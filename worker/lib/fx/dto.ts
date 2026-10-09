/**
 * THE OWNER'S RATES ANSWERS, FIELD BY FIELD (FX programme plan §8, §4.5).
 *
 * `GET /api/admin/pricing/rates` and the history are built here and nowhere
 * else, key by key from explicit column lists — never `SELECT *` from a 0179
 * table — so a column a later migration adds cannot reach an answer unseen.
 * Every money or rate key is in FINANCIAL_FIELDS (both copies); the generic
 * keys are registered in tests/financialFieldsUnion.test.ts. The router door
 * (requireCostRead) answers the verified owner only; every answer is
 * `private, no-store`.
 *
 * `key_configured` is a boolean, never the key. `effective_rates_iqd` is the
 * name of the derived rates — `effective_iqd` is a staff-wage name elsewhere
 * (critique F14c).
 */
import { changePctText } from '@levonis/pricing/fxChain';
import { nextCheckAt, PROVIDER_DAY_CAP } from './schedule';
import { FX_PAIRS, type FxPairId, type FxPairRow } from './pairs';
import { FX_REFRESH_GLOBAL_LIMIT } from './limits';

export interface FxLogRow {
  id: string;
  pair: FxPairId;
  event: string;
  trigger_kind: string;
  provider: string | null;
  market_rate: string | null;
  effective_before: string | null;
  effective_after: string | null;
  pending_rate: string | null;
  change_ppm: number | null;
  published_at: string | null;
  result: string;
  error_code: string | null;
  repriced_products: number | null;
  created_at: string;
}

export const LOG_COLUMNS =
  'id, pair, event, trigger_kind, provider, market_rate, effective_before, effective_after, pending_rate, change_ppm, published_at, result, error_code, repriced_products, created_at';

const ATTRIBUTION: Readonly<Record<'iqwealth' | 'ecb', { text: string; url: string }>> = {
  iqwealth: { text: 'IQWealth', url: 'https://iraqsm.com' },
  ecb: { text: 'ECB reference rates', url: 'https://www.ecb.europa.eu' },
};

export function historyItemDto(r: FxLogRow) {
  return {
    id: r.id,
    pair: r.pair,
    event: r.event,
    trigger_kind: r.trigger_kind,
    provider: r.provider,
    market_rate: r.market_rate,
    effective_before: r.effective_before,
    effective_after: r.effective_after,
    pending_rate: r.pending_rate,
    change_ppm: r.change_ppm,
    published_at: r.published_at,
    result: r.result,
    error_code: r.error_code,
    repriced_products: r.repriced_products,
    created_at: r.created_at,
  };
}

function pairDto(r: FxPairRow, observed: FxLogRow | undefined, now: Date) {
  const usd = r.pair === 'USD_IQD';
  return {
    pair: r.pair,
    provider: r.provider,
    attribution: ATTRIBUTION[r.provider],
    mode: r.mode,
    interval_hours: usd ? r.interval_hours : 24,
    market_rate: r.market_rate,
    market_buy: usd ? r.market_buy : null,
    official_rate: usd ? r.official_rate : null,
    adjustment_iqd_per_usd: usd ? r.adjustment : null,
    manual_rate: r.manual_rate,
    effective_rate: r.effective_rate,
    effective_version: r.effective_version,
    effective_source: r.effective_source,
    effective_applied_at: r.effective_applied_at,
    last_known_good_rate: r.last_known_good_rate,
    drift_anchor_rate: r.drift_anchor_rate,
    drift_anchor_at: r.drift_anchor_at,
    published_at: r.published_at,
    last_checked_at: r.last_checked_at,
    last_check_result: r.last_check_result,
    last_successful_at: r.last_successful_at,
    status: r.status,
    fetch_status: r.fetch_status,
    last_error_code: r.last_error_code,
    failing_since: r.failing_since,
    pending:
      r.pending_effective_rate === null
        ? null
        : {
            market_rate: r.pending_market_rate,
            effective_rate: r.pending_effective_rate,
            published_at: r.pending_published_at,
            observed_at: r.pending_observed_at,
            reason: r.pending_reason,
            change_pct: r.effective_rate === null ? null : changePctText(r.effective_rate, r.pending_effective_rate),
          },
    // The plan's `{rate, at}` under the net's name: a rate under a generic key
    // would pass the FINANCIAL_FIELDS strip (naming contract C17).
    rejected: r.rejected_rate === null ? null : { rejected_rate: r.rejected_rate, rejected_at: r.rejected_at },
    // L14: while MANUAL, what a refresh observed — offered as «استخدم … سعرًا يدويًا».
    last_observed:
      r.mode === 'MANUAL' && observed && observed.pending_rate !== null
        ? { market_rate: observed.market_rate, candidate: observed.pending_rate, observed_at: observed.created_at }
        : null,
    anomaly_threshold_pct: r.anomaly_threshold_pct,
    drift_threshold_pct: r.drift_threshold_pct,
    min_change_pct: r.min_change_pct,
    bound_min: r.bound_min,
    bound_max: r.bound_max,
    next_check_at: nextCheckAt(r, now),
    owner_version: r.owner_version,
  };
}

export interface RatesReadModel {
  pairs: FxPairRow[];
  observed: Map<FxPairId, FxLogRow>;
  derived: { currency: 'USD' | 'EUR' | 'CNY'; rate_iqd: string | null; version: number; updated_at: string | null }[];
  shipping: { profile: string; basis: string; rate_iqd: string | null; version: number; updated_at: string | null }[];
  procurementShipping: Record<string, string | null>;
  refreshUsedToday: number;
  engineProducts: number;
}

export function ratesDto(keyConfigured: boolean, m: RatesReadModel, now: Date) {
  const usd = m.pairs.find((p) => p.pair === 'USD_IQD');
  const day = now.toISOString().slice(0, 10);
  const effective_rates_iqd: Record<string, { rate_iqd: string | null; version: number; updated_at: string | null }> = {};
  for (const d of m.derived) effective_rates_iqd[d.currency] = { rate_iqd: d.rate_iqd, version: d.version, updated_at: d.updated_at };
  return {
    success: true as const,
    pairs: FX_PAIRS.map((p) => m.pairs.find((r) => r.pair === p)).filter((r): r is FxPairRow => !!r).map((r) => pairDto(r, m.observed.get(r.pair), now)),
    effective_rates_iqd,
    shipping: m.shipping.map((s) => ({
      profile: s.profile,
      basis: s.basis,
      rate_iqd: s.rate_iqd,
      version: s.version,
      updated_at: s.updated_at,
      procurement_suggestion: m.procurementShipping[s.profile] ?? null,
    })),
    key_configured: keyConfigured,
    refresh_budget: { used_today: m.refreshUsedToday, limit: FX_REFRESH_GLOBAL_LIMIT },
    provider_budget: {
      USD_IQD: {
        used_today: usd && usd.provider_calls_day === day ? usd.provider_calls_count : 0,
        cap: PROVIDER_DAY_CAP.iqwealth.total,
      },
    },
    engine_products: m.engineProducts,
    // FX-5 (repricing) fills these; FX-1 prices nothing.
    reprice_blocked: 0,
    stale_products: 0,
  };
}
