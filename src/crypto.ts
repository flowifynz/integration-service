// Small crypto helpers. Node built-ins only, no dependencies.
//  - encrypt/decrypt: Jobber tokens at rest (AES-256-GCM)
//  - signToken/verifyToken: expiring signed tokens for connect links and OAuth state
//  - hmacMatches/safeEqual: constant-time comparisons for webhooks and shared secrets

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Format: v1.<iv>.<authTag>.<ciphertext>, each part base64url.
// The "v1" prefix leaves room for key rotation later (v2 = new key).
const VERSION = 'v1';

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('Unrecognised encrypted value format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  // final() throws if the value was tampered with or the key is wrong.
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/** Constant-time string comparison. False for missing values or different lengths. */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hmacSha256(secret: string, data: string | Buffer, encoding: 'base64' | 'hex'): string {
  return createHmac('sha256', secret).update(data).digest(encoding);
}

// ---- Signed, expiring tokens ----------------------------------------------------
// <base64url(json)>.<base64url(hmac)>. `purpose` stops a token minted for one job
// (e.g. an OAuth state) being replayed as another (e.g. a 7-day connect link).

interface Envelope<T> {
  p: string; // purpose
  exp: number; // unix seconds
  d: T; // data
}

export function signToken<T>(data: T, ttlSeconds: number, purpose: string, secret: string): string {
  const env: Envelope<T> = { p: purpose, exp: Math.floor(Date.now() / 1000) + ttlSeconds, d: data };
  const body = Buffer.from(JSON.stringify(env)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken<T>(token: string | undefined, purpose: string, secret: string): T | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const env = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Envelope<T>;
    if (env.p !== purpose || env.exp < Math.floor(Date.now() / 1000)) return null;
    return env.d;
  } catch {
    return null;
  }
}
