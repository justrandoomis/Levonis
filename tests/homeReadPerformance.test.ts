import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, get, stubApp, type StubUser } from './fixtures/app';
import { seedLiveCatalog, LIVE_PRODUCTS } from './fixtures/liveCatalog';
import { wavesD1 } from './fixtures/wavesD1';
import { homeRoutes } from '../worker/routes/products';
import { loadRelationsViews, loadRelationsViewsForIds } from '../worker/lib/productOverlay';

test('graded home reference prices share the relations wave, with unchanged cards on overlapping shelves', async () => {
  const raw = freshDb();
  try {
    seedLiveCatalog(raw);
    raw.exec("INSERT INTO users (id, email, name, password_hash, role) VALUES ('reader', 'reader@example.com', 'Reader', 'x', 'customer')");
    const graded = LIVE_PRODUCTS[1];
    const reference = LIVE_PRODUCTS[3];
    raw.prepare('UPDATE products SET condition_doc = ? WHERE id = ?').run(
      JSON.stringify({ kind: 'open_box', grade: 'like_new', new_product_id: reference.id }), graded.id
    );
    raw.prepare(`INSERT INTO offer_windows (id, subject_type, subject_id, offer_price_mode, discount_percent, active)
      VALUES ('home-performance-offer', 'product', ?, 'discount_percent', 10, 1)`).run(graded.id);
    const { db, waves } = wavesD1(raw);
    type Card = { id: string; display_price_iqd: number; condition_reference?: { reference_iqd: number } };
    type Home = { open_box: Card[]; latest: Card[]; discounted: Card[] };
    const read = async (user: StubUser | null): Promise<Home> => {
      const response = await get(stubApp(db, user, (app) => app.route('/api/home', homeRoutes)), '/api/home');
      assert.equal(response.status, 200);
      return response.json() as Promise<Home>;
    };
    await read(null); // first isolate read primes only shared configuration
    for (const user of [null, { id: 'reader', role: 'customer', email: 'reader@example.com' } as const]) {
      waves.reset();
      const home = await read(user);
      assert.equal(waves.counts.waves, 2, waves.counts.sqls.join('\n'));
      const card = home.open_box.find((p) => p.id === graded.id)!;
      assert.ok(card?.condition_reference, 'the reference saving is still present');
      const { condition_reference: referencePrice, ...plain } = card;
      assert.equal(referencePrice.reference_iqd, reference.price_iqd);
      assert.deepEqual(home.latest.find((p) => p.id === graded.id), plain);
      assert.deepEqual(home.discounted.find((p) => p.id === graded.id), plain);
    }
  } finally {
    raw.close();
  }
});

test('known shelf ids load rows and relations in one wave while preserving every inventory mode', async () => {
  const raw = freshDb();
  try {
    seedLiveCatalog(raw);
    const rows = ['BASE', 'OPTION', 'COLOR', 'VARIANT_COMBINATION'].map((inventory_mode, i) => ({
      id: LIVE_PRODUCTS[i].id, inventory_mode,
    }));
    for (const row of rows) raw.prepare('UPDATE products SET inventory_mode = ? WHERE id = ?').run(row.inventory_mode, row.id);
    const { db, waves } = wavesD1(raw);
    const expected = await loadRelationsViews(db, rows);
    waves.reset();
    const ids = [...rows.map((row) => row.id), 'removed-product'];
    const rowsOf = db.prepare('SELECT id, inventory_mode FROM products WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids)).all<{ id: string; inventory_mode: string }>().then(({ results }) => results);
    const actual = await loadRelationsViewsForIds(db, ids, rowsOf);
    assert.equal(waves.counts.waves, 1, waves.counts.sqls.join('\n'));
    assert.equal(actual.has('removed-product'), false);
    assert.deepEqual(actual, expected);
    for (const row of rows) assert.equal(actual.get(row.id)?.inventory_mode, row.inventory_mode);
  } finally {
    raw.close();
  }
});
