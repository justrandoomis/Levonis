/**
 * THE CART'S «تغيير الخيارات» SHEET PRINTED THE WRONG SHELF.
 *
 * It read `المخزون: {variantView.stock}`, and `stock` on a cart line is the
 * product's BASE row (worker/routes/cart.ts calls it "Legacy field: the base
 * row"). So a pre-order line — not served from a shelf at all — read
 * «المخزون: 0», and an option-tracked product read a number belonging to no
 * selection. The per-selection figure has always been `availability.stock`.
 *
 * `sheetShelf` is LIFTED OUT OF src/pages/Cart.tsx and run against the REAL
 * cart route's payload, so this passes only because the shipped code behaves.
 *
 * Run: node --import tsx --test tests/cartVariantSheetStock.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, stubApp, get, json, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';

const buyer: StubUser = { id: 'u1', role: 'customer', email: 's@x.co' };
const cartApp = (db: unknown) => stubApp(db, buyer, (a) => a.route('/api/cart', cartRoutes));
const CART_SRC = readFileSync(join(ROOT, 'src/pages/Cart.tsx'), 'utf8');

function liftSheetShelf(): (item: unknown) => number | null {
  const m = /const sheetShelf = \(item: CartItem\)[^=]*=> \{\n([\s\S]*?)\n {2}\};/.exec(CART_SRC);
  assert.ok(m, 'sheetShelf is a single arrow helper in src/pages/Cart.tsx');
  return new Function('item', m[1]) as (item: unknown) => number | null;
}

const lineOf = async (raw: DatabaseSync, id: string) => {
  const cart = await json(await get(cartApp(asD1(raw)), '/api/cart'));
  const line = (cart.items as Array<{ id: string }>).find((i) => i.id === id);
  assert.ok(line, `the line is in the cart — ${id}`);
  return line as { id: string; stock: number | null; availability: Record<string, unknown> };
};

/** Base row says 99; the chosen model's own shelf says 4. */
function seedOptionTracked(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode)
    VALUES ('p_opt','opt','Nozzle','فوهة',25000,'active',99,'[]','[]',
            'direct_sale','["direct_sale"]','[]','[]','OPTION');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g','p_opt','Size',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,availability_type)
    VALUES ('v_04','p_opt','g','0.4','0.4',0,1,4,'');
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,
                            shipping_method_id,transport_method,warranty_plan_id,qty)
    VALUES ('ci_opt','u1','p_opt','v_04','["v_04"]','','','','',1);
  `);
  return raw;
}

/** A pre-order-only model with a LAND route; the base row stores 0. */
function seedPreorder(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','Bambu Lab A1','بامبو A1','بامبو A1',725000,'active',0,'[]','[]',
            'pre_order','["pre_order"]','[]','["https://cdn/a1.png"]','PRODUCT','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g','p_a1','Model',0,1);
    INSERT INTO product_option_values
      (id,product_id,group_id,name_en,name_ar,sort,active,stock,availability_type,variant_key,variant_label)
    VALUES ('v_a1','p_a1','g','A1','A1',0,1,0,'','a1','A1');
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity)
    VALUES ('f_a1_p','p_a1','v_a1','pre_order',1,NULL);
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,surcharge_iqd)
    VALUES ('t_a1_land','p_a1','f_a1_p','land',1,25000);
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,
                            shipping_method_id,transport_method,warranty_plan_id,qty)
    VALUES ('ci_pre','u1','p_a1','v_a1','["v_a1"]','','','land','',1);
  `);
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)").run(
    JSON.stringify({ ordinary_iqd: 5000 })
  );
  return raw;
}

test('an option-tracked line shows the chosen model’s shelf, not the base row', async () => {
  const line = await lineOf(seedOptionTracked(), 'ci_opt');
  assert.equal(line.stock, 99, 'the legacy field is still the base row');
  assert.equal(liftSheetShelf()(line), 4, 'the sheet reads the selection’s own shelf');
});

test('a pre-order line prints no stock line at all', async () => {
  const line = await lineOf(seedPreorder(), 'ci_pre');
  assert.equal(line.availability.mode, 'preorder', 'the real route resolves a pre-order');
  assert.equal(line.stock, 0, 'the base row the old sheet printed as «المخزون: 0»');
  assert.equal(liftSheetShelf()(line), null);
});

test('an untracked shelf prints nothing — untracked is not zero', () => {
  const sheetShelf = liftSheetShelf();
  assert.equal(sheetShelf({ stock: 7, availability: { mode: 'direct_sale', stock: { tracked: false, available: null } } }), null);
  assert.equal(sheetShelf({ stock: 7 }), null, 'no availability block, no guess from the base row');
});

test('the sheet no longer prints the legacy base-row field', () => {
  assert.doesNotMatch(CART_SRC, /variantView\.stock\b/);
  assert.match(CART_SRC, /const shelf = sheetShelf\(variantView\)/);
});

/**
 * `GET /api/cart` keeps `mode: 'preorder'` on a pre-order line even when no
 * route is usable (it reports NO_TRANSPORT_OFFERED instead), but `mode` is the
 * resolver's answer, and `unavailable` does not say which order type the line
 * is. The line's own journey does, so it hides the shelf independently.
 */
test('the line’s stated journey alone hides the stock line, whatever the mode', () => {
  const sheetShelf = liftSheetShelf();
  const tracked0 = { tracked: true, available: 0 };
  assert.equal(sheetShelf({ transport_method: 'air', availability: { mode: 'unavailable', stock: tracked0 } }), null);
  // A direct line that sold out is still a true «المخزون: 0».
  assert.equal(sheetShelf({ transport_method: '', availability: { mode: 'unavailable', stock: tracked0 } }), 0);
});
