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
import { lazy, Suspense, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { TabStrip, TabPanels } from '../../ui/Tabs';
import { useStorefrontRuntime, type TabKind } from '../runtime';
import { useStoreTheme } from '../StoreTheme';
import { Column, Loading } from '../parts';
import { useBlockRows } from '../useBlockRows';
import { ProductsView } from './ProductsGrid';
import type { BlockProps } from '../types';

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
    if (rt.initialTab && wants(rt.initialTab)) return rt.initialTab;
    return items.includes('products') ? 'products' : items[0];
  });
  // The section filter lives up here: the Collections tab picks one, the
  // Products tab shows it (with a clear chip).
  const [sectionFilter, setSectionFilter] = useState(rt.section);

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
          indicator that travels as one element. */}
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
        {current === 'products' ? (
          <ProductsView
            initial={data.products.latest}
            collections={sections}
            sectionFilter={sectionFilter}
            onClearSection={() => setSectionFilter('')}
            previewCount={block.settings.products_preview}
            storeOpen={!!store.open}
          />
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
                setTab('products');
              }}
            />
          </Suspense>
        )}
      </TabPanels>
    </Column>
  );
}
