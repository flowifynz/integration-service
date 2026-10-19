// Nightly cron (Render "flowify-reminders"). Only enqueues — the worker does the work,
// so retries and quiet-hours handling live in one place.
// singletonKey = tomorrow's date: if the cron fires twice, reminders still go once.

import '../instrument.ts';
import { closeDb } from '../db.ts';
import { getBoss, Queues, stopBoss } from '../queue.ts';

function tomorrowInNz(now = new Date()): string {
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(tomorrow);
}

const date = tomorrowInNz();
const boss = await getBoss();
const jobId = await boss.send(Queues.DAY_BEFORE_REMINDERS, { date }, { singletonKey: `reminders-${date}` });
console.log(jobId ? `Queued reminders for ${date}` : `Reminders for ${date} already queued`);
await stopBoss();
await closeDb();
