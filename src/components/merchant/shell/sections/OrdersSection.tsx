/**
 * `/merchant/orders[/<id>]` — the list, or one order's own screen (W3-B).
 *
 * The list is `OrdersList` (../../orders/OrdersList.tsx, merchant platform v2
 * §3.3: DataList, server search, bulk moves, tracking on ship, slips, CSV),
 * which replaced `SalesTabs.OrdersTab` here; an address that names an order
 * opens `OrderDetailScreen` (../../orders/**), the place an order is read in
 * full. Each is its own lazy chunk behind the same section skeleton.
 *
 * THE LIST'S STATE IS THE ADDRESS. Its status tab, its search and how many
 * pages are open are written back to `?status&q&pages` as they change
 * (replace, never push — a typed search is not a history step), and read
 * from it on every mount: the browser's Back from an order lands on the
 * same list, and the order screen's own «all orders» link goes to the last
 * list this section showed, not to a fresh one.
 */
import { lazy, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import type { SectionProps } from '../sections';
import { useWorkspace } from '../context';
import { merchantHref } from '../../../../lib/merchantRoutes';
import { ordersViewHref, readOrdersView, type OrdersView } from '../../orders/ordersView';

const OrdersList = lazy(() => import('../../orders/OrdersList'));
const OrderDetailScreen = lazy(() => import('../../orders/OrderDetailScreen'));

/** The list's address as last shown, and whose — this tab's memory only, never stored. */
let lastList: { store: string; link: string } | null = null;

export default function OrdersSection({ id }: SectionProps) {
  const ws = useWorkspace();
  const { search } = useLocation();
  const query = useMemo(() => readOrdersView(search), [search]);
  useEffect(() => {
    if (!id) lastList = { store: ws.store.id, link: ordersViewHref(query) };
  }, [id, query, ws.store.id]);
  if (id) {
    const back = lastList?.store === ws.store.id ? lastList.link : merchantHref.orders();
    return <OrderDetailScreen key={id} id={id} backHref={ws.href(back)} />;
  }
  return (
    <OrdersList
      initialStatus={query.status ?? ''}
      initialQuery={query.q ?? ''}
      initialPages={query.pages ?? 1}
      onViewChange={(view: OrdersView) => ws.go(ordersViewHref(view), { replace: true })}
      orderHref={(orderId: string) => ws.href(merchantHref.order(orderId))}
      storeName={ws.store.name}
      storeId={ws.store.id}
      stageCounts={ws.attention.data?.orders?.by_stage}
      onChanged={() => ws.attention.refresh(true)}
    />
  );
}
