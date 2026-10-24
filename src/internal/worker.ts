// Worker jobs for Flowify's own automations. Registered by worker.ts alongside the client
// jobs, on their own queues, so a problem here never blocks a client's texts.

import type PgBoss from 'pg-boss';
import { Sentry } from '../instrument.ts';
import { Queues } from '../queue.ts';
import { db } from '../db.ts';
import { type InternalChatJob, queueInternalChat, sendInternalChat } from './chat.ts';
import { sendInternalSms } from './sms.ts';

export async function registerInternalWorkers(boss: PgBoss): Promise<void> {
  await boss.work<{ messageId: string }>(Queues.INTERNAL_SMS, async ([job]) => {
    if (!job) return;
    const result = await sendInternalSms(job.data.messageId);
    console.log(`[internal sms ${job.data.messageId}] ${result}`);
    if (result === 'failed_permanent') {
      const { rows } = await db().query<{ booking_id: string | null; error: string | null }>(
        'SELECT booking_id, error FROM internal.messages WHERE id = $1',
        [job.data.messageId],
      );
      const row = rows[0];
      Sentry.withScope((scope) => {
        scope.setTag('scope', 'internal');
        Sentry.captureMessage(`Internal SMS permanently failed: ${row?.error ?? 'unknown'}`, 'warning');
      });
      if (row?.booking_id) {
        await queueInternalChat({ kind: 'sms_failed', bookingId: row.booking_id, detail: (row.error ?? 'TNZ refused it').slice(0, 200) });
      }
    }
  });

  await boss.work<InternalChatJob>(Queues.INTERNAL_CHAT, async ([job]) => {
    if (!job) return;
    console.log(`[internal chat ${job.data.kind} ${job.data.bookingId}] ${await sendInternalChat(job.data)}`);
  });
}
