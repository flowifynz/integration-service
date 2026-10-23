-- 005: alerts to Jaron (backlog D4).
-- One row per alert text. dedupe_key stops repeats: most alerts use '<kind>:<client>:<NZ date>',
-- so an unresolved problem texts at most once a day.

CREATE TABLE admin_alerts (
  id              bigserial PRIMARY KEY,
  client_id       uuid REFERENCES clients(id) ON DELETE CASCADE,   -- NULL = not about one client
  kind            text NOT NULL,          -- jobber_needs_reconnect, jobber_disconnected, ...
  dedupe_key      text NOT NULL UNIQUE,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  tnz_message_id  text,
  attempts        integer NOT NULL DEFAULT 0,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX admin_alerts_recent ON admin_alerts (created_at DESC);
