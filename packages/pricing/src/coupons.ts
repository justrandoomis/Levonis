/**
 * THE COUPON RESOLVER — which lines a coupon names, and what it takes off them.
 *
 * Pure: no database, no clock, no request. Everything it needs is passed in,
 * so every rule below is provable in a unit test and provable in the same way
 * at the cart, at the quote and at the till. `membershipBenefits.ts` next door
 * is the same shape for the same reason, and this file deliberately borrows
 * its vocabulary — scope with ancestry, percent-or-fixed, a cap that knows
 * whether it is per unit or per order — rather than inventing a second one.
 *
 * ========================= THE OWNER'S DECISIONS =========================
 *
 * Every rule here traces to an answer the owner gave. They are written down
 * because each of them is a different amount of money and none is guessable.
 *
 *  1. A SCOPED COUPON DISCOUNTS ONLY THE LINES IT NAMES.
 *     20% off filament, in a cart holding 100,000 of filament and 900,000 of
 *     printer, is 20,000 — not 200,000. An unscoped coupon names every line,
 *     which is what every coupon written before this file did.
 *
 *  2. A PERCENTAGE IS TAKEN OFF THE GOODS, NOT OFF THE FEES.
 *     A line's stored unit price is `applied + freight commission + direct
 *     surcharge + warranty fee` (pricing.ts). The last three are cash the shop
 *     owes a forwarder, a carrier and a warranty book — discounting them pays
 *     that money out of margin. On a 950,000 printer with a 200,000 warranty
 *     and 150,000 of air freight, "10% off" was really 13.8%. So the caller
 *     passes `unit_goods_iqd` and the fees never enter the arithmetic.
 *
 *  3. A FIXED AMOUNT IS ONE AMOUNT, NOT ONE PER UNIT.
 *     "خصم بقيمة تسعمائة ألف" is 950,000 off the order, so three A1 Combos on
 *     one line take 950,000 between them, not 2,850,000. A percentage is the
 *     opposite — it is inherently per unit — which is exactly why `cap_scope`
 *     has to exist and has to be stored rather than assumed.
 *
 *  4. THE CAP KNOWS WHAT IT CAPS. `per_unit` ceilings each unit's own
 *     discount, so two printers under a 100,000 cap save 200,000; `per_order`
 *     ceilings the coupon once. 0074 made this distinction first and its
 *     comment says why: getting it wrong is a real amount of money.
 *
 *  5. A COUPON CAN NAME THE DELIVERY INSTEAD OF THE GOODS, or both — the
 *     admin chooses per coupon. «خصم على التوصيل العادي» reduces the delivery
 *     fee and leaves the filament's price alone.
 *
 * ============================== WHAT IT IS NOT ==============================
 *
 * This file does not decide ELIGIBILITY — the audience, the window, the usage
 * limits and the personal assignment are the caller's, because each needs the
 * database or the clock. It decides only the two questions that are pure:
 * WHICH LINES, and HOW MUCH.
 */

/** 'global' matches everything; the rest name a target the line must sit in. */
export type CouponScope = 'global' | 'category' | 'sub_category' | 'product' | 'brand' | 'bundle';
export type CouponKind = 'fixed_iqd' | 'percent';
export type CapScope = 'per_unit' | 'per_order';
export type AppliesTo = 'merchandise' | 'delivery' | 'both';

export interface CouponRule {
  scope: CouponScope;
  category_id: string | null;
  sub_category_id: string | null;
  product_id: string | null;
  brand_id: string | null;
  bundle_product_id: string | null;
  /** The MODEL (a product_option_values id) — "A1 Combo", not "A1". */
  option_value_id: string | null;
  color_id: string | null;
  /** Allowed sets. EMPTY MEANS ANY — an unfiltered axis, not a closed door. */
  fulfillment_types: readonly string[];
  transport_methods: readonly string[];
  delivery_methods: readonly string[];
  kind: CouponKind;
  value: number;
  max_discount_iqd: number | null;
  cap_scope: CapScope;
  max_quantity: number | null;
  applies_to: AppliesTo;
  stacks: boolean;
}

export interface CouponLine {
  line_id: string;
  product_id: string;
  /** Every option value on the line, so a model filter can find one. */
  option_value_ids: readonly string[];
  color_id: string;
  brand_id: string | null;
  category_id: string | null;
  sub_category_id: string | null;
  /** Every section above this product, inclusive. See `inBranch`. */
  ancestry: readonly string[] | null;
  /** Set only when the line IS a bundle; a component line carries null. */
  bundle_product_id: string | null;
  fulfillment_type: string;
  transport_method: string;
  qty: number;
  /**
   * GOODS PER UNIT. The merchandise value alone — never the freight
   * commission, the direct-sale surcharge or the warranty fee. See decision 2.
   */
  unit_goods_iqd: number;
  /** True when a membership rule or an offer already discounted this line. */
  already_discounted: boolean;
}

export interface CouponContext {
  /** The chosen last-mile method, or null when it is not known yet (the cart). */
  delivery_method: string | null;
  /** The delivery fee a 'delivery' or 'both' coupon may reduce. */
  delivery_iqd: number;
}

/**
 * A SECTION NAMES THE WHOLE BRANCH BENEATH IT — the same rule, and the same
 * reasoning, as membershipBenefits.inBranch. The taxonomy has no fixed depth,
 * so matching only the id on the product row would leave a coupon on
 * "Printers" quietly skipping a product filed under "Printers → FDM → Bambu",
 * with nothing on any screen to say why.
 */
function inBranch(
  ruleId: string | null,
  exact: string | null | undefined,
  ancestry: readonly string[] | null | undefined
): boolean {
  if (!ruleId) return false;
  if (ruleId === (exact ?? null)) return true;
  return ancestry ? ancestry.includes(ruleId) : false;
}

/** An empty allowed set means the axis is not filtered at all. */
function axisAllows(allowed: readonly string[], actual: string | null): boolean {
  if (allowed.length === 0) return true;
  if (!actual) return false;
  return allowed.includes(actual);
}

/** Does this coupon's SCOPE name this line? Filters are applied separately. */
export function scopeNamesLine(rule: CouponRule, line: CouponLine): boolean {
  switch (rule.scope) {
    case 'product':
      return !!rule.product_id && rule.product_id === line.product_id;
    case 'brand':
      return !!rule.brand_id && rule.brand_id === line.brand_id;
    case 'bundle':
      return !!rule.bundle_product_id && rule.bundle_product_id === line.bundle_product_id;
    case 'sub_category':
      return inBranch(rule.sub_category_id, line.sub_category_id, line.ancestry);
    case 'category':
      return inBranch(rule.category_id, line.category_id, line.ancestry);
    case 'global':
      return true;
    default:
      return false;
  }
}

/**
 * Does the coupon match this line in full — scope AND every filter?
 *
 * `delivery_method` is a property of the ORDER, not of a line, so it is tested
 * once here against the context. When it is not yet known (the cart page, which
 * runs before an address is chosen) a coupon that filters on it CANNOT MATCH —
 * it fails closed, exactly as membershipBenefits does for `min_subtotal_iqd`,
 * so a cart never advertises a discount the checkout then refuses.
 */
export function couponMatchesLine(rule: CouponRule, line: CouponLine, ctx: CouponContext): boolean {
  if (!scopeNamesLine(rule, line)) return false;
  if (rule.option_value_id && !line.option_value_ids.includes(rule.option_value_id)) return false;
  if (rule.color_id && rule.color_id !== line.color_id) return false;
  if (!axisAllows(rule.fulfillment_types, line.fulfillment_type || null)) return false;
  if (!axisAllows(rule.transport_methods, line.transport_method || null)) return false;
  if (rule.delivery_methods.length > 0 && !axisAllows(rule.delivery_methods, ctx.delivery_method)) return false;
  if (!rule.stacks && line.already_discounted) return false;
  return true;
}

/** True when the coupon filters on something the cart cannot know yet. */
export function needsDeliveryChoice(rule: CouponRule): boolean {
  return rule.delivery_methods.length > 0;
}

export interface CouponAllocation {
  /** Per line, the amount this coupon takes off it. Sums to merchandise_iqd. */
  lines: Array<{ line_id: string; amount_iqd: number }>;
  merchandise_iqd: number;
  delivery_iqd: number;
  total_iqd: number;
  /** Lines the coupon named, before any money was worked out. */
  matched_line_ids: string[];
  /** Goods value the coupon could draw on. 0 means nothing matched. */
  matched_goods_iqd: number;
}

const EMPTY: CouponAllocation = {
  lines: [],
  merchandise_iqd: 0,
  delivery_iqd: 0,
  total_iqd: 0,
  matched_line_ids: [],
  matched_goods_iqd: 0,
};

/** A whole number of dinars, never negative. */
const dinars = (n: number): number => Math.max(0, Math.floor(Number(n) || 0));

/**
 * WHAT THE COUPON TAKES OFF, AND FROM WHICH LINE.
 *
 * The per-line breakdown is not decoration: it is frozen onto `order_items`
 * so a later refund can give back what the customer ACTUALLY PAID for the line
 * being returned. Prorating an order-wide figure across lines — which is what
 * this codebase did before there was anything to prorate against — is wrong in
 * both directions the moment a coupon is targeted: return the untouched
 * filament from a 950,000-printer-coupon order and the customer is short-
 * changed; return the printer and the shop pays out more than it took.
 *
 * ALLOCATION IS LARGEST-REMAINDER. Integer division loses a dinar or two per
 * line; handing those to the largest remainders keeps the per-line figures
 * summing EXACTLY to the discount the customer was shown. A cent of drift here
 * becomes a receipt that does not add up.
 */
export function allocateCoupon(
  rule: CouponRule,
  lines: readonly CouponLine[],
  ctx: CouponContext
): CouponAllocation {
  const matched = lines.filter((l) => couponMatchesLine(rule, l, ctx));
  const wantsGoods = rule.applies_to === 'merchandise' || rule.applies_to === 'both';
  const wantsDelivery = rule.applies_to === 'delivery' || rule.applies_to === 'both';

  // A delivery-only coupon still has to NAME something in the cart: it is a
  // discount on delivering THESE goods, not a standing delivery subsidy.
  if (matched.length === 0) return EMPTY;

  // How many units qualify, taken in cart order so the answer is stable.
  let quota = rule.max_quantity === null ? Infinity : Math.max(0, Math.trunc(rule.max_quantity));
  const eligible = matched.map((l) => {
    const take = Math.max(0, Math.min(l.qty, quota));
    quota -= take;
    return { line: l, units: take };
  });
  const matchedGoods = eligible.reduce((s, e) => s + dinars(e.line.unit_goods_iqd) * e.units, 0);

  let goodsDiscount = 0;
  const perLine: Array<{ line_id: string; amount_iqd: number }> = [];

  if (wantsGoods && matchedGoods > 0) {
    if (rule.kind === 'percent') {
      // Per unit by nature, so a per-unit cap bites here, before quantity.
      for (const e of eligible) {
        if (e.units === 0) continue;
        let unit = Math.floor((dinars(e.line.unit_goods_iqd) * rule.value) / 100);
        if (rule.cap_scope === 'per_unit' && rule.max_discount_iqd !== null) {
          unit = Math.min(unit, dinars(rule.max_discount_iqd));
        }
        const amount = unit * e.units;
        if (amount > 0) perLine.push({ line_id: e.line.line_id, amount_iqd: amount });
        goodsDiscount += amount;
      }
      if (rule.cap_scope === 'per_order' && rule.max_discount_iqd !== null) {
        goodsDiscount = Math.min(goodsDiscount, dinars(rule.max_discount_iqd));
      }
    } else {
      // ONE amount off the matched goods — decision 3. Never multiplied by qty.
      goodsDiscount = dinars(rule.value);
      if (rule.max_discount_iqd !== null) goodsDiscount = Math.min(goodsDiscount, dinars(rule.max_discount_iqd));
    }
    // NEVER MORE THAN THE GOODS IT NAMED. This is the clamp that stops a
    // 950,000 coupon aimed at one printer from spilling onto the filament
    // beside it — the order total is not the ceiling, the matched goods are.
    goodsDiscount = Math.min(goodsDiscount, matchedGoods);
  }

  // Re-spread when a cap or the clamp moved the total, so the per-line figures
  // still sum to it exactly.
  const spread = spreadAcross(goodsDiscount, eligible);

  let deliveryDiscount = 0;
  if (wantsDelivery) {
    const fee = dinars(ctx.delivery_iqd);
    if (rule.kind === 'percent') {
      deliveryDiscount = Math.floor((fee * rule.value) / 100);
      if (rule.max_discount_iqd !== null && rule.cap_scope === 'per_order') {
        deliveryDiscount = Math.min(deliveryDiscount, Math.max(0, dinars(rule.max_discount_iqd) - goodsDiscount));
      }
    } else if (rule.applies_to === 'delivery') {
      deliveryDiscount = dinars(rule.value);
    } else {
      // 'both' with a fixed amount: the goods take what they can, delivery
      // takes only the remainder. One amount, spent once.
      deliveryDiscount = Math.max(0, dinars(rule.value) - goodsDiscount);
    }
    deliveryDiscount = Math.min(deliveryDiscount, fee);
  }

  return {
    lines: spread,
    merchandise_iqd: goodsDiscount,
    delivery_iqd: deliveryDiscount,
    total_iqd: goodsDiscount + deliveryDiscount,
    matched_line_ids: matched.map((l) => l.line_id),
    matched_goods_iqd: matchedGoods,
  };
}

/** Largest-remainder apportionment of `total` across the eligible lines. */
function spreadAcross(
  total: number,
  eligible: ReadonlyArray<{ line: CouponLine; units: number }>
): Array<{ line_id: string; amount_iqd: number }> {
  if (total <= 0) return [];
  const weights = eligible.map((e) => ({
    line_id: e.line.line_id,
    weight: dinars(e.line.unit_goods_iqd) * e.units,
  }));
  const basis = weights.reduce((s, w) => s + w.weight, 0);
  if (basis <= 0) return [];
  const exact = weights.map((w) => ({ ...w, raw: (total * w.weight) / basis }));
  const out = exact.map((e) => ({ line_id: e.line_id, amount_iqd: Math.floor(e.raw), rem: e.raw - Math.floor(e.raw) }));
  let left = total - out.reduce((s, o) => s + o.amount_iqd, 0);
  // Ties resolve by line id so two identical carts always allocate identically.
  out
    .slice()
    .sort((a, b) => b.rem - a.rem || (a.line_id < b.line_id ? -1 : 1))
    .forEach((o) => {
      if (left <= 0) return;
      const target = out.find((x) => x.line_id === o.line_id)!;
      target.amount_iqd += 1;
      left -= 1;
    });
  return out.filter((o) => o.amount_iqd > 0).map((o) => ({ line_id: o.line_id, amount_iqd: o.amount_iqd }));
}
