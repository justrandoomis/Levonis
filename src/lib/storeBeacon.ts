/**
 * THE STOREFRONT'S ANALYTICS BEACON — a few hundred bytes on every store page.
 *
 * Tells the Worker (POST /api/storefront/events) that a store or product page
 * was seen, a product added to the cart, or the store checkout reached. The
 * Worker decides what counts — once per visitor per day, never the owner,
 * never a crawler — and stores only a salted hash (worker/lib/
 * storefrontAnalytics.ts).
 *
 * WHAT LEAVES THE BROWSER: the event, the store and product ids, an anonymous
 * random id this page keeps in localStorage (not a cookie, never sent
 * anywhere else), and the HOST of the page that linked here — never its path
 * or query. With Do Not Track or Global Privacy Control on, no id is created
 * or sent at all. `sendBeacon` survives the page being closed; any failure is
 * silent — analytics must never cost a shopper anything.
 */

export type StoreEvent = 'store_view' | 'product_view' | 'add_to_cart' | 'checkout_started';

const KEY = 'lv_vid';
let memo: string | null | undefined;

function optedOut(): boolean {
  const n = navigator as Navigator & { globalPrivacyControl?: boolean };
  return n.doNotTrack === '1' || n.globalPrivacyControl === true;
}

function visitorId(): string | null {
  if (memo !== undefined) return memo;
  if (optedOut()) return (memo = null);
  try {
    let id = localStorage.getItem(KEY);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(KEY, id);
    }
    return (memo = id);
  } catch {
    // Storage blocked (a private window): one id for this page's life.
    return (memo = crypto.randomUUID?.().replace(/-/g, '') ?? null);
  }
}

function referrerHost(): string {
  try {
    return document.referrer ? new URL(document.referrer).hostname : '';
  } catch {
    return '';
  }
}

export function trackStoreEvent(store: string | null | undefined, event: StoreEvent, product?: string | null): void {
  if (!store) return;
  try {
    const body = JSON.stringify({ event, store, product: product || undefined, visitor: visitorId() || undefined, ref: referrerHost() || undefined });
    const url = '/api/storefront/events';
    // A string body is text/plain: no preflight, and the Worker parses it.
    if (navigator.sendBeacon?.(url, body)) return;
    void fetch(url, { method: 'POST', body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  } catch {
    /* never on the shopper's path */
  }
}

/**
 * «سرعة متجري» (P4): schedules the speed reporter (./storeVitals.ts, ~1 KB)
 * for the page load that shows `store` — fetched after `load`, once the
 * browser is idle, with a dynamic import that is never a store page's static
 * closure (tests/bundleBudget.test.ts). Save-Data (or prefers-reduced-data)
 * skips it; Do Not Track / GPC are honoured inside it; the Worker never counts
 * the owner or a bot. Once started it is not stopped on unmount: it sends ONE
 * beacon for this page load when the page is hidden, in-shop navigation or not.
 *
 * ONE COPY for both store pages (review 2026-09-30): the same effect written
 * into Storefront.tsx and StorefrontProduct.tsx cost the store pages' 47 KB
 * budget about 270 B twice. Each page runs `useEffect(() =>
 * scheduleStoreVitals(storeId), [storeId])`; the return value is the effect's
 * cleanup (nothing starts after the page has gone).
 */
export function scheduleStoreVitals(store: string | null | undefined): () => void {
  const none = () => {};
  try {
    if (!store || (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData || window.matchMedia?.('(prefers-reduced-data: reduce)').matches) return none;
  } catch {
    return none;
  }
  let live = true;
  const start = () => {
    if (live) void import('./storeVitals').then((m) => live && m.startStoreVitals(store), () => {});
  };
  // Safari has no idle callback: a short timer after `load` instead.
  const later = () => ('requestIdleCallback' in window ? window.requestIdleCallback(start, { timeout: 5000 }) : setTimeout(start, 2000));
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
  return () => {
    live = false;
    window.removeEventListener('load', later);
  };
}
