/**
 * THE LEGACY PRODUCT DOORS ARE RETIRED ONTO THE STORE API — audit 01 B10.
 *
 * `POST /api/community/my-store/products` and `DELETE …/:id` wrote products
 * with none of the store rules: `store_id` NULL, no selling entitlement or
 * suspension check, any image URL (an off-platform tracking pixel on the
 * community pages), and a hard DELETE that took ordered products out from
 * under their order lines. They stayed reachable while the community was
 * closed, so they were the way around every rule `/api/merchant/products`
 * enforces.
 *
 * Now each answers 307 to the store route — the same method and body, which a
 * browser's fetch follows by itself — so an old client keeps working, under
 * the store rules. These tests follow the redirect the way a browser does and
 * check what the store route then decides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1, stubApp, send, json, row, count, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { communityRoutes } from '../worker/routes/community';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';

const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };
const BARE: StubUser = { id: 'bare', role: 'customer', email: 'bare@x.co' };

const ORDER_COLS = `(id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)`;

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('owner','Ali','owner@x.co','h','merchant'), ('bare','Sara','bare@x.co','h','customer'),
      ('buyer','Zaid','buyer@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at,source)
      VALUES ('mm','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','purchase');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m_bare','bare','Sara Prints');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
  `);
  return raw;
}

const app = (raw: ReturnType<typeof freshDb>, user: StubUser) =>
  stubApp(asD1(raw), user, (a) => {
    a.route('/api/community', communityRoutes);
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/merchant', merchantCatalogRoutes); // W2-F: the catalogue's own router
  });

/** What `fetch` does with a 307: the same method and body, to the Location. */
async function follow(a: ReturnType<typeof app>, method: string, path: string, body: unknown = {}) {
  const first = await send(a, method, path, body);
  assert.equal(first.status, 307, `${method} ${path} must hand the request on, not answer it`);
  const to = first.headers.get('location');
  assert.ok(to, 'a 307 names where to go');
  return { location: to, res: await send(a, method, to, body) };
}

test('the legacy create door hands the SAME request to the store API — and the store rules apply there', async () => {
  const raw = seed();
  const { location, res } = await follow(app(raw, OWNER), 'POST', '/api/community/my-store/products', {
    name: 'Bracket',
    price_iqd: 7000,
    images: ['https://tracker.example/pixel.gif?who=viewer', '/files/merchants/owner/public/aaaa1111.webp'],
  });
  assert.equal(location, '/api/merchant/products');
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const id = (await json(res)).product.id;
  const p = row<{ store_id: string | null; images: string }>(raw, 'SELECT store_id, images FROM community_products WHERE id = ?', id)!;
  assert.equal(p.store_id, 's1', 'a product belongs to a store — the legacy door wrote NULL');
  assert.deepEqual(JSON.parse(p.images), ['/files/merchants/owner/public/aaaa1111.webp'], 'only the merchant\'s own upload survives');
});

test('no store, a lapsed membership or a suspension is refused at the store door — the old door is no way around it', async () => {
  // A community merchant profile with no store: the legacy door used to write
  // a store-less product for exactly this person.
  const raw = seed();
  const bare = await follow(app(raw, BARE), 'POST', '/api/community/my-store/products', { name: 'Thing', price_iqd: 1000 });
  assert.equal(bare.res.status, 404);

  // A store whose PLUS has lapsed.
  raw.exec(`UPDATE memberships SET expires_at = '2026-02-01T00:00:00.000Z' WHERE id = 'mm'`);
  const lapsed = await follow(app(raw, OWNER), 'POST', '/api/community/my-store/products', { name: 'Thing', price_iqd: 1000 });
  assert.equal(lapsed.res.status, 403);

  // A merchant Levonis suspended, with a live membership.
  raw.exec(`UPDATE memberships SET expires_at = '2099-01-01T00:00:00.000Z' WHERE id = 'mm';
            UPDATE community_merchants SET status = 'suspended' WHERE id = 'm1'`);
  const suspended = await follow(app(raw, OWNER), 'POST', '/api/community/my-store/products', { name: 'Thing', price_iqd: 1000 });
  assert.equal(suspended.res.status, 403);

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_products'), 0, 'nothing was written by any of them');
});

test('the legacy delete door archives an ordered product instead of deleting it out from under its order', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd)
      VALUES ('cp1','m1','s1','ali3d-bracket','Bracket','active','active',7000),
             ('cp2','m1','s1','ali3d-spare','Spare','active','active',7000);
    INSERT INTO orders ${ORDER_COLS} VALUES
      ('o1','buyer','delivered',7000,'m1','s1','merchant','store_product','{}','d','{}','wallet',7000,1500,0);
    INSERT INTO order_items (id,order_id,community_product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,seller_type)
      VALUES ('i1','o1','cp1','Bracket',1,7000,7000,'merchant');
  `);
  const a = app(raw, OWNER);

  const ordered = await follow(a, 'DELETE', '/api/community/my-store/products/cp1');
  assert.equal(ordered.location, '/api/merchant/products/cp1');
  assert.equal(ordered.res.status, 200);
  assert.equal((await json(ordered.res)).archived, true);
  assert.deepEqual(
    row(raw, "SELECT lifecycle, status FROM community_products WHERE id = 'cp1'"),
    { lifecycle: 'archived', status: 'hidden' },
    'the row an order line points at is still there'
  );
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM order_items WHERE community_product_id = 'cp1'"), 1);

  // Never ordered: the store route may delete it outright.
  const spare = await follow(a, 'DELETE', '/api/community/my-store/products/cp2');
  assert.equal(spare.res.status, 200);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_products WHERE id = 'cp2'"), 0);

  // Somebody else's product is not theirs to delete through either door.
  raw.exec(`INSERT INTO community_products (id,merchant_id,slug,name,status,lifecycle,price_iqd)
              VALUES ('cpx','m_bare','sara-x','X','active','active',1)`);
  const foreign = await follow(a, 'DELETE', '/api/community/my-store/products/cpx');
  assert.equal(foreign.res.status, 404);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_products WHERE id = 'cpx'"), 1);
});

test('the community routes write no product rows at all, and the profile editor sends merchants to /merchant', () => {
  const community = readFileSync(join(ROOT, 'worker/routes/community.ts'), 'utf8');
  assert.doesNotMatch(community, /INSERT\s+INTO\s+community_products/i);
  assert.doesNotMatch(community, /DELETE\s+FROM\s+community_products/i);
  assert.doesNotMatch(community, /UPDATE\s+community_products/i);

  const editProfile = readFileSync(join(ROOT, 'src/pages/EditProfile.tsx'), 'utf8');
  assert.doesNotMatch(editProfile, /import\s+MerchantDashboard\b/, 'the legacy «Merchant Mode» editor is no longer mounted');
  assert.match(editProfile, /to="\/merchant"/);
});
