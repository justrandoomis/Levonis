/**
 * THE SHOP'S OWN MARK, AND WHY REPLACING IT IN R2 CHANGED NOTHING.
 *
 * The owner uploaded a new `UiUx/Logo/Logo.webp` over the live object and the
 * site kept showing the old mark — on the browser tab, on the iPad home
 * screen, inside the installed Android app. The upload was fine. The logo
 * simply resolved along THREE INDEPENDENT PATHS, and only one of them ever
 * asked R2 anything:
 *
 *   1. THE R2 OBJECT, at `SITE_LOGO_KEY` below, served by the Worker's
 *      `/files/*` route. The brand folder is the one prefix this application
 *      does NOT mint per upload: `isRewritableMediaKey`
 *      (worker/lib/mediaStorage.ts) exists to recognise it and hand it a
 *      short, revalidating `Cache-Control` instead of the year of `immutable`
 *      every minted key gets, precisely because a human replaces these bytes
 *      under a name that must keep working. This is the ONLY path a
 *      replacement in the bucket can reach, and it reaches exactly two things:
 *      the WebP tab icon and the share card's image.
 *
 *   2. THE PNG FORK under `public/icons/` — seven binaries COMMITTED TO THIS
 *      REPOSITORY, produced from path 1 by hand with
 *      `scripts/build-pwa-icons.mjs` (its own header says why it is not part
 *      of `npm run build`). index.html's `apple-touch-icon` and its two PNG
 *      favicons, the manifest's `icons` array (worker/lib/webManifest.ts) and
 *      the service worker's precache list all read those files, and those
 *      files are what an iPad home screen and an installed Android app
 *      actually draw. No upload to R2 changes one byte of them. They change
 *      when somebody runs the script and commits the output. Treat them as a
 *      FORK awaiting a manual merge, never as a cache that will catch up.
 *
 *      AND A MERGE UNDER THE SAME NAMES WOULD NOT HAVE REACHED ANYONE
 *      EITHER. `/icons/*` is served for a week, answered from Cloudflare's
 *      edge cache (`cf-cache-status: HIT`, observed live) and precached by
 *      the service worker, so new pixels behind `icon-192.png` stay invisible
 *      behind three caches. The names therefore carry
 *      `PLATFORM_ICON_REVISION` — the first eight hex digits of the SHA-256
 *      of the logo bytes the icons were cut from — and the generator refuses
 *      to write new pixels under an old revision. A new mark is a new URL
 *      that no cache has ever seen.
 *
 *   3. THE LOOSE STRINGS. The key was written out again in the icon link, in
 *      `og:image`, in `twitter:image` and in a component's fallback — four
 *      copies with nothing holding them together. A rename that missed one
 *      would not even 404: `not_found_handling: "single-page-application"`
 *      answers a missing asset with the SPA shell at HTTP 200, so the browser
 *      is handed HTML where it asked for an image and draws a blank square.
 *
 * THIS MODULE IS PATH 3'S REPLACEMENT — one place where the mark is named.
 * index.html cannot import it: the shell is parsed before any module runs, and
 * there is no templating step over it. So the constants are mirrored there
 * once, and `tests/siteMedia.test.ts` holds the shell, the generator script
 * and the manifest's icon list to these values — a check at test time standing
 * in for an import at run time. If you change a name here, that test tells you
 * every other place that has to move.
 *
 * WHAT THIS MODULE DOES NOT FIX, stated so nobody reads it as a cure: it does
 * not regenerate path 2, and it cannot. While the PNGs are stale the owner's
 * new mark is invisible on precisely the two devices they were looking at.
 * And an iPhone or iPad that ALREADY added the shop to its home screen keeps
 * the icon it saved that day — iOS never refetches it; only removing the
 * shortcut and adding it again picks up a new mark. Android refreshes an
 * installed app's icon by itself once the manifest's icon bytes change.
 */

/** The object in the public bucket. Replaced in place, deliberately. */
export const SITE_LOGO_KEY = 'UiUx/Logo/Logo.webp';

/**
 * The canonical origin. Only share metadata needs it — every crawler requires
 * an ABSOLUTE `og:image` and several silently drop a relative one — and
 * nothing that renders in the page should use it, because one document is
 * served on the apex and on every merchant subdomain.
 */
export const SITE_ORIGIN = 'https://levonis-iq.com';

/** What the browser asks for: the Worker's R2 route, relative, same-origin. */
export const SITE_LOGO_URL = `/files/${SITE_LOGO_KEY}`;

/**
 * THE LOGO THE FORK WAS CUT FROM: the first eight hex digits of the SHA-256 of
 * `SITE_LOGO_KEY`'s bytes when `scripts/build-pwa-icons.mjs` last ran. Every
 * name below carries it, and the generator reads it from HERE and stops when
 * the logo in R2 no longer hashes to it — the moment to rename, not to
 * overwrite. `bc80fc2b` is the mark the owner uploaded in September 2026
 * (1254×1254 WebP, 51,518 bytes, R2 etag 6b711a1efa320b9f0359d7f030aa1e4e).
 */
export const PLATFORM_ICON_REVISION = 'bc80fc2b';

/**
 * THE SAME OBJECT, UNDER A URL THAT CHANGES WITH IT — what index.html's WebP
 * tab icon, `og:image` and `twitter:image` name.
 *
 * The Worker reads the key from the PATH (`/files/*` in
 * worker/routes/uploads.ts), so the query changes nothing it serves; what it
 * changes is every cache that is keyed on the URL and never asks R2 at all:
 * the browser's own favicon store, and the link-preview caches of Telegram
 * and WhatsApp, which keep an `og:image` for as long as its URL stays the
 * same. Unversioned, those went on showing the previous mark no matter how
 * short the `/files/` Cache-Control was. Bumped together with the icon names.
 */
export const SITE_LOGO_VERSIONED_URL = `${SITE_LOGO_URL}?v=${PLATFORM_ICON_REVISION}`;

/** What a crawler is handed. Must be byte-identical to index.html's og:image. */
export const SITE_LOGO_SHARE_URL = `${SITE_ORIGIN}${SITE_LOGO_VERSIONED_URL}`;

/**
 * THE FORK. Every generated PNG, by the name `scripts/build-pwa-icons.mjs`
 * writes it under `public/icons/` — which reads the names from this object.
 *
 * `public/` is copied byte-for-byte into `dist/` by Vite and `/icons/*` is not
 * in `run_worker_first`, so these are answered by the asset layer with the
 * Worker uninvolved — which is why an icon the browser needs before anything
 * renders points here rather than at a database-backed route.
 *
 * worker/lib/webManifest.ts keeps its own copy of these paths on purpose (that
 * module states a no-imports property, and the Worker cannot import from
 * `src/` in any case). The test holds the two lists together.
 */
export const PLATFORM_ICONS = {
  appleTouch: '/icons/apple-touch-icon.bc80fc2b.png',
  favicon16: '/icons/favicon-16.bc80fc2b.png',
  favicon32: '/icons/favicon-32.bc80fc2b.png',
  any192: '/icons/icon-192.bc80fc2b.png',
  any512: '/icons/icon-512.bc80fc2b.png',
  maskable192: '/icons/maskable-192.bc80fc2b.png',
  maskable512: '/icons/maskable-512.bc80fc2b.png',
} as const;

/**
 * The root `/favicon.ico` — 16, 32 and 48 in one file, written by the same
 * script. The one icon whose name cannot carry a revision (every client that
 * probes for it asks for exactly this path), so it is served with the
 * document's revalidating Cache-Control, not the icons' week.
 */
export const ROOT_FAVICON = '/favicon.ico';

/**
 * The platform mark to draw inside the application when there is no merchant
 * logo to draw instead — a PNG from the fork rather than the R2 WebP, so that
 * a surface previewing what the customer is about to INSTALL shows the same
 * pixels the home screen will get. Showing the live logo here while the
 * launcher gets the fork would be a prettier lie.
 */
export const PLATFORM_APP_ICON = PLATFORM_ICONS.any192;

/**
 * The slot name a settings-driven logo would arrive under.
 *
 * There is no `logo` slot in `SITE_MEDIA_SLOTS` (worker/lib/siteMedia.ts)
 * today: that list covers brand marks, service icons and banners, so the
 * `mainPageMedia` setting has never been able to point at the logo and no
 * admin screen can replace it. Adding one is the only change that makes a
 * logo replacement stop needing a cache purge, because the admin upload route
 * mints `<slot>-<token>.webp` — the URL changes by construction, `immutable`
 * becomes honest again, and no browser anywhere is holding a promise about
 * the new name.
 */
export const SITE_LOGO_SLOT = 'logo';

/** The shape of one resolved site-media entry, as `/api/home` sends it. */
export interface SiteLogoCandidate {
  slot: string;
  /** '' for a slot the owner has not filled and that has no default. */
  url: string;
}

/**
 * THE SETTINGS-DRIVEN READER — the one funnel every surface should call.
 *
 * Today it always answers `SITE_LOGO_URL`, because nothing sends a `logo`
 * slot. That is the point rather than an oversight: when the slot lands,
 * every caller already follows the setting without being edited, and there is
 * no second place where "the logo" is decided. An entry with an empty `url`
 * means "not set" and falls back — the same rule the storefront applies to
 * every other site-media slot.
 */
export function resolveSiteLogoUrl(media?: readonly SiteLogoCandidate[] | null): string {
  if (!media) return SITE_LOGO_URL;
  const entry = media.find((m) => m && m.slot === SITE_LOGO_SLOT);
  const url = entry ? entry.url : '';
  return typeof url === 'string' && url.length > 0 ? url : SITE_LOGO_URL;
}
