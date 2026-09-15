/**
 * CHANGING A QUANTITY MAY NOT DESTROY A PRICE, AND AN ACCOUNT THAT MAY NOT SEE
 * A COST MAY NOT ERASE ONE.
 *
 * `PUT /api/admin/products/:id/fulfillment` is a whole-set replace: the parser
 * reads thirteen money columns off the request and the upsert wrote every one
 * of them back. Its only client, the admin fulfilment panel, has NO price
 * fields on its transport rows at all — so an admin who opened that panel to
 * set a pre-order quota and pressed save wrote NULL over every stored route
 * price. The owner's rule is "لا تغيّر الأسعار": this change exists to move a
 * QUANTITY, and it must not cost a price to do it.
 *
 * The same door has the mirror-image problem with scope. The GET correctly
 * strips `cost_iqd` from an assistant admin, so that account is handed a
 * payload with the cost missing and sends it straight back — and the replace
 * writes the absence as NULL. The one account forbidden from READING a cost
 * could destroy it, silently, without ever seeing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, json, put, row, type StubUser } from './fixtures/app';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';

const owner: StubUser = { id: 'boss', role: 'admin', email: 'b@x.co' };
const assistant: StubUser = { id: 'asst', role: 'admin', email: 'a@x.co', admin_scope: 'assistant' } as StubUser;

const appFor = (db: unknown, user: StubUser) =>
  stubApp(db, user, (a) => a.route('/api/admin/products', adminProductRelationsRoutes));

/** One model with a pre-order cell and an air route, both carrying real money. */
function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','B','b@x.co','h','admin'),
      ('asst','A','a@x.co','h','admin');
    UPDATE users SET admin_scope = 'assistant' WHERE id = 'asst';
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','A1','ايه1','ئەی١',500000,'active',NULL,'[]','[]',
            'pre_order','["pre_order"]','[{"method":"air","active":true}]',
            '["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_m','p_a1','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved)
      VALUES ('v_mini','p_a1','g_m','A1 mini','ميني',0,1,4,0);
    INSERT INTO product_option_fulfillment
      (id,product_id,option_id,fulfillment_type,enabled,capacity,
       regular_price_iqd,prime_price_iqd,pro_price_iqd,cost_iqd)
      VALUES ('f_pre','p_a1','v_mini','pre_order',1,30, 550000,530000,520000,400000);
    INSERT INTO product_option_transports
      (id,product_id,fulfillment_id,method,enabled,capacity,surcharge_iqd,
       regular_price_iqd,prime_price_iqd,pro_price_iqd,cost_iqd)
      VALUES ('t_air','p_a1','f_pre','air',1,10,7500, 620000,590000,575000,410000);
  `);
  return raw;
}

const cellRow = (raw: DatabaseSync) =>
  row<Record<string, number | null>>(
    raw,
    'SELECT capacity, regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd FROM product_option_fulfillment WHERE id = ?',
    'f_pre'
  )!;
const routeRow = (raw: DatabaseSync) =>
  row<Record<string, number | null>>(
    raw,
    'SELECT capacity, surcharge_iqd, regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd FROM product_option_transports WHERE id = ?',
    't_air'
  )!;

/** Exactly what src/components/adminProducts/FulfillmentPanel.tsx sends: a
 *  quota and a surcharge, and not one price on the route. */
const panelBody = (capacity: number, routeCapacity: number) => ({
  fulfillments: [
    {
      option_id: 'v_mini',
      fulfillment_type: 'pre_order',
      enabled: true,
      sort: 0,
      capacity,
      transports: [{ method: 'air', enabled: true, sort: 0, surcharge_iqd: 7500, capacity: routeCapacity }],
    },
  ],
});

test('saving an order-type quota does not wipe the prices the panel never sent', async () => {
  const raw = seed();
  const before = { cell: cellRow(raw), route: routeRow(raw) };

  const res = await json(
    await put(appFor(asD1(raw), owner), '/api/admin/products/p_a1/fulfillment', panelBody(25, 8))
  );
  assert.equal(res.success, true, JSON.stringify(res));

  assert.equal(cellRow(raw).capacity, 25, 'the quantity this save exists to change did change');
  assert.equal(routeRow(raw).capacity, 8);

  for (const k of ['regular_price_iqd', 'prime_price_iqd', 'pro_price_iqd', 'cost_iqd'] as const) {
    assert.equal(cellRow(raw)[k], before.cell[k], `the cell's ${k} was destroyed by a quantity edit`);
    assert.equal(routeRow(raw)[k], before.route[k], `the route's ${k} was destroyed by a quantity edit`);
  }
});

test('a payload that DOES mention money is still taken at its word, nulls included', async () => {
  const raw = seed();
  const body = panelBody(25, 8) as unknown as {
    fulfillments: Array<Record<string, unknown> & { transports: Array<Record<string, unknown>> }>;
  };
  body.fulfillments[0].regular_price_iqd = 600000;
  body.fulfillments[0].prime_price_iqd = null;
  const res = await json(
    await put(appFor(asD1(raw), owner), '/api/admin/products/p_a1/fulfillment', body)
  );
  assert.equal(res.success, true, JSON.stringify(res));

  assert.equal(cellRow(raw).regular_price_iqd, 600000, 'a stated price is written');
  assert.equal(cellRow(raw).prime_price_iqd, null, 'and a deliberately cleared one is cleared — that is how it is done');
  // The ROUTE said nothing about money, so its prices stand.
  assert.equal(routeRow(raw).regular_price_iqd, 620000);
});

test('an assistant admin cannot erase a cost it is not allowed to see', async () => {
  const raw = seed();
  // The GET strips the cost for this account, so the payload it sends back has
  // no cost key — through no fault of its own.
  const res = await json(await put(appFor(asD1(raw), assistant), '/api/admin/products/p_a1/fulfillment', panelBody(25, 8)));
  assert.equal(res.success, true, JSON.stringify(res));

  assert.equal(cellRow(raw).capacity, 25, 'the quota edit it IS allowed to make went through');
  assert.equal(cellRow(raw).cost_iqd, 400000, 'and the cost it may not read is still there');
  assert.equal(routeRow(raw).cost_iqd, 410000);
});
