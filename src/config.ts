// Central config. Values are read lazily (getters) so tests and scripts can import
// modules without every env var being set — a missing var only fails when it's used.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  get port(): number {
    return Number(process.env.PORT ?? 3000);
  },
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  /** Public HTTPS address of the web service, no trailing slash. Used for OAuth redirect URI. */
  get publicBaseUrl(): string {
    return required('PUBLIC_BASE_URL').replace(/\/+$/, '');
  },
  /** Signs connect links and OAuth state (HMAC). Not the token encryption key. */
  get appSecret(): string {
    return required('APP_SECRET');
  },
  /** 32-byte AES-256-GCM key for Jobber tokens, supplied base64-encoded. */
  get tokenEncryptionKey(): Buffer {
    const key = Buffer.from(required('TOKEN_ENCRYPTION_KEY'), 'base64');
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    return key;
  },
  jobber: {
    get clientId(): string {
      return required('JOBBER_CLIENT_ID');
    },
    /** Also the HMAC key Jobber signs webhooks with. */
    get clientSecret(): string {
      return required('JOBBER_CLIENT_SECRET');
    },
    /** Sent as X-JOBBER-GRAPHQL-VERSION. Required on purpose: pin a version deliberately. */
    get apiVersion(): string {
      return required('JOBBER_API_VERSION');
    },
  },
  elevenlabs: {
    get toolSecret(): string {
      return required('ELEVENLABS_TOOL_SECRET');
    },
    get webhookSecret(): string {
      return required('ELEVENLABS_WEBHOOK_SECRET');
    },
  },
  tnz: {
    get apiToken(): string {
      return required('TNZ_API_TOKEN');
    },
    get baseUrl(): string {
      return process.env.TNZ_BASE_URL ?? 'https://api.tnz.co.nz/api/v3.00';
    },
    get inboundKey(): string {
      return required('TNZ_INBOUND_KEY');
    },
  },
  get sentryDsn(): string | undefined {
    return process.env.SENTRY_DSN || undefined;
  },
};
