/**
 * FX-7 GAPS (DECISIONS row 202; migration 0183's SKU rung) — the four the
 * review listed, each against the real routes, the real engine writer and the
 * cart's own resolver on a real database with the 41 census products, at the
 * brief's rates (1 USD = 1,600 IQD; China sea 400,000 IQD per CBM; Germany land
 * 3,200 IQD per kg). Proves:
 *   1. one figure per product or model reads the rung as the cart does: the
 *      comparison's and the printer finder's model is «from» its lowest SKU
 *      (never the model's highest, which the ladder beneath the rung holds),
 *      the listing card is «from» the lowest sellable SKU, and the admin quote
 *      preview prices a whole selection (one value per group) at its SKU's own
 *      price;
 *   2. a failed read of the SKU prices is not a missing table: the overlay says
 *      so; back to manual pricing, an engine save (a per-model one included) and
 *      the bulk save refuse PRICING_READ_FAILED (503, retryable) and write
 *      nothing; the automatic repricing skips the product without blocking it
 *      and reprices it on the next good read;
 *   3. a product with no option whose colours are gone: its orphaned colour
 *      inputs are dropped from the plan — it is priced as the product itself
 *      again, no SKU row under an empty key, the old SKU rows removed;
 *   4. purchase lines per variant (and per colour) feed direct pricing at that
 *      variant's (that colour's) level as well as the model's (the product's): only where
 *      the purchase differs from what the level inherits, never above the
 *      owner's pricing weight, never with route freight (the double-freight
 *      guard); preorder stays unchanged; without 0183 the preview stays per model.
 *
 * Run: node --import tsx --test tests/skuPricesGaps.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, count, dbThrough, get, json, post, put, row, stubApp } from './fixtures/app';
import { applyRate, fxEnv, market, OWNER_ROW_SQL, pairOf } from './fixtures/fx';
import { OWNER_USER, pricingWorld } from './fixtures/procurementPricing';
import { legacyProductId, seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { loadPreviewContext, loadProducts } from '../worker/lib/pricingEngine/load';
import { loadRelationsView, loadRelationsViews } from '../worker/lib/productOverlay';
import { deriveProductEntries, type PurchaseForPricing, type PurchaseSkuLevels } from '../worker/lib/pricingEngine/fromPurchase';
import { loadProductPricing, type ProductPricingData, type StoredInputRow } from '../worker/lib/pricingEngine/store';
import { directPurchaseStore } from '../worker/lib/pricingEngine/directPurchase';
import { samePrices, type EngineAdoption } from '../src/components/adminOperations/procurementPricing';
import { resolveCartLine } from '../worker/routes/cart';
import { pricingCtxForUser, publicWithDisplayPrice, resolveVariantPricing } from '../worker/routes/products';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import type { Env } from '../worker/lib/types';

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
/** The pre-order price at U = 1,600: supplier $ + 0.005 CBM × 400,000 + the minimum profit $, rounded up. */
const sea = (usd: number, target: number, u = 1600) => ceil1000(usd * u + 0.005 * 400_000 + target * u);
/** The a1's land pre-order price: supplier $ + 1 kg × 3,200 + the minimum profit $. */
const land = (usd: number, target: number) => ceil1000(usd * 1600 + 1 * 3200 + target * 1600);

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
async function charge(w: World, pid: string, ids: string[], colour: string | null, route: '' | 'sea' | 'land', db: D1Database = w.db) {
  const loaded = (await loadProducts(db, [pid])).get(pid)!;
  const ctx = await loadPreviewContext(w.db);
  const r = resolveCartLine(
    loaded.row,
    { optionId: ids[0] ?? '', optionValueIds: ids, colorId: colour ?? '', transportMethod: route, fulfillmentType: route ? 'pre_order' : 'direct_sale', warrantyPlanId: '' },
    'free',
    false,
    ctx,
    loaded.view,
    'prepaid'
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

const TWO_GROUPS = {
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

const skuCount = (w: World, pid: string) => count(w.raw, 'SELECT COUNT(*) AS n FROM product_sku_prices WHERE product_id = ?', pid);

/** The same database, every read of the SKU rung failing as a temporary D1 error would (never "no such table"). */
function failingSkuReads(db: D1Database): D1Database {
  const boom = () => Promise.reject(new Error('D1_ERROR: Network connection lost.'));
  const fake = { bind: () => fake, all: boom, first: boom, run: boom, raw: boom };
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => (/^\s*SELECT[\s\S]*FROM product_sku_prices WHERE product_id/i.test(sql) ? fake : target.prepare(sql));
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** The pricing and purchase doors (as pricingWorld mounts them), over any D1. */
function pricingApp(db: D1Database) {
  return stubApp(db, OWNER_USER, (a) => {
    a.use('/api/admin/*', noStoreUnlessSet);
    a.route('/api/admin/pricing', adminPricingRoutes);
    a.route('/api/admin/procurement', adminProcurementRoutes);
  });
}

// ------------------------------------------------------------- 1. one figure reads the rung

test('the comparison, the finder, the listing card and the admin quote preview read the SKU rung: a two-group model is «from» its lowest SKU, a whole selection its own SKU — never the model’s highest', async () => {
  const w = pricingWorld();
  addSizeGroup(w.raw);
  const { preview } = await save(w, A1, TWO_GROUPS);
  assert.equal(preview.adoption.per_sku, true);
  const [m0, m1, small, large] = [`${A1}_o0`, `${A1}_o1`, `${A1}_s`, `${A1}_l`];
  const smallDirect = land(10, 3) + 5000;
  const largeDirect = land(15, 6) + 5000;
  assert.equal(await charge(w, A1, [m0, small], null, ''), smallDirect, 'the cart: the small SKU’s own price');
  assert.equal(await charge(w, A1, [m0, large], null, ''), largeDirect);

  const ctx = await pricingCtxForUser(w.db, null);
  const loaded = (await loadProducts(w.db, [A1])).get(A1)!;

  // The comparison's columns and the printer finder's configurations (`resolveVariantPricing`):
  // a model is «from» its lowest SKU — the ladder alone would say the model's highest (42,000).
  const variants = (await resolveVariantPricing(w.db, [loaded.row], ctx)).get(A1)!.options;
  const at = (id: string) => variants.find((v) => v.option.id === id)!;
  for (const m of [m0, m1]) {
    assert.equal(at(m).level.unit_subtotal_iqd, smallDirect, `${m}: its cheapest SKU, as the cart charges it`);
    assert.equal(at(m).from, true, `${m}: its SKUs differ — a «from» figure`);
  }
  assert.equal(at(small).level.unit_subtotal_iqd, smallDirect, 'a second group’s value: its own SKUs too, not the product’s base');
  assert.equal(at(large).level.unit_subtotal_iqd, largeDirect);
  assert.equal(at(large).from, false, 'every Large SKU costs the same: one price');

  // The listing card: «from» the lowest sellable SKU price (any channel — the shop's base), and it says «from».
  const card = publicWithDisplayPrice(loaded.row, ctx, loaded.view);
  const lowest = Math.min(...all<{ p: number }>(w.raw, 'SELECT regular_price_iqd AS p FROM product_sku_prices WHERE product_id = ?', A1).map((r) => r.p));
  assert.equal(card.display_price_iqd, lowest);
  assert.equal(card.display_from, true);

  // The admin quote preview: the whole selection (any order) is its SKU's price; the first group alone is the ladder.
  const admin = stubApp(w.db, OWNER_USER, (a) => a.route('/api/admin/products-v2', adminProductsRoutes));
  const quote = async (body: Record<string, unknown>) => {
    const res = await post(admin, `/api/admin/products-v2/${A1}/quote`, body);
    const out = await json(res);
    assert.equal(res.status, 200, JSON.stringify(out));
    return out.quote as { regular_iqd: number; unit_subtotal_iqd: number; errors: string[] };
  };
  assert.equal((await quote({ optionId: m0, optionValueIds: [small, m0] })).unit_subtotal_iqd, smallDirect);
  assert.equal((await quote({ optionValueIds: [m1, large] })).unit_subtotal_iqd, largeDirect);
  assert.equal((await quote({ optionValueIds: [m0, small], transportMethod: 'land' })).unit_subtotal_iqd, land(10, 3), 'a route: the SKU’s pre-order price');
  assert.equal((await quote({ optionId: m0 })).unit_subtotal_iqd, largeDirect, 'one group alone: the ladder beneath the rung (the model’s highest)');
  // Junk in the list is dropped, never trusted.
  assert.equal((await quote({ optionValueIds: [m0, small, 7, '', null] })).unit_subtotal_iqd, smallDirect);
});

// ------------------------------------------------------------- 2. a failed read is not a missing table

test('a failed read of the SKU prices is not a missing table: back to manual, an engine save and the bulk save refuse PRICING_READ_FAILED (503) and write nothing; the automatic run skips without blocking', async () => {
  const w = pricingWorld();
  await save(w, PID, { ...BASE, inputs: [...BASE.inputs, { scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' }] });
  const rows = skuCount(w, PID);
  assert.equal(rows, 2 * 25 * 2, 'priced per SKU');
  const failing = failingSkuReads(w.db);

  // The overlay: a failed read says so; a missing table does not.
  const one = await loadRelationsView(failing, PID, 'VARIANT_COMBINATION');
  assert.equal(one.sku_prices, null);
  assert.equal(one.sku_prices_unread, true);
  const page = (await loadRelationsViews(failing, [{ id: PID, inventory_mode: 'VARIANT_COMBINATION' }])).get(PID)!;
  assert.equal(page.sku_prices_unread, true);
  const healthy = await loadRelationsView(w.db, PID, 'VARIANT_COMBINATION');
  assert.equal(healthy.sku_prices?.length, rows);
  assert.equal(healthy.sku_prices_unread, undefined);
  const before0183 = await loadRelationsView(worldThrough('0182').db, PID, 'VARIANT_COMBINATION');
  assert.equal(before0183.sku_prices, null);
  assert.equal(before0183.sku_prices_unread, undefined, 'no table: absent, not failed');

  // The storefront degrades to the ladder — the model's highest, never lower — and does not fail.
  assert.ok((await charge(w, PID, [M0], C(1), 'sea', failing)) >= (await charge(w, PID, [M0], C(1), 'sea')));

  const image = () =>
    JSON.stringify([
      all(w.raw, 'SELECT * FROM product_sku_prices WHERE product_id = ? ORDER BY combo_key, channel', PID),
      all(w.raw, 'SELECT * FROM product_pricing_state WHERE product_id = ?', PID),
      all(w.raw, 'SELECT * FROM pricing_inputs WHERE product_id = ? ORDER BY scope, scope_id', PID),
      count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'),
    ]);
  const snapshot = image();
  const app = pricingApp(failing);
  const refused = async (res: Response) => {
    const body = await json(res);
    assert.deepEqual([res.status, body.code], [503, 'PRICING_READ_FAILED'], JSON.stringify(body).slice(0, 300));
    assert.equal(body.error, `${COST_REFUSALS.PRICING_READ_FAILED.ar} / ${COST_REFUSALS.PRICING_READ_FAILED.en}`);
  };

  // Back to manual: the flip without the SKU rows' delete would leave them overriding every manual price.
  const ws = row<{ s: number }>(w.raw, 'SELECT write_seq AS s FROM product_pricing_state WHERE product_id = ?', PID)!.s;
  await refused(await post(app, `/api/admin/pricing/products/${PID}/manual`, { write_seq: ws }));
  // An engine save — here one that returns the product to per-model pricing (the colour's value cleared).
  await refused(
    await put(app, `/api/admin/pricing/products/${PID}/inputs`, { inputs_seq: seqOf(w, PID), inputs: [{ scope: 'color', scope_id: C(0), supplier_cost_amount: null, supplier_cost_currency: null }] })
  );
  await refused(await put(app, `/api/admin/pricing/products/${PID}/inputs`, { inputs_seq: seqOf(w, PID), inputs: [{ scope: 'base', supplier_cost_amount: '11', supplier_cost_currency: 'USD' }] }));
  await refused(await get(app, `/api/admin/pricing/products/${PID}/inputs`));
  // The bulk save: that product refused with the code, the request itself answered.
  const bulk = await post(app, '/api/admin/pricing/products/save-bulk', { items: [{ product_id: PID, preview_hash: '0'.repeat(64) }] });
  assert.equal(bulk.status, 200);
  assert.deepEqual((await json(bulk)).results, [{ product_id: PID, status: 'refused', code: 'PRICING_READ_FAILED' }]);
  assert.equal(image(), snapshot, 'nothing written');

  // The automatic repricing (FX-5): the dollar moves, the read fails — skipped, not blocked, no bell.
  const now = new Date();
  const m = market({ sell: 1632, usd: '1.1', cny: '7.857143' });
  m.state.at = now;
  m.state.ecbDay = now.toISOString().slice(0, 10);
  const run = await runFxScheduler({ ...fxEnv(w.raw, { DB: failing }), STORE_ROOT_DOMAIN: 'levonis-iq.com' } as Env, { now, scheduledTime: now }, { trigger: 'cron', fetchImpl: m.f.fetch });
  assert.equal(pairOf(w.raw, 'USD_IQD').effective_rate, '1632');
  assert.ok(!(run.repricing?.repriced ?? []).includes(PID));
  assert.ok(!(run.repricing?.blocked ?? []).some((b) => b.product_id === PID), JSON.stringify(run.repricing?.blocked));
  assert.equal(row<{ c: string | null }>(w.raw, 'SELECT reprice_blocked_code AS c FROM product_pricing_state WHERE product_id = ?', PID)!.c, null);
  assert.equal(skuCount(w, PID), rows);
  assert.equal(await charge(w, PID, [M0], C(0), 'sea'), sea(12, 3), 'still the old rate’s price');

  // The next good read: back to manual succeeds and the SKU rows go with it.
  const exit = await post(w.app, `/api/admin/pricing/products/${PID}/manual`, { write_seq: ws });
  assert.equal(exit.status, 200, JSON.stringify(await json(exit)));
  assert.equal(skuCount(w, PID), 0);
});

// ------------------------------------------------------------- 3. orphaned colour inputs

test('a product with no option whose colours are gone: its orphaned colour inputs are dropped from the plan — priced as the product itself, no SKU row under an empty key, the old ones removed', async () => {
  const w = pricingWorld();
  const P = 'px_colours';
  w.raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, price_iqd, status, stock, options, colors, selling_type, sale_types, preorder_transports, images, inventory_mode)
    VALUES ('${P}', 'px-colours', 'Colours only', 'ألوان فقط', 'تەنها ڕەنگ', 50000, 'active', 5, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '[]', 'COLOR');
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock)
    VALUES ('${P}_c0', '${P}', 'Red', 'أحمر', 'سوور', '#cc0000', 0, 1, 5), ('${P}_c1', '${P}', 'Blue', 'أزرق', 'شین', '#0000cc', 1, 1, 5);
  `);
  const { preview } = await save(w, P, { ...BASE, inputs: [...BASE.inputs, { scope: 'color', scope_id: `${P}_c0`, supplier_cost_amount: '12', supplier_cost_currency: 'USD' }] });
  assert.equal(preview.adoption.per_sku, true);
  assert.equal(await charge(w, P, [], `${P}_c0`, ''), sea(12, 3) + 2000);
  assert.equal(await charge(w, P, [], `${P}_c1`, ''), sea(10, 3) + 2000);
  assert.equal(skuCount(w, P), 2);

  // The colours are deleted; the colour input stays (the owner's data is never dropped from the table).
  w.raw.exec(`DELETE FROM product_colors WHERE product_id = '${P}'`);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ? AND scope = 'color'", P), 1);

  const next = await save(w, P, { inputs: [{ scope: 'base', supplier_cost_amount: '11', supplier_cost_currency: 'USD' }] });
  assert.equal(next.preview.adoption.per_sku, false, 'the orphaned colour level names nothing sellable');
  assert.deepEqual(next.preview.adoption.missing_codes, []);
  assert.equal(skuCount(w, P), 0, 'the old SKU rows removed; none under an empty key');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_sku_costs WHERE product_id = ? AND combo_key <> ''", P), 0);
  assert.equal(row<{ p: number }>(w.raw, 'SELECT price_iqd AS p FROM products WHERE id = ?', P)!.p, sea(11, 3) + 2000);
  assert.equal(await charge(w, P, [], null, ''), sea(11, 3) + 2000);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ? AND scope = 'color'", P), 1, 'kept, unused');
});

// ------------------------------------------------------------- 4. purchase lines per variant / colour

/** A china-sea purchase (in CNY, the route's currency) of PLA variant rows: [variant index, unit CNY]. CNY 1 = $0.14 centrally. */
function plaPurchase(w: World, lines: Array<[number, number]>) {
  return w.draft({
    currency: 'CNY',
    exchange_rate: 230,
    cost_profile_id: 'china_sea',
    cost_profile_version: w.profileVersion('china_sea'),
    shipping_rate_iqd: 400_000,
    lines: lines.map(([v, usd]) => ({ product_id: PID, scope: 'variant', scope_id: `${PID}_v${v}`, qty_ordered: 2, source_unit_amount: usd, weight_g: 1000, volume_mm3: 5_000_000 })),
  });
}

test('purchase lines per variant feed direct pricing at that variant’s own level as well as its model’s; preorder stays unchanged, the cart charges each direct SKU its own, and without 0183 preview keeps model scope', async () => {
  const w = pricingWorld();
  await save(w, PID, BASE);
  // v0 = model 1 · colour 1 at CNY 100 ($14), v1 = model 1 · colour 2 at CNY 50 ($7).
  const d = plaPurchase(w, [[0, 100], [1, 50]]);
  const look = await w.preview({ draft: d });
  assert.equal(look.status, 200, JSON.stringify(look.body).slice(0, 400));
  const product = (look.body.products as Array<{ product_id: string; preview_hash: string; adoption: EngineAdoption; entries: Array<{ scope: string; scope_id: string; changes: Record<string, { after: unknown }> }> }>).find((p) => p.product_id === PID)!;
  const entryAt = (scope: string, id: string) => product.entries.find((e) => e.scope === scope && e.scope_id === id);
  // The model (narrow, the maximum: what an older store did) and each variant's own level.
  assert.equal(entryAt('option', M0)?.changes.supplier_cost_amount?.after, '100');
  assert.deepEqual(Object.keys(entryAt('sku', sku([M0], C(0)))?.changes ?? {}), [], 'v0 = its model’s new value: it keeps inheriting');
  assert.deepEqual(entryAt('sku', sku([M0], C(1)))?.changes.supplier_cost_amount?.after, '50');
  assert.equal(entryAt('sku', sku([M0], C(1)))?.changes.manual_cbm, undefined, 'the CBM it inherits is the same: not pinned');

  const id = await w.save(d);
  const pricingSnapshot = () => JSON.stringify(['pricing_inputs', 'pricing_rules', 'pricing_sku_costs', 'product_sku_prices', 'pricing_direct_purchase'].map((table) => all(w.raw, `SELECT * FROM ${table} WHERE product_id = ? ORDER BY rowid`, PID)));
  const beforeApply = pricingSnapshot();
  const ordinaryInputs = all(w.raw, 'SELECT * FROM pricing_inputs WHERE product_id = ? ORDER BY rowid', PID);
  const preorderCosts = all(w.raw, "SELECT * FROM pricing_sku_costs WHERE product_id = ? AND channel <> 'direct_sale' ORDER BY rowid", PID);
  const preorderPrices = all(w.raw, "SELECT * FROM product_sku_prices WHERE product_id = ? AND channel <> 'direct_sale' ORDER BY rowid", PID);
  // The committed purchase gets its durable source id. The confirm loop takes
  // its fresh hash only when it writes exactly the direct prices reviewed.
  const stale = await w.apply(PID, { purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'PRICING_PREVIEW_STALE');
  assert.equal(pricingSnapshot(), beforeApply, 'the refused draft hash writes nothing');
  assert.equal(samePrices(stale.body.details.preview.adoption, product.adoption), true, 'the UI can safely retry only the already-reviewed direct prices');
  const applyBody = { purchase_id: id, preview_hash: stale.body.details.preview.preview_hash, confirm_large_change: true };
  const applied = await w.apply(PID, applyBody);
  assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 400));
  const direct = directPurchaseStore(await loadProductPricing(w.db, PID));
  const skuInputs = direct.inputs.filter((r) => r.scope === 'sku').map(({ scope_id, supplier_cost_amount, source_ref, manual_cbm }) => ({ scope_id, supplier_cost_amount, source_ref, manual_cbm }));
  assert.deepEqual(skuInputs, [{ scope_id: sku([M0], C(1)), supplier_cost_amount: '50', source_ref: `purchase:${id}`, manual_cbm: null }]);
  assert.deepEqual(all(w.raw, 'SELECT * FROM pricing_inputs WHERE product_id = ? ORDER BY rowid', PID), ordinaryInputs, 'ordinary input rows remain unchanged');
  assert.deepEqual(all(w.raw, "SELECT * FROM pricing_sku_costs WHERE product_id = ? AND channel <> 'direct_sale' ORDER BY rowid", PID), preorderCosts, 'preorder cost rows remain unchanged');
  assert.deepEqual(all(w.raw, "SELECT * FROM product_sku_prices WHERE product_id = ? AND channel <> 'direct_sale' ORDER BY rowid", PID), preorderPrices, 'preorder price rows remain unchanged');
  for (const [model, colour] of [[M0, C(0)], [M0, C(1)], [M0, C(5)], [M1, C(1)]]) {
    assert.equal(await charge(w, PID, [model!], colour!, 'sea'), sea(10, 3), 'preorder retains its ordinary supplier cost');
  }
  assert.equal(await charge(w, PID, [M0], C(0), ''), sea(14, 3) + 2000, 'v0 direct: its purchase');
  assert.equal(await charge(w, PID, [M0], C(1), ''), sea(7, 3) + 2000, 'v1 direct: its own purchase, not its model’s CNY 100');
  assert.equal(await charge(w, PID, [M0], C(5), ''), sea(14, 3) + 2000, 'an unbought colour inherits its model’s new direct value');
  assert.equal(await charge(w, PID, [M1], C(1), ''), sea(10, 3) + 2000, 'the other model stays untouched');
  const afterApply = pricingSnapshot();
  const replay = await w.apply(PID, applyBody);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.already, true);
  assert.equal(pricingSnapshot(), afterApply, 'an exact replay changes neither price nor input rows');

  // Deploy-ahead: without 0183 the same purchase preview stays at model scope.
  const old = worldThrough('0182');
  const od = plaPurchase(old, [[0, 100], [1, 50]]);
  const oldLook = await old.preview({ draft: od });
  assert.equal(oldLook.status, 200, JSON.stringify(oldLook.body).slice(0, 400));
  const oldProduct = (oldLook.body.products as Array<{ product_id: string; entries: Array<{ scope: string }> }>).find((p) => p.product_id === PID)!;
  assert.deepEqual([...new Set(oldProduct.entries.map((e) => e.scope))], ['option']);
});

const storedWith = (rows: Array<Partial<StoredInputRow>>): ProductPricingData => ({
  product_id: 'p1',
  state: null,
  config_version: 0,
  rules: [],
  inputs: rows.map((r) => ({
    product_id: 'p1', scope: 'base', scope_id: '', origin: 'MANUAL_OVERRIDE', supplier_cost_amount: null, supplier_cost_delta: null,
    supplier_cost_currency: null, supplier_input_mode: null, original_input_amount: null, original_input_currency: null,
    conversion_rate_snapshot: null, conversion_fx_version: null, canonical_supplier_cost_usd: null, converted_at: null,
    shipping_profile: 'GERMANY_LAND', pricing_weight_g: null, shipping_weight_g: null, shipping_length_mm: null, shipping_width_mm: null,
    shipping_height_mm: null, manual_cbm: null, additional_cost_iqd: null, unresolved_fields: '[]', source_ref: '', version: 1, updated_at: '',
    ...r,
  })) as StoredInputRow[],
});

/** A colour-only product: three colours, each one sellable SKU. */
const COLOUR_LEVELS: PurchaseSkuLevels = {
  color: new Set(['c1', 'c2', 'c3']),
  sku: new Set(['c:c1', 'c:c2', 'c:c3']),
  variants: new Map(),
  units: ['c1', 'c2', 'c3'].map((c) => ({ option_value_ids: [], color_id: c, combo_key: `c:${c}` })),
};

/** Germany land, EUR: colour c1 at 450 (2.0 kg) and c2 at 500 (3.0 kg); freight on both, packaging per colour. */
const colourLines = (): PurchaseForPricing => ({
  purchase_id: 'po_colour_gaps',
  status: 'ordered',
  cost_state: 'final',
  currency: 'EUR',
  exchange_rate: 1760,
  profile: { id: 'germany_land', shipping_basis: 'weight' },
  lines: [
    { index: 0, line_id: null, key: 'p1:color:c1', product_id: 'p1', scope: 'color', scope_id: 'c1', option_id: null, label: 'c1', qty: 1, cost_mode: 'unit', source_amount: 450, weight_g: 2000, volume_mm3: 0, store_price_iqd: null },
    { index: 1, line_id: null, key: 'p1:color:c2', product_id: 'p1', scope: 'color', scope_id: 'c2', option_id: null, label: 'c2', qty: 1, cost_mode: 'unit', source_amount: 500, weight_g: 3000, volume_mm3: 0, store_price_iqd: null },
  ],
  charges: [
    { title: 'شحن محلي', pricing_role: 'excluded', shares: [{ index: 0, amount_iqd: 16_000 }, { index: 1, amount_iqd: 16_000 }] },
    { title: 'تغليف أ', pricing_role: 'additional', shares: [{ index: 0, amount_iqd: 3_000 }] },
    { title: 'تغليف ب', pricing_role: 'additional', shares: [{ index: 1, amount_iqd: 5_000 }] },
  ],
});

test('purchase lines per colour feed the colour’s own level: what differs from the inherited value, never route freight (the double-freight guard), never above the owner’s pricing weight', () => {
  const stored = storedWith([{ supplier_cost_amount: '500', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', shipping_weight_g: 3000 }]);
  const d = deriveProductEntries(colourLines(), 'p1', stored, { optIn: new Set(), prefer: false, usePurchase: true, rates: null, levels: COLOUR_LEVELS });
  const at = (scope: string, id: string) => d.entries.find((e) => e.write.scope === scope && e.write.scope_id === id)!;
  // The product (narrow, never lower): its supplier and weight kept, the packaging maximum taken.
  assert.equal(at('base', '').narrow, true);
  assert.equal(at('base', '').write.set.supplier_cost_amount, undefined);
  assert.equal(at('base', '').write.set.additional_cost_iqd, 5_000);
  // c1 differs from what it inherits (500 EUR, 3 kg, 5,000): its own values; the freight never.
  assert.deepEqual(at('color', 'c1').write.set, { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_weight_g: 2000, additional_cost_iqd: 3_000 });
  assert.equal(at('color', 'c1').narrow, false);
  // c2 is exactly what it inherits: it keeps inheriting.
  assert.deepEqual(at('color', 'c2').write.set, {});
  for (const e of d.entries) assert.notEqual(e.write.set.additional_cost_iqd, 16_000, 'route freight never feeds pricing');
  assert.deepEqual(d.proposals, [], 'no profile proposed at a colour (the product resolves one)');

  // The owner's pricing weight decides above the colour: the purchase's shipping weight is not written there.
  const weighed = storedWith([{ supplier_cost_amount: '500', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', shipping_weight_g: 3000, pricing_weight_g: 3500 }]);
  const w2 = deriveProductEntries(colourLines(), 'p1', weighed, { optIn: new Set(), prefer: false, usePurchase: true, rates: null, levels: COLOUR_LEVELS });
  assert.equal(w2.entries.find((e) => e.write.scope === 'color' && e.write.scope_id === 'c1')!.write.set.shipping_weight_g, undefined);
  assert.ok(w2.shadowed.some((x) => x.scope === 'color' && x.scope_id === 'c1' && x.field === 'shipping_weight_g'), JSON.stringify(w2.shadowed));

  // A colour with its own row: replaced exactly (the purchase priced that colour).
  const own = storedWith([
    { supplier_cost_amount: '500', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', shipping_weight_g: 3000 },
    { scope: 'color', scope_id: 'c2', supplier_cost_amount: '520', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', shipping_profile: null },
  ]);
  const d3 = deriveProductEntries(colourLines(), 'p1', own, { optIn: new Set(), prefer: false, usePurchase: true, rates: null, levels: COLOUR_LEVELS });
  assert.equal(d3.entries.find((e) => e.write.scope === 'color' && e.write.scope_id === 'c2')!.write.set.supplier_cost_amount, '500');

  // Without the SKU rung (no levels): the product's scope alone, exactly as before.
  const before = deriveProductEntries(colourLines(), 'p1', stored, { optIn: new Set(), prefer: false, usePurchase: true, rates: null });
  assert.deepEqual(before.entries.map((e) => e.write.scope), ['base']);
});
