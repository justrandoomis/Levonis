import type { DisplayUsdSummary, FinanceKnownPart, FinanceSummary, UsdKnownPart } from './types';

/**
 * THE OVERVIEW'S HEADLINE, AS DATA (redesign step 1, DECISIONS row 313).
 *
 * «صافي حصتك» is what the owner keeps: after the order coupon, credited price
 * protection and a returned trade-in credit, exactly as every staff and investor
 * share is already worked out. While some orders of the period are incomplete it
 * shows what the complete orders say (`known`), and says so. The sale-time
 * estimates stay in the net, always named (owner 2026-11-11): the part that rests
 * on confirmed costs and the part from orders with at least one estimated line.
 * Pure, so a test can hold it; the component only words it.
 */
export interface OverviewNet {
  net: number | null;
  /** USD cents for the same figure; undefined = stay in dinars. */
  cents: number | null | undefined;
  /** The figure is the complete orders' only (the period has incomplete orders). */
  fromKnown: boolean;
  /** What the margin is taken over: the complete orders' revenue on the known path. */
  marginBase: number | null | undefined;
  /** `cents`: the part in USD cents (undefined: dinars; null: the server sent none, and a dollar note leaves the amount out). */
  confirmed: { orders: number; net: number | null; cents: number | null | undefined } | null;
  estimated: { orders: number; net: number | null; cents: number | null | undefined } | null;
  /**
   * What came off the figure shown: the coupons, credited price protection and returned
   * trade-in credits of the orders the headline is made of — on the known path the
   * complete orders' own, never an incomplete order's (review R2). 0 when nothing came
   * off, or when there is no figure for it to come off.
   */
  deductions: number;
  /** The same in USD cents (undefined: dinars; null: the server sent no cents for it). */
  deductionsCents: number | null | undefined;
  /** review: something is unknown; estimated: complete but resting partly on estimates; confirmed: all costs confirmed. */
  state: 'review' | 'estimated' | 'confirmed';
}

const partNet = (p: FinanceKnownPart) => (p.net_after_report_adjustments_iqd !== undefined ? p.net_after_report_adjustments_iqd : p.owner_net_iqd);
/** What lies between a figure before the deductions and the same figure after them; null when either is missing. */
const between = (before: number | null | undefined, after: number | null | undefined) => (before == null || after == null ? null : before - after);
const total = (values: Array<number | null | undefined>) => (values.some((v) => v == null) ? null : values.reduce<number>((a, v) => a + (v as number), 0));

export function overviewNet(data: FinanceSummary, usd?: DisplayUsdSummary): OverviewNet {
  const t = data.totals, known = data.known ?? undefined;
  const afterDeductions = t.owner_period_net_after_report_adjustments_iqd;
  // A server that predates the after-deductions field still answers the figure before them.
  const full = afterDeductions !== undefined ? afterDeductions : t.owner_period_net_iqd !== undefined ? t.owner_period_net_iqd : t.owner_net_iqd ?? null;
  const knownNet = known ? (known.net_after_report_adjustments_iqd !== undefined ? known.net_after_report_adjustments_iqd : known.owner_net_iqd) : null;
  const fromKnown = full == null && !!known && known.incomplete_orders > 0 && knownNet != null;
  const net = full ?? (fromKnown ? knownNet : null);
  const ut = usd?.totals, uk = usd?.known;
  const cents = !ut ? undefined
    : fromKnown ? (uk ? (uk.net_after_report_adjustments_cents !== undefined ? uk.net_after_report_adjustments_cents : uk.owner_net_cents) ?? null : null)
      : (afterDeductions !== undefined ? ut.owner_period_net_after_report_adjustments_cents : t.owner_period_net_iqd !== undefined ? ut.owner_period_net_cents : ut.owner_net_cents) ?? null;
  // The complete orders' two known figures carry the same share of the overhead, so what lies
  // between them is exactly their own deductions; the period's figure took off every order's.
  const deductions = net == null ? 0
    : fromKnown ? between(known!.owner_net_iqd, known!.net_after_report_adjustments_iqd) ?? 0
      : afterDeductions !== undefined ? (t.coupon_iqd ?? 0) + (t.price_protection_iqd ?? 0) + (t.trade_in_credit_returned_iqd ?? 0) : 0;
  const deductionsCents = !ut ? undefined : deductions === 0 ? 0
    : fromKnown ? between(uk?.owner_net_cents, uk?.net_after_report_adjustments_cents)
      : total([ut.coupon_cents, ut.price_protection_cents, ut.trade_in_credit_returned_cents ?? 0]);
  const incomplete = (t.unknown_lines ?? 0) + (t.pending_costs ?? 0);
  const estimatedOrders = known?.estimated?.orders_count ?? 0;
  // A part in cents: dinars without a USD block; null when the server sent none for it.
  const inCents = (part: UsdKnownPart | undefined) => (!ut ? undefined : part ? part.net_after_report_adjustments_cents : null);
  return {
    net, cents, fromKnown,
    marginBase: fromKnown ? known!.revenue_iqd : data.chart_data?.revenue_iqd,
    confirmed: known?.confirmed ? { orders: known.confirmed.orders_count, net: partNet(known.confirmed), cents: inCents(uk?.confirmed) } : null,
    estimated: known?.estimated ? { orders: estimatedOrders, net: partNet(known.estimated), cents: inCents(uk?.estimated) } : null,
    deductions, deductionsCents,
    state: incomplete > 0 || t.owner_period_net_iqd === null ? 'review' : estimatedOrders > 0 ? 'estimated' : 'confirmed',
  };
}

/**
 * The average delivered order. Null when the period has no order: there is
 * nothing to average, so the tile says nothing rather than «ناقص», which means a
 * value still to complete. A revenue the server could not total stays missing.
 */
export function averageOrder(data: FinanceSummary, usd?: DisplayUsdSummary): { iqd: number | null; cents: number | null | undefined } | null {
  const count = data.totals.orders_count ?? data.orders?.length ?? 0;
  if (!(count > 0)) return null;
  const revenue = data.chart_data?.revenue_iqd;
  return { iqd: revenue == null ? null : revenue / count, cents: usd?.chart ? Math.round(usd.chart.revenue_cents / count) : undefined };
}
