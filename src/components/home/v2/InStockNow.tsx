import React from 'react';
import { Check } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api, type ApiProduct, type HomeTaxon } from '../../../lib/api';
import { inSections } from '../../../lib/homeLayout';
import { IN_STOCK_PATH, inStockCatalogPath, inStockCatalogs, inStockOnly, inStockSeeAll } from '../../../lib/inStockShelf';
import { useRail } from '../../../lib/useRail';
import ProductCard from '../ProductCard';
import { ProductCardSkeleton } from '../../ui/Skeleton';
import SectionHead from './SectionHead';

/**
 * «متوفر الآن» — products that can be bought for direct sale right now, with
 * one chip per catalog that holds them (src/lib/inStockShelf.ts). Drawn just
 * below the two editorial banners (owner, 2026-11-18).
 *
 * ONE REQUEST to open (`avail=1`, the server's in-stock filter); a catalog
 * chip then asks for that catalog's own in-stock list once, cached for the
 * visit — the rail first shows what the opening list already holds for it.
 * Nothing in stock, or the request failed: the section is not drawn at all,
 * so the home never shows an empty «متوفر الآن».
 *
 * The rail and the card are «أحدث المنتجات»'s (LatestProducts.tsx): 148 px
 * cards that scroll on a phone, a five/six-column grid from 1024 px.
 */
const LIMIT = 12;
const ROWS_OF_FIVE = 10;

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
  const [opening, setOpening] = React.useState<ApiProduct[] | null>(null);
  const [active, setActive] = React.useState<string>('all');
  const [fetched, setFetched] = React.useState<Record<string, ApiProduct[]>>({});
  const inflight = React.useRef(new Set<string>());

  React.useEffect(() => {
    let live = true;
    api
      .get<{ products: ApiProduct[] }>(IN_STOCK_PATH)
      .then((r) => live && setOpening(inStockOnly(r.products ?? [])))
      .catch(() => live && setOpening([]));
    return () => {
      live = false;
    };
  }, []);

  const catalogs = React.useMemo(() => inStockCatalogs(tree, opening ?? []), [tree, opening]);
  const catalog = catalogs.find((c) => c.id === active);

  React.useEffect(() => {
    if (!catalog || fetched[catalog.id] || inflight.current.has(catalog.id)) return;
    const id = catalog.id;
    inflight.current.add(id);
    api
      .get<{ products: ApiProduct[] }>(inStockCatalogPath(id))
      .then((r) => setFetched((prev) => ({ ...prev, [id]: r.products ?? [] })))
      // The opening list still holds this catalog's products; a failed widen just keeps them.
      .catch(() => setFetched((prev) => ({ ...prev, [id]: [] })))
      .finally(() => inflight.current.delete(id));
  }, [catalog, fetched]);

  const products = React.useMemo(() => {
    const base = opening ?? [];
    if (!catalog) return base.slice(0, LIMIT);
    return inStockOnly([...base.filter((p) => inSections(p, catalog.memberIds)), ...(fetched[catalog.id] ?? [])]).slice(0, LIMIT);
  }, [opening, catalog, fetched]);

  React.useEffect(() => {
    railEl.current?.scrollTo({ left: 0 });
  }, [active]);

  if (opening === null) return <div aria-hidden="true" className="h-[330px]" />;
  if (opening.length === 0) return null;

  const chips = [
    { id: 'all', label: loc('الكل', 'All', 'هەموو') },
    ...catalogs.map((c) => ({ id: c.id, label: loc(c.node.name_ar, c.node.name_en, c.node.name_ckb) })),
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
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div
        ref={setRail}
        aria-live="polite"
        className="-mx-4 -my-2 flex snap-x gap-2.5 overflow-x-auto overscroll-x-contain px-4 pt-2 pb-3 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-5 lg:gap-4 lg:overflow-visible lg:px-0 2xl:grid-cols-6 2xl:gap-5"
      >
        {products.length === 0
          ? Array.from({ length: 4 }, (_, i) => (
              <ProductCardSkeleton key={i} density="compact" className="w-[148px] shrink-0 lg:w-auto" />
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
