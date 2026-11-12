/**
 * «المال والأرباح», AN INVENTED 1–11 NOVEMBER 2026, AS /summary ANSWERS IT (redesign step 4, DECISIONS row 316).
 *
 * EVERY FIGURE IN THIS FILE IS INVENTED: the order ids, the delivery times, the amounts, the products and their pieces.
 * None of them is the shop's — the repository is public, so the live figures the owner's screens were checked on stay
 * outside it. The month is made to hold every case the screens show, as the corrected server answers it: promotion by sales
 * value (DECISIONS row 313), the statement's «known» and «waiting» (row 315), and step 4's fields — each order's state and
 * cash, the products' pieces kept and their orders, the sections' names in three languages, each day's deductions and net
 * after them. tests/financeReportTables.test.ts, tests/financeDrill.test.ts and tests/financeOverviewScreen.test.ts read it:
 * 13 orders, 5,814,070 of net sales, a calculated net of 796,059 (485,819 from 3 confirmed orders, 310,240 from 6
 * estimated ones), 4 waiting (a purchase price 2, a wage 1, an investor share 1 — its goods cost on the sale-time estimate),
 * six products, and one order delivered at 21:40 UTC on Friday 6 November: Saturday 7 November in Baghdad.
 */
import type { FinanceSummary } from '../../src/components/financeWorkspace/types';

type St = 'ok' | 'est' | 'wage' | 'nocost' | 'inv';
interface O { id: string; at: string; sales: number; ship: number; cod: number; cogs: number | null; wages: number; pending: number; unknown: number; units: number; inv: number | null; cdiff: number; st: St; reasons: string[] }
const O: O[] = [
  { id: 'ORD-0A00000001', at: '2026-11-10T11:42:18.120Z', sales: 735000, ship: 18000, cod: 2500, cogs: 602410, wages: 6500, pending: 0, unknown: 0, units: 1, inv: 0, cdiff: 655500, st: 'ok', reasons: [] },
  { id: 'ORD-0A00000002', at: '2026-11-10T09:27:05.640Z', sales: 45000, ship: 6000, cod: 0, cogs: 32700, wages: 0, pending: 2, unknown: 0, units: 2, inv: 0, cdiff: 51000, st: 'wage', reasons: ['fifo_missing', 'fifo_missing', 'verified_goods_cost_required', 'verified_goods_cost_required'] },
  { id: 'ORD-0A00000003', at: '2026-11-10T08:03:51.910Z', sales: 1045000, ship: 22000, cod: 0, cogs: 814540, wages: 6500, pending: 0, unknown: 0, units: 1, inv: 0, cdiff: 1067000, st: 'ok', reasons: [] },
  { id: 'ORD-0A00000004', at: '2026-11-09T13:20:44.205Z', sales: 26000, ship: 6000, cod: 0, cogs: null, wages: 0, pending: 0, unknown: 1, units: 21, inv: 0, cdiff: 32000, st: 'nocost', reasons: ['fifo_missing', 'fifo_missing'] },
  { id: 'ORD-0A00000005', at: '2026-11-09T10:05:37.480Z', sales: 1087000, ship: 22000, cod: 7000, cogs: 847240, wages: 0, pending: 0, unknown: 0, units: 3, inv: 0, cdiff: 1116000, st: 'est', reasons: ['fifo_missing', 'fifo_missing'] },
  { id: 'ORD-0A00000006', at: '2026-11-09T07:48:12.030Z', sales: 4680, ship: 6000, cod: 0, cogs: 900, wages: 0, pending: 0, unknown: 0, units: 36, inv: 0, cdiff: 10680, st: 'est', reasons: ['fifo_missing'] },
  // 21:40 UTC on Friday 6 November is 00:40 on Saturday 7 November in Baghdad: that day's order, in the second week.
  { id: 'ORD-0A00000007', at: '2026-11-06T21:40:12.300Z', sales: 22500, ship: 7000, cod: 0, cogs: 16350, wages: 0, pending: 0, unknown: 0, units: 1, inv: 0, cdiff: 29500, st: 'est', reasons: ['fifo_missing'] },
  { id: 'ORD-0A00000008', at: '2026-11-05T12:31:26.770Z', sales: 8890, ship: 6000, cod: 0, cogs: null, wages: 0, pending: 0, unknown: 3, units: 58, inv: 0, cdiff: 14890, st: 'nocost', reasons: ['fifo_missing', 'fifo_missing', 'fifo_missing', 'fifo_missing'] },
  { id: 'ORD-0A00000009', at: '2026-11-05T09:14:58.360Z', sales: 42500, ship: 6000, cod: 0, cogs: 32700, wages: 0, pending: 0, unknown: 0, units: 2, inv: 0, cdiff: 48500, st: 'est', reasons: ['fifo_missing'] },
  { id: 'ORD-0A0000000A', at: '2026-11-04T14:02:33.850Z', sales: 995000, ship: 0, cod: 0, cogs: 809900, wages: 0, pending: 0, unknown: 0, units: 1, inv: 0, cdiff: 0, st: 'ok', reasons: [] },
  { id: 'ORD-0A0000000B', at: '2026-11-04T06:55:09.120Z', sales: 45000, ship: 7000, cod: 0, cogs: 32700, wages: 0, pending: 0, unknown: 0, units: 2, inv: 0, cdiff: 52000, st: 'est', reasons: ['fifo_missing', 'fifo_missing'] },
  // Its investor share waits for a confirmed cost: its one line, the funded printer, is costed on the sale-time estimate.
  { id: 'ORD-0A0000000C', at: '2026-11-02T12:10:47.590Z', sales: 1690000, ship: 22000, cod: 9500, cogs: 1312000, wages: 0, pending: 0, unknown: 0, units: 1, inv: null, cdiff: 1471500, st: 'inv', reasons: ['fifo_missing'] },
  { id: 'ORD-0A0000000D', at: '2026-11-02T08:36:21.440Z', sales: 67500, ship: 7000, cod: 0, cogs: 49050, wages: 0, pending: 0, unknown: 0, units: 3, inv: 0, cdiff: 74500, st: 'est', reasons: ['fifo_missing', 'fifo_missing'] },
];
export const PROMOTION = 192400;
/** Largest remainder, as the server's allocateExact: the shares add up to the total exactly. */
export function allocate(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (sum > 0 ? (total * w) / sum : 0));
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  [...raw.keys()].sort((a, b) => raw[b] - Math.floor(raw[b]) - (raw[a] - Math.floor(raw[a]))).forEach((i) => { if (left > 0) { out[i] += 1; left -= 1; } });
  return out;
}
const promo = allocate(PROMOTION, O.map((o) => o.sales));
const day = (at: string) => new Date(Date.parse(at) + 3 * 3600000).toISOString().slice(0, 10);
const sumNull = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce((a: number, b) => a + (b as number), 0));
const STATE = { ok: ['confirmed', null], est: ['estimated', null], wage: ['waiting', 'wage_waits_cost'], nocost: ['waiting', 'no_price'], inv: ['waiting', 'investor_waits'] } as const;
/**
 * The review reasons that name a goods cost not confirmed yet (worker/lib/orderProfitReview.ts: a line on the sale-time estimate or
 * the frozen snapshot raises one of the first four; a profit-based wage waiting for such a line, the fifth). An order's
 * `cost_confidence` is the server's (adminFinanceWorkspace orderRow): no goods cost → 'unknown'; one of these → 'snapshot'; else
 * 'verified' — whatever else it waits for (the third review of step 4: an investor share that waits leaves a confirmed cost confirmed;
 * here the waiting investor order's own line is on the estimate, and its review reason says so).
 */
const UNCONFIRMED_COST = new Set(['fifo_missing', 'historical_cost_unverified', 'fifo_quantity_incomplete', 'fifo_cost_missing', 'verified_goods_cost_required']);
const confidenceOf = (o: O) => (o.cogs === null ? 'unknown' : o.reasons.some((code) => UNCONFIRMED_COST.has(code)) ? 'snapshot' : 'verified');

export const orders = O.map((o, i) => {
  const basis = o.cogs === null || o.pending > 0 ? null : o.sales - o.cogs + o.ship + o.cod - o.wages;
  const net = basis === null || o.inv === null ? null : basis - promo[i] - o.inv;
  return {
    id: o.id, order_id: o.id, status: 'delivered', created_at: o.at, delivered_at: o.at, order_kind: 'normal' as const, customer_name: 'زبون', version: 3,
    net_goods_iqd: o.sales, retained_revenue_iqd: o.sales, cogs_iqd: o.cogs, gross_profit_iqd: o.cogs === null ? null : o.sales - o.cogs,
    shipping_income_iqd: o.ship, cod_tax_iqd: o.cod, direct_cost_iqd: o.wages, wages_iqd: o.wages, materials_iqd: 0, manual_direct_iqd: 0, courier_fee_iqd: 0, payment_fee_iqd: 0,
    contribution_profit_iqd: basis, profit_basis_iqd: basis, promotion_iqd: promo[i], investor_iqd: o.inv, owner_net_iqd: net, coupon_iqd: 0, price_protection_iqd: 0,
    trade_in_credit_iqd: 0, trade_in_credit_returned_iqd: 0, net_after_report_adjustments_iqd: net, refunded_iqd: 0, refund_iqd: 0, collected_iqd: 0, collection_difference_iqd: o.cdiff,
    pending_costs: o.pending, unknown_lines: o.unknown, units: o.units, has_financial_activity: true, review_reasons: o.reasons.map((code) => ({ code, field: 'cogs_iqd', source_id: null, line_ids: [] })),
    cost_confidence: confidenceOf(o),
    // Redesign step 4: as the server's orderRow answers them.
    revenue_iqd: o.sales + o.ship + o.cod, finance_state: STATE[o.st][0], wait_reason: STATE[o.st][1], cash_state: o.cdiff > 0 ? 'not_recorded' as const : 'prepaid' as const,
  };
});
const FIELDS = ['net_goods_iqd', 'retained_revenue_iqd', 'cogs_iqd', 'gross_profit_iqd', 'shipping_income_iqd', 'cod_tax_iqd', 'direct_cost_iqd', 'wages_iqd', 'materials_iqd', 'manual_direct_iqd', 'courier_fee_iqd', 'payment_fee_iqd', 'contribution_profit_iqd', 'profit_basis_iqd', 'promotion_iqd', 'investor_iqd', 'owner_net_iqd', 'coupon_iqd', 'price_protection_iqd', 'trade_in_credit_iqd', 'trade_in_credit_returned_iqd', 'net_after_report_adjustments_iqd', 'refunded_iqd', 'refund_iqd', 'collected_iqd', 'collection_difference_iqd', 'pending_costs', 'unknown_lines', 'units'];
type R = Record<string, unknown>;
export const sums = (rows: R[]) => Object.fromEntries(FIELDS.map((f) => [f, sumNull(rows.map((r) => (r[f] === undefined ? 0 : r[f]) as number | null))])) as Record<string, number | null>;
const totals: R = { ...sums(orders), orders_count: orders.length, general_expenses_iqd: 0, general_waiting_iqd: 0, unallocated_promotion_iqd: 0 };
totals.owner_period_net_iqd = totals.owner_net_iqd;
totals.owner_period_net_after_report_adjustments_iqd = totals.net_after_report_adjustments_iqd;
const complete = orders.filter((o) => o.owner_net_iqd !== null), incomplete = orders.filter((o) => o.owner_net_iqd === null);
const part = (rows: typeof orders) => ({ orders_count: rows.length, revenue_iqd: rows.reduce((v, o) => v + o.revenue_iqd, 0),
  owner_net_iqd: rows.reduce((v, o) => v + (o.owner_net_iqd as number), 0), net_after_report_adjustments_iqd: rows.reduce((v, o) => v + (o.owner_net_iqd as number), 0), order_ids: rows.map((o) => o.id) });
const all = part(complete);
const known = { orders_count: complete.length, incomplete_orders: incomplete.length, revenue_iqd: all.revenue_iqd,
  cost_iqd: complete.reduce((v, o) => v + (o.cogs_iqd as number) + o.direct_cost_iqd + o.promotion_iqd, 0), owner_net_iqd: all.owner_net_iqd,
  net_after_report_adjustments_iqd: all.net_after_report_adjustments_iqd, overhead_share_iqd: 0,
  confirmed: part(complete.filter((o) => o.finance_state === 'confirmed')), estimated: part(complete.filter((o) => o.finance_state === 'estimated')),
  totals: { ...sums(complete), orders_count: complete.length }, general_share_iqd: 0, unallocated_share_iqd: 0 };
const reasons: Record<string, string[]> = {};
for (const o of incomplete) (reasons[o.wait_reason as string] ??= []).push(o.id);
const waiting = { orders_count: incomplete.length, totals: sums(incomplete), reasons, general_share_iqd: 0, unallocated_share_iqd: 0 };

// The products and sections, their lines' sums (each order's delivery and COD fee shared over its lines by sales value), with the
// month's promotion shared by sales value. Each product's orders are the ones its lines came from (printer B: three orders; the
// filament: seven; the magnets and the switches: the two orders of small parts, one of them holding both). A product's goods cost
// is its lines' own, so a unit can cost less in one order than in another (another lot, or the sale-time estimate): the filament's
// lines in ORD-0A00000004 and ORD-0A00000005 cost 11,400 a kilogram, its others 16,350; every switch costs 25.
const P = [
  { id: 'prd_printer_a', name: 'Sample printer A', qty: 1, sales: 735000, cogs: 602410, ship: 18000, cod: 2500, wages: 6500, inv: 0 as number | null, pending: 0, main: 'cat_printers', sub: 'cat_printers_fdm', estimated: 0,
    orders: ['ORD-0A00000001'] },
  { id: 'prd_filament', name: 'Sample filament 1 kg', qty: 13, sales: 287000, cogs: 197700, ship: 39042, cod: 270, wages: 0, inv: 0, pending: 2, main: 'cat_materials', sub: 'cat_materials_fdm', estimated: 11,
    orders: ['ORD-0A00000002', 'ORD-0A00000004', 'ORD-0A00000005', 'ORD-0A00000007', 'ORD-0A00000009', 'ORD-0A0000000B', 'ORD-0A0000000D'] },
  { id: 'prd_printer_b', name: 'Sample printer B', qty: 3, sales: 3085000, cogs: 2448880, ship: 43150, cod: 6730, wages: 6500, inv: 0, pending: 0, main: 'cat_printers', sub: 'cat_printers_fdm', estimated: 0,
    orders: ['ORD-0A00000003', 'ORD-0A00000005', 'ORD-0A0000000A'] },
  { id: 'prd_magnets', name: 'Sample magnets', qty: 50, sales: 8750, cogs: null as number | null, ship: 4351, cod: 0, wages: 0, inv: 0, pending: 0, main: 'cat_makers', sub: 'cat_makers_hw', estimated: 0,
    orders: ['ORD-0A00000004', 'ORD-0A00000008'] },
  { id: 'prd_switches', name: 'Sample switches', qty: 64, sales: 8320, cogs: 1600, ship: 8457, cod: 0, wages: 0, inv: 0, pending: 0, main: 'cat_makers', sub: 'cat_makers_new', estimated: 2,
    orders: ['ORD-0A00000006', 'ORD-0A00000008'] },
  { id: 'prd_printer_c', name: 'Sample printer C', qty: 1, sales: 1690000, cogs: 1312000, ship: 22000, cod: 9500, wages: 0, inv: null, pending: 0, main: 'cat_printers', sub: 'cat_printers_fdm', estimated: 1,
    orders: ['ORD-0A0000000C'] },
];
const pPromo = allocate(PROMOTION, P.map((p) => p.sales));
const SECTION: Record<string, [string, string, string]> = {
  cat_printers: ['الطابعات', 'Printers', 'چاپکەرەکان'], cat_materials: ['مواد الطباعة', 'Printing materials', 'کەرەستەی چاپ'], cat_makers: ['مواد MakerWorld', 'MakerWorld parts', 'پارچەکانی MakerWorld'],
  cat_printers_fdm: ['طابعات FDM', 'FDM printers', 'چاپکەرە FDM'], cat_materials_fdm: ['مواد FDM', 'FDM materials', 'کەرەستەی FDM'], cat_makers_hw: ['قطع هاردوير', 'Hardware parts', 'پارچەی ڕەق'], cat_makers_new: ['منتجات جديدة', 'New products', 'بەرهەمی نوێ'],
};
const stateOfGroup = (cogs: number | null, pending: number, inv: number | null, estimated: number) =>
  (cogs === null ? ['waiting', 'no_price'] : pending > 0 ? ['waiting', 'wage_waits_cost'] : inv === null ? ['waiting', 'investor_waits'] : [estimated > 0 ? 'estimated' : 'confirmed', null]) as [string, string | null];
export const products = P.map((p, i) => {
  const promotion = pPromo[i];
  const basis = p.cogs === null || p.pending > 0 ? null : p.sales - p.cogs + p.ship + p.cod - p.wages;
  const net = basis === null || p.inv === null ? null : basis - promotion - p.inv;
  const [finance_state, wait_reason] = stateOfGroup(p.cogs, p.pending, p.inv, p.estimated);
  return { id: p.id, name: p.name, level: 'product' as const, qty: p.qty, kept_qty: p.qty, returned_qty: 0, order_ids: p.orders, orders_count: p.orders.length,
    main_id: p.main, main_name: SECTION[p.main][0], net_goods_iqd: p.sales, retained_revenue_iqd: p.sales, cogs_iqd: p.cogs, gross_profit_iqd: p.cogs === null ? null : p.sales - p.cogs,
    shipping_income_iqd: p.ship, cod_tax_iqd: p.cod, direct_cost_iqd: p.wages, wages_iqd: p.wages, materials_iqd: 0, manual_direct_iqd: 0, courier_fee_iqd: 0, payment_fee_iqd: 0,
    contribution_profit_iqd: basis, profit_basis_iqd: basis, promotion_iqd: promotion, investor_iqd: p.inv, owner_net_iqd: net, coupon_iqd: 0, price_protection_iqd: 0, trade_in_credit_returned_iqd: 0,
    net_after_report_adjustments_iqd: net, pending_costs: p.pending, unknown_lines: p.cogs === null ? 4 : 0, units: 0, estimated_lines: p.estimated,
    finance_state, wait_reason, sub: p.sub };
});
const group = (id: string, level: 'main' | 'sub') => {
  const rows = products.filter((p) => (level === 'main' ? p.main_id : p.sub) === id);
  const t = sums(rows as unknown as R[]);
  const [finance_state, wait_reason] = stateOfGroup(t.cogs_iqd, t.pending_costs as number, t.investor_iqd, rows.reduce((v, r) => v + r.estimated_lines, 0));
  const [ar, en, ckb] = SECTION[id];
  return { id, name: ar, name_ar: ar, name_en: en, name_ckb: ckb, level, qty: rows.reduce((v, r) => v + r.qty, 0), kept_qty: rows.reduce((v, r) => v + r.kept_qty, 0), returned_qty: 0,
    order_ids: [...new Set(rows.flatMap((r) => r.order_ids))], orders_count: new Set(rows.flatMap((r) => r.order_ids)).size, estimated_lines: rows.reduce((v, r) => v + r.estimated_lines, 0), ...t, finance_state, wait_reason };
};
export const categories = [group('cat_printers', 'main'), group('cat_materials', 'main'), group('cat_makers', 'main'),
  group('cat_printers_fdm', 'sub'), group('cat_materials_fdm', 'sub'), group('cat_makers_hw', 'sub'), group('cat_makers_new', 'sub')];

const DAYS = Array.from({ length: 11 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
const daily = DAYS.map((d) => {
  const rows = orders.filter((o) => day(o.delivered_at) === d), t = sums(rows as unknown as R[]);
  const revenue = rows.reduce((v, o) => v + o.revenue_iqd, 0);
  const cost = t.profit_basis_iqd === null ? null : rows.reduce((v, o) => v + (o.cogs_iqd ?? 0) + o.direct_cost_iqd + o.promotion_iqd, 0);
  return { day: d, revenue_iqd: revenue, cost_iqd: cost, owner_net_iqd: t.owner_net_iqd, investor_iqd: t.investor_iqd, orders_count: rows.length, unknown_lines: t.unknown_lines as number, pending_costs: t.pending_costs as number,
    deductions_iqd: 0, net_after_report_adjustments_iqd: t.net_after_report_adjustments_iqd };
});

export const november = {
  success: true, range: { from: '2026-11-01', to: '2026-11-11' }, totals, known, waiting,
  missing_costs: { lines: 18, orders: 10, unknown_lines: 4, estimated_lines: 14, unknown_products: [{ product_id: 'prd_magnets', name: 'Sample magnets', qty: 50, lines: 4 }] },
  orders, kinds: [{ kind: 'normal', orders_count: 13, ...sums(orders) }, { kind: 'quick_buy', orders_count: 0, ...sums([]) }, { kind: 'gift', orders_count: 0, ...sums([]) }],
  products, categories,
  chart_data: { daily, expense_composition: [{ key: 'goods', amount_iqd: null }, { key: 'wages', amount_iqd: null }, { key: 'materials', amount_iqd: null }, { key: 'other', amount_iqd: null }, { key: 'delivery', amount_iqd: 0 }, { key: 'promotion', amount_iqd: PROMOTION }, { key: 'general', amount_iqd: 0 }],
    basis: 'delivered_baghdad_day', revenue_iqd: 5968070, cost_iqd: null, owner_net_iqd: null, investor_iqd: null, orders_count: 13, unknown_lines: 4, pending_costs: 2, deductions_iqd: 0, net_after_report_adjustments_iqd: null },
  exceptions: [], promotions: [{ id: 'promo_nov', month: '2026-11', currency: 'USD', amount: 130, amount_iqd: PROMOTION, enabled: 1, exchange_rate: 1480, title: 'ترويج الشهر', version: 1 }],
  general_expenses_iqd: 0, truncated: false, allocation_basis: 'sales_value',
} as unknown as FinanceSummary;
