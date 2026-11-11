/**
 * «المال والأرباح» → التكاليف — WHAT THE COSTS PAGES WORK OUT FOR THE SCREEN, PURE (redesign step 5, DECISIONS row 317).
 * The money is the server's; these only arrange it for reading. tests/financeCostsPages.test.ts holds each.
 */

/** A group's sale-time estimates per piece as one range: its lowest and highest (equal for one value); null when it has none. */
export function estimateRange(estimates: readonly number[]): { min: number; max: number } | null {
  const known = estimates.filter((v) => Number.isFinite(v));
  return known.length ? { min: Math.min(...known), max: Math.max(...known) } : null;
}
/** The range as the card writes it: «12,000–12,500», or one figure when the estimates agree; Latin digits. */
export const rangeFigures = (r: { min: number; max: number }) => (r.min === r.max ? r.min.toLocaleString('en-US') : `${r.min.toLocaleString('en-US')}–${r.max.toLocaleString('en-US')}`);

/**
 * Each value's share of their sum in percent, rounded to `decimals` places by the largest remainder, so the column adds up
 * to exactly 100 (one place: 100.0) — never 99.9 or 100.1 beside a total of 100%. Values below 0 count as 0; with nothing to
 * share (every value 0) every share is 0.
 */
export function sharePercents(values: readonly number[], decimals = 1): number[] {
  const safe = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)), sum = safe.reduce((a, b) => a + b, 0);
  if (!sum) return values.map(() => 0);
  const unit = 10 ** decimals, total = 100 * unit;
  const exact = safe.map((v) => (v * total) / sum), floor = exact.map(Math.floor);
  let left = total - floor.reduce((a, b) => a + b, 0);
  // The largest remainders take the units left; ties go to the larger value, then to the earlier row.
  const order = exact.map((x, i) => i).sort((a, b) => exact[b] - floor[b] - (exact[a] - floor[a]) || safe[b] - safe[a] || a - b);
  for (const i of order) { if (left <= 0) break; floor[i] += 1; left -= 1; }
  return floor.map((v) => v / unit);
}
/** A percent as the tables write it: one decimal place, Latin digits. */
export const percentText = (p: number, decimals = 1) => `${p.toFixed(decimals)}%`;

/**
 * «من يحمل الترويج»: the server's product shares with each one's share of the month's sales in percent (adding up to 100), and
 * the totals row — pieces, net sales and the promotion, which is the month's amount exactly because the shares are. A month
 * whose lines all sold at 0 (gifts) shares it equally by line on the server; its percents follow the shares instead.
 */
export function promotionTable<P extends { qty: number; sales_iqd: number; promotion_iqd: number }>(products: readonly P[]) {
  const percents = sharePercents(products.some((p) => p.sales_iqd > 0) ? products.map((p) => p.sales_iqd) : products.map((p) => p.promotion_iqd));
  return {
    rows: products.map((p, i) => ({ ...p, percent: percents[i] })),
    total: products.reduce((t, p) => ({ qty: t.qty + p.qty, sales_iqd: t.sales_iqd + p.sales_iqd, promotion_iqd: t.promotion_iqd + p.promotion_iqd }), { qty: 0, sales_iqd: 0, promotion_iqd: 0 }),
  };
}
