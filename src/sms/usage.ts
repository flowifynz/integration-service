// SMS allowance/overage arithmetic (pricing option A). Pure — unit tested.

export interface UsageInput {
  /** Segments counted against the allowance this month. */
  billableSegments: number;
  /** Included segments per month; null = unlimited. */
  allowance: number | null;
  /** Overage charge per segment, NZD cents ex GST; null = not charged. */
  overageCents: number | null;
}

export interface UsageBill {
  overageSegments: number;
  /** NZD ex GST, rounded to cents. */
  overageCharge: number;
  /** Share of the allowance used, 0–1+ (null if unlimited). */
  allowanceUsed: number | null;
}

export function billUsage(u: UsageInput): UsageBill {
  if (u.allowance === null) return { overageSegments: 0, overageCharge: 0, allowanceUsed: null };
  const overageSegments = Math.max(0, u.billableSegments - u.allowance);
  const overageCharge = Math.round(overageSegments * (u.overageCents ?? 0)) / 100;
  return {
    overageSegments,
    overageCharge,
    allowanceUsed: u.allowance > 0 ? u.billableSegments / u.allowance : null,
  };
}

/** 'YYYY-MM' → validated, or the previous month (the one you invoice for) by default. */
export function reportMonth(arg: string | undefined, now = new Date()): string {
  if (arg) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(arg)) throw new Error(`Month must be YYYY-MM, got "${arg}"`);
    return arg;
  }
  const nz = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit' }).format(now);
  const [y, m] = nz.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
