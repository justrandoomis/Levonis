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

/**
 * The verb on the button that makes a move — the order screen's one primary
 * action. The same words as the list's tray (./strings.ts `moveLabel`;
 * tests/ordersListUi.test.ts holds the two equal), repeated here for the
 * same reason as the status words.
 */
export function orderMoveLabel(to: string, loc: Loc): string {
  switch (to) {
    case 'confirmed': return loc('تأكيد', 'Confirm', 'پشتڕاستکردنەوە');
    case 'processing': return loc('بدء التجهيز', 'Start preparing', 'دەستپێکردنی ئامادەکردن');
    case 'shipped': return loc('شحن', 'Ship', 'ناردن');
    case 'delivered': return loc('تم التسليم', 'Delivered', 'گەیشت');
    default: return orderStatusLabel(to, loc);
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

/**
 * HOW AN ORDER IS PAID, SHOWN APART FROM WHERE IT IS IN THE FLOW — a second
 * chip beside the status, on the list, the order screen and the slip.
 * Display only: it is read from the order's own `payment_method_id` (and,
 * where the full order is read, what is still due at the door); nothing here
 * marks anything paid, and the money itself stays the ledger's.
 *
 *   paid         settled at checkout from the wallet — nothing at the door;
 *   cod          money is collected at the door (a cash order, or any order
 *                with something still due on delivery);
 *   instalments  financed (BNPL, Gini) — the platform's arrangement.
 *
 * `paymentMark` is the chip beside a status: none on a cancelled order —
 * its money went back, and the status chip already says so.
 */
export type OrderPayment = 'paid' | 'cod' | 'instalments';

export function orderPayment(o: { payment_method_id?: string | null; due_on_delivery_iqd?: number | null }): OrderPayment | null {
  const method = String(o.payment_method_id ?? '');
  const due = typeof o.due_on_delivery_iqd === 'number' && Number.isFinite(o.due_on_delivery_iqd) ? o.due_on_delivery_iqd : null;
  if (method === 'bnpl' || method === 'gini') return 'instalments';
  if (due !== null && due > 0) return 'cod';
  if (method === 'wallet' || method === 'full_advance') return 'paid';
  // A cash order the wallet covered in full owes nothing at the door; the
  // list's row does not carry what is due, so there a cash order reads as cash.
  if (method === 'cash') return due === 0 ? 'paid' : 'cod';
  return null;
}

export function paymentMark(o: { status?: string; payment_method_id?: string | null; due_on_delivery_iqd?: number | null }): OrderPayment | null {
  return o.status === 'cancelled' ? null : orderPayment(o);
}

export function orderPaymentLabel(p: OrderPayment, loc: Loc): string {
  switch (p) {
    case 'paid': return loc('مدفوع · محفظة', 'Paid · wallet', 'پارەدراو · جزدان');
    case 'cod': return loc('الدفع عند الاستلام', 'Cash on delivery', 'پارەدان لە کاتی گەیاندن');
    case 'instalments': return loc('تقسيط', 'Instalments', 'قیست');
  }
}

/** Cash still to collect is the one that needs the merchant: warning until the order is delivered. */
export function orderPaymentTone(p: OrderPayment, status: string): Tone {
  if (status === 'cancelled') return 'neutral';
  if (p === 'cod') return status === 'delivered' ? 'neutral' : 'warning';
  return p === 'paid' ? 'success' : 'neutral';
}

/** The three words without the language context — for a printed slip that is handed its language. */
export function locIn(lang: string): Loc {
  return (ar, en, ckb) => (lang === 'en' ? en : lang === 'ckb' ? ckb ?? ar : ar);
}
