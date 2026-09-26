/**
 * ONE CATEGORY AS A PAGE — GET /api/catalog/:slug (catalog discovery S1).
 *
 * Acceptance over the live data of 2026-09-25: /categories/printers has an FDM
 * shelf (10), «جاهزة للتسليم الآن» (4), «للطباعة بأكثر من لون» (≥ 3) and two
 * brands; /categories/printing-materials renders as a listing; a section with
 * no products is a 404; an inactive section that still holds products renders.
 *
 * Run: node --import tsx --test tests/catalogPageRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { P, seedLiveCatalog } from './fixtures/liveCatalog';
import { catalogRoutes } from '../worker/routes/catalog';

function world(extra = '', user: { id: string; role: 'customer'; email: string } | null = null) {
  const raw = freshDb();
  seedLiveCatalog(raw);
  if (extra) raw.exec(extra);
  const app = stubApp(asD1(raw), user, (a) => a.route('/api/catalog', catalogRoutes));
  return { raw, app };
}

interface ShelfOut {
  id: string;
  kind: string;
  count: number;
  see_all: string;
  products: Array<{ id: string; direct_stock_available?: number; compare_type?: string }>;
}

test('/categories/printers: FDM (10), available now (4), multicolour (≥3), brands (2)', async () => {
  const { app } = world();
  const res = await get(app, '/api/catalog/printers');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /public, max-age=60/, 'signed-out answers are cacheable');
  const b = await json(res);
  assert.equal(b.layout, 'shelves');
  assert.equal(b.moved, false);
  assert.equal(b.node.product_count, 10);
  assert.equal(b.node.available_count, 4);
  assert.deepEqual(b.path.map((p: { slug: string }) => p.slug), ['printers']);
  const shelves = b.shelves as ShelfOut[];
  assert.deepEqual(shelves.map((s) => [s.id, s.count]), [
    ['child:cat_printers_fdm', 10],
    ['available', 4],
    ['multicolor', 7],
    ['brand', 2],
  ]);
  const fdm = shelves[0];
  assert.equal(fdm.see_all, '/categories/printers/fdm-printers');
  assert.equal(fdm.products.length, 10);
  assert.ok(fdm.products.slice(0, 4).every((p) => (p.direct_stock_available ?? 0) > 0), 'available first on every rail');
  assert.equal(fdm.products[0].compare_type, 'printer');
  assert.equal(shelves[1].see_all, '/categories/printers/all?avail=1');
  assert.equal(shelves[2].see_all, '/categories/printers/all?colors=16-');
  assert.deepEqual(b.brands.map((x: { slug: string; count: number }) => [x.slug, x.count]), [['bambu-lab', 9], ['snapmaker', 1]]);
  assert.deepEqual(
    b.related.map((r: { slug: string }) => r.slug),
    ['printer-accessories', 'printing-materials', 'makers-supply'],
    'the sibling roots, for «يكمّل طابعتك»'
  );
});

test('a smart shelf needs 3 items and must not repeat a child shelf', async () => {
  // Only two printers available → no «available» shelf.
  const { app } = world(`UPDATE products SET stock = 0 WHERE id IN ('${P.X2D}', '${P.U1}')`);
  const b = await json(await get(app, '/api/catalog/printers'));
  assert.equal((b.shelves as ShelfOut[]).some((s) => s.id === 'available'), false);
});

test('/categories/printing-materials renders as a listing (≤ 1 non-empty child and < 8 products)', async () => {
  const { app } = world();
  const b = await json(await get(app, '/api/catalog/printing-materials'));
  assert.equal(b.layout, 'listing');
  assert.equal(b.node.product_count, 1);
  assert.deepEqual(b.children.map((c: { slug: string }) => c.slug), ['fdm-materials']);
});

test('a sub-section resolves with its breadcrumb, and by id as well as by slug', async () => {
  const { app } = world();
  const bySlug = await json(await get(app, '/api/catalog/fdm-printers'));
  assert.deepEqual(bySlug.path.map((p: { slug: string; path: string }) => [p.slug, p.path]), [
    ['printers', '/categories/printers'],
    ['fdm-printers', '/categories/printers/fdm-printers'],
  ]);
  const byId = await json(await get(app, '/api/catalog/cat_printers_fdm'));
  assert.equal(byId.node.id, 'cat_printers_fdm');
});

test('a section with no products is a 404 CATALOG_NOT_FOUND — so is an unknown slug', async () => {
  const { app } = world();
  for (const slug of ['resin-printers', 'laser-crafting', 'no-such-section']) {
    const res = await get(app, `/api/catalog/${slug}`);
    assert.equal(res.status, 404, slug);
    assert.equal((await json(res)).code, 'CATALOG_NOT_FOUND');
  }
});

test('an INACTIVE section that still holds products still renders', async () => {
  const { app } = world(`UPDATE catalogs SET active = 0 WHERE id = 'cat_makers'`);
  const res = await get(app, '/api/catalog/makers-supply');
  assert.equal(res.status, 200);
  assert.equal((await json(res)).node.product_count, 2);
});

test('a signed-in viewer gets tier-priced cards that are never cached publicly', async () => {
  const { app } = world(
    `INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','U','u@x.co','h','customer')`,
    { id: 'u1', role: 'customer', email: 'u@x.co' }
  );
  const res = await get(app, '/api/catalog/printers');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
});
