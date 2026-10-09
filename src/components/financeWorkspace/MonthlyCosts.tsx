import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Megaphone, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { refusalText } from '../../lib/refusalStrings';
import { useLanguage } from '../../LanguageContext';
import ExpenseLedger from '../adminFinance/ExpenseLedger';
import { financeStrings } from '../adminFinance/strings';
import { isLatin } from '../adminFinance/format';
import { Button, Field, Loading, Money, Row, Surface } from './ui';
import { monthRange, WORKSPACE_API, type Promotion } from './types';
import { PA_STRINGS, tri } from './displayCurrencyStrings';

export default function MonthlyCosts({ month, onChanged }: { month: string; onChanged: () => void }) {
  const { loc, dir, lang } = useLanguage();
  const strings = useMemo(() => financeStrings(loc), [loc]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [exchange, setExchange] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [expensesOpen, setExpensesOpen] = useState(false);
  const [unallocated, setUnallocated] = useState(0);
  const operation = useRef(crypto.randomUUID());
  const range = monthRange(month);
  const selected = promotions.find((p) => p.enabled);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setExchange('');
    api.get<{ promotions: Promotion[]; unallocated_iqd?: number }>(`${WORKSPACE_API}/promotions?month=${month}`)
      .then((r) => {
        if (!live) return;
        setPromotions(r.promotions ?? []);
        setUnallocated(r.unallocated_iqd ?? 0);
        const primary = r.promotions?.find((p) => p.enabled);
        setAmount(primary ? String(primary.amount) : ''); setCurrency(primary?.currency ?? 'USD');
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [month, revision]);
  const save = async () => {
    if (saving || amount.trim() === '') return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) { setError(loc('أدخل مبلغًا صحيحًا', 'Enter a valid amount')); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const body = { month, amount: value, currency, operation_id: operation.current,
        ...(exchange.trim() ? { exchange_rate: Number(exchange) } : {}), ...(selected ? { version: selected.version } : {}) };
      if (selected) await api.patch(`${WORKSPACE_API}/promotions/${encodeURIComponent(selected.id)}`, body);
      else await api.post(`${WORKSPACE_API}/promotions`, body);
      operation.current = crypto.randomUUID(); setRevision((v) => v + 1); onChanged();
      setNotice(loc('حُفظ ترويج الشهر وأعيد حساب نصيب المنتجات', 'Monthly promotion saved and product shares recalculated'));
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
      onChange={(e) => { setExchange(e.target.value); operation.current = crypto.randomUUID(); }} placeholder={keepsRate ? String(selected!.exchange_rate) : ''} />
  </Field>;
  const remove = async () => {
    if (!selected || saving) return;
    setSaving(true); setError('');
    try { await api.delete(`${WORKSPACE_API}/promotions/${encodeURIComponent(selected.id)}`); setRevision((v) => v + 1); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  return <>
    {error && <div className="fw-error" role="alert">{error}</div>}
    {notice && <p className="fw-success" role="status"><Check size={16} />{notice}</p>}
    {loading && !promotions.length ? <Loading text={loc('تحميل تكاليف الشهر…', 'Loading monthly costs…')} /> : <Surface className="fw-promo-hero">
      <div><h2>{loc('ترويج الشهر', 'Monthly promotion')}</h2>
        <p className="fw-note">{loc('مبلغ واحد للشهر كله. يتوزع على قطع المنتجات المباعة ويُخصم من حصة المالك.', 'One amount for the whole month, allocated across sold units and borne by the owner.')}</p>
        <div className="fw-promo-amount">
          <input type="number" inputMode="decimal" min="0" step="any" value={amount} placeholder="100" aria-label={loc('مبلغ الترويج', 'Promotion amount')}
            onFocus={(e) => e.target.select()} onChange={(e) => { setAmount(e.target.value); operation.current = crypto.randomUUID(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
          <select className="fw-select" value={currency} onChange={(e) => { setCurrency(e.target.value); operation.current = crypto.randomUUID(); }} aria-label={loc('العملة', 'Currency')}>
            <option value="USD">USD</option><option value="IQD">IQD</option>
          </select>
        </div>
        <div className="fw-promo-summary">
          {selected && <span>{loc('المبلغ المسجل بالدينار', 'Recorded IQD amount')}: <Money value={selected.amount_iqd} /></span>}
          <span>{loc('الشهر', 'Month')}: <span dir="ltr">{month}</span> · {loc('يتحمله المالك فقط', 'Owner borne')}</span>
        </div>
        {foreign && rateField}
        <Button variant="primary" busy={saving} disabled={loading || amount.trim() === '' || (foreign && !keepsRate && exchange.trim() === '')} onClick={save}><Check size={16} />{loc('حفظ مبلغ الشهر', 'Save monthly amount')}</Button>
        {selected && <Button variant="ghost" busy={saving} onClick={remove}>{loc('إيقاف الترويج لهذا الشهر', 'Disable this month’s promotion')}</Button>}
        {promotions.length > 1 && <details className="fw-advanced"><summary>{loc('خيارات متقدمة', 'Advanced options')}</summary>
          {promotions.map((p) => <Row key={p.id} label={p.title} value={<Money value={p.amount_iqd} />} />)}
        </details>}
      </div>
      <span className="fw-promo-symbol" aria-hidden><Megaphone size={30} strokeWidth={1.6} /></span>
    </Surface>}
    <Surface title={loc('كيف يؤثر على الأرباح؟', 'How does this affect profit?')}>
      <Row label={loc('نطاق التوزيع', 'Allocation scope')} value={loc('كل منتجات الشهر', 'All products sold this month')} />
      <Row label={loc('طريقة التوزيع', 'Allocation method')} value={loc('حسب عدد القطع المباعة', 'By sold units')} />
      <Row label={loc('حصة الموظف والمستثمر', 'Staff and investor share')} value={loc('لا تخصم منها تكلفة الترويج', 'Unaffected by promotion')} />
      {unallocated > 0 && <Row label={loc('ترويج بانتظار مبيعات الشهر', 'Promotion awaiting this month’s sales')} value={<Money value={unallocated} />} hint={loc('يظهر الآن ضمن تكاليف المالك، ويتوزع عند بيع القطع.', 'Already included in owner costs; allocated when units sell.')} />}
      <p className="fw-note">{loc('عند تعديل المبلغ، تتحدث تفاصيل الطلبات والمنتجات وحصة المالك للشهر. يسجل النظام التعديل تلقائيًا.', 'Changing the amount updates orders, products and the owner’s monthly share. Changes are recorded automatically.')}</p>
    </Surface>
    <details className="fw-advanced" onToggle={(e) => setExpensesOpen(e.currentTarget.open)}><summary><Plus size={16} />{loc('مصروفات أخرى للشهر', 'Other monthly expenses')}</summary>
      {expensesOpen && <ExpenseLedger from={range.from} to={range.to} s={strings} latin={isLatin(lang)} dir={dir} onChanged={onChanged} />}
    </details>
  </>;
}
