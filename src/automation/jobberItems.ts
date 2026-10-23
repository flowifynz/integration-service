// Jobber reads for build step 4. Field names checked against Jobber's schema via
// introspection (API 2026-05-12): Visit, Quote (quoteStatus, sentAt, clientHubUri),
// Invoice (invoiceStatus, dueDate, clientHubUri), Job (jobStatus, completedAt,
// allowReviewRequest), Client (receivesReminders / receivesQuoteFollowUps /
// receivesInvoiceFollowUps / receivesReviewRequests), PropertyAddress (street1, city).
//
// ⚠ Unverified: the sub-fields of Iso8601DateTimeRangeInput used to filter visits by date.
// I've used { after, before }. If visitsStartingBetween() errors, run
// `node dist/scripts/tomorrowVisits.js <slug>` and send Claude the error.

import { jobberQuery } from '../jobber/graphql.ts';

const WORKER_TIMEOUT = { timeoutMs: 15_000 };

const CLIENT_FIELDS = `id firstName companyName isCompany phones { number primary }`;

export interface JobberClientLite {
  id: string;
  firstName: string | null;
  companyName: string | null;
  isCompany: boolean;
  phones: Array<{ number: string; primary: boolean | null }>;
}

export interface VisitItem {
  id: string;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  isComplete: boolean;
  isRecurring: boolean;
  client: JobberClientLite & { receivesReminders: boolean };
  property: { address: { street1: string | null; city: string | null } | null } | null;
}

const VISIT_FIELDS = `id startAt endAt allDay isComplete isRecurring
  client { ${CLIENT_FIELDS} receivesReminders }
  property { address { street1 city } }`;

export async function getVisit(clientId: string, id: string): Promise<VisitItem | null> {
  const data = await jobberQuery<{ visit: VisitItem | null }>(
    clientId,
    `query FlowifyVisit($id: EncodedId!) { visit(id: $id) { ${VISIT_FIELDS} } }`,
    { id },
    WORKER_TIMEOUT,
  );
  return data.visit;
}

/** All visits starting in [fromIso, toIso). Dates are inlined (we generate them) so we don't depend on the scalar's name. */
export async function visitsStartingBetween(clientId: string, fromIso: string, toIso: string): Promise<VisitItem[]> {
  const out: VisitItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: { visits: { nodes: VisitItem[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await jobberQuery(
      clientId,
      `query FlowifyVisitsBetween($cursor: String) {
        visits(first: 50, after: $cursor, filter: { startAt: { after: ${JSON.stringify(fromIso)}, before: ${JSON.stringify(toIso)} } }) {
          nodes { ${VISIT_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor },
      WORKER_TIMEOUT,
    );
    out.push(...data.visits.nodes);
    if (!data.visits.pageInfo.hasNextPage) break;
    cursor = data.visits.pageInfo.endCursor;
  }
  return out;
}

export interface QuoteItem {
  id: string;
  quoteNumber: string;
  quoteStatus: string;
  sentAt: string | null;
  clientHubUri: string | null;
  client: (JobberClientLite & { receivesQuoteFollowUps: boolean }) | null;
}

export async function getQuote(clientId: string, id: string): Promise<QuoteItem | null> {
  const data = await jobberQuery<{ quote: QuoteItem | null }>(
    clientId,
    `query FlowifyQuote($id: EncodedId!) {
      quote(id: $id) { id quoteNumber quoteStatus sentAt clientHubUri client { ${CLIENT_FIELDS} receivesQuoteFollowUps } }
    }`,
    { id },
    WORKER_TIMEOUT,
  );
  return data.quote;
}

export interface InvoiceItem {
  id: string;
  invoiceNumber: string;
  invoiceStatus: string;
  dueDate: string | null;
  clientHubUri: string | null;
  client: (JobberClientLite & { receivesInvoiceFollowUps: boolean }) | null;
}

export async function getInvoice(clientId: string, id: string): Promise<InvoiceItem | null> {
  const data = await jobberQuery<{ invoice: InvoiceItem | null }>(
    clientId,
    `query FlowifyInvoice($id: EncodedId!) {
      invoice(id: $id) { id invoiceNumber invoiceStatus dueDate clientHubUri client { ${CLIENT_FIELDS} receivesInvoiceFollowUps } }
    }`,
    { id },
    WORKER_TIMEOUT,
  );
  return data.invoice;
}

export interface JobItem {
  id: string;
  jobStatus: string;
  completedAt: string | null;
  allowReviewRequest: boolean;
  client: JobberClientLite & { receivesReviewRequests: boolean };
}

export async function getJob(clientId: string, id: string): Promise<JobItem | null> {
  const data = await jobberQuery<{ job: JobItem | null }>(
    clientId,
    `query FlowifyJob($id: EncodedId!) {
      job(id: $id) { id jobStatus completedAt allowReviewRequest client { ${CLIENT_FIELDS} receivesReviewRequests } }
    }`,
    { id },
    WORKER_TIMEOUT,
  );
  return data.job;
}
