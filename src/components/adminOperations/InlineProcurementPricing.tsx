import { useEffect, useId, useState } from 'react';
import { api, ApiError, isAborted } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { contractRefusal, refusalLang } from '../../lib/refusalStrings';
import { UsdInput } from '../adminProducts/form/v2/v2Ui';
import type { V2Answer, V2DraftWire } from '../adminProducts/form/v2/v2Model';
import PricingSummaryBar from './PricingSummaryBar';
import InlineSaleDiscount from './InlineSaleDiscount';
import type { PricingSummary } from './procurementPricing';
import { money, T, type Selection } from './shared';

export type InlinePriceDraft = { final_cost_usd?: string; minimum_profit_usd?: string; customer_price_usd?: string };
type PriceSelection = Pick<Selection, 'product_id' | 'scope' | 'scope_id' | 'label'> & Partial<Pick<Selection, 'option_id' | 'color_id'>>;
export const inlinePriceKey = (line: PriceSelection) => `${line.product_id}:${line.scope}:${line.scope_id}`;
/** `keepCost` (DECISIONS row 273): a final cost the owner typed and saved for this very shipment stays the cost,
 * instead of the landed cost of the shipment, until the shipment itself changes. */
export const inlinePricingRequestKey = (line: PriceSelection, draft: Record<string, unknown> | null, value: InlinePriceDraft, revision: number, keepCost = false) =>
  JSON.stringify([{ product_id: line.product_id, scope: line.scope, scope_id: line.scope_id, ...(draft ? { draft } : {}), ...(draft && keepCost ? { keep_cost: true } : {}), ...value }, revision]);
export type InlinePriceQuote = { requestKey: string; price: number | null };
export const currentInlinePrice = (quote: InlinePriceQuote | undefined, requestKey: string): number | null =>
  quote?.requestKey === requestKey && typeof quote.price === 'number' && Number.isFinite(quote.price) ? quote.price : null;
interface LinePrice {
  pricing: V2DraftWire;
  preview: V2Answer;
  final_cost_usd: string | null;
  minimum_profit_usd: string | null;
  customer_price_usd: string | null;
  customer_price_iqd: number | null;
  profit_scope: 'product' | 'option' | 'color' | 'sku';
  cost_from_purchase: boolean;
  /** DECISIONS row 273: the final cost is the landed unit cost of this shipment at its dollar rate (absent from an older server). */
  shipment?: { landed_cost_iqd: string; usd_iqd: string; final_cost_usd: string } | null;
}

export default function InlineProcurementPricing({ line, purchaseDraft, value, onChange, onSaved, revision, summary, onAdvanced, readOnly = false, onQuote, keepCost = false }: {
  line: PriceSelection;
  purchaseDraft: Record<string, unknown> | null;
  value: InlinePriceDraft;
  onChange: (value: InlinePriceDraft) => void;
  /** Receives the edits that were saved (a typed final cost among them, or not). */
  onSaved: (saved: InlinePriceDraft) => void;
  keepCost?: boolean;
  revision: number;
  summary: PricingSummary | null;
  onAdvanced: () => void;
  readOnly?: boolean;
  onQuote?: (selectionKey: string, quote: InlinePriceQuote) => void;
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
    && (value.minimum_profit_usd === undefined || value.minimum_profit_usd === '' || /^(?:\d+)(?:\.\d{1,6})?$/.test(value.minimum_profit_usd))
    && (value.customer_price_usd === undefined || /^(?:\d+)(?:\.\d{1,6})?$/.test(value.customer_price_usd));
  const requestKey = inlinePricingRequestKey(line, purchaseDraft, value, revision, keepCost);
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
  }, [requestKey, valid, attempt]);
  const result = answer?.key === requestKey && valid ? answer.data : null;
  const selectionKey = inlinePriceKey(line);
  const price = result?.customer_price_iqd ?? null;
  useEffect(() => { onQuote?.(selectionKey, { requestKey, price }); }, [onQuote, selectionKey, requestKey, price]);
  const answeredSelection = answer ? JSON.parse(answer.key)[0] as Selection : null;
  const latest = answeredSelection?.product_id === line.product_id && answeredSelection.scope === line.scope && answeredSelection.scope_id === line.scope_id ? answer?.data : null;
  const pending = !result && !error && valid;
  const confirmRequired = result?.preview.large_change || result?.preview.drop_flag;
  const change = (field: keyof InlinePriceDraft, text: string) => {
    setError(null); setSaved(false); setConfirmedKey('');
    const next = { ...value, [field]: text };
    // The last edited amount drives the preview; never send two competing targets.
    if (field === 'customer_price_usd') delete next.minimum_profit_usd;
    if (field === 'minimum_profit_usd') delete next.customer_price_usd;
    onChange(next);
  };
  const field = (key: keyof InlinePriceDraft, label: string, fallback: string | null | undefined) => (
    <UsdInput id={`${id}-${key}`} label={`${label} (USD) · ${line.label}`} placeholder="—" disabled={saving}
      value={value[key] ?? fallback ?? ''} onChange={(text) => change(key, text)} data={key} />
  );
  const save = async () => {
    if (!result || saving) return;
    setSaving(true); setError(null);
    try {
      await api.put(`/api/admin/products-v2/${encodeURIComponent(line.product_id)}/pricing`, {
        pricing: result.pricing, seq: result.preview.seq, preview_hash: result.preview.review_hash,
        procurement_stock: { scope: line.scope, scope_id: line.scope_id },
        ...(confirmedKey === requestKey ? { confirm_large_change: true } : {}),
      });
      setSaved(true);
      onSaved(value);
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
      : invalidField === 'customer_price_usd_requires_cost'
        ? loc('أكمل التكلفة أولاً لحساب الربح من سعر الزبون.', 'Complete the cost before calculating profit from the customer price.', 'سەرەتا تێچوو تەواو بکە بۆ ژماردنی قازانج لە نرخی کڕیار.')
      : invalidField === 'customer_price_usd_below_cost'
        ? loc('سعر الزبون يجب أن يتجاوز التكلفة وفروق الخيارات ليبقى الربح موجبًا.', 'The customer price must exceed cost and option adjustments to keep a positive profit.', 'نرخی کڕیار دەبێت لە تێچوو و جیاوازیی هەڵبژاردەکان زیاتر بێت بۆ قازانجی ئەرێنی.')
      : invalidField === 'customer_price_usd_conflicts'
        ? loc('توجد قاعدة سعر خاصة تتعارض مع هذا المبلغ. راجع إعدادات التسعير.', 'A specific pricing rule conflicts with this amount. Review the pricing settings.', 'یاسایەکی تایبەتی نرخدان لەگەڵ ئەم بڕە ناکۆکە. ڕێکخستنەکانی نرخدان بپشکنە.')
      : invalidField === 'final_cost_usd' || invalidField === 'minimum_profit_usd' || invalidField === 'customer_price_usd'
        ? loc('أدخل مبلغاً صالحاً بالدولار، حتى ست خانات عشرية.', 'Enter a valid USD amount with up to six decimal places.', 'بڕێکی دروست بە دۆلار بنووسە، تا شەش ژمارەی دەهەمی.')
        : error ? contractRefusal(error, refusalLang(lang), error instanceof Error ? error.message : String(error)) : '';
  // Review uses the exact same V2 quote as step 3. A selected SKU can be priced
  // while another SKU still blocks publishing the product; never substitute a
  // missing product-wide published price for this saved selection's quote.
  if (readOnly) return <div data-procurement-price-review>
    <PricingSummaryBar summary={summary} label={line.label} busy={pending} onEdit={onAdvanced} fields={{
      cost: result?.final_cost_usd ? `$${result.final_cost_usd}` : '—',
      profit: result?.minimum_profit_usd ? `$${result.minimum_profit_usd}` : '—',
      customerUsd: result?.customer_price_usd ? `$${result.customer_price_usd}` : '—',
      price,
    }} />
    {result && <p role="status" className={`mt-2 text-xs ${T.text3}`}>{dirty || result.cost_from_purchase
      ? loc('هذه معاينة لتعديلات لم تُحفظ بعد. ارجع إلى التكاليف والشحن لحفظها.', 'This previews unsaved edits. Return to Costs and shipping to save them.', 'ئەمە پێشبینیی دەستکارییە پاشەکەوتنەکراوەکانە. بگەڕێوە بۆ تێچوو و ناردن بۆ پاشەکەوتکردن.')
      : result.preview.complete
      ? loc('سعر الخيار المحسوب من بيانات التسعير الحالية؛ يُستخدم لتقدير الربح.', 'The selection price calculated from current pricing inputs is used to estimate profit.', 'نرخی هەڵبژاردە لە زانیارییەکانی ئێستای نرخدانەوە ژمێردراوە و بۆ خەمڵاندنی قازانج بەکاردێت.')
      : loc('نشر سعر المنتج ينتظر استكمال بيانات التسعير من الإعدادات. سعر الخيار، إن ظهر، يبقى معاينة لتقدير الربح.', 'Publishing the product price requires completing its pricing settings. Any displayed selection price remains a preview for estimating profit.', 'بڵاوکردنەوەی نرخی بەرهەم پێویستی بە تەواوکردنی ڕێکخستنەکانی نرخدان هەیە. نرخی پیشاندراوی هەڵبژاردە تەنها پێشبینییە بۆ خەمڵاندنی قازانج.')}</p>}
    {errorText && <p role="alert" className="mt-2 text-sm text-[var(--ap-danger)]">{errorText}</p>}
  </div>;
  return (
    <div data-procurement-inline-pricing>
      <PricingSummaryBar summary={summary} label={line.label} busy={pending} fields={{
        cost: field('final_cost_usd', loc('التكلفة النهائية', 'Final cost', 'تێچووی کۆتایی'), latest?.final_cost_usd),
        profit: field('minimum_profit_usd', loc('الحد الأدنى للربح', 'Minimum profit', 'کەمترین قازانج'), latest?.minimum_profit_usd),
        customerUsd: field('customer_price_usd', loc('السعر النهائي للزبون', 'Final customer price', 'نرخی کۆتایی کڕیار'), latest?.customer_price_usd),
        price: result?.customer_price_iqd ?? null,
      }} />
      <p className={`mt-2 text-xs ${T.text3}`}>{loc('عدّل التكلفة أو الربح أو سعر الزبون بالدولار ثم احفظ. في التسعير حسب التكلفة، تعديل سعر الزبون يعيد حساب الربح. يظهر سعر الدينار بعد التقريب المعتمد. تكلفة الشحنة المحاسبية تبقى حسب بيانات الشراء أعلاه.', 'Edit cost, profit or customer price in USD, then save. Cost-based pricing recalculates profit when you edit the customer price. IQD reflects the configured rounding. The shipment’s accounting cost follows the purchase fields above.', 'تێچوو، قازانج یان نرخی کڕیار بە دۆلار دەستکاری بکە و پاشەکەوت بکە. لە نرخدانی بەپێی تێچوو، گۆڕینی نرخی کڕیار قازانج دووبارە دەژمێرێتەوە. نرخی دینار بەپێی خڕکردنەوەکەیە. تێچووی ژمێریاریی بارەکە بەپێی زانیاریی کڕینی سەرەوەیە.')}</p>
      <InlineSaleDiscount productId={line.product_id} label={line.label} revision={revision} onAdvanced={onAdvanced}
        modelId={line.scope === 'option' ? line.scope_id : line.option_id ?? null} colorId={line.scope === 'color' ? line.scope_id : line.color_id ?? null} />
      {result?.shipment && value.final_cost_usd === undefined && <p className={`mt-1 text-xs ${T.text2}`} data-procurement-shipment-cost>{loc(
        `التكلفة النهائية هي تكلفة هذه الشحنة: ${money(Number(result.shipment.landed_cost_iqd))} للقطعة ÷ ${result.shipment.usd_iqd} د.ع للدولار = $${result.shipment.final_cost_usd}. تتحدث مع سعر الصرف والشحن والكمية والسعر الخام والمصاريف.`,
        `Final cost is this shipment’s cost: ${money(Number(result.shipment.landed_cost_iqd))} per unit ÷ ${result.shipment.usd_iqd} IQD per USD = $${result.shipment.final_cost_usd}. It follows the exchange rate, freight, quantity, raw price and charges.`,
        `تێچووی کۆتایی تێچووی ئەم بارەیە: ${money(Number(result.shipment.landed_cost_iqd))} بۆ هەر پارچەیەک ÷ ${result.shipment.usd_iqd} د.ع بۆ هەر دۆلارێک = $${result.shipment.final_cost_usd}. لەگەڵ نرخی ئاڵوگۆڕ، ناردن، بڕ، نرخی خاو و خەرجییەکان نوێ دەبێتەوە.`,
      )}</p>}
      {result?.preview.method === 'usd' && <p className={`mt-1 text-xs ${T.text3}`}>{loc('هذا المنتج يستخدم سعر بيع ثابتاً؛ تغيير التكلفة أو الربح يحافظ على قاعدة تسعيره.', 'This product uses a fixed selling price; cost and profit edits preserve its pricing method.', 'ئەم بەرهەمە نرخی فرۆشتنی جێگیری هەیە؛ دەستکاریکردنی تێچوو و قازانج شێوازی نرخدانەکە دەپارێزێت.')}</p>}
      {result && !result.preview.complete && <p role="status" className={`mt-2 text-sm ${T.text2}`}>{loc('سعر هذا الخيار معاينة. يمكن حفظ بياناته، لكن نشر المنتج ينتظر استكمال بيانات بقية خياراته من إعدادات التسعير.', 'This selection’s price is a preview. Its inputs can be saved, but publishing requires completing the remaining pricing inputs in Pricing settings.', 'نرخی ئەم هەڵبژاردەیە پێشبینییە. زانیارییەکانی پاشەکەوت دەکرێن، بەڵام بڵاوکردنەوە پێویستی بە تەواوکردنی زانیارییە ماوەکانی نرخدان هەیە لە ڕێکخستنەکانی نرخدان.')}</p>}
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
