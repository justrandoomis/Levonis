/**
 * STATS — real figures only: the rating from reviews, the share of 4★+
 * reviews, published products, followers, completed orders, and the year the
 * store joined. A metric with no data yet (no reviews) is left out — never a
 * made-up 100 %.
 */
import { useLanguage } from '../../../LanguageContext';
import { BlockHeading, Column, useText } from '../parts';
import type { BlockProps } from '../types';

export default function StatsBlock({ block, store }: BlockProps<'stats'>) {
  const { loc } = useLanguage();
  const text = useText();
  const values: Array<{ key: string; value: string; label: string }> = [];
  for (const m of block.settings.metrics) {
    if (m === 'rating' && store.merchant.rating !== null && store.merchant.rating !== undefined) {
      values.push({ key: m, value: store.merchant.rating.toFixed(1), label: loc(`تقييم (${store.merchant.rating_count})`, `Rating (${store.merchant.rating_count})`) });
    } else if (m === 'positive' && store.positive_pct !== null && store.positive_pct !== undefined) {
      values.push({ key: m, value: `${store.positive_pct}%`, label: loc('تقييم إيجابي', 'Positive rating', 'هەڵسەنگاندنی ئەرێنی') });
    } else if (m === 'products') {
      values.push({ key: m, value: String(store.product_count ?? 0), label: loc('منتجات', 'Products', 'بەرهەم') });
    } else if (m === 'followers') {
      values.push({ key: m, value: String(store.followers ?? 0), label: loc('متابعون', 'Followers', 'شوێنکەوتوو') });
    } else if (m === 'completed_orders') {
      values.push({ key: m, value: String(store.merchant.completed_orders ?? 0), label: loc('طلب مكتمل', 'Completed orders') });
    } else if (m === 'years' && store.created_at) {
      values.push({ key: m, value: String(new Date(store.created_at).getFullYear()), label: loc('على Levonis منذ', 'On Levonis since', 'لەسەر LEVONIS لە') });
    }
  }
  if (!values.length) return null;
  const cards = block.variant === 'cards';
  return (
    <Column>
      <BlockHeading title={text(block.settings.title)} />
      <div className={cards ? 'grid grid-cols-2 @min-[40rem]:grid-cols-4 sf-grid' : 'flex items-stretch'}>
        {values.map((v, i) => (
          <div
            key={v.key}
            className={cards ? 'sf-card sf-card-pad text-center' : `flex-1 py-1 px-1 text-center min-w-0 ${i ? 'border-s border-white/10' : ''}`}
          >
            <div className="text-white font-bold text-[16px] leading-tight tabular-nums" dir="ltr">
              {v.value}
            </div>
            <div className="text-zinc-500 text-[11px] truncate">{v.label}</div>
          </div>
        ))}
      </div>
      {/* OWNER: Sorani to be written by hand. */}
    </Column>
  );
}
