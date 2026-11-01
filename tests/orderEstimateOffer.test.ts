/**
 * «استخدم سعر اليوم» ON A LINE BOUGHT UNDER AN OFFER (docs/SMART_PRICING.md
 * §6.1, §6.5; worker/lib/orderEstimates.ts).
 *
 * An estimated line keeps a live offer, so its estimate is the OFFER price,
 * while the SKU × channel's published price carries no offer. The confirm
 * panel's read therefore names the frozen price before the offer — the one
 * today's price is compared with — and the same offer on today's price, which
 * is what «استخدم سعر اليوم» proposes. Never the bare published price: that
 * would ask the customer to pay the offer's saving back.
 *
 *   PURE   a frozen percent is re-applied as the offer computes it; an amount
 *          off (and any term that cannot be recovered) keeps the same saving;
 *          no price today, or none on the rule, proposes nothing; a line with
 *          no offer reads exactly as before; a snapshot that is not JSON is no
 *          offer, and a database without 0218 still has no estimate.
 *   REAL   through the real checkout, a percent and an amount off: nothing
 *          moved → nothing proposed; today's price moves → the same offer on
 *          it, and settling there asks the customer for the supplier's change
 *          only.
 *
 * Run: node --import tsx --test tests/orderEstimateOffer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, json, post, row, stubApp, withoutTriggers, type StubUser } from './fixtures/app';
import { LimitD1, violations } from './fixtures/d1Limits';
import { leaks } from './fixtures/costlyProduct';
import { seedCatalogue, orderBody } from './lib/bundles';
import { publishSeededV2 } from './fixtures/autoPublish';
import { orderRoutes } from '../worker/routes/orders';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../worker/routes/orderPriceAdjust';
import { estimateLineView, offerBeforeUnitIqd, offerTodayUnitIqd, orderEstimateRows, type OrderEstimateRow } from '../worker/lib/orderEstimates';
import { todayFinalOf } from '../src/components/adminOrders/EstimateConfirmPanel';
import { ESTIMATE_NOTICE_VERSION } from '../packages/contracts/src/priceEstimates';

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };

// Telegram and the mail provider at `fetch`, file-wide: nothing leaves the process.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ ok: true, id: 'em_1', result: { message_id: 1, chat: { id: 1 } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// =========================================================================
//  PURE
// =========================================================================

/** A TPU line bought at 10% off a published 45,000: sold at 40,500. */
const line = (over: Partial<OrderEstimateRow> = {}): OrderEstimateRow => ({
  order_item_id: 'oi-tpu', order_id: 'ORD-1', product_id: 'p_pre2', combo_key: '', channel: 'pre_order_sea', qty: 1,
  estimate_unit_iqd: 40_500, notice_version: 1, state: 'open', final_unit_iqd: null, adjustment_id: null, decided_by: '',
  decided_at: null, created_at: '2026-11-01T00:00:00.000Z', name_snapshot: 'TPU Spool', option_snapshot: null,
  offer_before_iqd: 45_000, offer_mode: 'discount_percent', offer_percent: 10,
  ...over,
});

test('a frozen percent off is re-applied to today’s price exactly as the offer computes it', () => {
  const r = line();
  assert.equal(offerBeforeUnitIqd(r), 45_000);
  assert.equal(offerTodayUnitIqd(r, 45_000), 40_500, 'nothing moved: the price the line was sold at');
  assert.equal(offerTodayUnitIqd(r, 50_000), 45_000, '10% off 50,000 — not the estimate moved by 5,000 (45,500)');
  assert.equal(offerTodayUnitIqd(r, 44_000), 39_750, '10% off 44,000 is 39,600, rounded up on the rule');
  // A 1% window lowers 25,000 to 24,750 but not 1,250 (1,237.5 rounds back up): today it sells at the price itself.
  assert.equal(offerTodayUnitIqd(line({ estimate_unit_iqd: 24_750, offer_before_iqd: 25_000, offer_percent: 1 }), 1_250), 1_250);
  assert.equal(offerTodayUnitIqd(r, null), null, 'no published price today, nothing to propose');
  assert.equal(offerTodayUnitIqd(r, 0), null);
});

test('an amount off — or a term that cannot be recovered — keeps the same saving on today’s price', () => {
  const amount = line({ estimate_unit_iqd: 40_000, offer_mode: 'discount_iqd', offer_percent: null });
  assert.equal(offerTodayUnitIqd(amount, 45_000), 40_000);
  assert.equal(offerTodayUnitIqd(amount, 50_000), 45_000);
  assert.equal(offerTodayUnitIqd(amount, 4_000), null, 'a saving above today’s price is no price');
  // A percent that does not give back the estimate, a dollar sale, a dinar price, no mode at all.
  for (const over of [{ offer_percent: 20 }, { offer_mode: 'fixed_usd', offer_percent: null }, { offer_mode: 'fixed' }, { offer_mode: null, offer_percent: null }]) {
    assert.equal(offerTodayUnitIqd(line(over), 50_000), 45_500, JSON.stringify(over));
  }
});

test('the line view: the offer keys only on a line bought under an offer; every other line reads exactly as before', () => {
  const KEYS = ['adjustment_id', 'channel', 'current_unit_iqd', 'decided_at', 'estimate_unit_iqd', 'final_unit_iqd', 'name', 'order_item_id', 'qty', 'state', 'variant'];
  // No offer: no snapshot key, an unreadable one, or a "before" that did not lower the price.
  for (const over of [{ offer_before_iqd: null }, { offer_before_iqd: undefined }, { offer_before_iqd: 40_500 }, { offer_before_iqd: 30_000 }]) {
    const r = line(over);
    assert.equal(offerBeforeUnitIqd(r), null, JSON.stringify(over));
    assert.equal(offerTodayUnitIqd(r, 50_000), null, JSON.stringify(over));
    assert.deepEqual(Object.keys(estimateLineView(r, 50_000)).sort(), KEYS, JSON.stringify(over));
  }
  const offered = estimateLineView(line(), 50_000);
  assert.deepEqual(Object.keys(offered).sort(), [...KEYS, 'offer_before_unit_iqd', 'offer_today_unit_iqd'].sort());
  assert.deepEqual([offered.estimate_unit_iqd, offered.current_unit_iqd, offered.offer_before_unit_iqd, offered.offer_today_unit_iqd], [40_500, 50_000, 45_000, 45_000]);
  // The GET read found no published price today: the key is there, null — no same-offer price today.
  const none = estimateLineView(line(), null);
  assert.deepEqual(Object.keys(none).sort(), [...KEYS, 'offer_before_unit_iqd', 'offer_today_unit_iqd'].sort());
  assert.deepEqual([none.current_unit_iqd, none.offer_before_unit_iqd, none.offer_today_unit_iqd], [null, 45_000, null]);
  // The confirm door's answer reads no price today, so it names no same-offer price at all (never a null that says "none today").
  const unread = estimateLineView(line());
  assert.deepEqual(Object.keys(unread).sort(), [...KEYS, 'offer_before_unit_iqd'].sort());
  assert.deepEqual([unread.current_unit_iqd, unread.offer_before_unit_iqd], [null, 45_000]);
  // A plain line reads the same either way.
  assert.deepEqual(estimateLineView(line({ offer_before_iqd: null })), estimateLineView(line({ offer_before_iqd: null }), null));
});

test('«استخدم سعر اليوم»: today’s price on a plain line; on an offer line the same offer today, and nothing while nothing moved', () => {
  assert.equal(todayFinalOf({ current_unit_iqd: 25_500 }), 25_500, 'a plain line: as it always was');
  assert.equal(todayFinalOf({ current_unit_iqd: null }), null);
  const offer = { offer_before_unit_iqd: 45_000 };
  assert.equal(todayFinalOf({ ...offer, current_unit_iqd: 45_000, offer_today_unit_iqd: 40_500 }), null, 'today’s price is still the one before the offer');
  assert.equal(todayFinalOf({ ...offer, current_unit_iqd: 50_000, offer_today_unit_iqd: 45_000 }), 45_000, 'never 50,000: the offer’s saving stays');
  assert.equal(todayFinalOf({ ...offer, current_unit_iqd: 50_000, offer_today_unit_iqd: null }), null);
  assert.equal(todayFinalOf({ ...offer, current_unit_iqd: null, offer_today_unit_iqd: null }), null);
});

test('the read: a snapshot that is not JSON is no offer, never an error; a database without 0218 has no estimate', async () => {
  const raw = freshDb();
  raw.exec(`PRAGMA foreign_keys = OFF;
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd, pricing_snapshot) VALUES
      ('oi_text','ORD-1','p1','A',1,1000,1000,'not json'), ('oi_null','ORD-1','p1','B',1,1000,1000,NULL),
      ('oi_offer','ORD-1','p1','C',1,1000,1000,'{"offer_before_iqd":1250,"offer":{"offer_price_mode":"discount_percent","offer_discount_percent":20}}');`);
  // The records are the checkout batch's alone (T7); this read-only check writes them directly.
  const guards = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'order_price_estimates'").all() as Array<{ name: string }>).map((t) => t.name);
  withoutTriggers(
    raw,
    guards,
    ['oi_text', 'oi_null', 'oi_offer']
      .map((id) => `INSERT INTO order_price_estimates (order_item_id, order_id, product_id, combo_key, channel, qty, estimate_unit_iqd, notice_version, state, created_at)
        VALUES ('${id}', 'ORD-1', 'p1', '', 'pre_order_sea', 1, 1000, 1, 'open', '2026-11-01T00:00:00.000Z');`)
      .join('\n')
  );
  const rows = await orderEstimateRows(asD1(raw), 'ORD-1');
  assert.deepEqual(rows.map((r) => [r.order_item_id, r.offer_before_iqd, r.offer_mode, r.offer_percent]), [
    ['oi_text', null, null, null],
    ['oi_null', null, null, null],
    ['oi_offer', 1250, 'discount_percent', 20],
  ]);
  assert.deepEqual(await orderEstimateRows(asD1(dbThrough('0217')), 'ORD-1'), []);
});

// =========================================================================
//  REAL
// =========================================================================

/** What the V2 writer's estimate batch does to the label (T1). */
function label(raw: DatabaseSync, pid: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';`);
}

/** The engine publishes another price for the TPU's route (its result and its row, under its own token). */
function publish(raw: DatabaseSync, channel: string, iqd: number): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:p_pre2', 1);
    UPDATE pricing_v2_sku_results SET direct_price_iqd = MAX(direct_price_iqd, ${iqd}), final_price_iqd = ${iqd}
     WHERE product_id = 'p_pre2' AND channel = '${channel}';
    UPDATE product_sku_prices SET regular_price_iqd = ${iqd} WHERE product_id = 'p_pre2' AND channel = '${channel}';
    DELETE FROM ops_guards WHERE id = 'engine-price:p_pre2';`);
}

/** The labelled TPU (published at 45,000 by sea) bought under a live, public window, cash on delivery. */
async function world(mode: 'discount_percent' | 'discount_iqd') {
  const raw = seedCatalogue();
  await publishSeededV2(raw);
  label(raw, 'p_pre2');
  raw
    .prepare(
      `INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,offer_price_mode,offer_price_iqd,
                                  discount_percent,discount_iqd,plus_price_iqd,locked_preview,active)
       VALUES ('product','p_pre2','ofw_tpu',NULL,NULL,'[]',?,NULL,?,?,NULL,1,1)`
    )
    .run(mode, mode === 'discount_percent' ? 10 : null, mode === 'discount_iqd' ? 5000 : null);
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty,fulfillment_type)
       VALUES ('ci_tpu','buyer','p_pre2','','[]','','','sea','',1,'pre_order')`
    )
    .run();
  const db = new LimitD1(raw) as unknown as D1Database;
  const buyer = stubApp(db, BUYER, (a) => {
    a.route('/api/orders', orderRoutes);
    a.route('/api/orders', orderPriceRoutes);
  }, { publishV2: false });
  const admin = stubApp(db, OWNER, (a) => a.route('/api/admin/orders', adminOrderPriceRoutes), { publishV2: false });
  const res = await post(buyer, '/api/orders', orderBody({ price_estimate_ack: ESTIMATE_NOTICE_VERSION }));
  const placed = await json(res);
  assert.equal(res.status, 200, JSON.stringify(placed).slice(0, 400));
  const orderId = String(placed.order.id);
  const rec = row<Rec>(raw, 'SELECT * FROM order_price_estimates WHERE order_id = ?', orderId)!;
  const panelLine = async () => {
    const panel = await json(await get(admin, `/api/admin/orders/${orderId}/price-estimate`));
    assert.equal(panel.success, true, JSON.stringify(panel).slice(0, 300));
    assert.deepEqual(leaks(panel), [], 'customer prices only');
    return panel.lines[0] as Rec;
  };
  return { raw, admin, orderId, rec, panelLine };
}

for (const [mode, estimate, today] of [
  // 10% off: 40,500; on today's 50,000 the same offer is 45,000 (the saving moved with the price).
  ['discount_percent', 40_500, 45_000],
  // 5,000 off: 40,000; on today's 50,000 the same offer is 45,000.
  ['discount_iqd', 40_000, 45_000],
] as const) {
  test(`a line bought under ${mode}: compared with the price before the offer, settled at the same offer on today’s price`, async () => {
    const w = await world(mode);
    assert.equal(w.rec.estimate_unit_iqd, estimate, 'the estimate is the offer price');

    // Nothing moved: the published price is the one before the offer, and nothing is proposed.
    const still = await w.panelLine();
    assert.deepEqual(
      [still.estimate_unit_iqd, still.current_unit_iqd, still.offer_before_unit_iqd, still.offer_today_unit_iqd],
      [estimate, 45_000, 45_000, estimate]
    );
    assert.equal(todayFinalOf(still as Parameters<typeof todayFinalOf>[0]), null, '«استخدم سعر اليوم» is not offered: the supplier price did not move');

    // The published price moves: the same offer on it, never the bare published price.
    publish(w.raw, w.rec.channel, 50_000);
    const moved = await w.panelLine();
    assert.deepEqual([moved.current_unit_iqd, moved.offer_before_unit_iqd, moved.offer_today_unit_iqd], [50_000, 45_000, today]);
    assert.deepEqual(Object.keys(moved), [
      'order_item_id', 'name', 'variant', 'qty', 'channel', 'estimate_unit_iqd', 'current_unit_iqd',
      'offer_before_unit_iqd', 'offer_today_unit_iqd', 'final_unit_iqd', 'state', 'adjustment_id', 'decided_at',
    ], 'the GET read keeps its keys, in order');
    const final = todayFinalOf(moved as Parameters<typeof todayFinalOf>[0]);
    assert.equal(final, today);

    // Settling there asks the customer for the supplier's change only; the offer's saving stays theirs.
    const total = row<Rec>(w.raw, 'SELECT total_iqd FROM orders WHERE id = ?', w.orderId)!.total_iqd as number;
    const res = await post(w.admin, `/api/admin/orders/${w.orderId}/price-estimate/confirm`, {
      idempotency_key: `offer-today-${mode}`,
      lines: [{ order_item_id: w.rec.order_item_id, final_unit_iqd: final }],
    });
    const body = await json(res);
    assert.equal(res.status, 201, JSON.stringify(body).slice(0, 300));
    assert.equal(body.adjustment.new_total_iqd, total + (today - estimate));
    assert.deepEqual(
      body.adjustment.lines.map((l: Rec) => [l.estimate_unit_iqd, l.final_unit_iqd]),
      [[estimate, today]]
    );
    // The confirm answer reads no price today: it names the price before the offer, and no same-offer price at all.
    const answered = body.lines[0] as Rec;
    assert.deepEqual([answered.state, answered.final_unit_iqd, answered.current_unit_iqd, answered.offer_before_unit_iqd], ['proposed', today, null, 45_000]);
    assert.equal('offer_today_unit_iqd' in answered, false, 'never null, which the GET read uses for "no same-offer price today"');
    // The GET read still names it.
    assert.equal((await w.panelLine()).offer_today_unit_iqd, today);
  });
}

test('the whole flow stays inside the live D1 limits', () => {
  assert.deepEqual(violations, []);
});
