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

import { alertText, alertTnzMessageId, dailyAlertKey, isAlertDaytime, nzDate, toGsmSafe, type AlertKind } from '../src/alerts/text.ts';

describe('admin alerts (D4)', () => {
  const kinds: AlertKind[] = [
    'jobber_needs_reconnect', 'jobber_disconnected', 'jobber_reconnected', 'jobber_connect_failed',
    'sms_failures', 'stuck_webhooks', 'queue_backlog', 'test',
  ];

  it('every alert is plain GSM-7, has no link, and fits in 2 segments', () => {
    for (const kind of kinds) {
      const text = alertText(kind, { businessName: 'Tāmaki Plumbing – “Ltd”', slug: 'tamaki-plumbing', detail: 4 });
      const { encoding, segments } = smsSegments(text);
      assert.equal(encoding, 'GSM-7', `${kind}: ${text}`);
      assert.ok(segments <= 2, `${kind} is ${segments} segments`);
      assert.doesNotMatch(text, /https?:|www\./i, `${kind} contains a link (TNZ URL check)`);
    }
  });

  it('reconnect alerts name the client and the connect-link command', () => {
    const text = alertText('jobber_needs_reconnect', { businessName: 'Smith Plumbing', slug: 'smith-plumbing' });
    assert.match(text, /Smith Plumbing/);
    assert.match(text, /connectLink\.js smith-plumbing/);
  });

  it('strips macrons, curly quotes and dashes', () => {
    assert.equal(toGsmSafe('Tāmaki – “Ōrākei”'), 'Tamaki - "Orakei"');
  });

  it('daily keys roll over at NZ midnight, not UTC midnight', () => {
    // 2026-10-23 10:30 UTC = 23:30 NZDT on the 23rd; 11:30 UTC = 00:30 on the 24th.
    assert.equal(nzDate(new Date('2026-10-23T10:30:00Z')), '2026-10-23');
    assert.equal(nzDate(new Date('2026-10-23T11:30:00Z')), '2026-10-24');
    assert.equal(dailyAlertKey('sms_failures', 'abc', new Date('2026-10-23T11:30:00Z')), 'sms_failures:abc:2026-10-24');
    assert.equal(dailyAlertKey('queue_backlog', null, new Date('2026-10-23T11:30:00Z')), 'queue_backlog:all:2026-10-24');
  });

  it('health-check alerts only go out 7am to 9pm NZ', () => {
    assert.equal(isAlertDaytime(new Date('2026-10-23T17:59:00Z')), false); // 6:59am NZDT
    assert.equal(isAlertDaytime(new Date('2026-10-23T18:00:00Z')), true); // 7:00am
    assert.equal(isAlertDaytime(new Date('2026-10-23T07:59:00Z')), true); // 8:59pm
    assert.equal(isAlertDaytime(new Date('2026-10-23T08:00:00Z')), false); // 9:00pm
  });

  it('alert MessageIDs never look like a customer text row', () => {
    const id = alertTnzMessageId(12, 1);
    assert.equal(id, 'flowifyalert12a1');
    assert.match(id, /^[A-Za-z0-9]{1,40}$/);
    assert.equal(messageRowIdFromTnz(id), null);
  });
});

import { alertChatText, alertThreadKey } from '../src/alerts/text.ts';
import { googleChatPostUrl } from '../src/alerts/googleChat.ts';

describe('admin alerts in Google Chat', () => {
  it('reconnect alerts carry the connect link when given one', () => {
    const text = alertChatText('jobber_needs_reconnect', {
      businessName: 'Smith Plumbing',
      slug: 'smith-plumbing',
      connectLink: 'https://example.onrender.com/jobber/connect?t=abc',
    });
    assert.match(text, /\*Smith Plumbing: Jobber connection expired\*/);
    assert.match(text, /<https:\/\/example\.onrender\.com\/jobber\/connect\?t=abc\|Connect Jobber to Flowify>/);
  });

  it('falls back to the Render Shell command without a link', () => {
    assert.match(alertChatText('jobber_disconnected', { slug: 'smith-plumbing' }), /connectLink\.js smith-plumbing/);
  });

  it('keeps every Jobber alert for a client in one thread', () => {
    assert.equal(alertThreadKey('jobber_needs_reconnect', 'c1'), alertThreadKey('jobber_reconnected', 'c1'));
    assert.notEqual(alertThreadKey('jobber_disconnected', 'c1'), alertThreadKey('jobber_disconnected', 'c2'));
    assert.equal(alertThreadKey('queue_backlog', null), 'queue_backlog-all');
  });

  it('adds thread options to the webhook URL without losing key and token', () => {
    const url = new URL(googleChatPostUrl('https://chat.googleapis.com/v1/spaces/AAA/messages?key=K&token=T', 'jobber-c1'));
    assert.equal(url.searchParams.get('key'), 'K');
    assert.equal(url.searchParams.get('token'), 'T');
    assert.equal(url.searchParams.get('threadKey'), 'jobber-c1');
    assert.equal(url.searchParams.get('messageReplyOption'), 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  });
});

import { columnsToWrite, missingForNewClient, parseOnboardArgs, TIER_DEFAULTS } from '../src/onboarding/settings.ts';

describe('onboarding script (D5)', () => {
  const newCore = ['--slug', 'smith-plumbing', '--name', 'Smith Plumbing', '--tier', 'core', '--agent-phone', '09 555 1234', '--owner-mobile', '021 123 4567'];

  it('parses a new Core client and normalises numbers to E.164', () => {
    const { input, errors } = parseOnboardArgs(newCore);
    assert.deepEqual(errors, []);
    assert.equal(input?.agentPhone, '+6495551234');
    assert.equal(input?.ownerMobile, '+64211234567');
    assert.deepEqual(missingForNewClient(input!), []);
  });

  it('new client gets plan defaults, SubAccount = slug, onboarding in Test mode', () => {
    const cols = columnsToWrite(parseOnboardArgs(newCore).input!, null);
    assert.equal(cols.monthly_minutes_cap, TIER_DEFAULTS.core.minutesCap);
    assert.equal(cols.sms_allowance_segments, 500);
    assert.equal(cols.tnz_subaccount, 'smith-plumbing');
    assert.equal(cols.status, 'onboarding');
    assert.equal(cols.sms_mode, 'test');
  });

  it('rejects bad input with a clear message', () => {
    const { input, errors } = parseOnboardArgs(['--slug', 'Smith Plumbing', '--tier', 'pro', '--owner-mobile', '12', '--agent-id', 'abc']);
    assert.equal(input, undefined);
    assert.ok(errors.some((e) => e.includes('--slug')));
    assert.ok(errors.some((e) => e.includes('--tier must be base or core')));
    assert.ok(errors.some((e) => e.includes('--owner-mobile')));
    assert.ok(errors.some((e) => e.includes('--agent-id')));
  });

  it('a new client must have name, tier, Twilio number and owner mobile', () => {
    const { input } = parseOnboardArgs(['--slug', 'x-plumbing']);
    assert.match(missingForNewClient(input!)[0]!, /--name, --tier, --agent-phone, --owner-mobile/);
  });

  it('an update only changes what was given', () => {
    const cols = columnsToWrite(parseOnboardArgs(['--slug', 'smith-plumbing', '--agent-id', 'agent_abc123']).input!, { tier: 'core' });
    assert.deepEqual(cols, { elevenlabs_agent_id: 'agent_abc123' });
  });

  it('a Base to Core upgrade applies Core defaults unless overridden', () => {
    const cols = columnsToWrite(parseOnboardArgs(['--slug', 's', '--tier', 'core', '--minutes', '400']).input!, { tier: 'base' });
    assert.equal(cols.tier, 'core');
    assert.equal(cols.monthly_minutes_cap, 400);
    assert.equal(cols.sms_allowance_segments, TIER_DEFAULTS.core.smsAllowanceSegments);
  });

  it('--go-live switches the client on and texts to Live', () => {
    const cols = columnsToWrite(parseOnboardArgs(['--slug', 's', '--go-live']).input!, { tier: 'core' });
    assert.deepEqual(cols, { status: 'active', sms_mode: 'live' });
  });
});

import { callCategory, callerConfirmationText, callerDetails, extractPostCall, planPostCall } from '../src/calls/postCall.ts';

describe('post-call processing (D3)', () => {
  const payload = (over: { transcript?: unknown[]; collected?: Record<string, unknown>; duration?: number; phoneCall?: boolean } = {}) => ({
    type: 'post_call_transcription',
    event_timestamp: 1761200000,
    data: {
      agent_id: 'agent_abc',
      conversation_id: 'conv_1',
      status: 'done',
      transcript: over.transcript ?? [
        { role: 'agent', message: 'Kia ora', time_in_call_secs: 0 },
        { role: 'user', message: 'My tap is leaking', time_in_call_secs: 3 },
        {
          role: 'agent',
          message: null,
          tool_calls: [{ tool_name: 'create_request', params_as_json: JSON.stringify({ name: 'Sam Smith', address: '12 Smith St', description: 'Leaking tap', urgency: 'soon' }) }],
        },
        { role: 'agent', message: null, tool_results: [{ tool_name: 'create_request', result_value: JSON.stringify({ ok: true, logged: false }) }] },
      ],
      metadata: {
        start_time_unix_secs: 1761199900,
        call_duration_secs: 95,
        termination_reason: 'end_call tool',
        ...(over.phoneCall === false ? {} : { phone_call: { external_number: '+64211234567', agent_number: '+6495551234', type: 'twilio' } }),
      },
      analysis: {
        call_successful: 'success',
        transcript_summary: 'Sam called about a leaking tap.',
        data_collection_results: Object.fromEntries(Object.entries(over.collected ?? {}).map(([k, v]) => [k, { data_collection_id: k, value: v }])),
      },
      conversation_initiation_client_data: { dynamic_variables: { system__caller_id: '+64217654321', system__called_number: '+6495550000' } },
    },
  });

  it('reads numbers, timing, summary and the create_request call', () => {
    const info = extractPostCall(payload());
    assert.equal(info.conversationId, 'conv_1');
    assert.equal(info.callerNumber, '+64211234567'); // phone_call wins over system vars
    assert.equal(info.calledNumber, '+6495551234');
    assert.equal(info.durationSecs, 95);
    assert.equal(info.startedAt?.toISOString(), new Date(1761199900 * 1000).toISOString());
    assert.equal(info.requestTool.called, true);
    assert.equal(info.requestTool.logged, false);
    assert.equal(info.requestTool.args?.name, 'Sam Smith');
    assert.equal(info.userSpoke, true);
  });

  it('falls back to system__ variables for phone numbers', () => {
    const info = extractPostCall(payload({ phoneCall: false }));
    assert.equal(info.callerNumber, '+64217654321');
    assert.equal(info.calledNumber, '+6495550000');
  });

  it('copes with junk', () => {
    const info = extractPostCall({ nonsense: true });
    assert.equal(info.conversationId, null);
    assert.equal(info.requestTool.called, false);
  });

  it('categorises calls', () => {
    assert.equal(callCategory(extractPostCall(payload())), 'new_job');
    assert.equal(callCategory(extractPostCall(payload({ transcript: [], collected: { call_category: 'sales_spam' } }))), 'other');
    assert.equal(callCategory(extractPostCall(payload({ transcript: [{ role: 'agent', message: 'Kia ora' }] }))), 'no_conversation');
    assert.equal(callCategory(extractPostCall(payload({ transcript: [{ role: 'user', message: 'Hi there' }] }))), 'unknown');
  });

  it('Core: tool ran but Jobber failed -> create after the call, short owner follow-up, thank the caller', () => {
    const plan = planPostCall(extractPostCall(payload()), { tier: 'core', jobberRequestId: null, callerTextsOn: true });
    assert.deepEqual(plan, { category: 'new_job', createRequest: true, ownerText: 'saved_after_call', callerText: true, needsReview: null });
  });

  it('Core: already logged during the call -> only the thank-you text', () => {
    const plan = planPostCall(extractPostCall(payload()), { tier: 'core', jobberRequestId: 'req_1', callerTextsOn: true });
    assert.equal(plan.createRequest, false);
    assert.equal(plan.ownerText, null);
    assert.equal(plan.callerText, true);
  });

  it('Core: never creates a duplicate when the tool said logged: true', () => {
    const p = payload();
    (p.data.transcript[3] as { tool_results: { result_value: string }[] }).tool_results[0]!.result_value = JSON.stringify({ ok: true, logged: true });
    const plan = planPostCall(extractPostCall(p), { tier: 'core', jobberRequestId: null, callerTextsOn: true });
    assert.equal(plan.createRequest, false);
  });

  it('Core: tool never ran, data collection has the details -> create + full owner text', () => {
    const info = extractPostCall(payload({
      transcript: [{ role: 'user', message: 'Need a sparky' }],
      collected: { call_category: 'new_job', caller_name: 'Kim Tane', job_description: 'Power out in kitchen', is_emergency: 'yes' },
    }));
    const plan = planPostCall(info, { tier: 'core', jobberRequestId: null, callerTextsOn: true });
    assert.equal(plan.createRequest, true);
    assert.equal(plan.ownerText, 'new_request');
    assert.equal(callerDetails(info).urgency, 'emergency');
  });

  it('Core: new job without a name -> no request, owner told, flagged for review', () => {
    const info = extractPostCall(payload({ transcript: [{ role: 'user', message: 'hello' }], collected: { call_category: 'new_job' } }));
    const plan = planPostCall(info, { tier: 'core', jobberRequestId: null, callerTextsOn: true });
    assert.equal(plan.createRequest, false);
    assert.equal(plan.ownerText, 'new_request');
    assert.match(plan.needsReview ?? '', /no name/);
  });

  it('Base: owner always gets the summary for a new job; never touches Jobber', () => {
    const plan = planPostCall(extractPostCall(payload()), { tier: 'base', jobberRequestId: null, callerTextsOn: true });
    assert.equal(plan.createRequest, false);
    assert.equal(plan.ownerText, 'new_request');
  });

  it('other calls get no texts; unknown calls are flagged for review', () => {
    const other = planPostCall(extractPostCall(payload({ transcript: [], collected: { call_category: 'sales_spam' } })), { tier: 'core', jobberRequestId: null, callerTextsOn: true });
    assert.deepEqual([other.createRequest, other.ownerText, other.callerText], [false, null, false]);
    const unknown = planPostCall(extractPostCall(payload({ transcript: [{ role: 'user', message: 'Hi' }] })), { tier: 'core', jobberRequestId: null, callerTextsOn: true });
    assert.ok(unknown.needsReview);
  });

  it('caller text is one GSM-7 segment once signed', () => {
    const body = composeSms('call_confirmation', callerConfirmationText('Dave'), { business_name: 'Smith Plumbing & Gas', agent_phone_display: '09 555 1234' });
    assert.equal(smsSegments(body).encoding, 'GSM-7');
    assert.ok(smsSegments(body).segments <= 1, body);
    assert.equal(departmentFor('call_confirmation'), 'calls');
  });

  it('owner alert text is GSM-7 even when truncated', () => {
    const long = ownerAlertText({ callerName: 'Sam', callbackPhone: null, phoneSource: 'none', address: null, description: 'x'.repeat(300), urgency: 'soon', loggedInJobber: false });
    assert.equal(smsSegments(long).encoding, 'GSM-7');
    const base = ownerAlertText({ callerName: 'Sam', callbackPhone: null, phoneSource: 'none', address: null, description: 'Leak', urgency: 'soon', loggedInJobber: null });
    assert.doesNotMatch(base, /Jobber/);
  });
});
