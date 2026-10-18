/**
 * «● تكلفة شراء جديدة بانتظار مراجعتك» — D1 IN SECTION ٣ (the clean start,
 * addendum A.10; DECISIONS rows 221 D1, 222 and 247). Owner-only.
 *
 * Every confirmed stock purchase of the product leaves its own pending review
 * (row 247: one per purchase — purchases of different models or colours never
 * erase each other), listed oldest first. Each names its purchase and the
 * inputs it carries per level — the product, a model, a colour or a variant
 * exactly as bought: the supplier price and its currency, the shipping weight,
 * the CBM and the extra cost — and the colours or variants whose own cost it
 * will not reach. The owner previews each price change (the server's sheet:
 * the changed prices, the 15% tick), applies it — one batch: inputs, prices,
 * history — or keeps the current cost. Every figure is the server's; nothing
 * is computed here.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatIqd } from '../../../../lib/api';
import { useLanguage } from '../../../../LanguageContext';
import { Button } from '../../../ui/Button';
import { channelName, useV2Lang } from './v2Ui';
import type { V2Channel } from './v2Model';

type Names = { ar: string; en: string; ckb: string };
interface ReviewInput {
  scope: string;
  scope_id: string;
  name?: Names | null;
  fields: Record<string, string | number | null>;
  iqd?: { original_input_amount: string; conversion_rate_snapshot: string } | null;
}
interface Shadowed {
  scope: string;
  scope_id: string;
  field: string;
  by: Array<{ scope: string; scope_id: string; name?: Names | null }>;
}
interface Review {
  id: string;
  purchase_id: string;
  purchase_name?: string | null;
  state: string;
  created_at: string;
  inputs: ReviewInput[];
  shadowed?: Shadowed[];
}
interface Change {
  combo_key: string;
  names: Names;
  channel: string;
  old_iqd: number | null;
  new_iqd: number | null;
  change_percent: number | null;
  large: boolean;
}
interface Preview {
  review_hash: string | null;
  large_change: boolean;
  drop_flag: boolean;
  changes: Change[];
  complete: boolean;
}

const T = {
  chip: { ar: '● تكلفة شراء جديدة بانتظار مراجعتك', en: '● A new purchase cost awaits your review', ckb: '● تێچووی کڕینێکی نوێ چاوەڕێی پێداچوونەوەتە' },
  review: { ar: 'راجع السعر الجديد', en: 'Review the new price', ckb: 'نرخە نوێیەکە ببینە' },
  keep: { ar: 'أبقِ التكلفة الحالية', en: 'Keep the current cost', ckb: 'تێچووی ئێستا بهێڵەرەوە' },
  apply: { ar: 'اعتمد التكلفة والأسعار', en: 'Apply the cost and prices', ckb: 'تێچوو و نرخەکان پەسەند بکە' },
  noChange: { ar: 'لا يتغير أي سعر للزبون — تُحفظ التكلفة الجديدة فقط.', en: 'No customer price changes — only the new cost is saved.', ckb: 'هیچ نرخێکی کڕیار ناگۆڕێت — تەنها تێچووە نوێیەکە پاشەکەوت دەکرێت.' },
  large: { ar: 'أؤكد تغيّرًا يتجاوز 15%', en: 'I confirm a change above 15%', ckb: 'گۆڕانێکی سەروو 15% پشتڕاست دەکەمەوە' },
  applied: { ar: 'تم اعتماد تكلفة الشراء.', en: 'The purchase cost was applied.', ckb: 'تێچووی کڕین پەسەند کرا.' },
  kept: { ar: 'أُبقيت التكلفة الحالية.', en: 'The current cost was kept.', ckb: 'تێچووی ئێستا هێڵرایەوە.' },
  from: { ar: 'من الشراء', en: 'From purchase', ckb: 'لە کڕینەوە' },
  levelBase: { ar: 'المنتج', en: 'Product', ckb: 'بەرهەم' },
  levelOption: { ar: 'الموديل', en: 'Model', ckb: 'مۆدێل' },
  levelColor: { ar: 'اللون', en: 'Colour', ckb: 'ڕەنگ' },
  levelSku: { ar: 'التركيبة', en: 'Variant', ckb: 'تێکەڵە' },
  supplier: { ar: 'سعر المورد', en: 'Supplier price', ckb: 'نرخی دابینکەر' },
  weight: { ar: 'وزن الشحن (غ)', en: 'Shipping weight (g)', ckb: 'کێشی بارکردن (گ)' },
  cbm: { ar: 'الحجم CBM', en: 'Volume CBM', ckb: 'قەبارە CBM' },
  additional: { ar: 'تكلفة إضافية (د.ع)', en: 'Additional cost (IQD)', ckb: 'تێچووی زیادە (د.ع)' },
  converted: { ar: 'محوَّل مرة واحدة من الدينار', en: 'Converted once from dinars', ckb: 'یەک جار لە دینارەوە گۆڕدراوە' },
  shadowFrom: { ar: 'لن تصل هذه التكلفة إلى:', en: 'This cost will not reach:', ckb: 'ئەم تێچووە ناگاتە:' },
  shadowWhy: { ar: '— لها تكلفة خاصة', en: '— they have their own cost', ckb: '— تێچووی تایبەتی خۆیان هەیە' },
} as const;
type Key = keyof typeof T;

const LEVEL: Readonly<Record<string, Key>> = { base: 'levelBase', option: 'levelOption', color: 'levelColor', sku: 'levelSku' };

function useText() {
  const { lang } = useLanguage();
  const t = (k: Key) => (lang === 'en' ? T[k].en : lang === 'ckb' ? T[k].ckb : T[k].ar);
  // A Sorani slot never shows the Arabic (DECISIONS row 183): an empty one reads the English.
  const nameOf = (n: Names | null | undefined) => (n ? (lang === 'en' ? n.en || n.ar : lang === 'ckb' ? n.ckb || n.en : n.ar || n.en) : '');
  return { t, nameOf };
}

export default function PurchaseReviewCard({ productId, onApplied }: { productId: string; onApplied: () => void }) {
  const { t } = useText();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [note, setNote] = useState('');
  const base = `/api/admin/products-v2/${encodeURIComponent(productId)}/purchase-review`;

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ purchase_reviews?: Review[]; purchase_review: Review | null }>(base, { mascot: 'silent' });
      const list = r.purchase_reviews ?? (r.purchase_review ? [r.purchase_review] : []);
      setReviews(list.filter((x) => x.state === 'pending'));
    } catch {
      setReviews([]);
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const done = (id: string, k: 'applied' | 'kept') => {
    setNote(t(k));
    setReviews((list) => list.filter((x) => x.id !== id));
    if (k === 'applied') onApplied();
  };

  if (!reviews.length) return note ? <p className="mb-3 text-[12px] text-text-secondary" role="status">{note}</p> : null;
  return (
    <div className="mb-3 space-y-2" data-v2-purchase-reviews={reviews.length}>
      {note ? (
        <p className="text-[12px] text-text-secondary" role="status">
          {note}
        </p>
      ) : null}
      {reviews.map((r) => (
        <ReviewItem key={r.id} review={r} base={base} onDone={(k) => done(r.id, k)} />
      ))}
    </div>
  );
}

function ReviewItem({ review, base, onDone }: { review: Review; base: string; onDone: (k: 'applied' | 'kept') => void }) {
  const { t, nameOf } = useText();
  const v2Lang = useV2Lang();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tick, setTick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      const p = e instanceof ApiError ? (e.details?.preview as Preview | undefined) : undefined;
      if (p) setPreview(p);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const levelOf = (scope: string, name: Names | null | undefined) => `${t(LEVEL[scope] ?? 'levelBase')}${name ? ` · ${nameOf(name)}` : ''}`;
  // The levels whose own cost the purchase will not reach, each named once.
  const shadowedBy = [...new Map((review.shadowed ?? []).flatMap((s) => s.by).map((b) => [`${b.scope}:${b.scope_id}`, b] as const)).values()];

  return (
    <section className="lv-alert lv-alert-info space-y-2 px-3 py-2 text-[12px] text-text-primary" data-v2-purchase-review={review.id}>
      <p className="font-bold">{t('chip')}</p>
      <p className="text-text-secondary">
        {t('from')} <span dir="auto">{review.purchase_name || review.purchase_id}</span>
      </p>
      <ul className="space-y-1" data-v2-purchase-review-inputs>
        {review.inputs.map((i) => (
          <li key={`${i.scope}:${i.scope_id}`} className="min-w-0">
            <span className="font-semibold" dir="auto">
              {levelOf(i.scope, i.name)}
            </span>
            <span className="flex flex-wrap gap-x-3 text-text-secondary">
              {i.fields.supplier_cost_amount != null ? (
                <span>
                  {t('supplier')}{' '}
                  <span dir="ltr">
                    {String(i.fields.supplier_cost_amount)} {String(i.fields.supplier_cost_currency ?? '')}
                  </span>
                  {i.iqd ? (
                    <span className="text-text-muted">
                      {' '}
                      ({t('converted')}{' '}
                      <span dir="ltr">
                        {formatIqd(Number(i.iqd.original_input_amount))} ÷ {i.iqd.conversion_rate_snapshot}
                      </span>
                      )
                    </span>
                  ) : null}
                </span>
              ) : null}
              {i.fields.shipping_weight_g != null ? (
                <span>
                  {t('weight')} <span dir="ltr">{String(i.fields.shipping_weight_g)}</span>
                </span>
              ) : null}
              {i.fields.manual_cbm != null ? (
                <span>
                  {t('cbm')} <span dir="ltr">{String(i.fields.manual_cbm)}</span>
                </span>
              ) : null}
              {i.fields.additional_cost_iqd != null ? (
                <span>
                  {t('additional')} <span dir="ltr">{formatIqd(Number(i.fields.additional_cost_iqd))}</span>
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {shadowedBy.length ? (
        <p className="text-text-secondary" data-v2-purchase-review-shadowed>
          {t('shadowFrom')} <span dir="auto">{shadowedBy.map((b) => levelOf(b.scope, b.name)).join(' ، ')}</span> {t('shadowWhy')}
        </p>
      ) : null}
      {preview ? (
        <div className="space-y-2" data-v2-purchase-review-preview>
          {preview.changes.length === 0 ? (
            <p>{t('noChange')}</p>
          ) : (
            <ul className="space-y-1">
              {preview.changes.map((c) => (
                <li key={`${c.combo_key}|${c.channel}`} className="flex min-w-0 flex-wrap items-center gap-x-2">
                  <span className="min-w-0 truncate" dir="auto">{nameOf(c.names)}</span>
                  <span className="text-text-muted">{channelName(c.channel as V2Channel, v2Lang)}</span>
                  <span dir="ltr">
                    {c.old_iqd === null ? '—' : formatIqd(c.old_iqd)} → {c.new_iqd === null ? '—' : formatIqd(c.new_iqd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {preview.large_change || preview.drop_flag ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} data-v2-purchase-review-large />
              {t('large')}
            </label>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-red-400" role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {!preview ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            data-v2-purchase-review-action="preview"
            onClick={() =>
              run(async () => {
                const r = await api.post<{ preview: Preview }>(`${base}/${encodeURIComponent(review.id)}/preview`, {});
                setPreview(r.preview);
              })
            }
          >
            {t('review')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={busy || ((preview.large_change || preview.drop_flag) && !tick)}
            data-v2-purchase-review-action="apply"
            onClick={() =>
              run(async () => {
                await api.post(`${base}/${encodeURIComponent(review.id)}/apply`, { preview_hash: preview.review_hash, ...(tick ? { confirm_large_change: true } : {}) });
                onDone('applied');
              })
            }
          >
            {t('apply')}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          data-v2-purchase-review-action="dismiss"
          onClick={() =>
            run(async () => {
              await api.post(`${base}/${encodeURIComponent(review.id)}/dismiss`, {});
              onDone('kept');
            })
          }
        >
          {t('keep')}
        </Button>
      </div>
    </section>
  );
}
