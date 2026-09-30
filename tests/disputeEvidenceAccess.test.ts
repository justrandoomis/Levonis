/**
 * DISPUTE EVIDENCE ACCESS (docs/COMMUNITY_ECOSYSTEM.md §9.6, migration 0163).
 *
 * The brief's rule, verbatim: staff read-only, audited, only while disputed,
 * only for the pre-order store conversation linked to a disputed order. Over
 * the real routes — a real acceptance, a real dispute, a real decision:
 *
 *   · 403 EVIDENCE_NOT_LINKED before the dispute, for the thread, its pages
 *     and its files — nothing recorded;
 *   · 200 read-only while it is disputed: `read_only`, role `staff`, every
 *     card's actions empty, nothing offered to send, the case named by id;
 *   · one read SESSION per admin per thread per half hour — the header, the
 *     pages and the files share it — as a `chat_staff_reads` row AND an
 *     `admin.chat_read` audit row; a second admin, or the same one later, is
 *     another session;
 *   · no staff write path: every POST door of the thread refuses them;
 *   · the evidence rows never expose a key or a message;
 *   · a thread NOT linked to the disputed order (the customer's DM with the
 *     store, a rival workshop's request thread) stays 403 during it;
 *   · 403 EVIDENCE_CLOSED the moment the decision lands — thread and files;
 *   · the dispute desk links «المحادثة» and «الطلب»;
 *   · a store order bought from a thread opens the same door while its
 *     complaint is open, and closes it when the complaint is decided.
 *
 * Run: node --import tsx --test tests/disputeEvidenceAccess.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, count, row, all, memoryBucket, MERCHANT_HOST, type StubUser, type Mount } from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { chatRoutes } from '../worker/routes/chats';
import { chatCommerceRoutes } from '../worker/routes/chatCommerce';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { fileRoutes } from '../worker/routes/uploads';
import { evidenceVerdict } from '../worker/lib/disputeEvidence';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/chats', chatRoutes);
  a.route('/api/chats', chatCommerceRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
  a.route('/files', fileRoutes);
};

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'owner', role: 'customer', email: 'owner@x.co' };
const OMAR: StubUser = { id: 'owner2', role: 'customer', email: 'owner2@x.co' };
const NOUR: StubUser = { id: 'stranger', role: 'customer', email: 'stranger@x.co' };
// boss@x.co is INITIAL_ADMIN_EMAIL in the harness: the owner, financial scope included.
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const DESK: StubUser = { id: 'desk', role: 'admin', email: 'desk@x.co' };

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('owner','Ali','owner@x.co','h','customer'),
      ('owner2','Omar','owner2@x.co','h','customer'), ('stranger','Nour','stranger@x.co','h','customer'),
      ('boss','Boss','boss@x.co','h','admin'), ('desk','Desk','desk@x.co','h','admin');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,name_ar,status,lifecycle,price_iqd,stock,track_stock,images,created_at) VALUES
      ('cp_vase','m1','s1','vase','Vase','مزهرية','active','active',25000,5,1,'[]','2026-09-01T00:00:00.000Z');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('r1','buyer','Print a bracket','I need a bracket printed','receiving_offers','open','public',2,'${FUTURE}');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES
      ('o1','r1','m1','s1',50000,'pending'), ('o2','r1','m2','s2',60000,'pending');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm) VALUES
      ('p1','m1','s1','P1S','fdm',256,256,250), ('p2','m2','s2','P1S','fdm',256,256,250);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('dep','buyer','deposit','USD',${Math.ceil((500_000 * 100) / RATE)},'approved','seed');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

type Bucket = ReturnType<typeof memoryBucket>;
const as = (raw: DatabaseSync, user: StubUser | null, bucket?: Bucket, host?: string) =>
  stubApp(asD1(raw), user, mount, { ...(bucket ? { env: { BUCKET: bucket } } : {}), ...(host ? { host } : {}) });

const sessions = (raw: DatabaseSync) => count(raw, 'SELECT COUNT(*) AS n FROM chat_staff_reads');
const audited = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.chat_read'");
const members = (raw: DatabaseSync, chatId: string) =>
  all<{ user_id: string }>(raw, 'SELECT user_id FROM chat_participants WHERE chat_id = ? ORDER BY user_id', chatId).map((r) => r.user_id);

/**
 * The world of one custom job: Omar's thread about the request (his offer
 * loses), Sara accepts Ali's offer — the board deal writes the order with
 * the request thread — Ali sends a product card there, Sara a photograph, and
 * Ali starts and delivers the work.
 */
async function deliveredJob(raw: DatabaseSync, bucket: Bucket) {
  const rival = (await json(await post(as(raw, BUYER), '/api/chats/open', { requestId: 'r1', merchantId: 'm2' }))).chatId as string;
  assert.ok(rival);
  const list = await json(await get(as(raw, BUYER), '/api/marketplace/requests/r1/offers'));
  const o = (list.offers as Array<{ id: string; price_iqd: number; revision: number }>).find((x) => x.id === 'o1')!;
  const acc = await post(as(raw, BUYER), '/api/marketplace/offers/o1/accept', { expected_price_iqd: o.price_iqd, offer_revision: o.revision });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const orderId = (await json(acc)).order.id as string;
  const chatId = row<{ chat_id: string }>(raw, 'SELECT chat_id FROM community_orders WHERE id = ?', orderId)!.chat_id;
  assert.ok(chatId, 'a board deal is written with its request thread');
  assert.equal(row<{ context_type: string }>(raw, 'SELECT context_type FROM chats WHERE id = ?', chatId)!.context_type, 'request');

  assert.equal((await post(as(raw, ALI), `/api/chats/${chatId}/messages`, { card: { type: 'product', ref: 'cp_vase' } })).status, 200);
  assert.equal((await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'Can it be black?' })).status, 200);
  const key = `chat/${chatId}/attachments/aaaa1111.webp`;
  await bucket.put(key, new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), { httpMetadata: { contentType: 'image/webp' } });
  raw.prepare(
    `INSERT INTO chat_messages (id, chat_id, sender_id, kind, body, file_key, attachment_kind, created_at)
     VALUES ('msg_photo', ?, 'buyer', 'image', '', ?, 'image', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run(chatId, key);

  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/start`)).status, 200);
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${orderId}/delivered`)).status, 200);
  const escrowId = row<{ id: string }>(raw, 'SELECT id FROM community_escrows WHERE community_order_id = ?', orderId)!.id;
  return { orderId, chatId, rival, key, escrowId };
}

async function disputed(raw: DatabaseSync, bucket: Bucket) {
  const job = await deliveredJob(raw, bucket);
  const d = await post(as(raw, BUYER), `/api/marketplace/orders/${job.orderId}/dispute`, { description: 'The bracket arrived cracked in two pieces' });
  assert.equal(d.status, 201, JSON.stringify(await json(d.clone())));
  const complaintId = (await json(d)).complaint_id as string;
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', job.orderId)!.state, 'disputed');
  return { ...job, complaintId };
}

// ===================================================================== before

test('before the dispute the door is shut: 403 EVIDENCE_NOT_LINKED for the thread, its pages and its files — nothing recorded', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { chatId, key } = await deliveredJob(raw, bucket);
  for (const path of [`/api/chats/${chatId}`, `/api/chats/${chatId}/messages`, `/files/${key}`]) {
    const r = await get(as(raw, BOSS, bucket), path);
    assert.equal(r.status, 403, path);
    assert.equal((await json(r)).code, 'EVIDENCE_NOT_LINKED', path);
  }
  assert.equal(sessions(raw), 0);
  assert.equal(audited(raw), 0);
  // A customer who is no party is refused as before — never told about a door.
  const stranger = await get(as(raw, NOUR), `/api/chats/${chatId}/messages`);
  assert.equal(stranger.status, 403);
  assert.equal((await json(stranger)).code, 'FORBIDDEN');
});

// ===================================================================== during

test('while it is disputed staff read the thread read-only: no actions on any card, nothing to send, the case named by id', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { chatId, orderId, complaintId } = await disputed(raw, bucket);
  const lastReadBefore = all(raw, 'SELECT user_id, last_read_at FROM chat_participants WHERE chat_id = ? ORDER BY user_id', chatId);

  const head = await get(as(raw, BOSS), `/api/chats/${chatId}`);
  assert.equal(head.status, 200, JSON.stringify(await json(head.clone())));
  const { chat } = await json(head);
  assert.equal(chat.read_only, true);
  assert.equal(chat.role, 'staff');
  assert.deepEqual(chat.can, { product_card: false, store_card: false, print_request: false, quote: false, custom_product: false }, 'no composer, no card menu');
  assert.deepEqual(chat.evidence, { community_order_id: orderId, order_id: null, complaint_id: complaintId, request_id: 'r1' });

  const page = await get(as(raw, BOSS), `/api/chats/${chatId}/messages`);
  assert.equal(page.status, 200);
  const body = await json(page);
  assert.equal(body.read_only, true);
  const cards = (body.messages as Array<{ card: { type: string; current: { actions: string[] } } | null }>).filter((m) => m.card);
  assert.ok(cards.some((m) => m.card!.type === 'product'), 'the product card is on the page');
  for (const m of cards) assert.deepEqual(m.card!.current.actions, [], `${m.card!.type}: staff act on nothing`);

  // Reading is not joining, and not marking anything read for the parties.
  assert.deepEqual(members(raw, chatId), ['buyer', 'owner']);
  assert.deepEqual(all(raw, 'SELECT user_id, last_read_at FROM chat_participants WHERE chat_id = ? ORDER BY user_id', chatId), lastReadBefore);

  // The same product card still offers the customer its door: the flag is the viewer's.
  const mine = await json(await get(as(raw, BUYER), `/api/chats/${chatId}/messages`));
  const vase = (mine.messages as Array<{ card: { type: string; current: { actions: string[] } } | null }>).find((m) => m.card?.type === 'product');
  assert.ok(vase!.card!.current.actions.length > 0);
});

test('every read SESSION is on the record once — the header, the pages and the files share it; another admin, or later, is another', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { chatId, key, orderId, complaintId } = await disputed(raw, bucket);

  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}`)).status, 200);
  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}/messages`)).status, 200);
  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}/messages?limit=1`)).status, 200);
  const older = (await json(await get(as(raw, BOSS), `/api/chats/${chatId}/messages?limit=1`))).older_cursor as string;
  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}/messages?limit=1&before=${encodeURIComponent(older)}`)).status, 200);
  const file = await get(as(raw, BOSS, bucket), `/files/${key}`);
  assert.equal(file.status, 200, 'the thread\'s file opens through the same door');
  assert.equal(sessions(raw), 1, 'one session, not one row per poll or page');
  assert.equal(audited(raw), 1);
  assert.deepEqual(
    row(raw, 'SELECT chat_id, admin_id, complaint_id, community_order_id FROM chat_staff_reads'),
    { chat_id: chatId, admin_id: 'boss', complaint_id: complaintId, community_order_id: orderId }
  );
  const audit = row<{ actor_id: string; target: string; detail: string }>(raw, "SELECT actor_id, target, detail FROM audit_log WHERE action = 'admin.chat_read'")!;
  assert.equal(audit.actor_id, 'boss');
  assert.equal(audit.target, chatId);
  assert.deepEqual(JSON.parse(audit.detail), { read_only: true, evidence: true, community_order: orderId, order: null, complaint: complaintId });

  // A second admin is a second session; the first one's is still open.
  assert.equal((await get(as(raw, DESK), `/api/chats/${chatId}/messages`)).status, 200);
  assert.equal(sessions(raw), 2);
  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}/messages`)).status, 200);
  assert.equal(sessions(raw), 2);
  // Half an hour on, the same admin's next look opens a new one.
  raw.prepare("UPDATE chat_staff_reads SET created_at = ? WHERE admin_id = 'boss'").run(new Date(Date.now() - 31 * 60_000).toISOString());
  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}/messages`)).status, 200);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM chat_staff_reads WHERE admin_id = 'boss'"), 2);
  assert.equal(audited(raw), 3);
});

test('no staff write path: every door that writes into the thread refuses them, and nothing lands', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { chatId } = await disputed(raw, bucket);
  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}/messages`)).status, 200, 'staff can read it now');
  const writes: Array<[string, unknown]> = [
    [`/api/chats/${chatId}/messages`, { body: 'Staff here' }],
    [`/api/chats/${chatId}/messages`, { card: { type: 'product', ref: 'cp_vase' } }],
    [`/api/chats/${chatId}/typing`, { typing: true }],
    [`/api/chats/${chatId}/cards/link`, { url: 'https://www.printables.com/model/1' }],
    [`/api/chats/${chatId}/quotes`, { request_id: 'r1', price_iqd: 1000, completion_days: 1 }],
    [`/api/chats/${chatId}/custom-products`, { name: 'Staff price', price_iqd: 1 }],
    [`/api/chats/${chatId}/print-requests`, {}],
  ];
  for (const [path, body] of writes) {
    const r = await post(as(raw, BOSS), path, body);
    assert.equal(r.status, 403, `${path} ${JSON.stringify(body)} → ${r.status}`);
  }
  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}/products`)).status, 403, 'the picker is a write door');
  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}/typing`)).status, 403);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM chat_messages WHERE sender_id = 'boss'"), 0);
  assert.deepEqual(members(raw, chatId), ['buyer', 'owner'], 'and staff never joined');
});

test('the evidence rows never expose a key or a message', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { chatId, key } = await disputed(raw, bucket);
  const page = await json(await get(as(raw, BOSS), `/api/chats/${chatId}/messages`));
  assert.equal((await get(as(raw, BOSS, bucket), `/files/${key}`)).status, 200);
  const text = JSON.stringify(page);
  for (const field of ['"file_key"', '"client_id"', '"card_event_key"', '"card_ref_key"']) assert.ok(!text.includes(field), `${field} is not on a staff page`);
  const photo = (page.messages as Array<{ id: string; fileUrl: string | null }>).find((m) => m.id === 'msg_photo')!;
  assert.equal(photo.fileUrl, `/files/${key}`, 'a file is an address on the Worker, served through the audited door');

  const cols = (raw.prepare('PRAGMA table_info(chat_staff_reads)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols, ['id', 'chat_id', 'admin_id', 'complaint_id', 'community_order_id', 'created_at']);
  for (const r of all<Record<string, unknown>>(raw, 'SELECT * FROM chat_staff_reads')) {
    assert.ok(!JSON.stringify(r).includes('chat/'), 'no storage key in a session row');
  }
  for (const r of all<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'admin.chat_read'")) {
    assert.ok(!r.detail.includes(key) && !r.detail.includes('Can it be black'), 'no key, no message text in the audit row');
  }
});

test('a thread NOT linked to the disputed order stays shut during it: the customer\'s DM with the store, a rival workshop\'s request thread', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { rival } = await disputed(raw, bucket);
  const dm = (await json(await post(as(raw, BUYER), '/api/chats/open', { merchantId: 'm1' }))).chatId as string;
  assert.equal(row<{ context_type: string }>(raw, 'SELECT context_type FROM chats WHERE id = ?', dm)!.context_type, 'store');
  await post(as(raw, BUYER), `/api/chats/${dm}/messages`, { body: 'Unrelated question' });
  for (const chatId of [dm, rival]) {
    for (const path of [`/api/chats/${chatId}`, `/api/chats/${chatId}/messages`]) {
      const r = await get(as(raw, BOSS), path);
      assert.equal(r.status, 403, path);
      assert.equal((await json(r)).code, 'EVIDENCE_NOT_LINKED', path);
    }
  }
  assert.equal(sessions(raw), 0);
});

test('only a platform admin on the admin host, never a customer: the evidence door is the desk\'s own bar', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { chatId } = await disputed(raw, bucket);
  const stranger = await get(as(raw, NOUR), `/api/chats/${chatId}/messages`);
  assert.equal(stranger.status, 403);
  assert.equal((await json(stranger)).code, 'FORBIDDEN');
  const rivalMerchant = await get(as(raw, OMAR), `/api/chats/${chatId}`);
  assert.equal(rivalMerchant.status, 403);
  const onStoreHost = await get(as(raw, BOSS, undefined, MERCHANT_HOST), `/api/chats/${chatId}/messages`);
  assert.equal(onStoreHost.status, 403);
  assert.equal((await json(onStoreHost)).code, 'FORBIDDEN', 'an admin session on a store\'s host is no staff reader');
  assert.equal(sessions(raw), 0);
});

// ====================================================================== desk

test('the dispute desk links «المحادثة» and «الطلب» on the list and on the case', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { chatId, complaintId } = await disputed(raw, bucket);
  const list = await json(await get(as(raw, BOSS), '/api/admin/community/complaints'));
  const c = (list.complaints as Array<{ id: string; chat_id: string | null; request_id: string | null }>).find((x) => x.id === complaintId)!;
  assert.equal(c.chat_id, chatId);
  assert.equal(c.request_id, 'r1');
  const one = await json(await get(as(raw, BOSS), `/api/admin/community/complaints/${complaintId}`));
  assert.equal(one.complaint.chat_id, chatId);
  assert.equal(one.complaint.request_id, 'r1');
});

// ===================================================================== after

test('the door closes the moment the decision lands: 403 EVIDENCE_CLOSED for the thread and its files', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const { chatId, key, escrowId, orderId } = await disputed(raw, bucket);
  assert.equal((await get(as(raw, BOSS), `/api/chats/${chatId}/messages`)).status, 200);
  const decided = await post(as(raw, BOSS), `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'release', reason: 'the work was fine' });
  assert.equal(decided.status, 200, JSON.stringify(await json(decided.clone())));
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)!.state, 'completed');
  for (const path of [`/api/chats/${chatId}`, `/api/chats/${chatId}/messages`, `/files/${key}`]) {
    const r = await get(as(raw, BOSS, bucket), path);
    assert.equal(r.status, 403, path);
    assert.equal((await json(r)).code, 'EVIDENCE_CLOSED', path);
  }
  assert.equal(sessions(raw), 1, 'the refusals record nothing');
  // The parties still read their own conversation.
  assert.equal((await get(as(raw, BUYER), `/api/chats/${chatId}/messages`)).status, 200);
  assert.equal((await get(as(raw, BUYER, bucket), `/files/${key}`)).status, 200);
});

// ================================================================ store orders

test('a store order bought from a thread opens the same door while its complaint is open, and shuts it when decided', async () => {
  const raw = seed();
  const dm = (await json(await post(as(raw, BUYER), '/api/chats/open', { merchantId: 'm1' }))).chatId as string;
  await post(as(raw, BUYER), `/api/chats/${dm}/messages`, { body: 'Is the vase in stock?' });
  await post(as(raw, ALI), `/api/chats/${dm}/messages`, { body: 'Yes, ready to ship' });
  raw.exec(`
    INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd,origin_chat_id)
      VALUES ('ord1','buyer','delivered',25000,'m1','s1','merchant','store_product','{}','d','{}','wallet',25000,${RATE},0,'${dm}');
  `);
  const shut = await get(as(raw, BOSS), `/api/chats/${dm}/messages`);
  assert.equal((await json(shut)).code, 'EVIDENCE_NOT_LINKED', 'a purchase alone opens nothing');

  raw.exec(`INSERT INTO community_complaints (id, reporter_id, merchant_id, store_id, order_id, category, description, status)
              VALUES ('cc1', 'buyer', 'm1', 's1', 'ord1', 'order', 'The vase came broken', 'submitted')`);
  const open = await get(as(raw, BOSS), `/api/chats/${dm}`);
  assert.equal(open.status, 200);
  assert.deepEqual((await json(open)).chat.evidence, { community_order_id: null, order_id: 'ord1', complaint_id: 'cc1', request_id: null });
  assert.equal(row<{ complaint_id: string }>(raw, 'SELECT complaint_id FROM chat_staff_reads')!.complaint_id, 'cc1');
  const desk = await json(await get(as(raw, BOSS), '/api/admin/community/complaints'));
  assert.equal((desk.complaints as Array<{ id: string; chat_id: string }>).find((c) => c.id === 'cc1')!.chat_id, dm);

  assert.equal((await post(as(raw, BOSS), '/api/admin/community/complaints/cc1/status', { status: 'resolved', resolution: 'refunded' })).status, 200);
  const closed = await get(as(raw, BOSS), `/api/chats/${dm}/messages`);
  assert.equal(closed.status, 403);
  assert.equal((await json(closed)).code, 'EVIDENCE_CLOSED');
});

// ===================================================================== pure

test('the verdict: a disputed order wins, an open store-order complaint opens, decided complaints close, anything else is not linked', () => {
  const none = evidenceVerdict([], [], []);
  assert.equal(none.state, 'none');
  // Ordered, never disputed: not linked.
  assert.equal(evidenceVerdict([{ id: 'co1', state: 'in_progress', request_id: 'r1' }], [], []).state, 'none');
  // Disputed: open, with the open complaint named over an older decided one.
  const open = evidenceVerdict(
    [{ id: 'co1', state: 'disputed', request_id: 'r1' }],
    [],
    [
      { id: 'k2', status: 'under_review', community_order_id: 'co1', order_id: null },
      { id: 'k1', status: 'rejected', community_order_id: 'co1', order_id: null },
    ]
  );
  assert.deepEqual(open, { state: 'open', community_order_id: 'co1', order_id: null, complaint_id: 'k2', request_id: 'r1' });
  // Decided: closed.
  const closed = evidenceVerdict([{ id: 'co1', state: 'completed', request_id: 'r1' }], [], [{ id: 'k1', status: 'resolved', community_order_id: 'co1', order_id: null }]);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.complaint_id, 'k1');
  // A community order's complaint that is open while the order is NOT disputed is no evidence door.
  assert.equal(evidenceVerdict([{ id: 'co1', state: 'in_progress', request_id: 'r1' }], [], [{ id: 'k1', status: 'submitted', community_order_id: 'co1', order_id: null }]).state, 'none');
  // A store order bought here, its complaint open: open; decided: closed.
  assert.equal(evidenceVerdict([], ['ord1'], [{ id: 'k3', status: 'waiting_merchant', community_order_id: null, order_id: 'ord1' }]).state, 'open');
  assert.equal(evidenceVerdict([], ['ord1'], [{ id: 'k3', status: 'closed', community_order_id: null, order_id: 'ord1' }]).state, 'closed');
});
