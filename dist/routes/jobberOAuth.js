// Jobber connect flow.
//
//  1. Jaron runs `npm run connect-link -- <client-slug>` and sends the client the link.
//  2. GET /jobber/connect?t=<signed link>   → verifies the link, redirects to Jobber
//  3. Client approves in Jobber
//  4. GET /jobber/callback?code&state      → swaps code for tokens, reads the Jobber
//                                            account, saves an encrypted connection
//
// Reconnecting is the same flow: the callback overwrites the old connection row.
// The link is signed (APP_SECRET) so nobody can attach their Jobber account to a client
// by guessing a URL. OAuth `state` is a separate short-lived token (CSRF protection).
import { config } from "../config.js";
import { signToken, verifyToken } from "../crypto.js";
import { getClientById } from "../db.js";
import { saveConnection } from "../jobber/connection.js";
import { ACCOUNT_QUERY, jobberQueryWithToken } from "../jobber/graphql.js";
import { authorizeUrl, exchangeCode } from "../jobber/oauth.js";
export const CONNECT_LINK_PURPOSE = 'jobber-connect-link';
const STATE_PURPOSE = 'jobber-oauth-state';
export const CONNECT_LINK_TTL_SECONDS = 7 * 24 * 3600;
export function makeConnectLink(clientId) {
    const t = signToken({ clientId }, CONNECT_LINK_TTL_SECONDS, CONNECT_LINK_PURPOSE, config.appSecret);
    return `${config.publicBaseUrl}/jobber/connect?t=${encodeURIComponent(t)}`;
}
function page(reply, status, heading, text) {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return reply
        .code(status)
        .type('text/html; charset=utf-8')
        .send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flowify</title>` +
        `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
        `<h1 style="font-size:1.4rem">${esc(heading)}</h1><p>${esc(text)}</p></body>`);
}
export async function jobberOAuthRoutes(app) {
    app.get('/jobber/connect', async (req, reply) => {
        const { t } = req.query;
        const link = verifyToken(t, CONNECT_LINK_PURPOSE, config.appSecret);
        if (!link)
            return page(reply, 400, 'Link expired', 'This connect link is invalid or has expired. Ask Flowify for a new one.');
        const state = signToken({ clientId: link.clientId }, 15 * 60, STATE_PURPOSE, config.appSecret);
        return reply.redirect(authorizeUrl(state));
    });
    app.get('/jobber/callback', async (req, reply) => {
        const { code, state, error } = req.query;
        if (error)
            return page(reply, 400, 'Not connected', 'Jobber access was not approved. You can use the same link to try again.');
        const s = verifyToken(state, STATE_PURPOSE, config.appSecret);
        if (!s || !code)
            return page(reply, 400, 'Link expired', 'This sign-in took too long or the link was reused. Please start again from your connect link.');
        const client = await getClientById(s.clientId);
        if (!client)
            return page(reply, 404, 'Unknown business', 'We could not find your business. Please contact Flowify.');
        try {
            const tokens = await exchangeCode(code);
            const { account } = await jobberQueryWithToken(tokens.accessToken, ACCOUNT_QUERY);
            await saveConnection(client.id, tokens, account);
            req.log.info({ clientId: client.id, jobberAccountId: account.id }, 'Jobber connected');
            return page(reply, 200, 'Jobber connected', `${client.business_name} is now connected to Flowify. You can close this tab.`);
        }
        catch (err) {
            // Most likely: the Jobber account is already connected to a different Flowify client
            // (unique index), or Jobber rejected the code.
            req.log.error({ err, clientId: client.id }, 'Jobber connect failed');
            return page(reply, 500, 'Something went wrong', 'We could not finish connecting Jobber. Flowify has been notified.');
        }
    });
}
//# sourceMappingURL=jobberOAuth.js.map