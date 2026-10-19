// sendClientSms: the one way a customer text leaves Flowify. Called by the worker's
// send-sms job, never directly from a web request (TNZ latency must not hold up a call
// or a webhook ack).
//
// Order of checks: dedupe → valid number → opt-out → quiet hours → claim → send.
import { db, getClientById } from "../db.js";
import { formatNational, toE164 } from "../phone.js";
import { composeSms, MARKETING_KINDS } from "./compose.js";
import { quietHoursDeferral } from "./quietHours.js";
import { sendTnzSms, TnzError } from "./tnz.js";
export function idempotencyKey(clientId, jobberItemId, kind) {
    return `${clientId}:${jobberItemId}:${kind}`;
}
export async function sendClientSms(job) {
    const client = await getClientById(job.clientId);
    if (!client)
        throw new Error(`Unknown client ${job.clientId}`);
    const to = toE164(job.toPhone);
    const body = composeSms(job.kind, job.text, {
        business_name: client.business_name,
        agent_phone_display: client.agent_phone ? formatNational(client.agent_phone) : null,
    });
    // 1. Record the message (or find the existing record for this idempotency key).
    const inserted = await db().query(`INSERT INTO messages (client_id, idempotency_key, kind, is_marketing, to_phone, body)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, status`, [client.id, job.idempotencyKey, job.kind, MARKETING_KINDS.has(job.kind), to ?? job.toPhone, body]);
    const row = inserted.rows[0] ??
        (await db().query('SELECT id, status FROM messages WHERE idempotency_key = $1', [
            job.idempotencyKey,
        ])).rows[0];
    if (!row)
        throw new Error('Message row vanished');
    if (row.status !== 'queued' && row.status !== 'failed')
        return { status: 'duplicate' };
    const setStatus = (status, error = null) => db().query('UPDATE messages SET status = $2, error = $3 WHERE id = $1', [row.id, status, error]);
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
        if (until)
            return { status: 'deferred', until }; // row stays 'queued'
    }
    // 5. Claim the row so a concurrent retry of the same job can't double-send.
    const claimed = await db().query(`UPDATE messages SET status = 'sending', attempts = attempts + 1
      WHERE id = $1 AND status IN ('queued', 'failed') RETURNING id`, [row.id]);
    if (!claimed.rowCount)
        return { status: 'duplicate' };
    // 6. Send.
    try {
        const { messageId } = await sendTnzSms({
            to,
            message: body,
            subAccount: client.tnz_subaccount,
            reference: `msg-${row.id}`,
            mode: client.sms_mode === 'live' ? 'Live' : 'Test',
        });
        await db().query(`UPDATE messages SET status = 'sent', tnz_message_id = $2, sent_at = now(), error = NULL WHERE id = $1`, [row.id, messageId]);
        return { status: 'sent', tnzMessageId: messageId };
    }
    catch (err) {
        await setStatus('failed', err.message);
        if (err instanceof TnzError && !err.retryable)
            return { status: 'failed_permanent', error: err.message };
        throw err; // pg-boss retries with backoff
    }
}
//# sourceMappingURL=outbound.js.map