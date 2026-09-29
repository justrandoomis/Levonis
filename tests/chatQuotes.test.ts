/**
 * PRINT REQUESTS AND QUOTES IN THE STORE'S CONVERSATION — stage 4 of
 * docs/COMMUNITY_COMMERCE_CHAT.md (0151, worker/routes/chatCommerce.ts), on
 * top of the escrow that already exists.
 *
 * The journey: the customer sends a print request in the thread → the store
 * quotes → the customer accepts THROUGH THE EXISTING DOOR (hold + one fenced
 * batch) → a funded order linked to the thread, and «تم إنشاء الطلب» posted
 * there. And every rule the owner listed, tried as an attack:
 *   · one financial flow per deal — acceptance is the marketplace's own;
 *   · accepting twice is the SAME order, never a second hold;
 *   · a quote edited after the customer saw it cannot be accepted at the old
 *     price (OFFER_CHANGED) — the older card says so and loses its buttons;
 *   · another store can neither read, quote, nor be made to hold a private
 *     request — refused by the routes AND by 0151's trigger;
 *   · the customer never quotes, the store never sends a print request,
 *     outsiders do neither; the community switch closes the create doors only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, post, patch, get, json, count, row, all, spendable, type StubUser, type Mount } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { chatCommerceRoutes } from '../worker/routes/chatCommerce';
import { marketplaceRoutes } from '../worker/routes/marketplace';

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const ZAIN: StubUser = { id: 'zain', role: 'merchant', email: 'zain@x.co' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co' };

const mount: Mount = (a) => {
  a.route('/api/chats', chatRoutes);
  a.route('/api/chats', chatCommerceRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

function seed(raw: DatabaseSync = freshDb(), opts: { gate?: boolean } = {}) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('buyer','Sara','buyer@x.co','h','customer','sara'), ('ali','Ali','ali@x.co','h','merchant','ali'),
      ('zain','Zain','zain@x.co','h','merchant','zain'), ('eve','Eve','eve@x.co','h','customer','eve');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_zain','zain','Zain Print','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active'), ('s_zain','m_zain','zain','zainprint','Zain Print','active');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem_zain','zain','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
  `);
  if (opts.gate !== false) raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}')`);
  return raw;
}
const fund = (raw: DatabaseSync, user: string, iqd: number) =>
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_${Math.random().toString(36).slice(2)}','${user}','deposit','USD',${Math.ceil((iqd * 100) / RATE)},'approved','test funding')`);
const as = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, mount);

async function storeThread(raw: DatabaseSync, merchantId = 'm_ali'): Promise<string> {
  const res = await json(await post(as(raw, BUYER), '/api/chats/open', { merchantId }));
  return res.chatId;
}
const messages = async (raw: DatabaseSync, user: StubUser, chatId: string) =>
  (await json(await get(as(raw, user), `/api/chats/${chatId}/messages`))).messages as Array<Record<string, any>>;
const cardsOf = async (raw: DatabaseSync, user: StubUser, chatId: string, type: string) =>
  (await messages(raw, user, chatId)).filter((m) => m.card?.type === type);

const JOB = { title: 'Phone stand', description: 'A stand for my phone, matte black please', quantity: 2, material: 'PETG', color: 'Black' };
const TERMS = { price_iqd: 45000, completion_days: 3, delivery_method: 'merchant_delivery', message: 'Ready in 3 days', valid_days: 7 };

/** The customer's «طلب طباعة», drafted then sent — what the sheet does. */
async function sendPrintRequest(raw: DatabaseSync, chatId: string) {
  const draft = await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests`, JOB);
  assert.equal(draft.status, 201, JSON.stringify(await json(draft.clone())));
  const requestId = (await json(draft)).request.id as string;
  const sent = await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests/${requestId}/send`, {});
  assert.equal(sent.status, 201, JSON.stringify(await json(sent.clone())));
  return { requestId, sent: await json(sent) };
}
async function quote(raw: DatabaseSync, chatId: string, body: Record<string, unknown>, who: StubUser = ALI) {
  return post(as(raw, who), `/api/chats/${chatId}/quotes`, { ...TERMS, ...body });
}
/** Accept exactly what the card showed — the snapshot's price and revision (a quote card's message). */
function acceptCard(raw: DatabaseSync, message: Record<string, any>, who: StubUser = BUYER, extra: Record<string, unknown> = {}) {
  return post(as(raw, who), `/api/marketplace/offers/${message.card.ref}/accept`, {
    expected_price_iqd: message.card.original.price_iqd,
    offer_revision: message.card.original.revision,
    ...extra,
  });
}

// ================================================================ the journey

test('the journey: print request in the thread → quote → accept through the escrow → a funded order linked to the thread', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { requestId, sent } = await sendPrintRequest(raw, chatId);
  assert.equal(sent.message.kind, 'print_request_card');
  assert.equal(sent.message.card.original.title, 'Phone stand');
  assert.equal(sent.message.card.original.quantity, 2);

  const r = row<Record<string, unknown>>(raw, 'SELECT state, status, visibility, target_merchant_id, origin_chat_id, created_by FROM community_requests WHERE id = ?', requestId)!;
  assert.deepEqual(r, { state: 'open', status: 'open', visibility: 'direct', target_merchant_id: 'm_ali', origin_chat_id: chatId, created_by: 'customer' });

  // Never on the board, which only ever lists public requests.
  const board = await json(await get(as(raw, ZAIN), '/api/marketplace/requests'));
  assert.equal(board.requests.length, 0);

  // The store sees the card with «quote»; the customer with «cancel».
  const [forAli] = await cardsOf(raw, ALI, chatId, 'print_request');
  assert.deepEqual(forAli.card.current.actions, ['quote']);
  const [forBuyer] = await cardsOf(raw, BUYER, chatId, 'print_request');
  assert.deepEqual(forBuyer.card.current.actions, ['cancel']);

  // The store quotes it.
  const q = await quote(raw, chatId, { request_id: requestId });
  assert.equal(q.status, 201, JSON.stringify(await json(q.clone())));
  const qb = await json(q);
  assert.equal(qb.message.kind, 'quote_card');
  assert.equal(qb.message.card.original.price_iqd, 45000);
  assert.equal(qb.message.card.original.revision, 1);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', requestId)!.state, 'receiving_offers');

  const [quoteForBuyer] = await cardsOf(raw, BUYER, chatId, 'quote');
  assert.deepEqual(quoteForBuyer.card.current.actions, ['accept', 'decline']);
  const [quoteForAli] = await cardsOf(raw, ALI, chatId, 'quote');
  assert.deepEqual(quoteForAli.card.current.actions, ['edit', 'withdraw']);

  // The customer accepts through the EXISTING door.
  fund(raw, 'buyer', 100_000);
  const before = spendable(raw, 'buyer');
  const acc = await acceptCard(raw, quoteForBuyer);
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const { order } = await json(acc);
  assert.equal(order.state, 'funded');
  assert.equal(order.price_iqd, 45000);
  assert.equal(order.chat_id, chatId, 'the order knows the conversation it came from');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE community_order_id = ?', order.id)!.state, 'held');
  assert.ok(spendable(raw, 'buyer') < before, 'the money is held');

  // «تم إنشاء الطلب» — one system card, in this thread, by the customer's action.
  const systems = (await messages(raw, ALI, chatId)).filter((m) => m.system);
  assert.equal(systems.length, 1);
  assert.equal(systems[0].card.type, 'custom_order');
  assert.equal(systems[0].card.original.event, 'funded');
  assert.equal(systems[0].card.current.status, 'funded');
  assert.deepEqual(systems[0].card.current.actions, ['start', 'view'], 'the store starts the work from the conversation');

  const [accepted] = await cardsOf(raw, BUYER, chatId, 'quote');
  assert.equal(accepted.card.current.status, 'accepted');
  assert.equal(accepted.card.current.order_id, order.id);
  assert.deepEqual(accepted.card.current.actions, []);
});

test('ATTACK: accepting twice is the SAME order — never a second hold, never a second order', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { requestId } = await sendPrintRequest(raw, chatId);
  const { message } = await json(await quote(raw, chatId, { request_id: requestId }));
  fund(raw, 'buyer', 200_000);
  const first = await json(await acceptCard(raw, message));
  const afterFirst = spendable(raw, 'buyer');
  const again = await acceptCard(raw, message);
  assert.equal(again.status, 200);
  const replay = await json(again);
  assert.equal(replay.replayed, true);
  assert.equal(replay.order.id, first.order.id);
  assert.equal(spendable(raw, 'buyer'), afterFirst, 'nothing more was taken');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM wallet_holds'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages WHERE is_system = 1'), 1, 'the event is recorded once');
  // Another account replaying the customer's acceptance gets nothing.
  assert.equal((await acceptCard(raw, message, EVE)).status, 403);
});

test('ATTACK: the store edits its quote after the customer saw it — the old price cannot be accepted', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { requestId } = await sendPrintRequest(raw, chatId);
  const first = await json(await quote(raw, chatId, { request_id: requestId }));
  const edited = await patch(as(raw, ALI), `/api/chats/${chatId}/quotes/${first.offer.id}`, { price_iqd: 60000 });
  assert.equal(edited.status, 200, JSON.stringify(await json(edited.clone())));
  const eb = await json(edited);
  assert.equal(eb.message.card.original.revision, 2);
  assert.equal(eb.message.card.original.price_iqd, 60000);

  const quotes = await cardsOf(raw, BUYER, chatId, 'quote');
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].card.current.status, 'changed', 'the older card says the quote was updated');
  assert.deepEqual(quotes[0].card.current.actions, [], '…and offers nothing to press');
  assert.deepEqual(quotes[1].card.current.actions, ['accept', 'decline']);
  assert.equal(quotes[0].card.original.price_iqd, 45000, 'what was sent is never rewritten');

  fund(raw, 'buyer', 200_000);
  const stale = await acceptCard(raw, quotes[0]);
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'OFFER_CHANGED');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0, 'nothing held at a price nobody confirmed');
  const fresh = await acceptCard(raw, quotes[1]);
  assert.equal(fresh.status, 201);
  assert.equal((await json(fresh)).order.price_iqd, 60000);

  // An accepted quote is the contract: it cannot be edited.
  const late = await patch(as(raw, ALI), `/api/chats/${chatId}/quotes/${first.offer.id}`, { price_iqd: 1000 });
  assert.equal(late.status, 409);
});

test('the store may quote with no request — the request it makes is the CUSTOMER\'s, and acceptance is the consent', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const res = await quote(raw, chatId, { title: 'Custom keychain', quantity: 10, material: 'PLA', description: 'Your logo, 4 cm' });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const body = await json(res);
  const r = row<Record<string, unknown>>(raw, 'SELECT customer_id, state, visibility, target_merchant_id, created_by, origin_chat_id FROM community_requests WHERE id = ?', body.request_id)!;
  assert.deepEqual(r, { customer_id: 'buyer', state: 'receiving_offers', visibility: 'direct', target_merchant_id: 'm_ali', created_by: 'merchant', origin_chat_id: chatId });
  assert.equal(body.message.card.original.title, 'Custom keychain');
  // Nothing is charged until the customer accepts.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM wallet_holds'), 0);
  fund(raw, 'buyer', 100_000);
  const acc = await acceptCard(raw, body.message);
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  // The customer can also decline instead — shown on a second quote.
  const second = await json(await quote(raw, chatId, { title: 'Second item', quantity: 1 }));
  const dec = await post(as(raw, BUYER), `/api/marketplace/offers/${second.offer.id}/decline`, {});
  assert.equal(dec.status, 200);
  const declined = (await cardsOf(raw, ALI, chatId, 'quote')).find((m) => m.card.ref === second.offer.id)!;
  assert.equal(declined.card.current.status, 'declined');
});

// ================================================================ attacks

test('ATTACK: only the customer sends print requests, only the store quotes, outsiders do neither', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const byStore = await post(as(raw, ALI), `/api/chats/${chatId}/print-requests`, JOB);
  assert.equal(byStore.status, 403);
  assert.equal((await json(byStore)).code, 'CARD_NOT_ALLOWED');
  const byCustomer = await quote(raw, chatId, { title: 'Free stuff' }, BUYER);
  assert.equal(byCustomer.status, 403);
  assert.equal((await json(byCustomer)).code, 'CARD_NOT_ALLOWED');
  assert.equal((await quote(raw, chatId, { title: 'Undercut' }, ZAIN)).status, 403, 'another store is not in this conversation');
  assert.equal((await post(as(raw, EVE), `/api/chats/${chatId}/print-requests`, JOB)).status, 403);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_requests'), 0);
});

test('ATTACK: another store can neither read, quote, nor be made to hold a private request', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { requestId } = await sendPrintRequest(raw, chatId);

  // It is invisible to them…
  assert.equal((await get(as(raw, ZAIN), `/api/marketplace/requests/${requestId}`)).status, 404);
  assert.equal((await get(as(raw, EVE), `/api/marketplace/requests/${requestId}`)).status, 404);
  assert.equal((await get(as(raw, ALI), `/api/marketplace/requests/${requestId}`)).status, 200, '…and readable by the store it was sent to');
  assert.equal((await get(as(raw, ZAIN), `/api/marketplace/requests/${requestId}/offers`)).status, 200);
  assert.deepEqual((await json(await get(as(raw, ZAIN), `/api/marketplace/requests/${requestId}/offers`))).offers, []);

  // …the board's offer door does not know it…
  const board = await post(as(raw, ZAIN), `/api/marketplace/requests/${requestId}/offers`, TERMS);
  assert.equal(board.status, 404);

  // …a quote from their own conversation with the same customer cannot name it…
  const zainThread = await storeThread(raw, 'm_zain');
  const smuggled = await quote(raw, zainThread, { request_id: requestId }, ZAIN);
  assert.equal(smuggled.status, 404);

  // …and the database itself refuses the row a forgotten check would write.
  assert.throws(
    () => raw.exec(`INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('o_bad','${requestId}','m_zain','s_zain',1,'pending')`),
    /DIRECT_REQUEST_OTHER_STORE/
  );
  assert.throws(() => raw.exec(`UPDATE community_requests SET visibility = 'public' WHERE id = '${requestId}'`), /DIRECT_REQUEST_VISIBILITY_LOCKED/);
  assert.throws(() => raw.exec(`UPDATE community_requests SET target_merchant_id = 'm_zain' WHERE id = '${requestId}'`), /DIRECT_REQUEST_TARGET_LOCKED/);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 0);
});

test('ATTACK: a second quote while one is live, a quote on an expired or cancelled request — refused', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { requestId } = await sendPrintRequest(raw, chatId);
  assert.equal((await quote(raw, chatId, { request_id: requestId })).status, 201);
  const twice = await quote(raw, chatId, { request_id: requestId, price_iqd: 40000 });
  assert.equal(twice.status, 409);
  assert.equal((await json(twice)).code, 'OFFER_EXISTS');

  // The customer cancels: the live quote is closed with it.
  assert.equal((await post(as(raw, BUYER), `/api/marketplace/requests/${requestId}/cancel`, {})).status, 200);
  const [closed] = await cardsOf(raw, BUYER, chatId, 'quote');
  assert.equal(closed.card.current.status, 'declined');
  assert.deepEqual(closed.card.current.actions, []);
  const onCancelled = await quote(raw, chatId, { request_id: requestId });
  assert.equal(onCancelled.status, 409);
  assert.equal((await json(onCancelled)).code, 'REQUEST_NOT_OPEN');

  const second = await sendPrintRequest(raw, chatId);
  raw.exec(`UPDATE community_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '${second.requestId}'`);
  const onExpired = await quote(raw, chatId, { request_id: second.requestId });
  assert.equal(onExpired.status, 409);
  assert.equal((await json(onExpired)).code, 'REQUEST_EXPIRED');
});

test('ATTACK: a customer who cannot pay is refused before anything is written — no order, no card', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { requestId } = await sendPrintRequest(raw, chatId);
  const { message } = await json(await quote(raw, chatId, { request_id: requestId }));
  fund(raw, 'buyer', 1000);
  const res = await acceptCard(raw, message);
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'INSUFFICIENT_FUNDS');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages WHERE is_system = 1'), 0);
  // A lower price sent by the client is not a discount, it is a stale confirmation.
  fund(raw, 'buyer', 200_000);
  const cheap = await post(as(raw, BUYER), `/api/marketplace/offers/${message.card.ref}/accept`, { expected_price_iqd: 1, offer_revision: 1 });
  assert.equal(cheap.status, 409);
  assert.equal((await json(cheap)).code, 'OFFER_CHANGED');
});

test('the community switch closes the doors that START custom work — acceptance stays open', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { requestId } = await sendPrintRequest(raw, chatId);
  const { message } = await json(await quote(raw, chatId, { request_id: requestId }));
  raw.exec(`UPDATE admin_settings SET value = '{"open":false}' WHERE key = 'communityGate'`);
  const blockedRequest = await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests`, JOB);
  assert.equal(blockedRequest.status, 503);
  assert.equal((await json(blockedRequest)).code, 'COMMUNITY_CLOSED');
  const blockedQuote = await quote(raw, chatId, { title: 'Another' });
  assert.equal(blockedQuote.status, 503);
  fund(raw, 'buyer', 100_000);
  assert.equal((await acceptCard(raw, message)).status, 201, 'a quote already given can still be accepted');
});

test('a store that takes no custom requests is not sent one', async () => {
  const raw = seed();
  raw.exec(`UPDATE merchant_stores SET accepts_custom_requests = 0 WHERE id = 's_ali'`);
  const chatId = await storeThread(raw);
  const res = await post(as(raw, BUYER), `/api/chats/${chatId}/print-requests`, JOB);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'STORE_NO_CUSTOM_REQUESTS');
});

test('the orders panel shows this store × this customer, both flows, to the two of them only', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { requestId } = await sendPrintRequest(raw, chatId);
  const { message } = await json(await quote(raw, chatId, { request_id: requestId }));
  fund(raw, 'buyer', 100_000);
  await acceptCard(raw, message);
  const panel = await json(await get(as(raw, ALI), `/api/chats/${chatId}/orders`));
  assert.equal(panel.role, 'merchant');
  assert.equal(panel.custom_orders.length, 1);
  assert.equal(panel.custom_orders[0].title, 'Phone stand');
  assert.deepEqual(panel.store_orders, []);
  assert.equal((await get(as(raw, ZAIN), `/api/chats/${chatId}/orders`)).status, 403);
  assert.doesNotMatch(JSON.stringify(panel), /buyer@x\.co|contact|address/);
});

test('a Worker ahead of 0151 still accepts a board offer — the direct-request reads degrade', async () => {
  const raw = seed(dbThrough('0150'));
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('r1','buyer','Print a bracket','I need a bracket printed','receiving_offers','open','public',1,'${FUTURE}');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('o1','r1','m_ali','s_ali',50000,'pending');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm) VALUES ('p1','m_ali','s_ali','P1S','fdm',256,256,250);
  `);
  fund(raw, 'buyer', 200_000);
  const res = await post(as(raw, BUYER), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50000, offer_revision: 1 });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  void all;
});
