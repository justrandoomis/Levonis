import React from 'react';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import CardPrice from '../CardPrice';
import Countdown from '../ui/Countdown';
import SectionHeader from './SectionHeader';
import { productPrimaryImage } from '../../lib/productImage';

/**
 * FLASH DEALS — a board, not a rail, because the thing that makes a deal a
 * deal is the clock and a clock has to be READ, not flicked past.
 *
 * WHAT THIS IS BUILT ON. Nothing new: `offer_windows` (migration 0060) is the
 * shop's scheduled-offer table, the owner already edits it, and the product
 * page and the listing already honour it. It simply never reached the home
 * page, which passed a literal `null` where every other surface passes the
 * offer view — so a deal the owner scheduled priced correctly everywhere
 * except the screen every visitor lands on. See `homeRoutes` in
 * worker/routes/products.ts.
 *
 * THE COUNTDOWN IS DECORATION AND NOTHING ELSE. The API refuses an expired
 * offer on its own; this clock reaching zero changes no price here. It exists
 * so the shopper can see what "while it lasts" means, and one shared 1 Hz
 * ticker drives every instance on the page.
 *
 * THE PRICE IS THE SERVER'S OFFER PRICE, resolved by `resolveOfferPrice` — the
 * same resolution the checkout charges. Nothing on this card computes a
 * discount, which is what stops a shelf ever quoting a number the cart
 * refuses.
 */
export default function FlashDealsBoard({ products }: { products: ApiProduct[] }) {
  const { t } = useLanguage();
  if (products.length === 0) return null;

  // The first deal leads, at double width where there is room for it: a board
  // with one obvious headline reads as an event, a uniform grid reads as
  // another aisle.
  const [lead, ...rest] = products;

  return (
    <section data-home-section="flash_deals" className="mb-10 sm:mb-12">
      <SectionHeader title={t('homeFlashDeals')} accent="bg-rose-500" to="/products?type=discounted" />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
        {[lead, ...rest].map((p, index) => (
          <Link
            key={p.id}
            to={`/product/${p.slug || p.id}`}
            data-flash-deal={p.id}
            className={`group relative flex flex-col overflow-hidden rounded-2xl border border-rose-500/25 bg-surface hover:border-rose-500/50 transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              index === 0 ? 'col-span-2 sm:col-span-2 row-span-1' : ''
            }`}
          >
            <div className={`relative overflow-hidden bg-black ${index === 0 ? 'aspect-[2/1]' : 'aspect-square'}`}>
              <SafeImage
                src={productPrimaryImage(p)}
                alt={p.name}
                aspect="auto"
                className="w-full h-full group-hover:scale-[1.04] transition-transform duration-500 motion-reduce:transition-none"
              />
              <span className="absolute top-2 start-2 inline-flex items-center gap-1 rounded-md bg-rose-500/90 px-1.5 py-0.5 text-[10px] font-bold text-white">
                <Zap aria-hidden className="w-3 h-3" />
                {t('homeFlashDeals')}
              </span>
              {/* Only an offer that actually has an end time gets a clock. An
                  open-ended window is still a deal; it is just not a race. */}
              {p.offer?.ends_at && (
                <span className="absolute bottom-2 start-2 inline-flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 backdrop-blur-sm">
                  <span className="text-[10px] text-zinc-400">{t('homeEndsIn')}</span>
                  <Countdown target={p.offer.ends_at} kind="ends" className="text-[10px] font-bold text-white" />
                </span>
              )}
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
        ))}
      </div>
    </section>
  );
}
