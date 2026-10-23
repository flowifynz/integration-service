// POST /jobber/webhooks — every Jobber webhook for every client lands here.
//
// Jobber wants a 2xx within 1 second, so this handler does the minimum:
// verify signature → store (deduped) → enqueue → 200. All Jobber lookups and texts
// happen in the worker. Target: well under 100 ms.

import type { FastifyInstance } from 'fastify';
import { raiseAlert } from '../alerts/alerts.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { clientIdForAccount, markDisconnectedByAccount } from '../jobber/connection.ts';
import { JOBBER_SIGNATURE_HEADER, parseJobberWebhook, verifyJobberSignature, webhookDedupeKey } from '../jobber/webhook.ts';
import { getBoss, Queues } from '../queue.ts';

export async function jobberWebhookRoutes(app: FastifyInstance) {
  // Keep the raw body for HMAC verification. Scoped to this plugin only.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/jobber/webhooks', async (req, reply) => {
    const raw = req.body as Buffer;
    const signature = req.headers[JOBBER_SIGNATURE_HEADER] as string | undefined;
    if (!verifyJobberSignature(raw, signature, config.jobber.clientSecret)) {
      req.log.warn('Jobber webhook with bad signature');
      return reply.code(401).send();
    }

    const evt = parseJobberWebhook(raw);
    if (!evt) return reply.code(400).send();

    const clientId = await clientIdForAccount(evt.accountId);
    const inserted = await db().query<{ id: string }>(
      `INSERT INTO webhook_events (client_id, jobber_account_id, topic, item_id, occurred_at, dedupe_key, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        clientId,
        evt.accountId,
        evt.topic,
        evt.itemId ?? null,
        evt.occurredAt ?? null,
        webhookDedupeKey(evt),
        raw.toString('utf8'),
        clientId ? 'received' : 'ignored',
      ],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) return reply.code(200).send(); // duplicate delivery — already handled

    if (evt.topic === 'APP_DISCONNECT') {
      // Client removed Flowify from Jobber. Quick single UPDATE, safe to do inline.
      const disconnected = await markDisconnectedByAccount(evt.accountId);
      req.log.warn({ jobberAccountId: evt.accountId, clientId: disconnected }, 'Jobber app disconnected');
      await db().query(`UPDATE webhook_events SET status = 'processed', processed_at = now() WHERE id = $1`, [eventId]);
      // A disconnect usually means a cancellation or a mistake — either way Jaron needs to know.
      // raiseAlert only inserts a row and queues a job, so it stays well inside Jobber's 1 s.
      if (disconnected) await raiseAlert({ kind: 'jobber_disconnected', clientId: disconnected });
    } else if (clientId) {
      // If this send fails the event stays 'received'; the weekly check / a sweeper picks it up.
      await (await getBoss()).send(Queues.JOBBER_EVENT, { eventId });
    }
    return reply.code(200).send();
  });
}
