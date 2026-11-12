import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDownToLine, Printer, Search, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Status, Surface, useNarrow } from './ui';
import { DisplayMoney, MissingValue, UsdBasisNote, centsAt, useDisplayCurrency } from './displayCurrency';
import { dayIn, fw, rangeText } from './overviewStrings';
import { rs, type RsKey } from './reportStrings';
import {
  barOf, costOnEstimate, countWhereKnown, countWhereUnknown, exportQuery, filterGroups, filterOrders, groupDays, groupMoney, groupNet, groupOnEstimate, groupSales, netOf, netTotal, NO_FILTER, ORDER_LEVEL, orderId, orderLevelRow, orderMoney,
  piecesOf, REASONS, revenueOf, scopeIds, share, sortRows, standingOf, stateCounts, totalOf,
  type DayGroup, type DayRow, type Dir, type KindFilter, type Num, type OrderScope, type OrderStanding, type ScopeRef, type StateFilter, type Total,
} from './reportTable';
import { financeDay, WORKSPACE_API, type DisplayUsdSummary, type FinanceOrder, type FinanceProduct, type FinanceSummary, type FinanceWaitReason } from './types';
import type { OrderFocus } from './OrderProfitSheet';

/**
 * «التقارير» — ORDERS, PRODUCTS, SECTIONS AND DAYS (redesign step 4, owner 2026-11-11; DECISIONS row 316).
 *
 * One table each, from the period's summary already read for the overview (nothing new is fetched): sortable
 * headers, a totals row over the rows shown, the period's money as the server answers it (in dollars its cents),
 * and on a phone a list instead of a table. An unknown cell is a chip that names what it waits for, never a dash
 * and never 0; the totals row gives the known sum with «+» and how many orders are missing from it. Every count, sort and
 * sum is reportTable.ts, held by tests/financeReportTables.test.ts; this file only draws.
 *
 * The independent review of step 4: each page's export is the page as it is shown (its filters, its grouping) in its own
 * toolbar; the products and sections end on the row of what no product carries («خصومات على مستوى الطلب»), so they add up
 * to the orders; an unknown margin or goods cost is a chip, the goods cost's opens what fixes it; sales that count an
 * unrecorded refund as 0 say so; the days count, column by column, the orders that make a cell unknown, and name the
 * estimates; a row that opens nothing is no button; a phone row keeps its status. The second review: no column ever steps
 * aside (the promotion and the section were hidden on every laptop inside the admin shell) — a table wider than its card
 * scrolls inside it — and a known cost on Days names an estimate even when its order waits for something else. The third:
 * so do the goods costs of Orders, Products and Sections — a waiting row's own, and every goods-cost total — and the Days
 * total on a phone.
 */
type Lang = 'ar' | 'en' | 'ckb';
type Loc = (ar: string, en: string, ckb?: string) => string;
type Open = (id: string, step?: OrderFocus) => void;
/** The first rows drawn; the rest on «عرض الكل» (a year has every order of it, and a phone must not stutter). The figure drawer's list too. */
export const FIRST = 300;

// ------------------------------------------------------------------ cells
/** An amount in a cell, bare (the strip says the currency): dinars whole, dollars from cents. */
export function amountText(v: number, usd: boolean): string {
  return usd ? (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toLocaleString('en-US');
}
export function Amount({ v, usd, missing, warn }: { v: Num; usd: boolean; missing?: ReactNode; warn?: boolean }) {
  if (v == null) return <>{missing ?? <MissingValue />}</>;
  return <span className={`fw-num${v < 0 || warn ? ' fw-neg' : ''}`} dir="ltr">{amountText(v, usd)}</span>;
}
/** A totals cell: the known sum, with «+» and the chip of what is missing when a cell above it is unknown (the chip alone when the known cells add up to nothing). */
export function TotalAmount({ t, usd, chip }: { t: Total; usd: boolean; chip: ReactNode }) {
  if (t.unknown > 0 && t.sum === 0) return <>{chip}</>;
  return <>{<span className={`fw-num${t.sum < 0 ? ' fw-neg' : ''}`} dir="ltr">{amountText(t.sum, usd)}{t.unknown ? '+' : ''}</span>}{t.unknown > 0 && <> {chip}</>}</>;
}
const pct = (v: number | null) => (v == null ? null : <bdi dir="ltr" className="fw-num">{(v * 100).toFixed(1)}%</bdi>);
const REASON_CHIP: Record<FinanceWaitReason, RsKey> = { no_price: 'stNoPrice', return_cost: 'stReturnCost', wage_waits_cost: 'stWage', investor_waits: 'stInvestor', refund_unknown: 'stRefund', other: 'stOther' };
/** The words of a standing: «مؤكد», «تكلفة تقديرية», or what it waits for. */
export const standingText = (loc: Loc, s: OrderStanding) => rs(loc, s.state === 'confirmed' ? 'stConfirmed' : s.state === 'estimated' ? 'stEstimated' : REASON_CHIP[s.reason ?? 'other']);
/**
 * The step an order opens at: its purchase price for a missing price, a returned piece's cost, a waiting wage or an estimate;
 * its cash for an investor share whose costs are confirmed.
 */
export const stepOf = (o: FinanceOrder, s: OrderStanding): OrderFocus | undefined =>
  s.state === 'estimated' || s.reason === 'no_price' || s.reason === 'return_cost' || s.reason === 'wage_waits_cost' ? 'cost'
    : s.reason === 'investor_waits' ? (o.cost_confidence === 'verified' ? 'collection' : 'cost') : undefined;
/** What fixes a standing: a price (missing, an estimate, what a wage waits for) on «التكاليف الناقصة»; anything else in the order itself. */
const toCosts = (s: OrderStanding) => s.state === 'estimated' || s.reason === 'no_price' || s.reason === 'wage_waits_cost';
const toneOf = (s: OrderStanding) => (s.state === 'confirmed' ? 'positive' : s.reason === 'no_price' ? 'danger' : 'warning');
/** A chip that opens what fixes it (a button in a row that opens something else: its click stays its own). */
function ChipButton({ className, text, title, act, chip }: { className: string; text: string; title: string; act: () => void; chip?: string }) {
  return <button type="button" className={`${className} fw-chip-button`} title={title} data-finance-chip={chip} onClick={(e) => { e.stopPropagation(); act(); }}>{text}</button>;
}
/**
 * A standing as a chip that opens its fix: a price (missing, an estimate, or what a wage waits for) on «التكاليف الناقصة»;
 * an investor share, a returned piece's cost or anything else in the order itself. A confirmed row has nothing to fix.
 */
function StandingChip({ s, onMissing, onOrder }: { s: OrderStanding; onMissing?: () => void; onOrder?: () => void }) {
  const { loc } = useLanguage();
  const text = standingText(loc, s), costs = toCosts(s);
  const act = costs ? onMissing : s.state === 'waiting' ? onOrder : undefined;
  if (!act) return <Status tone={toneOf(s)}>{text}</Status>;
  return <ChipButton className={`fw-status fw-status--${toneOf(s)}`} text={text} title={rs(loc, costs ? 'toCosts' : 'toOrderStep')} chip={s.reason ?? s.state} act={act} />;
}

// ------------------------------------------------------------------ the table
export interface Col<R> { key: string; head: ReactNode; sub?: ReactNode; sort?: (r: R) => number | string | null; cell: (r: R) => ReactNode; total?: ReactNode; start?: boolean; span?: number }
export interface PhoneRow { a: ReactNode; b: ReactNode; c: ReactNode; e?: ReactNode }
interface Sort { key: string; dir: Dir }
/**
 * A sortable table over the rows shown, its totals row, and the first FIRST rows with «عرض الكل». A row that opens
 * something (`opens`) does so with its first cell as a button, for the keyboard; one that opens nothing is no button and
 * no pointer. `pinned` rows (the order-level row) follow the sorted ones, never sorted or cut. On a phone a list of the same rows.
 */
function ReportTable<R>({ name, cols, rows, pinned = [], sort, onSort, rowKey, onRow, opens, rowLabel, phone, phoneTotal, attrs }: {
  name: string; cols: Col<R>[]; rows: R[]; pinned?: R[]; sort: Sort; onSort: (s: Sort) => void; rowKey: (r: R) => string; onRow?: (r: R) => void; opens?: (r: R) => boolean; rowLabel?: (r: R) => string;
  phone: (r: R) => PhoneRow; phoneTotal?: ReactNode; attrs?: (r: R) => Record<string, string | undefined>;
}) {
  const { loc } = useLanguage();
  const narrow = useNarrow();
  const [all, setAll] = useState(false);
  const col = cols.find((c) => c.key === sort.key) ?? cols[0];
  const sorted = useMemo(() => (col.sort ? sortRows(rows, col.sort, sort.dir) : rows), [rows, col, sort.dir]);
  const shown = [...(all ? sorted : sorted.slice(0, FIRST)), ...pinned];
  const open = (r: R) => !!onRow && (opens?.(r) ?? true);
  const more = sorted.length > FIRST && !all && <button type="button" className="fw-button fw-button--ghost" onClick={() => setAll(true)}>{rs(loc, 'showAll', { n: sorted.length })}</button>;
  if (narrow) return <><ul className="fw-rows" data-finance-report={name}>{shown.map((r) => { const p = phone(r), key = rowKey(r); return <li key={key} {...attrs?.(r)}>
    {open(r) ? <button type="button" onClick={() => onRow!(r)} aria-label={rowLabel?.(r)}><PhoneCells p={p} /></button> : <div><PhoneCells p={p} /></div>}</li>; })}
    {phoneTotal && <li className="fw-rows-total">{phoneTotal}</li>}</ul>{more}</>;
  const head = (c: Col<R>) => {
    const on = c.key === sort.key, label = <>{c.head}{c.sub && <small>{c.sub}</small>}</>, cls = c.start ? 'fw-start' : undefined;
    if (!c.sort) return <th key={c.key} scope="col" className={cls}>{label}</th>;
    return <th key={c.key} scope="col" className={cls} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="fw-sort" onClick={() => onSort({ key: c.key, dir: on ? (sort.dir === 'asc' ? 'desc' : 'asc') : c.start ? 'asc' : 'desc' })}>{label}<i aria-hidden>{on ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</i></button></th>;
  };
  const cellClass = (c: Col<R>, first = false) => (first || c.start ? 'fw-start' : undefined);
  return <><div className="fw-table-wrap"><table className="fw-table fw-report" data-finance-report={name}>
    <thead><tr>{cols.map(head)}</tr></thead>
    <tbody>{shown.map((r) => <tr key={rowKey(r)} onClick={open(r) ? () => onRow!(r) : undefined} className={open(r) ? 'fw-clickable' : undefined} {...attrs?.(r)}>
      {cols.map((c, i) => (i === 0 && open(r)
        ? <th key={c.key} scope="row" className="fw-start"><button type="button" className="fw-open" aria-label={rowLabel?.(r)} onClick={(e) => { e.stopPropagation(); onRow!(r); }}>{c.cell(r)}</button></th>
        : i === 0 ? <th key={c.key} scope="row" className="fw-start">{c.cell(r)}</th>
          : <td key={c.key} className={cellClass(c)}>{c.cell(r)}</td>))}
    </tr>)}</tbody>
    {cols.some((c) => c.total !== undefined) && <tfoot><tr>{cols.map((c, i) => (c.span === 0 ? null : <td key={c.key} colSpan={c.span} className={cellClass(c, i === 0)}>{c.total}</td>))}</tr></tfoot>}
  </table></div>{more}</>;
}
const PhoneCells = ({ p }: { p: PhoneRow }) => <><span className="fw-rows-a">{p.a}</span><span className="fw-rows-b">{p.b}</span><span className="fw-rows-c">{p.c}</span>{p.e && <span className="fw-rows-e">{p.e}</span>}</>;

/** The display currency's figures: the server's cents when the owner chose dollars and a rate exists; undefined keeps dinars. */
function useUsd(data: FinanceSummary): DisplayUsdSummary | undefined {
  const currency = useDisplayCurrency();
  return currency === 'USD' && data.display_usd?.available ? data.display_usd : undefined;
}
/** The note on the dollar basis, as the overview writes it, when the owner chose dollars (the reports and the figure drawer). */
export function UsdNote({ data }: { data: FinanceSummary }) {
  const currency = useDisplayCurrency(), u = data.display_usd;
  return currency === 'USD' ? <UsdBasisNote available={!!u?.available} atTimeCount={u?.at_time_count} todayCount={u?.today_count} todayRate={u?.today_rate} batchLines={u?.batch_cost_lines} /> : null;
}
/**
 * THE PAGE'S EXPORT (the independent review of step 4): the table as it is shown — its filters, its grouping — for the period
 * the figures were read for (`data.range`), never the bar's while another period loads. The file is in dinars: under the
 * dollar toggle the button says so.
 */
function ExportLink({ data, query }: { data: FinanceSummary; query: string }) {
  const { loc } = useLanguage();
  const usd = useDisplayCurrency() === 'USD';
  if (!data.range) return null;
  return <a className="fw-button fw-button--ghost" href={`${WORKSPACE_API}/export.csv?from=${data.range.from}&to=${data.range.to}${query}`} aria-label={usd ? rs(loc, 'exportIqd') : fw(loc, 'exportCsv')} data-finance-export>
    <ArrowDownToLine size={16} aria-hidden /><span>{usd ? rs(loc, 'exportIqd') : fw(loc, 'exportCsv')}</span></a>;
}
/**
 * Reports → Orders as a workbook and as a page to print (the owner's brief, 2026-11-12, part 1; DECISIONS row 329): the same
 * table and filters as the CSV, in the reader's language, the amounts in dinars; the printed page opens in its own tab with the
 * browser's print dialog, where «Save as PDF» makes the PDF.
 */
function OrdersFileLinks({ data, query }: { data: FinanceSummary; query: string }) {
  const { loc, lang } = useLanguage();
  if (!data.range) return null;
  const base = `from=${data.range.from}&to=${data.range.to}${query}&lang=${lang}`;
  return <>
    <a className="fw-button fw-button--ghost" href={`${WORKSPACE_API}/export.xlsx?${base}`} aria-label={rs(loc, 'exportXlsx')} title={rs(loc, 'exportXlsx')} data-finance-export-xlsx>
      <ArrowDownToLine size={16} aria-hidden /><span>Excel</span></a>
    <a className="fw-button fw-button--ghost" href={`${WORKSPACE_API}/print?${base}`} target="_blank" rel="noopener" aria-label={rs(loc, 'exportPrint')} title={rs(loc, 'exportPrint')} data-finance-export-print>
      <Printer size={16} aria-hidden /><span>PDF</span></a>
  </>;
}
function ScopeChip({ label, onClear, attr = 'data-finance-scope' }: { label: string | null; onClear: () => void; attr?: string }) {
  const { loc } = useLanguage();
  return label && <span className="fw-scope" {...{ [attr]: '' }}><bdi>{label}</bdi><button type="button" className="fw-icon-button fw-scope-x" onClick={onClear} aria-label={rs(loc, 'clearFilter')}><X size={14} aria-hidden /></button></span>;
}
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <div className="fw-search"><Search aria-hidden /><input className="fw-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} /></div>;
}
const shortId = (id: string) => id.replace(/^ORD-/, '');
const missingChip = (loc: Loc, t: Total) => <MissingValue text={rs(loc, 'missingN', { n: t.unknown })} />;
const waitingChip = (loc: Loc, t: Total) => <MissingValue text={fw(loc, 'waitingN', { n: t.unknown })} />;
/**
 * «مبلغ مرتجع غير مثبت»: sales that count a refund nobody recorded as 0 — said beside the figure, which stays the overview's
 * (whether such sales should be unknown on the overview too is the owner's question); a total says how many rows do.
 */
const refundCell = (loc: Loc, has: boolean) => (has ? <> <Status tone="warning">{rs(loc, 'stRefund')}</Status></> : null);
const refundTotal = (loc: Loc, n: number) => (n > 0 ? <> <Status tone="warning">{rs(loc, 'refundN', { n })}</Status></> : null);
/**
 * A known figure that rests on sale-time estimates names them (owner decision 3): «تقديري» beside a waiting row's own goods cost
 * (its status chip names what it waits for, not the estimate; an «تقديري» row's chip says it already), «تقديري n» beside a
 * known total — n the rows above it whose known figure rests on one (the third review of step 4). The fourth: every known total of a
 * goods cost, a gross or a net says it — the products' and the sections' gross and net, the orders' net, a phone's total — and the
 * figure drawer (FigureDrawer.tsx) its rows, its total and its headline.
 */
export const estimatedCell = (loc: Loc, on: boolean) => (on ? <> <Status tone="warning">{fw(loc, 'estimatedChip')}</Status></> : null);
export const estimatedTotal = (loc: Loc, n: number) => (n > 0 ? <> <Status tone="warning">{fw(loc, 'estimatedN', { n })}</Status></> : null);

/** The days a Days row covers, as its first cell writes them: one day, or the first and last of a week or a month. */
const daysText = (L: Lang, from: string, to: string, range?: { from: string; to: string }) => (from === to ? dayIn(L, from, range) : rangeText(L, from, to));
/**
 * The chip of the orders page opened on part of the orders, and those orders in THIS summary (scopeIds): named in the
 * reader's language from the row as it is now — its name when it was opened if the period no longer has it.
 */
export function scopeOf(loc: Loc, L: Lang, ref: ScopeRef | null, data: FinanceSummary): OrderScope | null {
  if (!ref) return null;
  const ids = scopeIds(ref, data);
  if (ref.kind === 'days') return { label: rs(loc, 'filterDay', { name: daysText(L, ref.from, ref.to, data.range) }), ids };
  if (ref.id === ORDER_LEVEL) return { label: rs(loc, 'orderLevel'), ids };
  const row = (ref.kind === 'product' ? data.products : data.categories ?? []).find((p) => p.id === ref.id && (p.level ?? 'product') === ref.kind);
  const name = !row ? ref.name : ref.kind === 'product' ? row.name : sectionName(loc, row);
  return { label: rs(loc, ref.kind === 'product' ? 'filterProduct' : 'filterSection', { name }), ids };
}

// ------------------------------------------------------------------ orders
export function OrdersReport({ data, scope: ref, onClearScope, openOrder, onMissing, onCollections }: {
  data: FinanceSummary; scope: ScopeRef | null; onClearScope: () => void; openOrder: Open; onMissing: () => void; onCollections: (orderId: string) => void;
}) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang, usd = useUsd(data), money = useMemo(() => orderMoney(usd), [usd]), u = !!usd;
  const narrow = useNarrow();
  const [q, setQ] = useState('');
  const [state, setState] = useState<StateFilter>('');
  const [kind, setKind] = useState<KindFilter>('');
  const [sort, setSort] = useState<Sort>({ key: 'day', dir: 'desc' });
  const scope = useMemo(() => scopeOf(loc, L, ref, data), [loc, L, ref, data]);
  const base = useMemo(() => filterOrders(data.orders, data, { ...NO_FILTER, q, kind, scope }), [data, q, kind, scope]);
  const rows = useMemo(() => filterOrders(base, data, { ...NO_FILTER, state }), [base, data, state]);
  const counts = stateCounts(base, data), shown = stateCounts(rows, data);
  const sum = (f: string) => totalOf(rows, (o) => money(o, f));
  const net = netTotal(rows, money, usd);
  const wait = <MissingValue text={fw(loc, 'waitingCell')} />;
  // The calculated orders' net; when none of the rows shown is calculated (the «ينتظر» filter, a product whose orders all wait) it is not known — never 0.
  const netCell = net.orders === 0 && net.waiting > 0 ? <MissingValue text={fw(loc, 'waitingN', { n: net.waiting })} /> : <Amount v={net.net} usd={u} />;
  const open = (o: FinanceOrder) => openOrder(orderId(o), stepOf(o, standingOf(o, data)));
  const status = (o: FinanceOrder) => <StandingChip s={standingOf(o, data)} onMissing={onMissing} onOrder={() => open(o)} />;
  // On a phone the whole row is the button (it opens the order at what it waits for): its chip only says, it is no button inside a button.
  const said = (o: FinanceOrder) => <StandingChip s={standingOf(o, data)} />;
  const cash = (o: FinanceOrder) => {
    const c = o.cash_state;
    if (!c) return null;
    const text = rs(loc, c === 'prepaid' ? 'cashPrepaid' : c === 'recorded' ? 'cashRecorded' : c === 'part' ? 'cashPart' : 'cashNot');
    if (c === 'prepaid' || c === 'recorded') return <Status tone="positive">{text}</Status>;
    return <button type="button" className="fw-status fw-status--neutral fw-chip-button" title={rs(loc, 'toCollections')} data-finance-cash={c} onClick={(e) => { e.stopPropagation(); onCollections(orderId(o)); }}>{text}</button>;
  };
  const sales = (o: FinanceOrder) => money(o, 'retained_revenue_iqd');
  // An unknown goods cost opens what fixes it: a missing purchase price «التكاليف الناقصة», a returned piece's cost the order itself.
  const cogsChip = (o: FinanceOrder) => {
    const s = standingOf(o, data), own = s.reason === 'return_cost';
    return <ChipButton className="fw-missing" text={rs(loc, own ? 'stReturnCost' : 'stNoPrice')} title={rs(loc, own ? 'toOrderStep' : 'toCosts')} chip={own ? 'return_cost' : 'no_price'} act={own ? () => open(o) : onMissing} />;
  };
  // A margin with no net is a chip: the order still waits; a known net on no revenue (a gift) has no margin, and says so.
  const margin = (o: FinanceOrder) => pct(share(netOf(o, money), revenueOf(o, money, usd))) ?? (netOf(o, money) == null ? wait : fw(loc, 'noSales'));
  const refunds = rows.filter((o) => (o.unknown_refunds ?? 0) > 0).length;
  const cols: Col<FinanceOrder>[] = [
    { key: 'order', head: rs(loc, 'colOrder'), start: true, sort: (o) => orderId(o), cell: (o) => <span className="fw-order-cell"><b dir="ltr">{shortId(orderId(o))}</b>
      <small><bdi>{o.customer_name}</bdi>{o.order_kind && o.order_kind !== 'normal' ? ` · ${rs(loc, o.order_kind === 'gift' ? 'kindGift' : 'kindQuick')}` : ''}</small></span>,
      total: <b>{rs(loc, 'total')}</b> },
    { key: 'day', head: rs(loc, 'colDelivered'), sort: (o) => o.delivered_at || o.created_at, cell: (o) => dayIn(L, financeDay(o.delivered_at || o.created_at), data.range), total: rows.length },
    { key: 'sales', head: rs(loc, 'colSales'), sort: sales, cell: (o) => <><Amount v={sales(o)} usd={u} />{refundCell(loc, (o.unknown_refunds ?? 0) > 0)}</>,
      total: <><TotalAmount t={totalOf(rows, sales)} usd={u} chip={missingChip(loc, totalOf(rows, sales))} />{refundTotal(loc, refunds)}</> },
    // A waiting order's known goods cost on an estimate says so (its chip names what it waits for); the total counts every order's.
    { key: 'cogs', head: fw(loc, 'cogs'), sort: (o) => money(o, 'cogs_iqd'), cell: (o) => { const v = money(o, 'cogs_iqd'), s = standingOf(o, data);
      return <><Amount v={v} usd={u} missing={cogsChip(o)} />{estimatedCell(loc, v != null && s.state === 'waiting' && costOnEstimate(o, s))}</>; },
      total: <><TotalAmount t={sum('cogs_iqd')} usd={u} chip={missingChip(loc, sum('cogs_iqd'))} />{estimatedTotal(loc, countWhereKnown(rows, (o) => money(o, 'cogs_iqd'), (o) => (costOnEstimate(o, standingOf(o, data)) ? 1 : 0)))}</> },
    { key: 'wages', head: fw(loc, 'wages'), sort: (o) => wages(o), cell: (o) => <Amount v={wages(o)} usd={u} missing={wait} />,
      total: <TotalAmount t={totalOf(rows, wages)} usd={u} chip={waitingChip(loc, totalOf(rows, wages))} /> },
    { key: 'promotion', head: rs(loc, 'colPromotion'), sort: (o) => money(o, 'promotion_iqd'), cell: (o) => { const p = money(o, 'promotion_iqd'), s = sales(o); return <Amount v={p} usd={u} warn={p != null && s != null && p > s} />; },
      total: <TotalAmount t={sum('promotion_iqd')} usd={u} chip={missingChip(loc, sum('promotion_iqd'))} /> },
    { key: 'investor', head: rs(loc, 'colInvestor'), sort: (o) => money(o, 'investor_iqd'), cell: (o) => <Amount v={money(o, 'investor_iqd')} usd={u} missing={wait} />,
      total: <TotalAmount t={sum('investor_iqd')} usd={u} chip={waitingChip(loc, sum('investor_iqd'))} /> },
    // The calculated orders' net names the ones on a sale-time estimate, as the strip's chips and the goods-cost total do (the fourth review).
    { key: 'net', head: rs(loc, 'colNet'), sort: (o) => netOf(o, money), cell: (o) => <b><Amount v={netOf(o, money)} usd={u} missing={wait} /></b>,
      total: <><b>{netCell}</b>{estimatedTotal(loc, countWhereKnown(rows, (o) => netOf(o, money), (o) => (costOnEstimate(o, standingOf(o, data)) ? 1 : 0)))}</> },
    { key: 'margin', head: fw(loc, 'marginCol'), sort: (o) => share(netOf(o, money), revenueOf(o, money, usd)), cell: margin,
      total: pct(share(net.net, net.revenue)) ?? (net.orders === 0 ? (net.waiting > 0 ? <MissingValue text={fw(loc, 'waitingN', { n: net.waiting })} /> : null) : fw(loc, 'noSales')) },
    { key: 'status', head: rs(loc, 'status'), start: true, cell: status, total: <small className="fw-muted">{rs(loc, 'netTotal', { n: net.orders })}</small>, span: 2 },
    { key: 'cash', head: fw(loc, 'cash'), start: true, cell: cash, span: 0 },
  ];
  function wages(o: FinanceOrder): Num { return (o.pending_costs ?? 0) > 0 ? null : money(o, 'wages_iqd'); }
  // A type chosen on a wide screen keeps filtering on a phone, where its menu is hidden: a chip says so and takes it off.
  const kindName = kind ? rs(loc, kind === 'gift' ? 'kindGift' : kind === 'quick_buy' ? 'kindQuick' : 'kindNormal') : '';
  const strip = <div className="fw-strip" data-finance-strip>
    <span>{fw(loc, 'orders')} <b>{rows.length}</b></span>
    <span>{rs(loc, 'colSales')} <b><Amount v={totalOf(rows, sales).sum} usd={u} /></b></span>
    <span>{rs(loc, 'colNet')} <b>{netCell}</b> <span className="fw-muted" dir="ltr">({net.orders}/{rows.length})</span></span>
    <span className="fw-strip-chips"><Status tone="positive">{fw(loc, 'confirmedN', { n: shown.confirmed })}</Status><Status tone="warning">{fw(loc, 'estimatedN', { n: shown.estimated })}</Status>
      <Status>{fw(loc, 'waitingN', { n: shown.waiting })}</Status></span>
    <span className="fw-muted">{rs(loc, u ? 'amountsUsd' : 'amountsIqd')}</span>
  </div>;
  const filters: Array<[StateFilter, string]> = [['', rs(loc, 'stateAll', { n: counts.all })], ['confirmed', fw(loc, 'confirmedN', { n: counts.confirmed })], ['estimated', fw(loc, 'estimatedN', { n: counts.estimated })],
    ['waiting', fw(loc, 'waitingN', { n: counts.waiting })], ...REASONS.filter((r) => counts.reasons[r]).map((r): [StateFilter, string] => [`reason:${r}`, rs(loc, 'stateWaitingFor', { reason: `${rs(loc, REASON_CHIP[r])} (${counts.reasons[r]})` })])];
  return <div className="fw-body" data-finance-orders-report>
    <Surface>
      <div className="fw-toolbar fw-toolbar--wrap"><SearchBox value={q} onChange={setQ} placeholder={rs(loc, 'search')} />
        <label className="fw-chip"><span className="fw-muted">{rs(loc, 'status')}</span><select className="fw-select" value={state} onChange={(e) => setState(e.target.value as StateFilter)} data-finance-state-filter>
          {filters.map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select></label>
        <label className="fw-chip fw-wide-only"><span className="fw-muted">{rs(loc, 'kind')}</span><select className="fw-select" value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} data-finance-order-kind>
          <option value="">{rs(loc, 'kindAll')}</option><option value="normal">{rs(loc, 'kindNormal')}</option><option value="quick_buy">{rs(loc, 'kindQuick')}</option><option value="gift">{rs(loc, 'kindGift')}</option></select></label>
        <ScopeChip label={scope?.label ?? null} onClear={onClearScope} />
        {narrow && <ScopeChip label={kind ? rs(loc, 'kindFilter', { name: kindName }) : null} onClear={() => setKind('')} attr="data-finance-kind-chip" />}
        <ExportLink data={data} query={exportQuery({ view: 'orders', q, state, kind, scope: ref })} />
        <OrdersFileLinks data={data} query={exportQuery({ view: 'orders', q, state, kind, scope: ref })} />
      </div>
      {strip}
      <UsdNote data={data} />
      {rows.length ? <ReportTable name="orders" cols={cols} rows={rows} sort={sort} onSort={setSort} rowKey={orderId} onRow={open} rowLabel={(o) => rs(loc, 'openOrder', { id: shortId(orderId(o)) })}
        attrs={(o) => ({ 'data-finance-order': orderId(o), 'data-finance-state': standingOf(o, data).state })}
        phone={(o) => ({ a: <b dir="ltr">{shortId(orderId(o))}</b>, b: netOf(o, money) == null ? said(o) : <b><Amount v={netOf(o, money)} usd={u} /></b>,
          c: <>{dayIn(L, financeDay(o.delivered_at || o.created_at), data.range)} · <Amount v={sales(o)} usd={u} /></>, e: netOf(o, money) == null ? undefined : said(o) })} />
        : <p className="fw-note" role="status">{data.orders.length ? rs(loc, 'noMatch') : rs(loc, 'noneInPeriod')}</p>}
      <p className="fw-note">{rs(loc, 'ordersNote')}</p>
    </Surface>
    <OrderKinds data={data} />
  </div>;
}

/**
 * «حسب نوع الطلب»: the period's delivered orders split by what made them (0174) — the cart, a Quick Buy, gifts only —
 * from the summary. It stood on the old overview; the redesign keeps it with the orders (independent review, 2026-11-11).
 * On a phone a list (the review of step 4: its last column was cut at 390 px).
 */
function OrderKinds({ data }: { data: FinanceSummary }) {
  const { loc } = useLanguage();
  const usd = useUsd(data), narrow = useNarrow();
  if (!data.kinds?.length) return null;
  const cents = (kind: string, field: string) => (usd ? centsAt(usd.kinds?.[kind] ?? {}, field) : undefined);
  const name = (kind: string) => (kind === 'quick_buy' ? `⚡ ${rs(loc, 'kindQuick')}` : kind === 'gift' ? `🎁 ${rs(loc, 'kindGift')}` : rs(loc, 'kindNormal'));
  return <Surface title={rs(loc, 'kindsTitle')} subtitle={rs(loc, 'kindsNote')}>
    {narrow ? <ul className="fw-rows" data-finance-kinds>{data.kinds.map((k) => <li key={k.kind}><div>
      <span className="fw-rows-a">{name(k.kind)}</span><span className="fw-rows-b"><DisplayMoney iqd={k.net_goods_iqd} cents={cents(k.kind, 'net_goods_iqd')} compact /></span>
      <span className="fw-rows-c">{fw(loc, 'orders')}: {k.orders_count} · {fw(loc, 'grossProfit')} <DisplayMoney iqd={k.gross_profit_iqd} cents={cents(k.kind, 'gross_profit_iqd')} compact /></span></div></li>)}</ul>
      : <div className="fw-table-wrap"><table className="fw-table" data-finance-kinds>
        <thead><tr><th scope="col">{rs(loc, 'kind')}</th><th scope="col">{fw(loc, 'orders')}</th><th scope="col">{fw(loc, 'netSales')}</th><th scope="col">{fw(loc, 'grossProfit')}</th></tr></thead>
        <tbody>{data.kinds.map((k) => <tr key={k.kind}><th scope="row">{name(k.kind)}</th><td>{k.orders_count}</td>
          <td><DisplayMoney iqd={k.net_goods_iqd} cents={cents(k.kind, 'net_goods_iqd')} compact /></td><td><DisplayMoney iqd={k.gross_profit_iqd} cents={cents(k.kind, 'gross_profit_iqd')} compact /></td></tr>)}</tbody>
      </table></div>}
    <p className="fw-note">{rs(loc, 'kindsGift')}</p>
  </Surface>;
}

// ------------------------------------------------------------------ products and sections
/** A section's name in the reader's language; the screen words a line with no section (or no subsection) itself. */
export function sectionName(loc: Loc, p: Pick<FinanceProduct, 'id' | 'name' | 'name_ar' | 'name_en' | 'name_ckb' | 'level'>): string {
  if (p.id === 'unclassified') return rs(loc, p.level === 'sub' ? 'noSub' : 'unclassified');
  if (p.id === ORDER_LEVEL) return rs(loc, 'orderLevel');
  const ar = p.name_ar || p.name;
  return loc(ar, p.name_en || ar, p.name_ckb || undefined);
}
export function GroupsReport({ data, level, onLevel, onOpenOrders, onMissing }: {
  data: FinanceSummary; level: 'product' | 'main' | 'sub'; onLevel?: (level: 'main' | 'sub') => void; onOpenOrders: (scope: ScopeRef) => void; onMissing: () => void;
}) {
  const { loc } = useLanguage();
  const usd = useUsd(data), u = !!usd, money = useMemo(() => groupMoney(usd, level), [usd, level]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'gross', dir: 'desc' });
  const all = useMemo(() => (level === 'product' ? data.products : data.categories ?? []), [data, level]);
  const rows = useMemo(() => filterGroups(all, level, q), [all, level, q]);
  // What no product carries, after the others, while the table is whole (a search shows the rows it found, as the file does).
  const pinned = useMemo(() => { const o = q.trim() ? null : orderLevelRow(data, level); return o ? [o] : []; }, [data, level, q]);
  const every = [...rows, ...pinned];
  const lvl = (p: FinanceProduct) => p.id === ORDER_LEVEL;
  const nameOf = (p: FinanceProduct) => (lvl(p) ? rs(loc, 'orderLevel') : level === 'product' ? p.name : sectionName(loc, p));
  const mains = new Map((data.categories ?? []).filter((c) => c.level === 'main').map((c) => [c.id, c]));
  const sectionOf = (p: FinanceProduct) => { if (lvl(p)) return ''; const m = p.main_id ? mains.get(p.main_id) : undefined; return m ? sectionName(loc, m) : p.main_id === 'unclassified' ? rs(loc, 'unclassified') : p.main_name ?? ''; };
  const sales = (p: FinanceProduct) => groupSales(p, money), gross = (p: FinanceProduct) => money(p, 'gross_profit_iqd'), net = (p: FinanceProduct) => groupNet(p, money);
  const grossRows = rows.map(gross);
  const t = (f: (p: FinanceProduct) => Num) => totalOf(every, f);
  const known = every.filter((p) => gross(p) != null);
  const standing = (p: FinanceProduct): OrderStanding | null => (p.finance_state ? { state: p.finance_state, reason: p.finance_state === 'waiting' ? p.wait_reason ?? 'other' : null } : null);
  const status = (p: FinanceProduct) => { const s = standing(p); return s && <StandingChip s={s} onMissing={onMissing} />; };
  const said = (p: FinanceProduct) => { const s = standing(p); return s && <StandingChip s={s} />; };
  const wait = <MissingValue text={fw(loc, 'waitingCell')} />;
  // A waiting row whose known goods cost rests on estimated lines: its chip names what it waits for, so the cost names the estimate.
  const onEstimate = (p: FinanceProduct) => p.finance_state === 'waiting' && money(p, 'cogs_iqd') != null && groupOnEstimate(p);
  // An unknown goods cost names why: a missing purchase price, or a returned piece's cost.
  const noCost = (p: FinanceProduct) => <MissingValue text={rs(loc, p.wait_reason === 'return_cost' ? 'stReturnCost' : 'stNoPrice')} />;
  const pieces = (p: FinanceProduct) => <span className="fw-num">{piecesOf(p)}{(p.returned_qty ?? 0) > 0 && <small>{rs(loc, 'returnedN', { n: p.returned_qty ?? 0 })}</small>}</span>;
  const refunds = every.filter((p) => (p.unknown_refunds ?? 0) > 0).length;
  // A known total names how many rows above it rest on estimated lines: the goods cost's, the gross's and the net's (the fourth review).
  const estimates = (f: (p: FinanceProduct) => Num) => estimatedTotal(loc, countWhereKnown(every, f, (p) => (groupOnEstimate(p) ? 1 : 0)));
  // The order-level row has nothing sold: only its net (its deductions) is drawn; its other cells stay empty, never a 0 that reads as a sale.
  const own = (cell: (p: FinanceProduct) => ReactNode) => (p: FinanceProduct) => (lvl(p) ? null : cell(p));
  const cols: Col<FinanceProduct>[] = [
    { key: 'name', head: level === 'product' ? fw(loc, 'product') : rs(loc, 'colSection'), start: true, sort: nameOf, cell: (p) => <bdi className="fw-name">{nameOf(p)}</bdi>, total: <b>{rs(loc, 'total')}</b> },
    ...(level === 'product' ? [{ key: 'section', head: rs(loc, 'colSection'), start: true, sort: sectionOf, cell: (p: FinanceProduct) => <span className="fw-muted">{sectionOf(p)}</span>, total: null }] : []),
    { key: 'pieces', head: fw(loc, 'pieces'), sort: piecesOf, cell: own(pieces), total: <span className="fw-num">{rows.reduce((v, p) => v + piecesOf(p), 0)}</span> },
    { key: 'sales', head: rs(loc, 'colSales'), sort: sales, cell: own((p) => <><Amount v={sales(p)} usd={u} />{refundCell(loc, (p.unknown_refunds ?? 0) > 0)}</>),
      total: <><TotalAmount t={t(sales)} usd={u} chip={missingChip(loc, t(sales))} />{refundTotal(loc, refunds)}</> },
    // As on the orders: a waiting row's known goods cost on an estimate says so, and the total counts the rows whose cost rests on one.
    { key: 'cogs', head: fw(loc, 'cogs'), sort: (p) => money(p, 'cogs_iqd'), cell: own((p) => <><Amount v={money(p, 'cogs_iqd')} usd={u} missing={noCost(p)} />{estimatedCell(loc, onEstimate(p))}</>),
      total: <><TotalAmount t={t((p) => money(p, 'cogs_iqd'))} usd={u} chip={missingChip(loc, t((p) => money(p, 'cogs_iqd')))} />{estimates((p) => money(p, 'cogs_iqd'))}</> },
    { key: 'gross', head: fw(loc, 'grossProfit'), sort: gross, cell: own((p) => <span className="fw-gross"><b><Amount v={gross(p)} usd={u} missing={<MissingValue />} /></b>{barOf(gross(p), grossRows) > 0 && <i className="fw-gbar" aria-hidden><i style={{ width: `${barOf(gross(p), grossRows)}%` }} /></i>}</span>),
      total: <><TotalAmount t={t(gross)} usd={u} chip={missingChip(loc, t(gross))} />{estimates(gross)}</> },
    { key: 'margin', head: fw(loc, 'marginCol'), sort: (p) => share(gross(p), sales(p)), cell: own((p) => pct(share(gross(p), sales(p))) ?? (gross(p) == null ? <MissingValue /> : fw(loc, 'noSales'))),
      total: pct(share(totalOf(known, gross).sum, totalOf(known, sales).sum)) },
    { key: 'promotion', head: rs(loc, 'colPromotion'), sort: (p) => money(p, 'promotion_iqd'), cell: own((p) => { const v = money(p, 'promotion_iqd'), s = sales(p); return <Amount v={v} usd={u} warn={v != null && s != null && v > s} />; }),
      total: <TotalAmount t={t((p) => money(p, 'promotion_iqd'))} usd={u} chip={missingChip(loc, t((p) => money(p, 'promotion_iqd')))} /> },
    { key: 'net', head: rs(loc, 'colNet'), sub: rs(loc, 'netBefore'), sort: net, cell: (p) => <b><Amount v={net(p)} usd={u} missing={wait} /></b>,
      total: <><b><TotalAmount t={t(net)} usd={u} chip={waitingChip(loc, t(net))} /></b>{estimates(net)}</> },
    { key: 'status', head: rs(loc, 'status'), start: true, cell: own(status), total: null },
  ];
  const open = (p: FinanceProduct) => { if (p.order_ids?.length) onOpenOrders({ kind: level, id: p.id, name: nameOf(p) }); };
  // A phone row: the gross (or the chip of why it is unknown), the pieces kept, sales and promotion, then the margin — and the
  // status of a row that is not confirmed, unless the gross's chip already says it (the review of step 4: an estimate is always named),
  // with «تقديري» beside a waiting row's status when its known gross rests on estimated lines (the third review).
  const phone = (p: FinanceProduct): PhoneRow => {
    if (lvl(p)) return { a: <bdi className="fw-name">{nameOf(p)}</bdi>, b: <b><Amount v={net(p)} usd={u} missing={wait} /></b>, c: <>{fw(loc, 'orders')}: {p.orders_count ?? 0}</> };
    const s = standing(p), g = gross(p), chip = s && s.state !== 'confirmed' && g != null ? said(p) : null;
    return { a: <bdi className="fw-name">{nameOf(p)}</bdi>, b: g == null ? said(p) ?? noCost(p) : <b><Amount v={g} usd={u} /></b>,
      c: <>{fw(loc, 'pieces')}: {piecesOf(p)} · <Amount v={sales(p)} usd={u} /> · {rs(loc, 'colPromotion')} <Amount v={money(p, 'promotion_iqd')} usd={u} /></>,
      e: <>{pct(share(g, sales(p)))}{chip && <> {chip}</>}{estimatedCell(loc, g != null && onEstimate(p))}</> };
  };
  return <Surface>
    <div className="fw-toolbar fw-toolbar--wrap"><SearchBox value={q} onChange={setQ} placeholder={rs(loc, level === 'product' ? 'searchProducts' : 'searchSections')} />
      {onLevel && level !== 'product' && <div className="fw-filter-pills fw-pills-inline" role="group" aria-label={fw(loc, 'sectionsPage')}>
        {(['main', 'sub'] as const).map((l) => <button key={l} type="button" className="fw-pill" aria-pressed={level === l} data-finance-level={l} onClick={() => onLevel(l)}>{rs(loc, l === 'main' ? 'levelMain' : 'levelSub')}</button>)}</div>}
      <ExportLink data={data} query={exportQuery(level === 'product' ? { view: 'products', q } : { view: 'sections', level, q })} />
    </div>
    <UsdNote data={data} />
    {rows.length ? <ReportTable name={level === 'product' ? 'products' : `sections-${level}`} cols={cols} rows={rows} pinned={pinned} sort={sort} onSort={setSort} rowKey={(p) => `${p.level}:${p.id}`}
      onRow={open} opens={(p) => (p.order_ids?.length ?? 0) > 0} rowLabel={(p) => rs(loc, 'openGroupOrders', { name: nameOf(p) })} attrs={(p) => ({ 'data-finance-group': p.id, 'data-finance-state': p.finance_state })}
      // On a phone the gross is the list's one total: it names its estimates too, beside its amount (the fourth review).
      phone={phone} phoneTotal={<><b>{rs(loc, 'total')}</b><span><TotalAmount t={t(gross)} usd={u} chip={missingChip(loc, t(gross))} />{estimates(gross)}</span></>} />
      : <p className="fw-note" role="status">{all.length ? rs(loc, 'noMatch') : rs(loc, 'noneInPeriod')}</p>}
    <p className="fw-note">{rs(loc, 'productsNote')}</p>
  </Surface>;
}

// ------------------------------------------------------------------ days
export function DaysReport({ data, onOpenOrders }: { data: FinanceSummary; onOpenOrders: (scope: ScopeRef) => void }) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang, usd = useUsd(data), u = !!usd;
  const [by, setBy] = useState<DayGroup>('day');
  const [sort, setSort] = useState<Sort>({ key: 'day', dir: 'asc' });
  const rows = useMemo(() => groupDays(data.chart_data?.daily ?? [], by, data.orders, data, usd), [data, by, usd]);
  const label = (r: DayRow) => (by === 'day' ? dayIn(L, r.from, data.range) : daysText(L, r.from, r.to, data.range));
  // A cell's chip counts the orders that make THAT column unknown; the totals' chip the same orders, summed — never days.
  const waits = (n: number) => <MissingValue text={n ? fw(loc, 'waitingN', { n }) : fw(loc, 'missingCell')} />;
  const est = (n: number) => estimatedTotal(loc, n);
  const t = (f: (r: DayRow) => Num) => totalOf(rows, f);
  const deductions = rows.some((r) => r.deductions !== 0);
  const cost = (r: DayRow) => r.cost, investor = (r: DayRow) => r.investor, net = (r: DayRow) => r.net;
  const cols: Col<DayRow>[] = [
    { key: 'day', head: rs(loc, by === 'day' ? 'colDay' : by === 'week' ? 'colWeek' : 'colMonth'), start: true, sort: (r) => r.from, cell: label, total: <b>{rs(loc, 'total')}</b> },
    { key: 'orders', head: fw(loc, 'orders'), sort: (r) => r.orders, cell: (r) => <span className="fw-num">{r.orders}</span>, total: <span className="fw-num">{rows.reduce((v, r) => v + r.orders, 0)}</span> },
    { key: 'revenue', head: rs(loc, 'colRevenue'), sort: (r) => r.revenue, cell: (r) => <><Amount v={r.revenue} usd={u} />{refundTotal(loc, r.refunds)}</>,
      total: <><TotalAmount t={t((r) => r.revenue)} usd={u} chip={null} />{refundTotal(loc, rows.reduce((v, r) => v + r.refunds, 0))}</> },
    // A known cost that holds a sale-time estimate names it (owner decision 3) — a waiting order's too (restsOnEstimate) — as «صافيك» below does.
    { key: 'cost', head: fw(loc, 'costs'), sort: cost, cell: (r) => <><Amount v={r.cost} usd={u} missing={waits(r.costWaits)} />{r.cost != null && est(r.estimated)}</>,
      total: <><TotalAmount t={t(cost)} usd={u} chip={waits(countWhereUnknown(rows, cost, (r) => r.costWaits))} />{est(countWhereKnown(rows, cost, (r) => r.estimated))}</> },
    { key: 'investor', head: fw(loc, 'investor'), sort: investor, cell: (r) => <Amount v={r.investor} usd={u} missing={waits(r.investorWaits)} />,
      total: <TotalAmount t={t(investor)} usd={u} chip={waits(countWhereUnknown(rows, investor, (r) => r.investorWaits))} /> },
    ...(deductions ? [{ key: 'deductions', head: rs(loc, 'colDeductions'), sort: (r: DayRow) => r.deductions, cell: (r: DayRow) => <Amount v={r.deductions} usd={u} />, total: <TotalAmount t={t((r) => r.deductions)} usd={u} chip={null} /> }] : []),
    // «صافيك» names the orders it counts on a sale-time estimate (owner decision 3), the day's and the total's.
    { key: 'net', head: rs(loc, 'colNet'), sort: net, cell: (r) => <><b><Amount v={r.net} usd={u} missing={waits(r.waiting)} /></b>{r.net != null && est(r.estimated)}</>,
      total: <><b><TotalAmount t={t(net)} usd={u} chip={waits(countWhereUnknown(rows, net, (r) => r.waiting))} /></b>{est(countWhereKnown(rows, net, (r) => r.estimated))}</> },
  ];
  const open = (r: DayRow) => onOpenOrders({ kind: 'days', from: r.from, to: r.to });
  return <Surface>
    <div className="fw-toolbar fw-toolbar--wrap"><div className="fw-filter-pills fw-pills-inline" role="group" aria-label={rs(loc, 'groupBy')}>
      {(['day', 'week', 'month'] as const).map((g) => <button key={g} type="button" className="fw-pill" aria-pressed={by === g} data-finance-group-by={g} onClick={() => setBy(g)}>{rs(loc, g === 'day' ? 'byDay' : g === 'week' ? 'byWeek' : 'byMonth')}</button>)}</div>
      <ExportLink data={data} query={exportQuery({ view: 'days', by })} /></div>
    <UsdNote data={data} />
    {rows.length ? <ReportTable name="days" cols={cols} rows={rows} sort={sort} onSort={setSort} rowKey={(r) => r.key} onRow={open} opens={(r) => r.orders > 0} rowLabel={(r) => rs(loc, 'filterDay', { name: label(r) })}
      attrs={(r) => ({ 'data-finance-day': r.key })}
      phone={(r) => ({ a: label(r), b: <><b><Amount v={r.net} usd={u} missing={waits(r.waiting)} /></b>{r.net != null && est(r.estimated)}</>, c: <>{fw(loc, 'orders')}: {r.orders} · <Amount v={r.revenue} usd={u} /></> })}
      // The phone's total names the estimates its known net holds, as the desktop's totals row and each row above it do (the third review),
      // its chips kept beside its amount at the end of the line (the fourth).
      phoneTotal={<><b>{rs(loc, 'total')}</b><span><TotalAmount t={t(net)} usd={u} chip={waits(countWhereUnknown(rows, net, (r) => r.waiting))} />{est(countWhereKnown(rows, net, (r) => r.estimated))}</span></>} />
      : <p className="fw-note" role="status">{rs(loc, 'noneInPeriod')}</p>}
    <p className="fw-note">{rs(loc, 'daysNote')}</p>
  </Surface>;
}

