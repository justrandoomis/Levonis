/**
 * What host is this request for, and what may that host do?
 *
 * Wildcard merchant subdomains change the threat model of this application,
 * so this file is deliberately small, pure and heavily tested
 * (tests/hosts.test.ts). Nothing here touches the database or the request
 * body; it turns a Host header into a classification, and every caller
 * branches on that.
 *
 * THE RISK THIS EXISTS TO CONTAIN. Once `*.levonis-iq.com` reaches this
 * Worker and the session cookie is scoped to `.levonis-iq.com`, a page served
 * from `evil.levonis-iq.com` is SAME-ORIGIN with `evil.levonis-iq.com/api/…`
 * — and the API is the same Worker, carrying the same session. The existing
 * `originCheck` cannot help: the origin genuinely matches. So classification
 * is not cosmetic routing, it is the boundary itself:
 *
 *   - `main`     — levonis-iq.com / www. Everything is available here.
 *   - `system`   — studio, mail, api… A merchant may never hold one of these
 *                  names, and they are matched BEFORE any database lookup so
 *                  a bad row in `reserved_slugs` cannot expose one (§7).
 *   - `merchant` — a candidate slug. Nothing is trusted yet: the slug is
 *                  syntax-checked here and only then looked up.
 *   - `foreign`  — anything else, including a spoofed Host. Treated as the
 *                  main site so a probe learns nothing, and never as a
 *                  merchant.
 *
 * Global admin is refused on every host except `main` (see requireMainHost).
 * That is what stops a compromised or hostile merchant storefront from
 * driving platform administration with the visitor's own cookie (§53).
 */

/**
 * Subdomains a merchant can never be. Checked before `reserved_slugs`, and
 * kept in code on purpose: this list must hold even if the database is
 * unreachable, mid-migration, or has had a row deleted by accident.
 */
export const SYSTEM_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www', 'api', 'admin', 'studio', 'mail', 'support', 'cdn', 'assets', 'static',
  'auth', 'account', 'community', 'shop', 'store', 'app', 'dashboard', 'status',
  'help', 'billing', 'checkout', 'blog', 'docs', 'dev', 'staging', 'test',
  'ftp', 'smtp', 'imap', 'ns1', 'ns2', 'mx', 'webmail', 'cpanel',
  'files', 'media', 'img', 'images', 'pay', 'payments', 'wallet',
  'security', 'abuse', 'legal', 'privacy',
]);

/** Slug syntax. Deliberately narrow — it becomes a DNS label and a URL. */
export const SLUG_MIN = 3;
export const SLUG_MAX = 32;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type HostKind = 'main' | 'system' | 'merchant' | 'foreign';

export interface HostInfo {
  kind: HostKind;
  /** The hostname, normalised: lowercase, no port, no trailing dot. */
  host: string;
  /** Present only when kind === 'merchant'. Already syntax-valid. */
  slug: string | null;
  /** The system label (e.g. 'studio'), when kind === 'system'. */
  system: string | null;
}

/**
 * Normalises a Host header into a bare hostname, or null if it is not one.
 *
 * A Host header is attacker-controlled. Anything with a slash, whitespace, an
 * '@', a second colon (IPv6 or a smuggled port), or a label that is not
 * DNS-shaped is rejected outright rather than parsed generously — a
 * "best-effort" parse here is exactly how a host ends up interpolated
 * somewhere it should not be (§55).
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Reject control characters BEFORE trimming. `trim()` would quietly swallow
  // a trailing newline, turning a header-injection attempt into a hostname
  // that looks perfectly ordinary. Nothing upstream should ever deliver one;
  // if it does, that is a reason to refuse the request, not to tidy it up.
  // Matching control characters is exactly the intent here: a Host header
  // containing one is a header-injection attempt, not a hostname, and must be
  // refused rather than sanitised.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  // Strip a single trailing dot (the FQDN root), which is legal in DNS and
  // would otherwise make "levonis-iq.com." look foreign.
  if (h.endsWith('.')) h = h.slice(0, -1);
  // Port, but only one and only digits.
  const colon = h.indexOf(':');
  if (colon !== -1) {
    const port = h.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    h = h.slice(0, colon);
  }
  if (!h || h.length > 253) return null;
  if (/[^a-z0-9.-]/.test(h)) return null;
  if (h.startsWith('.') || h.includes('..')) return null;
  for (const label of h.split('.')) {
    if (!label || label.length > 63) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
  }
  return h;
}

/** Is this a syntactically acceptable store slug? Says nothing about uniqueness. */
export function isValidSlugSyntax(slug: string): boolean {
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) return false;
  if (!SLUG_RE.test(slug)) return false;
  // No run of hyphens, and never the IDN prefix — 'xn--' would let a slug
  // render as a completely different script in the address bar.
  if (slug.includes('--')) return false;
  return true;
}

/** Reserved by the platform, independent of the database. */
export function isSystemSlug(slug: string): boolean {
  return SYSTEM_SUBDOMAINS.has(slug);
}

/**
 * Classifies a request host against the platform's root domain.
 *
 * `rootDomain` is configuration (APP_ORIGIN / STORE_ROOT_DOMAIN), never taken
 * from the request. If it is missing, every host is `foreign` — the platform
 * refuses to guess which domain it is, rather than trusting whatever arrived.
 */
export function classifyHost(rawHost: string | null | undefined, rootDomain: string | null | undefined): HostInfo {
  const host = normalizeHost(rawHost);
  const root = normalizeHost(rootDomain);
  const fallback: HostInfo = { kind: 'foreign', host: host ?? '', slug: null, system: null };
  if (!host || !root) return fallback;

  if (host === root) return { kind: 'main', host, slug: null, system: null };
  if (!host.endsWith('.' + root)) return fallback;

  const prefix = host.slice(0, -(root.length + 1));
  // Only ONE label deep. `a.b.levonis-iq.com` is not a merchant: a wildcard
  // certificate covers one level, and deeper names are how cookie and
  // certificate scoping mistakes get exploited.
  if (prefix.includes('.')) return fallback;

  if (prefix === 'www') return { kind: 'main', host, slug: null, system: null };
  if (isSystemSlug(prefix)) return { kind: 'system', host, slug: null, system: prefix };
  if (!isValidSlugSyntax(prefix)) return fallback;
  return { kind: 'merchant', host, slug: prefix, system: null };
}

/**
 * The `Domain` attribute for the session cookie, or null for a host-only cookie.
 *
 * Production must share one identity across `levonis-iq.com` and every
 * `*.levonis-iq.com` storefront (§8). Development and staging must NOT try:
 * `localhost` has no dot, and `*.workers.dev` sits under a public suffix, so a
 * browser silently DROPS the Set-Cookie in both cases — which would look like
 * "login is broken" rather than "the cookie was rejected".
 *
 * Returning null means "omit Domain", which yields a host-only cookie: the
 * correct, working behaviour everywhere a shared parent domain is impossible.
 */
export function sessionCookieDomain(rawHost: string | null | undefined, rootDomain: string | null | undefined): string | null {
  const host = normalizeHost(rawHost);
  const root = normalizeHost(rootDomain);
  if (!host || !root) return null;
  // A registrable parent domain needs at least one dot. 'localhost' does not
  // have one, and a single-label Domain is invalid.
  if (!root.includes('.')) return null;
  // Never widen onto a public suffix. workers.dev, pages.dev and github.io are
  // the ones this project could realistically be served from; a cookie scoped
  // to any of them would be offered to every other tenant on that suffix, and
  // browsers reject it anyway.
  if (PUBLIC_SUFFIXES.has(root)) return null;
  if (host !== root && !host.endsWith('.' + root)) return null;
  return '.' + root;
}

const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'workers.dev', 'pages.dev', 'github.io', 'vercel.app', 'netlify.app',
  'localhost', 'local', 'test', 'invalid', 'example',
]);

/**
 * The platform's root domain, from configuration only.
 * STORE_ROOT_DOMAIN wins when set; otherwise it is derived from APP_ORIGIN so
 * a deployment that already sets APP_ORIGIN needs no new variable.
 */
export function rootDomainFrom(env: { STORE_ROOT_DOMAIN?: string; APP_ORIGIN?: string }): string | null {
  const explicit = normalizeHost(env.STORE_ROOT_DOMAIN);
  if (explicit) return explicit;
  const origin = (env.APP_ORIGIN || '').trim();
  if (!origin) return null;
  try {
    return normalizeHost(new URL(origin).hostname);
  } catch {
    return null;
  }
}

/**
 * The canonical public URL of a storefront.
 * Falls back to the in-app route when there is no root domain configured, so
 * a staging deployment without wildcard DNS still links somewhere real rather
 * than to a host that does not resolve.
 */
export function storeUrl(slug: string, rootDomain: string | null, storeId: string): string {
  if (rootDomain && isValidSlugSyntax(slug) && !isSystemSlug(slug)) {
    return `https://${slug}.${rootDomain}`;
  }
  return `/community/store/${storeId}`;
}
