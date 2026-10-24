-- 009: Flowify's own automations (the "internal" module, src/internal/).
-- Kept in their own schema so nothing here is ever mixed up with client data:
-- no row in these tables belongs to a Flowify client, and no client query touches them.
--
-- First feature: the website agent ("book a discovery call") books into Flowify's
-- GoHighLevel calendar and texts a confirmation through TNZ.

CREATE SCHEMA IF NOT EXISTS internal;

-- One row per discovery-call booking attempt from the website agent.
-- booking_key = '<email>|<slot start ISO>' so an ElevenLabs retry of the same tool call
-- never creates a second appointment.
CREATE TABLE internal.bookings (
  id                  bigserial PRIMARY KEY,
  booking_key         text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'booked', 'failed')),
  conversation_id     text,                     -- ElevenLabs conversation ID
  agent_id            text,                     -- ElevenLabs agent ID
  caller_name         text NOT NULL,
  business_name       text,
  phone               text,                     -- E.164 when valid, as given otherwise
  email               text NOT NULL,
  summary             text,                     -- one line on what they're after (from the agent)
  slot_start          timestamptz NOT NULL,
  slot_end            timestamptz NOT NULL,
  ghl_contact_id      text,
  ghl_appointment_id  text,
  attempts            integer NOT NULL DEFAULT 0,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX internal_bookings_created ON internal.bookings (created_at DESC);

-- Every text Flowify sends about its own business (not a client's). Same shape and
-- rules as public.messages: idempotency key = sent at most once.
CREATE TABLE internal.messages (
  id               bigserial PRIMARY KEY,
  idempotency_key  text NOT NULL UNIQUE,      -- e.g. 'booking:42:confirmation'
  kind             text NOT NULL,              -- discovery_confirmation, ...
  booking_id       bigint REFERENCES internal.bookings(id),
  to_phone         text NOT NULL,
  body             text NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'sending', 'sent', 'failed',
                                       'skipped_opt_out', 'skipped_invalid')),
  tnz_message_id   text,
  attempts         integer NOT NULL DEFAULT 0,
  error            text,
  price            numeric(10,4),
  sms_parts        integer,
  delivery_status  text,
  delivery_result  text,
  result_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX internal_messages_phone_created ON internal.messages (to_phone, created_at DESC);

-- STOPs replying to Flowify's own texts. Separate from public.opt_outs so a prospect
-- opting out of Flowify's texts doesn't block a client's customer texts (and the other
-- way round, a global client-side STOP — public.opt_outs with client_id NULL — is
-- still honoured by internal texts).
CREATE TABLE internal.opt_outs (
  phone       text PRIMARY KEY,               -- E.164
  source      text NOT NULL DEFAULT 'sms_stop',
  created_at  timestamptz NOT NULL DEFAULT now()
);
