/**
 * A BIG SECTION'S PAGE — every product read, up to CATEGORY_PAGE_CAP (the owner's live check of
 * 2026-11-11; docs/DECISIONS.md row 311).
 *
 * Live, three sections of the Bambu import hold more than 200 products (maintenance parts 589, spare parts
 * 568, makers' supply 358). Their page read only the first 200 in the shop's order and built everything from
 * them: a child whose products came later had no shelf, every count read null — so no row said «متوفر الآن»
 * or «بطلب مسبق» (row 309) — and «Bambu Lab» counted 200 of 571. The page now reads every product of its
 * section up to a thousand, in the same one statement, without the long text no card carries.
 *
 * Run: node --import tsx --test tests/bigCategoryPage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { CATEGORY_PAGE_CAP, catalogRoutes } from '../worker/routes/catalog';
import { nounKindFor, sectionStockLabel } from '../src/lib/catalog/copy';
import type { CategoryPayload } from '../src/lib/catalog/types';

const BAMBU = 'brd_1c0917856cc94e2bbd31';

/**
 * «makers-supply» with `kits` priced model kits that sell direct and on pre-order, none in stock, AHEAD of its
 * two in-stock Levo products in the shop's order — so past 200 kits the old page never read the Levo products
 * of «new-products» and «maker-tools».
 */
function world(kits: number, publishV2?: false) {
  const raw = freshDb();
  seedLiveCatalog(raw);
  raw.exec(`UPDATE products SET display_order = 5000 WHERE category_id = 'cat_makers'`);
  const ins = raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, description, description_ar, price_iqd, prime_price_iqd, pro_price_iqd, status,
                           stock, selling_type, sale_types, category_id, sub_category_id, brand_id, display_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 50000, 48000, 46000, 'active', 0, 'direct_sale', '["direct_sale","pre_order"]',
             'cat_makers', 'cat_makers_kits', ?, ?, '2026-10-01T00:00:00.000Z')`
  );
  for (let i = 0; i < kits; i++) ins.run(`kit_${i}`, `kit-${i}`, `Kit ${i}`, `مجسم ${i}`, `A long description ${i}`, `وصف طويل ${i}`, BAMBU, i);
  const db = asD1(raw);
  const app = stubApp(db, null, (a) => a.route('/api/catalog', catalogRoutes), publishV2 === false ? { publishV2: false } : undefined);
  return { db, app };
}

const page = async (app: ReturnType<typeof world>['app']): Promise<CategoryPayload> =>
  (await json(await app.request('/api/catalog/makers-supply'))) as CategoryPayload;

type Counted = {
  product_count: number;
  available_count: number | null;
  preorder_count?: number | null;
  unavailable_count?: number | null;
  withheld_count?: number | null;
};
const counts = (n: Counted) => [n.product_count, n.available_count, n.preorder_count ?? null, n.unavailable_count ?? null, n.withheld_count ?? null];

test('a section past 200 products: every child keeps its shelf and its exact counts, and the brands count every product', async () => {
  const { app } = world(230);
  const b = await page(app);
  assert.equal(b.truncated, false);
  assert.deepEqual(counts(b.node), [232, 2, 230, 0, 0]);
  const kids = new Map(b.children.map((c) => [c.slug, c]));
  assert.deepEqual(counts(kids.get('model-kits')!), [230, 0, 230, 0, 0]);
  assert.deepEqual(counts(kids.get('new-products')!), [1, 1, 0, 0, 0], 'the Levo switch, 30 products past where the old cap stopped');
  assert.deepEqual(counts(kids.get('maker-tools')!), [1, 1, 0, 0, 0]);
  assert.deepEqual(
    b.shelves.filter((s) => s.kind === 'child').map((s) => [s.id, s.count, s.products.length]),
    [
      ['child:cat_makers_new', 1, 1],
      ['child:cat_makers_kits', 230, 10],
      ['child:cat_makers_tools', 1, 1],
    ],
    'a shelf for every non-empty child, in the admin order'
  );
  assert.deepEqual(
    b.brands.map((x) => [x.slug, x.count]),
    [
      ['bambu-lab', 230],
      ['levo', 2],
    ]
  );
  // What the rows then say (row 309): each child its own word.
  const word = (slug: string) => {
    const n = kids.get(slug)!;
    return sectionStockLabel(n, nounKindFor(n.product_type, n.is_printer_catalog), 'ar');
  };
  assert.equal(word('model-kits'), 'بطلب مسبق');
  assert.equal(word('new-products'), 'متوفر الآن');
  assert.equal(word('maker-tools'), 'متوفر الآن');
});

test('the page reads its rows without the long text once their columns are known, and its answer does not change', async () => {
  const { db, app } = world(230);
  const first = await page(app); // whole rows: the binding learns the columns
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  (db as { prepare: (sql: string) => ReturnType<typeof prepare> }).prepare = (sql: string) => {
    seen.push(sql);
    return prepare(sql);
  };
  const second = await page(app);
  const rowRead = seen.find((s) => s.includes('ORDER BY sellable_now DESC, display_order ASC, created_at DESC'));
  assert.ok(rowRead, seen.join('\n'));
  assert.ok(rowRead.includes('products."price_iqd"') && rowRead.includes('products."spec_fields"'), rowRead);
  for (const long of ['description', 'description_ar', 'how_to_use', 'content_blocks', 'specifications']) {
    assert.ok(!rowRead.includes(`products."${long}"`), `${long} is not read: ${rowRead}`);
  }
  assert.ok(!/SELECT \*/.test(rowRead), rowRead);
  assert.deepEqual(second, first, 'the same answer, every card included');
});

test('past CATEGORY_PAGE_CAP the page reads the first this-many and says so: its counts are unknown, never estimated', async () => {
  const { app } = world(CATEGORY_PAGE_CAP + 10, false);
  const b = await page(app);
  assert.equal(b.truncated, true);
  assert.equal(b.node.product_count, CATEGORY_PAGE_CAP + 12);
  assert.deepEqual(counts(b.node).slice(1), [null, null, null, null]);
  for (const c of b.children) assert.deepEqual(counts(c).slice(1), [null, null, null, null], c.slug);
  assert.deepEqual(
    b.brands.map((x) => [x.slug, x.count]),
    [['bambu-lab', CATEGORY_PAGE_CAP]],
    'the brands of what was read: the first thousand, all kits'
  );
});
