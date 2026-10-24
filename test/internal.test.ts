// Unit tests for Flowify's own automations (src/internal/). Run: npm test
// No database or network: GHL calls go to a fake fetch.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  DISCOVERY_CALL,
  bookableSlots,
  bookingChatText,
  bookingKey,
  checkBookable,
  confirmationText,
  firstName,
  isIsoDate,
  localParts,
  looksLikeEmail,
  normaliseTimeOfDay,
  slotQueryRange,
  slotsFromGhl,
  spokenSlot,
  suggestSlots,
  todayForAgent,
} from '../src/internal/discoveryCall.ts';
import {
  GhlError,
  appointmentBody,
  contactUpsertBody,
  createAppointment,
  getFreeSlots,
  isSlotTaken,
  setGhlFetchForTests,
  splitFullName,
} from '../src/internal/ghl.ts';
import { smsSegments } from '../src/sms/compose.ts';
import { internalRowIdFromTnz, internalTnzMessageId, messageRowIdFromTnz, tnzMessageId } from '../src/sms/tnz.ts';

// Saturday 24 Oct 2026, 9pm NZDT (UTC+13).
const NOW = new Date('2026-10-24T08:00:00Z');
// NZDT local time on a given day → Date.
const nz = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+13:00`);

describe('discovery call: bookable window', () => {
  it('reads NZ weekday and time', () => {
    assert.deepEqual(localParts(nz('2026-10-26', '09:30')), { date: '2026-10-26', weekday: 1, minutes: 570 });
  });

  it('allows Mon-Thu 9am to a 6:30pm start, Friday 9am to an 11:30am start', () => {
    assert.equal(checkBookable(nz('2026-10-26', '09:00'), NOW).ok, true);
    assert.equal(checkBookable(nz('2026-10-29', '18:30'), NOW).ok, true); // ends 7pm
    assert.equal(checkBookable(nz('2026-10-30', '11:30'), NOW).ok, true); // ends 12pm
  });

  it('refuses early, late, Friday afternoon and weekends', () => {
    assert.deepEqual(checkBookable(nz('2026-10-26', '08:30'), NOW), { ok: false, reason: 'outside_hours' });
    assert.deepEqual(checkBookable(nz('2026-10-26', '18:45'), NOW), { ok: false, reason: 'outside_hours' }); // would end 7:15pm
    assert.deepEqual(checkBookable(nz('2026-10-30', '12:00'), NOW), { ok: false, reason: 'outside_hours' });
    assert.deepEqual(checkBookable(nz('2026-10-31', '10:00'), NOW), { ok: false, reason: 'outside_hours' }); // Saturday
    assert.deepEqual(checkBookable(nz('2026-11-01', '10:00'), NOW), { ok: false, reason: 'outside_hours' }); // Sunday
  });

  it('needs an hour of notice and stays inside the lookahead', () => {
    const monday9 = nz('2026-10-26', '09:00');
    assert.deepEqual(checkBookable(monday9, new Date(monday9.getTime() - 30 * 60_000)), { ok: false, reason: 'past_or_too_soon' });
    assert.equal(checkBookable(monday9, new Date(monday9.getTime() - 61 * 60_000)).ok, true);
    assert.deepEqual(checkBookable(nz('2026-10-01', '10:00'), NOW), { ok: false, reason: 'past_or_too_soon' });
    assert.deepEqual(checkBookable(nz('2026-11-26', '10:00'), NOW), { ok: false, reason: 'too_far_ahead' });
  });

  it('builds a GHL query range in NZ midnights, across the April 2027 DST change', () => {
    const r = slotQueryRange('2027-04-03', 2);
    assert.equal(new Date(r.startMs).toISOString(), '2027-04-02T11:00:00.000Z'); // midnight NZDT
    assert.equal(new Date(r.endMs + 1).toISOString(), '2027-04-04T12:00:00.000Z'); // midnight 5 Apr NZST
  });

  it('checks real dates', () => {
    assert.equal(isIsoDate('2026-10-26'), true);
    assert.equal(isIsoDate('2026-02-30'), false);
    assert.equal(isIsoDate('26/10/2026'), false);
    assert.equal(isIsoDate(undefined), false);
  });
});

describe('discovery call: slots', () => {
  const ghlBody = {
    '2026-10-26': { slots: ['2026-10-26T08:30:00+13:00', '2026-10-26T09:00:00+13:00', '2026-10-26T09:00:00+13:00', 'junk'] },
    '2026-10-31': { slots: ['2026-10-31T10:00:00+13:00'] },
    traceId: 'abc',
  };

  it('pulls slots out of the GHL response and keeps only bookable ones', () => {
    const raw = slotsFromGhl(ghlBody);
    assert.equal(raw.length, 5);
    const ok = bookableSlots(raw, NOW);
    assert.deepEqual(ok.map((d) => d.toISOString()), ['2026-10-25T20:00:00.000Z']); // Mon 9am only
    assert.deepEqual(slotsFromGhl(null), []);
  });

  // Monday 9:00 to 18:30 every 30 minutes.
  const monday = Array.from({ length: 20 }, (_, i) => new Date(nz('2026-10-26', '09:00').getTime() + i * 30 * 60_000));
  const tuesdayEvening = [nz('2026-10-27', '17:30')];

  it('spreads suggestions across the first free day', () => {
    const { day, picks, matchedTimeOfDay } = suggestSlots(monday, 'any');
    assert.equal(day, '2026-10-26');
    assert.equal(matchedTimeOfDay, true);
    assert.deepEqual(picks.map((d) => spokenSlot(d)), ['Monday 26 October at 9am', 'Monday 26 October at 2pm', 'Monday 26 October at 6:30pm']);
  });

  it('prefers the time of day asked for', () => {
    const { picks } = suggestSlots(monday, 'morning');
    assert.ok(picks.every((d) => localParts(d).minutes < 12 * 60));
    assert.equal(picks.length, 3);
    const afternoon = suggestSlots(monday, 'afternoon').picks;
    assert.ok(afternoon.every((d) => localParts(d).minutes >= 12 * 60 && localParts(d).minutes < 17 * 60));
  });

  it('moves to a later day for the time of day, or falls back to any time', () => {
    assert.equal(suggestSlots([...monday.slice(0, 4), ...tuesdayEvening], 'evening').day, '2026-10-27');
    const fallback = suggestSlots(monday.slice(0, 4), 'evening');
    assert.equal(fallback.matchedTimeOfDay, false);
    assert.equal(fallback.picks.length, 3);
    assert.deepEqual(suggestSlots([], 'any'), { day: null, picks: [], matchedTimeOfDay: false });
  });

  it('reads time-of-day loosely', () => {
    assert.equal(normaliseTimeOfDay('Mornings'), 'morning');
    assert.equal(normaliseTimeOfDay('pm'), 'afternoon');
    assert.equal(normaliseTimeOfDay('after work'), 'afternoon');
    assert.equal(normaliseTimeOfDay('evening'), 'evening');
    assert.equal(normaliseTimeOfDay(undefined), 'any');
  });
});

describe('discovery call: wording', () => {
  it('says times naturally', () => {
    assert.equal(spokenSlot(nz('2026-10-27', '10:30')), 'Tuesday 27 October at 10:30am');
    assert.equal(spokenSlot(nz('2026-10-30', '12:00')), 'Friday 30 October at 12pm');
    assert.equal(todayForAgent(NOW), 'Saturday 24 October 2026');
  });

  it('writes a plain GSM-7 confirmation text, under 2 segments, with no web link', () => {
    const text = confirmationText('Hōne “Macca” Te Whare', nz('2026-10-27', '10:30'));
    assert.match(text, /^Hi Hone, your Flowify discovery call is booked for Tuesday 27 October at 10:30am\./);
    assert.match(text, /- Flowify New Zealand Ltd$/);
    const seg = smsSegments(text);
    assert.equal(seg.encoding, 'GSM-7');
    assert.ok(seg.segments <= 2, `${seg.segments} segments`);
    assert.doesNotMatch(text, /https?:|www\./);
    assert.equal(firstName(''), 'there');
  });

  it('lists everything the team needs in the Chat notice', () => {
    const b = {
      caller_name: 'Sam Sample',
      business_name: 'Sample Plumbing',
      phone: '021 123 4567',
      email: 'sam@example.co.nz',
      summary: 'Missing calls on site',
      slot_start: nz('2026-10-27', '10:30'),
      error: null,
    };
    const made = bookingChatText('booking_made', b);
    for (const s of ['New discovery call booked', 'Sam Sample', 'Sample Plumbing', '021 123 4567', 'sam@example.co.nz', 'Tuesday 27 October at 10:30am', 'Missing calls on site']) {
      assert.ok(made.includes(s), s);
    }
    assert.match(bookingChatText('booking_failed', { ...b, business_name: null }, 'GHL 500'), /FAILED - follow up by email[\s\S]*Business: not given[\s\S]*Error: GHL 500/);
  });

  it('checks emails and keys bookings by person and time', () => {
    assert.equal(looksLikeEmail('sam@example.co.nz'), true);
    assert.equal(looksLikeEmail('sam at example dot com'), false);
    assert.equal(looksLikeEmail('sam@example'), false);
    const t = nz('2026-10-27', '10:30');
    assert.equal(bookingKey(' Sam@Example.co.nz ', t), bookingKey('sam@example.co.nz', t));
  });

  it('keeps the confirmation text cap and window settings sane', () => {
    assert.ok(DISCOVERY_CALL.maxTextsPerPhonePerDay >= 1 && DISCOVERY_CALL.maxTextsPerDay >= DISCOVERY_CALL.maxTextsPerPhonePerDay);
    assert.ok(DISCOVERY_CALL.lookaheadDays + 1 <= 31, 'GHL free-slots allows at most 31 days');
  });
});

describe('internal TNZ MessageIDs', () => {
  it('are alphanumeric, short, and never confused with client or alert texts', () => {
    const id = internalTnzMessageId(123456789, 3);
    assert.match(id, /^[A-Za-z0-9]{1,40}$/);
    assert.equal(internalRowIdFromTnz(id), '123456789');
    assert.equal(messageRowIdFromTnz(id), null);
    assert.equal(internalRowIdFromTnz(tnzMessageId(42, 1)), null);
    assert.equal(internalRowIdFromTnz('flowifyalert7a1'), null);
    assert.equal(internalRowIdFromTnz(`flowifyintcheck${Date.now()}`), null);
  });
});

describe('GHL client', () => {
  process.env.GHL_PRIVATE_TOKEN = 'pit-test';
  process.env.GHL_LOCATION_ID = 'loc123';
  process.env.GHL_CALENDAR_ID = 'cal456';
  afterEach(() => setGhlFetchForTests(null));

  it('upserts contacts without tags (they would replace existing ones)', () => {
    const body = contactUpsertBody({ name: ' Matthew John Macdonald ', email: 'Matt@Example.COM', phone: '+64211234567', companyName: 'Macca Electrical' }, 'loc123', 'src');
    assert.deepEqual(body, {
      locationId: 'loc123',
      name: 'Matthew John Macdonald',
      firstName: 'Matthew',
      lastName: 'John Macdonald',
      email: 'matt@example.com',
      phone: '+64211234567',
      companyName: 'Macca Electrical',
      source: 'src',
    });
    assert.equal('tags' in contactUpsertBody({ name: 'Cher', email: 'c@x.nz', phone: null, companyName: null }, 'l', 's'), false);
    assert.deepEqual(splitFullName('Cher'), { firstName: 'Cher', lastName: '' });
  });

  it('builds appointments in UTC ISO with GHL notifications on', () => {
    const start = nz('2026-10-27', '10:30');
    const body = appointmentBody({ contactId: 'c1', start, end: new Date(start.getTime() + 1_800_000), title: 'T', description: 'D' }, { calendarId: 'cal', locationId: 'loc' });
    assert.equal(body.startTime, '2026-10-26T21:30:00.000Z');
    assert.equal(body.endTime, '2026-10-26T22:00:00.000Z');
    assert.equal(body.toNotify, true);
    assert.equal(body.appointmentStatus, 'confirmed');
    assert.equal('ignoreFreeSlotValidation' in body, false);
  });

  it('sends the token, Version header and query, and parses errors', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    setGhlFetchForTests(async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ '2026-10-27': { slots: ['2026-10-27T10:30:00+13:00'] } }), { status: 200 });
    });
    const res = await getFreeSlots({ startMs: 1, endMs: 2 }, 'Pacific/Auckland');
    assert.deepEqual(slotsFromGhl(res), ['2026-10-27T10:30:00+13:00']);
    assert.equal(seen?.url, 'https://services.leadconnectorhq.com/calendars/cal456/free-slots?startDate=1&endDate=2&timezone=Pacific%2FAuckland');
    const headers = seen?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer pit-test');
    assert.equal(headers.Version, 'v3');

    setGhlFetchForTests(async () => new Response(JSON.stringify({ statusCode: 401, message: 'Invalid JWT' }), { status: 401 }));
    await assert.rejects(getFreeSlots({ startMs: 1, endMs: 2 }, 'Pacific/Auckland'), (err: unknown) => err instanceof GhlError && !err.retryable && err.ghlMessage === 'Invalid JWT');
  });

  it('creates an appointment and spots "slot taken" errors', async () => {
    setGhlFetchForTests(async (_url, init) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(b.calendarId, 'cal456');
      assert.equal(b.locationId, 'loc123');
      return new Response(JSON.stringify({ id: 'appt789', calendarId: 'cal456' }), { status: 201 });
    });
    const start = nz('2026-10-27', '10:30');
    assert.deepEqual(await createAppointment({ contactId: 'c1', start, end: start, title: 't', description: 'd' }), { id: 'appt789' });

    assert.equal(isSlotTaken(new GhlError(400, JSON.stringify({ message: 'The slot you have selected is no longer available' }), 'x')), true);
    assert.equal(isSlotTaken(new GhlError(422, JSON.stringify({ message: ['contactId must be a string'] }), 'x')), false);
    assert.equal(isSlotTaken(new GhlError(401, JSON.stringify({ message: 'slot' }), 'x')), false);
    assert.equal(isSlotTaken(new Error('slot')), false);
    assert.equal(new GhlError(503, '', 'x').retryable, true);
  });
});
