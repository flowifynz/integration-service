// Lists a client's visits for a day, exactly as the nightly reminder run sees them.
// Use it to check the Jobber date filter works before relying on reminders.
//   node dist/scripts/tomorrowVisits.js <client-slug> [YYYY-MM-DD]   (default: tomorrow, NZ)

import { visitsStartingBetween } from '../automation/jobberItems.ts';
import { localDate, visitWhen, zonedMidnightIso } from '../automation/texts.ts';
import { closeDb, getClientBySlug } from '../db.ts';

const [slug, dateArg] = process.argv.slice(2);
if (!slug) {
  console.error('Usage: node dist/scripts/tomorrowVisits.js <client-slug> [YYYY-MM-DD]');
  process.exit(1);
}
const client = await getClientBySlug(slug);
if (!client) {
  console.error(`No client with slug "${slug}"`);
  process.exit(1);
}
const date = dateArg ?? localDate(new Date(Date.now() + 24 * 3600 * 1000), client.timezone);
const from = zonedMidnightIso(date, client.timezone);
const to = new Date(new Date(from).getTime() + 24 * 3600 * 1000).toISOString();
try {
  const visits = await visitsStartingBetween(client.id, from, to);
  console.log(`${visits.length} visit(s) on ${date} (${from} to ${to}):`);
  for (const v of visits) {
    const when = v.startAt ? visitWhen(v.startAt, v.endAt, v.allDay, client.timezone) : 'unscheduled';
    const phones = v.client.phones.map((p) => p.number).join(', ') || 'no phone';
    console.log(`- ${when} | ${v.client.firstName ?? v.client.companyName ?? '?'} | ${phones} | reminders ${v.client.receivesReminders ? 'on' : 'OFF'}${v.isComplete ? ' | complete' : ''}`);
  }
} catch (err) {
  console.error('Jobber query failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
