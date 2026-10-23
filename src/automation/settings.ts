// Per-client automation settings (clients.automation jsonb), merged over defaults. Pure.

export interface AutomationSettings {
  /** Text when a visit is booked or moved. */
  confirmations: boolean;
  /** Minutes to wait after a visit change before confirming, so quick edits coalesce. */
  confirmationDelayMinutes: number;
  /** Day-before reminders (sent by the 6pm nightly run). */
  reminders: boolean;
  /** Follow up quotes still awaiting a response this many days after sending. */
  quoteFollowUps: boolean;
  quoteFollowUpDays: number;
  /** Follow up unpaid invoices this many days after their due date. */
  invoiceFollowUps: boolean;
  invoiceFollowUpDays: number[];
  /** Ask for a review after a job closes (needs clients.review_link). */
  reviewRequests: boolean;
  reviewDelayMinutes: number;
  /** Don't ask the same customer again within this many days. */
  reviewCooldownDays: number;
  /** Ignore items older than this when first seen (bulk-closing old jobs, old invoices). */
  staleAfterDays: number;
  /** Don't confirm visits booked further ahead than this (reminders still go). */
  confirmWithinDays: number;
  /** Thank-you text to a caller after a new-job call (T1). */
  callerConfirmations: boolean;
}

export const DEFAULT_AUTOMATION: AutomationSettings = {
  confirmations: true,
  confirmationDelayMinutes: 3,
  reminders: true,
  quoteFollowUps: true,
  quoteFollowUpDays: 3,
  invoiceFollowUps: true,
  invoiceFollowUpDays: [1, 7],
  reviewRequests: true,
  reviewDelayMinutes: 120,
  reviewCooldownDays: 180,
  staleAfterDays: 3,
  confirmWithinDays: 60,
  callerConfirmations: true,
};

export function automationSettings(raw: unknown): AutomationSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_AUTOMATION };
  for (const key of Object.keys(DEFAULT_AUTOMATION) as Array<keyof AutomationSettings>) {
    const v = o[key];
    const d = DEFAULT_AUTOMATION[key];
    if (typeof d === 'boolean' && typeof v === 'boolean') (out[key] as boolean) = v;
    else if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v) && v >= 0) (out[key] as number) = v;
    else if (Array.isArray(d) && Array.isArray(v) && v.every((n) => typeof n === 'number' && n >= 0)) (out[key] as number[]) = v as number[];
  }
  return out;
}
