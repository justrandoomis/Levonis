import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import { type ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import SectionHeader from './SectionHeader';
import { productPrimaryImage } from '../../lib/productImage';
import { useMoney } from '../../CurrencyContext';

/**
 * THE FILAMENT SHELF — «الفيلمنت العشوائي», a dense swatch wall.
 *
 * WHY THIS LOOKS DIFFERENT FROM EVERY OTHER SHELF. Filament is bought by
 * COLOUR and by TYPE, and a shopper scanning for "a red PETG" is comparing
 * dozens of near-identical spools. A rail shows four of them and hides the
 * rest behind a swipe, which is the wrong shape for a decision made by
 * comparison. So this is a tight grid of square swatches — more of the range
 * visible at once, each one small because the picture IS the information.
 *
 * WHICH PRODUCTS. The taxonomy decides, never a name match: the materials
 * branch and everything under it (worker/lib/homeShelves.ts). Matching "PLA"
 * in a name would find "PLA-compatible nozzle"; matching the template family
 * would find RC kits, which share it.
 *
 * WHAT "RANDOM" MEANS HERE. Not `ORDER BY RANDOM()` — that re-rolls on every
 * request including the client's own refetch, so scrolling away and back would
 * show a different shelf and read as a bug. The server shuffles ids with a
 * seed that is stable inside a ten-minute bucket: one steady shelf while you
 * browse, a different handful when you come back.
 */
export default function FilamentShelf({ products }: { products: ApiProduct[] }) {
  const { money } = useMoney();
  const { t, loc } = useLanguage();
  if (products.length === 0) return null;

  return (
    <section data-home-section="filament" className="mb-10 sm:mb-12">
      <SectionHeader title={t('homeFilament')} accent="bg-info" to="/products" />
      <p className="text-[12px] text-zinc-500 -mt-2 mb-3">{t('homeFilamentSub')}</p>
      {/* Four across on a phone, eight on a desktop: a swatch is a picture and
          a price, and it does not need a card's chrome to be legible. */}
      <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2 sm:gap-2.5">
        {products.map((p) => {
          const price = p.display_price_iqd ?? p.price_iqd;
          return (
            <Link
              key={p.id}
              to={`/product/${p.slug || p.id}`}
              data-filament-swatch={p.id}
              title={p.name}
              className="group flex flex-col gap-1 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-lg"
            >
              <span className="block aspect-square overflow-hidden rounded-lg bg-black border border-border-subtle group-hover:border-info/50 transition-colors">
                <SafeImage
                  src={productPrimaryImage(p)}
                  alt={p.name}
                  aspect="auto"
                  className="w-full h-full group-hover:scale-[1.06] transition-transform duration-500 motion-reduce:transition-none"
                />
              </span>
              {/* The name is LTR and clipped to one line: a spool's name is a
                  code ("PLA Basic — Jade White"), and two lines of it here
                  would cost more height than the swatch itself. */}
              <span dir="ltr" className="block text-[10px] text-zinc-400 truncate text-start">
                {p.name}
              </span>
              <span className="block text-[11px] font-bold text-white tabular-nums truncate">
                {money(price)}
              </span>
            </Link>
          );
        })}
      </div>
      <span className="sr-only">{loc('عينة عشوائية تتغير كل عشر دقائق', 'A random sample that changes every ten minutes', 'نموونەیەکی هەڕەمەکی کە هەموو دە خولەکێک دەگۆڕێت')}</span>
    </section>
  );
}
