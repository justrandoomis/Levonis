/**
 * THE FACTS BEHIND «ما دفعه فعلاً», read the way checkout froze them, for the
 * one rule in packages/pricing/src/paidNet.ts (Services V2 plan §3.2).
 *
 * Price protection (worker/routes/returns.ts) and trade-in
 * (worker/lib/tradeIn.ts) both read a unit's paid net from here, so the same
 * unit is never worth one figure to one service and another to the next:
 *
 *   merchandise  `unitMerchandiseIqd` × qty — the applied price, without the
 *                warranty fee or the transport commission (a bundle
 *                component: its stored allocation)
 *   membership   the frozen line membership, as the finance report reads it
 *                (`calculateGoods` with the coupon and points left out)
 *   own discount `order_items.coupon_discount_iqd` (written by checkout since
 *                S-P0a: the goods part of a coupon, on the lines it named)
 *   order shares the coupon residual and the points, by gross over
 *                subtotal + delivery
 *   adjustment   the accepted price adjustment's share (`calculateGoods`)
 *
 * The order's coupon is read from its snapshot. When that coupon is a trade-in
 * credit (`coupons.trade_in_id`), it is payment in kind (owner decision 5): it
 * is not subtracted, and what was paid may reach the total plus the credit.
 *
 * Reads only. Every caller decides inside its own write batch.
 */
import { calculateGoods, type GoodsLine } from './orderProfit';
import { unitMerchandiseIqd } from './pointsOps';
import { safeParse } from './types';
import { paidNetPerUnit, type PaidNetLineFacts, type PaidNetOrderFacts } from '../../packages/pricing/src/paidNet';

type Row = Record<string, unknown>;

export interface OrderPaidNet {
  order: PaidNetOrderFacts;
  lines: PaidNetLineFacts[];
}

/**
 * The order-level coupon checkout froze: its id, the dinars it took, and the
 * part of them that came off the DELIVERY fee (a delivery code, frozen in the
 * snapshot since Services V2 S-P0a; 0 on an older order). The delivery part is
 * no unit's price, so it is never shared onto a line.
 */
export function orderCoupon(order: Row): { couponId: string | null; discountIqd: number; deliveryIqd: number } {
  const snap = safeParse<{ coupon_id?: unknown; discount_iqd?: unknown; delivery_iqd?: unknown } | null>(order.coupon_snapshot as string | null, null);
  const discountIqd = snap ? Math.max(0, Math.trunc(Number(snap.discount_iqd) || 0)) : 0;
  return {
    couponId: snap && typeof snap.coupon_id === 'string' && snap.coupon_id ? snap.coupon_id : null,
    discountIqd,
    deliveryIqd: snap ? Math.min(discountIqd, Math.max(0, Math.trunc(Number(snap.delivery_iqd) || 0))) : 0,
  };
}

/**
 * One order's facts. `tradeInCredit`: the order's coupon is a trade-in credit.
 * Null when the order's lines cannot be read consistently (a caller then asks
 * for a human review rather than guessing).
 */
export function paidNetFacts(order: Row, items: GoodsLine[], tradeInCredit: boolean): OrderPaidNet | null {
  const goodsOnly = { ...order, points_discount_iqd: 0, price_adjustment_iqd: 0 };
  const member = calculateGoods(goodsOnly, items.map((line) => ({ ...line, coupon_discount_iqd: 0 })), []);
  // The same with each line's own coupon discount: a bundle parent's is spread
  // over its components exactly as its membership is, so a component carries
  // its share of the code that named its bundle.
  const discounted = calculateGoods(goodsOnly, items, []);
  const accepted = calculateGoods(order, items, []);
  const lines: PaidNetLineFacts[] = [];
  for (const line of accepted.lines) {
    const qty = Math.max(1, Number(line.qty) || 1);
    const allocation = line.component_alloc_iqd === null || line.component_alloc_iqd === undefined ? null : Number(line.component_alloc_iqd);
    const merchandise =
      allocation ??
      unitMerchandiseIqd({
        qty,
        unit_price_iqd: Number(line.unit_price_iqd) || 0,
        pricing_snapshot: line.pricing_snapshot as string | null,
        warranty_snapshot: line.warranty_snapshot as string | null,
        transport_snapshot: line.transport_snapshot as string | null,
      }) * qty;
    const gross = allocation ?? (Number(line.unit_price_iqd) || 0) * qty;
    const memberLine = member.lines.find((v) => v.id === line.id);
    const discountedLine = discounted.lines.find((v) => v.id === line.id);
    if (!memberLine || !discountedLine) return null;
    lines.push({
      id: String(line.id),
      qty,
      gross_iqd: gross,
      merchandise_iqd: merchandise,
      membership_iqd: Math.max(0, gross - memberLine.net_goods_iqd),
      line_discount_iqd: Math.max(0, memberLine.net_goods_iqd - discountedLine.net_goods_iqd),
      price_adjustment_iqd: Math.trunc(Number(line.price_adjustment_iqd) || 0),
    });
  }
  const coupon = orderCoupon(order);
  return {
    order: {
      subtotal_iqd: Math.max(0, Math.trunc(Number(order.subtotal_iqd) || 0)),
      shipping_iqd: Math.max(0, Math.trunc(Number(order.shipping_iqd) || 0)),
      total_iqd: Math.max(0, Math.trunc(Number(order.total_iqd) || 0)),
      // The goods part only: the lines' own discounts come off it as the
      // residual inside paidNetLines; a delivery part is no unit's price.
      order_coupon_iqd: tradeInCredit ? 0 : coupon.discountIqd - coupon.deliveryIqd,
      points_iqd: Math.max(0, Math.trunc(Number(order.points_discount_iqd) || 0)),
      paid_in_kind_iqd: tradeInCredit ? coupon.discountIqd : 0,
    },
    lines,
  };
}

/**
 * The facts of several orders in three reads (orders, their lines, which of
 * their coupons are trade-in credits), whatever their number — the ids travel
 * as one JSON parameter.
 */
export async function loadOrdersPaidNet(db: D1Database, orderIds: readonly string[]): Promise<Map<string, OrderPaidNet>> {
  const ids = [...new Set(orderIds.filter((x) => typeof x === 'string' && x !== ''))];
  const out = new Map<string, OrderPaidNet>();
  if (!ids.length) return out;
  const json = JSON.stringify(ids);
  const [orders, items] = await Promise.all([
    db.prepare('SELECT * FROM orders WHERE id IN (SELECT value FROM json_each(?1))').bind(json).all<Row>(),
    db.prepare('SELECT * FROM order_items WHERE order_id IN (SELECT value FROM json_each(?1)) ORDER BY order_id, id').bind(json).all<GoodsLine>(),
  ]);
  const couponIds = [...new Set((orders.results ?? []).map((o) => orderCoupon(o).couponId).filter((x): x is string => !!x))];
  const credits = new Set<string>();
  if (couponIds.length) {
    try {
      const { results } = await db
        .prepare('SELECT id FROM coupons WHERE id IN (SELECT value FROM json_each(?1)) AND trade_in_id IS NOT NULL')
        .bind(JSON.stringify(couponIds))
        .all<{ id: string }>();
      for (const r of results ?? []) credits.add(r.id);
    } catch (e) {
      // A database without trade-in credits (before 0143) has none to count as paid.
      if (!/no such column/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
  const byOrder = new Map<string, GoodsLine[]>();
  for (const line of items.results ?? []) {
    const key = String(line.order_id);
    const list = byOrder.get(key) ?? [];
    list.push(line);
    byOrder.set(key, list);
  }
  for (const order of orders.results ?? []) {
    const id = String(order.id);
    const couponId = orderCoupon(order).couponId;
    const facts = paidNetFacts(order, byOrder.get(id) ?? [], !!couponId && credits.has(couponId));
    if (facts) out.set(id, facts);
  }
  return out;
}

/** One unit of one line, or null when the order or the line cannot be read. */
export async function paidNetUnit(db: D1Database, orderId: string, itemId: string): Promise<{ unit: number; orderTotal: number } | null> {
  const facts = (await loadOrdersPaidNet(db, [orderId])).get(orderId);
  if (!facts) return null;
  const unit = paidNetPerUnit(facts.order, facts.lines, itemId);
  return unit === null ? null : { unit, orderTotal: facts.order.total_iqd };
}
