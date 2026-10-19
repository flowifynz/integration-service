// Jobber webhook verification and parsing. Pure functions, unit tested.
//
// Jobber signs each webhook with HMAC-SHA256 of the raw request body, keyed with the
// app's client secret, base64-encoded, in the X-Jobber-Hmac-SHA256 header.
// Always verify against the RAW bytes — re-serialised JSON won't match.
import { createHash } from 'node:crypto';
import { hmacSha256, safeEqual } from "../crypto.js";
export const JOBBER_SIGNATURE_HEADER = 'x-jobber-hmac-sha256';
export function verifyJobberSignature(rawBody, signature, clientSecret) {
    if (!signature)
        return false;
    return safeEqual(hmacSha256(clientSecret, rawBody, 'base64'), signature);
}
/** Payload shape: { data: { webHookEvent: { topic, appId, accountId, itemId, occurredAt } } } */
export function parseJobberWebhook(rawBody) {
    try {
        const evt = JSON.parse(rawBody.toString('utf8'))?.data?.webHookEvent;
        if (!evt || typeof evt.topic !== 'string' || typeof evt.accountId !== 'string')
            return null;
        return evt;
    }
    catch {
        return null;
    }
}
/**
 * Jobber delivers at least once, so the same event can arrive twice. Jobber doesn't send
 * an event ID, so we derive one from the fields that identify the event.
 */
export function webhookDedupeKey(evt) {
    return createHash('sha256')
        .update([evt.topic, evt.accountId, evt.itemId ?? '', evt.occurredAt ?? ''].join('|'))
        .digest('hex');
}
//# sourceMappingURL=webhook.js.map