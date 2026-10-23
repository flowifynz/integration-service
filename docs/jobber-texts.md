# Jobber-driven texts (build step 4)

## What gets sent

| Text | Trigger | When | Skipped if |
|---|---|---|---|
| Booking confirmation | `VISIT_CREATE` / `VISIT_UPDATE` | 3 min after the change (edits in that window coalesce) | unscheduled, in the past, complete, recurring, more than 60 days ahead, already confirmed for that time |
| Booking updated | `VISIT_UPDATE` with a new time | 3 min after the change | same time as last confirmation |
| Day-before reminder | nightly run, 6pm | for every visit tomorrow | complete; confirmed for that time in the last 12h |
| Quote follow-up | `QUOTE_SENT` | 3 days after sending | quote no longer `awaiting_response` |
| Invoice follow-up | `INVOICE_CREATE` / `INVOICE_UPDATE` | 1 and 7 days after the due date | invoice no longer `awaiting_payment` / `past_due` |
| Review request | `JOB_CLOSED` | 2 hours after closing | no `review_link` on the client; job or customer has review requests off in Jobber; same customer asked in the last 180 days |

All texts also respect: Jobber's per-customer switches (`receivesReminders`,
`receivesQuoteFollowUps`, `receivesInvoiceFollowUps`, `receivesReviewRequests`), our opt-outs,
quiet hours (8pm to 8am), a mobile number existing, and send at most once each.
Items already stale when first seen (closed, due or sent more than 3 days ago) are ignored,
so connecting a client with years of history doesn't send a burst of old follow-ups.

Not yet covered: assessments (quote visits). Jobber has no assessment webhook topic;
they'll come via request updates later.

## Per-client settings

Defaults live in `src/automation/settings.ts`. Override per client in Render Shell:

```bash
node dist/scripts/sql.js "UPDATE clients SET automation = automation || '{\"quoteFollowUpDays\": 5}' WHERE slug = 'smith-plumbing'"
node dist/scripts/sql.js "UPDATE clients SET automation = automation || '{\"reviewRequests\": false}' WHERE slug = 'smith-plumbing'"
node dist/scripts/sql.js "UPDATE clients SET review_link = 'https://g.page/r/XXXX/review' WHERE slug = 'smith-plumbing'"
```

Keys: `confirmations`, `confirmationDelayMinutes`, `reminders`, `quoteFollowUps`,
`quoteFollowUpDays`, `invoiceFollowUps`, `invoiceFollowUpDays` (array), `reviewRequests`,
`reviewDelayMinutes`, `reviewCooldownDays`, `staleAfterDays`, `confirmWithinDays`.

## Jobber Developer Center setup

1. **Scopes:** add read access for **jobs**, **quotes**, **invoices** and **scheduling /
   visits** (names vary slightly in the Developer Center). Changing scopes means each
   connected account must reconnect: run `node dist/scripts/connectLink.js <slug>`.
2. **Webhooks** (same URL as APP_DISCONNECT: `<PUBLIC_BASE_URL>/jobber/webhooks`):
   `VISIT_CREATE`, `VISIT_UPDATE`, `QUOTE_SENT`, `INVOICE_CREATE`, `INVOICE_UPDATE`, `JOB_CLOSED`.

## Testing (Jobber testing account, flowify-test client)

Before you start, make sure your test customer in Jobber has **your mobile** and the
"receives reminders / follow-ups / review requests" switches on.

1. **Check the date filter.** Book a visit for tomorrow, then:
   `node dist/scripts/tomorrowVisits.js flowify-test`. It should list the visit. If it errors,
   send Claude the error (the date-filter field names are the one unverified bit).
2. **Booking confirmation.** Schedule a visit next week. About 3 minutes later you should get
   "you're booked in…". Drag it to another day: about 3 minutes later, "your booking has changed…".
3. **Reminder.** With a visit tomorrow, run `node dist/cron/reminders.js --force`. You should
   get "a reminder that … is booked for tomorrow". Run it again: no second text.
4. **Quote follow-up.** Temporarily set the delay to 0 days:
   `UPDATE clients SET automation = automation || '{"quoteFollowUpDays": 0}' WHERE slug = 'flowify-test'`,
   then send a quote in Jobber. You should get the follow-up within a minute (8am to 8pm). Approve
   another quote before testing to confirm approved quotes aren't chased. Set it back afterwards.
5. **Invoice follow-up.** Create an invoice with a due date of yesterday and send it.
6. **Review request.** Set `review_link` and `reviewDelayMinutes` to 0, then close a job.

What happened and why: **flowify-worker → Logs**, search `[check` (one line per decision,
e.g. `skip: quote is approved`), and `webhook_events` / `messages` in Render Shell:

```bash
node dist/scripts/sql.js "SELECT topic, status, error, received_at FROM webhook_events ORDER BY id DESC LIMIT 10"
node dist/scripts/sql.js "SELECT id, kind, status, item_ref, created_at FROM messages ORDER BY id DESC LIMIT 10"
```
