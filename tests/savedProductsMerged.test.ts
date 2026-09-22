/**
 * «في المحفوظات عند حفظ منتج معين لا يظهر وتظهر لا توجد منتجات محفوظه بعد»
 *
 * The heart worked. The page was empty. There are TWO hearts, and «المحفوظات»
 * only knew about one of them:
 *
 *   Storefront.tsx        → PUT /api/community-favorites/:id → community_product_favorites
 *   Product.tsx (line 1403) → PUT /api/profile/favorites/:id  → favorites
 *
 * Two tables, and they stay two: they reference `community_products` and
 * `products`, and one foreign key cannot point at either. What was wrong was
 * that ONE screen read only one of them, so the buyer who hearted a printer on
 * the main product page — the ordinary case — got «لا توجد منتجات محفوظه بعد»
 * from a page that had their save sitting in the other table.
 *
 * Everything below runs against the REAL route and the REAL migrations. The
 * `source` field is the load-bearing part and gets the most assertions: the
 * card opens a different page per source, and the heart DELETES through a
 * different door — and a delete against the wrong table is a 200 that removes
 * nothing, which would read as a broken tap rather than as an error.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, get, json, type StubUser } from './fixtures/app';
import { communityFavoriteRoutes } from '../worker/routes/communityFavorites';

const buyer: StubUser = { id: 'u1', role: 'customer', email: 'b@x.co' };
const app = (db: unknown) => stubApp(db, buyer, (a) => a.route('/api/community-favorites', communityFavoriteRoutes));

interface Item {
  source: 'store' | 'catalog';
  product_id: string;
  slug: string;
  name: string;
  store_name: string | null;
  store_url: string | null;
  price_iqd: number;
  in_stock: boolean | null;
  saved_at: string;
}

/**
 * One buyer, one catalogue save and one storefront save, with the CATALOGUE
 * one hearted later — so a response that merely concatenated the two lists in
 * query order would put it second and the ordering assertion would catch it.
 */
function seed(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO users (id, email) VALUES ('u1', 'b@x.co'), ('m1', 'm@x.co');
    INSERT INTO community_merchants (id, user_id, name) VALUES ('cm1', 'm1', 'Ali Prints');
    INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name)
      VALUES ('st1', 'cm1', 'm1', 'aliprints', 'Ali Prints');
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, name_ar, price_iqd)
      VALUES ('cp1', 'cm1', 'st1', 'phone-stand', 'Phone stand', 'حامل هاتف', 12000);
    INSERT INTO products (id, slug, name, name_ar, price_iqd, status)
      VALUES ('p1', 'bambu-a1', 'Bambu Lab A1', 'بامبو لاب A1', 505000, 'active');

    INSERT INTO community_product_favorites (user_id, product_id, created_at)
      VALUES ('u1', 'cp1', '2026-01-01T00:00:00.000Z');
    INSERT INTO favorites (user_id, product_id, created_at)
      VALUES ('u1', 'p1', '2026-02-01T00:00:00.000Z');
  `);
}

async function list(raw: DatabaseSync): Promise<Item[]> {
  const res = await get(app(asD1(raw)), '/api/community-favorites');
  assert.equal(res.status, 200);
  return (await json(res)).items as Item[];
}

test('a product hearted on the MAIN product page appears in المحفوظات', async () => {
  const raw = freshDb();
  seed(raw);
  const items = await list(raw);
  const catalogue = items.find((i) => i.product_id === 'p1');
  assert.ok(catalogue, 'the save the owner made is on the list — this is the whole report');
  assert.equal(catalogue.source, 'catalog');
  assert.equal(catalogue.slug, 'bambu-a1', 'the slug the /product/:slug route needs');
  assert.equal(catalogue.price_iqd, 505_000);
});

test('the storefront hearts are still there — one list, not a replacement', async () => {
  const items = await list((() => { const r = freshDb(); seed(r); return r; })());
  assert.equal(items.length, 2);
  const store = items.find((i) => i.product_id === 'cp1');
  assert.ok(store);
  assert.equal(store.source, 'store');
  assert.equal(store.store_name, 'Ali Prints');
});

test('the list is in save order across BOTH tables, newest first', async () => {
  const raw = freshDb();
  seed(raw);
  const items = await list(raw);
  assert.deepEqual(
    items.map((i) => i.product_id),
    ['p1', 'cp1'],
    'the catalogue save is the more recent one, and sorting is not per-table'
  );
});

test('a catalogue row claims no merchant, so the card never tries to leave the site', async () => {
  const raw = freshDb();
  seed(raw);
  const catalogue = (await list(raw)).find((i) => i.source === 'catalog')!;
  assert.equal(catalogue.store_url, null, 'a truthy url here would open a subdomain that does not exist');
  assert.equal(catalogue.store_name, null);
});

test('a retired catalogue product drops off, exactly as /api/profile/favorites drops it', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec("UPDATE products SET status = 'hidden' WHERE id = 'p1'");
  const items = await list(raw);
  assert.deepEqual(items.map((i) => i.product_id), ['cp1'], 'and the storefront save is untouched by it');
});

test('availability is NOT claimed for a catalogue product', async () => {
  /**
   * A storefront product's availability is one column. A catalogue product's
   * is the whole availability engine — `inventory_mode`, the per-option and
   * per-colour levels, the pre-order capacity and its transport quotas — and
   * `products.stock` means nothing on its own for any mode but SIMPLE. So the
   * list says `null` and the card prints nothing, in BOTH stock states: a
   * printer in stock in three colours must not read «غير متوفر», and a
   * sold-out one must not be promised.
   */
  for (const stock of [0, 7]) {
    const raw = freshDb();
    seed(raw);
    raw.exec(`UPDATE products SET stock = ${stock} WHERE id = 'p1'`);
    const catalogue = (await list(raw)).find((i) => i.source === 'catalog')!;
    assert.equal(catalogue.in_stock, null, `stock=${stock}: unknown, not guessed`);
  }
  // The storefront side still answers, because there it IS one column.
  const raw = freshDb();
  seed(raw);
  raw.exec("UPDATE community_products SET track_stock = 1, stock = 0 WHERE id = 'cp1'");
  assert.equal((await list(raw)).find((i) => i.source === 'store')!.in_stock, false);
});

test('an empty list is empty for the right reason — both tables read', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id, email) VALUES ('u1', 'b@x.co')");
  assert.deepEqual(await list(raw), []);
});

test('the two saves are distinguishable even when the ids collide', async () => {
  /**
   * `community_products.id` and `products.id` are separate id spaces, so the
   * same string can exist in both. The list is keyed by source + id on the
   * client for exactly this reason, and a remove must delete one and leave the
   * other — which is only possible because `source` is on the row.
   */
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id, email) VALUES ('u1', 'b@x.co'), ('m1', 'm@x.co');
    INSERT INTO community_merchants (id, user_id, name) VALUES ('cm1', 'm1', 'Ali Prints');
    INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name)
      VALUES ('st1', 'cm1', 'm1', 'aliprints', 'Ali Prints');
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, price_iqd)
      VALUES ('same', 'cm1', 'st1', 'store-thing', 'Store thing', 1000);
    INSERT INTO products (id, slug, name, price_iqd, status)
      VALUES ('same', 'catalogue-thing', 'Catalogue thing', 2000, 'active');
    INSERT INTO community_product_favorites (user_id, product_id) VALUES ('u1', 'same');
    INSERT INTO favorites (user_id, product_id) VALUES ('u1', 'same');
  `);
  const items = await list(raw);
  assert.equal(items.length, 2, 'both survive — neither overwrites the other');
  assert.deepEqual([...items.map((i) => i.source)].sort(), ['catalog', 'store']);
});
