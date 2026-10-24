# Website agent: book a discovery call (internal module)

Flowify's own website agent ("Flowify - Website Agent" in ElevenLabs) behind the **Book a
discovery call** button. It replaces the agent's Google Calendar tools and the Make
scenarios "WebAgent - SMS Confirmation / Check Availability / Book Appointment / Alerts".

```
Website widget (ElevenLabs agent)
   |  POST /internal/tools/check_availability     -> GHL free slots, filtered to Flowify's hours
   |  POST /internal/tools/book_discovery_call    -> GHL contact (+ tags) + appointment
   v                                                 -> queue: TNZ confirmation text
Flowify service (flowify-web)                        -> queue: Google Chat "new booking"
   worker: internal-send-sms, internal-chat
```

This is **Flowify's own business**, not a client. It lives in `src/internal/`, stores
everything in the `internal` database schema, uses its own secret, queues, TNZ SubAccount
and kill switch, and never reads or writes client rows.

## What it does

- **Bookable hours are enforced by the service**, not just the prompt: Monday to Thursday
  9am to 7pm, Friday 9am to 12pm, 30-minute calls that must finish inside those hours,
  at least 1 hour's notice, up to 14 days ahead. GHL's calendar must also show the slot as
  free. Change the hours in `DISCOVERY_CALL` in `src/internal/discoveryCall.ts`.
- **check_availability** returns 2 or 3 times spread across the first free day (or the
  day asked for), worded for speaking ("Tuesday 27 October at 10:30am"), plus today's date
  so the agent can work out "next Tuesday".
- **book_discovery_call** checks the details and the time, then in GHL: upserts the contact
  (name, email, phone, business, source), **adds** the tags `Discovery Call Booking` and
  `ElevenLabs Website Agent` (adding never removes their existing tags), and creates a
  confirmed 30-minute appointment titled "Flowify Discovery Call - Name (Business)".
  GHL's own calendar notifications send the invite.
- **The same booking can't be made twice**: an ElevenLabs retry of the same person + time
  returns "already booked" instead of a second appointment.
- **If the time was just taken**, the agent gets fresh alternatives. **If GHL fails**, the
  agent tells them the team will email within one business day, and the details are
  posted to Google Chat as "Website booking FAILED - follow up by email", so no lead is lost.
- **Confirmation text** (TNZ, GSM-7, 2 segments, no web links), sent straight away. It is
  confirming something the person just did, so it ignores quiet hours. It's only sent to
  valid mobiles, never to a number that has replied STOP, and is capped at 3 per number and
  30 in total per 24 hours, because the widget is public.
- **Google Chat notice** of every booking (name, business, phone, email, time, what they're
  after), threaded per booking. A failed text shows under its booking.
- **STOP** to one of these texts opts the number out of Flowify's own texts only
  (`internal.opt_outs`), not out of clients' texts.

## 1. Secrets and settings (Render)

Everything secret lives in Render (`flowify-shared` env group) and 1Password, never in
the agent, Make, Notion or chat. Add to `flowify-shared`:

| Variable | Value | Secret? |
|---|---|---|
| `INTERNAL_TOOL_SECRET` | `openssl rand -hex 24` (a NEW value, not `ELEVENLABS_TOOL_SECRET`) | yes |
| `GHL_PRIVATE_TOKEN` | the new GHL Private Integration token (step 2) | yes |
| `INTERNAL_CHAT_WEBHOOK_URL` | the new Google Chat webhook URL (step 3) | yes |
| `GHL_LOCATION_ID` | Flowify's GHL sub-account (location) ID | no |
| `GHL_CALENDAR_ID` | the discovery-call calendar ID | no |
| `INTERNAL_AGENT_IDS` | `agent_3901m2hk5rxvf9hv0atz1jmtbvsm` (Flowify - Website Agent) | no |
| `INTERNAL_SMS_MODE` | `test` while testing, then `live` | no |
| `INTERNAL_ENABLED` | `true` (the kill switch: anything else and the tools refuse politely) | no |
| `INTERNAL_TNZ_SUBACCOUNT` | optional, default `Flowify Internal` (same as the old Make texts) | no |
| `GHL_API_VERSION` | optional, default `v3` (what GHL's docs list) | no |

Current values (24 Oct 2026): location `cSD3rittRRDCXU27Jpzn`, discovery-call calendar
`IDjKjurwWTDah0acKkr0` (the old Make scenarios used an earlier calendar, `oC1SnO8LGLHlY6NfZRjs`).
If the calendar changes again, its ID is in the calendar's link in GHL.

## 2. GHL: new token, calendar check

The old Private Integration token is written in plain text in two Make scenarios, so
replace it:

1. GHL (Flowify sub-account) → **Settings → Private Integrations → Create new integration**,
   name "Flowify service". Scopes: **View Calendars** (`calendars.readonly`), **Edit Calendar
   Events** (`calendars/events.write`), **Edit Contacts** (`contacts.write`).
2. Copy the token into 1Password, then into Render as `GHL_PRIVATE_TOKEN`.
3. **Delete the old integration** (the one used in Make). The GHL Make scenarios have never
   run, so nothing else breaks.
4. On the discovery-call calendar, check:
   - slot length 30 minutes; availability at least covers Mon-Thu 9-7, Fri 9-12;
   - a **meeting location** (Google Meet or Zoom), or the invite has no video link
     (the old Google Calendar tool added a Meet link itself);
   - **notifications to the contact on booking are on** (that's what sends the invite email).

## 3. Google Chat: new webhook

The bookings space's webhook URL (key and token) sits in plain text in the agent's
`notify_team_google_chat` tool, and other Chat URLs in Make. In the space that should get
booking notices: **Apps & integrations → Webhooks → Add webhook** "Flowify service", copy
the URL to 1Password and Render (`INTERNAL_CHAT_WEBHOOK_URL`). After go-live, **delete the
old webhooks** so the leaked URLs stop working.

## 4. Deploy and check (Render Shell, flowify-web)

Upload the changed files, let Render deploy (migration `009_internal.sql` runs first), then:

```bash
node dist/scripts/internalCheck.js --chat --sms 021XXXXXXX
```

It prints which settings are set (never their values), the next free times from GHL inside
Flowify's hours, a sample confirmation text, posts a test message to the Chat space and
sends the sample text (Test mode unless `INTERNAL_SMS_MODE=live`). It never books anything.

## 5. ElevenLabs (only after step 4 works)

1. **Workspace → Secrets → Add**: name `flowify_internal_tool_secret`, value = `INTERNAL_TOOL_SECRET`.
2. On **Flowify - Website Agent → Tools**, add two **Webhook** tools, method **POST**,
   header `x-flowify-secret` = the secret above:

   **check_availability**: URL `https://flowify-web.onrender.com/internal/tools/check_availability`,
   timeout 20s. Description: *Find free discovery-call times. Call once you know roughly when
   suits them.* Body (JSON object):

   | Property | Type | Value |
   |---|---|---|
   | `date` | string, optional | LLM: "The day they want as YYYY-MM-DD, worked out from today's date. Leave empty for the next free times." |
   | `time_of_day` | string, optional | LLM: "morning, afternoon, evening or any" |
   | `agent_id` | string | dynamic variable `system__agent_id` |
   | `conversation_id` | string | dynamic variable `system__conversation_id` |

   **book_discovery_call**: URL `https://flowify-web.onrender.com/internal/tools/book_discovery_call`,
   timeout 30s. Description: *Book the discovery call once they've confirmed a time. Sends the
   invite, the text confirmation and the team notice.* Body:

   | Property | Type | Value |
   |---|---|---|
   | `caller_name` | string, required | LLM: "Their full name" |
   | `business_name` | string | LLM: "Their business name" |
   | `caller_phone` | string | LLM: "Their best contact number, digits only" |
   | `caller_email` | string, required | LLM: "Their email, exactly as confirmed" |
   | `slot_start_iso` | string, required | LLM: "start_iso of the time they chose, exactly as check_availability gave it" |
   | `summary` | string | LLM: "One short line on what they're looking for, if mentioned" |
   | `agent_id` | string | dynamic variable `system__agent_id` |
   | `conversation_id` | string | dynamic variable `system__conversation_id` |

3. **Remove** the old tools from the agent: `google_calendar_check_availability`,
   `google_calendar_create_event`, `send_confirmation_sms`, `notify_team_google_chat`.
   Keep `end_call`.
4. Paste `docs/website-agent-prompt.txt` into the System prompt.
5. Test in the agent's browser test with `INTERNAL_SMS_MODE=test`: book a real slot with
   your own email, check the GHL appointment, the invite email, the Chat notice and
   `internal.messages`, then cancel the appointment in GHL. Also try: a Saturday, Friday
   3pm, "in half an hour", and a mistyped email.
6. Go live: `INTERNAL_SMS_MODE=live` in Render (saves and redeploys).

## 6. After go-live

- Make: switch off and delete the four **WebAgent** scenarios and their webhooks. The SMS
  Confirmation webhook has no authentication, so anyone with its URL can send texts on
  Flowify's TNZ account until it's gone.
- Delete the old GHL Private Integration and the old Google Chat webhooks (steps 2 and 3).

## Turning it off, or rolling back

- **Off**: set `INTERNAL_ENABLED=false`. Both tools then answer "online booking isn't
  working right now", and the agent takes their details and says the team will email.
  Note that in this state nothing posts to Chat, so check the ElevenLabs conversation log.
- **Roll back**: re-attach the old Google Calendar tools and the old prompt in ElevenLabs
  (the agent's version history has them).

## Looking at bookings and texts (Render Shell)

```bash
node dist/scripts/sql.js "SELECT id, status, caller_name, slot_start, ghl_appointment_id, error FROM internal.bookings ORDER BY id DESC LIMIT 10"
node dist/scripts/sql.js "SELECT id, status, kind, delivery_status, error, sent_at FROM internal.messages ORDER BY id DESC LIMIT 10"
```

## Unconfirmed: check during testing

- **GHL `Version` header**: GHL's current docs list `v3` only; the old Make scenarios sent
  `2021-07-28`. If `internalCheck.js` reports a version error, set `GHL_API_VERSION`.
- **GHL "slot taken" wording**: the service spots it from a 4xx mentioning slot or
  availability. If a taken slot instead shows as a failed booking in Chat, send me the error.
- **TNZ link check**: the text mentions `hello@flowify.nz`. If TNZ holds it as "Pending
  URLCheck" (see backlog D10), the email address is counting as a link.
