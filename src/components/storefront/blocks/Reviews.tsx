/**
 * REVIEWS — from completed orders only; the buyer's name is masked by the
 * server («Ahmed K.»). A summary with the distribution, then the newest.
 *
 * Two variants (review of the store builder, 2026-09-28 — the block used to
 * ignore the one the merchant picked): `list`, one review under another; and
 * `cards`, the stars first and the words in a card, side by side — a row that
 * scrolls sideways on a phone, a grid on a wider page. A store with no
 * reviews yet shows the block to its owner in the builder, and to nobody on
 * the live page: «لا توجد تقييمات بعد» on a shop's front is not a message a
 * merchant chose to publish.
 */
import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import type { ReviewsData } from '../../../../packages/storeLayout/src/data';
import { useStorefrontRuntime } from '../runtime';
import { BlockHeading, Column, Empty, Loading, useText } from '../parts';
import type { BlockProps } from '../types';

export function useReviews(initial: ReviewsData | null): ReviewsData | null {
  const rt = useStorefrontRuntime();
  const [data, setData] = useState<ReviewsData | null>(initial);
  useEffect(() => {
    if (initial) {
      setData(initial);
      return;
    }
    let alive = true;
    rt.loadReviews()
      .then((d) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [initial, rt]);
  return data;
}

export function ReviewsView({
  initial,
  limit = 20,
  summary = true,
  variant = 'list',
}: {
  initial: ReviewsData | null;
  limit?: number;
  summary?: boolean;
  variant?: 'list' | 'cards';
}) {
  const { loc } = useLanguage();
  const data = useReviews(initial);
  if (!data) return <Loading />;
  if (!data.count) {
    return (
      <Empty
        icon={<Star className="w-8 h-8 text-zinc-600" strokeWidth={1.5} aria-hidden="true" />}
        text={loc('لا توجد تقييمات بعد', 'No reviews yet', 'هێشتا هەڵسەنگاندن نییە')}
        hint={loc('التقييمات تأتي من طلبات مكتملة فقط.', 'Reviews come only from completed orders.', 'هەڵسەنگاندنەکان تەنها لە داواکاریە تەواوکراوەکانەوە دێن.')}
      />
    );
  }
  return (
    <div className="space-y-3">
      {summary && (
        <div className="sf-card sf-card-pad">
          <div className="flex items-center gap-4">
            <div className="text-center shrink-0">
              <div className="text-gold font-bold text-xl">{data.average?.toFixed(1)}</div>
              <div className="text-zinc-500 text-[10.5px]">{loc(`${data.count} تقييم`, `${data.count} reviews`, `${data.count} هەڵسەنگاندن`)}</div>
            </div>
            <div className="flex-1 space-y-1">
              {[5, 4, 3, 2, 1].map((n) => {
                const count = data.distribution[String(n)] ?? 0;
                const pct = data.count ? (count / data.count) * 100 : 0;
                return (
                  <div key={n} className="flex items-center gap-2" dir="ltr">
                    <span className="text-zinc-500 text-[10px] w-3">{n}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                      {/* A width this file computes from counts — never a merchant value. */}
                      <div className="h-full bg-gold/70 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-zinc-600 text-[10px] w-6 text-right">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {variant === 'cards' ? (
        <ReviewCards reviews={data.reviews.slice(0, limit)} />
      ) : (
        data.reviews.slice(0, limit).map((r) => (
        <div key={r.id} className="sf-card sf-card-pad">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-2 min-w-0">
              {/* Its own direction: «Omar N.» in an Arabic page kept its full stop on the wrong side. */}
              <span className="text-white text-[12.5px] font-semibold truncate" dir="auto">
                {r.customer_name}
              </span>
              {/* Every review here came from a completed transaction — the
                  database will not hold one that did not. */}
              <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                {loc('شراء موثّق', 'Verified', 'کڕینی پشتڕاستکراو')}
              </span>
            </div>
            <div className="flex gap-0.5 shrink-0" role="img" aria-label={`${r.rating}/5`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} className={`w-3 h-3 ${n <= r.rating ? 'text-gold fill-gold' : 'text-zinc-700'}`} aria-hidden="true" />
              ))}
            </div>
          </div>
          {!!r.body && <p className="text-zinc-300 text-[12.5px] leading-relaxed">{r.body}</p>}
          {!!r.merchant_reply && (
            <div className="mt-2.5 ps-3 border-s-2 border-gold/30">
              <p className="text-gold/80 text-[10.5px] font-semibold mb-0.5">{loc('رد البائع', 'Seller reply', 'وەڵامی فرۆشیار')}</p>
              <p className="text-zinc-400 text-[12px] leading-relaxed">{r.merchant_reply}</p>
            </div>
          )}
        </div>
        ))
      )}
    </div>
  );
}

/** The `cards` variant: stars first, the words in a card, side by side. */
function ReviewCards({ reviews }: { reviews: ReviewsData['reviews'] }) {
  const { loc } = useLanguage();
  return (
    <div
      data-reviews-variant="cards"
      className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 hide-scrollbar @min-[40rem]:mx-0 @min-[40rem]:grid @min-[40rem]:grid-cols-2 @min-[40rem]:overflow-visible @min-[40rem]:px-0 @min-[64rem]:grid-cols-3"
    >
      {reviews.map((r) => (
        <figure key={r.id} className="sf-card sf-card-pad flex w-[82%] shrink-0 snap-start flex-col gap-2.5 @min-[40rem]:w-auto">
          <div className="flex gap-0.5" role="img" aria-label={`${r.rating}/5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Star key={n} className={`w-4 h-4 ${n <= r.rating ? 'text-gold fill-gold' : 'text-zinc-700'}`} aria-hidden="true" />
            ))}
          </div>
          {!!r.body && (
            <blockquote className="text-zinc-200 text-[13px] leading-relaxed line-clamp-5" dir="auto">
              {r.body}
            </blockquote>
          )}
          <figcaption className="mt-auto flex items-center gap-2 min-w-0">
            <span className="text-zinc-400 text-[12px] font-semibold truncate" dir="auto">
              {r.customer_name}
            </span>
            <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
              {loc('شراء موثّق', 'Verified', 'کڕینی پشتڕاستکراو')}
            </span>
          </figcaption>
          {!!r.merchant_reply && (
            <div className="ps-3 border-s-2 border-gold/30">
              <p className="text-gold/80 text-[10.5px] font-semibold mb-0.5">{loc('رد البائع', 'Seller reply', 'وەڵامی فرۆشیار')}</p>
              <p className="text-zinc-400 text-[12px] leading-relaxed line-clamp-3">{r.merchant_reply}</p>
            </div>
          )}
        </figure>
      ))}
    </div>
  );
}

export default function ReviewsBlock({ block, data }: BlockProps<'reviews'>) {
  const text = useText();
  const { loc } = useLanguage();
  const rt = useStorefrontRuntime();
  const rows = useReviews(data.reviews);
  // No reviews yet: nothing on the live page; the builder's preview keeps the
  // empty state, so the merchant sees why the block shows nothing.
  if (rows && !rows.count && rt.mode === 'live') return null;
  return (
    <Column>
      <BlockHeading title={text(block.settings.title) || loc('التقييمات', 'Reviews', 'هەڵسەنگاندنەکان')} />
      {rows ? (
        <ReviewsView initial={rows} limit={block.settings.limit} summary={block.settings.show_summary} variant={block.variant === 'cards' ? 'cards' : 'list'} />
      ) : (
        <Loading />
      )}
    </Column>
  );
}
