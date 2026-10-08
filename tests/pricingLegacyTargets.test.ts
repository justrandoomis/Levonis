/**
 * ANSWER B, APPLIED — packages/pricing/src/legacyTargets.ts and its use on the
 * 41-product census fixture (MVP plan §6 P1; master plan v2 §2.5, C38, C39;
 * owner answer of 2026-10-07).
 *
 *   T_r = (item_r + fee_r) − C_r    P = P_dir − paid_base
 *
 * Pure vectors first (the B3 §29 example with a fee F, routes that disagree,
 * direct-only, pre-order-only, negative and off-step premiums, no cost, cost
 * less specific than price, placement, the round trip, determinism), then the
 * census fixture: its counts, today's prices equal to the cart's own line for
 * every model × channel × payment, and the statuses the census predicts.
 *
 * Run: node --import tsx --test tests/pricingLegacyTargets.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_TARGET_REASON_CODES,
  deriveLegacyTargets,
  worstTargetState,
  type LegacyModelInput,
  type LegacyProductResult,
  type LegacyRouteObservation,
} from '../packages/pricing/src/legacyTargets';
import { ceilStep } from '../packages/pricing/src/costToPrice';
import { resolveRuleAt } from '../packages/pricing/src/ruleResolution';
import { LEGACY_REASONS } from '../packages/contracts/src/pricingMigrationLabels';
import { asD1, count, freshDb } from './fixtures/app';
import { LEGACY_CENSUS, legacyOptionId, legacyProductId, seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { listPricedProducts, loadPreviewContext, loadProducts, loadRateReference } from '../worker/lib/pricingEngine/load';
import { evaluateProducts, type ProductEvaluation } from '../worker/lib/pricingEngine/compute';
import { resolveCartLine } from '../worker/routes/cart';

// ------------------------------------------------------------------ helpers

const obs = (item: number, fee: number, cost: number | null, price_rung: LegacyRouteObservation['price_rung'] = 'option', cost_rung: LegacyRouteObservation['cost_rung'] = 'option') => ({
  item_iqd: item,
  fee_iqd: fee,
  cost_iqd: cost,
  price_rung,
  cost_rung: cost === null ? null : cost_rung,
});
const route = (r: 'air' | 'sea' | 'land', item: number, fee: number, cost: number | null, pr?: LegacyRouteObservation['price_rung'], cr?: LegacyRouteObservation['cost_rung']): LegacyRouteObservation => ({
  route: r,
  ...obs(item, fee, cost, pr, cr),
});
const one = (model: LegacyModelInput, extra: Partial<Parameters<typeof deriveLegacyTargets>[0]> = {}) =>
  deriveLegacyTargets({ product_id: 'p', models: [model], ...extra });
const ruleAt = (res: LegacyProductResult, kind: 'target_profit' | 'direct_premium', optionId: string) =>
  resolveRuleAt(res.rules, kind, { product_id: res.product_id, option_value_ids: optionId ? [optionId] : [], color_id: null, ancestry: [] });

// ------------------------------------------------------------- B3 §29 with a fee F

test('B3 §29 with an air fee F: minimum profit = 915,000 + F − 765,000; premium = 965,000 − (915,000 + F)', () => {
  for (const F of [0, 20_000, 50_000]) {
    const res = one({ option_id: 'combo', direct: obs(965_000, 0, 765_000, 'fulfillment'), routes: [route('air', 915_000, F, 765_000)] });
    const m = res.models[0]!;
    assert.equal(m.target.state, 'MIGRATED');
    assert.equal(m.target.value_iqd, 150_000 + F, `F = ${F}`);
    assert.equal(m.premium.state, 'MIGRATED');
    assert.equal(m.premium.value_iqd, 50_000 - F);
    assert.equal(m.base_route, 'air');
    assert.equal(m.roundtrip_ok, true);
    // The fee is named as part of the old profit only when there is one.
    assert.deepEqual(m.target.reasons, F ? [{ code: 'ROUTE_FEE_INCLUDED', route: 'air', iqd: F }] : []);
    // Placed at product scope (one model), read back through E1's own resolution.
    const t = ruleAt(res, 'target_profit', 'combo');
    assert.ok(t.status === 'active' && t.amount_iqd === 150_000 + F && t.rule.scope === 'product');
  }
});

test('B3 §29 with F above the 50,000 premium: the premium goes negative and is held — never written below zero', () => {
  const res = one({ option_id: 'combo', direct: obs(965_000, 0, 765_000), routes: [route('air', 915_000, 60_000, 765_000)] });
  const m = res.models[0]!;
  assert.equal(m.target.value_iqd, 210_000);
  assert.equal(m.premium.state, 'DIRECT_PREMIUM_REVIEW_REQUIRED');
  assert.equal(m.premium.value_iqd, null);
  assert.deepEqual(m.premium.reasons.map((r) => r.code), ['LEGACY_DIRECT_BELOW_PREORDER']);
  // A BLOCKED premium marker, so nothing inherits a premium for this model.
  const p = ruleAt(res, 'direct_premium', 'combo');
  assert.equal(p.status, 'blocked');
});

// ------------------------------------------------------------- routes that disagree

test('two routes with different fees → CONFLICT, one candidate per route, never averaged; the premium is in conflict too', () => {
  const res = one({
    option_id: 'o',
    direct: obs(1_000_000, 0, 700_000),
    routes: [route('air', 900_000, 25_000, 700_000), route('land', 900_000, 15_000, 700_000)],
  });
  const m = res.models[0]!;
  assert.equal(m.target.state, 'CONFLICT');
  assert.equal(m.target.value_iqd, null);
  assert.ok(m.target.reasons.some((r) => r.code === 'TARGET_ROUTE_CONFLICT'));
  assert.deepEqual(
    m.target.candidates.map((c) => [c.route, c.value_iqd]),
    [
      ['air', 225_000],
      ['land', 215_000],
    ]
  );
  // No average (220,000) anywhere.
  assert.ok(!JSON.stringify(res).includes('220000'));
  assert.equal(m.premium.state, 'CONFLICT');
  assert.equal(ruleAt(res, 'target_profit', 'o').status, 'blocked');
});

test('two routes with the same old profit and the same paid price: migrated, and the premium needs no base route', () => {
  const res = one({ option_id: 'o', direct: obs(960_000, 0, 700_000), routes: [route('air', 900_000, 10_000, 700_000), route('land', 900_000, 10_000, 700_000)] });
  const m = res.models[0]!;
  assert.equal(m.target.value_iqd, 210_000);
  assert.equal(m.premium.value_iqd, 50_000);
  assert.equal(m.base_route, 'air');
});

test('the same old profit at different paid prices: the premium needs the owner’s base route (NO_BASE_ROUTE), then migrates', () => {
  const model: LegacyModelInput = {
    option_id: 'o',
    direct: obs(1_000_000, 0, 700_000),
    routes: [route('air', 900_000, 25_000, 725_000, 'option', 'transport'), route('land', 900_000, 15_000, 715_000, 'option', 'transport')],
  };
  const held = one(model).models[0]!;
  assert.equal(held.target.state, 'MIGRATED');
  assert.equal(held.target.value_iqd, 200_000);
  assert.equal(held.premium.state, 'DIRECT_PREMIUM_REVIEW_REQUIRED');
  assert.deepEqual(held.premium.reasons.map((r) => r.code), ['NO_BASE_ROUTE']);
  assert.deepEqual(held.premium.candidates.map((c) => [c.route, c.value_iqd]), [['air', 75_000], ['land', 85_000]]);
  const chosen = one(model, { base_route: { o: 'land' } }).models[0]!;
  assert.equal(chosen.premium.state, 'MIGRATED');
  assert.equal(chosen.premium.value_iqd, 85_000);
  assert.equal(chosen.roundtrip_ok, true);
});

// ------------------------------------------------------------- direct only, pre-order only

test('direct-only product (C39): premium 0 at product scope, target = P_dir − C_dir, PREMIUM_ZERO_DIRECT_ONLY', () => {
  const res = deriveLegacyTargets({
    product_id: 'p',
    models: [
      { option_id: 'a', direct: obs(150_000, 0, 120_000), routes: [] },
      { option_id: 'b', direct: obs(175_000, 0, 140_000), routes: [] },
    ],
  });
  assert.deepEqual(res.models.map((m) => [m.mix, m.target.value_iqd, m.premium.value_iqd]), [
    ['DIRECT_ONLY', 30_000, 0],
    ['DIRECT_ONLY', 35_000, 0],
  ]);
  assert.ok(res.models.every((m) => m.premium.reasons.some((r) => r.code === 'PREMIUM_ZERO_DIRECT_ONLY')));
  const premium = res.rules.filter((r) => r.kind === 'direct_premium');
  assert.deepEqual(premium.map((r) => [r.scope, r.amount_iqd, r.state]), [['product', 0, 'ACTIVE']]);
  // Models disagree on the target: each is placed at option scope, none at product scope.
  assert.deepEqual(
    res.rules.filter((r) => r.kind === 'target_profit').map((r) => [r.scope, r.scope_id, r.amount_iqd]),
    [
      ['option', 'a', 30_000],
      ['option', 'b', 35_000],
    ]
  );
  assert.ok(res.models.every((m) => m.roundtrip_ok === true));
});

test('a direct fee (the product’s scalar premium) is part of the direct-only old profit', () => {
  const m = one({ option_id: 'a', direct: obs(150_000, 20_000, 120_000), routes: [] }).models[0]!;
  assert.equal(m.target.value_iqd, 50_000);
});

test('pre-order-only: premium NOT_APPLICABLE and no premium rule', () => {
  const res = one({ option_id: 'a', direct: null, routes: [route('land', 500_000, 15_000, 400_000)] });
  const m = res.models[0]!;
  assert.equal(m.mix, 'PREORDER_ONLY');
  assert.equal(m.target.value_iqd, 115_000);
  assert.equal(m.premium.state, 'NOT_APPLICABLE');
  assert.equal(res.rules.filter((r) => r.kind === 'direct_premium').length, 0);
});

test('a mixed product: a direct-only model inherits the product premium, or is held when there is none', () => {
  const base = { option_id: 'both', direct: obs(560_000, 0, 400_000), routes: [route('land', 500_000, 10_000, 400_000)] };
  const res = deriveLegacyTargets({ product_id: 'p', models: [base, { option_id: 'direct', direct: obs(700_000, 0, 550_000), routes: [] }] });
  const [both, direct] = res.models;
  assert.equal(both!.premium.value_iqd, 50_000);
  assert.equal(direct!.target.value_iqd, 700_000 - 550_000 - 50_000);
  assert.equal(direct!.roundtrip_ok, true);
  const held = deriveLegacyTargets({
    product_id: 'p',
    models: [{ ...base, routes: [route('land', 500_000, 80_000, 400_000)] }, { option_id: 'direct', direct: obs(700_000, 0, 550_000), routes: [] }],
  });
  assert.equal(held.models[1]!.target.state, 'TARGET_PROFIT_REVIEW_REQUIRED');
  assert.deepEqual(held.models[1]!.target.reasons.map((r) => r.code), ['DIRECT_ONLY_PREMIUM_UNKNOWN']);
});

// ------------------------------------------------------------- premiums off the step

test('a premium off the 1,000 step is held, with the floor and the ceiling as candidates', () => {
  const m = one({ option_id: 'o', direct: obs(965_000, 0, 765_000), routes: [route('sea', 915_000, 4_500, 765_000)] }).models[0]!;
  assert.equal(m.target.value_iqd, 154_500);
  assert.equal(m.premium.state, 'DIRECT_PREMIUM_REVIEW_REQUIRED');
  assert.deepEqual(m.premium.reasons, [{ code: 'LEGACY_PREMIUM_NOT_ON_STEP', iqd: 45_500 }]);
  assert.deepEqual(m.premium.candidates.map((c) => [c.kind, c.value_iqd]), [['floor', 45_000], ['ceiling', 46_000]]);
  // A zero premium is a real value, not a missing one.
  const zero = one({ option_id: 'o', direct: obs(915_000, 0, 765_000), routes: [route('sea', 915_000, 0, 765_000)] }).models[0]!;
  assert.equal(zero.premium.state, 'MIGRATED');
  assert.equal(zero.premium.value_iqd, 0);
});

// ------------------------------------------------------------- guards

test('no cost → UNRESOLVED with a BLOCKED marker; zero cost, a sale at or below cost and a zero price → REVIEW; nothing clamped', () => {
  const none = one({ option_id: 'o', direct: obs(600_000, 0, null), routes: [route('land', 550_000, 15_000, null)] });
  assert.equal(none.models[0]!.target.state, 'TARGET_PROFIT_UNRESOLVED');
  assert.deepEqual(none.models[0]!.target.reasons.map((r) => r.code), ['MISSING_LEGACY_COST', 'ROUTE_FEE_INCLUDED']);
  assert.equal(ruleAt(none, 'target_profit', 'o').status, 'blocked');

  const zero = one({ option_id: 'o', direct: null, routes: [route('land', 550_000, 0, 0)] }).models[0]!;
  assert.deepEqual([zero.target.state, zero.target.reasons.map((r) => r.code)], ['TARGET_PROFIT_REVIEW_REQUIRED', ['LEGACY_COST_ZERO']]);

  const below = one({ option_id: 'o', direct: null, routes: [route('land', 500_000, 0, 500_000)] }).models[0]!;
  assert.deepEqual([below.target.state, below.target.reasons.map((r) => r.code)], ['TARGET_PROFIT_REVIEW_REQUIRED', ['LEGACY_SALE_NOT_ABOVE_COST']]);
  assert.equal(below.target.value_iqd, null);

  const free = one({ option_id: 'o', direct: null, routes: [route('land', 0, 0, 10_000)] }).models[0]!;
  assert.ok(free.target.reasons.some((r) => r.code === 'LEGACY_PRICE_ZERO'));
});

test('cost less specific than price: a model priced on its own but costed by the product is held — one model, or a colour, decide alike', () => {
  // Two models: the model's own price, the product's cost.
  const two = deriveLegacyTargets({
    product_id: 'p',
    models: [
      { option_id: 'a', direct: null, routes: [route('land', 900_000, 0, 700_000, 'option', 'option')] },
      { option_id: 'b', direct: null, routes: [route('land', 1_050_000, 0, 700_000, 'fulfillment', 'base')] },
    ],
  });
  assert.equal(two.models[0]!.target.state, 'MIGRATED');
  assert.equal(two.models[1]!.target.state, 'TARGET_PROFIT_REVIEW_REQUIRED');
  assert.deepEqual(two.models[1]!.target.reasons.map((r) => r.code), ['COST_LESS_SPECIFIC_THAN_PRICE']);
  // The candidate is still shown so the owner can take it.
  assert.deepEqual(two.models[1]!.target.candidates.map((c) => c.value_iqd), [350_000]);
  // One model: the model IS the product, so its own price over the product cost is fine.
  assert.equal(one({ option_id: 'a', direct: null, routes: [route('land', 900_000, 0, 700_000, 'fulfillment', 'base')] }).models[0]!.target.state, 'MIGRATED');
  // A colour price over a model cost is less specific at any count.
  assert.equal(one({ option_id: 'a', direct: null, routes: [route('land', 900_000, 0, 700_000, 'color', 'option')] }).models[0]!.target.state, 'TARGET_PROFIT_REVIEW_REQUIRED');
});

test('a stored SKU cost that differs from the ladder → CONFLICT (VARIANT_COST_CONFLICT)', () => {
  const m = one({ option_id: 'o', direct: null, routes: [route('land', 900_000, 0, 700_000)], variant_costs: [710_000] }).models[0]!;
  assert.equal(m.target.state, 'CONFLICT');
  assert.ok(m.target.reasons.some((r) => r.code === 'VARIANT_COST_CONFLICT'));
  assert.equal(one({ option_id: 'o', direct: null, routes: [route('land', 900_000, 0, 700_000)], variant_costs: [700_000] }).models[0]!.target.state, 'MIGRATED');
});

test('a model the store cannot sell today derives nothing and is left out of the placement', () => {
  const res = deriveLegacyTargets({
    product_id: 'p',
    models: [
      { option_id: 'a', direct: null, routes: [route('land', 900_000, 0, 700_000)] },
      { option_id: 'x', direct: null, routes: [] },
    ],
  });
  assert.equal(res.models[1]!.mix, 'NOT_SELLABLE');
  assert.deepEqual(res.models[1]!.target.reasons.map((r) => r.code), ['MODEL_NOT_SELLABLE']);
  assert.deepEqual(res.rules.map((r) => [r.kind, r.scope, r.scope_id]), [['target_profit', 'product', '']]);
});

// ------------------------------------------------------------- placement, round trip, determinism

test('placement: product scope when every model agrees, option scope otherwise; held models get BLOCKED markers', () => {
  const agree = deriveLegacyTargets({
    product_id: 'p',
    models: ['a', 'b', 'c'].map((id) => ({ option_id: id, direct: obs(960_000, 0, 700_000), routes: [route('land', 900_000, 10_000, 700_000)] })),
  });
  assert.deepEqual(agree.rules.map((r) => [r.kind, r.scope, r.amount_iqd]), [
    ['target_profit', 'product', 210_000],
    ['direct_premium', 'product', 50_000],
  ]);
  // B3 §3: base 700/900 and Combo 800/1,050 → 200,000 and 250,000, each on its model.
  const b3 = deriveLegacyTargets({
    product_id: 'p',
    models: [
      { option_id: 'base', direct: null, routes: [route('land', 900_000, 0, 700_000, 'option', 'option')] },
      { option_id: 'combo', direct: null, routes: [route('land', 1_050_000, 0, 800_000, 'option', 'option')] },
      { option_id: 'nocost', direct: null, routes: [route('land', 1_100_000, 0, null)] },
    ],
  });
  assert.deepEqual(b3.rules.map((r) => [r.scope, r.scope_id, r.state, r.amount_iqd]), [
    ['option', 'base', 'ACTIVE', 200_000],
    ['option', 'combo', 'ACTIVE', 250_000],
    ['option', 'nocost', 'BLOCKED', null],
  ]);
  for (const [id, want] of [['base', 200_000], ['combo', 250_000]] as const) {
    const t = ruleAt(b3, 'target_profit', id);
    assert.ok(t.status === 'active' && t.amount_iqd === want, id);
  }
  assert.equal(ruleAt(b3, 'target_profit', 'nocost').status, 'blocked');
});

test('the round trip, through E1: ceilStep(C_r + T) lands in [paid_r, paid_r + 999] and the direct price comes back, for a sweep of inputs', () => {
  let checked = 0;
  for (let cost = 101_000; cost < 2_000_000; cost += 137_771) {
    for (const fee of [0, 4_500, 15_000, 25_000]) {
      for (const markup of [1_000, 33_333, 150_000]) {
        const item = cost + markup;
        const direct = item + fee + 50_000;
        const res = one({ option_id: 'o', direct: obs(direct, 0, cost), routes: [route('land', item, fee, cost)] });
        const m = res.models[0]!;
        assert.equal(m.roundtrip_ok, true);
        const T = m.target.value_iqd!;
        assert.equal(T, item + fee - cost);
        const price = ceilStep(cost + T);
        assert.ok(price >= item + fee && price <= item + fee + 999);
        assert.ok(price + m.premium.value_iqd! >= direct && price + m.premium.value_iqd! <= direct + 999);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 100);
  // A held value is not checked (null), never reported as passing.
  assert.equal(one({ option_id: 'o', direct: null, routes: [route('land', 500, 0, null)] }).models[0]!.roundtrip_ok, null);
});

test('determinism: the same models in any order give the same values per model and the same rules', () => {
  const models: LegacyModelInput[] = [
    { option_id: 'a', direct: obs(960_000, 0, 700_000), routes: [route('land', 900_000, 10_000, 700_000)] },
    { option_id: 'b', direct: obs(1_100_000, 0, 820_000), routes: [route('land', 1_020_000, 10_000, 820_000), route('air', 1_020_000, 10_000, 820_000)] },
    { option_id: 'c', direct: null, routes: [route('sea', 300_000, 4_500, null)] },
    { option_id: 'd', direct: obs(400_000, 0, 300_000), routes: [] },
  ];
  const key = (r: LegacyProductResult) => ({
    models: [...r.models].sort((x, y) => x.option_id.localeCompare(y.option_id)),
    rules: [...r.rules].sort((x, y) => x.id.localeCompare(y.id)),
  });
  const first = key(deriveLegacyTargets({ product_id: 'p', models }));
  for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
    assert.deepEqual(key(deriveLegacyTargets({ product_id: 'p', models: order.map((i) => models[i]!) })), first);
  }
});

test('every reason the derivation raises is labelled in ar, en and ckb, with its severity', () => {
  for (const code of LEGACY_TARGET_REASON_CODES) assert.ok(code in LEGACY_REASONS, `${code} has no label`);
  assert.equal(worstTargetState(['MIGRATED', 'TARGET_PROFIT_UNRESOLVED', 'CONFLICT']), 'CONFLICT');
  assert.equal(worstTargetState([]), 'MIGRATED');
});

test('the input is checked: a model listed twice, a route twice, or a fractional price is a programming error', () => {
  assert.throws(() => deriveLegacyTargets({ product_id: 'p', models: [{ option_id: 'a', direct: null, routes: [] }, { option_id: 'a', direct: null, routes: [] }] }), /PRICING_INVARIANT/);
  assert.throws(() => one({ option_id: 'a', direct: null, routes: [route('air', 1, 0, null), route('air', 1, 0, null)] }), /PRICING_INVARIANT/);
  assert.throws(() => one({ option_id: 'a', direct: obs(100.5, 0, 10), routes: [] }), /PRICING_INVARIANT/);
});

// ------------------------------------------------------------- the census fixture

async function censusWorld() {
  const raw = freshDb();
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  const db = asD1(raw);
  const [refs, ctx, ref] = await Promise.all([listPricedProducts(db), loadPreviewContext(db), loadRateReference(db)]);
  const all = await evaluateProducts(db, refs.map((r) => r.id), ctx, ref);
  return { raw, db, ctx, all, bySlug: new Map(all.map((p) => [p.doc.slug, p] as const)) };
}
let world: ReturnType<typeof censusWorld> | null = null;
const census = () => (world ??= censusWorld());

test('the census fixture has the census shape: 41 products, 92 models, 89 + 79 cells, 80 routes, 35 surcharges, 28 fee products, 153 colours, 266 SKUs', async () => {
  const { raw } = await census();
  assert.equal(LEGACY_CENSUS.length, 41);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM products'), 41);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM product_option_values WHERE active = 1'), 92);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM product_option_fulfillment WHERE enabled = 1 AND fulfillment_type = 'direct_sale'"), 89);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM product_option_fulfillment WHERE enabled = 1 AND fulfillment_type = 'pre_order'"), 79);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM product_option_transports WHERE enabled = 1'), 80);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM product_option_transports WHERE enabled = 1 AND surcharge_iqd IS NOT NULL'), 35);
  assert.equal(
    count(raw, "SELECT COUNT(DISTINCT p.id) n FROM products p LEFT JOIN product_option_transports t ON t.product_id = p.id AND t.enabled = 1 AND t.surcharge_iqd IS NOT NULL WHERE t.id IS NOT NULL OR p.preorder_transports <> '[]'"),
    28
  );
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM product_colors'), 153);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM product_variants'), 266);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM products WHERE product_cost_iqd IS NOT NULL'), 34);
});

test('today’s price is the cart’s own line: every model × channel × payment of the 41 products equals resolveCartLine', async () => {
  const { db, ctx, all } = await census();
  const loaded = await loadProducts(db, all.map((p) => p.id));
  let lines = 0;
  for (const p of all) {
    const { row, view } = loaded.get(p.id)!;
    for (const m of p.models) {
      for (const c of m.channels) {
        for (const payment of ['prepaid', 'cod'] as const) {
          const cart = resolveCartLine(
            row,
            { optionId: m.option_id, colorId: '', transportMethod: c.route ?? '', fulfillmentType: c.route ? 'pre_order' : 'direct_sale', warrantyPlanId: '', optionValueIds: m.option_id ? [m.option_id] : [] },
            'free',
            false,
            ctx,
            view,
            payment
          ).resolved;
          assert.equal(cart.errors.length === 0, c.ok, `${p.doc.slug} ${c.channel}`);
          if (!c.ok) continue;
          assert.equal(payment === 'prepaid' ? c.prepaid_iqd : c.cod_iqd, cart.unit_subtotal_iqd, `${p.doc.slug} ${m.option_id} ${c.channel} ${payment}`);
          if (payment === 'prepaid') {
            assert.equal(c.item_iqd, cart.regular_iqd);
            assert.equal(c.cost_iqd, cart.cost_iqd);
            assert.equal(c.price_rung, cart.price_source);
            // The cost rung walk reaches the resolver's own cost on every line.
            assert.equal(c.cost_rung === null, cart.cost_iqd === null, `${p.doc.slug} ${c.channel}: cost rung`);
          }
          lines += 1;
        }
      }
    }
  }
  assert.ok(lines >= 2 * (89 + 80), `only ${lines} lines compared`);
});

test('answer B on the census: every migrated value is item + fee − landed cost, and its round trip holds', async () => {
  const { all } = await census();
  let migrated = 0;
  for (const p of all) {
    for (const m of p.models) {
      if (m.legacy.target.state !== 'MIGRATED') continue;
      migrated += 1;
      assert.equal(m.legacy.roundtrip_ok, true, `${p.doc.slug} ${m.option_id}`);
      for (const c of m.channels.filter((x) => x.ok && x.route)) {
        assert.equal(m.legacy.target.value_iqd, c.item_iqd! + c.fee_iqd! - c.cost_iqd!, `${p.doc.slug} ${c.channel}`);
      }
    }
  }
  assert.ok(migrated >= 60, `only ${migrated} models migrated`);
});

test('the census statuses: no cost (h2c, h2d, x2d combo) → held; ams-2-pro → base route; direct-only → profile and premium 0; sea → CBM; r1 → no premium', async () => {
  const { bySlug, all } = await census();
  const get = (slug: string): ProductEvaluation => bySlug.get(slug)!;
  for (const slug of ['bambu-lab-h2c', 'bambu-lab-h2d', 'bambu-lab-x2d-combo-open-box-workshop-2026']) {
    assert.equal(get(slug).status, 'TARGET_PROFIT_REVIEW_REQUIRED', slug);
    assert.ok(get(slug).reason_codes.includes('MISSING_LEGACY_COST'), slug);
  }
  const ams = get('bambu-lab-ams-2-pro');
  assert.deepEqual([ams.status, ams.routes, ams.reason_codes], ['NEEDS_MANUAL_REVIEW', ['air', 'land'], ['SHIPPING_PROFILE_MISSING']]);
  for (const slug of ['bambu-lab-petg-basic', 'bambu-lab-round-magnet', 'levo-switch-blue-3pin', 'bambu-lab-x2d-combo-open-box-workshop-2026']) {
    const p = get(slug);
    assert.equal(p.mix, 'DIRECT_ONLY', slug);
    assert.ok(p.reason_codes.includes('SHIPPING_PROFILE_MISSING'), slug);
    assert.ok(p.models.every((m) => m.legacy.premium.value_iqd === 0), slug);
    assert.ok(p.info_codes.includes('PREMIUM_ZERO_DIRECT_ONLY'), slug);
  }
  const sea = all.filter((p) => p.routes.includes('sea') && p.doc.dimensions.package_depth_mm === null);
  assert.ok(sea.length >= 15);
  for (const p of sea) assert.ok(p.reason_codes.includes('CBM_MISSING'), p.doc.slug);
  const r1 = get('bambu-lab-r1-co2-laser');
  assert.equal(r1.mix, 'PREORDER_ONLY');
  assert.ok(r1.models.every((m) => m.legacy.premium.state === 'NOT_APPLICABLE'));
  // a1: a model priced on its own but costed by the product is held (critique-1 §28: "a1 likely has one").
  const a1 = get('bambu-lab-a1');
  assert.deepEqual(a1.models.map((m) => m.legacy.target.state), ['MIGRATED', 'TARGET_PROFIT_REVIEW_REQUIRED']);
  assert.equal(a1.models[1]!.option_id, legacyOptionId('bambu-lab-a1', 1));
  // The spool's sea fee leaves a premium off the step.
  assert.ok(get('bambu-reusable-spool').reason_codes.includes('LEGACY_PREMIUM_NOT_ON_STEP'));
  // The U1 nozzle ships by air with no weight anywhere.
  assert.deepEqual(get('snapmaker-u1-hot-end-nozzle-hardened-steel').reason_codes, ['WEIGHT_MISSING']);
  // A clean product waits only for its supplier cost.
  for (const slug of ['bambu-lab-ams-ht', 'bambu-lab-ams-lite', 'bambu-lab-x2d', 'snapmaker-u1']) assert.equal(get(slug).status, 'WAITING_FOR_SUPPLIER_COST', slug);
  // P1 stores no supplier cost: nothing is ready to switch.
  assert.ok(all.every((p) => p.status !== 'READY_TO_SWITCH' && p.status !== 'READY'));
  assert.equal(legacyProductId('bambu-hotend-a1-a2'), 'lp_01');
});
