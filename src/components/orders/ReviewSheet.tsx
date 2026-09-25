/**
 * "تقييم المنتجات المستلمة" — rating THE PRODUCTS of a delivered order.
 *
 * The owner asked for the products, plural, so the sheet is built around the
 * order rather than around one product:
 *
 *  - ONE request on open, `GET /api/reviews/order/:orderId`, which answers for
 *    every line at once: what is reviewable, what this customer already
 *    reviewed, and whether the order is delivered at all. The old per-product
 *    `/eligibility/:productId` call needed a round trip per tap and could
 *    never say "nothing left" before the customer had clicked through all of
 *    them.
 *  - Submitting does NOT end the sheet. The rated product turns into a
 *    read-only row and the next unrated one opens, so an order of four
 *    products is four ratings in one sitting.
 *  - An order with nothing left says so — no empty form, no dead stars.
 *
 * THE SERVER DECIDES, THIS ONLY REFLECTS IT. `reviewedProductIds` and `items`
 * are the caller's optimistic hints, used for the first paint and nothing
 * else; every enable/disable below comes from the loaded order. A second
 * submission for a product is REFUSED by the server (409) unless what exists
 * is the system-written marker, which a real buyer replaces — the row says
 * which case it is instead of offering stars that would bounce.
 *
 * The body sent is exactly what worker/routes/reviews.ts parses:
 * { productId, orderId, stars (1-5), body } — no media here; the full review
 * form with photos lives on the product page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Star, CheckCircle2, Gift, RotateCw, PackageOpen } from 'lucide-react';
import { api } from '../../lib/api';
import type { ApiOrderItem } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import SafeImage from '../ui/SafeImage';
import { asLang, formatDate } from './format';

/** One product of the order, as GET /api/reviews/order/:orderId returns it. */
interface OrderReviewLine {
  order_item_id: string;
  product_id: string;
  name: string;
  image: string;
  variant: string;
  is_printer: boolean;
  existing_review: { id: string; stars: number; status: string; created_at: string } | null;
  can_replace_system_review: boolean;
  state: 'reviewable' | 'reviewed' | 'not_delivered';
}

interface OrderReview {
  delivered: boolean;
  review_points: number | null;
  remaining: number;
  lines: OrderReviewLine[];
}

/** Mirrors MAX_BODY_CHARS in worker/routes/reviews.ts — the server rejects more. */
const MAX_BODY = 4000;

const STRINGS = {
  ar: {
    title: 'تقييم المنتجات المستلمة',
    pickItem: 'منتجات هذا الطلب',
    loading: 'جارٍ تحميل منتجات الطلب…',
    loadFailed: 'تعذر تحميل منتجات هذا الطلب.',
    retry: 'إعادة المحاولة',
    progress: (done: number, total: number) => `قيّمت ${done} من ${total}`,
    reviewed: (d: string) => `قيّمت هذا المنتج في ${d}.`,
    reviewStatus: { pending: 'قيد المراجعة', published: 'منشور', rejected: 'مرفوض' } as Record<string, string>,
    chipReviewed: 'مُقيَّم',
    chipTodo: 'بانتظار التقييم',
    giftHint: 'تُنشر مراجعتك فورًا، وقد تدخل المراجعة الغنية قائمة اعتماد هدايا التقييم.',
    pointsHint: (n: number) => `تُنشر فورًا؛ وإن لم تتأهل لهدية تحصل على ${(n * 2).toLocaleString()} نقطة وفق إعداد الأساس.`,
    stars: 'التقييم',
    star: (n: number) => (n === 1 ? 'نجمة واحدة' : n === 2 ? 'نجمتان' : `${n} نجوم`),
    starsRequired: 'اختر عدد النجوم أولًا.',
    bodyLabel: 'مراجعتك',
    bodyPlaceholder: 'ما الذي أعجبك؟ ما الذي كان يمكن أن يكون أفضل؟',
    moderation: 'تُنشر المراجعة فورًا. اعتماد المكافأة قرار منفصل.',
    submit: 'إرسال المراجعة',
    submitting: 'جارٍ الإرسال…',
    close: 'إغلاق',
    done: (name: string) => `شكرًا — نُشرت مراجعتك لـ «${name}».`,
    nextUp: 'المنتج التالي بالأسفل.',
    failed: 'تعذر إرسال المراجعة.',
    noItems: 'لا توجد منتجات قابلة للتقييم في هذا الطلب.',
    allReviewed: 'قيّمت كل منتجات هذا الطلب. شكرًا لك.',
    notDelivered: 'يمكنك تقييم المنتجات بعد استلام الطلب.',
  },
  en: {
    title: 'Rate the products you received',
    pickItem: 'Products in this order',
    loading: 'Loading the products of this order…',
    loadFailed: 'The products of this order could not be loaded.',
    retry: 'Try again',
    progress: (done: number, total: number) => `${done} of ${total} rated`,
    reviewed: (d: string) => `You reviewed this product on ${d}.`,
    reviewStatus: { pending: 'under review', published: 'published', rejected: 'rejected' } as Record<string, string>,
    chipReviewed: 'Rated',
    chipTodo: 'Not rated yet',
    giftHint: 'Your review publishes immediately; a rich review may enter gift approval.',
    pointsHint: (n: number) => `Published immediately; outside a gift level it earns ${(n * 2).toLocaleString()} configured fallback points.`,
    stars: 'Rating',
    star: (n: number) => (n === 1 ? '1 star' : `${n} stars`),
    starsRequired: 'Choose a star rating first.',
    bodyLabel: 'Your review',
    bodyPlaceholder: 'What did you like? What could be better?',
    moderation: 'The review publishes immediately. Reward approval is separate.',
    submit: 'Submit review',
    submitting: 'Submitting…',
    close: 'Close',
    done: (name: string) => `Thank you — your review of “${name}” is published.`,
    nextUp: 'The next product is below.',
    failed: 'The review could not be submitted.',
    noItems: 'No reviewable products in this order.',
    allReviewed: 'You have rated every product in this order. Thank you.',
    notDelivered: 'You can rate the products once the order has been delivered.',
  },
  ckb: {
    // OWNER: the Kurdish (Sorani) wording is yours to write by hand. Every
    // string added in this round carries the ARABIC text on purpose — it is
    // never machine-translated Kurdish. The entries that already read as
    // Sorani below are the owner's own earlier wording and are untouched.
    title: 'تقييم المنتجات المستلمة', // OWNER: Sorani to be written by hand.
    pickItem: 'منتجات هذا الطلب', // OWNER: Sorani to be written by hand.
    loading: 'جارٍ تحميل منتجات الطلب…', // OWNER: Sorani to be written by hand.
    loadFailed: 'تعذر تحميل منتجات هذا الطلب.', // OWNER: Sorani to be written by hand.
    retry: 'إعادة المحاولة', // OWNER: Sorani to be written by hand.
    progress: (done: number, total: number) => `قيّمت ${done} من ${total}`, // OWNER: Sorani to be written by hand.
    reviewed: (d: string) => `لە ${d} ئەم کاڵات هەڵسەنگاندووە.`,
    reviewStatus: { pending: 'لە پێداچوونەوەدایە', published: 'بڵاوکراوەتەوە', rejected: 'ڕەتکراوەتەوە' } as Record<string, string>,
    chipReviewed: 'مُقيَّم', // OWNER: Sorani to be written by hand.
    chipTodo: 'بانتظار التقييم', // OWNER: Sorani to be written by hand.
    giftHint: 'پێداچوونەوەکەت دەستبەجێ بڵاودەکرێتەوە و لەوانەیە بچێتە ڕیزی دیاری.',
    pointsHint: (n: number) => `دەستبەجێ بڵاودەکرێتەوە؛ ئەگەر دیاری وەرنەگرێت ${(n * 2).toLocaleString()} خاڵ وەردەگرێت.`,
    stars: 'هەڵسەنگاندن',
    star: (n: number) => `${n} ئەستێرە`,
    starsRequired: 'اختر عدد النجوم أولًا.', // OWNER: Sorani to be written by hand.
    bodyLabel: 'پێداچوونەوەکەت',
    bodyPlaceholder: 'چیت پێ باش بوو؟ چی دەکرا باشتر بێت؟',
    moderation: 'پێداچوونەوەکە دەستبەجێ بڵاودەکرێتەوە؛ پەسەندی خەڵات جیاوازە.',
    submit: 'ناردنی پێداچوونەوە',
    submitting: 'ناردن…',
    close: 'داخستن',
    done: (name: string) => `شكرًا — نُشرت مراجعتك لـ «${name}».`, // OWNER: Sorani to be written by hand.
    nextUp: 'المنتج التالي بالأسفل.', // OWNER: Sorani to be written by hand.
    failed: 'پێداچوونەوەکە نەنێردرا.',
    noItems: 'هیچ کاڵایەکی هەڵسەنگاندن نییە لەم داواکارییە.',
    allReviewed: 'قيّمت كل منتجات هذا الطلب. شكرًا لك.', // OWNER: Sorani to be written by hand.
    notDelivered: 'يمكنك تقييم المنتجات بعد استلام الطلب.', // OWNER: Sorani to be written by hand.
  },
} as const;

/** A line the customer may still rate — the ONLY thing that enables the form. */
function isOpen(l: OrderReviewLine): boolean {
  return l.state === 'reviewable';
}

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
  /** The caller's copy of the order lines — first paint only; the server's
   *  answer replaces it the moment it lands. */
  items: ApiOrderItem[];
  initialItemId?: string | null;
  /** Optimistic hint for the first paint; never the authority. */
  reviewedProductIds: ReadonlySet<string>;
  onSubmitted: (productId: string) => void;
}) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];

  const [data, setData] = useState<OrderReview | null>(null);
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [productId, setProductId] = useState<string | null>(null);
  const [stars, setStars] = useState(0);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The product just published, kept visible while the next one is rated. */
  const [justDone, setJustDone] = useState<string | null>(null);

  /** The first line worth opening: the caller's choice, else the first unrated. */
  const firstOpen = useCallback(
    (lines: OrderReviewLine[], preferItemId: string | null): string | null => {
      const wanted = preferItemId ? lines.find((l) => l.order_item_id === preferItemId) : undefined;
      if (wanted && isOpen(wanted)) return wanted.product_id;
      return lines.find(isOpen)?.product_id ?? null;
    },
    []
  );

  /**
   * `prefer` is passed in rather than closed over, so the caller changing
   * `initialItemId` cannot re-identify this callback and silently refetch the
   * order out from under a half-typed review.
   */
  const fetchOrder = useCallback(
    async (prefer: string | null) => {
      setLoad('loading');
      setError('');
      try {
        const d = await api.get<OrderReview>(`/api/reviews/order/${encodeURIComponent(orderId)}`);
        const lines = Array.isArray(d.lines) ? d.lines : [];
        setData({ ...d, lines });
        setProductId(firstOpen(lines, prefer));
        setLoad('ready');
      } catch {
        setData(null);
        setLoad('failed');
      }
    },
    [orderId, firstOpen]
  );

  // A fresh sheet every time it opens, and never a stale order behind it.
  useEffect(() => {
    if (!open || !orderId) return;
    setStars(0);
    setBody('');
    setBusy(false);
    setJustDone(null);
    void fetchOrder(initialItemId);
    // initialItemId is the caller's opening choice, read once per open: adding
    // it here would restart the sheet whenever the caller re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId, fetchOrder]);

  /**
   * What to draw before the server has answered: the caller's own lines,
   * marked from `reviewedProductIds`. It is a PLACEHOLDER LIST ONLY — nothing
   * here is selectable and no form hangs off it, so an optimistic hint can
   * never let someone submit a rating the server would refuse.
   */
  const placeholder = useMemo(
    () =>
      items
        .filter((it) => !!it.product_id)
        .map((it) => ({ id: it.id, name: it.name, image: it.image, reviewed: reviewedProductIds.has(it.product_id!) })),
    [items, reviewedProductIds]
  );

  const lines = data?.lines ?? [];
  const active = lines.find((l) => l.product_id === productId) ?? null;
  const ratedCount = lines.filter((l) => l.state === 'reviewed').length;
  const openCount = lines.filter(isOpen).length;
  const canSubmit = !!active && isOpen(active) && stars >= 1 && body.trim().length > 0 && !busy;

  const pick = (l: OrderReviewLine) => {
    if (busy || l.product_id === productId) return;
    setProductId(l.product_id);
    setStars(0);
    setBody('');
    setError('');
  };

  const submit = async () => {
    if (!active || !canSubmit) return;
    setBusy(true);
    setError('');
    const rated = active;
    try {
      await api.post('/api/reviews', { productId: rated.product_id, orderId, stars, body: body.trim() });
      // The line becomes read-only from the stars we know were accepted; the
      // sheet then moves on rather than ending on one product.
      const next: OrderReviewLine[] = lines.map((l) =>
        l.product_id === rated.product_id
          ? {
              ...l,
              state: 'reviewed' as const,
              can_replace_system_review: false,
              existing_review: {
                id: l.existing_review?.id ?? '',
                stars,
                status: 'published',
                created_at: new Date().toISOString(),
              },
            }
          : l
      );
      setData((d) => (d ? { ...d, lines: next, remaining: next.filter(isOpen).length } : d));
      setJustDone(rated.name);
      setStars(0);
      setBody('');
      setProductId(next.find(isOpen)?.product_id ?? null);
      onSubmitted(rated.product_id);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : s.failed);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  const rowBase =
    'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold';

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
      <div className="px-4 sm:px-5 pb-6 pt-2">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="text-white font-bold text-[16px] min-w-0">{s.title}</h2>
          {load === 'ready' && lines.length > 0 && (
            <span data-review-progress className="text-[11.5px] text-zinc-500 tabular-nums shrink-0">
              {s.progress(ratedCount, lines.length)}
            </span>
          )}
        </div>

        {/* Loading: the caller's own lines, inert, so the sheet has shape
            without pretending to know what may be rated. */}
        {load === 'loading' && (
          <>
            <p role="status" aria-live="polite" className="mt-3 inline-flex items-center gap-2 text-zinc-400 text-[12.5px]">
              <Spinner size="xs" delayMs={0} decorative /> {s.loading}
            </p>
            <ul className="mt-3 flex flex-col gap-1.5" aria-hidden="true">
              {placeholder.map((p) => (
                <li key={p.id} className={`${rowBase} border-zinc-800/70 opacity-50`}>
                  <SafeImage src={p.image} alt="" aspect="square" className="w-10 h-10 rounded-lg shrink-0" bgClassName="bg-black" fallbackIconClassName="w-4 h-4" />
                  <span className="min-w-0 flex-1 text-[13px] text-zinc-300 truncate">{p.name}</span>
                  {p.reviewed && <CheckCircle2 className="w-4 h-4 text-emerald-400/60 shrink-0" />}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* Failure is said out loud, with the way back. */}
        {load === 'failed' && (
          <div className="mt-4">
            <p role="alert" className="text-amber-400 text-[13px]">
              {s.loadFailed}
            </p>
            <button
              type="button"
              onClick={() => void fetchOrder(initialItemId)}
              data-review-retry
              className="mt-3 min-h-[44px] px-4 inline-flex items-center gap-2 rounded-xl border border-zinc-700 text-zinc-200 text-[13.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              <RotateCw className="w-4 h-4" aria-hidden />
              {s.retry}
            </button>
          </div>
        )}

        {load === 'ready' && (
          <>
            {/* The banner for the product just published stays while the next
                one is rated — the thanks is not a dead end. */}
            {justDone && (
              <div
                role="status"
                aria-live="polite"
                data-review-done
                className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 flex items-start gap-2"
              >
                <CheckCircle2 className="w-4.5 h-4.5 text-emerald-400 shrink-0 mt-px" aria-hidden />
                <p className="text-emerald-200 text-[12.5px] min-w-0">
                  {s.done(justDone)}
                  {openCount > 0 && <span className="text-emerald-300/70"> {s.nextUp}</span>}
                </p>
              </div>
            )}

            {/* Nothing to offer — and it says which kind of nothing. */}
            {lines.length === 0 ? (
              <p className="text-zinc-400 text-[13px] mt-4">{s.noItems}</p>
            ) : !data?.delivered ? (
              <p data-review-empty className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-zinc-400 text-[13px]">
                {s.notDelivered}
              </p>
            ) : openCount === 0 && !justDone ? (
              <div data-review-empty className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 flex items-start gap-2.5">
                <PackageOpen className="w-5 h-5 text-gold shrink-0" aria-hidden />
                <p className="text-zinc-300 text-[13px]">{s.allReviewed}</p>
              </div>
            ) : null}

            {lines.length > 0 && (
              <div role="radiogroup" aria-label={s.pickItem} className="mt-3 flex flex-col gap-1.5">
                {lines.map((l) => {
                  const selected = l.product_id === productId;
                  const rated = l.state === 'reviewed';
                  /**
                   * Only a line that can still be rated is a CHOICE. A rated
                   * or undelivered line is a status row, so it is rendered as
                   * plain content instead of a disabled radio the group would
                   * still own and announce as a selectable option.
                   */
                  const Row = isOpen(l) ? 'button' : 'div';
                  const choice = isOpen(l)
                    ? ({ type: 'button', role: 'radio', 'aria-checked': selected, disabled: busy, onClick: () => pick(l) } as const)
                    : ({} as const);
                  return (
                    <Row
                      key={l.order_item_id}
                      {...choice}
                      data-review-line={l.product_id}
                      data-review-state={l.state}
                      className={`${rowBase} ${
                        selected
                          ? 'border-gold/60 bg-gold/10'
                          : isOpen(l)
                            ? 'border-zinc-800 hover:bg-zinc-800/60'
                            : 'border-zinc-800/60 opacity-70'
                      }`}
                    >
                      <SafeImage
                        src={l.image}
                        alt=""
                        aspect="square"
                        className="w-10 h-10 rounded-lg shrink-0"
                        bgClassName="bg-black"
                        fallbackIconClassName="w-4 h-4"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-zinc-200 truncate">{l.name}</span>
                        {l.variant && <span className="block text-[11.5px] text-zinc-500 truncate">{l.variant}</span>}
                        {rated && l.existing_review && (
                          <span className="block text-[11px] text-emerald-300/85 truncate">
                            {s.reviewed(formatDate(l.existing_review.created_at, lang))}{' '}
                            {s.reviewStatus[l.existing_review.status] ?? l.existing_review.status}
                          </span>
                        )}
                      </span>
                      {rated ? (
                        <span className="shrink-0 inline-flex items-center gap-1">
                          {l.existing_review && (
                            <span className="text-[11.5px] font-bold text-emerald-300 tabular-nums" aria-label={s.star(l.existing_review.stars)}>
                              {l.existing_review.stars}
                            </span>
                          )}
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-label={s.chipReviewed} />
                        </span>
                      ) : (
                        isOpen(l) && (
                          <span className="shrink-0 rounded-full border border-gold/35 px-2 py-0.5 text-[10px] font-bold text-gold">
                            {s.chipTodo}
                          </span>
                        )
                      )}
                    </Row>
                  );
                })}
              </div>
            )}

            {/* The form for the product now selected. */}
            {active && isOpen(active) && (
              <>
                <div className="mt-4 h-px bg-zinc-800" />

                {/* What this rating may earn — the server's answer, never a guess. */}
                <p className="mt-3 text-[12.5px] min-h-[1.25em]">
                  {active.is_printer ? (
                    <span className="inline-flex items-start gap-1.5 text-zinc-300">
                      <Gift className="w-4 h-4 text-gold shrink-0 mt-px" aria-hidden /> {s.giftHint}
                    </span>
                  ) : typeof data?.review_points === 'number' && data.review_points > 0 ? (
                    <span className="text-zinc-300">{s.pointsHint(data.review_points)}</span>
                  ) : null}
                </p>

                <fieldset className="mt-3">
                  <legend className="text-[12px] text-zinc-400 mb-1.5">
                    {s.stars} — <span className="text-zinc-300">{active.name}</span>
                  </legend>
                  <div role="radiogroup" aria-label={`${s.stars} — ${active.name}`} className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={stars === n}
                        aria-label={s.star(n)}
                        data-star={n}
                        disabled={busy}
                        onClick={() => setStars(n)}
                        className="w-11 h-11 inline-flex items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50"
                      >
                        <Star
                          className={`w-7 h-7 transition-colors ${n <= stars ? 'text-gold' : 'text-zinc-700'}`}
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
                    // Bounded here as well as on the server, so the counter
                    // below can never promise room the server would refuse.
                    onChange={(e) => setBody(e.target.value.slice(0, MAX_BODY))}
                    placeholder={s.bodyPlaceholder}
                    rows={4}
                    maxLength={MAX_BODY}
                    disabled={busy}
                    data-review-body
                    className="w-full bg-black/60 border border-zinc-800 rounded-xl px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-600 resize-y focus:outline-none focus:border-gold/60 disabled:opacity-60"
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
                    className="min-h-[44px] px-4 rounded-xl border border-zinc-700 text-zinc-200 text-[13.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50"
                  >
                    {s.close}
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!canSubmit}
                    // Says why it is closed rather than just being grey.
                    title={stars < 1 ? s.starsRequired : undefined}
                    data-submit-review
                    data-mascot="review"
                    className="flex-1 min-h-[44px] rounded-xl bg-[#ef233c] text-snow text-[13.5px] font-bold hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    {busy && <Spinner size="sm" delayMs={0} decorative className="text-white" />}
                    {busy ? s.submitting : s.submit}
                  </button>
                </div>
              </>
            )}

            {/* Whenever no form is showing there is still one way out — a
                state with neither a submit button nor a close button would
                trap the customer behind a scrim. */}
            {!(active && isOpen(active)) && (
              <button
                type="button"
                onClick={close}
                className="mt-4 w-full min-h-[44px] rounded-xl border border-zinc-700 text-zinc-200 text-[13.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                {s.close}
              </button>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
