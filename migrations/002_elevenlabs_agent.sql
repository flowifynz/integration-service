-- 002: identify a client by its ElevenLabs agent as well as by the dialled number.
-- Browser tests in ElevenLabs have no dialled number, and it's a useful fallback anyway.
ALTER TABLE clients ADD COLUMN elevenlabs_agent_id text UNIQUE;

-- Default each client's TNZ SubAccount to its slug so no text is ever untagged.
UPDATE clients SET tnz_subaccount = slug WHERE tnz_subaccount IS NULL;
