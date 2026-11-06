/**
 * WHAT EACH COUPON DOES HERE (DECISIONS row 298): `couponPoolFacts`, the pure helper the
 * cart's rows read. It decides no money of its own: the coupons' takes must add up to
 * `allocateCouponPool`'s, and each coupon that takes nothing must say why.
 *
 * Run: node --import tsx --test tests/couponPoolFacts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateCouponPool, couponPoolFacts, couponPoolOffer, type CouponLine, type PoolCoupon } from '@levonis/pricing/coupons';
import { orderLineBenefits, type BenefitRule } from '@levonis/pricing/membershipBenefits';
import { couponRuleOf } from '../worker/lib/couponLines';

const line = (id: string, product: string, unit: number, qty = 1, over: Partial<CouponLine> = {}): CouponLine => ({
  line_id: id,
  product_id: product,
  option_value_ids: [],
  color_id: '',
  brand_id: null,
  category_id: null,
  sub_category_id: null,
  ancestry: null,
  bundle_product_id: null,
  fulfillment_type: 'direct_sale',
  transport_method: '',
  qty,
  unit_goods_iqd: unit,
  already_discounted: false,
  ...over,
});

const ship = (id: string, over: Record<string, unknown> = {}): PoolCoupon => ({
  coupon_id: id,
  code: id.toUpperCase(),
  min_total_iqd: Number(over.min_total_iqd ?? 100_000),
  rule: couponRuleOf({ kind: 'fixed_iqd', value: 5_000, scope: 'global', applies_to: 'delivery', stacks: 1, ...over }),
});

const filament = (id: string, over: Record<string, unknown> = {}): PoolCoupon => ({
  coupon_id: id,
  code: id.toUpperCase(),
  min_total_iqd: 0,
  rule: couponRuleOf({ kind: 'percent', value: 15, max_discount_iqd: 25_000, cap_scope: 'per_order', max_quantity: 1, scope: 'products', product_ids: '["p_pla","p_petg"]', applies_to: 'merchandise', stacks: 0, ...over }),
});

const ctx = (fee: number) => ({ delivery_method: null, delivery_iqd: fee });
const PRINTER = line('printer', 'p_printer', 800_000);
const states = (out: ReturnType<typeof couponPoolFacts>) => out.facts.map((f) => [f.coupon_id, f.state, f.take_iqd]);

test('every coupon says what it takes, and the takes are the pool’s own sums', () => {
  const out = couponPoolFacts([filament('f1'), ship('s1'), filament('f2'), ship('s2')], [PRINTER, line('pla', 'p_pla', 30_000, 3)], ctx(12_000));
  assert.deepEqual(states(out), [['f1', 'applies', 4_500], ['s1', 'applies', 5_000], ['f2', 'applies', 4_500], ['s2', 'applies', 5_000]]);
  assert.equal(out.facts.reduce((s, f) => s + f.take_iqd, 0), out.allocation.total_iqd);
  assert.deepEqual(out.facts[0].lines, [{ line_id: 'pla', amount_iqd: 4_500 }], 'and on what line');
  assert.deepEqual(out.facts[1].lines, [], 'a delivery coupon lands on no line');
  assert.equal(out.code, 'F1', 'the first that takes something opens the pool');
  assert.equal(out.count, 4);
});

test('a delivery coupon: waiting, under its minimum, no fee left, or no line at all', () => {
  const pending = couponPoolFacts([ship('s1')], [PRINTER], ctx(0), { deliveryPending: true });
  assert.deepEqual(states(pending), [['s1', 'waiting', 0]], 'the fee is not known yet');
  assert.equal(pending.count, 1);
  assert.equal(pending.allocation.delivery_waiting, true);

  const short = couponPoolFacts([ship('s1')], [line('t', 'p_tool', 70_000)], ctx(5_000));
  assert.deepEqual(states(short), [['s1', 'min_not_met', 0]]);
  assert.equal(short.facts[0].short_of_iqd, 30_000);
  assert.equal(short.count, 0);

  const exact = couponPoolFacts([ship('s1')], [line('t', 'p_tool', 100_000)], ctx(5_000));
  assert.deepEqual(states(exact), [['s1', 'applies', 5_000]], 'the minimum itself clears');

  const used = couponPoolFacts([ship('s1'), ship('s2')], [PRINTER], ctx(5_000));
  assert.deepEqual(states(used), [['s1', 'applies', 5_000], ['s2', 'no_fee', 0]], 'the fee went to the first: the second stays for next order');

  const free = couponPoolFacts([ship('s1')], [PRINTER], ctx(0));
  assert.deepEqual(states(free), [['s1', 'no_fee', 0]], 'a delivery that came out free spends nothing');

  const none = couponPoolFacts([ship('s1', { min_total_iqd: 0 })], [], ctx(5_000));
  assert.deepEqual(states(none), [['s1', 'no_target', 0]], 'a gift-only order names no paid line');
});

test('a goods coupon: no line it names, or every piece it names already took a coupon', () => {
  const noLine = couponPoolFacts([filament('f1')], [PRINTER], ctx(0));
  assert.deepEqual(states(noLine), [['f1', 'no_target', 0]]);
  assert.equal(noLine.code, 'F1', 'with nothing that takes, the first coupon still names the pool');
  assert.equal(noLine.count, 0);

  const onOffer = couponPoolFacts([filament('f1')], [line('pla', 'p_pla', 30_000, 1, { already_discounted: true })], ctx(0));
  assert.deepEqual(states(onOffer), [['f1', 'on_offer', 0]], 'one discount per piece, and it says that is why');

  const pieces = couponPoolFacts([filament('f1'), filament('f2')], [line('pla', 'p_pla', 30_000, 1)], ctx(0));
  assert.deepEqual(states(pieces), [['f1', 'applies', 4_500], ['f2', 'no_piece', 0]], 'one piece, one coupon; the other stays');
});

test('the minimum is tested on the goods after the coupons, so a filament coupon can push a delivery coupon under it', () => {
  const out = couponPoolFacts([filament('f1'), ship('s1')], [line('pla', 'p_pla', 105_000)], ctx(5_000));
  assert.deepEqual(states(out), [['f1', 'applies', 15_750], ['s1', 'min_not_met', 0]]);
  assert.equal(out.facts[1].short_of_iqd, 100_000 - (105_000 - 15_750));
});

test('an empty pool has nothing to say', () => {
  const out = couponPoolFacts([], [PRINTER], ctx(5_000));
  assert.deepEqual(out.facts, []);
  assert.equal(out.code, null);
  assert.equal(out.count, 0);
});

// ------------------------------------------------------------ what a preview must not get wrong

test('a goods coupon kept off only by an offer says so: it is not «no such line»', () => {
  const offered = line('a', 'p_pla', 24_000, 1, { already_discounted: true });
  const other = line('b', 'p_other', 24_000);
  const on = (lines: CouponLine[]) => couponPoolFacts([filament('f1')], lines, ctx(0)).facts[0].state;
  assert.equal(on([offered]), 'on_offer');
  assert.equal(on([other]), 'no_target', 'a line it does not name');
  assert.equal(on([offered, other]), 'on_offer');
  assert.equal(couponPoolFacts([filament('f2', { stacks: 1 })], [offered], ctx(0)).facts[0].state, 'applies', 'minted to work on an offer');
});

test('a tie on price is decided by the shared name, never by the line id a door made up', () => {
  const cartDoor = [line('ci_b', 'p_pla', 24_000, 1, { tie_key: 'ci_b' }), line('ci_a', 'p_pla', 24_000, 1, { tie_key: 'ci_a' })];
  const quoteDoor = (x: string, y: string) => [line(x, 'p_pla', 24_000, 1, { tie_key: 'ci_a' }), line(y, 'p_pla', 24_000, 1, { tie_key: 'ci_b' })];
  assert.deepEqual(allocateCouponPool([filament('f1')], cartDoor, ctx(0)).lines.map((l) => l.line_id), ['ci_a'], 'the lowest shared name');
  for (const [x, y] of [['oi_z', 'oi_a'], ['oi_a', 'oi_z'], ['oi_m', 'oi_n']]) {
    assert.deepEqual(allocateCouponPool([filament('f1')], quoteDoor(x, y), ctx(0)).lines.map((l) => l.line_id), [x], 'the same line, whatever it is called today');
  }
  assert.equal(allocateCouponPool([filament('f1'), filament('f2')], cartDoor, ctx(0)).merchandise_iqd, 7_200);
  // No shared name: the line's own id, as before.
  assert.deepEqual(allocateCouponPool([filament('f1')], [line('b', 'p_pla', 24_000), line('a', 'p_pla', 24_000)], ctx(0)).lines.map((l) => l.line_id), ['a']);
});

const offerOn = (coupons: PoolCoupon[], lines: CouponLine[], goodsIqd: number, feeAt: (g: number) => number, pending = false) =>
  couponPoolOffer(coupons, lines, ctx(0), { goodsIqd, feeAt, deliveryPending: pending });
/** Free over 75,000, strictly: the owner's own line. */
const waived = (fee: number) => (goods: number) => (goods > 75_000 ? 0 : fee);

test('the coupon that would bring the fee back: 3,600 off 76,000 over a 75,000 line saves nothing, so it is not offered', () => {
  const o = offerOn([filament('f1')], [line('a', 'p_pla', 24_000), line('b', 'p_other', 52_000)], 76_000, waived(5_000));
  assert.deepEqual([o.fee_before_iqd, o.fee_after_iqd, o.fee_back_iqd, o.net_iqd, o.no_gain], [0, 5_000, 5_000, 0, true]);
  assert.deepEqual(o.facts.map((f) => [f.state, f.take_iqd, f.lines.length]), [['no_gain', 0, 0]]);
  assert.equal(o.count, 0, 'and spends nothing');
});

test('when it still saves, the customer is told what it saves: what it takes, less the fee it brings back', () => {
  const lines = [line('a', 'p_pla', 24_000, 2), line('b', 'p_other', 32_000)];
  const o = offerOn([filament('f1'), filament('f2')], lines, 80_000, waived(5_000));
  assert.deepEqual([o.allocation.total_iqd, o.fee_back_iqd, o.net_iqd, o.no_gain], [7_200, 5_000, 2_200, false]);
  assert.deepEqual(o.facts.map((f) => f.state), ['applies', 'applies']);
});

test('over the line either way nothing comes back; a delivery coupon draws on the fee the customer is really charged', () => {
  const stays = offerOn([filament('f1')], [line('a', 'p_pla', 24_000), line('b', 'p_other', 100_000)], 124_000, waived(5_000));
  assert.deepEqual([stays.fee_back_iqd, stays.net_iqd, stays.no_gain], [0, 3_600, false]);

  const free = offerOn([ship('s1')], [PRINTER], 800_000, waived(5_000));
  assert.deepEqual([free.facts[0].state, free.net_iqd], ['no_fee', 0], 'the member pays no fee: nothing for it to take');
  const paid = offerOn([ship('s1')], [PRINTER], 800_000, () => 5_000);
  assert.deepEqual([paid.facts[0].state, paid.net_iqd, paid.fee_back_iqd], ['applies', 5_000, 0]);
});

test('with the fee unknown nothing is worked out of it, and a waiting coupon still waits', () => {
  const o = offerOn([ship('s1')], [PRINTER], 800_000, () => { throw new Error('must not be asked'); }, true);
  assert.deepEqual([o.facts[0].state, o.fee_back_iqd, o.no_gain, o.count], ['waiting', 0, false, 1]);
});

test('a rule’s budget on a tie goes by the shared name at every door, and by the order given only without one', () => {
  const rule = { id: 'r', tier: 'pro', benefit_type: 'product_discount', scope: 'global', discount_mode: 'percent', percent: 10, fixed_iqd: null, max_discount_iqd: null, cap_scope: 'per_unit', max_quantity: 1, min_subtotal_iqd: null, free_shipping_threshold_iqd: null, shipping_methods: null, max_shipping_subsidy_iqd: null, cod_tax_exempt: false, enabled: true, starts_at: null, ends_at: null } as unknown as BenefitRule;
  const input = (tieKey?: string) => ({ regularUnitIqd: 30_000, qty: 1, rule, ...(tieKey ? { tieKey } : {}) });
  assert.deepEqual(orderLineBenefits([input('ci_b'), input('ci_a')]).map((l) => l.total_iqd), [0, 3_000], 'the lowest name takes it');
  assert.deepEqual(orderLineBenefits([input('ci_a'), input('ci_b')]).map((l) => l.total_iqd), [3_000, 0], 'the same line in either order');
  assert.deepEqual(orderLineBenefits([input(), input()]).map((l) => l.total_iqd), [3_000, 0], 'no name: the order given, as ever');
});
