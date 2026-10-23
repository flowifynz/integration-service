// TNZ SMS sender — the only module that talks to TNZ.
//
// Checked against TNZ REST API v3.00 (OpenAPI spec, Oct 2026):
//  - POST https://api.tnz.co.nz/api/v3.00/sms, `Authorization: Bearer <token>`, JSON body.
//  - Fields are top-level (no wrapper object): Message, Destination, MessageID, Reference,
//    SubAccount, Department, Mode ('Test' = handled as successful without sending), NotificationType,
//    WebhookCallbackURL, WebhookCallbackFormat.
//  - 200 OK → { "MessageID": "..." }. Errors → { "Result": "Failed", "ErrorMessage": [...] }.
//  - MessageID is ours to set (max 40 chars, alphanumeric). TNZ puts it on any reply it can
//    match to this text, which is how a STOP is tied back to the right client.
//
// Each text asks TNZ to send replies (and delivery results) to our /tnz/inbound webhook as
// JSON, so no account-level webhook setting is needed.

import { config } from '../config.ts';

export interface TnzSendInput {
  /** E.164, e.g. +64211234567 */
  to: string;
  message: string;
  /** Per-client billing sub-account. */
  subAccount: string | null;
  /** Message category for TNZ reporting (bookings, owner-alerts, ...). See departmentFor(). */
  department: string;
  /** Our MessageID: alphanumeric, ≤ 40 chars. See tnzMessageId(). */
  messageId: string;
  /** Human-readable reference shown in TNZ's dashboard, e.g. the client slug + message kind. */
  reference: string;
  /** 'Test' = TNZ accepts but doesn't deliver (use during onboarding). */
  mode: 'Test' | 'Live';
}

export class TnzError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`TNZ send failed (${status}): ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
  /** 4xx (other than 429) won't succeed on retry — bad number, bad payload, auth. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/**
 * Our MessageID for a messages row: 'flowify<row id>a<attempt>'. Alphanumeric only, as TNZ
 * requires. The attempt number keeps each retry unique in case TNZ rejects a reused ID.
 */
export function tnzMessageId(messageRowId: string | number, attempt: number): string {
  return `flowify${messageRowId}a${attempt}`;
}

/** Reverse of tnzMessageId: the messages row id, or null if it isn't one of ours. */
export function messageRowIdFromTnz(messageId: string | null | undefined): string | null {
  return messageId?.match(/^flowify(\d+)a\d+$/)?.[1] ?? null;
}

export function inboundWebhookUrl(): string {
  return `${config.publicBaseUrl}/tnz/inbound?key=${encodeURIComponent(config.tnz.inboundKey)}`;
}

export function buildTnzPayload(input: TnzSendInput, webhookUrl: string): Record<string, unknown> {
  return {
    Message: input.message,
    Destination: input.to,
    MessageID: input.messageId,
    Reference: input.reference,
    NotificationType: 'Webhook',
    WebhookCallbackURL: webhookUrl,
    WebhookCallbackFormat: 'JSON',
    Department: input.department,
    ...(input.subAccount ? { SubAccount: input.subAccount } : {}),
    ...(input.mode === 'Test' ? { Mode: 'Test' } : {}),
  };
}

export async function sendTnzSms(input: TnzSendInput): Promise<{ messageId: string }> {
  // Read config BEFORE the network try/catch: a missing setting is a config error,
  // not a retryable network error.
  const url = `${config.tnz.baseUrl}/sms`;
  const headers = {
    Authorization: `Bearer ${config.tnz.apiToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const body = JSON.stringify(buildTnzPayload(input, inboundWebhookUrl()));

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new TnzError(0, `Network error: ${(err as Error).message}`); // retryable
  }

  const text = await res.text();
  if (!res.ok) throw new TnzError(res.status, text);
  let json: { MessageID?: unknown; Result?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    throw new TnzError(res.status, `Non-JSON response: ${text}`);
  }
  if (json.Result === 'Failed' || typeof json.MessageID !== 'string') throw new TnzError(res.status, text);
  return { messageId: json.MessageID };
}
