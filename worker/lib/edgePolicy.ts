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
 * hundredth. Every answer, hit or miss, 200 or 304, leaves with THIS header:
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
 * (`resetCommunityAccessCache`'s pattern); other colos age out within
 * `s-maxage`. The seams are on the writes that exist: the settings PUT and
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
  return `public, max-age=${lifetime.maxAge}, s-maxage=${lifetime.sMaxAge}, stale-while-revalidate=${lifetime.staleWhileRevalidate}`;
}

/** The header the anonymous routes emit by default — spelled once, pinned by the tests. */
export const ANONYMOUS_CACHE_CONTROL = cacheControlFor(ANONYMOUS_LIFETIME);

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
  return new Request(`https://${hostname}${path}${search ? `?${search}` : ''}`, { method: 'GET' });
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
  const cacheControl = cacheControlFor(opts.lifetime ?? ANONYMOUS_LIFETIME);
  const ifNoneMatch = c.req.header('If-None-Match');
  const cache = edgeCache();
  const key = canonicalKey(c.req.url, opts.params ?? [], c.req.header('Host'));

  const stamp = (res: Response): Response => {
    const out = conditional(res, ifNoneMatch, cacheControl);
    if (opts.perViewer) varyOnViewer(out.headers);
    return out;
  };

  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) return stamp(hit);
  }

  const built = await build();
  if (built.status !== 200) return built;

  const text = await built.text();
  if (text.length === 0) return new Response(text, { status: 200, headers: built.headers });
  const headers = new Headers(built.headers);
  headers.set('Cache-Control', cacheControl);
  headers.set('ETag', await weakEtag(text));
  if (opts.perViewer) varyOnViewer(headers);
  const res = new Response(text, { status: 200, headers });
  if (cache) await schedule(c, cache.put(key, res.clone()));
  return stamp(res);
}

/**
 * Drop the canonical entries for these paths on this origin (per colo). Paths
 * with declared parameters have one entry per parameter set and age out on
 * their own within `s-maxage`; the seams purge the parameter-less answers.
 */
export async function purgeAnonymousCache(origin: string, paths: readonly string[]): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  const host = /^[a-z]+:\/\//i.test(origin) ? new URL(origin).host : origin;
  await Promise.all(
    paths.map((p) =>
      cache.delete(canonicalKey(`https://${host}${p}`)).catch((e) => {
        console.error('edge purge failed (the entry expires within s-maxage):', p, e instanceof Error ? e.message : e);
      })
    )
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

/** The apex answers a catalogue or pricing write changes: the first screen, the shelves, the listing, and the product pages named. */
export function cataloguePaths(slugs: readonly string[] = []): string[] {
  return ['/api/home', '/api/home/sections', '/api/products', ...slugs.filter(Boolean).map((s) => `/api/products/${s}`)];
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
