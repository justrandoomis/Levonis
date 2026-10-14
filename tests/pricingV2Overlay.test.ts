/**
 * PRICING V2-3 — THE V2-AWARE SKU READ (spec §3.4 productOverlay, C-3, C-13,
 * risks R-5, R-6, R-13).
 *
 * The overlay reads a product's SKU rows in ONE statement that also says
 * whether the product is V2 — and falls back to V1's read on a database
 * without 0189. Proves:
 *   - a V2 row counts while the V2 writer's result still says its price; its
 *     stored key `o:*` is the product itself (`''`); the customer's document of
 *     a V2 product — and only of a V2 product — is strict;
 *   - a V2 row whose result price differs is inert (and strict refuses the
 *     channel rather than pricing it from the ladder);
 *   - without the V2 results table the read falls back to V1's: V1 rows are
 *     read exactly as before, the V2 rows go inert, the ladder answers with the
 *     highest price — never 'absent', never `sku_prices_unread`; and a
 *     database migrated only through 0188 reads exactly as it did;
 *   - a malformed `o:*` row on a product WITH options never reaches its document;
 *   - the public projection carries neither the strict flag, nor the rows, nor
 *     their V2 flag.
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/pricingV2Overlay.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, dbThrough, get, row, stubApp } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { productRoutes } from '../worker/routes/products';
import { OWNER_ROW_SQL, applyRate } from './fixtures/fx';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { legacyProductId, seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { seedOptionless, writeV2, cartGrid } from './fixtures/pricingV2';
import { loadRelationsViews, applyRelations } from '../worker/lib/productOverlay';
import { parseProductRow, projectPublic } from '../worker/lib/productModel';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { v2EditorAnswer, v2OwnerAnswer } from '../worker/lib/pricingEngine/v2/dto';
import { v2Offerable } from '../worker/lib/skuLevels';

type World = ReturnType<typeof pricingWorld>;

const PID = legacyProductId('bambu-lab-pla-matte-1kg');
const C = (k: number) => `${PID}_c${k}`;
const OL = 'p_v2_ol';
const fixed = (usd: string) => ({ scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd });
const off = (usd: string) => ({ scope: 'product' as const, scope_id: '', usd });
const seqOf = (w: World, pid: string) => row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', pid)?.s ?? 0;

/** A V1 product priced per SKU (a colour holds its own supplier cost), through the owner's own V1 door. */
async function v1PerSku(w: World) {
  const draft = {
    inputs: [
      { scope: 'base', supplier_cost_amount: '10', supplier_cost_currency: 'USD', shipping_profile: 'CHINA_SEA', manual_cbm: '0.005' },
      { scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' },
    ],
    rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '3' }, { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 2000 }],
  };
  const first = await w.putInputs(PID, { inputs_seq: seqOf(w, PID), ...draft });
  const saved = await w.putInputs(PID, { inputs_seq: seqOf(w, PID), ...draft, preview_hash: first.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 400));
}

const viewsOf = async (w: World, ids: string[]) => loadRelationsViews(w.db, all<{ id: string; inventory_mode: string }>(w.raw, `SELECT id, inventory_mode FROM products WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids));

test('V2 rows count while their result says the price; o:* is the product itself; only a V2 document is strict', async () => {
  const w = pricingWorld();
  seedOptionless(w.raw, OL, { routes: ['land'] });
  await v1PerSku(w);
  await writeV2(w.db, OL, { method: 'usd', points: [fixed('500')], discounts: [off('25')] });
  const views = await viewsOf(w, [PID, OL, AMS]);
  const v1 = views.get(PID)!;
  const v2 = views.get(OL)!;
  assert.ok(v1.sku_prices!.length > 0, 'the V1 product has SKU rows');
  assert.ok(v1.sku_prices!.every((r) => !('v2' in r)), 'a V1 row never carries the V2 flag');
  assert.equal(v1.sku_strict, undefined);
  assert.deepEqual(v2.sku_prices, [
    { combo_key: '', channel: 'direct_sale', regular_price_iqd: 800_000, v2: true },
    { combo_key: '', channel: 'pre_order_land', regular_price_iqd: 760_000, v2: true },
  ]);
  assert.equal(v2.sku_strict, true);
  assert.deepEqual(views.get(AMS)!.sku_prices, [], 'a manual product: present, no row');
  assert.equal(views.get(AMS)!.sku_strict, undefined);
  // The option-less V2 product has no relational row at all, yet its document carries the rung and the flag.
  const doc = (await loadProducts(w.db, [OL])).get(OL)!.doc;
  assert.equal(v2.has_relations, false);
  assert.equal(doc.sku_strict, true);
  assert.equal(doc.sku_prices?.length, 2);
  // The public projection carries none of it.
  const pub = JSON.stringify(projectPublic(doc));
  for (const key of ['sku_strict', 'sku_prices', '"v2"', 'usd_ceil6', 'exact_iqd', 'discount_usd', 'deltas_usd', 'anchor']) assert.ok(!pub.includes(key), `the public projection carries no ${key}`);

  // A V2 row whose result price no longer matches is inert — and strict refuses the channel, never the ladder.
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${OL}', 1);
    UPDATE pricing_v2_sku_results SET final_price_iqd = 770000 WHERE product_id = '${OL}' AND channel = 'pre_order_land';
    DELETE FROM ops_guards WHERE id = 'engine-price:${OL}';`);
  const after = (await viewsOf(w, [OL])).get(OL)!;
  assert.deepEqual(after.sku_prices!.map((r) => r.channel), ['direct_sale']);
  const grid = await cartGrid(w.db, OL);
  assert.ok(grid['@pre_order_land']!.errors.includes('VARIANT_UNAVAILABLE'));
  assert.equal(grid['@direct_sale']!.prepaid, 800_000);
});

test('without the V2 results the read falls back to V1: V1 rows unchanged, V2 rows inert, the ladder holds the highest — never absent, never unread', async () => {
  const w = pricingWorld();
  seedOptionless(w.raw, OL, { routes: ['land'] });
  await v1PerSku(w);
  await writeV2(w.db, OL, { method: 'usd', points: [fixed('500')], discounts: [off('25')] });
  const before = (await viewsOf(w, [PID])).get(PID)!.sku_prices;
  // A deploy ahead of its migration (or 0189 rolled back): the table is gone.
  w.raw.exec('DROP TABLE pricing_v2_sku_results');
  const views = await viewsOf(w, [PID, OL]);
  assert.deepEqual(views.get(PID)!.sku_prices, before, 'V1 rows read exactly as before');
  for (const pid of [PID, OL]) {
    assert.ok(Array.isArray(views.get(pid)!.sku_prices), `${pid}: the rung is present, not 'absent'`);
    assert.equal(views.get(pid)!.sku_prices_unread, undefined, `${pid}: not a failed read`);
    assert.equal(views.get(pid)!.sku_strict, undefined);
  }
  assert.deepEqual(views.get(OL)!.sku_prices, [], 'the V2 rows are inert');
  const grid = await cartGrid(w.db, OL);
  assert.equal(grid['@direct_sale']!.prepaid, 800_000);
  assert.equal(grid['@pre_order_land']!.prepaid, 800_000, 'the ladder holds the highest price: never below the V2 price');

  // A database migrated only through 0188: the V1 read, exactly as it was.
  const raw = dbThrough('0188');
  raw.exec(OWNER_ROW_SQL);
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  applyRate(raw, 'USD_IQD', '1600');
  const old = pricingWorld({ raw });
  const oldViews = await viewsOf(old, [PID, AMS]);
  for (const pid of [PID, AMS]) {
    assert.deepEqual(oldViews.get(pid)!.sku_prices, []);
    assert.equal(oldViews.get(pid)!.sku_prices_unread, undefined);
    assert.equal(oldViews.get(pid)!.sku_strict, undefined);
  }
});

test('a malformed o:* row on a product with options never reaches its document (R-13)', async () => {
  const w = pricingWorld();
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000')], discounts: [off('50')] });
  // Forge a product-level row and its matching result under the token (only a bug or a raw write could).
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${AMS}', 1);
    INSERT INTO product_sku_prices (product_id, combo_key, channel, regular_price_iqd, source, write_seq, updated_at) VALUES ('${AMS}', 'o:*', 'direct_sale', 1000, 'ENGINE', 9, 'x');
    INSERT INTO pricing_v2_sku_results (product_id, combo_key, channel, method, anchor, final_price_iqd, exact_iqd, direct_price_iqd, direct_exact_iqd, usd_ceil6, usd_iqd_rate, usd_fx_version, inputs_seq, config_version, write_seq, computed_at)
      VALUES ('${AMS}', '', 'direct_sale', 'usd', 'product_fixed', 1000, '1000', 1000, '1000', '1', '1600', 1, 1, 1, 9, 'x');
    DELETE FROM ops_guards WHERE id = 'engine-price:${AMS}';`);
  const view = (await viewsOf(w, [AMS])).get(AMS)!;
  assert.ok(view.sku_prices!.some((r) => r.combo_key === ''), 'the view reads the row');
  const doc = applyRelations(parseProductRow(row<Record<string, unknown>>(w.raw, 'SELECT * FROM products WHERE id = ?', AMS)!), view);
  assert.equal(doc.sku_prices!.some((r) => r.combo_key === ''), false, 'the document drops it: a line with no model chosen is never priced from it');
});

test('the role projections are allow-lists: a price editor reads final dinars only; offers read D and P from the rows alone', async () => {
  const w = pricingWorld();
  const ev = await writeV2(w.db, AMS, { method: 'usd', points: [fixed('987.65')], discounts: [off('61.73')], dryRun: true });
  const editor = JSON.stringify(v2EditorAnswer(ev));
  // The method's LABEL is every editor's (§4.4); no USD figure, no rate, no cost-derived key.
  assert.doesNotMatch(editor, /"v2_|"owner"|usd_|_usd|exact|floor|replacement|1600|987\.65|61\.73/i, 'no private key, no rate, no dollar figure');
  assert.match(editor, /"price_iqd":1581000/, 'the final dinars are there');
  const owner = v2OwnerAnswer(ev);
  assert.equal(owner.v2_rate?.usd_iqd, '1600');
  assert.deepEqual(owner.v2_points, [{ scope: 'product', id: '', kind: 'fixed', usd: '987.65' }]);
  assert.ok(owner.table.every((r) => r.owner && typeof r.owner.v2_usd_ceil6 === 'string'));

  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('987.65')], discounts: [off('61.73')] });
  const doc = (await loadProducts(w.db, [AMS])).get(AMS)!.doc;
  assert.deepEqual(v2Offerable(doc, { optionValueIds: [`${AMS}_o0`], colorId: null }), { direct_iqd: 1_581_000, preorder: { land: 1_482_000 } });
  const v1 = (await loadProducts(w.db, [PID])).get(PID)!.doc;
  assert.equal(v2Offerable(v1, { optionValueIds: [`${PID}_o0`], colorId: C(0) }), null, 'a V1 product is not offerable this way');
});

test('the public product page of a V2 product carries its final prices only: no V2 flag, no dollar figure, no private result key', async () => {
  const w = pricingWorld();
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('987.65')], discounts: [off('61.73')] });
  const slug = row<{ s: string }>(w.raw, 'SELECT slug AS s FROM products WHERE id = ?', AMS)!.s;
  for (const user of [null, { id: 'u_c', role: 'customer', email: 'c@x.co' }] as const) {
    const app = stubApp(w.db, user, (a) => a.route('/api/products', productRoutes));
    for (const path of [`/api/products/${slug}`, '/api/products']) {
      const res = await get(app, path);
      assert.equal(res.status, 200, path);
      const text = await res.text();
      const body = JSON.parse(text) as unknown;
      assert.deepEqual(leaks(body, { decimals: ['987.65', '61.73', '1600'] }), [], `${user?.role ?? 'guest'} ${path}`);
      for (const key of ['sku_strict', '"v2":', 'usd_ceil6', 'exact_iqd', 'discount_usd', 'deltas_usd', '"anchor"', 'pricing_method']) assert.ok(!text.includes(key), `${path} carries no ${key}`);
      if (path.includes(slug)) assert.match(text, /1581000/, 'the final price is published');
    }
  }
});
