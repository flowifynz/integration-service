// Jobber-driven texts (build step 4).
//
// Flow: Jobber webhook → webhook_events row → worker → handleJobberEvent() schedules a
// follow-up check (pg-boss job with startAfter) → runCheck() re-fetches the item from Jobber
// at that moment and only texts if it still makes sense (quote still unanswered, invoice
// still unpaid, visit still at that time...). Day-before reminders come from the nightly run.
//
// Every text: respects Flowify's per-client automation settings, Jobber's per-customer
// switches (receivesReminders etc.), our opt-outs and quiet hours (in sendClientSms), and is
// sent at most once per idempotency key.

import { type ClientRow, db, getClientById } from '../db.ts';
import { Sentry } from '../instrument.ts';
import { isMobile, toE164 } from '../phone.ts';
import { getBoss, Queues } from '../queue.ts';
import type { SmsKind } from '../sms/compose.ts';
import type { SendSmsJob } from '../sms/outbound.ts';
import { getInvoice, getJob, getQuote, getVisit, type VisitItem, visitsStartingBetween } from './jobberItems.ts';
import { automationSettings } from './settings.ts';
import {
  bookingConfirmationText,
  dayLabel,
  followUpTimes,
  INVOICE_UNPAID,
  invoiceFollowUpText,
  pickMobile,
  QUOTE_OPEN,
  quoteFollowUpText,
  reminderText,
  rescheduleText,
  reviewRequestText,
  visitConfirmationDecision,
  visitWhen,
  zonedMidnightIso,
} from './texts.ts';

const DAY = 24 * 3600 * 1000;
const mobileE164 = (raw: string) => {
  const e = toE164(raw);
  return e && isMobile(e) ? e : null;
};

export type CheckKind = 'visit_confirmation' | 'quote_followup' | 'invoice_followup' | 'review_request';
export interface FollowUpCheck {
  clientId: string;
  check: CheckKind;
  itemId: string;
  /** invoice follow-ups: days after due date (part of the dedupe key). */
  offsetDays?: number;
}

async function schedule(check: FollowUpCheck, at: Date, singletonKey: string) {
  await (await getBoss()).send(Queues.FOLLOW_UP_CHECK, check, { startAfter: at, singletonKey });
}

async function queueText(client: ClientRow, kind: SmsKind, toPhone: string, text: string, key: string, jobberItemId: string, itemRef?: string) {
  const job: SendSmsJob = { clientId: client.id, kind, toPhone, text, idempotencyKey: key, jobberItemId, itemRef };
  await (await getBoss()).send(Queues.SEND_SMS, job);
}

function log(clientId: string, msg: string) {
  console.log(`[automation ${clientId}] ${msg}`);
}

// ---- Webhook → schedule ----------------------------------------------------------------

/** Returns 'processed' if something was scheduled, 'ignored' otherwise. */
export async function handleJobberEvent(evt: { client_id: string; topic: string; item_id: string | null }): Promise<'processed' | 'ignored'> {
  if (!evt.item_id) return 'ignored';
  const client = await getClientById(evt.client_id);
  if (!client || !['active', 'onboarding'].includes(client.status)) return 'ignored';
  const s = automationSettings(client.automation);
  const now = new Date();

  switch (evt.topic) {
    case 'VISIT_CREATE':
    case 'VISIT_UPDATE': {
      if (!s.confirmations) return 'ignored';
      // Wait a few minutes so a burst of edits (drag, drop, adjust) produces one text.
      await schedule(
        { clientId: client.id, check: 'visit_confirmation', itemId: evt.item_id },
        new Date(now.getTime() + s.confirmationDelayMinutes * 60_000),
        `visit-confirm:${evt.item_id}`,
      );
      return 'processed';
    }
    case 'QUOTE_SENT': {
      if (!s.quoteFollowUps) return 'ignored';
      const quote = await getQuote(client.id, evt.item_id);
      if (!quote?.sentAt) return 'ignored';
      const times = followUpTimes(new Date(quote.sentAt), [s.quoteFollowUpDays * DAY], now, s.staleAfterDays);
      for (const t of times) await schedule({ clientId: client.id, check: 'quote_followup', itemId: quote.id }, t.at, `quote:${quote.id}`);
      return times.length ? 'processed' : 'ignored';
    }
    case 'INVOICE_CREATE':
    case 'INVOICE_UPDATE': {
      if (!s.invoiceFollowUps) return 'ignored';
      const inv = await getInvoice(client.id, evt.item_id);
      if (!inv?.dueDate || !['awaiting_payment', 'sent_not_due', 'past_due'].includes(inv.invoiceStatus)) return 'ignored';
      const times = followUpTimes(new Date(inv.dueDate), s.invoiceFollowUpDays.map((d) => d * DAY), now, s.staleAfterDays);
      for (const t of times) {
        const offsetDays = Math.round(t.offsetMs / DAY);
        await schedule(
          { clientId: client.id, check: 'invoice_followup', itemId: inv.id, offsetDays },
          t.at,
          `invoice:${inv.id}:${offsetDays}:${inv.dueDate}`,
        );
      }
      return times.length ? 'processed' : 'ignored';
    }
    case 'JOB_CLOSED': {
      if (!s.reviewRequests || !client.review_link) return 'ignored';
      const job = await getJob(client.id, evt.item_id);
      if (!job) return 'ignored';
      const closedAt = job.completedAt ? new Date(job.completedAt) : now;
      // Bulk-closing old jobs mustn't spray review requests.
      if (now.getTime() - closedAt.getTime() > s.staleAfterDays * DAY) return 'ignored';
      await schedule(
        { clientId: client.id, check: 'review_request', itemId: job.id },
        new Date(now.getTime() + s.reviewDelayMinutes * 60_000),
        `review:${job.id}`,
      );
      return 'processed';
    }
    default:
      return 'ignored';
  }
}

// ---- Scheduled check → maybe text --------------------------------------------------------

export async function runCheck(c: FollowUpCheck): Promise<string> {
  const client = await getClientById(c.clientId);
  if (!client || !['active', 'onboarding'].includes(client.status)) return 'skip: client inactive';
  const s = automationSettings(client.automation);
  const tz = client.timezone;
  const biz = client.business_name;
  const now = new Date();

  switch (c.check) {
    case 'visit_confirmation': {
      if (!s.confirmations) return 'skip: confirmations off';
      const v = await getVisit(client.id, c.itemId);
      if (!v) return 'skip: visit gone';
      if (!v.client.receivesReminders) return 'skip: customer has reminders off in Jobber';
      const to = pickMobile(v.client.phones, mobileE164);
      if (!to) return 'skip: no mobile';
      const { rows } = await db().query<{ item_ref: string }>(
        `SELECT DISTINCT item_ref FROM messages
          WHERE client_id = $1 AND jobber_item_id = $2 AND kind IN ('booking_confirmation', 'reschedule_confirmation') AND item_ref IS NOT NULL`,
        [client.id, v.id],
      );
      const d = visitConfirmationDecision(v, rows.map((r) => r.item_ref), now, s.confirmWithinDays);
      if (!d.send) return `skip: ${d.reason}`;
      const when = visitWhen(v.startAt!, v.endAt, v.allDay, tz);
      const street = v.property?.address?.street1 ?? null;
      const text = d.kind === 'booking_confirmation' ? bookingConfirmationText(v.client, biz, when, street) : rescheduleText(v.client, biz, when, street);
      await queueText(client, d.kind, to, text, `${client.id}:${v.id}@${v.startAt}:${d.kind}`, v.id, v.startAt!);
      return `queued ${d.kind}`;
    }
    case 'quote_followup': {
      if (!s.quoteFollowUps) return 'skip: quote follow-ups off';
      const q = await getQuote(client.id, c.itemId);
      if (!q?.client) return 'skip: quote gone';
      if (!QUOTE_OPEN.has(q.quoteStatus)) return `skip: quote is ${q.quoteStatus}`;
      if (!q.client.receivesQuoteFollowUps) return 'skip: customer has quote follow-ups off in Jobber';
      const to = pickMobile(q.client.phones, mobileE164);
      if (!to) return 'skip: no mobile';
      await queueText(client, 'quote_followup', to, quoteFollowUpText(q.client, biz, q.quoteNumber, q.clientHubUri), `${client.id}:${q.id}:quote_followup`, q.id);
      return 'queued quote_followup';
    }
    case 'invoice_followup': {
      if (!s.invoiceFollowUps) return 'skip: invoice follow-ups off';
      const inv = await getInvoice(client.id, c.itemId);
      if (!inv?.client || !inv.dueDate) return 'skip: invoice gone';
      if (!INVOICE_UNPAID.has(inv.invoiceStatus)) return `skip: invoice is ${inv.invoiceStatus}`;
      if (!inv.client.receivesInvoiceFollowUps) return 'skip: customer has invoice follow-ups off in Jobber';
      const to = pickMobile(inv.client.phones, mobileE164);
      if (!to) return 'skip: no mobile';
      const text = invoiceFollowUpText(inv.client, biz, inv.invoiceNumber, `on ${dayLabel(new Date(inv.dueDate), tz)}`, inv.clientHubUri);
      await queueText(client, 'invoice_followup', to, text, `${client.id}:${inv.id}:invoice_followup_${c.offsetDays ?? 0}d`, inv.id);
      return 'queued invoice_followup';
    }
    case 'review_request': {
      if (!s.reviewRequests || !client.review_link) return 'skip: review requests off or no review link';
      const job = await getJob(client.id, c.itemId);
      if (!job) return 'skip: job gone';
      if (!job.allowReviewRequest) return 'skip: job has review requests off in Jobber';
      if (!job.client.receivesReviewRequests) return 'skip: customer has review requests off in Jobber';
      const to = pickMobile(job.client.phones, mobileE164);
      if (!to) return 'skip: no mobile';
      const recent = await db().query(
        `SELECT 1 FROM messages WHERE client_id = $1 AND kind = 'review_request' AND to_phone = $2
            AND created_at > now() - make_interval(days => $3) LIMIT 1`,
        [client.id, to, s.reviewCooldownDays],
      );
      if (recent.rowCount) return 'skip: asked this customer recently';
      await queueText(client, 'review_request', to, reviewRequestText(job.client, biz, client.review_link), `${client.id}:${job.id}:review_request`, job.id);
      return 'queued review_request';
    }
  }
}

// ---- Nightly: day-before reminders -------------------------------------------------------

export async function runDayBeforeReminders(date: string): Promise<void> {
  const { rows: clients } = await db().query<ClientRow>(
    `SELECT c.* FROM clients c JOIN jobber_connections j ON j.client_id = c.id
      WHERE c.status IN ('active', 'onboarding') AND j.status = 'connected'`,
  );
  for (const client of clients) {
    try {
      const s = automationSettings(client.automation);
      if (!s.reminders) continue;
      const from = zonedMidnightIso(date, client.timezone);
      const to = new Date(new Date(from).getTime() + DAY).toISOString(); // DST nights are 23/25h; reminders are per day so ±1h is fine
      const visits = await visitsStartingBetween(client.id, from, to);
      let queued = 0;
      for (const v of visits) if (await remindVisit(client, v)) queued++;
      log(client.id, `reminders for ${date}: ${visits.length} visits, ${queued} queued`);
    } catch (err) {
      // One client's broken connection mustn't stop everyone else's reminders.
      console.error(`Reminders failed for client ${client.id}`, err);
      Sentry.captureException(err);
    }
  }
}

async function remindVisit(client: ClientRow, v: VisitItem): Promise<boolean> {
  if (!v.startAt || v.isComplete || !v.client.receivesReminders) return false;
  const to = pickMobile(v.client.phones, mobileE164);
  if (!to) return false;
  // Just confirmed for this time? Don't text twice in one evening.
  const recent = await db().query(
    `SELECT 1 FROM messages WHERE client_id = $1 AND jobber_item_id = $2 AND item_ref = $3
        AND kind IN ('booking_confirmation', 'reschedule_confirmation') AND created_at > now() - interval '12 hours' LIMIT 1`,
    [client.id, v.id, v.startAt],
  );
  if (recent.rowCount) return false;
  const when = visitWhen(v.startAt, v.endAt, v.allDay, client.timezone);
  await queueText(
    client,
    'visit_reminder',
    to,
    reminderText(v.client, client.business_name, when, v.property?.address?.street1 ?? null),
    `${client.id}:${v.id}@${v.startAt}:visit_reminder`,
    v.id,
    v.startAt,
  );
  return true;
}
