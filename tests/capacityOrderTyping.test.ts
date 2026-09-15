/**
 * ONE ROW, ONE ORDER TYPE, ONE COUNTER — the three doors that still typed a
 * line one way and charged it another, reproduced against the real routers and
 * the real migrations.
 *
 * 0075 gave a (model × pre-order) cell an OPTIONAL capacity and each of its
 * routes a quota of its own, and DECISION 4 says the ORDER TYPE alone picks
 * which counter a sale moves. `statedOrderType` was introduced so the read
 * model and the checkout would type one row identically. These three doors
 * were outside it:
 *
 *  T1  THE CART'S TWO WRITE DOORS PASSED THE RAW `fulfillmentType`.
 *      `unusableOrderType` answers null for anything that is not exactly
 *      `direct_sale` or `pre_order`, so a body carrying a TRANSPORT and no
 *      stated type — exactly what src/components/orders/ReorderButton.tsx
 *      builds, since it never sends `fulfillmentType` — was validated against
 *      `saleAvailability`'s DESCRIPTIVE fallback, admitted against the SHELF,
 *      and stored as a row that both `GET /api/cart` and `POST /api/orders`
 *      then type `pre_order`. The add answered 200 and the SAME response's
 *      `items[0]` already read `{"mode":"preorder"}`: admitted against one
 *      counter and described by another in one payload.
 *
 *  T2  THE CART AND THE CHECKOUT DEFAULTED A BARE ROW TWO DIFFERENT WAYS. A
 *      row that states NEITHER a type NOR a transport left `statedOrderType`
 *      at '', and the two sides then resolved that '' apart: the cart left the
 *      descriptive fallback standing (a live import quota) while the checkout
 *      applied `|| 'direct_sale'` and judged the SHELF. On a dual-mode model
 *      with an empty shelf and an open quota the cart said
 *      `{"mode":"preorder","qty_ok":true}` and the door said OUT_OF_STOCK.
 *
 *  T3  THE TXT PREVIEW NEVER PLANNED, SO IT NEVER ASKED ABOUT THE COUNTER.
 *      `POST /api/admin/template/parse` parses, merges and validates the
 *      DOCUMENT; every refusal that lives in the PLAN — `refuseStrandedCapacity`
 *      above all — was invisible to it. A file lowering a cell's capacity below
 *      the units it is holding previewed `errors: []`, `warnings: []` and a
 *      tidy diff, and was then refused at apply. The CSV door gained this
 *      pre-flight last round; the TXT door, the one an owner uses most, had not.
 *
 * A GREEN STATUS PROVES NOTHING HERE: T1 and T2 both answered 200 on the door
 * that was wrong. So the assertions name the ROW, the COLUMN and the LEDGER
 * SCOPE that moved, and every fixture keeps the shelf and the quota far apart
 * so "which counter answered" is always readable.
 *
 * Run: npx tsx --test tests/capacityOrderTyping.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { zipSync, strToU8 } from 'fflate';
import { asD1, freshDb, stubApp, get, post, patch, json, all, row, ctx, type App, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { orderBody } from './lib/bundles';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const boss: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };

const shopApp = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/products', productRoutes);
  });

const adminApp = (db: unknown) =>
  stubApp(db, boss, (a) => {
    a.route('/api/admin/template', templateRoutes);
    a.route('/api/admin/products-v2', adminProductsRoutes);
  });

/** Every counter this file cares about, read straight out of the real tables. */
const counters = (raw: DatabaseSync) => ({
  /** The SHELF: the model's own row, which is where `inventory_mode = OPTION` keeps it. */
  shelf: all<{ id: string; stock: number | null; reserved: number }>(
    raw,
    'SELECT id, stock, reserved FROM product_option_values ORDER BY id'
  ),
  base: all<{ id: string; stock: number | null; stock_reserved: number }>(
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

const cartLines = (raw: DatabaseSync) =>
  all<{ id: string; qty: number; transport_method: string; fulfillment_type: string }>(
    raw,
    'SELECT id, qty, transport_method, fulfillment_type FROM cart_items ORDER BY id'
  );

interface ShopSpec {
  /** The model's shelf — `product_option_values.stock`. */
  shelf?: number | null;
  /** The (model × pre-order) SHARED pool. NULL = untracked. */
  cell?: number | null;
  /** Air's OWN quota. NULL = air draws on the shared pool above. */
  air?: number | null;
}

/**
 * ONE dual-mode model: a shelf a direct buyer reads and a pre-order cell a
 * pre-order buyer reads. The two numbers are always different, so an assertion
 * can never pass by accident on the counter it did not mean.
 *
 * `name_ku` carries the ARABIC text. The Kurdish (ckb) of this shop is the
 * owner's to write by hand; nothing here invents it.
 */
function seedShop(o: ShopSpec = {}): DatabaseSync {
  const { shelf = 7, cell = 0, air = null } = o;
  const raw = freshDb();
  const n = (v: number | null) => (v === null ? 'NULL' : String(v));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','A1','ايه1','ايه1',500000,'active',NULL,'[]','[]',
            'direct_sale','["direct_sale","pre_order"]',
            '[{"method":"air","active":true,"commission_iqd":7500}]',
            '["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_m','p_a1','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved)
      VALUES ('v_mini','p_a1','g_m','A1 mini','ايه1 ميني',0,1,${n(shelf)},0);
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity,capacity_reserved)
      VALUES ('f_direct','p_a1','v_mini','direct_sale',1,NULL,0),
             ('f_pre','p_a1','v_mini','pre_order',1,${n(cell)},0);
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,surcharge_iqd,capacity,capacity_reserved)
      VALUES ('t_air','p_a1','f_pre','air',1,7500,${n(air)},0);
  `);
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)").run(
    JSON.stringify({ ordinary_iqd: 5000 })
  );
  return raw;
}

/** A cart row written straight into the table, so its two typing columns are exact. */
const seedLine = (raw: DatabaseSync, o: { transport?: string; type?: string; qty?: number } = {}) => {
  raw.prepare(
    `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,
                             shipping_method_id,transport_method,fulfillment_type,warranty_plan_id,qty)
     VALUES ('ci_1','buyer','p_a1','v_mini','["v_mini"]','','',?,?,'',?)`
  ).run(o.transport ?? '', o.type ?? '', o.qty ?? 1);
};

/**
 * THE BODY `src/components/orders/ReorderButton.tsx` ACTUALLY BUILDS. It sends
 * the bought selection — option, colour, transport, warranty — and it does NOT
 * send `fulfillmentType`, because no order item carries one. That absence is
 * the whole of T1.
 */
const reorderBody = (qty = 1) => ({
  productId: 'p_a1',
  qty,
  optionId: 'v_mini',
  optionValueIds: ['v_mini'],
  transportMethod: 'air',
});

// =====================================================================
//  T1 — THE ADD DOOR JUDGES THE TYPE IT IS ABOUT TO STORE
// =====================================================================

test('an add that carries a transport and no stated type is judged as the PRE-ORDER it will be stored as', async () => {
  // Shelf 7, pre-order pool 0: tracked and EMPTY. The two counters disagree,
  // which is the only reason this defect is visible.
  const raw = seedShop({ shelf: 7, cell: 0 });
  const res = await post(shopApp(asD1(raw)), '/api/cart/items', reorderBody());
  const body = await json(res);

  // WITHOUT THE FIX this was 200 `{"success":true}` whose own `items[0]`
  // already read `{"mode":"preorder","reason":"PREORDER_CAPACITY_EXHAUSTED"}` —
  // admitted against one counter and described by another in one payload, which
  // is what this message prints when it fails.
  const describedAs = JSON.stringify(body.items?.[0]?.availability ?? body);
  assert.equal(res.status, 400, `the add was admitted against the shelf and described as ${describedAs.slice(0, 300)}`);
  assert.equal(body.code, 'PREORDER_CAPACITY_EXHAUSTED');
  // "Out of stock" would be a lie about a pre-order: there is no shelf.
  assert.match(String(body.error), /pre-order quota/i);

  // AND NOTHING WAS WRITTEN. A row admitted here is a row the cart screen then
  // describes against a different counter.
  assert.deepEqual(cartLines(raw), [], 'the refused line was stored anyway');
  const c = counters(raw);
  assert.deepEqual(c.cells.find((x) => x.id === 'f_pre'), { id: 'f_pre', capacity: 0, capacity_reserved: 0 });
  assert.deepEqual(c.shelf, [{ id: 'v_mini', stock: 7, reserved: 0 }], 'the shelf paid for a refused pre-order');
});

test('the same body with room in the quota is admitted, and spends the QUOTA at the door — never the shelf', async () => {
  // The other half: this must not become "refuse everything with a transport".
  // Air holds TWO of its own while the shared pool is empty, so a sale that
  // lands on air's row is unmistakable.
  const raw = seedShop({ shelf: 7, cell: 0, air: 2 });
  const db = asD1(raw);
  const app = shopApp(db);

  const add = await post(app, '/api/cart/items', reorderBody());
  assert.equal(add.status, 200, JSON.stringify(await json(add)).slice(0, 400));

  // The stored row is still the legacy shape — a transport, no stated type —
  // and the read model types it the way the door just did. (The id is the
  // server's own, so only the two typing columns are compared.)
  assert.deepEqual(
    cartLines(raw).map(({ qty, transport_method, fulfillment_type }) => ({ qty, transport_method, fulfillment_type })),
    [{ qty: 1, transport_method: 'air', fulfillment_type: '' }]
  );
  const cart = await json(await get(app, '/api/cart'));
  assert.equal(cart.items[0].availability.mode, 'preorder');
  assert.equal(cart.items[0].availability.preorder.capacity.available, 2);

  const order = await post(app, '/api/orders', orderBody({ transportMethod: 'air' }));
  assert.equal(order.status, 200, JSON.stringify(await json(order)).slice(0, 400));

  const c = counters(raw);
  assert.deepEqual(c.routes, [{ id: 't_air', capacity: 2, capacity_reserved: 1 }], 'air’s own quota did not move');
  assert.deepEqual(
    c.cells.find((x) => x.id === 'f_pre'),
    { id: 'f_pre', capacity: 0, capacity_reserved: 0 },
    'the shared pool was charged as well — one sale, two counters'
  );
  assert.deepEqual(c.shelf, [{ id: 'v_mini', stock: 7, reserved: 0 }], 'a pre-order took a unit off the shelf');
  assert.deepEqual(c.ledger, [{ scope: 'preorder_transport', scope_id: 't_air', qty: 1, kind: 'reserve' }]);
});

test('a STATED direct sale on the same model is untouched — the shelf is still its counter', async () => {
  // The fix types a line from its own row; it must not re-type a line that
  // states what it is. "Buy now" with the pre-order pool empty is a direct sale.
  const raw = seedShop({ shelf: 7, cell: 0 });
  const db = asD1(raw);
  const app = shopApp(db);

  const add = await post(app, '/api/cart/items', {
    productId: 'p_a1',
    qty: 1,
    optionValueIds: ['v_mini'],
    fulfillmentType: 'direct_sale',
  });
  assert.equal(add.status, 200, JSON.stringify(await json(add)).slice(0, 400));
  const order = await post(app, '/api/orders', orderBody());
  assert.equal(order.status, 200, JSON.stringify(await json(order)).slice(0, 400));

  const c = counters(raw);
  assert.deepEqual(c.shelf, [{ id: 'v_mini', stock: 7, reserved: 1 }], 'a direct sale stopped spending the shelf');
  assert.deepEqual(c.cells.find((x) => x.id === 'f_pre'), { id: 'f_pre', capacity: 0, capacity_reserved: 0 });
  assert.deepEqual(c.ledger, [{ scope: 'option', scope_id: 'v_mini', qty: 1, kind: 'reserve' }]);
});

test('the PATCH door types the row the same way — raising the qty of a legacy line is a pre-order edit', async () => {
  const raw = seedShop({ shelf: 7, cell: 0 });
  seedLine(raw, { transport: 'air', type: '', qty: 1 });
  const db = asD1(raw);

  // The cart screen's `+` button: a qty change and nothing else, so the door
  // reads the line's OWN two columns — a transport, no stated type.
  const res = await patch(shopApp(db), '/api/cart/items/ci_1', { qty: 2 });
  const body = await json(res);
  assert.equal(res.status, 400, `the patch was judged against the shelf: ${JSON.stringify(body).slice(0, 400)}`);
  assert.equal(body.code, 'PREORDER_CAPACITY_EXHAUSTED');
  assert.deepEqual(cartLines(raw), [{ id: 'ci_1', qty: 1, transport_method: 'air', fulfillment_type: '' }],
    'the refused patch was written anyway');
});

// =====================================================================
//  T2 — THE CART AND THE CHECKOUT APPLY ONE DEFAULT TO A BARE ROW
// =====================================================================
//
// Shelf 0 (tracked and empty) and an open import quota of two: the two
// answers a bare row could get are as far apart as they can be — "sold out"
// and "two places left".

test('a row that states NOTHING is the same order type in the cart and at the door — the quota, not the shelf', async () => {
  const raw = seedShop({ shelf: 0, cell: 2 });
  seedLine(raw, { transport: '', type: '', qty: 1 });
  const db = asD1(raw);
  const app = shopApp(db);

  // The stored row really states nothing: this is a defect about the DEFAULT.
  assert.deepEqual(cartLines(raw), [{ id: 'ci_1', qty: 1, transport_method: '', fulfillment_type: '' }]);

  const cart = await json(await get(app, '/api/cart'));
  const a = cart.items[0].availability;
  assert.equal(a.mode, 'preorder', 'the cart stopped describing the counter this line spends');
  assert.equal(a.preorder.capacity.available, 2);
  assert.equal(a.stock.max_qty, 2);
  assert.equal(a.qty_ok, true);

  // WITHOUT THE FIX the door defaulted the same row to `direct_sale` and
  // answered 400 OUT_OF_STOCK about a shelf the cart never offered.
  const order = await post(app, '/api/orders', orderBody());
  assert.equal(order.status, 200, `the door judged a different counter: ${JSON.stringify(await json(order)).slice(0, 400)}`);

  const c = counters(raw);
  assert.deepEqual(c.cells.find((x) => x.id === 'f_pre'), { id: 'f_pre', capacity: 2, capacity_reserved: 1 });
  assert.deepEqual(c.shelf, [{ id: 'v_mini', stock: 0, reserved: 0 }], 'the empty shelf was charged');
  assert.deepEqual(c.ledger, [{ scope: 'preorder', scope_id: 'f_pre', qty: 1, kind: 'reserve' }]);
});

test('the held place is releasable — cancelling gives it back to the row that holds it', async () => {
  // A HELD UNIT MUST ALWAYS BE RELEASABLE. Defaulting the row to a pre-order is
  // only safe if the release aims at the SAME row the reserve named.
  const raw = seedShop({ shelf: 0, cell: 2 });
  seedLine(raw, { transport: '', type: '', qty: 1 });
  const db = asD1(raw);

  const bought = await json(await post(shopApp(db), '/api/orders', orderBody()));
  assert.equal(bought.success, true, JSON.stringify(bought).slice(0, 400));
  const cancelled = await json(
    await post(shopApp(db), `/api/orders/${String(bought.order.id)}/cancel`, { reason: 'changed my mind' })
  );
  assert.equal(cancelled.success, true, JSON.stringify(cancelled).slice(0, 300));

  const c = counters(raw);
  assert.deepEqual(c.cells.find((x) => x.id === 'f_pre'), { id: 'f_pre', capacity: 2, capacity_reserved: 0 },
    'the place was never given back — the quota is stranded');
  assert.deepEqual(c.ledger.map((l) => `${l.kind}:${l.scope}:${l.scope_id}`),
    ['reserve:preorder:f_pre', 'release:preorder:f_pre']);
});

test('the same bare row on a model WITH stock is a direct sale on both sides — the default cuts both ways', async () => {
  // The rule is "the row's own description", not "always pre-order". With five
  // on the shelf the description is a direct sale, and the SHELF is what moves.
  const raw = seedShop({ shelf: 5, cell: 2 });
  seedLine(raw, { transport: '', type: '', qty: 1 });
  const db = asD1(raw);
  const app = shopApp(db);

  const cart = await json(await get(app, '/api/cart'));
  assert.equal(cart.items[0].availability.mode, 'direct_sale');
  assert.equal(cart.items[0].availability.reason, null, 'a row that states nothing was handed a refusal');
  assert.equal(cart.items[0].availability.stock.max_qty, 5);

  const order = await post(app, '/api/orders', orderBody());
  assert.equal(order.status, 200, JSON.stringify(await json(order)).slice(0, 400));

  const c = counters(raw);
  assert.deepEqual(c.shelf, [{ id: 'v_mini', stock: 5, reserved: 1 }]);
  assert.deepEqual(c.cells.find((x) => x.id === 'f_pre'), { id: 'f_pre', capacity: 2, capacity_reserved: 0 },
    'a direct sale spent the import quota');
  assert.deepEqual(c.ledger, [{ scope: 'option', scope_id: 'v_mini', qty: 1, kind: 'reserve' }]);
});

test('an UNTRACKED quota still means unlimited for a bare row — NULL is not zero', async () => {
  // The hard rule, on the default path: `COALESCE(capacity, 0)` here would
  // close every pre-order in the catalogue.
  const raw = seedShop({ shelf: 0, cell: null });
  seedLine(raw, { transport: '', type: '', qty: 3 });
  const db = asD1(raw);

  const cart = await json(await get(shopApp(db), '/api/cart'));
  assert.equal(cart.items[0].availability.mode, 'preorder');
  assert.equal(cart.items[0].availability.preorder.capacity.tracked, false);
  assert.equal(cart.items[0].availability.preorder.capacity.available, null);

  const order = await post(shopApp(db), '/api/orders', orderBody());
  assert.equal(order.status, 200, JSON.stringify(await json(order)).slice(0, 400));
  const c = counters(raw);
  assert.deepEqual(c.cells.find((x) => x.id === 'f_pre'), { id: 'f_pre', capacity: null, capacity_reserved: 0 },
    'an untracked counter reserved something');
  assert.deepEqual(c.shelf, [{ id: 'v_mini', stock: 0, reserved: 0 }]);
  assert.deepEqual(c.ledger, [], 'an untracked pre-order wrote a ledger row');
});

// =====================================================================
//  T3 — THE TXT PREVIEW REFUSES WHAT THE TXT APPLY WILL REFUSE
// =====================================================================

const CREATE_TXT = [
  'template_version=2',
  'slug=typing-a1',
  'name_ar=طابعة ايه1',
  'name_en=A1 printer',
  // name_ckb is deliberately absent: the Kurdish is the owner's to write.
  'status=draft',
  'price_iqd=500000',
  'stock=0',
  'options.1.id=opt_mini',
  'options.1.group=Model',
  'options.1.name_ar=ايه1 ميني',
  'options.1.name_en=A1 mini',
  'options.1.active=true',
  'options.1.preorder.enabled=true',
  'options.1.preorder.capacity=3',
  'options.1.preorder.transports.1.method=air',
  'options.1.preorder.transports.1.surcharge_iqd=80000',
].join('\n');

const parseTxt = (a: App, text: string) => post(a, '/api/admin/template/parse', { text });
const applyTxt = (a: App, text: string, mode: 'draft' | 'update' = 'draft') =>
  post(a, '/api/admin/template/apply', { text, mode, confirm: true });

/** A product created through the TXT door itself, then holding one live
 *  pre-order unit — the state an owner's file walks into. */
async function seedHeldCell(): Promise<{ raw: DatabaseSync; app: App; exported: string }> {
  const raw = freshDb();
  const app = adminApp(asD1(raw));
  const created = await json(await applyTxt(app, CREATE_TXT));
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 500));
  const cell = row<{ id: string; capacity: number }>(
    raw,
    "SELECT id, capacity FROM product_option_fulfillment WHERE fulfillment_type = 'pre_order'"
  );
  assert.ok(cell, 'the create did not land a pre-order cell at all');
  assert.equal(cell!.capacity, 3, 'the file’s capacity did not land');
  // One live pre-order is holding a place in that cell.
  raw.prepare('UPDATE product_option_fulfillment SET capacity_reserved = 1 WHERE id = ?').run(cell!.id);

  const exported = await (
    await get(app, `/api/admin/template/export/${String(created.product_id)}`)
  ).text();
  return { raw, app, exported };
}

/** The owner's edit: the same export with the pool cut to zero. */
function lowerCapacity(text: string, to: string): string {
  const re = /^options\.1\.preorder\.capacity=.*$/m;
  assert.match(text, re, 'the export no longer carries the cell capacity — the fixture is stale');
  return text.replace(re, `options.1.preorder.capacity=${to}`);
}

test('the TXT preview refuses a file that would strand a held pre-order — the apply’s own refusal, before the write', async () => {
  const { raw, app, exported } = await seedHeldCell();
  const lowered = lowerCapacity(exported, '0');

  const preview = await json(await parseTxt(app, lowered));
  // WITHOUT THE FIX: errors [], warnings [], validation_error null and a tidy
  // diff — a preview that says "this is fine" about a file the apply refuses.
  assert.deepEqual(preview.errors, [], 'the PARSER is still happy: this is the plan’s answer, not a new parse error');
  assert.ok(preview.validation_error, 'the preview still previews a save the apply will refuse');
  assert.equal(preview.validation_error.code, 'CAPACITY_BELOW_RESERVED');
  assert.match(String(preview.validation_error.message), /1 unit/);

  // AND THE APPLY SAYS THE SAME THING — one question, one answer.
  const applied = await applyTxt(app, lowered, 'update');
  const body = await json(applied);
  assert.equal(body.success, false);
  assert.equal(body.code, preview.validation_error.code, 'the preview and the apply name different refusals');

  // Nothing moved: the quota is still what the row holds it at.
  assert.deepEqual(
    all<{ capacity: number | null; capacity_reserved: number }>(
      raw,
      "SELECT capacity, capacity_reserved FROM product_option_fulfillment WHERE fulfillment_type = 'pre_order'"
    ),
    [{ capacity: 3, capacity_reserved: 1 }]
  );
});

test('clearing a held quota to UNTRACKED is previewed as its own refusal — NULL is not "no limit any more"', async () => {
  // The second stranding shape: once the column is NULL the deduct guard can
  // never match again, so the held unit can be neither deducted nor released.
  const { app, exported } = await seedHeldCell();
  const cleared = lowerCapacity(exported, '__NULL__');

  const preview = await json(await parseTxt(app, cleared));
  assert.ok(preview.validation_error, 'clearing a held quota previewed clean');
  assert.equal(preview.validation_error.code, 'CAPACITY_UNTRACKED_WHILE_HELD');

  const applied = await json(await applyTxt(app, cleared, 'update'));
  assert.equal(applied.success, false);
  assert.equal(applied.code, preview.validation_error.code);
});

test('a file that leaves the quota above the hold still previews clean, and still applies', async () => {
  // The control. A preview that refuses everything is not a preview, and this
  // is the file an owner actually sends: the same export, re-applied.
  const { raw, app, exported } = await seedHeldCell();

  const clean = await json(await parseTxt(app, exported));
  assert.equal(clean.validation_error, null, JSON.stringify(clean.validation_error));
  assert.deepEqual(clean.errors, []);

  const lowerButLegal = lowerCapacity(exported, '1'); // exactly the 1 unit held
  const stillFine = await json(await parseTxt(app, lowerButLegal));
  assert.equal(stillFine.validation_error, null, JSON.stringify(stillFine.validation_error));

  const applied = await json(await applyTxt(app, lowerButLegal, 'update'));
  assert.equal(applied.success, true, JSON.stringify(applied).slice(0, 500));
  assert.deepEqual(
    all<{ capacity: number | null; capacity_reserved: number }>(
      raw,
      "SELECT capacity, capacity_reserved FROM product_option_fulfillment WHERE fulfillment_type = 'pre_order'"
    ),
    [{ capacity: 1, capacity_reserved: 1 }],
    'the held unit did not survive the save that was allowed'
  );
});

test('an ARCHIVE previews the same refusal — a bulk import is where an unread quota is cut', async () => {
  // The ZIP door is the single-file preview repeated, and it is the one an
  // owner uses to send twenty files nobody reads line by line. A file in it
  // that the apply will refuse must not come back `ready_to_apply`.
  const { app, exported } = await seedHeldCell();
  const archive = zipSync({ 'a1.txt': strToU8(lowerCapacity(exported, '0')) });
  const form = new FormData();
  form.set('file', new File([archive], 'batch.zip', { type: 'application/zip' }));
  const res = await json(
    await app.request(
      '/api/admin/template/parse-zip',
      { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } },
      undefined,
      ctx
    )
  );

  assert.equal(res.files.length, 1, JSON.stringify(res).slice(0, 400));
  const file = res.files[0];
  assert.deepEqual(file.errors, [], 'the PARSER is still happy — this is the plan’s answer');
  assert.ok(file.validation_error, 'the archive previewed a save the apply will refuse');
  assert.equal(file.validation_error.code, 'CAPACITY_BELOW_RESERVED');
  assert.equal(file.ready_to_apply, false, 'a file the apply refuses was counted as ready');
  assert.equal(file.ok, false);
  assert.equal(res.counts.ready, 0);
  assert.equal(res.counts.not_ready, 1);
});
