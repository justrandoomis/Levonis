import React, { useEffect, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import { useRail } from '../../lib/useRail';
import AnimatedItem from '../AnimatedItem';
import SectionHeader from './SectionHeader';
import BundleTile, { type BundleCard } from '../bundles/BundleTile';

/**
 * THE HOME BUNDLES SHELF (docs/BUNDLES_MYSTERY.md §13.2).
 *
 * ITS OWN LAZY CHUNK, on purpose. `src/pages/Home.tsx` is eager — it is the
 * storefront's first paint — so importing the bundle card, the countdown, the
 * offer badge and the tier metadata from it would put all of them into the
 * entry chunk of every first visit, and quietly undo the split that moving
 * `Bundles` to `React.lazy` just achieved. `tests/bundleBudget.test.ts`
 * measures exactly that closure.
 *
 * ITS OWN REQUEST, also on purpose. `/api/home` is a wide read the whole
 * storefront waits on; a fifth query inside it would make first paint wait on
 * a shelf that renders nothing when the owner has published no bundles. A
 * failure here silently costs the shelf, never the home page.
 *
 * The shelf renders NOTHING until it has cards — no skeleton, no empty header.
 * An empty section that reserves space is worse than one that is simply not
 * there, and the owner's visibility toggle is what decides whether it may
 * appear at all.
 */
export default function BundlesShelf() {
  const { loc } = useLanguage();
  const rail = useRail();
  const [bundles, setBundles] = useState<BundleCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ bundles?: BundleCard[] }>('/api/bundles?limit=12')
      .then((r) => {
        if (!cancelled) setBundles(r.bundles ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (bundles.length === 0) return null;

  return (
    <section data-home-section="bundles" className="mb-10 sm:mb-12">
      {/* §13.3: page copy is inline trilingual, not a `src/translations.ts`
          key — that file ships to every visitor as `vendor-i18n`. */}
      <SectionHeader
        title={loc('الباقات والعروض', 'Bundles & offers', 'پاکێج و پێشنیارەکان')}
        accent="bg-gold"
        to="/bundles"
      />
      <div
        ref={rail.ref}
        className="flex gap-3 sm:gap-4 overflow-x-auto overscroll-x-contain hide-scrollbar pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x"
      >
        {bundles.map((b, index) => (
          <AnimatedItem key={b.id} index={index} className="snap-start shrink-0">
            <BundleTile b={b} className="w-[164px] sm:w-[190px]" />
          </AnimatedItem>
        ))}
      </div>
    </section>
  );
}
