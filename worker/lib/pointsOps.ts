/**
 * Purchase points (final-phase §6.6, decision register row 20 defaults):
 *
 *  - 1 point per full 1,000 IQD of QUALIFYING spend; 1 point redeems as 1 IQD
 *    (redemption already implemented in checkout — POINT currency wallet).
 *  - Qualifying spend = merchandise actually paid for: the per-unit APPLIED
 *    product price × qty, net of order-level discounts (coupon) and net of
 *    the points-funded portion, EXCLUDING last-mile shipping, preorder
 *    transport commissions and warranty fees. Fractional remainders do NOT
 *    carry across purchases (floor per order — row 20 default, changeable).
 *  - Awarded at the DELIVERED event (verified fulfillment), never at
 *    checkout. Idempotent via points_awards PRIMARY KEY(source_ref):
 *    'order:<id>:award' exists exactly once no matter how many times the
 *    delivered transition or a replayed callback fires.
 *  - Reversals (refund/return) are separate negative points_awards rows keyed
 *    'order:<id>:reverse[:<case>]' — never double-reversed, capped at what
 *    remains un-reversed of the original award.
 *
 * The points VALUE lives in wallet_transactions (currency='POINT'), same
 * ledger the rest of the app reads; points_awards is the idempotency guard
 * with immutable source references (0003).
 */

import type { Env } from './types';
import { safeParse } from './types';

// ---------------------------------------------------------------- pure math

export interface PointsItemFacts {
  qty: number;
  unit_price_iqd: number; // applied + effective commission + warranty fee (0002)
  pricing_snapshot: string | null; // JSON ResolvedPrice sans cost (has applied_iqd)
  warranty_snapshot: string | null; // JSON {fee_iqd,...}
  transport_snapshot: string | null; // JSON {commission_iqd, waived}
}

/**
 * Merchandise value of ONE unit of an order item: the applied product price
 * only — transport commission and warranty fee stripped. Prefers the
 * persisted resolver snapshot; falls back to subtracting the persisted fee
 * snapshots from unit_price_iqd for pre-snapshot rows.
 */
export function unitMerchandiseIqd(item: PointsItemFacts): number {
  const ps = safeParse<{ applied_iqd?: number } | null>(item.pricing_snapshot, null);
  if (ps && Number.isInteger(ps.applied_iqd) && (ps.applied_iqd as number) >= 0) {
    return ps.applied_iqd as number;
  }
  const warranty = safeParse<{ fee_iqd?: number } | null>(item.warranty_snapshot, null);
  const transport = safeParse<{ commission_iqd?: number; waived?: boolean } | null>(item.transport_snapshot, null);
  const wFee = warranty ? Number(warranty.fee_iqd) || 0 : 0;
  const comm = transport && transport.waived !== true ? Number(transport.commission_iqd) || 0 : 0;
  return Math.max(0, (Number(item.unit_price_iqd) || 0) - wFee - comm);
}

/**
 * Qualifying spend for a whole order. Order-level discounts (coupon IQD and
 * the points-funded portion) are deducted IN FULL from the merchandise base —
 * deliberately conservative (they can partly cover shipping): points are
 * never over-awarded, and shipping never earns points.
 */
export function computeQualifyingSpendIqd(
  items: PointsItemFacts[],
  couponDiscountIqd: number,
  pointsDiscountIqd: number
): number {
  let merchandise = 0;
  for (const it of items) {
    merchandise += unitMerchandiseIqd(it) * Math.max(0, Math.trunc(Number(it.qty) || 0));
  }
  const discounts = Math.max(0, Number(couponDiscountIqd) || 0) + Math.max(0, Number(pointsDiscountIqd) || 0);
  return Math.max(0, merchandise - discounts);
}

/** Row-20 rate: floor(spend / 1000); remainders do not carry over. */
export function pointsForQualifyingSpend(qualifyingIqd: number): number {
  if (!Number.isFinite(qualifyingIqd) || qualifyingIqd <= 0) return 0;
  return Math.floor(qualifyingIqd / 1000);
}

// ---------------------------------------------------------------- award

export interface AwardResult {
  awarded: boolean;
  points: number;
  reason?: string;
}

interface OrderPointsRow {
  id: string;
  user_id: string;
  status: string;
  subtotal_iqd: number;
  points_discount_iqd: number;
  coupon_snapshot: string | null;
}

async function loadOrderFacts(
  env: Env,
  orderId: string
): Promise<{ order: OrderPointsRow; items: PointsItemFacts[]; couponIqd: number } | null> {
  const order = await env.DB.prepare(
    'SELECT id, user_id, status, subtotal_iqd, points_discount_iqd, coupon_snapshot FROM orders WHERE id = ?'
  )
    .bind(orderId)
    .first<OrderPointsRow>();
  if (!order) return null;
  const { results: items } = await env.DB.prepare(
    'SELECT qty, unit_price_iqd, pricing_snapshot, warranty_snapshot, transport_snapshot FROM order_items WHERE order_id = ?'
  )
    .bind(orderId)
    .all<PointsItemFacts>();
  const coupon = safeParse<{ discount_iqd?: number } | null>(order.coupon_snapshot, null);
  const couponIqd = coupon ? Number(coupon.discount_iqd) || 0 : 0;
  return { order, items, couponIqd };
}

/**
 * Awards purchase points for a DELIVERED order. Call from the delivered
 * transition (worker/routes/admin.ts). Idempotent: replaying the transition
 * or a duplicated callback awards exactly once (points_awards PK aborts the
 * whole batch, so the wallet deposit can never double either).
 */
export async function awardOrderPoints(env: Env, orderId: string): Promise<AwardResult> {
  const facts = await loadOrderFacts(env, orderId);
  if (!facts) return { awarded: false, points: 0, reason: 'order_not_found' };
  const { order, items, couponIqd } = facts;
  if (order.status !== 'delivered') return { awarded: false, points: 0, reason: 'not_delivered' };

  const qualifying = computeQualifyingSpendIqd(items, couponIqd, Number(order.points_discount_iqd) || 0);
  const points = pointsForQualifyingSpend(qualifying);

  const now = new Date().toISOString();
  const key = `order:${orderId}:award`;
  const stmts: D1PreparedStatement[] = [
    // Guard row is written even for a 0-point order so the evaluation is
    // recorded once and replays are visibly no-ops.
    env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points) VALUES (?, ?, ?)').bind(
      key,
      order.user_id,
      points
    ),
  ];
  if (points > 0) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', ?)`
      ).bind(
        `wtx_pts_${orderId}`,
        order.user_id,
        points,
        `Purchase points for delivered order ${orderId}`,
        orderId,
        now
      )
    );
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      return { awarded: false, points: 0, reason: 'already_awarded' };
    }
    throw e;
  }
  return { awarded: true, points };
}

// ---------------------------------------------------------------- reversal

export interface ReversalResult {
  reversed: boolean;
  points: number;
  reason?: string;
}

/**
 * Reverses purchase points on a refund/return.
 *
 *  - Full reversal by default; pass opts.portionIqd (the refunded
 *    MERCHANDISE portion in IQD) for a proportional reversal of a partial
 *    return: floor(portion / 1000) points, capped at what remains.
 *  - Never double-reverses: each reversal is its own points_awards row —
 *    'order:<id>:reverse' (full) or 'order:<id>:reverse:<sourceRef>' (per
 *    return case) — and the cap re-derives from all recorded reversals.
 *  - The wallet withdrawal is balance-guarded: if the customer already spent
 *    the points, nothing goes negative — the call reports
 *    'insufficient_points_balance' honestly instead of faking a claw-back.
 */
export async function reversePointsForOrder(
  env: Env,
  orderId: string,
  reason: string,
  opts: { portionIqd?: number; sourceRef?: string } = {}
): Promise<ReversalResult> {
  const award = await env.DB.prepare('SELECT user_id, points FROM points_awards WHERE source_ref = ?')
    .bind(`order:${orderId}:award`)
    .first<{ user_id: string; points: number }>();
  if (!award || (Number(award.points) || 0) <= 0) {
    return { reversed: false, points: 0, reason: 'nothing_awarded' };
  }

  const prior = await env.DB.prepare(
    "SELECT COALESCE(SUM(points), 0) AS total FROM points_awards WHERE source_ref LIKE ? AND points < 0"
  )
    .bind(`order:${orderId}:reverse%`)
    .first<{ total: number }>();
  const remaining = (Number(award.points) || 0) + (Number(prior?.total) || 0); // reversals are negative
  if (remaining <= 0) return { reversed: false, points: 0, reason: 'already_reversed' };

  let toReverse = remaining;
  if (opts.portionIqd !== undefined) {
    const portionPoints = pointsForQualifyingSpend(Math.max(0, Math.trunc(opts.portionIqd)));
    toReverse = Math.min(remaining, portionPoints);
  }
  if (toReverse <= 0) return { reversed: false, points: 0, reason: 'no_points_in_portion' };

  const suffix = opts.sourceRef ? `:${String(opts.sourceRef).slice(0, 60)}` : '';
  const key = `order:${orderId}:reverse${suffix}`;
  const wtxId = opts.sourceRef ? `wtx_ptsrev_${String(opts.sourceRef).slice(0, 40)}` : `wtx_ptsrev_${orderId}`;
  const now = new Date().toISOString();
  const note = `Points reversal for order ${orderId}: ${reason}`.slice(0, 300);

  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points) VALUES (?, ?, ?)').bind(
        key,
        award.user_id,
        -toReverse
      ),
      // Conditional amount: turns negative (violating CHECK amount > 0) when
      // the live POINT balance no longer covers the claw-back, aborting the
      // whole batch atomically — same pattern as checkout point spending.
      env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'withdrawal', 'POINT',
           CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                        FROM wallet_transactions WHERE user_id = ?2 AND currency='POINT' AND status='approved') >= ?3
                THEN ?3 ELSE -1 END,
           'approved', ?4, ?5, 'system', ?6`
      ).bind(wtxId, award.user_id, toReverse, note, orderId, now),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      return { reversed: false, points: 0, reason: 'already_reversed' };
    }
    if (msg.includes('CHECK')) {
      return { reversed: false, points: toReverse, reason: 'insufficient_points_balance' };
    }
    throw e;
  }
  return { reversed: true, points: toReverse };
}
