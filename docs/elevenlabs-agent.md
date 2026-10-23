# ElevenLabs agent setup (Core: capture a request)

Core clients (`tier = core`) until live booking (backlog D9) is built. Base clients (no Jobber)
need Base mode (D1) and don't use these tools. Create the client with `onboardClient.js`
(README → Onboarding a client) and pass the agent's ID with `--agent-id`.

One agent per Flowify client. All agents call the same Flowify URLs; the service works out
which client a call is for from the dialled number, or from the agent ID in browser tests.

## 0. Phone number (Twilio)

1. Buy the NZ number in Twilio and wait for its regulatory bundle to be approved.
2. Import it into ElevenLabs (Phone Numbers → Import → Twilio) and assign the agent.
3. **In Twilio, check the number's active region is US1.** NZ numbers can arrive with the
   Australia (AU1) region active and no configuration there. Calls then fail with a carrier
   "number not active" message and never appear in the US1 call logs. Fix: the number's
   **Regional** tab → **Change active region** → US1. The active configuration should then
   show `https://api.us.elevenlabs.io/twilio/…`.
4. Save it on the client (E.164, no spaces):
   ```bash
   node dist/scripts/sql.js "UPDATE clients SET agent_phone = '+649XXXXXXX' WHERE slug = '<client-slug>'"
   ```

## 1. Link the agent to the client

Copy the agent ID from the agent's page in ElevenLabs (`agent_...`), then in **Render Shell**:

```bash
node dist/scripts/sql.js "UPDATE clients SET elevenlabs_agent_id = 'agent_XXXXXXXX' WHERE slug = 'flowify-test'"
```

## 2. Dynamic variables

Deploy any service change that adds a variable **before** publishing an agent change that
uses it. If the agent asks for a variable the service doesn't send yet, calls drop.


Define these on the agent. The call-start webhook returns all eight, and ElevenLabs requires
the webhook to return every variable the agent defines. For browser tests, give them
placeholder values in the agent's test settings (**{ } Vars** button): `business_name` = Flowify
Test Plumbing, `greeting` = Kia ora, `caller_id_available` = no, `customer_name` = none.
Those placeholders make a browser test behave like a call with no caller ID.

| Variable | Example |
|---|---|
| `business_name` | Flowify Test Plumbing |
| `greeting` | Kia ora Sam (known caller) / Kia ora (anyone else) |
| `caller_id_available` | yes / no |
| `customer_name` | Tom Jones, Tom Jones from Apex Building, or `none` |
| `customer_first_name` | Sam (empty for new callers) |
| `tier` | core (or base) |
| `can_book` | false |
| `can_reschedule` | false |

## 3. First message

```
{{greeting}}, you've called {{business_name}}. This is the virtual receptionist. How can I help?
```

## 4. System prompt

**Version 3 (23 Oct 2026)** lives in `docs/agent-prompt.txt`: paste the whole file into
the agent's System prompt. It's a short playbook: golden rules for every call, then one
section per call type (new job, message, sales, wrong number, calling back), the callback
number rules, and what to do when a tool fails.

- **Behaviour goes in the prompt; facts go in the knowledge base.** The knowledge base
  (services, area, hours, payment, FAQs) is only looked up when the agent thinks it needs
  a fact, so rules there get missed.
- After any prompt change, run the simulation tests in `docs/agent-tests.md` before
  publishing.

The `end_call` system tool must be on (agent → Tools → System tools) for "end the call" to work.

## 5. Tools

All three tools: **Webhook**, method **POST**, header `x-flowify-secret` = your
`ELEVENLABS_TOOL_SECRET` (stored as an ElevenLabs secret).

### find_customer

- **URL:** `https://flowify-web.onrender.com/elevenlabs/tools/find_customer`
- **Description:** Look up a caller by a phone number they gave you. Only needed when there's no caller ID; callers with caller ID are looked up before the call starts.

| Parameter | Value type | Value / description |
|---|---|---|
| `called_number` | Dynamic variable | `system__called_number` |
| `agent_id` | Dynamic variable | `system__agent_id` |
| `caller_number` | Dynamic variable | `system__caller_id` |
| `phone` | LLM (optional) | A phone number the caller said, only if there's no caller ID |

### create_request

- **URL:** `https://flowify-web.onrender.com/elevenlabs/tools/create_request`
- **Description:** Log the caller's job request for the team, once you have their name, site address, what they need and the urgency.

| Parameter | Value type | Value / description |
|---|---|---|
| `called_number` | Dynamic variable | `system__called_number` |
| `agent_id` | Dynamic variable | `system__agent_id` |
| `caller_number` | Dynamic variable | `system__caller_id` |
| `conversation_id` | Dynamic variable | `system__conversation_id` |
| `name` | LLM (required) | Caller's full name (as confirmed, if find_customer found them) |
| `phone` | LLM (optional) | Callback number exactly as the caller said it, only if different from the number they're calling from or there's no caller ID. Never invent one; use none if they won't give one |
| `address` | LLM | Site address for the job, as confirmed with the caller |
| `description` | LLM (required) | What needs doing, in one or two sentences |
| `urgency` | LLM | One of: emergency, soon, flexible |

### take_message

Added 23 Oct 2026 (D3). **Deploy the service before adding this tool to the agent.**

- **URL:** `https://flowify-web.onrender.com/elevenlabs/tools/take_message`
- **Description:** Pass a message to the team from someone who isn't booking new work: a supplier, an existing customer chasing something, or anyone else who needs a call back. Never for sales calls and never for new jobs.

| Parameter | Value type | Value / description |
|---|---|---|
| `called_number` | Dynamic variable | `system__called_number` |
| `agent_id` | Dynamic variable | `system__agent_id` |
| `caller_number` | Dynamic variable | `system__caller_id` |
| `conversation_id` | Dynamic variable | `system__conversation_id` |
| `name` | LLM (required) | The caller's name |
| `company` | LLM (optional) | Their company, if they gave one |
| `phone` | LLM (optional) | Callback number exactly as the caller said it, only if different from the number they're calling from or there's no caller ID. Never invent one; use none if they won't give one |
| `message` | LLM (required) | The message for the team, in one or two sentences |
| `about` | LLM (required) | One of: supplier, existing_customer, other |

Tool Call Sound: **Typing**, **Always play** (same as create_request).

The service texts the owner ("Supplier message from ... Not a job - nothing added to
Jobber."). Nothing goes into Jobber and the caller gets no thank-you text.

**Tool Call Sound** (bottom of the tool settings, for create_request): **Typing**, behaviour **Always play**.
Don't rely on a spoken holding line ("one moment...") before the tool: in testing the
model treated it as the end of its turn and waited ~40 s before calling the tool. With
Always play, callers hear typing from the moment the agent starts on the tool call.

## 6. What happens when create_request runs

1. The service finds the caller in Jobber by phone, or creates a new client with their
   name, number and site address (source: "Flowify AI receptionist").
2. It creates a Jobber request, attached to the matching property if the address is on
   file, with a note holding everything the caller said.
3. It texts the owner (`clients.owner_mobile`). If Jobber was unreachable, the text says so
   and still carries all the details.
