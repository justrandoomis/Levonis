/**
 * Owner report: setting a direct-sale shelf to 0 in Quick Price failed with
 * "stock cannot be below 2; those units are reserved by live direct-sale
 * orders". A figure under the held units now means "nothing more to sell":
 * the row keeps exactly the held units (available = 0) and the answer says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, stubApp, put, json, all, type StubUser } from './fixtures/app';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';

const boss: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

test('a direct stock of 0 over held units is kept at the held count, not refused', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_m','matte','PLA Matte','PLA Matte','PLA Matte',25000,'active',NULL,'[]','[]',
            'direct_sale','["direct_sale"]','[]','[]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g','p_m','Colour',0,1);
    INSERT INTO product_option_values
      (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved,availability_type,variant_key,variant_label) VALUES
      ('v_ivory','p_m','g','Ivory White','Ivory White',0,1,5,2,'','ivory','Ivory White');
  `);
  const app = stubApp(asD1(raw), boss, (a) => a.route('/api/admin/products', adminProductRelationsRoutes));
  const res = await put(app, '/api/admin/products/p_m/fulfillment', {
    fulfillments: [{ option_id: 'v_ivory', fulfillment_type: 'direct_sale', enabled: true, transports: [] }],
    direct_stock: [{ scope: 'option', id: 'v_ivory', stock: 0, low_stock_threshold: null }],
    inventory_mode: 'OPTION',
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.stock_notices, [{ scope: 'option', id: 'v_ivory', requested: 0, stored: 2, reserved: 2 }]);
  assert.deepEqual(
    all(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'v_ivory'),
    [{ stock: 2, reserved: 2 }]
  );
});
