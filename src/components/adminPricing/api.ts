/**
 * «التسعير والشحن» P1 — THE OWNER'S PRICING PREVIEW, ITS WIRE (MVP plan §6 P1).
 *
 * The product preview's three calls, all to /api/admin/pricing, all read-only
 * on the server (the rates routes and the stale list follow below):
 *
 *   GET  /overview?page=N            the products, 20 a page, and the §2.3 counts
 *   GET  /products/:id               today's prices per model × channel, the old
 *                                    landed cost, the derived minimum profit and
 *                                    Direct Sale Extra, measures, the rate reference
 *   POST /products/:id/what-if       «كم سيصبح السعر؟» — computed on the SERVER
 *                                    by E1's exact maths; nothing is saved
 *
 * THE BROWSER NEVER PRICES. No price, replacement cost or rounding is computed
 * here: every figure on the screen is a whole-dinar integer or an exact decimal
 * TEXT the server sent. The client only formats them (tests/pricingCostToPrice
 * pins that src/ imports neither costToPrice, ruleResolution nor legacyTargets).
 * Decimals the owner types travel as TEXT, never as a JSON number, because the
 * server refuses a float for a decimal (worker/lib/pricingEngine/whatIf.ts).
 *
 * The router answers the verified owner alone (`requireCostRead`):
 * OWNER_EMAIL_UNVERIFIED for the owner's own unverified session, and
 * COST_ACCESS_DENIED for everyone else — the screen renders both by code.
 */
import { api, type RequestOptions } from '../../lib/api';
import type { PricingMigrationStatus, LegacyValueState } from '../../../packages/contracts/src/pricingMigrationLabels';
import type { EngineAdoption } from '../adminOperations/procurementPricing';

export const PRICING_API = '/api/admin/pricing';

export type PricingRoute = 'air' | 'sea' | 'land';
export type PricingChannel = 'direct_sale' | 'pre_order_air' | 'pre_order_sea' | 'pre_order_land';
export type PricingProfile = 'GERMANY_LAND' | 'CHINA_AIR' | 'CHINA_SEA';
export type PricingCurrency = 'USD' | 'EUR' | 'CNY';
export type PricingSaleMix = 'BOTH' | 'DIRECT_ONLY' | 'PREORDER_ONLY' | 'NOT_SELLABLE';
export type PricingRung = 'base' | 'option' | 'fulfillment' | 'transport' | 'color';

export const PRICING_CURRENCIES: readonly PricingCurrency[] = ['USD', 'EUR', 'CNY'];
export const PRICING_PROFILES: readonly PricingProfile[] = ['GERMANY_LAND', 'CHINA_AIR', 'CHINA_SEA'];
export const PRICING_CHANNELS: readonly PricingChannel[] = ['direct_sale', 'pre_order_air', 'pre_order_sea', 'pre_order_land'];
/** Which shipping profile prices a pre-order route (skuChannel.ts ROUTE_PROFILE, restated as data). */
export const ROUTE_PROFILE: Readonly<Record<PricingRoute, PricingProfile>> = { air: 'CHINA_AIR', sea: 'CHINA_SEA', land: 'GERMANY_LAND' };

export interface PricingNames {
  name_ar: string;
  name_en: string;
  name_ckb: string;
}

/** One product's line in the overview, and the head of its page. */
export interface PricingProductSummary extends PricingNames {
  id: string;
  slug: string;
  /** The product's store status (active, draft, …) — unchanged by this screen. */
  status: string;
  migration_status: PricingMigrationStatus;
  /** Codes that hold the product: legacy reasons and engine readiness codes. */
  reason_codes: string[];
  /** Codes that explain a value and hold nothing. */
  info_codes: string[];
  channel_mix: PricingSaleMix;
  routes: PricingRoute[];
  model_count: number;
  /** A typed PRIME/PRO price or adjustment on any rung (yes/no only). */
  typed_member_prices: boolean;
}

export interface PricingOverview {
  success: true;
  preview_only: true;
  page: number;
  page_size: number;
  pages: number;
  total: number;
  status_counts: Array<{ migration_status: PricingMigrationStatus; count: number }>;
  typed_member_price_products: number;
  products: PricingProductSummary[];
}

/** One channel of one model as a guest's cart is charged for it today. */
export interface PricingChannelToday {
  channel: PricingChannel;
  route: PricingRoute | null;
  today_item_iqd: number | null;
  /** The old route fee (pre-order) or the direct scalar (direct sale). */
  today_fee_iqd: number | null;
  today_prepaid_iqd: number | null;
  today_cod_iqd: number | null;
  /** Cash on delivery re-prices this pre-order from the direct ladder. */
  cod_priced_as_direct: boolean;
  /** The old landed cost (shipping included — answer B). */
  landed_cost_iqd: number | null;
  price_rung: PricingRung | null;
  cost_rung: PricingRung | null;
  resolver_errors: string[];
}

export interface PricingReasonFigure {
  code: string;
  route: PricingRoute | null;
  legacy_reason_iqd: number | null;
}

export type PricingCandidateKind = 'route' | 'floor' | 'ceiling';

export interface PricingDerivedTarget {
  migration_state: LegacyValueState;
  target_profit_iqd: number | null;
  reason_codes: string[];
  reason_figures: PricingReasonFigure[];
  candidates: Array<{ kind: PricingCandidateKind; route: PricingRoute | null; target_profit_iqd: number }>;
}

export interface PricingDerivedDirectSaleExtra {
  migration_state: LegacyValueState;
  direct_sale_extra_iqd: number | null;
  reason_codes: string[];
  reason_figures: PricingReasonFigure[];
  candidates: Array<{ kind: PricingCandidateKind; route: PricingRoute | null; direct_sale_extra_iqd: number }>;
}

export interface PricingSuggestedMeasures {
  shipping_weight_g: number | null;
  weight_scope: 'base' | 'option' | null;
  shipping_length_mm: number | null;
  shipping_width_mm: number | null;
  shipping_height_mm: number | null;
  box_scope: 'base' | 'option' | null;
  /** Exact decimal TEXT (L × W × H / 1e9). */
  calculated_cbm: string | null;
}

export interface PricingModel extends PricingNames {
  /** '' for a product without models (the product itself). */
  option_id: string;
  channel_mix: PricingSaleMix;
  base_route: PricingRoute | null;
  channels: PricingChannelToday[];
  target: PricingDerivedTarget;
  direct_sale_extra: PricingDerivedDirectSaleExtra;
  /** null: nothing to check; otherwise whether the old prices come back from the values. */
  roundtrip_ok: boolean | null;
  suggested_measures: PricingSuggestedMeasures;
  missing: Array<{ channel: PricingChannel; code: string }>;
}

export interface PricingFxRate {
  currency: PricingCurrency;
  /** Exact decimal TEXT, or null when no rate is known (USD today). */
  rate_iqd: string | null;
  confirmed: boolean;
  rate_origin: 'central' | 'procurement_profiles' | 'what_if';
}

export interface PricingShippingRate {
  profile: PricingProfile;
  basis: 'weight' | 'volume';
  rate_iqd: string | null;
  confirmed: boolean;
  rate_origin: 'central' | 'procurement_profiles' | 'what_if';
}

export interface PricingRates {
  fx_rates: PricingFxRate[];
  shipping_rates: PricingShippingRate[];
}

export interface PricingProductDetail extends PricingRates {
  success: true;
  preview_only: true;
  product: PricingProductSummary;
  models: PricingModel[];
}

export interface PricingWhatIfRequest {
  /** Decimal TEXT, strictly above zero (never a JSON number). */
  supplier_cost: string;
  currency: PricingCurrency;
  option_id?: string;
  /** Whole dinars. */
  additional_cost_iqd?: number;
  measures?: {
    weight_g?: number;
    length_mm?: number;
    width_mm?: number;
    height_mm?: number;
    /** Decimal TEXT. */
    manual_cbm?: string;
    shipping_profile?: PricingProfile;
  };
  rates?: {
    fx?: Partial<Record<PricingCurrency, string>>;
    shipping?: Partial<Record<PricingProfile, string>>;
  };
}

export interface PricingWhatIfChannel {
  channel: PricingChannel;
  today_prepaid_iqd: number | null;
  today_cod_iqd: number | null;
  /** The engine's new price; null when it cannot price this channel. */
  computed_price_iqd: number | null;
  /** new − today (prepaid), whole IQD, from the server. */
  change_iqd: number | null;
  replacement_cost_iqd: number | null;
  replacement_exact: string | null;
  supplier_cost_iqd: number | null;
  shipping_cost_iqd: number | null;
  additional_cost_iqd: number | null;
  target_profit_iqd: number | null;
  direct_sale_extra_iqd: number | null;
  preorder_base_iqd: number | null;
  /** What rounding up to the 1,000 step added (≥ 0): the proof the minimum is kept. */
  rounding_added_iqd: number | null;
  shipping_profile: PricingProfile | null;
  fx_rate: string | null;
  shipping_rate: string | null;
  effective_weight_g: number | null;
  effective_cbm: string | null;
  issue_codes: string[];
}

export interface PricingWhatIfAnswer extends PricingRates {
  success: true;
  preview_only: true;
  inputs: {
    scope: 'base' | 'option';
    scope_id: string;
    supplier_cost: string;
    supplier_currency: PricingCurrency;
    additional_cost_iqd: number | null;
  };
  models: Array<PricingNames & { option_id: string; channels: PricingWhatIfChannel[] }>;
}

export function fetchPricingOverview(page: number, opts?: RequestOptions): Promise<PricingOverview> {
  return api.get<PricingOverview>(`${PRICING_API}/overview?page=${Math.max(1, Math.floor(page))}`, opts);
}

/** Never more pages than this are read for one list (the engine's cap is 60 products). */
export const OVERVIEW_PAGE_LIMIT = 10;

/**
 * Every product of the overview, for a list the owner can search and filter
 * without paging: page 1 first (it carries the count of pages), the rest in
 * parallel. The counts are the server's, over every product.
 */
export async function fetchPricingProducts(opts?: RequestOptions): Promise<{ overview: PricingOverview; products: PricingProductSummary[]; truncated: boolean }> {
  const first = await fetchPricingOverview(1, opts);
  const last = Math.min(first.pages, OVERVIEW_PAGE_LIMIT);
  const rest = await Promise.all(Array.from({ length: Math.max(0, last - 1) }, (_, i) => fetchPricingOverview(i + 2, opts)));
  const seen = new Set<string>();
  const products: PricingProductSummary[] = [];
  for (const page of [first, ...rest]) {
    for (const p of page.products) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      products.push(p);
    }
  }
  return { overview: first, products, truncated: first.pages > OVERVIEW_PAGE_LIMIT };
}

export function fetchPricingProduct(id: string, opts?: RequestOptions): Promise<PricingProductDetail> {
  return api.get<PricingProductDetail>(`${PRICING_API}/products/${encodeURIComponent(id)}`, opts);
}

export function runPricingWhatIf(id: string, body: PricingWhatIfRequest, opts?: RequestOptions): Promise<PricingWhatIfAnswer> {
  return api.post<PricingWhatIfAnswer>(`${PRICING_API}/products/${encodeURIComponent(id)}/what-if`, body, opts);
}

// ============================================================= FX-1: the central rates
//
// FX programme plan §8 and §12. The owner's exchange-rate panel speaks to the
// same router, behind the same door (`requireCostRead`; every write also
// `assertCostWrite`); every answer is `private, no-store`. The browser never
// calls an exchange-rate provider: «تحديث الآن» asks the SERVER to check, and
// the server alone reaches IQWealth or the ECB.
//
// EVERY FIGURE IS THE SERVER'S. Rates are exact decimal TEXT; the client
// formats them and never computes one. What the owner types travels as TEXT
// too (the server refuses a JSON number for a decimal). Owner acts carry the
// pair's `owner_version`, so a panel left open across another act answers 409
// PRICING_CHANGED instead of overwriting it — a routine scheduler check never
// moves that version.

export type FxPairId = 'USD_IQD' | 'EUR_USD' | 'CNY_USD';
export const FX_PAIR_IDS: readonly FxPairId[] = ['USD_IQD', 'EUR_USD', 'CNY_USD'];
export type FxMode = 'AUTO' | 'MANUAL';
export type FxFetchStatus = 'OK' | 'FAILED' | 'STALE' | 'NOT_CONFIGURED';
export type FxStatus = FxFetchStatus | 'REVIEW_REQUIRED';
export type FxPendingReason = 'FIRST_VALUE' | 'ANOMALY' | 'ANOMALY_24H' | 'DRIFT' | 'BACK_TO_AUTO';
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

export interface FxPendingDto {
  market_rate: string | null;
  effective_rate: string;
  published_at: string | null;
  observed_at: string | null;
  reason: FxPendingReason | null;
  /** Signed percentage TEXT from the server, against the effective rate; null on a first value. */
  change_pct: string | null;
}

export interface FxPairDto {
  pair: FxPairId;
  provider: 'iqwealth' | 'ecb';
  attribution: { text: string; url: string };
  mode: FxMode;
  /** 6 or 12 for USD/IQD; 24 for the ECB pairs. */
  interval_hours: number;
  market_rate: string | null;
  market_buy: string | null;
  official_rate: string | null;
  /** USD/IQD only: a FIXED number of dinars per dollar added to the market sell, signed, never a percentage (owner decision 5). */
  market_adjustment_iqd: string | null;
  /** USD/IQD: true when effective = market sell + adjustment exactly, so the card may show the sum (never computed here). */
  formula_holds: boolean;
  manual_rate: string | null;
  effective_rate: string | null;
  effective_version: number;
  effective_source: 'provider' | 'manual' | 'review_approved' | null;
  effective_applied_at: string | null;
  last_known_good_rate: string | null;
  drift_anchor_rate: string | null;
  drift_anchor_at: string | null;
  published_at: string | null;
  last_checked_at: string | null;
  last_check_result: FxCheckResult | null;
  last_successful_at: string | null;
  status: FxStatus;
  fetch_status: FxFetchStatus;
  last_error_code: string | null;
  failing_since: string | null;
  pending: FxPendingDto | null;
  /** The value the owner last rejected, remembered 24 hours (critique M4.2). */
  rejected: { rejected_rate: string; rejected_at: string | null } | null;
  /** While MANUAL: what a refresh observed (critique L14). */
  last_observed: { market_rate: string | null; candidate: string; observed_at: string } | null;
  anomaly_threshold_pct: string;
  drift_threshold_pct: string;
  min_change_pct: string;
  bound_min: string;
  bound_max: string;
  next_check_at: string | null;
  owner_version: number;
}

export interface FxShippingDto {
  profile: PricingProfile;
  basis: 'weight' | 'volume';
  rate_iqd: string | null;
  version: number;
  updated_at: string | null;
  /** The purchase screens' value, offered as a one-tap suggestion. */
  procurement_suggestion: string | null;
}

export interface FxRatesAnswer {
  success: true;
  pairs: FxPairDto[];
  effective_rates_iqd: Partial<Record<PricingCurrency, { rate_iqd: string | null; version: number; updated_at: string | null }>>;
  shipping: FxShippingDto[];
  /** Whether the IQWealth key is set — a boolean, never the key. */
  key_configured: boolean;
  refresh_budget: { used_today: number; limit: number };
  provider_budget: { USD_IQD: { used_today: number; cap: number } };
  engine_products: number;
  reprice_blocked: number;
  stale_products: number;
  /** Only on «تحديث الآن». */
  report?: FxRefreshReport;
}

/** What «تحديث الآن» did, pair by pair — codes only, never a figure (worker/routes/adminPricing.ts). */
export interface FxRefreshReport {
  checked: Array<{ pair: FxPairId; result: FxCheckResult; code: string | null }>;
  lease_held: FxPairId[];
  budget_deferred: FxPairId[];
}

export interface FxHistoryItem {
  id: string;
  pair: FxPairId;
  event: string;
  trigger_kind: 'cron' | 'refresh' | 'owner' | 'back_to_auto' | string;
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
  /** USD/IQD: the adjustment in force for this row (owner decision 5); null on the ECB pairs. */
  market_adjustment_iqd: string | null;
  /** settings_change rows: every changed setting, old → new (owner decision 10); null otherwise. */
  settings_diff: FxSettingsDiffItem[] | null;
}

/** The settings a history row's diff may name (worker/lib/fx/ownerActs.ts SETTINGS_DIFF_FIELDS). */
export type FxSettingsField =
  | 'mode'
  | 'interval_hours'
  | 'market_adjustment_iqd'
  | 'anomaly_threshold_pct'
  | 'drift_threshold_pct'
  | 'min_change_pct'
  | 'bound_min'
  | 'bound_max';

/** One changed setting: the exact text before and after. */
export interface FxSettingsDiffItem {
  field: FxSettingsField | string;
  before: string;
  after: string;
}

/** The body of a settings act: `owner_version` plus only the fields the owner changed. */
export interface FxSettingsBody {
  owner_version: number;
  mode?: FxMode;
  interval_hours?: 6 | 12;
  market_adjustment_iqd?: string;
  anomaly_threshold_pct?: string;
  drift_threshold_pct?: string;
  min_change_pct?: string;
  bound_min?: string;
  bound_max?: string;
  confirm_large_change?: boolean;
}

export const fetchFxRates = (opts?: RequestOptions) => api.get<FxRatesAnswer>(`${PRICING_API}/rates`, opts);

/**
 * The history, a page at a time. The cursor is the last row's time AND id:
 * one batch stamps all its rows with the same time, so a time alone dropped
 * the rest of a batch at a page edge (FX-1 review C4).
 */
export function fetchFxHistory(
  q: { pair?: FxPairId | null; before?: { created_at: string; id: string } | null; limit?: number },
  opts?: RequestOptions
): Promise<{ success: true; items: FxHistoryItem[] }> {
  const p = new URLSearchParams();
  if (q.pair) p.set('pair', q.pair);
  if (q.before) {
    p.set('before', q.before.created_at);
    p.set('before_id', q.before.id);
  }
  p.set('limit', String(Math.min(100, Math.max(1, Math.floor(q.limit ?? 30)))));
  return api.get<{ success: true; items: FxHistoryItem[] }>(`${PRICING_API}/rates/history?${p.toString()}`, opts);
}

export const saveFxSettings = (pair: FxPairId, body: FxSettingsBody) =>
  api.put<FxRatesAnswer>(`${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/settings`, body);

export const setFxManual = (pair: FxPairId, body: { owner_version: number; rate: string; confirm_large_change?: boolean }) =>
  api.put<FxRatesAnswer>(`${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/manual`, body);

export const confirmFxRate = (pair: FxPairId, body: { owner_version: number }) =>
  api.post<FxRatesAnswer>(`${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/confirm`, body);

export const refreshFxRates = (pairs?: FxPairId[]) =>
  api.post<FxRatesAnswer>(`${PRICING_API}/rates/fx/refresh`, pairs ? { pairs } : {});

export const reviewFxRate = (pair: FxPairId, body: { owner_version: number; decision: 'approve' | 'reject' | 'keep_manual'; confirm_large_change?: boolean }) =>
  api.post<FxRatesAnswer>(`${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/review`, body);

export const saveShippingRate = (profile: PricingProfile, body: { version: number; rate_iqd: string; confirm_large_change?: boolean }) =>
  api.put<FxRatesAnswer>(`${PRICING_API}/rates/shipping/${encodeURIComponent(profile)}`, body);

// ============================================================= The stale list (owner decision 8; USD design §6.5)
//
//   GET  /save-list               engine products whose stored price was computed at a
//                                 confirmed rate that changed since (stale), and
//                                 complete-but-manual products (ready) — counts and names
//   POST /save-list/preview       {product_ids} (≤ 20): each product's preview and hash — reads only
//   POST /products/save-bulk      {items:[{product_id, preview_hash}], confirm_large_change?} — the
//                                 one price write of this screen, after that preview; each product
//                                 its own atomic, fenced, audited batch on the server
//
// Every figure is the server's. FX-5: a confirmed rate change reprices these
// engine products automatically (the server, deficit first, every quarter
// hour until none is left); this list stays the owner's manual tool, and
// `auto` says «يُعاد التسعير تلقائياً» with the last run.

/** The most products one preview or bulk save carries (the server's own bound). */
export const ENGINE_BULK_MAX = 20;

export interface SaveListItem extends PricingNames {
  product_id: string;
  slug: string;
  /** What moved: a supplier currency (USD / EUR / CNY) or a shipping profile. */
  reasons: string[];
  /** Stale items only: the code the automatic repricing could not get past (never a figure). */
  blocked_code?: string | null;
}

/** The automatic repricing's last run that had work (counts only). */
export interface AutoRepriceLastRun {
  at: string;
  trigger: 'fx' | 'owner_rate' | 'shipping' | 'sweep' | string;
  repriced: number;
  blocked: number;
  remaining: number;
}

/** «يُعاد التسعير تلقائياً» — FX-5's status: counts, the pause, the last run. */
export interface AutoRepriceStatus {
  /** Stale engine products are being repriced on the next ticks. */
  active: boolean;
  paused: boolean;
  stale: number;
  blocked: number;
  last_run: AutoRepriceLastRun | null;
}

export interface SaveListAnswer {
  success: boolean;
  stale: { count: number; items: SaveListItem[] };
  ready: { count: number; items: SaveListItem[] };
  /** Null before the engine is installed. */
  auto?: AutoRepriceStatus | null;
}

export interface SaveListPreviewItem extends PricingNames {
  product_id: string;
  slug: string;
  preview: EngineAdoption;
}

export interface BulkSaveResult {
  product_id: string;
  status: 'saved' | 'already' | 'unchanged' | 'refused';
  code?: string;
}

export function fetchSaveList(signal?: AbortSignal): Promise<SaveListAnswer> {
  return api.get<SaveListAnswer>(`${PRICING_API}/save-list`, { signal, mascot: 'silent' });
}

export function previewSaveList(productIds: readonly string[]): Promise<{ success: boolean; items: SaveListPreviewItem[] }> {
  return api.post<{ success: boolean; items: SaveListPreviewItem[] }>(`${PRICING_API}/save-list/preview`, { product_ids: productIds.slice(0, ENGINE_BULK_MAX) }, { mascot: 'silent' });
}

export function saveBulk(items: ReadonlyArray<{ product_id: string; preview_hash: string }>, confirmLarge: boolean): Promise<{ success: boolean; results: BulkSaveResult[] }> {
  const body = { items: items.slice(0, ENGINE_BULK_MAX), ...(confirmLarge ? { confirm_large_change: true } : {}) };
  return api.post<{ success: boolean; results: BulkSaveResult[] }>(`${PRICING_API}/products/save-bulk`, body, { mascot: 'silent' });
}

/** The products one preview takes: the stale ones first (their stored price is already behind), then the ready ones. */
export const firstBatch = (list: SaveListAnswer): string[] => [...list.stale.items, ...list.ready.items].map((i) => i.product_id).slice(0, ENGINE_BULK_MAX);
