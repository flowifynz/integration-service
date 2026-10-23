-- 003: SMS cost tracking and allowances (pricing option A: included allowance + overage).

-- Filled in from TNZ's result webhook for each text.
ALTER TABLE messages
  ADD COLUMN department      text,           -- TNZ Department we tagged it with (bookings, owner-alerts, ...)
  ADD COLUMN price           numeric(10,4),  -- what TNZ charged Flowify (from webhook Price), NZD
  ADD COLUMN sms_parts       integer,        -- segments used (from webhook Detail "SMSParts:n")
  ADD COLUMN delivery_status text,           -- webhook Status, e.g. Success / Failed
  ADD COLUMN delivery_result text,           -- webhook Result, e.g. delivered / Destination is blacklisted
  ADD COLUMN result_at       timestamptz;

-- Per-client allowance. PLACEHOLDER defaults — change per client or per tier as pricing settles:
--   UPDATE clients SET sms_allowance_segments = 300, sms_overage_cents = 20 WHERE tier = 'run';
ALTER TABLE clients
  ADD COLUMN sms_allowance_segments integer,       -- included segments per month (null = unlimited)
  ADD COLUMN sms_overage_cents      numeric(6,2);  -- charged per segment over the allowance, NZD cents ex GST

UPDATE clients SET sms_allowance_segments = 300, sms_overage_cents = 20 WHERE tier = 'run';
UPDATE clients SET sms_allowance_segments = 600, sms_overage_cents = 20 WHERE tier = 'receptionist';

CREATE INDEX messages_sent_month ON messages (client_id, sent_at) WHERE status = 'sent';
