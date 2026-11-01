/**
 * ONE UNIT, ONE FIGURE, THROUGH THE REAL DOORS (docs/SMART_PRICING.md §6.9;
 * migration 0218; review finding orders-1).
 *
 * TPU (`p_pre2`, labelled) and PETG (`p_pre`) bought by sea, cash on
 * delivery, through the real checkout; settled through the real confirm door
 * (and the customer's 0140 approval); delivered; each line returned through
 * the real refund door. For every line, the refund, trade-in's paid figure
 * (`loadOrdersPaidNet`, what tradeIn.ts values a unit from) and price
 * protection's settled baseline (`settledEstimatePaidUnit`) are the same
 * figure: the line's own final price — or, when the financial admin kept the
 * total and so absorbed the final (ABSORBED), what was charged for the line.
 *
 * Run: node --import tsx --test tests/priceEstimateReturnsFlow.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { seedCatalogue, orderBody } from './lib/bundles';
import { publishSeededV2 } from './fixtures/autoPublish';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { returnRoutes } from '../worker/routes/returns';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../worker/routes/orderPriceAdjust';
import { loadOrdersPaidNet } from '../worker/lib/paidNet';
import { orderEstimateFacts, settledEstimatePaidUnit } from '../worker/lib/protectionClaims';
import { paidNetPerUnit } from '../packages/pricing/src/paidNet';
import type { GoodsLine } from '../worker/lib/orderProfit';
import { ESTIMATE_NOTICE_VERSION } from '../packages/contracts/src/priceEstimates';

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };

// Nothing leaves the process (the proposal's notices).
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function label(raw: DatabaseSync, pid: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';`);
}

async function world(labelPetg: boolean) {
  const raw = seedCatalogue();
  await publishSeededV2(raw);
  label(raw, 'p_pre2');
  if (labelPetg) label(raw, 'p_pre');
  for (const [id, pid] of [['ci_tpu', 'p_pre2'], ['ci_petg', 'p_pre']]) {
    raw
      .prepare(
        `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty,fulfillment_type)
         VALUES (?,'buyer',?,'','[]','','','sea','',1,'pre_order')`
      )
      .run(id, pid);
  }
  const db = asD1(raw);
  const buyer = stubApp(db, BUYER, (a) => {
    a.route('/api/orders', orderRoutes);
    a.route('/api/orders', orderPriceRoutes);
  }, { publishV2: false });
  const admin = stubApp(db, OWNER, (a) => {
    a.route('/api/admin/orders', adminOrderPriceRoutes);
    a.route('/api/admin', adminRoutes);
    a.route('/api/returns', returnRoutes);
  }, { publishV2: false });
  const res = await post(buyer, '/api/orders', orderBody({ price_estimate_ack: ESTIMATE_NOTICE_VERSION }));
  const placed = await json(res);
  assert.equal(res.status, 200, JSON.stringify(placed).slice(0, 400));
  const orderId = String(placed.order.id);
  const items = all<Rec>(raw, 'SELECT * FROM order_items WHERE order_id = ?', orderId);
  const tpu = items.find((i) => i.product_id === 'p_pre2')!;
  const petg = items.find((i) => i.product_id === 'p_pre')!;
  return { raw, db, buyer, admin, orderId, tpu, petg };
}
type World = Awaited<ReturnType<typeof world>>;

/** `newTotal`: the financial admin's own total (`new_total_iqd`), when one is typed. */
async function confirm(w: World, key: string, lines: Array<{ order_item_id: string; final_unit_iqd: number }>, newTotal?: number): Promise<Rec> {
  const res = await post(w.admin, `/api/admin/orders/${w.orderId}/price-estimate/confirm`, {
    idempotency_key: key,
    lines,
    ...(newTotal === undefined ? {} : { new_total_iqd: newTotal }),
  });
  const body = await json(res);
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(body).slice(0, 300));
  return body;
}

const deliver = (w: World) =>
  w.raw.prepare("UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), w.orderId);

/** Each line's figure to the three services: the return refund, trade-in's paid unit, protection's settled baseline. */
async function figures(w: World): Promise<Record<'tpu' | 'petg', { refund: number; tradeIn: number; protection: number }>> {
  const estimates = await orderEstimateFacts(w.db, w.orderId);
  assert.ok(Array.isArray(estimates), 'the estimate records read');
  const order = row<Rec>(w.raw, 'SELECT * FROM orders WHERE id = ?', w.orderId)!;
  const items = all<GoodsLine>(w.raw, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY order_id, id', w.orderId);
  const paid = (await loadOrdersPaidNet(w.db, [w.orderId])).get(w.orderId)!;
  const out: Record<string, { refund: number; tradeIn: number; protection: number }> = {};
  for (const [name, item] of [['petg', w.petg], ['tpu', w.tpu]] as const) {
    const caseId = `rc_${name}`;
    w.raw
      .prepare(
        `INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,within_window,delivered_at_snapshot)
         VALUES (?,?,?,'buyer',1,'defective','inspected',1,?)`
      )
      .run(caseId, w.orderId, item.id, new Date().toISOString());
    const res = await post(w.admin, `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' });
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
    out[name] = {
      refund: Number(body.refund.amount_iqd),
      tradeIn: paidNetPerUnit(paid.order, paid.lines, item.id)!,
      protection: settledEstimatePaidUnit(order, items, false, estimates, item.id)!.unit,
    };
  }
  return out as Record<'tpu' | 'petg', { refund: number; tradeIn: number; protection: number }>;
}

// =========================================================================

test('APPROVED: TPU settled +5,000 and approved; PETG was never re-priced — every service reads each line at its own price', async () => {
  const w = await world(false);
  const proposal = await confirm(w, `returns-approved-${w.orderId}`, [{ order_item_id: w.tpu.id, final_unit_iqd: w.tpu.unit_price_iqd + 5000 }]);
  assert.equal(proposal.outcome, 'proposed');
  const approved = await post(w.buyer, `/api/orders/${w.orderId}/price-adjustment/${proposal.adjustment.id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(row<Rec>(w.raw, 'SELECT price_adjustment_iqd FROM orders WHERE id = ?', w.orderId)!.price_adjustment_iqd, 5000);
  deliver(w);
  const got = await figures(w);
  // Before the fix the +5,000 was spread by net goods: PETG refunded and traded at 42,353 for an item charged 40,000.
  const tpu = w.tpu.unit_price_iqd + 5000;
  const petg = w.petg.unit_price_iqd;
  assert.deepEqual(got.tpu, { refund: tpu, tradeIn: tpu, protection: tpu });
  assert.deepEqual(got.petg, { refund: petg, tradeIn: petg, protection: petg });
});

test('CANCEL-OUT: TPU +1,000 and PETG −1,000 confirmed with no money moved — every service reads each line at its final price', async () => {
  const w = await world(true);
  const total = row<Rec>(w.raw, 'SELECT total_iqd FROM orders WHERE id = ?', w.orderId)!.total_iqd;
  const res = await confirm(w, `returns-cancel-${w.orderId}`, [
    { order_item_id: w.tpu.id, final_unit_iqd: w.tpu.unit_price_iqd + 1000 },
    { order_item_id: w.petg.id, final_unit_iqd: w.petg.unit_price_iqd - 1000 },
  ]);
  assert.equal(res.outcome, 'confirmed');
  const order = row<Rec>(w.raw, 'SELECT total_iqd, price_adjustment_iqd FROM orders WHERE id = ?', w.orderId)!;
  assert.deepEqual([order.total_iqd, order.price_adjustment_iqd], [total, 0], 'no money moved');
  deliver(w);
  const got = await figures(w);
  // Before the fix PETG was refunded and traded at its 40,000 estimate although it was confirmed at 39,000.
  const tpu = w.tpu.unit_price_iqd + 1000;
  const petg = w.petg.unit_price_iqd - 1000;
  assert.deepEqual(got.tpu, { refund: tpu, tradeIn: tpu, protection: tpu });
  assert.deepEqual(got.petg, { refund: petg, tradeIn: petg, protection: petg });
});

test('ABSORBED: TPU confirmed +5,000 while the financial admin keeps the total — no money moved, so every service reads each line at its charge', async () => {
  const w = await world(false);
  const total = row<Rec>(w.raw, 'SELECT total_iqd FROM orders WHERE id = ?', w.orderId)!.total_iqd;
  const res = await confirm(w, `returns-absorbed-${w.orderId}`, [{ order_item_id: w.tpu.id, final_unit_iqd: w.tpu.unit_price_iqd + 5000 }], total);
  assert.equal(res.outcome, 'confirmed');
  const order = row<Rec>(w.raw, 'SELECT total_iqd, price_adjustment_iqd FROM orders WHERE id = ?', w.orderId)!;
  assert.deepEqual([order.total_iqd, order.price_adjustment_iqd], [total, 0], 'no money moved');
  // The record keeps the final it was confirmed at; the kept total absorbed it, so it counts for nothing.
  const rec = row<Rec>(w.raw, 'SELECT state, final_unit_iqd FROM order_price_estimates WHERE order_item_id = ?', w.tpu.id)!;
  assert.deepEqual([rec.state, rec.final_unit_iqd], ['confirmed', w.tpu.unit_price_iqd + 5000]);
  deliver(w);
  const got = await figures(w);
  // Each line at what was charged for it: never the absorbed +5,000 (protection once added it).
  const tpu = w.tpu.unit_price_iqd;
  const petg = w.petg.unit_price_iqd;
  assert.deepEqual(got.tpu, { refund: tpu, tradeIn: tpu, protection: tpu });
  assert.deepEqual(got.petg, { refund: petg, tradeIn: petg, protection: petg });
});
