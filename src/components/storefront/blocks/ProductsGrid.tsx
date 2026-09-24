/**
 * PRODUCTS — the store's products as a grid.
 *
 * `ProductsView` is the Products tab of the classic page, behaviour for
 * behaviour: featured first within what is loaded, six until «show all», then
 * paging from the server; a collection filter is a SERVER query, so a shelf's
 * whole contents are reachable, not only what one page held. The first page
 * arrives with the store (blocks_data) — no request before it paints.
 *
 * `ProductsGridBlock` is the stacked block: a source (latest, featured, deals,
 * one collection), a count, and «show more» that pages in place.
 */
import { useEffect, useState } from 'react';
import { ShoppingBag, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { productQueryKey, type CollectionData, type ProductPage } from '../../../../packages/storeLayout/src/data';
import { useStorefrontRuntime } from '../runtime';
import { useStoreTheme } from '../StoreTheme';
import { BlockHeading, Column, Empty, Loading, ProductGrid, useText, type CardProduct } from '../parts';
import type { BlockProps } from '../types';

export function collectionName(c: CollectionData | undefined, lang: string): string {
  if (!c) return '';
  return lang === 'en' || !c.name_ar ? c.name : c.name_ar;
}

interface ListState {
  key: string;
  items: CardProduct[] | null;
  cursor: string | null;
}

export function ProductsView({
  initial,
  collections,
  sectionFilter,
  onClearSection,
  previewCount,
  storeOpen,
}: {
  /** The first page of the store's newest products, when it came with the store. */
  initial: ProductPage | undefined;
  collections: CollectionData[];
  sectionFilter: string;
  onClearSection: () => void;
  previewCount: number;
  storeOpen: boolean;
}) {
  const { loc, lang } = useLanguage();
  const { accent } = useStoreTheme();
  const rt = useStorefrontRuntime();
  const injected = rt.injectedProducts;
  const preloaded = !sectionFilter && !injected ? initial : undefined;
  const [state, setState] = useState<ListState>(() => ({
    key: sectionFilter,
    items: injected ?? preloaded?.items ?? null,
    cursor: injected ? null : (preloaded?.next_cursor ?? null),
  }));
  const [more, setMore] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (injected) {
      setState({ key: sectionFilter, items: injected, cursor: null });
      return;
    }
    if (preloaded) {
      setState({ key: '', items: preloaded.items, cursor: preloaded.next_cursor });
      return;
    }
    let alive = true;
    setState({ key: sectionFilter, items: null, cursor: null });
    rt.loadProducts({ source: sectionFilter ? 'collection' : 'latest', collection_id: sectionFilter, cursor: null })
      .then((d) => alive && setState({ key: sectionFilter, items: d.items, cursor: d.next_cursor }))
      .catch(() => alive && setState({ key: sectionFilter, items: [], cursor: null }));
    return () => {
      alive = false;
    };
  }, [sectionFilter, injected, preloaded, rt]);

  async function loadMore() {
    if (!state.cursor) return;
    setMore(true);
    try {
      const d = await rt.loadProducts({ source: sectionFilter ? 'collection' : 'latest', collection_id: sectionFilter, cursor: state.cursor });
      setState((s) => ({ ...s, items: [...(s.items ?? []), ...d.items], cursor: d.next_cursor }));
    } catch {
      /* keep the page we have */
    } finally {
      setMore(false);
    }
  }

  const products = state.items;
  if (products === null) return <Loading />;

  const sectionName = sectionFilter ? collectionName(collections.find((x) => x.id === sectionFilter), lang) : '';
  const chip = (
    <button
      type="button"
      onClick={onClearSection}
      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-xl bg-white/[0.05] border border-white/10 text-zinc-200 text-[12px] font-medium"
    >
      <span dir="auto">{sectionName}</span>
      <X className="w-3.5 h-3.5 text-zinc-500" aria-hidden="true" />
    </button>
  );

  if (!products.length) {
    return (
      <div>
        {sectionFilter && <div className="mb-3">{chip}</div>}
        <Empty
          icon={<ShoppingBag className="w-8 h-8 text-zinc-600" strokeWidth={1.5} aria-hidden="true" />}
          text={
            sectionFilter
              ? loc('لا توجد منتجات في هذا القسم حاليًا', 'No products in this section right now', 'لەم بەشە بەرهەم نییە')
              : loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا بەرهەم نییە')
          }
        />
      </div>
    );
  }

  // The merchant's featured picks lead; within that, the server's order.
  const sorted = [...products].sort((a, b) => Number(!!b.featured) - Number(!!a.featured));
  const revealed = showAll || sectionFilter ? sorted : sorted.slice(0, previewCount);

  return (
    <div>
      <div dir="rtl" className="flex items-center justify-between mb-3">
        {sectionFilter ? chip : <h2 className="sf-title text-white">{loc('أحدث المنتجات', 'Latest products', 'نوێترین بەرهەمەکان')}</h2>}
        {!sectionFilter && (sorted.length > previewCount || state.cursor) && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className={`text-[13px] font-medium ${accent.text}`}>
            {showAll ? loc('عرض أقل', 'Show less', 'کەمتر') : loc('عرض الكل', 'View all', 'هەموو ببینە')}
          </button>
        )}
      </div>

      <ProductGrid products={revealed} storeOpen={storeOpen} legacyLinks={!!injected} />

      {state.cursor && (showAll || sectionFilter) && (
        <button
          type="button"
          onClick={loadMore}
          disabled={more}
          className="w-full h-10 mt-3 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12.5px] font-medium disabled:opacity-50"
        >
          {more ? loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…') : loc('عرض المزيد', 'Show more', 'زیاتر')}
        </button>
      )}
    </div>
  );
}

/** A page of products from one source, with «show more» paging in place. */
export function usePagedProducts(
  source: 'latest' | 'featured' | 'deals' | 'collection',
  collectionId: string,
  initial: ProductPage | undefined
) {
  const rt = useStorefrontRuntime();
  const [items, setItems] = useState<CardProduct[] | null>(initial?.items ?? null);
  const [cursor, setCursor] = useState<string | null>(initial?.next_cursor ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initial) {
      setItems(initial.items);
      setCursor(initial.next_cursor);
      return;
    }
    let alive = true;
    rt.loadProducts({ source, collection_id: collectionId, cursor: null })
      .then((d) => {
        if (!alive) return;
        setItems(d.items);
        setCursor(d.next_cursor);
      })
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [initial, source, collectionId, rt]);

  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const d = await rt.loadProducts({ source, collection_id: collectionId, cursor });
      setItems((prev) => [...(prev ?? []), ...d.items]);
      setCursor(d.next_cursor);
    } catch {
      /* keep what we have */
    } finally {
      setBusy(false);
    }
  }
  return { items, cursor, busy, more };
}

export default function ProductsGridBlock({ block, store, data }: BlockProps<'products_grid'>) {
  const s = block.settings;
  const text = useText();
  const { loc } = useLanguage();
  const initial = data.products[productQueryKey(s.source, s.collection_id)];
  const { items, cursor, busy, more } = usePagedProducts(s.source, s.collection_id, initial);
  const [expanded, setExpanded] = useState(false);
  if (items === null) return <Column><Loading /></Column>;
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, s.limit);
  // «Show more» first reveals what is loaded, then pages from the server;
  // it disappears when there is nothing left to show.
  const canMore = s.show_more && ((!expanded && items.length > s.limit) || !!cursor);
  return (
    <Column>
      <BlockHeading title={text(s.title)} />
      <ProductGrid products={shown} storeOpen={!!store.open} />
      {canMore && (
        <button
          type="button"
          onClick={() => {
            const hidden = !expanded && items.length > s.limit;
            setExpanded(true);
            if (!hidden) void more();
          }}
          disabled={busy}
          className="w-full h-10 mt-3 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12.5px] font-medium disabled:opacity-50"
        >
          {busy ? loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…') : loc('عرض المزيد', 'Show more', 'زیاتر')}
        </button>
      )}
    </Column>
  );
}
