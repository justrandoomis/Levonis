/**
 * Central price resolver — the ONLY place selling prices and fees are
 * computed. Used by storefront preview, cart, server checkout, admin and
 * tests, so every surface agrees.
 *
 * Model (mandate §5):
 *  - Four nullable price fields exist at product, option, color and variant
 *    level: regular, PRIME, PRO, cost. NULL means "inherit" down the chain
 *    variant → color → option → product base, PER FIELD independently. Zero
 *    is an explicit value, never treated as blank (no truthiness checks).
 *  - An option/colour REGULAR price is a rung on the ladder: a fixed number
 *    replaces what is beneath it, an adjustment moves it. Either way the
 *    difference it makes to the regular price is a SURCHARGE (or reduction)
 *    that EVERY tier pays — see "the member ladder follows the regular one"
 *    below. Base 150,000 / PRIME 125,000 / PRO 100,000 with an option
 *    +25,000 sells at 175,000 / 150,000 / 125,000; add a direct-sale
 *    premium of 100,000 and the line is 275,000 / 250,000 / 125,000 — the
 *    availability premium is the one surcharge an active PRO does NOT pay
 *    (the owner: «Pro Card users are exempt from this additional
 *    shipping-type cost»), on the same gate as the commission waiver.
 *  - PRO members pay the resolved PRO price when one exists; otherwise the
 *    configured store-wide PRO policy applies; otherwise the PRIME price when
 *    one exists on the line (a PRO member never pays more than a PRIME
 *    member); if none of those exist, the regular price applies (no
 *    fabricated discount).
 *  - PRIME members pay the resolved PRIME price when one exists; PRIME has no
 *    store-wide policy fallback, so an unpriced product simply costs the
 *    regular price — a PRIME discount is never invented (product-form
 *    mandate §5).
 *  - Precedence is fixed: active PRO, then active PRIME, then regular. A
 *    member never pays more than the regular price, and the ladder the
 *    resolver hands out is always PRO <= PRIME <= Regular
 *    (`clampMemberLadder`).
 *  - Compare-at is GONE from the resolver (mandate §4: "احذف ... خانة
 *    Compare-at price من الواجهة ومن منطق العرض"). products.original_price_iqd
 *    still exists in the schema but nothing reads it any more; a later
 *    migration drops the column.
 *  - Fees: the availability fee — EITHER the pre-order transport commission
 *    OR the direct-sale premium, never both, both waived for an active PRO —
 *    and the selected warranty fee (added; NEVER waived by membership)
 *    compose the unit subtotal. Last-mile delivery is order-level (waived
 *    for PRO). A printer's extended-warranty plan may be priced as a PERCENT
 *    of the line's REGULAR price (worker/lib/warrantyPlans.ts `planFee`) —
 *    tier-neutral by construction, rounded once to an integer dinar here.
 *  - Payment method × availability (owner mandate): a pre-order line paid in
 *    advance keeps its transport commission; a pre-order line paid CASH ON
 *    DELIVERY is priced exactly like a direct sale (base + direct premium),
 *    while the line stays a pre-order — its transport, journey, stages and
 *    tracking are untouched. `preorderPricing` carries that choice in and
 *    `pricing_basis` reports which rule priced the line; the transport object
 *    is kept with its method and marked `waived_by: 'cod_direct_pricing'`.
 *    "Priced as a direct sale" needs a direct-sale premium to price WITH: a
 *    product that has none configured (the normal shape of a pre-order-only
 *    product) keeps its commission under cash on delivery — otherwise the
 *    store would lose the commission and charge nothing in its place, making
 *    the door cheaper than the wallet, the opposite of the owner's intent.
 */

import { safeParse } from './json';
import { effectiveAvailability } from './availability';
import { effectiveBaseMonths, planFee, planTotalMonths } from './warrantyPlanMath';
import { modelSaleTypes, modelTransports, leadTimeOf, type ModelAvailability, type ModelTransport, type FulfillmentType, type SelectionPriceSnapshot } from './fulfillment';

export type Tier = 'free' | 'plus' | 'pro' | 'prime';

/** Ranking used wherever "the better membership wins" (mandate §5:
 *  "ترتيب تحديد السعر والميزة: PRO الفعّال أولًا، ثم PRIME الفعّال، ثم
 *  المستخدم الاعتيادي"). Higher = stronger. */
export const TIER_RANK: Record<Tier, number> = { free: 0, plus: 1, prime: 2, pro: 3 };

export interface PriceFields {
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  /**
   * ADJUSTMENTS (migration 0044). A signed number of dinars applied to the
   * value this row would otherwise have inherited for the SAME field. Optional
   * everywhere, and null on every row written before 0044, so a catalogue that
   * has never used them resolves byte-for-byte as it always did.
   *
   * The MODE IS DERIVED, never stored (see `priceMode` below):
   *   price null, adjust null  -> INHERIT
   *   price null, adjust set   -> ADJUSTMENT
   *   price set                -> FIXED  (a typed number is an answer; an
   *                                       adjustment beside it is a leftover)
   */
  regular_adjust_iqd?: number | null;
  prime_adjust_iqd?: number | null;
  pro_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
}

/** The four fields a price ladder is made of, and their adjustment twins. */
export type PriceKey = 'regular_price_iqd' | 'prime_price_iqd' | 'pro_price_iqd' | 'cost_iqd';
export type AdjustKey = 'regular_adjust_iqd' | 'prime_adjust_iqd' | 'pro_adjust_iqd' | 'cost_adjust_iqd';
export const ADJUST_OF: Record<PriceKey, AdjustKey> = {
  regular_price_iqd: 'regular_adjust_iqd',
  prime_price_iqd: 'prime_adjust_iqd',
  pro_price_iqd: 'pro_adjust_iqd',
  cost_iqd: 'cost_adjust_iqd',
};

export type PriceMode = 'inherit' | 'adjust' | 'fixed';

/**
 * Which of the owner's three modes (§5) one row is in for one field. Read from
 * the row, never stored beside it — two columns already say it unambiguously,
 * and a third that repeats them is a value that can go stale.
 */
export function priceMode(row: Partial<PriceFields> | null | undefined, field: PriceKey): PriceMode {
  if (!row) return 'inherit';
  const fixed = row[field];
  if (fixed !== null && fixed !== undefined) return 'fixed';
  const adj = row[ADJUST_OF[field]];
  if (adj !== null && adj !== undefined && Number.isFinite(adj)) return 'adjust';
  return 'inherit';
}

export interface OptionV2 extends PriceFields, ModelAvailability {
  id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  image: string;
  order: number;
  active: boolean;
  /**
   * HOW THIS ONE OPTION IS FULFILLED. '' (or absent) = inherit the product's
   * sale_types, which is what every option written before this feature does —
   * so an old product behaves exactly as it always did. See
   * worker/lib/availability.ts for the inheritance rule.
   */
  availability_type?: '' | 'direct_sale' | 'pre_order';
  /** Shown when this option is a pre-order. Prose wins over the day numbers. */
  lead_time_text?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  /** The MODEL this option is a fulfilment of — 'a1' vs 'a1-combo'. */
  variant_key?: string;
  variant_label?: string;
  /** Sellable units at this level; null = this level does not track stock. */
  stock?: number | null;
  // ---- carried for the ADMIN surfaces only; pricing never reads them ------
  /**
   * The option GROUP this value belongs to ("Model", "Availability", …).
   *
   * The relational model is groups → values; every flat consumer — pricing,
   * the cart, the TXT template — sees only the values. Without this the group
   * a value came from is unrecoverable, so a product with «1 مجموعة · 4 قيمة»
   * exported as four ungrouped options and re-imported as four separate
   * groups. Carrying the NAME (not the id) also means the template can name a
   * group that does not exist yet and have it created.
   */
  group_en?: string;
  /** The fragment this option contributes to a built SKU. */
  sku_part?: string;
  /** Warn level for this option's own stock; null = no warning configured. */
  low_stock_threshold?: number | null;
}

export interface ColorV2 extends PriceFields {
  id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  hex: string;
  image: string;
  option_id: string | null; // linked to one option, or null = available to all
  order: number;
  active: boolean;
  // ---- carried for the ADMIN surfaces only; pricing never reads them ------
  /**
   * EVERY option this colour is available for, not just the one `option_id`
   * can hold. A colour linked to two of four options is the normal case in the
   * admin form, and `option_id` is deliberately left null for it (see
   * applyRelations) — so without this list the template could neither show nor
   * restore that constraint.
   */
  option_ids?: string[];
  /** Sellable units of this colour; null = this level does not track stock. */
  stock?: number | null;
  /** Warn level for this colour's own stock; null = none configured. */
  low_stock_threshold?: number | null;
  /** The fragment this colour contributes to a built SKU. */
  sku_part?: string;
}

export interface TransportOffer extends Partial<Omit<ModelTransport, 'enabled'>> {
  method: 'air' | 'sea' | 'land';
  commission_iqd: number | null; // null = inherit admin default
  active: boolean;
}

export interface WarrantyPlanV2 {
  id: string;
  title_ar: string;
  title_en: string;
  title_ckb: string;
  terms_ar: string;
  terms_en: string;
  terms_ckb: string;
  duration_months: number;
  duration_kind: 'total' | 'extension';
  /** Fixed fee in IQD — the charged amount when `fee_percent` is null, and
   *  the honest fallback a template or CSV may still write. */
  fee_iqd: number;
  /**
   * PERCENT-BASED FEE (the owner's model for printer extensions: e.g. 7.5% or
   * 10% of the printer price). Applied to the line's REGULAR price — the
   * price before any membership — and rounded to an integer dinar by
   * worker/lib/warrantyPlans.ts `planFee`, so the fee is identical for a
   * guest, a PRIME and a PRO member (the warranty fee is never waived). null =
   * this plan charges its fixed `fee_iqd`.
   */
  fee_percent: number | null;
  order: number;
  active: boolean;
}

export interface ProPricingPolicy {
  mode: 'explicit_only' | 'global_percent';
  percent: number | null; // e.g. 10 → 10% off regular, only in global_percent mode
}

export const DEFAULT_PRO_POLICY: ProPricingPolicy = { mode: 'explicit_only', percent: null };

export interface PricingProduct {
  price_iqd: number; // base regular (required, canonical)
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  product_cost_iqd: number | null;
  /** Legacy scalar, kept in sync with sale_types[0]; `sale_types` is the
   *  authority when present (mandate §6). */
  selling_type: string;
  /** Multi-select sale types: 'direct_sale' | 'pre_order' | 'bundle'. */
  sale_types?: string[];
  /** Availability premium for DIRECT fulfilment (from-stock, ships now).
   *  The owner prices immediacy the way transports price their journey:
   *  e.g. base 100k — direct +50k, land +15k, air +25k, sea +0. NULL/0 =
   *  no premium. Applies to a direct line (no transport selected) and to a
   *  pre-order line paid cash on delivery (`preorderPricing: 'cod'`); a
   *  prepaid pre-order line pays its transport commission instead — never
   *  both. With NO premium configured, cash on delivery has nothing to price
   *  the pre-order line "as direct" with, so the commission stays. Waived
   *  for an active PRO, like the commission. */
  direct_surcharge_iqd?: number | null;
  options: OptionV2[];
  colors: ColorV2[];
  preorder_transports: TransportOffer[];
  warranty_plans: WarrantyPlanV2[];
  /**
   * The product's configured BASE coverage in months (products.ops_policy
   * `warranty_base_months`; a printer defaults to 12 on write). An extension
   * plan's total is base + extension; with no configured base the total is
   * null — honest, never assumed.
   */
  warranty_base_months?: number | null;
}

/**
 * The chosen warranty plan, resolved for THIS line and frozen verbatim into
 * order_items.warranty_snapshot at checkout. `fee_iqd` is the integer dinar
 * actually charged (percent plans already applied to `basis_iqd`, the line's
 * regular price); `base_months` / `total_months` are what the delivered unit
 * will record (deviceOps.computeCoverage prefers them over a later change of
 * the product's policy), so "+12 → 24 total" survives the cart.
 */
export interface ResolvedWarranty {
  plan_id: string;
  title_ar: string;
  title_en: string;
  fee_iqd: number;
  duration_months: number;
  duration_kind: string;
  fee_percent: number | null;
  basis_iqd: number;
  base_months: number | null;
  total_months: number | null;
}

export interface ResolvedPrice {
  selection_snapshot?: SelectionPriceSnapshot;
  regular_iqd: number;
  pro_iqd: number | null; // resolved explicit-or-policy PRO price (null = none applies)
  prime_iqd: number | null; // resolved explicit PRIME price (null = none applies)
  applied_iqd: number; // what this buyer pays for the item itself
  applied_tier: 'regular' | 'pro' | 'prime';
  cost_iqd: number | null; // admin only — strip before public serialization
  price_source: 'color' | 'option' | 'base';
  /**
   * The pre-order journey this line is on (null on a direct line). The
   * method is what shipping_type, the stage path, tracking and the pre-order
   * gift are derived from, so it is KEPT even when the commission is not
   * charged; `waived_by` says why it is not: the PRO waiver, or the line
   * being priced as a direct sale because it is paid cash on delivery.
   */
  transport: {
    method: string;
    commission_iqd: number;
    waived: boolean;
    waived_by?: 'pro' | 'cod_direct_pricing';
  } | null;
  /** Direct-sale premium that APPLIES to this line (null = none configured or
   *  not a direct-priced line). `waived` = an active PRO pays 0 of it. */
  direct: { surcharge_iqd: number; waived: boolean } | null;
  /** Which rule priced the availability fee: 'preorder' = the transport
   *  commission; 'direct' = the direct-sale premium (a direct line, or a
   *  pre-order line paid cash on delivery). */
  pricing_basis: 'direct' | 'preorder';
  warranty: ResolvedWarranty | null;
  unit_subtotal_iqd: number; // applied + effective commission + effective direct surcharge + warranty fee
  errors: string[]; // non-empty = selection invalid, reject server-side
}

/** How a pre-order line is being paid, which decides its availability fee. */
export type PreorderPricing = 'prepaid' | 'cod';

type PriceSource = 'color' | 'option' | 'base';

/** The value of one field after each rung of the ladder — needed so a member
 *  adjustment with nothing of its own to inherit can anchor on the regular
 *  price AT THE SAME RUNG rather than on the product's. */
interface LadderTrace {
  value: number | null;
  source: PriceSource;
  at: Record<PriceSource, number | null>;
}

/**
 * Walks base -> option -> colour for ONE field.
 *
 * A rung with a fixed price REPLACES what came below it (unchanged behaviour,
 * and the reason worker/lib/pinnedPrices.ts exists). A rung with an adjustment
 * MOVES what came below it by that many dinars, clamped at zero.
 *
 * `regularAt` is passed only for PRIME and PRO. When one of them has nothing to
 * inherit — no member price is set anywhere below — an adjustment on it anchors
 * on the regular price resolved at that same rung, because "PRO pays 15,000
 * less" can only mean less than what everyone else pays. COST gets no such
 * fallback: a cost adjustment with no cost beneath it stays inherit, because
 * inventing a cost from a selling price would make the profit figures of §12
 * confidently wrong.
 */
/**
 * THE MEMBER LADDER FOLLOWS THE REGULAR ONE — the owner's rule:
 *
 *   «الخيارات والألوان والشحن تبقى تكاليف إضافية»: a member price is an
 *   OFFSET from the base, and everything a customer adds on top of the base
 *   costs every tier the same.
 *
 * So at each rung (option, then colour) a PRIME/PRO field that says nothing
 * of its own does not merely inherit the value beneath it — it inherits that
 * value PLUS the change this rung made to the regular price. A rung that
 * states its own member price replaces it (as ever); a rung with a member
 * ADJUSTMENT applies it on top of that carried value ("PRO gets 5,000 more
 * off on this option"), or on the rung's regular price when no member price
 * exists beneath — "PRO pays 15,000 less" can only mean less than everyone
 * else pays.
 *
 * A REDUCTION that swallows the member price (base PRO 90,000, option
 * −100,000) leaves nothing to carry: the member simply pays the reduced
 * regular price — or, for a PRO member whose line still has a PRIME price,
 * that PRIME price (`clampMemberLadder`). The write-time validators refuse
 * such a row unless it states its own member price, so this is a safety net
 * for legacy rows, not a path.
 */
export function memberAtRung(input: {
  /** the member price resolved beneath this rung (null = no member price anywhere below) */
  inherited: number | null;
  /** regular at this rung − regular beneath it: what this rung adds for everyone */
  regularDelta: number;
  /** the regular price resolved AT this rung — the anchor for an adjustment with nothing beneath */
  regularHere: number | null;
  row: PriceFields | null;
  field: 'prime_price_iqd' | 'pro_price_iqd';
}): number | null {
  const { inherited, regularDelta, regularHere, row, field } = input;
  const carried =
    inherited === null ? null : inherited + regularDelta > 0 ? Math.round(inherited + regularDelta) : null;
  if (!row) return carried;
  const fixed = row[field];
  if (fixed !== null && fixed !== undefined) return fixed;
  const adj = row[ADJUST_OF[field]];
  if (adj !== null && adj !== undefined && Number.isFinite(adj)) {
    const anchor = carried !== null ? carried : regularHere;
    if (anchor === null) return carried;
    return Math.max(0, Math.round(anchor + adj));
  }
  return carried;
}

/** The three selling prices one level of the ladder resolves to. */
export interface LadderRungs {
  regular: number;
  prime: number | null;
  pro: number | null;
}

/**
 * THE RESOLVER'S FINAL WORD on a line's member prices — applied after the
 * ladder has been walked, and mirrored by the Quick Edit grid so that what the
 * admin sees is what the customer is charged:
 *   - neither member price is ever above the regular price;
 *   - PRIME is never below PRO (a PRIME row cheaper than PRO would be refused
 *     at write time; a legacy row is clamped up rather than inverting the
 *     ladder at checkout);
 *   - a PRO member never pays more than a PRIME member: a line with a PRIME
 *     price but no PRO price of its own — none configured, or the base PRO
 *     swallowed by a reduction — charges PRO members the PRIME price.
 * Nothing here invents a discount: with no member price on the line at all,
 * both stay null and the regular price applies.
 */
export function clampMemberLadder(regular: number, prime: number | null, pro: number | null): { prime: number | null; pro: number | null } {
  let proOut = pro === null ? null : Math.min(pro, regular);
  let primeOut = prime === null ? null : Math.min(prime, regular);
  if (primeOut !== null && proOut !== null) primeOut = Math.max(primeOut, proOut);
  if (proOut === null && primeOut !== null) proOut = primeOut;
  return { prime: primeOut, pro: proOut };
}

/**
 * What ONE row resolves to on top of the level beneath it — the write-time
 * validators' view of the ladder (productModel, productRelations, importCsv,
 * and the client mirror in src/components/adminProducts/form/model.ts).
 * `consumed` names the member fields the row would inherit but cannot: the
 * row's reduction is at least as large as the member price beneath it, so the
 * resolver would charge the member the reduced regular price. `inverted` says
 * the row's derived PRO is above its derived PRIME — the resolver would clamp
 * PRIME up to PRO, charging a PRIME member a number the row never shows.
 * Validators refuse both unless the row states its own member price.
 */
export function derivedRung(
  row: PriceFields,
  beneath: LadderRungs
): LadderRungs & { consumed: Array<'prime' | 'pro'>; inverted: boolean } {
  const regAdj = row.regular_adjust_iqd;
  const regular =
    row.regular_price_iqd !== null && row.regular_price_iqd !== undefined
      ? row.regular_price_iqd
      : regAdj !== null && regAdj !== undefined && Number.isFinite(regAdj)
        ? Math.max(0, Math.round(beneath.regular + regAdj))
        : beneath.regular;
  const regularDelta = regular - beneath.regular;
  const consumed: Array<'prime' | 'pro'> = [];
  const member = (field: 'prime_price_iqd' | 'pro_price_iqd', inherited: number | null) => {
    const own = row[field];
    const adj = row[ADJUST_OF[field]];
    const statesOwn = (own !== null && own !== undefined) || (adj !== null && adj !== undefined);
    if (inherited !== null && !statesOwn && regular > 0 && inherited + regularDelta <= 0) {
      consumed.push(field === 'prime_price_iqd' ? 'prime' : 'pro');
    }
    return memberAtRung({ inherited, regularDelta, regularHere: regular, row, field });
  };
  const prime = member('prime_price_iqd', beneath.prime);
  const pro = member('pro_price_iqd', beneath.pro);
  return { regular, prime, pro, consumed, inverted: prime !== null && pro !== null && pro > prime };
}

/** Walks base → option → colour for PRIME or PRO with the rule above. */
function pickMember(
  field: 'prime_price_iqd' | 'pro_price_iqd',
  color: ColorV2 | null,
  option: OptionV2 | null,
  base: number | null,
  regularAt: Record<PriceSource, number | null>
): LadderTrace {
  const at: Record<PriceSource, number | null> = { base, option: base, color: base };
  let value = base;
  let source: PriceSource = 'base';
  const regularBase = regularAt.base ?? 0;
  const regularOption = regularAt.option ?? regularBase;
  const regularColor = regularAt.color ?? regularOption;
  const rungs: Array<[Exclude<PriceSource, 'base'>, PriceFields | null, number, number | null]> = [
    ['option', option, regularOption - regularBase, regularAt.option],
    ['color', color, regularColor - regularOption, regularAt.color],
  ];
  for (const [rung, row, regularDelta, regularHere] of rungs) {
    const next = memberAtRung({ inherited: value, regularDelta, regularHere, row, field });
    if (row && (next !== value || regularDelta !== 0)) source = rung;
    value = next;
    at[rung] = value;
  }
  return { value: value ?? null, source, at };
}

function pick(
  field: PriceKey,
  color: ColorV2 | null,
  option: OptionV2 | null,
  base: number | null,
  regularAt?: Record<PriceSource, number | null>
): LadderTrace {
  let value = base;
  let source: PriceSource = 'base';
  const at: Record<PriceSource, number | null> = { base, option: base, color: base };
  const rungs: Array<[Exclude<PriceSource, 'base'>, PriceFields | null]> = [
    ['option', option],
    ['color', color],
  ];
  for (const [rung, row] of rungs) {
    if (row) {
      const fixed = row[field];
      if (fixed !== null && fixed !== undefined) {
        value = fixed;
        source = rung;
      } else {
        const adj = row[ADJUST_OF[field]];
        if (adj !== null && adj !== undefined && Number.isFinite(adj)) {
          const anchor = value !== null && value !== undefined ? value : regularAt?.[rung] ?? null;
          if (anchor !== null) {
            value = Math.max(0, Math.round(anchor + adj));
            source = rung;
          }
        }
      }
    }
    at[rung] = value;
  }
  return { value: value ?? null, source, at };
}

export function resolveUnitPrice(input: {
  product: PricingProduct;
  optionId?: string | null;
  colorId?: string | null;
  transportMethod?: string | null; // '' | air | sea | land
  fulfillmentType?: FulfillmentType | null;
  warrantyPlanId?: string | null;
  tier: Tier;
  tierActive: boolean;
  proPolicy?: ProPricingPolicy;
  transportDefaults?: Array<{ method: string; commission_iqd: number }>;
  /**
   * How a PRE-ORDER line is paid. 'prepaid' (the default, and the only thing
   * the cart and the product page can know) keeps the commission pricing;
   * 'cod' — the checkout's answer once the customer picked cash on delivery —
   * prices the line as a direct sale WHEN the product carries a direct-sale
   * premium (see `codDirectPricing` below). Ignored on a direct line.
   */
  preorderPricing?: PreorderPricing;
  /**
   * The owner's catalog flag (worker/lib/printerIdentity.ts). A printer whose
   * ops_policy never stated a base is read with the 12-month printer default,
   * so its extension's total is 24/36 here exactly as it will be on the unit.
   * Absent = not a printer: nothing is assumed.
   */
  isPrinter?: boolean;
}): ResolvedPrice {
  const { product } = input;
  const proPolicy = input.proPolicy ?? DEFAULT_PRO_POLICY;
  const preorderPricing: PreorderPricing = input.preorderPricing === 'cod' ? 'cod' : 'prepaid';
  const errors: string[] = [];
  // The direct-sale premium, read once: it decides both what a direct-priced
  // line pays and whether cash on delivery can re-price a pre-order at all.
  const directSurcharge = product.direct_surcharge_iqd ?? null;
  const hasDirectPremium = typeof directSurcharge === 'number' && Number.isInteger(directSurcharge) && directSurcharge > 0;

  const option = input.optionId
    ? product.options.find((o) => o.id === input.optionId) ?? null
    : null;
  if (input.optionId && !option) errors.push('OPTION_NOT_FOUND');
  if (option && option.active === false) errors.push('OPTION_INACTIVE');

  const color = input.colorId
    ? product.colors.find((c) => c.id === input.colorId) ?? null
    : null;
  if (input.colorId && !color) errors.push('COLOR_NOT_FOUND');
  if (color && color.active === false) errors.push('COLOR_INACTIVE');
  // A linked color is valid only with its assigned option.
  if (color && color.option_id && color.option_id !== (option?.id ?? null)) {
    errors.push('COLOR_OPTION_MISMATCH');
  }

  // Per-field independent inheritance. Regular is resolved first because the
  // member fields may need to anchor an adjustment on it.
  const regular = pick('regular_price_iqd', color, option, product.price_iqd);
  // PRIME and PRO carry every surcharge the regular ladder added (see
  // memberAtRung); cost does not — a surcharge says nothing about what the
  // extra costs the store, and inventing a cost would make §12 profit wrong.
  const proExplicit = pickMember('pro_price_iqd', color, option, product.pro_price_iqd, regular.at);
  const primeExplicit = pickMember('prime_price_iqd', color, option, product.prime_price_iqd, regular.at);
  const cost = pick('cost_iqd', color, option, product.product_cost_iqd);

  let regularIqd = regular.value ?? product.price_iqd;
  if (!Number.isInteger(regularIqd) || regularIqd < 0) errors.push('REGULAR_PRICE_INVALID');

  // PRO resolution: explicit price, else policy, else (below) the line's PRIME
  // price, else none.
  let proIqd: number | null = null;
  if (proExplicit.value !== null && proExplicit.value !== undefined) {
    proIqd = proExplicit.value;
  } else if (proPolicy.mode === 'global_percent' && proPolicy.percent !== null && proPolicy.percent > 0) {
    proIqd = Math.max(0, regularIqd - Math.floor((regularIqd * proPolicy.percent) / 100));
  }

  // PRIME resolution: explicit price only — no store-wide percentage policy,
  // because §5 defines the PRIME discount as a per-product/per-variant price.
  let primeIqd: number | null =
    primeExplicit.value !== null && primeExplicit.value !== undefined ? primeExplicit.value : null;

  // The ladder the customer is charged from is PRO <= PRIME <= Regular, and a
  // PRO member never pays more than a PRIME member (clampMemberLadder). The
  // Quick Edit grid applies the same function to its cells, which is what
  // keeps the admin's numbers and the cart's identical.
  ({ prime: primeIqd, pro: proIqd } = clampMemberLadder(regularIqd, primeIqd, proIqd));

  // §5 precedence: active PRO first, then active PRIME, then regular.
  const isPro = input.tier === 'pro' && input.tierActive;
  const isPrime = input.tier === 'prime' && input.tierActive;
  let appliedIqd = regularIqd;
  let appliedTier: 'regular' | 'pro' | 'prime' = 'regular';
  if (isPro && proIqd !== null) {
    appliedIqd = proIqd;
    appliedTier = 'pro';
  } else if (isPrime && primeIqd !== null) {
    appliedIqd = primeIqd;
    appliedTier = 'prime';
  }

  // Preorder transport commission — added on top; waived for active PRO, and
  // not charged at all when the line is paid cash on delivery (priced as a
  // direct sale below — the transport itself stays, because the journey does).
  let transport: ResolvedPrice['transport'] = null;
  const method = (input.transportMethod ?? '').trim();
  const productSaleTypes = product.sale_types && product.sale_types.length ? product.sale_types : [product.selling_type];

  // Options are real models. Fulfillment and transport select independent
  // pricing/availability rows. Legacy availability is read-only compatibility.
  const optionAvailability = effectiveAvailability(option, productSaleTypes);
  const canonical = option?.direct !== undefined || option?.preorder !== undefined;
  const allowedTypes = canonical ? modelSaleTypes(option, productSaleTypes) : optionAvailability ? [optionAvailability] : productSaleTypes;
  const fulfillmentType = input.fulfillmentType ?? ((method && allowedTypes.includes('pre_order')) || (allowedTypes.includes('pre_order') && !allowedTypes.includes('direct_sale') && !allowedTypes.includes('bundle')) ? 'pre_order' : 'direct_sale');
  if (!allowedTypes.includes(fulfillmentType) && !(fulfillmentType === 'direct_sale' && allowedTypes.includes('bundle'))) errors.push('FULFILLMENT_NOT_OFFERED');
  if (method && !allowedTypes.includes('pre_order')) errors.push('TRANSPORT_NOT_APPLICABLE');
  const saleTypes = [fulfillmentType];
  const offers = modelTransports(product, option);
  if (saleTypes.includes('pre_order') && (saleTypes.length === 1 || method)) {
    if (!method) {
      errors.push('TRANSPORT_REQUIRED');
    } else {
      const offer = offers.find((t) => t.method === method && t.active !== false);
      if (!offer) {
        errors.push('TRANSPORT_NOT_OFFERED');
      } else {
        let commission = offer.surcharge_iqd ?? offer.commission_iqd;
        // An exact transport price/adjustment replaces the inherited commission.
        if (offer.regular_price_iqd != null || offer.regular_adjust_iqd != null) commission = 0;
        if (commission === null || commission === undefined) {
          const def = (input.transportDefaults ?? []).find((d) => d.method === method);
          commission = def ? def.commission_iqd : null;
        }
        if (commission === null || commission === undefined) {
          errors.push('TRANSPORT_COMMISSION_UNCONFIGURED');
        } else if (!canonical && preorderPricing === 'cod' && hasDirectPremium) {
          // Cash on delivery: the owner's rule is that this line follows the
          // DIRECT-SALE pricing, so the commission is not the fee here — the
          // direct premium below is. The method stays: shipping_type, the
          // fourteen stages, tracking and the gift rule all read it. Only
          // when there IS a direct premium to price the line with: a product
          // with none keeps its commission (the branch below), so the door is
          // never cheaper than the wallet.
          transport = { method, commission_iqd: commission, waived: true, waived_by: 'cod_direct_pricing' };
        } else {
          // §5: "لا تمنح PRIME أي ميزة PRO أخرى تلقائيًا" — the preorder
          // commission waiver stays PRO-only.
          transport = isPro
            ? { method, commission_iqd: commission, waived: true, waived_by: 'pro' }
            : { method, commission_iqd: commission, waived: false };
        }
      }
    }
  } else if (method) {
    // Direct-sale items carry no transport selection.
    errors.push('TRANSPORT_NOT_APPLICABLE');
  }

  // Direct-sale premium. It applies on a line PRICED as a direct sale: one
  // actually fulfilled from stock (direct sale enabled, no transport chosen),
  // or a pre-order line paid cash on delivery (`codDirectPricing` — the
  // transport resolved above and the commission stepped aside). A prepaid
  // pre-order line pays its commission instead; the two never stack. The
  // customer is shown only the FINAL price (mandate: «يظهر له السعر النهائي
  // فقط مع الزياده»), so the premium folds into unit_subtotal_iqd exactly
  // like the commission — and, like the commission, an active PRO is exempt
  // from it (the owner: «Pro Card users are exempt from this additional
  // shipping-type cost»). The resolver's `isPro` is already the checkout's
  // proContext gate (approved default address, benefits not restricted), so
  // the two waivers can never disagree about who is PRO.
  let direct: ResolvedPrice['direct'] = null;
  const directEnabled =
    saleTypes.includes('direct_sale') ||
    // A bundle is a catalogue classification, not a route, so it only enables
    // direct fulfilment while the OPTION has not named a route of its own.
    (!optionAvailability && productSaleTypes.includes('bundle'));
  const codDirectPricing = transport !== null && transport.waived_by === 'cod_direct_pricing';
  const directPriced = (!method && directEnabled) || codDirectPricing;
  if (directPriced && hasDirectPremium) {
    direct = { surcharge_iqd: directSurcharge as number, waived: isPro };
  }
  // 'preorder' only while the commission is the fee actually in force.
  const pricingBasis: ResolvedPrice['pricing_basis'] = transport !== null && !codDirectPricing ? 'preorder' : 'direct';

  const modelRegular = regularIqd;
  let fulfillmentDelta = 0;
  let transportDelta = 0;
  const fulfillment = fulfillmentType === 'pre_order' ? option?.preorder : option?.direct;
  const selectedTransport = fulfillmentType === 'pre_order' ? offers.find((t) => t.method === method && t.active !== false) : undefined;
  const fields = (row: Partial<PriceFields>): PriceFields => ({ regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, ...row });
  let resolvedCost = cost.value;
  const applyCost = (row: Partial<PriceFields>) => {
    if (row.cost_iqd != null) resolvedCost = row.cost_iqd;
    else if (row.cost_adjust_iqd != null && resolvedCost != null) resolvedCost = Math.max(0, resolvedCost + row.cost_adjust_iqd);
  };
  if (fulfillment) {
    const directFallback = fulfillmentType === 'direct_sale' && fulfillment.regular_price_iqd == null && fulfillment.regular_adjust_iqd == null;
    const row = fields({ ...fulfillment, ...(directFallback ? { regular_adjust_iqd: directSurcharge ?? 0 } : {}) });
    const beneath = { regular: regularIqd, prime: primeIqd, pro: proIqd };
    const rung = derivedRung(row, { regular: regularIqd, prime: primeIqd, pro: proIqd });
    fulfillmentDelta = rung.regular - regularIqd;
    regularIqd = rung.regular;
    primeIqd = rung.prime;
    proIqd = rung.pro;
    if (directFallback && isPro && fulfillment.pro_price_iqd == null) proIqd = (beneath.pro ?? beneath.prime ?? beneath.regular) + (fulfillment.pro_adjust_iqd ?? 0);
    if (fulfillmentType === 'direct_sale') direct = null;
    applyCost(fulfillment);
  }
  if (selectedTransport && (canonical || (['regular_price_iqd', 'prime_price_iqd', 'pro_price_iqd', 'regular_adjust_iqd', 'prime_adjust_iqd', 'pro_adjust_iqd'] as const).some((k) => selectedTransport[k] != null))) {
    const surcharge = selectedTransport.surcharge_iqd ?? selectedTransport.commission_iqd ?? input.transportDefaults?.find((t) => t.method === method)?.commission_iqd ?? 0;
    const transportFields = fields({ ...selectedTransport, regular_adjust_iqd: selectedTransport.regular_adjust_iqd ?? surcharge });
    const beneath = { regular: regularIqd, prime: primeIqd, pro: proIqd };
    const rung = derivedRung(transportFields, beneath);
    transportDelta = rung.regular - regularIqd;
    regularIqd = rung.regular;
    primeIqd = rung.prime;
    proIqd = rung.pro;
    // Exempt only the transport move. The model and fulfillment rungs survive.
    if (isPro && selectedTransport.pro_price_iqd == null) {
      proIqd = (beneath.pro ?? beneath.prime ?? beneath.regular) + (selectedTransport.pro_adjust_iqd ?? 0);
    }
    applyCost(selectedTransport);
    // The transport price is now in the ladder, so it must not be charged twice.
    if (transport) transport = { ...transport, commission_iqd: 0 };
  }
  if (fulfillment || selectedTransport) {
    ({ prime: primeIqd, pro: proIqd } = clampMemberLadder(regularIqd, primeIqd, proIqd));
    appliedIqd = isPro ? proIqd ?? regularIqd : isPrime ? primeIqd ?? regularIqd : regularIqd;
    appliedTier = isPro && proIqd !== null ? 'pro' : isPrime && primeIqd !== null ? 'prime' : 'regular';
  }

  // Warranty fee — added on top of the resolved price; never waived by tier.
  // A percent plan is priced on the REGULAR price of this exact selection
  // (option and colour surcharges included), so a PRO and a guest pay the
  // same dinar for the same extension; the rounding happens once, here, and
  // the product page, the cart and the checkout all read this number.
  let warranty: ResolvedPrice['warranty'] = null;
  if (input.warrantyPlanId) {
    const plan = product.warranty_plans.find((w) => w.id === input.warrantyPlanId && w.active !== false);
    if (!plan) {
      errors.push('WARRANTY_PLAN_NOT_FOUND');
    } else {
      // A printer's base defaults to 12 months when its ops_policy never said
      // (worker/lib/warrantyPlans.ts) — the same answer the delivered unit
      // will record, so the snapshot's 24/36 promise is one the store keeps.
      const baseMonths = effectiveBaseMonths(product.warranty_base_months ?? null, input.isPrinter === true);
      warranty = {
        plan_id: plan.id,
        title_ar: plan.title_ar,
        title_en: plan.title_en,
        fee_iqd: planFee(plan, regularIqd),
        duration_months: plan.duration_months,
        duration_kind: plan.duration_kind,
        fee_percent: plan.fee_percent ?? null,
        basis_iqd: regularIqd,
        base_months: baseMonths,
        total_months: planTotalMonths(plan, baseMonths),
      };
    }
  }

  const commissionEffective = transport && !transport.waived ? transport.commission_iqd : 0;
  const warrantyFee = warranty ? warranty.fee_iqd : 0;
  const directFee = direct && !direct.waived ? direct.surcharge_iqd : 0;
  const unitSubtotal = appliedIqd + commissionEffective + directFee + warrantyFee;

  return {
    selection_snapshot: {
      fulfillment_type: fulfillmentType,
      transport_method: transport ? transport.method as 'air' | 'sea' | 'land' : null,
      membership_tier: isPro ? 'pro' : isPrime ? 'prime' : 'regular',
      resolved_product_base: product.price_iqd,
      resolved_option_delta: modelRegular - product.price_iqd,
      resolved_fulfillment_delta: fulfillmentDelta + directFee,
      resolved_transport_delta: transportDelta + commissionEffective,
      resolved_membership_adjustment: appliedIqd - regularIqd,
      resolved_delivery_fee: 0,
      resolved_final_price: unitSubtotal,
      lead_time: leadTimeOf(selectedTransport, fulfillment, option),
    },
    regular_iqd: regularIqd,
    pro_iqd: proIqd,
    prime_iqd: primeIqd,
    applied_iqd: appliedIqd,
    applied_tier: appliedTier,
    cost_iqd: resolvedCost ?? null,
    price_source: regular.source,
    transport,
    direct,
    pricing_basis: pricingBasis,
    warranty,
    unit_subtotal_iqd: unitSubtotal,
    errors,
  };
}

/** Reads the PRO pricing policy + transport defaults out of admin settings values. */
export function proPolicyFrom(value: unknown): ProPricingPolicy {
  const v = safeParse<ProPricingPolicy>(typeof value === 'string' ? value : JSON.stringify(value ?? null), DEFAULT_PRO_POLICY);
  if (!v || (v.mode !== 'explicit_only' && v.mode !== 'global_percent')) return DEFAULT_PRO_POLICY;
  return { mode: v.mode, percent: typeof v.percent === 'number' && v.percent > 0 && v.percent < 100 ? v.percent : null };
}
