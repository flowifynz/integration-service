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

export interface RequestNoteInput {
  callerName: string;
  callbackPhone: string | null;
  address: string | null;
  description: string;
  urgency: Urgency;
  addressOnFile: boolean;
}

/** Full detail for the request note, so nothing the caller said is lost. */
export function requestNote(n: RequestNoteInput): string {
  return [
    'Logged by the Flowify AI receptionist.',
    `Caller: ${n.callerName}`,
    n.callbackPhone ? `Callback: ${n.callbackPhone}` : null,
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
  address: string | null;
  description: string;
  urgency: Urgency;
  loggedInJobber: boolean;
}): string {
  const head = n.urgency === 'emergency' ? 'URGENT new request' : 'New request';
  const d = n.description.length > 200 ? `${n.description.slice(0, 197)}…` : n.description;
  return [
    `${head} from ${n.callerName}${n.callbackPhone ? ` (${n.callbackPhone})` : ''}`,
    n.address ? `Site: ${n.address}` : null,
    d,
    n.loggedInJobber ? 'In Jobber under Requests.' : 'NOT saved in Jobber (connection problem) — please add it manually.',
  ]
    .filter(Boolean)
    .join('\n');
}
