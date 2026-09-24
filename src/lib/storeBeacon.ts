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
