// Flowify's own website agent ("book a discovery call") — ElevenLabs webhook tools.
//
//   POST /internal/tools/check_availability    free discovery-call times from Flowify's GHL calendar
//   POST /internal/tools/book_discovery_call   GHL contact + appointment, then text + Chat notice
//
// Every call must send header `x-flowify-secret` = INTERNAL_TOOL_SECRET (NOT the client
// ELEVENLABS_TOOL_SECRET). Optional INTERNAL_AGENT_IDS limits which agents may call.
// INTERNAL_ENABLED=true switches the tools on; anything else = they politely refuse.
//
// Like the client tools, failures return 200 with ok:false and a `message` telling the
// agent what to say, so the conversation never stalls on an error.
// Setup: docs/internal-website-agent.md.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.ts';
import { safeEqual } from '../crypto.ts';
import { db } from '../db.ts';
import { Sentry } from '../instrument.ts';
import { localDate } from '../automation/texts.ts';
import { toE164 } from '../phone.ts';
import { queueInternalChat } from './chat.ts';
import {
  type BookableCheck,
  DISCOVERY_CALL,
  bookableSlots,
  bookingKey,
  checkBookable,
  confirmationText,
  isIsoDate,
  looksLikeEmail,
  normaliseTimeOfDay,
  slotQueryRange,
  slotsFromGhl,
  spokenDay,
  spokenSlot,
  suggestSlots,
  todayForAgent,
} from './discoveryCall.ts';
import { addContactTags, createAppointment, getFreeSlots, isSlotTaken, upsertContact } from './ghl.ts';
import { queueInternalSms } from './sms.ts';

const DAY = 86_400_000;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const FALLBACK =
  "Online booking isn't working right now. Apologise, make sure you have their full name, business, phone and email, and tell them the Flowify team will email them within one business day to lock in a time.";

const slotView = (d: Date) => ({ start_iso: d.toISOString(), spoken: spokenSlot(d) });

function notBookableMessage(check: Exclude<BookableCheck, { ok: true }>): string {
  switch (check.reason) {
    case 'past_or_too_soon':
      return `That time is too soon: calls need at least ${DISCOVERY_CALL.minNoticeMinutes} minutes' notice. Call check_availability and offer the next free times.`;
    case 'too_far_ahead':
      return `That's more than ${DISCOVERY_CALL.lookaheadDays} days away. Offer a time in the next two weeks: call check_availability.`;
    case 'outside_hours':
      return `That's outside the team's hours (${DISCOVERY_CALL.hoursSpoken}). Call check_availability and offer the nearest time inside those hours.`;
  }
}

/** Free, bookable slots from `fromDate` to the end of the lookahead window. */
async function findSlots(fromDate: string, now: Date): Promise<Date[]> {
  const today = localDate(now, DISCOVERY_CALL.timeZone);
  const days = Math.max(1, DISCOVERY_CALL.lookaheadDays - daysBetween(today, fromDate) + 1);
  const res = await getFreeSlots(slotQueryRange(fromDate, days), DISCOVERY_CALL.timeZone, 6_000);
  return bookableSlots(slotsFromGhl(res), now);
}

export async function internalToolRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!safeEqual(req.headers['x-flowify-secret'] as string | undefined, config.internal.toolSecret)) {
      return reply.code(401).send({ ok: false, error: 'unauthorised' });
    }
    if (!config.internal.enabled) {
      return reply.send({ ok: false, error: 'disabled', message: FALLBACK });
    }
    const allowed = config.internal.agentIds;
    const agentId = str((req.body as Record<string, unknown> | undefined)?.agent_id);
    if (allowed.length && (!agentId || !allowed.includes(agentId))) {
      req.log.warn({ agentId }, 'Internal tool call from an agent not in INTERNAL_AGENT_IDS');
      return reply.code(403).send({ ok: false, error: 'agent_not_allowed', message: FALLBACK });
    }
  });

  // ---- check_availability -----------------------------------------------------------
  // Body: { date?: 'YYYY-MM-DD', time_of_day?: 'morning'|'afternoon'|'evening'|'any', agent_id, conversation_id }
  app.post('/tools/check_availability', async (req, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const now = new Date();
    const today = localDate(now, DISCOVERY_CALL.timeZone);
    const lastDay = addDays(today, DISCOVERY_CALL.lookaheadDays);
    const asked = isIsoDate(body.date) ? body.date : null;
    const tod = normaliseTimeOfDay(body.time_of_day);
    const base = { today: todayForAgent(now), bookable_hours: DISCOVERY_CALL.hoursSpoken };

    if (asked && asked > lastDay) {
      return reply.send({
        ok: true,
        ...base,
        requested_day_available: false,
        slots: [],
        message: `That's more than ${DISCOVERY_CALL.lookaheadDays} days away. Ask them for a day in the next two weeks, then call check_availability again.`,
      });
    }

    const from = asked && asked >= today ? asked : today;
    let slots: Date[];
    try {
      slots = await findSlots(from, now);
    } catch (err) {
      req.log.error({ err }, 'check_availability: GHL failed');
      Sentry.captureException(err);
      return reply.send({ ok: false, error: 'calendar_unavailable', ...base, message: FALLBACK });
    }

    const onAskedDay = asked ? slots.filter((d) => localDate(d, DISCOVERY_CALL.timeZone) === asked) : [];
    const pool = asked && onAskedDay.length ? onAskedDay : slots;
    const { day, picks, matchedTimeOfDay } = suggestSlots(pool, tod);

    if (!picks.length) {
      return reply.send({
        ok: true,
        ...base,
        requested_day_available: false,
        slots: [],
        message: `No free times in the next ${DISCOVERY_CALL.lookaheadDays} days. Apologise and tell them the team will email them to find a time. You still need their name, business, phone and email.`,
      });
    }

    const dayLabel = spokenDay(picks[0]!);
    let message: string;
    if (asked && !onAskedDay.length) {
      // 00:00 UTC is midday the same day in NZ (UTC+12/+13), so this names the right day.
      message = `Nothing free on ${spokenDay(new Date(Date.parse(`${asked}T00:00:00Z`)))} (team hours are ${DISCOVERY_CALL.hoursSpoken}). The nearest free day is ${dayLabel}. Offer these times.`;
    } else if (tod !== 'any' && !matchedTimeOfDay) {
      message = `No ${tod} times free on ${dayLabel}, but these are. Offer them.`;
    } else {
      message = `Offer these times on ${dayLabel}. When they pick one, confirm it back, then call book_discovery_call with its start_iso.`;
    }
    return reply.send({ ok: true, ...base, requested_day_available: Boolean(asked && onAskedDay.length), day, slots: picks.map(slotView), message });
  });

  // ---- book_discovery_call ------------------------------------------------------------
  // Body: { caller_name, business_name, caller_phone, caller_email, slot_start_iso,
  //         summary?, agent_id, conversation_id }
  app.post('/tools/book_discovery_call', async (req, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.caller_name);
    const business = str(body.business_name);
    const phoneRaw = str(body.caller_phone);
    const email = str(body.caller_email);
    const summary = str(body.summary)?.slice(0, 500) ?? null;
    const slotIso = str(body.slot_start_iso);

    const missing = [!name && 'their full name', !email && 'their email address', !slotIso && 'the time they picked'].filter(Boolean);
    if (missing.length) {
      return reply.send({ ok: false, error: 'missing_details', message: `Before booking, get ${missing.join(' and ')}.` });
    }
    if (!looksLikeEmail(email)) {
      return reply.send({ ok: false, error: 'check_email', message: "That email address doesn't look complete. Ask for it again and spell it back to confirm." });
    }
    const start = new Date(slotIso!);
    if (Number.isNaN(start.getTime())) {
      return reply.send({ ok: false, error: 'bad_slot', message: 'Use the start_iso of one of the times from check_availability, exactly as given.' });
    }
    const now = new Date();
    const check = checkBookable(start, now);
    if (!check.ok) return reply.send({ ok: false, error: 'not_bookable', message: notBookableMessage(check) });

    const end = new Date(start.getTime() + DISCOVERY_CALL.durationMinutes * 60_000);
    const phone = toE164(phoneRaw) ?? phoneRaw; // keep what they said if it doesn't parse
    const key = bookingKey(email!, start);
    const conversationId = str(body.conversation_id);
    const agentId = str(body.agent_id);

    // 1. Claim the booking (an ElevenLabs retry of the same call must not book twice).
    let bookingId: string | undefined = (
      await db().query<{ id: string }>(
        `INSERT INTO internal.bookings (booking_key, conversation_id, agent_id, caller_name, business_name, phone, email, summary, slot_start, slot_end, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
         ON CONFLICT (booking_key) DO NOTHING
         RETURNING id`,
        [key, conversationId, agentId, name, business, phone, email, summary, start, end],
      )
    ).rows[0]?.id;

    if (!bookingId) {
      const existing = (
        await db().query<{ id: string; status: string }>(`SELECT id, status FROM internal.bookings WHERE booking_key = $1`, [key])
      ).rows[0];
      if (existing?.status === 'booked') {
        return reply.send({
          ok: true,
          booked: true,
          slot: spokenSlot(start),
          message: `Already booked for ${spokenSlot(start)}. Confirm that to them; don't book again.`,
        });
      }
      // Re-try a failed attempt, or take over one stuck for over 2 minutes.
      bookingId = (
        await db().query<{ id: string }>(
          `UPDATE internal.bookings
              SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = now(),
                  caller_name = $2, business_name = $3, phone = $4, summary = $5, conversation_id = $6, agent_id = $7
            WHERE booking_key = $1 AND (status = 'failed' OR (status = 'pending' AND updated_at < now() - interval '2 minutes'))
            RETURNING id`,
          [key, name, business, phone, summary, conversationId, agentId],
        )
      ).rows[0]?.id;
      if (!bookingId) {
        return reply.send({ ok: false, error: 'in_progress', message: "That booking is already going through. Wait a few seconds, then call book_discovery_call once more." });
      }
    }

    const fail = (error: string) =>
      db().query(`UPDATE internal.bookings SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [bookingId, error.slice(0, 500)]);

    // 2. GHL: contact, tags, appointment.
    let contactId: string;
    let appointmentId: string;
    try {
      contactId = (await upsertContact({ name: name!, email: email!, phone: toE164(phoneRaw), companyName: business }, DISCOVERY_CALL.source)).id;
      await addContactTags(contactId, DISCOVERY_CALL.tags).catch((err) => {
        req.log.warn({ err }, 'book_discovery_call: adding tags failed (booking continues)');
        Sentry.captureException(err);
      });
      appointmentId = (
        await createAppointment({
          contactId,
          start,
          end,
          title: `${DISCOVERY_CALL.title} - ${name}${business ? ` (${business})` : ''}`,
          description: [
            'Booked by the Flowify website agent.',
            summary ? `Looking for: ${summary}` : null,
            conversationId ? `ElevenLabs conversation: ${conversationId}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        })
      ).id;
    } catch (err) {
      if (isSlotTaken(err)) {
        await fail('slot taken');
        let alternatives: Date[] = [];
        try {
          alternatives = suggestSlots(await findSlots(localDate(start, DISCOVERY_CALL.timeZone), now), 'any').picks;
        } catch {
          /* fall through with no alternatives */
        }
        return reply.send({
          ok: false,
          error: 'slot_taken',
          slots: alternatives.map(slotView),
          message: alternatives.length
            ? 'That time was just taken. Apologise and offer one of these instead.'
            : 'That time was just taken. Apologise and call check_availability for other days.',
        });
      }
      req.log.error({ err, bookingId }, 'book_discovery_call: GHL failed');
      Sentry.captureException(err);
      await fail((err as Error).message);
      await queueInternalChat({ kind: 'booking_failed', bookingId, detail: (err as Error).message.slice(0, 200) }).catch((e) =>
        req.log.error({ err: e }, 'could not queue booking_failed chat'),
      );
      return reply.send({ ok: false, error: 'booking_failed', message: FALLBACK });
    }

    await db().query(
      `UPDATE internal.bookings SET status = 'booked', ghl_contact_id = $2, ghl_appointment_id = $3, error = NULL, updated_at = now() WHERE id = $1`,
      [bookingId, contactId, appointmentId],
    );

    // 3. Confirmation text + team notice. Queued, so the agent isn't kept waiting on TNZ.
    let text: Awaited<ReturnType<typeof queueInternalSms>> | 'error';
    try {
      text = await queueInternalSms({
        kind: 'discovery_confirmation',
        idempotencyKey: `booking:${bookingId}:confirmation`,
        toPhone: phoneRaw,
        body: confirmationText(name!, start),
        bookingId,
      });
    } catch (err) {
      req.log.error({ err, bookingId }, 'book_discovery_call: could not queue text');
      Sentry.captureException(err);
      text = 'error';
    }
    await queueInternalChat({ kind: 'booking_made', bookingId }).catch((err) => req.log.error({ err }, 'could not queue booking_made chat'));
    if (text !== 'queued' && text !== 'duplicate') {
      await queueInternalChat({ kind: 'sms_failed', bookingId, detail: text }).catch(() => {});
    }

    const texting = text === 'queued' || text === 'duplicate';
    return reply.send({
      ok: true,
      booked: true,
      slot: spokenSlot(start),
      text_sent: texting,
      message: texting
        ? `Booked for ${spokenSlot(start)}. Tell them a calendar invite is on its way to their email and a confirmation text is on its way to their phone.`
        : `Booked for ${spokenSlot(start)}. Tell them a calendar invite is on its way to their email. Don't mention a text.`,
    });
  });
}
