// Unit tests for the dependency-free core. Run: npm test

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { decrypt, encrypt, safeEqual, signToken, verifyToken } from '../src/crypto.ts';
import { verifyElevenLabsSignature } from '../src/elevenlabsSignature.ts';
import { accessTokenExpiry } from '../src/jobber/oauth.ts';
import { parseJobberWebhook, verifyJobberSignature, webhookDedupeKey } from '../src/jobber/webhook.ts';
import { composeSms, isStopRequest } from '../src/sms/compose.ts';
import { quietHoursDeferral } from '../src/sms/quietHours.ts';
import { extractInbound } from '../src/sms/inbound.ts';
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
      { to: '+64211234567', message: 'hi', subAccount: 'smith', messageId: tnzMessageId(42, 1), reference: 'smith booking_confirmation', mode: 'Test' },
      'https://x.test/tnz/inbound?key=k',
    );
    assert.equal(p.Destination, '+64211234567');
    assert.equal(p.Message, 'hi');
    assert.equal(p.MessageID, 'flowify42a1');
    assert.equal(p.Mode, 'Test');
    assert.equal(p.SubAccount, 'smith');
    assert.equal(p.NotificationType, 'Webhook');
    assert.equal(p.WebhookCallbackFormat, 'JSON');
    const live = buildTnzPayload({ to: '+64', message: '', subAccount: null, messageId: 'flowify1a1', reference: 'r', mode: 'Live' }, 'u');
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
