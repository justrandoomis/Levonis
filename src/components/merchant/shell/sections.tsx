/**
 * EVERY WORKSPACE SCREEN, LAZILY — one `React.lazy` per section.
 *
 * The shell (this folder's MerchantShell and the page that renders it) is
 * the only part of the workspace a merchant downloads up front; each screen
 * is fetched the first time its address is opened, behind its own skeleton
 * (./SectionFallback), and none of it can ever reach a customer's first load
 * (tests/bundleBudget.test.ts, the workspace closure).
 *
 * The existing tabs are mounted UNCHANGED in behaviour — ProductsManager,
 * CatalogTabs, SalesTabs, StoreSettingsTab, PrintersTab, CostingTab,
 * StoreDesignPanel and the self-contained W2 screens (finance, delivery,
 * notifications, inbox). A wrapper here only hands a screen what the address
 * says: the object it names (`/orders/<id>`), a filter (`?status=pending`) or
 * a «new» form (`?new=1`). The wrappers are defined inside each lazy factory,
 * so the shell's chunk carries a few lines per screen and imports none of
 * them.
 */
import { lazy, type ComponentType, type LazyExoticComponent, type ReactElement } from 'react';
import { merchantHref, type MerchantSection } from '../../../lib/merchantRoutes';
import { useWorkspace, type WorkspaceValue } from './context';

export interface SectionProps {
  /** The object the address names (`/orders/<id>`), when it names one. */
  id?: string;
}

type Section = LazyExoticComponent<ComponentType<SectionProps>>;

/** A lazy screen whose module is `load()`, drawn by `render` with the workspace in hand. */
function section<M>(load: () => Promise<M>, render: (m: M, props: SectionProps, ws: WorkspaceValue) => ReactElement): Section {
  return lazy(async () => {
    const m = await load();
    function WorkspaceSection(props: SectionProps) {
      return render(m, props, useWorkspace());
    }
    return { default: WorkspaceSection };
  });
}

export const SECTIONS: Readonly<Record<MerchantSection, Section>> = {
  home: lazy(() => import('./sections/CommandCenter')),

  // `/orders` is the list; `/orders/<id>` is the order's own screen (W3-B),
  // its own chunk — the list does not download it, nor it the list.
  orders: lazy(() => import('./sections/OrdersSection')),
  custom_orders: section(() => import('../dashboard/SalesTabs'), (m) => <m.CustomOrdersTab />),
  requests: lazy(() => import('./sections/RequestsSection')),
  customers: lazy(() => import('./sections/CustomersSection')),
  coupons: section(
    () => import('../dashboard/SalesTabs'),
    (m, _p, ws) => <m.CouponsTab canSell={ws.canSell} startCreating={ws.query.create} onCreateHandled={ws.clearQuery} />
  ),

  products: section(
    () => import('../dashboard/ProductsManager'),
    (m, { id }, ws) => (
      <m.ProductsManager
        canSell={ws.canSell}
        store={ws.store}
        focusProductId={ws.query.create ? 'new' : id ?? null}
        initialState={ws.query.state}
        initialStock={ws.query.stock}
        onEditorClose={() => {
          if (id || ws.query.create) ws.go(ws.href(merchantHref.products()), { replace: true });
        }}
      />
    )
  ),
  collections: section(
    () => import('../dashboard/CatalogTabs'),
    (m, _p, ws) => <m.SectionsTab canSell={ws.canSell} autoFocusCreate={ws.query.create} />
  ),
  services: section(() => import('../dashboard/CatalogTabs'), (m, _p, ws) => <m.ServicesTab canSell={ws.canSell} />),
  showcase: section(() => import('../dashboard/CatalogTabs'), (m) => <m.ShowcaseTab />),

  printers: section(() => import('../dashboard/PrintersTab'), (m, _p, ws) => <m.PrintersTab canSell={ws.canSell} />),
  costing: section(() => import('../dashboard/CostingTab'), (m) => <m.CostingTab />),

  store_design: lazy(() => import('../storeDesign/StoreDesignPanel')),
  store_settings: section(
    () => import('../dashboard/StoreSettingsTab'),
    (m, _p, ws) => <m.StoreSettingsTab me={ws.me} onSaved={ws.reloadMe} deliveryHref={ws.href(merchantHref.storeDelivery())} />
  ),
  store_delivery: section(
    () => import('../delivery/DeliverySettingsEditor'),
    (m, _p, ws) => <m.default storeGovernorate={ws.store.governorate ?? ''} onSaved={ws.reloadMe} />
  ),

  money: section(
    () => import('../finance/MerchantFinance'),
    (m, _p, ws) => (
      <m.default
        onOpenOrder={(orderId) => ws.go(ws.href(merchantHref.order(orderId)))}
        onOpenCustomOrders={() => ws.go(ws.href(merchantHref.customOrders()))}
      />
    )
  ),
  analytics: lazy(() => import('./sections/AnalyticsSection')),
  reviews: lazy(() => import('./sections/ReviewsSection')),
  inbox: section(() => import('../inbox/MerchantInbox'), (m) => <m.default />),
  notifications: lazy(() => import('./sections/NotificationsSection')),
};
