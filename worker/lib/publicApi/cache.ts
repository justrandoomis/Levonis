/**
 * EDGE CACHING AND CONDITIONAL REQUESTS FOR THE PUBLIC API.
 *
 * Every public answer is the same for everyone — the API never reads a
 * session — so it is stored in the colo's cache under its CANONICAL URL: the
 * site's origin, the path, and only the query parameters the endpoint
 * declares, sorted. An unknown parameter cannot mint a new cache entry, and
 * `?a=1&b=2` and `?b=2&a=1` are one entry.
 *
 * A weak ETag (a hash of the body) lets a client revalidate with
 * `If-None-Match` and get a bodiless 304.
 *
 * THE ROUTE'S OWN LIFETIME, ON A HIT TOO. Cloudflare hands a cached answer
 * back with its `max-age` raised to the zone's Browser Cache TTL — four hours
 * on levonis-iq.com (seen live: `public, max-age=14400, s-maxage=120` on a
 * hit, `max-age=60` on the miss that stored it). A client would then keep a
 * price for hours. So every answer, hit or miss, 200 or 304, leaves with the
 * route's own `Cache-Control`.
 *
 * `caches` does not exist under Node, where the tests run; the same code then
 * simply builds every answer (the pattern of worker/routes/catalog.ts).
 */

/**
 * THE CATALOGUE CACHE EPOCH (the clean start, DECISIONS row 222; spec addendum A.4.5).
 *
 * Every catalogue answer cached at the edge (the anonymous storefront routes,
 * the catalogue tree and pages, search, the public API) is keyed with this
 * epoch. Purges are per colo and an anonymous answer lives up to s-maxage +
 * stale-while-revalidate; a new epoch makes every entry stored before the
 * release miss in every colo at once — so no page priced in the old dinars is
 * served after the deploy (they age out unseen). Change it only for a release
 * that must drop every cached catalogue answer.
 *
 * 2026-10-15 (DECISIONS row 240): catalog-only products appear (an answer cached
 * before would hide them, or 404 their page), and every card carries `price_status`.
 *
 * 2026-10-18 (DECISIONS row 259, Community V3 push 1.4): the merchant approval
 * gate is enforced. Every store page, directory, feed, search and share answer
 * cached before the deploy still showed merchants no reviewer approved; under
 * the new epoch every colo misses at once and answers through the public
 * predicate (owner decisions C1/C2/C9).
 *
 * 2026-10-26 (DECISIONS row 268, owner decision Q2, build item B0): a print
 * request budget is private by default. Every public API request answer and
 * search answer cached before the deploy still carried `budget_iqd`; under
 * the new epoch every colo misses at once and answers through `publicRequest`
 * and the public API whitelist, whose `budget_iqd` is always null.
 */
export const CATALOG_CACHE_EPOCH = 'budget-privacy-2026-10-26';

/** A cache key URL carrying the epoch (appended last, so the declared params keep their order). */
export function withCacheEpoch(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}__cv=${CATALOG_CACHE_EPOCH}`;
}

export function edgeCache(): Cache | null {
  return typeof caches !== 'undefined' ? ((caches as unknown as { default?: Cache }).default ?? null) : null;
}

export async function weakEtag(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `W/"${hex.slice(0, 32)}"`;
}

/** Does `If-None-Match` name this ETag? (Weak comparison; `*` matches.) */
export function etagMatches(ifNoneMatch: string | undefined, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  const want = bare(etag);
  return ifNoneMatch.split(',').some((t) => t.trim() === '*' || bare(t) === want);
}

/**
 * The answer to send: a fresh, mutable copy, or a 304 when the client already
 * has it — either way carrying `cacheControl`, the route's own policy.
 */
export function conditional(res: Response, ifNoneMatch: string | undefined, cacheControl: string): Response {
  const etag = res.headers.get('ETag');
  if (etagMatches(ifNoneMatch, etag)) {
    const headers = new Headers();
    for (const h of ['ETag', 'Content-Type']) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('Cache-Control', cacheControl);
    return new Response(null, { status: 304, headers });
  }
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', cacheControl);
  return new Response(res.body, { status: res.status, headers });
}
