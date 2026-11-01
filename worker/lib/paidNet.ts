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
 *   adjustment   the accepted price adjustment's share (`calculateGoods`); a
 *                line settled at its own final price (0218) carries its own
 *                final − estimate (`estimateLineAdjustments`)
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
import { HttpError } from './http';
import { paidNetPerUnit, splitExact, type PaidNetLineFacts, type PaidNetOrderFacts } from '../../packages/pricing/src/paidNet';
import { estimateServerMessage } from '../../packages/contracts/src/priceEstimates';

type Row = Record<string, unknown>;

export interface OrderPaidNet {
  order: PaidNetOrderFacts;
  lines: PaidNetLineFacts[];
}

// ------------------------------------------------------------- estimated lines (0218)

/** One line's estimate record (migration 0218): customer prices only. */
export interface EstimateLineFact {
  order_item_id: string;
  state: string;
  qty: number;
  estimate_unit_iqd: number;
  final_unit_iqd: number | null;
}

/** The two states that settle an estimate line: confirmed by the shop, or approved by the customer. */
const SETTLED_ESTIMATE: ReadonlySet<string> = new Set(['confirmed', 'approved']);

/** A settled line with its final price. */
export const isSettledEstimate = (e: EstimateLineFact): boolean =>
  SETTLED_ESTIMATE.has(e.state) && typeof e.final_unit_iqd === 'number' && Number.isSafeInteger(e.final_unit_iqd);

/** A settled line's own (final − estimate) × qty. */
const ownShift = (e: EstimateLineFact): number =>
  (Number(e.final_unit_iqd) - Math.trunc(Number(e.estimate_unit_iqd) || 0)) * Math.max(1, Math.trunc(Number(e.qty) || 1));

const MISSING_ESTIMATES = /no such table:?\s*(?:main\.)?order_price_estimates\b/i;

/**
 * The estimate records of these orders, by order id, or 'unreadable'. A
 * database without 0218 has none. Any other failure is 'unreadable': money is
 * never decided on a guess about whether a price was an estimate.
 */
export async function estimateFactsOf(
  db: Pick<D1Database, 'prepare'>,
  orderIds: readonly string[]
): Promise<Map<string, EstimateLineFact[]> | 'unreadable'> {
  const ids = [...new Set(orderIds.filter((x) => typeof x === 'string' && x !== ''))];
  const out = new Map<string, EstimateLineFact[]>();
  if (!ids.length) return out;
  try {
    const { results } = await db
      .prepare(
        `SELECT order_id, order_item_id, state, qty, estimate_unit_iqd, final_unit_iqd
           FROM order_price_estimates WHERE order_id IN (SELECT value FROM json_each(?1))`
      )
      .bind(JSON.stringify(ids))
      .all<EstimateLineFact & { order_id: string }>();
    for (const r of results ?? []) {
      const key = String(r.order_id);
      const list = out.get(key) ?? [];
      list.push({
        order_item_id: String(r.order_item_id),
        state: String(r.state),
        qty: Number(r.qty),
        estimate_unit_iqd: Number(r.estimate_unit_iqd),
        final_unit_iqd: r.final_unit_iqd === null || r.final_unit_iqd === undefined ? null : Number(r.final_unit_iqd),
      });
      out.set(key, list);
    }
    return out;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (MISSING_ESTIMATES.test(message)) return out;
    // Traceable to its orders: how many, and the first few ids. Never a figure or a customer's data.
    console.error('paid net: estimate records unreadable', ids.length, ids.slice(0, 5), message);
    return 'unreadable';
  }
}

/** 503 PRICE_ESTIMATES_READ_FAILED: the estimate records could not be read, so the door refuses. Nothing was written. */
export const estimatesUnreadable = (): HttpError =>
  new HttpError(503, estimateServerMessage('PRICE_ESTIMATES_READ_FAILED'), 'PRICE_ESTIMATES_READ_FAILED');

/**
 * The settled lines' own (final − estimate) × qty that count, by order item.
 * An approved line's always counts: the customer approved that money. Lines
 * confirmed at finals that cancel out (no money moved) count too. Confirmed
 * shifts that do not net to zero were absorbed by an edited total, so none of
 * them counts.
 */
export function ownEstimateShifts(estimates: readonly EstimateLineFact[]): Map<string, number> {
  const settled = estimates.filter(isSettledEstimate);
  const confirmedNet = settled.filter((e) => e.state === 'confirmed').reduce((s, e) => s + ownShift(e), 0);
  const out = new Map<string, number>();
  for (const e of settled) {
    if (e.state === 'confirmed' && confirmedNet !== 0) continue;
    const shift = ownShift(e);
    if (shift !== 0) out.set(String(e.order_item_id), shift);
  }
  return out;
}

/**
 * THE ESTIMATE SETTLEMENT ON ITS OWN LINES (0218; docs/SMART_PRICING.md §6.9):
 * each unit line's share of the accepted `price_adjustment_iqd`, signed.
 *
 * `calculateGoods` spreads that figure over every line by net goods. An
 * estimate settlement is not such a shared figure: each settled line moved by
 * its own (final − estimate) × qty (`ownEstimateShifts`). So the approved
 * shifts come out of the shared figure, only the remainder (an edited total, a
 * later ordinary proposal) is spread, and each line adds its own shift.
 *
 * The lines still add up to the goods `calculateGoods` says the order kept.
 * When a shift cut past its own line's goods, or the remainder past the
 * order's, those kept goods are placed exactly, weighted by each line's own
 * figure, so no line goes below zero and none gains what the order never took.
 *
 * Null when no line moves on its own: the shared spread stands, as before.
 */
export function estimateLineAdjustments(
  order: Row,
  items: GoodsLine[],
  estimates: readonly EstimateLineFact[]
): Map<string, number> | null {
  if (!estimates.length) return null;
  // Only a unit line can carry a shift (a bundle parent is no unit, as in calculateGoods).
  const parents = new Set(items.map((l) => l.bundle_parent_item_id).filter(Boolean));
  const units = new Set(items.filter((l) => !parents.has(l.id)).map((l) => String(l.id)));
  const onUnits = estimates.filter((e) => units.has(String(e.order_item_id)));
  const shifts = ownEstimateShifts(onUnits);
  if (!shifts.size) return null;
  const approved = onUnits.filter((e) => e.state === 'approved' && isSettledEstimate(e)).reduce((s, e) => s + ownShift(e), 0);
  const remainder = { ...order, price_adjustment_iqd: Math.trunc(Number(order.price_adjustment_iqd) || 0) - approved };
  const own = calculateGoods(remainder, items, []).lines.map((l) => ({
    id: String(l.id),
    before: l.original_net_goods_iqd,
    adjustment: l.price_adjustment_iqd + (shifts.get(String(l.id)) ?? 0),
  }));
  const kept = calculateGoods(order, items, []).lines.reduce((s, l) => s + l.net_goods_iqd, 0);
  const holds = own.every((l) => l.before + l.adjustment >= 0) && own.reduce((s, l) => s + l.before + l.adjustment, 0) === kept;
  if (holds) return new Map(own.map((l) => [l.id, l.adjustment]));
  // A cut past a line's goods (or the order's): the kept goods, split by each line's own figure.
  const placed = splitExact(kept, own.map((l) => Math.max(0, l.before + l.adjustment)));
  return new Map(own.map((l, i) => [l.id, placed[i] - l.before]));
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
 * `estimates`: the order's estimate records (0218); none reads as before.
 * Null when the order's lines cannot be read consistently (a caller then asks
 * for a human review rather than guessing).
 */
export function paidNetFacts(
  order: Row,
  items: GoodsLine[],
  tradeInCredit: boolean,
  estimates: readonly EstimateLineFact[] = []
): OrderPaidNet | null {
  const goodsOnly = { ...order, points_discount_iqd: 0, price_adjustment_iqd: 0 };
  const member = calculateGoods(goodsOnly, items.map((line) => ({ ...line, coupon_discount_iqd: 0 })), []);
  // The same with each line's own coupon discount: a bundle parent's is spread
  // over its components exactly as its membership is, so a component carries
  // its share of the code that named its bundle.
  const discounted = calculateGoods(goodsOnly, items, []);
  const accepted = calculateGoods(order, items, []);
  const own = estimateLineAdjustments(order, items, estimates);
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
      price_adjustment_iqd: own ? (own.get(String(line.id)) ?? 0) : Math.trunc(Number(line.price_adjustment_iqd) || 0),
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
 * The facts of several orders in four reads (orders, their lines, their
 * estimate records, which of their coupons are trade-in credits), whatever
 * their number — the ids travel as one JSON parameter. `known`: estimate
 * records the caller already read (no read of them then). Unreadable estimate
 * records refuse with 503 PRICE_ESTIMATES_READ_FAILED.
 */
export async function loadOrdersPaidNet(
  db: Pick<D1Database, 'prepare'>,
  orderIds: readonly string[],
  known?: ReadonlyMap<string, readonly EstimateLineFact[]>
): Promise<Map<string, OrderPaidNet>> {
  const ids = [...new Set(orderIds.filter((x) => typeof x === 'string' && x !== ''))];
  const out = new Map<string, OrderPaidNet>();
  if (!ids.length) return out;
  const json = JSON.stringify(ids);
  const [orders, items, estimates] = await Promise.all([
    db.prepare('SELECT * FROM orders WHERE id IN (SELECT value FROM json_each(?1))').bind(json).all<Row>(),
    db.prepare('SELECT * FROM order_items WHERE order_id IN (SELECT value FROM json_each(?1)) ORDER BY order_id, id').bind(json).all<GoodsLine>(),
    known ?? estimateFactsOf(db, ids),
  ]);
  if (estimates === 'unreadable') throw estimatesUnreadable();
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
    const facts = paidNetFacts(order, byOrder.get(id) ?? [], !!couponId && credits.has(couponId), estimates.get(id) ?? []);
    if (facts) out.set(id, facts);
  }
  return out;
}

/**
 * One unit of one line, or null when the order or the line cannot be read.
 * `estimates`: the order's estimate records when the caller already read them.
 */
export async function paidNetUnit(
  db: Pick<D1Database, 'prepare'>,
  orderId: string,
  itemId: string,
  estimates?: readonly EstimateLineFact[]
): Promise<{ unit: number; orderTotal: number } | null> {
  const facts = (await loadOrdersPaidNet(db, [orderId], estimates ? new Map([[orderId, estimates]]) : undefined)).get(orderId);
  if (!facts) return null;
  const unit = paidNetPerUnit(facts.order, facts.lines, itemId);
  return unit === null ? null : { unit, orderTotal: facts.order.total_iqd };
}
