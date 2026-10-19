// ElevenLabs endpoints.
//
// Tool calls (mid-call, latency-critical — target < 1.5 s end to end):
//   POST /elevenlabs/tools/find_customer
//   POST /elevenlabs/tools/create_request          (Run tier — see note below)
//   POST /elevenlabs/tools/get_availability
//   POST /elevenlabs/tools/book_appointment
//   POST /elevenlabs/tools/find_upcoming_bookings
//   POST /elevenlabs/tools/reschedule_appointment
// Webhooks:
//   POST /elevenlabs/call-start   (personalisation: greet a known caller by name)
//   POST /elevenlabs/post-call    (log the call + text the owner a summary)
//
// Every tool and the call-start webhook must send header `x-flowify-secret`.
// Every tool body must include `called_number` — set it in ElevenLabs to the dynamic
// variable {{system__called_number}} (the Twilio number the caller dialled), which is how
// we know which client the call belongs to. Most tools also take `caller_number`
// = {{system__caller_id}}.
//
// NOTE: the brief lists five tools, but Run-tier clients need to log a Jobber request
// during the call, so create_request is added here. (Alternative: create the request
// from the post-call webhook — simpler, but the caller gets no confirmation on the call.)
//
// Responses are JSON the agent reads, so `message` fields are written to be spoken.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { safeEqual } from '../crypto.ts';
import { type ClientRow, db } from '../db.ts';
import { verifyElevenLabsSignature } from '../elevenlabsSignature.ts';
import { toE164 } from '../phone.ts';

interface ToolBody {
  called_number?: string;
  caller_number?: string;
  [key: string]: unknown;
}

/** Find the Flowify client from the number the caller dialled. */
async function resolveClient(body: ToolBody): Promise<ClientRow | null> {
  const dialled = toE164(body.called_number);
  if (!dialled) return null;
  const { rows } = await db().query<ClientRow>(
    `SELECT * FROM clients WHERE agent_phone = $1 AND status IN ('active', 'onboarding')`,
    [dialled],
  );
  return rows[0] ?? null;
}

const notImplemented = (reply: FastifyReply, tool: string) =>
  reply.code(501).send({
    ok: false,
    error: 'not_implemented',
    tool,
    message: "Sorry, I can't do that over the phone just yet. I'll take your details and someone will call you back.",
  });

const featureOff = (reply: FastifyReply, message: string) => reply.send({ ok: false, error: 'feature_off', message });

/** Wraps a tool handler with client resolution. */
function tool(
  handler: (args: { req: FastifyRequest; reply: FastifyReply; body: ToolBody; client: ClientRow }) => Promise<unknown>,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as ToolBody;
    const client = await resolveClient(body);
    if (!client) {
      req.log.error({ called: body.called_number }, 'Tool call for unknown agent number');
      return reply.code(404).send({
        ok: false,
        error: 'unknown_client',
        message: "Sorry, I'm having trouble with our system. Can I take your name and number for a call back?",
      });
    }
    return handler({ req, reply, body, client });
  };
}

const canBook = (c: ClientRow) => c.tier === 'receptionist' && c.booking_mode !== 'capture_request';
const canReschedule = (c: ClientRow) => c.tier === 'receptionist' && c.rescheduling_enabled;

export async function elevenLabsToolRoutes(app: FastifyInstance) {
  // Shared-secret check for everything in this plugin.
  app.addHook('preHandler', async (req, reply) => {
    if (!safeEqual(req.headers['x-flowify-secret'] as string | undefined, config.elevenlabs.toolSecret)) {
      return reply.code(401).send({ ok: false, error: 'unauthorised' });
    }
  });

  // find_customer — body: { called_number, caller_number }
  // Returns { found, customer: { name, ... } } — never addresses or bookings here: identity
  // isn't confirmed yet (NZ Privacy Act). Build step 2.
  app.post(
    '/tools/find_customer',
    tool(async ({ reply }) => notImplemented(reply, 'find_customer')),
  );

  // create_request — body: { called_number, caller_number, name, phone, address, description }
  // Creates (or matches) the Jobber client and logs a request. Build step 2.
  app.post(
    '/tools/create_request',
    tool(async ({ reply }) => notImplemented(reply, 'create_request')),
  );

  // get_availability — body: { called_number, job_type?, preferred_day? }
  // v1: AM/PM windows with capacity, next 10 working days, first 2–3 with space. Build step 5.
  app.post(
    '/tools/get_availability',
    tool(async ({ reply, client }) => {
      if (!canBook(client)) return featureOff(reply, "I can't book times directly, but I'll pass your details on and we'll call you to arrange a time.");
      return notImplemented(reply, 'get_availability');
    }),
  );

  // book_appointment — body: { called_number, caller_number, slot_id, name, address, description }
  // Re-checks the slot is still free, books in Jobber, queues confirmation text + email. Build step 5.
  app.post(
    '/tools/book_appointment',
    tool(async ({ reply, client }) => {
      if (!canBook(client)) return featureOff(reply, "I can't book times directly, but I'll pass your details on and we'll call you to arrange a time.");
      return notImplemented(reply, 'book_appointment');
    }),
  );

  // find_upcoming_bookings — body: { called_number, caller_number, confirmed_name, confirmed_address }
  // Only answers if name AND site address match the Jobber record (identity check). Build step 6.
  app.post(
    '/tools/find_upcoming_bookings',
    tool(async ({ reply, client }) => {
      if (!canReschedule(client)) return featureOff(reply, "I can't look up bookings, but I'll ask the team to call you back about it.");
      return notImplemented(reply, 'find_upcoming_bookings');
    }),
  );

  // reschedule_appointment — body: { called_number, caller_number, visit_id, slot_id }
  // Re-verifies the visit belongs to this caller, moves it, queues new text + email. Build step 6.
  // When rescheduling is off: log the request and text the owner instead.
  app.post(
    '/tools/reschedule_appointment',
    tool(async ({ reply, client }) => {
      if (!canReschedule(client)) return featureOff(reply, "I'll let the team know you'd like to change your booking, and they'll call you back.");
      return notImplemented(reply, 'reschedule_appointment');
    }),
  );

  // Call-start personalisation. ElevenLabs sends { caller_id, agent_id, called_number, call_sid }
  // and expects dynamic variables back (confirm the exact shape in ElevenLabs' docs).
  // Must be fast — the caller is waiting for the greeting.
  app.post('/call-start', async (req) => {
    const body = (req.body ?? {}) as { caller_id?: string; called_number?: string };
    const client = await resolveClient({ called_number: body.called_number });
    return {
      type: 'conversation_initiation_client_data',
      dynamic_variables: {
        business_name: client?.business_name ?? '',
        customer_first_name: '', // TODO(step 2): look up caller_id in Jobber, first name only
        tier: client?.tier ?? '',
        can_book: client ? canBook(client) : false,
        can_reschedule: client ? canReschedule(client) : false,
      },
    };
  });
}

// Post-call webhook. Separate plugin: it's signed by ElevenLabs (HMAC over the raw body)
// rather than our shared-secret header, so it needs the raw body.
export async function elevenLabsPostCallRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/post-call', async (req, reply) => {
    const raw = req.body as Buffer;
    if (!verifyElevenLabsSignature(raw, req.headers['elevenlabs-signature'] as string | undefined, config.elevenlabs.webhookSecret)) {
      return reply.code(401).send();
    }
    const payload = JSON.parse(raw.toString('utf8')) as { data?: { conversation_id?: string } };
    // Store the raw payload now; parsing it into calls columns + owner summary text is step 7.
    await db().query(
      `INSERT INTO calls (conversation_id, payload) VALUES ($1, $2) ON CONFLICT (conversation_id) DO NOTHING`,
      [payload.data?.conversation_id ?? null, raw.toString('utf8')],
    );
    return reply.code(200).send();
  });
}
