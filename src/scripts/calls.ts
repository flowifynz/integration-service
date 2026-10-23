// Recent calls and what happened after each one (backlog D3).
//   node dist/scripts/calls.js                     last 10 calls
//   node dist/scripts/calls.js <slug>              last 10 for one client
//   node dist/scripts/calls.js --reprocess <conversation_id>
//       run the after-call steps again (texts are still sent at most once)

import { closeDb, db } from '../db.ts';
import { getBoss, Queues, stopBoss } from '../queue.ts';

const args = process.argv.slice(2);
try {
  if (args[0] === '--reprocess') {
    const id = args[1];
    if (!id) throw new Error('Usage: node dist/scripts/calls.js --reprocess <conversation_id>');
    const r = await db().query(
      `UPDATE calls SET processing_status = 'pending', processing_error = NULL WHERE conversation_id = $1 AND payload IS NOT NULL`,
      [id],
    );
    if (!r.rowCount) throw new Error(`No call ${id} with a post-call payload`);
    await (await getBoss()).send(Queues.POST_CALL, { conversationId: id });
    console.log('Queued. The worker processes it within a minute; run this script again to see the result.');
  } else {
    const slug = args[0];
    const { rows } = await db().query(
      `SELECT to_char(c.started_at AT TIME ZONE 'Pacific/Auckland', 'DD Mon HH24:MI') AS started,
              cl.slug, c.duration_seconds AS secs, c.category, c.caller_name, c.outcome,
              c.request_source AS request, c.processing_status AS status,
              COALESCE(c.needs_review, c.processing_error) AS note, c.conversation_id
         FROM calls c LEFT JOIN clients cl ON cl.id = c.client_id
        WHERE ($1::text IS NULL OR cl.slug = $1)
        ORDER BY c.id DESC LIMIT 10`,
      [slug ?? null],
    );
    console.table(rows);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await stopBoss();
  await closeDb();
}
