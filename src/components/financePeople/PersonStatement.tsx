import type { CSSProperties, ReactNode } from 'react';
import { personStatementStrings, type PersonStatementStrings } from '../../lib/personStatementStrings';
import { percentText } from '../../lib/personFinanceStrings';
import { Money, useLanguage } from './shared';
import type { AgreementFinance, PersonFinance } from './PersonFinanceView';
import { debtOf, flowColumns, type Column } from './personFlow';

/**
 * «الحساب باختصار» — the person statement (owner request 2026-11-17; DECISIONS row 342).
 *
 * One table answers the owner's five questions for someone who works and
 * invests: what was earned from work, what from investing, what was paid,
 * what is still waiting and how much can be withdrawn now; then one numbered
 * row per investment («استثمار 1», «استثمار 2», …) with its capital, share,
 * units sold and left, and its profit.
 *
 * Display only: every amount is the server's (worker/lib/personFinance.ts).
 * The server's own rule is earned = paid + in a withdrawal request + waiting +
 * available (held is the ledger's unpaid remainder), so the column always
 * closes; when a ledger paid more than it earned, the difference is drawn as
 * its own «debt» line, never hidden. The table totals are the rows' sums, and
 * profit the agreements do not carry (an older record) is its own line, so
 * the table's total is the account's total.
 */
const strings = (lang: string) => personStatementStrings(lang as 'ar' | 'en' | 'ckb');

const Minus = ({ value }: { value: number }) => <>{value > 0 && <span className="fp-sign" aria-hidden="true">−</span>}<Money value={value} /></>;

/** Earned − paid − in a withdrawal request − waiting = left to withdraw, per source and together. */
export function MoneyFlow({ person }: { person: PersonFinance }) {
  const { lang } = useLanguage(), t = strings(lang);
  const cols = flowColumns(person, t);
  if (!cols.length) return null;
  const any = (f: (c: Column) => number) => cols.some((c) => f(c) !== 0);
  const row = (key: string, label: string, cell: (c: Column) => ReactNode, className?: string) =>
    <tr key={key} className={className}><th scope="row">{label}</th>{cols.map((c) => <td key={c.key} data-label={c.label}>{cell(c)}</td>)}</tr>;
  const capital = any((c) => c.capital);
  return <section className="fp-stack fp-flow-block" aria-label={t.flowTitle}>
    <div><h4>{t.flowTitle}</h4><p className="fp-row-meta">{t.flowHint}</p></div>
    <table className="fp-ledger fp-flow" style={{ '--cols': cols.length } as CSSProperties}>
      <thead><tr><td />{cols.map((c) => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
      <tbody>
        {row('earned', t.earned, (c) => <Money value={c.earned} />)}
        {row('paid', t.paid, (c) => <Minus value={c.paid} />)}
        {any((c) => c.reserved) && row('reserved', t.reserved, (c) => <Minus value={c.reserved} />)}
        {any((c) => c.held) && row('held', t.held, (c) => <Minus value={c.held} />, 'fp-ledger-wait')}
        {any(debtOf) && row('debt', t.debt, (c) => <Money value={debtOf(c)} className={debtOf(c) ? 'fp-negative' : ''} />)}
        {row('available', t.available, (c) => <Money value={c.available} />, 'fp-ledger-sum')}
        {capital && row('capital', t.capitalBack, (c) => c.key === 'work' ? <span className="fp-row-meta">—</span> : <Money value={c.capital} />)}
        {capital && row('withdraw', t.canWithdraw, (c) => <Money value={c.withdraw} />, 'fp-ledger-sum fp-ledger-go')}
      </tbody>
    </table>
  </section>;
}

const byAge = (a: AgreementFinance, b: AgreementFinance) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
const agreementTitle = (a: AgreementFinance, lang: string) => (lang === 'en' ? a.product_name : a.product_name_ar || a.product_name) || a.label || a.name;

/** Where one investment stands, in words (no amount): goods still on the way, all sold, or selling. */
const stageOf = (a: AgreementFinance, t: PersonStatementStrings) => a.units.ordered > a.units.received ? t.stageIncoming
  : a.units.received > 0 && a.units.in_stock + a.units.in_orders === 0 ? t.stageSoldOut : t.stageSelling;
/** Profit earned ÷ capital, the same rule as the account's return (roi_bps, rounded down). */
const returnBps = (profit: number, capital: number) => capital > 0 ? Math.floor(profit * 10000 / capital) : null;

/** «استثمار 1», «استثمار 2», … oldest first: where it stands, capital, share, units sold of all with a bar,
 * profit, its return, and that profit split into available and waiting; then the capital returned. */
export function InvestmentsTable({ person }: { person: PersonFinance }) {
  const { lang } = useLanguage(), t = strings(lang);
  const inv = person.investor;
  if (!inv?.agreements.length) return null;
  const rows = [...inv.agreements].sort(byAge);
  const sum = (f: (a: AgreementFinance) => number) => rows.reduce((n, a) => n + f(a), 0);
  const all = (a: AgreementFinance) => Math.max(a.units.ordered, a.units.received);
  const left = (a: AgreementFinance) => a.units.in_stock + a.units.in_orders + Math.max(0, a.units.ordered - a.units.received);
  const other = inv.profit.earned_iqd - sum((a) => a.profit.earned_iqd), otherAvailable = inv.profit.available_iqd - sum((a) => a.profit.available_iqd), otherHeld = inv.profit.held_iqd - sum((a) => a.profit.held_iqd);
  const cols = [t.capital, t.share, t.sold, t.profit, t.returnPct, t.profitAvailable, t.waitingShort, t.capitalReturned];
  const sold = (n: number, of: number, rest: number) => <span className="fp-units"><span>{t.unitsOf(n, of)}</span>
    {of > 0 && <span className="fp-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, (n / of) * 100)}%` }} /></span>}
    <span className="fp-row-meta">{t.unitsLeft(rest)}</span></span>;
  const pct = (bps: number | null) => <bdi dir="ltr">{percentText(bps, 1)}</bdi>;
  const capital = sum((a) => a.principal_iqd);
  return <section className="fp-stack" aria-label={t.investTitle}>
    <div><h4>{t.investTitle}</h4><p className="fp-row-meta">{t.investHint}</p></div>
    <div className="fp-ledger-wrap"><table className="fp-ledger fp-cards">
      <thead><tr><th scope="col">{t.item}</th>{cols.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((a, i) => <tr key={a.id}>
          <th scope="row"><strong>{t.invNo(i + 1)}</strong><span className="fp-row-meta">{agreementTitle(a, lang)}</span><span className="fp-row-meta fp-stage">{stageOf(a, t)}</span></th>
          <td data-label={t.capital}><Money value={a.principal_iqd} /></td>
          <td data-label={t.share}><bdi dir="ltr">{percentText(a.profit_share_bps)}</bdi></td>
          <td data-label={t.sold}>{sold(a.units.sold, all(a), left(a))}</td>
          <td data-label={t.profit}><Money value={a.profit.earned_iqd} /></td>
          <td data-label={t.returnPct}>{pct(returnBps(a.profit.earned_iqd, a.principal_iqd))}</td>
          <td data-label={t.profitAvailable}><Money value={a.profit.available_iqd} /></td>
          <td data-label={t.waitingShort} className={a.profit.held_iqd > 0 ? 'fp-ledger-waitcell' : undefined}><Money value={a.profit.held_iqd} /></td>
          <td data-label={t.capitalReturned}><Money value={a.capital.back_from_sales_iqd} /></td>
        </tr>)}
        {(other !== 0 || otherAvailable !== 0 || otherHeld !== 0) && <tr>
          <th scope="row"><span className="fp-row-meta">{t.other}</span></th>
          <td data-label={t.capital} /><td data-label={t.share} /><td data-label={t.sold} />
          <td data-label={t.profit}><Money value={other} /></td><td data-label={t.returnPct} />
          <td data-label={t.profitAvailable}><Money value={otherAvailable} /></td><td data-label={t.waitingShort}><Money value={otherHeld} /></td><td data-label={t.capitalReturned} />
        </tr>}
        {rows.length > 1 || other !== 0 ? <tr className="fp-ledger-sum">
          <th scope="row">{t.total}</th>
          <td data-label={t.capital}><Money value={capital} /></td>
          <td data-label={t.share} />
          <td data-label={t.sold}>{sold(sum((a) => a.units.sold), sum(all), sum(left))}</td>
          <td data-label={t.profit}><Money value={inv.profit.earned_iqd} /></td>
          <td data-label={t.returnPct}>{pct(returnBps(inv.profit.earned_iqd, capital))}</td>
          <td data-label={t.profitAvailable}><Money value={inv.profit.available_iqd} /></td>
          <td data-label={t.waitingShort}><Money value={inv.profit.held_iqd} /></td>
          <td data-label={t.capitalReturned}><Money value={sum((a) => a.capital.back_from_sales_iqd)} /></td>
        </tr> : null}
      </tbody>
    </table></div>
  </section>;
}

export type SummaryRow = { key: string; name: string; onOpen?: () => void; cells: number[] };

/** The owner's one line per person, since the start, with a total line. */
export function PeopleSummary({ title, columns, rows }: { title: string; columns: string[]; rows: SummaryRow[] }) {
  const { lang } = useLanguage(), t = strings(lang);
  if (!rows.length) return null;
  const total = columns.map((_, i) => rows.reduce((n, r) => n + (r.cells[i] ?? 0), 0));
  return <section className="fp-stack fp-summary" aria-label={title}>
    <div><h4>{title}</h4><p className="fp-row-meta">{t.summaryHint}</p></div>
    <div className="fp-ledger-wrap"><table className="fp-ledger fp-cards">
      <thead><tr><th scope="col">{t.name}</th>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => <tr key={r.key}>
          <th scope="row">{r.onOpen ? <button type="button" className="fp-link" onClick={r.onOpen} aria-label={`${t.open}: ${r.name}`}>{r.name}</button> : r.name}</th>
          {r.cells.map((n, i) => <td key={columns[i]} data-label={columns[i]}><Money value={n} /></td>)}
        </tr>)}
        {rows.length > 1 && <tr className="fp-ledger-sum"><th scope="row">{t.total}</th>{total.map((n, i) => <td key={columns[i]} data-label={columns[i]}><Money value={n} /></td>)}</tr>}
      </tbody>
    </table></div>
  </section>;
}
