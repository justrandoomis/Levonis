/**
 * THE JOURNEY, END TO END — stage 10 of docs/COMMUNITY_COMMERCE_CHAT.md.
 *
 * The owner's criterion, verbatim: «لا تعتبر المهمة مكتملة بمجرد ظهور الواجهة.
 * المعيار هو أن الرحلة كاملة تعمل من: محادثة → عرض/منتج → قبول → دفع آمن →
 * طلب → تنفيذ → تسليم → تأكيد/نزاع.»
 *
 * So each test here walks one whole deal through the REAL routes — the same
 * doors the screens call, in the order a person takes them — and checks the
 * money at every step, from both wallets' side: what the customer holds, what
 * the store is owed, and what each of them reads in the conversation.
 *
 *   A  custom work    thread → print request → quote → updated quote → accept
 *                     (escrow) → start → deliver → confirm → the store is paid
 *   B  ready goods    thread → product card + private product → one cart →
 *                     wallet checkout → the store moves it → receipt → paid
 *   C  a dispute      … → deliver → dispute (money frozen) → Levonis refunds
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, patch, json, count, row, type StubUser, type Mount } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { chatCommerceRoutes } from '../worker/routes/chatCommerce';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { merchantRoutes } from '../worker/routes/merchant';
import { orderRoutes } from '../worker/routes/orders';
import { walletRoutes } from '../worker/routes/wallet';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { merchantBuckets, orderCredit } from '../worker/lib/merchantLedger';
import { resetPrivateProductsMemo } from '../worker/lib/privateProducts';

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

const mount: Mount = (a) => {
  a.route('/api/chats', chatRoutes);
  a.route('/api/chats', chatCommerceRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/store-orders', storeOrderRoutes);
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/wallet', walletRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};

function seed() {
  resetPrivateProductsMemo();
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('buyer','Sara','buyer@x.co','h','customer','sara'), ('ali','Ali','ali@x.co','h','merchant','ali'),
      ('boss','Boss','boss@x.co','h','admin','boss');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,created_at) VALUES
      ('cp_vase','m_ali','s_ali','vase','Vase','active','active',25000,5,1,'2026-09-01T00:00:00.000Z');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('wt_buyer','buyer','deposit','USD',${Math.ceil((500_000 * 100) / RATE)},'approved','test funding');
  `);
  return raw;
}

const as = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, mount);
type Msg = { id: string; system?: boolean; sender_id: string; card?: { type: string; ref: string; original: Record<string, unknown>; current: { status: string; actions: string[] } } | null };
const thread = async (raw: DatabaseSync, viewer: StubUser, chatId: string) =>
  (await json(await get(as(raw, viewer), `/api/chats/${chatId}/messages?limit=200`))).messages as Msg[];
const newest = async (raw: DatabaseSync, viewer: StubUser, chatId: string, type: string) =>
  (await thread(raw, viewer, chatId)).filter((m) => m.card?.type === type).pop()!;
const events = async (raw: DatabaseSync, chatId: string) =>
  (await thread(raw, ALI, chatId)).filter((m) => m.system).map((m) => `${m.card!.type}:${String(m.card!.original.event)}`);

/** The customer's wallet as the wallet page reads it. */
async function wallet(raw: DatabaseSync) {
  const w = await json(await get(as(raw, BUYER), '/api/wallet'));
  return { spendable: Number(w.balance_usd_cents), held: Number(w.balances.usd_cents_held), settled: Number(w.balances.usd_cents_settled) };
}
const cents = (iqd: number) => (iqd * 100) / RATE;
const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} cents, expected ≈ ${expected.toFixed(2)}`);

// ================================================================ A

test('JOURNEY A — custom work: conversation → print request → quote → accept (held) → work → delivery → confirm → the store is paid', async () => {
  const raw = seed();
  const start = await wallet(raw);

  // 1. The customer writes to the store.
  const chatId = (await json(await post(as(raw, BUYER), '/api/chats/open', { merchantId: 'm_ali' }))).chatId as string;
  assert.equal((await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'Can you print a phone stand?' })).status, 200);

  // 2. …and sends the job to this store alone.
  const draft = await json(await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests`, {
    title: 'Phone stand', description: 'A stand for my phone, matte black please', quantity: 1, budget_iqd: 45000,
  }));
  assert.equal((await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests/${draft.request.id}/send`, {})).status, 201);
  const requestCard = await newest(raw, ALI, chatId, 'print_request');
  assert.deepEqual(requestCard.card!.current.actions, ['quote'], 'the store is asked for a quote');

  // 3. The store quotes 40,000, then lowers it to 38,000 — a new revision.
  const q = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { request_id: draft.request.id, price_iqd: 40000, completion_days: 3 }));
  assert.equal((await patch(as(raw, ALI), `/api/chats/${chatId}/quotes/${q.offer.id}`, { price_iqd: 38000 })).status, 200);
  const quotes = (await thread(raw, BUYER, chatId)).filter((m) => m.card?.type === 'quote');
  assert.deepEqual(quotes.map((m) => [m.card!.original.price_iqd, m.card!.current.status]), [[40000, 'changed'], [38000, 'pending']]);
  assert.deepEqual(quotes[1].card!.current.actions, ['accept', 'decline']);

  // 4. The older card cannot be accepted at its old price — the customer sees the new one.
  const stale = await post(as(raw, BUYER), `/api/marketplace/offers/${q.offer.id}/accept`, { expected_price_iqd: 40000, offer_revision: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'OFFER_CHANGED');
  near((await wallet(raw)).held, 0, 'nothing held for a refused acceptance');

  // 5. Accept at what the card shows: the money is HELD, not paid.
  const acc = await post(as(raw, BUYER), `/api/marketplace/offers/${q.offer.id}/accept`, { expected_price_iqd: 38000, offer_revision: 2 });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const orderId = (await json(acc)).order.id as string;
  const esc = row<{ state: string; gross_iqd: number; merchant_receivable_iqd: number }>(
    raw, 'SELECT state, gross_iqd, merchant_receivable_iqd FROM community_escrows WHERE community_order_id = ?', orderId
  )!;
  assert.deepEqual([esc.state, esc.gross_iqd], ['held', 38000]);
  const held = await wallet(raw);
  near(held.held, cents(38000), 'held in escrow');
  near(held.spendable, start.spendable - cents(38000), 'not spendable while held');
  assert.equal(held.settled, start.settled, 'nothing has left the wallet yet');
  assert.equal((await merchantBuckets(asD1(raw), 'm_ali')).available, 0, 'the store is not paid on acceptance');

  // 6–7. The store works and delivers, from the order's own doors.
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/start`)).status, 200);
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/delivered`)).status, 200);
  const deliveredCard = await newest(raw, BUYER, chatId, 'custom_order');
  assert.deepEqual(deliveredCard.card!.current.actions, ['confirm', 'view'], 'the customer is asked to confirm, in the thread');

  // 8. The customer confirms: the escrow releases, the store is paid its share.
  assert.equal((await post(as(raw, BUYER), `/api/marketplace/orders/${orderId}/confirm`)).status, 200);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE community_order_id = ?', orderId)!.state, 'released');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)!.state, 'completed');
  const end = await wallet(raw);
  near(end.held, 0, 'the hold is gone');
  near(end.settled, start.settled - cents(38000), 'the customer paid the accepted price, once');
  assert.equal((await merchantBuckets(asD1(raw), 'm_ali')).available, esc.merchant_receivable_iqd, 'the store received its share');

  // The conversation tells the whole story, once each.
  assert.deepEqual(await events(raw, chatId), [
    'custom_order:funded', 'custom_order:started', 'custom_order:delivered', 'custom_order:completed',
  ]);
});

// ================================================================ B

test('JOURNEY B — ready goods: product card + private product → one cart → wallet checkout → the store ships → receipt → the store is paid', async () => {
  const raw = seed();
  const start = await wallet(raw);
  const chatId = (await json(await post(as(raw, BUYER), '/api/chats/open', { merchantId: 'm_ali' }))).chatId as string;

  // The store shows a ready product, and makes one for this customer.
  assert.equal((await post(as(raw, ALI), `/api/chats/${chatId}/messages`, { card: { type: 'product', ref: 'cp_vase' } })).status, 200);
  const made = await json(await post(as(raw, ALI), `/api/chats/${chatId}/custom-products`, { name: 'Engraved lamp', price_iqd: 60000, prep_days: 2 }));
  const privateId = made.product.id as string;
  const productCard = await newest(raw, BUYER, chatId, 'product');
  assert.deepEqual(productCard.card!.current.actions, ['add_to_cart', 'view']);
  assert.deepEqual((await newest(raw, BUYER, chatId, 'custom_product')).card!.current.actions, ['add_to_cart']);

  // Both go into ONE cart (one store), each re-priced by the server.
  for (const productId of ['cp_vase', privateId]) {
    const add = await post(as(raw, BUYER), '/api/cart/merchant-items', { productId, qty: 1, origin_chat_id: chatId });
    assert.ok([200, 201].includes(add.status), JSON.stringify(await json(add.clone())));
  }
  const quote = await json(await post(as(raw, BUYER), '/api/store-orders/quote', { addressId: 'a1' }));
  const placed = await post(as(raw, BUYER), '/api/store-orders', {
    idempotencyKey: 'journey-b-0001', addressId: 'a1', quoteFingerprint: quote.quote?.quote_fingerprint,
  });
  assert.equal(placed.status, 201, JSON.stringify(await json(placed.clone())));
  const orderId = (await json(placed)).order.id as string;
  const order = row<{ total_iqd: number; origin_chat_id: string; status: string }>(raw, 'SELECT total_iqd, origin_chat_id, status FROM orders WHERE id = ?', orderId)!;
  assert.equal(order.origin_chat_id, chatId);
  assert.equal(order.total_iqd, Number(quote.quote.total_iqd));
  assert.ok(order.total_iqd >= 85000, 'both lines at the database price');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', orderId), 2);

  // Paid from the wallet at checkout; the store's share waits for receipt.
  near((await wallet(raw)).settled, start.settled - cents(order.total_iqd), 'the wallet paid the order total');
  const pending = await orderCredit(asD1(raw), orderId);
  assert.ok(pending.pending_iqd > 0 && pending.available_iqd === 0, JSON.stringify(pending));

  // The private product is sold: nobody can buy it again, and its card says so.
  assert.equal((await newest(raw, BUYER, chatId, 'custom_product')).card!.current.status, 'purchased');
  const again = await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: privateId, qty: 1 });
  assert.ok(again.status >= 400, 'a sold private product is not buyable twice');

  // The store moves it; the customer confirms receipt from the conversation.
  for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
    assert.equal((await post(as(raw, ALI), `/api/merchant/orders/${orderId}/status`, { status })).status, 200, status);
  }
  assert.deepEqual((await newest(raw, BUYER, chatId, 'order')).card!.current.actions, ['confirm_receipt', 'view']);
  assert.equal((await post(as(raw, BUYER), `/api/orders/${orderId}/confirm-receipt`)).status, 200);
  const paid = await orderCredit(asD1(raw), orderId);
  assert.ok(paid.available_iqd > 0 && paid.pending_iqd === 0, `the store's share is available after receipt: ${JSON.stringify(paid)}`);

  assert.deepEqual(await events(raw, chatId), [
    'order:placed', 'order:confirmed', 'order:processing', 'order:shipped', 'order:delivered', 'order:received',
  ]);
});

// ================================================================ C

test('JOURNEY C — a dispute: delivered → disputed (money frozen, nobody paid) → Levonis refunds → the customer has it back', async () => {
  const raw = seed();
  const start = await wallet(raw);
  const chatId = (await json(await post(as(raw, BUYER), '/api/chats/open', { merchantId: 'm_ali' }))).chatId as string;
  const draft = await json(await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests`, {
    title: 'Phone stand', description: 'A stand for my phone, matte black please', quantity: 1,
  }));
  await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests/${draft.request.id}/send`, {});
  const q = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { request_id: draft.request.id, price_iqd: 40000, completion_days: 2 }));
  const orderId = (await json(await post(as(raw, BUYER), `/api/marketplace/offers/${q.offer.id}/accept`, { expected_price_iqd: 40000, offer_revision: 1 }))).order.id as string;
  await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/start`);
  await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/delivered`);

  // The stand arrived broken: the customer disputes instead of confirming.
  const d = await post(as(raw, BUYER), `/api/marketplace/orders/${orderId}/dispute`, { description: 'The stand arrived broken in two pieces' });
  assert.ok([200, 201].includes(d.status), JSON.stringify(await json(d.clone())));
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE community_order_id = ?', orderId)!.state, 'disputed');
  near((await wallet(raw)).held, cents(40000), 'the money stays held while Levonis decides');
  assert.equal((await merchantBuckets(asD1(raw), 'm_ali')).available, 0, 'the store is not paid during a dispute');
  // The customer can no longer «confirm» a disputed order from the thread.
  assert.deepEqual((await newest(raw, BUYER, chatId, 'custom_order')).card!.current.actions, ['view']);

  // Levonis decides: refund.
  const escrowId = row<{ id: string }>(raw, 'SELECT id FROM community_escrows WHERE community_order_id = ?', orderId)!.id;
  const r = await post(as(raw, BOSS), `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'refund', reason: 'broken on arrival' });
  assert.equal(r.status, 200, JSON.stringify(await json(r.clone())));
  const end = await wallet(raw);
  near(end.held, 0, 'nothing held');
  near(end.spendable, start.spendable, 'the customer has every dinar back');
  assert.equal((await merchantBuckets(asD1(raw), 'm_ali')).available, 0);
  assert.deepEqual(await events(raw, chatId), [
    'custom_order:funded', 'custom_order:started', 'custom_order:delivered', 'custom_order:disputed', 'custom_order:refunded',
  ]);
});
