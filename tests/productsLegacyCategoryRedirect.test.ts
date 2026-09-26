/**
 * OLD `/products?category=` LINKS HAVE A CANONICAL HOME (catalog discovery,
 * docs/ux/CATALOG_DISCOVERY.md §2 «Routes», IMPLEMENTATION_PLAN.md S5/S8).
 *
 * The listing route echoes the catalog it resolved with its canonical path
 * (`ResolvedCategory.path`, S1). `legacyCategoryTarget` turns that echo into the
 * URL an old link should `replace` to — keeping any other parameter — and
 * answers null for a legacy free-text token the server cannot name, which keeps
 * listing exactly as today (tests/homeCategories.test.ts).
 *
 * The switch that performs the replace on /products belongs to the wiring
 * stream (S8), which flips the home links after the owner's OK; this pins the
 * target it will use.
 *
 * Run: node --import tsx --test tests/productsLegacyCategoryRedirect.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { productRoutes } from '../worker/routes/products';
import { legacyCategoryTarget } from '../src/lib/catalog/listingModel';

function app(extra = '') {
  const raw = freshDb();
  seedLiveCatalog(raw);
  if (extra) raw.exec(extra);
  return stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
}

const echo = async (a: ReturnType<typeof app>, category: string) =>
  ((await json(await a.request(`/api/products?category=${encodeURIComponent(category)}&limit=1`))) as { category?: { path?: string } | null }).category;

test('/products?category=cat_printers_fdm → /categories/printers/fdm-printers', async () => {
  const a = app();
  assert.equal(legacyCategoryTarget(await echo(a, 'cat_printers_fdm'), '?category=cat_printers_fdm'), '/categories/printers/fdm-printers');
});

test('a root, by id or by slug, → its category page', async () => {
  const a = app();
  assert.equal(legacyCategoryTarget(await echo(a, 'cat_printers'), '?category=cat_printers'), '/categories/printers');
  assert.equal(legacyCategoryTarget(await echo(a, 'printers'), 'category=printers'), '/categories/printers');
});

test('other parameters travel with the redirect', async () => {
  const a = app();
  assert.equal(
    legacyCategoryTarget(await echo(a, 'cat_printers_fdm'), '?category=cat_printers_fdm&avail=1&sort=price_asc'),
    '/categories/printers/fdm-printers?avail=1&sort=price_asc'
  );
});

test('a legacy free-text token keeps listing: no target', async () => {
  const a = app(`UPDATE products SET subcategory_id = 'old-token' WHERE id = (SELECT id FROM products LIMIT 1)`);
  const category = await echo(a, 'old-token');
  assert.equal(category, null, 'the server names no catalog for it');
  assert.equal(legacyCategoryTarget(category, '?category=old-token'), null);
  assert.equal(legacyCategoryTarget(undefined, ''), null);
  assert.equal(legacyCategoryTarget({ path: '/elsewhere' }, ''), null, 'only a category path is ever a target');
});
