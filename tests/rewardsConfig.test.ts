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
  free_shipping: { enabled: true },
  filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: [] as string[] },
  shop: { free_shipping: { enabled: false, points: null as number | null }, filament_discount: { enabled: false, points: null as number | null } },
});

test('the defaults are the owner’s answers: 7 days, 15% up to 25,000 IQD on FDM filament, no shop price invented', () => {
  const d = normalizeRewardConfig(null);
  assert.deepEqual(d, REWARD_PROGRAM_DEFAULT);
  assert.equal(d.valid_days, 7);
  assert.deepEqual(d.filament, { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: [] });
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

test('the owner’s write is strict: each malformed field is refused with a reason', () => {
  assert.equal(validateRewardConfig(valid()).ok, true);
  const bad: Array<[unknown, RegExp]> = [
    [null, /object/],
    [{ ...valid(), enabled: 1 }, /enabled/],
    [{ ...valid(), valid_days: 0 }, /valid_days/],
    [{ ...valid(), valid_days: 91 }, /valid_days/],
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

test('the coupon terms each grant freezes: the delivery in full, or the percentage on the ticked list or the FDM section', () => {
  const cfg = normalizeRewardConfig(null);
  assert.deepEqual(
    [termsFor('free_shipping', cfg).applies_to, termsFor('free_shipping', cfg).percent, termsFor('free_shipping', cfg).scope],
    ['delivery', 100, 'global']
  );
  const section = termsFor('filament_discount', cfg);
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
  const all = [
    rewardText({ kind: 'printer_coupons', count: 1, until: '2026-11-10', percent: 15, kinds: ['free_shipping', 'filament_discount'] }),
    rewardText({ kind: 'printer_coupons', count: 3, until: '2026-11-10', percent: 15, kinds: ['free_shipping', 'filament_discount'] }),
    rewardText({ kind: 'printer_coupons', count: 1, until: '2026-11-10', percent: 15, kinds: ['free_shipping'] }),
    rewardText({ kind: 'printer_coupons', count: 1, until: '2026-11-10', percent: 15, kinds: ['filament_discount'] }),
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
  assert.match(all[6].body.en, /500 points/);
});
