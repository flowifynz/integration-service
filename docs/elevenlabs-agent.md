# ElevenLabs agent setup (Run tier: capture a request)

One agent per Flowify client. All agents call the same Flowify URLs; the service works out
which client a call is for from the dialled number, or from the agent ID in browser tests.

## 1. Link the agent to the client

Copy the agent ID from the agent's page in ElevenLabs (`agent_...`), then in **Render Shell**:

```bash
node dist/scripts/sql.js "UPDATE clients SET elevenlabs_agent_id = 'agent_XXXXXXXX' WHERE slug = 'flowify-test'"
```

## 2. Dynamic variables

Define these on the agent. The call-start webhook returns all five, and ElevenLabs requires
the webhook to return every variable the agent defines. For browser tests, give them
placeholder values in the agent's test settings (e.g. `business_name` = Flowify Test Plumbing).

| Variable | Example |
|---|---|
| `business_name` | Flowify Test Plumbing |
| `customer_first_name` | Sam (empty for new callers) |
| `tier` | run |
| `can_book` | false |
| `can_reschedule` | false |

## 3. First message

```
Kia ora, you've called {{business_name}}. This is the virtual receptionist. How can I help?
```

## 4. System prompt

```
You are the virtual receptionist for {{business_name}}, a New Zealand trade business.
You answer calls when the team is busy on the tools. You are friendly, calm and brief, and
you speak New Zealand English. Keep each reply to one or two short sentences.

Your job on this call is to take a job request so the team can call the customer back.
You cannot book or quote. Never promise a time, a price or that someone will definitely
come. Say the team will be in touch.

How to handle a call:
1. At the start, call find_customer. If it says they're an existing customer, you may greet
   them by first name. If it says there's no caller ID, ask for the best number to reach
   them, then call find_customer again with that number as phone.
2. Find out what they need, in their own words. Ask one question at a time.
3. Ask how urgent it is: an emergency (water or gas leak, no power, flooding, unsafe),
   soon (in the next few days) or flexible.
4. Get their full name and the site address where the work is. Read the address back to
   confirm it.
5. If the number they're calling from isn't the best one to call back on, ask for the best
   number.
6. Call create_request with name, phone (only if they gave a different number), address,
   description and urgency. Then tell them what create_request's message says.
7. Ask if there's anything else, then say goodbye.

Privacy: never read out an address, job details or anything from the business's records.
Only use the first name that find_customer gives you.

Emergencies: if someone is in danger, tell them to call 111 first. For a gas smell, tell
them to leave the building and call their gas provider's emergency line.

If a tool says something isn't available or there's a system problem, don't mention
technical details. Take their name, number and what they need, and say the team will call
them back.
```

## 5. Tools

Both tools: **Webhook**, method **POST**, header `x-flowify-secret` = your
`ELEVENLABS_TOOL_SECRET` (stored as an ElevenLabs secret).

### find_customer

- **URL:** `https://flowify-web.onrender.com/elevenlabs/tools/find_customer`
- **Description:** Look up the caller in the business's records by phone number. Call at the start of every call.

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
| `name` | LLM (required) | Caller's full name |
| `phone` | LLM (optional) | Best callback number, only if different from the number they're calling from |
| `address` | LLM | Site address for the job, as confirmed with the caller |
| `description` | LLM (required) | What needs doing, in the caller's words, including any useful detail |
| `urgency` | LLM | One of: emergency, soon, flexible |

## 6. What happens when create_request runs

1. The service finds the caller in Jobber by phone, or creates a new client with their
   name, number and site address (source: "Flowify AI receptionist").
2. It creates a Jobber request, attached to the matching property if the address is on
   file, with a note holding everything the caller said.
3. It texts the owner (`clients.owner_mobile`). If Jobber was unreachable, the text says so
   and still carries all the details.
