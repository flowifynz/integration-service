// Job queue on Postgres via pg-boss (no Redis). The web service only sends jobs;
// the worker processes them. pg-boss retries failed jobs with backoff.

import PgBoss from 'pg-boss';
import { config } from './config.ts';

export const Queues = {
  /** Send one SMS through TNZ (see sms/outbound.ts). */
  SEND_SMS: 'send-sms',
  /** Process one stored Jobber webhook event (see worker.ts). */
  JOBBER_EVENT: 'jobber-event',
  /** Delayed re-check of a Jobber item before texting (see automation/run.ts). */
  FOLLOW_UP_CHECK: 'follow-up-check',
  /** Nightly: text every client's customers about tomorrow's visits. */
  DAY_BEFORE_REMINDERS: 'day-before-reminders',
  /** Text one admin_alerts row to Jaron (see alerts/alerts.ts). */
  SEND_ADMIN_ALERT: 'send-admin-alert',
  /** Act on one finished call: record, safety-net request, texts (see calls/processCall.ts). */
  POST_CALL: 'post-call',
  /** Hourly: repeat unresolved alerts, find stuck events and backed-up queues. */
  HEALTH_CHECK: 'health-check',
  /** Flowify's own texts (src/internal/sms.ts). Never a client text. */
  INTERNAL_SMS: 'internal-send-sms',
  /** Flowify's own Google Chat posts, e.g. a new website booking (src/internal/chat.ts). */
  INTERNAL_CHAT: 'internal-chat',
} as const;

export type QueueName = (typeof Queues)[keyof typeof Queues];

let boss: PgBoss | undefined;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  const instance = new PgBoss({ connectionString: config.databaseUrl });
  instance.on('error', (err) => console.error('pg-boss error', err));
  await instance.start();

  // pg-boss v10 requires queues to exist before send/work.
  for (const name of Object.values(Queues)) {
    if (!(await instance.getQueue(name))) {
      // pg-boss v10's Queue type requires `name` inside the options too.
      await instance.createQueue(name, {
        name,
        retryLimit: 5,
        retryDelay: 30, // seconds; doubles each attempt with retryBackoff
        retryBackoff: true,
        expireInSeconds: 120,
      });
    }
  }
  boss = instance;
  return boss;
}

export async function stopBoss(): Promise<void> {
  await boss?.stop({ graceful: true });
  boss = undefined;
}
