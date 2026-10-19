// Builds the final text a customer receives. Pure — unit tested.
//
// Rules from the brief:
//  - TNZ sends from a short code, so every customer text is signed with the business name.
//  - Every booking text says how to change it: call the agent's number (no reply inbox).
//  - Review requests are marketing under the Unsolicited Electronic Messages Act 2007:
//    they must identify the sender and carry a working opt-out.
const BOOKING_KINDS = new Set(['booking_confirmation', 'reschedule_confirmation', 'visit_reminder']);
export const MARKETING_KINDS = new Set(['review_request']);
export function composeSms(kind, text, client) {
    // Owner alerts go to the tradie, not their customer: no signature or footer.
    if (kind === 'owner_alert')
        return text.trim();
    const lines = [text.trim()];
    if (client.agent_phone_display) {
        lines.push(BOOKING_KINDS.has(kind)
            ? `To change your booking, call us on ${client.agent_phone_display}.`
            : `Questions? Call us on ${client.agent_phone_display}.`);
    }
    lines.push(`- ${client.business_name}`);
    if (MARKETING_KINDS.has(kind))
        lines.push('Reply STOP to opt out.');
    return lines.join('\n');
}
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT']);
/** True if an inbound reply is an opt-out request. */
export function isStopRequest(text) {
    if (!text)
        return false;
    const normalised = text.trim().toUpperCase().replace(/[^A-Z ]/g, '').trim();
    return STOP_WORDS.has(normalised);
}
//# sourceMappingURL=compose.js.map