// Small crypto helpers. Node built-ins only, no dependencies.
//  - encrypt/decrypt: Jobber tokens at rest (AES-256-GCM)
//  - signToken/verifyToken: expiring signed tokens for connect links and OAuth state
//  - hmacMatches/safeEqual: constant-time comparisons for webhooks and shared secrets
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
// Format: v1.<iv>.<authTag>.<ciphertext>, each part base64url.
// The "v1" prefix leaves room for key rotation later (v2 = new key).
const VERSION = 'v1';
export function encrypt(plaintext, key) {
    const iv = randomBytes(12); // 96-bit nonce, the GCM standard
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function decrypt(payload, key) {
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
export function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string')
        return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}
export function hmacSha256(secret, data, encoding) {
    return createHmac('sha256', secret).update(data).digest(encoding);
}
export function signToken(data, ttlSeconds, purpose, secret) {
    const env = { p: purpose, exp: Math.floor(Date.now() / 1000) + ttlSeconds, d: data };
    const body = Buffer.from(JSON.stringify(env)).toString('base64url');
    const sig = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}
export function verifyToken(token, purpose, secret) {
    if (!token)
        return null;
    const [body, sig] = token.split('.');
    if (!body || !sig)
        return null;
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    if (!safeEqual(sig, expected))
        return null;
    try {
        const env = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (env.p !== purpose || env.exp < Math.floor(Date.now() / 1000))
            return null;
        return env.d;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=crypto.js.map