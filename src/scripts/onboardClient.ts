// Onboard (or update) a client in one command — backlog D5.
//
//   node dist/scripts/onboardClient.js --slug smith-plumbing --name "Smith Plumbing" --tier core \
//     --agent-phone "09 555 1234" --owner-mobile "021 123 4567" --owner-name Dave \
//     --owner-email dave@smithplumbing.co.nz --agent-id agent_abc123
//
// Re-run with the same --slug to change anything (only the options given change).
// --go-live switches the client on (status active, TNZ Live) once everything is in place.
// --dry-run shows the changes without writing. --help lists every option.

import { closeDb, db, type ClientRow } from '../db.ts';
import { columnsToWrite, missingForNewClient, type OnboardInput, parseOnboardArgs, TIER_DEFAULTS, USAGE } from '../onboarding/settings.ts';
import { makeConnectLink } from '../routes/jobberOAuth.ts';

function fail(lines: string[]): never {
  for (const l of lines) console.error(`✗ ${l}`);
  console.error('\nRun with --help for every option.');
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const { input, errors } = parseOnboardArgs(argv);
  if (!input) fail(errors);

  const existing = (await db().query<ClientRow>('SELECT * FROM clients WHERE slug = $1', [input.slug])).rows[0] ?? null;
  const problems = existing ? [] : missingForNewClient(input);

  // Numbers and agents identify the client on every call, so they must be unique.
  if (input.agentPhone) {
    const other = await db().query<{ slug: string }>('SELECT slug FROM clients WHERE agent_phone = $1 AND slug <> $2', [input.agentPhone, input.slug]);
    if (other.rows[0]) problems.push(`--agent-phone ${input.agentPhone} already belongs to ${other.rows[0].slug}`);
  }
  if (input.agentId) {
    const other = await db().query<{ slug: string }>('SELECT slug FROM clients WHERE elevenlabs_agent_id = $1 AND slug <> $2', [input.agentId, input.slug]);
    if (other.rows[0]) problems.push(`--agent-id ${input.agentId} already belongs to ${other.rows[0].slug}`);
  }

  const tier = input.tier ?? existing?.tier;
  const jobber = existing
    ? (await db().query<{ status: string; jobber_account_name: string | null }>(
        'SELECT status, jobber_account_name FROM jobber_connections WHERE client_id = $1',
        [existing.id],
      )).rows[0] ?? null
    : null;

  if (input.goLive) problems.push(...goLiveBlockers(input, existing, tier, jobber?.status ?? null));
  if (problems.length) fail(problems);

  const cols = columnsToWrite(input, existing ? { tier: existing.tier } : null);
  printChanges(existing, cols);
  if (!Object.keys(cols).length) {
    console.log('Nothing to change.');
  } else if (input.dryRun) {
    console.log('\nDry run: nothing written.');
    return;
  } else {
    await write(existing, cols);
    console.log(existing ? `\n✓ Updated ${input.slug}` : `\n✓ Created ${input.slug}`);
  }

  const client = (await db().query<ClientRow>('SELECT * FROM clients WHERE slug = $1', [input.slug])).rows[0]!;
  printNextSteps(client, jobber);
}

function goLiveBlockers(input: OnboardInput, existing: ClientRow | null, tier: string | undefined, jobberStatus: string | null): string[] {
  const out: string[] = [];
  if (!existing) out.push('--go-live: create the client first, test it, then go live in a second run');
  if (!(input.agentId ?? existing?.elevenlabs_agent_id)) out.push('--go-live: no ElevenLabs agent ID (--agent-id)');
  if (!(input.agentPhone ?? existing?.agent_phone)) out.push('--go-live: no Twilio number (--agent-phone)');
  if (!(input.ownerMobile ?? existing?.owner_mobile)) out.push('--go-live: no owner mobile (--owner-mobile)');
  if (tier === 'core' && jobberStatus !== 'connected') out.push(`--go-live: Jobber isn't connected (${jobberStatus ?? 'never connected'})`);
  return out;
}

function printChanges(existing: ClientRow | null, cols: Record<string, unknown>) {
  const rows = Object.entries(cols).map(([field, value]) => ({
    field,
    was: existing ? String((existing as unknown as Record<string, unknown>)[field] ?? '') : '',
    now: String(value ?? ''),
  }));
  const changed = existing ? rows.filter((r) => r.was !== r.now) : rows;
  if (changed.length) console.table(changed);
}

async function write(existing: ClientRow | null, cols: Record<string, unknown>) {
  const names = Object.keys(cols);
  const values = Object.values(cols);
  if (existing) {
    const sets = names.map((n, i) => `${n} = $${i + 2}`).join(', ');
    await db().query(`UPDATE clients SET ${sets}, updated_at = now() WHERE id = $1`, [existing.id, ...values]);
  } else {
    const params = names.map((_, i) => `$${i + 1}`).join(', ');
    await db().query(`INSERT INTO clients (${names.join(', ')}) VALUES (${params})`, values);
  }
}

function printNextSteps(c: ClientRow, jobber: { status: string; jobber_account_name: string | null } | null) {
  const d = TIER_DEFAULTS[c.tier];
  console.log(`\n${c.business_name} (${c.slug}) — ${c.tier.toUpperCase()}, status ${c.status}, texts ${c.sms_mode === 'live' ? 'LIVE' : 'Test mode'}`);
  console.log(`  Twilio number ${c.agent_phone ?? '—'} · owner ${c.owner_name ?? ''} ${c.owner_mobile ?? '—'} · agent ${c.elevenlabs_agent_id ?? '—'}`);
  console.log(
    `  ${c.monthly_minutes_cap ?? d.minutesCap} mins/month · ${c.sms_allowance_segments ?? d.smsAllowanceSegments} SMS segments, then ${c.sms_overage_cents ?? d.smsOverageCents}c each · TNZ SubAccount ${c.tnz_subaccount ?? c.slug}`,
  );

  const steps: string[] = [];
  if (c.tier === 'core') {
    if (jobber?.status === 'connected') {
      steps.push(`Jobber connected (${jobber.jobber_account_name ?? 'account'}). Check it: node dist/scripts/jobberClients.js ${c.slug}`);
    } else {
      steps.push(`Send the client this Jobber connect link (valid 7 days):\n     ${makeConnectLink(c.id)}`);
      steps.push(`After they connect: node dist/scripts/jobberClients.js ${c.slug}`);
    }
    if (!c.review_link) steps.push('Add the Google review link when you have it: --review-link https://g.page/r/.../review');
  } else {
    steps.push('Base mode (no Jobber) is not built yet (backlog D1): run calls and texts on the Make.com interim path for now.');
  }
  if (!c.elevenlabs_agent_id) steps.push('Once the ElevenLabs agent exists: re-run with --agent-id agent_...');
  if (c.status !== 'active') {
    steps.push('ElevenLabs: import the Twilio number (region US1) and assign it to the agent; a preview call should greet with the business name.');
    steps.push(`When R3 tests pass: node dist/scripts/onboardClient.js --slug ${c.slug} --go-live`);
  }
  console.log('\nNext:');
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}

try {
  await main();
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
