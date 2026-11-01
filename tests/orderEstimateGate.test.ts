/**
 * «بانتظار تأكيد السعر النهائي» — THE ORDER WAITS AT «تم الاستلام», WHATEVER
 * DOOR TRIES TO MOVE IT (docs/SMART_PRICING.md §6.4; migration 0218, triggers
 * T8–T10; DECISIONS row 280; invariant I4).
 *
 * An order placed through the REAL checkout with a line at an estimated price
 * is held until every such line is settled. Every door is driven for real:
 *
 *   the stage door        PATCH /api/admin/orders/:id/stage — 409, and the
 *                         stage machine's own reason; a pre-check that cannot
 *                         be read lets the trigger decide (still refused);
 *   the legacy door       PATCH /api/admin/orders/:id — the STATUS flip itself
 *                         is refused by T8, answered 409;
 *   the courier door      POST /api/admin/orders/:id/delivery — refused BEFORE
 *                         the courier API is called (a stub counts the calls),
 *                         and 503 when the pre-check cannot be read;
 *   Telegram              «تم تأكيد الطلب» answers with the sentence;
 *   the stage sweep       never selects it (a received order has no clock);
 *   the expiry sweep      skips it while the shop owes a price;
 *   the customer          may always cancel — the lines are void, and the order
 *                         is never re-opened (T9).
 * Settled, every door opens. The board filters and counts these orders, and a
 * database without 0218 reads and moves every order exactly as before.
 *
 * Run: node --import tsx --test tests/orderEstimateGate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, dbThrough, get, json, patch, pending, post, row, stubApp, type StubUser } from './fixtures/app';
import { seedCatalogue, orderBody } from './lib/bundles';
import { publishSeededV2 } from './fixtures/autoPublish';
import { leaks } from './fixtures/costlyProduct';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../worker/routes/orderPriceAdjust';
import { estimateGateGuards, moveOrderStage, sweepDueStages } from '../worker/lib/orderStageOps';
import { sweepExpiredOrders } from '../worker/lib/orderExpirySweep';
import { handleOrderConfirmCallback } from '../worker/lib/orderTelegramConfirm';
import { ORDER_ESTIMATE_WARNING, orderAnnouncement } from '../worker/lib/adminTopicRouting';
import { PRICE_ESTIMATE_UNCONFIRMED_MESSAGE } from '../worker/lib/priceEstimateGate';
import { ESTIMATE_NOTICE_VERSION, ESTIMATE_STRINGS } from '../packages/contracts/src/priceEstimates';
import type { Env } from '../worker/lib/types';

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const ADMIN_TG = 6404042791;
const GROUP = -1002233445566;
const ADMIN_CHAT = '-100999';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}
/** Telegram, the mail provider and the courier at `fetch`: nothing leaves the process, every call is counted. */
const calls: Call[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  let body: Record<string, unknown> = {};
  try {
    body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(url);
  calls.push({ url, method: m ? m[1] : url.includes('courier.invalid') ? 'courier' : 'email', body });
  if (url.includes('courier.invalid')) {
    return new Response(JSON.stringify({ id: 'AW-1', tracking_number: 'T-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: true, id: 'em_1', result: { message_id: 900, chat: { id: GROUP } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});
const courierCalls = () => calls.filter((c) => c.method === 'courier').length;

const ENV = {
  TELEGRAM_BOT_TOKEN: '1111:CUSTOMER-BOT-TOKEN',
  TELEGRAM_ADMIN_BOT_TOKEN: '8888:ADMIN-BOT-TOKEN',
  TELEGRAM_ADMIN_USER_IDS: String(ADMIN_TG),
  TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT,
  APP_ORIGIN: 'https://levonis-iq.com',
  EMAIL_API_KEY: 're_k',
  EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
  ALWASEET_BASE_URL: 'https://courier.invalid',
  ALWASEET_USERNAME: 'u',
  ALWASEET_PASSWORD: 'p',
};

function label(raw: DatabaseSync, pid: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';`);
}

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The estimate pre-check's one statement (priceEstimateGate.ts), failing as a D1 outage would. */
class BrokenPrecheck {
  constructor(private readonly inner: D1Database) {}
  prepare(sql: string) {
    if (/FROM order_price_estimates WHERE order_id = \? AND state IN \('open','proposed','rejected'\) LIMIT 1/.test(sql)) {
      return {
        bind: () => ({
          first: async () => {
            throw new Error('D1_ERROR: simulated outage');
          },
        }),
      };
    }
    return this.inner.prepare(sql);
  }
  batch(statements: D1PreparedStatement[]) {
    return this.inner.batch(statements);
  }
}

/** An order placed through the real checkout, its TPU line at an estimated price (by sea, cash on delivery). */
async function world(o: { estimate?: boolean } = {}) {
  const raw = seedCatalogue();
  raw.exec(`
    UPDATE users SET locale = 'ar', email_verified_at = '2026-01-01T00:00:00.000Z' WHERE id = 'buyer';
    INSERT INTO admin_settings (key, value) VALUES ('deliveryConfig', '${JSON.stringify({
      createPath: '/create',
      createFields: { orderId: 'ref', itemsSummary: 'type_name', itemCount: 'items_number' },
    })}');
    INSERT INTO telegram_admin_config (id,group_chat_id,group_title,configured_by,configured_by_tg)
      VALUES ('singleton','${GROUP}','Levonis Ops','boss',${ADMIN_TG});
    INSERT INTO admin_tg_identities (telegram_user_id,user_id,created_by) VALUES (${ADMIN_TG},'boss','boss');
  `);
  await publishSeededV2(raw);
  if (o.estimate !== false) label(raw, 'p_pre2');
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty,fulfillment_type)
       VALUES ('ci_tpu','buyer','p_pre2','','[]','','','sea','',1,'pre_order')`
    )
    .run();
  const db = asD1(raw);
  const buyer = stubApp(db, BUYER, (a) => {
    a.route('/api/orders', orderRoutes);
    a.route('/api/orders', orderPriceRoutes);
  }, { publishV2: false, env: ENV });
  const admin = (d: unknown = db) =>
    stubApp(d, OWNER, (a) => {
      a.route('/api/admin/orders', adminOrderPriceRoutes);
      a.route('/api/admin', adminRoutes);
    }, { publishV2: false, env: ENV });
  const res = await post(buyer, '/api/orders', orderBody({ price_estimate_ack: ESTIMATE_NOTICE_VERSION }));
  const placed = await json(res);
  assert.equal(res.status, 200, JSON.stringify(placed).slice(0, 400));
  const orderId = String(placed.order.id);
  const env = { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co', ...ENV } as unknown as Env;
  return { raw, db, buyer, admin, orderId, env };
}
type World = Awaited<ReturnType<typeof world>>;

const orderOf = (w: World) => row<Rec>(w.raw, 'SELECT * FROM orders WHERE id = ?', w.orderId)!;
const recordsOf = (w: World) => all<Rec>(w.raw, 'SELECT * FROM order_price_estimates WHERE order_id = ?', w.orderId);
const unchanged = (w: World) => {
  const o = orderOf(w);
  assert.deepEqual([o.status, o.stage, o.delivery_remote_id], ['pending', 'received', '']);
};
/** The financial admin settles the line at its estimate (no money moves). */
async function settleEstimate(w: World): Promise<void> {
  const line = recordsOf(w)[0];
  const res = await post(w.admin(), `/api/admin/orders/${w.orderId}/price-estimate/confirm`, {
    idempotency_key: `settle-${w.orderId}`,
    lines: [{ order_item_id: line.order_item_id, final_unit_iqd: line.estimate_unit_iqd }],
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res)).slice(0, 300));
}
const flush = async () => {
  await Promise.all(pending.splice(0));
};

// =========================================================================

test('the stage door refuses every move the gate guards with 409 PRICE_ESTIMATE_UNCONFIRMED; settled, it moves', async () => {
  const w = await world();
  for (const stage of ['confirmed', 'supplier_preparing', 'at_origin_warehouse', 'handed_to_carrier', 'delivered']) {
    const res = await patch(w.admin(), `/api/admin/orders/${w.orderId}/stage`, { stage });
    const body = await json(res);
    assert.equal(res.status, 409, `${stage}: ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(body.code, 'PRICE_ESTIMATE_UNCONFIRMED', stage);
    assert.equal(body.error, PRICE_ESTIMATE_UNCONFIRMED_MESSAGE);
    unchanged(w);
  }
  // The stage machine itself, forced and automatic: refused by the pre-check.
  const forced = await moveOrderStage(w.env, { orderId: w.orderId, to: 'confirmed', source: 'automatic', force: true });
  assert.deepEqual([forced.moved, forced.reason], [false, 'PRICE_ESTIMATE_UNCONFIRMED']);
  // A pre-check that cannot be read: the move runs and the trigger refuses it inside the flip.
  const broken = { ...w.env, DB: new BrokenPrecheck(w.db) as unknown as D1Database } as Env;
  const raced = await moveOrderStage(broken, { orderId: w.orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });
  assert.deepEqual([raced.moved, raced.reason], [false, 'PRICE_ESTIMATE_UNCONFIRMED']);
  unchanged(w);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ? AND stage <> 'received'", w.orderId), 0);

  await settleEstimate(w);
  const moved = await patch(w.admin(), `/api/admin/orders/${w.orderId}/stage`, { stage: 'confirmed' });
  assert.equal(moved.status, 200, JSON.stringify(await json(moved)).slice(0, 300));
  assert.deepEqual([orderOf(w).status, orderOf(w).stage], ['confirmed', 'confirmed']);
  await flush();
});

test('the legacy status door: T8 refuses the status flip itself — confirmed, processing, shipped, delivered — and cancelling passes', async () => {
  const w = await world();
  for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
    const res = await patch(w.admin(), `/api/admin/orders/${w.orderId}`, { status });
    const body = await json(res);
    assert.equal(res.status, 409, `${status}: ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(body.code, 'PRICE_ESTIMATE_UNCONFIRMED', status);
    unchanged(w);
  }
  // A cancellation is always allowed: T10 voids the line.
  const cancelled = await patch(w.admin(), `/api/admin/orders/${w.orderId}`, { status: 'cancelled' });
  assert.equal(cancelled.status, 200, JSON.stringify(await json(cancelled)).slice(0, 300));
  assert.equal(orderOf(w).status, 'cancelled');
  assert.equal(recordsOf(w)[0].state, 'void');
  // …and the order is never re-opened (T9), by either door.
  for (const res of [
    await patch(w.admin(), `/api/admin/orders/${w.orderId}`, { status: 'pending' }),
    await patch(w.admin(), `/api/admin/orders/${w.orderId}/stage`, { stage: 'confirmed' }),
  ]) {
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'PRICE_ESTIMATE_REOPEN_REFUSED');
  }
  assert.equal(orderOf(w).status, 'cancelled');
  await flush();
});

test('the courier door refuses BEFORE the courier is called, answers 503 when it cannot read the gate, and books once settled', async () => {
  const w = await world();
  calls.length = 0;
  const res = await post(w.admin(), `/api/admin/orders/${w.orderId}/delivery`, {});
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body).slice(0, 300));
  assert.equal(body.code, 'PRICE_ESTIMATE_UNCONFIRMED');
  assert.equal(courierCalls(), 0, 'the courier API was never called');
  unchanged(w);

  // FAIL CLOSED: an unreadable pre-check is a 503, never a booking on a guess.
  const broken = await post(w.admin(new BrokenPrecheck(w.db)), `/api/admin/orders/${w.orderId}/delivery`, {});
  assert.equal(broken.status, 503);
  assert.equal((await json(broken)).code, 'PRICE_ESTIMATES_READ_FAILED');
  assert.equal(courierCalls(), 0);
  // The database refuses a booking whatever door writes it (T8).
  assert.throws(() => w.raw.exec(`UPDATE orders SET delivery_remote_id = 'AW-9' WHERE id = '${w.orderId}'`), /PRICE_ESTIMATE_UNCONFIRMED/);

  await settleEstimate(w);
  const booked = await post(w.admin(), `/api/admin/orders/${w.orderId}/delivery`, {});
  assert.equal(booked.status, 200, JSON.stringify(await json(booked)).slice(0, 300));
  assert.equal(courierCalls(), 1);
  assert.equal(orderOf(w).delivery_remote_id, 'AW-1');
  await flush();
});

test('Telegram «تم تأكيد الطلب» answers with the sentence and keeps its button; settled, the same press confirms', async () => {
  const w = await world();
  calls.length = 0;
  const cb = (id: string) => ({
    id,
    from: { id: ADMIN_TG },
    data: `oc:${w.orderId}`,
    message: { message_id: 900, chat: { id: GROUP }, text: `🛒 طلب جديد — ${w.orderId}` },
  });
  const out = await handleOrderConfirmCallback(w.env, cb('cb1'), 'admin');
  assert.equal(out, 'refused');
  const answer = calls.find((c) => c.method === 'answerCallbackQuery');
  assert.equal(answer?.body.text, PRICE_ESTIMATE_UNCONFIRMED_MESSAGE.split(' / ')[0]);
  assert.equal(calls.some((c) => c.method === 'editMessageText' || c.method === 'editMessageReplyMarkup'), false, 'the button stays');
  unchanged(w);

  await settleEstimate(w);
  assert.equal(await handleOrderConfirmCallback(w.env, cb('cb2'), 'admin'), 'confirmed');
  assert.equal(orderOf(w).status, 'confirmed');
  await flush();
});

test('the stage sweep never selects an order held at «تم الاستلام»: it has no clock, and a forged one moves nothing', async () => {
  const w = await world();
  assert.equal(orderOf(w).next_stage_at, null, 'received → confirmed is a manual stage: no clock');
  const report = await sweepDueStages(w.env, 200, '2099-01-01T00:00:00.000Z');
  assert.equal(report.promoted, 0);
  unchanged(w);
  // Even a forged clock (an older build's row) cannot move it: the sweep re-checks the stage's source, and the gate holds.
  w.raw.prepare("UPDATE orders SET next_stage = 'confirmed', next_stage_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(w.orderId);
  const forged = await sweepDueStages(w.env, 200, '2099-01-01T00:00:00.000Z');
  assert.equal(forged.promoted, 0);
  unchanged(w);
});

test('the expiry sweep skips an order the shop owes a final price; once settled it is an ordinary pending order again', async () => {
  const w = await world();
  w.raw.prepare("UPDATE orders SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(w.orderId);
  const cfg = { enabled: true, ttl_minutes: 60, batch_limit: 10 } as Parameters<typeof sweepExpiredOrders>[1];
  const report = await sweepExpiredOrders(w.env, cfg, '2099-01-01T00:00:00.000Z');
  assert.deepEqual([report.scanned, report.cancelled], [0, 0], 'excluded in SQL: it never spends the batch');
  unchanged(w);
  await settleEstimate(w);
  const later = await sweepExpiredOrders(w.env, cfg, '2099-01-01T00:00:00.000Z');
  assert.equal(later.cancelled, 1);
  assert.equal(orderOf(w).status, 'cancelled');
});

test('the customer may always leave: their cancel passes the gate, the lines are void, nothing is re-opened', async () => {
  const w = await world();
  const res = await post(w.buyer, `/api/orders/${w.orderId}/cancel`);
  assert.equal(res.status, 200, JSON.stringify(await json(res)).slice(0, 300));
  assert.equal(orderOf(w).status, 'cancelled');
  const rec = recordsOf(w)[0];
  assert.equal(rec.state, 'void');
  const read = await json(await get(w.buyer, `/api/orders/${w.orderId}`));
  assert.deepEqual(read.order.items[0].price_estimate, { state: 'void' });
  const reopen = await moveOrderStage(w.env, { orderId: w.orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });
  assert.deepEqual([reopen.moved, reopen.reason], [false, 'PRICE_ESTIMATE_REOPEN_REFUSED']);
  await flush();
});

test('the board: «بانتظار تأكيد السعر» filters and counts the held orders, badges the row and offers no one-tap move', async () => {
  const w = await world();
  const board = await json(await get(w.admin(), '/api/admin/orders?scope=all&price_estimate=1'));
  assert.equal(board.success, true, JSON.stringify(board).slice(0, 300));
  assert.equal(board.price_estimate, true);
  assert.equal(board.price_estimate_count, 1);
  assert.deepEqual(board.orders.map((o: Rec) => o.id), [w.orderId]);
  const row0 = board.orders[0];
  assert.equal(row0.price_estimate_open, true);
  assert.equal(row0.quick_next, null, 'the gate would refuse the button');
  assert.deepEqual(row0.items[0].price_estimate, { state: 'open' });
  assert.deepEqual(leaks(board), []);
  const detail = await json(await get(w.admin(), `/api/admin/orders/${w.orderId}`));
  assert.equal(detail.order.price_estimate_open, true);
  assert.deepEqual(detail.order.items[0].price_estimate, { state: 'open' });

  await settleEstimate(w);
  const after = await json(await get(w.admin(), '/api/admin/orders?scope=all&price_estimate=1'));
  assert.deepEqual([after.orders.length, after.price_estimate_count], [0, 0]);
  const all0 = await json(await get(w.admin(), '/api/admin/orders?scope=all'));
  const settledRow = all0.orders.find((o: Rec) => o.id === w.orderId);
  assert.equal('price_estimate_open' in settledRow, false);
  assert.equal(settledRow.quick_next?.stage, 'confirmed');
  assert.deepEqual(settledRow.items[0].price_estimate, { state: 'confirmed' });
});

test('the messages: the admin group is warned, the customer is told the final price is confirmed before ordering from the supplier', async () => {
  const w = await world();
  await flush();
  const group = calls.find((c) => c.method === 'sendMessage' && String(c.body.text).startsWith('🛒') && String(c.body.text).includes(w.orderId));
  assert.ok(group, 'the admin group heard about the order');
  assert.equal(String(group!.body.text).split('\n')[1], ORDER_ESTIMATE_WARNING, 'the warning is the second line');
  const placed = all<Rec>(w.raw, "SELECT payload FROM outbox WHERE event_key LIKE ?", `order.placed:${w.orderId}%`);
  assert.ok(placed.length > 0, 'the order-placed message was queued');
  assert.ok(placed.every((p) => String(p.payload).includes(ESTIMATE_STRINGS.orderPlaced.ar)), JSON.stringify(placed).slice(0, 300));
  // The builder itself: only a literal true prints it, and an ordinary order is unchanged.
  const base = { orderId: 'ORD-X', lines: [], totalIqd: 1000 };
  assert.equal(orderAnnouncement({ ...base, priceEstimate: true }).split('\n')[1], ORDER_ESTIMATE_WARNING);
  assert.equal(orderAnnouncement({ ...base, priceEstimate: 'yes' }), orderAnnouncement(base));
  // An ordinary order's message carries neither.
  const plain = await world({ estimate: false });
  await flush();
  const plainGroup = calls.find((c) => c.method === 'sendMessage' && String(c.body.text).startsWith('🛒') && String(c.body.text).includes(plain.orderId));
  assert.ok(plainGroup && !String(plainGroup.body.text).includes(ORDER_ESTIMATE_WARNING));
  const plainPlaced = all<Rec>(plain.raw, "SELECT payload FROM outbox WHERE event_key LIKE ?", `order.placed:${plain.orderId}%`);
  assert.ok(plainPlaced.every((p) => !String(p.payload).includes(ESTIMATE_STRINGS.orderPlaced.ar)));
});

test('the gate’s condition is the trigger’s: a cancellation and a touch at «تم الاستلام» are never guarded', () => {
  const g = (legacyFrom: string, legacyTo: string, storedStage: string, to: string) => estimateGateGuards({ legacyFrom, legacyTo, storedStage, to });
  assert.equal(g('pending', 'confirmed', 'received', 'confirmed'), true);
  assert.equal(g('pending', 'pending', 'received', 'supplier_preparing'), true, 'a stage move alone is guarded');
  assert.equal(g('pending', 'cancelled', 'received', 'cancelled'), false);
  assert.equal(g('pending', 'pending', 'received', 'received'), false);
  assert.equal(g('cancelled', 'confirmed', 'cancelled', 'confirmed'), true, 'a re-opening asks (T9 decides)');
});

test('DEPLOY-AHEAD: on a database without 0218 every door, sweep and read answers exactly as before', async () => {
  const raw = dbThrough('0217');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer'),('boss','Ali','boss@x.co','h','admin');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage,created_at,updated_at)
      VALUES ('ORD-OLD','buyer','pending','{}','standard','{}','cash',50000,1500,50000,50000,'preorder_sea','received',
              '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_old','ORD-OLD',NULL,'Spool',1,45000,45000);
  `);
  const db = asD1(raw);
  const env = { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
  const admin = stubApp(db, OWNER, (a) => a.route('/api/admin', adminRoutes), { publishV2: false });
  const board = await json(await get(admin, '/api/admin/orders?scope=all&price_estimate=1'));
  assert.equal(board.success, true, JSON.stringify(board).slice(0, 300));
  assert.deepEqual([board.orders.length, board.price_estimate_count], [0, 0]);
  const plainBoard = await json(await get(admin, '/api/admin/orders?scope=all'));
  assert.equal(plainBoard.orders.length, 1);
  assert.equal('price_estimate' in plainBoard.orders[0].items[0], false);
  const expiry = await sweepExpiredOrders(env, { enabled: true, ttl_minutes: 60, batch_limit: 10 } as Parameters<typeof sweepExpiredOrders>[1], '2099-01-01T00:00:00.000Z');
  assert.equal(expiry.cancelled, 1, 'the sweep reads its candidates without the clause');
  raw.exec("UPDATE orders SET status = 'pending' WHERE id = 'ORD-OLD'");
  const moved = await moveOrderStage(env, { orderId: 'ORD-OLD', to: 'confirmed', source: 'manual', changedBy: 'boss' });
  assert.equal(moved.moved, true, JSON.stringify(moved));
});
