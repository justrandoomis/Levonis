/**
 * ONE CANCELLATION FOR A COMMUNITY-STORE ORDER, WHICHEVER DOOR ASKS
 * (audit 02 B2 + B7, audit 01 B1/B2).
 *
 * Four doors used to mean four different things by «ملغي»:
 *   · the MERCHANT reversed their own credit and kept the buyer's money;
 *   · the CUSTOMER and the ADMIN refunded the buyer and left the merchant's
 *     credit pending for ever, the store's stock and the coupon use spent;
 *   · an admin could re-open a cancelled, refunded order.
 * Every door now runs `cancelStoreOrder` (worker/lib/storeOrderOps.ts): refund,
 * restock, coupon, credit reversal, history and audit in one batch — once.
 *
 * Run: node --import tsx --test tests/storeOrderCancel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, patch, json, count, row, spendable, pending } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { orderRoutes } from '../worker/routes/orders';
import { merchantRoutes } from '../worker/routes/merchant';
import { adminRoutes } from '../worker/routes/admin';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { merchantBalance } from '../worker/lib/escrowOps';
import { cancelAnchorId } from '../worker/lib/storeOrderOps';
import { orderCreditStateSql } from '../worker/lib/merchantLedger';
import type { Env } from '../worker/lib/types';

const DEP = 100_000;
const FUTURE = '2099-01-01T00:00:00.000Z';

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'),
      ('ali','Ali','ali@x.co','h','merchant'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings)
      VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{"fee_iqd":2800}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_ltd','m_ali','s_ali','ali-ltd','Ali limited','active','active',14000,5,1);
    INSERT INTO merchant_coupons (id,store_id,merchant_id,code,kind,value,max_uses,used_count)
      VALUES ('mc1','s_ali','m_ali','TEN','percent',10,5,0);
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('dep_buyer','buyer','deposit','USD',${DEP},'approved','seed');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
  `);
}

const buyerApp = (db: D1Database) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
    a.route('/api/orders', orderRoutes);
  });
const merchantApp = (db: D1Database) =>
  stubApp(db, { id: 'ali', role: 'merchant', email: 'ali@x.co' }, (a) => a.route('/api/merchant', merchantRoutes));
const adminApp = (db: D1Database) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin', adminRoutes));

/** A paid order: 2 units with the TEN coupon — 28,000 − 2,800 + 2,800 delivery = 28,000 IQD = 2,000 cents. */
async function paidOrder(raw: DatabaseSync): Promise<string> {
  const app = buyerApp(asD1(raw));
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: 'cp_ltd', qty: 2 })).status, 201);
  const q = await json(await post(app, '/api/store-orders/quote', { couponCode: 'TEN' }));
  const res = await post(app, '/api/store-orders', {
    idempotencyKey: `cancel-${Math.random().toString(36).slice(2, 10)}`,
    addressId: 'a1',
    couponCode: 'TEN',
    quoteFingerprint: q.quote.quote_fingerprint,
  });
  const body = await json(res);
  assert.equal(res.status, 201, JSON.stringify(body));
  await Promise.allSettled(pending.splice(0));
  assert.equal(spendable(raw, 'buyer'), DEP - 2000, 'the buyer paid 2,000 cents');
  assert.deepEqual(product(raw), { stock: 3, sold_count: 2 });
  assert.equal(couponUses(raw), 1);
  return String(body.order.id);
}

const product = (raw: DatabaseSync) =>
  row<{ stock: number; sold_count: number }>(raw, "SELECT stock, sold_count FROM community_products WHERE id='cp_ltd'")!;
const couponUses = (raw: DatabaseSync) =>
  row<{ used_count: number }>(raw, "SELECT used_count FROM merchant_coupons WHERE id='mc1'")!.used_count;
/** The sale credit from the append-only merchant ledger (migration 0121): its state and what it holds. */
const credit = (raw: DatabaseSync, id: string) =>
  row<{ state: string; amount_iqd: number }>(
    raw,
    `SELECT ${orderCreditStateSql('?1')} AS state,
            (SELECT COALESCE(SUM(amount_iqd), 0) FROM merchant_ledger_entries WHERE order_id = ?1 AND bucket IN ('pending','available')) AS amount_iqd`,
    id
  )!;
const order = (raw: DatabaseSync, id: string) =>
  row<{ status: string; stage: string }>(raw, 'SELECT status, stage FROM orders WHERE id = ?', id)!;

/** Everything a store cancellation owes, asserted as one. */
function assertFullyCancelled(raw: DatabaseSync, id: string, actorAudit = 1) {
  assert.deepEqual(order(raw, id), { status: 'cancelled', stage: 'cancelled' });
  assert.equal(spendable(raw, 'buyer'), DEP, 'the buyer has every cent back');
  const refund = row<{ amount: number; amount_iqd: number | null }>(raw, 'SELECT amount, amount_iqd FROM wallet_transactions WHERE id = ?', `wtx_refund_${id}_usd`)!;
  assert.deepEqual(refund, { amount: 2000, amount_iqd: 28000 }, 'the refund copies the debit’s cents AND dinars');
  assert.deepEqual(product(raw), { stock: 5, sold_count: 0 }, 'stock and sold_count restored');
  assert.equal(couponUses(raw), 0, 'the coupon use given back');
  assert.equal(credit(raw, id).state, 'reversed', 'the merchant is not owed a refunded sale');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM order_status_history WHERE id = ?', cancelAnchorId(id)), 1, 'one cancellation, on the record');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'store_order.cancelled' AND target = ?", id), actorAudit);
}

// ============================================================ the three doors

test('the MERCHANT cancels a paid store order: the buyer is refunded (B2), stock and coupon come back, credit reversed', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await paidOrder(raw);
  const res = await post(merchantApp(asD1(raw)), `/api/merchant/orders/${id}/status`, { status: 'cancelled', reason: 'out of filament' });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.refunded_usd_cents, 2000);
  await Promise.allSettled(pending.splice(0));
  assertFullyCancelled(raw, id);
  const bell = row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer' AND event_key = ?", `order.status.cancelled:${id}`)!;
  assert.equal(bell.n, 1, 'the buyer is told');
});

test('the CUSTOMER cancels: the merchant’s pending credit is reversed and the store is restocked (B7) — and told', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await paidOrder(raw);
  const res = await post(buyerApp(asD1(raw)), `/api/orders/${id}/cancel`, {});
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.order.status, 'cancelled');
  await Promise.allSettled(pending.splice(0));
  assertFullyCancelled(raw, id);
  assert.equal(
    count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE user_id = 'ali' AND event_key = ?", `store_order.cancelled:${id}`),
    1,
    'the store hears it must not ship'
  );
});

test('the ADMIN cancels through the status door: the same operation, not the platform’s (A1)', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await paidOrder(raw);
  const res = await patch(adminApp(asD1(raw)), `/api/admin/orders/${id}`, { status: 'cancelled', adminNote: 'customer asked by phone' });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  await Promise.allSettled(pending.splice(0));
  assertFullyCancelled(raw, id);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE user_id = 'ali' AND event_key = ?", `store_order.cancelled:${id}`), 1);
});

test('the ADMIN cancels through the STAGE door: the same operation', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await paidOrder(raw);
  const res = await patch(adminApp(asD1(raw)), `/api/admin/orders/${id}/stage`, { stage: 'cancelled' });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.stage, 'cancelled');
  await Promise.allSettled(pending.splice(0));
  assertFullyCancelled(raw, id);
});

// ======================================================== never twice, never back

test('a second cancellation from another door refunds and restocks NOTHING again', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await paidOrder(raw);
  assert.equal((await post(merchantApp(asD1(raw)), `/api/merchant/orders/${id}/status`, { status: 'cancelled' })).status, 200);
  const again = await post(buyerApp(asD1(raw)), `/api/orders/${id}/cancel`, {});
  assert.equal(again.status, 400);
  const admin = await patch(adminApp(asD1(raw)), `/api/admin/orders/${id}`, { status: 'cancelled' });
  assert.equal(admin.status, 400, 'cancelled → cancelled is no transition');
  await Promise.allSettled(pending.splice(0));
  assertFullyCancelled(raw, id);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id='buyer' AND type='deposit'"), 2, 'the seed and ONE refund');
});

test('two cancellations racing: the one that loses the gate rolls back whole and says so (409)', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await paidOrder(raw);
  const { failing, db } = failingD1(raw);
  let raced = false;
  failing.beforeBatch = (stmts) => {
    if (raced || !stmts.some((s) => /INSERT INTO order_status_history/.test(s.sql))) return;
    raced = true;
    // The customer's cancel committed first: its flip and its gate row are in.
    raw.prepare(
      `UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id = ?`
    ).run(id);
    raw.prepare(
      `INSERT INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
       VALUES (?, ?, 'cancelled', 'cancelled', 'manual', '2026-01-01T00:00:00.000Z', 'buyer', 'Cancelled by the customer')`
    ).run(cancelAnchorId(id), id);
  };
  const res = await post(merchantApp(db), `/api/merchant/orders/${id}/status`, { status: 'cancelled' });
  assert.ok(raced, 'the race was staged');
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'ORDER_CHANGED');
  // The loser wrote nothing: no refund, no restock, no second reversal.
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions WHERE id = ?', `wtx_refund_${id}_usd`), 0);
  assert.deepEqual(product(raw), { stock: 3, sold_count: 2 });
  assert.equal(credit(raw, id).state, 'pending');
});

test('an admin cannot re-open a cancelled store order — through either door (STORE_ORDER_REOPEN_REFUSED)', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await paidOrder(raw);
  assert.equal((await post(merchantApp(asD1(raw)), `/api/merchant/orders/${id}/status`, { status: 'cancelled' })).status, 200);
  const admin = adminApp(asD1(raw));

  const reopen = await patch(admin, `/api/admin/orders/${id}`, { status: 'confirmed' });
  assert.equal(reopen.status, 409);
  assert.equal((await json(reopen)).code, 'STORE_ORDER_REOPEN_REFUSED');
  const byStage = await patch(admin, `/api/admin/orders/${id}/stage`, { stage: 'confirmed' });
  assert.equal(byStage.status, 409);
  assert.equal((await json(byStage)).code, 'STORE_ORDER_REOPEN_REFUSED');
  assert.equal(order(raw, id).status, 'cancelled');
  await Promise.allSettled(pending.splice(0));
});

test('no stage move enters or leaves `cancelled` for a store order — not even a forced one', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await paidOrder(raw);
  const env = { DB: asD1(raw) } as unknown as Env;
  const res = await moveOrderStage(env, { orderId: id, to: 'cancelled', source: 'manual', force: true });
  assert.equal(res.moved, false);
  assert.equal(res.reason, 'ILLEGAL_MOVE');
  assert.equal(order(raw, id).status, 'pending', 'a stage move would have refunded nothing');
});

// ================================================================ the clawback

test('cancelling after the credit was released takes it back out of «available» with its own row', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await paidOrder(raw);
  const m = merchantApp(asD1(raw));
  for (const s of ['confirmed', 'processing', 'shipped', 'delivered']) {
    assert.equal((await post(m, `/api/merchant/orders/${id}/status`, { status: s })).status, 200, s);
  }
  // The customer confirmed receipt: the credit became available.
  assert.equal((await post(buyerApp(asD1(raw)), `/api/orders/${id}/confirm-receipt`, {})).status, 200);
  assert.equal(credit(raw, id).state, 'available');
  const owed = credit(raw, id).amount_iqd;
  assert.equal((await merchantBalance(asD1(raw), 'm_ali')).available_iqd, owed);

  // A dispute later ends in a refund: the admin walks it back and cancels.
  const admin = adminApp(asD1(raw));
  assert.equal((await patch(admin, `/api/admin/orders/${id}`, { status: 'shipped' })).status, 200);
  assert.equal((await patch(admin, `/api/admin/orders/${id}`, { status: 'cancelled' })).status, 200);
  await Promise.allSettled(pending.splice(0));

  // The claw-back is refund lines of its own in «available» (never an edit), keyed once per order.
  const reversal = row<{ amount_iqd: number; n: number }>(
    raw, "SELECT SUM(amount_iqd) AS amount_iqd, COUNT(*) AS n FROM merchant_ledger_entries WHERE order_id = ? AND bucket = 'available' AND event_key LIKE 'reversal:' || ? || ':%'", id, id
  )!;
  assert.equal(reversal.amount_iqd, -owed);
  assert.ok(reversal.n >= 1);
  assert.equal((await merchantBalance(asD1(raw), 'm_ali')).available_iqd, 0, 'nothing left to pay out for a refunded sale');
  assert.equal(spendable(raw, 'buyer'), DEP);
});
