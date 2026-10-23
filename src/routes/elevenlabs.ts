// ElevenLabs endpoints.
//
// Tool calls (mid-call):
//   POST /elevenlabs/tools/find_customer           built (step 2)
//   POST /elevenlabs/tools/create_request          built (step 2)
//   POST /elevenlabs/tools/get_availability        stub (step 5)
//   POST /elevenlabs/tools/book_appointment        stub (step 5)
//   POST /elevenlabs/tools/find_upcoming_bookings  stub (step 6)
//   POST /elevenlabs/tools/reschedule_appointment  stub (step 6)
// Webhooks:
//   POST /elevenlabs/call-start   personalisation: greet a known caller by first name
//   POST /elevenlabs/post-call    store the call, then the worker texts and fills gaps (D3)
//
// Every tool and the call-start webhook must send header `x-flowify-secret`.
// Which client a call belongs to: `called_number` ({{system__called_number}}, the number
// dialled), falling back to `agent_id` ({{system__agent_id}}) — which also works in
// ElevenLabs' browser tests, where there's no phone number. Set clients.elevenlabs_agent_id.
//
// Responses are JSON the agent reads. `message` tells the agent what to do or say next.
// Tool failures still return 200 with ok:false and a message, so the agent carries on
// gracefully instead of the call stalling on an error.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { safeEqual } from '../crypto.ts';
import { type ClientRow, db } from '../db.ts';
import { verifyElevenLabsSignature } from '../elevenlabsSignature.ts';
import { Sentry } from '../instrument.ts';
import { logJobberRequest, resolveClient } from '../calls/logRequest.ts';
import { extractPostCall } from '../calls/postCall.ts';
import { confirmName, looksMadeUp, normaliseUrgency, type PhoneSource, ownerAlertText } from '../jobber/callerText.ts';
import { findClientsByPhone, pickClient } from '../jobber/clients.ts';
import { formatNational, toE164 } from '../phone.ts';
import { getBoss, Queues } from '../queue.ts';
import type { SendSmsJob } from '../sms/outbound.ts';

interface ToolBody {
  called_number?: string;
  agent_id?: string;
  caller_number?: string;
  conversation_id?: string;
  [key: string]: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const notImplemented = (reply: FastifyReply, tool: string) =>
  reply.send({
    ok: false,
    error: 'not_implemented',
    tool,
    message: "This isn't available yet. Take the caller's details and say the team will call them back.",
  });

const featureOff = (reply: FastifyReply, message: string) => reply.send({ ok: false, error: 'feature_off', message });

function tool(
  handler: (args: { req: FastifyRequest; reply: FastifyReply; body: ToolBody; client: ClientRow }) => Promise<unknown>,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as ToolBody;
    const client = await resolveClient(body);
    if (!client) {
      req.log.error({ called: body.called_number, agent: body.agent_id }, 'Tool call for unknown client');
      return reply.send({
        ok: false,
        error: 'unknown_client',
        message: "There's a system problem. Take the caller's name, number and what they need, and say the team will call them back.",
      });
    }
    return handler({ req, reply, body, client });
  };
}

// Live booking is part of Core, switched on per client (booking_mode / rescheduling_enabled).
const canBook = (c: ClientRow) => c.tier === 'core' && c.booking_mode !== 'capture_request';
const canReschedule = (c: ClientRow) => c.tier === 'core' && c.rescheduling_enabled;

async function queueOwnerAlert(client: ClientRow, text: string, key: string) {
  if (!client.owner_mobile) return;
  const job: SendSmsJob = { clientId: client.id, kind: 'owner_alert', toPhone: client.owner_mobile, text, idempotencyKey: key };
  await (await getBoss()).send(Queues.SEND_SMS, job);
}

export async function elevenLabsToolRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!safeEqual(req.headers['x-flowify-secret'] as string | undefined, config.elevenlabs.toolSecret)) {
      return reply.code(401).send({ ok: false, error: 'unauthorised' });
    }
  });

  // ---- find_customer ---------------------------------------------------------------
  // Body: { called_number, agent_id, caller_number, phone? }
  // `phone` is a number the caller says out loud (no caller ID, or browser tests).
  // Returns first name only — no addresses or job details before identity is confirmed.
  app.post(
    '/tools/find_customer',
    tool(async ({ req, reply, body, client }) => {
      const e164 = toE164(str(body.caller_number)) ?? toE164(str(body.phone));
      if (!e164) {
        return reply.send({
          ok: true,
          found: false,
          reason: 'no_number',
          message: 'No caller ID. Ask for the best number to reach them on, then call find_customer again with that number as phone.',
        });
      }
      try {
        const matches = await findClientsByPhone(client.id, e164, { timeoutMs: 3_000 });
        const match = pickClient(matches);
        return reply.send(
          match
            ? {
                ok: true,
                found: true,
                first_name: match.firstName,
                customer_name: confirmName(match),
                // Confirm, don't ask. Only reveals the name to someone holding that customer's phone.
                message: `Existing customer on file as ${confirmName(match)}. Confirm by asking "Am I speaking with ${confirmName(match)}?" instead of asking for their name. If they say no, take their full name as normal. Never read out an address or job details; always ask for the site address.`,
              }
            : { ok: true, found: false, message: 'New caller. Take their full name, site address and what they need.' },
        );
      } catch (err) {
        req.log.error({ err, clientId: client.id }, 'find_customer failed');
        Sentry.captureException(err);
        return reply.send({ ok: false, found: false, message: 'Records unavailable right now. Carry on and take their details as normal.' });
      }
    }),
  );

  // ---- create_request -------------------------------------------------------------
  // Body: { called_number, agent_id, caller_number, conversation_id, name, phone?, address,
  //         description, urgency }
  // Matches the caller to an existing Jobber client by phone (or creates one), logs a request
  // with the details in a note, and texts the owner. If Jobber is unreachable the owner text
  // still goes out with everything the caller said, so no enquiry is lost.
  app.post(
    '/tools/create_request',
    tool(async ({ req, reply, body, client }) => {
      const name = str(body.name);
      const description = str(body.description);
      if (!name || !description) {
        return reply.send({
          ok: false,
          error: 'missing_details',
          message: `Before logging this, ask for ${[!name && "the caller's full name", !description && 'what they need done'].filter(Boolean).join(' and ')}.`,
        });
      }
      const address = str(body.address);
      const urgency = normaliseUrgency(body.urgency);
      const callerId = toE164(str(body.caller_number));
      const phoneArg = str(body.phone);
      const spokenPhone = toE164(phoneArg);

      // No caller ID: the only number we have is one the caller said, so make sure we got one
      // and that it isn't something the model invented ("the one I'm calling from" → 022 123 4567).
      if (!callerId) {
        if (phoneArg?.toLowerCase() !== 'none' && !spokenPhone) {
          return reply.send({
            ok: false,
            error: 'need_number',
            message:
              "There's no caller ID, so you can't see the number they're calling from. Ask them to say their phone number, digit by digit. If they won't give one, call create_request again with phone set to none.",
          });
        }
      }
      if (spokenPhone && looksMadeUp(formatNational(spokenPhone))) {
        return reply.send({
          ok: false,
          error: 'check_number',
          message: "That number doesn't look right. Ask the caller to say their phone number again, digit by digit, and use only the digits they actually say.",
        });
      }

      const matchPhone = callerId ?? spokenPhone; // who they are
      const callbackPhone = spokenPhone ?? callerId; // where to call back
      const callbackDisplay = callbackPhone ? formatNational(callbackPhone) : null;
      const phoneSource: PhoneSource = spokenPhone ? (callerId ? 'spoken' : 'spoken_no_caller_id') : callerId ? 'caller_id' : 'none';
      const conversationId = str(body.conversation_id);

      let requestId: string | null = null;
      try {
        requestId = await logJobberRequest(client, { name, matchPhone, callbackDisplay, phoneSource, address, description, urgency });
      } catch (err) {
        req.log.error({ err, clientId: client.id }, 'create_request: Jobber failed');
        Sentry.captureException(err);
      }

      await queueOwnerAlert(
        client,
        ownerAlertText({ callerName: name, callbackPhone: callbackDisplay, phoneSource, address, description, urgency, loggedInJobber: Boolean(requestId) }),
        `${client.id}:${requestId ?? conversationId ?? Date.now()}:owner_alert`,
      ).catch((err) => req.log.error({ err }, 'owner alert queue failed'));

      if (conversationId) {
        await db()
          .query(
            // COALESCE: a second create_request in the same call that fails must not wipe the first one's ID.
            `INSERT INTO calls (conversation_id, client_id, caller_phone, outcome, jobber_request_id, request_source)
             VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE 'tool' END)
             ON CONFLICT (conversation_id) DO UPDATE
               SET client_id = EXCLUDED.client_id,
                   outcome = CASE WHEN calls.jobber_request_id IS NOT NULL THEN calls.outcome ELSE EXCLUDED.outcome END,
                   jobber_request_id = COALESCE(calls.jobber_request_id, EXCLUDED.jobber_request_id),
                   request_source = COALESCE(calls.request_source, EXCLUDED.request_source)`,
            [conversationId, client.id, callerId, requestId ? 'request_logged' : 'request_failed', requestId],
          )
          .catch((err) => req.log.error({ err }, 'calls upsert failed'));
      }

      return reply.send({
        ok: true,
        logged: Boolean(requestId),
        message: `Done. Tell the caller their request has been passed to the ${client.business_name} team${
          urgency === 'emergency' ? ', flagged as urgent,' : ''
        } and someone will be in touch${callbackDisplay ? ` on ${callbackDisplay}` : ' as soon as they can'}.`,
      });
    }),
  );

  // ---- booking tools (steps 5–6) ---------------------------------------------------
  app.post(
    '/tools/get_availability',
    tool(async ({ reply, client }) => {
      if (!canBook(client)) return featureOff(reply, "You can't book times. Take their details with create_request and say the team will call to arrange a time.");
      return notImplemented(reply, 'get_availability');
    }),
  );
  app.post(
    '/tools/book_appointment',
    tool(async ({ reply, client }) => {
      if (!canBook(client)) return featureOff(reply, "You can't book times. Take their details with create_request and say the team will call to arrange a time.");
      return notImplemented(reply, 'book_appointment');
    }),
  );
  app.post(
    '/tools/find_upcoming_bookings',
    tool(async ({ reply, client }) => {
      if (!canReschedule(client)) return featureOff(reply, "You can't look up bookings. Take their details and say the team will call them back.");
      return notImplemented(reply, 'find_upcoming_bookings');
    }),
  );
  app.post(
    '/tools/reschedule_appointment',
    tool(async ({ reply, client }) => {
      if (!canReschedule(client)) return featureOff(reply, "Say you'll let the team know they'd like to change their booking, and they'll call back.");
      return notImplemented(reply, 'reschedule_appointment');
    }),
  );

  // ---- call-start personalisation -------------------------------------------------
  // ElevenLabs sends { caller_id, agent_id, called_number, call_sid, conversation_id } and
  // waits for this before greeting, so the Jobber lookup gets a tight 1.5 s budget.
  // The response must contain EVERY dynamic variable defined on the agent.
  app.post('/call-start', async (req) => {
    const body = (req.body ?? {}) as { caller_id?: string; called_number?: string; agent_id?: string };
    const client = await resolveClient(body);
    let firstName = '';
    let customerName = 'none';
    const caller = toE164(str(body.caller_id));
    if (client && caller) {
      try {
        const matches = await findClientsByPhone(client.id, caller, { timeoutMs: 1_500 });
        if (matches.length === 1) {
          firstName = matches[0]!.firstName;
          customerName = confirmName(matches[0]!);
        }
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'call-start lookup skipped');
      }
    }
    return {
      type: 'conversation_initiation_client_data',
      dynamic_variables: {
        business_name: client?.business_name ?? '',
        customer_first_name: firstName,
        // Ready-made opener for the first message, so new callers don't get "Kia ora ,".
        greeting: firstName ? `Kia ora ${firstName}` : 'Kia ora',
        // So the agent doesn't ask for a number it already has, or look the caller up twice.
        caller_id_available: caller ? 'yes' : 'no',
        customer_name: customerName, // 'none' if not found or no caller ID
        tier: client?.tier ?? '',
        can_book: client ? canBook(client) : false,
        can_reschedule: client ? canReschedule(client) : false,
      },
    };
  });
}

// Post-call webhook: signed by ElevenLabs (HMAC over the raw body), so it needs the raw body.
// Stores the call and queues processing (calls/processCall.ts); answers fast so ElevenLabs
// doesn't retry. Only post_call_transcription is used: post_call_audio is ignored (it would
// overwrite the transcript), and so is call_initiation_failure (outbound calls only).
export async function elevenLabsPostCallRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/post-call', async (req, reply) => {
    const raw = req.body as Buffer;
    if (!verifyElevenLabsSignature(raw, req.headers['elevenlabs-signature'] as string | undefined, config.elevenlabs.webhookSecret)) {
      return reply.code(401).send();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send();
    }
    const info = extractPostCall(payload);
    if (info.type !== 'post_call_transcription' || !info.conversationId) {
      req.log.info({ type: info.type }, 'post-call webhook ignored');
      return reply.code(200).send();
    }

    // create_request may already have made this row; keep its fields and add the rest.
    await db().query(
      `INSERT INTO calls (conversation_id, payload, agent_id, called_number, caller_phone, started_at, duration_seconds,
                          summary, termination_reason, call_successful, processing_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
       ON CONFLICT (conversation_id) DO UPDATE SET
         payload = EXCLUDED.payload, agent_id = EXCLUDED.agent_id, called_number = EXCLUDED.called_number,
         caller_phone = COALESCE(calls.caller_phone, EXCLUDED.caller_phone), started_at = EXCLUDED.started_at,
         duration_seconds = EXCLUDED.duration_seconds, summary = EXCLUDED.summary,
         termination_reason = EXCLUDED.termination_reason, call_successful = EXCLUDED.call_successful,
         processing_status = CASE WHEN calls.processing_status = 'done' THEN 'done' ELSE 'pending' END`,
      [
        info.conversationId,
        raw.toString('utf8'),
        info.agentId,
        toE164(info.calledNumber),
        toE164(info.callerNumber),
        info.startedAt,
        info.durationSecs === null ? null : Math.round(info.durationSecs),
        info.summary,
        info.terminationReason,
        info.callSuccessful,
      ],
    );
    try {
      await (await getBoss()).send(Queues.POST_CALL, { conversationId: info.conversationId }, { singletonKey: info.conversationId });
    } catch (err) {
      req.log.error({ err }, 'post-call queue failed'); // the hourly health check re-queues pending calls
    }
    return reply.code(200).send();
  });
}
