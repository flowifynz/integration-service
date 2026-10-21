// Jobber client + request operations used by the ElevenLabs tools.
// Field names checked against Jobber's schema via GraphQL introspection (API 2026-05-12):
//  - clients(searchTerm, searchFields: [PHONES], filter: { isArchived }) ; Client.phones { number }
//  - clientCreate(input: ClientCreateInput!) → { client, userErrors }
//      ClientCreateInput: firstName, lastName, phones [{ number, primary }], properties
//      [{ address: { street1, street2, city, province, postalCode, country } }], sourceAttribution { sourceText }
//  - requestCreate(input: RequestCreateInput!) → { request, userErrors }
//      RequestCreateInput: clientId!, propertyId, title, ...
//  - requestCreateNote(requestId, input: { message })
// Property address sub-fields on READ (street1, city) are assumed to mirror AddressAttributes;
// that query is isolated in findPropertyId() and failure there is non-fatal.

import { formatNational, toE164 } from '../phone.ts';
import { jobberQuery } from './graphql.ts';

export interface JobberClientMatch {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
}

interface UserError {
  message: string;
  path?: string[];
}

export class JobberUserError extends Error {
  readonly errors: UserError[];
  constructor(operation: string, errors: UserError[]) {
    super(`${operation} rejected: ${errors.map((e) => e.message).join('; ')}`);
    this.errors = errors;
  }
}

const FIND_BY_PHONE = /* GraphQL */ `
  query FlowifyFindByPhone($term: String!) {
    clients(first: 10, searchTerm: $term, searchFields: [PHONES], filter: { isArchived: false }) {
      nodes { id firstName lastName name phones { number } }
    }
  }
`;

/**
 * Jobber clients whose phone numbers include this exact number (E.164).
 * Jobber stores numbers as typed ("021 467 770", "0214677 70", "+64 21..."), and we don't know
 * how its search normalises them, so we search a few formats in parallel and then keep only
 * clients with a number that is exactly equal once normalised.
 */
export async function findClientsByPhone(
  clientId: string,
  e164: string,
  opts: { timeoutMs?: number } = {},
): Promise<JobberClientMatch[]> {
  const national = formatNational(e164); // '021 467 770'
  const terms = [...new Set([national.replace(/\s/g, ''), national, e164])];

  type Result = { clients: { nodes: Array<JobberClientMatch & { phones: Array<{ number: string }> }> } };
  const settled = await Promise.allSettled(terms.map((term) => jobberQuery<Result>(clientId, FIND_BY_PHONE, { term }, opts)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<Result> => s.status === 'fulfilled');
  if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;

  const byId = new Map<string, JobberClientMatch>();
  for (const { value } of ok) {
    for (const c of value.clients.nodes) {
      if (c.phones.some((p) => toE164(p.number) === e164)) {
        byId.set(c.id, { id: c.id, firstName: c.firstName, lastName: c.lastName, name: c.name });
      }
    }
  }
  return [...byId.values()];
}

/** Picks the client a caller most likely is: same first name if several share the number. */
export function pickClient(matches: JobberClientMatch[], spokenName?: string | null): JobberClientMatch | null {
  if (matches.length === 0) return null;
  if (matches.length === 1 || !spokenName) return matches[0]!;
  const first = spokenName.trim().split(/\s+/)[0]?.toLowerCase();
  return matches.find((m) => m.firstName.toLowerCase() === first) ?? matches[0]!;
}

const CLIENT_CREATE = /* GraphQL */ `
  mutation FlowifyClientCreate($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client { id firstName lastName name clientProperties(first: 1) { nodes { id } } }
      userErrors { message path }
    }
  }
`;

export async function createJobberClient(
  clientId: string,
  input: { firstName: string; lastName: string; e164: string | null; address: string | null },
): Promise<{ client: JobberClientMatch; propertyId: string | null }> {
  const data = await jobberQuery<{
    clientCreate: {
      client: (JobberClientMatch & { clientProperties: { nodes: Array<{ id: string }> } }) | null;
      userErrors: UserError[];
    };
  }>(
    clientId,
    CLIENT_CREATE,
    {
      input: {
        firstName: input.firstName,
        lastName: input.lastName,
        ...(input.e164 ? { phones: [{ number: formatNational(input.e164), primary: true }] } : {}),
        // The spoken address goes into street1 as one line; the tradie can tidy it in Jobber.
        ...(input.address ? { properties: [{ address: { street1: input.address, country: 'New Zealand' } }] } : {}),
        sourceAttribution: { sourceText: 'Flowify AI receptionist' },
      },
    },
    { timeoutMs: 8_000 },
  );
  const { client, userErrors } = data.clientCreate;
  if (userErrors.length || !client) throw new JobberUserError('clientCreate', userErrors);
  const { clientProperties, ...rest } = client;
  return { client: rest, propertyId: clientProperties.nodes[0]?.id ?? null };
}

const CLIENT_PROPERTIES = /* GraphQL */ `
  query FlowifyClientProperties($id: EncodedId!) {
    client(id: $id) { clientProperties(first: 20) { nodes { id address { street1 } } } }
  }
`;

/** Id of the client's property matching the spoken address, or null. Never throws. */
export async function findPropertyId(
  clientId: string,
  jobberClientId: string,
  matches: (street1: string) => boolean,
): Promise<string | null> {
  try {
    const data = await jobberQuery<{
      client: { clientProperties: { nodes: Array<{ id: string; address: { street1: string | null } | null }> } } | null;
    }>(clientId, CLIENT_PROPERTIES, { id: jobberClientId }, { timeoutMs: 5_000 });
    const props = data.client?.clientProperties.nodes ?? [];
    return props.find((p) => p.address?.street1 && matches(p.address.street1))?.id ?? null;
  } catch (err) {
    console.error('findPropertyId failed (continuing without property)', (err as Error).message);
    return null;
  }
}

const REQUEST_CREATE = /* GraphQL */ `
  mutation FlowifyRequestCreate($input: RequestCreateInput!) {
    requestCreate(input: $input) {
      request { id }
      userErrors { message path }
    }
  }
`;

const REQUEST_NOTE = /* GraphQL */ `
  mutation FlowifyRequestNote($requestId: EncodedId!, $input: RequestCreateNoteInput!) {
    requestCreateNote(requestId: $requestId, input: $input) {
      userErrors { message }
    }
  }
`;

export async function createJobberRequest(
  clientId: string,
  input: { jobberClientId: string; propertyId: string | null; title: string; note: string },
): Promise<{ requestId: string; noteSaved: boolean }> {
  const data = await jobberQuery<{ requestCreate: { request: { id: string } | null; userErrors: UserError[] } }>(
    clientId,
    REQUEST_CREATE,
    { input: { clientId: input.jobberClientId, title: input.title, ...(input.propertyId ? { propertyId: input.propertyId } : {}) } },
    { timeoutMs: 8_000 },
  );
  const { request, userErrors } = data.requestCreate;
  if (userErrors.length || !request) throw new JobberUserError('requestCreate', userErrors);

  // The note carries the full detail. If it fails the request still exists (with the title),
  // and the owner alert text has the details too.
  let noteSaved = true;
  try {
    const note = await jobberQuery<{ requestCreateNote: { userErrors: UserError[] } }>(
      clientId,
      REQUEST_NOTE,
      { requestId: request.id, input: { message: input.note } },
      { timeoutMs: 8_000 },
    );
    if (note.requestCreateNote.userErrors.length) throw new JobberUserError('requestCreateNote', note.requestCreateNote.userErrors);
  } catch (err) {
    noteSaved = false;
    console.error('requestCreateNote failed', (err as Error).message);
  }
  return { requestId: request.id, noteSaved };
}
