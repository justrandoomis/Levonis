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
 * Subdomains a merchant can never be.
 *
 * Checked BEFORE `reserved_slugs`, and kept in code on purpose: this list has
 * to hold even if the database is unreachable, mid-migration, or has had a
 * row deleted by accident. A wildcard that resolves before the database
 * answers is a wildcard that must be safe without it.
 *
 * Grouped by WHY, because the reason decides whether a future name belongs
 * here. Two of the groups are not about names we use:
 *
 *   - the phishing surface (`login`, `verify`, `secure`…) is reserved because
 *     of who could otherwise ask for it. A merchant controls the content of
 *     their storefront, so a merchant on `login.levonis-iq.com` gets a valid
 *     certificate, the real brand's domain, and a page they write, aimed at
 *     this platform's own customers.
 *   - mail infrastructure (`send`, `dkim`, `bounce`…) is reserved because
 *     those names already speak for this domain's email to the rest of the
 *     internet.
 *
 * `docs/SUBDOMAIN_ARCHITECTURE.md` §3 carries the same reasoning for
 * operators. Names a merchant should not have for BUSINESS reasons live in
 * the `reserved_slugs` table instead, so they can change without a deploy.
 */
export const SYSTEM_SUBDOMAINS: ReadonlySet<string> = new Set([
  // 1. RUNNING SERVICES. Handing one of these to a merchant takes a live
  //    product down. `studio` serves LEVO Studio; `send` and `mail` carry
  //    outbound email.
  'www', 'studio', 'mail', 'send', 'api', 'app', 'community', 'support',

  // 2. MAIL INFRASTRUCTURE. A merchant on any of these does not just get a
  //    page — they get a name the world already trusts to speak for this
  //    domain's email, and deliverability breaks the moment it moves.
  'smtp', 'imap', 'pop', 'pop3', 'mx', 'webmail', 'email', 'mailer',
  'newsletter', 'bounce', 'bounces', 'unsubscribe', 'dkim', 'dmarc', 'spf',
  'autodiscover', 'autoconfig', 'em', 'mg', 'mandrill', 'postmaster',

  // 3. THE PHISHING SURFACE, and the reason this list is longer than it looks.
  //    A merchant controls the CONTENT of their storefront. A merchant on
  //    `login.levonis-iq.com` gets a real certificate, a real subdomain of
  //    the real brand, and a page they write themselves — pointed at this
  //    platform's own customers. These names are refused because of who
  //    could otherwise ask for them, not because we plan to use them all.
  'auth', 'login', 'signin', 'signup', 'register', 'account', 'accounts',
  'id', 'sso', 'oauth', 'verify', 'verification', 'reset', 'password',
  'secure', 'security', 'my', 'me', 'profile', 'session',

  // 4. PLATFORM FUNCTIONS. A shop at `checkout.` or `wallet.` is
  //    indistinguishable from the platform doing the same thing.
  'admin', 'dashboard', 'checkout', 'cart', 'order', 'orders', 'invoice',
  'invoices', 'receipt', 'receipts', 'pay', 'payments', 'payment', 'wallet',
  'billing', 'shop', 'store', 'stores', 'merchant', 'merchants', 'seller',
  'sellers', 'vendor', 'vendors', 'help', 'contact', 'about', 'legal',
  'terms', 'privacy', 'refund', 'refunds', 'abuse', 'report',

  // 5. INFRASTRUCTURE AND OPERATIONS.
  'cdn', 'assets', 'static', 'files', 'media', 'img', 'images', 'video',
  'ns', 'ns1', 'ns2', 'ns3', 'ns4', 'dns', 'ftp', 'sftp', 'ssh', 'vpn',
  'git', 'ci', 'build', 'deploy', 'status', 'health', 'metrics', 'logs',
  'grafana', 'kibana', 'monitor', 'cpanel', 'whm', 'plesk', 'webdisk',

  // 6. ENVIRONMENTS. A merchant on `staging.` or `beta.` will be mistaken
  //    for this platform's own pre-release site, by customers and by us.
  'dev', 'development', 'staging', 'stage', 'test', 'testing', 'qa',
  'beta', 'alpha', 'preview', 'sandbox', 'demo', 'local', 'localhost',
  'internal', 'private', 'root', 'blog', 'docs', 'doc', 'wiki', 'news',

  // 7. THE STOREFRONT'S OWN PATH WORDS (audit 01 B23). A store is addressed
  //    as `/api/storefront/<slug>`, beside fixed routes on the same router —
  //    so a shop slugged `resolve` was unreachable (`/resolve` answers first)
  //    and one slugged `by-id` collided with the legacy-link lookup. Every
  //    literal segment of that router is reserved, plus `p`, the product path
  //    on a store's own host; tests/storeSlugsPaging.test.ts walks the router
  //    so a new route word cannot be added without landing here.
  'resolve', 'by-id', 'p', 'products', 'sections', 'services', 'showcase', 'reviews', 'delivery',
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
  /**
   * Is this hostname the configured root domain, or anything beneath it?
   *
   * `kind` alone cannot answer that. `foreign` covers two completely
   * different situations — a host OUTSIDE the platform's domain (a
   * workers.dev URL, a preview deployment, localhost, or no root domain
   * configured at all), and a host INSIDE it that is too deep to be a store
   * (`a.b.levonis-iq.com`). The first is operator territory; the second is
   * next to merchant-controlled content. `adminAllowedOn` is the difference.
   */
  underRoot: boolean;
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
  const underRoot = !!host && !!root && (host === root || host.endsWith('.' + root));
  const fallback: HostInfo = { kind: 'foreign', host: host ?? '', slug: null, system: null, underRoot };
  if (!host || !root) return fallback;

  if (host === root) return { kind: 'main', host, slug: null, system: null, underRoot: true };
  if (!host.endsWith('.' + root)) return fallback;

  const prefix = host.slice(0, -(root.length + 1));
  // Only ONE label deep. `a.b.levonis-iq.com` is not a merchant: a wildcard
  // certificate covers one level, and deeper names are how cookie and
  // certificate scoping mistakes get exploited.
  if (prefix.includes('.')) return fallback;

  if (prefix === 'www') return { kind: 'main', host, slug: null, system: null, underRoot: true };
  if (isSystemSlug(prefix)) return { kind: 'system', host, slug: null, system: prefix, underRoot: true };
  if (!isValidSlugSyntax(prefix)) return fallback;
  return { kind: 'merchant', host, slug: prefix, system: null, underRoot: true };
}

/**
 * May platform administration be served on this host?
 *
 * THE THREAT: a page served from `evil.levonis-iq.com` is same-origin with
 * `evil.levonis-iq.com/api/…`, and the session cookie is scoped to the parent
 * domain, so that page can drive the API with a visiting admin's own
 * credentials. Anything under the platform's domain that is not the apex is
 * therefore refused (§53).
 *
 * WHAT THIS FIXES: the guard used to be `kind === 'main'`, which quietly made
 * a CONFIGURATION MISTAKE into a total outage. When STORE_ROOT_DOMAIN and
 * APP_ORIGIN do not name the domain the site is actually served on, every
 * host classifies as `foreign` — including the apex — and the whole admin API
 * answered 404. That is precisely what happened on the first production
 * verification run, and a security guard that fails closed onto the
 * operators, on a host no merchant can control, is not making anyone safer.
 *
 * So the rule is about the RELATIONSHIP to the root domain, not the label:
 *
 *   main                          → yes, this is the platform
 *   system / merchant             → no, a merchant may control this page
 *   foreign, under the root       → no (`a.b.levonis-iq.com` — one wildcard
 *                                  certificate covers one level, and deeper
 *                                  names are where scoping mistakes get
 *                                  exploited)
 *   foreign, outside the root     → yes — a workers.dev deployment, a preview
 *                                  URL, localhost, or a root domain that is
 *                                  not configured. No merchant can be served
 *                                  there, and the operator has to be able to
 *                                  administer their own deployment.
 */
export function adminAllowedOn(info: HostInfo): boolean {
  if (info.kind === 'main') return true;
  if (info.kind === 'system' || info.kind === 'merchant') return false;
  return !info.underRoot;
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
