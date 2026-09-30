/**
 * THE BULK MOVE — POST /api/merchant/orders/bulk-status (merchant platform v2
 * §4.2, P3b): the single transition repeated per id, and nothing more.
 *
 *   ≤ 50 ids, or the whole request is refused (BULK_TOO_MANY);
 *   never a cancel (BULK_CANCEL_NOT_ALLOWED) — it refunds, one at a time;
 *   each id gets the single route's own verdict: moved, ORDER_TRANSITION_INVALID,
 *   ORDER_NOT_FOUND (also another store's order — the same 404 as no order);
 *   one history row and ONE customer notice per moved order, none for a refused one;
 *   a ship's tracking number lands on every moved order and reaches the
 *   customer's tracker as `tracking_no`.
 *
 * Run: node --import tsx --test tests/merchantOrdersBulk.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, pending, count, row } from './fixtures/app';
import { legacyLedgerWrite } from './fixtures/legacyLedger';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantOrderRoutes, BULK_MAX, BULK_TARGETS } from '../worker/routes/merchantOrders';
import { orderRoutes } from '../worker/routes/orders';

function seed(): DatabaseSync {
  const raw = freshDb();
  legacyLedgerWrite(raw, `
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES
      ('buyer','Sara','buyer@x.co','h','customer','2026-01-01T00:00:00.000Z','ar'),
      ('ali','Ali','ali@x.co','h','merchant',NULL,'ar'),
      ('omar','Omar','omar@x.co','h','merchant',NULL,'ar');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_omar','omar','Omar 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings)
      VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{}'), ('s_omar','m_omar','omar','omar3d','Omar 3D','active','{}');
  `);
  return raw;
}

function addOrder(raw: DatabaseSync, id: string, status: string, merchant = 'm_ali', created = '2026-03-01T00:00:00.000Z') {
  raw
    .prepare(
      `INSERT INTO orders
         (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
          subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage,merchant_id,seller_type,created_at)
       VALUES (?,'buyer',?,'{"governorate":"baghdad"}','merchant','{}','wallet',10000,1400,10000,0,'direct','received',?,'merchant',?)`
    )
    .run(id, status, merchant, created);
}

const merchantApp = (db: D1Database) =>
  stubApp(db, { id: 'ali', role: 'merchant', email: 'ali@x.co' }, (a) => {
    // Mounted as worker/index.ts mounts them: the single route's file first, then the orders sub-router.
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/merchant/orders', merchantOrderRoutes);
  });
const buyerApp = (db: D1Database) => stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/orders', orderRoutes));

const statusOf = (raw: DatabaseSync, id: string) => ({ ...row<{ status: string; t: string }>(raw, 'SELECT status, delivery_tracking_no AS t FROM orders WHERE id = ?', id)! });
const historyOf = (raw: DatabaseSync, id: string, status: string) =>
  count(raw, 'SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ? AND status = ?', id, status);
const noticesOf = (raw: DatabaseSync, id: string, status: string) =>
  count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer' AND event_key = ?", `order.status.${status}:${id}`);

test('the bulk targets are every forward step of the flow and never the cancel', () => {
  assert.deepEqual([...BULK_TARGETS].sort(), ['confirmed', 'delivered', 'processing', 'shipped']);
  assert.equal(BULK_MAX, 50);
});

test('MORE THAN 50 IDS is refused whole — nothing moves, nobody is told', async () => {
  const raw = seed();
  const ids: string[] = [];
  for (let i = 0; i < BULK_MAX + 1; i++) {
    ids.push(`ORD-B${i}`);
    addOrder(raw, `ORD-B${i}`, 'pending');
  }
  const res = await post(merchantApp(asD1(raw)), '/api/merchant/orders/bulk-status', { ids, status: 'confirmed' });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'BULK_TOO_MANY');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE status = 'confirmed'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_status_history'), 0);
});

test('A CANCEL IS NEVER BULK — it refunds, and stays one order at a time', async () => {
  const raw = seed();
  addOrder(raw, 'ORD-1', 'pending');
  const res = await post(merchantApp(asD1(raw)), '/api/merchant/orders/bulk-status', { ids: ['ORD-1'], status: 'cancelled' });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'BULK_CANCEL_NOT_ALLOWED');
  assert.equal(statusOf(raw, 'ORD-1').status, 'pending');
});

test('an empty list, a non-list and an unknown status are refused before anything is read', async () => {
  const raw = seed();
  addOrder(raw, 'ORD-1', 'pending');
  const app = merchantApp(asD1(raw));
  assert.equal((await json(await post(app, '/api/merchant/orders/bulk-status', { ids: [], status: 'confirmed' }))).code, 'BAD_IDS');
  assert.equal((await json(await post(app, '/api/merchant/orders/bulk-status', { ids: 'ORD-1', status: 'confirmed' }))).code, 'BAD_IDS');
  assert.equal((await json(await post(app, '/api/merchant/orders/bulk-status', { ids: ['ORD-1'], status: 'teleported' }))).code, 'BAD_STATUS');
  assert.equal(statusOf(raw, 'ORD-1').status, 'pending');
});

test('EACH ID GETS THE SINGLE TRANSITION\'S VERDICT: moved, invalid from its state, or not found (another store\'s too)', async () => {
  const raw = seed();
  addOrder(raw, 'ORD-A', 'pending');
  addOrder(raw, 'ORD-B', 'pending');
  addOrder(raw, 'ORD-C', 'shipped'); // shipped → confirmed is not a move
  addOrder(raw, 'ORD-E', 'pending', 'm_omar'); // another store's
  const res = await post(merchantApp(asD1(raw)), '/api/merchant/orders/bulk-status', {
    ids: ['ORD-A', 'ORD-C', 'ORD-B', 'ORD-D', 'ORD-E', 'ORD-A'],
    status: 'confirmed',
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'confirmed');
  assert.deepEqual(body.done, ['ORD-A', 'ORD-B'], 'moved once each, a duplicate id is one order');
  assert.deepEqual(body.refused, [
    { id: 'ORD-C', code: 'ORDER_TRANSITION_INVALID' },
    { id: 'ORD-D', code: 'ORDER_NOT_FOUND' },
    { id: 'ORD-E', code: 'ORDER_NOT_FOUND' },
  ]);
  assert.equal(statusOf(raw, 'ORD-A').status, 'confirmed');
  assert.equal(statusOf(raw, 'ORD-B').status, 'confirmed');
  assert.equal(statusOf(raw, 'ORD-C').status, 'shipped', 'the refused row did not stop the loop, and did not move');
  assert.equal(statusOf(raw, 'ORD-E').status, 'pending', 'another store\'s order is untouched');

  // One history row per moved order, none for the refused.
  assert.equal(historyOf(raw, 'ORD-A', 'confirmed'), 1);
  assert.equal(historyOf(raw, 'ORD-B', 'confirmed'), 1);
  assert.equal(historyOf(raw, 'ORD-C', 'confirmed'), 0);
  // ONE notice per moved order — the same event key as the single route, so a
  // replay is silent — and one audit row each, both written after the response
  // (the bulk door defers them, so the request holds only the transitions).
  await Promise.all(pending.splice(0));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'merchant.order_status'"), 2);
  assert.equal(noticesOf(raw, 'ORD-A', 'confirmed'), 1);
  assert.equal(noticesOf(raw, 'ORD-B', 'confirmed'), 1);
  assert.equal(noticesOf(raw, 'ORD-C', 'confirmed'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer'"), 2);
});

test('A BULK SHIP carries the tracking number to every moved order, its history row, and the customer\'s tracker', async () => {
  const raw = seed();
  addOrder(raw, 'ORD-A', 'processing');
  addOrder(raw, 'ORD-B', 'processing');
  addOrder(raw, 'ORD-C', 'pending'); // cannot ship yet
  const res = await post(merchantApp(asD1(raw)), '/api/merchant/orders/bulk-status', {
    ids: ['ORD-A', 'ORD-B', 'ORD-C'],
    status: 'shipped',
    tracking_no: '  TRK-9  ',
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.done, ['ORD-A', 'ORD-B']);
  assert.deepEqual(body.refused, [{ id: 'ORD-C', code: 'ORDER_TRANSITION_INVALID' }]);
  assert.deepEqual(statusOf(raw, 'ORD-A'), { status: 'shipped', t: 'TRK-9' }, 'trimmed, stored on the existing column');
  assert.deepEqual(statusOf(raw, 'ORD-B'), { status: 'shipped', t: 'TRK-9' });
  assert.deepEqual(statusOf(raw, 'ORD-C'), { status: 'pending', t: '' });
  const note = row<{ note: string }>(raw, "SELECT note FROM order_status_history WHERE order_id = 'ORD-A' AND status = 'shipped'")!.note;
  assert.match(note, /TRK-9/, 'the history row records that this move carried the number');

  // The customer's own tracker (worker/routes/orders.ts) already returns it as `tracking_no`.
  const tracker = await get(buyerApp(asD1(raw)), '/api/orders/ORD-A');
  assert.equal(tracker.status, 200, JSON.stringify(await tracker.clone().json()));
  assert.equal((await json(tracker)).order?.tracking_no, 'TRK-9');

  await Promise.all(pending.splice(0));
  assert.equal(noticesOf(raw, 'ORD-A', 'shipped'), 1);
  assert.equal(noticesOf(raw, 'ORD-B', 'shipped'), 1);
});

test('a tracking number over 60 characters is refused BEFORE any order moves; on a move that is not a ship it is ignored', async () => {
  const raw = seed();
  addOrder(raw, 'ORD-A', 'processing');
  addOrder(raw, 'ORD-B', 'pending');
  const app = merchantApp(asD1(raw));
  const long = await post(app, '/api/merchant/orders/bulk-status', { ids: ['ORD-A'], status: 'shipped', tracking_no: 'x'.repeat(61) });
  assert.equal(long.status, 400);
  assert.equal((await json(long)).code, 'TRACKING_NO_TOO_LONG');
  assert.equal(statusOf(raw, 'ORD-A').status, 'processing');

  const confirm = await post(app, '/api/merchant/orders/bulk-status', { ids: ['ORD-B'], status: 'confirmed', tracking_no: 'TRK-IGNORED' });
  assert.equal(confirm.status, 200);
  assert.deepEqual(statusOf(raw, 'ORD-B'), { status: 'confirmed', t: '' }, 'only a ship carries a tracking number');
});

test('the bulk door is the store owner\'s: a customer session is not a merchant', async () => {
  const raw = seed();
  addOrder(raw, 'ORD-A', 'pending');
  const res = await post(
    stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/merchant/orders', merchantOrderRoutes)),
    '/api/merchant/orders/bulk-status',
    { ids: ['ORD-A'], status: 'confirmed' }
  );
  assert.ok(res.status === 403 || res.status === 404, `a non-merchant is refused (${res.status})`);
  assert.equal(statusOf(raw, 'ORD-A').status, 'pending');
});
