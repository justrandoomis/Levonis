import { centsAt } from './displayCurrency';
import { financeDay, type CashState, type DisplayUsdSummary, type FinanceChartAmounts, type FinanceOrder, type FinanceProduct, type FinanceState, type FinanceSummary, type FinanceWaitReason } from './types';

/**
 * «التقارير» — THE TABLES' ARITHMETIC, PURE (redesign step 4, owner 2026-11-11; DECISIONS row 316).
 *
 * Money is the server's: every amount here is a field of /summary (in dollars its cents). This module only
 * orders, filters and adds up what a table SHOWS — the rows the owner filtered to — so the totals row always
 * sums the rows above it, and a column with an unknown cell says how many are unknown beside the known sum,
 * never a 0 and never a bare dash. Where an order stands is the server's own answer (`finance_state`), the
 * one the statement's columns and the export read. tests/financeReportTables.test.ts holds every rule here.
 */
export type Num = number | null;
export type Dir = 'asc' | 'desc';

/**
 * Sorted by `value` in the direction asked. An unknown value (null) is last in BOTH directions — the owner looks
 * for the largest or the smallest known figure, not for gaps — and equal values keep the order they came in.
 */
export function sortRows<T>(rows: readonly T[], value: (row: T) => number | string | null | undefined, dir: Dir): T[] {
  return rows.map((row, i) => ({ row, i, v: value(row) })).sort((a, b) => {
    const an = a.v == null, bn = b.v == null;
    if (an || bn) return an && bn ? a.i - b.i : an ? 1 : -1;
    const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v));
    return c === 0 ? a.i - b.i : dir === 'asc' ? c : -c;
  }).map((x) => x.row);
}

/** A column's total over the rows shown: the sum of its known cells, and how many cells are unknown. */
export interface Total { sum: number; unknown: number; rows: number }
export function totalOf<T>(rows: readonly T[], value: (row: T) => Num | undefined): Total {
  let sum = 0, unknown = 0;
  for (const row of rows) { const v = value(row); if (v == null) unknown += 1; else sum += v; }
  return { sum, unknown, rows: rows.length };
}

/** A figure over a base as a share (a margin): none without a positive base or a figure. */
export const share = (value: Num | undefined, base: Num | undefined): number | null => (value == null || base == null || base <= 0 ? null : value / base);

// ------------------------------------------------------------------ orders
export const orderId = (o: FinanceOrder) => o.order_id || o.id;
export interface OrderStanding { state: FinanceState; reason: FinanceWaitReason | null }
/**
 * Where an order stands: the server's `finance_state` and `wait_reason`. A server that predates them still lists the
 * ids of each part (`known.confirmed`, `known.estimated`, `waiting.reasons`), and those are read instead — the server's
 * answer either way, never worked out again here.
 */
export function standingOf(o: FinanceOrder, data: Pick<FinanceSummary, 'known' | 'waiting'>): OrderStanding {
  if (o.finance_state) return { state: o.finance_state, reason: o.finance_state === 'waiting' ? o.wait_reason ?? 'other' : null };
  const id = orderId(o);
  for (const [reason, ids] of Object.entries(data.waiting?.reasons ?? {})) if (ids?.includes(id)) return { state: 'waiting', reason: reason as FinanceWaitReason };
  if (data.known?.confirmed?.order_ids?.includes(id)) return { state: 'confirmed', reason: null };
  if (data.known?.estimated?.order_ids?.includes(id)) return { state: 'estimated', reason: null };
  return o.owner_net_iqd == null ? { state: 'waiting', reason: 'other' } : { state: o.cost_confidence === 'verified' ? 'confirmed' : 'estimated', reason: null };
}
/** The order's cash (the server's `cash_state`); none from a server that predates it. */
export const cashOf = (o: FinanceOrder): CashState | null => o.cash_state ?? null;
/**
 * AN ORDER WHOSE KNOWN GOODS COST RESTS ON A SALE-TIME ESTIMATE (owner decision 3: always named): the server's `cost_confidence`
 * beside a known `profit_basis_iqd` — whatever the order waits for. The second review of step 4: Reports → Days named only the
 * orders in the «تقديري» state, so a waiting order whose cost is known (its investor share waits) put its estimate into a known
 * cost with no label. A complete order rests on one exactly when it stands «تقديري»; a server that predates `cost_confidence` is
 * read from that state.
 */
export const restsOnEstimate = (o: FinanceOrder, s: OrderStanding): boolean =>
  o.profit_basis_iqd != null && (o.cost_confidence ? o.cost_confidence !== 'verified' : s.state === 'estimated');
/**
 * A KNOWN GOODS COST ON A SALE-TIME ESTIMATE, AS A ROW OF ORDERS, PRODUCTS OR SECTIONS SHOWS IT (the third review of step 4;
 * owner decision 3): an order's known `cogs_iqd` beside a `cost_confidence` that is not 'verified' (an older server: its «تقديري»
 * state); a product's or a section's beside its `estimated_lines`. Days needs the whole basis for a known cost (restsOnEstimate);
 * these tables show the goods cost as soon as it is known — beside a wage that still waits for it — so they name it then.
 */
export const costOnEstimate = (o: FinanceOrder, s: OrderStanding): boolean =>
  o.cogs_iqd != null && (o.cost_confidence ? o.cost_confidence !== 'verified' : s.state === 'estimated');
export const groupOnEstimate = (p: FinanceProduct): boolean =>
  p.cogs_iqd != null && (p.estimated_lines !== undefined ? p.estimated_lines > 0 : p.finance_state === 'estimated');

/** The reasons in the order the owner fixes them (the banner's, the statement's and the server's order). */
export const REASONS: readonly FinanceWaitReason[] = ['no_price', 'return_cost', 'wage_waits_cost', 'investor_waits', 'refund_unknown', 'other'];
/** The status filter: every order, one state, or the waiting orders of one reason. */
export type StateFilter = '' | FinanceState | `reason:${FinanceWaitReason}`;
export type KindFilter = '' | 'normal' | 'quick_buy' | 'gift';
/** A table opened on some orders only (a product's, a section's, a day's), named on its chip. */
export interface OrderScope { label: string; ids: readonly string[] }
/**
 * WHAT THE ORDERS PAGE WAS OPENED ON: a product's or a section's row, or a day (a week, a month) of Reports → Days. Kept as
 * that reference, never as a list of ids: its orders are read again from each summary (scopeOf), so a new period or a
 * refresh shows that product's orders in the period on screen — never the ids of the period it was clicked in under the
 * same name. `name`: the row's name when it was opened, for a period in which the row no longer appears.
 */
export type ScopeRef = { kind: 'product' | 'main' | 'sub'; id: string; name: string } | { kind: 'days'; from: string; to: string };
/** The orders a reference stands for in this summary: the row's own `order_ids` (none when the row is not in it), or the orders delivered on those days. */
export function scopeIds(ref: ScopeRef, data: Pick<FinanceSummary, 'orders' | 'products' | 'categories' | 'order_level'>): string[] {
  if (ref.kind === 'days') return data.orders.filter((o) => { const d = financeDay(o.delivered_at || o.created_at); return d >= ref.from && d <= ref.to; }).map(orderId);
  if (ref.id === ORDER_LEVEL) return [...(data.order_level?.order_ids ?? [])];
  const rows = ref.kind === 'product' ? data.products ?? [] : data.categories ?? [];
  return [...(rows.find((p) => p.id === ref.id && (p.level ?? 'product') === ref.kind)?.order_ids ?? [])];
}
export interface OrderFilter { q: string; state: StateFilter; kind: KindFilter; scope: OrderScope | null }
export const NO_FILTER: OrderFilter = { q: '', state: '', kind: '', scope: null };

export function filterOrders(orders: readonly FinanceOrder[], data: Pick<FinanceSummary, 'known' | 'waiting'>, f: OrderFilter): FinanceOrder[] {
  const q = f.q.trim().toLocaleLowerCase(), scope = f.scope ? new Set(f.scope.ids) : null;
  return orders.filter((o) => {
    const id = orderId(o);
    if (scope && !scope.has(id)) return false;
    if (q && !`${id} ${o.customer_name ?? ''}`.toLocaleLowerCase().includes(q)) return false;
    if (f.kind && (o.order_kind ?? 'normal') !== f.kind) return false;
    if (!f.state) return true;
    const s = standingOf(o, data);
    return f.state.startsWith('reason:') ? s.state === 'waiting' && s.reason === f.state.slice(7) : s.state === f.state;
  });
}
/** How many orders stand where, for the status filter's options and the strip's chips. */
export function stateCounts(orders: readonly FinanceOrder[], data: Pick<FinanceSummary, 'known' | 'waiting'>) {
  const counts = { all: orders.length, confirmed: 0, estimated: 0, waiting: 0, reasons: {} as Partial<Record<FinanceWaitReason, number>> };
  for (const o of orders) {
    const s = standingOf(o, data);
    counts[s.state] += 1;
    if (s.reason) counts.reasons[s.reason] = (counts.reasons[s.reason] ?? 0) + 1;
  }
  return counts;
}

/** An order's dinar field, or its cents in dollars (the server's per-order cents). */
export type Money = (o: FinanceOrder, field: string) => Num;
export function orderMoney(usd: DisplayUsdSummary | undefined): Money {
  return (o, field) => {
    if (usd) return centsAt(usd.orders?.[orderId(o)]?.cents ?? {}, field) ?? null;
    const v = (o as unknown as Record<string, number | null | undefined>)[field];
    return v === undefined ? (field.endsWith('_iqd') ? 0 : null) : v;
  };
}
/**
 * «صافيك» of an order: after its coupon, credited price protection and returned trade-in credit, as the headline
 * (DECISIONS row 313); a server that predates that field answers the net before them.
 */
export const netOf = (o: FinanceOrder, money: Money): Num => (o.net_after_report_adjustments_iqd !== undefined ? money(o, 'net_after_report_adjustments_iqd') : money(o, 'owner_net_iqd'));
/**
 * The margin's base, revenue: net sales, delivery and the COD fee — the server's `revenue_iqd`, or in dollars the sum of
 * the three amounts' cents (an older server: the same sum in dinars).
 */
export function revenueOf(o: FinanceOrder, money: Money, usd?: DisplayUsdSummary): Num {
  if (!usd && o.revenue_iqd !== undefined) return o.revenue_iqd;
  const parts = ['retained_revenue_iqd', 'shipping_income_iqd', 'cod_tax_iqd'].map((f) => money(o, f));
  return parts.some((v) => v == null) ? null : parts.reduce<number>((a, v) => a + (v as number), 0);
}
/** The orders' net total: the sum of the calculated orders' nets (a waiting order has none), how many they are, and their revenue. */
export function netTotal(rows: readonly FinanceOrder[], money: Money, usd?: DisplayUsdSummary) {
  const calculated = rows.filter((o) => netOf(o, money) != null);
  return { net: totalOf(calculated, (o) => netOf(o, money)).sum, orders: calculated.length, revenue: totalOf(calculated, (o) => revenueOf(o, money, usd)).sum, waiting: rows.length - calculated.length };
}

// ------------------------------------------------------------------ products and sections
/**
 * «القطع» (owner default 2026-11-11, plan question 4.7.1): the pieces the customers KEPT, with the returned ones shown
 * apart. Flip this to count every piece sold, as the old screens did.
 */
export const PIECES: 'kept' | 'sold' = 'kept';
export const piecesOf = (p: FinanceProduct): number => (PIECES === 'kept' ? p.kept_qty ?? p.qty - (p.returned_qty ?? 0) : p.qty);
/**
 * WHAT NO PRODUCT AND NO SECTION CARRIES (the independent review of step 4): the rest of a coupon larger than the goods, a price
 * protection or a returned trade-in credit no line carries. The server names it once (`order_level`); the products' and the
 * sections' tables draw it as a row of their own, after the others, so their «صافيك» adds up to the orders'. This only shapes
 * the server's figures as a row: nothing sold, its deductions, its net (unknown while an order it comes from has none).
 */
export const ORDER_LEVEL = 'order_level';
export function orderLevelRow(data: Pick<FinanceSummary, 'order_level'>, level: 'product' | 'main' | 'sub'): FinanceProduct | null {
  const o = data.order_level;
  if (!o) return null;
  return { id: ORDER_LEVEL, name: '', level, qty: 0, kept_qty: 0, returned_qty: 0, order_ids: o.order_ids, orders_count: o.orders_count, coupon_iqd: o.coupon_iqd,
    price_protection_iqd: o.price_protection_iqd, trade_in_credit_returned_iqd: o.trade_in_credit_returned_iqd, net_after_report_adjustments_iqd: o.net_after_report_adjustments_iqd };
}
/** A product or section row's dinar field, or its cents in dollars. */
export function groupMoney(usd: DisplayUsdSummary | undefined, level: 'product' | 'main' | 'sub'): (p: FinanceProduct, field: string) => Num {
  return (p, field) => {
    // The order-level row sold nothing: in cents as in dinars, a field it does not carry is 0, never «unknown».
    if (usd && p.id === ORDER_LEVEL) { const row = usd.order_level ?? {}, key = field.replace(/_iqd$/, '_cents'); return key in row ? row[key] : 0; }
    if (usd) { const rows = level === 'product' ? usd.products : usd.categories?.[level]; return centsAt(rows?.[p.id] ?? {}, field) ?? null; }
    const v = (p as unknown as Record<string, number | null | undefined>)[field];
    return v === undefined ? 0 : v;
  };
}
/** A product's or a section's «صافيك» (before general expenses): after its deductions, as an order's. */
export const groupNet = (p: FinanceProduct, money: (p: FinanceProduct, field: string) => Num): Num =>
  (p.net_after_report_adjustments_iqd !== undefined ? money(p, 'net_after_report_adjustments_iqd') : money(p, 'owner_net_iqd'));
export const groupSales = (p: FinanceProduct, money: (p: FinanceProduct, field: string) => Num): Num =>
  (p.retained_revenue_iqd !== undefined ? money(p, 'retained_revenue_iqd') : money(p, 'net_goods_iqd'));
/** The rows of one level whose name holds the search (the names in every language the server sent). */
export function filterGroups(rows: readonly FinanceProduct[], level: 'product' | 'main' | 'sub', q: string): FinanceProduct[] {
  const needle = q.trim().toLocaleLowerCase();
  return rows.filter((p) => (p.level ?? 'product') === level && (!needle || [p.name, p.name_ar, p.name_en, p.name_ckb].some((n) => n?.toLocaleLowerCase().includes(needle))));
}
/** The bar under a product's gross: its share of the largest positive gross among the rows shown (0–100). */
export function barOf(value: Num, rows: readonly Num[]): number {
  const top = Math.max(0, ...rows.filter((v): v is number => v != null));
  return value == null || value <= 0 || top <= 0 ? 0 : Math.max(2, Math.round(value / top * 100));
}

// ------------------------------------------------------------------ days
export type DayGroup = 'day' | 'week' | 'month';
const DAY_MS = 86_400_000;
const at = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
/** The Saturday on or before a day: a week starts on Saturday (the old report's bucketKeyOf). */
export function weekStart(day: string): string {
  const t = at(day), dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 1) % 7) * DAY_MS).toISOString().slice(0, 10);
}
export const bucketOf = (day: string, by: DayGroup) => (by === 'month' ? day.slice(0, 7) : by === 'week' ? weekStart(day) : day);
/**
 * One row of Reports → Days: a day, or a week or month of the period's days (`from`–`to`, inside the period). Beside each
 * amount, how many of its orders make a column unknown, column by column (the independent review of step 4: one count for
 * every column said «ينتظر 2» under an investor share only one order waits for): `waiting` the orders still waiting (the
 * net), `costWaits` those whose costs are not all known (the costs), `investorWaits` those whose investor share waits (the
 * investor share); and how many count a refund nobody recorded as 0 (`refunds`) or have a known goods cost that rests on a
 * sale-time estimate (`estimated`, restsOnEstimate; owner decision 3: always named). That count names the estimates beside a
 * known cost and a known net alike: where the net is known every order is complete, and a complete order rests on an estimate
 * exactly when it stands «تقديري»; where only the cost is, it counts the waiting orders whose cost is known too (the second review).
 */
export interface DayRow { key: string; from: string; to: string; orders: number; revenue: number; cost: Num; investor: Num; deductions: number; net: Num; waiting: number;
  costWaits: number; investorWaits: number; estimated: number; refunds: number }
const plus = (a: Num, b: Num) => (a == null || b == null ? null : a + b);
type DayCounts = Pick<DayRow, 'waiting' | 'costWaits' | 'investorWaits' | 'estimated' | 'refunds'>;
const NO_COUNTS: DayCounts = { waiting: 0, costWaits: 0, investorWaits: 0, estimated: 0, refunds: 0 };
/**
 * The period's days, or its weeks or months. A week or a month sums its days and stays unknown if any of its days
 * is: a total is never a part passed off as the whole. The counts (DayRow) are the orders' own, from the server's answer
 * where each stands and which of its figures are null — so a cell's chip counts exactly the orders that make it unknown.
 * In dollars every amount is the server's cents for that day.
 */
export function groupDays(daily: ReadonlyArray<FinanceChartAmounts & { day: string }>, by: DayGroup, orders: readonly FinanceOrder[], data: Pick<FinanceSummary, 'known' | 'waiting'>, usd?: DisplayUsdSummary): DayRow[] {
  const countsOn = new Map<string, DayCounts>();
  for (const o of orders) {
    const d = financeDay(o.delivered_at || o.created_at), c = { ...(countsOn.get(d) ?? NO_COUNTS) }, s = standingOf(o, data);
    c.waiting += s.state === 'waiting' ? 1 : 0; c.estimated += restsOnEstimate(o, s) ? 1 : 0;
    c.costWaits += o.profit_basis_iqd === null ? 1 : 0; c.investorWaits += o.investor_iqd === null ? 1 : 0; c.refunds += (o.unknown_refunds ?? 0) > 0 ? 1 : 0;
    countsOn.set(d, c);
  }
  const rows = new Map<string, DayRow>();
  for (const d of daily) {
    const c = usd?.chart?.daily?.[d.day], counts = countsOn.get(d.day) ?? NO_COUNTS;
    const day: DayRow = usd
      ? { key: '', from: d.day, to: d.day, orders: d.orders_count, revenue: c?.revenue_cents ?? 0, cost: c ? c.cost_cents : null, investor: c ? c.investor_cents : null, deductions: c?.deductions_cents ?? 0,
        net: c ? (c.net_after_report_adjustments_cents !== undefined ? c.net_after_report_adjustments_cents : c.owner_net_cents) : null, ...counts }
      : { key: '', from: d.day, to: d.day, orders: d.orders_count, revenue: d.revenue_iqd, cost: d.cost_iqd, investor: d.investor_iqd, deductions: d.deductions_iqd ?? 0,
        net: d.net_after_report_adjustments_iqd !== undefined ? d.net_after_report_adjustments_iqd : d.owner_net_iqd, ...counts };
    const key = bucketOf(d.day, by), row = rows.get(key);
    if (!row) { rows.set(key, { ...day, key }); continue; }
    rows.set(key, { key, from: row.from < day.from ? row.from : day.from, to: row.to > day.to ? row.to : day.to, orders: row.orders + day.orders, revenue: row.revenue + day.revenue,
      cost: plus(row.cost, day.cost), investor: plus(row.investor, day.investor), deductions: row.deductions + day.deductions, net: plus(row.net, day.net),
      waiting: row.waiting + day.waiting, costWaits: row.costWaits + day.costWaits, investorWaits: row.investorWaits + day.investorWaits, estimated: row.estimated + day.estimated, refunds: row.refunds + day.refunds });
  }
  return [...rows.values()];
}
/**
 * The orders a totals cell's chip stands for (the review of step 4): the sum of the rows' own counts over the rows whose value
 * is unknown — the same unit as each cell's chip (orders, never rows), so «ينتظر 2» + «ينتظر 2» above never reads «ينتظر 2» below.
 */
export const countWhereUnknown = <R>(rows: readonly R[], value: (r: R) => Num, count: (r: R) => number) => rows.reduce((v, r) => v + (value(r) == null ? count(r) : 0), 0);
/** The same over the rows whose value is known: how many orders (or rows) on an estimate a known total stands on. */
export const countWhereKnown = <R>(rows: readonly R[], value: (r: R) => Num, count: (r: R) => number) => rows.reduce((v, r) => v + (value(r) == null ? 0 : count(r)), 0);

// ------------------------------------------------------------------ the export
/**
 * WHAT A PAGE'S EXPORT CARRIES (the independent review of step 4): its view and what the page shows — the orders' search,
 * status, type and the row or days they were opened on; a drawer's column or cash; the products' and sections' search; the days'
 * grouping — as the server's export reads them (adminFinanceWorkspace exportFilter, which applies this module's rules to its own
 * rows). The file then adds up to the screen it came from. Nothing is added for what the page does not filter.
 */
export interface ExportQuery { view: 'orders' | 'products' | 'sections' | 'days'; level?: 'main' | 'sub'; part?: 'calculated' | 'waiting' | 'period'; q?: string; state?: StateFilter; kind?: KindFilter;
  scope?: ScopeRef | null; cash?: 'due' | 'open'; by?: DayGroup }
export function exportQuery(x: ExportQuery): string {
  const p: Array<[string, string]> = [['view', x.view]];
  if (x.view === 'sections') p.push(['level', x.level ?? 'main']);
  if (x.part) p.push(['part', x.part]);
  if (x.q?.trim()) p.push(['q', x.q.trim()]);
  if (x.state) p.push(['state', x.state]);
  if (x.kind) p.push(['kind', x.kind]);
  if (x.scope) p.push(['scope', x.scope.kind === 'days' ? `days:${x.scope.from}:${x.scope.to}` : `${x.scope.kind}:${x.scope.id}`]);
  if (x.cash) p.push(['cash', x.cash]);
  if (x.by && x.by !== 'day') p.push(['by', x.by]);
  return p.map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
}
