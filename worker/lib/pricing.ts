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
 *  - Option/color prices REPLACE the applicable base price (not surcharges).
 *  - PRO members pay the resolved PRO price when one exists; otherwise the
 *    configured store-wide PRO policy applies; if no policy is configured,
 *    the regular price applies (no fabricated discount).
 *  - PRIME members pay the resolved PRIME price when one exists; PRIME has no
 *    store-wide policy fallback, so an unpriced product simply costs the
 *    regular price — a PRIME discount is never invented (product-form
 *    mandate §5).
 *  - Precedence is fixed: active PRO, then active PRIME, then regular. A
 *    member never pays more than the regular price.
 *  - Compare-at is GONE from the resolver (mandate §4: "احذف ... خانة
 *    Compare-at price من الواجهة ومن منطق العرض"). products.original_price_iqd
 *    still exists in the schema but nothing reads it any more; a later
 *    migration drops the column.
 *  - Fees: preorder transport commission (added; waived for PRO) and the
 *    selected warranty fee (added; NEVER waived by membership) compose the
 *    unit subtotal. Last-mile delivery is order-level (waived for PRO).
 */

import { safeParse } from './types';
import { effectiveAvailability } from './availability';

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
  fee_iqd: number;
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
   *  no premium. Applies only to a direct line (no transport selected);
   *  a pre-order line pays its transport commission instead, never both. */
  direct_surcharge_iqd?: number | null;
  options: OptionV2[];
  colors: ColorV2[];
  preorder_transports: TransportOffer[];
  warranty_plans: WarrantyPlanV2[];
}

export interface ResolvedPrice {
  regular_iqd: number;
  pro_iqd: number | null; // resolved explicit-or-policy PRO price (null = none applies)
  prime_iqd: number | null; // resolved explicit PRIME price (null = none applies)
  applied_iqd: number; // what this buyer pays for the item itself
  applied_tier: 'regular' | 'pro' | 'prime';
  cost_iqd: number | null; // admin only — strip before public serialization
  price_source: 'color' | 'option' | 'base';
  transport: { method: string; commission_iqd: number; waived: boolean } | null;
  /** Direct-fulfilment premium actually charged on this line (null = none). */
  direct: { surcharge_iqd: number } | null;
  warranty: { plan_id: string; title_ar: string; fee_iqd: number; duration_months: number; duration_kind: string } | null;
  unit_subtotal_iqd: number; // applied + effective commission + direct surcharge + warranty fee
  errors: string[]; // non-empty = selection invalid, reject server-side
}

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
  warrantyPlanId?: string | null;
  tier: Tier;
  tierActive: boolean;
  proPolicy?: ProPricingPolicy;
  transportDefaults?: Array<{ method: string; commission_iqd: number }>;
}): ResolvedPrice {
  const { product } = input;
  const proPolicy = input.proPolicy ?? DEFAULT_PRO_POLICY;
  const errors: string[] = [];

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
  const proExplicit = pick('pro_price_iqd', color, option, product.pro_price_iqd, regular.at);
  const primeExplicit = pick('prime_price_iqd', color, option, product.prime_price_iqd, regular.at);
  const cost = pick('cost_iqd', color, option, product.product_cost_iqd);

  const regularIqd = regular.value ?? product.price_iqd;
  if (!Number.isInteger(regularIqd) || regularIqd < 0) errors.push('REGULAR_PRICE_INVALID');

  // PRO resolution: explicit price, else policy, else none. Never above regular.
  let proIqd: number | null = null;
  if (proExplicit.value !== null && proExplicit.value !== undefined) {
    proIqd = Math.min(proExplicit.value, regularIqd);
  } else if (proPolicy.mode === 'global_percent' && proPolicy.percent !== null && proPolicy.percent > 0) {
    proIqd = Math.max(0, regularIqd - Math.floor((regularIqd * proPolicy.percent) / 100));
  }

  // PRIME resolution: explicit price only — no store-wide percentage policy,
  // because §5 defines the PRIME discount as a per-product/per-variant price.
  // Never above regular, and never below the PRO price (PRO <= PRIME <=
  // Regular): a PRIME row cheaper than PRO would be rejected at write time,
  // and clamping here keeps a legacy row from inverting the ladder at
  // checkout.
  let primeIqd: number | null = null;
  if (primeExplicit.value !== null && primeExplicit.value !== undefined) {
    primeIqd = Math.min(primeExplicit.value, regularIqd);
    if (proIqd !== null) primeIqd = Math.max(primeIqd, proIqd);
  }

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

  // Preorder transport commission — added on top; waived for active PRO.
  let transport: ResolvedPrice['transport'] = null;
  const method = (input.transportMethod ?? '').trim();
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
  const saleTypes = optionAvailability ? [optionAvailability] : productSaleTypes;
  if (saleTypes.includes('pre_order') && (saleTypes.length === 1 || method)) {
    if (!method) {
      errors.push('TRANSPORT_REQUIRED');
    } else {
      const offer = product.preorder_transports.find((t) => t.method === method && t.active !== false);
      if (!offer) {
        errors.push('TRANSPORT_NOT_OFFERED');
      } else {
        let commission = offer.commission_iqd;
        if (commission === null || commission === undefined) {
          const def = (input.transportDefaults ?? []).find((d) => d.method === method);
          commission = def ? def.commission_iqd : null;
        }
        if (commission === null || commission === undefined) {
          errors.push('TRANSPORT_COMMISSION_UNCONFIGURED');
        } else {
          // §5: "لا تمنح PRIME أي ميزة PRO أخرى تلقائيًا" — the preorder
          // commission waiver stays PRO-only.
          transport = { method, commission_iqd: commission, waived: isPro };
        }
      }
    }
  } else if (method) {
    // Direct-sale items carry no transport selection.
    errors.push('TRANSPORT_NOT_APPLICABLE');
  }

  // Direct-fulfilment premium: only when this line is actually fulfilled
  // from stock — direct sale enabled and no transport chosen. A pre-order
  // line pays its transport commission instead; the two never stack. The
  // customer is shown only the FINAL price (mandate: «يظهر له السعر النهائي
  // فقط مع الزياده»), so the premium folds into unit_subtotal_iqd exactly
  // like the commission and is never waived by membership.
  let direct: ResolvedPrice['direct'] = null;
  const directEnabled =
    saleTypes.includes('direct_sale') ||
    // A bundle is a catalogue classification, not a route, so it only enables
    // direct fulfilment while the OPTION has not named a route of its own.
    (!optionAvailability && productSaleTypes.includes('bundle'));
  const directSurcharge = product.direct_surcharge_iqd ?? null;
  if (!method && directEnabled && typeof directSurcharge === 'number' && Number.isInteger(directSurcharge) && directSurcharge > 0) {
    direct = { surcharge_iqd: directSurcharge };
  }

  // Warranty fee — added on top of the resolved price; never waived by tier.
  let warranty: ResolvedPrice['warranty'] = null;
  if (input.warrantyPlanId) {
    const plan = product.warranty_plans.find((w) => w.id === input.warrantyPlanId && w.active !== false);
    if (!plan) {
      errors.push('WARRANTY_PLAN_NOT_FOUND');
    } else {
      warranty = {
        plan_id: plan.id,
        title_ar: plan.title_ar,
        fee_iqd: plan.fee_iqd,
        duration_months: plan.duration_months,
        duration_kind: plan.duration_kind,
      };
    }
  }

  const commissionEffective = transport && !transport.waived ? transport.commission_iqd : 0;
  const warrantyFee = warranty ? warranty.fee_iqd : 0;
  const directFee = direct ? direct.surcharge_iqd : 0;
  const unitSubtotal = appliedIqd + commissionEffective + directFee + warrantyFee;

  return {
    regular_iqd: regularIqd,
    pro_iqd: proIqd,
    prime_iqd: primeIqd,
    applied_iqd: appliedIqd,
    applied_tier: appliedTier,
    cost_iqd: cost.value ?? null,
    price_source: regular.source,
    transport,
    direct,
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
