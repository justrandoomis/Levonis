/**
 * The inbound hop assertion for Audit's RPC methods (`01-TARGET.md` §4 item 3,
 * the same contract the core's `worker/entrypoints/base.ts` implements).
 *
 * A service binding is account-level trust: any Worker on the account could
 * call `record()`. The signed hop is what says WHICH one did and WHAT it asked
 * for, and for an audit log it does one thing more — it is the only source of
 * `source_service`, so a compromised Worker cannot write the log in another
 * service's name.
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
 * Who may call what. `record` is open to every service — auditing is a duty,
 * not a privilege, and the hop still fixes the name it is recorded under. The
 * READS are not: `query` and `verifyChain` return other people's privileged
 * actions, so only the Admin BFF and Support may ask, and an admin reaching
 * them over HTTP is checked again against a full-scope principal (`http.ts`).
 */
export const AUDIT_METHOD_CALLERS: MethodAllowlist = {
  'AuditEntrypoint.record': ['*'],
  'AuditEntrypoint.query': ['admin', 'support'],
  'AuditEntrypoint.verifyChain': ['admin'],
};

const nonces = new NonceSet();

export function hopMode(env: Env): HopMode {
  const explicit = (env as unknown as { ENTRYPOINT_HOP?: string }).ENTRYPOINT_HOP;
  if (explicit) return modeVar(explicit, HOP_MODES, 'off') as HopMode;
  return (env.ALLOWED_CALLER_KIDS ?? '').trim() ? 'on' : 'off';
}

/**
 * Verifies the caller's hop for THIS method and THESE arguments and returns
 * the VERIFIED issuer, or `null`.
 *
 * `null` in two cases, and they mean the same thing: the assertion is `off`
 * (dark, local, any deployment with no registered callers), or it is in `log`
 * mode and the hop did not verify. Neither is an identity, which is what tells
 * `record()` to fall back to the argument's `source_service` — an honest
 * caller claim rather than one dressed up as a verified hop.
 */
export async function assertCaller(env: Env, method: string, args: unknown, ctx?: RpcCtx | { hop?: RpcCtx['hop'] }): Promise<string | null> {
  const mode = hopMode(env);
  if (mode === 'off') return null;
  const qualified = `AuditEntrypoint.${method}`;
  const hop = (ctx as { hop?: RpcCtx['hop'] } | undefined)?.hop;
  let reason = 'MISSING_HOP';
  if (hop) {
    const v = await verifyHop({
      hop,
      method: qualified,
      args,
      principalHeader: (ctx as RpcCtx | undefined)?.principal ?? null,
      allowedIssuers: allowedIssuersFor(AUDIT_METHOD_CALLERS, qualified),
      ring: await producerKeys(env),
      nonces,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (v.ok) return hop.iss;
    reason = v.reason;
  }
  console.warn(`audit: hop refused (${mode})`, qualified, reason);
  if (mode === 'on') throw forbidden(`Refused: ${reason}`, 'FORBIDDEN');
  // `log` MEANS "COUNT IT, DO NOT ENFORCE" — never "believe it". Returning the
  // envelope's own `iss` here would hand an unverified, unsigned claim of
  // identity to the caller as though it had been checked, and during the
  // documented `off -> log -> on` rollout that is a window in which anyone can
  // act in another service's name. Only `v.ok` above may produce an issuer.
  return null;
}
