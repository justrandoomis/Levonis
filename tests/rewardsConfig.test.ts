/**
 * THE REWARDS PROGRAMME'S TERMS, THE 'products' COUPON SCOPE AND THE WORDS
 * (migration 0220; docs/DECISIONS.md row 286).
 *
 *   · the stored terms are read tolerantly (a damaged row behaves like the
 *     owner's defaults, field by field) and written strictly (a typo is
 *     refused, never stored); the points shop never sells without a price;
 *   · the filament coupon's list scope names exactly the listed products and
 *     FAILS CLOSED on an empty list — it can never widen to the catalogue;
 *   · every notice exists in Arabic, English and Sorani, the Sorani never a
 *     copy of the Arabic (DECISIONS row 183).
 *
 * Run: node --import tsx --test tests/rewardsConfig.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateCoupon, couponMatchesLine, type CouponLine, type CouponRule } from '@levonis/pricing/coupons';
import { couponRuleOf } from '../worker/lib/couponLines';
import { REWARD_PROGRAM_DEFAULT, normalizeRewardConfig, validateRewardConfig } from '../worker/lib/rewards/config';
import { termsFor } from '../worker/lib/rewards/coupons';
import { rewardText } from '../worker/lib/rewards/strings';

const valid = () => ({
  enabled: true,
  valid_days: 7,
  weekly: { enabled: true, months: 12 },
  free_shipping: { enabled: true, amount_iqd: 5_000, min_order_iqd: 100_000 },
  filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: [] as string[], max_pieces: 1 },
  shop: { free_shipping: { enabled: false, points: null as number | null }, filament_discount: { enabled: false, points: null as number | null } },
});

test('the defaults are the owner’s answers: every week for 12 months, 5,000 off the delivery over 100,000, 15% off one piece of FDM filament, no shop price invented', () => {
  const d = normalizeRewardConfig(null);
  assert.deepEqual(d, REWARD_PROGRAM_DEFAULT);
  assert.equal(d.valid_days, 7);
  assert.deepEqual(d.weekly, { enabled: true, months: 12 });
  assert.deepEqual(d.free_shipping, { enabled: true, amount_iqd: 5_000, min_order_iqd: 100_000 });
  assert.deepEqual(d.filament, { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: [], max_pieces: 1 });
  assert.deepEqual(d.shop.free_shipping, { enabled: false, points: null });
  assert.deepEqual(d.shop.filament_discount, { enabled: false, points: null });
});

test('a damaged stored row behaves like the defaults, field by field, and a priceless shop item is never on sale', () => {
  const n = normalizeRewardConfig(
    JSON.stringify({
      enabled: 'yes',
      valid_days: -3,
      filament: { percent: 400, max_discount_iqd: 'lots', product_ids: ['p_ok', 'bad id!', 'p_ok', 7] },
      shop: { free_shipping: { enabled: true, points: null }, filament_discount: { enabled: true, points: 9000 } },
    })
  );
  assert.equal(n.enabled, true);
  assert.equal(n.valid_days, 7);
  assert.equal(n.filament.percent, 15);
  assert.equal(n.filament.max_discount_iqd, 25_000);
  assert.deepEqual(n.filament.product_ids, ['p_ok']);
  assert.deepEqual(n.shop.free_shipping, { enabled: false, points: null });
  assert.deepEqual(n.shop.filament_discount, { enabled: true, points: 9000 });
  assert.deepEqual(normalizeRewardConfig('not json'), REWARD_PROGRAM_DEFAULT);
});

test('a row saved before the weekly coupons reads the owner’s new terms, and keeps the choices it made', () => {
  const n = normalizeRewardConfig(JSON.stringify({ valid_days: 10, free_shipping: { enabled: false }, filament: { enabled: true, percent: 20, max_discount_iqd: 9_000, product_ids: ['p_ok'] } }));
  assert.deepEqual(n.weekly, { enabled: true, months: 12 });
  assert.deepEqual(n.free_shipping, { enabled: false, amount_iqd: 5_000, min_order_iqd: 100_000 });
  assert.deepEqual(n.filament, { enabled: true, percent: 20, max_discount_iqd: 9_000, product_ids: ['p_ok'], max_pieces: 1 });
  assert.equal(n.valid_days, 10);
  const damaged = normalizeRewardConfig(JSON.stringify({ weekly: { enabled: 'yes', months: 0 }, free_shipping: { amount_iqd: -1, min_order_iqd: 'x' }, filament: { max_pieces: 0 } }));
  assert.deepEqual(damaged.weekly, { enabled: true, months: 12 });
  assert.deepEqual([damaged.free_shipping.amount_iqd, damaged.free_shipping.min_order_iqd, damaged.filament.max_pieces], [5_000, 100_000, 1]);
  assert.equal(normalizeRewardConfig({ free_shipping: { min_order_iqd: 0 } }).free_shipping.min_order_iqd, 0, 'no minimum is the owner’s to choose');
});

test('the owner’s write is strict: each malformed field is refused with a reason', () => {
  assert.equal(validateRewardConfig(valid()).ok, true);
  const bad: Array<[unknown, RegExp]> = [
    [null, /object/],
    [{ ...valid(), enabled: 1 }, /enabled/],
    [{ ...valid(), valid_days: 0 }, /valid_days/],
    [{ ...valid(), valid_days: 91 }, /valid_days/],
    [{ ...valid(), weekly: { enabled: 1, months: 12 } }, /weekly\.enabled/],
    [{ ...valid(), weekly: { enabled: true, months: 0 } }, /weekly\.months/],
    [{ ...valid(), free_shipping: { ...valid().free_shipping, amount_iqd: 0 } }, /amount_iqd/],
    [{ ...valid(), free_shipping: { ...valid().free_shipping, min_order_iqd: -1 } }, /min_order_iqd/],
    [{ ...valid(), filament: { ...valid().filament, max_pieces: 0 } }, /max_pieces/],
    [{ ...valid(), filament: { ...valid().filament, percent: 0 } }, /percent/],
    [{ ...valid(), filament: { ...valid().filament, percent: 101 } }, /percent/],
    [{ ...valid(), filament: { ...valid().filament, max_discount_iqd: -5 } }, /max_discount_iqd/],
    [{ ...valid(), filament: { ...valid().filament, product_ids: ['ok', 'not ok!'] } }, /product_ids/],
    [{ ...valid(), shop: { ...valid().shop, free_shipping: { enabled: true, points: null } } }, /without a price/],
    [{ ...valid(), shop: { ...valid().shop, filament_discount: { enabled: false, points: 0 } } }, /points/],
  ];
  for (const [raw, why] of bad) {
    const r = validateRewardConfig(raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    if (!r.ok) assert.match(r.error, why);
  }
});

test('the coupon terms each grant freezes: an amount off the delivery, or a percentage of one piece on the ticked list or the FDM section', () => {
  const cfg = normalizeRewardConfig(null);
  const ship = termsFor('free_shipping', cfg);
  assert.deepEqual([ship.applies_to, ship.coupon_kind, ship.value, ship.min_total_iqd, ship.scope], ['delivery', 'fixed_iqd', 5_000, 100_000, 'global']);
  const section = termsFor('filament_discount', cfg);
  assert.deepEqual([section.coupon_kind, section.value, section.max_quantity], ['percent', 15, 1]);
  assert.deepEqual([section.scope, section.category_id, section.stacks], ['category', 'cat_materials_fdm', false]);
  const listed = termsFor('filament_discount', normalizeRewardConfig({ filament: { product_ids: ['p1', 'p2'] } }));
  assert.deepEqual([listed.scope, listed.product_ids, listed.category_id], ['products', ['p1', 'p2'], null]);
});

const LINE = (id: string, product: string, unit: number): CouponLine => ({
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
  qty: 1,
  unit_goods_iqd: unit,
  already_discounted: false,
});

test("the 'products' scope names exactly its list, and an empty list names nothing — it never widens", () => {
  const rule = couponRuleOf({ scope: 'products', product_ids: '["p_pla","p_petg"]', kind: 'percent', value: 15, max_discount_iqd: 25_000 });
  assert.deepEqual(rule.product_ids, ['p_pla', 'p_petg']);
  const ctx = { delivery_method: null, delivery_iqd: 0 };
  const lines = [LINE('a', 'p_pla', 30_000), LINE('b', 'p_printer', 900_000), LINE('c', 'p_petg', 40_000)];
  assert.equal(couponMatchesLine(rule, lines[0], ctx), true);
  assert.equal(couponMatchesLine(rule, lines[1], ctx), false);
  const out = allocateCoupon(rule, lines, ctx);
  assert.equal(out.merchandise_iqd, 4_500 + 6_000, '15% of the two filaments only');
  assert.deepEqual(out.matched_line_ids, ['a', 'c']);

  const capped = allocateCoupon({ ...rule, max_discount_iqd: 5_000 } as CouponRule, lines, ctx);
  assert.equal(capped.merchandise_iqd, 5_000, 'the ceiling holds for the whole order');

  const empty = couponRuleOf({ scope: 'products', product_ids: '[]', kind: 'percent', value: 15 });
  assert.equal(allocateCoupon(empty, lines, ctx).total_iqd, 0);
  const missingColumn = couponRuleOf({ scope: 'products', kind: 'percent', value: 15 });
  assert.deepEqual(missingColumn.product_ids, []);
  assert.equal(allocateCoupon(missingColumn, lines, ctx).total_iqd, 0, 'a database without the column cannot widen either');
});

test('every notice is written in three languages, the Sorani never a copy of the Arabic', () => {
  const title = { ar: 'أجمل طبعة', en: 'Best print', ckb: 'جوانترین چاپ' };
  const terms = { percent: 15, amount: 5_000, min: 100_000, pieces: 1 };
  const all = [
    rewardText({ kind: 'printer_coupons', count: 1, until: '2026-11-10', ...terms, kinds: ['free_shipping', 'filament_discount'] }),
    rewardText({ kind: 'printer_coupons', count: 3, until: '2026-11-10', ...terms, kinds: ['free_shipping', 'filament_discount'] }),
    rewardText({ kind: 'printer_coupons', count: 1, until: '2026-11-10', ...terms, kinds: ['free_shipping'] }),
    rewardText({ kind: 'printer_coupons', count: 1, until: '2026-11-10', ...terms, kinds: ['filament_discount'] }),
    rewardText({ kind: 'weekly_coupons', until: '2026-11-10', ...terms, kinds: ['free_shipping', 'filament_discount'] }),
    rewardText({ kind: 'weekly_coupons', until: '2026-11-10', ...terms, kinds: ['free_shipping'] }),
    rewardText({ kind: 'coupons_expiring', count: 1, until: '2026-11-10' }),
    rewardText({ kind: 'coupons_expiring', count: 2, until: '2026-11-10' }),
    rewardText({ kind: 'competition_won', title, place: 1, points: 500 }),
    rewardText({ kind: 'competition_won', title, place: 2, points: 0 }),
    rewardText({ kind: 'competition_refund', title, points: 200 }),
  ];
  for (const t of all) {
    for (const part of [t.title, t.body]) {
      assert.ok(part.ar && part.en && part.ckb, JSON.stringify(part));
      assert.notEqual(part.ckb, part.ar);
      assert.doesNotMatch(part.ar, /undefined|NaN/);
      assert.doesNotMatch(part.ckb, /undefined|NaN/);
    }
  }
  assert.match(all[0].body.ar, /15%/);
  assert.match(all[0].body.ar, /2026-11-10/);
  assert.match(all[0].body.ar, /5,000 د\.ع/);
  assert.match(all[0].body.ar, /100,000 د\.ع/);
  assert.match(all[4].body.en, /all on one order/);
  assert.match(all[8].body.en, /500 points/);
});
