// Monthly SMS usage per client, for invoicing overage (pricing option A).
//   node dist/scripts/smsUsage.js            → last month (NZ time)
//   node dist/scripts/smsUsage.js 2026-11    → a given month
//   node dist/scripts/smsUsage.js 2026-11 --csv   → CSV for your invoicing spreadsheet / Xero
//
// Counts texts TNZ accepted (status 'sent') by the NZ-time month they were sent.
// Segments come from TNZ's result webhook (SMSParts); before a result arrives a text counts
// as 1. Cost is TNZ's Price; if TNZ didn't send one, it's estimated as segments × the
// optional TNZ_SEGMENT_COST_NZD env var and marked estimated.
// Owner alerts are Flowify's own cost: shown, but not counted against the allowance.
// Compare the per-client cost column with TNZ's invoice summarised by SubAccount.

import { closeDb, db } from '../db.ts';
import { BILLABLE_DEPARTMENTS } from '../sms/compose.ts';
import { billUsage, reportMonth } from '../sms/usage.ts';

const args = process.argv.slice(2);
const csv = args.includes('--csv');
const month = reportMonth(args.find((a) => !a.startsWith('--')));
const fallbackRate = process.env.TNZ_SEGMENT_COST_NZD ? Number(process.env.TNZ_SEGMENT_COST_NZD) : null;

interface Row {
  slug: string;
  business_name: string;
  sms_allowance_segments: number | null;
  sms_overage_cents: string | null;
  texts: string;
  segments: string;
  billable_segments: string;
  owner_alert_segments: string;
  cost: string | null;
  unpriced_segments: string;
  undelivered: string;
}

const { rows } = await db().query<Row>(
  `SELECT c.slug, c.business_name, c.sms_allowance_segments, c.sms_overage_cents,
          count(m.id)                                                        AS texts,
          coalesce(sum(coalesce(m.sms_parts, 1)), 0)                         AS segments,
          coalesce(sum(coalesce(m.sms_parts, 1)) FILTER (WHERE m.department = ANY($2)), 0) AS billable_segments,
          coalesce(sum(coalesce(m.sms_parts, 1)) FILTER (WHERE m.department = 'owner-alerts'), 0) AS owner_alert_segments,
          sum(m.price)                                                       AS cost,
          coalesce(sum(coalesce(m.sms_parts, 1)) FILTER (WHERE m.price IS NULL), 0) AS unpriced_segments,
          count(m.id) FILTER (WHERE m.delivery_status IS NOT NULL AND m.delivery_status NOT ILIKE 'success%') AS undelivered
     FROM clients c
     LEFT JOIN messages m
       ON m.client_id = c.id
      AND m.status = 'sent'
      AND (m.sent_at AT TIME ZONE 'Pacific/Auckland') >= ($1 || '-01')::date
      AND (m.sent_at AT TIME ZONE 'Pacific/Auckland') <  (($1 || '-01')::date + interval '1 month')
    GROUP BY c.id
    ORDER BY c.slug`,
  [month, BILLABLE_DEPARTMENTS],
);

const report = rows.map((r) => {
  const billable = Number(r.billable_segments);
  const bill = billUsage({
    billableSegments: billable,
    allowance: r.sms_allowance_segments,
    overageCents: r.sms_overage_cents === null ? null : Number(r.sms_overage_cents),
  });
  const known = r.cost === null ? 0 : Number(r.cost);
  const estimated = fallbackRate !== null ? Number(r.unpriced_segments) * fallbackRate : 0;
  return {
    client: r.slug,
    texts: Number(r.texts),
    segments: Number(r.segments),
    billable: billable,
    allowance: r.sms_allowance_segments ?? 'unlimited',
    used: bill.allowanceUsed === null ? '' : `${Math.round(bill.allowanceUsed * 100)}%`,
    overage_segs: bill.overageSegments,
    overage_nzd: bill.overageCharge.toFixed(2),
    owner_alerts: Number(r.owner_alert_segments),
    tnz_cost_nzd: (known + estimated).toFixed(2) + (Number(r.unpriced_segments) > 0 ? (fallbackRate !== null ? ' (part est.)' : ' (incomplete)') : ''),
    undelivered: Number(r.undelivered),
  };
});

if (csv) {
  const cols = Object.keys(report[0] ?? { client: '' });
  console.log(cols.join(','));
  for (const r of report) console.log(cols.map((c) => JSON.stringify((r as Record<string, unknown>)[c] ?? '')).join(','));
} else {
  console.log(`SMS usage for ${month} (NZ time). Costs NZD as charged by TNZ; overage ex GST.`);
  console.table(report);
}
await closeDb();
