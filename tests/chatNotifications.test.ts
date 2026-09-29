/**
 * NOTIFICATIONS WITHOUT SPAM — stage 8 of docs/COMMUNITY_COMMERCE_CHAT.md.
 *
 *   · a line in a store's conversation tells the other side once per TURN
 *     (a customer typing four lines is one question waiting);
 *   · a card that WAITS ON the other side — a print request for the store, a
 *     quote or a private product for the customer — is news whoever spoke
 *     last, named for what it asks, once per card (an updated quote is a new
 *     card and a new notice);
 *   · the money events recorded in the thread (D8) bring no chat notice of
 *     their own: each already has its domain notice (funded, started,
 *     delivered…), and the thread's card is the history, not a second ping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, patch, json, type StubUser, type Mount } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { chatCommerceRoutes } from '../worker/routes/chatCommerce';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { resetPrivateProductsMemo } from '../worker/lib/privateProducts';

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };

const mount: Mount = (a) => {
  a.route('/api/chats', chatRoutes);
  a.route('/api/chats', chatCommerceRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

function seed() {
  resetPrivateProductsMemo();
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('buyer','Sara','buyer@x.co','h','customer','sara'), ('ali','Ali','ali@x.co','h','merchant','ali');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,name_ar,status,lifecycle,price_iqd,stock,track_stock,images) VALUES
      ('cp_vase','m_ali','s_ali','vase','Vase','مزهرية','active','active',25000,5,1,'["/files/merchants/ali/public/vase01.webp"]'),
      ('cp_cup','m_ali','s_ali','cup','Cup','كوب','active','active',9000,5,1,'[]');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('wt_buyer','buyer','deposit','USD',${Math.ceil((500_000 * 100) / RATE)},'approved','test funding');
  `);
  return raw;
}

const as = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, mount);
const openThread = async (raw: DatabaseSync) =>
  (await json(await post(as(raw, BUYER), '/api/chats/open', { merchantId: 'm_ali' }))).chatId as string;
const say = (raw: DatabaseSync, who: StubUser, chatId: string, body: string) =>
  post(as(raw, who), `/api/chats/${chatId}/messages`, { body });
const sendCard = (raw: DatabaseSync, who: StubUser, chatId: string, type: string, ref: string) =>
  post(as(raw, who), `/api/chats/${chatId}/messages`, { card: { type, ref } });

/** The chat notices a user holds, oldest first: `title_ar | body_ar`. */
function chatNotices(raw: DatabaseSync, userId: string): Array<{ kind: string; title: string; body: string; en: string }> {
  return (
    raw
      .prepare(
        `SELECT kind, title_ar, body_ar, title_en FROM user_notifications
          WHERE user_id = ? AND kind IN ('chat_message','new_message') ORDER BY created_at, rowid`
      )
      .all(userId) as Array<{ kind: string; title_ar: string; body_ar: string; title_en: string }>
  ).map((n) => ({ kind: n.kind, title: n.title_ar, body: n.body_ar, en: n.title_en }));
}

test('a turn of lines is one notice; a reply and its product cards are one notice too', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  for (const line of ['مرحبا', 'عندكم مزهريات؟', 'باللون الأسود']) assert.equal((await say(raw, BUYER, chatId, line)).status, 200);
  assert.equal(chatNotices(raw, 'ali').length, 1, 'three lines from the customer, one notice to the store');

  assert.equal((await say(raw, ALI, chatId, 'أهلًا، نعم')).status, 200);
  assert.equal((await sendCard(raw, ALI, chatId, 'product', 'cp_vase')).status, 200);
  assert.equal((await sendCard(raw, ALI, chatId, 'product', 'cp_cup')).status, 200);
  const toBuyer = chatNotices(raw, 'buyer');
  assert.equal(toBuyer.length, 1, 'a reply and two product cards are one turn');
  assert.equal(toBuyer[0].title, 'ردّ المتجر على رسالتك');
});

test('a product card that opens the store’s turn is named for what it is', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  await say(raw, BUYER, chatId, 'أريد هدية');
  assert.equal((await sendCard(raw, ALI, chatId, 'product', 'cp_vase')).status, 200);
  const [n] = chatNotices(raw, 'buyer');
  assert.equal(n.title, 'أرسل لك المتجر منتجًا');
  assert.equal(n.body, 'مزهرية', 'the Arabic name for an Arabic reader');
  assert.equal(n.en, 'The store sent you a product');
});

test('a print request reaches the store as a print request, even mid-turn', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  await say(raw, BUYER, chatId, 'عندي طلب طباعة');
  const draft = await json(await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests`, {
    title: 'Phone stand', description: 'A stand for my phone, matte black please', quantity: 1,
  }));
  assert.equal((await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests/${draft.request.id}/send`, {})).status, 201);
  const toStore = chatNotices(raw, 'ali');
  assert.equal(toStore.length, 2, 'the line and the request are two different things to answer');
  assert.equal(toStore[1].kind, 'new_message');
  assert.equal(toStore[1].title, 'طلب طباعة جديد لمتجرك');
  assert.equal(toStore[1].body, 'Phone stand');
  // A replayed send posts no second card and no second notice.
  await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests/${draft.request.id}/send`, {});
  assert.equal(chatNotices(raw, 'ali').length, 2);
});

test('a quote, and each update to it, is one notice to the customer — the money events add none', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const draft = await json(await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests`, {
    title: 'Phone stand', description: 'A stand for my phone, matte black please', quantity: 1,
  }));
  await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests/${draft.request.id}/send`, {});
  await say(raw, ALI, chatId, 'تمام، هذا عرضي');
  const q = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { request_id: draft.request.id, price_iqd: 40000, completion_days: 2 }));
  assert.ok(q.offer?.id, JSON.stringify(q));
  const edited = await patch(as(raw, ALI), `/api/chats/${chatId}/quotes/${q.offer.id}`, { price_iqd: 38000 });
  assert.equal(edited.status, 200, JSON.stringify(await json(edited.clone())));

  const toBuyer = chatNotices(raw, 'buyer');
  assert.deepEqual(toBuyer.map((n) => n.title), ['ردّ المتجر على رسالتك', 'وصلك عرض سعر من المتجر', 'عدّل المتجر عرض السعر']);
  assert.equal(toBuyer[1].body, 'Phone stand — 40,000 د.ع');
  assert.equal(toBuyer[2].body, 'Phone stand — 38,000 د.ع');

  // Accepting funds the order and records it in the thread — and pings nobody
  // through the chat: the store's «offer accepted» notice is the domain's own.
  const msgs = (await json(await get(as(raw, BUYER), `/api/chats/${chatId}/messages?limit=200`))).messages as Array<{ card?: { type: string; ref: string; original: { revision?: number } } }>;
  const latest = msgs.filter((m) => m.card?.type === 'quote').pop()!;
  const acc = await post(as(raw, BUYER), `/api/marketplace/offers/${latest.card!.ref}/accept`, {
    expected_price_iqd: 38000, offer_revision: latest.card!.original.revision,
  });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  assert.equal(chatNotices(raw, 'ali').filter((n) => n.kind === 'new_message').length, 1, 'only the print request itself');
  assert.equal(chatNotices(raw, 'buyer').length, 3);
});

test('a private product is announced to its customer, with its price', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  await say(raw, BUYER, chatId, 'ممكن نسخة خاصة؟');
  const res = await post(as(raw, ALI), `/api/chats/${chatId}/custom-products`, {
    name: 'Engraved vase', name_ar: 'مزهرية محفورة', description: 'With your name', price_iqd: 55000, prep_days: 3, valid_days: 7,
  });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const [n] = chatNotices(raw, 'buyer');
  assert.equal(n.title, 'أعدّ لك المتجر منتجًا خاصًا');
  assert.match(n.body, /55,000 د\.ع$/);
});
