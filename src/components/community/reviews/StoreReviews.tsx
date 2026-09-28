/**
 * «قيّم المتجر» — A CUSTOMER RATES THE SHOP THEY BOUGHT FROM.
 *
 * The server has always had it (worker/routes/merchantReviews.ts): `GET
 * /api/community-reviews/eligible` lists the delivered store orders and the
 * completed custom orders this customer has not reviewed yet, and `POST
 * /api/community-reviews` writes a review against ONE of them — the merchant
 * and the store are taken from that transaction, never from the request, and
 * nobody reviews their own shop. No page offered it (review of Levo
 * Community, 2026-09-28), so store pages carried «no reviews yet» however
 * much they sold. Confirming receipt of a custom order even answered
 * `review_available: true` into the void.
 *
 * Here: the transactions waiting for a rating, each a card that opens the
 * form in place — five stars (each a 44px target, a real radio group) and
 * optional words — and says what happened. `kind` picks which transactions a
 * screen shows: the store orders on /orders, the custom orders under
 * «تنفيذ طلباتي».
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useAuth } from '../../../AuthContext';
import { api, ApiError } from '../../../lib/api';
import { keyOf, ofKind, reviewTarget, type EligibleReview } from './eligible';

const MAX_BODY = 3000;

/** The transactions waiting for this customer's rating, of one kind. */
export function useEligibleReviews(kind: 'store' | 'custom', refreshKey = 0) {
  const { isAuthenticated } = useAuth();
  const [rows, setRows] = useState<EligibleReview[] | null>(null);
  useEffect(() => {
    if (!isAuthenticated) {
      setRows([]);
      return;
    }
    let alive = true;
    api
      .get<{ eligible: EligibleReview[] }>('/api/community-reviews/eligible')
      .then((d) => alive && setRows(ofKind(d.eligible ?? [], kind)))
      // Nothing to offer when the list cannot be read: this is an invitation, not a record.
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [isAuthenticated, kind, refreshKey]);
  return rows;
}

/** The waiting ratings, as a short list of cards; nothing at all when there are none. */
export default function PendingStoreReviews({ kind, refreshKey = 0 }: { kind: 'store' | 'custom'; refreshKey?: number }) {
  const { loc } = useLanguage();
  const rows = useEligibleReviews(kind, refreshKey);
  const [done, setDone] = useState<string[]>([]);
  if (!rows || rows.length === 0) return null;
  const waiting = rows.filter((r) => !done.includes(keyOf(r))).slice(0, 3);
  if (!waiting.length && !done.length) return null;
  // OWNER: Sorani to be written by hand (every string in this file).
  return (
    <section aria-labelledby={`store-reviews-${kind}`} className="mb-4 space-y-2" data-store-reviews={kind}>
      <h2 id={`store-reviews-${kind}`} className="text-[13px] font-bold text-gold">
        {loc('قيّم من اشتريت منهم', 'Rate the shops you bought from')}
      </h2>
      {waiting.map((r) => (
        <StoreReviewCard key={keyOf(r)} item={r} onDone={() => setDone((d) => [...d, keyOf(r)])} />
      ))}
      {done.length > 0 && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-emerald-300" role="status">
          <Check aria-hidden="true" className="h-4 w-4" />
          {loc('شكرًا — تقييمك يظهر في صفحة المتجر.', 'Thank you — your rating shows on the store’s page.')}
        </p>
      )}
    </section>
  );
}

export function StoreReviewCard({ item, onDone }: { item: EligibleReview; onDone: () => void }) {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refusal = useCallback(
    (e: unknown) => {
      const code = e instanceof ApiError ? e.code : '';
      const status = e instanceof ApiError ? e.status : 0;
      if (code === 'SELF_REVIEW') return loc('هذا متجرك — لا تقيّم نفسك.', 'This is your own store — you cannot rate yourself.');
      if (code === 'NOT_ELIGIBLE') return loc('لا يمكن تقييم هذا الطلب الآن.', 'This order cannot be rated now.');
      if (status === 409) return loc('قيّمت هذا الطلب من قبل.', 'You have already rated this order.');
      if (code === 'RATE_LIMITED') return loc('تقييمات كثيرة في وقت قصير — انتظر قليلًا.', 'Many ratings in a short while — wait a moment.');
      return loc('تعذّر إرسال التقييم — حاول مجددًا.', 'Could not send the rating — try again.');
    },
    [loc]
  );

  async function send() {
    if (!rating || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/community-reviews', { rating, body: body.trim(), ...reviewTarget(item) });
      onDone();
    } catch (e) {
      setError(refusal(e));
      // Already rated elsewhere: the card has nothing left to ask.
      if (e instanceof ApiError && e.status === 409) onDone();
    } finally {
      setBusy(false);
    }
  }

  const names = [
    loc('سيئ', 'Poor'),
    loc('مقبول', 'Fair'),
    loc('جيد', 'Good'),
    loc('جيد جدًا', 'Very good'),
    loc('ممتاز', 'Excellent'),
  ];

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5" data-store-review-card={keyOf(item)}>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-white">
          {loc('كيف كانت تجربتك مع ', 'How was your experience with ')}
          <bdi className="font-semibold">{item.merchant_name}</bdi>
          {loc('؟', '?')}
        </p>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="min-h-11 shrink-0 rounded-xl bg-olive px-4 text-[12.5px] font-semibold text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-store-review-open
          >
            {loc('قيّم', 'Rate')}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-3">
          {/* In the page's direction, as the product rating sheet draws them (components/orders/ReviewSheet). */}
          <div role="radiogroup" aria-label={loc('التقييم من 5', 'Rating out of 5')} className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={`${n} — ${names[n - 1]}`}
                onClick={() => setRating(n)}
                className="flex h-11 w-11 items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                data-store-review-star={n}
              >
                <Star aria-hidden="true" className={`h-7 w-7 ${n <= rating ? 'fill-gold text-gold' : 'text-zinc-600'}`} />
              </button>
            ))}
            <span className="ms-2 text-[12.5px] text-zinc-300" dir="auto" aria-hidden="true">
              {rating ? names[rating - 1] : ''}
            </span>
          </div>
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-zinc-400">{loc('كلمة عن تجربتك (اختياري)', 'A word about it (optional)')}</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, MAX_BODY))}
              rows={3}
              maxLength={MAX_BODY}
              dir="auto"
              className="w-full resize-y rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white outline-none focus:border-gold/40 focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
          {error && (
            <p className="text-[12px] text-red-300" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={send}
              disabled={!rating || busy}
              className="min-h-11 flex-1 rounded-xl bg-olive text-[13px] font-bold text-snow disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              data-store-review-send
            >
              {busy ? loc('جارٍ الإرسال…', 'Sending…') : loc('أرسل التقييم', 'Send the rating')}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="min-h-11 rounded-xl border border-white/10 px-4 text-[13px] text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {loc('لاحقًا', 'Later')}
            </button>
          </div>
          <p className="text-[11.5px] text-zinc-500">
            {/* The name as the store page masks it (worker/routes/storefront.ts `maskName`): «Ahmed K.». */}
            {loc('يظهر تقييمك في صفحة المتجر باسمك المختصر.', 'Your rating shows on the store’s page under your short name.')}
          </p>
        </div>
      )}
    </div>
  );
}
