/**
 * WHERE A PRODUCT IS IN ITS LIFE — the merchant's own state, and the two
 * things that are NOT states.
 *
 *   draft      being written; never on the storefront
 *   published  on the storefront, buyable while in stock
 *   hidden     taken off the storefront for now; keeps everything
 *   archived   retired; kept for the orders that name it
 *
 * `community_products.publish_state` holds exactly these four (a CHECK,
 * migration 0126). SOLD OUT IS NOT A STATE: it is derived — a published
 * product that tracks stock and has none left (for a product with variants,
 * none left in any active variant). LEVONIS'S HIDE IS NOT A STATE EITHER: it
 * is the admin's own column (`admin_hidden_at`, migration 0118) that no
 * merchant write can clear, and it wins over `published` wherever a product is
 * shown.
 */
export const PUBLISH_STATES = ['draft', 'published', 'hidden', 'archived'] as const;
export type PublishState = (typeof PUBLISH_STATES)[number];

export function isPublishState(v: unknown): v is PublishState {
  return typeof v === 'string' && (PUBLISH_STATES as readonly string[]).includes(v);
}

/**
 * The pre-0126 vocabulary (`lifecycle`: draft | active | hidden | sold_out |
 * archived) read as a state. `sold_out` was a manual flag that took the
 * product off the storefront, so it reads as `hidden` — the customer-facing
 * behaviour stays exactly what it was (docs/DECISIONS.md, W2-F).
 */
export function stateFromLegacyLifecycle(v: unknown): PublishState {
  switch (v) {
    case 'active':
    case 'published':
      return 'published';
    case 'draft':
      return 'draft';
    case 'archived':
      return 'archived';
    default:
      return 'hidden';
  }
}

/** The legacy mirror a state writes into `lifecycle`, for every pre-0126 reader. */
export function legacyLifecycleOf(state: PublishState): 'active' | 'draft' | 'hidden' | 'archived' {
  return state === 'published' ? 'active' : state;
}

/** Sold out, derived: tracked, and nothing left to sell. */
export function isSoldOut(p: { track_stock: boolean | number; stock: number }): boolean {
  return !!Number(p.track_stock) && Number(p.stock) <= 0;
}

/**
 * At or below the merchant's low-stock line, and not yet out. `threshold`
 * null means the merchant set none (no alert); 0 means "tell me at zero",
 * which is the sold-out notice rather than a low one, so it never fires here.
 */
export function isLowStock(stock: number, threshold: number | null | undefined): boolean {
  if (threshold === null || threshold === undefined) return false;
  return stock > 0 && stock <= threshold;
}
