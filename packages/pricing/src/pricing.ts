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
import { unitDiscountIqd, type BenefitRule } from './membershipBenefits';
import { effectiveBaseMonths, planFee, planTotalMonths } from './warrantyPlanMath';

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
export const PRICE_KEYS: readonly PriceKey[] = Object.keys(ADJUST_OF) as PriceKey[];
export const ADJUST_KEYS: readonly AdjustKey[] = Object.values(ADJUST_OF);

/**
 * THE RUNGS, MOST GENERAL FIRST — and the order is load-bearing.
 *
 *   base -> option -> fulfillment -> transport -> color
 *
 * COLOUR STAYS LAST, above even the transport, because a colour is a SURCHARGE
 * for the colour and is paid on every route. Putting it beneath the fulfilment
 * rung would make a fulfilment's fixed price swallow it — and that is a price
 * change for every product where a model states an absolute price and a colour
 * adds to it, which is precisely the shape migration 0073 creates from the
 * legacy "A1 mini — Direct" rows. The owner's precedence list (transport beats
 * fulfilment beats model beats product) is satisfied by the three rungs in the
 * middle; colour is not in that list because it is a different axis.
 */
type PriceSource = 'color' | 'transport' | 'fulfillment' | 'option' | 'base';

/** The walk order. `base` is the seed, so it is not a step. */
const RUNGS: Array<Exclude<PriceSource, 'base'>> = ['option', 'fulfillment', 'transport', 'color'];

/** The rows for each step, in walk order. */
interface LadderRows {
  option: PriceFields | null;
  fulfillment: PriceFields | null;
  transport: PriceFields | null;
  color: PriceFields | null;
}

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

/**
 * ONE CELL OF (MODEL x ORDER TYPE) — migration 0073's `product_option_fulfillment`.
 *
 * A model that sells both ways carries two of these. Each prices ITSELF with
 * the same four-field contract every other rung uses (NULL inherits, a fixed
 * price replaces, an adjustment moves), which is how one product can charge
 * +50,000 for a direct A1 mini and +20,000 for a direct A1 mini Combo at the
 * same time — something `products.direct_surcharge_iqd`, being ONE number,
 * never could.
 */
export interface OptionFulfillment extends PriceFields {
  fulfillment_type: 'direct_sale' | 'pre_order';
  enabled?: boolean;
  /**
   * NO DIRECT-STOCK FIELD, DELIBERATELY. Direct-sale availability is the
   * MODEL's number — `OptionV2.stock`, the row `products.inventory_mode`
   * selects — and a second direct counter here would fork the ledger.
   *
   * 0075 OVERRODE THE OTHER HALF OF THAT RULE, in the owner's words: a
   * pre-order may carry an OPTIONAL independent capacity. `capacity` below is
   * that pool; it is never the model's stock and the two are never mixed.
   */
  lead_time_text?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  /**
   * 0075 — THE MODEL'S SHARED PRE-ORDER POOL, or null/absent for UNTRACKED.
   *
   * null (and absent) = no limit is claimed: pre-orders are unlimited, which
   * is what every cell written before 0075 carries. `0` = tracked and empty.
   * The two are different answers and nothing here may conflate them, so
   * never `capacity ?? 0`.
   *
   * MEANINGLESS ON A direct_sale CELL — the direct number is `OptionV2.stock`
   * — and refused there by the writers.
   */
  capacity?: number | null;
  /** Pre-order only: how the unit reaches Iraq. Never local delivery. */
  transports?: OptionTransport[];
}

/**
 * ONE CELL OF (MODEL x PRE-ORDER x TRANSPORT) — `product_option_transports`.
 *
 * `surcharge_iqd` is a FEE and behaves like the product's transport
 * commission: added on top, waived for an active PRO. The four price fields
 * are the ITEM's own price on this route and no membership waives those. They
 * are separate on purpose — collapsing them would make the PRO waiver either
 * cancel a model's price difference or stop waiving shipping.
 */
export interface OptionTransport extends PriceFields {
  method: 'air' | 'sea' | 'land';
  enabled?: boolean;
  /** Overrides the product's commission for this method. Never adds to it. */
  surcharge_iqd?: number | null;
  /**
   * 0075 — THIS ROUTE'S OWN PRE-ORDER QUOTA, or null/absent.
   *
   * null = this route draws on the fulfilment cell's SHARED pool, so selling
   * one by air leaves one fewer for sea and for land. A number = this route
   * holds its own quota and does NOT also spend the pool: one counter per
   * sale. Nothing ever copies one quantity onto all three routes.
   */
  capacity?: number | null;
  lead_time_text?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
}

export interface OptionV2 extends PriceFields {
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
  /**
   * THE OPTION IS THE MODEL; THESE ARE ITS ORDER TYPES.
   *
   * Present from migration 0073 on. While this is empty the option resolves
   * exactly as it did before — `availability_type` above still decides its
   * route — so nothing written before 0073 moves by a dinar.
   */
  fulfillments?: OptionFulfillment[];
  /** Set by 0073 on a row merged into another model. Never sellable. */
  merged_into?: string;
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

export interface TransportOffer {
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

/**
 * THE ORIGINAL, AND NOW NARROWEST, MEMBER-DISCOUNT RULE.
 *
 * One store-wide percentage for PRO, with no ceiling, no category, no
 * quantity limit and no PREMIUM equivalent. Superseded by
 * `membership_benefit_rules` (migration 0074) and kept because five routes and
 * a dozen tests still speak it: `memberFallback` below takes precedence, and
 * this shape is normalised into the same mechanism when no rule is supplied,
 * so there is exactly ONE code path that turns a rule into a member price.
 */
export interface ProPricingPolicy {
  mode: 'explicit_only' | 'global_percent';
  percent: number | null; // e.g. 10 → 10% off regular, only in global_percent mode
}

export const DEFAULT_PRO_POLICY: ProPricingPolicy = { mode: 'explicit_only', percent: null };

/**
 * The rules that apply to THIS line, already selected by specificity. Null for
 * a tier means no configured benefit — which is not the same as a zero
 * discount: it means the tier's price is whatever the ladder says, and for a
 * product with no explicit member price that is the regular price.
 */
export interface MemberFallback {
  pro: BenefitRule | null;
  prime: BenefitRule | null;
}

/** The legacy policy, expressed as the one rule shape the resolver uses. */
export function fallbackFromProPolicy(policy: ProPricingPolicy): MemberFallback {
  if (policy.mode !== 'global_percent' || policy.percent === null || !(policy.percent > 0)) {
    return { pro: null, prime: null };
  }
  return {
    pro: {
      id: 'legacy:proPricingPolicy',
      tier: 'pro',
      benefit_type: 'product_discount',
      scope: 'global',
      category_id: null,
      sub_category_id: null,
      product_id: null,
      discount_mode: 'percent',
      percent: policy.percent,
      fixed_iqd: null,
      max_discount_iqd: null,
      cap_scope: null,
      max_quantity: null,
      min_subtotal_iqd: null,
      free_shipping_threshold_iqd: null,
      shipping_methods: null,
      max_shipping_subsidy_iqd: null,
      cod_tax_exempt: null,
      enabled: true,
      priority: 0,
      valid_from: null,
      valid_until: null,
      label: 'Store-wide PRO percentage (legacy setting)',
    },
    prime: null,
  };
}

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
  regular_iqd: number;
  pro_iqd: number | null; // resolved explicit-or-policy PRO price (null = none applies)
  prime_iqd: number | null; // resolved explicit PRIME price (null = none applies)
  applied_iqd: number; // what this buyer pays for the item itself
  applied_tier: 'regular' | 'pro' | 'prime';
  cost_iqd: number | null; // admin only — strip before public serialization
  /** Which rung set the REGULAR price. See PriceSource for the walk order. */
  price_source: PriceSource;
  /**
   * WHICH CONFIGURED RULE PRODUCED A MEMBER PRICE, per tier, or null when the
   * price came from a typed number on the line (or from nothing at all).
   *
   * The order snapshot keeps this so a receipt can name the benefit that was
   * applied, and so a later change to the rules can be told apart from a
   * change to the product's own prices when a total is questioned.
   */
  member_rule: { pro: string | null; prime: string | null };
  /**
   * WHAT THIS LINE IS, once the model's own cells have been read — written
   * into the order snapshot so a receipt never has to re-derive it.
   * `source` says where the answer came from: the customer said it, or it was
   * inferred from the presence of a transport the way it was before 0073.
   */
  fulfillment: {
    type: 'direct_sale' | 'pre_order';
    source: 'stated' | 'inferred';
    /** The model's own cell priced this line (false = product fallbacks did). */
    from_option_cell: boolean;
    /** The MODEL, by its own key — what `option_id` alone cannot name once a
     *  model has been renamed or a duplicate merged away. */
    variant_key: string;
    lead_time_text: string;
    lead_time_min_days: number | null;
    lead_time_max_days: number | null;
  };
  /**
   * EVERY PIECE OF THIS PRICE, SEPARATELY — so a receipt, a refund or an admin
   * never has to re-derive one.
   *
   * The four `*_iqd` values are the REGULAR price after each rung of the
   * ladder, so a delta is a subtraction the reader can do without guessing
   * which rung moved it: the model's difference is `option_iqd - base_iqd`,
   * the order type's is `fulfillment_iqd - option_iqd`, and so on. The fees
   * are what was actually CHARGED — zero where a waiver applied — because the
   * snapshot has to add up to what the customer paid.
   */
  components: {
    base_iqd: number;
    option_iqd: number;
    fulfillment_iqd: number;
    transport_iqd: number;
    color_iqd: number;
    /** applied − regular: the membership's effect, zero for a non-member. */
    membership_adjustment_iqd: number;
    transport_fee_iqd: number;
    direct_fee_iqd: number;
    warranty_fee_iqd: number;
  };
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
 *
 * `derived` SAYS WHICH SIDE CAME FROM A BENEFIT RULE RATHER THAN A TYPED
 * NUMBER, and it decides which way an inversion is resolved.
 *
 * When both numbers were typed by the same person, an inversion is a data
 * fault and PRIME is clamped UP to PRO, as it always was. But once one side
 * can be GENERATED — a store-wide "PRO 5% off" rule against a product whose
 * PREMIUM price the owner typed as 800 — clamping up would charge that PREMIUM
 * member 950: a rule nobody wrote for this product silently overwriting a
 * price somebody did. So when exactly one side is rule-derived, the
 * rule-derived side moves and the typed one is left exactly as typed.
 */
export function clampMemberLadder(
  regular: number,
  prime: number | null,
  pro: number | null,
  derived?: { prime?: boolean; pro?: boolean }
): { prime: number | null; pro: number | null } {
  let proOut = pro === null ? null : Math.min(pro, regular);
  let primeOut = prime === null ? null : Math.min(prime, regular);
  if (primeOut !== null && proOut !== null && proOut > primeOut) {
    const proDerived = derived?.pro === true;
    const primeDerived = derived?.prime === true;
    if (proDerived && !primeDerived) proOut = primeOut; // a rule never raises a typed PREMIUM
    else primeOut = proOut; // both typed, both derived, or only PREMIUM derived
  }
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

/**
 * THE MODEL'S OWN CELL FOR THIS ORDER TYPE, or null when it has none. A model
 * that publishes no fulfilment rows at all is a pre-0073 model: it keeps
 * answering through `availability_type` and the product's own fallbacks.
 */
export function findFulfillment(
  option: OptionV2 | null,
  type: 'direct_sale' | 'pre_order'
): OptionFulfillment | null {
  return option?.fulfillments?.find((f) => f.fulfillment_type === type) ?? null;
}

/** That cell's own row for one route. */
export function findTransport(fulfillment: OptionFulfillment | null, method: string): OptionTransport | null {
  return fulfillment?.transports?.find((t) => t.method === method) ?? null;
}

/** True when a row states anything at all about price — fixed or adjustment. */
export function statesPrice(row: PriceFields | null | undefined): boolean {
  if (!row) return false;
  return PRICE_KEYS.some((k) => row[k] !== null && row[k] !== undefined) ||
    ADJUST_KEYS.some((k) => row[k] !== null && row[k] !== undefined);
}

/** Walks base → option → fulfilment → transport → colour for PRIME or PRO. */
function pickMember(
  field: 'prime_price_iqd' | 'pro_price_iqd',
  rows: LadderRows,
  base: number | null,
  regularAt: Record<PriceSource, number | null>
): LadderTrace {
  const at: Record<PriceSource, number | null> = {
    base,
    option: base,
    fulfillment: base,
    transport: base,
    color: base,
  };
  let value = base;
  let source: PriceSource = 'base';
  // The regular price BENEATH each rung, carried forward so a rung that says
  // nothing about the regular price contributes a delta of zero.
  let regularBeneath = regularAt.base ?? 0;
  for (const rung of RUNGS) {
    const regularHere = regularAt[rung] ?? regularBeneath;
    const next = memberAtRung({
      inherited: value,
      regularDelta: regularHere - regularBeneath,
      regularHere: regularAt[rung],
      row: rows[rung],
      field,
    });
    if (rows[rung] && (next !== value || regularHere !== regularBeneath)) source = rung;
    value = next;
    at[rung] = value;
    regularBeneath = regularHere;
  }
  return { value: value ?? null, source, at };
}

function pick(
  field: PriceKey,
  rows: LadderRows,
  base: number | null,
  regularAt?: Record<PriceSource, number | null>
): LadderTrace {
  let value = base;
  let source: PriceSource = 'base';
  const at: Record<PriceSource, number | null> = {
    base,
    option: base,
    fulfillment: base,
    transport: base,
    color: base,
  };
  for (const rung of RUNGS) {
    const row = rows[rung];
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
  /**
   * THE ORDER TYPE, SAID OUT LOUD.
   *
   * Until migration 0073 this was INFERRED — a line was a pre-order if a
   * transport came with it, and a direct sale otherwise. That conflated two
   * independent decisions (`PRODUCT OPTION != ORDER TYPE != TRANSPORT`), and
   * it made "pre-order by land" the only way to say "pre-order".
   *
   * Omit it and the old inference still runs, so every caller that has not
   * been taught to send it behaves exactly as before.
   */
  fulfillmentType?: 'direct_sale' | 'pre_order' | null;
  warrantyPlanId?: string | null;
  tier: Tier;
  tierActive: boolean;
  proPolicy?: ProPricingPolicy;
  /**
   * THE CONFIGURED MEMBERSHIP BENEFIT for this line's product, one rule per
   * tier, already selected by specificity (product > sub-section > section >
   * tier default) by whoever read the table.
   *
   * It is a FALLBACK, exactly as `proPolicy` always was: a line carrying an
   * explicit member price of its own keeps it, because an owner who typed the
   * number a PRO member pays for this product has already answered the
   * question, and applying a rule on top would discount the discount.
   */
  memberFallback?: MemberFallback;
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
  const memberFallback = input.memberFallback ?? fallbackFromProPolicy(proPolicy);
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

  /**
   * THE ORDER TYPE AND THE ROUTE, RESOLVED BEFORE ANY MONEY.
   *
   * `fulfillmentType` is what the customer chose; with nothing chosen it is
   * inferred the way it always was — a transport means a pre-order — so a
   * caller that predates 0073 gets the behaviour it has always had.
   *
   * A cell that is not there, or is switched off, leaves BOTH rungs null and
   * the ladder walks straight past them onto the product's own fallbacks.
   */
  const method = (input.transportMethod ?? '').trim();
  const statedType = input.fulfillmentType === 'direct_sale' || input.fulfillmentType === 'pre_order'
    ? input.fulfillmentType
    : null;
  const inferredType: 'direct_sale' | 'pre_order' = method ? 'pre_order' : 'direct_sale';
  const lineType = statedType ?? inferredType;

  const fulfillment = findFulfillment(option, lineType);
  if (statedType && option && !fulfillment && (option.fulfillments?.length ?? 0) > 0) {
    // The model publishes its order types and this is not one of them.
    errors.push('FULFILLMENT_NOT_OFFERED');
  }
  if (fulfillment && fulfillment.enabled === false) errors.push('FULFILLMENT_DISABLED');

  const transportRow = fulfillment && method ? findTransport(fulfillment, method) : null;
  if (transportRow && transportRow.enabled === false) errors.push('TRANSPORT_DISABLED');

  const priceRows: LadderRows = {
    option,
    fulfillment: fulfillment && fulfillment.enabled !== false ? fulfillment : null,
    transport: transportRow && transportRow.enabled !== false ? transportRow : null,
    color,
  };

  // Per-field independent inheritance. Regular is resolved first because the
  // member fields may need to anchor an adjustment on it.
  const regular = pick('regular_price_iqd', priceRows, product.price_iqd);
  // PRIME and PRO carry every surcharge the regular ladder added (see
  // memberAtRung); cost does not — a surcharge says nothing about what the
  // extra costs the store, and inventing a cost would make §12 profit wrong.
  const proExplicit = pickMember('pro_price_iqd', priceRows, product.pro_price_iqd, regular.at);
  const primeExplicit = pickMember('prime_price_iqd', priceRows, product.prime_price_iqd, regular.at);
  const cost = pick('cost_iqd', priceRows, product.product_cost_iqd);

  const regularIqd = regular.value ?? product.price_iqd;
  if (!Number.isInteger(regularIqd) || regularIqd < 0) errors.push('REGULAR_PRICE_INVALID');

  /**
   * MEMBER PRICES: an explicit number first, then the configured rule.
   *
   * The order is the whole precedence policy in two lines. A typed
   * `pro_price_iqd` is the owner's answer for this exact product and wins over
   * any rule; where they typed nothing, the rule that matches most specifically
   * decides. Nothing adds the two together.
   *
   * PREMIUM resolves the same way now. It used to be explicit-price-only —
   * "§5 defines the PRIME discount as a per-product price" — which is exactly
   * the limitation that made a PREMIUM printer discount impossible to state
   * once instead of per printer.
   */
  const memberPrice = (
    explicit: number | null | undefined,
    rule: BenefitRule | null
  ): { value: number | null; rule_id: string | null } => {
    if (explicit !== null && explicit !== undefined) return { value: explicit, rule_id: null };
    const off = unitDiscountIqd(regularIqd, rule);
    if (off <= 0) return { value: null, rule_id: null };
    return { value: Math.max(0, regularIqd - off), rule_id: rule?.id ?? null };
  };

  const proResolved = memberPrice(proExplicit.value, memberFallback.pro);
  const primeResolved = memberPrice(primeExplicit.value, memberFallback.prime);
  let proIqd: number | null = proResolved.value;
  let primeIqd: number | null = primeResolved.value;

  // The ladder the customer is charged from is PRO <= PRIME <= Regular, and a
  // PRO member never pays more than a PRIME member (clampMemberLadder). The
  // Quick Edit grid applies the same function to its cells, which is what
  // keeps the admin's numbers and the cart's identical.
  const beforeClamp = { prime: primeIqd, pro: proIqd };
  ({ prime: primeIqd, pro: proIqd } = clampMemberLadder(regularIqd, primeIqd, proIqd, {
    prime: primeResolved.rule_id !== null,
    pro: proResolved.rule_id !== null,
  }));

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
  const productSaleTypes = product.sale_types && product.sale_types.length ? product.sale_types : [product.selling_type];

  /**
   * THE CHOSEN OPTION MAY DECIDE HOW THIS LINE IS FULFILLED.
   *
   * Until now a line's route came only from the product: a pre-order-only
   * product demanded a transport, a direct-only one refused it, and a product
   * selling both ways let the transport selection decide. That is still
   * exactly what happens when the option has no opinion — which is every
   * option that existed before this feature, so no priced line changes.
   *
   * When the option DOES declare itself, it narrows the line to its own route
   * and nothing else: choosing "A1 Combo — Direct Sale" cannot be turned into
   * a pre-order by adding a transport to the request, and choosing
   * "A1 Combo — Pre-order" cannot skip one. That is what makes the four
   * cells of the owner's grid genuinely independent rather than four labels
   * over one shared fulfilment decision.
   */
  const optionAvailability = effectiveAvailability(option, productSaleTypes);
  /**
   * A STATED ORDER TYPE NARROWS THE LINE, exactly as an option's own
   * declaration does — and it has to, or "pre-order" would still only be
   * sayable by naming a route.
   *
   * Before this, a product selling BOTH ways let the transport decide: with no
   * transport the line was a direct sale, whatever the customer had picked. So
   * a stated `pre_order` with no route yet resolved as a direct sale and
   * quietly skipped TRANSPORT_REQUIRED — the customer would be shown a direct
   * price for a pre-order they had explicitly chosen.
   *
   * The two answers cannot contradict each other: asking for a type the model
   * or the product does not sell is refused by name, never repriced.
   */
  if (statedType) {
    const offersIt = option?.fulfillments?.some((f) => f.fulfillment_type === statedType && f.enabled !== false);
    const declaresOther = optionAvailability && optionAvailability !== statedType;
    const productOffers = productSaleTypes.includes(statedType) || productSaleTypes.includes('bundle');
    if (!offersIt && (declaresOther || !productOffers)) {
      if (!errors.includes('FULFILLMENT_NOT_OFFERED')) errors.push('FULFILLMENT_NOT_OFFERED');
    }
  }
  const saleTypes = statedType ? [statedType] : optionAvailability ? [optionAvailability] : productSaleTypes;
  if (saleTypes.includes('pre_order') && (saleTypes.length === 1 || method)) {
    if (!method) {
      errors.push('TRANSPORT_REQUIRED');
    } else {
      /**
       * A ROUTE THE MODEL ITSELF DECLARES IS OFFERED, even when the product
       * carries no list of its own.
       *
       * 0073 moved pre-order transports onto the MODEL — the admin's «نوع
       * الطلب لكل موديل» door writes `product_option_transports` and never
       * touches `products.preorder_transports`. This line only ever consulted
       * the product column, so a shop that enabled LAND on the A1 Combo and
       * nothing at product level got `TRANSPORT_NOT_OFFERED` on a route it
       * had just configured. `saleAvailability` gated the same way, which is
       * why the option never appeared on the product page either.
       *
       * The product row stays as the FALLBACK it was always documented to be:
       * when the model declares the route, `offer` may be absent and the
       * commission ladder below falls through to the product's figure and then
       * to the admin default exactly as before.
       */
      const offer = product.preorder_transports.find((t) => t.method === method && t.active !== false) ?? null;
      const modelOffersIt = !!transportRow && transportRow.enabled !== false;
      if (!offer && !modelOffersIt) {
        errors.push('TRANSPORT_NOT_OFFERED');
      } else {
        /**
         * AN OVERRIDE REPLACES ITS FALLBACK. IT NEVER ADDS TO IT.
         *
         * The owner's rule, stated as a number: a model whose Air row says
         * 80,000 on a product whose Air says 50,000 charges 80,000 — not
         * 130,000. So the ladder is a first-match, not a sum:
         *
         *   1. this MODEL's own row for this route (`surcharge_iqd`)
         *   2. ...or zero, when that row prices the ITEM instead — the
         *      difference is already inside `applied_iqd` and charging the
         *      product's commission on top would bill it twice
         *   3. the PRODUCT's commission for this method
         *   4. the admin default for this method
         */
        let commission: number | null = null;
        if (transportRow && transportRow.enabled !== false) {
          const own = transportRow.surcharge_iqd;
          if (own !== null && own !== undefined && Number.isInteger(own) && own >= 0) commission = own;
          else if (statesPrice(transportRow)) commission = 0;
        }
        if (commission === null) commission = offer?.commission_iqd ?? null;
        if (commission === null || commission === undefined) {
          const def = (input.transportDefaults ?? []).find((d) => d.method === method);
          commission = def ? def.commission_iqd : null;
        }
        if (commission === null || commission === undefined) {
          errors.push('TRANSPORT_COMMISSION_UNCONFIGURED');
        } else if (preorderPricing === 'cod' && hasDirectPremium) {
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
  /**
   * THE MODEL'S OWN DIRECT DIFFERENCE WINS, and it wins by being IN the price.
   *
   * `products.direct_surcharge_iqd` is ONE number for a whole product, so it
   * cannot say "+50,000 on the A1 mini and +20,000 on the Combo". A model that
   * states its own direct-sale pricing has already expressed its difference in
   * `applied_iqd` through the fulfilment rung — adding the product's premium
   * on top of that would charge the difference twice. So the product number is
   * what it was always meant to be: a FALLBACK, for a model that says nothing.
   */
  const cellPricesDirect = directPriced && statesPrice(priceRows.fulfillment);
  if (directPriced && hasDirectPremium && !cellPricesDirect) {
    direct = { surcharge_iqd: directSurcharge as number, waived: isPro };
  }
  // 'preorder' only while the commission is the fee actually in force.
  const pricingBasis: ResolvedPrice['pricing_basis'] = transport !== null && !codDirectPricing ? 'preorder' : 'direct';

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
    regular_iqd: regularIqd,
    pro_iqd: proIqd,
    prime_iqd: primeIqd,
    applied_iqd: appliedIqd,
    applied_tier: appliedTier,
    /**
     * The rule is named only where it is still the reason for the number. A
     * clamp that moved a rule-derived price to the other tier's typed one
     * means the typed price is now the reason, and a receipt that still
     * credited the rule would be pointing at arithmetic that was overruled.
     */
    member_rule: {
      pro: proResolved.rule_id !== null && proIqd === beforeClamp.pro ? proResolved.rule_id : null,
      prime: primeResolved.rule_id !== null && primeIqd === beforeClamp.prime ? primeResolved.rule_id : null,
    },
    cost_iqd: cost.value ?? null,
    price_source: regular.source,
    fulfillment: {
      type: lineType,
      source: statedType ? 'stated' : 'inferred',
      from_option_cell: priceRows.fulfillment !== null,
      variant_key: option?.variant_key ?? '',
      // The most specific promise wins: this route's, else this order type's.
      lead_time_text: transportRow?.lead_time_text || fulfillment?.lead_time_text || option?.lead_time_text || '',
      lead_time_min_days:
        transportRow?.lead_time_min_days ?? fulfillment?.lead_time_min_days ?? option?.lead_time_min_days ?? null,
      lead_time_max_days:
        transportRow?.lead_time_max_days ?? fulfillment?.lead_time_max_days ?? option?.lead_time_max_days ?? null,
    },
    transport,
    direct,
    pricing_basis: pricingBasis,
    warranty,
    unit_subtotal_iqd: unitSubtotal,
    components: {
      base_iqd: regular.at.base ?? regularIqd,
      option_iqd: regular.at.option ?? regularIqd,
      fulfillment_iqd: regular.at.fulfillment ?? regularIqd,
      transport_iqd: regular.at.transport ?? regularIqd,
      color_iqd: regular.at.color ?? regularIqd,
      membership_adjustment_iqd: appliedIqd - regularIqd,
      transport_fee_iqd: commissionEffective,
      direct_fee_iqd: directFee,
      warranty_fee_iqd: warrantyFee,
    },
    errors,
  };
}

/** Reads the PRO pricing policy + transport defaults out of admin settings values. */
export function proPolicyFrom(value: unknown): ProPricingPolicy {
  const v = safeParse<ProPricingPolicy>(typeof value === 'string' ? value : JSON.stringify(value ?? null), DEFAULT_PRO_POLICY);
  if (!v || (v.mode !== 'explicit_only' && v.mode !== 'global_percent')) return DEFAULT_PRO_POLICY;
  return { mode: v.mode, percent: typeof v.percent === 'number' && v.percent > 0 && v.percent < 100 ? v.percent : null };
}
