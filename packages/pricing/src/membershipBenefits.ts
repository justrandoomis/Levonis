/**
 * WHAT A MEMBERSHIP IS WORTH, AS DATA.
 *
 * Every commercial number a PRO or PREMIUM membership grants — a percentage, a
 * fixed amount, a ceiling, how many units qualify, which delivery methods are
 * covered, whether the cash-on-delivery tax is waived — is a ROW in
 * `membership_benefit_rules`, and this module is the only thing that reads
 * them. Nothing here is a constant: the values in migration 0074's seed are
 * the owner's starting point, not the rule.
 *
 * IT IS NOT A SECOND DISCOUNT ENGINE, and the distinction matters. The three
 * things that actually move money already exist and keep their jobs:
 *
 *   `resolveUnitPrice`     decides every price, walking base -> option ->
 *                          fulfillment -> transport -> colour. A benefit rule
 *                          reaches it the same way the old `proPricingPolicy`
 *                          did — as a FALLBACK consulted only when the line
 *                          carries no explicit member price of its own.
 *   `quoteShipping`        decides every delivery fee and which components a
 *                          waiver covers.
 *   `codDeliveryTaxIqd`    calculates the tax in full, before anything waives
 *                          it, so the invoice can show both numbers.
 *
 * This module tells those three what the membership is worth. It does not
 * price anything itself, and it never sees a request, a database or a clock.
 *
 * AN EXPLICIT MEMBER PRICE ALWAYS WINS. A product carrying a typed
 * `pro_price_iqd` is an owner stating the exact number a PRO member pays for
 * that product; a rule is a default for the products nobody has typed a number
 * for. Applying both would discount the discount — the single most expensive
 * bug this design can have — so `resolveUnitPrice` consults a rule only where
 * no explicit price exists, which is exactly what it already did.
 */

import type { Tier } from './pricing';

export type BenefitType = 'product_discount' | 'free_shipping' | 'cod_tax_exemption';
export type BenefitScope = 'global' | 'category' | 'sub_category' | 'product';
export type DiscountMode = 'percent' | 'fixed';
export type CapScope = 'per_unit' | 'per_order';
/** The checkout delivery methods a shipping waiver can cover. */
export type DeliveryMethodId = 'standard' | 'personal';

/** One row of `membership_benefit_rules`, as the resolver sees it. */
export interface BenefitRule {
  id: string;
  tier: Exclude<Tier, 'free'>;
  benefit_type: BenefitType;
  scope: BenefitScope;
  category_id: string | null;
  sub_category_id: string | null;
  product_id: string | null;
  discount_mode: DiscountMode | null;
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: CapScope | null;
  max_quantity: number | null;
  min_subtotal_iqd: number | null;
  free_shipping_threshold_iqd: number | null;
  shipping_methods: DeliveryMethodId[] | null;
  max_shipping_subsidy_iqd: number | null;
  cod_tax_exempt: boolean | null;
  enabled: boolean;
  priority: number;
  valid_from: string | null;
  valid_until: string | null;
  label: string | null;
}

/** What a rule is being matched against. */
export interface BenefitTarget {
  product_id?: string | null;
  category_id?: string | null;
  sub_category_id?: string | null;
}

/**
 * SPECIFICITY, and it is the OUTER sort.
 *
 * Product beats sub-section beats section beats the tier default, and
 * `priority` only ever breaks a tie between rules at the SAME level. Letting
 * priority cross levels would mean a global rule with priority 99 silently
 * overriding the product override an admin typed for one printer — which is
 * the opposite of what "override" means to the person writing it.
 */
export const SCOPE_RANK: Record<BenefitScope, number> = {
  product: 3,
  sub_category: 2,
  category: 1,
  global: 0,
};

/** Whether a rule's scope names this product. A global rule names everything. */
export function scopeMatches(rule: BenefitRule, target: BenefitTarget): boolean {
  switch (rule.scope) {
    case 'product':
      return !!rule.product_id && rule.product_id === (target.product_id ?? null);
    case 'sub_category':
      return !!rule.sub_category_id && rule.sub_category_id === (target.sub_category_id ?? null);
    case 'category':
      return !!rule.category_id && rule.category_id === (target.category_id ?? null);
    case 'global':
      return true;
    default:
      return false;
  }
}

/** Inclusive from, exclusive-of-nothing until: an open end is simply open. */
export function withinWindow(rule: BenefitRule, nowIso: string): boolean {
  if (rule.valid_from && nowIso < rule.valid_from) return false;
  if (rule.valid_until && nowIso > rule.valid_until) return false;
  return true;
}

export interface SelectContext {
  tier: Tier;
  /** Resolved server-side. A rule is never applied to an inactive membership. */
  tierActive: boolean;
  benefitType: BenefitType;
  target?: BenefitTarget;
  /** ISO timestamp. Supplied by the caller so this stays a pure function. */
  nowIso: string;
  /** The order value a `min_subtotal_iqd` is tested against, when known. */
  subtotalIqd?: number;
}

/**
 * THE ONE RULE THAT APPLIES, or none.
 *
 * Deliberately singular. Stacking two membership discounts on one line is not
 * a feature anyone asked for and is very hard to see going wrong — the totals
 * simply come out smaller than they should, on some products, for some
 * members. The most specific valid rule wins and the rest are ignored.
 */
export function selectRule(rules: readonly BenefitRule[], ctx: SelectContext): BenefitRule | null {
  if (!ctx.tierActive || ctx.tier === 'free') return null;
  const candidates = rules.filter(
    (rule) =>
      rule.enabled &&
      rule.tier === ctx.tier &&
      rule.benefit_type === ctx.benefitType &&
      withinWindow(rule, ctx.nowIso) &&
      scopeMatches(rule, ctx.target ?? {}) &&
      (rule.min_subtotal_iqd === null ||
        ctx.subtotalIqd === undefined ||
        ctx.subtotalIqd >= rule.min_subtotal_iqd)
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => {
    const scope = SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope];
    if (scope !== 0) return scope;
    const priority = b.priority - a.priority;
    if (priority !== 0) return priority;
    // A stable last resort so two identical rules always resolve the same way.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0]!;
}

/* ------------------------------------------------------------- the money */

/**
 * WHAT ONE UNIT SAVES.
 *
 * The per-unit ceiling is applied HERE, before quantity, because that is what
 * "up to 100,000 per printer" means: two printers save 200,000. Applying the
 * same ceiling to the line total would quietly halve the second printer's
 * benefit, and nothing on the screen would say so.
 *
 * Integer dinars throughout, rounded DOWN, so a rounding error can never
 * charge a member less than the arithmetic says — and never produce a
 * fractional dinar on an invoice.
 */
export function unitDiscountIqd(regularUnitIqd: number, rule: BenefitRule | null): number {
  if (!rule || rule.benefit_type !== 'product_discount') return 0;
  const regular = Math.max(0, Math.trunc(regularUnitIqd));
  if (regular <= 0) return 0;

  let raw = 0;
  if (rule.discount_mode === 'percent') {
    const pct = rule.percent;
    if (pct === null || !Number.isFinite(pct) || pct <= 0) return 0;
    raw = Math.floor((regular * Math.min(100, pct)) / 100);
  } else if (rule.discount_mode === 'fixed') {
    const fixed = rule.fixed_iqd;
    if (fixed === null || !Number.isFinite(fixed) || fixed <= 0) return 0;
    raw = Math.trunc(fixed);
  } else {
    return 0;
  }

  if (rule.cap_scope === 'per_unit' && rule.max_discount_iqd !== null) {
    raw = Math.min(raw, Math.max(0, Math.trunc(rule.max_discount_iqd)));
  }
  // A discount never exceeds the thing it discounts.
  return Math.max(0, Math.min(raw, regular));
}

export interface LineBenefit {
  rule_id: string | null;
  scope: BenefitScope | null;
  discount_mode: DiscountMode | null;
  /** What each qualifying unit saves, after any per-unit ceiling. */
  per_unit_iqd: number;
  /** How many of the line's units qualify, after `max_quantity`. */
  eligible_qty: number;
  /** The line's whole saving, after any per-order ceiling. */
  total_iqd: number;
  /** Which ceiling actually bit, for the UI and the snapshot. */
  capped_by: 'none' | 'per_unit' | 'per_order' | 'quantity';
}

export const NO_LINE_BENEFIT: LineBenefit = {
  rule_id: null,
  scope: null,
  discount_mode: null,
  per_unit_iqd: 0,
  eligible_qty: 0,
  total_iqd: 0,
  capped_by: 'none',
};

/**
 * WHAT A WHOLE LINE SAVES.
 *
 * Quantity and the per-order ceiling live here rather than in
 * `resolveUnitPrice` because neither is a property of a unit: a rule that
 * covers the first two printers cannot be expressed as a unit price at all,
 * and pretending otherwise is how a product page ends up promising a discount
 * the cart then takes back.
 */
export function lineBenefit(input: {
  regularUnitIqd: number;
  qty: number;
  rule: BenefitRule | null;
}): LineBenefit {
  const { rule } = input;
  const qty = Math.max(0, Math.trunc(input.qty));
  if (!rule || qty === 0) return NO_LINE_BENEFIT;

  const perUnit = unitDiscountIqd(input.regularUnitIqd, rule);
  if (perUnit <= 0) return { ...NO_LINE_BENEFIT, rule_id: rule.id, scope: rule.scope };

  const limit = rule.max_quantity === null ? qty : Math.max(0, Math.trunc(rule.max_quantity));
  const eligible = Math.min(qty, limit);
  if (eligible === 0) {
    return { ...NO_LINE_BENEFIT, rule_id: rule.id, scope: rule.scope, capped_by: 'quantity' };
  }

  let total = perUnit * eligible;
  let cappedBy: LineBenefit['capped_by'] = 'none';
  if (rule.cap_scope === 'per_unit' && rule.max_discount_iqd !== null) {
    // Whether the per-unit ceiling actually bit is decided by comparing the
    // raw calculation with what was charged, not by the ceiling's presence.
    const uncapped = unitDiscountIqd(input.regularUnitIqd, { ...rule, max_discount_iqd: null });
    if (uncapped > perUnit) cappedBy = 'per_unit';
  }
  if (rule.cap_scope === 'per_order' && rule.max_discount_iqd !== null) {
    const ceiling = Math.max(0, Math.trunc(rule.max_discount_iqd));
    if (total > ceiling) {
      total = ceiling;
      cappedBy = 'per_order';
    }
  }
  if (cappedBy === 'none' && eligible < qty) cappedBy = 'quantity';

  return {
    rule_id: rule.id,
    scope: rule.scope,
    discount_mode: rule.discount_mode,
    per_unit_iqd: perUnit,
    eligible_qty: eligible,
    total_iqd: Math.max(0, total),
    capped_by: cappedBy,
  };
}

/* ---------------------------------------------------------- the shipping */

export interface ShippingBenefit {
  rule_id: string | null;
  eligible: boolean;
  threshold_iqd: number | null;
  /** Which basis figure the threshold was tested against, for the audit line. */
  basis_iqd: number;
  methods: DeliveryMethodId[] | null;
  max_subsidy_iqd: number | null;
  /** Why it did not apply, when it did not. */
  reason: 'applied' | 'no_rule' | 'below_threshold' | 'method_not_covered';
}

export const NO_SHIPPING_BENEFIT: ShippingBenefit = {
  rule_id: null,
  eligible: false,
  threshold_iqd: null,
  basis_iqd: 0,
  methods: null,
  max_subsidy_iqd: null,
  reason: 'no_rule',
};

/**
 * WHETHER DELIVERY IS FREE, and on which methods.
 *
 * The threshold is compared with `>=`: an owner who writes 75,000 means
 * "seventy-five thousand qualifies". (The store's older PRO waiver used a
 * strictly-greater test; the rule's own comparison is stated here so the two
 * can never be read off each other by accident — see `docs/MEMBERSHIP_BENEFITS.md`.)
 *
 * `methods: null` means the rule covers every method. An empty array means it
 * covers none, which is how a rule is switched off for a method without
 * deleting it.
 */
export function shippingBenefit(input: {
  rule: BenefitRule | null;
  basisIqd: number;
  method: DeliveryMethodId | null;
}): ShippingBenefit {
  const { rule } = input;
  if (!rule || rule.benefit_type !== 'free_shipping') return { ...NO_SHIPPING_BENEFIT, basis_iqd: input.basisIqd };

  const base: ShippingBenefit = {
    rule_id: rule.id,
    eligible: false,
    threshold_iqd: rule.free_shipping_threshold_iqd,
    basis_iqd: input.basisIqd,
    methods: rule.shipping_methods,
    max_subsidy_iqd: rule.max_shipping_subsidy_iqd,
    reason: 'below_threshold',
  };

  if (rule.shipping_methods !== null && (input.method === null || !rule.shipping_methods.includes(input.method))) {
    return { ...base, reason: 'method_not_covered' };
  }
  const threshold = rule.free_shipping_threshold_iqd;
  if (threshold !== null && input.basisIqd < threshold) return base;
  return { ...base, eligible: true, reason: 'applied' };
}

/** What the member actually pays after a capped subsidy. */
export function shippingAfterBenefit(feeIqd: number, benefit: ShippingBenefit): { paid_iqd: number; subsidy_iqd: number } {
  const fee = Math.max(0, Math.trunc(feeIqd));
  if (!benefit.eligible) return { paid_iqd: fee, subsidy_iqd: 0 };
  const ceiling = benefit.max_subsidy_iqd;
  const subsidy = ceiling === null ? fee : Math.min(fee, Math.max(0, Math.trunc(ceiling)));
  return { paid_iqd: fee - subsidy, subsidy_iqd: subsidy };
}

/* --------------------------------------------------------------- the tax */

export interface TaxBenefit {
  rule_id: string | null;
  cod_exempt: boolean;
}

export const NO_TAX_BENEFIT: TaxBenefit = { rule_id: null, cod_exempt: false };

/**
 * Whether the cash-on-delivery tax is waived.
 *
 * Returns only the DECISION. The caller still calculates the tax in full and
 * records both numbers, because an order that shows "COD tax: 0" cannot be
 * reconciled against a courier's cash sheet, and an invoice that never names
 * the exemption cannot explain itself to the customer who received it.
 */
export function taxBenefit(rule: BenefitRule | null): TaxBenefit {
  if (!rule || rule.benefit_type !== 'cod_tax_exemption') return NO_TAX_BENEFIT;
  return { rule_id: rule.id, cod_exempt: rule.cod_tax_exempt === true };
}
