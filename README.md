# Flowify service

One Node.js (TypeScript) app on Render that serves every Flowify client. It connects
**ElevenLabs** (the AI receptionist), **Jobber** (the client's job management, which they
own) and **TNZ** (NZ SMS).

## Plans (from 23 Oct 2026)

| Plan | What the service does | Price |
|---|---|---|
| **Base** | AI receptionist + missed-call text-back. No Jobber. Needs *Base mode* (backlog D1–D3), not built yet | $495 setup, $149/mo |
| **Core** | Base + Jobber: requests from calls, Jobber-driven texts, live booking once built (D9) | from $1,495 setup, $450/mo |

`clients.tier` is `base` or `core` (migration 007 renamed the old `run` / `receptionist`).
Live booking is switched on per Core client with `booking_mode` / `rescheduling_enabled`.
The full backlog (D1–D12) lives in Notion: Flowify Builds › Flowify Service Build Backlog.

```
 Caller ──► Twilio ──► ElevenLabs agent ──tool calls──►┐
                                                       │   flowify-web  (Fastify)
 Jobber ──webhooks (ack < 1 s)────────────────────────►│     │ stores + enqueues
 Client ──"Connect Jobber" link──► OAuth ─────────────►┘     ▼
                                                     Postgres (+ pg-boss queue)
                                                             ▲
 flowify-reminders (nightly cron) ──enqueue──────────────────┤
                                                             ▼
                                                     flowify-worker ──► TNZ SMS
                                                                   └──► Jobber lookups
```

## Status of this scaffold

| Piece | State |
|---|---|
| render.yaml (web, worker, cron, Postgres, env group) | Done |
| Schema + migration runner (runs pre-deploy) | Done |
| Jobber OAuth connect / callback / reconnect | Done — needs a real test account |
| Token encryption (AES-256-GCM) + locked refresh with rotation | Done |
| `APP_DISCONNECT` handling | Done |
| Jobber webhook receiver (HMAC, dedupe, enqueue) | Done |
| TNZ sender + messages log, dedupe, opt-outs, quiet hours | Done — payload shape unconfirmed |
| STOP handling (TNZ inbound) | Done — payload shape unconfirmed |
| ElevenLabs find_customer, create_request, call-start greeting | Done (step 2), see docs/elevenlabs-agent.md |
| ElevenLabs booking/reschedule tools | Stubs (backlog D9) |
| After-call processing: call record, caller thank-you text, Core safety-net request, Base owner text | Done (D3), see docs/post-call.md |
| Worker: Jobber-driven texts (confirmations, reminders, quote/invoice follow-ups, reviews) | Done (step 4), see docs/jobber-texts.md |
| TNZ cost tracking + monthly usage report (`sms:usage`) | Done |
| Base mode, missed-call text-back | Not built (D1, D2) |
| Alerts to Jaron (Google Chat, optional text) + hourly health check | Done (D4), see docs/alerts.md |
| Onboarding script (`onboardClient.js`), tiers renamed base/core | Done (D5, D11) |
| Minutes cap, weekly calls-vs-Jobber check | Not built (D6, D7) |
| **Internal module** (Flowify's own automations): website agent books discovery calls in Flowify's GHL calendar, TNZ confirmation text, Google Chat notice | Built 24 Oct 2026, see docs/internal-website-agent.md |

**Client vs internal.** Everything above is for Flowify's trade clients. Flowify's own
business automations live in `src/internal/`, with their own database schema (`internal.*`),
their own routes (`/internal/*`), secret (`INTERNAL_TOOL_SECRET`), queues (`internal-*`), TNZ
SubAccount and kill switch (`INTERNAL_ENABLED`). Nothing there reads or writes client rows.

## Layout

```
render.yaml                 Render Blueprint
migrations/001_init.sql     clients, jobber_connections, messages, webhook_events, calls, opt_outs
src/
  server.ts                 web entry point
  worker.ts                 worker entry point (send-sms, jobber-event, day-before-reminders)
  cron/reminders.ts         nightly cron: enqueues reminders for tomorrow (NZ date)
  migrate.ts                forward-only migration runner
  config.ts  db.ts  queue.ts  crypto.ts  phone.ts  instrument.ts  elevenlabsSignature.ts
  jobber/
    oauth.ts                authorize URL, code exchange, refresh
    connection.ts           save / get valid token (locked refresh) / disconnect
    graphql.ts              GraphQL client (+ retry once on 401)
    webhook.ts              HMAC verify, parse, dedupe key
  sms/
    compose.ts              signature, "call us to change", STOP line on marketing
    quietHours.ts           8pm–8am Pacific/Auckland
    tnz.ts                  the only module that talks to TNZ
    outbound.ts             sendClientSms: dedupe → number → opt-out → quiet hours → claim → send
  routes/
    elevenlabs.ts           tools + call-start + post-call
    jobberOAuth.ts          /jobber/connect, /jobber/callback
    jobberWebhook.ts        /jobber/webhooks
    tnzInbound.ts           /tnz/inbound (STOP)
  internal/                 Flowify's OWN automations (not client data), see docs/internal-website-agent.md
    routes.ts               /internal/tools/check_availability, /internal/tools/book_discovery_call
    discoveryCall.ts        bookable hours, slot picking, wording (pure, tested)
    ghl.ts                  Flowify's GoHighLevel calendar + contacts
    sms.ts  chat.ts         Flowify's own texts (internal.messages) and Google Chat notices
    worker.ts               internal-send-sms, internal-chat jobs
  scripts/
    connectLink.ts          npm run connect-link -- <slug>
    jobberClients.ts        npm run jobber:clients -- <slug>   (step 1 "done" check)
    internalCheck.ts        node dist/scripts/internalCheck.js [--chat] [--sms <mobile>]
test/core.test.ts           unit tests for crypto, signatures, quiet hours, SMS text
test/internal.test.ts       unit tests for the internal module
```

Source files import each other with `.ts` extensions, so Node 22.18+ runs them directly
(dev, tests, scripts — no build step). `npm run build` compiles to `dist/` for Render.

## Local dev

```bash
npm install
cp .env.example .env            # fill in values
node --env-file=.env src/migrate.ts
node --env-file=.env --watch src/server.ts
node --env-file=.env --watch src/worker.ts   # second terminal
npm test
npm run typecheck
```

## Setup

Step-by-step instructions (Render, Jobber app, secrets, first connection, TNZ test):
see **SETUP.md**.

## Jobber Developer Center settings

- **OAuth Callback URL:** `<PUBLIC_BASE_URL>/jobber/callback`
- **Refresh token rotation:** on
- **Webhook URL:** `<PUBLIC_BASE_URL>/jobber/webhooks`. Subscribe to `APP_DISCONNECT` plus the
  visit/quote/invoice topics once confirmed
- **Scopes:** read/write clients and requests now; jobs, quotes, invoices and scheduling
  when booking is built. Keep them minimal, since reviewers check.
- **Test in GraphiQL invalidates the app's refresh tokens for that account.** Reconnect afterwards.

## Onboarding a client

One command in Render Shell (flowify-web) creates the client with its plan's defaults,
sets the TNZ SubAccount to the slug, and prints the Jobber connect link (Core):

```bash
node dist/scripts/onboardClient.js --slug smith-plumbing --name "Smith Plumbing" --tier core \
  --agent-phone "09 555 1234" --owner-mobile "021 123 4567" --owner-name Dave \
  --owner-email dave@smithplumbing.co.nz --agent-id agent_abc123
node dist/scripts/onboardClient.js --help        # every option
```

Re-run with the same `--slug` to change anything (only the options you give change). Add
`--dry-run` to preview. When the R3 tests pass, switch the client on (status `active`, TNZ Live):

```bash
node dist/scripts/onboardClient.js --slug smith-plumbing --go-live
```

`--go-live` refuses if the agent ID, Twilio number or owner mobile is missing, or (Core) Jobber
isn't connected. Plan defaults (minutes, SMS allowance) live in `src/onboarding/settings.ts`.

Other Render Shell commands:

```bash
node dist/scripts/connectLink.js smith-plumbing     # a fresh connect link
node dist/scripts/jobberClients.js smith-plumbing   # after they connect: proves the connection works
node dist/scripts/sql.js "SELECT ..."                # one-off SQL
node dist/scripts/sendTestSms.js smith-plumbing 021...  # test text
```

## ElevenLabs tool configuration

Every tool: `POST <PUBLIC_BASE_URL>/elevenlabs/tools/<name>`, header
`x-flowify-secret: <ELEVENLABS_TOOL_SECRET>`, body parameter `called_number` =
`{{system__called_number}}`, and `caller_number` = `{{system__caller_id}}` where relevant.
The call-start webhook (`/elevenlabs/call-start`) uses the same header. The post-call
webhook (`/elevenlabs/post-call`) is verified with `ELEVENLABS_WEBHOOK_SECRET`.

## Unconfirmed — check before relying on it

Marked in code with comments. None of these are verified yet:

- **Jobber:** the `clients` query fields (`phones`, `emails`, `searchTerm`); webhook topic names; throttling error code;
  booking and reschedule mutations (week-1 list).
- **TNZ v3.00:** sending matches the spec. The reply/delivery webhook payload field names
  are not defined in TNZ's spec; `sms/inbound.ts` accepts likely names. Confirm with a real STOP.
- **ElevenLabs:** post-call signature header format; call-start response shape.
- **Render:** cron schedule assumed to be UTC.

## Decisions taken in this scaffold

- Added a sixth tool, `create_request`, for Core (the five-tool list has no way to log
  a request mid-call). Alternative: create it from the post-call webhook.
- Opt-outs with no client attached block that number for every client (shared short code).
- Owner alerts skip quiet hours; customer texts don't.
- Customer texts that aren't about a booking end "Questions? Call us on …" rather than
  "to change your booking".
- Cron runs 05:00 UTC (6pm NZDT / 5pm NZST) and only enqueues.
