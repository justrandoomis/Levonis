/**
 * A STORE SALE'S MONEY, LINE BY LINE, IN THE APPEND-ONLY MERCHANT LEDGER
 * (docs/MERCHANT_PLATFORM.md §4.3, the owner's rules of 2026-09-24):
 *
 *   · a sale is three lines — the goods, the 5% commission as its OWN line,
 *     the merchant's delivery fee as its own line — all pending;
 *   · the customer's «استلمت طلبي» or the three-day sweep moves them to
 *     available with a release pair; a replay moves nothing;
 *   · an open complaint or ticket freezes the release (reported as frozen);
 *   · a cancel undoes the sale with refund lines — in pending, or as a
 *     claw-back from available after the release;
 *   · every figure of the finance summary is the ledger's own sum, and the
 *     finance API is the merchant's own, paged, filtered, linked.
 *
 * Run: node --import tsx --test tests/merchantLedgerFlows.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, all, row, pending } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { orderRoutes } from '../worker/routes/orders';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantFinanceRoutes, merchantPayoutRoutes } from '../worker/routes/merchantFinance';
import { releaseDueStoreCredits, STORE_RELEASE_DAYS } from '../worker/lib/storeOrderOps';
import { financeSummary, merchantBuckets } from '../worker/lib/merchantLedger';
import type { Env } from '../worker/lib/types';

const FUTURE = '2099-01-01T00:00:00.000Z';
const DAY = 86_400_000;

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('ali','Ali','ali@x.co','h','merchant'), ('zed','Zed','zed@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_zed','zed','Zed','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings)
      VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{"fee_iqd":2000}'), ('s_zed','m_zed','zed','zed3d','Zed','active','{}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,100,0);
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES ('dep','buyer','deposit','USD',100000,'approved','seed');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
  `);
}

const buyer = (db: D1Database) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
    a.route('/api/orders', orderRoutes);
  });
const merchant = (db: D1Database, id = 'ali') =>
  stubApp(db, { id, role: 'merchant', email: `${id}@x.co` }, (a) => {
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/merchant/finance', merchantFinanceRoutes);
    a.route('/api/merchant/payouts', merchantPayoutRoutes);
  });
const env = (raw: DatabaseSync) => ({ DB: asD1(raw) } as unknown as Env);

async function placeOrder(raw: DatabaseSync): Promise<string> {
  const app = buyer(asD1(raw));
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 })).status, 201);
  const q = await json(await post(app, '/api/store-orders/quote', { addressId: 'a1' }));
  const res = await post(app, '/api/store-orders', {
    idempotencyKey: `flow-${Math.random().toString(36).slice(2, 10)}`, addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint,
  });
  const body = await json(res);
  assert.equal(res.status, 201, JSON.stringify(body));
  await Promise.allSettled(pending.splice(0));
  return String(body.order.id);
}

async function deliver(raw: DatabaseSync, id: string) {
  const m = merchant(asD1(raw));
  for (const s of ['confirmed', 'processing', 'shipped', 'delivered']) {
    assert.equal((await post(m, `/api/merchant/orders/${id}/status`, { status: s })).status, 200, s);
  }
  await Promise.allSettled(pending.splice(0));
}

const linesOf = (raw: DatabaseSync, id: string) =>
  all<{ kind: string; bucket: string; amount_iqd: number }>(
    raw, 'SELECT kind, bucket, amount_iqd FROM merchant_ledger_entries WHERE order_id = ? ORDER BY created_at, kind, bucket', id
  );
const bucketOf = (raw: DatabaseSync, id: string, bucket: string) =>
  row<{ s: number }>(raw, 'SELECT COALESCE(SUM(amount_iqd), 0) AS s FROM merchant_ledger_entries WHERE order_id = ? AND bucket = ?', id, bucket)!.s;

test('a sale is three lines — goods, the 5% commission of its own, the delivery fee — all pending, summing to the receivable', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw);
  assert.deepEqual(linesOf(raw, id), [
    { kind: 'commission', bucket: 'pending', amount_iqd: -700 },
    { kind: 'delivery_fee', bucket: 'pending', amount_iqd: 2000 },
    { kind: 'sale_gross', bucket: 'pending', amount_iqd: 14000 },
  ]);
  const o = row<{ merchant_receivable_iqd: number }>(raw, 'SELECT merchant_receivable_iqd FROM orders WHERE id = ?', id)!;
  assert.equal(bucketOf(raw, id, 'pending'), o.merchant_receivable_iqd);
  assert.deepEqual(await merchantBuckets(asD1(raw), 'm_ali'), { pending: 15300, available: 0, reserved: 0, paid: 0 });
});

test('the customer’s «استلمت طلبي» moves it to available with one release pair — a replay moves nothing', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw);
  await deliver(raw, id);
  assert.equal(bucketOf(raw, id, 'available'), 0, '«تم التسليم» is not money');
  const app = buyer(asD1(raw));
  assert.equal((await json(await post(app, `/api/orders/${id}/confirm-receipt`, {}))).released, true);
  assert.equal((await json(await post(app, `/api/orders/${id}/confirm-receipt`, {}))).replayed, true);
  const rel = all<{ bucket: string; amount_iqd: number }>(raw, "SELECT bucket, amount_iqd FROM merchant_ledger_entries WHERE order_id = ? AND kind = 'release' ORDER BY bucket", id);
  assert.deepEqual(rel, [{ bucket: 'available', amount_iqd: 15300 }, { bucket: 'pending', amount_iqd: -15300 }]);
  assert.equal(bucketOf(raw, id, 'pending'), 0);
  assert.equal(bucketOf(raw, id, 'available'), 15300);
});

test('three days after delivery the sweep releases; an open ticket FREEZES it and the summary says how much is frozen', async () => {
  const raw = freshDb();
  seed(raw);
  const free = await placeOrder(raw);
  const held = await placeOrder(raw);
  await deliver(raw, free);
  await deliver(raw, held);
  const ago = new Date(Date.now() - (STORE_RELEASE_DAYS + 1) * DAY).toISOString();
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id IN (?, ?)').run(ago, free, held);
  raw.prepare(`INSERT INTO support_tickets (id,user_id,subject,order_id,state) VALUES ('t1','buyer','broken',?,'open')`).run(held);

  const r = await releaseDueStoreCredits(env(raw), new Date().toISOString());
  assert.deepEqual(r, { released: 1, frozen: 1, refund_blocked: 0, errors: 0 });
  assert.equal(bucketOf(raw, free, 'available'), 15300);
  assert.equal(bucketOf(raw, held, 'pending'), 15300);
  const s = await financeSummary(asD1(raw), 'm_ali');
  assert.equal(s.pending_frozen, 15300, 'the frozen part of pending is named');
  assert.equal((await releaseDueStoreCredits(env(raw), new Date().toISOString())).released, 0, 'nothing twice');
});

test('a cancel undoes the sale with refund lines — in pending before the release, as a claw-back from available after it', async () => {
  const raw = freshDb();
  seed(raw);
  const early = await placeOrder(raw);
  assert.equal((await post(merchant(asD1(raw)), `/api/merchant/orders/${early}/status`, { status: 'cancelled' })).status, 200);
  assert.deepEqual(
    all(raw, "SELECT kind, bucket, amount_iqd FROM merchant_ledger_entries WHERE order_id = ? AND kind LIKE '%refund' ORDER BY kind", early),
    [
      { kind: 'commission_refund', bucket: 'pending', amount_iqd: 700 },
      { kind: 'delivery_refund', bucket: 'pending', amount_iqd: -2000 },
      { kind: 'refund', bucket: 'pending', amount_iqd: -14000 },
    ]
  );
  assert.equal(bucketOf(raw, early, 'pending'), 0);

  const late = await placeOrder(raw);
  await deliver(raw, late);
  await post(buyer(asD1(raw)), `/api/orders/${late}/confirm-receipt`, {});
  // An admin later cancels (a dispute lost): the released money comes back out of available.
  const { adminRoutes } = await import('../worker/routes/admin');
  const admin = stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin', adminRoutes));
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Boss','boss@x.co','h','admin')");
  const { patch } = await import('./fixtures/app');
  assert.equal((await patch(admin, `/api/admin/orders/${late}`, { status: 'shipped' })).status, 200);
  assert.equal((await patch(admin, `/api/admin/orders/${late}`, { status: 'cancelled' })).status, 200);
  await Promise.allSettled(pending.splice(0));
  assert.equal(bucketOf(raw, late, 'available'), 0, 'clawed back');
  const s = await financeSummary(asD1(raw), 'm_ali');
  assert.equal(s.refunds, 32000, 'two sales of 14,000 goods + 2,000 delivery returned');
  assert.equal(s.commission, 0, 'the platform gave its commission back on both');
  assert.equal(s.receivable, 0);
});

test('the summary is the ledger’s own sum; the finance API is the merchant’s own, paged, filtered and linked', async () => {
  const raw = freshDb();
  seed(raw);
  const a = await placeOrder(raw);
  const b = await placeOrder(raw);
  await deliver(raw, a);
  await post(buyer(asD1(raw)), `/api/orders/${a}/confirm-receipt`, {});
  const m = merchant(asD1(raw));
  const sum = await json(await get(m, '/api/merchant/finance/summary'));
  assert.equal(sum.success, true);
  const s = sum.summary;
  const total = row<{ t: number }>(raw, "SELECT SUM(amount_iqd) AS t FROM merchant_ledger_entries WHERE merchant_id = 'm_ali'")!.t;
  assert.equal(s.receivable, total, 'receivable is every line summed');
  assert.equal(s.receivable, s.pending + s.available + s.reserved + s.paid_out);
  assert.equal(s.receivable, s.gross - s.commission + s.delivery_fees - s.refunds + s.adjustments);
  assert.deepEqual([s.gross, s.commission, s.delivery_fees, s.pending, s.available], [28000, 1400, 4000, 15300, 15300]);

  // Paged newest first, every line linked to its order.
  const p1 = await json(await get(m, '/api/merchant/finance/ledger?limit=4'));
  assert.equal(p1.entries.length, 4);
  assert.ok(p1.next_cursor);
  const p2 = await json(await get(m, `/api/merchant/finance/ledger?limit=4&cursor=${encodeURIComponent(p1.next_cursor)}`));
  const ids = [...p1.entries, ...p2.entries].map((e: { id: string }) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no line twice across pages');
  assert.equal(ids.length, 8, '3 + 3 sale lines and one release pair');
  assert.ok([...p1.entries, ...p2.entries].every((e: { link: { type: string; id: string } }) => e.link.type === 'order' && [a, b].includes(e.link.id)));
  const onlyCommission = await json(await get(m, '/api/merchant/finance/ledger?kind=commission'));
  assert.deepEqual(onlyCommission.entries.map((e: { amount_iqd: number }) => e.amount_iqd), [-700, -700]);
  const future = await json(await get(m, '/api/merchant/finance/ledger?from=2099-01-01'));
  assert.equal(future.entries.length, 0);
  const bad = await get(m, '/api/merchant/finance/ledger?kind=everything');
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'INVALID_FILTER');

  // Another merchant sees none of it.
  const zed = merchant(asD1(raw), 'zed');
  assert.equal((await json(await get(zed, '/api/merchant/finance/ledger'))).entries.length, 0);
  assert.equal((await json(await get(zed, '/api/merchant/finance/summary'))).summary.receivable, 0);
});
