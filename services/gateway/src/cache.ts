/**
 * The safe anonymous-GET cache (`01-TARGET.md` §3.7).
 *
 * THE ONLY WAY TO GET THIS WRONG IS TO SERVE ONE CUSTOMER'S BODY TO ANOTHER,
 * so every condition below is a refusal, not a hint, and `canCache()` is
 * written so that adding a path to the allowlist can never on its own make a
 * personalised response cacheable:
 *
 *   method GET, and only GET                — never a mutation, and never a
 *                                             HEAD: Hono answers a HEAD on a
 *                                             GET route with 200 and an EMPTY
 *                                             body, and the key has no method
 *                                             in it, so one anonymous HEAD
 *                                             would otherwise store an empty
 *                                             body under the GET's key and
 *                                             blank the route for the whole
 *                                             TTL
 *   no `levonis_session` cookie             — the presence of the cookie is
 *                                             enough; the gateway does not
 *                                             need to know whether it is valid
 *   no `Authorization` header
 *   the path is on the allowlist            — an explicit list of anonymous,
 *                                             catalogue-shaped reads
 *   the response is 200                     — `success:false` and every 5xx
 *   with no `Set-Cookie`, and a NON-EMPTY     are refused: a refusal is about
 *   body whose `success` is not `false`       the CALLER, never about the URL;
 *                                             an empty body is never a
 *                                             catalogue answer and is refused
 *                                             on its own
 *
 * THE KEY is `host + path + sorted query + lang`. The host is in the key
 * because the same path answers differently on a merchant storefront
 * (`/api/storefront/resolve`); the language is in the key because the same
 * product answers in ar, en or ckb; the query is sorted so `?a=1&b=2` and
 * `?b=2&a=1` are one entry rather than two.
 *
 * `s-maxage` LIVES ON THE CACHE ENTRY ONLY. The stored response carries it so
 * `caches.default` expires the entry; the response handed to the browser is
 * rewritten to `private, max-age=0`, so neither the browser nor any downstream
 * CDN ever holds a shared copy of a body this Worker decided to share.
 *
 * `caches.default` is inert on workers.dev, which is why the dark gateway
 * serves a real zone (`02-MIGRATION-PLAN.md` §13.2) and `gateway-parity.mjs`
 * marks `Age`/`cf-cache-status` assertions `zone-only`.
 */

export const SESSION_COOKIE = 'levonis_session';
export const CLIENT_CACHE_CONTROL = 'private, max-age=0';
export const CACHE_KEY_ORIGIN = 'https://gateway-cache.levonis.internal';

export type Lang = 'ar' | 'en' | 'ckb';
export const LANGS: readonly Lang[] = ['ar', 'en', 'ckb'];

export interface CacheRule {
  /** the whole path must match */
  pattern: RegExp;
  /** seconds, on the cache entry only */
  ttl: number;
  note?: string;
}

export const CACHE_ALLOWLIST: readonly CacheRule[] = [
  { pattern: /^\/api\/products$/, ttl: 60 },
  // A product page, but not its quote: `/api/products/:slug/quote` prices a
  // specific cart for a specific caller.
  { pattern: /^\/api\/products\/[^/]+$/, ttl: 60 },
  { pattern: /^\/api\/home$/, ttl: 60 },
  { pattern: /^\/api\/bundles$/, ttl: 30, note: 'members-only body; an anonymous call is success:false and is never stored' },
  { pattern: /^\/api\/settings\/public$/, ttl: 30 },
  { pattern: /^\/api\/storefront\/resolve$/, ttl: 30 },
  { pattern: /^\/api\/storefront\/[^/]+$/, ttl: 30 },
  { pattern: /^\/api\/storefront\/[^/]+\/products(\/.*)?$/, ttl: 30 },
  { pattern: /^\/api\/policies\/current$/, ttl: 60 },
  { pattern: /^\/api\/farm\/leaderboard$/, ttl: 30 },
  { pattern: /^\/api\/memberships\/plans$/, ttl: 60 },
  { pattern: /^\/files\/products\/.+$/, ttl: 300 },
  { pattern: /^\/files\/community\/.+$/, ttl: 300 },
  { pattern: /^\/files\/avatars\/.+$/, ttl: 300 },
];

/** True when the request carries the session cookie at all — valid or not. */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(';').some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
}

/** `?lang`, else the first `Accept-Language` primary tag we serve, else `en`. */
export function langOf(url: URL, headers: Headers): Lang {
  const q = (url.searchParams.get('lang') ?? '').trim().toLowerCase();
  if ((LANGS as readonly string[]).includes(q)) return q as Lang;
  for (const part of (headers.get('accept-language') ?? '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase().split('-')[0];
    if ((LANGS as readonly string[]).includes(tag)) return tag as Lang;
  }
  return 'en';
}

export interface CacheDecision {
  rule: CacheRule;
  key: string;
  lang: Lang;
}

/**
 * The request half of the decision. `enabled` is the `CACHE_MODE` var, so the
 * whole layer is one flip away from off in production without a deploy.
 */
export function canCache(req: { method: string; url: string; headers: Headers }, enabled: boolean, allowlist: readonly CacheRule[] = CACHE_ALLOWLIST): CacheDecision | null {
  if (!enabled) return null;
  // GET ONLY. A HEAD shares this key (the key has no method component) and
  // Hono answers it from the GET route with an empty body, so admitting HEAD
  // here is a one-request cache-poisoning primitive on every allowlisted path.
  if (req.method.toUpperCase() !== 'GET') return null;
  if (req.headers.get('authorization')) return null;
  if (hasSessionCookie(req.headers.get('cookie'))) return null;
  const url = new URL(req.url);
  const rule = allowlist.find((r) => r.pattern.test(url.pathname));
  if (!rule) return null;
  const lang = langOf(url, req.headers);
  return { rule, key: cacheKey(url, lang), lang };
}

/** `host + path + sorted query + lang`, as an absolute URL so it can key `caches.default`. */
export function cacheKey(url: URL, lang: Lang): string {
  const params = [...url.searchParams.entries()].filter(([k]) => k !== 'lang').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const host = url.hostname.toLowerCase();
  return `${CACHE_KEY_ORIGIN}/${lang}/${host}${url.pathname}${search ? `?${search}` : ''}`;
}

/**
 * The response half. A body is inspected only when it is JSON: `success:false`
 * is a refusal about the caller (an anonymous miss on a members-only bundle
 * list), and storing it would serve that refusal to everyone.
 */
export function canStore(res: { status: number; headers: Headers }, bodyText: string | null): boolean {
  if (res.status !== 200) return false;
  // An empty 200 is never a catalogue response. It is what a HEAD, a
  // truncated upstream or a stripped body looks like, and storing one blanks
  // the route for everyone until the entry expires.
  if (bodyText !== null && bodyText.length === 0) return false;
  if (res.headers.has('set-cookie')) return false;
  if (/no-store/.test(res.headers.get('cache-control') ?? '')) return false;
  const vary = (res.headers.get('vary') ?? '').toLowerCase();
  if (vary.includes('cookie') || vary === '*') return false;
  if (bodyText !== null && /"success"\s*:\s*false/.test(bodyText.slice(0, 4096))) return false;
  return true;
}

/** The headers the STORED entry carries (shared, short) … */
export function storedCacheControl(ttl: number): string {
  return `public, s-maxage=${ttl}`;
}

/** … and the header the CLIENT gets, so `s-maxage` never leaves this Worker. */
export function clientCacheControl(): string {
  return CLIENT_CACHE_CONTROL;
}
