// sendClientSms: the one way a customer text leaves Flowify. Called by the worker's
// send-sms job, never directly from a web request (TNZ latency must not hold up a call
// or a webhook ack).
//
// Order of checks: dedupe → valid number → opt-out → quiet hours → claim → send.

import { db, getClientById } from '../db.ts';
import { formatNational, toE164 } from '../phone.ts';
import { composeSms, departmentFor, MARKETING_KINDS, type SmsKind } from './compose.ts';
import { quietHoursDeferral } from './quietHours.ts';
import { sendTnzSms, TnzError, tnzMessageId } from './tnz.ts';

export interface SendSmsJob {
  clientId: string;
  kind: SmsKind;
  toPhone: string;
  /** The message itself, without signature or footer — composeSms adds those. */
  text: string;
  /** '<clientId>:<jobber item id>:<kind>' — same key = same text, sent at most once. */
  idempotencyKey: string;
  /** The Jobber visit/quote/invoice/job this text is about (for "already confirmed?" checks). */
  jobberItemId?: string;
  /** Version of that item, e.g. a visit's startAt, so a moved visit is recognised. */
  itemRef?: string;
}

export type SendSmsResult =
  | { status: 'sent'; tnzMessageId: string }
  | { status: 'duplicate' }
  | { status: 'skipped_invalid' }
  | { status: 'skipped_opt_out' }
  | { status: 'deferred'; until: Date }
  | { status: 'failed_permanent'; error: string };

export function idempotencyKey(clientId: string, jobberItemId: string, kind: SmsKind): string {
  return `${clientId}:${jobberItemId}:${kind}`;
}

export async function sendClientSms(job: SendSmsJob): Promise<SendSmsResult> {
  const client = await getClientById(job.clientId);
  if (!client) throw new Error(`Unknown client ${job.clientId}`);

  const to = toE164(job.toPhone);
  const body = composeSms(job.kind, job.text, {
    business_name: client.business_name,
    agent_phone_display: client.agent_phone ? formatNational(client.agent_phone) : null,
  });

  // 1. Record the message (or find the existing record for this idempotency key).
  const inserted = await db().query<{ id: string; status: string }>(
    `INSERT INTO messages (client_id, idempotency_key, kind, is_marketing, to_phone, body, department, jobber_item_id, item_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, status`,
    [client.id, job.idempotencyKey, job.kind, MARKETING_KINDS.has(job.kind), to ?? job.toPhone, body, departmentFor(job.kind), job.jobberItemId ?? null, job.itemRef ?? null],
  );
  const row =
    inserted.rows[0] ??
    (await db().query<{ id: string; status: string }>('SELECT id, status FROM messages WHERE idempotency_key = $1', [
      job.idempotencyKey,
    ])).rows[0];
  if (!row) throw new Error('Message row vanished');
  if (row.status !== 'queued' && row.status !== 'failed') return { status: 'duplicate' };

  const setStatus = (status: string, error: string | null = null) =>
    db().query('UPDATE messages SET status = $2, error = $3 WHERE id = $1', [row.id, status, error]);

  // 2. Valid NZ number?
  if (!to) {
    await setStatus('skipped_invalid', `Unparseable number: ${job.toPhone}`);
    return { status: 'skipped_invalid' };
  }

  // 3. Opted out of this client, or of everyone (client_id NULL)?
  const optOut = await db().query('SELECT 1 FROM opt_outs WHERE phone = $1 AND (client_id = $2 OR client_id IS NULL) LIMIT 1', [
    to,
    client.id,
  ]);
  if (optOut.rowCount) {
    await setStatus('skipped_opt_out');
    return { status: 'skipped_opt_out' };
  }

  // 4. Quiet hours (owner alerts are exempt — the tradie chose to get them).
  if (job.kind !== 'owner_alert') {
    const until = quietHoursDeferral(new Date(), client.timezone);
    if (until) return { status: 'deferred', until }; // row stays 'queued'
  }

  // 5. Claim the row so a concurrent retry of the same job can't double-send.
  const claimed = await db().query<{ attempts: number }>(
    `UPDATE messages SET status = 'sending', attempts = attempts + 1
      WHERE id = $1 AND status IN ('queued', 'failed') RETURNING attempts`,
    [row.id],
  );
  const attempt = claimed.rows[0]?.attempts;
  if (!attempt) return { status: 'duplicate' };

  // 6. Send.
  try {
    const { messageId } = await sendTnzSms({
      to,
      message: body,
      subAccount: client.tnz_subaccount ?? client.slug, // never send untagged
      department: departmentFor(job.kind),
      messageId: tnzMessageId(row.id, attempt),
      reference: `${client.slug} ${job.kind}`,
      mode: client.sms_mode === 'live' ? 'Live' : 'Test',
    });
    await db().query(
      `UPDATE messages SET status = 'sent', tnz_message_id = $2, sent_at = now(), error = NULL WHERE id = $1`,
      [row.id, messageId],
    );
    return { status: 'sent', tnzMessageId: messageId };
  } catch (err) {
    await setStatus('failed', (err as Error).message);
    if (err instanceof TnzError && !err.retryable) return { status: 'failed_permanent', error: err.message };
    throw err; // pg-boss retries with backoff
  }
}
