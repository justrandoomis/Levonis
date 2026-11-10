import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { personFinanceStrings, percentText, type HoldReasonKey, type PersonFinanceStrings } from '../../lib/personFinanceStrings';
import { Button, Dialog, Money, dateLabel, useLanguage, type OpenOrder } from './shared';

/**
 * «الأشخاص» — one person, one picture (worker/lib/personFinance.ts; DECISIONS
 * row 304). The same card on the owner's Investors and Staff tabs and on the
 * person's own «أرباحي»: what was earned from investing and working, what can
 * be withdrawn now, where the capital is, the share of each agreement, the
 * return so far, and why anything is held. Display only: every figure is the
 * server's. The person's own page (`own`) receives no order ids and no amount
 * per sale or per reason, and shows none of the owner's instructions.
 */
export type HoldReason = HoldReasonKey;
export type HeldSale = { order_id: string; day: string | null; reasons: HoldReason[]; profit_iqd: number; capital_iqd: number; profit_unknown: boolean };
export type HeldRest = { reason: HoldReason; profit_iqd?: number; capital_iqd?: number };
export type AgreementFinance = {
  id: string; name: string; product_name: string | null; product_name_ar: string | null; label: string | null; created_at: string;
  principal_iqd: number; funded_iqd: number; profit_share_bps: number; loss_share_bps: number;
  units: { ordered: number; received: number; in_stock: number; in_orders: number; sold: number };
  capital: { back_from_sales_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; held_iqd: number; loss_iqd: number; not_recovered_iqd: number };
  profit: { earned_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; held_iqd: number; sales: number; sales_unknown: number };
  held_whole: boolean; held_sales: HeldSale[]; held_sales_more: number; held_rest: HeldRest | null;
};
export type PersonWork = { staff_id: string; name: string; role: string; status: 'active' | 'paused' | 'archived'; start_work_date: string | null; paused_from: string | null; resumes_at: string | null; working_since: string | null; pauses: { from: string; to: string | null }[]; settlement?: { through_day: string; owed_iqd: number; settlement_day: string } | null };
type Investor = {
  state: string; default_profit_share_bps: number | null;
  capital: { agreed_iqd: number; put_in_iqd: number; in_agreements_iqd: number; in_goods_iqd: number; sold_held_iqd: number; at_work_iqd: number; returned_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; debt_iqd: number; not_recovered_iqd: number; unused_returned_iqd: number; awaiting_rest_of_funding_iqd: number; loss_iqd: number };
  profit: { earned_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; held_iqd: number; debt_iqd: number };
  share: { agreements_bps: number[]; min_bps: number | null; max_bps: number | null; earned_bps: number | null };
  roi_bps: number | null;
  units: { ordered: number; received: number; in_stock: number; in_orders: number; sold: number };
  agreements: AgreementFinance[];
  holds: { reason: HoldReason; sales: number; profit_iqd?: number; capital_iqd?: number; profit_unknown: number }[];
};
type Work = { roles: PersonWork[]; earned_iqd: number; paid_iqd: number; available_iqd: number; reserved_iqd: number; held_iqd: number; debt_iqd: number; balance_iqd: number; pending_costs: number; holds: { reason: HoldReason; entries: number; amount_iqd?: number }[] };
export type PersonFinance = {
  user_id: string | null; staff_id?: string; name: string;
  investor: null | Investor;
  work: null | Work;
  combined: { earned_iqd: number; paid_iqd: number; reserved_iqd: number; held_iqd: number; available_earnings_iqd: number; available_capital_iqd: number; available_iqd: number };
  period?: { wages_iqd: number; profit_iqd: number };
};

const strings = (lang: string) => personFinanceStrings(lang as 'ar' | 'en' | 'ckb');
/** A percentage inside right-to-left text keeps its sign after the number. */
const Pct = ({ bps, decimals = 0 }: { bps: number | null | undefined; decimals?: number }) => <bdi dir="ltr">{percentText(bps, decimals)}</bdi>;

function Stat({ label, value, hint, tone }: { label: string; value: number | null; hint?: ReactNode; tone?: 'good' | 'wait' }) {
  return <div className={`fp-stat${tone ? ` fp-stat-${tone}` : ''}`}><span>{label}</span><Money value={value} />{hint && <p className="fp-row-meta">{hint}</p>}</div>;
}

export function WorkStatus({ role, s }: { role: PersonWork; s: PersonFinanceStrings }) {
  const { lang } = useLanguage();
  const tone = role.status === 'active' ? 'fp-status-available' : role.status === 'paused' ? 'fp-status-pending' : '';
  return <><p className="fp-person-status"><span className={`fp-status ${tone}`}>{role.status === 'active' ? s.active : role.status === 'paused' ? s.paused : s.archived}</span>
    <span>{role.role || role.name}</span>
    {role.status === 'paused' && role.paused_from && <span className="fp-row-meta">{s.since} {dateLabel(role.paused_from, lang)}</span>}
    {role.status === 'paused' && role.resumes_at && <span className="fp-row-meta">· {s.resumesOn} {dateLabel(role.resumes_at, lang)}</span>}
    {role.status === 'active' && role.working_since && <span className="fp-row-meta">{s.since} {dateLabel(role.working_since, lang)}</span>}
  </p>
    {role.settlement && <p className="fp-row-meta">{s.settledThrough} {dateLabel(dayBefore(role.settlement.through_day), lang)} · {s.agreedOwed} <Money value={role.settlement.owed_iqd} /></p>}</>;
}
/** A settlement covers orders delivered BEFORE its day: the last settled day is the one before. */
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/** Where the capital put in is now. The parts always add up to it. */
export function CapitalBar({ capital, holds = [], s }: { capital: Investor['capital']; holds?: Investor['holds']; s: PersonFinanceStrings }) {
  // Why the sold money waits, in the words of the holds below (the person's own page has no amounts).
  const soldWhy = holds.filter((h) => h.sales > 0 && (h.capital_iqd === undefined || h.capital_iqd > 0)).map((h) => s.hold[h.reason](h.sales)).join(' · ');
  const parts = [
    { key: 'stock', label: s.inGoods, value: capital.in_goods_iqd },
    { key: 'sold', label: s.soldHeld, value: capital.sold_held_iqd },
    { key: 'returned', label: s.returned, value: Math.max(0, capital.returned_iqd - capital.debt_iqd) },
    { key: 'unrecovered', label: s.notRecovered, value: capital.not_recovered_iqd },
    { key: 'loss', label: s.capitalLoss, value: capital.loss_iqd },
  ].filter((p) => p.value > 0);
  const total = Math.max(capital.put_in_iqd, parts.reduce((n, p) => n + p.value, 0));
  return <div className="fp-stack fp-capital">
    {total > 0 && <div className="fp-capbar" aria-hidden="true">{parts.map((p) => <span key={p.key} className={`fp-capbar-${p.key}`} style={{ width: `${Math.max(1.5, (p.value / total) * 100)}%` }} />)}</div>}
    <ul className="fp-legend">{parts.map((p) => <li key={p.key}><i className={`fp-dot fp-capbar-${p.key}`} aria-hidden="true" /><span>{p.label}</span><Money value={p.value} />
      {p.key === 'sold' && soldWhy && <small className="fp-row-meta">{soldWhy}</small>}
      {p.key === 'returned' && capital.available_iqd > 0 && <small className="fp-row-meta">{s.availableOf}: <Money value={capital.available_iqd} /></small>}
      {p.key === 'returned' && capital.unused_returned_iqd > 0 && <small className="fp-row-meta">{s.unusedReturned}: <Money value={capital.unused_returned_iqd} /></small>}</li>)}
      {capital.debt_iqd > 0 && <li className="fp-negative"><span>{s.capitalDebt}</span><Money value={capital.debt_iqd} /></li>}</ul>
  </div>;
}

type HoldItem = { key: string; text: string; profit?: number; capital?: number; amount?: number; action?: string };
function Holds({ items, s }: { items: HoldItem[]; s: PersonFinanceStrings }) {
  if (!items.length) return null;
  return <div className="fp-holds" role="note"><strong>{s.holdsTitle}</strong><ul>{items.map((i) => <li key={i.key}><span>{i.text}</span>
    {!!i.amount && <Money value={i.amount} />}
    {(!!i.profit || !!i.capital) && <span className="fp-hold-amounts">{!!i.profit && <>{s.profitEarned} <Money value={i.profit} /></>}{!!i.profit && !!i.capital && ' · '}{!!i.capital && <>{s.capital} <Money value={i.capital} /></>}</span>}
    {i.action && <small className="fp-row-meta">{i.action}</small>}</li>)}</ul></div>;
}

/** One held sale: its order, why it waits, and — when the owner can open orders — one button per
 * missing step: the purchase price first (the profit is worked out from it), then the cash. */
function HeldSaleRow({ h, s, openOrder }: { h: HeldSale; s: PersonFinanceStrings; openOrder?: OpenOrder }) {
  const { lang } = useLanguage();
  return <div className="fp-row fp-held-sale">
    <div className="min-w-0">{openOrder ? <button type="button" className="fp-link" onClick={() => openOrder(h.order_id)} dir="ltr">{h.order_id}</button> : <bdi dir="ltr">{h.order_id}</bdi>}
      {h.day && <span className="fp-row-meta"> · {dateLabel(h.day, lang)}</span>}
      <p className="fp-row-meta">{h.reasons.map((r) => s.hold[r](1)).join(' · ')}</p>
      {openOrder && (h.reasons.includes('cost') || h.reasons.includes('collection')) && <div className="fp-row-actions">
        {h.reasons.includes('cost') && <Button size="sm" variant="primary" onClick={() => openOrder(h.order_id, 'cost')}>{s.enterCost}</Button>}
        {h.reasons.includes('collection') && <Button size="sm" variant={h.reasons.includes('cost') ? 'ghost' : 'primary'} onClick={() => openOrder(h.order_id, 'collection')}>{s.recordCash}</Button>}
      </div>}</div>
    <div className="text-end">{h.profit_unknown ? <span className="fp-row-meta">{s.profitUnknown(1)}</span> : <Money value={h.profit_iqd} />}<p className="fp-row-meta">{s.capital}: <Money value={h.capital_iqd} /></p></div>
  </div>;
}

/** Why investment money is held, in words. `owner` adds amounts and what to do; with `openOrder`
 * the owner also gets every held sale with the button that releases it. */
export function InvestmentHolds({ investor, owner, s, openOrder }: { investor: Investor; owner: boolean; s: PersonFinanceStrings; openOrder?: OpenOrder }) {
  const items: HoldItem[] = investor.holds.map((h) => ({ key: h.reason, text: h.sales > 0 ? s.hold[h.reason](h.sales) : s.holdGroup[h.reason], profit: owner ? h.profit_iqd : undefined, capital: owner ? h.capital_iqd : undefined, action: owner ? s.holdAction[h.reason] : undefined }));
  const unknown = investor.holds.reduce((n, h) => n + h.profit_unknown, 0);
  if (unknown) items.push({ key: 'unknown', text: s.profitUnknown(unknown) });
  if (investor.agreements.some((a) => a.held_whole)) items.push({ key: 'whole', text: s.wholeAgreement });
  const sales = owner && openOrder ? investor.agreements.flatMap((a) => a.held_sales).sort((x, y) => (x.day ?? '').localeCompare(y.day ?? '') || x.order_id.localeCompare(y.order_id)) : [];
  return <>
    <Holds items={items} s={s} />
    {sales.length > 0 && <section className="fp-stack" aria-label={s.heldSalesSteps}><h4>{s.heldSalesSteps}</h4><div className="fp-rows">
      {sales.map((h) => <HeldSaleRow key={h.order_id} h={h} s={s} openOrder={openOrder} />)}</div></section>}
  </>;
}

/** Why wages are held, in words. `owner` adds amounts and what to do. */
export function WorkHolds({ work, owner, s }: { work: Work; owner: boolean; s: PersonFinanceStrings }) {
  return <Holds s={s} items={work.holds.map((h) => ({ key: h.reason, text: (s.wageHold[h.reason] ?? s.wageHold.recalculation!)(Math.max(1, h.entries)), amount: owner ? h.amount_iqd : undefined, action: owner ? s.wageAction[h.reason] : undefined }))} />;
}

function ShareStat({ investor: inv, s }: { investor: Investor; s: PersonFinanceStrings }) {
  const { min_bps: min, max_bps: max } = inv.share, fallback = inv.default_profit_share_bps;
  return <div className="fp-stat"><span>{s.share}</span>
    <strong className="fp-big">{min == null || max == null ? <Pct bps={fallback} /> : min === max ? <Pct bps={min} /> : <><Pct bps={min} />–<Pct bps={max} /></>}</strong>
    <p className="fp-row-meta">{min != null && (min === max ? s.allAgreements(inv.agreements.length) : s.byAgreement)}
      {fallback != null && fallback !== max && <>{min != null && ' · '}{s.defaultShare} <Pct bps={fallback} /></>}</p></div>;
}

/** The at-a-glance card. `own` is the person's own page: no settings, no owner amounts or actions. */
export function PersonCard({ person, onOpen, actions, own = false, openOrder }: { person: PersonFinance; onOpen?: () => void; actions?: ReactNode; own?: boolean; openOrder?: OpenOrder }) {
  const { lang } = useLanguage(), s = strings(lang);
  const inv = person.investor, work = person.work, roles = work?.roles.filter((r) => r.status !== 'archived') ?? [], c = person.combined;
  const totalLabel = inv && work ? s.earnedTotal : inv ? s.profitEarned : s.wagesEarned;
  const invested = !!inv && (inv.capital.put_in_iqd > 0 || inv.agreements.length > 0);
  return <article className="fp-person" aria-label={person.name}>
    <header className="fp-rule-heading fp-staff-heading">
      <div className="flex items-center gap-3 min-w-0"><span className="fp-avatar" aria-hidden="true">{(person.name || '?').slice(0, 1)}</span>
        <div className="min-w-0"><h3>{person.name}</h3><p className="fp-chips">{inv && <span className="fp-status fp-status-approved">{s.investor}</span>}{roles.map((r) => <span key={r.staff_id} className="fp-status">{s.works} · {r.role || r.name}</span>)}</p></div></div>
      {actions}
    </header>
    <section className="fp-person-total" aria-label={totalLabel}>
      <span>{totalLabel}</span><Money value={c.earned_iqd} />
      {inv && work && <p className="fp-row-meta">{s.fromInvesting} <Money value={inv.profit.earned_iqd} /> · {s.fromWork} <Money value={work.earned_iqd} /></p>}
      {person.period && (person.period.profit_iqd > 0 || person.period.wages_iqd > 0) && <p className="fp-row-meta">{s.period}: {inv && <>{s.periodProfit} <Money value={person.period.profit_iqd} /></>}{inv && work && ' · '}{work && <>{s.periodWages} <Money value={person.period.wages_iqd} /></>}</p>}
    </section>
    <div className="fp-stats fp-person-combined">
      <Stat label={s.availableNow} value={c.available_iqd} tone={c.available_iqd > 0 ? 'good' : undefined}
        hint={c.available_capital_iqd > 0 ? <>{s.earningsPart} <Money value={c.available_earnings_iqd} /> · {s.capital} <Money value={c.available_capital_iqd} /></> : undefined} />
      <Stat label={s.paidOut} value={c.paid_iqd} />
      <Stat label={s.heldNow} value={c.held_iqd} tone={c.held_iqd > 0 ? 'wait' : undefined} />
      {c.reserved_iqd > 0 && <Stat label={s.reservedNow} value={c.reserved_iqd} />}
    </div>
    {inv && <section className="fp-person-block" aria-label={s.investmentTitle}>
      <h4>{s.investmentTitle}</h4>
      {invested ? <>
        <div className="fp-stats">
          <Stat label={s.capitalPutIn} value={inv.capital.put_in_iqd} />
          <Stat label={s.profitEarned} value={inv.profit.earned_iqd} />
          <div className="fp-stat"><span>{s.roi}</span><strong className="fp-big"><Pct bps={inv.roi_bps} decimals={1} /></strong><p className="fp-row-meta">{s.roiHint}</p></div>
          <ShareStat investor={inv} s={s} />
          {inv.profit.debt_iqd > 0 && <Stat label={s.profitDebt} value={inv.profit.debt_iqd} />}
        </div>
        <CapitalBar capital={inv.capital} holds={inv.holds} s={s} />
        {inv.units.received + inv.units.ordered > 0 && <p className="fp-row-meta">{s.unitsLine(inv.units.in_stock, inv.units.in_orders, inv.units.sold, Math.max(0, inv.units.ordered - inv.units.received))}</p>}
        <InvestmentHolds investor={inv} owner={!own} s={s} openOrder={own ? undefined : openOrder} />
      </> : <div className="fp-stats"><ShareStat investor={inv} s={s} /><p className="fp-muted">{s.noAgreements}</p></div>}
    </section>}
    {work && <section className="fp-person-block" aria-label={s.workTitle}>
      <h4>{s.workTitle}</h4>
      {work.roles.map((r) => <WorkStatus key={r.staff_id} role={r} s={s} />)}
      <div className="fp-stats">
        <Stat label={s.wagesEarned} value={work.earned_iqd} />
        <Stat label={s.wagesPaid} value={work.paid_iqd} />
        <Stat label={s.wagesAvailable} value={work.available_iqd} />
        {work.held_iqd > 0 && <Stat label={s.wagesHeld} value={work.held_iqd} />}
        {work.debt_iqd > 0 && <Stat label={s.wageDebt} value={work.debt_iqd} />}
      </div>
      <WorkHolds work={work} owner={!own} s={s} />
    </section>}
    {onOpen && <Button variant="ghost" onClick={onOpen}>{s.details}<ChevronLeft size={16} aria-hidden="true" /></Button>}
  </article>;
}

function AgreementRow({ a, s, owner, openOrder }: { a: AgreementFinance; s: PersonFinanceStrings; owner: boolean; openOrder?: OpenOrder }) {
  const { lang } = useLanguage();
  const title = (lang === 'en' ? a.product_name : a.product_name_ar || a.product_name) || a.label || a.name;
  const rest = a.held_rest;
  return <div className="fp-rule">
    <div className="fp-rule-heading"><strong>{title}</strong><span className="fp-status"><Pct bps={a.profit_share_bps} /></span></div>
    <p className="fp-row-meta">{s.unitsLine(a.units.in_stock, a.units.in_orders, a.units.sold, Math.max(0, a.units.ordered - a.units.received))}</p>
    <div className="fp-stats">
      <Stat label={s.capital} value={a.principal_iqd} />
      {a.capital.back_from_sales_iqd > 0 && <Stat label={s.backFromSales} value={a.capital.back_from_sales_iqd} hint={a.capital.held_iqd > 0 ? <>{s.heldOf} <Money value={a.capital.held_iqd} /></> : undefined} />}
      <Stat label={s.profitEarned} value={a.profit.earned_iqd} hint={a.profit.held_iqd > 0 ? <>{s.heldOf} <Money value={a.profit.held_iqd} /></> : undefined} />
    </div>
    {owner && (a.held_sales.length > 0 || rest) && <details className="fp-detail" open><summary>{s.heldSales}{a.held_sales.length > 0 && ` (${a.held_sales.length + a.held_sales_more})`}</summary><div className="fp-rows">
      {a.held_sales.map((h) => <HeldSaleRow key={h.order_id} h={h} s={s} openOrder={openOrder} />)}
      {a.held_sales_more > 0 && <p className="fp-row-meta">{s.moreSales(a.held_sales_more)}</p>}
      {rest && <div className="fp-row"><p className="fp-row-meta min-w-0">{s.holdGroup[rest.reason]}</p>
        <div className="text-end">{!!rest.profit_iqd && <Money value={rest.profit_iqd} />}{!!rest.capital_iqd && <p className="fp-row-meta">{s.capital}: <Money value={rest.capital_iqd} /></p>}</div></div>}
    </div>{a.held_whole && <p className="fp-note">{s.wholeAgreement}</p>}</details>}
  </div>;
}

/** The details sheet: the card, then every agreement and, for the owner, its held sales. */
export function PersonSheet({ person, onClose, own = false, openOrder, children }: { person: PersonFinance; onClose: () => void; own?: boolean; openOrder?: OpenOrder; children?: ReactNode }) {
  const { lang } = useLanguage(), s = strings(lang);
  return <Dialog open onClose={onClose} title={person.name}><div className="fp-stack">
    <PersonCard person={person} own={own} />
    {person.investor && person.investor.agreements.length > 0 && <section className="fp-stack" aria-label={s.agreementsTitle}><h3>{s.agreementsTitle}</h3>
      {person.investor.agreements.map((a) => <AgreementRow key={a.id} a={a} s={s} owner={!own} openOrder={openOrder} />)}</section>}
    {children}
  </div></Dialog>;
}
