/**
 * WHAT A PRODUCT CARD SAYS ABOUT AVAILABILITY — one rule for every surface
 * that draws a storefront card: the compact card (src/lib/productCard.ts
 * re-exports it), the public API's card (worker/lib/publicApi/common.ts) and
 * the support assistant's product cards (worker/routes/support.ts).
 *
 * It reads only fields the server already resolved on the card
 * (`resolveProductCards` → `cardShape`): `direct_stock_available`,
 * `sale_types`, `price_status`, and `low_stock_threshold` / `selling_type`
 * when a fuller payload is passed. It never prices, never reads the base
 * `stock` counter (on an option- or colour-tracked product that counter is
 * not the shelf), and never turns an absent field into a fact.
 *
 * THREE STATES, AND A FOURTH THAT DRAWS NOTHING.
 *
 *  available   — `direct_stock_available > 0`: units in the Iraq stock now.
 *  preorder    — no direct unit, and the product's sale types include
 *                pre-order.
 *  unavailable — no direct unit, and the sale types say pre-order is not
 *                offered either.
 *  unknown     — no direct unit and the card was not told the sale types
 *                (a card projection that predates `sale_types`), or the
 *                product is catalog-only (DECISIONS rows 239-240: stock is not
 *                configured for an unpriced product). The card says nothing
 *                rather than guess «طلب مسبق» or «نفد».
 *
 * Pure: no I/O, no imports.
 */

export type AvailabilityState = 'available' | 'preorder' | 'unavailable' | 'unknown';

export interface Availability {
  state: AvailabilityState;
  /** Direct-sale units the buyer can still take today; null when not stated. */
  qty: number | null;
  /** True when `qty` is at or under the low-stock threshold («بقي 2»). */
  low: boolean;
}

/** The card fields the rule reads. Typed `unknown` so a server card (`Record<string, unknown>`) and the SPA's `ApiProduct` both fit. */
export interface AvailabilityInput {
  direct_stock_available?: unknown;
  sale_types?: unknown;
  low_stock_threshold?: unknown;
  price_status?: unknown;
  /** The legacy single-mode field; the detail payload carries it and a few older call sites pass a full product. */
  selling_type?: unknown;
}

/** «بقي N» from here down when the shop has not set its own threshold. */
export const DEFAULT_LOW_STOCK = 2;

export function cardAvailability(p: AvailabilityInput): Availability {
  // CATALOG-ONLY (rows 239-240): the card says nothing — never «غير متوفر» or «نفد».
  if (p.price_status === 'unpriced') return { state: 'unknown', qty: null, low: false };
  const n = p.direct_stock_available;
  if (typeof n === 'number' && Number.isInteger(n) && n > 0) {
    const t = p.low_stock_threshold;
    const threshold = typeof t === 'number' && Number.isInteger(t) && t >= 0 ? t : DEFAULT_LOW_STOCK;
    return { state: 'available', qty: n, low: n <= threshold };
  }
  if (Array.isArray(p.sale_types)) {
    return { state: p.sale_types.includes('pre_order') ? 'preorder' : 'unavailable', qty: null, low: false };
  }
  if (p.selling_type === 'pre_order') return { state: 'preorder', qty: null, low: false };
  return { state: 'unknown', qty: null, low: false };
}
