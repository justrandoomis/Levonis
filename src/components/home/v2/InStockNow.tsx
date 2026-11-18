import React from 'react';
import { Check } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import type { HomeTaxon } from '../../../lib/api';
import { inStockResults, inStockSeeAll, interleave, startInStock, subscribeInStock } from '../../../lib/inStockShelf';
import { useRail } from '../../../lib/useRail';
import ProductCard from '../ProductCard';
import { ProductCardSkeleton } from '../../ui/Skeleton';
import SectionHead from './SectionHead';

/**
 * «متوفر الآن» — products that can be bought for direct sale right now, with
 * one chip per catalog that holds them (src/lib/inStockShelf.ts). Drawn just
 * below the two editorial banners (owner, 2026-11-18).
 *
 * The lists are asked for catalog by catalog, in parallel, when this section
 * mounts — right after the home page's first paint, not when scrolled to —
 * and it fills in as each answer lands. Its title and placeholder cards show at once; only
 * when EVERY catalog has answered with nothing is the section not drawn.
 *
 * The rail and the card are «أحدث المنتجات»'s (LatestProducts.tsx): 148 px
 * cards that scroll on a phone, a grid from 1024 px — up to three rows here
 * (15 cards at five across, 18 at six).
 */
const LIMIT = 18;
const ROWS_OF_FIVE = 15;

export default function InStockNow({ tree }: { tree: HomeTaxon[] }) {
  const { loc } = useLanguage();
  const rail = useRail();
  const railEl = React.useRef<HTMLDivElement | null>(null);
  const railRef = rail.ref;
  const setRail = React.useCallback(
    (node: HTMLDivElement | null) => {
      railEl.current = node;
      railRef(node);
    },
    [railRef]
  );
  const [active, setActive] = React.useState<string>('all');
  const [, rerender] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => subscribeInStock(rerender), []);
  React.useEffect(() => startInStock(tree), [tree]);

  const results = inStockResults(tree);
  const answered = tree.filter((n) => results[n.id] !== undefined).length;
  const done = tree.length > 0 && answered === tree.length;
  const catalogs = tree.filter((n) => (results[n.id]?.length ?? 0) > 0);
  const catalog = catalogs.find((c) => c.id === active);

  const products = (catalog ? results[catalog.id] ?? [] : interleave(catalogs.map((c) => results[c.id] ?? []))).slice(0, LIMIT);

  React.useEffect(() => {
    railEl.current?.scrollTo({ left: 0 });
  }, [active]);

  if (done && catalogs.length === 0) return null;
  const waiting = products.length === 0;

  const chips = [
    { id: 'all', label: loc('الكل', 'All', 'هەموو'), count: 0 },
    ...catalogs.map((c) => ({ id: c.id, label: loc(c.name_ar, c.name_en, c.name_ckb), count: results[c.id]?.length ?? 0 })),
  ];

  return (
    <section data-home-section="in-stock" aria-labelledby="home-in-stock-title">
      <SectionHead
        id="home-in-stock-title"
        title={loc('متوفر الآن', 'In stock now', 'ئێستا بەردەستە')}
        to={inStockSeeAll(catalog)}
      />

      {catalogs.length > 1 && (
        <div
          role="group"
          aria-label={loc('الفئات المتوفرة', 'Catalogs in stock', 'بەشە بەردەستەکان')}
          className="-mx-4 mb-2 flex gap-1.5 overflow-x-auto overscroll-x-contain px-4 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:mb-4 lg:px-0"
        >
          {chips.map((c) => {
            const on = c.id === (catalog?.id ?? 'all');
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => setActive(c.id)}
                data-in-stock-chip={c.id}
                className="group inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none"
              >
                <span
                  className={`inline-flex h-8 items-center gap-1 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors group-focus-visible:ring-2 group-focus-visible:ring-focus ${
                    on
                      ? 'border border-transparent bg-[var(--clay-well-bg)] text-text-primary shadow-press'
                      : 'border border-border-subtle bg-surface-raised text-text-secondary shadow-xs group-hover:text-text-primary'
                  }`}
                >
                  {on ? <Check aria-hidden="true" className="size-3.5" strokeWidth={2.6} /> : null}
                  {c.label}
                  {c.count > 0 ? <span className="tabular-nums text-text-tertiary">{c.count}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div
        ref={setRail}
        aria-live="polite"
        aria-busy={waiting || undefined}
        className="-mx-4 -my-2 flex snap-x gap-2.5 overflow-x-auto overscroll-x-contain px-4 pt-2 pb-3 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-5 lg:gap-4 lg:overflow-visible lg:px-0 2xl:grid-cols-6 2xl:gap-5"
      >
        {waiting
          ? Array.from({ length: 5 }, (_, i) => (
              <ProductCardSkeleton key={i} density="compact" className={`w-[148px] shrink-0 lg:w-auto ${i === 4 ? 'hidden lg:block' : ''}`} />
            ))
          : products.map((p, i) => (
              <div key={p.id} className={`flex shrink-0 snap-start ${i >= ROWS_OF_FIVE ? 'lg:hidden 2xl:flex' : ''}`}>
                <ProductCard p={p} density="compact" compareToggle widthClass="w-[148px] shrink-0 lg:w-full" imageSizes="(min-width: 1920px) 293px, (min-width: 1536px) calc((100vw - 164px) / 6), (min-width: 1024px) calc((100vw - 128px) / 5), 148px" />
              </div>
            ))}
      </div>
    </section>
  );
}
