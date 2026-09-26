/**
 * THE ADMIN SIDE OF CATALOG PRESENTATION (catalog discovery S1, migration 0136).
 *
 * The owner writes a section's description and sets its hero photo on the
 * sections screen; the slug `all` is refused (the listing reserves it); a
 * renamed slug keeps resolving (owner Q11); and every write drops the cached
 * tree and the taxonomy index, so the storefront shows the edit.
 *
 * Run: node --import tsx --test tests/adminTaxonomyDescription.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, asD1, ctx, freshDb, get, json, post, row, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { catalogRoutes } from '../worker/routes/catalog';
import { productRoutes } from '../worker/routes/products';
import { MEDIA_REFERENCE_SOURCES } from '../worker/lib/mediaRefs';

const ADMIN = { id: 'usr_boss', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

class Bucket {
  readonly puts = new Map<string, number>();
  async head(key: string) { return this.puts.has(key) ? ({ key } as unknown) : null; }
  async get(key: string) { return this.puts.has(key) ? ({ key } as unknown) : null; }
  async put(key: string, value: ArrayBufferView) { this.puts.set(key, (value as Uint8Array).byteLength); }
  async delete(key: string) { this.puts.delete(key); }
}

function webp(width = 1600, height = 900, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return b;
}

function setup() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const db = asD1(raw);
  const bucket = new Bucket();
  const admin = stubApp(db as never, ADMIN, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes), {
    host: APEX,
    env: { DB: db, BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket },
  });
  const store = stubApp(db as never, null, (a) => a.route('/api/catalog', catalogRoutes).route('/api/products', productRoutes));
  return { raw, admin, store, bucket };
}

test('a description is written per language, kept by a partial update, and cleared by an empty string', async () => {
  const { raw, admin, store } = setup();
  const res = await post(admin, '/api/admin/taxonomy/catalogs', {
    id: 'cat_makers',
    name_en: "Maker's Supply",
    description_ar: 'كل ما يحتاجه الصانع.',
    description_en: 'Everything a maker needs.',
    description_ckb: 'هەموو شتێک بۆ دروستکەر.',
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(
    row(raw, "SELECT description_ar, description_en, description_ckb FROM catalogs WHERE id = 'cat_makers'"),
    { description_ar: 'كل ما يحتاجه الصانع.', description_en: 'Everything a maker needs.', description_ckb: 'هەموو شتێک بۆ دروستکەر.' }
  );
  // An active toggle sends no description and must not wipe it.
  await post(admin, '/api/admin/taxonomy/catalogs', { id: 'cat_makers', name_en: "Maker's Supply", active: false });
  assert.equal(row<{ d: string }>(raw, "SELECT description_ar AS d FROM catalogs WHERE id = 'cat_makers'")!.d, 'كل ما يحتاجه الصانع.');
  await post(admin, '/api/admin/taxonomy/catalogs', { id: 'cat_makers', name_en: "Maker's Supply", active: true, description_en: '' });
  assert.equal(row<{ d: string }>(raw, "SELECT description_en AS d FROM catalogs WHERE id = 'cat_makers'")!.d, '');

  // The admin list carries it, and the storefront tree shows it.
  const list = await json(await get(admin, '/api/admin/taxonomy/catalogs'));
  const makers = list.catalogs.find((c: { id: string }) => c.id === 'cat_makers');
  assert.equal(makers.description_ar, 'كل ما يحتاجه الصانع.');
  assert.equal(makers.hero_image_url, '');
  const tree = await json(await get(store, '/api/catalog/tree'));
  assert.equal(tree.roots.find((r: { id: string }) => r.id === 'cat_makers').description_ar, 'كل ما يحتاجه الصانع.');
});

test('a description longer than one or two lines is refused', async () => {
  const { admin } = setup();
  const res = await post(admin, '/api/admin/taxonomy/catalogs', { id: 'cat_makers', name_en: 'M', description_ar: 'x'.repeat(281) });
  assert.equal(res.status, 400);
});

test('a new section can carry its description from the start', async () => {
  const { raw, admin } = setup();
  const res = await post(admin, '/api/admin/taxonomy/catalogs', { id: 'cat_new', name_en: 'Scanners', description_en: '3D scanners.' });
  assert.equal(res.status, 200);
  assert.equal(row<{ d: string }>(raw, "SELECT description_en AS d FROM catalogs WHERE id = 'cat_new'")!.d, '3D scanners.');
});

test('the slug `all` is reserved — typed or derived — with a stable code', async () => {
  const { admin } = setup();
  for (const body of [{ name_en: 'Anything', slug: 'all' }, { name_en: 'All' }, { id: 'cat_makers', name_en: 'M', slug: 'ALL' }]) {
    const res = await post(admin, '/api/admin/taxonomy/catalogs', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await json(res)).code, 'CATALOG_SLUG_RESERVED');
  }
});

test('a renamed slug keeps resolving: the category page says `moved`, the old ?category= still lists', async () => {
  const { raw, admin, store } = setup();
  const res = await post(admin, '/api/admin/taxonomy/catalogs', { id: 'cat_printers', name_en: 'Printers', slug: '3d-printers' });
  assert.equal(res.status, 200);
  assert.deepEqual(row(raw, "SELECT slug, catalog_id FROM catalog_slug_history"), { slug: 'printers', catalog_id: 'cat_printers' });

  const page = await json(await get(store, '/api/catalog/printers'));
  assert.equal(page.moved, true);
  assert.equal(page.node.slug, '3d-printers');
  assert.equal(page.node.path, '/categories/3d-printers');
  const fresh = await json(await get(store, '/api/catalog/3d-printers'));
  assert.equal(fresh.moved, false);

  const listing = await json(await get(store, '/api/products?category=printers'));
  assert.equal(listing.category.id, 'cat_printers');
  assert.equal(listing.category.path, '/categories/3d-printers', 'the old link can replace to the new path');
  assert.equal(listing.products.length, 10);

  // Renaming BACK makes the slug live again, and it is no longer history.
  await post(admin, '/api/admin/taxonomy/catalogs', { id: 'cat_printers', name_en: 'Printers', slug: 'printers' });
  assert.deepEqual(
    (raw.prepare('SELECT slug FROM catalog_slug_history ORDER BY slug').all() as Array<{ slug: string }>).map((r) => r.slug),
    ['3d-printers']
  );
  assert.equal((await json(await get(store, '/api/catalog/printers'))).moved, false);
});

test('the hero photo has its own upload and removal, WebP only, and reaches the tree as a URL', async () => {
  const { raw, admin, store, bucket } = setup();
  const form = new FormData();
  form.append('file', new File([webp() as BlobPart], 'hero.webp'));
  const res = await admin.request('/api/admin/taxonomy/catalogs/cat_printers/hero-image', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await json(res);
  assert.match(String(body.hero_image_url), /^\/files\/UiUx\/MainPage\/catalog-catprinters-hero[a-z0-9]+\.webp$/);
  assert.ok(bucket.puts.has(String(body.hero_image_key)));
  assert.equal(row<{ k: string }>(raw, "SELECT image_key AS k FROM catalogs WHERE id = 'cat_printers'")!.k, '', 'the home cover is untouched');

  const tree = await json(await get(store, '/api/catalog/tree'));
  assert.equal(tree.roots[0].hero_image_url, body.hero_image_url);

  const png = new Uint8Array(64);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const bad = new FormData();
  bad.append('file', new File([png as BlobPart], 'hero.webp'));
  const refused = await admin.request('/api/admin/taxonomy/catalogs/cat_printers/hero-image', { method: 'POST', body: bad, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'SITE_MEDIA_NOT_WEBP');

  const del = await admin.request('/api/admin/taxonomy/catalogs/cat_printers/hero-image', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(del.status, 200);
  assert.equal(row<{ k: string }>(raw, "SELECT hero_image_key AS k FROM catalogs WHERE id = 'cat_printers'")!.k, '');
});

test('the media sweeper knows the hero column holds a live key', () => {
  assert.ok(MEDIA_REFERENCE_SOURCES.some((s) => s.table === 'catalogs' && s.column === 'hero_image_key'));
});
