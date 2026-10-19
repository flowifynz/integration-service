# Flowify service: setup guide

From the zip on your laptop to **build step 1 done**: the service runs on Render, your
Jobber test account is connected, and the service can pull its client list. It also
covers a first TNZ test text. Allow about 2–3 hours.

Commands run on your laptop unless a step says **Render Shell**. That's the *Shell* tab
on the `flowify-web` service in the Render dashboard, where the scripts run with
production env vars and database access.

---

## 0. Before you start

You need:

- [ ] **Node 22.18 or newer** on your laptop (`node --version`). Older versions can't run `.ts` files directly.
- [ ] **GitHub** account (private repo)
- [ ] **Render** account with a card on file (nothing here uses the free tier)
- [ ] **Jobber Developer Center** account: developer.getjobber.com
- [ ] **Jobber developer testing account**: use the signup link on the Developer Center's *Getting Started* page. It lasts 90 days with no subscription prompts. Don't use a real client's account.
- [ ] **TNZ** account with API access
- [ ] **Sentry** account (optional for now)
- [ ] A 1Password vault (or similar) called e.g. *Flowify service*. Every secret below goes in it **before** it goes anywhere else.

---

## 1. Install, test and create the lockfile

```bash
unzip flowify-service.zip && cd flowify-service
npm install          # also creates package-lock.json; Render's `npm ci` needs it
npm test             # expect: 18 pass, 0 fail
npm run typecheck    # first check against the REAL library types
npm run build        # compiles to dist/
```

**If `typecheck` shows errors**, paste them to Claude. The scaffold was checked against
simplified library types because packages couldn't be installed in Claude's workspace,
so a small mismatch with Fastify, pg-boss or Sentry is possible. Fix them before
deploying.

```bash
git add package-lock.json && git commit -m "Add lockfile"
```

## 2. Push to GitHub

Create an **empty private** repo on GitHub called `flowify-service` (no README or
.gitignore, since the zip already has both), then:

```bash
git remote add origin git@github.com:<your-user>/flowify-service.git
git push -u origin main
```

## 3. Generate your own secrets

Run each command once and save each value in 1Password under the name on the left:

```bash
openssl rand -base64 32   # APP_SECRET            (signs connect links)
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY  (encrypts Jobber tokens; never change or lose it)
openssl rand -hex 24      # ELEVENLABS_TOOL_SECRET
openssl rand -hex 24      # TNZ_INBOUND_KEY       (hex is safe to put in a URL)
```

APP_SECRET and TOKEN_ENCRYPTION_KEY must be **different** values.

## 4. Create everything on Render (Blueprint)

1. Render dashboard → **New → Blueprint** → connect GitHub → pick `flowify-service`.
2. Render reads `render.yaml` and lists: `flowify-web`, `flowify-worker`,
   `flowify-reminders` (cron), `flowify-db` (Postgres) and the `flowify-shared` env group.
   Check the region shows **Oregon** for all of them.
3. **Apply.** First deploy takes about 5 minutes. On `flowify-web` → *Events* you should see:
   build → pre-deploy (`npm run migrate` prints `Applying 001_init.sql`) → live.
4. Open `https://<your-web-service>.onrender.com/healthz` → `{"ok":true}`.

The services start fine without the secrets. Each secret is only needed when a request
uses it.

Copy the web service's URL (top of the `flowify-web` page). That's your **PUBLIC_BASE_URL**, with
no trailing slash, e.g. `https://flowify-web-abcd.onrender.com`.

## 5. Add secrets to the env group

Render → **Environment Groups** → `flowify-shared` → add:

| Key | Value |
|---|---|
| `PUBLIC_BASE_URL` | the URL from step 4 |
| `APP_SECRET` | from step 3 |
| `TOKEN_ENCRYPTION_KEY` | from step 3 |
| `ELEVENLABS_TOOL_SECRET` | from step 3 |
| `TNZ_INBOUND_KEY` | from step 3 |
| `TNZ_API_TOKEN` | from TNZ (step 9). Add it later if you don't have it yet |
| `SENTRY_DSN` | optional (step 10) |

`JOBBER_CLIENT_ID` and `JOBBER_CLIENT_SECRET` come in step 6. `ELEVENLABS_WEBHOOK_SECRET`
comes later, when the ElevenLabs agent is set up (build step 2).

Save, and let Render redeploy the three services. (The YAML can't hold these: Render
ignores secret placeholders inside env groups. Variables you add in the dashboard
survive later Blueprint syncs.)

## 6. Create the Jobber app

In the Developer Center → **Apps → New**:

1. **Name** `Flowify`, plus developer name and a one-paragraph description (reviewers read this later).
2. **Scopes:** for now, *read/write clients* and *read/write requests*. Add jobs, quotes,
   invoices and scheduling scopes when you build steps 4–6. While the app is in Draft you
   can change scopes freely; afterwards just reconnect the test account.
3. **OAuth Callback URL:** `<PUBLIC_BASE_URL>/jobber/callback`. It must match exactly:
   https, no trailing slash.
4. **Refresh token rotation:** turn it **on**.
5. **Webhooks:** add topic `APP_DISCONNECT` → URL `<PUBLIC_BASE_URL>/jobber/webhooks`.
   (The visit, quote and invoice topics come in build step 4. The full topic list is in the
   webhook dropdown, so screenshot it now for the week-1 questions.)
6. Save. Copy the **Client ID** and **Client Secret** into 1Password, then into the
   `flowify-shared` env group as `JOBBER_CLIENT_ID` and `JOBBER_CLIENT_SECRET`. Save and redeploy.

⚠ **GraphiQL resets the connection.** *Manage Apps → ⋯ → Test in GraphiQL* is how you
answer the week-1 questions (mutations, webhook topics). Each GraphiQL session
**invalidates the app's existing refresh tokens for that Jobber account**. After using
it, the service's connection to that account dies and you need a new connect link
(step 8). This is expected, not a bug. Do your GraphiQL exploring before step 8, or
reconnect afterwards.

## 7. Add a test client row

**Render Shell** (flowify-web → Shell):

```bash
node dist/scripts/sql.js "INSERT INTO clients (slug, business_name, tier, owner_name, owner_mobile, owner_email, monthly_minutes_cap) VALUES ('flowify-test', 'Flowify Test Plumbing', 'run', 'Jaron', '+6421XXXXXXX', 'jaron@flowify.nz', 100)"
node dist/scripts/sql.js "SELECT slug, business_name, tier, status, sms_mode FROM clients"
```

`agent_phone` stays empty until there's a Twilio number for the ElevenLabs agent.
`sms_mode` defaults to `test`.

## 8. Connect Jobber (build step 1 "done")

1. In the Jobber **testing account**, add two or three made-up clients with NZ mobile numbers.
2. **Render Shell:**
   ```bash
   node dist/scripts/connectLink.js flowify-test
   ```
3. Open the printed link in a browser where you're logged into the Jobber testing
   account → **Allow** → you should land on "Jobber connected".
4. Check that it's stored (tokens encrypted):
   ```bash
   node dist/scripts/sql.js "SELECT jobber_account_name, status, access_token_expires_at, left(refresh_token_enc, 12) AS enc FROM jobber_connections"
   ```
   `enc` should start with `v1.`.
5. **Pull the client list:**
   ```bash
   node dist/scripts/jobberClients.js flowify-test
   ```
   You should see your test clients. **If it errors on a field name** (`phones`, `emails`,
   `searchTerm`), check the `clients` query in GraphiQL and fix `CLIENTS_QUERY` in
   `src/jobber/graphql.ts`. That's the one query not yet checked against the real schema.
6. **Prove the refresh works:** wait more than an hour (tokens last 60 minutes), run step 5 again, then:
   ```bash
   node dist/scripts/sql.js "SELECT refreshed_at, access_token_expires_at FROM jobber_connections"
   ```
   `refreshed_at` should have moved forward. That shows the rotated refresh token was saved.

**Disconnect/reconnect test (part of Jobber's review standard):** in the Jobber testing
account, find Flowify under connected apps and disconnect it. Then:

```bash
node dist/scripts/sql.js "SELECT topic, status, received_at FROM webhook_events ORDER BY id DESC LIMIT 3"
node dist/scripts/sql.js "SELECT status, disconnected_at FROM jobber_connections"
```

Expect an `APP_DISCONNECT` row marked `processed` and the connection marked
`disconnected`. Run step 8.2–8.5 again to reconnect.

✅ **Build step 1 is done** when 8.5 lists the clients and 8.6 shows a refresh.

## 9. TNZ: confirm the API format and send a test text

The TNZ code follows my best reading of their API, **not their v3.00 spec**, which isn't
public. So:

1. In your TNZ account, create an **API token** (or ask TNZ support for a v3.00 token) →
   1Password → `TNZ_API_TOKEN` in the env group → redeploy.
2. Ask TNZ support for (or find in their docs) the **v3.00 JSON spec** for:
   - the send-SMS request body (`MessageData`, `Destinations[].Recipient`, `Reference`, `SubAccount`, `Mode`?)
   - the success response (`Result`, `MessageID`?)
   - the **inbound reply webhook** payload, and whether it includes the `Reference` of the
     text being replied to (this decides whether a STOP opts out of one client or all of them)
   - how SubAccounts are created for per-client billing
3. Fix `buildTnzPayload` / `parseTnzResponse` in `src/sms/tnz.ts` and `extractInbound` in
   `src/routes/tnzInbound.ts` to match. Nothing else needs to change.
4. **Test send** (between 8am and 8pm NZ time; quiet hours apply). **Render Shell:**
   ```bash
   node dist/scripts/sendTestSms.js flowify-test 021XXXXXXX
   ```
   In `test` mode TNZ should accept it without delivering it. You'll see
   `{ status: 'sent', tnzMessageId: ... }`. If it fails, the error includes TNZ's
   full response.
5. To get it on your phone, switch the test client to live and send again:
   ```bash
   node dist/scripts/sql.js "UPDATE clients SET sms_mode = 'live' WHERE slug = 'flowify-test'"
   node dist/scripts/sendTestSms.js flowify-test 021XXXXXXX
   ```
   Check the text is signed "- Flowify Test Plumbing".
6. In TNZ, set the inbound/reply webhook URL to
   `<PUBLIC_BASE_URL>/tnz/inbound?key=<TNZ_INBOUND_KEY>`. Reply **STOP** to the test text, then:
   ```bash
   node dist/scripts/sql.js "SELECT * FROM opt_outs"
   ```
   Delete that row afterwards so you can keep testing:
   `node dist/scripts/sql.js "DELETE FROM opt_outs"`

## 10. Sentry (optional now, needed before the first real client)

Sentry → new **Node.js** project → copy the DSN → `SENTRY_DSN` in the env group →
redeploy. Errors from all three services land in one project. Phone numbers and names
are kept out (`sendDefaultPii: false`).

## 11. Housekeeping

- [ ] Add Render (US hosting), TNZ and Sentry to Flowify's privacy policy as processors.
  Client data is stored offshore, which the Privacy Act's IPP 12 cares about.
- [ ] Render → `flowify-db` → confirm daily backups are listed.
- [ ] Put a reminder in your calendar for the Jobber testing account's 90-day expiry.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Build fails at `npm ci` | `package-lock.json` not committed (step 1) |
| Build fails at `npm run build` | type errors; run `npm run typecheck` locally |
| Deploy stuck at pre-deploy | migration error; check flowify-web → Events → pre-deploy logs |
| Logs say `Missing required environment variable X` | add X to `flowify-shared` and redeploy |
| Jobber says redirect URI mismatch | callback URL in the Developer Center ≠ `PUBLIC_BASE_URL` + `/jobber/callback` exactly |
| "Something went wrong" after Allow | flowify-web logs. Most often the Jobber account is already connected to another client row, or wrong client secret |
| `jobberClients` → "not connected (needs_reconnect)" | refresh token was rejected; did you use GraphiQL? Send a new connect link |
| Jobber webhooks return 401 | `JOBBER_CLIENT_SECRET` wrong or regenerated (regenerating also revokes all connections) |
| Changed `TOKEN_ENCRYPTION_KEY` | every stored token is now unreadable: restore the old key from 1Password |

## What comes next (build step 2)

Set up the ElevenLabs test agent and a Twilio number, then put that number in
`clients.agent_phone`. Then build `find_customer` + `create_request`. Tool settings
are in README.md → *ElevenLabs tool configuration*.
