// Background worker entry point (Render "flowify-worker").
// Processes queued jobs: texts, Jobber webhook follow-ups, nightly reminders.

import { Sentry } from './instrument.ts';
import { closeDb, db } from './db.ts';
import { getBoss, Queues, stopBoss } from './queue.ts';
import { sendClientSms, type SendSmsJob } from './sms/outbound.ts';

const boss = await getBoss();

// ---- send-sms -------------------------------------------------------------------
await boss.work<SendSmsJob>(Queues.SEND_SMS, async ([job]) => {
  if (!job) return;
  const result = await sendClientSms(job.data);
  if (result.status === 'deferred') {
    // Quiet hours: re-queue for 8am. Same idempotency key, so it still sends at most once.
    await boss.send(Queues.SEND_SMS, job.data, { startAfter: result.until });
  } else if (result.status === 'failed_permanent') {
    Sentry.captureMessage(`SMS permanently failed: ${result.error}`, 'warning');
  }
});

// ---- jobber-event -----------------------------------------------------------------
// One stored webhook_events row. Build step 4: fetch the visit/quote/invoice from Jobber
// (jobberQuery with a 15s timeout) and queue the right text via Queues.SEND_SMS with
// idempotencyKey(clientId, itemId, kind).
await boss.work<{ eventId: string }>(Queues.JOBBER_EVENT, async ([job]) => {
  if (!job) return;
  const { rows } = await db().query<{ id: string; client_id: string; topic: string; item_id: string; status: string }>(
    'SELECT id, client_id, topic, item_id, status FROM webhook_events WHERE id = $1',
    [job.data.eventId],
  );
  const evt = rows[0];
  if (!evt || evt.status !== 'received') return;

  try {
    switch (evt.topic) {
      // TODO(step 4): confirm the real topic names in Jobber's Developer Center first.
      // case 'VISIT_CREATE':
      // case 'VISIT_UPDATE':
      // case 'QUOTE_SENT':
      // case 'INVOICE_CREATE':
      default:
        await db().query(`UPDATE webhook_events SET status = 'ignored', processed_at = now() WHERE id = $1`, [evt.id]);
        return;
    }
  } catch (err) {
    await db().query(`UPDATE webhook_events SET error = $2 WHERE id = $1`, [evt.id, (err as Error).message]);
    throw err; // retry
  }
});

// ---- day-before-reminders ---------------------------------------------------------
// Build step 4: for each active client with a live Jobber connection, query tomorrow's
// visits (NZ date), and queue one visit_reminder per visit with
// idempotencyKey(clientId, visitId, 'visit_reminder').
await boss.work<{ date: string }>(Queues.DAY_BEFORE_REMINDERS, async ([job]) => {
  if (!job) return;
  const { rows } = await db().query<{ id: string }>(
    `SELECT c.id FROM clients c JOIN jobber_connections j ON j.client_id = c.id
      WHERE c.status = 'active' AND j.status = 'connected'`,
  );
  console.log(`Reminders for ${job.data.date}: ${rows.length} clients (not implemented yet)`);
});

console.log('Worker started');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await stopBoss(); // graceful: lets running jobs finish
    await closeDb();
    process.exit(0);
  });
}
