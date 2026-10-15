/**
 * Services S-P2 (DECISIONS row 238; spec §6.8, §13.2–§13.4) — completion on DELIVERY books the old
 * device into stock: the request completes when the order its credit paid for is delivered (the
 * delivered hook, idempotent), in one batch with the custody move, a HIDDEN used draft, its lot
 * `ilot_ti_<request>` at cost = the credit, the provenance row, stock +1 and the ledger row. The
 * manual door is the owner's, after delivery only. A delivered order that completed a trade-in is
 * returned, never cancelled. LOCAL ONLY.
 *
 * Run: node --import tsx --test tests/sv2_p2_completion.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, json, post, row } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { completeTradeInsForOrder, bookTradeInStock } from '../worker/lib/tradeInStock';
import { loadRequest } from '../worker/lib/tradeIn';
import { OWNER, STAFF, adminApp, approvedAndOrdered, checkoutBody, customerApp, daysAgo, delivered, received, restoreFetch, seed, settle, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const code = async (res: Response) => [res.status, (await json(res)).code] as const;
const req = (raw: DatabaseSync, id: string) => row<Record<string, any>>(raw, 'SELECT * FROM trade_in_requests WHERE id = ?', id)!;

test('M4/M5: completion waits for the delivery — then books exactly one lot ilot_ti_<id> at cost = the credit, one provenance row, stock +1, a ledger row and a HIDDEN used draft with no price', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  const credit = req(raw, id).credit_iqd as number;
  // Not delivered yet: the owner's manual door refuses; nobody else has one.
  assert.deepEqual(await code(await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/complete`)), [403, 'OWNER_REQUIRED']);
  assert.deepEqual(await code(await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/complete`)), [409, 'TRADE_IN_ORDER_NOT_DELIVERED']);
  assert.equal(req(raw, id).status, 'awaiting_payment');
  const lotsBefore = count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots');

  await delivered(raw, orderId);
  const r = req(raw, id);
  assert.equal(r.status, 'completed');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots'), lotsBefore + 1);
  const lot = row<Record<string, any>>(raw, 'SELECT * FROM inventory_lots WHERE id = ?', `ilot_ti_${id}`)!;
  assert.deepEqual([lot.product_id, lot.qty_received, lot.qty_remaining, lot.unit_cost_iqd, lot.total_cost_iqd, lot.cost_basis], [`prd_ti_${id}`, 1, 1, credit, credit, 'received']);
  const prov = row<Record<string, any>>(raw, 'SELECT * FROM trade_in_stock WHERE request_id = ?', id)!;
  assert.deepEqual([prov.lot_id, prov.product_id, prov.source_product_id, prov.cost_basis_iqd, prov.order_id], [`ilot_ti_${id}`, `prd_ti_${id}`, 'p_a1', credit, orderId]);
  const draft = row<Record<string, any>>(raw, 'SELECT * FROM products WHERE id = ?', `prd_ti_${id}`)!;
  assert.equal(draft.status, 'hidden');
  assert.equal(draft.stock, 1);
  assert.equal(draft.price_iqd, 0, 'the owner prices it in V2 before it lists');
  assert.equal(draft.product_cost_iqd, null);
  assert.equal(draft.options, '[]');
  assert.equal(draft.colors, '[]');
  assert.equal(draft.category_id, 'cat_used');
  assert.equal(draft.sub_category_id, 'cat_used_printers');
  const cond = JSON.parse(draft.condition_doc);
  assert.deepEqual([cond.kind, cond.grade, cond.warranty_months, cond.new_product_id, cond.unit_images], ['used', 'good', 1, 'p_a1', []]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE idempotency_key = ? AND kind = 'adjust_in' AND qty = 1", `trade_in_stock:${id}`), 1);
  assert.deepEqual(
    (raw.prepare("SELECT action FROM trade_in_events WHERE request_id = ? AND action IN ('complete','stock_booked') ORDER BY created_at, rowid").all(id) as Array<{ action: string }>).map((e) => e.action),
    ['complete', 'stock_booked']
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = ?', `trade_in:${id}:completed`), 1);

  // Idempotent: the hook again, the sweep's catch-up, the stock booking — nothing twice.
  const env = { DB: asD1(raw) } as never;
  assert.deepEqual(await completeTradeInsForOrder(env, orderId), []);
  assert.equal(await bookTradeInStock(env, (await loadRequest(asD1(raw), id))!), false);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots WHERE id = ?', `ilot_ti_${id}`), 1);
  assert.equal(row<{ stock: number }>(raw, 'SELECT stock FROM products WHERE id = ?', `prd_ti_${id}`)!.stock, 1);
  // The provenance and the lot's cost are never rewritten.
  assert.throws(() => raw.exec(`UPDATE trade_in_stock SET cost_basis_iqd = 1 WHERE request_id = '${id}'`), /TRADE_IN_STOCK_IMMUTABLE/);
  assert.throws(() => raw.exec(`UPDATE inventory_lots SET unit_cost_iqd = 1 WHERE id = 'ilot_ti_${id}'`), /BATCH_COST_IMMUTABLE/);
  // A delivered order that completed a trade-in is returned, never cancelled.
  assert.throws(() => raw.exec(`UPDATE orders SET status = 'cancelled' WHERE id = '${orderId}'`), /TRADE_IN_ORDER_DELIVERED/);
});

test('the owner completes by hand only after delivery; a zero credit has nothing to wait for', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  // Delivered without the hook (an order flipped by a door that predates it): the owner's door completes it.
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), orderId);
  const done = await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/complete`);
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal(req(raw, id).status, 'completed');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_stock WHERE request_id = ?', id), 1);
  const audit = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'trade_in.complete' AND target = ?", id)!.detail);
  assert.equal(audit.via, 'manual');
});

test('cut-over: a request completed before S-P2 without its device books the stock when the device is received', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const offer = req(raw, id).offer_iqd as number;
  raw.prepare(`UPDATE trade_in_requests SET status = 'completed', completed_at = ?, final_value_iqd = ?, credit_iqd = ? WHERE id = ?`).run(daysAgo(2), offer, offer, id);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_stock WHERE request_id = ?', id), 0);
  const body = await received(raw, id);
  assert.equal(body.request.status, 'completed');
  const prov = row<{ cost_basis_iqd: number; lot_id: string }>(raw, 'SELECT cost_basis_iqd, lot_id FROM trade_in_stock WHERE request_id = ?', id)!;
  assert.deepEqual([prov.cost_basis_iqd, prov.lot_id], [offer, `ilot_ti_${id}`]);
  assert.equal(row<{ stock: number }>(raw, 'SELECT stock FROM products WHERE id = ?', `prd_ti_${id}`)!.stock, 1);
});

test('concurrency: the delivered hook and the sweep complete the same request at once — one completion, one lot', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), orderId);
  const env = { DB: serialD1(raw) } as never;
  const [a, b] = await Promise.all([completeTradeInsForOrder(env, orderId), completeTradeInsForOrder(env, orderId)]);
  assert.equal(a.length + b.length, 1);
  assert.equal(req(raw, id).status, 'completed');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots WHERE id = ?', `ilot_ti_${id}`), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_events WHERE request_id = ? AND action = 'complete'", id), 1);
});

test('an undelivered order’s cancel before completion leaves the request awaiting payment with its credit back (no stock, no completion)', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  raw.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(new Date().toISOString(), orderId);
  const env = { DB: asD1(raw) } as never;
  assert.deepEqual(await completeTradeInsForOrder(env, orderId), []);
  const r = req(raw, id);
  assert.equal(r.status, 'awaiting_payment');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_stock WHERE request_id = ?', id), 0);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', orderId)!.state, 'released');
  void received;
});

test('review F-11: the lot costs what the credit actually took off the order — a reprice between the value and the checkout leaves part unused, and the stock does not carry it', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id);
  const ap = await json(await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/approve`));
  assert.equal(ap.request.status, 'awaiting_payment', JSON.stringify(ap));
  const credit = ap.request.credit_iqd as number;
  const { repriceV2 } = await import('./fixtures/v2Publish');
  await repriceV2(raw, 'p_p1s', 400_000);
  assert.ok(credit > 400_000, 'the credit is worth more than the repriced target');
  const a = customerApp(raw);
  const pay = await json(await post(a, `/api/trade-in/requests/${id}/checkout`));
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty) VALUES ('c_x','cust','p_p1s','','[]','','','','',1)`);
  const placed = await post(a, '/api/orders', checkoutBody({ couponCode: pay.coupon_code }));
  const pb = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(pb));
  await settle();
  await delivered(raw, pb.order.id);
  const spent = JSON.parse(row<{ coupon_snapshot: string }>(raw, 'SELECT coupon_snapshot FROM orders WHERE id = ?', pb.order.id)!.coupon_snapshot).discount_iqd as number;
  assert.equal(spent, 400_000);
  assert.equal(row<{ cost_basis_iqd: number }>(raw, 'SELECT cost_basis_iqd FROM trade_in_stock WHERE request_id = ?', id)!.cost_basis_iqd, spent);
  const lot = row<{ unit_cost_iqd: number; total_cost_iqd: number }>(raw, 'SELECT unit_cost_iqd, total_cost_iqd FROM inventory_lots WHERE id = ?', `ilot_ti_${id}`)!;
  assert.deepEqual([lot.unit_cost_iqd, lot.total_cost_iqd], [spent, spent]);
});
