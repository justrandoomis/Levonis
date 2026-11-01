/**
 * LIVE PRODUCTS KEEP THEIR PUBLISHED PRICES AND STATE when `sellableSkus` reads
 * the variant rows of a VARIANT_COMBINATION product (review finding data-1, the
 * live side; worker/lib/pricingEngine/legacy.ts).
 *
 *   - the census's products stocked per model × colour (a variant row for every
 *     cell) answer exactly the grid they answered before, and a V2 write over
 *     one of them prices every SKU and leaves nothing to write;
 *   - a V2-published product whose stored rows include a combination that has
 *     since lost its variant row (the cart refuses it: VARIANT_NOT_MODELLED)
 *     keeps every published row, the cart's price of every SKU it sells, its
 *     panel status and its staleness; only its next write drops the unbuyable
 *     row, and every real SKU keeps its price;
 *   - a model no variant row stocks (sold by pre-order only, as the admin
 *     editor leaves it, or its rows switched off) keeps its SKUs exactly as
 *     before: a first V2 publish writes its option level over the archived
 *     figure, the page and the card print the V2 prices only, and a product
 *     whose model lost its rows has nothing new to write.
 *
 * Run: node --import tsx --test tests/priceEstimateVariantGridLive.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, get, json, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { LEGACY_CENSUS, legacyProductId } from './fixtures/legacyCatalogue';
import { cartGrid, v2App, v2Context, writeV2 } from './fixtures/pricingV2';
import { sellableSkus } from '../worker/lib/pricingEngine/legacy';
import { evaluateV2Write, storedDesired } from '../worker/lib/pricingEngine/v2/evaluate';
import { staleReasonsV2 } from '../worker/lib/pricingEngine/v2/stale';
import { checkSelection } from '../worker/lib/commercialState';
import { snapshotFrom } from '../worker/lib/productOverlay';
import { productRoutes, saleAvailability } from '../worker/routes/products';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CUSTOMER: StubUser = { id: 'usr_cust', role: 'customer', email: 'c@x.co' };

/** What a customer is shown: `products.price_iqd` (feeds, sitemaps), the card's «from», the page's opening price and each model's level. */
async function shown(raw: DatabaseSync, pid: string, slug: string) {
  const shop = stubApp(asD1(raw), CUSTOMER, (a) => a.route('/api/products', productRoutes));
  const page = (await json(await get(shop, `/api/products/${slug}`))) as Json;
  return {
    price_iqd: row<Json>(raw, 'SELECT price_iqd FROM products WHERE id = ?', pid)!.price_iqd as number,
    display: page.product.display_price_iqd as number,
    base: page.price_levels.base.applied_iqd as number,
    option: Object.fromEntries(Object.entries(page.price_levels.option as Json).map(([k, v]) => [k, (v as Json).applied_iqd as number])),
  };
}

const optionRows = (raw: DatabaseSync, pid: string) =>
  all<Json>(raw, 'SELECT id, regular_price_iqd FROM product_option_values WHERE product_id = ? ORDER BY id', pid).map((r) => [r.id, r.regular_price_iqd]);

/** Spool and Refill (one model group) × the colours given, sold by pre-order by sea, a variant row for each combination named. */
function seedSpoolRefill(raw: DatabaseSync, o: { colours: Array<[string, string, string, string]>; variants: string[]; refillArchive?: number }): void {
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES ('p_fil', 'p-fil', 'PLA', 'بلا', 'پلا', 'active', 40000, NULL, 'pre_order', '["pre_order"]',
              '[{"method":"sea","commission_iqd":0,"active":true}]', 'VARIANT_COMBINATION', 1000, 400, 300, 200);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_m', 'p_fil', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, regular_price_iqd) VALUES
      ('m1', 'p_fil', 'g_m', 'Spool', 'بكرة', 'بەکرە', 0, 1, NULL), ('m2', 'p_fil', 'g_m', 'Refill', 'تعبئة', 'پڕکردنەوە', 1, 1, ${o.refillArchive ?? 'NULL'});
  `);
  o.colours.forEach(([id, en, ar, ckb], i) =>
    raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active) VALUES ('${id}', 'p_fil', '${en}', '${ar}', '${ckb}', '#336699', ${i}, 1)`)
  );
  o.variants.forEach((combo, i) => raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES ('pv_${i}', 'p_fil', '${combo}', 1)`));
  for (const v of ['m1', 'm2']) {
    raw.exec(`
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES ('f_${v}_p', 'p_fil', '${v}', 'pre_order', 1);
      INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled) VALUES ('t_${v}', 'p_fil', 'f_${v}_p', 'sea', 1);
    `);
  }
}

/** An FX-5 evaluation of the stored set (what the automatic repricing would write). */
async function storedEvaluation(db: D1Database, pid: string) {
  const c = await v2Context(db, pid);
  const desired = storedDesired(c.v2);
  return evaluateV2Write({ ...c, method: c.stored.state!.pricing_method as 'cost' | 'usd', points: desired.points, discounts: desired.discounts, inputWrites: [], ruleWrites: [], auto: true });
}

const skuRows = (raw: DatabaseSync, pid: string) =>
  all<Json>(raw, 'SELECT combo_key, channel, regular_price_iqd, write_seq FROM product_sku_prices WHERE product_id = ? ORDER BY combo_key, channel', pid);

test('the census products stocked per model × colour answer the grid they answered before; a V2 write prices every SKU and leaves nothing to write', async () => {
  const w = pricingWorld();
  const combos = LEGACY_CENSUS.filter((r) => r.inv_mode === 'VARIANT_COMBINATION');
  assert.ok(combos.length >= 10, 'the census has its VARIANT_COMBINATION products');
  for (const r of combos) {
    const { loaded } = await v2Context(w.db, legacyProductId(r.slug));
    const now = sellableSkus(loaded.doc, loaded.view);
    assert.deepEqual(now, sellableSkus(loaded.doc, { ...loaded.view!, inventory_mode: 'BASE' }), `${r.slug}: as before`);
    assert.equal(now.skus.length, r.skus as number, `${r.slug}: one SKU per variant row`);
  }

  const pid = legacyProductId('bambu-lab-pla-basic-filament');
  const ev = await writeV2(w.db, pid, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '20' }] });
  assert.equal(ev.complete, true);
  assert.equal(new Set(skuRows(w.raw, pid).map((r) => r.combo_key)).size, 60, 'two models × thirty colours');
  const again = await storedEvaluation(w.db, pid);
  assert.deepEqual([again.complete, again.needs_write, again.changes.length, again.stale], [true, false, 0, []]);
});

test('a V2-published product keeps its published prices and state when a combination loses its variant row; its next write drops only that row', async () => {
  const w = pricingWorld();
  const pid = 'p_vc';
  w.raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES ('p_vc', 'p-vc', 'Cable', 'كابل', 'کێبڵ', 'active', 500000, NULL, 'direct_sale', '["direct_sale","pre_order"]',
              '[{"method":"land","commission_iqd":10000,"active":true}]', 'VARIANT_COMBINATION', 1000, 400, 300, 200);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_a', 'p_vc', 'Type', 0, 1), ('g_b', 'p_vc', 'Length', 1, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
      ('a1', 'p_vc', 'g_a', 'A1', 'أ١', 'ئا١', 0, 1), ('a2', 'p_vc', 'g_a', 'A2', 'أ٢', 'ئا٢', 1, 1),
      ('b1', 'p_vc', 'g_b', 'B1', 'ب١', 'بێ١', 0, 1), ('b2', 'p_vc', 'g_b', 'B2', 'ب٢', 'بێ٢', 1, 1);
    INSERT INTO product_variants (id, product_id, combo_key, active, stock) VALUES
      ('pv_11', 'p_vc', 'o:a1|o:b1', 1, 5), ('pv_12', 'p_vc', 'o:a1|o:b2', 1, 5), ('pv_21', 'p_vc', 'o:a2|o:b1', 1, 5), ('pv_22', 'p_vc', 'o:a2|o:b2', 1, 5);
  `);
  for (const v of ['a1', 'a2']) {
    w.raw.exec(`
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES ('f_${v}_d', 'p_vc', '${v}', 'direct_sale', 1), ('f_${v}_p', 'p_vc', '${v}', 'pre_order', 1);
      INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled) VALUES ('t_${v}', 'p_vc', 'f_${v}_p', 'land', 1);
    `);
  }
  // Published while every cell had its row: A2 · B1 is the cheapest SKU ($10 − $3).
  const points = [
    { scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd: '10' },
    { scope: 'option' as const, scope_id: 'b2', kind: 'delta' as const, usd: '5' },
    { scope: 'option' as const, scope_id: 'a2', kind: 'delta' as const, usd: '-3' },
  ];
  await writeV2(w.db, pid, { method: 'usd', points });
  const published = skuRows(w.raw, pid);
  assert.equal(published.length, 8, 'four SKUs × direct and land');
  const cartBefore = await cartGrid(w.db, pid);
  const lowest = (rows: Json[]) => Math.min(...rows.map((r) => r.regular_price_iqd as number));
  assert.equal(row<Json>(w.raw, 'SELECT price_iqd FROM products WHERE id = ?', pid)!.price_iqd, lowest(published));

  // The owner stops selling A2 · B1: its variant row is switched off, and the cart refuses it from then on.
  w.raw.exec("UPDATE product_variants SET active = 0 WHERE id = 'pv_21'");
  const c = await v2Context(w.db, pid);
  const refused = saleAvailability(c.loaded.doc, {
    optionValueIds: ['a2', 'b1'],
    colorId: null,
    inventory: snapshotFrom(c.loaded.view!, { stock: null, reserved: 0, low_stock_threshold: null }),
  });
  assert.deepEqual([refused.selection.complete, refused.selection.errors.includes('VARIANT_NOT_MODELLED')], [false, true], JSON.stringify(refused.selection));
  assert.deepEqual(checkSelection(c.loaded.doc, c.loaded.view, ['a2', 'b1'], null), { ok: false, code: 'PRICE_REQUEST_SELECTION_INVALID' });

  // Nothing is written: every published row stays, the cart charges every SKU it sells what it charged before.
  assert.deepEqual(skuRows(w.raw, pid), published);
  const cartAfter = await cartGrid(w.db, pid);
  assert.deepEqual(Object.keys(cartAfter).sort(), Object.keys(cartBefore).filter((k) => !k.startsWith('o:a2|o:b1@')).sort());
  for (const [k, v] of Object.entries(cartAfter)) assert.deepEqual(v, cartBefore[k], k);

  // The state: current in the owner's panel, publishable, nothing stale, no price moves in an FX-5 evaluation.
  const panel = (await json(await get(v2App(w.raw), `/api/admin/products-v2/${pid}/pricing`))) as Json;
  assert.deepEqual([panel.status, panel.publishable, panel.needs_pricing], [{ kind: 'current' }, true, false]);
  assert.deepEqual(staleReasonsV2(c.v2!.results, c.rates!), []);
  const fx5 = await storedEvaluation(w.db, pid);
  assert.deepEqual([fx5.complete, fx5.codes, fx5.changes.length, fx5.stale, fx5.drafts], [true, [], 0, [], false]);
  const kept = published.filter((r) => r.combo_key !== 'o:a2|o:b1');
  assert.deepEqual(
    fx5.plan.prices.map((p) => [p.combo_key, p.channel, p.price.computed_price_iqd]).sort(),
    kept.map((r) => [r.combo_key, r.channel, r.regular_price_iqd]).sort(),
    'the SKUs it sells, at their published prices'
  );

  // Its next write keeps every real price and drops only the row the cart refuses.
  await writeV2(w.db, pid, { method: 'usd', points });
  assert.deepEqual(
    skuRows(w.raw, pid).map((r) => [r.combo_key, r.channel, r.regular_price_iqd]),
    kept.map((r) => [r.combo_key, r.channel, r.regular_price_iqd])
  );
  assert.equal(row<Json>(w.raw, 'SELECT price_iqd FROM products WHERE id = ?', pid)!.price_iqd, lowest(kept), 'the card’s «from» is a price it sells');
});

test('a model no variant row stocks keeps its SKU: a first V2 publish writes its level over the archived figure, and the page prints V2 prices only', async () => {
  const w = pricingWorld();
  // Refill is sold by pre-order only: the admin editor writes variant rows for direct-sale combinations only, so
  // it has none, and its option row still holds the archived 5,000 (DECISIONS rows 239/240: never shown).
  seedSpoolRefill(w.raw, { colours: [['c_red', 'Red', 'أحمر', 'سوور']], variants: ['o:m1|c:c_red'], refillArchive: 5000 });
  const c = await v2Context(w.db, 'p_fil');
  assert.deepEqual(sellableSkus(c.loaded.doc, c.loaded.view), sellableSkus(c.loaded.doc, { ...c.loaded.view!, inventory_mode: 'BASE' }), 'as before');

  await writeV2(w.db, 'p_fil', { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '20' }] });
  const v2 = row<Json>(w.raw, "SELECT price_iqd FROM products WHERE id = 'p_fil'")!.price_iqd as number;
  assert.ok(v2 > 5000, String(v2));
  assert.deepEqual(await shown(w.raw, 'p_fil', 'p-fil'), { price_iqd: v2, display: v2, base: v2, option: { m1: v2, m2: v2 } }, 'no archived figure anywhere');
  assert.deepEqual(optionRows(w.raw, 'p_fil'), [['m1', v2], ['m2', v2]], 'Refill’s level is written, as before');
  assert.deepEqual(all<Json>(w.raw, "SELECT DISTINCT combo_key FROM product_sku_prices WHERE product_id = 'p_fil' ORDER BY combo_key").map((r) => r.combo_key), ['o:m1|c:c_red', 'o:m2|c:c_red']);
});

test('a model whose variant rows all go off keeps its SKUs: what the page and the card print stays, and its next write has nothing to change', async () => {
  const w = pricingWorld();
  const RED: [string, string, string, string] = ['c_red', 'Red', 'أحمر', 'سوور'];
  const BLUE: [string, string, string, string] = ['c_blue', 'Blue', 'أزرق', 'شین'];
  seedSpoolRefill(w.raw, { colours: [RED, BLUE], variants: ['o:m1|c:c_red', 'o:m1|c:c_blue', 'o:m2|c:c_red', 'o:m2|c:c_blue'] });
  const points = [
    { scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd: '20' },
    { scope: 'option' as const, scope_id: 'm2', kind: 'delta' as const, usd: '-8' },
  ];
  await writeV2(w.db, 'p_fil', { method: 'usd', points });
  const rows = () => skuRows(w.raw, 'p_fil').map((r) => [r.combo_key, r.channel, r.regular_price_iqd]);
  const published = { rows: rows(), options: optionRows(w.raw, 'p_fil'), shown: await shown(w.raw, 'p_fil', 'p-fil') };
  assert.equal(published.rows.length, 4);
  const refill = published.options.find(([id]) => id === 'm2')![1] as number;
  assert.deepEqual([published.shown.price_iqd, published.shown.display, published.shown.base], [refill, refill, refill], 'Refill is the cheaper model');

  // Refill is no longer stocked: both of its variant rows go off (the value itself stays active).
  w.raw.exec("UPDATE product_variants SET active = 0 WHERE id IN ('pv_2', 'pv_3')");
  const c = await v2Context(w.db, 'p_fil');
  assert.deepEqual(sellableSkus(c.loaded.doc, c.loaded.view), sellableSkus(c.loaded.doc, { ...c.loaded.view!, inventory_mode: 'BASE' }), 'as before');
  assert.deepEqual({ rows: rows(), options: optionRows(w.raw, 'p_fil'), shown: await shown(w.raw, 'p_fil', 'p-fil') }, published);

  // Its next write (FX-5 or the owner's save) changes nothing, and nothing goes stale.
  const fx5 = await storedEvaluation(w.db, 'p_fil');
  assert.deepEqual([fx5.complete, fx5.codes, fx5.needs_write, fx5.changes.length, fx5.stale], [true, [], false, 0, []]);
  await writeV2(w.db, 'p_fil', { method: 'usd', points });
  assert.deepEqual({ rows: rows(), options: optionRows(w.raw, 'p_fil'), shown: await shown(w.raw, 'p_fil', 'p-fil') }, published);
});
