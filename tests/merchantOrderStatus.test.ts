/**
 * A STORE ORDER'S STATUS, MOVED BY ITS MERCHANT — counted once, and told.
 *
 * Two defects in `POST /api/merchant/orders/:id/status`, both invisible from
 * the merchant's own screen:
 *
 *   1. THE COMPLETION WAS COUNTED TWICE ON A DOUBLE TAP. Both taps pass the
 *      flow check on the same stale `shipped`; the conditional flip lets only
 *      one through — but the reputation INSERT and `completed_orders + 1` beside
 *      it were unconditional, so the loser's batch still committed them.
 *   2. THE BUYER WAS NEVER TOLD. The route flipped the status and notified
 *      nobody, so a community-store customer heard nothing between «تم استلام
 *      طلبك» and the parcel at the door.
 *
 * Run: node --import tsx --test tests/merchantOrderStatus.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, failingD1, asD1, stubApp, post, get, json, pending, count } from './fixtures/app';
import { merchantRoutes } from '../worker/routes/merchant';

function seed(status: string): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES
      ('buyer','Sara','buyer@x.co','h','customer','2026-01-01T00:00:00.000Z','ar'),
      ('ali','Ali','ali@x.co','h','merchant',NULL,'ar');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings)
      VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{}');
    INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,order_id)
      VALUES ('pl1','m_ali','sale_credit',9000,'pending','ORD-M1');
  `);
  raw
    .prepare(
      `INSERT INTO orders
         (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
          subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage,merchant_id,seller_type)
       VALUES ('ORD-M1','buyer',?, '{}','merchant','{}','wallet',10000,1400,10000,0,'direct','received','m_ali','merchant')`
    )
    .run(status);
  return raw;
}

const merchantApp = (db: D1Database) =>
  stubApp(db, { id: 'ali', role: 'merchant', email: 'ali@x.co' }, (a) => a.route('/api/merchant', merchantRoutes));

const completed = (raw: DatabaseSync) =>
  (raw.prepare("SELECT completed_orders AS n FROM community_merchants WHERE id = 'm_ali'").get() as { n: number }).n;
const reputation = (raw: DatabaseSync) =>
  count(raw, "SELECT COUNT(*) AS n FROM merchant_reputation_events WHERE order_id = 'ORD-M1' AND kind = 'order_completed'");

test('A NORMAL DELIVERY counts the completion ONCE — and does NOT free the payout', async () => {
  const raw = seed('shipped');
  const res = await post(merchantApp(asD1(raw)), '/api/merchant/orders/ORD-M1/status', { status: 'delivered' });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  await Promise.all(pending.splice(0));
  assert.equal(completed(raw), 1);
  assert.equal(reputation(raw), 1);
  // The owner's rule (docs/MERCHANT_PLATFORM.md §2): the merchant's own
  // «تم التسليم» never releases money — the customer's confirmation, or three
  // days after delivery, does (tests/storeOrderRelease.test.ts).
  assert.equal((raw.prepare("SELECT state FROM merchant_payout_ledger WHERE id = 'pl1'").get() as { state: string }).state, 'pending');
});

test('THE DOUBLE TAP — the tap that LOST the race adds no completion and no reputation, and says so', async () => {
  const raw = seed('shipped');
  const { failing, db } = failingD1(raw);
  // The OTHER tap wins between this request's read of `shipped` and its batch:
  // exactly what two taps a few milliseconds apart do. Everything the winner's
  // batch wrote is written here, once.
  let raced = false;
  failing.beforeBatch = (stmts) => {
    if (raced || !stmts.some((s) => /UPDATE orders SET status/.test(s.sql))) return;
    raced = true;
    raw.exec(`
      UPDATE orders SET status = 'delivered' WHERE id = 'ORD-M1';
      UPDATE merchant_payout_ledger SET state = 'available' WHERE id = 'pl1';
      INSERT INTO merchant_reputation_events (id,merchant_id,kind,points,order_id) VALUES ('rep_w','m_ali','order_completed',10,'ORD-M1');
      UPDATE community_merchants SET completed_orders = completed_orders + 1 WHERE id = 'm_ali';
    `);
  };
  const res = await post(merchantApp(db), '/api/merchant/orders/ORD-M1/status', { status: 'delivered' });
  assert.ok(raced, 'the race was staged');
  assert.equal(res.status, 409, 'the loser is told the order changed, not that it succeeded');
  assert.equal(completed(raw), 1, 'one delivery, one completed order');
  assert.equal(reputation(raw), 1, 'one delivery, one reputation line');
});

test('THE BUYER IS TOLD — a merchant confirming a store order reaches the customer\'s bell and channels', async () => {
  const raw = seed('pending');
  const res = await post(merchantApp(asD1(raw)), '/api/merchant/orders/ORD-M1/status', { status: 'confirmed' });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  await Promise.all(pending.splice(0));
  const bell = raw.prepare("SELECT title_ar FROM user_notifications WHERE user_id = 'buyer' AND event_key = 'order.status.confirmed:ORD-M1'").get() as
    | { title_ar: string }
    | undefined;
  assert.ok(bell, 'the in-app row exists');
  assert.match(bell!.title_ar, /تم تأكيد طلبك ORD-M1/);
  // The verified e-mail gets its row too (skipped on this deployment, which
  // has no provider — recorded, never silently dropped).
  assert.ok(raw.prepare("SELECT 1 FROM outbox WHERE event_key = 'order.status.confirmed:ORD-M1:email'").get());
});

test('`processing` is a warehouse fact on a store order too — no message', async () => {
  const raw = seed('confirmed');
  const res = await post(merchantApp(asD1(raw)), '/api/merchant/orders/ORD-M1/status', { status: 'processing' });
  assert.equal(res.status, 200);
  await Promise.all(pending.splice(0));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer'"), 0);
});

/**
 * B26 — THE ORDERS TAB READ THE FIRST 30 AND NEVER ASKED FOR MORE. The list is
 * paged by (created_at, id): every order comes back exactly once, in order,
 * including two that share an instant — which a timestamp-only cursor skips —
 * and the status filter holds across pages.
 */
test('B26 the merchant orders list pages through every order once, ties included', async () => {
  const raw = seed('pending');
  const add = raw.prepare(
    `INSERT INTO orders
       (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage,merchant_id,seller_type,created_at)
     VALUES (?,'buyer',?,'{}','merchant','{}','wallet',1000,1400,1000,0,'direct','received','m_ali','merchant',?)`
  );
  add.run('ORD-M2', 'pending', '2026-03-01T00:00:00.000Z');
  add.run('ORD-M3', 'delivered', '2026-03-01T00:00:00.000Z'); // the same instant as M2
  add.run('ORD-M4', 'pending', '2026-02-01T00:00:00.000Z');
  add.run('ORD-M5', 'pending', '2026-01-01T00:00:00.000Z');
  raw.exec("UPDATE orders SET created_at = '2026-04-01T00:00:00.000Z' WHERE id = 'ORD-M1'");
  const app = merchantApp(asD1(raw));

  const walk = async (filter: string) => {
    const seen: string[] = [];
    let cursor: string | null = '';
    for (let page = 0; cursor !== null && page < 10; page++) {
      const qs = new URLSearchParams({ limit: '2', ...(filter ? { status: filter } : {}), ...(cursor ? { cursor } : {}) });
      const body = await json(await get(app, `/api/merchant/orders?${qs}`));
      assert.equal(body.success, true, JSON.stringify(body));
      seen.push(...body.orders.map((o: { id: string }) => o.id));
      cursor = body.next_cursor;
    }
    return seen;
  };

  assert.deepEqual(await walk(''), ['ORD-M1', 'ORD-M3', 'ORD-M2', 'ORD-M4', 'ORD-M5'], 'newest first, ties by id, nothing twice');
  assert.deepEqual(await walk('pending'), ['ORD-M1', 'ORD-M2', 'ORD-M4', 'ORD-M5'], 'the filter holds on every page');
});
