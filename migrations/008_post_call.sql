-- 008: post-call processing (backlog D3). The post-call webhook fills these in from
-- ElevenLabs' payload; the worker decides texts and the Jobber safety net.

ALTER TABLE calls
  ADD COLUMN agent_id            text,
  ADD COLUMN called_number       text,          -- the Twilio number dialled (E.164)
  ADD COLUMN caller_name         text,
  ADD COLUMN callback_phone      text,          -- number the caller said, if different from caller ID
  ADD COLUMN category            text,          -- new_job, other, no_conversation, unknown
  ADD COLUMN termination_reason  text,
  ADD COLUMN call_successful     text,          -- ElevenLabs analysis: success / failure / unknown
  ADD COLUMN details             jsonb,         -- data collection results + create_request arguments
  ADD COLUMN request_source      text CHECK (request_source IN ('tool', 'after_call')),
  ADD COLUMN needs_review        text,          -- why a human should look at this call (weekly check)
  ADD COLUMN processing_status   text NOT NULL DEFAULT 'none'
                                   CHECK (processing_status IN ('none', 'pending', 'done', 'no_client', 'error')),
  ADD COLUMN processed_at        timestamptz,
  ADD COLUMN processing_error    text;

-- Rows created by create_request before this migration.
UPDATE calls SET request_source = 'tool' WHERE jobber_request_id IS NOT NULL AND request_source IS NULL;

CREATE INDEX calls_pending ON calls (processing_status) WHERE processing_status IN ('pending', 'error');
