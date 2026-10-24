// Checks the internal module's setup (website agent → GHL → TNZ → Google Chat).
// Read-only by default: it never creates a contact or an appointment.
//
//   node dist/scripts/internalCheck.js                  settings + free slots from GHL (next 7 days)
//   node dist/scripts/internalCheck.js --chat           also post a test message to INTERNAL_CHAT_WEBHOOK_URL
//   node dist/scripts/internalCheck.js --sms 021...     also send a sample confirmation text
//                                                       (INTERNAL_SMS_MODE decides Test or Live)
//
// Prints whether each secret is set, never its value.

import { postToGoogleChat } from '../alerts/googleChat.ts';
import { localDate } from '../automation/texts.ts';
import { config } from '../config.ts';
import { closeDb } from '../db.ts';
import { toE164 } from '../phone.ts';
import { sendTnzSms } from '../sms/tnz.ts';
import { smsSegments } from '../sms/compose.ts';
import { DISCOVERY_CALL, bookableSlots, confirmationText, slotQueryRange, slotsFromGhl, spokenSlot, suggestSlots } from '../internal/discoveryCall.ts';
import { getFreeSlots, GhlError } from '../internal/ghl.ts';

const args = process.argv.slice(2);
const set = (name: string) => (process.env[name] ? 'set' : 'MISSING');

console.log('Internal module settings');
console.log(`  INTERNAL_ENABLED          ${config.internal.enabled ? 'true (tools on)' : 'not true (tools refuse politely)'}`);
console.log(`  INTERNAL_TOOL_SECRET      ${set('INTERNAL_TOOL_SECRET')}`);
console.log(`  INTERNAL_AGENT_IDS        ${config.internal.agentIds.length ? config.internal.agentIds.join(', ') : '(any agent with the secret)'}`);
console.log(`  INTERNAL_CHAT_WEBHOOK_URL ${set('INTERNAL_CHAT_WEBHOOK_URL')}`);
console.log(`  INTERNAL_SMS_MODE         ${config.internal.smsMode}`);
console.log(`  INTERNAL_TNZ_SUBACCOUNT   ${config.internal.tnzSubaccount}`);
console.log(`  GHL_PRIVATE_TOKEN         ${set('GHL_PRIVATE_TOKEN')}`);
console.log(`  GHL_LOCATION_ID           ${set('GHL_LOCATION_ID')}`);
console.log(`  GHL_CALENDAR_ID           ${set('GHL_CALENDAR_ID')}`);
console.log(`  GHL_API_VERSION           ${config.ghl.apiVersion}`);

let failed = false;
const now = new Date();
let sampleStart = new Date(now.getTime() + 2 * 86_400_000);

try {
  const res = await getFreeSlots(slotQueryRange(localDate(now, DISCOVERY_CALL.timeZone), 7), DISCOVERY_CALL.timeZone);
  const raw = slotsFromGhl(res);
  const ok = bookableSlots(raw, now);
  console.log(`\nGHL free slots, next 7 days: ${raw.length} from GHL, ${ok.length} inside Flowify's bookable hours`);
  const { picks } = suggestSlots(ok, 'any');
  for (const d of picks) console.log(`  ${spokenSlot(d)}  (${d.toISOString()})`);
  if (picks[0]) sampleStart = picks[0];
  if (!raw.length) console.log('  GHL returned no slots. Check the calendar ID and its availability settings.');
} catch (err) {
  failed = true;
  console.error(`\nGHL check FAILED: ${(err as Error).message}`);
  if (err instanceof GhlError && (err.status === 401 || err.status === 403)) {
    console.error('  Token rejected or missing a scope. Needs: calendars.readonly, calendars/events.write, contacts.write.');
  }
  if (err instanceof GhlError && err.status === 400 && /version/i.test(err.body)) {
    console.error('  GHL rejected the Version header. Try setting GHL_API_VERSION=2021-04-15 in Render.');
  }
}

const sample = confirmationText('Sam Sample', sampleStart);
const seg = smsSegments(sample);
console.log(`\nSample confirmation text (${seg.encoding}, ${seg.segments} segment${seg.segments === 1 ? '' : 's'}):\n${sample}`);

if (args.includes('--chat')) {
  const url = config.internal.chatWebhookUrl;
  if (!url) {
    failed = true;
    console.error('\n--chat: INTERNAL_CHAT_WEBHOOK_URL is not set');
  } else {
    try {
      await postToGoogleChat(url, '✅ *Test from the Flowify service* - website booking notices reach this space.', 'internal-check');
      console.log('\nGoogle Chat: test message posted');
    } catch (err) {
      failed = true;
      console.error(`\nGoogle Chat FAILED: ${(err as Error).message}`);
    }
  }
}

const smsIdx = args.indexOf('--sms');
if (smsIdx >= 0) {
  const to = toE164(args[smsIdx + 1]);
  if (!to) {
    failed = true;
    console.error('\n--sms: give a valid NZ mobile, e.g. --sms 021 123 4567');
  } else {
    try {
      const { messageId } = await sendTnzSms({
        to,
        message: sample,
        subAccount: config.internal.tnzSubaccount,
        department: 'website-bookings',
        messageId: `flowifyintcheck${Date.now()}`,
        reference: 'flowify-internal check',
        mode: config.internal.smsMode,
      });
      console.log(`\nTNZ: accepted in ${config.internal.smsMode} mode (MessageID ${messageId})`);
    } catch (err) {
      failed = true;
      console.error(`\nTNZ FAILED: ${(err as Error).message}`);
    }
  }
}

await closeDb();
process.exitCode = failed ? 1 : 0;
