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
 * The second review's fixes: the one-row read that teaches the columns is never fatal (whole rows instead);
 * the page and its counts are kept once per section, whatever spelling of its slug was asked; and the import's
 * purge drops the counts with the page.
 *
 * The third review's coverage: the counts reach every visible descendant at any depth and nothing hidden, held
 * or inactive; a member's tier read rides in the first wave and the counts read none; a failed read keeps
 * nothing; an Arabic slug keeps one copy and is purged; and the page and its counts answer on a database the
 * deploy runs ahead of.
 *
 * Run: node --import tsx --test tests/bigCategoryPage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, hasColumn, json, stubApp, type Mount } from './fixtures/app';
import { wavesD1 } from './fixtures/wavesD1';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { DEEP, seedDeepSections } from './fixtures/deepSections';
import { CATEGORY_PAGE_CAP, LISTING_SLUG_MAX, catalogRoutes, sectionCachePath } from '../worker/routes/catalog';
import { cardRowColumns, pricingCtxForUser, resolveProductCards } from '../worker/routes/products';
import { slugify } from '../worker/routes/adminTaxonomy';
import { listing } from '../worker/lib/listing';
import { purgeImported, purgePlan } from '../worker/lib/catalogImport/purge';
import { PURGE_MARKER_CACHE } from '../worker/lib/edgePolicy';
import { withCacheEpoch } from '../worker/lib/publicApi/cache';
import { nounKindFor, sectionStockLabel } from '../src/lib/catalog/copy';
import type { CatalogTreeNode, CategoryPayload, SectionCountsPayload } from '../src/lib/catalog/types';

const BAMBU = 'brd_1c0917856cc94e2bbd31';
const mount: Mount = (a) => a.route('/api/catalog', catalogRoutes);
const MEMBER = { id: 'u1', role: 'customer' as const, email: 'u@x.co' };

/**
 * «makers-supply» with `kits` priced model kits that sell direct and on pre-order, none in stock, AHEAD of its
 * two in-stock Levo products in the shop's order — so past 200 kits the old page never read the Levo products
 * of «new-products» and «maker-tools». On `raw`, an older database (`dbThrough`), when one is given.
 */
function seed(kits: number, raw: DatabaseSync = freshDb()): DatabaseSync {
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

/**
 * AT ANY DEPTH (the third review). A listing page remembers every node of its section's counts, and opening a
 * section from there asks nothing again only if its own rows came with them — so the counts walk the whole
 * subtree the page draws, not its first level (tests/categoryListingStock.test.ts proves the page's side).
 */
test('the counts reach every visible descendant at any depth — a grandchild, a leaf lifted from under an inactive section — and nothing hidden, held or inactive', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedDeepSections(raw);
  const app = stubApp(asD1(raw), null, mount);
  const c = (await json(await app.request('/api/catalog/makers-supply/counts'))) as SectionCountsPayload;
  const p = (await json(await app.request('/api/catalog/makers-supply'))) as CategoryPayload;
  const flat = (n: CatalogTreeNode): CatalogTreeNode[] => [n, ...n.children.flatMap(flat)];
  const nodes = flat(p.node);
  assert.deepEqual(
    c.counts.map((x) => x.id),
    nodes.map((n) => n.id),
    'every node of the page, at every depth, in its order'
  );
  assert.deepEqual(nodes.map((n) => n.id), ['cat_makers', 'cat_makers_new', 'cat_makers_tools', DEEP.hand, DEEP.saws, DEEP.leaf]);
  for (const n of nodes) assert.deepEqual(counts(c.counts.find((x) => x.id === n.id)!), counts(n), n.slug);
  assert.ok(!c.counts.some((x) => x.id === DEEP.mid), 'an inactive section is never a node: its leaf is lifted');
  const by = new Map(c.counts.map((x) => [x.id, x]));
  assert.deepEqual(counts(by.get(DEEP.saws)!), [1, 1, 0, 0, 0], 'the draft, the hidden and the held product are not counted');
  assert.deepEqual(counts(by.get(DEEP.leaf)!), [1, 0, 1, 0, 0], 'under the inactive section: one pre-order');
  assert.deepEqual(counts(by.get('cat_makers')!), [4, 3, 1, 0, 0]);
  // A descendant's own counts are these very numbers: what a listing page remembers for it is what it would ask.
  const tools = (await json(await app.request('/api/catalog/maker-tools/counts'))) as SectionCountsPayload;
  assert.deepEqual(
    tools.counts,
    c.counts.filter((x) => ['cat_makers_tools', DEEP.hand, DEEP.saws].includes(x.id))
  );
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

/**
 * A MEMBER'S PAGE WAITS FOR NO TIER (the third review). The shared pricing inputs are kept in memory, so only a
 * signed-in viewer's own tier read — never memoised — shows where the pricing inputs are asked for: beside the
 * catalogs, in the first wave, not after the row read. The counts are built at the guest's prices: no tier.
 */
test('a member’s page asks its tier in the first wave — no wave more than a guest’s — and a member’s counts read no tier at all', async () => {
  const measure = async (member: boolean, path: string) => {
    const { waves, db } = wavesD1(seed(30), 0);
    const app = stubApp(db, member ? MEMBER : null, mount, { publishV2: false });
    assert.equal((await app.request(path)).status, 200, path); // warm: the columns known, the shared inputs in memory
    waves.reset();
    assert.equal((await app.request(path)).status, 200, path);
    return { ...waves.counts };
  };
  const tierReads = (sqls: string[]) => sqls.filter((s) => s.includes('FROM memberships WHERE user_id')).length;
  const guest = await measure(false, '/api/catalog/makers-supply');
  const member = await measure(true, '/api/catalog/makers-supply');
  assert.equal(tierReads(guest.sqls), 0);
  assert.equal(tierReads(member.sqls), 1, 'the member’s tier is read');
  assert.equal(member.waves, guest.waves, `a member: ${member.waves} waves, a guest: ${guest.waves}\n${member.sqls.join('\n')}`);
  const memberCounts = await measure(true, '/api/catalog/makers-supply/counts');
  assert.equal(tierReads(memberCounts.sqls), 0, 'the counts never read the viewer’s tier');
  assert.deepEqual(memberCounts.sqls, (await measure(false, '/api/catalog/makers-supply/counts')).sqls, 'the very statements a guest’s counts send');
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

// ------------------------------------------------------------- the second review

/** The one-row column read on `db` fails: its promise rejects (as a D1 error does), or `prepare` itself throws. */
function failFirstRow(db: D1Database, how: 'reject' | 'throw'): void {
  const prepare = db.prepare.bind(db);
  (db as { prepare: (sql: string) => ReturnType<typeof prepare> }).prepare = (sql: string) => {
    if (sql.trim() !== 'SELECT * FROM products LIMIT 1') return prepare(sql);
    if (how === 'throw') throw new Error('D1_ERROR: simulated failure to prepare');
    const fail = () => Promise.reject(new Error('D1_ERROR: simulated read failure'));
    return { bind: () => ({ all: fail, first: fail, run: fail, raw: fail }), all: fail, first: fail, run: fail, raw: fail } as unknown as ReturnType<typeof prepare>;
  };
}

test('the one-row read that teaches the columns is never fatal: without it the page and its counts read whole rows and answer the same', async () => {
  const unhandled: unknown[] = [];
  const note = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', note);
  try {
    for (const how of ['reject', 'throw'] as const) {
      for (const path of ['/api/catalog/makers-supply', '/api/catalog/makers-supply/counts']) {
        const { db, app } = world(30);
        failFirstRow(db, how);
        const seen = spy(db);
        const first = await app.request(path);
        assert.equal(first.status, 200, `${how} ${path}: ${await first.clone().text()}`);
        const body = await json(first);
        assert.deepEqual(counts(path.endsWith('/counts') ? body.counts[0] : body.node), [32, 2, 30, 0, 0], `${how} ${path}`);
        if (!path.endsWith('/counts')) {
          assert.deepEqual(
            (body as CategoryPayload).shelves.filter((s) => s.kind === 'child').map((s) => [s.id, s.count]),
            [['child:cat_makers_new', 1], ['child:cat_makers_kits', 30], ['child:cat_makers_tools', 1]],
            `${how}: every child's shelf`
          );
        }
        assert.match(seen.find(isRowRead) ?? '', /^\s*SELECT \*, /, `${how} ${path}: the columns unknown, the rows are read whole (as before row 311)`);
        assert.ok(cardRowColumns(db), `${how} ${path}: and those rows taught the binding its columns`);
        seen.length = 0;
        const second = await app.request(path);
        assert.equal(seen.filter((s) => s.trim() === 'SELECT * FROM products LIMIT 1').length, 0, `${how} ${path}: not asked again`);
        assert.doesNotMatch(seen.find(isRowRead) ?? 'SELECT *', /SELECT \*/, `${how} ${path}: the next build leaves the long text out`);
        assert.deepEqual(await json(second), body, `${how} ${path}: the same answer either way`);
      }
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], 'no rejection left unobserved');
  } finally {
    process.off('unhandledRejection', note);
  }
});

/** A stand-in for one of the colo's caches (tests/edgeStaleWhileRevalidate.test.ts has one that also expires). */
function memoryCache() {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: Request) {
      return store.get(req.url)?.clone();
    },
    async put(req: Request, res: Response) {
      store.set(req.url, new Response(await res.arrayBuffer(), res));
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}

/** `caches.default` (the answers) and the purge markers' own cache, for the length of `run`. */
async function withCaches(run: (answers: ReturnType<typeof memoryCache>) => Promise<void>): Promise<void> {
  const scope = globalThis as { caches?: unknown };
  const answers = memoryCache();
  const markers = memoryCache();
  scope.caches = {
    default: answers,
    async open(name: string) {
      assert.equal(name, PURGE_MARKER_CACHE);
      return markers;
    },
  };
  try {
    await run(answers);
  } finally {
    delete scope.caches;
  }
}

const ORIGIN = 'https://levonis-iq.com';
/** «makers-supply»'s two in-stock products (tests/fixtures/liveCatalog.ts): the Levo switch and key ring. */
const LEVO = ['prd_0ce55586ba5e4751bc84', 'prd_94dedaeb082243efb43a'];
const sellOutLevo = (raw: DatabaseSync) =>
  raw.exec(
    `UPDATE products SET stock = 0, stock_reserved = 0 WHERE id IN ('${LEVO.join("','")}');
     UPDATE product_variants SET stock = 0 WHERE product_id IN ('${LEVO.join("','")}')`
  );
/** What the import's `/publish-finish` does after writing those two: the plan, then the purge on this origin. */
async function importPurge(db: D1Database) {
  const plan = await purgePlan(db, LEVO);
  await purgeImported({ STORE_ROOT_DOMAIN: 'levonis-iq.com' }, `${ORIGIN}/api/admin/catalog-import/publish-finish`, plan);
  // A copy read in the purge's own millisecond counts as read before it: step past it.
  await new Promise((r) => setTimeout(r, 5));
  return plan;
}
const availableIn = async (res: Response) => {
  const b = await json(res);
  return (b.node ?? b.counts[0]).available_count as number | null;
};

test('one copy per section, whatever spelling of its slug was asked — and the import’s purge drops the page and its counts', async () => {
  await withCaches(async (answers) => {
    const raw = seed(3);
    const db = asD1(raw);
    const app = stubApp(db, null, mount);
    const ask = (p: string) => app.request(`${ORIGIN}${p}`);
    const spellings = {
      counts: ['/api/catalog/makers-supply/counts', '/api/catalog/%20makers-supply%20/counts', '/api/catalog/makers%2Dsupply/counts'],
      page: ['/api/catalog/makers-supply', '/api/catalog/%20makers-supply', '/api/catalog/makers%2Dsupply'],
    };
    for (const [first, ...others] of [spellings.counts, spellings.page]) {
      const built = await ask(first);
      assert.equal(built.status, 200, first);
      assert.equal(built.headers.get('age'), null, `${first}: built`);
      assert.equal(await availableIn(built), 2, first);
      for (const p of others) {
        const hit = await ask(p);
        assert.equal(hit.status, 200, p);
        assert.notEqual(hit.headers.get('age'), null, `${p}: served from the one copy`);
      }
    }
    assert.deepEqual(
      [...answers.store.keys()].sort(),
      [withCacheEpoch(`${ORIGIN}/api/catalog/makers-supply`), withCacheEpoch(`${ORIGIN}/api/catalog/makers-supply/counts`)].sort(),
      'one copy per answer, not one per spelling'
    );

    sellOutLevo(raw);
    assert.equal(await availableIn(await ask(spellings.counts[2])), 2, 'until the purge, the copy answers');
    const plan = await importPurge(db);
    for (const s of ['makers-supply', 'new-products', 'maker-tools']) {
      assert.ok(plan.paths.includes(`/api/catalog/${s}`), s);
      assert.ok(plan.paths.includes(`/api/catalog/${s}/counts`), `${s}: its counts beside its page`);
    }
    for (const p of [spellings.counts[1], spellings.page[2], spellings.counts[0], spellings.page[0]]) {
      const after = await ask(p);
      assert.equal(await availableIn(after), 0, `${p}: the import's stock`);
    }
    assert.equal(answers.store.size, 2, 'and still one copy each');
  });
});

test('a section whose slug is too long to ask by: its counts are kept under its id, as the listing asks them, and the purge names that spelling', async () => {
  await withCaches(async (answers) => {
    const raw = seed(3);
    const long = `makers-supply-${'a'.repeat(LISTING_SLUG_MAX)}`;
    raw.exec(`UPDATE catalogs SET slug = '${long}' WHERE id = 'cat_makers'`);
    const db = asD1(raw);
    const app = stubApp(db, null, mount);
    // src/lib/bootFetch.ts `listingCategory`: past LISTING_SLUG_MAX the storefront asks by id.
    const path = '/api/catalog/cat_makers/counts';
    const built = await app.request(`${ORIGIN}${path}`);
    assert.equal(await availableIn(built), 2);
    assert.ok(answers.store.has(withCacheEpoch(`${ORIGIN}${path}`)));

    sellOutLevo(raw);
    const plan = await importPurge(db);
    assert.ok(plan.paths.includes(path), 'the spelling the storefront asks by');
    assert.ok(plan.paths.includes(sectionCachePath(long, 'counts')) && plan.paths.includes(sectionCachePath(long, 'page')));
    assert.ok(!plan.sections.includes('cat_makers'), 'an id is not a section slug (the public v1 keys stay by slug)');
    const after = await app.request(`${ORIGIN}${path}`);
    assert.equal(after.headers.get('age'), null, 'rebuilt');
    assert.equal(await availableIn(after), 0);
  });
});

test('a slug no section can be asked by is refused before the cache: the map’s own path, «.», «..» and nothing', async () => {
  await withCaches(async (answers) => {
    const guest = world(0).app;
    assert.equal((await guest.request(`${ORIGIN}/api/catalog/tree`)).status, 200);
    assert.equal(answers.store.size, 1, 'the map, kept');
    const member = world(0, { member: true }).app;
    for (const p of ['/api/catalog/%20tree', '/api/catalog/tree%20', '/api/catalog/%20.', '/api/catalog/%20..', '/api/catalog/%20', '/api/catalog/%20./counts', '/api/catalog/%20../counts', '/api/catalog/%20/counts']) {
      for (const app of [guest, member]) {
        const res = await app.request(`${ORIGIN}${p}`);
        assert.equal(res.status, 404, `${p}: ${(await res.clone().text()).slice(0, 120)}`);
        assert.equal((await json(res)).code, 'CATALOG_NOT_FOUND', p);
      }
    }
    assert.equal(answers.store.size, 1, 'nothing kept for them, and the map never served as a section');

    // A section slugged «tree» still has its counts at a path of its own (`/api/catalog/tree/counts`).
    const raw = seed(0);
    raw.exec(`UPDATE catalogs SET slug = 'tree' WHERE id = 'cat_makers_new'`);
    const own = await stubApp(asD1(raw), null, mount).request(`${ORIGIN}/api/catalog/tree/counts`);
    assert.equal(own.status, 200);
    assert.equal(((await json(own)) as SectionCountsPayload).id, 'cat_makers_new');
  });
});

// -------------------------------------------------------------- the third review

/** Every statement on `db` that `match` names fails — its promise rejects, as a D1 error does — until `heal()`. */
function failWhere(db: D1Database, match: (sql: string) => boolean): () => void {
  let broken = true;
  const prepare = db.prepare.bind(db);
  (db as { prepare: (sql: string) => ReturnType<typeof prepare> }).prepare = (sql: string) => {
    if (!broken || !match(sql)) return prepare(sql);
    const fail = () => Promise.reject(new Error('D1_ERROR: simulated read failure'));
    return { bind: () => ({ all: fail, first: fail, run: fail, raw: fail }), all: fail, first: fail, run: fail, raw: fail } as unknown as ReturnType<typeof prepare>;
  };
  return () => {
    broken = false;
  };
}

test('a failed read keeps nothing: the counts and the page answer 500, no copy is stored, no rejection is left unobserved, and the next ask builds them whole', async () => {
  const unhandled: unknown[] = [];
  const note = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', note);
  try {
    await withCaches(async (answers) => {
      const reads: Array<[string, (sql: string) => boolean]> = [
        ['the sections', (s) => s.trim() === 'SELECT * FROM catalogs'],
        ['the memberships', (s) => s.includes('membership(product_id, catalog_id) AS')],
        ['the rows', isRowRead],
      ];
      for (const [what, match] of reads) {
        for (const path of ['/api/catalog/makers-supply/counts', '/api/catalog/makers-supply']) {
          answers.store.clear();
          const db = asD1(seed(3));
          const heal = failWhere(db, match);
          const app = stubApp(db, null, mount);
          const failed = await app.request(`${ORIGIN}${path}`);
          assert.equal(failed.status, 500, `${what}, ${path}`);
          assert.equal(answers.store.size, 0, `${what}, ${path}: nothing kept`);
          heal();
          const next = await app.request(`${ORIGIN}${path}`);
          assert.equal(next.status, 200, `${what}, ${path}: the next ask builds it`);
          assert.equal(next.headers.get('age'), null, `${what}, ${path}: built, not a kept failure`);
          assert.equal(await availableIn(next), 2);
          assert.equal(answers.store.size, 1, `${what}, ${path}: and keeps it`);
        }
      }
      // A member's tier read fails: their page, which prices with it, is a 500; a section that is not there is
      // still a 404 (it never waits for the tier); the counts never read it.
      const db = asD1(seed(3));
      failWhere(db, (s) => s.replace(/\s+/g, ' ').includes('FROM memberships WHERE user_id'));
      const member = stubApp(db, MEMBER, mount);
      assert.equal((await member.request(`${ORIGIN}/api/catalog/makers-supply`)).status, 500);
      assert.equal((await member.request(`${ORIGIN}/api/catalog/no-such-section`)).status, 404);
      assert.equal((await member.request(`${ORIGIN}/api/catalog/makers-supply/counts`)).status, 200);
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], 'no rejection left unobserved');
  } finally {
    process.off('unhandledRejection', note);
  }
});

test('an Arabic slug: one copy of its page and of its counts however its letters were escaped, and the import’s purge reaches both', async () => {
  await withCaches(async (answers) => {
    const raw = seed(3);
    const arabic = slugify('مستلزمات الصناع', 'x');
    assert.equal(arabic, 'مستلزمات-الصناع');
    raw.exec(`UPDATE catalogs SET slug = '${arabic}' WHERE id = 'cat_makers'`);
    const db = asD1(raw);
    const app = stubApp(db, null, mount);
    const ask = (p: string) => app.request(`${ORIGIN}${p}`);
    // As the storefront asks (src/lib/catalog/data.ts: upper-case escapes), in lower case, and padded.
    const asked = encodeURIComponent(arabic);
    const spellings = {
      counts: [`/api/catalog/${asked}/counts`, `/api/catalog/${asked.toLowerCase()}/counts`, `/api/catalog/%20${asked}/counts`],
      page: [`/api/catalog/${asked}`, `/api/catalog/${asked.toLowerCase()}`, `/api/catalog/${asked}%20`],
    };
    for (const [first, ...others] of [spellings.counts, spellings.page]) {
      const built = await ask(first);
      assert.equal(built.status, 200, first);
      assert.equal(built.headers.get('age'), null, `${first}: built`);
      assert.equal(await availableIn(built), 2, first);
      for (const p of others) {
        const hit = await ask(p);
        assert.equal(hit.status, 200, p);
        assert.notEqual(hit.headers.get('age'), null, `${p}: served from the one copy`);
      }
    }
    assert.deepEqual(
      [...answers.store.keys()].sort(),
      [withCacheEpoch(`${ORIGIN}/api/catalog/${asked}`), withCacheEpoch(`${ORIGIN}/api/catalog/${asked}/counts`)].sort(),
      'one copy per answer, under the spelling the storefront asks'
    );

    sellOutLevo(raw);
    const plan = await importPurge(db);
    assert.ok(plan.sections.includes(arabic));
    assert.ok(plan.paths.includes(`/api/catalog/${asked}`) && plan.paths.includes(`/api/catalog/${asked}/counts`), plan.paths.join('\n'));
    for (const p of [spellings.counts[1], spellings.page[2], spellings.counts[0], spellings.page[0]]) {
      assert.equal(await availableIn(await ask(p)), 0, `${p}: the import's stock`);
    }
    assert.equal(answers.store.size, 2, 'and still one copy each');
  });
});

/**
 * THE DEPLOY RUNS AHEAD (CLAUDE.md, «a migration and the code that needs it»): the columns the narrowed row read
 * names are LEARNED from the binding's own table, so a database without the newest `products` column
 * (0218's `price_estimate`), without V2 pricing (0189: nothing sellable, fail closed) or without the picture
 * sets and the catalogue hold (0149, 0184) still answers — the same numbers on the page and in its counts.
 */
test('on a database the deploy runs ahead of, the page and its counts answer: the narrowed read names only the columns there are', async () => {
  for (const through of ['0217', '0188', '0148']) {
    const raw = seed(30, dbThrough(through));
    assert.equal(hasColumn(raw, 'products', 'price_estimate'), false, `${through}: really behind`);
    const db = asD1(raw);
    const seen = spy(db);
    const app = stubApp(db, null, mount);
    const firstPage = await app.request('/api/catalog/makers-supply');
    assert.equal(firstPage.status, 200, `${through}: ${await firstPage.clone().text()}`);
    const p = (await json(firstPage)) as CategoryPayload;
    const c = (await json(await app.request('/api/catalog/makers-supply/counts'))) as SectionCountsPayload;
    assert.equal(c.success, true, through);
    const by = new Map(c.counts.map((x) => [x.id, x]));
    for (const n of [p.node, ...p.children]) assert.deepEqual(counts(by.get(n.id)!), counts(n), `${through}: ${n.slug}`);
    seen.length = 0;
    const again = await app.request('/api/catalog/makers-supply');
    const narrowed = seen.find(isRowRead) ?? '';
    assert.doesNotMatch(narrowed, /SELECT \*/, `${through}: the columns were learned`);
    assert.ok(!narrowed.includes('price_estimate'), `${through}: never a column the table lacks`);
    assert.deepEqual(await json(again), p, `${through}: the same answer from the narrowed read`);
  }
});
