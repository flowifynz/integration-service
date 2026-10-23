// Background worker entry point (Render "flowify-worker").
// Processes queued jobs: texts, Jobber webhook events, follow-up checks, nightly reminders.

import { Sentry } from './instrument.ts';
import { sendAdminAlert } from './alerts/alerts.ts';
import { runHealthCheck } from './alerts/healthCheck.ts';
import { type FollowUpCheck, handleJobberEvent, runCheck, runDayBeforeReminders } from './automation/run.ts';
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
    Sentry.withScope((scope) => {
      scope.setTag('client_id', job.data.clientId);
      scope.setTag('sms_kind', job.data.kind);
      Sentry.captureMessage(`SMS permanently failed: ${result.error}`, 'warning');
    });
  }
});

// ---- jobber-event -----------------------------------------------------------------
// One stored webhook_events row → schedule whatever follow-up check it implies.
await boss.work<{ eventId: string }>(Queues.JOBBER_EVENT, async ([job]) => {
  if (!job) return;
  const { rows } = await db().query<{ id: string; client_id: string; topic: string; item_id: string | null; status: string }>(
    'SELECT id, client_id, topic, item_id, status FROM webhook_events WHERE id = $1',
    [job.data.eventId],
  );
  const evt = rows[0];
  if (!evt || evt.status !== 'received') return;

  try {
    const outcome = await handleJobberEvent(evt);
    await db().query(`UPDATE webhook_events SET status = $2, processed_at = now(), error = NULL WHERE id = $1`, [evt.id, outcome]);
  } catch (err) {
    await db().query(`UPDATE webhook_events SET error = $2 WHERE id = $1`, [evt.id, (err as Error).message]);
    throw err; // pg-boss retries with backoff
  }
});

// ---- follow-up-check ----------------------------------------------------------------
// Re-fetch the Jobber item and text only if it still makes sense.
await boss.work<FollowUpCheck>(Queues.FOLLOW_UP_CHECK, async ([job]) => {
  if (!job) return;
  const outcome = await runCheck(job.data);
  console.log(`[check ${job.data.check} ${job.data.itemId}] ${outcome}`);
});

// ---- day-before-reminders ---------------------------------------------------------
await boss.work<{ date: string }>(Queues.DAY_BEFORE_REMINDERS, async ([job]) => {
  if (!job) return;
  await runDayBeforeReminders(job.data.date);
});

// ---- send-admin-alert ---------------------------------------------------------------
// Alert texts to Jaron. Not subject to quiet hours.
await boss.work<{ alertId: string }>(Queues.SEND_ADMIN_ALERT, async ([job]) => {
  if (!job) return;
  const result = await sendAdminAlert(job.data.alertId);
  console.log(`[alert ${job.data.alertId}] ${result}`);
});

// ---- health-check (hourly) ----------------------------------------------------------
await boss.work(Queues.HEALTH_CHECK, async () => {
  for (const line of await runHealthCheck()) console.log(`[health] ${line}`);
});
// pg-boss keeps the schedule in Postgres; calling this on every start just updates it.
await boss.schedule(Queues.HEALTH_CHECK, '7 * * * *', {}, { tz: 'Pacific/Auckland' });

console.log('Worker started');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await stopBoss(); // graceful: lets running jobs finish
    await closeDb();
    process.exit(0);
  });
}
