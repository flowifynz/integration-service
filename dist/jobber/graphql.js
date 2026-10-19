// Jobber GraphQL client. One function for calls on behalf of a connected client
// (handles token refresh + one retry on 401), one for a raw token (used during connect).
//
// To confirm: Jobber's throttling. It uses query-cost limits and reports throttling in
// `errors[].extensions` — check the exact code in the API explorer and add backoff here.
import { config } from "../config.js";
import { getAccessToken } from "./connection.js";
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
export class JobberApiError extends Error {
    status;
    errors;
    constructor(message, status, errors) {
        super(message);
        this.status = status;
        this.errors = errors;
    }
}
async function post(accessToken, query, variables, timeoutMs) {
    const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-JOBBER-GRAPHQL-VERSION': config.jobber.apiVersion,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) };
}
function unwrap(status, body) {
    if (status >= 400 || body.errors?.length || !body.data) {
        const msg = body.errors?.map((e) => e.message).join('; ') || `HTTP ${status}`;
        throw new JobberApiError(`Jobber API error: ${msg}`, status, body.errors);
    }
    return body.data;
}
/** Query with an explicit token (no refresh). Used in the OAuth callback before saving. */
export async function jobberQueryWithToken(accessToken, query, variables = {}) {
    const { status, body } = await post(accessToken, query, variables, 10_000);
    return unwrap(status, body);
}
/**
 * Query on behalf of a client. Default timeout is tight (4s) because most calls happen
 * while a caller is on the line; pass a longer one from the worker.
 */
export async function jobberQuery(clientId, query, variables = {}, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 4_000;
    let res = await post(await getAccessToken(clientId), query, variables, timeoutMs);
    if (res.status === 401) {
        // Token rejected despite looking valid (revoked, clock skew). Refresh once and retry.
        res = await post(await getAccessToken(clientId, { force: true }), query, variables, timeoutMs);
    }
    return unwrap(res.status, res.body);
}
// ---- Queries used so far -----------------------------------------------------
// Field names are best guesses from Jobber's public schema; verify each one in the
// GraphQL explorer before relying on it.
export const ACCOUNT_QUERY = /* GraphQL */ `
  query FlowifyAccount {
    account { id name }
  }
`;
export const CLIENTS_QUERY = /* GraphQL */ `
  query FlowifyClients($first: Int!, $searchTerm: String) {
    clients(first: $first, searchTerm: $searchTerm) {
      nodes {
        id
        name
        phones { number primary }
        emails { address primary }
      }
    }
  }
`;
//# sourceMappingURL=graphql.js.map