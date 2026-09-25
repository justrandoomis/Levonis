/**
 * REVIEW W2-5 p4 — A PAYOUT RESERVED BEFORE A CLAW-BACK IS NOT SENT WHILE THE
 * MERCHANT OWES THE PLATFORM.
 *
 * A delivered order is released to the merchant, who asks to be paid (the
 * money moves available → reserved). The dispute is then lost: an admin
 * cancels the order, the customer is refunded and the credit is clawed back,
 * which leaves «available» negative — the merchant owes the platform. A NEW
 * request was already refused; approving or paying the reserved one was not.
 * Now both decisions carry a debt fence in the same batch and refuse with
 * 409 MERCHANT_IN_DEBT {debt_iqd}; failing it (money back to available) stays
 * possible, and once the debt is covered the payout goes through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, patch, get, json, pending } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { orderRoutes } from '../worker/routes/orders';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantFinanceRoutes, merchantPayoutRoutes } from '../worker/routes/merchantFinance';
import { adminRoutes } from '../worker/routes/admin';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { merchantBuckets } from '../worker/lib/merchantLedger';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const FUTURE = '2099-01-01T00:00:00.000Z';
function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('buyer','Sara','buyer@x.co','h','customer',NULL), ('ali','Ali','ali@x.co','h','merchant',NULL), ('boss','Boss','boss@x.co','h','admin','full');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings)
      VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{"fee_iqd":2000}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,100,0);
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES ('dep','buyer','deposit','USD',100000,'approved','seed');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
  `);
}
const buyer = (db: D1Database) => stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
  a.route('/api/cart', cartRoutes); a.route('/api/store-orders', storeOrderRoutes); a.route('/api/orders', orderRoutes);
});
const merchant = (db: D1Database) => stubApp(db, { id: 'ali', role: 'merchant', email: 'ali@x.co' }, (a) => {
  a.route('/api/merchant/payouts', merchantPayoutRoutes); a.route('/api/merchant/finance', merchantFinanceRoutes); a.route('/api/merchant', merchantRoutes);
});
const admin = (db: D1Database) => stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: 'full' }, (a) => {
  a.route('/api/admin/community', adminCommunityRoutes); a.route('/api/admin', adminRoutes);
});

/** Delivered, released, a payout requested for all of it, then the order cancelled and the credit clawed back. */
async function inDebtWithReservedPayout() {
  const raw = freshDb(); seed(raw); const db = asD1(raw);
  const b = buyer(db);
  assert.equal((await post(b, '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 })).status, 201);
  const q = await json(await post(b, '/api/store-orders/quote', { addressId: 'a1' }));
  const placed = await json(await post(b, '/api/store-orders', { idempotencyKey: 'debt-key-0001', addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint }));
  const orderId = String(placed.order.id);
  const m = merchant(db);
  for (const s of ['confirmed', 'processing', 'shipped', 'delivered']) assert.equal((await post(m, `/api/merchant/orders/${orderId}/status`, { status: s })).status, 200);
  await Promise.allSettled(pending.splice(0));
  assert.equal((await json(await post(b, `/api/orders/${orderId}/confirm-receipt`, {}))).released, true);
  const released = await merchantBuckets(db, 'm_ali');
  assert.ok(released.available > 0);
  const req = await json(await post(m, '/api/merchant/payouts', { amount_iqd: released.available, idempotencyKey: 'payout-key-01', channel: 'zaincash', account: '07701234567' }));
  assert.equal(req.payout?.state, 'requested');
  const a = admin(db);
  assert.equal((await patch(a, `/api/admin/orders/${orderId}`, { status: 'shipped' })).status, 200);
  assert.equal((await patch(a, `/api/admin/orders/${orderId}`, { status: 'cancelled' })).status, 200);
  await Promise.allSettled(pending.splice(0));
  const after = await merchantBuckets(db, 'm_ali');
  assert.ok(after.available < 0, `the claw-back leaves available negative (got ${after.available})`);
  return { raw, db, a, m, payoutId: String(req.payout.id), debt: -after.available, reserved: after.reserved };
}

test('approve is refused 409 MERCHANT_IN_DEBT with the debt while available < 0, and nothing moves', async () => {
  const { db, a, payoutId, debt, reserved } = await inDebtWithReservedPayout();
  const res = await post(a, `/api/admin/community/payouts/${payoutId}/approve`, {});
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, 'MERCHANT_IN_DEBT');
  assert.equal(body.details?.debt_iqd, debt);
  const b = await merchantBuckets(db, 'm_ali');
  assert.equal(b.reserved, reserved);
  assert.equal(b.paid, 0);
  const row = (await db.prepare('SELECT state FROM merchant_payouts WHERE id = ?').bind(payoutId).first<{ state: string }>())!;
  assert.equal(row.state, 'requested');
  // The queue shows the debt so the admin knows why before pressing.
  const queue = await json(await get(a, '/api/admin/community/payouts?state=open'));
  const q = queue.payouts.find((p: { id: string }) => p.id === payoutId);
  assert.equal(q.merchant.debt_iqd, debt);
});

test('paid is refused 409 MERCHANT_IN_DEBT for a payout approved before the claw-back', async () => {
  const raw = freshDb(); seed(raw); const db = asD1(raw);
  // Same story, but the admin approved BEFORE the claw-back landed.
  const b = buyer(db);
  await post(b, '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 });
  const q = await json(await post(b, '/api/store-orders/quote', { addressId: 'a1' }));
  const placed = await json(await post(b, '/api/store-orders', { idempotencyKey: 'debt-key-0002', addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint }));
  const orderId = String(placed.order.id);
  const m = merchant(db);
  for (const s of ['confirmed', 'processing', 'shipped', 'delivered']) await post(m, `/api/merchant/orders/${orderId}/status`, { status: s });
  await Promise.allSettled(pending.splice(0));
  await post(b, `/api/orders/${orderId}/confirm-receipt`, {});
  const avail = (await merchantBuckets(db, 'm_ali')).available;
  const req = await json(await post(m, '/api/merchant/payouts', { amount_iqd: avail, idempotencyKey: 'payout-key-02', channel: 'zaincash', account: '07701234567' }));
  const a = admin(db);
  assert.equal((await post(a, `/api/admin/community/payouts/${req.payout.id}/approve`, {})).status, 200);
  await patch(a, `/api/admin/orders/${orderId}`, { status: 'shipped' });
  await patch(a, `/api/admin/orders/${orderId}`, { status: 'cancelled' });
  await Promise.allSettled(pending.splice(0));
  const debt = -(await merchantBuckets(db, 'm_ali')).available;
  assert.ok(debt > 0);
  const res = await post(a, `/api/admin/community/payouts/${req.payout.id}/paid`, { reference: 'TRX-123' });
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, 'MERCHANT_IN_DEBT');
  assert.equal(body.details?.debt_iqd, debt);
  const after = await merchantBuckets(db, 'm_ali');
  assert.equal(after.paid, 0, 'no money left the platform');
  assert.equal((await db.prepare('SELECT state FROM merchant_payouts WHERE id = ?').bind(req.payout.id).first<{ state: string }>())!.state, 'approved');
});

test('failing the payout still works while in debt — the reservation returns to available and reduces the debt', async () => {
  const { db, a, payoutId, debt, reserved } = await inDebtWithReservedPayout();
  const res = await post(a, `/api/admin/community/payouts/${payoutId}/fail`, { reason: 'the order was refunded' });
  assert.equal(res.status, 200);
  const b = await merchantBuckets(db, 'm_ali');
  assert.equal(b.reserved, 0);
  assert.equal(b.available, reserved - debt);
});

test('once the debt is covered the same payout is approved and paid', async () => {
  const { raw, db, a, payoutId, debt } = await inDebtWithReservedPayout();
  // Cover the debt with a positive admin adjustment.
  const adj = await post(a, '/api/admin/community/merchants/m_ali/adjustment', { amount_iqd: debt, reason: 'debt settled in cash', idempotencyKey: 'adj-cover-debt-01' });
  assert.equal(adj.status, 200, JSON.stringify(await json(adj.clone())));
  assert.equal((await merchantBuckets(db, 'm_ali')).available, 0);
  assert.equal((await post(a, `/api/admin/community/payouts/${payoutId}/approve`, {})).status, 200);
  const paid = await post(a, `/api/admin/community/payouts/${payoutId}/paid`, { reference: 'TRX-456' });
  assert.equal(paid.status, 200);
  assert.equal(raw.prepare('SELECT state FROM merchant_payouts WHERE id = ?').get(payoutId)?.state, 'paid');
});

test('MERCHANT_IN_DEBT has a sentence in every language slot', () => {
  const s = REFUSAL_STRINGS.MERCHANT_IN_DEBT;
  assert.ok(s && s.ar && s.en && s.ckb);
});
