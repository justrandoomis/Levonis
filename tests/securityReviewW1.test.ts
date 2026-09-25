/**
 * THE WAVE-1 SECURITY/INTEGRATION REVIEW (findings S1–S5, S7, S8, and the
 * 0119 data repair) — each reviewer probe inverted into the rule it pins.
 *
 *   S1  the storefront said «open» for a shop the cart refused;
 *   S2  acceptance and the preview mint used a narrower merchant rule than
 *       making an offer;
 *   S3  read-only staff in a store thread could still drive «يكتب…» and file
 *       uploads under it;
 *   S4  a suspended store's new address leaked through STORE_MOVED;
 *   S5  the community directory kept serving sanctioned shops;
 *   S7  the subdomain e2e script still spoke the pre-wave-1 contract;
 *   S8  preview links minted under the week-long rule kept their week, and a
 *       link outlived its creator's access.
 * S6 (the admin order doors) is pinned in tests/storeOrderMoneyReview.test.ts
 * and tests/communityMoneyScope.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  freshDb, dbThrough, asD1, stubApp, post, send, get, json, row, count, all, pending, holds,
} from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { storefrontRoutes } from '../worker/routes/storefront';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { chatRoutes } from '../worker/routes/chats';
import { uploadRoutes } from '../worker/routes/uploads';
import { communityRoutes } from '../worker/routes/community';
import { mayQuoteOnBoard } from '../worker/lib/communityRequests';

const FUTURE = '2099-01-01T00:00:00.000Z';
const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const RATE = 1400;

// ===================================================================== S1

function seedStore(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('ali','Ali','ali@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active');
    INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES ('ali3d','s_ali',1);
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock)
      VALUES ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,100,0);
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
  `);
}
const shopper = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/storefront', storefrontRoutes);
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
  }, { env: ENV });

test('S1 (probe P1 inverted): a store the cart refuses reads CLOSED on the storefront and its product page — no live buy button', async () => {
  for (const [label, sql] of [
    ['restricted merchant', "UPDATE community_merchants SET status = 'restricted' WHERE id = 'm_ali'"],
    ['lapsed owner subscription', "UPDATE memberships SET expires_at = '2026-02-01T00:00:00.000Z' WHERE id = 'mem_ali'"],
    ['store stopped selling direct products', "UPDATE merchant_stores SET sells_direct_products = 0 WHERE id = 's_ali'"],
  ] as const) {
    const raw = freshDb();
    seedStore(raw);
    raw.exec(sql);
    const a = shopper(raw);
    const store = await json(await get(a, '/api/storefront/ali3d'));
    const page = await json(await get(a, '/api/storefront/ali3d/products/ali-spool'));
    const add = await post(a, '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 });
    assert.equal(store.store.open, false, `${label}: the storefront says closed`);
    assert.equal(store.store.status, 'closed', label);
    assert.equal(page.store.open, false, `${label}: the product page (sellable = store.open && in_stock) disables the button`);
    assert.equal((await json(add)).code, 'STORE_CLOSED', `${label}: and the cart agrees`);
  }
  // The control: a store that takes orders says so, and the cart takes one.
  const raw = freshDb();
  seedStore(raw);
  const a = shopper(raw);
  assert.equal((await json(await get(a, '/api/storefront/ali3d'))).store.open, true);
  assert.equal((await post(a, '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 })).status, 201);
});

// ===================================================================== S2

function seedRequest() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('owner','Ali','a@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at) VALUES
      ('r1','buyer','Print a bracket','I need a bracket printed','receiving_offers','open','public',1,'${FUTURE}'),
      ('r2','buyer','Print a vase','A tall vase','open','open','public',0,'${FUTURE}');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('o1','r1','m1','s1',50000,'pending');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('wt1','buyer','deposit','USD',${Math.ceil((60000 * 100) / RATE)},'approved','fund');
  `);
  return raw;
}
const mp = (raw: DatabaseSync, id: string, env: Record<string, unknown> = {}) =>
  stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, (a) => {
    a.route('/api/marketplace/print', printRequestRoutes);
    a.route('/api/marketplace', marketplaceRoutes);
  }, { env });

test('S2 (probe P2 inverted): an offer its merchant could not make today cannot be ACCEPTED — refused before any money is reserved', async () => {
  for (const [label, sql, offerCode] of [
    ['paused store', "UPDATE merchant_stores SET status = 'paused' WHERE id = 's1'", 'STORE_PAUSED'],
    ['lapsed owner plan', "UPDATE memberships SET expires_at = '2026-02-01T00:00:00.000Z' WHERE id = 'mem1'", 'SUBSCRIPTION_INACTIVE'],
    ['restricted merchant', "UPDATE community_merchants SET status = 'restricted' WHERE id = 'm1'", 'MERCHANT_RESTRICTED'],
  ] as const) {
    const raw = seedRequest();
    raw.exec(sql);
    const bid = await post(mp(raw, 'owner'), '/api/marketplace/requests/r2/offers', { price_iqd: 1000 });
    assert.equal((await json(bid)).code, offerCode, `${label}: a new offer is refused`);
    const acc = await post(mp(raw, 'buyer'), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50000, offer_revision: 1 });
    assert.equal(acc.status, 409, label);
    assert.equal((await json(acc)).code, 'MERCHANT_UNAVAILABLE', `${label}: the customer is told the merchant is not taking work — never why`);
    assert.equal(count(raw, 'SELECT COUNT(*) n FROM community_escrows'), 0, `${label}: no escrow`);
    assert.equal(holds(raw, 'buyer').length, 0, `${label}: nothing was reserved`);
    assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_offers WHERE id = 'o1'")!.state, 'pending');
    assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")!.state, 'receiving_offers');
    await Promise.allSettled(pending.splice(0));
  }
  // The control: the same offer, the merchant in good standing, is accepted.
  const raw = seedRequest();
  const ok = await post(mp(raw, 'buyer'), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50000, offer_revision: 1 });
  assert.equal(ok.status, 201, JSON.stringify(await json(ok.clone())));
});

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array | ArrayBuffer) { this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value)); }
  async head(key: string) { const v = this.objects.get(key); return v ? ({ key, size: v.byteLength } as unknown as R2Object) : null; }
  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) return null;
    return { body: new Blob([v as unknown as BlobPart]).stream(), httpEtag: `"${key}"`, arrayBuffer: async () => v.buffer };
  }
  async delete(key: string) { this.objects.delete(key); }
}

function seedPreview(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('owner2','Omar','o@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m2','owner2','Omar 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s2','m2','owner2','omar3d','Omar 3D');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm) VALUES ('p2','m2','s2','P1S','fdm',256,256,250);
    INSERT INTO community_request_files (id,request_id,file_key,file_name,content_type,size_bytes,kind,analysis,model_format,preview_key)
      VALUES ('f1','r1','requests/buyer/x.stl','x.stl','model/stl',84,'model','{}','stl','request-previews/r1/f1.lvm');
  `);
}

test('S2 (probe P3 inverted): a RESTRICTED merchant, refused every new offer, cannot mint a 3D preview link either', async () => {
  const raw = seedRequest();
  seedPreview(raw);
  raw.exec("UPDATE community_merchants SET status = 'restricted' WHERE id = 'm2'");
  const bucket = new MemoryBucket();
  const mint = await post(mp(raw, 'owner2', { BUCKET: bucket }), '/api/marketplace/print/requests/r1/files/f1/viewer-token');
  assert.equal(mint.status, 403);
  assert.equal((await json(mint)).code, 'VIEWER_NOT_ALLOWED');
  assert.equal(await mayQuoteOnBoard(asD1(raw), 'owner2'), false);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM model_view_tokens'), 0);
});

// ===================================================================== S8

test('S8: a preview link grants no more than its creator still has — it stops when the merchant is restricted', async () => {
  const raw = seedRequest();
  seedPreview(raw);
  const app = mp(raw, 'owner2', { BUCKET: new MemoryBucket() });
  const mint = await post(app, '/api/marketplace/print/requests/r1/files/f1/viewer-token');
  assert.equal(mint.status, 200, JSON.stringify(await json(mint.clone())));
  const { token } = await json(mint);
  // Since W5-B a link opens only for the account that minted it.
  assert.equal((await get(mp(raw, 'someone-else'), `/api/marketplace/print/viewer/${token}`)).status, 404, 'a link is not a bearer ticket');
  const viewer = mp(raw, 'owner2');
  assert.equal((await get(viewer, `/api/marketplace/print/viewer/${token}`)).status, 200, 'the link works while its creator may quote');
  raw.exec("UPDATE community_merchants SET status = 'restricted' WHERE id = 'm2'");
  assert.equal((await get(viewer, `/api/marketplace/print/viewer/${token}`)).status, 404, 'and stops with the access it stood on');
  // The request's own customer keeps a link of their own.
  const buyer = mp(raw, 'buyer', { BUCKET: new MemoryBucket() });
  const own = await post(buyer, '/api/marketplace/print/requests/r1/files/f1/viewer-token');
  assert.equal(own.status, 200);
  assert.equal((await get(buyer, `/api/marketplace/print/viewer/${(await json(own)).token}`)).status, 200);
});

test('S8: a link minted under the week-long rule is dead after 60 minutes, whatever its expires_at says', async () => {
  const raw = seedRequest();
  seedPreview(raw);
  const app = mp(raw, 'buyer', { BUCKET: new MemoryBucket() });
  const mint = await post(app, '/api/marketplace/print/requests/r1/files/f1/viewer-token');
  const { token } = await json(mint);
  // Rewrite it into the pre-wave-1 shape: minted two hours ago, valid for a week.
  raw.exec(`UPDATE model_view_tokens SET created_at = '${new Date(Date.now() - 2 * 3_600_000).toISOString()}',
                                         expires_at = '${new Date(Date.now() + 5 * 86_400_000).toISOString()}'`);
  assert.equal((await get(app, `/api/marketplace/print/viewer/${token}`)).status, 404);
});

// ===================================================================== S3

function seedStoreThread(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('owner','Ali','owner@x.co','h','merchant'), ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
      VALUES ('ord1','buyer','pending',1000,'m1','s1','merchant','store_product','{}','merchant','{}','wallet',1000,1500,0);
    INSERT INTO chats (id, order_id) VALUES ('chat1','ord1');
    INSERT INTO chat_participants (chat_id,user_id) VALUES ('chat1','buyer'), ('chat1','owner'), ('chat1','boss');
  `);
}

test('S3 (probe P4 inverted): a legacy staff participant of a store thread is read-only on EVERY write door — message, typing, upload', async () => {
  const raw = freshDb();
  seedStoreThread(raw);
  const admin = stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => {
    a.route('/api/chats', chatRoutes);
    a.route('/api/uploads', uploadRoutes);
  });
  const msg = await post(admin, '/api/chats/chat1/messages', { body: 'hello' });
  assert.equal(msg.status, 403);
  assert.equal((await json(msg)).code, 'CHAT_READ_ONLY');
  const typing = await post(admin, '/api/chats/chat1/typing', { typing: true });
  assert.equal(typing.status, 403);
  assert.equal((await json(typing)).code, 'CHAT_READ_ONLY');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM chat_typing_presence'), 0, 'nothing shows «يكتب…» to the customer');
  // A chat file is written under the thread: refused before a byte is stored.
  const mp4 = new Uint8Array(32);
  mp4.set([0x00, 0x00, 0x00, 0x18], 0);
  mp4.set([0x66, 0x74, 0x79, 0x70], 4);
  const form = new FormData();
  form.set('purpose', 'chat');
  form.set('entity_id', 'chat1');
  form.set('file', new File([mp4], 'clip.mp4', { type: 'video/mp4' }));
  const up = await admin.request('/api/uploads', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  assert.equal(up.status, 403);
  assert.equal((await json(up)).code, 'CHAT_READ_ONLY');
  // The parties still write.
  const buyer = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/chats', chatRoutes));
  assert.equal((await post(buyer, '/api/chats/chat1/typing', { typing: true })).status, 200);
});

test('S3 + S8: migration 0119 removes non-party members of store threads and revokes week-long preview links — once, audited', () => {
  const raw = dbThrough('0118');
  raw.exec('PRAGMA foreign_keys = OFF');
  seedStoreThread(raw);
  raw.exec(`
    -- The shop's OWN order thread: the admin desk IS the other party and stays.
    INSERT INTO orders (id,user_id,status,total_iqd,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
      VALUES ('ord2','buyer','pending',1000,'levonis','platform','{}','pickup','{}','cod',1000,1500,1000);
    INSERT INTO chats (id, order_id) VALUES ('chat2','ord2');
    INSERT INTO chat_participants (chat_id,user_id) VALUES ('chat2','buyer'), ('chat2','boss');
    INSERT INTO community_requests (id,customer_id,title,state,status,visibility) VALUES ('r1','buyer','T','open','open','public');
    INSERT INTO community_request_files (id,request_id,file_key,file_name,content_type,size_bytes,kind) VALUES ('f1','r1','k','x.stl','model/stl',1,'model');
    INSERT INTO model_view_tokens (token_hash,file_id,request_id,created_by,expires_at,revoked_at) VALUES
      ('week','f1','r1','owner','${new Date(Date.now() + 6 * 86_400_000).toISOString()}',NULL),
      ('hour','f1','r1','owner','${new Date(Date.now() + 30 * 60_000).toISOString()}',NULL),
      ('gone','f1','r1','owner','${new Date(Date.now() + 6 * 86_400_000).toISOString()}','2026-01-01T00:00:00.000Z');
  `);
  raw.exec('PRAGMA foreign_keys = ON');
  const sql = readFileSync(join(ROOT, 'migrations/0119_store_threads_and_viewer_links.sql'), 'utf8');
  raw.exec(sql);
  assert.deepEqual(all(raw, "SELECT user_id FROM chat_participants WHERE chat_id = 'chat1' ORDER BY user_id"), [{ user_id: 'buyer' }, { user_id: 'owner' }]);
  assert.deepEqual(all(raw, "SELECT user_id FROM chat_participants WHERE chat_id = 'chat2' ORDER BY user_id"), [{ user_id: 'boss' }, { user_id: 'buyer' }], 'the shop desk thread is untouched');
  const tokens = Object.fromEntries(all<{ token_hash: string; revoked_at: string | null }>(raw, 'SELECT token_hash, revoked_at FROM model_view_tokens').map((t) => [t.token_hash, t.revoked_at]));
  assert.ok(tokens.week, 'the week-long link is revoked');
  assert.equal(tokens.hour, null, 'a link inside the 60-minute rule is kept');
  assert.equal(tokens.gone, '2026-01-01T00:00:00.000Z', 'an already revoked link keeps its date');
  const audits = all<{ action: string; detail: string }>(raw, "SELECT action, detail FROM audit_log WHERE action LIKE 'migration.0119.%' ORDER BY action");
  assert.deepEqual(audits.map((a) => [a.action, JSON.parse(a.detail).rows]), [
    ['migration.0119.store_thread_members_removed', 1],
    ['migration.0119.viewer_links_revoked', 1],
  ]);
  // Twice is once.
  raw.exec(sql);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'migration.0119.%'"), 2);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM chat_participants'), 4);

  // Nothing to repair, nothing recorded: a fresh database (every migration
  // applied, 0119 included) still starts with an EMPTY audit log.
  assert.equal(count(freshDb(), 'SELECT COUNT(*) n FROM audit_log'), 0, 'a database with nothing to repair gets no audit row');
});

// ===================================================================== S4

test('S4 (probe P6 inverted): the retired slug of a SUSPENDED store answers STORE_UNAVAILABLE — its new address is not disclosed', async () => {
  const raw = freshDb();
  seedStore(raw);
  raw.exec(`
    UPDATE merchant_stores SET slug = 'fake-official-levo' WHERE id = 's_ali';
    UPDATE merchant_store_slugs SET active = 0 WHERE slug = 'ali3d';
    INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES ('fake-official-levo','s_ali',1);
  `);
  const oldHost = () => stubApp(asD1(raw), null, (a) => a.route('/api/storefront', storefrontRoutes), { host: 'ali3d.levonis-iq.com', env: ENV });
  // While the store is in good standing the old address still redirects.
  const moved = await json(await get(oldHost(), '/api/storefront/resolve'));
  assert.equal(moved.code, 'STORE_MOVED');
  assert.equal(moved.details.redirect, 'https://fake-official-levo.levonis-iq.com');
  for (const sanction of [
    "UPDATE merchant_stores SET status = 'suspended', status_reason = 'impersonation' WHERE id = 's_ali'",
    "UPDATE merchant_stores SET status = 'active' WHERE id = 's_ali'; UPDATE community_merchants SET status = 'suspended' WHERE id = 'm_ali'",
  ]) {
    raw.exec(sanction);
    const res = await get(oldHost(), '/api/storefront/resolve');
    const body = await json(res);
    assert.equal(res.status, 404);
    assert.equal(body.code, 'STORE_UNAVAILABLE');
    assert.equal(body.details, undefined, 'no redirect');
    assert.ok(!JSON.stringify(body).includes('fake-official-levo'), 'the new name is nowhere in the answer');
  }
});

// ===================================================================== S5

test('S5 (probe P7 inverted): the directory serves nothing of a sanctioned shop; the followed list keeps a neutral, unfollowable card', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('ali','Ali','ali@x.co','h','merchant'), ('v','V','v@x.co','h','customer'),
      ('omar','Omar','omar@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name,bio,avatar_key,status) VALUES
      ('m_ali','ali','Levonis Official Store','Official Levonis support — DM us your wallet code','merchants/ali/public/a.webp','active'),
      ('m_omar','omar','Omar 3D','Honest prints','merchants/omar/public/o.webp','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES
      ('s_ali','m_ali','ali','ali3d','Levonis Official Store','suspended'), ('s_omar','m_omar','omar','omar3d','Omar 3D','active');
    INSERT INTO follows (user_id, merchant_id) VALUES ('v','m_ali'), ('v','m_omar');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  const a = stubApp(asD1(raw), { id: 'v', role: 'customer', email: 'v@x.co' }, (x) => x.route('/api/community', communityRoutes), { env: ENV });
  for (const sanction of [
    null,
    "UPDATE merchant_stores SET status = 'active' WHERE id = 's_ali'; UPDATE community_merchants SET status = 'suspended' WHERE id = 'm_ali'",
  ]) {
    if (sanction) raw.exec(sanction);
    const dir = await json(await get(a, '/api/community/merchants'));
    const ids = (dir.merchants as Array<{ id: string }>).map((m) => m.id);
    assert.deepEqual(ids, ['m_omar'], 'the sanctioned shop is not listed');
    assert.ok(!JSON.stringify(dir).includes('DM us your wallet code'));
    const followed = await json(await get(a, '/api/community/followed'));
    const card = (followed.merchants as Array<Record<string, unknown>>).find((m) => m.id === 'm_ali')!;
    assert.deepEqual(card, {
      id: 'm_ali', unavailable: true, name: null, bio: null, avatarUrl: null, verified: false, pro_badge: false,
      created_at: card.created_at, store_slug: null, store_url: null,
    });
    const healthy = (followed.merchants as Array<Record<string, unknown>>).find((m) => m.id === 'm_omar')!;
    assert.equal(healthy.unavailable, false);
    assert.equal(healthy.bio, 'Honest prints');
  }
  // The customer can still stop following it.
  assert.equal((await send(a, 'DELETE', '/api/community/store/m_ali/follow')).status, 200);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM follows WHERE merchant_id = 'm_ali'"), 0);
});

// ===================================================================== S7

test('S7: the subdomain e2e script speaks the wave-1 contract — drafts published, quotes bound, offers accepted as seen, credits keyed', () => {
  const file = join(ROOT, 'scripts/e2e-subdomains.mjs');
  execFileSync(process.execPath, ['--check', file]);
  const src = readFileSync(file, 'utf8');
  const publishes = src.match(/\/api\/marketplace\/print\/requests\/\$\{\w+\}\/publish/g) ?? [];
  assert.ok(publishes.length >= 2, 'both requests it creates are published before a merchant offers');
  assert.match(src, /quoteFingerprint: quote\.json\?\.quote\?\.quote_fingerprint/);
  assert.match(src, /expected_price_iqd: offer\.json\?\.offer\?\.price_iqd/);
  assert.match(src, /offer_revision: offer\.json\?\.offer\?\.revision/);
  assert.match(src, /'\/api\/admin\/wallet\/credit', \{[\s\S]{0,300}idempotencyKey:/);
  assert.doesNotMatch(src, /\/offers\/\$\{offerId\}\/accept`\)/, 'no acceptance without the version it accepts');
});
