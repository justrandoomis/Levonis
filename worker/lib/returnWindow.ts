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
