// GoHighLevel client for Flowify's OWN sub-account (sales CRM + discovery-call calendar).
// Not used for clients: Flowify's trade clients run on Jobber.
//
// Checked against GHL's API v2 docs (marketplace.gohighlevel.com/docs, Oct 2026):
//  - Auth: `Authorization: Bearer <Private Integration Token>`, plus a `Version` header
//    (the docs list 'v3' as the only value; set GHL_API_VERSION to override).
//  - GET  /calendars/{calendarId}/free-slots?startDate=<ms>&endDate=<ms>&timezone=<IANA>
//    → { 'YYYY-MM-DD': { slots: [ISO, ...] }, traceId }. Range at most 31 days.
//  - POST /contacts/upsert { locationId, name, firstName, lastName, email, phone, companyName, source }
//    → { new: boolean, contact: { id, ... } }. NOTE: `tags` here REPLACES all existing tags,
//    so tags are added separately with:
//  - POST /contacts/{contactId}/tags { tags: [...] } (adds, keeps existing ones).
//  - POST /calendars/events/appointments { calendarId, locationId, contactId, startTime,
//    endTime, title, description, appointmentStatus, toNotify } → { id, ... }.
//    GHL checks the slot is free unless ignoreFreeSlotValidation is set (we never set it).
//  - Errors: 4xx/5xx with { statusCode, message }.
//
// The token lives in Render (GHL_PRIVATE_TOKEN), never in code, chat or Notion.

import { config } from '../config.ts';

export class GhlError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, what: string) {
    super(`GHL ${what} failed (${status}): ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
  /** GHL's own message, for deciding what to tell the caller. */
  get ghlMessage(): string {
    try {
      const m = (JSON.parse(this.body) as { message?: unknown }).message;
      return Array.isArray(m) ? m.join('; ') : typeof m === 'string' ? m : '';
    } catch {
      return '';
    }
  }
}

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = (...args) => fetch(...args);

/** Tests only: swap the network for a fake. */
export function setGhlFetchForTests(fn: FetchFn | null): void {
  fetchImpl = fn ?? ((...args) => fetch(...args));
}

async function ghl<T>(what: string, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 8_000): Promise<T> {
  // Config first, outside the network try/catch: a missing secret is a config error.
  const url = `${config.ghl.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.ghl.token}`,
    Version: config.ghl.apiVersion,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GhlError(0, `Network error: ${(err as Error).message}`, what);
  }
  const text = await res.text();
  if (!res.ok) throw new GhlError(res.status, text, what);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new GhlError(res.status, `Non-JSON response: ${text}`, what);
  }
}

/** Free slot start times (ISO strings) for the discovery-call calendar. */
export async function getFreeSlots(range: { startMs: number; endMs: number }, timeZone: string, timeoutMs?: number): Promise<unknown> {
  const q = new URLSearchParams({
    startDate: String(range.startMs),
    endDate: String(range.endMs),
    timezone: timeZone,
  });
  return ghl('free-slots', 'GET', `/calendars/${encodeURIComponent(config.ghl.calendarId)}/free-slots?${q}`, undefined, timeoutMs);
}

export interface ContactInput {
  name: string;
  email: string;
  phone: string | null;
  companyName: string | null;
}

/** Splits 'Matthew John Macdonald' into first 'Matthew' and last 'John Macdonald'. */
export function splitFullName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

export function contactUpsertBody(input: ContactInput, locationId: string, source: string): Record<string, unknown> {
  const { firstName, lastName } = splitFullName(input.name);
  return {
    locationId,
    name: input.name.trim(),
    firstName,
    ...(lastName ? { lastName } : {}),
    email: input.email.trim().toLowerCase(),
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.companyName ? { companyName: input.companyName } : {}),
    source,
    // No `tags` here on purpose: on upsert they replace all of the contact's existing tags.
  };
}

export async function upsertContact(input: ContactInput, source: string): Promise<{ id: string; isNew: boolean }> {
  const res = await ghl<{ new?: boolean; contact?: { id?: string } }>(
    'contact upsert',
    'POST',
    '/contacts/upsert',
    contactUpsertBody(input, config.ghl.locationId, source),
  );
  const id = res.contact?.id;
  if (!id) throw new GhlError(200, JSON.stringify(res), 'contact upsert (no contact id)');
  return { id, isNew: Boolean(res.new) };
}

export async function addContactTags(contactId: string, tags: readonly string[]): Promise<void> {
  await ghl('add tags', 'POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
}

export interface AppointmentInput {
  contactId: string;
  start: Date;
  end: Date;
  title: string;
  description: string;
}

export function appointmentBody(input: AppointmentInput, ids: { calendarId: string; locationId: string }): Record<string, unknown> {
  return {
    calendarId: ids.calendarId,
    locationId: ids.locationId,
    contactId: input.contactId,
    startTime: input.start.toISOString(),
    endTime: input.end.toISOString(),
    title: input.title,
    description: input.description,
    appointmentStatus: 'confirmed',
    toNotify: true, // GHL sends its calendar confirmation/invite per the calendar's settings
  };
}

export async function createAppointment(input: AppointmentInput): Promise<{ id: string }> {
  const res = await ghl<{ id?: string }>(
    'create appointment',
    'POST',
    '/calendars/events/appointments',
    appointmentBody(input, { calendarId: config.ghl.calendarId, locationId: config.ghl.locationId }),
    10_000,
  );
  if (!res.id) throw new GhlError(200, JSON.stringify(res), 'create appointment (no id)');
  return { id: res.id };
}

/** A 4xx from create-appointment that means "that time isn't free any more". */
export function isSlotTaken(err: unknown): boolean {
  if (!(err instanceof GhlError) || err.status < 400 || err.status >= 500 || err.status === 401 || err.status === 403) return false;
  return /slot|available|availability|booked|conflict/i.test(err.ghlMessage || err.body);
}
