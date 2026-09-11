/**
 * `IdentityEntrypoint` — the identity half of the core, reachable over a
 * service binding (`01-TARGET.md` §2.4, §3.4, §3.6). This is what
 * `levonis-identity` will be in Phase 9; until then the gateway, Studio and
 * every extracted service reach sessions, display names, contacts and the
 * cross-isolate rate-limit counter THROUGH THESE METHODS instead of reading
 * `users`, `sessions` or `rate_limits` themselves.
 *
 * Nothing here is new behaviour: `resolveSession`/`introspect` run the same
 * lookup `lib/session.ts` runs on the cookie, `rateLimitHit` runs the upsert
 * `lib/ratelimit.ts` runs (the kit's `RATE_LIMIT_UPSERT_SQL` is that statement),
 * and `revoke` deletes the row `destroySession` deletes.
 *
 * WHAT NEVER LEAVES: a password hash, a Google subject, a session token, a raw
 * phone. `lookupUsers` answers display fields; `contactFor` answers ONE address
 * for ONE channel and is allowlisted to Notifications alone.
 */
import type {
  ContactChannel,
  IdentityApi,
  PublicKey,
  ResolveSessionInput,
  ResolveSessionResult,
  UserContact,
  UserDisplay,
} from '@levonis/contracts/rpc/identity';
import { LOOKUP_MAX_IDS } from '@levonis/contracts/rpc/identity';
import type { DeliverResult, RpcCtx } from '@levonis/contracts/rpc/common';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { d1RateLimitHit, rateLimitKey } from '@levonis/platform-kit/ratelimit';
import { signCompact, importSigningKey } from '@levonis/platform-kit/keys';
import { placeholders } from '@levonis/platform-kit/inList';
import { CoreEntrypoint } from './base';
import { maskPhone } from '../lib/phone';

interface SessionRow {
  user_id: string;
  expires_at: string;
}

/** The columns a display lookup may answer with — nothing else is selected. */
const DISPLAY_COLUMNS = 'id, username, name, avatar_key, role, membership_tier';

export class IdentityEntrypoint extends CoreEntrypoint {
  /**
   * The cookie has already been hashed by the caller (`sha256Hex(token)`, the
   * exact value `lib/session.ts` stores as `sessions.id`), so the raw token
   * never crosses a binding.
   */
  async resolveSession(input: ResolveSessionInput, ctx?: RpcCtx): Promise<ResolveSessionResult> {
    await this.assertHop('resolveSession', [input], ctx);
    const env = this.ready();
    const row = await env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?')
      .bind(input.sid_hash)
      .first<SessionRow>();
    if (!row) return { principal: null, reason: 'NOT_FOUND' };
    const exp = Date.parse(row.expires_at);
    if (!(exp > Date.now())) return { principal: null, reason: 'EXPIRED' };
    const user = await env.DB.prepare(
      `SELECT id, role, admin_scope, is_investor, membership_tier, locale FROM users WHERE id = ?`
    )
      .bind(row.user_id)
      .first<{ id: string; role: string; admin_scope: string | null; is_investor: number; membership_tier: string | null; locale: string }>();
    if (!user) return { principal: null, reason: 'NOT_FOUND' };
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      v: 1 as const,
      sub: user.id,
      sid_hash: input.sid_hash,
      role: user.role as 'customer' | 'merchant' | 'admin',
      scope: user.role === 'admin' ? ((user.admin_scope as 'full' | 'assistant' | null) ?? 'full') : null,
      investor: !!user.is_investor,
      tier: user.membership_tier ?? null,
      locale: user.locale === 'ku' ? ('ckb' as const) : user.locale === 'ar' ? ('ar' as const) : ('en' as const),
      host_kind: input.host_kind,
      iat,
      exp: iat + 120,
      cid: input.cid,
    };
    const key = await this.signingKey();
    if (!key) return { principal: null, reason: 'REVOKED' }; // no key configured: mint nothing rather than an unsigned claim
    return { principal: await signCompact(key, claims), exp: claims.exp };
  }

  /** ≤90 ids (D1 binds ≤100 parameters); display fields only. */
  async lookupUsers(ids: string[], ctx?: RpcCtx): Promise<UserDisplay[]> {
    await this.assertHop('lookupUsers', [ids], ctx);
    const env = this.ready();
    const wanted = [...new Set(ids.filter((i) => typeof i === 'string' && i))].slice(0, LOOKUP_MAX_IDS);
    if (wanted.length === 0) return [];
    const { results } = await env.DB.prepare(`SELECT ${DISPLAY_COLUMNS} FROM users WHERE id IN (${placeholders(wanted.length)})`)
      .bind(...wanted)
      .all<UserDisplay>();
    return results ?? [];
  }

  /** One user, one channel, Notifications only — and audited by the caller's own record. */
  async contactFor(userId: string, channel: ContactChannel, ctx?: RpcCtx): Promise<{ address: string } | null> {
    await this.assertHop('contactFor', [userId, channel], ctx);
    const env = this.ready();
    if (channel === 'email') {
      const row = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string }>();
      return row?.email && !row.email.endsWith('@telegram.local') ? { address: row.email } : null;
    }
    if (channel === 'phone') {
      const row = await env.DB.prepare('SELECT phone_e164 FROM users WHERE id = ?').bind(userId).first<{ phone_e164: string | null }>();
      return row?.phone_e164 ? { address: row.phone_e164 } : null;
    }
    const row = await env.DB.prepare('SELECT chat_id FROM telegram_links WHERE user_id = ? AND revoked_at IS NULL')
      .bind(userId)
      .first<{ chat_id: string }>();
    return row?.chat_id ? { address: String(row.chat_id) } : null;
  }

  /** Display-safe contacts for the admin surfaces — the phone is masked here, not by the caller. */
  async lookupContacts(ids: string[], ctx?: RpcCtx): Promise<UserContact[]> {
    await this.assertHop('lookupContacts', [ids], ctx);
    const env = this.ready();
    const wanted = [...new Set(ids.filter((i) => typeof i === 'string' && i))].slice(0, LOOKUP_MAX_IDS);
    if (wanted.length === 0) return [];
    const { results } = await env.DB.prepare(`SELECT id, email, phone_e164 FROM users WHERE id IN (${placeholders(wanted.length)})`)
      .bind(...wanted)
      .all<{ id: string; email: string | null; phone_e164: string | null }>();
    return (results ?? []).map((r) => ({ id: r.id, email: r.email, phone_masked: r.phone_e164 ? maskPhone(r.phone_e164) : null }));
  }

  /**
   * The cross-isolate counter every Worker shares (ADR-016). Identity owns
   * `rate_limits`, so this is the ONE writer — a service that moved out keeps
   * its limit by calling here instead of counting in its own isolate.
   */
  async rateLimitHit(cls: string, key: string, limit: number, windowSeconds: number, ctx?: RpcCtx): Promise<{ allowed: boolean; count: number }> {
    await this.assertHop('rateLimitHit', [cls, key, limit, windowSeconds], ctx);
    const env = this.ready();
    return d1RateLimitHit(env.DB, rateLimitKey(cls, null, '', key), limit, windowSeconds);
  }

  async revoke(sidHash: string, ctx?: RpcCtx): Promise<{ revoked: boolean }> {
    await this.assertHop('revoke', [sidHash], ctx);
    const env = this.ready();
    const res = await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sidHash).run();
    return { revoked: (res.meta.changes ?? 0) > 0 };
  }

  /** The public half of the core's signing key, for callers verifying its principals and events. */
  async getPublicKeys(ctx?: RpcCtx): Promise<{ keys: PublicKey[] }> {
    await this.assertHop('getPublicKeys', [], ctx);
    const env = this.ready();
    const key = await this.signingKey();
    if (!key || !env.CORE_SIGNING_PUBLIC_KEY) return { keys: [] };
    return { keys: [{ kid: key.kid, alg: 'EdDSA', public_key: env.CORE_SIGNING_PUBLIC_KEY, service: 'core', not_after: null }] };
  }

  /**
   * Is this session live, and whose? The one method Studio is allowlisted for
   * besides `redeemHandoff` — deliberately NOT `resolveSession`, which mints a
   * signed principal and would be an oracle in a service that only needs to
   * know whether the person is still signed in.
   */
  async introspect(sidHash: string, ctx?: RpcCtx): Promise<{ active: boolean; user?: UserDisplay }> {
    await this.assertHop('introspect', [sidHash], ctx);
    const env = this.ready();
    const row = await env.DB.prepare(
      `SELECT s.expires_at AS expires_at, ${DISPLAY_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')}
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
    )
      .bind(sidHash)
      .first<UserDisplay & { expires_at: string }>();
    if (!row) return { active: false };
    if (!(Date.parse(row.expires_at) > Date.now())) return { active: false };
    const { expires_at: _expires, ...user } = row;
    return { active: true, user };
  }

  /**
   * The core consumes no events yet: Identity's `SubscriptionChanged` consumer
   * — the writer of the `users.membership_tier` copy — is added in Phase 6b,
   * the slice that removes the write-on-read in `lib/entitlements.ts`. Until
   * then this answers honestly rather than silently acknowledging, so nothing
   * can believe a projection is being maintained when it is not.
   */
  async deliver(batch: EventEnvelope[]): Promise<DeliverResult> {
    return {
      results: (batch ?? []).map((e) => ({
        event_id: e.event_id,
        result: 'invalid' as const,
        error: 'the core subscribes to no events before Phase 6b',
      })),
    };
  }

  private async signingKey() {
    const env = this.env;
    if (!env.CORE_SIGNING_KEY || !env.CORE_SIGNING_PUBLIC_KEY) return null;
    try {
      return await importSigningKey(env.CORE_SIGNING_KEY, env.CORE_SIGNING_PUBLIC_KEY);
    } catch {
      return null;
    }
  }
}

/**
 * Compile-time proof that what is implemented matches the contract exactly —
 * a signature that drifts from `packages/contracts` fails `npm run check`,
 * not a dark deploy. The methods NOT listed here (`setRole`) belong to later
 * phases and are named in `CONTRACT.md`.
 */
type ImplementedIdentity = Pick<
  IdentityApi,
  'resolveSession' | 'lookupUsers' | 'lookupContacts' | 'contactFor' | 'rateLimitHit' | 'revoke' | 'getPublicKeys' | 'introspect' | 'deliver'
>;
export const _identityContract: (e: IdentityEntrypoint) => ImplementedIdentity = (e) => e;
