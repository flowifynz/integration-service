# Alerts to Jaron (backlog D4)

When something breaks for a client, a message is posted to your **support alerts** space in
Google Chat before the client notices. Each alert also goes to Sentry. A text to your mobile
is an optional backup.

## What raises an alert, and when

| Alert | Trigger | When it's sent |
|---|---|---|
| Jobber connection expired | Jobber rejects the client's refresh token | Straight away. Then once a day until reconnected |
| Flowify app removed in Jobber | `APP_DISCONNECT` webhook | Straight away. Then once a day until reconnected (skipped if the client is `cancelled`) |
| Jobber reconnected | Client reconnects after either of the above | Straight away (good news) |
| Connect failed | Client used a connect link and the callback failed, e.g. that Jobber account is already linked to another client | Straight away, at most once a day |
| Texts failing | 3+ failed texts (send errors or failed delivery) for one client in 24h | Hourly check, once a day per client |
| Jobber events stuck | Events still unprocessed after an hour. The check also re-queues them | Hourly check, once a day |
| Worker backed up | Jobs waiting over 30 minutes (deliberately delayed jobs don't count) | Hourly check, once a day |

The hourly health check runs inside `flowify-worker` at 7 minutes past each hour (NZ time).
With Google Chat set up it posts any time. If you only use texts, it only texts between 7am
and 9pm, and anything found overnight reaches you at 7am.

**In Google Chat:**
- Everything about one client's Jobber connection (expired, removed, failed, reconnected)
  goes in one thread, so the "reconnected" message shows up under the problem.
- Expired and removed alerts include a **fresh connect link** (valid 7 days) that you can
  forward to the client. That link connects a Jobber account to that client, so keep the
  space to Flowify staff.

**By text (optional):**
- Texts have no links, because TNZ holds texts with links for a URL check. Instead they
  give the Render Shell command for a new connect link.
- Texts go to TNZ SubAccount `flowify`, so they never appear on a client's SMS bill.
- Texts are sent Live even while a client's own texts are in Test mode.

## Setup

1. **Create the webhook in Google Chat.** Open your support alerts space → click the space
   name at the top → **Apps & integrations** → **Webhooks** → **Add webhook**. Name it
   "Flowify alerts" (the avatar URL is optional) → **Save** → copy the URL. It starts with
   `https://chat.googleapis.com/v1/spaces/...`.
   - The webhook URL works like a password: anyone holding it can post to the space. Save it in 1Password.
   - If **Webhooks** isn't offered, a Google Workspace admin has turned off incoming
     webhooks: Admin console → Apps → Google Workspace → Google Chat → allow incoming webhooks.
2. **Render → Environment Groups → `flowify-shared`**: add `GOOGLE_CHAT_WEBHOOK_URL` = that
   URL. Save; Render redeploys.
   - Optional backup by text: also add `ALERT_MOBILE` = your mobile. Leave it out for Chat only.
   - With neither set, alerts only reach Sentry and the logs, and `admin_alerts` rows show `skipped`.
3. **Sentry (optional email):** Alerts → Create alert → Issues →
   *A new issue is created* → email you. Each alert kind per client is its own issue.

## Test it (after deploying)

All in **Render Shell** on `flowify-web`:

```bash
# 1. Test post: proves the webhook and the worker. It should appear in the space within a minute.
node dist/scripts/healthCheck.js --test
node dist/scripts/healthCheck.js --list        # status should be 'sent'

# 2. Expired connection (simulated). Mark the test client's connection broken, run the check:
node dist/scripts/sql.js "UPDATE jobber_connections SET status = 'needs_reconnect' WHERE client_id = (SELECT id FROM clients WHERE slug = 'flowify-test')"
node dist/scripts/healthCheck.js               # prints 'alert jobber_needs_reconnect ...'; post with a connect link
node dist/scripts/healthCheck.js               # run again: no second post today
# Open the link from the post and approve in Jobber → "Jobber reconnected" in the same thread.

# 3. App removed (real webhook). In the Jobber testing account: Settings → Apps → Flowify →
#    Disconnect. "Removed the Flowify app" appears within a minute. Reconnect with the link
#    in that post → "Jobber reconnected" in the same thread.
```

## Tables

`admin_alerts`: one row per alert (`kind`, `status`, `error`, `chat_sent_at`, `tnz_message_id`).

```bash
node dist/scripts/sql.js "SELECT id, kind, status, error, chat_sent_at, created_at FROM admin_alerts ORDER BY id DESC LIMIT 10"
```
