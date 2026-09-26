/**
 * «السعر: من الأقل» SORTS ON THE PRICE THIS VIEWER PAYS (catalog discovery S1).
 *
 * The listing resolves every candidate through the one pricing path before it
 * sorts, so a PRO member — whose PRO rung can reorder two machines — sees the
 * order of the prices on their own cards, and a guest sees theirs.
 *
 * Run: node --import tsx --test tests/listingSortResolvedPrice.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { productRoutes } from '../worker/routes/products';

function world() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('promem','Omar','o@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('a_pro','promem','Home','Omar','+9647709876543','Erbil, Ankawa 4','',1);
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap1','promem',1,'Omar','+9647709876543','Erbil, Ankawa 4','','approved');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('m_pro','promem','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO products (id, slug, name, description, price_iqd, pro_price_iqd, status, category_id, sub_category_id, stock, display_order) VALUES
      ('p_a', 'machine-a', 'Machine A', '', 100000, 70000, 'active', 'cat_printers', 'cat_printers_fdm', 1, 0),
      ('p_b', 'machine-b', 'Machine B', '', 90000, 88000, 'active', 'cat_printers', 'cat_printers_fdm', 1, 1),
      ('p_c', 'machine-c', 'Machine C', '', 95000, NULL, 'active', 'cat_printers', 'cat_printers_fdm', 1, 2);
  `);
  const db = asD1(raw);
  const guest = stubApp(db, null, (a) => a.route('/api/products', productRoutes));
  const pro = stubApp(db, { id: 'promem', role: 'customer', email: 'o@x.co' }, (a) => a.route('/api/products', productRoutes));
  return { guest, pro };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const order = (b: Record<string, any>) => (b.products as Array<{ id: string; display_price_iqd: number }>).map((p) => `${p.id}:${p.display_price_iqd}`);

test('a PRO viewer\'s rung changes the price_asc order; a guest keeps the regular order', async () => {
  const { guest, pro } = world();
  const g = await json(await get(guest, '/api/products?category=cat_printers&sort=price_asc'));
  assert.deepEqual(order(g), ['p_b:90000', 'p_c:95000', 'p_a:100000']);
  const p = await json(await get(pro, '/api/products?category=cat_printers&sort=price_asc'));
  assert.deepEqual(order(p), ['p_a:70000', 'p_b:88000', 'p_c:95000'], 'the PRO price of A (70,000) puts it first');
  const d = await json(await get(pro, '/api/products?category=cat_printers&sort=price_desc'));
  assert.deepEqual(order(d), ['p_c:95000', 'p_b:88000', 'p_a:70000']);
});

test('the price filter reads the same resolved number the sort does', async () => {
  const { guest, pro } = world();
  const g = await json(await get(guest, '/api/products?category=cat_printers&price=-80000'));
  assert.equal(g.total, 0);
  const p = await json(await get(pro, '/api/products?category=cat_printers&price=-80000'));
  assert.deepEqual(order(p), ['p_a:70000']);
});

test('the member facet is relative to the viewer: a PRO already pays the PRO rung', async () => {
  const { guest, pro } = world();
  assert.equal((await json(await get(guest, '/api/products?category=cat_printers&member=1'))).total, 2);
  assert.equal((await json(await get(pro, '/api/products?category=cat_printers&member=1'))).total, 0);
});
