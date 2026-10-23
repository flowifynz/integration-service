// POST /tnz/inbound?key=<TNZ_INBOUND_KEY> — TNZ's webhook. Every text we send sets this
// as its WebhookCallbackURL (JSON), so TNZ posts here for:
//   - the final result of each text we sent (Type 'SMS'): we record price, segments and
//     delivery status for billing; a "blacklisted" result becomes an opt-out on our side
//   - replies (Type 'SMSReply' / 'SMSInbound'): we act on STOP
// See sms/inbound.ts for the payload.
//
// Attribution: TNZ puts our outbound MessageID on results and matched replies, which gives
// us the messages row and so the client. Fallback for replies: the SubAccount. If neither
// works, a STOP opts the number out of every client (safe default for a shared short code).

import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { safeEqual } from '../crypto.ts';
import { db } from '../db.ts';
import { isMobile, toE164 } from '../phone.ts';
import { isStopRequest } from '../sms/compose.ts';
import { extractInbound, isBlacklisted, isReply, isSendResult } from '../sms/inbound.ts';
import { messageRowIdFromTnz } from '../sms/tnz.ts';

export async function tnzInboundRoutes(app: FastifyInstance) {
  app.post('/tnz/inbound', async (req, reply) => {
    const { key } = req.query as { key?: string };
    if (!safeEqual(key, config.tnz.inboundKey)) return reply.code(401).send();

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const f = extractInbound(body);
    const rowId = messageRowIdFromTnz(f.messageId);

    // ---- Result of a text we sent: record cost + delivery ------------------------------
    if (isSendResult(f)) {
      const blacklisted = isBlacklisted(f);
      req.log.info(
        { tnz: { type: f.type, status: f.status, result: f.result, ourMessageId: Boolean(rowId), price: f.price, parts: f.smsParts, blacklisted } },
        'TNZ result',
      );
      if (!rowId) return reply.code(200).send();

      const { rows } = await db().query<{ client_id: string; to_phone: string }>(
        `UPDATE messages
            SET price = $2, sms_parts = $3, delivery_status = $4, delivery_result = $5, result_at = now()
          WHERE id = $1
          RETURNING client_id, to_phone`,
        [rowId, f.price, f.smsParts, f.status ?? null, f.result ?? f.detail ?? null],
      );
      const msg = rows[0];
      if (msg && blacklisted) {
        // TNZ has this number on its opt-out list; mirror it so we stop trying.
        await db().query(
          `INSERT INTO opt_outs (client_id, phone, source) VALUES ($1, $2, 'tnz_blacklist') ON CONFLICT DO NOTHING`,
          [msg.client_id, msg.to_phone],
        );
      }
      return reply.code(200).send();
    }

    // ---- Reply: act on STOP ---------------------------------------------------------
    const phone = f.phoneCandidates.map((p) => toE164(p)).find((p): p is string => Boolean(p && isMobile(p))) ?? null;
    const isStop = isReply(f) && f.textCandidates.some((t) => isStopRequest(t));

    // Shape only — no numbers, no message text, no API key.
    req.log.info(
      {
        tnz: {
          type: f.type,
          status: f.status,
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
      const { rows } = await db().query<{ id: string }>(
        'SELECT id FROM clients WHERE tnz_subaccount = $1 OR (tnz_subaccount IS NULL AND slug = $1)',
        [f.subAccount],
      );
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
