/**
 * ONE PART OF THE STORE, BY ITS ADDRESS — on a page with no tab strip.
 *
 * The classic page answers `/products`, `/about`, `?tab=services`,
 * `?section=…` inside its Tabs block. Six of the seven starters have no Tabs
 * block, and on them every such address — a hero's button to «المنتجات», a
 * banner linked to «عن المتجر», a collection card — drew the same home page
 * again, so the link seemed to do nothing (review of the store builder,
 * 2026-09-28). Here the address gets a page of its own: the store's header,
 * the part it asked for with its title, and the way back to the store's home.
 *
 * It reuses the Tabs block's own views (./blocks/tabViews.tsx and the Products
 * view), so a part looks the same wherever it is reached from. Loaded lazily
 * by the renderer: a visitor landing on the home page never downloads it.
 */
import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { BlockData } from '../../../packages/storeLayout/src/data';
import type { HeaderVariant } from '../../../packages/storeLayout/src/schema';
import { useStorefrontRuntime, type TabKind } from './runtime';
import { Column, Loading } from './parts';
import { useBlockRows } from './useBlockRows';
import { ProductsView } from './blocks/ProductsGrid';
import type { StorefrontStore } from './types';

const TabView = lazy(() => import('./blocks/tabViews').then((m) => ({ default: m.TabView })));

export default function StoreViewPage({
  kind,
  store,
  data,
  header,
}: {
  kind: TabKind;
  store: StorefrontStore;
  data: BlockData;
  /** The overlay header floats over the page top: the page starts below its two controls. */
  header: HeaderVariant;
}) {
  const { loc } = useLanguage();
  const rt = useStorefrontRuntime();
  // Picking a collection on the Collections page shows its products here,
  // as the Tabs block does; the address stays the one the visitor opened.
  const [view, setView] = useState<TabKind>(kind);
  const [sectionFilter, setSectionFilter] = useState(rt.section);

  const live = !rt.profileOnly;
  const sections = useBlockRows(data.collections, rt.loadCollections, live && (view === 'collections' || view === 'products')) ?? [];
  const services = useBlockRows(data.services, rt.loadServices, live && view === 'services') ?? [];
  const showcase = useBlockRows(data.showcase, rt.loadShowcase, live && view === 'showcase') ?? [];

  const title: Record<TabKind, string> = {
    products: loc('المنتجات', 'Products', 'بەرهەمەکان'),
    collections: loc('الأقسام', 'Sections', 'بەشەکان'),
    deals: loc('العروض', 'Deals', 'ئۆفەرەکان'),
    services: loc('الخدمات', 'Services', 'خزمەتگوزاری'),
    showcase: loc('المعرض', 'Showcase', 'پیشانگا'),
    about: loc('عن المتجر', 'About', 'دەربارە'),
  };

  return (
    <div data-store-view={view} className={header === 'overlay' ? 'pt-16' : 'pt-4'}>
      <Column>
        <Link
          to={rt.routeHref('home')}
          className="relative lv-hit inline-flex min-h-11 items-center gap-1 rounded-lg text-[12.5px] font-medium text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-store-view-home
        >
          <ChevronRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />
          {/* OWNER: Sorani to be written by hand. */}
          {loc('الصفحة الرئيسية للمتجر', 'Store home')}
        </Link>
        <h1 className="sf-title text-white mt-1 mb-4 [text-wrap:balance]">{title[view]}</h1>
        {view === 'products' ? (
          <ProductsView
            initial={data.products.latest}
            collections={sections}
            sectionFilter={sectionFilter}
            onClearSection={() => setSectionFilter('')}
            previewCount={24}
            storeOpen={!!store.open}
            expanded
          />
        ) : (
          <Suspense fallback={<Loading />}>
            <TabView
              kind={view}
              store={store}
              data={data}
              sections={sections}
              services={services}
              showcase={showcase}
              aboutReviews
              onPickSection={(id) => {
                setSectionFilter(id);
                setView('products');
              }}
            />
          </Suspense>
        )}
      </Column>
    </div>
  );
}
