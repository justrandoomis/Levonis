/**
 * STORE ADDRESSES, PAGING AND THE CLOSED GOVERNORATE LIST — wave 1, W1-C.
 *
 *   audit 01 B14  a renamed store's old address answered «No such store»
 *   audit 01 B23  `resolve`, `by-id`… could be claimed as store slugs
 *   audit 01 B24  onboarding / slug-change races were a raw 500
 *   audit 01 B5   keyset pages skipped rows sharing a timestamp; a CSV import
 *                 stamped every row with one
 *   audit 01 B19  the root domain was typed into the bundle
 *   audit 02 B27  store / merchant governorate was free text
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshDb, asD1, failingD1, stubApp, post, patch, get, json, row, all, type StubUser,
} from './fixtures/app';
import { merchantRoutes } from '../worker/routes/merchant';
import { storefrontRoutes } from '../worker/routes/storefront';
import { checkSlug } from '../worker/lib/merchantOps';
import { isSystemSlug, SLUG_MIN } from '../worker/lib/hosts';

const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };
const FUTURE = '2099-01-01T00:00:00.000Z';
const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('owner','Ali','owner@x.co','h','merchant'), ('rival','Zaid','z@x.co','h','merchant'), ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem2','rival','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO admin_settings (key, value) VALUES ('communityGate', '{"open":true}');
  `);
  return raw;
}
function withStore(raw: ReturnType<typeof freshDb>) {
  raw.exec(`
    INSERT INTO community_merchants (id,user_id,name,governorate) VALUES ('m1','owner','Ali 3D','بغداد - الكرادة');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,governorate) VALUES ('s1','m1','owner','ali3d','Ali 3D','بغداد - الكرادة');
    INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES ('ali3d','s1',1);
  `);
  return raw;
}

const merchant = (db: D1Database, user: StubUser = OWNER) =>
  stubApp(db, user, (a) => {
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/storefront', storefrontRoutes);
  }, { env: ENV });
const host = (raw: ReturnType<typeof freshDb>, h: string) =>
  stubApp(asD1(raw), null, (a) => a.route('/api/storefront', storefrontRoutes), { host: h, env: ENV });

// ============================================================ B14 — redirects

test('B14: after a rename the OLD address answers STORE_MOVED with where the shop lives now', async () => {
  const raw = withStore(seed());
  const change = await post(merchant(asD1(raw)), '/api/merchant/store/slug', { slug: 'ali-prints' });
  assert.equal(change.status, 200, JSON.stringify(await json(change)));

  const old = await get(host(raw, 'ali3d.levonis-iq.com'), '/api/storefront/resolve');
  assert.equal(old.status, 404);
  const body = await json(old);
  assert.equal(body.code, 'STORE_MOVED');
  assert.equal(body.details.redirect, 'https://ali-prints.levonis-iq.com');
  assert.equal(body.root_domain, 'levonis-iq.com');

  // The in-site route under the old slug keeps working, as the same store.
  const bySlug = await json(await get(host(raw, 'levonis-iq.com'), '/api/storefront/ali3d'));
  assert.equal(bySlug.store.slug, 'ali-prints');

  // The new address is the shop.
  assert.equal((await get(host(raw, 'ali-prints.levonis-iq.com'), '/api/storefront/resolve')).status, 200);
});

test('B14: a slug another store has since CLAIMED is that store — never a redirect to the old one', async () => {
  const raw = withStore(seed());
  raw.exec(`
    INSERT INTO merchant_store_slugs (slug, store_id, active, reserved_until) VALUES ('oldname','s1',0,'2020-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m2','rival','Zaid');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s2','m2','rival','oldname','Zaid Prints');
  `);
  const res = await json(await get(host(raw, 'oldname.levonis-iq.com'), '/api/storefront/resolve'));
  assert.equal(res.store.name, 'Zaid Prints');
});

test('B19: every resolve answer names the configured root domain, and /me does too', async () => {
  const raw = withStore(seed());
  assert.equal((await json(await get(host(raw, 'levonis-iq.com'), '/api/storefront/resolve'))).root_domain, 'levonis-iq.com');
  assert.equal((await json(await get(host(raw, 'ali3d.levonis-iq.com'), '/api/storefront/resolve'))).root_domain, 'levonis-iq.com');
  assert.equal((await json(await get(host(raw, 'nosuch.levonis-iq.com'), '/api/storefront/resolve'))).root_domain, 'levonis-iq.com');
  assert.equal((await json(await get(merchant(asD1(raw)), '/api/merchant/me'))).root_domain, 'levonis-iq.com');
});

// ============================================================ B23 — API words

test('B23: every literal segment of the storefront router is a reserved slug (and `p`)', async () => {
  const words = new Set<string>(['p']);
  for (const r of storefrontRoutes.routes) {
    for (const seg of r.path.split('/')) if (seg && !seg.startsWith(':') && seg !== '*') words.add(seg);
  }
  for (const w of ['resolve', 'by-id', 'products', 'reviews']) assert.ok(words.has(w), `the walk found «${w}»`);
  const raw = seed();
  for (const w of words) {
    assert.ok(isSystemSlug(w) || w.length < SLUG_MIN, `«${w}» is a storefront path word and can still be a store slug`);
    if (w.length >= SLUG_MIN) assert.equal((await checkSlug(asD1(raw), w)).reason, 'reserved', w);
  }
});

// ============================================================ B24 — races

test('B24: onboarding that loses the slug race answers 409 SLUG_UNAVAILABLE — never a raw 500', async () => {
  const raw = seed();
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /INSERT INTO merchant_stores/.test(s.sql))) {
      raw.exec(`INSERT INTO community_merchants (id,user_id,name) VALUES ('m2','rival','Zaid');
                INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s2','m2','rival','ali3d','Zaid');`);
    }
  };
  const res = await post(merchant(db), '/api/merchant/onboard', { name: 'Ali 3D', slug: 'ali3d' });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'SLUG_UNAVAILABLE');
  assert.equal(row(raw, "SELECT id FROM merchant_stores WHERE user_id = 'owner'"), undefined, 'nothing half-landed');
});

test('B24: a double-tapped onboarding answers 409 STORE_EXISTS', async () => {
  const raw = seed();
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /INSERT INTO merchant_stores/.test(s.sql))) {
      raw.exec(`INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
                INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','first-tap','Ali 3D');`);
    }
  };
  const res = await post(merchant(db), '/api/merchant/onboard', { name: 'Ali 3D', slug: 'second-tap' });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'STORE_EXISTS');
});

test('B24: a slug change that loses the race answers 409, and the old address is untouched', async () => {
  const raw = withStore(seed());
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /UPDATE merchant_stores SET slug/.test(s.sql))) {
      raw.exec(`INSERT INTO community_merchants (id,user_id,name) VALUES ('m2','rival','Zaid');
                INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s2','m2','rival','wanted','Zaid');`);
    }
  };
  const res = await post(merchant(db), '/api/merchant/store/slug', { slug: 'wanted' });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'SLUG_UNAVAILABLE');
  assert.equal(row<{ slug: string }>(raw, "SELECT slug FROM merchant_stores WHERE id = 's1'")!.slug, 'ali3d');
});

test('a slug whose parking has LAPSED onboards cleanly (its history row is taken over, not a PK 500)', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('gone','G','g@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('mg','gone','Gone');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('sg','mg','gone','gone-new','Gone');
    INSERT INTO merchant_store_slugs (slug, store_id, active, reserved_until) VALUES ('freed','sg',0,'2020-01-01T00:00:00.000Z');
  `);
  const res = await post(merchant(asD1(raw)), '/api/merchant/onboard', { name: 'Ali 3D', slug: 'freed' });
  assert.equal(res.status, 201, JSON.stringify(await json(res)));
  const slugRow = row<{ store_id: string; active: number }>(raw, "SELECT store_id, active FROM merchant_store_slugs WHERE slug = 'freed'")!;
  assert.equal(slugRow.active, 1);
  assert.notEqual(slugRow.store_id, 'sg');
});

// ============================================================ B5 — keyset paging

test('B5 (probe P5): thirty products on ONE timestamp are all reachable through the storefront cursor', async () => {
  const raw = withStore(seed());
  const ins = raw.prepare(
    `INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,created_at)
     VALUES (?,?,?,?,?,'active','active',1000,1,0,'2026-05-01T00:00:00.000Z')`
  );
  for (let i = 0; i < 30; i++) ins.run(`cpx${String(i).padStart(2, '0')}`, 'm1', 's1', `ali3d-x-${i}`, `X ${i}`);
  const seen = new Set<string>();
  let cursor = '';
  for (let pages = 0; pages < 10; pages++) {
    const page = await json(await get(host(raw, 'levonis-iq.com'), `/api/storefront/ali3d/products?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    for (const p of page.products) {
      assert.ok(!seen.has(p.id), `${p.id} served twice`);
      seen.add(p.id);
    }
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  assert.equal(seen.size, 30);
});

test('B5: an old client\'s bare-timestamp cursor still reads as before', async () => {
  const raw = withStore(seed());
  raw.exec(`INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,created_at) VALUES
    ('a','m1','s1','ali3d-a','A','active','active',1,'2026-05-01T00:00:00.000Z'),
    ('b','m1','s1','ali3d-b','B','active','active',1,'2026-05-02T00:00:00.000Z')`);
  const page = await json(await get(host(raw, 'levonis-iq.com'), `/api/storefront/ali3d/products?cursor=${encodeURIComponent('2026-05-02T00:00:00.000Z')}`));
  assert.deepEqual(page.products.map((p: { id: string }) => p.id), ['a']);
});

test('B5: the CSV import stamps each row its own instant, in file order', async () => {
  const raw = withStore(seed());
  const csv = 'name,price_iqd\n' + Array.from({ length: 5 }, (_, i) => `Imported ${i},1000`).join('\n');
  const res = await post(merchant(asD1(raw)), '/api/merchant/products/import', { csv, confirm: true });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  const rows = all<{ name: string; created_at: string }>(raw, "SELECT name, created_at FROM community_products WHERE name LIKE 'Imported %' ORDER BY created_at DESC");
  assert.equal(new Set(rows.map((r) => r.created_at)).size, 5, 'five rows, five instants');
  assert.deepEqual(rows.map((r) => r.name), ['Imported 0', 'Imported 1', 'Imported 2', 'Imported 3', 'Imported 4'], 'newest-first is file order');
});

test('B5: the merchant\'s own product list and follower list page without dropping a tie', async () => {
  const raw = withStore(seed());
  const ins = raw.prepare(
    `INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,created_at)
     VALUES (?,?,?,?,?,'hidden','draft',1000,'2026-05-01T00:00:00.000Z')`
  );
  for (let i = 0; i < 9; i++) ins.run(`d${i}`, 'm1', 's1', `ali3d-d-${i}`, `D ${i}`);
  const fol = raw.prepare(`INSERT INTO follows (user_id, merchant_id, created_at) VALUES (?, 'm1', '2026-05-01T00:00:00.000Z')`);
  for (let i = 0; i < 9; i++) {
    raw.prepare(`INSERT INTO users (id,name,email,password_hash) VALUES (?, ?, ?, 'h')`).run(`f${i}`, `F${i}`, `f${i}@x.co`);
    fol.run(`f${i}`);
  }
  const m = merchant(asD1(raw));
  for (const [path, key] of [['/api/merchant/products', 'products'], ['/api/merchant/followers', 'followers']] as const) {
    const seen = new Set<string>();
    let cursor = '';
    for (let n = 0; n < 10; n++) {
      const page = await json(await get(m, `${path}?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      for (const r of page[key]) seen.add(r.id);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    assert.equal(seen.size, 9, `${path}: every row once`);
  }
});

// ============================================================ B27 — governorate

test('B27: the governorate is stored as a closed-list id; a legacy free-text value stays readable', async () => {
  const raw = withStore(seed());
  const m = merchant(asD1(raw));
  const gov = () => row<{ governorate: string }>(raw, "SELECT governorate FROM merchant_stores WHERE id = 's1'")!.governorate;

  // The settings form echoes the legacy text back: left exactly as it was.
  assert.equal((await patch(m, '/api/merchant/store', { governorate: 'بغداد - الكرادة', tagline: 'hi' })).status, 200);
  assert.equal(gov(), 'بغداد - الكرادة');

  // A new value that is not on the list is refused with a stable code.
  const bad = await patch(m, '/api/merchant/store', { governorate: 'Atlantis' });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'GOVERNORATE_INVALID');

  // A name in any of the three languages lands on the id.
  assert.equal((await patch(m, '/api/merchant/store', { governorate: 'بغداد' })).status, 200);
  assert.equal(gov(), 'baghdad');
  assert.equal((await patch(m, '/api/merchant/store', { governorate: 'هەولێر' })).status, 200);
  assert.equal(gov(), 'erbil');
});

test('B27: onboarding stores the id on the store and on the merchant', async () => {
  const raw = seed();
  const res = await post(merchant(asD1(raw)), '/api/merchant/onboard', { name: 'Ali 3D', slug: 'ali3d', governorate: 'Erbil' });
  assert.equal(res.status, 201, JSON.stringify(await json(res)));
  assert.equal(row<{ governorate: string }>(raw, "SELECT governorate FROM merchant_stores WHERE user_id = 'owner'")!.governorate, 'erbil');
  assert.equal(row<{ governorate: string }>(raw, "SELECT governorate FROM community_merchants WHERE user_id = 'owner'")!.governorate, 'erbil');
  const refused = await post(merchant(asD1(seed())), '/api/merchant/onboard', { name: 'Ali 3D', slug: 'ali3d', governorate: 'Atlantis' });
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'GOVERNORATE_INVALID');
});
