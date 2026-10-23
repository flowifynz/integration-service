// Shared by the create_request tool (during the call) and the post-call safety net (after it):
// match the caller to a Jobber client by phone (or create one) and log a request with a note.

import { type ClientRow, db } from '../db.ts';
import { addressMatches, type PhoneSource, requestNote, requestTitle, splitName, type Urgency } from '../jobber/callerText.ts';
import { createJobberClient, createJobberRequest, findClientsByPhone, findPropertyId, pickClient } from '../jobber/clients.ts';
import { toE164 } from '../phone.ts';

export interface LogRequestInput {
  name: string;
  /** Who they are: caller ID, else the number they said (E.164). */
  matchPhone: string | null;
  /** Where to call back, formatted for reading. */
  callbackDisplay: string | null;
  phoneSource: PhoneSource;
  address: string | null;
  description: string;
  urgency: Urgency;
  /** Logged by the post-call safety net rather than during the call. */
  afterCall?: boolean;
  /** Budget for the phone lookup: tight during a call, relaxed after. */
  lookupTimeoutMs?: number;
}

/** Returns the Jobber request ID. Throws if Jobber fails. */
export async function logJobberRequest(client: ClientRow, i: LogRequestInput): Promise<string> {
  const matches = i.matchPhone ? await findClientsByPhone(client.id, i.matchPhone, { timeoutMs: i.lookupTimeoutMs ?? 4_000 }) : [];
  const existing = pickClient(matches, i.name);
  let jobberClientId: string;
  let propertyId: string | null = null;
  if (existing) {
    jobberClientId = existing.id;
    if (i.address) propertyId = await findPropertyId(client.id, existing.id, (street1) => addressMatches(i.address, street1));
  } else {
    const created = await createJobberClient(client.id, { ...splitName(i.name), e164: i.matchPhone, address: i.address });
    jobberClientId = created.client.id;
    propertyId = created.propertyId;
  }
  const result = await createJobberRequest(client.id, {
    jobberClientId,
    propertyId,
    title: requestTitle(i.description, i.urgency),
    note: requestNote({
      callerName: i.name,
      callbackPhone: i.callbackDisplay,
      phoneSource: i.phoneSource,
      address: i.address,
      description: i.description,
      urgency: i.urgency,
      addressOnFile: Boolean(propertyId),
      afterCall: i.afterCall,
    }),
  });
  return result.requestId;
}

/** The Flowify client a call belongs to: by dialled number, else by ElevenLabs agent ID. */
export async function resolveClient(body: { called_number?: unknown; agent_id?: unknown }): Promise<ClientRow | null> {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const dialled = toE164(s(body.called_number));
  if (dialled) {
    const { rows } = await db().query<ClientRow>(`SELECT * FROM clients WHERE agent_phone = $1 AND status IN ('active', 'onboarding')`, [
      dialled,
    ]);
    if (rows[0]) return rows[0];
  }
  const agentId = s(body.agent_id);
  if (agentId) {
    const { rows } = await db().query<ClientRow>(
      `SELECT * FROM clients WHERE elevenlabs_agent_id = $1 AND status IN ('active', 'onboarding')`,
      [agentId],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}
