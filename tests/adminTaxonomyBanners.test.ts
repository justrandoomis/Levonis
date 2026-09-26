/**
 * A SECTION'S BANNER, ONE PICTURE PER THEME, AND THE ORDER OF THE SECTIONS
 * (owner, 2026-09-26; migration 0142).
 *
 *  - «صورتين تناسب الثيم الفاتح والثيم الداكن … من قسم اعدادات الأقسام
 *    الرئيسية و الفئات الفرعيه»: every section, main or sub, takes a light
 *    banner (`hero-light-image` → catalogs.hero_light_image_key) beside the
 *    dark one it already had (`hero-image` → hero_image_key, 0136). Same rules
 *    as every section picture: WebP by magic bytes, R2 before the pointer,
 *    admins only, re-validated on the way out, known to the media sweeper.
 *  - «يقرر ترتيب الفئات في (كل الفئات)»: POST /catalogs/order writes a whole
 *    level's `sort`, and the storefront follows it.
 *
 * Run: node --import tsx --test tests/adminTaxonomyBanners.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, asD1, ctx, freshDb, get, json, post, row, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { catalogRoutes } from '../worker/routes/catalog';
import { MEDIA_REFERENCE_SOURCES } from '../worker/lib/mediaRefs';

const ADMIN = { id: 'usr_boss', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };
const SHOPPER = { id: 'usr_shop', role: 'customer' as const, email: 'shop@x.co', admin_scope: null };
const IP = { 'CF-Connecting-IP': '1.2.3.4' };

class Bucket {
  readonly puts = new Map<string, number>();
  async head(key: string) { return this.puts.has(key) ? ({ key } as unknown) : null; }
  async get(key: string) { return this.puts.has(key) ? ({ key } as unknown) : null; }
  async put(key: string, value: ArrayBufferView) { this.puts.set(key, (value as Uint8Array).byteLength); }
  async delete(key: string) { this.puts.delete(key); }
}

function webp(width = 2400, height = 300, size = 64): Uint8Array {
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

function setup(user: typeof ADMIN | typeof SHOPPER | null = ADMIN) {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const db = asD1(raw);
  const bucket = new Bucket();
  const env = { DB: db, BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket };
  const admin = stubApp(db as never, user as never, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes), { host: APEX, env });
  const store = stubApp(db as never, null, (a) => a.route('/api/catalog', catalogRoutes));
  return { raw, admin, store, bucket };
}

const upload = (app: ReturnType<typeof setup>['admin'], id: string, segment: string, bytes: Uint8Array) => {
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], 'banner.webp'));
  return app.request(`/api/admin/taxonomy/catalogs/${id}/${segment}`, { method: 'POST', body: form, headers: IP }, undefined, ctx);
};

test('a SUB-section takes a light banner beside its dark one; both reach the tree and the page as URLs', async () => {
  const { raw, admin, store, bucket } = setup();
  const dark = await upload(admin, 'cat_materials_fdm', 'hero-image', webp());
  assert.equal(dark.status, 200, await dark.clone().text());
  const res = await upload(admin, 'cat_materials_fdm', 'hero-light-image', webp());
  assert.equal(res.status, 200, await res.clone().text());
  const body = await json(res);
  assert.match(String(body.hero_light_image_url), /^\/files\/UiUx\/MainPage\/catalog-catmaterialsfdm-light[a-z0-9]+\.webp$/);
  assert.ok(bucket.puts.has(String(body.hero_light_image_key)), 'stored in R2 before the pointer moved');
  const stored = row<{ light: string; dark: string; cover: string }>(
    raw,
    "SELECT hero_light_image_key AS light, hero_image_key AS dark, image_key AS cover FROM catalogs WHERE id = 'cat_materials_fdm'"
  )!;
  assert.equal(`/files/${stored.light}`, body.hero_light_image_url);
  assert.notEqual(stored.dark, stored.light, 'two pictures, two columns');
  assert.equal(stored.cover, '', 'the home cover is untouched');

  // The admin list, the tree and the category page all carry the URL, never the key.
  const list = await json(await get(admin, '/api/admin/taxonomy/catalogs'));
  const fdm = list.catalogs.find((c: { id: string }) => c.id === 'cat_materials_fdm');
  assert.equal(fdm.hero_light_image_url, body.hero_light_image_url);
  const tree = await json(await get(store, '/api/catalog/tree'));
  const materials = tree.roots.find((r: { id: string }) => r.id === 'cat_materials');
  const child = materials.children.find((c: { id: string }) => c.id === 'cat_materials_fdm');
  assert.equal(child.hero_light_image_url, body.hero_light_image_url);
  assert.equal(child.hero_image_url, `/files/${stored.dark}`);
  assert.equal('hero_light_image_key' in child, false, 'the raw key never leaves the worker');
  const page = await json(await get(store, '/api/catalog/printing-materials'));
  assert.equal(page.children[0].hero_light_image_url, body.hero_light_image_url);
  assert.equal(page.node.hero_light_image_url, '', 'the root has none of its own');

  // Clear: the pointer goes, the object stays for the sweeper.
  const del = await admin.request('/api/admin/taxonomy/catalogs/cat_materials_fdm/hero-light-image', { method: 'DELETE', headers: IP }, undefined, ctx);
  assert.equal(del.status, 200);
  assert.equal((await json(del)).hero_light_image_url, '');
  assert.equal(row<{ k: string }>(raw, "SELECT hero_light_image_key AS k FROM catalogs WHERE id = 'cat_materials_fdm'")!.k, '');
  assert.ok(bucket.puts.has(String(body.hero_light_image_key)));
  assert.notEqual(row<{ k: string }>(raw, "SELECT hero_image_key AS k FROM catalogs WHERE id = 'cat_materials_fdm'")!.k, '', 'the dark one is kept');
});

test('the light banner is WebP only, within the size cap, on a section that exists', async () => {
  const { raw, admin } = setup();
  const png = new Uint8Array(64);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const refused = await upload(admin, 'cat_printers', 'hero-light-image', png);
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'SITE_MEDIA_NOT_WEBP');
  const huge = await upload(admin, 'cat_printers', 'hero-light-image', webp(2400, 300, 3 * 1024 * 1024));
  assert.equal(huge.status, 400);
  assert.equal((await json(huge)).code, 'SITE_MEDIA_TOO_LARGE');
  const missing = await upload(admin, 'cat_nope', 'hero-light-image', webp());
  assert.equal(missing.status, 404);
  assert.equal(row<{ k: string }>(raw, "SELECT hero_light_image_key AS k FROM catalogs WHERE id = 'cat_printers'")!.k, '');
});

test('a stored value that is not our WebP under UiUx/MainPage/ never reaches the storefront', async () => {
  const { raw, store } = setup();
  raw.exec(`UPDATE catalogs SET hero_light_image_key = 'https://evil.example/x.webp' WHERE id = 'cat_printers'`);
  const tree = await json(await get(store, '/api/catalog/tree'));
  assert.equal(tree.roots.find((r: { id: string }) => r.id === 'cat_printers').hero_light_image_url, '');
  raw.exec(`UPDATE catalogs SET hero_light_image_key = 'UiUx/MainPage/../../private/x.webp' WHERE id = 'cat_printers'`);
  assert.equal((await json(await get(store, '/api/catalog/printers'))).node.hero_light_image_url, '');
});

test('only an admin may set, clear or reorder', async () => {
  for (const user of [SHOPPER, null]) {
    const { raw, admin } = setup(user as never);
    const up = await upload(admin, 'cat_printers', 'hero-light-image', webp());
    assert.ok(up.status === 401 || up.status === 403, `upload as ${user?.role ?? 'anonymous'}: ${up.status}`);
    const del = await admin.request('/api/admin/taxonomy/catalogs/cat_printers/hero-light-image', { method: 'DELETE', headers: IP }, undefined, ctx);
    assert.ok(del.status === 401 || del.status === 403);
    const order = await post(admin, '/api/admin/taxonomy/catalogs/order', { parent_id: null, ids: ['cat_makers', 'cat_materials', 'cat_pacc', 'cat_printers'] });
    assert.ok(order.status === 401 || order.status === 403);
    assert.equal(row<{ s: number }>(raw, "SELECT sort AS s FROM catalogs WHERE id = 'cat_makers'")!.s, row<{ s: number }>(freshSeed(), "SELECT sort AS s FROM catalogs WHERE id = 'cat_makers'")!.s);
  }
});

function freshSeed() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  return raw;
}

test('the media sweeper knows the light banner column holds a live key', () => {
  const source = MEDIA_REFERENCE_SOURCES.find((s) => s.table === 'catalogs' && s.column === 'hero_light_image_key');
  assert.ok(source);
  assert.equal(source!.kind, 'text');
});

test('the admin orders the main sections; «كل الفئات» follows it exactly', async () => {
  const { raw, admin, store } = setup();
  const roots = (raw.prepare("SELECT id FROM catalogs WHERE parent_id IS NULL").all() as Array<{ id: string }>).map((r) => r.id);
  const wanted = ['cat_materials', 'cat_printers', 'cat_makers', ...roots.filter((id) => !['cat_materials', 'cat_printers', 'cat_makers'].includes(id))];
  const res = await post(admin, '/api/admin/taxonomy/catalogs/order', { parent_id: null, ids: wanted });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(
    (raw.prepare('SELECT id FROM catalogs WHERE parent_id IS NULL ORDER BY sort').all() as Array<{ id: string }>).map((r) => r.id),
    wanted
  );
  assert.equal(row<{ s: number }>(raw, "SELECT sort AS s FROM catalogs WHERE id = 'cat_printers'")!.s, 20, 'written as 10, 20, 30…');
  const tree = await json(await get(store, '/api/catalog/tree'));
  const shown = tree.roots.map((r: { id: string }) => r.id);
  assert.deepEqual(shown, wanted.filter((id) => shown.includes(id)), 'the tree is in the admin’s order');
  assert.equal(shown[0], 'cat_materials');
  assert.ok(row(raw, "SELECT 1 AS x FROM audit_log WHERE action = 'catalog.reorder'"), 'audited');
});

test('a sub-section level is ordered under its own parent, and the category page follows it', async () => {
  const { raw, admin, store } = setup();
  const kids = (raw.prepare("SELECT id FROM catalogs WHERE parent_id = 'cat_printers' ORDER BY sort").all() as Array<{ id: string }>).map((r) => r.id);
  assert.ok(kids.length >= 2, 'the seed has several printer sub-sections');
  const wanted = [...kids].reverse();
  const res = await post(admin, '/api/admin/taxonomy/catalogs/order', { parent_id: 'cat_printers', ids: wanted });
  assert.equal(res.status, 200, await res.clone().text());
  // Make every one visible, so the page's order can be read in full.
  raw.exec(`UPDATE catalogs SET active = 1 WHERE parent_id = 'cat_printers'`);
  const page = await json(await get(store, '/api/catalog/printers'));
  const shown = page.children.map((c: { id: string }) => c.id);
  assert.deepEqual(shown, wanted.filter((id) => shown.includes(id)));
});

test('an order that is not exactly one level is refused and nothing moves', async () => {
  const { raw, admin } = setup();
  const before = JSON.stringify(raw.prepare('SELECT id, sort FROM catalogs ORDER BY id').all());
  const roots = (raw.prepare("SELECT id FROM catalogs WHERE parent_id IS NULL").all() as Array<{ id: string }>).map((r) => r.id);
  const bad = [
    { parent_id: null, ids: roots.slice(1) }, // a sibling missing
    { parent_id: null, ids: [...roots, 'cat_printers_fdm'] }, // a stranger from another level
    { parent_id: null, ids: [...roots.slice(0, -1), roots[0]] }, // a repeat
    { parent_id: 'cat_printers', ids: roots }, // the wrong parent
  ];
  for (const b of bad) {
    const res = await post(admin, '/api/admin/taxonomy/catalogs/order', b);
    assert.equal(res.status, 400, JSON.stringify(b));
    assert.equal((await json(res)).code, 'CATALOG_ORDER_MISMATCH');
  }
  for (const b of [{ parent_id: null, ids: [] }, { parent_id: 7, ids: roots }, { parent_id: null, ids: 'cat_printers' }]) {
    const res = await post(admin, '/api/admin/taxonomy/catalogs/order', b);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'CATALOG_ORDER_INVALID');
  }
  assert.equal(JSON.stringify(raw.prepare('SELECT id, sort FROM catalogs ORDER BY id').all()), before);
});
