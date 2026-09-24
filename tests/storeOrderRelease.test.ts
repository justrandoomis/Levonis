/**
 * «تم التسليم» IS NOT MONEY — the owner's completion rule for community-store
 * orders (docs/MERCHANT_PLATFORM.md §2, 2026-09-24), and the lifecycle facts
 * the merchant's own moves now write (audit 02 B9, B10, B23; audit 01 B11).
 *
 *   · a merchant's move writes `stage`, an `order_status_history` row and —
 *     on delivery — `delivered_at`, once; the customer's tracker follows it;
 *   · the sale credit stays PENDING on delivery; the CUSTOMER's confirmation
 *     releases it, or the cron three days after delivery — unless a complaint
 *     or support ticket is open on the order, which freezes it;
 *   · the merchant is told about a new order (their preference honoured);
 *   · an admin marking a store order delivered grants no platform points;
 *   · a store order is not returned through Levonis's returns desk.
 *
 * Run: node --import tsx --test tests/storeOrderRelease.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, patch, get, json, count, row, pending } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { orderRoutes } from '../worker/routes/orders';
import { merchantRoutes } from '../worker/routes/merchant';
import { adminRoutes } from '../worker/routes/admin';
import { returnRoutes } from '../worker/routes/returns';
import { releaseDueStoreCredits, STORE_RELEASE_DAYS } from '../worker/lib/storeOrderOps';
import type { Env } from '../worker/lib/types';

const DEP = 100_000;
const FUTURE = '2099-01-01T00:00:00.000Z';
const DAY = 86_400_000;

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'),
      ('other','Omar','other@x.co','h','customer'),
      ('ali','Ali','ali@x.co','h','merchant'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings)
      VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,100,0);
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('dep_buyer','buyer','deposit','USD',${DEP},'approved','seed');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
  `);
}

const buyerApp = (db: D1Database, id = 'buyer') =>
  stubApp(db, { id, role: 'customer', email: `${id}@x.co` }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/returns', returnRoutes);
  });
const merchantApp = (db: D1Database) =>
  stubApp(db, { id: 'ali', role: 'merchant', email: 'ali@x.co' }, (a) => a.route('/api/merchant', merchantRoutes));
const adminApp = (db: D1Database) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin', adminRoutes));

async function placeOrder(raw: DatabaseSync): Promise<string> {
  const app = buyerApp(asD1(raw));
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 })).status, 201);
  const q = await json(await post(app, '/api/store-orders/quote', {}));
  const res = await post(app, '/api/store-orders', {
    idempotencyKey: `rel-${Math.random().toString(36).slice(2, 10)}`, addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint,
  });
  const body = await json(res);
  assert.equal(res.status, 201, JSON.stringify(body));
  await Promise.allSettled(pending.splice(0));
  return String(body.order.id);
}

async function deliver(raw: DatabaseSync, id: string) {
  const m = merchantApp(asD1(raw));
  for (const s of ['confirmed', 'processing', 'shipped', 'delivered']) {
    const res = await post(m, `/api/merchant/orders/${id}/status`, { status: s });
    assert.equal(res.status, 200, `${s}: ${JSON.stringify(await json(res))}`);
  }
  await Promise.allSettled(pending.splice(0));
}

const creditState = (raw: DatabaseSync, id: string) =>
  row<{ state: string }>(raw, "SELECT state FROM merchant_payout_ledger WHERE order_id = ? AND kind = 'sale_credit'", id)!.state;
const env = (raw: DatabaseSync) => ({ DB: asD1(raw) } as unknown as Env);
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

// ====================================================== the merchant's moves

test('B9 a merchant’s moves write stage, the history and delivered_at — the customer’s tracker follows them', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw);
  await deliver(raw, id);

  const o = row<{ status: string; stage: string; delivered_at: string | null }>(raw, 'SELECT status, stage, delivered_at FROM orders WHERE id = ?', id)!;
  assert.equal(o.status, 'delivered');
  assert.equal(o.stage, 'delivered');
  assert.ok(o.delivered_at, 'the three days have a clock');
  const stages = raw.prepare('SELECT stage FROM order_status_history WHERE order_id = ? ORDER BY changed_at, rowid').all(id).map((r) => (r as { stage: string }).stage);
  assert.deepEqual(stages, ['confirmed', 'preparing', 'out_for_delivery', 'delivered']);

  const tracking = await json(await get(buyerApp(asD1(raw)), `/api/orders/${id}/tracking`));
  assert.equal(tracking.stage, 'delivered', 'no longer «تم استلام الطلب» for ever');
  assert.ok(tracking.steps.every((s: { reached: boolean }) => s.reached));
});

test('B10 «تم التسليم» by the merchant does NOT make the money available', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw);
  await deliver(raw, id);
  assert.equal(creditState(raw, id), 'pending');
  const payouts = await json(await get(merchantApp(asD1(raw)), '/api/merchant/payouts'));
  assert.equal(payouts.balance.available_iqd, 0);
  assert.equal(payouts.balance.pending_iqd, 13300);
  const detail = await json(await get(merchantApp(asD1(raw)), `/api/merchant/orders/${id}`));
  assert.equal(detail.order.credit_state, 'pending');
  assert.ok(detail.order.release_after, 'the merchant is told when it releases on its own');
});

// ===================================================== the customer confirms

test('the CUSTOMER’s «استلمت طلبي» releases the credit — once', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw);
  const app = buyerApp(asD1(raw));

  const early = await post(app, `/api/orders/${id}/confirm-receipt`, {});
  assert.equal(early.status, 409, 'nothing to confirm before delivery');
  assert.equal((await json(early)).code, 'ORDER_NOT_DELIVERED');

  await deliver(raw, id);
  const view = await json(await get(app, `/api/orders/${id}`));
  assert.equal(view.order.receipt.can_confirm, true);
  const autoAt = Date.parse(view.order.receipt.auto_confirms_at);
  const deliveredAt = Date.parse(String(row<{ delivered_at: string }>(raw, 'SELECT delivered_at FROM orders WHERE id = ?', id)!.delivered_at));
  assert.equal(autoAt - deliveredAt, STORE_RELEASE_DAYS * DAY, 'the date the page shows is the sweep’s own');

  const stranger = await post(buyerApp(asD1(raw), 'other'), `/api/orders/${id}/confirm-receipt`, {});
  assert.equal(stranger.status, 404, 'only the buyer confirms');

  const ok = await json(await post(app, `/api/orders/${id}/confirm-receipt`, {}));
  assert.deepEqual(ok, { success: true, replayed: false, released: true });
  assert.equal(creditState(raw, id), 'available');
  const again = await json(await post(app, `/api/orders/${id}/confirm-receipt`, {}));
  assert.equal(again.replayed, true);
  assert.equal(again.released, false);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'store_order.receipt_confirmed'"), 1);
  assert.equal((await json(await get(app, `/api/orders/${id}`))).order.receipt.can_confirm, false);
});

test('a platform order has no receipt to confirm (stable code)', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
            VALUES ('ORD-P1','buyer','delivered','{}','standard','{}','cod',5000,1400,5000,5000)`);
  const res = await post(buyerApp(asD1(raw)), '/api/orders/ORD-P1/confirm-receipt', {});
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'RECEIPT_NOT_APPLICABLE');
});

// ============================================================ the three days

test('three days after delivery with no open complaint, the sweep releases the credit — idempotently, audited', async () => {
  const raw = freshDb();
  seed(raw);
  const young = await placeOrder(raw);
  const old = await placeOrder(raw);
  await deliver(raw, young);
  await deliver(raw, old);
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(ago(STORE_RELEASE_DAYS + 1), old);
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(ago(STORE_RELEASE_DAYS - 1), young);

  const first = await releaseDueStoreCredits(env(raw), new Date().toISOString());
  assert.deepEqual(first, { released: 1, frozen: 0, refund_blocked: 0, errors: 0 });
  assert.equal(creditState(raw, old), 'available');
  assert.equal(creditState(raw, young), 'pending', 'two days is not three');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'store_order.credit_released' AND target = ?", old), 1);

  const second = await releaseDueStoreCredits(env(raw), new Date().toISOString());
  assert.deepEqual(second, { released: 0, frozen: 0, refund_blocked: 0, errors: 0 }, 'nothing is released twice');
});

test('an open support ticket or complaint on the order FREEZES the release; resolving it lets it go', async () => {
  const raw = freshDb();
  seed(raw);
  const byTicket = await placeOrder(raw);
  const byComplaint = await placeOrder(raw);
  await deliver(raw, byTicket);
  await deliver(raw, byComplaint);
  for (const id of [byTicket, byComplaint]) raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(ago(10), id);
  raw.prepare(`INSERT INTO support_tickets (id,user_id,subject,order_id,state) VALUES ('t1','buyer','Broken spool',?,'open')`).run(byTicket);
  raw.prepare(`INSERT INTO community_complaints (id,reporter_id,merchant_id,store_id,order_id,category,description,status)
               VALUES ('cmp1','buyer','m_ali','s_ali',?,'order','never arrived','under_review')`).run(byComplaint);

  const frozen = await releaseDueStoreCredits(env(raw), new Date().toISOString());
  assert.deepEqual(frozen, { released: 0, frozen: 2, refund_blocked: 0, errors: 0 });
  assert.equal(creditState(raw, byTicket), 'pending');
  assert.equal(creditState(raw, byComplaint), 'pending');

  raw.exec("UPDATE support_tickets SET state = 'resolved' WHERE id = 't1'");
  raw.exec("UPDATE community_complaints SET status = 'resolved' WHERE id = 'cmp1'");
  const released = await releaseDueStoreCredits(env(raw), new Date().toISOString());
  assert.deepEqual(released, { released: 2, frozen: 0, refund_blocked: 0, errors: 0 });
});

test('an order moved back from delivered is not released by the sweep', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw);
  await deliver(raw, id);
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(ago(10), id);
  assert.equal((await patch(adminApp(asD1(raw)), `/api/admin/orders/${id}`, { status: 'shipped' })).status, 200);
  await Promise.allSettled(pending.splice(0));
  const res = await releaseDueStoreCredits(env(raw), new Date().toISOString());
  assert.equal(res.released, 0);
  assert.equal(creditState(raw, id), 'pending');
});

// ============================================================ the admin door

test('an admin marking a store order delivered starts the same clock — and grants no Levonis purchase points', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw);
  const res = await patch(adminApp(asD1(raw)), `/api/admin/orders/${id}`, { status: 'delivered' });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  await Promise.allSettled(pending.splice(0));
  assert.equal(creditState(raw, id), 'pending', 'released by the customer or the three days, like any delivery');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id = 'buyer' AND currency = 'POINT'"), 0,
    'a merchant’s goods earn no Levonis points');
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(ago(4), id);
  assert.equal((await releaseDueStoreCredits(env(raw), new Date().toISOString())).released, 1, 'the admin’s delivery is not stuck pending for ever (A2)');
});

// ================================================================ the returns desk

test('a store order is not returned through Levonis’s returns desk — the customer is sent to support', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw);
  await deliver(raw, id);
  const itemId = row<{ id: string }>(raw, 'SELECT id FROM order_items WHERE order_id = ?', id)!.id;
  const res = await post(buyerApp(asD1(raw)), '/api/returns', { orderItemId: itemId, reason: 'defective' });
  const body = await json(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'STORE_ORDER_RETURN_VIA_SUPPORT');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM return_cases'), 0);
});

// ================================================================ B23

test('B23 the merchant is told about a new order — unless they switched new-order notices off', async () => {
  const raw = freshDb();
  seed(raw);
  const first = await placeOrder(raw);
  const bell = row<{ link: string; kind: string; title_ar: string }>(
    raw, "SELECT link, kind, title_ar FROM user_notifications WHERE user_id = 'ali' AND event_key = ?", `store_order.new:${first}`
  )!;
  assert.equal(bell.link, '/merchant');
  assert.equal(bell.kind, 'order_update');
  assert.match(bell.title_ar, new RegExp(first));

  raw.exec(`INSERT INTO merchant_notification_preferences (merchant_id, new_orders) VALUES ('m_ali', 0)`);
  const second = await placeOrder(raw);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE user_id = 'ali' AND event_key = ?", `store_order.new:${second}`), 0);
});
