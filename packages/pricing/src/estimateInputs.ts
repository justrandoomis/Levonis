/**
 * ESTIMATED PRE-ORDER PRICES: THE INPUTS ONE ESTIMATE WRITES
 * (docs/SMART_PRICING.md §4.3–§4.6; owner decisions D2 and D3, DECISIONS
 * rows 278–279).
 *
 * An estimate is an ordinary Pricing V2 cost-first price (invariant I1). The
 * estimator turns a product's supplier prices (one per sellable SKU, from the
 * owner's catalogue), its type's figures and its own package into the very
 * wire the product form sends, `{method: 'cost', cost: {inputs,
 * minimum_profit}}`, and the engine prices that wire (`desiredFor` →
 * `evaluateDesired`, worker/lib/pricingEngine/estimate/compute.ts). This file
 * is the pure half: no I/O, no rate and no price. It decides three things.
 *
 * 1. THE SUPPLIER COST (`compactSupplierPrices`). The form's wire carries
 *    absolute costs only (`FORM_INPUT_FIELDS` has no `supplier_cost_delta`),
 *    and E1's `resolveSupplier` lets a more specific absolute replace
 *    everything below it, while two different absolutes at the option level
 *    are INPUT_CONFLICT. So the least specific EXACT representation wins:
 *      - one `base` absolute when every SKU costs the same;
 *      - `option` absolutes on the values of ONE group when the cost depends on
 *        that group only (each SKU then meets exactly one option absolute);
 *      - `color` absolutes when it depends on the colour only;
 *      - otherwise, and always when currencies are mixed, one absolute per SKU
 *        at the SKU's own level (`ownScopeOf`).
 *    Every candidate is re-resolved SKU by SKU with `resolveSkuInputs`; a
 *    difference of even one decimal moves on to the next candidate.
 *
 * 2. THE MEASURES, in order of precedence (§4.4):
 *      - the model's and the colour's own packages, which the engine reads
 *        itself (`packagesOf`, DECISIONS row 247) and this file never writes;
 *      - the product's own package (`products.package_*`, a public spec)
 *        written onto the `base` row, mapped [depth, width, height] →
 *        [L, W, H] as the form's `withPackageMeasure` does;
 *      - the type's default weight and box, or its CBM as `manual_cbm` (only
 *        where no box exists at base: LD6, a manual CBM beats a box at its
 *        level), and only where some SKU would otherwise have none. Defaults go
 *        into the private `base` input alone, never into `products.package_*`
 *        (this module writes no product column at all), and every SKU priced
 *        from one carries EST_DEFAULT_WEIGHT / EST_DEFAULT_BOX.
 *    Both the weight and the box are required: engine-mode completeness counts
 *    the resolved weight and effective CBM (worker/lib/productCompleteness.ts).
 *
 * 3. THE THREE-WAY MERGE against `applied_wire_json` (§4.5), field by field:
 *      - a stored field equal to what the estimator last applied is the
 *        estimator's: it is rewritten, or cleared when no longer wanted;
 *      - a field that differs from it is the owner's (the form,
 *        `procurementLinePricing` or a purchase): kept, EST_OWNER_EDITED
 *        (field names only);
 *      - a field the estimator never wrote that holds a value is the owner's:
 *        kept.
 *    Owner corrections win across levels too. A SKU whose chain holds an owner
 *    supplier cost is priced by the owner, and the estimator never lays an
 *    absolute at or above that owner's level for it (it would override or
 *    conflict with the correction), nor any absolute at all beneath an owner
 *    entry that is not itself an absolute (a cleared field, a difference): a
 *    sibling's price is never inferred for it.
 *
 * Fail closed: a SKU with no usable price (EST_NO_PRICE), a type with no
 * minimum profit or with no default where a SKU needs one
 * (EST_TYPE_INCOMPLETE), more input entries than the form takes, 61
 * (EST_TOO_MANY_SCOPES), and a SKU whose stock route (`shipping_profile`) the
 * owner holds on another route than the estimate's (EST_STRUCTURE_OWNER,
 * field `shipping_profile`: V2 prices D on that route, §4.3) are blocking
 * codes. The owner's route is never overwritten. Nothing is ever guessed and no
 * figure lives in this file: amounts, measures and the profit are the
 * owner's data; rates are read by the engine alone (invariant I8).
 *
 * CONFIDENTIAL: supplier prices, measures and the profit are the owner's.
 * `src/` never imports this file (tests/pricingCostToPrice.test.ts).
 */
import {
  MAX_ADDITIONAL_COST_IQD,
  MAX_BOX_MM,
  MAX_WEIGHT_G,
  SUPPLIER_CURRENCIES,
  resolveSkuInputs,
  type InputLevel,
  type PricingInputRow,
  type ScopeInputs,
  type SkuInputChain,
  type SupplierCurrency,
} from './costToPrice';
import { ROUTE_PROFILE, SHIPPING_PROFILES, type PreorderRoute, type ShippingProfile } from './skuChannel';
import { canonicalUsdRuleAmount } from './ruleResolution';
import type { PhysicalDimensionOverrides } from './physicalDimensions';

/* ----------------------------------------------------------------- limits -- */

/** The most input entries one product-form parse takes (`MAX_SCOPES`, worker/lib/pricingEngine/productInputs.ts). */
export const MAX_ESTIMATE_INPUT_ENTRIES = 61;
/** A supplier amount on the form's wire: at most 12 integer and 6 fraction digits (`parseInputEntry`). */
export const SUPPLIER_AMOUNT_DIGITS = { int: 12, fraction: 6 } as const;
/** A manual CBM on the form's wire: at most 3 integer and 9 fraction digits, 12 characters (`parseInputEntry`, 0181). */
export const MANUAL_CBM_DIGITS = { int: 3, fraction: 9, length: 12 } as const;
/** `product_price_estimates.applied_wire_json` CHECK (0218): at most this many characters. */
export const MAX_APPLIED_WIRE_LENGTH = 200_000;
/** The version of the `applied_wire_json` document this file reads and writes. */
export const APPLIED_WIRE_VERSION = 1;

/* ------------------------------------------------------------------ names -- */

/** Where a catalogue price came from (`supplier_price_matches.source`, or the owner's `supplier_price_manual.origin`). */
export type EstimatePriceSource = 'tmall_cn' | 'bambu_eu' | 'bambu_us' | 'typed' | 'store_page';
export const ESTIMATE_PRICE_SOURCES: readonly EstimatePriceSource[] = ['tmall_cn', 'bambu_eu', 'bambu_us', 'typed', 'store_page'];

/** Where a value the estimator wrote came from (§4.5). The type's route, extra cost and profit are `type_default`. */
export type EstimateValueSource = EstimatePriceSource | 'product_package' | 'type_default';
export const ESTIMATE_VALUE_SOURCES: readonly EstimateValueSource[] = [...ESTIMATE_PRICE_SOURCES, 'product_package', 'type_default'];

/**
 * The fields the merge owns one by one. A unit travels whole on the wire: the
 * supplier cost is its amount with its currency; the box is its three axes.
 * The names are the pricing field labels' own (`PRICING_FIELD_LABELS`).
 */
export type EstimateInputField = 'supplier_cost' | 'shipping_profile' | 'shipping_weight_g' | 'shipping_box' | 'manual_cbm' | 'additional_cost_iqd';
export const ESTIMATE_INPUT_FIELDS: readonly EstimateInputField[] = [
  'supplier_cost',
  'shipping_profile',
  'shipping_weight_g',
  'shipping_box',
  'manual_cbm',
  'additional_cost_iqd',
];
/** The product's minimum-profit rule, as EST_OWNER_EDITED names it. */
export const MINIMUM_PROFIT_FIELD = 'minimum_profit';

/** `price_estimate_lines.measure_source` (0218). */
export type EstimateMeasureSource = 'model' | 'colour' | 'product' | 'type_default' | 'owner' | 'none';

/** The codes this file decides (§4.6). The first four block an apply. */
export type EstimateInputFlagCode =
  | 'EST_NO_PRICE'
  | 'EST_TYPE_INCOMPLETE'
  | 'EST_TOO_MANY_SCOPES'
  | 'EST_STRUCTURE_OWNER'
  | 'EST_DEFAULT_WEIGHT'
  | 'EST_DEFAULT_BOX'
  | 'EST_US_REFERENCE'
  | 'EST_MANUAL_PRICE'
  | 'EST_STORE_PAGE_PRICE'
  | 'EST_OWNER_EDITED';
export const ESTIMATE_INPUT_BLOCKING: readonly EstimateInputFlagCode[] = ['EST_NO_PRICE', 'EST_TYPE_INCOMPLETE', 'EST_TOO_MANY_SCOPES', 'EST_STRUCTURE_OWNER'];

/** The flag a catalogue source carries when a SKU is priced from it. */
const SOURCE_FLAG: Partial<Record<EstimatePriceSource, EstimateInputFlagCode>> = {
  bambu_us: 'EST_US_REFERENCE',
  typed: 'EST_MANUAL_PRICE',
  store_page: 'EST_STORE_PAGE_PRICE',
};

/** One flag: a code, and the SKUs (combo keys) or the field names it concerns. Never a value. */
export interface EstimateFlag {
  code: string;
  combo_keys?: string[];
  fields?: string[];
}

/* ------------------------------------------------------------------ input -- */

/** A packaged measure (worker/lib/pricingEngine/store.ts `PackagedMeasure`): [L, W, H] in mm, the box whole or none. */
export interface EstimatePackage {
  weight_g: number | null;
  box: readonly [number, number, number] | null;
}

/** One sellable SKU (worker `sellableSkus`): its selection in relation order, the model first. */
export interface EstimateSku {
  combo_key: string;
  option_value_ids: readonly string[];
  color_id: string | null;
  /** The model's and the colour's own packages, exactly as the engine reads them (`packagesOf(doc)(ids, colour)`). */
  packaged?: { model?: EstimatePackage | null; color?: EstimatePackage | null } | null;
}

/** One SKU's catalogue price (`supplierPricesFor`, §3.7). */
export interface EstimateSupplierPrice {
  amount: string;
  currency: SupplierCurrency;
  source: EstimatePriceSource;
  /** The snapshot id (or another short reference) for `source_ref` 'estimate:<ref>'. */
  ref?: string | null;
  /** Codes the catalogue attached to this price (EST_SNAPSHOT_STALE, EST_UNITS_DIVIDED, …), carried when it prices the SKU. */
  flags?: readonly string[];
}

/** A `pricing_inputs` row as stored: a structural subset of the worker's `StoredInputRow`. */
export interface EstimateInputRow {
  scope: InputLevel;
  scope_id: string;
  origin: 'SOURCE' | 'MANUAL_OVERRIDE';
  supplier_cost_amount: string | null;
  supplier_cost_delta: string | null;
  supplier_cost_currency: SupplierCurrency | null;
  supplier_input_mode: string | null;
  shipping_profile: ShippingProfile | null;
  pricing_weight_g: number | null;
  shipping_weight_g: number | null;
  shipping_length_mm: number | null;
  shipping_width_mm: number | null;
  shipping_height_mm: number | null;
  manual_cbm: string | null;
  additional_cost_iqd: number | null;
  /** The JSON text the table stores, or the list itself. */
  unresolved_fields: string | readonly string[] | null;
}

/** The product's own `target_profit` rule at product scope, as stored (`ruleAt(rules, pid, 'target_profit', 'product', '')`). */
export interface EstimateProductRule {
  state: string;
  amount_usd?: string | null;
  amount_iqd?: number | null;
}

/** The figures of the product's estimate type (`price_estimate_types`), with the product's route override already applied. */
export interface EstimateTypeInputs {
  key: string;
  route: PreorderRoute;
  default_weight_g: number | null;
  default_length_mm: number | null;
  default_width_mm: number | null;
  default_height_mm: number | null;
  default_cbm: string | null;
  additional_cost_iqd: number | null;
  min_profit_usd: string | null;
}

/** The scope ids the form accepts for this product (`formScopeIds`); left out, the SKUs' own ids. */
export interface EstimateScopeIds {
  option?: Iterable<string>;
  color?: Iterable<string>;
  sku?: Iterable<string>;
}

/* ------------------------------------------------------------------- wire -- */

/** One scope's entry of `cost.inputs` (`parseInputEntry`): an absent key is untouched, null clears. */
export interface EstimateWireInput {
  scope: InputLevel;
  scope_id?: string;
  supplier_cost_amount?: string | null;
  supplier_cost_currency?: SupplierCurrency | null;
  shipping_profile?: ShippingProfile | null;
  shipping_weight_g?: number | null;
  shipping_length_mm?: number | null;
  shipping_width_mm?: number | null;
  shipping_height_mm?: number | null;
  manual_cbm?: string | null;
  additional_cost_iqd?: number | null;
}

/** The V2 pricing block the estimate sends (`parseV2Wire`): the product's minimum profit as USD text. */
export interface EstimateWire {
  method: 'cost';
  cost: { inputs: EstimateWireInput[]; minimum_profit?: string };
}

/* ---------------------------------------------------------- applied wire -- */

export interface SupplierValue {
  amount: string;
  currency: SupplierCurrency;
}

type FieldValue = SupplierValue | ShippingProfile | number | readonly [number, number, number] | string;

/** One field the estimator wrote: where, what and from where (§4.5). */
export interface AppliedField {
  scope: InputLevel;
  scope_id: string;
  field: EstimateInputField;
  value: FieldValue;
  source: EstimateValueSource;
}

/** `product_price_estimates.applied_wire_json`: every field the estimator wrote, and the product rule. */
export interface AppliedWire {
  v: typeof APPLIED_WIRE_VERSION;
  inputs: AppliedField[];
  minimum_profit: { amount_usd: string; source: EstimateValueSource } | null;
}

/* ------------------------------------------------------------------ plan -- */

export interface EstimateSkuPlan {
  combo_key: string;
  /** `catalogue`: priced at its catalogue price; `owner`: the owner's cost decides; `missing`: neither. */
  supplier: 'catalogue' | 'owner' | 'missing';
  /** The catalogue price this SKU is priced at (catalogue only), canonical. */
  price: { amount: string; currency: SupplierCurrency; source: EstimatePriceSource } | null;
  weight_source: EstimateMeasureSource;
  cbm_source: EstimateMeasureSource;
  /** One word for the line: the weaker of the two measures (none, type_default, product, owner, colour, model). */
  measure_source: EstimateMeasureSource;
  /** The engine's own codes that keep this SKU's inputs from resolving (supplier, weight, CBM). */
  issues: string[];
  /** This SKU's flag codes (defaults, price source, the catalogue's own). */
  flags: string[];
}

export interface EstimatePlan {
  wire: EstimateWire;
  /** What `applied_wire_json` holds after an apply of this plan. */
  applied: AppliedWire;
  applied_json: string;
  /** The `InputWrite.source_ref` of each entry the wire carries: 'estimate:<snapshot | type>'. */
  source_refs: Array<{ scope: InputLevel; scope_id: string; source_ref: string }>;
  supplier: { level: 'base' | 'option' | 'color' | 'sku' | 'none'; group_id: string | null; exact: boolean };
  skus: EstimateSkuPlan[];
  /** `product_price_estimates.measure_basis`: '' when no SKU has both measures. */
  measure_basis: '' | 'real' | 'type_default' | 'mixed';
  flags: EstimateFlag[];
  /** The blocking codes among `flags` (EST_NO_PRICE, EST_TYPE_INCOMPLETE, EST_TOO_MANY_SCOPES, EST_STRUCTURE_OWNER). */
  blocked_by: EstimateInputFlagCode[];
  /** Fields the estimate wanted that the owner holds and keeps (information for the review sheet). */
  owner_held: Array<{ scope: InputLevel; scope_id: string; field: EstimateInputField | typeof MINIMUM_PROFIT_FIELD }>;
}

export interface EstimatePlanInput {
  skus: readonly EstimateSku[];
  /** Each SKU's catalogue price by combo key; an absent SKU has none. */
  prices: ReadonlyMap<string, EstimateSupplierPrice> | Readonly<Record<string, EstimateSupplierPrice | null | undefined>>;
  /** Option value id → its group id (`view.values`). An absent value belongs to the one implicit group ''. */
  option_groups?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  type: EstimateTypeInputs;
  /** The product's own dimensions (`doc.dimensions`): its package weight and box. */
  product_package?: PhysicalDimensionOverrides | null;
  /** The product's stored `pricing_inputs` rows (both origins). */
  inputs: readonly Partial<EstimateInputRow>[];
  product_rule?: EstimateProductRule | null;
  /** The stored `applied_wire_json` (text or parsed); null before the first apply. */
  applied?: unknown;
  scopes?: EstimateScopeIds;
}

/* --------------------------------------------------------------- helpers -- */

const LEVEL_RANK: Readonly<Record<InputLevel, number>> = { base: 0, option: 1, color: 2, sku: 3 };
const FIELD_RANK: Readonly<Record<EstimateInputField, number>> = {
  supplier_cost: 0,
  shipping_profile: 1,
  shipping_weight_g: 2,
  shipping_box: 3,
  manual_cbm: 4,
  additional_cost_iqd: 5,
};

const isLevel = (v: unknown): v is InputLevel => typeof v === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_RANK, v);
const isCurrency = (v: unknown): v is SupplierCurrency => typeof v === 'string' && (SUPPLIER_CURRENCIES as readonly string[]).includes(v);
const isProfile = (v: unknown): v is ShippingProfile => typeof v === 'string' && (SHIPPING_PROFILES as readonly string[]).includes(v);
const isField = (v: unknown): v is EstimateInputField => typeof v === 'string' && Object.prototype.hasOwnProperty.call(FIELD_RANK, v);
const isValueSource = (v: unknown): v is EstimateValueSource => typeof v === 'string' && (ESTIMATE_VALUE_SOURCES as readonly string[]).includes(v);
const isPriceSource = (v: unknown): v is EstimatePriceSource => typeof v === 'string' && (ESTIMATE_PRICE_SOURCES as readonly string[]).includes(v);

const wholeIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : null;

/**
 * Canonical positive decimal text within the digit limits, or null — the
 * form's own reading (`parseProcurementDecimal`): no sign, no exponent, no
 * leading or trailing '.', leading zeros and trailing fraction zeros dropped.
 */
function canonicalPositiveDecimal(raw: unknown, maxInt: number, maxFraction: number): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(raw.trim());
  if (!m) return null;
  const int = m[1]!.replace(/^0+(?=[0-9])/, '');
  const fraction = (m[2] ?? '').replace(/0+$/, '');
  if (int.length > maxInt || fraction.length > maxFraction) return null;
  if (int === '0' && !fraction) return null;
  return fraction ? `${int}.${fraction}` : int;
}

/** A supplier amount the form's wire carries, canonical — or null (unusable: no price). */
export const canonicalSupplierAmount = (raw: unknown): string | null =>
  canonicalPositiveDecimal(raw, SUPPLIER_AMOUNT_DIGITS.int, SUPPLIER_AMOUNT_DIGITS.fraction);

/** A manual CBM the form's wire carries, canonical — or null. */
export function canonicalManualCbm(raw: unknown): string | null {
  const text = canonicalPositiveDecimal(raw, MANUAL_CBM_DIGITS.int, MANUAL_CBM_DIGITS.fraction);
  return text !== null && text.length <= MANUAL_CBM_DIGITS.length ? text : null;
}

const validWeight = (v: unknown): number | null => wholeIn(v, 1, MAX_WEIGHT_G);
function validBox(l: unknown, w: unknown, h: unknown): [number, number, number] | null {
  const axes = [wholeIn(l, 1, MAX_BOX_MM), wholeIn(w, 1, MAX_BOX_MM), wholeIn(h, 1, MAX_BOX_MM)];
  return axes.every((a) => a !== null) ? (axes as [number, number, number]) : null;
}

/**
 * The product's own package as the base row takes it (the form's
 * `withPackageMeasure`): its packed weight, and its box [L, W, H] = [depth,
 * width, height]. A value the form's wire could not carry is no package.
 */
export function productPackageOf(dims: PhysicalDimensionOverrides | null | undefined): EstimatePackage {
  return {
    weight_g: validWeight(dims?.package_weight_g),
    box: validBox(dims?.package_depth_mm, dims?.package_width_mm, dims?.package_height_mm),
  };
}

/** A SKU worth its own level (worker `skuOwnLevel`): a colour, or more than one option value. */
const skuOwnLevel = (combo: string): boolean => combo.includes('c:') || combo.split('|').length > 1;

/**
 * The scope a SKU's own absolute is written at: the exact SKU when it is worth
 * its own level, else its model's (one option value alone is the model's
 * level), else the product itself (`''`).
 */
export function ownScopeOf(sku: Pick<EstimateSku, 'combo_key' | 'option_value_ids'>): { scope: InputLevel; scope_id: string } {
  if (sku.combo_key && skuOwnLevel(sku.combo_key)) return { scope: 'sku', scope_id: sku.combo_key };
  const model = sku.option_value_ids.filter(Boolean)[0];
  return model ? { scope: 'option', scope_id: model } : { scope: 'base', scope_id: '' };
}

/** The scopes of a SKU's chain, least specific first (the chain `chainOfUnit` builds). */
function chainScopes(sku: EstimateSku): Array<{ scope: InputLevel; scope_id: string }> {
  return [
    { scope: 'base', scope_id: '' },
    ...sku.option_value_ids.filter(Boolean).map((id) => ({ scope: 'option' as const, scope_id: id })),
    ...(sku.color_id ? [{ scope: 'color' as const, scope_id: sku.color_id }] : []),
    ...(sku.combo_key ? [{ scope: 'sku' as const, scope_id: sku.combo_key }] : []),
  ];
}

/** Does an entry at this scope reach this SKU? */
function covers(scope: InputLevel, scopeId: string, sku: EstimateSku): boolean {
  switch (scope) {
    case 'base':
      return true;
    case 'option':
      return sku.option_value_ids.includes(scopeId);
    case 'color':
      return sku.color_id === scopeId;
    default:
      return sku.combo_key === scopeId;
  }
}

const scopeKey = (scope: InputLevel, scopeId: string) => `${scope}\u0000${scope === 'base' ? '' : scopeId}`;
const fieldKey = (scope: InputLevel, scopeId: string, field: string) => `${scopeKey(scope, scopeId)}\u0000${field}`;
const byScope = <T extends { scope: InputLevel; scope_id: string }>(a: T, b: T) =>
  LEVEL_RANK[a.scope] - LEVEL_RANK[b.scope] || (a.scope_id < b.scope_id ? -1 : a.scope_id > b.scope_id ? 1 : 0);

const uniqueSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/* -------------------------------------------------------------- the chain -- */

function unresolvedOf(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** A stored row as E1 reads it (worker `e1Row`): `supplier_cost_amount` → `supplier_cost`, …. */
function e1Row(row: Partial<EstimateInputRow> | null | undefined): PricingInputRow | null {
  if (!row) return null;
  return {
    supplier_cost: row.supplier_cost_amount ?? null,
    supplier_cost_delta: row.supplier_cost_delta ?? null,
    supplier_currency: row.supplier_cost_currency ?? null,
    shipping_profile: row.shipping_profile ?? null,
    pricing_weight_g: row.pricing_weight_g ?? null,
    shipping_weight_g: row.shipping_weight_g ?? null,
    shipping_length_mm: row.shipping_length_mm ?? null,
    shipping_width_mm: row.shipping_width_mm ?? null,
    shipping_height_mm: row.shipping_height_mm ?? null,
    manual_cbm: row.manual_cbm ?? null,
    additional_cost_iqd: row.additional_cost_iqd ?? null,
    ...(row.origin === 'SOURCE' ? { unresolved_fields: unresolvedOf(row.unresolved_fields) } : {}),
  };
}

const rowAt = (rows: readonly Partial<EstimateInputRow>[], scope: InputLevel, scopeId: string, origin: EstimateInputRow['origin']) =>
  rows.find((r) => r.scope === scope && (r.scope_id ?? '') === scopeId && r.origin === origin) ?? null;

function scopeInputs(rows: readonly Partial<EstimateInputRow>[], scope: InputLevel, scopeId: string, packaged?: EstimatePackage | null): ScopeInputs {
  const level = { scope_id: scopeId, source: e1Row(rowAt(rows, scope, scopeId, 'SOURCE')), override: e1Row(rowAt(rows, scope, scopeId, 'MANUAL_OVERRIDE')) };
  if (!packaged) return level;
  // The packaged measure decides its level whole: its weight before any pricing row's, its box before any box
  // or manual CBM of either row (worker `scopeInputs`, DECISIONS row 247).
  const override: PricingInputRow = { ...(level.override ?? {}) };
  let source = level.source;
  if (packaged.weight_g !== null) Object.assign(override, { pricing_weight_g: packaged.weight_g, shipping_weight_g: null });
  if (packaged.box) {
    const [shipping_length_mm, shipping_width_mm, shipping_height_mm] = packaged.box;
    Object.assign(override, { shipping_length_mm, shipping_width_mm, shipping_height_mm, manual_cbm: null });
    if (source?.manual_cbm != null) source = { ...source, manual_cbm: null };
  }
  return { ...level, source, override };
}

/**
 * One SKU's input chain over stored rows — a mirror of the worker's
 * `chainOfUnit` (worker/lib/pricingEngine/store.ts) with the SKU's packages,
 * as V2's evaluation builds it (`combo_key || null`). This package may not
 * import worker/; `tests/estimateInputs.test.ts` pins the two together.
 */
export function estimateChain(rows: readonly Partial<EstimateInputRow>[], sku: EstimateSku): SkuInputChain {
  return {
    base: { source: e1Row(rowAt(rows, 'base', '', 'SOURCE')), override: e1Row(rowAt(rows, 'base', '', 'MANUAL_OVERRIDE')) },
    options: sku.option_value_ids.filter(Boolean).map((id, i) => scopeInputs(rows, 'option', id, i === 0 ? sku.packaged?.model : null)),
    ...(sku.color_id ? { color: scopeInputs(rows, 'color', sku.color_id, sku.packaged?.color) } : {}),
    ...(sku.combo_key ? { sku: scopeInputs(rows, 'sku', sku.combo_key) } : {}),
  };
}

/* ------------------------------------------------------- values and keys -- */

const supplierKey = (v: SupplierValue) => `${v.amount}|${v.currency}`;
const boxKey = (b: readonly [number | null, number | null, number | null]) => b.map((x) => (x === null ? '-' : String(x))).join('x');

/** The comparable key of an applied value. */
function appliedKey(field: EstimateInputField, value: FieldValue): string {
  switch (field) {
    case 'supplier_cost':
      return supplierKey(value as SupplierValue);
    case 'shipping_box':
      return boxKey(value as readonly [number, number, number]);
    default:
      return String(value);
  }
}

/**
 * The comparable key of the value a stored MANUAL_OVERRIDE row holds for one
 * field, or null when it holds none. A supplier difference or a cost typed in
 * dinars is never a value the estimator wrote, so its key never equals one.
 */
function storedKey(row: Partial<EstimateInputRow> | null, field: EstimateInputField): { key: string; absolute: boolean } | null {
  if (!row) return null;
  switch (field) {
    case 'supplier_cost': {
      if (row.supplier_cost_delta != null) return { key: `delta:${row.supplier_cost_delta}|${row.supplier_cost_currency ?? ''}`, absolute: false };
      if (row.supplier_cost_amount == null) return null;
      const amount = canonicalSupplierAmount(row.supplier_cost_amount) ?? `raw:${row.supplier_cost_amount}`;
      const key = `${amount}|${row.supplier_cost_currency ?? ''}`;
      return { key: row.supplier_input_mode === 'IQD_CONVERTED' ? `iqd:${key}` : key, absolute: true };
    }
    case 'shipping_box': {
      const axes = [row.shipping_length_mm ?? null, row.shipping_width_mm ?? null, row.shipping_height_mm ?? null] as const;
      return axes.every((a) => a === null) ? null : { key: boxKey(axes), absolute: true };
    }
    case 'manual_cbm':
      return row.manual_cbm == null ? null : { key: canonicalManualCbm(row.manual_cbm) ?? `raw:${row.manual_cbm}`, absolute: true };
    default: {
      const v = row[field];
      return v == null ? null : { key: String(v), absolute: true };
    }
  }
}

/** How one field stands between the store and the record of the last apply (§4.5). */
type FieldState =
  | { kind: 'empty' }
  | { kind: 'estimator'; record: AppliedField }
  /** The owner's value; `record` when it replaced one the estimator wrote. */
  | { kind: 'owner'; absolute: boolean; record: AppliedField | null }
  /** The owner cleared a value the estimator wrote. */
  | { kind: 'cleared'; record: AppliedField };

function fieldState(row: Partial<EstimateInputRow> | null, field: EstimateInputField, record: AppliedField | undefined): FieldState {
  const stored = storedKey(row, field);
  if (record && stored && stored.key === appliedKey(field, record.value)) return { kind: 'estimator', record };
  if (stored) return { kind: 'owner', absolute: stored.absolute, record: record ?? null };
  return record ? { kind: 'cleared', record } : { kind: 'empty' };
}

/* --------------------------------------------------------- applied wire -- */

function parseFieldValue(field: EstimateInputField, raw: unknown): FieldValue | null {
  switch (field) {
    case 'supplier_cost': {
      const r = raw as Partial<SupplierValue> | null;
      const amount = r && typeof r === 'object' ? canonicalSupplierAmount(r.amount) : null;
      return amount && isCurrency(r?.currency) ? { amount, currency: r!.currency } : null;
    }
    case 'shipping_profile':
      return isProfile(raw) ? raw : null;
    case 'shipping_weight_g':
      return validWeight(raw);
    case 'shipping_box':
      return Array.isArray(raw) && raw.length === 3 ? validBox(raw[0], raw[1], raw[2]) : null;
    case 'manual_cbm':
      return canonicalManualCbm(raw);
    default:
      return wholeIn(raw, 0, MAX_ADDITIONAL_COST_IQD);
  }
}

/**
 * The stored `applied_wire_json` (text or parsed), or null when there is none.
 * Read defensively: a record that does not parse is dropped — the field it
 * named then reads as the owner's, which keeps it (fail towards the owner).
 */
export function parseAppliedWire(raw: unknown): AppliedWire | null {
  let doc: unknown = raw;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const d = doc as { v?: unknown; inputs?: unknown; minimum_profit?: unknown };
  if (d.v !== APPLIED_WIRE_VERSION) return null;
  const seen = new Set<string>();
  const inputs: AppliedField[] = [];
  for (const entry of Array.isArray(d.inputs) ? d.inputs : []) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (!isLevel(e.scope) || !isField(e.field) || !isValueSource(e.source)) continue;
    const scopeId = e.scope === 'base' ? '' : typeof e.scope_id === 'string' && e.scope_id ? e.scope_id : null;
    if (scopeId === null || (e.scope === 'base' && e.scope_id !== undefined && e.scope_id !== '')) continue;
    const value = parseFieldValue(e.field, e.value);
    const key = fieldKey(e.scope, scopeId, e.field);
    if (value === null || seen.has(key)) continue;
    seen.add(key);
    inputs.push({ scope: e.scope, scope_id: scopeId, field: e.field, value, source: e.source });
  }
  const mp = d.minimum_profit as { amount_usd?: unknown; source?: unknown } | null | undefined;
  const amount = mp && typeof mp === 'object' ? canonicalUsdRuleAmount(mp.amount_usd) : null;
  return {
    v: APPLIED_WIRE_VERSION,
    inputs: inputs.sort(byField),
    minimum_profit: amount && isValueSource(mp?.source) ? { amount_usd: amount, source: mp!.source } : null,
  };
}

const byField = (a: AppliedField, b: AppliedField) => byScope(a, b) || FIELD_RANK[a.field] - FIELD_RANK[b.field];

/** The canonical text of an applied wire (sorted; the form `applied_wire_json` stores). */
export function serializeAppliedWire(wire: AppliedWire): string {
  return JSON.stringify({
    v: APPLIED_WIRE_VERSION,
    inputs: [...wire.inputs].sort(byField).map((f) => ({ scope: f.scope, scope_id: f.scope === 'base' ? '' : f.scope_id, field: f.field, value: f.value, source: f.source })),
    minimum_profit: wire.minimum_profit ? { amount_usd: wire.minimum_profit.amount_usd, source: wire.minimum_profit.source } : null,
  });
}

/* ----------------------------------------------------- measure sources -- */

/** Which of the two measures a source reading describes, and how the line names the weaker one. */
const MEASURE_WEAKNESS: readonly EstimateMeasureSource[] = ['none', 'type_default', 'product', 'owner', 'colour', 'model'];

const sourceOfRecord = (s: EstimateValueSource): EstimateMeasureSource =>
  s === 'type_default' ? 'type_default' : s === 'product_package' ? 'product' : 'owner';

/**
 * Where one SKU's freight weight and CBM come from, read from rows as stored
 * (or as an apply would leave them) and the applied record: `model` / `colour`
 * when the level that decides is that package, `product` / `type_default` when
 * it is a `base` field the estimator wrote from that source and the store still
 * holds that very value, `owner` for any other value, `none` when nothing
 * resolves. §4.9's "defaulted" test is `weight === 'type_default' || cbm ===
 * 'type_default'`.
 */
export function skuMeasureSources(
  rows: readonly Partial<EstimateInputRow>[],
  sku: EstimateSku,
  applied: AppliedWire | null
): { weight: EstimateMeasureSource; cbm: EstimateMeasureSource; issues: string[] } {
  const { inputs, problems } = resolveSkuInputs(estimateChain(rows, sku));
  const base = rowAt(rows, 'base', '', 'MANUAL_OVERRIDE');
  const model = sku.option_value_ids.filter(Boolean)[0] ?? null;
  const record = (field: EstimateInputField) => applied?.inputs.find((f) => f.scope === 'base' && f.field === field) ?? null;
  const fromBase = (field: EstimateInputField): EstimateMeasureSource => {
    const r = record(field);
    const state = r ? fieldState(base, field, r) : null;
    return state?.kind === 'estimator' ? sourceOfRecord(r!.source) : 'owner';
  };
  let weight: EstimateMeasureSource = 'none';
  const w = inputs.weight;
  if (w) {
    if (w.level === 'option' && w.scope_id === model && sku.packaged?.model?.weight_g != null) weight = 'model';
    else if (w.level === 'color' && sku.packaged?.color?.weight_g != null) weight = 'colour';
    else if (w.level === 'base' && w.origin === 'MANUAL_OVERRIDE' && w.field === 'shipping_weight_g') weight = fromBase('shipping_weight_g');
    else weight = 'owner';
  }
  let cbm: EstimateMeasureSource = 'none';
  const c = inputs.cbm;
  if (c) {
    if (c.level === 'option' && c.scope_id === model && sku.packaged?.model?.box) cbm = 'model';
    else if (c.level === 'color' && sku.packaged?.color?.box) cbm = 'colour';
    else if (c.level === 'base' && c.from === 'manual' && c.manual_origin === 'MANUAL_OVERRIDE') cbm = fromBase('manual_cbm');
    else if (c.level === 'base' && c.from === 'calculated' && c.box?.origin === 'MANUAL_OVERRIDE') cbm = fromBase('shipping_box');
    else cbm = 'owner';
  }
  const issues = uniqueSorted([...(w ? [] : problems.weight.map((p) => p.code)), ...(c ? [] : problems.cbm.map((p) => p.code))]);
  return { weight, cbm, issues };
}

/** The weaker of a SKU's two measure sources: the one word its line carries. */
export function lineMeasureSource(weight: EstimateMeasureSource, cbm: EstimateMeasureSource): EstimateMeasureSource {
  return MEASURE_WEAKNESS.indexOf(weight) <= MEASURE_WEAKNESS.indexOf(cbm) ? weight : cbm;
}

/* ------------------------------------------------------------ compaction -- */

/** One SKU the estimator prices at its catalogue price (canonical amount). */
export interface SupplierTarget {
  sku: EstimateSku;
  amount: string;
  currency: SupplierCurrency;
}

/** One absolute the representation writes, and the target SKUs it prices. */
export interface SupplierEntry {
  scope: InputLevel;
  scope_id: string;
  amount: string;
  currency: SupplierCurrency;
  combo_keys: string[];
}

export interface SupplierCompaction {
  level: 'base' | 'option' | 'color' | 'sku';
  /** The option group of an `option` representation. */
  group_id: string | null;
  entries: SupplierEntry[];
  /** Every target is reproduced exactly (and the caller's check passed). */
  exact: boolean;
  /** The targets a forced `sku` representation could not reproduce (only when `exact` is false). */
  unverified: string[];
}

export interface CompactionOptions {
  /** Option value id → group id; an absent value is the implicit group ''. */
  groupOf?: (optionValueId: string) => string;
  /** May the wire name this scope? (Base always.) */
  allowed?: (scope: InputLevel, scopeId: string) => boolean;
  /** Force the per-SKU representation (prices are missing: nothing is inferred from a sibling). */
  perSku?: boolean;
  /**
   * The caller's own check of a candidate (the merged store, the owner's SKUs): the combo keys it refuses for.
   * Empty accepts. It runs after the candidate reproduces every target on its own.
   */
  check?: (entries: readonly SupplierEntry[]) => readonly string[];
}

const supplierRow = (e: Pick<SupplierEntry, 'scope' | 'scope_id' | 'amount' | 'currency'>): Partial<EstimateInputRow> => ({
  scope: e.scope,
  scope_id: e.scope === 'base' ? '' : e.scope_id,
  origin: 'MANUAL_OVERRIDE',
  supplier_cost_amount: e.amount,
  supplier_cost_currency: e.currency,
});

/** The targets a set of rows does NOT price exactly at their catalogue price. */
function mispriced(rows: readonly Partial<EstimateInputRow>[], targets: readonly SupplierTarget[]): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const { inputs, problems } = resolveSkuInputs(estimateChain(rows, t.sku));
    const got = inputs.supplier;
    if (problems.supplier.length || !got || got.amount !== t.amount || got.currency !== t.currency) out.push(t.sku.combo_key);
  }
  return out;
}

/** Entries pricing each target by the value `keyOf` maps it to, or null when two targets of one key disagree. */
function entriesBy(targets: readonly SupplierTarget[], scope: InputLevel, keyOf: (t: SupplierTarget) => string | null): SupplierEntry[] | null {
  const by = new Map<string, SupplierEntry>();
  for (const t of targets) {
    const id = keyOf(t);
    if (id === null) return null;
    const at = by.get(id);
    if (!at) by.set(id, { scope, scope_id: scope === 'base' ? '' : id, amount: t.amount, currency: t.currency, combo_keys: [t.sku.combo_key] });
    else if (at.amount !== t.amount || at.currency !== t.currency) return null;
    else at.combo_keys.push(t.sku.combo_key);
  }
  return [...by.values()].sort(byScope);
}

/**
 * THE LEAST SPECIFIC EXACT REPRESENTATION of the targets' catalogue prices
 * (§4.4): base → one option group → colour → per SKU, the first candidate that
 * reproduces every target exactly through `resolveSkuInputs` (and passes the
 * caller's check). Mixed currencies, or `perSku`, go straight to per SKU. Null
 * when there is no target. When no candidate passes, the per-SKU one is
 * returned with `exact: false` and the targets it misses.
 */
export function compactSupplierPrices(targets: readonly SupplierTarget[], opts: CompactionOptions = {}): SupplierCompaction | null {
  if (!targets.length) return null;
  const groupOf = opts.groupOf ?? (() => '');
  const allowed = opts.allowed ?? (() => true);
  const candidates: Array<{ level: SupplierCompaction['level']; group_id: string | null; entries: SupplierEntry[] }> = [];
  const oneCurrency = targets.every((t) => t.currency === targets[0]!.currency);

  if (!opts.perSku) {
    const base = entriesBy(targets, 'base', () => '');
    if (base) candidates.push({ level: 'base', group_id: null, entries: base });
  }
  if (!opts.perSku && oneCurrency) {
    // Option groups in relation order (the model's first); fewest entries first, ties in that order.
    const groups: string[] = [];
    for (const t of targets) for (const id of t.sku.option_value_ids.filter(Boolean)) if (!groups.includes(groupOf(id))) groups.push(groupOf(id));
    const options: Array<{ group: string; entries: SupplierEntry[]; order: number }> = [];
    groups.forEach((g, order) => {
      const entries = entriesBy(targets, 'option', (t) => {
        const values = t.sku.option_value_ids.filter((id) => id && groupOf(id) === g);
        return values.length === 1 ? values[0]! : null;
      });
      // One value for every target is kept too: unlike `base`, it does not reach a SKU of the group's other values.
      if (entries) options.push({ group: g, entries, order });
    });
    options.sort((a, b) => a.entries.length - b.entries.length || a.order - b.order);
    for (const o of options) candidates.push({ level: 'option', group_id: o.group, entries: o.entries });
    const colours = entriesBy(targets, 'color', (t) => t.sku.color_id || null);
    if (colours) candidates.push({ level: 'color', group_id: null, entries: colours });
  }
  // Per SKU: each target at its own level. Two targets on one scope (a caller's duplicate) share it only
  // when they agree; a scope they disagree on is left out, so neither is priced from it.
  const own = new Map<string, SupplierEntry | null>();
  for (const t of targets) {
    const at = ownScopeOf(t.sku);
    const k = scopeKey(at.scope, at.scope_id);
    const seen = own.get(k);
    if (seen === undefined) own.set(k, { ...at, amount: t.amount, currency: t.currency, combo_keys: [t.sku.combo_key] });
    else if (seen && seen.amount === t.amount && seen.currency === t.currency) seen.combo_keys.push(t.sku.combo_key);
    else own.set(k, null);
  }
  const perSku = [...own.values()].filter((e): e is SupplierEntry => !!e).sort(byScope);
  const whole = [...own.values()].every((e) => e !== null);
  if (whole) candidates.push({ level: 'sku', group_id: null, entries: perSku });

  for (const c of candidates) {
    if (!c.entries.every((e) => e.scope === 'base' || allowed(e.scope, e.scope_id))) continue;
    if (mispriced(c.entries.map(supplierRow), targets).length) continue;
    if (opts.check && opts.check(c.entries).length) continue;
    return { ...c, exact: true, unverified: [] };
  }
  // Nothing passes: the per-SKU representation of what CAN be written, and the targets it misses.
  const forced = perSku.filter((e) => e.scope === 'base' || allowed(e.scope, e.scope_id));
  const missed = new Set<string>(mispriced(forced.map(supplierRow), targets));
  for (const k of opts.check ? opts.check(forced) : []) missed.add(k);
  return { level: 'sku', group_id: null, entries: forced, exact: false, unverified: uniqueSorted(missed) };
}

/* ----------------------------------------------------------------- merge -- */

interface DesiredField {
  scope: InputLevel;
  scope_id: string;
  field: EstimateInputField;
  value: FieldValue;
  source: EstimateValueSource;
  /** The snapshot reference a supplier value carries ('estimate:<ref>'). */
  ref?: string | null;
}

type FieldWrite = { scope: InputLevel; scope_id: string; field: EstimateInputField; value: FieldValue | null; ref?: string | null };

interface MergeOutcome {
  writes: FieldWrite[];
  records: AppliedField[];
  ownerEdited: string[];
  ownerHeld: Array<{ scope: InputLevel; scope_id: string; field: EstimateInputField }>;
}

/**
 * THE THREE-WAY MERGE of one set of fields (§4.5). `desired` are the fields the
 * estimate wants now; `considered` limits which recorded fields this call
 * settles (the supplier fields, or the base row's other fields); `allowed`
 * says whether the wire may name a scope (a record at a scope the product no
 * longer offers is carried, never cleared through the wire).
 */
function mergeFields(
  rows: readonly Partial<EstimateInputRow>[],
  applied: AppliedWire | null,
  desired: readonly DesiredField[],
  considered: (f: AppliedField) => boolean,
  allowed: (scope: InputLevel, scopeId: string) => boolean
): MergeOutcome {
  const out: MergeOutcome = { writes: [], records: [], ownerEdited: [], ownerHeld: [] };
  const records = new Map((applied?.inputs ?? []).filter(considered).map((f) => [fieldKey(f.scope, f.scope_id, f.field), f] as const));
  const wanted = new Map(desired.map((d) => [fieldKey(d.scope, d.scope_id, d.field), d] as const));
  for (const key of uniqueSorted([...records.keys(), ...wanted.keys()])) {
    const record = records.get(key);
    const want = wanted.get(key);
    const at = (want ?? record)!;
    const row = rowAt(rows, at.scope, at.scope === 'base' ? '' : at.scope_id, 'MANUAL_OVERRIDE');
    const state = fieldState(row, at.field, record);
    const reachable = at.scope === 'base' || allowed(at.scope, at.scope_id);
    if (want) {
      if (state.kind === 'estimator' || state.kind === 'empty') {
        const same = state.kind === 'estimator' && appliedKey(want.field, want.value) === appliedKey(want.field, state.record.value);
        if (!same) {
          if (!reachable) {
            if (record) out.records.push(record);
            continue;
          }
          out.writes.push({ scope: want.scope, scope_id: want.scope_id, field: want.field, value: want.value, ref: want.ref });
        }
        out.records.push({ scope: want.scope, scope_id: want.scope === 'base' ? '' : want.scope_id, field: want.field, value: want.value, source: want.source });
      } else if (state.kind === 'owner' && !state.record) {
        out.ownerHeld.push({ scope: want.scope, scope_id: want.scope_id, field: want.field });
      } else {
        // The owner changed (or cleared) what the estimator wrote: kept, and the record stays so it stays theirs.
        out.ownerEdited.push(want.field);
        out.records.push(record!);
      }
      continue;
    }
    // Recorded, no longer wanted.
    if (state.kind === 'estimator') {
      if (reachable) out.writes.push({ scope: record!.scope, scope_id: record!.scope_id, field: record!.field, value: null });
      else out.records.push(record!);
    } else if (state.kind === 'owner') {
      out.ownerEdited.push(record!.field);
      out.records.push(record!);
    } else if (state.kind === 'cleared' && record!.field === 'supplier_cost') {
      // A supplier cost the owner cleared keeps its SKUs the owner's: no later estimate writes it back.
      out.ownerEdited.push(record!.field);
      out.records.push(record!);
    }
  }
  return out;
}

/** The rows an apply of these writes leaves (worker `mergedInputs` over MANUAL_OVERRIDE rows). */
function applyWrites(rows: readonly Partial<EstimateInputRow>[], writes: readonly FieldWrite[]): Partial<EstimateInputRow>[] {
  const out = rows.map((r) => ({ ...r }));
  for (const w of writes) {
    const scopeId = w.scope === 'base' ? '' : w.scope_id;
    let row = out.find((r) => r.scope === w.scope && (r.scope_id ?? '') === scopeId && r.origin === 'MANUAL_OVERRIDE');
    if (!row) {
      row = { scope: w.scope, scope_id: scopeId, origin: 'MANUAL_OVERRIDE' };
      out.push(row);
    }
    Object.assign(row, wireFields(w));
    if (w.field === 'supplier_cost') {
      if (w.value !== null) row.supplier_cost_delta = null;
      row.supplier_input_mode = row.supplier_cost_amount != null || row.supplier_cost_delta != null ? 'SOURCE_CURRENCY' : null;
    }
  }
  return out;
}

/** One field write as the wire's keys. */
function wireFields(w: FieldWrite): Partial<EstimateWireInput> {
  switch (w.field) {
    case 'supplier_cost': {
      const v = w.value as SupplierValue | null;
      return { supplier_cost_amount: v ? v.amount : null, supplier_cost_currency: v ? v.currency : null };
    }
    case 'shipping_box': {
      const b = w.value as readonly [number, number, number] | null;
      return { shipping_length_mm: b ? b[0] : null, shipping_width_mm: b ? b[1] : null, shipping_height_mm: b ? b[2] : null };
    }
    case 'shipping_profile':
      return { shipping_profile: w.value as ShippingProfile | null };
    case 'shipping_weight_g':
      return { shipping_weight_g: w.value as number | null };
    case 'manual_cbm':
      return { manual_cbm: w.value as string | null };
    default:
      return { additional_cost_iqd: w.value as number | null };
  }
}

/* ------------------------------------------------------------------ plan -- */

const isMapLike = <V>(m: unknown): m is ReadonlyMap<string, V> => !!m && typeof (m as ReadonlyMap<string, V>).get === 'function';

/** One key of a map or a plain record (own keys only), or null. */
function lookup<V>(m: ReadonlyMap<string, V> | Readonly<Record<string, V | null | undefined>> | null | undefined, key: string): V | null {
  if (!m) return null;
  if (isMapLike<V>(m)) return m.get(key) ?? null;
  const rec = m as Readonly<Record<string, V | null | undefined>>;
  return Object.prototype.hasOwnProperty.call(rec, key) ? (rec[key] ?? null) : null;
}

/** The owner's hold on one SKU's supplier cost: the most specific level holding an owner entry, and whether it decides. */
interface OwnerHold {
  level: number;
  /** Every owner entry at that level is an absolute: anything less specific is replaced, never added to. */
  decisive: boolean;
}

/**
 * EVERYTHING ONE ESTIMATE WRITES (§4.4–§4.6): the supplier representation, the
 * measures, the profile, the extra cost and the minimum profit, merged three
 * ways against what the last apply wrote, as the product form's wire — with
 * the record the apply stores, each SKU's sources, and the flags.
 */
export function planEstimateInputs(input: EstimatePlanInput): EstimatePlan {
  const { skus, type } = input;
  const rows = input.inputs;
  const applied = parseAppliedWire(input.applied);
  const groupOf = (id: string): string => lookup<string>(input.option_groups, id) ?? '';

  // The scopes the wire may name: the form's (when given), else the SKUs' own.
  const fromSkus = {
    option: new Set(skus.flatMap((s) => s.option_value_ids.filter(Boolean))),
    color: new Set(skus.map((s) => s.color_id).filter((c): c is string => !!c)),
    sku: new Set(skus.map((s) => s.combo_key).filter((k) => !!k && skuOwnLevel(k))),
  };
  const sets = {
    option: input.scopes?.option ? new Set(input.scopes.option) : fromSkus.option,
    color: input.scopes?.color ? new Set(input.scopes.color) : fromSkus.color,
    sku: input.scopes?.sku ? new Set(input.scopes.sku) : fromSkus.sku,
  };
  const allowed = (scope: InputLevel, scopeId: string) => scope === 'base' || sets[scope].has(scopeId);

  const flags = new Map<string, EstimateFlag>();
  const flag = (code: string, extra: { combo_keys?: string[]; fields?: string[] } = {}) => {
    const f = flags.get(code) ?? { code };
    if (extra.combo_keys?.length) f.combo_keys = uniqueSorted([...(f.combo_keys ?? []), ...extra.combo_keys]);
    if (extra.fields?.length) f.fields = uniqueSorted([...(f.fields ?? []), ...extra.fields]);
    flags.set(code, f);
  };

  /* 1. Who prices each SKU's supplier cost: the owner (an owner entry in its chain), or the catalogue. */
  const supplierRecords = new Map((applied?.inputs ?? []).filter((f) => f.field === 'supplier_cost').map((f) => [scopeKey(f.scope, f.scope_id), f] as const));
  const holdAt = (scope: InputLevel, scopeId: string): { absolute: boolean } | null => {
    const manual = rowAt(rows, scope, scopeId, 'MANUAL_OVERRIDE');
    const state = fieldState(manual, 'supplier_cost', supplierRecords.get(scopeKey(scope, scopeId)));
    if (state.kind === 'owner') return { absolute: state.absolute };
    if (state.kind === 'cleared') return { absolute: false };
    // A retired SOURCE row's cost is not the estimator's either.
    const source = rowAt(rows, scope, scopeId, 'SOURCE');
    if (source?.supplier_cost_delta != null) return { absolute: false };
    if (source?.supplier_cost_amount != null) return { absolute: true };
    return null;
  };
  const holds = new Map<string, OwnerHold>();
  for (const s of skus) {
    let hold: OwnerHold | null = null;
    for (const at of chainScopes(s)) {
      const h = holdAt(at.scope, at.scope_id);
      if (!h) continue;
      const level = LEVEL_RANK[at.scope];
      if (!hold || level > hold.level) hold = { level, decisive: h.absolute };
      else if (level === hold.level) hold.decisive = hold.decisive && h.absolute;
    }
    if (hold) holds.set(s.combo_key, hold);
  }

  const targets: SupplierTarget[] = [];
  const noPrice: string[] = [];
  const skuPrice = new Map<string, EstimateSupplierPrice & { amount: string }>();
  for (const s of skus) {
    if (holds.has(s.combo_key)) continue;
    const p = lookup<EstimateSupplierPrice>(input.prices, s.combo_key);
    const amount = p && isCurrency(p.currency) && isPriceSource(p.source) ? canonicalSupplierAmount(p.amount) : null;
    if (!p || !amount) {
      noPrice.push(s.combo_key);
      continue;
    }
    skuPrice.set(s.combo_key, { ...p, amount });
    targets.push({ sku: s, amount, currency: p.currency });
  }

  /* 2. The supplier representation, merged with the store: every target exact, no owner hold overridden. */
  const refOf = new Map(targets.map((t) => [t.sku.combo_key, skuPrice.get(t.sku.combo_key)!] as const));
  const desiredSupplier = (entries: readonly SupplierEntry[]): DesiredField[] =>
    entries.map((e) => {
      const p = refOf.get(e.combo_keys[0]!)!;
      return { scope: e.scope, scope_id: e.scope_id, field: 'supplier_cost', value: { amount: e.amount, currency: e.currency }, source: p.source, ref: p.ref ?? null };
    });
  const mergeSupplier = (entries: readonly SupplierEntry[]) => mergeFields(rows, applied, desiredSupplier(entries), (f) => f.field === 'supplier_cost', allowed);
  const check = (entries: readonly SupplierEntry[]): string[] => {
    const refused = new Set<string>();
    for (const e of entries) {
      for (const s of skus) {
        const hold = holds.get(s.combo_key);
        if (!hold || !covers(e.scope, e.scope_id, s)) continue;
        // Beneath an owner absolute only, never at or above its level; nothing at all beneath a cleared cost or a difference.
        if (!hold.decisive || LEVEL_RANK[e.scope] >= hold.level) refused.add(s.combo_key);
      }
    }
    for (const k of mispriced(applyWrites(rows, mergeSupplier(entries).writes), targets)) refused.add(k);
    return [...refused];
  };
  const compaction = compactSupplierPrices(targets, { groupOf, allowed, perSku: noPrice.length > 0, check });
  const supplierMerge = mergeSupplier(compaction?.entries ?? []);
  const unverified = new Set(compaction?.unverified ?? []);

  /* 3. The base row: the route's profile, the type's extra cost, and the measures. */
  const baseRow = rowAt(rows, 'base', '', 'MANUAL_OVERRIDE');
  const baseRecord = (field: EstimateInputField) => applied?.inputs.find((f) => f.scope === 'base' && f.field === field);
  const baseState = (field: EstimateInputField) => fieldState(baseRow, field, baseRecord(field));
  const desiredBase: DesiredField[] = [];
  const want = (field: EstimateInputField, value: FieldValue, source: EstimateValueSource) =>
    desiredBase.push({ scope: 'base', scope_id: '', field, value, source });
  want('shipping_profile', ROUTE_PROFILE[type.route], 'type_default');
  const extra = wholeIn(type.additional_cost_iqd, 0, MAX_ADDITIONAL_COST_IQD);
  if (extra !== null) want('additional_cost_iqd', extra, 'type_default');

  // Which SKUs reach the base row for a measure: resolved over the store with the estimator's own base
  // measures taken away (they are about to be rewritten); the owner's base values stay.
  const MEASURE_FIELDS: readonly EstimateInputField[] = ['shipping_weight_g', 'shipping_box', 'manual_cbm'];
  const needRows = rows.map((r) => {
    if (r.scope !== 'base' || r.origin !== 'MANUAL_OVERRIDE') return r;
    const next = { ...r };
    for (const f of MEASURE_FIELDS) if (baseState(f).kind === 'estimator') Object.assign(next, wireFields({ scope: 'base', scope_id: '', field: f, value: null }));
    return next;
  });
  const needs = { weight: [] as string[], cbm: [] as string[] };
  for (const s of skus) {
    const { inputs, problems } = resolveSkuInputs(estimateChain(needRows, s));
    // Only a measure missing everywhere, or failing at the base level itself, is the base row's to give.
    if (!inputs.weight && problems.weight.every((p) => !p.level || p.level === 'base')) needs.weight.push(s.combo_key);
    if (!inputs.cbm && problems.cbm.every((p) => !p.level || p.level === 'base')) needs.cbm.push(s.combo_key);
  }
  const pkg = productPackageOf(input.product_package);
  const typeWeight = validWeight(type.default_weight_g);
  const typeBox = validBox(type.default_length_mm, type.default_width_mm, type.default_height_mm);
  const typeCbm = canonicalManualCbm(type.default_cbm);
  const incomplete: { fields: string[]; combo_keys: string[] } = { fields: [], combo_keys: [] };
  if (pkg.weight_g !== null) want('shipping_weight_g', pkg.weight_g, 'product_package');
  else if (needs.weight.length) {
    if (typeWeight !== null) want('shipping_weight_g', typeWeight, 'type_default');
    else {
      incomplete.fields.push('shipping_weight_g');
      incomplete.combo_keys.push(...needs.weight);
    }
  }
  if (pkg.box) want('shipping_box', pkg.box, 'product_package');
  else if (needs.cbm.length && !['shipping_box', 'manual_cbm'].some((f) => baseState(f as EstimateInputField).kind === 'owner')) {
    // A box or a manual CBM the owner keeps at base decides that level: nothing is laid over it. Otherwise
    // the type's CBM goes in as `manual_cbm` only because no box exists at base (a manual CBM beats a box at
    // its level, LD6), else the type's box.
    if (typeCbm !== null) want('manual_cbm', typeCbm, 'type_default');
    else if (typeBox) want('shipping_box', typeBox, 'type_default');
    else {
      incomplete.fields.push('shipping_box');
      incomplete.combo_keys.push(...needs.cbm);
    }
  }
  const baseMerge = mergeFields(rows, applied, desiredBase, (f) => f.scope === 'base' && f.field !== 'supplier_cost', allowed);

  /* 4. The minimum profit: the type's, as the product's own rule (D3), merged like a field. */
  const rule = input.product_rule ?? null;
  const ruleValue = (): string | null => {
    if (!rule || rule.state === 'INHERIT') return null;
    if (rule.state === 'ACTIVE' && rule.amount_usd != null) return canonicalUsdRuleAmount(rule.amount_usd) ?? `raw:${rule.amount_usd}`;
    if (rule.state === 'ACTIVE' && rule.amount_iqd != null) return `iqd:${rule.amount_iqd}`;
    return `state:${rule.state}`;
  };
  const storedRule = ruleValue();
  const typeProfit = canonicalUsdRuleAmount(type.min_profit_usd);
  const ruleRecord = applied?.minimum_profit ?? null;
  // The rule's state, as a field's (§4.5): the estimator's, the owner's (changed, cleared, or never ours), or empty.
  const ruleState: FieldState['kind'] = ruleRecord
    ? storedRule === ruleRecord.amount_usd
      ? 'estimator'
      : storedRule === null
        ? 'cleared'
        : 'owner'
    : storedRule === null
      ? 'empty'
      : 'owner';
  let minimumProfit: string | undefined;
  let nextRule: AppliedWire['minimum_profit'] = null;
  const ownerHeld: EstimatePlan['owner_held'] = [...supplierMerge.ownerHeld, ...baseMerge.ownerHeld];
  const ownerEdited = [...supplierMerge.ownerEdited, ...baseMerge.ownerEdited];
  // A type with no minimum profit is incomplete (§4.1), whatever this product holds: the type table is filled first.
  if (typeProfit === null) incomplete.fields.push(MINIMUM_PROFIT_FIELD);
  if (ruleState === 'estimator' || ruleState === 'empty') {
    if (typeProfit !== null) {
      if (storedRule !== typeProfit) minimumProfit = typeProfit;
      nextRule = { amount_usd: typeProfit, source: 'type_default' };
    } else {
      // The type lost its minimum profit: blocked, and the product's rule is left as it stands.
      nextRule = ruleRecord;
    }
  } else if (ruleRecord) {
    // The owner changed or cleared the minimum profit the estimator set: theirs, kept.
    ownerEdited.push(MINIMUM_PROFIT_FIELD);
    nextRule = ruleRecord;
  } else {
    ownerHeld.push({ scope: 'base', scope_id: '', field: MINIMUM_PROFIT_FIELD });
  }

  /* 5. The wire: one entry per scope, the fields that change; the record; each SKU's sources. */
  const writes = [...supplierMerge.writes, ...baseMerge.writes];
  const entries = new Map<string, EstimateWireInput>();
  const refs = new Map<string, string>();
  for (const w of [...writes].sort((a, b) => byScope(a, b) || FIELD_RANK[a.field] - FIELD_RANK[b.field])) {
    const k = scopeKey(w.scope, w.scope_id);
    const entry = entries.get(k) ?? (w.scope === 'base' ? { scope: 'base' as const } : { scope: w.scope, scope_id: w.scope_id });
    Object.assign(entry, wireFields(w));
    entries.set(k, entry);
    if (w.field === 'supplier_cost' && w.value !== null && w.ref) refs.set(k, `estimate:${w.ref}`);
  }
  const inputs = [...entries.values()];
  const wire: EstimateWire = { method: 'cost', cost: { inputs, ...(minimumProfit !== undefined ? { minimum_profit: minimumProfit } : {}) } };
  const source_refs = inputs.map((e) => {
    const scopeId = e.scope === 'base' ? '' : e.scope_id!;
    return { scope: e.scope, scope_id: scopeId, source_ref: refs.get(scopeKey(e.scope, scopeId)) ?? `estimate:${type.key}` };
  });
  const nextApplied: AppliedWire = { v: APPLIED_WIRE_VERSION, inputs: [...supplierMerge.records, ...baseMerge.records].sort(byField), minimum_profit: nextRule };
  const applied_json = serializeAppliedWire(nextApplied);
  const after = applyWrites(rows, writes);

  const unpriced: string[] = [];
  const offRoute: string[] = [];
  const routeProfile = ROUTE_PROFILE[type.route];
  const skuPlans: EstimateSkuPlan[] = skus.map((s) => {
    const measures = skuMeasureSources(after, s, nextApplied);
    const priced = skuPrice.get(s.combo_key);
    const supplier: EstimateSkuPlan['supplier'] = holds.has(s.combo_key) ? 'owner' : priced && !unverified.has(s.combo_key) ? 'catalogue' : 'missing';
    const issues = new Set(measures.issues);
    const resolved = resolveSkuInputs(estimateChain(after, s));
    for (const p of resolved.problems.supplier) issues.add(p.code);
    // Fail closed: a SKU whose supplier cost does not resolve after the apply has no price, whoever holds it.
    if (!resolved.inputs.supplier || resolved.problems.supplier.length) unpriced.push(s.combo_key);
    // V2 prices D on the stock route (§4.3): an owner's route other than the estimate's blocks, and is kept.
    const profile = resolved.inputs.shipping_profile;
    if (profile && profile.value !== routeProfile) offRoute.push(s.combo_key);
    const skuFlags = new Set<string>();
    if (measures.weight === 'type_default') skuFlags.add('EST_DEFAULT_WEIGHT');
    if (measures.cbm === 'type_default') skuFlags.add('EST_DEFAULT_BOX');
    if (priced && supplier === 'catalogue') {
      const sourceFlag = SOURCE_FLAG[priced.source];
      if (sourceFlag) skuFlags.add(sourceFlag);
      for (const f of priced.flags ?? []) if (typeof f === 'string' && f) skuFlags.add(f);
    }
    return {
      combo_key: s.combo_key,
      supplier,
      price: priced && supplier === 'catalogue' ? { amount: priced.amount, currency: priced.currency, source: priced.source } : null,
      weight_source: measures.weight,
      cbm_source: measures.cbm,
      measure_source: lineMeasureSource(measures.weight, measures.cbm),
      issues: uniqueSorted(issues),
      flags: uniqueSorted(skuFlags),
    };
  });

  /* 6. The flags. */
  const missingPrice = uniqueSorted([...noPrice, ...unverified, ...unpriced]);
  if (missingPrice.length) flag('EST_NO_PRICE', { combo_keys: missingPrice });
  if (incomplete.fields.length) flag('EST_TYPE_INCOMPLETE', { fields: incomplete.fields, combo_keys: incomplete.combo_keys });
  if (inputs.length > MAX_ESTIMATE_INPUT_ENTRIES || applied_json.length > MAX_APPLIED_WIRE_LENGTH) flag('EST_TOO_MANY_SCOPES');
  if (offRoute.length) flag('EST_STRUCTURE_OWNER', { combo_keys: offRoute, fields: ['shipping_profile'] });
  for (const p of skuPlans) for (const code of p.flags) flag(code, { combo_keys: [p.combo_key] });
  if (ownerEdited.length) flag('EST_OWNER_EDITED', { fields: ownerEdited });

  const measured = skuPlans.filter((p) => p.weight_source !== 'none' && p.cbm_source !== 'none');
  const defaulted = measured.filter((p) => p.weight_source === 'type_default' || p.cbm_source === 'type_default').length;
  const measure_basis: EstimatePlan['measure_basis'] = !measured.length ? '' : defaulted === 0 ? 'real' : defaulted === measured.length ? 'type_default' : 'mixed';
  const flagList = [...flags.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    wire,
    applied: nextApplied,
    applied_json,
    source_refs,
    supplier: { level: compaction?.level ?? 'none', group_id: compaction?.group_id ?? null, exact: compaction ? compaction.exact : true },
    skus: skuPlans,
    measure_basis,
    flags: flagList,
    blocked_by: ESTIMATE_INPUT_BLOCKING.filter((c) => flags.has(c)),
    owner_held: ownerHeld.sort((a, b) => byScope(a, b) || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
  };
}
