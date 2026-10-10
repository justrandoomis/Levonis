/**
 * FX-7 — COLOUR AND VARIANT (SKU) PRICING LEVELS (FX programme plan §4.4, §11,
 * §26; USD procurement design §4.1 and owner question Q4; DECISIONS row 184 (1):
 * product → option → colour → SKU, the SKU the most specific; migration
 * 0183_product_sku_prices.sql).
 *
 * Every scenario runs the real owner routes, the real engine writer and the
 * cart's own resolver on a real database with the 41 census products, at the
 * brief's rates (1 USD = 1,600 IQD; China sea 400,000 IQD per CBM; Germany land
 * 3,200 IQD per kg). Proves:
 *   - inheritance per level: an empty field inherits SKU → colour → model →
 *     product, the most specific value wins — the supplier cost and the minimum
 *     profit alike — and clearing a colour's value returns it to its model's;
 *   - a colour override changes only that colour's price: every other SKU is
 *     charged exactly what it was; the SKU rows carry the prices, the ladder
 *     beneath holds each model's highest, the colour rows' own prices are
 *     cleared, and a Worker without the SKU rung never charges a SKU less;
 *   - a two-group product prices every combination, and the cart charges each
 *     one exactly;
 *   - the resolver check refuses any mismatch: a SKU row off by one step, a
 *     missing SKU row, a ladder below a SKU — RESOLVER_MISMATCH, nothing written;
 *   - non-owners see nothing (no colour or SKU input, rule or cost);
 *   - FX-5 reprices every SKU, the stale list names a per-SKU product (and a
 *     colour added since), the six-figure preview is one row per SKU × channel,
 *     the order snapshot and price protection read the line's SKU, and going
 *     back to manual pricing returns every SKU to its model's price, never lower;
 *   - deploy-ahead: on a database before 0183 the engine behaves exactly as
 *     before FX-7 (no colour or SKU level, a second group refused, the same
 *     prices written for a per-model product, the storefront unaffected).
 *
 * Run: node --import tsx --test tests/skuPrices.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, dbThrough, get, json, post, row } from './fixtures/app';
import { applyRate, fxEnv, market, OWNER_ROW_SQL, pairOf } from './fixtures/fx';
import { pricingWorld } from './fixtures/procurementPricing';
import { legacyProductId, seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { loadPreviewContext, loadProducts } from '../worker/lib/pricingEngine/load';
import { loadProductPricing } from '../worker/lib/pricingEngine/store';
import { loadPricingRates } from '../worker/lib/pricingEngine/rates';
import { loadEngineReads, parseProductInputs, productEngineEvaluation } from '../worker/lib/pricingEngine/productInputs';
import { verifyPlan, type PricePlan } from '../worker/lib/pricingEngine/writer';
import { engineBasisOf } from '../worker/lib/pricingEngine/orderBasis';
import { engineCombosOf, engineObservations } from '../worker/lib/pricingEngine/protectionBasis';
import { resolveCartLine } from '../worker/routes/cart';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import type { Env } from '../worker/lib/types';
import type { DatabaseSync } from 'node:sqlite';

type World = ReturnType<typeof pricingWorld>;

// bambu-lab-pla-matte-1kg: two models, 25 colours (linked to every model), sold direct and by sea pre-order.
const PID = legacyProductId('bambu-lab-pla-matte-1kg');
const M0 = `${PID}_o0`;
const M1 = `${PID}_o1`;
const C = (k: number) => `${PID}_c${k}`;
const sku = (ids: string[], colour: string | null) => [...[...ids].sort().map((id) => `o:${id}`), ...(colour ? [`c:${colour}`] : [])].join('|');

// bambu-lab-a1: two models, no colour, sold direct and by land pre-order — given a second option group below.
const A1 = legacyProductId('bambu-lab-a1');

const BASE = {
  inputs: [{ scope: 'base', supplier_cost_amount: '10', supplier_cost_currency: 'USD', shipping_profile: 'CHINA_SEA', manual_cbm: '0.005' }],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '3' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 2000 },
  ],
};

const ceil1000 = (n: number) => Math.ceil(n / 1000) * 1000;
/** The pre-order price of lp_23 at U = 1,600: supplier $ + 0.005 CBM × 400,000 + the minimum profit $, rounded up. */
const sea = (usd: number, target: number, u = 1600) => ceil1000(usd * u + 0.005 * 400_000 + target * u);

const seqOf = (w: World, pid: string) => row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', pid)?.s ?? 0;

/** The owner's save: 409 with the preview, then the same body with its hash (and the tick above 15%). */
async function save(w: World, pid: string, draft: Record<string, unknown>) {
  const first = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft });
  assert.equal(first.status, 409, JSON.stringify(first.body).slice(0, 600));
  assert.equal(first.body.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(first.body.details?.preview?.adoption?.missing_codes));
  const preview = first.body.details.preview;
  const saved = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft, preview_hash: preview.preview_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 600));
  assert.equal(saved.body.mode, 'engine');
  return { preview, saved: saved.body };
}

/** What the cart charges a guest for one line (its whole selection, colour and route), prepaid. */
async function charge(w: World, pid: string, ids: string[], colour: string | null, route: '' | 'sea' | 'land', opts: { older?: boolean; cod?: boolean } = {}) {
  const loaded = (await loadProducts(w.db, [pid])).get(pid)!;
  const ctx = await loadPreviewContext(w.db);
  // An older Worker reads no SKU row (the table is unknown to it).
  const view = opts.older && loaded.view ? { ...loaded.view, sku_prices: null } : loaded.view;
  const r = resolveCartLine(
    loaded.row,
    { optionId: ids[0] ?? '', optionValueIds: ids, colorId: colour ?? '', transportMethod: route, fulfillmentType: route ? 'pre_order' : 'direct_sale', warrantyPlanId: '' },
    'free',
    false,
    ctx,
    view,
    opts.cod ? 'cod' : 'prepaid'
  );
  assert.deepEqual([...r.resolved.errors, ...r.selectionErrors], [], `${ids.join('+')} ${colour ?? ''} ${route}`);
  return r.resolved.unit_subtotal_iqd;
}

/** A world on a database migrated only through `through` (a deploy ahead of its migration). */
function worldThrough(through: string): World {
  const raw = dbThrough(through);
  raw.exec(OWNER_ROW_SQL);
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  applyRate(raw, 'USD_IQD', '1600');
  applyRate(raw, 'EUR_USD', '1.1');
  applyRate(raw, 'CNY_USD', '0.14');
  raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND';
            UPDATE pricing_shipping_rates SET rate_iqd = '20000', version = version + 1 WHERE profile = 'CHINA_AIR';
            UPDATE pricing_shipping_rates SET rate_iqd = '400000', version = version + 1 WHERE profile = 'CHINA_SEA';`);
  return pricingWorld({ raw });
}

/** A second option group («Size»: Small, Large) on the a1 — every model × size is a SKU. */
function addSizeGroup(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('${A1}_g2', '${A1}', 'Size', 1, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock, variant_key, variant_label)
    VALUES ('${A1}_s', '${A1}', '${A1}_g2', 'Small', 'صغير', 'بچووک', 0, 1, 5, 's', 'Small'),
           ('${A1}_l', '${A1}', '${A1}_g2', 'Large', 'كبير', 'گەورە', 1, 1, 5, 'l', 'Large');
  `);
}

const skuRows = (w: World, pid = PID) =>
  Object.fromEntries(all<{ combo_key: string; channel: string; regular_price_iqd: number }>(w.raw, 'SELECT combo_key, channel, regular_price_iqd FROM product_sku_prices WHERE product_id = ?', pid).map((r) => [`${r.combo_key}@${r.channel}`, r.regular_price_iqd]));

// ------------------------------------------------------------- inheritance

test('inheritance per level: an empty field inherits SKU → colour → model → product, the most specific value wins — supplier cost and minimum profit alike', async () => {
  const w = pricingWorld();
  const draft = {
    inputs: [
      ...BASE.inputs,
      { scope: 'option', scope_id: M1, supplier_cost_amount: '11', supplier_cost_currency: 'USD' },
      { scope: 'color', scope_id: C(1), supplier_cost_amount: '12', supplier_cost_currency: 'USD' },
      { scope: 'sku', scope_id: sku([M1], C(2)), supplier_cost_amount: '13', supplier_cost_currency: 'USD' },
    ],
    rules: [...BASE.rules, { kind: 'target_profit', scope: 'color', scope_id: C(2), amount_usd: '4' }, { kind: 'target_profit', scope: 'sku', scope_id: sku([M0], C(3)), amount_usd: '5' }],
  };
  const { preview } = await save(w, PID, draft);
  assert.equal(preview.adoption.per_sku, true, 'a colour or SKU level holds a value: priced per SKU');

  const expect: Array<[string, string, number]> = [
    [M0, C(0), sea(10, 3)], // the product's cost and minimum profit
    [M1, C(0), sea(11, 3)], // the model's cost
    [M0, C(1), sea(12, 3)], // the colour's cost
    [M1, C(1), sea(12, 3)], // the colour beats the model
    [M1, C(2), sea(13, 4)], // the SKU's cost, the colour's minimum profit
    [M0, C(2), sea(10, 4)], // the colour's minimum profit
    [M0, C(3), sea(10, 5)], // the SKU's minimum profit
  ];
  for (const [m, c, pre] of expect) {
    assert.equal(await charge(w, PID, [m], c, 'sea'), pre, `${m} ${c} sea`);
    assert.equal(await charge(w, PID, [m], c, ''), pre + 2000, `${m} ${c} direct = pre-order + the Direct Sale Extra`);
  }
  assert.equal(sea(12, 3), 26_000);
  assert.equal(sea(13, 4), 30_000);

  // The form answers every level: the colour's own value, the SKU's, and each SKU's computed price.
  const answer = (await w.getInputs(PID)).body;
  assert.equal(answer.sku_levels, true);
  assert.equal(answer.per_sku, true);
  const colourScope = answer.scopes.find((s: { scope: string; scope_id: string }) => s.scope === 'color' && s.scope_id === C(1));
  assert.equal(colourScope.pricing_inputs.supplier_cost_amount, '12');
  const skuScope = answer.scopes.find((s: { scope: string; scope_id: string }) => s.scope === 'sku' && s.scope_id === sku([M0], C(3)));
  assert.equal(skuScope.minimum_target_profit_usd, '5');
  const summaryOf = (combo: string) => answer.skus.find((k: { combo_key: string }) => k.combo_key === combo).pricing_summary;
  assert.equal(summaryOf(sku([M1], C(2))).preorder_base_iqd, sea(13, 4), 'the colour card shows the SKU’s computed customer price');
  assert.equal(summaryOf(sku([M1], C(2))).direct_sale_price_iqd, sea(13, 4) + 2000);

  // Empty = inherit: clearing the colour's cost returns its SKUs to their models'.
  await save(w, PID, { inputs: [{ scope: 'color', scope_id: C(1), supplier_cost_amount: null, supplier_cost_currency: null }] });
  assert.equal(await charge(w, PID, [M1], C(1), 'sea'), sea(11, 3));
  assert.equal(await charge(w, PID, [M0], C(1), 'sea'), sea(10, 3));
});

// ------------------------------------------------------------- one colour moves alone

test('a colour override changes only that colour’s price: the SKU rows carry it, the ladder holds each model’s highest, and an older Worker never charges less', async () => {
  const w = pricingWorld();
  await save(w, PID, BASE);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_sku_prices'), 0, 'priced per model: no SKU row');
  const before: Record<string, number> = {};
  for (const m of [M0, M1]) for (let k = 0; k < 25; k += 1) for (const r of ['', 'sea'] as const) before[`${m}|${k}|${r}`] = await charge(w, PID, [m], C(k), r);
  assert.equal(before[`${M0}|7|sea`], sea(10, 3));

  const { preview } = await save(w, PID, { inputs: [{ scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' }] });
  // The six figures are one row per SKU × channel, named by model and colour.
  const rows = preview.adoption.rows as Array<{ combo_key: string; channel: string; name_en: string; today_prepaid_iqd: number; computed_price_iqd: number }>;
  assert.equal(rows.length, 2 * 25 * 2);
  const moved = rows.filter((r) => r.today_prepaid_iqd !== r.computed_price_iqd);
  assert.deepEqual(moved.map((r) => r.combo_key).sort(), [sku([M0], C(0)), sku([M0], C(0)), sku([M1], C(0)), sku([M1], C(0))].sort(), 'only colour 0 moves');
  assert.equal(rows.find((r) => r.combo_key === sku([M0], C(0)))!.name_en, 'Model 1 · Colour 1');

  for (const m of [M0, M1])
    for (let k = 0; k < 25; k += 1)
      for (const r of ['', 'sea'] as const) {
        const now = await charge(w, PID, [m], C(k), r);
        if (k === 0) assert.equal(now, sea(12, 3) + (r ? 0 : 2000), `${m} colour 0 ${r || 'direct'}`);
        else assert.equal(now, before[`${m}|${k}|${r}`], `${m} colour ${k} ${r || 'direct'} unchanged`);
      }

  // The SKU rows: one per sellable SKU × channel.
  const rowsByKey = skuRows(w);
  assert.equal(Object.keys(rowsByKey).length, 2 * 25 * 2);
  assert.equal(rowsByKey[`${sku([M0], C(0))}@pre_order_sea`], 26_000);
  assert.equal(rowsByKey[`${sku([M0], C(5))}@direct_sale`], 25_000);
  // The ladder beneath: each model's highest; the colour rows' own prices cleared.
  const cells = all<{ fulfillment_type: string; regular_price_iqd: number }>(w.raw, 'SELECT fulfillment_type, regular_price_iqd FROM product_option_fulfillment WHERE option_id = ? ORDER BY fulfillment_type', M0);
  assert.deepEqual(cells.map((c) => [c.fulfillment_type, c.regular_price_iqd]), [['direct_sale', 28_000], ['pre_order', 26_000]]);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_colors WHERE product_id = ? AND (regular_price_iqd IS NOT NULL OR regular_adjust_iqd IS NOT NULL)', PID), 0);
  // The variant rows mirror their SKU's direct price (the purchase screens' selection price).
  assert.equal(row<{ p: number }>(w.raw, 'SELECT regular_price_iqd AS p FROM product_variants WHERE product_id = ? AND combo_key = ?', PID, sku([M0], C(0)))!.p, 28_000);
  assert.equal(row<{ p: number }>(w.raw, 'SELECT regular_price_iqd AS p FROM product_variants WHERE product_id = ? AND combo_key = ?', PID, sku([M0], C(1)))!.p, 25_000);
  // products.price_iqd: the lowest (the card's «from»).
  assert.equal(row<{ p: number }>(w.raw, 'SELECT price_iqd AS p FROM products WHERE id = ?', PID)!.p, sea(10, 3));

  // Rollback safety: an older Worker (no SKU rung) charges the model's highest, never less.
  for (const m of [M0, M1])
    for (const k of [0, 1, 9])
      for (const r of ['', 'sea'] as const) {
        const older = await charge(w, PID, [m], C(k), r, { older: true });
        assert.ok(older >= (await charge(w, PID, [m], C(k), r)), `older Worker ≥ the SKU price (${m} ${k} ${r})`);
      }
  // Cash on delivery of a pre-order pays the SKU's direct price (the resolver's COD rule).
  assert.equal(await charge(w, PID, [M0], C(0), 'sea', { cod: true }), 28_000);

  // Owner decision 6 per SKU: history under the SKU's key, the order snapshot and the claim read it.
  assert.ok(count(w.raw, "SELECT COUNT(*) AS n FROM price_history WHERE product_id = ? AND variant_key = ?", PID, `sku:${sku([M0], C(0))}@pre_order_sea`) >= 1);
  const basis = await engineBasisOf(w.db, [
    { key: 'l1', product_id: PID, option_id: M0, option_value_ids: [M0], color_id: C(0), pricing_basis: 'preorder', route: 'sea', regular_iqd: 26_000 },
    { key: 'l2', product_id: PID, option_id: M0, option_value_ids: [M0], color_id: C(4), pricing_basis: 'direct', route: null, regular_iqd: 25_000 },
    { key: 'l3', product_id: PID, option_id: M0, option_value_ids: [M0], color_id: C(0), pricing_basis: 'direct', route: null, regular_iqd: 25_000 },
  ]);
  assert.equal(basis.get('l1')?.engine_combo_key, sku([M0], C(0)));
  assert.equal(basis.get('l1')?.engine_channel, 'pre_order_sea');
  assert.equal(basis.get('l2')?.engine_combo_key, sku([M0], C(4)));
  assert.equal(basis.has('l3'), false, 'a regular price that is not its SKU’s engine price gets no snapshot');
  const obs = await engineObservations(w.db, PID, engineCombosOf({ optionId: M0, optionValueIds: [M0], colorId: C(0) }), 'pre_order_sea', { from: '2000-01-01', to: '2999-01-01' });
  assert.equal(obs.today?.price_iqd, 26_000, 'price protection reads the line’s SKU today');
});

// ------------------------------------------------------------- two groups

test('a two-group product prices every combination, and the cart charges each one exactly', async () => {
  const w = pricingWorld();
  addSizeGroup(w.raw);
  const land = (usd: number, target: number) => ceil1000(usd * 1600 + 1 * 3200 + target * 1600);
  const draft = {
    inputs: [
      { scope: 'base', supplier_cost_amount: '10', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000 },
      { scope: 'option', scope_id: `${A1}_l`, supplier_cost_amount: '15', supplier_cost_currency: 'USD' },
    ],
    rules: [
      { kind: 'target_profit', scope: 'product', amount_usd: '3' },
      { kind: 'target_profit', scope: 'option', scope_id: `${A1}_l`, amount_usd: '6' },
      { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 5000 },
    ],
  };
  const { preview } = await save(w, A1, draft);
  assert.equal(preview.adoption.per_sku, true, 'a second option group: priced per SKU');
  for (const m of [`${A1}_o0`, `${A1}_o1`]) {
    for (const [size, usd, t] of [[`${A1}_s`, 10, 3], [`${A1}_l`, 15, 6]] as const) {
      const ids = [m, size];
      assert.equal(await charge(w, A1, ids, null, 'land'), land(usd, t), `${m} ${size} land`);
      assert.equal(await charge(w, A1, ids, null, ''), land(usd, t) + 5000, `${m} ${size} direct`);
      // In either order the request lists its groups (the cart's relation order decides the model).
      assert.equal(await charge(w, A1, [size, m], null, 'land'), land(usd, t));
      assert.ok((await charge(w, A1, ids, null, 'land', { older: true })) >= land(usd, t), 'an older Worker never charges less');
    }
  }
  assert.equal(Object.keys(skuRows(w, A1)).length, 2 * 2 * 2, 'every model × size × channel');
});

// ------------------------------------------------------------- the exact check

test('the resolver check refuses any mismatch: a SKU row off by a step, a missing SKU row, a ladder below a SKU — and a refused write changes nothing', async () => {
  const w = pricingWorld();
  await save(w, PID, BASE);
  const draftBody = { inputs: [{ scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' }] };
  const loaded = (await loadProducts(w.db, [PID])).get(PID)!;
  const stored = await loadProductPricing(w.db, PID);
  const ctx = await loadPreviewContext(w.db);
  const rates = await loadPricingRates(w.db);
  const draft = parseProductInputs(draftBody, loaded, stored, { rates, now: new Date().toISOString() });
  const ev = await productEngineEvaluation(loaded, stored, ctx, rates, draft, await loadEngineReads(w.db, PID));
  assert.equal(ev.complete, true, JSON.stringify(ev.codes));
  assert.equal(ev.verification.ok, true, 'the plan as computed reads back exactly');

  const target = `${sku([M0], C(0))}`;
  const off: PricePlan = { ...ev.plan, skus: ev.plan.skus.map((k) => (k.combo_key === target && k.channel === 'pre_order_sea' ? { ...k, price: k.price + 1000 } : k)) };
  const v1 = verifyPlan(loaded, ev.legacy, off, ctx);
  assert.equal(v1.ok, false);
  assert.ok(v1.mismatches.includes(`${target}:pre_order_sea:prepaid`), JSON.stringify(v1.mismatches));

  const missing: PricePlan = { ...ev.plan, skus: ev.plan.skus.filter((k) => !(k.combo_key === sku([M1], C(3)) && k.channel === 'direct_sale')) };
  const v2 = verifyPlan(loaded, ev.legacy, missing, ctx);
  assert.equal(v2.ok, false, 'the SKU falls to the ladder (the model’s highest), not its own price');
  assert.ok(v2.mismatches.some((m) => m.startsWith(`${sku([M1], C(3))}:direct_sale`)), JSON.stringify(v2.mismatches));

  const lowLadder: PricePlan = { ...ev.plan, cells: ev.plan.cells.map((c) => ({ ...c, price: 1000 })), routes: ev.plan.routes.map((r) => ({ ...r, price: 1000 })), values: ev.plan.values.map((v) => ({ ...v, price: 1000 })) };
  const v3 = verifyPlan(loaded, ev.legacy, lowLadder, ctx);
  assert.equal(v3.ok, false);
  assert.ok(v3.mismatches.some((m) => m.endsWith(':rollback')), 'a ladder an older Worker would undercharge from is refused');

  // A write whose fences moved changes nothing: the colour rows and SKU rows stay as they were.
  const image = JSON.stringify([all(w.raw, 'SELECT * FROM product_sku_prices ORDER BY combo_key, channel'), all(w.raw, 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', PID)]);
  const stale = await w.putInputs(PID, { inputs_seq: seqOf(w, PID) + 1, ...draftBody });
  assert.equal(stale.status, 409);
  assert.equal(JSON.stringify([all(w.raw, 'SELECT * FROM product_sku_prices ORDER BY combo_key, channel'), all(w.raw, 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', PID)]), image);
});

test('the SKU rows are the engine writer’s alone: an insert, update or delete outside its batch is ENGINE_MANAGED', async () => {
  const w = pricingWorld();
  await save(w, PID, { ...BASE, inputs: [...BASE.inputs, { scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' }] });
  const k = sku([M0], C(0));
  assert.throws(() => w.raw.exec(`UPDATE product_sku_prices SET regular_price_iqd = 1000 WHERE product_id = '${PID}' AND combo_key = '${k}'`), /ENGINE_MANAGED/);
  assert.throws(() => w.raw.exec(`DELETE FROM product_sku_prices WHERE product_id = '${PID}'`), /ENGINE_MANAGED/);
  assert.throws(
    () => w.raw.exec(`INSERT INTO product_sku_prices (product_id, combo_key, channel, regular_price_iqd, write_seq, updated_at) VALUES ('${PID}', 'o:${M0}|c:${C(9)}x', 'direct_sale', 1000, 1, 'now')`),
    /ENGINE_MANAGED/
  );
  // The CHECKs: a price on the 1,000 step, at least 1,000.
  w.raw.exec("INSERT INTO ops_guards (id, ok) VALUES ('engine-price:" + PID + "', 1)");
  assert.throws(() => w.raw.exec(`UPDATE product_sku_prices SET regular_price_iqd = 25500 WHERE product_id = '${PID}' AND combo_key = '${k}' AND channel = 'direct_sale'`), /CHECK/);
  w.raw.exec("DELETE FROM ops_guards WHERE id = 'engine-price:" + PID + "'");
});

// ------------------------------------------------------------- non-owners

test('non-owners see nothing: no colour or SKU input, rule, cost or per-SKU summary reaches anyone but the verified owner', async () => {
  const w = pricingWorld();
  await save(w, PID, { ...BASE, inputs: [...BASE.inputs, { scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' }] });
  for (const user of [
    { id: 'usr_asst', role: 'admin' as const, email: 'asst@x.co', admin_scope: 'assistant' },
    { id: 'usr_cust', role: 'customer' as const, email: 'c@x.co' },
  ]) {
    const other = pricingWorld({ raw: w.raw, user });
    const read = await other.getInputs(PID);
    assert.equal(read.status, 403, `${user.role} reads nothing`);
    assert.equal(JSON.stringify(read.body).includes('supplier_cost'), false);
    const write = await other.putInputs(PID, { inputs_seq: seqOf(w, PID), inputs: [{ scope: 'color', scope_id: C(1), supplier_cost_amount: '1', supplier_cost_currency: 'USD' }] });
    assert.equal(write.status, 403, `${user.role} writes nothing`);
    const look = await other.previewInputs(PID, { inputs: [{ scope: 'sku', scope_id: sku([M0], C(2)), supplier_cost_amount: '1', supplier_cost_currency: 'USD' }] });
    assert.equal(look.status, 403);
  }
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_inputs WHERE scope = 'color' AND scope_id = ?", C(1)), 0);
});

// ------------------------------------------------------------- FX-5, the stale list, back to manual

test('FX-5 reprices every SKU when the dollar moves; the stale list names a colour added since; back to manual returns each SKU to its model’s highest, never lower', async () => {
  const w = pricingWorld();
  await save(w, PID, { ...BASE, inputs: [...BASE.inputs, { scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' }] });
  const now = new Date();
  const m = market({ sell: 1632, usd: '1.1', cny: '7.857143' });
  m.state.at = now;
  m.state.ecbDay = now.toISOString().slice(0, 10);
  const report = await runFxScheduler({ ...fxEnv(w.raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' } as Env, { now, scheduledTime: now }, { trigger: 'cron', fetchImpl: m.f.fetch });
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1632');
  assert.deepEqual(report.repricing?.repriced, [PID]);
  assert.equal(await charge(w, PID, [M0], C(0), 'sea'), sea(12, 3, 1632), 'colour 0 at the new rate');
  assert.equal(await charge(w, PID, [M1], C(3), 'sea'), sea(10, 3, 1632), 'every other colour at the new rate');
  assert.equal(skuRows(w)[`${sku([M1], C(3))}@pre_order_sea`], sea(10, 3, 1632));
  assert.ok(count(w.raw, "SELECT COUNT(*) AS n FROM price_history WHERE product_id = ? AND variant_key LIKE 'sku:%|c:%' AND price_source = 'engine_fx'", PID) > 0, 'engine_fx history per SKU');

  // A colour added since (no price of its own: the engine's lock lets it in) is listed until the product is saved.
  w.raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES ('${PID}_c99', '${PID}', 'New', 'جديد', 'نوێ', '#000000', 99, 1, 5)`);
  const list = await json(await get(w.app, '/api/admin/pricing/save-list'));
  const item = (list.stale.items as Array<{ product_id: string; reasons: string[] }>).find((i) => i.product_id === PID);
  assert.ok(item?.reasons.includes('SKUS'), JSON.stringify(list.stale));
  assert.equal(await charge(w, PID, [M0], `${PID}_c99`, 'sea'), sea(12, 3, 1632), 'meanwhile it sells at its model’s highest price, never lower');

  // Back to manual pricing: the SKU rows go, every SKU at its model's highest (the confirmation said so).
  const ws = row<{ s: number }>(w.raw, 'SELECT write_seq AS s FROM product_pricing_state WHERE product_id = ?', PID)!.s;
  const exit = await post(w.app, `/api/admin/pricing/products/${PID}/manual`, { write_seq: ws });
  assert.equal(exit.status, 200, JSON.stringify(await json(exit)));
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_sku_prices WHERE product_id = ?', PID), 0);
  assert.equal(await charge(w, PID, [M1], C(3), 'sea'), sea(12, 3, 1632), 'the model’s highest');
  assert.equal(await charge(w, PID, [M0], C(0), 'sea'), sea(12, 3, 1632));
});

// ------------------------------------------------------------- deploy-ahead

test('deploy-ahead: on a database before 0183 the engine behaves exactly as before FX-7 — no colour or SKU level, a second group refused, the same prices written, the storefront unaffected', async () => {
  const old = worldThrough('0181');
  const fresh = pricingWorld();
  assert.equal(count(old.raw, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'product_sku_prices'"), 0, 'fixture: the table is absent');

  const answer = (await old.getInputs(PID)).body;
  assert.equal(answer.sku_levels, false);
  assert.equal(answer.per_sku, false);
  assert.deepEqual(answer.skus, []);
  assert.deepEqual([...new Set(answer.scopes.map((s: { scope: string }) => s.scope))], ['base', 'option'], 'only the product and its models, as before');

  const colour = await old.putInputs(PID, { inputs_seq: 0, inputs: [{ scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' }] });
  assert.deepEqual([colour.status, colour.body.code, colour.body.details?.field], [400, 'PRICING_INPUT_INVALID', 'inputs[0].scope']);
  const rule = await old.putRules(PID, { rules: [{ kind: 'target_profit', scope: 'sku', scope_id: sku([M0], C(0)), amount_usd: '5' }] });
  assert.deepEqual([rule.status, rule.body.details?.field], [400, 'rules[0].scope']);

  // The same per-model adoption writes the same prices, row for row, on both databases.
  await save(old, PID, BASE);
  await save(fresh, PID, BASE);
  const image = (w: World) =>
    JSON.stringify([
      all(w.raw, 'SELECT price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd, preorder_transports FROM products WHERE id = ?', PID),
      all(w.raw, 'SELECT id, regular_price_iqd, prime_price_iqd, pro_price_iqd FROM product_option_values WHERE product_id = ? ORDER BY id', PID),
      all(w.raw, 'SELECT id, regular_price_iqd FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', PID),
      all(w.raw, 'SELECT id, regular_price_iqd, surcharge_iqd FROM product_option_transports WHERE product_id = ? ORDER BY id', PID),
      all(w.raw, 'SELECT id, regular_price_iqd, regular_adjust_iqd FROM product_colors WHERE product_id = ? ORDER BY id', PID),
      all(w.raw, 'SELECT id, regular_price_iqd FROM product_variants WHERE product_id = ? ORDER BY id', PID),
      all(w.raw, 'SELECT combo_key, channel, computed_price_iqd FROM pricing_sku_costs WHERE product_id = ? ORDER BY combo_key, channel', PID),
    ]);
  assert.equal(image(old), image(fresh));
  assert.equal(count(fresh.raw, 'SELECT COUNT(*) AS n FROM product_sku_prices'), 0);

  // A second option group stays refused as before (PRICE_SHAPE_UNSUPPORTED), and stays manual.
  addSizeGroup(old.raw);
  const two = await old.putInputs(A1, {
    inputs_seq: 0,
    inputs: [{ scope: 'base', supplier_cost_amount: '10', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000 }],
    rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '3' }, { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 5000 }],
  });
  assert.equal(two.status, 200, 'data only');
  assert.equal(two.body.mode, 'manual');
  assert.ok(two.body.adoption.missing_codes.includes('PRICE_SHAPE_UNSUPPORTED'), JSON.stringify(two.body.adoption.missing_codes));

  // The storefront reads without the table: the cart prices as the ladder says, no error.
  assert.equal(await charge(old, PID, [M0], C(4), 'sea'), sea(10, 3));
});
