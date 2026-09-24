import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { storeBySlug, storeIsSuspended } from '../lib/merchantAuth';
import { buildWebManifest } from '../lib/webManifest';

/**
 * GET /manifest.webmanifest — the document that decides what installing this
 * site puts on a customer's home screen.
 *
 * ONE URL, MANY IDENTITIES. The same built bundle is served from the apex and
 * from every merchant subdomain, so the manifest cannot be a file: a static
 * `public/manifest.webmanifest` would install `ali3d.levonis-iq.com` as
 * "LEVONIS", with the platform's mark, on the phone of a customer who believes
 * they are installing that shop. The Host header is what distinguishes them,
 * and the Host header only reaches the Worker — hence a route.
 *
 * THIS ROUTE HAS EXACTLY ONE CORRECT FAILURE MODE, AND IT IS NOT A 500.
 * A manifest that errors, or that answers with anything a browser cannot
 * parse, makes the whole site "not installable" — with no message the owner
 * will ever see and nothing a customer can report beyond "the button is gone".
 * So every path below that could fail ends at the platform manifest with a
 * 200: an unknown subdomain, a store row that is not there, a D1 outage, a
 * binding that is missing in a preview deployment. The platform's own identity
 * is always a truthful answer for a host on this platform; a 500 never is.
 */

/**
 * FIVE MINUTES, PUBLIC.
 *
 * The two forces are a merchant renaming their shop and a browser re-reading
 * this file. Merchants rename rarely but expect to SEE it — «غيّرت الاسم وما
 * تغيّر» is the support message this number exists to prevent, and five
 * minutes is short enough that a merchant checking their own work does not
 * write it. In the other direction, an installed application re-reads its
 * manifest on its own schedule, measured in days, so a longer cache buys
 * almost nothing: the requests this actually spares are the ones from every
 * page load of every browser that follows the `<link rel="manifest">`.
 *
 * `public`, not `private`: there is nothing per-visitor in this response. Two
 * customers on the same host get identical bytes, so a shared cache in front
 * of the Worker is free to serve both.
 */
export const MANIFEST_CACHE_SECONDS = 300;

export const MANIFEST_CONTENT_TYPE = 'application/manifest+json; charset=utf-8';

export async function webManifestRoute(c: Context<AppContext>): Promise<Response> {
  const host = c.get('host');
  let identity = null as { name: string; tagline: string; logoKey: string | null } | null;

  // `main`, `system` and `foreign` are the platform, and they are answered
  // without touching D1 at all. That is most of this route's traffic — the
  // apex, studio, a preview URL, a spoofed Host — and none of it has a store
  // to look up, so none of it should pay for a query.
  if (host.kind === 'merchant' && host.slug) {
    try {
      const ctx = await storeBySlug(c.env.DB, host.slug);
      // An ADMIN-SUSPENDED store (or a store whose merchant is suspended)
      // falls back to the platform identity — see the note below.
      if (ctx && !storeIsSuspended(ctx)) {
        identity = {
          name: String(ctx.store.name ?? ''),
          tagline: String(ctx.store.tagline ?? ''),
          logoKey: ctx.store.logo_key ?? null,
        };
      }
      // `ctx === null` is a subdomain with no store behind it — a typo, a
      // deleted shop, a slug someone guessed. The SPA renders its own
      // "unknown store" screen there, and the platform identity is the honest
      // manifest to pair with it.
    } catch {
      // D1 unavailable, mid-migration, or the binding absent in a preview
      // deployment. A store that cannot be read is not a reason to make the
      // platform uninstallable — see the note at the top of this file.
      identity = null;
    }
  }

  /**
   * A PAUSED STORE KEEPS ITS OWN NAME; A SUSPENDED ONE DOES NOT.
   *
   * `paused` is the merchant closing for the afternoon: the storefront still
   * renders under the shop's own brand and says it is closed, so relabelling
   * an installed app over it would be wrong.
   *
   * An ADMIN suspension is different by the owner's decision (2026-09-24,
   * docs/MERCHANT_PLATFORM.md §2): the customer sees only «المتجر غير متاح
   * حاليًا» and none of the shop's content — and a store name or logo can be
   * the very thing it was suspended for (an impersonating name, a bad logo).
   * So a suspended store, or a store whose merchant is suspended, installs as
   * the platform, exactly like any other host with no servable store behind it.
   */
  const manifest = buildWebManifest(identity);

  return c.body(JSON.stringify(manifest), 200, {
    /**
     * EXACTLY THIS TYPE. `securityHeaders()` puts `X-Content-Type-Options:
     * nosniff` on every response this Worker makes, so there is no sniffing to
     * fall back on: a manifest served as `application/json` or — the failure
     * this route exists to end — as `text/html` from the SPA asset fallback is
     * refused outright, and the browser reports only "Manifest: Line 1,
     * column 1, Syntax error" to a console nobody is watching.
     */
    'Content-Type': MANIFEST_CONTENT_TYPE,
    'Cache-Control': `public, max-age=${MANIFEST_CACHE_SECONDS}`,
    /**
     * NO `Vary: Host`, DELIBERATELY, SO NOBODY ADDS ONE LATER.
     *
     * This response does vary by host — that is the entire point of the route.
     * But the host is part of the URL's authority, not a request header that
     * modulates one URL: `https://a.levonis-iq.com/manifest.webmanifest` and
     * `https://levonis-iq.com/manifest.webmanifest` are two different URLs and
     * every HTTP cache already keys them apart. `Vary: Host` states nothing a
     * cache did not know and, in caches that treat an unfamiliar `Vary` name
     * conservatively, only costs hit rate.
     */
  });
}
