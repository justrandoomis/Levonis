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
}

export interface OptionV2 extends PriceFields {
  id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  image: string;
  order: number;
  active: boolean;
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

function pick(field: keyof PriceFields, color: ColorV2 | null, option: OptionV2 | null, base: number | null): { value: number | null; source: 'color' | 'option' | 'base' } {
  if (color && color[field] !== null && color[field] !== undefined) return { value: color[field], source: 'color' };
  if (option && option[field] !== null && option[field] !== undefined) return { value: option[field], source: 'option' };
  return { value: base, source: 'base' };
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

  // Per-field independent inheritance.
  const regular = pick('regular_price_iqd', color, option, product.price_iqd);
  const proExplicit = pick('pro_price_iqd', color, option, product.pro_price_iqd);
  const primeExplicit = pick('prime_price_iqd', color, option, product.prime_price_iqd);
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
  const saleTypes = product.sale_types && product.sale_types.length ? product.sale_types : [product.selling_type];
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
  const directEnabled = saleTypes.includes('direct_sale') || saleTypes.includes('bundle');
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
