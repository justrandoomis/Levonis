/**
 * CONVERSATIONS ABOUT A STORE ORDER — wave 1, W1-C.
 *
 *   audit 04 B10  a customer's message on a merchant-store order reached nobody:
 *                 the seller was not in the thread and nothing told them
 *   audit 04 B5   a thread returned its OLDEST 500 messages — the newest never
 *   audit 04 B6   an admin opening the order's chat silently joined the
 *                 merchant↔customer thread (DECISIONS: read-only + audit row)
 *
 * Real routes on every migration; only the session is stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, json, all, count, row, type StubUser } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { fileRoutes } from '../worker/routes/uploads';
import { mergeNewestPage, prependOlder } from '../src/lib/chatPaging';

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const SELLER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };
const ADMIN: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const STRANGER: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co' };

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('owner','Ali','owner@x.co','h','merchant'),
      ('boss','Boss','boss@x.co','h','admin'), ('eve','Eve','eve@x.co','h','customer');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
      VALUES ('ord1','buyer','pending',1000,'m1','s1','merchant','store_product','{}','d','{}','wallet',1000,1500,0),
             ('shop1','buyer','pending',1000,NULL,NULL,'levonis','platform','{}','d','{}','wallet',1000,1500,0);
  `);
  return raw;
}
const as = (raw: ReturnType<typeof freshDb>, user: StubUser) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/chats', chatRoutes));
const members = (raw: ReturnType<typeof freshDb>, chatId: string) =>
  all<{ user_id: string }>(raw, 'SELECT user_id FROM chat_participants WHERE chat_id = ? ORDER BY user_id', chatId).map((r) => r.user_id);

// ============================================================== B10

test('B10: the customer opens the order chat first — the SELLER is in it, sees it, and is told', async () => {
  const raw = seed();
  const { chatId } = await json(await post(as(raw, BUYER), '/api/chats/open', { orderId: 'ord1' }));
  assert.deepEqual(members(raw, chatId), ['buyer', 'owner']);

  assert.equal((await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'Which colour is this?' })).status, 200);
  const list = await json(await get(as(raw, SELLER), '/api/chats'));
  assert.equal(list.chats.length, 1, "the thread is in the seller's list");
  assert.equal(list.chats[0].unread, 1);

  const notes = all<{ user_id: string; kind: string; link: string }>(raw, 'SELECT user_id, kind, link FROM user_notifications');
  // The seller hears it as the STORE's notice, opening the thread in the workspace inbox (W2-E).
  assert.deepEqual(notes, [{ user_id: 'owner', kind: 'new_message', link: `/merchant/inbox/${chatId}` }]);

  // Once per TURN: a second line in a row is the same question waiting.
  await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'And the size?' });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications'), 1);
  // The seller answers: the customer is told, once.
  await post(as(raw, SELLER), `/api/chats/${chatId}/messages`, { body: 'Gold, size M' });
  assert.deepEqual(
    all(raw, "SELECT user_id, kind FROM user_notifications WHERE user_id = 'buyer'"),
    [{ user_id: 'buyer', kind: 'chat_message' }]
  );
});

test('B10: a thread created BEFORE the fix (buyer alone) gains its seller on the next message', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO chats (id, order_id) VALUES ('c_old','ord1'); INSERT INTO chat_participants (chat_id, user_id) VALUES ('c_old','buyer');`);
  await post(as(raw, BUYER), '/api/chats/c_old/messages', { body: 'Hello?' });
  assert.deepEqual(members(raw, 'c_old'), ['buyer', 'owner']);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'owner'"), 1);
});

test('the seller\'s «رسائل جديدة» switch governs the outside channels; the in-app record always lands (W2-E)', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO merchant_notification_preferences (merchant_id, new_messages) VALUES ('m1', 0)`);
  const { chatId } = await json(await post(as(raw, BUYER), '/api/chats/open', { orderId: 'ord1' }));
  await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'hi' });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'new_message'"), 1, 'in-app: the store\'s record');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM outbox WHERE event_key LIKE 'merchant:%'"), 0, 'switched off: nothing goes out');
  assert.deepEqual(members(raw, chatId), ['buyer', 'owner'], 'the message still reaches the thread');
});

// ============================================================== B6

test('B6: an admin opening a store order\'s chat is answered READ-ONLY and never joins', async () => {
  const raw = seed();
  const { chatId } = await json(await post(as(raw, BUYER), '/api/chats/open', { orderId: 'ord1' }));
  await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'Where is my parcel?' });

  const opened = await json(await post(as(raw, ADMIN), '/api/chats/open', { orderId: 'ord1' }));
  assert.equal(opened.readOnly, true);
  assert.equal(opened.chatId, chatId);
  assert.deepEqual(members(raw, chatId), ['buyer', 'owner'], 'nobody was added');

  const read = await get(as(raw, ADMIN), `/api/chats/${chatId}/messages`);
  assert.equal(read.status, 200);
  const body = await json(read);
  assert.equal(body.read_only, true);
  assert.equal(body.messages.length, 1);

  // Every look is on the record — once per admin per thread per hour, not per poll.
  await get(as(raw, ADMIN), `/api/chats/${chatId}/messages`);
  assert.deepEqual(
    all(raw, "SELECT actor_id, action, target FROM audit_log WHERE action = 'admin.chat_read'"),
    [{ actor_id: 'boss', action: 'admin.chat_read', target: chatId }]
  );

  // Read-only means read-only: no message, no typing.
  const write = await post(as(raw, ADMIN), `/api/chats/${chatId}/messages`, { body: 'Staff here' });
  assert.equal(write.status, 403);
  assert.equal((await post(as(raw, ADMIN), `/api/chats/${chatId}/typing`, { typing: true })).status, 403);
});

test('B6: an admin silently joined BEFORE the fix is still read-only', async () => {
  const raw = seed();
  const { chatId } = await json(await post(as(raw, BUYER), '/api/chats/open', { orderId: 'ord1' }));
  raw.exec(`INSERT INTO chat_participants (chat_id, user_id) VALUES ('${chatId}', 'boss')`);
  const write = await post(as(raw, ADMIN), `/api/chats/${chatId}/messages`, { body: 'Staff here' });
  assert.equal(write.status, 403);
  assert.equal((await json(write)).code, 'CHAT_READ_ONLY');
});

test('an admin does not START a conversation between a customer and a store', async () => {
  const raw = seed();
  const opened = await json(await post(as(raw, ADMIN), '/api/chats/open', { orderId: 'ord1' }));
  assert.deepEqual({ chatId: opened.chatId, readOnly: opened.readOnly }, { chatId: null, readOnly: true });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chats'), 0);
});

test('the SHOP\'s own order threads are unchanged: the admin is the other party and joins', async () => {
  const raw = seed();
  const { chatId } = await json(await post(as(raw, BUYER), '/api/chats/open', { orderId: 'shop1' }));
  await post(as(raw, ADMIN), '/api/chats/open', { orderId: 'shop1' });
  assert.deepEqual(members(raw, chatId), ['boss', 'buyer']);
  assert.equal((await post(as(raw, ADMIN), `/api/chats/${chatId}/messages`, { body: 'Support here' })).status, 200);
});

test('B6: a FILE from a store thread, opened by staff who only read it, is recorded like the thread itself', async () => {
  const raw = seed();
  const { chatId } = await json(await post(as(raw, BUYER), '/api/chats/open', { orderId: 'ord1' }));
  const shop = (await json(await post(as(raw, BUYER), '/api/chats/open', { orderId: 'shop1' }))).chatId as string;
  // A stored attachment in each thread, served through the real file route.
  const stored = new Map<string, Uint8Array>();
  const bucket = {
    async get(key: string) {
      const b = stored.get(key);
      return b ? { body: new Blob([b as unknown as BlobPart]).stream(), size: b.byteLength, httpEtag: `"${key}"`, writeHttpMetadata() {} } : null;
    },
    async head(key: string) { return stored.has(key) ? { key, size: stored.get(key)!.byteLength } : null; },
  };
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  stored.set(`chat/${chatId}/aaaa1111.jpg`, photo);
  stored.set(`chat/${shop}/bbbb2222.jpg`, photo);
  const files = (user: StubUser) =>
    stubApp(asD1(raw), user, (a) => a.route('/files', fileRoutes), { env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket } });
  const reads = () => count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.chat_read'");

  assert.equal((await get(files(ADMIN), `/files/chat/${chatId}/aaaa1111.jpg`)).status, 200);
  assert.equal(reads(), 1, 'the staff read of a merchant↔customer file is on the record');
  assert.equal(row<{ target: string }>(raw, "SELECT target FROM audit_log WHERE action = 'admin.chat_read'")!.target, chatId);
  assert.deepEqual(members(raw, chatId), ['buyer', 'owner'], 'and staff did not join to read it');

  // The shop's own thread is the support desk's work: nothing to record.
  assert.equal((await get(files(ADMIN), `/files/chat/${shop}/bbbb2222.jpg`)).status, 200);
  assert.equal(reads(), 1);
  // A participant reads their own file unrecorded; a stranger does not read it.
  assert.equal((await get(files(SELLER), `/files/chat/${chatId}/aaaa1111.jpg`)).status, 200);
  assert.equal(reads(), 1);
  assert.equal((await get(files(STRANGER), `/files/chat/${chatId}/aaaa1111.jpg`)).status, 403);
});

test('strangers are still out: no read, no open', async () => {
  const raw = seed();
  const { chatId } = await json(await post(as(raw, BUYER), '/api/chats/open', { orderId: 'ord1' }));
  assert.equal((await get(as(raw, STRANGER), `/api/chats/${chatId}/messages`)).status, 403);
  assert.equal((await post(as(raw, STRANGER), '/api/chats/open', { orderId: 'ord1' })).status, 403);
});

// ============================================================== B5

test('B5: a long thread answers its NEWEST page, and pages back through every message exactly once', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO chats (id) VALUES ('c1'); INSERT INTO chat_participants (chat_id,user_id) VALUES ('c1','buyer'),('c1','owner');`);
  const ins = raw.prepare('INSERT INTO chat_messages (id,chat_id,sender_id,body,created_at) VALUES (?,?,?,?,?)');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  // 510 messages, and the last ten share ONE timestamp — a page boundary
  // inside a tie is the case a timestamp-only cursor drops.
  for (let i = 0; i < 510; i++) {
    const at = new Date(t0 + Math.min(i, 500) * 1000).toISOString();
    ins.run(`m${String(i).padStart(3, '0')}`, 'c1', i % 2 ? 'buyer' : 'owner', `msg ${i}`, at);
  }
  const a = as(raw, BUYER);
  const first = await json(await get(a, '/api/chats/c1/messages?limit=7'));
  assert.equal(first.messages.at(-1).body, 'msg 509', 'the newest message is on screen');
  assert.equal(first.messages.length, 7);
  assert.equal(first.has_more, true);

  const seen: string[] = first.messages.map((m: { body: string }) => m.body);
  let cursor: string | null = first.older_cursor;
  let pages = 0;
  while (cursor) {
    const page = await json(await get(a, `/api/chats/c1/messages?limit=7&before=${encodeURIComponent(cursor)}`));
    seen.unshift(...page.messages.map((m: { body: string }) => m.body));
    cursor = page.older_cursor;
    assert.ok(++pages < 200, 'paging terminates');
  }
  assert.equal(seen.length, 510, 'every message, once');
  assert.equal(new Set(seen).size, 510);
  assert.equal(seen[0], 'msg 0');
});

test('B5: reading an OLDER page does not mark the thread read — only the newest page does', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO chats (id) VALUES ('c1'); INSERT INTO chat_participants (chat_id,user_id) VALUES ('c1','buyer'),('c1','owner');
            INSERT INTO chat_messages (id,chat_id,sender_id,body,created_at) VALUES
              ('a','c1','owner','one','2026-01-01T00:00:00.000Z'), ('b','c1','owner','two','2026-01-01T00:00:01.000Z');`);
  await get(as(raw, BUYER), `/api/chats/c1/messages?before=${encodeURIComponent('2026-01-01T00:00:01.000Z|b')}`);
  assert.equal(row<{ last_read_at: string | null }>(raw, "SELECT last_read_at FROM chat_participants WHERE chat_id='c1' AND user_id='buyer'")!.last_read_at, null);
  await get(as(raw, BUYER), '/api/chats/c1/messages');
  assert.notEqual(row<{ last_read_at: string | null }>(raw, "SELECT last_read_at FROM chat_participants WHERE chat_id='c1' AND user_id='buyer'")!.last_read_at, null);
});

// ============================================================== client merge

const msg = (id: string, at: string) => ({ id, created_at: at });

test('the chat screen keeps the history it paged back through when the poll brings the newest page', () => {
  const older = [msg('a', '1'), msg('b', '2')];
  const page1 = [msg('c', '3'), msg('d', '4')];
  const onScreen = [...older, ...page1];
  // The poll's newest page now also has «e».
  const poll = mergeNewestPage(onScreen, [msg('d', '4'), msg('e', '5')], true);
  assert.deepEqual(poll.messages.map((m) => m.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(poll.reset, false);
  // A quiet poll changes nothing — the same array, so React does not re-render.
  const quiet = mergeNewestPage(poll.messages, [msg('d', '4'), msg('e', '5')], true);
  assert.equal(quiet.messages, poll.messages);
  // More arrived than a page holds: keeping the old rows would hide a gap.
  const gap = mergeNewestPage(poll.messages, [msg('x', '8'), msg('y', '9')], true);
  assert.deepEqual(gap, { messages: [msg('x', '8'), msg('y', '9')], reset: true });
  // A short thread IS its only page.
  assert.deepEqual(mergeNewestPage(onScreen, [msg('a', '1')], false).messages, [msg('a', '1')]);
});

test('an older page goes above, without repeating a row already shown', () => {
  const now = [msg('c', '3'), msg('d', '4')];
  assert.deepEqual(prependOlder(now, [msg('a', '1'), msg('b', '2'), msg('c', '3')]).map((m) => m.id), ['a', 'b', 'c', 'd']);
  assert.equal(prependOlder(now, [msg('c', '3')]), now);
});
