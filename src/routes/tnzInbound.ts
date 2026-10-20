// POST /tnz/inbound?key=<TNZ_INBOUND_KEY> — TNZ's webhook. Every text we send sets this
// as its WebhookCallbackURL (JSON), so TNZ posts here for:
//   - replies from customers (we act on STOP)
//   - delivery results for our texts (logged for now)
// Both arrive with the same field set; see sms/inbound.ts.
//
// Attribution: TNZ puts our outbound MessageID on replies it can match, which gives us the
// messages row and so the client. Fallback: the SubAccount. If neither works, the number
// is opted out of every client (safe default for a shared short code).

import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { safeEqual } from '../crypto.ts';
import { db } from '../db.ts';
import { isMobile, toE164 } from '../phone.ts';
import { isStopRequest } from '../sms/compose.ts';
import { extractInbound } from '../sms/inbound.ts';
import { messageRowIdFromTnz } from '../sms/tnz.ts';

export async function tnzInboundRoutes(app: FastifyInstance) {
  app.post('/tnz/inbound', async (req, reply) => {
    const { key } = req.query as { key?: string };
    if (!safeEqual(key, config.tnz.inboundKey)) return reply.code(401).send();

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const f = extractInbound(body);

    // First candidate that is a valid NZ mobile; first text that is a STOP request.
    const phone = f.phoneCandidates.map((p) => toE164(p)).find((p): p is string => Boolean(p && isMobile(p))) ?? null;
    const isStop = f.textCandidates.some((t) => isStopRequest(t));
    const rowId = messageRowIdFromTnz(f.messageId);

    // Shape only — no numbers, no message text, no API key.
    req.log.info(
      {
        tnz: {
          type: f.type,
          status: f.status,
          result: f.result,
          hasReceivedId: Boolean(f.receivedId),
          phoneFound: Boolean(phone),
          isStop,
          ourMessageId: Boolean(rowId),
          hasSubAccount: Boolean(f.subAccount),
        },
      },
      'TNZ webhook',
    );

    if (!phone || !isStop) return reply.code(200).send();

    let clientId: string | null = null;
    if (rowId) {
      const { rows } = await db().query<{ client_id: string }>('SELECT client_id FROM messages WHERE id = $1', [rowId]);
      clientId = rows[0]?.client_id ?? null;
    }
    if (!clientId && f.subAccount) {
      const { rows } = await db().query<{ id: string }>('SELECT id FROM clients WHERE tnz_subaccount = $1', [f.subAccount]);
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
