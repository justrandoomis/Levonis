/**
 * CARDS IN THE STORE'S CONVERSATION — stages 2 and 3 of
 * docs/COMMUNITY_COMMERCE_CHAT.md (migration 0150, worker/lib/chatCards.ts).
 *
 * The owner's rules, each pinned as an attack or a behaviour:
 *   · a card carries an ID; the server rebuilds the snapshot from the database
 *     and never takes a price, a name or a picture from the client;
 *   · a product of ANOTHER store, a hidden product, a forged id → refused;
 *   · a merchant cannot send a product they do not own; nobody outside the
 *     thread sends anything; a personal DM carries no cards;
 *   · the snapshot is frozen; the current state (price now, stock, the store
 *     open) is read on every view, for the reader — only the customer is
 *     offered «أضف إلى السلة»;
 *   · a retried send (same client_id) is one message, never two;
 *   · a system card does not swallow the next line's notification;
 *   · the thread is named by the store to its customer.
 *
 * Real routes on every migration; only the session is stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, post, get, json, all, count, row, hasColumn, type StubUser } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { postSystemCard } from '../worker/lib/chatCards';
import type { Env } from '../worker/lib/types';

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const SELLER: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const RIVAL: StubUser = { id: 'zain', role: 'merchant', email: 'zain@x.co' };
const STRANGER: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co' };
const FUTURE = '2099-01-01T00:00:00.000Z';

function seed(raw: DatabaseSync = freshDb()) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('buyer','Sara','buyer@x.co','h','customer','sara'), ('ali','Ali','ali@x.co','h','merchant','ali'),
      ('zain','Zain','zain@x.co','h','merchant','zain'), ('eve','Eve','eve@x.co','h','customer','eve');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_zain','zain','Zain Print','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,logo_key,tagline) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active','merchants/ali/public/logo01.webp','Prints made in Basra'),
      ('s_zain','m_zain','zain','zainprint','Zain Print','active',NULL,'');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,name_ar,status,lifecycle,price_iqd,stock,track_stock,images,created_at) VALUES
      ('cp_vase','m_ali','s_ali','vase','Vase','مزهرية','active','active',25000,5,1,'["/files/merchants/ali/public/vase01.webp"]','2026-09-01T00:00:00.000Z'),
      ('cp_hook','m_ali','s_ali','hook','Hook','خطاف','active','active',3000,0,1,'[]','2026-09-02T00:00:00.000Z'),
      ('cp_hidden','m_ali','s_ali','secret','Secret','سري','hidden','hidden',9000,5,1,'[]','2026-09-03T00:00:00.000Z'),
      ('cp_zain','m_zain','s_zain','zain-vase','Zain vase','مزهرية زين','active','active',20000,5,1,'[]','2026-09-04T00:00:00.000Z');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem_zain','zain','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
  `);
  return raw;
}
const as = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/chats', chatRoutes));

/** The customer's thread with Ali's store — opened the way the storefront opens it. */
async function storeThread(raw: DatabaseSync): Promise<string> {
  const res = await json(await post(as(raw, BUYER), '/api/chats/open', { merchantId: 'm_ali' }));
  assert.equal(res.context, 'store', JSON.stringify(res));
  return res.chatId;
}
const sendCard = (raw: DatabaseSync, user: StubUser, chatId: string, card: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  post(as(raw, user), `/api/chats/${chatId}/messages`, { card, ...extra });
const thread = async (raw: DatabaseSync, user: StubUser, chatId: string) =>
  (await json(await get(as(raw, user), `/api/chats/${chatId}/messages`))).messages as Array<Record<string, any>>;

// ================================================================= sending

test('a product card is built by the SERVER from the database — the client sends an id and nothing else', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const res = await sendCard(raw, BUYER, chatId, { type: 'product', ref: 'cp_vase', price_iqd: 1, name: 'FREE', image: 'https://evil.example/x.png' }, {
    body: 'ignored', price_iqd: 1,
  });
  assert.equal(res.status, 200);
  const { message } = await json(res);
  assert.equal(message.kind, 'product_card');
  assert.equal(message.card.type, 'product');
  assert.equal(message.card.ref, 'cp_vase');
  assert.deepEqual(
    {
      name: message.card.original.name,
      name_ar: message.card.original.name_ar,
      price: message.card.original.price_iqd,
      image: message.card.original.image,
      url: message.card.original.url,
      store: message.card.original.store,
    },
    {
      name: 'Vase',
      name_ar: 'مزهرية',
      price: 25000,
      image: '/files/merchants/ali/public/vase01.webp',
      url: '/community/store/ali3d/p/vase',
      store: { id: 's_ali', slug: 'ali3d', name: 'Ali 3D Store' },
    }
  );
  // The stored row carries the id and the server's snapshot — nothing the client typed.
  const stored = row<Record<string, unknown>>(raw, "SELECT kind, body, card_type, card_ref, card_snapshot, is_system FROM chat_messages WHERE card_type = 'product'")!;
  assert.equal(stored.kind, 'text', 'kind stays inside 0001\'s CHECK');
  assert.equal(stored.body, '🛍️ Vase', 'the plain fallback is the product\'s own name');
  assert.equal(stored.card_ref, 'cp_vase');
  assert.equal(stored.is_system, 0);
  assert.doesNotMatch(String(stored.card_snapshot), /FREE|evil\.example|"price_iqd":1[,}]/);
});

test('the store may send its own product card, and the customer is the only one offered «add to cart»', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  assert.equal((await sendCard(raw, SELLER, chatId, { type: 'product', ref: 'cp_vase' })).status, 200);
  const forCustomer = (await thread(raw, BUYER, chatId))[0];
  const forSeller = (await thread(raw, SELLER, chatId))[0];
  assert.equal(forCustomer.card.current.status, 'available');
  assert.deepEqual(forCustomer.card.current.actions, ['add_to_cart', 'view']);
  assert.deepEqual(forSeller.card.current.actions, ['view'], 'a store never buys from itself');
  assert.equal(forSeller.mine, true);
});

test('ATTACK: a product of ANOTHER store, a hidden product, a forged id — each refused, nothing written', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  for (const [who, ref, status, code] of [
    [SELLER, 'cp_zain', 404, 'CARD_NOT_IN_THREAD'], // a merchant sending a product they do not own
    [BUYER, 'cp_zain', 404, 'CARD_NOT_IN_THREAD'], // a customer smuggling a competitor into the thread
    [SELLER, 'cp_hidden', 409, 'PRODUCT_NOT_PUBLISHED'],
    [BUYER, 'cp_nope', 404, 'CARD_NOT_IN_THREAD'],
  ] as const) {
    const res = await sendCard(raw, who, chatId, { type: 'product', ref });
    const body = await json(res);
    assert.equal(res.status, status, `${who.id} → ${ref}: ${JSON.stringify(body)}`);
    assert.equal(body.code, code);
  }
  // A store card names THIS thread's store and no other.
  const rival = await sendCard(raw, BUYER, chatId, { type: 'store', ref: 's_zain' });
  assert.equal(rival.status, 404);
  assert.equal((await json(rival)).code, 'CARD_NOT_IN_THREAD');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages'), 0);
});

test('ATTACK: a card type born with its entity cannot be sent by id, and an unknown type is refused', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  for (const type of ['quote', 'custom_product', 'print_request', 'bogus', '']) {
    const res = await sendCard(raw, SELLER, chatId, { type, ref: 'x1' });
    assert.equal(res.status, 400, type);
    assert.equal((await json(res)).code, 'CARD_TYPE_UNSUPPORTED', type);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages'), 0);
});

test('ATTACK: nobody outside the thread sends a card; a personal conversation carries none', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const outsider = await sendCard(raw, RIVAL, chatId, { type: 'product', ref: 'cp_vase' });
  assert.equal(outsider.status, 403);
  assert.equal((await sendCard(raw, STRANGER, chatId, { type: 'store', ref: 's_ali' })).status, 403);

  const { chatId: dm } = await json(await post(as(raw, BUYER), '/api/chats/open', { userId: 'eve' }));
  const inDm = await sendCard(raw, BUYER, dm, { type: 'product', ref: 'cp_vase' });
  assert.equal(inDm.status, 400);
  assert.equal((await json(inDm)).code, 'CARD_NOT_ALLOWED_HERE');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages'), 0);
});

// ================================================================= frozen vs current

test('the snapshot is frozen; the price NOW, the stock and the store being open are read on every view', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  await sendCard(raw, SELLER, chatId, { type: 'product', ref: 'cp_vase' });
  await sendCard(raw, SELLER, chatId, { type: 'product', ref: 'cp_hook' });

  const first = await thread(raw, BUYER, chatId);
  const hook = first[1];
  let vase = first[0];
  assert.equal(hook.card.current.status, 'out_of_stock');
  assert.deepEqual(hook.card.current.actions, ['view']);

  raw.exec("UPDATE community_products SET price_iqd = 27000 WHERE id = 'cp_vase'");
  [vase] = await thread(raw, BUYER, chatId);
  assert.equal(vase.card.original.price_iqd, 25000, 'what the card said when it was sent');
  assert.equal(vase.card.current.price_iqd, 27000, 'what it costs now');
  assert.equal(vase.card.current.price_changed, true);

  raw.exec("UPDATE merchant_stores SET status = 'paused' WHERE id = 's_ali'");
  [vase] = await thread(raw, BUYER, chatId);
  assert.equal(vase.card.current.status, 'store_closed');
  assert.deepEqual(vase.card.current.actions, ['view']);

  raw.exec("UPDATE merchant_stores SET status = 'active' WHERE id = 's_ali'; UPDATE community_products SET publish_state = 'hidden' WHERE id = 'cp_vase'");
  [vase] = await thread(raw, BUYER, chatId);
  assert.equal(vase.card.current.status, 'unavailable', 'a product unpublished after the card is not buyable from it');
  assert.deepEqual(vase.card.current.actions, []);
  assert.equal(vase.card.original.name, 'Vase', 'the conversation still shows what was sent');
});

test('a store card shows the store; a suspended store reads «unavailable» with nothing to open', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { message } = await json(await sendCard(raw, SELLER, chatId, { type: 'store', ref: 's_ali' }));
  assert.equal(message.kind, 'store_card');
  assert.deepEqual(
    { name: message.card.original.name, logo: message.card.original.logo, url: message.card.original.url, tagline: message.card.original.tagline },
    { name: 'Ali 3D Store', logo: '/files/merchants/ali/public/logo01.webp', url: '/community/store/ali3d', tagline: 'Prints made in Basra' }
  );
  assert.equal(message.card.current.status, 'open');
  raw.exec("UPDATE merchant_stores SET status = 'suspended' WHERE id = 's_ali'");
  const [card] = await thread(raw, BUYER, chatId);
  assert.equal(card.card.current.status, 'closed');
  assert.deepEqual(card.card.current.actions, []);
});

// ================================================================= idempotent sends

test('a retried send with the same client_id is ONE message — for a card and for a line of text', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const first = await json(await sendCard(raw, BUYER, chatId, { type: 'product', ref: 'cp_vase' }, { client_id: 'tap-000000001' }));
  const again = await json(await sendCard(raw, BUYER, chatId, { type: 'product', ref: 'cp_vase' }, { client_id: 'tap-000000001' }));
  assert.equal(again.replayed, true);
  assert.equal(again.id, first.id);
  assert.equal(again.message.card.ref, 'cp_vase');

  const t1 = await json(await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'Is it in stock?', client_id: 'tap-000000002' }));
  const t2 = await json(await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'Is it in stock?', client_id: 'tap-000000002' }));
  assert.equal(t2.id, t1.id);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages'), 2);

  // The id is the SENDER's: the seller reusing the customer's client_id is a new message.
  const other = await json(await post(as(raw, SELLER), `/api/chats/${chatId}/messages`, { body: 'Yes', client_id: 'tap-000000002' }));
  assert.notEqual(other.id, t1.id);
  // And a malformed one is refused rather than silently ignored.
  const bad = await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'x', client_id: 'no spaces!' });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'CLIENT_ID_INVALID');
});

// ================================================================= system cards

test('a system card is posted once per event, only into a thread of that store and customer', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const env = { DB: asD1(raw) } as unknown as Env;
  const card = { type: 'store' as const, ref: 's_ali', snapshot: { v: 1, name: 'Ali 3D Store' }, body: '🏪 Ali 3D Store' };
  const expect = { storeId: 's_ali', customerId: 'buyer' };
  assert.equal(await postSystemCard(env, { chatId, actorId: 'buyer', card, eventKey: 'order:o1:placed', expect }), true);
  assert.equal(await postSystemCard(env, { chatId, actorId: 'buyer', card, eventKey: 'order:o1:placed', expect }), false, 'the same event twice');
  assert.equal(
    await postSystemCard(env, { chatId, actorId: 'buyer', card, eventKey: 'order:o2:placed', expect: { storeId: 's_zain', customerId: 'buyer' } }),
    false,
    'another store\'s event never lands in this thread'
  );
  assert.equal(
    await postSystemCard(env, { chatId, actorId: 'buyer', card, eventKey: 'order:o3:placed', expect: { storeId: 's_ali', customerId: 'eve' } }),
    false,
    'another customer\'s event never lands in this thread'
  );
  assert.equal(await postSystemCard(env, { chatId: null, actorId: 'buyer', card, eventKey: 'x', expect }), false);
  const msgs = await thread(raw, SELLER, chatId);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].system, true);
});

test('a system card by the customer does not swallow their next line\'s notification (the turn rule)', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const env = { DB: asD1(raw) } as unknown as Env;
  await post(as(raw, SELLER), `/api/chats/${chatId}/messages`, { body: 'Welcome!' });
  await postSystemCard(env, {
    chatId, actorId: 'buyer', eventKey: 'order:o1:placed', expect: { storeId: 's_ali', customerId: 'buyer' },
    card: { type: 'store', ref: 's_ali', snapshot: {}, body: '🧾' },
  });
  const before = count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'ali'");
  await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'Please hurry' });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'ali'"), before + 1, 'the seller is told');
});

// ================================================================= identity, picker, list

test('the thread is named by the store to its customer, and by the customer to the store', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const mine = await json(await get(as(raw, BUYER), `/api/chats/${chatId}`));
  assert.equal(mine.chat.role, 'customer');
  assert.equal(mine.chat.context.type, 'store');
  assert.deepEqual(
    { name: mine.chat.store.name, logo: mine.chat.store.logoUrl, url: mine.chat.store.url, open: mine.chat.store.open },
    { name: 'Ali 3D Store', logo: '/files/merchants/ali/public/logo01.webp', url: '/community/store/ali3d', open: true }
  );
  assert.equal(mine.chat.other, null, 'the customer is shown the store, not the owner');
  assert.deepEqual(mine.chat.can, { product_card: true, store_card: true, print_request: false, quote: false, custom_product: false },
    'custom work follows Levo Community\'s switch — closed on a fresh database');
  raw.exec(`INSERT INTO admin_settings (key, value) VALUES ('communityGate', '{"open":true}')`);
  assert.equal((await json(await get(as(raw, BUYER), `/api/chats/${chatId}`))).chat.can.print_request, true);
  assert.equal((await json(await get(as(raw, SELLER), `/api/chats/${chatId}`))).chat.can.quote, true);
  assert.equal((await json(await get(as(raw, SELLER), `/api/chats/${chatId}`))).chat.can.print_request, false, 'the store does not send print requests');
  assert.doesNotMatch(JSON.stringify(mine), /ali@x\.co|password|phone/);

  const theirs = await json(await get(as(raw, SELLER), `/api/chats/${chatId}`));
  assert.equal(theirs.chat.role, 'merchant');
  assert.deepEqual(theirs.chat.other, { name: 'Sara', username: 'sara' });
  assert.doesNotMatch(JSON.stringify(theirs), /buyer@x\.co/);

  assert.equal((await get(as(raw, STRANGER), `/api/chats/${chatId}`)).status, 403);

  // The conversation list names the store to the customer too.
  await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'hello' });
  const list = await json(await get(as(raw, BUYER), '/api/chats'));
  assert.equal(list.chats[0].other_name, 'Ali 3D Store');
  assert.equal(list.chats[0].other_username, null);
  const sellerList = await json(await get(as(raw, SELLER), '/api/chats'));
  assert.equal(sellerList.chats[0].other_name, 'Sara');
});

test('the product picker lists this store\'s buyable products only — never hidden, never another store\'s', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const page = await json(await get(as(raw, SELLER), `/api/chats/${chatId}/products`));
  assert.deepEqual(page.products.map((p: { id: string }) => p.id), ['cp_hook', 'cp_vase']);
  const vase = page.products.find((p: { id: string }) => p.id === 'cp_vase');
  assert.deepEqual({ price: vase.price_iqd, image: vase.image, in_stock: vase.in_stock }, { price: 25000, image: '/files/merchants/ali/public/vase01.webp', in_stock: true });
  assert.doesNotMatch(JSON.stringify(page), /"stock"|cost|merchant_id/);
  const q = await json(await get(as(raw, BUYER), `/api/chats/${chatId}/products?q=${encodeURIComponent('مزهر')}`));
  assert.deepEqual(q.products.map((p: { id: string }) => p.id), ['cp_vase']);
  assert.equal((await get(as(raw, RIVAL), `/api/chats/${chatId}/products`)).status, 403);
});

test('{userId} never reuses a STORE\'s thread as the pair\'s personal conversation', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const dm = await json(await post(as(raw, BUYER), '/api/chats/open', { userId: 'ali' }));
  assert.notEqual(dm.chatId, chatId, 'a personal message must not land in the store\'s inbox');
  const again = await json(await post(as(raw, BUYER), '/api/chats/open', { userId: 'ali' }));
  assert.equal(again.chatId, dm.chatId, 'the personal conversation is still one per pair');
});

// ================================================================= deploy ahead of 0150

test('a Worker ahead of 0150 still sends text and attachments; a card is a SERVICE_SETUP, never a half-card', async () => {
  const raw = seed(dbThrough('0149'));
  assert.equal(hasColumn(raw, 'chat_messages', 'card_type'), false);
  const chatId = await storeThread(raw);
  const text = await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'hello', client_id: 'tap-000000009' });
  assert.equal(text.status, 200, JSON.stringify(await text.clone().json()));
  const msgs = await thread(raw, BUYER, chatId);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].card, null);
  const card = await sendCard(raw, BUYER, chatId, { type: 'product', ref: 'cp_vase' });
  assert.equal(card.status, 500);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages'), 1);
  // The thread list and the identity still answer.
  assert.equal((await get(as(raw, BUYER), '/api/chats')).status, 200);
  assert.equal((await get(as(raw, BUYER), `/api/chats/${chatId}`)).status, 200);
  void all;
});
