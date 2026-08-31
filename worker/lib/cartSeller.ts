/**
 * One cart, one seller.
 *
 * A Levonis cart belongs to the signed-in customer — there is no second cart
 * system and no per-store cart (§14, §89). But a single checkout settles with
 * exactly one seller: it produces one order, with one delivery promise, one
 * commission and one party responsible for it. Mixing Levonis stock with a
 * merchant's, or two merchants with each other, would produce an order nobody
 * can fulfil and money that cannot be split correctly.
 *
 * So the cart carries a SCOPE, derived from the lines themselves rather than
 * stored as a flag. A flag can disagree with reality after a line is removed;
 * a derivation cannot. This mirrors `lib/shippingType.ts`, which solved the
 * same shape of problem for air/sea/land, deliberately — one idiom, so the two
 * rules read the same way and a reader who understands one understands both.
 *
 * The rule is enforced on every door into the cart, server-side. The frontend
 * shows the confirmation dialogue, but the frontend is not what stops a mixed
 * cart: a request that skips the dialogue is refused the same way (§15).
 */

export interface SellerScope {
  seller_type: 'levonis' | 'merchant';
  merchant_id: string | null;
  store_id: string | null;
}

/** A cart line, reduced to just what decides its seller. */
export interface SellerLine {
  seller_type?: unknown;
  merchant_id?: unknown;
  store_id?: unknown;
}

export const PLATFORM_SCOPE: SellerScope = { seller_type: 'levonis', merchant_id: null, store_id: null };

export function merchantScope(merchantId: string, storeId: string): SellerScope {
  return { seller_type: 'merchant', merchant_id: merchantId, store_id: storeId };
}

/**
 * The seller a cart currently belongs to, or null when it is empty.
 *
 * Derived from the lines. An empty cart has NO scope — it is not "a Levonis
 * cart with nothing in it" — so the first item added, from either side,
 * decides without a conflict.
 */
export function cartSellerScope(lines: readonly SellerLine[]): SellerScope | null {
  if (!lines.length) return null;
  const first = lines[0];
  const type = first.seller_type === 'merchant' ? 'merchant' : 'levonis';
  if (type === 'levonis') return PLATFORM_SCOPE;
  return {
    seller_type: 'merchant',
    merchant_id: first.merchant_id == null ? null : String(first.merchant_id),
    store_id: first.store_id == null ? null : String(first.store_id),
  };
}

/** Do two scopes settle with the same seller? */
export function sameSeller(a: SellerScope, b: SellerScope): boolean {
  if (a.seller_type !== b.seller_type) return false;
  if (a.seller_type === 'levonis') return true;
  return a.merchant_id === b.merchant_id;
}

export type SellerConflict = {
  /** What the cart holds today. */
  current: SellerScope;
  /** What was just asked for. */
  incoming: SellerScope;
};

/**
 * Would adding `incoming` to a cart holding `lines` mix sellers?
 * Returns the conflict to report, or null when the add is fine.
 */
export function sellerConflict(
  lines: readonly SellerLine[],
  incoming: SellerScope
): SellerConflict | null {
  const current = cartSellerScope(lines);
  if (!current) return null;
  if (sameSeller(current, incoming)) return null;
  return { current, incoming };
}

/**
 * The error code the API returns and the frontend switches on.
 *
 * Deliberately distinct from CART_SHIPPING_CONFLICT: both mean "your cart
 * must be emptied first", but they need different words and offer different
 * choices, and one shared code would make them impossible to tell apart in
 * the UI.
 */
export const CART_SELLER_CONFLICT = 'CART_SELLER_CONFLICT';

/**
 * Details attached to the 400, so the dialogue can name both shops rather
 * than saying "another seller". The names are resolved by the caller — this
 * module does no I/O.
 */
export function conflictDetails(
  conflict: SellerConflict,
  names: { current?: string | null; incoming?: string | null } = {}
) {
  return {
    cart_seller_type: conflict.current.seller_type,
    cart_merchant_id: conflict.current.merchant_id,
    cart_store_id: conflict.current.store_id,
    cart_seller_name: names.current ?? null,
    incoming_seller_type: conflict.incoming.seller_type,
    incoming_merchant_id: conflict.incoming.merchant_id,
    incoming_store_id: conflict.incoming.store_id,
    incoming_seller_name: names.incoming ?? null,
  };
}
