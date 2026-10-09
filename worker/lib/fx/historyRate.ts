/**
 * THE SHOP'S USD/IQD AS IT WAS AT A GIVEN MOMENT — for the IQD/USD display
 * toggle of «الأرباح والتكاليف» (design P-A §8; owner brief 2026-10-09,
 * "Accounting Currency": «للسجلات التاريخية استخدم exchange_rate_snapshot الخاص
 * بوقت العملية إذا كان موجوداً»).
 *
 * The figure is the shop's EFFECTIVE USD/IQD (market sell + the owner's
 * adjustment, owner decision 5) that was in force at the time — read from the
 * append-only `fx_rate_log`: the `effective_after` of the newest row at or
 * before that moment whose effective value actually changed. Older than the
 * first applied value, the caller falls back to TODAY's effective rate and
 * marks it «≈»; with no applied rate at all, USD is unavailable. It is never
 * the wallet's 1 USD = 1,400 IQD (`orders.exchange_rate`, owner decision 9)
 * and never a purchase document's rate.
 *
 * DISPLAY ONLY. Nothing here is written, and no IQD amount is ever re-derived
 * from it: the accounting stays in the dinars recorded at the time.
 *
 * Reads, in ONE `db.batch` (one snapshot), on idx_fx_rate_log_pair:
 *   1. the newest change row at or before the anchor (the rate in force then);
 *   2. every change row after the anchor up to `toIso` (capped);
 *   3. today's effective USD/IQD from `fx_rate_pairs`.
 * It names no order, line, lot or wallet table (tests/pricingCurrencyRoles):
 * the caller passes instants it already holds. Without migration 0179, or on
 * any read error, it answers null and the page stays in dinars. Never throws.
 */
const DECIMAL = /^[0-9]{1,12}(\.[0-9]{1,12})?$/;
/** Generous: a rate changes at most every few hours, so a year is ~1,500 rows. */
const MAX_STEPS = 5000;

export interface UsdRateStep {
  /** When this value came into force, epoch ms. */
  at: number;
  /** IQD per 1 USD, exact decimal text. */
  rate: string;
}
export interface UsdRateSteps {
  /** Ascending by time. Empty before the first applied value. */
  steps: UsdRateStep[];
  /** Today's effective USD/IQD, or null before the first approval. */
  today: string | null;
}
export type UsdBasis = 'at_time' | 'today';

const SELECT = `SELECT effective_after AS rate, created_at FROM fx_rate_log
  WHERE pair = 'USD_IQD' AND effective_after IS NOT NULL AND effective_after IS NOT effective_before`;

function step(row: { rate?: unknown; created_at?: unknown } | undefined): UsdRateStep | null {
  if (!row || typeof row.rate !== 'string' || !DECIMAL.test(row.rate)) return null;
  const at = Date.parse(String(row.created_at ?? ''));
  return Number.isFinite(at) ? { at, rate: row.rate } : null;
}

export async function loadUsdRateSteps(db: D1Database, anchorIso: string, toIso: string): Promise<UsdRateSteps | null> {
  try {
    const [before, within, today] = await db.batch<Record<string, unknown>>([
      db.prepare(`${SELECT} AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(anchorIso),
      db.prepare(`${SELECT} AND created_at > ? AND created_at <= ? ORDER BY created_at, rowid LIMIT ${MAX_STEPS}`).bind(anchorIso, toIso),
      db.prepare("SELECT effective_rate AS rate FROM fx_rate_pairs WHERE pair = 'USD_IQD'"),
    ]);
    const steps: UsdRateStep[] = [];
    for (const row of [...(before.results ?? []), ...(within.results ?? [])]) {
      const s = step(row);
      if (s) steps.push(s);
    }
    steps.sort((a, b) => a.at - b.at);
    const t = today.results?.[0]?.rate;
    return { steps, today: typeof t === 'string' && DECIMAL.test(t) ? t : null };
  } catch {
    return null;
  }
}

/**
 * The rate in force at `atMs`: the last step at or before it (`at_time`);
 * otherwise today's rate (`today`, shown «≈»); otherwise null (no USD).
 */
export function usdRateAt(steps: UsdRateSteps | null, atMs: number | null): { rate: string; basis: UsdBasis } | null {
  if (!steps) return null;
  if (atMs !== null && Number.isFinite(atMs)) {
    let lo = 0, hi = steps.steps.length - 1, found: UsdRateStep | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (steps.steps[mid]!.at <= atMs) {
        found = steps.steps[mid]!;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found) return { rate: found.rate, basis: 'at_time' };
  }
  return steps.today ? { rate: steps.today, basis: 'today' } : null;
}
