/**
 * THE RESERVATION FENCE — case 2 of the owner's seventeen ("atomic reservation;
 * any component failing fails the whole operation safely"),
 * docs/BUNDLES_MYSTERY.md §3.3.
 *
 * THE HOLE IT CLOSES. `planInventory` writes a guarded INSERT and a guarded
 * UPDATE per target. A guard that stops holding BETWEEN the plan-time read and
 * the commit makes both statements match zero rows — WITHOUT failing the batch.
 * D1 does not error on a zero-row UPDATE. So the order committed with a line
 * unreserved, and the same hole existed on release, restore and deduct: a
 * cancellation whose release matched nothing left the customer refunded and the
 * units held for ever, invisible to every screen. `assertMovesApplied` was
 * written for exactly this and had zero callers.
 *
 * The fence counts the ledger rows the batch actually wrote and compares them
 * against the rows the plan promised, INSIDE the same transaction. A shortfall
 * fires `CHECK (actual = expected)` and the whole batch rolls back — order,
 * wallet spend, points, and every other reservation with it.
 *
 * This is a fix for EVERY order, not only bundles, and it is why slice 1 ships
 * before anything is composed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, json, count, row, all, spendable, ctx } from './fixtures/app';
import { orderRoutes } from '../worker/routes/orders';
import { assertMovesApplied, planInventory, planReservationFence, type StockMove } from '../worker/lib/inventory';
import { deductOrderStock, planOrderReturn, returnOrderStock } from '../worker/lib/orderInventory';

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default)
      VALUES ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status)
      VALUES ('dep_b','buyer','deposit','USD',100000,'approved');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_pla','pla','PLA Basic','PLA',25000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]'),
             ('p_untracked','cable','Cable','كيبل',5000,'active',NULL,'[]','[]','direct_sale','["direct_sale"]','[]','[]');
  `);
}

const cartLine = (raw: DatabaseSync, id: string, productId: string, qty: number) =>
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES (?,'buyer',?,'','[]','','','','',?)`
    )
    .run(id, productId, qty);

const buyerApp = (db: D1Database) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => {
    a.route('/api/orders', orderRoutes);
  });

let seq = 0;
const orderBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `fence-reservation-key-${++seq}`,
  ...over,
});

const fence = (raw: DatabaseSync, orderId: string, kind: string) =>
  row<{ expected: number; actual: number }>(
    raw,
    'SELECT expected, actual FROM order_reservation_fence WHERE order_id = ? AND kind = ?',
    orderId,
    kind
  );

// ---------------------------------------------------------------- it passes

test('checkout writes ONE fence row for the reservation, and it balances', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci1', 'p_pla', 2);
  const db = asD1(raw);
  const res = await json(await post(buyerApp(db), '/api/orders', orderBody()));
  assert.equal(res.success, true);
  const orderId = res.order.id as string;

  const f = fence(raw, orderId, 'reserve')!;
  assert.deepEqual(f, { expected: 1, actual: 1 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind='reserve'", orderId), 1);
  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_pla'), {
    stock: 5,
    stock_reserved: 2,
  });
});

test('an order that reserves nothing still fences, at expected = 0', async () => {
  // A pre-order line, or an untracked product: there is nothing to hold, and
  // "nothing was held" is a fact worth recording rather than a gap.
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci1', 'p_untracked', 1);
  const db = asD1(raw);
  const res = await json(await post(buyerApp(db), '/api/orders', orderBody()));
  assert.equal(res.success, true);
  assert.deepEqual(fence(raw, res.order.id, 'reserve'), { expected: 0, actual: 0 });
});

test('confirmation, cancellation and return each fence their own kind', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci1', 'p_pla', 2);
  const db = asD1(raw);
  const orderId = (await json(await post(buyerApp(db), '/api/orders', orderBody()))).order.id as string;

  await deductOrderStock(db, orderId, null);
  assert.deepEqual(fence(raw, orderId, 'deduct'), { expected: 1, actual: 1 });

  const back = await returnOrderStock(db, orderId, null);
  assert.equal(back.kind, 'restore', 'the units had been deducted, so they come back');
  assert.deepEqual(fence(raw, orderId, 'restore'), { expected: 1, actual: 1 });
  // Four kinds, four independent rows — the key is (order_id, kind).
  assert.deepEqual(
    all<{ kind: string }>(raw, 'SELECT kind FROM order_reservation_fence WHERE order_id = ? ORDER BY kind', orderId).map((r) => r.kind),
    ['deduct', 'reserve', 'restore']
  );
});

test('a cancellation BEFORE confirmation fences the release', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci1', 'p_pla', 2);
  const db = asD1(raw);
  const orderId = (await json(await post(buyerApp(db), '/api/orders', orderBody()))).order.id as string;

  const res = await json(await post(buyerApp(db), `/api/orders/${orderId}/cancel`));
  assert.equal(res.success, true);
  assert.deepEqual(fence(raw, orderId, 'release'), { expected: 1, actual: 1 });
  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_pla'), { stock: 5, stock_reserved: 0 });
});

test('the fence is idempotent under replay: the same operation twice rewrites one row', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci1', 'p_pla', 2);
  const db = asD1(raw);
  const orderId = (await json(await post(buyerApp(db), '/api/orders', orderBody()))).order.id as string;

  await deductOrderStock(db, orderId, null);
  await deductOrderStock(db, orderId, null); // a double-clicked confirmation
  await deductOrderStock(db, orderId, null); // a replayed webhook
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM order_reservation_fence WHERE order_id = ? AND kind='deduct'", orderId), 1);
  assert.deepEqual(fence(raw, orderId, 'deduct'), { expected: 1, actual: 1 });
  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_pla'), { stock: 3, stock_reserved: 0 });
});

// -------------------------------------------------------------- it catches

test('a reservation whose guard stops holding between plan and commit takes the WHOLE order down', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci1', 'p_pla', 2);
  const { failing, db } = failingD1(raw);

  const before = spendable(raw, 'buyer');
  // The concurrent writer: between `planInventory`'s pre-check (which saw 5
  // free) and the commit, someone else takes every unit.
  let fired = false;
  failing.beforeBatch = (stmts) => {
    if (fired || !stmts.some((s) => /INSERT INTO orders/i.test(s.sql))) return;
    fired = true;
    raw.prepare("UPDATE products SET stock_reserved = 5 WHERE id = 'p_pla'").run();
  };

  const res = await post(buyerApp(db), '/api/orders', orderBody({ useWallet: true }));
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.code, 'CONFLICT_RETRY', 'the existing CHECK → CONFLICT_RETRY mapping needs no new branch');

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0, 'no order');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items'), 0, 'no items');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0, 'no ledger row claiming a movement that never happened');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_reservation_fence'), 0, 'not even the fence itself');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 1, 'the cart is intact');
  assert.equal(spendable(raw, 'buyer'), before, 'the wallet was never touched');
});

test('a RELEASE whose guard stops holding rolls the refund back with it', async () => {
  // The worse half of the same hole: the customer is refunded and the units
  // stay held for ever, and `orderCancelOps`' own fence only ever proved that
  // the STATUS FLIP landed.
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci1', 'p_pla', 2);
  const plain = asD1(raw);
  const orderId = (await json(await post(buyerApp(plain), '/api/orders', orderBody({ useWallet: true })))).order.id as string;
  const heldBalance = spendable(raw, 'buyer');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind='reserve'"), 1);

  const { failing, db } = failingD1(raw);
  let fired = false;
  failing.beforeBatch = (stmts) => {
    if (fired || !stmts.some((s) => /UPDATE orders SET status = 'cancelled'/i.test(s.sql))) return;
    fired = true;
    // Someone else releases the hold first; this batch's guarded release now
    // matches zero rows.
    raw.prepare("UPDATE products SET stock_reserved = 0 WHERE id = 'p_pla'").run();
  };

  const res = await post(buyerApp(db), `/api/orders/${orderId}/cancel`);
  assert.notEqual(res.status, 200);
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM orders WHERE id = ?', orderId)!.status, 'pending', 'still cancellable');
  assert.equal(spendable(raw, 'buyer'), heldBalance, 'the money did NOT go back while the stock movement failed');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind='release'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM order_reservation_fence WHERE kind='release'"), 0);
});

// ------------------------------------------------------- the summed pre-check

test('two moves against ONE stock row are judged on their SUM, at plan time', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                           subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
       VALUES ('ORD-SUM','buyer','{}','standard','{}','cash',0,1400,0,0)`
    )
    .run();
  raw.prepare("UPDATE products SET stock = 3 WHERE id = 'p_pla'").run();

  const target = { scope: 'base' as const, scope_id: '', stock: 3, reserved: 0, low_stock_threshold: null, label: 'base' };
  const moves: StockMove[] = [
    { product_id: 'p_pla', qty: 2, line_id: 'oi_1', targets: [target] },
    { product_id: 'p_pla', qty: 2, line_id: 'oi_2', targets: [target] },
  ];
  const plan = await planInventory(db, moves, { kind: 'reserve', operationId: 'ORD-SUM', orderId: 'ORD-SUM', reason: 'checkout' });

  // Judged independently, both moves pass (3 - 0 >= 2) and the guards then fail
  // at commit: a permanent, deterministic CONFLICT_RETRY on a cart nobody is
  // racing, with no screen able to say why. Summed, the second is REJECTED at
  // plan time and the friendly refusal fires.
  assert.equal(plan.rejected.length, 1);
  assert.deepEqual(plan.rejected[0], { line_id: 'oi_2', scope: 'base', scope_id: '', reason: 'INSUFFICIENT_STOCK' });
  assert.equal(plan.plannedLedgerRows, 1);

  // And what the plan DOES promise, the fence expects.
  const stmt = await planReservationFence(db, 'ORD-SUM', 'reserve', plan.plannedLedgerRows);
  await db.batch([...plan.statements, stmt]);
  assert.deepEqual(fence(raw, 'ORD-SUM', 'reserve'), { expected: 1, actual: 1 });
});

test('the same row reached through two different lines still reserves twice when it fits', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                           subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
       VALUES ('ORD-FIT','buyer','{}','standard','{}','cash',0,1400,0,0)`
    )
    .run();
  const target = { scope: 'base' as const, scope_id: '', stock: 5, reserved: 0, low_stock_threshold: null, label: 'base' };
  const plan = await planInventory(
    db,
    [
      { product_id: 'p_pla', qty: 2, line_id: 'oi_1', targets: [target] },
      { product_id: 'p_pla', qty: 3, line_id: 'oi_2', targets: [target] },
    ],
    { kind: 'reserve', operationId: 'ORD-FIT', orderId: 'ORD-FIT', reason: 'checkout' }
  );
  assert.deepEqual(plan.rejected, []);
  assert.equal(plan.plannedLedgerRows, 2, 'two lines, two ledger rows — the per-order_item trail returns depend on');
  await db.batch([...plan.statements, await planReservationFence(db, 'ORD-FIT', 'reserve', plan.plannedLedgerRows)]);
  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_pla'), { stock: 5, stock_reserved: 5 });
  assert.deepEqual(fence(raw, 'ORD-FIT', 'reserve'), { expected: 2, actual: 2 });
});

test('a plan whose promise is short of the ledger it writes cannot commit', async () => {
  // The fence read directly: claim two rows, write one.
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                           subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
       VALUES ('ORD-LIE','buyer','{}','standard','{}','cash',0,1400,0,0)`
    )
    .run();
  const target = { scope: 'base' as const, scope_id: '', stock: 5, reserved: 0, low_stock_threshold: null, label: 'base' };
  const plan = await planInventory(db, [{ product_id: 'p_pla', qty: 1, line_id: 'oi_1', targets: [target] }], {
    kind: 'reserve',
    operationId: 'ORD-LIE',
    orderId: 'ORD-LIE',
    reason: 'checkout',
  });
  const lying = await planReservationFence(db, 'ORD-LIE', 'reserve', 2);
  await assert.rejects(() => db.batch([...plan.statements, lying]), /CHECK/);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_pla'), { stock: 5, stock_reserved: 0 });
});

test('assertMovesApplied re-reads what the batch claims to have moved', async () => {
  // The fence is the production guarantee inside a transaction; this is the
  // post-commit assertion the admin stock screen and these tests use, and it
  // had no callers at all before this slice.
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci1', 'p_pla', 2);
  const db = asD1(raw);
  const orderId = (await json(await post(buyerApp(db), '/api/orders', orderBody()))).order.id as string;
  const target = { scope: 'base' as const, scope_id: '', stock: 0, reserved: 0, low_stock_threshold: null, label: 'base' };
  const moves: StockMove[] = [{ product_id: 'p_pla', qty: 2, line_id: 'oi_1', targets: [target] }];
  assert.deepEqual(await assertMovesApplied(db, moves), { ok: true, short: [] });

  // A row that has gone negative, or vanished, is NAMED rather than assumed away.
  raw.prepare("UPDATE products SET stock = 0, stock_reserved = 4 WHERE id = 'p_pla'").run();
  const bad = await assertMovesApplied(db, moves);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.short, ['base:p_pla:negative']);
  void orderId;
});

test('planOrderReturn hands its caller the fence inside the same plan', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci1', 'p_pla', 1);
  const db = asD1(raw);
  const orderId = (await json(await post(buyerApp(db), '/api/orders', orderBody()))).order.id as string;
  const planned = await planOrderReturn(db, orderId, null);
  assert.equal(planned.kind, 'release');
  assert.ok(
    planned.plan!.statements.some((s) => /order_reservation_fence/i.test((s as unknown as { sql: string }).sql ?? '')),
    'the fence rides in the plan, so every caller inherits it'
  );
});

void ctx;
