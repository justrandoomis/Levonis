/**
 * FIVE MORE SURFACES WHERE 0075's COUNTER RULE DID NOT REACH — the second
 * adversarial round.
 *
 * Migration 0075 gave a (model x pre-order) cell an OPTIONAL capacity and each
 * of its routes an optional quota, and DECISION 4 says the ORDER TYPE alone
 * picks which counter a sale moves: `products.inventory_mode`'s row for a
 * direct sale, the route's own quota or the cell's shared pool for a
 * pre-order. Never both, never a sum, never the model's stock for a pre-order.
 * `tests/stockByOrderType.test.ts` pins that for a bare line and
 * `tests/stockByOrderTypeBundle.test.ts` for a bundle component. This file
 * pins the five doors that were still outside it, each reproduced against the
 * real routers and the real migrations:
 *
 *  S1  THE MYSTERY DOOR WAS OUTSIDE THE RULE ENTIRELY. `loadCandidates`
 *      resolved every pool candidate with `resolveStock` and the checkout
 *      reserved `cand.targets` verbatim, so a PRE-ORDER mystery offer reserved
 *      the drawn member's DIRECT SHELF — taking a unit from under the direct
 *      buyer racing it — while the import quota that sale was actually
 *      spending was never consulted and could be oversold without bound. A
 *      member with nine on the shelf and a pre-order cell of ONE sold all
 *      nine.
 *
 *  S2  THE PRODUCT PAGE AND THE ADD DOOR ANSWERED ABOUT DIFFERENT COUNTERS.
 *      `POST /api/products/:slug/quote` never parsed `optionValueIds` and
 *      asked `capacityFrom` with a SINGLE value, so on a multi-group product
 *      whose only tracked quota lives on the second group's value the page
 *      published `{tracked: false, available: null, max_qty: 99}` — a stepper
 *      to 99 — and the add door then refused the same selection
 *      `QTY_UNAVAILABLE` "Only 1 left".
 *
 *  S3  THE WRITE DOOR CREATED WHAT THE READ DOORS TREAT AS UNMODELLED. Two
 *      TRACKED pre-order cells on values a customer must choose TOGETHER is a
 *      configuration with no one counter, so every read resolves
 *      `PREORDER_CAPACITY_AMBIGUOUS` — but `PUT /:id/fulfillment` accepted it
 *      with `{"success": true}` and `warnings: []`. The product became
 *      permanently unsellable as a pre-order while the product page went on
 *      publishing a live quota, and the admin had been told the save worked.
 *
 *  S4  A LEGACY CART LINE WAS DESCRIBED AS ONE THING AND JUDGED AS ANOTHER.
 *      `statedAvailability` delegated to `unusableOrderType`, which answers
 *      null for any stated value that is not exactly `direct_sale` or
 *      `pre_order` — so a line with `fulfillment_type = ''` and a stored
 *      `transport_method`, exactly the shape migration 0073 leaves behind,
 *      came back untouched while `POST /api/orders` typed it `pre_order` from
 *      that transport and refused it.
 *
 *  S5  THE ONE FACT THAT TELLS A FULL QUOTA FROM AN EMPTY SHELF REACHED THE
 *      ADMIN UNTRANSLATED. The bundle preview's blocking banner rendered
 *      `({b.reason})` verbatim, so an Arabic-first admin read
 *      «<product> — المطلوب 1, المتاح 0 (PREORDER_CAPACITY_EXHAUSTED)» on the
 *      screen they open to diagnose it.
 *
 * A GREEN ROUTE PROVES NOTHING HERE: every one of these defects returned 200.
 * So each assertion below names the exact counter — the row, the column and
 * the ledger scope — rather than the status code.
 *
 * Run: npx tsx --test tests/capacitySurfaces2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, stubApp, get, post, json, all, row, type App, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { seedCatalogue, orderBody } from './lib/bundles';
import { addMysteryOffer } from './lib/mysteryOffer';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const boss: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };

const shopApp = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/products', productRoutes);
  });
const adminApp = (db: unknown) => stubApp(db, boss, (a) => a.route('/api/admin/products', adminProductRelationsRoutes));
const put = (a: App, path: string, body: unknown) =>
  a.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Every counter this file cares about, read straight out of the four real
 *  tables, so an assertion names a row rather than a status code. */
const counters = (raw: DatabaseSync) => ({
  shelf: all<{ id: string; stock: number | null; stock_reserved: number }>(
    raw,
    'SELECT id, stock, stock_reserved FROM products WHERE stock_reserved <> 0 ORDER BY id'
  ),
  cells: all<{ id: string; capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT id, capacity, capacity_reserved FROM product_option_fulfillment ORDER BY id'
  ),
  routes: all<{ id: string; capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT id, capacity, capacity_reserved FROM product_option_transports ORDER BY id'
  ),
  ledger: all<{ scope: string; scope_id: string; qty: number; kind: string }>(
    raw,
    'SELECT scope, scope_id, qty, kind FROM inventory_ledger ORDER BY rowid'
  ),
});

// =====================================================================
//  S1 — A PRE-ORDER MYSTERY SPENDS THE IMPORT QUOTA, NEVER THE SHELF
// =====================================================================
//
// The smallest shop in which the defect is a sentence: ONE pre-order-only
// candidate with NINE units on its shelf and a pre-order cell that holds ONE.
// The two numbers are deliberately different and deliberately far apart — a
// fixture where they matched could not tell which one had been reserved.

interface PreorderMemberSpec {
  /** The member's DIRECT shelf. Nine, so "the shelf was taken" is visible. */
  shelf?: number | null;
  /** The (model x pre-order) shared pool. */
  cell?: number | null;
  /** Air's OWN quota. null = air draws on the shared pool above. */
  air?: number | null;
}

function seedPreorderMystery(o: PreorderMemberSpec = {}): DatabaseSync {
  const { shelf = 9, cell = 1, air = null } = o;
  const raw = seedCatalogue();
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('mp_pre','fil-pre','Filament Pre','فتيل مسبق','فتیلی پێشوەخت',30000,'active',
            ${shelf === null ? 'NULL' : shelf},'[]','[]',
            'pre_order','["pre_order"]',
            '[{"method":"air","active":true,"commission_iqd":3000},{"method":"sea","active":true,"commission_iqd":1500}]',
            '["https://cdn/pre.png"]','BASE','{"is_spool":true}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active)
      VALUES ('pog_pre','mp_pre','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,availability_type)
      VALUES ('pov_pre','mp_pre','pog_pre','Standard','عادي',0,1,NULL,'pre_order');
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity,capacity_reserved)
      VALUES ('ofl_pre','mp_pre','pov_pre','pre_order',1,${cell === null ? 'NULL' : cell},0);
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,surcharge_iqd,capacity,capacity_reserved)
      VALUES ('otr_air','mp_pre','ofl_pre','air',1,3000,${air === null ? 'NULL' : air},0),
             ('otr_sea','mp_pre','ofl_pre','sea',1,1500,NULL,0);

    INSERT INTO mystery_pools (id,name,kind) VALUES ('mpl_pre','Pre-order pool','preorder');
    INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,family_id,weight,active)
      VALUES ('mpe_pre','mpl_pre','mp_pre','["pov_pre"]','','',1,1);
  `);
  addMysteryOffer(raw, { spoolQty: 1, poolId: 'mpl_pre' });
  raw.exec(
    `UPDATE mystery_offers SET direct_pool_id = NULL, preorder_pool_id = 'mpl_pre',
            allow_direct = 0, allow_preorder = 1 WHERE product_id = 'p_mystery'`
  );
  return raw;
}

/** One pre-order mystery box, bought through the real cart and checkout. */
const buyMysteryBox = async (db: unknown, qty = 1, method = 'air') => {
  const app = shopApp(db);
  const add = await post(app, '/api/cart/items', {
    productId: 'p_mystery',
    qty,
    transportMethod: method,
    mysteryMode: 'preorder',
  });
  if (add.status !== 200) return { add, order: null as Response | null, body: await json(add) };
  const order = await post(app, '/api/orders', orderBody({ transportMethod: method }));
  return { add, order, body: await json(order) };
};

test('a PRE-ORDER mystery reserves the drawn member’s import quota and never its shelf', async () => {
  const raw = seedPreorderMystery({ shelf: 9, cell: 1 });
  const db = asD1(raw);

  const { order, body } = await buyMysteryBox(db);
  assert.equal(order?.status, 200, JSON.stringify(body));
  assert.equal(body.order.shipping_type, 'preorder_air', 'the order is not a pre-order at all');

  const c = counters(raw);
  // THE SHELF IS UNTOUCHED. Without the fix this read
  // [{ id: 'mp_pre', stock: 9, stock_reserved: 1 }] — a pre-order holding a
  // unit a direct buyer was entitled to.
  assert.deepEqual(c.shelf, [], 'a pre-order mystery reserved the drawn member’s DIRECT shelf');
  assert.equal(
    row<{ stock_reserved: number }>(raw, 'SELECT stock_reserved FROM products WHERE id = ?', 'mp_pre')!.stock_reserved,
    0
  );
  // THE IMPORT QUOTA IS THE COUNTER THAT MOVED, by exactly one.
  assert.deepEqual(c.cells, [{ id: 'ofl_pre', capacity: 1, capacity_reserved: 1 }]);
  // And the ledger names that row, so the release has something to aim at.
  assert.deepEqual(c.ledger, [{ scope: 'preorder', scope_id: 'ofl_pre', qty: 1, kind: 'reserve' }]);
});

test('the import quota BOUNDS a pre-order mystery — the second box is refused, with the shelf still full', async () => {
  const raw = seedPreorderMystery({ shelf: 9, cell: 1 });
  const db = asD1(raw);

  const first = await buyMysteryBox(db);
  assert.equal(first.order?.status, 200, JSON.stringify(first.body));

  // A second buyer, a second box, against a quota with nothing left in it.
  // Without the fix the wheel was bounded by the SHELF, so this sold — and so
  // did seven more after it.
  const second = await buyMysteryBox(db);
  const status = second.order ? second.order.status : second.add.status;
  assert.notEqual(status, 200, 'the offer sold a second unit against a quota of one');

  const c = counters(raw);
  assert.deepEqual(c.cells, [{ id: 'ofl_pre', capacity: 1, capacity_reserved: 1 }], 'the quota was oversold');
  assert.deepEqual(c.shelf, [], 'the shelf paid for a pre-order');
  assert.equal(c.ledger.length, 1, 'a second reservation was written');

  // THE REFUSAL CARRIES NO COUNT (§8.2 row 18). A number here would name a
  // candidate's own counter, which is the before-and-after oracle on the pick.
  const text = JSON.stringify(second.body);
  assert.ok(!/\b[1-9]\d*\s+pre-order place/.test(text), `the refusal names a pool count: ${text}`);
});

test('the quota a mystery spool holds is releasable — cancelling gives the place back, exactly once', async () => {
  // A HELD UNIT MUST ALWAYS BE RELEASABLE. Moving the mystery door onto the
  // capacity rows is only safe if the release aims at the SAME row: the ledger
  // names `product_option_fulfillment.id`, and a release that missed it would
  // strand the place for ever with no screen able to say where it went.
  const raw = seedPreorderMystery({ shelf: 9, cell: 1 });
  const db = asD1(raw);

  const bought = await buyMysteryBox(db);
  assert.equal(bought.order?.status, 200, JSON.stringify(bought.body));
  const orderId = String(bought.body.order.id);
  assert.deepEqual(counters(raw).cells, [{ id: 'ofl_pre', capacity: 1, capacity_reserved: 1 }]);

  const cancelled = await json(await post(shopApp(db), `/api/orders/${orderId}/cancel`, { reason: 'changed my mind' }));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled).slice(0, 300));
  assert.deepEqual(
    counters(raw).cells,
    [{ id: 'ofl_pre', capacity: 1, capacity_reserved: 0 }],
    'the place was never given back — the quota is stranded'
  );
  assert.deepEqual(
    counters(raw).ledger.map((l) => `${l.kind}:${l.scope}:${l.scope_id}`),
    ['reserve:preorder:ofl_pre', 'release:preorder:ofl_pre']
  );

  // Exactly once: a replayed cancel moves nothing.
  await post(shopApp(db), `/api/orders/${orderId}/cancel`, { reason: 'changed my mind' });
  assert.equal(counters(raw).ledger.length, 2, 'a repeated cancel wrote a second release');

  // And the place really is for sale again.
  const again = await buyMysteryBox(db);
  assert.equal(again.order?.status, 200, JSON.stringify(again.body));
  assert.deepEqual(counters(raw).cells, [{ id: 'ofl_pre', capacity: 1, capacity_reserved: 1 }]);
  assert.deepEqual(counters(raw).shelf, [], 'the replacement order took the shelf instead');
});

test('a route with its OWN quota is the counter a mystery spool spends — not the shared pool', async () => {
  // Air holds ONE of its own; the shared pool holds fifty. A draw on air must
  // spend air's row, leave the pool alone, and stop at one.
  const raw = seedPreorderMystery({ shelf: 9, cell: 50, air: 1 });
  const db = asD1(raw);

  const first = await buyMysteryBox(db, 1, 'air');
  assert.equal(first.order?.status, 200, JSON.stringify(first.body));

  const after = counters(raw);
  assert.deepEqual(
    after.routes.find((r) => r.id === 'otr_air'),
    { id: 'otr_air', capacity: 1, capacity_reserved: 1 },
    'air’s own quota did not move'
  );
  assert.deepEqual(
    after.cells,
    [{ id: 'ofl_pre', capacity: 50, capacity_reserved: 0 }],
    'the shared pool was charged as well — one sale, two counters'
  );
  assert.deepEqual(after.ledger, [{ scope: 'preorder_transport', scope_id: 'otr_air', qty: 1, kind: 'reserve' }]);

  // Air is now full. Sea still draws on the fifty-unit shared pool, so the
  // same offer is still sellable by sea — the whole point of a per-route quota.
  const airAgain = await buyMysteryBox(db, 1, 'air');
  assert.notEqual(
    airAgain.order ? airAgain.order.status : airAgain.add.status,
    200,
    'air sold a second unit against a quota of one'
  );
});

test('a DIRECT mystery pool still spends the shelf — the rule cuts both ways', async () => {
  const raw = seedPreorderMystery({ shelf: 9, cell: 1 });
  // The same member, in a DIRECT pool this time. Its pre-order cell is
  // irrelevant to a direct sale and must not be touched.
  raw.exec(`
    UPDATE products SET selling_type='direct_sale', sale_types='["direct_sale"]' WHERE id='mp_pre';
    UPDATE product_option_values SET availability_type='direct_sale' WHERE id='pov_pre';
    UPDATE mystery_pools SET kind='direct' WHERE id='mpl_pre';
    UPDATE mystery_offers SET direct_pool_id='mpl_pre', preorder_pool_id=NULL,
           allow_direct=1, allow_preorder=0 WHERE product_id='p_mystery';
  `);
  const db = asD1(raw);

  const app = shopApp(db);
  const add = await post(app, '/api/cart/items', { productId: 'p_mystery', qty: 1, mysteryMode: 'direct' });
  assert.equal(add.status, 200, JSON.stringify(await json(add)));
  const order = await post(app, '/api/orders', orderBody());
  assert.equal(order.status, 200, JSON.stringify(await json(order)));

  const c = counters(raw);
  assert.deepEqual(c.shelf, [{ id: 'mp_pre', stock: 9, stock_reserved: 1 }], 'a direct sale stopped spending the shelf');
  assert.deepEqual(c.cells, [{ id: 'ofl_pre', capacity: 1, capacity_reserved: 0 }], 'a direct sale spent a pre-order quota');
  assert.deepEqual(c.ledger, [{ scope: 'base', scope_id: '', qty: 1, kind: 'reserve' }]);
});

// =====================================================================
//  S2 — THE QUOTE ANSWERS ABOUT THE COUNTER THE ADD DOOR CHARGES
// =====================================================================
//
// TWO option groups, so a customer's selection names TWO values at once, and
// the ONLY tracked pre-order quota sits on the SECOND group's value. That is
// the shape that tells "the endpoint read the whole selection" apart from "the
// endpoint read `optionId`": with one value it finds nothing to track.

function seedTwoGroups(capacity = 1): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('boss','Admin','a@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_multi','multi','Multi','متعدد','فرەیی',500000,'active',NULL,'[]','[]',
            'pre_order','["pre_order"]',
            '[{"method":"air","active":true,"commission_iqd":7500}]',
            '["https://cdn/m.png"]','BASE','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES
      ('g_model','p_multi','Model',0,1),
      ('g_edition','p_multi','Edition',1,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,availability_type) VALUES
      ('v_mini','p_multi','g_model','A1 mini','ايه1 ميني',0,1,NULL,'pre_order'),
      ('v_combo','p_multi','g_edition','Combo','كومبو',0,1,NULL,'pre_order');
    -- THE ONLY TRACKED QUOTA IN THE WHOLE PRODUCT, and it is on the SECOND
    -- group's value. The first group's model carries a cell with no limit.
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity) VALUES
      ('f_mini','p_multi','v_mini','pre_order',1,NULL),
      ('f_combo','p_multi','v_combo','pre_order',1,${capacity});
  `);
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)").run(JSON.stringify({ ordinary_iqd: 5000 }));
  return raw;
}

/** The body the page sends and the body the cart sends — deliberately the SAME
 *  object, because the whole defect was that the two doors read it differently. */
const multiSelection = (qty: number) => ({
  productId: 'p_multi',
  qty,
  optionId: 'v_mini',
  optionValueIds: ['v_mini', 'v_combo'],
  transportMethod: 'air',
  fulfillmentType: 'pre_order',
});

test('the quote publishes the same pre-order counter the add door charges on a multi-group product', async () => {
  const raw = seedTwoGroups(1);
  const db = asD1(raw);
  const app = shopApp(db);

  const quoted = await json(await post(app, '/api/products/multi/quote', multiSelection(2)));
  const a = quoted.availability;

  // WITHOUT THE FIX: { tracked: false, available: null, max_qty: 99 } and
  // qty_ok true — a stepper to 99 on a quota of one.
  assert.equal(a.preorder.capacity.tracked, true, 'the page reports the quota as untracked');
  assert.equal(a.preorder.capacity.available, 1);
  assert.equal(a.preorder.capacity.max_qty, 1, 'the page offers a ceiling the door will not honour');
  assert.equal(a.stock.max_qty, 1, 'the stepper ceiling is the pre-order counter, not an unconditional 99');
  assert.equal(a.qty_ok, false, 'the page says two is fine');
  assert.equal(a.selection.option_value_ids.length, 2, 'the endpoint dropped half the selection');

  // AND THE DOOR AGREES — the same body, the same counter, the same verdict.
  const refused = await post(app, '/api/cart/items', multiSelection(2));
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'QTY_UNAVAILABLE');

  // One is what both of them will sell.
  const ok = await post(app, '/api/cart/items', multiSelection(1));
  assert.equal(ok.status, 200, JSON.stringify(await json(ok)));
});

test('a quote that sends only the legacy optionId is answered exactly as before', async () => {
  // The storefront's own body (src/pages/Product.tsx sends `optionId` alone).
  // The fix must not change what it is told: the model it named has an
  // untracked cell, so the quota claims no limit.
  const raw = seedTwoGroups(1);
  const app = shopApp(asD1(raw));
  const quoted = await json(
    await post(app, '/api/products/multi/quote', { qty: 1, optionId: 'v_mini', transportMethod: 'air' })
  );
  assert.equal(quoted.availability.preorder.capacity.tracked, false);
  assert.equal(quoted.availability.preorder.capacity.available, null);
  assert.equal(quoted.availability.selection.option_value_ids.length, 1);
  // The PRICE the legacy body is quoted is byte for byte what it was: the
  // fix threads a selection into the availability, never into the resolver.
  assert.equal(quoted.quote.applied_iqd, 500000);
  assert.equal(quoted.quote.unit_subtotal_iqd, 500000 + 7500, 'the price the legacy body is quoted moved');
});

// =====================================================================
//  S3 — THE WRITE DOOR REFUSES WHAT THE READ DOORS CANNOT ANSWER
// =====================================================================

const cellPayload = (optionId: string, capacity: number | null) => ({
  option_id: optionId,
  fulfillment_type: 'pre_order',
  enabled: true,
  capacity,
  transports: [{ method: 'air', enabled: true, surcharge_iqd: 7500 }],
});

test('two TRACKED pre-order quotas on values chosen together are refused AT THE SAVE, naming both models', async () => {
  const raw = seedTwoGroups(1);
  // Start from a clean slate so the refusal is provably about the payload.
  raw.exec('DELETE FROM product_option_fulfillment');
  const db = asD1(raw);

  const res = await put(adminApp(db), '/api/admin/products/p_multi/fulfillment', {
    fulfillments: [cellPayload('v_mini', 20), cellPayload('v_combo', 50)],
  });
  const body = await json(res);

  // WITHOUT THE FIX this was 200 `{"success": true, ..., "warnings": []}` and
  // the product then refused every pre-order for ever.
  assert.equal(res.status, 400, `the ambiguous configuration was accepted: ${JSON.stringify(body)}`);
  assert.equal(body.code, 'PREORDER_CAPACITY_AMBIGUOUS');
  assert.match(String(body.error), /A1 mini/, 'the refusal does not name the first model');
  assert.match(String(body.error), /Combo/, 'the refusal does not name the second model');

  // NOTHING WAS WRITTEN. A refusal that half-saves is worse than the defect.
  assert.deepEqual(all(raw, 'SELECT id FROM product_option_fulfillment'), []);
});

test('a route quota counts as tracked for the same rule — a cell left blank does not hide it', async () => {
  const raw = seedTwoGroups(1);
  raw.exec('DELETE FROM product_option_fulfillment');
  const db = asD1(raw);

  const res = await put(adminApp(db), '/api/admin/products/p_multi/fulfillment', {
    fulfillments: [
      { ...cellPayload('v_mini', null), transports: [{ method: 'air', enabled: true, capacity: 20 }] },
      cellPayload('v_combo', 50),
    ],
  });
  assert.equal(res.status, 400, 'a quota hidden on a ROUTE slipped past the check');
  assert.equal((await json(res)).code, 'PREORDER_CAPACITY_AMBIGUOUS');
});

test('two tracked quotas in the SAME group are allowed — a group is a choice BETWEEN its values', async () => {
  const raw = seedTwoGroups(1);
  raw.exec(`
    DELETE FROM product_option_fulfillment;
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,availability_type)
      VALUES ('v_maxi','p_multi','g_model','A1 maxi','ايه1 ماكسي',1,1,NULL,'pre_order');
  `);
  const db = asD1(raw);

  const res = await put(adminApp(db), '/api/admin/products/p_multi/fulfillment', {
    fulfillments: [cellPayload('v_mini', 20), cellPayload('v_maxi', 50)],
  });
  assert.equal(res.status, 200, `a legal per-model quota pair was refused: ${JSON.stringify(await json(res))}`);
  assert.deepEqual(
    all<{ option_id: string; capacity: number }>(
      raw,
      'SELECT option_id, capacity FROM product_option_fulfillment ORDER BY option_id'
    ),
    [
      { option_id: 'v_maxi', capacity: 50 },
      { option_id: 'v_mini', capacity: 20 },
    ]
  );
});

test('an ordinary untracked save across two groups is untouched — this refuses nothing that exists today', async () => {
  // Migration 0075 adds `capacity` NULL to every row and copies nothing into
  // it, so no catalogue in existence has two tracked cells. A save that leaves
  // both blank must still work.
  const raw = seedTwoGroups(1);
  raw.exec('DELETE FROM product_option_fulfillment');
  const db = asD1(raw);
  const res = await put(adminApp(db), '/api/admin/products/p_multi/fulfillment', {
    fulfillments: [cellPayload('v_mini', null), cellPayload('v_combo', null)],
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
});

// =====================================================================
//  S4 — A LEGACY LINE IS READ AS THE ORDER TYPE THE DOOR WILL JUDGE IT AS
// =====================================================================
//
// The shape migration 0073 actually leaves behind: `fulfillment_type = ''`
// (the backfill fills it only where the named option row carries an
// `availability_type`, which a BASE-mode legacy line does not) beside a
// `transport_method` the customer really did choose.

function seedLegacyLine(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','A1','ايه1','ئەی١',500000,'active',NULL,'[]','[]',
            'direct_sale','["direct_sale","pre_order"]',
            '[{"method":"air","active":true,"commission_iqd":7500}]',
            '["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_m','p_a1','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved)
      VALUES ('v_mini','p_a1','g_m','A1 mini','ايه1 ميني',0,1,7,0);
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity,capacity_reserved)
      VALUES ('f_direct','p_a1','v_mini','direct_sale',1,NULL,0),
             ('f_pre','p_a1','v_mini','pre_order',1,1,1);
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,surcharge_iqd,capacity)
      VALUES ('t_air','p_a1','f_pre','air',1,7500,NULL);
    -- THE LEGACY ROW. No stated order type; a transport the customer chose.
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,
                            shipping_method_id,transport_method,fulfillment_type,warranty_plan_id,qty)
      VALUES ('ci_legacy','buyer','p_a1','v_mini','["v_mini"]','','','air','','',1);
  `);
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)").run(JSON.stringify({ ordinary_iqd: 5000 }));
  return raw;
}

test('a legacy cart line with a transport is READ as the pre-order the checkout will judge it as', async () => {
  const raw = seedLegacyLine();
  const db = asD1(raw);

  // The stored row really is the legacy shape — this is a read defect.
  assert.equal(
    row<{ fulfillment_type: string; transport_method: string }>(
      raw,
      'SELECT fulfillment_type, transport_method FROM cart_items WHERE id = ?',
      'ci_legacy'
    )!.fulfillment_type,
    ''
  );

  const cart = await json(await get(shopApp(db), '/api/cart'));
  const a = cart.items[0].availability;

  // WITHOUT THE FIX: mode "direct_sale", reason null, stock.max_qty 7 — a
  // direct sale off a shelf the door is never going to read for this line.
  assert.equal(a.mode, 'preorder', 'the cart re-typed a pre-order line as a direct sale');
  assert.equal(a.reason, 'PREORDER_CAPACITY_EXHAUSTED');
  assert.equal(a.qty_ok, false);
  assert.equal(a.stock.max_qty, 0, 'the cart offered the SHELF as this line’s ceiling');
  assert.equal(a.preorder.capacity.available, 0);
  // The shelf is a fact and is not rewritten to mean "sold out".
  assert.equal(a.stock.available, 7);

  // AND THE DOOR AGREES: it types the same row from the same transport.
  const refused = await post(shopApp(db), '/api/orders', orderBody());
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'PREORDER_CAPACITY_EXHAUSTED');
});

test('a legacy line whose own row states NOTHING is still returned untouched', async () => {
  // No stated type AND no transport: the checkout's third step is a DEFAULT,
  // not a fact about the line, so the descriptive fallback stays the answer and
  // no refusal is invented.
  const raw = seedLegacyLine();
  raw.exec("UPDATE cart_items SET transport_method = '' WHERE id = 'ci_legacy'");
  const cart = await json(await get(shopApp(asD1(raw)), '/api/cart'));
  const a = cart.items[0].availability;
  assert.equal(a.mode, 'direct_sale');
  assert.equal(a.reason, null, 'a line that states nothing was handed a refusal');
  assert.equal(a.stock.max_qty, 7);
  assert.equal(a.qty_ok, true);
});

// =====================================================================
//  S5 — THE BLOCKING REASON REACHES THE ADMIN AS A SENTENCE
// =====================================================================
//
// Static assertions over the source, in the house pattern of
// tests/bundleAdminUi.test.ts and tests/stockByOrderTypeUi.test.ts: there is no
// browser DOM runner in this repo.

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const PANEL = 'src/components/adminBundles/AdminBundles.tsx';

/** The `code: { ar, en }` keys of the panel's own reason table. */
function reasonTable(): Map<string, { ar: string; en: string }> {
  const src = read(PANEL);
  const from = src.indexOf('const BLOCKING_REASONS');
  assert.ok(from > 0, 'the panel has no blocking-reason table at all');
  const body = src.slice(from, src.indexOf('\n};', from));
  const out = new Map<string, { ar: string; en: string }>();
  for (const m of body.matchAll(/(\b[A-Z_]{4,}\b):\s*\{\s*\n?\s*ar:\s*'([^']+)',\s*\n?\s*en:\s*'([^']+)',?\s*\n?\s*\}/g)) {
    out.set(m[1], { ar: m[2], en: m[3] });
  }
  return out;
}

test('every blocking reason the server can emit has an admin-readable sentence', () => {
  const table = reasonTable();
  // Derived from the server, not hand-listed: the `StockResolution.error`
  // union plus the two verdicts `bundleAvailability` adds itself. A reason
  // added there with no sentence here fails this test instead of reaching an
  // admin as a Latin identifier.
  const union = read('worker/lib/inventory.ts');
  const slice = union.slice(union.indexOf('  error:'), union.indexOf('| null;', union.indexOf('  error:')));
  const fromResolution = [...slice.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(fromResolution.includes('PREORDER_CAPACITY_AMBIGUOUS'), 'the error union was not found');

  const composition = read('worker/lib/bundleComposition.ts');
  const fromVerdicts = ['OUT_OF_STOCK', 'PREORDER_CAPACITY_EXHAUSTED'].filter((c) =>
    composition.includes(`'${c}'`)
  );
  assert.equal(fromVerdicts.length, 2, 'bundleAvailability no longer emits the two counter verdicts');

  for (const code of [...fromResolution, ...fromVerdicts]) {
    assert.ok(table.has(code), `no admin sentence for blocking reason ${code}`);
  }
});

test('a full import quota and an empty shelf do not read the same to an admin', () => {
  const table = reasonTable();
  const quota = table.get('PREORDER_CAPACITY_EXHAUSTED')!;
  const shelf = table.get('OUT_OF_STOCK')!;
  assert.notEqual(quota.ar, shelf.ar, 'the two counters share one Arabic sentence');
  assert.notEqual(quota.en, shelf.en);
  // Arabic, not a transliteration of the code.
  for (const [code, t] of table) {
    assert.match(t.ar, /[؀-ۿ]/, `${code} has no Arabic sentence`);
    assert.ok(!t.ar.includes(code), `${code} is "translated" to itself`);
  }
});

test('the banner renders the sentence, and keeps the raw code only as a dimmed aside', () => {
  const src = read(PANEL);
  const from = src.indexOf('preview.availability.blocking.map');
  assert.ok(from > 0, 'the blocking banner is gone');
  const banner = src.slice(from, from + 700);
  assert.match(banner, /whyBlocked\(b\.reason\)/, 'the banner still prints the machine code as the only reason');
  // The code survives for support, but not as the whole answer.
  assert.match(banner, /\(\{b\.reason\}\)/, 'the raw code is no longer available to quote to support');
  assert.ok(
    banner.indexOf('whyBlocked(b.reason)') < banner.indexOf('({b.reason})'),
    'the code is printed before the sentence'
  );
});

test('no Kurdish is invented for these codes — the fallback is the Arabic, on purpose', () => {
  const src = read(PANEL);
  const from = src.indexOf('const BLOCKING_REASONS');
  const body = src.slice(from, src.indexOf('\n};', from));
  assert.ok(!/\bckb:/.test(body), 'a ckb string was added to the blocking table — see the Sorani rule');
  assert.match(src.slice(Math.max(0, from - 1400), from), /ckb: THE ARABIC IS DELIBERATELY REPEATED/);
});
