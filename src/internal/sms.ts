// Flowify's own texts (e.g. a prospect's discovery-call confirmation). Same TNZ sender and
// the same safety rules as client texts, but separate tables (internal.messages,
// internal.opt_outs) and a separate TNZ SubAccount, so they never mix with client data or
// show on a client's SMS bill.
//
// Rules: sent at most once per idempotency key; mobiles only; STOP honoured (Flowify's
// own opt-outs and any global opt-out); daily caps because the website widget is public.
// No quiet hours: these confirm something the person did seconds ago on our website.

import { db } from '../db.ts';
import { isMobile, toE164 } from '../phone.ts';
import { getBoss, Queues } from '../queue.ts';
import { internalTnzMessageId, sendTnzSms, TnzError } from '../sms/tnz.ts';
import { config } from '../config.ts';
import { DISCOVERY_CALL } from './discoveryCall.ts';

export type InternalSmsKind = 'discovery_confirmation';

const DEPARTMENT: Record<InternalSmsKind, string> = {
  discovery_confirmation: 'website-bookings',
};

export type QueueResult = 'queued' | 'duplicate' | 'skipped_invalid' | 'skipped_opt_out' | 'capped';

export async function isInternallyOptedOut(e164: string): Promise<boolean> {
  const { rowCount } = await db().query(
    `SELECT 1 FROM internal.opt_outs WHERE phone = $1
     UNION ALL
     SELECT 1 FROM opt_outs WHERE phone = $1 AND client_id IS NULL
     LIMIT 1`,
    [e164],
  );
  return Boolean(rowCount);
}

/** Records a text and queues it for the worker. Never throws on a skip — returns why. */
export async function queueInternalSms(input: {
  kind: InternalSmsKind;
  idempotencyKey: string;
  toPhone: string | null;
  body: string;
  bookingId?: string | number | null;
}): Promise<QueueResult> {
  const to = toE164(input.toPhone);
  if (!to || !isMobile(to)) return 'skipped_invalid';
  if (await isInternallyOptedOut(to)) return 'skipped_opt_out';

  const caps = await db().query<{ to_phone: string; total: string }>(
    `SELECT count(*) FILTER (WHERE to_phone = $1)::text AS to_phone, count(*)::text AS total
       FROM internal.messages WHERE created_at > now() - interval '24 hours'`,
    [to],
  );
  const c = caps.rows[0];
  if (c && (Number(c.to_phone) >= DISCOVERY_CALL.maxTextsPerPhonePerDay || Number(c.total) >= DISCOVERY_CALL.maxTextsPerDay)) {
    return 'capped';
  }

  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO internal.messages (idempotency_key, kind, booking_id, to_phone, body)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [input.idempotencyKey, input.kind, input.bookingId ?? null, to, input.body],
  );
  const id = rows[0]?.id;
  if (!id) return 'duplicate';
  await (await getBoss()).send(Queues.INTERNAL_SMS, { messageId: id });
  return 'queued';
}

export type SendResult = 'sent' | 'already_done' | 'skipped_opt_out' | 'failed_permanent';

/** Worker: send one internal.messages row. Throws on retryable failures (pg-boss retries). */
export async function sendInternalSms(messageId: string): Promise<SendResult> {
  const claimed = await db().query<{ id: string; kind: InternalSmsKind; to_phone: string; body: string; attempts: number }>(
    `UPDATE internal.messages SET status = 'sending', attempts = attempts + 1
      WHERE id = $1 AND status IN ('queued', 'failed')
      RETURNING id, kind, to_phone, body, attempts`,
    [messageId],
  );
  const msg = claimed.rows[0];
  if (!msg) return 'already_done';

  // A STOP may have arrived since the text was queued.
  if (await isInternallyOptedOut(msg.to_phone)) {
    await db().query(`UPDATE internal.messages SET status = 'skipped_opt_out' WHERE id = $1`, [msg.id]);
    return 'skipped_opt_out';
  }

  try {
    const { messageId: tnzId } = await sendTnzSms({
      to: msg.to_phone,
      message: msg.body,
      subAccount: config.internal.tnzSubaccount,
      department: DEPARTMENT[msg.kind] ?? 'flowify-internal',
      messageId: internalTnzMessageId(msg.id, msg.attempts),
      reference: `flowify-internal ${msg.kind}`, // no names or numbers in TNZ's dashboard
      mode: config.internal.smsMode,
    });
    await db().query(`UPDATE internal.messages SET status = 'sent', tnz_message_id = $2, sent_at = now(), error = NULL WHERE id = $1`, [
      msg.id,
      tnzId,
    ]);
    return 'sent';
  } catch (err) {
    await db().query(`UPDATE internal.messages SET status = 'failed', error = $2 WHERE id = $1`, [msg.id, (err as Error).message]);
    if (err instanceof TnzError && !err.retryable) return 'failed_permanent';
    throw err;
  }
}
