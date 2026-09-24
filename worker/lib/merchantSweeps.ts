/**
 * THE MERCHANT NOTIFICATION AND ANALYTICS SWEEPS — one exported entry point,
 * registered with one line in worker/lib/jobs.ts.
 *
 * Every tick (15 minutes):
 *   - «صار مبلغ متاحًا» for store-sale credits the three-day sweep released
 *     since the last ticks. The release writes an `audit_log` row
 *     (`store_order.credit_released`, worker/lib/storeOrderOps.ts); this reads
 *     those rows from the last two days and tells each merchant once — the
 *     event key is the order, the same key the customer's «استلمت طلبي» uses,
 *     so the two paths can never announce one credit twice;
 *   - the same for a custom order's escrow released by the auto-confirm sweep
 *     or an admin's resolution (`community_escrow_events` kind 'release').
 *
 * Once per Baghdad day, from 09:00 (nobody's phone buzzes at midnight about a
 * coupon):
 *   - «كوبونك ينتهي قريبًا» for an active, unexhausted coupon ending within
 *     `COUPON_ENDING_DAYS`, once per coupon per end date;
 *   - «ما زال بانتظار تأكيدك» for a store order still `pending` a day after it
 *     was placed, once per order;
 *   - the analytics marks and salts whose day is over are deleted.
 *
 * All of it is idempotent: every notice has its replay key, and the daily
 * gate is a fixed-window row, so overlapping ticks do the work once.
 */
import type { Env } from './types';
import { baghdadDay, BAGHDAD_OFFSET_MS } from './baghdadTime';
import {
  couponEndingNotice,
  notifyMerchant,
  notifyOrderCreditAvailable,
  notifyPayoutAvailable,
  pendingOrderNotice,
} from './merchantNotify';
import { pruneStorefrontAnalytics } from './storefrontAnalytics';

export const COUPON_ENDING_DAYS = 3;
export const PENDING_ORDER_HOURS = 24;
/** The Baghdad hour from which the daily part runs. */
export const DAILY_FROM_HOUR = 9;
const BATCH = 200;

export interface MerchantSweepReport {
  payouts_available: number;
  coupons_ending: number;
  pending_orders: number;
  daily_ran: boolean;
  pruned_marks: number;
  errors: number;
}

/** Was the daily part already run for this Baghdad day? Claims it if not. */
async function claimDay(db: D1Database, day: string): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`
    )
    .bind('sweep:merchant-daily', Number(day.replace(/-/g, '')))
    .first<{ count: number }>();
  return Number(row?.count) === 1;
}

export async function runMerchantSweeps(env: Env, nowIso: string, opts: { forceDaily?: boolean } = {}): Promise<MerchantSweepReport> {
  const out: MerchantSweepReport = {
    payouts_available: 0,
    coupons_ending: 0,
    pending_orders: 0,
    daily_ran: false,
    pruned_marks: 0,
    errors: 0,
  };
  const db = env.DB;
  const now = Date.parse(nowIso);

  // ---- released store credits (every tick)
  try {
    const since = new Date(now - 2 * 86_400_000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT target AS order_id, json_extract(detail, '$.merchant_id') AS merchant_id,
                json_extract(detail, '$.amount_iqd') AS amount_iqd
           FROM audit_log
          WHERE action = 'store_order.credit_released' AND created_at >= ?
          ORDER BY created_at
          LIMIT ${BATCH}`
      )
      .bind(since)
      .all<{ order_id: string; merchant_id: string | null; amount_iqd: number | null }>();
    for (const r of results ?? []) {
      // The amount is the ledger's (what the order now holds available), not the audit line's.
      const res = await notifyOrderCreditAvailable(env, r.order_id);
      if (res.written) out.payouts_available += 1;
    }
  } catch (e) {
    out.errors += 1;
    console.error('merchant sweep: released credits', e instanceof Error ? e.message : String(e));
  }

  // ---- released custom-order escrows (the auto-confirm sweep, an admin's
  //      resolution): the release is an append-only escrow event. Same key as
  //      the customer's confirm route, so each credit is announced once.
  try {
    const since = new Date(now - 2 * 86_400_000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT o.id AS order_id, o.merchant_id, o.merchant_receivable_iqd AS amount_iqd
           FROM community_escrow_events ev
           JOIN community_escrows e ON e.id = ev.escrow_id
           JOIN community_orders o ON o.id = e.community_order_id
          WHERE ev.kind = 'release' AND ev.created_at >= ?
          ORDER BY ev.created_at
          LIMIT ${BATCH}`
      )
      .bind(since)
      .all<{ order_id: string; merchant_id: string; amount_iqd: number }>();
    for (const r of results ?? []) {
      const res = await notifyPayoutAvailable(env, {
        merchantId: r.merchant_id,
        amountIqd: Number(r.amount_iqd) || 0,
        sourceKey: `community_order:${r.order_id}`,
        communityOrderId: r.order_id,
      });
      if (res.written) out.payouts_available += 1;
    }
  } catch (e) {
    out.errors += 1;
    console.error('merchant sweep: released escrows', e instanceof Error ? e.message : String(e));
  }

  // ---- the daily part
  const baghdadHour = new Date(now + BAGHDAD_OFFSET_MS).getUTCHours();
  const day = baghdadDay(now);
  if (!opts.forceDaily && baghdadHour < DAILY_FROM_HOUR) return out;
  if (!(await claimDay(db, day).catch(() => false)) && !opts.forceDaily) return out;
  out.daily_ran = true;

  try {
    const horizon = new Date(now + COUPON_ENDING_DAYS * 86_400_000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT c.id, c.code, c.ends_at, c.used_count, c.merchant_id
           FROM merchant_coupons c
           JOIN merchant_stores s ON s.id = c.store_id
          WHERE c.active = 1 AND c.ends_at IS NOT NULL AND c.ends_at <> ''
            AND c.ends_at > ?1 AND c.ends_at <= ?2
            AND (c.max_uses IS NULL OR c.used_count < c.max_uses)
            AND s.status <> 'suspended'
          ORDER BY c.ends_at
          LIMIT ${BATCH}`
      )
      .bind(nowIso, horizon)
      .all<{ id: string; code: string; ends_at: string; used_count: number; merchant_id: string }>();
    for (const cpn of results ?? []) {
      const res = await notifyMerchant(env, { merchantId: cpn.merchant_id }, couponEndingNotice(cpn));
      if (res.written) out.coupons_ending += 1;
    }
  } catch (e) {
    out.errors += 1;
    console.error('merchant sweep: coupons', e instanceof Error ? e.message : String(e));
  }

  try {
    const cutoff = new Date(now - PENDING_ORDER_HOURS * 3_600_000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT o.id, o.merchant_id FROM orders o
          WHERE o.seller_type = 'merchant' AND o.merchant_id IS NOT NULL
            AND o.status = 'pending' AND o.created_at <= ?1 AND o.created_at > ?2
          ORDER BY o.created_at
          LIMIT ${BATCH}`
      )
      // A week back at most: an order abandoned for longer is a support case,
      // not a reminder to send every morning.
      .bind(cutoff, new Date(now - 7 * 86_400_000).toISOString())
      .all<{ id: string; merchant_id: string }>();
    for (const o of results ?? []) {
      const res = await notifyMerchant(env, { merchantId: o.merchant_id }, pendingOrderNotice(o.id));
      if (res.written) out.pending_orders += 1;
    }
  } catch (e) {
    out.errors += 1;
    console.error('merchant sweep: pending orders', e instanceof Error ? e.message : String(e));
  }

  try {
    out.pruned_marks = (await pruneStorefrontAnalytics(db, day)).marks;
  } catch (e) {
    out.errors += 1;
    console.error('merchant sweep: analytics prune', e instanceof Error ? e.message : String(e));
  }
  return out;
}
