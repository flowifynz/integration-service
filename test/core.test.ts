// Unit tests for the dependency-free core. Run: npm test

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { decrypt, encrypt, safeEqual, signToken, verifyToken } from '../src/crypto.ts';
import { verifyElevenLabsSignature } from '../src/elevenlabsSignature.ts';
import { addressMatches, confirmName, looksMadeUp, normaliseUrgency, ownerAlertText, requestNote, requestTitle, splitName } from '../src/jobber/callerText.ts';
import { accessTokenExpiry } from '../src/jobber/oauth.ts';
import { parseJobberWebhook, verifyJobberSignature, webhookDedupeKey } from '../src/jobber/webhook.ts';
import { composeSms, departmentFor, isStopRequest, smsSegments } from '../src/sms/compose.ts';
import { quietHoursDeferral } from '../src/sms/quietHours.ts';
import { extractInbound, isBlacklisted, isReply, isSendResult } from '../src/sms/inbound.ts';
import { billUsage, reportMonth } from '../src/sms/usage.ts';
import { buildTnzPayload, messageRowIdFromTnz, tnzMessageId } from '../src/sms/tnz.ts';

describe('token encryption', () => {
  const key = randomBytes(32);

  it('round-trips', () => {
    const enc = encrypt('jobber-refresh-token-abc', key);
    assert.match(enc, /^v1\./);
    assert.notEqual(enc, encrypt('jobber-refresh-token-abc', key), 'random IV each time');
    assert.equal(decrypt(enc, key), 'jobber-refresh-token-abc');
  });

  it('rejects tampering and wrong keys', () => {
    const enc = encrypt('secret', key);
    const parts = enc.split('.');
    parts[3] = Buffer.from('xxxxxx').toString('base64url');
    assert.throws(() => decrypt(parts.join('.'), key));
    assert.throws(() => decrypt(enc, randomBytes(32)));
  });
});

describe('signed tokens', () => {
  const secret = 'test-secret';

  it('verifies data with matching purpose', () => {
    const t = signToken({ clientId: 'c1' }, 60, 'connect', secret);
    assert.deepEqual(verifyToken(t, 'connect', secret), { clientId: 'c1' });
  });

  it('rejects wrong purpose, wrong secret, expiry and tampering', () => {
    const t = signToken({ clientId: 'c1' }, 60, 'connect', secret);
    assert.equal(verifyToken(t, 'state', secret), null);
    assert.equal(verifyToken(t, 'connect', 'other'), null);
    assert.equal(verifyToken(signToken({ clientId: 'c1' }, -1, 'connect', secret), 'connect', secret), null);
    const [, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ p: 'connect', exp: 9e9, d: { clientId: 'evil' } })).toString('base64url');
    assert.equal(verifyToken(`${forged}.${sig}`, 'connect', secret), null);
    assert.equal(verifyToken(undefined, 'connect', secret), null);
  });

  it('safeEqual handles length mismatch and missing values', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual(undefined, 'abc'), false);
  });
});

describe('Jobber webhooks', () => {
  const secret = 'jobber-client-secret';
  const raw = Buffer.from(
    JSON.stringify({ data: { webHookEvent: { topic: 'VISIT_CREATE', appId: 'a', accountId: 'acc1', itemId: 'v1', occurredAt: '2026-10-07T01:00:00Z' } } }),
  );
  const goodSig = createHmac('sha256', secret).update(raw).digest('base64');

  it('verifies the HMAC over the raw body', () => {
    assert.equal(verifyJobberSignature(raw, goodSig, secret), true);
    assert.equal(verifyJobberSignature(raw, goodSig, 'wrong'), false);
    assert.equal(verifyJobberSignature(Buffer.from(raw.toString() + ' '), goodSig, secret), false);
    assert.equal(verifyJobberSignature(raw, undefined, secret), false);
  });

  it('parses and dedupes', () => {
    const evt = parseJobberWebhook(raw);
    assert.equal(evt?.topic, 'VISIT_CREATE');
    assert.equal(webhookDedupeKey(evt!), webhookDedupeKey(parseJobberWebhook(Buffer.from(raw))!));
    assert.notEqual(webhookDedupeKey(evt!), webhookDedupeKey({ ...evt!, topic: 'VISIT_UPDATE' }));
    assert.equal(parseJobberWebhook(Buffer.from('not json')), null);
  });
});

describe('ElevenLabs post-call signature', () => {
  const secret = 'el-secret';
  const raw = Buffer.from('{"type":"post_call_transcription"}');
  const t = 1_800_000_000;
  const header = `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

  it('accepts a valid, recent signature', () => {
    assert.equal(verifyElevenLabsSignature(raw, header, secret, t + 60), true);
  });
  it('rejects old timestamps, bad secrets and missing headers', () => {
    assert.equal(verifyElevenLabsSignature(raw, header, secret, t + 3600), false);
    assert.equal(verifyElevenLabsSignature(raw, header, 'nope', t), false);
    assert.equal(verifyElevenLabsSignature(raw, undefined, secret, t), false);
  });
});

describe('quiet hours (Pacific/Auckland)', () => {
  // October 2026 is NZDT, UTC+13.
  const nz = (local: string) => new Date(`${local}+13:00`);

  it('allows 8am to 7:59pm', () => {
    assert.equal(quietHoursDeferral(nz('2026-10-08T08:00:00')), null);
    assert.equal(quietHoursDeferral(nz('2026-10-08T13:30:00')), null);
    assert.equal(quietHoursDeferral(nz('2026-10-08T19:59:00')), null);
  });

  it('defers evenings to just after 8am next day', () => {
    const until = quietHoursDeferral(nz('2026-10-08T21:15:00'))!;
    assert.equal(until.toISOString(), nz('2026-10-09T08:01:00').toISOString());
  });

  it('defers early mornings to just after 8am same day', () => {
    const until = quietHoursDeferral(nz('2026-10-08T06:30:00'))!;
    assert.equal(until.toISOString(), nz('2026-10-08T08:01:00').toISOString());
  });
});

describe('SMS composition', () => {
  const client = { business_name: 'Smith Plumbing', agent_phone_display: '09 555 1234' };

  it('signs booking texts and says how to change them', () => {
    const s = composeSms('visit_reminder', 'Hi Sam, reminder: we visit tomorrow 8am–12pm.', client);
    assert.match(s, /To change your booking, call us on 09 555 1234\./);
    assert.match(s, /- Smith Plumbing$/);
    assert.doesNotMatch(s, /STOP/);
  });

  it('adds an opt-out to review requests (marketing)', () => {
    assert.match(composeSms('review_request', 'Thanks! Leave us a review: https://g.page/x', client), /Reply STOP to opt out\.$/);
  });

  it('leaves owner alerts unsigned', () => {
    assert.equal(composeSms('owner_alert', 'New booking: Sam, Fri AM', client), 'New booking: Sam, Fri AM');
  });

  it('recognises STOP replies', () => {
    for (const s of ['STOP', 'stop', ' Stop. ', 'unsubscribe', 'opt out']) assert.equal(isStopRequest(s), true, s);
    for (const s of ['stop by tomorrow?', 'yes', '', null]) assert.equal(isStopRequest(s), false, String(s));
  });
});

describe('misc', () => {
  it('reads expiry from a JWT when expires_in is missing', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString('base64url');
    assert.equal(accessTokenExpiry(`h.${payload}.s`).getTime(), 1_800_000_000_000);
    assert.equal(accessTokenExpiry('opaque', 3600, 0).getTime(), 3_600_000);
  });

  it('builds a TNZ v3.00 payload (top-level fields, Test mode, sub-account, our MessageID)', () => {
    const p = buildTnzPayload(
      { to: '+64211234567', message: 'hi', subAccount: 'smith', department: 'bookings', messageId: tnzMessageId(42, 1), reference: 'smith booking_confirmation', mode: 'Test' },
      'https://x.test/tnz/inbound?key=k',
    );
    assert.equal(p.Destination, '+64211234567');
    assert.equal(p.Message, 'hi');
    assert.equal(p.MessageID, 'flowify42a1');
    assert.equal(p.Mode, 'Test');
    assert.equal(p.SubAccount, 'smith');
    assert.equal(p.Department, 'bookings');
    assert.equal(p.NotificationType, 'Webhook');
    assert.equal(p.WebhookCallbackFormat, 'JSON');
    const live = buildTnzPayload({ to: '+64', message: '', subAccount: null, department: 'owner-alerts', messageId: 'flowify1a1', reference: 'r', mode: 'Live' }, 'u');
    assert.equal('Mode' in live, false);
    assert.equal('SubAccount' in live, false);
  });

  it('TNZ MessageIDs are alphanumeric, <= 40 chars, and map back to the row', () => {
    const id = tnzMessageId('9007199254740991', 12);
    assert.match(id, /^[A-Za-z0-9]{1,40}$/);
    assert.equal(messageRowIdFromTnz(id), '9007199254740991');
    assert.equal(messageRowIdFromTnz('1000000a-f002-4007-b00a-d00000000002'), null);
    assert.equal(messageRowIdFromTnz(undefined), null);
  });

  it('parses the real TNZ webhook field set', () => {
    const f = extractInbound({
      Version: 'v3.00', Sender: 'jaron@flowify.nz', APIKey: 'x', Type: 'SMSReply', Destination: '+64211234567',
      ReceivedID: 'r1', MessageID: 'flowify7a1', SubAccount: 'smith', Status: 'RECEIVED', Result: 'Success', Message: 'Stop', Detail: '',
    });
    assert.deepEqual(f.phoneCandidates, ['jaron@flowify.nz', '+64211234567']);
    assert.deepEqual(f.textCandidates, ['Stop']);
    assert.equal(f.messageId, 'flowify7a1');
    assert.equal(f.type, 'SMSReply');
    assert.equal(f.receivedId, 'r1');
    assert.equal(extractInbound({ Status: 'Delivered', MessageID: 'flowify7a1' }).textCandidates.length, 0);
  });
});

describe('caller text helpers (create_request)', () => {
  it('splits names, with placeholders Jobber accepts', () => {
    assert.deepEqual(splitName('Sam Smith'), { firstName: 'Sam', lastName: 'Smith' });
    assert.deepEqual(splitName('  Mary Ann  van der Berg '), { firstName: 'Mary', lastName: 'Ann van der Berg' });
    assert.deepEqual(splitName('Cher'), { firstName: 'Cher', lastName: '(surname not given)' });
    assert.deepEqual(splitName(''), { firstName: 'Unknown', lastName: 'Caller' });
  });

  it('matches spoken addresses to properties on file', () => {
    assert.equal(addressMatches('12 Smith St, Takapuna', '12 Smith Street'), true);
    assert.equal(addressMatches('12 smith street takapuna auckland', '12 Smith St'), true);
    assert.equal(addressMatches('14 Smith Street', '12 Smith Street'), false);
    assert.equal(addressMatches('12 Smith Street', null), false);
    assert.equal(addressMatches('12', '12'), false); // too short to trust
  });

  it('normalises urgency and builds titles', () => {
    assert.equal(normaliseUrgency('Emergency'), 'emergency');
    assert.equal(normaliseUrgency('urgent'), 'emergency');
    assert.equal(normaliseUrgency('soon'), 'soon');
    assert.equal(normaliseUrgency(undefined), 'flexible');
    assert.equal(requestTitle('Blocked drain', 'emergency'), 'URGENT: Blocked drain');
    assert.equal(requestTitle('x'.repeat(200), 'soon').length, 78);
    assert.equal(requestTitle('', 'flexible'), 'Phone enquiry');
  });

  it('writes a note and owner alert with everything the caller said', () => {
    const note = requestNote({ callerName: 'Sam Smith', callbackPhone: '021 467 770', phoneSource: 'caller_id', address: '12 Smith St', description: 'Leaking tap', urgency: 'soon', addressOnFile: false });
    assert.match(note, /Caller: Sam Smith/);
    assert.match(note, /not yet a property/);
    assert.match(note, /Leaking tap$/);
    const alert = ownerAlertText({ callerName: 'Sam', callbackPhone: '021 467 770', phoneSource: 'spoken_no_caller_id', address: null, description: 'Leak', urgency: 'emergency', loggedInJobber: false });
    assert.match(alert, /^URGENT new request from Sam \(021 467 770\)/);
    assert.match(alert, /NOT saved in Jobber/);
    assert.match(alert, /caller ID hidden: not verified/);
    assert.match(note, /Callback: 021 467 770 \(from caller ID\)/);
  });
});

describe('SMS cost tracking (pricing option A)', () => {
  it('reads price, segments and type from a TNZ result webhook', () => {
    const f = extractInbound({ Type: 'SMS', MessageID: 'flowify9a1', Status: 'Success', Result: 'delivered', Price: '0.115', Detail: 'SMSParts:2' });
    assert.equal(isSendResult(f), true);
    assert.equal(isReply(f), false);
    assert.equal(f.price, 0.115);
    assert.equal(f.smsParts, 2);
    assert.equal(isBlacklisted(f), false);
    const reply = extractInbound({ Type: 'SMSReply', Message: 'STOP', Price: null });
    assert.equal(isReply(reply), true);
    assert.equal(reply.price, null);
    assert.equal(isBlacklisted(extractInbound({ Type: 'SMS', Status: 'Failed', Result: 'Destination is blacklisted' })), true);
  });

  it('tags departments, with owner alerts kept separate', () => {
    assert.equal(departmentFor('visit_reminder'), 'bookings');
    assert.equal(departmentFor('review_request'), 'reviews');
    assert.equal(departmentFor('owner_alert'), 'owner-alerts');
  });

  it('counts segments, flagging macrons and emoji', () => {
    assert.deepEqual(smsSegments('a'.repeat(160)), { encoding: 'GSM-7', segments: 1 });
    assert.deepEqual(smsSegments('a'.repeat(161)), { encoding: 'GSM-7', segments: 2 });
    assert.deepEqual(smsSegments('Kia ora, ' + 'a'.repeat(100)), { encoding: 'GSM-7', segments: 1 });
    assert.deepEqual(smsSegments('Kia ora Māori ' + 'a'.repeat(100)), { encoding: 'UCS-2', segments: 2 });
    assert.equal(smsSegments('{}').segments, 1); // extension chars count double but still fit
  });

  it('bills overage against the allowance', () => {
    assert.deepEqual(billUsage({ billableSegments: 250, allowance: 300, overageCents: 20 }), { overageSegments: 0, overageCharge: 0, allowanceUsed: 250 / 300 });
    assert.deepEqual(billUsage({ billableSegments: 347, allowance: 300, overageCents: 20 }), { overageSegments: 47, overageCharge: 9.4, allowanceUsed: 347 / 300 });
    assert.equal(billUsage({ billableSegments: 999, allowance: null, overageCents: 20 }).overageCharge, 0);
  });

  it('defaults the report to last month in NZ time', () => {
    assert.equal(reportMonth(undefined, new Date('2026-11-05T00:00:00Z')), '2026-10');
    assert.equal(reportMonth(undefined, new Date('2026-01-10T00:00:00Z')), '2025-12');
    assert.equal(reportMonth(undefined, new Date('2026-10-31T12:00:00Z')), '2026-10'); // already 1 Nov in NZ
    assert.equal(reportMonth('2026-07'), '2026-07');
    assert.throws(() => reportMonth('July'));
  });
});

describe('confirmName', () => {
  const base = { firstName: 'Tom', lastName: 'Jones', name: 'Tom Jones', companyName: null, isCompany: false };
  it('uses the person, adding the company for company clients', () => {
    assert.equal(confirmName(base), 'Tom Jones');
    assert.equal(confirmName({ ...base, name: 'Apex Building', companyName: 'Apex Building', isCompany: true }), 'Tom Jones from Apex Building');
    assert.equal(confirmName({ ...base, firstName: '', lastName: '', name: 'Apex Building', companyName: 'Apex Building', isCompany: true }), 'Apex Building');
  });
});

describe('looksMadeUp (invented phone numbers)', () => {
  it('flags placeholder-looking numbers', () => {
    assert.equal(looksMadeUp('022 123 4567'), true);
    assert.equal(looksMadeUp('021 000 0000'), true);
    assert.equal(looksMadeUp('027 987 6543'), true);
  });
  it('accepts real-looking numbers', () => {
    assert.equal(looksMadeUp('021 467 770'), false);
    assert.equal(looksMadeUp('09 873 6617'), false);
    assert.equal(looksMadeUp('022 418 3390'), false);
  });
});

// ---- Build step 4: Jobber-driven texts ------------------------------------------------
import { automationSettings, DEFAULT_AUTOMATION } from '../src/automation/settings.ts';
import {
  bookingConfirmationText,
  followUpTimes,
  hiName,
  invoiceFollowUpText,
  pickMobile,
  quoteFollowUpText,
  reminderText,
  reviewRequestText,
  visitConfirmationDecision,
  visitWhen,
  zonedMidnightIso,
} from '../src/automation/texts.ts';

describe('automation settings', () => {
  it('merges valid overrides over defaults and ignores junk', () => {
    assert.deepEqual(automationSettings({}), DEFAULT_AUTOMATION);
    const s = automationSettings({ quoteFollowUpDays: 5, reviewRequests: false, invoiceFollowUpDays: [2], reminders: 'yes', confirmWithinDays: -1 });
    assert.equal(s.quoteFollowUpDays, 5);
    assert.equal(s.reviewRequests, false);
    assert.deepEqual(s.invoiceFollowUpDays, [2]);
    assert.equal(s.reminders, true); // 'yes' ignored
    assert.equal(s.confirmWithinDays, 60); // negative ignored
    assert.deepEqual(automationSettings(null), DEFAULT_AUTOMATION);
  });
});

describe('visit times (Pacific/Auckland)', () => {
  const tz = 'Pacific/Auckland';
  it('formats day and time windows in NZ time with a plain hyphen', () => {
    // 2026-10-29T19:00Z = Fri 30 Oct 8am NZDT
    assert.equal(visitWhen('2026-10-29T19:00:00Z', '2026-10-29T21:30:00Z', false, tz), 'Fri 30 Oct, 8am-10:30am');
    assert.equal(visitWhen('2026-10-29T19:00:00Z', null, false, tz), 'Fri 30 Oct, 8am');
    assert.equal(visitWhen('2026-10-29T19:00:00Z', '2026-10-30T04:00:00Z', true, tz), 'Fri 30 Oct');
    assert.equal(visitWhen('2026-10-30T00:00:00Z', '2026-10-30T01:00:00Z', false, tz), 'Fri 30 Oct, 1pm-2pm');
  });
  it('finds NZ midnight in summer, winter and across DST', () => {
    assert.equal(zonedMidnightIso('2026-10-24', tz), '2026-10-23T11:00:00.000Z'); // NZDT +13
    assert.equal(zonedMidnightIso('2026-07-01', tz), '2026-06-30T12:00:00.000Z'); // NZST +12
    assert.equal(zonedMidnightIso('2026-09-27', tz), '2026-09-26T12:00:00.000Z'); // DST starts 2am that day
  });
});

describe('visit confirmation decisions', () => {
  const now = new Date('2026-10-23T03:00:00Z');
  const v = { startAt: '2026-10-29T19:00:00Z', isComplete: false, isRecurring: false };
  it('confirms a new upcoming visit once, then treats a new time as a reschedule', () => {
    assert.deepEqual(visitConfirmationDecision(v, [], now, 60), { send: true, kind: 'booking_confirmation' });
    assert.equal(visitConfirmationDecision(v, [v.startAt], now, 60).send, false);
    assert.deepEqual(visitConfirmationDecision({ ...v, startAt: '2026-10-30T19:00:00Z' }, [v.startAt], now, 60), { send: true, kind: 'reschedule_confirmation' });
  });
  it('skips unscheduled, past, complete, recurring and far-off visits', () => {
    assert.equal(visitConfirmationDecision({ ...v, startAt: null }, [], now, 60).send, false);
    assert.equal(visitConfirmationDecision({ ...v, startAt: '2026-10-22T19:00:00Z' }, [], now, 60).send, false);
    assert.equal(visitConfirmationDecision({ ...v, isComplete: true }, [], now, 60).send, false);
    assert.equal(visitConfirmationDecision({ ...v, isRecurring: true }, [], now, 60).send, false);
    assert.equal(visitConfirmationDecision({ ...v, startAt: '2027-03-01T19:00:00Z' }, [], now, 60).send, false);
  });
});

describe('follow-up timing', () => {
  const DAY = 24 * 3600 * 1000;
  const now = new Date('2026-10-23T03:00:00Z');
  it('keeps future and recent offsets, drops stale ones', () => {
    const due = new Date('2026-10-01T00:00:00Z'); // 22 days ago
    assert.equal(followUpTimes(due, [1 * DAY, 7 * DAY], now, 3).length, 0);
    const due2 = new Date('2026-10-20T00:00:00Z'); // 3 days ago
    assert.deepEqual(followUpTimes(due2, [1 * DAY, 7 * DAY], now, 3).map((t) => t.offsetMs / DAY), [1, 7]);
  });
});

describe('customer mobile + wording', () => {
  const asMobile = (raw: string) => (raw.startsWith('02') ? `+64${raw.slice(1).replace(/\D/g, '')}` : null);
  it('prefers the primary mobile, skips landlines', () => {
    assert.equal(pickMobile([{ number: '09 555 1234', primary: true }, { number: '021 467 770', primary: false }], asMobile), '+6421467770');
    assert.equal(pickMobile([{ number: '021 111 222' }, { number: '022 333 444', primary: true }], asMobile), '+6422333444');
    assert.equal(pickMobile([{ number: '09 555 1234' }], asMobile), null);
    assert.equal(pickMobile(null, asMobile), null);
  });
  it('writes short, plain-ASCII texts', () => {
    const p = { firstName: 'Sam' };
    const texts = [
      bookingConfirmationText(p, 'Smith Plumbing', 'Fri 30 Oct, 8am-10:30am', '12 Smith Street'),
      reminderText(p, 'Smith Plumbing', 'Fri 30 Oct, 8am-10:30am', '12 Smith Street'),
      quoteFollowUpText(p, 'Smith Plumbing', '45', 'https://clienthub.getjobber.com/client_hubs/abc/quotes/123'),
      invoiceFollowUpText(p, 'Smith Plumbing', '1021', 'on Mon 26 Oct', 'https://clienthub.getjobber.com/client_hubs/abc/invoices/456'),
      reviewRequestText(p, 'Smith Plumbing', 'https://g.page/r/abc123/review'),
    ];
    for (const t of texts) {
      assert.equal(smsSegments(t).encoding, 'GSM-7', t);
      assert.ok(smsSegments(t).segments <= 2, t);
    }
    assert.equal(hiName({ firstName: '' }), 'Hi there');
    assert.match(texts[0]!, /^Hi Sam, you're booked in with Smith Plumbing for Fri 30 Oct, 8am-10:30am at 12 Smith Street\.$/);
  });
});
