/**
 * PRICING V2 — THE PRICE MODEL, EXACT (docs/PRICING-V2.md §1; owner decisions
 * A1, B1, C1 and the §7 defaults, DECISIONS row 221; implementation spec V2-1).
 *
 * ONE ANCHOR, THE DIRECT-SALE PRICE D, PER SKU. Every amount below is an exact
 * rational ("E" = IQD-exact = USD × U); nothing is rounded until the last step.
 *
 *     E_base = fixed × U        a «سعر خاص $» on the SKU (sku_fixed: no difference is added),
 *                               else on its model (model_fixed), else, price-first, the
 *                               product's typed dollar price (product_fixed)
 *            | R_stock + T × U  cost-first: replacement cost on the stock route
 *                               («مسار شحن المخزون») plus the minimum profit (anchor `cost`)
 *     E_D    = E_base + (Σ option ± + colour ±) × U        (C1: the same USD on every model)
 *     E_D    = max(E_D, R_stock + T × U)                    cost-first only (C-9, row 187)
 *     D      = round(E_D)      the ONE rounding rule (`roundPriceIqd`, DECISIONS row 245):
 *                               above 1,000 IQD up to the next 250, else up to whole dinars
 *     E_P,r  = E_D − Δ × U      Δ: sku > colour > model > product (B1, one Δ for every route)
 *     P_r    = round(E_P,r)
 *
 * THE ROUTE FLOOR (cost-first only, B1 with spec C-5 and the owner's answer Q1,
 * DECISIONS row 222). With R_r the replacement cost of route r (its own shipping
 * profile):
 *   - R_r > D      → the route is blocked (V2_ROUTE_BELOW_COST, an error on that
 *                    channel only; the SKU's other channels stay priced);
 *   - E_P,r < R_r  → the route sells at the DIRECT price D, no discount on it
 *                    (V2_DISCOUNT_WITHDRAWN, an owner warning). Never lifted to the
 *                    cost: a price equal to the cost rounded up would publish the
 *                    cost to every customer (Q1).
 * Price-first never floors (C-6, Q3): it only raises the owner's warnings — a
 * channel below its own known cost (`below_cost`, V2_BELOW_COST) and a direct price
 * below cost + minimum profit (`below_min_profit`, V2_BELOW_MIN_PROFIT) — when the
 * optional cost (and, for the second, the minimum profit) resolve. Neither ever
 * blocks a save or moves a price.
 *
 * A pre-order-only SKU has no discount (C-8, §7 default 3): every route sells at D
 * and a stored Δ that would apply raises V2_DISCOUNT_IGNORED.
 *
 * THE SHELF (cost-first only; DECISIONS row 244, docs/PRICING-V2.md §10). A SKU
 * whose stock is on the shelf carries `shelf` = the HIGHEST landed unit cost, in
 * dinars, among the batches still on its shelf (the worker reads it from
 * `inventory_lots`). That cost is R_stock of the DIRECT price — in dinars as it
 * was paid, never converted — and only the minimum profit and the differences
 * are dollars at U:
 *
 *     E_D = R_shelf + T × U + (Σ option ± + colour ±) × U,  never below R_shelf + T × U
 *     D   = round(E_D)  (the engine's one rounding, `roundPriceIqd`, DECISIONS row 245)   so D − R_shelf ≥ T × U at publication
 *
 * Its pre-order routes follow D like every SKU (B1, DECISIONS row 247):
 * P_r = round(E_D − Δ × U), with the Q1 floors measured against the route's own
 * supplier cost R_r — so a costlier or cheaper batch moves the direct price and
 * the pre-order together, and the discount between them stays Δ. While the shelf
 * sells, a route whose own cost is at or above D is stopped (V2_ROUTE_SHELF_CHEAPER)
 * and a route with no supplier calculation is unavailable (V2_ROUTE_NO_SUPPLIER,
 * on that channel only). A SKU whose shelf is SOLD OUT goes back to the supplier
 * calculation; without one, every channel of it is unsold (V2_STOCK_SOLD_OUT) —
 * never priced from a guess.
 *
 * So P ≤ D on every channel, every price is on the rounding rule and is round(its
 * exact figure) — the rounding adds less than 250 —, cost-first D − R_stock ≥ T × U, and a
 * cost-first route is never below its own replacement cost. These are asserted on
 * every channel (PRICING_INVARIANT, thrown, never caught).
 *
 * Inputs that are missing or wrong return issue CODES, never a number (brief 1
 * §38); a channel with any error is left out of `channels`. Every decimal is text
 * parsed to a BigInt rational (`@levonis/contracts/procurementCost`), as E1 does;
 * a fractional JS number anywhere in the input is a RangeError (it is already a
 * binary float). Cost inputs resolve exactly as E1 (`resolveSkuInputs`,
 * `replacementCost`), the minimum profit as E1 (`targetProfitExactIqd`).
 *
 * CONFIDENTIAL, like costToPrice.ts: `src/` must not import this file
 * (`tests/pricingCostToPrice.test.ts` enforces it).
 */
import {
  addProcurementExact,
  ceilToPlaces,
  compareProcurementExact,
  mulProcurementExact,
  parseProcurementDecimal,
  procurementExact,
  procurementExactText,
  quotientProcurementExact,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';
import type { PricingIssueCode } from '@levonis/contracts/pricingIssues';
import {
  MAX_FINAL_PRICE_IQD,
  USD_DISPLAY_PLACES,
  replacementCost,
  resolveSkuInputs,
  type CentralRates,
  type InputLevel,
  type PricingIssue,
  type ReplacementCost,
  type ResolvedSkuInputs,
  type SkuInputChain,
} from './costToPrice';
import { isValidRuleAmount, parseUsdRuleAmount, targetProfitExactIqd, type RuleResolution } from './ruleResolution';
import { PRICE_ROUNDING_STEP_IQD, isOnPriceRule, roundPriceIqd } from './priceRounding';
import { ROUTE_PROFILE, SKU_CHANNELS, routeOfChannel, skuComboKey, type ShippingProfile, type SkuChannel } from './skuChannel';

/* ----------------------------------------------------------------- shapes -- */

export type V2Method = 'cost' | 'usd';
export type V2Scope = 'product' | 'option' | 'color' | 'sku';

export const V2_METHODS: readonly V2Method[] = ['cost', 'usd'];
export const V2_SCOPES: readonly V2Scope[] = ['product', 'option', 'color', 'sku'];
/** A USD price, difference or discount: at most this much (the 0189 CHECK, like 0181's minimum profit). */
export const V2_MAX_USD = 100_000;

/** USD text: ≤ 2 decimals, the 0181 amount_usd grammar; a delta may be signed and is never 0. */
export interface V2PricePoint {
  scope: V2Scope;
  scope_id: string;
  kind: 'fixed' | 'delta';
  usd: string;
}
/** ≥ 0; an explicit 0 is a «no discount» exception that overrides a wider Δ. */
export interface V2Discount {
  scope: V2Scope;
  scope_id: string;
  usd: string;
}

/**
 * The SKU's shelf (DECISIONS row 244), cost-first only: `on_shelf` — units remain, and
 * `cost_iqd` is the highest landed unit cost (whole dinars) among its batches still on the
 * shelf; `sold_out` — it had batches and none remains. Absent: no batch, or no known cost.
 */
export type V2Shelf = { state: 'on_shelf'; cost_iqd: number; units: number } | { state: 'sold_out' };

export interface V2Sku {
  /** Canonical (`skuComboKey`); '' = the product itself. */
  combo_key: string;
  /** The model: the first value in relation order; null when the product has no model. */
  model_id: string | null;
  /** Relation order, model first. */
  option_value_ids: readonly string[];
  color_id: string | null;
  /** Structurally enabled channels (the resolver's availability), not price. */
  channels: readonly SkuChannel[];
  /** Cost inputs (`chainOfUnit`): required cost-first, optional price-first (profit reports, `below_cost`). */
  chain?: SkuInputChain;
  /** `resolveRuleAt(rules, 'target_profit', …)`: required cost-first; optional price-first (Q3's owner warning). */
  target?: RuleResolution;
  /** Cost-first: the shelf the direct price is priced from (row 244); ignored price-first. */
  shelf?: V2Shelf | null;
}

export interface V2Input {
  method: V2Method;
  /** E1's: USD = U, EUR = E × U, CNY = C × U; shipping per profile. */
  rates: CentralRates;
  points: readonly V2PricePoint[];
  discounts: readonly V2Discount[];
  skus: readonly V2Sku[];
  /** Previews only: an unconfirmed central rate is a warning instead of an error (as E1). */
  allowUnconfirmedRates?: boolean;
}

export type V2Anchor = 'sku_fixed' | 'model_fixed' | 'product_fixed' | 'cost';
export type V2Floor = 'none' | 'discount_withdrawn' | 'direct_min_profit';

export interface V2Channel {
  channel: SkuChannel;
  /** Final IQD; on the rounding rule (`roundPriceIqd`); ≥ 1; ≤ direct_iqd. */
  price_iqd: number;
  /** The exact figure `price_iqd` is the rounding of: E_P (a route), or E_D (direct, or a
   * route whose discount was withdrawn). */
  exact_iqd: string;
  /** This SKU's D. */
  direct_iqd: number;
  direct_exact_iqd: string;
  /** Price-first only: the channel's USD (D_usd, or D_usd − Δ on a route), exact; else null. */
  usd_exact: string | null;
  /** ceil6(exact_iqd ÷ U): display, audit and a future protection base — never re-priced from. */
  usd_ceil6: string;
  anchor: V2Anchor;
  /** Σ option ± + colour ± added to the anchor, signed ('0' when sku_fixed). */
  deltas_usd: string;
  /** Routes: the Δ that applies to this SKU ('0' when none, or on a pre-order-only SKU);
   * `floor` says whether it was honoured. Null on direct_sale. */
  discount_usd: string | null;
  discount_from: { scope: V2Scope; scope_id: string } | null;
  floor: V2Floor;
  /** R of THIS channel's profile (direct: the stock profile); null price-first without a complete cost, and on a
   * direct channel priced from the shelf (`shelf` is its R then). */
  replacement: ReplacementCost | null;
  /** Cost-first direct sale priced from the shelf (row 244): R_shelf in dinars and the units on the shelf. */
  shelf: { cost_iqd: number; units: number } | null;
  /** Cost-first only. */
  target_profit_usd: string | null;
  target_rule_id: string | null;
  target_rule_version: number | null;
  /** Price-first only, owner warning: the exact price is below this channel's known cost. */
  below_cost: boolean;
  /**
   * Price-first only, owner warning (Q3): this SKU's exact direct price E_D is below
   * R_stock + T (its cost on the stock route plus the minimum profit), whatever its
   * anchor. On every channel of the SKU (they share D). Never blocks, never moves a price.
   */
  below_min_profit: boolean;
}

export interface V2SkuResult {
  combo_key: string;
  ok: boolean;
  /** Only the channels that could be priced. */
  channels: V2Channel[];
  issues: PricingIssue[];
}

export interface V2Result {
  ok: boolean;
  skus: V2SkuResult[];
  /** The setup's own problems (a point or a discount the stored shape would refuse), each once. */
  issues: PricingIssue[];
}

/* ------------------------------------------------------------ the grammar -- */

const V2_USD_TEXT = /^[0-9]+(?:\.[0-9]{1,2})?$/;
const MAX_USD_EXACT: ProcurementExact = { num: BigInt(V2_MAX_USD), den: 1n };
const ZERO: ProcurementExact = { num: 0n, den: 1n };

/** A fractional JS number is already a binary float: refused with a RangeError, never priced. */
function noFloat(value: unknown, path: string): void {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError(`${path} must be decimal text or a whole number, never a binary float`);
}

/** Every number anywhere in the input is a safe integer (spec V2-1 §1.5 test 5). */
function assertNoFloat(value: unknown, path: string, seen: Set<object> = new Set()): void {
  noFloat(value, path);
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) assertNoFloat(child, `${path}.${key}`, seen);
}

/**
 * A stored V2 dollar amount, exact — or null when the 0189 CHECK would refuse it:
 * digits, at most one '.', one or two decimals, ≤ 9 characters (≤ 10 with a sign),
 * 0 < |x| ≤ 100,000. `signed` (a ± difference) takes one leading '+' or '-';
 * `zero` (a discount) also takes 0. Reads '120.50' and '120.5' alike.
 */
export function parseV2Usd(text: unknown, opts: { signed?: boolean; zero?: boolean } = {}): ProcurementExact | null {
  noFloat(text, 'A dollar amount');
  if (typeof text !== 'string') return null;
  const signed = opts.signed === true;
  const sign = signed && (text.startsWith('-') || text.startsWith('+')) ? text[0] : '';
  const body = text.slice(sign.length);
  if (text.length > (signed ? 10 : 9) || !V2_USD_TEXT.test(body)) return null;
  const magnitude = procurementExact(body);
  if (compareProcurementExact(magnitude, MAX_USD_EXACT) > 0) return null;
  if (magnitude.num === 0n && !opts.zero) return null;
  return sign === '-' ? { num: -magnitude.num, den: magnitude.den } : magnitude;
}

/** A central rate as an exact positive rational, or null (absent, malformed, ≤ 0). */
function positiveRate(raw: unknown): ProcurementExact | null {
  if (typeof raw !== 'string') return null;
  try {
    return procurementExact(parseProcurementDecimal(raw, { maxIntDigits: 20, maxFractionDigits: 20, min: 'positive' }));
  } catch {
    return null;
  }
}

const isV2Scope = (v: unknown): v is V2Scope => typeof v === 'string' && (V2_SCOPES as readonly string[]).includes(v);

/* ------------------------------------------------------------- resolution -- */

/** Does a point or discount at this scope name this SKU? */
function names(scope: V2Scope, scopeId: string, sku: V2Sku): boolean {
  switch (scope) {
    case 'product':
      return true;
    case 'option':
      return sku.option_value_ids.includes(scopeId);
    case 'color':
      return sku.color_id !== null && scopeId === sku.color_id;
    case 'sku':
      return scopeId === sku.combo_key;
  }
}

/**
 * The discount that applies to one SKU: the most specific level wins,
 * sku > colour > option (on the SKU's model only) > product (rows 184 (1), 200).
 * Null when none names it (Δ = 0). Shape checks are `priceProductV2`'s.
 */
export function resolveDiscount(discounts: readonly V2Discount[], sku: V2Sku): V2Discount | null {
  const at = (scope: V2Scope, id: string | null) => (id === null ? undefined : discounts.find((d) => d.scope === scope && d.scope_id === id));
  return at('sku', sku.combo_key === '' ? null : sku.combo_key) ?? at('color', sku.color_id) ?? at('option', sku.model_id) ?? at('product', '') ?? null;
}

export type V2AnchorPick =
  | { anchor: 'sku_fixed' | 'model_fixed' | 'product_fixed'; point: V2PricePoint }
  | { anchor: 'cost'; point: null }
  | { anchor: null; code: 'V2_PRICE_MISSING' | 'V2_SCOPE_INVALID'; point: V2PricePoint | null };

/**
 * The anchor of one SKU's direct price (§1.3 step 2): a SKU fixed price, else its
 * model's fixed price, else — price-first — the product's dollar price, or —
 * cost-first — replacement cost plus minimum profit. A fixed price on an option
 * value that is not the SKU's model, and a product dollar price on a cost-first
 * product, are V2_SCOPE_INVALID; price-first without any is V2_PRICE_MISSING.
 */
export function anchorOf(points: readonly V2PricePoint[], sku: V2Sku, method: V2Method): V2AnchorPick {
  const fixed = points.filter((p) => p.kind === 'fixed');
  const notModel = fixed.find((p) => p.scope === 'option' && p.scope_id !== sku.model_id && sku.option_value_ids.includes(p.scope_id));
  if (notModel) return { anchor: null, code: 'V2_SCOPE_INVALID', point: notModel };
  const own = sku.combo_key === '' ? undefined : fixed.find((p) => p.scope === 'sku' && p.scope_id === sku.combo_key);
  if (own) return { anchor: 'sku_fixed', point: own };
  const model = sku.model_id === null ? undefined : fixed.find((p) => p.scope === 'option' && p.scope_id === sku.model_id);
  if (model) return { anchor: 'model_fixed', point: model };
  const product = fixed.find((p) => p.scope === 'product');
  if (method === 'usd') return product ? { anchor: 'product_fixed', point: product } : { anchor: null, code: 'V2_PRICE_MISSING', point: null };
  return product ? { anchor: null, code: 'V2_SCOPE_INVALID', point: product } : { anchor: 'cost', point: null };
}

/* ---------------------------------------------------------------- checks -- */

type Problem = Omit<PricingIssue, 'severity' | 'channel'>;

const levelOf = (scope: V2Scope): InputLevel => (scope === 'product' ? 'base' : scope);
const whereOf = (scope: unknown, scopeId: unknown): Pick<Problem, 'level' | 'scope_ids'> =>
  isV2Scope(scope) ? { level: levelOf(scope), scope_ids: [scope === 'product' ? '' : String(scopeId ?? '')] } : {};
const problem = (code: PricingIssueCode, scope: unknown, scopeId: unknown): Problem => ({ code, ...whereOf(scope, scopeId) });

interface Checked<T> {
  item: T;
  usd: ProcurementExact | null;
  problem: Problem | null;
}

/** The scope shape both tables share (the 0189 CHECKs): a known scope, '' exactly on the product. */
function scopeShapeOk(scope: unknown, scopeId: unknown): boolean {
  return isV2Scope(scope) && typeof scopeId === 'string' && scopeId.length <= 400 && (scope === 'product') === (scopeId === '');
}

function checkPoints(points: readonly V2PricePoint[], method: V2Method): Checked<V2PricePoint>[] {
  const checked = points.map((p): Checked<V2PricePoint> => {
    const invalid = (code: PricingIssueCode) => ({ item: p, usd: null, problem: problem(code, p?.scope, p?.scope_id) });
    if (!p || !scopeShapeOk(p.scope, p.scope_id) || (p.kind !== 'fixed' && p.kind !== 'delta')) return invalid('V2_SCOPE_INVALID');
    // product: fixed only (the price-first anchor); colour: ± only (C1); SKU: fixed only (C1).
    if ((p.scope === 'product' && p.kind !== 'fixed') || (p.scope === 'color' && p.kind !== 'delta') || (p.scope === 'sku' && p.kind !== 'fixed'))
      return invalid('V2_SCOPE_INVALID');
    if (p.scope === 'product' && method === 'cost') return invalid('V2_SCOPE_INVALID'); // the cost is the anchor
    const usd = parseV2Usd(p.usd, { signed: p.kind === 'delta' });
    return usd ? { item: p, usd, problem: null } : invalid('AMOUNT_TOO_LARGE');
  });
  return conflicts(checked, (c) => c.item?.scope, (c) => c.item?.scope_id);
}

function checkDiscounts(discounts: readonly V2Discount[]): Checked<V2Discount>[] {
  const checked = discounts.map((d): Checked<V2Discount> => {
    if (!d || !scopeShapeOk(d.scope, d.scope_id)) return { item: d, usd: null, problem: problem('V2_SCOPE_INVALID', d?.scope, d?.scope_id) };
    const usd = parseV2Usd(d.usd, { zero: true });
    return usd ? { item: d, usd, problem: null } : { item: d, usd: null, problem: problem('AMOUNT_TOO_LARGE', d.scope, d.scope_id) };
  });
  return conflicts(checked, (c) => c.item?.scope, (c) => c.item?.scope_id);
}

/** Two rows for one (scope, scope_id): the table's primary key would refuse it; never guessed. */
function conflicts<T>(checked: Checked<T>[], scopeOf: (c: Checked<T>) => unknown, idOf: (c: Checked<T>) => unknown): Checked<T>[] {
  const keyOf = (c: Checked<T>) => `${String(scopeOf(c))}\u0000${String(idOf(c))}`;
  const count = new Map<string, number>();
  for (const c of checked) count.set(keyOf(c), (count.get(keyOf(c)) ?? 0) + 1);
  return checked.map((c) => ((count.get(keyOf(c)) ?? 0) > 1 ? { ...c, usd: null, problem: problem('V2_POINT_CONFLICT', scopeOf(c), idOf(c)) } : c));
}

/* ------------------------------------------------------------------ maths -- */

const sub = (a: ProcurementExact, b: ProcurementExact): ProcurementExact => addProcurementExact(a, { num: -b.num, den: b.den });
const cmp = compareProcurementExact;
const text = procurementExactText;

function invariant(condition: boolean, what: string): void {
  // A programming error, never a data problem: thrown, never caught silently.
  if (!condition) throw new Error(`PRICING_INVARIANT: ${what}`);
}

interface Context {
  method: V2Method;
  rates: CentralRates;
  allowUnconfirmed: boolean;
  u: ProcurementExact | null;
  uText: string | null;
  uErrors: Problem[];
  uWarnings: Problem[];
  points: Checked<V2PricePoint>[];
  discounts: Checked<V2Discount>[];
}

interface Cost {
  cost: ReplacementCost;
  exact: ProcurementExact;
}

/** R on one profile, through E1's own maths. */
function costOn(resolved: ResolvedSkuInputs, profile: ShippingProfile, ctx: Context): { cost: Cost | null; errors: Problem[]; warnings: Problem[] } {
  const r = replacementCost(resolved, profile, ctx.rates, { allowUnconfirmedRates: ctx.allowUnconfirmed });
  const strip = (i: PricingIssue): Problem => {
    const { severity, channel, ...rest } = i;
    return rest;
  };
  if (!r.ok) {
    return {
      cost: null,
      errors: r.issues.filter((i) => i.severity === 'error').map(strip),
      warnings: r.issues.filter((i) => i.severity === 'warning').map(strip),
    };
  }
  return { cost: { cost: r.cost, exact: procurementExact(r.cost.replacement_exact) }, errors: [], warnings: r.warnings.map(strip) };
}

/** R on the stock route («مسار شحن المخزون», `inputs.shipping_profile`). */
function stockCost(resolved: ResolvedSkuInputs, ctx: Context): { cost: Cost | null; errors: Problem[]; warnings: Problem[] } {
  const profile = resolved.inputs.shipping_profile?.value ?? null;
  if (!profile) return { cost: null, errors: [...resolved.problems.supplier, ...resolved.problems.profile], warnings: [] };
  return costOn(resolved, profile, ctx);
}

/** The minimum profit of a cost-first SKU, exact in dinars (as E1). */
function targetOf(target: RuleResolution | undefined, ctx: Context): { exact: ProcurementExact | null; usd: string | null; errors: Problem[]; warnings: Problem[] } {
  const none = (errors: Problem[], warnings: Problem[] = []) => ({ exact: null, usd: null, errors, warnings });
  if (!target) return none([{ code: 'TARGET_PROFIT_MISSING', rule_kind: 'target_profit' }]);
  // Passing the Direct Sale Extra as the profit would silently price on it.
  invariant(target.kind === 'target_profit', 'target is a target_profit resolution');
  if (target.status !== 'active')
    return none([{ code: target.code, rule_kind: 'target_profit', ...(target.status === 'blocked' ? { rule_id: target.rule.id } : {}) }]);
  const warnings: Problem[] = target.tie ? [{ code: 'RULE_TIE', rule_kind: 'target_profit', rule_id: target.rule.id }] : [];
  const blocked: Problem = { code: 'TARGET_PROFIT_BLOCKED', rule_kind: 'target_profit', rule_id: target.rule.id };
  const usd = target.amount_usd ?? null;
  if (usd !== null) {
    const amount = parseUsdRuleAmount(usd);
    if (!amount || target.amount_iqd != null) return none([blocked], warnings); // fail closed
    if (!ctx.uText || !ctx.u) return none([], warnings); // U's own error is already on every channel
    // A tie MIXING a USD and a dinar row was ranked at a rate: it must be this one.
    if (target.ranked_at_usd_iqd != null) invariant(cmp(procurementExact(target.ranked_at_usd_iqd), ctx.u) === 0, 'a mixed tie is ranked at the rate it is priced at');
    return { exact: targetProfitExactIqd(target, ctx.uText), usd: text(amount), errors: [], warnings };
  }
  if (!isValidRuleAmount('target_profit', target.amount_iqd)) return none([blocked], warnings); // fail closed
  return { exact: procurementExact(target.amount_iqd), usd: null, errors: [], warnings };
}

/** A shelf as the maths reads it: whole dinars ≥ 0 and a positive unit count, or a programming error. */
function shelfOf(raw: V2Shelf | null | undefined): V2Shelf | null {
  if (!raw) return null;
  if (raw.state === 'sold_out') return raw;
  invariant(raw.state === 'on_shelf', 'a shelf is on_shelf or sold_out');
  invariant(Number.isSafeInteger(raw.cost_iqd) && raw.cost_iqd >= 0 && raw.cost_iqd <= MAX_FINAL_PRICE_IQD, 'a shelf cost is whole dinars');
  invariant(Number.isSafeInteger(raw.units) && raw.units > 0, 'a shelf holds whole units');
  return raw;
}

function priceSkuV2(s: V2Sku, ctx: Context): V2SkuResult {
  const { method } = ctx;
  const wanted = SKU_CHANNELS.filter((c) => s.channels.includes(c));
  const issues: PricingIssue[] = [];
  const seen = new Set<string>();
  const push = (p: Problem, severity: 'error' | 'warning', channel?: SkuChannel) => {
    const issue: PricingIssue = { ...p, severity, ...(channel ? { channel } : {}) };
    const key = JSON.stringify(issue);
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };
  const warn = (p: Problem, channel?: SkuChannel) => push(p, 'warning', channel);

  /* What every channel of this SKU needs: U, a clean setup, the anchor, D. */
  const errors: Problem[] = [...ctx.uErrors];
  ctx.uWarnings.forEach((p) => warn(p));

  const points = ctx.points.filter((c) => c.item && isV2Scope(c.item.scope) && names(c.item.scope, c.item.scope_id, s));
  const discounts = ctx.discounts.filter((c) => c.item && isV2Scope(c.item.scope) && names(c.item.scope, c.item.scope_id, s));
  for (const c of [...points, ...discounts]) if (c.problem) errors.push(c.problem);
  const validPoints = points.filter((c) => !c.problem);
  const validDiscounts = discounts.filter((c) => !c.problem);
  // A model-level discount names the SKU's model only (§1.3: "a model can carry an exception").
  for (const c of validDiscounts) if (c.item.scope === 'option' && c.item.scope_id !== s.model_id) errors.push(problem('V2_SCOPE_INVALID', 'option', c.item.scope_id));

  const pick = anchorOf(
    validPoints.map((c) => c.item),
    s,
    method
  );
  if (pick.anchor === null) errors.push(pick.point ? problem(pick.code, pick.point.scope, pick.point.scope_id) : { code: pick.code });
  const anchor: V2Anchor | null = pick.anchor;
  const anchorUsd = pick.anchor !== null && pick.anchor !== 'cost' ? parseV2Usd(pick.point.usd) : null;

  // Row 244: cost-first, the shelf prices the direct sale; a sold-out shelf goes back to the supplier.
  const shelf = method === 'cost' ? shelfOf(s.shelf) : null;
  const onShelf = shelf?.state === 'on_shelf' ? shelf : null;
  // Cost inputs: required cost-first, optional price-first (owner warnings only).
  const resolved = method === 'cost' || s.chain ? resolveSkuInputs(s.chain ?? {}) : null;
  let stock: Cost | null = null;
  let target: ReturnType<typeof targetOf> | null = null;
  let supplierErrors: Problem[] = [];
  if (resolved) {
    const r = stockCost(resolved, ctx);
    stock = r.cost;
    if (method === 'cost') {
      // On the shelf, the stock route's supplier calculation does not price the direct sale.
      if (!onShelf) {
        supplierErrors = r.errors;
        r.warnings.forEach((p) => warn(p));
      }
      target = targetOf(s.target, ctx);
      errors.push(...target.errors);
      target.warnings.forEach((p) => warn(p));
    } else if (stock && s.target) {
      // Q3: price-first reads the minimum profit only for the owner's warning; a missing or
      // blocked one is no error here (the price is the typed dollars), it just raises nothing.
      const t = targetOf(s.target, ctx);
      target = t.errors.length ? null : t;
    }
  }

  /* Each route's own cost (cost-first: required; price-first: for `below_cost`). */
  const routeCost = new Map<SkuChannel, { cost: Cost | null; errors: Problem[] }>();
  for (const channel of wanted) {
    const route = routeOfChannel(channel);
    if (!route || !resolved) continue;
    const r = costOn(resolved, ROUTE_PROFILE[route], ctx);
    if (method === 'cost') r.warnings.forEach((p) => warn(p));
    routeCost.set(channel, { cost: r.cost, errors: method === 'cost' ? r.errors : [] });
  }

  const fail = (channel: SkuChannel, list: readonly Problem[]) => list.forEach((p) => push(p, 'error', channel));
  const done = (channels: V2Channel[]): V2SkuResult => ({
    combo_key: s.combo_key,
    ok: channels.length === wanted.length && !issues.some((i) => i.severity === 'error'),
    channels,
    issues,
  });

  // Row 244: sold out and nothing to price it from — every channel of the SKU is unsold, never guessed.
  if (shelf?.state === 'sold_out' && supplierErrors.length && !errors.length) {
    for (const channel of wanted) fail(channel, [{ code: 'V2_STOCK_SOLD_OUT' }]);
    return done([]);
  }
  errors.push(...supplierErrors);

  const u = ctx.u;
  const T = target?.exact ?? null;
  // R_stock: the costliest batch on the shelf (dinars, as paid), else the stock route's supplier calculation.
  const rStock: ProcurementExact | null = onShelf ? procurementExact(onShelf.cost_iqd) : (stock?.exact ?? null);
  const minProfitAt = rStock && T ? addProcurementExact(rStock, T) : null; // R_stock + T × U
  const minDirect = method === 'cost' ? minProfitAt : null;
  if (errors.length || !u || anchor === null || (method === 'cost' && !minDirect) || (anchor !== 'cost' && !anchorUsd)) {
    for (const channel of wanted) fail(channel, [...errors, ...(routeCost.get(channel)?.errors ?? [])]);
    return done([]);
  }

  /* 2-3. The anchor and the differences, exact. */
  const eBase = anchorUsd ? mulProcurementExact(anchorUsd, u) : minDirect!;
  let deltas = ZERO;
  if (anchor !== 'sku_fixed') {
    for (const c of validPoints) if (c.item.kind === 'delta') deltas = addProcurementExact(deltas, c.usd!);
  }
  let eD = addProcurementExact(eBase, mulProcurementExact(deltas, u));
  const dUsd = anchorUsd ? addProcurementExact(anchorUsd, deltas) : null;

  /* 4. Cost-first: D is never below R_stock + T (C-9). */
  let directFloor: V2Floor = 'none';
  if (minDirect && cmp(eD, minDirect) < 0) {
    eD = minDirect;
    directFloor = 'direct_min_profit';
    warn({ code: 'V2_DIRECT_MIN_PROFIT' });
  }

  /* Q3: a typed dollar price below cost + minimum profit saves, with the owner's warning. */
  const belowMinProfit = method === 'usd' && minProfitAt !== null && cmp(eD, minProfitAt) < 0;
  if (belowMinProfit) warn({ code: 'V2_BELOW_MIN_PROFIT' });

  /* 5. D. */
  const tooLarge: Problem = { code: 'AMOUNT_TOO_LARGE' };
  if (eD.num <= 0n || cmp(eD, procurementExact(MAX_FINAL_PRICE_IQD)) > 0) {
    const p: Problem = eD.num <= 0n ? { code: 'V2_PRICE_MISSING' } : tooLarge;
    for (const channel of wanted) fail(channel, [p, ...(routeCost.get(channel)?.errors ?? [])]);
    return done([]);
  }
  const D = roundPriceIqd(eD);
  // The owner's rule on direct sale (row 187): rounding, the rate or freight never take profit below T.
  if (method === 'cost') invariant(cmp(sub(procurementExact(D), rStock!), T!) >= 0, 'cost-first: D − R_stock ≥ T');

  const common = {
    direct_iqd: D,
    direct_exact_iqd: text(eD),
    anchor,
    deltas_usd: text(deltas),
    target_profit_usd: method === 'cost' ? (target?.usd ?? null) : null,
    target_rule_id: method === 'cost' && s.target?.status === 'active' ? s.target.rule.id : null,
    target_rule_version: method === 'cost' && s.target?.status === 'active' ? s.target.rule.version : null,
  };
  const usdCeil6 = (exact: ProcurementExact) => text(ceilToPlaces(quotientProcurementExact(exact, u), USD_DISPLAY_PLACES));

  /* 6. Δ: only on a SKU that sells direct (C-8). */
  const sellsDirect = wanted.includes('direct_sale');
  const sellsRoute = wanted.some((c) => routeOfChannel(c) !== null);
  const won = resolveDiscount(
    validDiscounts.map((c) => c.item),
    s
  );
  const wonUsd = won ? validDiscounts.find((c) => c.item === won)!.usd! : ZERO;
  const delta = sellsDirect ? wonUsd : ZERO;
  const deltaFrom = sellsDirect && won ? { scope: won.scope, scope_id: won.scope_id } : null;
  if (!sellsDirect && sellsRoute && won && wonUsd.num > 0n) warn(problem('V2_DISCOUNT_IGNORED', won.scope, won.scope_id));

  const channels: V2Channel[] = [];
  for (const channel of wanted) {
    const route = routeOfChannel(channel);
    if (!route) {
      const below = method === 'usd' && stock !== null && cmp(eD, stock.exact) < 0;
      if (below) warn({ code: 'V2_BELOW_COST', profile: stock!.cost.shipping_profile }, channel);
      channels.push({
        channel,
        price_iqd: D,
        exact_iqd: text(eD),
        usd_exact: method === 'usd' && dUsd ? text(dUsd) : null,
        usd_ceil6: usdCeil6(eD),
        discount_usd: null,
        discount_from: null,
        floor: directFloor,
        replacement: onShelf ? null : (stock?.cost ?? null),
        shelf: onShelf ? { cost_iqd: onShelf.cost_iqd, units: onShelf.units } : null,
        below_cost: below,
        below_min_profit: belowMinProfit,
        ...common,
      });
      continue;
    }

    const own = routeCost.get(channel) ?? { cost: null, errors: [] };
    if (own.errors.length) {
      // Row 244: while the shelf sells, a route without its supplier calculation is simply unavailable.
      fail(channel, onShelf ? [{ code: 'V2_ROUTE_NO_SUPPLIER', profile: ROUTE_PROFILE[route] }] : own.errors);
      continue;
    }
    // Row 247 (B1 on the shelf too): every route is priced from the D the SKU actually sells at — the
    // shelf's or the supplier's —, so P ≤ D by construction and D − P is Δ. Only the Q1 floors below
    // look at the route's own supplier cost.
    const eP = sub(eD, mulProcurementExact(delta, u));
    if (eP.num <= 0n) {
      fail(channel, [deltaFrom ? problem('V2_DISCOUNT_TOO_LARGE', deltaFrom.scope, deltaFrom.scope_id) : { code: 'V2_DISCOUNT_TOO_LARGE' }]);
      continue;
    }
    let price = roundPriceIqd(eP);
    let exact = eP;
    let floor: V2Floor = directFloor;
    const rR = own.cost;
    if (method === 'cost') {
      const rExact = rR!.exact;
      // Q1 (DECISIONS row 222): a route never sells AT its own replacement cost — not even the cost rounded up
      // by the rule, which would publish it. The cost so rounded is the line: the route is blocked when even
      // the direct price does not clear it, and its discount is withdrawn when the discounted price does not.
      const rStep = roundPriceIqd(rExact);
      if (rStep >= D) {
        // Row 244: on the shelf, the shelf sells below this route's cost — stopped while it does.
        fail(channel, [{ code: onShelf ? 'V2_ROUTE_SHELF_CHEAPER' : 'V2_ROUTE_BELOW_COST', profile: ROUTE_PROFILE[route] }]);
        continue;
      }
      if (price <= rStep) {
        // Q1: the direct price, no discount on this route — never lifted to the cost.
        price = D;
        exact = eD;
        floor = 'discount_withdrawn';
        warn({ code: 'V2_DISCOUNT_WITHDRAWN', profile: ROUTE_PROFILE[route] }, channel);
      }
      invariant(price > rStep && cmp(procurementExact(price), rExact) > 0, 'a cost-first route always sells above its own cost');
    }
    const below = method === 'usd' && rR !== null && cmp(eP, rR.exact) < 0;
    if (below) warn({ code: 'V2_BELOW_COST', profile: ROUTE_PROFILE[route] }, channel);
    channels.push({
      channel,
      price_iqd: price,
      exact_iqd: text(exact),
      usd_exact: method === 'usd' && dUsd ? text(sub(dUsd, delta)) : null,
      usd_ceil6: usdCeil6(exact),
      discount_usd: text(delta),
      discount_from: deltaFrom,
      floor,
      replacement: rR?.cost ?? null,
      shelf: null,
      below_cost: below,
      below_min_profit: belowMinProfit,
      ...common,
    });
  }

  /* 7. The owner's rules, on every channel. */
  for (const c of channels) {
    const exact = procurementExact(c.exact_iqd);
    invariant(c.price_iqd <= D, 'P ≤ D');
    invariant(isOnPriceRule(c.price_iqd) && c.price_iqd <= MAX_FINAL_PRICE_IQD, 'price is on the rounding rule');
    invariant(c.price_iqd === roundPriceIqd(exact), 'price = round(exact)');
    const added = sub(procurementExact(c.price_iqd), exact);
    invariant(added.num >= 0n && cmp(added, procurementExact(PRICE_ROUNDING_STEP_IQD)) < 0, 'rounding adds less than one step');
    if (method === 'usd' && c.usd_exact !== null) invariant(cmp(mulProcurementExact(procurementExact(c.usd_exact), u), exact) === 0, 'price-first: exact = USD × U');
  }
  return done(channels);
}

/**
 * Price every SKU of one product, V2 (see the file header). Pure: the worker
 * loads the points, discounts, inputs, rules and rates and decides each SKU's
 * structural channels; this returns final prices per SKU × channel, the private
 * figures behind them, and codes for everything that is missing.
 */
export function priceProductV2(input: V2Input): V2Result {
  assertNoFloat(input, 'V2Input');
  invariant((V2_METHODS as readonly string[]).includes(input.method), 'method is cost or usd');
  invariant(!('floorMode' in input), 'the cost floor mode is retired (owner answer Q1): a floored route sells at D');
  invariant(!('step' in input), 'one rounding rule (DECISIONS row 245, roundPriceIqd): no step is passed');
  const allowUnconfirmed = input.allowUnconfirmedRates === true;

  /* 1. U: present and confirmed (an unconfirmed U is a warning in previews only). */
  const usdEntry = input.rates.fx.USD;
  const u = positiveRate(usdEntry?.rate);
  const uErrors: Problem[] = [];
  const uWarnings: Problem[] = [];
  if (!u) uErrors.push({ code: 'FX_RATE_MISSING', currency: 'USD' });
  else if (!usdEntry!.confirmed) (allowUnconfirmed ? uWarnings : uErrors).push({ code: 'FX_RATE_UNCONFIRMED', currency: 'USD' });

  const ctx: Context = {
    method: input.method,
    rates: input.rates,
    allowUnconfirmed,
    u,
    uText: u ? text(u) : null,
    uErrors,
    uWarnings,
    points: checkPoints(input.points, input.method),
    discounts: checkDiscounts(input.discounts),
  };

  const keys = new Set<string>();
  for (const s of input.skus) {
    invariant(!keys.has(s.combo_key), `combo_key ${JSON.stringify(s.combo_key)} is listed once`);
    keys.add(s.combo_key);
    invariant(skuComboKey({ option_value_ids: s.option_value_ids, color_id: s.color_id }) === s.combo_key, `combo_key ${JSON.stringify(s.combo_key)} is its selection's`);
    invariant(s.model_id === null || s.option_value_ids.includes(s.model_id), 'the model is one of the SKU option values');
  }

  const issues: PricingIssue[] = [];
  const listed = new Set<string>();
  for (const c of [...ctx.points, ...ctx.discounts]) {
    if (!c.problem) continue;
    const issue: PricingIssue = { ...c.problem, severity: 'error' };
    const key = JSON.stringify(issue);
    if (listed.has(key)) continue;
    listed.add(key);
    issues.push(issue);
  }
  const skus = input.skus.map((s) => priceSkuV2(s, ctx));
  return { ok: skus.every((s) => s.ok) && !issues.some((i) => i.severity === 'error'), skus, issues };
}
