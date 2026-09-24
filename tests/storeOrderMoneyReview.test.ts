/**
 * THE WAVE-1 MONEY REVIEW, STORE ORDERS (findings F3–F7, and S6's admin door)
 * — each reviewer probe inverted into the guarantee it now pins.
 *
 *   F3  a hundred frozen credits at the head of the queue starved the release
 *       sweep for ever;
 *   F4  legacy rows: an order refunded then re-opened was paid to the
 *       merchant by the new sweep, and a paid order an old merchant-cancel
 *       never refunded had no door at all — a release guard, a read-only
 *       detector and two audited admin decisions;
 *   F5  a delivery an admin walked back re-released the moment the merchant
 *       marked it delivered again;
 *   F6  a same-key retry on a wallet holding exactly the order was refused by
 *       its own hold;
 *   F7  two checkout tabs on one cart both committed and both debited;
 *   S6  an assistant-scope admin could refund and claw back through the admin
 *       order doors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import {
  freshDb, asD1, stubApp, post, patch, get, json, count, row, all, pending, spendable, holds, ledger, failingD1,
  type StubUser,
} from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { orderRoutes } from '../worker/routes/orders';
import { merchantRoutes } from '../worker/routes/merchant';
import { adminRoutes } from '../worker/routes/admin';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { releaseDueStoreCredits, runStoreOrderSweeps, STORE_RELEASE_DAYS } from '../worker/lib/storeOrderOps';
import { merchantBalance } from '../worker/lib/escrowOps';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import type { Env } from '../worker/lib/types';

const FUTURE = '2099-01-01T00:00:00.000Z';
const DAY = 86_400_000;

function seed(raw: DatabaseSync, depositCents = 100_000) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('buyer','Sara','buyer@x.co','h','customer',NULL),
      ('ali','Ali','ali@x.co','h','merchant',NULL),
      ('boss','Boss','boss@x.co','h','admin',NULL),
      ('aide','Aide','aide@x.co','h','admin','assistant');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings)
      VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{"fee_iqd":1000}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,50,1);
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('dep_buyer','buyer','deposit','USD',${depositCents},'approved','seed');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
  `);
}

const buyerApp = (db: unknown) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
    a.route('/api/orders', orderRoutes);
  });
const merchantApp = (db: unknown) =>
  stubApp(db, { id: 'ali', role: 'merchant', email: 'ali@x.co' }, (a) => a.route('/api/merchant', merchantRoutes));
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const AIDE: StubUser = { id: 'aide', role: 'admin', email: 'aide@x.co', admin_scope: 'assistant' };
const adminApp = (db: unknown, user: StubUser = BOSS) =>
  stubApp(db, user, (a) => {
    a.route('/api/admin/community', adminCommunityRoutes);
    a.route('/api/admin', adminRoutes);
  });
const env = (db: unknown) => ({ DB: db } as unknown as Env);

async function addToCart(raw: DatabaseSync) {
  const add = await post(buyerApp(asD1(raw)), '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 });
  assert.equal(add.status, 201, JSON.stringify(await json(add.clone())));
}

async function placeOrder(raw: DatabaseSync, key = `k-${Math.random().toString(36).slice(2, 12)}`): Promise<string> {
  await addToCart(raw);
  const app = buyerApp(asD1(raw));
  const q = await json(await post(app, '/api/store-orders/quote', {}));
  const res = await post(app, '/api/store-orders', { idempotencyKey: key, addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint });
  const body = await json(res);
  assert.equal(res.status, 201, JSON.stringify(body));
  await Promise.allSettled(pending.splice(0));
  return String(body.order.id);
}

async function deliver(raw: DatabaseSync, id: string, from = ['confirmed', 'processing', 'shipped', 'delivered']) {
  const m = merchantApp(asD1(raw));
  for (const s of from) {
    const res = await post(m, `/api/merchant/orders/${id}/status`, { status: s });
    assert.equal(res.status, 200, `${s}: ${JSON.stringify(await json(res))}`);
  }
  await Promise.allSettled(pending.splice(0));
}

const creditOf = (raw: DatabaseSync, id: string) =>
  row<{ state: string; amount_iqd: number }>(raw, "SELECT state, amount_iqd FROM merchant_payout_ledger WHERE order_id = ? AND kind = 'sale_credit'", id)!;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

// ===================================================================== F3

test('F3 (probe P1 inverted): a hundred frozen credits at the head of the queue no longer starve a due, undisputed one', async () => {
  const raw = freshDb();
  seed(raw);
  const clean = await placeOrder(raw);
  await deliver(raw, clean);
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(ago(5), clean);
  const ins = raw.prepare(`INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
      payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,seller_type,merchant_id,store_id,origin,delivered_at)
    VALUES (?, 'buyer','delivered','{}','merchant','{}','wallet',1000,1400,1000,0,'merchant','m_ali','s_ali','store_product',?)`);
  const led = raw.prepare(`INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,order_id,idempotency_key)
    VALUES (?, 'm_ali','sale_credit',950,'pending',?,?)`);
  const tkt = raw.prepare(`INSERT INTO support_tickets (id,user_id,subject,order_id,state) VALUES (?, 'buyer','question',?,'waiting_customer')`);
  for (let i = 0; i < 100; i++) {
    const id = `ORD-OLD${String(i).padStart(4, '0')}`;
    ins.run(id, new Date(Date.now() - 10 * DAY + i * 1000).toISOString());
    led.run(`pay_old_${i}`, id, `sale:${id}`);
    tkt.run(`t_old_${i}`, id);
  }
  const r = await runStoreOrderSweeps(env(asD1(raw)), new Date().toISOString());
  assert.equal(r.released, 1, JSON.stringify(r));
  assert.equal(r.frozen, 100, 'the frozen rows are counted, not selected');
  assert.equal(creditOf(raw, clean).state, 'available');
  await Promise.allSettled(pending.splice(0));
});

// ===================================================================== F4

/** The B7 + re-open chain as the code before wave 1 left it: refunded, credit pending, re-opened. */
async function refundedThenReopened(raw: DatabaseSync, creditState: 'pending' | 'available' = 'pending') {
  const id = await placeOrder(raw, 'k-legacy-a-001');
  const debit = row<{ amount: number; amount_iqd: number }>(raw, "SELECT amount, amount_iqd FROM wallet_transactions WHERE ref = ? AND type='withdrawal'", id)!;
  raw.prepare(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,ref,created_by,amount_iqd,exchange_rate_snapshot)
               VALUES (?, 'buyer','deposit','USD',?,'approved','Refund for cancelled order',?,'system',?,1400)`).run(`wtx_refund_${id}_usd`, debit.amount, id, debit.amount_iqd);
  raw.prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(id);
  if (creditState === 'available') raw.prepare("UPDATE merchant_payout_ledger SET state = 'available' WHERE order_id = ?").run(id);
  return id;
}

/** The B2 victim as the code before wave 1 left it: the MERCHANT cancelled a paid order — credit reversed, no refund. */
async function unrefundedMerchantCancel(raw: DatabaseSync) {
  const id = await placeOrder(raw, 'k-legacy-b-001');
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(id);
  raw.prepare("UPDATE merchant_payout_ledger SET state = 'reversed' WHERE order_id = ?").run(id);
  return id;
}

test('F4 (probe P8a inverted): a refunded-then-reopened order’s credit is never released — not three days after delivery, not on «استلمت طلبي»', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await refundedThenReopened(raw);
  await deliver(raw, id, ['processing', 'shipped', 'delivered']);
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(ago(STORE_RELEASE_DAYS + 1), id);
  const r = await runStoreOrderSweeps(env(asD1(raw)), new Date().toISOString());
  assert.equal(r.released, 0);
  assert.equal(r.refund_blocked, 1, 'held back and counted');
  assert.equal(creditOf(raw, id).state, 'pending');
  // The customer's confirmation stamps the receipt and still pays nobody.
  const conf = await post(buyerApp(asD1(raw)), `/api/orders/${id}/confirm-receipt`, {});
  assert.equal(conf.status, 200, JSON.stringify(await json(conf.clone())));
  assert.ok(row<{ r: string | null }>(raw, 'SELECT receipt_confirmed_at r FROM orders WHERE id = ?', id)!.r);
  assert.equal(creditOf(raw, id).state, 'pending');
  assert.equal((await merchantBalance(asD1(raw), 'm_ali')).available_iqd, 0);
  await Promise.allSettled(pending.splice(0));
});

test('F4: the read-only detector lists BOTH legacy shapes to a financial admin — and an assistant is refused', async () => {
  const raw = freshDb();
  seed(raw);
  const a = await refundedThenReopened(raw);
  const b = await unrefundedMerchantCancel(raw);
  const ledgerBefore = count(raw, 'SELECT COUNT(*) n FROM merchant_payout_ledger');
  const txBefore = count(raw, 'SELECT COUNT(*) n FROM wallet_transactions');
  const res = await get(adminApp(asD1(raw)), '/api/admin/community/reconciliation/store-orders');
  assert.equal(res.status, 200);
  const d = await json(res);
  assert.deepEqual(d.refunded_reopened.map((o: { order_id: string }) => o.order_id), [a]);
  assert.equal(d.refunded_reopened[0].credit_state, 'pending');
  assert.deepEqual(d.cancelled_unrefunded.map((o: { order_id: string }) => o.order_id), [b]);
  assert.equal(d.cancelled_unrefunded[0].paid_usd_cents, row<{ amount: number }>(raw, "SELECT amount FROM wallet_transactions WHERE ref = ? AND type='withdrawal'", b)!.amount);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_payout_ledger'), ledgerBefore, 'looking changed nothing');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions'), txBefore);
  // A healthy order is in neither list.
  const healthy = await placeOrder(raw, 'k-healthy-0001');
  const again = await json(await get(adminApp(asD1(raw)), '/api/admin/community/reconciliation/store-orders'));
  assert.ok(![...again.refunded_reopened, ...again.cancelled_unrefunded].some((o: { order_id: string }) => o.order_id === healthy));
  // The owner's or a financial admin's list only.
  const aide = await get(adminApp(asD1(raw), AIDE), '/api/admin/community/reconciliation/store-orders');
  assert.equal(aide.status, 403);
  assert.equal((await json(aide)).code, 'FINANCIAL_SCOPE_REQUIRED');
});

test('F4 (probe P8b inverted): the unrefunded merchant-cancel victim is refunded — exactly the debit, once, audited — through the cancel operation’s own refund', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await unrefundedMerchantCancel(raw);
  const debit = row<{ amount: number; amount_iqd: number; exchange_rate_snapshot: number }>(raw,
    "SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE ref = ? AND type='withdrawal'", id)!;
  const before = spendable(raw, 'buyer');
  // Two submits at once: one refund.
  const db = serialD1(raw);
  const [r1, r2] = await Promise.all([
    post(adminApp(db), `/api/admin/community/reconciliation/store-orders/${id}/refund`, { reason: 'old merchant cancel never refunded' }),
    post(adminApp(db), `/api/admin/community/reconciliation/store-orders/${id}/refund`, { reason: 'old merchant cancel never refunded' }),
  ]);
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  const bodies = [await json(r1), await json(r2)];
  assert.deepEqual(bodies.map((b) => b.replayed).sort(), [false, true], 'one refund and one replay');
  const refund = row<{ amount: number; amount_iqd: number; exchange_rate_snapshot: number; created_by: string }>(raw,
    'SELECT amount, amount_iqd, exchange_rate_snapshot, created_by FROM wallet_transactions WHERE id = ?', `wtx_refund_${id}_usd`)!;
  assert.deepEqual({ amount: refund.amount, amount_iqd: refund.amount_iqd, exchange_rate_snapshot: refund.exchange_rate_snapshot }, debit,
    'the refund is the debit, cents AND the 0108 dinars');
  assert.equal(refund.created_by, 'admin');
  assert.equal(spendable(raw, 'buyer') - before, debit.amount);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.store_order_reconciled' AND target = ?", id), 1, 'one audit row');
  assert.equal(creditOf(raw, id).state, 'reversed', 'the merchant is still paid nothing');
  const list = await json(await get(adminApp(asD1(raw)), '/api/admin/community/reconciliation/store-orders'));
  assert.equal(list.cancelled_unrefunded.length, 0, 'the row leaves the list once reconciled');
});

test('F4: the refunded-then-reopened order’s credit is reversed by the admin decision — pending in place, available by a claw-back row — once', async () => {
  for (const state of ['pending', 'available'] as const) {
    const raw = freshDb();
    seed(raw);
    const id = await refundedThenReopened(raw, state);
    const availableBefore = (await merchantBalance(asD1(raw), 'm_ali')).available_iqd;
    const credit = creditOf(raw, id);
    const res = await post(adminApp(asD1(raw)), `/api/admin/community/reconciliation/store-orders/${id}/reverse-credit`, { reason: 'customer refunded before re-open' });
    assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
    assert.equal((await json(res)).replayed, false);
    if (state === 'pending') {
      assert.equal(creditOf(raw, id).state, 'reversed');
    } else {
      const claw = all<{ amount_iqd: number; state: string }>(raw, "SELECT amount_iqd, state FROM merchant_payout_ledger WHERE order_id = ? AND kind = 'reversal'", id);
      assert.deepEqual(claw, [{ amount_iqd: -credit.amount_iqd, state: 'available' }]);
      assert.equal((await merchantBalance(asD1(raw), 'm_ali')).available_iqd, availableBefore - credit.amount_iqd);
    }
    assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.store_order_reconciled' AND target = ?", id), 1);
    assert.equal(row<{ status: string }>(raw, 'SELECT status FROM orders WHERE id = ?', id)!.status, 'confirmed', 'the order itself is left as it is');
    const again = await post(adminApp(asD1(raw)), `/api/admin/community/reconciliation/store-orders/${id}/reverse-credit`, { reason: 'twice' });
    assert.equal((await json(again)).replayed, true);
    assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.store_order_reconciled' AND target = ?", id), 1, 'audited once');
    // A later cancellation of that order is not blocked by the claw-back
    // already taken, and takes nothing twice.
    const shipped = await patch(adminApp(asD1(raw)), `/api/admin/orders/${id}`, { status: 'cancelled' });
    assert.equal(shipped.status, 200, JSON.stringify(await json(shipped.clone())));
    assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_payout_ledger WHERE order_id = ? AND kind = 'reversal'", id), state === 'available' ? 1 : 0);
    assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions WHERE id = ?', `wtx_refund_${id}_usd`), 1, 'never refunded twice');
    await Promise.allSettled(pending.splice(0));
  }
});

test('F4: the credit reversal re-checks the order INSIDE its own batch — an order cancelled in between is left to its cancellation', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await refundedThenReopened(raw);
  // Between the decision's reads and its batch, something else cancels the
  // order (an out-of-band writer that — unlike `cancelStoreOrder` — does not
  // touch the credit). The decision must not act on the stale read.
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((st) => /SET state = 'reversed'/.test(st.sql))) {
      raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(id);
      failing.beforeBatch = null;
    }
  };
  const res = await post(adminApp(db), `/api/admin/community/reconciliation/store-orders/${id}/reverse-credit`, { reason: 'refunded before re-open' });
  assert.equal(res.status, 409, JSON.stringify(await json(res.clone())));
  assert.equal((await json(res)).code, 'RECONCILE_NOT_APPLICABLE');
  assert.equal(creditOf(raw, id).state, 'pending', 'nothing was reversed on the stale read');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.store_order_reconciled'"), 0);
});

test('F4: a decision on an order that is not in that shape is refused 409 RECONCILE_NOT_APPLICABLE and moves nothing', async () => {
  const raw = freshDb();
  seed(raw);
  const healthy = await placeOrder(raw);
  const tx = count(raw, 'SELECT COUNT(*) n FROM wallet_transactions');
  for (const path of ['refund', 'reverse-credit']) {
    const res = await post(adminApp(asD1(raw)), `/api/admin/community/reconciliation/store-orders/${healthy}/${path}`, { reason: 'probing' });
    assert.equal(res.status, 409, path);
    assert.equal((await json(res)).code, 'RECONCILE_NOT_APPLICABLE');
  }
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions'), tx);
  assert.equal(creditOf(raw, healthy).state, 'pending');
  const aide = await post(adminApp(asD1(raw), AIDE), `/api/admin/community/reconciliation/store-orders/${healthy}/refund`, { reason: 'probing' });
  assert.equal(aide.status, 403);
});

// ===================================================================== F5

test('F5 (probe P6 inverted): a delivery the admin walked back restarts the three days on the merchant’s next «تم التسليم»', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw, 'k-back-0001');
  await deliver(raw, id);
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(ago(5), id);
  const back = await patch(adminApp(asD1(raw)), `/api/admin/orders/${id}`, { status: 'shipped' });
  assert.equal(back.status, 200);
  const again = await post(merchantApp(asD1(raw)), `/api/merchant/orders/${id}/status`, { status: 'delivered' });
  assert.equal(again.status, 200);
  const at = Date.parse(row<{ d: string }>(raw, 'SELECT delivered_at d FROM orders WHERE id = ?', id)!.d);
  assert.ok(Date.now() - at < 60_000, 'delivered_at is the delivery that just happened');
  const r = await runStoreOrderSweeps(env(asD1(raw)), new Date().toISOString());
  assert.equal(r.released, 0, 'nothing is released the same minute');
  assert.equal(creditOf(raw, id).state, 'pending');
  // Three days after THAT delivery it releases.
  const later = await releaseDueStoreCredits(env(asD1(raw)), new Date(Date.now() + (STORE_RELEASE_DAYS * DAY) + 60_000).toISOString());
  assert.equal(later.released, 1);
  await Promise.allSettled(pending.splice(0));
});

test('F5: every door into delivered restarts a STORE order’s clock — and a platform order keeps its first date (warranty, returns)', async () => {
  const raw = freshDb();
  seed(raw);
  // The admin's own PATCH into delivered.
  const viaAdmin = await placeOrder(raw, 'k-admin-deliv-1');
  await deliver(raw, viaAdmin);
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(ago(9), viaAdmin);
  assert.equal((await patch(adminApp(asD1(raw)), `/api/admin/orders/${viaAdmin}`, { status: 'shipped' })).status, 200);
  assert.equal((await patch(adminApp(asD1(raw)), `/api/admin/orders/${viaAdmin}`, { status: 'delivered' })).status, 200);
  assert.ok(Date.now() - Date.parse(row<{ d: string }>(raw, 'SELECT delivered_at d FROM orders WHERE id = ?', viaAdmin)!.d) < 60_000);
  // The PATCH flip itself, where the stage sync behind it has nothing to move
  // (a stage left at `delivered` while the status was walked back): the
  // flip's own stamp is the only one.
  const leftBehind = await placeOrder(raw, 'k-admin-deliv-2');
  await deliver(raw, leftBehind);
  raw.prepare("UPDATE orders SET delivered_at = ?, status = 'shipped' WHERE id = ?").run(ago(9), leftBehind);
  assert.equal(row<{ stage: string }>(raw, 'SELECT stage FROM orders WHERE id = ?', leftBehind)!.stage, 'delivered');
  assert.equal((await patch(adminApp(asD1(raw)), `/api/admin/orders/${leftBehind}`, { status: 'delivered' })).status, 200);
  assert.ok(Date.now() - Date.parse(row<{ d: string }>(raw, 'SELECT delivered_at d FROM orders WHERE id = ?', leftBehind)!.d) < 60_000);
  // The stage door (and the courier sync / stage sweep behind it).
  const viaStage = await placeOrder(raw, 'k-stage-deliv-1');
  await deliver(raw, viaStage);
  raw.prepare("UPDATE orders SET delivered_at = ?, status = 'shipped', stage = 'shipped' WHERE id = ?").run(ago(9), viaStage);
  const moved = await moveOrderStage(env(asD1(raw)), { orderId: viaStage, to: 'delivered', source: 'manual', changedBy: 'boss' });
  assert.equal(moved.moved, true, JSON.stringify(moved));
  assert.ok(Date.now() - Date.parse(row<{ d: string }>(raw, 'SELECT delivered_at d FROM orders WHERE id = ?', viaStage)!.d) < 60_000);
  // A Levonis order is untouched by this: the first delivery date stands.
  raw.exec(`INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
              subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,seller_type,origin,delivered_at,stage)
            VALUES ('ORD-PLAT1','buyer','shipped','{}','pickup','{}','cod',1000,1400,1000,1000,'levonis','platform','2026-01-02T00:00:00.000Z','shipped')`);
  assert.equal((await patch(adminApp(asD1(raw)), '/api/admin/orders/ORD-PLAT1', { status: 'delivered' })).status, 200);
  assert.equal(row<{ d: string }>(raw, "SELECT delivered_at d FROM orders WHERE id = 'ORD-PLAT1'")!.d, '2026-01-02T00:00:00.000Z');
  await Promise.allSettled(pending.splice(0));
});

// ===================================================================== F6

test('F6 (probe P5 inverted): a same-key retry after a transient failure pays with its OWN reservation on a wallet holding exactly the order', async () => {
  const raw = freshDb();
  seed(raw, 1072); // 15,000 IQD at 1,400 → 1071 cents; the wallet holds just that
  const { failing, db } = failingD1(raw);
  const app = buyerApp(db);
  await addToCart(raw);
  const q = await json(await post(app, '/api/store-orders/quote', {}));
  assert.equal(q.quote.wallet_covers, true);
  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO orders/i.test(s.sql));
  const first = await post(app, '/api/store-orders', { idempotencyKey: 'k-tight-0001', addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint });
  assert.equal(first.status, 500, 'a transient D1 failure');
  failing.failWhen = null;
  // The page re-quotes with its attempt key: the reservation is its own money.
  const withKey = await json(await post(app, '/api/store-orders/quote', { idempotencyKey: 'k-tight-0001' }));
  assert.equal(withKey.quote.wallet_covers, true, 'the button is not disabled by the attempt’s own hold');
  const withoutKey = await json(await post(app, '/api/store-orders/quote', {}));
  assert.equal(withoutKey.quote.wallet_covers, false, 'another attempt could not use that money');
  const retry = await post(app, '/api/store-orders', { idempotencyKey: 'k-tight-0001', addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint });
  assert.equal(retry.status, 201, JSON.stringify(await json(retry.clone())));
  assert.equal(holds(raw, 'buyer').length, 1, 'the same reservation, reused');
  assert.equal(holds(raw, 'buyer')[0].state, 'committed');
  assert.equal(ledger(raw, 'buyer').filter((t) => t.type === 'withdrawal').length, 1, 'one debit');
  assert.equal(spendable(raw, 'buyer'), 1072 - 1071);
  await Promise.allSettled(pending.splice(0));
});

// ===================================================================== F7

test('F7 (probe P7 inverted): two checkout tabs with two keys on ONE cart — one order, one debit, the other tab told CART_CHANGED and its hold handed back', async () => {
  const raw = freshDb();
  seed(raw);
  await addToCart(raw);
  const q = await json(await post(buyerApp(asD1(raw)), '/api/store-orders/quote', {}));
  const db = serialD1(raw);
  const results = await Promise.all([
    post(buyerApp(db), '/api/store-orders', { idempotencyKey: 'tab-one-000001', addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint }),
    post(buyerApp(db), '/api/store-orders', { idempotencyKey: 'tab-two-000002', addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint }),
  ]);
  await Promise.allSettled(pending.splice(0));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = results.find((r) => r.status === 409)!;
  assert.equal((await json(loser)).code, 'CART_CHANGED');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 1, 'one order');
  const debits = ledger(raw, 'buyer').filter((t) => t.type === 'withdrawal');
  assert.equal(debits.length, 1, 'one debit');
  assert.deepEqual(holds(raw, 'buyer').map((h) => h.state).sort(), ['committed', 'released'], 'the losing tab’s reservation is handed back');
  assert.equal(spendable(raw, 'buyer'), 100_000 - debits[0].amount);
});

// ===================================================================== S6

test('S6 (security probe P8 inverted): an assistant-scope admin cannot refund or claw back through the admin order doors — a financial admin can', async () => {
  const raw = freshDb();
  seed(raw);
  const id = await placeOrder(raw, 'k-scope-000001');
  await deliver(raw, id);
  assert.equal((await post(buyerApp(asD1(raw)), `/api/orders/${id}/confirm-receipt`, {})).status, 200);
  const owed = (await merchantBalance(asD1(raw), 'm_ali')).available_iqd;
  assert.ok(owed > 0);
  const buyerBefore = spendable(raw, 'buyer');

  const aide = adminApp(asD1(raw), AIDE);
  // A status correction moves no money: still the assistant desk's.
  assert.equal((await patch(aide, `/api/admin/orders/${id}`, { status: 'shipped' })).status, 200);
  // The cancel refunds a paid order and claws back a released credit.
  for (const [method, path, body] of [
    ['PATCH', `/api/admin/orders/${id}`, { status: 'cancelled' }],
    ['PATCH', `/api/admin/orders/${id}/stage`, { stage: 'cancelled' }],
  ] as const) {
    const res = await (method === 'PATCH' ? patch(aide, path, body) : post(aide, path, body));
    assert.equal(res.status, 403, path);
    assert.equal((await json(res)).code, 'FINANCIAL_SCOPE_REQUIRED');
  }
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM orders WHERE id = ?', id)!.status, 'shipped');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_payout_ledger WHERE order_id = ? AND kind = 'reversal'", id), 0, 'no claw-back');
  assert.equal(spendable(raw, 'buyer'), buyerBefore, 'no refund');
  assert.equal((await merchantBalance(asD1(raw), 'm_ali')).available_iqd, owed);

  // The owner does it.
  const boss = await patch(adminApp(asD1(raw)), `/api/admin/orders/${id}`, { status: 'cancelled' });
  assert.equal(boss.status, 200, JSON.stringify(await json(boss.clone())));
  assert.equal((await merchantBalance(asD1(raw), 'm_ali')).available_iqd, 0);
  await Promise.allSettled(pending.splice(0));
});
