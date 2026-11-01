/**
 * A COMBINATION A PRODUCT DOES NOT SELL IS «NOT AVAILABLE», NEVER «طلب السعر»
 * (review r2-quote; docs/SMART_PRICING.md §3.5 rule 3).
 *
 * A VARIANT_COMBINATION product's grid leaves out a combination with no active
 * variant row when each of its choices is stocked in another (`sellableSkus`):
 * the cart refuses it (VARIANT_NOT_MODELLED) and so does «طلب السعر»
 * (PRICE_REQUEST_SELECTION_INVALID). On the plain chooser (an owner-built
 * product: no group kind, default or swatch) a customer can still form it, so:
 *
 *   - `unofferedSkuKeys` names those combinations, and only those: none for a
 *     grid with a row for every cell, another mode, or no active row; the
 *     quote's per-selection `selectionUnoffered` agrees with it;
 *   - the page body lists them (`unoffered_selections`, absent when none) on a
 *     priced and on a catalog-only product;
 *   - the quote of a partly priced product answers such a combination on its
 *     ordinary path (VARIANT_NOT_MODELLED), never `price_status: 'unpriced'`;
 *     a valid unpriced SKU, and a part of a selection naming an unpriced
 *     choice, still answer 'unpriced';
 *   - the quote of a catalog-only product keeps its 409 PRICE_NOT_AVAILABLE and
 *     adds `selection_errors: ['VARIANT_NOT_MODELLED']` for such a combination
 *     only;
 *   - over every complete selection, a quote that answers 'unpriced' (or the
 *     plain catalog-only 409) is one «طلب السعر» takes;
 *   - the page never offers «طلب السعر» for such a combination, nor prices it
 *     (review r3-unoffered-page, r3-level-left-out): it asks no quote, shows no
 *     figure (price card, route rows, «من …», level price, a colour row's unit),
 *     and says «غير متاح مع هذا الاختيار»; a catalog-only page says it in place
 *     of the request panel;
 *   - `selectionUnoffered` is never true for a part of a SKU the product sells,
 *     nor on a grid without relations too large to list (r3-unoffered-nonrel);
 *   - the page never prints a code (r3-raw-codes): every code the server can
 *     send it has words in ar, en and ckb, and one with none says nothing.
 *
 * Run: node --import tsx --test tests/priceEstimateStorefrontUnoffered.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, stubApp, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { pricingWorld } from './fixtures/procurementPricing';
import { writeV2 } from './fixtures/pricingV2';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { sellableSkus } from '../worker/lib/pricingEngine/legacy';
import { checkSelection, selectionUnoffered, unofferedSkuKeys } from '../worker/lib/commercialState';
import type { ProductDoc } from '../worker/lib/productModel';
import type { ProductRelationsView } from '../worker/lib/productOverlay';
import { productRoutes } from '../worker/routes/products';
import { priceRequestRoutes } from '../worker/routes/priceRequests';
import { SKU_STRICT_ERROR } from '../packages/pricing/src/pricing';
import { WARRANTY_NOT_PRINTER } from '../packages/pricing/src/warrantyPlanMath';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CUSTOMER: StubUser = { id: 'usr_cust', role: 'customer', email: 'c@x.co' };
const k = (...ids: string[]) => [...ids].sort().map((id) => `o:${id}`).join('|');

/**
 * An owner-built cable sold by pre-order over land: Type A1/A2 × Length B1/B2, stocked as A1·B1 and A2·B2
 * only. A1·B2 and A2·B1 are left out (each of their choices is stocked in the other row).
 */
function seedCable(raw: DatabaseSync, id: string, rows: string[][] = [['a1', 'b1'], ['a2', 'b2']]): void {
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES ('${id}', '${id}', 'Cable', 'كابل', 'کێبڵ', 'active', 0, NULL, 'pre_order', '["pre_order"]',
              '[{"method":"land","commission_iqd":0,"active":true}]', 'VARIANT_COMBINATION', 1000, 400, 300, 200);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('${id}_ga', '${id}', 'Type', 0, 1), ('${id}_gb', '${id}', 'Length', 1, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
      ('${id}_a1', '${id}', '${id}_ga', 'A1', 'أ١', 'ئا١', 0, 1), ('${id}_a2', '${id}', '${id}_ga', 'A2', 'أ٢', 'ئا٢', 1, 1),
      ('${id}_b1', '${id}', '${id}_gb', 'B1', 'ب١', 'بێ١', 0, 1), ('${id}_b2', '${id}', '${id}_gb', 'B2', 'ب٢', 'بێ٢', 1, 1);
  `);
  rows.forEach((r, i) => {
    raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES ('${id}_pv${i}', '${id}', '${k(...r.map((v) => `${id}_${v}`))}', 1)`);
  });
  for (const v of ['a1', 'a2']) {
    raw.exec(`
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES ('${id}_f_${v}', '${id}', '${id}_${v}', 'pre_order', 1);
      INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled) VALUES ('${id}_t_${v}', '${id}', '${id}_f_${v}', 'land', 1);
    `);
  }
}

/** A V2 write's SKU row removed, as a structure change after publication leaves it: that SKU has no price. */
function unpriceSku(raw: DatabaseSync, id: string, combo: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${id}', 1);
    DELETE FROM product_sku_prices WHERE product_id = '${id}' AND combo_key = '${combo}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${id}';`);
}

async function shop() {
  const w = pricingWorld();
  w.raw.exec("INSERT OR IGNORE INTO users (id, email, role) VALUES ('usr_cust', 'c@x.co', 'customer')");
  const app = stubApp(
    asD1(w.raw),
    CUSTOMER,
    (a) => {
      a.route('/api/products', productRoutes);
      a.route('/api/price-requests', priceRequestRoutes);
    },
    { publishV2: false }
  );
  return { ...w, app };
}

type App = Awaited<ReturnType<typeof shop>>['app'];
const quote = async (app: App, slug: string, ids: string[]) => {
  const res = await post(app, `/api/products/${slug}/quote`, { optionValueIds: ids, fulfillmentType: 'pre_order', transportMethod: 'land' });
  return { status: res.status, body: (await json(res)) as Json };
};
const request = async (app: App, id: string, ids: string[]) => {
  const res = await post(app, '/api/price-requests', { product_id: id, option_value_ids: ids });
  return { status: res.status, body: (await json(res)) as Json };
};
/** Every complete selection of the cable: one Type × one Length. */
const complete = (id: string) => ['a1', 'a2'].flatMap((a) => ['b1', 'b2'].map((b) => [`${id}_${a}`, `${id}_${b}`]));

// ---------------------------------------------------------------- the rule

test('unofferedSkuKeys: the combinations the grid leaves out — none for a full grid, another mode or no active row', async () => {
  const raw = freshDb();
  seedCable(raw, 'pc');
  seedCable(raw, 'pf', [['a1', 'b1'], ['a1', 'b2'], ['a2', 'b1'], ['a2', 'b2']]);
  seedCable(raw, 'po');
  raw.exec("UPDATE products SET inventory_mode = 'OPTION' WHERE id = 'po'");
  seedCable(raw, 'pn');
  raw.exec("UPDATE product_variants SET active = 0 WHERE product_id = 'pn'");
  // A length no row stocks: its cells stay (the cart refuses them, «طلب السعر» takes them), as before.
  seedCable(raw, 'p3');
  raw.exec("INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('p3_b3', 'p3', 'p3_gb', 'B3', 2, 1)");
  const loaded = await loadProducts(asD1(raw), ['pc', 'pf', 'po', 'pn', 'p3']);
  const of = (id: string) => unofferedSkuKeys(loaded.get(id)!.doc, loaded.get(id)!.view);
  assert.deepEqual(of('pc'), [k('pc_a1', 'pc_b2'), k('pc_a2', 'pc_b1')]);
  assert.deepEqual(of('pf'), [], 'a row for every cell');
  assert.deepEqual(of('po'), [], 'another inventory mode');
  assert.deepEqual(of('pn'), [], 'no active row');
  assert.deepEqual(of('p3'), [k('p3_a1', 'p3_b2'), k('p3_a2', 'p3_b1')], 'B3 keeps its two cells');
  // Exactly what the request door refuses as not part of the product, among the grid's cells; and the quote's
  // per-selection question agrees with the list on every selection, complete or not.
  for (const id of ['pc', 'pf', 'po', 'pn', 'p3']) {
    const { doc, view } = loaded.get(id)!;
    const values = ['a1', 'a2', 'b1', 'b2', 'b3'].map((v) => `${id}_${v}`);
    const asked = [...complete(id), ...values.map((v) => [v]), [values[0], values[1]], [values[0], 'nope'], []];
    for (const sel of asked) {
      const left = of(id).includes(k(...sel));
      assert.equal(selectionUnoffered(doc, view, sel, null), left, `${sel.join('·')}`);
      if (left) assert.deepEqual(checkSelection(doc, view, sel, null), { ok: false, code: 'PRICE_REQUEST_SELECTION_INVALID' });
    }
  }
  const { doc, view } = loaded.get('pc')!;
  for (const sel of complete('pc')) assert.equal(checkSelection(doc, view, sel, null).ok, !of('pc').includes(k(...sel)), sel.join('·'));
});

// ---------------------------------------------------------------- a partly priced product

test('a partly priced product: a combination it does not sell is quoted «not available», never «طلب السعر»; its unpriced SKU still is', async () => {
  const w = await shop();
  seedCable(w.raw, 'pp');
  await writeV2(w.db, 'pp', { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '10' }] });
  // A2·B2 loses its price: A2 and B2 are then in no priced SKU.
  unpriceSku(w.raw, 'pp', k('pp_a2', 'pp_b2'));

  // A1·B2 names B2, a choice no priced SKU carries — it used to answer 'unpriced', and «طلب السعر» refused it.
  const left = await quote(w.app, 'pp', ['pp_a1', 'pp_b2']);
  assert.equal(left.status, 200);
  assert.equal(left.body.price_status, 'priced', JSON.stringify(left.body).slice(0, 300));
  assert.ok(left.body.availability.selection.errors.includes('VARIANT_NOT_MODELLED'), 'the availability answer the cart gives');
  assert.equal(left.body.availability.selection.complete, false);
  assert.equal((await request(w.app, 'pp', ['pp_a1', 'pp_b2'])).body.code, 'PRICE_REQUEST_SELECTION_INVALID');

  const page = (await json(await get(w.app, '/api/products/pp'))) as Json;
  assert.equal(page.price_status, 'priced');
  assert.deepEqual(page.unpriced_selections, [k('pp_a2', 'pp_b2')]);
  assert.deepEqual(page.unoffered_selections, [k('pp_a1', 'pp_b2'), k('pp_a2', 'pp_b1')], 'the page knows what it may not offer');

  // Unchanged: a valid unpriced SKU, and a part of a selection that names an unpriced choice, answer 'unpriced'.
  const unpriced = await quote(w.app, 'pp', ['pp_a2', 'pp_b2']);
  assert.deepEqual([unpriced.status, unpriced.body.price_status, unpriced.body.quote], [200, 'unpriced', null]);
  assert.equal((await request(w.app, 'pp', ['pp_a2', 'pp_b2'])).status, 200, '«طلب السعر» takes it');
  const part = await quote(w.app, 'pp', ['pp_b2']);
  assert.deepEqual([part.status, part.body.price_status], [200, 'unpriced']);
  const priced = await quote(w.app, 'pp', ['pp_a1', 'pp_b1']);
  assert.deepEqual([priced.body.price_status, priced.body.quote.errors], ['priced', []]);

  // Over every complete selection: a quote that answers 'unpriced' is one «طلب السعر» takes.
  for (const sel of complete('pp')) {
    const q = await quote(w.app, 'pp', sel);
    const r = await request(w.app, 'pp', sel);
    if (q.body.price_status === 'unpriced') assert.equal(r.status, 200, `${sel.join('·')}: ${JSON.stringify(r.body)}`);
    if (r.body.code === 'PRICE_REQUEST_SELECTION_INVALID') assert.notEqual(q.body.price_status, 'unpriced', sel.join('·'));
  }
});

// ---------------------------------------------------------------- a catalog-only product

test('a catalog-only product: the quote keeps its 409 and names a combination it does not sell; the page body lists them', async () => {
  const w = await shop();
  seedCable(w.raw, 'pu');
  const left = await quote(w.app, 'pu', ['pu_a1', 'pu_b2']);
  assert.deepEqual([left.status, left.body.code], [409, 'PRICE_NOT_AVAILABLE']);
  assert.deepEqual(left.body.details, { price_status: 'unpriced', selection_errors: ['VARIANT_NOT_MODELLED'] });

  const page = (await json(await get(w.app, '/api/products/pu'))) as Json;
  assert.equal(page.price_status, 'unpriced');
  assert.deepEqual(page.unoffered_selections, [k('pu_a1', 'pu_b2'), k('pu_a2', 'pu_b1')]);
  // Every other request is answered exactly as before: the plain refusal.
  for (const sel of [['pu_a1', 'pu_b1'], ['pu_a2', 'pu_b2'], ['pu_b2'], []]) {
    const q = await quote(w.app, 'pu', sel);
    assert.deepEqual([q.status, q.body.code, q.body.details], [409, 'PRICE_NOT_AVAILABLE', { price_status: 'unpriced' }], sel.join('·'));
  }
  const res = await post(w.app, '/api/products/pu/quote', null);
  assert.deepEqual([res.status, ((await json(res)) as Json).details], [409, { price_status: 'unpriced' }], 'a body that is not an object');
  // Over every complete selection: the plain refusal is one «طلب السعر» takes; the named one, one it refuses.
  for (const sel of complete('pu')) {
    const q = await quote(w.app, 'pu', sel);
    const r = await request(w.app, 'pu', sel);
    assert.equal(r.status === 200, q.body.details.selection_errors === undefined, `${sel.join('·')}: ${JSON.stringify([q.body.details, r.body.code])}`);
  }
});

test('a product with a row for every cell carries no list, and its quotes do not name one', async () => {
  const w = await shop();
  seedCable(w.raw, 'pw', [['a1', 'b1'], ['a1', 'b2'], ['a2', 'b1'], ['a2', 'b2']]);
  seedCable(w.raw, 'px', [['a1', 'b1'], ['a1', 'b2'], ['a2', 'b1'], ['a2', 'b2']]);
  await writeV2(w.db, 'px', { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '10' }] });
  unpriceSku(w.raw, 'px', k('px_a2', 'px_b2'));
  for (const id of ['pw', 'px']) {
    const page = (await json(await get(w.app, `/api/products/${id}`))) as Json;
    assert.equal('unoffered_selections' in page, false, id);
  }
  for (const sel of complete('pw')) assert.deepEqual((await quote(w.app, 'pw', sel)).body.details, { price_status: 'unpriced' });
  assert.equal((await quote(w.app, 'px', ['px_a2', 'px_b2'])).body.price_status, 'unpriced');
  assert.equal((await quote(w.app, 'px', ['px_a1', 'px_b2'])).body.price_status, 'priced');
});

// ---------------------------------------------------------------- the page

test('the page: a combination it does not sell is not offered — no quote, no figure, no «طلب السعر», only the chooser’s words', () => {
  const page = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.match(page, /setUnofferedSelections\(Array\.isArray\(data\.unoffered_selections\) \? data\.unoffered_selections : \[\]\);/);
  // The body's list (past ENGINE_MAX_SKUS, the SKUs it sells: tests/priceEstimateStorefrontOffered.test.ts).
  assert.match(page, /const selectionUnoffered = unofferedSelections\.includes\(selectionKey\) \|\| outsideOffered\(offeredSelections, selectionKey\);/);
  // A chosen value with no priced SKU does not short-cut such a combination to «طلب السعر».
  assert.match(page, /const choiceUnpriced =\s*!catalogOnly &&\s*!selectionUnoffered &&\s*unpricedSelections\.length > 0 &&/);
  // No quote is asked for it (the quote answered it with another SKU's figures), and nothing on screen can be bought:
  // the price card, the «من …» pill, the route rows and the status lines (with their codes) step aside.
  assert.match(page, /if \(catalogOnly \|\| knownUnpriced \|\| selectionUnoffered\) \{\s*setQuoteLoading\(false\);\s*return;/);
  assert.match(page, /warrantyPlanId, quoteToken, catalogOnly, knownUnpriced, selectionUnoffered\]\);/);
  assert.match(page, /const noPrice = catalogOnly \|\| selectionUnpriced \|\| selectionUnoffered;/);
  assert.match(page, /const priceBlock = noPrice \? null : \(/);
  assert.match(page, /const showTransports = effectivePreorder && !noPrice && /);
  assert.match(page, /\{offersBoth && !routeAskedPerVersion && !noPrice \? \(/);
  assert.equal((page.match(/\{noPrice \? null : statusMessages\}/g) ?? []).length, 2);
  // No level figure stands for it either: the grid's pair price is another SKU's (r3-level-left-out).
  assert.match(page, /const levelPrice: PriceLevel \| null = \(\(\) => \{\s*const L = priceLevels;\s*\/\/[^\n]*\n\s*if \(!L \|\| selectionUnoffered\) return null;/);
  // In the price's place: a priced product says only the chooser's words; a catalog-only one keeps its headline
  // and puts the words where the request panel was.
  const at = page.indexOf('const unpricedBlock = ');
  const block = page.slice(at, page.indexOf('<PriceRequestPanel', at));
  assert.match(
    block,
    /=>\s*selectionUnoffered && !catalogOnly \? \(\s*<div className="lv-surface p-4">\s*<p className="[^"]*" data-selection-not-offered>\s*\{tr\(NOT_OFFERED\.ar, NOT_OFFERED\.en, NOT_OFFERED\.ckb\)\}\s*<\/p>\s*<\/div>\s*\) : \(/
  );
  assert.match(block, /source === 'catalog' && wideLayout === wide && selectionUnoffered \? \(/);
  assert.match(block, /data-selection-not-offered>\s*\{tr\(NOT_OFFERED\.ar, NOT_OFFERED\.en, NOT_OFFERED\.ckb\)\}/);
  assert.match(block, /\) : source === 'catalog' && wideLayout === wide \? \(/);
  // «عدة ألوان»: such a colour is not offered (never quoted or priced), has no level figure, and says the words.
  assert.match(page, /const rowUnoffered = \(key: string\): boolean => unofferedSelections\.includes\(key\) \|\| outsideOffered\(offeredSelections, key\);/);
  assert.match(page, /const notOfferedChip = \{ text: tr\(NOT_OFFERED\.ar, NOT_OFFERED\.en, NOT_OFFERED\.ckb\), cls: 'text-text-muted' \};/);
  assert.match(page, /const unoffered = rowUnoffered\(selectionKeyOf\(\[\.\.\.sharedIds, v\.id\], null\)\);/);
  assert.match(page, /const unoffered = rowUnoffered\(selectionKeyOf\(optionValueIds, col\.id\)\);/);
  assert.equal((page.match(/const unpriced = !unoffered && (optionNoPrice\(\[\.\.\.sharedIds, v\.id\], v\.id\)|colorNoPrice\(col\.id\));/g) ?? []).length, 2);
  assert.equal((page.match(/const level = unoffered \? null : colourLevel\((v|col)\.id\);/g) ?? []).length, 2);
  assert.equal((page.match(/offered: !unpriced && !unoffered && !\(direct && shelf !== null && shelf <= 0\),/g) ?? []).length, 2);
  assert.equal((page.match(/chip: unoffered \? notOfferedChip : unpriced \? null : levelChip\(shelf\),/g) ?? []).length, 2);
  // The colour held behind the rows stops being offered (the shared option changed): the page takes the first that
  // can take a quantity, so the panel keeps its total and add.
  assert.match(
    page,
    /\} else if \(colourMode === 'many' && !colourRows\.some\(\(r\) => r\.id === singleColourId && r\.offered\)\) \{[^}]*const probe = colourRows\.find\(\(r\) => r\.offered\)\?\.id;\s*if \(probe && probe !== singleColourId\) setSingleColour\(probe\);/
  );
  // On a phone the bar says the chooser's words, never an empty request slot (no request panel is mounted for it).
  assert.match(
    page,
    /\{noPrice \? \(\s*selectionUnoffered \? \([\s\S]{0,300}?data-bar-not-offered>\s*\{tr\(NOT_OFFERED\.ar, NOT_OFFERED\.en, NOT_OFFERED\.ckb\)\}\s*<\/p>\s*\) : \([\s\S]{0,400}?<div ref=\{setRequestBarSlot\}/
  );
});

// ---------------------------------------------------------------- a grid without relations (review r3-unoffered-nonrel)

/** A legacy product without relational rows (options and colours in its JSON), 16 × 16, stocked on o1..o16·c1 and o1·c2..c16. */
function flatGrid() {
  const O = Array.from({ length: 16 }, (_, i) => `o${i + 1}`);
  const C = Array.from({ length: 16 }, (_, i) => `c${i + 1}`);
  const rows = [...O.map((o) => `o:${o}|c:c1`), ...C.slice(1).map((c) => `o:o1|c:${c}`)];
  const doc = {
    options: O.map((id) => ({ id, active: true, name_en: id })),
    colors: C.map((id) => ({ id, active: true, name_en: id, option_id: null })),
  } as unknown as ProductDoc;
  const view = {
    has_relations: false,
    inventory_mode: 'VARIANT_COMBINATION',
    groups: [],
    values: [],
    colors: [],
    links: [],
    images: [],
    fulfillments: [],
    transports: [],
    variants: rows.map((combo_key, i) => ({ id: `pv${i}`, combo_key, active: 1 })),
  } as unknown as ProductRelationsView;
  return { O, C, doc, view };
}

test('selectionUnoffered: never a part of a SKU it sells, and nothing on a grid without relations too large to list', async () => {
  const { O, C, doc, view } = flatGrid();
  assert.equal(sellableSkus(doc, view).overflow, false);
  assert.equal(sellableSkus(doc, { ...view, variants: [] }).overflow, true, 'the whole grid is past ENGINE_MAX_SKUS');
  // A part of a sold SKU — nothing chosen, a model alone, a colour alone — and crafted selections.
  const asked: Array<[string[], string | null]> = [[[], null], ...O.map((o): [string[], string | null] => [[o], null]), ...C.map((c): [string[], string | null] => [[], c])];
  asked.push([['o2', 'o3'], null], [['o2', 'nope'], 'c2'], [['o2'], 'nope']);
  for (const [ids, colour] of asked) {
    assert.equal(selectionUnoffered(doc, view, ids, colour), false, `${ids.join('·')}${colour ? `·${colour}` : ''}`);
  }
  // Without relations the whole-grid check cannot tell a cell from a part of one there, so no cell is named:
  // the page reads `offered_selections` instead.
  for (const o of O) for (const c of C) assert.equal(selectionUnoffered(doc, view, [o], c), false, `${o}·${c}`);

  // With relations the parts stay out and every left-out cell is still named, past the limit too (20 × 13 on 32 rows).
  const raw = freshDb();
  raw.exec(`INSERT INTO products (id, slug, name, status, price_iqd, inventory_mode) VALUES ('pg', 'pg', 'Big', 'active', 0, 'VARIANT_COMBINATION');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('pg_ga', 'pg', 'A', 0, 1), ('pg_gb', 'pg', 'B', 1, 1);`);
  const A = Array.from({ length: 20 }, (_, i) => `a${i + 1}`);
  const B = Array.from({ length: 13 }, (_, i) => `b${i + 1}`);
  A.forEach((a, i) => raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('${a}', 'pg', 'pg_ga', '${a}', ${i}, 1)`));
  B.forEach((b, i) => raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('${b}', 'pg', 'pg_gb', '${b}', ${i}, 1)`));
  const stocked = [...A.map((a) => [a, 'b1']), ...B.slice(1).map((b) => ['a1', b])];
  stocked.forEach((r, i) => raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES ('pv${i}', 'pg', '${k(...r)}', 1)`));
  const big = (await loadProducts(asD1(raw), ['pg'])).get('pg')!;
  for (const v of [...A, ...B]) assert.equal(selectionUnoffered(big.doc, big.view, [v], null), false, v);
  assert.equal(selectionUnoffered(big.doc, big.view, [], null), false);
  assert.equal(selectionUnoffered(big.doc, big.view, ['a2', 'a3'], null), false, 'two values of one group');
  const keys = new Set(stocked.map((r) => k(...r)));
  let named = 0;
  for (const a of A) for (const b of B) if (selectionUnoffered(big.doc, big.view, [a, b], null)) named += 1;
  assert.equal(named, 260 - keys.size);
});

test('a catalog-only product without relations, past the limit: its quote names no combination for a part (the plain refusal)', async () => {
  const w = await shop();
  const O = Array.from({ length: 16 }, (_, i) => `pf_o${i + 1}`);
  const C = Array.from({ length: 16 }, (_, i) => `pf_c${i + 1}`);
  w.raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode, options, colors)
    VALUES ('pf', 'pf', 'Flat', 'مسطح', 'تەخت', 'active', 0, NULL, 'pre_order', '["pre_order"]', '[{"method":"land","commission_iqd":0,"active":true}]', 'VARIANT_COMBINATION',
            '${JSON.stringify(O.map((id) => ({ id, name_en: id, name: id, active: true })))}', '${JSON.stringify(C.map((id) => ({ id, name_en: id, name: id, hex: '#123456', active: true })))}')`);
  const rows = [...O.map((o) => `o:${o}|c:pf_c1`), ...C.slice(1).map((c) => `o:pf_o1|c:${c}`)];
  rows.forEach((key, i) => w.raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES ('pf_v${i}', 'pf', '${key}', 1)`));
  // Two named choices — the one model sent twice, a model and a stocked colour — are parts or SKUs: the plain 409.
  for (const body of [{ optionId: 'pf_o2', optionValueIds: ['pf_o2'] }, { optionValueIds: ['pf_o2', 'pf_o3'] }, { optionValueIds: ['pf_o2'], colorId: 'pf_c1' }]) {
    w.raw.exec('DELETE FROM rate_limits');
    const res = await post(w.app, '/api/products/pf/quote', { ...body, fulfillmentType: 'pre_order', transportMethod: 'land' });
    assert.deepEqual([res.status, ((await json(res)) as Json).details], [409, { price_status: 'unpriced' }], JSON.stringify(body));
  }
  // The page is not left to that: its body lists the SKUs the product sells.
  const page = (await json(await get(w.app, '/api/products/pf'))) as Json;
  assert.equal(page.price_status, 'unpriced');
  assert.deepEqual(new Set(page.offered_selections), new Set(rows));
});

// ---------------------------------------------------------------- no code on the page (review r3-raw-codes)

test('the page never prints a code: every code the server can send it has words in ar, en and ckb; one it has none for says nothing', () => {
  const page = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  const block = (from: string, to: string) => page.slice(page.indexOf(from, page.indexOf('const STRINGS = {')), page.indexOf(to, page.indexOf(from, page.indexOf('const STRINGS = {'))));
  const blocks = { ar: block('  ar: {', '  en: {'), en: block('  en: {', '  ckb: {'), ckb: block('  ckb: {', '} as const;') };
  // The fallback is '' (it used to be the code), and a blocking code with no sentence is left out of the alerts.
  assert.match(page, /function reasonText\(s: Strings, code: string \| null \| undefined\): string \{\s*if \(!code\) return '';\s*const said = \(s as unknown as Record<string, unknown>\)\[code\];\s*return typeof said === 'string' \? said : '';\s*\}/);
  assert.doesNotMatch(page, /map\[code\] \|\| code/);
  assert.match(page, /const blockingCodes: string\[\] = \[[\s\S]{0,200}\]\.filter\(\(code\) => reasonText\(s, code\) !== ''\);/);
  assert.match(page, /setActionError\(estimateSaid \|\| counted \|\| said \|\| translated \|\| raw\);/);
  // The words: the chooser's for a combination it does not sell and a way of buying a model does not offer, the
  // route's own for a route switched off, and the cart door's for a SKU with no price on the chosen way.
  const LANGS = ['ar', 'en', 'ckb'] as const;
  for (const l of LANGS) {
    for (const code of ['VARIANT_NOT_MODELLED', 'FULFILLMENT_NOT_OFFERED', 'FULFILLMENT_DISABLED']) {
      assert.match(blocks[l], new RegExp(`\\b${code}: NOT_OFFERED\\.${l},`), `${l}.${code}`);
    }
    assert.ok(blocks[l].includes(`VARIANT_UNAVAILABLE: '${REFUSAL_STRINGS.VARIANT_UNAVAILABLE[l]}',`), `${l}.VARIANT_UNAVAILABLE is the door's sentence`);
    const route = /TRANSPORT_NOT_OFFERED: '([^']+)'/.exec(blocks[l]);
    assert.ok(route && blocks[l].includes(`TRANSPORT_DISABLED: '${route[1]}',`), `${l}.TRANSPORT_DISABLED`);
  }
  assert.notEqual(REFUSAL_STRINGS.VARIANT_UNAVAILABLE.ckb, REFUSAL_STRINGS.VARIANT_UNAVAILABLE.ar);
  // Every code the detail and the quote can carry to a reasonText call on this page: the availability's selection
  // errors (scanned), its reasons and the modes' reasons, the resolver's errors (scanned), the strict SKU's, the
  // printers-only warranty, a closed offer and a community listing.
  const products = readFileSync(join(ROOT, 'worker/routes/products.ts'), 'utf8');
  const sale = products.slice(products.indexOf('export function saleAvailability('), products.indexOf('export interface InitialDirectSaleSelection'));
  const pushed = (src: string) => src.split('\n').filter((line) => line.includes('errors.push(')).flatMap((line) => [...line.matchAll(/'([A-Z][A-Z_]+)'/g)].map((m) => m[1]));
  const resolver = pushed(readFileSync(join(ROOT, 'packages/pricing/src/pricing.ts'), 'utf8'));
  const codes = new Set([
    ...pushed(sale),
    'OUT_OF_STOCK', 'NO_TRANSPORT_OFFERED', 'PREORDER_CAPACITY_EXHAUSTED', 'TRANSPORT_COMMISSION_UNCONFIGURED', 'PREORDER_NOT_ENABLED',
    ...resolver,
    SKU_STRICT_ERROR,
    WARRANTY_NOT_PRINTER,
    'OFFER_INACTIVE',
    'COMMUNITY_LISTING_NOT_SELLABLE',
  ]);
  assert.ok(codes.has('VARIANT_NOT_MODELLED') && codes.has('TRANSPORT_DISABLED') && codes.size >= 25, [...codes].join(', '));
  // Not here: DIRECT_SALE_NOT_ENABLED is never a reason this page reads (a closed direct sale is not listed as a mode),
  // COMPOSITION_MAX_REQUIRED belongs to a composition, which this page sends to /bundles, and DERIVED_PRICE_BELOW_FLOOR
  // never leaves the server (worker/lib/customerPricing.ts).
  for (const code of codes) {
    for (const l of LANGS) assert.match(blocks[l], new RegExp(`\\b${code}: `), `${l}.${code} has no sentence`);
  }
});
