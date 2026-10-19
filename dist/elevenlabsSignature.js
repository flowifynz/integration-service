// ElevenLabs post-call webhook signature check. Pure — unit tested.
//
// Header format (confirm in ElevenLabs' webhook docs): `ElevenLabs-Signature: t=<unix>,v0=<hex>`
// where v0 = HMAC-SHA256(secret, `${t}.${rawBody}`). Rejects anything older than 30 min
// so a captured request can't be replayed later.
import { hmacSha256, safeEqual } from "./crypto.js";
const TOLERANCE_SECONDS = 30 * 60;
export function verifyElevenLabsSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!header)
        return false;
    const parts = Object.fromEntries(header.split(',').map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > TOLERANCE_SECONDS)
        return false;
    const expected = hmacSha256(secret, `${parts.t}.${rawBody.toString('utf8')}`, 'hex');
    return safeEqual(parts.v0, expected);
}
//# sourceMappingURL=elevenlabsSignature.js.map