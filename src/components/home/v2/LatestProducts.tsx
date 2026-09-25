import React from 'react';
import { useLanguage } from '../../../LanguageContext';
import { api, type ApiProduct } from '../../../lib/api';
import { inSections, orderLatest, type LatestChip, type LatestChipId } from '../../../lib/homeLayout';
import { useRail } from '../../../lib/useRail';
import ProductCard from '../ProductCard';
import { ProductCardSkeleton } from '../../ui/Skeleton';
import SectionHead from './SectionHead';

/**
 * «أحدث المنتجات» with its filter chips.
 *
 * «الكل» is the newest-first list `/api/home` already returned — no request.
 * A section chip first shows what the page already holds for that section
 * (the newest list plus the shelves), then asks `/api/products` for the
 * section itself — once per chip, cached for the visit — so the filter is the
 * real catalogue and not "the few of them that happened to be on the page".
 *
 * ORDER: products that can be bought for direct sale right now come first,
 * then everything else, each group newest-first (src/lib/homeLayout.ts
 * `orderLatest`).
 *
 * THE CARD IS THE SHOP'S PRODUCT CARD, unchanged — the dark card on its own
 * dark panel, as the owner asked. On a phone the list is a rail (a row of
 * cards costs one card's height); on a wide screen it becomes a grid.
 */
const LIMIT = 10;

export default function LatestProducts({
  latest,
  pool,
  chips,
}: {
  latest: ApiProduct[];
  pool: ApiProduct[];
  chips: LatestChip[];
}) {
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
  const [active, setActive] = React.useState<LatestChipId>('all');
  const [fetched, setFetched] = React.useState<Partial<Record<LatestChipId, ApiProduct[]>>>({});
  const [failed, setFailed] = React.useState<Partial<Record<LatestChipId, boolean>>>({});
  const inflight = React.useRef(new Set<LatestChipId>());

  const chip = chips.find((c) => c.id === active) ?? chips[0];

  React.useEffect(() => {
    if (!chip || chip.id === 'all' || fetched[chip.id] || inflight.current.has(chip.id)) return;
    const id = chip.id;
    inflight.current.add(id);
    // One request per section the chip covers, in parallel — «الإكسسوارات»
    // covers two.
    Promise.all(
      chip.categoryIds.map((cat) =>
        api.get<{ products: ApiProduct[] }>(`/api/products?category=${encodeURIComponent(cat)}&limit=20`)
      )
    )
      .then((pages) => setFetched((prev) => ({ ...prev, [id]: pages.flatMap((p) => p.products ?? []) })))
      .catch(() => setFailed((prev) => ({ ...prev, [id]: true })))
      .finally(() => inflight.current.delete(id));
  }, [chip, fetched]);

  const products = React.useMemo(() => {
    if (!chip || chip.id === 'all') return orderLatest(latest).slice(0, LIMIT);
    const onPage = [...latest, ...pool].filter((p) => inSections(p, chip.memberIds));
    return orderLatest([...(fetched[chip.id] ?? []), ...onPage]).slice(0, LIMIT);
  }, [chip, latest, pool, fetched]);

  const waiting = !!chip && chip.id !== 'all' && !fetched[chip.id] && !failed[chip.id] && products.length === 0;

  // Back to the start of the rail when the filter changes, so a new list is
  // never shown already scrolled to its middle.
  React.useEffect(() => {
    railEl.current?.scrollTo({ left: 0 });
  }, [active]);

  if (latest.length === 0) return null;

  const label: Record<LatestChipId, string> = {
    all: loc('الكل', 'All', 'هەموو'),
    // OWNER: Sorani to be written by hand (printers, accessories chips and the section title).
    printers: loc('الطابعات', 'Printers'),
    filament: 'Filament',
    resin: 'Resin',
    accessories: loc('الإكسسوارات', 'Accessories'),
  };

  return (
    <section data-home-section="latest" aria-labelledby="home-latest-title">
      <SectionHead
        id="home-latest-title"
        title={loc('أحدث المنتجات', 'Latest products')}
        to={chip && chip.categoryIds.length === 1 ? `/products?category=${encodeURIComponent(chip.categoryIds[0])}` : '/products'}
      />

      {chips.length > 1 && (
        <div
          role="group"
          aria-label={loc('تصفية المنتجات', 'Filter products')}
          className="-mx-4 mb-2 flex gap-1.5 overflow-x-auto overscroll-x-contain px-4 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:mb-4 lg:px-0"
        >
          {chips.map((c) => {
            const on = c.id === active;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => setActive(c.id)}
                data-latest-chip={c.id}
                className="group inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none"
              >
                <span
                  className={`inline-flex h-8 items-center rounded-full px-3.5 text-[12.5px] font-semibold transition-colors group-focus-visible:ring-2 group-focus-visible:ring-focus ${
                    on ? 'bg-white text-black' : 'border border-border-subtle bg-surface text-text-secondary group-hover:border-zinc-700 group-hover:text-text-primary'
                  }`}
                >
                  {label[c.id]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* The rail: the whole card row scrolls sideways on a phone and becomes
          a five-column grid from 1024px. aria-live so a screen reader hears
          that the list changed after a chip. */}
      <div
        ref={setRail}
        aria-live="polite"
        aria-busy={waiting || undefined}
        className="-mx-4 flex snap-x gap-2.5 overflow-x-auto overscroll-x-contain px-4 pb-1 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-5 lg:gap-4 lg:overflow-visible lg:px-0"
      >
        {waiting
          ? Array.from({ length: 4 }, (_, i) => (
              <ProductCardSkeleton key={i} className="w-[156px] shrink-0 lg:w-auto" />
            ))
          : products.map((p) => (
              <div key={p.id} className="flex shrink-0 snap-start">
                <ProductCard p={p} widthClass="w-[156px] sm:w-[176px] lg:w-full" />
              </div>
            ))}
      </div>
      {!waiting && products.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-5 text-center text-[13px] text-text-secondary">
          {failed[active] ? (
            <>
              <p>{loc('تعذر تحميل هذا القسم الآن.', 'This section could not be loaded right now.')}</p>
              <button
                type="button"
                onClick={() => setFailed((prev) => ({ ...prev, [active]: false }))}
                className="min-h-11 rounded-lg px-3 font-semibold text-text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {loc('إعادة المحاولة', 'Retry', 'دووبارە هەوڵ بدەوە')}
              </button>
            </>
          ) : (
            <p>{loc('لا توجد منتجات في هذا القسم بعد.', 'No products in this section yet.')}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
