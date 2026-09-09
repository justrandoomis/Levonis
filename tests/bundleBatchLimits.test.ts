/**
 * THE WRITE BATCH HAS A WRITTEN CEILING — docs/BUNDLES_MYSTERY.md §3.1 and §14.
 *
 * This feature is the first thing in the tree that can multiply statements
 * without bound: `max_qty_per_order` reaches 99, so one line could ask a single
 * D1 batch for thousands of `order_items` rows and thousands of inventory
 * statements, and `planInventory` binds one placeholder per (move × target) in
 * its idempotency-key pre-read. D1 caps both bound parameters per query and
 * total request size, and the failure mode is an opaque driver error on the
 * money path.
 *
 * So the ceiling is a DOOR REFUSAL naming the limit, not a clamp:
 * `COMPOSITION_TOO_LARGE`. A clamp would quietly sell someone fewer bundles
 * than they asked for and charge them for what arrived.
 *
 * The two assertions here are the ones a limit needs: a MAXIMAL LEGAL order
 * still commits (so the limit is not theatre), and one line over it is refused
 * by name with nothing written (so the limit is real).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, stubApp, post, json, count, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { MAX_PHYSICAL_LINES } from '../worker/lib/bundleComposition';
import { addBundle, seedCatalogue, orderBody, type ComponentSpec } from './lib/bundles';
import type { DatabaseSync } from 'node:sqlite';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

/** `n` untracked ordinary products, so the size of the composition is the only
 *  thing under test — not the stock behind it. */
function manyMembers(raw: DatabaseSync, n: number): ComponentSpec[] {
  const out: ComponentSpec[] = [];
  for (let i = 0; i < n; i += 1) {
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                               selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
         VALUES (?,?,?,'قطعة','پارچە',1000,'active',NULL,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}')`
      )
      .run(`p_m${i}`, `member-${i}`, `Member ${i}`);
    out.push({ id: `bc_m${i}`, product: `p_m${i}`, qty: 1 });
  }
  return out;
}

test('a MAXIMAL legal order commits — the ceiling is not theatre', async () => {
  const raw = seedCatalogue();
  const components = manyMembers(raw, 24);
  addBundle(raw, {
    id: 'prd_big',
    slug: 'big',
    priceIqd: 20_000,
    config: { max_qty_per_order: 10 },
    components,
  });
  const db = asD1(raw);
  // 24 components × 10 bundles + the parent's own row = 241 rows: a real
  // order at the top of the range the ceiling allows.
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_big', qty: 10 }));
  assert.equal(added.success, true, JSON.stringify(added));

  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', res.order.id), 25);
  assert.equal(res.order.items.length, 1, 'the customer still sees ONE line');
  // Untracked members hold nothing, so the fence records an honest zero.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
});

test('one line over the ceiling is refused with COMPOSITION_TOO_LARGE, naming the limit, writing nothing', async () => {
  const raw = seedCatalogue();
  const components = manyMembers(raw, 26);
  addBundle(raw, {
    id: 'prd_big',
    slug: 'big',
    priceIqd: 20_000,
    config: { max_qty_per_order: 10 },
    components,
  });
  const db = asD1(raw);
  // 26 × 10 + 1 = 261 > 250. The ADD refuses it, so the customer meets the limit
  // at the first door rather than after filling a cart they cannot buy.
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_big', qty: 10 }));
  assert.equal(added.code, 'COMPOSITION_TOO_LARGE', JSON.stringify(added));
  assert.equal(added.details.limit, MAX_PHYSICAL_LINES);
  assert.equal(added.details.physical_lines, 261);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0);
});

test('the ceiling is judged across the WHOLE order, not one line at a time', async () => {
  const raw = seedCatalogue();
  const components = manyMembers(raw, 24);
  addBundle(raw, {
    id: 'prd_big',
    slug: 'big',
    priceIqd: 20_000,
    config: { max_qty_per_order: 9 },
    components: components.map((k) => ({ ...k, picksColor: false })),
  });
  // A second bundle over the same members: two legal lines that together
  // exceed what one batch may write.
  addBundle(raw, {
    id: 'prd_big2',
    slug: 'big2',
    priceIqd: 20_000,
    config: { max_qty_per_order: 9 },
    components: components.map((k) => ({ ...k, id: `${k.id}_b` })),
  });
  const db = asD1(raw);
  const app = appFor(db);
  assert.equal((await json(await post(app, '/api/cart/items', { productId: 'prd_big', qty: 6 }))).success, true);
  assert.equal((await json(await post(app, '/api/cart/items', { productId: 'prd_big2', qty: 6 }))).success, true);

  // 24×6 + 24×6 = 288 physical lines in one batch.
  const res = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(res.code, 'COMPOSITION_TOO_LARGE', JSON.stringify(res));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
});

test('a maximal TRACKED order stays inside D1’s bound-parameter budget', async () => {
  // Every member tracked, so `planInventory` really does bind one placeholder
  // per (move × target) in its pre-read and really does write two guarded
  // statements per target — the shape the parameter cap applies to.
  const raw = seedCatalogue();
  const components = manyMembers(raw, 20);
  raw.exec(`UPDATE products SET stock = 50 WHERE id LIKE 'p_m%'`);
  addBundle(raw, { id: 'prd_big', slug: 'big', priceIqd: 20_000, config: { max_qty_per_order: 10 }, components });
  const db = asD1(raw);
  assert.equal((await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_big', qty: 10 }))).success, true);

  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind='reserve'"), 20);
  assert.deepEqual(
    (await import('./fixtures/app')).row(
      raw,
      'SELECT expected, actual FROM order_reservation_fence WHERE order_id = ? AND kind = ?',
      res.order.id,
      'reserve'
    ),
    { expected: 20, actual: 20 }
  );
});
