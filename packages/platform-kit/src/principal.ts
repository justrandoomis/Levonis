/**
 * The Identity-signed principal (`01-TARGET.md` §3.4, ADR-002). Identity signs;
 * the gateway forwards `x-levonis-principal`; every service verifies with
 * Identity's public keys, checks `exp` and compares `host_kind` with the
 * gateway-set `x-levonis-host`. A compromised gateway can replay, never mint.
 */
import type { HostKind, Principal, PrincipalRole, PrincipalScope } from '@levonis/contracts/rpc/common';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { obj, str, int, bool, nullable, oneOf, validator } from '@levonis/contracts/schema';
import { utf8 } from '@levonis/contracts/canonical';
import { parseCompact, signCompact, verifyBytes, type KeyRing, type SigningKey } from './keys';

export { PRINCIPAL_HEADER };
export type { Principal, PrincipalRole, PrincipalScope, HostKind };

/** User principals live 120 s; the gateway re-resolves per request for money/admin-write classes. */
export const PRINCIPAL_TTL_S = 120;
/** System principals (cron/queue) are minted per run and live 5 minutes. */
export const SYSTEM_PRINCIPAL_TTL_S = 300;

const principalCheck = validator(
  obj({
    v: oneOf(1),
    sub: str,
    sid_hash: nullable(str),
    role: oneOf('customer', 'merchant', 'admin', 'system', 'anonymous'),
    scope: nullable(oneOf('owner', 'full', 'assistant')),
    investor: bool,
    tier: nullable(str),
    locale: nullable(oneOf('ar', 'en', 'ckb')),
    host_kind: oneOf('main', 'system', 'merchant', 'foreign'),
    iat: int,
    exp: int,
    cid: str,
  })
);

export interface MintInput {
  sub: string;
  sid_hash: string | null;
  role: PrincipalRole;
  scope: PrincipalScope;
  investor: boolean;
  tier: string | null;
  locale: 'ar' | 'en' | 'ckb' | null;
  host_kind: HostKind;
  cid: string;
}

export function buildPrincipal(input: MintInput, nowSeconds: number, ttlSeconds = PRINCIPAL_TTL_S): Principal {
  return { v: 1, ...input, iat: nowSeconds, exp: nowSeconds + ttlSeconds };
}

/** `{ sub:'system:<svc>', role:'system' }` for cron/queue work, signed with the service key. */
export function systemPrincipalInput(svc: string, cid: string): MintInput {
  return { sub: `system:${svc}`, sid_hash: null, role: 'system', scope: null, investor: false, tier: null, locale: null, host_kind: 'system', cid };
}

/** The gateway's marker for an unauthenticated request on an anonymous route. */
export function anonymousPrincipalInput(ipHash: string, host_kind: HostKind, cid: string): MintInput {
  return { sub: `anon:${ipHash}`, sid_hash: null, role: 'anonymous', scope: null, investor: false, tier: null, locale: null, host_kind, cid };
}

export async function signPrincipal(key: SigningKey, principal: Principal): Promise<string> {
  principalCheck.parse(principal);
  return signCompact(key, principal);
}

export type PrincipalVerification =
  | { ok: true; principal: Principal; kid: string }
  | {
      ok: false;
      reason: 'MALFORMED' | 'UNKNOWN_KID' | 'BAD_SIGNATURE' | 'INVALID_CLAIMS' | 'EXPIRED' | 'NOT_YET_VALID' | 'HOST_MISMATCH' | 'WRONG_ISSUER';
    };

export interface VerifyPrincipalOptions {
  nowSeconds: number;
  /** the gateway-set `x-levonis-host` kind; a mismatch is a 403 and an AuditRecorded */
  expectHostKind?: HostKind;
  /** the services whose keys may sign principals (`identity`; `gateway` for anonymous/system markers) */
  issuers?: string[];
  /** clock skew tolerance */
  leewaySeconds?: number;
}

export async function verifyPrincipal(header: string, ring: KeyRing, opts: VerifyPrincipalOptions): Promise<PrincipalVerification> {
  const parts = parseCompact(header);
  if (!parts) return { ok: false, reason: 'MALFORMED' };
  const key = ring.get(parts.header.kid);
  if (!key) return { ok: false, reason: 'UNKNOWN_KID' };
  if (opts.issuers && !opts.issuers.includes(key.service)) return { ok: false, reason: 'WRONG_ISSUER' };
  if (!(await verifyBytes(key, utf8(parts.signingInput), parts.sig))) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (!principalCheck.is(parts.payload)) return { ok: false, reason: 'INVALID_CLAIMS' };
  const p = parts.payload as Principal;
  const leeway = opts.leewaySeconds ?? 5;
  if (p.exp + leeway < opts.nowSeconds) return { ok: false, reason: 'EXPIRED' };
  if (p.iat - leeway > opts.nowSeconds) return { ok: false, reason: 'NOT_YET_VALID' };
  if (opts.expectHostKind && p.host_kind !== opts.expectHostKind) return { ok: false, reason: 'HOST_MISMATCH' };
  return { ok: true, principal: p, kid: parts.header.kid };
}

/**
 * The `c.get('user')` shape route code expects (`worker/lib/types.ts` SessionUser),
 * reconstructed from a principal. Fields a principal CANNOT fill are typed
 * `null`/`''` and listed in `UNFILLABLE_SESSION_FIELDS`: every extraction slice
 * greps the moved routes for them and replaces the read with
 * `IDENTITY.contactFor` (Notifications only) or removes it.
 */
export const UNFILLABLE_SESSION_FIELDS = ['email', 'phone', 'profile_json', 'bio', 'checkin_streak', 'google_sub', 'name', 'username', 'avatar_key'] as const;

export interface PrincipalSessionUser {
  id: string;
  role: 'customer' | 'merchant' | 'admin';
  is_investor: number;
  membership_tier: string;
  admin_scope: string | null;
  locale: string | null;
  /** UNFILLABLE — see UNFILLABLE_SESSION_FIELDS */
  email: '';
  phone: null;
  profile_json: null;
  bio: null;
  checkin_streak: 0;
  google_sub: null;
  name: '';
  username: null;
  avatar_key: null;
}

export function principalToSessionUser(p: Principal): PrincipalSessionUser | null {
  if (p.role === 'system' || p.role === 'anonymous') return null;
  return {
    id: p.sub,
    role: p.role,
    is_investor: p.investor ? 1 : 0,
    membership_tier: p.tier ?? 'free',
    admin_scope: p.role === 'admin' ? (p.scope === 'assistant' ? 'assistant' : 'full') : null,
    locale: p.locale,
    email: '',
    phone: null,
    profile_json: null,
    bio: null,
    checkin_streak: 0,
    google_sub: null,
    name: '',
    username: null,
    avatar_key: null,
  };
}

/** Authorization helpers over the principal (services re-apply their own checks, `01-TARGET.md` §4 item 2). */
export const isSignedIn = (p: Principal | null | undefined): p is Principal => !!p && p.role !== 'anonymous' && p.role !== 'system';
export const isAdmin = (p: Principal | null | undefined): boolean => !!p && p.role === 'admin';
export const isFullAdmin = (p: Principal | null | undefined): boolean => isAdmin(p) && p?.scope !== 'assistant';
export const isSystem = (p: Principal | null | undefined, svc?: string): boolean =>
  !!p && p.role === 'system' && (svc === undefined || p.sub === `system:${svc}`);
