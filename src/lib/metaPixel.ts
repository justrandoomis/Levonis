/**
 * THE META PIXEL — the shop's ad measurement on Facebook and Instagram
 * (owner request 2026-10-31, pixel 906446185408755).
 *
 * WHY NOT META'S SNIPPET IN index.html. The snippet is an inline <script>, and
 * this site admits no inline script but the theme boot script, by hash
 * (worker/lib/securityPolicy.ts). And index.html is SHARED: the same document
 * is every merchant subdomain's too, where the platform's pixel must not watch
 * another shop's customers. So the snippet's two halves live here:
 *   the queue   `window.fbq` is defined at once, as the snippet does, so the
 *               calls made before Meta's script arrives are kept and replayed;
 *   the script  fbevents.js (~100 KB) is added after the page has loaded and
 *               the browser is idle. No first paint waits on a third origin
 *               (the reason the fonts are self-hosted: docs/PERFORMANCE_LOG.md).
 * The snippet's <noscript> image is left out: without JavaScript there is no
 * shop to measure (#root is empty), and it would fire on every store host.
 *
 * WHAT IT SENDS. A PageView, from the pages `isMetaPixelPath` lists — public
 * shopping and browsing pages — and only on the main site
 * (src/components/MetaPixel.tsx). Meta receives the page address with every
 * event, so an account page, an order, a chat, a sign-in link or a private
 * link is never reported. Two of Meta's defaults are off for the same reason:
 *   autoConfig        automatic events read button text and page metadata
 *                     from whatever page is open, the admin console included;
 *   disablePushState  fbevents otherwise sends a PageView on every history
 *                     change, private routes included. The router reports.
 * No advanced matching: no name, email, phone or account id is ever passed.
 *
 * THE PRIVACY POLICY SAYS EXACTLY THIS (worker/lib/policies/privacy.ts,
 * version 4). A new event, a new page or advanced matching is a change to
 * that document too.
 */

export const META_PIXEL_ID = '906446185408755';
export const META_PIXEL_SCRIPT_URL = 'https://connect.facebook.net/en_US/fbevents.js';

/**
 * The pages a PageView is sent from: an ALLOWLIST, so a private page added
 * later is not reported by default. Paths are compared without a trailing
 * slash; the query string is not consulted.
 */
const TRACKED_PATHS: readonly RegExp[] = [
  /^\/$/,
  /^\/products$/,
  /^\/product\/[^/]+$/,
  /^\/categories(?:\/[^/]+){0,2}$/,
  /^\/compare$/,
  /^\/used-printers$/,
  // Not /trade-in: it is the customer's own devices and requests, and its
  // query string carries their request ids.
  /^\/bundles(?:\/[^/]+)?$/,
  /^\/cart$/,
  /^\/checkout$/,
  /^\/community(?:\/(?:stores|makers|projects))?$/,
  /^\/community\/projects\/(?!new$)[^/]+$/,
  /^\/community\/store\/[^/]+(?:\/p\/[^/]+)?$/,
  /^\/u\/[^/]+$/,
  /^\/tools$/,
  /^\/printer-finder$/,
  /^\/policies(?:\/[^/]+)?$/,
  /^\/policy$/,
];

export function isMetaPixelPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return TRACKED_PATHS.some((pattern) => pattern.test(path));
}

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: Fbq;
  loaded: boolean;
  version: string;
  disablePushState?: boolean;
};

type PixelWindow = Window & { fbq?: Fbq; _fbq?: Fbq };

let started = false;

/** Defines the queue, configures the pixel and schedules Meta's script. Idempotent. */
export function startMetaPixel(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const w = window as PixelWindow;
  if (!w.fbq) {
    // Meta's base code, unminified: calls queue until fbevents.js takes over.
    const fbq = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    } as Fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    w.fbq = fbq;
    if (!w._fbq) w._fbq = fbq;
  }
  const fbq = w.fbq;
  // Both before `init`, which is when fbevents reads them.
  fbq.disablePushState = true;
  fbq('set', 'autoConfig', false, META_PIXEL_ID);
  fbq('init', META_PIXEL_ID);

  const load = () => {
    const script = document.createElement('script');
    script.async = true;
    script.src = META_PIXEL_SCRIPT_URL;
    document.head.appendChild(script);
  };
  const whenIdle = () => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(load, { timeout: 4000 });
    else window.setTimeout(load, 1500);
  };
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
}

/**
 * THE SERVER'S COPY (Meta Conversions API, worker/routes/metaEvents.ts). The
 * same event id goes to the pixel and to the server, so Meta keeps one of the
 * two; the server adds what a browser script cannot be trusted with. A
 * beacon: nothing waits for it, and a failure is silent.
 */
export const META_EVENTS_PATH = '/api/meta-events';

function newEventId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
  } catch {
    // an insecure context has no randomUUID
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function toServer(event: { event: 'PageView' | 'ViewContent'; id: string; path: string; product?: string }): void {
  try {
    const body = JSON.stringify(event);
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(META_EVENTS_PATH, new Blob([body], { type: 'text/plain' }))) return;
    }
    if (typeof fetch === 'function') {
      void fetch(META_EVENTS_PATH, { method: 'POST', body, keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    }
  } catch {
    // a beacon that cannot leave is not worth an error
  }
}

const currentPath = (): string => (typeof window === 'undefined' ? '' : window.location.pathname);

/**
 * `trackSingle`, NOT `track`: with `disablePushState` set, fbevents accepts
 * ONE `track('PageView')` per document load and silently drops the rest — so
 * every page opened inside the app after the first went unreported (measured
 * 2026-10-31 against fbevents 2.9.432; a custom event passed on the same page).
 * `trackSingle` addresses this pixel by id and is not deduplicated that way.
 */
export function trackMetaPageView(): void {
  const fbq = (window as PixelWindow).fbq;
  if (!fbq) return;
  const id = newEventId();
  fbq('trackSingle', META_PIXEL_ID, 'PageView', {}, { eventID: id });
  toServer({ event: 'PageView', id, path: currentPath() });
}

/**
 * THE ONE DOOR src/components/MetaPixel.tsx OPENS, on the main site only, for
 * each page the router opens: a page that is not reported starts nothing, and
 * a page the browser already left — a guard's redirect (/cart → /auth for a
 * guest) ran first — is not reported under the address Meta would read.
 */
export function reportMetaPage(pathname: string): void {
  if (!isMetaPixelPath(pathname) || currentPath() !== pathname) return;
  startMetaPixel();
  trackMetaPageView();
}

/**
 * A product page was opened: reported to the SERVER only, which sends Meta a
 * ViewContent with the product's id (the browser pixel sends PageView alone).
 * Nothing before the pixel started — i.e. off the main site — and nothing from
 * a page that is not reported.
 */
export function reportMetaViewContent(productId: string): void {
  if (!started || !productId || !isMetaPixelPath(currentPath())) return;
  toServer({ event: 'ViewContent', id: newEventId(), path: currentPath(), product: productId });
}
