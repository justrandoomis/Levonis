/**
 * ONE PLACE TO ANSWER A CUSTOMER — the server half of the support console.
 *
 * «في لوحة الإدارة لا يوجد صفحة للرد على رسائل المستخدمين ولا على الشكاوى ولا
 * على التذاكر». Three kinds of waiting customer, and before this round only
 * one of them had a queue:
 *
 *   • ORDER MESSAGES — «محادثة مباشرة مع الفريق» put the customer in a thread
 *     with nobody. These tests pin the inbox that lists those threads, the
 *     team-level unread count, and the «‼️ Support» line a customer message
 *     now sends (once per burst, never for staff, never for a seller's order).
 *   • COMPLAINTS — answerable by an admin, readable by nobody: the reporter
 *     had no thread. These pin the reporter's own routes, that an internal
 *     note never reaches them, that both sides can attach a file, and that the
 *     `complaints/` file gate asks the right question.
 *   • TICKETS — plus the three ticket defects the audit found: a retried
 *     confirmation made two tickets, a second-hand holder could not open one
 *     from their printer, and a hand-built attachment key was accepted.
 *
 * Real migrations, real routes, real R2-shaped adapter; only the session and
 * the buckets are stubbed.
 *
 * Run: node --import tsx --test tests/supportConsole.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, ctx, freshDb, json, pending, post, row, stubApp, type StubUser } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { adminChatRoutes } from '../worker/routes/adminChats';
import { supportRoutes } from '../worker/routes/support';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { adminRoutes } from '../worker/routes/admin';
import { fileRoutes, uploadRoutes } from '../worker/routes/uploads';
import { notifyComplaintReply, notifySupportReply } from '../worker/lib/engagementNotify';
import type { Env } from '../worker/lib/types';

// ------------------------------------------------------------------ fixture

class MemoryBucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: Record<string, string> }) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value.slice(0))
        : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { bytes, metadata: options?.httpMetadata ?? {} });
  }
  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: new Blob([stored.bytes as unknown as BlobPart]).stream(),
      size: stored.bytes.byteLength,
      httpEtag: `"${key}"`,
      writeHttpMetadata(headers: Headers) {
        if (stored.metadata.contentType) headers.set('Content-Type', stored.metadata.contentType);
      },
    };
  }
  async head(key: string) {
    const stored = this.objects.get(key);
    return stored ? { key, size: stored.bytes.byteLength, httpEtag: `"${key}"` } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function webp(): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12);
  b.set([0x7f, 0x02, 0x00], 24);
  b.set([0xdf, 0x01, 0x00], 27);
  return b;
}
const IMAGES = {
  async info() {
    return { format: 'image/webp', fileSize: 30, width: 640, height: 480 };
  },
  input() {
    return { async output() { return { response: () => new Response(webp()) }; } };
  },
};

const ADMIN: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'b@x.co' };
const OTHER: StubUser = { id: 'other', role: 'customer', email: 'o@x.co' };
const HOLDER: StubUser = { id: 'holder', role: 'customer', email: 'h@x.co' };

const GROUP = '-1001234567890';
const THREADS: Record<string, number> = { support: 55, report: 33, warranty: 66, general: 1 };

function bindGroup(raw: DatabaseSync): void {
  raw
    .prepare(
      `INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg)
       VALUES ('singleton', ?, 'Levonis', 'boss', 1)`
    )
    .run(GROUP);
  for (const [key, thread] of Object.entries(THREADS)) {
    raw
      .prepare(
        `INSERT INTO telegram_admin_topics (topic_key, message_thread_id, enabled, configured_by, configured_by_tg)
         VALUES (?, ?, 1, 'boss', 1)`
      )
      .run(key, thread);
  }
}

interface Sent { chat_id: string; message_thread_id?: number; text: string }
function stubTelegram(): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('api.telegram.org')) return real(url as never, init as never);
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Sent);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

async function drain(): Promise<void> {
  while (pending.length) await Promise.all(pending.splice(0, pending.length));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * `telegram: true` gives the deployment an admin bot. Only tests that bind a
 * group AND stub `fetch` ask for it: without the stub a bot token would let an
 * announcement try the real network from a unit test.
 */
function world(opts: { telegram?: boolean } = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Ali','boss@x.co','h','admin'),
      ('boss2','Zaid','boss2@x.co','h','admin'),
      ('buyer','Sara','b@x.co','h','customer'),
      ('other','Omar','o@x.co','h','customer'),
      ('seller','Noor','s@x.co','h','customer'),
      ('holder','Huda','h@x.co','h','customer');
    INSERT INTO community_merchants (id, user_id, name) VALUES ('m1','seller','Noor Prints');
  `);
  const order = (id: string, user: string, merchant: string | null) =>
    raw
      .prepare(
        `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                             subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,merchant_id)
         VALUES (?,?, 'pending','{}','standard','{}','cash',1000,0,1400,1000,1000,?)`
      )
      .run(id, user, merchant);
  order('ORD-A', 'buyer', null);
  order('ORD-B', 'buyer', null);
  order('ORD-M', 'buyer', 'm1');
  const buckets = { priv: new MemoryBucket(), pub: new MemoryBucket() };
  const env = {
    BUCKET: buckets.priv,
    R2_PRIVATE: buckets.priv,
    R2_PUBLIC: buckets.pub,
    IMAGES,
    ...(opts.telegram ? { TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN' } : {}),
  };
  const app = (user: StubUser | null) =>
    stubApp(
      asD1(raw),
      user,
      (a) => {
        a.route('/api/chats', chatRoutes);
        a.route('/api/admin/chats', adminChatRoutes);
        a.route('/api/admin/community', adminCommunityRoutes);
        a.route('/api/admin', adminRoutes);
        a.route('/api/support', supportRoutes);
        a.route('/api/marketplace', marketplaceRoutes);
        a.route('/api/uploads', uploadRoutes);
        a.route('/files', fileRoutes);
      },
      { env }
    );
  return { raw, app, buckets };
}

const get = (a: ReturnType<ReturnType<typeof world>['app']>, path: string, headers: Record<string, string> = {}) =>
  a.request(path, { headers: { 'CF-Connecting-IP': '1.2.3.4', ...headers } }, undefined, ctx);

async function upload(a: ReturnType<ReturnType<typeof world>['app']>, purpose: string, entityId: string) {
  const form = new FormData();
  form.set('purpose', purpose);
  form.set('entity_id', entityId);
  form.set('file', new File([webp() as unknown as BlobPart], 'evidence.webp', { type: 'image/webp' }));
  return a.request('/api/uploads', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
}

/** Opens the order thread as `user` and returns its id. */
async function openOrderChat(a: ReturnType<ReturnType<typeof world>['app']>, orderId: string): Promise<string> {
  const res = await post(a, '/api/chats/open', { orderId });
  assert.equal(res.status, 200, await res.clone().text());
  return (await json(res)).chatId as string;
}

const tick = () => new Promise((r) => setTimeout(r, 3));

// ======================================================= «الرسائل» — the inbox

test('MESSAGES — a customer line on the shop’s order thread is in the admin inbox, unread, with the customer named', async () => {
  const w = world();
  const buyer = w.app(BUYER);
  const chatId = await openOrderChat(buyer, 'ORD-A');
  assert.equal((await post(buyer, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'Which colour did you send?' })).status, 200);
  await tick();
  assert.equal((await post(buyer, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'Also the nozzle?' })).status, 200);

  const res = await get(w.app(ADMIN), '/api/admin/chats');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.chats.length, 1);
  const c = body.chats[0];
  assert.equal(c.order_id, 'ORD-A');
  assert.equal(c.unread, 2, 'nobody on the team has touched it: every customer line is waiting');
  assert.equal(c.customer.name, 'Sara');
  assert.equal(c.last_message.body, 'Also the nozzle?');
  assert.equal(c.last_message.from_customer, true);
});

test('MESSAGES — a staff reply clears the count, and a later customer line makes it one again', async () => {
  const w = world();
  const buyer = w.app(BUYER);
  const admin = w.app(ADMIN);
  const chatId = await openOrderChat(buyer, 'ORD-A');
  await post(buyer, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'hello?' });
  await tick();
  // The admin joins through the same door the order modal and the console use.
  assert.equal(await openOrderChat(admin, 'ORD-A'), chatId);
  await post(admin, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'Hi Sara — checking now.' });
  let c = (await json(await get(admin, '/api/admin/chats'))).chats[0];
  assert.equal(c.unread, 0, 'answered');
  await tick();
  await post(buyer, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'thanks!' });
  c = (await json(await get(admin, '/api/admin/chats'))).chats[0];
  assert.equal(c.unread, 1);
});

test('MESSAGES — reading the thread clears it for the whole TEAM, not just the admin who opened it', async () => {
  const w = world();
  const buyer = w.app(BUYER);
  const chatId = await openOrderChat(buyer, 'ORD-A');
  await post(buyer, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'hello?' });
  await tick();
  const boss = w.app(ADMIN);
  await openOrderChat(boss, 'ORD-A');
  // OrderChatPanel's read — it stamps this admin's last_read_at.
  assert.equal((await get(boss, `/api/chats/${chatId}/messages`)).status, 200);
  const other = w.app({ id: 'boss2', role: 'admin', email: 'boss2@x.co' });
  const c = (await json(await get(other, '/api/admin/chats'))).chats[0];
  assert.equal(c.unread, 0, 'a second agent is not told a thread is waiting when a colleague has read it');
});

test('MESSAGES — a seller’s order thread and an empty thread are not in the shop’s inbox; waiting threads sort first', async () => {
  const w = world();
  const buyer = w.app(BUYER);
  const admin = w.app(ADMIN);
  // B: answered long ago.
  const b = await openOrderChat(buyer, 'ORD-B');
  await post(buyer, `/api/chats/${b}/messages`, { kind: 'text', body: 'first' });
  await tick();
  await openOrderChat(admin, 'ORD-B');
  await post(admin, `/api/chats/${b}/messages`, { kind: 'text', body: 'answered' });
  await tick();
  // A: waiting.
  const a = await openOrderChat(buyer, 'ORD-A');
  await post(buyer, `/api/chats/${a}/messages`, { kind: 'text', body: 'waiting' });
  await tick();
  // B gets a staff line last so it is the most RECENT thread — and still sorts
  // after the waiting one.
  await post(admin, `/api/chats/${b}/messages`, { kind: 'text', body: 'anything else?' });
  // M: a merchant-store order — the seller's conversation, not the shop's.
  const m = await openOrderChat(buyer, 'ORD-M');
  await post(buyer, `/api/chats/${m}/messages`, { kind: 'text', body: 'to the seller' });

  const rows = (await json(await get(admin, '/api/admin/chats'))).chats as Array<{ order_id: string; unread: number }>;
  assert.deepEqual(rows.map((r) => r.order_id), ['ORD-A', 'ORD-B'], 'waiting first; no seller thread');
  const unread = (await json(await get(admin, '/api/admin/chats?filter=unread'))).chats as Array<{ order_id: string }>;
  assert.deepEqual(unread.map((r) => r.order_id), ['ORD-A']);
});

test('MESSAGES — the inbox and the counts are staff-only', async () => {
  const w = world();
  assert.equal((await get(w.app(BUYER), '/api/admin/chats')).status, 403);
  assert.equal((await get(w.app(BUYER), '/api/admin/chats/summary')).status, 403);
});

test('COUNTS — one summary for the badge, the tabs and the dashboard tile, and they agree', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO support_tickets (id,user_id,subject,state) VALUES
      ('t1','buyer','a','open'), ('t2','buyer','b','waiting_staff'), ('t3','buyer','c','waiting_customer');
    INSERT INTO community_complaints (id, reporter_id, category, description, status) VALUES
      ('c1','buyer','quality','x','submitted'), ('c2','buyer','quality','y','under_review'),
      ('c3','buyer','quality','z','waiting_customer'), ('c4','buyer','quality','w','resolved');
  `);
  const buyer = w.app(BUYER);
  const chatId = await openOrderChat(buyer, 'ORD-A');
  await post(buyer, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'hi' });

  const summary = await json(await get(w.app(ADMIN), '/api/admin/chats/summary'));
  assert.equal(summary.tickets_waiting, 2);
  assert.equal(summary.chats_unread, 1);
  assert.equal(summary.complaints_open, 2, 'submitted + under_review: the ball is on the desk');

  const overview = await json(await get(w.app(ADMIN), '/api/admin/overview'));
  assert.equal(overview.stats.support_tickets_waiting, 2);
  assert.equal(overview.stats.support_chats_unread, 1);
  assert.equal(overview.stats.support_complaints_open, 2);
});

test('MESSAGES — «‼️ Support» hears a customer write, once per burst, and never staff or a seller’s thread', async () => {
  const w = world({ telegram: true });
  bindGroup(w.raw);
  const tg = stubTelegram();
  try {
    const buyer = w.app(BUYER);
    const admin = w.app(ADMIN);
    const chatId = await openOrderChat(buyer, 'ORD-A');
    await post(buyer, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'my home address is 12 Karrada st' });
    await drain();
    assert.equal(tg.sent.length, 1);
    assert.equal(tg.sent[0].message_thread_id, THREADS.support);
    assert.match(tg.sent[0].text, /ORD-A/);
    assert.doesNotMatch(tg.sent[0].text, /Karrada|Sara|b@x\.co/, 'no text, no name, no email in a group chat');

    await tick();
    await post(buyer, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'second line' });
    await drain();
    assert.equal(tg.sent.length, 1, 'a second line in a row is the same conversation waiting');

    await openOrderChat(admin, 'ORD-A');
    await tick();
    await post(admin, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'on it' });
    await drain();
    assert.equal(tg.sent.length, 1, 'staff replying does not announce itself to staff');

    await tick();
    await post(buyer, `/api/chats/${chatId}/messages`, { kind: 'text', body: 'thanks' });
    await drain();
    assert.equal(tg.sent.length, 2, 'after an answer, the customer writing again is news');

    const m = await openOrderChat(buyer, 'ORD-M');
    await post(buyer, `/api/chats/${m}/messages`, { kind: 'text', body: 'to the seller' });
    await drain();
    assert.equal(tg.sent.length, 2, 'a seller’s order thread is not the shop’s desk');
  } finally {
    tg.restore();
  }
});

// ============================================================ tickets

test('TICKET — one confirmation, one ticket: a retried POST with the same key is a replay, not a second ticket', async () => {
  const w = world({ telegram: true });
  bindGroup(w.raw);
  const tg = stubTelegram();
  try {
    const buyer = w.app(BUYER);
    const body = { confirm: true, subject: 'Printer noise', body: 'It clicks loudly', idempotencyKey: 'key-0123456789' };
    const first = await post(buyer, '/api/support/tickets', body);
    assert.equal(first.status, 200, await first.clone().text());
    const second = await post(buyer, '/api/support/tickets', body);
    assert.equal(second.status, 200);
    const a = await json(first);
    const b = await json(second);
    assert.equal(a.ticket.id, b.ticket.id);
    assert.equal(b.replay, true);
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = 'buyer'"), 1);
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM support_ticket_messages WHERE ticket_id = ?', a.ticket.id), 1, 'nor a second copy of the first message');
    await drain();
    assert.equal(tg.sent.length, 1, 'and the group hears about it once');

    // Another account with the SAME key is another ticket.
    const theirs = await json(await post(w.app(OTHER), '/api/support/tickets', body));
    assert.notEqual(theirs.ticket.id, a.ticket.id);
    // A new confirm step is a new key, and a genuinely new ticket.
    const again = await json(await post(buyer, '/api/support/tickets', { ...body, idempotencyKey: 'key-9876543210' }));
    assert.notEqual(again.ticket.id, a.ticket.id);
    // A page on the old bundle sends no key and keeps the old behaviour.
    const { idempotencyKey: _drop, ...noKey } = body;
    void _drop;
    await post(buyer, '/api/support/tickets', noKey);
    await post(buyer, '/api/support/tickets', noKey);
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = 'buyer'"), 4);
  } finally {
    tg.restore();
  }
});

function seedUnit(raw: DatabaseSync, registration: { user: string; revoked?: boolean } | null) {
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types)
      VALUES ('p1','p1','Printer',500000,'active',5,'BASE','direct_sale','["direct_sale"]');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_1','ORD-A','p1','Printer','',1,500000,500000);
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_end_at)
      VALUES ('oiu_1','ORD-A','oi_1','p1','buyer',1,'2026-09-18T00:00:00.000Z','2027-09-18T00:00:00.000Z');
  `);
  if (registration) {
    raw
      .prepare('INSERT INTO device_registrations (unit_id, user_id, revoked_at) VALUES (?, ?, ?)')
      .run('oiu_1', registration.user, registration.revoked ? '2026-09-20T00:00:00.000Z' : null);
  }
}

test('TICKET — «تواصل مع الدعم» works for the person who holds a second-hand printer, not only its buyer', async () => {
  const w = world();
  seedUnit(w.raw, { user: 'holder' });
  const body = { confirm: true, subject: 'Bed not heating', body: 'It stays cold', unit_id: 'oiu_1' };
  const res = await post(w.app(HOLDER), '/api/support/tickets', body);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await json(res)).ticket.unit_id, 'oiu_1');
  // The buyer still may; a stranger may not.
  assert.equal((await post(w.app(BUYER), '/api/support/tickets', body)).status, 200);
  const stranger = await post(w.app(OTHER), '/api/support/tickets', body);
  assert.equal(stranger.status, 400);
  assert.equal((await json(stranger)).code, 'UNIT_NOT_FOUND');
});

test('TICKET — a revoked registration is history, not a holder', async () => {
  const w = world();
  seedUnit(w.raw, { user: 'holder', revoked: true });
  const res = await post(w.app(HOLDER), '/api/support/tickets', { confirm: true, subject: 'Bed', body: 'It stays cold', unit_id: 'oiu_1' });
  assert.equal(res.status, 400);
});

test('TICKET — an attachment key that was never uploaded is refused on both doors, before anything is written', async () => {
  const w = world();
  w.raw.exec("INSERT INTO support_tickets (id,user_id,subject) VALUES ('tkt_x','buyer','Broken');");
  const ghost = 'support/tkt_x/attachments/never-uploaded.webp';
  const mine = await post(w.app(BUYER), '/api/support/tickets/tkt_x/messages', { fileKey: ghost });
  assert.equal(mine.status, 400);
  assert.equal((await json(mine)).code, 'ATTACHMENT_NOT_FOUND');
  const staff = await post(w.app(ADMIN), '/api/support/admin/tickets/tkt_x/messages', { fileKey: ghost });
  assert.equal(staff.status, 400);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM support_ticket_messages WHERE ticket_id = 'tkt_x'"), 0);

  // The same key, actually uploaded, is accepted.
  const up = await json(await upload(w.app(BUYER), 'support', 'tkt_x'));
  const ok = await post(w.app(BUYER), '/api/support/tickets/tkt_x/messages', { fileKey: up.key });
  assert.equal(ok.status, 200, await ok.clone().text());
});

test('TICKET — the reply notification opens the ticket, not the assistant', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO support_tickets (id,user_id,subject) VALUES ('tkt_n','buyer','Where');
    INSERT INTO support_ticket_messages (id,ticket_id,sender_id,is_staff,body) VALUES ('tkm_n','tkt_n','boss',1,'here');
  `);
  await notifySupportReply({ DB: asD1(w.raw) } as unknown as Env, 'tkt_n', 'tkm_n');
  const n = row<{ link: string }>(w.raw, "SELECT link FROM user_notifications WHERE kind = 'support_reply'");
  assert.equal(n?.link, '/support?tab=tickets&ticket=tkt_n');
});

// ========================================================= complaints

function seedComplaints(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO community_complaints (id, reporter_id, merchant_id, category, description, status) VALUES
      ('ct1','buyer','m1','quality','The print arrived cracked','waiting_customer'),
      ('ct2','other',NULL,'conduct','Rude reply','submitted');
    INSERT INTO community_complaint_messages (id, complaint_id, sender_id, sender_role, body, internal, created_at) VALUES
      ('cm1','ct1','boss','admin','Can you send a photo?',0,'2026-09-20T10:00:00.000Z'),
      ('cm2','ct1','boss','admin','Merchant has two prior strikes',1,'2026-09-20T10:01:00.000Z');
  `);
}

test('COMPLAINT — the reporter can read their own thread, and an internal note is never in it', async () => {
  const w = world();
  seedComplaints(w.raw);
  const list = await json(await get(w.app(BUYER), '/api/marketplace/complaints'));
  assert.deepEqual(list.complaints.map((c: { id: string }) => c.id), ['ct1'], 'only their own');
  assert.equal(list.complaints[0].message_count, 1, 'the note is not counted either');
  assert.equal(list.complaints[0].merchant_name, 'Noor Prints');

  const d = await json(await get(w.app(BUYER), '/api/marketplace/complaints/ct1'));
  assert.equal(d.complaint.description, 'The print arrived cracked');
  assert.deepEqual(d.messages.map((m: { body: string }) => m.body), ['Can you send a photo?']);
  assert.equal(d.messages[0].is_staff, true);
  assert.equal(JSON.stringify(d).includes('two prior strikes'), false);
  assert.equal(JSON.stringify(d).includes('sender_id'), false, 'staff identity stays internal');

  assert.equal((await get(w.app(OTHER), '/api/marketplace/complaints/ct1')).status, 404, 'not theirs reads as not there');
  assert.equal((await get(w.app(null), '/api/marketplace/complaints')).status, 401);
});

test('COMPLAINT — the reporter answers back; the ball returns to the desk, and the desk is told once', async () => {
  const w = world({ telegram: true });
  seedComplaints(w.raw);
  bindGroup(w.raw);
  const tg = stubTelegram();
  try {
    const buyer = w.app(BUYER);
    const res = await post(buyer, '/api/marketplace/complaints/ct1/messages', { body: 'Here it is — the corner is snapped.' });
    assert.equal(res.status, 200, await res.clone().text());
    const b = await json(res);
    assert.equal(b.message.mine, true);
    assert.equal(b.message.is_staff, false);
    assert.equal(b.status, 'under_review', '«بانتظار العميل» is no longer true');
    const stored = row<{ sender_role: string; internal: number; created_at: string }>(
      w.raw,
      'SELECT sender_role, internal, created_at FROM community_complaint_messages WHERE id = ?',
      b.message.id
    );
    assert.equal(stored?.sender_role, 'user');
    assert.equal(stored?.internal, 0);
    assert.equal(stored?.created_at, b.message.created_at, 'the row the client appends is the row that was written');
    assert.equal(row<{ status: string }>(w.raw, "SELECT status FROM community_complaints WHERE id = 'ct1'")?.status, 'under_review');

    await drain();
    assert.equal(tg.sent.length, 1);
    assert.equal(tg.sent[0].message_thread_id, THREADS.report);
    assert.match(tg.sent[0].text, /ct1/);
    assert.doesNotMatch(tg.sent[0].text, /corner is snapped/, 'the text stays on the site');

    await tick();
    await post(buyer, '/api/marketplace/complaints/ct1/messages', { body: 'and the box was wet' });
    await drain();
    assert.equal(tg.sent.length, 1, 'a second line in a row says nothing new');

    assert.equal((await post(buyer, '/api/marketplace/complaints/ct1/messages', { body: '  ' })).status, 400);
    assert.equal((await post(w.app(OTHER), '/api/marketplace/complaints/ct1/messages', { body: 'hi' })).status, 404);
  } finally {
    tg.restore();
  }
});

test('COMPLAINT — both sides can send a photo, filed under the complaint and read through the right gate', async () => {
  const w = world();
  seedComplaints(w.raw);
  const buyer = w.app(BUYER);
  const admin = w.app(ADMIN);

  // The reporter uploads to their own complaint; a stranger cannot name it.
  const upRes = await upload(buyer, 'complaint', 'ct1');
  assert.equal(upRes.status, 200, await upRes.clone().text());
  const up = await json(upRes);
  assert.match(up.key, /^complaints\/ct1\/attachments\//);
  assert.equal((await upload(w.app(OTHER), 'complaint', 'ct1')).status, 403);

  const sent = await json(await post(buyer, '/api/marketplace/complaints/ct1/messages', { fileKey: up.key }));
  assert.equal(sent.message.kind, 'image');
  assert.equal(sent.message.file_url, `/files/${up.key}`);
  assert.equal(JSON.stringify(sent).includes('"file_key"'), false, 'the key never ships to the customer');

  // A key from another complaint, or one never uploaded, is refused.
  assert.equal((await post(buyer, '/api/marketplace/complaints/ct1/messages', { fileKey: 'complaints/ct2/attachments/x.webp' })).status, 400);
  assert.equal((await post(buyer, '/api/marketplace/complaints/ct1/messages', { fileKey: 'complaints/ct1/attachments/ghost.webp' })).status, 400);

  // The desk answers with a picture too, and sees the customer's.
  const staffUp = await json(await upload(admin, 'complaint', 'ct1'));
  const reply = await post(admin, '/api/admin/community/complaints/ct1/messages', { body: '', fileKey: staffUp.key, internal: false });
  assert.equal(reply.status, 200, await reply.clone().text());
  const replied = await json(reply);
  assert.equal(replied.message.file_key, staffUp.key);
  assert.equal(replied.message.kind, 'image');
  const detail = await json(await get(admin, '/api/admin/community/complaints/ct1'));
  assert.ok(detail.messages.some((m: { file_url: string | null }) => m.file_url === `/files/${up.key}`));

  // The files gate: the reporter reads the thread's files, a stranger does not.
  assert.equal((await get(buyer, `/files/${staffUp.key}`)).status, 200);
  assert.equal((await get(w.app(OTHER), `/files/${up.key}`)).status, 403);
  assert.equal((await get(admin, `/files/${up.key}`)).status, 200);

  // A file attached to an INTERNAL note is staff-only, even to the reporter.
  const noteUp = await json(await upload(admin, 'complaint', 'ct1'));
  await post(admin, '/api/admin/community/complaints/ct1/messages', { body: 'for us', fileKey: noteUp.key, internal: true });
  assert.equal((await get(buyer, `/files/${noteUp.key}`)).status, 403);
  assert.equal((await get(admin, `/files/${noteUp.key}`)).status, 200);
  const mine = await json(await get(buyer, '/api/marketplace/complaints/ct1'));
  assert.equal(JSON.stringify(mine).includes(noteUp.key), false);
});

test('COMPLAINT — an admin reply links to the reporter’s thread, and an attachment-only reply still says something', async () => {
  const w = world();
  seedComplaints(w.raw);
  w.raw.exec("INSERT INTO community_complaint_messages (id, complaint_id, sender_id, sender_role, body, internal) VALUES ('cm9','ct1','boss','admin','',0);");
  await notifyComplaintReply({ DB: asD1(w.raw) } as unknown as Env, 'ct1', 'cm9', '');
  const n = row<{ link: string; body_ar: string }>(w.raw, "SELECT link, body_ar FROM user_notifications WHERE kind = 'complaint_reply'");
  assert.equal(n?.link, '/support?tab=tickets&complaint=ct1');
  assert.ok(n && n.body_ar.length > 0, 'not an empty row in the bell');
});

// ============================================== repair: previews and counts

test('MESSAGES — the inbox previews a clip, a voice note and a PDF as what they are, not «صورة» or a blank line', async () => {
  const w = world();
  const buyer = w.app(BUYER);
  const chatId = await openOrderChat(buyer, 'ORD-A');
  const lastKind = async (id: string, kind: string, attachmentKind: string | null, fileKey: string, at: string) => {
    w.raw
      .prepare(
        `INSERT INTO chat_messages (id, chat_id, sender_id, kind, body, file_key, attachment_kind, created_at)
         VALUES (?, ?, 'buyer', ?, '', ?, ?, ?)`
      )
      .run(id, chatId, kind, fileKey, attachmentKind, at);
    return (await json(await get(w.app(ADMIN), '/api/admin/chats'))).chats[0].last_message.kind;
  };
  // The stored `kind` column can only say 'image' for a clip and 'text' for the rest.
  assert.equal(await lastKind('m1', 'image', 'video', `chat/${chatId}/video/a.mp4`, '2026-09-23T10:00:00.000Z'), 'video');
  assert.equal(await lastKind('m2', 'text', 'audio', `chat/${chatId}/audio/a.webm`, '2026-09-23T10:01:00.000Z'), 'audio');
  assert.equal(await lastKind('m3', 'text', 'file', `chat/${chatId}/files/a.pdf`, '2026-09-23T10:02:00.000Z'), 'file');
  // A row written before migration 0110's column: the folder still says what it is.
  assert.equal(await lastKind('m4', 'image', null, `chat/${chatId}/video/b.mp4`, '2026-09-23T10:03:00.000Z'), 'video');
  assert.equal(await lastKind('m5', 'image', null, `chat/${chatId}/attachments/c.webp`, '2026-09-23T10:04:00.000Z'), 'image');
});

test('COUNTS — a complaint leaves «الشكاوى» when the desk answers and comes back when the reporter does', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO community_complaints (id, reporter_id, category, description, status) VALUES
      ('k1','buyer','quality','cracked','under_review');
  `);
  const admin = w.app(ADMIN);
  const counted = async () => (await json(await get(admin, '/api/admin/chats/summary'))).complaints_open;
  const flagged = async () =>
    (await json(await get(admin, '/api/admin/community/complaints'))).complaints.find((c: { id: string }) => c.id === 'k1').awaiting_reply;
  assert.equal(await counted(), 1, 'never answered');
  assert.equal(await flagged(), 1);

  // An internal note is the desk talking to itself — not an answer.
  assert.equal((await post(admin, '/api/admin/community/complaints/k1/messages', { body: 'check the courier', internal: true })).status, 200);
  assert.equal(await counted(), 1);

  await tick();
  assert.equal((await post(admin, '/api/admin/community/complaints/k1/messages', { body: 'Send a photo please' })).status, 200);
  assert.equal(await counted(), 0, 'answered — the status did not move, the badge did');
  assert.equal(await flagged(), 0);
  assert.equal(row<{ status: string }>(w.raw, "SELECT status FROM community_complaints WHERE id = 'k1'")?.status, 'under_review');

  await tick();
  assert.equal((await post(w.app(BUYER), '/api/marketplace/complaints/k1/messages', { body: 'here it is' })).status, 200);
  assert.equal(await counted(), 1, 'the reporter wrote last on a complaint already under review');
  assert.equal(await flagged(), 1);

  w.raw.exec("UPDATE community_complaints SET status = 'resolved' WHERE id = 'k1'");
  assert.equal(await counted(), 0, 'a closed case waits on nobody');
});
