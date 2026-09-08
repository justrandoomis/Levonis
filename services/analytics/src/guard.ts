/**
 * The inbound hop assertion for Analytics' RPC methods (`01-TARGET.md` §4
 * item 3, the same contract the core's `worker/entrypoints/base.ts`
 * implements).
 *
 * A service binding is account-level trust: any Worker on the account could
 * call `merchantDaily()`. The signed hop is what says WHICH one did and WHAT it
 * asked for — and since a merchant's numbers are a merchant's business, the
 * read methods are allowlisted rather than open.
 *
 * Mode, exactly as the core's: `on` as soon as any caller key is registered
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
 * Who may call what. Analytics writes nothing on request — its only input is
 * the bus — so every method here is a read: the platform overview goes to the
 * Admin BFF and Support, a merchant series additionally to Marketplace, which
 * is the Worker that serves a merchant its own dashboard.
 */
export const ANALYTICS_METHOD_CALLERS: MethodAllowlist = {
  'AnalyticsEntrypoint.overview': ['admin', 'support'],
  'AnalyticsEntrypoint.daily': ['admin', 'support'],
  'AnalyticsEntrypoint.merchantDaily': ['admin', 'support', 'marketplace'],
};

const nonces = new NonceSet();

export function hopMode(env: Env): HopMode {
  const explicit = (env as unknown as { ENTRYPOINT_HOP?: string }).ENTRYPOINT_HOP;
  if (explicit) return modeVar(explicit, HOP_MODES, 'off') as HopMode;
  return (env.ALLOWED_CALLER_KIDS ?? '').trim() ? 'on' : 'off';
}

/**
 * Verifies the caller's hop for THIS method and THESE arguments and returns
 * the VERIFIED issuer, or `null` — when the assertion is `off` (dark, local,
 * any deployment with no registered callers), or when it is in `log` mode and
 * the hop did not verify. An unverified claim is not an identity.
 */
export async function assertCaller(env: Env, method: string, args: unknown, ctx?: RpcCtx | { hop?: RpcCtx['hop'] }): Promise<string | null> {
  const mode = hopMode(env);
  if (mode === 'off') return null;
  const qualified = `AnalyticsEntrypoint.${method}`;
  const hop = (ctx as { hop?: RpcCtx['hop'] } | undefined)?.hop;
  let reason = 'MISSING_HOP';
  if (hop) {
    const v = await verifyHop({
      hop,
      method: qualified,
      args,
      principalHeader: (ctx as RpcCtx | undefined)?.principal ?? null,
      allowedIssuers: allowedIssuersFor(ANALYTICS_METHOD_CALLERS, qualified),
      ring: await producerKeys(env),
      nonces,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (v.ok) return hop.iss;
    reason = v.reason;
  }
  console.warn(`analytics: hop refused (${mode})`, qualified, reason);
  if (mode === 'on') throw forbidden(`Refused: ${reason}`, 'FORBIDDEN');
  // `log` MEANS "COUNT IT, DO NOT ENFORCE" — never "believe it". Returning the
  // envelope's own `iss` here would hand an unverified, unsigned claim of
  // identity to the caller as though it had been checked, and during the
  // documented `off -> log -> on` rollout that is a window in which anyone can
  // act in another service's name. Only `v.ok` above may produce an issuer.
  return null;
}
