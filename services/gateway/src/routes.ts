/**
 * THE ROUTING TABLE (`01-TARGET.md` §3.3).
 *
 * One row per public prefix: which host classes it is served on, who will own
 * it, in which phase ownership flips, what the caller must prove, which rate
 * class it belongs to, and whether an anonymous GET of it may be cached.
 *
 * THREE PROPERTIES MAKE THIS SAFE TO PUT IN FRONT OF A LIVE SITE.
 *
 *  1. **Every row starts at CORE.** `targetFor()` returns the row's `owner`
 *     only once `GATEWAY_PHASE` has reached its `flipPhase`; at phase 1 every
 *     legacy prefix resolves to `CORE`, so the gateway is a transparent hop.
 *     Flipping a prefix is a var change (`GATEWAY_PHASE`), and flipping it
 *     BACK is `ROUTE_OVERRIDES` — seconds, no deploy (`02-MIGRATION-PLAN.md`
 *     rollback level (b)).
 *  2. **Nothing falls off the table.** The last row is `/api` → CORE, the
 *     strangler default: a prefix nobody has claimed keeps being served by the
 *     Worker that serves it today. `test/routing.test.ts` reads every
 *     `app.route(...)` mount out of `worker/index.ts` and fails if one does
 *     not resolve to exactly the owner recorded here — which is what stops a
 *     new mount in the core from silently becoming a 404 at the edge.
 *  3. **Longest prefix wins, and a `pattern` row wins over a prefix row.**
 *     Matching is plain `startsWith`, because the design's rows are written as
 *     `/api/admin/wallet*` and `/api/admin/orders*` and must cover
 *     `/api/admin/wallet-requests` and `/api/admin/orders/:id/stage` alike.
 *     The two places where one prefix has two owners (`GET
 *     /api/orders/:id/tracking` → Fulfilment, `GET /api/orders/:id/units` →
 *     Devices) are `pattern` rows.
 *
 * Host rules mirror `docs/SUBDOMAIN_ARCHITECTURE.md` §5: `main` is apex-only
 * (platform administration and anything that changes credentials), `root` is
 * the apex plus every merchant storefront (a customer shopping on a store host
 * still needs cart, wallet and orders), `all` adds hosts outside the root —
 * which in practice means a workers.dev or localhost deployment, exactly as
 * `adminAllowedOn` already treats them.
 */
import type { RouteHosts, RouteRequires, RouteTarget, RouteOverride } from '@levonis/contracts/http/gateway';
import type { RateClass } from '@levonis/platform-kit/edge/capabilities';

export type { RouteHosts, RouteRequires, RouteTarget, RouteOverride };

export interface RouteRule {
  /** matched with `startsWith` — the design writes these as `<prefix>*` */
  prefix: string;
  hosts: RouteHosts;
  /** who serves it at the end state */
  owner: RouteTarget;
  /** the phase in which `owner` takes over from CORE; null = never (CORE keeps it, or the gateway answers) */
  flipPhase: number | null;
  requires: RouteRequires;
  rateClass: RateClass;
  /** anonymous GETs of this prefix may enter the Cache API allowlist (src/cache.ts narrows it further) */
  cacheable?: boolean;
  /** the row applies only to these methods */
  methods?: readonly string[];
  /** the row applies only when the path also matches (more specific than any prefix row) */
  pattern?: RegExp;
  /** a legacy alias: responses carry `x-levonis-legacy-path: 1` so the 410 decision has usage data */
  legacy?: boolean;
  note?: string;
}

/** `/api/health` is forwarded to CORE unchanged; the gateway answers only `?gw=1` and `?deep=1`. */
export const HEALTH_PATH = '/api/health';

/**
 * The four endpoints `worker/index.ts:193-196` answers with 410. The gateway
 * answers them itself with the same bodies, so a stale client sees no change
 * when the surrounding prefix flips to a service that never knew them.
 */
export const GONE_ROUTES: Readonly<Record<string, string>> = {
  '/api/d1/query': 'This endpoint has been removed.',
  '/api/d1/init': 'This endpoint has been removed.',
  '/api/make-all-investors': 'This endpoint has been removed.',
  '/api/upload': 'Use POST /api/uploads.',
};

export const ROUTES: readonly RouteRule[] = [
  // ---------------------------------------------------------------- health
  { prefix: HEALTH_PATH, hosts: 'all', owner: 'CORE', flipPhase: null, requires: 'none', rateClass: 'public-read', note: 'forwarded unchanged: workflow 7 must keep proving the core' },

  // -------------------------------------------------------------- identity
  { prefix: '/api/auth', hosts: 'root', owner: 'IDENTITY', flipPhase: 9, requires: 'none', rateClass: 'auth', note: 'shared login across the apex and every storefront' },
  { prefix: '/api/profile', hosts: 'root', owner: 'IDENTITY', flipPhase: 9, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/addresses', hosts: 'root', owner: 'IDENTITY', flipPhase: 9, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/community-favorites', hosts: 'root', owner: 'IDENTITY', flipPhase: 9, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/studio', hosts: 'main', owner: 'IDENTITY', flipPhase: 9, requires: 'none', rateClass: 'auth', note: 'Studio handoff/introspect: bearer server-to-server, exempt from the ip class' },

  // -------------------------------------------------------------- telegram
  { prefix: '/api/telegram/webhook', hosts: 'main', owner: 'NOTIFICATIONS', flipPhase: 4, requires: 'none', rateClass: 'webhook', note: 'secret-header check moves with it' },
  { prefix: '/api/telegram/admin', hosts: 'main', owner: 'NOTIFICATIONS', flipPhase: 4, requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/telegram', hosts: 'root', owner: 'IDENTITY', flipPhase: 9, requires: 'none', rateClass: 'auth', note: 'link/OTP status poll — 240/min per ip, see limiter.ts' },

  // ------------------------------------------------------- catalog (public)
  { prefix: '/api/products', hosts: 'root', owner: 'CATALOG', flipPhase: 5, requires: 'none', rateClass: 'public-read', cacheable: true },
  { prefix: '/api/home', hosts: 'root', owner: 'CATALOG', flipPhase: 5, requires: 'none', rateClass: 'public-read', cacheable: true },
  { prefix: '/api/bundles', hosts: 'root', owner: 'CATALOG', flipPhase: 5, requires: 'none', rateClass: 'public-read', cacheable: true, note: 'members-only body; an anonymous miss is success:false and is never stored' },
  { prefix: '/api/settings/public', hosts: 'root', owner: 'CONFIG', flipPhase: 4, requires: 'none', rateClass: 'public-read', cacheable: true },

  // -------------------------------------------------------- catalog (admin)
  { prefix: '/api/admin/bundles', hosts: 'main', owner: 'CATALOG', flipPhase: 5, requires: 'admin', rateClass: 'admin-write' },
  // The mystery pools, their weights and the eligible-stock preview: catalogue
  // configuration, and its own mount because its own router carries its own
  // requireAdmin (docs/BUNDLES_MYSTERY.md §10).
  { prefix: '/api/admin/mystery', hosts: 'main', owner: 'CATALOG', flipPhase: 5, requires: 'admin', rateClass: 'admin-write' },
  // Windows, tiers, limits and the offer price for ANY subject — one promotion
  // model, so it sits with the coupons/offers owner rather than with the
  // catalogue (docs/BUNDLES_MYSTERY.md §9, §10).
  { prefix: '/api/admin/offers', hosts: 'main', owner: 'COMMERCE', flipPhase: 5, requires: 'admin', rateClass: 'admin-write' },
  // The composition and mystery read models: aggregates only, no order id and
  // no user id, so they belong to Analytics (§12).
  { prefix: '/api/admin/analytics', hosts: 'main', owner: 'ANALYTICS', flipPhase: 5, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/products-v2', hosts: 'main', owner: 'CATALOG', flipPhase: 5, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/products', hosts: 'main', owner: 'CATALOG', flipPhase: 5, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/taxonomy', hosts: 'main', owner: 'CATALOG', flipPhase: 5, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/template', hosts: 'main', owner: 'CATALOG', flipPhase: 5, requires: 'admin', rateClass: 'upload' },
  { prefix: '/api/admin/import', hosts: 'main', owner: 'CATALOG', flipPhase: 5, requires: 'admin', rateClass: 'upload' },
  { prefix: '/api/admin/media/ingest', hosts: 'main', owner: 'FILES', flipPhase: 4, requires: 'admin', rateClass: 'upload' },
  { prefix: '/api/admin/media', hosts: 'main', owner: 'CATALOG', flipPhase: 5, requires: 'admin', rateClass: 'admin-write' },

  // -------------------------------------------------------------- commerce
  { prefix: '/api/cart', hosts: 'root', owner: 'COMMERCE', flipPhase: 7, requires: 'auth', rateClass: 'write' },
  { prefix: '/api/orders', hosts: 'root', owner: 'COMMERCE', flipPhase: 7, requires: 'auth', rateClass: 'money', note: 'GET /api/orders/:id is read on merchant hosts for store orders' },
  { prefix: '/api/orders', pattern: /^\/api\/orders\/[^/]+\/tracking$/, methods: ['GET', 'HEAD'], hosts: 'root', owner: 'FULFILMENT', flipPhase: 7, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/orders', pattern: /^\/api\/orders\/[^/]+\/units$/, methods: ['GET', 'HEAD'], hosts: 'root', owner: 'DEVICES', flipPhase: 7, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/orders', pattern: /^\/api\/orders\/[^/]+\/settlement$/, methods: ['POST'], hosts: 'main', owner: 'LEDGER', flipPhase: 8, requires: 'auth', rateClass: 'money' },
  { prefix: '/api/returns/admin', hosts: 'main', owner: 'COMMERCE', flipPhase: 7, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/returns', hosts: 'main', owner: 'COMMERCE', flipPhase: 7, requires: 'auth', rateClass: 'write' },
  { prefix: '/api/price-protection/admin', hosts: 'main', owner: 'COMMERCE', flipPhase: 7, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/price-protection', hosts: 'main', owner: 'COMMERCE', flipPhase: 7, requires: 'auth', rateClass: 'write' },
  { prefix: '/api/admin/orders', hosts: 'main', owner: 'COMMERCE', flipPhase: 7, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/orders', pattern: /^\/api\/admin\/orders\/[^/]+\/(stage|delivery)/, hosts: 'main', owner: 'FULFILMENT', flipPhase: 7, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/delivery', hosts: 'main', owner: 'FULFILMENT', flipPhase: 7, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/labels', hosts: 'main', owner: 'FULFILMENT', flipPhase: 7, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/coupons', hosts: 'main', owner: 'COMMERCE', flipPhase: 7, requires: 'admin', rateClass: 'admin-write' },

  // ------------------------------------------------------------------ money
  { prefix: '/api/wallet/admin', hosts: 'main', owner: 'LEDGER', flipPhase: 8, requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/wallet', hosts: 'root', owner: 'LEDGER', flipPhase: 8, requires: 'auth', rateClass: 'money', note: 'wallet read on storefront checkout' },
  { prefix: '/api/rewards', hosts: 'root', owner: 'LEDGER', flipPhase: 8, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/admin/wallet', hosts: 'main', owner: 'LEDGER', flipPhase: 8, requires: 'admin:full', rateClass: 'admin-write', note: 'covers /api/admin/wallet-requests and /api/admin/wallet/credit' },

  // -------------------------------------------- subscriptions and referrals
  { prefix: '/api/memberships/referral', hosts: 'root', owner: 'REFERRALS', flipPhase: 6, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/memberships/admin/referrals', hosts: 'main', owner: 'REFERRALS', flipPhase: 6, requires: 'admin:full', rateClass: 'admin-write' },
  // What a membership is WORTH: the configured PRO/PREMIUM shopping benefit
  // rules (migration 0074). Subscriptions owns the tables, so it owns the door.
  { prefix: '/api/admin/membership-benefits', hosts: 'main', owner: 'SUBSCRIPTIONS', flipPhase: 6, requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/memberships/admin', hosts: 'main', owner: 'SUBSCRIPTIONS', flipPhase: 6, requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/memberships', hosts: 'root', owner: 'SUBSCRIPTIONS', flipPhase: 6, requires: 'none', rateClass: 'user' },
  { prefix: '/api/subscription', hosts: 'root', owner: 'SUBSCRIPTIONS', flipPhase: 6, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/referrals/admin', hosts: 'main', owner: 'REFERRALS', flipPhase: 6, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/referrals', hosts: 'main', owner: 'REFERRALS', flipPhase: 6, requires: 'auth', rateClass: 'user' },

  // ---------------------------------------------------------------- reviews
  { prefix: '/api/reviews/admin', hosts: 'main', owner: 'REVIEWS', flipPhase: 6, requires: 'admin:full', rateClass: 'admin-write', note: 'moderation mints points' },
  { prefix: '/api/reviews', hosts: 'main', owner: 'REVIEWS', flipPhase: 6, requires: 'none', rateClass: 'write' },

  // ----------------------------------------------- marketplace / merchants
  { prefix: '/api/merchant', hosts: 'root', owner: 'MARKETPLACE', flipPhase: 6, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/storefront', hosts: 'root', owner: 'MARKETPLACE', flipPhase: 6, requires: 'none', rateClass: 'public-read', cacheable: true, note: '/api/storefront/resolve must answer on every hostname' },
  { prefix: '/api/community-reviews', hosts: 'root', owner: 'MARKETPLACE', flipPhase: 6, requires: 'none', rateClass: 'write' },
  { prefix: '/api/community', hosts: 'root', owner: 'MARKETPLACE', flipPhase: 6, requires: 'none', rateClass: 'user', legacy: true, note: 'legacy shims' },
  { prefix: '/api/store-orders', hosts: 'root', owner: 'MARKETPLACE', flipPhase: 6, requires: 'auth', rateClass: 'money' },
  { prefix: '/api/marketplace', hosts: 'root', owner: 'MARKETPLACE', flipPhase: 6, requires: 'none', rateClass: 'write', note: '/api/marketplace/print extends the same requests' },
  { prefix: '/api/admin/community', hosts: 'main', owner: 'MARKETPLACE', flipPhase: 6, requires: 'admin', rateClass: 'admin-write' },
  // The print quote engine (migration 0078). It answers «احسب سعر طباعتك» for a
  // GUEST — the calculator is how somebody finds out the shop exists, so
  // `requires: 'none'` is the point of it, and the route's own per-bucket rate
  // limits do the work an auth gate would otherwise do.
  { prefix: '/api/print-quote', hosts: 'root', owner: 'MARKETPLACE', flipPhase: 6, requires: 'none', rateClass: 'upload', note: 'guest uploads a model and is quoted for it' },

  // ------------------------------------------------------- leaves (phase 4)
  { prefix: '/api/chats', hosts: 'root', owner: 'CHAT', flipPhase: 4, requires: 'auth', rateClass: 'write' },
  { prefix: '/api/notifications', hosts: 'root', owner: 'NOTIFICATIONS', flipPhase: 4, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/uploads', hosts: 'root', owner: 'FILES', flipPhase: 4, requires: 'auth', rateClass: 'upload' },
  { prefix: '/files', hosts: 'root', owner: 'FILES', flipPhase: 4, requires: 'none', rateClass: 'public-read', cacheable: true, note: 'the /files/<key> path contract is permanent' },
  { prefix: '/api/invoices', hosts: 'main', owner: 'INVOICES', flipPhase: 4, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/kyc/admin', hosts: 'main', owner: 'KYC', flipPhase: 4, requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/kyc', hosts: 'main', owner: 'KYC', flipPhase: 4, requires: 'auth', rateClass: 'upload' },
  { prefix: '/api/policies/admin', hosts: 'main', owner: 'POLICIES', flipPhase: 4, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/policies', hosts: 'root', owner: 'POLICIES', flipPhase: 4, requires: 'none', rateClass: 'public-read', cacheable: true },
  { prefix: '/api/support/admin/restrictions', hosts: 'main', owner: 'RISK', flipPhase: 4, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/support/admin', hosts: 'main', owner: 'SUPPORT', flipPhase: 4, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/support', hosts: 'main', owner: 'SUPPORT', flipPhase: 4, requires: 'auth', rateClass: 'write' },
  { prefix: '/api/invest', hosts: 'main', owner: 'INVEST', flipPhase: 4, requires: 'investor', rateClass: 'user' },
  { prefix: '/api/admin/invest', hosts: 'main', owner: 'INVEST', flipPhase: 4, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/farm', hosts: 'main', owner: 'FARM', flipPhase: 4, requires: 'none', rateClass: 'user', note: 'the leaderboard is the one public route' },
  { prefix: '/api/admin/farm', hosts: 'main', owner: 'FARM', flipPhase: 4, requires: 'admin:full', rateClass: 'admin-write', note: 'grants coins' },
  { prefix: '/api/admin/settings', hosts: 'main', owner: 'CONFIG', flipPhase: 4, requires: 'admin', rateClass: 'admin-write' },

  // ---------------------------------------------- devices and warranty (7)
  { prefix: '/api/devices/admin', hosts: 'main', owner: 'DEVICES', flipPhase: 7, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/devices', hosts: 'main', owner: 'DEVICES', flipPhase: 7, requires: 'auth', rateClass: 'user' },
  { prefix: '/api/warranty/verify', hosts: 'root', owner: 'DEVICES', flipPhase: 7, requires: 'none', rateClass: 'public-read', note: 'a customer verifies a document on a store host too' },
  { prefix: '/api/warranty', hosts: 'main', owner: 'DEVICES', flipPhase: 7, requires: 'none', rateClass: 'user' },
  { prefix: '/api/admin/warranties', hosts: 'main', owner: 'DEVICES', flipPhase: 7, requires: 'admin', rateClass: 'admin-write' },

  // ------------------------------------------------------- the Admin BFF (9)
  { prefix: '/api/admin/overview', hosts: 'main', owner: 'ADMIN', flipPhase: 9, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/users', hosts: 'main', owner: 'ADMIN', flipPhase: 9, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/admin/users', methods: ['PATCH', 'PUT', 'DELETE'], hosts: 'main', owner: 'ADMIN', flipPhase: 9, requires: 'admin:full', rateClass: 'admin-write', note: 'role and tier are financial/PII writes' },
  { prefix: '/api/admin/providers', hosts: 'main', owner: 'ADMIN', flipPhase: 9, requires: 'admin', rateClass: 'admin-write' },

  // ------------------------------------------------- the versioned surface
  { prefix: '/api/v1/audit', hosts: 'main', owner: 'AUDIT', flipPhase: 2, requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/v1/analytics', hosts: 'main', owner: 'ANALYTICS', flipPhase: 2, requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/v1/ads', hosts: 'main', owner: 'ADS', flipPhase: 2, requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/v1/search', hosts: 'root', owner: 'SEARCH', flipPhase: 4, requires: 'none', rateClass: 'public-read', cacheable: true },
  { prefix: '/api/v1/risk', hosts: 'main', owner: 'RISK', flipPhase: 4, requires: 'admin', rateClass: 'admin-write' },

  // ---------------------------------------------------------------- legacy
  { prefix: '/api/translate', hosts: 'main', owner: 'CORE', flipPhase: null, requires: 'admin', rateClass: 'admin-write', legacy: true, note: '410 after the owner decides D8' },

  // ----------------------------------------------- the strangler defaults
  // Admin before the bare /api default so an unclaimed admin prefix is still
  // apex-only and admin-gated. Both keep answering from the core.
  { prefix: '/api/admin', hosts: 'main', owner: 'CORE', flipPhase: null, requires: 'admin', rateClass: 'admin-write', note: 'whatever routes/admin.ts still mounts' },
  { prefix: '/api', hosts: 'root', owner: 'CORE', flipPhase: null, requires: 'none', rateClass: 'ip', note: 'the strangler default: an unclaimed prefix keeps being served by the core' },
];

/** Rows are ordered by specificity: a `pattern` row beats a prefix row, then the longest prefix wins. */
export function applies(rule: RouteRule, path: string, method: string): boolean {
  if (!path.startsWith(rule.prefix)) return false;
  if (rule.pattern && !rule.pattern.test(path)) return false;
  if (rule.methods && !rule.methods.includes(method.toUpperCase())) return false;
  return true;
}

function moreSpecific(a: RouteRule, b: RouteRule): boolean {
  if (!!a.pattern !== !!b.pattern) return !!a.pattern;
  if (!!a.methods !== !!b.methods) return !!a.methods;
  return a.prefix.length > b.prefix.length;
}

export function matchRoute(path: string, method: string, rules: readonly RouteRule[] = ROUTES): RouteRule | null {
  let best: RouteRule | null = null;
  for (const r of rules) {
    if (!applies(r, path, method)) continue;
    if (!best || moreSpecific(r, best)) best = r;
  }
  return best;
}

/** `"<prefix>=<TARGET>,…"` — the kill switch. An unparsable entry is dropped, never guessed. */
export function parseOverrides(value: string | undefined, targets: readonly string[]): RouteOverride[] {
  const out: RouteOverride[] = [];
  for (const entry of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const prefix = entry.slice(0, eq).trim();
    const target = entry.slice(eq + 1).trim().toUpperCase();
    if (!prefix.startsWith('/') || !targets.includes(target)) continue;
    out.push({ prefix, target: target as RouteTarget });
  }
  return out;
}

/**
 * Every target name the overrides parser accepts (also the binding names the
 * pipeline looks up). Typed as `RouteTarget[]`, so a target added to the
 * contract without a home here — or a typo — is a compile error.
 */
export const ROUTE_TARGETS: readonly RouteTarget[] = [
  'CORE', 'IDENTITY', 'CATALOG', 'COMMERCE', 'LEDGER', 'SUBSCRIPTIONS', 'REFERRALS', 'REVIEWS', 'MARKETPLACE',
  'CHAT', 'NOTIFICATIONS', 'FILES', 'INVOICES', 'DEVICES', 'KYC', 'POLICIES', 'SUPPORT', 'RISK', 'INVEST',
  'FARM', 'CONFIG', 'ADMIN', 'FULFILMENT', 'AUDIT', 'ANALYTICS', 'ADS', 'SEARCH', 'GATEWAY',
];

/**
 * The target a rule resolves to at a given phase, with the kill switch applied
 * LAST — an override wins over the phase, which is what makes it a rollback.
 * The longest matching override prefix wins, like the table itself.
 */
export function targetFor(rule: RouteRule, phase: number, overrides: readonly RouteOverride[] = [], path?: string): RouteTarget {
  let target: RouteTarget = rule.flipPhase !== null && phase >= rule.flipPhase ? rule.owner : 'CORE';
  let bestLen = -1;
  for (const o of overrides) {
    const subject = path ?? rule.prefix;
    if (!subject.startsWith(o.prefix)) continue;
    if (o.prefix.length > bestLen) {
      bestLen = o.prefix.length;
      target = o.target;
    }
  }
  return target;
}

export interface Resolution {
  rule: RouteRule;
  target: RouteTarget;
}

/** The one entry point: path + method + phase + overrides → the rule and the Worker that serves it. */
export function resolve(path: string, method: string, phase: number, overrides: readonly RouteOverride[] = [], rules: readonly RouteRule[] = ROUTES): Resolution | null {
  const rule = matchRoute(path, method, rules);
  if (!rule) return null;
  return { rule, target: targetFor(rule, phase, overrides, path) };
}

export const phaseOf = (v: string | undefined): number => {
  const n = Number.parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
};
