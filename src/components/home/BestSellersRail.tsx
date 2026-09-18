import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import type { ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import CardPrice from '../CardPrice';
import SectionHeader from './SectionHeader';
import { productPrimaryImage } from '../../lib/productImage';
import { useRail } from '../../lib/useRail';

/**
 * THE ALSO-RAN PROBLEM, AND WHY THIS SHELF LOOKS LIKE A CHART.
 *
 * "Best sellers" is a RANKING, and a row of identical cards throws the ranking
 * away — the shopper cannot tell the shop's number one from its number nine,
 * which is the only information the shelf carries that the catalogue does not.
 * So the position is the loudest thing on each card: an oversized numeral
 * behind the picture, the way a chart prints one.
 *
 * The numeral is DECORATION and is marked as such. The ordering is already in
 * the DOM, so reading "1" aloud before the product name would be noise to a
 * screen reader; the rank lives in `aria-hidden` and the list order carries
 * the meaning.
 *
 * THE RANK IS THE SERVER'S. It comes from units actually sold in orders whose
 * stock has moved (worker/lib/soldStates.ts explains why that reading and not
 * the stricter one the sales badge prints). Nothing is re-sorted here.
 */
export default function BestSellersRail({ products }: { products: ApiProduct[] }) {
  const { t } = useLanguage();
  const rail = useRail();
  if (products.length === 0) return null;

  return (
    <section data-home-section="best_sellers" className="mb-10 sm:mb-12">
      <SectionHeader title={t('homeBestSellers')} accent="bg-gold" to="/products" />
      {/* A div rather than an <ol>: `useRail` owns a div ref, and the ranking
          is already carried by the DOM order and printed on each card. */}
      <div
        ref={rail.ref}
        className="flex gap-3 sm:gap-4 overflow-x-auto overscroll-x-contain hide-scrollbar pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x"
      >
        {products.map((p, index) => (
          <div key={p.id} className="snap-start shrink-0">
            <Link
              to={`/product/${p.slug || p.id}`}
              data-best-seller={p.id}
              className="group relative flex w-[168px] sm:w-[196px] flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface hover:bg-surface-raised transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <div className="relative aspect-square overflow-hidden bg-black">
                <SafeImage
                  src={productPrimaryImage(p)}
                  alt={p.name}
                  aspect="auto"
                  className="w-full h-full group-hover:scale-[1.04] transition-transform duration-500 motion-reduce:transition-none"
                />
                {/* The rank, set into the bottom corner and clipped by the
                    frame — big enough to read at a glance, dark enough not to
                    fight the product it is labelling. */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute -bottom-3 start-1 text-[64px] leading-none font-black text-white/15 tabular-nums select-none"
                  style={{ WebkitTextStroke: '1px rgba(186,163,105,0.35)' }}
                >
                  {index + 1}
                </span>
              </div>
              <div className="p-3 flex flex-col flex-1 min-w-0">
                <h3 dir="ltr" className="text-white font-medium text-[13px] leading-snug line-clamp-2 min-h-[2.2rem] text-start">
                  {p.name}
                </h3>
                <div className="mt-auto pt-2">
                  <CardPrice p={p} />
                </div>
              </div>
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
