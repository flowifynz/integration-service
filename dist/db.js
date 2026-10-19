// Postgres pool + transaction helper. One pool per process.
import pg from 'pg';
import { config } from "./config.js";
let pool;
export function db() {
    if (!pool) {
        // Render's internal connection string doesn't need SSL. If you ever connect over
        // the external URL (e.g. from your laptop), add ?sslmode=require to DATABASE_URL.
        pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
        pool.on('error', (err) => console.error('Postgres pool error', err));
    }
    return pool;
}
export async function withTransaction(fn) {
    const client = await db().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    }
    finally {
        client.release();
    }
}
export async function closeDb() {
    await pool?.end();
    pool = undefined;
}
export async function getClientById(id) {
    const { rows } = await db().query('SELECT * FROM clients WHERE id = $1', [id]);
    return rows[0] ?? null;
}
export async function getClientBySlug(slug) {
    const { rows } = await db().query('SELECT * FROM clients WHERE slug = $1', [slug]);
    return rows[0] ?? null;
}
//# sourceMappingURL=db.js.map