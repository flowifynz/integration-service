# Flowify service

One Node.js (TypeScript) app on Render that serves every Flowify client. It connects
**ElevenLabs** (the AI receptionist), **Jobber** (the client's job management, which they
own) and **TNZ** (NZ SMS).

## Plans (from 23 Oct 2026)

| Plan | What the service does | Price |
|---|---|---|
| **Base** | AI receptionist + missed-call text-back. No Jobber. Needs *Base mode* (backlog D1–D3), not built yet | $495 setup, $149/mo |
| **Core** | Base + Jobber: requests from calls, Jobber-driven texts, live booking once built (D9) | from $1,495 setup, $450/mo |

The database still uses the old tier values: `run` (= Core, capture only) and `receptionist`
(= Core with booking tools). Renaming them to `base` / `core` is backlog item D11 (a migration
plus the `tier` / `can_book` call-start variables), so keep using `run` for now.
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
| ElevenLabs booking/reschedule tools, post-call summary | Stubs (backlog D9, D3) |
| Worker: Jobber-driven texts (confirmations, reminders, quote/invoice follow-ups, reviews) | Done (step 4), see docs/jobber-texts.md |
| TNZ cost tracking + monthly usage report (`sms:usage`) | Done |
| Base mode, missed-call text-back | Not built (D1, D2) |
| Go-live readiness: alerts to Jaron, onboarding script, minutes cap, weekly calls-vs-Jobber check | Not built (D4, D5, D6, D7) |

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
  scripts/
    connectLink.ts          npm run connect-link -- <slug>
    jobberClients.ts        npm run jobber:clients -- <slug>   (step 1 "done" check)
test/core.test.ts           unit tests for crypto, signatures, quiet hours, SMS text
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

## Onboarding a client (until the onboarding script, D5, exists)

Core client today: `tier` = `'run'`, `monthly_minutes_cap` = 300 (100 for Base once Base mode exists).

```sql
INSERT INTO clients (slug, business_name, tier, agent_phone, owner_mobile, owner_email,
                     tnz_subaccount, monthly_minutes_cap)
VALUES ('smith-plumbing', 'Smith Plumbing', 'run', '+6495551234', '+64211234567',
        'owner@example.co.nz', 'smith-plumbing', 300);
```

```bash
# in Render Shell (flowify-web):
node dist/scripts/connectLink.js smith-plumbing     # send this link to the client
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

- Added a sixth tool, `create_request`, for Core (old "Run" tier) (the five-tool list has no way to log
  a request mid-call). Alternative: create it from the post-call webhook.
- Opt-outs with no client attached block that number for every client (shared short code).
- Owner alerts skip quiet hours; customer texts don't.
- Customer texts that aren't about a booking end "Questions? Call us on …" rather than
  "to change your booking".
- Cron runs 05:00 UTC (6pm NZDT / 5pm NZST) and only enqueues.
