/**
 * Cross-module membership/referral/coupon operations. Implemented by the
 * memberships module; consumed by checkout (orders), admin order
 * transitions, and registration (referral attribution). Signatures are the
 * stable contract — keep them unchanged.
 *
 * All operations are IDEMPOTENT under retries: they key on the source
 * transaction (order id / membership id) and rely on the UNIQUE indexes
 * from migration 0002.
 */

import type { Env } from './types';

/**
 * Grants the free PLUS membership for a qualifying printer purchase
 * (mandate §8.2), when printerGiftConfig.enabled and the order contains a
 * product from a printer catalog. Safe to call multiple times per order.
 * Returns the membership id when a grant happened, else null.
 */
export async function grantPrinterGiftIfEligible(env: Env, orderId: string): Promise<string | null> {
  void env; void orderId;
  return null; // implemented by the memberships workstream
}

/**
 * Referral program 9.1 hook — call when an order transitions to DELIVERED.
 * Records delivered_at-based eligibility (delivered_at + 7 days) for a
 * pending printer-referral reward. Idempotent per (campaign, order id).
 */
export async function onOrderDelivered(env: Env, orderId: string): Promise<void> {
  void env; void orderId;
}

/**
 * Referral program 9.1/9.2 attribution — call ONCE when a new account is
 * created with a referral code. Never reassigns an existing attribution.
 */
export async function attributeReferral(env: Env, newUserId: string, code: string): Promise<boolean> {
  void env; void newUserId; void code;
  return false;
}

/**
 * Referral 9.1 — free delivery for the referred friend's qualifying printer
 * purchase. Returns true when the order qualifies (referred user with a
 * printer attribution and the order contains a printer-catalog product).
 */
export async function referralFreeDeliveryApplies(env: Env, userId: string, productIds: string[]): Promise<boolean> {
  void env; void userId; void productIds;
  return false;
}

export interface CouponCheck {
  ok: boolean;
  reason?: string;
  coupon_id?: string;
  code?: string;
  discount_iqd?: number;
}

/**
 * Validates a coupon for a user + order total. Does NOT redeem — the
 * checkout batch inserts the coupon_redemptions row (UNIQUE order_id makes
 * redemption idempotent) after this returns ok.
 */
export async function validateCoupon(env: Env, userId: string, code: string, totalIqd: number): Promise<CouponCheck> {
  void env; void userId; void code; void totalIqd;
  return { ok: false, reason: 'COUPONS_NOT_CONFIGURED' };
}

/**
 * Referral program 9.2 hook — call when a NEW paid PRO subscription is
 * recorded (purchase event, not launch activation). Idempotent per
 * (campaign, membership id).
 */
export async function onProSubscriptionPurchased(env: Env, membershipId: string, buyerUserId: string): Promise<void> {
  void env; void membershipId; void buyerUserId;
}
