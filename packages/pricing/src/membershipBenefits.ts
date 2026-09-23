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
  /**
   * Every section ABOVE this product's own two, so a rule written on
   * "Printers" reaches a product filed under "Printers → FDM → Bambu".
   * Supplied by the worker from the `catalogs` tree; omitting it falls back to
   * exact matching (see `scopeMatches`).
   */
  ancestry?: readonly string[] | null;
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
/**
 * A SECTION RULE COVERS THE WHOLE BRANCH BENEATH IT.
 *
 * The taxonomy has no fixed depth: an admin can file a product under
 * "Printers → FDM → Bambu" and nothing stops them. Matching only the id on the
 * product row would leave a rule on "Printers" quietly skipping that product —
 * the discount would simply not appear, on some products, for some members,
 * with nothing on any screen to say why. So the caller supplies the product's
 * `ancestry` (every section above it, inclusive) and a rule matches anywhere in
 * it. Callers with no tree to walk pass nothing and get exact matching, which
 * is what every pure test does.
 */
function inBranch(ruleId: string | null, exact: string | null | undefined, ancestry: readonly string[] | null | undefined): boolean {
  if (!ruleId) return false;
  if (ruleId === (exact ?? null)) return true;
  return ancestry ? ancestry.includes(ruleId) : false;
}

export function scopeMatches(rule: BenefitRule, target: BenefitTarget): boolean {
  switch (rule.scope) {
    case 'product':
      return !!rule.product_id && rule.product_id === (target.product_id ?? null);
    case 'sub_category':
      return inBranch(rule.sub_category_id, target.sub_category_id, target.ancestry);
    case 'category':
      return inBranch(rule.category_id, target.category_id, target.ancestry);
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
      /**
       * A minimum-order rule FAILS CLOSED when the caller does not know the
       * order value. Passing it instead would put a discount on a product card
       * that the checkout then refuses to honour, and "the price changed when
       * I got to the cart" is the exact complaint this whole system exists to
       * prevent. Surfaces that want to advertise such a rule say "from X",
       * which is a different sentence from a price.
       */
      (rule.min_subtotal_iqd === null ||
        (ctx.subtotalIqd !== undefined && ctx.subtotalIqd >= rule.min_subtotal_iqd))
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

/**
 * WHETHER A RULE'S WHOLE EFFECT FITS IN A UNIT PRICE.
 *
 * This is the line that decides WHERE a rule is applied, and it exists so that
 * every rule is applied exactly once. A percentage with a per-unit ceiling is
 * a property of one unit, so `resolveUnitPrice` bakes it into the price and
 * the product page, the cart and the checkout all quote the same number
 * without any of them knowing about benefit rules.
 *
 * A quantity limit, a per-ORDER ceiling and a minimum order value are
 * properties of the ORDER. None can be written as a unit price — "the first
 * two printers" is not a price — so a rule carrying one is deliberately kept
 * OUT of the unit price and applied once, at the line, where the quantity and
 * the order total are known. Letting such a rule into the unit price is how a
 * cart ends up discounting the third printer it promised not to.
 */
export function isUnitExpressible(rule: BenefitRule | null): boolean {
  if (!rule || rule.benefit_type !== 'product_discount') return false;
  if (rule.max_quantity !== null) return false;
  if (rule.min_subtotal_iqd !== null) return false;
  if (rule.cap_scope === 'per_order' && rule.max_discount_iqd !== null) return false;
  return true;
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
  /**
   * WHERE THE MONEY ALREADY IS.
   *
   * 'unit' — `resolveUnitPrice` has already taken `total_iqd` off this line's
   * unit price, so the caller must NOT subtract it again; it is reported only
   * so the cart can say what the membership was worth.
   * 'line' — the unit price is the regular one and the caller subtracts
   * `total_iqd` from the line once. See `isUnitExpressible`.
   */
  applied_at: 'unit' | 'line';
}

export const NO_LINE_BENEFIT: LineBenefit = {
  rule_id: null,
  scope: null,
  discount_mode: null,
  per_unit_iqd: 0,
  eligible_qty: 0,
  total_iqd: 0,
  capped_by: 'none',
  applied_at: 'unit',
};

/**
 * WHAT A WHOLE LINE SAVES — one line on its own. The same arithmetic as
 * `orderLineBenefits` for a cart of one line, which is what it is.
 */
export function lineBenefit(input: LineBenefitInput): LineBenefit {
  return orderLineBenefits([input])[0]!;
}

export interface LineBenefitInput {
  regularUnitIqd: number;
  qty: number;
  rule: BenefitRule | null;
}

/** Whether a rule carries a limit that belongs to the ORDER, not to a line. */
function hasOrderWideLimit(rule: BenefitRule): boolean {
  return rule.max_quantity !== null || (rule.cap_scope === 'per_order' && rule.max_discount_iqd !== null);
}

/**
 * WHAT EVERY LINE OF ONE ORDER SAVES.
 *
 * Quantity and the per-order ceiling live here rather than in
 * `resolveUnitPrice` because neither is a property of a unit: a rule that
 * covers the first two printers cannot be expressed as a unit price at all,
 * and pretending otherwise is how a product page ends up promising a discount
 * the cart then takes back.
 *
 * A PER-ORDER LIMIT IS SPENT ONCE PER ORDER, NOT ONCE PER LINE. `per_order`
 * is what the admin chose and what the cart says («الخصم بحد أقصى لكل طلب»),
 * so a rule's `max_discount_iqd` with `cap_scope: 'per_order'`, and its
 * `max_quantity`, are budgets shared by every line the rule covers. This used
 * to be applied to each line separately, so two different printers under one
 * rule capped at 100,000 per order saved 200,000.
 *
 * The budget goes to the rule's lines with the LARGEST per-unit saving first
 * (ties in cart order), so the customer gets the most the rule allows and the
 * answer does not change when the cart is reordered. Each line then carries
 * the part it actually received, so the per-line figures an order snapshots
 * add up to the clamped total exactly.
 *
 * Answers in input order, one entry per input.
 */
export function orderLineBenefits(inputs: readonly LineBenefitInput[]): LineBenefit[] {
  const out: LineBenefit[] = inputs.map(() => NO_LINE_BENEFIT);
  const budgets = new Map<string, { qty: number; iqd: number }>();
  const perUnitOf = inputs.map((i) => unitDiscountIqd(i.regularUnitIqd, i.rule));

  // Largest saving first, then cart order: who draws on a shared budget first.
  const order = inputs.map((_, i) => i).sort((a, b) => perUnitOf[b]! - perUnitOf[a]! || a - b);

  for (const i of order) {
    const input = inputs[i]!;
    const { rule } = input;
    const qty = Math.max(0, Math.trunc(input.qty));
    if (!rule || qty === 0) continue;
    const appliedAt: LineBenefit['applied_at'] = isUnitExpressible(rule) ? 'unit' : 'line';

    const perUnit = perUnitOf[i]!;
    if (perUnit <= 0) {
      out[i] = { ...NO_LINE_BENEFIT, rule_id: rule.id, scope: rule.scope, applied_at: appliedAt };
      continue;
    }

    // The rule's shared budget, opened by the first of its lines to arrive.
    let budget = hasOrderWideLimit(rule) ? budgets.get(rule.id) : undefined;
    if (hasOrderWideLimit(rule) && !budget) {
      budget = {
        qty: rule.max_quantity === null ? Infinity : Math.max(0, Math.trunc(rule.max_quantity)),
        iqd:
          rule.cap_scope === 'per_order' && rule.max_discount_iqd !== null
            ? Math.max(0, Math.trunc(rule.max_discount_iqd))
            : Infinity,
      };
      budgets.set(rule.id, budget);
    }

    const eligible = Math.min(qty, budget ? budget.qty : qty);
    if (eligible === 0) {
      out[i] = { ...NO_LINE_BENEFIT, rule_id: rule.id, scope: rule.scope, capped_by: 'quantity', applied_at: appliedAt };
      continue;
    }

    let total = perUnit * eligible;
    let cappedBy: LineBenefit['capped_by'] = 'none';
    if (rule.cap_scope === 'per_unit' && rule.max_discount_iqd !== null) {
      // Whether the per-unit ceiling actually bit is decided by comparing the
      // raw calculation with what was charged, not by the ceiling's presence.
      const uncapped = unitDiscountIqd(input.regularUnitIqd, { ...rule, max_discount_iqd: null });
      if (uncapped > perUnit) cappedBy = 'per_unit';
    }
    if (budget && total > budget.iqd) {
      total = budget.iqd;
      cappedBy = 'per_order';
    }
    if (cappedBy === 'none' && eligible < qty) cappedBy = 'quantity';
    if (budget) {
      budget.qty -= eligible;
      budget.iqd -= total;
    }

    out[i] = {
      rule_id: rule.id,
      scope: rule.scope,
      discount_mode: rule.discount_mode,
      per_unit_iqd: perUnit,
      eligible_qty: eligible,
      total_iqd: Math.max(0, total),
      capped_by: cappedBy,
      applied_at: appliedAt,
    };
  }
  return out;
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
 * THE THRESHOLD IS STRICTLY GREATER: 75,000 does NOT qualify, 75,001 does.
 * That is the owner's CONFIRMED rule and the comparison `quoteShipping` has
 * always used (`packages/shipping/src/shipping.ts`), so the rules table
 * changes WHAT the number is and never what comparing against it means. Two
 * engines with two operators would make the same order free on one screen and
 * not on the next, which is precisely the class of bug a single configured
 * threshold exists to remove. Written down in `docs/MEMBERSHIP_BENEFITS.md`.
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
  if (threshold !== null && input.basisIqd <= threshold) return base;
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
