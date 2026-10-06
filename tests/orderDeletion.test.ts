import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import { failingD1 } from './fixtures/app';
import { planOrderFinanceSnapshot } from '../worker/lib/orderFinance';
import {
  deleteCancelledOrder,
  CANCELLED_ORDER_RETENTION_DAYS,
  OrderDeletionRefusal,
  sweepCancelledOrders,
  type OrderDeletionDb,
} from '../worker/lib/orderDeletion';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8'));
  }
  db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'owner@example.test')").run();
  return db;
}

function adapter(db: DatabaseSync): OrderDeletionDb {
  return new SqliteD1(db) as unknown as OrderDeletionDb;
}

function addOrder(db: DatabaseSync, id: string, status = 'pending', date = '2026-01-01T00:00:00.000Z'): void {
  db.prepare(
    `INSERT INTO orders
      (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, created_at, updated_at)
     VALUES (?, 'u1', ?, '{}', 'delivery', '{}', 'cod', 1000, 1500, 1000, 1000, ?, ?)`
  ).run(id, status, date, date);
  db.prepare(
    `INSERT INTO order_items (id, order_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES (?, ?, 'Test product', 1, 1000, 1000)`
  ).run(`${id}-item`, id);
}

test('permanent order deletion is limited to cancelled orders and removes owned rows', async () => {
  const db = database();
  addOrder(db, 'order-delete');
  await assert.rejects(
    () => deleteCancelledOrder(adapter(db), 'order-delete'),
    (error: unknown) => error instanceof OrderDeletionRefusal && error.code === 'ORDER_NOT_CANCELLED'
  );

  db.prepare("UPDATE orders SET status = 'cancelled', updated_at = '2026-01-02T00:00:00.000Z' WHERE id = 'order-delete'").run();
  db.prepare("INSERT INTO products (id, slug, name) VALUES ('p-ledger', 'p-ledger', 'Ledger product')").run();
  db.prepare(
    "INSERT INTO inventory_ledger (id, product_id, scope, kind, qty, idempotency_key, order_id) VALUES ('led-delete', 'p-ledger', 'base', 'release', 1, 'delete-test', 'order-delete')"
  ).run();
  db.prepare(
    "INSERT INTO order_status_history (id, order_id, stage, status, source, changed_at) VALUES ('hist-delete', 'order-delete', 'cancelled', 'cancelled', 'manual', '2026-01-02T00:00:00.000Z')"
  ).run();

  const result = await deleteCancelledOrder(adapter(db), 'order-delete');
  assert.equal(result.deleted, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'order-delete'").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = 'order-delete'").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = 'order-delete'").get()!.n, 0);
  assert.equal(db.prepare("SELECT order_id FROM inventory_ledger WHERE id = 'led-delete'").get()!.order_id, null);
});

test('a delivered or serialized cancelled order is never purged', async () => {
  const db = database();
  addOrder(db, 'order-device', 'cancelled');
  db.prepare("UPDATE orders SET delivered_at = '2026-01-02T00:00:00.000Z' WHERE id = 'order-device'").run();
  await assert.rejects(
    () => deleteCancelledOrder(adapter(db), 'order-device'),
    (error: unknown) => error instanceof OrderDeletionRefusal && error.code === 'ORDER_HAS_FULFILMENT_HISTORY'
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'order-device'").get()!.n, 1);
});

test('the retention sweep defaults to seven full days from cancellation, including the exact boundary', async () => {
  const db = database();
  addOrder(db, 'old-cancelled', 'cancelled', '2026-01-01T00:00:00.000Z');
  addOrder(db, 'recent-cancelled', 'cancelled', '2026-02-22T00:00:00.001Z');
  addOrder(db, 'boundary-cancelled', 'cancelled');
  addOrder(db, 'offset-cancelled', 'cancelled');
  addOrder(db, 'old-pending', 'pending', '2026-01-01T00:00:00.000Z');
  db.prepare("UPDATE orders SET cancelled_at = '2026-01-01T00:00:00.000Z' WHERE id = 'old-cancelled'").run();
  db.prepare("UPDATE orders SET cancelled_at = '2026-02-22T00:00:00.001Z' WHERE id = 'recent-cancelled'").run();
  db.prepare("UPDATE orders SET cancelled_at = '2026-02-22T00:00:00.000Z' WHERE id = 'boundary-cancelled'").run();
  db.prepare("UPDATE orders SET cancelled_at = '2026-02-22T03:00:00+03:00' WHERE id = 'offset-cancelled'").run();

  const report = await sweepCancelledOrders(adapter(db), '2026-03-01T00:00:00.000Z');
  assert.equal(CANCELLED_ORDER_RETENTION_DAYS, 7);
  assert.equal(report.retention_days, 7);
  assert.equal(report.deleted, 3, JSON.stringify(report));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'old-cancelled'").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'recent-cancelled'").get()!.n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'old-pending'").get()!.n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id IN ('boundary-cancelled','offset-cancelled')").get()!.n, 0);
});

test('the cancelled timestamp follows cancellation and reopening in every route', () => {
  const db = database();
  addOrder(db, 'order-clock');
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = 'order-clock'").run();
  assert.ok(db.prepare("SELECT cancelled_at FROM orders WHERE id = 'order-clock'").get()!.cancelled_at);
  db.prepare("UPDATE orders SET cancelled_at='2026-01-01T00:00:00.000Z' WHERE id='order-clock'").run();
  db.prepare("UPDATE orders SET status='cancelled',updated_at='2026-06-01T00:00:00.000Z' WHERE id='order-clock'").run();
  assert.equal(db.prepare("SELECT cancelled_at FROM orders WHERE id='order-clock'").get()!.cancelled_at, '2026-01-01T00:00:00.000Z');
  db.prepare("UPDATE orders SET status = 'pending' WHERE id = 'order-clock'").run();
  assert.equal(db.prepare("SELECT cancelled_at FROM orders WHERE id = 'order-clock'").get()!.cancelled_at, null);
  db.prepare("UPDATE orders SET status='cancelled' WHERE id='order-clock'").run();
  assert.notEqual(db.prepare("SELECT cancelled_at FROM orders WHERE id='order-clock'").get()!.cancelled_at, '2026-01-01T00:00:00.000Z');
});

test('checkout finance snapshots are removed with a cancelled order, with foreign keys both on and off', async () => {
  for (const foreignKeys of [true, false]) {
    const db = database();
    if (!foreignKeys) db.exec('PRAGMA foreign_keys=OFF');
    addOrder(db, 'checkout', 'cancelled');
    db.exec("INSERT INTO products(id,name,slug) VALUES ('p','Filament','purge-filament'); UPDATE order_items SET product_id='p' WHERE order_id='checkout'");
    const d1 = adapter(db);
    await d1.batch(await planOrderFinanceSnapshot(d1 as D1Database, 'checkout', [{ id: 'checkout-item', product_id: 'p' }], '2026-01-01T00:00:00.000Z'));
    db.exec("INSERT INTO finance_order_versions(order_id,version) VALUES ('checkout',0); INSERT INTO finance_staff_basis VALUES ('checkout','[]','2026-01-01')");
    assert.equal(db.prepare('SELECT COUNT(*) n FROM finance_line_departments').get()!.n, 1);
    assert.throws(() => db.exec('DELETE FROM finance_line_departments'), /snapshot immutable/);
    assert.throws(() => db.exec("UPDATE finance_line_departments SET main_name='changed'"), /snapshot immutable/);
    assert.equal((await deleteCancelledOrder(d1, 'checkout')).deleted, true);
    for (const table of ['orders','order_items','finance_order_snapshots','finance_line_departments','finance_order_versions','finance_staff_basis','ops_guards'])
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, table);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  }
});

test('reopening or cancelling again during deletion leaves the order and all children intact', async () => {
  for (const recancel of [false, true]) {
    const db = database(); addOrder(db, 'raced', 'cancelled');
    db.exec("UPDATE orders SET cancelled_at='2026-01-01T00:00:00.000Z' WHERE id='raced'");
    const wrapped = failingD1(db);
    wrapped.failing.beforeBatch = () => {
      db.exec("UPDATE orders SET status='pending' WHERE id='raced'");
      if (recancel) db.exec("UPDATE orders SET status='cancelled' WHERE id='raced'");
    };
    await assert.rejects(() => deleteCancelledOrder(wrapped.db, 'raced', { cutoff: '2026-03-01T00:00:00.000Z' }),
      (error: unknown) => error instanceof OrderDeletionRefusal && error.code === 'ORDER_CHANGED');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE id='raced'").get()!.n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM order_items WHERE order_id='raced'").get()!.n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ops_guards').get()!.n, 0);
  }
});

test('recorded or concurrently added financial evidence survives deletion with FK enforcement disabled', async () => {
  for (const concurrent of [false, true]) {
    const db = database(); db.exec('PRAGMA foreign_keys=OFF'); addOrder(db, 'money', 'cancelled');
    const collection = () => db.exec("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES ('receipt','money','customer',1000,'2026-01-01','u1','2026-01-01')");
    const wrapped = failingD1(db);
    if (concurrent) wrapped.failing.beforeBatch = collection; else collection();
    await assert.rejects(() => deleteCancelledOrder(wrapped.db, 'money'),
      (error: unknown) => error instanceof OrderDeletionRefusal && error.code === (concurrent ? 'ORDER_CHANGED' : 'ORDER_HAS_FINANCIAL_HISTORY'));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE id='money'").get()!.n, 1);
    assert.equal(db.prepare('SELECT amount_iqd FROM finance_collections').get()!.amount_iqd, 1000);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM order_items').get()!.n, 1);
  }
});

test('older protected records cannot starve later eligible cancellations from a bounded page', async () => {
  const db = database();
  for (let i = 0; i < 4; i++) {
    const id = `protected-${i}`; addOrder(db, id, 'cancelled');
    db.prepare("UPDATE orders SET cancelled_at='2026-01-01T00:00:00Z' WHERE id=?").run(id);
    db.prepare("INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at) VALUES (?,?,?,?)").run(`cogs:${id}`,id,'Unfinished financial posting','2026-01-01');
  }
  addOrder(db, 'eligible', 'cancelled');
  db.exec("UPDATE orders SET cancelled_at='2026-02-01T00:00:00Z' WHERE id='eligible'");
  const report = await sweepCancelledOrders(adapter(db), '2026-03-01T00:00:00Z', 7, 1);
  assert.equal(report.deleted, 1, JSON.stringify(report));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE id='eligible'").get()!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM finance_posting_errors').get()!.n, 4);
});

test('unrestored FIFO stock blocks deletion; balanced cancelled allocations are removed without moving lots', async () => {
  const db = database(); addOrder(db, 'stock', 'cancelled');
  db.exec(`INSERT INTO products(id,name,slug) VALUES ('p','Filament','purge-stock');
    INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('lot','p','base',2,1,500,'opening','2026-01-01');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES ('used','stock','stock-item','lot','base',1,500,500,'stock-used');`);
  await assert.rejects(() => deleteCancelledOrder(adapter(db), 'stock'),
    (error: unknown) => error instanceof OrderDeletionRefusal && error.code === 'ORDER_STOCK_PENDING');
  db.exec(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key,released_at)
    VALUES ('restored','stock','stock-item','lot','base',1,500,500,'stock-restored','2026-01-02'); UPDATE inventory_lots SET qty_remaining=2;`);
  assert.equal((await deleteCancelledOrder(adapter(db), 'stock')).deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_item_inventory_allocations').get()!.n, 0);
  assert.equal(db.prepare('SELECT qty_remaining FROM inventory_lots').get()!.qty_remaining, 2);
});

test('an unfinished refund retains the order; a settled wallet refund remains in the ledger after deletion', async () => {
  const db = database(); addOrder(db, 'wallet', 'cancelled');
  db.exec("UPDATE orders SET wallet_applied_usd_cents=100 WHERE id='wallet'");
  await assert.rejects(() => deleteCancelledOrder(adapter(db), 'wallet'),
    (error: unknown) => error instanceof OrderDeletionRefusal && error.code === 'ORDER_REFUND_PENDING');
  db.exec("INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref,created_by) VALUES ('wtx_refund_wallet_usd','u1','deposit','USD',100,'approved','wallet','system')");
  assert.equal((await deleteCancelledOrder(adapter(db), 'wallet')).deleted, true);
  assert.equal(db.prepare("SELECT amount FROM wallet_transactions WHERE id='wtx_refund_wallet_usd'").get()!.amount, 100);
});
