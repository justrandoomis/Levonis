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
 * 4. THE PROFIT CEILING (`planEstimateProfits`, §4.11, DECISIONS row 291):
 *    when the type carries a ceiling P (0–100% of cost), each SKU sells at
 *    the highest dollar charm price ($x.99) of at least $5 at or under both
 *    today's price and its cost plus P% whose profit keeps one rounding step
 *    over the cost — under $5 at the highest plain house price there that
 *    keeps it (`charmTarget`, ./charmPrice.ts) — written as fixed USD rules
 *    at the least specific exact scope (past the wire's 60 rows, one profit
 *    per group: the dearest, under $5 the cheapest that keeps every margin;
 *    EST_CEILING_SHARED, information); a charm price at today's own dinar
 *    price shows c only on a product of at most 19 SKUs where that plan is
 *    exact and today's is too, so the wire's rows never move a dinar price for
 *    a dollar figure; an owner's rule at any scope wins. The costs, the owner's differences and the USD rate it needs
 *    arrive as DATA from the engine's own first evaluation (compute.ts): this
 *    file still reads no rate.
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
// The profit ceiling (§4.11): the dollar charm price of each SKU, and the engine's own rule walk to verify what it writes.
import { resolveRuleAt, type PricingRuleRow, type PricingRuleState } from './ruleResolution';
import { skuComboKey } from './skuChannel';
import { charmTarget, priceAtProfit, type CharmBasis } from './charmPrice';

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
  | 'EST_OWNER_EDITED'
  // Information (§4.11): too many options for one rule each — some share a dearer profit of their group.
  | 'EST_CEILING_SHARED';
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
  /** The type's profit ceiling, 0–100% of cost (0222); absent or null is no ceiling: today's rule (§4.11). */
  profit_cap_pct?: string | null;
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

/**
 * The V2 pricing block the estimate sends (`parseV2Wire`): the product's minimum profit as USD text — or, under
 * the profit cap (§4.11), the form's rule rows when a scope rule moves.
 */
export interface EstimateWire {
  method: 'cost';
  cost: { inputs: EstimateWireInput[]; minimum_profit?: string | EstimateProfitRow[] };
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
  /** The option, colour and SKU rules the profit cap wrote (§4.11); absent when none, so older records read as before. */
  minimum_profit_scopes?: AppliedProfitScope[];
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
  const scopes = parseProfitScopes((doc as { minimum_profit_scopes?: unknown }).minimum_profit_scopes);
  return {
    v: APPLIED_WIRE_VERSION,
    inputs: inputs.sort(byField),
    minimum_profit: amount && isValueSource(mp?.source) ? { amount_usd: amount, source: mp!.source } : null,
    // Only when the profit cap wrote a scope rule: a record without one reads exactly as before (§4.11).
    ...(scopes.length ? { minimum_profit_scopes: scopes } : {}),
  };
}

const byField = (a: AppliedField, b: AppliedField) => byScope(a, b) || FIELD_RANK[a.field] - FIELD_RANK[b.field];

/** The canonical text of an applied wire (sorted; the form `applied_wire_json` stores). */
export function serializeAppliedWire(wire: AppliedWire): string {
  return JSON.stringify({
    v: APPLIED_WIRE_VERSION,
    inputs: [...wire.inputs].sort(byField).map((f) => ({ scope: f.scope, scope_id: f.scope === 'base' ? '' : f.scope_id, field: f.field, value: f.value, source: f.source })),
    minimum_profit: wire.minimum_profit ? { amount_usd: wire.minimum_profit.amount_usd, source: wire.minimum_profit.source } : null,
    // Emitted only when non-empty, so every record written before the profit cap stays byte for byte (§4.11).
    ...(wire.minimum_profit_scopes?.length
      ? { minimum_profit_scopes: [...wire.minimum_profit_scopes].sort(byProfitScope).map((f) => ({ scope: f.scope, scope_id: f.scope_id, amount_usd: f.amount_usd, source: f.source })) }
      : {}),
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

/* -------------------------------------- the owner's statement of real measures -- */

/**
 * `product_price_estimates.measure_basis` of SKUs' measure sources, as an apply states it: '' when no SKU has
 * both measures, 'real' when none of those is on a type default, 'type_default' when all are, else 'mixed'.
 */
export function measureBasisOf(sources: ReadonlyArray<{ weight: EstimateMeasureSource; cbm: EstimateMeasureSource }>): '' | 'real' | 'type_default' | 'mixed' {
  const measured = sources.filter((s) => s.weight !== 'none' && s.cbm !== 'none');
  const defaulted = measured.filter((s) => s.weight === 'type_default' || s.cbm === 'type_default').length;
  return !measured.length ? '' : defaulted === 0 ? 'real' : defaulted === measured.length ? 'type_default' : 'mixed';
}

/**
 * The base field each of a SKU's defaulted measures resolves from (§4.9's "defaulted", `skuMeasureSources`):
 * the weight from `shipping_weight_g`; the CBM from the type's box, or from the type's CBM written as
 * `manual_cbm` — which decides its level before any box (LD6), so no box can be stated in its place. Null
 * where the measure is not on a type default.
 */
export function skuDefaultedFields(
  rows: readonly Partial<EstimateInputRow>[],
  sku: EstimateSku,
  applied: AppliedWire | null
): { weight: 'shipping_weight_g' | null; cbm: 'shipping_box' | 'manual_cbm' | null } {
  const m = skuMeasureSources(rows, sku, applied);
  const base = rowAt(rows, 'base', '', 'MANUAL_OVERRIDE');
  return {
    weight: m.weight === 'type_default' ? 'shipping_weight_g' : null,
    // A type-default CBM resolves at the base row: from its manual CBM when one is there, else from its box.
    cbm: m.cbm === 'type_default' ? (base?.manual_cbm != null ? 'manual_cbm' : 'shipping_box') : null,
  };
}

/** What the owner states real (§4.9 step 0): the values the estimate is priced from, exactly as he was shown them. */
export interface StatedMeasures {
  weight_g?: number;
  /** [L, W, H] in mm, as the pricing form's box. */
  box_mm?: readonly [number, number, number];
}

/** Why a statement is not taken: `changed` — what the owner saw is no longer the store; the others are said to him. */
export type MeasureStatementRefusal = 'changed' | 'type_cbm' | 'package_differs' | 'package_partial' | 'below_net';

export type MeasureStatement =
  | {
      ok: true;
      /** The record with the stated fields re-sourced to the product's package, as the next apply records them. */
      applied: AppliedWire;
      /** The package values to write, only where the package is empty ([L, W, H] → depth, width, height). */
      package: { weight_g: number | null; box: [number, number, number] | null };
      fields: EstimateInputField[];
    }
  | { ok: false; reason: MeasureStatementRefusal };

/** An empty package value, as the conditional write reads it (`COALESCE(column, 0) <= 0`). */
const emptyPackageValue = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && v <= 0);

/**
 * THE OWNER'S STATEMENT THAT THE MEASURES SHOWN ARE THIS PRODUCT'S REAL ONES (§4.9 step 0; DECISIONS row 292).
 * Each stated value must be a base field the last apply recorded as the type's default and the store still holds
 * (the estimator's, §4.5), equal to what the owner states: the weight with no pricing weight deciding the level
 * before it, the box with no manual CBM there (a type's CBM decides before any box, LD6: `type_cbm`). The product's
 * own package must be empty there or hold the very value (`package_differs`; one or two box axes typed:
 * `package_partial`), and a stated weight is never lighter than the product's own net weight (`below_net`: the
 * form's «الصندوق أخف من محتواه» — the type's weight does not fit this product, whatever is ticked). Taken, the
 * stated fields are re-recorded as the product's package — what the next apply records when the package equals
 * the stored base values (`mergeFields`) — and the package values to write are the empty ones. Pure: the stored
 * row, the package and the price are the caller's to write and fence; no price moves, since the base row is
 * unchanged and V2 never reads the product-level package.
 */
export function attestBaseMeasures(
  rows: readonly Partial<EstimateInputRow>[],
  applied: AppliedWire | null,
  dims: PhysicalDimensionOverrides | null | undefined,
  sent: StatedMeasures
): MeasureStatement {
  const base = rowAt(rows, 'base', '', 'MANUAL_OVERRIDE');
  const recordOf = (field: EstimateInputField) => applied?.inputs.find((f) => f.scope === 'base' && f.field === field) ?? null;
  /** A base record of the type's default that the store still holds (never the owner's value, §4.5). */
  const held = (field: EstimateInputField) => {
    const r = recordOf(field);
    return r && r.source === 'type_default' && fieldState(base, field, r).kind === 'estimator' ? r : null;
  };
  const fields: EstimateInputField[] = [];
  if (sent.weight_g !== undefined) {
    const r = held('shipping_weight_g');
    if (!r || base?.pricing_weight_g != null || r.value !== sent.weight_g) return { ok: false, reason: 'changed' };
    fields.push('shipping_weight_g');
  }
  if (sent.box_mm !== undefined) {
    if (base?.manual_cbm != null) return { ok: false, reason: held('manual_cbm') ? 'type_cbm' : 'changed' };
    const r = held('shipping_box');
    if (!r || appliedKey('shipping_box', r.value) !== boxKey(sent.box_mm)) return { ok: false, reason: 'changed' };
    fields.push('shipping_box');
  }
  if (!applied || !fields.length) return { ok: false, reason: 'changed' };

  let weight: number | null = null;
  if (sent.weight_g !== undefined) {
    const v = dims?.package_weight_g;
    if (emptyPackageValue(v)) weight = sent.weight_g;
    else if (validWeight(v) !== sent.weight_g) return { ok: false, reason: 'package_differs' };
    // Packed, the product weighs at least itself: a lighter weight would publish a contradiction under «العبوة».
    const net = validWeight(dims?.net_weight_g);
    if (net !== null && sent.weight_g < net) return { ok: false, reason: 'below_net' };
  }
  let box: [number, number, number] | null = null;
  if (sent.box_mm !== undefined) {
    const axes = [dims?.package_depth_mm, dims?.package_width_mm, dims?.package_height_mm];
    const typed = axes.filter((v) => !emptyPackageValue(v)).length;
    if (typed === 0) box = [sent.box_mm[0], sent.box_mm[1], sent.box_mm[2]];
    else if (typed < 3) return { ok: false, reason: 'package_partial' };
    else {
      const pkg = validBox(axes[0], axes[1], axes[2]);
      if (!pkg || boxKey(pkg) !== boxKey(sent.box_mm)) return { ok: false, reason: 'package_differs' };
    }
  }
  const next: AppliedWire = {
    ...applied,
    inputs: applied.inputs.map((f) => (f.scope === 'base' && fields.includes(f.field) ? { ...f, source: 'product_package' as const } : f)),
  };
  return { ok: true, applied: next, package: { weight_g: weight, box }, fields };
}

/** What the confirmation can be asked of the measures now (§4.9; `GET /estimates/products/:id` `confirm_gate`). */
export interface MeasureGate {
  /** The SKUs a type default prices now (§4.9 step 1 refuses them), in key order. */
  defaulted: string[];
  /** The statement on offer — the base values those SKUs are priced from — and the SKUs it makes real; null when none can. */
  stated: { weight_g: number | null; box_mm: [number, number, number] | null; combo_keys: string[] } | null;
  /** Why the other defaulted SKUs cannot be stated real (the type's CBM, the package, a weight lighter than the product), or null. */
  blocked: Exclude<MeasureStatementRefusal, 'changed'> | null;
}

/**
 * The live answer the confirmation sheet asks before anything is sent: which SKUs are defaulted, which of them
 * the owner's statement of the shown values makes real (each measure they need judged alone, as
 * `attestBaseMeasures` judges it), and why the rest cannot be stated. A SKU whose CBM is the type's own CBM is
 * never made real by a statement (there is no box to state).
 */
export function measureGate(
  rows: readonly Partial<EstimateInputRow>[],
  skus: readonly EstimateSku[],
  applied: AppliedWire | null,
  dims: PhysicalDimensionOverrides | null | undefined
): MeasureGate {
  const needs = new Map<string, Array<'weight' | 'box' | 'cbm'>>();
  for (const s of skus) {
    const d = skuDefaultedFields(rows, s, applied);
    const need = [...(d.weight ? (['weight'] as const) : []), ...(d.cbm === 'shipping_box' ? (['box'] as const) : d.cbm === 'manual_cbm' ? (['cbm'] as const) : [])];
    if (need.length) needs.set(s.combo_key, need);
  }
  const defaulted = uniqueSorted(needs.keys());
  if (!defaulted.length) return { defaulted, stated: null, blocked: null };
  const value = (field: EstimateInputField) => applied?.inputs.find((f) => f.scope === 'base' && f.field === field)?.value;
  const weight = value('shipping_weight_g');
  const box = value('shipping_box');
  const verdicts = new Map<'weight' | 'box' | 'cbm', MeasureStatementRefusal | null>();
  const verdict = (need: 'weight' | 'box' | 'cbm'): MeasureStatementRefusal | null => {
    if (!verdicts.has(need)) {
      const sent: StatedMeasures | null =
        need === 'weight' && typeof weight === 'number' ? { weight_g: weight } : need === 'box' && Array.isArray(box) ? { box_mm: box as readonly [number, number, number] } : null;
      const a = need === 'cbm' || !sent ? null : attestBaseMeasures(rows, applied, dims, sent);
      verdicts.set(need, need === 'cbm' ? 'type_cbm' : !a ? 'changed' : a.ok ? null : a.reason);
    }
    return verdicts.get(need)!;
  };
  const real = defaulted.filter((k) => needs.get(k)!.every((n) => verdict(n) === null));
  const wanted = new Set(real.flatMap((k) => needs.get(k)!));
  // The reason the owner reads first: the type's CBM, then a package to complete, then a weight lighter than the
  // product (its cure is a real weight, which the refresh's apply of a package that differs would then take in too),
  // then a package that differs.
  const reasons = new Set(defaulted.filter((k) => !real.includes(k)).flatMap((k) => needs.get(k)!.map(verdict)));
  const blocked = (['type_cbm', 'package_partial', 'below_net', 'package_differs'] as const).find((r) => reasons.has(r)) ?? null;
  return {
    defaulted,
    stated: real.length
      ? {
          weight_g: wanted.has('weight') ? (weight as number) : null,
          box_mm: wanted.has('box') ? [...(box as readonly [number, number, number])] as [number, number, number] : null,
          combo_keys: real,
        }
      : null,
    blocked,
  };
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

  // The one rule, shared with the owner's statement of real measures (§4.9 step 0), which writes what this apply would.
  const measure_basis: EstimatePlan['measure_basis'] = measureBasisOf(skuPlans.map((p) => ({ weight: p.weight_source, cbm: p.cbm_source })));
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

/* ------------------------------------------------------ the profit ceiling -- */

/*
 * THE PROFIT CEILING (owner decisions 2026-11-05, DECISIONS row 291; docs/SMART_PRICING.md §4.11).
 *
 * The owner found the estimated prices too dear — one type's fixed minimum profit made a 3,862 IQD part sell at
 * 14,250 — and then ruled: «dont make 25% on all product . it called the smart pricing so priced from 0% to 25% or
 * 30 or 35 or even 50 and 100», «we want cheap price so we need to become cheapest iraqi supplier», «still nor
 * cheapest enough . more cheaper» (he chose ceilings of 3–10% per type), and «make the price for product be like
 * that 9.99$ , 19.99$ 24.99$ and ect …». A type may carry a profit ceiling P, 0 to 100% of cost
 * (`price_estimate_types.profit_cap_pct`), and each SKU then sells, from $5 up (`CHARM_MIN_USD`), at the highest
 * DOLLAR CHARM PRICE c ($x.99, the owner's grid) whose dinar price is at or under both today's price, rp(R + T × U),
 * and its cost plus P%, R × (1 + P/100), and whose profit over R keeps one rounding step (one dinar at or under 1,000
 * IQD) — so the route floor, rp(R), is cleared now and after any later rise of R or U, which FX-5 follows with T_sku
 * kept in dollars — else the lowest charm price that keeps it; under $5 (the grid's $0.50 step too coarse for the
 * cheapest prices) at the highest plain HOUSE PRICE D — 250 IQD steps, whole dinars at or under 1,000 — under the same
 * ceiling with the same margin, else the lowest that keeps it:
 *
 *     T_sku = floor6(c − R ÷ U)            in USD, so the engine's dollar price is c and its dinar price rp(c × U)
 *     T_sku = floor6((D − R) ÷ U)          under $5: the dinar price D, its dollar display D's own figure
 *
 * (`charmTarget`, ./charmPrice.ts, which holds the grid, the threshold, the choice and its exception: nothing goes up
 * while today's price clears the floor; a charm price whose dinar price is today's sells at it at c's own profit, so
 * its dollar figure is c — T stays there only where today's own figure already is c, or for a house price; an owner's
 * positive option or colour difference Δ stays on top: T_sku = floor6(c − R ÷ U − Δ), or floor6((D − R) ÷ U − Δ)).
 * At U = 1,600 the same 15 CNY part (R = 3,659.5) sells at 4,000 IQD ($2.50) under a 10% ceiling. A SKU whose price
 * is the owner's own fixed dollar price (a «سعر خاص $» on it or its model) keeps T: the ceiling leaves it alone.
 *
 * The ceiling lives in the estimator and reaches the engine as ordinary FIXED USD `target_profit` rules, so the
 * engine's own rules hold as they were: no percentage is stored in a rule, D − R ≥ T_sku is still asserted on
 * every write, and FX-5 never re-derives a ceiling — it keeps T_sku in dollars between applies; only the owner's
 * reviewed compute and apply move it (282(b)).
 *
 * THE LEAST SPECIFIC EXACT SCOPE, as the supplier compaction picks one (§4.4): one product rule when every SKU the
 * estimator prices takes the same profit (every single-SKU product); otherwise the product rule stays T and the
 * SKUs whose profit differs from it get rules on the values of ONE option group — two option rules of different
 * groups would tie, and a tie takes the maximum — else on their colours, else one per SKU. Each candidate is
 * resolved SKU by SKU with the engine's own `resolveRuleAt` over the rules as the write would leave them, and the
 * first exact one wins.
 *
 * NONE EXACT FITS THE WIRE (60 rows, or every candidate refused): ONE PROFIT PER GROUP — one product rule, the values
 * of one option group, or the colours. Each rule is the highest profit among the SKUs it reaches, so every one sells
 * at or above its own price's profit (some dollar prices leave the grid) — but where every SKU it reaches sells under
 * $5 at its plain house price it is the CHEAPEST of their profits, the highest at which none sells above its own
 * house price, whenever each keeps its margin there (a house price leaves no slack under the next step: the dearest
 * would lift the others a whole 250 IQD step), else the least that keeps each at or above its own price with its
 * margin. Never above T (today's price); every SKU whose profit is not its own keeps its margin at the price it
 * resolves to. The representation adding the least profit above the SKUs' own wins, then the one taking the least
 * under their own prices; the SKUs above their own are flagged EST_CEILING_SHARED (information). Not
 * even that fits: the product as it sells with no ceiling — today's rule at today's U, the very plan compute's first
 * evaluation priced — flagged the same, never blocked: a product today's rule prices is never held back.
 *
 * TODAY'S PLAN UNLESS THE NEW ONE COSTS NOTHING (the lead's ruling for the owner, 2026-11-05). A SKU whose charm price
 * sells at today's very dinar price kept T until then; it now takes c's own profit, so the storefront shows c at the
 * same dinar price — one more rule to write now, and to take back in a later wire. Past the wire's 60 rows those extra
 * rules would push the product to one profit per group or to no ceiling at all, and lift a sibling the ceiling sells
 * under today's price back up to it; left on the record they count against every later plan, which then shares a
 * profit, or blocks with EST_TOO_MANY_SCOPES, where today's rules would have fitted. So the planner first plans today's
 * targets (each such SKU at T, `keepToday`) and takes the new targets only
 *   - on a product of at most 19 SKUs (`MAX_SKUS_SHOWING_C_AT_TODAY`, every SKU of the grid counted, the owner's too): a
 *     write is at most the product's own row, one rule per SKU it wants and one per SKU of the last apply to take back,
 *     so those rules on the record can never be what passes the wire at a later compute — not even with the grid doubled
 *     in between (3 × 19 + 1 rows); and
 *   - when both plans resolve every SKU to exactly its own target within the wire — every dinar price the same, the
 *     moved SKUs' dollar figures c.
 * Otherwise today's plan stands, byte for byte, and a larger product never records such a rule: no dinar price moves
 * for a dollar figure. (The bound's one limit: a product of at most 19 SKUs carrying such rules that jumps past 40 SKUs
 * between two computes, its next plan needing so many rules of its own that their sum passes the wire — §4.11.)
 *
 * AT THE R AND U OF THE APPLY. "The same dinar price" holds there. Between applies FX-5 prices R + T_sku × U at each new
 * rate, so a SKU on c's profit sits (T_sku − T) × U from what T would have sold it at — under one rounding step at the
 * apply's rate, either side: the same dinar price or one 250 IQD step from it (two only after a rise of U, rarely: a
 * T_sku almost a full step from T), its dollar figure still c while its cost follows the dollar — until the next compute
 * and apply, which read R at T and price it exactly as today's plan does (§4.11, «The route floor and FX-5»).
 *
 * EACH SKU'S COST R comes from compute's first evaluation, which prices the product as it sells with NO ceiling:
 * this planner with no P (every SKU the estimator prices at T, the ceiling's own scope rules of the last apply back
 * to inherit). Priced with those rules still in force, a SKU whose cost moved past its rounding step since its last
 * apply could close its own route (the rule then no longer clears it: V2_ROUTE_BELOW_COST), leave no R, and never
 * be priced again.
 *
 * OWNER RULES WIN (§4.5). Estimator and owner rules look alike in `pricing_rules`; only the record tells them
 * apart, by value (`applied_wire_json.minimum_profit_scopes`, beside the product's `minimum_profit`). A SKU an
 * owner's option, colour or SKU rule reaches — or one whose ceiling rule the owner cleared — is the owner's: no
 * estimator rule at those levels ever reaches it (at the same level it would tie, more specific it would
 * override); only the product rule does, which the owner's rule shadows. An owner's product rule means no profit
 * amount is written at all, and the ceiling's own scope rules go back to inherit, so his rule decides every SKU as
 * it did before the ceiling (the rollback of a ceiling the same way).
 */

/** At most this many minimum-profit rows one wire takes (`MAX_RULES_PER_WRITE`, worker/lib/pricingEngine/ownerRules.ts). */
export const MAX_ESTIMATE_PROFIT_ROWS = 60;
/**
 * The most SKUs a product may have for a charm price at today's dinar price to show c (see the section header): 3N + 1 ≤
 * 60 — the product's own row, N rules of the last apply to take back and 2N rules for a grid that doubled since. So
 * those rules on the record can never be what passes the wire at a later compute.
 */
export const MAX_SKUS_SHOWING_C_AT_TODAY = Math.floor((MAX_ESTIMATE_PROFIT_ROWS - 1) / 3);
/** A profit ceiling is a percentage of cost from 0 to this much (the 0222 CHECK). */
export const MAX_PROFIT_CAP_PCT = 100;
/** …with at most this many decimals. */
export const PROFIT_CAP_DECIMALS = 2;

/** A profit ceiling as the 0222 column takes it, canonical ('0', '6', '37.5', '100'), or null: no sign, no exponent, no comma. */
export function canonicalProfitCapPct(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(raw.trim());
  if (!m) return null;
  const int = m[1]!.replace(/^0+(?=[0-9])/, '');
  const fraction = (m[2] ?? '').replace(/0+$/, '');
  if (int.length > 3 || fraction.length > PROFIT_CAP_DECIMALS) return null;
  if (Number(int) > MAX_PROFIT_CAP_PCT || (Number(int) === MAX_PROFIT_CAP_PCT && fraction)) return null;
  return fraction ? `${int}.${fraction}` : int;
}

/**
 * ONE SKU'S MINIMUM PROFIT UNDER THE CEILING, canonical USD text: the type's T itself when today's price stays as it
 * shows (nothing goes up, or the chosen price is today's and already shows its dollar figure — c itself, or a house
 * price), else floor6(c − R ÷ U − Δ⁺) for its dollar charm price c from $5 up — today's own dinar price included, its
 * dollar figure then c —, floor6((D − R) ÷ U − Δ⁺) for its house price D under it — see `charmTarget`. R is the
 * engine's exact replacement cost on the SKU's route (`replacement_exact`), U the USD/IQD the price is computed at, Δ
 * the SKU's option and colour differences as the engine adds them (`deltas_usd`, signed; absent: none). Null when a
 * figure does not read: nothing is guessed. One SKU alone: the planner still keeps T for a charm price at today's
 * dinar price unless its product has at most 19 SKUs and its new plan and today's are both exact (`planEstimateProfits`).
 */
export function ceilingProfitUsd(minProfitUsd: unknown, ceilingPct: unknown, costExact: unknown, usdIqd: unknown, differenceUsd?: unknown): string | null {
  return ceilingTargetOf(minProfitUsd, ceilingPct, costExact, usdIqd, differenceUsd)?.amount_usd ?? null;
}

/** `ceilingProfitUsd` with how the price was chosen (`charmTarget`'s basis), that price and today's, IQD. */
function ceilingTargetOf(
  minProfitUsd: unknown,
  ceilingPct: unknown,
  costExact: unknown,
  usdIqd: unknown,
  differenceUsd?: unknown
): { amount_usd: string; basis: CharmBasis; price_iqd: number; today_iqd: number } | null {
  const t = canonicalUsdRuleAmount(minProfitUsd);
  const p = canonicalProfitCapPct(ceilingPct);
  if (t === null || p === null || typeof costExact !== 'string' || typeof usdIqd !== 'string') return null;
  if (differenceUsd !== undefined && differenceUsd !== null && typeof differenceUsd !== 'string') return null;
  const target = charmTarget({ cost_iqd: costExact, usd_iqd: usdIqd, min_profit_usd: t, ceiling_pct: p, difference_usd: differenceUsd ?? null });
  if (!target) return null;
  // Today's price keeps the type's T as the type spells it, so its rule is byte for byte the one it replaces.
  const amount = target.basis === 'today' ? t : canonicalUsdRuleAmount(target.amount_usd);
  return amount === null ? null : { amount_usd: amount, basis: target.basis, price_iqd: target.price_iqd, today_iqd: target.today_iqd };
}

/** The levels a minimum-profit rule below the product's sits at (`pricing_rules.scope`). */
export type ProfitScope = 'option' | 'color' | 'sku';
const PROFIT_SCOPE_RANK: Readonly<Record<ProfitScope, number>> = { option: 0, color: 1, sku: 2 };
const isProfitScope = (v: unknown): v is ProfitScope => v === 'option' || v === 'color' || v === 'sku';
const profitKey = (scope: string, scopeId: string) => `${scope}\u0000${scopeId}`;

function byProfitScope(a: { scope: ProfitScope; scope_id: string }, b: { scope: ProfitScope; scope_id: string }): number {
  return PROFIT_SCOPE_RANK[a.scope] - PROFIT_SCOPE_RANK[b.scope] || (a.scope_id < b.scope_id ? -1 : a.scope_id > b.scope_id ? 1 : 0);
}

/** One `target_profit` rule of the product as stored (`read.stored.rules`), at any scope; scopes other than these four are ignored. */
export interface EstimateProfitRule {
  scope: string;
  scope_id: string;
  state: string;
  amount_usd?: string | null;
  amount_iqd?: number | null;
}

/** One row of the form's `cost.minimum_profit` (v2/api.ts `minimumProfitRules`): `amount_usd` null is INHERIT. */
export interface EstimateProfitRow {
  kind: 'target_profit';
  scope: 'product' | ProfitScope;
  scope_id?: string;
  amount_usd: string | null;
}

/** One rule the profit cap wrote below the product (`applied_wire_json.minimum_profit_scopes`). */
export interface AppliedProfitScope {
  scope: ProfitScope;
  scope_id: string;
  amount_usd: string;
  source: EstimateValueSource;
}

/** The record's scope rules, read defensively: an entry that does not parse is dropped, so its rule reads as the owner's and is kept. */
function parseProfitScopes(raw: unknown): AppliedProfitScope[] {
  const out: AppliedProfitScope[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const amount = typeof e.amount_usd === 'string' ? canonicalUsdRuleAmount(e.amount_usd) : null;
    if (!isProfitScope(e.scope) || typeof e.scope_id !== 'string' || !e.scope_id || !amount || !isValueSource(e.source)) continue;
    const k = profitKey(e.scope, e.scope_id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ scope: e.scope, scope_id: e.scope_id, amount_usd: amount, source: e.source });
  }
  return out.sort(byProfitScope);
}

/** A stored rule's value as the merge compares it — step 4's reading: null when absent or INHERIT. */
function profitRuleValue(rule: EstimateProfitRule | null | undefined): string | null {
  if (!rule || rule.state === 'INHERIT') return null;
  if (rule.state === 'ACTIVE' && rule.amount_usd != null) return canonicalUsdRuleAmount(rule.amount_usd) ?? `raw:${rule.amount_usd}`;
  if (rule.state === 'ACTIVE' && rule.amount_iqd != null) return `iqd:${rule.amount_iqd}`;
  return `state:${rule.state}`;
}

/** The product the verification's rule rows name (they are this product's alone). */
const PROFIT_RULE_PRODUCT = 'product';

/** The product's rules as an apply of these rows leaves them, as the engine's resolver reads rules. */
function profitRulesAfter(rules: readonly EstimateProfitRule[], rows: readonly EstimateProfitRow[]): PricingRuleRow[] {
  const at = new Map<string, PricingRuleRow>();
  const put = (id: string, scope: 'product' | ProfitScope, scopeId: string, state: string, usd: string | null, iqd: number | null) =>
    at.set(profitKey(scope, scopeId), {
      id,
      kind: 'target_profit',
      scope,
      catalog_id: null,
      product_id: PROFIT_RULE_PRODUCT,
      scope_id: scopeId,
      state: state as PricingRuleState,
      amount_usd: usd,
      amount_iqd: iqd,
      version: 1,
    });
  rules.forEach((r, i) => {
    if (r.scope === 'product') put(`stored:${i}`, 'product', '', r.state, r.amount_usd ?? null, r.amount_iqd ?? null);
    else if (isProfitScope(r.scope) && r.scope_id) put(`stored:${i}`, r.scope, r.scope_id, r.state, r.amount_usd ?? null, r.amount_iqd ?? null);
  });
  for (const w of rows) {
    const scopeId = w.scope === 'product' ? '' : (w.scope_id ?? '');
    put(`written:${profitKey(w.scope, scopeId)}`, w.scope, scopeId, w.amount_usd === null ? 'INHERIT' : 'ACTIVE', w.amount_usd, null);
  }
  return [...at.values()];
}

export interface EstimateProfitInput {
  skus: readonly EstimateSku[];
  /** Each SKU's exact replacement cost R on its route (`replacement_exact`), from the engine's own first evaluation. */
  costs: ReadonlyMap<string, string> | Readonly<Record<string, string | null | undefined>>;
  /** U, the USD/IQD the engine prices at (exact text). */
  usd_iqd: string | null;
  /** The type's T and its profit ceiling P, 0–100% of cost (null or absent: no ceiling). */
  min_profit_usd: string | null;
  profit_cap_pct?: string | null;
  /** Every stored `target_profit` rule of the product, at any scope. */
  rules: readonly EstimateProfitRule[];
  /** The stored `applied_wire_json` (text or parsed); null before the first apply. */
  applied?: unknown;
  /** Option value id → its group id; an absent value belongs to the one implicit group ''. */
  option_groups?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** The scope ids a rule may name (the ids `desiredFor` checks); left out, the SKUs' own. */
  scopes?: EstimateScopeIds;
  /**
   * Each SKU's option and colour differences Σ ± (USD, signed; `deltas_usd`) as that same evaluation priced them;
   * absent: none. The engine adds a positive sum on top of R + T × U, so the ceiling's price counts it (§4.11).
   */
  differences?: ReadonlyMap<string, string> | Readonly<Record<string, string | null | undefined>>;
  /**
   * The SKUs whose price is the owner's own fixed dollar price — a «سعر خاص $» on the SKU or its model (the
   * evaluation's anchor `sku_fixed` / `model_fixed`): the minimum profit is only their floor, so they keep T.
   */
  fixed?: Iterable<string>;
}

export interface EstimateProfitTarget {
  combo_key: string;
  amount_usd: string;
  /** Not the type's T: the ceiling's price (a charm price from $5 up, the house price under it) decides this SKU's profit. */
  capped: boolean;
}

/** The information flag of a representation dearer than the ceiling's own prices (§4.11): never blocking. */
export const CEILING_SHARED_FLAG = 'EST_CEILING_SHARED';

export interface EstimateProfitPlan {
  /**
   * `none`      no cap and no rule the cap ever wrote: the estimate is today's, byte for byte;
   * `owner`     the product's own minimum profit is the owner's (or its type has none): no profit amount is
   *             written; the cap's own scope rules go back to inherit (`rows`), so his product rule decides every
   *             SKU as it did before the cap (none with a type that has no T: blocked, nothing moves);
   * `unpriced`  a SKU the estimator prices has no cost even at the type's T, or U is missing — the evaluation is
   *             incomplete or blocked: nothing is capped from a guess;
   * `planned`   the representation below — exact, or (none exact fitting the wire) one profit per group, its SKUs
   *             above their own flagged EST_CEILING_SHARED;
   * `uncapped`  not even that fits: the product as it sells with no ceiling (today's rule at today's U), flagged
   *             EST_CEILING_SHARED — information, never blocking;
   * `too_many`  not even the product with no ceiling can be written: EST_TOO_MANY_SCOPES (blocking).
   * `unpriced`, `uncapped` and `too_many` plan no ceiling: their rows and record are the product as it sells with no
   * ceiling (this planner with no P, the plan compute's first evaluation priced), or the plan's own when that cannot
   * be written.
   */
  kind: 'none' | 'owner' | 'unpriced' | 'planned' | 'uncapped' | 'too_many';
  /** Where the capped profits are written: the product rule alone, one option group, the colours, or each SKU. */
  level: 'product' | 'option' | 'color' | 'sku' | null;
  group_id: string | null;
  /** The product rule's amount (planned only). */
  product_usd: string | null;
  /** Each SKU the estimator prices (the owner's left out), with its minimum profit. */
  targets: EstimateProfitTarget[];
  /** The SKUs an owner's rule holds (combo keys). */
  held: string[];
  /** The wire's rows: the product's first when it moves, then each scope's (null clears). Empty: nothing moves. */
  rows: EstimateProfitRow[];
  /** The record's product rule after an apply (planned, or the uncapped plan nothing planned falls back to); undefined keeps the plan's. */
  minimum_profit: AppliedWire['minimum_profit'] | undefined;
  /** The record's scope rules after an apply: the cap's, and every one the owner holds or the wire cannot name. */
  scopes: AppliedProfitScope[];
  flags: EstimateFlag[];
  owner_held: Array<{ scope: ProfitScope; scope_id: string; field: typeof MINIMUM_PROFIT_FIELD }>;
}

/**
 * The plans step 5 returns — every SKU the estimator prices resolves to exactly its own target within the wire's 60
 * rows — each with whether a SKU's target kept T for a charm price at today's dinar price (`planProfits`' `keepToday`).
 * Read by `planEstimateProfits` alone: a plan's own shape is the same either way.
 */
const EXACT_PLANS = new WeakMap<EstimateProfitPlan, { keptToday: boolean }>();

/**
 * THE MINIMUM PROFIT OF EVERY SKU UNDER THE CEILING, AS RULES (see the section header): each SKU's target, the least
 * specific exact representation, merged rule by rule against the record — the estimator's rewritten or cleared,
 * the owner's kept (EST_OWNER_EDITED, field names only) — as the wire's rows and the record an apply stores.
 *
 * TODAY'S PLAN FIRST (see the section header): each SKU whose charm price sells at today's dinar price at T, as
 * before the ruling of 2026-11-05. Only on a product of at most 19 SKUs whose plan is exact and kept such a SKU at T is
 * the new one planned — those SKUs at c's own profit — and it is taken only when it is exact too; otherwise today's
 * plan stands as it is.
 */
export function planEstimateProfits(input: EstimateProfitInput): EstimateProfitPlan {
  const today = planProfits(input, true);
  // Too large for those rules, not exact, or no SKU kept at T for today's dinar price (the new plan would be this one).
  if (input.skus.length > MAX_SKUS_SHOWING_C_AT_TODAY || !EXACT_PLANS.get(today)?.keptToday) return today;
  const next = planProfits(input, false);
  return EXACT_PLANS.has(next) ? next : today;
}

/** `planEstimateProfits`, each SKU whose charm price sells at today's dinar price at T (`keepToday`) or at c's own profit. */
function planProfits(input: EstimateProfitInput, keepToday: boolean): EstimateProfitPlan {
  const applied = parseAppliedWire(input.applied);
  const records = applied?.minimum_profit_scopes ?? [];
  const cap = input.profit_cap_pct === null || input.profit_cap_pct === undefined ? null : canonicalProfitCapPct(input.profit_cap_pct);
  const out: EstimateProfitPlan = { kind: 'none', level: null, group_id: null, product_usd: null, targets: [], held: [], rows: [], minimum_profit: undefined, scopes: records, flags: [], owner_held: [] };
  if (cap === null && !records.length) return out;

  const { skus } = input;
  const comboOf = (s: EstimateSku) => skuComboKey({ option_value_ids: s.option_value_ids, color_id: s.color_id });
  const reaches = (scope: ProfitScope, scopeId: string, s: EstimateSku): boolean =>
    scope === 'option' ? s.option_value_ids.includes(scopeId) : scope === 'color' ? s.color_id === scopeId : comboOf(s) === scopeId;

  // 1. Who holds each rule below the product (§4.5's reading, rule by rule).
  const stored = new Map<string, EstimateProfitRule & { scope: ProfitScope }>();
  for (const r of input.rules) if (isProfitScope(r.scope) && r.scope_id) stored.set(profitKey(r.scope, r.scope_id), r as EstimateProfitRule & { scope: ProfitScope });
  const recorded = new Map(records.map((f) => [profitKey(f.scope, f.scope_id), f] as const));
  const holderOf = (k: string): 'estimator' | 'owner' | 'cleared' | 'empty' => {
    const value = profitRuleValue(stored.get(k));
    const record = recorded.get(k);
    if (record) return value === record.amount_usd ? 'estimator' : value === null ? 'cleared' : 'owner';
    return value === null ? 'empty' : 'owner';
  };
  // The owner's SKUs: an owner's live rule reaches them (it decides before the product's: `shadowed`), or the owner
  // cleared the cap's rule that reached them (they fall to the product's rule, which then never carries a cap).
  const held = new Set<string>();
  const shadowed = new Set<string>();
  let ownerEdited = false;
  for (const k of uniqueSorted([...stored.keys(), ...recorded.keys()])) {
    const holder = holderOf(k);
    if (holder === 'estimator' || holder === 'empty') continue;
    const at = (recorded.get(k) ?? stored.get(k))!;
    if (recorded.has(k)) ownerEdited = true;
    else out.owner_held.push({ scope: at.scope, scope_id: at.scope_id, field: MINIMUM_PROFIT_FIELD });
    for (const s of skus) {
      if (!reaches(at.scope, at.scope_id, s)) continue;
      held.add(s.combo_key);
      if (holder === 'owner') shadowed.add(s.combo_key);
    }
  }
  out.held = uniqueSorted(held);
  out.owner_held.sort(byProfitScope);
  if (ownerEdited) out.flags.push({ code: 'EST_OWNER_EDITED', fields: [MINIMUM_PROFIT_FIELD] });
  // The ids a rule may name on this product: a rule at any other id would be refused by the wire's parser.
  const fromSkus = {
    option: new Set(skus.flatMap((s) => s.option_value_ids.filter(Boolean))),
    color: new Set(skus.map((s) => s.color_id).filter((c): c is string => !!c)),
    sku: new Set(skus.map(comboOf).filter(Boolean)),
  };
  const sets: Record<ProfitScope, Set<string>> = {
    option: input.scopes?.option ? new Set(input.scopes.option) : fromSkus.option,
    color: input.scopes?.color ? new Set(input.scopes.color) : fromSkus.color,
    sku: input.scopes?.sku ? new Set(input.scopes.sku) : fromSkus.sku,
  };
  const tooMany: EstimateFlag = { code: 'EST_TOO_MANY_SCOPES', fields: [MINIMUM_PROFIT_FIELD] };

  // 2. The product's own rule: the estimator's or empty exactly as step 4 of `planEstimateInputs` reads it. A type
  //    with no minimum profit (EST_TYPE_INCOMPLETE, blocking) writes nothing and carries the record's rules.
  const typeProfit = canonicalUsdRuleAmount(input.min_profit_usd);
  const productValue = profitRuleValue(input.rules.find((r) => r.scope === 'product'));
  const productRecord = applied?.minimum_profit ?? null;
  const productOurs = productRecord ? productValue === productRecord.amount_usd : productValue === null;
  if (typeProfit === null) return { ...out, kind: 'owner' };
  if (!productOurs) {
    // The owner's own product rule: no profit amount is written, and it decides every SKU as it did before the cap.
    // So the cap's own option, colour and SKU rules — which would still decide their SKUs before his rule, and which
    // the product form does not draw — go back to inherit and leave the record; his own rules, a rule he cleared and
    // one the wire can no longer name are kept as they are.
    const back = records.filter((f) => holderOf(profitKey(f.scope, f.scope_id)) === 'estimator' && sets[f.scope].has(f.scope_id));
    if (back.length > MAX_ESTIMATE_PROFIT_ROWS) return { ...out, kind: 'too_many', flags: [...out.flags, tooMany] };
    return {
      ...out,
      kind: 'owner',
      rows: back.map((f) => ({ kind: 'target_profit' as const, scope: f.scope, scope_id: f.scope_id, amount_usd: null })),
      scopes: records.filter((f) => !back.includes(f)),
    };
  }

  // Nothing planned — a SKU with no cost to cap from, or no representation the wire takes: the product is priced as
  // it sells with no cap (this planner with no P: every SKU the estimator prices at T, the cap's own scope rules back
  // to inherit) — the very plan compute's first evaluation priced, so that evaluation stands and blocks it. When even
  // that cannot be written, the plan's own wire and the record's rules are kept.
  const unplanned = (kind: 'unpriced' | 'too_many', flags: EstimateFlag[]): EstimateProfitPlan => {
    const uncapped = cap === null ? null : planEstimateProfits({ ...input, profit_cap_pct: null });
    const back = uncapped?.kind === 'planned' ? uncapped : null;
    return { ...out, kind, flags, ...(back ? { rows: back.rows, minimum_profit: back.minimum_profit, scopes: back.scopes } : {}) };
  };

  // 3. Each SKU the estimator prices, its target: T, or under the ceiling its own price's profit — a dollar charm price
  //    from $5 up, the house price under it (`charmTarget`, its own differences counted) — T for a SKU the owner prices
  //    himself in dollars, whose minimum profit is only its floor (the ceiling leaves his price alone). A charm price
  //    whose dinar price is today's: c's own profit, or T in today's plan (`keepToday`) — the same dinar price.
  const free = skus.filter((s) => !held.has(s.combo_key));
  const fixed = new Set(input.fixed ?? []);
  const targets = new Map<string, string>();
  // The SKUs priced under $5 at their plain house price (`charmTarget`'s `plain`), with that price: the only ones a
  // shared rule may price under their own price (step 6).
  const plainPrice = new Map<string, number>();
  let keptToday = false;
  for (const s of free) {
    if (cap === null || fixed.has(s.combo_key)) {
      targets.set(s.combo_key, typeProfit);
      continue;
    }
    const x = ceilingTargetOf(typeProfit, cap, lookup<string>(input.costs, s.combo_key), input.usd_iqd, lookup<string>(input.differences, s.combo_key));
    if (x === null) return unplanned('unpriced', out.flags);
    const kept = keepToday && x.basis === 'charm' && x.price_iqd === x.today_iqd;
    if (kept) keptToday = true;
    targets.set(s.combo_key, kept ? typeProfit : x.amount_usd);
    if (x.basis === 'plain') plainPrice.set(s.combo_key, x.price_iqd);
  }
  out.targets = free.map((s) => ({ combo_key: s.combo_key, amount_usd: targets.get(s.combo_key)!, capped: targets.get(s.combo_key) !== typeProfit }));

  // 4. The candidates, least specific first.
  interface Candidate {
    level: Exclude<EstimateProfitPlan['level'], null>;
    group_id: string | null;
    product: string;
    wanted: Map<string, AppliedProfitScope>;
  }
  const candidates: Candidate[] = [];
  const amounts = uniqueSorted(targets.values());
  const clearedOnly = [...held].some((k) => !shadowed.has(k));
  // The option groups of the SKUs the estimator prices, in relation order (the model's first), and a SKU's one value in each.
  const groupOf = (id: string): string => lookup<string>(input.option_groups, id) ?? '';
  const valueIn = (g: string) => (s: EstimateSku): string | null => {
    const values = s.option_value_ids.filter((id) => id && groupOf(id) === g);
    return values.length === 1 ? values[0]! : null;
  };
  const groupsOf = (list: readonly EstimateSku[]): string[] => {
    const out: string[] = [];
    for (const s of list) for (const id of s.option_value_ids.filter(Boolean)) if (!out.includes(groupOf(id))) out.push(groupOf(id));
    return out;
  };
  if (amounts.length <= 1 && (!amounts.length || amounts[0] === typeProfit || !clearedOnly)) {
    candidates.push({ level: 'product', group_id: null, product: amounts[0] ?? typeProfit, wanted: new Map() });
  } else {
    const capped = free.filter((s) => targets.get(s.combo_key) !== typeProfit);
    // One rule per id, each the profit of every capped SKU it names — or no such candidate.
    const by = (scope: ProfitScope, idOf: (s: EstimateSku) => string | null): Map<string, AppliedProfitScope> | null => {
      const wanted = new Map<string, AppliedProfitScope>();
      for (const s of capped) {
        const id = idOf(s);
        if (!id) return null;
        const amount = targets.get(s.combo_key)!;
        const k = profitKey(scope, id);
        const seen = wanted.get(k);
        if (seen && seen.amount_usd !== amount) return null;
        wanted.set(k, { scope, scope_id: id, amount_usd: amount, source: 'type_default' });
      }
      return wanted;
    };
    // ONE option group, in relation order (the model's first), fewest rules first.
    const options = groupsOf(capped)
      .flatMap((g, order) => {
        const wanted = by('option', valueIn(g));
        return wanted ? [{ g, order, wanted }] : [];
      })
      .sort((a, b) => a.wanted.size - b.wanted.size || a.order - b.order);
    for (const o of options) candidates.push({ level: 'option', group_id: o.g, product: typeProfit, wanted: o.wanted });
    const colours = by('color', (s) => s.color_id);
    if (colours) candidates.push({ level: 'color', group_id: null, product: typeProfit, wanted: colours });
    const own = by('sku', (s) => comboOf(s) || null);
    if (own) candidates.push({ level: 'sku', group_id: null, product: typeProfit, wanted: own });
  }

  // 5. The first candidate that merges, fits the wire and resolves every SKU exactly.
  const merge = (c: Candidate, accept: (s: EstimateSku, amount: string) => boolean): { rows: EstimateProfitRow[]; records: AppliedProfitScope[]; amounts: Map<string, string> } | null => {
    for (const w of c.wanted.values()) {
      // Never at a scope the wire may not name or the owner holds, never reaching a SKU the owner holds.
      if (!sets[w.scope].has(w.scope_id)) return null;
      const holder = holderOf(profitKey(w.scope, w.scope_id));
      if (holder === 'owner' || holder === 'cleared') return null;
      if (skus.some((s) => held.has(s.combo_key) && reaches(w.scope, w.scope_id, s))) return null;
    }
    const scopeRows: Array<EstimateProfitRow & { scope: ProfitScope; scope_id: string }> = [];
    const next: AppliedProfitScope[] = [];
    for (const k of uniqueSorted([...recorded.keys(), ...c.wanted.keys()])) {
      const want = c.wanted.get(k);
      const record = recorded.get(k);
      const holder = holderOf(k);
      if (want) {
        if (!(holder === 'estimator' && record!.amount_usd === want.amount_usd)) scopeRows.push({ kind: 'target_profit', scope: want.scope, scope_id: want.scope_id, amount_usd: want.amount_usd });
        next.push(want);
      } else if (holder === 'estimator' && sets[record!.scope].has(record!.scope_id)) {
        // The cap's own rule, no longer wanted: back to inherit.
        scopeRows.push({ kind: 'target_profit', scope: record!.scope, scope_id: record!.scope_id, amount_usd: null });
      } else if (record) {
        // The owner's (changed or cleared), or at a scope the product no longer offers: kept, never cleared through the wire.
        next.push(record);
      }
    }
    const rows: EstimateProfitRow[] = [...(productValue === c.product ? [] : [{ kind: 'target_profit' as const, scope: 'product' as const, amount_usd: c.product }]), ...scopeRows.sort(byProfitScope)];
    if (rows.length > MAX_ESTIMATE_PROFIT_ROWS) return null;
    // Every SKU the estimator prices resolves, through the engine's own walk over the rules as the write leaves
    // them, to a profit the candidate accepts — no tie, nothing else deciding.
    const rules = profitRulesAfter(input.rules, rows);
    const resolved = new Map<string, string>();
    for (const s of free) {
      const r = resolveRuleAt(rules, 'target_profit', { product_id: PROFIT_RULE_PRODUCT, option_value_ids: s.option_value_ids, color_id: s.color_id, ancestry: [] }, { usdIqdRate: input.usd_iqd });
      const amount = r.status === 'active' && !r.tie ? r.amount_usd : null;
      if (typeof amount !== 'string' || !accept(s, amount)) return null;
      resolved.set(s.combo_key, amount);
    }
    return { rows, records: next.sort(byProfitScope), amounts: resolved };
  };
  const planned = (c: Candidate, merged: NonNullable<ReturnType<typeof merge>>): EstimateProfitPlan => ({
    ...out,
    kind: 'planned',
    level: c.level,
    group_id: c.group_id,
    product_usd: c.product,
    rows: merged.rows,
    minimum_profit: { amount_usd: c.product, source: 'type_default' },
    scopes: merged.records,
  });
  for (const c of candidates) {
    const merged = merge(c, (s, amount) => amount === targets.get(s.combo_key));
    if (!merged) continue;
    // Exact: `planEstimateProfits` weighs today's plan against the new one by this.
    const exact = planned(c, merged);
    EXACT_PLANS.set(exact, { keptToday });
    return exact;
  }
  if (cap === null) return unplanned('too_many', [...out.flags, tooMany]);

  // 6. None exact fits the wire: ONE PROFIT PER GROUP (§4.11) — one product rule, the values of one option group, or
  //    the colours (a value whose SKUs would all take T, or one reaching an owner's SKU, gets no rule: its SKUs fall
  //    to the product's T). Each rule is the DEAREST target among the SKUs it reaches, so every one sells at or above
  //    its own price's profit (its dollar price may leave the grid) — except where every SKU it reaches sells under $5
  //    at its plain house price: there it is the CHEAPEST of their targets, the highest profit at which none sells
  //    above its own house price, whenever each still keeps its margin there (a dearer one would lift a house price
  //    that leaves no slack under the next step a whole step), else the least profit that keeps each at or above its
  //    own house price with its margin (a group across 1,000 IQD). No SKU resolves above T, today's price (above it only
  //    where its own target already is), none from $5 up under its own target, and each whose profit is not its own
  //    keeps its margin at the price it resolves to (today's price excepted). The candidate adding the least profit
  //    above the SKUs' own wins, then the one taking the least under their own prices, then the fewest rows, then the
  //    least specific. EST_CEILING_SHARED names the SKUs above their own.
  const micro = (usd: string): bigint => {
    const [whole, fraction = ''] = usd.split('.');
    return BigInt(whole!) * 1_000_000n + BigInt(`${fraction}000000`.slice(0, 6));
  };
  const usdOf = (m: bigint): string => canonicalUsdRuleAmount(`${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, '0')}`)!;
  const typeMicro = micro(typeProfit);
  const own = (s: EstimateSku): bigint => micro(targets.get(s.combo_key)!);
  // The engine's price at a profit, and whether its margin holds there — the SKU's own R and differences.
  const at = (s: EstimateSku, m: bigint) =>
    priceAtProfit({ cost_iqd: lookup<string>(input.costs, s.combo_key) ?? '', usd_iqd: input.usd_iqd ?? '', difference_usd: lookup<string>(input.differences, s.combo_key) }, usdOf(m));
  const within = (s: EstimateSku, amount: string): boolean => {
    const a = micro(amount);
    const least = own(s);
    if (a === least) return true;
    // Never above today's price (above it only where its own target already is); from $5 up never under its own.
    if (a > (least > typeMicro ? least : typeMicro) || (a < least && !plainPrice.has(s.combo_key))) return false;
    // Today's price itself, or any other profit whose margin holds at the price it resolves to.
    return (a === typeMicro && a > least) || at(s, a)?.keeps === true;
  };
  // The least profit at which a SKU priced under $5 still sells at its own house price with its margin: every profit
  // from it to its own target does (one price, a margin that grows with the profit), every lower one does not.
  const leastAtOwn = (s: EstimateSku): bigint => {
    const price = plainPrice.get(s.combo_key)!;
    let lo = 1n;
    let hi = own(s);
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const x = at(s, mid);
      if (x !== null && x.price_iqd === price && x.keeps) hi = mid;
      else lo = mid + 1n;
    }
    return hi;
  };
  // One group's profit: the dearest of its SKUs' own. Under $5 (every SKU it reaches at its plain house price) the
  // cheapest — none above its own price — when every one keeps its margin there; else the least that keeps every one
  // at or above its own price, when every one keeps its margin there; else the dearest.
  const groupMicro = (list: readonly EstimateSku[]): bigint => {
    const owns = list.map(own);
    const dearest = owns.reduce((a, b) => (a > b ? a : b));
    if (!list.every((s) => plainPrice.has(s.combo_key))) return dearest;
    const cheapest = owns.reduce((a, b) => (a < b ? a : b));
    if (list.every((s) => own(s) === cheapest || at(s, cheapest)?.keeps === true)) return cheapest;
    const least = list.map(leastAtOwn).reduce((a, b) => (a > b ? a : b));
    return list.every((s) => least <= own(s) || at(s, least)?.keeps === true) ? least : dearest;
  };
  const sharedBy = (scope: ProfitScope, idOf: (s: EstimateSku) => string | null): Map<string, AppliedProfitScope> => {
    const members = new Map<string, EstimateSku[]>();
    for (const s of free) {
      const id = idOf(s);
      if (id) members.set(id, [...(members.get(id) ?? []), s]);
    }
    const wanted = new Map<string, AppliedProfitScope>();
    for (const [id, list] of members) {
      const m = groupMicro(list);
      if (m === typeMicro || skus.some((x) => held.has(x.combo_key) && reaches(scope, id, x))) continue;
      wanted.set(profitKey(scope, id), { scope, scope_id: id, amount_usd: usdOf(m), source: 'type_default' });
    }
    return wanted;
  };
  const shared: Candidate[] = [];
  if (!clearedOnly && free.length) shared.push({ level: 'product', group_id: null, product: usdOf(groupMicro(free)), wanted: new Map() });
  for (const g of groupsOf(free)) shared.push({ level: 'option', group_id: g, product: typeProfit, wanted: sharedBy('option', valueIn(g)) });
  shared.push({ level: 'color', group_id: null, product: typeProfit, wanted: sharedBy('color', (s) => s.color_id) });
  let best: { c: Candidate; merged: NonNullable<ReturnType<typeof merge>>; over: bigint; under: number } | null = null;
  for (const c of shared) {
    const merged = merge(c, within);
    if (!merged) continue;
    // The profit added above the SKUs' own (USD millionths), then the dinars taken under their own prices (under $5).
    let over = 0n;
    let under = 0;
    for (const s of free) {
      const a = micro(merged.amounts.get(s.combo_key)!);
      if (a > own(s)) over += a - own(s);
      else if (a < own(s)) under += plainPrice.get(s.combo_key)! - at(s, a)!.price_iqd;
    }
    const better = !best || over < best.over || (over === best.over && (under < best.under || (under === best.under && merged.rows.length < best.merged.rows.length)));
    if (better) best = { c, merged, over, under };
  }
  if (best) {
    const { amounts: resolved } = best.merged;
    const above = free.filter((s) => micro(resolved.get(s.combo_key)!) > own(s)).map((s) => s.combo_key);
    return {
      ...planned(best.c, best.merged),
      targets: free.map((s) => ({ combo_key: s.combo_key, amount_usd: resolved.get(s.combo_key)!, capped: resolved.get(s.combo_key) !== typeProfit })),
      flags: above.length ? [...out.flags, { code: CEILING_SHARED_FLAG, combo_keys: uniqueSorted(above) }] : out.flags,
    };
  }

  // 7. Not even that fits: the product as it sells with no ceiling — today's rule at today's U, the very plan compute's
  //    first evaluation priced — flagged the same, never blocked. Only when even that cannot be written: blocked.
  const uncapped = planEstimateProfits({ ...input, profit_cap_pct: null });
  if (uncapped.kind === 'planned' || uncapped.kind === 'none') {
    return {
      ...out,
      kind: 'uncapped',
      targets: free.map((s) => ({ combo_key: s.combo_key, amount_usd: typeProfit, capped: false })),
      flags: [...out.flags, { code: CEILING_SHARED_FLAG, combo_keys: uniqueSorted(free.filter((s) => targets.get(s.combo_key) !== typeProfit).map((s) => s.combo_key)) }],
      ...(uncapped.kind === 'planned' ? { rows: uncapped.rows, minimum_profit: uncapped.minimum_profit, scopes: uncapped.scopes } : {}),
    };
  }
  return unplanned('too_many', [...out.flags, tooMany]);
}

/**
 * The plan with its minimum profit as the profit cap planned it (§4.11): the wire's rows, the record's product
 * and scope rules, the flags. `none` returns the plan as it is; every other kind carries the record's scope rules
 * that are still in force into what an apply stores, so the estimator never forgets a rule it wrote.
 */
export function withEstimateProfits(plan: EstimatePlan, profits: EstimateProfitPlan): EstimatePlan {
  if (profits.kind === 'none') return plan;
  const applied: AppliedWire = {
    v: APPLIED_WIRE_VERSION,
    inputs: plan.applied.inputs,
    minimum_profit: profits.minimum_profit !== undefined ? profits.minimum_profit : plan.applied.minimum_profit,
    ...(profits.scopes.length ? { minimum_profit_scopes: profits.scopes } : {}),
  };
  const applied_json = serializeAppliedWire(applied);
  // The product's row alone travels as the form's text, exactly as before the cap; scope rows as the form's rows.
  // A plan sends exactly its rows (none: the store already holds it); any other kind replaces the plan's minimum
  // profit only with rows of its own — the cap's rules back to inherit, or the uncapped plan nothing planned keeps.
  const only = profits.rows.length === 1 && profits.rows[0]!.scope === 'product' ? profits.rows[0]!.amount_usd : null;
  const rows = only !== null ? only : profits.rows;
  const minimumProfit = profits.rows.length ? rows : profits.kind === 'planned' ? undefined : plan.wire.cost.minimum_profit;
  const wire: EstimateWire = { method: 'cost', cost: { inputs: plan.wire.cost.inputs, ...(minimumProfit !== undefined ? { minimum_profit: minimumProfit } : {}) } };
  const flags = new Map<string, EstimateFlag>(plan.flags.map((f) => [f.code, { ...f }]));
  const add = (f: EstimateFlag) => {
    const at = flags.get(f.code) ?? { code: f.code };
    if (f.combo_keys?.length) at.combo_keys = uniqueSorted([...(at.combo_keys ?? []), ...f.combo_keys]);
    if (f.fields?.length) at.fields = uniqueSorted([...(at.fields ?? []), ...f.fields]);
    flags.set(f.code, at);
  };
  for (const f of profits.flags) add(f);
  if (applied_json.length > MAX_APPLIED_WIRE_LENGTH) add({ code: 'EST_TOO_MANY_SCOPES' });
  return {
    ...plan,
    wire,
    applied,
    applied_json,
    flags: [...flags.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    blocked_by: ESTIMATE_INPUT_BLOCKING.filter((c) => flags.has(c)),
    owner_held: [...plan.owner_held, ...profits.owner_held].sort((a, b) => byScope(a, b) || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
  };
}
