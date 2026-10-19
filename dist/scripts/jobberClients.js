// Build step 1 "done" check: pull a connected account's client list through the stored,
// encrypted, auto-refreshing connection.
//   npm run jobber:clients -- smith-plumbing [search term]
import { closeDb, getClientBySlug } from "../db.js";
import { CLIENTS_QUERY, jobberQuery } from "../jobber/graphql.js";
const [slug, searchTerm] = process.argv.slice(2);
if (!slug) {
    console.error('Usage: npm run jobber:clients -- <client-slug> [search term]');
    process.exit(1);
}
const client = await getClientBySlug(slug);
if (!client) {
    console.error(`No client with slug "${slug}"`);
    process.exit(1);
}
const data = await jobberQuery(client.id, CLIENTS_QUERY, { first: 20, searchTerm: searchTerm ?? null }, { timeoutMs: 15_000 });
for (const c of data.clients.nodes) {
    console.log(`${c.id}  ${c.name}  ${c.phones.map((p) => p.number).join(', ')}`);
}
console.log(`${data.clients.nodes.length} clients`);
await closeDb();
//# sourceMappingURL=jobberClients.js.map