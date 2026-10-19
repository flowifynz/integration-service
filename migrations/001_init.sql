-- 001_init: core tables for the Flowify service.
-- pg-boss creates and manages its own `pgboss` schema; nothing for it here.

-- One row per Flowify client (a trade business on Run or Receptionist).
CREATE TABLE clients (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL UNIQUE,              -- short handle, e.g. 'smith-plumbing'
  business_name        text NOT NULL,                     -- used to sign every text
  tier                 text NOT NULL CHECK (tier IN ('run', 'receptionist')),
  status               text NOT NULL DEFAULT 'onboarding'
                         CHECK (status IN ('onboarding', 'active', 'paused', 'cancelled')),

  -- The Twilio number callers dial (E.164). Identifies the client on every ElevenLabs call,
  -- and is the "call us on ..." number in every text.
  agent_phone          text UNIQUE,

  owner_name           text,
  owner_mobile         text,                              -- E.164; owner alerts + call summaries
  owner_email          text,
  timezone             text NOT NULL DEFAULT 'Pacific/Auckland',

  -- Booking settings (see project brief).
  booking_mode         text NOT NULL DEFAULT 'capture_request'
                         CHECK (booking_mode IN ('capture_request', 'quote_visit', 'job_visit')),
  times_offered        text NOT NULL DEFAULT 'am_pm' CHECK (times_offered IN ('am_pm', 'exact')),
  rescheduling_enabled boolean NOT NULL DEFAULT false,
  capacity_am          integer NOT NULL DEFAULT 1 CHECK (capacity_am >= 0),  -- visits per AM window
  capacity_pm          integer NOT NULL DEFAULT 1 CHECK (capacity_pm >= 0),  -- visits per PM window
  -- {"mon":["07:30","16:30"], ..., "sat":null}. Null day = closed.
  business_hours       jsonb NOT NULL DEFAULT
    '{"mon":["07:30","16:30"],"tue":["07:30","16:30"],"wed":["07:30","16:30"],"thu":["07:30","16:30"],"fri":["07:30","16:30"],"sat":null,"sun":null}',
  job_lengths          jsonb NOT NULL DEFAULT '{"quote_visit":60,"job_visit":120}',  -- minutes
  review_link          text,                              -- Google review URL for review requests

  -- SMS
  tnz_subaccount       text,                              -- TNZ SubAccount for per-client billing
  sms_mode             text NOT NULL DEFAULT 'test' CHECK (sms_mode IN ('test', 'live')),

  monthly_minutes_cap  integer,                           -- 100 for Run, 300 for Receptionist

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Jobber OAuth connection per client. Tokens are AES-256-GCM encrypted by the app
-- (TOKEN_ENCRYPTION_KEY); the database never sees them in plain text.
CREATE TABLE jobber_connections (
  client_id               uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  jobber_account_id       text NOT NULL,                  -- matches accountId on webhooks
  jobber_account_name     text,
  access_token_enc        text NOT NULL,
  refresh_token_enc       text NOT NULL,                  -- rotates on every refresh
  access_token_expires_at timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'connected'
                            CHECK (status IN ('connected', 'needs_reconnect', 'disconnected')),
  connected_at            timestamptz NOT NULL DEFAULT now(),
  refreshed_at            timestamptz,
  disconnected_at         timestamptz
);
-- A Jobber account can only be live for one client at a time.
CREATE UNIQUE INDEX jobber_connections_live_account
  ON jobber_connections (jobber_account_id) WHERE status <> 'disconnected';

-- Every outbound text. idempotency_key = '<client>:<jobber item>:<message type>' so an
-- at-least-once Jobber webhook can never send the same text twice.
CREATE TABLE messages (
  id               bigserial PRIMARY KEY,
  client_id        uuid NOT NULL REFERENCES clients(id),
  idempotency_key  text NOT NULL UNIQUE,
  kind             text NOT NULL,      -- booking_confirmation, visit_reminder, review_request, ...
  is_marketing     boolean NOT NULL DEFAULT false,  -- review requests: needs opt-out line (UEMA)
  to_phone         text NOT NULL,      -- E.164 when valid, raw input otherwise
  body             text NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'sending', 'sent', 'failed',
                                       'skipped_opt_out', 'skipped_invalid')),
  tnz_message_id   text,
  attempts         integer NOT NULL DEFAULT 0,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX messages_client_created ON messages (client_id, created_at DESC);
CREATE INDEX messages_stuck ON messages (status) WHERE status IN ('queued', 'sending', 'failed');

-- Raw Jobber webhooks, stored before acknowledging (must ack within 1 second).
CREATE TABLE webhook_events (
  id                bigserial PRIMARY KEY,
  client_id         uuid REFERENCES clients(id),         -- null if account not recognised
  jobber_account_id text NOT NULL,
  topic             text NOT NULL,                        -- e.g. VISIT_CREATE, APP_DISCONNECT
  item_id           text,
  occurred_at       timestamptz,
  dedupe_key        text NOT NULL UNIQUE,                 -- sha256(topic|accountId|itemId|occurredAt)
  payload           jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error             text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz
);
CREATE INDEX webhook_events_pending ON webhook_events (received_at) WHERE status = 'received';

-- One row per ElevenLabs call (from the post-call webhook).
CREATE TABLE calls (
  id                 bigserial PRIMARY KEY,
  client_id          uuid REFERENCES clients(id),
  conversation_id    text UNIQUE,                         -- ElevenLabs conversation ID
  caller_phone       text,
  started_at         timestamptz,
  duration_seconds   integer,
  outcome            text,     -- booked, rescheduled, request_logged, no_action, ...
  summary            text,
  jobber_request_id  text,
  jobber_visit_id    text,
  payload            jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_client_started ON calls (client_id, started_at DESC);

-- STOP opt-outs. client_id NULL = opted out of every Flowify client. Because TNZ sends
-- from a shared short code, a STOP we can't tie to one client must block all of them.
CREATE TABLE opt_outs (
  id          bigserial PRIMARY KEY,
  client_id   uuid REFERENCES clients(id),
  phone       text NOT NULL,                              -- E.164
  source      text NOT NULL DEFAULT 'sms_stop',           -- sms_stop, manual, agent
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (client_id, phone)
);
CREATE INDEX opt_outs_phone ON opt_outs (phone);
