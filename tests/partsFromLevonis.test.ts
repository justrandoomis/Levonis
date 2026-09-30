/**
 * «من ليفونيس» — A LEVONIS ITEM BECOMES THE MERCHANT'S OWN PART (Programme C,
 * phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.3 row «From Levonis»).
 *
 * Pinned over the real routes:
 *   · GET /api/products/print-parts lists only live items marked «يُستخدم داخل
 *     منتجات مطبوعة», with the guest price, words in three languages and an
 *     in-stock boolean; `kind`, `q` and `cursor` are its only declared
 *     parameters; 24 to a page with an exact `next_cursor`;
 *   · POST /api/merchant/parts/from-levonis creates ONE hidden part in the
 *     caller's store: the item's options as variants (or the one chosen), the
 *     facts with `source = levonis:<id>#<option>`, the pictures copied under
 *     the merchant's own public prefix and recorded as theirs;
 *   · a second import of the same source is refused (PART_ALREADY_IMPORTED
 *     {product_id}), a non-part is refused (PART_NOT_ELIGIBLE), another
 *     merchant's store is untouched;
 *   · refresh re-reads the facts and pictures, keeps the merchant's price and
 *     their own pictures, and RETURNS the Levonis price beside the product;
 *   · both doors are rate limited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, failingD1, get, patch, post, json, row, count, MemoryBucket, type StubUser, type Mount } from './fixtures/app';
import { seedCatalog } from './fixtures/catalog';
import { productRoutes } from '../worker/routes/products';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';
import { merchantPartRoutes, parseLevonisSource } from '../worker/routes/merchantParts';
import { PRINT_PARTS_PAGE, PRINT_PARTS_PARAMS } from '../worker/routes/printParts';
import { ANONYMOUS_CACHE_CONTROL, canonicalKey } from '../worker/lib/edgePolicy';
import { rateLimitKey } from '../worker/lib/ratelimit';
import { readPartSpec } from '../packages/catalog/src/personalize/parts';

const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const ZAIN: StubUser = { id: 'zain', role: 'merchant', email: 'zain@x.co' };

const mount: Mount = (a) => {
  a.route('/api/products', productRoutes);
  a.route('/api/merchant', merchantCatalogRoutes);
  a.route('/api/merchant/parts', merchantPartRoutes);
};

const MAGNET_SPEC = JSON.stringify({
  printed_use: 'Yes', part_kind: 'Magnet', part_shape: 'Round', diameter_mm: '6', height_mm: '3',
  install_type: 'Press fit', variant_specs: 'opt-10x2: diameter_mm=10, height_mm=2',
});
const PICTURE = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 69, 66, 80, 9, 9, 9]);
const OPTION_PICTURE = new Uint8Array([82, 73, 70, 70, 7, 7, 7, 7, 87, 69, 66, 80, 1, 1, 1]);

function world(): { raw: DatabaseSync; bucket: MemoryBucket } {
  const raw = freshDb();
  seedCatalog(raw);
  // «التخصيص» ships dark (C1, lane L5): the parts doors open with the builder's switch.
  raw.exec(`INSERT INTO admin_settings (key, value) VALUES ('customizationConfig', '{"enabled":true}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,description,description_ar,price_iqd,status,images,spec_fields,stock,net_weight_g) VALUES
      ('lv_mag','n52-magnet','N52 Magnet','مغناطيس N52','موگناتیسی N52','Strong neodymium magnet','مغناطيس نيوديميوم قوي',1000,'active',
       '["/files/products/lv_mag/gallery/aaa.webp"]','${MAGNET_SPEC}',NULL,2),
      ('lv_led','led-strip','LED strip','شريط LED','','','',3000,'active','[]',
       '{"printed_use":"Yes","part_kind":"LED","part_shape":"Strip","voltage":"5","length_mm":"1000"}',0,NULL),
      ('lv_pla','pla-white','PLA White 1kg','فلمنت أبيض','','','',22000,'active','[]','{"material_type":"PLA","net_weight":"1000"}',NULL,NULL),
      ('lv_no','fridge-magnet','Fridge magnet','','','','',500,'active','[]','{"printed_use":"No","part_kind":"Magnet"}',NULL,NULL),
      ('lv_off','old-magnet','Old magnet','','','','',500,'hidden','[]','{"printed_use":"Yes","part_kind":"Magnet"}',NULL,NULL),
      ('lv_odd','odd-part','Odd thing','','','','',500,'active','[]','{"printed_use":"Yes","part_kind":"Laser"}',NULL,NULL);
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g-size','lv_mag','Size',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,regular_price_iqd,image) VALUES
      ('opt-6x3','lv_mag','g-size','6×3 mm','٦×٣ مم',0,1,1000,''),
      ('opt-10x2','lv_mag','g-size','10×2 mm','١٠×٢ مم',1,1,1500,'/files/products/lv_mag/options/bbb.webp');
  `);
  const bucket = new MemoryBucket();
  void bucket.put('products/lv_mag/gallery/aaa.webp', PICTURE, { httpMetadata: { contentType: 'image/webp' } });
  void bucket.put('products/lv_mag/options/bbb.webp', OPTION_PICTURE, { httpMetadata: { contentType: 'image/webp' } });
  return { raw, bucket };
}

const as = (w: { raw: DatabaseSync; bucket: MemoryBucket }, user: StubUser | null) =>
  stubApp(asD1(w.raw), user, mount, { env: { BUCKET: w.bucket } });

const ids = (parts: Array<{ id: string }>) => parts.map((p) => p.id);

// ================================================================ the door

test('GET /api/products/print-parts lists only live items marked for printed products, priced as a guest, in words', async () => {
  const w = world();
  const res = await get(as(w, null), '/api/products/print-parts');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL, 'a guest answer the edge may keep');
  const body = await json(res);
  // Not the filament, not the «No», not the hidden one, not the unknown kind.
  assert.deepEqual(ids(body.parts), ['lv_led', 'lv_mag']);
  assert.equal(body.next_cursor, null);
  const magnet = body.parts[1];
  assert.deepEqual(
    { price: magnet.price_iqd, in_stock: magnet.in_stock, image: magnet.image, kind: magnet.kind, words: magnet.words },
    {
      price: 1000,
      in_stock: true,
      image: '/files/products/lv_mag/gallery/aaa.webp',
      kind: 'magnet',
      words: { ar: 'مغناطيس دائري ٦ × ٣ مم', en: 'Round magnet 6 × 3 mm', ckb: 'موگناتیسی خڕ ٦ × ٣ ملم' },
    }
  );
  assert.deepEqual(
    magnet.options.map((o: Record<string, unknown>) => [o.key, o.price_iqd, (o.words as { en: string }).en]),
    [['opt-6x3', 1000, 'Round magnet 6 × 3 mm'], ['opt-10x2', 1500, 'Round magnet 10 × 2 mm']]
  );
  assert.equal(body.parts[0].in_stock, false, 'the LED strip has none left — a boolean, never a count');
  for (const p of body.parts) {
    for (const k of ['spec', 'spec_fields', 'gallery', 'description', 'stock', 'cost_iqd', 'product_cost_iqd']) assert.ok(!(k in p), `a card carries ${k}`);
  }
  // The same answer for a signed-in merchant — nothing in it is priced for the caller.
  const merchant = await json(await get(as(w, ALI), '/api/products/print-parts'));
  assert.deepEqual(merchant.parts, body.parts);
});

test('print-parts: `kind` and `q` narrow, and they are the only parameters (with the cursor) the edge key reads', async () => {
  const w = world();
  const app = as(w, null);
  assert.deepEqual(ids((await json(await get(app, '/api/products/print-parts?kind=magnet'))).parts), ['lv_mag']);
  assert.deepEqual(ids((await json(await get(app, '/api/products/print-parts?kind=led'))).parts), ['lv_led']);
  assert.deepEqual(ids((await json(await get(app, '/api/products/print-parts?kind=bogus'))).parts), ['lv_led', 'lv_mag'], 'an unknown kind narrows nothing');
  assert.deepEqual(ids((await json(await get(app, '/api/products/print-parts?q=N52'))).parts), ['lv_mag']);
  assert.deepEqual(ids((await json(await get(app, `/api/products/print-parts?q=${encodeURIComponent('مغناطيس')}`))).parts), ['lv_mag']);
  assert.deepEqual(ids((await json(await get(app, '/api/products/print-parts?q=nothing-like-it'))).parts), []);
  assert.deepEqual([...PRINT_PARTS_PARAMS], ['kind', 'q', 'cursor']);
  const key = canonicalKey('https://levonis-iq.com/api/products/print-parts?q=N52&utm=x&kind=magnet&cursor=abc', PRINT_PARTS_PARAMS);
  assert.equal(key.url, 'https://levonis-iq.com/api/products/print-parts?cursor=abc&kind=magnet&q=N52', 'an undeclared parameter mints nothing');
  // The literal path is never read as a product slug.
  assert.equal((await get(app, '/api/products/print-parts')).status, 200);
});

test('print-parts pages by an exact cursor: 24, then the rest, nothing twice, the last page says null', async () => {
  const w = world();
  const values = Array.from({ length: 27 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `('lv_s${n}','screw-${n}','Screw M3 ${n}','','',${100 + i},'active','','','[]','{"printed_use":"Yes","part_kind":"Screw","diameter_mm":"3"}',NULL,NULL)`;
  });
  w.raw.exec(`INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,description,description_ar,images,spec_fields,stock,net_weight_g) VALUES ${values.join(',')};`);
  const app = as(w, null);
  const first = await json(await get(app, '/api/products/print-parts?kind=screw'));
  assert.equal(first.parts.length, PRINT_PARTS_PAGE);
  assert.ok(first.next_cursor);
  const second = await json(await get(app, `/api/products/print-parts?kind=screw&cursor=${first.next_cursor}`));
  assert.equal(second.parts.length, 3);
  assert.equal(second.next_cursor, null);
  const all = [...ids(first.parts), ...ids(second.parts)];
  assert.equal(new Set(all).size, 27);
  assert.deepEqual(all, [...all].sort(), 'in name order');
  assert.equal((await get(app, '/api/products/print-parts?cursor=%%%')).status, 400);
});

// ================================================================ from Levonis

test('from-levonis creates ONE hidden part: the options as variants, the facts with their source, the pictures copied as the merchant\'s own', async () => {
  const w = world();
  const res = await post(as(w, ALI), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag' });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const { product, images } = await json(res);
  assert.equal(product.state, 'hidden');
  assert.deepEqual(row(w.raw, 'SELECT store_id, status, lifecycle, stock, track_stock, price_iqd, weight_g FROM community_products WHERE id = ?', product.id), {
    store_id: 's_ali', status: 'hidden', lifecycle: 'hidden', stock: 0, track_stock: 1, price_iqd: 1000, weight_g: 2,
  });
  assert.equal(product.name, 'N52 Magnet');
  assert.equal(product.name_ar, 'مغناطيس N52');
  assert.equal(product.description_ar, 'مغناطيس نيوديميوم قوي');
  // The item's option values are the product's variants, at the Levonis guest prices.
  assert.equal(product.variant_mode, 'variants');
  const values = product.option_groups[0].values as Array<{ id: string; name: string }>;
  assert.deepEqual(values.map((v) => v.name), ['6×3 mm', '10×2 mm']);
  assert.deepEqual(product.variants.map((v: { price_iqd: number | null; stock: number }) => [v.price_iqd, v.stock]), [[null, 0], [1500, 0]]);
  // The facts, with the 10×2 line keyed by the value it became.
  const spec = readPartSpec(product.part_spec, values.map((v) => v.id))!;
  assert.equal(spec.source, 'levonis:lv_mag');
  assert.deepEqual({ kind: spec.kind, shape: spec.shape, d: spec.diameter_mm, h: spec.height_mm, install: spec.install }, { kind: 'magnet', shape: 'round', d: 6, h: 3, install: 'Press fit' });
  assert.deepEqual(spec.variants, { [values[1].id]: { diameter_mm: 10, height_mm: 2 } });
  // The pictures: copied into merchants/ali/public/, recorded as Ali's, the option's on its variant.
  assert.deepEqual(images, { copied: 2, skipped: 0 });
  const keys = product.media.map((m: { key: string }) => m.key) as string[];
  assert.equal(keys.length, 2);
  for (const key of keys) {
    assert.match(key, /^merchants\/ali\/public\/lv[0-9a-f]{30}\.webp$/);
    assert.ok(w.bucket.objects.has(key), 'the bytes are in the bucket');
    assert.deepEqual(row(w.raw, 'SELECT owner_id, mime_type FROM file_objects WHERE object_key = ?', key), { owner_id: 'ali', mime_type: 'image/webp' });
  }
  assert.deepEqual([...w.bucket.objects.get(keys[0])!.bytes], [...PICTURE]);
  assert.equal(product.variants[1].image_key, keys[1], 'the 10×2 variant shows its own picture');
  assert.deepEqual(JSON.parse(row<{ images: string }>(w.raw, 'SELECT images FROM community_products WHERE id = ?', product.id)!.images), keys.map((k) => `/files/${k}`));
  // And it is an ordinary product the editor saves as it is.
  const saved = await patch(as(w, ALI), `/api/merchant/products/${product.id}`, { price_iqd: 1200, media: product.media.map((m: { key: string }) => ({ key: m.key })) });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())));
});

test('from-levonis with one option: a simple part of that option, its line merged, its price, its source', async () => {
  const w = world();
  const res = await post(as(w, ALI), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag', option_key: 'opt-10x2' });
  assert.equal(res.status, 201);
  const { product } = await json(res);
  assert.equal(product.variant_mode, 'simple');
  assert.equal(product.price_iqd, 1500);
  assert.equal(product.name, 'N52 Magnet — 10×2 mm');
  const spec = readPartSpec(product.part_spec)!;
  assert.deepEqual({ d: spec.diameter_mm, h: spec.height_mm, source: spec.source, variants: spec.variants }, { d: 10, h: 2, source: 'levonis:lv_mag#opt-10x2', variants: undefined });
  assert.deepEqual(parseLevonisSource(spec.source), { productId: 'lv_mag', optionKey: 'opt-10x2' });
  // The option's own picture leads; the item's gallery follows.
  assert.deepEqual([...w.bucket.objects.get(product.media[0].key)!.bytes], [...OPTION_PICTURE]);
  assert.deepEqual([...w.bucket.objects.get(product.media[1].key)!.bytes], [...PICTURE]);
});

test('PART_ALREADY_IMPORTED: the same source twice in one store is refused with the part that exists', async () => {
  const w = world();
  const first = (await json(await post(as(w, ALI), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag' }))).product;
  const again = await post(as(w, ALI), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag' });
  assert.equal(again.status, 409);
  const body = await json(again);
  assert.equal(body.code, 'PART_ALREADY_IMPORTED');
  assert.deepEqual(body.details, { product_id: first.id });
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM community_products WHERE store_id = 's_ali'"), 1);
  // One option of it is a different source, so it is its own part.
  assert.equal((await post(as(w, ALI), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag', option_key: 'opt-6x3' })).status, 201);
});

test('the fence INSIDE the batch holds when a second import lands between the pre-check and the write', async () => {
  const w = world();
  for (const [productId, rival] of [['lv_led', 'cp_raced_led'], ['lv_mag', 'cp_raced_mag']] as const) {
    const { failing, db } = failingD1(w.raw);
    // The competitor commits after this request's pre-check and before its batch.
    failing.beforeBatch = (stmts) => {
      if (!/INSERT INTO community_products/.test(stmts[0]?.sql ?? '')) return;
      w.raw.exec(`INSERT INTO community_products (id,merchant_id,store_id,slug,name,price_iqd,publish_state,part_spec)
        VALUES ('${rival}','m_ali','s_ali','${rival}','Raced',1,'hidden','{"part_kind":"magnet","source":"levonis:${productId}"}')`);
      failing.beforeBatch = null;
    };
    const res = await post(stubApp(db, ALI, mount, { env: { BUCKET: w.bucket } }), '/api/merchant/parts/from-levonis', { product_id: productId });
    assert.equal(res.status, 409, productId);
    assert.deepEqual((await json(res)).details, { product_id: rival }, productId);
    assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM community_products WHERE store_id = 's_ali' AND part_spec LIKE '%levonis:${productId}"%'`), 1, `one part from ${productId}, not two`);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM community_product_media'), 0, 'the losing batch left no picture rows');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM community_product_variants'), 0, 'and no variants');
});

test('PART_NOT_ELIGIBLE: a filament, an item marked «No», an unknown kind, an option it does not have; 404 for no live item', async () => {
  const w = world();
  const app = as(w, ALI);
  for (const [body, status, code] of [
    [{ product_id: 'lv_pla' }, 409, 'PART_NOT_ELIGIBLE'],
    [{ product_id: 'lv_no' }, 409, 'PART_NOT_ELIGIBLE'],
    [{ product_id: 'lv_odd' }, 409, 'PART_NOT_ELIGIBLE'],
    [{ product_id: 'lv_mag', option_key: 'opt-nope' }, 409, 'PART_NOT_ELIGIBLE'],
    [{ product_id: 'lv_off' }, 404, 'NOT_FOUND'],
    [{ product_id: 'does-not-exist' }, 404, 'NOT_FOUND'],
    [{}, 400, undefined],
  ] as const) {
    const res = await post(app, '/api/merchant/parts/from-levonis', body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal((await json(res)).code, code, JSON.stringify(body));
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM community_products'), 0, 'nothing was made');
  assert.equal(w.bucket.objects.size, 2, 'nothing was copied');
});

test('another merchant\'s store is untouched: Zain imports into his own, and neither can refresh the other\'s part', async () => {
  const w = world();
  const ali = (await json(await post(as(w, ALI), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag' }))).product;
  const zainRes = await post(as(w, ZAIN), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag' });
  assert.equal(zainRes.status, 201, 'the same item is a part in each store that imports it');
  const zain = (await json(zainRes)).product;
  assert.equal(row<{ store_id: string }>(w.raw, 'SELECT store_id FROM community_products WHERE id = ?', zain.id)!.store_id, 's_zain');
  assert.ok(zain.media.every((m: { key: string }) => m.key.startsWith('merchants/zain/public/')), 'his copies, under his prefix');
  assert.equal((await post(as(w, ZAIN), `/api/merchant/parts/${ali.id}/refresh`)).status, 404);
  assert.equal((await post(as(w, ALI), `/api/merchant/parts/${zain.id}/refresh`)).status, 404);
  assert.equal((await get(as(w, ZAIN), `/api/merchant/products/${ali.id}`)).status, 404);
});

test('refresh re-reads the facts and pictures, keeps the merchant\'s own price and pictures, and RETURNS the Levonis price', async () => {
  const w = world();
  const part = (await json(await post(as(w, ALI), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag', option_key: 'opt-6x3' }))).product;
  const levonisCopy = part.media[0].key as string;
  // Ali prices it his way and adds his own picture.
  const edited = await patch(as(w, ALI), `/api/merchant/products/${part.id}`, {
    price_iqd: 2500,
    media: [{ key: levonisCopy }, { key: 'merchants/ali/public/aaaa1111.webp' }],
  });
  assert.equal(edited.status, 200, JSON.stringify(await json(edited.clone())));
  // Levonis moves: a new price, a new height, a new picture.
  w.raw.exec(`
    UPDATE product_option_values SET regular_price_iqd = 1250 WHERE id = 'opt-6x3';
    UPDATE products SET spec_fields = json_set(spec_fields, '$.height_mm', '4'), images = '["/files/products/lv_mag/gallery/ccc.webp"]' WHERE id = 'lv_mag';
  `);
  await w.bucket.put('products/lv_mag/gallery/ccc.webp', new Uint8Array([82, 73, 70, 70, 5, 5, 5, 5, 87, 69, 66, 80]), { httpMetadata: { contentType: 'image/webp' } });
  const res = await post(as(w, ALI), `/api/merchant/parts/${part.id}/refresh`);
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const body = await json(res);
  assert.equal(body.product.price_iqd, 2500, 'the merchant\'s price is never overwritten');
  assert.equal(body.levonis.price_iqd, 1250, 'the Levonis price is RETURNED beside it');
  assert.equal(body.levonis.option_key, 'opt-6x3');
  const spec = readPartSpec(body.product.part_spec)!;
  assert.deepEqual({ h: spec.height_mm, source: spec.source }, { h: 4, source: 'levonis:lv_mag#opt-6x3' });
  const keys = body.product.media.map((m: { key: string }) => m.key) as string[];
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], levonisCopy, 'the new Levonis picture replaced the old copy');
  assert.match(keys[0], /^merchants\/ali\/public\/lv[0-9a-f]{30}\.webp$/);
  assert.equal(keys[1], 'merchants/ali/public/aaaa1111.webp', 'his own picture is kept');
  // A part that did not come from Levonis has nothing to refresh from.
  const own = (await json(await post(as(w, ALI), '/api/merchant/products', { name: 'Own hook', price_iqd: 300, state: 'hidden', part_spec: { part_kind: 'hook' } }))).product;
  const refused = await post(as(w, ALI), `/api/merchant/parts/${own.id}/refresh`);
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'PART_NOT_ELIGIBLE');
  // An item Levonis took down cannot be refreshed from.
  w.raw.exec("UPDATE products SET status = 'hidden' WHERE id = 'lv_mag'");
  assert.equal((await post(as(w, ALI), `/api/merchant/parts/${part.id}/refresh`)).status, 404);
});

test('both doors are rate limited — 60 imports and 60 refreshes an hour', async () => {
  const w = world();
  const now = Math.floor(Date.now() / 1000);
  const window = now - (now % 3600);
  w.raw.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 60), (?, ?, 60)').run(
    rateLimitKey('merchant-product-create', 'ali', '1.2.3.4'), window,
    rateLimitKey('merchant-part-refresh', 'ali', '1.2.3.4'), window
  );
  const res = await post(as(w, ALI), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag' });
  assert.equal(res.status, 429);
  assert.equal((await post(as(w, ALI), '/api/merchant/parts/cp_any/refresh')).status, 429);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM community_products'), 0);
});
