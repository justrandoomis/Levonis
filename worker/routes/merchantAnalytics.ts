/**
 * THE STORE'S ANALYTICS OVER A RANGE — GET /api/merchant/analytics/report.
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   Baghdad days, inclusive (default: the last
 *                                    30 days); at most 366 days
 *
 * EVERY FIGURE HAS A REAL SOURCE, AND A FIGURE WITHOUT ONE IS ABSENT — not 0.
 *
 *   traffic       merchant_store_analytics_daily / merchant_product_analytics_daily,
 *                 written by the storefront beacon (worker/lib/storefrontAnalytics.ts).
 *                 Counting began on `traffic.since` (the first day any store
 *                 recorded traffic). Days before it are NOT in the series — the
 *                 store had visitors, nobody counted them — and when no store
 *                 has any traffic yet, `traffic` is absent altogether. A day
 *                 on or after `since` with no row is a real zero.
 *   orders        `orders` of this merchant, live — so a cancellation next
 *                 week corrects last week. Counted = not cancelled; placed on
 *                 the Baghdad day of `created_at`.
 *   funnel        visitors → product views → add to cart → checkout → orders,
 *                 over the days traffic was counted only; absent with traffic.
 *   products      top: units and revenue from counted order lines; least
 *                 viewed: this store's live products by views (with traffic).
 *   customers     from counted orders: buyers in the range, and how many had
 *                 bought here before (or more than once in the range).
 *   coupons       per code used in the range: orders, discount given, sales;
 *                 plus the coupon's own lifetime uses and end date.
 *   governorates  the delivery address's governorate on counted orders; an
 *                 order without one is counted apart as `unspecified`.
 *   requests      matching decisions, notifications, offers sent and accepted,
 *                 custom orders completed — from the community tables.
 *
 * Traffic sources are coarse (direct / search / social / other) and only the
 * referrer's host was ever looked at.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest, requireAuth } from '../lib/http';
import { requireStoreOwner } from '../lib/merchantAuth';
import { getTierStatus, benefits } from '../lib/entitlements';
import { addDays, baghdadDay } from '../lib/baghdadTime';
import { BAGHDAD_SQL_SHIFT, resolveRange, utcWindowFor } from '../lib/financeReport';

export const merchantAnalyticsRoutes = new Hono<AppContext>();
merchantAnalyticsRoutes.use('*', requireAuth);

/** A store order that counts: not cancelled (refunds cancel the order). */
const COUNTED = `o.status <> 'cancelled'`;
const DAY_OF = (col: string) => `COALESCE(date(${col}, '${BAGHDAD_SQL_SHIFT}'), '')`;

interface TrafficRow {
  day: string;
  visitors: number;
  store_views: number;
  product_views: number;
  add_to_cart: number;
  checkout_started: number;
  source_direct: number;
  source_search: number;
  source_social: number;
  source_other: number;
}

const num = (v: unknown) => Number(v) || 0;

merchantAnalyticsRoutes.get('/report', async (c) => {
  const ctx = await requireStoreOwner(c);
  const user = c.get('user')!;
  const tier = await getTierStatus(c.env.DB, user.id);
  if (!benefits.merchantAnalytics(tier)) {
    throw new HttpError(403, 'Analytics are part of LEVO PLUS. Renew to see them again.', 'ANALYTICS_NOT_INCLUDED');
  }
  const today = baghdadDay(Date.now());
  const to = c.req.query('to') || today;
  const from = c.req.query('from') || addDays(to, -29);
  const resolved = resolveRange(from, to);
  if ('error' in resolved) throw badRequest(resolved.error, 'BAD_RANGE');
  const range = resolved.range;
  const { startIso, endIso } = utcWindowFor(range);
  const db = c.env.DB;
  const storeId = ctx.store.id;
  const merchantId = ctx.merchant.id;

  const [sinceRow, traffic, orderDays, cancelled, top, customers, coupons, govs, matches, offers, custom] = await Promise.all([
    db.prepare('SELECT MIN(day) AS d FROM merchant_store_analytics_daily').first<{ d: string | null }>(),
    db
      .prepare(
        `SELECT day, visitors, store_views, product_views, add_to_cart, checkout_started,
                source_direct, source_search, source_social, source_other
           FROM merchant_store_analytics_daily
          WHERE store_id = ? AND day >= ? AND day <= ?
          ORDER BY day`
      )
      .bind(storeId, range.from, range.to)
      .all<TrafficRow>(),
    db
      .prepare(
        `SELECT ${DAY_OF('o.created_at')} AS day, COUNT(*) AS orders,
                COALESCE(SUM(o.total_iqd), 0) AS gross, COALESCE(SUM(o.merchant_receivable_iqd), 0) AS receivable
           FROM orders o
          WHERE o.merchant_id = ? AND o.created_at >= ? AND o.created_at < ? AND ${COUNTED}
          GROUP BY day`
      )
      .bind(merchantId, startIso, endIso)
      .all<{ day: string; orders: number; gross: number; receivable: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders o
          WHERE o.merchant_id = ? AND o.created_at >= ? AND o.created_at < ? AND o.status = 'cancelled'`
      )
      .bind(merchantId, startIso, endIso)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT i.community_product_id AS id, MAX(p.name) AS name,
                SUM(i.qty) AS units, COALESCE(SUM(i.line_total_iqd), 0) AS revenue, COUNT(DISTINCT o.id) AS orders
           FROM order_items i
           JOIN orders o ON o.id = i.order_id
           LEFT JOIN community_products p ON p.id = i.community_product_id AND p.merchant_id = o.merchant_id
          WHERE o.merchant_id = ? AND o.created_at >= ? AND o.created_at < ? AND ${COUNTED}
            AND i.community_product_id IS NOT NULL
          GROUP BY i.community_product_id
          ORDER BY revenue DESC, units DESC, id
          LIMIT 5`
      )
      .bind(merchantId, startIso, endIso)
      .all<{ id: string; name: string | null; units: number; revenue: number; orders: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS customers,
                COALESCE(SUM(CASE WHEN t.first_at < ?2 OR t.n_in >= 2 THEN 1 ELSE 0 END), 0) AS returning_n
           FROM (SELECT o.user_id,
                        SUM(CASE WHEN o.created_at >= ?2 THEN 1 ELSE 0 END) AS n_in,
                        MIN(o.created_at) AS first_at
                   FROM orders o
                  WHERE o.merchant_id = ?1 AND o.created_at < ?3 AND ${COUNTED}
                  GROUP BY o.user_id) t
          WHERE t.n_in > 0`
      )
      .bind(merchantId, startIso, endIso)
      .first<{ customers: number; returning_n: number }>(),
    db
      .prepare(
        `SELECT o.coupon_code AS code, COUNT(*) AS orders,
                COALESCE(SUM(o.coupon_discount_iqd), 0) AS discount, COALESCE(SUM(o.total_iqd), 0) AS gross,
                MAX(mc.id) AS coupon_id, MAX(mc.used_count) AS used_count, MAX(mc.max_uses) AS max_uses,
                MAX(mc.ends_at) AS ends_at, MAX(mc.active) AS active
           FROM orders o
           LEFT JOIN merchant_coupons mc ON mc.store_id = ?4 AND mc.code = o.coupon_code
          WHERE o.merchant_id = ?1 AND o.created_at >= ?2 AND o.created_at < ?3 AND ${COUNTED}
            AND o.coupon_code <> ''
          GROUP BY o.coupon_code
          ORDER BY orders DESC, code
          LIMIT 20`
      )
      .bind(merchantId, startIso, endIso, storeId)
      .all<{
        code: string; orders: number; discount: number; gross: number; coupon_id: string | null;
        used_count: number | null; max_uses: number | null; ends_at: string | null; active: number | null;
      }>(),
    db
      .prepare(
        `SELECT COALESCE(json_extract(o.address_snapshot, '$.governorate'), '') AS governorate,
                COUNT(*) AS orders, COALESCE(SUM(o.total_iqd), 0) AS gross
           FROM orders o
          WHERE o.merchant_id = ? AND o.created_at >= ? AND o.created_at < ? AND ${COUNTED}
            AND json_valid(o.address_snapshot)
          GROUP BY governorate
          ORDER BY orders DESC`
      )
      .bind(merchantId, startIso, endIso)
      .all<{ governorate: string; orders: number; gross: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END), 0) AS matched,
                COALESCE(SUM(CASE WHEN notified = 1 THEN 1 ELSE 0 END), 0) AS notified
           FROM community_request_matches
          WHERE merchant_id = ? AND created_at >= ? AND created_at < ?`
      )
      .bind(merchantId, startIso, endIso)
      .first<{ matched: number; notified: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS sent, COALESCE(SUM(CASE WHEN state = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted
           FROM community_offers
          WHERE merchant_id = ? AND created_at >= ? AND created_at < ?`
      )
      .bind(merchantId, startIso, endIso)
      .first<{ sent: number; accepted: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS completed, COALESCE(SUM(merchant_receivable_iqd), 0) AS receivable
           FROM community_orders
          WHERE merchant_id = ? AND state = 'completed' AND completed_at >= ? AND completed_at < ?`
      )
      .bind(merchantId, startIso, endIso)
      .first<{ completed: number; receivable: number }>(),
  ]);

  // ---- orders: every day of the range, because `orders` has always existed.
  const byDay = new Map((orderDays.results ?? []).map((r) => [r.day, r]));
  const days: string[] = [];
  for (let d = range.from; d && d <= range.to; d = addDays(d, 1)) days.push(d);
  const orderSeries = days.map((day) => ({
    day,
    orders: num(byDay.get(day)?.orders),
    gross_iqd: num(byDay.get(day)?.gross),
  }));
  const orderCount = orderSeries.reduce((s, r) => s + r.orders, 0);
  const gross = orderSeries.reduce((s, r) => s + r.gross_iqd, 0);
  const receivable = (orderDays.results ?? []).reduce((s, r) => s + num(r.receivable), 0);

  // ---- traffic: only the days it was being counted.
  const since = sinceRow?.d ?? null;
  const countedFrom = since && since > range.from ? since : range.from;
  const trafficAvailable = !!since && since <= range.to;
  const tByDay = new Map((traffic.results ?? []).map((r) => [r.day, r]));
  const trafficDays = trafficAvailable ? days.filter((d) => d >= countedFrom) : [];
  const trafficSeries = trafficDays.map((day) => {
    const r = tByDay.get(day);
    return {
      day,
      visitors: num(r?.visitors),
      store_views: num(r?.store_views),
      product_views: num(r?.product_views),
      add_to_cart: num(r?.add_to_cart),
      checkout_started: num(r?.checkout_started),
    };
  });
  const sum = (k: keyof TrafficRow) =>
    trafficDays.reduce((s, d) => s + num(tByDay.get(d)?.[k]), 0);

  let trafficBlock: Record<string, unknown> | undefined;
  let funnel: Record<string, unknown> | undefined;
  let leastViewed: Array<Record<string, unknown>> | undefined;
  if (trafficAvailable) {
    const totals = {
      visitors: sum('visitors'),
      store_views: sum('store_views'),
      product_views: sum('product_views'),
      add_to_cart: sum('add_to_cart'),
      checkout_started: sum('checkout_started'),
    };
    trafficBlock = {
      since,
      counted_from: countedFrom,
      totals,
      sources: {
        direct: sum('source_direct'),
        search: sum('source_search'),
        social: sum('source_social'),
        other: sum('source_other'),
      },
      series: trafficSeries,
    };
    const ordersWhileCounted = orderSeries.filter((r) => r.day >= countedFrom).reduce((s, r) => s + r.orders, 0);
    funnel = {
      from: countedFrom,
      visitors: totals.visitors,
      product_views: totals.product_views,
      add_to_cart: totals.add_to_cart,
      checkout_started: totals.checkout_started,
      orders: ordersWhileCounted,
      // Orders per 100 visitors — absent with no visitors, never a 0% of nothing.
      ...(totals.visitors > 0
        ? { conversion_percent: Math.round((ordersWhileCounted / totals.visitors) * 1000) / 10 }
        : {}),
    };
    const { results: views } = await db
      .prepare(
        `SELECT p.id, p.name, COALESCE(SUM(a.views), 0) AS views, COALESCE(SUM(a.add_to_cart), 0) AS add_to_cart
           FROM community_products p
           LEFT JOIN merchant_product_analytics_daily a
             ON a.product_id = p.id AND a.store_id = ?1 AND a.day >= ?2 AND a.day <= ?3
          WHERE p.store_id = ?1 AND p.status = 'active'
          GROUP BY p.id, p.name
          ORDER BY views ASC, p.created_at DESC, p.id
          LIMIT 5`
      )
      .bind(storeId, countedFrom, range.to)
      .all<{ id: string; name: string; views: number; add_to_cart: number }>();
    leastViewed = (views ?? []).map((v) => ({ id: v.id, name: v.name, views: num(v.views), add_to_cart: num(v.add_to_cart) }));
  }

  const govRows = govs.results ?? [];
  const sent = num(offers?.sent);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    range: { from: range.from, to: range.to, days: range.days, timezone: 'Asia/Baghdad' },
    ...(trafficBlock ? { traffic: trafficBlock } : {}),
    orders: {
      totals: {
        orders: orderCount,
        gross_iqd: gross,
        receivable_iqd: receivable,
        cancelled: num(cancelled?.n),
        // An average over no orders is not 0; it is absent.
        ...(orderCount ? { average_order_iqd: Math.round(gross / orderCount) } : {}),
      },
      series: orderSeries,
    },
    ...(funnel ? { funnel } : {}),
    products: {
      top: (top.results ?? []).map((t) => ({
        id: t.id,
        name: t.name ?? '',
        units: num(t.units),
        revenue_iqd: num(t.revenue),
        orders: num(t.orders),
      })),
      ...(leastViewed ? { least_viewed: leastViewed } : {}),
    },
    customers: {
      customers: num(customers?.customers),
      returning: num(customers?.returning_n),
      new: num(customers?.customers) - num(customers?.returning_n),
    },
    coupons: (coupons.results ?? []).map((k) => ({
      code: k.code,
      orders: num(k.orders),
      discount_iqd: num(k.discount),
      gross_iqd: num(k.gross),
      // The coupon's own row, when it still exists; its fields are absent otherwise.
      ...(k.coupon_id
        ? {
            coupon_id: k.coupon_id,
            used_count: num(k.used_count),
            max_uses: k.max_uses === null ? null : num(k.max_uses),
            ends_at: k.ends_at,
            active: !!k.active,
          }
        : {}),
    })),
    governorates: govRows.filter((g) => g.governorate).map((g) => ({ governorate: g.governorate, orders: num(g.orders), gross_iqd: num(g.gross) })),
    ...(govRows.some((g) => !g.governorate)
      ? { governorates_unspecified: govRows.filter((g) => !g.governorate).reduce((s, g) => s + num(g.orders), 0) }
      : {}),
    requests: {
      matched: num(matches?.matched),
      notified: num(matches?.notified),
      offers_sent: sent,
      offers_accepted: num(offers?.accepted),
      ...(sent ? { win_rate_percent: Math.round((num(offers?.accepted) / sent) * 100) } : {}),
      custom_orders_completed: num(custom?.completed),
      custom_orders_receivable_iqd: num(custom?.receivable),
    },
  });
});
