/**
 * HOW AN ORDER IS PAID, AS ITS OWN CHIP — beside the status chip on the
 * orders list and on the order's own screen, never folded into it. No dot
 * (the status chip has one) and an icon, so the two read apart without
 * colour. The decision is ./labels.ts `orderPayment`; display only.
 */
import { Banknote, CalendarClock, Wallet } from 'lucide-react';
import { StatusChip } from '../../ui/Badge';
import { orderPayment, orderPaymentLabel, orderPaymentTone, paymentMark, type OrderPayment } from './labels';

type Loc = (ar: string, en: string, ckb?: string) => string;

const ICON: Record<OrderPayment, typeof Wallet> = { paid: Wallet, cod: Banknote, instalments: CalendarClock };

export function PaymentChip({
  order, loc, fallback = null, always = false,
}: {
  order: { status?: string; payment_method_id?: string | null; due_on_delivery_iqd?: number | null };
  loc: Loc;
  /** What stands in when there is no mark (a cancelled order, an unknown method). */
  fallback?: string | null;
  /** The method even on a cancelled order — the money section's «how it was paid». */
  always?: boolean;
}) {
  const p = always ? orderPayment(order) : paymentMark(order);
  if (!p) return fallback;
  const Icon = ICON[p];
  return (
    <StatusChip tone={orderPaymentTone(p, order.status ?? '')} dot={false} icon={<Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}>
      <span data-payment-chip={p}>{orderPaymentLabel(p, loc)}</span>
    </StatusChip>
  );
}
