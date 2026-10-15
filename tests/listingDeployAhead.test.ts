/**
 * DEPLOY AHEAD OF 0184, 0189 AND 0193 (CLAUDE.md rule 2; DECISIONS row 240;
 * spec §1.3, §4.10, §7.1).
 *
 * A Worker carrying this branch can meet a database missing any of the three
 * migrations it reads (a manual redeploy of an older commit, or Workers Builds
 * reopened in an emergency). Proves on real databases built through 0183,
 * 0188 and the migration before 0193:
 *   - `runListed` retries ONCE per missing piece with exactly that clause
 *     stripped: without 0184 both held clauses go (VISIBLE = active); without
 *     0189 the V2 clause becomes `AND 0` (nothing sellable);
 *   - customers still see every active product, catalog-only, and NO answer
 *     carries a price — the legacy columns hold a sentinel to prove it;
 *   - without 0193 the price-request doors answer 503 PRICE_REQUESTS_UNAVAILABLE
 *     (never cacheable) and the admin sort and filter fall back.
 *
 * Run: node --import tsx --test tests/listingDeployAhead.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, get, json, post, stubApp, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { LEGACY, catalogLeaks } from './fixtures/catalogOnly';
import { optimisticSellableFlag, optimisticVisible, runListed } from '../worker/lib/listing';
import { productRoutes, homeRoutes } from '../worker/routes/products';
import { publicApiRoutes } from '../worker/routes/publicApi';
import { priceRequestRoutes } from '../worker/routes/priceRequests';
import { adminProductsRoutes } from '../worker/routes/adminProducts';

const CUSTOMER: StubUser = { id: 'u_c', role: 'customer', email: 'c@x.co' };
const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BEFORE_0193 = readdirSync(join(ROOT, 'migrations')).some((f) => f.startsWith('0192_')) ? '0192' : '0191';

function seed(raw: DatabaseSync): DatabaseSync {
  raw.exec(`
    INSERT INTO users (id, name, email, password_hash, role) VALUES ('u_c', 'C', 'c@x.co', 'h', 'customer'), ('usr_owner', 'O', 'boss@x.co', 'h', 'admin');
    INSERT INTO products (id, slug, name, status, price_iqd, prime_price_iqd, pro_price_iqd, stock, selling_type, sale_types) VALUES
      ('p_old', 'old-printer', 'Old Printer', 'active', ${LEGACY.price}, ${LEGACY.prime}, ${LEGACY.pro}, 4, 'direct_sale', '["direct_sale"]'),
      ('p_draft', 'old-draft', 'Old Draft', 'draft', ${LEGACY.price}, NULL, NULL, 4, 'direct_sale', '["direct_sale"]');
  `);
  return raw;
}

const shop = (raw: DatabaseSync, user: StubUser | null = null) =>
  stubApp(
    asD1(raw),
    user,
    (a) => {
      a.route('/api/products', productRoutes);
      a.route('/api/home', homeRoutes);
      a.route('/api/public/v1', publicApiRoutes);
      a.route('/api/price-requests', priceRequestRoutes);
      a.route('/api/admin/products-v2', adminProductsRoutes);
    },
    { publishV2: false }
  );

/** The statements `runListed` tried, in order. */
async function attempts(raw: DatabaseSync): Promise<string[]> {
  const db = asD1(raw);
  const tried: string[] = [];
  await runListed(db, `SELECT id, ${optimisticSellableFlag(db, 'p')} AS s FROM products p WHERE ${optimisticVisible(db, 'p')}`, async (sql) => {
    tried.push(sql);
    return db.prepare(sql).all();
  });
  return tried;
}

test('runListed strips exactly the missing clause, once each', async () => {
  const none = await attempts(seed(dbThrough('0183')));
  assert.equal(none.length, 3, 'without 0184 and 0189: the held clauses go, then the V2 clause');
  assert.match(none[0]!, /pch\.held|pcv\.held/);
  assert.doesNotMatch(none[2]!, /product_completeness/);
  assert.doesNotMatch(none[2]!, /product_pricing_state/);
  assert.match(none[2]!, / AND 0 THEN 1 ELSE 0 END/, 'nothing sellable');

  const no189 = await attempts(seed(dbThrough('0188')));
  assert.equal(no189.length, 2, 'without 0189 only: one retry');
  assert.match(no189[1]!, /pcv\.held = 1/, 'the catalogue hold stays');
  assert.doesNotMatch(no189[1]!, /product_pricing_state/);

  const current = await attempts(seed(dbThrough(BEFORE_0193)));
  assert.equal(current.length, 1, 'a database with 0184 and 0189 never retries');
});

for (const through of ['0183', '0188'] as const) {
  test(`a database through ${through}: every active product shown catalog-only, no answer carries a price`, async () => {
    const raw = seed(dbThrough(through));
    for (const user of [null, CUSTOMER]) {
      const app = shop(raw, user);
      const list = await json(await get(app, '/api/products'));
      assert.deepEqual((list.products as Array<{ id: string }>).map((p) => p.id), ['p_old'], 'the active product, never the draft');
      const card = (list.products as Array<Record<string, unknown>>)[0]!;
      assert.equal(card.price_status, 'unpriced');
      assert.equal(card.display_price_iqd, null);
      const page = await get(app, '/api/products/old-printer');
      assert.equal(page.status, 200);
      const pageBody = await json(page);
      assert.equal(pageBody.price_status, 'unpriced');
      const quote = await post(app, '/api/products/old-printer/quote', { qty: 1 });
      assert.equal(quote.status, 409);
      assert.equal((await json(quote)).code, 'PRICE_NOT_AVAILABLE');
      const home = await json(await get(app, '/api/home'));
      const api = await json(await get(app, '/api/public/v1/products/old-printer'));
      assert.equal(api.data.price.status, 'unpriced');
      for (const [where, body] of Object.entries({ list, pageBody, home, api })) {
        assert.deepEqual(catalogLeaks(body), [], `${through} ${where}`);
      }
    }
  });
}

test(`a database before 0193: the price-request doors answer 503, never cached; the admin falls back`, async () => {
  const raw = seed(dbThrough(BEFORE_0193));
  const app = shop(raw, CUSTOMER);
  for (const res of [
    await post(app, '/api/price-requests', { product_id: 'p_old' }),
    await get(app, '/api/price-requests/mine'),
  ]) {
    assert.equal(res.status, 503);
    assert.equal((await json(res)).code, 'PRICE_REQUESTS_UNAVAILABLE');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  }
  // The customer surfaces never read 0193: they answer as on the migrated database.
  assert.equal((await get(app, '/api/products/old-printer')).status, 200);
  const admin = shop(raw, OWNER);
  const sorted = await json(await get(admin, '/api/admin/products-v2?sort=requests'));
  assert.ok((sorted.products as Array<Record<string, unknown>>).every((p) => p.price_requests === null));
  const requested = await json(await get(admin, '/api/admin/products-v2?requested=1'));
  assert.equal(requested.requests_unavailable, true);
  assert.equal(requested.total, 0);
});
