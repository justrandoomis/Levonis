/**
 * THE TWO ANSWERS EVERY FIRST PAINT WAITS FOR, STARTED BEFORE REACT EXISTS.
 *
 * Measured in the lab (docs/PERFORMANCE_LOG.md «P2b»): the app rendered
 * nothing but the route fallback until `GET /api/storefront/resolve` came
 * back, and that request left only after every chunk was parsed, React had
 * mounted and `StoreProvider`'s effect had run — ≈2.0 s into a Slow-4G visit,
 * one whole round trip after the code was already in the browser. `/api/home`
 * left later still, from `Home`'s own effect. Neither depends on anything
 * React computes, so both can leave the moment this module evaluates, and
 * overlap the parse and the mount instead of following them.
 *
 * TWO SOURCES, IN ORDER OF COST:
 *
 *   1. THE DOCUMENT ITSELF. For the pages the Worker already rewrites for a
 *      share card (a store's home, a product page — worker/index.ts
 *      `assetWithPreview`), the server puts the resolve answer INTO the
 *      document as `<script type="application/json" id="lv-resolve">`. It is
 *      the anonymous answer — the same bytes `/api/storefront/resolve` gives a
 *      visitor with no session — so it can be read synchronously by anyone
 *      and no request is made at all. A data block of that type is never
 *      executed, so the CSP's script allowance is untouched.
 *   2. A REQUEST STARTED HERE, at module evaluation, when the document
 *      carries no answer: `/api/storefront/resolve` always, and `/api/home`
 *      on `/` unless the document says this host is a store (a store's `/`
 *      is its own home and never reads `/api/home`).
 *
 * The consumers (`src/StoreContext.tsx`, `src/pages/Home.tsx`) take the
 * primed response ONCE with `takePrimed` and settle it through `settleJson`,
 * which mirrors `src/lib/api.ts` exactly: the same deadline, the same
 * `ApiError` shape (status, code, details, the whole body) for every refusal
 * the callers already branch on (`STORE_MOVED`, `STORE_UNAVAILABLE`, a 404),
 * the same mascot feedback. A retry, or any later call, goes through `api.get`
 * as before — nothing here caches an answer; a primed request is a request
 * that simply started earlier.
 *
 * NOTHING HERE MAY BREAK A PAGE LOAD: a malformed data block reads as absent,
 * a failed primed request rejects only in the hands of the consumer that took
 * it (the promise is settled quietly otherwise), and without a `window` (the
 * unit tests, a server render) the module does nothing.
 */
import { api, ApiError, DEFAULT_TIMEOUT_MS } from './api';
import { beginRequestFeedback, type MascotFeedback } from './mascotRequest';
import { requestErrorText } from './requestErrorText';

export const RESOLVE_PATH = '/api/storefront/resolve';
export const HOME_PATH = '/api/home';
/**
 * WHOSE SESSION THIS IS, ASKED WITH THE ENTRY (speed audit 2026-10-16).
 * `AuthProvider` sent it from its mount effect — after every chunk had been
 * parsed and React had mounted — and three things wait for it: the community
 * gate, the guarded routes (`ProtectedRoute` draws its fallback until the
 * session is known, so a signed-in cart did not even ask for its page's code
 * before this answer), and the reads keyed on the viewer. It depends on
 * nothing React computes, so it leaves here, on every page; `AuthContext`
 * takes it once (`takePrimedJson`, whose epoch guard re-asks if the session
 * changes while it settles). `private, no-store` on the server: nothing caches it.
 */
export const AUTH_ME_PATH = '/api/auth/me';
/**
 * «IS LEVO COMMUNITY OPEN TO ME?» on the pages the gate wraps
 * (src/App.tsx `CommunityGate`): the whole body of those pages is that
 * answer, and the server answers it from the cookie the request carries — the
 * same cookie /api/auth/me reads — so it need not wait for /me either
 * (src/pages/community/access.tsx takes it). Measured live (phone, Slow-4G,
 * ×4 CPU): /me then the access read then the card, one after another; priming
 * both took the card's LCP from 2.98 to 2.45 s.
 */
export const COMMUNITY_ACCESS_PATH = '/api/community/access';
/** The main site's paths behind `CommunityGate` (src/App.tsx), which read COMMUNITY_ACCESS_PATH before anything else. */
export function isCommunityGatedPath(pathname: string): boolean {
  return /^\/(?:community(?:\/.*)?|u\/[^/]+\/?|requests(?:\/[^/]+)?\/?|followed-stores\/?)$/i.test(pathname);
}
export function productsOpeningPath(search = ''): string {
  const query = new URLSearchParams(search);
  const params = new URLSearchParams();
  if (query.get('search')) params.set('search', query.get('search')!);
  if (query.get('category')) params.set('category', query.get('category')!);
  params.set('limit', '50');
  return `/api/products?${params}`;
}

/** The next catalogue read can overlap its route chunk on an actual tap.
 * Only the main storefront and same-origin catalogue links qualify. This
 * never warms account, cart or payment data, and carries no arbitrary query
 * parameters into an API path. */
export function navigationDataPath(href: string, origin: string): string | null {
  try {
    const url = new URL(href, origin);
    const current = new URL(origin);
    if (url.origin !== current.origin || !['levonis-iq.com', 'www.levonis-iq.com'].includes(url.hostname)) return null;
    if (url.pathname === '/products') return productsOpeningPath(url.search);
    if (!/^\/product\/[^/]+\/?$/.test(url.pathname)) return null;
    const slug = decodeURIComponent(url.pathname.split('/')[2]);
    if (!slug || /[/\\?#]/.test(slug)) return null;
    return `/api/products/${slug}`;
  } catch {
    return null;
  }
}
/**
 * THE CATEGORY PAGES' FIRST READS, BY URL (speed audit 2026-10-16: the
 * category pages were the slowest in the audit, ~6 s on a phone, because each
 * read waited for the one before it: route chunk → catalogue → listing →
 * pictures). Every one of these is answerable from the URL alone, so they
 * start with the entry script on a cold load, and on the press of a link in
 * the app — overlapping the route chunk instead of following it:
 *
 *   /categories             the map                 /api/catalog/tree
 *   /categories/<cat>       the department          /api/catalog/<cat>
 *   /categories/<cat>/<sub> the map, and the list   /api/catalog/tree +
 *                           by its slug              /api/products?category=<sub>&facets=1&limit=24
 *
 * The list is asked for BY SLUG (the Worker resolves a slug as well as an id,
 * worker/routes/products.ts `listCatalogProducts`), so it no longer waits for
 * the map to turn the slug into an id; only a URL without a query (the
 * default list) is started here — a filtered one starts from its page.
 *
 * A DEPARTMENT THAT IS ITS OWN LISTING says so on its answer's headers
 * (`X-Catalog-Listing: <slug>`, worker/routes/catalog.ts), so its list starts
 * the moment those headers arrive rather than after the page has rendered.
 */
export const CATALOG_TREE_PATH = '/api/catalog/tree';
const MAIN_HOSTS = ['levonis-iq.com', 'www.levonis-iq.com'];
export const CATALOG_LISTING_HEADER = 'X-Catalog-Listing';

/** What src/components/listing/useListing.ts asks first for a category's default list (a test holds them equal). */
export function categoryListingPath(slug: string): string {
  return `/api/products?category=${encodeURIComponent(slug).replace(/%2C/gi, ',')}&facets=1&limit=24`;
}

const segment = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  try {
    const s = decodeURIComponent(raw);
    return s && !/[/\\?#]/.test(s) ? s : null;
  } catch {
    return null;
  }
};

/** The reads a `/categories…` URL makes first; [] for any other path. */
export function categoryOpeningPaths(pathname: string, search = ''): string[] {
  const m = /^\/categories(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return [];
  if (m[1] === undefined) return [CATALOG_TREE_PATH];
  const cat = segment(m[1]);
  if (!cat) return [];
  if (m[2] === undefined) return [`/api/catalog/${encodeURIComponent(cat)}`];
  const sub = segment(m[2]);
  if (!sub) return [];
  const plain = new URLSearchParams(search).toString() === '';
  return plain ? [CATALOG_TREE_PATH, categoryListingPath(sub === 'all' ? cat : sub)] : [CATALOG_TREE_PATH];
}

/** Start a category URL's first reads, and a listing department's list on its answer's headers. */
export function primeCategoryOpening(pathname: string, search = '', start: (path: string) => void = primeGet): string[] {
  const paths = categoryOpeningPaths(pathname, search);
  for (const path of paths) start(path);
  const department = paths.length === 1 && paths[0] !== CATALOG_TREE_PATH ? primed.get(paths[0]) : undefined;
  if (department && new URLSearchParams(search).toString() === '') {
    department
      .then((res) => {
        const slug = segment(res.headers.get(CATALOG_LISTING_HEADER) ?? undefined);
        if (slug) start(categoryListingPath(slug));
      })
      .catch(() => undefined);
  }
  return paths;
}

/** A press on a same-origin link into the catalogue map, on the main site: its first reads. */
export function navigationCategoryOpening(href: string, origin: string, start: (path: string) => void = primeGet): string[] {
  try {
    const url = new URL(href, origin);
    if (url.origin !== new URL(origin).origin || !MAIN_HOSTS.includes(url.hostname)) return [];
    return primeCategoryOpening(url.pathname, url.search, start);
  } catch {
    return [];
  }
}

/** The id of the data block `worker/index.ts` writes into a rewritten document. */
export const INLINE_RESOLVE_ID = 'lv-resolve';

const primed = new Map<string, Promise<Response>>();
const deadlines = new WeakMap<Promise<Response>, { finish: () => void; cancel: () => void }>();
let sessionEpoch = 0;

/** Bumped by every `clearPrimedRequests`: an answer asked under another number was asked for another session. */
export function primedSessionEpoch(): number {
  return sessionEpoch;
}

/** Authentication changed: an opening answer from the earlier session is unusable. */
export function clearPrimedRequests(): void {
  for (const response of primed.values()) deadlines.get(response)?.cancel();
  primed.clear();
  sessionEpoch += 1;
}

/** Consumed once, never a page cache. A session change while it settles forces a fresh GET. */
export function takePrimedJson<T>(path: string, mascot?: MascotFeedback): Promise<T> | null {
  const response = takePrimed(path);
  if (!response) return null;
  return (async () => {
    let epoch = sessionEpoch;
    let answer = settleJson<T>(path, response, mascot);
    for (;;) {
      try {
        const data = await answer;
        if (epoch === sessionEpoch) return data;
      } catch (error) {
        if (epoch === sessionEpoch) throw error;
      }
      epoch = sessionEpoch;
      // The ordinary in-flight coalescer is keyed by URL. An old-session
      // request for this URL may still be pending, so explicitly bypass it.
      answer = api.get<T>(path, { signal: new AbortController().signal, mascot });
    }
  })();
}

/** The JSON of a `<script type="application/json" id=…>` data block, or null when absent or unreadable. */
export function readInlineJson<T>(id: string): T | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(id);
  if (!el || el.tagName !== 'SCRIPT' || (el as HTMLScriptElement).type !== 'application/json') return null;
  try {
    const text = (el.textContent || '').trim();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Start a GET now, once per path, with the API client's own deadline. */
export function primeGet(path: string, timeoutMs = DEFAULT_TIMEOUT_MS): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function' || primed.has(path)) return;
  const controller = new AbortController();
  const started = fetch(path, { credentials: 'same-origin', signal: controller.signal });
  const timer = setTimeout(() => {
    if (primed.get(path) === started) primed.delete(path);
    controller.abort();
    deadlines.delete(started);
  }, timeoutMs);
  // Keep the deadline alive through res.json(), not just response headers.
  const finish = () => { clearTimeout(timer); deadlines.delete(started); };
  deadlines.set(started, { finish, cancel: () => { controller.abort(); finish(); } });
  // A primed request nobody takes must not surface as an unhandled rejection.
  started.catch(() => {
    if (primed.get(path) === started) primed.delete(path);
    finish();
  });
  primed.set(path, started);
}

/** The primed response for `path`, handed out once; null when none was started (or it was already taken). */
export function takePrimed(path: string): Promise<Response> | null {
  const started = primed.get(path) ?? null;
  primed.delete(path);
  return started;
}

/**
 * Settle a primed response the way `api.get` would have: JSON in, `ApiError`
 * out for every non-2xx or `success:false` body, a network failure for an
 * aborted or unreachable request, and the mascot's request feedback around it.
 */
export async function settleJson<T>(path: string, response: Promise<Response>, mascot?: MascotFeedback): Promise<T> {
  const feedback = beginRequestFeedback('GET', path, mascot);
  try {
    let res: Response;
    try {
      res = await response;
    } catch {
      throw new ApiError(0, requestErrorText('network'), 'NETWORK');
    }
    let data: { success?: boolean; error?: string; code?: string; details?: Record<string, unknown> } & T;
    try {
      data = await res.json();
    } catch {
      throw new ApiError(res.status, res.ok ? requestErrorText('invalid') : requestErrorText('server', res.status));
    }
    if (!res.ok || data.success === false) {
      throw new ApiError(
        res.status,
        data.error || requestErrorText('server', res.status),
        data.code,
        data.details,
        data as unknown as Record<string, unknown>
      );
    }
    feedback.finish();
    return data;
  } catch (error) {
    feedback.finish(error instanceof ApiError ? error : { status: 0 });
    throw error;
  } finally {
    deadlines.get(response)?.finish();
  }
}

/**
 * What to start for this page: the resolve answer unless the document carries
 * it, and `/api/home` for the platform's own front page. Exported for the
 * tests; called once below when a window exists.
 */
export function bootRequests(
  pathname: string,
  inline: { kind?: unknown } | null,
  start: (path: string) => void = primeGet,
  search = '',
  hostname = ''
): string[] {
  const started: string[] = [];
  if (!inline) started.push(RESOLVE_PATH);
  if (pathname === '/' && (!inline || inline.kind !== 'merchant')) started.push(HOME_PATH);
  // A bare /product on a custom or merchant host is not a platform product.
  // Only the two canonical main-site hosts may start catalogue requests here.
  if ((hostname === 'levonis-iq.com' || hostname === 'www.levonis-iq.com') && inline?.kind !== 'merchant') {
    if (pathname === '/products') started.push(productsOpeningPath(search));
    if (/^\/product\/[^/]+\/?$/.test(pathname)) {
      try { started.push(`/api/products/${decodeURIComponent(pathname.split('/')[2])}`); } catch { /* invalid route encoding */ }
    }
    if (isCommunityGatedPath(pathname)) started.push(COMMUNITY_ACCESS_PATH);
  }
  for (const path of started) start(path);
  if ((hostname === 'levonis-iq.com' || hostname === 'www.levonis-iq.com') && inline?.kind !== 'merchant') {
    started.push(...primeCategoryOpening(pathname, search, start));
  }
  // Last: the page's own opening reads go out first; the session follows on every page.
  started.push(AUTH_ME_PATH);
  start(AUTH_ME_PATH);
  return started;
}

if (typeof window !== 'undefined') {
  try {
    bootRequests(window.location.pathname, readInlineJson<{ kind?: unknown }>(INLINE_RESOLVE_ID), primeGet, window.location.search, window.location.hostname);
  } catch {
    // Nothing here may break a page load.
  }
}
