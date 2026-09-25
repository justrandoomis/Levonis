/**
 * `/merchant/orders[/<id>]` — the list, or one order's own screen (W3-B).
 *
 * The list stays `OrdersTab` (dashboard/SalesTabs.tsx) unchanged; an address
 * that names an order opens `OrderDetailScreen` (../../orders/**), which
 * replaced the expanded row as the place an order is read in full. Each is
 * its own lazy chunk behind the same section skeleton.
 */
import { lazy } from 'react';
import type { SectionProps } from '../sections';
import { useWorkspace } from '../context';
import { merchantHref } from '../../../../lib/merchantRoutes';

const OrdersTab = lazy(() => import('../../dashboard/SalesTabs').then((m) => ({ default: m.OrdersTab })));
const OrderDetailScreen = lazy(() => import('../../orders/OrderDetailScreen'));

export default function OrdersSection({ id }: SectionProps) {
  const ws = useWorkspace();
  if (id) return <OrderDetailScreen key={id} id={id} />;
  return <OrdersTab initialStatus={ws.query.status ?? ''} orderHref={(orderId: string) => ws.href(merchantHref.order(orderId))} />;
}
