/**
 * The inbound hop assertion for Notifications' RPC methods (`01-TARGET.md` §4
 * item 3, the same contract `worker/entrypoints/base.ts`,
 * `services/audit/src/guard.ts` and `services/analytics/src/guard.ts`
 * implement).
 *
 * WHY THIS SERVICE NEEDS IT MOST. A service binding is account-level trust:
 * any Worker on the account can call `send()`. `send()` writes `notify_outbox`
 * rows straight from the caller's own `params.to` / `params.chat_id` and then
 * pumps them, so an unguarded `send()` is an open relay holding the platform's
 * mail credential and its bot token — the one RPC on the platform whose abuse
 * reaches a real person's inbox in the platform's name. The signed hop is what
 * says WHICH Worker asked and WHAT it asked for.
 *
 * Mode, exactly as the others': `on` as soon as any caller key is registered
 * (`ALLOWED_CALLER_KIDS`), `off` while none is — a Worker with no registered
 * callers is a Worker nothing is bound to — with an explicit `ENTRYPOINT_HOP`
 * override for both directions. `deliver()` is NOT guarded here: the platform
 * kit's `defineConsumer` already checks the hop issuer against the per-event
 * producer allowlist, which is the stronger check.
 */
import { NonceSet, verifyHop, allowedIssuersFor, type MethodAllowlist } from '@levonis/platform-kit/hop';
import { modeVar } from '@levonis/platform-kit/config';
import { forbidden } from '@levonis/platform-kit/errors';
import type { RpcCtx } from '@levonis/contracts/rpc/common';
import { producerKeys } from './keys';
import type { Env } from './env';

export type HopMode = 'off' | 'log' | 'on';
export const HOP_MODES: readonly HopMode[] = ['off', 'log', 'on'];

/**
 * Who may ask this service to send.
 *
 * The list is the set of Workers that own a reason to message a customer:
 * `core` (the monolith's `enqueue()` forwards here from Phase 4b-i), and the
 * Phase 6–8 deployables that inherit its senders — Commerce for order mail,
 * Marketplace for merchant mail, Subscriptions for renewals, Ledger for
 * deposit and withdrawal decisions, Identity for verification and password
 * mail, and Admin for an operator-initiated message. `*` is deliberately NOT
 * used: unlike `AuditEntrypoint.record`, sending is a privilege, not a duty.
 */
export const NOTIFICATIONS_METHOD_CALLERS: MethodAllowlist = {
  'NotificationsEntrypoint.send': ['core', 'identity', 'commerce', 'marketplace', 'subscriptions', 'ledger', 'admin'],
};

const nonces = new NonceSet();

export function hopMode(env: Env): HopMode {
  const explicit = (env as unknown as { ENTRYPOINT_HOP?: string }).ENTRYPOINT_HOP;
  if (explicit) return modeVar(explicit, HOP_MODES, 'off') as HopMode;
  return (env.ALLOWED_CALLER_KIDS ?? '').trim() ? 'on' : 'off';
}

/**
 * Verifies the caller's hop for THIS method and THESE arguments and returns
 * the VERIFIED issuer — or `null` when the assertion is off (dark, local, and
 * any deployment with no registered callers).
 *
 * In `log` mode the return is `null` as well, never the envelope's own `iss`:
 * `log` means "count it, do not enforce", and an unverified claim of identity
 * is not an identity.
 */
export async function assertCaller(env: Env, method: string, args: unknown, ctx?: RpcCtx | { hop?: RpcCtx['hop'] }): Promise<string | null> {
  const mode = hopMode(env);
  if (mode === 'off') return null;
  const qualified = `NotificationsEntrypoint.${method}`;
  const hop = (ctx as { hop?: RpcCtx['hop'] } | undefined)?.hop;
  let reason = 'MISSING_HOP';
  if (hop) {
    const v = await verifyHop({
      hop,
      method: qualified,
      args,
      principalHeader: (ctx as RpcCtx | undefined)?.principal ?? null,
      allowedIssuers: allowedIssuersFor(NOTIFICATIONS_METHOD_CALLERS, qualified),
      ring: await producerKeys(env),
      nonces,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (v.ok) return hop.iss;
    reason = v.reason;
  }
  console.warn(`notifications: hop refused (${mode})`, qualified, reason);
  if (mode === 'on') throw forbidden(`Refused: ${reason}`, 'FORBIDDEN');
  return null;
}
