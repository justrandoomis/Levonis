import type { DisplayUsdSummary, FinanceSummary, ProfitTotals, UsdCents } from './types';

/**
 * «من المبيعات إلى حصتك» — THE PERIOD'S STATEMENT, AS DATA (redesign step 3, owner 2026-11-11).
 *
 * One row per term of the server's own arithmetic, in the order it applies them:
 *   gross   = net sales − goods cost
 *   basis   = gross + delivery + COD fee − wages − materials and extra costs − courier and payment fees
 *   net     = basis − promotion − investor share − general expenses − coupons and credits
 * in three columns: the complete orders («محسوبة»), the orders still waiting for something
 * («تنتظر»), and the whole period. A cell the server could not work out is null — the
 * screen says what it waits for — and never 0. The period's overheads (general expenses,
 * a month's promotion with no sales) are shared between the two by revenue, exactly as
 * the server's `known` carries them, so «محسوبة» + «تنتظر» = the period wherever both are known.
 *
 * «المواد والتكاليف الإضافية» is every direct cost that is not a wage (`direct_cost − wages`,
 * the materials) plus the owner's manual direct cost: in dinars that is materials + manual,
 * and in cents, where each field is converted on its own, it is the figure that keeps the
 * rows adding up to the server's net to the cent (financeUsdDisplay recomputes the profit
 * basis from `direct_cost`). In dollars the cells are the server's cents, never a conversion.
 */
export type StatementKey = 'sales' | 'cogs' | 'gross' | 'delivery' | 'cod' | 'wages' | 'materials' | 'fees' | 'promotion' | 'investor' | 'general' | 'deductions' | 'net';
export interface StatementRow { key: StatementKey; sign: '' | '+' | '−' | '='; cells: [number | null, number | null, number | null] }
export interface Statement { currency: 'IQD' | 'USD'; rows: StatementRow[] }
/** One column: its sums (named by their dinar fields), its costs still waiting, its share of the overheads, its net. */
type Part = { t: ProfitTotals; pending: number; general: number; unallocated: number; net: number | null } | null;

const add = (...xs: (number | null | undefined)[]) => (xs.some((x) => x == null) ? null : xs.reduce<number>((v, x) => v + (x as number), 0));
/** A cents row read by the dinar names of its fields. */
const byIqdNames = (c: UsdCents): ProfitTotals => Object.fromEntries(Object.entries(c).map(([k, v]) => [k.replace(/_cents$/, '_iqd'), v])) as ProfitTotals;

function column(p: Part, key: StatementKey): number | null {
  if (!p) return null;
  const t = p.t, v = (f: keyof ProfitTotals) => t[f] ?? null;
  switch (key) {
    case 'sales': return v('retained_revenue_iqd');
    case 'cogs': return v('cogs_iqd');
    case 'gross': return v('gross_profit_iqd');
    case 'delivery': return v('shipping_income_iqd');
    case 'cod': return v('cod_tax_iqd');
    // A cost that waits for the goods cost (a profit-based wage) is in no sum yet: the column's wages are not known.
    case 'wages': return p.pending > 0 ? null : v('wages_iqd');
    case 'materials': { const direct = v('direct_cost_iqd'), wages = v('wages_iqd'); return p.pending > 0 || direct === null || wages === null ? null : add(direct - wages, v('manual_direct_iqd')); }
    case 'fees': return add(v('courier_fee_iqd'), v('payment_fee_iqd'));
    case 'promotion': return add(v('promotion_iqd'), p.unallocated);
    case 'investor': return v('investor_iqd');
    case 'general': return p.general;
    case 'deductions': return add(v('coupon_iqd'), v('price_protection_iqd'), t.trade_in_credit_returned_iqd ?? 0);
    case 'net': return p.net;
  }
}

const ORDER: Array<[StatementKey, StatementRow['sign']]> = [
  ['sales', ''], ['cogs', '−'], ['gross', '='], ['delivery', '+'], ['cod', '+'], ['wages', '−'], ['materials', '−'], ['fees', '−'],
  ['promotion', '−'], ['investor', '−'], ['general', '−'], ['deductions', '−'], ['net', '='],
];
const pendingOf = (t: ProfitTotals | undefined) => t?.pending_costs ?? 0;
const after = (withDeductions: number | null | undefined, before: number | null | undefined) => (withDeductions !== undefined ? withDeductions : before ?? null);
const rowsOf = (calc: Part, wait: Part, period: Part) => ORDER.map(([key, sign]): StatementRow => ({ key, sign, cells: [column(calc, key), column(wait, key), column(period, key)] }));

/**
 * The rows in dinars, or — with the server's dollar block, when it carries every column the
 * screen shows — in its cents. A server that predates the cents of a column answers in dinars.
 */
export function statementRows(data: FinanceSummary, usd?: DisplayUsdSummary): Statement {
  const t = data.totals, k = data.known ?? null, w = data.waiting ?? null;
  const uk = usd?.known ?? null, uw = usd?.waiting ?? null, ut = usd?.totals;
  if (ut && (!k?.totals || uk?.totals) && (!w || uw)) {
    const period: Part = { t: byIqdNames(ut), pending: pendingOf(t), general: ut.general_expenses_cents ?? 0, unallocated: ut.unallocated_promotion_cents ?? 0,
      net: after(ut.owner_period_net_after_report_adjustments_cents, ut.owner_period_net_cents) };
    const calc: Part = k?.totals && uk?.totals ? { t: byIqdNames(uk.totals), pending: pendingOf(k.totals), general: uk.general_share_cents ?? 0, unallocated: uk.unallocated_share_cents ?? 0,
      net: after(uk.net_after_report_adjustments_cents, uk.owner_net_cents) } : null;
    const wait: Part = w && uw ? { t: byIqdNames(uw.totals), pending: pendingOf(w.totals), general: uw.general_share_cents, unallocated: uw.unallocated_share_cents, net: null } : null;
    return { currency: 'USD', rows: rowsOf(calc, wait, period) };
  }
  const period: Part = { t, pending: pendingOf(t), general: t.general_expenses_iqd ?? 0, unallocated: t.unallocated_promotion_iqd ?? 0,
    net: after(t.owner_period_net_after_report_adjustments_iqd, t.owner_period_net_iqd) };
  const calc: Part = k?.totals ? { t: k.totals, pending: pendingOf(k.totals), general: k.general_share_iqd ?? 0, unallocated: k.unallocated_share_iqd ?? 0,
    net: after(k.net_after_report_adjustments_iqd, k.owner_net_iqd) } : null;
  const wait: Part = w ? { t: w.totals, pending: pendingOf(w.totals), general: w.general_share_iqd ?? 0, unallocated: w.unallocated_share_iqd ?? 0, net: null } : null;
  return { currency: 'IQD', rows: rowsOf(calc, wait, period) };
}

/**
 * The columns the screen draws: «محسوبة», «تنتظر» and «الفترة» while the period is split between complete
 * and waiting orders; otherwise the period alone — a column with no orders in it would say «ناقص» on every
 * line though nothing is missing from it, and the other would only repeat the period (independent review).
 */
export function statementColumns(calc: number, wait: number): Array<0 | 1 | 2> {
  return calc > 0 && wait > 0 ? [0, 1, 2] : [2];
}

/**
 * The column's signed terms from «ربح البضاعة» down add up to its net, and its gross is its
 * sales less its goods cost — what a test asserts for every column it can (null: a term is unknown).
 */
export function statementAddsUp(rows: StatementRow[], col: 0 | 1 | 2): boolean | null {
  const v = (key: StatementKey) => rows.find((r) => r.key === key)!.cells[col];
  const net = v('net'), gross = v('gross'), sales = v('sales'), cogs = v('cogs');
  const terms: Array<[StatementKey, 1 | -1]> = [['gross', 1], ['delivery', 1], ['cod', 1], ['wages', -1], ['materials', -1], ['fees', -1], ['promotion', -1], ['investor', -1], ['general', -1], ['deductions', -1]];
  if (net === null || terms.some(([key]) => v(key) === null)) return null;
  if (sales !== null && cogs !== null && gross !== sales - cogs) return false;
  return terms.reduce((s, [key, sign]) => s + sign * (v(key) as number), 0) === net;
}
