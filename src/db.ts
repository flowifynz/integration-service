// Postgres pool + transaction helper. One pool per process.

import pg from 'pg';
import { config } from './config.ts';

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    // Render's internal connection string doesn't need SSL. If you ever connect over
    // the external URL (e.g. from your laptop), add ?sslmode=require to DATABASE_URL.
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    pool.on('error', (err) => console.error('Postgres pool error', err));
  }
  return pool;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

// ---- Shared row types --------------------------------------------------------

export interface ClientRow {
  id: string;
  slug: string;
  business_name: string;
  tier: 'base' | 'core';
  status: 'onboarding' | 'active' | 'paused' | 'cancelled';
  agent_phone: string | null;
  owner_name: string | null;
  owner_mobile: string | null;
  owner_email: string | null;
  timezone: string;
  booking_mode: 'capture_request' | 'quote_visit' | 'job_visit';
  times_offered: 'am_pm' | 'exact';
  rescheduling_enabled: boolean;
  capacity_am: number;
  capacity_pm: number;
  business_hours: Record<string, [string, string] | null>;
  job_lengths: Record<string, number>;
  review_link: string | null;
  tnz_subaccount: string | null;
  sms_mode: 'test' | 'live';
  monthly_minutes_cap: number | null;
  elevenlabs_agent_id: string | null;
  sms_allowance_segments: number | null;
  sms_overage_cents: string | null; // numeric comes back from pg as a string
  automation: unknown; // jsonb; read via automationSettings()
}

export async function getClientById(id: string): Promise<ClientRow | null> {
  const { rows } = await db().query<ClientRow>('SELECT * FROM clients WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getClientBySlug(slug: string): Promise<ClientRow | null> {
  const { rows } = await db().query<ClientRow>('SELECT * FROM clients WHERE slug = $1', [slug]);
  return rows[0] ?? null;
}
