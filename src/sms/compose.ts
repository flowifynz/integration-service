// Builds the final text a customer receives. Pure — unit tested.
//
// Rules from the brief:
//  - TNZ sends from a short code, so every customer text is signed with the business name.
//  - Every booking text says how to change it: call the agent's number (no reply inbox).
//  - Review requests are marketing under the Unsolicited Electronic Messages Act 2007:
//    they must identify the sender and carry a working opt-out.

export type SmsKind =
  | 'booking_confirmation'
  | 'reschedule_confirmation'
  | 'visit_reminder'
  | 'quote_followup'
  | 'invoice_followup'
  | 'review_request'
  | 'missed_call'
  | 'call_confirmation'
  | 'owner_alert';

const BOOKING_KINDS: ReadonlySet<SmsKind> = new Set(['booking_confirmation', 'reschedule_confirmation', 'visit_reminder']);
export const MARKETING_KINDS: ReadonlySet<SmsKind> = new Set(['review_request']);

/**
 * TNZ Department for a message kind. Sent with every text so TNZ's dashboard and invoices
 * can split usage by type as well as by client (SubAccount). Owner alerts are tagged
 * separately because they're Flowify's cost, not billed against the client's allowance.
 */
export function departmentFor(kind: SmsKind): string {
  switch (kind) {
    case 'booking_confirmation':
    case 'reschedule_confirmation':
    case 'visit_reminder':
      return 'bookings';
    case 'quote_followup':
    case 'invoice_followup':
      return 'follow-ups';
    case 'review_request':
      return 'reviews';
    case 'missed_call':
      return 'missed-calls';
    case 'call_confirmation':
      return 'calls';
    case 'owner_alert':
      return 'owner-alerts';
  }
}

/** Departments that count against the client's monthly allowance. */
export const BILLABLE_DEPARTMENTS: readonly string[] = ['bookings', 'follow-ups', 'reviews', 'missed-calls', 'calls'];

/**
 * Segments a text will use. 160 chars per single part (153 per part when split) for plain
 * GSM-7 text; any other character (macron, emoji, curly quote) switches the WHOLE text to
 * UCS-2: 70 per single part, 67 when split. Used to warn about costly templates.
 */
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; segments: number } {
  // GSM-7 basic set plus extension characters (which count double).
  const basic = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const extended = '^{}\\[~]|€\f';
  let units = 0;
  for (const ch of text) {
    if (basic.includes(ch)) units += 1;
    else if (extended.includes(ch)) units += 2;
    else {
      const len = [...text].length;
      return { encoding: 'UCS-2', segments: len <= 70 ? 1 : Math.ceil(len / 67) };
    }
  }
  return { encoding: 'GSM-7', segments: units <= 160 ? 1 : Math.ceil(units / 153) };
}

export interface ComposeClient {
  business_name: string;
  /** Already formatted for reading, e.g. '09 555 1234'. */
  agent_phone_display: string | null;
}

export function composeSms(kind: SmsKind, text: string, client: ComposeClient): string {
  // Owner alerts go to the tradie, not their customer: no signature or footer.
  if (kind === 'owner_alert') return text.trim();

  const lines = [text.trim()];
  if (client.agent_phone_display) {
    lines.push(
      BOOKING_KINDS.has(kind)
        ? `To change your booking, call us on ${client.agent_phone_display}.`
        : `Questions? Call us on ${client.agent_phone_display}.`,
    );
  }
  lines.push(`- ${client.business_name}`);
  if (MARKETING_KINDS.has(kind)) lines.push('Reply STOP to opt out.');
  return lines.join('\n');
}

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT']);

/** True if an inbound reply is an opt-out request. */
export function isStopRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalised = text.trim().toUpperCase().replace(/[^A-Z ]/g, '').trim();
  return STOP_WORDS.has(normalised);
}
