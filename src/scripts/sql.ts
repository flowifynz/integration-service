// Run one SQL statement against DATABASE_URL and print the result. Meant for Render's
// Shell tab on flowify-web, where the database is reachable without opening it to the internet:
//   node dist/scripts/sql.js "SELECT slug, business_name, status FROM clients"
// Locally: npm run sql -- "SELECT 1"

import { closeDb, db } from '../db.ts';

const statement = process.argv[2];
if (!statement) {
  console.error('Usage: node dist/scripts/sql.js "<SQL statement>"');
  process.exit(1);
}
try {
  const result = await db().query(statement);
  if (result.rows.length) console.table(result.rows);
  console.log(`${result.rowCount ?? 0} row(s)`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
