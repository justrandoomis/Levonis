/**
 * «اكتمال المعلومات» — THE STAFF COLUMN AND CARD (the Bambu import spec §H.2;
 * worker/lib/knowledge/infoCompleteness.ts, worker/lib/knowledge/completeness.ts,
 * worker/routes/adminProducts.ts).
 *
 *   1. the list column: per product with knowledge rows, over the expected keys
 *      of its type (its source route), `not_applicable` excluded, missing
 *      (not_found + not_published), unknown and unverified apart; one GROUP BY
 *      statement for the page, sent beside the pictures (no new wave);
 *   2. the form card: the same counts and every applicable key that is not
 *      verified, by name, in three languages;
 *   3. separate from the commercial «ناقص» (`missing_count`), which it never
 *      changes;
 *   4. staff only (a customer is refused at the router), and no value, source
 *      or price in the answer;
 *   5. a database without 0194: null, never a failure.
 *
 * Run: node --import tsx --test tests/infoCompleteness.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { dbThrough, freshDb, get, stubApp, type StubUser } from './fixtures/app';
import { wavesD1 } from './fixtures/wavesD1';
import { seedLiveCatalog, P } from './fixtures/liveCatalog';
import { insertSpecValue, notFound, notPublished } from './fixtures/knowledgeModel';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { expectedKeys, specKey } from '../packages/catalog/src/bambuImport/registry/specKeys';
import { productTypeOf } from '../packages/catalog/src/bambuImport/registry/types';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ADMIN: StubUser = { id: 'adm', role: 'admin', email: 'a@x.co', admin_scope: 'full' };
const CUSTOMER: StubUser = { id: 'c1', role: 'customer', email: 'c1@x.co' };
/** A printer route of the reviewed manifest: route L1 = the printers node. */
const PRINTER_ROUTE = '552709755391528960>552709755550912512';
const SECRET_VALUE = 'info-completeness-secret-value';

function seed(raw: DatabaseSync): string[] {
  raw.exec(`
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, source_route, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', '1', '${P.H2D}', 'h2d', 'https://us.store.bambulab.com/products/h2d', '${PRINTER_ROUTE}', 'created', 'not_configured', 'f', '2026-10-15T00:00:00Z', 'cir_test');
  `);
  const keys = expectedKeys('printer').map((k) => k.key);
  assert.ok(keys.length >= 6, `${keys.length} expected printer keys`);
  const [a, b, c, d, e, f] = keys;
  insertSpecValue(raw, P.H2D, a, { value_text: SECRET_VALUE });
  insertSpecValue(raw, P.H2D, b, { value_text: '2', status: 'unverified' });
  insertSpecValue(raw, P.H2D, c, notFound([{ kind: 'store_page', url: 'https://us.store.bambulab.com/products/h2d', title: 'Store page' }]));
  insertSpecValue(raw, P.H2D, d, notPublished());
  insertSpecValue(raw, P.H2D, e, { status: 'not_applicable', missing_reason: 'not_applicable' });
  // The same key twice (two scopes): its best status counts once.
  insertSpecValue(raw, P.H2D, f, { status: 'unknown' });
  insertSpecValue(raw, P.H2D, f, { scope_kind: 'option_value', scope_id: 'v_any', value_text: '5', status: 'verified' });
  // A key no type expects never counts.
  insertSpecValue(raw, P.H2D, 'x.chamber-fan', { value_text: 'Yes' });
  return keys;
}

function world(through: string | null = null) {
  const raw = through ? dbThrough(through) : freshDb();
  seedLiveCatalog(raw);
  const keys = through ? [] : seed(raw);
  const { waves, db } = wavesD1(raw);
  const app = (user: StubUser | null = ADMIN) => stubApp(db, user, (x) => x.route('/api/admin/products-v2', adminProductsRoutes), { env: { INITIAL_ADMIN_EMAIL: 'a@x.co' } });
  return { raw, db, waves, app, keys };
}

async function read(w: ReturnType<typeof world>, path: string, user: StubUser | null = ADMIN): Promise<{ status: number; body: Body; text: string }> {
  const res = await get(w.app(user), path);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Body, text };
}

test('the type comes from the source route', () => {
  assert.equal(productTypeOf(PRINTER_ROUTE), 'printer');
});

test('the list column: counts over the printer’s expected keys, not_applicable out, the rest apart', async () => {
  const w = world();
  const { status, body } = await read(w, '/api/admin/products-v2?limit=50');
  assert.equal(status, 200, JSON.stringify(body));
  const h2d = body.products.find((p: Body) => p.id === P.H2D);
  const expected = w.keys.length;
  // a verified, b unverified, c not_found, d not_published, e not_applicable, f verified (best of two), the rest no row.
  assert.deepEqual(h2d.info_completeness, {
    ratio: Math.round((3 / (expected - 1)) * 1000) / 1000,
    applicable: expected - 1,
    verified: 2,
    unverified: 1,
    missing: 2,
    unknown: expected - 6,
  });
  // Every other product has no knowledge row: no column value, and the commercial «ناقص» is untouched.
  for (const p of body.products.filter((x: Body) => x.id !== P.H2D)) assert.equal(p.info_completeness, null, p.id);
  assert.ok('missing_count' in h2d, 'the commercial completeness is still its own field');
});

test('one GROUP BY statement for the page, in the pictures’ wave', async () => {
  const w = world();
  await read(w, '/api/admin/products-v2?limit=50'); // warm the isolate's memos
  w.waves.reset();
  await read(w, '/api/admin/products-v2?limit=50');
  const sqls = w.waves.counts.sqls;
  const mine = sqls.filter((q) => q.startsWith('SELECT v.product_id, v.canonical_key, v.status, COUNT(*)'));
  assert.equal(mine.length, 1, sqls.join('\n'));
  const before = world();
  // The same list with the column read away: the wave count must not change.
  before.raw.exec('DELETE FROM product_spec_values');
  await read(before, '/api/admin/products-v2?limit=50');
  before.waves.reset();
  await read(before, '/api/admin/products-v2?limit=50');
  assert.equal(w.waves.counts.waves, before.waves.counts.waves, 'the column rides an existing wave');
});

test('the form card: the same counts and every applicable key that is not verified, by name', async () => {
  const w = world();
  const { status, body, text } = await read(w, `/api/admin/products-v2/${P.H2D}/info-completeness`);
  assert.equal(status, 200, text);
  const card = body.info_completeness;
  assert.equal(card.type, 'printer');
  assert.equal(card.not_found, 1);
  assert.equal(card.not_published, 1);
  const [, b, c, d, e, f] = w.keys;
  const gapKeys = card.gaps.map((g: Body) => g.key);
  assert.ok(gapKeys.includes(b) && gapKeys.includes(c) && gapKeys.includes(d), gapKeys.join(','));
  assert.ok(!gapKeys.includes(e), 'not applicable is no gap');
  assert.ok(!gapKeys.includes(f), 'a key verified in any scope is stated');
  assert.equal(card.gaps.length, card.unverified + card.missing + card.unknown);
  for (const g of card.gaps) {
    assert.deepEqual(g.label, specKey(g.key)!.labels);
    assert.ok(g.label.ar && g.label.en && g.label.ckb && g.label.ckb !== g.label.ar, g.key);
  }
  assert.ok(!text.includes(SECRET_VALUE) && !text.includes('us.store.bambulab.com'), 'no value and no source in the answer');
  // A product with no knowledge row: null.
  const none = await read(w, `/api/admin/products-v2/${P.X2D}/info-completeness`);
  assert.equal(none.status, 200);
  assert.equal(none.body.info_completeness, null);
  const missing = await read(w, '/api/admin/products-v2/prd_nope/info-completeness');
  assert.equal(missing.status, 404);
});

test('staff only: a customer and a guest are refused at the router', async () => {
  const w = world();
  assert.notEqual((await read(w, `/api/admin/products-v2/${P.H2D}/info-completeness`, CUSTOMER)).status, 200);
  assert.notEqual((await read(w, `/api/admin/products-v2/${P.H2D}/info-completeness`, null)).status, 200);
});

test('a database without 0194: the list reads null in the column and the card is null — never a 500', async () => {
  const w = world('0193');
  const list = await read(w, '/api/admin/products-v2?limit=50');
  assert.equal(list.status, 200, list.text);
  assert.ok(list.body.products.length > 0);
  for (const p of list.body.products) assert.equal(p.info_completeness, null);
  const card = await read(w, `/api/admin/products-v2/${P.H2D}/info-completeness`);
  assert.equal(card.status, 200, card.text);
  assert.equal(card.body.info_completeness, null);
});
