/**
 * THE THREE SOURCE PAIRS (FX programme plan §4.1, migration 0179) — their
 * vocabulary and the one read of their rows.
 *
 *   USD_IQD  IQD per 1 USD  (Iraqi parallel market via IQWealth, plus the owner's adjustment)
 *   EUR_USD  USD per 1 EUR  (ECB daily reference)
 *   CNY_USD  USD per 1 CNY  (ECB USD ÷ ECB CNY)
 *
 * PRIVATE. Every column here is the owner's (DECISIONS row 189); the one
 * public figure is the effective USD/IQD, read by `displayRate.ts` from
 * `pricing_fx_rates`, never from here. Rows are read by an explicit column
 * list — never `SELECT *` — so a column a later migration adds cannot reach a
 * DTO unseen (plan §4.5).
 */

export type FxPairId = 'USD_IQD' | 'EUR_USD' | 'CNY_USD';
export const FX_PAIRS: readonly FxPairId[] = ['USD_IQD', 'EUR_USD', 'CNY_USD'];
export const isFxPair = (v: unknown): v is FxPairId => typeof v === 'string' && (FX_PAIRS as readonly string[]).includes(v);

export type FxProvider = 'iqwealth' | 'ecb';
export type FxMode = 'AUTO' | 'MANUAL';
export type FxFetchStatus = 'OK' | 'FAILED' | 'STALE' | 'NOT_CONFIGURED';
export type FxStatus = FxFetchStatus | 'REVIEW_REQUIRED';
export type FxCheckResult =
  | 'APPLIED'
  | 'UNCHANGED'
  | 'REVIEW_HELD'
  | 'DEFERRED'
  | 'SUPERSEDED'
  | 'FAILED'
  | 'STALE'
  | 'INVALID'
  | 'NOT_CONFIGURED'
  | 'OBSERVED';
export type FxPendingReason = 'FIRST_VALUE' | 'ANOMALY' | 'ANOMALY_24H' | 'DRIFT' | 'BACK_TO_AUTO';
export type FxEffectiveSource = 'provider' | 'manual' | 'review_approved';
export type FxLogEvent =
  | 'check'
  | 'apply'
  | 'review_held'
  | 'review_approved'
  | 'review_rejected'
  | 'review_cleared'
  | 'review_expired'
  | 'manual_set'
  | 'mode_change'
  | 'settings_change'
  | 'failure'
  | 'observed'
  | 'deferred'
  | 'superseded'
  | 'commit_refused'
  | 'anchor_confirmed';
export type FxTriggerKind = 'cron' | 'refresh' | 'owner' | 'back_to_auto';

/** The source currency each pair converts, and the currency of `pricing_fx_rates` it feeds. */
export const PAIR_CURRENCY: Readonly<Record<FxPairId, 'USD' | 'EUR' | 'CNY'>> = { USD_IQD: 'USD', EUR_USD: 'EUR', CNY_USD: 'CNY' };

/** One `fx_rate_pairs` row, as read. Decimals are canonical TEXT. */
export interface FxPairRow {
  pair: FxPairId;
  provider: FxProvider;
  mode: FxMode;
  interval_hours: number;
  market_rate: string | null;
  market_buy: string | null;
  official_rate: string | null;
  source_usd_per_eur: string | null;
  source_cny_per_eur: string | null;
  adjustment: string;
  manual_rate: string | null;
  effective_rate: string | null;
  effective_version: number;
  effective_source: FxEffectiveSource | null;
  effective_applied_at: string | null;
  effective_applied_by: string | null;
  last_known_good_rate: string | null;
  last_known_good_at: string | null;
  drift_anchor_rate: string | null;
  drift_anchor_at: string | null;
  published_at: string | null;
  last_checked_at: string | null;
  last_check_result: FxCheckResult | null;
  last_successful_at: string | null;
  last_cron_success_at: string | null;
  fetch_status: FxFetchStatus;
  status: FxStatus;
  last_error_code: string | null;
  failing_since: string | null;
  pending_market_rate: string | null;
  pending_effective_rate: string | null;
  pending_published_at: string | null;
  pending_observed_at: string | null;
  pending_reason: FxPendingReason | null;
  pending_notified_at: string | null;
  rejected_rate: string | null;
  rejected_at: string | null;
  anomaly_threshold_pct: string;
  drift_threshold_pct: string;
  min_change_pct: string;
  bound_min: string;
  bound_max: string;
  max_age_hours: number;
  provider_calls_day: string | null;
  provider_calls_count: number;
  lease_token: string | null;
  lease_until: string | null;
  version: number;
  owner_version: number;
  updated_by: string | null;
  updated_at: string;
}

/** Every column of `fx_rate_pairs`, by name — the explicit list every read uses. */
export const PAIR_COLUMNS = [
  'pair', 'provider', 'mode', 'interval_hours', 'market_rate', 'market_buy', 'official_rate', 'source_usd_per_eur',
  'source_cny_per_eur', 'adjustment', 'manual_rate', 'effective_rate', 'effective_version', 'effective_source',
  'effective_applied_at', 'effective_applied_by', 'last_known_good_rate', 'last_known_good_at', 'drift_anchor_rate',
  'drift_anchor_at', 'published_at', 'last_checked_at', 'last_check_result', 'last_successful_at', 'last_cron_success_at',
  'fetch_status', 'status', 'last_error_code', 'failing_since', 'pending_market_rate', 'pending_effective_rate',
  'pending_published_at', 'pending_observed_at', 'pending_reason', 'pending_notified_at', 'rejected_rate', 'rejected_at',
  'anomaly_threshold_pct', 'drift_threshold_pct', 'min_change_pct', 'bound_min', 'bound_max', 'max_age_hours',
  'provider_calls_day', 'provider_calls_count', 'lease_token', 'lease_until', 'version', 'owner_version', 'updated_by',
  'updated_at',
] as const satisfies readonly (keyof FxPairRow)[];

export const PAIR_SELECT = `SELECT ${PAIR_COLUMNS.join(', ')} FROM fx_rate_pairs`;

/** A missing table (a database the 0179 migration has not reached) — the only error a read tolerates. */
export const isMissingTable = (e: unknown): boolean => /no such table/i.test(e instanceof Error ? e.message : String(e));

const order = (p: FxPairId) => FX_PAIRS.indexOf(p);

/** The three pairs in plan order, or null on a database without 0179. Any other failure throws. */
export async function loadPairs(db: D1Database): Promise<FxPairRow[] | null> {
  try {
    const { results } = await db.prepare(PAIR_SELECT).all<FxPairRow>();
    return (results ?? []).map((r) => ({ ...r })).sort((a, b) => order(a.pair) - order(b.pair));
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
}

/** One pair, or null on a database without 0179. */
export async function loadPair(db: D1Database, pair: FxPairId): Promise<FxPairRow | null> {
  try {
    const row = await db.prepare(`${PAIR_SELECT} WHERE pair = ?`).bind(pair).first<FxPairRow>();
    return row ? { ...row } : null;
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
}

/** The status the derived-status CHECK demands (critique H1). */
export const derivedStatus = (pendingEffective: string | null, fetchStatus: FxFetchStatus): FxStatus =>
  pendingEffective !== null ? 'REVIEW_REQUIRED' : fetchStatus;

/** `new Date(ms).toISOString()` — the only time shape stored (TS24). */
export const iso = (d: Date | number): string => new Date(typeof d === 'number' ? d : d.getTime()).toISOString();
export const HOUR_MS = 3_600_000;
