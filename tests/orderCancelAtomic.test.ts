/**
 * Cancelling an order is ONE transaction — for the customer and for the admin.
 *
 * The customer route used to flip the status with a `.run()` of its own and
 * post the refund from a later batch; a failure in between left a cancelled,
 * unrefunded order that the route's own "pending only" guard then refused to
 * retry for ever. The admin route had the same shape and, on top, never
 * returned the points reservation or cancelled the pending accrual.
 *
 * Now (worker/lib/orderCancelOps.ts): the conditional flip, the stock return,
 * the wallet and points refunds, the reservation flip and the accrual
 * cancellation share one `db.batch`; a lost flip aborts the batch; the refund
 * rows are idempotent on their deterministic ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, patch, json, row, count, spendable, settledPoints, pending } from './fixtures/app';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';

function seed(raw: DatabaseSync, status = 'pending') {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','b@x.co','h','customer'), ('boss','Admin','boss@x.co','h','admin');
    -- Paid the correct way at checkout: a deposit and an approved debit; 3,000
    -- points earned and 1,000 redeemed on the order.
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES
      ('dep','buyer','deposit','USD',50000,'approved','funding'),
      ('wtx_ord_O1_usd','buyer','withdrawal','USD',50000,'approved','Wallet payment on order O1'),
      ('pts','buyer','deposit','POINT',3000,'approved','earned'),
      ('wtx_ord_O1_pts','buyer','withdrawal','POINT',1000,'approved','Points used on order O1');
    INSERT INTO orders
      (id,user_id,status,stage,shipping_type,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
       subtotal_iqd,shipping_iqd,points_discount_iqd,wallet_applied_iqd,wallet_applied_usd_cents,
       exchange_rate,total_iqd,due_on_delivery_iqd,idempotency_key)
    VALUES
      ('O1','buyer','${status}','received','direct','{}','standard','{}','wallet',
       71000,5000,1000,70000,50000,1400,71000,0,'idem-O1');
    INSERT INTO points_reservations (id,order_id,user_id,points,eligible_basis_iqd,state,wallet_tx_id)
      VALUES ('prs1','O1','buyer',1000,71000,'committed','wtx_ord_O1_pts');
    INSERT INTO points_accruals (id,source_ref,order_id,user_id,kind,points,eligible_iqd,iqd_per_point,rule_version,state,purchase_at,available_at,reason)
      VALUES ('pac1','order:O1:accrual','O1','buyer','purchase',700,70000,100,'v2','pending','2026-09-01T00:00:00.000Z','2026-09-08T00:00:00.000Z','purchase');
  `);
}

const buyerApp = (db: D1Database) => stubApp(db, { id: 'buyer', role: 'customer', email: 'b@x.co' }, (a) => a.route('/api/orders', orderRoutes));
const adminApp = (db: D1Database) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin', adminRoutes), { env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' } });

const status = (raw: DatabaseSync) => row<{ status: string }>(raw, "SELECT status FROM orders WHERE id='O1'")!.status;
const refunded = (raw: DatabaseSync) => ({
  usd: row(raw, "SELECT id, created_by FROM wallet_transactions WHERE id='wtx_refund_O1_usd'"),
  pts: row(raw, "SELECT id, created_by FROM wallet_transactions WHERE id='wtx_refund_O1_pts'"),
  reservation: row<{ state: string }>(raw, "SELECT state FROM points_reservations WHERE id='prs1'")!.state,
  accrual: row<{ state: string }>(raw, "SELECT state FROM points_accruals WHERE id='pac1'")!.state,
});

test('customer cancel: a failure in the batch leaves the order PENDING and unrefunded — and the retry then refunds exactly once', async () => {
  const raw = freshDb();
  seed(raw);
  const { failing, db } = failingD1(raw);
  const app = buyerApp(db);

  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO wallet_transactions/i.test(s.sql));
  const first = await post(app, '/api/orders/O1/cancel', {});
  assert.equal(first.status, 500, 'the failure is surfaced, not hidden');
  assert.equal(status(raw), 'pending', 'the flip did NOT land on its own');
  assert.equal(refunded(raw).usd, undefined);
  assert.equal(refunded(raw).reservation, 'committed');
  assert.equal(refunded(raw).accrual, 'pending');

  failing.failWhen = null;
  const retry = await json(await post(app, '/api/orders/O1/cancel', {}));
  assert.equal(retry.success, true, JSON.stringify(retry));
  assert.equal(status(raw), 'cancelled');
  const r = refunded(raw);
  assert.ok(r.usd && r.pts, 'both refunds posted');
  assert.equal(r.usd?.created_by, 'system');
  assert.equal(r.reservation, 'refunded');
  assert.equal(r.accrual, 'cancelled');
  assert.equal(spendable(raw, 'buyer'), 50_000, 'the wallet is back to the deposit');
  assert.equal(settledPoints(raw, 'buyer'), 3000, 'the points came back as points');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id='buyer'"), 6, 'exactly one refund row per currency');

  // Nothing to do twice.
  const again = await post(app, '/api/orders/O1/cancel', {});
  assert.equal(again.status, 400);
  assert.equal(spendable(raw, 'buyer'), 50_000);
  await Promise.allSettled(pending);
});

test('customer cancel: a flip that loses to a concurrent transition writes nothing at all', async () => {
  const raw = freshDb();
  seed(raw);
  const { failing, db } = failingD1(raw);
  const app = buyerApp(db);
  // Between the route's read and its batch, an admin confirms the order.
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /SET status = 'cancelled'/.test(s.sql))) raw.exec("UPDATE orders SET status='confirmed' WHERE id='O1'");
  };
  const res = await post(app, '/api/orders/O1/cancel', {});
  const out = await json(res);
  assert.equal(res.status, 400, JSON.stringify(out));
  assert.match(String(out.error), /already cancelled or has progressed/);
  assert.equal(status(raw), 'confirmed');
  assert.equal(refunded(raw).usd, undefined, 'no refund on an order that is not cancelled');
  assert.equal(refunded(raw).pts, undefined);
  assert.equal(refunded(raw).reservation, 'committed');
  assert.equal(refunded(raw).accrual, 'pending');
  await Promise.allSettled(pending);
});

test('admin cancel: refunds wallet and points, returns the reservation and cancels the accrual — in the flip’s own batch', async () => {
  const raw = freshDb();
  seed(raw, 'confirmed');
  const app = adminApp(asD1(raw));
  const res = await patch(app, '/api/admin/orders/O1', { status: 'cancelled', adminNote: 'customer asked' });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(status(raw), 'cancelled');
  const r = refunded(raw);
  assert.equal(r.usd?.created_by, 'admin');
  assert.equal(r.pts?.created_by, 'admin');
  assert.equal(r.reservation, 'refunded', 'the admin path now returns the reservation');
  assert.equal(r.accrual, 'cancelled', 'and cancels the pending accrual');
  assert.equal(spendable(raw, 'buyer'), 50_000);
  assert.equal(settledPoints(raw, 'buyer'), 3000);

  // Re-opened and cancelled again: the refund replays, it does not double.
  assert.equal((await patch(app, '/api/admin/orders/O1', { status: 'processing' })).status, 200);
  assert.equal((await patch(app, '/api/admin/orders/O1', { status: 'cancelled' })).status, 200);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_refund_O1_%'"), 2);
  assert.equal(spendable(raw, 'buyer'), 50_000, 'not refunded twice');
  await Promise.allSettled(pending);
});

test('admin cancel: a failure in the batch leaves the status where it was, with nothing refunded', async () => {
  const raw = freshDb();
  seed(raw, 'confirmed');
  const { failing, db } = failingD1(raw);
  const app = adminApp(db);
  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO wallet_transactions/i.test(s.sql));
  const res = await patch(app, '/api/admin/orders/O1', { status: 'cancelled' });
  assert.equal(res.status, 500);
  assert.equal(status(raw), 'confirmed');
  assert.equal(refunded(raw).usd, undefined);
  assert.equal(refunded(raw).reservation, 'committed');
  assert.equal(refunded(raw).accrual, 'pending');

  // A stale edit (the order moved underneath the admin) is a 400, not a refund.
  failing.failWhen = null;
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /SET status = \?/.test(s.sql))) raw.exec("UPDATE orders SET status='shipped' WHERE id='O1'");
  };
  const stale = await patch(app, '/api/admin/orders/O1', { status: 'cancelled' });
  assert.equal(stale.status, 400);
  assert.equal(status(raw), 'shipped');
  assert.equal(refunded(raw).usd, undefined);
  await Promise.allSettled(pending);
});
