/**
 * THE RETURN WINDOW, BY THE TIER THE ORDER WAS BOUGHT UNDER (owner, 2026-11-19).
 *
 * «PRO can return within 14 days and pays no return delivery or restocking
 * fee; item must still be in returnable condition.» Everyone else keeps the
 * seven days of the returns policy, article 4.2.
 *
 * WHICH TIER COUNTS: the one frozen on the order at purchase,
 * `orders.membership_tier_snapshot` — written as the account's tier only while
 * its membership was active, and a paused PRO card acts as PREMIUM then
 * (worker/lib/tierPause.ts), so the snapshot says 'pro' exactly when an
 * active, unpaused PRO bought it. That makes the window a property of the
 * ORDER, known the moment it is placed and the same on every screen and every
 * day: a member who lets PRO lapse after buying keeps the 14 days they bought
 * under, and a customer who subscribes after the delivery does not stretch an
 * old order's window. It is judged from the delivery, at REQUEST time, exactly
 * like the seven days (worker/routes/returns.ts).
 *
 * Price protection keeps its own seven days (worker/routes/returns.ts): the
 * owner extended the return, not the price promise.
 *
 * Who holds the benefit is ENTITLEMENT_MINIMUM_TIER's `proFreeReturn14`, so
 * the comparison table and this rule read the same row.
 */
import { ENTITLEMENT_MINIMUM_TIER } from './entitlements';
import { TIER_RANK } from './pricing';
import { servicesSaleMonths } from './deviceOps';

export const RETURN_WINDOW_DAYS = 7;
export const PRO_RETURN_WINDOW_DAYS = 14;
export const DAY_MS = 86_400_000;

export interface ReturnTerms {
  /** Days from the recorded delivery in which a return may be requested. */
  window_days: number;
  /** No return delivery and no restocking fee is charged to the customer for this order. */
  free_return: boolean;
}

/** The return terms of an order, from the tier it was bought under. */
export function returnTermsFor(tierSnapshot: string | null | undefined): ReturnTerms {
  const tier = String(tierSnapshot ?? 'free') as keyof typeof TIER_RANK;
  const pro = (TIER_RANK[tier] ?? 0) >= TIER_RANK[ENTITLEMENT_MINIMUM_TIER.proFreeReturn14];
  return pro ? { window_days: PRO_RETURN_WINDOW_DAYS, free_return: true } : { window_days: RETURN_WINDOW_DAYS, free_return: false };
}

/** The window in milliseconds. */
export function returnWindowMs(terms: ReturnTerms): number {
  return terms.window_days * DAY_MS;
}

/**
 * «NO WARRANTY = NO FREE RETURN» (owner, 2026-11-20; DECISIONS row 365; returns policy 4.3, version 6).
 *
 * A printer sold THROUGH THE PRINTER SERVICES with warranty NONE — «Just Printer», or a custom choice without a
 * warranty — is not in the customer's return flow: the read of an order says so for that line and the request
 * door refuses it by this code. It holds for an order bought under PRO too (PRO's fourteen days need a warranty
 * on a serviced printer). The shop can still take such a printer back — a legal right, or damage on arrival —
 * through THE OWNER's exception (POST /api/returns/admin/exception: a written reason, audited).
 *
 * WHAT IT NEVER TOUCHES: a serviced printer sold WITH a warranty (same window, same reasons), the kit, add-on
 * and every other line of the same order, and any line sold without the services — a product that is not a
 * printer, or a printer sold before the services existed (no `services_snapshot`). Those answer exactly as
 * they did; `serviced: false` is how a caller knows to add nothing to its answer for them.
 *
 * The fact read is the SALE (`order_items.services_snapshot`, frozen at checkout — the same reading the device
 * window uses, `servicesSaleMonths`), never today's price list and never a later goodwill on the device.
 */
export const NO_WARRANTY_NO_FREE_RETURN = 'NO_WARRANTY_NO_FREE_RETURN' as const;

export interface LineReturnRule {
  /** The line was sold through the printer services (its frozen snapshot is readable). */
  serviced: boolean;
  /** The customer may ask for a return of this line through their own flow (the window and reasons still apply). */
  eligible: boolean;
  reason?: typeof NO_WARRANTY_NO_FREE_RETURN;
}

export function lineReturnRule(servicesSnapshot: string | null | undefined): LineReturnRule {
  const months = servicesSaleMonths(servicesSnapshot);
  if (months === null) return { serviced: false, eligible: true };
  return months === 0 ? { serviced: true, eligible: false, reason: NO_WARRANTY_NO_FREE_RETURN } : { serviced: true, eligible: true };
}

/** The refusal's sentence, as the server says it (the screens say it in the reader's language by the code). */
export const NO_WARRANTY_NO_FREE_RETURN_MESSAGE =
  'بيعت هذه الطابعة بلا ضمان، ولذلك لا يشملها الإرجاع المجاني. تواصل مع الدعم إن وصلتك تالفة. حقوقك القانونية كمستهلك تبقى قائمة. / This printer was sold without a warranty, so the free return does not cover it. Contact support if it arrived damaged. Your statutory consumer rights still apply.';
