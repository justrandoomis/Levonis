/**
 * A BIG SECTION'S PAGE — every product read, up to CATEGORY_PAGE_CAP (the owner's live check of
 * 2026-11-11; docs/DECISIONS.md row 311).
 *
 * Live, three sections of the Bambu import hold more than 200 products (maintenance parts 589, spare parts
 * 568, makers' supply 358). Their page read only the first 200 in the shop's order and built everything from
 * them: a child whose products came later had no shelf, every count read null — so no row said «متوفر الآن»
 * or «بطلب مسبق» (row 309) — and «Bambu Lab» counted 200 of 571. The page now reads every product of its
 * section up to a thousand, in the same one statement, without the long text no card carries — from the
 * first build of an isolate on. A listing page gets its rows' counts from `/:slug/counts`: the same numbers,
 * the same for every viewer and cached for all, never a per-viewer build of the whole section.
 *
 * Run: node --import tsx --test tests/bigCategoryPage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, json, stubApp, type Mount } from './fixtures/app';
import { wavesD1 } from './fixtures/wavesD1';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { CATEGORY_PAGE_CAP, catalogRoutes } from '../worker/routes/catalog';
import { cardRowColumns, pricingCtxForUser, resolveProductCards } from '../worker/routes/products';
import { listing } from '../worker/lib/listing';
import { nounKindFor, sectionStockLabel } from '../src/lib/catalog/copy';
import type { CategoryPayload, SectionCountsPayload } from '../src/lib/catalog/types';

const BAMBU = 'brd_1c0917856cc94e2bbd31';
const mount: Mount = (a) => a.route('/api/catalog', catalogRoutes);
const MEMBER = { id: 'u1', role: 'customer' as const, email: 'u@x.co' };

/**
 * «makers-supply» with `kits` priced model kits that sell direct and on pre-order, none in stock, AHEAD of its
 * two in-stock Levo products in the shop's order — so past 200 kits the old page never read the Levo products
 * of «new-products» and «maker-tools».
 */
function seed(kits: number): DatabaseSync {
  const raw = freshDb();
  seedLiveCatalog(raw);
  raw.exec(`UPDATE products SET display_order = 5000 WHERE category_id = 'cat_makers'`);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('${MEMBER.id}','U','${MEMBER.email}','h','customer')`);
  const ins = raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, description, description_ar, price_iqd, prime_price_iqd, pro_price_iqd, status,
                           stock, selling_type, sale_types, category_id, sub_category_id, brand_id, display_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 50000, 48000, 46000, 'active', 0, 'direct_sale', '["direct_sale","pre_order"]',
             'cat_makers', 'cat_makers_kits', ?, ?, '2026-10-01T00:00:00.000Z')`
  );
  for (let i = 0; i < kits; i++) ins.run(`kit_${i}`, `kit-${i}`, `Kit ${i}`, `مجسم ${i}`, `A long description ${i}`, `وصف طويل ${i}`, BAMBU, i);
  return raw;
}

function world(kits: number, opts: { publishV2?: false; member?: boolean } = {}) {
  const db = asD1(seed(kits));
  const app = stubApp(db, opts.member ? MEMBER : null, mount, opts.publishV2 === false ? { publishV2: false } : undefined);
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

/** Every statement the routes prepare on `db`, in order. */
function spy(db: D1Database): string[] {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  (db as { prepare: (sql: string) => ReturnType<typeof prepare> }).prepare = (sql: string) => {
    seen.push(sql);
    return prepare(sql);
  };
  return seen;
}
const isRowRead = (s: string) => s.includes('ORDER BY sellable_now DESC, display_order ASC, created_at DESC');

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

test('the first build already reads its rows without the long text, and the long text moves no card', async () => {
  const { db, app } = world(230);
  const seen = spy(db);
  const first = await page(app);
  assert.equal(seen.filter((s) => s.trim() === 'SELECT * FROM products LIMIT 1').length, 1, 'one one-row read teaches the binding its columns');
  const rowRead = seen.find(isRowRead);
  assert.ok(rowRead, seen.join('\n'));
  assert.ok(rowRead.includes('products."price_iqd"') && rowRead.includes('products."spec_fields"'), rowRead);
  for (const long of ['description', 'description_ar', 'how_to_use', 'content_blocks', 'specifications']) {
    assert.ok(!rowRead.includes(`products."${long}"`), `${long} is read: ${rowRead}`);
  }
  assert.ok(!/SELECT \*/.test(rowRead), rowRead);
  seen.length = 0;
  const second = await page(app);
  assert.equal(seen.filter((s) => s.trim() === 'SELECT * FROM products LIMIT 1').length, 0, 'a binding that knows its columns asks no more');
  assert.deepEqual(second, first, 'the same answer, every card included');

  // The rows read whole make the very same cards (the listing's own rule, tests/listingPaging.test.ts).
  const L = await listing(db);
  const read = async (cols: string) =>
    (
      await db
        .prepare(`SELECT ${cols}, ${L.sellableFlag('products')} AS sellable_now FROM products WHERE category_id = 'cat_makers' ORDER BY id`)
        .all<Record<string, unknown>>()
    ).results ?? [];
  const ctx = await pricingCtxForUser(db, null);
  const narrow = await resolveProductCards(db, await read(cardRowColumns(db)!), ctx, null, 'flag');
  const whole = await resolveProductCards(db, await read('*'), ctx, null, 'flag');
  assert.equal(narrow.size, 232);
  assert.deepEqual(narrow, whole);
});

test('the counts: the section and every visible descendant, the page’s own numbers, the same for every viewer and cached for all', async () => {
  const { app } = world(230);
  const res = await app.request('/api/catalog/makers-supply/counts');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60', 'no price in it: one copy for everyone');
  assert.doesNotMatch(res.headers.get('vary') ?? '', /cookie/i);
  const b = (await json(res)) as SectionCountsPayload;
  assert.equal(b.id, 'cat_makers');
  assert.equal(b.truncated, false);
  assert.equal(b.counts[0].id, 'cat_makers', 'the section first');
  assert.ok(JSON.stringify(b).length < 2_000, `a few numbers, no card: ${JSON.stringify(b).length} bytes`);
  const by = new Map(b.counts.map((x) => [x.id, x]));
  assert.deepEqual(counts(by.get('cat_makers')!), [232, 2, 230, 0, 0]);
  assert.deepEqual(counts(by.get('cat_makers_kits')!), [230, 0, 230, 0, 0]);
  assert.deepEqual(counts(by.get('cat_makers_new')!), [1, 1, 0, 0, 0]);
  const p = await page(app);
  for (const n of [p.node, ...p.children]) assert.deepEqual(counts(by.get(n.id)!), counts(n), n.slug);

  // A signed-in viewer: the very same answer, still public — not a build at their prices.
  const signedIn = world(230, { member: true });
  const mine = await signedIn.app.request('/api/catalog/makers-supply/counts');
  assert.equal(mine.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual(await json(mine), b);
  assert.equal((await signedIn.app.request('/api/catalog/makers-supply')).headers.get('cache-control'), 'private, no-store', 'the page itself stays per viewer');

  // By id (a slug too long to ask by), and a section that is not there.
  assert.equal(((await json(await app.request('/api/catalog/cat_makers/counts'))) as SectionCountsPayload).id, 'cat_makers');
  const missing = await app.request('/api/catalog/no-such-section/counts');
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).code, 'CATALOG_NOT_FOUND');
});

test('the page and its counts send the same statements at 32 products and at 602, in a bounded number of waves', async () => {
  const measure = async (kits: number, path: string) => {
    const { waves, db } = wavesD1(seed(kits), 0);
    const app = stubApp(db, null, mount, { publishV2: false });
    assert.equal((await app.request(path)).status, 200, path); // the isolate is warm (the columns are known)
    waves.reset();
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    return { ...waves.counts };
  };
  for (const [path, ceiling] of [
    ['/api/catalog/makers-supply', 4],
    ['/api/catalog/makers-supply/counts', 3],
  ] as const) {
    const small = await measure(30, path);
    const big = await measure(600, path);
    assert.equal(big.executions, small.executions, `${path}: ${small.executions} statements at 32 products, ${big.executions} at 602\n${big.sqls.join('\n')}`);
    assert.ok(big.waves <= ceiling, `${path}: ${big.waves} waves > ${ceiling}\n${big.sqls.join('\n')}`);
  }
});

test('past CATEGORY_PAGE_CAP the page reads the first this-many and says so: its stock counts are unknown, never estimated', async () => {
  const { app } = world(CATEGORY_PAGE_CAP + 10, { publishV2: false });
  const b = await page(app);
  assert.equal(b.truncated, true);
  assert.equal(b.node.product_count, CATEGORY_PAGE_CAP + 12);
  assert.deepEqual(counts(b.node).slice(1), [null, null, null, null]);
  for (const c of b.children) assert.deepEqual(counts(c).slice(1), [null, null, null, null], c.slug);
  // The shelves and the brands describe what was read (DECISIONS row 311 says so; no live section is near it).
  assert.deepEqual(
    b.brands.map((x) => [x.slug, x.count]),
    [['bambu-lab', CATEGORY_PAGE_CAP]],
    'the brands of the products read: the first thousand, all kits'
  );
  const c = (await json(await app.request('/api/catalog/makers-supply/counts'))) as SectionCountsPayload;
  assert.equal(c.truncated, true);
  for (const n of c.counts) assert.deepEqual(counts(n).slice(1), [null, null, null, null], n.id);
});
