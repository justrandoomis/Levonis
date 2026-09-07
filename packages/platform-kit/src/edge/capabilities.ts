/**
 * The capability table (`01-TARGET.md` §3.5): `{ prefix, hosts, requires,
 * rateClass, cacheable? }` per route prefix. Every `<domain>/admin/` prefix and
 * `/api/admin/` requires `hosts:'main'` + `admin`; money- or PII-writing admin
 * paths require `admin:full`. The gateway matches by longest prefix; the
 * service check is the authority. Denial bodies are today's.
 *
 * This module carries the type, the matcher, the denial bodies and the admin
 * seed rows; the full routing table arrives with the gateway (slice 1.5) and
 * `tests/gatewayCapabilities.test.ts` fails if an admin mount lacks a `main` rule.
 */
import type { HostKind, Principal } from '@levonis/contracts/rpc/common';
import { meetsRequirement } from '../scope';

export type HostRule = 'main' | 'root' | 'all';
export type Requirement = 'none' | 'auth' | 'investor' | 'admin' | 'admin:full';
export type RateClass = 'ip' | 'user' | 'auth' | 'money' | 'write' | 'upload' | 'admin-write' | 'public-read' | 'webhook';

export interface Capability {
  prefix: string;
  hosts: HostRule;
  requires: Requirement;
  rateClass: RateClass;
  cacheable?: boolean;
  /** which methods the rule covers; default all */
  methods?: readonly string[];
}

/** Money- or PII-writing admin prefixes: `admin:full` at the gateway AND in the service. */
export const ADMIN_FULL_PREFIXES = [
  '/api/wallet/admin/', '/api/admin/wallet', '/api/kyc/admin/', '/api/telegram/admin/', '/api/reviews/admin/',
  '/api/memberships/admin/', '/api/admin/farm/', '/api/admin/users/',
] as const;

/** The admin seed: every admin surface is apex-only and admin-gated. */
export const ADMIN_CAPABILITIES: readonly Capability[] = [
  { prefix: '/api/admin/', hosts: 'main', requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/telegram/admin/', hosts: 'main', requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/kyc/admin/', hosts: 'main', requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/support/admin/', hosts: 'main', requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/policies/admin/', hosts: 'main', requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/wallet/admin/', hosts: 'main', requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/admin/wallet', hosts: 'main', requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/referrals/admin/', hosts: 'main', requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/reviews/admin/', hosts: 'main', requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/devices/admin/', hosts: 'main', requires: 'admin', rateClass: 'admin-write' },
  { prefix: '/api/memberships/admin/', hosts: 'main', requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/admin/farm/', hosts: 'main', requires: 'admin:full', rateClass: 'admin-write' },
  { prefix: '/api/admin/users/', hosts: 'main', requires: 'admin:full', rateClass: 'admin-write', methods: ['PATCH', 'PUT', 'DELETE'] },
  { prefix: '/api/v1/', hosts: 'main', requires: 'admin', rateClass: 'admin-write', methods: ['*ADMIN*'] },
];

/** Longest matching prefix wins; a `methods` list narrows the match. */
export function matchCapability(rules: readonly Capability[], path: string, method = 'GET'): Capability | null {
  let best: Capability | null = null;
  for (const r of rules) {
    if (!path.startsWith(r.prefix)) continue;
    if (r.methods && !r.methods.includes(method.toUpperCase()) && !r.methods.includes('*ADMIN*')) continue;
    if (r.methods?.includes('*ADMIN*') && !/\/admin(\/|$)/.test(path)) continue;
    if (!best || r.prefix.length > best.prefix.length) best = r;
  }
  return best;
}

export function hostAllowed(rule: HostRule, hostKind: HostKind): boolean {
  if (rule === 'all') return true;
  if (rule === 'root') return hostKind !== 'foreign';
  return hostKind === 'main' || hostKind === 'foreign'; // `adminAllowedOn`: a foreign host is treated as the main site so a probe learns nothing
}

export type Denial =
  | { status: 404; body: { success: false; error: 'Not found' } }
  | { status: 401; body: { success: false; error: 'Authentication required'; code: 'UNAUTHORIZED' } }
  | { status: 403; body: { success: false; error: string; code: 'FORBIDDEN' } };

/** Today's bodies (`worker/lib/http.ts`): host 404, then 401, then 403. */
export function capabilityDenial(rule: Capability, principal: Principal | null, hostKind: HostKind): Denial | null {
  if (!hostAllowed(rule.hosts, hostKind)) return { status: 404, body: { success: false, error: 'Not found' } };
  if (rule.requires === 'none') return null;
  if (!principal || principal.role === 'anonymous') return { status: 401, body: { success: false, error: 'Authentication required', code: 'UNAUTHORIZED' } };
  if (meetsRequirement(principal, rule.requires)) return null;
  const error =
    rule.requires === 'investor' ? 'Investor access required' : rule.requires === 'admin' ? 'Administrator access required' : rule.requires === 'admin:full' ? 'Financial administrator access required' : 'Not allowed';
  return { status: 403, body: { success: false, error, code: 'FORBIDDEN' } };
}
