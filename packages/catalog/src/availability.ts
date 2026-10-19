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
 * A HIDDEN COUNT IS NOT A ZERO. `direct_stock_available` is ABSENT (not 0)
 * on a direct-sale card when the server withheld the count on purpose: an
 * active mystery-pool member (`directStockAvailable` → null under the coarse
 * rule, §8.2 row 18) is still bought directly, and the door answers
 * OUT_OF_STOCK honestly if the shelf is empty. So a card whose sale types
 * offer a direct sale and that carries no count is `unknown` — never
 * «غير متوفر» beside a price for an item in stock, and never «طلب مسبق» for
 * one that may be on the shelf. A stated 0 stays a fact.
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
    // The server's own test for a direct shelf (`directStockAvailable`: direct_sale or bundle). With
    // one offered and no count on the card, the count was withheld, not found empty.
    if (n === undefined || n === null) {
      if (p.sale_types.includes('direct_sale') || p.sale_types.includes('bundle')) return { state: 'unknown', qty: null, low: false };
    }
    return { state: p.sale_types.includes('pre_order') ? 'preorder' : 'unavailable', qty: null, low: false };
  }
  if (p.selling_type === 'pre_order') return { state: 'preorder', qty: null, low: false };
  return { state: 'unknown', qty: null, low: false };
}

/**
 * WHAT A BUNDLE TILE SAYS, IN THE CARD'S FOUR WORDS — FOR THE VIEWER WHO ASKED.
 *
 * A bundle's card carries its builder's ONE verdict (`availability_state`,
 * worker/lib/bundleComposition.ts `CompositionState`), resolved with the
 * viewer's own tier, and BundleTile (`STATE_LABELS`) draws it as a chip. A
 * surface that speaks of the same tile in the product card's words (the
 * support assistant) maps it here, so it never contradicts the chip:
 *
 *  available   — in_stock «متوفر», low «الكمية محدودة», ending_soon
 *                «ينتهي قريباً», and member_exclusive «متاح لك»: an in-stock
 *                gated offer THIS viewer is entitled to, which they can buy.
 *  preorder    — preorder «طلب مسبق».
 *  unavailable — sold_out «نفدت الكمية», ended «انتهى العرض».
 *  unknown     — locked «حصري للمشتركين» (the members-only line already says
 *                it), upcoming «قريباً» (not «غير متوفر»: it opens on its
 *                countdown), unconfigured, and any state this table does not
 *                know — no word, as the tile renders no chip for one.
 *
 * Not the public API's `availabilityFromComposition`, which answers for an
 * anonymous visitor and reads a members-only box as unavailable.
 */
export function compositionAvailability(state: unknown): AvailabilityState {
  switch (state) {
    case 'in_stock':
    case 'low':
    case 'ending_soon':
    case 'member_exclusive':
      return 'available';
    case 'preorder':
      return 'preorder';
    case 'sold_out':
    case 'ended':
      return 'unavailable';
    default:
      return 'unknown';
  }
}
