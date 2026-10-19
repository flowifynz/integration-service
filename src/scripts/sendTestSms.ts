// Send one test text through the real path (compose → opt-out → quiet hours → TNZ → messages log).
//   node dist/scripts/sendTestSms.js <client-slug> <mobile> ["optional message"]
// The client's sms_mode decides whether TNZ delivers it: 'test' = accepted but not
// delivered, 'live' = arrives on the phone. Quiet hours apply (8pm–8am NZ).

import { closeDb, getClientBySlug } from '../db.ts';
import { sendClientSms } from '../sms/outbound.ts';

const [slug, mobile, text] = process.argv.slice(2);
if (!slug || !mobile) {
  console.error('Usage: node dist/scripts/sendTestSms.js <client-slug> <mobile> ["message"]');
  process.exit(1);
}
const client = await getClientBySlug(slug);
if (!client) {
  console.error(`No client with slug "${slug}"`);
  process.exit(1);
}
console.log(`Sending in ${client.sms_mode.toUpperCase()} mode for ${client.business_name}...`);
try {
  const result = await sendClientSms({
    clientId: client.id,
    kind: 'booking_confirmation',
    toPhone: mobile,
    text: text ?? 'Test from Flowify: your booking is confirmed for Thu 8am–12pm.',
    idempotencyKey: `test:${client.id}:${Date.now()}`,
  });
  console.log(result);
} catch (err) {
  console.error((err as Error).message); // full TNZ response body is in the message
  process.exitCode = 1;
} finally {
  await closeDb();
}
