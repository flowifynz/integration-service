-- 006: alerts go to Google Chat (text to ALERT_MOBILE becomes an optional extra).
-- Each channel is tracked separately so a retry never posts or texts twice.

ALTER TABLE admin_alerts
  ADD COLUMN detail            text,          -- count or short error, used to build the Chat message at send time
  ADD COLUMN chat_sent_at      timestamptz,
  ADD COLUMN chat_message_name text;         -- Google Chat message resource name (spaces/.../messages/...)
