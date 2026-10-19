// Prints a 7-day Jobber connect link for a client.
//   npm run connect-link -- smith-plumbing
// Needs DATABASE_URL, APP_SECRET and PUBLIC_BASE_URL (same values as production).

import { closeDb, getClientBySlug } from '../db.ts';
import { makeConnectLink } from '../routes/jobberOAuth.ts';

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: npm run connect-link -- <client-slug>');
  process.exit(1);
}
const client = await getClientBySlug(slug);
if (!client) {
  console.error(`No client with slug "${slug}"`);
  process.exit(1);
}
console.log(`Connect link for ${client.business_name} (valid 7 days):\n${makeConnectLink(client.id)}`);
await closeDb();
