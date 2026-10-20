// POST /tnz/inbound?key=<TNZ_INBOUND_KEY> — TNZ's webhook. Every text we send sets this
// as its WebhookCallbackURL (JSON), so TNZ posts here for:
//   - replies from customers (we act on STOP)
//   - delivery results for our texts (logged for now)
//
// ⚠ TNZ's spec links to the webhook payloads but doesn't define them, so extractInbound()
// (sms/inbound.ts) accepts the likely field names (from TNZ's polling endpoints: From, MessageText,
// MessageID, SubAccount). Each request logs its field NAMES (never values) so the first
// real reply confirms the shape. Then trim extractInbound to the real names.
//
// Attribution: TNZ puts our outbound MessageID on replies it can match, which gives us the
// messages row and so the client. Fallback: the SubAccount. If neither works, the number
// is opted out of every client (safe default for a shared short code).

import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { safeEqual } from '../crypto.ts';
import { db } from '../db.ts';
import { toE164 } from '../phone.ts';
import { isStopRequest } from '../sms/compose.ts';
import { extractInbound } from '../sms/inbound.ts';
import { messageRowIdFromTnz } from '../sms/tnz.ts';

export async function tnzInboundRoutes(app: FastifyInstance) {
  app.post('/tnz/inbound', async (req, reply) => {
    const { key } = req.query as { key?: string };
    if (!safeEqual(key, config.tnz.inboundKey)) return reply.code(401).send();

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const fields = extractInbound(body);
    // Field names only — message text and numbers stay out of the logs.
    req.log.info({ tnzFields: Object.keys(body), hasText: Boolean(fields.text) }, 'TNZ webhook');

    // No reply text → a delivery result. Logged above; nothing else to do yet.
    if (!fields.text) return reply.code(200).send();

    const phone = toE164(fields.from);
    if (!phone || !isStopRequest(fields.text)) return reply.code(200).send();

    let clientId: string | null = null;
    const rowId = messageRowIdFromTnz(fields.messageId);
    if (rowId) {
      const { rows } = await db().query<{ client_id: string }>('SELECT client_id FROM messages WHERE id = $1', [rowId]);
      clientId = rows[0]?.client_id ?? null;
    }
    if (!clientId && fields.subAccount) {
      const { rows } = await db().query<{ id: string }>('SELECT id FROM clients WHERE tnz_subaccount = $1', [fields.subAccount]);
      if (rows.length === 1) clientId = rows[0]!.id;
    }

    await db().query(
      `INSERT INTO opt_outs (client_id, phone, source) VALUES ($1, $2, 'sms_stop') ON CONFLICT DO NOTHING`,
      [clientId, phone],
    );
    req.log.info({ clientId: clientId ?? 'ALL' }, 'SMS opt-out recorded');
    return reply.code(200).send();
  });
}
