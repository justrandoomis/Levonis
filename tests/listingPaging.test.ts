/**
 * THE LISTING PAGES TO THE END OF EVERY CANDIDATE (owner, 2026-10-19: «browse
 * ALL products»; `GET /api/products?brand=bambu-lab` stopped at 300 of ~1,100).
 *
 * A 1,200-product shop in the live shape — a few dozen sellable products and
 * a long catalog-only import (DECISIONS row 240) — paged 50 at a time to the
 * end in EVERY sort:
 *   - no product twice, none missing, `total` and `has_more` honest, and the
 *     order exactly the listing's rule (newest, name, price, relevance R1/R3…);
 *   - page 1 asked with the facet counts lists what the same page without them
 *     lists (the client's first page carries `facets=1`, its «عرض المزيد» not);
 *   - `page=N` is `offset=(N-1)·limit`, and both are edge-cache keys;
 *   - past the candidate cap a resolved order is BOUNDED (only that many
 *     sellable candidates are priced) and HONEST (`truncated: true`, nothing
 *     hidden: the rest follow in the shelf order; a resolved filter cannot
 *     vouch for them);
 *   - the latency guard: the D1 statements and waves of a request do not grow
 *     with the catalogue (the 50-id chunked offer and pool reads were a wave
 *     each), and the row read leaves out the long text no card carries —
 *     with cards identical to the plain listing's;
 *   - a catalog-only candidate's keyed item is exactly what its card makes;
 *   - the head priced to order is the same with or without the counts — a
 *     brand or a printer walked as the client walks it (page 1 with
 *     `facets=1`, «عرض المزيد» without) past the cap skips and repeats nothing;
 *   - «عرض المزيد» pages from the SERVER'S cursor: products entering the order
 *     ahead of the shopper never pull later pages back nor end the list early;
 *   - the answer says WHICH part was not exact (`partial_order`,
 *     `partial_counts`, `cut_off`), and the note the client shows follows it;
 *   - the name order compares with one shared collator and sorts once.
 *
 * Run: node --import tsx --test tests/listingPaging.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, stubApp, type Mount } from './fixtures/app';
import { publishV2 } from './fixtures/v2Publish';
import { wavesD1 } from './fixtures/wavesD1';
import {
  LISTING_CACHE_PARAMS,
  keyedListingItem,
  listCatalogProducts,
  listingItemOf,
  pricingCtxForUser,
  productRoutes,
  resolveProductCards,
  type ListingKeyRow,
} from '../worker/routes/products';
import { LISTING_SORTS, type ListingSort } from '../packages/catalog/src/discovery';
import { NAME_COLLATOR, filtersReadResolved, sortItems, storedKeyFilters } from '../worker/lib/listingFacets';
import {
  cursorOf,
  fetchNextPages,
  firstPageSnapshot,
  listingNotes,
  priceOrStockFilterOn,
  remainingOf,
  withNextPage,
  type ListingSnapshot,
} from '../src/lib/catalog/listingSnapshot';
import { emptyListing } from '../src/lib/catalog/listingQuery';
import type { ProductsListResponse } from '../src/lib/api';
import type { ListingState } from '../src/lib/catalog/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Card = Record<string, any>;
type Product = {
  id: string;
  name: string;
  price: number;
  priced: boolean;
  stock: number;
  direct: boolean;
  brand: string;
  displayOrder: number;
  createdAt: string;
  enclosed: '1' | '0' | null;
};

const BRANDS = [
  { id: 'lb_one', slug: 'brand-one' },
  { id: 'lb_two', slug: 'brand-two' },
  { id: 'lb_three', slug: 'brand-three' },
];
const NAMES = ['Alpha', 'beta', 'Gamma', 'delta', 'Épsilon'];

/** `n` products, every 25th one priced (sellable once published), the rest catalog-only. */
function catalogue(n: number): Product[] {
  return Array.from({ length: n }, (_, i) => {
    const priced = i % 25 === 0;
    return {
      id: `lp_${String(i).padStart(4, '0')}`,
      // Ties and numbers on purpose: «Alpha 2» before «Alpha 10», «beta» beside «Beta».
      name: `${NAMES[i % NAMES.length]} ${i % 97}`,
      // Equal prices on purpose (12 steps): ties keep the shelf order.
      price: priced ? 100_000 + ((i / 25) % 12) * 25_000 : 0,
      priced,
      stock: priced && (i / 25) % 3 !== 0 ? 5 + (i % 4) : 0,
      // A pre-order-only product needs its routes to be priced; every one here sells direct.
      direct: true,
      brand: BRANDS[i % 3].id,
      displayOrder: i % 7,
      // Three products share each minute: equal dates keep the shelf order.
      createdAt: new Date(Date.UTC(2026, 0, 1) + (i % 400) * 60_000).toISOString(),
      enclosed: i % 5 === 0 ? '1' : i % 5 === 1 ? '0' : null,
    };
  });
}

async function seed(raw: DatabaseSync, products: Product[]): Promise<void> {
  const brand = raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)');
  for (const b of BRANDS) brand.run(b.id, b.slug, `ماركة ${b.slug}`, b.slug);
  const ins = raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, name_ku, description, description_ar, description_ku, how_to_use, features,
                           status, price_iqd, stock, selling_type, sale_types, brand_id, spec_fields, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const p of products) {
    const long = p.id.endsWith('0') ? `A long description of ${p.name}. `.repeat(20) : '';
    ins.run(
      p.id, p.id.replace('_', '-'), p.name, `منتج ${p.name}`, `بەرهەمی ${p.name}`, long, long, long, long ? 'Use it well.' : '',
      long ? '["fast","quiet"]' : '[]',
      p.price, p.stock,
      p.direct ? 'direct_sale' : 'pre_order', JSON.stringify(p.direct ? ['direct_sale'] : ['pre_order']),
      p.brand,
      JSON.stringify(p.enclosed === null ? {} : { enclosed: p.enclosed === '1' ? 'yes' : 'no' }),
      p.displayOrder, p.createdAt, p.createdAt
    );
  }
  for (const p of products) if (p.priced) await publishV2(raw, p.id);
}

const mount: Mount = (a) => a.route('/api/products', productRoutes);

interface World {
  raw: DatabaseSync;
  products: Product[];
  app: ReturnType<typeof stubApp>;
}
let shared: Promise<World> | null = null;
const world = (): Promise<World> =>
  (shared ??= (async () => {
    const raw = freshDb();
    const products = catalogue(1200);
    await seed(raw, products);
    return { raw, products, app: stubApp(asD1(raw), null, mount, { publishV2: false }) };
  })());

/** R1's shelf order: sellable first, then display order, newest, id. */
function shelf(products: Product[]): Product[] {
  return [...products].sort(
    (a, b) =>
      Number(b.priced) - Number(a.priced) ||
      a.displayOrder - b.displayOrder ||
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
      (a.id < b.id ? -1 : 1)
  );
}

/** The listing's rule for each order, over the fixture's own facts. */
function expectedOrder(products: Product[], sort: ListingSort): string[] {
  const ranked = shelf(products);
  const rank = new Map(ranked.map((p, i) => [p.id, i]));
  const byRank = (a: Product, b: Product) => rank.get(a.id)! - rank.get(b.id)!;
  const available = (p: Product) => (p.priced && p.direct ? p.stock : 0);
  const cmp: Record<ListingSort, (a: Product, b: Product) => number> = {
    relevance: (a, b) => Number(b.priced) - Number(a.priced) || Number(available(b) > 0) - Number(available(a) > 0) || byRank(a, b),
    newest: (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : byRank(a, b)),
    price_asc: (a, b) => (a.priced && b.priced ? a.price - b.price || byRank(a, b) : Number(b.priced) - Number(a.priced) || byRank(a, b)),
    price_desc: (a, b) => (a.priced && b.priced ? b.price - a.price || byRank(a, b) : Number(b.priced) - Number(a.priced) || byRank(a, b)),
    name: (a, b) => NAME_COLLATOR.compare(a.name, b.name) || byRank(a, b),
    available: (a, b) =>
      Number(b.priced) - Number(a.priced) ||
      Number(available(b) > 0) - Number(available(a) > 0) ||
      available(b) - available(a) ||
      byRank(a, b),
    direct: (a, b) =>
      Number(b.priced) - Number(a.priced) ||
      Number(b.priced && b.direct) - Number(a.priced && a.direct) ||
      Number(available(b) > 0) - Number(available(a) > 0) ||
      byRank(a, b),
  };
  return ranked.sort(cmp[sort]).map((p) => p.id);
}

/** Every page of one listing, 50 at a time, with each page's envelope checked. */
async function walk(app: World['app'], query: string, expectTotal: number): Promise<Card[]> {
  const out: Card[] = [];
  for (let offset = 0; offset < expectTotal + 50; offset += 50) {
    const b = await json(await get(app, `/api/products?${query}&limit=50&offset=${offset}`));
    assert.equal(b.total, expectTotal, `${query} @${offset}: total`);
    assert.equal(b.truncated, false, `${query} @${offset}: truncated`);
    assert.equal(b.has_more, offset + 50 < expectTotal, `${query} @${offset}: has_more`);
    out.push(...(b.products as Card[]));
    if (!b.has_more) break;
  }
  return out;
}

test('every sort pages to the end of 1,200 products: no product twice, none missing, the listing\'s own order', async () => {
  const w = await world();
  const all = w.products.map((p) => p.id).sort();
  for (const sort of LISTING_SORTS) {
    const cards = await walk(w.app, `sort=${sort}`, 1200);
    const ids = cards.map((c) => String(c.id));
    assert.equal(new Set(ids).size, ids.length, `${sort}: a product listed twice`);
    assert.deepEqual([...ids].sort(), all, `${sort}: every product, once`);
    assert.deepEqual(ids, expectedOrder(w.products, sort), `${sort}: the listing's order`);
    // Each card says whether it is priced, and the sellable ones carry their price.
    for (const c of cards) assert.equal(c.price_status, w.products.find((p) => p.id === c.id)!.priced ? 'priced' : 'unpriced', `${sort}: ${c.id}`);
  }
});

test('page 1 with the facet counts lists what page 1 without them lists, in every sort (the client asks both)', async () => {
  const w = await world();
  for (const sort of LISTING_SORTS) {
    const withFacets = await json(await get(w.app, `/api/products?sort=${sort}&facets=1&limit=24`));
    const plain = await json(await get(w.app, `/api/products?sort=${sort}&limit=24`));
    assert.deepEqual(withFacets.products.map((c: Card) => c.id), plain.products.map((c: Card) => c.id), sort);
    assert.equal(withFacets.total, 1200);
    assert.equal(withFacets.facets.total, 1200, `${sort}: the counts cover every candidate`);
    assert.deepEqual(
      withFacets.facets.brands.map((b: Card) => [b.slug, b.count]).sort(),
      [['brand-one', 400], ['brand-three', 400], ['brand-two', 400]]
    );
  }
});

test('filters page to the end too — stored-key (brand, spec) and resolved (available now, price range)', async () => {
  const w = await world();
  const cases: Array<{ q: string; keep: (p: Product) => boolean; sort: ListingSort }> = [
    { q: 'brand=brand-two&sort=newest', keep: (p) => p.brand === 'lb_two', sort: 'newest' },
    { q: 'brand=brand-two&f.enclosed=1&sort=name', keep: (p) => p.brand === 'lb_two' && p.enclosed === '1', sort: 'name' },
    { q: 'brand=brand-three&sort=price_asc', keep: (p) => p.brand === 'lb_three', sort: 'price_asc' },
    { q: 'avail=1&sort=relevance', keep: (p) => p.priced && p.direct && p.stock > 0, sort: 'relevance' },
    { q: 'price=150000-&sort=price_desc', keep: (p) => p.priced && p.price >= 150_000, sort: 'price_desc' },
  ];
  for (const c of cases) {
    const want = w.products.filter(c.keep);
    const ids = (await walk(w.app, c.q, want.length)).map((x) => String(x.id));
    assert.deepEqual(ids, expectedOrder(want, c.sort), c.q);
  }
});

test('`page` is `offset` counted in pages, and both are edge-cache keys', async () => {
  const w = await world();
  const byPage = await json(await get(w.app, '/api/products?sort=newest&limit=24&page=3'));
  const byOffset = await json(await get(w.app, '/api/products?sort=newest&limit=24&offset=48'));
  assert.deepEqual(byPage.products.map((c: Card) => c.id), byOffset.products.map((c: Card) => c.id));
  assert.equal(byPage.products.length, 24);
  // An explicit offset wins over a page.
  const both = await json(await get(w.app, '/api/products?sort=newest&limit=24&page=3&offset=0'));
  assert.equal(both.products[0].id, expectedOrder(w.products, 'newest')[0]);
  for (const k of ['limit', 'offset', 'page', 'sort', 'brand', 'facets']) assert.ok(LISTING_CACHE_PARAMS.includes(k), `${k} keys the edge cache`);
  assert.equal((await get(w.app, '/api/products?sort=newest&page=0')).status, 400);
});

/** A D1 that records the id lists the statements bind (one json_each parameter each). */
function recordingIdLists(db: D1Database) {
  const lists: Array<{ sql: string; n: number }> = [];
  const wrap = (st: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(st, {
      get(target, prop, recv) {
        if (prop === 'bind') {
          return (...args: unknown[]) => {
            for (const a of args) {
              if (typeof a !== 'string' || !a.startsWith('["')) continue;
              const parsed = JSON.parse(a) as unknown[];
              if (parsed.every((x) => typeof x === 'string' && x.startsWith('lp_'))) lists.push({ sql, n: parsed.length });
            }
            return wrap(target.bind(...args), sql);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const proxy = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: proxy as D1Database, lists };
}

test('past the candidate cap a price sort is BOUNDED and HONEST: only the cap is priced, nothing is hidden, truncated says so', async () => {
  const w = await world();
  const { db, lists } = recordingIdLists(asD1(w.raw));
  const CAP = 20;
  const list = async (q: Record<string, string>) =>
    (await listCatalogProducts(db, q, pricingCtxForUser(db, null), { caps: { candidates: CAP } })) as { body: Card; rows: unknown };
  const ranked = shelf(w.products);
  const sellable = ranked.filter((p) => p.priced);
  assert.equal(sellable.length, 48);
  const head = sellable.slice(0, CAP);
  const tail = sellable.slice(CAP);

  const ids: string[] = [];
  for (let offset = 0; offset < 1200; offset += 50) {
    lists.length = 0;
    const { body } = await list({ sort: 'price_asc', limit: '50', offset: String(offset) });
    assert.equal(body.truncated, true, 'more sellable candidates than the cap');
    assert.equal(body.total, 1200, 'and none of them is hidden');
    assert.equal(body.has_more, offset + 50 < 1200);
    ids.push(...(body.products as Card[]).map((c) => String(c.id)));
    // Bounded: no statement names more products than the cap plus one page.
    const most = Math.max(...lists.map((l) => l.n));
    assert.ok(most <= CAP + 50, `a statement bound ${most} product ids: ${lists.find((l) => l.n === most)?.sql.slice(0, 80)}`);
  }
  assert.equal(new Set(ids).size, 1200, 'no product twice');
  // The cap's sellable products in price order, then the rest of the sellable ones in the shelf order,
  // then the catalog-only ones in the shelf order.
  assert.deepEqual(ids.slice(0, CAP), expectedOrder(head, 'price_asc'));
  assert.deepEqual(ids.slice(CAP, 48), tail.map((p) => p.id));
  assert.deepEqual(ids.slice(48), ranked.filter((p) => !p.priced).map((p) => p.id));

  // A resolved filter cannot vouch for a product it did not price: only the cap's are answered, honestly flagged.
  const ranged = (await list({ price: '1-', sort: 'price_asc', limit: '50' })).body;
  assert.equal(ranged.truncated, true);
  assert.deepEqual(ranged.products.map((c: Card) => c.id), expectedOrder(head, 'price_asc'));
  assert.equal(ranged.total, CAP);

  // A stored-key order needs no price: the cap does not apply, and nothing is truncated.
  const newest = (await list({ sort: 'newest', limit: '50', offset: '1150' })).body;
  assert.equal(newest.truncated, false);
  assert.deepEqual(newest.products.map((c: Card) => c.id), expectedOrder(w.products, 'newest').slice(1150));

  // The keys' own bound: past it the listing says so, and pages what it read.
  const keyed = (await listCatalogProducts(db, { sort: 'newest', limit: '50', offset: '450' }, pricingCtxForUser(db, null), { caps: { keys: 500 } })).body as Card;
  assert.equal(keyed.truncated, true);
  assert.equal(keyed.total, 500);
  assert.equal(keyed.products.length, 50);
  assert.equal(keyed.has_more, false);
});

test('the latency guard: statements and waves do not grow with the catalogue, and the rows leave the long text out', async () => {
  const big = await world();
  const small = freshDb();
  await seed(small, catalogue(120));
  const requests = [
    'sort=relevance&facets=1&limit=24',
    'brand=brand-one&sort=relevance&limit=24&offset=24',
    'sort=newest&limit=24&offset=96',
    'sort=price_asc&facets=1&limit=24',
    'avail=1&limit=24',
    'sort=name&f.enclosed=1&limit=24',
  ];
  const measure = async (raw: DatabaseSync, q: string) => {
    const { waves, db } = wavesD1(raw, 0);
    const app = stubApp(db, null, mount, { publishV2: false });
    await get(app, `/api/products?${q}`); // the isolate is warm (the row columns are known)
    waves.reset();
    const res = await get(app, `/api/products?${q}`);
    assert.equal(res.status, 200);
    return { ...waves.counts };
  };
  for (const q of requests) {
    const a = await measure(small, q);
    const b = await measure(big.raw, q);
    assert.equal(b.executions, a.executions, `${q}: ${a.executions} statements at 120 products, ${b.executions} at 1,200\n${b.sqls.join('\n')}`);
    assert.ok(b.waves <= 2, `${q}: ${b.waves} waves\n${b.sqls.join('\n')}`);
    assert.ok(b.executions <= 15, `${q}: ${b.executions} statements\n${b.sqls.join('\n')}`);
    assert.ok(!b.sqls.some((s) => s.includes('subject_id = ?')), `${q}: the offers are read in one statement`);
  }
  // The row read names its columns and leaves the long text out.
  const { waves, db } = wavesD1(big.raw, 0);
  const app = stubApp(db, null, mount, { publishV2: false });
  await get(app, '/api/products?sort=price_asc&limit=24');
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  (db as { prepare: (sql: string) => D1PreparedStatement }).prepare = (sql: string) => {
    seen.push(sql);
    return prepare(sql);
  };
  await get(app, '/api/products?sort=price_asc&limit=24&offset=24');
  const rowRead = seen.find((s) => s.includes('WHERE products.id IN (SELECT value FROM json_each(?))'));
  assert.ok(rowRead && rowRead.includes('products."price_iqd"') && !rowRead.includes('"description"'), rowRead);
  void waves;
});

test('the cards of the paged listing are the plain listing\'s cards, long text left out of the read or not', async () => {
  const w = await world();
  const plain = new Map<string, Card>();
  for (let offset = 0; offset < 1200; offset += 50) {
    for (const c of (await json(await get(w.app, `/api/products?limit=50&offset=${offset}`))).products as Card[]) plain.set(String(c.id), c);
  }
  assert.equal(plain.size, 1200);
  const paged = await walk(w.app, 'sort=relevance', 1200);
  for (const c of paged) assert.deepEqual(c, plain.get(String(c.id)), String(c.id));
});

test('a catalog-only candidate\'s keyed item is exactly what its card makes of it', async () => {
  const w = await world();
  const db = asD1(w.raw);
  const rows = w.raw
    .prepare("SELECT *, 0 AS sellable_now, (SELECT slug FROM brands b WHERE b.id = products.brand_id) AS brand_slug FROM products WHERE price_iqd = 0 ORDER BY id LIMIT 120")
    .all() as Array<Record<string, unknown>>;
  const cards = await resolveProductCards(db, rows, await pricingCtxForUser(db, null), null, 'flag');
  rows.forEach((row, i) => {
    const card = cards.get(String(row.id))!;
    assert.equal(card.price_status, 'unpriced');
    const resolved = listingItemOf(row, card, i, String(row.brand_slug), ['some-printer']);
    const keyed = keyedListingItem(row as unknown as ListingKeyRow, i, String(row.brand_slug), ['some-printer']);
    assert.deepEqual({ ...keyed, card: null }, { ...resolved, card: null }, String(row.id));
  });
});

const idOf = (c: Card) => String(c.id);

/**
 * One listing walked AS THE CLIENT WALKS IT, straight through the route function with a cap a test can
 * reach: page 1 with the counts (`listingFirstPagePath`), then «عرض المزيد» without them — three small
 * pages, then large ones to the end.
 */
async function walkAsClient(db: D1Database, q: Record<string, string>, cap: number) {
  const list = async (extra: Record<string, string>) =>
    (await listCatalogProducts(db, { ...q, ...extra }, pricingCtxForUser(db, null), { caps: { candidates: cap } })).body as Card;
  const pages: Card[] = [await list({ facets: '1', limit: '5' })];
  let offset = pages[0].products.length;
  while (pages[pages.length - 1].has_more) {
    const b = await list({ limit: pages.length < 4 ? '5' : '50', offset: String(offset) });
    pages.push(b);
    offset += b.products.length;
  }
  return { pages, ids: pages.flatMap((p) => (p.products as Card[]).map(idOf)), plainFirst: await list({ limit: '5' }) };
}

test('the head is the same with or without the counts: a brand walked as the client walks it, past the cap, skips and repeats nothing', async () => {
  const w = await world();
  const db = asD1(w.raw);
  const CAP = 10;
  const brandTwo = w.products.filter((p) => p.brand === 'lb_two');
  const ranked = shelf(brandTwo);
  const sellable = ranked.filter((p) => p.priced);
  assert.equal(sellable.length, 16, 'more sellable products of the brand than the cap');
  for (const sort of ['price_asc', 'price_desc', 'relevance', 'available', 'direct'] as ListingSort[]) {
    const { pages, ids, plainFirst } = await walkAsClient(db, { brand: 'brand-two', sort }, CAP);
    assert.deepEqual((pages[0].products as Card[]).map(idOf), (plainFirst.products as Card[]).map(idOf), `${sort}: page 1 with the counts = page 1 without`);
    assert.equal(new Set(ids).size, ids.length, `${sort}: a product listed twice`);
    assert.equal(ids.length, brandTwo.length, `${sort}: every product of the brand, once`);
    // The brand's first sellable products in the order, then its other sellable ones and its catalog-only
    // ones in the shelf order — whichever page asked for the counts.
    assert.deepEqual(ids.slice(0, CAP), expectedOrder(sellable.slice(0, CAP), sort), `${sort}: the head`);
    assert.deepEqual(ids.slice(CAP, sellable.length), sellable.slice(CAP).map((p) => p.id), `${sort}: the sellable past the head`);
    assert.deepEqual(ids.slice(sellable.length), ranked.filter((p) => !p.priced).map((p) => p.id), `${sort}: the catalog-only`);
    for (const [i, p] of pages.entries()) {
      assert.equal(p.total, brandTwo.length, `${sort} page ${i + 1}: nothing hidden`);
      assert.equal(p.partial_order, true, `${sort} page ${i + 1}: the order covered the head only`);
      assert.equal(p.truncated, true, `${sort} page ${i + 1}`);
    }
    assert.equal(pages[0].partial_counts, true, `${sort}: the counts saw ${CAP} of 48 sellable prices`);
    // The brand facet still counts every brand (disjunctive).
    assert.deepEqual(
      (pages[0].facets.brands as Card[]).map((b) => [b.slug, b.count]).sort(),
      [['brand-one', 400], ['brand-three', 400], ['brand-two', 400]]
    );
  }
});

test('«يناسب طابعة» with the counts chooses the head the SQL narrowing chooses without them', async () => {
  const raw = freshDb();
  const ins = raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, name_ku, description, status, price_iqd, stock, selling_type, sale_types,
                           spec_fields, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', 'active', ?, ?, 'direct_sale', '["direct_sale"]', '{}', ?, ?, ?)`
  );
  const at = '2026-01-01T00:00:00.000Z';
  // Two printers (catalog-only: they are linked to, not listed by, the chip).
  ins.run('fp_pa', 'fit-printer-a', 'Printer A', 'طابعة أ', 'چاپکەری A', 0, 0, 100, at, at);
  ins.run('fp_pb', 'fit-printer-b', 'Printer B', 'طابعة ب', 'چاپکەری B', 0, 0, 101, at, at);
  // 30 sellable parts, each cheaper than the one before it in the shelf order.
  const parts = Array.from({ length: 30 }, (_, i) => `fp_${String(i).padStart(3, '0')}`);
  parts.forEach((id, i) => ins.run(id, id.replace('_', '-'), `Part ${i}`, `قطعة ${i}`, `پارچە ${i}`, 900_000 - i * 10_000, 5, i, at, at));
  for (const id of parts) await publishV2(raw, id);
  const fit = raw.prepare('INSERT INTO product_printer_fits (product_id, printer_id, position) VALUES (?, ?, ?)');
  parts.forEach((id, i) => {
    if (i % 2 === 0) fit.run(id, 'fp_pa', 0);
    if (i % 3 === 0) fit.run(id, 'fp_pb', 1);
  });
  const db = asD1(raw);
  const CAP = 5;
  const fitsA = parts.filter((_, i) => i % 2 === 0);
  for (const sort of ['price_asc', 'relevance'] as ListingSort[]) {
    const { pages, ids, plainFirst } = await walkAsClient(db, { fits: 'fit-printer-a', sort }, CAP);
    assert.deepEqual((pages[0].products as Card[]).map(idOf), (plainFirst.products as Card[]).map(idOf), `${sort}: page 1 with the counts = page 1 without`);
    assert.equal(new Set(ids).size, ids.length, `${sort}: a part listed twice`);
    assert.deepEqual([...ids].sort(), [...fitsA].sort(), `${sort}: every part that fits, once`);
    // The first five parts that fit, in the order (cheapest last in the shelf: reversed by price); then the rest.
    const head = fitsA.slice(0, CAP);
    assert.deepEqual(ids.slice(0, CAP), sort === 'price_asc' ? [...head].reverse() : head, `${sort}: the head`);
    assert.deepEqual(ids.slice(CAP), fitsA.slice(CAP), `${sort}: past the head, the shelf order`);
    for (const p of pages) assert.equal(p.partial_order, true);
    // Every printer is still counted (disjunctive).
    assert.deepEqual(
      (pages[0].facets.printers as Card[]).map((p) => [p.slug, p.count]).sort(),
      [['fit-printer-a', 15], ['fit-printer-b', 10]]
    );
  }
});

/** Catalog-only products as the importer writes them (display order 0, the newest dates): ahead of the shopper in both orders. */
function importAhead(raw: DatabaseSync, k: number): void {
  const ins = raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, name_ku, description, status, price_iqd, stock, selling_type, sale_types,
                           brand_id, spec_fields, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', 'active', 0, 0, 'direct_sale', '["direct_sale"]', 'lb_one', '{}', 0, ?, ?)`
  );
  for (let i = 0; i < k; i++) {
    const id = `li_${String(i).padStart(4, '0')}`;
    const at = new Date(Date.UTC(2026, 9, 19) + i * 1000).toISOString();
    ins.run(id, id.replace('_', '-'), `Import ${i}`, `مستورد ${i}`, `هاوردە ${i}`, at, at);
  }
}

for (const sort of ['relevance', 'newest'] as const) {
  test(`«عرض المزيد» pages from the server's cursor: products entering ahead of the shopper (${sort}) neither end the list nor repeat a card`, async () => {
    const raw = freshDb();
    const products = catalogue(600);
    await seed(raw, products);
    const app = stubApp(asD1(raw), null, mount, { publishV2: false });
    const page = async (offset: number, facets = false) =>
      (await json(await get(app, `/api/products?sort=${sort}&limit=24${facets ? '&facets=1' : ''}${offset ? `&offset=${offset}` : ''}`))) as ProductsListResponse;
    let snap: ListingSnapshot = firstPageSnapshot(await page(0, true), null);
    const press = async () => {
      const pages = await fetchNextPages(snap, (offset) => page(offset));
      snap = pages.reduce((s, p) => withNextPage(s, p.res, p.offset), snap);
      return pages;
    };
    for (let i = 0; i < 3; i++) await press();
    assert.equal(snap.products.length, 96);
    assert.equal(cursorOf(snap), 96);

    importAhead(raw, 24);
    const pages = await press();
    assert.equal(pages.length, 2, 'the page of cards already held is passed over in the same press');
    assert.equal(snap.products.length, 120, 'the press still adds a page');
    assert.equal(cursorOf(snap), 144, 'the cursor is the server position, past the repeats');
    assert.equal(snap.hasMore, true);
    assert.ok(remainingOf(snap) > 0, '«عرض المزيد» stays');

    let presses = 0;
    while (remainingOf(snap) > 0 && presses++ < 40) await press();
    const ids = snap.products.map((p) => String(p.id));
    assert.equal(new Set(ids).size, ids.length, 'no card twice');
    const held = new Set(ids);
    assert.deepEqual(products.filter((p) => !held.has(p.id)).map((p) => p.id), [], 'every product reached');
    assert.equal(snap.hasMore, false, 'the list ends where the server says');
  });
}

test('the snapshot keeps its cursor: kept pages keep theirs, an older snapshot pages from what it holds, an empty page ends the list', () => {
  const card = (id: string) => ({ id }) as ProductsListResponse['products'][number];
  const cards = (from: number, n: number) => Array.from({ length: n }, (_, i) => card(`c${from + i}`));
  const kept: ListingSnapshot = { products: cards(0, 48), total: 200, truncated: false, nextOffset: 72, hasMore: true, facets: null };
  const refreshed = firstPageSnapshot({ products: cards(0, 24), total: 200, has_more: true }, kept);
  assert.equal(refreshed.products.length, 48);
  assert.equal(cursorOf(refreshed), 72, 'the kept pages keep their server cursor');
  assert.equal(refreshed.hasMore, undefined, 'only `total` speaks for the kept pages');
  assert.equal(remainingOf(refreshed), 128);
  const older = { products: cards(0, 30), total: 100, truncated: false, facets: null } as ListingSnapshot;
  assert.equal(cursorOf(older), 30, 'an older snapshot pages from the cards it holds');
  const ended = withNextPage(older, { products: [], total: 100, has_more: true }, 30);
  assert.equal(ended.hasMore, false, 'an empty page ends the list');
  assert.equal(remainingOf(ended), 0);
  const repeats = withNextPage(older, { products: cards(6, 24), total: 100, has_more: true }, 30);
  assert.equal(repeats.products.length, 30, 'repeats are dropped');
  assert.equal(cursorOf(repeats), 54, '…and the cursor still moves past them');
  assert.equal(repeats.hasMore, true, 'a page of repeats does not end the list');
});

test('the answer says WHICH part was not exact — a partial price order, partial counts, or products cut off — and the note follows', async () => {
  const w = await world();
  const db = asD1(w.raw);
  const list = async (q: Record<string, string>, caps: { candidates?: number; keys?: number }) =>
    (await listCatalogProducts(db, q, pricingCtxForUser(db, null), { caps })).body as Card;
  const flags = (b: Card) => ({ truncated: b.truncated, partial_order: b.partial_order, partial_counts: b.partial_counts, cut_off: b.cut_off });

  // A stored-key order is exact from the keys: only the counts saw part of the sellable prices.
  const newestFacets = await list({ sort: 'newest', facets: '1', limit: '24' }, { candidates: 10 });
  assert.deepEqual(flags(newestFacets), { truncated: false, partial_order: false, partial_counts: true, cut_off: false });
  const newestLater = await list({ sort: 'newest', limit: '24', offset: '24' }, { candidates: 10 });
  assert.deepEqual(flags(newestLater), { truncated: false, partial_order: false, partial_counts: undefined, cut_off: false });
  // A price order past the cap is partial on every page, with the counts or without.
  const priceFacets = await list({ sort: 'price_asc', facets: '1', limit: '24' }, { candidates: 10 });
  assert.deepEqual(flags(priceFacets), { truncated: true, partial_order: true, partial_counts: true, cut_off: false });
  const priceLater = await list({ sort: 'price_asc', limit: '24', offset: '24' }, { candidates: 10 });
  assert.deepEqual(flags(priceLater), { truncated: true, partial_order: true, partial_counts: undefined, cut_off: false });
  // Under the cap nothing is partial.
  const whole = await list({ sort: 'price_asc', facets: '1', limit: '24' }, {});
  assert.deepEqual(flags(whole), { truncated: false, partial_order: false, partial_counts: false, cut_off: false });
  // Past the keys' cap the rest are not listed — whatever the order.
  const cut = await list({ sort: 'newest', limit: '24' }, { keys: 500 });
  assert.deepEqual(flags(cut), { truncated: true, partial_order: false, partial_counts: undefined, cut_off: true });

  // The client's note names what happened, from whichever page answered last.
  const state = emptyListing();
  const snapOf = (b: Card) => firstPageSnapshot(b as ProductsListResponse, null);
  assert.deepEqual(listingNotes(snapOf(newestFacets), { ...state, sort: 'newest' }), { partial: null, cutOff: false });
  assert.deepEqual(listingNotes(snapOf(priceFacets), { ...state, sort: 'price_asc' }), { partial: 'order', cutOff: false });
  assert.deepEqual(listingNotes(snapOf(priceFacets), { ...state, avail: true }), { partial: 'filter', cutOff: false });
  assert.deepEqual(listingNotes(snapOf(cut), state), { partial: null, cutOff: true });
  const later = withNextPage(snapOf(priceFacets), { ...(priceLater as ProductsListResponse), partial_order: false }, 24);
  assert.equal(later.partialOrder, false, 'a later page\'s word replaces page 1\'s');

  // The client's «price or stock filter» is the Worker's, and the stored-key filters never read one.
  const states: ListingState[] = [
    state,
    { ...state, avail: true },
    { ...state, sale: 'direct' },
    { ...state, price: { min: 1, max: null } },
    { ...state, offer: true },
    { ...state, member: true },
    { ...state, brands: ['brand-one'], fits: ['fit-printer-a'], specs: { enclosed: ['1'] } },
  ];
  for (const s of states) {
    assert.equal(priceOrStockFilterOn(s), filtersReadResolved(s), JSON.stringify(s));
    assert.equal(filtersReadResolved(storedKeyFilters(s)), false);
    assert.deepEqual(storedKeyFilters(s).brands, s.brands);
  }
});

test('the name order compares with ONE collator and sorts the candidates once: no per-comparison localeCompare, no second sort', async () => {
  const w = await world();
  const realLocale = String.prototype.localeCompare;
  const realCompare = NAME_COLLATOR.compare;
  let locale = 0;
  let collated = 0;
  String.prototype.localeCompare = function (this: string, that: string, locales?: string | string[], options?: Intl.CollatorOptions) {
    locale += 1;
    return realLocale.call(this, that, locales, options);
  };
  Object.defineProperty(NAME_COLLATOR, 'compare', {
    configurable: true,
    value: (a: string, b: string) => {
      collated += 1;
      return realCompare(a, b);
    },
  });
  try {
    const count = async (q: string) => {
      locale = 0;
      collated = 0;
      const b = await json(await get(w.app, `/api/products?${q}`));
      return { b, locale, collated };
    };
    await count('sort=name&limit=24&offset=480'); // the isolate is warm
    const newest = await count('sort=newest&limit=24&offset=480');
    const named = await count('sort=name&limit=24&offset=480');
    // One sort of the same 1,200 names in the same (shelf) order, straight through sortItems.
    collated = 0;
    const items = shelf(w.products).map((p, i) =>
      keyedListingItem({ id: p.id, name: p.name, created_at: p.createdAt, brand_id: null, inventory_mode: null, composition: null, sellable_now: 0 }, i, null)
    );
    sortItems(items, 'name', false);
    const once = collated;
    assert.equal(named.locale, newest.locale, 'the name order calls no localeCompare of its own');
    assert.equal(newest.collated, 0);
    assert.ok(named.collated > 0 && named.collated <= Math.ceil(once * 1.2), `${named.collated} comparisons where one sort makes ${once}`);
    assert.deepEqual((named.b.products as Card[]).map(idOf), expectedOrder(w.products, 'name').slice(480, 504));
  } finally {
    String.prototype.localeCompare = realLocale;
    delete (NAME_COLLATOR as unknown as { compare?: unknown }).compare;
  }
  assert.equal(NAME_COLLATOR.compare('a', 'B'), -1, 'the collator is itself again');
});
