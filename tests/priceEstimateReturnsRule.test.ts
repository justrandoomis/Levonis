/**
 * THE SHARED RULE BEHIND «ما دفعه فعلاً» FOR A LINE SETTLED AT ITS OWN FINAL
 * PRICE (worker/lib/paidNet.ts `estimateLineAdjustments`; docs/SMART_PRICING.md
 * §6.9; migration 0218; review finding orders-1). Return refunds, trade-in and
 * price protection all read each line's accepted price adjustment from it:
 *
 *   - an approved line keeps its own (final − estimate) × qty;
 *   - only the remainder of `price_adjustment_iqd` (an edited total, a later
 *     ordinary proposal) is spread by net goods;
 *   - confirmed finals count only when they net to zero (no money moved);
 *   - the lines never add up to more goods than the order kept, and no line
 *     goes below zero;
 *   - with nothing that counts, the shared spread stands exactly as before.
 *
 * Run: node --import tsx --test tests/priceEstimateReturnsRule.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateLineAdjustments, type EstimateLineFact } from '../worker/lib/paidNet';
import { calculateGoods, type GoodsLine } from '../worker/lib/orderProfit';

test('THE RULE: each line keeps its own shift, the remainder is spread, the kept goods are never exceeded', () => {
  const order = (adj: number) => ({ id: 'o', subtotal_iqd: 85000, shipping_iqd: 0, points_discount_iqd: 0, price_adjustment_iqd: adj });
  const line = (id: string, unit: number, extra: Partial<GoodsLine> = {}) =>
    ({
      id,
      order_id: 'o',
      product_id: `p_${id}`,
      qty: 1,
      unit_price_iqd: unit,
      line_total_iqd: unit,
      coupon_discount_iqd: 0,
      membership_discount_iqd: 0,
      bundle_parent_item_id: null,
      component_alloc_iqd: null,
      cost_iqd: null,
      ...extra,
    }) as GoodsLine;
  const items = [line('a', 45000), line('b', 40000)];
  const fact = (id: string, state: string, est: number, fin: number | null): EstimateLineFact => ({ order_item_id: id, state, qty: 1, estimate_unit_iqd: est, final_unit_iqd: fin });
  const goods = (o: Record<string, unknown>, list: GoodsLine[], own: Map<string, number>) =>
    calculateGoods(o, list, []).lines.map((l) => l.original_net_goods_iqd + own.get(l.id)!);

  // Approved +2,000 on A: A carries all of it.
  assert.deepEqual([...estimateLineAdjustments(order(2000), items, [fact('a', 'approved', 45000, 47000)])!], [['a', 2000], ['b', 0]]);
  // An edited total (+1,000 where the line said +2,000): A keeps +2,000 and the -1,000 remainder is spread by net goods.
  const edited = estimateLineAdjustments(order(1000), items, [fact('a', 'approved', 45000, 47000)])!;
  assert.deepEqual(goods(order(1000), items, edited), [46471, 39529]);
  // Confirmed finals that cancel out: each line its own.
  const cancelled = estimateLineAdjustments(order(0), items, [fact('a', 'confirmed', 45000, 46000), fact('b', 'confirmed', 40000, 39000)])!;
  assert.deepEqual([...cancelled], [['a', 1000], ['b', -1000]]);
  // Confirmed finals an edited total absorbed, records not settled, or no records: the shared spread stands.
  assert.equal(estimateLineAdjustments(order(0), items, [fact('a', 'confirmed', 45000, 47000)]), null);
  for (const st of ['open', 'proposed', 'rejected', 'void']) {
    assert.equal(estimateLineAdjustments(order(2000), items, [fact('a', st, 45000, st === 'open' ? null : 47000)]), null, st);
  }
  assert.equal(estimateLineAdjustments(order(2000), items, []), null);
  // A record on a bundle parent (never a unit of the order) moves nothing.
  const bundled = [line('k', 0), line('c1', 45000, { bundle_parent_item_id: 'k' }), line('c2', 40000, { bundle_parent_item_id: 'k' })];
  assert.equal(estimateLineAdjustments(order(2000), bundled, [fact('k', 'approved', 45000, 47000)]), null);

  // Past its own goods: A's 30,000 coupon and a -20,000 shift. A is worth nothing and B takes the rest of the cut;
  // the lines add up to exactly the goods calculateGoods says the order kept.
  const couponed = [line('a', 45000, { coupon_discount_iqd: 30000 }), line('b', 40000)];
  const cut = estimateLineAdjustments(order(-20000), couponed, [fact('a', 'approved', 45000, 25000)])!;
  const kept = calculateGoods(order(-20000), couponed, []).lines.reduce((sum, l) => sum + l.net_goods_iqd, 0);
  assert.equal(kept, 35000);
  assert.deepEqual(goods(order(-20000), couponed, cut), [0, 35000]);
});
