/**
 * THE ORDER'S TIMELINE (docs/COMMUNITY_ECOSYSTEM.md §9.5, migration 0160) over
 * the real routes, a real acceptance and a real escrow:
 *
 *   · a stranger is nobody to the order: no update, no timeline, no file;
 *   · «بدأ التنفيذ» stamps `started_at` and writes ONE «started» row;
 *   · the workshop's updates reach the customer as one row per order that
 *     comes back unread on each update; the customer's «اطلب تعديلًا» reaches
 *     the workshop; each side writes only its own kinds;
 *   · «ready» is a moment inside `in_progress`: no state, no money;
 *   · a modification request after delivery is refused;
 *   · a photo is the workshop's own PRIVATE upload under THIS order, and the
 *     timeline hands out a URL on the Worker — never a key;
 *   · the merged timeline reads created → funded → started → … → delivered →
 *     confirmed → released → completed, actors as roles;
 *   · the conversation the deal came from hears each update;
 *   · the merchant may cancel before work starts and dispute after
 *     (`cancellationPolicy` admits them as it stands);
 *   · the upload door files an order photo under the order, for a party only;
 *   · a report of an update is resolved to the update for the desk.
 *
 * Run: node --import tsx --test tests/orderTimeline.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, count, row, all, memoryBucket, failingD1, type StubUser, type Mount } from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { communityOrderTimelineRoutes, TIMELINE_UPDATES_MAX } from '../worker/routes/communityOrderTimeline';
import { wavesD1 } from './fixtures/wavesD1';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { KEY_PURPOSES, SESSION_PURPOSES, assertUploadEntity, placementFor, purposeAdmits, quotaBytesFor } from '../worker/lib/uploadEntity';
import { HttpError } from '../worker/lib/http';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/marketplace', communityOrderTimelineRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'owner', role: 'customer', email: 'owner@x.co' };
const NOUR: StubUser = { id: 'stranger', role: 'customer', email: 'stranger@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

/** Sara's bracket, Ali's pending offer, a funded wallet — the accept-integrity world. */
function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('owner','Ali','owner@x.co','h','customer'),
      ('owner2','Omar','owner2@x.co','h','customer'), ('stranger','Nour','stranger@x.co','h','customer'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D');
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
const as = (raw: DatabaseSync, user: StubUser | null, bucket?: Bucket) =>
  stubApp(asD1(raw), user, mount, bucket ? { env: { BUCKET: bucket } } : {});

/** Sara accepts Ali's offer as the list shows it: a funded order with a held escrow. */
async function funded(raw: DatabaseSync): Promise<string> {
  const list = await json(await get(as(raw, BUYER), '/api/marketplace/requests/r1/offers'));
  const o = (list.offers as Array<{ id: string; price_iqd: number; revision: number }>).find((x) => x.id === 'o1')!;
  const acc = await post(as(raw, BUYER), '/api/marketplace/offers/o1/accept', { expected_price_iqd: o.price_iqd, offer_revision: o.revision });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  return (await json(acc)).order.id as string;
}
async function started(raw: DatabaseSync): Promise<string> {
  const id = await funded(raw);
  const s = await post(as(raw, ALI), `/api/marketplace/orders/${id}/start`);
  assert.equal(s.status, 200, JSON.stringify(await json(s.clone())));
  return id;
}

const updates = (id: string) => `/api/marketplace/orders/${id}/updates`;
const timeline = (id: string) => `/api/marketplace/orders/${id}/timeline`;
const notes = (raw: DatabaseSync, user: string, key: string) =>
  all<{ id: string; kind: string; title_en: string; body_en: string; meta: string; read_at: string | null; link: string }>(
    raw,
    'SELECT id, kind, title_en, body_en, meta, read_at, link FROM user_notifications WHERE user_id = ? AND event_key = ? ORDER BY created_at, rowid',
    user,
    key
  );
const kinds = (t: Record<string, unknown>) => (t.timeline as Array<{ kind: string }>).map((e) => e.kind);

// =============================================================== strangers

test('a stranger is nobody to the order: no update, no timeline, no file', async () => {
  const raw = seed();
  const id = await started(raw);
  assert.equal((await post(as(raw, NOUR), updates(id), { kind: 'note', body: 'hello' })).status, 404);
  assert.equal((await get(as(raw, NOUR), timeline(id))).status, 404);
  assert.equal((await get(as(raw, NOUR), `${updates(id)}/nope/file`)).status, 404);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_order_updates WHERE kind = 'note'"), 0);
});

// ==================================================================== start

test('«بدأ التنفيذ» stamps started_at and writes ONE started row, whatever the retries', async () => {
  const raw = seed();
  const id = await funded(raw);
  assert.equal(row<{ started_at: string | null }>(raw, 'SELECT started_at FROM community_orders WHERE id = ?', id)!.started_at, null);
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${id}/start`)).status, 200);
  const o = row<{ state: string; started_at: string | null }>(raw, 'SELECT state, started_at FROM community_orders WHERE id = ?', id)!;
  assert.equal(o.state, 'in_progress');
  assert.ok(o.started_at, 'started_at is stamped');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_order_updates WHERE community_order_id = ? AND kind = 'started'", id), 1);
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${id}/start`)).status, 409);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_order_updates WHERE community_order_id = ? AND kind = 'started'", id), 1);

  const t = await json(await get(as(raw, BUYER), timeline(id)));
  assert.deepEqual(kinds(t), ['created', 'funded', 'started']);
  const [created, fundedEv, startedEv] = t.timeline as Array<{ actor: string; at: string }>;
  assert.equal(created.actor, 'customer');
  assert.equal(fundedEv.actor, 'customer');
  assert.equal(startedEv.actor, 'merchant');
  assert.equal(startedEv.at, o.started_at);
  assert.equal(t.role, 'customer');
  assert.equal(t.order.started_at, o.started_at);
  assert.deepEqual(t.can, { update: false, ready: false, modification_request: true });
  assert.deepEqual((await json(await get(as(raw, ALI), timeline(id)))).can, { update: true, ready: true, modification_request: false });
});

// ================================================================== updates

test('the workshop\'s updates reach the customer as ONE row per order that comes back on each update; each side writes its own kinds', async () => {
  const raw = seed();
  const id = await started(raw);

  const first = await post(as(raw, ALI), updates(id), { kind: 'progress', body: 'First layers down, looks clean.' });
  assert.equal(first.status, 201, JSON.stringify(await json(first.clone())));
  const u = (await json(first)).update;
  assert.equal(u.kind, 'progress');
  assert.equal(u.actor, 'merchant');
  assert.equal(u.file, null);
  let heard = notes(raw, 'buyer', `order_update:${id}`);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].kind, 'order_update');
  assert.equal(heard[0].title_en, 'The workshop posted an update on your order “Print a bracket”');
  assert.equal(heard[0].body_en, 'First layers down, looks clean.');
  assert.match(heard[0].link, /#timeline$/);
  assert.ok(JSON.parse(heard[0].meta).title_ckb, 'Sorani is stamped');

  // Read it; the next update from the SAME workshop brings the row back unread.
  raw.exec("UPDATE user_notifications SET read_at = '2026-01-01T00:00:00.000Z' WHERE user_id = 'buyer'");
  assert.equal((await post(as(raw, ALI), updates(id), { kind: 'note', body: 'Colour swapped to black as agreed.' })).status, 201);
  heard = notes(raw, 'buyer', `order_update:${id}`);
  assert.equal(heard.length, 1, 'still one row per order');
  assert.equal(JSON.parse(heard[0].meta).count, 2);
  assert.equal(heard[0].read_at, null);
  assert.equal(heard[0].title_en, '2 updates on your order “Print a bracket”');
  assert.equal(heard[0].body_en, 'Colour swapped to black as agreed.');

  // Each side writes its own kinds; the order's own moves are nobody's to send.
  const customerProgress = await post(as(raw, BUYER), updates(id), { kind: 'progress', body: 'me too' });
  assert.equal(customerProgress.status, 403);
  assert.equal((await json(customerProgress)).code, 'ORDER_UPDATE_KIND_NOT_ALLOWED');
  const merchantChange = await post(as(raw, ALI), updates(id), { kind: 'modification_request', body: 'change it' });
  assert.equal(merchantChange.status, 403);
  assert.equal((await json(merchantChange)).code, 'ORDER_UPDATE_KIND_NOT_ALLOWED');
  const clientStarted = await post(as(raw, ALI), updates(id), { kind: 'started' });
  assert.equal(clientStarted.status, 403);
  assert.equal((await json(clientStarted)).details.reason, 'SERVER_ONLY');
  const long = await post(as(raw, ALI), updates(id), { kind: 'note', body: 'x'.repeat(1001) });
  assert.equal(long.status, 400);
  assert.equal((await json(long)).code, 'ORDER_UPDATE_TOO_LONG');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_order_updates WHERE community_order_id = ?', id), 3, 'started + two updates');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'community.order_update'"), 2);
});

test('«ready» is a moment inside in_progress: no state moves, no money moves, and a second «ready» is a replay', async () => {
  const raw = seed();
  const id = await started(raw);
  const before = row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE community_order_id = ?', id)!;
  assert.equal(before.state, 'held');

  const ready = await post(as(raw, ALI), updates(id), { kind: 'ready' });
  assert.equal(ready.status, 201, JSON.stringify(await json(ready.clone())));
  const firstId = (await json(ready)).update.id as string;
  const o = row<{ state: string; ready_at: string | null }>(raw, 'SELECT state, ready_at FROM community_orders WHERE id = ?', id)!;
  assert.equal(o.state, 'in_progress', 'no state change');
  assert.ok(o.ready_at, 'ready_at is stamped');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE community_order_id = ?', id)!.state, 'held', 'no money moved');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_escrow_events WHERE kind IN ('release','refund')"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_ledger_entries"), 0);

  const again = await json(await post(as(raw, ALI), updates(id), { kind: 'ready' }));
  assert.equal(again.replayed, true);
  assert.equal(again.update.id, firstId);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_order_updates WHERE community_order_id = ? AND kind = 'ready'", id), 1);
  assert.equal(row<{ ready_at: string }>(raw, 'SELECT ready_at FROM community_orders WHERE id = ?', id)!.ready_at, o.ready_at);
  assert.equal((await json(await get(as(raw, ALI), timeline(id)))).can.ready, false);
  // The customer's timeline shows it; the delivered door is still the state machine's.
  assert.ok(kinds(await json(await get(as(raw, BUYER), timeline(id)))).includes('ready'));
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${id}/delivered`)).status, 200);
});

test('before the work starts the workshop may write, but not «ready»', async () => {
  const raw = seed();
  const id = await funded(raw);
  const early = await post(as(raw, ALI), updates(id), { kind: 'ready' });
  assert.equal(early.status, 403);
  const why = await json(early);
  assert.deepEqual([why.code, why.details.reason], ['ORDER_UPDATE_KIND_NOT_ALLOWED', 'NOT_STARTED']);
  assert.equal((await post(as(raw, ALI), updates(id), { kind: 'note', body: 'Filament arrives tomorrow.' })).status, 201);
  assert.equal(row<{ ready_at: string | null }>(raw, 'SELECT ready_at FROM community_orders WHERE id = ?', id)!.ready_at, null);
});

// ============================================================ modification

test('the customer may ask for a change before delivery and not after; the workshop is told; the merged timeline reads in order', async () => {
  const raw = seed();
  const id = await started(raw);
  const asked = await post(as(raw, BUYER), updates(id), { kind: 'modification_request', body: 'Could the holes be 5 mm instead of 4?' });
  assert.equal(asked.status, 201, JSON.stringify(await json(asked.clone())));
  assert.equal((await json(asked)).update.actor, 'customer');
  const told = notes(raw, 'owner', `order_update:${id}`);
  assert.equal(told.length, 1);
  assert.equal(told[0].title_en, 'The customer asked for a change on the order “Print a bracket”');
  assert.match(told[0].link, new RegExp(`${id}$`), 'the workshop is sent to the order');

  assert.equal((await post(as(raw, ALI), updates(id), { kind: 'progress', body: 'Done — 5 mm holes.' })).status, 201);
  assert.equal((await post(as(raw, ALI), `/api/marketplace/orders/${id}/delivered`)).status, 200);
  const late = await post(as(raw, BUYER), updates(id), { kind: 'modification_request', body: 'One more thing…' });
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'ORDER_UPDATE_TOO_LATE');
  // The workshop may still leave a note while the customer decides.
  assert.equal((await post(as(raw, ALI), updates(id), { kind: 'note', body: 'Left with the doorman.' })).status, 201);
  assert.equal((await post(as(raw, BUYER), `/api/marketplace/orders/${id}/confirm`)).status, 200);
  const settled = await post(as(raw, ALI), updates(id), { kind: 'note', body: 'Thanks!' });
  assert.equal(settled.status, 409);
  assert.equal((await json(settled)).code, 'ORDER_UPDATE_TOO_LATE');

  const t = await json(await get(as(raw, BUYER), timeline(id)));
  assert.deepEqual(kinds(t), ['created', 'funded', 'started', 'modification_request', 'progress', 'delivered', 'note', 'confirmed', 'released', 'completed']);
  // The confirmation and the release are one act, told in the act's order
  // even though the escrow moves a moment before the order is stamped.
  const byKind = Object.fromEntries((t.timeline as Array<{ kind: string; actor: string; amount_iqd?: number }>).map((e) => [e.kind, e]));
  assert.equal(byKind.delivered.actor, 'merchant');
  assert.equal(byKind.confirmed.actor, 'customer');
  assert.equal(byKind.released.actor, 'customer');
  assert.equal(byKind.completed.actor, 'customer');
  assert.ok((byKind.released.amount_iqd ?? 0) > 0, 'the released amount is on the event');
  const ats = (t.timeline as Array<{ at: string }>).map((e) => e.at);
  assert.deepEqual(ats, [...ats].sort(), 'in time order');
  assert.equal(t.order.state, 'completed');
});

// ==================================================================== photos

const KEY = (orderId: string) => `community-orders/${orderId}/updates/p1.webp`;
const fileRow = (raw: DatabaseSync, key: string, owner: string, purpose: string, visibility = 'private') =>
  raw.exec(`INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, original_name, purpose)
            VALUES ('${key}', '${visibility}', '${key.split('/')[0]}', '${owner}', 'x', 'image/webp', 4, 'p1.webp', '${purpose}')`);

test('a photo is the workshop\'s own PRIVATE upload under THIS order; the timeline hands out a URL, never a key', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  const id = await started(raw);
  const key = KEY(id);
  await bucket.put(key, new Uint8Array([0x52, 0x49, 0x46, 0x46]), { httpMetadata: { contentType: 'image/webp' } });
  fileRow(raw, key, 'owner', 'order_update');
  fileRow(raw, `community-orders/${id}/updates/theirs.webp`, 'stranger', 'order_update');
  fileRow(raw, 'users/owner/post-files/mine.webp', 'owner', 'post');
  fileRow(raw, 'community-orders/cord_other/updates/elsewhere.webp', 'owner', 'order_update');
  fileRow(raw, `community-orders/${id}/updates/public.webp`, 'owner', 'order_update', 'public');

  for (const bad of [
    `community-orders/${id}/updates/theirs.webp`,
    'users/owner/post-files/mine.webp',
    'community-orders/cord_other/updates/elsewhere.webp',
    `community-orders/${id}/updates/public.webp`,
    `community-orders/${id}/updates/missing.webp`,
    '',
  ]) {
    const res = await post(as(raw, ALI), updates(id), { kind: 'photo', file_key: bad });
    assert.equal(res.status, 400, bad);
    assert.equal((await json(res)).code, 'ORDER_UPDATE_FILE_NOT_OWNED', bad);
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_order_updates WHERE kind = 'photo'"), 0);

  const ok = await post(as(raw, ALI), updates(id), { kind: 'photo', file_key: key, body: 'Off the bed.' });
  assert.equal(ok.status, 201, JSON.stringify(await json(ok.clone())));
  const u = (await json(ok)).update;
  assert.equal(u.file.url, `/api/marketplace/orders/${id}/updates/${u.id}/file`);
  assert.equal(u.file.inline, true);

  const res = await get(as(raw, BUYER), timeline(id));
  const text = await res.text();
  assert.ok(!text.includes('community-orders/'), 'no key in the timeline');
  assert.ok(!text.includes('p1.webp'));
  const t = JSON.parse(text);
  const photo = (t.timeline as Array<{ kind: string; file: { url: string } | null }>).find((e) => e.kind === 'photo')!;
  assert.equal(photo.file!.url, u.file.url);

  // The bytes: both parties, inline, never cached; a stranger gets nothing.
  const asCustomer = await get(as(raw, BUYER, bucket), u.file.url);
  assert.equal(asCustomer.status, 200);
  assert.equal(asCustomer.headers.get('content-type'), 'image/webp');
  assert.match(asCustomer.headers.get('content-disposition') ?? '', /^inline/);
  assert.equal(asCustomer.headers.get('cache-control'), 'private, no-store');
  assert.equal(asCustomer.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await asCustomer.arrayBuffer()).byteLength, 4);
  assert.equal((await get(as(raw, ALI, bucket), u.file.url)).status, 200);
  assert.equal((await get(as(raw, NOUR, bucket), u.file.url)).status, 404);
  assert.equal((await get(as(raw, BUYER, bucket), `${updates(id)}/${u.id}x/file`)).status, 404);
});

// ============================================================== the chat card

test('the conversation the deal came from hears each update as a system card, once per update', async () => {
  const raw = seed();
  const id = await started(raw);
  // The thread the deal came from: the one the acceptance opened for a board
  // request (offers V2), or — on a database whose accept did not — one made here.
  let chatId = row<{ chat_id: string | null }>(raw, 'SELECT chat_id FROM community_orders WHERE id = ?', id)!.chat_id;
  if (!chatId) {
    chatId = 'chat1';
    raw.exec(`
      INSERT INTO chats (id, context_type, context_id, store_id, merchant_id) VALUES ('chat1','request','r1','s1','m1');
      INSERT INTO chat_participants (chat_id, user_id) VALUES ('chat1','buyer'), ('chat1','owner');
      UPDATE community_orders SET chat_id = 'chat1' WHERE id = '${id}'`);
  }
  raw.exec(`UPDATE chats SET last_message_at = NULL WHERE id = '${chatId}'`);
  const a = (await json(await post(as(raw, ALI), updates(id), { kind: 'progress', body: 'Printing now.' }))).update.id as string;
  const b = (await json(await post(as(raw, BUYER), updates(id), { kind: 'modification_request', body: 'Make it blue.' }))).update.id as string;
  const cards = all<{ sender_id: string; card_type: string; card_ref: string; card_event_key: string; card_snapshot: string; is_system: number }>(
    raw,
    "SELECT sender_id, card_type, card_ref, card_event_key, card_snapshot, is_system FROM chat_messages WHERE chat_id = ? AND card_event_key LIKE '%:update:%' ORDER BY created_at, rowid",
    chatId
  );
  assert.deepEqual(
    cards.map((c) => [c.sender_id, c.card_type, c.card_ref, c.card_event_key, c.is_system]),
    [
      ['owner', 'custom_order', id, `custom_order:${id}:update:${a}`, 1],
      ['buyer', 'custom_order', id, `custom_order:${id}:update:${b}`, 1],
    ]
  );
  const snap = JSON.parse(cards[0].card_snapshot);
  assert.equal(snap.event, 'progress');
  assert.deepEqual(snap.update, { id: a, kind: 'progress', body: 'Printing now.', has_photo: false });
  assert.ok(row(raw, 'SELECT last_message_at FROM chats WHERE id = ?', chatId)!.last_message_at, 'the thread moved up in the inbox');
});

// ======================================================= cancel and dispute

test('the merchant may cancel before work starts and dispute after — cancellationPolicy admits them as it stands', async () => {
  const early = seed();
  const id1 = await funded(early);
  const c = await post(as(early, ALI), `/api/marketplace/orders/${id1}/cancel`);
  assert.equal(c.status, 200, JSON.stringify(await json(c.clone())));
  assert.equal((await json(c)).refunded, true);
  assert.equal(row<{ state: string }>(early, 'SELECT state FROM community_orders WHERE id = ?', id1)!.state, 'cancelled');
  assert.equal(row<{ state: string }>(early, 'SELECT state FROM community_escrows WHERE community_order_id = ?', id1)!.state, 'refunded');
  // …and the request's discussion records who closed it.
  const closed = row<{ body: string }>(early, "SELECT body FROM community_request_comments WHERE request_id = 'r1' AND kind = 'system_update' ORDER BY created_at DESC LIMIT 1")!;
  assert.deepEqual(JSON.parse(closed.body), { code: 'cancelled', meta: { by: 'merchant', order_id: id1 } });
  const t = await json(await get(as(early, ALI), timeline(id1)));
  assert.deepEqual(kinds(t).slice(-2), ['cancelled', 'refunded'], 'the act, then the money');
  const cancelled = (t.timeline as Array<{ kind: string; actor: string }>).find((e) => e.kind === 'cancelled')!;
  assert.equal(cancelled.actor, 'merchant');

  const late = seed();
  const id2 = await started(late);
  const refused = await post(as(late, ALI), `/api/marketplace/orders/${id2}/cancel`);
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'CUSTOM_ORDER_CANCEL_NEEDS_DISPUTE');
  const d = await post(as(late, ALI), `/api/marketplace/orders/${id2}/dispute`, { description: 'The customer changed the job after I printed it' });
  assert.equal(d.status, 201, JSON.stringify(await json(d.clone())));
  assert.equal(row<{ state: string }>(late, 'SELECT state FROM community_orders WHERE id = ?', id2)!.state, 'disputed');
  const disputed = row<{ body: string }>(late, "SELECT body FROM community_request_comments WHERE request_id = 'r1' AND kind = 'system_update' ORDER BY created_at DESC LIMIT 1")!;
  assert.deepEqual(JSON.parse(disputed.body), { code: 'disputed', meta: { by: 'merchant', order_id: id2 } });
  assert.deepEqual(kinds(await json(await get(as(late, BUYER), timeline(id2)))), ['created', 'funded', 'started', 'dispute']);
  // Frozen: neither side writes on the timeline any more.
  assert.equal((await post(as(late, ALI), updates(id2), { kind: 'note', body: 'x' })).status, 409);
});

// ============================================================== upload door

test('the upload door files an order photo under the order, for its only writer — the workshop, while the order is live — as a private key the page never sees', async () => {
  const raw = seed();
  const id = await funded(raw);
  const db = asD1(raw);
  assert.ok((SESSION_PURPOSES as readonly string[]).includes('order_update'));
  assert.ok(KEY_PURPOSES.has('order_update'), 'the key comes back to the merchant, who posts it to the timeline');
  assert.equal(purposeAdmits('order_update', 'image'), true);
  assert.equal(purposeAdmits('order_update', 'model'), false);
  assert.equal(await assertUploadEntity(db, { id: 'owner', role: 'customer' }, 'order_update', id), id);
  // The door opens where its consumer does (review 2026-09-30): the customer's
  // change request takes no file, so the customer is nobody here, like a stranger.
  for (const who of ['buyer', 'stranger', 'owner2']) {
    await assert.rejects(assertUploadEntity(db, { id: who, role: 'customer' }, 'order_update', id), (e: unknown) => e instanceof HttpError && e.status === 404, who);
  }
  await assert.rejects(assertUploadEntity(db, { id: 'owner', role: 'customer' }, 'order_update', 'cord_nope'), (e: unknown) => e instanceof HttpError && e.status === 404);
  // A closed order takes no update, so it takes no upload either — the POST's own answer.
  raw.exec(`UPDATE community_orders SET state = 'completed' WHERE id = '${id}'`);
  await assert.rejects(
    assertUploadEntity(db, { id: 'owner', role: 'customer' }, 'order_update', id),
    (e: unknown) => e instanceof HttpError && e.status === 409 && e.code === 'ORDER_UPDATE_TOO_LATE'
  );
  // And the bytes count against the owner's quota for job files, like an offer's.
  assert.equal(quotaBytesFor({ post_gb: 2, product_file_gb: 5, request_gb: 1 } as never, 'order_update'), 1024 ** 3);
  assert.deepEqual(placementFor('order_update', 'image', { userId: 'owner', entityId: id, mime: 'image/webp' }), {
    visibility: 'private',
    domain: 'community-orders',
    entityId: id,
    kind: 'updates',
  });
});

// =================================================================== reports

test('a report of an update is filed per update and resolved to the update for the desk, who may open its photo', async () => {
  const raw = seed();
  const id = await started(raw);
  const uid = (await json(await post(as(raw, ALI), updates(id), { kind: 'note', body: 'Pay me outside the platform' }))).update.id as string;
  const own = await post(as(raw, ALI), `${updates(id)}/${uid}/report`, { reason: 'fraud' });
  assert.equal(own.status, 404, 'nobody reports their own update');
  assert.equal((await post(as(raw, NOUR), `${updates(id)}/${uid}/report`, { reason: 'fraud' })).status, 404);

  const filed = await post(as(raw, BUYER), `${updates(id)}/${uid}/report`, { reason: 'fraud', details: 'asked for cash' });
  assert.equal(filed.status, 201, JSON.stringify(await json(filed.clone())));
  const reportId = (await json(filed)).report_id as string;
  // The report names the UPDATE (review 2026-09-30), so a second update of the same order is its own report.
  assert.deepEqual(row(raw, 'SELECT target_type, target_id FROM community_reports WHERE id = ?', reportId), { target_type: 'request', target_id: uid });
  assert.deepEqual(row(raw, 'SELECT kind, target_id FROM community_report_targets WHERE report_id = ?', reportId), { kind: 'order_update', target_id: uid });
  assert.equal((await json(await post(as(raw, BUYER), `${updates(id)}/${uid}/report`, { reason: 'fraud' }))).replayed, true);

  const queue = await json(await get(as(raw, BOSS), '/api/admin/community/reports?state=open'));
  assert.equal(queue.reports.length, 1);
  assert.equal(queue.reports[0].target.kind, 'order_update');
  assert.equal(queue.reports[0].target.id, uid);
  assert.equal(queue.reports[0].target.order_id, id);
  assert.equal(queue.reports[0].target.body, 'Pay me outside the platform');
  assert.equal(queue.reports[0].target.actor_id, 'owner');

  // A later abusive PHOTO is reported too — not swallowed as a replay of the note's report —
  // and the desk can open it (audited); an unreported photo stays the parties' alone.
  const key = `community-orders/${id}/updates/abuse0001.webp`;
  const quiet = `community-orders/${id}/updates/quiet0001.webp`;
  raw.exec(`INSERT INTO file_objects (object_key,visibility,domain,owner_id,entity_id,mime_type,byte_size,original_name,purpose) VALUES
    ('${key}','private','community-orders','owner','${id}','image/webp',4,'a.webp','order_update'),
    ('${quiet}','private','community-orders','owner','${id}','image/webp',4,'q.webp','order_update')`);
  const bucket = memoryBucket();
  await bucket.put(key, new Uint8Array([1, 2, 3, 4]), { httpMetadata: { contentType: 'image/webp' } });
  await bucket.put(quiet, new Uint8Array([5, 6, 7, 8]), { httpMetadata: { contentType: 'image/webp' } });
  const withBucket = (u: StubUser) => stubApp(asD1(raw), u, mount, { env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket } });
  const photo = (await json(await post(withBucket(ALI), updates(id), { kind: 'photo', file_key: key }))).update;
  const quietPhoto = (await json(await post(withBucket(ALI), updates(id), { kind: 'photo', file_key: quiet }))).update;
  const second = await post(as(raw, BUYER), `${updates(id)}/${photo.id}/report`, { reason: 'abuse' });
  assert.equal(second.status, 201, 'a second update of the same order is its own report');
  assert.equal((await json(await get(as(raw, BOSS), '/api/admin/community/reports?state=open'))).reports.length, 2);
  const asDesk = await get(withBucket(BOSS), `/api/marketplace/orders/${id}/updates/${photo.id}/file`);
  assert.equal(asDesk.status, 200, 'the desk opens the reported photo');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.order_update_file_read' AND target = ?", id), 1);
  assert.equal((await get(withBucket(BOSS), `/api/marketplace/orders/${id}/updates/${quietPhoto.id}/file`)).status, 404, 'nobody reported this one');
});

// ================================================== races (review 2026-09-30)

/**
 * THE RULES HOLD IN THE WRITE. POST /orders/:id/updates reads the order, then
 * writes; a «سلّمت العمل» or a dispute that commits in between (the fixture's
 * `beforeBatch`, the concurrent writer it exists for) must leave no row the
 * rule forbids.
 */
test('an update racing a state change is refused in the write: no change request on a delivered order, no «ready» on a disputed one', async () => {
  const raw = seed();
  const id = await started(raw);
  const { failing, db } = failingD1(raw);
  const racing = (sqlState: string) => {
    failing.beforeBatch = (stmts) => {
      if (stmts.some((st) => /INSERT INTO community_order_updates/.test(st.sql))) {
        raw.exec(`UPDATE community_orders SET state = '${sqlState}' WHERE id = '${id}'`);
        failing.beforeBatch = null;
      }
    };
  };
  racing('merchant_marked_delivered');
  const change = await post(stubApp(db, BUYER, mount), updates(id), { kind: 'modification_request', body: 'Please make it red' });
  assert.equal(change.status, 409);
  assert.equal((await json(change)).code, 'ORDER_UPDATE_TOO_LATE');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_order_updates WHERE community_order_id = ? AND kind = 'modification_request'", id), 0);

  raw.exec(`UPDATE community_orders SET state = 'in_progress' WHERE id = '${id}'`);
  racing('disputed');
  const ready = await post(stubApp(db, ALI, mount), updates(id), { kind: 'ready' });
  assert.equal(ready.status, 409);
  assert.equal((await json(ready)).details.state, 'disputed');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_order_updates WHERE community_order_id = ? AND kind = 'ready'", id), 0);
  assert.equal(row<{ ready_at: string | null }>(raw, 'SELECT ready_at FROM community_orders WHERE id = ?', id)!.ready_at, null);
});

test('a cancel and its refund on the same millisecond read «the act, then the money»', async () => {
  const raw = seed();
  const id = await funded(raw);
  // What POST /orders/:id/cancel writes whenever its clock and the escrow's land on one instant.
  const at = '2026-09-30T10:00:00.000Z';
  raw.exec(`
    UPDATE community_orders SET state = 'cancelled', cancelled_at = '${at}', created_at = '2026-09-29T09:00:00.000Z' WHERE id = '${id}';
    UPDATE community_escrows SET held_at = '2026-09-29T10:00:00.000Z' WHERE community_order_id = '${id}';
    UPDATE community_escrow_events SET created_at = '2026-09-29T10:00:00.000Z'
     WHERE escrow_id = (SELECT id FROM community_escrows WHERE community_order_id = '${id}');
    INSERT INTO community_escrow_events (id, escrow_id, kind, amount_iqd, actor_id, actor_role, reason, idempotency_key, created_at)
      SELECT 'e_refund', id, 'refund', gross_iqd, 'owner', 'merchant', 'cancelled before work started', 'cancel:${id}', '${at}'
        FROM community_escrows WHERE community_order_id = '${id}';
  `);
  const t = await json(await get(as(raw, BUYER), timeline(id)));
  assert.deepEqual(kinds(t), ['created', 'funded', 'cancelled', 'refunded'], JSON.stringify(kinds(t)));
});

test('the order read carries the admin\'s confirmation window — the default 7, the setting when set, 0 when auto-release is off', async () => {
  const raw = seed();
  const id = await funded(raw);
  assert.equal((await json(await get(as(raw, ALI), `/api/marketplace/orders/${id}`))).auto_complete_days, 7);
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('communityAutoCompleteDays', '0')`);
  assert.equal((await json(await get(as(raw, BUYER), `/api/marketplace/orders/${id}`))).auto_complete_days, 0);
});

test('the timeline read is two round trips and carries the newest TIMELINE_UPDATES_MAX updates, saying older ones exist (perf review 2026-09-30)', async () => {
  // It used to be three dependent waves (the order → the escrow and every update → the escrow's events keyed on the
  // escrow's id) and an unbounded read of the updates, re-run every 30 s while the page is open.
  const raw = seed();
  const id = await started(raw);
  const { waves, db } = wavesD1(raw);
  waves.reset();
  const small = await json(await get(stubApp(db, BUYER, mount), timeline(id)));
  assert.ok(waves.counts.waves <= 2, `waves ${waves.counts.waves}`);
  assert.equal(small.older_updates, false);

  // 205 progress notes after the «started» row, one a millisecond, then two rows of ONE millisecond («zz» written first).
  const base = Date.now() + 60_000;
  const values = Array.from({ length: 205 }, (_, i) => `('u${String(i).padStart(3, '0')}','${id}','owner','progress','n${i}',NULL,'${new Date(base + i).toISOString()}')`);
  raw.exec(`INSERT INTO community_order_updates (id, community_order_id, actor_id, kind, body, file_key, created_at) VALUES ${values.join(',')}`);
  const tie = new Date(base + 205).toISOString();
  raw.exec(`INSERT INTO community_order_updates (id, community_order_id, actor_id, kind, body, file_key, created_at) VALUES ('zz','${id}','owner','progress','first',NULL,'${tie}')`);
  raw.exec(`INSERT INTO community_order_updates (id, community_order_id, actor_id, kind, body, file_key, created_at) VALUES ('aa','${id}','owner','progress','second',NULL,'${tie}')`);
  waves.reset();
  const big = await json(await get(stubApp(db, BUYER, mount), timeline(id)));
  assert.ok(waves.counts.waves <= 2, `waves ${waves.counts.waves}`);
  assert.equal(big.older_updates, true, 'older updates exist beyond the page');
  const notes = (big.timeline as Array<{ kind: string; body?: string; note?: string; text?: string }>).filter((e) => e.kind === 'progress');
  assert.equal(notes.length, TIMELINE_UPDATES_MAX, 'the read is bounded');
  const text = (e: Record<string, unknown>) => String(e.body ?? e.note ?? e.text ?? '');
  // The NEWEST are kept, oldest first; the same-millisecond pair keeps its written order, never its ids' («aa» < «zz»).
  assert.deepEqual(notes.slice(-2).map(text), ['first', 'second']);
  assert.equal(text(notes[0]), `n${205 + 2 - TIMELINE_UPDATES_MAX}`);
});
