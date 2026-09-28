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
