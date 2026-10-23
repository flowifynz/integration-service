# After every call (backlog D3)

When a call ends, ElevenLabs sends its post-call webhook to `/elevenlabs/post-call`. The
service stores the call, and the worker then does the following:

| Situation | What happens |
|---|---|
| Any call | Call record filled in: who, when, how long, what about (minutes cap and weekly check read this) |
| New job, logged in Jobber during the call | Thank-you text to the caller (T1) |
| New job, Core, `create_request` ran but Jobber failed | Request created now (note says "logged after the call"); owner gets "Now saved in Jobber"; caller thanked |
| New job, Core, `create_request` never ran | Request created now from the agent's data collection; owner gets the full summary; caller thanked |
| New job but no name or details | No request; owner gets what there is; call flagged `needs_review` |
| New job, Base | Owner gets the summary text (T2, or T3 if urgent); caller thanked. No Jobber |
| Sales, supplier, wrong number (`call_category` other than `new_job`) | Recorded only |
| Nobody spoke, or under 10 seconds | Recorded as `no_conversation` (missed-call text-back is D2) |
| Can't tell (no `call_category`, tool not used) | Recorded, flagged `needs_review` |

Texts to callers go to mobiles only, follow quiet hours (held until 8am), and count against
the client's SMS allowance (TNZ Department `calls`). To turn the thank-you text off for one client:

```bash
node dist/scripts/sql.js "UPDATE clients SET automation = automation || '{\"callerConfirmations\": false}' WHERE slug = 'smith-plumbing'"
```

The wording is: "Thanks for calling. We've passed your details to {owner first name} and
they'll be in touch soon." The service then adds "Questions? Call us on {Twilio number}" and
"- {Business}".

## ElevenLabs settings this relies on

1. **Post-call webhook.** ElevenLabs → Settings (workspace) → Webhooks → post-call
   *transcription* webhook URL `<PUBLIC_BASE_URL>/elevenlabs/post-call`. Its secret must equal
   `ELEVENLABS_WEBHOOK_SECRET` in Render. Leave post-call **audio** off: it isn't used.
2. **Data collection** (agent → Analysis → Data collection). Without these, the service
   only knows about a call if `create_request` was used. Add each as type *String*,
   with the description shown:

| Identifier | Description to paste |
|---|---|
| `call_category` | One of: new_job, existing_booking, supplier, sales_spam, wrong_number, complaint, other. new_job = the caller wants work done. |
| `caller_name` | The caller's full name as they gave it. Empty if not given. |
| `caller_phone` | The callback number the caller said, digits only. Empty if they didn't say one. |
| `property_address` | The site address for the job. Empty if not given. |
| `job_description` | What the caller needs done, in one or two sentences. |
| `is_emergency` | yes if the caller described an urgent or dangerous problem, otherwise no. |

Publish the agent after adding them.

## Testing (flowify-test)

In Render Shell on `flowify-web`:

```bash
node dist/scripts/calls.js flowify-test         # latest calls and what happened after each
```

1. **Normal call.** Call the test number from your mobile, give a job, and hang up after the
   goodbye. Within a minute: `status` done, `category` new_job, `request` tool, and a thank-you
   text arrives (8am to 8pm).
2. **Safety net.** Turn the `create_request` tool off on the agent (or disconnect it), publish,
   and call with a job. Within a minute: a request appears in Jobber with "Logged by Flowify
   after the call", you get the owner text, `request` = after_call. Turn the tool back on and publish.
3. **Sales call.** Pretend to sell something. You should get no texts, and `category` = other.
4. **Replay.** `node dist/scripts/calls.js --reprocess <conversation_id>` on test 1 sends nothing new.

Worker log lines start `[call <conversation_id>]` and list what was done.
