/**
 * A COUPON'S WINDOW, AS DAYS — no React, tested in tests/couponDates.test.ts.
 *
 * The server always stored `starts_at`/`ends_at` and the Command Center
 * counts coupons «ending soon» from them, but the coupon form had no field
 * for either — so no merchant coupon ever had an end, and the count never
 * fired. The form speaks in days (`<input type="date">`); a start is the first
 * instant of its day and an end the last, in the merchant's own time.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-10-01` → the ISO instant that day starts (or, for an end, ends) locally; '' → null. */
export function dayToIso(day: string, edge: 'start' | 'end'): string | null {
  if (!DAY.test(day)) return null;
  const d = new Date(`${day}T${edge === 'start' ? '00:00:00' : '23:59:59'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** An ISO instant → the local day a date field shows; null → ''. */
export function isoToDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The form's two days are a window that can apply: an end on or after the start. */
export function windowProblem(startDay: string, endDay: string): 'end_before_start' | null {
  if (startDay && endDay && endDay < startDay) return 'end_before_start';
  return null;
}

export type CouponPhase =
  | { phase: 'ended'; at: string }
  | { phase: 'scheduled'; at: string }
  | { phase: 'ends'; at: string; soon: boolean }
  | { phase: 'open' };

/** Where a coupon is in its window right now. «Soon» is the Command Center's own seven days. */
export function couponPhase(c: { starts_at: string | null; ends_at: string | null }, now = Date.now(), soonDays = 7): CouponPhase {
  const ends = c.ends_at ? Date.parse(c.ends_at) : NaN;
  const starts = c.starts_at ? Date.parse(c.starts_at) : NaN;
  if (!Number.isNaN(ends) && ends < now) return { phase: 'ended', at: c.ends_at! };
  if (!Number.isNaN(starts) && starts > now) return { phase: 'scheduled', at: c.starts_at! };
  if (!Number.isNaN(ends)) return { phase: 'ends', at: c.ends_at!, soon: ends - now <= soonDays * 86_400_000 };
  return { phase: 'open' };
}
