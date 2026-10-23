// Onboarding (backlog D5): plan defaults and argument checking for the onboarding script.
// Pure functions, no database — unit tested.

import { parseArgs } from 'node:util';
import { toE164 } from '../phone.ts';

export type Tier = 'base' | 'core';

/**
 * Defaults per plan. Minutes from the offer (01 Flowify Build Context). SMS allowance and
 * overage are PLACEHOLDERS until pricing option A is confirmed. Change here, not per client.
 */
export const TIER_DEFAULTS: Record<Tier, { minutesCap: number; smsAllowanceSegments: number; smsOverageCents: number }> = {
  base: { minutesCap: 100, smsAllowanceSegments: 150, smsOverageCents: 20 },
  core: { minutesCap: 300, smsAllowanceSegments: 500, smsOverageCents: 20 },
};

/** What the script will write. undefined = not given (keep the existing value on an update). */
export interface OnboardInput {
  slug: string;
  businessName?: string;
  tier?: Tier;
  agentPhone?: string;
  ownerName?: string;
  ownerMobile?: string;
  ownerEmail?: string;
  agentId?: string;
  reviewLink?: string;
  minutesCap?: number;
  smsAllowanceSegments?: number;
  smsOverageCents?: number;
  /** Go live: status 'active' and TNZ texts sent for real. */
  goLive: boolean;
  dryRun: boolean;
}

export const USAGE = `Create or update a Flowify client.

  node dist/scripts/onboardClient.js --slug <slug> [options]

New client (required): --slug --name --tier base|core --agent-phone --owner-mobile
  --slug            short handle, lower case and hyphens, e.g. smith-plumbing (also the TNZ SubAccount)
  --name            business name exactly as it signs texts, e.g. "Smith Plumbing"
  --tier            base | core
  --agent-phone     the client's Twilio number (callers are forwarded to it)
  --owner-mobile    where owner summaries and urgent alerts go
Optional:
  --owner-name      first name, e.g. Dave
  --owner-email
  --agent-id        ElevenLabs agent ID (agent_...)
  --review-link     Google review link for review requests (Core)
  --minutes         receptionist minutes a month (default 100 Base / 300 Core)
  --sms-allowance   included SMS segments a month (default 150 Base / 500 Core)
  --sms-overage     cents per segment over the allowance (default 20)
  --go-live         switch the client on: status active, texts sent for real (TNZ Live)
  --dry-run         show what would change, change nothing

Re-run with the same --slug to change anything; only the options you give are changed.`;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseOnboardArgs(argv: string[]): { input?: OnboardInput; errors: string[] } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        slug: { type: 'string' },
        name: { type: 'string' },
        tier: { type: 'string' },
        'agent-phone': { type: 'string' },
        'owner-name': { type: 'string' },
        'owner-mobile': { type: 'string' },
        'owner-email': { type: 'string' },
        'agent-id': { type: 'string' },
        'review-link': { type: 'string' },
        minutes: { type: 'string' },
        'sms-allowance': { type: 'string' },
        'sms-overage': { type: 'string' },
        'go-live': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }));
  } catch (err) {
    return { errors: [(err as Error).message] };
  }
  if (values.help) return { errors: [] };

  const errors: string[] = [];
  const str = (k: string) => {
    const v = values[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const int = (k: string, min: number) => {
    const v = str(k);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) {
      errors.push(`--${k} must be a whole number of at least ${min}`);
      return undefined;
    }
    return n;
  };
  const phone = (k: string) => {
    const v = str(k);
    if (v === undefined) return undefined;
    const e164 = toE164(v);
    if (!e164) errors.push(`--${k} "${v}" isn't a valid NZ phone number`);
    return e164 ?? undefined;
  };

  const slug = str('slug');
  if (!slug) errors.push('--slug is required');
  else if (!SLUG.test(slug) || slug.length > 40) errors.push(`--slug "${slug}" must be lower case letters, numbers and hyphens (max 40)`);

  const tierRaw = str('tier')?.toLowerCase();
  let tier: Tier | undefined;
  if (tierRaw !== undefined) {
    if (tierRaw === 'base' || tierRaw === 'core') tier = tierRaw;
    else errors.push(`--tier must be base or core (got "${tierRaw}")`);
  }

  const ownerEmail = str('owner-email');
  if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) errors.push(`--owner-email "${ownerEmail}" doesn't look like an email`);

  const agentId = str('agent-id');
  if (agentId && !/^agent_[A-Za-z0-9]+$/.test(agentId)) errors.push(`--agent-id "${agentId}" should look like agent_xxxxxxxx (ElevenLabs agent ID)`);

  const reviewLink = str('review-link');
  if (reviewLink && !/^https:\/\//.test(reviewLink)) errors.push('--review-link must start with https://');

  const input: OnboardInput = {
    slug: slug ?? '',
    businessName: str('name'),
    tier,
    agentPhone: phone('agent-phone'),
    ownerName: str('owner-name'),
    ownerMobile: phone('owner-mobile'),
    ownerEmail,
    agentId,
    reviewLink,
    minutesCap: int('minutes', 1),
    smsAllowanceSegments: int('sms-allowance', 0),
    smsOverageCents: int('sms-overage', 0),
    goLive: values['go-live'] === true,
    dryRun: values['dry-run'] === true,
  };
  return { input: errors.length ? undefined : input, errors };
}

/** Extra checks for a client that doesn't exist yet. */
export function missingForNewClient(input: OnboardInput): string[] {
  const missing: string[] = [];
  if (!input.businessName) missing.push('--name');
  if (!input.tier) missing.push('--tier');
  if (!input.agentPhone) missing.push('--agent-phone');
  if (!input.ownerMobile) missing.push('--owner-mobile');
  return missing.length ? [`New client needs: ${missing.join(', ')}`] : [];
}

/**
 * The column values to write. New client: everything, with plan defaults filled in.
 * Existing client: only what was given — plus the new plan's defaults when the tier changes
 * (e.g. a Base → Core upgrade) and no override was given.
 */
export function columnsToWrite(input: OnboardInput, existing: { tier: Tier } | null): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  const set = (col: string, v: unknown) => {
    if (v !== undefined) cols[col] = v;
  };
  set('business_name', input.businessName);
  set('tier', input.tier);
  set('agent_phone', input.agentPhone);
  set('owner_name', input.ownerName);
  set('owner_mobile', input.ownerMobile);
  set('owner_email', input.ownerEmail);
  set('elevenlabs_agent_id', input.agentId);
  set('review_link', input.reviewLink);

  const tierChanged = input.tier !== undefined && input.tier !== existing?.tier;
  const defaults = tierChanged && input.tier ? TIER_DEFAULTS[input.tier] : undefined;
  set('monthly_minutes_cap', input.minutesCap ?? defaults?.minutesCap);
  set('sms_allowance_segments', input.smsAllowanceSegments ?? defaults?.smsAllowanceSegments);
  set('sms_overage_cents', input.smsOverageCents ?? defaults?.smsOverageCents);

  if (!existing) {
    cols.slug = input.slug;
    cols.tnz_subaccount = input.slug; // SubAccount = slug, so TNZ bills per client
    cols.status = 'onboarding';
    cols.sms_mode = 'test';
  }
  if (input.goLive) {
    cols.status = 'active';
    cols.sms_mode = 'live';
  }
  return cols;
}
