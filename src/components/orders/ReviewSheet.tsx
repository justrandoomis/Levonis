/**
 * Rating a delivered product, from the order it came in.
 *
 * The body sent is exactly what worker/routes/reviews.ts parses:
 * { productId, orderId, stars (1-5), body } — no media here; the full review
 * form with photos lives on the product page. Eligibility is asked of the
 * server for the chosen product, and its answer decides what the sheet
 * offers: an existing review means "Reviewed", a printer means the rating
 * gift, a configured points value means that number — and an unconfigured
 * one means no promise at all.
 */
import { useEffect, useState } from 'react';
import { Star, CheckCircle2, Gift } from 'lucide-react';
import { api } from '../../lib/api';
import type { ApiOrderItem } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import SafeImage from '../ui/SafeImage';
import { asLang, formatDate } from './format';

interface Eligibility {
  eligible_orders: Array<{ id: string; delivered_at: string | null }>;
  existing_review: { id: string; stars: number; status: string; created_at: string; source?: 'user' | 'system'; system_generated?: boolean } | null;
  can_replace_system_review?: boolean;
  is_printer: boolean;
  review_points: number | null;
}

const MAX_BODY = 4000;

const STRINGS = {
  ar: {
    title: 'قيّم المنتج',
    pickItem: 'اختر المنتج',
    checking: 'جارٍ التحقق من الأهلية…',
    checkFailed: 'تعذر التحقق من الأهلية.',
    reviewed: (d: string) => `قيّمت هذا المنتج في ${d}.`,
    reviewStatus: { pending: 'قيد المراجعة', published: 'منشور', rejected: 'مرفوض' } as Record<string, string>,
    giftHint: 'تُنشر مراجعتك فورًا، وقد تدخل المراجعة الغنية قائمة اعتماد هدايا التقييم.',
    pointsHint: (n: number) => `تُنشر فورًا؛ وإن لم تتأهل لهدية تحصل على ${(n * 2).toLocaleString()} نقطة وفق إعداد الأساس.`,
    stars: 'التقييم',
    star: (n: number) => (n === 1 ? 'نجمة واحدة' : n === 2 ? 'نجمتان' : `${n} نجوم`),
    bodyLabel: 'مراجعتك',
    bodyPlaceholder: 'ما الذي أعجبك؟ ما الذي كان يمكن أن يكون أفضل؟',
    moderation: 'تُنشر المراجعة فورًا. اعتماد المكافأة قرار منفصل.',
    submit: 'إرسال المراجعة',
    submitting: 'جارٍ الإرسال…',
    close: 'إغلاق',
    done: 'شكرًا لك — نُشرت مراجعتك.',
    failed: 'تعذر إرسال المراجعة.',
    noItems: 'لا توجد منتجات قابلة للتقييم في هذا الطلب.',
  },
  en: {
    title: 'Rate this product',
    pickItem: 'Choose a product',
    checking: 'Checking eligibility…',
    checkFailed: 'Eligibility could not be checked.',
    reviewed: (d: string) => `You reviewed this product on ${d}.`,
    reviewStatus: { pending: 'under review', published: 'published', rejected: 'rejected' } as Record<string, string>,
    giftHint: 'Your review publishes immediately; a rich review may enter gift approval.',
    pointsHint: (n: number) => `Published immediately; outside a gift level it earns ${(n * 2).toLocaleString()} configured fallback points.`,
    stars: 'Rating',
    star: (n: number) => (n === 1 ? '1 star' : `${n} stars`),
    bodyLabel: 'Your review',
    bodyPlaceholder: 'What did you like? What could be better?',
    moderation: 'The review publishes immediately. Reward approval is separate.',
    submit: 'Submit review',
    submitting: 'Submitting…',
    close: 'Close',
    done: 'Thank you — your review is now published.',
    failed: 'The review could not be submitted.',
    noItems: 'No reviewable products in this order.',
  },
  ckb: {
    title: 'کاڵاکە هەڵبسەنگێنە',
    pickItem: 'کاڵایەک هەڵبژێرە',
    checking: 'پشکنینی شیاوی…',
    checkFailed: 'شیاوی نەپشکنرا.',
    reviewed: (d: string) => `لە ${d} ئەم کاڵات هەڵسەنگاندووە.`,
    reviewStatus: { pending: 'لە پێداچوونەوەدایە', published: 'بڵاوکراوەتەوە', rejected: 'ڕەتکراوەتەوە' } as Record<string, string>,
    giftHint: 'پێداچوونەوەکەت دەستبەجێ بڵاودەکرێتەوە و لەوانەیە بچێتە ڕیزی دیاری.',
    pointsHint: (n: number) => `دەستبەجێ بڵاودەکرێتەوە؛ ئەگەر دیاری وەرنەگرێت ${(n * 2).toLocaleString()} خاڵ وەردەگرێت.`,
    stars: 'هەڵسەنگاندن',
    star: (n: number) => `${n} ئەستێرە`,
    bodyLabel: 'پێداچوونەوەکەت',
    bodyPlaceholder: 'چیت پێ باش بوو؟ چی دەکرا باشتر بێت؟',
    moderation: 'پێداچوونەوەکە دەستبەجێ بڵاودەکرێتەوە؛ پەسەندی خەڵات جیاوازە.',
    submit: 'ناردنی پێداچوونەوە',
    submitting: 'ناردن…',
    close: 'داخستن',
    done: 'سوپاس — پێداچوونەوەکەت بڵاوکرایەوە.',
    failed: 'پێداچوونەوەکە نەنێردرا.',
    noItems: 'هیچ کاڵایەکی هەڵسەنگاندن نییە لەم داواکارییە.',
  },
} as const;

export default function ReviewSheet({
  open,
  onClose,
  orderId,
  items,
  initialItemId = null,
  reviewedProductIds,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  items: ApiOrderItem[];
  initialItemId?: string | null;
  reviewedProductIds: ReadonlySet<string>;
  onSubmitted: (productId: string) => void;
}) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const candidates = items.filter((it) => !!it.product_id);

  const [itemId, setItemId] = useState<string | null>(null);
  const [stars, setStars] = useState(0);
  const [body, setBody] = useState('');
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [eligState, setEligState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // A fresh sheet every time it opens: the first unreviewed item is preselected.
  useEffect(() => {
    if (!open) return;
    const preferred =
      candidates.find((it) => it.id === initialItemId) ??
      candidates.find((it) => it.product_id && !reviewedProductIds.has(it.product_id)) ??
      candidates[0] ??
      null;
    setItemId(preferred?.id ?? null);
    setStars(0);
    setBody('');
    setError('');
    setDone(false);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialItemId, orderId]);

  const item = candidates.find((it) => it.id === itemId) ?? null;
  const productId = item?.product_id ?? null;

  useEffect(() => {
    if (!open || !productId) return;
    let alive = true;
    setEligState('loading');
    setElig(null);
    api
      .get<Eligibility>(`/api/reviews/eligibility/${encodeURIComponent(productId)}`)
      .then((d) => {
        if (!alive) return;
        setElig(d);
        setEligState('idle');
      })
      .catch(() => alive && setEligState('failed'));
    return () => {
      alive = false;
    };
  }, [open, productId]);

  const submit = async () => {
    if (!productId || busy || stars < 1 || !body.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/reviews', { productId, orderId, stars, body: body.trim() });
      setDone(true);
      onSubmitted(productId);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : s.failed);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  const existing = elig?.existing_review ?? null;
  const replaceSystem = !!elig?.can_replace_system_review || !!existing?.system_generated || existing?.source === 'system';
  const canSubmit = !!productId && stars >= 1 && body.trim().length > 0 && !busy && (!existing || replaceSystem) && eligState !== 'loading';

  return (
    <Sheet
      open={open}
      onClose={close}
      label={s.title}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      panelClassName="w-full sm:max-w-lg max-h-[88dvh] overflow-y-auto"
      testId="review-sheet"
    >
      <div className="px-5 pb-6 pt-2">
        <h2 className="text-white font-bold text-[16px]">{s.title}</h2>

        {candidates.length === 0 ? (
          <p className="text-zinc-400 text-[13px] mt-3">{s.noItems}</p>
        ) : done ? (
          <div role="status" aria-live="polite" className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4 flex items-start gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" aria-hidden />
            <p className="text-emerald-200 text-[13px]">{s.done}</p>
          </div>
        ) : (
          <>
            {candidates.length > 1 && (
              <div role="radiogroup" aria-label={s.pickItem} className="mt-3 flex flex-col gap-1.5">
                {candidates.map((it) => {
                  const active = it.id === itemId;
                  const reviewed = !!it.product_id && reviewedProductIds.has(it.product_id);
                  return (
                    <button
                      key={it.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setItemId(it.id)}
                      className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] ${
                        active ? 'border-[#BAA369]/60 bg-[#BAA369]/10' : 'border-zinc-800 hover:bg-zinc-800/60'
                      }`}
                    >
                      <SafeImage src={it.image} alt="" aspect="square" className="w-9 h-9 rounded-lg shrink-0" bgClassName="bg-black" fallbackIconClassName="w-4 h-4" />
                      <span className="min-w-0 flex-1 text-[13px] text-zinc-200 truncate">{it.name}</span>
                      {reviewed && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-label={s.reviewStatus.published} />}
                    </button>
                  );
                })}
              </div>
            )}

            {item && (
              <div className="mt-3 flex items-center gap-3">
                <SafeImage src={item.image} alt="" aspect="square" className="w-12 h-12 rounded-xl shrink-0" bgClassName="bg-black" />
                <div className="min-w-0">
                  <p className="text-white text-[13.5px] font-bold truncate">{item.name}</p>
                  {item.variant && <p className="text-zinc-500 text-[12px] truncate">{item.variant}</p>}
                </div>
              </div>
            )}

            {/* Eligibility — the server's answer, never a guess. */}
            <div role="status" aria-live="polite" className="mt-3 text-[12.5px] min-h-[1.25em]">
              {eligState === 'loading' && (
                <span className="inline-flex items-center gap-2 text-zinc-400">
                  <Spinner size="xs" delayMs={0} decorative /> {s.checking}
                </span>
              )}
              {eligState === 'failed' && <span className="text-amber-400">{s.checkFailed}</span>}
              {existing && !replaceSystem && (
                <span className="inline-flex items-center gap-1.5 text-emerald-300">
                  <CheckCircle2 className="w-4 h-4" aria-hidden />
                  {s.reviewed(formatDate(existing.created_at, lang))} {s.reviewStatus[existing.status] ?? existing.status}
                </span>
              )}
              {(!existing || replaceSystem) && elig && elig.is_printer && (
                <span className="inline-flex items-center gap-1.5 text-zinc-300">
                  <Gift className="w-4 h-4 text-[#BAA369]" aria-hidden /> {s.giftHint}
                </span>
              )}
              {(!existing || replaceSystem) && elig && !elig.is_printer && typeof elig.review_points === 'number' && elig.review_points > 0 && (
                <span className="text-zinc-300">{s.pointsHint(elig.review_points)}</span>
              )}
            </div>

            {(!existing || replaceSystem) && (
              <>
                <fieldset className="mt-3">
                  <legend className="text-[12px] text-zinc-400 mb-1.5">{s.stars}</legend>
                  <div role="radiogroup" aria-label={s.stars} className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={stars === n}
                        aria-label={s.star(n)}
                        data-star={n}
                        onClick={() => setStars(n)}
                        className="w-11 h-11 inline-flex items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                      >
                        <Star
                          className={`w-7 h-7 transition-colors ${n <= stars ? 'text-[#BAA369]' : 'text-zinc-700'}`}
                          fill={n <= stars ? 'currentColor' : 'none'}
                          aria-hidden
                        />
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label className="block mt-3">
                  <span className="text-[12px] text-zinc-400 block mb-1">{s.bodyLabel}</span>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value.slice(0, MAX_BODY))}
                    placeholder={s.bodyPlaceholder}
                    rows={4}
                    maxLength={MAX_BODY}
                    className="w-full bg-black/60 border border-zinc-800 rounded-xl px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-600 resize-y focus:outline-none focus:border-[#BAA369]/60"
                  />
                  <span className="block text-end text-[10.5px] text-zinc-600 tabular-nums mt-0.5">
                    {body.length}/{MAX_BODY}
                  </span>
                </label>
                <p className="text-[11px] text-zinc-500">{s.moderation}</p>

                <p role="alert" aria-live="assertive" className="text-red-400 text-[12.5px] mt-2 min-h-[1.25em]">
                  {error}
                </p>

                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={close}
                    disabled={busy}
                    className="min-h-[44px] px-4 rounded-xl border border-zinc-700 text-zinc-200 text-[13.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-50"
                  >
                    {s.close}
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!canSubmit}
                    data-submit-review
                    className="flex-1 min-h-[44px] rounded-xl bg-[#ef233c] text-white text-[13.5px] font-bold hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    {busy && <Spinner size="sm" delayMs={0} decorative className="text-white" />}
                    {busy ? s.submitting : s.submit}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {(done || (existing && !replaceSystem && !busy)) && (
          <button
            type="button"
            onClick={close}
            className="mt-4 w-full min-h-[44px] rounded-xl border border-zinc-700 text-zinc-200 text-[13.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
          >
            {s.close}
          </button>
        )}
      </div>
    </Sheet>
  );
}
