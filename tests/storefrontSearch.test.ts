/**
 * IN-STORE SEARCH AND SORT (merchant platform V2, storefront L11) on the real
 * `GET /api/storefront/:slug/products`, against every migration:
 *
 *   - `q` is matched as a LITERAL: a «%» or «_» a visitor types finds the
 *     product that carries it, never everything (worker/lib/sqlLike.ts);
 *   - a term over 60 characters is refused (400), not cut;
 *   - `sort=price_asc|price_desc` orders by price and pages by `<price>|<id>`
 *     without skipping a tie; anything else named is refused; no sort keeps
 *     the keyset the route always had (`<created_at>|<id>`, newest first);
 *   - a collection keeps its own arrangement unless a sort is named;
 *   - the card carries `has_video` (L10) from `community_product_media`;
 *   - THE EDGE KEY (worker/lib/edgePolicy.ts): `q` and `sort` are DECLARED
 *     parameters, so two different terms are two entries — a guest's «تروس»
 *     is never answered from the cached «تنين».
 *
 * Run: node --import tsx --test tests/storefrontSearch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, pending, stubApp } from './fixtures/app';
import { seedLayoutStore, SLUG } from './fixtures/storeLayout';
import { storefrontRoutes, STORE_PRODUCTS_PARAMS, STORE_REVIEWS_PARAMS } from '../worker/routes/storefront';
import { canonicalKey } from '../worker/lib/edgePolicy';

const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };

function world() {
  const raw = freshDb();
  seedLayoutStore(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/storefront', storefrontRoutes), { env: ENV });
  return { raw, app };
}

const products = async (app: ReturnType<typeof stubApp>, qs: string) => {
  const res = await get(app, `/api/storefront/${SLUG}/products${qs}`);
  const body = await json(res);
  return { status: res.status, body, ids: ((body.products ?? []) as Array<{ id: string }>).map((p) => p.id) };
};

/** A product of the fixture store with an odd name, for the literal-match tests. */
function addProduct(raw: ReturnType<typeof freshDb>, id: string, name: string, price: number, createdAt: string) {
  raw
    .prepare(
      `INSERT INTO community_products (id,merchant_id,store_id,slug,status,lifecycle,name,name_ar,description,images,price_iqd,
          original_price_iqd,section_id,featured,stock,track_stock,sold_count,created_at)
       VALUES (?,'m1','s1',?,'active','active',?,?,'','[]',?,NULL,NULL,0,5,1,0,?)`
    )
    .run(id, `raf3d-${id}`, name, name, price, createdAt);
}

// ------------------------------------------------------------------ literal q

test('q matches «%» and «_» as literals, and a term over 60 characters is refused', async () => {
  const { raw, app } = world();
  addProduct(raw, 'pct', '50% off spool', 5000, '2026-09-20T10:00:00.000Z');
  addProduct(raw, 'pctx', '50x off spool', 5000, '2026-09-20T11:00:00.000Z');
  addProduct(raw, 'under', 'a_b bracket', 5000, '2026-09-20T12:00:00.000Z');
  addProduct(raw, 'underx', 'axb bracket', 5000, '2026-09-20T13:00:00.000Z');

  assert.deepEqual((await products(app, '?q=50%25')).ids, ['pct'], 'a percent sign is the character, not «anything»');
  assert.deepEqual((await products(app, '?q=a_b')).ids, ['under'], 'an underscore is the character, not «any one»');
  assert.deepEqual((await products(app, '?q=spool')).ids, ['pctx', 'pct'], 'a plain term: newest first, the keyset unchanged');
  // The merchant's Arabic name is searched too.
  assert.deepEqual((await products(app, `?q=${encodeURIComponent('تنين')}`)).ids, ['p1']);
  // Nothing matches: an empty page, never an error.
  const none = await products(app, '?q=zzzz');
  assert.equal(none.status, 200);
  assert.deepEqual(none.ids, []);
  assert.equal(none.body.next_cursor, null);

  const sixty = 'x'.repeat(60);
  assert.equal((await products(app, `?q=${sixty}`)).status, 200, 'sixty characters is the ceiling, inclusive');
  const tooLong = await products(app, `?q=${sixty}x`);
  assert.equal(tooLong.status, 400, 'sixty-one is refused, not cut');
  assert.equal(tooLong.body.success, false);
});

// ----------------------------------------------------------------------- sort

test('sort=price_asc / price_desc order by price, page by <price>|<id>, and never skip a tie', async () => {
  const { raw, app } = world();
  // Two products at one price: the keyset must break the tie by id.
  addProduct(raw, 'tieA', 'tie a', 7000, '2026-09-20T10:00:00.000Z');
  addProduct(raw, 'tieB', 'tie b', 7000, '2026-09-20T11:00:00.000Z');
  // Fixture prices: p8 3000, p4 7000, p7 9000, p2 12000, p1 18000, p6 22000, p3 30000, p5 45000.
  const asc = await products(app, '?sort=price_asc&limit=3');
  assert.deepEqual(asc.ids, ['p8', 'tieB', 'tieA'], 'cheapest first; a tie by id descending');
  assert.equal(asc.body.next_cursor, '7000|tieA');
  const asc2 = await products(app, `?sort=price_asc&limit=3&cursor=${encodeURIComponent(asc.body.next_cursor)}`);
  assert.deepEqual(asc2.ids, ['p4', 'p7', 'p2'], 'the third 7000 row is not skipped at the boundary');
  const asc3 = await products(app, `?sort=price_asc&limit=3&cursor=${encodeURIComponent(asc2.body.next_cursor)}`);
  assert.deepEqual(asc3.ids, ['p1', 'p6', 'p3']);
  const asc4 = await products(app, `?sort=price_asc&limit=3&cursor=${encodeURIComponent(asc3.body.next_cursor)}`);
  assert.deepEqual(asc4.ids, ['p5']);
  assert.equal(asc4.body.next_cursor, null);

  const desc = await products(app, '?sort=price_desc&limit=4');
  assert.deepEqual(desc.ids, ['p5', 'p3', 'p6', 'p1']);
  assert.equal(desc.body.next_cursor, '18000|p1');
  const desc2 = await products(app, `?sort=price_desc&limit=4&cursor=${encodeURIComponent(desc.body.next_cursor)}`);
  assert.deepEqual(desc2.ids, ['p2', 'p7', 'tieB', 'tieA']);

  // A search inside a sort.
  assert.deepEqual((await products(app, '?sort=price_desc&q=tie')).ids, ['tieB', 'tieA']);
  // A name the server does not know is refused.
  assert.equal((await products(app, '?sort=cheapest')).status, 400);
  assert.equal((await products(app, '?sort=new')).ids.length, 10, '«new» is the list as it came');
});

test('no sort keeps the keyset the route always had: every product once, newest first, across pages', async () => {
  const { app } = world();
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    const page = await products(app, `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...page.ids);
    cursor = page.body.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ['p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1']);
  const first = await products(app, '?limit=3');
  assert.match(String(first.body.next_cursor), /^2026-09-01T\d\d:00:00\.000Z\|p6$/, 'the cursor is still <created_at>|<id>');
});

test('a collection keeps its own arrangement unless a sort is named', async () => {
  const { raw, app } = world();
  // sec3 holds p3 (30000), p4 (7000), p7 (9000): migration 0127 backfilled the
  // legacy `section_id` shelf into a manual collection; the merchant's order is
  // the positions, arranged here as p4, p3, p7.
  raw.exec(`UPDATE merchant_collection_products SET position = CASE product_id WHEN 'p4' THEN 1 WHEN 'p3' THEN 2 ELSE 3 END WHERE collection_id = 'sec3'`);
  assert.deepEqual((await products(app, '?section=sec3')).ids, ['p4', 'p3', 'p7'], 'the merchant’s order');
  assert.deepEqual((await products(app, '?section=sec3&sort=price_desc')).ids, ['p3', 'p7', 'p4']);
  assert.deepEqual((await products(app, '?section=sec3&sort=price_asc&limit=2')).ids, ['p4', 'p7']);
  const page = await products(app, '?section=sec3&sort=price_asc&limit=2');
  assert.equal(page.body.next_cursor, '9000|p7');
  assert.deepEqual((await products(app, `?section=sec3&sort=price_asc&limit=2&cursor=${encodeURIComponent(page.body.next_cursor)}`)).ids, ['p3']);
  assert.deepEqual((await products(app, `?section=sec3&q=${encodeURIComponent('مصباح')}`)).ids, ['p3'], 'a search inside a collection');
  assert.deepEqual((await products(app, '?section=sec3&sort=new')).ids, ['p7', 'p4', 'p3'], '«new» named on a collection is newest first');
});

// ------------------------------------------------------------ has_video (L10)

test('the card says has_video from community_product_media, and the store body carries image_2', async () => {
  const { raw, app } = world();
  raw.exec(`INSERT INTO community_product_media (id, product_id, store_id, kind, media_key, position)
            VALUES ('pm1','p2','s1','video','merchants/owner/public/clip0001.mp4',0)`);
  raw.exec(`UPDATE community_products SET images = '["/files/merchants/owner/public/one.webp","/files/merchants/owner/public/two.webp"]' WHERE id = 'p1'`);
  const list = await products(app, '');
  const byId = new Map((list.body.products as Array<{ id: string; has_video: boolean }>).map((p) => [p.id, p.has_video]));
  assert.equal(byId.get('p2'), true);
  assert.equal(byId.get('p1'), false);
  // The store body's own first page (blocks_data) carries the same two facts.
  const store = await json(await get(app, `/api/storefront/${SLUG}`));
  const latest = store.store.blocks_data.products.latest.items as Array<{ id: string; has_video: boolean; image_2: string | null; images: string[] }>;
  const p1 = latest.find((p) => p.id === 'p1')!;
  const p2 = latest.find((p) => p.id === 'p2')!;
  assert.equal(p1.image_2, '/files/merchants/owner/public/two.webp');
  assert.equal(p1.images.length, 1, 'the card still carries one picture; the second is its own field');
  assert.equal(p1.has_video, false);
  assert.equal(p2.has_video, true);
  assert.equal(p2.image_2, null);
});

// ------------------------------------------------------------- the edge key

/** `caches.default` as the live zone behaves (tests/edgeCachePolicy.test.ts). */
function zoneCache() {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: Request) {
      const stored = store.get(req.url);
      if (!stored) return undefined;
      const copy = stored.clone();
      const headers = new Headers(copy.headers);
      headers.set('CF-Cache-Status', 'HIT');
      return new Response(copy.body, { status: copy.status, headers });
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}

test('q and sort are declared cache parameters: two terms are two edge entries, and each answers its own question', async () => {
  for (const p of ['q', 'sort']) assert.ok(STORE_PRODUCTS_PARAMS.includes(p), `${p} is declared on the products route`);
  for (const p of ['rating', 'photos']) assert.ok(STORE_REVIEWS_PARAMS.includes(p), `${p} is declared on the reviews route`);
  const a = canonicalKey(`https://x.levonis-iq.com/api/storefront/${SLUG}/products?q=a`, STORE_PRODUCTS_PARAMS).url;
  const b = canonicalKey(`https://x.levonis-iq.com/api/storefront/${SLUG}/products?q=b`, STORE_PRODUCTS_PARAMS).url;
  assert.notEqual(a, b, 'two terms are two keys');

  const { app } = world();
  const scope = globalThis as { caches?: unknown };
  const cache = zoneCache();
  scope.caches = { default: cache };
  try {
    const first = await products(app, `?q=${encodeURIComponent('تنين')}`);
    await Promise.all(pending);
    assert.deepEqual(first.ids, ['p1']);
    assert.equal(cache.store.size, 1, 'the first guest answer was stored');
    const second = await products(app, `?q=${encodeURIComponent('تروس')}`);
    await Promise.all(pending);
    assert.deepEqual(second.ids, ['p2'], 'a different term is a different answer, not the first one’s hit');
    assert.equal(cache.store.size, 2, 'two terms, two entries');
    const sorted = await products(app, '?sort=price_asc&limit=2');
    await Promise.all(pending);
    assert.deepEqual(sorted.ids, ['p8', 'p4']);
    const plain = await products(app, '?limit=2');
    await Promise.all(pending);
    assert.deepEqual(plain.ids, ['p8', 'p7'], 'the sorted entry does not answer the plain list');
    assert.equal(cache.store.size, 4);
    // …and a repeat of the first term is a hit with the first term's body.
    const again = await get(app, `/api/storefront/${SLUG}/products?q=${encodeURIComponent('تنين')}`);
    assert.equal(again.headers.get('CF-Cache-Status'), 'HIT');
    assert.deepEqual(((await json(again)).products as Array<{ id: string }>).map((p) => p.id), ['p1']);
  } finally {
    delete scope.caches;
  }
});
