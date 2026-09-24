/**
 * THE STORE'S CONVERSATIONS (W2-E, docs/MERCHANT_PLATFORM.md §4.8): threads
 * carry the store that owns them and who each member is; the merchant inbox
 * lists only the store's threads its owner is a member of, pages by cursor,
 * searches on the server, and counts unread per thread.
 *
 * Run: node --import tsx --test tests/merchantInbox.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, get, json, post, row } from './fixtures/app';
import { BUYER, BUYER2, OWNER, OWNER2, addOrder, appOf, seedW2E } from './fixtures/merchantW2E';
import type { StubUser } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { merchantInboxRoutes } from '../worker/routes/merchantInbox';

const chat = (raw: DatabaseSync, u: StubUser) => appOf(raw, u, (a) => a.route('/api/chats', chatRoutes));
const inbox = (raw: DatabaseSync, u: StubUser) => appOf(raw, u, (a) => a.route('/api/merchant/inbox', merchantInboxRoutes));
const open = async (raw: DatabaseSync, u: StubUser, body: Record<string, unknown>) => json(await post(chat(raw, u), '/api/chats/open', body));
const say = (raw: DatabaseSync, u: StubUser, chatId: string, text: string) => post(chat(raw, u), `/api/chats/${chatId}/messages`, { body: text });
const list = async (raw: DatabaseSync, u: StubUser, q = '') => json(await get(inbox(raw, u), `/api/merchant/inbox${q}`));

test('opening writes the store\'s context and each member\'s role', async () => {
  const raw = seedW2E();
  addOrder(raw, { id: 'ORD-CTX001', status: 'pending' });
  const direct = await open(raw, BUYER, { merchantId: 'm1' });
  const order = await open(raw, BUYER, { orderId: 'ORD-CTX001' });
  const ctx = (id: string) => row<Record<string, string>>(raw, 'SELECT context_type, context_id, store_id, merchant_id FROM chats WHERE id = ?', id);
  assert.deepEqual(ctx(direct.chatId), { context_type: 'store', context_id: 'buyer', store_id: 's1', merchant_id: 'm1' });
  assert.deepEqual(ctx(order.chatId), { context_type: 'store_order', context_id: 'ORD-CTX001', store_id: 's1', merchant_id: 'm1' });
  for (const id of [direct.chatId, order.chatId]) {
    assert.deepEqual(
      all(raw, 'SELECT user_id, role FROM chat_participants WHERE chat_id = ? ORDER BY user_id', id),
      [{ user_id: 'buyer', role: 'customer' }, { user_id: 'owner', role: 'merchant' }]
    );
  }
  // A personal DM stays personal: no store, no roles, not in any inbox.
  const dm = await open(raw, BUYER, { userId: 'owner2' });
  assert.equal(ctx(dm.chatId)!.store_id, null);
  // The owner cannot open a store thread with themselves.
  assert.equal((await post(chat(raw, OWNER), '/api/chats/open', { merchantId: 'm1' })).status, 400);
});

test('a request\'s thread: the requester and a merchant WITH AN OFFER, nobody else', async () => {
  const raw = seedW2E();
  raw.exec(`
    INSERT INTO community_requests (id, customer_id, title) VALUES ('req1','buyer','Bracket');
    INSERT INTO community_offers (id, request_id, merchant_id, store_id, price_iqd, state) VALUES ('off1','req1','m1','s1',10000,'pending');
  `);
  const byCustomer = await open(raw, BUYER, { requestId: 'req1', merchantId: 'm1' });
  const byMerchant = await open(raw, OWNER, { requestId: 'req1' });
  assert.equal(byCustomer.context, 'request');
  assert.equal(byMerchant.chatId, byCustomer.chatId, 'one thread per request and store');
  const refused = async (u: StubUser, body: Record<string, unknown>) => {
    const res = await post(chat(raw, u), '/api/chats/open', body);
    return [res.status, ((await res.json()) as { code?: string }).code];
  };
  assert.deepEqual(await refused(OWNER2, { requestId: 'req1' }), [403, 'REQUEST_THREAD_NOT_ALLOWED'], 'a merchant who never bid');
  assert.deepEqual(await refused(BUYER, { requestId: 'req1', merchantId: 'm2' }), [403, 'REQUEST_THREAD_NOT_ALLOWED'], 'a merchant the customer picks who never bid');
  assert.deepEqual(await refused(BUYER2, { requestId: 'req1', merchantId: 'm1' }), [403, 'REQUEST_THREAD_NOT_ALLOWED'], 'somebody else\'s request');
});

test('ISOLATION: the inbox holds the store\'s threads its owner is in — never another store\'s, never a personal DM, never a thread without them', async () => {
  const raw = seedW2E();
  const mine = await open(raw, BUYER, { merchantId: 'm1' });
  await say(raw, BUYER, mine.chatId, 'hello store');
  const theirs = await open(raw, BUYER, { merchantId: 'm2' });
  await say(raw, BUYER, theirs.chatId, 'hello other store');
  const dm = await open(raw, OWNER, { userId: 'buyer2' });
  await say(raw, OWNER, dm.chatId, 'personal');
  // A thread stamped with this store that the owner is NOT a member of (a
  // corrupted row, a future staff seat): not listed.
  raw.exec(`INSERT INTO chats (id, context_type, context_id, store_id, merchant_id, last_message_at) VALUES ('chat_orphan','store','buyer2','s1','m1','2030-01-01T00:00:00.000Z');
            INSERT INTO chat_participants (chat_id, user_id) VALUES ('chat_orphan','buyer2');`);
  const a = await list(raw, OWNER);
  assert.deepEqual(a.threads.map((t: { id: string }) => t.id), [mine.chatId]);
  const b = await list(raw, OWNER2);
  assert.deepEqual(b.threads.map((t: { id: string }) => t.id), [theirs.chatId]);
  assert.equal((await get(inbox(raw, BUYER), '/api/merchant/inbox')).status, 404, 'a customer has no store inbox');
  // And the thread itself stays participants-only.
  assert.equal((await get(chat(raw, OWNER2), `/api/chats/${mine.chatId}/messages`)).status, 403);
});

test('unread per thread and in total; reading the thread clears it', async () => {
  const raw = seedW2E();
  const t1 = await open(raw, BUYER, { merchantId: 'm1' });
  await say(raw, BUYER, t1.chatId, 'one');
  await say(raw, BUYER, t1.chatId, 'two');
  const t2 = await open(raw, BUYER2, { merchantId: 'm1' });
  await say(raw, BUYER2, t2.chatId, 'three');
  await say(raw, OWNER, t2.chatId, 'answered');
  const all1 = await list(raw, OWNER);
  const unread = Object.fromEntries(all1.threads.map((t: { id: string; unread: number }) => [t.id, t.unread]));
  assert.equal(unread[t1.chatId], 2);
  assert.equal(unread[t2.chatId], 1, 'the owner writing does not read what was there (the open does)');
  const counted = await json(await get(inbox(raw, OWNER), '/api/merchant/inbox/unread-count'));
  assert.deepEqual([counted.threads, counted.messages], [2, 3]);
  await get(chat(raw, OWNER), `/api/chats/${t1.chatId}/messages`);
  const after = await list(raw, OWNER, '?unread=1');
  assert.deepEqual(after.threads.map((t: { id: string }) => t.id), [t2.chatId]);
  const t2row = all1.threads.find((t: { id: string }) => t.id === t2.chatId);
  assert.deepEqual([t2row.last_from, t2row.last_message], ['store', 'answered']);
  assert.equal(t2row.customer.name, 'Omar Najm');
});

test('server search: the customer\'s name, the order number, and the words of the thread; kind filters', async () => {
  const raw = seedW2E();
  addOrder(raw, { id: 'ORD-FIND01', status: 'pending', user: 'buyer2' });
  const direct = await open(raw, BUYER, { merchantId: 'm1' });
  await say(raw, BUYER, direct.chatId, 'Can you print in carbon fibre?');
  const order = await open(raw, BUYER2, { orderId: 'ORD-FIND01' });
  await say(raw, BUYER2, order.chatId, 'When will it ship?');
  const ids = async (q: string) => (await list(raw, OWNER, q)).threads.map((t: { id: string }) => t.id);
  assert.deepEqual(await ids('?q=carbon'), [direct.chatId]);
  assert.deepEqual(await ids('?q=Omar'), [order.chatId]);
  assert.deepEqual(await ids('?q=FIND01'), [order.chatId]);
  assert.deepEqual(await ids(`?q=${encodeURIComponent('%')}`), [], 'a wildcard the merchant typed is a literal');
  assert.deepEqual(await ids('?kind=order'), [order.chatId]);
  assert.deepEqual(await ids('?kind=direct'), [direct.chatId]);
  assert.equal((await get(inbox(raw, OWNER), '/api/merchant/inbox?kind=all')).status, 400);
  // The other store's words are not searchable from here.
  const other = await open(raw, BUYER, { merchantId: 'm2' });
  await say(raw, BUYER, other.chatId, 'carbon fibre too');
  assert.deepEqual(await ids('?q=carbon'), [direct.chatId]);
});

test('paging by cursor walks every thread once, newest activity first, ties included', async () => {
  const raw = seedW2E();
  for (let i = 0; i < 7; i++) {
    raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('c${i}','Customer ${i}','c${i}@x.co','h');
      INSERT INTO chats (id, context_type, context_id, store_id, merchant_id, last_message_at)
        VALUES ('chat_p${i}','store','c${i}','s1','m1','${i < 4 ? '2026-09-01T00:00:00.000Z' : `2026-09-0${i}T00:00:00.000Z`}');
      INSERT INTO chat_participants (chat_id, user_id, role) VALUES ('chat_p${i}','owner','merchant'), ('chat_p${i}','c${i}','customer');`);
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON page
    const page: Record<string, any> = await list(raw, OWNER, `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...page.threads.map((t: { id: string }) => t.id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.deepEqual(seen.slice(0, 3), ['chat_p6', 'chat_p5', 'chat_p4']);
});

test('sending stamps the thread\'s last activity; attachments go through the same door as before', async () => {
  const raw = seedW2E();
  const t = await open(raw, BUYER, { merchantId: 'm1' });
  assert.equal(row<{ at: string | null }>(raw, 'SELECT last_message_at AS at FROM chats WHERE id = ?', t.chatId)!.at, null);
  const sent = await json(await say(raw, BUYER, t.chatId, 'hi'));
  assert.equal(row<{ at: string }>(raw, 'SELECT last_message_at AS at FROM chats WHERE id = ?', t.chatId)!.at, sent.message.created_at);
  // An attachment key from another conversation is refused exactly as before.
  const bad = await post(chat(raw, BUYER), `/api/chats/${t.chatId}/messages`, { kind: 'image', fileKey: 'chat/chat_other/attachments/x.webp' });
  assert.equal(bad.status, 400);
});
