/**
 * «الصورة الرئيسية للوضع الفاتح» — ONE PRODUCT, TWO MAIN IMAGES (migration 0138).
 *
 * The owner: «اجعل للادمن في تفاصيل صفحة المنتج (تعديل / اضافة) خيار يمكن وضع
 * الصورة الرئيسية للوضع الداكن والصورة الرئيسية للوضع الفاتح».
 *
 * The chain this pins, hop by hop, through the real routes:
 *
 *   TXT template → ProductDoc → D1 `products.light_image`
 *     → GET admin product → ProductForm state (`toEditorDoc`)
 *     → save from the form, and a save that never mentions the field
 *     → GET /api/products/:slug, the /api/products card, the compare card
 *     → the storefront's choice of picture per theme (src/lib/productImage.ts)
 *
 * and the guards around it: only an owned, processed product image is kept;
 * the public payload carries the key only when there is a picture; the orphan
 * sweep knows the column; the CSV importer refuses a path it cannot keep.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, asD1, stubApp, post, get, json, row, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { productRoutes } from '../worker/routes/products';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { PRODUCT_COLUMNS, parseProductRow, projectPublic } from '../worker/lib/productModel';
import { MEDIA_REFERENCE_SOURCES } from '../worker/lib/mediaRefs';
import { loadLightProductImages } from '../worker/lib/productSelectionImage';
import { parseImport, templateShape } from '../worker/lib/importCsv';
import { productMainImage, themedImage } from '../src/lib/productImage';
import { isStorableLightImage } from '../src/components/adminProducts/form/MainImagesPair';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
  a.route('/api/products', productRoutes);
};

function setup() {
  const raw = freshDb();
  const db = asD1(raw);
  return { raw, db, app: stubApp(db, OWNER, mount) };
}

const LIGHT = '/files/products/prd_a1/a1-light.webp';
const LIGHT_2 = '/files/products/prd_a1/a1-light-v2.webp';

const TXT = (extra = '') => `template_version=2
slug=a1-two-images
name_ar=إيه1
name_en=Bambu Lab A1
status=draft
price_iqd=725000
${extra}`;

async function formDoc(a: App, id: string) {
  const p = await json(await get(a, `/api/admin/products-v2/${id}`));
  assert.equal(p.success, true, JSON.stringify(p));
  return toEditorDoc(p.product);
}

const updatedAt = (raw: ReturnType<typeof freshDb>, id: string) =>
  String(row(raw, 'SELECT updated_at FROM products WHERE id = ?', id)!.updated_at);

// ============================================================ the whole chain

test('0138 — the light main image travels TXT → D1 → admin form → save → storefront', async () => {
  const { raw, app } = setup();

  const created = await json(await post(app, '/api/admin/template/apply', { text: TXT(`light_image=${LIGHT}`), mode: 'draft', confirm: true }));
  assert.equal(created.success, true, JSON.stringify(created));
  const id = created.product_id as string;

  // The DATABASE, not the parser's echo.
  assert.equal(row<{ light_image: string }>(raw, 'SELECT light_image FROM products WHERE id = ?', id)!.light_image, LIGHT);

  // The admin form reads it through its own transform.
  const doc = await formDoc(app, id);
  assert.equal(doc.light_image, LIGHT, 'the «الصورة الرئيسية للوضع الفاتح» slot shows the stored picture');

  // Saved from the form, replaced.
  const replaced = await json(await post(app, '/api/admin/products-v2', { ...doc, light_image: LIGHT_2, expected_updated_at: updatedAt(raw, id) }));
  assert.equal(replaced.success, true, JSON.stringify(replaced));
  assert.equal((await formDoc(app, id)).light_image, LIGHT_2);

  // A client that never heard of the field keeps it (the `condition` rule).
  const { light_image: _omit, ...older } = await formDoc(app, id);
  const partial = await json(await post(app, '/api/admin/products-v2', { ...older, expected_updated_at: updatedAt(raw, id) }));
  assert.equal(partial.success, true, JSON.stringify(partial));
  assert.equal((await formDoc(app, id)).light_image, LIGHT_2, 'omitting the key never erases the picture');

  // The storefront: the product page and the listing card both carry it.
  raw.prepare("UPDATE products SET status = 'active' WHERE id = ?").run(id);
  const detail = await json(await get(app, '/api/products/a1-two-images'));
  const product = (detail.product ?? detail) as Record<string, unknown>;
  assert.equal(product.light_image, LIGHT_2, 'GET /api/products/:slug');
  const list = await json(await get(app, '/api/products'));
  const card = ((list.products ?? list.items) as Array<Record<string, unknown>>).find((p) => p.id === id);
  assert.ok(card, 'the product is listed');
  assert.equal(card!.light_image, LIGHT_2, 'the /api/products card');

  // Removing it is `light_image: ''`, and then no card carries the key at all.
  const cleared = await json(await post(app, '/api/admin/products-v2', { ...(await formDoc(app, id)), status: 'active', light_image: '', expected_updated_at: updatedAt(raw, id) }));
  assert.equal(cleared.success, true, JSON.stringify(cleared));
  const after = ((await json(await get(app, '/api/products'))).products as Array<Record<string, unknown>>).find((p) => p.id === id);
  assert.equal('light_image' in after!, false, 'no picture, no key — every other listing payload is byte-identical');
});

test('0138 — only an owned, processed product image is kept; anything else is dropped at the model', () => {
  const base = { id: 'p', slug: 'p', name: 'P', images: '[]' };
  const keep = parseProductRow({ ...base, light_image: LIGHT });
  assert.equal(keep.light_image, LIGHT);
  for (const bad of ['https://cdn.example.com/a.webp', '/files/products/a.png', 'javascript:alert(1)', '/files/../x.webp', 42]) {
    assert.equal(parseProductRow({ ...base, light_image: bad }).light_image, '', `${String(bad)} is not a stored product image`);
  }
  assert.equal(parseProductRow(base).light_image, '', 'a row from before 0138 reads as no light image');
  // Public projection: present only when set.
  assert.equal(projectPublic(keep).light_image, LIGHT);
  assert.equal('light_image' in projectPublic(parseProductRow(base)), false);
});

test('0138 — the column is written, swept safely, and in the migration count', () => {
  assert.ok((PRODUCT_COLUMNS as readonly string[]).includes('light_image'), 'PRODUCT_COLUMNS is the write path');
  assert.ok(
    MEDIA_REFERENCE_SOURCES.some((s) => s.table === 'products' && s.column === 'light_image'),
    'the orphan sweep must never delete a file only this column points at'
  );
  const sql = readFileSync(new URL('../migrations/0138_product_light_image.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE products ADD COLUMN light_image TEXT NOT NULL DEFAULT ''/);
  const persistence = readFileSync(new URL('../worker/lib/productPersistence.ts', import.meta.url), 'utf8');
  assert.match(persistence, /productsHaveColumn\(db, 'light_image'\)/, 'a save crosses the deploy window before 0138 lands');
});

test('0138 — the compare card reads light images in one bounded query, and survives a database before 0138', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT INTO products (id, slug, name, light_image) VALUES ('p1','p1','P1',?), ('p2','p2','P2','')").run(LIGHT);
  const map = await loadLightProductImages(db, ['p1', 'p2', 'missing']);
  assert.deepEqual([...map.entries()], [['p1', LIGHT]], 'only products that HAVE one');

  const old = freshDb();
  old.exec('ALTER TABLE products DROP COLUMN light_image');
  assert.deepEqual([...(await loadLightProductImages(asD1(old), ['p1'])).entries()], [], 'no column = no light images, not an error');
});

test('0138 — the CSV importer refuses a light_image it could not keep, with the line', () => {
  const shape = templateShape('printer', ['printers']);
  const parseProductsCsv = (text: string) => parseImport(text, shape);
  const header = 'row_type,key,name,light_image';
  const ok = parseProductsCsv(`${header}\nproduct,a1,Bambu Lab A1,${LIGHT}\n`);
  const product = ok.products[0] as unknown as { light_image: string | null };
  assert.equal(product.light_image, LIGHT);
  const bad = parseProductsCsv(`${header}\nproduct,a1,Bambu Lab A1,https://cdn.example.com/a1.jpg\n`);
  assert.ok(
    bad.issues.some((i) => i.severity === 'error' && /light_image/.test(i.message) && i.line === 2),
    JSON.stringify(bad.issues)
  );
  const none = parseProductsCsv('row_type,key,name\nproduct,a1,Bambu Lab A1\n');
  assert.equal((none.products[0] as unknown as { light_image: string | null }).light_image, null, 'no column = keep what is stored');
});

test('0138 — the storefront shows the light image on the light theme only, the primary everywhere else', () => {
  const p = { media: [{ url: '/files/products/a/dark.webp', primary: true }], images: ['/files/products/a/dark.webp'], light_image: LIGHT };
  assert.equal(productMainImage(p, 'light'), LIGHT);
  assert.equal(productMainImage(p, 'dark'), '/files/products/a/dark.webp');
  assert.equal(productMainImage({ ...p, light_image: '' }, 'light'), '/files/products/a/dark.webp', 'no light image = the primary in both');
  assert.equal(productMainImage({ ...p, light_image: undefined }, 'light'), '/files/products/a/dark.webp');
  assert.equal(themedImage('d', 'l', 'light'), 'l');
  assert.equal(themedImage('d', 'l', 'dark'), 'd');
  assert.equal(themedImage('d', '', 'light'), 'd');
  // The editor refuses an upload the model would silently drop.
  assert.equal(isStorableLightImage(LIGHT), true);
  assert.equal(isStorableLightImage('/files/products/a.avif'), false);
  assert.equal(isStorableLightImage('https://x.co/a.webp'), false);
});
