// POST /tnz/inbound?key=<TNZ_INBOUND_KEY> — replies to our texts, configured in TNZ.
// Only job right now: honour STOP.
//
// ⚠ TNZ's inbound payload field names are not confirmed — extractInbound() is a guess.
// Check in TNZ's docs (or log one real reply in Test mode) and fix that function only.
//
// Attribution: replies come back to a shared short code, so a STOP can't always be tied
// to one client. If TNZ includes the original message's Reference ('msg-<id>') we opt the
// number out of that client only; otherwise we opt it out of every client (safe default).

import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { safeEqual } from '../crypto.ts';
import { db } from '../db.ts';
import { toE164 } from '../phone.ts';
import { isStopRequest } from '../sms/compose.ts';

function extractInbound(body: Record<string, unknown>): { from?: string; text?: string; reference?: string } {
  return {
    from: (body.Sender ?? body.From ?? body.sender) as string | undefined,
    text: (body.Message ?? body.MessageText ?? body.message) as string | undefined,
    reference: (body.Reference ?? body.OriginalReference) as string | undefined,
  };
}

export async function tnzInboundRoutes(app: FastifyInstance) {
  app.post('/tnz/inbound', async (req, reply) => {
    const { key } = req.query as { key?: string };
    if (!safeEqual(key, config.tnz.inboundKey)) return reply.code(401).send();

    const body = (req.body ?? {}) as Record<string, unknown>;
    const { from, text, reference } = extractInbound(body);
    req.log.info({ from, reference }, 'TNZ inbound'); // no message text in logs

    const phone = toE164(from);
    if (!phone || !isStopRequest(text)) return reply.code(200).send();

    let clientId: string | null = null;
    const messageId = reference?.match(/^msg-(\d+)$/)?.[1];
    if (messageId) {
      const { rows } = await db().query<{ client_id: string }>('SELECT client_id FROM messages WHERE id = $1', [messageId]);
      clientId = rows[0]?.client_id ?? null;
    }
    await db().query(
      `INSERT INTO opt_outs (client_id, phone, source) VALUES ($1, $2, 'sms_stop') ON CONFLICT DO NOTHING`,
      [clientId, phone],
    );
    return reply.code(200).send();
  });
}
