import { useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Button, Sheet, Status } from './ui';
import { MissingValue, useDisplayCurrency } from './displayCurrency';
import { dayIn, fw, rangeText, type FwKey } from './overviewStrings';
import { rs } from './reportStrings';
import { drill, drillParts, FORMULA, headline, rowOnEstimate, type DrillPart, type FigureKey } from './drill';
import { Amount, estimatedCell, estimatedTotal, FIRST, standingText, stepOf, UsdNote } from './Reports';
import { exportQuery, orderId } from './reportTable';
import { financeDay, WORKSPACE_API, type FinanceSection, type FinanceSummary } from './types';
import type { OrderFocus } from './OrderProfitSheet';
import { DrawerGeneralEntries } from './GeneralExpenses';
import { cs } from './costsStrings';

/**
 * «فتح رقم» — THE FIGURE DRAWER (redesign step 4, owner 2026-11-11; DECISIONS row 316).
 *
 * A card of the overview, a line of the statement or a cash figure opens here on the orders that make it: the
 * figure as the overview shows it and on how many orders it stands, its formula in words, then — one column of the
 * statement at a time, «محسوبة» or «تنتظر» — each order with its value (largest first), whether it is confirmed or
 * estimated or what it waits for, its day, revenue and promotion, and the overheads no order carries as rows of their
 * own, so the list adds up to the statement's cell (drill.ts; tests/financeDrill.test.ts). Each order opens its sheet,
 * on top of the drawer; closing either gives focus back to what opened it. A side panel on a wide screen, the whole
 * screen on a phone. Money is the server's; in dollars its cents.
 *
 * The independent review of step 4: the dates and the file are the read's own (`data.range`), never the period bar's
 * while another period loads; a period with no delivered order opens on the period and its overheads, not on an empty
 * «تنتظر (0)»; the first FIRST orders, then «عرض الكل», with the total and the overhead rows always there; the amounts
 * name their currency; a cash figure stands on the orders with cash in it, and its file is those orders. The fourth: a known
 * goods cost, gross or net that rests on a sale-time estimate is named as Reports names it — «تقديري» beside a waiting row's
 * value (its chip names what it waits for), «تقديري n» beside the total and the headline (owner decision 3; drill.ts rowOnEstimate).
 */
type Lang = 'ar' | 'en' | 'ckb';
/** The name of each figure, as the statement and the cards write it. */
export const FIGURE_NAME: Record<FigureKey, FwKey> = { sales: 'netSales', cogs: 'cogs', gross: 'grossProfit', delivery: 'delivery', cod: 'cod', wages: 'wages', materials: 'materials',
  fees: 'fees', promotion: 'promo', investor: 'investor', general: 'expenses', deductions: 'deductions', net: 'netShare', cashDue: 'cashDue', cashOpen: 'cashOpen' };

type Props = { data: FinanceSummary; figure: FigureKey; from: string; to: string; onClose: () => void; openOrder: (id: string, step?: OrderFocus) => void; onNavigate: (section: FinanceSection) => void };
export default function FigureDrawer(props: Props) {
  const { loc, lang } = useLanguage();
  const range = props.data.range ?? { from: props.from, to: props.to };
  return <Sheet side title={fw(loc, FIGURE_NAME[props.figure])} subtitle={<bdi>{rangeText(lang as Lang, range.from, range.to)}</bdi>} onClose={props.onClose}><FigureBody {...props} /></Sheet>;
}
/** The export of one part of the drawer: a column of the statement (or the period), or the orders a cash figure lists. */
const partQuery = (figure: FigureKey, part: DrillPart) => exportQuery(part === 'all'
  ? { view: 'orders', cash: figure === 'cashOpen' ? 'open' : 'due' }
  : { view: 'orders', part: part === 0 ? 'calculated' : part === 1 ? 'waiting' : 'period' });
/** The drawer's content (its own component, so a test can draw it without the dialog's portal). */
export function FigureBody({ data, figure, from, to, onClose, openOrder, onNavigate }: Props) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang, currency = useDisplayCurrency(), range = data.range ?? { from, to };
  const usd = currency === 'USD' && data.display_usd?.available ? data.display_usd : undefined;
  const parts = drillParts(data, figure);
  const [pick, setPick] = useState<DrillPart>(parts[0]);
  const [all, setAll] = useState(false);
  const part = parts.includes(pick) ? pick : parts[0];
  const d = drill(data, figure, part, usd), head = headline(data, figure, usd), u = d.currency === 'USD';
  const name = fw(loc, FIGURE_NAME[figure]);
  const orders = d.rows.filter((r) => r.kind === 'order'), overheads = d.rows.filter((r) => r.kind !== 'order');
  const shown = all ? orders : orders.slice(0, FIRST);
  const count = (p: DrillPart) => (p === 1 ? data.waiting?.orders_count ?? 0 : p === 2 ? data.totals.orders_count ?? data.orders.length : data.known?.orders_count ?? 0);
  const tab = (p: DrillPart) => (p === 'all' ? rs(loc, 'tabOrders', { n: orders.length }) : fw(loc, p === 0 ? 'colCalculated' : p === 1 ? 'colWaiting' : 'colPeriod', { n: count(p) }));
  // A cash figure stands on the orders with cash in it — the rows below — not on every order of the period.
  const basis = figure === 'cashDue' || figure === 'cashOpen' ? rs(loc, figure === 'cashDue' ? 'cashDueBasis' : 'cashOpenBasis', { n: orders.length })
    : head.orders === head.all ? rs(loc, 'periodBasis', { n: head.all }) : fw(loc, 'completeTitle', { n: head.orders, m: head.all });
  const csv = `${WORKSPACE_API}/export.csv?from=${range.from}&to=${range.to}${partQuery(figure, part)}`;
  const t = data.totals;
  const unknown = <MissingValue text={fw(loc, part === 1 ? 'waitingCell' : 'missingCell')} />;
  const formula = rs(loc, FORMULA[figure]);
  return <div className="fw-drawer" data-finance-drawer={figure} data-finance-drawer-part={String(part)}>
      <div className="fw-drawer-total"><strong><Amount v={head.value} usd={u} missing={unknown} /></strong>
        <small className="fw-muted">{basis}</small>{head.value != null && estimatedTotal(loc, head.estimated)}<small className="fw-muted" data-finance-drawer-currency>{rs(loc, u ? 'amountsUsd' : 'amountsIqd')}</small></div>
      {/* A formula that names its figure («صافي حصتك = …») needs no «=» before it; a definition does. */}
      <p className="fw-formula" data-finance-formula>{!formula.includes(' = ') && <><b aria-hidden>=</b> </>}{formula}</p>
      <UsdNote data={data} />
      {figure === 'fees' && (t.collected_iqd ?? 0) === 0 && (t.collection_difference_iqd ?? 0) > 0 && <p className="fw-note">{fw(loc, 'feesNote')}</p>}
      {/* Step 5's review: one note for the general line — no order carries it, each column its share, the entries below. */}
      {figure === 'general' && <p className="fw-note">{cs(loc, 'drawerGeneralNote')}</p>}
      <div className="fw-drawer-tools">
        {parts.length > 1 ? <div className="fw-seg fw-seg--on" role="group" aria-label={name}>
          {parts.map((p) => <button key={String(p)} type="button" aria-pressed={part === p} onClick={() => { setPick(p); setAll(false); }} data-finance-drawer-tab={String(p)}>{tab(p)}</button>)}</div>
          : <span className="fw-muted" data-finance-drawer-tab={String(part)}>{tab(part)}</span>}
        {figure !== 'general' && <a className="fw-button fw-button--ghost" href={csv} data-finance-drawer-csv><ArrowDownToLine size={16} aria-hidden /><span>{u ? rs(loc, 'exportIqd') : fw(loc, 'exportCsv')}</span></a>}
      </div>
      {d.rows.length ? <ul className="fw-rows fw-drill" data-finance-drill>{shown.map((r) => {
        if (r.kind !== 'order') return null;
        const id = orderId(r.order), s = r.standing;
        return <li key={id} data-finance-drill-row={id}><button type="button" onClick={() => openOrder(id, stepOf(r.order, s))} aria-label={rs(loc, 'openOrder', { id })}>
          <span className="fw-rows-a"><b dir="ltr">{id.replace(/^ORD-/, '')}</b> <Status tone={s.state === 'confirmed' ? 'positive' : s.reason === 'no_price' ? 'danger' : 'warning'}>{standingText(loc, s)}</Status></span>
          <span className="fw-rows-b"><b><Amount v={r.value} usd={u} missing={unknown} /></b>{estimatedCell(loc, s.state !== 'estimated' && rowOnEstimate(figure, r))}</span>
          <span className="fw-rows-c">{dayIn(L, financeDay(r.order.delivered_at || r.order.created_at), range)}
            {r.revenue != null && <> · {rs(loc, 'revenueShort', { amount: '' })}<Amount v={r.revenue} usd={u} /></>}
            {r.promotion != null && figure !== 'promotion' && <> · {rs(loc, 'promoShort', { amount: '' })}<Amount v={r.promotion} usd={u} /></>}</span>
          {r.margin != null && <span className="fw-rows-e"><bdi dir="ltr" className="fw-num">{(r.margin * 100).toFixed(1)}%</bdi></span>}
        </button></li>;
      })}
        {orders.length > shown.length && <li className="fw-rows-more"><button type="button" className="fw-button fw-button--ghost" onClick={() => setAll(true)} data-finance-drill-more>{rs(loc, 'showAll', { n: orders.length })}</button></li>}
        {overheads.map((r) => <li key={r.kind} className="fw-drill-overhead" data-finance-drill-row={r.kind}><div>
          <span className="fw-rows-a">{rs(loc, r.kind === 'general' ? 'generalRow' : r.kind === 'unallocated' ? 'unallocatedRow' : 'overheadRow')}</span>
          <span className="fw-rows-b"><Amount v={r.value} usd={u} /></span></div></li>)}
        <li className="fw-rows-total" data-finance-drill-total><span>{rs(loc, 'total')}</span><span><b><Amount v={d.total} usd={u} missing={unknown} /></b>{d.total != null && estimatedTotal(loc, d.estimated)}</span></li>
      </ul> : figure !== 'general' && <p className="fw-note" role="status">{rs(loc, part === 2 ? 'noneInPeriod' : 'noOrdersHere')}</p>}
      {/* Redesign step 5 (DECISIONS row 317): the general line lists the period's entries, its total the period's figure. */}
      {figure === 'general' && <DrawerGeneralEntries from={range.from} to={range.to} usdCents={u ? usd?.totals?.general_expenses_cents ?? null : undefined} />}
      {figure === 'promotion' && <Button variant="secondary" onClick={() => { onClose(); onNavigate('monthly'); }}>{rs(loc, 'openPromotion')}</Button>}
      {figure === 'general' && <Button variant="secondary" onClick={() => { onClose(); onNavigate('expenses'); }}>{rs(loc, 'openExpenses')}</Button>}
    </div>;
}
