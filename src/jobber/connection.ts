// Per-client Jobber connections: save, get a valid access token (refreshing if needed),
// and mark disconnected. Tokens are encrypted before they touch the database.
//
// Refresh is the delicate part. With refresh token rotation, two requests refreshing at
// the same moment would each spend the same refresh token — the second fails and the
// client is locked out. So refresh happens inside a transaction holding a row lock
// (SELECT ... FOR UPDATE): the second request waits, then sees the fresh token and uses it.

import { config } from '../config.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { db, withTransaction } from '../db.ts';
import { JobberAuthError, refreshTokens, type TokenSet } from './oauth.ts';

/** Refresh when the access token has less than this left, so it can't expire mid-call. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class JobberNotConnectedError extends Error {
  readonly clientId: string;
  readonly reason: 'never_connected' | 'needs_reconnect' | 'disconnected';
  constructor(clientId: string, reason: JobberNotConnectedError['reason']) {
    super(`Jobber not connected for client ${clientId} (${reason})`);
    this.clientId = clientId;
    this.reason = reason;
  }
}

interface ConnectionRow {
  access_token_enc: string;
  refresh_token_enc: string;
  access_token_expires_at: Date;
  status: 'connected' | 'needs_reconnect' | 'disconnected';
}

export async function saveConnection(
  clientId: string,
  tokens: TokenSet,
  account: { id: string; name?: string | null },
): Promise<void> {
  const key = config.tokenEncryptionKey;
  await db().query(
    `INSERT INTO jobber_connections
       (client_id, jobber_account_id, jobber_account_name, access_token_enc, refresh_token_enc,
        access_token_expires_at, status, connected_at, refreshed_at, disconnected_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'connected', now(), now(), NULL)
     ON CONFLICT (client_id) DO UPDATE SET
       jobber_account_id = EXCLUDED.jobber_account_id,
       jobber_account_name = EXCLUDED.jobber_account_name,
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       status = 'connected', connected_at = now(), refreshed_at = now(), disconnected_at = NULL`,
    [clientId, account.id, account.name ?? null, encrypt(tokens.accessToken, key), encrypt(tokens.refreshToken, key), tokens.expiresAt],
  );
}

/**
 * A valid access token for this client's Jobber account.
 * `force` refreshes even if the token looks fresh (used after a 401).
 */
export async function getAccessToken(clientId: string, opts: { force?: boolean } = {}): Promise<string> {
  const key = config.tokenEncryptionKey;
  const isFresh = (row: ConnectionRow) =>
    new Date(row.access_token_expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS;

  // Fast path: no lock, no transaction — this is what nearly every mid-call lookup hits.
  const { rows } = await db().query<ConnectionRow>(
    'SELECT access_token_enc, refresh_token_enc, access_token_expires_at, status FROM jobber_connections WHERE client_id = $1',
    [clientId],
  );
  const current = rows[0];
  if (!current) throw new JobberNotConnectedError(clientId, 'never_connected');
  if (current.status !== 'connected') throw new JobberNotConnectedError(clientId, current.status);
  if (!opts.force && isFresh(current)) return decrypt(current.access_token_enc, key);

  // Slow path: lock the row and refresh.
  const token = await withTransaction(async (tx) => {
    const locked = (
      await tx.query<ConnectionRow>(
        'SELECT access_token_enc, refresh_token_enc, access_token_expires_at, status FROM jobber_connections WHERE client_id = $1 FOR UPDATE',
        [clientId],
      )
    ).rows[0];
    if (!locked || locked.status !== 'connected') return null;
    // Someone else refreshed while we waited for the lock — use theirs.
    if (locked.access_token_enc !== current.access_token_enc && isFresh(locked)) {
      return decrypt(locked.access_token_enc, key);
    }

    let tokens: TokenSet;
    try {
      tokens = await refreshTokens(decrypt(locked.refresh_token_enc, key));
    } catch (err) {
      if (err instanceof JobberAuthError && err.isInvalidGrant) {
        // Dead refresh token. Record it (committed with this transaction) and stop.
        await tx.query(`UPDATE jobber_connections SET status = 'needs_reconnect' WHERE client_id = $1`, [clientId]);
        return null;
      }
      throw err; // network blip or Jobber 5xx: let the caller fail/retry, keep the old tokens
    }

    // Save the rotated refresh token BEFORE anything else uses the new access token.
    await tx.query(
      `UPDATE jobber_connections
         SET access_token_enc = $2, refresh_token_enc = $3, access_token_expires_at = $4, refreshed_at = now()
       WHERE client_id = $1`,
      [clientId, encrypt(tokens.accessToken, key), encrypt(tokens.refreshToken, key), tokens.expiresAt],
    );
    return tokens.accessToken;
  });

  if (token === null) {
    // TODO(build step 7): alert Jaron (Sentry + owner email) — this client needs a new connect link.
    console.error(`Jobber refresh token rejected for client ${clientId}; marked needs_reconnect`);
    throw new JobberNotConnectedError(clientId, 'needs_reconnect');
  }
  return token;
}

/** Called on Jobber's APP_DISCONNECT webhook (client removed the app in Jobber). */
export async function markDisconnectedByAccount(jobberAccountId: string): Promise<string | null> {
  const { rows } = await db().query<{ client_id: string }>(
    `UPDATE jobber_connections
        SET status = 'disconnected', disconnected_at = now(),
            -- tokens are useless now; overwrite rather than keep them around
            access_token_enc = 'revoked', refresh_token_enc = 'revoked'
      WHERE jobber_account_id = $1 AND status <> 'disconnected'
      RETURNING client_id`,
    [jobberAccountId],
  );
  return rows[0]?.client_id ?? null;
}

export async function clientIdForAccount(jobberAccountId: string): Promise<string | null> {
  const { rows } = await db().query<{ client_id: string }>(
    `SELECT client_id FROM jobber_connections WHERE jobber_account_id = $1 AND status <> 'disconnected'`,
    [jobberAccountId],
  );
  return rows[0]?.client_id ?? null;
}
