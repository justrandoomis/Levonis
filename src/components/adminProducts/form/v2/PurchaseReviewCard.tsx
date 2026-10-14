/**
 * «● تكلفة شراء جديدة بانتظار مراجعتك» — D1 IN SECTION ٣ (the clean start,
 * addendum A.10; DECISIONS rows 221 D1 and 222). Owner-only.
 *
 * A confirmed stock purchase leaves one pending review on the product: the
 * cost inputs it implies, never yet applied. The owner previews the price
 * change (the server's sheet: the changed prices, the 15% tick), applies it
 * — one batch: inputs, prices, history — or keeps the current cost. Every
 * figure is the server's; nothing is computed here.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatIqd } from '../../../../lib/api';
import { useLanguage } from '../../../../LanguageContext';
import { Button } from '../../../ui/Button';

interface ReviewInput {
  scope: string;
  scope_id: string;
  fields: Record<string, string | number | null>;
}
interface Review {
  id: string;
  purchase_id: string;
  state: string;
  created_at: string;
  inputs: ReviewInput[];
}
interface Change {
  combo_key: string;
  names: { ar: string; en: string; ckb: string };
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
} as const;

export default function PurchaseReviewCard({ productId, onApplied }: { productId: string; onApplied: () => void }) {
  const { lang } = useLanguage();
  const t = (k: keyof typeof T) => (lang === 'en' ? T[k].en : lang === 'ckb' ? T[k].ckb : T[k].ar);
  const nameOf = (n: Change['names']) => (lang === 'en' ? n.en : lang === 'ckb' ? n.ckb || n.ar : n.ar) || n.en;
  const [review, setReview] = useState<Review | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tick, setTick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const base = `/api/admin/products-v2/${encodeURIComponent(productId)}/purchase-review`;

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ purchase_review: Review | null }>(base, { mascot: 'silent' });
      setReview(r.purchase_review && r.purchase_review.state === 'pending' ? r.purchase_review : null);
    } catch {
      setReview(null);
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!review) return note ? <p className="mb-3 text-[12px] text-text-secondary" role="status">{note}</p> : null;

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

  return (
    <section className="lv-alert lv-alert-info mb-3 space-y-2 px-3 py-2 text-[12px] text-text-primary" data-v2-purchase-review={review.id}>
      <p className="font-bold">{t('chip')}</p>
      <p className="text-text-secondary">
        {t('from')} <span dir="ltr">{review.purchase_id}</span>
      </p>
      {preview ? (
        <div className="space-y-2" data-v2-purchase-review-preview>
          {preview.changes.length === 0 ? (
            <p>{t('noChange')}</p>
          ) : (
            <ul className="space-y-1">
              {preview.changes.map((c) => (
                <li key={`${c.combo_key}|${c.channel}`} className="flex min-w-0 flex-wrap items-center gap-x-2">
                  <span className="min-w-0 truncate" dir="auto">{nameOf(c.names)}</span>
                  <span className="text-text-muted">{c.channel}</span>
                  <span dir="ltr">
                    {c.old_iqd === null ? '—' : formatIqd(c.old_iqd)} → {c.new_iqd === null ? '—' : formatIqd(c.new_iqd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {preview.large_change || preview.drop_flag ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} />
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
            onClick={() =>
              run(async () => {
                await api.post(`${base}/${encodeURIComponent(review.id)}/apply`, { preview_hash: preview.review_hash, ...(tick ? { confirm_large_change: true } : {}) });
                setNote(t('applied'));
                setReview(null);
                setPreview(null);
                onApplied();
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
          onClick={() =>
            run(async () => {
              await api.post(`${base}/${encodeURIComponent(review.id)}/dismiss`, {});
              setNote(t('kept'));
              setReview(null);
              setPreview(null);
            })
          }
        >
          {t('keep')}
        </Button>
      </div>
    </section>
  );
}
