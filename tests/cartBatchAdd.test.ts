/**
 * SEVERAL COLOURS IN ONE ADD, ALL OR NOTHING (docs/ux/COLOUR-QUANTITIES.md §4).
 *
 * A customer who means «50 black, 5 white, 1 beige» could only add one colour
 * and one quantity at a time, and one add of «beige × 56» reached an order.
 * `POST /api/cart/items/batch` takes every colour in one press. These hold its
 * contract on the REAL cart routes over every migration (node:sqlite):
 *
 *   * every line lands with its own colour and quantity, and `added[]` says so;
 *   * a refused line adds NOTHING — the table is byte-identical before and
 *     after — and every refused line is named, not only the first;
 *   * lines that share one stock counter are judged on their sum;
 *   * a merge held to the ceiling is reported, never silent;
 *   * the emptying of a cart of another type and the new lines are one batch;
 *   * a press whose answer was lost is refused when pressed again
 *     (CART_LINES_CHANGED), so 50/5/1 never becomes 100/10/2;
 *   * the lines reach the checkout as three order lines on three counters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, all, count, failingD1, freshDb, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { acceptedPolicies } from './lib/policies';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';

const BUYER: StubUser = { id: 'u1', role: 'customer', email: 's@x.co' };

const PLANS = JSON.stringify(
  [
    { id: 'wp_ext12', title_ar: 'ضمان +12', title_en: 'Extended +12', duration_months: 12, duration_kind: 'extension', fee_iqd: 0, fee_percent: 7.5, order: 0, active: true },
    { id: 'wp_ext24', title_ar: 'ضمان +24', title_en: 'Extended +24', duration_months: 24, duration_kind: 'extension', fee_iqd: 0, fee_percent: 10, order: 1, active: true },
  ]
);

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u1','Sara','s@x.co','h','customer'),
      ('zain','Zain','zain@x.co','h','merchant');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_1','u1','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);

    -- One filament whose COLOURS carry the stock (the incident's shape): one spool option, three colours.
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_pla','pla','PLA Basic','بي إل إيه',24000,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','[]','COLOR');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_spool','p_pla','Spool',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock) VALUES
      ('ov_1kg','p_pla','g_spool','With spool — 1 kg','مع بكرة — 1 كغ',0,1,NULL);
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES
      ('c_black','p_pla','Black','أسود','#000000',0,1,206),
      ('c_white','p_pla','Cold White','أبيض بارد','#F5F7FA',1,1,195),
      ('c_beige','p_pla','Beige','بيج','#E8DCC4',2,1,4);

    -- The same three colours on ONE shelf of 52 (the base row), and under ONE option row of 52.
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_base','pla-base','PETG Basic','بي إي تي جي',20000,'active',52,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE'),
             ('p_opt','pla-opt','ABS Basic','إيه بي إس',22000,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','[]','OPTION');
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES
      ('b_black','p_base','Black','أسود','#000000',0,1,NULL),
      ('b_white','p_base','White','أبيض','#FFFFFF',1,1,NULL),
      ('o_black','p_opt','Black','أسود','#000000',0,1,NULL),
      ('o_white','p_opt','White','أبيض','#FFFFFF',1,1,NULL);
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_opt','p_opt','Spool',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock) VALUES
      ('ov_opt','p_opt','g_opt','1 kg','1 كغ',0,1,52);

    -- A pre-order product, for a cart of the other shipping type.
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_pre','pre','Imported printer','طابعة',500000,'active',0,'[]','[]','pre_order','["pre_order"]',
              '[{"method":"air","commission_iqd":25000,"active":true}]','[]');

    -- A printer in two colours that sells an extended warranty.
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,warranty_plans,ops_policy)
      VALUES ('p_x1','x1','Printer X1','طابعة X1',899000,'active',20,'[]','[]','direct_sale','["direct_sale"]','[]','[]',
              '${PLANS}','{"serialized":true,"warranty_base_months":12}');
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES
      ('x_black','p_x1','Black','أسود','#000000',0,1,NULL),
      ('x_white','p_x1','White','أبيض','#FFFFFF',1,1,NULL);
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_cq_printers','cq-test-printers','طابعات',1);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_x1','cat_cq_printers',0);

    -- A store, for the 0114 seller trigger.
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_zain','zain','Zain Print','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_zain','m_zain','zain','zainprint','Zain Print','active');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_zain','m_zain','s_zain','zain-spool','Zain spool','active','active',9000,100,0);
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_zain','zain','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
  `);
}

function setup(dbOverride?: (raw: DatabaseSync) => { db: unknown }) {
  const raw = freshDb();
  seed(raw);
  const db = dbOverride ? dbOverride(raw).db : asD1(raw);
  const app = stubApp(db, BUYER, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });
  return { raw, app };
}

const KG = ['ov_1kg'];
const incident = (inCart?: [number, number, number]) => ({
  productId: 'p_pla',
  fulfillmentType: 'direct_sale',
  lines: [
    { optionValueIds: KG, colorId: 'c_black', qty: 50, ...(inCart ? { inCart: inCart[0] } : {}) },
    { optionValueIds: KG, colorId: 'c_white', qty: 5, ...(inCart ? { inCart: inCart[1] } : {}) },
    { optionValueIds: KG, colorId: 'c_beige', qty: 1, ...(inCart ? { inCart: inCart[2] } : {}) },
  ],
});

const cartRows = (raw: DatabaseSync) =>
  all<Record<string, unknown>>(raw, "SELECT * FROM cart_items WHERE user_id = 'u1' ORDER BY id");
const qtyByColour = (raw: DatabaseSync, product = 'p_pla') =>
  Object.fromEntries(
    all<{ color_id: string; qty: number }>(raw, "SELECT color_id, qty FROM cart_items WHERE user_id = 'u1' AND product_id = ?", product).map((r) => [
      r.color_id,
      r.qty,
    ])
  );

// ─────────────────────────────────────────────────────────────── 1. the add

test('1. black 50, white 5, beige 1 land as three lines, each with its own colour and quantity', async () => {
  const { raw, app } = setup();
  const res = await post(app, '/api/cart/items/batch', incident());
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(qtyByColour(raw), { c_black: 50, c_white: 5, c_beige: 1 });
  for (const r of cartRows(raw)) {
    assert.equal(r.option_value_ids, '["ov_1kg"]');
    assert.equal(r.option_id, 'ov_1kg');
    assert.equal(r.fulfillment_type, 'direct_sale');
  }
  assert.deepEqual(
    body.added.map((a: Record<string, unknown>) => [a.index, a.color_id, a.requested, a.before, a.after, a.capped]),
    [
      [0, 'c_black', 50, 0, 50, false],
      [1, 'c_white', 5, 0, 5, false],
      [2, 'c_beige', 1, 0, 1, false],
    ]
  );
  assert.ok(body.added.every((a: Record<string, unknown>) => typeof a.line_id === 'string' && a.line_id));
  assert.equal(body.items.length, 3, 'the whole cart comes back, as GET /api/cart gives it');
});

// ─────────────────────────────────────────────────────────── 2–3. refusals

test('2. one colour out of stock: 400 OUT_OF_STOCK naming it, and the table is byte-identical — even with a line that would have merged', async () => {
  const { raw, app } = setup();
  raw.exec("UPDATE product_colors SET stock = 0 WHERE id = 'c_beige'");
  // Black already in the cart: the batch's black line would merge into it.
  const first = await post(app, '/api/cart/items', { productId: 'p_pla', optionValueIds: KG, colorId: 'c_black', qty: 10, fulfillmentType: 'direct_sale' });
  assert.equal(first.status, 200, JSON.stringify(await json(first.clone())));
  const before = JSON.stringify(cartRows(raw));
  const res = await post(app, '/api/cart/items/batch', incident());
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.code, 'OUT_OF_STOCK');
  assert.equal(body.details.lines.length, 1);
  assert.equal(body.details.lines[0].index, 2);
  assert.equal(body.details.lines[0].color_id, 'c_beige');
  assert.equal(body.details.lines[0].code, 'OUT_OF_STOCK');
  assert.equal(JSON.stringify(cartRows(raw)), before, 'nothing was added and nothing merged');
});

test('3. every refused line is reported, not only the first', async () => {
  const { raw, app } = setup();
  raw.exec("UPDATE product_colors SET stock = 0 WHERE id = 'c_beige'");
  const body = incident();
  body.lines[1].qty = 999; // white has 195
  const res = await post(app, '/api/cart/items/batch', body);
  const out = await json(res);
  assert.equal(res.status, 400);
  assert.equal(out.code, 'QTY_UNAVAILABLE', 'the first refused line speaks for the request');
  assert.deepEqual(
    out.details.lines.map((l: Record<string, unknown>) => [l.index, l.code]),
    [
      [1, 'QTY_UNAVAILABLE'],
      [2, 'OUT_OF_STOCK'],
    ]
  );
  assert.equal(out.details.lines[0].available, 195, 'the remainder rides as data, as the single door sends it');
  assert.equal(out.details.lines[0].preorder, false);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'u1'"), 0);
});

// ─────────────────────────────────────────────────────── 4. shared counters

for (const [label, productId, colours, optionValueIds] of [
  ['BASE (one shelf on the product row)', 'p_base', ['b_black', 'b_white'], [] as string[]],
  ['OPTION (one option row both colours sit under)', 'p_opt', ['o_black', 'o_white'], ['ov_opt']],
] as const) {
  test(`4. ${label}: 50 + 5 on a shelf of 52 is refused as one shared counter, and nothing is written`, async () => {
    const { raw, app } = setup();
    const res = await post(app, '/api/cart/items/batch', {
      productId,
      fulfillmentType: 'direct_sale',
      lines: [
        { optionValueIds, colorId: colours[0], qty: 50 },
        { optionValueIds, colorId: colours[1], qty: 5 },
      ],
    });
    const body = await json(res);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.code, 'QTY_UNAVAILABLE');
    assert.equal(body.details.shared, true);
    assert.equal(body.details.available, 52);
    assert.deepEqual(body.details.line_indexes, [0, 1]);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'u1'"), 0);
    // Each alone would have passed: the single door takes 50.
    const single = await post(app, '/api/cart/items', { productId, optionValueIds, colorId: colours[0], qty: 50, fulfillmentType: 'direct_sale' });
    assert.equal(single.status, 200);
  });
}

test('4. with stock per COLOUR the same request passes: each colour is its own counter', async () => {
  const { raw, app } = setup();
  raw.exec("UPDATE product_colors SET stock = 52 WHERE product_id = 'p_pla'");
  const res = await post(app, '/api/cart/items/batch', { ...incident(), lines: incident().lines.slice(0, 2) });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.deepEqual(qtyByColour(raw), { c_black: 50, c_white: 5 });
});

// ─────────────────────────────────────────────────────── 5. merge and ceiling

test('5. a merge held to the ceiling is reported: 120 in the cart + 50 on a shelf of 150 gives 150, capped', async () => {
  const { raw, app } = setup();
  raw.exec("UPDATE product_colors SET stock = 150 WHERE id = 'c_black'");
  assert.equal(
    (await post(app, '/api/cart/items', { productId: 'p_pla', optionValueIds: KG, colorId: 'c_black', qty: 120, fulfillmentType: 'direct_sale' })).status,
    200
  );
  const res = await post(app, '/api/cart/items/batch', incident([120, 0, 0]));
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const black = body.added[0];
  assert.deepEqual([black.before, black.requested, black.after, black.capped], [120, 50, 150, true]);
  assert.equal(body.added[1].capped, false);
  assert.deepEqual(qtyByColour(raw), { c_black: 150, c_white: 5, c_beige: 1 });
});

// ─────────────────────────────────────────────────────────── 6. the shape

test('6. a duplicate identity, 41 lines and a composition product are refused before anything is read twice', async () => {
  const { raw, app } = setup();
  const dup = incident();
  dup.lines[2].colorId = 'c_black';
  const d = await post(app, '/api/cart/items/batch', dup);
  const db = await json(d);
  assert.equal(d.status, 400);
  assert.equal(db.code, 'BATCH_DUPLICATE_LINE');
  assert.deepEqual(db.details.line_indexes, [0, 2]);

  const many = { ...incident(), lines: Array.from({ length: 41 }, (_, i) => ({ optionValueIds: KG, colorId: `c_${i}`, qty: 1 })) };
  const m = await post(app, '/api/cart/items/batch', many);
  assert.equal(m.status, 400);
  assert.equal((await json(m)).code, 'BATCH_TOO_MANY_LINES');

  const none = await post(app, '/api/cart/items/batch', { ...incident(), lines: [] });
  assert.equal(none.status, 400);
  assert.equal((await json(none)).code, 'VALIDATION');

  // A product that is sellable and then becomes a composition (bundle) row.
  assert.equal((await post(app, '/api/cart/items/batch', incident())).status, 200);
  raw.exec("DELETE FROM cart_items WHERE user_id = 'u1'");
  raw.exec("UPDATE products SET composition = 'bundle' WHERE id = 'p_base'");
  const comp = await post(app, '/api/cart/items/batch', { productId: 'p_base', lines: [{ optionValueIds: [], colorId: 'b_black', qty: 1 }] });
  assert.equal(comp.status, 400);
  assert.equal((await json(comp)).code, 'BATCH_NOT_SUPPORTED');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'u1'"), 0);
});

// ─────────────────────────────────────────────── 7. the other shipping type

test('7. a cart of the other shipping type: refused with nothing written; with replaceCart, emptied and filled in ONE batch', async () => {
  const { raw, app } = setup();
  assert.equal((await post(app, '/api/cart/items', { productId: 'p_pre', qty: 1, fulfillmentType: 'pre_order', transportMethod: 'air' })).status, 200);
  const before = JSON.stringify(cartRows(raw));
  const res = await post(app, '/api/cart/items/batch', incident());
  const body = await json(res);
  // The single door's own status for this code (worker/routes/cart.ts `enforceCartScope`).
  assert.equal(res.status, 400);
  assert.equal(body.code, 'CART_SHIPPING_CONFLICT');
  assert.equal(JSON.stringify(cartRows(raw)), before);

  const ok = await post(app, '/api/cart/items/batch', { ...incident(), replaceCart: true });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.deepEqual(qtyByColour(raw), { c_black: 50, c_white: 5, c_beige: 1 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'u1' AND product_id = 'p_pre'"), 0);
});

test('7. …and when that batch fails, the cart is NOT left empty: the emptying and the lines are one transaction', async () => {
  let failing!: ReturnType<typeof failingD1>['failing'];
  const { raw, app } = setup((r) => {
    const f = failingD1(r);
    failing = f.failing;
    return f;
  });
  assert.equal((await post(app, '/api/cart/items', { productId: 'p_pre', qty: 1, fulfillmentType: 'pre_order', transportMethod: 'air' })).status, 200);
  const before = JSON.stringify(cartRows(raw));
  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO cart_items/.test(s.sql));
  const res = await post(app, '/api/cart/items/batch', { ...incident(), replaceCart: true });
  assert.equal(res.status, 500);
  assert.equal(JSON.stringify(cartRows(raw)), before, 'no state exists with the cart emptied and the lines missing');
  const batch = failing.batches.at(-1)!;
  assert.equal(batch.filter((sql) => sql.startsWith('DELETE FROM cart_items')).length, 1, 'the emptying rides the same batch');
  assert.equal(batch.filter((sql) => sql.startsWith('INSERT INTO cart_items')).length, 3);
});

// ───────────────────────────────────────────────── 8. a press whose answer was lost

test('8. inCart: a mismatch is 409 CART_LINES_CHANGED with nothing written', async () => {
  const { raw, app } = setup();
  assert.equal(
    (await post(app, '/api/cart/items', { productId: 'p_pla', optionValueIds: KG, colorId: 'c_white', qty: 2, fulfillmentType: 'direct_sale' })).status,
    200
  );
  const before = JSON.stringify(cartRows(raw));
  const res = await post(app, '/api/cart/items/batch', incident([0, 0, 0]));
  const body = await json(res);
  assert.equal(res.status, 409);
  assert.equal(body.code, 'CART_LINES_CHANGED');
  assert.deepEqual(body.details.lines, [{ index: 1, in_cart: 2 }]);
  assert.equal(JSON.stringify(cartRows(raw)), before);
});

test('8. pressing twice after a lost answer gives CART_LINES_CHANGED, and the quantities stay 50/5/1, not 100/10/2', async () => {
  const { raw, app } = setup();
  const first = await post(app, '/api/cart/items/batch', incident([0, 0, 0]));
  assert.equal(first.status, 200);
  // The answer never reached the page; the customer presses again with what the page believed.
  const again = await post(app, '/api/cart/items/batch', incident([0, 0, 0]));
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'CART_LINES_CHANGED');
  assert.deepEqual(qtyByColour(raw), { c_black: 50, c_white: 5, c_beige: 1 });
});

test('8. inCart on some lines only is a VALIDATION refusal', async () => {
  const { app } = setup();
  const body = incident([0, 0, 0]);
  delete (body.lines[2] as { inCart?: number }).inCart;
  const res = await post(app, '/api/cart/items/batch', body);
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'VALIDATION');
});

// ─────────────────────────────────────────────── 9. the warranty, per line

test('9. a warranty conflict on one colour of a printer is 409 naming that line, with nothing written', async () => {
  const { raw, app } = setup();
  assert.equal(
    (await post(app, '/api/cart/items', { productId: 'p_x1', colorId: 'x_black', qty: 1, warrantyPlanId: 'wp_ext24', fulfillmentType: 'direct_sale' })).status,
    200
  );
  const before = JSON.stringify(cartRows(raw));
  const res = await post(app, '/api/cart/items/batch', {
    productId: 'p_x1',
    fulfillmentType: 'direct_sale',
    warrantyPlanId: 'wp_ext12',
    lines: [
      { optionValueIds: [], colorId: 'x_white', qty: 1 },
      { optionValueIds: [], colorId: 'x_black', qty: 1 },
    ],
  });
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'CART_WARRANTY_CONFLICT');
  assert.deepEqual(body.details.lines.map((l: Record<string, unknown>) => [l.index, l.color_id]), [[1, 'x_black']]);
  assert.equal(JSON.stringify(cartRows(raw)), before);
});

// ─────────────────────────────────────────────── 10. the 0114 seller trigger

test('10. a store line landing between the read and the write: the seller refusal, with nothing of the batch written', async () => {
  let failing!: ReturnType<typeof failingD1>['failing'];
  const { raw, app } = setup((r) => {
    const f = failingD1(r);
    failing = f.failing;
    return f;
  });
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /INSERT INTO cart_items/.test(s.sql))) {
      raw
        .prepare(`INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,qty) VALUES ('m_race','u1','merchant','m_zain','s_zain','cp_zain',1)`)
        .run();
    }
  };
  const res = await post(app, '/api/cart/items/batch', incident());
  const body = await json(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'CART_SELLER_CONFLICT');
  assert.deepEqual(
    cartRows(raw).map((r) => r.id),
    ['m_race'],
    'the store line is the only line: none of the three colours was written'
  );
});

// ───────────────────────────────────────────── 11. a colour option group (0194)

test('11. a colour OPTION GROUP (0194 kind = color): three lines that differ only in the colour value', async () => {
  const { raw, app } = setup();
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_grp','pla-grp','PLA Matte','بي إل إيه مطفي',26000,'active',500,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active,kind) VALUES
      ('gg_spool','p_grp','Spool',0,1,''),
      ('gg_col','p_grp','Colour',1,1,'color');
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock) VALUES
      ('gv_1kg','p_grp','gg_spool','1 kg','1 كغ',0,1,NULL),
      ('gv_black','p_grp','gg_col','Charcoal','فحمي',0,1,NULL),
      ('gv_white','p_grp','gg_col','Ivory White','أبيض عاجي',1,1,NULL),
      ('gv_beige','p_grp','gg_col','Desert Tan','رملي',2,1,NULL);
  `);
  const res = await post(app, '/api/cart/items/batch', {
    productId: 'p_grp',
    fulfillmentType: 'direct_sale',
    lines: [
      { optionValueIds: ['gv_1kg', 'gv_black'], colorId: '', qty: 50 },
      { optionValueIds: ['gv_1kg', 'gv_white'], colorId: '', qty: 5 },
      { optionValueIds: ['gv_1kg', 'gv_beige'], colorId: '', qty: 1 },
    ],
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const rows = all<{ option_value_ids: string; qty: number }>(
    raw,
    "SELECT option_value_ids, qty FROM cart_items WHERE user_id = 'u1' AND product_id = 'p_grp' ORDER BY qty DESC"
  );
  assert.deepEqual(rows, [
    { option_value_ids: '["gv_1kg","gv_black"]', qty: 50 },
    { option_value_ids: '["gv_1kg","gv_white"]', qty: 5 },
    { option_value_ids: '["gv_1kg","gv_beige"]', qty: 1 },
  ]);
});

// ─────────────────────────────────────────────────────── 12. end to end

test('12. end to end: the batch cart checks out as three order lines, each reserved on its own colour', async () => {
  const { raw, app } = setup();
  assert.equal((await post(app, '/api/cart/items/batch', incident())).status, 200);
  const res = await post(app, '/api/orders', {
    addressId: 'addr_1',
    deliveryMethodId: 'standard',
    paymentMethodId: 'cash',
    useWallet: false,
    usePoints: false,
    itemIds: [],
    idempotencyKey: `colour-batch-${Date.now()}`,
    policyAcceptance: acceptedPolicies(),
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 600));
  const orderId = String(body.order?.id ?? body.orderId ?? body.id ?? row<{ id: string }>(raw, 'SELECT id FROM orders')!.id);
  const items = all<{ color_id: string; qty: number; option_snapshot: string }>(
    raw,
    'SELECT color_id, qty, option_snapshot FROM order_items WHERE order_id = ? ORDER BY qty DESC',
    orderId
  );
  assert.deepEqual(
    items.map((i) => [i.color_id, i.qty, i.option_snapshot]),
    [
      ['c_black', 50, 'With spool — 1 kg / Black'],
      ['c_white', 5, 'With spool — 1 kg / Cold White'],
      ['c_beige', 1, 'With spool — 1 kg / Beige'],
    ]
  );
  const reserves = all<{ scope: string; scope_id: string; qty: number }>(
    raw,
    "SELECT scope, scope_id, qty FROM inventory_ledger WHERE order_id = ? AND kind = 'reserve' ORDER BY qty DESC",
    orderId
  );
  assert.deepEqual(
    reserves.map((r) => [r.scope, r.scope_id, r.qty]),
    [
      ['color', 'c_black', 50],
      ['color', 'c_white', 5],
      ['color', 'c_beige', 1],
    ]
  );
  const invoice = row<{ snapshot: string }>(raw, 'SELECT snapshot FROM invoices WHERE order_id = ? ORDER BY revision DESC', orderId);
  assert.ok(invoice, 'the checkout issues the invoice');
  const lines = (JSON.parse(invoice.snapshot) as { lines: Array<{ qty: number }> }).lines;
  assert.deepEqual(lines.map((l) => l.qty).sort((a, b) => b - a), [50, 5, 1], 'three invoice lines');
});

// ───────────────────────────────────── 13. product-level refusals, once

test('13. a catalog-only product is 409 PRICE_NOT_AVAILABLE; a members-only offer is 403 MEMBERSHIP_REQUIRED once, not per line', async () => {
  const { raw, app } = setup();
  // Publish first (the first customer request), then take the published price away.
  assert.equal((await post(app, '/api/cart/items/batch', incident())).status, 200);
  raw.exec("DELETE FROM cart_items WHERE user_id = 'u1'");
  raw.exec(`
    INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,offer_price_mode,offer_price_iqd,
                               discount_percent,discount_iqd,plus_price_iqd,locked_preview,active)
    VALUES ('product','p_pla','ofw_pla',NULL,NULL,'["pro"]','discount_iqd',NULL,NULL,1000,NULL,1,1)
  `);
  const members = await post(app, '/api/cart/items/batch', incident());
  const mb = await json(members);
  assert.equal(members.status, 403, JSON.stringify(mb));
  assert.equal(mb.code, 'MEMBERSHIP_REQUIRED');
  assert.equal(mb.details.lines, undefined, 'a product-level refusal, said once');
  raw.exec("DELETE FROM offer_windows WHERE id = 'ofw_pla'");

  // A product shown with no price yet (DECISIONS row 240): visible, never published, so never sellable.
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_cat','pla-cat','PLA Silk','بي إل إيه حريري',0,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','[]','COLOR');
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES
      ('s_gold','p_cat','Gold','ذهبي','#D4AF37',0,1,10),
      ('s_silver','p_cat','Silver','فضي','#C0C0C0',1,1,10);
  `);
  const res = await post(app, '/api/cart/items/batch', {
    productId: 'p_cat',
    fulfillmentType: 'direct_sale',
    lines: [
      { optionValueIds: [], colorId: 's_gold', qty: 2 },
      { optionValueIds: [], colorId: 's_silver', qty: 1 },
    ],
  });
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'PRICE_NOT_AVAILABLE');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'u1'"), 0);
});
