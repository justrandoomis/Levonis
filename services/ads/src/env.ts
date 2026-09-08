/**
 * `levonis-ads` bindings, vars and secret NAMES.
 *
 * Every provider credential is optional and every one of them is read in
 * exactly one place — `providers/*.ts` `configured(env)`. Nothing else in this
 * service may look at a secret, and no value ever reaches a log line, a
 * delivery row or an error message.
 */
import type { EdgeEnv } from '@levonis/platform-kit/edge/types';

export interface AdsVars {
  /** the GLOBAL kill switch; fails closed — only the exact string `on` enables delivery */
  ADS_ENABLED?: string;
  /** off | log | on — the inbound gateway-hop check */
  GATEWAY_ONLY?: string;
  /** throw | log — the owned-tables guard (ADR-003) */
  OWNERSHIP_GUARD?: string;
  /** `service:kid:publicKey,…` — producers whose event signatures are verified */
  ALLOWED_CALLER_KIDS?: string;
  /** dark/test only: accept the committed fixtures' `sig: 'fixture'` marker */
  ACCEPT_FIXTURE_SIG?: string;
  /**
   * How long a SETTLED delivery row and its processed-events marker are kept
   * (`03-EVENTS.md` §5 rule 6). Unsettled rows and every DLQ row are never
   * rolled. `ProductViewed` alone writes four delivery rows per page view, so
   * without a roll this table is the service's growth problem.
   */
  ADS_RETENTION_DAYS?: string;
  SVC_VERSION?: string;
}

/**
 * The provider credentials, by NAME. A provider counts as configured only when
 * every name it needs is a non-empty string; otherwise the registry hands the
 * caller the SANDBOX adapter instead (`SECRETS.md`).
 */
export interface AdsSecrets {
  META_CAPI_ACCESS_TOKEN?: string;
  META_CAPI_DATASET_ID?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_ACCESS_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_CONVERSION_ACTION_ID?: string;
  TIKTOK_ADS_ACCESS_TOKEN?: string;
  TIKTOK_ADS_PIXEL_CODE?: string;
  SNAPCHAT_ADS_ACCESS_TOKEN?: string;
  SNAPCHAT_ADS_PIXEL_ID?: string;
  /** this Worker's own Ed25519 key (base64url PKCS#8) */
  ADS_SIGNING_KEY?: string;
  HEALTH_PROBE_TOKEN?: string;
}

export type Env = EdgeEnv &
  AdsVars &
  AdsSecrets & {
    /** the service's OWN database — never the shared core D1 */
    DB: D1Database;
  };

export const versionOf = (env: AdsVars): string => (env.SVC_VERSION || '').trim() || 'dev';

/** True when the var is exactly `on`. An unset, misspelt or empty var is never "on". */
export const isOn = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'on';

/** The retention window in days: a positive integer, defaulting to 30, capped at 400. */
export const retentionDays = (env: AdsVars): number => {
  const n = Number.parseInt((env.ADS_RETENTION_DAYS ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 400) : 30;
};

/** A secret counts as present only when it is a non-empty string after trimming. */
export const has = (v: string | undefined): boolean => typeof v === 'string' && v.trim().length > 0;
