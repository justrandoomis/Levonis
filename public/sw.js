/* global self, caches, fetch, Response, URL, console */
/**
 * THE SERVICE WORKER. PLAIN JAVASCRIPT, SERVED VERBATIM, ON PURPOSE.
 *
 * Vite copies `public/` into `dist/` byte for byte — no Rollup, no hashing, no
 * transform — so THIS FILE IS WHAT THE BROWSER EXECUTES. It therefore contains
 * no `require`, no module syntax and no bare specifier of any kind: there is no
 * bundler between it and the browser to resolve one, and a service worker that
 * fails to parse is not a degraded app, it is a registration that never
 * happens and an offline mode that silently does not exist.
 *
 * WHY THE CACHE POLICY IS THE WHOLE DESIGN. A service worker sits in front of
 * every request the page makes and keeps doing so after the tab is closed. The
 * classic progressive-web-app failure is not a missing feature, it is a
 * cache-first HTML shell: the stale document names `/assets/Name-<hash>.js`
 * chunks that the next deploy deleted, so every returning visitor gets a white
 * screen and stays dead until they clear site data — which a customer in Iraq
 * on a phone will not do, they will simply never come back. Every rule below
 * exists to make that impossible:
 *
 *   documents      NETWORK-FIRST. The cache is an offline fallback and nothing
 *                  else, so a deploy is live on the very next navigation.
 *   /assets/*      cache-first, because Vite content-hashes them: the URL
 *                  changes whenever the bytes do, so a hit can never be stale.
 *   /icons/*,      stale-while-revalidate. Small, rarely changed, and wanted
 *   the manifest   instantly by the install prompt.
 *   /api/*,        NEVER touched. Prices, stock, the cart, orders and the
 *   /files/*       session live there. A cached price is a customer shown a
 *                  number that is not the price, and a cached /files object is
 *                  one person's private receipt handed to the next.
 *
 * WHY THE ROUTING DECISION IS A PURE FUNCTION. `strategyFor` takes a URL and a
 * request and returns a string. It reads no cache, performs no I/O and has no
 * browser dependency, which is the only reason any of this can be tested
 * without a browser (tests/serviceWorker.test.ts drives it in a node:vm with a
 * stubbed global scope). The `fetch` listener below is a thin switch over it,
 * so a policy mistake is a failing assertion rather than a live incident.
 *
 * OUT OF SCOPE, DELIBERATELY: push, background sync, periodic sync and
 * notifications. None of them is registered here. Web Push in particular has a
 * server half that does not exist (src/pages/Settings.tsx states that honestly
 * to the customer), and a worker that asks for a subscription it cannot use
 * would be a permission prompt in exchange for nothing.
 */

// ---------------------------------------------------------------- versioning

/**
 * Bump this whenever the caching rules change. Every cache name is keyed by it
 * and `activate` deletes every cache that is not on the current list, so a bump
 * is a clean slate — that is the recovery lever if a bad policy ever ships.
 * It is NOT keyed to the app build: the documents are network-first and the
 * assets are content-hashed, so a deploy needs no cache flush.
 */
const VERSION = 'v1';

const DOCUMENT_CACHE = 'levonis-document-' + VERSION;
const ASSET_CACHE = 'levonis-assets-' + VERSION;
const STATIC_CACHE = 'levonis-static-' + VERSION;
const CURRENT_CACHES = [DOCUMENT_CACHE, ASSET_CACHE, STATIC_CACHE];

/**
 * The offline shell is stored under ONE key, the site root, and never under the
 * URL the visitor happened to be on. Caching per-URL documents would make the
 * worker serve one product's page — and, on `/product/*`, one product's share
 * card, which the Worker rewrites per product — in place of another's.
 */
const DOCUMENT_KEY = '/';

/**
 * Hashed chunk names never collide, so a cache-first asset store grows by a
 * full bundle on every deploy and is never emptied by anything: the cache name
 * is keyed to THIS file's version, not to the app build. Vite currently emits
 * on the order of 180 chunks plus stylesheets, so this holds roughly the
 * current build plus a little slack, and the oldest entries are evicted first.
 * Without a cap the store reaches the origin's quota, `cache.put` starts
 * throwing QuotaExceededError, and — if a put were ever awaited on the critical
 * path — the page would stop loading. It is not; see `rememberAsset`.
 */
const ASSET_CACHE_LIMIT = 220;

/**
 * Precached at install, and only these. They are tiny, they genuinely never
 * change within a version, and an install prompt that has to go to the network
 * for its own icon is an install prompt that appears without one.
 *
 * index.html is NOT here, on purpose — see the header. Neither is anything
 * under /assets/, because those names change every deploy and this list does
 * not.
 */
const PRECACHE_URLS = [
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
];

// ------------------------------------------------------------ offline shell

/**
 * The offline document, as a string constant with NO external reference of any
 * kind — no stylesheet, no font, no image, no script. It is the response shown
 * when the network is gone AND nothing has been cached yet, i.e. on the very
 * first visit of a browser that has already installed the worker. Anything it
 * linked to would be a request that also fails, so the page would render
 * unstyled black-on-white with a broken image: exactly the moment a customer
 * decides the store is broken rather than their connection.
 *
 * The retry control is an anchor with an EMPTY href, not a button with an
 * onclick. An empty reference resolves to the current document's own URL
 * (RFC 3986 §5.3 keeps the query), so tapping it re-requests the page the
 * visitor actually wanted — and it needs no script, which matters because this
 * site's Content-Security-Policy refuses inline script everywhere else and a
 * synthesised document should not be the one place that asks for an exception.
 *
 * Arabic-first and RTL, like the rest of the interface, on the site's real
 * black (#000000 — the document's colour, not the softened `--color-canvas`
 * token) with the gold accent.
 */
const OFFLINE_HTML = [
  '<!doctype html>',
  '<html lang="ar" dir="rtl">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="theme-color" content="#000000">',
  '<title>LEVONIS — لا يوجد اتصال بالإنترنت</title>',
  '<style>',
  '  :root { color-scheme: dark; }',
  '  html, body { margin: 0; height: 100%; background: #000000; color: #f2f3f5; }',
  '  body { display: flex; align-items: center; justify-content: center;',
  '         font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif;',
  '         padding: 24px; text-align: center; }',
  '  main { max-width: 26rem; }',
  '  .mark { margin: 0 0 1.5rem; font-size: 0.75rem; font-weight: 700;',
  '          letter-spacing: 0.35em; color: #BAA369; }',
  '  h1 { margin: 0 0 0.75rem; font-size: 1.25rem; font-weight: 700; line-height: 1.5; }',
  '  p.hint { margin: 0 0 2rem; font-size: 0.875rem; line-height: 1.8; color: #b7bbc3; }',
  '  a.retry { display: inline-flex; align-items: center; justify-content: center;',
  '            min-height: 44px; padding: 0 1.5rem; border-radius: 12px;',
  '            background: #ece8dc; color: #101114; font-size: 0.875rem;',
  '            font-weight: 700; text-decoration: none; }',
  '</style>',
  '</head>',
  '<body>',
  '<main>',
  '<p class="mark">LEVONIS</p>',
  '<h1>لا يوجد اتصال بالإنترنت</h1>',
  '<p class="hint">تعذّر الوصول إلى المتجر. تحقّق من اتصالك ثم أعد المحاولة.</p>',
  '<a class="retry" href="">إعادة المحاولة</a>',
  '</main>',
  '</body>',
  '</html>',
].join('\n');

/**
 * Its own locked-down policy, because this document is synthesised here and so
 * inherits nothing from `dist/_headers` — the asset layer never saw it. Inline
 * style is the only thing it needs; everything else is refused.
 */
const OFFLINE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': OFFLINE_CSP,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ------------------------------------------------------- the routing decision

const NETWORK_ONLY = 'network-only';
const NETWORK_FIRST = 'network-first';
const CACHE_FIRST = 'cache-first';
const STALE_WHILE_REVALIDATE = 'stale-while-revalidate';

/** A document request, by either of the two signals a browser may give us. */
function isNavigation(request) {
  return request.mode === 'navigate' || request.destination === 'document';
}

function hasRangeHeader(request) {
  try {
    return !!(request.headers && typeof request.headers.get === 'function' && request.headers.get('range'));
  } catch {
    // A stub or an exotic Request without a real Headers object. Treat the
    // unknown as "do not touch it", which is always the safe answer here.
    return true;
  }
}

/**
 * Decides what this service worker does with a request, and nothing else.
 *
 * Pure: no cache lookup, no network, no side effect. `network-only` is the
 * default answer for everything unrecognised, and it means the `fetch`
 * listener does not even call `respondWith` — the request goes to the network
 * as though no service worker were installed at all.
 */
function strategyFor(url, request) {
  // Anything that is not a plain GET. A POST to /api/orders must never be
  // replayed from anywhere, and a HEAD answered from a cached GET body is a
  // protocol violation.
  if (!request || request.method !== 'GET') return NETWORK_ONLY;

  // Another origin: Google fonts, the sign-in iframe, the analytics beacon,
  // product media on a vendor CDN. Their responses are opaque, so caching them
  // stores a body we cannot inspect and cannot invalidate.
  if (url.origin !== self.location.origin) return NETWORK_ONLY;

  // A ranged request is a partial body. Storing one and replaying it as a
  // whole response is how a video seek turns into a corrupt file.
  if (hasRangeHeader(request)) return NETWORK_ONLY;

  const path = url.pathname;

  // The two surfaces the Worker owns. `/api/*` is prices, stock, cart, orders
  // and the session; `/files/*` serves R2 objects, and the private ones are
  // authorised per request by worker/routes/uploads.ts. Neither is ever read
  // from, or written to, a cache here.
  if (path === '/api' || path.startsWith('/api/')) return NETWORK_ONLY;
  if (path === '/files' || path.startsWith('/files/')) return NETWORK_ONLY;

  // Documents are decided BEFORE the query-string guard below. A navigation is
  // never served from a query-keyed entry — the only document ever stored is
  // the root, under DOCUMENT_KEY — so `/products?cat=x` can safely get the
  // offline fallback, and refusing it would mean a filtered listing is the one
  // page that shows the browser's own error instead of ours.
  if (isNavigation(request)) return NETWORK_FIRST;

  // A query string on a subresource is a cache-buster somebody else added, and
  // the Cache API keys on the full URL, so honouring it means storing a second
  // copy of the same bytes under every variant anyone ever appends.
  if (url.search) return NETWORK_ONLY;

  // Content-hashed by Vite: the URL changes whenever the bytes do, which is
  // exactly the condition under which cache-first cannot go stale.
  if (path.startsWith('/assets/')) return CACHE_FIRST;

  // Small, stable, and wanted instantly by the install prompt — but not
  // immutable, so they are revalidated in the background after being served.
  // The manifest is answered per host by the Worker, which is why it is
  // refreshed rather than pinned.
  if (path.startsWith('/icons/') || path === '/manifest.webmanifest') return STALE_WHILE_REVALIDATE;

  return NETWORK_ONLY;
}

// ------------------------------------------------------------ cache plumbing

/**
 * Only a real, complete, first-party 200 is worth storing.
 *
 * `type === 'basic'` rejects opaque cross-origin responses, whose status is
 * always 0 and whose body cannot be read. `redirected` is the subtle one: the
 * asset layer answers `/index.html` with a 307 to `/`, and serving a redirected
 * response to a navigation throws "a redirected response was used for a request
 * whose redirect mode is not follow" — which would take the app down offline
 * AND online, because the worker answers first either way.
 */
function cacheable(response) {
  return !!response && response.status === 200 && response.type === 'basic' && response.redirected !== true;
}

/** Every cache write is guarded. A QuotaExceededError must never fail a page. */
async function putSafely(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch {
    // Storage is full, blocked (private browsing on some engines), or the
    // response body was already consumed. The page has its response either
    // way; a cache is an optimisation, never a dependency.
  }
}

async function matchSafely(cacheName, request) {
  try {
    const cache = await caches.open(cacheName);
    return await cache.match(request);
  } catch {
    // Same reasoning: a cache we cannot read is a cache miss, not an error.
    return undefined;
  }
}

/**
 * Enforces ASSET_CACHE_LIMIT. `cache.keys()` returns entries in insertion
 * order, so the front of the list is the oldest — i.e. the previous deploy's
 * chunks, which is precisely what should go first.
 */
async function trimAssetCache() {
  try {
    const cache = await caches.open(ASSET_CACHE);
    const keys = await cache.keys();
    if (keys.length <= ASSET_CACHE_LIMIT) return;
    const doomed = keys.slice(0, keys.length - ASSET_CACHE_LIMIT);
    for (const request of doomed) await cache.delete(request);
  } catch {
    // An un-trimmable cache is a large cache, not a broken one.
  }
}

/** Store an asset and trim, off the critical path. */
async function rememberAsset(request, response) {
  await putSafely(ASSET_CACHE, request, response);
  await trimAssetCache();
}

/**
 * A copy of a response, for the cache, or nothing.
 *
 * `clone()` throws once a body has been read or locked. That is bookkeeping,
 * and bookkeeping must never reach the visitor: without this, a throw here
 * would land in the navigation handler's catch and answer a LIVE page with the
 * offline notice, which is the most confusing failure this file could produce.
 */
function copyOf(response) {
  try {
    return response.clone();
  } catch {
    // Nothing to store. The response itself is untouched and still on its way.
    return undefined;
  }
}

/**
 * Hands a background promise to the browser so it is not killed when the
 * worker is spun down, and swallows its rejection. An unhandled rejection
 * inside a service worker is reported against the PAGE, which turns a missed
 * revalidation into a console error the owner will chase for an afternoon.
 */
function later(event, promise) {
  if (!promise || typeof promise.then !== 'function') return promise;
  const quiet = promise.then(
    (value) => value,
    () => undefined
  );
  try {
    if (event && typeof event.waitUntil === 'function') event.waitUntil(quiet);
  } catch {
    // A synthetic event (a test, or a browser that has already finished the
    // dispatch) simply does not extend the lifetime. The work still runs.
  }
  return promise;
}

// -------------------------------------------------------------- the handlers

/**
 * Documents: the network is asked FIRST, every time. The cache is consulted
 * only after the network has actually failed, so a deploy reaches the visitor
 * on the next navigation and `Cache-Control: no-cache` on index.html keeps
 * meaning what it says.
 */
async function handleNavigation(event) {
  const request = event.request;
  let response;

  // ONLY the network call is inside this try. The offline notice is a serious
  // thing to show someone who is online, so it must be reachable from exactly
  // one cause — the network being unreachable — and never from a mistake in
  // the caching below it.
  try {
    response = await fetch(request);
  } catch {
    // Genuinely unreachable. A 404 or a 500 is a response, and was returned.
    const cached = await matchSafely(DOCUMENT_CACHE, DOCUMENT_KEY);
    if (cached) return cached;
    return offlineResponse();
  }

  // Only the ROOT document is kept, and only a genuine HTML 200. A path that
  // is missing from dist/ is answered 200 text/html with the SPA shell rather
  // than 404 (not_found_handling: single-page-application), so a status check
  // on its own would happily store that shell under any URL at all.
  try {
    const url = new URL(request.url);
    if (url.pathname === DOCUMENT_KEY && cacheable(response) && isHtml(response)) {
      const copy = copyOf(response);
      if (copy) later(event, putSafely(DOCUMENT_CACHE, DOCUMENT_KEY, copy));
    }
  } catch {
    // An unreadable URL or header. The page still gets its response.
  }

  return response;
}

function isHtml(response) {
  try {
    const type = response.headers.get('content-type') || '';
    return type.toLowerCase().indexOf('text/html') !== -1;
  } catch {
    // No readable headers means we cannot prove it is a document, and an
    // unproven document is not stored as the offline shell.
    return false;
  }
}

/** /assets/* — served from the cache when present, never revalidated. */
async function handleAsset(event) {
  const request = event.request;
  const cached = await matchSafely(ASSET_CACHE, request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) {
    const copy = copyOf(response);
    if (copy) later(event, rememberAsset(request, copy));
  }
  return response;
}

/** /icons/*, /manifest.webmanifest — instant from cache, refreshed behind it. */
async function handleStatic(event) {
  const request = event.request;
  const cached = await matchSafely(STATIC_CACHE, request);
  const refresh = fetch(request).then((response) => {
    if (cacheable(response)) {
      const copy = copyOf(response);
      if (copy) later(event, putSafely(STATIC_CACHE, request, copy));
    }
    return response;
  });
  if (cached) {
    later(event, refresh);
    return cached;
  }
  try {
    return await refresh;
  } catch {
    // Nothing cached and no network. Falling through to a plain fetch gives
    // the browser exactly the failure it would have had without this worker —
    // a broken icon, never a broken page.
    return fetch(request);
  }
}

// ------------------------------------------------------------- the listeners

self.addEventListener('install', (event) => {
  // No skipWaiting() here. A worker that takes over mid-session replaces the
  // asset cache under a page that is still lazy-loading chunks from the build
  // it was served, and the visitor gets a chunk-load error on the next route
  // they open. The new worker waits; the page asks for it by posting
  // {type:'SKIP_WAITING'} at a moment of its own choosing.
  event.waitUntil(
    (async () => {
      // Deliberately NOT cache.addAll. A path that is not present in dist/ is
      // answered 200 with the SPA shell, and addAll rejects only on a non-2xx
      // status — so a typo would be stored as HTML under a .png key and
      // surface much later as a broken icon nobody can explain. Each file is
      // fetched and its content type checked before it is kept, and a failure
      // is skipped rather than allowed to fail the whole install.
      for (const url of PRECACHE_URLS) {
        try {
          const response = await fetch(url, { cache: 'reload' });
          if (!cacheable(response)) continue;
          const type = (response.headers.get('content-type') || '').toLowerCase();
          if (type.indexOf('image/') !== 0) continue;
          await putSafely(STATIC_CACHE, url, response);
        } catch {
          // Offline at install time, or the file is not deployed yet. The
          // stale-while-revalidate path picks it up on first use.
        }
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(
          names.filter((name) => CURRENT_CACHES.indexOf(name) === -1).map((name) => caches.delete(name))
        );
      } catch {
        // Cache storage is unavailable. The handlers all treat that as a miss,
        // so the app runs network-only — degraded, not broken.
      }
      try {
        await self.clients.claim();
      } catch {
        // Claiming is an optimisation: without it the worker governs the next
        // navigation instead of this one.
      }
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event && event.data;
  // The page's explicit consent to be taken over now — nothing else in this
  // file calls skipWaiting, and no other message shape is acted on.
  if (data && data.type === 'SKIP_WAITING') {
    try {
      self.skipWaiting();
    } catch {
      // Already active, or no worker is waiting. Nothing to do.
    }
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    // An unparseable URL is not ours to handle.
    return;
  }

  const strategy = strategyFor(url, request);

  // NETWORK_ONLY does not call respondWith at all. That is the difference
  // between "this worker passes the request through" and "this worker
  // re-issues the request itself": the latter would drop the credentials mode,
  // the redirect mode and the priority the browser chose, on /api/* of all
  // places. Returning without responding leaves the request completely
  // untouched.
  if (strategy === NETWORK_ONLY) return;

  if (strategy === NETWORK_FIRST) {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (strategy === CACHE_FIRST) {
    event.respondWith(handleAsset(event));
    return;
  }
  if (strategy === STALE_WHILE_REVALIDATE) {
    event.respondWith(handleStatic(event));
  }
});

// --------------------------------------------------------------- for testing
//
// Attached to `self` rather than declared with module syntax, because this file
// is served raw and must stay parseable as a classic worker script. This is the
// seam tests/serviceWorker.test.ts drives: it runs this file inside a node:vm
// with a stubbed global scope and calls the routing decision directly.
self.strategyFor = strategyFor;
self.__LEVONIS_SW__ = {
  VERSION,
  DOCUMENT_CACHE,
  ASSET_CACHE,
  STATIC_CACHE,
  CURRENT_CACHES,
  DOCUMENT_KEY,
  ASSET_CACHE_LIMIT,
  PRECACHE_URLS,
  OFFLINE_HTML,
  strategyFor,
  cacheable,
  offlineResponse,
};

if (typeof console !== 'undefined' && console.debug) console.debug('levonis sw ' + VERSION);
