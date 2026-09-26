/**
 * «تعديل السعر النهائي» — AN ADMIN RE-PRICES, THE CUSTOMER DECIDES.
 *
 * Every test here drives the REAL routes (admin proposal, customer decision,
 * the customer bot's webhook) over a real SQLite database with every
 * migration applied, with Telegram stubbed at `fetch`, and asserts on what the
 * people involved would see: the order's money, the ledger rows, the hold, the
 * audit trail, the messages. The D1 limits the local engine does not enforce
 * (100 bound parameters, 5 compound terms) are enforced by `LimitD1`.
 *
 * Run: node --import tsx --test tests/orderPriceAdjust.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, stubApp, post, patch, get, json, pending, row, all, count, type StubUser } from './fixtures/app';
import { LimitD1, violations } from './fixtures/d1Limits';
import { adminRoutes } from '../worker/routes/admin';
import { orderRoutes } from '../worker/routes/orders';
import { telegramRoutes } from '../worker/routes/telegram';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../worker/routes/orderPriceAdjust';
import { decidePriceAdjustment, parsePriceCallbackData, priceCallbackData } from '../worker/lib/orderPriceAdjust';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { sweepExpiredOrders } from '../worker/lib/orderExpirySweep';
import { planPriceAdjustment } from '../packages/pricing/src/priceAdjustment';
import type { Env } from '../worker/lib/types';

const CUSTOMER_TOKEN = '1111:CUSTOMER-BOT-TOKEN';
const HOOK_SECRET = 'customer-hook-secret';
const CUSTOMER_TG = 7001;
const STRANGER_TG = 7002;
const ADMIN_CHAT = '-100999';
const RATE = 1400;

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const CUSTOMER: StubUser = { id: 'cust', role: 'customer', email: 'sara@x.co' };
const OTHER: StubUser = { id: 'other', role: 'customer', email: 'other@x.co' };

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** Telegram (and the mail provider) at `fetch`; nothing leaves the process. */
function stubFetch(): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  let mid = 500;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(url);
    calls.push({ method: m ? m[1] : 'email', body });
    const chat = Number(body.chat_id ?? 0) || 1;
    return new Response(JSON.stringify({ ok: true, id: 'em_1', result: { message_id: ++mid, chat: { id: chat } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

// NOTHING IN THIS FILE REACHES THE NETWORK: a file-wide stub under the per-test
// ones, so a notification sent after a test's own stub is restored still lands here.
const FILE_STUB = stubFetch();
test.after(() => FILE_STUB.restore());

const ENV = {
  TELEGRAM_BOT_TOKEN: CUSTOMER_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: HOOK_SECRET,
  TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT,
  APP_ORIGIN: 'https://levonis-iq.com',
  EMAIL_API_KEY: 're_k',
  EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
};

function dbOf(raw: DatabaseSync): D1Database {
  return new LimitD1(raw) as unknown as D1Database;
}

const adminApp = (raw: DatabaseSync, user: StubUser = OWNER) =>
  stubApp(dbOf(raw), user, (a) => {
    a.route('/api/admin/orders', adminOrderPriceRoutes);
    a.route('/api/admin', adminRoutes);
  }, { env: ENV });

const customerApp = (raw: DatabaseSync, user: StubUser = CUSTOMER) =>
  stubApp(dbOf(raw), user, (a) => {
    a.route('/api/orders', orderRoutes);
    a.route('/api/orders', orderPriceRoutes);
  }, { env: ENV });

const hookApp = (raw: DatabaseSync) =>
  stubApp(dbOf(raw), null, (a) => a.route('/api/telegram', telegramRoutes), { env: ENV });

const envOf = (raw: DatabaseSync) => ({ DB: dbOf(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co', ...ENV }) as unknown as Env;

interface Seed {
  id?: string;
  status?: string;
  stage?: string;
  payment?: string;
  total?: number;
  due?: number;
  walletIqd?: number;
  walletCents?: number;
  bnplDue?: number;
  giniPaid?: number;
  sellerType?: string;
  remoteId?: string;
  accrualEligible?: number;
  accrualSettled?: boolean;
  linkTelegram?: boolean;
}

/** A customer, an owner, an assistant — and one order in the state asked for. */
function seed(o: Seed = {}): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES
      ('boss','Ali','boss@x.co','h','admin',NULL,'ar'),
      ('helper','Mona','helper@x.co','h','admin',NULL,'ar'),
      ('cust','سارة','sara@x.co','h','customer','2026-01-01T00:00:00.000Z','ar'),
      ('other','Omar','other@x.co','h','customer','2026-01-01T00:00:00.000Z','ar');
    UPDATE users SET admin_scope = 'assistant' WHERE id = 'helper';
  `);
  if (o.linkTelegram !== false) {
    raw.exec(`INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
              VALUES ('cust', ${CUSTOMER_TG}, ${CUSTOMER_TG}, '+9647700000001', '2026-01-01T00:00:00.000Z');`);
  }
  const id = o.id ?? 'ORD-PA1';
  const walletIqd = o.walletIqd ?? 0;
  const walletCents = o.walletCents ?? Math.floor((walletIqd * 100) / RATE);
  const total = o.total ?? 100_000;
  raw
    .prepare(
      `INSERT INTO orders
         (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
          subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,wallet_applied_iqd,wallet_applied_usd_cents,
          shipping_type,stage,bnpl_due_iqd,gini_paid_iqd,seller_type,delivery_remote_id,merchandise_iqd,
          created_at,updated_at)
       VALUES (?,?,?, '{"name":"سارة"}','home','{}',?, ?,?,?,?,?,?, 'direct',?, ?,?,?,?,?,
               '2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z')`
    )
    .run(
      id, 'cust', o.status ?? 'pending', o.payment ?? 'cash',
      total, RATE, total, o.due ?? total - walletIqd, walletIqd, walletCents,
      o.stage ?? (o.status === 'confirmed' ? 'confirmed' : o.status === 'shipped' ? 'out_for_delivery' : 'received'),
      o.bnplDue ?? 0, o.giniPaid ?? 0, o.sellerType ?? 'levonis', o.remoteId ?? '', total
    );
  if (walletIqd > 0) {
    // The deposit that funded it and the checkout debit (worker/routes/orders.ts), dinars recorded (0108).
    raw.exec(`
      INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,ref,created_by,decided_at,amount_iqd,exchange_rate_snapshot)
        VALUES ('wtx_dep_1','cust','deposit','USD',${walletCents},'approved','deposit','', 'admin','2026-09-01T00:00:00.000Z',${walletIqd},${RATE}),
               ('wtx_ord_${id}_usd','cust','withdrawal','USD',${walletCents},'approved','order','${id}','system','2026-09-20T10:00:00.000Z',${walletIqd},${RATE});
    `);
  }
  if (o.accrualEligible !== undefined) {
    raw
      .prepare(
        `INSERT INTO points_accruals (id, source_ref, order_id, user_id, kind, points, base_points, multiplier_x100, eligible_iqd,
                                      iqd_per_point, rule_version, state, purchase_at, available_at, settled_at, reason)
         VALUES ('pac_1', ?, ?, 'cust', 'purchase', ?, ?, 100, ?, 100, 'v2', 'pending', '2026-09-20T10:00:00.000Z',
                 '2026-09-27T10:00:00.000Z', ?, 'purchase')`
      )
      .run(
        `order:${id}:accrual`, id, Math.floor(o.accrualEligible / 100), Math.floor(o.accrualEligible / 100), o.accrualEligible,
        o.accrualSettled ? '2026-09-20T10:00:00.000Z' : null
      );
  }
  return raw;
}

let keySeq = 0;
const propose = (raw: DatabaseSync, body: Record<string, unknown> = {}, user: StubUser = OWNER, id = 'ORD-PA1') =>
  post(adminApp(raw, user), `/api/admin/orders/${id}/price-adjustment`, {
    new_total_iqd: 120_000,
    reason: 'ارتفع سعر المورد',
    idempotencyKey: `key-${++keySeq}-abcdef`,
    ...body,
  });

const orderOf = (raw: DatabaseSync, id = 'ORD-PA1') =>
  row<Record<string, unknown>>(raw, 'SELECT * FROM orders WHERE id = ?', id)!;
const adjOf = (raw: DatabaseSync, pid: string) =>
  row<Record<string, unknown>>(raw, 'SELECT * FROM order_price_adjustments WHERE id = ?', pid)!;
const settle = async () => {
  await Promise.all(pending.splice(0));
};

let updateSeq = 90_000;
const press = (raw: DatabaseSync, data: string, from = CUSTOMER_TG) =>
  post(
    hookApp(raw),
    '/api/telegram/webhook',
    {
      update_id: ++updateSeq,
      callback_query: {
        id: `cb${updateSeq}`,
        from: { id: from },
        data,
        message: { message_id: 501, chat: { id: from, type: 'private' }, text: 'LEVONIS\nعدّلنا السعر' },
      },
    },
    { 'X-Telegram-Bot-Api-Secret-Token': HOOK_SECRET }
  );

// =========================================================================
//  THE PURE RULE
// =========================================================================

test('planner: higher → the door amount grows; lower → the door first, then the prepaid wallet part comes back', () => {
  const base = { totalIqd: 100_000, dueOnDeliveryIqd: 70_000, walletAppliedIqd: 30_000, paymentMethodId: 'cash' };
  const up = planPriceAdjustment({ ...base, newTotalIqd: 125_000 });
  assert.ok(up.ok);
  assert.deepEqual([up.plan.newDueIqd, up.plan.newWalletIqd, up.plan.walletRefundIqd, up.plan.deltaIqd], [95_000, 30_000, 0, 25_000]);

  const down = planPriceAdjustment({ ...base, newTotalIqd: 40_000 });
  assert.ok(down.ok);
  assert.deepEqual([down.plan.newDueIqd, down.plan.newWalletIqd, down.plan.walletRefundIqd], [10_000, 30_000, 0]);

  const below = planPriceAdjustment({ ...base, newTotalIqd: 20_000 });
  assert.ok(below.ok);
  assert.deepEqual([below.plan.newDueIqd, below.plan.newWalletIqd, below.plan.walletRefundIqd], [0, 20_000, 10_000]);
  // The invariant the order keeps: door + wallet = total.
  assert.equal(below.plan.newDueIqd + below.plan.newWalletIqd, 20_000);
});

test('planner: refusals — same total, not a whole positive number, financed orders', () => {
  const base = { totalIqd: 100_000, dueOnDeliveryIqd: 100_000, walletAppliedIqd: 0, paymentMethodId: 'cash' };
  assert.deepEqual(planPriceAdjustment({ ...base, newTotalIqd: 100_000 }), { ok: false, code: 'PRICE_ADJUST_SAME_TOTAL' });
  for (const bad of [0, -5, 1.5, Number.NaN, 2e9]) {
    assert.deepEqual(planPriceAdjustment({ ...base, newTotalIqd: bad }), { ok: false, code: 'PRICE_ADJUST_INVALID_TOTAL' });
  }
  assert.deepEqual(planPriceAdjustment({ ...base, paymentMethodId: 'bnpl', newTotalIqd: 90_000 }), { ok: false, code: 'PRICE_ADJUST_FINANCED' });
  assert.deepEqual(planPriceAdjustment({ ...base, paymentMethodId: 'gini', newTotalIqd: 90_000 }), { ok: false, code: 'PRICE_ADJUST_FINANCED' });
  assert.deepEqual(planPriceAdjustment({ ...base, bnplDueIqd: 5, newTotalIqd: 90_000 }), { ok: false, code: 'PRICE_ADJUST_FINANCED' });
});

test('callback data names the proposal, fits Telegram, and parses only its own shape', () => {
  const pid = 'padj_0123456789abcdef01234567';
  const d = priceCallbackData('approve', pid);
  assert.ok(new TextEncoder().encode(d).length <= 64);
  assert.deepEqual(parsePriceCallbackData(d), { decision: 'approve', adjustmentId: pid });
  assert.deepEqual(parsePriceCallbackData(priceCallbackData('reject', pid)), { decision: 'reject', adjustmentId: pid });
  for (const bad of ['pa:y:ORD-1', 'pa:x:' + pid, 'oc:ORD-1', `pa:y:${pid}x`, 42]) assert.equal(parsePriceCallbackData(bad), null);
});

// =========================================================================
//  PROPOSE
// =========================================================================

test('propose: records the proposal, holds the order, audits, and tells the customer in-app, by email and on Telegram with two buttons', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    const res = await propose(raw, { note: 'شحن إضافي 20,000' });
    assert.equal(res.status, 201);
    const body = await json(res);
    const pid = body.adjustment.id as string;
    assert.match(pid, /^padj_[0-9a-f]{24}$/);
    assert.equal(body.adjustment.new_due_iqd, 120_000);

    const o = orderOf(raw);
    assert.equal(o.price_hold_id, pid);
    assert.equal(o.total_iqd, 100_000, 'no money moves at proposal time');
    const a = adjOf(raw, pid);
    assert.deepEqual([a.state, a.old_total_iqd, a.new_total_iqd, a.delta_iqd, a.proposed_by], ['pending', 100_000, 120_000, 20_000, 'boss']);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_adjust.propose' AND target = 'ORD-PA1'"), 1);
    const inApp = row<Record<string, string>>(raw, "SELECT * FROM user_notifications WHERE user_id = 'cust'")!;
    assert.equal(inApp.link, '/orders/ORD-PA1');
    assert.equal(inApp.kind, 'order_update');

    await settle();
    const tg = f.calls.find((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === CUSTOMER_TG);
    assert.ok(tg, 'the customer got a Telegram prompt');
    const kb = (tg!.body.reply_markup as { inline_keyboard: Array<Array<Record<string, string>>> }).inline_keyboard;
    assert.equal(kb[0][0].callback_data, `pa:y:${pid}`);
    assert.equal(kb[1][0].callback_data, `pa:n:${pid}`);
    assert.equal(kb[2][0].url, 'https://levonis-iq.com/orders/ORD-PA1');
    assert.match(String(tg!.body.text), /100,000 د.ع/);
    assert.match(String(tg!.body.text), /120,000 د.ع/);
    assert.equal(adjOf(raw, pid).tg_message_id !== null, true, 'the prompt is remembered so a web decision can stamp it');
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM outbox WHERE event_key = ?", `order.price_adjust:${pid}:email`), 1);
  } finally {
    f.restore();
  }
});

test('propose is idempotent per key; a reused key with another figure is refused; one open proposal at a time', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    const first = await propose(raw, { idempotencyKey: 'same-key-123' });
    assert.equal(first.status, 201);
    const again = await propose(raw, { idempotencyKey: 'same-key-123' });
    assert.equal(again.status, 200);
    assert.equal((await json(again)).replayed, true);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_price_adjustments'), 1);

    const reused = await propose(raw, { idempotencyKey: 'same-key-123', new_total_iqd: 130_000 });
    assert.equal(reused.status, 409);
    assert.equal((await json(reused)).code, 'IDEMPOTENCY_KEY_REUSED');

    const second = await propose(raw, { new_total_iqd: 90_000 });
    assert.equal(second.status, 409);
    assert.equal((await json(second)).code, 'PRICE_APPROVAL_PENDING');
    await settle();
  } finally {
    f.restore();
  }
});

test('propose needs the financial scope and a real figure', async () => {
  const raw = seed();
  const res = await propose(raw, {}, ASSISTANT);
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'FINANCIAL_SCOPE_REQUIRED');
  for (const bad of [0, -1, 12.5, '120000']) {
    const r = await propose(raw, { new_total_iqd: bad });
    assert.equal(r.status, 400, `refuses ${String(bad)}`);
    assert.equal((await json(r)).code, 'PRICE_ADJUST_INVALID_TOTAL');
  }
  const same = await propose(raw, { new_total_iqd: 100_000 });
  assert.equal((await json(same)).code, 'PRICE_ADJUST_SAME_TOTAL');
  const noReason = await propose(raw, { reason: '' });
  assert.equal(noReason.status, 400);
  assert.equal(orderOf(raw).price_hold_id, null);
});

test('only pre-shipping platform orders that are not financed may be re-priced', async () => {
  const cases: Array<[Seed, string]> = [
    [{ payment: 'bnpl', bnplDue: 100_000, due: 0 }, 'PRICE_ADJUST_FINANCED'],
    [{ payment: 'gini', giniPaid: 95_000, due: 5_000 }, 'PRICE_ADJUST_FINANCED'],
    [{ status: 'shipped' }, 'PRICE_ADJUST_STAGE'],
    [{ status: 'delivered', stage: 'delivered' }, 'PRICE_ADJUST_STAGE'],
    [{ status: 'cancelled', stage: 'received' }, 'PRICE_ADJUST_STAGE'],
    [{ status: 'confirmed', remoteId: 'AW-123' }, 'PRICE_ADJUST_COURIER_BOOKED'],
    [{ sellerType: 'merchant' }, 'PRICE_ADJUST_STORE_ORDER'],
  ];
  for (const [s, code] of cases) {
    const raw = seed(s);
    const res = await propose(raw);
    assert.equal(res.status, 409, JSON.stringify(s));
    assert.equal((await json(res)).code, code, JSON.stringify(s));
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_price_adjustments'), 0);
  }
  // A confirmed (and a processing) order still may.
  const raw = seed({ status: 'confirmed' });
  assert.equal((await propose(raw)).status, 201);
  await settle();
});

test('the admin GET says why a proposal cannot be made, and who may make one', async () => {
  const raw = seed({ payment: 'bnpl', bnplDue: 100_000, due: 0 });
  const r = await json(await get(adminApp(raw), '/api/admin/orders/ORD-PA1/price-adjustment'));
  assert.equal(r.blocker, 'PRICE_ADJUST_FINANCED');
  assert.equal(r.can_propose, false);
  const ok = seed();
  const a = await json(await get(adminApp(ok, ASSISTANT), '/api/admin/orders/ORD-PA1/price-adjustment'));
  assert.equal(a.blocker, null);
  assert.equal(a.can_propose, false, 'an assistant cannot propose');
  assert.equal(a.financial_scope, false);
});

// =========================================================================
//  THE HOLD
// =========================================================================

test('while held, every admin door and the stage machine refuse with PRICE_APPROVAL_PENDING; the database refuses too', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    await propose(raw);
    const stage = await patch(adminApp(raw), '/api/admin/orders/ORD-PA1/stage', { stage: 'confirmed' });
    assert.equal(stage.status, 409);
    assert.equal((await json(stage)).code, 'PRICE_APPROVAL_PENDING');
    const status = await patch(adminApp(raw), '/api/admin/orders/ORD-PA1', { status: 'cancelled' });
    assert.equal(status.status, 409);
    assert.equal((await json(status)).code, 'PRICE_APPROVAL_PENDING');

    const moved = await moveOrderStage(envOf(raw), { orderId: 'ORD-PA1', to: 'confirmed', source: 'automatic', force: true });
    assert.equal(moved.moved, false);
    assert.equal(moved.reason, 'PRICE_APPROVAL_PENDING');

    // A writer that read the order BEFORE the hold landed meets the trigger.
    assert.throws(() => raw.exec("UPDATE orders SET status = 'confirmed', stage = 'confirmed' WHERE id = 'ORD-PA1'"), /PRICE_APPROVAL_PENDING/);
    assert.equal(orderOf(raw).status, 'pending');

    // The board shows it, and counts it.
    const board = await json(await get(adminApp(raw), '/api/admin/orders?scope=all&price_hold=1'));
    assert.equal(board.orders.length, 1);
    assert.equal(board.orders[0].price_hold_id, orderOf(raw).price_hold_id);
    assert.equal(board.price_hold_count, 1);
    await settle();
  } finally {
    f.restore();
  }
});

test('the expiry sweep does not cancel an order waiting on the customer’s price decision', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    await propose(raw);
    raw.exec("UPDATE orders SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 'ORD-PA1'");
    const rep = await sweepExpiredOrders(envOf(raw), { enabled: true, ttl_minutes: 60, batch_limit: 10 } as never, '2026-09-26T10:00:00.000Z');
    assert.equal(rep.cancelled, 0);
    assert.equal(orderOf(raw).status, 'pending');
    await settle();
  } finally {
    f.restore();
  }
});

test('withdraw releases the hold, changes no money, and the order moves again', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    const pid = (await json(await propose(raw))).adjustment.id as string;
    // Any admin may withdraw — it moves no money.
    const w = await post(adminApp(raw, ASSISTANT), `/api/admin/orders/ORD-PA1/price-adjustment/${pid}/withdraw`);
    assert.equal(w.status, 200);
    assert.equal(adjOf(raw, pid).state, 'withdrawn');
    assert.equal(orderOf(raw).price_hold_id, null);
    assert.equal(orderOf(raw).total_iqd, 100_000);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_adjust.withdraw'"), 1);
    const again = await post(adminApp(raw), `/api/admin/orders/ORD-PA1/price-adjustment/${pid}/withdraw`);
    assert.equal((await json(again)).replayed, true);
    // Approving a withdrawn proposal is refused.
    const late = await post(customerApp(raw), `/api/orders/ORD-PA1/price-adjustment/${pid}/approve`);
    assert.equal(late.status, 409);
    assert.equal((await json(late)).code, 'PRICE_ADJUST_NOT_PENDING');
    const stage = await patch(adminApp(raw), '/api/admin/orders/ORD-PA1/stage', { stage: 'confirmed' });
    assert.equal(stage.status, 200);
    await settle();
  } finally {
    f.restore();
  }
});

// =========================================================================
//  APPROVE / REJECT — THE MONEY
// =========================================================================

test('approve (higher, part prepaid from the wallet): the difference goes to the door; the wallet is untouched; one audit row', async () => {
  const f = stubFetch();
  try {
    const raw = seed({ walletIqd: 30_000, accrualEligible: 100_000 });
    const pid = (await json(await propose(raw, { new_total_iqd: 125_000 }))).adjustment.id as string;
    const shown = await json(await get(customerApp(raw), '/api/orders/ORD-PA1/price-adjustment'));
    assert.equal(shown.pending.id, pid);
    assert.equal(shown.pending.new_due_iqd, 95_000);

    const res = await post(customerApp(raw), `/api/orders/ORD-PA1/price-adjustment/${pid}/approve`);
    assert.equal(res.status, 200);
    assert.equal((await json(res)).outcome, 'approved');
    const o = orderOf(raw);
    assert.deepEqual(
      [o.total_iqd, o.due_on_delivery_iqd, o.wallet_applied_iqd, o.price_adjustment_iqd, o.price_hold_id],
      [125_000, 95_000, 30_000, 25_000, null]
    );
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE id LIKE 'wtx_padj_%'"), 0);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_adjust.approve'"), 1);
    // Points follow the merchandise rule, never above the new total: untouched here.
    assert.equal(row<{ eligible_iqd: number }>(raw, "SELECT eligible_iqd FROM points_accruals WHERE id = 'pac_1'")!.eligible_iqd, 100_000);

    // The customer order payload now carries the adjustment line.
    const got = await json(await get(customerApp(raw), '/api/orders/ORD-PA1'));
    assert.equal(got.order.financial.price_adjustment_iqd, 25_000);
    assert.equal(got.order.price_hold_id, null);

    await settle();
    const admin = f.calls.find((c) => c.method === 'sendMessage' && String(c.body.chat_id) === ADMIN_CHAT);
    assert.ok(admin, 'the admin chat heard about it');
    assert.match(String(admin!.body.text), /وافق الزبون على السعر الجديد/);
    // The second press is its own answer and moves nothing.
    const again = await json(await post(customerApp(raw), `/api/orders/ORD-PA1/price-adjustment/${pid}/approve`));
    assert.equal(again.replayed, true);
    assert.equal(orderOf(raw).total_iqd, 125_000);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_adjust.approve'"), 1);
  } finally {
    f.restore();
  }
});

test('approve (lower than what the wallet prepaid): the excess is credited back in dinars in the same batch; a later cancel returns only the rest', async () => {
  const f = stubFetch();
  try {
    // Paid in full from the wallet: 100,000 د.ع = 7,142 cents at 1,400.
    const raw = seed({ payment: 'wallet', walletIqd: 100_000, due: 0, accrualEligible: 100_000, accrualSettled: true });
    const pid = (await json(await propose(raw, { new_total_iqd: 60_000 }))).adjustment.id as string;
    assert.equal(adjOf(raw, pid).wallet_refund_iqd, 40_000);
    const res = await post(customerApp(raw), `/api/orders/ORD-PA1/price-adjustment/${pid}/approve`);
    assert.equal(res.status, 200);

    const refund = all<Record<string, unknown>>(raw, "SELECT * FROM wallet_transactions WHERE id LIKE 'wtx_padj_%'");
    assert.equal(refund.length, 1);
    assert.deepEqual(
      [refund[0].type, refund[0].amount, refund[0].amount_iqd, refund[0].exchange_rate_snapshot, refund[0].ref, refund[0].status],
      ['deposit', 2857, 40_000, RATE, 'order-price:ORD-PA1', 'approved']
    );
    const o = orderOf(raw);
    assert.deepEqual([o.total_iqd, o.due_on_delivery_iqd, o.wallet_applied_iqd, o.wallet_applied_usd_cents], [60_000, 0, 60_000, 7142 - 2857]);
    // The pending accrual never rewards more than the new total.
    const acc = row<Record<string, number>>(raw, "SELECT eligible_iqd, base_points, points FROM points_accruals WHERE id = 'pac_1'")!;
    assert.deepEqual([acc.eligible_iqd, acc.base_points, acc.points], [60_000, 600, 600]);
    const audit = row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'order.price_adjust.approve'")!;
    assert.match(audit.detail, /wtx_padj_/);

    // Cancel now: the cents left on the order and the dinars left, never the 40,000 twice.
    const cancel = await post(customerApp(raw), '/api/orders/ORD-PA1/cancel');
    assert.equal(cancel.status, 200);
    const back = row<Record<string, number>>(raw, "SELECT amount, amount_iqd FROM wallet_transactions WHERE id = 'wtx_refund_ORD-PA1_usd'")!;
    assert.deepEqual([back.amount, back.amount_iqd], [4285, 60_000]);
    // Net across the whole life of the order: every dinar and every cent returned.
    const net = row<{ c: number; d: number }>(
      raw,
      `SELECT SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END) AS c,
              SUM(CASE WHEN type='deposit' THEN amount_iqd ELSE -amount_iqd END) AS d
         FROM wallet_transactions WHERE user_id = 'cust' AND currency = 'USD' AND id <> 'wtx_dep_1'`
    )!;
    assert.deepEqual([net.c, net.d], [0, 0]);
    await settle();
  } finally {
    f.restore();
  }
});

test('approve (lower, cash on delivery): the door amount shrinks and nothing is refunded', async () => {
  const f = stubFetch();
  try {
    const raw = seed({ walletIqd: 30_000 });
    const pid = (await json(await propose(raw, { new_total_iqd: 80_000 }))).adjustment.id as string;
    await post(customerApp(raw), `/api/orders/ORD-PA1/price-adjustment/${pid}/approve`);
    const o = orderOf(raw);
    assert.deepEqual([o.total_iqd, o.due_on_delivery_iqd, o.wallet_applied_iqd, o.price_adjustment_iqd], [80_000, 50_000, 30_000, -20_000]);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE id LIKE 'wtx_padj_%'"), 0);
    await settle();
  } finally {
    f.restore();
  }
});

test('a fully prepaid order that now owes something at the door is no longer "settled" for its points', async () => {
  const f = stubFetch();
  try {
    const raw = seed({ payment: 'wallet', walletIqd: 100_000, due: 0, accrualEligible: 90_000, accrualSettled: true });
    const pid = (await json(await propose(raw, { new_total_iqd: 110_000 }))).adjustment.id as string;
    await post(customerApp(raw), `/api/orders/ORD-PA1/price-adjustment/${pid}/approve`);
    assert.equal(orderOf(raw).due_on_delivery_iqd, 10_000);
    assert.equal(row<{ settled_at: string | null }>(raw, "SELECT settled_at FROM points_accruals WHERE id = 'pac_1'")!.settled_at, null);
    await settle();
  } finally {
    f.restore();
  }
});

test('reject: the hold is released, the order keeps the old price, the admin is told', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    const pid = (await json(await propose(raw))).adjustment.id as string;
    const res = await post(customerApp(raw), `/api/orders/ORD-PA1/price-adjustment/${pid}/reject`);
    assert.equal(res.status, 200);
    assert.equal((await json(res)).outcome, 'rejected');
    const o = orderOf(raw);
    assert.deepEqual([o.total_iqd, o.due_on_delivery_iqd, o.price_hold_id, o.price_adjustment_iqd], [100_000, 100_000, null, 0]);
    assert.equal(adjOf(raw, pid).state, 'rejected');
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_adjust.reject'"), 1);
    await settle();
    assert.ok(f.calls.some((c) => c.method === 'sendMessage' && String(c.body.chat_id) === ADMIN_CHAT && /رفض الزبون/.test(String(c.body.text))));
    // The customer's Telegram prompt is stamped with the outcome and loses its buttons.
    const edit = f.calls.find((c) => c.method === 'editMessageText');
    assert.ok(edit);
    assert.match(String(edit!.body.text), /تم الرفض/);
    // Then the admin cancels through the normal path.
    assert.equal((await patch(adminApp(raw), '/api/admin/orders/ORD-PA1', { status: 'cancelled' })).status, 200);
  } finally {
    f.restore();
  }
});

test('the customer may cancel a held pending order directly: the proposal is voided in the same batch', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    const pid = (await json(await propose(raw))).adjustment.id as string;
    const res = await post(customerApp(raw), '/api/orders/ORD-PA1/cancel');
    assert.equal(res.status, 200);
    const o = orderOf(raw);
    assert.deepEqual([o.status, o.price_hold_id], ['cancelled', null]);
    assert.deepEqual([adjOf(raw, pid).state, adjOf(raw, pid).decided_via], ['void', 'customer_cancel']);
    await settle();
  } finally {
    f.restore();
  }
});

test('someone else’s order is not found; a proposal id from another order is not found', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    const pid = (await json(await propose(raw))).adjustment.id as string;
    assert.equal((await post(customerApp(raw, OTHER), `/api/orders/ORD-PA1/price-adjustment/${pid}/approve`)).status, 404);
    assert.equal((await get(customerApp(raw, OTHER), '/api/orders/ORD-PA1/price-adjustment')).status, 404);
    assert.equal(orderOf(raw).price_hold_id, pid);
    await settle();
  } finally {
    f.restore();
  }
});

test('two presses at the same instant apply once: one approval, one ledger credit, one audit row', async () => {
  const f = stubFetch();
  try {
    const raw = seed({ payment: 'wallet', walletIqd: 100_000, due: 0 });
    const pid = (await json(await propose(raw, { new_total_iqd: 50_000 }))).adjustment.id as string;
    const env = envOf(raw);
    const [x, y] = await Promise.all([
      decidePriceAdjustment(env, { adjustmentId: pid, decision: 'approve', actorUserId: 'cust', via: 'web' }),
      decidePriceAdjustment(env, { adjustmentId: pid, decision: 'approve', actorUserId: 'cust', via: 'telegram' }),
    ]);
    assert.deepEqual([x.outcome, y.outcome], ['approved', 'approved']);
    assert.equal([x, y].filter((r) => 'replayed' in r && r.replayed).length, 1);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE id LIKE 'wtx_padj_%'"), 1);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_adjust.approve'"), 1);
    assert.equal(orderOf(raw).total_iqd, 50_000);
    await settle();
  } finally {
    f.restore();
  }
});

// =========================================================================
//  TELEGRAM
// =========================================================================

test('Telegram: the linked customer approves with the inline button; the press is answered and the message stamped; a replayed press moves nothing', async () => {
  const f = stubFetch();
  try {
    const raw = seed({ payment: 'wallet', walletIqd: 100_000, due: 0 });
    const pid = (await json(await propose(raw, { new_total_iqd: 70_000 }))).adjustment.id as string;
    await settle();
    f.calls.length = 0;

    assert.equal((await press(raw, `pa:y:${pid}`)).status, 200);
    await settle();
    assert.equal(adjOf(raw, pid).state, 'approved');
    assert.equal(adjOf(raw, pid).decided_via, 'telegram');
    assert.equal(orderOf(raw).total_iqd, 70_000);
    const answer = f.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.match(String(answer!.body.text), /تمت الموافقة/);
    const edit = f.calls.find((c) => c.method === 'editMessageText');
    assert.ok(edit);
    assert.deepEqual((edit!.body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard.flat().filter((b) => 'callback_data' in (b as object)), []);
    assert.ok(f.calls.some((c) => c.method === 'sendMessage' && String(c.body.chat_id) === ADMIN_CHAT));

    // The same button pressed again (a new update — Telegram's own redelivery is deduped earlier).
    f.calls.length = 0;
    await press(raw, `pa:y:${pid}`);
    await settle();
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE id LIKE 'wtx_padj_%'"), 1);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_adjust.approve'"), 1);
    assert.ok(!f.calls.some((c) => c.method === 'sendMessage' && String(c.body.chat_id) === ADMIN_CHAT), 'the admin is not told twice');
    // And the opposite button after the fact does not undo it.
    await press(raw, `pa:n:${pid}`);
    assert.equal(adjOf(raw, pid).state, 'approved');
  } finally {
    f.restore();
  }
});

test('Telegram: a press from any other Telegram account is refused and audited; the proposal stays pending', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    const pid = (await json(await propose(raw))).adjustment.id as string;
    await settle();
    f.calls.length = 0;
    await press(raw, `pa:y:${pid}`, STRANGER_TG);
    assert.equal(adjOf(raw, pid).state, 'pending');
    assert.equal(orderOf(raw).price_hold_id, pid);
    const answer = f.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.match(String(answer!.body.text), /لصاحب الطلب فقط/);
    assert.equal(answer!.body.show_alert, true);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_adjust.telegram_denied'"), 1);
    // A revoked link is no longer the owner either.
    raw.exec("UPDATE telegram_links SET revoked_at = '2026-09-25T00:00:00.000Z' WHERE user_id = 'cust'");
    await press(raw, `pa:y:${pid}`);
    assert.equal(adjOf(raw, pid).state, 'pending');
  } finally {
    f.restore();
  }
});

test('Telegram: reject from the button releases the hold and keeps the price', async () => {
  const f = stubFetch();
  try {
    const raw = seed();
    const pid = (await json(await propose(raw))).adjustment.id as string;
    await settle();
    await press(raw, `pa:n:${pid}`);
    await settle();
    assert.equal(adjOf(raw, pid).state, 'rejected');
    assert.deepEqual([orderOf(raw).total_iqd, orderOf(raw).price_hold_id], [100_000, null]);
  } finally {
    f.restore();
  }
});

test('the whole flow stays inside the live D1 limits', () => {
  assert.deepEqual(violations, []);
});

test('after an approval the invoice gets a correction revision carrying the adjustment line; the receipt prints it', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO invoices (id, invoice_no, order_id, revision, snapshot, amount_paid_iqd, amount_due_iqd, payment_status, issued_at)
            VALUES ('inv_1', 'INV-2026-00000001', 'ORD-PA1', 1, '{}', 0, 100000, 'cod_due', '2026-09-20T10:00:00.000Z')`);
  const pid = (await json(await propose(raw, { new_total_iqd: 112_500 }))).adjustment.id as string;
  await post(customerApp(raw), `/api/orders/ORD-PA1/price-adjustment/${pid}/approve`);
  await settle();
  const rev = row<{ revision: number; snapshot: string; amount_due_iqd: number }>(
    raw,
    "SELECT revision, snapshot, amount_due_iqd FROM invoices WHERE order_id = 'ORD-PA1' AND superseded_by IS NULL"
  )!;
  assert.equal(rev.revision, 2);
  assert.equal(rev.amount_due_iqd, 112_500);
  const snap = JSON.parse(rev.snapshot) as { totals: { total_iqd: number; price_adjustment_iqd: number } };
  assert.deepEqual([snap.totals.total_iqd, snap.totals.price_adjustment_iqd], [112_500, 12_500]);
  const receipt = await get(adminApp(raw), '/api/admin/orders/ORD-PA1/receipt');
  assert.match(await receipt.text(), /تعديل السعر/);
});
