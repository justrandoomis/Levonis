/**
 * `/merchant/orders[/<id>]` — the list, or one order's own screen (W3-B).
 *
 * The list is `OrdersList` (../../orders/OrdersList.tsx, merchant platform v2
 * §3.3: DataList, server search, bulk moves, tracking on ship, slips, CSV),
 * which replaced `SalesTabs.OrdersTab` here; an address that names an order
 * opens `OrderDetailScreen` (../../orders/**), the place an order is read in
 * full. Each is its own lazy chunk behind the same section skeleton.
 */
import { lazy } from 'react';
import type { SectionProps } from '../sections';
import { useWorkspace } from '../context';
import { merchantHref } from '../../../../lib/merchantRoutes';

const OrdersList = lazy(() => import('../../orders/OrdersList'));
const OrderDetailScreen = lazy(() => import('../../orders/OrderDetailScreen'));

export default function OrdersSection({ id }: SectionProps) {
  const ws = useWorkspace();
  if (id) return <OrderDetailScreen key={id} id={id} />;
  return (
    <OrdersList
      initialStatus={ws.query.status ?? ''}
      orderHref={(orderId: string) => ws.href(merchantHref.order(orderId))}
      storeName={ws.store.name}
      stageCounts={ws.attention.data?.orders?.by_stage}
      onChanged={() => ws.attention.refresh(true)}
    />
  );
}
