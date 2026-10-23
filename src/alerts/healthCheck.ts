// Hourly health check (backlog D4). Run by the worker on a pg-boss schedule; also
// runnable by hand: node dist/scripts/healthCheck.js
//
// 1. Jobber connections still broken → repeat the alert (once a NZ day).
// 2. A client with 3+ failed texts in 24h → alert.
// 3. Jobber events stuck in 'received' over an hour → re-queue them + alert.
// 4. Worker jobs waiting over 30 minutes → alert.
// 5. Alert texts stuck in 'queued' → re-queue.
// 6. Calls not processed after 15 minutes → re-queue; processing errors → alert.
//
// With Google Chat set up, alerts post any time. Text-only setups only alert 7am–9pm NZ.
// Event alerts (refresh failed, app removed) are sent straight away, any time.

import { config } from '../config.ts';
import { db } from '../db.ts';
import { getBoss, Queues } from '../queue.ts';
import { raiseAlert } from './alerts.ts';
import { isAlertDaytime } from './text.ts';

export const SMS_FAILURE_THRESHOLD = 3;

export async function runHealthCheck(opts: { anyTime?: boolean } = {}): Promise<string[]> {
  const log: string[] = [];
  const boss = await getBoss();

  // 5 first: re-queue alert texts that never got queued (e.g. pg-boss hiccup in the web service).
  const stuckAlerts = await db().query<{ id: string }>(
    `SELECT id FROM admin_alerts WHERE status = 'queued' AND created_at < now() - interval '10 minutes'`,
  );
  for (const a of stuckAlerts.rows) await boss.send(Queues.SEND_ADMIN_ALERT, { alertId: a.id });
  if (stuckAlerts.rowCount) log.push(`re-queued ${stuckAlerts.rowCount} alert text(s)`);

  // 3: re-queue stuck Jobber events whether or not it's daytime — that's a fix, not an alert.
  const stuckEvents = await db().query<{ id: string }>(
    `SELECT id FROM webhook_events
      WHERE status = 'received' AND client_id IS NOT NULL
        AND received_at < now() - interval '1 hour' AND received_at > now() - interval '7 days'`,
  );
  for (const e of stuckEvents.rows) await boss.send(Queues.JOBBER_EVENT, { eventId: e.id });
  if (stuckEvents.rowCount) log.push(`re-queued ${stuckEvents.rowCount} stuck Jobber event(s)`);

  // Chat posts don't wake anyone, so with Chat set up the check alerts any time.
  // Text-only setups keep the 7am-9pm window.
  // Calls the post-call job never picked up (queue hiccup): process them now.
  const stuckCalls = await db().query<{ conversation_id: string }>(
    `SELECT conversation_id FROM calls
      WHERE processing_status = 'pending' AND created_at < now() - interval '15 minutes' AND created_at > now() - interval '7 days'`,
  );
  for (const c of stuckCalls.rows) await boss.send(Queues.POST_CALL, { conversationId: c.conversation_id });
  if (stuckCalls.rowCount) log.push(`re-queued ${stuckCalls.rowCount} unprocessed call(s)`);

  if (!opts.anyTime && !config.alerts.googleChatWebhookUrl && !isAlertDaytime()) {
    log.push('outside 7am-9pm NZ: alert texts held until morning');
    return log;
  }

  // 1: broken Jobber connections for clients we still look after.
  const broken = await db().query<{ client_id: string; status: 'needs_reconnect' | 'disconnected' }>(
    `SELECT jc.client_id, jc.status
       FROM jobber_connections jc JOIN clients c ON c.id = jc.client_id
      WHERE jc.status <> 'connected' AND c.status IN ('onboarding', 'active')`,
  );
  for (const b of broken.rows) {
    const kind = b.status === 'needs_reconnect' ? 'jobber_needs_reconnect' : 'jobber_disconnected';
    if (await raiseAlert({ kind, clientId: b.client_id })) log.push(`alert ${kind} ${b.client_id}`);
  }

  // 2: repeated text failures (send errors or failed delivery results).
  const failures = await db().query<{ client_id: string; n: string }>(
    `SELECT client_id, count(*) AS n FROM messages
      WHERE created_at > now() - interval '24 hours'
        AND (status = 'failed' OR delivery_status ILIKE 'fail%')
      GROUP BY client_id HAVING count(*) >= $1`,
    [SMS_FAILURE_THRESHOLD],
  );
  for (const f of failures.rows) {
    if (await raiseAlert({ kind: 'sms_failures', clientId: f.client_id, detail: Number(f.n) })) log.push(`alert sms_failures ${f.client_id}`);
  }

  // Calls whose processing failed (after pg-boss retries) in the last day.
  const failedCalls = await db().query<{ client_id: string | null; n: string }>(
    `SELECT client_id, count(*) AS n FROM calls
      WHERE processing_status = 'error' AND created_at > now() - interval '24 hours' GROUP BY client_id`,
  );
  for (const f of failedCalls.rows) {
    if (await raiseAlert({ kind: 'calls_failed', clientId: f.client_id, detail: Number(f.n) })) log.push(`alert calls_failed ${f.client_id ?? ''}`);
  }

  if (stuckEvents.rowCount) {
    if (await raiseAlert({ kind: 'stuck_webhooks', detail: stuckEvents.rowCount })) log.push('alert stuck_webhooks');
  }

  // 4: worker backlog. Jobs deliberately delayed (quiet hours, follow-ups days out) have a
  // future start_after, so they don't count.
  try {
    const backlog = await db().query<{ n: string }>(
      `SELECT count(*) AS n FROM pgboss.job
        WHERE state IN ('created', 'retry') AND start_after < now() - interval '30 minutes'`,
    );
    const n = Number(backlog.rows[0]?.n ?? 0);
    if (n > 0 && (await raiseAlert({ kind: 'queue_backlog', detail: n }))) log.push(`alert queue_backlog ${n}`);
  } catch (err) {
    log.push(`queue backlog check skipped: ${(err as Error).message}`);
  }

  if (!log.length) log.push('all healthy');
  return log;
}
