// Parses TNZ webhook bodies. Pure — unit tested. See routes/tnzInbound.ts for context.
//
// TNZ v3.00 webhook fields (seen in production, Oct 2026; documented at
// tnz.co.nz/help/configuring-api-webhooks) — the same set for results and replies:
//   Version, Sender, APIKey, Type, Destination, ContactID, ReceivedID, MessageID,
//   SubAccount, Department, JobNumber, SentTimeLocal, SentTimeUTC, SentTimeUTC_RFC3339,
//   Status, Result, Message, Price, Detail, URL
// Type: 'SMS' = final result for a text we sent; 'SMSReply' = reply matched to one of our
// texts; 'SMSInbound' = unmatched inbound text. Detail carries e.g. 'SMSParts:1'.
// Price = what TNZ charged the account holder (may be null on reseller accounts).

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
  detail?: string;
  receivedId?: string;
  price: number | null;
  smsParts: number | null;
}

export function extractInbound(body: Record<string, unknown>): InboundFields {
  const lower = new Map(Object.entries(body).map(([k, v]) => [k.toLowerCase(), v]));
  const str = (name: string): string | undefined => {
    const v = lower.get(name.toLowerCase());
    if (typeof v === 'number') return String(v);
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const all = (...names: string[]) => names.map(str).filter((v): v is string => Boolean(v));
  const detail = str('Detail');
  const priceRaw = str('Price');
  const price = priceRaw !== undefined && Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : null;
  const parts = detail?.match(/SMSParts\s*:\s*(\d+)/i)?.[1];
  return {
    phoneCandidates: all('From', 'Sender', 'Destination', 'FromNumber', 'Mobile'),
    textCandidates: all('MessageText', 'Message', 'ReplyMessage', 'Detail', 'Text'),
    messageId: str('MessageID'),
    subAccount: str('SubAccount'),
    type: str('Type'),
    status: str('Status'),
    result: str('Result'),
    detail,
    receivedId: str('ReceivedID'),
    price,
    smsParts: parts ? Number(parts) : null,
  };
}

/** A final result for a text we sent (as opposed to a reply). */
export function isSendResult(f: InboundFields): boolean {
  return f.type?.toUpperCase() === 'SMS';
}

/** A reply or unmatched inbound text. Missing Type is treated as possibly a reply. */
export function isReply(f: InboundFields): boolean {
  const t = f.type?.toUpperCase();
  return t === undefined || t === 'SMSREPLY' || t === 'SMSINBOUND';
}

/** TNZ refused because the number is on its opt-out list ("Destination is blacklisted"). */
export function isBlacklisted(f: InboundFields): boolean {
  return [f.status, f.result, f.detail].some((v) => v && /blacklist/i.test(v));
}
