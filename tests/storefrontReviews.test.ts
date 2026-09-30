/**
 * STORE REVIEWS: PHOTOS, FILTERS AND «المزيد» (merchant platform V2,
 * storefront L12) on the real `GET /api/storefront/:slug/reviews`:
 *
 *   - `rating=N` narrows the page to one star value; `photos=1` to reviews
 *     that carry pictures; the summary and distribution stay the whole
 *     store's under either;
 *   - every review carries its `images` as a list;
 *   - `next_cursor` is EXACT (one row past the page is read, D8): null on a
 *     page that happens to be full when nothing follows it;
 *   - a rating outside 1–5 is refused;
 *   - the store body's first page (worker/lib/storeLayout.ts) has the same
 *     exact cursor;
 *   - THE EDGE KEY: `rating` and `photos` are declared, so «★5» and «with
 *     photos» are two entries, never one another's hit.
 *
 * Run: node --import tsx --test tests/storefrontReviews.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, pending, stubApp } from './fixtures/app';
import { seedLayoutStore, SLUG, STORE_ID } from './fixtures/storeLayout';
import { storefrontRoutes } from '../worker/routes/storefront';
import { blockDataFor } from '../worker/lib/storeLayout';
import { storeById } from '../worker/lib/merchantAuth';
import { normalizeLayout } from '../packages/storeLayout/src/normalize';

const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const PHOTOS = ['/files/merchants/c2/public/a.webp', '/files/merchants/c2/public/b.webp'];

function world() {
  const raw = freshDb();
  seedLayoutStore(raw);
  // r2 (5★, 2026-09-12) carries two pictures; r1 (5★, 09-10) and r3 (4★, 09-14) none.
  raw.prepare('UPDATE merchant_reviews SET images = ? WHERE id = ?').run(JSON.stringify(PHOTOS), 'r2');
  const db = asD1(raw);
  const app = stubApp(db, null, (a) => a.route('/api/storefront', storefrontRoutes), { env: ENV });
  return { raw, db, app };
}

const reviews = async (app: ReturnType<typeof stubApp>, qs = '') => {
  const res = await get(app, `/api/storefront/${SLUG}/reviews${qs}`);
  const body = await json(res);
  return { status: res.status, body, ids: ((body.reviews ?? []) as Array<{ id: string }>).map((r) => r.id) };
};

test('rating= and photos=1 narrow the page; the summary stays the whole store’s; images travel as lists', async () => {
  const { app } = world();
  const all = await reviews(app);
  assert.equal(all.status, 200);
  assert.deepEqual(all.ids, ['r3', 'r2', 'r1'], 'newest first');
  const r2 = (all.body.reviews as Array<{ id: string; images: string[] }>).find((r) => r.id === 'r2')!;
  assert.deepEqual(r2.images, PHOTOS);
  assert.deepEqual((all.body.reviews as Array<{ id: string; images: string[] }>).find((r) => r.id === 'r1')!.images, []);

  const five = await reviews(app, '?rating=5');
  assert.deepEqual(five.ids, ['r2', 'r1']);
  assert.equal(five.body.count, 3, 'the count is the store’s, not the page’s');
  assert.deepEqual(five.body.distribution, { '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 });
  assert.equal(five.body.average, all.body.average);

  const four = await reviews(app, '?rating=4');
  assert.deepEqual(four.ids, ['r3']);
  const three = await reviews(app, '?rating=3');
  assert.deepEqual(three.ids, [], 'a star nobody gave: an empty page, the summary intact');
  assert.equal(three.body.count, 3);

  const photos = await reviews(app, '?photos=1');
  assert.deepEqual(photos.ids, ['r2']);
  const both = await reviews(app, '?photos=1&rating=4');
  assert.deepEqual(both.ids, [], 'the two filters compose');

  assert.equal((await reviews(app, '?rating=9')).status, 400);
  assert.equal((await reviews(app, '?rating=0')).status, 400);
  assert.equal((await reviews(app, '?photos=yes')).ids.length, 3, 'only «1» means with photos');
});

test('next_cursor is exact: null on a full last page, set only when a row follows; the cursor walks the filter', async () => {
  const { app } = world();
  const p1 = await reviews(app, '?limit=2');
  assert.deepEqual(p1.ids, ['r3', 'r2']);
  assert.equal(p1.body.next_cursor, '2026-09-12T10:00:00.000Z|r2');
  const p2 = await reviews(app, `?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
  assert.deepEqual(p2.ids, ['r1']);
  assert.equal(p2.body.next_cursor, null);

  const full = await reviews(app, '?limit=3');
  assert.equal(full.ids.length, 3);
  assert.equal(full.body.next_cursor, null, 'a page that is exactly full carries no cursor when nothing follows');

  // Under a filter the cursor pages the filtered list.
  const f1 = await reviews(app, '?rating=5&limit=1');
  assert.deepEqual(f1.ids, ['r2']);
  assert.equal(f1.body.next_cursor, '2026-09-12T10:00:00.000Z|r2');
  const f2 = await reviews(app, `?rating=5&limit=1&cursor=${encodeURIComponent(f1.body.next_cursor)}`);
  assert.deepEqual(f2.ids, ['r1']);
  assert.equal(f2.body.next_cursor, null);
});

test('the store body’s first page of reviews (blocks_data) carries images and the same exact cursor', async () => {
  const { db } = world();
  const ctx = await storeById(db, STORE_ID);
  assert.ok(ctx);
  const two = normalizeLayout({ schema_version: 1, blocks: [{ type: 'reviews', settings: { limit: 2 } }] }, { ownerUserId: 'owner' }).layout;
  const data = await blockDataFor(db, ctx!, two);
  assert.ok(data.reviews);
  assert.deepEqual(data.reviews!.reviews.map((r) => r.id), ['r3', 'r2']);
  assert.deepEqual(data.reviews!.reviews[1].images, PHOTOS);
  assert.equal(data.reviews!.next_cursor, '2026-09-12T10:00:00.000Z|r2');
  const three = normalizeLayout({ schema_version: 1, blocks: [{ type: 'reviews', settings: { limit: 3 } }] }, { ownerUserId: 'owner' }).layout;
  const exact = await blockDataFor(db, ctx!, three);
  assert.equal(exact.reviews!.reviews.length, 3);
  assert.equal(exact.reviews!.next_cursor, null, 'three of three: nothing to load more');
});

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

test('rating and photos are declared cache parameters: «★5», «with photos» and «all» are three edge entries', async () => {
  const { app } = world();
  const scope = globalThis as { caches?: unknown };
  const cache = zoneCache();
  scope.caches = { default: cache };
  try {
    const all = await reviews(app);
    await Promise.all(pending);
    assert.deepEqual(all.ids, ['r3', 'r2', 'r1']);
    const five = await reviews(app, '?rating=5');
    await Promise.all(pending);
    assert.deepEqual(five.ids, ['r2', 'r1'], 'not the «all» entry');
    const photos = await reviews(app, '?photos=1');
    await Promise.all(pending);
    assert.deepEqual(photos.ids, ['r2'], 'not the «★5» entry');
    assert.equal(cache.store.size, 3);
    const again = await get(app, `/api/storefront/${SLUG}/reviews?photos=1`);
    assert.equal(again.headers.get('CF-Cache-Status'), 'HIT');
    assert.deepEqual(((await json(again)).reviews as Array<{ id: string }>).map((r) => r.id), ['r2']);
  } finally {
    delete scope.caches;
  }
});
