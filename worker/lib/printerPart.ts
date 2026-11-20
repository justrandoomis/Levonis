/**
 * «حصة الطابعة وحدها» — THE ONE DEFINITION (owner ruling R1, 2026-11-21; DECISIONS row 364).
 *
 * «shop only, the investor and staff on just printer the base [price after all promotion]; any services earn on new
 * column as profit from services is for shop».
 *
 * A printer line sold with services (order_items.services_snapshot) carries, inside its price, what the customer paid
 * for the warranty, Levo Care, packaging, inspection and the academy: `fee_iqd` per unit (the frozen fee AFTER the
 * package and PRO discounts — with the price anchor a Just Printer line froze 0, a Smart line the Smart fee, so the
 * printer's own part is the same in every package). That part is the SHOP'S. Investors' shares and staff commission
 * (profit-% and revenue-%) are counted on the printer's own part only:
 *
 *     gross              = qty × snapshot.fee_iqd
 *     services_net       = min(gross, floor(net_goods × gross / line_total))          the breakdown, before returns
 *     services_retained  = min(gross, floor(retained_revenue × gross / line_total))   «ربح الخدمات» (never negative)
 *     printer_part       = retained_revenue − services_retained                       what investors and staff read
 *
 * (each 0 when the line holds no services, has no line total, or keeps nothing). So everything that lowered the line —
 * a line coupon, the member's discount, points, an accepted price change, a refund — is carried by the printer and its
 * services IN PROPORTION to their share of the line's price, exactly as the report's breakdown has split them since
 * phase 3 (splitServicedLine). What the engines deduct AFTER the line (the goods cost, the wages, the courier, the
 * month's general expenses, an order-level coupon, price protection) stays wholly on the printer's part, as it would
 * for a printer bought without services. Services have no goods cost: their profit is their retained income (what a
 * warranty or Care claim later costs is a general expense of its own day, ruling R3).
 *
 * NOTHING ALREADY COUNTED IS RESTATED, AND NO ACCRUED WAGE OR HELD PAYOUT MOVES. Services went on sale on 2026-11-19;
 * the rule governs orders CREATED (placed) on or after `PRINTER_PART_FROM_DAY` (Baghdad day). An order placed before it
 * keeps the basis it has always had (the whole line) for its whole life — delivered before or after the day, with a
 * wage already accrued at an earlier milestone (`prepared`) or not, held in an open payout or not, whatever recomputes
 * it later. A line without a services snapshot is untouched on any day: every figure and every stored snapshot of it
 * is byte-identical.
 *
 * WHAT THE RULE DOES NOT TOUCH: the investor's own money. Capital recovery and the «is this sale a loss?» test read the
 * WHOLE retained line, as they always did (investorFinance.ts): only the PROFIT that is shared is counted on the
 * printer's part. A printer sold above its cost returns the whole principal and records no loss even when its own part
 * is below the cost (the profit share is then 0).
 *
 * AN ORDER-LEVEL COUPON (the part of a code no line carries, financeReportOverlay) is shared like a line coupon: the
 * line's share of it comes off what the line retains BEFORE the services' part is taken (participantProfit.ts), so a
 * 10% code costs the participants the same whether it was stored on the line or on the order.
 *
 * Pure, no imports: read by participantProfit, investorFinance, financeWageCalculation, orderFinance and printerFinance.
 */
type Row = Record<string, unknown>;
const num = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
};

/**
 * The first Baghdad day whose NEW ORDERS are shared on the printer's own part. It must be a Baghdad day strictly after
 * the day the code is deployed; bump it before pushing if the push slips (an order placed on this day before the deploy
 * hour would otherwise be recomputed once).
 */
export const PRINTER_PART_FROM_DAY = '2026-11-22';

/**
 * Ruling R3: a warranty / Levo Care claim cost is a general expense of the SHOP on its cost day — it leaves the
 * participants' general-expense spread (and its fingerprint) from this expense day on. A claim cost dated earlier
 * (claims went live 2026-11-18) stays where it was counted, so no stored share or fingerprint changes.
 */
export const CLAIM_COSTS_OUT_OF_SHARES_FROM_DAY = PRINTER_PART_FROM_DAY;
export const CLAIM_EXPENSE_CATEGORIES = ['exp_warranty_claims', 'exp_care_claims'] as const;
/** SQL: true for an operating_expenses row `alias` that is a claim cost the participants no longer carry. Literals only. */
export const claimCostOutOfSharesSql = (alias = 'e') =>
  `(${alias}.category_id IN (${CLAIM_EXPENSE_CATEGORIES.map((c) => `'${c}'`).join(',')}) AND ${alias}.expense_day>='${CLAIM_COSTS_OUT_OF_SHARES_FROM_DAY}')`;

/** floor(a × b / c) for non-negative integers, exact past 2^53. */
const mulDivFloor = (a: number, b: number, c: number) => Number((BigInt(Math.trunc(a)) * BigInt(Math.trunc(b))) / BigInt(Math.trunc(c)));

export interface ServicesSnapshotView {
  /** The per-unit services fee charged inside the line price (after package and PRO discounts), ≥ 0. */
  fee: number;
  /** The anchor's fee per unit (the Smart package inside the catalogue price); 0 when the line is not anchored. */
  anchor_fee: number;
  /** What the PRO services discount took off the services, per unit (0 when none). */
  pro_discount: number;
  package: string | null;
  lines: Array<{ service: string; choice: string; fee_iqd: number }>;
}
/** The frozen services of a line, tolerant of garbage; null when the line holds none. */
export function servicesSnapshotOf(raw: unknown): ServicesSnapshotView | null {
  if (typeof raw !== 'string' || !raw) return null;
  let v: Row | null = null;
  try { v = JSON.parse(raw) as Row; } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const lines = Array.isArray(v.lines) ? (v.lines as Row[]) : [];
  const pro = (v.pro_discount && typeof v.pro_discount === 'object' ? v.pro_discount : null) as Row | null;
  const selection = (v.selection && typeof v.selection === 'object' ? v.selection : null) as Row | null;
  const pkg = v.package ?? selection?.package ?? null;
  return {
    fee: Math.max(0, num(v.fee_iqd)),
    anchor_fee: Math.max(0, num(v.anchor_fee_iqd)),
    pro_discount: Math.max(0, num(pro?.services_iqd)),
    package: typeof pkg === 'string' && pkg ? pkg : null,
    lines: lines.map((l) => ({ service: String(l?.service ?? ''), choice: String(l?.choice ?? ''), fee_iqd: Math.max(0, num(l?.fee_iqd)) })),
  };
}

/** The services' share of `amount` of a line: min(gross, floor(amount × gross / line_total)); 0 when nothing can be shared. */
export function servicesShareOf(amount: number, gross: number, lineTotal: number): number {
  return lineTotal > 0 && amount > 0 && gross > 0 ? Math.min(gross, mulDivFloor(amount, gross, lineTotal)) : 0;
}

export interface PrinterPart {
  serviced: boolean;
  /** qty × the frozen per-unit fee. */
  services_gross_iqd: number;
  /** The services' share of the line's net goods (before returns) — the phase 3 breakdown figure. */
  services_net_iqd: number;
  /** The services' share of what the line RETAINS (net goods − refunds): «ربح الخدمات». */
  services_retained_iqd: number;
  /** retained revenue − services_retained: the printer's own part, the base of investors and staff. */
  printer_part_retained_iqd: number;
}
/**
 * One line's printer part. `retained_revenue_iqd` absent (a line the profit engine has not refreshed) reads
 * net_goods_iqd − refund_iqd. Unserviced: services 0, the printer part IS the retained revenue.
 */
export function printerPartOf(line: { qty?: unknown; line_total_iqd?: unknown; net_goods_iqd?: unknown; retained_revenue_iqd?: unknown; refund_iqd?: unknown; services_snapshot?: unknown }): PrinterPart {
  const snap = servicesSnapshotOf(line.services_snapshot);
  const net = num(line.net_goods_iqd);
  const kept = line.retained_revenue_iqd === undefined || line.retained_revenue_iqd === null ? net - num(line.refund_iqd) : num(line.retained_revenue_iqd);
  if (!snap) return { serviced: false, services_gross_iqd: 0, services_net_iqd: 0, services_retained_iqd: 0, printer_part_retained_iqd: kept };
  const gross = Math.max(0, num(line.qty)) * snap.fee, total = num(line.line_total_iqd);
  const retained = servicesShareOf(kept, gross, total);
  return { serviced: true, services_gross_iqd: gross, services_net_iqd: servicesShareOf(net, gross, total), services_retained_iqd: retained, printer_part_retained_iqd: kept - retained };
}

/** The Baghdad day of a stored instant (ISO or SQLite UTC text); null when absent or unreadable. */
function baghdadDayOf(stamp: unknown): string | null {
  if (!stamp) return null;
  const value = String(stamp);
  const at = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(at.getTime()) ? null : new Date(at.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}
/**
 * Does the printer-part rule govern this order's shares? Only an order PLACED on or after the first day — so nothing
 * accrued, snapshotted or held for an older order can change because of this rule. (An order row without a creation
 * instant is read by its delivery; with neither it is a new order.)
 */
export function printerPartRuleApplies(order: Row): boolean {
  const day = baghdadDayOf(order.created_at) ?? baghdadDayOf(order.delivered_at);
  return day === null || day >= PRINTER_PART_FROM_DAY;
}
/**
 * What the participants (investors, staff on a percentage) do NOT count of this line: the services' retained part
 * when the rule governs the order, else 0. THE call every share engine makes.
 */
export function servicesOutOfShares(order: Row, line: Parameters<typeof printerPartOf>[0]): number {
  if (!line.services_snapshot || !printerPartRuleApplies(order)) return 0;
  return printerPartOf(line).services_retained_iqd;
}
