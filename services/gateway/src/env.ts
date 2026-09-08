/**
 * The gateway's bindings and vars.
 *
 * EVERY binding is optional. The gateway is deployed dark long before the
 * Workers it will one day route to exist, and a prefix whose owner is not
 * bound must fall back to the strangler default (`CORE`) rather than throw —
 * that is what makes "flip a phase" a var change instead of a deploy order.
 * `src/routes.ts` resolves the target; `src/pipeline.ts` degrades to CORE when
 * the resolved binding is absent, and refuses only when CORE itself is missing.
 */
import type { RouteTarget } from '@levonis/contracts/http/gateway';
import type { RateLimitBinding, RateLimitRpc } from '@levonis/platform-kit/ratelimit';
import type { PublicKey, ResolveSessionInput, ResolveSessionResult } from '@levonis/contracts/rpc/identity';
import type { RpcCtx } from '@levonis/contracts/rpc/common';
import type { EdgeEnv } from '@levonis/platform-kit/edge/types';

/** What the gateway needs from a downstream Worker: an HTTP forward, and (later) health. */
export interface ForwardTarget {
  fetch(request: Request): Promise<Response>;
  health?(ctx?: RpcCtx): Promise<unknown>;
}

/**
 * Identity as the gateway may use it: session resolution, revocation, the
 * public keys it verifies principals with, and the cross-isolate rate counter.
 *
 * Deliberately NOT the full `IdentityApi` — `lookupContacts`, `lookupUsers`
 * and `setRole` are not on this type, so no gateway code can call them even by
 * accident, and `tests/leastPrivilege.test.ts` pins the same four methods from
 * the manifest side (ADR-015).
 *
 * `ctx` is optional here and required in the contract: the gateway attaches a
 * signed hop when it holds a signing key, and calls without one when it does
 * not (the same shape the kit's `RateLimitRpc` already uses). `src/identity.ts`
 * is the only place that decides which of the two happens.
 */
export interface IdentityGatewayApi extends RateLimitRpc {
  resolveSession(input: ResolveSessionInput, ctx?: RpcCtx): Promise<ResolveSessionResult>;
  revoke(sidHash: string, ctx?: RpcCtx): Promise<{ revoked: boolean }>;
  getPublicKeys(ctx?: RpcCtx): Promise<{ keys: PublicKey[] }>;
}

export interface GatewayVars {
  /** the strangler phase: a prefix flips to its owner when this reaches its `flipPhase` */
  GATEWAY_PHASE?: string;
  /** `on` until G3: everything without a valid health-probe token gets 403 */
  GATEWAY_LOCKED?: string;
  /** `"<prefix>=<TARGET>,…"` — the kill switch */
  ROUTE_OVERRIDES?: string;
  /** off | shadow | on */
  PRINCIPAL_MODE?: string;
  PRINCIPAL_SHADOW_RATE?: string;
  /** on | off */
  CACHE_MODE?: string;
  /** `memory` is dark/local only (ADR-016) */
  RATE_LIMIT_MODE?: string;
  /** `"ip,public-read"` — promotes a shadow class to enforcement without a deploy */
  RATE_LIMIT_ENFORCE?: string;
  TURNSTILE_SITEKEY?: string;
  APP_ORIGIN?: string;
  STORE_ROOT_DOMAIN?: string;
  EXTRA_ALLOWED_ORIGINS?: string;
  SVC_VERSION?: string;
  /** `service:kid:publicKeyB64,…` — how the gateway learns Identity's key before `service_keys` exists */
  ALLOWED_CALLER_KIDS?: string;
}

export interface GatewaySecrets {
  /** base64url PKCS#8 Ed25519 private key; absent = no hop envelope is signed */
  GATEWAY_SIGNING_KEY?: string;
  /** base64url raw public key of the pair above, so the callee can be told which kid to expect */
  GATEWAY_SIGNING_PUBLIC_KEY?: string;
  /** absent = Turnstile is off everywhere */
  TURNSTILE_SECRET?: string;
  HEALTH_PROBE_TOKEN?: string;
}

export type ServiceBindings = Partial<Record<Exclude<RouteTarget, 'GATEWAY'>, ForwardTarget>> & {
  IDENTITY?: IdentityGatewayApi & ForwardTarget;
};

export type Env = EdgeEnv &
  GatewayVars &
  GatewaySecrets &
  ServiceBindings & {
    /** per-colo first-layer limiters; absent classes are simply not limited by that layer */
    RL_IP?: RateLimitBinding;
    RL_PUBLIC_READ?: RateLimitBinding;
  };

export const versionOf = (env: Env): string => (env.SVC_VERSION || '').trim() || 'dev';

/** True when the var is exactly `on` (an unset or misspelt var is never "on"). */
export const isOn = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'on';
