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
    ['script-src', ["'self'", GOOGLE_SIGNIN_ORIGIN, CLOUDFLARE_INSIGHTS_SCRIPT]],
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
 * WHY A FILE. wrangler.jsonc runs the Worker only for /api/* and /files/*
 * (run_worker_first); index.html, every SPA route and every asset are served
 * by the asset layer BEFORE the Worker exists for that request. So the
 * middleware above never touched the page itself — the audit's live probe
 * found the SPA document without X-Frame-Options, nosniff or any policy,
 * while the API next to it had them all. The asset layer honours a
 * `_headers` file; generating it from this module keeps one policy text.
 */
export function assetHeadersFile(): string {
  const lines = [
    '# GENERATED by scripts/write-asset-headers.mjs from worker/lib/securityPolicy.ts — do not edit.',
    '# Headers for every response the asset layer serves (index.html, SPA routes, /assets/*).',
    '/*',
    `  Content-Security-Policy: ${spaCsp()}`,
    `  Strict-Transport-Security: ${STRICT_TRANSPORT_SECURITY}`,
    ...Object.entries(STATIC_SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`),
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
