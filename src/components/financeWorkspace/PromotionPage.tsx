import { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, Check } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, Field, formatMoney, Loading, Money, Status, Surface, useNarrow } from './ui';
import { currentMonth, financeDay, WORKSPACE_API, type Promotion } from './types';
import { PA_STRINGS, tri } from './displayCurrencyStrings';
import { cs, refusalWords } from './costsStrings';
import { dayText, fw, monthText, rangeText } from './overviewStrings';
import { rs } from './reportStrings';
import { percentText, promotionTable } from './costFigures';

/**
 * «التكاليف ← ترويج الشهر» (redesign step 5, owner 2026-11-11; DECISIONS row 317), in place of «تكاليف الشهر».
 *
 * ONE MONTH, NAMED: the period's month unless the owner picks another (the workspace passes it; a period across months says
 * so, since each month has its own promotion). THE AMOUNT: the month's total, its currency, the rate actually paid (P-A F3,
 * unchanged: required for any currency but the dinar unless the row keeps its own, a suggestion filled only on a tap) and
 * the dinars it was booked at; save and disable. THE RULE: by sales value, the owner's decision of 11 November (row 313).
 * WHO CARRIES IT: the month's products with the pieces sold, the sales as invoiced, the share of the month's sales and the
 * share of the promotion — the server's own line shares, adding up to the month exactly; a month with no sale yet waits for
 * one, its amount counted on its 1st (owner default 5.7.4), and a past month without sales says it counted then; the current
 * month's shares are provisional until it ends (owner default 5.7.2, no freezing). Staff and investor shares never include
 * it. THE HISTORY: every edit, who and when, before → after, a move to another month named. The collapsed «مصروفات أخرى
 * للشهر» box is gone: rent and the like are Costs → General expenses.
 *
 * The independent review of step 5: the workspace mounts the page once per month (`key={month}`, as it did MonthlyCosts), so
 * nothing typed for one month stands in another's form; the form is drawn only on this month's own answer — after a failed
 * read the page says why and offers to read again, never a form that would book the last month's amount on this one; one
 * condition (`blocked`) holds both the save button and Enter in the amount; disabling asks first, naming the month and the
 * amount, and says when it is done; a refusal is worded in the reader's language.
 */
type Lang = 'ar' | 'en' | 'ckb';
export interface PromotionShare { product_id: string | null; name: string; qty: number; sales_iqd: number; promotion_iqd: number }
export interface PromotionState { month?: string; currency: string; amount: number; exchange_rate: number; amount_iqd: number; enabled: boolean }
export interface PromotionEdit { id: string; version: number; at: string; actor_id: string; actor_name: string | null; before: PromotionState | null; after: PromotionState | null }
export interface PromotionsAnswer {
  month: string; promotions: Promotion[]; total_iqd: number; unallocated_iqd: number;
  rate_suggestion?: { rate: string; date: string; usd_basis: 'at_time' | 'today' } | null;
  /** Redesign step 5 (absent from a server that predates it). */
  products?: PromotionShare[]; sales_iqd?: number; lines_count?: number; history?: PromotionEdit[]; history_truncated?: boolean;
}
/** The day the owner chose the rule (DECISIONS row 313). */
const RULE_DAY = '2026-11-11';
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A promotion's amount as the history writes it: dinars, or the paid currency with the dinars it was booked at. */
export const promotionAmount = (p: Pick<PromotionState, 'currency' | 'amount' | 'amount_iqd'>) => (p.currency === 'IQD' ? formatMoney(p.amount_iqd) : `${p.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${p.currency} (${formatMoney(p.amount_iqd)})`);
/** What one edit did, in words: entered, changed (or not), disabled, enabled again — and moved to another month, when it was. */
export function editText(loc: (ar: string, en: string, ckb?: string) => string, h: PromotionEdit, lang: Lang = 'ar'): string {
  const before = h.before ? promotionAmount(h.before) : '', after = h.after ? promotionAmount(h.after) : '';
  if (!h.before) return cs(loc, 'histCreated', { after });
  const what = h.before.enabled && h.after && !h.after.enabled ? cs(loc, 'histDisabled', { before })
    : !h.before.enabled && h.after?.enabled ? cs(loc, 'histEnabled', { after })
      : before === after ? cs(loc, 'histSame', { after }) : cs(loc, 'histChanged', { before, after });
  const from = h.before.month, to = h.after?.month;
  return from && to && from !== to ? `${cs(loc, 'histMoved', { from: monthText(lang, from), to: monthText(lang, to) })} · ${what}` : what;
}
/** The Baghdad time of an instant, Latin digits. */
const clockOf = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t + 3 * 3600000).toISOString().slice(11, 16) : ''; };

export default function PromotionPage({ month, onMonth, from, to, revision = 0, onChanged }: {
  month: string; onMonth: (month: string) => void; from: string; to: string; revision?: number; onChanged: () => void;
}) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang;
  const narrow = useNarrow();
  const [data, setData] = useState<PromotionsAnswer | null>(null);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [exchange, setExchange] = useState('');
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const operation = useRef(crypto.randomUUID());
  const stopButton = useRef<HTMLSpanElement>(null);
  const confirmBox = useRef<HTMLDivElement>(null);
  const stopped = useRef(false);
  const stopId = useId();
  useEffect(() => {
    let live = true;
    setLoading(true); setReadError(''); setExchange('');
    api.get<PromotionsAnswer>(`${WORKSPACE_API}/promotions?month=${month}`)
      .then((r) => {
        if (!live) return;
        setData(r);
        const primary = r.promotions?.find((p) => p.enabled);
        setAmount(primary ? String(primary.amount) : ''); setCurrency(primary?.currency ?? 'USD');
      })
      .catch((e) => { if (live) { setData(null); setReadError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [month, revision, attempt]);
  // The confirmation opens on its sentence, so a second Enter never stops the promotion unread; closed, focus goes back to its button.
  useEffect(() => {
    if (stopping) { stopped.current = true; confirmBox.current?.querySelector<HTMLElement>('p')?.focus(); }
    else if (stopped.current) { stopped.current = false; stopButton.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
  }, [stopping]);
  // This month's own answer: the form, the carriers and the history stand on it, never on another month's.
  const shown = data?.month === month ? data : null;
  const promotions = shown?.promotions ?? [];
  const selected = promotions.find((p) => p.enabled);
  const suggestion = shown?.rate_suggestion ?? null;
  // P-A F3: any currency but the dinar books at the rate actually paid. The
  // field is in view (not under the advanced options) and blank only keeps the
  // rate an existing same-currency row already carries.
  const foreign = currency !== 'IQD';
  const keepsRate = !!selected && selected.currency === currency;
  // One condition for the button and for Enter in the amount: nothing is sent while it holds.
  const blocked = loading || !shown || saving || amount.trim() === '' || (foreign && !keepsRate && exchange.trim() === '');
  const refused = (e: unknown) => refusalWords(loc, lang, e, e instanceof Error ? e.message : String(e));
  const save = async () => {
    if (blocked) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { setError(cs(loc, 'promoInvalid')); return; }
    setSaving(true); setError(''); setNotice(''); setStopping(false);
    try {
      const body = { month, amount: value, currency, operation_id: operation.current,
        ...(exchange.trim() ? { exchange_rate: Number(exchange) } : {}), ...(selected ? { version: selected.version } : {}) };
      if (selected) await api.patch(`${WORKSPACE_API}/promotions/${encodeURIComponent(selected.id)}`, body);
      else await api.post(`${WORKSPACE_API}/promotions`, body);
      operation.current = crypto.randomUUID();
      setNotice(cs(loc, 'promoSaved'));
      // The workspace reads every figure again — this page's shares and history with them (`revision`).
      onChanged();
    } catch (e) { setError(refused(e)); }
    finally { setSaving(false); }
  };
  const rateField = <Field label={tri(loc, PA_STRINGS.promotionRateLabel)} hint={keepsRate ? tri(loc, PA_STRINGS.promotionRateKeep, { rate: String(selected!.exchange_rate) }) : tri(loc, PA_STRINGS.promotionRateHint)}>
    <input className="fw-input" type="number" min="0" step="any" inputMode="decimal" dir="ltr" value={exchange} required={!keepsRate} data-finance-promotion-rate
      onChange={(e) => { setExchange(e.target.value); operation.current = crypto.randomUUID(); }} placeholder={keepsRate ? String(selected!.exchange_rate) : currency === 'USD' && suggestion ? suggestion.rate : ''} />
    {currency === 'USD' && suggestion && !keepsRate && exchange.trim() === '' && <button type="button" className="fw-pill" data-finance-promotion-rate-suggestion
      onClick={() => { setExchange(suggestion.rate); operation.current = crypto.randomUUID(); }}>
      {tri(loc, PA_STRINGS.promotionRateSuggestion, { date: suggestion.date, rate: suggestion.usd_basis === 'today' ? `≈ ${suggestion.rate}` : suggestion.rate })}
    </button>}
  </Field>;
  const closeStop = () => setStopping(false);
  const remove = async () => {
    if (!selected || saving) return;
    setSaving(true); setError(''); setNotice('');
    try { await api.delete(`${WORKSPACE_API}/promotions/${encodeURIComponent(selected.id)}`); setStopping(false); setNotice(cs(loc, 'promoDisabled')); onChanged(); }
    catch (e) { setError(refused(e)); }
    finally { setSaving(false); }
  };
  return <>
    <Surface title={`${fw(loc, 'promotion')} · ${monthText(L, month)}`}>
      <div className="fw-list" data-finance-promotion={month}>
        <label className="fw-chip" style={{ justifySelf: 'start' }}><CalendarDays size={16} aria-hidden /><input type="month" className="fw-input" value={month} aria-label={cs(loc, 'promoPick')} data-finance-promotion-month
          onChange={(e) => { if (MONTH.test(e.target.value)) onMonth(e.target.value); }} /></label>
        {from.slice(0, 7) !== to.slice(0, 7) && <p className="fw-note" data-finance-promotion-span>{cs(loc, 'promoSpan', { from: monthText(L, from.slice(0, 7)), to: monthText(L, to.slice(0, 7)) })}</p>}
        {month === currentMonth() && <p className="fw-note" data-finance-promotion-provisional><Status tone="warning">{cs(loc, 'promoProvisional')}</Status> {cs(loc, 'promoProvisionalNote')}</p>}
        {notice && <p className="fw-success" role="status"><Check size={16} />{notice}</p>}
        {!shown ? (loading ? <Loading text={cs(loc, 'promoLoading')} /> : <div className="fw-error" role="alert" data-finance-promotion-read-failed>
          {readError && <>{readError} </>}{cs(loc, 'promoReadFailed')} <Button variant="ghost" onClick={() => setAttempt((v) => v + 1)}>{cs(loc, 'promoRetry')}</Button></div>) : <>
          {error && <div className="fw-error" role="alert">{error}</div>}
          <div className="fw-fields">
            <Field label={cs(loc, 'promoAmount')}>
              <input className="fw-input" type="number" inputMode="decimal" min="0" step="any" dir="ltr" value={amount} placeholder="100" data-finance-promotion-amount
                onFocus={(e) => e.target.select()} onChange={(e) => { setAmount(e.target.value); operation.current = crypto.randomUUID(); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} /></Field>
            <label className="fw-field" style={{ flex: '0 1 140px' }}><span>{cs(loc, 'promoCurrency')}</span>
              <select className="fw-select" value={currency} onChange={(e) => { setCurrency(e.target.value); operation.current = crypto.randomUUID(); }}>
                <option value="USD">USD</option><option value="IQD">IQD</option>
              </select></label>
          </div>
          {selected && <p className="fw-note" data-finance-promotion-recorded>{cs(loc, 'promoRecorded', { amount: formatMoney(selected.amount_iqd) })}</p>}
          {foreign && rateField}
          <div className="fw-fields">
            <Button variant="primary" busy={saving} disabled={blocked} onClick={save} data-finance-promotion-save><Check size={16} />{cs(loc, 'promoSave')}</Button>
            {selected && !stopping && <span ref={stopButton}><Button variant="ghost" busy={saving} onClick={() => setStopping(true)} data-finance-promotion-stop>{cs(loc, 'promoDisable')}</Button></span>}
          </div>
          {selected && stopping && <div className="fw-confirm" role="alertdialog" aria-labelledby={stopId} ref={confirmBox} data-finance-promotion-stop-confirm
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeStop(); } }}>
            <p id={stopId} tabIndex={-1}>{cs(loc, 'promoDisableAsk', { month: monthText(L, month), amount: promotionAmount(selected) })}</p>
            <div className="fw-fields"><Button variant="ghost" disabled={saving} onClick={closeStop}>{cs(loc, 'genCancel')}</Button>
              <Button variant="danger" busy={saving} onClick={() => void remove()}>{cs(loc, 'promoDisableConfirm')}</Button></div>
          </div>}
          <p className="fw-formula" data-finance-promotion-rule><b>{cs(loc, 'promoRule', { day: dayText(L, RULE_DAY) })}</b></p>
        </>}
      </div>
    </Surface>
    {shown && <Carriers data={shown} narrow={narrow} />}
    {shown && <History edits={shown.history ?? []} truncated={!!shown.history_truncated} />}
  </>;
}

/** «من يحمل الترويج»: the month's products and their shares, adding up to the month; or why there are none. */
export function Carriers({ data, narrow }: { data: PromotionsAnswer; narrow: boolean }) {
  const { loc } = useLanguage();
  const products = data.products ?? [];
  const table = promotionTable(products);
  const staff = <p className="fw-note">{cs(loc, 'promoStaff')}</p>;
  if (!data.total_iqd) return <Surface title={cs(loc, 'promoCarriers')}><p className="fw-note" role="status" data-finance-promotion-none>{cs(loc, 'promoNone')}</p>{staff}</Surface>;
  if (!products.length || data.unallocated_iqd > 0) {
    // A month that is over has no sale left to wait for: its amount counted on its 1st, for good (owner default 5.7.4).
    const ended = data.month < currentMonth();
    return <Surface title={cs(loc, 'promoCarriers')}>
      <p data-finance-promotion-waiting={ended ? 'ended' : 'waiting'}><Status tone="warning">{cs(loc, ended ? 'promoEnded' : 'promoWaiting')}</Status> <Money value={data.unallocated_iqd || data.total_iqd} /></p>
      <p className="fw-note">{ended ? cs(loc, 'promoEndedNote') : cs(loc, 'promoWaitingNote')}</p>{staff}</Surface>;
  }
  const total = rs(loc, 'total');
  // Every line free (gifts): the server shares the month equally by line, and the percent column follows those shares.
  const share = cs(loc, products.some((p) => p.sales_iqd > 0) ? 'promoColShare' : 'promoColShareGifts');
  return <Surface title={cs(loc, 'promoCarriers')} subtitle={cs(loc, 'promoRuleNote')}>
    {narrow ? <ul className="fw-rows" data-finance-promotion-products>
      {table.rows.map((p) => <li key={p.product_id ?? p.name}><div><span className="fw-rows-a">{p.name}</span><span className="fw-rows-b"><Money value={p.promotion_iqd} /></span>
        <span className="fw-rows-c">{cs(loc, 'carriersPieces')} {p.qty.toLocaleString('en-US')} · {cs(loc, 'carriersSales')} <Money value={p.sales_iqd} /> · {share} <bdi dir="ltr">{percentText(p.percent)}</bdi></span></div></li>)}
      <li className="fw-rows-total"><span>{total}</span><b><Money value={table.total.promotion_iqd} /></b></li>
    </ul> : <div className="fw-table-wrap"><table className="fw-table fw-report" data-finance-promotion-products>
      <thead><tr><th scope="col" className="fw-start">{fw(loc, 'product')}</th><th scope="col">{cs(loc, 'carriersPieces')}</th><th scope="col">{cs(loc, 'carriersSales')}</th>
        <th scope="col">{share}</th><th scope="col">{cs(loc, 'promoColAmount')}</th></tr></thead>
      <tbody>{table.rows.map((p) => <tr key={p.product_id ?? p.name}><th scope="row" className="fw-start"><span className="fw-name">{p.name}</span></th>
        <td className="fw-num">{p.qty.toLocaleString('en-US')}</td><td><Money value={p.sales_iqd} /></td><td className="fw-num"><bdi dir="ltr">{percentText(p.percent)}</bdi></td><td><b><Money value={p.promotion_iqd} /></b></td></tr>)}</tbody>
      <tfoot><tr><td className="fw-start">{total}</td><td className="fw-num">{table.total.qty.toLocaleString('en-US')}</td><td><Money value={table.total.sales_iqd} /></td>
        <td className="fw-num"><bdi dir="ltr">{percentText(100)}</bdi></td><td><Money value={table.total.promotion_iqd} /></td></tr></tfoot>
    </table></div>}
    <p className="fw-note" data-finance-promotion-invoiced>{cs(loc, 'promoInvoiced')}</p>
    {staff}
  </Surface>;
}

/** «سجل التعديلات»: each edit of the month, newest first — what it did, who, when; and whether older ones were left out. */
export function History({ edits, truncated = false }: { edits: PromotionEdit[]; truncated?: boolean }) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang;
  return <Surface title={cs(loc, 'promoHistory')}>
    {edits.length ? <div className="fw-history" data-finance-promotion-history>{edits.map((h) => {
      const day = financeDay(h.at);
      return <div className="fw-history-row" key={h.id}><div><b>{editText(loc, h, L)}</b>
        <p>{h.actor_name ?? cs(loc, 'histUnknown')} · <bdi>{day ? rangeText(L, day, day) : ''}</bdi> <bdi dir="ltr">{clockOf(h.at)}</bdi></p></div></div>;
    })}</div> : <p className="fw-note">{cs(loc, 'histNone')}</p>}
    {truncated && <p className="fw-note" data-finance-promotion-history-truncated>{cs(loc, 'histTruncated', { n: edits.length })}</p>}
  </Surface>;
}
