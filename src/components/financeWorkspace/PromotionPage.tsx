import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { refusalText } from '../../lib/refusalStrings';
import { useLanguage } from '../../LanguageContext';
import { Button, Field, formatMoney, Loading, Money, Status, Surface, useNarrow } from './ui';
import { currentMonth, financeDay, WORKSPACE_API, type Promotion } from './types';
import { PA_STRINGS, tri } from './displayCurrencyStrings';
import { cs } from './costsStrings';
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
 * WHO CARRIES IT: the month's products with their pieces, net sales, share of the month's sales and share of the promotion —
 * the server's own line shares, adding up to the month exactly; a month with no sale yet waits for one, its amount counted on
 * its 1st (owner default 5.7.4); the current month's shares are provisional until it ends (owner default 5.7.2, no freezing).
 * Staff and investor shares never include it. THE HISTORY: every edit, who and when, before → after. The collapsed
 * «مصروفات أخرى للشهر» box is gone: rent and the like are Costs → General expenses.
 */
type Lang = 'ar' | 'en' | 'ckb';
export interface PromotionShare { product_id: string | null; name: string; qty: number; sales_iqd: number; promotion_iqd: number }
export interface PromotionState { currency: string; amount: number; exchange_rate: number; amount_iqd: number; enabled: boolean }
export interface PromotionEdit { id: string; version: number; at: string; actor_id: string; actor_name: string | null; before: PromotionState | null; after: PromotionState | null }
export interface PromotionsAnswer {
  month: string; promotions: Promotion[]; total_iqd: number; unallocated_iqd: number;
  rate_suggestion?: { rate: string; date: string; usd_basis: 'at_time' | 'today' } | null;
  /** Redesign step 5 (absent from a server that predates it). */
  products?: PromotionShare[]; sales_iqd?: number; lines_count?: number; history?: PromotionEdit[];
}
/** The day the owner chose the rule (DECISIONS row 313). */
const RULE_DAY = '2026-11-11';
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A promotion's amount as the history writes it: dinars, or the paid currency with the dinars it was booked at. */
export const promotionAmount = (p: PromotionState) => (p.currency === 'IQD' ? formatMoney(p.amount_iqd) : `${p.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${p.currency} (${formatMoney(p.amount_iqd)})`);
/** What one edit did, in words: entered, changed, disabled, enabled again. */
export function editText(loc: (ar: string, en: string, ckb?: string) => string, h: PromotionEdit): string {
  const before = h.before ? promotionAmount(h.before) : '', after = h.after ? promotionAmount(h.after) : '';
  if (!h.before) return cs(loc, 'histCreated', { after });
  if (h.before.enabled && h.after && !h.after.enabled) return cs(loc, 'histDisabled', { before });
  if (!h.before.enabled && h.after?.enabled) return cs(loc, 'histEnabled', { after });
  return cs(loc, 'histChanged', { before, after });
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const operation = useRef(crypto.randomUUID());
  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setExchange('');
    api.get<PromotionsAnswer>(`${WORKSPACE_API}/promotions?month=${month}`)
      .then((r) => {
        if (!live) return;
        setData(r);
        const primary = r.promotions?.find((p) => p.enabled);
        setAmount(primary ? String(primary.amount) : ''); setCurrency(primary?.currency ?? 'USD');
      })
      .catch((e) => { if (live) { setData(null); setError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [month, revision]);
  // The month changed: what was typed for another month is not this one's, nor is its notice.
  useEffect(() => { setNotice(''); operation.current = crypto.randomUUID(); }, [month]);
  const promotions = data?.month === month ? data.promotions ?? [] : [];
  const selected = promotions.find((p) => p.enabled);
  const suggestion = data?.month === month ? data.rate_suggestion ?? null : null;
  const save = async () => {
    if (saving || amount.trim() === '') return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { setError(cs(loc, 'promoInvalid')); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const body = { month, amount: value, currency, operation_id: operation.current,
        ...(exchange.trim() ? { exchange_rate: Number(exchange) } : {}), ...(selected ? { version: selected.version } : {}) };
      if (selected) await api.patch(`${WORKSPACE_API}/promotions/${encodeURIComponent(selected.id)}`, body);
      else await api.post(`${WORKSPACE_API}/promotions`, body);
      operation.current = crypto.randomUUID();
      setNotice(cs(loc, 'promoSaved'));
      // The workspace reads every figure again — this page's shares and history with them (`revision`).
      onChanged();
    } catch (e) { setError(e instanceof ApiError && e.code ? refusalText(e.code, lang, e.message) : e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  // P-A F3: any currency but the dinar books at the rate actually paid. The
  // field is in view (not under the advanced options) and blank only keeps the
  // rate an existing same-currency row already carries.
  const foreign = currency !== 'IQD';
  const keepsRate = !!selected && selected.currency === currency;
  const rateField = <Field label={tri(loc, PA_STRINGS.promotionRateLabel)} hint={keepsRate ? tri(loc, PA_STRINGS.promotionRateKeep, { rate: String(selected!.exchange_rate) }) : tri(loc, PA_STRINGS.promotionRateHint)}>
    <input className="fw-input" type="number" min="0" step="any" inputMode="decimal" dir="ltr" value={exchange} required={!keepsRate} data-finance-promotion-rate
      onChange={(e) => { setExchange(e.target.value); operation.current = crypto.randomUUID(); }} placeholder={keepsRate ? String(selected!.exchange_rate) : currency === 'USD' && suggestion ? suggestion.rate : ''} />
    {currency === 'USD' && suggestion && !keepsRate && exchange.trim() === '' && <button type="button" className="fw-pill" data-finance-promotion-rate-suggestion
      onClick={() => { setExchange(suggestion.rate); operation.current = crypto.randomUUID(); }}>
      {tri(loc, PA_STRINGS.promotionRateSuggestion, { date: suggestion.date, rate: suggestion.usd_basis === 'today' ? `≈ ${suggestion.rate}` : suggestion.rate })}
    </button>}
  </Field>;
  const remove = async () => {
    if (!selected || saving) return;
    setSaving(true); setError(''); setNotice('');
    try { await api.delete(`${WORKSPACE_API}/promotions/${encodeURIComponent(selected.id)}`); onChanged(); }
    catch (e) { setError(e instanceof ApiError && e.code ? refusalText(e.code, lang, e.message) : e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const shown = data?.month === month ? data : null;
  return <>
    <Surface title={`${fw(loc, 'promotion')} · ${monthText(L, month)}`}>
      <div className="fw-list" data-finance-promotion={month}>
        <label className="fw-chip" style={{ justifySelf: 'start' }}><CalendarDays size={16} aria-hidden /><input type="month" className="fw-input" value={month} aria-label={cs(loc, 'promoPick')} data-finance-promotion-month
          onChange={(e) => { if (MONTH.test(e.target.value)) onMonth(e.target.value); }} /></label>
        {from.slice(0, 7) !== to.slice(0, 7) && <p className="fw-note" data-finance-promotion-span>{cs(loc, 'promoSpan', { from: monthText(L, from.slice(0, 7)), to: monthText(L, to.slice(0, 7)) })}</p>}
        {month === currentMonth() && <p className="fw-note" data-finance-promotion-provisional><Status tone="warning">{cs(loc, 'promoProvisional')}</Status> {cs(loc, 'promoProvisionalNote')}</p>}
        {error && <div className="fw-error" role="alert">{error}</div>}
        {notice && <p className="fw-success" role="status"><Check size={16} />{notice}</p>}
        {loading && !shown ? <Loading text={cs(loc, 'promoLoading')} /> : <>
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
            <Button variant="primary" busy={saving} disabled={loading || amount.trim() === '' || (foreign && !keepsRate && exchange.trim() === '')} onClick={save}><Check size={16} />{cs(loc, 'promoSave')}</Button>
            {selected && <Button variant="ghost" busy={saving} onClick={remove}>{cs(loc, 'promoDisable')}</Button>}
          </div>
          <p className="fw-formula" data-finance-promotion-rule><b>{cs(loc, 'promoRule', { day: dayText(L, RULE_DAY) })}</b></p>
        </>}
      </div>
    </Surface>
    {shown && <Carriers data={shown} narrow={narrow} />}
    {shown && <History edits={shown.history ?? []} />}
  </>;
}

/** «من يحمل الترويج»: the month's products and their shares, adding up to the month; or why there are none. */
export function Carriers({ data, narrow }: { data: PromotionsAnswer; narrow: boolean }) {
  const { loc } = useLanguage();
  const products = data.products ?? [];
  const table = promotionTable(products);
  const staff = <p className="fw-note">{cs(loc, 'promoStaff')}</p>;
  if (!data.total_iqd) return <Surface title={cs(loc, 'promoCarriers')}><p className="fw-note" role="status" data-finance-promotion-none>{cs(loc, 'promoNone')}</p>{staff}</Surface>;
  if (!products.length || data.unallocated_iqd > 0) return <Surface title={cs(loc, 'promoCarriers')}>
    <p data-finance-promotion-waiting><Status tone="warning">{cs(loc, 'promoWaiting')}</Status> <Money value={data.unallocated_iqd || data.total_iqd} /></p>
    <p className="fw-note">{cs(loc, 'promoWaitingNote')}</p>{staff}</Surface>;
  const total = rs(loc, 'total');
  return <Surface title={cs(loc, 'promoCarriers')} subtitle={cs(loc, 'promoRuleNote')}>
    {narrow ? <ul className="fw-rows" data-finance-promotion-products>
      {table.rows.map((p) => <li key={p.product_id ?? p.name}><div><span className="fw-rows-a">{p.name}</span><span className="fw-rows-b"><Money value={p.promotion_iqd} /></span>
        <span className="fw-rows-c">{fw(loc, 'pieces')} {p.qty.toLocaleString('en-US')} · {fw(loc, 'netSales')} <Money value={p.sales_iqd} /> · <bdi dir="ltr">{percentText(p.percent)}</bdi></span></div></li>)}
      <li className="fw-rows-total"><span>{total}</span><b><Money value={table.total.promotion_iqd} /></b></li>
    </ul> : <div className="fw-table-wrap"><table className="fw-table fw-report" data-finance-promotion-products>
      <thead><tr><th scope="col" className="fw-start">{fw(loc, 'product')}</th><th scope="col">{fw(loc, 'pieces')}</th><th scope="col">{fw(loc, 'netSales')}</th>
        <th scope="col">{cs(loc, 'promoColShare')}</th><th scope="col">{cs(loc, 'promoColAmount')}</th></tr></thead>
      <tbody>{table.rows.map((p) => <tr key={p.product_id ?? p.name}><th scope="row" className="fw-start"><span className="fw-name">{p.name}</span></th>
        <td className="fw-num">{p.qty.toLocaleString('en-US')}</td><td><Money value={p.sales_iqd} /></td><td className="fw-num"><bdi dir="ltr">{percentText(p.percent)}</bdi></td><td><b><Money value={p.promotion_iqd} /></b></td></tr>)}</tbody>
      <tfoot><tr><td className="fw-start">{total}</td><td className="fw-num">{table.total.qty.toLocaleString('en-US')}</td><td><Money value={table.total.sales_iqd} /></td>
        <td className="fw-num"><bdi dir="ltr">{percentText(100)}</bdi></td><td><Money value={table.total.promotion_iqd} /></td></tr></tfoot>
    </table></div>}
    {staff}
  </Surface>;
}

/** «سجل التعديلات»: each edit of the month, newest first — what it did, who, when. */
export function History({ edits }: { edits: PromotionEdit[] }) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang;
  return <Surface title={cs(loc, 'promoHistory')}>
    {edits.length ? <div className="fw-history" data-finance-promotion-history>{edits.map((h) => {
      const day = financeDay(h.at);
      return <div className="fw-history-row" key={h.id}><div><b>{editText(loc, h)}</b>
        <p>{h.actor_name ?? cs(loc, 'histUnknown')} · <bdi>{day ? rangeText(L, day, day) : ''}</bdi> <bdi dir="ltr">{clockOf(h.at)}</bdi></p></div></div>;
    })}</div> : <p className="fw-note">{cs(loc, 'histNone')}</p>}
  </Surface>;
}
