import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { UsdInput } from '../adminProducts/form/v2/v2Ui';
import { draftFrom, previewAnswerOf, saveBodyOf, type DiscountDraft, type DiscountReadWire, type Issue, type OfferWire, type PreviewRowWire } from '../adminProducts/form/productDiscountWire';
import { money, T } from './shared';

/**
 * «السعر بعد الخصم ($)» IN THE PURCHASE LINE CARD (DECISIONS row 273; the owner, 2026-10-27): the sale price
 * of this model after a discount, written to the SAME offer row as the product form section «تخفيض السعر»
 * (`GET /api/admin/offers/:id`, its preview and `PUT`, with the stamp it read), so its rules are the same:
 * dollars rounded to dinars by the door, the warnings below cost and below the minimum profit, open-ended
 * unless the row has dates. The row keeps every other model, date, tier and limit as stored. A product on a
 * percent or a dinar sale is edited from its own section, never switched from here.
 */
interface ReadAnswer {
  offer: OfferWire | null;
  discount: DiscountReadWire;
}

/** The draft this card writes: the stored row with this model's dollar price set (or the whole product's). */
export function inlineSaleDraft(offer: OfferWire | null, read: DiscountReadWire, modelId: string | null, usd: string): DiscountDraft | null {
  const base = draftFrom(offer, read);
  const perModel = read.usd.scopes.includes('model') && !!modelId && read.models.some((m) => m.model_id === modelId);
  const scope: DiscountDraft['scope'] = offer && base.scope === 'product' && base.usdWhole ? 'product' : perModel ? 'model' : read.usd.scopes.includes('product') ? 'product' : 'model';
  if (scope === 'model' && !perModel) return null;
  return scope === 'model'
    ? { ...base, mode: 'usd', scope, usdByModel: { ...base.usdByModel, [modelId!]: usd } }
    : { ...base, mode: 'usd', scope, usdWhole: usd };
}

/** The stored dollar price of this model (or of the whole product), for the field's first value. */
export function inlineSaleValue(offer: OfferWire | null, modelId: string | null): string {
  const set = offer?.offer_price_mode === 'fixed_usd' ? (offer.offer_usd_prices ?? []) : [];
  return set.find((p) => modelId && p.model_id === modelId)?.usd ?? set.find((p) => p.model_id === '')?.usd ?? '';
}

const issueText = (i: Issue, lang: string) => (lang === 'ar' ? i.ar : lang === 'ckb' ? i.ckb : i.en) || i.message || i.code;
const issuesOf = (e: unknown): Issue[] => {
  if (e instanceof ApiError) {
    const listed = (e.details?.errors as Issue[] | undefined) ?? null;
    return listed && listed.length ? listed : [{ code: e.code ?? 'ERROR', message: e.message }];
  }
  return [{ code: 'ERROR', message: e instanceof Error ? e.message : String(e) }];
};

export default function InlineSaleDiscount({ productId, modelId, colorId, label, revision, onAdvanced }: {
  productId: string;
  /** The model (option) this purchase line is; null for a product without models. */
  modelId: string | null;
  colorId?: string | null;
  label: string;
  revision: number;
  onAdvanced: () => void;
}) {
  const { lang, loc } = useLanguage();
  const id = useId();
  const [answer, setAnswer] = useState<ReadAnswer | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewRowWire[] | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const load = useCallback(async () => {
    const res = await api.get<ReadAnswer>(`/api/admin/offers/${encodeURIComponent(productId)}`, { mascot: 'silent' });
    setAnswer(res);
    setValue(null);
  }, [productId]);
  useEffect(() => { void load().catch((e) => setIssues(issuesOf(e))); }, [load, revision]);
  const read = answer?.discount ?? null;
  const offer = answer?.offer ?? null;
  const stored = inlineSaleValue(offer, modelId);
  const typed = value ?? stored;
  const otherMode = !!offer && offer.offer_price_mode !== 'fixed_usd';
  const draft = read && read.published && read.usd.available && !otherMode && typed.trim() ? inlineSaleDraft(offer, read, modelId, typed.trim()) : null;
  const body = draft ? JSON.stringify(saveBodyOf(offer, draft)) : '';
  useEffect(() => {
    if (!body) { setPreview(null); return; }
    const controller = new AbortController();
    const t = setTimeout(() => {
      api.post<{ rows?: PreviewRowWire[]; issues?: Issue[]; warnings?: Issue[]; refused?: boolean }>(`/api/admin/offers/${encodeURIComponent(productId)}/preview`, JSON.parse(body), { signal: controller.signal, mascot: 'silent' })
        .then((res) => { const shown = previewAnswerOf(res); setPreview(shown.preview); setIssues(shown.issues); })
        .catch(() => { if (!controller.signal.aborted) setPreview(null); });
    }, 400);
    return () => { clearTimeout(t); controller.abort(); };
  }, [body, productId]);
  if (!read || read.composition) return null;
  // The direct-sale row of this model (this colour when it has its own), the price the customer pays.
  const rows = (preview ?? []).filter((r) => r.channel === 'direct_sale' && (!modelId || r.model_id === modelId));
  const row = rows.find((r) => colorId && r.combo_key.includes(colorId)) ?? rows[0] ?? null;
  const before = read.rows.find((r) => r.channel === 'direct_sale' && (!modelId || r.model_id === modelId) && (!colorId || r.combo_key.includes(colorId))) ?? read.rows.find((r) => r.channel === 'direct_sale' && (!modelId || r.model_id === modelId));
  const save = async () => {
    if (!draft) return;
    setBusy(true); setIssues([]); setNote('');
    try {
      await api.put(`/api/admin/offers/${encodeURIComponent(productId)}`, saveBodyOf(offer, draft));
      setNote(loc('حُفظ التخفيض. يظهر للزبون بالسعر بعد الخصم.', 'Sale price saved. Customers see the price after discount.', 'داشکاندنەکە پاشەکەوت کرا. کڕیار نرخی دوای داشکاندن دەبینێت.'));
      await load();
    } catch (e) {
      setIssues(issuesOf(e));
      if (e instanceof ApiError && e.code === 'SPECIAL_OFFER_CHANGED') await load().catch(() => undefined);
    } finally { setBusy(false); }
  };
  const blocked = !read.published
    ? loc('انشر أسعار المنتج أولًا؛ يُحسب الخصم من السعر المنشور.', 'Publish the product prices first; the discount is taken from the published price.', 'سەرەتا نرخەکانی بەرهەم بڵاو بکەرەوە؛ داشکاندن لە نرخی بڵاوکراوە هەژمار دەکرێت.')
    : otherMode
      ? loc('على هذا المنتج تخفيض بنسبة أو بالدينار. عدّله من «تخفيض السعر» في إعدادات التسعير.', 'This product has a percent or dinar sale. Edit it under Sale price in the pricing settings.', 'ئەم بەرهەمە داشکاندنی ڕێژەیی یان بە دیناری هەیە. لە «داشکاندنی نرخ» لە ڕێکخستنەکانی نرخدان دەستکاری بکە.')
      : !read.usd.available
        ? loc('السعر بعد الخصم بالدولار غير متاح لهذا المنتج؛ استعمل نسبة الخصم من «تخفيض السعر» في إعدادات التسعير.', 'A USD price after discount is not available for this product; use a percent under Sale price in the pricing settings.', 'نرخی دوای داشکاندن بە دۆلار بۆ ئەم بەرهەمە بەردەست نییە؛ ڕێژەی داشکاندن لە «داشکاندنی نرخ» لە ڕێکخستنەکانی نرخدان بەکاربهێنە.')
        : '';
  const dirty = value !== null && value.trim() !== stored;
  return (
    <div className="mt-3 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-3" data-procurement-sale-discount>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-end">
        <label className="grid gap-1 text-[12px] text-[var(--ap-text-3)]" htmlFor={`${id}-sale`}>
          <span>{loc('السعر بعد الخصم ($)', 'Price after discount ($)', 'نرخ دوای داشکاندن ($)')} <span className={T.text3}>{loc('(اختياري)', '(optional)', '(ئارەزوومەندانە)')}</span></span>
          <UsdInput id={`${id}-sale`} label={`${loc('السعر بعد الخصم ($)', 'Price after discount ($)', 'نرخ دوای داشکاندن ($)')} · ${label}`} placeholder="—" disabled={busy || !!blocked} value={typed} onChange={(v) => { setValue(v); setNote(''); }} data="sale_price_usd" />
        </label>
        <p className="text-[13px] text-[var(--ap-text-2)] tabular-nums" aria-live="polite" data-sale-after>
          {loc('الآن (قبل الخصم)', 'Now (before discount)', 'ئێستا (پێش داشکاندن)')}: <bdi dir="ltr">{before ? money(before.before_iqd) : '—'}</bdi>
          {' · '}
          {loc('للزبون بعد الخصم', 'Customer price after discount', 'نرخی کڕیار دوای داشکاندن')}: <strong className="text-[var(--ap-text-1)]"><bdi dir="ltr">{row?.after_iqd != null && row.state === 'lowered' ? money(row.after_iqd) : '—'}</bdi></strong>
        </p>
      </div>
      {blocked && <p className={`mt-2 text-xs ${T.text3}`}>{blocked}</p>}
      {row && row.state === 'not_lower' && <p role="status" className={`mt-2 text-xs ${T.text2}`}>{loc('ليس أقل من السعر الحالي — لا يظهر خصم.', 'Not below the current price: no discount shows.', 'لە نرخی ئێستا کەمتر نییە: هیچ داشکاندنێک دەرناکەوێت.')}</p>}
      {row?.owner?.below_cost && <p role="alert" className="mt-2 text-xs text-[var(--ap-danger)]" data-sale-warning="below-cost">{loc('تحت التكلفة', 'Below cost', 'لە خوار تێچوو')}</p>}
      {!row?.owner?.below_cost && row?.owner?.below_min_profit && <p role="alert" className="mt-2 text-xs text-[var(--ap-warning)]" data-sale-warning="below-min-profit">{loc('تحت الحد الأدنى للربح', 'Below the minimum profit', 'لە خوار کەمترین قازانج')}</p>}
      {issues.length > 0 && <p role="alert" className="mt-2 text-xs text-[var(--ap-danger)]">{issues.map((i) => issueText(i, lang)).join(lang === 'en' ? '; ' : '؛ ')}</p>}
      {note && <p role="status" className={`mt-2 text-xs ${T.text2}`}>{note}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {!blocked && dirty && <button type="button" className={T.btnSecondary} disabled={busy || !draft} onClick={() => void save()}>{busy ? loc('جارٍ الحفظ…', 'Saving…', 'پاشەکەوت دەکرێت…') : loc('حفظ التخفيض', 'Save sale price', 'پاشەکەوتکردنی داشکاندن')}</button>}
        {dirty && <button type="button" className={T.btnGhost} disabled={busy} onClick={() => { setValue(null); setIssues([]); }}>{loc('تراجع', 'Discard edits', 'پاشگەزبوونەوە')}</button>}
        {(blocked || offer) && <button type="button" className={T.btnGhost} onClick={onAdvanced}>{loc('التواريخ والإعدادات الأخرى', 'Dates and other settings', 'بەروار و ڕێکخستنەکانی تر')}</button>}
      </div>
    </div>
  );
}
