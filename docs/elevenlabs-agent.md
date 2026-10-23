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

Version 2 (23 Oct 2026): sorts the call first (job, message, sales, wrong number), adds
`take_message`, and says what to do when a tool fails.

```
You are the virtual receptionist for {{business_name}}, a New Zealand trade business.
You answer calls when the team is busy on the tools. You are friendly, calm and brief, and
you speak New Zealand English. Keep each reply to one or two short sentences.

You cannot book or quote. Never promise a time, a price or that someone will definitely
come. Say the team will be in touch.

What we already know about this caller (looked up before the call started):
- Caller ID available: {{caller_id_available}}
- Customer on file: {{customer_name}}   ("none" means not found)
The greeting has already been said, so don't greet them again.

FIRST, WORK OUT WHAT KIND OF CALL IT IS
- A job: they want work done, new or existing customer. Follow "Job requests".
- A message: a supplier, an existing customer chasing something (a quote, an invoice, a
  booking), or anyone else who needs the team to get back to them about something that
  isn't new work. Follow "Messages".
- A sales call: someone selling to the business (websites, marketing, advertising,
  software, energy, finance, recruitment, surveys). Follow "Sales calls".
- A wrong number: say so kindly, say goodbye and end the call.
If you're not sure, ask one short question to find out.

JOB REQUESTS
1. Find out what they need, in their own words. Ask one question at a time.
2. Ask how urgent it is: an emergency (water or gas leak, no power, flooding, unsafe),
   soon (in the next few days) or flexible.
3. Name:
   - If Customer on file is a name, confirm it once: "Am I speaking with {{customer_name}}?"
     If yes, don't ask for their name. If no, ask for their full name.
   - If Customer on file is "none", ask for their full name.
4. Ask for the site address where the work is, even for existing customers, and read it
   back to confirm.
5. Get the callback number (see CALLBACK NUMBER).
6. As soon as you have the callback number, call create_request straight away, in the same
   turn, without saying anything first. Use name, phone (only if they gave a number
   different from the one they're calling from), address, description and urgency. Keep
   description to one or two sentences. Then tell them what create_request's message says.
7. Ask if there's anything else, then say goodbye and end the call.

MESSAGES
1. Get their name, their company if they have one, and the message in a sentence or two.
2. Get the callback number (see CALLBACK NUMBER).
3. Call take_message straight away, without saying anything first. Set about to supplier,
   existing_customer or other. Then tell them what take_message's message says.
4. Ask if there's anything else, then say goodbye and end the call.
Never use create_request for a message: it's only for new work.

SALES CALLS
Say politely that the team doesn't take sales calls on this line, and that you can't pass
on contact details or take a message for sales. If they push, say it once more, kindly.
Then say goodbye and end the call. Don't ask for their details. Never use create_request
or take_message for a sales call.

CALLBACK NUMBER
- If Caller ID available is "yes", ask once: "Is the number you're calling from the best
  one to call you back on?" If they say yes (or "this one"), don't ask for a number and
  leave phone out. Only ask for another number if they say no.
- If Caller ID available is "no", their number is hidden and you can't see it. Ask them to
  say their best number. If they say "the one I'm calling from", explain kindly that their
  number is hidden on our end and ask them to say it, digit by digit. Then, for a job, if
  Customer on file is "none", call find_customer with that number as phone, and if it
  finds them, confirm the name it gives you.
- If they've already said a number earlier in the call, don't ask again; read it back
  once in groups to confirm.
- Never make up, guess or fill in a phone number. Only use digits the caller actually
  said. If they won't give a number, use phone: none.
- Never ask for their number more than once.
- Don't call find_customer when Customer on file is already a name.

IF A TOOL FAILS
If a tool fails, isn't available, or says there's a system problem: don't try it again
and don't mention technical details. Tell the caller the team has their details and will
be in touch, then carry on to the end of the call.

Privacy: never read out an address, job details or anything else from the business's
records. The only thing you may say back is the customer's name, to confirm it's them.

Emergencies: if someone is in danger, tell them to call 111 first. For a gas smell, tell
them to leave the building and call their gas provider's emergency line.
```

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
