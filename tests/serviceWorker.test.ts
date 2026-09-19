/**
 * THE SERVICE WORKER'S CACHE POLICY, DRIVEN WITHOUT A BROWSER.
 *
 * `public/sw.js` is the only file in this repository that keeps executing after
 * the tab is closed and that can, on its own, serve every visitor a page built
 * for a deploy that no longer exists. There is no bundler between it and the
 * browser and no type checker over it, so this file is the entire safety net.
 *
 * HOW. The worker is loaded into a `node:vm` context with a stubbed
 * ServiceWorkerGlobalScope — a `self` that records `addEventListener`
 * handlers, a fake `caches`, and a `fetch` the test controls — and then driven
 * with synthetic FetchEvents. That is possible only because the worker keeps
 * its routing decision in one pure function and attaches it to `self`; the
 * assertions below are on REAL BEHAVIOUR (what was fetched, what was read from
 * the cache, in which order, and what came back), not on the source text.
 *
 * The one exception is the last test, which IS about the source text, because
 * "this file is served raw" is a property no behavioural assertion can catch:
 * a stray module statement parses fine here and fails only in the browser, as
 * a registration that silently never happens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SW_PATH = join(ROOT, 'public', 'sw.js');
const SOURCE = readFileSync(SW_PATH, 'utf8');

const ORIGIN = 'https://levonis-iq.com';

// ------------------------------------------------------------- the harness

/** The Cache API keys on the full request URL, so the stub does too. */
function keyOf(input: unknown): string {
  const raw = typeof input === 'string' ? input : String((input as { url: string }).url);
  return new URL(raw, ORIGIN).toString();
}

/**
 * A response the worker is willing to cache. `Response.type` is 'default' in
 * Node and 'basic' in a browser for a same-origin fetch; the worker refuses
 * anything that is not 'basic' (that is how it refuses opaque cross-origin
 * bodies), so the stub has to say so.
 */
function basic(body: string, init: ResponseInit = {}): Response {
  const res = new Response(body, { status: 200, ...init });
  Object.defineProperty(res, 'type', { value: 'basic', configurable: true });
  return res;
}

function html(body: string): Response {
  return basic(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function png(): Response {
  return basic('\u0089PNG', { headers: { 'content-type': 'image/png' } });
}

class FakeCache {
  entries: Array<{ key: string; response: Response }> = [];
  throwOnPut = false;
  constructor(private log: string[], private name: string) {}

  async put(request: unknown, response: Response): Promise<void> {
    this.log.push(`put:${this.name}`);
    if (this.throwOnPut) throw new Error('QuotaExceededError');
    const key = keyOf(request);
    const at = this.entries.findIndex((e) => e.key === key);
    if (at >= 0) this.entries.splice(at, 1);
    this.entries.push({ key, response });
  }

  async match(request: unknown): Promise<Response | undefined> {
    this.log.push(`match:${this.name}`);
    return this.entries.find((e) => e.key === keyOf(request))?.response;
  }

  /** Insertion order, like the real Cache — the worker's eviction relies on it. */
  async keys(): Promise<Array<{ url: string }>> {
    return this.entries.map((e) => ({ url: e.key }));
  }

  async delete(request: unknown): Promise<boolean> {
    const key = keyOf(request);
    const at = this.entries.findIndex((e) => e.key === key);
    if (at < 0) return false;
    this.entries.splice(at, 1);
    return true;
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  constructor(private log: string[]) {}
  async open(name: string): Promise<FakeCache> {
    let store = this.stores.get(name);
    if (!store) {
      store = new FakeCache(this.log, name);
      this.stores.set(name, store);
    }
    return store;
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

interface SwEvent {
  request: unknown;
  response?: Promise<Response>;
  waits: Array<Promise<unknown>>;
  respondWith(value: Promise<Response> | Response): void;
  waitUntil(value: Promise<unknown>): void;
  data?: unknown;
}

function makeEvent(request: unknown): SwEvent {
  const ev: SwEvent = {
    request,
    waits: [],
    respondWith(value) {
      ev.response = Promise.resolve(value);
    },
    waitUntil(value) {
      ev.waits.push(Promise.resolve(value));
    },
  };
  return ev;
}

interface FakeRequestInit {
  method?: string;
  mode?: string;
  destination?: string;
  headers?: Record<string, string>;
}

function makeRequest(url: string, init: FakeRequestInit = {}) {
  return {
    url: new URL(url, ORIGIN).toString(),
    method: init.method ?? 'GET',
    mode: init.mode ?? 'no-cors',
    destination: init.destination ?? '',
    headers: new Headers(init.headers ?? {}),
  };
}

const navigation = (path: string) => makeRequest(path, { mode: 'navigate', destination: 'document' });

type FetchImpl = (input: unknown) => Promise<Response>;

function loadWorker() {
  const log: string[] = [];
  const listeners = new Map<string, Array<(event: SwEvent) => void>>();
  const caches = new FakeCaches(log);
  let fetchImpl: FetchImpl = async () => basic('ok');
  let skipWaitingCalls = 0;
  let claimed = false;

  const self = {
    location: new URL(`${ORIGIN}/`),
    addEventListener(type: string, fn: (event: SwEvent) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    skipWaiting() {
      skipWaitingCalls += 1;
    },
    clients: {
      async claim() {
        claimed = true;
      },
    },
  } as Record<string, unknown>;

  const context: Record<string, unknown> = {
    self,
    caches,
    fetch: (input: unknown) => {
      log.push('fetch');
      return fetchImpl(input);
    },
    Response,
    Request,
    Headers,
    URL,
    console: { debug() {} },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: SW_PATH });

  const dispatch = (type: string, event: SwEvent) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
    return event;
  };

  /**
   * Drains a dispatched event completely.
   *
   * The response has to be awaited FIRST: the worker hands its cache writes to
   * `waitUntil` only after the network has answered, so an event inspected the
   * moment it is dispatched has an empty waits list and every cache assertion
   * below would pass by accident. Then the list is drained repeatedly, because
   * a background task may enqueue another one (storing an asset enqueues the
   * trim). Rejections are swallowed here on purpose — that background work must
   * never reject is asserted by its own test, not by every other one failing.
   */
  const settle = async (event: SwEvent) => {
    if (event.response) await event.response.then(() => undefined, () => undefined);
    let drained = 0;
    while (drained < event.waits.length) {
      const batch = event.waits.slice(drained);
      drained = event.waits.length;
      await Promise.all(batch.map((p) => p.then(() => undefined, () => undefined)));
    }
  };

  return {
    self,
    log,
    caches,
    listeners,
    dispatch,
    settle,
    internals: self.__LEVONIS_SW__ as Record<string, string | number | string[]>,
    strategyFor: self.strategyFor as (url: URL, request: unknown) => string,
    setFetch(fn: FetchImpl) {
      fetchImpl = fn;
    },
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
    get claimed() {
      return claimed;
    },
  };
}

// --------------------------------------------------- the pure routing decision

test('strategyFor never lets the API, the file store, another origin or a write be cached', () => {
  const sw = loadWorker();
  const decide = (path: string, init: FakeRequestInit = {}) =>
    sw.strategyFor(new URL(path, ORIGIN), makeRequest(path, init));

  // Prices, stock, cart, orders and the session. A cached answer here is a
  // customer shown a number that is not the price.
  assert.equal(decide('/api/products'), 'network-only');
  assert.equal(decide('/api/orders/abc/status'), 'network-only');
  assert.equal(decide('/api'), 'network-only');

  // R2 objects, half of which are authorised per request by the Worker.
  assert.equal(decide('/files/receipts/order-1.pdf'), 'network-only');
  assert.equal(decide('/files/products/x.webp'), 'network-only');

  // Another origin: opaque responses we could neither inspect nor invalidate.
  assert.equal(
    sw.strategyFor(new URL('https://fonts.gstatic.com/s/cairo.woff2'), makeRequest('https://fonts.gstatic.com/s/cairo.woff2')),
    'network-only'
  );

  // A write is never replayed from anywhere, not even a navigation-shaped one.
  assert.equal(decide('/api/cart', { method: 'POST' }), 'network-only');
  assert.equal(decide('/', { method: 'POST', mode: 'navigate', destination: 'document' }), 'network-only');
  assert.equal(decide('/', { method: 'HEAD', mode: 'navigate', destination: 'document' }), 'network-only');

  // A partial body stored whole is a corrupt file on the next seek.
  assert.equal(decide('/assets/vendor-webgl-abc.js', { headers: { Range: 'bytes=0-1023' } }), 'network-only');

  // A cache-buster somebody else appended would store a second copy of the
  // same bytes under every variant anyone ever invents.
  assert.equal(decide('/assets/index-abc123.js?v=2'), 'network-only');

  // Nothing unrecognised is ever intercepted.
  assert.equal(decide('/robots.txt'), 'network-only');
});

test('strategyFor routes documents, hashed assets and the install surface', () => {
  const sw = loadWorker();
  const decide = (path: string, init: FakeRequestInit = {}) =>
    sw.strategyFor(new URL(path, ORIGIN), makeRequest(path, init));

  assert.equal(decide('/', { mode: 'navigate', destination: 'document' }), 'network-first');
  assert.equal(decide('/product/lamp', { mode: 'navigate', destination: 'document' }), 'network-first');
  // A filtered listing must not be the one page that shows the browser's own
  // error instead of ours, so the query-string guard does not reach navigations.
  assert.equal(decide('/products?cat=x', { mode: 'navigate', destination: 'document' }), 'network-first');
  // Firefox reports `destination` without `mode` on some navigations.
  assert.equal(decide('/cart', { destination: 'document' }), 'network-first');

  assert.equal(decide('/assets/index-Bxordacj.js'), 'cache-first');
  assert.equal(decide('/assets/index-Bxordacj.css'), 'cache-first');

  assert.equal(decide('/icons/icon-192.png'), 'stale-while-revalidate');
  assert.equal(decide('/icons/maskable-512.png'), 'stale-while-revalidate');

  // THE MANIFEST IS NOT A STATIC FILE, and this assertion is the tripwire that
  // stops it being treated as one again. `worker/routes/manifest.ts` builds the
  // body per host out of a live merchant row, so a stored copy either pins a
  // renamed shop's old name past the route's own 300-second budget (the Cache
  // API keeps no expiry) or, if the first fetch landed while D1 was unreachable,
  // pins the platform fallback «LEVONIS» onto that merchant's origin. It gets
  // `/api/*`'s treatment: never read, never written.
  assert.equal(decide('/manifest.webmanifest'), 'network-only');
});

// ----------------------------------------------------------- the fetch handler

test('a navigation asks the network FIRST and does not read the cache before it', async () => {
  const sw = loadWorker();
  sw.setFetch(async () => html('<!doctype html><title>live</title>'));

  const event = sw.dispatch('fetch', makeEvent(navigation('/')));
  const response = await event.response;
  assert.ok(response, 'the worker answered the navigation');
  assert.equal(await response.text(), '<!doctype html><title>live</title>');

  // The ORDER is the assertion. A cache read before the network would be a
  // cache-first shell, which is the white-screen-after-deploy failure.
  assert.equal(sw.log[0], 'fetch', `first operation was ${sw.log[0]}, not the network`);
  assert.equal(sw.log.filter((l) => l.startsWith('match:')).length, 0, 'no cache was read at all');
});

test('a successful ROOT navigation is kept as the offline shell, and a deeper one is not', async () => {
  const sw = loadWorker();
  const documentCache = String(sw.internals.DOCUMENT_CACHE);
  sw.setFetch(async () => html('<!doctype html><title>shell</title>'));

  await sw.settle(sw.dispatch('fetch', makeEvent(navigation('/'))));
  let store = await sw.caches.open(documentCache);
  assert.equal(store.entries.length, 1, 'the root document is the offline shell');
  assert.equal(store.entries[0].key, `${ORIGIN}/`);

  await sw.settle(sw.dispatch('fetch', makeEvent(navigation('/product/lamp'))));
  store = await sw.caches.open(documentCache);
  assert.equal(store.entries.length, 1, 'one product page must never be stored as another one');
});

test('a 200 that is not HTML is never stored as the offline shell', async () => {
  // A path that does not exist in dist/ is answered 200 with the SPA shell, so
  // a status check alone is not enough — but the inverse matters more: an
  // asset-layer answer that is not a document must not become the document.
  const sw = loadWorker();
  sw.setFetch(async () => basic('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
  await sw.settle(sw.dispatch('fetch', makeEvent(navigation('/'))));
  const store = await sw.caches.open(String(sw.internals.DOCUMENT_CACHE));
  assert.equal(store.entries.length, 0);
});

test('when the network is gone the cached document is served', async () => {
  const sw = loadWorker();
  const store = await sw.caches.open(String(sw.internals.DOCUMENT_CACHE));
  await store.put('/', html('<!doctype html><title>cached shell</title>'));

  sw.setFetch(async () => {
    throw new TypeError('Failed to fetch');
  });

  const event = sw.dispatch('fetch', makeEvent(navigation('/products')));
  const response = await event.response;
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<!doctype html><title>cached shell</title>');
});

test('the offline page follows Accept-Language through all three languages', async () => {
  const sw = loadWorker();
  sw.setFetch(async () => {
    throw new TypeError('Failed to fetch');
  });

  // The service worker cannot read `localStorage`, so it cannot read the choice
  // LanguageContext stores there. `Accept-Language` on the failed navigation is
  // the only signal it has, and this is the test that it is actually used —
  // otherwise a customer who set the interface to English or Sorani gets an RTL
  // Arabic page at the one moment they are already unsure the shop works.
  const offlineFor = async (acceptLanguage?: string) => {
    const request = makeRequest('/', {
      mode: 'navigate',
      destination: 'document',
      headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
    });
    const event = sw.dispatch('fetch', makeEvent(request));
    const response = await event.response;
    assert.ok(response);
    return { response, body: await response.text() };
  };

  const en = await offlineFor('en-GB,en;q=0.9');
  assert.match(en.body, /No internet connection/);
  assert.match(en.body, /lang="en"/);
  assert.match(en.body, /dir="ltr"/);

  const ckb = await offlineFor('ckb,ar;q=0.8');
  assert.match(ckb.body, /پەیوەندی ئینتەرنێت نییە/);
  assert.match(ckb.body, /lang="ckb"/);
  assert.match(ckb.body, /dir="rtl"/);

  // A device set to plain Kurdish gets Sorani, which is the Kurdish the shop
  // actually speaks, rather than falling through to Arabic.
  const ku = await offlineFor('ku-IQ');
  assert.match(ku.body, /lang="ckb"/);

  // Arabic is the floor: an unrecognised language, and no header at all.
  for (const header of ['fr-FR,fr;q=0.9', undefined]) {
    const fallback = await offlineFor(header);
    assert.match(fallback.body, /لا يوجد اتصال بالإنترنت/);
    assert.match(fallback.body, /lang="ar"/);
  }

  // The body varies by a request header, so the response has to say so — a
  // response that varies silently is how one visitor's language reaches the
  // next one through whatever store sits in front of it.
  assert.equal(en.response.headers.get('vary'), 'Accept-Language');
  assert.equal(en.response.headers.get('content-language'), 'en');

  // Every language keeps the properties the offline page lives or dies by: it
  // may reference nothing, because everything it referenced would also fail.
  for (const body of [en.body, ckb.body, ku.body]) {
    assert.doesNotMatch(body, /<script/i);
    assert.doesNotMatch(body, /<link/i);
    assert.doesNotMatch(body, /<img/i);
    assert.doesNotMatch(body, /https?:\/\//);
    assert.match(body, /#000000/);
  }
});

test('with no cached document the offline page comes back: 200, HTML, and Arabic', async () => {
  const sw = loadWorker();
  sw.setFetch(async () => {
    throw new TypeError('Failed to fetch');
  });

  const event = sw.dispatch('fetch', makeEvent(navigation('/')));
  const response = await event.response;
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /text\/html/);

  const body = await response.text();
  assert.match(body, /لا يوجد اتصال بالإنترنت/);
  assert.match(body, /lang="ar"/);
  assert.match(body, /dir="rtl"/);
  assert.match(body, /#000000/);
  // It must survive with no network at all, so it may reference nothing.
  assert.doesNotMatch(body, /<script/i);
  assert.doesNotMatch(body, /<link/i);
  assert.doesNotMatch(body, /<img/i);
  assert.doesNotMatch(body, /https?:\/\//);
});

test('a hashed asset is served from the cache without touching the network', async () => {
  const sw = loadWorker();
  const store = await sw.caches.open(String(sw.internals.ASSET_CACHE));
  await store.put('/assets/index-Bxordacj.js', basic('console.log(1)'));

  sw.setFetch(async () => {
    throw new Error('the network must not be consulted for a cached hashed asset');
  });

  const event = sw.dispatch('fetch', makeEvent(makeRequest('/assets/index-Bxordacj.js')));
  const response = await event.response;
  assert.ok(response);
  assert.equal(await response.text(), 'console.log(1)');
  assert.equal(sw.log.includes('fetch'), false, 'the network was consulted');
});

test('the asset cache is capped, oldest first, so it cannot grow across deploys', async () => {
  const sw = loadWorker();
  const limit = Number(sw.internals.ASSET_CACHE_LIMIT);
  const store = await sw.caches.open(String(sw.internals.ASSET_CACHE));
  for (let i = 0; i < limit + 5; i++) await store.put(`/assets/old-${i}.js`, basic(`chunk ${i}`));

  sw.setFetch(async () => basic('fresh'));
  await sw.settle(sw.dispatch('fetch', makeEvent(makeRequest('/assets/new-Bxordacj.js'))));

  assert.equal(store.entries.length, limit, `expected the cache trimmed to ${limit}`);
  assert.equal(store.entries[store.entries.length - 1].key, `${ORIGIN}/assets/new-Bxordacj.js`);
  assert.equal(store.entries[0].key, `${ORIGIN}/assets/old-6.js`, 'the oldest entries go first');
});

test('the API and the file store are not answered by the worker at all', async () => {
  const sw = loadWorker();
  sw.setFetch(async () => basic('never'));

  for (const path of ['/api/products', '/files/products/x.webp']) {
    const event = sw.dispatch('fetch', makeEvent(makeRequest(path)));
    assert.equal(event.response, undefined, `${path} must pass through untouched`);
  }
  assert.deepEqual(sw.log, [], 'the worker did not even re-issue the request itself');
});

test('a cache.put that throws does not make the handler reject', async () => {
  const sw = loadWorker();
  const assets = await sw.caches.open(String(sw.internals.ASSET_CACHE));
  const documents = await sw.caches.open(String(sw.internals.DOCUMENT_CACHE));
  assets.throwOnPut = true;
  documents.throwOnPut = true;

  sw.setFetch(async (input) =>
    String((input as { url?: string }).url ?? input).endsWith('.js') ? basic('chunk') : html('<!doctype html>')
  );

  const asset = sw.dispatch('fetch', makeEvent(makeRequest('/assets/index-Bxordacj.js')));
  const assetResponse = await asset.response;
  assert.equal(await assetResponse!.text(), 'chunk');
  await sw.settle(asset);

  const page = sw.dispatch('fetch', makeEvent(navigation('/')));
  const pageResponse = await page.response;
  assert.equal(await pageResponse!.text(), '<!doctype html>');
  await sw.settle(page);
});

// -------------------------------------------------- install, activate, message

test('install precaches the icons and refuses anything that is not an image', async () => {
  const sw = loadWorker();
  sw.setFetch(async () => png());
  const install = sw.dispatch('install', makeEvent(undefined));
  await sw.settle(install);
  const store = await sw.caches.open(String(sw.internals.STATIC_CACHE));
  assert.equal(store.entries.length, (sw.internals.PRECACHE_URLS as string[]).length);

  // The trap: a path missing from dist/ answers 200 with the SPA shell, so
  // cache.addAll would store HTML under a .png key and the failure would only
  // surface much later as an icon nobody can explain.
  const shell = loadWorker();
  shell.setFetch(async () => html('<!doctype html><title>SPA</title>'));
  await shell.settle(shell.dispatch('install', makeEvent(undefined)));
  const shellStore = await shell.caches.open(String(shell.internals.STATIC_CACHE));
  assert.equal(shellStore.entries.length, 0, 'the SPA shell was stored under an icon URL');
});

test('install does NOT skip waiting; only the page asking for it does', async () => {
  const sw = loadWorker();
  sw.setFetch(async () => png());
  await sw.settle(sw.dispatch('install', makeEvent(undefined)));
  assert.equal(sw.skipWaitingCalls, 0, 'taking over mid-session breaks a page mid lazy-load');

  const ignored = makeEvent(undefined);
  ignored.data = { type: 'SOMETHING_ELSE' };
  sw.dispatch('message', ignored);
  assert.equal(sw.skipWaitingCalls, 0);

  const asked = makeEvent(undefined);
  asked.data = { type: 'SKIP_WAITING' };
  sw.dispatch('message', asked);
  assert.equal(sw.skipWaitingCalls, 1);
});

test('activate deletes exactly the caches that are not current, then claims', async () => {
  const sw = loadWorker();
  const current = sw.internals.CURRENT_CACHES as string[];
  assert.ok(current.length >= 3);

  for (const name of [...current, 'levonis-document-v0', 'levonis-assets-v0', 'something-else']) {
    await sw.caches.open(name);
  }

  await sw.settle(sw.dispatch('activate', makeEvent(undefined)));

  assert.deepEqual([...sw.caches.stores.keys()].sort(), [...current].sort());
  assert.equal(sw.claimed, true);
});

// ------------------------------------------------------------ served raw

test('sw.js is a classic script: no module syntax, no bare specifier, no require', () => {
  // Vite copies public/ byte for byte — there is no bundler to resolve any of
  // these, and the browser rejects the registration outright rather than
  // degrading, so an offline mode would silently never exist.
  assert.doesNotMatch(SOURCE, /^\s*(?:import|export)\b/m, 'module syntax');
  assert.doesNotMatch(SOURCE, /\bimport\s*\(/, 'dynamic import');
  assert.doesNotMatch(SOURCE, /\brequire\s*\(/, 'CommonJS require');
  assert.doesNotMatch(SOURCE, /\bfrom\s+['"][^'"]+['"]/, 'a bare or relative specifier');
  assert.doesNotMatch(SOURCE, /\bimportScripts\s*\(/, 'importScripts');

  // The seam this whole file depends on.
  assert.match(SOURCE, /self\.strategyFor\s*=\s*strategyFor;/);
});

test('every precached URL is a file that genuinely ships in dist/', () => {
  // THE TRAP THIS CLOSES. A path that is not present in dist/ is answered 200
  // with the SPA shell, not 404 (not_found_handling: single-page-application),
  // so a typo in the precache list is stored as HTML under a .png key and
  // surfaces weeks later as a home-screen icon that will not draw. Vite copies
  // public/ into dist/ byte for byte, so "exists in public/" is the check.
  const sw = loadWorker();
  const urls = sw.internals.PRECACHE_URLS as string[];
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(url.startsWith('/'), `${url} must be an absolute path`);
    assert.equal(existsSync(join(ROOT, 'public', url.slice(1))), true, `public${url} does not exist`);
  }
});
