// Parses TNZ webhook bodies. Pure — unit tested. See routes/tnzInbound.ts for context.

export interface InboundFields {
  from?: string;
  text?: string;
  messageId?: string;
  subAccount?: string;
}

/** Picks the first present string field among likely names (case-insensitive). */
export function extractInbound(body: Record<string, unknown>): InboundFields {
  const lower = new Map(Object.entries(body).map(([k, v]) => [k.toLowerCase(), v]));
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = lower.get(n.toLowerCase());
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  return {
    from: pick('From', 'Sender', 'FromNumber', 'Mobile'),
    text: pick('MessageText', 'ReplyMessage', 'Message', 'Text'),
    messageId: pick('MessageID', 'MessageId'),
    subAccount: pick('SubAccount'),
  };
}
