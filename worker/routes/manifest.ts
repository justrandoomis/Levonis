import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { storeBySlug, storeIsSuspended, type StoreContext } from '../lib/merchantAuth';
import { getMediaObject } from '../lib/mediaStorage';
import {
  PLATFORM_ICON_FOR_ROLE,
  PLATFORM_ICON_REVISION,
  STORE_ICON_PATHS,
  readStoreIconsQuietly,
  scheduleStoreIconRefresh,
  servableStoreIcons,
  storeIconStatus,
  storeIconUrls,
  storeSurface,
  type StoreIconRole,
  type StoreIconSet,
} from '../lib/storeIcons';
import { buildWebManifest, type ManifestIdentity } from '../lib/webManifest';

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
  let identity: ManifestIdentity | null = null;

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
        const icons = await servableIconsFor(c, ctx);
        const surface = storeSurface(ctx.store);
        identity = {
          name: String(ctx.store.name ?? ''),
          tagline: String(ctx.store.tagline ?? ''),
          logoKey: ctx.store.logo_key ?? null,
          // The store's own PNGs when they exist for its CURRENT logo; the
          // builder falls back to the raw logo + platform icons otherwise.
          icons: icons ? storeIconUrls(icons) : null,
          backgroundColor: surface.background,
          themeColor: surface.theme,
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

// ---------------------------------------------------------------------------
//  THE STORE'S RENDITIONS, AND THE LAZY BACKFILL
// ---------------------------------------------------------------------------

/**
 * What this store may serve as its app icon right now — and, when that is not
 * yet its current logo's renditions, the refresh that makes them, AFTER the
 * response (worker/lib/storeIcons.ts). This is the backfill: an existing store
 * gets its icons from the first manifest or icon request after this ships,
 * with no job to run. The read is quiet — a database without migration 0123
 * reads as "no renditions", which is what this route served before.
 */
async function servableIconsFor(c: Context<AppContext>, ctx: StoreContext): Promise<StoreIconSet | null> {
  const row = await readStoreIconsQuietly(c.env.DB, ctx.store.id);
  const status = storeIconStatus(c.env, ctx.store, row);
  if (status.due) scheduleStoreIconRefresh(c, ctx.store);
  return servableStoreIcons(ctx.store, row);
}

/**
 * GET /store-icon/<name> — THE HOST'S OWN ICON AT A PATH THAT NEVER CHANGES.
 *
 * `index.html` is one document served byte-identically on the apex and on
 * every store's subdomain, so it cannot name a store's content-addressed
 * rendition key — yet it is what iOS reads at «إضافة إلى الشاشة الرئيسية»
 * (`apple-touch-icon`, which iOS prefers to anything in the manifest) and
 * what every browser reads for the tab icon. So the document names these
 * stable paths, and the Worker answers each per Host:
 *
 *   a store's host   the store's rendition for its CURRENT logo;
 *   everywhere else  the platform's own PNG for the same role — the apex, a
 *                    system host, an unknown store, a suspended store (whose
 *                    customer sees only «المتجر غير متاح حاليًا»), and a store
 *                    whose renditions are not cut yet (which this request
 *                    then schedules).
 *
 * Never the SPA shell and never a 500: an unknown name is a bare 404, and any
 * failure on the store's side falls back to the platform icon — a real icon
 * beats a missing one, and iOS, given nothing it can decode, uses a
 * SCREENSHOT OF THE PAGE instead.
 *
 * REVALIDATING, NOT IMMUTABLE. The bytes behind one of these URLs change the
 * moment a merchant replaces their logo, so the answer is cached for five
 * minutes (the manifest's own figure — `MANIFEST_CACHE_SECONDS`) and then
 * revalidated; the ETag names the rendition revision, so a revalidation that
 * finds nothing new is a 304 and one D1 read, never a body. No `Vary: Host`,
 * for the reason the manifest gives: the host is in the URL.
 */
export const STORE_ICON_CACHE_CONTROL = `public, max-age=${MANIFEST_CACHE_SECONDS}, must-revalidate`;

/** An image needs no policy of its own beyond "run nothing". */
const ICON_CSP = "default-src 'none'; sandbox";

export async function storeIconRoute(c: Context<AppContext>): Promise<Response> {
  const name = c.req.param('name') ?? '';
  const role: StoreIconRole | undefined = Object.prototype.hasOwnProperty.call(STORE_ICON_PATHS, name)
    ? STORE_ICON_PATHS[name]
    : undefined;
  if (!role) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': ICON_CSP } });
  }

  const host = c.get('host');
  if (host.kind === 'merchant' && host.slug) {
    try {
      const ctx = await storeBySlug(c.env.DB, host.slug);
      if (ctx && !storeIsSuspended(ctx)) {
        const icons = await servableIconsFor(c, ctx);
        if (icons) {
          const served = await serveRendition(c, icons, role);
          if (served) return served;
        }
      }
    } catch {
      // The store could not be read: the platform icon below is the answer.
    }
  }
  return servePlatformIcon(c, role);
}

function iconHeaders(etag: string): Headers {
  return new Headers({
    'Content-Type': 'image/png',
    'Cache-Control': STORE_ICON_CACHE_CONTROL,
    ETag: etag,
    'Content-Security-Policy': ICON_CSP,
  });
}

/** The store's rendition from R2, or null to fall back (the object is missing). */
async function serveRendition(c: Context<AppContext>, icons: StoreIconSet, role: StoreIconRole): Promise<Response | null> {
  const etag = `"${icons.rev}-${role}"`;
  if (c.req.header('If-None-Match') === etag) return new Response(null, { status: 304, headers: iconHeaders(etag) });
  const object = await getMediaObject(c.env, 'public', icons.keys[role]);
  if (!object) return null;
  return new Response(object.body, { status: 200, headers: iconHeaders(etag) });
}

/**
 * The platform's PNG for this role, read through the asset binding — the same
 * committed file `/icons/*` serves, so there is one copy of every platform
 * icon, not two. A 404 (never the SPA shell) if the asset layer cannot supply
 * an image.
 */
async function servePlatformIcon(c: Context<AppContext>, role: StoreIconRole): Promise<Response> {
  const etag = `"platform-${PLATFORM_ICON_REVISION}-${role}"`;
  if (c.req.header('If-None-Match') === etag) return new Response(null, { status: 304, headers: iconHeaders(etag) });
  try {
    const asset = await c.env.ASSETS.fetch(new Request(new URL(PLATFORM_ICON_FOR_ROLE[role], c.req.url).toString()));
    const type = (asset.headers.get('Content-Type') || '').toLowerCase();
    if (asset.ok && type.startsWith('image/png')) {
      return new Response(asset.body, { status: 200, headers: iconHeaders(etag) });
    }
    await asset.body?.cancel().catch(() => undefined);
  } catch {
    // No asset binding (a unit test, a misconfigured preview).
  }
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': ICON_CSP } });
}
