/**
 * The words of a store order's states — the same Arabic, English and
 * hand-written Sorani the orders list uses (dashboard/SalesTabs.tsx
 * `statusLabel`), repeated here so the detail screen's chunk does not pull the
 * whole list in. The moves are the server's flow (worker/routes/merchant.ts
 * MERCHANT_ORDER_FLOW); the server decides, this only offers them.
 */
import type { Tone } from '../../ui/Badge';

type Loc = (ar: string, en: string, ckb?: string) => string;

export const ORDER_FLOW: Readonly<Record<string, readonly string[]>> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function orderStatusLabel(k: string, loc: Loc): string {
  switch (k) {
    case 'pending': return loc('جديد', 'New', 'نوێ');
    case 'confirmed': return loc('مؤكد', 'Confirmed', 'پشتڕاستکراو');
    case 'processing': return loc('قيد التجهيز', 'Preparing', 'ئامادەکردن');
    case 'shipped': return loc('تم الشحن', 'Shipped', 'نێردرا');
    case 'delivered': return loc('تم التسليم', 'Delivered', 'گەیشت');
    case 'cancelled': return loc('ملغي', 'Cancelled', 'هەڵوەشێنراوە');
    default: return k;
  }
}

export function orderStatusTone(k: string): Tone {
  switch (k) {
    case 'pending': return 'warning';
    case 'confirmed':
    case 'processing':
    case 'shipped': return 'info';
    case 'delivered': return 'success';
    case 'cancelled': return 'danger';
    default: return 'neutral';
  }
}
