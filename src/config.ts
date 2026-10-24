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
  alerts: {
    /** Incoming webhook URL of the Google Chat space alerts are posted to (Jaron's support alerts space). */
    get googleChatWebhookUrl(): string | undefined {
      const url = process.env.GOOGLE_CHAT_WEBHOOK_URL || undefined;
      if (url && !url.startsWith('https://chat.googleapis.com/')) {
        throw new Error('GOOGLE_CHAT_WEBHOOK_URL must start with https://chat.googleapis.com/');
      }
      return url;
    },
    /** Optional: also text alerts to this mobile (E.164 or NZ format). Unset = no alert texts. */
    get mobile(): string | undefined {
      return process.env.ALERT_MOBILE || undefined;
    },
    /** 'Live' by default: alerts are real even while a client's texts are in Test mode. */
    get smsMode(): 'Live' | 'Test' {
      return process.env.ALERT_SMS_MODE?.toLowerCase() === 'test' ? 'Test' : 'Live';
    },
  },
  /**
   * Flowify's own automations (src/internal/). Separate secrets from the client side, so a
   * leaked client tool secret can't call Flowify's sales tools and the other way round.
   */
  internal: {
    /** Kill switch. Anything other than 'true' = the internal tools politely refuse. */
    get enabled(): boolean {
      return process.env.INTERNAL_ENABLED?.toLowerCase() === 'true';
    },
    /** Header x-flowify-secret on the website agent's tools. Not the client ELEVENLABS_TOOL_SECRET. */
    get toolSecret(): string {
      return required('INTERNAL_TOOL_SECRET');
    },
    /** Optional allowlist: comma-separated ElevenLabs agent IDs allowed to call the tools. */
    get agentIds(): string[] {
      return (process.env.INTERNAL_AGENT_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    },
    /** Google Chat space for website bookings (incoming webhook URL). Optional. */
    get chatWebhookUrl(): string | undefined {
      const url = process.env.INTERNAL_CHAT_WEBHOOK_URL || undefined;
      if (url && !url.startsWith('https://chat.googleapis.com/')) {
        throw new Error('INTERNAL_CHAT_WEBHOOK_URL must start with https://chat.googleapis.com/');
      }
      return url;
    },
    /** 'live' sends real texts; anything else = TNZ Test mode (accepted, not delivered). */
    get smsMode(): 'Live' | 'Test' {
      return process.env.INTERNAL_SMS_MODE?.toLowerCase() === 'live' ? 'Live' : 'Test';
    },
    /** TNZ SubAccount for Flowify's own texts, so they never land on a client's SMS bill. */
    get tnzSubaccount(): string {
      return process.env.INTERNAL_TNZ_SUBACCOUNT || 'Flowify Internal';
    },
  },
  /** Flowify's own GoHighLevel sub-account (sales CRM + discovery-call calendar). */
  ghl: {
    /** Private Integration Token. Scopes: calendars.readonly, calendars/events.write, contacts.write. */
    get token(): string {
      return required('GHL_PRIVATE_TOKEN');
    },
    get locationId(): string {
      return required('GHL_LOCATION_ID');
    },
    get calendarId(): string {
      return required('GHL_CALENDAR_ID');
    },
    /** Sent as the Version header. GHL's docs (Oct 2026) list 'v3' as the only value. */
    get apiVersion(): string {
      return process.env.GHL_API_VERSION || 'v3';
    },
    get baseUrl(): string {
      return process.env.GHL_BASE_URL ?? 'https://services.leadconnectorhq.com';
    },
  },
  get sentryDsn(): string | undefined {
    return process.env.SENTRY_DSN || undefined;
  },
};
