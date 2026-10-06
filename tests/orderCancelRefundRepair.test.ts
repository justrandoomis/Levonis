import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, patch, json, row, count, pending } from './fixtures/app';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { repairCancelledOrderRefunds } from '../worker/lib/orderCancelRepair';
import { getWalletDinarBreakdown } from '../worker/lib/walletOps';
import type { Env } from '../worker/lib/types';

const NOW = '2026-10-06T03:00:00.000Z';
const env = (db: D1Database) => ({ DB: db } as Env);

function seed(raw: DatabaseSync, status = 'pending') {
  raw.exec(`
    INSERT INTO users(id,name,email,password_hash,role) VALUES
      ('buyer','Buyer','buyer@example.com','h','customer'),('boss','Boss','boss@x.co','h','admin');
    INSERT INTO orders(id,user_id,status,stage,shipping_type,address_snapshot,delivery_method_id,
      delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,points_discount_iqd,
      wallet_applied_iqd,wallet_applied_usd_cents,exchange_rate,total_iqd,due_on_delivery_iqd,idempotency_key)
    VALUES('P2S','buyer','${status}','${status === 'cancelled' ? 'cancelled' : status === 'confirmed' ? 'confirmed' : 'received'}','preorder_land','{}',
      'pickup','{}','cash',1000000,0,1000,50000,3571,1400,1000000,949000,'p2s-order');
    INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref,amount_iqd,exchange_rate_snapshot) VALUES
      ('topup','buyer','deposit','USD',3571,'approved','funding',50000,1400),
      ('wtx_ord_P2S_usd','buyer','withdrawal','USD',3571,'approved','P2S',50000,1400),
      ('earned','buyer','deposit','POINT',2000,'approved','earned',NULL,NULL),
      ('wtx_ord_P2S_pts','buyer','withdrawal','POINT',1000,'approved','P2S',NULL,NULL);
    INSERT INTO points_reservations(id,order_id,user_id,points,eligible_basis_iqd,state,wallet_tx_id)
      VALUES('prs','P2S','buyer',1000,1000000,'committed','wtx_ord_P2S_pts');
    INSERT INTO points_accruals(id,source_ref,order_id,user_id,kind,points,eligible_iqd,iqd_per_point,rule_version,state,purchase_at,available_at,reason)
      VALUES('pac','order:P2S:accrual','P2S','buyer','purchase',100,10000,100,'v2','pending','2026-10-01T00:00:00.000Z','2026-10-08T00:00:00.000Z','purchase');
  `);
}

const adminApp = (db: D1Database) => stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, a => a.route('/api/admin', adminRoutes));
const buyerApp = (db: D1Database) => stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@example.com' }, a => a.route('/api/orders', orderRoutes));
const refunds = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_refund_P2S_%'");
const state = (raw: DatabaseSync) => row(raw, "SELECT status,stage FROM orders WHERE id='P2S'");

test('P2S land preorder: all three cancellation doors immediately restore the exact 50,000 IQD and points', async () => {
  for (const door of ['customer', 'admin_status', 'admin_stage']) {
    const raw = freshDb(); seed(raw, door === 'customer' ? 'pending' : 'confirmed');
    const db = asD1(raw);
    assert.equal((await getWalletDinarBreakdown(db, 'buyer', 1400)).iqd_settled, 0);
    const response = door === 'customer' ? await post(buyerApp(db), '/api/orders/P2S/cancel', {})
      : await patch(adminApp(db), `/api/admin/orders/P2S${door === 'admin_stage' ? '/stage' : ''}`,
        door === 'admin_stage' ? { stage: 'cancelled' } : { status: 'cancelled' });
    assert.equal(response.status, 200, `${door}: ${JSON.stringify(await json(response))}`);
    assert.equal(state(raw)?.status, 'cancelled');
    assert.equal((await getWalletDinarBreakdown(db, 'buyer', 1400)).iqd_settled, 50_000, door);
    assert.equal(refunds(raw), 2, door);
    assert.equal(row(raw, "SELECT state FROM points_reservations WHERE id='prs'")?.state, 'refunded');
    assert.equal(row(raw, "SELECT state FROM points_accruals WHERE id='pac'")?.state, 'cancelled');
    await Promise.allSettled(pending);
  }
});

test('stage cancellation rolls back status and points on refund failure, then retries exactly once', async () => {
  const raw = freshDb(); seed(raw);
  const { db, failing } = failingD1(raw);
  failing.failWhen = stmts => stmts.some(s => /INSERT INTO wallet_transactions/.test(s.sql));
  const app = adminApp(db);
  assert.equal((await patch(app, '/api/admin/orders/P2S/stage', { stage: 'cancelled' })).status, 500);
  assert.deepEqual(state(raw), { status: 'pending', stage: 'received' });
  assert.equal(refunds(raw), 0);
  assert.equal(row(raw, "SELECT state FROM points_reservations WHERE id='prs'")?.state, 'committed');
  failing.failWhen = null;
  assert.equal((await patch(app, '/api/admin/orders/P2S/stage', { stage: 'cancelled' })).status, 200);
  assert.equal((await patch(app, '/api/admin/orders/P2S/stage', { stage: 'cancelled' })).status, 400);
  assert.equal(refunds(raw), 2);
  await Promise.allSettled(pending);
});

test('stage cancellation losing to a confirmation does not refund the still-active order', async () => {
  const raw = freshDb(); seed(raw);
  const { db, failing } = failingD1(raw);
  failing.beforeBatch = stmts => {
    if (stmts.some(s => /SET stage = \?/.test(s.sql))) raw.exec("UPDATE orders SET status='confirmed' WHERE id='P2S'");
  };
  assert.equal((await patch(adminApp(db), '/api/admin/orders/P2S/stage', { stage: 'cancelled' })).status, 400);
  assert.equal(state(raw)?.status, 'confirmed');
  assert.equal(refunds(raw), 0);
});

test('historical stage cancellation is repaired automatically once, preserving its cancellation timestamp', async () => {
  const raw = freshDb(); seed(raw, 'cancelled');
  const db = asD1(raw);
  const before = row(raw, "SELECT updated_at FROM orders WHERE id='P2S'")?.updated_at;
  assert.deepEqual(await repairCancelledOrderRefunds(env(db), NOW), { scanned: 1, repaired: 1, skipped: 0, errors: 0 });
  assert.equal((await getWalletDinarBreakdown(db, 'buyer', 1400)).iqd_settled, 50_000);
  assert.equal(refunds(raw), 2);
  assert.equal(row(raw, "SELECT updated_at FROM orders WHERE id='P2S'")?.updated_at, before);
  assert.equal((await repairCancelledOrderRefunds(env(db), NOW)).scanned, 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='order.cancel_refund_repaired'"), 1);
});

test('historical refund requires payment evidence and refuses conflicting money or delivered history', async () => {
  for (const change of [
    "UPDATE wallet_transactions SET status='pending' WHERE id='wtx_ord_P2S_usd'",
    "UPDATE orders SET wallet_applied_usd_cents=4000 WHERE id='P2S'",
    "UPDATE orders SET delivered_at='2026-10-01T00:00:00.000Z' WHERE id='P2S'",
    "UPDATE orders SET gini_paid_iqd=50000 WHERE id='P2S'",
    "INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref) VALUES('manual-return','buyer','deposit','USD',100,'approved','P2S')",
  ]) {
    const raw = freshDb(); seed(raw, 'cancelled'); raw.exec(change);
    assert.equal((await repairCancelledOrderRefunds(env(asD1(raw)), NOW)).scanned, 0, change);
    assert.equal(refunds(raw), 0, change);
  }
});

test('historical repair returns only the remaining advance after an approved price reduction', async () => {
  const raw = freshDb(); seed(raw, 'cancelled');
  raw.exec(`UPDATE orders SET wallet_applied_usd_cents=2143,wallet_applied_iqd=30000 WHERE id='P2S';
    INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref,amount_iqd,exchange_rate_snapshot)
    VALUES('price-refund','buyer','deposit','USD',1428,'approved','order-price:P2S',20000,1400)`);
  const db = asD1(raw);
  assert.equal((await repairCancelledOrderRefunds(env(db), NOW)).repaired, 1);
  assert.deepEqual(row(raw, "SELECT amount,amount_iqd FROM wallet_transactions WHERE id='wtx_refund_P2S_usd'"), { amount: 2143, amount_iqd: 30000 });
  assert.equal((await getWalletDinarBreakdown(db, 'buyer', 1400)).iqd_settled, 50_000);
});

test('historical repair failure is retryable and concurrent reopening receives no credit', async () => {
  const raw = freshDb(); seed(raw, 'cancelled');
  const { db, failing } = failingD1(raw);
  failing.failWhen = stmts => stmts.some(s => /INSERT INTO wallet_transactions/.test(s.sql));
  assert.equal((await repairCancelledOrderRefunds(env(db), NOW)).errors, 1);
  assert.equal(refunds(raw), 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='order.cancel_refund_repaired'"), 0);
  failing.failWhen = null;
  failing.beforeBatch = stmts => {
    if (stmts.some(s => /INSERT INTO wallet_transactions/.test(s.sql))) raw.exec("UPDATE orders SET status='confirmed' WHERE id='P2S'");
  };
  assert.equal((await repairCancelledOrderRefunds(env(db), NOW)).skipped, 1);
  assert.equal(refunds(raw), 0);
});

test('historical repair that loses to another completed repair does not credit twice', async () => {
  const raw = freshDb(); seed(raw, 'cancelled');
  const { db, failing } = failingD1(raw);
  failing.beforeBatch = () => {
    raw.exec(`INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref,amount_iqd,exchange_rate_snapshot)
      VALUES('wtx_refund_P2S_usd','buyer','deposit','USD',3571,'approved','P2S',50000,1400),
        ('wtx_refund_P2S_pts','buyer','deposit','POINT',1000,'approved','P2S',NULL,NULL)`);
  };
  assert.equal((await repairCancelledOrderRefunds(env(db), NOW)).skipped, 1);
  assert.equal(refunds(raw), 2);
  assert.equal((await getWalletDinarBreakdown(db, 'buyer', 1400)).iqd_settled, 50_000);
});

test('stage cancellation cannot refund a stale advance after a concurrent approved price cut', async () => {
  const raw = freshDb(); seed(raw);
  const { db, failing } = failingD1(raw);
  failing.beforeBatch = stmts => {
    if (stmts.some(s => /SET stage = \?/.test(s.sql))) raw.exec(`
      UPDATE orders SET wallet_applied_usd_cents=2143,wallet_applied_iqd=30000 WHERE id='P2S';
      INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref,amount_iqd,exchange_rate_snapshot)
      VALUES('price-refund','buyer','deposit','USD',1428,'approved','order-price:P2S',20000,1400)`);
  };
  assert.equal((await patch(adminApp(db), '/api/admin/orders/P2S/stage', { stage: 'cancelled' })).status, 400);
  assert.equal(state(raw)?.status, 'pending');
  assert.equal(refunds(raw), 0);
  failing.beforeBatch = null;
  assert.equal((await patch(adminApp(db), '/api/admin/orders/P2S/stage', { stage: 'cancelled' })).status, 200);
  assert.equal((await getWalletDinarBreakdown(db, 'buyer', 1400)).iqd_settled, 50_000);
  await Promise.allSettled(pending);
});

test('stage cannot reopen an order whose advance was already returned', async () => {
  const raw = freshDb(); seed(raw);
  const db = asD1(raw), app = adminApp(db);
  assert.equal((await patch(app, '/api/admin/orders/P2S/stage', { stage: 'cancelled' })).status, 200);
  assert.equal((await patch(app, '/api/admin/orders/P2S/stage', { stage: 'confirmed' })).status, 400);
  assert.equal(state(raw)?.status, 'cancelled');
  assert.equal((await getWalletDinarBreakdown(db, 'buyer', 1400)).iqd_settled, 50_000);
  await Promise.allSettled(pending);
});

test('stage reopening also refuses a refund that lands after its initial read', async () => {
  const raw = freshDb(); seed(raw, 'cancelled');
  const { db, failing } = failingD1(raw);
  failing.beforeBatch = stmts => {
    if (stmts.some(s => /SET stage = \?/.test(s.sql))) raw.exec(`
      INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref,amount_iqd,exchange_rate_snapshot)
      VALUES('wtx_refund_P2S_usd','buyer','deposit','USD',3571,'approved','P2S',50000,1400)`);
  };
  assert.equal((await patch(adminApp(db), '/api/admin/orders/P2S/stage', { stage: 'confirmed' })).status, 400);
  assert.equal(state(raw)?.status, 'cancelled');
});
