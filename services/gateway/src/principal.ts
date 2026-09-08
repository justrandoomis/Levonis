/**
 * Session → signed principal (`01-TARGET.md` §3.4, ADR-002).
 *
 * The gateway never reads `users` or `sessions`. It hashes the cookie exactly
 * as `worker/lib/session.ts` does (`sha256Hex(token)`) and asks Identity, which
 * returns a **signed** principal. The gateway then VERIFIES that signature
 * against Identity's published keys before it believes a single claim in it —
 * including the ones its own capability guard depends on (`role`, `scope`).
 *
 * WHY VERIFY SOMETHING WE JUST ASKED FOR. Because the same header is what the
 * callee will verify, and a gateway that forwards a principal it cannot verify
 * is a gateway that discovers a key rotation as a 403 storm in every service
 * at once. Verifying at the edge turns that into one failed lookup here, with
 * a reason, on the hop that can still fall back.
 *
 * WHY IDENTITY SIGNS AND NOT THE GATEWAY: a compromised gateway can then
 * replay a principal, but never mint one (§3.4).
 *
 * THE CACHE IS KEYED `(sid_hash, host_kind)` AND ONLY FOR READ CLASSES.
 * A customer who opens the apex and a storefront within the TTL must not get
 * the apex principal on both — `host_kind` is a signed claim the callee
 * compares against the gateway-set `x-levonis-host`, so one cache entry
 * serving both hosts would hand every service a mismatch (or, worse, a valid
 * principal for the wrong host class). `money` and `admin-write` classes never
 * read the cache: a logout or a role change must bite immediately where it
 * matters, and 30 seconds of staleness on a product list is not the same risk
 * as 30 seconds of staleness on a withdrawal.
 */
import type { Principal } from '@levonis/contracts/rpc/common';
import type { HostInfo } from '@levonis/platform-kit/edge/hosts';
import type { RateClass } from '@levonis/platform-kit/edge/capabilities';
import { KeyRing } from '@levonis/platform-kit/keys';
import { verifyPrincipal } from '@levonis/platform-kit/principal';
import { sha256Hex } from '@levonis/contracts/canonical';
import { SESSION_COOKIE } from './cache';
import type { IdentityGatewayApi } from './env';

export const PRINCIPAL_CACHE_TTL_MS = 30_000;
export const PRINCIPAL_CACHE_MAX = 10_000;
export const PUBLIC_KEY_TTL_MS = 5 * 60_000;

/** Classes that must resolve per request — no cache, ever (`01-TARGET.md` §3.4). */
export const UNCACHED_CLASSES: readonly RateClass[] = ['money', 'admin-write'];

export function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const s = part.trim();
    if (s.startsWith(`${name}=`)) return decodeURIComponent(s.slice(name.length + 1));
  }
  return null;
}

/** The `sessions.id` the core stores: `sha256Hex(token)` (`worker/lib/session.ts`). */
export async function sidHashOf(cookieHeader: string | null): Promise<string | null> {
  const token = cookieValue(cookieHeader, SESSION_COOKIE);
  return token ? sha256Hex(token) : null;
}

interface Entry {
  header: string;
  principal: Principal;
  at: number;
}

/** Insertion-ordered LRU-by-age: the oldest entry is evicted at the cap. */
export class PrincipalCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly ttlMs = PRINCIPAL_CACHE_TTL_MS, private readonly max = PRINCIPAL_CACHE_MAX, private readonly now: () => number = () => Date.now()) {}

  private static key(sidHash: string, hostKind: string): string {
    return `${sidHash}|${hostKind}`;
  }

  get(sidHash: string, hostKind: string): Entry | null {
    const k = PrincipalCache.key(sidHash, hostKind);
    const hit = this.entries.get(k);
    if (!hit) return null;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(k);
      return null;
    }
    return hit;
  }

  set(sidHash: string, hostKind: string, header: string, principal: Principal): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(PrincipalCache.key(sidHash, hostKind), { header, principal, at: this.now() });
  }

  /** `SessionRevoked` / logout: drop every host-kind entry for this session. */
  evictSession(sidHash: string): number {
    let n = 0;
    for (const k of [...this.entries.keys()]) if (k.startsWith(`${sidHash}|`)) { this.entries.delete(k); n++; }
    return n;
  }

  /** `RoleChanged`: the subject's id is not the cache key, so the whole cache is dropped. Cheap, and correct. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Identity's public keys, refreshed at most every 5 minutes (§3.4). */
export class PublicKeyCache {
  private ring: KeyRing | null = null;
  private at = 0;
  constructor(private readonly ttlMs = PUBLIC_KEY_TTL_MS, private readonly now: () => number = () => Date.now()) {}

  async get(identity: Pick<IdentityGatewayApi, 'getPublicKeys'>, bootstrap?: string): Promise<KeyRing> {
    if (this.ring && this.now() - this.at < this.ttlMs) return this.ring;
    const ring = await KeyRing.fromAllowlist(bootstrap);
    try {
      const { keys } = await identity.getPublicKeys();
      for (const k of keys) await ring.add(k.service, k.public_key);
    } catch {
      // A registry that cannot be reached must not invalidate the bootstrap
      // allowlist: an unverifiable principal is dropped below, not trusted.
      if (this.ring) return this.ring;
    }
    this.ring = ring;
    this.at = this.now();
    return ring;
  }

  invalidate(): void {
    this.ring = null;
  }
}

export type PrincipalOutcome =
  | { kind: 'anonymous' }
  | { kind: 'resolved'; header: string; principal: Principal; cached: boolean }
  | { kind: 'rejected'; reason: string };

export interface ResolveInput {
  identity: IdentityGatewayApi | undefined;
  cookieHeader: string | null;
  host: HostInfo;
  cid: string;
  rateClass: RateClass;
  cache: PrincipalCache;
  keys: PublicKeyCache;
  bootstrapKids?: string;
  nowSeconds?: number;
}

/**
 * Resolve, verify and (where allowed) cache. Never throws: a gateway that
 * cannot resolve a session forwards the request as anonymous and lets the
 * service behind it decide — during Phases 3–8 that service still has the
 * cookie and its own `loadSessionUser`, so a lookup failure here is a lost
 * optimisation, not a lost login.
 */
export async function resolvePrincipal(input: ResolveInput): Promise<PrincipalOutcome> {
  if (!input.identity) return { kind: 'anonymous' };
  const sidHash = await sidHashOf(input.cookieHeader);
  if (!sidHash) return { kind: 'anonymous' };

  const cacheable = !UNCACHED_CLASSES.includes(input.rateClass);
  if (cacheable) {
    const hit = input.cache.get(sidHash, input.host.kind);
    if (hit) return { kind: 'resolved', header: hit.header, principal: hit.principal, cached: true };
  }

  let result;
  try {
    result = await input.identity.resolveSession({ sid_hash: sidHash, host_kind: input.host.kind, cid: input.cid });
  } catch {
    return { kind: 'rejected', reason: 'IDENTITY_UNAVAILABLE' };
  }
  if (!result || result.principal === null) return { kind: 'anonymous' };

  const ring = await input.keys.get(input.identity, input.bootstrapKids);
  const verified = await verifyPrincipal(result.principal, ring, {
    nowSeconds: input.nowSeconds ?? Math.floor(Date.now() / 1000),
    expectHostKind: input.host.kind,
    issuers: ['identity', 'core'],
  });
  if (!verified.ok) {
    // A rotation the 5-minute key cache has not seen yet looks exactly like
    // this, so the ring is dropped and the next request re-fetches it.
    if (verified.reason === 'UNKNOWN_KID') input.keys.invalidate();
    return { kind: 'rejected', reason: verified.reason };
  }

  if (cacheable) input.cache.set(sidHash, input.host.kind, result.principal, verified.principal);
  return { kind: 'resolved', header: result.principal, principal: verified.principal, cached: false };
}
