/**
 * The bindings and vars `levonis-analytics` runs on. Every binding except `DB`
 * is optional: the service must start, ingest and answer health with nothing
 * else present, which is what makes the dark deploy and the local rig possible
 * before Identity, the gateway or any secret exists.
 */
import type { PublicKey } from '@levonis/contracts/rpc/identity';
import type { RpcCtx } from '@levonis/contracts/rpc/common';

/** The one method Analytics calls on anybody (`OWNERSHIP.json` `calls`). */
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
  ANALYTICS_RETENTION_DAYS?: string;
  ANALYTICS_ROLLUP_DAYS?: string;
  ANALYTICS_ROLLUP_MAX_ROWS?: string;
  SVC_VERSION?: string;

  /** Secrets — names only in the repository (`SECRETS.md`). */
  ANALYTICS_HASH_SALT?: string;
  ANALYTICS_SIGNING_KEY?: string;
  HEALTH_PROBE_TOKEN?: string;
}

export const SERVICE = 'analytics' as const;

export const versionOf = (env: Env): string => env.SVC_VERSION || 'dev';

export const onOff = (v: string | undefined): boolean => v === 'on' || v === 'true' || v === '1';

/** A positive integer var with a floor and a ceiling, so a typo cannot blow the D1 budget. */
export function intVar(v: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export const retentionDays = (env: Env): number => intVar(env.ANALYTICS_RETENTION_DAYS, 30, 400);
export const rollupDays = (env: Env): number => intVar(env.ANALYTICS_ROLLUP_DAYS, 2, 14);
export const rollupMaxRows = (env: Env): number => intVar(env.ANALYTICS_ROLLUP_MAX_ROWS, 20_000, 100_000);
