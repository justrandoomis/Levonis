/**
 * THE EDGE POLICY FOR THE ANONYMOUS PUBLIC READS (P2a; plan §B.1 #2).
 *
 * One helper over worker/lib/publicApi/cache.ts (`edgeCache`, `weakEtag`,
 * `conditional`) for the routes the SPA calls on every boot and every page:
 * /api/home, /api/home/sections, /api/products, /api/products/:slug,
 * /api/settings/public, /api/community/access, /api/storefront/*, the print
 * catalogue. Each of them answered from D1 on every call — three to nine
 * dependent round trips from a Worker in Baghdad to a primary in another
 * region — for a body that is the same for every visitor who is not signed in.
 *
 * THE RULE, IN ONE SENTENCE: a body that could be somebody's is never shared.
 *
 *   `anonymousCached` stores and serves ONLY when the request is a GET that
 *   carries no session cookie, no Authorization header and no resolved user.
 *   A signed-in request runs the route exactly as before and leaves with
 *   `private, no-store` — its prices are its membership's, its `favorite` is
 *   its own, and no cache anywhere may hold them. The cookie's PRESENCE is
 *   the test (worker/lib/session.ts `hasSessionCookie`): whether it still
 *   names a live session is irrelevant to whether the answer may be shared.
 *
 * THE KEY is canonical: the request's origin (a store host keys its own
 * `/resolve`), the path, and only the query parameters the route DECLARES,
 * sorted. An unknown parameter cannot mint an entry, and `?a=1&b=2` and
 * `?b=2&a=1` are one entry (the public API's rule, worker/routes/publicApi.ts).
 *
 * THE LIFETIME is `public, max-age=60, s-maxage=120, stale-while-revalidate=600`
 * unless the route says otherwise: a minute in the browser, two at the edge,
 * and ten more minutes in which a colo may answer stale while it refreshes —
 * so a slow primary costs the first visitor after the window, never the
 * hundredth. The Workers Cache API implements none of that by itself (it
 * drops an entry at its `s-maxage` and never serves stale), so `edgeServe`
 * below does it: see «STALE WHILE REVALIDATE, AS DECLARED». Every answer, hit
 * or miss, 200 or 304, leaves with THIS header:
 * Cloudflare hands a Cache API hit back with `max-age` raised to the zone's
 * Browser Cache TTL (four hours, seen live), and the re-stamp of
 * worker/routes/catalog.ts:84-96 is kept here for the same reason.
 *
 * A weak ETag over the body lets a browser revalidate with `If-None-Match`
 * and get a bodiless 304, on a hit or a miss alike.
 *
 * THE BROWSER'S CACHE STRADDLES THE SIGN-IN. A route whose SESSION variant
 * differs from its guest variant (prices per membership, `favorite`,
 * `viewer_tier`, the community `admin`/`may_enter`, a merchant's own printer
 * groups) declares `perViewer: true` and its anonymous answer leaves with
 * `Vary: Cookie`. A browser keys such an entry on the Cookie header too, so
 * the guest body it stored a moment before sign-in cannot answer the first
 * request after it — the session cookie is new, the entry does not match,
 * the Worker builds the member's answer (review finding, P2 review). The
 * colo's own key is built here and never consults `Vary`, so the edge hit
 * rate is unchanged. A route that is the same bytes for everyone (the public
 * settings, the storefront, the print catalogue) keeps the plain policy.
 *
 * ONLY A 200 IS STORED. A refusal (`STORE_UNAVAILABLE`, a 404, a 5xx) is
 * about the moment or the caller and is answered fresh every time; an empty
 * body is never a catalogue answer (the gateway learned that from a HEAD:
 * Hono answers HEAD from the GET route with an empty body, which is why only
 * GET reaches the cache at all).
 *
 * PURGE is per colo, like every Cache API delete: `purgeAnonymousCache`
 * drops the canonical entries for the paths an admin write changed
 * (`resetCommunityAccessCache`'s pattern) and marks the paths purged, which
 * retires their parameterised copies in that colo too; other colos keep
 * theirs within the declared `s-maxage + stale-while-revalidate`. The seams are on the writes that exist: the settings PUT and
 * the site-media upload, the community gate PUT, every merchant write (one
 * middleware on the merchant routers), a store's rename and the two admin
 * sanctions, the admin product and benefit-rule writes and the PRO pause
 * (the catalogue seam), the printer-model PATCH.
 *
 * `caches` does not exist under Node, where the tests run: the same code then
 * builds every answer and still stamps the policy, the ETag and the 304, so
 * tests/edgeCachePolicy.test.ts proves the headers on the real routes and
 * proves the store/hit path with a stand-in `caches.default`.
 */
import { withCacheEpoch } from './publicApi/cache';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppContext } from './types';
import { conditional, edgeCache, weakEtag } from './publicApi/cache';
import { hasSessionCookie } from './session';
import { forgetPricingInputs } from './membershipBenefits';
import { rootDomainFrom, storeUrl } from './hosts';

export interface EdgeLifetime {
  /** Seconds a browser may reuse the answer. */
  maxAge: number;
  /** Seconds the edge (and any shared cache) may reuse it. */
  sMaxAge: number;
  /** Seconds past `sMaxAge` a stale copy may be served while it refreshes. */
  staleWhileRevalidate: number;
}

/** The plan's policy for every anonymous public read (§B.1 #2). */
export const ANONYMOUS_LIFETIME: EdgeLifetime = { maxAge: 60, sMaxAge: 120, staleWhileRevalidate: 600 };

/** What a session-bound answer leaves with: nothing between the Worker and the browser may keep it. */
export const SESSION_CACHE_CONTROL = 'private, no-store';

/** The header a per-viewer route's anonymous answer varies on — the sign-in boundary, as a browser cache sees it. */
export const VIEWER_VARY = 'Cookie';

export function cacheControlFor(lifetime: EdgeLifetime = ANONYMOUS_LIFETIME): string {
  // A route that declares no stale window says nothing about one (the catalogue tree's
  // `public, max-age=60, s-maxage=300`), rather than a `stale-while-revalidate=0` no cache needs.
  const stale = lifetime.staleWhileRevalidate > 0 ? `, stale-while-revalidate=${lifetime.staleWhileRevalidate}` : '';
  return `public, max-age=${lifetime.maxAge}, s-maxage=${lifetime.sMaxAge}${stale}`;
}

/** The header the anonymous routes emit by default — spelled once, pinned by the tests. */
export const ANONYMOUS_CACHE_CONTROL = cacheControlFor(ANONYMOUS_LIFETIME);

/** Public projections changed at this privacy release. An older cached body
 * can carry removed fields even after every route is corrected, and its ETag
 * could otherwise authorize a browser to reuse those bytes. Only entries
 * built by this projection revision may answer. Bump when removing fields.
 * 2026-10-13 (DECISIONS row 220): the print-service rates, the owner's FX
 * adjustment in `displayUsdRate`, a picture's supplier link and the estimate's
 * quantity curve left the public answers.
 * 2026-10-15 (DECISIONS row 240): catalog-only cards and pages (`price_status`,
 * null prices) — a body cached before could say the product is absent.
 * 2026-10-16 (docs/bambu-import/I18N-DESIGN.md §A.5, §C): the knowledge
 * answer's compatibility is one item per label with `more`, and the imported
 * English carries the translation memory's words — a pre-release copy would
 * still show the repeated chips.
 * 2026-10-17 (DECISIONS row 248): cards, levels and quotes carry the shop's
 * dollar prices (`*_usd_cents`) — a body cached before would keep reading the
 * dinar price divided back by a rate. */
export const PUBLIC_PROJECTION_REVISION = 'usd-base-2026-10';
const PROJECTION_HEADER = 'X-Levonis-Public-Projection';

/**
 * Could this request's answer be somebody's? A GET with no session cookie,
 * no Authorization and no user set by anything upstream is nobody's.
 */
export function isAnonymousGet(c: Context<AppContext>): boolean {
  if (c.req.method !== 'GET') return false;
  if (c.req.header('Authorization')) return false;
  if (hasSessionCookie(c.req.header('Cookie'))) return false;
  // `undefined` on the session-free paths (worker/index.ts), `null` for a
  // guest whose session was looked up: either way nobody.
  return !c.get('user');
}

/**
 * The canonical cache key: `https://<host>/<path>?<declared params, sorted>`.
 * A `Request` because that is what `caches.default` keys on. The host is the
 * request's `Host` header (the store hosts key their own answers; the apex
 * its own) and the scheme is always `https`, so the key is the same whether
 * the request was seen behind TLS, in a test harness, or named by a purge
 * seam that only knows the hostname.
 */
export function canonicalKey(requestUrl: string, declaredParams: readonly string[] = [], host?: string | null): Request {
  const url = new URL(requestUrl);
  const params = [...url.searchParams.entries()]
    .filter(([k]) => declaredParams.includes(k))
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const search = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const hostname = (host || url.host).trim().toLowerCase();
  // The catalogue cache epoch (the clean start): every key carries it, so no pre-release answer is ever hit.
  return new Request(withCacheEpoch(`https://${hostname}${path}${search ? `?${search}` : ''}`), { method: 'GET' });
}

export interface AnonymousCacheOptions {
  /** The query parameters that may change the answer. Anything else is ignored by the key. */
  params?: readonly string[];
  /** The route's own lifetime, when it differs from the plan's default. */
  lifetime?: EdgeLifetime;
  /**
   * True when a signed-in caller gets a DIFFERENT body than a guest: the
   * anonymous answer then carries `Vary: Cookie`, so a browser that stored it
   * as a guest does not keep serving it to the person who just signed in.
   */
  perViewer?: boolean;
}

/** Append `Cookie` to the response's `Vary` without dropping what a middleware already put there. */
export function varyOnViewer(headers: Headers): void {
  const have = (headers.get('Vary') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (have.some((v) => v === '*' || v.toLowerCase() === VIEWER_VARY.toLowerCase())) return;
  headers.set('Vary', [...have, VIEWER_VARY].join(', '));
}

/**
 * What a browser's HTTP cache does with `Vary` (RFC 9111 §4.1): a stored
 * response answers a request only when every header it names is the same on
 * both. Used by the tests to prove the sign-in boundary; `*` never matches.
 */
export function browserMayReuse(stored: Response, storedRequestHeaders: Headers, request: Headers): boolean {
  const vary = (stored.headers.get('Vary') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (vary.includes('*')) return false;
  return vary.every((h) => (storedRequestHeaders.get(h) ?? '') === (request.get(h) ?? ''));
}

function schedule(c: Context<AppContext>, work: Promise<unknown>): Promise<void> {
  const quiet = work.then(() => undefined, () => undefined);
  try {
    c.executionCtx.waitUntil(quiet);
    return Promise.resolve();
  } catch {
    // No execution context (a test calling the app without one): finish inline.
    return quiet;
  }
}

// ------------------------------------------- stale while revalidate, as declared
//
// STALE WHILE REVALIDATE, AS DECLARED (speed audit 2026-10-16, findings «the edge
// cache never serves stale»). Every anonymous answer has always gone out with
// `s-maxage=120, stale-while-revalidate=600`, and the comments above and on
// CATALOG_CACHE_EPOCH promised a colo would answer stale for those ten minutes.
// The Workers Cache API ignores `stale-while-revalidate`: an entry vanished at
// 120 s and the next guest in that colo paid the whole D1 build (0.5–1.5 s
// measured live, 2–5 dependent round trips). So the edge now does what the
// header has always said, and nothing more:
//
//   age ≤ s-maxage / 2           fresh: served.
//   s-maxage / 2 < age ≤ s-maxage  fresh: served, and rebuilt in the background
//                                 (`waitUntil`), so a key that is read at least
//                                 once a minute never reaches its end at all.
//   s-maxage < age ≤ s-maxage + swr   stale: served AT ONCE, rebuilt in the background
//                                 — only where the route declares a stale window
//                                 (`staleWhileRevalidate > 0`).
//   older, or retired by a purge    a miss: built inline, exactly as before.
//
// THE FRESHNESS RULES DO NOT MOVE. No header changes. No copy is ever served
// older than the route's own `s-maxage + stale-while-revalidate` — the bound its
// Cache-Control has always published to every cache on the path, and the one a
// browser already applies to the same answer (Chrome honours
// `stale-while-revalidate` on fetches). A route that declares no stale window
// (the catalogue tree, a category page — worker/routes/catalog.ts) is never
// served past its `s-maxage`: it only gains the background refresh. Per route
// class:
//
//   prices and stock   the listing, search, a product, the home, the shelves, a
//                      store's products — the declared 120 s + 600 s, unchanged;
//                      a signed-in request never sees a shared copy, the cart and
//                      the checkout price from D1, and an admin write retires
//                      every copy of the paths it names in its colo AT ONCE
//                      (below: parameterised copies included, which before
//                      lived on up to 120 s even in the colo that wrote).
//   the category map   tree and category page: their own s-maxage, no stale window.
//   configuration      the resolve, the public settings, the community gate, the
//                      storefront, the print catalogue, the knowledge answer:
//                      the declared window.
//
// A stale or late-fresh copy leaves with `Age` (seconds since it was BUILT), so a
// browser counts its own `max-age` and stale window from the build, never from
// this answer: no cache on the path can stretch the bound.
//
// THE REFRESH IS A GUEST'S OWN REQUEST, REPLAYED. It is dispatched through the
// whole Worker (`setEdgeRefreshDispatcher`, registered by worker/index.ts) as
// a cookie-less GET of the canonical URL with the visitor's Host, language and
// address, so it runs every middleware and the route exactly as a guest's miss
// would — never the finished request's own Hono context, whose response has
// already left (its headers would leak into the copy). One refresh per key per
// isolate at a time. A refresh answered 404/410 (the product was hidden) drops
// the copy; any other failure leaves it to age out. Without a dispatcher (a unit
// test of one router) nothing is served stale: a late copy is a miss, as before.

/** On a STORED copy only: when the data in it was read (ms since the epoch). Never sent to a client. */
export const STORED_AT_HEADER = 'X-Levonis-Stored-At';
/** On a purge marker: when the purge ran. */
const PURGED_AT_HEADER = 'X-Levonis-Purged-At';
/** The named cache the purge markers live in — never the answers' own. */
export const PURGE_MARKER_CACHE = 'levonis-edge-purges';
/** A marker outlives every copy it can retire (the longest stored lifetime is 300 + 600 s). */
const PURGE_MARKER_SECONDS = 3600;

export type EdgeFreshness = 'fresh' | 'refresh' | 'stale' | 'expired';

/** What a copy of this age may do under this lifetime (the ladder above). Pure. */
export function freshnessOf(ageMs: number, lifetime: EdgeLifetime): EdgeFreshness {
  const fresh = lifetime.sMaxAge * 1000;
  const age = Math.max(0, ageMs);
  if (age <= fresh / 2) return 'fresh';
  if (age <= fresh) return 'refresh';
  if (age <= fresh + Math.max(0, lifetime.staleWhileRevalidate) * 1000) return 'stale';
  return 'expired';
}

/** How long the Cache API must keep a copy: through its stale window, not one second more. */
export function storedCacheControl(lifetime: EdgeLifetime): string {
  return `public, max-age=${lifetime.maxAge}, s-maxage=${lifetime.sMaxAge + Math.max(0, lifetime.staleWhileRevalidate)}`;
}

/** `ctx` is the finished request's execution context (Hono's type and the runtime's differ; it is passed through untouched). */
type RefreshDispatcher = (request: Request, env: AppContext['Bindings'], ctx: unknown) => Response | Promise<Response>;
let refreshDispatcher: RefreshDispatcher | null = null;
/** The Worker's own `app.fetch` — the one way a background refresh runs (worker/index.ts). */
export function setEdgeRefreshDispatcher(dispatch: RefreshDispatcher | null): void {
  refreshDispatcher = dispatch;
}
/** The refresh requests this isolate made: they skip the lookup and store inline. Unforgeable from outside. */
const refreshRequests = new WeakSet<Request>();
/** One refresh per key per isolate at a time. */
const refreshing = new Map<string, Promise<void>>();

function executionCtxOf(c: Context<AppContext>): unknown {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/** The canonical URL a refresh asks for: the key without the cache epoch. */
function refreshUrlOf(key: Request): string {
  const url = new URL(key.url);
  url.searchParams.delete('__cv');
  return url.toString();
}

function scheduleRefresh(c: Context<AppContext>, cache: Cache, key: Request): boolean {
  const dispatch = refreshDispatcher;
  if (!dispatch) return false;
  if (refreshing.has(key.url)) return true;
  const headers = new Headers();
  for (const name of ['Host', 'Accept-Language', 'CF-Connecting-IP', 'X-Forwarded-Proto']) {
    const v = c.req.header(name);
    if (v) headers.set(name, v);
  }
  const request = new Request(refreshUrlOf(key), { method: 'GET', headers });
  refreshRequests.add(request);
  const work = (async () => {
    const res = await dispatch(request, c.env, executionCtxOf(c));
    // The answer is not read by anyone: release its body.
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404 || res.status === 410) await cache.delete(key).catch(() => false);
  })()
    .catch((e) => {
      console.error('edge refresh failed (the copy ages out within its window):', new URL(key.url).pathname, e instanceof Error ? e.message : e);
    })
    .finally(() => {
      refreshing.delete(key.url);
    });
  refreshing.set(key.url, work);
  void schedule(c, work);
  return true;
}

async function purgeMarkers(): Promise<Cache | null> {
  try {
    const open = (caches as unknown as { open?: (name: string) => Promise<Cache> }).open;
    return typeof open === 'function' ? await open.call(caches, PURGE_MARKER_CACHE) : null;
  } catch {
    return null;
  }
}

function purgeMarkerKey(host: string, path: string): Request {
  return canonicalKey(`https://${host}/__edge-purged${path.replace(/\/+$/, '') || '/'}`);
}

/** When this host's `path` was last purged in this colo (ms), or null. */
async function purgedAt(key: Request): Promise<number | null> {
  if (typeof caches === 'undefined') return null;
  const markers = await purgeMarkers();
  if (!markers) return null;
  const url = new URL(key.url);
  const hit = await markers.match(purgeMarkerKey(url.host, url.pathname)).catch(() => undefined);
  const at = Number(hit?.headers.get(PURGED_AT_HEADER));
  return Number.isFinite(at) && at > 0 ? at : null;
}

export interface EdgeServeOptions {
  /** The canonical key (`canonicalKey`). */
  key: Request;
  /** What decides fresh, stale and expired. */
  lifetime: EdgeLifetime;
  /** What every answer leaves with; `cacheControlFor(lifetime)` unless the route spells its own. */
  cacheControl?: string;
  /** `Vary: Cookie` on the answer (see `AnonymousCacheOptions.perViewer`). */
  perViewer?: boolean;
}

/**
 * The colo cache under one lifetime: a hit by the ladder above, else `build()`,
 * stored when it is a non-empty 200. The caller has already decided the answer
 * may be shared (`anonymousCached`: a guest; worker/routes/catalog.ts: the
 * viewer-independent tree, a guest's category page).
 */
export async function edgeServe(c: Context<AppContext>, opts: EdgeServeOptions, build: () => Promise<Response>): Promise<Response> {
  const { key, lifetime } = opts;
  const cacheControl = opts.cacheControl ?? cacheControlFor(lifetime);
  const ifNoneMatch = c.req.header('If-None-Match');
  const cache = edgeCache();
  const isRefresh = refreshRequests.has(c.req.raw);

  const stamp = (res: Response, ageMs: number | null): Response => {
    const out = conditional(res, ifNoneMatch, cacheControl);
    out.headers.delete(STORED_AT_HEADER);
    if (ageMs !== null) out.headers.set('Age', String(Math.floor(Math.max(0, ageMs) / 1000)));
    if (opts.perViewer) varyOnViewer(out.headers);
    return out;
  };

  if (cache && !isRefresh) {
    const [hit, purged] = await Promise.all([cache.match(key).catch(() => undefined), purgedAt(key).catch(() => null)]);
    if (hit?.headers.get(PROJECTION_HEADER) === PUBLIC_PROJECTION_REVISION) {
      const storedAt = Number(hit.headers.get(STORED_AT_HEADER));
      const known = Number.isFinite(storedAt) && storedAt > 0;
      // A copy stored before this release carries no time: the Cache API drops it at its old s-maxage.
      const age = known ? Date.now() - storedAt : null;
      const retired = purged !== null && (!known || storedAt <= purged);
      const state = age === null ? 'fresh' : freshnessOf(age, lifetime);
      if (!retired) {
        if (state === 'fresh') return stamp(hit, age);
        if (state === 'refresh') {
          scheduleRefresh(c, cache, key);
          return stamp(hit, age);
        }
        if (state === 'stale' && scheduleRefresh(c, cache, key)) return stamp(hit, age);
      }
    }
  }

  // The data is as old as the moment it was READ: a build that began before a
  // purge is retired by that purge's marker even if it is stored after it.
  const startedAt = Date.now();
  const built = await build();
  if (built.status !== 200) return built;

  const text = await built.text();
  if (text.length === 0) return new Response(text, { status: 200, headers: built.headers });
  const headers = new Headers(built.headers);
  headers.set('Cache-Control', cacheControl);
  headers.set(PROJECTION_HEADER, PUBLIC_PROJECTION_REVISION);
  headers.set('ETag', await weakEtag(text));
  if (opts.perViewer) varyOnViewer(headers);
  const res = new Response(text, { status: 200, headers });
  if (cache) {
    const stored = new Headers(headers);
    stored.set('Cache-Control', storedCacheControl(lifetime));
    stored.set(STORED_AT_HEADER, String(startedAt));
    const put = cache.put(key, new Response(text, { status: 200, headers: stored }));
    // A refresh already runs after the answer has left: store before it reports back.
    if (isRefresh) await put.catch(() => undefined);
    else await schedule(c, put);
  }
  return stamp(res, null);
}

/**
 * THE GUEST'S COPY OF `path` THIS COLO WOULD SERVE RIGHT NOW, as JSON — or
 * null: none, past its window, retired by a purge, of another projection, or
 * unreadable. Never builds and never refreshes. For a document that wants to
 * know what its page will read (worker/lib/productOpeningLead.ts): a copy
 * this function returns is exactly what a guest's request for `path` is
 * answered with.
 */
export async function peekAnonymousCopy(c: Context<AppContext>, path: string, lifetime: EdgeLifetime = ANONYMOUS_LIFETIME): Promise<unknown | null> {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const key = canonicalKey(new URL(path, c.req.url).toString(), [], c.req.header('Host'));
    const [hit, purged] = await Promise.all([cache.match(key), purgedAt(key)]);
    if (!hit || hit.headers.get(PROJECTION_HEADER) !== PUBLIC_PROJECTION_REVISION) return null;
    const storedAt = Number(hit.headers.get(STORED_AT_HEADER));
    if (!(Number.isFinite(storedAt) && storedAt > 0)) return null;
    const state = freshnessOf(Date.now() - storedAt, lifetime);
    // Exactly what `edgeServe` would do: a stale copy is served only where it can be refreshed.
    if ((purged !== null && storedAt <= purged) || state === 'expired' || (state === 'stale' && !refreshDispatcher)) {
      await hit.body?.cancel().catch(() => undefined);
      return null;
    }
    return await hit.json();
  } catch {
    return null;
  }
}

/**
 * Serve `build()`'s answer under the anonymous policy — from the colo's cache
 * when it holds it — or, for a request that carries a session, run `build()`
 * as it always ran and mark the answer private.
 */
export async function anonymousCached(
  c: Context<AppContext>,
  opts: AnonymousCacheOptions,
  build: () => Promise<Response>
): Promise<Response> {
  if (!isAnonymousGet(c)) {
    const own = await build();
    if (own.status === 200 && !own.headers.has('Cache-Control')) own.headers.set('Cache-Control', SESSION_CACHE_CONTROL);
    return own;
  }
  return edgeServe(
    c,
    {
      key: canonicalKey(c.req.url, opts.params ?? [], c.req.header('Host')),
      lifetime: opts.lifetime ?? ANONYMOUS_LIFETIME,
      perViewer: opts.perViewer,
    },
    build
  );
}

/**
 * Drop the canonical entries for these paths on this origin (per colo), and
 * retire every OTHER copy of them there too: a path with declared parameters
 * has one entry per parameter set (`/api/products?limit=50`, a listing, a
 * search), which a delete by name cannot reach, so a purge marker for the path
 * is written beside it and any copy read before the marker is a miss in this
 * colo from now on. Other colos keep their copies within their declared window.
 */
export async function purgeAnonymousCache(origin: string, paths: readonly string[]): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  const host = /^[a-z]+:\/\//i.test(origin) ? new URL(origin).host : origin;
  const markers = await purgeMarkers();
  const at = String(Date.now());
  await Promise.all(
    paths.map(async (p) => {
      const marked = markers
        ? markers
            .put(purgeMarkerKey(host.toLowerCase(), new URL(`https://x${p}`).pathname), new Response(null, {
              headers: { [PURGED_AT_HEADER]: at, 'Cache-Control': `public, max-age=${PURGE_MARKER_SECONDS}, s-maxage=${PURGE_MARKER_SECONDS}` },
            }))
            .catch((e) => {
              console.error('edge purge marker failed (parameterised copies age out within their window):', p, e instanceof Error ? e.message : e);
            })
        : undefined;
      await Promise.all([
        marked,
        cache.delete(canonicalKey(`https://${host}${p}`)).catch((e) => {
          console.error('edge purge failed (the entry expires within s-maxage):', p, e instanceof Error ? e.message : e);
        }),
      ]);
    })
  );
}

/** The request's own host — what an admin write purges by default. */
export function originOf(c: Context<AppContext>): string {
  return `https://${(c.req.header('Host') || new URL(c.req.url).host).trim().toLowerCase()}`;
}

/** The apex answers an admin write changes, by the settings key it wrote. */
export function pathsChangedBySetting(key: string): string[] {
  const out = new Set<string>(['/api/settings/public']);
  if (/^home|^mainPageMedia$|^siteMedia|^adVideoUrl$|^currency$|^exchangeRate$/.test(key)) {
    out.add('/api/home');
    out.add('/api/home/sections');
  }
  if (/^print(Accessories|Pricing|Materials)$/.test(key)) {
    out.add('/api/print-quote/accessories');
    out.add('/api/print-quote/materials');
    out.add('/api/marketplace/print/catalog');
  }
  if (/^proPricingPolicy$|^preorderTransportDefaults$|^proPause$/.test(key)) {
    out.add('/api/home');
    out.add('/api/home/sections');
    out.add('/api/products');
  }
  return [...out];
}

/** The community gate's one public answer. */
export const COMMUNITY_ACCESS_PATH = '/api/community/access';

/**
 * The storefront answers a publish, a profile edit, a catalogue edit, a
 * rename or a suspension changes, on the store's own host and on the apex:
 * the resolve (keyed by host), the store body by slug and by id, and every
 * parameter-less per-store read. The parameterised entries (`/products?…`,
 * `/reviews?…`) have one entry per parameter set and age out within
 * `s-maxage`; their parameter-less spelling is dropped here.
 */
export function storefrontPaths(slug: string, id?: string): string[] {
  const out = [
    '/api/storefront/resolve',
    `/api/storefront/${slug}`,
    `/api/storefront/${slug}/sections`,
    `/api/storefront/${slug}/services`,
    `/api/storefront/${slug}/showcase`,
    `/api/storefront/${slug}/products`,
    `/api/storefront/${slug}/reviews`,
  ];
  if (id) out.push(`/api/storefront/by-id/${id}`);
  return out;
}

/**
 * The store's DOCUMENTS, should the zone ever hold them: its home on its own
 * host and its page on the main site (worker/index.ts `assetWithPreview`
 * inlines the anonymous resolve into both). The Worker never `put`s a
 * document itself, so on a zone without the HTML Cache Rule these deletes
 * find nothing; with it, the writing colo drops its copy at once and every
 * other colo ages out within the document's `s-maxage` (60 s, no
 * stale-while-revalidate — worker/lib/socialPreview.ts). The product
 * documents (`/p/<slug>`) are not enumerated here; the deploy purge and the
 * 60 s bound cover them.
 */
export function storefrontDocumentPaths(slug: string, id?: string): string[] {
  const out = ['/', `/community/store/${slug}`];
  if (id) out.push(`/community/store/${id}`);
  return out;
}

/**
 * The apex answers a catalogue or pricing write changes: the first screen, the shelves, the listing, and the
 * product pages named — and, since a product with no price yet is SHOWN (DECISIONS row 240), the public API's
 * list and its pages named and the sitemap, so every price-state flip (a V2 write, FX-5, a completeness flip in
 * either direction) drops their copies too. Each product named also drops its knowledge answer (the Bambu
 * import spec §G.1: `/api/products/<slug>/knowledge`, five minutes at the edge), so a product write — its
 * specifications, its documents, its visibility — is never answered from an older copy in this colo.
 */
export function cataloguePaths(slugs: readonly string[] = []): string[] {
  const named = slugs.filter(Boolean);
  return [
    '/api/home',
    '/api/home/sections',
    '/api/home/graded',
    '/api/products',
    ...named.map((s) => `/api/products/${s}`),
    ...named.map((s) => `/api/products/${s}/knowledge`),
    '/api/public/v1/products',
    ...named.map((s) => `/api/public/v1/products/${encodeURIComponent(s)}`),
    '/sitemap.xml',
  ];
}

// ------------------------------------------------------------- the seams
//
// One call on each admin write that changes a cached answer, in the isolate
// and colo that took the write. Every seam is best effort: a failed purge is
// logged and the entry expires within `s-maxage` (the same contract as
// `purgeCatalogTreeCache`, worker/routes/catalog.ts).

/** PUT /api/admin/settings/:key — the public settings, the first screen, the shelves, the pricing inputs. */
export async function afterSettingsWrite(c: Context<AppContext>, key: string): Promise<void> {
  forgetPricingInputs(c.env.DB);
  await purgeAnonymousCache(originOf(c), pathsChangedBySetting(key));
}

/** PUT /api/admin/community/gate — the one answer every page asks first. */
export async function afterCommunityGateWrite(c: Context<AppContext>): Promise<void> {
  await purgeAnonymousCache(originOf(c), [COMMUNITY_ACCESS_PATH]);
}

/**
 * A store changed in a way its guests can see — a layout publish, a profile
 * or delivery edit, a service, a showcase item, a product, a review reply, a
 * rename, a suspension or its lifting: its shopfront on its own host
 * (`/resolve` is keyed by that origin), on the apex, where the merchant or
 * the admin may have sent the write from, and on the request's own host.
 * A rename calls this twice, once with each slug, so the OLD host's resolve
 * (which must now say STORE_MOVED, or STORE_UNAVAILABLE for a sanctioned
 * store) is dropped along with the new one's.
 */
export async function afterStorefrontWrite(c: Context<AppContext>, store: { slug: string; id: string }): Promise<void> {
  const root = rootDomainFrom(c.env);
  const origins = new Set<string>([originOf(c)]);
  const own = storeUrl(store.slug, root, store.id);
  if (/^https?:\/\//.test(own)) origins.add(new URL(own).origin);
  if (root) origins.add(`https://${root}`);
  const paths = [...storefrontPaths(store.slug, store.id), ...storefrontDocumentPaths(store.slug, store.id)];
  await Promise.all([...origins].map((o) => purgeAnonymousCache(o, paths)));
}

/**
 * Every merchant write, as ONE middleware on the merchant routers: after a
 * successful non-GET the store the caller owns (`requireStoreOwner` records
 * it on the context) has its cached shopfront dropped. Registered on the
 * router rather than called from each of the eighteen handlers, so a new
 * write cannot forget it. Best effort like every seam.
 */
export const purgeStorefrontAfterWrite: MiddlewareHandler<AppContext> = async (c, next) => {
  await next();
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return;
  if (c.res.status >= 300) return;
  const store = c.get('merchantStore');
  if (!store) return;
  await afterStorefrontWrite(c, store);
};

/**
 * A catalogue or pricing write on the apex — a product saved, hidden,
 * repriced or deleted (`/api/admin/products-v2`, the legacy
 * `/api/admin/products`), a membership benefit rule saved or deleted, the
 * PRO pause flipped: the guest listing, the product page named, and the two
 * home answers carry prices computed from these, and are dropped on the
 * request's host and on the root domain.
 */
export async function afterCatalogueWrite(c: Context<AppContext>, slugs: readonly string[] = []): Promise<void> {
  forgetPricingInputs(c.env.DB);
  const root = rootDomainFrom(c.env);
  const origins = new Set<string>([originOf(c)]);
  if (root) origins.add(`https://${root}`);
  const paths = cataloguePaths(slugs);
  await Promise.all([...origins].map((o) => purgeAnonymousCache(o, paths)));
}

/**
 * The catalogue seam as a router middleware (the admin product and benefit
 * routers): after a successful non-GET, purge. A handler that knows the
 * product's slug records it with `c.set('catalogueSlug', slug)` before
 * answering so the product page is dropped too; the listing and the home are
 * dropped regardless.
 */
export const purgeCatalogueAfterWrite: MiddlewareHandler<AppContext> = async (c, next) => {
  await next();
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return;
  if (c.res.status >= 300) return;
  // A V2 pricing preview (V2-3b) and an offer preview (docs/ux/PRODUCT-DISCOUNT.md §5.2) are POSTs
  // that write nothing: nothing to purge.
  const path = new URL(c.req.url).pathname;
  if (/\/pricing\/preview$/.test(path) || /^\/api\/admin\/offers\/[^/]+\/preview$/.test(path)) return;
  const slug = c.get('catalogueSlug') ?? (await catalogueSlugFromPath(c));
  await afterCatalogueWrite(c, slug ? [slug] : []);
};

/** `/api/admin/products-v2/<id>/…` names a product by id; its slug is one read away. Best effort. */
async function catalogueSlugFromPath(c: Context<AppContext>): Promise<string | null> {
  const id = /\/api\/admin\/products(?:-v2)?\/([^/?#]+)/.exec(new URL(c.req.url).pathname)?.[1];
  if (!id || ['brands', 'catalogs', 'maintenance', 'recommended', 'consolidation', 'simulate', 'versions'].includes(id)) return null;
  try {
    const row = await c.env.DB.prepare('SELECT slug FROM products WHERE id = ?').bind(decodeURIComponent(id)).first<{ slug: string }>();
    return row?.slug ?? null;
  } catch {
    return null;
  }
}

/**
 * THE SAME PURGE FROM A JOB, WITH NO REQUEST (FX programme plan §7.6, critique
 * L4): the FX scheduler runs on the cron and has no Hono `Context`. It drops
 * the root domain's and the `www.` host's entries, plus `origin` when a
 * request made the change (an owner's rate act).
 *
 *   settings  the public display rate moved: `/api/settings/public`, `/api/home`
 *             and `/api/home/sections` all carry it — the set
 *             `pathsChangedBySetting('exchangeRate')` purges today
 *   slugs     repriced products (FX-5): the catalogue paths and each product page
 *
 * When nothing changed, nothing is purged. Best effort, per colo, like every
 * seam: elsewhere the anonymous answers age out within `s-maxage`.
 */
export async function purgeCatalogueFromJob(
  env: AppContext['Bindings'],
  slugs: readonly string[],
  opts: { settings?: boolean; origin?: string } = {}
): Promise<void> {
  const paths = new Set<string>();
  if (opts.settings) for (const p of pathsChangedBySetting('exchangeRate')) paths.add(p);
  if (slugs.length) for (const p of cataloguePaths(slugs)) paths.add(p);
  if (paths.size === 0) return;
  forgetPricingInputs(env.DB);
  const origins = new Set<string>();
  const root = rootDomainFrom(env);
  if (root) {
    origins.add(`https://${root}`);
    origins.add(`https://www.${root}`);
  }
  if (opts.origin) origins.add(opts.origin);
  await Promise.all([...origins].map((o) => purgeAnonymousCache(o, [...paths])));
}

/** The print catalogue (materials, printers, accessories, the wizard's vocabulary). */
export const PRINT_CATALOGUE_PATHS: readonly string[] = [
  '/api/print-quote/printers',
  '/api/print-quote/materials',
  '/api/print-quote/accessories',
  '/api/marketplace/print/catalog',
];

export async function afterPrintCatalogueWrite(c: Context<AppContext>): Promise<void> {
  await purgeAnonymousCache(originOf(c), PRINT_CATALOGUE_PATHS);
}

/**
 * NO SHARED OR STORED COPY OF AN ADMIN OR CART ANSWER.
 *
 * Admin JSON (products, price grid, procurement, finance) and the cart carry
 * cost or a person's own selection, and went out with no Cache-Control at
 * all — so a proxy, a shared browser's disk cache or the back button could
 * keep one. A route that chose its own policy (a file download, an image)
 * keeps it; everything else is `private, no-store`. A response whose headers
 * cannot be changed (a pass-through body) is left as it is.
 */
export const noStoreUnlessSet: MiddlewareHandler<AppContext> = async (c, next) => {
  await next();
  if (c.res.headers.has('Cache-Control')) return;
  try {
    c.res.headers.set('Cache-Control', SESSION_CACHE_CONTROL);
  } catch {
    /* immutable headers: the route answered with a fetched Response */
  }
};
