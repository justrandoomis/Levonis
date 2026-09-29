/**
 * THE CONVERSATION IS THE CENTRE — stage 6 of docs/COMMUNITY_COMMERCE_CHAT.md.
 *
 * Every money move of a deal that started in a store's conversation is
 * recorded THERE, once, by the server, after the move committed (D8):
 *
 *   custom work   funded → started → delivered → completed | disputed →
 *                 refunded/completed by Levonis | cancelled
 *   store order   placed → confirmed → processing → shipped → delivered →
 *                 received | cancelled
 *
 * And the fixes that came with it: «تم التسليم» that matched nothing no
 * longer answers 200; a thread a customer names for a cart line is recorded
 * only when it is their own thread with that store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, count, row, type StubUser, type Mount } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { chatCommerceRoutes } from '../worker/routes/chatCommerce';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { merchantRoutes } from '../worker/routes/merchant';
import { orderRoutes } from '../worker/routes/orders';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { emptyCommunitySweepReport, sweepCommunityAutoComplete } from '../worker/lib/communityRequests';
import { resetPrivateProductsMemo } from '../worker/lib/privateProducts';
import type { Env } from '../worker/lib/types';

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

const mount: Mount = (a) => {
  a.route('/api/chats', chatRoutes);
  a.route('/api/chats', chatCommerceRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/store-orders', storeOrderRoutes);
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};

function seed() {
  resetPrivateProductsMemo();
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('buyer','Sara','buyer@x.co','h','customer','sara'), ('ali','Ali','ali@x.co','h','merchant','ali'),
      ('eve','Eve','eve@x.co','h','customer','eve'), ('boss','Boss','boss@x.co','h','admin','boss');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,images) VALUES
      ('cp_vase','m_ali','s_ali','vase','Vase','active','active',25000,5,1,'["/files/merchants/ali/public/vase01.webp"]');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES
      ('a1','buyer','Sara','+964770','Street 1','basra'), ('a_eve','eve','Eve','+964772','Street 3','basra');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  for (const u of ['buyer', 'eve']) {
    raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
              VALUES ('wt_${u}','${u}','deposit','USD',${Math.ceil((500_000 * 100) / RATE)},'approved','test funding')`);
  }
  return raw;
}
const as = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, mount);
const openThread = async (raw: DatabaseSync, who: StubUser = BUYER) =>
  (await json(await post(as(raw, who), '/api/chats/open', { merchantId: 'm_ali' }))).chatId as string;
const systemEvents = async (raw: DatabaseSync, chatId: string, viewer: StubUser = ALI) =>
  ((await json(await get(as(raw, viewer), `/api/chats/${chatId}/messages?limit=200`))).messages as Array<Record<string, any>>)
    .filter((m) => m.system)
    .map((m) => `${m.card.type}:${m.card.original.event}`);

/** A funded custom order made in the thread: request → quote → accept. */
async function fundedOrder(raw: DatabaseSync, chatId: string) {
  const draft = await json(await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests`, {
    title: 'Phone stand', description: 'A stand for my phone, matte black please', quantity: 1,
  }));
  await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests/${draft.request.id}/send`, {});
  const q = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { request_id: draft.request.id, price_iqd: 40000, completion_days: 2 }));
  const acc = await post(as(raw, BUYER), `/api/marketplace/offers/${q.offer.id}/accept`, { expected_price_iqd: 40000, offer_revision: 1 });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  return (await json(acc)).order.id as string;
}

// ================================================================ custom work

test('custom work, told in its conversation: funded → started → delivered → completed, each once', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const orderId = await fundedOrder(raw, chatId);
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/start`)).status, 200);
  // A later second tap is refused by the order's own state table — and posts nothing twice.
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/start`)).status, 409);
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/delivered`)).status, 200);

  // The customer sees «confirm» on the card; the store does not.
  const msgs = (await json(await get(as(raw, BUYER), `/api/chats/${chatId}/messages?limit=200`))).messages as Array<Record<string, any>>;
  const latest = msgs.filter((m) => m.system).pop()!;
  assert.equal(latest.card.current.status, 'merchant_marked_delivered');
  assert.deepEqual(latest.card.current.actions, ['confirm', 'view']);

  assert.equal((await post(as(raw, BUYER), `/api/marketplace/orders/${orderId}/confirm`)).status, 200);
  assert.deepEqual(await systemEvents(raw, chatId), [
    'custom_order:funded', 'custom_order:started', 'custom_order:delivered', 'custom_order:completed',
  ]);
  // The store's moves are news to the customer; the customer's to the store.
  const senders = (await json(await get(as(raw, BUYER), `/api/chats/${chatId}/messages?limit=200`))).messages
    .filter((m: Record<string, any>) => m.system)
    .map((m: Record<string, any>) => m.sender_id);
  assert.deepEqual(senders, ['buyer', 'ali', 'ali', 'buyer']);
});

test('«تم التسليم» that matched nothing is not a success — a replay is, anything else is ORDER_CHANGED', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const orderId = await fundedOrder(raw, chatId);
  await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/start`);
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/delivered`)).status, 200);
  // A later second tap is refused by the state table (the replay answer is for
  // the tap that raced the first one past that check).
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/delivered`)).status, 409);

  // A dispute lands between the store's read and its write: the write used to
  // match nothing and answer 200 anyway.
  const second = await fundedOrder(raw, chatId);
  await post(as(raw, ALI), `/api/marketplace/orders/${second}/start`);
  const inner = asD1(raw) as unknown as { prepare(sql: string): any; batch(s: unknown[]): Promise<unknown> };
  const racing = {
    prepare(sql: string) {
      const stmt = inner.prepare(sql);
      if (!/SET state = 'merchant_marked_delivered'/.test(sql)) return stmt;
      return {
        bind: (...values: unknown[]) => {
          const bound = stmt.bind(...values);
          return {
            run: async () => {
              raw.exec(`UPDATE community_orders SET state = 'disputed' WHERE id = '${second}'`);
              return bound.run();
            },
            first: () => bound.first(),
            all: () => bound.all(),
          };
        },
      };
    },
    batch: (stmts: unknown[]) => inner.batch(stmts),
  };
  const res = await stubApp(racing, ALI, mount).request(`/api/marketplace/orders/${second}/delivered`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: '{}',
  });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'ORDER_CHANGED');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', second)!.state, 'disputed');
  assert.equal((await systemEvents(raw, chatId)).filter((e) => e === 'custom_order:delivered').length, 1, 'no «delivered» card for a delivery that never happened');
});

test('a dispute and Levonis\'s decision are recorded in the conversation; a cancel before work too', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const orderId = await fundedOrder(raw, chatId);
  await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/start`);
  const d = await post(as(raw, BUYER), `/api/marketplace/orders/${orderId}/dispute`, { description: 'The stand arrived broken in two pieces' });
  assert.equal(d.status, 201, JSON.stringify(await json(d.clone())));
  const escrowId = row<{ id: string }>(raw, 'SELECT id FROM community_escrows WHERE community_order_id = ?', orderId)!.id;
  const r = await post(as(raw, BOSS), `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'refund', reason: 'broken on arrival' });
  assert.equal(r.status, 200, JSON.stringify(await json(r.clone())));
  assert.deepEqual(await systemEvents(raw, chatId), ['custom_order:funded', 'custom_order:started', 'custom_order:disputed', 'custom_order:refunded']);

  const second = await fundedOrder(raw, chatId);
  assert.equal((await post(as(raw, BUYER), `/api/marketplace/orders/${second}/cancel`)).status, 200);
  const events = await systemEvents(raw, chatId);
  assert.deepEqual(events.slice(-2), ['custom_order:funded', 'custom_order:cancelled']);
});

test('the clock completing a job is recorded too — by the store, as news to the customer', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const orderId = await fundedOrder(raw, chatId);
  await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/start`);
  await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/delivered`);
  raw.exec(`UPDATE community_orders SET auto_complete_at = '2020-01-01T00:00:00.000Z' WHERE id = '${orderId}'`);
  const report = emptyCommunitySweepReport();
  await sweepCommunityAutoComplete({ DB: asD1(raw) } as unknown as Env, new Date().toISOString(), 10, report);
  assert.equal(report.auto_completed, 1, JSON.stringify(report));
  const events = await systemEvents(raw, chatId);
  assert.equal(events[events.length - 1], 'custom_order:completed');
});

// ================================================================ store orders

async function placeFromChat(raw: DatabaseSync, chatId: string, key: string, who: StubUser = BUYER, origin: string | null = chatId) {
  const add = await post(as(raw, who), '/api/cart/merchant-items', { productId: 'cp_vase', qty: 1, ...(origin ? { origin_chat_id: origin } : {}) });
  assert.equal(add.status, 201, JSON.stringify(await json(add.clone())));
  const address = who.id === 'eve' ? 'a_eve' : 'a1';
  const q = await json(await post(as(raw, who), '/api/store-orders/quote', { addressId: address }));
  const res = await post(as(raw, who), '/api/store-orders', { idempotencyKey: key, addressId: address, quoteFingerprint: q.quote?.quote_fingerprint });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  return (await json(res)).order.id as string;
}

test('a store order bought from a product card: placed → confirmed → shipped → delivered → received, in the thread', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  await post(as(raw, ALI), `/api/chats/${chatId}/messages`, { card: { type: 'product', ref: 'cp_vase' } });
  const orderId = await placeFromChat(raw, chatId, 'key-card-0001');
  assert.equal(row<{ origin_chat_id: string }>(raw, 'SELECT origin_chat_id FROM orders WHERE id = ?', orderId)!.origin_chat_id, chatId);
  for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
    const res = await post(as(raw, ALI), `/api/merchant/orders/${orderId}/status`, { status });
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(await json(res.clone()))}`);
  }
  const delivered = ((await json(await get(as(raw, BUYER), `/api/chats/${chatId}/messages?limit=200`))).messages as Array<Record<string, any>>)
    .filter((m) => m.system).pop()!;
  assert.deepEqual(delivered.card.current.actions, ['confirm_receipt', 'view'], '«استلمت طلبي» from the conversation');
  assert.equal((await post(as(raw, BUYER), `/api/orders/${orderId}/confirm-receipt`)).status, 200);
  assert.equal((await post(as(raw, BUYER), `/api/orders/${orderId}/confirm-receipt`)).status, 200, 'a replay');
  assert.deepEqual(await systemEvents(raw, chatId), [
    'order:placed', 'order:confirmed', 'order:processing', 'order:shipped', 'order:delivered', 'order:received',
  ]);
});

test('a store order bought outside any conversation posts nothing; a cancellation from the thread is recorded', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  await placeFromChat(raw, chatId, 'key-plain-0001', BUYER, null);
  assert.deepEqual(await systemEvents(raw, chatId), [], 'no thread named, nothing posted');
  const fromChat = await placeFromChat(raw, chatId, 'key-chat-0002');
  assert.equal((await post(as(raw, ALI), `/api/merchant/orders/${fromChat}/status`, { status: 'cancelled', reason: 'out of material' })).status, 200);
  assert.deepEqual(await systemEvents(raw, chatId), ['order:placed', 'order:cancelled']);
});

test('ATTACK: naming ANOTHER customer\'s thread on a cart line records nothing — no card lands in their conversation', async () => {
  const raw = seed();
  const buyerThread = await openThread(raw, BUYER);
  await openThread(raw, EVE);
  const orderId = await placeFromChat(raw, buyerThread, 'key-forged-0001', EVE, buyerThread);
  assert.equal(row<{ origin_chat_id: string | null }>(raw, 'SELECT origin_chat_id FROM orders WHERE id = ?', orderId)!.origin_chat_id, null);
  assert.deepEqual(await systemEvents(raw, buyerThread), []);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages WHERE is_system = 1'), 0);
});
