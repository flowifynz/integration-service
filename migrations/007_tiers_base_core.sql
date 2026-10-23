-- 007: plans are now Base and Core (backlog D11, 23 Oct 2026).
-- Every existing client is Jobber-connected, so all of them become 'core'. Booking is
-- now switched on per client with booking_mode / rescheduling_enabled, not by tier.

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_tier_check;
UPDATE clients SET tier = 'core' WHERE tier IN ('run', 'receptionist');
ALTER TABLE clients ADD CONSTRAINT clients_tier_check CHECK (tier IN ('base', 'core'));

COMMENT ON COLUMN clients.tier IS 'base = receptionist + missed-call text-back, no Jobber; core = base + Jobber';
COMMENT ON COLUMN clients.monthly_minutes_cap IS 'Receptionist minutes a month: 100 Base, 300 Core (defaults in src/onboarding/settings.ts)';
