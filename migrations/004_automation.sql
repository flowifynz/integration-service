-- 004: Jobber-driven texts (build step 4).

-- Per-client automation settings. Empty = all defaults (see src/automation/settings.ts).
-- Override one setting, e.g.:
--   UPDATE clients SET automation = automation || '{"quoteFollowUpDays": 5}' WHERE slug = 'smith-plumbing';
ALTER TABLE clients ADD COLUMN automation jsonb NOT NULL DEFAULT '{}';

-- Which Jobber item a text was about, and the version of it (e.g. a visit's start time),
-- so a moved visit gets a "booking updated" text instead of a duplicate confirmation.
ALTER TABLE messages
  ADD COLUMN jobber_item_id text,
  ADD COLUMN item_ref       text;
CREATE INDEX messages_jobber_item ON messages (client_id, jobber_item_id);
