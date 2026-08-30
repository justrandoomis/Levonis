/**
 * The four shipping types, for the client.
 *
 * Mirrors worker/lib/shippingType.ts — the SPA and the Worker are built
 * independently and neither can import the other's module graph — and pinned
 * by tests/shippingType.test.ts so the two cannot drift apart silently.
 *
 * The client NEVER decides the rule. The server refuses a mixed cart and
 * names both types in the refusal; this file only turns those two ids into
 * words the customer reads.
 */
export type ShippingType = 'direct' | 'preorder_air' | 'preorder_sea' | 'preorder_land';

export const SHIPPING_TYPES: ShippingType[] = ['direct', 'preorder_air', 'preorder_sea', 'preorder_land'];

export const SHIPPING_TYPE_LABELS: Record<ShippingType, { ar: string; en: string; ckb: string }> = {
  direct: { ar: 'شحن مباشر', en: 'Direct shipping', ckb: 'گەیاندنی ڕاستەوخۆ' },
  preorder_air: { ar: 'طلب مسبق — جوي', en: 'Pre-order — air', ckb: 'پێش-داواکاری — ئاسمانی' },
  preorder_sea: { ar: 'طلب مسبق — بحري', en: 'Pre-order — sea', ckb: 'پێش-داواکاری — دەریایی' },
  preorder_land: { ar: 'طلب مسبق — بري', en: 'Pre-order — land', ckb: 'پێش-داواکاری — وشکانی' },
};

export function isShippingType(v: unknown): v is ShippingType {
  return typeof v === 'string' && (SHIPPING_TYPES as string[]).includes(v);
}

/** The label for a type, or an empty string when the server sent something unknown. */
export function shippingTypeLabel(type: unknown, lang: string): string {
  if (!isShippingType(type)) return '';
  const row = SHIPPING_TYPE_LABELS[type];
  return lang === 'en' ? row.en : lang === 'ckb' ? row.ckb : row.ar;
}
