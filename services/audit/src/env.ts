/**
 * The bindings and vars `levonis-audit` runs on, and the small readers that
 * turn them into behaviour. Every binding except `DB` is optional: the service
 * must start, ingest and answer health with nothing else present — that is what
 * makes the dark deploy (and the local rig) possible before Identity, the
 * gateway or any secret exists.
 */
import type { PublicKey } from '@levonis/contracts/rpc/identity';
import type { RpcCtx } from '@levonis/contracts/rpc/common';

/** The one method Audit calls on anybody (`OWNERSHIP.json` `calls`). */
export interface IdentityKeysBinding {
  getPublicKeys(ctx: RpcCtx): Promise<{ keys: PublicKey[] }>;
}

export interface Env {
  DB: D1Database;
  IDENTITY?: IdentityKeysBinding;

  /** `service:kid:publicKey,…` — the bootstrap producer key list. */
  ALLOWED_CALLER_KIDS?: string;
  /** off | log | on — inbound gateway-hop enforcement. */
  GATEWAY_ONLY?: string;
  /** on | off — dark/local only: accept the committed fixtures' `sig` marker. */
  ACCEPT_FIXTURE_SIG?: string;
  AUDIT_SEAL_BATCH?: string;
  AUDIT_VERIFY_PAGE?: string;
  /**
   * The ceiling on how many chain links ONE verification request recomputes.
   * `verifyChain` reports a truncated prefix honestly, so a bound costs
   * accuracy about the tail, never correctness — and without one a single
   * repeatable admin request recomputes up to 50 000 HMACs and issues 100 D1
   * page queries inside one invocation.
   */
  AUDIT_VERIFY_MAX_ROWS?: string;
  SVC_VERSION?: string;

  /** Secrets — names only in the repository (`SECRETS.md`). */
  AUDIT_CHAIN_KEY?: string;
  AUDIT_SIGNING_KEY?: string;
  HEALTH_PROBE_TOKEN?: string;
}

export const SERVICE = 'audit' as const;

export const versionOf = (env: Env): string => env.SVC_VERSION || 'dev';

export const onOff = (v: string | undefined): boolean => v === 'on' || v === 'true' || v === '1';

/** A positive integer var with a floor and a ceiling, so a typo cannot blow the D1 budget. */
export function intVar(v: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export const sealBatchSize = (env: Env): number => intVar(env.AUDIT_SEAL_BATCH, 200, 500);
export const verifyPageSize = (env: Env): number => intVar(env.AUDIT_VERIFY_PAGE, 500, 1000);
export const verifyMaxRows = (env: Env): number => intVar(env.AUDIT_VERIFY_MAX_ROWS, 5_000, 50_000);
