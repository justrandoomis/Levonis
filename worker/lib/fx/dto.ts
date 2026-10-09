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
import { changePctText, sameRate, usdIqdCandidate } from '@levonis/pricing/fxChain';
import { nextCheckAt, PROVIDER_DAY_CAP } from './schedule';
import { FX_PAIRS, type FxPairId, type FxPairRow } from './pairs';
import { FX_REFRESH_GLOBAL_LIMIT } from './limits';
import { REJECT_MEMORY_MS } from './decide';

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
  market_adjustment_iqd: string | null;
  settings_diff: string | null;
}

export const LOG_COLUMNS =
  'id, pair, event, trigger_kind, provider, market_rate, effective_before, effective_after, pending_rate, change_ppm, published_at, result, error_code, repriced_products, created_at, market_adjustment_iqd, settings_diff';

/** One `{field, before, after}` of a settings_change row, as the owner's history reads it. */
export interface SettingsDiffItem {
  field: string;
  before: string;
  after: string;
}

/**
 * The stored diff as a list — every entry three strings, nothing else — or
 * null. The column's CHECK holds a JSON array; anything else read here is
 * dropped rather than served (the history never fails on one bad row).
 */
export function settingsDiffOf(text: string | null): SettingsDiffItem[] | null {
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return null;
    const out: SettingsDiffItem[] = [];
    for (const e of raw) {
      if (e && typeof e === 'object' && typeof e.field === 'string' && typeof e.before === 'string' && typeof e.after === 'string') {
        out.push({ field: e.field, before: e.before, after: e.after });
      }
    }
    return out;
  } catch {
    return null;
  }
}

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
    market_adjustment_iqd: r.pair === 'USD_IQD' ? r.market_adjustment_iqd : null,
    settings_diff: settingsDiffOf(r.settings_diff),
  };
}

/** USD/IQD in AUTO, and effective = market sell + market_adjustment_iqd exactly. */
function formulaHolds(r: FxPairRow): boolean {
  if (r.mode !== 'AUTO' || r.market_rate === null || r.effective_rate === null) return false;
  try {
    return sameRate(usdIqdCandidate(r.market_rate, r.market_adjustment_iqd), r.effective_rate);
  } catch {
    return false;
  }
}

/** The rejection memory of decide() step 8 still holds (24 hours). */
function rejectionActive(r: Pick<FxPairRow, 'rejected_rate' | 'rejected_at'>, now: Date): boolean {
  if (r.rejected_rate === null || r.rejected_at === null) return false;
  const at = Date.parse(r.rejected_at);
  return Number.isFinite(at) && now.getTime() - at < REJECT_MEMORY_MS;
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
    market_adjustment_iqd: usd ? r.market_adjustment_iqd : null,
    // «سعر السوق + الزيادة = السعر المعتمد» is shown only when it is TRUE of
    // the figures on the card (owner decision 5): AUTO, and the effective rate
    // is exactly the last validated market sell plus the adjustment. A move
    // inside the dead band, a held value or a manual rate makes it false, and
    // the panel then shows no sum rather than a wrong one. A flag, no figure:
    // the client never computes a rate.
    formula_holds: usd && formulaHolds(r),
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
    // would pass the FINANCIAL_FIELDS strip (naming contract C17). Only while
    // the memory holds (24 hours): the row keeps the last rejection for ever,
    // and the panel said «won't be offered again for 24 hours» for ever
    // (FX-1 correctness review #9).
    rejected: rejectionActive(r, now) ? { rejected_rate: r.rejected_rate!, rejected_at: r.rejected_at } : null,
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
  /** FX-5: engine products whose stored price waits for a repricing — a count. */
  staleProducts?: number;
  /** FX-5: engine products the automatic repricing could not reach — a count. */
  repriceBlocked?: number;
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
    // FX-5: the automatic repricing's counts (the status line itself is on GET /save-list).
    reprice_blocked: m.repriceBlocked ?? 0,
    stale_products: m.staleProducts ?? 0,
  };
}
