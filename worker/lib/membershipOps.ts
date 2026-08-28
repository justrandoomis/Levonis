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
import { getSetting } from './settings';
import { getLaunchConfig, getTierStatus } from './entitlements';
import { newId } from './crypto';

/**
 * Calendar-month addition with month-end clamping: the day-of-month is
 * preserved, but when the target month is shorter it clamps to that month's
 * last day (e.g. Jan 31 + 1 month = Feb 28/29, Aug 31 + 1 month = Sep 30).
 * Time-of-day is preserved. All arithmetic is UTC.
 */
export function addMonths(fromIso: string, months: number): string {
  const d = new Date(fromIso);
  const day = d.getUTCDate();
  const t = new Date(d.getTime());
  t.setUTCDate(1); // avoid overflow while shifting months
  t.setUTCMonth(t.getUTCMonth() + months);
  const daysInTarget = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, daysInTarget));
  return t.toISOString();
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('UNIQUE') || msg.includes('PRIMARY KEY');
}

/** True when any of the order's items belongs to a printer catalog. */
async function orderHasPrinterProduct(db: D1Database, orderId: string): Promise<boolean> {
  const hit = await db
    .prepare(
      `SELECT 1 AS x
         FROM order_items oi
         JOIN product_catalogs pc ON pc.product_id = oi.product_id
         JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
        WHERE oi.order_id = ?
        LIMIT 1`
    )
    .bind(orderId)
    .first();
  return !!hit;
}

/**
 * Grants the free PLUS membership for a qualifying printer purchase
 * (mandate §8.2), when printerGiftConfig.enabled and the order contains a
 * product from a printer catalog. Safe to call multiple times per order.
 * Returns the membership id when a grant happened, else null.
 */
export async function grantPrinterGiftIfEligible(env: Env, orderId: string): Promise<string | null> {
  const cfg = await getSetting(env.DB, 'printerGiftConfig');
  if (!cfg.enabled) return null; // honestly disabled until the owner turns it on

  const order = await env.DB.prepare('SELECT id, user_id FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: string; user_id: string }>();
  if (!order) return null;

  if (!(await orderHasPrinterProduct(env.DB, orderId))) return null;

  const plan = await env.DB.prepare('SELECT id, tier, duration_months FROM membership_plans WHERE id = ?')
    .bind(cfg.plan_id)
    .first<{ id: string; tier: 'plus' | 'pro'; duration_months: number }>();
  if (!plan) {
    console.error('printerGiftConfig.plan_id points at a missing plan', cfg.plan_id);
    return null; // misconfigured — no fabricated grant
  }

  const launch = await getLaunchConfig(env.DB);
  const nowIso = new Date().toISOString();
  const id = `gift_${orderId}`;
  try {
    await env.DB.prepare(
      `INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months,
         price_paid_iqd, starts_at, expires_at, source, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'gift_printer', ?)`
    )
      .bind(
        id,
        order.user_id,
        plan.id,
        plan.tier,
        launch.activated ? 'active' : 'prepaid_pending_launch',
        plan.duration_months,
        launch.activated ? nowIso : null,
        launch.activated ? addMonths(nowIso, plan.duration_months) : null,
        orderId
      )
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) return null; // already granted for this order
    throw e;
  }
  // Sync the legacy users.* tier cache.
  await getTierStatus(env.DB, order.user_id);
  return id;
}

/**
 * Referral program 9.1 hook — call when an order transitions to DELIVERED.
 * Records delivered_at-based eligibility (delivered_at + 7 days) for a
 * pending printer-referral reward. Idempotent per (campaign, order id).
 */
export async function onOrderDelivered(env: Env, orderId: string): Promise<void> {
  const order = await env.DB.prepare('SELECT id, user_id, delivered_at FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: string; user_id: string; delivered_at: string | null }>();
  if (!order) return;

  const attribution = await env.DB.prepare(
    "SELECT referrer_id FROM referral_attributions WHERE referred_id = ? AND campaign = 'printer'"
  )
    .bind(order.user_id)
    .first<{ referrer_id: string }>();
  if (!attribution) return;

  if (!(await orderHasPrinterProduct(env.DB, orderId))) return;

  const deliveredMs = order.delivered_at ? Date.parse(order.delivered_at) : NaN;
  const baseMs = Number.isFinite(deliveredMs) ? deliveredMs : Date.now();
  const eligibleAt = new Date(baseMs + 7 * 86_400_000).toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO referral_rewards (id, campaign, referrer_id, referred_id, source_ref, state, eligible_at)
       VALUES (?, 'printer', ?, ?, ?, 'pending', ?)`
    )
      .bind(newId('rrw'), attribution.referrer_id, order.user_id, orderId, eligibleAt)
      .run();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e; // UNIQUE(campaign, source_ref) = already recorded
  }
}

/**
 * Referral program 9.1/9.2 attribution — call ONCE when a new account is
 * created with a referral code. Never reassigns an existing attribution.
 */
export async function attributeReferral(env: Env, newUserId: string, code: string): Promise<boolean> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return false;
  const row = await env.DB.prepare('SELECT user_id FROM referral_codes WHERE code = ?')
    .bind(normalized)
    .first<{ user_id: string }>();
  if (!row) return false;
  if (row.user_id === newUserId) return false; // self-referral

  let inserted = false;
  for (const campaign of ['printer', 'pro_sub'] as const) {
    try {
      await env.DB.prepare(
        'INSERT INTO referral_attributions (id, referrer_id, referred_id, campaign) VALUES (?, ?, ?, ?)'
      )
        .bind(newId('rat'), row.user_id, newUserId, campaign)
        .run();
      inserted = true;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // UNIQUE(referred_id, campaign) = already attributed
    }
  }
  return inserted;
}

/**
 * Referral 9.1 — free delivery for the referred friend's qualifying printer
 * purchase. Returns true when the order qualifies (referred user with a
 * printer attribution and the order contains a printer-catalog product).
 * One qualifying purchase per friend: once a printer referral reward exists
 * for this referred user, later orders no longer qualify.
 */
export async function referralFreeDeliveryApplies(env: Env, userId: string, productIds: string[]): Promise<boolean> {
  const ids = productIds.filter((p) => typeof p === 'string' && p !== '').slice(0, 200);
  if (ids.length === 0) return false;

  const attribution = await env.DB.prepare(
    "SELECT referrer_id FROM referral_attributions WHERE referred_id = ? AND campaign = 'printer'"
  )
    .bind(userId)
    .first();
  if (!attribution) return false;

  const alreadyUsed = await env.DB.prepare(
    "SELECT 1 AS x FROM referral_rewards WHERE campaign = 'printer' AND referred_id = ? LIMIT 1"
  )
    .bind(userId)
    .first();
  if (alreadyUsed) return false;

  const placeholders = ids.map(() => '?').join(',');
  const hit = await env.DB.prepare(
    `SELECT 1 AS x
       FROM product_catalogs pc
       JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
      WHERE pc.product_id IN (${placeholders})
      LIMIT 1`
  )
    .bind(...ids)
    .first();
  return !!hit;
}

export interface CouponCheck {
  ok: boolean;
  reason?: string;
  coupon_id?: string;
  code?: string;
  discount_iqd?: number;
}

interface CouponRow {
  id: string;
  code: string;
  tier_required: 'plus' | 'pro' | null;
  kind: 'fixed_iqd' | 'percent';
  value: number;
  min_total_iqd: number;
  starts_at: string | null;
  ends_at: string | null;
  max_global: number | null;
  max_per_user: number;
  active: number;
}

/**
 * Validates a coupon for a user + order total. Does NOT redeem — the
 * checkout batch inserts the coupon_redemptions row (UNIQUE order_id makes
 * redemption idempotent) after this returns ok.
 */
export async function validateCoupon(env: Env, userId: string, code: string, totalIqd: number): Promise<CouponCheck> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { ok: false, reason: 'CODE_REQUIRED' };
  if (!Number.isInteger(totalIqd) || totalIqd < 0) return { ok: false, reason: 'INVALID_TOTAL' };

  const coupon = await env.DB.prepare('SELECT * FROM coupons WHERE code = ?')
    .bind(normalized)
    .first<CouponRow>();
  if (!coupon) return { ok: false, reason: 'CODE_NOT_FOUND' };
  if (!coupon.active) return { ok: false, reason: 'INACTIVE' };

  const nowMs = Date.now();
  if (coupon.starts_at && nowMs < Date.parse(coupon.starts_at)) return { ok: false, reason: 'NOT_STARTED' };
  if (coupon.ends_at && nowMs > Date.parse(coupon.ends_at)) return { ok: false, reason: 'EXPIRED' };
  if (totalIqd < coupon.min_total_iqd) return { ok: false, reason: 'MIN_TOTAL_NOT_MET' };

  if (coupon.tier_required) {
    // Server-side tier check — never a client-supplied flag. PRO satisfies
    // a PLUS requirement (PRO is the superset tier).
    const status = await getTierStatus(env.DB, userId);
    const tierOk =
      status.active &&
      (coupon.tier_required === 'plus'
        ? status.tier === 'plus' || status.tier === 'pro'
        : status.tier === 'pro');
    if (!tierOk) return { ok: false, reason: 'TIER_REQUIRED' };
  }

  if (coupon.max_global !== null) {
    const g = await env.DB.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?')
      .bind(coupon.id)
      .first<{ n: number }>();
    if ((g?.n ?? 0) >= coupon.max_global) return { ok: false, reason: 'GLOBAL_LIMIT_REACHED' };
  }
  const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?')
    .bind(coupon.id, userId)
    .first<{ n: number }>();
  if ((u?.n ?? 0) >= coupon.max_per_user) return { ok: false, reason: 'PER_USER_LIMIT_REACHED' };

  let discount =
    coupon.kind === 'fixed_iqd' ? coupon.value : Math.floor((totalIqd * coupon.value) / 100);
  discount = Math.min(discount, totalIqd); // a coupon never pushes the total below zero
  if (discount <= 0) return { ok: false, reason: 'NO_DISCOUNT' };

  return { ok: true, coupon_id: coupon.id, code: coupon.code, discount_iqd: discount };
}

/**
 * Referral program 9.2 hook — call when a NEW paid PRO subscription is
 * recorded (purchase event, not launch activation). Idempotent per
 * (campaign, membership id). The reward starts 'qualified' because it is
 * tied to the payment itself; cancelling the membership cancels it.
 */
export async function onProSubscriptionPurchased(env: Env, membershipId: string, buyerUserId: string): Promise<void> {
  const attribution = await env.DB.prepare(
    "SELECT referrer_id FROM referral_attributions WHERE referred_id = ? AND campaign = 'pro_sub'"
  )
    .bind(buyerUserId)
    .first<{ referrer_id: string }>();
  if (!attribution) return;

  try {
    await env.DB.prepare(
      `INSERT INTO referral_rewards (id, campaign, referrer_id, referred_id, source_ref, state)
       VALUES (?, 'pro_sub', ?, ?, ?, 'qualified')`
    )
      .bind(newId('rrw'), attribution.referrer_id, buyerUserId, membershipId)
      .run();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e; // UNIQUE(campaign, source_ref) = already recorded
  }
}
