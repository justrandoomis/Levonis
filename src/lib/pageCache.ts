/**
 * WHAT A PAGE LAST SHOWED, SO GOING BACK DOES NOT LOOK LIKE A FIRST VISIT.
 *
 * «عند الرجوع للوراء لا يضطر أن يحمل الصفحة مرة ثانية … يدخل على صفحة معينة
 *  ويرجع للوراء خلال ثواني معدودة يضطر إلى تحميل الصفحة من جديد.»
 *
 * THE DEFECT. Every list page in this app fetches in a mount effect and starts
 * at `loading = true`. React Router unmounts a route on navigation, so `back`
 * builds the page again from nothing: skeleton, request, paint. On a phone on
 * Iraqi mobile data that is a second or more of grey boxes for a screen the
 * customer was looking at four seconds earlier, and it happens on EVERY back
 * out of a product page. The data was not stale. It was simply gone, because
 * the only place it lived was component state.
 *
 * WHAT THIS IS. A module-scoped snapshot of the last successful answer for a
 * page, with the time it was taken. A page seeds its state from the snapshot
 * when one is fresh, and revalidates in the background instead of showing a
 * loader. Nothing here decides what is fresh for whom: the caller passes the
 * TTL that suits its own screen.
 *
 * WHAT THIS IS NOT.
 *
 *   - NOT AN HTTP CACHE. It does not sit inside `api.get`, and no request is
 *     skipped because of it. Every page that reads a snapshot still asks the
 *     server immediately; the snapshot only decides whether the customer looks
 *     at a skeleton while that happens. A cache that suppressed the request
 *     would make «رجعت للوراء» show yesterday's price, which is the one thing
 *     this shop refuses (src/lib/useFreshOnReturn.ts exists for the same
 *     reason, from the other end).
 *
 *   - NOT STORAGE. It is a plain Map in module scope. A hard reload creates a
 *     new module and therefore an empty cache, which is correct: a reload is
 *     the customer asking for the page again. Nothing is written to
 *     localStorage or sessionStorage, so a shared phone cannot show the next
 *     person what the last one was reading, and nothing here survives the tab.
 *
 *   - NOT FOR MONEY OR FOR ANYTHING PERSONAL. The cart, the checkout, the
 *     wallet and the order pages are deliberately absent from the call sites:
 *     a price or a balance must be fetched before it is shown, never painted
 *     from a snapshot and corrected a moment later. This holds catalogue
 *     listings — what the shop sells — which is exactly the data the back
 *     button lands on.
 *
 * WHERE IT IS WIRED, AND WHERE IT DELIBERATELY IS NOT. Four catalogue
 * listings use it — Home, /products, /used-printers and /bundles — which is
 * the loop `back` actually travels: a shelf, a product, back to the shelf.
 * THE PRODUCT PAGE IS NOT ONE OF THEM, on purpose. Its load resolves the
 * order type, the transport, the variant and the price together, and painting
 * a remembered price for even a moment on the screen with «أضف إلى السلة» on
 * it is the trade this shop does not make. Neither are the cart, the
 * checkout, the wallet or the orders: those read money and must fetch it.
 *
 * SIGNING IN OR OUT EMPTIES IT, through `clearPageCache()` in AuthContext.
 * Prices and availability are membership-dependent (PRIME/PRO tiers), so a
 * snapshot taken as one identity must never be painted for another — and the
 * cheapest correct answer to "which of these rows were identity-dependent" is
 * "all of them, drop the lot".
 */

/** One page's last good answer. */
interface Snapshot {
  value: unknown;
  /** `performance.now()`-style monotonic ms, so a clock change cannot make a
   *  snapshot look fresh forever. */
  at: number;
}

/**
 * A back-navigation is seconds, not minutes. Sixty is long enough to cover
 * "open a product, read it, come back" — the journey the owner described —
 * and short enough that a page left in a background tab over lunch fetches
 * again on its own rather than flashing a stale shelf first.
 */
export const PAGE_CACHE_TTL_MS = 60_000;

const store = new Map<string, Snapshot>();

/** Monotonic where the browser has it; `Date.now()` is the fallback and is
 *  only ever used to compare two readings taken from the same source. */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * The snapshot for `key`, or null when there is none or it is older than
 * `ttlMs`. The value is returned as-is — callers own it, and a caller that
 * mutates what it gets back has mutated the snapshot too.
 */
export function readPageCache<T>(key: string, ttlMs: number = PAGE_CACHE_TTL_MS): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (now() - hit.at > ttlMs) {
    // Dropped rather than left to rot: the page is about to fetch anyway, and
    // an expired entry that stays in the Map is a leak with a timestamp on it.
    store.delete(key);
    return null;
  }
  return hit.value as T;
}

/** Record what the page is now showing. Only ever called after a SUCCESSFUL
 *  read — a failure must not be painted instantly next time. */
export function writePageCache(key: string, value: unknown): void {
  store.set(key, { value, at: now() });
}

/** Forget one page, for a caller that knows its own data just changed. */
export function dropPageCache(key: string): void {
  store.delete(key);
}

/** Forget everything. Called when the identity changes — see the header. */
export function clearPageCache(): void {
  store.clear();
}

/** For tests: how many snapshots are held. Never read by the app. */
export function pageCacheSize(): number {
  return store.size;
}
