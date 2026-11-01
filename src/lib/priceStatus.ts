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

/**
 * «سعر تقديري» — AN ESTIMATED PRE-ORDER PRICE (docs/SMART_PRICING.md §5.1–5.3;
 * migration 0218; DECISIONS rows 278 and 281).
 *
 * `price_status` stays binary: an estimate is a PRICED figure the owner has not
 * confirmed against the supplier yet. The server adds one boolean beside it,
 * `price_estimate: true`, only on a priced card or selection that is an
 * estimate, so every other payload is what it was. It carries no figure,
 * source or flag. A card that says it is unpriced is never an estimate.
 */
export const isEstimated = (p: { price_status?: string | null; price_estimate?: unknown } | null | undefined): boolean =>
  p?.price_estimate === true && !isUnpriced(p);

/**
 * The two card labels, EAGER for the same reason as UNPRICED_TEXT. They are
 * COPIES of `ESTIMATE_STRINGS.label` and `ESTIMATE_STRINGS.labelShort`
 * (packages/contracts/src/priceEstimates.ts, which only the Worker and lazy
 * chunks import); tests/estimateStorefrontUi.test.ts pins them equal.
 */
export const ESTIMATE_TEXT = { ar: 'سعر تقديري', en: 'Estimated price', ckb: 'نرخی خەمڵێنراو' } as const;
/** The compact card's second line. */
export const ESTIMATE_SHORT = { ar: 'تقديري', en: 'Estimate', ckb: 'خەمڵێنراو' } as const;
