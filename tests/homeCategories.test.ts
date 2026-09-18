/**
 * THE CATEGORIES THE SHOP HAD AND THE STOREFRONT NEVER SHOWED.
 *
 * The owner built the taxonomy — Printers, FDM Printers, Resin Printers,
 * Printing Materials and eighteen more — filed three products under it, saw
 * «الطابعات · 3» in the admin, and the home page showed no categories at all.
 * The live `/api/home` answered `"categories": []`.
 *
 * `product_catalogs` was empty, and it was being emptied on purpose by every
 * save: the product form posts `catalog_ids: []` while the owner's section
 * picks land in `products.category_id` / `products.sub_category_id`, and
 * `planCatalogs()` treats that list as the complete set and DELETES the rest.
 *
 * It was never only cosmetic. `worker/lib/printerIdentity.ts` decides whether
 * a product is a printer by reading the same empty table, so on the live
 * database NOTHING was a printer — and the PLUS printer gift, the PRO
 * maintenance discount, the referral free-delivery rule and the printer
 * delivery advance were all silently off, on a shop that sells printers. The
 * last group of tests here is that one, because it is the expensive half.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, asD1, ctx, freshDb, json, stubApp } from './fixtures/app';
import { homeRoutes, productRoutes } from '../worker/routes/products';
import {
  catalogSubtreeFilter,
  homeCategoryTree,
  withClassificationPlacements,
} from '../worker/lib/catalogMembership';
import { printerProductIds } from '../worker/lib/printerIdentity';

type Raw = ReturnType<typeof freshDb>;

/**
 * A product filed the way the ADMIN FORM files one: the classification
 * columns are written, `product_catalogs` is not. This is the exact shape the
 * live database is in, and every test below depends on it being faithful.
 */
function fileProduct(
  raw: Raw,
  id: string,
  name: string,
  category: string | null,
  sub: string | null
): void {
  raw.prepare(
    `INSERT INTO products (id, slug, name, description, price_iqd, status, category_id, sub_category_id)
     VALUES (?, ?, ?, '', 100000, 'active', ?, ?)`
  ).run(id, id, name, category, sub);
}

/** The routes under test, over the D1 shim the rest of the suite uses. */
const app = (raw: Raw) => {
  const db = asD1(raw);
  return stubApp(db as never, null, (a) => a.route('/api/home', homeRoutes).route('/api/products', productRoutes), {
    host: APEX,
    env: { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '' },
  });
};

const request = (a: ReturnType<typeof app>, path: string) =>
  a.request(path, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);

// =========================================================================
// THE REGRESSION
// =========================================================================

test('THE DEFECT: a product filed only in the classification columns still reaches the home page', async () => {
  const raw = freshDb();
  fileProduct(raw, 'p_x2d', 'Bambu Lab X2D', 'cat_printers', 'cat_printers_fdm');

  // The state the live database is actually in.
  const placements = raw.prepare('SELECT COUNT(*) AS n FROM product_catalogs').get() as { n: number };
  assert.equal(placements.n, 0, 'the fixture must reproduce the empty placement table');

  const res = await request(app(raw), '/api/home');
  const body = await json(res);
  const categories = body.categories as { id: string; product_count: number; children?: unknown[] }[];
  assert.ok(Array.isArray(categories), 'categories must be a list');
  assert.notDeepEqual(categories, [], 'this is the live payload the owner reported: []');
  assert.deepEqual(
    categories.map((c) => c.id),
    ['cat_printers'],
    'the one main section that holds something, and no empty ones'
  );
});

test('a MAIN section counts what is filed under its children — the roll-up', async () => {
  // Every product is classified under the LEAF. A root counted on its own rows
  // reads zero, gets filtered off the page, and the owner sees nothing — which
  // is the same bug one level up from the one above.
  const raw = freshDb();
  fileProduct(raw, 'p1', 'X2D', 'cat_printers', 'cat_printers_fdm');
  fileProduct(raw, 'p2', 'A1', 'cat_printers', 'cat_printers_fdm');
  fileProduct(raw, 'p3', 'Saturn', 'cat_printers', 'cat_printers_resin');

  const tree = await homeCategoryTree(asD1(raw));
  const printers = tree.find((c) => c.id === 'cat_printers');
  assert.ok(printers, 'Printers must be on the page');
  assert.equal(printers!.product_count, 3, 'all three, though none is filed AT this level');
  assert.deepEqual(
    printers!.children!.map((c) => [c.id, c.product_count]),
    [
      ['cat_printers_fdm', 2],
      ['cat_printers_resin', 1],
    ],
    'and the sub-sections that hold products, with their own counts'
  );
});

test('«الأقسام الفرعية التي فيها المنتجات» — an EMPTY sub-section is not offered', async () => {
  const raw = freshDb();
  fileProduct(raw, 'p1', 'X2D', 'cat_printers', 'cat_printers_fdm');
  const tree = await homeCategoryTree(asD1(raw));
  const printers = tree.find((c) => c.id === 'cat_printers')!;
  const ids = printers.children!.map((c) => c.id);
  assert.ok(ids.includes('cat_printers_fdm'));
  assert.ok(
    !ids.includes('cat_printers_resin'),
    'a sub-section card that opens onto an empty grid is a dead end'
  );
  assert.equal(
    tree.some((c) => c.id === 'cat_materials'),
    false,
    'and a main section with nothing anywhere below it never arrives at all'
  );
});

test('a DRAFT product fills no shelf', async () => {
  const raw = freshDb();
  fileProduct(raw, 'p1', 'X2D', 'cat_printers', 'cat_printers_fdm');
  raw.prepare("UPDATE products SET status = 'draft' WHERE id = 'p1'").run();
  assert.deepEqual(await homeCategoryTree(asD1(raw)), []);
});

test('a BUNDLE row does not inflate a category count', async () => {
  // A composition row is not an ordinary catalogue product — /api/products
  // excludes it from the default listing — so counting it would promise a
  // shelf one item longer than the grid behind it.
  const raw = freshDb();
  fileProduct(raw, 'p1', 'X2D', 'cat_printers', 'cat_printers_fdm');
  fileProduct(raw, 'b1', 'Starter bundle', 'cat_printers', 'cat_printers_fdm');
  raw.prepare("UPDATE products SET composition = 'bundle' WHERE id = 'b1'").run();
  const tree = await homeCategoryTree(asD1(raw));
  assert.equal(tree.find((c) => c.id === 'cat_printers')!.product_count, 1);
});

// =========================================================================
// TAPPING THE CHIP HAS TO SHOW THE PRODUCTS
// =========================================================================

test('the grid behind a MAIN section lists everything below it', async () => {
  // Counting right and listing nothing is a worse bug than both being wrong:
  // the chip is then a promise the next screen breaks.
  const raw = freshDb();
  fileProduct(raw, 'p1', 'X2D', 'cat_printers', 'cat_printers_fdm');
  fileProduct(raw, 'p2', 'Saturn', 'cat_printers', 'cat_printers_resin');
  fileProduct(raw, 'p3', 'PLA', 'cat_materials', 'cat_materials_fdm');

  const a = app(raw);
  const parent = await json(await request(a, '/api/products?category=cat_printers'));
  assert.deepEqual(
    (parent.products as { id: string }[]).map((p) => p.id).sort(),
    ['p1', 'p2'],
    'a main section lists its descendants, not only rows filed at its own level'
  );

  const leaf = await json(await request(a, '/api/products?category=cat_printers_fdm'));
  assert.deepEqual((leaf.products as { id: string }[]).map((p) => p.id), ['p1'], 'and a leaf lists its own');
});

test('the legacy free-text subcategory_id still matches — old rows keep working', async () => {
  const raw = freshDb();
  raw.prepare(
    `INSERT INTO products (id, slug, name, description, price_iqd, status, subcategory_id)
     VALUES ('old', 'old', 'Old row', '', 1000, 'active', 'legacy-token')`
  ).run();
  const got = await json(await request(app(raw), '/api/products?category=legacy-token'));
  assert.deepEqual((got.products as { id: string }[]).map((p) => p.id), ['old']);
});

// =========================================================================
// THE WRITE SIDE — A SAVE MUST NOT UNSHELVE THE PRODUCT IT IS SAVING
// =========================================================================

test('withClassificationPlacements folds the section picks into an empty catalog_ids', () => {
  assert.deepEqual(
    withClassificationPlacements([], { category_id: 'cat_printers', sub_category_id: 'cat_printers_fdm' }),
    ['cat_printers', 'cat_printers_fdm'],
    'this is the exact body the admin form posts — it used to delete every placement'
  );
});

test('it keeps explicit placements, adds no duplicates, and ignores absent picks', () => {
  assert.deepEqual(
    withClassificationPlacements(['cat_accessories', 'cat_printers'], {
      category_id: 'cat_printers',
      sub_category_id: null,
    }),
    ['cat_accessories', 'cat_printers'],
    'a merchandising placement survives, and the main section is not added twice'
  );
  assert.deepEqual(withClassificationPlacements(['a'], {}), ['a']);
  assert.deepEqual(withClassificationPlacements([], { category_id: '  ' }), [], 'blank is not an id');
});

// =========================================================================
// THE EXPENSIVE HALF: WHAT "IS THIS A PRINTER" READS
// =========================================================================

test('THE MONEY BUG: the backfill is what makes a printer a printer again', async () => {
  /**
   * `printerProductIds` reads `product_catalogs` and nothing else. With the
   * table empty — which is the live state — it answers "no printers", and the
   * PLUS printer gift, the PRO maintenance discount, the referral
   * free-delivery rule and the 50,000 IQD printer delivery advance all
   * silently stop applying. Migration 0088 is what repairs the existing rows;
   * this test is the proof that the repair reaches THAT reader, not only the
   * home page's own count.
   */
  const raw = freshDb();
  fileProduct(raw, 'p_x2d', 'Bambu Lab X2D', 'cat_printers', 'cat_printers_fdm');

  const before = await printerProductIds(asD1(raw), ['p_x2d']);
  assert.equal(before.has('p_x2d'), false, 'the state the live database is in');

  // Exactly what migration 0088 does for the sub section.
  raw.prepare(
    `INSERT INTO product_catalogs (product_id, catalog_id, position)
     SELECT p.id, p.sub_category_id,
            (SELECT COALESCE(MAX(x.position), 0) FROM product_catalogs x WHERE x.catalog_id = p.sub_category_id) + 1
       FROM products p
      WHERE p.sub_category_id IS NOT NULL AND p.sub_category_id <> ''
        AND EXISTS (SELECT 1 FROM catalogs c WHERE c.id = p.sub_category_id)
        AND NOT EXISTS (SELECT 1 FROM product_catalogs pc
                         WHERE pc.product_id = p.id AND pc.catalog_id = p.sub_category_id)`
  ).run();

  const printerCatalogs = raw
    .prepare('SELECT COUNT(*) AS n FROM catalogs WHERE is_printer_catalog = 1')
    .get() as { n: number };
  assert.ok(printerCatalogs.n > 0, 'the seed must still mark some catalog as a printer catalog');

  const after = await printerProductIds(asD1(raw), ['p_x2d']);
  assert.equal(after.has('p_x2d'), true, 'a printer is a printer again');
});

// =========================================================================
// THE SHAPE OF THE FILTER ITSELF
// =========================================================================

test('catalogSubtreeFilter binds its own parameters, in order', () => {
  const f = catalogSubtreeFilter('cat_printers');
  assert.equal(f.params.length, (f.sql.match(/\?/g) ?? []).length, 'one binding per placeholder');
  assert.deepEqual(f.params, ['cat_printers', 'cat_printers']);
  assert.ok(!/\?\d/.test(f.sql), 'no numbered placeholders — callers concatenate this beside plain ones');
});
