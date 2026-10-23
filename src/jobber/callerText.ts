// Pure helpers for turning what a caller said into Jobber records and texts. Unit tested.

/** 'Sam Smith' → { Sam, Smith }. Jobber requires a last name, so a single word gets a placeholder. */
export function splitName(full: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Unknown', lastName: 'Caller' };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '(surname not given)' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(street|st|road|rd|avenue|ave|drive|dr|place|pl|crescent|cres|lane|ln|terrace|tce)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');

/**
 * Does a spoken address match a property on file? Compares the start of the spoken address
 * with the property's street line, ignoring case, punctuation and street-type words
 * ("12 Smith St" matches "12 Smith Street, Takapuna").
 */
export function addressMatches(spoken: string | null | undefined, street1: string | null | undefined): boolean {
  if (!spoken || !street1) return false;
  const a = normalise(spoken);
  const b = normalise(street1);
  return b.length >= 4 && a.startsWith(b);
}

export type Urgency = 'emergency' | 'soon' | 'flexible';

export function normaliseUrgency(u: unknown): Urgency {
  const s = String(u ?? '').toLowerCase();
  if (s.startsWith('emerg') || s === 'urgent') return 'emergency';
  if (s.startsWith('soon')) return 'soon';
  return 'flexible';
}

/** Short request title for Jobber's list view. */
export function requestTitle(description: string | null | undefined, urgency: Urgency): string {
  const d = (description ?? '').trim().replace(/\s+/g, ' ') || 'Phone enquiry';
  const short = d.length > 80 ? `${d.slice(0, 77).trimEnd()}…` : d;
  return urgency === 'emergency' ? `URGENT: ${short}` : short;
}

/** Where the callback number came from. 'spoken' with no caller ID can't be verified. */
export type PhoneSource = 'caller_id' | 'spoken' | 'spoken_no_caller_id' | 'none';

export function phoneSourceLabel(src: PhoneSource): string {
  switch (src) {
    case 'caller_id':
      return 'from caller ID';
    case 'spoken':
      return 'given on the call';
    case 'spoken_no_caller_id':
      return 'given on the call, caller ID hidden, not verified';
    case 'none':
      return 'no number given';
  }
}

/**
 * True for numbers a model is likely to invent as a placeholder: a run of 6+ ascending or
 * descending digits (022 123 4567) or 6+ of the same digit (021 000 0000). Real numbers
 * like this exist but are rare enough that asking the caller to repeat it is the right call.
 */
export function looksMadeUp(nationalDigits: string): boolean {
  const d = nationalDigits.replace(/\D/g, '');
  let up = 1;
  let down = 1;
  let same = 1;
  for (let i = 1; i < d.length; i++) {
    const a = Number(d[i - 1]);
    const b = Number(d[i]);
    up = b === a + 1 ? up + 1 : 1;
    down = b === a - 1 ? down + 1 : 1;
    same = b === a ? same + 1 : 1;
    if (up >= 6 || down >= 6 || same >= 6) return true;
  }
  return false;
}

export interface RequestNoteInput {
  callerName: string;
  callbackPhone: string | null;
  phoneSource: PhoneSource;
  address: string | null;
  description: string;
  urgency: Urgency;
  addressOnFile: boolean;
  /** Created by the post-call safety net, not by the receptionist during the call. */
  afterCall?: boolean;
}

/** Full detail for the request note, so nothing the caller said is lost. */
export function requestNote(n: RequestNoteInput): string {
  return [
    n.afterCall
      ? "Logged by Flowify after the call (the receptionist couldn't save it during the call)."
      : 'Logged by the Flowify AI receptionist.',
    `Caller: ${n.callerName}`,
    n.callbackPhone ? `Callback: ${n.callbackPhone} (${phoneSourceLabel(n.phoneSource)})` : 'Callback: no number given',
    n.address ? `Site: ${n.address}${n.addressOnFile ? '' : ' (not yet a property on this client — please add)'}` : 'Site: not given',
    `Urgency: ${n.urgency}`,
    '',
    n.description,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Text to the business owner about a new request. */
export function ownerAlertText(n: {
  callerName: string;
  callbackPhone: string | null;
  phoneSource: PhoneSource;
  address: string | null;
  description: string;
  urgency: Urgency;
  /** true = in Jobber, false = Jobber failed, null = no Jobber (Base). */
  loggedInJobber: boolean | null;
}): string {
  // Plain GSM-7 only: one en/em dash or ellipsis would make the whole text cost 2-3x.
  const head = n.urgency === 'emergency' ? 'URGENT new request' : 'New request';
  const d = n.description.length > 200 ? `${n.description.slice(0, 197)}...` : n.description;
  return [
    `${head} from ${n.callerName}${n.callbackPhone ? ` (${n.callbackPhone})` : ' (NO callback number)'}`,
    n.phoneSource === 'spoken_no_caller_id' ? 'Number said on the call, caller ID hidden: not verified.' : null,
    n.address ? `Site: ${n.address}` : null,
    d,
    n.loggedInJobber === null ? null : n.loggedInJobber ? 'In Jobber under Requests.' : 'NOT saved in Jobber (connection problem) - please add it manually.',
  ]
    .filter(Boolean)
    .join('\n');
}

export type MessageAbout = 'supplier' | 'existing_customer' | 'other';

export function normaliseAbout(v: unknown): MessageAbout {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (s === 'supplier') return 'supplier';
  if (s === 'existing_customer' || s === 'customer') return 'existing_customer';
  return 'other';
}

/** Text to the business owner with a message (not a job). Plain GSM-7 in the fixed wording. */
export function messageAlertText(n: {
  callerName: string;
  company: string | null;
  callbackPhone: string | null;
  phoneSource: PhoneSource;
  about: MessageAbout;
  message: string;
}): string {
  const label = n.about === 'supplier' ? 'Supplier message' : n.about === 'existing_customer' ? 'Customer message' : 'Message';
  const m = n.message.length > 250 ? `${n.message.slice(0, 247)}...` : n.message;
  return [
    `${label} from ${n.callerName}${n.company ? `, ${n.company}` : ''}${n.callbackPhone ? ` (${n.callbackPhone})` : ' (NO callback number)'}`,
    n.phoneSource === 'spoken_no_caller_id' ? 'Number said on the call, caller ID hidden: not verified.' : null,
    m,
    'Not a job - nothing added to Jobber.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * How the agent should refer to a Jobber client when confirming who's calling:
 * "Tom Jones", or "Tom Jones from Apex Building" for a company client with a contact name,
 * or just "Apex Building" if there's no person's name.
 */
export function confirmName(c: { firstName: string; lastName: string; name: string; companyName: string | null; isCompany: boolean }): string {
  const person = [c.firstName, c.lastName].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
  const company = (c.companyName ?? '').trim();
  if (c.isCompany && company) return person ? `${person} from ${company}` : company;
  return person || c.name;
}
