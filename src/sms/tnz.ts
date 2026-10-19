// TNZ SMS sender — the only module that talks to TNZ.
//
// ⚠ The request/response field names below are my best reading of TNZ's API and are NOT
// confirmed for v3.00. Before the first real send, check them against TNZ's v3.00 docs
// and adjust buildTnzPayload / parseTnzResponse only — nothing else depends on the shape.

import { config } from '../config.ts';

export interface TnzSendInput {
  /** E.164, e.g. +64211234567 */
  to: string;
  message: string;
  /** Per-client billing sub-account. */
  subAccount: string | null;
  /** Our reference — set to the messages.id so replies/receipts can be traced back. */
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

export function buildTnzPayload(input: TnzSendInput): Record<string, unknown> {
  return {
    MessageData: {
      Message: input.message,
      Destinations: [{ Recipient: input.to }],
      Reference: input.reference,
      ...(input.subAccount ? { SubAccount: input.subAccount } : {}),
      ...(input.mode === 'Test' ? { Mode: 'Test' } : {}),
    },
  };
}

function parseTnzResponse(json: Record<string, unknown>): string | null {
  // Expected: { Result: 'Success', MessageID: '...' } — confirm.
  if (json.Result !== 'Success') return null;
  return typeof json.MessageID === 'string' ? json.MessageID : null;
}

export async function sendTnzSms(input: TnzSendInput): Promise<{ messageId: string }> {
  let res: Response;
  try {
    res = await fetch(`${config.tnz.baseUrl}/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.tnz.apiToken}`,
        'Content-Type': 'application/json; encoding=utf-8',
        Accept: 'application/json',
      },
      body: JSON.stringify(buildTnzPayload(input)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new TnzError(0, `Network error: ${(err as Error).message}`); // retryable
  }

  const text = await res.text();
  if (!res.ok) throw new TnzError(res.status, text);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TnzError(res.status, `Non-JSON response: ${text}`);
  }
  const messageId = parseTnzResponse(json);
  if (!messageId) throw new TnzError(res.status, text);
  return { messageId };
}
