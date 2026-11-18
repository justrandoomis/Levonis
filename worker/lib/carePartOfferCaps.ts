/**
 * THE LIVE PART OFFERS OF A CUSTOMER, WITH THEIR DEVICES' CAPS TODAY (phase 5 review, 2026-11-18;
 * DECISIONS row 358). What the cart, the quote and the order hand to `allocateCareOffers`.
 *
 * An offer's own ceiling is what it reserved when it was issued. The device's Care caps are re-read HERE,
 * at every door: what is left of the money ceiling (approved benefits and used offers counted), how many
 * claims are left, and whether the offer's claim is already one of the counted ones. So whatever happened
 * since the offer was issued — an approved Care quote, another offer used, an odd row — the Care discount
 * of one order can never take a device past its terms.
 *
 * Kept apart from carePartGrants.ts so that file stays free of the entitlement reader (careClaims.ts reaches
 * membershipOps.ts, which reads `isCareCouponId` from it).
 *
 * A customer with no live offer costs one read. A database without 0243 or 0236: no offers / no caps.
 */
import { careClaimsInstalled, careEntitlements } from './careClaims';
import { liveCareOffers, type LiveCareOffer } from './carePartGrants';

export async function spendableCareOffers(db: D1Database, userId: string, nowIso = new Date().toISOString()): Promise<LiveCareOffer[]> {
  const offers = await liveCareOffers(db, userId, nowIso);
  if (!offers.length) return offers;
  const roots = [...new Set(offers.map((o) => o.entitlement_unit_id).filter((x): x is string => !!x))];
  if (!roots.length || !(await careClaimsInstalled(db))) return offers;
  const ents = await careEntitlements(db, roots, Date.parse(nowIso) || Date.now());
  return offers.map((o) => {
    const e = o.entitlement_unit_id ? ents.get(o.entitlement_unit_id) : undefined;
    // A device the reader does not know (or whose terms are unknown) is left to the offer's own ceiling.
    if (!e || !e.terms) return o;
    return {
      ...o,
      root_left_iqd: e.benefit_left_iqd,
      root_claims_left: e.claims_left,
      claim_counted: e.usage.some((u) => u.claim_id === o.claim_id),
    };
  });
}
