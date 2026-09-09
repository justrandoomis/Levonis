/**
 * THE CHECKOUT KEY IS UNIQUE PER USER, NOT GLOBALLY (owner decision 11).
 *
 * THE DEFECT THIS PINS. `orders.idempotency_key` was declared globally UNIQUE
 * in 0001_init.sql while BOTH replay lookups read it `WHERE idempotency_key = ?
 * AND user_id = ?`. The key is minted by the browser (`newIdempotencyKey`,
 * src/lib/api.ts) and travels in the request body, so it is attacker-chosen
 * input landing in a globally-unique column: spend a predictable key first and
 * the next account to use it has its INSERT refused, its per-user replay lookup
 * find nothing, and its request fall out of the bottom of the catch as a
 * generic "Order could not be placed. Please try again." — for ever.
 *
 * Migration 0064 moves the key to `client_idempotency_key` under a PARTIAL
 * UNIQUE index on (user_id, client_idempotency_key). These tests assert the
 * guarantee in the owner's own words — "a key used by User A must never block
 * or resolve an order for User B" — from BOTH directions, because a fix that
 * merely stopped the collision while letting user B replay user A's ORDER would
 * be far worse than the bug.
 *
 * They run through the real routers, the real batch and every real migration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, failingD1, stubApp, post, json, row, all, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { seedCatalogue, orderBody } from './lib/bundles';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const other: StubUser = { id: 'u_plus', role: 'customer', email: 'z@x.co' };

const appFor = (db: unknown, user: StubUser) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

/** One plain product in this user's cart — no bundle, no mystery. */
async function cartOne(db: unknown, user: StubUser) {
  const res = await json(await post(appFor(db, user), '/api/cart/items', { productId: 'p_nozzle', qty: 1 }));
  assert.equal(res.success, true, `add-to-cart failed: ${JSON.stringify(res)}`);
}

const bodyFor = (user: StubUser, key: string) =>
  orderBody({ addressId: user.id === 'buyer' ? 'addr_b' : 'addr_p', idempotencyKey: key });

// ---------------------------------------------------------------- the rule

test('two different users can check out with the SAME key, and each gets their own order', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const KEY = 'shared-checkout-key-0001';

  await cartOne(db, buyer);
  const first = await json(await post(appFor(db, buyer), '/api/orders', bodyFor(buyer, KEY)));
  assert.equal(first.success, true, JSON.stringify(first));
  assert.notEqual(first.replay, true, 'the first checkout is not a replay');

  await cartOne(db, other);
  const second = await json(await post(appFor(db, other), '/api/orders', bodyFor(other, KEY)));
  assert.equal(second.success, true, `the second user was blocked by the first user's key: ${JSON.stringify(second)}`);
  assert.notEqual(second.replay, true, "the second user must get a NEW order, never a replay of someone else's");

  assert.notEqual(first.order.id, second.order.id, 'two distinct orders');
  const owners = all<{ id: string; user_id: string; client_idempotency_key: string }>(
    raw,
    'SELECT id, user_id, client_idempotency_key FROM orders WHERE client_idempotency_key = ? ORDER BY user_id',
    KEY
  );
  assert.deepEqual(
    owners.map((o) => o.user_id),
    ['buyer', 'u_plus'],
    'one row per user under the same key'
  );
  // Each order belongs to the account that placed it.
  assert.equal(owners.find((o) => o.user_id === 'buyer')!.id, first.order.id);
  assert.equal(owners.find((o) => o.user_id === 'u_plus')!.id, second.order.id);
});

test("a user's own retry with the same key still replays their own order — it does not create a second one", async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const KEY = 'same-user-retry-key-0002';

  await cartOne(db, buyer);
  const first = await json(await post(appFor(db, buyer), '/api/orders', bodyFor(buyer, KEY)));
  assert.equal(first.success, true, JSON.stringify(first));

  // The cart is empty now, so this retry can only succeed via the replay path.
  const retry = await json(await post(appFor(db, buyer), '/api/orders', bodyFor(buyer, KEY)));
  assert.equal(retry.success, true, JSON.stringify(retry));
  assert.equal(retry.replay, true, 'the same user, the same key: a replay');
  assert.equal(retry.order.id, first.order.id, 'the SAME order comes back');
  assert.equal(
    Number(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM orders WHERE user_id = ?', 'buyer')!.n),
    1,
    'a retry never writes a second order'
  );
});

test('the pre-check is scoped too: user B is never handed user A’s order before the batch runs', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const KEY = 'precheck-scope-key-0003';

  await cartOne(db, buyer);
  const mine = await json(await post(appFor(db, buyer), '/api/orders', bodyFor(buyer, KEY)));
  assert.equal(mine.success, true);

  // user B posts the same key with an EMPTY cart. If the pre-check leaked
  // across users it would answer 200 with the other person's order; scoped, it
  // falls through to the ordinary empty-cart refusal.
  const leak = await json(await post(appFor(db, other), '/api/orders', bodyFor(other, KEY)));
  assert.notEqual(
    leak.order?.id,
    mine.order.id,
    "the pre-check handed one customer another customer's order"
  );
  assert.equal(leak.success, false, `an empty cart must refuse, got: ${JSON.stringify(leak)}`);
});

// ------------------------------------------------------------- the collision

test('a concurrent same-user double-tap collides on the index and replays, it does not fail', async () => {
  const raw = seedCatalogue();
  const { failing, db } = failingD1(raw);
  const KEY = 'double-tap-key-0004';

  await cartOne(db, buyer);

  // Simulate the second tap landing between the first request's pre-check and
  // its commit: the hook writes the row the first request is about to write,
  // so the real batch hits the per-user UNIQUE index for real.
  let fired = false;
  failing.beforeBatch = (stmts) => {
    if (fired || !stmts.some((s) => s.sql.includes('INSERT INTO orders'))) return;
    fired = true;
    raw
      .prepare(
        `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
                             payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,client_idempotency_key)
         VALUES ('ORD-RACER','buyer','pending','{}','standard','{}','cash',5000,1500,5000,5000,?)`
      )
      .run(KEY);
  };

  const res = await json(await post(appFor(db, buyer), '/api/orders', bodyFor(buyer, KEY)));
  failing.beforeBatch = null;
  assert.equal(fired, true, 'the racing row was planted');
  assert.equal(res.success, true, `the double tap should replay, not fail: ${JSON.stringify(res)}`);
  assert.equal(res.replay, true);
  assert.equal(res.order.id, 'ORD-RACER', 'the order that actually committed is the one returned');
});

test('a concurrent stock loss is still CONFLICT_RETRY, not mistaken for key reuse', async () => {
  const raw = seedCatalogue();
  const { failing, db } = failingD1(raw);

  await cartOne(db, buyer);

  // `inventory_ledger.idempotency_key` is globally UNIQUE and rides in the very
  // same batch. Before the catch was narrowed to the ORDERS key, its message
  // ("UNIQUE constraint failed: inventory_ledger.idempotency_key") matched the
  // replay branch, which then found no order and — after this change — would
  // have reported a stock race as IDEMPOTENCY_KEY_REUSED.
  // A concurrent writer takes the stock between the plan and the commit: the
  // reservation fence's CHECK (actual = expected) rolls the whole batch back.
  failing.beforeBatch = (stmts) => {
    if (!stmts.some((s) => s.sql.includes('INSERT INTO orders'))) return;
    failing.beforeBatch = null;
    raw.exec("UPDATE products SET stock_reserved = stock WHERE id = 'p_nozzle'");
  };

  const res = await json(await post(appFor(db, buyer), '/api/orders', bodyFor(buyer, 'stock-race-key-0005')));
  assert.notEqual(res.code, 'IDEMPOTENCY_KEY_REUSED', 'a stock race is not key reuse');
  assert.equal(res.success, false, `the stock race must refuse: ${JSON.stringify(res)}`);
});

// --------------------------------------------------------------- the schema

test('the per-user index exists, is partial, and lets the legacy column keep its history', () => {
  const raw: DatabaseSync = seedCatalogue();
  const idx = row<{ sql: string }>(
    raw,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_user_idempotency'"
  );
  assert.ok(idx, 'migration 0064 did not create the per-user index');
  assert.match(idx!.sql, /user_id/, 'the index is not scoped by user');
  assert.match(idx!.sql, /client_idempotency_key/);
  assert.match(idx!.sql, /WHERE\s+client_idempotency_key\s*<>\s*''/, 'the index must be PARTIAL, or every pre-0064 row collides');

  // The legacy column and its global UNIQUE are untouched: rows written before
  // the migration keep their key and stay replayable.
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
                           payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,idempotency_key)
       VALUES ('ORD-LEGACY','buyer','pending','{}','standard','{}','cash',1,1500,1,1,'legacy-key')`
    )
    .run();
  const legacy = row<{ client_idempotency_key: string; idempotency_key: string }>(
    raw,
    'SELECT client_idempotency_key, idempotency_key FROM orders WHERE id = ?',
    'ORD-LEGACY'
  )!;
  assert.equal(legacy.idempotency_key, 'legacy-key');
  assert.equal(legacy.client_idempotency_key, '', 'the new column backfills to empty, never to the legacy key');
});

test('a pre-0064 order still replays for its own owner after the deploy', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  // An order written by the OLD code: the key is in the legacy column only.
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
                           payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,idempotency_key)
       VALUES ('ORD-INFLIGHT','buyer','pending','{}','standard','{}','cash',5000,1500,5000,5000,'in-flight-key')`
    )
    .run();

  const res = await json(await post(appFor(db, buyer), '/api/orders', bodyFor(buyer, 'in-flight-key')));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.order.id, 'ORD-INFLIGHT', 'a retry that crossed the deploy replays its own pre-migration order');
});
