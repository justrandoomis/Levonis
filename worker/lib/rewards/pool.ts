/**
 * THE CUSTOMER'S LIVE REWARD COUPONS, AS ONE POOL (owner, 2026-11-05; migration
 * 0225; docs/DECISIONS.md row 295).
 *
 * One order spends as many of them as it can use: «2 coupon mean shipping
 * discount 10000 and 2 pic of filament». The arithmetic is pure and lives in
 * packages/pricing/src/coupons.ts (`allocateCouponPool`); this file reads who
 * holds what, and is the one definition of «spent».
 *
 * THE CHECKOUT STILL TAKES ONE CODE. A customer presses «استخدمه الآن» on any
 * of their coupons, the box holds that one code, and the server spends what the
 * order can use. A typed promo code is not a reward coupon and goes the ordinary
 * way, alone: it never joins the pool.
 *
 * WHERE THE SPENDING IS WRITTEN. `coupon_redemptions.order_id` is UNIQUE (0002),
 * so the first coupon spent goes there like any coupon, and every other one goes
 * to `coupon_redemption_extras` (0225). `SPENT_SQL` reads both; the triggers of
 * 0225 refuse a coupon active in either table, inside the order's own batch.
 */
import { allocateCouponPool, type CouponContext, type CouponLine, type PoolAllocation, type PoolCoupon } from '@levonis/pricing/coupons';
import { couponRuleOf } from '../couponLines';
import { isSchemaMissing } from '../membershipBenefits';

/**
 * The query's own bound: a hundred printers' pairs at the default week of
 * validity. Past it the soonest to end are read, and the rest wait for the next order.
 */
export const POOL_LIMIT = 200;

/** Is this coupon spent on a live order? One scalar SQL expression, for every reader. */
export const SPENT_SQL = (coupon: string): string =>
  `(EXISTS (SELECT 1 FROM coupon_redemptions sr WHERE sr.coupon_id = ${coupon} AND sr.state = 'active')
     OR EXISTS (SELECT 1 FROM coupon_redemption_extras sx WHERE sx.coupon_id = ${coupon} AND sx.state = 'active'))`;

/** The order that spent this coupon, or NULL. One scalar SQL expression. */
export const SPENT_ON_SQL = (coupon: string): string =>
  `COALESCE((SELECT sr.order_id FROM coupon_redemptions sr WHERE sr.coupon_id = ${coupon} AND sr.state = 'active' LIMIT 1),
            (SELECT sx.order_id FROM coupon_redemption_extras sx WHERE sx.coupon_id = ${coupon} AND sx.state = 'active' LIMIT 1))`;

/** Was this coupon spent beside another, on a live order? False on a database without 0225. */
export async function spentAsExtra(db: D1Database, couponId: string): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT 1 AS x FROM coupon_redemption_extras WHERE coupon_id = ? AND state = 'active' LIMIT 1").bind(couponId).first();
    return !!row;
  } catch (e) {
    if (isSchemaMissing(e)) return false;
    throw e;
  }
}

/**
 * Every reward coupon this customer can spend right now, the soonest to end
 * first. Among coupons that end together the first printer's go first, then the
 * coupon's id, so one wallet always spends one way. Without this the coupon spent
 * was decided by a random id, and so was what a later return could withdraw: a
 * returned printer takes the highest unit's coupons (`revokeRewardsForReturn`),
 * and those are whole only if the order spent from the lowest.
 */
export async function livePool(db: D1Database, userId: string, nowIso: string): Promise<PoolCoupon[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*
         FROM reward_grants g
         JOIN coupons c ON c.id = g.coupon_id
        WHERE g.user_id = ?1 AND g.revoked_at IS NULL
          AND c.active = 1 AND c.assigned_user_id = ?1
          AND (c.starts_at IS NULL OR c.starts_at <= ?2)
          AND (c.ends_at IS NULL OR c.ends_at > ?2)
          AND NOT ${SPENT_SQL('g.coupon_id')}
        ORDER BY c.ends_at ASC, g.unit_index ASC, c.id ASC
        LIMIT ?3`
    )
    .bind(userId, nowIso, POOL_LIMIT)
    .all<Record<string, unknown>>();
  return (results ?? []).map((row) => ({
    coupon_id: String(row.id),
    code: String(row.code),
    rule: couponRuleOf(row),
    min_total_iqd: Math.max(0, Math.trunc(Number(row.min_total_iqd) || 0)),
  }));
}

export interface PoolTarget {
  lines: readonly CouponLine[];
  ctx: CouponContext;
  deliveryPending?: boolean;
}

/** What this customer's coupons take off these lines. */
export async function poolFor(db: D1Database, userId: string, target: PoolTarget, nowIso: string): Promise<{ coupons: PoolCoupon[]; allocation: PoolAllocation }> {
  const coupons = await livePool(db, userId, nowIso);
  return { coupons, allocation: allocateCouponPool(coupons, target.lines, target.ctx, { deliveryPending: target.deliveryPending }) };
}
