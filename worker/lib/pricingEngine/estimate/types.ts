/**
 * THE ESTIMATOR'S SHARED NAMES (docs/SMART_PRICING.md §4; migration 0218;
 * DECISIONS rows 278–282).
 *
 * An estimate is an ordinary Pricing V2 cost-first price (invariant I1) that a
 * product carries with the public label `products.price_estimate` until the
 * owner confirms it against the supplier. This module holds the rows the
 * estimator reads and writes, their defensive parsers, the flag classes and
 * the constants every estimate file shares. Pure: no I/O.
 *
 * OWNER-ONLY (invariant I6): every type, figure, flag and source here is the
 * owner's. Customers see a boolean label and final prices, never these.
 */
import { D1_INVOCATION_STATEMENT_LIMIT } from '../../quarterHourBudget';
import { PREORDER_ROUTES, ROUTE_PROFILE, channelOfRoute, type PreorderRoute, type ShippingProfile, type SkuChannel } from '@levonis/pricing/skuChannel';
import {
  ESTIMATE_BLOCKING_FLAGS,
  ESTIMATE_HARD_FLAGS,
  ESTIMATE_INFO_FLAGS,
  ESTIMATE_SOFT_FLAGS,
} from '@levonis/contracts/priceEstimates';
import type { EstimateFlag as PlanFlag, EstimateMeasureSource } from '@levonis/pricing/estimateInputs';

export type { PlanFlag };

/* ------------------------------------------------------------- the budget -- */

/** Kept free under D1's 1,000 statements per invocation (the door's reads, the purge, the completeness hook). */
export const ESTIMATE_RESERVE = 100;
/** What one estimate call may spend in all (§4.8): 1,000 − 100 = 900. */
export const ESTIMATE_INVOCATION_LIMIT = D1_INVOCATION_STATEMENT_LIMIT - ESTIMATE_RESERVE;
/**
 * What one product's reads may cost before its batch (loads, the V2 read, the supplier prices, the
 * structure planner): a product is not started unless this much is left. Measured on the test worlds
 * (tests/priceEstimateBudget.test.ts), with a margin.
 */
export const ESTIMATE_PRODUCT_READS = 80;

/** Products per compute call (§4.8). */
export const ESTIMATE_COMPUTE_PAGE = 10;
/** Products per apply call (§4.8). */
export const ESTIMATE_APPLY_PAGE = 5;
/** Products per listing page of the workspace. */
export const ESTIMATE_LIST_PAGE = 25;

/**
 * The purchase policy version that carries the estimated-price clause (§9 row 280): the owner's «apply»
 * switch is refused until the published purchase policy is at least this (worker/lib/policies/purchase.ts).
 */
export const ESTIMATE_POLICY_MIN_VERSION = 7;

/** The `pricing_audit` / `audit_log` source of an estimate write. */
export const ESTIMATE_APPLY_SOURCE = 'estimate_apply';

/* ------------------------------------------------------------------ names -- */

export type EstimateSourcing = 'EU_STORE_EUR' | 'CHINA_CNY';
export const ESTIMATE_SOURCINGS: readonly EstimateSourcing[] = ['EU_STORE_EUR', 'CHINA_CNY'];
export const isSourcing = (v: unknown): v is EstimateSourcing => typeof v === 'string' && (ESTIMATE_SOURCINGS as readonly string[]).includes(v);
export const isRoute = (v: unknown): v is PreorderRoute => typeof v === 'string' && (PREORDER_ROUTES as readonly string[]).includes(v);

/** The currency a sourcing buys in (the store's own; a US reference and a typed price may differ per SKU). */
export const SOURCING_CURRENCY: Readonly<Record<EstimateSourcing, 'EUR' | 'CNY'>> = { EU_STORE_EUR: 'EUR', CHINA_CNY: 'CNY' };

export type EstimateState = 'candidate' | 'estimated' | 'confirmed' | 'paused';
export const ESTIMATE_STATES: readonly EstimateState[] = ['candidate', 'estimated', 'confirmed', 'paused'];
export const isEstimateState = (v: unknown): v is EstimateState => typeof v === 'string' && (ESTIMATE_STATES as readonly string[]).includes(v);

export type TypeSource = '' | 'owner' | 'supplier_category' | 'import_type';
export type MeasureBasis = '' | 'real' | 'type_default' | 'mixed';

/** The type keys filament is sold under: sea only, never air (0218's CHECK and trigger T5). */
export const SEA_ONLY_TYPES: readonly string[] = ['filament', 'filament_pack'];

/** The channel of a route (one route per estimated product, §4.1). */
export const routeChannel = (route: PreorderRoute): SkuChannel => channelOfRoute(route);
export const routeProfile = (route: PreorderRoute): ShippingProfile => ROUTE_PROFILE[route];

/* ------------------------------------------------------------------- rows -- */

/** `price_estimate_types` (0218): the owner's per-type figures, every one NULL until typed. */
export interface EstimateTypeRow {
  key: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sourcing: EstimateSourcing;
  route: PreorderRoute;
  allow_air: boolean;
  us_reference_allowed: boolean;
  default_weight_g: number | null;
  default_length_mm: number | null;
  default_width_mm: number | null;
  default_height_mm: number | null;
  default_cbm: string | null;
  additional_cost_iqd: number | null;
  min_profit_usd: string | null;
  stale_after_days: number;
  version: number;
  updated_by: string;
  updated_at: string;
  /**
   * The profit ceiling, a percentage of cost from 0 to 100 (0222, DECISIONS row 291): null is no ceiling (today's
   * rule). ABSENT on a database without 0222 (deploy-ahead): no ceiling, and the type editor offers no field for it.
   */
  profit_cap_pct?: string | null;
}

/** `product_price_estimates` (0218): one product's estimate bookkeeping. */
export interface ProductEstimateRow {
  product_id: string;
  type_key: string | null;
  type_source: TypeSource;
  sourcing_override: EstimateSourcing | null;
  route_override: PreorderRoute | null;
  state: EstimateState;
  measure_basis: MeasureBasis;
  flags_json: string;
  preview_hash: string | null;
  computed_at: string | null;
  applied_at: string | null;
  applied_by: string | null;
  applied_write_seq: number | null;
  applied_wire_json: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  version: number;
  updated_by: string;
  updated_at: string;
}

/** `price_estimate_control` (0218): the owner's two switches. */
export interface EstimateControl {
  apply_enabled: boolean;
  ordering_enabled: boolean;
  version: number;
  updated_by: string;
  updated_at: string;
}

const intOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isSafeInteger(Number(v)) ? Number(v) : null);
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function typeRowOf(r: Record<string, unknown>): EstimateTypeRow | null {
  if (!isSourcing(r.sourcing) || !isRoute(r.route)) return null;
  return {
    key: String(r.key),
    name_ar: String(r.name_ar ?? ''),
    name_en: String(r.name_en ?? ''),
    name_ckb: String(r.name_ckb ?? ''),
    sourcing: r.sourcing,
    route: r.route,
    allow_air: Number(r.allow_air) === 1,
    us_reference_allowed: Number(r.us_reference_allowed) === 1,
    default_weight_g: intOrNull(r.default_weight_g),
    default_length_mm: intOrNull(r.default_length_mm),
    default_width_mm: intOrNull(r.default_width_mm),
    default_height_mm: intOrNull(r.default_height_mm),
    default_cbm: textOrNull(r.default_cbm),
    additional_cost_iqd: intOrNull(r.additional_cost_iqd),
    min_profit_usd: textOrNull(r.min_profit_usd),
    stale_after_days: intOrNull(r.stale_after_days) ?? 60,
    version: intOrNull(r.version) ?? 1,
    updated_by: String(r.updated_by ?? ''),
    updated_at: String(r.updated_at ?? ''),
    // `SELECT *` on a database without 0222 has no such key: the type then carries none (no cap, no field).
    ...(Object.prototype.hasOwnProperty.call(r, 'profit_cap_pct') ? { profit_cap_pct: textOrNull(r.profit_cap_pct) } : {}),
  };
}

const TYPE_SOURCES: readonly TypeSource[] = ['', 'owner', 'supplier_category', 'import_type'];
const MEASURE_BASES: readonly MeasureBasis[] = ['', 'real', 'type_default', 'mixed'];

export function estimateRowOf(r: Record<string, unknown>): ProductEstimateRow {
  const ts = String(r.type_source ?? '') as TypeSource;
  const mb = String(r.measure_basis ?? '') as MeasureBasis;
  return {
    product_id: String(r.product_id),
    type_key: textOrNull(r.type_key),
    type_source: TYPE_SOURCES.includes(ts) ? ts : '',
    sourcing_override: isSourcing(r.sourcing_override) ? r.sourcing_override : null,
    route_override: isRoute(r.route_override) ? r.route_override : null,
    state: isEstimateState(r.state) ? r.state : 'candidate',
    measure_basis: MEASURE_BASES.includes(mb) ? mb : '',
    flags_json: typeof r.flags_json === 'string' ? r.flags_json : '[]',
    preview_hash: textOrNull(r.preview_hash),
    computed_at: textOrNull(r.computed_at),
    applied_at: textOrNull(r.applied_at),
    applied_by: textOrNull(r.applied_by),
    applied_write_seq: intOrNull(r.applied_write_seq),
    applied_wire_json: textOrNull(r.applied_wire_json),
    confirmed_at: textOrNull(r.confirmed_at),
    confirmed_by: textOrNull(r.confirmed_by),
    version: intOrNull(r.version) ?? 1,
    updated_by: String(r.updated_by ?? ''),
    updated_at: String(r.updated_at ?? ''),
  };
}

export function controlOf(r: Record<string, unknown> | null | undefined): EstimateControl | null {
  if (!r) return null;
  return {
    apply_enabled: Number(r.apply_enabled) === 1,
    ordering_enabled: Number(r.ordering_enabled) === 1,
    version: intOrNull(r.version) ?? 1,
    updated_by: String(r.updated_by ?? ''),
    updated_at: String(r.updated_at ?? ''),
  };
}

/* ------------------------------------------------- sourcing and the route -- */

/**
 * A product's effective sourcing and route (§4.1): the owner's overrides over its type. EU sourcing travels
 * by land unless overridden (trigger T5 refuses anything else); China sourcing takes the type's route.
 */
export function effectiveRouting(type: EstimateTypeRow, row: Pick<ProductEstimateRow, 'sourcing_override' | 'route_override'> | null) {
  const sourcing: EstimateSourcing = row?.sourcing_override ?? type.sourcing;
  const route: PreorderRoute = row?.route_override ?? (sourcing === 'EU_STORE_EUR' ? 'land' : type.route);
  return { sourcing, route, us_reference_allowed: sourcing === 'EU_STORE_EUR' && type.us_reference_allowed };
}

/* ------------------------------------------------------------------ flags -- */

export type FlagClass = 'blocking' | 'hard' | 'soft' | 'info';

const SETS: ReadonlyArray<[FlagClass, ReadonlySet<string>]> = [
  ['blocking', new Set<string>(ESTIMATE_BLOCKING_FLAGS)],
  ['hard', new Set<string>(ESTIMATE_HARD_FLAGS)],
  ['soft', new Set<string>(ESTIMATE_SOFT_FLAGS)],
  ['info', new Set<string>(ESTIMATE_INFO_FLAGS)],
];

/**
 * The class of a flag code (§4.6). Every code the estimator does not name itself is the evaluation's own
 * (FX_RATE_MISSING, V2_ROUTE_BELOW_COST, CBM_MISSING, …) or a structural one: blocking.
 */
export function flagClass(code: string): FlagClass {
  for (const [c, set] of SETS) if (set.has(code)) return c;
  return 'blocking';
}

const uniqueSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** Adds a flag (merging its combo keys and field names); codes and ids only, never a value. */
export function addFlag(flags: Map<string, PlanFlag>, code: string, extra: { combo_keys?: readonly string[]; fields?: readonly string[] } = {}): void {
  const f = flags.get(code) ?? { code };
  if (extra.combo_keys?.length) f.combo_keys = uniqueSorted([...(f.combo_keys ?? []), ...extra.combo_keys]);
  if (extra.fields?.length) f.fields = uniqueSorted([...(f.fields ?? []), ...extra.fields]);
  flags.set(code, f);
}

export const sortedFlags = (flags: Map<string, PlanFlag>): PlanFlag[] => [...flags.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

/** The blocking codes among `flags`. */
export const blockingCodes = (flags: readonly PlanFlag[]): string[] => flags.filter((f) => flagClass(f.code) === 'blocking').map((f) => f.code);

/** `flags_json` within its column (≤ `max` characters): combo keys dropped first (a count kept), then the codes alone. */
export function flagsJson(flags: readonly PlanFlag[], max: number): string {
  const full = JSON.stringify(flags);
  if (full.length <= max) return full;
  const counted = JSON.stringify(flags.map((f) => ({ code: f.code, ...(f.combo_keys?.length ? { count: f.combo_keys.length } : {}), ...(f.fields ? { fields: f.fields } : {}) })));
  if (counted.length <= max) return counted;
  return JSON.stringify(flags.map((f) => ({ code: f.code })).slice(0, Math.max(1, Math.floor(max / 40))));
}

/** A stored flag: its combo keys, or their number when they were counted to fit the column (`flagsJson`). */
export type StoredFlag = PlanFlag & { count?: number };

/** The stored `flags_json` (codes with their ids, or their count), read defensively. */
export function parseFlags(raw: unknown): StoredFlag[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: StoredFlag[] = [];
  for (const f of v) {
    if (typeof f === 'string' && f) out.push({ code: f });
    else if (f && typeof f === 'object' && typeof (f as { code?: unknown }).code === 'string') {
      const o = f as { code: string; combo_keys?: unknown; fields?: unknown; count?: unknown };
      out.push({
        code: o.code,
        ...(Array.isArray(o.combo_keys) ? { combo_keys: o.combo_keys.filter((k): k is string => typeof k === 'string') } : {}),
        // Display only: what reads SKUs (confirm, the shown flags) reads `combo_keys`.
        ...(!Array.isArray(o.combo_keys) && Number.isSafeInteger(o.count) && (o.count as number) >= 0 ? { count: o.count as number } : {}),
        ...(Array.isArray(o.fields) ? { fields: o.fields.filter((k): k is string => typeof k === 'string') } : {}),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ lines -- */

export type LinePriceSource = 'tmall_cn' | 'bambu_eu' | 'bambu_us' | 'typed' | 'store_page' | 'none';

/** One SKU × channel of a preview (`price_estimate_lines`, 0218) — owner-only. */
export interface EstimateLine {
  combo_key: string;
  channel: SkuChannel;
  /** Where the supplier price came from (`price_estimate_lines.price_source`). */
  source: LinePriceSource;
  supplier_amount: string | null;
  supplier_currency: 'USD' | 'EUR' | 'CNY' | null;
  measure_source: EstimateMeasureSource;
  flags: string[];
  /** R, the replacement cost in IQD (the engine's own). */
  est_cost_iqd: number | null;
  /** The estimated price this apply would publish. */
  est_price_iqd: number | null;
  /** The price customers are charged today (the product's stored V2 result), or null. */
  published_price_iqd: number | null;
  change_pct: string | null;
  large: boolean;
}

/** What one product's compute answers (§4.8) — owner-only. */
export interface EstimatePreview {
  product_id: string;
  name: string;
  state: EstimateState;
  /** Whether customers see the label now (`products.price_estimate`). */
  label: boolean;
  type: string | null;
  type_source: TypeSource;
  sourcing: EstimateSourcing | null;
  route: PreorderRoute | null;
  currency: 'EUR' | 'CNY' | null;
  /** 'ready': pre-order-only on the route already; 'prepare': the apply makes it so; 'owner': never restructured. */
  structure: 'ready' | 'prepare' | 'owner' | null;
  measure_basis: MeasureBasis;
  flags: PlanFlag[];
  blocking: boolean;
  blocked_by: string[];
  preview_hash: string | null;
  computed_at: string;
  lines: EstimateLine[];
  /** The bookkeeping row's version the next write is fenced on (0 when none exists yet). */
  version: number;
}
