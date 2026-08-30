/**
 * The FOUR shipping types, and the rule that a cart holds exactly one.
 *
 * WHY A CART MAY NOT MIX THEM. These are not four labels on one journey, they
 * are four different journeys. A direct order ships from LEVO's own shelf in
 * days; an air pre-order is bought from a supplier abroad, cleared, and
 * forwarded — weeks. Sea and land are weeks more again, and each moves on its
 * own consolidated shipment. A basket holding two of them has no single
 * delivery date, no single tracking path and no honest status to show the
 * customer, because half of it would be sitting in a warehouse in another
 * country while the other half is on a motorbike in Baghdad.
 *
 * So the FIRST item decides the cart's type and every later item must match.
 * The refusal is explicit and offers the only two real ways out — empty the
 * cart and start this type, or keep what is there.
 *
 * STORED AS THE TRANSPORT METHOD IT ALREADY WAS. cart_items.transport_method
 * has held '' | 'air' | 'sea' | 'land' since migration 0002, and '' has always
 * meant direct. This adds the vocabulary and the rule on top of that column
 * rather than a parallel one that could disagree with it.
 */

export type ShippingType = 'direct' | 'preorder_air' | 'preorder_sea' | 'preorder_land';

export const SHIPPING_TYPES: ShippingType[] = ['direct', 'preorder_air', 'preorder_sea', 'preorder_land'];

/** The transport method a line stores for a given type. '' = direct. */
export function transportForType(type: ShippingType): '' | 'air' | 'sea' | 'land' {
  switch (type) {
    case 'preorder_air':
      return 'air';
    case 'preorder_sea':
      return 'sea';
    case 'preorder_land':
      return 'land';
    default:
      return '';
  }
}

/** The type a stored transport method means. Anything unknown reads as direct. */
export function typeForTransport(method: unknown): ShippingType {
  switch (method) {
    case 'air':
      return 'preorder_air';
    case 'sea':
      return 'preorder_sea';
    case 'land':
      return 'preorder_land';
    default:
      return 'direct';
  }
}

export function isPreorder(type: ShippingType): boolean {
  return type !== 'direct';
}

/** Names for the customer. Owner-authored, never machine-translated. */
export const SHIPPING_TYPE_LABELS: Record<ShippingType, { ar: string; en: string; ckb: string }> = {
  direct: { ar: 'شحن مباشر', en: 'Direct shipping', ckb: 'گەیاندنی ڕاستەوخۆ' },
  preorder_air: { ar: 'طلب مسبق — جوي', en: 'Pre-order — air', ckb: 'پێش-داواکاری — ئاسمانی' },
  preorder_sea: { ar: 'طلب مسبق — بحري', en: 'Pre-order — sea', ckb: 'پێش-داواکاری — دەریایی' },
  preorder_land: { ar: 'طلب مسبق — بري', en: 'Pre-order — land', ckb: 'پێش-داواکاری — وشکانی' },
};

/**
 * The cart's current type, or null when the cart is empty.
 *
 * Reads the LINES, not a stored flag: a flag can drift out of step with the
 * rows it describes (a line removed, a line edited), and then the cart claims
 * a type it no longer holds.
 */
export function cartShippingType(
  lines: Array<{ transport_method?: unknown }>
): ShippingType | null {
  if (lines.length === 0) return null;
  return typeForTransport(lines[0].transport_method);
}

/** Every distinct type present. More than one means the cart is already mixed. */
export function distinctShippingTypes(lines: Array<{ transport_method?: unknown }>): ShippingType[] {
  return [...new Set(lines.map((l) => typeForTransport(l.transport_method)))];
}
