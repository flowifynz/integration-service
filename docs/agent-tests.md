# Agent tests (ElevenLabs simulation tests)

Re-check every call type after a prompt change, without phoning and without texts. Each
row below becomes one test on the agent: **Agent → Tests → Create test → Simulation**
(ElevenLabs plays the caller from the instructions and grades the conversation against
the success criteria).

**Before you run them:**
- Set the test's dynamic variables:
  - `business_name` = Flowify Test Plumbing
  - `greeting` = Kia ora
  - `caller_id_available` = yes
  - `customer_name` = none

  The **Known caller** tests use different values, shown in the test.
- If the test screen offers **mock tool responses**, turn it on, so tests don't create real
  Jobber requests or texts. Mock create_request and take_message with
  `{"ok": true, "logged": true, "message": "Done. Tell them it's been passed to the team."}`.
  If there's no mocking, put flowify-test in TNZ Test mode first
  (`UPDATE clients SET sms_mode = 'test' ...`). Requests will still land in your Jobber
  test account; delete them afterwards.
- Run each critical test 3 to 5 times. These tests vary from run to run, and one pass
  proves little.

| # | Test | Caller instructions (simulated user) | Success criteria |
|---|---|---|---|
| 1 | New job, known caller | Vars: customer_name = Tom Jones. You're Tom Jones. You want a leaking outside tap fixed at 12 High Street, Birkenhead. Not urgent. The number you're calling from is fine. | Confirms "Tom Jones" once without asking for the name; asks urgency and address; asks once whether the calling number is best; calls create_request once with no phone; doesn't ask for the number again |
| 2 | New job, hidden number | Vars: caller_id_available = no. You're Aroha Smith, blocked drain at 4 Kowhai Road, Takapuna, need it in the next few days. When asked for a number first say "the one I'm calling from", then give 021 555 0199. | Explains the number is hidden and asks for digits; reads 021 555 0199 back; never invents a number; create_request phone = 0215550199 |
| 3 | Emergency | You smell gas in the kitchen and you're scared. | Tells them to leave the building and call the gas emergency line (and 111 if in danger) before anything else; urgency = emergency |
| 4 | Supplier wants a call back | You're Jeff from Plumright chasing an unpaid invoice. You'd like the owner to call you back on this number. | Doesn't describe how it sorted the call; asks if they want a call back; calls take_message with about = supplier; never calls create_request |
| 5 | Supplier will call back | You're Jeff from Plumright about an outstanding invoice. When asked anything more, say "it doesn't matter, I'll call back later". | Stops asking questions; doesn't ask for a number; calls take_message once with phone none and "no call back needed"; says it's let the team know; never promises a call back |
| 6 | Existing customer chasing a quote | Vars: customer_name = Tom Jones. You're Tom, you got a quote last week and want to know when someone will be in touch. | Treats it as a message, not a new job; take_message about = existing_customer; never reads out quote details |
| 7 | Sales call | You sell websites and want to talk to the owner about your services. Push once when told no. | Politely declines twice at most; takes no details; never calls create_request or take_message; ends the call |
| 8 | Wrong number | You're trying to book a haircut. | Says kindly it's Flowify Test Plumbing; no tools; ends the call |
| 9 | Caller challenges the agent | You want a new hot water cylinder quote. After it asks whether this number is best, say "why are you asking, you've got my number?" | Agrees briefly and carries on; doesn't over-explain; doesn't ask the same question again |
| 10 | Price question | You want to know how much a new toilet costs before anything else. | Doesn't give a price or a range; offers to take the job request instead |
| 11 | Tool failure | Mock create_request with `{"ok": false, "error": "jobber_down", "message": "There's a system problem."}`. Ordinary leaking-tap job. | Calls create_request once only; doesn't retry; doesn't mention technical details; says the team has the details and will be in touch |

Also worth a **Tool call** test (Tests → Tool call) for #1: expected tool `create_request`
with parameters name, address, description, urgency, and no `phone`.

When a real call goes wrong, add it as a test straight from the conversation: open it in
ElevenLabs and use **Create test**, so the same mistake can't come back unnoticed.
