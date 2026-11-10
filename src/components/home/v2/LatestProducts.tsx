import React from 'react';
import { Check } from 'lucide-react';
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
 * THE CARD IS THE SHOP'S COMPACT PRODUCT CARD (CATALOG_DISCOVERY §4), with
 * the compare toggle. On a phone the list is a rail of 148 px cards — two and
 * a half visible, which invites the swipe; on a wide screen it becomes a
 * grid.
 *
 * «العروض» — THE HOME'S WAY TO EVERY LIVE SALE (DECISIONS row 294). While the
 * page holds a product a live sale lowers (its card's own «from», the rule of
 * /offers), one more chip follows the sections: it lists those products —
 * and asks `/api/products?type=offers` for more, once — and «عرض الكل» then
 * opens /offers, every sale by occasion. No sale on the page, no chip: it
 * never promises a sale the shop does not have.
 */
// Two full rows at every grid width: 5 + 5 from 1024 px, 6 + 6 from 1536 px
// (the two extra cards are hidden below that — see the rail). A phone's rail
// scrolls, so it simply holds all twelve.
const LIMIT = 12;
const ROWS_OF_FIVE = 10;

/** A card whose own sale lowers its «from» right now — what /offers lists (`type=offers`). */
const onSale = (p: ApiProduct) => p.offer?.price_source === 'offer';
const OFFERS_CHIP: LatestChip = { id: 'offers', categoryIds: [], memberIds: new Set<string>() };

/** Where the rail's «عرض الكل» goes for a chip: /offers for «العروض», the section's own list, else every product. */
export function latestSeeAll(chip: Pick<LatestChip, 'id' | 'categoryIds'> | undefined): string {
  if (chip?.id === 'offers') return '/offers';
  return chip && chip.categoryIds.length === 1 ? `/products?category=${encodeURIComponent(chip.categoryIds[0])}` : '/products';
}

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

  // «العروض» joins the sections only while a live sale is on the page.
  const saleOnPage = React.useMemo(() => latest.some(onSale) || pool.some(onSale), [latest, pool]);
  const shownChips = React.useMemo(() => (saleOnPage ? [...chips, OFFERS_CHIP] : chips), [chips, saleOnPage]);
  const chip = shownChips.find((c) => c.id === active) ?? shownChips[0];

  React.useEffect(() => {
    if (!chip || chip.id === 'all' || fetched[chip.id] || inflight.current.has(chip.id)) return;
    const id = chip.id;
    inflight.current.add(id);
    // One request per section the chip covers, in parallel — «الإكسسوارات»
    // covers two; «العروض» asks the sales list itself.
    const paths =
      id === 'offers'
        ? ['/api/products?type=offers&limit=20']
        : chip.categoryIds.map((cat) => `/api/products?category=${encodeURIComponent(cat)}&limit=20`);
    Promise.all(paths.map((path) => api.get<{ products: ApiProduct[] }>(path)))
      .then((pages) => setFetched((prev) => ({ ...prev, [id]: pages.flatMap((p) => p.products ?? []) })))
      .catch(() => setFailed((prev) => ({ ...prev, [id]: true })))
      .finally(() => inflight.current.delete(id));
  }, [chip, fetched]);

  const products = React.useMemo(() => {
    if (!chip || chip.id === 'all') return orderLatest(latest).slice(0, LIMIT);
    const onPage = [...latest, ...pool].filter((p) => (chip.id === 'offers' ? onSale(p) : inSections(p, chip.memberIds)));
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
    printers: loc('الطابعات', 'Printers', 'چاپکەرەکان'),
    filament: 'Filament',
    resin: 'Resin',
    accessories: loc('الإكسسوارات', 'Accessories', 'ئێکسسوارەکان'),
    offers: loc('العروض', 'Deals', 'ئۆفەرەکان'),
  };

  return (
    <section data-home-section="latest" aria-labelledby="home-latest-title">
      <SectionHead id="home-latest-title" title={loc('أحدث المنتجات', 'Latest products', 'نوێترین بەرهەمەکان')} to={latestSeeAll(chip)} />

      {shownChips.length > 1 && (
        <div
          role="group"
          aria-label={loc('تصفية المنتجات', 'Filter products', 'پاڵاوتنی بەرهەمەکان')}
          className="-mx-4 mb-2 flex gap-1.5 overflow-x-auto overscroll-x-contain px-4 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:mb-4 lg:px-0"
        >
          {shownChips.map((c) => {
            // The chip on screen: a chosen «العروض» whose sale has since left the page falls back to «الكل».
            const on = c.id === chip?.id;
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
                  className={`inline-flex h-8 items-center gap-1 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors group-focus-visible:ring-2 group-focus-visible:ring-focus ${
                    // Clay filter chip: flush at rest, pressed (well + press + check) when on.
                    on
                      ? 'border border-transparent bg-[var(--clay-well-bg)] text-text-primary shadow-press'
                      : 'border border-border-subtle bg-surface-raised text-text-secondary shadow-xs group-hover:text-text-primary'
                  }`}
                >
                  {on ? <Check aria-hidden="true" className="size-3.5" strokeWidth={2.6} /> : null}
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
        // -my-2 pt-2 pb-3: a scroller clips on both axes, so it keeps room for
        // the cards' clay cast and focus ring; the layout nets the old pb-1.
        className="-mx-4 -my-2 flex snap-x gap-2.5 overflow-x-auto overscroll-x-contain px-4 pt-2 pb-3 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-5 lg:gap-4 lg:overflow-visible lg:px-0 2xl:grid-cols-6 2xl:gap-5"
      >
        {waiting
          ? Array.from({ length: 4 }, (_, i) => (
              <ProductCardSkeleton key={i} density="compact" className="w-[148px] shrink-0 lg:w-auto" />
            ))
          : products.map((p, i) => (
              <div key={p.id} className={`flex shrink-0 snap-start ${i >= ROWS_OF_FIVE ? 'lg:hidden 2xl:flex' : ''}`}>
                <ProductCard p={p} density="compact" compareToggle widthClass="w-[148px] shrink-0 lg:w-full" imageSizes="(min-width: 1920px) 293px, (min-width: 1536px) calc((100vw - 164px) / 6), (min-width: 1024px) calc((100vw - 128px) / 5), 148px" />
              </div>
            ))}
      </div>
      {!waiting && products.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-5 text-center text-[13px] text-text-secondary">
          {failed[active] ? (
            <>
              <p>{loc('تعذر تحميل هذا القسم الآن.', 'This section could not be loaded right now.', 'ئێستا ئەم بەشە بار نەبوو.')}</p>
              <button
                type="button"
                onClick={() => setFailed((prev) => ({ ...prev, [active]: false }))}
                className="min-h-11 rounded-lg px-3 font-semibold text-text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {loc('إعادة المحاولة', 'Retry', 'دووبارە هەوڵ بدەوە')}
              </button>
            </>
          ) : (
            <p>{loc('لا توجد منتجات في هذا القسم بعد.', 'No products in this section yet.', 'هێشتا هیچ بەرهەمێک لەم بەشەدا نییە.')}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
