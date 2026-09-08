/**
 * The capability guard (`01-TARGET.md` §3.5): host + role + financial scope,
 * applied at the edge to every admin surface — by CAPABILITY, not by prefix.
 *
 * WHAT THIS CLOSES. Seven admin surfaces live outside `/api/admin/*`
 * (`/api/kyc/admin`, `/api/wallet/admin`, `/api/support/admin`,
 * `/api/telegram/admin`, `/api/reviews/admin`, `/api/memberships/admin`,
 * `/api/devices/admin`). `worker/index.ts` mounts `requireMainHost` on
 * `/api/admin/*` only; Phase 0 fixed the rest by putting the host rule inside
 * `requireAdmin` itself. The gateway now refuses them one hop earlier, and
 * `test/capabilities.test.ts` fails if any admin mount discovered in
 * `worker/index.ts` or in a service's admin router lacks a `hosts:'main'` row.
 *
 * TWO RULES, TWO CLOCKS.
 *  - The HOST rule applies from the first request: it needs no principal, only
 *    the classified Host header, and it is the guard that makes wildcard
 *    merchant subdomains survivable (`edge/hosts.ts` §53).
 *  - The ROLE and SCOPE rules apply only when the gateway actually holds a
 *    verified principal for the request (`PRINCIPAL_MODE=on` for that class).
 *    While the core still runs `loadSessionUser` itself, the gateway must not
 *    invent an answer from a cookie it has not resolved — so it forwards and
 *    lets the service decide. The service check is the authority in every
 *    phase; the gateway is defence in depth (`01-TARGET.md` §4 item 2).
 *
 * Refusal bodies are today's, byte for byte: host → 404 `{success:false,
 * error:'Not found'}`; missing principal → 401 `Authentication required` /
 * `UNAUTHORIZED`; wrong role → 403 `Administrator access required`;
 * assistant scope on a money/PII surface → 403 `FORBIDDEN`.
 */
import type { Principal } from '@levonis/contracts/rpc/common';
import type { HostInfo } from '@levonis/platform-kit/edge/hosts';
import { adminAllowedOn } from '@levonis/platform-kit/edge/hosts';
import { meetsRequirement } from '@levonis/platform-kit/scope';
import type { Capability, Denial } from '@levonis/platform-kit/edge/capabilities';
import { ADMIN_CAPABILITIES, ADMIN_FULL_PREFIXES } from '@levonis/platform-kit/edge/capabilities';
import { ROUTES, type RouteHosts, type RouteRule } from './routes';

export type { Capability, Denial };
export { ADMIN_CAPABILITIES, ADMIN_FULL_PREFIXES };

/**
 * The host rule, over the full `HostInfo` rather than the bare kind.
 *
 * `adminAllowedOn` is reused verbatim for `main` — including its deliberate
 * "foreign and OUTSIDE the root domain is the operator's own deployment"
 * branch, which is why a mistyped STORE_ROOT_DOMAIN cannot 404 the whole admin
 * API again (`edge/hosts.ts`). `root` is everything under the platform's
 * domain plus that same operator case; a host under the root that is too deep
 * to be a store (`a.b.levonis-iq.com`) is refused before this is reached
 * (`pipeline.ts`, `01-TARGET.md` §3.2 step 3).
 */
export function hostAllowedFor(rule: RouteHosts, info: HostInfo): boolean {
  if (rule === 'main') return adminAllowedOn(info);
  if (rule === 'root') return info.underRoot || info.kind === 'foreign';
  return true;
}

/** Every capability row the gateway enforces: the routing table's, plus the kit's admin seed. */
export function capabilitiesFrom(rules: readonly RouteRule[] = ROUTES): Capability[] {
  const fromRoutes: Capability[] = rules.map((r) => ({
    prefix: r.prefix,
    hosts: r.hosts,
    requires: r.requires,
    rateClass: r.rateClass,
    ...(r.cacheable ? { cacheable: true } : {}),
    ...(r.methods ? { methods: r.methods } : {}),
  }));
  return [...fromRoutes, ...ADMIN_CAPABILITIES];
}

/** True when this path+method is one of the money/PII admin surfaces that need a non-assistant admin. */
export function needsFinancialScope(path: string, method: string): boolean {
  if (ADMIN_FULL_PREFIXES.some((p) => path.startsWith(p) && !p.endsWith('users/'))) return true;
  // `/api/admin/users/:id` is admin-readable but only `admin:full` may PATCH a
  // role or a tier (`01-TARGET.md` §3.5).
  if (path.startsWith('/api/admin/users/')) return ['PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  return false;
}

export interface GuardInput {
  path: string;
  method: string;
  host: HostInfo;
  rule: RouteRule;
  /** the VERIFIED principal, or null when the gateway holds none for this request */
  principal: Principal | null;
  /** false while the core still resolves the session itself: host rule only */
  enforceIdentity: boolean;
}

/**
 * The guard. Returns the refusal, or null to forward.
 *
 * Order matters and is today's: host first (404 — a wrong-host caller learns
 * the route does not exist here, not that it exists elsewhere), then
 * authentication, then role, then scope.
 */
export function guard(input: GuardInput): Denial | null {
  const requires = needsFinancialScope(input.path, input.method) && input.rule.requires !== 'none' ? 'admin:full' : input.rule.requires;
  const hostRule: RouteHosts = requires === 'admin' || requires === 'admin:full' ? 'main' : input.rule.hosts;
  if (!hostAllowedFor(hostRule, input.host)) return { status: 404, body: { success: false, error: 'Not found' } };
  if (!input.enforceIdentity || requires === 'none') return null;
  const p = input.principal;
  if (!p || p.role === 'anonymous') return { status: 401, body: { success: false, error: 'Authentication required', code: 'UNAUTHORIZED' } };
  if (meetsRequirement(p, requires)) return null;
  const error =
    requires === 'investor' ? 'Investor access required'
      : requires === 'admin' ? 'Administrator access required'
        : requires === 'admin:full' ? 'Administrator access required'
          : 'Not allowed';
  return { status: 403, body: { success: false, error, code: 'FORBIDDEN' } };
}
