import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ArrowUpLeft, CheckCircle2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, Money, Status, Surface, cardClick, formatMoney, useNarrow } from './ui';
import { DisplayMoney, MissingValue, UsdBasisNote, centsAt, usdText, useDisplayCurrency } from './displayCurrency';
import { averageOrder, overviewNet } from './overviewFigures';
import { statementColumns, statementRows, type StatementKey } from './statement';
import { change, signFlip } from './compare';
import { fw, rangeText, type FwKey } from './overviewStrings';
import { financeDay, type DisplayUsdSummary, type FinanceSection, type FinanceSummary, type FinanceWaitReason } from './types';
import type { OrderFocus } from './OrderProfitSheet';
import { columnEstimates, type FigureKey } from './drill';
import { piecesOf } from './reportTable';
import { rs } from './reportStrings';

/**
 * «نظرة عامة» — THE OVERVIEW OF «المال والأرباح» (redesign step 3, owner 2026-11-11).
 *
 * Summary before detail, every figure on a printed basis, and nothing bare: how much of
 * the period is calculated (and how much of that on estimates), four cards that each
 * compare like with like, the revenue curve against the comparison period, what waits
 * for the owner, then the statement from sales to «صافي حصتك» in three columns. No chart
 * library: the curve and the sparklines are drawn here, so the overview no longer
 * downloads one. Money stays exactly what the server answers — in dollars its cents, never
 * a conversion and never dinars beside a dollar figure; this file only words it.
 */
type Lang = 'ar' | 'en' | 'ckb';
/** One person of /finance-people/people: today's balances (what can be paid now, what is held). */
export type PayoutPerson = { user_id: string | null; staff_id?: string; name: string; investor?: unknown; work?: unknown; combined?: { available_iqd?: number; held_iqd?: number } };
export type People = { list: PayoutPerson[] | null; error: boolean };
type OpenOrder = (id: string, step?: OrderFocus) => void;

/** The payouts are today's balances, not the period's: read once per visit, and again on «تحديث». */
function usePeople(revision: number): People {
  const [state, setState] = useState<People>({ list: null, error: false });
  useEffect(() => {
    let live = true;
    api.get<{ people: PayoutPerson[] }>('/api/admin/finance-people/people', { mascot: 'silent' })
      .then((r) => { if (live) setState({ list: r.people ?? [], error: false }); }).catch(() => { if (live) setState({ list: [], error: true }); });
    return () => { live = false; };
  }, [revision]);
  return state;
}
const available = (p: PayoutPerson) => p.combined?.available_iqd ?? 0;
/** The page a person's payout is reviewed on: an investor's on «المستثمرون», anyone else's on «الموظفون». */
const pageOf = (p: PayoutPerson): FinanceSection => (p.investor ? 'investors' : 'staff');

export default function Overview({ data, prev, compareFrom, compareTo, revision = 0, openOrder, onNavigate, onMissing, onCollections, onFigure }: {
  data: FinanceSummary; prev: FinanceSummary | null; compareFrom?: string; compareTo?: string; revision?: number;
  openOrder: OpenOrder; onNavigate: (section: FinanceSection) => void; onMissing: () => void; onCollections: () => void;
  /** Opens a figure on the orders that make it (redesign step 4, the figure drawer). */
  onFigure?: (key: FigureKey) => void;
}) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang;
  const t = data.totals;
  const currency = useDisplayCurrency();
  // Server cents when the owner chose USD and a rate exists; undefined keeps every figure in dinars.
  const u = currency === 'USD' && data.display_usd?.available ? data.display_usd : undefined;
  const people = usePeople(revision);
  const figures = overviewNet(data, u);
  const prevFigures = prev ? overviewNet(prev) : null;
  const orders = t.orders_count ?? data.orders.length;
  const known = data.known ?? null;
  const vsText = compareFrom && compareTo ? fw(loc, 'vs', { range: rangeText(L, compareFrom, compareTo) }) : '';
  // An amount in a note, in the figure's currency: in dollars only the server's cents; without them the note leaves it out.
  const noteAmount = (iqd: number | null | undefined, cents: number | null | undefined) => (u ? (cents == null ? '' : usdText(cents)) : iqd == null ? '' : formatMoney(iqd));

  // A change is shown only between two figures on the same basis (in dinars, the accounting values); a partial one says so,
  // and one across zero says which way it turned — a percentage of a loss means nothing.
  const uid = useId();
  const whyOf = (key: FwKey) => `${uid}-why-${key}`;
  const delta = (now: number | null | undefined, before: number | null | undefined, partial = false, key?: FwKey) => {
    if (!prev) return null;
    // The reason in words too, not only as a tooltip; nothing covers the card (cardClick), so the tooltip shows and a click on it opens the card.
    // The third review of step 4: the card's button is described by it (a screen reader says why), the keyboard's focus on that
    // button shows it (the stylesheet), and a drag across the figures never copies it.
    if (partial) return <span className="fw-delta" title={fw(loc, 'partialWhy')} data-finance-delta="partial">{fw(loc, 'partial')}<span className="fw-sr" id={key && whyOf(key)}>: {fw(loc, 'partialWhy')}</span></span>;
    const turn = signFlip(now, before);
    if (turn) return <span className={`fw-delta ${turn === 'up' ? 'fw-up' : 'fw-down'}`} data-finance-delta={turn === 'up' ? 'loss-to-profit' : 'profit-to-loss'}>
      <span aria-hidden>{turn === 'up' ? '▲' : '▼'}</span>{fw(loc, turn === 'up' ? 'lossToProfit' : 'profitToLoss')} {vsText}</span>;
    const c = change(now, before);
    if (c === null) return <span className="fw-delta" data-finance-delta="none">{fw(loc, 'noCompare')}</span>;
    return <span className={`fw-delta${c > 0 ? ' fw-up' : c < 0 ? ' fw-down' : ''}`} data-finance-delta={c}>
      <span aria-hidden>{c > 0 ? '▲' : c < 0 ? '▼' : '•'}</span><bdi dir="ltr">{Math.abs(c * 100).toFixed(1)}%</bdi> {vsText}</span>;
  };

  const sales = t.retained_revenue_iqd ?? null;
  const fullGross = t.gross_profit_iqd != null;
  const gross = fullGross ? t.gross_profit_iqd! : known?.totals?.gross_profit_iqd ?? null;
  const grossCents = !u ? undefined : fullGross ? centsAt(u.totals, 'gross_profit_iqd') : u.known?.totals ? centsAt(u.known.totals, 'gross_profit_iqd') : null;
  const pct = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || b <= 0 ? null : `${(a / b * 100).toFixed(1)}%`);
  const grossPct = pct(gross, fullGross ? sales : known?.totals?.retained_revenue_iqd);
  const knownNote = known ? fw(loc, 'knownNote', { n: known.orders_count, m: orders }) : '';
  const sharePct = pct(figures.net, figures.marginBase);
  const estimated = figures.estimated && figures.estimated.orders > 0 ? figures.estimated : null;
  const part = (label: FwKey, p: { orders: number; net: number | null; cents: number | null | undefined }) => [fw(loc, label), noteAmount(p.net, p.cents), `(${p.orders})`].filter(Boolean).join(' ');
  const deducted = figures.deductions > 0 ? [fw(loc, 'deducted'), noteAmount(figures.deductions, figures.deductionsCents)].filter(Boolean).join(' −') : '';
  const average = averageOrder(data, u);
  const daily = data.chart_data?.daily ?? [];
  const prevOrders = prev ? prev.totals.orders_count ?? prev.orders.length : null;
  // The gross rests on sale-time estimates for these orders (owner decision 3: always named): of the complete orders when
  // the gross is theirs; of the whole period — every order with an estimated line, as no goods cost is unknown — when it is the period's.
  const grossEstimated = fullGross ? (data.missing_costs && !data.missing_costs.unknown_lines ? data.missing_costs.orders : 0) : known?.estimated?.orders_count ?? 0;
  // The net-sales sparkline is net sales day by day (the orders' own, by Baghdad delivery day), not the revenue the curve shows.
  const salesByDay = new Map<string, number>();
  for (const o of data.orders) { const day = financeDay(o.delivered_at || o.created_at); salesByDay.set(day, (salesByDay.get(day) ?? 0) + (o.retained_revenue_iqd ?? 0)); }

  const grossPartial = !fullGross || prev?.totals.gross_profit_iqd == null;
  // A net still missing here is a partial comparison too, never «nothing to compare».
  const netPartial = figures.net == null || figures.fromKnown || !!prevFigures?.fromKnown || prevFigures?.net == null;
  const cards: Array<{ key: FwKey; value: ReactNode; notes: string[]; delta: ReactNode; spark?: number[]; split?: boolean; primary?: boolean; open?: () => void; partial?: boolean }> = [
    { key: 'netSales', value: <DisplayMoney iqd={sales} cents={u ? centsAt(u.totals, 'retained_revenue_iqd') : undefined} />, notes: [fw(loc, 'netSalesNote', { n: orders })],
      delta: delta(sales, prev?.totals.retained_revenue_iqd), spark: daily.map((d) => salesByDay.get(d.day) ?? 0), open: onFigure && (() => onFigure('sales')) },
    { key: 'grossProfit', value: <DisplayMoney iqd={gross} cents={grossCents} />,
      notes: [...(fullGross ? [grossPct ? fw(loc, 'grossNoteAll', { pct: grossPct }) : ''] : [grossPct ? fw(loc, 'grossMargin', { pct: grossPct }) : '', gross != null ? knownNote : '']),
        gross != null && grossEstimated > 0 ? fw(loc, 'estimatedOrders', { n: grossEstimated }) : ''],
      delta: delta(gross, prev?.totals.gross_profit_iqd, grossPartial, 'grossProfit'), partial: grossPartial, open: onFigure && (() => onFigure('gross')) },
    { key: 'netShare', value: <DisplayMoney iqd={figures.net} cents={figures.cents} />, primary: true, split: !!estimated && figures.net != null,
      notes: [sharePct ? fw(loc, 'shareMargin', { pct: sharePct }) : '',
        figures.fromKnown ? `${knownNote}${(known?.overhead_share_iqd ?? 0) > 0 ? fw(loc, 'overheadNote') : ''}` : figures.net != null ? fw(loc, 'netNote') : '',
        estimated && figures.confirmed ? `${part('confirmedPart', figures.confirmed)} · ${part('estimatedPart', estimated)}` : '', deducted],
      delta: delta(figures.net, prevFigures?.net, netPartial, 'netShare'), partial: netPartial, open: onFigure && (() => onFigure('net')) },
    { key: 'deliveredOrders', value: <strong>{orders}</strong>,
      notes: [fw(loc, 'units', { n: t.units ?? 0 }), average ? fw(loc, 'averageOrder', { amount: noteAmount(average.iqd, average.cents) }).trim() : ''],
      delta: delta(orders, prevOrders), spark: daily.map((d) => d.orders_count), open: onFigure && (() => onNavigate('orders')) },
  ];
  const confirmedShare = figures.confirmed?.net != null && figures.net ? Math.max(0, Math.min(100, Math.round(figures.confirmed.net / figures.net * 100))) : 0;

  return <div className="fw-body" data-finance-overview>
    {currency === 'USD' && <UsdBasisNote available={!!data.display_usd?.available} atTimeCount={data.display_usd?.at_time_count} todayCount={data.display_usd?.today_count} todayRate={data.display_usd?.today_rate} batchLines={data.display_usd?.batch_cost_lines} />}
    {data.truncated && <p className="fw-error" role="alert">{fw(loc, 'truncated')}</p>}
    <Completeness data={data} onMissing={onMissing} />
    {/* A card opens on its label's button (the keyboard's way) or a click anywhere on it, its figures still selectable (cardClick). */}
    <div className="fw-kpis">{cards.map((c) => <div key={c.key} className={`fw-metric${c.primary ? ' fw-metric--primary' : ''}${c.open ? ' fw-metric--open' : ''}`} data-finance-kpi={c.key} onClick={c.open && cardClick(c.open)}>
      <span>{c.open ? <button type="button" className="fw-open" onClick={c.open} data-finance-open={c.key} aria-describedby={prev && c.partial ? whyOf(c.key) : undefined}>{fw(loc, c.key)}</button> : fw(loc, c.key)}</span>{c.value}{c.delta}
      {c.spark?.some((v) => v > 0) && <Spark values={c.spark} />}
      {c.split && <div className="fw-stack" aria-hidden><i className="fw-ok" style={{ width: `${confirmedShare}%` }} /><i className="fw-est" style={{ flex: 1 }} /></div>}
      {c.notes.filter(Boolean).map((n) => <small key={n}>{n}</small>)}
    </div>)}</div>
    <div className="fw-grid fw-grid--wide">
      <Surface title={fw(loc, 'chartTitle')} subtitle={fw(loc, 'chartNote')}><Curve data={data} prev={prev} usd={u} compareLabel={compareFrom && compareTo ? rangeText(L, compareFrom, compareTo) : ''} /></Surface>
      <Attention data={data} usd={u} people={people} openOrder={openOrder} onNavigate={onNavigate} onMissing={onMissing} onCollections={onCollections} />
    </div>
    <Statement data={data} usd={u} onOpen={onFigure} />
    <div className="fw-grid">
      <TopProducts data={data} usd={u} onNavigate={onNavigate} />
      <div className="fw-body"><Cash data={data} usd={u} onCollections={onCollections} onFigure={onFigure} /><Payouts people={people} onNavigate={onNavigate} /></div>
    </div>
  </div>;
}

/** How much of the period is calculated, and on what: confirmed, estimated, waiting — counted, never implied. */
function Completeness({ data, onMissing }: { data: FinanceSummary; onMissing: () => void }) {
  const { loc } = useLanguage();
  const total = data.totals.orders_count ?? data.orders.length;
  if (!total) return null;
  const known = data.known ?? null, missing = data.missing_costs;
  // A server that predates `waiting` still says how many orders are not complete.
  const waits = data.waiting ? data.waiting.orders_count : known ? known.incomplete_orders : data.totals.owner_period_net_iqd === null ? total : 0;
  const estimated = known?.estimated?.orders_count ?? 0, confirmed = known ? known.confirmed?.orders_count ?? known.orders_count - estimated : 0;
  if (!waits && !estimated) return <div className="fw-banner fw-banner--ok" role="status" data-finance-completeness="confirmed"><CheckCircle2 size={18} aria-hidden /><strong>{fw(loc, 'completeAll')}</strong></div>;
  const reasonKey: Record<FinanceWaitReason, FwKey> = { no_price: 'reasonNoPrice', return_cost: 'reasonReturnCost', wage_waits_cost: 'reasonWage', investor_waits: 'reasonInvestor', refund_unknown: 'reasonRefund', other: 'reasonOther' };
  // In the order the owner fixes them: a price first, then what waits on a price, then the cash.
  const list = (Object.keys(reasonKey) as FinanceWaitReason[]).map((r) => [r, data.waiting?.reasons?.[r] ?? []] as const).filter(([, ids]) => ids.length)
    .map(([r, ids]) => fw(loc, reasonKey[r], { n: ids.length })).join(loc('، ', ', ', '، '));
  const w = (n: number) => `${(n / total * 100).toFixed(2)}%`;
  return <div className="fw-banner" role="status" data-finance-completeness={waits ? 'waiting' : 'estimated'}>
    <div className="fw-banner-body">
      <strong>{waits ? fw(loc, 'completeTitle', { n: total - waits, m: total }) : fw(loc, 'estimatedTitle', { n: estimated })}</strong>
      <p>{[waits && list ? fw(loc, 'waitsFor', { list }) : '', estimated ? fw(loc, 'estimatedNote', { n: estimated }) : ''].filter(Boolean).join(' ')}</p>
      <div className="fw-stack" aria-hidden><i className="fw-ok" style={{ width: w(confirmed) }} /><i className="fw-est" style={{ width: w(estimated) }} /><i className="fw-wait" style={{ width: w(waits) }} /></div>
      <div className="fw-keys"><span><i className="fw-dot fw-ok" />{fw(loc, 'confirmedN', { n: confirmed })}</span><span><i className="fw-dot fw-est" />{fw(loc, 'estimatedN', { n: estimated })}</span>
        <span><i className="fw-dot fw-wait" />{fw(loc, 'waitingN', { n: waits })}</span></div>
    </div>
    {!!missing?.lines && <Button variant="primary" onClick={onMissing}>{fw(loc, 'completeCosts', { n: missing.lines })}</Button>}
  </div>;
}

function Spark({ values }: { values: number[] }) {
  const w = 120, h = 30, max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`).join(' ');
  return <svg className="fw-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
    <polyline points={`0,${h - 2} ${pts} ${w},${h - 2}`} style={{ fill: 'color-mix(in oklab,var(--color-info) 16%,transparent)' }} />
    <polyline points={pts} style={{ fill: 'none', stroke: 'var(--color-info)', strokeWidth: 1.6 }} /></svg>;
}

/** A round step for four or so gridlines over `top`; never under one whole dinar or dollar (no «0.25» on an axis of money). */
export const niceStep = (top: number) => { const raw = Math.max(top, 4) / 4, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
/** A period's revenue day by day, in the display currency: the server's cents in dollars (none: null — never dinars). */
function dailyRevenue(s: FinanceSummary, usd: DisplayUsdSummary | undefined): number[] | null {
  const days = s.chart_data?.daily ?? [];
  if (!usd) return days.map((d) => d.revenue_iqd ?? 0);
  return usd.chart ? days.map((d) => (usd.chart!.daily[d.day]?.revenue_cents ?? 0) / 100) : null;
}
/** Revenue accumulated day by day, this period against the comparison; one scale for both, labels in Latin digits. */
export function Curve({ data, prev, usd, compareLabel }: { data: FinanceSummary; prev: FinanceSummary | null; usd?: DisplayUsdSummary; compareLabel: string }) {
  const { loc } = useLanguage();
  const narrow = useNarrow();
  const cum = (rows: number[] | null) => (rows ?? []).reduce<number[]>((acc, v) => [...acc, (acc[acc.length - 1] ?? 0) + v], []);
  const prevUsd = usd ? (prev?.display_usd?.available ? prev.display_usd : undefined) : undefined;
  const now = cum(dailyRevenue(data, usd)), before = prev && (!usd || prevUsd) ? cum(dailyRevenue(prev, prevUsd)) : [];
  const n = Math.max(now.length, before.length);
  if (!n) return null;
  // Nothing sold in either period: a flat line on an empty scale says less than these words.
  if (![...now, ...before].some((v) => v > 0)) return <p className="fw-note" data-finance-curve="empty">{fw(loc, 'noRevenue')}</p>;
  const money = (v: number) => (usd ? usdText(Math.round(v * 100)) : formatMoney(v));
  const W = narrow ? 340 : 640, H = narrow ? 180 : 210, padL = 40, padR = 12, padT = 12, padB = 24;
  const top = Math.max(...now, ...before, 1), step = niceStep(top), max = Math.ceil(top / step) * step;
  const x = (i: number) => padL + (n === 1 ? 0 : i * (W - padL - padR) / (n - 1));
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const path = (a: number[]) => a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const short = (v: number) => `${usd ? '$' : ''}${v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(0)}k` : v}`;
  const every = Math.max(1, Math.ceil(n / 6)), end = now[now.length - 1] ?? 0;
  const ink = { fill: 'var(--fw-muted)', fontSize: 10 };
  return <figure className="fw-curve" data-finance-curve>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${fw(loc, 'chartTitle')}: ${money(end)}${before.length ? ` · ${compareLabel}: ${money(before[before.length - 1])}` : ''}`} direction="ltr">
      {ticks.map((v) => <g key={v}><line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} style={{ stroke: 'var(--fw-line)' }} strokeDasharray={v ? '3 4' : undefined} /><text x={padL - 6} y={y(v) + 3.5} textAnchor="end" style={ink}>{short(v)}</text></g>)}
      {Array.from({ length: n }, (_, i) => i).filter((i) => i % every === 0 || i === n - 1).map((i) => <text key={i} x={x(i)} y={H - 7} textAnchor="middle" style={ink}>{i + 1}</text>)}
      {before.length > 0 && <path d={path(before)} style={{ fill: 'none', stroke: 'var(--fw-muted)', strokeWidth: 1.6 }} strokeDasharray="5 4" />}
      {now.length > 0 && <path d={`${path(now)} L${x(now.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} style={{ fill: 'color-mix(in oklab,var(--color-info) 14%,transparent)' }} />}
      {now.length > 0 && <path d={path(now)} style={{ fill: 'none', stroke: 'var(--color-info)', strokeWidth: 2.4 }} />}
      {now.length > 0 && <circle cx={x(now.length - 1)} cy={y(end)} r="4" style={{ fill: 'var(--color-info)' }} />}
    </svg>
    <figcaption className="fw-keys"><span><i className="fw-dot fw-info" />{fw(loc, 'thisPeriod')} · <bdi dir="ltr">{money(end)}</bdi></span>
      {before.length > 0 && <span><i className="fw-dot fw-wait" />{compareLabel} · <bdi dir="ltr">{money(before[before.length - 1])}</bdi></span>}</figcaption>
  </figure>;
}

/** What waits for the owner in this period, each with the button that does it. */
export function Attention({ data, usd, people, openOrder, onNavigate, onMissing, onCollections }: { data: FinanceSummary; usd?: DisplayUsdSummary; people: People; openOrder: OpenOrder;
  onNavigate: (section: FinanceSection) => void; onMissing: () => void; onCollections: () => void }) {
  const { loc } = useLanguage();
  const t = data.totals, missing = data.missing_costs, waiting = data.waiting?.reasons?.investor_waits ?? [];
  const open = t.collection_difference_iqd ?? 0, openCents = usd ? centsAt(usd.totals, 'collection_difference_iqd') : undefined;
  const payable = (people.list ?? []).filter((p) => available(p) > 0).sort((a, b) => available(b) - available(a));
  const items: Array<{ key: string; tone: string; title: string; note: ReactNode; action: string; onClick: () => void; primary?: boolean }> = [];
  if (missing?.lines) items.push({ key: 'costs', tone: 'fw-est', title: fw(loc, 'completeCosts', { n: missing.lines }), note: fw(loc, 'aCostsNote', { orders: missing.orders }), action: fw(loc, 'complete'), onClick: onMissing, primary: true });
  if (open > 0) items.push({ key: 'cash', tone: 'fw-info', title: fw(loc, 'aCash'), action: fw(loc, 'record'), onClick: onCollections,
    note: fw(loc, 'aCashNote', { amount: usd ? (openCents == null ? '' : usdText(openCents)) : formatMoney(open), n: data.orders.filter((o) => (o.collection_difference_iqd ?? 0) > 0).length }).trim() });
  if (waiting.length) {
    // Its costs confirmed, a held share waits for the cash; otherwise for the cost first (PersonFinanceView's two steps).
    const first = data.orders.find((o) => (o.order_id || o.id) === waiting[0]);
    items.push({ key: 'investor', tone: 'fw-info', title: fw(loc, 'aInvestor'), note: fw(loc, 'aInvestorNote', { n: waiting.length }), action: fw(loc, 'open'),
      onClick: () => openOrder(waiting[0], first?.cost_confidence === 'verified' ? 'collection' : 'cost') });
  }
  if (payable.length) items.push({ key: 'payouts', tone: 'fw-ok', title: fw(loc, 'aPayouts'), action: fw(loc, 'review'), onClick: () => onNavigate(pageOf(payable[0])),
    // Each name keeps its own direction: an Arabic name in an English line stays beside its amount.
    note: <>{fw(loc, 'aPayoutsNote', { amount: formatMoney(payable.reduce((v, p) => v + available(p), 0)), names: '' }).trim()}{' '}
      {payable.slice(0, 3).map((p, i) => <span key={p.user_id ?? p.staff_id ?? p.name}>{i ? loc('، ', ', ', '، ') : ''}<bdi>{p.name} {formatMoney(available(p))}</bdi></span>)}</> });
  if ((t.orders_count ?? 0) > 0 && (t.general_expenses_iqd ?? 0) === 0) items.push({ key: 'expenses', tone: 'fw-wait', title: fw(loc, 'aExpenses'), note: fw(loc, 'aExpensesNote'), action: fw(loc, 'add'), onClick: () => onNavigate('expenses') });
  return <Surface title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{fw(loc, 'attention')}{items.length > 0 && <Status tone="warning">{items.length}</Status>}</span>}>
    {items.length ? <ul className="fw-att" data-finance-attention>{items.map((it) => <li key={it.key} data-finance-attention-item={it.key}>
      <i className={`fw-dot ${it.tone}`} aria-hidden /><div><strong>{it.title}</strong><small>{it.note}</small></div>
      <Button variant={it.primary ? 'primary' : 'secondary'} onClick={it.onClick}>{it.action}</Button>
    </li>)}</ul> : <p className="fw-note">{fw(loc, 'attentionNone')}</p>}
  </Surface>;
}

const ROW: Record<StatementKey, FwKey> = { sales: 'netSales', cogs: 'cogs', gross: 'grossProfit', delivery: 'delivery', cod: 'cod', wages: 'wages', materials: 'materials', fees: 'fees',
  promotion: 'promo', investor: 'investor', general: 'expenses', deductions: 'deductions', net: 'netShare' };
/** «من المبيعات إلى حصتك»: three columns on a wide screen, one at a time on a phone; in dollars the server's cents. */
export function Statement({ data, usd, onOpen }: { data: FinanceSummary; usd?: DisplayUsdSummary; onOpen?: (key: StatementKey) => void }) {
  const { loc } = useLanguage();
  const { rows, currency } = useMemo(() => statementRows(data, usd), [data, usd]);
  const t = data.totals, total = t.orders_count ?? data.orders.length, calc = data.known?.orders_count ?? 0, wait = data.waiting?.orders_count ?? 0;
  // The columns with orders in them: «محسوبة» and «تنتظر» only while the period is split between them, else the period alone
  // (an empty column would say «ناقص» on every line though nothing is missing from it).
  const visible = statementColumns(calc, wait);
  const [pick, setCol] = useState<0 | 1 | 2>(visible[0]);
  // On a phone one column at a time: the calculated orders first while some wait, else the period.
  const col = visible.includes(pick) ? pick : visible[0];
  // How many orders each column's known figures rest on a sale-time estimate for (owner decision 3), named in its head: the calculated
  // ones; since the fourth review of step 4 also the waiting ones and the period's, once their goods cost is known (drill.ts columnEstimates).
  const [eCalc, eWait, ePeriod] = useMemo(() => columnEstimates(data, usd), [data, usd]);
  const heads = [fw(loc, eCalc ? 'colCalculatedEst' : 'colCalculated', { n: calc, e: eCalc }), fw(loc, eWait ? 'colWaitingEst' : 'colWaiting', { n: wait, e: eWait }),
    fw(loc, ePeriod ? 'colPeriodEst' : 'colPeriod', { n: total, e: ePeriod })];
  const cell = (v: number | null, i: 0 | 1 | 2, key: StatementKey) => v !== null ? (currency === 'USD' ? <span className="fw-money" dir="ltr">{usdText(v)}</span> : <Money value={v} />)
    : <MissingValue text={fw(loc, i === 1 || key === 'wages' || key === 'materials' || key === 'investor' ? 'waitingCell' : 'missingCell')} />;
  // A negative investor share is the investors' part of a loss, added back: the row says so.
  const investorLoss = rows.find((r) => r.key === 'investor')?.cells.some((v) => v !== null && v < 0) ?? false;
  const hint = (key: StatementKey) => key === 'fees' && (t.collected_iqd ?? 0) === 0 && (t.collection_difference_iqd ?? 0) > 0 ? fw(loc, 'feesNote')
    : key === 'wages' && (t.pending_costs ?? 0) > 0 ? fw(loc, 'wagesWaiting', { n: t.pending_costs ?? 0 })
      : key === 'investor' && investorLoss ? fw(loc, 'investorLoss')
        // In dollars the server has no cents for it: the note names it without a dinar amount among dollar cells.
        : key === 'general' && (t.general_waiting_iqd ?? 0) > 0 ? currency === 'USD' ? fw(loc, 'generalWaitingShort') : fw(loc, 'generalWaiting', { amount: formatMoney(t.general_waiting_iqd) }) : '';
  return <Surface title={fw(loc, 'statement')} subtitle={fw(loc, 'statementNote')}>
    {visible.length > 1 && <div className="fw-seg" role="group" aria-label={fw(loc, 'statement')}>
      {visible.map((i) => <button key={i} type="button" aria-pressed={col === i} onClick={() => setCol(i)}>{heads[i]}</button>)}</div>}
    <div className="fw-table-wrap"><table className="fw-table fw-pl" data-finance-statement={currency} data-phone-col={col}>
      <thead><tr><th scope="col"><span className="fw-sr">{fw(loc, 'statement')}</span></th>{visible.map((i) => <th key={i} scope="col" data-col={i}>{heads[i]}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.key} className={r.sign === '=' ? 'fw-pl-sum' : undefined} data-key={r.key}>
        <th scope="row"><span className="fw-pl-op" aria-hidden>{r.sign}</span>{onOpen ? <button type="button" className="fw-open" onClick={() => onOpen(r.key)} title={rs(loc, 'drawerOpen', { name: fw(loc, ROW[r.key]) })} data-finance-open={r.key}>{fw(loc, ROW[r.key])}</button> : fw(loc, ROW[r.key])}{hint(r.key) && <small>{hint(r.key)}</small>}</th>
        {visible.map((i) => <td key={i} data-col={i}>{cell(r.cells[i], i, r.key)}</td>)}
      </tr>)}</tbody>
    </table></div>
  </Surface>;
}

function TopProducts({ data, usd, onNavigate }: { data: FinanceSummary; usd?: DisplayUsdSummary; onNavigate: (section: FinanceSection) => void }) {
  const { loc } = useLanguage();
  const rows = [...data.products].sort((a, b) => (b.gross_profit_iqd ?? -Infinity) - (a.gross_profit_iqd ?? -Infinity)).slice(0, 6);
  const cents = (id: string, field: string) => (usd ? centsAt(usd.products?.[id] ?? {}, field) : undefined);
  // A gross that rests on a sale-time estimate says so on its row (owner decision 3); the server counts each product's estimated lines.
  const estimated = (p: (typeof rows)[number]) => p.gross_profit_iqd != null && (p.estimated_lines ?? 0) > 0;
  return <Surface title={fw(loc, 'topProducts')} action={<Button variant="ghost" onClick={() => onNavigate('products')}>{fw(loc, 'fullReport')}<ArrowUpLeft size={15} aria-hidden /></Button>}>
    {rows.length ? <div className="fw-table-wrap"><table className="fw-table" data-finance-top-products>
      <thead><tr><th scope="col">{fw(loc, 'product')}</th><th scope="col" className="fw-wide">{fw(loc, 'pieces')}</th><th scope="col" className="fw-wide">{fw(loc, 'netSales')}</th><th scope="col">{fw(loc, 'grossProfit')}</th><th scope="col">{fw(loc, 'marginCol')}</th></tr></thead>
      <tbody>{rows.map((p) => { const salesOf = p.retained_revenue_iqd ?? p.net_goods_iqd ?? null; return <tr key={p.id} data-finance-estimated={estimated(p) || undefined}>
        <th scope="row">{p.name}{estimated(p) && <> <Status tone="warning">{fw(loc, 'estimatedChip')}</Status></>}</th><td className="fw-wide">{piecesOf(p)}</td>
        <td className="fw-wide"><DisplayMoney iqd={salesOf} cents={cents(p.id, 'retained_revenue_iqd')} compact /></td>
        <td><DisplayMoney iqd={p.gross_profit_iqd} cents={cents(p.id, 'gross_profit_iqd')} compact /></td>
        <td>{p.gross_profit_iqd == null ? <MissingValue /> : salesOf ? <bdi dir="ltr">{(p.gross_profit_iqd / salesOf * 100).toFixed(1)}%</bdi> : fw(loc, 'noSales')}</td></tr>; })}</tbody>
    </table></div> : <p className="fw-note">{fw(loc, 'noProducts')}</p>}
    {rows.some(estimated) && <p className="fw-note">{fw(loc, 'estimatedChipNote')}</p>}
  </Surface>;
}

/** Profit is not cash: what is due on delivery or from Gini, and how much of it is recorded as received. */
function Cash({ data, usd, onCollections, onFigure }: { data: FinanceSummary; usd?: DisplayUsdSummary; onCollections: () => void; onFigure?: (key: FigureKey) => void }) {
  const { loc } = useLanguage();
  const t = data.totals, open = t.collection_difference_iqd ?? 0, recorded = t.collected_iqd ?? 0, due = open + recorded;
  if (due <= 0) return null;
  const c = (f: string) => (usd ? centsAt(usd.totals, f) : undefined);
  const openC = c('collection_difference_iqd'), recordedC = c('collected_iqd');
  const dueC = openC === undefined ? undefined : openC == null || recordedC == null ? null : openC + recordedC;
  return <Surface title={fw(loc, 'cash')} subtitle={fw(loc, 'cashNote')}>
    <div className="fw-stack" aria-hidden><i className="fw-ok" style={{ width: `${(recorded / due * 100).toFixed(2)}%` }} /><i className="fw-info" style={{ flex: 1 }} /></div>
    <dl className="fw-kv" data-finance-cash>
      <dt>{onFigure ? <button type="button" className="fw-open" onClick={() => onFigure('cashDue')} data-finance-open="cashDue">{fw(loc, 'cashDue')}</button> : fw(loc, 'cashDue')}</dt><dd><DisplayMoney iqd={due} cents={dueC} /></dd>
      <dt><i className="fw-dot fw-ok" />{fw(loc, 'cashRecorded')}</dt><dd><DisplayMoney iqd={recorded} cents={recordedC} /></dd>
      <dt><i className="fw-dot fw-info" />{onFigure ? <button type="button" className="fw-open" onClick={() => onFigure('cashOpen')} data-finance-open="cashOpen">{fw(loc, 'cashOpen')}</button> : fw(loc, 'cashOpen')}<small>{fw(loc, 'cashOpenNote')}</small></dt><dd><DisplayMoney iqd={open} cents={openC} /></dd>
    </dl>
    {open > 0 && <Button variant="primary" onClick={onCollections}>{fw(loc, 'aCash')}</Button>}
  </Surface>;
}

/** Who can be paid now and what is held — today's balances from «الأشخاص», in dinars as those screens keep them. */
export function Payouts({ people, onNavigate }: { people: People; onNavigate: (section: FinanceSection) => void }) {
  const { loc } = useLanguage();
  const list = people.list ?? [];
  const payable = list.filter((p) => available(p) > 0).sort((a, b) => available(b) - available(a));
  const now = list.reduce((v, p) => v + available(p), 0), held = list.reduce((v, p) => v + (p.combined?.held_iqd ?? 0), 0);
  return <Surface title={fw(loc, 'payouts')} subtitle={fw(loc, 'payoutsNote')} action={<Button variant="ghost" onClick={() => onNavigate(payable[0] ? pageOf(payable[0]) : 'staff')}>{fw(loc, 'details')}<ArrowUpLeft size={15} aria-hidden /></Button>}>
    {people.list === null ? <p className="fw-note" role="status">{fw(loc, 'payoutsLoading')}</p> : people.error ? <p className="fw-note" role="alert">{fw(loc, 'payoutsError')}</p> : <>
      <dl className="fw-kv" data-finance-payouts><dt>{fw(loc, 'payNow')}</dt><dd><Money value={now} /></dd><dt>{fw(loc, 'held')}</dt><dd><Money value={held} /></dd></dl>
      {payable.length ? <ul className="fw-att">{payable.slice(0, 3).map((p) => <li key={p.user_id ?? p.staff_id ?? p.name}><i className="fw-dot fw-ok" aria-hidden /><div><strong>{p.name}</strong></div>
        <button type="button" className="fw-link" onClick={() => onNavigate(pageOf(p))}><Money value={available(p)} /></button></li>)}</ul>
        : <p className="fw-note">{fw(loc, 'payoutsNone')}</p>}
    </>}
  </Surface>;
}

