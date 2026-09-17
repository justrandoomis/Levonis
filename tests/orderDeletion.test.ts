import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import {
  deleteCancelledOrder,
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'order-delete'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = 'order-delete'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = 'order-delete'").get().n, 0);
  assert.equal(db.prepare("SELECT order_id FROM inventory_ledger WHERE id = 'led-delete'").get().order_id, null);
});

test('a delivered or serialized cancelled order is never purged', async () => {
  const db = database();
  addOrder(db, 'order-device', 'cancelled');
  db.prepare("UPDATE orders SET delivered_at = '2026-01-02T00:00:00.000Z' WHERE id = 'order-device'").run();
  await assert.rejects(
    () => deleteCancelledOrder(adapter(db), 'order-device'),
    (error: unknown) => error instanceof OrderDeletionRefusal && error.code === 'ORDER_HAS_FULFILMENT_HISTORY'
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'order-device'").get().n, 1);
});

test('the retention sweep deletes only cancelled orders older than 30 days', async () => {
  const db = database();
  addOrder(db, 'old-cancelled', 'cancelled', '2026-01-01T00:00:00.000Z');
  addOrder(db, 'recent-cancelled', 'cancelled', '2026-02-20T00:00:00.000Z');
  addOrder(db, 'old-pending', 'pending', '2026-01-01T00:00:00.000Z');
  db.prepare("UPDATE orders SET cancelled_at = '2026-01-01T00:00:00.000Z' WHERE id = 'old-cancelled'").run();
  db.prepare("UPDATE orders SET cancelled_at = '2026-02-20T00:00:00.000Z' WHERE id = 'recent-cancelled'").run();

  const report = await sweepCancelledOrders(adapter(db), '2026-03-01T00:00:00.000Z', 30, 20);
  assert.equal(report.deleted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'old-cancelled'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'recent-cancelled'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'old-pending'").get().n, 1);
});

test('the cancelled timestamp follows cancellation and reopening in every route', () => {
  const db = database();
  addOrder(db, 'order-clock');
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = 'order-clock'").run();
  assert.ok(db.prepare("SELECT cancelled_at FROM orders WHERE id = 'order-clock'").get().cancelled_at);
  db.prepare("UPDATE orders SET status = 'pending' WHERE id = 'order-clock'").run();
  assert.equal(db.prepare("SELECT cancelled_at FROM orders WHERE id = 'order-clock'").get().cancelled_at, null);
});
