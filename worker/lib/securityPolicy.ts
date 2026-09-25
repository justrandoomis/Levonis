/**
 * Browser-side hardening — Content-Security-Policy and HSTS — in one place,
 * so the policy can be read, reasoned about and pinned by tests
 * (tests/securityPolicy.test.ts).
 *
 * WHY A CSP AT ALL. The same SPA bundle is served on the apex AND on every
 * merchant subdomain, and the session cookie is scoped to the parent domain,
 * so a page on `ali3d.levonis-iq.com` is same-origin with an API that carries
 * the visitor's own session — on a host where cart, checkout and orders are
 * deliberately available (§94). A merchant cannot upload code, but they do
 * control TEXT the platform renders: a store name, a bio, a product
 * description, a link. React escapes all of it by default. This policy is the
 * second lock for the day the first one fails: with no 'unsafe-inline' and no
 * 'unsafe-eval' in script-src, an injected <script>, an onerror= handler or a
 * javascript: URL does not execute even if it reaches the DOM.
 *
 * WHAT THE SPA POLICY ALLOWS, AND WHY — every entry is something the app
 * actually loads today:
 *   accounts.google.com   Google sign-in. @react-oauth/google injects
 *                         gsi/client, renders its button inside an iframe from
 *                         that origin and talks back to it.
 *   fonts.googleapis.com  the web fonts' stylesheet, and
 *   fonts.gstatic.com     the font files it references
 *   img-src https:        product media comes from vendor CDNs (Shopify,
 *                         Cloudflare Images, …) as well as from R2 under
 *                         /files. A host allowlist would break the next brand
 *                         the owner adds; https: still refuses mixed content.
 *   media-src https:      the same, for product video and the home ad video
 *   blob: / data:         image previews before upload, generated QR codes
 *   static.cloudflareinsights.com / cloudflareinsights.com
 *                         Cloudflare Web Analytics. The zone has it switched
 *                         on, so the EDGE injects `beacon.min.js` into every
 *                         HTML response after the Worker and the asset layer
 *                         are done — nothing in this repository loads it. The
 *                         first live run of workflow 28 found the policy
 *                         refusing that script on every public page: the
 *                         owner's analytics had gone dark the moment the CSP
 *                         shipped. The script origin may load and the beacon
 *                         origin may be posted to; both are Cloudflare's own,
 *                         serve fixed first-party code, and add no inline or
 *                         eval allowance. Switching the injection off instead
 *                         is a dashboard setting, i.e. the owner's call.
 *
 * The built index.html carries ONE external module script and ONE external
 * stylesheet and no inline code, which is what makes the strict script-src
 * possible without a nonce.
 *
 * THE PRINT DOCUMENTS ARE DIFFERENT. Receipts, warranty documents, delivery
 * labels and invoices are stand-alone HTML rendered by the Worker, with inline
 * <style> and — when opened for printing — one inline auto-print hook. They
 * carry their own policy (documentCsp) that names that exact script by hash.
 * Any other inline script in such a document, injected or accidental, is
 * refused. The hash is pinned next to the script it covers so the two cannot
 * drift apart unnoticed.
 */

// No imports on purpose: scripts/write-asset-headers.mjs loads this module at
// build time, inside the browser tsconfig's program, where Workers types do
// not exist. A structural parameter type keeps it dependency-free.

export const GOOGLE_SIGNIN_ORIGIN = 'https://accounts.google.com';
export const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com';
export const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';
/** Cloudflare Web Analytics: where the edge-injected beacon script comes from … */
export const CLOUDFLARE_INSIGHTS_SCRIPT = 'https://static.cloudflareinsights.com';
/** … and where it reports to. */
export const CLOUDFLARE_INSIGHTS_BEACON = 'https://cloudflareinsights.com';

/**
 * The one inline script the Worker ever emits: opens the browser's print
 * dialog once a receipt or warranty document has loaded. Both renderers emit
 * this exact string (tests pin that), so its hash is the whole script-src of
 * a document.
 */
export const AUTO_PRINT_SCRIPT =
  "window.addEventListener('load',function(){setTimeout(function(){window.print()},250)})";

/** sha256 of AUTO_PRINT_SCRIPT, base64. Recomputed by the test — edit both or neither. */
export const AUTO_PRINT_SCRIPT_HASH = 'sha256-gn9n97Z5Dr3GoujCS/3qgP8CfP2OXYrMB9UIoJccUsw=';

/**
 * The ONE inline script the SPA document carries (index.html): it sets
 * `data-theme` before the first paint from the stored appearance choice
 * (src/lib/theme.ts owns the same logic afterwards), so a light page never
 * flashes dark and a dark one never flashes ivory. It cannot be an external
 * file without a render-blocking request, and it cannot wait for the bundle —
 * that IS the flash. So it is allowed by hash, like AUTO_PRINT_SCRIPT, and the
 * policy still admits no other inline code. tests/themeSystem.test.ts holds
 * this string to index.html and to the built dist/index.html byte for byte.
 */
export const THEME_BOOT_SCRIPT =
  `(function(){var p,d,t,r=document.documentElement,m,b;try{p=localStorage.getItem('levonis.theme.v1')}catch(e){}d=p==='dark'||(p==='system'&&!!window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);t=d?'dark':'light';r.setAttribute('data-theme',t);r.style.colorScheme=t;m=document.querySelector('meta[name="theme-color"]');b=document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');if(m)m.setAttribute('content',d?'#0b0c0f':'#f3f0ea');if(b)b.setAttribute('content',d?'black':'default')})()`;

/** sha256 of THEME_BOOT_SCRIPT, base64. Recomputed by the test — edit both or neither. */
export const THEME_BOOT_SCRIPT_HASH = 'sha256-vXjQOhoD66tMh84jxZLg6dOGLXcd3AeXZQwZ1CIo90s=';

/**
 * One year, and every subdomain: the apex, every merchant storefront and
 * studio are all served over TLS at the Cloudflare edge. No `preload` — that
 * is a registry submission for the owner to make, not a header to slip in.
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

function policy(directives: Array<[string, string[]]>): string {
  return directives.map(([name, sources]) => (sources.length ? `${name} ${sources.join(' ')}` : name)).join('; ');
}

/**
 * The four static hardening headers, shared by the Worker middleware
 * (lib/http.ts securityHeaders) and the static-asset `_headers` file so the
 * two can never disagree.
 */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

/**
 * The policy for the SPA and the JSON API. Deliberately independent of the
 * deployment's domain: the app talks only to its own origin (LEVO Studio is
 * a LINK the user follows, never a fetch), so the same text can be written
 * into the static `_headers` file at build time.
 */
export function spaCsp(): string {
  return policy([
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'${THEME_BOOT_SCRIPT_HASH}'`, GOOGLE_SIGNIN_ORIGIN, CLOUDFLARE_INSIGHTS_SCRIPT]],
    ['style-src', ["'self'", "'unsafe-inline'", GOOGLE_FONTS_CSS, GOOGLE_SIGNIN_ORIGIN]],
    ['font-src', ["'self'", 'data:', GOOGLE_FONTS_FILES]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['media-src', ["'self'", 'blob:', 'https:']],
    ['connect-src', ["'self'", 'blob:', GOOGLE_SIGNIN_ORIGIN, GOOGLE_FONTS_CSS, CLOUDFLARE_INSIGHTS_BEACON]],
    ['frame-src', [GOOGLE_SIGNIN_ORIGIN]],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ]);
}

/**
 * The `_headers` file for Workers Static Assets, written into dist/ by
 * scripts/write-asset-headers.mjs after every build.
 *
 * WHY A FILE. `run_worker_first` in wrangler.jsonc names the only paths the
 * Worker is invoked for; index.html and every asset are served by the asset
 * layer BEFORE the Worker exists for that request. So the middleware above
 * never touched the page itself — the audit's live probe found the SPA
 * document without X-Frame-Options, nosniff or any policy, while the API next
 * to it had them all. The asset layer honours a `_headers` file; generating it
 * from this module keeps one policy text.
 *
 * THE PRODUCT PATHS ARE THE EXCEPTION, AND THEY DO NOT CHANGE THE ANSWER.
 * `/product/*` and its three siblings were later added to `run_worker_first`
 * so a shared link can carry the product's own share card
 * (worker/lib/socialPreview.ts). Those documents therefore pass through the
 * middleware as well — and get the SAME text, because `securityHeaders` sets
 * a policy only when the response does not already carry one, and the one it
 * would set comes from this very module. Every other SPA route is still served
 * by the asset layer alone, so this file stays the only thing standing between
 * the page and a missing policy.
 */
/**
 * `/assets/*` IS CONTENT-HASHED, SO IT NEVER NEEDS REVALIDATING.
 *
 * Vite emits every chunk as `Name-<hash>.js`: change a byte and the NAME
 * changes, so a given URL's bytes can never change. That is exactly the
 * condition `immutable` describes, and this file carried no Cache-Control at
 * all — so a returning visitor sent a conditional request for each of 181
 * chunks and waited for 181 304s before the app could start. On a 4G
 * connection in Iraq that is the whole of the second-visit cost.
 *
 * INDEX.HTML MUST NOT GET IT. The document is the thing that NAMES the current
 * hashes; caching it for a year would pin a browser to one deploy for a year
 * and no new release would ever reach it. It gets `no-cache` — revalidate
 * every time, which is one cheap 304 — and the SPA routes with it, because
 * they serve that same document.
 *
 * `_headers` applies the LAST matching rule, so the specific `/assets/*` block
 * follows the catch-all rather than preceding it.
 */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const DOCUMENT_CACHE_CONTROL = 'no-cache';

/**
 * THE SERVICE WORKER AND THE APP ICONS BOTH NEED A CACHE RULE THE CATCH-ALL
 * ABOVE CANNOT GIVE THEM.
 *
 * `/sw.js` — public/sw.js, copied verbatim into dist by vite — is the single
 * file in this deployment that can keep hurting people after it is fixed. An
 * installed browser goes on running the copy it already has until it fetches a
 * newer one, and it fetches a newer one on navigation. So `no-cache`
 * (revalidate every time, one cheap 304, exactly what index.html gets and for
 * exactly the same reason) is what makes a correction reach an installed
 * visitor on their NEXT navigation. Browsers already refuse to trust a cached
 * worker script for more than 24 hours whatever this header says, so it cannot
 * make matters worse; what it prevents is the layer in between — a corporate
 * proxy, an ISP cache, the browser's own HTTP cache — holding a broken worker
 * for the whole of that day.
 *
 * CONTENT-TYPE IS THE ASSET LAYER'S, AND IT IS ALREADY RIGHT. A `.js` file is
 * served as `text/javascript` (observed live on a built chunk under /assets),
 * which is one of the JavaScript MIME types a service worker registration
 * requires; registration is refused outright otherwise, with a MIME error and
 * no offline mode. Nothing here may change it, and nothing here sets it.
 *
 * NO `Service-Worker-Allowed` HEADER, ON PURPOSE. The script is served from
 * the ROOT, so its default scope is already the whole origin. That header
 * would only be needed to widen the scope of a worker living in a
 * subdirectory, and widening scope by header is the kind of thing that should
 * have to be asked for.
 *
 * `/icons/*` are the installed app's icons, and they are NOT content-hashed:
 * the names are fixed (`icon-192.png`), which is the whole point — the
 * manifest and index.html name them literally. So `immutable` would be a lie
 * here in a way it is not under /assets, and the day the owner changes the
 * mark every installed home screen would keep the old one for a year. A week
 * with revalidation is the honest compromise: an already-installed phone stops
 * re-fetching its icon on every visit, and a new mark still reaches everyone
 * within seven days.
 *
 * WHY EACH RULE BELOW DELETES EVERY HEADER IT IS ABOUT TO SET. Read the note
 * above about the last, more specific rule replacing the earlier one — and
 * then read this, because the live site disagrees with it. EVERY matching rule
 * is applied, in file order, and a header name an earlier rule already set is
 * APPENDED to rather than overwritten. A built chunk comes back today carrying
 * `Cache-Control: no-cache, public, max-age=31536000, immutable`, and its
 * Content-Security-Policy and its nosniff twice over.
 *
 * For Cache-Control the cost is obvious: the leading `no-cache` inherited from
 * the catch-all wins in every conformant client, which is why the `immutable`
 * in the block above has in fact never done anything, and why an `/icons/*`
 * rule written the same way would cost a round trip and buy nothing.
 *
 * For Strict-Transport-Security it is worse and much quieter. Its grammar has
 * no room for a comma, so `max-age=31536000; includeSubDomains,
 * max-age=31536000; includeSubDomains` is not a weaker HSTS — it is an
 * unparseable one, and an unparseable STS header is discarded whole. A rule
 * that "repeats the security headers" would therefore have removed HSTS from
 * exactly the paths it was written to protect.
 *
 * So every rule here is made COMPLETE and EXCLUSIVE: it unsets each header
 * first, then sets it. The unset operator is the two characters `! ` followed
 * by the header name, on a line that carries no colon, and unsets are applied
 * before sets within a rule whatever their order in the file. Each header then
 * ships exactly once, with the value written here — which is what the note
 * above always meant, and now is.
 *
 * `/assets/*` IS NOW CORRECTED TOO, AND THIS PARAGRAPH IS THE DECISION THAT
 * PREVIOUSLY SAID IT WOULD NOT BE.
 *
 * It used to read: "`/*` and `/assets/*` ARE LEFT EXACTLY AS THEY WERE. Their
 * duplication is pre-existing and live; correcting it changes the headers on
 * every page and every chunk in the application, which is a decision of its
 * own and is not being smuggled in behind a service worker." That was the
 * right call at the time — the change belonged to somebody deciding about
 * performance, not to a service-worker commit. The owner has since asked for
 * exactly that decision: «اختبر الموقع لتحسين السرعة وخاصة الظهور الأولي …
 * وخاصة على الأجهزة الضعيفة».
 *
 * WHAT IT WAS COSTING, measured on the live site before the change. Every
 * content-hashed chunk came back as:
 *
 *     cache-control: no-cache, public, max-age=31536000, immutable
 *     x-content-type-options: nosniff
 *     x-content-type-options: nosniff
 *
 * The leading `no-cache` is the catch-all's, appended to rather than replaced,
 * and it wins in every conformant client: the browser must ask the origin
 * before reusing a file whose URL already guarantees its bytes. Five such
 * files are on the critical path (`index`, `vendor-react`, `vendor-motion`,
 * `vendor-i18n` and the stylesheet), so a repeat visit paid five conditional
 * round trips — at the ~450 ms first-byte measured from Iraq — to be told
 * nothing had changed. On a slow connection that is the difference between an
 * app that opens and one that thinks about it.
 *
 * AND IT WAS A SECURITY HOLE, which is the part that decided it. HSTS's
 * grammar has no room for a comma, so the doubled
 * `max-age=31536000; includeSubDomains, max-age=31536000; includeSubDomains`
 * is not a weaker HSTS — it is unparseable, and an unparseable STS header is
 * discarded whole. Every `/assets/*` response was therefore shipping NO
 * Strict-Transport-Security at all, on exactly the paths that carry the
 * application's code.
 *
 * `/*` STAYS AS IT IS: it is the FIRST rule, nothing precedes it, so it has
 * nothing to unset and no duplication to correct. `no-cache` on the document
 * is not a defect there — it is the point (see DOCUMENT_CACHE_CONTROL).
 */
export const SERVICE_WORKER_CACHE_CONTROL = 'no-cache';
export const ICON_CACHE_CONTROL = 'public, max-age=604800';

export function assetHeadersFile(): string {
  const security = [
    `  Content-Security-Policy: ${spaCsp()}`,
    `  Strict-Transport-Security: ${STRICT_TRANSPORT_SECURITY}`,
    ...Object.entries(STATIC_SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`),
  ];
  // Derived from the very lines above, so the two can never drift: a header
  // added to `security` and forgotten here would be the one that ships twice.
  const clear = ['Content-Security-Policy', 'Strict-Transport-Security', ...Object.keys(STATIC_SECURITY_HEADERS), 'Cache-Control'].map(
    (name) => `  ! ${name}`
  );
  const lines = [
    '# GENERATED by scripts/write-asset-headers.mjs from worker/lib/securityPolicy.ts — do not edit.',
    '# Headers for every response the asset layer serves (index.html, SPA routes, /assets/*).',
    '/*',
    ...security,
    `  Cache-Control: ${DOCUMENT_CACHE_CONTROL}`,
    '',
    '# Content-hashed by Vite: the URL changes whenever the bytes do, so these',
    '# never need revalidating. The unsets are what make that true: without them',
    '# the catch-all above contributes a leading `no-cache` that wins over the',
    '# `immutable` below, and a doubled Strict-Transport-Security that no browser',
    '# can parse. Measured live before this: five conditional round trips per',
    '# repeat visit, and no HSTS on any chunk.',
    '/assets/*',
    ...clear,
    ...security,
    `  Cache-Control: ${ASSET_CACHE_CONTROL}`,
    '',
    '# The service worker script itself. It is the one file that keeps running',
    '# after it is wrong, so it must revalidate on every navigation — that is how',
    '# a fix reaches an already-installed browser on its next page view instead of',
    '# up to a day later. The unsets are not decoration: the catch-all above already',
    '# set them, and a second rule APPENDS to a header rather than replacing it —',
    '# which for Strict-Transport-Security means an unparseable value the browser',
    '# discards whole.',
    '/sw.js',
    ...clear,
    ...security,
    `  Cache-Control: ${SERVICE_WORKER_CACHE_CONTROL}`,
    '',
    '# The installed app icons. Fixed names, not content-hashed, so never',
    '# `immutable`: a changed mark would sit on installed home screens for a year.',
    '# A week, with revalidation — and the same unsets, for the same reason, or the',
    '# inherited no-cache would make this rule buy nothing at all.',
    '/icons/*',
    ...clear,
    ...security,
    `  Cache-Control: ${ICON_CACHE_CONTROL}`,
    '',
    '# The Kurdish patch face (src/index.css explains what it is and why it is',
    '# 4.8 KB). Fixed name, NOT content-hashed, so it takes the icons policy and',
    '# never the `immutable` one above: a corrected glyph must be able to reach a',
    '# browser that already has the old file, and `immutable` for a year would',
    '# stop it. The same unsets for the same reason — without them the inherited',
    '# no-cache wins and the rule buys nothing.',
    '/fonts/*',
    ...clear,
    ...security,
    `  Cache-Control: ${ICON_CACHE_CONTROL}`,
  ];
  return lines.join('\n') + '\n';
}

/** Stand-alone print documents: inline styles, the one hashed inline script, nothing else. */
export function documentCsp(): string {
  return policy([
    ['default-src', ["'none'"]],
    ['script-src', [`'${AUTO_PRINT_SCRIPT_HASH}'`]],
    ['style-src', ["'unsafe-inline'", GOOGLE_FONTS_CSS]],
    ['font-src', ["'self'", 'data:', GOOGLE_FONTS_FILES]],
    ['img-src', ["'self'", 'data:', 'https:']],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ]);
}

/**
 * Marks the response a route is about to build as a stand-alone document.
 * Call it before `c.html(...)`; `securityHeaders` then leaves this policy in
 * place instead of applying the SPA one.
 */
export function asDocument(c: { header: (name: string, value: string) => void }): void {
  c.header('Content-Security-Policy', documentCsp());
}
