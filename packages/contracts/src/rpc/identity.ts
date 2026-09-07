/**
 * Identity's RPC surface (`01-TARGET.md` §3.4, §2.4, §3.6) — the core's
 * `IdentityEntrypoint` until Phase 9, then `levonis-identity`.
 */
import type { EventConsumer } from './consumer';
import type { HostKind, RpcCtx } from './common';

export interface ResolveSessionInput {
  /** sha256 of the cookie token, as `lib/session.ts` computes it */
  sid_hash: string;
  host_kind: HostKind;
  cid: string;
}

export type ResolveSessionResult = { principal: string; exp: number } | { principal: null; reason: 'NOT_FOUND' | 'EXPIRED' | 'REVOKED' };

/** Display fields only — never email, phone, hashes (`01-TARGET.md` §2.4). */
export interface UserDisplay {
  id: string;
  username: string | null;
  name: string | null;
  avatar_key: string | null;
  role: 'customer' | 'merchant' | 'admin';
  membership_tier: string | null;
}

export interface UserContact {
  id: string;
  email: string | null;
  phone_masked: string | null;
}

export type ContactChannel = 'email' | 'telegram' | 'phone';

export interface PublicKey {
  kid: string;
  alg: 'EdDSA';
  /** base64url raw Ed25519 public key (32 bytes) */
  public_key: string;
  service: string;
  not_after: string | null;
}

/** The contract cap: D1 binds ≤100 parameters, so list-taking calls take ≤90 ids. */
export const LOOKUP_MAX_IDS = 90;

export interface IdentityApi extends EventConsumer {
  resolveSession(input: ResolveSessionInput, ctx: RpcCtx): Promise<ResolveSessionResult>;
  /** ≤90 ids; display fields only. */
  lookupUsers(ids: string[], ctx: RpcCtx): Promise<UserDisplay[]>;
  /** `admin_scope='full'` callers only (levonis-admin, Support member-360); audited. */
  lookupContacts(ids: string[], ctx: RpcCtx): Promise<UserContact[]>;
  /** One user, one channel, Notifications only; audited. */
  contactFor(userId: string, channel: ContactChannel, ctx: RpcCtx): Promise<{ address: string } | null>;
  /** Today's D1 fixed-window upsert (`lib/ratelimit.ts`), reached by every Worker. */
  rateLimitHit(cls: string, key: string, limit: number, windowSeconds: number, ctx: RpcCtx): Promise<{ allowed: boolean; count: number }>;
  revoke(sidHash: string, ctx: RpcCtx): Promise<{ revoked: boolean }>;
  getPublicKeys(ctx: RpcCtx): Promise<{ keys: PublicKey[] }>;
  /** Studio SSO — allowlisted for Studio's kid together with `introspect` only. */
  redeemHandoff(code: string, ctx: RpcCtx): Promise<{ ok: true; sid_hash: string; user: UserDisplay } | { ok: false; reason: 'INVALID' | 'EXPIRED' | 'USED' }>;
  introspect(sidHash: string, ctx: RpcCtx): Promise<{ active: boolean; user?: UserDisplay }>;
  /** `IDENTITY.setRole` — audited; replaces `admin.ts` PATCH /users/:id role writes. */
  setRole(cmd: { userId: string; role: 'customer' | 'merchant' | 'admin'; adminScope: 'full' | 'assistant' | null; isInvestor: boolean }, ctx: RpcCtx): Promise<{ ok: boolean }>;
}
