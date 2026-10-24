// Discovery-call booking rules and wording for the website agent. Pure — unit tested.
//
// The bookable window is enforced HERE, not just in the agent's prompt: GHL's calendar
// may show a slot as free, but only slots inside these hours (and with enough notice)
// are ever offered or booked. Change the hours in DISCOVERY_CALL below.

import { localDate, zonedMidnightIso } from '../automation/texts.ts';
import { toGsmSafe } from '../alerts/text.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const DISCOVERY_CALL = {
  title: 'Flowify Discovery Call',
  /** Matches the GHL calendar's slot length. */
  durationMinutes: 30,
  /** No call starting sooner than this from now. */
  minNoticeMinutes: 60,
  /** How far ahead the agent may look for a free slot. GHL allows at most 31 days per query. */
  lookaheadDays: 14,
  timeZone: 'Pacific/Auckland',
  /**
   * Bookable hours per weekday (0 = Sunday), local time. A call must START and FINISH
   * inside the window: with 30-minute calls, the last Mon-Thu start is 6:30pm, Friday 11:30am.
   */
  hours: {
    1: ['09:00', '19:00'],
    2: ['09:00', '19:00'],
    3: ['09:00', '19:00'],
    4: ['09:00', '19:00'],
    5: ['09:00', '12:00'],
  } as Record<number, [string, string] | undefined>,
  /** Plain-English version for the agent to read out. */
  hoursSpoken: 'Monday to Thursday 9am to 7pm, and Friday mornings 9am to 12pm',
  maxSuggestions: 3,
  /** Added to the GHL contact (added, never replacing their existing tags). */
  tags: ['Discovery Call Booking', 'ElevenLabs Website Agent'],
  source: 'ElevenLabs Website Agent',
  /** Anti-abuse: the widget is public, so cap confirmation texts. */
  maxTextsPerPhonePerDay: 3,
  maxTextsPerDay: 30,
} as const;

// ---- Local time helpers ------------------------------------------------------------

export interface LocalParts {
  date: string; // YYYY-MM-DD
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since local midnight
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(d: Date, timeZone: string = DISCOVERY_CALL.timeZone): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: localDate(d, timeZone),
    weekday: WEEKDAYS[get('weekday')] ?? -1,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** True if `s` is a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** GHL free-slots query range: local midnight of `fromDate` for `days` days, in epoch ms. */
export function slotQueryRange(fromDate: string, days: number, timeZone: string = DISCOVERY_CALL.timeZone): { startMs: number; endMs: number } {
  const startMs = Date.parse(zonedMidnightIso(fromDate, timeZone));
  // Midnight of the day after the last day, found via the local calendar (DST-safe).
  const last = new Date(Date.parse(`${fromDate}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
  const endMs = Date.parse(zonedMidnightIso(last, timeZone)) - 1;
  return { startMs, endMs };
}

// ---- Bookable window ---------------------------------------------------------------

export type BookableCheck = { ok: true } | { ok: false; reason: 'past_or_too_soon' | 'outside_hours' | 'too_far_ahead' };

export function checkBookable(start: Date, now: Date = new Date()): BookableCheck {
  if (start.getTime() < now.getTime() + DISCOVERY_CALL.minNoticeMinutes * MINUTE) return { ok: false, reason: 'past_or_too_soon' };
  if (start.getTime() > now.getTime() + (DISCOVERY_CALL.lookaheadDays + 1) * DAY) return { ok: false, reason: 'too_far_ahead' };
  const { weekday, minutes } = localParts(start);
  const window = DISCOVERY_CALL.hours[weekday];
  if (!window) return { ok: false, reason: 'outside_hours' };
  const [open, close] = window.map(toMinutes) as [number, number];
  if (minutes < open || minutes + DISCOVERY_CALL.durationMinutes > close) return { ok: false, reason: 'outside_hours' };
  return { ok: true };
}

/** GHL slot strings → bookable instants, sorted, de-duplicated. Junk is dropped. */
export function bookableSlots(isoSlots: readonly string[], now: Date = new Date()): Date[] {
  const seen = new Set<number>();
  const out: Date[] = [];
  for (const s of isoSlots) {
    const t = Date.parse(s);
    if (Number.isNaN(t) || seen.has(t)) continue;
    const d = new Date(t);
    if (!checkBookable(d, now).ok) continue;
    seen.add(t);
    out.push(d);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** Pulls every slot string out of GHL's free-slots response ({ 'YYYY-MM-DD': { slots: [...] }, traceId }). */
export function slotsFromGhl(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const out: string[] = [];
  for (const value of Object.values(body as Record<string, unknown>)) {
    const slots = (value as { slots?: unknown } | null)?.slots;
    if (Array.isArray(slots)) for (const s of slots) if (typeof s === 'string') out.push(s);
  }
  return out;
}

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'any';

export function normaliseTimeOfDay(v: unknown): TimeOfDay {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s.includes('morn') || s === 'am') return 'morning';
  if (s.includes('after') || s === 'pm') return 'afternoon';
  if (s.includes('even') || s.includes('night') || s.includes('late')) return 'evening';
  return 'any';
}

function matchesTimeOfDay(d: Date, tod: TimeOfDay): boolean {
  if (tod === 'any') return true;
  const { minutes } = localParts(d);
  if (tod === 'morning') return minutes < 12 * 60;
  if (tod === 'afternoon') return minutes >= 12 * 60 && minutes < 17 * 60;
  return minutes >= 17 * 60;
}

/**
 * Up to `max` slots on the first day that has any, spread across that day (first, middle,
 * last) so the caller gets a real choice rather than 9:00, 9:30 and 10:00.
 * Prefers the time of day asked for; falls back to any time that day if none match.
 */
export function suggestSlots(slots: readonly Date[], tod: TimeOfDay, max: number = DISCOVERY_CALL.maxSuggestions): { day: string | null; picks: Date[]; matchedTimeOfDay: boolean } {
  if (!slots.length) return { day: null, picks: [], matchedTimeOfDay: false };
  const preferred = slots.filter((d) => matchesTimeOfDay(d, tod));
  const pool = preferred.length ? preferred : slots;
  const day = localParts(pool[0]!).date;
  const sameDay = pool.filter((d) => localParts(d).date === day);
  if (sameDay.length <= max) return { day, picks: sameDay, matchedTimeOfDay: preferred.length > 0 };
  const picks: Date[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (sameDay.length - 1)) / (max - 1));
    const d = sameDay[idx]!;
    if (!picks.includes(d)) picks.push(d);
  }
  return { day, picks, matchedTimeOfDay: preferred.length > 0 };
}

// ---- Wording ------------------------------------------------------------------------

/** '10am', '10:30am', '12pm'. */
export function spokenClock(d: Date, timeZone: string = DISCOVERY_CALL.timeZone): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const minute = get('minute');
  return `${get('hour')}${minute === '00' ? '' : `:${minute}`}${get('dayPeriod').toLowerCase()}`;
}

/** 'Tuesday 28 October'. */
export function spokenDay(d: Date, timeZone: string = DISCOVERY_CALL.timeZone): string {
  const parts = new Intl.DateTimeFormat('en-NZ', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

/** 'Tuesday 28 October at 10:30am'. */
export function spokenSlot(d: Date, timeZone: string = DISCOVERY_CALL.timeZone): string {
  return `${spokenDay(d, timeZone)} at ${spokenClock(d, timeZone)}`;
}

/** 'Saturday 24 October 2026' — given to the agent so it can work out "tomorrow", "next Tuesday". */
export function todayForAgent(now: Date = new Date(), timeZone: string = DISCOVERY_CALL.timeZone): string {
  const year = new Intl.DateTimeFormat('en-NZ', { timeZone, year: 'numeric' }).format(now);
  return `${spokenDay(now, timeZone)} ${year}`;
}

/** First name for a greeting, GSM-safe. 'Matthew Macdonald' → 'Matthew'. */
export function firstName(fullName: string): string {
  const first = toGsmSafe(fullName).trim().split(/\s+/)[0] ?? '';
  return first || 'there';
}

/**
 * The confirmation text. Plain GSM-7 (no dashes, curly quotes or macrons), no links:
 * TNZ holds texts with web links for a manual check. Kept under 2 segments.
 */
export function confirmationText(name: string, start: Date): string {
  return toGsmSafe(
    [
      `Hi ${firstName(name)}, your Flowify discovery call is booked for ${spokenSlot(start)}.`,
      'A calendar invite is on its way to your email. To change the time, reply to the invite or email hello@flowify.nz',
      '- Flowify New Zealand Ltd',
    ].join('\n'),
  );
}

export type InternalChatKind = 'booking_made' | 'booking_failed' | 'sms_failed';

export interface BookingForChat {
  caller_name: string;
  business_name: string | null;
  /** Already formatted for reading, e.g. '021 123 4567', or as given. */
  phone: string | null;
  email: string;
  summary: string | null;
  slot_start: Date;
  error: string | null;
}

/** Google Chat notice for the team. Chat formatting: *bold*, plain line breaks. */
export function bookingChatText(kind: InternalChatKind, b: BookingForChat, detail?: string): string {
  const who = [
    `Name: ${b.caller_name}`,
    `Business: ${b.business_name ?? 'not given'}`,
    `Phone: ${b.phone ?? 'not given'}`,
    `Email: ${b.email}`,
    `Time: ${spokenSlot(new Date(b.slot_start))}`,
    ...(b.summary ? [`Looking for: ${b.summary}`] : []),
  ].join('\n');
  switch (kind) {
    case 'booking_made':
      return `📅 *New discovery call booked* (website agent)\n${who}`;
    case 'booking_failed':
      return `🔴 *Website booking FAILED - follow up by email*\nThe agent told them the team will be in touch.\n${who}\nError: ${detail ?? b.error ?? 'unknown'}`;
    case 'sms_failed':
      return `🟠 *Confirmation text not sent* (the booking itself is fine)\n${who}\nReason: ${detail ?? 'unknown'}`;
  }
}

// ---- Input checks -------------------------------------------------------------------

export function looksLikeEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

/** Lower-cased email + slot instant. Same person, same time = same booking. */
export function bookingKey(email: string, start: Date): string {
  return `${email.trim().toLowerCase()}|${start.toISOString()}`;
}
