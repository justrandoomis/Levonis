/**
 * CATALOG-ONLY PRODUCTS (DECISIONS rows 239 (3) and 240).
 *
 * A product the owner has not priced in Pricing V2 yet is SHOWN — name,
 * pictures, options, colours, specifications — but not sold. The server marks
 * every projection with `price_status`; an unpriced one carries `price_iqd:
 * null`, never 0, and no stock or sale-type fields at all. Every surface reads
 * the status through `isUnpriced` and prints `UNPRICED_TEXT` instead of a
 * number. Nothing here prices anything.
 *
 * Kept tiny and EAGER: the home page's card imports it, and a card must never
 * flash a blank price while a lazy chunk loads (spec §6.1). An absent status
 * reads as priced — an older server never served an unpriced product.
 */
export type PriceStatus = 'priced' | 'unpriced';

export const isUnpriced = (p: { price_status?: string | null } | null | undefined): boolean => p?.price_status === 'unpriced';

/** «السعر غير متوفر حالياً» — real Sorani, never the Arabic copied (row 183). */
export const UNPRICED_TEXT = { ar: 'السعر غير متوفر حالياً', en: 'Price not available yet', ckb: 'نرخ هێشتا بەردەست نییە' } as const;
