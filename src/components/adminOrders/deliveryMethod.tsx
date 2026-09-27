/**
 * «توصيل عادي» / «توصيل شخصي» — the LAST-MILE METHOD an order was placed with.
 *
 * Not the shipping TYPE (direct / pre-order — `TypeBadge`), which is the
 * journey the box takes before it reaches Iraq. The method is how it reaches
 * the door, and it decides who carries it: the courier company for «توصيل
 * عادي», the shop's own driver for «توصيل شخصي». The owner asked for it beside
 * the amount collected at the door, because the two are written on different
 * sheets.
 *
 * THE WORDS ARE THE STORE'S OWN. The order froze the configured method with
 * its titles (`delivery_method_snapshot`, worker/routes/orders.ts), so a method
 * renamed later still reads the way it did when the customer chose it. A
 * snapshot without titles (a merchant's order, an older row) falls back to the
 * id; a method this screen cannot name draws nothing rather than a raw id.
 */
import { Bike, Store, Truck, type LucideIcon } from 'lucide-react';
import type { ApiOrder } from '../../lib/api';

type Snapshot = ApiOrder['delivery_method'] | null | undefined;

const BY_ID: Record<string, { ar: string; en: string; Icon: LucideIcon }> = {
  standard: { ar: 'توصيل عادي', en: 'Standard delivery', Icon: Truck },
  personal: { ar: 'توصيل شخصي', en: 'Personal delivery', Icon: Bike },
  pickup: { ar: 'استلام من المخزن', en: 'Store pickup', Icon: Store },
};

/** The method's id, when the snapshot carries one this screen knows. */
export function deliveryMethodId(method: Snapshot): 'standard' | 'personal' | 'pickup' | null {
  const id = method?.id;
  return id === 'standard' || id === 'personal' || id === 'pickup' ? id : null;
}

/**
 * The method's name in `lang`. A delivery method carries no Sorani title
 * anywhere in the store, so Sorani reads the Arabic one — exactly what the
 * cart does with the same titles.
 */
export function deliveryMethodName(method: Snapshot, lang: string): string | null {
  const ar = typeof method?.titleAr === 'string' ? method.titleAr.trim() : '';
  const en = typeof method?.titleEn === 'string' ? method.titleEn.trim() : '';
  if (ar || en) return lang === 'en' ? en || ar : ar || en;
  const known = BY_ID[method?.id ?? ''];
  return known ? (lang === 'en' ? known.en : known.ar) : null;
}

/**
 * One capsule. Personal delivery is the one the shop carries itself, the same
 * day, so it takes the info tint; the others stay neutral — one quiet cue, not
 * a second headline next to the amount.
 */
export function DeliveryMethodBadge({ method, lang, className = '' }: { method: Snapshot; lang: string; className?: string }) {
  const name = deliveryMethodName(method, lang);
  if (!name) return null;
  const id = deliveryMethodId(method);
  const Icon = BY_ID[id ?? '']?.Icon ?? Truck;
  const tone =
    id === 'personal'
      ? 'border-info/30 bg-info/10 text-info'
      : 'border-border-subtle bg-surface-raised text-text-secondary';
  return (
    <span
      data-delivery-method={id ?? 'other'}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-[1.4] font-bold whitespace-nowrap ${tone} ${className}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {name}
    </span>
  );
}
