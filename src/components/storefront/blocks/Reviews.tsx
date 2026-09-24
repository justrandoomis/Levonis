/**
 * REVIEWS — from completed orders only; the buyer's name is masked by the
 * server («Ahmed K.»). A summary with the distribution, then the newest.
 */
import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import type { ReviewsData } from '../../../../packages/storeLayout/src/data';
import { useStorefrontRuntime } from '../runtime';
import { BlockHeading, Column, Empty, Loading, useText } from '../parts';
import type { BlockProps } from '../types';

function useReviews(initial: ReviewsData | null): ReviewsData | null {
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

export function ReviewsView({ initial, limit = 20, summary = true }: { initial: ReviewsData | null; limit?: number; summary?: boolean }) {
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

      {data.reviews.slice(0, limit).map((r) => (
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
      ))}
    </div>
  );
}

export default function ReviewsBlock({ block, data }: BlockProps<'reviews'>) {
  const text = useText();
  const { loc } = useLanguage();
  return (
    <Column>
      <BlockHeading title={text(block.settings.title) || loc('التقييمات', 'Reviews', 'هەڵسەنگاندنەکان')} />
      <ReviewsView initial={data.reviews} limit={block.settings.limit} summary={block.settings.show_summary} />
    </Column>
  );
}
