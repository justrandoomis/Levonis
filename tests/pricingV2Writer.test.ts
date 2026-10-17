/**
 * PRICING V2-3 — THE WRITER AND THE RESOLVER (spec §3.2-§3.4, §3.8, §3.11).
 *
 * On the census world (41 products, U = 1,600, EUR/USD 1.1, Germany land
 * 3,200 IQD/kg, China air 20,000 IQD/kg) plus the shapes the census lacks — an
 * option-less product, a colour-only product, an option-less pre-order-only
 * product — one product of each shape is made V2 through the REAL V2 writer
 * (evaluateV2Write → v2WriteStatements → one batch), price-first and
 * cost-first. Proves:
 *   - the cart's resolver charges exactly each SKU × channel's V2 price,
 *     prepaid; cash on delivery of a pre-order pays D wherever the SKU sells
 *     direct (with options AND option-less through `o:*`), else its own price;
 *   - fees are 0 on every channel (no route commission, no direct surcharge);
 *   - P ≤ D everywhere;
 *   - an older Worker (no SKU rung, no strict flag) never charges less;
 *   - strict mode refuses an unpriced new model (VARIANT_UNAVAILABLE), at the
 *     resolver and at the cart door, while the priced model still sells;
 *   - the cart door and the cart charge the V2 price end to end;
 *   - history (`sku:<combo>@<channel>`, U, engine_owner), pricing_audit and
 *     audit_log are written, and the private results hold every pair whole;
 *   - a V1 engine product and the manual products beside them are
 *     byte-identical before and after.
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/pricingV2Writer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, get, json, post, row, stubApp } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { legacyOptionId, legacyProductId } from './fixtures/legacyCatalogue';
import { seedOptionless, writeV2, cartGrid } from './fixtures/pricingV2';
import { loadPreviewContext, loadProducts, type LoadedProduct } from '../worker/lib/pricingEngine/load';
import { resolveCartLine, cartRoutes } from '../worker/routes/cart';
import { routeOfChannel, skuPriceHistoryKey } from '@levonis/pricing/skuChannel';
import type { V2Evaluation } from '../worker/lib/pricingEngine/v2/evaluate';
import type { PricingContext } from '../worker/routes/cart';
import { stageV1Engine } from './fixtures/v1Engine';

type World = ReturnType<typeof pricingWorld>;

const AMS2 = legacyProductId('bambu-lab-ams-2-pro');
const PLA = legacyProductId('bambu-lab-pla-basic-filament');
const LASER = legacyProductId('bambu-lab-r1-co2-laser');
const MAGNET = legacyProductId('bambu-lab-round-magnet');
const V1_ENGINE = legacyProductId('bambu-lab-a1');
const OL = 'p_v2_ol';
const COL = 'p_v2_col';
const PO = 'p_v2_po';

const fixed = (usd: string, scope: 'product' | 'option' | 'sku' = 'product', id = '') => ({ scope, scope_id: id, kind: 'fixed' as const, usd });
const delta = (usd: string, scope: 'option' | 'color', id: string) => ({ scope, scope_id: id, kind: 'delta' as const, usd });
const off = (usd: string, scope: 'product' | 'option' | 'color' | 'sku' = 'product', id = '') => ({ scope, scope_id: id, usd });

/** What the cart charges one line (the cart's own function), on the customer's document — or an older Worker's. */
function charge(loaded: LoadedProduct, ctx: PricingContext, ids: readonly string[], colour: string | null, route: string, o: { cod?: boolean; older?: boolean } = {}) {
  const view = o.older && loaded.view ? { ...loaded.view, sku_prices: null, sku_strict: undefined } : loaded.view;
  return resolveCartLine(
    loaded.row,
    { optionId: ids[0] ?? '', optionValueIds: [...ids], colorId: colour ?? '', transportMethod: route, fulfillmentType: route ? 'pre_order' : 'direct_sale', warrantyPlanId: '' },
    'free',
    false,
    ctx,
    view,
    o.cod ? 'cod' : 'prepaid'
  ).resolved;
}

/** Every planned SKU × channel, charged as the cart charges it: prepaid = P, COD = D (or P), fee 0, P ≤ D, the older Worker never less. */
async function assertCharges(w: World, ev: V2Evaluation): Promise<number> {
  const loaded = (await loadProducts(w.db, [ev.product_id])).get(ev.product_id)!;
  const ctx = await loadPreviewContext(w.db);
  assert.equal(loaded.doc.sku_strict, true, `${ev.product_id}: the customer's document is strict`);
  let n = 0;
  for (const p of ev.plan.prices) {
    const label = `${ev.product_id} ${p.combo_key || '(product)'} ${p.channel}`;
    const route = routeOfChannel(p.channel) ?? '';
    const price = p.price.computed_price_iqd;
    const prepaid = charge(loaded, ctx, p.option_value_ids, p.color_id, route);
    assert.deepEqual(prepaid.errors, [], label);
    assert.equal(prepaid.unit_subtotal_iqd, price, `${label}: the cart charges the V2 price`);
    assert.equal(prepaid.components.transport_fee_iqd + prepaid.components.direct_fee_iqd, 0, `${label}: no fee`);
    const direct = ev.plan.prices.find((x) => x.combo_key === p.combo_key && x.channel === 'direct_sale')?.price.computed_price_iqd ?? null;
    if (direct !== null) assert.ok(price <= direct, `${label}: P ≤ D`);
    if (route) {
      const cod = charge(loaded, ctx, p.option_value_ids, p.color_id, route, { cod: true });
      assert.deepEqual(cod.errors, [], `${label} cod`);
      assert.equal(cod.unit_subtotal_iqd, direct ?? price, `${label}: cash on delivery pays D where the SKU sells direct`);
    }
    const older = charge(loaded, ctx, p.option_value_ids, p.color_id, route, { older: true });
    assert.ok(older.errors.length > 0 || older.unit_subtotal_iqd >= price, `${label}: an older Worker never charges less (${older.unit_subtotal_iqd} < ${price})`);
    n += 1;
  }
  return n;
}

const imageOf = (w: World, ids: readonly string[]) =>
  JSON.stringify(
    ids.map((pid) => [
      all(w.raw, 'SELECT * FROM products WHERE id = ?', pid),
      all(w.raw, 'SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id', pid),
      all(w.raw, 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', pid),
      all(w.raw, 'SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY id', pid),
      all(w.raw, 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY id', pid),
      all(w.raw, 'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id', pid),
      all(w.raw, 'SELECT * FROM product_sku_prices WHERE product_id = ? ORDER BY combo_key, channel', pid),
      all(w.raw, 'SELECT * FROM pricing_sku_costs WHERE product_id = ? ORDER BY combo_key, channel', pid),
      all(w.raw, 'SELECT * FROM product_pricing_state WHERE product_id = ?', pid),
    ])
  );


/** A V1 engine product as the cut-over found it (tests/fixtures/v1Engine.ts: the V1 doors are closed since the clean start). */
async function adoptV1(w: World, pid: string) {
  await stageV1Engine(w.db, pid, {
    inputs: [{ scope: 'base', supplier_cost_amount: '200', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000 }],
    rules: [
      { kind: 'target_profit', scope: 'product', amount_usd: '30' },
      { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 15_000 },
    ],
  });
}

test('every shape made V2 is charged exactly its V2 prices: prepaid, COD = D, fees 0, P ≤ D, never less for an older Worker', async () => {
  const w = pricingWorld();
  seedOptionless(w.raw, OL, { routes: ['land', 'air'] });
  seedOptionless(w.raw, COL, { routes: ['sea'], colours: 3 });
  seedOptionless(w.raw, PO, { saleTypes: ['pre_order'], routes: ['land'] });
  await adoptV1(w, V1_ENGINE);
  const others = all<{ id: string }>(w.raw, 'SELECT id FROM products ORDER BY id').map((r) => r.id).filter((id) => ![AMS, AMS2, PLA, LASER, MAGNET, OL, COL, PO].includes(id));
  const before = imageOf(w, others);
  const v1Before = await cartGrid(w.db, V1_ENGINE);

  // Price-first, one model (direct + land): $1,000 at U 1,600 = 1,600,000; $50 off = 1,520,000.
  const ams = await writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000')], discounts: [off('50')] });
  assert.equal(ams.kind, 'v2_create');
  assert.deepEqual(ams.plan.prices.map((p) => [p.channel, p.price.computed_price_iqd]), [['direct_sale', 1_600_000], ['pre_order_land', 1_520_000]]);
  // Price-first, two models × thirty colours (direct + sea): $20, model 2 +$4, colour 1 +$2, $1 off; colour 2 has no discount.
  const pla = await writeV2(w.db, PLA, {
    method: 'usd',
    points: [fixed('20'), delta('4', 'option', legacyOptionId('bambu-lab-pla-basic-filament', 1)), delta('2', 'color', `${PLA}_c0`)],
    discounts: [off('1'), off('0', 'color', `${PLA}_c1`)],
  });
  assert.equal(pla.plan.prices.length, 2 * 30 * 2, '60 SKUs × 2 channels');
  const plaPrice = (m: number, c: number, ch: string) => pla.plan.prices.find((p) => p.combo_key === `o:${legacyOptionId('bambu-lab-pla-basic-filament', m)}|c:${PLA}_c${c}` && p.channel === ch)!.price.computed_price_iqd;
  assert.equal(plaPrice(0, 5, 'direct_sale'), 32_000);
  assert.equal(plaPrice(0, 5, 'pre_order_sea'), 30_500, '$19 = 30,400 → 30,500 (the rule of row 245)');
  assert.equal(plaPrice(1, 0, 'direct_sale'), 41_750, '$26 = 41,600 → 41,750');
  assert.equal(plaPrice(0, 1, 'pre_order_sea'), plaPrice(0, 1, 'direct_sale'), 'an explicit $0 exception overrides the product discount');
  // Cost-first, one model sold direct + air + land: EUR 450 by Germany land (R = 800,000), $120 minimum (192,000) → D 992,000.
  const ams2 = await writeV2(w.db, AMS2, {
    method: 'cost',
    inputs: { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 },
    minimumProfitUsd: '120',
    discounts: [off('50')],
  });
  assert.deepEqual(Object.fromEntries(ams2.plan.prices.map((p) => [p.channel, p.price.computed_price_iqd])), { direct_sale: 992_000, pre_order_air: 912_000, pre_order_land: 912_000 });
  // Pre-order only, three models (land): every route at D; the discount is ignored (C-8).
  const laser = await writeV2(w.db, LASER, { method: 'usd', points: [fixed('2500')], discounts: [off('100')] });
  assert.ok(laser.plan.prices.every((p) => p.channel === 'pre_order_land' && p.price.computed_price_iqd === 4_000_000), 'pre-order-only sells at D');
  assert.ok(laser.result!.skus.every((s) => s.issues.some((i) => i.code === 'V2_DISCOUNT_IGNORED')));
  // Direct only, nine models, one model with its own fixed price.
  const magnet = await writeV2(w.db, MAGNET, { method: 'usd', points: [fixed('3'), fixed('5', 'option', legacyOptionId('bambu-lab-round-magnet', 4))] });
  assert.equal(magnet.plan.prices.find((p) => p.option_id === legacyOptionId('bambu-lab-round-magnet', 4))!.price.computed_price_iqd, 8_000);
  // Option-less (direct + land + air), colour-only (direct + sea), option-less pre-order only.
  const ol = await writeV2(w.db, OL, { method: 'usd', points: [fixed('500')], discounts: [off('25')] });
  const col = await writeV2(w.db, COL, { method: 'usd', points: [fixed('30'), delta('-2', 'color', `${COL}_c2`)], discounts: [off('3')] });
  const po = await writeV2(w.db, PO, { method: 'usd', points: [fixed('100')], discounts: [off('10')] });

  let charged = 0;
  for (const ev of [ams, pla, ams2, laser, magnet, ol, col, po]) charged += await assertCharges(w, ev);
  assert.ok(charged >= 140, `every SKU × channel charged (${charged})`);

  // The option-less product's own row is stored under the sentinel and read back as the product itself.
  assert.deepEqual(all(w.raw, 'SELECT combo_key, channel, regular_price_iqd FROM product_sku_prices WHERE product_id = ? ORDER BY channel', OL).map((r) => ({ ...r })), [
    { combo_key: 'o:*', channel: 'direct_sale', regular_price_iqd: 800_000 },
    { combo_key: 'o:*', channel: 'pre_order_air', regular_price_iqd: 760_000 },
    { combo_key: 'o:*', channel: 'pre_order_land', regular_price_iqd: 760_000 },
  ]);
  const olGrid = await cartGrid(w.db, OL);
  assert.equal(olGrid['@pre_order_land']!.cod, 800_000, 'option-less COD pays D through the o:* direct row');
  assert.equal(olGrid['@pre_order_land']!.prepaid, 760_000);
  const poGrid = await cartGrid(w.db, PO);
  assert.equal(poGrid['@pre_order_land']!.cod, 160_000, 'pre-order only: cash on delivery pays its own price (there is no D row)');
  // Fees are explicit zeros on every route the product lists.
  for (const pid of [OL, COL, PO]) {
    const list = JSON.parse(String(row<{ t: string }>(w.raw, 'SELECT preorder_transports AS t FROM products WHERE id = ?', pid)!.t)) as Array<{ commission_iqd?: number }>;
    assert.ok(list.length > 0 && list.every((t) => t.commission_iqd === 0), `${pid}: every route commission is an explicit 0`);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM products WHERE id IN (?, ?) AND direct_surcharge_iqd IS NOT NULL', AMS2, PLA), 0);

  // The state, the private results, the history and the audit.
  for (const ev of [ams, pla, ams2, laser, magnet, ol, col, po]) {
    const st = row<{ mode: string; pricing_method: string; v2_since: string | null; write_seq: number }>(w.raw, 'SELECT mode, pricing_method, v2_since, write_seq FROM product_pricing_state WHERE product_id = ?', ev.product_id)!;
    assert.equal(st.mode, 'engine');
    assert.equal(st.pricing_method, ev.method);
    assert.ok(st.v2_since);
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = ? AND write_seq = ?', ev.product_id, st.write_seq), ev.plan.prices.length);
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_sku_costs WHERE product_id = ?', ev.product_id), 0, 'a V2 product holds no V1 result');
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ? AND entity = 'sku_price' AND action = 'engine_entry'", ev.product_id), 1);
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE target = ? AND action = 'pricing.v2.created'", ev.product_id), 1);
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM ops_guards WHERE id LIKE '%' || ?", ev.product_id), 0, 'every token is released');
  }
  const hist = row<{ new_iqd: number; usd_iqd_rate: string; price_source: string }>(w.raw, 'SELECT new_iqd, usd_iqd_rate, price_source FROM price_history WHERE product_id = ? AND variant_key = ?', OL, skuPriceHistoryKey('', 'pre_order_land'))!;
  assert.deepEqual({ ...hist }, { new_iqd: 760_000, usd_iqd_rate: '1600', price_source: 'engine_owner' });
  const cost = row<Record<string, unknown>>(w.raw, "SELECT * FROM pricing_v2_sku_results WHERE product_id = ? AND channel = 'pre_order_air'", AMS2)!;
  assert.equal(cost.method, 'cost');
  assert.equal(cost.replacement_cost_iqd, 842_000, 'the air route carries its own replacement cost');
  assert.equal(cost.discount_usd, '50');
  assert.equal(cost.discount_scope, 'product');
  assert.equal(cost.supplier_currency, 'EUR');
  assert.equal(cost.cross_rate, '1.1');
  // The audit_log row carries ids and counts only — never a price, a rate or a cost.
  const detail = String(row<{ d: string }>(w.raw, "SELECT detail AS d FROM audit_log WHERE target = ? AND action = 'pricing.v2.created'", AMS2)!.d);
  assert.doesNotMatch(detail, /992000|912000|842000|1600|1760|"usd/);

  // Nothing else moved: the V1 engine product and every manual product, byte for byte.
  assert.equal(imageOf(w, others), before, 'a V1 or manual product beside the V2 ones is untouched');
  assert.deepEqual(await cartGrid(w.db, V1_ENGINE), v1Before);
  const v1Doc = (await loadProducts(w.db, [V1_ENGINE])).get(V1_ENGINE)!.doc;
  assert.equal(v1Doc.sku_strict, undefined, 'a V1 document is never strict');
});

test('a cost-first route whose cost is at or above the discounted price sells at D; one at or above D is blocked unless the owner accepted it', async () => {
  const w = pricingWorld();
  // $120 off: E_P = 800,000 = R_land — a price AT the route's own cost would publish it (Q1, review
  // 2026-10-14): the discount is withdrawn there too and the land route sells at D, like the air route
  // (R_air 842,000 > 800,000; C-5 `direct`). Every route sells strictly above its replacement cost.
  const ev = await writeV2(w.db, AMS2, {
    method: 'cost',
    inputs: { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 },
    minimumProfitUsd: '120',
    discounts: [off('120')],
  });
  const at = (ch: string) => ev.plan.prices.find((p) => p.channel === ch)!;
  assert.equal(at('pre_order_land').price.computed_price_iqd, 992_000);
  assert.equal(at('pre_order_land').price.v2.floor, 'discount_withdrawn');
  for (const p of ev.plan.prices) {
    const r = p.price.v2.replacement?.replacement_cost_iqd ?? null;
    if (r !== null && p.channel !== 'direct_sale') assert.ok(p.price.computed_price_iqd > r, `${p.channel} sells above its own cost`);
  }
  assert.equal(at('pre_order_air').price.computed_price_iqd, 992_000);
  assert.equal(at('pre_order_air').price.v2.floor, 'discount_withdrawn');
  assert.equal(row<{ f: string }>(w.raw, "SELECT floor AS f FROM pricing_v2_sku_results WHERE product_id = ? AND channel = 'pre_order_air'", AMS2)!.f, 'discount_withdrawn');
  await assertCharges(w, ev);

  // Air freight so dear that R_air > D: the route is blocked — refused until the owner's preview accepts it.
  w.raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '200000', version = version + 1 WHERE profile = 'CHINA_AIR'`);
  const held = await writeV2(w.db, AMS2, { method: 'cost', minimumProfitUsd: '120', discounts: [off('120')], dryRun: true });
  assert.deepEqual(held.blocked.map((b) => b.channel), ['pre_order_air']);
  assert.equal(held.complete, false);
  assert.ok(held.codes.includes('V2_ROUTE_BELOW_COST'));
  const accepted = await writeV2(w.db, AMS2, { method: 'cost', minimumProfitUsd: '120', discounts: [off('120')], acceptBlocked: true });
  assert.equal(accepted.complete, true);
  // The model's air row is switched off; land and direct still sell; the stored results name no air price.
  assert.equal(row<{ e: number }>(w.raw, "SELECT enabled AS e FROM product_option_transports WHERE product_id = ? AND method = 'air' AND fulfillment_id = ?", AMS2, `${legacyOptionId('bambu-lab-ams-2-pro', 0)}_p`)!.e, 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = ? AND channel = 'pre_order_air'", AMS2), 0);
  const grid = await cartGrid(w.db, AMS2);
  assert.equal(grid[`o:${legacyOptionId('bambu-lab-ams-2-pro', 0)}@pre_order_air`], undefined, 'the blocked route is not offered');
  assert.equal(grid[`o:${legacyOptionId('bambu-lab-ams-2-pro', 0)}@pre_order_land`]!.prepaid, 992_000, 'land sells at D: its discount would have sold it at its own cost');
});

test('strict mode: a model added to a V2 product before it is priced is refused, at the resolver and at the cart door', async () => {
  const w = pricingWorld();
  w.raw.exec("INSERT INTO users (id, name, email, password_hash, role) VALUES ('buyer', 'B', 'b@x.co', 'h', 'customer'), ('buyer2', 'C', 'c@x.co', 'h', 'customer')");
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000')], discounts: [off('50')] });
  const model = `${AMS}_o0`;
  // An older Worker (or a raw import) adds a model with a direct cell under the engine token: no SKU row exists for it.
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${AMS}', 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock) VALUES ('${AMS}_o9', '${AMS}', '${AMS}_g', 'New', 9, 1, 5);
    INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES ('${AMS}_o9_d', '${AMS}', '${AMS}_o9', 'direct_sale', 1);
    DELETE FROM ops_guards WHERE id = 'engine-price:${AMS}';`);
  const grid = await cartGrid(w.db, AMS);
  assert.ok(grid[`o:${AMS}_o9@direct_sale`]!.errors.includes('VARIANT_UNAVAILABLE'), 'the unpriced model is refused, never priced from the ladder');
  assert.equal(grid[`o:${model}@direct_sale`]!.prepaid, 1_600_000, 'the priced model still sells');

  const app = stubApp(w.db, { id: 'buyer', role: 'customer', email: 'b@x.co' }, (a) => a.route('/api/cart', cartRoutes));
  const refused = await post(app, '/api/cart/items', { productId: AMS, qty: 1, optionId: `${AMS}_o9`, fulfillmentType: 'direct_sale' });
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'VARIANT_UNAVAILABLE');
  // One cart holds one shipping type: the direct line in one buyer's cart, the pre-order line in another's.
  const app2 = stubApp(w.db, { id: 'buyer2', role: 'customer', email: 'c@x.co' }, (a) => a.route('/api/cart', cartRoutes));
  for (const [a, line, price] of [
    [app, { fulfillmentType: 'direct_sale' }, 1_600_000],
    [app2, { fulfillmentType: 'pre_order', transportMethod: 'land' }, 1_520_000],
  ] as const) {
    const added = await post(a, '/api/cart/items', { productId: AMS, qty: 1, optionId: model, ...line });
    assert.equal(added.status, 200, JSON.stringify(await json(added.clone())));
    const cart = await json(await get(a, '/api/cart'));
    assert.deepEqual((cart.items as Array<{ unit_price_iqd: number }>).map((i) => i.unit_price_iqd), [price], 'the cart charges the V2 price end to end');
  }
});
