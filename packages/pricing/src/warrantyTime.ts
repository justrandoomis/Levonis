/**
 * WARRANTY TIME, AS A PERSON SAYS IT — pure, no I/O, shared by the warranty
 * screens, the trade-in screens and the tests.
 */
const DAY_MS = 86_400_000;

/** Calendar-month addition, UTC, clamped to the target month's last day (worker/lib/membershipOps.ts `addMonths`). */
function plusMonths(fromMs: number, months: number): number {
  const d = new Date(fromMs);
  const day = d.getUTCDate();
  const t = new Date(fromMs);
  t.setUTCDate(1);
  t.setUTCMonth(t.getUTCMonth() + months);
  const daysInTarget = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, daysInTarget));
  return t.getTime();
}

/**
 * WHAT IS LEFT OF A WARRANTY, AS A PERSON SAYS IT (owner decision 3,
 * 2026-10-09): whole calendar months from now, then the remaining whole days,
 * until the end date. The owner's example — twelve months from delivery,
 * traded in thirty days later — reads «11 months 0 days» (where the rounded-up
 * `warrantyMonthsLeft` says 12). DISPLAY ONLY: the valuation keeps its own
 * rounding, which is a money rule. Zero and zero once the end has passed.
 */
export function warrantyTimeLeft(endIso: string | null | undefined, nowIso: string): { months: number; days: number } {
  const end = endIso ? Date.parse(endIso) : NaN;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(end) || !Number.isFinite(now) || end <= now) return { months: 0, days: 0 };
  let months = 0;
  while (months < 600 && plusMonths(now, months + 1) <= end) months++;
  const days = Math.floor((end - plusMonths(now, months)) / DAY_MS);
  return { months, days };
}
