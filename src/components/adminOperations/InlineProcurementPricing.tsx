import { useEffect, useId, useState } from 'react';
import { api, ApiError, isAborted } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { contractRefusal, refusalLang } from '../../lib/refusalStrings';
import { typingUsd } from '../adminProducts/form/v2/usdTyping';
import type { V2Answer, V2DraftWire } from '../adminProducts/form/v2/v2Model';
import PricingSummaryBar from './PricingSummaryBar';
import type { PricingSummary } from './procurementPricing';
import { money, T, type Selection } from './shared';

export type InlinePriceDraft = { final_cost_usd?: string; minimum_profit_usd?: string };
interface LinePrice {
  pricing: V2DraftWire;
  preview: V2Answer;
  final_cost_usd: string | null;
  minimum_profit_usd: string | null;
  customer_price_iqd: number | null;
  profit_scope: 'product' | 'option' | 'color' | 'sku';
  cost_from_purchase: boolean;
}

export default function InlineProcurementPricing({ line, purchaseDraft, value, onChange, onSaved, revision, summary, onAdvanced }: {
  line: Pick<Selection, 'product_id' | 'scope' | 'scope_id' | 'label'>;
  purchaseDraft: Record<string, unknown> | null;
  value: InlinePriceDraft;
  onChange: (value: InlinePriceDraft) => void;
  onSaved: () => void;
  revision: number;
  summary: PricingSummary | null;
  onAdvanced: () => void;
}) {
  const { lang, loc } = useLanguage();
  const id = useId();
  const [answer, setAnswer] = useState<{ key: string; data: LinePrice } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmedKey, setConfirmedKey] = useState('');
  const [attempt, setAttempt] = useState(0);
  const dirty = Object.keys(value).length > 0;
  const valid = (value.final_cost_usd === undefined || /^(?:\d+)(?:\.\d{1,6})?$/.test(value.final_cost_usd))
    && (value.minimum_profit_usd === undefined || value.minimum_profit_usd === '' || /^(?:\d+)(?:\.\d{1,6})?$/.test(value.minimum_profit_usd));
  const requestKey = JSON.stringify([{ product_id: line.product_id, scope: line.scope, scope_id: line.scope_id, ...(purchaseDraft ? { draft: purchaseDraft } : {}), ...value }, revision, attempt]);
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.post<LinePrice>('/api/admin/pricing/procurement/line-pricing', JSON.parse(requestKey)[0], { signal: controller.signal, mascot: 'silent' })
        .then((data) => { if (!controller.signal.aborted) { setAnswer({ key: requestKey, data }); setError(null); } })
        .catch((e) => {
          if (isAborted(e) || controller.signal.aborted) return;
          setError(e);
        });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [requestKey, valid]);
  const result = answer?.key === requestKey && valid ? answer.data : null;
  const answeredSelection = answer ? JSON.parse(answer.key)[0] as Selection : null;
  const latest = answeredSelection?.product_id === line.product_id && answeredSelection.scope === line.scope && answeredSelection.scope_id === line.scope_id ? answer?.data : null;
  const pending = !result && !error && valid;
  const confirmRequired = result?.preview.large_change || result?.preview.drop_flag;
  const change = (field: keyof InlinePriceDraft, text: string) => {
    setError(null); setSaved(false); setConfirmedKey('');
    onChange({ ...value, [field]: typingUsd(text) });
  };
  const field = (key: keyof InlinePriceDraft, label: string, fallback: string | null | undefined) => (
    <div className="flex min-w-0 items-center gap-1" dir="ltr">
      <span aria-hidden="true">$</span>
      <input id={`${id}-${key}`} aria-label={`${label} (USD) · ${line.label}`} type="text" inputMode="decimal" autoComplete="off"
        className="min-h-11 w-full min-w-0 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-0)] px-2 tabular-nums focus:border-[var(--ap-ring)]"
        placeholder="—" disabled={saving} value={value[key] ?? fallback ?? ''} onChange={(e) => change(key, e.target.value)} data-procurement-field={key} />
    </div>
  );
  const save = async () => {
    if (!result || saving) return;
    setSaving(true); setError(null);
    try {
      await api.put(`/api/admin/products-v2/${encodeURIComponent(line.product_id)}/pricing`, {
        pricing: result.pricing, seq: result.preview.seq, preview_hash: result.preview.review_hash,
        ...(confirmedKey === requestKey ? { confirm_large_change: true } : {}),
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e);
      // An obsolete preview must be read again before retrying its save.
      if (e instanceof ApiError && ['PRICING_CHANGED', 'PRICING_PREVIEW_STALE'].includes(e.code ?? '')) {
        setAnswer(null);
        setAttempt((n) => n + 1);
      }
    } finally { setSaving(false); }
  };
  const invalidField = error instanceof ApiError ? error.details?.field : null;
  const errorText = !valid
    ? loc('أكمل المبلغ لحساب السعر وحفظه.', 'Complete the amount to preview and save the price.', 'بڕەکە تەواو بکە بۆ پێشبینیکردن و پاشەکەوتکردنی نرخ.')
    : invalidField === 'final_cost_usd_requires_freight'
    ? loc('أكمل مسار الشحن ووزن أو حجم القطعة أولاً لحساب التكلفة النهائية.', 'Complete the shipping route and packed weight or volume before setting the final cost.', 'سەرەتا ڕێگای ناردن و کێش یان قەبارەی پاکێجکراو تەواو بکە بۆ دانانی تێچووی کۆتایی.')
    : invalidField === 'final_cost_usd_below_freight'
      ? loc('التكلفة النهائية يجب أن تكون أكبر من الشحن والمصاريف الإضافية.', 'Final cost must exceed freight and extra charges.', 'تێچووی کۆتایی دەبێت لە کرێی ناردن و خەرجیی زیادە زیاتر بێت.')
      : invalidField === 'final_cost_usd' || invalidField === 'minimum_profit_usd'
        ? loc('أدخل مبلغاً صالحاً بالدولار، حتى ست خانات عشرية.', 'Enter a valid USD amount with up to six decimal places.', 'بڕێکی دروست بە دۆلار بنووسە، تا شەش ژمارەی دەهەمی.')
        : error ? contractRefusal(error, refusalLang(lang), error instanceof Error ? error.message : String(error)) : '';
  return (
    <div data-procurement-inline-pricing>
      <PricingSummaryBar summary={summary} label={line.label} busy={pending} fields={{
        cost: field('final_cost_usd', loc('التكلفة النهائية', 'Final cost', 'تێچووی کۆتایی'), latest?.final_cost_usd),
        profit: field('minimum_profit_usd', loc('الحد الأدنى للربح', 'Minimum profit', 'کەمترین قازانج'), latest?.minimum_profit_usd),
        price: result?.customer_price_iqd ?? null,
      }} />
      <p className={`mt-2 text-xs ${T.text3}`}>{loc('عدّل التكلفة أو الربح بالدولار ثم احفظ السعر. تكلفة الشحنة المحاسبية تبقى حسب بيانات الشراء أعلاه.', 'Edit cost or profit in USD, then save the price. The shipment’s accounting cost follows the purchase fields above.', 'تێچوو یان قازانج بە دۆلار دەستکاری بکە، پاشان نرخەکە پاشەکەوت بکە. تێچووی ژمێریاریی بارەکە بەپێی زانیاریی کڕینی سەرەوەیە.')}</p>
      {result?.preview.method === 'usd' && <p className={`mt-1 text-xs ${T.text3}`}>{loc('هذا المنتج يستخدم سعر بيع ثابتاً؛ تغيير التكلفة أو الربح يحافظ على قاعدة تسعيره.', 'This product uses a fixed selling price; cost and profit edits preserve its pricing method.', 'ئەم بەرهەمە نرخی فرۆشتنی جێگیری هەیە؛ دەستکاریکردنی تێچوو و قازانج شێوازی نرخدانەکە دەپارێزێت.')}</p>}
      {dirty && result && !result.preview.complete && <p role="status" className={`mt-2 text-sm ${T.text2}`}>{loc('يمكن حفظ البيانات، لكن السعر يحتاج استكمال بيانات التسعير.', 'You can save these inputs, but pricing still needs more information.', 'دەتوانیت ئەم زانیارییانە پاشەکەوت بکەیت، بەڵام نرخدان زانیاریی زیاتر دەوێت.')}</p>}
      {dirty && result && (result.preview.changes?.length ?? 0) > 0 && <details className={`mt-2 text-xs ${T.text2}`}>
        <summary>{loc('تغييرات الأسعار', 'Price changes', 'گۆڕانکاریی نرخەکان')} ({result.preview.changes!.length})</summary>
        <ul>{result.preview.changes!.map((r) => <li key={`${r.combo_key}:${r.channel}`} dir="auto">{lang === 'en' ? r.names.en : lang === 'ckb' ? r.names.ckb || r.names.en : r.names.ar} · {r.channel}: <bdi dir="ltr">{r.old_iqd === null ? '—' : money(r.old_iqd)} → {r.new_iqd === null ? '—' : money(r.new_iqd)}</bdi></li>)}</ul>
      </details>}
      {confirmRequired && <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmedKey === requestKey} onChange={(e) => setConfirmedKey(e.target.checked ? requestKey : '')} />{loc('أؤكد تغيير السعر بأكثر من 15%', 'I confirm a price change above 15%', 'گۆڕانی نرخ بە زیاتر لە 15% پشتڕاست دەکەمەوە')}</label>}
      {errorText && <p role="alert" className="mt-2 text-sm text-[var(--ap-danger)]">{errorText}</p>}
      {saved && !dirty && <p role="status" className={`mt-2 text-sm ${T.text2}`}>{loc('تم حفظ تعديلات التسعير.', 'Pricing edits saved.', 'دەستکارییەکانی نرخدان پاشەکەوت کران.')}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {(dirty || result?.cost_from_purchase) && <button type="button" className={T.btnPrimary} disabled={saving || !result || (!!confirmRequired && confirmedKey !== requestKey)} onClick={save}>{saving ? loc('جارٍ الحفظ…', 'Saving…', 'پاشەکەوت دەکرێت…') : loc('حفظ التكلفة والربح والسعر', 'Save cost, profit and price', 'پاشەکەوتکردنی تێچوو، قازانج و نرخ')}</button>}
        {dirty && <button type="button" className={T.btnGhost} disabled={saving} onClick={() => { onChange({}); setError(null); setConfirmedKey(''); }}>{loc('تراجع', 'Discard edits', 'پاشگەزبوونەوە')}</button>}
        <button type="button" className={T.btnGhost} disabled={saving || dirty} onClick={onAdvanced}>{loc('إعدادات التسعير', 'Pricing settings', 'ڕێکخستنەکانی نرخدان')}</button>
      </div>
    </div>
  );
}
