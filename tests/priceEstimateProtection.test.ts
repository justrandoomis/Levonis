/**
 * «حماية السعر» FOR A LINE SOLD AT AN ESTIMATED PRICE (docs/SMART_PRICING.md
 * §6.9; owner default 282(h); migration 0218).
 *
 *   NOT BEFORE SETTLEMENT  a claim on a line whose estimate record is open,
 *                          proposed, rejected or void is refused with 409
 *                          PRICE_PROTECTION_ESTIMATE_PENDING — said before any
 *                          other answer about the claim, and still said if a
 *                          delivered order somehow kept an open line.
 *   THE SETTLED BASELINE   after settlement the line's paid unit is what it was
 *                          charged plus its own final − estimate — the shift the
 *                          order total took — and the estimate's adjustment is
 *                          never spread onto the order's other lines (which
 *                          would make an untouched line look protectable).
 *
 * Driven through the REAL checkout, settlement, 0140 approval and claim doors;
 * the settled baseline is also pinned on the pure rule.
 *
 * Run: node --import tsx --test tests/priceEstimateProtection.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, json, post, row, stubApp, withoutTriggers, type StubUser } from './fixtures/app';
import { seedCatalogue, orderBody } from './lib/bundles';
import { publishSeededV2 } from './fixtures/autoPublish';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { priceProtectionRoutes } from '../worker/routes/returns';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../worker/routes/orderPriceAdjust';
import {
  estimateBlocksProtection,
  hasSettledEstimate,
  settledEstimatePaidUnit,
  settledEstimateShift,
  type EstimateLineFact,
} from '../worker/lib/protectionClaims';
import { paidNetFacts } from '../worker/lib/paidNet';
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

/** TPU (`p_pre2`, labelled) and PETG (`p_pre`, not), both by sea, cash on delivery, through the real checkout. */
async function world() {
  const raw = seedCatalogue();
  await publishSeededV2(raw);
  label(raw, 'p_pre2');
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
    a.route('/api/price-protection', priceProtectionRoutes);
  }, { publishV2: false });
  const admin = stubApp(db, OWNER, (a) => {
    a.route('/api/admin/orders', adminOrderPriceRoutes);
    a.route('/api/admin', adminRoutes);
    a.route('/api/price-protection', priceProtectionRoutes);
  }, { publishV2: false });
  const res = await post(buyer, '/api/orders', orderBody({ price_estimate_ack: ESTIMATE_NOTICE_VERSION }));
  const placed = await json(res);
  assert.equal(res.status, 200, JSON.stringify(placed).slice(0, 400));
  const orderId = String(placed.order.id);
  const items = all<Rec>(raw, 'SELECT * FROM order_items WHERE order_id = ?', orderId);
  const tpu = items.find((i) => i.product_id === 'p_pre2')!;
  const petg = items.find((i) => i.product_id === 'p_pre')!;
  return { raw, buyer, admin, orderId, tpu, petg };
}
type World = Awaited<ReturnType<typeof world>>;

const claim = async (w: World, itemId: string) => {
  const res = await post(w.buyer, '/api/price-protection/claims', { orderItemId: itemId });
  return { status: res.status, body: await json(res) };
};
const record = (w: World) => row<Rec>(w.raw, 'SELECT * FROM order_price_estimates WHERE order_item_id = ?', w.tpu.id)!;

/** The financial admin's settlement: the TPU line at `final`, a 0140 proposal when the total changes. */
async function settleAt(w: World, final: number): Promise<Rec> {
  const res = await post(w.admin, `/api/admin/orders/${w.orderId}/price-estimate/confirm`, {
    idempotency_key: `protection-${w.orderId}-${final}`,
    lines: [{ order_item_id: w.tpu.id, final_unit_iqd: final }],
  });
  const body = await json(res);
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(body).slice(0, 300));
  return body;
}

const deliver = (w: World) =>
  w.raw.prepare("UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), w.orderId);

// =========================================================================

test('a claim on an estimated line waits for its settlement (PRICE_PROTECTION_ESTIMATE_PENDING) — open, proposed or rejected', async () => {
  const w = await world();
  // Open: said before anything else about the claim (the order is not even delivered).
  const open = await claim(w, w.tpu.id);
  assert.equal(open.status, 409, JSON.stringify(open.body).slice(0, 300));
  assert.equal(open.body.code, 'PRICE_PROTECTION_ESTIMATE_PENDING');
  // The order's ordinary line is answered as ever.
  const plain = await claim(w, w.petg.id);
  assert.equal(plain.body.code, 'NOT_DELIVERED');
  // Proposed, then rejected: still waiting.
  const proposal = await settleAt(w, w.tpu.unit_price_iqd + 5000);
  assert.equal((await claim(w, w.tpu.id)).body.code, 'PRICE_PROTECTION_ESTIMATE_PENDING');
  await post(w.buyer, `/api/orders/${w.orderId}/price-adjustment/${proposal.adjustment.id}/reject`);
  assert.equal(record(w).state, 'rejected');
  assert.equal((await claim(w, w.tpu.id)).body.code, 'PRICE_PROTECTION_ESTIMATE_PENDING');
  assert.equal(all(w.raw, 'SELECT * FROM price_protection_claims').length, 0);
});

test('defence in depth: a delivered order that somehow kept an open estimated line is still refused', async () => {
  const w = await world();
  // The gate (T8) forbids delivering it; forged here with the trigger dropped for one statement.
  withoutTriggers(w.raw, ['trg_orders_price_estimate_gate'], `UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = '${new Date().toISOString()}' WHERE id = '${w.orderId}'`);
  const res = await claim(w, w.tpu.id);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PRICE_PROTECTION_ESTIMATE_PENDING');
});

test('after settlement the line’s paid unit is its charge plus its own final − estimate, and the order’s other line keeps its own', async () => {
  const w = await world();
  const shift = 5000;
  const proposal = await settleAt(w, w.tpu.unit_price_iqd + shift);
  const approved = await post(w.buyer, `/api/orders/${w.orderId}/price-adjustment/${proposal.adjustment.id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(record(w).state, 'approved');
  deliver(w); // the gate is open: settled
  // TPU: paid its estimate plus the approved shift; today it costs the estimate again — a real drop of `shift`.
  const tpu = await claim(w, w.tpu.id);
  assert.equal(tpu.status, 200, JSON.stringify(tpu.body).slice(0, 400));
  assert.equal(tpu.body.claim.original_unit_iqd, w.tpu.unit_price_iqd + shift);
  assert.equal(tpu.body.claim.observed_unit_iqd, w.tpu.unit_price_iqd);
  assert.equal(tpu.body.claim.eligible_unit_iqd, shift);
  // The owner's decision recomputes the paid unit through the same settled baseline, and credits the shift.
  const decided = await json(await post(w.admin, `/api/price-protection/admin/claims/${tpu.body.claim.id}/decide`, { decision: 'approved' }));
  assert.equal(decided.success, true, JSON.stringify(decided).slice(0, 300));
  assert.equal(decided.credit.amount_iqd, shift);
  // PETG: never re-priced. The estimate's adjustment is not its money — no drop to protect.
  const petg = await claim(w, w.petg.id);
  assert.equal(petg.status, 400, JSON.stringify(petg.body).slice(0, 300));
  assert.equal(petg.body.code, 'NO_ELIGIBLE_DROP');
});

test('the settled baseline on the pure rule: approved lines carry their own shift, confirmed ones that cancel out too, an edited remainder is shared', () => {
  const order = (adj: number, total: number) => ({ id: 'o', subtotal_iqd: 85000, shipping_iqd: 0, total_iqd: total, points_discount_iqd: 0, price_adjustment_iqd: adj, coupon_snapshot: null });
  const items: GoodsLine[] = [
    { id: 'a', order_id: 'o', product_id: 'pa', qty: 1, unit_price_iqd: 45000, line_total_iqd: 45000 } as unknown as GoodsLine,
    { id: 'b', order_id: 'o', product_id: 'pb', qty: 1, unit_price_iqd: 40000, line_total_iqd: 40000 } as unknown as GoodsLine,
  ];
  const fact = (id: string, state: string, est: number, fin: number | null): EstimateLineFact => ({ order_item_id: id, state, qty: 1, estimate_unit_iqd: est, final_unit_iqd: fin });
  const shared = (o: Record<string, unknown>, id: string) => {
    const f = paidNetFacts(o, items, false)!;
    return paidNetPerUnit(f.order, f.lines, id);
  };

  // Approved +2,000 on A: A carries all of it, B none (the shared rule would have spread it over both).
  const approved = [fact('a', 'approved', 45000, 47000)];
  assert.equal(settledEstimatePaidUnit(order(2000, 87000), items, false, approved, 'a')!.unit, 47000);
  assert.equal(settledEstimatePaidUnit(order(2000, 87000), items, false, approved, 'b')!.unit, 40000);
  assert.ok(shared(order(2000, 87000), 'b')! > 40000, 'the shared rule alone would have raised B');

  // Confirmed at finals that cancel out (no money moved): each line at its own final.
  const confirmed = [fact('a', 'confirmed', 45000, 46000), fact('b', 'confirmed', 40000, 39000)];
  assert.equal(settledEstimatePaidUnit(order(0, 85000), items, false, confirmed, 'a')!.unit, 46000);
  assert.equal(settledEstimatePaidUnit(order(0, 85000), items, false, confirmed, 'b')!.unit, 39000);

  // An edited total (+1,000 where the line said +2,000): the −1,000 remainder is shared; the sum is the total.
  const ea = settledEstimatePaidUnit(order(1000, 86000), items, false, approved, 'a')!.unit;
  const eb = settledEstimatePaidUnit(order(1000, 86000), items, false, approved, 'b')!.unit;
  assert.equal(ea + eb, 86000);
  assert.ok(ea < 47000 && eb < 40000);

  // Confirmed at a final an edited total absorbed (no money moved, the finals do not net to zero): each line at
  // what it was charged, and the engine regular does not move — the same figure the return and trade-in read.
  const absorbed = [fact('a', 'confirmed', 45000, 47000)];
  assert.equal(settledEstimatePaidUnit(order(0, 85000), items, false, absorbed, 'a')!.unit, 45000);
  assert.equal(settledEstimatePaidUnit(order(0, 85000), items, false, absorbed, 'b')!.unit, 40000);
  assert.equal(settledEstimateShift(absorbed, 'a'), 0);
  assert.equal(settledEstimateShift(approved, 'a'), 2000);
  assert.equal(settledEstimateShift(confirmed, 'b'), -1000);

  // The gate of the claim: only a settled record lets it through.
  for (const s of ['open', 'proposed', 'rejected', 'void']) assert.equal(estimateBlocksProtection(fact('a', s, 1, null)), true, s);
  for (const s of ['confirmed', 'approved']) assert.equal(estimateBlocksProtection(fact('a', s, 1, 1)), false, s);
  assert.equal(estimateBlocksProtection(null), false, 'a line with no record is no estimate');
  assert.equal(hasSettledEstimate([fact('a', 'open', 1, null)]), false);
  assert.equal(hasSettledEstimate(approved), true);
});
