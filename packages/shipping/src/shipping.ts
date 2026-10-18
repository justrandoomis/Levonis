/**
 * Last-mile shipping quote engine — final-phase brief §6.3. Pure function so
 * product page, cart, checkout and admin all agree; the server-side checkout
 * re-runs it and is the only authority.
 *
 * CONFIRMED owner rules (must not be re-asked):
 *  - Ordinary products: 5,000 IQD to all Iraqi governorates.
 *  - PRO free-delivery waiver requires ALL of: eligible ACTIVE PRO, the
 *    single approved default PRO address selected, and qualifying order
 *    value STRICTLY greater than 75,000 IQD (75,000 does not qualify;
 *    75,001 does). PRO only — ordinary and PLUS never get this waiver.
 *  - A PRO customer on a different address is priced as an ordinary
 *    customer for that order; returning to the approved address restores
 *    eligibility automatically.
 *  - Printers ship at 25,000 or 50,000 IQD by size class/location — the
 *    actual mapping is owner configuration; never invented, never both.
 *  - More than N filament spools MAY add a carton fee — amount/threshold
 *    are owner configuration; no fee is charged while unconfigured.
 *  - PROTECTED SHIPPING is an opt-in ADD-ON on top of the standard tariff,
 *    not a replacement for it: the parcel is boxed and handled so it survives
 *    the trip. It is charged only when the customer asks for it AND the owner
 *    has priced it; an unpriced protected option is not offered rather than
 *    guessed at. PRO gets it free alongside its standard delivery — the
 *    owner's list is "PRO: free standard + protected". PRIME's benefit is
 *    "free standard" and stops there, so a PRIME member who wants the parcel
 *    protected pays for that part, which is also what prime_waiver_covers
 *    ='ordinary_only' has always meant.
 *  - PRO'S FREE DELIVERY COVERS BOTH METHODS. Owner, stated directly:
 *    «مشترك برو يحصل على التوصيل المجاني سواء شخصي او عادي». The seeded rule's
 *    '["standard","personal"]' is therefore the owner's rule and not an
 *    invention — PREMIUM is the tier that gets standard only. What must never
 *    happen is the waiver reaching somebody who is not an active subscriber at
 *    all, which is a question about ELIGIBILITY and not about which method a
 *    benefit covers.
 *  - LEVO PRIME (product-form mandate §5) gets free delivery ONLY when the
 *    eligible merchandise total — after product discounts, coupons AND points,
 *    before delivery — is STRICTLY greater than 150,000 IQD. 150,000 itself is
 *    not free; 150,001 is. PRIME is deliberately NOT given any other PRO
 *    benefit, so by default the waiver covers the ordinary delivery fee only
 *    and never the printer or carton surcharges.
 *
 * UNRESOLVED (decision log; configurable knobs, defaults flagged in the
 * quote's `assumptions`): threshold basis, whether the PRO waiver covers
 * printer fees in mixed carts, carton-fee interaction with the waiver.
 */

import { DELIVERY_POLICY_FALLBACK, deliveryCharge, type DeliveryMode, type DeliveryName, type DeliveryPolicy } from './storeDelivery';

export interface ShippingConfig {
  ordinary_iqd: number;
  printer_small_iqd: number | null;
  printer_large_iqd: number | null;
  pro_threshold_iqd: number;
  threshold_basis: 'merchandise_after_coupon' | 'merchandise_before_coupon';
  pro_waiver_covers: 'all' | 'ordinary_only';
  /** §5, owner-stated: strictly greater than this qualifies. */
  prime_threshold_iqd: number;
  prime_waiver_covers: 'all' | 'ordinary_only';
  carton_threshold_spools: number | null;
  carton_fee_iqd: number | null;
  printer_advance_required: boolean;
  /** Opt-in protected-delivery add-on. null = not priced, so not offered. */
  protected_iqd: number | null;
}

export interface ShippingItem {
  product_id: string;
  qty: number;
  /** Authoritative printer classification from the catalogue, including bundle components. */
  is_printer?: boolean;
  /** from products.ops_policy.size_class */
  size_class: 'ordinary' | 'printer_small' | 'printer_large' | null | undefined;
  /** filament spools count toward the carton threshold */
  is_spool?: boolean;
  /**
   * The catalog sections this line is filed under, NEAREST FIRST: the
   * sub-section, its parents, then the main section and its parents (the
   * worker builds it with `ancestryFor`). Read to find the delivery policy
   * group that prices the line (storeDelivery.ts); omitted by legacy callers,
   * which then fall to the default.
   */
  category_path?: string[];
}

export type ProductDeliveryMethod = 'standard' | 'personal';

export interface ProductDeliveryRule {
  enabled: boolean;
  /** Number of units covered by one fee block. Integer >= 1. */
  quantity_step: number;
  /** Integer IQD charged for each started block. */
  fee_iqd: number;
}

export interface ProductDeliveryOptions {
  standard: ProductDeliveryRule;
  personal: ProductDeliveryRule;
}

export interface ShippingComponent {
  /** 'rule' is a delivery-policy group (storeDelivery.ts). 'product' and
   *  'category' are retired and stay only so old order snapshots still type. */
  kind: 'ordinary' | 'rule' | 'product' | 'category' | 'protected' | 'printer_small' | 'printer_large' | 'carton';
  fee_iqd: number;
  waived: boolean;
  units: number;
  advance_required: boolean;
  /** Present only for a product-owned delivery component. */
  product_id?: string;
  /** Present only for a category rule component: the section whose rule
   *  priced the pool, and the products that were counted in it. */
  catalog_id?: string;
  product_ids?: string[];
  method?: ProductDeliveryMethod;
  quantity_step?: number;
  fee_per_step_iqd?: number;
  /** Delivery-policy components: the group id ('default' for the default). */
  rule_id?: string;
  mode?: DeliveryMode;
  block_size?: number;
  /** The default component's price: the governorate's own, or the default. */
  fee_source?: 'governorate' | 'default';
  /** A delivery-policy group component: the group's name (ar / en / ckb). */
  rule_name?: DeliveryName;
}

export interface ShippingQuote {
  components: ShippingComponent[];
  total_iqd: number;            // after waivers
  total_before_waiver_iqd: number;
  advance_due_iqd: number;      // printer fees payable in advance (post-waiver)
  pro_waiver_applied: boolean;
  prime_waiver_applied: boolean;
  /**
   * What the membership actually took off the delivery bill (§13). It equals
   * the waived fees when the benefit rule sets no ceiling, and the ceiling
   * when one is set and binds — in which case no single component is free in
   * full and `membership_subsidy_capped` says so, because "free delivery" on
   * a line the customer still partly paid for is a lie an invoice cannot
   * survive.
   */
  membership_subsidy_iqd: number;
  membership_subsidy_capped: boolean;
  /** The benefit rule that produced the waiver, for the order snapshot. */
  membership_rule_id: string | null;
  /** Auditable record of which membership rule produced a free delivery and
   *  what number it was tested against (§5: "مع مصدر السعر والإعفاء من
   *  التوصيل بصورة قابلة للتدقيق"). */
  waiver_source: 'none' | 'pro' | 'prime' | 'wallet' | 'promotion';
  waiver_basis_iqd: number;     // the value compared against the threshold
  /**
   * What the wallet free-delivery rule took off («توصيل عادي مجاني — للدفع
   * الكامل من محفظة Levo», owner brief 2026-10-06 §2). 0 unless the caller
   * passed `walletFreeDelivery`. Never part of `membership_subsidy_iqd`: the
   * two are different benefits, reported apart.
   */
  wallet_waiver_iqd: number;
  needs_config: string[];       // honest blockers (e.g. printer fee mapping)
  assumptions: string[];        // defaulted unresolved rules, surfaced
  reasons: string[];            // human-readable why lines (for the UI)
  /** Standard method only: which policy priced it, frozen with the order. */
  delivery_policy?: {
    updated_at: string;
    governorate: string;
    governorate_rule: 'default' | 'price' | 'stopped';
  };
  /** Standard method only: delivery to the address's governorate is stopped. */
  delivery_unavailable?: 'governorate_stopped';
}

/** Integer-only implementation of ceil(qty / step) * fee. */
export function productDeliveryFeeIqd(quantity: number, rule: ProductDeliveryRule): number {
  const qty = Math.max(0, Math.trunc(quantity));
  if (!rule.enabled || qty === 0) return 0;
  const step = Math.max(1, Math.trunc(rule.quantity_step));
  const fee = Math.max(0, Math.trunc(rule.fee_iqd));
  return Math.ceil(qty / step) * fee;
}

/**
 * The already-resolved membership free-delivery decision.
 *
 * Declared here rather than imported so this package stays pure and
 * dependency-free, and shaped to match `ShippingBenefit` in
 * `@levonis/pricing/membershipBenefits` field for field, so the worker hands
 * one straight to the other with no translation layer to drift.
 */
export interface MembershipShippingDecision {
  rule_id: string | null;
  /** Threshold AND eligible-method test already applied. */
  eligible: boolean;
  threshold_iqd: number | null;
  basis_iqd: number;
  max_subsidy_iqd: number | null;
  reason: 'applied' | 'no_rule' | 'below_threshold' | 'method_not_covered';
}

export function quoteShipping(input: {
  items: ShippingItem[];
  /** Standard/personal checkout method. Omitted by legacy pure callers. */
  deliveryMethod?: ProductDeliveryMethod;
  /** merchandise value per the configured basis (integer IQD) */
  merchandiseIqd: number;
  tier: 'free' | 'plus' | 'pro' | 'prime';
  tierActive: boolean;
  /** Canonical server entitlement flags. Older pure callers may omit them;
   *  production checkout always supplies them from entitlements.ts. */
  proShippingEntitled?: boolean;
  premiumShippingEntitled?: boolean;
  atApprovedDefaultAddress: boolean;
  /** PRIME basis (§5): merchandise AFTER product discounts, coupons and
   *  points, BEFORE delivery. It is a distinct number from `merchandiseIqd`,
   *  whose basis is the PRO rule's configurable `threshold_basis`. Falls back
   *  to merchandiseIqd only when the caller has no separate figure. */
  primeMerchandiseIqd?: number;
  /** independent promo/referral free-delivery (kept distinct from the PRO rule) */
  independentFreeDelivery?: boolean;
  /**
   * «توصيل عادي مجاني — للدفع الكامل من محفظة Levo» (owner brief 2026-10-06
   * §2). The caller has ALREADY decided the order qualifies —
   * `walletFreeDeliveryVerdict` in worker/lib/walletFreeDelivery.ts tests the
   * admin's rules, the method, the payment and the products — so this is a
   * plain yes. It waives the TARIFF of the chosen method (the one standard
   * shipment component; a personal method's fee components when the admin
   * covers personal) and never an add-on the customer chose: protected
   * delivery stays charged. A membership waiver keeps precedence: what PRO or
   * PREMIUM already waive stays theirs, and the wallet rule takes the rest.
   * Ignored without `deliveryMethod` (legacy pure callers).
   */
  walletFreeDelivery?: boolean;
  /** The customer asked for the parcel to be protected. */
  protectedDelivery?: boolean;
  /**
   * THE ADMIN'S CONFIGURED FREE-DELIVERY RULE for this member, already
   * resolved (tier, date window, threshold, eligible methods) by
   * `resolveMembershipBenefits`.
   *
   * When supplied it REPLACES the hardcoded `pro_threshold_iqd` /
   * `prime_threshold_iqd` comparison and the "standard only" method test
   * below — that is the whole point of the benefit rules: an owner changes
   * the threshold or adds personal delivery in the admin, and the next quote
   * follows without a deploy. It does NOT replace the approved-default-address
   * condition on PRO, which is a CONFIRMED owner rule about WHERE a PRO
   * benefit exists, not about what it is worth.
   *
   * Omitted by pure callers and by every pre-0074 test, which keep the
   * historical quote exactly.
   */
  membershipShipping?: MembershipShippingDecision;
  /**
   * THE STORE'S DELIVERY POLICY («إدارة التوصيل», storeDelivery.ts). Prices
   * the standard method; omitted, the code fallback (the pre-policy tariff).
   */
  deliveryPolicy?: DeliveryPolicy;
  /** The address's governorate id (IRAQ_GOVERNORATES), '' when unknown. */
  governorate?: string;
  config: ShippingConfig;
}): ShippingQuote {
  const { config } = input;
  const needs: string[] = [];
  const assumptions: string[] = [];
  const reasons: string[] = [];
  const components: ShippingComponent[] = [];
  // Owner, 2026-10-18: standard delivery is priced by the delivery policy
  // (storeDelivery.ts). The size-class/carton tariff below is the legacy
  // no-method quote, kept for old pure callers only.
  const standardShipment = input.deliveryMethod === 'standard';

  const printers = { printer_small: 0, printer_large: 0 };
  let ordinaryUnits = 0;
  let spoolUnits = 0;
  for (const it of standardShipment ? [] : input.items) {
    const qty = Math.max(0, Math.trunc(it.qty));
    if (it.size_class === 'printer_small') printers.printer_small += qty;
    else if (it.size_class === 'printer_large') printers.printer_large += qty;
    else ordinaryUnits += qty;
    if (it.is_spool) spoolUnits += qty;
  }

  // PRO waiver eligibility — CONFIRMED: PRO only, approved default address
  // only, strictly greater than the threshold.
  const proEntitled = input.proShippingEntitled ?? (input.tier === 'pro' && input.tierActive);
  const premiumEntitled = input.premiumShippingEntitled ?? (input.tier === 'prime' && input.tierActive);
  /** An admin-configured rule, when the caller resolved one for this member. */
  const rule = input.membershipShipping ?? null;
  const ruleTier = rule ? input.tier : null;
  const proEligible = rule
    ? proEntitled && input.tier === 'pro' && input.atApprovedDefaultAddress && rule.eligible
    : proEntitled && input.atApprovedDefaultAddress && input.merchandiseIqd > config.pro_threshold_iqd;
  if (proEntitled && input.atApprovedDefaultAddress && !proEligible) {
    if (rule && rule.reason === 'method_not_covered') {
      reasons.push('PRO free delivery does not cover the delivery method you chose.');
    } else {
      const bar = rule && rule.threshold_iqd !== null ? rule.threshold_iqd : config.pro_threshold_iqd;
      reasons.push(
        rule
          ? `PRO free delivery starts at ${bar.toLocaleString()} IQD.`
          : `PRO free delivery requires order value above ${bar.toLocaleString()} IQD (strictly greater).`
      );
    }
  }
  if (proEntitled && !input.atApprovedDefaultAddress) {
    reasons.push('Alternate delivery address selected — ordinary pricing applies for this order (PRO benefits restore automatically at your approved address).');
  }

  // PRIME waiver — §5. One condition only: STRICTLY above the threshold on
  // the after-discount/coupon/points merchandise total. No approved-address
  // requirement is imposed: the owner stated that rule for PRO alone, and
  // inventing an extra condition would silently deny a paid benefit.
  const primeBasis = input.primeMerchandiseIqd ?? input.merchandiseIqd;
  const primeEligible = rule
    ? premiumEntitled && input.tier === 'prime' && rule.eligible
    : premiumEntitled && primeBasis > config.prime_threshold_iqd;
  if (premiumEntitled && !primeEligible) {
    if (rule && rule.reason === 'method_not_covered') {
      reasons.push('LEVO PREMIUM free delivery covers standard delivery only — the method you chose is charged.');
    } else {
      const bar = rule && rule.threshold_iqd !== null ? rule.threshold_iqd : config.prime_threshold_iqd;
      reasons.push(
        rule
          ? `LEVO PREMIUM free delivery starts at ${bar.toLocaleString()} IQD.`
          : `LEVO PRIME free delivery needs an order above ${bar.toLocaleString()} IQD (strictly greater; ${bar.toLocaleString()} itself does not qualify).`
      );
    }
  }

  const waiverAll =
    (proEligible && config.pro_waiver_covers === 'all') ||
    (primeEligible && config.prime_waiver_covers === 'all');
  const waiverOrdinary = proEligible || primeEligible; // ordinary component always covered when eligible
  if (proEligible && config.pro_waiver_covers === 'all') {
    assumptions.push('pro_waiver_covers=all (mixed-cart precedence pending owner confirmation)');
  }
  if (primeEligible && config.prime_waiver_covers === 'all') {
    assumptions.push('prime_waiver_covers=all (owner has not extended PRIME beyond ordinary delivery)');
  }
  const independent = input.independentFreeDelivery === true;
  /**
   * The waiver a delivery-policy fee gets. PREMIUM covers standard
   * delivery only; PRO covers a personal rule only when the owner's policy
   * says "all". A membership rule ALREADY tested the method
   * (`method_not_covered` above), so a rule-driven waiver needs no second
   * opinion about which method it covers.
   */
  const ruleFeeWaived =
    independent ||
    (rule
      ? waiverOrdinary
      : input.deliveryMethod === 'standard'
        ? waiverOrdinary
        : proEligible && config.pro_waiver_covers === 'all');

  let deliveryPolicyNote: ShippingQuote['delivery_policy'];
  let deliveryUnavailable: ShippingQuote['delivery_unavailable'];
  if (standardShipment) {
    const policy = input.deliveryPolicy ?? DELIVERY_POLICY_FALLBACK;
    const charge = deliveryCharge({
      parts: input.items.map((it) => ({
        product_id: it.product_id,
        qty: it.qty,
        category_path: it.category_path,
        is_printer: it.is_printer === true || it.size_class === 'printer_small' || it.size_class === 'printer_large',
      })),
      policy,
      governorate: input.governorate ?? '',
    });
    deliveryPolicyNote = { updated_at: policy.updated_at, governorate: charge.governorate, governorate_rule: charge.governorate_rule };
    if (charge.governorate_rule === 'stopped') {
      deliveryUnavailable = 'governorate_stopped';
      needs.push(`governorate:${charge.governorate}:stopped`);
      reasons.push('Delivery to this governorate is currently stopped.');
    }
    for (const id of charge.stopped_product_ids) {
      needs.push(`product:${id}:standard_unavailable`);
      reasons.push(`Standard delivery is unavailable for product ${id}.`);
    }
    for (const part of charge.components) {
      components.push({
        kind: part.kind,
        rule_id: part.rule_id,
        mode: part.mode,
        block_size: part.block_size,
        fee_per_step_iqd: part.fee_per_step_iqd,
        ...(part.fee_source ? { fee_source: part.fee_source } : {}),
        ...(part.rule_name ? { rule_name: part.rule_name } : {}),
        fee_iqd: part.fee_iqd,
        waived: ruleFeeWaived,
        units: part.units,
        method: 'standard',
        product_ids: part.product_ids,
        advance_required: part.contains_printer && config.printer_advance_required,
      });
    }
  }

  // Ordinary component (legacy no-method quote): one flat fee per order.
  if (ordinaryUnits > 0 && !standardShipment) {
    const waived = waiverOrdinary || independent;
    components.push({ kind: 'ordinary', fee_iqd: config.ordinary_iqd, waived, units: ordinaryUnits, advance_required: false });
    if (independent && !proEligible) reasons.push('Free delivery applied from an approved promotion/referral.');
  }

  /**
   * Protected delivery: one flat add-on per order, ON TOP of the standard
   * tariff, and only when both the customer asked and the owner priced it.
   *
   * Its waiver is deliberately NOT `waiverOrdinary`: that one covers PRIME
   * too, and the owner's membership list gives PRIME free STANDARD delivery
   * only. It is also not tied to `pro_waiver_covers`, which is the unresolved
   * question about printer and carton surcharges in mixed carts — protecting
   * a parcel is part of the delivery PRO is told is free, not a surcharge on
   * a bulky item.
   */
  if (input.protectedDelivery) {
    if (config.protected_iqd === null) {
      needs.push('protected_fee_unconfigured');
      reasons.push('Protected shipping is not priced yet — no fee was charged for it.');
    } else {
      const waived = proEligible || independent;
      components.push({
        kind: 'protected',
        fee_iqd: config.protected_iqd,
        waived,
        units: 1,
        advance_required: false,
      });
      if (proEligible) reasons.push('LEVO PRO covers protected shipping as well as the standard fee.');
      else if (primeEligible) {
        reasons.push('LEVO PRIME covers the standard delivery fee; protected shipping is charged separately.');
      }
    }
  }

  // Printer components: per-unit fee by size class; fee paid in advance.
  for (const cls of ['printer_small', 'printer_large'] as const) {
    if (standardShipment) break;
    const count = printers[cls];
    if (count === 0) continue;
    const fee = cls === 'printer_small' ? config.printer_small_iqd : config.printer_large_iqd;
    if (fee === null) {
      needs.push(`${cls}_fee_unconfigured`);
      components.push({ kind: cls, fee_iqd: 0, waived: false, units: count, advance_required: config.printer_advance_required });
      continue;
    }
    const waived = waiverAll || independent;
    components.push({ kind: cls, fee_iqd: fee * count, waived, units: count, advance_required: config.printer_advance_required });
  }

  // Carton surcharge: only when the owner configured BOTH threshold and fee.
  if (
    !standardShipment &&
    config.carton_threshold_spools !== null &&
    config.carton_fee_iqd !== null &&
    spoolUnits > config.carton_threshold_spools
  ) {
    // Whether the PRO waiver covers the carton fee is unresolved — default:
    // follows pro_waiver_covers='all'.
    const waived = waiverAll;
    if (waived) assumptions.push('carton fee waived under pro_waiver_covers=all (pending owner confirmation)');
    components.push({ kind: 'carton', fee_iqd: config.carton_fee_iqd, waived, units: spoolUnits, advance_required: false });
  }

  const before = components.reduce((n, comp) => n + comp.fee_iqd, 0);
  /**
   * §13 — THE OPTIONAL SUBSIDY CEILING.
   *
   * With no ceiling the waived components are free and the subsidy is simply
   * what they came to. With a ceiling that BINDS, the member pays the excess,
   * so no component can still claim to be free: the flags come back off and
   * the quote carries the capped figure instead. An owner who never sets
   * `max_shipping_subsidy_iqd` never reaches this branch.
   */
  /**
   * THE WALLET RULE'S SHARE. A component it can take is any part of the
   * method's tariff — never the protected add-on. When a membership ceiling
   * binds, the wallet rule takes its components IN FULL and the ceiling
   * applies to what is left (the customer qualified for free delivery; a
   * capped membership must not make them pay part of it back). Without a
   * binding ceiling the membership keeps every component it already waived.
   */
  const wallet = input.walletFreeDelivery === true && input.deliveryMethod !== undefined;
  const walletTakes = (comp: ShippingComponent) => wallet && comp.kind !== 'protected';
  const waivedSum = components.reduce((n, comp) => n + (comp.waived ? comp.fee_iqd : 0), 0);
  const ceiling = (proEligible || primeEligible) && rule ? rule.max_subsidy_iqd : null;
  const cap = ceiling === null ? null : Math.max(0, Math.trunc(ceiling));
  let subsidy = waivedSum;
  let capped = false;
  let walletWaiver = 0;
  if (cap !== null && waivedSum > cap) {
    // Without the wallet rule `walletTakes` is false everywhere, `rest` is
    // `waivedSum` and this is the historical capped quote exactly.
    const rest = components.reduce((n, comp) => n + (comp.waived && !walletTakes(comp) ? comp.fee_iqd : 0), 0);
    subsidy = Math.min(rest, cap);
    capped = rest > cap;
    for (const comp of components) {
      if (walletTakes(comp)) {
        comp.waived = true;
        walletWaiver += comp.fee_iqd;
      } else if (capped) comp.waived = false;
    }
    if (capped) reasons.push(`Your membership covers up to ${subsidy.toLocaleString()} IQD of delivery on this order.`);
  } else if (wallet) {
    for (const comp of components) {
      if (!walletTakes(comp) || comp.waived) continue;
      comp.waived = true;
      walletWaiver += comp.fee_iqd;
    }
  }
  if (walletWaiver > 0) {
    reasons.push(
      input.deliveryMethod === 'standard'
        ? 'Free standard delivery — paid in full from Levo Wallet.'
        : 'Free delivery — paid in full from Levo Wallet.'
    );
  }
  const total = before - subsidy - walletWaiver;
  const advanceRaw = components.reduce(
    (n, comp) => n + (comp.advance_required && !comp.waived ? comp.fee_iqd : 0),
    0
  );
  // A capped subsidy comes off the bill as a whole, so the advance portion can
  // never be asked for more than the bill itself.
  const advance = Math.min(advanceRaw, total);

  if (proEligible) reasons.push('LEVO PRO free delivery applied (approved address, order above threshold).');
  if (primeEligible) reasons.push('LEVO PRIME free delivery applied (order above the PRIME threshold).');

  // PRO wins when a member somehow satisfies both (§5 precedence).
  const waiverSource: ShippingQuote['waiver_source'] = proEligible
    ? 'pro'
    : primeEligible
      ? 'prime'
      : walletWaiver > 0
        ? 'wallet'
        : independent
          ? 'promotion'
          : 'none';

  return {
    components,
    total_iqd: total,
    total_before_waiver_iqd: before,
    advance_due_iqd: advance,
    pro_waiver_applied: proEligible,
    prime_waiver_applied: primeEligible,
    membership_subsidy_iqd: proEligible || primeEligible ? subsidy : 0,
    membership_subsidy_capped: capped,
    membership_rule_id: (proEligible || primeEligible) && rule ? rule.rule_id : null,
    waiver_source: waiverSource,
    wallet_waiver_iqd: walletWaiver,
    waiver_basis_iqd: rule && ruleTier !== null && (proEligible || primeEligible)
      ? rule.basis_iqd
      : proEligible
        ? input.merchandiseIqd
        : primeEligible
          ? primeBasis
          : input.merchandiseIqd,
    needs_config: needs,
    assumptions,
    reasons,
    ...(deliveryPolicyNote ? { delivery_policy: deliveryPolicyNote } : {}),
    ...(deliveryUnavailable ? { delivery_unavailable: deliveryUnavailable } : {}),
  };
}
