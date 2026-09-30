/**
 * TABS — the classic storefront's tab strip: Products · Collections · Deals ·
 * Services · Showcase · About (+ reviews), in the order the layout lists them.
 * A tab with nothing behind it is not shown; About always is.
 *
 * The indicator is one element that travels (components/ui/Tabs), and the
 * body arrives from the side the change came from. Picking a collection hands
 * it to the Products tab as a server-side filter. The first page of every tab
 * arrived with the store, so switching tabs costs no request.
 *
 * Products — the tab a visitor lands on — ships with the storefront; the
 * other tabs' views are one lazy chunk (./tabViews.tsx) the renderer fetches
 * while the browser is idle.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { TabStrip, TabPanels } from '../../ui/Tabs';
import { Segmented } from '../../ui/Segmented';
import { useStorefrontRuntime, type ProductSort, type TabKind } from '../runtime';
import { useStoreTheme } from '../StoreTheme';
import { Column, Loading } from '../parts';
import { storefrontStrings } from '../strings';
import { useBlockRows } from '../useBlockRows';
import { ProductsView } from './ProductsGrid';
import type { BlockProps } from '../types';

/** The server's ceiling for a search term (worker/routes/storefront.ts `STORE_SEARCH_MAX`). */
const SEARCH_MAX = 60;
/** How long a pause in typing is a search — one request per thought, not per key. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * IN-STORE SEARCH AND SORT (storefront L11) — over the Products tab only. The
 * term is debounced and sent as the route's `q` (matched as a literal on the
 * server, so «50%» finds «50%»); the sort is one of the three names the
 * server knows, and «الأحدث» means the list's own order. Both are state of
 * this strip, so switching tabs and back keeps the search.
 */
export function ProductSearch({
  q,
  sort,
  onQuery,
  onSort,
}: {
  q: string;
  sort: ProductSort;
  onQuery: (q: string) => void;
  onSort: (sort: ProductSort) => void;
}) {
  const { lang } = useLanguage();
  const s = storefrontStrings(lang);
  const [typed, setTyped] = useState(q);
  useEffect(() => {
    const term = typed.trim().slice(0, SEARCH_MAX);
    if (term === q) return;
    const t = setTimeout(() => onQuery(term), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed, q, onQuery]);
  return (
    <div className="mb-3 space-y-2" data-store-search>
      <div className="relative">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" aria-hidden="true" />
        <input
          type="search"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          maxLength={SEARCH_MAX}
          placeholder={s.search.placeholder}
          aria-label={s.search.label}
          enterKeyHint="search"
          autoComplete="off"
          dir="auto"
          className="w-full h-10 rounded-xl border border-white/10 bg-white/[0.05] ps-9 pe-10 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-store-search-input
        />
        {typed && (
          <button
            type="button"
            onClick={() => {
              setTyped('');
              onQuery('');
            }}
            aria-label={s.search.clear}
            className="absolute end-1 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-lg text-zinc-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <Segmented
        size="sm"
        group="store-sort"
        label={s.sort.label}
        value={sort}
        onChange={(id) => onSort(id as ProductSort)}
        dataAttr="data-store-sort"
        items={[
          { id: 'new', label: s.sort.new },
          { id: 'price_asc', label: s.sort.priceAsc },
          { id: 'price_desc', label: s.sort.priceDesc },
        ]}
      />
    </div>
  );
}

const TabView = lazy(() => import('./tabViews').then((m) => ({ default: m.TabView })));

export default function TabsBlock({ block, store, data }: BlockProps<'tabs'>) {
  const { loc } = useLanguage();
  const { accent } = useStoreTheme();
  const rt = useStorefrontRuntime();
  const items = block.settings.items as TabKind[];
  const wants = (k: TabKind) => items.includes(k);

  // Rows a tab needs but the store's answer did not carry are fetched once —
  // a profile-only merchant has no store to ask, so nothing is.
  const live = !rt.profileOnly;
  const sections = useBlockRows(data.collections, rt.loadCollections, live && (wants('collections') || wants('products'))) ?? [];
  const services = useBlockRows(data.services, rt.loadServices, live && wants('services')) ?? [];
  const showcase = useBlockRows(data.showcase, rt.loadShowcase, live && wants('showcase')) ?? [];

  const [tab, setTab] = useState<TabKind>(() => {
    if (rt.section && wants('products')) return 'products';
    if (rt.section && wants('collections')) return 'collections';
    if (rt.initialTab && wants(rt.initialTab)) return rt.initialTab;
    return items.includes('products') ? 'products' : items[0];
  });
  // The section filter lives up here: the Collections tab picks one, the
  // Products tab shows it (with a clear chip). A strip WITHOUT a Products tab
  // shows the picked collection's products in the Collections tab itself —
  // picking one used to switch to a tab that was not there, and nothing moved.
  const [sectionFilter, setSectionFilter] = useState(rt.section);
  // The visitor's search and sort (L11): server queries, kept across tab changes.
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<ProductSort>('new');

  const show: Record<TabKind, boolean> = {
    products: true,
    collections: sections.length > 0,
    deals: (store.deal_count ?? 0) > 0,
    services: services.length > 0,
    showcase: showcase.length > 0,
    about: true,
  };
  const label: Record<TabKind, string> = {
    products: loc('المنتجات', 'Products', 'بەرهەمەکان'),
    collections: loc('الأقسام', 'Sections', 'بەشەکان'),
    deals: loc('العروض', 'Deals', 'ئۆفەرەکان'),
    services: loc('الخدمات', 'Services', 'خزمەتگوزاری'),
    showcase: loc('المعرض', 'Showcase', 'پیشانگا'),
    about: loc('عن المتجر', 'About', 'دەربارە'),
  };
  const TABS = items.map((id) => ({ id, label: label[id], show: show[id] }));
  const current = TABS.some((t) => t.id === tab && t.show) ? tab : (TABS.find((t) => t.show)?.id ?? tab);

  return (
    <Column>
      {/* Spread across the width, white when active over an accent-coloured
          indicator that travels as one element. Right-to-left in every
          language, as the rest of the classic page is drawn; the strip's arrow
          keys follow the strip's own direction (components/ui/Tabs, W6). */}
      <div dir="rtl" className="border-b border-white/10 mb-4 overflow-x-auto hide-scrollbar">
        <TabStrip
          group="storefront"
          label={loc('أقسام المتجر', 'Store sections', 'بەشەکانی فرۆشگا')}
          value={current}
          onChange={(id) => setTab(id as TabKind)}
          items={TABS.map((t) => ({ id: t.id, label: t.label, show: t.show }))}
          indicatorClassName={accent.indicator}
          idleClassName="text-zinc-500"
          className="min-w-full"
        />
      </div>

      <TabPanels value={current} order={TABS.map((t) => t.id)}>
        {current === 'products' || (current === 'collections' && sectionFilter && !wants('products')) ? (
          <>
            {/* A profile-only merchant has no store to search. */}
            {live && <ProductSearch q={q} sort={sort} onQuery={setQ} onSort={setSort} />}
            <ProductsView
              initial={data.products.latest}
              collections={sections}
              sectionFilter={sectionFilter}
              onClearSection={() => setSectionFilter('')}
              previewCount={block.settings.products_preview}
              storeOpen={!!store.open}
              query={{ q, sort }}
            />
          </>
        ) : (
          <Suspense fallback={<Loading />}>
            <TabView
              kind={current}
              store={store}
              data={data}
              sections={sections}
              services={services}
              showcase={showcase}
              aboutReviews={block.settings.about_reviews}
              onPickSection={(id) => {
                setSectionFilter(id);
                if (wants('products')) setTab('products');
              }}
            />
          </Suspense>
        )}
      </TabPanels>
    </Column>
  );
}
