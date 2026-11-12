import { centsAt } from './displayCurrency';
import { byIqdNames, statementColumns, statementRows, termOf, type StatementKey } from './statement';
import { costOnEstimate, orderId, revenueOf, orderMoney, share, sortRows, standingOf, type Num, type OrderStanding } from './reportTable';
import type { RsKey } from './reportStrings';
import type { DisplayUsdSummary, FinanceOrder, FinanceSummary } from './types';

/**
 * «فتح رقم» — WHAT MAKES A FIGURE, PURE (redesign step 4, owner 2026-11-11; DECISIONS row 316).
 *
 * A figure of the overview or a line of the statement opens on the orders behind it, one column at a time
 * («محسوبة» or «تنتظر», as the statement splits the period). Each order's value is its own term of the
 * statement (statement.ts `termOf`: the same arithmetic, field for field), and the overheads that no order
 * carries are rows of their own — the general expenses' share, a month's promotion with no sales — so the rows
 * add up to the statement's cell exactly, in dinars and in the server's cents. The cash figures open on the
 * orders whose cash is due. tests/financeDrill.test.ts adds them up for every line and both columns. Since the fourth
 * review a known value that rests on a sale-time estimate is named wherever it shows — a row, a total, the headline, a
 * column of the statement (rowOnEstimate, columnEstimates; owner decision 3).
 */
export type FigureKey = StatementKey | 'cashDue' | 'cashOpen';
export const STATEMENT_FIGURES: readonly StatementKey[] = ['sales', 'cogs', 'gross', 'delivery', 'cod', 'wages', 'materials', 'fees', 'promotion', 'investor', 'general', 'deductions', 'net'];
const isStatement = (key: FigureKey): key is StatementKey => (STATEMENT_FIGURES as readonly string[]).includes(key);
/** The formula of each figure, in words (reportStrings.ts). */
export const FORMULA: Record<FigureKey, RsKey> = { sales: 'fSales', cogs: 'fCogs', gross: 'fGross', delivery: 'fDelivery', cod: 'fCod', wages: 'fWages', materials: 'fMaterials',
  fees: 'fFees', promotion: 'fPromotion', investor: 'fInvestor', general: 'fGeneral', deductions: 'fDeductions', net: 'fNet', cashDue: 'fCashDue', cashOpen: 'fCashOpen' };

/** A row of the drawer: an order with its value, or an overhead that belongs to the whole period. */
export type DrillRow =
  | { kind: 'order'; order: FinanceOrder; value: Num; standing: OrderStanding; revenue: Num; promotion: Num; margin: number | null }
  | { kind: 'general' | 'unallocated' | 'overhead'; value: number };
/**
 * 0: the calculated orders («محسوبة»); 1: the orders still waiting («تنتظر»); 2: the whole period, for a period with no
 * delivered order — its overheads alone (the independent review of step 4: rent with no sale opened on «تنتظر (0)» and no
 * row); 'all': every order (the cash figures).
 */
export type DrillPart = 0 | 1 | 2 | 'all';
/** `estimated`: how many of its orders' known values rest on a sale-time estimate (rowOnEstimate) — what its total names. */
export interface Drill { currency: 'IQD' | 'USD'; part: DrillPart; rows: DrillRow[]; total: Num; estimated: number }

/**
 * WHAT A SALE-TIME ESTIMATE REACHES (the fourth review of step 4; owner decision 3: always named): an order's goods cost, the gross
 * on it and its net. A profit-based wage and an investor share wait for a confirmed cost instead (financeParticipants, investorFinance),
 * so no other figure of an order rests on one.
 */
const ON_COST: readonly FigureKey[] = ['cogs', 'gross', 'net'];
/**
 * A ROW OF THE DRAWER WHOSE KNOWN VALUE RESTS ON A SALE-TIME ESTIMATE: of a figure the estimate reaches, an order whose known goods cost
 * is one (reportTable costOnEstimate) — a waiting order's too, whose wage or investor share is what it waits for. The fourth review: the
 * drawer showed such an order's goods cost under «تنتظر» as a confirmed-looking figure while Reports → Orders named its estimate.
 */
export const rowOnEstimate = (key: FigureKey, r: DrillRow): boolean => r.kind === 'order' && r.value != null && ON_COST.includes(key) && costOnEstimate(r.order, r.standing);

/** The parts a figure opens on: the statement's split columns while the period has both; else the one it has; the period when it has neither; cash: every order. */
export function drillParts(data: FinanceSummary, key: FigureKey): DrillPart[] {
  if (!isStatement(key)) return ['all'];
  const calc = data.known?.orders_count ?? 0, wait = data.waiting?.orders_count ?? 0, columns = statementColumns(calc, wait);
  return columns.length > 1 ? [0, 1] : calc > 0 ? [0] : wait > 0 ? [1] : [2];
}

/**
 * The figure as the overview shows it: the period's own value when it is known, else the calculated orders'; on how many orders it
 * stands; and how many of those rest on a sale-time estimate in it (the fourth review: the headline names them as its rows do).
 */
export function headline(data: FinanceSummary, key: FigureKey, usd?: DisplayUsdSummary): { value: Num; orders: number; all: number; estimated: number } {
  const all = data.totals.orders_count ?? data.orders.length;
  if (!isStatement(key)) return { value: drill(data, key, 'all', usd).total, orders: all, all, estimated: 0 };
  const { rows } = statementRows(data, usd), cells = rows.find((r) => r.key === key)!.cells;
  if (cells[2] !== null) return { value: cells[2], orders: all, all, estimated: drill(data, key, 2, usd).estimated };
  return { value: cells[0], orders: data.known?.orders_count ?? 0, all, estimated: drill(data, key, 0, usd).estimated };
}

/**
 * THE ESTIMATES EACH COLUMN OF THE STATEMENT NAMES IN ITS HEAD (the fourth review of step 4; owner decision 3). «محسوبة»: its orders on a
 * sale-time estimate (the server's count). «تنتظر»: its orders whose known goods cost is one (costOnEstimate), once the column's goods
 * cost is known — the only figure of it an estimate reaches, with the gross on it (its net stays unknown). «الفترة»: both, once its
 * goods cost is known; with no order waiting every figure of it is known, and it is the calculated orders' (their count, as before). A
 * column whose goods cost still waits holds no estimate in a known figure, and names none.
 */
export function columnEstimates(data: FinanceSummary, usd?: DisplayUsdSummary): [number, number, number] {
  const calc = data.known?.estimated?.orders_count ?? 0, cogs = statementRows(data, usd).rows.find((r) => r.key === 'cogs')!.cells;
  const late = data.orders.filter((o) => { const s = standingOf(o, data); return s.state === 'waiting' && costOnEstimate(o, s); }).length;
  return [calc, cogs[1] === null ? 0 : late, !data.waiting?.orders_count ? calc : cogs[2] === null ? 0 : calc + late];
}

/**
 * The rows of one figure in one part, sorted by value (largest first; an unknown value last), and the part's total: the
 * statement's cell for a statement line (null while a term is unknown), the period's cash for a cash figure.
 */
export function drill(data: FinanceSummary, key: FigureKey, part: DrillPart, usd?: DisplayUsdSummary): Drill {
  const st = statementRows(data, usd), money = orderMoney(st.currency === 'USD' ? usd : undefined), dollars = st.currency === 'USD' ? usd : undefined;
  const orders = data.orders.filter((o) => part === 'all' || part === 2 || (standingOf(o, data).state === 'waiting') === (part === 1));
  const value = (o: FinanceOrder): Num => {
    if (key === 'cashDue') { const open = money(o, 'collection_difference_iqd'), recorded = money(o, 'collected_iqd'); return open == null || recorded == null ? null : open + recorded; }
    if (key === 'cashOpen') return money(o, 'collection_difference_iqd');
    // In dollars the order's cents row, read by the dinar names; its waiting costs are the dinar row's.
    const t = dollars ? byIqdNames(dollars.orders?.[orderId(o)]?.cents ?? {}) : o;
    return termOf(t, key, o.pending_costs ?? 0);
  };
  const rows: DrillRow[] = key === 'general' ? [] : orders.map((o) => {
    const v = value(o), revenue = revenueOf(o, money, dollars);
    return { kind: 'order' as const, order: o, value: v, standing: standingOf(o, data), revenue, promotion: money(o, 'promotion_iqd'),
      margin: key === 'net' ? share(v, revenue) : key === 'gross' ? share(v, termOf(dollars ? byIqdNames(dollars.orders?.[orderId(o)]?.cents ?? {}) : o, 'sales')) : null };
  }).filter((r) => key !== 'cashDue' && key !== 'cashOpen' ? true : r.value !== 0);
  const sorted = sortRows(rows, (r) => r.value, 'desc'), estimated = rows.filter((r) => rowOnEstimate(key, r)).length;
  if (!isStatement(key)) {
    const total = rows.some((r) => r.value == null) ? null : rows.reduce((s, r) => s + (r.value as number), 0);
    return { currency: st.currency, part, rows: sorted, total, estimated };
  }
  // The column's overheads, as the statement carries them (statement.ts, from the server's known / waiting shares; the period's own for part 2).
  const col = part === 1 ? 1 : part === 2 ? 2 : 0;
  const general = cellShare(data, usd, st.currency, col, 'general'), unallocated = cellShare(data, usd, st.currency, col, 'unallocated');
  if (key === 'general' && general) sorted.push({ kind: 'general', value: general });
  if (key === 'promotion' && unallocated) sorted.push({ kind: 'unallocated', value: unallocated });
  if (key === 'net' && (general || unallocated)) sorted.push({ kind: 'overhead', value: -general - unallocated });
  return { currency: st.currency, part, rows: sorted, total: st.rows.find((r) => r.key === key)!.cells[col], estimated };
}

/** A column's share of the general expenses or of a month's promotion with no sales, in the statement's currency; the period's whole amounts for column 2. */
function cellShare(data: FinanceSummary, usd: DisplayUsdSummary | undefined, currency: 'IQD' | 'USD', col: 0 | 1 | 2, which: 'general' | 'unallocated'): number {
  if (currency === 'USD') {
    if (col === 2) return (which === 'general' ? usd?.totals?.general_expenses_cents : usd?.totals?.unallocated_promotion_cents) ?? 0;
    const part = col === 0 ? usd?.known : usd?.waiting;
    return (which === 'general' ? part?.general_share_cents : part?.unallocated_share_cents) ?? 0;
  }
  if (col === 2) return (which === 'general' ? data.totals.general_expenses_iqd : data.totals.unallocated_promotion_iqd) ?? 0;
  const part = col === 0 ? data.known : data.waiting;
  return (which === 'general' ? part?.general_share_iqd : part?.unallocated_share_iqd) ?? 0;
}

/** The sum of a drawer's rows — what tests/financeDrill.test.ts holds equal to the cell; null when a row is unknown. */
export const rowsSum = (rows: readonly DrillRow[]): Num => (rows.some((r) => r.value == null) ? null : rows.reduce((s, r) => s + (r.value as number), 0));
/** The cents of the period's cash card, as the overview draws it (Cash): what is due, and what is not recorded yet. */
export const cashCard = (data: FinanceSummary, usd?: DisplayUsdSummary) => {
  const t = data.totals, c = (f: string) => (usd ? centsAt(usd.totals, f) ?? null : (t as Record<string, number | null | undefined>)[f] ?? 0);
  const open = c('collection_difference_iqd'), recorded = c('collected_iqd');
  return { due: open == null || recorded == null ? null : open + recorded, open };
};
