// Parses TNZ webhook bodies. Pure — unit tested. See routes/tnzInbound.ts for context.
//
// Real TNZ v3.00 webhook fields (seen in production, Oct 2026) — the same set for delivery
// results and replies:
//   Version, Sender, APIKey, Type, Destination, ContactID, ReceivedID, MessageID,
//   SubAccount, Department, JobNumber, SentTimeLocal, SentTimeUTC, SentTimeUTC_RFC3339,
//   Status, Result, Message, Price, Detail, URL
// Which of Sender/Destination holds the customer's mobile on a reply isn't documented, so
// we take the first candidate that is a valid NZ mobile number. Likewise the reply text is
// looked for in Message, then Detail.

export interface InboundFields {
  /** Candidate phone values, in priority order (raw strings). */
  phoneCandidates: string[];
  /** Candidate reply-text values, in priority order. */
  textCandidates: string[];
  messageId?: string;
  subAccount?: string;
  type?: string;
  status?: string;
  result?: string;
  receivedId?: string;
}

export function extractInbound(body: Record<string, unknown>): InboundFields {
  const lower = new Map(Object.entries(body).map(([k, v]) => [k.toLowerCase(), v]));
  const str = (name: string): string | undefined => {
    const v = lower.get(name.toLowerCase());
    if (typeof v === 'number') return String(v);
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const all = (...names: string[]) => names.map(str).filter((v): v is string => Boolean(v));
  return {
    phoneCandidates: all('From', 'Sender', 'Destination', 'FromNumber', 'Mobile'),
    textCandidates: all('MessageText', 'Message', 'ReplyMessage', 'Detail', 'Text'),
    messageId: str('MessageID'),
    subAccount: str('SubAccount'),
    type: str('Type'),
    status: str('Status'),
    result: str('Result'),
    receivedId: str('ReceivedID'),
  };
}
