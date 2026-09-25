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
import { printerProductIds } from './printerIdentity';
import { getSetting } from './settings';
import { benefits, getLaunchConfig, getTierStatus, tierInherits } from './entitlements';
import { newId } from './crypto';
import { audit } from './audit';
import { parseSupportSnapshot, type SupportSnapshot } from './supportCode';
import { levonisCollectibleSql } from './gini';

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
  // "Is this a printer" is answered in one place (worker/lib/printerIdentity.ts)
  // so the gift, the reviews reward, the home-delivery note and the extended
  // warranty can never disagree about which products are printers.
  const { results } = await db
    .prepare('SELECT DISTINCT product_id FROM order_items WHERE order_id = ?')
    .bind(orderId)
    .all<{ product_id: string }>();
  const printers = await printerProductIds(db, results.map((r) => r.product_id));
  return printers.size > 0;
}

/**
 * Grants the free PLUS membership for a qualifying printer purchase
 * (mandate §8.2), when printerGiftConfig.enabled and the order contains a
 * product from a printer catalog. Safe to call multiple times per order.
 * Returns the membership id when a grant happened, else null.
 *
 * ONE MEMBERSHIP AT A TIME (migration 0052): an account that already holds a
 * live membership — active or reserved for the launch — cannot receive a
 * second live row, so the gift is NOT written for it; the skip is audited
 * (`membership.gift_skipped`) so an admin can see it and comp the account by
 * hand if that is wanted. A gift's `credit_basis_iqd` is 0: it is worth
 * nothing toward a later paid upgrade.
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
    .first<{ id: string; tier: 'plus' | 'pro' | 'prime'; duration_months: number }>();
  if (!plan) {
    console.error('printerGiftConfig.plan_id points at a missing plan', cfg.plan_id);
    return null; // misconfigured — no fabricated grant
  }

  const launch = await getLaunchConfig(env.DB);
  const nowIso = new Date().toISOString();
  const id = `gift_${orderId}`;
  const skipped = async (live: { id: string; tier: string; state: string } | null) => {
    await audit(env.DB, null, 'membership.gift_skipped', orderId, {
      user_id: order.user_id,
      plan_id: plan.id,
      reason: 'account already holds a live membership',
      live,
    });
    return null;
  };
  // Already granted for this order → a quiet no-op, exactly as before. This
  // comes BEFORE the live-row check: the live row a replay would find is the
  // gift itself, and that is not a skip worth an audit entry.
  const granted = await env.DB.prepare('SELECT id FROM memberships WHERE id = ?').bind(id).first();
  if (granted) return null;
  const live = await env.DB
    .prepare("SELECT id, tier, state FROM memberships WHERE user_id = ? AND state IN ('active','prepaid_pending_launch') LIMIT 1")
    .bind(order.user_id)
    .first<{ id: string; tier: string; state: string }>();
  if (live) return skipped(live);
  try {
    // The state is decided inside the statement: a live row that appeared
    // since the SELECT above turns it into 'conflict', which the CHECK refuses
    // — the same guard the purchase path uses (routes/memberships.ts).
    await env.DB.prepare(
      `INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months,
         price_paid_iqd, credit_basis_iqd, credit_applied_iqd, starts_at, expires_at, source, source_ref)
       SELECT ?1, ?2, ?3, ?4,
         CASE WHEN EXISTS (SELECT 1 FROM memberships l WHERE l.user_id = ?2 AND l.state IN ('active','prepaid_pending_launch'))
              THEN 'conflict' ELSE ?5 END,
         ?6, 0, 0, 0, ?7, ?8, 'gift_printer', ?9`
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
    const msg = e instanceof Error ? e.message : String(e);
    if ((msg.includes('UNIQUE') && msg.includes('memberships.user_id')) || (msg.includes('CHECK') && msg.includes('state IN'))) {
      const now = await env.DB
        .prepare("SELECT id, tier, state FROM memberships WHERE user_id = ? AND state IN ('active','prepaid_pending_launch') LIMIT 1")
        .bind(order.user_id)
        .first<{ id: string; tier: string; state: string }>();
      return skipped(now);
    }
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
 *
 * SEPARATION OF THE TWO PROGRAMS (mandate §3.4): this legacy campaign keys
 * on the SIGNUP attribution (referral_attributions) and keeps its own
 * seven-day eligibility clock, exactly as before. The support-code gift
 * added below keys on the ORDER's support snapshot instead, has no PRO
 * requirement and no seven-day wait, and is evaluated first so a failure in
 * either program can never swallow the other. The double-payout guard for
 * the shared business event lives in evaluateSupportGiftForOrder.
 */
export async function onOrderDelivered(env: Env, orderId: string): Promise<void> {
  try {
    await evaluateSupportGiftForOrder(env, orderId, { trigger: 'order_delivered' });
  } catch (e) {
    // The legacy milestone below must still be recorded — a support-gift
    // failure is logged, never allowed to drop the other program's row.
    console.error('support gift evaluation failed for order', orderId, e instanceof Error ? e.message : String(e));
  }

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
 * REFERRAL 9.1'S DELIVERY WAIVER IS WITHDRAWN, and this note is what stands
 * where `referralFreeDeliveryApplies` used to.
 *
 * It answered one question — "may this order ship for nothing?" — with a YES
 * that asked for no subscription, no tier and no membership rule, and then
 * `quoteShipping` waived EVERY delivery component it had, including a
 * personal tariff the owner prices at 50,000 د.ع. The owner's report was
 * «يظهر لبعض المستخدمين التوصيل مجاني», and their own diagnosis was the rest
 * of it: «المستخدم لم يكن مشتركا بالاشتراك البرو وقد حصل على خصم». The
 * decision on it was «ألغِ المكافأة تماماً».
 *
 * Deleted rather than disabled behind a flag: a switch that nobody can see is
 * how this shipped in the first place. The three things it read still exist
 * and still mean what they meant —
 *   `referral_attributions`   who referred whom, and for which campaign,
 *   `referral_rewards`        the REFERRER's reward, a different payment to a
 *                             different person, untouched by this,
 *   `orders.referral_delivery_waived`  the record on orders that already had
 *                             the waiver, which stays readable so a past
 *                             invoice still explains itself.
 * Nothing writes a 1 into that column any more.
 */

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
  tier_required: 'plus' | 'pro' | 'prime' | null;
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
    // Server-side tier check — never a client-supplied flag.
    //
    // A LADDER, not an equality test: a higher tier satisfies every
    // requirement below it. The ladder is pricing.TIER_RANK (pro > prime >
    // plus) — the SAME order the price resolver and getTierStatus use — so a
    // PRO member can use a PRIME-required coupon and a PRIME member a
    // PLUS-required one. (This used to carry its own private ranking with
    // prime above pro, which refused PRO members the PRIME coupons.)
    //
    // And it goes through benefits.exclusiveCoupons first, so an admin's
    // restriction case gating 'exclusiveCoupons' actually pauses the coupons
    // instead of being a flag nothing reads.
    const status = await getTierStatus(env.DB, userId);
    const tierOk =
      benefits.exclusiveCoupons(status) &&
      (coupon.tier_required === 'plus' || coupon.tier_required === 'prime' || coupon.tier_required === 'pro') &&
      tierInherits(status.tier, coupon.tier_required);
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

// ===========================================================================
// SUPPORT-CODE GIFT ENGINE (integrated mandate §3.3 / §3.4)
// ===========================================================================
//
// The required path, stated in the mandate and implemented literally here:
//   an eligible PRINTER product is bought using a support code / share link
//   → the order is DELIVERED → its payment is SETTLED
//   → the REFERRER earns one filament-gift entitlement.
//
// What this engine deliberately does NOT require (§3.4 forbids importing
// them from the old program): no PRO membership for the referrer, no "the
// buyer must be a new account", and no seven-day wait. The seven-day clock
// belongs to POINTS (points_accruals.available_at, migration 0014) and is a
// different mechanism for a different purpose; conflating the two is exactly
// the mistake the mandate calls out. Any additional commercial hold-back has
// to be an announced, approved setting — never a silent default added here.
//
// Everything below is idempotent under replays (UNIQUE(order_id) from
// migration 0016) and never uses check-then-write: each state change is one
// conditional UPDATE whose WHERE clause carries the precondition, and a
// statement that touches zero rows is reported, not assumed to have worked.

export const SUPPORT_GIFT_STATES = ['pending_eligibility', 'due', 'reserved', 'paid', 'cancelled'] as const;
export type SupportGiftState = (typeof SUPPORT_GIFT_STATES)[number];

/** Forward-only chain; any live state may be cancelled. Pure — unit-tested. */
const SUPPORT_GIFT_CHAIN: SupportGiftState[] = ['pending_eligibility', 'due', 'reserved', 'paid'];

export function supportGiftTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return false;
  if (from === 'paid') return false; // a handed-over gift is history, not a draft
  if (to === 'cancelled') return from !== 'cancelled';
  if (from === 'cancelled') return false; // reopening is a new business decision, not an edit
  const i = SUPPORT_GIFT_CHAIN.indexOf(from as SupportGiftState);
  const j = SUPPORT_GIFT_CHAIN.indexOf(to as SupportGiftState);
  return i >= 0 && j === i + 1; // strictly one step forward
}

/** Facts a qualification decision is made from — no I/O, so it is testable. */
export interface SupportGiftFacts {
  hasSnapshot: boolean;
  selfSupport: boolean;
  hasEligibleLine: boolean;
  orderCancelled: boolean;
  delivered: boolean;
  collectedIqd: number;
  totalIqd: number;
}

export type SupportGiftBlocker =
  | 'no_support_snapshot'
  | 'self_support'
  | 'no_eligible_line'
  | 'order_cancelled'
  | 'not_delivered'
  | 'payment_not_settled';

export interface SupportGiftDecision {
  /** An attribution worth recording exists (even if it cannot pay out yet). */
  attributable: boolean;
  /** Delivered AND settled AND eligible: the claim is due. */
  qualifies: boolean;
  blocker: SupportGiftBlocker | null;
}

/**
 * The whole §3.4 rule in one pure function.
 *
 * "Delivery is not collection" (§11.5): a delivered COD order whose cash was
 * never handed over does NOT qualify, and collecting it later qualifies it
 * then — without restarting any clock. Partial payment stays pending: the
 * comparison is against the order total, never against "something arrived".
 */
export function decideSupportGift(f: SupportGiftFacts): SupportGiftDecision {
  if (!f.hasSnapshot) return { attributable: false, qualifies: false, blocker: 'no_support_snapshot' };
  if (f.selfSupport) return { attributable: false, qualifies: false, blocker: 'self_support' };
  if (!f.hasEligibleLine) return { attributable: false, qualifies: false, blocker: 'no_eligible_line' };
  if (f.orderCancelled) return { attributable: false, qualifies: false, blocker: 'order_cancelled' };
  if (!f.delivered) return { attributable: true, qualifies: false, blocker: 'not_delivered' };
  if (f.totalIqd > 0 && f.collectedIqd < f.totalIqd) {
    return { attributable: true, qualifies: false, blocker: 'payment_not_settled' };
  }
  return { attributable: true, qualifies: true, blocker: null };
}

/**
 * True when the order contains at least one line flagged eligible for the
 * support gift, resolved from EXPLICIT admin fields only (§3.4):
 *   products.support_gift_eligible  (1 = eligible, 0 = excluded, NULL = inherit)
 *   catalogs.is_printer_catalog     (the inherited catalog flag)
 * There is no name matching anywhere, and an accessory sitting in a printer
 * catalog can be excluded per product without touching the catalog.
 */
export async function orderHasSupportEligibleLine(db: D1Database, orderId: string): Promise<boolean> {
  const hit = await db
    .prepare(
      `SELECT 1 AS x
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?1
          AND COALESCE(
                p.support_gift_eligible,
                CASE WHEN EXISTS (SELECT 1
                                    FROM product_catalogs pc
                                    JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                                   WHERE pc.product_id = p.id)
                     THEN 1 ELSE 0 END) = 1
        LIMIT 1`
    )
    .bind(orderId)
    .first();
  return !!hit;
}

/** Product ids (from the given set) that carry the eligibility flag. */
export async function supportEligibleProductIds(db: D1Database, productIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(productIds.filter((p) => typeof p === 'string' && p !== ''))].slice(0, 200);
  if (ids.length === 0) return new Set();
  // One bound parameter for the list (json_each): the live D1 refuses > 100 (review F1).
  const { results } = await db
    .prepare(
      `SELECT p.id AS id
         FROM products p
        WHERE p.id IN (SELECT value FROM json_each(?))
          AND COALESCE(
                p.support_gift_eligible,
                CASE WHEN EXISTS (SELECT 1
                                    FROM product_catalogs pc
                                    JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                                   WHERE pc.product_id = p.id)
                     THEN 1 ELSE 0 END) = 1`
    )
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

interface SupportOrderRow {
  id: string;
  user_id: string;
  status: string;
  total_iqd: number;
  /** Settled inside the Gini app (migration 0103) — never ours to collect. */
  gini_paid_iqd: number | null;
  delivered_at: string | null;
  support_snapshot: string | null;
}

/**
 * Guards that must NOT silently deny a referrer and must NOT silently pay
 * twice — they park the claim in review instead (§3.4 "suspicion signals go
 * to review", §13 item 2 "no hidden new conditions"):
 *
 *  - legacy_printer_reward: the OLD printer campaign already recorded a
 *    reward keyed on this very order (referral_rewards.source_ref). Same
 *    business event, two programs → a human approves or cancels one.
 *  - return_open: a return case exists on an eligible line of this order and
 *    is not rejected, so the printer may be going back.
 */
async function supportGiftGuard(db: D1Database, orderId: string): Promise<{ needsReview: boolean; reason: string }> {
  const legacy = await db
    .prepare(
      `SELECT id FROM referral_rewards
        WHERE source_ref = ?1 AND campaign = 'printer' AND state <> 'cancelled' LIMIT 1`
    )
    .bind(orderId)
    .first<{ id: string }>();
  if (legacy) return { needsReview: true, reason: `legacy_printer_reward:${legacy.id}` };

  const openReturn = await db
    .prepare(
      `SELECT rc.id AS id
         FROM return_cases rc
         JOIN order_items oi ON oi.id = rc.order_item_id
         JOIN products p ON p.id = oi.product_id
        WHERE rc.order_id = ?1
          AND rc.state <> 'rejected'
          AND COALESCE(
                p.support_gift_eligible,
                CASE WHEN EXISTS (SELECT 1
                                    FROM product_catalogs pc
                                    JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                                   WHERE pc.product_id = p.id)
                     THEN 1 ELSE 0 END) = 1
        LIMIT 1`
    )
    .bind(orderId)
    .first<{ id: string }>();
  if (openReturn) return { needsReview: true, reason: `return_case_open:${openReturn.id}` };

  return { needsReview: false, reason: '' };
}

export interface SupportGiftEvaluation {
  order_id: string;
  /** A row exists for this order after the call (created now or before). */
  entitlement: boolean;
  created: boolean;
  /** The pending → due transition happened in THIS call. */
  became_due: boolean;
  state: SupportGiftState | null;
  needs_review: boolean;
  review_reason: string;
  blocker: SupportGiftBlocker | null;
  reason: string;
}

/**
 * Evaluate (and, when warranted, create or advance) the support-gift
 * entitlement for one order. Safe to call from any trigger — the delivered
 * transition, a settlement recording, an admin re-check, a cron sweep — and
 * safe to call repeatedly: UNIQUE(order_id) makes a second create a no-op
 * and the advance is a conditional UPDATE.
 */
export async function evaluateSupportGiftForOrder(
  env: Env,
  orderId: string,
  opts: { trigger?: string; actorId?: string | null } = {}
): Promise<SupportGiftEvaluation> {
  const db = env.DB;
  const trigger = opts.trigger || 'manual';
  const base: SupportGiftEvaluation = {
    order_id: orderId,
    entitlement: false,
    created: false,
    became_due: false,
    state: null,
    needs_review: false,
    review_reason: '',
    blocker: null,
    reason: '',
  };

  const order = await db
    .prepare('SELECT id, user_id, status, total_iqd, gini_paid_iqd, delivered_at, support_snapshot FROM orders WHERE id = ?')
    .bind(orderId)
    .first<SupportOrderRow>();
  if (!order) return { ...base, reason: 'order_not_found' };

  const existing = await db
    .prepare('SELECT id, state, needs_review FROM support_gift_entitlements WHERE order_id = ?')
    .bind(orderId)
    .first<{ id: string; state: SupportGiftState; needs_review: number }>();

  const snapshot: SupportSnapshot | null = parseSupportSnapshot(order.support_snapshot);
  const selfSupport = !!snapshot && snapshot.referrer_user_id === order.user_id;

  const [eligibleLine, collectedRow] = await Promise.all([
    orderHasSupportEligibleLine(db, orderId),
    db
      .prepare('SELECT COALESCE(SUM(amount_iqd), 0) AS collected FROM order_payment_settlements WHERE order_id = ?')
      .bind(orderId)
      .first<{ collected: number }>(),
  ]);

  const decision = decideSupportGift({
    hasSnapshot: !!snapshot,
    selfSupport,
    hasEligibleLine: eligibleLine,
    orderCancelled: order.status === 'cancelled',
    delivered: order.status === 'delivered' && !!order.delivered_at,
    collectedIqd: Number(collectedRow?.collected) || 0,
    // What LEVONIS had to collect, which is the whole total on every method
    // but one: a Gini order's goods were paid for inside the bank's app and
    // never pass through `order_payment_settlements`, so the plain total
    // would park every referrer's gift in 'payment_not_settled' for ever.
    totalIqd: Math.max(0, (Number(order.total_iqd) || 0) - (Number(order.gini_paid_iqd) || 0)),
  });

  // A claim that can no longer stand is cancelled rather than left dangling
  // (§3.4: cancel an unfulfilled entitlement on return/cancellation).
  if (!decision.attributable) {
    if (existing) {
      const cancelled = await cancelSupportGiftsForOrder(env, orderId, decision.blocker || 'not_attributable', opts.actorId ?? null);
      return {
        ...base,
        entitlement: true,
        state: cancelled > 0 ? 'cancelled' : existing.state,
        blocker: decision.blocker,
        reason: cancelled > 0 ? 'cancelled' : 'unchanged',
      };
    }
    return { ...base, blocker: decision.blocker, reason: decision.blocker || 'not_attributable' };
  }

  // snapshot is non-null here (attributable implies it).
  const snap = snapshot as SupportSnapshot;
  const referrer = await db
    .prepare('SELECT id FROM users WHERE id = ?')
    .bind(snap.referrer_user_id)
    .first<{ id: string }>();
  if (!referrer) return { ...base, reason: 'referrer_not_found' };

  const guard = await supportGiftGuard(db, orderId);
  const nowIso = new Date().toISOString();

  if (!existing) {
    const startDue = decision.qualifies && !guard.needsReview;
    const id = newId('sge');
    try {
      await db
        .prepare(
          `INSERT INTO support_gift_entitlements
             (id, order_id, referrer_id, buyer_id, support_ref, state, needs_review, review_reason,
              delivered_at, settled_at, qualified_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          orderId,
          snap.referrer_user_id,
          order.user_id,
          snap.ref || snap.referrer_username || '',
          startDue ? 'due' : 'pending_eligibility',
          guard.needsReview ? 1 : 0,
          guard.reason,
          order.delivered_at,
          decision.qualifies ? nowIso : null,
          startDue ? nowIso : null,
          nowIso,
          nowIso
        )
        .run();
      await audit(db, opts.actorId ?? null, 'support_gift.create', id, {
        order_id: orderId,
        referrer_id: snap.referrer_user_id,
        state: startDue ? 'due' : 'pending_eligibility',
        needs_review: guard.needsReview,
        review_reason: guard.reason,
        blocker: decision.blocker,
        trigger,
      });
      return {
        ...base,
        entitlement: true,
        created: true,
        became_due: startDue,
        state: startDue ? 'due' : 'pending_eligibility',
        needs_review: guard.needsReview,
        review_reason: guard.reason,
        blocker: decision.blocker,
        reason: 'created',
      };
    } catch (e) {
      // UNIQUE(order_id): a concurrent trigger created it first — fall
      // through to the advance path instead of writing a second claim.
      if (!isUniqueViolation(e)) throw e;
    }
  }

  // A guard that fired after the row was created must be recorded on it, so
  // the claim stops auto-advancing and shows up in the admin review queue.
  if (guard.needsReview) {
    const flagged = await db
      .prepare(
        `UPDATE support_gift_entitlements
            SET needs_review = 1, review_reason = ?2, updated_at = ?3
          WHERE order_id = ?1 AND needs_review = 0 AND state IN ('pending_eligibility','due')`
      )
      .bind(orderId, guard.reason, nowIso)
      .run();
    if ((flagged.meta.changes || 0) > 0) {
      await audit(db, opts.actorId ?? null, 'support_gift.review_flag', orderId, { reason: guard.reason, trigger });
    }
  }

  // Advance pending → due. The preconditions (delivered, fully collected, no
  // open guard) are all inside the WHERE clause, so two concurrent triggers
  // cannot both "see" a pending row and both promote it, and a partially
  // collected order can never slip through between a read and a write.
  let becameDue = false;
  if (decision.qualifies && !guard.needsReview) {
    const advanced = await db
      .prepare(
        `UPDATE support_gift_entitlements
            SET state = 'due',
                qualified_at = ?2,
                settled_at = COALESCE(settled_at, ?2),
                delivered_at = COALESCE(delivered_at, ?3),
                updated_at = ?2
          WHERE order_id = ?1
            AND state = 'pending_eligibility'
            AND needs_review = 0
            AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ?1 AND o.status = 'delivered')
            AND (SELECT COALESCE(SUM(s.amount_iqd), 0) FROM order_payment_settlements s WHERE s.order_id = ?1)
                >= (SELECT ${levonisCollectibleSql('o')} FROM orders o WHERE o.id = ?1)`
      )
      .bind(orderId, nowIso, order.delivered_at)
      .run();
    becameDue = (advanced.meta.changes || 0) > 0;
    if (becameDue) {
      await audit(db, opts.actorId ?? null, 'support_gift.due', orderId, {
        referrer_id: snap.referrer_user_id,
        trigger,
      });
    }
  }

  const after = await db
    .prepare('SELECT state, needs_review, review_reason FROM support_gift_entitlements WHERE order_id = ?')
    .bind(orderId)
    .first<{ state: SupportGiftState; needs_review: number; review_reason: string }>();

  return {
    ...base,
    entitlement: !!after,
    became_due: becameDue,
    state: after?.state ?? null,
    needs_review: !!after?.needs_review,
    review_reason: after?.review_reason ?? '',
    blocker: decision.blocker,
    reason: becameDue ? 'became_due' : 'unchanged',
  };
}

/**
 * Cancel every UNCOMMITTED entitlement of an order (§3.4: "cancel the
 * incomplete entitlement when the product is returned before the gift is
 * handed over"). Reserved and paid claims are deliberately untouched: stock
 * is already committed or the spool already left, and reversing that is an
 * announced settlement decision made by a human, never an automatic
 * clawback. Returns how many rows actually changed.
 */
export async function cancelSupportGiftsForOrder(
  env: Env,
  orderId: string,
  reason: string,
  actorId: string | null = null
): Promise<number> {
  const nowIso = new Date().toISOString();
  const res = await env.DB.prepare(
    `UPDATE support_gift_entitlements
        SET state = 'cancelled',
            outcome_reason = ?2,
            decided_by = COALESCE(?3, decided_by),
            decided_at = ?4,
            updated_at = ?4
      WHERE order_id = ?1 AND state IN ('pending_eligibility','due')`
  )
    .bind(orderId, String(reason || 'cancelled').slice(0, 200), actorId, nowIso)
    .run();
  const changed = res.meta.changes || 0;
  if (changed > 0) {
    await audit(env.DB, actorId, 'support_gift.cancel', orderId, { reason, count: changed });
  }
  return changed;
}

export interface SupportGiftReconciliation {
  scanned: number;
  cancelled: number;
  became_due: number;
  flagged: number;
}

/**
 * Sweep of live claims — the safety net for the events that do not call the
 * engine directly (an order cancelled through a path that predates this
 * feature, a COD collected by a job, a return opened after the gift became
 * due). It only re-runs the same idempotent evaluation, so running it twice
 * changes nothing the first run did not already settle.
 */
export async function reconcileSupportGifts(env: Env, limit = 200): Promise<SupportGiftReconciliation> {
  const cap = Math.max(1, Math.min(500, Math.trunc(limit) || 200));
  const { results } = await env.DB.prepare(
    `SELECT order_id FROM support_gift_entitlements
      WHERE state IN ('pending_eligibility','due')
      ORDER BY updated_at ASC LIMIT ?`
  )
    .bind(cap)
    .all<{ order_id: string }>();

  const report: SupportGiftReconciliation = { scanned: 0, cancelled: 0, became_due: 0, flagged: 0 };
  for (const row of results) {
    report.scanned++;
    try {
      const before = await env.DB.prepare(
        'SELECT state, needs_review FROM support_gift_entitlements WHERE order_id = ?'
      )
        .bind(row.order_id)
        .first<{ state: string; needs_review: number }>();
      const res = await evaluateSupportGiftForOrder(env, row.order_id, { trigger: 'reconcile' });
      if (res.state === 'cancelled' && before?.state !== 'cancelled') report.cancelled++;
      if (res.became_due) report.became_due++;
      if (res.needs_review && !before?.needs_review) report.flagged++;
    } catch (e) {
      console.error('support gift reconcile failed for order', row.order_id, e instanceof Error ? e.message : String(e));
    }
  }
  return report;
}
