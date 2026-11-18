/**
 * The store dock's tiny pieces the app shell and the product page need on every
 * store visit, kept out of the dock's own chunk so the main site's entry does
 * not grow by the dock (src/components/storeDock/StoreDock.tsx, loaded lazily).
 */

/**
 * The store-host pages that wear the dock: the shop's own pages. A product page
 * (`/p/…`) draws its own, with the buy controls; the platform's pages (cart,
 * checkout, orders, sign-in, the workspace) do not.
 */
export function storeDockRoute(pathname: string): boolean {
  const p = pathname.toLowerCase();
  if (p.startsWith('/p/')) return false;
  return !['/cart', '/checkout', '/store-checkout', '/orders', '/admin', '/auth', '/model-viewer'].some((x) => p === x || p.startsWith(`${x}/`));
}

/** The room a page leaves at its end so the dock never covers its last line. */
export function StoreDockSpacer() {
  return <div aria-hidden="true" data-store-dock-spacer className="shrink-0" style={{ height: 'calc(56px + 12px + max(0.625rem, env(safe-area-inset-bottom)) + 24px)' }} />;
}

/** A page changed the cart (the product page's add): the dock reads its count again. */
export const STORE_CART_CHANGED = 'lv:store-cart-changed';
export function announceStoreCartChanged(): void {
  try {
    window.dispatchEvent(new Event(STORE_CART_CHANGED));
  } catch {
    /* no window: nothing to tell */
  }
}

/** The part of `GET /api/cart/merchant` the dock reads. */
export interface StoreCartRead {
  store: { id: string } | null;
  items: Array<{ qty: number; unavailable_reason?: string | null }>;
}

/**
 * THIS STORE'S lines of the merchant cart. A cart holds one seller at a time:
 * when it is locked to another store (or holds nothing of a store), this store
 * has none in it. A line the server marks `other_store` is never this store's.
 */
export function storeLines<L extends StoreCartRead['items'][number]>(cart: { store: { id: string } | null; items: L[] } | null, storeId: string): L[] {
  if (!cart?.store || cart.store.id !== storeId) return [];
  return cart.items.filter((l) => l.unavailable_reason !== 'other_store');
}

/** The units the dock's badge shows. */
export function storeUnits(cart: StoreCartRead | null, storeId: string): number {
  return storeLines(cart, storeId).reduce((n, l) => n + (Number(l.qty) || 0), 0);
}
