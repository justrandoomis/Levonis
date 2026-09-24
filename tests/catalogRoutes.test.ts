/**
 * THE MERCHANT CATALOGUE'S CONTRACTS (merchant platform W2-F), against the real
 * routes and every migration:
 *
 *   · create / read / edit / duplicate with option groups, variants, media,
 *     attributes and collections — one batch, ids kept across edits;
 *   · the lifecycle as a CHECKed state, sold out derived, the legacy mirrors
 *     every older reader asks kept in step by the database;
 *   · Levonis's hide is not the merchant's to lift — not by an edit, not by a
 *     bulk publish, not by a duplicate;
 *   · bulk actions answer per product, and never reach another store's row;
 *   · media are this owner's uploads of the right kind;
 *   · collections: manual order, computed rules, the storefront's order;
 *   · list search/filter/sort with cursor paging;
 *   · insights leave cancelled orders out;
 *   · CSV import: dry run writes nothing, every bad row named; export → import
 *     reproduces the catalogue.
 *
 * Run: node --import tsx --test tests/catalogRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, patch, put, json, row, all, count } from './fixtures/app';
import { storefrontRoutes } from '../worker/routes/storefront';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { merchantApp, seedCatalog, variantBody } from './fixtures/catalog';

const adminApp = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin/community', adminCommunityRoutes));
const guest = (raw: DatabaseSync) => stubApp(asD1(raw), null, (a) => a.route('/api/storefront', storefrontRoutes));


async function create(raw: DatabaseSync, body: Record<string, unknown>, who = 'ali') {
  const res = await post(merchantApp(raw, who), '/api/merchant/products', body);
  const j = await json(res);
  assert.equal(res.status, 201, JSON.stringify(j));
  return j.product as Record<string, any>;
}

// ------------------------------------------------------------------ create

test('a product with variants, media, attributes and a collection is created in one batch and read back whole', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const col = await json(await post(merchantApp(raw), '/api/merchant/collections', { name: 'Figures' }));
  const p = await create(raw, variantBody({
    media: [{ key: 'merchants/ali/public/aaaa1111.webp', alt: 'front' }, { key: '/files/merchants/ali/public/cccc3333.mp4' }],
    attributes: { material: 'pla', technology: 'fdm', finish: 'painted', dim_x_mm: 80, dim_y_mm: 40, dim_z_mm: 120, weight_g: 90 },
    collection_ids: [col.collection.id],
  }));
  assert.equal(p.state, 'published');
  assert.equal(p.lifecycle, 'active', 'the legacy mirror, kept by the database');
  assert.equal(p.variant_mode, 'variants');
  assert.equal(p.stock, 7, "a variant product's stock is the sum of its active variants");
  assert.deepEqual(p.option_groups.map((g: any) => g.values.length), [2, 1]);
  assert.deepEqual(p.variants.map((v: any) => v.label), ['S / أحمر', 'وسط / أحمر']);
  assert.deepEqual(p.media.map((m: any) => m.kind), ['image', 'video']);
  assert.deepEqual(p.images, ['/files/merchants/ali/public/aaaa1111.webp'], 'the images mirror holds the pictures only');
  assert.equal(p.attributes.material, 'pla');
  assert.deepEqual(p.collection_ids, [col.collection.id]);
  assert.deepEqual(p.price_range, { min: 10_000, max: 14_000 });
});

test('a body is validated whole: every wrong field comes back with its path and code', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const res = await post(merchantApp(raw), '/api/merchant/products', {
    name: 'x',
    price_iqd: -5,
    state: 'live',
    attributes: { technology: 'magic', material: 'unobtainium' },
    media: [{ key: 'https://tracker.example/p.gif' }],
    variant_model: { groups: [{ ref: 'g', name: 'Size', values: [{ ref: 'a', name: 'A' }] }], variants: [{ values: ['a'], stock: -1 }] },
    options: [{ id: 'gold', name: 'GOLD PLATED (paid +20000)' }],
  });
  assert.equal(res.status, 400);
  const j = await json(res);
  assert.equal(j.code, 'PRODUCT_INVALID');
  const got = new Set(j.details.errors.map((e: any) => `${e.path}:${e.code}`));
  for (const want of ['name:NAME_INVALID', 'price_iqd:PRICE_INVALID', 'state:STATE_INVALID', 'attributes.technology:ATTRIBUTE_INVALID',
    'media.0:MEDIA_INVALID', 'variant_model.variants.0.stock:VARIANT_STOCK_INVALID', 'options:PRODUCT_OPTIONS_LEGACY']) {
    assert.ok(got.has(want), `${want} — got ${[...got].join(', ')}`);
  }
});

test('media must be this owner’s uploads of the right kind; a material must be on the platform’s list', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  const codes = async (body: Record<string, unknown>) => (await json(await post(m, '/api/merchant/products', { name: 'Thing', price_iqd: 1000, ...body }))).details?.errors?.map((e: any) => e.code);
  assert.deepEqual(await codes({ media: [{ key: 'merchants/zain/public/eeee5555.webp' }] }), ['MEDIA_NOT_OWNED'], "another merchant's picture");
  assert.deepEqual(await codes({ media: [{ key: 'merchants/ali/public/dddd4444.mp4' }] }), ['MEDIA_NOT_OWNED'], 'an .mp4 key the ledger says is a picture');
  assert.deepEqual(await codes({ media: [{ key: 'merchants/ali/public/ffff6666.webp' }] }), ['MEDIA_NOT_OWNED'], 'a key nobody uploaded');
  assert.deepEqual(await codes({ attributes: { material: 'unobtainium' } }), ['ATTRIBUTE_INVALID']);
  const vids = ['cccc3333', 'cccc3333', 'cccc3333'].map((k, i) => ({ key: `merchants/ali/public/${k}${i ? 'x' : ''}.mp4` }));
  assert.ok((await codes({ media: vids })).includes('MEDIA_TOO_MANY_VIDEOS'));
});

// ---------------------------------------------------------------- lifecycle

test('the lifecycle: draft → published → hidden → archived and back; sold out derived; the storefront follows', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  const p = await create(raw, { name: 'Vase', price_iqd: 9000, stock: 1, state: 'draft' });
  const onStore = async () => (await json(await get(guest(raw), '/api/storefront/ali3d/products'))).products.some((x: any) => x.id === p.id);
  assert.equal(await onStore(), false, 'a draft is never on the storefront');
  for (const [state, visible] of [['published', true], ['hidden', false], ['archived', false], ['published', true]] as const) {
    const r = await patch(m, `/api/merchant/products/${p.id}`, { state });
    assert.equal(r.status, 200, state);
    assert.equal((await json(r)).product.state, state);
    assert.equal(await onStore(), visible, `${state} → visible ${visible}`);
  }
  // Sold out is derived, never stored.
  const out = await json(await patch(m, `/api/merchant/products/${p.id}`, { stock: 0 }));
  assert.equal(out.product.sold_out, true);
  assert.equal(out.product.state, 'published');
  const card = (await json(await get(guest(raw), '/api/storefront/ali3d/products'))).products.find((x: any) => x.id === p.id);
  assert.equal(card.in_stock, false, 'shown, as sold out');
  // The database refuses a state that is not one of the four.
  assert.throws(() => raw.exec(`UPDATE community_products SET publish_state = 'sold_out' WHERE id = '${p.id}'`), /CHECK/);
  assert.equal((await patch(m, `/api/merchant/products/${p.id}`, { state: 'sold_out' })).status, 400);
  // The old vocabulary still works for an older client.
  assert.equal((await json(await patch(m, `/api/merchant/products/${p.id}`, { lifecycle: 'draft' }))).product.state, 'draft');
});

test('a variant product with no active variant cannot be published', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const body = variantBody();
  (body.variant_model as any).variants.forEach((v: any) => (v.active = false));
  const res = await post(merchantApp(raw), '/api/merchant/products', body);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'PRODUCT_NOT_PUBLISHABLE');
});

// ---------------------------------------------------------------- moderation

test('Levonis’s hide stays: an edit, a bulk publish and a duplicate all leave it hidden', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  const p = await create(raw, { name: 'Logo mug', price_iqd: 5000, stock: 3 });
  assert.equal((await post(adminApp(raw), `/api/admin/community/products/${p.id}/hide`, { reason: 'counterfeit logo' })).status, 200);
  // An edit that re-sends `published` is an edit — the product stays off.
  assert.equal((await patch(m, `/api/merchant/products/${p.id}`, { state: 'published', name: 'Logo mug 2' })).status, 200);
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM community_products WHERE id = ?', p.id)!.status, 'hidden');
  // A real publish is refused, with the reason.
  await patch(m, `/api/merchant/products/${p.id}`, { state: 'draft' });
  const pub = await patch(m, `/api/merchant/products/${p.id}`, { state: 'published' });
  assert.equal(pub.status, 409);
  assert.equal((await json(pub)).details.reason, 'counterfeit logo');
  const bulk = await json(await post(m, '/api/merchant/products/bulk', { action: 'publish', ids: [p.id] }));
  assert.deepEqual(bulk.results, [{ id: p.id, ok: false, code: 'PRODUCT_HIDDEN_BY_ADMIN' }]);
  // Even written straight into the table, the database keeps it off the storefront.
  raw.exec(`UPDATE community_products SET publish_state = 'published' WHERE id = '${p.id}'`);
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM community_products WHERE id = ?', p.id)!.status, 'hidden');
  assert.equal((await post(m, `/api/merchant/products/${p.id}/duplicate`)).status, 409);
});

// --------------------------------------------------------------------- bulk

test('bulk actions answer per product and never touch another store’s rows', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  const a = await create(raw, { name: 'Alpha', price_iqd: 1000, stock: 1, state: 'draft' });
  const b = await create(raw, { name: 'Beta', price_iqd: 2000, stock: 1, state: 'draft' });
  const z = await create(raw, { name: 'Zain thing', price_iqd: 3000, stock: 1 }, 'zain');
  const pub = await json(await post(m, '/api/merchant/products/bulk', { action: 'publish', ids: [a.id, b.id, z.id] }));
  assert.deepEqual(pub.results.map((r: any) => `${r.id === z.id ? 'z' : r.id === a.id ? 'a' : 'b'}:${r.ok ? 'ok' : r.code}`), ['a:ok', 'b:ok', 'z:NOT_FOUND']);
  const price = await json(await post(m, '/api/merchant/products/bulk', { action: 'set_price', ids: [a.id, z.id], price_iqd: 777 }));
  assert.equal(price.done, 1);
  assert.equal(row<{ price_iqd: number }>(raw, 'SELECT price_iqd FROM community_products WHERE id = ?', z.id)!.price_iqd, 3000, 'untouched');
  const del = await json(await post(merchantApp(raw, 'zain'), '/api/merchant/products/bulk', { action: 'delete', ids: [a.id] }));
  assert.deepEqual(del.results, [{ id: a.id, ok: false, code: 'NOT_FOUND' }]);
  // A product any order names is never deleted.
  raw.exec(`INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
            VALUES ('o1','buyer','delivered',1000,'m_ali','s_ali','merchant','store_product','{}','d','{}','wallet',1000,1500,0);
            INSERT INTO order_items (id,order_id,community_product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,seller_type)
            VALUES ('i1','o1','${a.id}','Alpha',1,1000,1000,'merchant');`);
  const del2 = await json(await post(m, '/api/merchant/products/bulk', { action: 'delete', ids: [a.id, b.id] }));
  assert.deepEqual(del2.results.map((r: any) => r.ok ? 'ok' : r.code), ['PRODUCT_HAS_ORDERS', 'ok']);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM community_products WHERE id = '${a.id}'`), 1);
  // Organising is the owner's even when they may not sell; selling is not.
  raw.exec(`UPDATE memberships SET expires_at = '2026-02-01T00:00:00.000Z' WHERE id = 'mem_ali'`);
  assert.equal((await post(m, '/api/merchant/products/bulk', { action: 'hide', ids: [a.id] })).status, 200);
  assert.equal((await post(m, '/api/merchant/products/bulk', { action: 'publish', ids: [a.id] })).status, 403);
  assert.equal((await post(m, '/api/merchant/products/bulk', { action: 'explode', ids: [a.id] })).status, 400);
});

// ---------------------------------------------------------- variants, edits

test('editing variants keeps each surviving combination’s id; a removed value takes its variants with it', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  const p = await create(raw, variantBody());
  const [vs, vm] = p.variants;
  const [gSize, gCol] = p.option_groups;
  const [s, mm] = gSize.values;
  const res = await json(await patch(m, `/api/merchant/products/${p.id}`, {
    variant_model: {
      groups: [
        { ref: gSize.id, name: 'Size', values: [{ ref: s.id, name: 'Small' }, { ref: mm.id, name: 'M' }, { ref: 'new_l', name: 'L' }] },
        { ref: gCol.id, name: 'Colour', kind: 'color', values: [{ ref: gCol.values[0].id, name: 'Red', swatch: 'red' }] },
      ],
      variants: [
        { values: [s.id, gCol.values[0].id], stock: 9 },
        { values: ['new_l', gCol.values[0].id], stock: 1, price_iqd: 20_000 },
      ],
    },
  }));
  assert.equal(res.product.variants[0].id, vs.id, 'same combination, same id');
  assert.ok(!res.product.variants.some((v: any) => v.id === vm.id), 'the dropped combination is gone');
  assert.equal(res.product.stock, 10);
  assert.equal(res.product.option_groups[0].values[0].name, 'Small');
  // Back to simple: the product's own stock must be stated.
  assert.equal((await patch(m, `/api/merchant/products/${p.id}`, { variant_model: null })).status, 400);
  const simple = await json(await patch(m, `/api/merchant/products/${p.id}`, { variant_model: null, stock: 4 }));
  assert.equal(simple.product.variant_mode, 'simple');
  assert.equal(simple.product.stock, 4);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM community_product_variants WHERE product_id = '${p.id}'`), 0);
});

test('a value id of ANOTHER product is a new value here — never a reach into the other product', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const other = await create(raw, variantBody(), 'zain');
  const foreignValue = other.option_groups[0].values[0].id;
  const mine = await create(raw, {
    name: 'Mine', price_iqd: 1000, state: 'draft',
    variant_model: { groups: [{ ref: 'g', name: 'Size', values: [{ ref: foreignValue, name: 'Hijack' }] }], variants: [{ values: [foreignValue], stock: 1 }] },
  });
  assert.notEqual(mine.option_groups[0].values[0].id, foreignValue);
  assert.equal(row<{ name: string }>(raw, 'SELECT name FROM community_product_option_values WHERE id = ?', foreignValue)!.name, 'S');
  // And the database refuses a variant built on another product's value outright.
  assert.throws(() => raw.exec(`INSERT INTO community_product_variants (id,product_id,store_id,value1_id) VALUES ('pvx','${mine.id}','s_ali','${foreignValue}')`), /VARIANT_VALUE_FOREIGN/);
});

test('duplicate copies the variants, media and collections as a DRAFT with new ids', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const p = await create(raw, variantBody({ media: [{ key: 'merchants/ali/public/aaaa1111.webp' }] }));
  const res = await post(merchantApp(raw), `/api/merchant/products/${p.id}/duplicate`);
  assert.equal(res.status, 201);
  const d = (await json(res)).product;
  assert.equal(d.state, 'draft');
  assert.equal(d.variants.length, 2);
  assert.ok(d.variants.every((v: any) => !p.variants.some((x: any) => x.id === v.id)));
  assert.deepEqual(d.variants.map((v: any) => v.price_iqd), [null, 14_000]);
  assert.equal(d.media[0].key, 'merchants/ali/public/aaaa1111.webp');
});

// -------------------------------------------------------------- collections

test('collections: a manual order the storefront follows, computed rules, and no foreign members', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  const a = await create(raw, { name: 'Alpha', price_iqd: 1000, stock: 5 });
  const b = await create(raw, { name: 'Beta', price_iqd: 1000, stock: 5, featured: true });
  const c = await create(raw, { name: 'Gamma', price_iqd: 1000, stock: 5 });
  const z = await create(raw, { name: 'Zain', price_iqd: 1000, stock: 5 }, 'zain');
  const col = (await json(await post(m, '/api/merchant/collections', { name: 'Shelf' }))).collection;
  assert.equal((await put(m, `/api/merchant/collections/${col.id}/products`, { product_ids: [c.id, a.id, b.id] })).status, 200);
  const order = async () => (await json(await get(guest(raw), `/api/storefront/ali3d/products?section=${col.id}`))).products.map((p: any) => p.name);
  assert.deepEqual(await order(), ['Gamma', 'Alpha', 'Beta'], "the merchant's order");
  await put(m, `/api/merchant/collections/${col.id}/products`, { product_ids: [b.id, c.id] });
  assert.deepEqual(await order(), ['Beta', 'Gamma']);
  const foreign = await put(m, `/api/merchant/collections/${col.id}/products`, { product_ids: [z.id] });
  assert.equal(foreign.status, 404);
  assert.equal((await json(foreign)).code, 'PRODUCT_NOT_FOUND');
  // Paging through a manual collection by its own order.
  const page1 = await json(await get(guest(raw), `/api/storefront/ali3d/products?section=${col.id}&limit=1`));
  const page2 = await json(await get(guest(raw), `/api/storefront/ali3d/products?section=${col.id}&limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`));
  assert.deepEqual([page1.products[0].name, page2.products[0].name], ['Beta', 'Gamma']);
  // Computed collections: one of each kind per store.
  const best = (await json(await post(m, '/api/merchant/collections', { name: 'Best sellers', kind: 'best_sellers' }))).collection;
  assert.equal((await post(m, '/api/merchant/collections', { name: 'Again', kind: 'best_sellers' })).status, 409);
  raw.exec(`UPDATE community_products SET sold_count = CASE id WHEN '${a.id}' THEN 3 WHEN '${c.id}' THEN 9 ELSE 0 END`);
  assert.deepEqual((await json(await get(guest(raw), `/api/storefront/ali3d/products?section=${best.id}`))).products.map((p: any) => p.name), ['Gamma', 'Alpha']);
  const featured = (await json(await post(m, '/api/merchant/collections', { name: 'Picks', kind: 'featured' }))).collection;
  assert.deepEqual((await json(await get(guest(raw), `/api/storefront/ali3d/products?section=${featured.id}`))).products.map((p: any) => p.name), ['Beta']);
  assert.equal((await post(m, `/api/merchant/collections/${featured.id}/products`, { product_ids: [a.id] })).status, 409, 'a rule chooses its own members');
  // The storefront's collection list counts each kind honestly.
  const list = (await json(await get(guest(raw), '/api/storefront/ali3d/sections'))).sections;
  assert.deepEqual(list.map((s: any) => `${s.kind}:${s.product_count}`).sort(), ['best_sellers:2', 'featured:1', 'manual:2']);
  // The database refuses a membership across stores.
  assert.throws(() => raw.exec(`INSERT INTO merchant_collection_products (collection_id,product_id,store_id) VALUES ('${col.id}','${z.id}','s_ali')`), /COLLECTION_MEMBER_FOREIGN/);
});

// -------------------------------------------------------------------- list

test('the list: search (including variant SKUs), filters, sort and cursor paging that never skips', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  for (let i = 0; i < 7; i++) await create(raw, { name: `Item ${i}`, price_iqd: 1000 * ((i % 3) + 1), stock: i, state: i % 2 ? 'published' : 'draft' });
  await create(raw, variantBody());
  const bySku = await json(await get(m, '/api/merchant/products?q=DR-M'));
  assert.deepEqual(bySku.products.map((p: any) => p.name), ['Dragon figure']);
  const drafts = await json(await get(m, '/api/merchant/products?state=draft'));
  assert.equal(drafts.total, 4);
  const out = await json(await get(m, '/api/merchant/products?stock=out'));
  assert.deepEqual(out.products.map((p: any) => p.name), ['Item 0']);
  const seen: string[] = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const page = await json(await get(m, `/api/merchant/products?sort=price_asc&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    seen.push(...page.products.map((p: any) => p.name));
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen).size, 8, 'every product once');
  const prices = seen.map((n) => (n === 'Dragon figure' ? 10_000 : 1000 * ((Number(n.slice(-1)) % 3) + 1)));
  assert.deepEqual(prices, [...prices].sort((x, y) => x - y));
  assert.equal((await get(m, '/api/merchant/products?cursor=s1.garbage')).status, 400);
});

// ----------------------------------------------------------------- insights

test('insights: units and revenue from orders that were NOT cancelled, in total and per variant', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const p = await create(raw, variantBody());
  const [vs, vm] = p.variants;
  const COLS = '(id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)';
  raw.exec(`INSERT INTO orders ${COLS} VALUES
      ('o_ok','buyer','delivered',24000,'m_ali','s_ali','merchant','store_product','{}','d','{}','wallet',24000,1500,0),
      ('o_x','buyer','cancelled',99000,'m_ali','s_ali','merchant','store_product','{}','d','{}','wallet',99000,1500,0);
    INSERT INTO order_items (id,order_id,community_product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,seller_type,variant_id) VALUES
      ('i1','o_ok','${p.id}','Dragon','S / أحمر',1,10000,10000,'merchant','${vs.id}'),
      ('i2','o_ok','${p.id}','Dragon','وسط / أحمر',1,14000,14000,'merchant','${vm.id}'),
      ('i3','o_x','${p.id}','Dragon','وسط / أحمر',7,14000,98000,'merchant','${vm.id}');`);
  const i = (await json(await get(merchantApp(raw), `/api/merchant/products/${p.id}/insights`))).insights;
  assert.equal(i.units_sold, 2);
  assert.equal(i.revenue_iqd, 24_000);
  assert.equal(i.orders, 1);
  assert.deepEqual(i.by_variant.map((v: any) => `${v.label}:${v.units}:${v.revenue_iqd}`).sort(), ['S / أحمر:1:10000', 'وسط / أحمر:1:14000']);
  assert.equal((await get(merchantApp(raw, 'zain'), `/api/merchant/products/${p.id}/insights`)).status, 404, "another store's product");
});

// -------------------------------------------------------------- import/export

const CSV = [
  'handle,name,price_iqd,stock,option1_name,option1_value,variant_price_iqd,variant_stock,collections,material',
  'vase,Vase,5000,,Size,S,,3,Shelf,pla',
  'vase,,,,Size,L,7000,1,,',
  'bad,,-4,,,,,,,',
  'mug,Mug,3000,9,,,,,Nowhere,',
  'lamp,Lamp,8000,2,,,,,,unobtainium',
].join('\n');

test('import: a dry run writes nothing and names every bad row; confirm creates drafts with their variants', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  await post(m, '/api/merchant/collections', { name: 'Shelf' });
  const before = count(raw, 'SELECT COUNT(*) n FROM community_products');
  const dry = await json(await post(m, '/api/merchant/products/import', { csv: CSV, confirm: false }));
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM community_products'), before, 'a preview writes nothing');
  assert.equal(dry.valid, 1);
  const errs = dry.errors.map((e: any) => `${e.row}:${e.field}:${e.code}`);
  assert.ok(errs.includes('4:name:CSV_NAME_INVALID'), errs.join(' | '));
  assert.ok(errs.includes('4:price_iqd:CSV_PRICE_INVALID'));
  assert.ok(errs.includes('5:collections:CSV_COLLECTION_UNKNOWN'));
  assert.ok(errs.includes('6:material:CSV_ATTRIBUTE_INVALID'));
  assert.deepEqual(dry.products.map((p: any) => `${p.name}:${p.variants}`), ['Vase:2']);
  const done = await json(await post(m, '/api/merchant/products/import', { csv: CSV, confirm: true }));
  assert.equal(done.created, 1);
  const vase = row<{ id: string; publish_state: string; variant_mode: string; stock: number }>(raw, "SELECT id, publish_state, variant_mode, stock FROM community_products WHERE name = 'Vase'")!;
  assert.equal(vase.publish_state, 'draft', 'a spreadsheet never publishes');
  assert.equal(vase.variant_mode, 'variants');
  assert.equal(vase.stock, 4);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM merchant_collection_products WHERE product_id = '${vase.id}'`), 1);
});

test('export → import reproduces the catalogue: fields, variants, prices, stock, attributes, collections', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  assert.equal((await post(m, '/api/merchant/collections', { name: 'Figures | Big' })).status, 400, '«|» separates collections in a cell');
  const col = (await json(await post(m, '/api/merchant/collections', { name: 'Figures' }))).collection;
  const big = (await json(await post(m, '/api/merchant/collections', { name: 'Big', name_ar: 'كبير' }))).collection;
  await create(raw, variantBody({ collection_ids: [col.id, big.id], attributes: { material: 'petg', finish: 'painted', dim_x_mm: 12.5, weight_g: 30 }, description: '=HYPERLINK("x")' }));
  await create(raw, { name: 'Plain', price_iqd: 2500, stock: 3, compare_at_iqd: 3000, low_stock_threshold: 1 });
  const res = await get(m, '/api/merchant/products/export.csv');
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.ok(csv.includes("'=HYPERLINK"), 'a formula is defused in the file');
  const snapshot = () => all<Record<string, unknown>>(raw, `
    SELECT p.name, p.description, p.price_iqd, p.original_price_iqd, p.stock, p.low_stock_threshold, p.material, p.finish, p.dim_x_mm, p.weight_g,
           (SELECT group_concat(COALESCE(v.price_iqd,'-') || ':' || v.stock || ':' || v.sku, ',') FROM community_product_variants v WHERE v.product_id = p.id) AS variants,
           (SELECT COUNT(*) FROM merchant_collection_products m WHERE m.product_id = p.id) AS collections
      FROM community_products p ORDER BY p.name, p.created_at`);
  const original = snapshot();
  // Import the file into a second, empty store of the same merchant's twin.
  raw.exec(`DELETE FROM community_products`);
  const imp = await json(await post(m, '/api/merchant/products/import', { csv, confirm: true }));
  assert.equal(imp.created, 2, JSON.stringify(imp.errors));
  assert.deepEqual(snapshot(), original);
});
