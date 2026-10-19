// Minimal forward-only migration runner. Runs every migrations/NNN_name.sql file not yet
// recorded in schema_migrations, in filename order, each in its own transaction.
// Runs as Render's preDeployCommand, so a failed migration blocks the deploy.
//
// Rule: never edit a migration that has run in production — add a new file instead.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { closeDb, db } from './db.ts';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const LOCK_ID = 727274; // arbitrary; stops two deploys migrating at once

async function migrate(): Promise<void> {
  const client = await db().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`Applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    console.log('Migrations up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
    await closeDb();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
