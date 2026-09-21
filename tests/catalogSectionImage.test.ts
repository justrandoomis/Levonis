/**
 * THE PICTURE A SUB-SECTION SHOWS ON THE HOME PAGE.
 *
 * THE OWNER'S REQUEST. «قم في الاقسام الرئيسية في الاقسام الفرعية اجعل
 * بالامكان للادمن وضع صورة للاقسام الفرعية في الواجهة الرئيسية».
 *
 * WHAT THE PAGE DID BEFORE. `catalogs` had no image column (0002 created the
 * table; the only later ALTER was `template_family` in 0018), so
 * CategoryBoard BORROWED a cover: the first photo among the products the home
 * page had already fetched that was filed under that section. Nobody decided
 * it — which of eight filaments stood for «خيوط PLA» depended on the order a
 * shelf query returned — and a section whose products were not among the
 * thirty on the first screen drew its monogram however good its artwork was.
 *
 * Migration 0100 adds `catalogs.image_key`, and this file pins the four
 * properties that make it safe:
 *
 *   IT REACHES THE STOREFRONT as a URL, never as a storage key.
 *   IT IS WEBP AND NOTHING ELSE, checked from the bytes rather than the name.
 *   IT NEVER REUSES AN OBJECT NAME, because /files/* stamps public keys
 *     `immutable` for a year and a replacement under a live key would keep
 *     showing the old picture with nothing here able to purge it.
 *   IT IS VISIBLE TO THE MEDIA SWEEPER, or the first cleanup would delete
 *     every cover the owner had uploaded.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, asD1, ctx, freshDb, json, stubApp } from './fixtures/app';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { homeRoutes } from '../worker/routes/products';
import { catalogTreeWithCounts, homeCategoryTree } from '../worker/lib/catalogMembership';
import { MEDIA_REFERENCE_SOURCES } from '../worker/lib/mediaRefs';
import {
  MAIN_PAGE_PREFIX,
  catalogImageUrl,
  isCatalogImageKey,
  mintCatalogImageObject,
} from '../worker/lib/siteMedia';
import { isAnonymousPublicMediaKey, isSafeMediaKey } from '../worker/lib/mediaStorage';

type Raw = ReturnType<typeof freshDb>;

const ADMIN = { id: 'usr_boss', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

/** An in-memory R2 that remembers what was written and under which key. */
class Bucket {
  readonly puts = new Map<string, { bytes: number; options: unknown }>();
  async head(key: string) {
    return this.puts.has(key) ? ({ key } as unknown) : null;
  }
  async get(key: string) {
    return this.puts.has(key) ? ({ key } as unknown) : null;
  }
  async put(key: string, value: ArrayBufferView, options: unknown) {
    this.puts.set(key, { bytes: (value as Uint8Array).byteLength, options });
  }
  async delete(key: string) {
    this.puts.delete(key);
  }
}

/**
 * A WebP header the sniffer accepts and the dimension reader can measure.
 * VP8X carries width and height as 24-bit "minus one" fields at 24 and 27.
 */
function webp(width = 800, height = 600, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const w = width - 1;
  const h = height - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return b;
}

/** A PNG, so the WebP rule can be tested with something that is not one. */
function png(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
}

/**
 * The fixture already ships the owner's taxonomy, so nothing here invents a
 * section: one product is filed the way the admin form files one — the
 * classification columns written, `product_catalogs` untouched — which is
 * what puts «الطابعات» and its «طابعات FDM» child on the home page at all.
 */
const SUB = 'cat_printers_fdm';

function seed(raw: Raw): void {
  raw.prepare(
    `INSERT INTO products (id, slug, name, description, price_iqd, status, category_id, sub_category_id)
     VALUES ('prd_a1', 'a1-mini', 'A1 mini', '', 500000, 'active', 'cat_printers', ?)`
  ).run(SUB);
}

interface HomeNode {
  id: string;
  image_url?: string;
  children?: HomeNode[];
}

/** The «الطابعات» department, as `/api/home` returns it. */
const printers = (body: Record<string, unknown>): HomeNode =>
  (body.categories as HomeNode[]).find((c) => c.id === 'cat_printers')!;

function setup() {
  const raw = freshDb();
  seed(raw);
  const bucket = new Bucket();
  const db = asD1(raw);
  const admin = stubApp(db as never, ADMIN, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes), {
    host: APEX,
    env: { DB: db, BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket },
  });
  const store = stubApp(db as never, null, (a) => a.route('/api/home', homeRoutes), {
    host: APEX,
    env: { DB: db },
  });
  return { raw, db, bucket, admin, store };
}

const upload = (app: ReturnType<typeof setup>['admin'], id: string, bytes: Uint8Array, name = 'cover.webp') => {
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], name));
  return app.request(
    `/api/admin/taxonomy/catalogs/${id}/image`,
    { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
};

// =========================================================================
// THE WHOLE ROUND TRIP
// =========================================================================

test('an admin uploads a WebP and the home page draws it on the sub-section', async () => {
  const { bucket, admin, store } = setup();

  const before = await json(await store.request('/api/home', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx));
  const subBefore = printers(before).children![0];
  assert.equal(subBefore.id, SUB);
  assert.equal(subBefore.image_url, '', 'no picture until one is uploaded — and that is a state, not an error');

  const res = await upload(admin, SUB, webp());
  assert.equal(res.status, 200, await res.clone().text());
  const body = await json(res);
  assert.match(String(body.image_url), /^\/files\/UiUx\/MainPage\/catalog-catprintersfdm-[a-z0-9]+\.webp$/);

  // The bytes really are in the bucket, under the key the pointer names.
  const key = String(body.image_url).replace('/files/', '');
  assert.ok(bucket.puts.has(key), 'the object must exist before anything points at it');

  const after = await json(await store.request('/api/home', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx));
  assert.equal(printers(after).children![0].image_url, body.image_url, 'and the first screen shows it');
});

test('the storefront is given a URL, never a storage key', async () => {
  const { admin, store } = setup();
  await upload(admin, SUB, webp());
  const body = await json(await store.request('/api/home', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx));
  const node = printers(body).children![0];
  assert.equal('image_key' in node, false, 'the raw key must not leave the worker');
  assert.match(String(node.image_url), /^\/files\//);
});

test('a cover is fetchable by a signed-out visitor — the first screen has no session', async () => {
  const { admin } = setup();
  const body = await json(await upload(admin, SUB, webp()));
  const key = String(body.image_url).replace('/files/', '');
  assert.ok(isSafeMediaKey(key), `${key} is not a safe media key`);
  assert.ok(isAnonymousPublicMediaKey(key), 'a category card must not ask a first-time visitor to sign in');
});

// =========================================================================
// THE OWNER'S WEBP RULE
// =========================================================================

test('a PNG renamed .webp is refused — the check is on the bytes, not the filename', async () => {
  const { admin, bucket } = setup();
  const res = await upload(admin, SUB, png(), 'not-really.webp');
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'SITE_MEDIA_NOT_WEBP');
  assert.equal(bucket.puts.size, 0, 'and nothing was stored');
});

test('a section that does not exist is a 404, not a stray object in the bucket', async () => {
  const { admin, bucket } = setup();
  const res = await upload(admin, 'cat_nope', webp());
  assert.equal(res.status, 404);
  assert.equal(bucket.puts.size, 0);
});

// =========================================================================
// WHY THE OBJECT NAME IS NEVER REUSED
// =========================================================================

test('a replacement lands on a NEW key, because /files/* stamps public keys immutable for a year', async () => {
  const { admin, bucket } = setup();
  const first = await json(await upload(admin, SUB, webp(800, 600)));
  const second = await json(await upload(admin, SUB, webp(400, 300)));

  assert.notEqual(first.image_url, second.image_url, 'the same key would keep serving the old picture');
  assert.equal(bucket.puts.size, 2, 'both objects exist; the pointer moved, the bytes were not overwritten');

  const stored = bucket.puts.get(String(second.image_url).replace('/files/', ''))!;
  const options = stored.options as { httpMetadata?: { cacheControl?: string; contentType?: string } };
  assert.equal(options.httpMetadata?.cacheControl, 'public, max-age=31536000, immutable');
  assert.equal(options.httpMetadata?.contentType, 'image/webp');
});

test('mintCatalogImageObject never answers the same name twice for one section', () => {
  const a = mintCatalogImageObject('cat_printers_fdm', 'tok_AAA111');
  const b = mintCatalogImageObject('cat_printers_fdm', 'tok_BBB222');
  assert.notEqual(a, b);
  for (const object of [a, b]) {
    assert.match(object, /\.webp$/);
    assert.ok(isCatalogImageKey(MAIN_PAGE_PREFIX + object), `${object} must be storable`);
  }
});

// =========================================================================
// REMOVING THE PICTURE
// =========================================================================

test('removing a cover clears the pointer and leaves the bytes to the sweeper', async () => {
  const { admin, store, bucket } = setup();
  const up = await json(await upload(admin, SUB, webp()));
  const key = String(up.image_url).replace('/files/', '');

  const res = await admin.request(
    `/api/admin/taxonomy/catalogs/${SUB}/image`,
    { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  assert.equal(res.status, 200);
  assert.equal((await json(res)).image_url, '');

  const body = await json(await store.request('/api/home', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx));
  assert.equal(printers(body).children![0].image_url, '', 'the section goes back to borrowing a product photo');
  // The route must NOT delete from R2 itself: only the sweeper can see whether
  // another row still points at the same bytes.
  assert.ok(bucket.puts.has(key), 'the object outlives the pointer');
});

// =========================================================================
// AN ORDINARY EDIT MUST NOT WIPE THE PICTURE
// =========================================================================

test('renaming a section keeps its cover — the upsert names its columns and image_key is not one', async () => {
  const { admin } = setup();
  const up = await json(await upload(admin, SUB, webp()));

  const res = await admin.request(
    '/api/admin/taxonomy/catalogs',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ id: SUB, name_en: 'FDM Printers (renamed)', parent_id: 'cat_printers' }),
    },
    undefined,
    ctx
  );
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await json(res)).catalog.image_key, String(up.image_url).replace('/files/', ''));
});

// =========================================================================
// THE SWEEPER MUST BE ABLE TO SEE IT
// =========================================================================

test('catalogs.image_key is a registered media reference, or the first cleanup deletes every cover', () => {
  const source = MEDIA_REFERENCE_SOURCES.find((s) => s.table === 'catalogs' && s.column === 'image_key');
  assert.ok(source, 'worker/lib/mediaRefs.ts must know this column holds a live key');
  // `text`, not `json`: the column stores the whole key, exactly like
  // product_images.r2_key, so the generic walker resolves it with no
  // special case — see migration 0100 for why it is not a bare filename.
  assert.equal(source!.kind, 'text');
  // No `where`. A deactivated section still holds its artwork, and the owner
  // reactivates sections routinely; narrowing on `active` would make
  // "deactivate, then activate again" silently lose the picture.
  assert.equal(source!.where, undefined);
});

// =========================================================================
// THE DEPLOY WINDOW
// =========================================================================

test('a value that is not a storable key degrades to "no picture", never to a broken <img>', () => {
  for (const bad of ['', null, undefined, 42, 'products/owner/gallery/a.webp', 'UiUx/MainPage/../secret.webp', 'UiUx/MainPage/a.png']) {
    assert.equal(catalogImageUrl(bad), '', `${JSON.stringify(bad)} must not become a URL`);
  }
  assert.equal(catalogImageUrl('UiUx/MainPage/catalog-x-ab12.webp'), '/files/UiUx/MainPage/catalog-x-ab12.webp');
});

test('the tree still answers on a database that has not had migration 0100 applied', async () => {
  const raw = freshDb();
  seed(raw);
  // The exact shape of the deploy window: the code is live, the column is not.
  raw.exec('ALTER TABLE catalogs DROP COLUMN image_key');

  const db = asD1(raw);
  const rows = await catalogTreeWithCounts(db as never);
  assert.ok(rows.length >= 2, 'the departments must still be there');
  for (const r of rows) {
    assert.equal(r.image_url, '', 'every row reads as "no authored picture", which is what it would hold');
  }

  const tree = await homeCategoryTree(db as never);
  assert.equal(tree.find((t) => t.id === 'cat_printers')?.id, 'cat_printers');
  assert.equal(tree.find((t) => t.id === 'cat_printers')?.children?.[0].id, SUB, 'and the sub-section is still on the page');
});

test('a MISSING CATALOGS TABLE still fails loudly — an empty shop is not an honest answer', async () => {
  const raw = freshDb();
  raw.exec('DROP TABLE catalogs');
  await assert.rejects(() => catalogTreeWithCounts(asD1(raw) as never));
});
