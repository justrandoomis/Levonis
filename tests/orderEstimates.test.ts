/**
 * «تأكيد السعر النهائي» — SETTLING AN ORDER'S ESTIMATED LINES
 * (docs/SMART_PRICING.md §6.5–6.8; migration 0218, trigger T11; DECISIONS row
 * 280; invariant I5: nothing extra is charged without approval).
 *
 * Every order here is placed through the REAL checkout at an estimated price,
 * and every decision goes through the REAL doors: the financial admin's
 * confirm, the 0140 proposal it becomes, the customer's approve and reject,
 * an admin's withdraw, the customer's cancel. Telegram and the mail provider
 * are stubbed at `fetch`; the D1 limits the local engine does not enforce are
 * (`LimitD1`).
 *
 *   CONFIRM      every final equal to its estimate confirms in one batch — no
 *                money, the gate opens, the customer is told in-app; finals
 *                whose differences cancel out (or a kept total) confirm the
 *                same way, each at its own price, and the notice lists the
 *                moved lines; a different total is a 0140 proposal with
 *                `reason_code` ESTIMATE_FINAL_PRICE, the changed lines
 *                `proposed` under it, the others `confirmed`.
 *   DECISIONS    approve moves the money exactly as 0140 plans it and opens
 *                the gate; reject keeps it closed, and the admin honours the
 *                estimate or cancels with a full refund; withdraw re-opens the
 *                lines; the customer's cancel voids them.
 *   BLOCKER      an ordinary proposal is refused while a line is open
 *                (PRICE_ESTIMATE_OPEN), and is the ordinary 0140 afterwards.
 *
 * Run: node --import tsx --test tests/orderEstimates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, count, get, json, patch, pending, post, row, stubApp, type StubUser } from './fixtures/app';
import { LimitD1, violations } from './fixtures/d1Limits';
import { leaks } from './fixtures/costlyProduct';
import { seedCatalogue, orderBody } from './lib/bundles';
import { publishSeededV2 } from './fixtures/autoPublish';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../worker/routes/orderPriceAdjust';
import { ESTIMATE_PROPOSAL_REASON, estimateProposalNote } from '../worker/lib/orderEstimates';
import { planPriceAdjustment } from '../packages/pricing/src/priceAdjustment';
import { ESTIMATE_NOTICE_VERSION, ESTIMATE_REASON_CODE, ESTIMATE_STRINGS, fillEstimateText } from '../packages/contracts/src/priceEstimates';

const CUSTOMER_TOKEN = '1111:CUSTOMER-BOT-TOKEN';
const ADMIN_CHAT = '-100999';
const CUSTOMER_TG = 7001;

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };

interface Call {
  method: string;
  body: Record<string, unknown>;
}
/** Telegram and the mail provider at `fetch`, file-wide: nothing leaves the process. */
const calls: Call[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let body: Record<string, unknown> = {};
  try {
    body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(String(input));
  calls.push({ method: m ? m[1] : 'email', body });
  return new Response(JSON.stringify({ ok: true, id: 'em_1', result: { message_id: 501, chat: { id: Number(body.chat_id ?? 0) || 1 } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const ENV = {
  TELEGRAM_BOT_TOKEN: CUSTOMER_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT,
  APP_ORIGIN: 'https://levonis-iq.com',
  EMAIL_API_KEY: 're_k',
  EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
};

/** What the V2 writer's estimate batch does to the label (T1). */
function label(raw: DatabaseSync, pid: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';`);
}

function cartLine(raw: DatabaseSync, id: string, productId: string, qty = 1): void {
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty,fulfillment_type)
       VALUES (?,'buyer',?,'','[]','','','sea','',?,'pre_order')`
    )
    .run(id, productId, qty);
}

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * One order placed through the real checkout at estimated prices: TPU
 * (`p_pre2`) and, when asked, PETG (`p_pre`), both by sea and both labelled —
 * cash on delivery, or prepaid in full from the wallet; delivered to the
 * buyer's address, or collected from the warehouse.
 */
async function world(o: { petg?: boolean; wallet?: boolean; qty?: number; pickup?: boolean } = {}) {
  const raw = seedCatalogue();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('helper','Mona','helper@x.co','h','admin');
    UPDATE users SET admin_scope = 'assistant' WHERE id = 'helper';
    -- The buyer reads Arabic (the messages below are asserted in it).
    UPDATE users SET locale = 'ar', email_verified_at = '2026-01-01T00:00:00.000Z' WHERE id = 'buyer';
    INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
      VALUES ('buyer', ${CUSTOMER_TG}, ${CUSTOMER_TG}, '+9647701234567', '2026-01-01T00:00:00.000Z');
  `);
  await publishSeededV2(raw);
  label(raw, 'p_pre2');
  label(raw, 'p_pre');
  cartLine(raw, 'ci_tpu', 'p_pre2', o.qty ?? 1);
  if (o.petg) cartLine(raw, 'ci_petg', 'p_pre');
  const db = new LimitD1(raw) as unknown as D1Database;
  const buyer = stubApp(db, BUYER, (a) => {
    a.route('/api/orders', orderRoutes);
    a.route('/api/orders', orderPriceRoutes);
  }, { publishV2: false, env: ENV });
  const admin = (user: StubUser = OWNER) =>
    stubApp(db, user, (a) => {
      a.route('/api/admin/orders', adminOrderPriceRoutes);
      a.route('/api/admin', adminRoutes);
    }, { publishV2: false, env: ENV });
  const res = await post(buyer, '/api/orders', orderBody({
    paymentMethodId: o.wallet ? 'wallet' : 'cash',
    useWallet: !!o.wallet,
    price_estimate_ack: ESTIMATE_NOTICE_VERSION,
    ...(o.pickup ? { deliveryMethodId: 'pickup' } : {}),
  }));
  const placed = await json(res);
  assert.equal(res.status, 200, JSON.stringify(placed).slice(0, 400));
  const orderId = String(placed.order.id);
  const lines = all<Rec>(raw, 'SELECT * FROM order_price_estimates WHERE order_id = ?', orderId);
  const of = (pid: string) => lines.find((l) => l.product_id === pid)!;
  return { raw, db, buyer, admin, orderId, tpu: of('p_pre2'), petg: o.petg ? of('p_pre') : null };
}
type World = Awaited<ReturnType<typeof world>>;

let keySeq = 0;
const confirm = async (w: World, finals: Array<[Rec, number]>, extra: Record<string, unknown> = {}, user: StubUser = OWNER) => {
  const res = await post(w.admin(user), `/api/admin/orders/${w.orderId}/price-estimate/confirm`, {
    idempotency_key: `estimate-key-${++keySeq}-abcdef`,
    lines: finals.map(([l, f]) => ({ order_item_id: l.order_item_id, final_unit_iqd: f })),
    ...extra,
  });
  return { status: res.status, body: await json(res) };
};
const recordOf = (w: World, l: Rec) => row<Rec>(w.raw, 'SELECT * FROM order_price_estimates WHERE order_item_id = ?', l.order_item_id)!;
const orderOf = (w: World) => row<Rec>(w.raw, 'SELECT * FROM orders WHERE id = ?', w.orderId)!;
const moveTo = (w: World, stage: string) => patch(w.admin(), `/api/admin/orders/${w.orderId}/stage`, { stage });
const settle = async () => {
  await Promise.all(pending.splice(0));
};

// =========================================================================
//  CONFIRM
// =========================================================================

test('every final equal to its estimate: one batch confirms, no money moves, the gate opens, the customer is told in-app', async () => {
  const w = await world();
  // Any admin reads the panel — customer prices only — and only a financial one may act.
  const asAssistant = await json(await get(w.admin(ASSISTANT), `/api/admin/orders/${w.orderId}/price-estimate`));
  assert.equal(asAssistant.success, true, JSON.stringify(asAssistant).slice(0, 300));
  assert.equal(asAssistant.can_confirm, false);
  assert.equal(asAssistant.financial_scope, false);
  assert.equal(asAssistant.unsettled, 1);
  const line = asAssistant.lines[0];
  assert.deepEqual([line.order_item_id, line.qty, line.channel, line.state], [w.tpu.order_item_id, 1, 'pre_order_sea', 'open']);
  assert.equal(line.estimate_unit_iqd, w.tpu.estimate_unit_iqd);
  assert.equal(line.current_unit_iqd, w.tpu.estimate_unit_iqd, 'today’s published price of the SKU × channel');
  assert.equal('offer_before_unit_iqd' in line || 'offer_today_unit_iqd' in line, false, 'a line bought with no offer reads as it always did');
  assert.deepEqual(leaks(asAssistant), []);
  assert.equal((await json(await get(w.admin(), `/api/admin/orders/${w.orderId}/price-estimate`))).can_confirm, true);
  const refused = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd]], {}, ASSISTANT);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'FINANCIAL_SCOPE_REQUIRED');

  const before = orderOf(w);
  assert.equal((await moveTo(w, 'confirmed')).status, 409, 'held until settled');
  const key = 'estimate-same-key-0001';
  const res = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd]], { idempotency_key: key });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.deepEqual([res.body.outcome, res.body.replayed, res.body.lines[0].state], ['confirmed', false, 'confirmed']);
  const after = orderOf(w);
  assert.deepEqual(
    [after.total_iqd, after.due_on_delivery_iqd, after.wallet_applied_iqd, after.price_hold_id, after.price_adjustment_iqd],
    [before.total_iqd, before.due_on_delivery_iqd, before.wallet_applied_iqd, null, before.price_adjustment_iqd]
  );
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM order_price_adjustments'), 0, 'no proposal, no money');
  const rec = recordOf(w, w.tpu);
  assert.deepEqual([rec.state, rec.final_unit_iqd, rec.adjustment_id, rec.decided_by], ['confirmed', w.tpu.estimate_unit_iqd, null, 'boss']);
  const told = fillEstimateText(ESTIMATE_STRINGS.confirmedNoChange, { id: w.orderId });
  const notice = row<Rec>(w.raw, "SELECT * FROM user_notifications WHERE user_id = 'buyer' AND event_key LIKE 'order.price_estimate.confirmed:%'")!;
  assert.equal(notice.title_ar, told.ar);
  assert.equal(notice.title_en, told.en);
  assert.equal(JSON.parse(String(notice.meta)).title_ckb, told.ckb);
  assert.deepEqual([notice.body_ar, notice.body_en, JSON.parse(String(notice.meta)).body_ckb], ['', '', undefined], 'nothing moved, no rows');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_estimate.confirm' AND target = ?", w.orderId), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM ops_guards WHERE id LIKE 'estimate-settle:%'"), 0);

  // The same request again is its own answer, and writes nothing twice.
  const again = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd]], { idempotency_key: key });
  assert.deepEqual([again.status, again.body.outcome, again.body.replayed], [200, 'confirmed', true]);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_estimate.confirm'"), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE event_key LIKE 'order.price_estimate.confirmed:%'"), 1);

  // The gate is open: the order moves on.
  const moved = await moveTo(w, 'confirmed');
  assert.equal(moved.status, 200, JSON.stringify(await json(moved)).slice(0, 300));
  assert.equal(orderOf(w).status, 'confirmed');
});

test('finals whose differences cancel out confirm in the same batch, each line at its own final price, the total unchanged', async () => {
  const w = await world({ petg: true });
  const before = orderOf(w);
  const res = await confirm(w, [
    [w.tpu, w.tpu.estimate_unit_iqd + 1000],
    [w.petg!, w.petg!.estimate_unit_iqd - 1000],
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.outcome, 'confirmed');
  assert.deepEqual([recordOf(w, w.tpu).state, recordOf(w, w.tpu).final_unit_iqd], ['confirmed', w.tpu.estimate_unit_iqd + 1000]);
  assert.deepEqual([recordOf(w, w.petg!).state, recordOf(w, w.petg!).final_unit_iqd], ['confirmed', w.petg!.estimate_unit_iqd - 1000]);
  assert.equal(orderOf(w).total_iqd, before.total_iqd);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM order_price_adjustments'), 0);
  // The customer is told the total held AND which prices moved (§6.5) — never «no change»: the moved
  // finals now govern returns and price protection.
  assertTotalUnchangedNotice(w, [
    [w.tpu, w.tpu.estimate_unit_iqd + 1000],
    [w.petg!, w.petg!.estimate_unit_iqd - 1000],
  ]);
  assert.equal((await moveTo(w, 'confirmed')).status, 200);
});

/** The same-total notice: «confirmed, total unchanged», its body one row per moved line in each language. */
function assertTotalUnchangedNotice(w: World, moved: Array<[Rec, number]>): void {
  const notices = all<Rec>(w.raw, "SELECT * FROM user_notifications WHERE user_id = 'buyer' AND event_key LIKE 'order.price_estimate.confirmed:%'");
  assert.equal(notices.length, 1);
  const notice = notices[0]!;
  const meta = JSON.parse(String(notice.meta));
  const told = fillEstimateText(ESTIMATE_STRINGS.confirmedTotalUnchanged, { id: w.orderId });
  assert.deepEqual([notice.title_ar, notice.title_en, meta.title_ckb], [told.ar, told.en, told.ckb]);
  const g = (n: number) => n.toLocaleString('en-US');
  const rows = (unit: string, arrow: string) =>
    moved
      .map(([l, to]) => {
        const it = row<Rec>(w.raw, 'SELECT name_snapshot, option_snapshot FROM order_items WHERE id = ?', l.order_item_id)!;
        const label = `${it.name_snapshot}${it.option_snapshot ? ` — ${it.option_snapshot}` : ''} × ${l.qty}`;
        return `${label}: ${g(l.estimate_unit_iqd)} ${unit} ${arrow} ${g(to)} ${unit}`;
      })
      .sort();
  assert.deepEqual(String(notice.body_en).split('\n').sort(), rows('IQD', '→'));
  assert.deepEqual(String(notice.body_ar).split('\n').sort(), rows('د.ع', '←'), 'old ← new reads right to left');
  assert.deepEqual(String(meta.body_ckb).split('\n').sort(), rows('د.ع', '←'));
  assert.equal(meta.price_estimate, 'confirmed');
}

test('a moved line with the total kept by hand confirms without money, and the notice lists it', async () => {
  const w = await world();
  const before = orderOf(w);
  const res = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000]], { new_total_iqd: before.total_iqd });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.outcome, 'confirmed');
  assert.deepEqual([recordOf(w, w.tpu).state, recordOf(w, w.tpu).final_unit_iqd], ['confirmed', w.tpu.estimate_unit_iqd + 2000]);
  assert.deepEqual([orderOf(w).total_iqd, orderOf(w).due_on_delivery_iqd], [before.total_iqd, before.due_on_delivery_iqd]);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM order_price_adjustments'), 0, 'no proposal, no money');
  assertTotalUnchangedNotice(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000]]);
});

test('a different total is a 0140 proposal with reason_code ESTIMATE_FINAL_PRICE: changed lines proposed under it, the others confirmed', async () => {
  const w = await world({ petg: true });
  const before = orderOf(w);
  const res = await confirm(w, [
    [w.tpu, w.tpu.estimate_unit_iqd + 2000],
    [w.petg!, w.petg!.estimate_unit_iqd],
  ], { note: 'سعر المورد ارتفع' });
  assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.outcome, 'proposed');
  const adj = res.body.adjustment;
  assert.equal(adj.reason_code, ESTIMATE_REASON_CODE);
  assert.equal(adj.new_total_iqd, before.total_iqd + 2000);
  assert.equal(adj.state, 'pending');
  assert.deepEqual(adj.lines, [{
    order_item_id: w.tpu.order_item_id,
    name: row<Rec>(w.raw, 'SELECT name_snapshot FROM order_items WHERE id = ?', w.tpu.order_item_id)!.name_snapshot,
    variant: row<Rec>(w.raw, 'SELECT option_snapshot FROM order_items WHERE id = ?', w.tpu.order_item_id)!.option_snapshot ?? '',
    qty: 1,
    estimate_unit_iqd: w.tpu.estimate_unit_iqd,
    final_unit_iqd: w.tpu.estimate_unit_iqd + 2000,
  }]);
  // The stored row: the code, the three-language reason, the per-line old → new note.
  const stored = row<Rec>(w.raw, 'SELECT * FROM order_price_adjustments WHERE id = ?', adj.id)!;
  assert.equal(stored.reason_code, ESTIMATE_REASON_CODE);
  assert.equal(stored.reason, ESTIMATE_PROPOSAL_REASON);
  assert.ok(String(stored.note).includes(`${w.tpu.estimate_unit_iqd.toLocaleString('en-US')} → ${(w.tpu.estimate_unit_iqd + 2000).toLocaleString('en-US')}`), stored.note);
  assert.ok(String(stored.note).includes('سعر المورد ارتفع'));
  // The lines: TPU proposed under the proposal's own id; PETG confirmed at its estimate.
  const tpu = recordOf(w, w.tpu);
  assert.deepEqual([tpu.state, tpu.adjustment_id, tpu.final_unit_iqd], ['proposed', adj.id, w.tpu.estimate_unit_iqd + 2000]);
  const petg = recordOf(w, w.petg!);
  assert.deepEqual([petg.state, petg.adjustment_id, petg.final_unit_iqd], ['confirmed', null, w.petg!.estimate_unit_iqd]);
  // Held, and no money moved yet.
  const held = orderOf(w);
  assert.deepEqual([held.price_hold_id, held.total_iqd, held.due_on_delivery_iqd], [adj.id, before.total_iqd, before.due_on_delivery_iqd]);
  assert.equal((await json(await moveTo(w, 'confirmed'))).code, 'PRICE_APPROVAL_PENDING');

  // The customer reads the localized reason and the rows, never the stored three-language line.
  const shown = await json(await get(w.buyer, `/api/orders/${w.orderId}/price-adjustment`));
  assert.equal(shown.pending.id, adj.id);
  assert.equal(shown.pending.reason_code, ESTIMATE_REASON_CODE);
  assert.equal(shown.pending.lines.length, 1);
  assert.deepEqual(leaks(shown), []);
  const inApp = row<Rec>(w.raw, "SELECT * FROM user_notifications WHERE user_id = 'buyer' AND event_key = ?", `order.price_adjust:${adj.id}`)!;
  assert.ok(String(inApp.body_ar).includes(ESTIMATE_STRINGS.estimateReason.ar));
  assert.ok(!String(inApp.body_ar).includes(ESTIMATE_STRINGS.estimateReason.en));
  assert.ok(String(inApp.body_en).includes(ESTIMATE_STRINGS.estimateReason.en));
  assert.ok(String(JSON.parse(String(inApp.meta)).body_ckb).includes(ESTIMATE_STRINGS.estimateReason.ckb));
  await settle();
  // The prompt is the message carrying this proposal's two decision buttons.
  const prompt = calls.find(
    (c) =>
      c.method === 'sendMessage' &&
      Number(c.body.chat_id) === CUSTOMER_TG &&
      JSON.stringify(c.body.reply_markup ?? {}).includes(`pa:y:${adj.id}`)
  );
  assert.ok(prompt, 'the customer got the Telegram prompt with the two buttons');
  assert.ok(String(prompt!.body.text).includes(ESTIMATE_STRINGS.estimateReason.ar));
  assert.ok(String(prompt!.body.text).includes(ESTIMATE_STRINGS.estimateRejectNote.ar));
  assert.ok(!String(prompt!.body.text).includes(ESTIMATE_STRINGS.estimateReason.en), 'one language, never the stored three');
});

test('an edited total is the financial admin’s figure; an edited total with no changed line is refused', async () => {
  const w = await world();
  const total = orderOf(w).total_iqd;
  const noChange = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd]], { new_total_iqd: total + 500 });
  assert.equal(noChange.status, 400);
  assert.equal(noChange.body.code, 'PRICE_ADJUST_INVALID_TOTAL');
  const res = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000]], { new_total_iqd: total + 1000 });
  assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.adjustment.new_total_iqd, total + 1000);
  assert.equal(recordOf(w, w.tpu).final_unit_iqd, w.tpu.estimate_unit_iqd + 2000);
});

// =========================================================================
//  DECISIONS
// =========================================================================

test('approve (cash on delivery, higher): the money moves exactly as 0140 plans it, the lines are approved, the gate opens', async () => {
  const w = await world();
  const before = orderOf(w);
  const proposed = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000]]);
  const pid = proposed.body.adjustment.id as string;
  const plan = planPriceAdjustment({
    totalIqd: before.total_iqd, dueOnDeliveryIqd: before.due_on_delivery_iqd, walletAppliedIqd: before.wallet_applied_iqd,
    paymentMethodId: before.payment_method_id, newTotalIqd: before.total_iqd + 2000,
  });
  assert.ok(plan.ok);
  const res = await post(w.buyer, `/api/orders/${w.orderId}/price-adjustment/${pid}/approve`);
  assert.equal(res.status, 200, JSON.stringify(await json(res)).slice(0, 300));
  const after = orderOf(w);
  assert.deepEqual(
    [after.total_iqd, after.due_on_delivery_iqd, after.wallet_applied_iqd, after.price_adjustment_iqd, after.price_hold_id],
    [plan.plan.newTotalIqd, plan.plan.newDueIqd, plan.plan.newWalletIqd, 2000, null]
  );
  const rec = recordOf(w, w.tpu);
  assert.deepEqual([rec.state, rec.adjustment_id, rec.final_unit_iqd, rec.decided_by], ['approved', pid, w.tpu.estimate_unit_iqd + 2000, 'buyer']);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE id LIKE 'wtx_padj_%'"), 0, 'the wallet is never debited again');
  assert.equal((await moveTo(w, 'confirmed')).status, 200);
  await settle();
});

/**
 * A CASH PICKUP CARRIES ITS APPROVED RISE TO THE WAREHOUSE COUNTER (payment
 * policy 5, 3.1 and 3.2; DECISIONS row 312). 0140's money rule has no pickup
 * branch: the rise joins `due_on_delivery_iqd`, which on a pickup is what
 * payment 3.2 says is paid on collection, untaxed, and the invoice's next
 * revision says the same; the counter's recorded collection of that amount
 * settles the order. Purchase 4.16 and price_protection 5.6 still say the rise
 * is «collected only at the door» — whether they move is the owner's open
 * question in row 312 (tests/paymentCashAtPickup.test.ts lists them), and this
 * is the fact the question rests on.
 */
test('approve (cash at warehouse pickup, higher): the rise joins what is paid on collection, untaxed, on the order and its invoice; the counter’s recorded collection settles it', async () => {
  const w = await world({ pickup: true });
  const before = orderOf(w);
  assert.deepEqual(
    [before.delivery_method_id, before.payment_method_id, before.cod_tax_iqd, before.wallet_applied_iqd, before.due_on_delivery_iqd],
    ['pickup', 'cash', 0, 0, before.total_iqd],
    'a cash pickup: no tax, nothing ahead, the whole total paid on collection'
  );
  const proposed = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000]]);
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body).slice(0, 300));
  const pid = proposed.body.adjustment.id as string;
  const res = await post(w.buyer, `/api/orders/${w.orderId}/price-adjustment/${pid}/approve`);
  assert.equal(res.status, 200, JSON.stringify(await json(res)).slice(0, 300));
  await settle();
  const after = orderOf(w);
  assert.deepEqual(
    [after.total_iqd, after.due_on_delivery_iqd, after.wallet_applied_iqd, after.cod_tax_iqd, after.delivery_method_id],
    [before.total_iqd + 2000, before.due_on_delivery_iqd + 2000, 0, 0, 'pickup'],
    'the rise is owed at the counter, untaxed, and nothing is taken from the wallet'
  );
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE id LIKE 'wtx_padj_%'"), 0, 'the wallet is never debited for it');
  const invoice = row<Rec>(
    w.raw,
    'SELECT amount_due_iqd, amount_paid_iqd, payment_status FROM invoices WHERE order_id = ? AND superseded_by IS NULL ORDER BY revision DESC LIMIT 1',
    w.orderId
  )!;
  assert.deepEqual([invoice.amount_due_iqd, invoice.amount_paid_iqd, invoice.payment_status], [after.due_on_delivery_iqd, 0, 'cod_due'], 'the invoice owes what the counter collects');

  // The team records the cash taken at the warehouse: the approved amount, once, and the order is paid.
  const counter = stubApp(w.db, OWNER, (a) => a.route('/api/orders', orderRoutes), { publishV2: false, env: ENV });
  const settled = await json(await post(counter, `/api/orders/${w.orderId}/settlement`, { amountIqd: after.due_on_delivery_iqd, eventKey: 'pickup-cash:estimate-1' }));
  assert.equal(settled.success, true, JSON.stringify(settled).slice(0, 300));
  assert.deepEqual(
    [settled.settlement.collected_iqd, settled.settlement.outstanding_iqd, settled.settlement.fully_settled],
    [after.total_iqd, 0, true]
  );
  await settle();
});

test('approve (prepaid from the wallet, lower): the difference comes back to the wallet in the same batch, exactly as 0140', async () => {
  const w = await world({ wallet: true });
  const before = orderOf(w);
  assert.equal(before.due_on_delivery_iqd, 0, 'paid in full from the wallet');
  const proposed = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd - 2000]]);
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body).slice(0, 300));
  const pid = proposed.body.adjustment.id as string;
  assert.equal(proposed.body.adjustment.wallet_refund_iqd, 2000);
  await post(w.buyer, `/api/orders/${w.orderId}/price-adjustment/${pid}/approve`);
  const after = orderOf(w);
  assert.deepEqual([after.total_iqd, after.due_on_delivery_iqd, after.wallet_applied_iqd], [before.total_iqd - 2000, 0, before.wallet_applied_iqd - 2000]);
  const credit = row<Rec>(w.raw, "SELECT * FROM wallet_transactions WHERE id LIKE 'wtx_padj_%'")!;
  assert.deepEqual([credit.type, credit.status, credit.ref], ['deposit', 'approved', `order-price:${w.orderId}`]);
  assert.equal(recordOf(w, w.tpu).state, 'approved');
  await settle();
});

test('reject keeps the gate closed and tells the admin to choose; honouring the estimate then opens it, with no money moved', async () => {
  const w = await world();
  const before = orderOf(w);
  const pid = (await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000]])).body.adjustment.id as string;
  await settle();
  calls.length = 0;
  const res = await post(w.buyer, `/api/orders/${w.orderId}/price-adjustment/${pid}/reject`);
  assert.equal(res.status, 200);
  await settle();
  const rec = recordOf(w, w.tpu);
  assert.deepEqual([rec.state, rec.adjustment_id, rec.final_unit_iqd], ['rejected', pid, w.tpu.estimate_unit_iqd + 2000]);
  const o = orderOf(w);
  assert.deepEqual([o.price_hold_id, o.total_iqd, o.status], [null, before.total_iqd, 'pending']);
  const gate = await json(await moveTo(w, 'confirmed'));
  assert.equal(gate.code, 'PRICE_ESTIMATE_UNCONFIRMED', 'the hold is released, the gate is not');
  const adminNote = calls.find((c) => c.method === 'sendMessage' && String(c.body.chat_id) === ADMIN_CHAT);
  assert.ok(adminNote && String(adminNote.body.text).includes('اختر: إبقاء السعر التقديري أو الإلغاء مع الاسترداد'), JSON.stringify(adminNote?.body).slice(0, 300));
  const stamp = calls.find((c) => c.method === 'editMessageText');
  assert.ok(stamp && String(stamp.body.text).includes('إما أن نُبقي سعرك الأصلي'), 'the decided prompt says what a rejection leads to');

  // The admin honours the estimate: the same total, so a confirmation — no proposal, no money.
  const honoured = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd]]);
  assert.equal(honoured.status, 200, JSON.stringify(honoured.body).slice(0, 300));
  assert.equal(honoured.body.outcome, 'confirmed');
  assert.deepEqual([recordOf(w, w.tpu).state, recordOf(w, w.tpu).final_unit_iqd, recordOf(w, w.tpu).adjustment_id], ['confirmed', w.tpu.estimate_unit_iqd, null]);
  assert.equal(orderOf(w).total_iqd, before.total_iqd);
  // Honouring the estimate moves no line's price: «no change».
  const honourNotice = row<Rec>(w.raw, "SELECT * FROM user_notifications WHERE user_id = 'buyer' AND event_key LIKE 'order.price_estimate.confirmed:%'")!;
  assert.equal(honourNotice.title_en, fillEstimateText(ESTIMATE_STRINGS.confirmedNoChange, { id: w.orderId }).en);
  assert.equal(honourNotice.body_en, '');
  assert.equal((await moveTo(w, 'confirmed')).status, 200);
});

test('or the rejected estimate is cancelled with a full refund through the ordinary cancel; the lines are void', async () => {
  const w = await world({ wallet: true });
  const before = orderOf(w);
  const pid = (await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000]])).body.adjustment.id as string;
  await post(w.buyer, `/api/orders/${w.orderId}/price-adjustment/${pid}/reject`);
  const cancelled = await patch(w.admin(), `/api/admin/orders/${w.orderId}`, { status: 'cancelled' });
  assert.equal(cancelled.status, 200, JSON.stringify(await json(cancelled)).slice(0, 300));
  assert.equal(recordOf(w, w.tpu).state, 'void');
  const refund = row<Rec>(w.raw, 'SELECT * FROM wallet_transactions WHERE id = ?', `wtx_refund_${w.orderId}_usd`)!;
  assert.equal(refund.amount, before.wallet_applied_usd_cents, 'every cent the wallet paid comes back');
  // …and the order is never re-opened (its money went back; its estimate lines are void).
  assert.ok(['REFUNDED_ORDER', 'PRICE_ESTIMATE_REOPEN_REFUSED'].includes((await json(await moveTo(w, 'confirmed'))).code));
  assert.equal(orderOf(w).status, 'cancelled');
  await settle();
});

test('withdraw re-opens the lines and the gate stays closed; the next settlement proposes again', async () => {
  const w = await world();
  const pid = (await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000]])).body.adjustment.id as string;
  const res = await post(w.admin(ASSISTANT), `/api/admin/orders/${w.orderId}/price-adjustment/${pid}/withdraw`);
  assert.equal(res.status, 200, 'any admin may withdraw: it moves no money');
  const rec = recordOf(w, w.tpu);
  assert.deepEqual([rec.state, rec.adjustment_id, rec.final_unit_iqd], ['open', null, null]);
  assert.equal(orderOf(w).price_hold_id, null);
  assert.equal((await json(await moveTo(w, 'confirmed'))).code, 'PRICE_ESTIMATE_UNCONFIRMED');
  const again = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 1000]]);
  assert.equal(again.status, 201, JSON.stringify(again.body).slice(0, 300));
  assert.equal(recordOf(w, w.tpu).state, 'proposed');
  await settle();
});

test('the customer’s cancel voids the waiting proposal and every unsettled line; the order is never re-opened', async () => {
  const w = await world();
  const pid = (await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000]])).body.adjustment.id as string;
  const res = await post(w.buyer, `/api/orders/${w.orderId}/cancel`);
  assert.equal(res.status, 200, JSON.stringify(await json(res)).slice(0, 300));
  const adj = row<Rec>(w.raw, 'SELECT * FROM order_price_adjustments WHERE id = ?', pid)!;
  assert.deepEqual([adj.state, adj.decided_via], ['void', 'customer_cancel']);
  assert.equal(recordOf(w, w.tpu).state, 'void');
  const reopen = await json(await moveTo(w, 'confirmed'));
  assert.equal(reopen.code, 'PRICE_ESTIMATE_REOPEN_REFUSED');
  assert.equal((await json(await patch(w.admin(), `/api/admin/orders/${w.orderId}`, { status: 'pending' }))).code, 'PRICE_ESTIMATE_REOPEN_REFUSED');
  assert.equal(orderOf(w).status, 'cancelled');
  // Nothing is left to settle.
  const late = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd]]);
  assert.equal(late.status, 409);
  await settle();
});

// =========================================================================
//  THE BLOCKER, AND THE REQUEST'S OWN CHECKS
// =========================================================================

test('an ordinary proposal is refused while an estimated line is open (PRICE_ESTIMATE_OPEN), and is the ordinary 0140 after settlement', async () => {
  const w = await world();
  const total = orderOf(w).total_iqd;
  const plain = await post(w.admin(), `/api/admin/orders/${w.orderId}/price-adjustment`, {
    new_total_iqd: total + 3000, reason: 'شحن إضافي', idempotencyKey: 'plain-key-0001',
  });
  assert.equal(plain.status, 409);
  assert.equal((await json(plain)).code, 'PRICE_ESTIMATE_OPEN');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM order_price_adjustments'), 0);
  const panel = await json(await get(w.admin(), `/api/admin/orders/${w.orderId}/price-adjustment`));
  assert.deepEqual([panel.blocker, panel.estimate_open, panel.can_propose], ['PRICE_ESTIMATE_OPEN', true, false]);

  await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd]]);
  const settled = await json(await get(w.admin(), `/api/admin/orders/${w.orderId}/price-adjustment`));
  assert.deepEqual([settled.blocker, settled.estimate_open, settled.can_propose], [null, false, true]);
  const ordinary = await post(w.admin(), `/api/admin/orders/${w.orderId}/price-adjustment`, {
    new_total_iqd: total + 3000, reason: 'شحن إضافي', idempotencyKey: 'plain-key-0002',
  });
  assert.equal(ordinary.status, 201);
  const adj = (await json(ordinary)).adjustment;
  assert.equal(adj.reason_code, '');
  assert.equal('lines' in adj, false);
  await settle();
});

test('the request names every open line on the rounding rule; replays answer themselves; a reused key or a waiting proposal is refused', async () => {
  const w = await world({ petg: true });
  const missing = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd]]);
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'PRICE_ADJUST_STALE');
  assert.deepEqual([...missing.body.details.order_item_ids].sort(), [w.tpu.order_item_id, w.petg!.order_item_id].sort());
  const twice = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd], [w.tpu, w.tpu.estimate_unit_iqd]]);
  assert.equal(twice.body.code, 'PRICE_ADJUST_STALE');
  for (const bad of [w.tpu.estimate_unit_iqd + 120, 0, -250, 1.5]) {
    const r = await confirm(w, [[w.tpu, bad], [w.petg!, w.petg!.estimate_unit_iqd]]);
    assert.equal(r.status, 400, `final ${bad}`);
    assert.equal(r.body.code, 'PRICE_ADJUST_INVALID_TOTAL');
  }
  const asText = await post(w.admin(), `/api/admin/orders/${w.orderId}/price-estimate/confirm`, {
    idempotency_key: 'text-final-key-01', lines: [{ order_item_id: w.tpu.order_item_id, final_unit_iqd: String(w.tpu.estimate_unit_iqd) }],
  });
  assert.equal(asText.status, 400);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM order_price_adjustments'), 0, 'nothing written by a refusal');
  assert.deepEqual([recordOf(w, w.tpu).state, recordOf(w, w.petg!).state], ['open', 'open']);

  // A proposal, replayed with its own key, answers with itself; the key with another figure is refused.
  const key = 'estimate-replay-key-01';
  const finals: Array<[Rec, number]> = [[w.tpu, w.tpu.estimate_unit_iqd + 2000], [w.petg!, w.petg!.estimate_unit_iqd]];
  const first = await confirm(w, finals, { idempotency_key: key });
  assert.equal(first.status, 201);
  const replay = await confirm(w, finals, { idempotency_key: key });
  assert.deepEqual([replay.status, replay.body.outcome, replay.body.replayed, replay.body.adjustment.id], [200, 'proposed', true, first.body.adjustment.id]);
  const reused = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 3000], [w.petg!, w.petg!.estimate_unit_iqd]], { idempotency_key: key });
  assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');
  const waiting = await confirm(w, finals);
  assert.equal(waiting.status, 409);
  assert.equal(waiting.body.code, 'PRICE_APPROVAL_PENDING');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM order_price_adjustments'), 1);

  // An order with no estimate, or none at all: 404.
  assert.equal((await post(w.admin(), '/api/admin/orders/ORD-NOPE/price-estimate/confirm', { idempotency_key: 'nope-key-0001', lines: [{ order_item_id: 'x', final_unit_iqd: 1000 }] })).status, 404);
  await settle();
});

test('the panel and the proposal answers carry customer prices only — never a cost — for any admin', async () => {
  const w = await world({ petg: true });
  await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd + 2000], [w.petg!, w.petg!.estimate_unit_iqd]]);
  for (const user of [OWNER, ASSISTANT]) {
    const panel = await json(await get(w.admin(user), `/api/admin/orders/${w.orderId}/price-estimate`));
    assert.deepEqual(leaks(panel), [], user.id);
    assert.equal(panel.pending.reason_code, ESTIMATE_REASON_CODE);
    assert.deepEqual(panel.lines.map((l: Rec) => l.state).sort(), ['confirmed', 'proposed']);
    const history = await json(await get(w.admin(user), `/api/admin/orders/${w.orderId}/price-adjustment`));
    assert.deepEqual(leaks(history), [], user.id);
    assert.equal(history.pending.lines.length, 1);
  }
  await settle();
});

test('a cancel landing between the confirmation’s read and its batch: the fence aborts it whole — no line, no notice, no audit', async () => {
  const w = await world();
  // The customer's cancel commits while the admin's confirmation is in flight (after its reads, before its batch).
  const inner = new LimitD1(w.raw) as unknown as D1Database;
  let raced = false;
  const hooked = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: (statements: D1PreparedStatement[]) => {
      if (!raced) {
        raced = true;
        w.raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(w.orderId); // T10 voids the line
      }
      return inner.batch(statements);
    },
  } as unknown as D1Database;
  const admin = stubApp(hooked, OWNER, (a) => a.route('/api/admin/orders', adminOrderPriceRoutes), { publishV2: false, env: ENV });
  const res = await post(admin, `/api/admin/orders/${w.orderId}/price-estimate/confirm`, {
    idempotency_key: 'raced-confirm-key-01',
    lines: [{ order_item_id: w.tpu.order_item_id, final_unit_iqd: w.tpu.estimate_unit_iqd }],
  });
  assert.equal(res.status, 409, JSON.stringify(await json(res)).slice(0, 300));
  assert.equal(recordOf(w, w.tpu).state, 'void', 'the cancel won; nothing was confirmed');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE event_key LIKE 'order.price_estimate.confirmed:%'"), 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.price_estimate.confirm'"), 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM ops_guards WHERE id LIKE 'estimate-settle:%'"), 0, 'the fence row rolled back with the batch');
  // Asked again, the answer names the cancellation.
  const again = await confirm(w, [[w.tpu, w.tpu.estimate_unit_iqd]]);
  assert.equal(again.status, 409);
  assert.match(String(again.body.error), /cancelled/);
});

test('the proposal note: per-line old → new, bounded by 0140’s 1,000 characters', () => {
  const one = estimateProposalNote([{ name: 'TPU Spool', variant: 'Black', qty: 2, from: 45000, to: 47250 }], 'سعر المورد');
  assert.equal(one, 'TPU Spool — Black × 2: 45,000 → 47,250\nسعر المورد');
  const many = estimateProposalNote(
    Array.from({ length: 80 }, (_, i) => ({ name: `Spool number ${i} with a long name`, variant: 'Colour', qty: 1, from: 45000, to: 47000 })),
    'x'.repeat(500)
  );
  assert.ok(many.length <= 1000, String(many.length));
  assert.match(many, /\n\+\d+\n/, 'says how many more rows there were');
});

test('the whole flow stays inside the live D1 limits', () => {
  assert.deepEqual(violations, []);
});
