/**
 * SANCTIONS, MODERATION AND THE SUSPENDED STORE — wave 1, stream W1-C.
 *
 *   • audit 04 B2 / audit 01 B8 — a merchant-status change overwrote the
 *     store's own status: restricting a merchant lifted a store suspension,
 *     restoring one re-opened a shop its merchant had paused.
 *   • audit 01 B9 — an admin hide was undone by the merchant's next «نشر».
 *   • audit 01 B4 — a suspended store could not save ANY setting.
 *   • owner decision 2026-09-24 — a suspended store's public page is only
 *     «المتجر غير متاح حاليًا»: no products, banner, bio or reviews are served.
 *   • migration 0118 — what the old cascade left behind is handed back.
 *
 * Real routes, every migration, only the session stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  freshDb, dbThrough, asD1, stubApp, post, patch, get, json, row, all, type StubUser,
} from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { merchantRoutes } from '../worker/routes/merchant';
import { storefrontRoutes } from '../worker/routes/storefront';
import { communityRoutes } from '../worker/routes/community';
import { webManifestRoute } from '../worker/routes/manifest';

const FUTURE = '2099-01-01T00:00:00.000Z';
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };

function seed(opts: { storeStatus?: string; merchantStatus?: string; plus?: boolean } = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('owner','Ali','owner@x.co','h','merchant'), ('boss','Boss','boss@x.co','h','admin'),
      ('buyer','Sara','buyer@x.co','h','customer');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m1','owner','Ali 3D','${opts.merchantStatus ?? 'active'}');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,description,status,delivery_settings)
      VALUES ('s1','m1','owner','ali3d','Ali 3D','Prints for everyone','Our long bio','${opts.storeStatus ?? 'active'}','{}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock)
      VALUES ('cp1','m1','s1','ali3d-widget','Widget','active','active',14000,5,1);
    INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
      VALUES ('od1','buyer','delivered',14000,'m1','s1','merchant','store_product','{}','d','{}','wallet',14000,1500,0);
    INSERT INTO merchant_reviews (id,merchant_id,customer_id,order_id,rating,body) VALUES ('rv1','m1','buyer','od1',5,'great');
  `);
  if (opts.plus !== false) {
    raw.exec(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
              VALUES ('mem1','owner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}')`);
  }
  return raw;
}

const admin = (raw: ReturnType<typeof freshDb>) =>
  stubApp(asD1(raw), BOSS, (a) => a.route('/api/admin/community', adminCommunityRoutes));
const merchant = (raw: ReturnType<typeof freshDb>) =>
  stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/storefront', storefrontRoutes);
  });
const visitor = (raw: ReturnType<typeof freshDb>, host?: string) =>
  stubApp(asD1(raw), null, (a) => {
    a.route('/api/storefront', storefrontRoutes);
    a.route('/api/community', communityRoutes);
    a.get('/manifest.webmanifest', webManifestRoute);
  }, host ? { host } : {});

const storeStatus = (raw: ReturnType<typeof freshDb>) =>
  row<{ status: string; status_reason: string }>(raw, "SELECT status, status_reason FROM merchant_stores WHERE id = 's1'")!;

// ======================================================= two sanctions

test('restricting a merchant no longer lifts a STORE suspension set for something else', async () => {
  const raw = seed();
  const a = admin(raw);
  assert.equal((await post(a, '/api/admin/community/stores/s1/status', { status: 'suspended', reason: 'banner' })).status, 200);
  const res = await post(a, '/api/admin/community/merchants/m1/status', { status: 'restricted', reason: 'late replies' });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.store_status, 'suspended', 'the panel is told the store is still suspended');
  assert.deepEqual(storeStatus(raw), { status: 'suspended', status_reason: 'banner' });
});

test('restoring a merchant never re-opens a shop the MERCHANT paused', async () => {
  const raw = seed({ storeStatus: 'paused' });
  const a = admin(raw);
  await post(a, '/api/admin/community/merchants/m1/status', { status: 'suspended', reason: 'fraud check' });
  assert.equal(storeStatus(raw).status, 'paused', 'suspending the merchant does not write the store');
  await post(a, '/api/admin/community/merchants/m1/status', { status: 'active', reason: '' });
  assert.equal(storeStatus(raw).status, 'paused', "the merchant's own pause survives the restore");
});

test('restoring a merchant leaves an ADMIN store suspension in force', async () => {
  const raw = seed();
  const a = admin(raw);
  await post(a, '/api/admin/community/stores/s1/status', { status: 'suspended', reason: 'counterfeit listing' });
  await post(a, '/api/admin/community/merchants/m1/status', { status: 'suspended', reason: 'fraud' });
  await post(a, '/api/admin/community/merchants/m1/status', { status: 'active', reason: '' });
  assert.deepEqual(storeStatus(raw), { status: 'suspended', status_reason: 'counterfeit listing' });
});

test('a suspended MERCHANT shuts their shop without writing it: the storefront is unavailable, then back on restore', async () => {
  const raw = seed();
  const a = admin(raw);
  await post(a, '/api/admin/community/merchants/m1/status', { status: 'suspended', reason: 'fraud' });
  assert.equal(storeStatus(raw).status, 'active', 'the store row is the store\'s own');
  const shut = await get(visitor(raw), '/api/storefront/ali3d');
  assert.equal(shut.status, 404);
  assert.equal((await json(shut)).code, 'STORE_UNAVAILABLE');
  // …and the store cannot be re-opened by an admin around the merchant sanction.
  assert.equal((await post(a, '/api/admin/community/stores/s1/status', { status: 'active', reason: '' })).status, 409);
  await post(a, '/api/admin/community/merchants/m1/status', { status: 'active', reason: '' });
  assert.equal((await get(visitor(raw), '/api/storefront/ali3d')).status, 200);
});

// ======================================================= the unavailable store

const PUBLIC_READS = [
  '/api/storefront/ali3d',
  '/api/storefront/ali3d/products',
  '/api/storefront/ali3d/products/ali3d-widget',
  '/api/storefront/ali3d/reviews',
  '/api/storefront/ali3d/sections',
  '/api/storefront/ali3d/services',
  '/api/storefront/ali3d/showcase',
  '/api/storefront/by-id/s1',
  '/api/storefront/by-id/m1',
  '/api/community/store/m1',
];

for (const [label, opts] of [
  ['store suspended', { storeStatus: 'suspended' }],
  ['merchant suspended', { merchantStatus: 'suspended' }],
] as const) {
  test(`OWNER DECISION — ${label}: every public read answers STORE_UNAVAILABLE and carries nothing of the shop`, async () => {
    const raw = seed(opts);
    raw.exec(`INSERT INTO admin_settings (key, value) VALUES ('communityGate', '{"open":true}')`);
    const v = visitor(raw);
    for (const path of PUBLIC_READS) {
      const res = await get(v, path);
      const text = await res.text();
      assert.equal(res.status, 404, path);
      assert.equal(JSON.parse(text).code, 'STORE_UNAVAILABLE', path);
      for (const leak of ['Ali 3D', 'Prints for everyone', 'Our long bio', 'Widget', 'great']) {
        assert.ok(!text.includes(leak), `${path} leaked «${leak}»`);
      }
    }
    // The host itself resolves to "unavailable", not to the shop.
    const resolved = await get(visitor(raw, 'ali3d.levonis-iq.com'), '/api/storefront/resolve');
    assert.equal(resolved.status, 404);
    const body = await json(resolved);
    assert.equal(body.code, 'STORE_UNAVAILABLE');
    assert.equal(body.store, null);
    // And the directory does not advertise it as a destination.
    const dir = await json(await get(v, '/api/community/merchants'));
    assert.equal(dir.merchants[0].store_url, null);
  });
}

test('a PAUSED store is still a store: served, and says it is closed', async () => {
  const raw = seed({ storeStatus: 'paused' });
  const res = await get(visitor(raw), '/api/storefront/ali3d');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.store.open, false);
  assert.equal(body.store.name, 'Ali 3D');
  assert.equal((await get(visitor(raw), '/api/storefront/ali3d/products')).status, 200);
});

test('audit 01 B4: a SUSPENDED store saves its settings — everything but open/closed', async () => {
  const raw = seed({ storeStatus: 'suspended' });
  const m = merchant(raw);
  // What the settings form sends: every field, open:false included.
  const saved = await patch(m, '/api/merchant/store', { name: 'Fixed banner store', tagline: 'clean', open: false });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  const s = row<{ name: string; tagline: string; status: string }>(raw, "SELECT name, tagline, status FROM merchant_stores WHERE id = 's1'")!;
  assert.deepEqual(s, { name: 'Fixed banner store', tagline: 'clean', status: 'suspended' }, "closed is what it already is — 'paused' is never written over 'suspended'");

  const reopen = await patch(m, '/api/merchant/store', { name: 'Sneaky rename', open: true });
  assert.equal(reopen.status, 403);
  assert.equal((await json(reopen)).code, 'STORE_SUSPENDED');
  assert.equal(row<{ name: string }>(raw, "SELECT name FROM merchant_stores WHERE id = 's1'")!.name, 'Fixed banner store', 'a refused re-open saves nothing');
});

test('re-opening a paused store asks what selling asks: a lapsed or suspended merchant cannot', async () => {
  const lapsed = seed({ storeStatus: 'paused', plus: false });
  const r1 = await patch(merchant(lapsed), '/api/merchant/store', { open: true });
  assert.equal(r1.status, 403);
  assert.equal((await json(r1)).code, 'SUBSCRIPTION_INACTIVE');
  assert.equal(storeStatus(lapsed).status, 'paused');

  const suspended = seed({ storeStatus: 'paused', merchantStatus: 'suspended' });
  const r2 = await patch(merchant(suspended), '/api/merchant/store', { open: true });
  assert.equal(r2.status, 403);
  assert.equal((await json(r2)).code, 'MERCHANT_SUSPENDED');

  const ok = seed({ storeStatus: 'paused' });
  assert.equal((await patch(merchant(ok), '/api/merchant/store', { open: true })).status, 200);
  assert.equal(storeStatus(ok).status, 'active');
});

test('the manifest of a suspended store falls back to the platform', async () => {
  const raw = seed({ storeStatus: 'suspended' });
  const res = await get(visitor(raw, 'ali3d.levonis-iq.com'), '/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.notEqual(JSON.parse(await res.text()).name, 'Ali 3D');
});

// ======================================================= sticky moderation

test('audit 01 B9: an ADMIN hide cannot be undone by the merchant, who is told why', async () => {
  const raw = seed();
  const a = admin(raw);
  const m = merchant(raw);

  assert.equal((await post(a, '/api/admin/community/products/cp1/hide', {})).status, 400, 'a hide needs a reason');
  const hide = await post(a, '/api/admin/community/products/cp1/hide', { reason: 'counterfeit logo' });
  assert.equal(hide.status, 200);

  // THE PROBE P9 MOVE: the merchant «publishes» it again. The admin hide did
  // not touch the merchant's own lifecycle (still 'active'), so re-sending it
  // is an edit — and the product stays OFF the storefront.
  assert.equal((await patch(m, '/api/merchant/products/cp1', { lifecycle: 'active', name: 'Widget (original)' })).status, 200);
  const list = await json(await get(m, '/api/storefront/ali3d/products'));
  assert.ok(!list.products.some((p: { id: string }) => p.id === 'cp1'), 'not on the storefront');
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM community_products WHERE id = 'cp1'")!.status, 'hidden');

  // An actual PUBLISH (draft → active) is refused, with the reason.
  assert.equal((await patch(m, '/api/merchant/products/cp1', { lifecycle: 'draft' })).status, 200);
  const publish = await patch(m, '/api/merchant/products/cp1', { lifecycle: 'active' });
  assert.equal(publish.status, 409);
  const refusal = await json(publish);
  assert.equal(refusal.code, 'PRODUCT_HIDDEN_BY_ADMIN');
  assert.equal(refusal.details.reason, 'counterfeit logo');

  // The merchant's own list says so.
  const mine = await json(await get(m, '/api/merchant/products'));
  const p = mine.products.find((x: { id: string }) => x.id === 'cp1');
  assert.equal(p.moderation.hidden_by_admin, true);
  assert.equal(p.moderation.reason, 'counterfeit logo');

  // A duplicate of the hidden content is the same content with a new id.
  const dup = await post(m, '/api/merchant/products/cp1/duplicate');
  assert.equal(dup.status, 409);
  assert.equal((await json(dup)).code, 'PRODUCT_HIDDEN_BY_ADMIN');
});

test('the hide wins IN THE STATEMENT, even when it lands between the merchant\'s check and write', async () => {
  const raw = seed();
  const d1 = asD1(raw);
  // A D1 whose merchant UPDATE first lets an admin hide land — the race the
  // SQL guard exists for.
  const racing = {
    prepare(sql: string) {
      if (/^\s*UPDATE community_products SET/.test(sql) && /admin_hidden_at IS NULL/.test(sql)) {
        raw.exec(`UPDATE community_products SET admin_hidden_at = '2026-09-24T00:00:00.000Z', admin_hidden_reason = 'race', status = 'hidden' WHERE id = 'cp1'`);
      }
      return (d1 as unknown as { prepare: (s: string) => unknown }).prepare(sql);
    },
    batch: (s: unknown[]) => (d1 as unknown as { batch: (x: unknown[]) => unknown }).batch(s),
  } as unknown as D1Database;
  raw.exec(`UPDATE community_products SET lifecycle = 'draft', status = 'hidden' WHERE id = 'cp1'`);
  const m = stubApp(racing, OWNER, (a) => a.route('/api/merchant', merchantRoutes));
  await patch(m, '/api/merchant/products/cp1', { lifecycle: 'active' });
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM community_products WHERE id = 'cp1'")!.status, 'hidden');
});

test('lifting the hide restores exactly what the merchant had chosen', async () => {
  const raw = seed();
  const a = admin(raw);
  await post(a, '/api/admin/community/products/cp1/hide', { reason: 'check the listing' });
  const lift = await post(a, '/api/admin/community/products/cp1/hide', { hidden: false });
  assert.equal(lift.status, 200);
  const p = row<{ status: string; lifecycle: string; admin_hidden_at: string | null }>(
    raw, "SELECT status, lifecycle, admin_hidden_at FROM community_products WHERE id = 'cp1'"
  )!;
  assert.deepEqual(p, { status: 'active', lifecycle: 'active', admin_hidden_at: null });
  const listed = await json(await get(admin(raw), '/api/admin/community/merchants/m1/products'));
  assert.equal(listed.products[0].admin_hidden, false);
  assert.equal(listed.products[0].live, true);
});

// ======================================================= migration 0118

test('migration 0118 hands a store the OLD cascade suspended back to its merchant, and keeps a store-level suspension', () => {
  const raw = dbThrough('0117');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','A','a@x.co','h'), ('u2','B','b@x.co','h'), ('u3','C','c@x.co','h'), ('buyer','S','s@x.co','h');
    INSERT INTO community_merchants (id,user_id,name,status,status_reason) VALUES
      ('mA','u1','Cascaded','suspended','fraud'), ('mB','u2','Own sanction','suspended','fraud'), ('mC','u3','Fine','active','');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,status_reason) VALUES
      ('sA','mA','u1','cascaded','Cascaded','suspended','fraud'),
      ('sB','mB','u2','ownsanction','Own sanction','suspended','banner'),
      ('sC','mC','u3','fine','Fine','suspended','banner');
    INSERT INTO audit_log (actor_id, action, target, detail) VALUES
      ('boss','admin.store_status','sB','{"status":"suspended","reason":"banner","merchant":"mB"}'),
      ('boss','admin.merchant_status','mB','{"status":"suspended","reason":"fraud"}'),
      ('boss','admin.merchant_status','mA','{"status":"suspended","reason":"fraud"}');
    INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
      VALUES ('o1','buyer','pending',1000,'mC','sC','merchant','store_product','{}','d','{}','wallet',1000,1500,0);
    INSERT INTO chats (id, order_id) VALUES ('c1','o1');
    INSERT INTO chat_participants (chat_id, user_id) VALUES ('c1','buyer');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd) VALUES
      ('pHidden','mC','sC','p-hidden','Hidden','hidden','hidden',100),
      ('pRepublished','mC','sC','p-repub','Back','active','active',100);
    INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES
      ('boss','admin.product_hidden','pHidden','{}','2026-05-01T00:00:00.000Z'),
      ('boss','admin.product_hidden','pRepublished','{}','2026-05-01T00:00:00.000Z'),
      ('u3','merchant.product_updated','pRepublished','{}','2026-05-02T00:00:00.000Z');
  `);
  raw.exec(readFileSync(join(ROOT, 'migrations/0118_sanctions_moderation_store_chats.sql'), 'utf8'));

  const stores = Object.fromEntries(
    all<{ id: string; status: string; status_reason: string }>(raw, 'SELECT id, status, status_reason FROM merchant_stores')
      .map((s) => [s.id, `${s.status}:${s.status_reason}`])
  );
  assert.equal(stores.sA, 'paused:', 'cascaded — handed back to its merchant, closed');
  assert.equal(stores.sB, 'suspended:banner', 'its own store-level suspension stands');
  assert.equal(stores.sC, 'suspended:banner', 'a merchant who is not suspended: not the cascade, untouched');

  const parts = all<{ user_id: string }>(raw, "SELECT user_id FROM chat_participants WHERE chat_id = 'c1' ORDER BY user_id").map((p) => p.user_id);
  assert.deepEqual(parts, ['buyer', 'u3'], 'the seller joins their order thread');

  const hidden = Object.fromEntries(
    all<{ id: string; admin_hidden_at: string | null }>(raw, 'SELECT id, admin_hidden_at FROM community_products').map((p) => [p.id, p.admin_hidden_at])
  );
  assert.equal(hidden.pHidden, '2026-05-01T00:00:00.000Z');
  assert.equal(hidden.pRepublished, null, 'already republished by its merchant — not re-hidden by a migration');

  // Twice is a no-op.
  raw.exec(readFileSync(join(ROOT, 'migrations/0118_sanctions_moderation_store_chats.sql'), 'utf8').replace(/ALTER TABLE[^;]+;/g, ''));
  assert.equal(all(raw, "SELECT 1 FROM chat_participants WHERE chat_id = 'c1'").length, 2);
});
