/**
 * COST → PRICE: the pricing engine's maths, exact (master plan v2 §2.4, LD4,
 * [C2-M4], [C2-M5], [C1-G10], [C1-G24], [L2-1a], [L2-1b], LD6; ENG §4.2).
 *
 *     supplierExact = supplier_amount × FX                        (exact rational)
 *     shippingExact = weight_g / 1000 × rate_per_kg   (CHINA_AIR, GERMANY_LAND)
 *                   | effective_cbm × rate_per_cbm   (CHINA_SEA)
 *     R_exact       = supplierExact + shippingExact + additional
 *     R             = ceil(R_exact);   supplier_cost_iqd = ceil(supplierExact)
 *     shipping_cost_iqd = R − supplier_cost_iqd − additional       [C2-M4]
 *     T_exact       = amount_usd × U   (a USD minimum profit, owner brief 2026-10-09)
 *                   | amount_iqd       (a migrated dinar amount not yet converted)
 *     pre-order     = ceil_step(R_exact + T_exact)   step 1,000 IQD    [LD4]
 *     direct        = pre-order(default profile) + P,  P % step = 0 else DIRECT_SALE_EXTRA_NOT_ON_STEP [C2-M5]
 *
 * So `price − P − R_exact ≥ T_exact` ALWAYS (the owner's rule: rounding, the
 * exchange rate or freight never take profit below the minimum), every price is
 * a multiple of the step, and the rounding adds less than one step. Nothing is a
 * float: decimals are BigInt rationals from `@levonis/contracts/procurementCost`,
 * rounded once, up.
 *
 * THE USD CHAIN (USD design §2.1-§2.2). E1 is fed USD = U, EUR = E×U, CNY = C×U
 * (`fxChain.composeIqdRates`), so R_exact = U × K where K is the Current Total
 * Cost in USD, and ceil_step(F × U) = ceil_step(R_exact + T × U) for the Final
 * Price in USD F = K + T. The USD figures each channel carries (K, F, freight and
 * extras ÷ U) are rounded UP at 6 decimals for DISPLAY and AUDIT ONLY: nothing
 * recomputes a price from them, because ceil6 can move F × U across a step.
 *
 * Missing or contradictory inputs return issue CODES, never a number (brief 1
 * §38): a channel with any error-severity issue gets no price at all. A zero
 * supplier cost counts as missing [C1-G24] — at any level, so a placeholder 0
 * never serves as the base that differences are added to.
 *
 * Inputs resolve over the SKU's levels (brief 1 §5): product (`base`) → option
 * values → colour → exact SKU, MANUAL_OVERRIDE before SOURCE at each level. A
 * SOURCE row's `unresolved_fields` mark beats that row's own value, but never the
 * owner's MANUAL_OVERRIDE at the same level (an explicit owner action resolves it):
 * - supplier cost walks least specific first so differences ADD UP
 *   (500 EUR + 80 + 5 = 585 EUR); an absolute cost at a more specific level
 *   replaces everything below it;
 * - profile, additional cost: the most specific level holding a value wins;
 * - effective weight: the most specific level holding `pricing_weight_g ??
 *   shipping_weight_g` (the MANUAL row's pair first, then SOURCE's), or listing
 *   either in `unresolved_fields` (→ SHIPPING_FIELD_UNRESOLVED; the level above is
 *   NOT inherited) [C1-G10];
 * - effective CBM: the MOST SPECIFIC level holding a manual CBM, a box, or a box
 *   field in `unresolved_fields` decides ALONE; at that level manual ?? L×W×H/1e9.
 *   The box is atomic: its three axes come from one row of one level, never mixed
 *   across levels or origins, and a partial box decides its level as CBM_MISSING
 *   instead of letting a parent's box price this SKU's package [L2-1a][L2-1b][LD6].
 *   A manual CBM always wins over the calculated one at its level — a SOURCE
 *   manual CBM over an override box too (LD6). Order at one level: manual CBM
 *   (MANUAL, then an unmarked SOURCE one) → the override box → a SOURCE mark →
 *   the SOURCE box.
 * - at the option level a SKU has several rows (one per option group): two
 *   different values there are INPUT_CONFLICT, never averaged or guessed, and the
 *   same option value listed twice is INPUT_CONFLICT too (a caller bug, never
 *   counted twice).
 *
 * Every decimal is read with `parseProcurementDecimal` — the 0179 CHECK grammar
 * (no exponent, no leading or trailing '.', a sign only on a difference) — so a
 * value the database would refuse is never priced.
 *
 * CONFIDENTIAL: the pricing formula never ships to the browser. `src/` must not
 * import this file (`tests/pricingCostToPrice.test.ts` enforces it).
 */
import {
  addProcurementExact,
  ceilProcurementExact,
  ceilToPlaces,
  compareProcurementExact,
  divProcurementExact,
  mulProcurementExact,
  parseProcurementDecimal,
  procurementExact,
  procurementExactText,
  quotientProcurementExact,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';
import type { PricingIssueCode } from '@levonis/contracts/pricingIssues';
import {
  isValidRuleAmount,
  parseUsdRuleAmount,
  targetProfitExactIqd,
  type PricingRuleKind,
  type RuleResolution,
} from './ruleResolution';
import {
  PROFILE_BASIS,
  SKU_CHANNELS,
  isShippingProfile,
  profileOfChannel,
  type ShippingBasis,
  type ShippingProfile,
  type SkuChannel,
} from './skuChannel';

/** Owner decision 3 / LD4: prices are rounded UP to whole thousands. */
export const ROUNDING_STEP_IQD = 1000;
/** C51: the most SKUs one product may have on the engine (SKU_GRID_TOO_LARGE above it). */
export const ENGINE_MAX_SKUS = 240;
/** `product_sku_prices.regular_price_iqd BETWEEN 1 AND 100000000000` (0179). */
export const MAX_FINAL_PRICE_IQD = 100_000_000_000;
/** `pricing_inputs` bounds (0179). */
export const MAX_ADDITIONAL_COST_IQD = 1_000_000_000;
export const MAX_WEIGHT_G = 100_000_000;
export const MAX_BOX_MM = 100_000;

export type SupplierCurrency = 'USD' | 'EUR' | 'CNY';
export const SUPPLIER_CURRENCIES: readonly SupplierCurrency[] = ['USD', 'EUR', 'CNY'];
const isSupplierCurrency = (v: unknown): v is SupplierCurrency =>
  typeof v === 'string' && (SUPPLIER_CURRENCIES as readonly string[]).includes(v);

/* ---------------------------------------------------------------- inputs -- */

/** The value columns of a `pricing_inputs` row (0179). Decimals are canonical TEXT. */
export interface PricingInputFields {
  supplier_cost: string | null;
  supplier_cost_delta: string | null;
  supplier_currency: SupplierCurrency | null;
  shipping_profile: ShippingProfile | null;
  pricing_weight_g: number | null;
  shipping_weight_g: number | null;
  shipping_length_mm: number | null;
  shipping_width_mm: number | null;
  shipping_height_mm: number | null;
  manual_cbm: string | null;
  additional_cost_iqd: number | null;
}

/** One `pricing_inputs` row of one origin. `unresolved_fields` is honoured on
 * SOURCE rows only (0179: MANUAL_OVERRIDE rows always hold '[]'). */
export interface PricingInputRow extends Partial<PricingInputFields> {
  unresolved_fields?: readonly string[] | null;
}

export type InputOrigin = 'SOURCE' | 'MANUAL_OVERRIDE';
export type InputLevel = 'base' | 'option' | 'color' | 'sku';

/** The SOURCE and MANUAL_OVERRIDE rows of one scope (`product_id, scope, scope_id`). */
export interface ScopeInputs {
  /** The option value id, colour id or combo key; '' (or omitted) for `base`. */
  scope_id?: string;
  source?: PricingInputRow | null;
  override?: PricingInputRow | null;
}

/** Every input row that can apply to one SKU. */
export interface SkuInputChain {
  base?: ScopeInputs | null;
  /** One entry per selected option value (one per option group). */
  options?: readonly ScopeInputs[];
  color?: ScopeInputs | null;
  sku?: ScopeInputs | null;
}

/** Shipping fields a SOURCE row may mark "not ready at this level, do not
 * inherit past here" (`unresolved_fields`, legacy contract C36). `shipping_box`
 * stands for the three axes as one unit [L2-1a]; naming one axis marks the box. */
export const UNRESOLVABLE_FIELDS = [
  'shipping_profile',
  'pricing_weight_g',
  'shipping_weight_g',
  'shipping_box',
  'shipping_length_mm',
  'shipping_width_mm',
  'shipping_height_mm',
  'manual_cbm',
] as const;
const BOX_FIELDS = ['shipping_box', 'shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm'];

export interface Resolved<T> {
  value: T;
  origin: InputOrigin;
  level: InputLevel;
  scope_id: string;
}

export interface EffectiveCbm {
  level: InputLevel;
  scope_id: string;
  /** The complete box of the deciding level, if it has one. */
  box: { length_mm: number; width_mm: number; height_mm: number; origin: InputOrigin } | null;
  /** L×W×H/1e9 of that box (exact decimal text). */
  calculated: string | null;
  manual: string | null;
  manual_origin: InputOrigin | null;
  effective: string;
  from: 'manual' | 'calculated';
}

export interface EffectiveSkuInputs {
  supplier: { amount: string; currency: SupplierCurrency; amount_level: InputLevel } | null;
  shipping_profile: Resolved<ShippingProfile> | null;
  weight: (Resolved<number> & { field: 'pricing_weight_g' | 'shipping_weight_g' }) | null;
  cbm: EffectiveCbm | null;
  /** null ⇒ counted as 0 in the maths, shown to the owner as "not set". */
  additional_cost_iqd: Resolved<number> | null;
}

/* ---------------------------------------------------------------- issues -- */

export type PricingIssueField = keyof PricingInputFields | 'shipping_box';

/** A readiness code with where it applies. Codes and names only — never a number. */
export interface PricingIssue {
  code: PricingIssueCode;
  severity: 'error' | 'warning';
  /** The channel this issue keeps from being priced (every error has one in `priceSku`). */
  channel?: SkuChannel;
  field?: PricingIssueField;
  level?: InputLevel;
  scope_ids?: readonly string[];
  currency?: SupplierCurrency;
  profile?: ShippingProfile;
  rule_kind?: PricingRuleKind;
  rule_id?: string;
}

type Problem = Omit<PricingIssue, 'severity' | 'channel'>;

export interface ResolvedSkuInputs {
  inputs: EffectiveSkuInputs;
  /** What keeps each part of the inputs from being usable; empty when usable.
   * `priceSku` attaches them to exactly the channels that need that part. */
  problems: {
    supplier: Problem[];
    profile: Problem[];
    weight: Problem[];
    cbm: Problem[];
    additional: Problem[];
  };
}

/* ------------------------------------------------------- input resolution -- */

const MOST_SPECIFIC_FIRST: readonly InputLevel[] = ['sku', 'color', 'option', 'base'];
const LEAST_SPECIFIC_FIRST: readonly InputLevel[] = ['base', 'option', 'color', 'sku'];

interface LevelScope {
  scope_id: string;
  source: PricingInputRow | null;
  override: PricingInputRow | null;
}

function scopesAt(chain: SkuInputChain, level: InputLevel): LevelScope[] {
  const of = (s: ScopeInputs | null | undefined): LevelScope | null =>
    s ? { scope_id: level === 'base' ? '' : String(s.scope_id ?? ''), source: s.source ?? null, override: s.override ?? null } : null;
  const list = level === 'option' ? (chain.options ?? []).map(of) : [of(chain[level as 'base' | 'color' | 'sku'])];
  return list.filter((s): s is LevelScope => !!s && (!!s.source || !!s.override));
}

const unresolvedIn = (row: PricingInputRow | null, names: readonly string[]): boolean =>
  Array.isArray(row?.unresolved_fields) && row.unresolved_fields.some((f) => names.includes(f));

type Cell<T> =
  | { kind: 'absent' }
  | { kind: 'unresolved'; scope_id: string }
  | { kind: 'invalid'; scope_id: string }
  | { kind: 'value'; value: T; origin: InputOrigin; scope_id: string };

/** One field at one scope: MANUAL first, then a SOURCE "unresolved" mark, then the SOURCE value. */
function readCell<T>(
  scope: LevelScope,
  field: keyof PricingInputFields,
  parse: (raw: unknown) => T | undefined,
  unresolvedNames: readonly string[] = []
): Cell<T> {
  const read = (raw: unknown, origin: InputOrigin): Cell<T> => {
    const value = parse(raw);
    return value === undefined ? { kind: 'invalid', scope_id: scope.scope_id } : { kind: 'value', value, origin, scope_id: scope.scope_id };
  };
  const manual = scope.override?.[field];
  if (manual != null) return read(manual, 'MANUAL_OVERRIDE');
  if (unresolvedNames.length && unresolvedIn(scope.source, unresolvedNames)) return { kind: 'unresolved', scope_id: scope.scope_id };
  const source = scope.source?.[field];
  if (source != null) return read(source, 'SOURCE');
  return { kind: 'absent' };
}

type LevelDecision<T> =
  | { kind: 'value'; value: T; origin: InputOrigin; level: InputLevel; scope_id: string }
  | { kind: 'unresolved' | 'invalid'; level: InputLevel; scope_ids: string[] }
  | { kind: 'conflict'; level: InputLevel; scope_ids: string[] };

/** Most specific level first; the first level with anything decides alone. Within
 * a level (several option rows) an unresolved or invalid cell fails closed, and
 * two different values are a conflict. */
function decideMostSpecific<T>(
  chain: SkuInputChain,
  cellOf: (scope: LevelScope) => Cell<T>,
  same: (a: T, b: T) => boolean
): LevelDecision<T> | null {
  for (const level of MOST_SPECIFIC_FIRST) {
    const cells = scopesAt(chain, level).map(cellOf).filter((c) => c.kind !== 'absent') as Exclude<Cell<T>, { kind: 'absent' }>[];
    if (!cells.length) continue;
    for (const bad of ['unresolved', 'invalid'] as const) {
      const hit = cells.filter((c) => c.kind === bad);
      if (hit.length) return { kind: bad, level, scope_ids: hit.map((c) => c.scope_id) };
    }
    const values = cells as Extract<Cell<T>, { kind: 'value' }>[];
    if (values.some((v) => !same(v.value, values[0].value))) return { kind: 'conflict', level, scope_ids: values.map((v) => v.scope_id) };
    const chosen = values.find((v) => v.origin === 'MANUAL_OVERRIDE') ?? values[0];
    return { kind: 'value', value: chosen.value, origin: chosen.origin, level, scope_id: chosen.scope_id };
  }
  return null;
}

const wholeIn = (min: number, max: number) => (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min && raw <= max ? raw : undefined;

/** The 0179 decimal TEXT grammar (the CHECKs bound the length; the exact maths
 * takes any length, and AMOUNT_TOO_LARGE bounds the result). */
const INPUT_DECIMAL = { maxIntDigits: 20, maxFractionDigits: 20 } as const;

/** A decimal in the 0179 grammar, exact; undefined when malformed or out of `min`. */
function decimalOf(raw: unknown, opts: { signed?: boolean; min?: 'positive' | 'nonnegative' }): ProcurementExact | undefined {
  if (typeof raw !== 'string') return undefined; // decimals are TEXT columns
  try {
    return procurementExact(parseProcurementDecimal(raw, { ...INPUT_DECIMAL, ...opts }), { signed: opts.signed === true });
  } catch {
    return undefined;
  }
}

const positiveDecimal = (raw: unknown): ProcurementExact | undefined => decimalOf(raw, { min: 'positive' });

const sameExact = (a: ProcurementExact, b: ProcurementExact) => compareProcurementExact(a, b) === 0;

function problemOf(code: PricingIssueCode, field: PricingIssueField, d: { level: InputLevel; scope_ids: string[] }): Problem {
  return { code, field, level: d.level, scope_ids: d.scope_ids };
}

function resolveSupplier(chain: SkuInputChain): { supplier: EffectiveSkuInputs['supplier']; problems: Problem[] } {
  let amount: ProcurementExact | null = null;
  let currency: SupplierCurrency | null = null;
  let amountLevel: InputLevel | null = null;
  const fail = (code: PricingIssueCode, field: PricingIssueField, level: InputLevel, scope_ids: string[]) => ({
    supplier: null,
    problems: [{ code, field, level, scope_ids }],
  });

  for (const level of LEAST_SPECIFIC_FIRST) {
    const cells: { scope_id: string; cost: ProcurementExact | null; delta: ProcurementExact | null; currency: SupplierCurrency | null }[] = [];
    for (const scope of scopesAt(chain, level)) {
      // The amount (absolute OR difference) is one value: MANUAL's pair wins whole.
      const ov = scope.override;
      const amountRow = ov && (ov.supplier_cost != null || ov.supplier_cost_delta != null) ? ov : scope.source;
      const rawCost = amountRow?.supplier_cost ?? null;
      const rawDelta = amountRow?.supplier_cost_delta ?? null;
      const rawCurrency = ov?.supplier_currency ?? scope.source?.supplier_currency ?? null;
      if (rawCost != null && rawDelta != null) return fail('INPUT_CONFLICT', 'supplier_cost', level, [scope.scope_id]);
      const cost = rawCost != null ? decimalOf(rawCost, { min: 'nonnegative' }) ?? null : null;
      const delta = rawDelta != null ? decimalOf(rawDelta, { signed: true }) ?? null : null;
      if ((rawCost != null && !cost) || (rawDelta != null && !delta))
        return fail('SUPPLIER_COST_MISSING', rawCost != null ? 'supplier_cost' : 'supplier_cost_delta', level, [scope.scope_id]);
      if (rawCurrency != null && !isSupplierCurrency(rawCurrency)) return fail('SUPPLIER_CURRENCY_MISSING', 'supplier_currency', level, [scope.scope_id]);
      cells.push({ scope_id: scope.scope_id, cost, delta, currency: rawCurrency as SupplierCurrency | null });
    }
    const absolute = cells.filter((c) => c.cost !== null);
    if (absolute.length) {
      // A zero absolute cost is a placeholder, not a cost [C1-G24]: it is missing at
      // its level and never becomes the base that differences are added to.
      const zero = absolute.filter((c) => c.cost!.num === 0n);
      if (zero.length) return fail('SUPPLIER_COST_MISSING', 'supplier_cost', level, zero.map((c) => c.scope_id));
      const first = absolute[0];
      if (absolute.some((c) => !sameExact(c.cost!, first.cost!) || c.currency !== first.currency))
        return fail('INPUT_CONFLICT', 'supplier_cost', level, absolute.map((c) => c.scope_id));
      amount = first.cost;
      currency = first.currency ?? currency;
      amountLevel = level;
    }
    for (const c of cells) {
      if (c.cost !== null || c.delta !== null || !c.currency) continue;
      if (currency && c.currency !== currency) return fail('CURRENCY_WITHOUT_AMOUNT', 'supplier_currency', level, [c.scope_id]);
      currency = c.currency;
    }
    for (const c of cells) {
      if (c.delta === null) continue;
      if (!amount) return fail('DELTA_WITHOUT_BASE', 'supplier_cost_delta', level, [c.scope_id]);
      if (c.currency && currency && c.currency !== currency) return fail('CURRENCY_MISMATCH', 'supplier_cost_delta', level, [c.scope_id]);
      currency = currency ?? c.currency;
      amount = addProcurementExact(amount, c.delta);
    }
  }

  const problems: Problem[] = [];
  if (!amount || amount.num === 0n) problems.push({ code: 'SUPPLIER_COST_MISSING', field: 'supplier_cost' }); // zero = missing [C1-G24]
  else if (amount.num < 0n) problems.push({ code: 'NEGATIVE_SUPPLIER_COST', field: 'supplier_cost' });
  if (!currency) problems.push({ code: 'SUPPLIER_CURRENCY_MISSING', field: 'supplier_currency' });
  if (problems.length || !amount || !currency || !amountLevel) return { supplier: null, problems };
  return { supplier: { amount: procurementExactText(amount), currency, amount_level: amountLevel }, problems };
}

type WeightCell = { value: number; field: 'pricing_weight_g' | 'shipping_weight_g' };

/** One scope's weight: the owner's MANUAL_OVERRIDE row first, whole (`pricing ??
 * shipping` — a SOURCE mark never beats the owner's value), then SOURCE, where a
 * field's "unresolved" mark beats that field's SOURCE value [C1-G10]. */
function weightCell(scope: LevelScope): Cell<WeightCell> {
  const parse = wholeIn(1, MAX_WEIGHT_G);
  const { scope_id } = scope;
  const at = (row: PricingInputRow | null, field: WeightCell['field'], origin: InputOrigin): Cell<WeightCell> | null => {
    const raw = row?.[field];
    if (raw == null) return null;
    const value = parse(raw);
    return value === undefined ? { kind: 'invalid', scope_id } : { kind: 'value', value: { value, field }, origin, scope_id };
  };
  const manual = at(scope.override, 'pricing_weight_g', 'MANUAL_OVERRIDE') ?? at(scope.override, 'shipping_weight_g', 'MANUAL_OVERRIDE');
  if (manual) return manual;
  if (unresolvedIn(scope.source, ['pricing_weight_g'])) return { kind: 'unresolved', scope_id };
  const pricing = at(scope.source, 'pricing_weight_g', 'SOURCE');
  if (pricing) return pricing;
  if (unresolvedIn(scope.source, ['shipping_weight_g'])) return { kind: 'unresolved', scope_id };
  return at(scope.source, 'shipping_weight_g', 'SOURCE') ?? { kind: 'absent' };
}

type CbmCell = {
  effective: ProcurementExact;
  from: 'manual' | 'calculated';
  box: EffectiveCbm['box'];
  calculated: ProcurementExact | null;
  manual: ProcurementExact | null;
  manual_origin: InputOrigin | null;
};

const BOX_AXES = ['shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm'] as const;

type BoxRead = { box: NonNullable<EffectiveCbm['box']>; calculated: ProcurementExact } | 'partial' | null;

/** One row's box, whole: null when it states no axis, 'partial' when it states
 * fewer than three valid axes (never completed from another row or level). */
function boxOf(row: PricingInputRow | null, origin: InputOrigin): BoxRead {
  const raw = BOX_AXES.map((a) => row?.[a] ?? null);
  if (raw.every((v) => v == null)) return null;
  const valid = raw.map((v) => wholeIn(1, MAX_BOX_MM)(v));
  if (valid.some((v) => v === undefined)) return 'partial';
  const [length_mm, width_mm, height_mm] = valid as [number, number, number];
  return {
    box: { length_mm, width_mm, height_mm, origin },
    calculated: divProcurementExact({ num: BigInt(length_mm) * BigInt(width_mm) * BigInt(height_mm), den: 1n }, 1_000_000_000n),
  };
}

/** The deciding outcome of one scope for CBM, or `absent` (see the file header for
 * the order). The field that made a scope fail is kept for the issue. */
function cbmCell(scope: LevelScope): Cell<CbmCell> & { field?: PricingIssueField } {
  const { scope_id } = scope;
  const sourceManualMarked = unresolvedIn(scope.source, ['manual_cbm']);
  const sourceBoxMarked = unresolvedIn(scope.source, BOX_FIELDS);
  const overrideBox = boxOf(scope.override, 'MANUAL_OVERRIDE');
  // A box a SOURCE mark calls unresolved is no box (not even for display).
  const sourceBox = sourceBoxMarked ? null : boxOf(scope.source, 'SOURCE');
  const shown = overrideBox ?? sourceBox;
  const complete = shown && shown !== 'partial' ? shown : null;
  const calculatedValue = (read: Exclude<BoxRead, 'partial' | null>): Cell<CbmCell> => ({
    kind: 'value',
    origin: read.box.origin,
    scope_id,
    value: { effective: read.calculated, from: 'calculated', box: read.box, calculated: read.calculated, manual: null, manual_origin: null },
  });

  // 1. A manual CBM decides its level (LD6): the owner's, then an unmarked SOURCE one.
  const manualOrigin: InputOrigin | null =
    scope.override?.manual_cbm != null ? 'MANUAL_OVERRIDE' : !sourceManualMarked && scope.source?.manual_cbm != null ? 'SOURCE' : null;
  if (manualOrigin) {
    const manual = positiveDecimal(manualOrigin === 'MANUAL_OVERRIDE' ? scope.override?.manual_cbm : scope.source?.manual_cbm);
    if (!manual) return { kind: 'invalid', scope_id, field: 'manual_cbm' };
    return {
      kind: 'value',
      origin: manualOrigin,
      scope_id,
      value: { effective: manual, from: 'manual', box: complete?.box ?? null, calculated: complete?.calculated ?? null, manual, manual_origin: manualOrigin },
    };
  }
  // 2. The owner's box, whole; a partial override box is never completed from SOURCE.
  if (overrideBox === 'partial') return { kind: 'invalid', scope_id, field: 'shipping_box' };
  if (overrideBox) return calculatedValue(overrideBox);
  // 3. A SOURCE mark: not ready at this level, and the level above is NOT inherited.
  if (sourceManualMarked) return { kind: 'unresolved', scope_id, field: 'manual_cbm' };
  if (sourceBoxMarked) return { kind: 'unresolved', scope_id, field: 'shipping_box' };
  // 4. The SOURCE box, whole.
  if (sourceBox === 'partial') return { kind: 'invalid', scope_id, field: 'shipping_box' };
  if (sourceBox) return calculatedValue(sourceBox);
  return { kind: 'absent' };
}

/** Resolve one SKU's effective inputs over its levels (see the file header). */
export function resolveSkuInputs(chain: SkuInputChain): ResolvedSkuInputs {
  // One option value listed twice is a caller bug (a SKU selects each value once):
  // its differences would add up twice. Fail closed on every channel.
  const optionIds = (chain.options ?? []).filter((o): o is ScopeInputs => !!o).map((o) => String(o.scope_id ?? ''));
  const repeated = [...new Set(optionIds.filter((id, i) => optionIds.indexOf(id) !== i))];
  if (repeated.length) {
    return {
      inputs: { supplier: null, shipping_profile: null, weight: null, cbm: null, additional_cost_iqd: null },
      problems: { supplier: [{ code: 'INPUT_CONFLICT', level: 'option', scope_ids: repeated }], profile: [], weight: [], cbm: [], additional: [] },
    };
  }

  const { supplier, problems: supplierProblems } = resolveSupplier(chain);

  // Shipping profile (used by direct_sale only).
  const profile = decideMostSpecific<ShippingProfile>(
    chain,
    (s) => readCell(s, 'shipping_profile', (v) => (isShippingProfile(v) ? v : undefined), ['shipping_profile']),
    (a, b) => a === b
  );
  const profileProblems: Problem[] =
    !profile || profile.kind === 'invalid'
      ? [{ code: 'SHIPPING_PROFILE_MISSING', field: 'shipping_profile', ...(profile ? { level: profile.level, scope_ids: profile.scope_ids } : {}) }]
      : profile.kind === 'unresolved'
        ? [problemOf('SHIPPING_FIELD_UNRESOLVED', 'shipping_profile', profile)]
        : profile.kind === 'conflict'
          ? [problemOf('INPUT_CONFLICT', 'shipping_profile', profile)]
          : [];

  // Effective weight [C1-G10].
  const weight = decideMostSpecific<WeightCell>(chain, weightCell, (a, b) => a.value === b.value);
  const weightProblems: Problem[] =
    !weight || weight.kind === 'invalid'
      ? [{ code: 'WEIGHT_MISSING', field: 'shipping_weight_g', ...(weight ? { level: weight.level, scope_ids: weight.scope_ids } : {}) }]
      : weight.kind === 'unresolved'
        ? [problemOf('SHIPPING_FIELD_UNRESOLVED', 'shipping_weight_g', weight)]
        : weight.kind === 'conflict'
          ? [problemOf('INPUT_CONFLICT', 'shipping_weight_g', weight)]
          : [];

  // Effective CBM: the most specific deciding level, alone [L2-1a][L2-1b][LD6].
  let cbm: EffectiveCbm | null = null;
  let cbmProblems: Problem[] = [{ code: 'CBM_MISSING', field: 'shipping_box' }];
  for (const level of MOST_SPECIFIC_FIRST) {
    const cells = scopesAt(chain, level).map(cbmCell).filter((c) => c.kind !== 'absent');
    if (!cells.length) continue;
    const failed = cells.find((c) => c.kind === 'unresolved') ?? cells.find((c) => c.kind === 'invalid');
    if (failed) {
      const ids = cells.filter((c) => c.kind === failed.kind).map((c) => (c as { scope_id: string }).scope_id);
      cbmProblems = [
        problemOf(failed.kind === 'unresolved' ? 'SHIPPING_FIELD_UNRESOLVED' : 'CBM_MISSING', failed.field ?? 'shipping_box', { level, scope_ids: ids }),
      ];
      break;
    }
    const values = cells as Extract<Cell<CbmCell>, { kind: 'value' }>[];
    if (values.some((v) => !sameExact(v.value.effective, values[0].value.effective))) {
      const field: PricingIssueField = values.some((v) => v.value.from === 'manual') ? 'manual_cbm' : 'shipping_box';
      cbmProblems = [problemOf('INPUT_CONFLICT', field, { level, scope_ids: values.map((v) => v.scope_id) })];
      break;
    }
    const chosen = values.find((v) => v.origin === 'MANUAL_OVERRIDE') ?? values[0];
    const c = chosen.value;
    cbm = {
      level,
      scope_id: chosen.scope_id,
      box: c.box,
      calculated: c.calculated ? procurementExactText(c.calculated) : null,
      manual: c.manual ? procurementExactText(c.manual) : null,
      manual_origin: c.manual_origin,
      effective: procurementExactText(c.effective),
      from: c.from,
    };
    cbmProblems = [];
    break;
  }

  // Additional cost: optional; null counts as 0. A value outside 0179's whole
  // 0…1,000,000,000 IQD (negative, fractional or too large) is AMOUNT_TOO_LARGE,
  // whose label reads "an amount is outside the allowed range" — §2.3 has no
  // narrower code — with the field and level that hold it.
  const additional = decideMostSpecific<number>(chain, (s) => readCell(s, 'additional_cost_iqd', wholeIn(0, MAX_ADDITIONAL_COST_IQD)), (a, b) => a === b);
  const additionalProblems: Problem[] =
    additional?.kind === 'invalid' || additional?.kind === 'unresolved'
      ? [problemOf('AMOUNT_TOO_LARGE', 'additional_cost_iqd', additional)]
      : additional?.kind === 'conflict'
        ? [problemOf('INPUT_CONFLICT', 'additional_cost_iqd', additional)]
        : [];

  const resolved = <T>(d: LevelDecision<T> | null): Resolved<T> | null =>
    d?.kind === 'value' ? { value: d.value, origin: d.origin, level: d.level, scope_id: d.scope_id } : null;
  const w = resolved(weight);

  return {
    inputs: {
      supplier,
      shipping_profile: resolved(profile),
      weight: w ? { ...w, value: w.value.value, field: w.value.field } : null,
      cbm,
      additional_cost_iqd: resolved(additional),
    },
    problems: { supplier: supplierProblems, profile: profileProblems, weight: weightProblems, cbm: cbmProblems, additional: additionalProblems },
  };
}

/* ------------------------------------------------------------------ rates -- */

/** A central rate row (`pricing_fx_rates` / `pricing_shipping_rates`): IQD per unit of
 * currency, or IQD per kg / per CBM. A null or non-positive rate is missing [C1-G24]. */
export interface CentralRate {
  rate: string | null;
  version: number;
  /** `confirmed_at IS NOT NULL` [C2-M3]. */
  confirmed: boolean;
}

export interface CentralRates {
  fx: Readonly<Partial<Record<SupplierCurrency, CentralRate>>>;
  shipping: Readonly<Partial<Record<ShippingProfile, CentralRate>>>;
}

/* ------------------------------------------------------------- the money -- */

/** The private replacement-cost breakdown of one SKU on one shipping profile
 * (the cost columns of `pricing_sku_costs`, plus the exact figures). */
export interface ReplacementCost {
  shipping_profile: ShippingProfile;
  shipping_basis: ShippingBasis;
  supplier_amount: string;
  supplier_currency: SupplierCurrency;
  fx_rate: string;
  fx_version: number;
  /** supplier_amount × fx_rate, exact decimal text. */
  supplier_cost_exact: string;
  /** ceil(supplier_cost_exact). */
  supplier_cost_iqd: number;
  shipping_rate: string;
  shipping_version: number;
  /** Set on weight-basis profiles only. */
  effective_weight_g: number | null;
  /** Volume basis only: calculated (box), manual and effective CBM of the deciding level. */
  shipping_cbm: string | null;
  manual_cbm: string | null;
  effective_cbm: string | null;
  /** Freight, exact decimal text. */
  shipping_cost_exact: string;
  /** R − supplier_cost_iqd − additional_cost_iqd [C2-M4]: never below 0, never above ceil(shipping_cost_exact). */
  shipping_cost_iqd: number;
  additional_cost_iqd: number;
  /** R_exact, exact decimal text (`pricing_sku_costs.replacement_exact`, LD4). */
  replacement_exact: string;
  /** R = ceil(R_exact) = supplier_cost_iqd + shipping_cost_iqd + additional_cost_iqd. */
  replacement_cost_iqd: number;
}

/** USD figures are rounded UP at this many decimals (display and audit only). */
export const USD_DISPLAY_PLACES = 6;

export interface ChannelPrice extends ReplacementCost {
  channel: SkuChannel;
  /** floor(target_profit_iqd_exact): the whole-dinar backstop the 0181 CHECKs hold. */
  target_profit_iqd: number;
  /** The deciding minimum profit in USD (canonical text); null when it is a migrated dinar amount. */
  target_profit_usd: string | null;
  /** T_exact in dinars: amount_usd × U, or the dinar amount — exact decimal text. */
  target_profit_iqd_exact: string;
  /** ceil6(supplier_cost_exact ÷ U); null without a USD rate (a dinar target only). Display. */
  supplier_cost_usd: string | null;
  /** ceil6(shipping_cost_exact ÷ U). Display. */
  shipping_cost_usd: string | null;
  /** ceil6(additional_cost_iqd ÷ U). Display. */
  additional_cost_usd: string | null;
  /** K = ceil6(R_exact ÷ U), the Current Total Cost in USD. Display. */
  current_total_cost_usd: string | null;
  /** F = K + (target_profit_usd ?? ceil6(T_exact ÷ U)). Display and audit ONLY (never re-priced from). */
  final_price_usd: string | null;
  /** The U the USD figures and a USD minimum profit used; null without one. */
  usd_iqd_rate: string | null;
  target_rule_id: string;
  target_rule_version: number;
  /** direct_sale only. */
  direct_sale_extra_iqd: number | null;
  extra_rule_id: string | null;
  extra_rule_version: number | null;
  rounding_step_iqd: number;
  /** ceil_step(R_exact + T_exact) on this channel's profile (for direct_sale: the default profile). */
  preorder_base_iqd: number;
  /** pre-order base − ceil(R_exact + T_exact): what rounding up added, 0 ≤ it < one step
   * (with a whole-dinar target this is computed − R − T − P, as before). */
  rounding_added_iqd: number;
  computed_price_iqd: number;
}

export interface SkuPricingResult {
  /** No error-severity issue, and every requested channel priced. */
  ok: boolean;
  inputs: EffectiveSkuInputs;
  /** Only the channels that could be priced; a channel with an error issue is absent. */
  channels: ChannelPrice[];
  issues: PricingIssue[];
}

const toNumber = (value: bigint, what: string): number => {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${what} is not a safe integer`);
  return Number(value);
};

function assertStep(step: number): bigint {
  if (!Number.isSafeInteger(step) || step < 1) throw new RangeError('The rounding step must be a positive whole number of IQD');
  return BigInt(step);
}

/** An amount for the public helpers: an exact rational, a bigint, decimal TEXT, or
 * a JS number that is a safe integer. A fractional JS number is refused (it is
 * already a binary float: 0.1 + 0.2, 1000.0000000000001), so no float ever
 * enters the price. */
function exactOf(value: ProcurementExact | number | bigint | string): ProcurementExact {
  if (typeof value === 'object') {
    if (typeof value?.num !== 'bigint' || typeof value.den !== 'bigint' || value.den <= 0n) throw new RangeError('Not an exact amount');
    return value;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('A fractional amount must be decimal text, never a binary float');
  return procurementExact(value, { signed: true });
}

/** The smallest multiple of `step` ≥ value — rounding UP, never to nearest. A
 * price is never rounded from below zero: a negative value is a RangeError. */
export function ceilStep(value: ProcurementExact | number | bigint | string, step: number = ROUNDING_STEP_IQD): number {
  const s = assertStep(step);
  const exact = exactOf(value);
  if (exact.num < 0n) throw new RangeError('A negative amount is never rounded to a price');
  return toNumber(ceilProcurementExact(divProcurementExact(exact, s)) * s, 'Price');
}

export function isOnStep(amount: number, step: number = ROUNDING_STEP_IQD): boolean {
  return Number.isSafeInteger(amount) && amount % Number(assertStep(step)) === 0;
}

/** Pre-order price = ceil_step(R_exact + T_exact) (LD4). `replacement` is the EXACT
 * replacement cost (a rational, a decimal text, or whole IQD), never negative.
 * The target is an exact rational > 0 — a USD minimum profit × U need not be
 * whole dinars (USD design §2.2) — given like the replacement: a rational, a
 * decimal text, or whole IQD (a fractional JS number is refused, never a float).
 * With T > 0 the price is therefore always at least one step — never 0. */
export function preorderPrice(
  replacement: ProcurementExact | number | bigint | string,
  targetProfit: ProcurementExact | number | bigint | string,
  step: number = ROUNDING_STEP_IQD
): number {
  const t = exactOf(targetProfit);
  if (t.num <= 0n) throw new RangeError('Target profit must be above zero');
  const r = exactOf(replacement);
  if (r.num < 0n) throw new RangeError('The replacement cost is never negative');
  const price = ceilStep(addProcurementExact(r, t), step);
  if (price < step) throw new RangeError('A price is at least one rounding step');
  return price;
}

/** Direct price = pre-order base + Direct Sale Extra. The extra must already be on the
 * step (DIRECT_SALE_EXTRA_NOT_ON_STEP otherwise [C2-M5]) — it is never rounded silently —
 * and the base is a real pre-order price: on the step and at least one step. */
export function directPrice(preorderBaseIqd: number, extraIqd: number, step: number = ROUNDING_STEP_IQD): number {
  if (!Number.isSafeInteger(extraIqd) || extraIqd < 0) throw new RangeError('The Direct Sale Extra must be a whole, non-negative number of IQD');
  if (!isOnStep(extraIqd, step)) throw new RangeError('DIRECT_SALE_EXTRA_NOT_ON_STEP');
  if (!isOnStep(preorderBaseIqd, step) || preorderBaseIqd < step) throw new RangeError('The pre-order base must be a positive multiple of the rounding step');
  return toNumber(BigInt(preorderBaseIqd) + BigInt(extraIqd), 'Price');
}

interface CostComputation {
  errors: Problem[];
  warnings: Problem[];
  cost: ReplacementCost | null;
  exact: ProcurementExact | null;
}

function rateOf(entry: CentralRate | undefined): { exact: ProcurementExact; text: string } | null {
  const exact = entry ? positiveDecimal(entry.rate) : undefined;
  return exact ? { exact, text: procurementExactText(exact) } : null;
}

function computeReplacement(
  resolved: ResolvedSkuInputs,
  profile: ShippingProfile,
  rates: CentralRates,
  allowUnconfirmedRates: boolean
): CostComputation {
  const { inputs, problems } = resolved;
  const errors: Problem[] = [...problems.supplier];
  const warnings: Problem[] = [];
  const unconfirmed = (p: Problem) => (allowUnconfirmedRates ? warnings : errors).push(p);

  let fx: ReturnType<typeof rateOf> = null;
  const currency = inputs.supplier?.currency;
  if (currency) {
    const entry = rates.fx[currency];
    fx = rateOf(entry);
    if (!fx) errors.push({ code: 'FX_RATE_MISSING', currency });
    else if (!entry!.confirmed) unconfirmed({ code: 'FX_RATE_UNCONFIRMED', currency });
  }
  const shipEntry = rates.shipping[profile];
  const ship = rateOf(shipEntry);
  if (!ship) errors.push({ code: 'SHIPPING_RATE_MISSING', profile });
  else if (!shipEntry!.confirmed) unconfirmed({ code: 'SHIPPING_RATE_UNCONFIRMED', profile });

  const basis = PROFILE_BASIS[profile];
  errors.push(...(basis === 'weight' ? problems.weight : problems.cbm), ...problems.additional);
  if (errors.length || !inputs.supplier || !fx || !ship) return { errors, warnings, cost: null, exact: null };

  try {
    const supplierExact = mulProcurementExact(procurementExact(inputs.supplier.amount), fx.exact);
    let shippingExact: ProcurementExact;
    if (basis === 'weight') {
      shippingExact = divProcurementExact(mulProcurementExact(ship.exact, procurementExact(BigInt(inputs.weight!.value))), 1000n);
    } else {
      shippingExact = mulProcurementExact(ship.exact, procurementExact(inputs.cbm!.effective));
    }
    const additional = inputs.additional_cost_iqd?.value ?? 0;
    const exact = addProcurementExact(supplierExact, shippingExact, procurementExact(BigInt(additional)));
    const replacement = ceilProcurementExact(exact);
    const supplierIqd = ceilProcurementExact(supplierExact);
    if (replacement > BigInt(MAX_FINAL_PRICE_IQD)) return { errors: [{ code: 'AMOUNT_TOO_LARGE' }], warnings, cost: null, exact: null };
    const shippingIqd = replacement - supplierIqd - BigInt(additional);
    return {
      errors,
      warnings,
      exact,
      cost: {
        shipping_profile: profile,
        shipping_basis: basis,
        supplier_amount: inputs.supplier.amount,
        supplier_currency: inputs.supplier.currency,
        fx_rate: fx.text,
        fx_version: rates.fx[inputs.supplier.currency]!.version,
        supplier_cost_exact: procurementExactText(supplierExact),
        supplier_cost_iqd: toNumber(supplierIqd, 'Supplier cost'),
        shipping_rate: ship.text,
        shipping_version: shipEntry!.version,
        effective_weight_g: basis === 'weight' ? inputs.weight!.value : null,
        shipping_cbm: basis === 'volume' ? inputs.cbm!.calculated : null,
        manual_cbm: basis === 'volume' ? inputs.cbm!.manual : null,
        effective_cbm: basis === 'volume' ? inputs.cbm!.effective : null,
        shipping_cost_exact: procurementExactText(shippingExact),
        shipping_cost_iqd: toNumber(shippingIqd, 'Shipping cost'),
        additional_cost_iqd: additional,
        replacement_exact: procurementExactText(exact),
        replacement_cost_iqd: toNumber(replacement, 'Replacement cost'),
      },
    };
  } catch (e) {
    if (e instanceof RangeError) return { errors: [{ code: 'AMOUNT_TOO_LARGE' }], warnings, cost: null, exact: null };
    throw e;
  }
}

/**
 * The replacement cost of one SKU on one shipping profile, or the codes that
 * keep it from being known. For owner previews (the L4 switch preview shows the
 * replacement cost before any price exists); `priceSku` uses the same maths.
 */
export function replacementCost(
  resolved: ResolvedSkuInputs,
  profile: ShippingProfile,
  rates: CentralRates,
  opts: { allowUnconfirmedRates?: boolean } = {}
): { ok: true; cost: ReplacementCost; warnings: PricingIssue[] } | { ok: false; issues: PricingIssue[] } {
  const r = computeReplacement(resolved, profile, rates, opts.allowUnconfirmedRates === true);
  const warnings = r.warnings.map((p): PricingIssue => ({ ...p, severity: 'warning' }));
  if (!r.cost) return { ok: false, issues: [...r.errors.map((p): PricingIssue => ({ ...p, severity: 'error' })), ...warnings] };
  return { ok: true, cost: r.cost, warnings };
}

function invariant(condition: boolean, what: string): void {
  // A programming error, never a data problem: it is thrown, never caught silently.
  if (!condition) throw new Error(`PRICING_INVARIANT: ${what}`);
}

export interface PriceSkuInput {
  chain: SkuInputChain;
  rates: CentralRates;
  /** The SKU's enabled channels (the worker decides them with the resolver). */
  channels: readonly SkuChannel[];
  /** `resolveRuleAt(rules, 'target_profit', sku)`. */
  target: RuleResolution;
  /** `resolveRuleAt(rules, 'direct_sale_extra', sku)`; needed when direct_sale is enabled. */
  extra?: RuleResolution | null;
  /** Default ROUNDING_STEP_IQD (1,000). */
  step?: number;
  /** Previews only: an unconfirmed central rate is a warning instead of an error [C2-M3]. */
  allowUnconfirmedRates?: boolean;
}

/** Price one SKU on every enabled channel (see the file header for the maths). */
export function priceSku(input: PriceSkuInput): SkuPricingResult {
  const step = Number(assertStep(input.step ?? ROUNDING_STEP_IQD));
  const resolved = resolveSkuInputs(input.chain);
  const { inputs, problems } = resolved;
  const wanted = SKU_CHANNELS.filter((c) => input.channels.includes(c));
  const issues: PricingIssue[] = [];
  const seenWarnings = new Set<string>();
  const warn = (p: Problem) => {
    const key = JSON.stringify(p);
    if (!seenWarnings.has(key)) {
      seenWarnings.add(key);
      issues.push({ ...p, severity: 'warning' });
    }
  };
  const { target } = input;
  const extra = input.extra ?? null;
  // Swapping the two resolutions would silently price on the extra as the profit.
  invariant(target?.kind === 'target_profit', 'target is a target_profit resolution');
  invariant(extra === null || extra.kind === 'direct_sale_extra', 'extra is a direct_sale_extra resolution');

  if (target.status === 'active' && target.tie) warn({ code: 'RULE_TIE', rule_kind: 'target_profit', rule_id: target.rule.id });

  // The minimum profit's currency (USD design §2.2). A USD amount needs U on
  // EVERY channel, whatever the supplier currency; a dinar amount does not.
  const usdEntry = input.rates.fx.USD;
  const usdRate = rateOf(usdEntry);
  const targetUsd = target.status === 'active' ? (target.amount_usd ?? null) : null;
  const targetUsdExact = targetUsd !== null ? parseUsdRuleAmount(targetUsd) : null;
  const targetProblems: Problem[] = [];
  let targetExact: ProcurementExact | null = null;
  if (target.status === 'active') {
    if (targetUsd !== null) {
      if (!targetUsdExact || target.amount_iqd != null) targetProblems.push({ code: 'TARGET_PROFIT_BLOCKED', rule_kind: 'target_profit', rule_id: target.rule.id }); // fail closed
      else if (!usdRate) targetProblems.push({ code: 'FX_RATE_MISSING', currency: 'USD' });
      else {
        if (!usdEntry!.confirmed) {
          const p: Problem = { code: 'FX_RATE_UNCONFIRMED', currency: 'USD' };
          if (input.allowUnconfirmedRates === true) warn(p);
          else targetProblems.push(p);
        }
        targetExact = targetProfitExactIqd(target, usdRate.text);
        // A tie MIXING a USD and a dinar row was ranked at a rate: it must be this one,
        // or a lower minimum could have won the tie.
        if (target.ranked_at_usd_iqd != null)
          invariant(compareProcurementExact(procurementExact(target.ranked_at_usd_iqd), usdRate.exact) === 0, 'a mixed tie is ranked at the rate it is priced at');
      }
    } else if (isValidRuleAmount('target_profit', target.amount_iqd)) targetExact = procurementExact(target.amount_iqd);
  }
  if (wanted.includes('direct_sale') && extra?.status === 'active' && extra.tie)
    warn({ code: 'RULE_TIE', rule_kind: 'direct_sale_extra', rule_id: extra.rule.id });

  const channels: ChannelPrice[] = [];
  for (const channel of wanted) {
    const errors: Problem[] = [];
    if (target.status !== 'active')
      errors.push({ code: target.code, rule_kind: 'target_profit', ...(target.status === 'blocked' ? { rule_id: target.rule.id } : {}) });
    else if (targetUsd !== null) errors.push(...targetProblems);
    else if (!isValidRuleAmount('target_profit', target.amount_iqd))
      errors.push({ code: 'TARGET_PROFIT_BLOCKED', rule_kind: 'target_profit', rule_id: target.rule.id }); // fail closed

    let extraIqd: number | null = null;
    if (channel === 'direct_sale') {
      if (!extra || extra.status === 'missing') errors.push({ code: 'DIRECT_SALE_EXTRA_MISSING', rule_kind: 'direct_sale_extra' });
      else if (extra.status === 'blocked') errors.push({ code: extra.code, rule_kind: 'direct_sale_extra', rule_id: extra.rule.id });
      else if (!isValidRuleAmount('direct_sale_extra', extra.amount_iqd))
        errors.push({ code: 'DIRECT_SALE_EXTRA_BLOCKED', rule_kind: 'direct_sale_extra', rule_id: extra.rule.id }); // fail closed
      else if (extra.amount_iqd % step !== 0) errors.push({ code: 'DIRECT_SALE_EXTRA_NOT_ON_STEP', rule_kind: 'direct_sale_extra', rule_id: extra.rule.id });
      else extraIqd = extra.amount_iqd;
    }

    const profile = profileOfChannel(channel, inputs.shipping_profile?.value ?? null);
    let computed: CostComputation | null = null;
    if (!profile) errors.push(...problems.supplier, ...problems.profile);
    else {
      computed = computeReplacement(resolved, profile, input.rates, input.allowUnconfirmedRates === true);
      errors.push(...computed.errors);
      computed.warnings.forEach(warn);
    }

    if (errors.length || !computed?.cost || !computed.exact || target.status !== 'active' || !targetExact) {
      const seen = new Set<string>();
      for (const p of errors) {
        const key = JSON.stringify(p);
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({ ...p, severity: 'error', channel });
      }
      continue;
    }

    const cost = computed.cost;
    const P = extraIqd ?? 0;
    let base: number;
    try {
      base = preorderPrice(computed.exact, targetExact, step);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      issues.push({ code: 'AMOUNT_TOO_LARGE', severity: 'error', channel });
      continue;
    }
    const price = base + P;
    if (!Number.isSafeInteger(price) || price > MAX_FINAL_PRICE_IQD) {
      issues.push({ code: 'AMOUNT_TOO_LARGE', severity: 'error', channel });
      continue;
    }
    const preExact = addProcurementExact(computed.exact, targetExact);
    const rounding = toNumber(BigInt(base) - ceilProcurementExact(preExact), 'Rounding');
    const targetFloor = toNumber(targetExact.num / targetExact.den, 'Target profit');

    // The owner's rules, asserted against the EXACT replacement cost and the EXACT minimum profit.
    const margin = addProcurementExact(procurementExact(BigInt(price - P)), { num: -computed.exact.num, den: computed.exact.den });
    invariant(compareProcurementExact(margin, targetExact) >= 0, 'price − extra − R_exact ≥ target');
    invariant(price % step === 0 && price >= step, 'price is a positive multiple of the step');
    invariant(rounding >= 0 && rounding < step, 'rounding adds less than one step');
    invariant(
      cost.supplier_cost_iqd + cost.shipping_cost_iqd + cost.additional_cost_iqd === cost.replacement_cost_iqd && cost.shipping_cost_iqd >= 0,
      'supplier + shipping + additional = R'
    );
    // The 0181 storage backstops (USD design §2.4), provable from the two above.
    invariant(price - cost.replacement_cost_iqd >= targetFloor && targetFloor > 0, 'computed − R ≥ floor(T)');
    const slack = price - cost.replacement_cost_iqd - targetFloor - P;
    invariant(slack >= 0 && slack <= step, 'computed − R − floor(T) − P is within one step');

    // Display and audit figures in USD, rounded UP at 6 decimals (never re-priced from).
    const usd = usdRate
      ? (() => {
          const perUsd = (x: ProcurementExact) => ceilToPlaces(quotientProcurementExact(x, usdRate.exact), USD_DISPLAY_PLACES);
          const k = perUsd(computed.exact);
          const t = targetUsdExact ?? perUsd(targetExact);
          return {
            supplier_cost_usd: procurementExactText(perUsd(procurementExact(cost.supplier_cost_exact))),
            shipping_cost_usd: procurementExactText(perUsd(procurementExact(cost.shipping_cost_exact))),
            additional_cost_usd: procurementExactText(perUsd(procurementExact(BigInt(cost.additional_cost_iqd)))),
            current_total_cost_usd: procurementExactText(k),
            final_price_usd: procurementExactText(addProcurementExact(k, t)),
            usd_iqd_rate: usdRate.text,
          };
        })()
      : { supplier_cost_usd: null, shipping_cost_usd: null, additional_cost_usd: null, current_total_cost_usd: null, final_price_usd: null, usd_iqd_rate: null };

    channels.push({
      channel,
      ...cost,
      target_profit_iqd: targetFloor,
      target_profit_usd: targetUsdExact ? procurementExactText(targetUsdExact) : null,
      target_profit_iqd_exact: procurementExactText(targetExact),
      ...usd,
      target_rule_id: target.rule.id,
      target_rule_version: target.rule.version,
      direct_sale_extra_iqd: channel === 'direct_sale' ? P : null,
      extra_rule_id: channel === 'direct_sale' && extra?.status === 'active' ? extra.rule.id : null,
      extra_rule_version: channel === 'direct_sale' && extra?.status === 'active' ? extra.rule.version : null,
      rounding_step_iqd: step,
      preorder_base_iqd: base,
      rounding_added_iqd: rounding,
      computed_price_iqd: price,
    });
  }

  return {
    ok: channels.length === wanted.length && !issues.some((i) => i.severity === 'error'),
    inputs,
    channels,
    issues,
  };
}
