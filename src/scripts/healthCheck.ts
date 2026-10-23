// Run the health check now, ignoring the 7am-9pm window.
//   node dist/scripts/healthCheck.js
// Send a test alert to Google Chat (and ALERT_MOBILE if set). Proves the webhook + worker:
//   node dist/scripts/healthCheck.js --test
// Recent alerts:
//   node dist/scripts/healthCheck.js --list

import '../instrument.ts';
import { raiseAlert } from '../alerts/alerts.ts';
import { runHealthCheck } from '../alerts/healthCheck.ts';
import { closeDb, db } from '../db.ts';
import { stopBoss } from '../queue.ts';

if (process.argv.includes('--test')) {
  const ok = await raiseAlert({ kind: 'test', detail: new Date().toISOString().slice(11, 16) + ' UTC', dedupeKey: `test:${Date.now()}` });
  console.log(ok ? 'Test alert queued. The worker sends it within a minute; check with --list.' : 'Test alert failed to queue (see error above).');
} else if (process.argv.includes('--list')) {
  const { rows } = await db().query(
    `SELECT a.id, a.kind, c.slug, a.status, a.error, a.chat_sent_at, a.created_at
       FROM admin_alerts a LEFT JOIN clients c ON c.id = a.client_id
      ORDER BY a.id DESC LIMIT 15`,
  );
  console.table(rows);
} else {
  for (const line of await runHealthCheck({ anyTime: true })) console.log(line);
}

await stopBoss();
await closeDb();
