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
 *
 * STOREFRONT L12 (merchant platform V2). The route always carried each
 * review's `images` and a `next_cursor`; the block showed neither. Now: the
 * pictures as a four-column strip under the words, four chips over the list
 * (all · ★5 · ★4 · 📷) that ask the server for `?rating=` / `?photos=1`, and
 * «المزيد» that pages by the cursor. The summary stays the whole store's
 * whatever chip is chosen — a filter narrows the page, never the rating.
 */
import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Segmented } from '../../ui/Segmented';
import type { ReviewsData } from '../../../../packages/storeLayout/src/data';
import { useStorefrontRuntime, type ReviewQuery } from '../runtime';
import { BlockHeading, Column, Empty, Loading, useText } from '../parts';
import { storefrontStrings } from '../strings';
import type { BlockProps } from '../types';

/** The four chips; `all` is the page that arrived with the store. */
export type ReviewFilter = 'all' | '5' | '4' | 'photos';
export const REVIEW_FILTERS: readonly ReviewFilter[] = ['all', '5', '4', 'photos'];

/** What one chip asks the server for. */
export function reviewQueryOf(filter: ReviewFilter): ReviewQuery {
  if (filter === 'photos') return { photos: true };
  if (filter === 'all') return {};
  return { rating: Number(filter) };
}

const EMPTY: ReviewsData = { average: null, count: 0, distribution: {}, reviews: [], next_cursor: null };

/**
 * The reviews on screen: the page that came with the store for «all», a
 * server page for any other chip, and «المزيد» appending the next page under
 * the same chip. `null` while a page is on its way.
 */
export function useReviews(initial: ReviewsData | null, filter: ReviewFilter = 'all') {
  const rt = useStorefrontRuntime();
  const [data, setData] = useState<ReviewsData | null>(filter === 'all' ? initial : null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initial && filter === 'all') {
      setData(initial);
      return;
    }
    let alive = true;
    setData(null);
    rt.loadReviews(reviewQueryOf(filter))
      .then((d) => alive && setData(d))
      // A failed filter shows the page we had, never a broken block.
      .catch(() => alive && setData(initial ?? EMPTY));
    return () => {
      alive = false;
    };
  }, [initial, rt, filter]);

  async function more() {
    if (!data?.next_cursor || busy) return;
    setBusy(true);
    try {
      const d = await rt.loadReviews({ ...reviewQueryOf(filter), cursor: data.next_cursor });
      setData((cur) => (cur ? { ...cur, reviews: [...cur.reviews, ...d.reviews], next_cursor: d.next_cursor } : d));
    } catch {
      /* keep the page we have */
    } finally {
      setBusy(false);
    }
  }
  return { data, busy, more };
}

export function ReviewsView({
  initial,
  limit = 20,
  summary = true,
  variant = 'list',
  filters = false,
}: {
  initial: ReviewsData | null;
  limit?: number;
  summary?: boolean;
  variant?: 'list' | 'cards';
  /** The chips and «المزيد» (L12) — the reviews block; the About tab's embed stays a plain first page. */
  filters?: boolean;
}) {
  const { loc, lang } = useLanguage();
  const s = storefrontStrings(lang);
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const { data, busy, more } = useReviews(initial, filters ? filter : 'all');
  // The whole store's rating, whichever chip is on: the first page carries it
  // and a filtered page repeats it (the route sums every visible review).
  const total = data ?? (filters ? initial : null);
  if (!total) return <Loading />;
  if (!total.count) {
    return (
      <Empty
        icon={<Star className="w-8 h-8 text-zinc-600" strokeWidth={1.5} aria-hidden="true" />}
        text={loc('لا توجد تقييمات بعد', 'No reviews yet', 'هێشتا هەڵسەنگاندن نییە')}
        hint={loc('التقييمات تأتي من طلبات مكتملة فقط.', 'Reviews come only from completed orders.', 'هەڵسەنگاندنەکان تەنها لە داواکاریە تەواوکراوەکانەوە دێن.')}
      />
    );
  }
  const reviews = data?.reviews ?? [];
  const shown = expanded || !filters ? reviews.slice(0, expanded ? undefined : limit) : reviews.slice(0, limit);
  const hidden = !expanded && reviews.length > limit;
  const canMore = filters && (hidden || !!data?.next_cursor);
  return (
    <div className="space-y-3">
      {summary && (
        <div className="sf-card sf-card-pad">
          <div className="flex items-center gap-4">
            <div className="text-center shrink-0">
              <div className="text-gold font-bold text-xl">{total.average?.toFixed(1)}</div>
              <div className="text-zinc-500 text-[10.5px]">{loc(`${total.count} تقييم`, `${total.count} reviews`, `${total.count} هەڵسەنگاندن`)}</div>
            </div>
            <div className="flex-1 space-y-1">
              {[5, 4, 3, 2, 1].map((n) => {
                const count = total.distribution[String(n)] ?? 0;
                const pct = total.count ? (count / total.count) * 100 : 0;
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

      {filters && (
        <Segmented
          size="sm"
          group="store-reviews"
          label={s.reviews.filterLabel}
          value={filter}
          onChange={(id) => {
            setFilter(id as ReviewFilter);
            setExpanded(false);
          }}
          dataAttr="data-review-filter"
          items={[
            { id: 'all', label: s.reviews.all },
            { id: '5', label: <StarsLabel n={5} text={s.reviews.stars(5)} /> },
            { id: '4', label: <StarsLabel n={4} text={s.reviews.stars(4)} /> },
            {
              id: 'photos',
              label: (
                <>
                  <span className="sr-only">{s.reviews.withPhotos}</span>
                  <span aria-hidden="true">📷</span>
                </>
              ),
            },
          ]}
        />
      )}

      {data === null ? (
        <Loading />
      ) : !reviews.length ? (
        <p className="text-zinc-500 text-[12.5px] text-center py-6" data-reviews-none>
          {s.reviews.noneFiltered}
        </p>
      ) : variant === 'cards' ? (
        <ReviewCards reviews={shown} photoAlt={s.reviews.photoAlt} />
      ) : (
        shown.map((r) => (
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
          <ReviewPhotos images={r.images} alt={s.reviews.photoAlt} />
          {!!r.merchant_reply && (
            <div className="mt-2.5 ps-3 border-s-2 border-gold/30">
              <p className="text-gold/80 text-[10.5px] font-semibold mb-0.5">{loc('رد البائع', 'Seller reply', 'وەڵامی فرۆشیار')}</p>
              <p className="text-zinc-400 text-[12px] leading-relaxed">{r.merchant_reply}</p>
            </div>
          )}
        </div>
        ))
      )}

      {canMore && (
        <button
          type="button"
          onClick={() => {
            if (hidden) setExpanded(true);
            else void more();
          }}
          disabled={busy}
          className="w-full h-10 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12.5px] font-medium disabled:opacity-50"
          data-reviews-more
        >
          {busy ? s.reviews.loadingMore : s.reviews.more}
        </button>
      )}
    </div>
  );
}

/** «★5» drawn, «5 stars» read. */
function StarsLabel({ n, text }: { n: number; text: string }) {
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" dir="ltr">
        ★{n}
      </span>
    </>
  );
}

/**
 * The reviewer's pictures (the server keeps at most six of their own uploads):
 * a four-column strip in the theme's small radius. Each opens the picture
 * itself in a new tab until the store viewer lands (storefront W-viewer);
 * the tab gets no handle on this page.
 */
function ReviewPhotos({ images, alt }: { images: string[]; alt: (n: number) => string }) {
  if (!images.length) return null;
  return (
    <div className="mt-2 grid grid-cols-4 gap-1 sf-r-sm overflow-hidden" data-review-photos={images.length}>
      {images.map((src, i) => (
        <a key={src} href={src} target="_blank" rel="noopener noreferrer" className="block aspect-square sf-well overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <img src={src} alt={alt(i + 1)} className="w-full h-full object-cover" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

/** The `cards` variant: stars first, the words in a card, side by side. */
function ReviewCards({ reviews, photoAlt }: { reviews: ReviewsData['reviews']; photoAlt: (n: number) => string }) {
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
          <ReviewPhotos images={r.images} alt={photoAlt} />
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
  const { data: rows } = useReviews(data.reviews);
  // No reviews yet: nothing on the live page; the builder's preview keeps the
  // empty state, so the merchant sees why the block shows nothing.
  if (rows && !rows.count && rt.mode === 'live') return null;
  return (
    <Column>
      <BlockHeading title={text(block.settings.title) || loc('التقييمات', 'Reviews', 'هەڵسەنگاندنەکان')} />
      {rows ? (
        <ReviewsView initial={rows} limit={block.settings.limit} summary={block.settings.show_summary} variant={block.variant === 'cards' ? 'cards' : 'list'} filters />
      ) : (
        <Loading />
      )}
    </Column>
  );
}
