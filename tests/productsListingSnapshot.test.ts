/**
 * THE PLAIN LISTING DID NOT MOVE (catalog discovery S1 acceptance).
 *
 * `/api/products` gained sort, filters and facet counts. A request that uses
 * none of them must answer exactly what it answered before — same products,
 * same order, same prices, same paging — except for the three card fields the
 * listing now carries (`sale_types`, `created_at`, `compare_type`) and the
 * category's new `path`.
 *
 * tests/fixtures/snapshots/productsListing.baseline.json was captured from the
 * route BEFORE this change, over the live catalogue of 2026-09-25
 * (tests/fixtures/liveCatalog.ts). It is a regression oracle: regenerate it only
 * for a deliberate change to the plain listing.
 *
 * Run: node --import tsx --test tests/productsListingSnapshot.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { productRoutes } from '../worker/routes/products';

const NEW_CARD_FIELDS = ['sale_types', 'created_at', 'compare_type'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withoutNewFields(body: Record<string, any>) {
  const out = { ...body };
  if (Array.isArray(out.products)) {
    out.products = out.products.map((p: Record<string, unknown>) => {
      const c = { ...p };
      for (const k of NEW_CARD_FIELDS) delete c[k];
      return c;
    });
  }
  if (out.category && typeof out.category === 'object') {
    const { path: _path, ...rest } = out.category as Record<string, unknown>;
    void _path;
    out.category = rest;
  }
  return out;
}

test('every plain listing request answers what it answered before, minus the new card fields', async () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/snapshots/productsListing.baseline.json'), 'utf8')) as Record<string, unknown>;
  const raw = freshDb();
  seedLiveCatalog(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
  assert.ok(Object.keys(baseline).length >= 6);
  for (const [path, expected] of Object.entries(baseline)) {
    const body = await json(await get(app, path));
    assert.deepEqual(withoutNewFields(body), expected, path);
  }
});

test('the new card fields are there, and say what the row says', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
  const body = await json(await get(app, '/api/products?category=cat_printers_fdm'));
  const x2d = body.products.find((p: { slug: string }) => p.slug === 'bambu-lab-x2d');
  assert.deepEqual(x2d.sale_types, ['direct_sale', 'pre_order']);
  assert.equal(x2d.compare_type, 'printer');
  assert.match(x2d.created_at, /^2026-09-20T10:/);
  assert.equal(body.category.path, '/categories/printers/fdm-printers', 'an old ?category= link can replace to this');
  const root = await json(await get(app, '/api/products?category=printers'));
  assert.equal(root.category.path, '/categories/printers');
  const pla = (await json(await get(app, '/api/products?category=cat_materials'))).products[0];
  assert.equal(pla.compare_type, 'filament');
  // No listing parameter → no listing envelope.
  assert.equal('total' in body, false);
  assert.equal('facets' in body, false);
});
