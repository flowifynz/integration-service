// Jobber OAuth 2.0 (authorization code grant) — URL building and token calls.
// No database here; see connection.ts for storing and refreshing per client.
//
// Confirmed against Jobber's App Authorization docs (Oct 2026):
//  - Endpoints: /api/oauth/authorize and /api/oauth/token on api.getjobber.com
//  - Token request is form-encoded with client_id + client_secret in the body
//  - Response includes expires_in (3600). Access tokens last 60 minutes.
//  - With "Refresh token rotation" on, every refresh returns a NEW refresh token. Always
//    store it, overwriting the old one, before using the new access token.
//  - PKCE is recommended but optional; not used yet (the client secret stays server-side).

import { config } from '../config.ts';

const OAUTH_BASE = 'https://api.getjobber.com/api/oauth';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export class JobberAuthError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Jobber token request failed (${status}): ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
  /** The refresh token is dead (revoked, already rotated, app disconnected). Client must reconnect. */
  get isInvalidGrant(): boolean {
    return (this.status === 400 || this.status === 401) && /invalid_grant|invalid_token|revoked/i.test(this.body);
  }
}

export function redirectUri(): string {
  return `${config.publicBaseUrl}/jobber/callback`;
}

export function authorizeUrl(state: string): string {
  const url = new URL(`${OAUTH_BASE}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.jobber.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

export function exchangeCode(code: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
}

export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.jobber.clientId,
      client_secret: config.jobber.clientSecret,
      ...params,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new JobberAuthError(res.status, text);

  const json = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token) {
    throw new JobberAuthError(res.status, `Token response missing tokens: ${text}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: accessTokenExpiry(json.access_token, json.expires_in),
  };
}

/** expires_in if given; else the JWT's `exp` claim; else a cautious 55 minutes. */
export function accessTokenExpiry(accessToken: string, expiresIn?: number, now = Date.now()): Date {
  if (typeof expiresIn === 'number' && expiresIn > 0) return new Date(now + expiresIn * 1000);
  const payload = accessToken.split('.')[1];
  if (payload) {
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
      if (typeof exp === 'number') return new Date(exp * 1000);
    } catch {
      // not a JWT — fall through
    }
  }
  return new Date(now + 55 * 60_000);
}
