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
  /** from products.ops_policy.size_class */
  size_class: 'ordinary' | 'printer_small' | 'printer_large' | null | undefined;
  /** filament spools count toward the carton threshold */
  is_spool?: boolean;
}

export interface ShippingComponent {
  kind: 'ordinary' | 'protected' | 'printer_small' | 'printer_large' | 'carton';
  fee_iqd: number;
  waived: boolean;
  units: number;
  advance_required: boolean;
}

export interface ShippingQuote {
  components: ShippingComponent[];
  total_iqd: number;            // after waivers
  total_before_waiver_iqd: number;
  advance_due_iqd: number;      // printer fees payable in advance (post-waiver)
  pro_waiver_applied: boolean;
  prime_waiver_applied: boolean;
  /** Auditable record of which membership rule produced a free delivery and
   *  what number it was tested against (§5: "مع مصدر السعر والإعفاء من
   *  التوصيل بصورة قابلة للتدقيق"). */
  waiver_source: 'none' | 'pro' | 'prime' | 'promotion';
  waiver_basis_iqd: number;     // the value compared against the threshold
  needs_config: string[];       // honest blockers (e.g. printer fee mapping)
  assumptions: string[];        // defaulted unresolved rules, surfaced
  reasons: string[];            // human-readable why lines (for the UI)
}

export function quoteShipping(input: {
  items: ShippingItem[];
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
  /** The customer asked for the parcel to be protected. */
  protectedDelivery?: boolean;
  config: ShippingConfig;
}): ShippingQuote {
  const { config } = input;
  const needs: string[] = [];
  const assumptions: string[] = [];
  const reasons: string[] = [];
  const components: ShippingComponent[] = [];

  const printers = { printer_small: 0, printer_large: 0 };
  let ordinaryUnits = 0;
  let spoolUnits = 0;
  for (const it of input.items) {
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
  const proEligible =
    proEntitled &&
    input.atApprovedDefaultAddress &&
    input.merchandiseIqd > config.pro_threshold_iqd;
  if (proEntitled && input.atApprovedDefaultAddress && !proEligible) {
    reasons.push(`PRO free delivery requires order value above ${config.pro_threshold_iqd.toLocaleString()} IQD (strictly greater).`);
  }
  if (proEntitled && !input.atApprovedDefaultAddress) {
    reasons.push('Alternate delivery address selected — ordinary pricing applies for this order (PRO benefits restore automatically at your approved address).');
  }

  // PRIME waiver — §5. One condition only: STRICTLY above the threshold on
  // the after-discount/coupon/points merchandise total. No approved-address
  // requirement is imposed: the owner stated that rule for PRO alone, and
  // inventing an extra condition would silently deny a paid benefit.
  const primeBasis = input.primeMerchandiseIqd ?? input.merchandiseIqd;
  const primeEligible = premiumEntitled && primeBasis > config.prime_threshold_iqd;
  if (premiumEntitled && !primeEligible) {
    reasons.push(
      `LEVO PRIME free delivery needs an order above ${config.prime_threshold_iqd.toLocaleString()} IQD (strictly greater; ${config.prime_threshold_iqd.toLocaleString()} itself does not qualify).`
    );
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

  // Ordinary component: one flat fee per order when any ordinary unit ships.
  if (ordinaryUnits > 0) {
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
  const total = components.reduce((n, comp) => n + (comp.waived ? 0 : comp.fee_iqd), 0);
  const advance = components.reduce(
    (n, comp) => n + (comp.advance_required && !comp.waived ? comp.fee_iqd : 0),
    0
  );

  if (proEligible) reasons.push('LEVO PRO free delivery applied (approved address, order above threshold).');
  if (primeEligible) reasons.push('LEVO PRIME free delivery applied (order above the PRIME threshold).');

  // PRO wins when a member somehow satisfies both (§5 precedence).
  const waiverSource: ShippingQuote['waiver_source'] = proEligible
    ? 'pro'
    : primeEligible
      ? 'prime'
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
    waiver_source: waiverSource,
    waiver_basis_iqd: proEligible ? input.merchandiseIqd : primeEligible ? primeBasis : input.merchandiseIqd,
    needs_config: needs,
    assumptions,
    reasons,
  };
}
