/**
 * WHAT A SEARCH ENGINE IS TOLD ABOUT THIS SHOP.
 *
 * TWO FILES EVERY CRAWLER ASKS FOR, AND THIS SITE HAD NEITHER. PageSpeed's SEO
 * section reports a missing `robots.txt`; Google Search Console reports a
 * missing sitemap by never finding one. Until now `/robots.txt` and
 * `/sitemap.xml` both fell through to the SPA shell, so a crawler asking for
 * robots got an HTML document with a 200 — which several crawlers read as
 * "everything is allowed" and some read as a malformed file.
 *
 * WHY THEY ARE WORKER ROUTES AND NOT FILES IN `public/`. The same built bundle
 * is served on the apex AND on every merchant subdomain. A static
 * `public/robots.txt` would name the PLATFORM's sitemap on `ali3d.levonis-iq
 * .com`, pointing Google at a list of URLs that do not belong to that shop;
 * a static `sitemap.xml` would advertise the whole catalogue as if it were
 * every merchant's. The Host header is what tells them apart and the Host
 * header only reaches the Worker. `worker/routes/manifest.ts` solved exactly
 * this problem for the web manifest, and this follows it deliberately — same
 * reasoning, same failure posture, same per-host shape.
 *
 * THE FAILURE MODE IS A VALID FILE, NEVER A 500. A crawler that gets a 5xx for
 * robots.txt is specified to treat the whole site as disallowed and stop —
 * Google backs off for up to 30 days. So a D1 outage, a missing binding or an
 * unknown host all end at a valid, conservative document with a 200. The same
 * argument the manifest route makes about installability, with a sharper edge:
 * getting this wrong de-indexes the shop.
 */
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';


/**
 * ONE HOUR.
 *
 * robots.txt changes when the shape of the site changes, which is rarely, and
 * a crawler re-reads it on its own schedule anyway (Google caches it for about
 * a day regardless of what we say). An hour is short enough that a correction
 * reaches the next crawl of the day and long enough that the Worker is not
 * invoked for every bot on the internet.
 */
export const ROBOTS_CACHE_SECONDS = 3600;

/**
 * FIFTEEN MINUTES for the sitemap, because it names REAL PRODUCTS and the
 * catalogue moves. A product published this morning that a crawler cannot see
 * until tomorrow is a day of the shop's own work sitting unindexed.
 */
export const SITEMAP_CACHE_SECONDS = 900;

/** The most URLs one sitemap document will carry. */
const MAX_SITEMAP_URLS = 2000;

/**
 * THE PATHS NO CRAWLER SHOULD SPEND ITS BUDGET ON, and which must never appear
 * in a search result.
 *
 * `Disallow` is not a security control and is not being used as one — every
 * path below is already refused to a stranger by the Worker's own auth. What
 * it prevents is a crawler burning this site's crawl budget on hundreds of
 * pages that answer 401, and a signed-in-only screen surfacing as a dead
 * result. The admin surface is listed FIRST because it is the one a search
 * result would be most embarrassing for.
 */
const DISALLOWED: readonly string[] = [
  '/api/',
  '/admin',
  '/merchant',
  '/checkout',
  '/cart',
  '/wallet',
  '/settings',
  '/profile',
  '/orders',
  '/auth',
];

/**
 * The public, indexable surfaces of the storefront. Only paths a signed-out
 * visitor can actually read — a sitemap that lists a page requiring a session
 * teaches the crawler to distrust the rest of it.
 */
const STATIC_PATHS: readonly string[] = [
  '/',
  '/products',
  '/bundles',
  '/compare',
  '/tools',
  '/used-printers',
  '/warranty',
  '/community',
  '/support',
  '/points',
];

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The origin to write absolute URLs against — AND IT IS NOT `trustedOrigin`.
 *
 * `worker/lib/appOrigin.ts` deliberately answers the APEX for a merchant host
 * whenever `APP_ORIGIN` is configured, because its job is where a token-bearing
 * link must leave through. That rule is exactly wrong here: a sitemap served at
 * `https://ali3d.levonis-iq.com/sitemap.xml` that lists `https://levonis-iq.com`
 * URLs is a CROSS-SITE sitemap, and Google ignores every entry in one. The
 * sitemap protocol requires each `<loc>` to share the host the file was fetched
 * from.
 *
 * So a merchant names ITSELF, from the request.
 *
 * The apex still prefers `APP_ORIGIN`, because `classifyHost` calls both
 * `levonis-iq.com` and `www.levonis-iq.com` `main`: listing the `www` variant
 * would advertise a second copy of every URL and split the shop's ranking
 * between two hostnames.
 */
function originOf(c: Context<AppContext>): string {
  const host = c.get('host');
  try {
    if (host.kind === 'merchant') return new URL(c.req.url).origin;
    const configured = (c.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
    return configured || new URL(c.req.url).origin;
  } catch {
    return '';
  }
}

export function robotsRoute(c: Context<AppContext>): Response {
  const host = c.get('host');
  const origin = originOf(c);
  const lines: string[] = ['User-agent: *'];

  /**
   * A NON-STOREFRONT HOST IS NOT INDEXED AT ALL.
   *
   * `system` is studio.levonis-iq.com and its siblings — an application, not a
   * shop, with no pages worth a search result. `foreign` is a workers.dev URL,
   * a preview deployment or a spoofed Host; indexing any of those would put a
   * DUPLICATE of the whole shop in Google under a hostname the owner does not
   * control, which is the classic way a staging URL outranks the real site.
   */
  if (host.kind !== 'main' && host.kind !== 'merchant') {
    lines.push('Disallow: /');
    return new Response(`${lines.join('\n')}\n`, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': `public, max-age=${ROBOTS_CACHE_SECONDS}`,
      },
    });
  }

  for (const path of DISALLOWED) lines.push(`Disallow: ${path}`);
  // Crawl-delay is deliberately absent: Google ignores it, and the shops that
  // honour it are the ones whose traffic this site wants.
  if (origin) {
    lines.push('');
    lines.push(`Sitemap: ${origin}/sitemap.xml`);
  }
  return new Response(`${lines.join('\n')}\n`, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': `public, max-age=${ROBOTS_CACHE_SECONDS}`,
    },
  });
}

interface SitemapRow {
  slug: string;
  updated_at: string | null;
}

/**
 * `<lastmod>` only when the row actually carries a date a crawler can parse.
 * An invented or malformed one is worse than none: Google warns on it and, on
 * repeat, stops trusting the lastmod of the whole file — which is the signal
 * that makes a sitemap worth serving in the first place.
 */
function lastmodOf(raw: string | null): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export async function sitemapRoute(c: Context<AppContext>): Promise<Response> {
  const host = c.get('host');
  const origin = originOf(c);
  const urls: { loc: string; lastmod: string; priority: string }[] = [];

  const answer = () => {
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls
        .map(
          (u) =>
            `  <url><loc>${xmlEscape(u.loc)}</loc>` +
            (u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : '') +
            `<priority>${u.priority}</priority></url>`
        )
        .join('\n') +
      `\n</urlset>\n`;
    return new Response(body, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': `public, max-age=${SITEMAP_CACHE_SECONDS}`,
      },
    });
  };

  // Same rule as robots: a host that is not a storefront advertises nothing.
  // An EMPTY urlset, not a 404 — a 404 here is a Search Console error the
  // owner would have to go and dismiss, for a host that was never meant to be
  // listed.
  if (!origin || (host.kind !== 'main' && host.kind !== 'merchant')) return answer();

  for (const path of STATIC_PATHS) {
    urls.push({ loc: `${origin}${path}`, lastmod: '', priority: path === '/' ? '1.0' : '0.7' });
  }

  /**
   * THE CATALOGUE. Active, non-composition products, newest first, capped.
   *
   * Contained on purpose: a sitemap that 500s is a Search Console error, and a
   * sitemap missing its products is still a valid sitemap that lists the
   * shop's main pages. So a D1 failure degrades to the static list above
   * rather than taking the document down.
   */
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT slug, updated_at FROM products
        WHERE status = 'active' AND slug <> ''
        ORDER BY updated_at DESC
        LIMIT ${MAX_SITEMAP_URLS}`
    ).all<SitemapRow>();
    for (const row of results ?? []) {
      const slug = String(row.slug ?? '').trim();
      if (!slug) continue;
      urls.push({
        loc: `${origin}/product/${encodeURIComponent(slug)}`,
        lastmod: lastmodOf(row.updated_at),
        priority: '0.8',
      });
    }
  } catch (e) {
    console.error('sitemap: product read failed', e instanceof Error ? e.message : e);
  }

  return answer();
}
