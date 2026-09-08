/**
 * The one place the gateway talks to Identity.
 *
 * Four methods, and no fifth is reachable from here: `resolveSession`,
 * `revoke`, `getPublicKeys`, `rateLimitHit` (ADR-015). The wrapper exists so
 * that WHETHER a call carries a signed hop envelope is decided once, from the
 * presence of `GATEWAY_SIGNING_KEY`, instead of at every call site:
 *
 *  - with a key: the platform kit's RPC client attaches `{cid, hop}` — signed
 *    over the method name and a hash of the arguments — plus a 3-second
 *    budget, a retry for idempotent methods and a circuit breaker per method.
 *  - without one: the bare binding stub, called without a `ctx`. That is the
 *    Phase-1 state, legal only while every callee runs `GATEWAY_ONLY=off`;
 *    `revoke` is marked non-idempotent so it is never retried blindly.
 *
 * The gateway never forges a hop to look signed. A call with no key is
 * visibly a call with no key.
 */
import { createRpcClient } from '@levonis/platform-kit/rpc';
import type { HopSigner } from '@levonis/platform-kit/hop';
import type { Env, IdentityGatewayApi } from './env';

export const IDENTITY_ENTRYPOINT = 'IdentityEntrypoint';
/** The exact method set the gateway may reach — mirrored by OWNERSHIP.json `calls`. */
export const IDENTITY_METHODS: readonly string[] = ['resolveSession', 'revoke', 'getPublicKeys', 'rateLimitHit'];

export function identityClient(env: Env, signer: HopSigner | null, cid: string): IdentityGatewayApi | undefined {
  const stub = env.IDENTITY;
  if (!stub) return undefined;
  if (!signer) return stub;
  return createRpcClient<IdentityGatewayApi>(stub, {
    service: 'identity',
    entrypoint: IDENTITY_ENTRYPOINT,
    signer,
    cid,
    nonIdempotent: ['revoke'],
  }) as unknown as IdentityGatewayApi;
}
