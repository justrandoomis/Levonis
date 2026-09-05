/**
 * A coupon's limits are enforced by the database, not by a count read a
 * moment earlier.
 *
 * validateCoupon counted redemptions and checkout inserted the row later, with
 * uniqueness only on the ORDER id. Two checkouts fired together by one
 * customer both counted zero and both redeemed a single-use coupon. Migration
 * 0049 puts the two limits in a BEFORE INSERT trigger on coupon_redemptions,
 * so the second insert fails inside the same transaction as its order and
 * neither persists — whoever wrote the statement.
 *
 * Real schema, real trigger: node:sqlite over the migration files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1, createTableSql } from './fixtures/d1';

function freshDb(): { db: SqliteD1; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)');
  raw.exec(createTableSql('0001_init.sql', 'orders'));
  raw.exec(createTableSql('0002_products_memberships.sql', 'coupons'));
  raw.exec(createTableSql('0002_products_memberships.sql', 'coupon_redemptions'));
  // The whole migration, as D1 will run it: column, index and trigger together.
  raw.exec(readFileSync(join(ROOT, 'migrations', '0049_security_hardening.sql'), 'utf8'));
  for (const u of ['u1', 'u2', 'u3']) raw.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(u, `${u}@x.com`);
  return { db: new SqliteD1(raw), raw };
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function coupon(raw: DatabaseSync, id: string, perUser: number, global: number | null) {
  raw
    .prepare(
      `INSERT INTO coupons (id, code, kind, value, max_per_user, max_global) VALUES (?, ?, 'fixed_iqd', 1000, ?, ?)`
    )
    .run(id, id.toUpperCase(), perUser, global);
}

function order(raw: DatabaseSync, id: string, user: string) {
  raw
    .prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, created_at, updated_at)
       VALUES (?, ?, 'pending', '{}', 'standard', '{}', 'cash', 10000, 0, 1400, 10000, 10000, ${NOW}, ${NOW})`
    )
    .run(id, user);
}

const redeem = (raw: DatabaseSync, id: string, couponId: string, user: string, orderId: string) =>
  raw
    .prepare(
      `INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES (?, ?, ?, ?, 1000)`
    )
    .run(id, couponId, user, orderId);

// ------------------------------------------------------------- per user

test('the per-user limit holds at the database: a second redemption by the same user is refused', () => {
  const { raw } = freshDb();
  coupon(raw, 'once', 1, null);
  order(raw, 'o1', 'u1');
  order(raw, 'o2', 'u1');
  redeem(raw, 'r1', 'once', 'u1', 'o1');
  assert.throws(() => redeem(raw, 'r2', 'once', 'u1', 'o2'), /COUPON_PER_USER_LIMIT/);
  // Another customer is unaffected by u1's use.
  order(raw, 'o3', 'u2');
  redeem(raw, 'r3', 'once', 'u2', 'o3');
});

test('max_per_user greater than one is honoured exactly', () => {
  const { raw } = freshDb();
  coupon(raw, 'twice', 2, null);
  for (const o of ['a', 'b', 'c']) order(raw, o, 'u1');
  redeem(raw, 'r1', 'twice', 'u1', 'a');
  redeem(raw, 'r2', 'twice', 'u1', 'b');
  assert.throws(() => redeem(raw, 'r3', 'twice', 'u1', 'c'), /COUPON_PER_USER_LIMIT/);
});

// --------------------------------------------------------------- global

test('the global cap holds across users; NULL means unlimited', () => {
  const { raw } = freshDb();
  coupon(raw, 'launch', 5, 2);
  order(raw, 'o1', 'u1');
  order(raw, 'o2', 'u2');
  order(raw, 'o3', 'u3');
  redeem(raw, 'r1', 'launch', 'u1', 'o1');
  redeem(raw, 'r2', 'launch', 'u2', 'o2');
  assert.throws(() => redeem(raw, 'r3', 'launch', 'u3', 'o3'), /COUPON_GLOBAL_LIMIT/);

  coupon(raw, 'open', 5, null);
  for (const [i, u] of ['u1', 'u2', 'u3'].entries()) {
    order(raw, `p${i}`, u);
    redeem(raw, `q${i}`, 'open', u, `p${i}`);
  }
});

// ------------------------------------------- the race, as the checkout runs it

test('inside the checkout transaction the order does not survive a refused redemption', async () => {
  const { db, raw } = freshDb();
  coupon(raw, 'once', 1, null);
  order(raw, 'o1', 'u1');
  redeem(raw, 'r1', 'once', 'u1', 'o1');

  // The second checkout's batch: order first (as orders.ts does), then the
  // redemption. The trigger aborts the statement; the batch is one
  // transaction, so the order is rolled back with it.
  const batch = [
    db.prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, created_at, updated_at)
       VALUES (?, ?, 'pending', '{}', 'standard', '{}', 'cash', 10000, 0, 1400, 9000, 9000, ${NOW}, ${NOW})`
    ).bind('o2', 'u1'),
    db.prepare(
      `INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES (?, ?, ?, ?, 1000)`
    ).bind('r2', 'once', 'u1', 'o2'),
  ];
  await assert.rejects(db.batch(batch), /COUPON_PER_USER_LIMIT/);
  const o2 = raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE id = 'o2'").get() as { n: number };
  assert.equal(o2.n, 0, 'the discounted order was not created');
  const n = raw.prepare("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'once'").get() as { n: number };
  assert.equal(n.n, 1, 'the first redemption is still the only one');
});
