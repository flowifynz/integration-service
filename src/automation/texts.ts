// Wording and decisions for Jobber-driven texts. Pure — unit tested.
//
// Plain ASCII only: an en dash, curly quote or macron switches a text to UCS-2 and can
// double or triple its segment cost (see smsSegments in sms/compose.ts). composeSms adds
// "To change your booking, call us on …" / "Questions? Call us on …", the business-name
// signature and, for review requests, the STOP line.

const DAY = 24 * 3600 * 1000;

export interface JobberPerson {
  firstName: string | null;
  companyName?: string | null;
}

export function hiName(p: JobberPerson | null | undefined): string {
  const first = p?.firstName?.trim();
  return first ? `Hi ${first}` : 'Hi there';
}

/** '8am', '8:30am', '12pm' in the given time zone. */
function clock(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-NZ', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const ampm = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase().replace(/\./g, '').replace(/\s/g, '');
  return `${hour}${minute === '00' ? '' : `:${minute}`}${ampm}`;
}

/** 'Thu 30 Oct' in the given time zone. */
export function dayLabel(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-NZ', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

/** 'Thu 30 Oct, 8am-10am' / 'Thu 30 Oct' (all day). Hyphen, not en dash: keeps GSM-7. */
export function visitWhen(startAt: string, endAt: string | null, allDay: boolean, timeZone: string): string {
  const start = new Date(startAt);
  const day = dayLabel(start, timeZone);
  if (allDay) return day;
  const end = endAt ? new Date(endAt) : null;
  return end && end > start ? `${day}, ${clock(start, timeZone)}-${clock(end, timeZone)}` : `${day}, ${clock(start, timeZone)}`;
}

/** The UTC instant of local midnight on `date` (YYYY-MM-DD) in `timeZone`, as ISO. */
export function zonedMidnightIso(date: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    guess = target - (asLocal - guess);
  }
  return new Date(guess).toISOString();
}

/** YYYY-MM-DD for a date in the given time zone. */
export function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
}

// ---- Message text ------------------------------------------------------------------

export function bookingConfirmationText(p: JobberPerson, business: string, when: string, street: string | null): string {
  return `${hiName(p)}, you're booked in with ${business} for ${when}${street ? ` at ${street}` : ''}.`;
}

export function rescheduleText(p: JobberPerson, business: string, when: string, street: string | null): string {
  return `${hiName(p)}, your booking with ${business} has changed. It's now ${when}${street ? ` at ${street}` : ''}.`;
}

export function reminderText(p: JobberPerson, business: string, when: string, street: string | null): string {
  return `${hiName(p)}, a reminder that ${business} is booked for tomorrow, ${when}${street ? ` at ${street}` : ''}.`;
}

export function quoteFollowUpText(p: JobberPerson, business: string, quoteNumber: string, link: string | null): string {
  return `${hiName(p)}, just checking you got quote #${quoteNumber} from ${business}.${link ? ` You can view and approve it here: ${link}` : ''}`;
}

export function invoiceFollowUpText(p: JobberPerson, business: string, invoiceNumber: string, dueLabel: string, link: string | null): string {
  return `${hiName(p)}, a friendly reminder that invoice #${invoiceNumber} from ${business} was due ${dueLabel}.${link ? ` You can view it here: ${link}` : ''} If you've already paid, thank you and please ignore this.`;
}

export function reviewRequestText(p: JobberPerson, business: string, reviewLink: string): string {
  return `${hiName(p)}, thanks for choosing ${business}. If you were happy with the work, a quick Google review would mean a lot: ${reviewLink}`;
}

// ---- Decisions -----------------------------------------------------------------------

export type Skip = { send: false; reason: string };
export type Go<T = object> = { send: true } & T;

/** Should a visit change produce a confirmation, and which kind? */
export function visitConfirmationDecision(
  v: { startAt: string | null; isComplete: boolean; isRecurring: boolean },
  previousRefs: string[],
  now: Date,
  confirmWithinDays: number,
): Skip | Go<{ kind: 'booking_confirmation' | 'reschedule_confirmation' }> {
  if (!v.startAt) return { send: false, reason: 'unscheduled' };
  if (v.isComplete) return { send: false, reason: 'complete' };
  const start = new Date(v.startAt).getTime();
  if (start <= now.getTime()) return { send: false, reason: 'in the past' };
  if (previousRefs.includes(v.startAt)) return { send: false, reason: 'already confirmed for this time' };
  if (previousRefs.length > 0) return { send: true, kind: 'reschedule_confirmation' };
  // First confirmation: skip recurring visits (dozens are created at once) and far-off ones.
  if (v.isRecurring) return { send: false, reason: 'recurring visit (reminders only)' };
  if (start - now.getTime() > confirmWithinDays * DAY) return { send: false, reason: 'too far ahead' };
  return { send: true, kind: 'booking_confirmation' };
}

/**
 * When to run follow-up checks, given the anchor time (quote sent / invoice due / job closed).
 * Offsets already more than `staleAfterDays` in the past are dropped, so connecting a client
 * with years of history (or bulk-closing old jobs) doesn't fire a burst of texts.
 */
export function followUpTimes(anchor: Date, offsetsMs: number[], now: Date, staleAfterDays: number): Array<{ offsetMs: number; at: Date }> {
  return offsetsMs
    .map((offsetMs) => ({ offsetMs, at: new Date(anchor.getTime() + offsetMs) }))
    .filter(({ at }) => at.getTime() >= now.getTime() - staleAfterDays * DAY);
}

export const QUOTE_OPEN = new Set(['awaiting_response']);
export const INVOICE_UNPAID = new Set(['awaiting_payment', 'past_due']);

/** Pick the customer's mobile: primary first, then any. `isMobileE164` returns E.164 or null. */
export function pickMobile(
  phones: Array<{ number: string; primary?: boolean | null }> | null | undefined,
  isMobileE164: (raw: string) => string | null,
): string | null {
  const sorted = [...(phones ?? [])].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  for (const p of sorted) {
    const m = isMobileE164(p.number);
    if (m) return m;
  }
  return null;
}
