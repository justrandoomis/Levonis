/**
 * THE BUNDLE DOOR OBEYS THE SAME COUNTER RULE AS EVERY OTHER DOOR (0075).
 *
 * Migration 0075 gave a (model x pre-order) cell an OPTIONAL capacity and each
 * of its routes an optional quota. `tests/stockByOrderType.test.ts` pins that
 * rule for a BARE product line. This file pins it for a COMPONENT line, because
 * the composition path had been resolving every component with `resolveStock`
 * — the member's SHELF — whatever the line's order type was, and that left the
 * whole bundle door outside the rule in both directions at once:
 *
 *  (a) A PRE-ORDER BUNDLE DECREMENTED DIRECT STOCK. A pre-order-only member
 *      with three units on the shelf was reserved against `products.stock`, so
 *      a direct buyer racing the same model was short a unit that no pre-order
 *      was ever entitled to take.
 *
 *  (b) THE IMPORT QUOTA WAS OVERSOLD WITHOUT BOUND. The same member with its
 *      pre-order cell at capacity 0 sold through the bundle door with an EMPTY
 *      ledger and an untouched cell, while the identical standalone line was
 *      correctly refused PREORDER_CAPACITY_EXHAUSTED.
 *
 * THE RULE THE COMPONENT LINE NOW FOLLOWS, written out because the next reader
 * will need it. A standalone line takes its order type from the customer's own
 * stored `fulfillment_type` and falls back to the transport on the row. A
 * component has no per-component answer to give — the buyer chose a BUNDLE, and
 * the bundle carries ONE transport method for every pre-order component
 * (§2.2, §17.12). So the member's OWN catalogue answer stands in first place,
 * and the journey the component is on decides only when the member genuinely
 * sells both ways:
 *
 *     member sells only one way   ->  that way
 *     member sells both ways      ->  the component's `shipping_type`
 *
 * The parent order's pricing basis is never consulted: prepaid versus cash on
 * delivery is how the money arrives, not what the order is.
 *
 * Every assertion below is made through the REAL routers, the REAL checkout
 * batch and real migrations, and names the exact counter — a green route proves
 * nothing here, because both defects were green.
 *
 * WHAT IS STILL SHELF-SHAPED, DELIBERATELY UNASSERTED. `resolveComponent` in
 * worker/lib/bundleRead.ts — the CART and CARD read model — still answers with
 * `resolveStock` for every component, so `bundle.availability.max_bundles` and
 * the coarse per-component state are computed off a pre-order member's SHELF.
 * That is a false REFUSAL, never an oversell: a model with an empty shelf and
 * an open import quota is reported sold out at `POST /api/cart/items` while the
 * same product bought on its own is accepted. Nothing here asserts that
 * behaviour in either direction, so the three-line correction in that file —
 * `resolveComponentCounter` in place of `resolveStock`, with the shipping plan
 * computed first and the line's transport threaded through `CompositionViewer`
 * — will not have to fight a test that pinned the wrong answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, get, json, all, row, count, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import { addBundle, seedCatalogue, orderBody } from './lib/bundles';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const owner: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };
const appFor = (db: unknown, user: StubUser = buyer) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });
const adminApp = (db: unknown) => stubApp(db, owner, (a) => a.route('/api/admin/bundles', adminBundlesRoutes));

// ---------------------------------------------------------------- the shop

/**
 * A PRE-ORDER-ONLY MEMBER WITH UNITS ON ITS SHELF — defect (a)'s own product.
 * BASE inventory, `products.stock = 3`, and deliberately NO fulfilment cell:
 * that is a catalogue row from before 0073, which DECISION 6 says is UNTRACKED
 * for pre-order and must still sell while reserving nothing.
 */
function addShelfPreorder(raw: DatabaseSync, stock: number | null = 3): void {
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                             selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
       VALUES ('p_shelf','shelfspool','PETG Shelf','بي إي تي جي','پی ئی تی جی',40000,'active',?,'[]','[]',
               'pre_order','["pre_order"]',
               '[{"method":"air","active":true},{"method":"sea","active":true}]',
               '["https://cdn/petg.png"]','BASE','{"is_spool":true}')`
    )
    .run(stock);
}

interface ModelShop {
  /** the model's SHELF — product_option_values.stock, kept plentiful so the
   *  shelf can never be the reason a pre-order assertion fails */
  shelf?: number | null;
  /** the (model x pre-order) SHARED pool; null = untracked = unlimited */
  pool?: number | null;
  /** per-route quotas; a method left out of the map draws on the shared pool */
  routeQuota?: Partial<Record<'air' | 'sea' | 'land', number>>;
}

/** A pre-order-only model whose capacity is configured per (model x pre-order)
 *  and per route — defect (b)'s own product. */
function addModelPreorder(raw: DatabaseSync, o: ModelShop = {}): void {
  const { shelf = 9, pool = 2 } = o;
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_model','a1mini','A1 mini','ايه1','ئەی١',500000,'active',NULL,'[]','[]',
            'pre_order','["pre_order"]',
            '[{"method":"air","active":true},{"method":"sea","active":true},{"method":"land","active":true}]',
            '["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_m','p_model','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved)
      VALUES ('v_model','p_model','g_m','A1 mini','ايه1 ميني',0,1,${shelf === null ? 'NULL' : shelf},0);
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity)
      VALUES ('f_direct','p_model','v_model','direct_sale',1,NULL),
             ('f_pre','p_model','v_model','pre_order',1,${pool === null ? 'NULL' : pool});
  `);
  for (const method of ['air', 'sea', 'land'] as const) {
    const q = o.routeQuota?.[method];
    raw
      .prepare(
        `INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,capacity)
         VALUES (?,?, 'f_pre', ?, 1, ?)`
      )
      .run(`t_${method}`, 'p_model', method, q === undefined ? null : q);
  }
}

const transportDefaults = (raw: DatabaseSync) =>
  raw.exec(
    `INSERT INTO admin_settings (key, value) VALUES ('preorderTransportDefaults',
      '[{"method":"air","commission_iqd":7000},{"method":"sea","commission_iqd":3000},{"method":"land","commission_iqd":2000}]')`
  );

// ------------------------------------------------------------- the counters

const productRow = (raw: DatabaseSync, id: string) =>
  row<{ stock: number | null; stock_reserved: number }>(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', id)!;
const modelShelf = (raw: DatabaseSync) =>
  row<{ stock: number | null; reserved: number }>(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'v_model')!;
const cell = (raw: DatabaseSync) =>
  row<{ capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT capacity, capacity_reserved FROM product_option_fulfillment WHERE id = ?',
    'f_pre'
  )!;
const route = (raw: DatabaseSync, method: string) =>
  row<{ capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT capacity, capacity_reserved FROM product_option_transports WHERE id = ?',
    `t_${method}`
  )!;
const ledger = (raw: DatabaseSync) =>
  all<{ product_id: string; scope: string; scope_id: string; kind: string; qty: number }>(
    raw,
    'SELECT product_id, scope, scope_id, kind, qty FROM inventory_ledger ORDER BY rowid'
  );

async function cartAdd(db: unknown, body: Record<string, unknown>) {
  return await json(await post(appFor(db), '/api/cart/items', body));
}

/**
 * ADD THE LINE, THEN PLACE THE ORDER, AND RETURN WHICHEVER ANSWER DECIDED.
 *
 * These tests are about WHICH COUNTER a bundle spends, not about which door
 * says no. Since the cart read model learned to read a pre-order component
 * against its import quota instead of the member's shelf, a quota that is
 * already full is caught at ADD, where it should be — the customer finds out
 * while choosing rather than at the end of the checkout. Before that fix the
 * add always succeeded (the shelf had stock) and only the checkout refused.
 * Asserting on one specific door would make these tests fail every time a
 * refusal moves EARLIER, which is the direction we want it to move.
 */
async function addThenBuy(db: unknown, body: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const added = await cartAdd(db, body);
  if (!added.success) return added;
  return await buy(db, over);
}
async function buy(db: unknown, over: Record<string, unknown> = {}) {
  return await json(await post(appFor(db), '/api/orders', orderBody(over)));
}

// ======================================================= defect (a): the shelf

test('a PRE-ORDER bundle line never decrements the member’s direct shelf', async () => {
  const raw = seedCatalogue();
  addShelfPreorder(raw, 3);
  transportDefaults(raw);
  addBundle(raw, { id: 'prd_shelf', slug: 'shelfbundle', priceIqd: 90_000, components: [{ id: 'bc_shelf', product: 'p_shelf', qty: 1 }] });
  const db = asD1(raw);

  assert.equal((await cartAdd(db, { productId: 'prd_shelf', qty: 1, transportMethod: 'air' })).success, true);
  const res = await buy(db);
  assert.equal(res.success, true, JSON.stringify(res));

  // THE DEFECT, stated as the reviewer reproduced it: a `base` reserve of 1 and
  // `stock_reserved = 1` on a product nobody bought from the shelf.
  assert.deepEqual(ledger(raw), [], 'a pre-order holds nothing on a shelf it is not entitled to');
  assert.deepEqual(
    productRow(raw, 'p_shelf'),
    { stock: 3, stock_reserved: 0 },
    'all three units are still there for the direct buyer racing this order'
  );
  assert.equal(
    row<{ shipping_type: string }>(raw, 'SELECT shipping_type FROM orders WHERE id = ?', res.order.id)!.shipping_type,
    'preorder_air',
    'and it really is a pre-order — the journey was never in doubt'
  );
});

test('a DIRECT bundle line still reserves the member’s shelf — the fix does not drop a counter', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000 });
  const db = asD1(raw);
  assert.equal((await cartAdd(db, { productId: 'prd_b1', qty: 1 })).success, true);
  assert.equal((await buy(db)).success, true);

  assert.deepEqual(
    ledger(raw).map((l) => [l.product_id, l.scope, l.kind, l.qty]).sort(),
    [
      ['p_nozzle', 'base', 'reserve', 1],
      ['p_pla', 'base', 'reserve', 2],
      ['p_printer', 'base', 'reserve', 1],
    ],
    'every direct component still holds its own units, at its own quantity'
  );
  assert.equal(productRow(raw, 'p_printer').stock_reserved, 1);
  assert.equal(productRow(raw, 'p_pla').stock_reserved, 2);
});

// ================================================== defect (b): the import quota

test('a bundle whose model’s pre-order quota is FULL is refused, exactly as the standalone line is', async () => {
  const raw = seedCatalogue();
  addModelPreorder(raw, { shelf: 9, pool: 0 });
  transportDefaults(raw);
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  const bundled = await addThenBuy(db, { productId: 'prd_model', qty: 1, transportMethod: 'air' });
  assert.equal(bundled.success, false, JSON.stringify(bundled));
  assert.equal(bundled.code, 'PREORDER_CAPACITY_EXHAUSTED', JSON.stringify(bundled));

  // Nothing was written, anywhere: not the quota, not the shelf, not the ledger.
  assert.deepEqual(cell(raw), { capacity: 0, capacity_reserved: 0 }, 'the full quota was not driven negative');
  assert.deepEqual(modelShelf(raw), { stock: 9, reserved: 0 }, 'and the shelf was not raided instead');
  assert.deepEqual(ledger(raw), []);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0, 'no order row survives a refusal');

  // THE PARITY THE DEFECT BROKE: the identical product bought on its own.
  raw.exec('DELETE FROM cart_items');
  const standalone = await cartAdd(db, {
    productId: 'p_model',
    qty: 1,
    optionId: 'v_model',
    fulfillmentType: 'pre_order',
    transportMethod: 'air',
  });
  assert.equal(standalone.success, false);
  assert.equal(standalone.code, 'PREORDER_CAPACITY_EXHAUSTED', 'the bare line was always refused; now the bundle is too');
});

test('a bundle pre-order spends the (model x pre-order) POOL — one counter, never the shelf as well', async () => {
  const raw = seedCatalogue();
  addModelPreorder(raw, { shelf: 9, pool: 2 });
  transportDefaults(raw);
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  assert.equal((await cartAdd(db, { productId: 'prd_model', qty: 1, transportMethod: 'air' })).success, true);
  const res = await buy(db);
  assert.equal(res.success, true, JSON.stringify(res));

  assert.deepEqual(
    ledger(raw).map((l) => [l.product_id, l.scope, l.scope_id, l.kind, l.qty]),
    [['p_model', 'preorder', 'f_pre', 'reserve', 1]],
    'EXACTLY ONE ledger row, and it names the pre-order pool'
  );
  assert.deepEqual(cell(raw), { capacity: 2, capacity_reserved: 1 });
  assert.deepEqual(modelShelf(raw), { stock: 9, reserved: 0 }, 'the shelf is not summed in and is not touched');
  assert.deepEqual(route(raw, 'air'), { capacity: null, capacity_reserved: 0 }, 'a shared route holds nothing of its own');
});

test('a route with its OWN quota is the only counter a bundle on that route spends', async () => {
  const raw = seedCatalogue();
  addModelPreorder(raw, { shelf: 9, pool: 2, routeQuota: { land: 1 } });
  transportDefaults(raw);
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  assert.equal((await cartAdd(db, { productId: 'prd_model', qty: 1, transportMethod: 'land' })).success, true);
  assert.equal((await buy(db)).success, true);

  assert.deepEqual(
    ledger(raw).map((l) => [l.scope, l.scope_id, l.kind]),
    [['preorder_transport', 't_land', 'reserve']],
    'the route quota, and nothing else'
  );
  assert.deepEqual(route(raw, 'land'), { capacity: 1, capacity_reserved: 1 });
  assert.deepEqual(cell(raw), { capacity: 2, capacity_reserved: 0 }, 'the shared pool is NOT charged a second time');
  assert.deepEqual(route(raw, 'air'), { capacity: null, capacity_reserved: 0 }, 'and no quantity was copied onto air');
  assert.deepEqual(route(raw, 'sea'), { capacity: null, capacity_reserved: 0 }, 'or onto sea');
  assert.deepEqual(modelShelf(raw), { stock: 9, reserved: 0 });
});

test('a NULL capacity is UNTRACKED for a bundle too — unlimited, and it reserves nothing', async () => {
  const raw = seedCatalogue();
  addModelPreorder(raw, { shelf: 2, pool: null });
  transportDefaults(raw);
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  // Three bundles against a shelf of two: only a counter that claims no limit
  // lets the third through, and only if the shelf is genuinely not consulted.
  for (let i = 0; i < 3; i += 1) {
    raw.exec('DELETE FROM cart_items');
    assert.equal((await cartAdd(db, { productId: 'prd_model', qty: 1, transportMethod: 'sea' })).success, true);
    const res = await buy(db);
    assert.equal(res.success, true, `bundle ${i + 1} should be unlimited: ${JSON.stringify(res)}`);
  }
  assert.deepEqual(cell(raw), { capacity: null, capacity_reserved: 0 }, 'NULL is untracked, never COALESCE(capacity, 0)');
  assert.deepEqual(modelShelf(raw), { stock: 2, reserved: 0 });
  assert.deepEqual(ledger(raw), []);
});

// ============================================== the demand is summed, not split

test('a component needing TWO of a model is judged on two places, not one', async () => {
  for (const [pool, ok] of [[1, false], [2, true]] as const) {
    const raw = seedCatalogue();
    addModelPreorder(raw, { shelf: 9, pool });
    transportDefaults(raw);
    addBundle(raw, {
      id: 'prd_model',
      slug: 'modelbundle',
      priceIqd: 600_000,
      components: [{ id: 'bc_model', product: 'p_model', qty: 2, optionValueIds: ['v_model'] }],
    });
    const db = asD1(raw);
    const res = await addThenBuy(db, { productId: 'prd_model', qty: 1, transportMethod: 'air' });
    assert.equal(res.success, ok, `pool ${pool}: ${JSON.stringify(res)}`);
    if (ok) {
      assert.deepEqual(cell(raw), { capacity: 2, capacity_reserved: 2 }, 'both places are held');
    } else {
      assert.equal(res.code, 'PREORDER_CAPACITY_EXHAUSTED');
      assert.deepEqual(cell(raw), { capacity: 1, capacity_reserved: 0 });
    }
  }
});

test('a bundle and a bare line of the SAME model sum against the one quota before either is judged', async () => {
  const raw = seedCatalogue();
  addModelPreorder(raw, { shelf: 9, pool: 1 });
  transportDefaults(raw);
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  assert.equal((await cartAdd(db, { productId: 'prd_model', qty: 1, transportMethod: 'air' })).success, true);
  assert.equal(
    (await cartAdd(db, { productId: 'p_model', qty: 1, optionId: 'v_model', fulfillmentType: 'pre_order', transportMethod: 'air' })).success,
    true,
    'the last place is still free when each line is looked at alone'
  );

  const res = await buy(db);
  assert.equal(res.success, false, JSON.stringify(res));
  assert.equal(res.code, 'PREORDER_CAPACITY_EXHAUSTED', 'two lines, one counter, summed');
  assert.deepEqual(cell(raw), { capacity: 1, capacity_reserved: 0 }, 'and the batch wrote nothing at all');
  assert.deepEqual(ledger(raw), []);
});

// ========================================= payment method is not order type

test('cash on delivery re-prices a bundle pre-order and does NOT re-target its counter', async () => {
  const raw = seedCatalogue();
  addModelPreorder(raw, { shelf: 9, pool: 2 });
  transportDefaults(raw);
  raw.exec("UPDATE products SET direct_surcharge_iqd = 5000 WHERE id = 'p_model'");
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  assert.equal((await cartAdd(db, { productId: 'prd_model', qty: 1, transportMethod: 'air' })).success, true);
  const quote = await json(await post(appFor(db), '/api/orders/quote', orderBody({ paymentMethodId: 'cash' })));
  assert.equal(quote.success, true, JSON.stringify(quote));

  const res = await buy(db, { paymentMethodId: 'cash' });
  assert.equal(res.success, true, JSON.stringify(res));
  assert.deepEqual(
    ledger(raw).map((l) => [l.scope, l.scope_id]),
    [['preorder', 'f_pre']],
    'the cash order spends the pre-order pool, exactly as a prepaid one does'
  );
  assert.deepEqual(modelShelf(raw), { stock: 9, reserved: 0 }, 'cash on delivery did not turn it into a direct sale');
});

// ============================================== the hold comes back exactly once

test('cancelling a bundle pre-order releases the capacity once, and a repeat moves nothing', async () => {
  const raw = seedCatalogue();
  addModelPreorder(raw, { shelf: 9, pool: 2 });
  transportDefaults(raw);
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  assert.equal((await cartAdd(db, { productId: 'prd_model', qty: 1, transportMethod: 'air' })).success, true);
  const res = await buy(db);
  assert.equal(res.success, true, JSON.stringify(res));
  assert.deepEqual(cell(raw), { capacity: 2, capacity_reserved: 1 });

  const first = await json(await post(appFor(db), `/api/orders/${res.order.id}/cancel`, { reason: 'changed my mind' }));
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual(cell(raw), { capacity: 2, capacity_reserved: 0 }, 'the place came back');

  const again = await json(await post(appFor(db), `/api/orders/${res.order.id}/cancel`, { reason: 'changed my mind' }));
  void again;
  assert.deepEqual(cell(raw), { capacity: 2, capacity_reserved: 0 }, 'and a repeat is a no-op through the ledger key');
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind = 'release'"),
    1,
    'exactly one release row, held by the UNIQUE idempotency key'
  );
});

// ============================== the panel is judged on the same counter (§2.3)

/**
 * ADMIN AND SHOP MAY NOT DISAGREE, so the composition pass the PANEL takes
 * resolves its components by order type too. `resolveComposition` called
 * `resolveStock` unconditionally, which meant the preview of a pre-order
 * bundle reported the members' SHELF as what bounds the offer: a model with an
 * empty shelf and five import places read "sold out" in the panel while the
 * checkout would sell it, and a model with a full quota and a deep shelf read
 * as freely available right up to the refusal at the door.
 */
test('the admin preview bounds a pre-order bundle by the import quota, not by the shelf', async () => {
  // The shelf is EMPTY and the quota is open: the honest preview is "sellable".
  const open = seedCatalogue();
  addModelPreorder(open, { shelf: 0, pool: 4 });
  transportDefaults(open);
  addBundle(open, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const openPreview = await json(await get(adminApp(asD1(open)), '/api/admin/bundles/prd_model/preview'));
  assert.equal(openPreview.success, true, JSON.stringify(openPreview));
  assert.equal(
    openPreview.preview.availability.max_bundles,
    4,
    'four import places is four bundles — the empty shelf bounds nothing a pre-order spends'
  );
  assert.equal(openPreview.preview.availability.state, 'preorder');
  assert.equal(openPreview.preview.components[0].available, 4, 'and the component reports the quota it will actually consume');

  // The quota is FULL and the shelf is deep: the honest preview is "the import
  // quota is full", NOT "sold out" — there is no shelf behind a pre-order, and
  // the two facts carry different waits and different remedies.
  const full = seedCatalogue();
  addModelPreorder(full, { shelf: 9, pool: 0 });
  transportDefaults(full);
  addBundle(full, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const fullPreview = await json(await get(adminApp(asD1(full)), '/api/admin/bundles/prd_model/preview'));
  assert.equal(fullPreview.success, true, JSON.stringify(fullPreview));
  assert.equal(fullPreview.preview.availability.max_bundles, 0, 'nine on the shelf cannot fill a pre-order place');
  assert.equal(fullPreview.preview.availability.state, 'sold_out');
  assert.equal(fullPreview.preview.components[0].available, 0);
  assert.deepEqual(
    fullPreview.preview.availability.blocking.map((b: { product_id: string; reason: string }) => [b.product_id, b.reason]),
    [['p_model', 'PREORDER_CAPACITY_EXHAUSTED']],
    'the panel names the component AND the counter that is actually blocking: a full import quota is not an empty shelf, and the admin reading this needs to know which of the two they can do something about'
  );
});

// ================================================== the read model, not the door
//
// Everything above is about a counter MOVING. This one is about a counter being
// READ: `resolveComponent` in bundleRead.ts answered `resolveStock` for every
// component, which is the wrong counter for a pre-order member in BOTH
// directions. The door was fixed first because an oversell is worse than a
// false refusal — but a bundle a customer is entitled to buy and cannot add to
// their cart is still a broken purchase path, and it is the half a shopper
// actually meets.

test('a pre-order bundle whose model has an EMPTY SHELF but import places left can still be added', async () => {
  const raw = seedCatalogue();
  // No shelf at all, four import places. The standalone line has always been
  // sellable here; the bundle was refused OUT_OF_STOCK.
  addModelPreorder(raw, { shelf: 0, pool: 4 });
  transportDefaults(raw);
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  const added = await cartAdd(db, { productId: 'prd_model', qty: 1, transportMethod: 'air' });
  assert.equal(added.success, true, `the shelf is not this line's counter: ${JSON.stringify(added)}`);

  const placed = await buy(db);
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.deepEqual(cell(raw), { capacity: 4, capacity_reserved: 1 }, 'one import place spent');
  assert.deepEqual(modelShelf(raw), { stock: 0, reserved: 0 }, 'and the empty shelf never went negative');
});

test('the read model still refuses a pre-order bundle whose quota is full, shelf or no shelf', async () => {
  const raw = seedCatalogue();
  // The inverse of the test above, and the reason this is not just "return
  // untracked and let the door sort it out": a full quota beside a stocked
  // shelf must not read as freely available.
  addModelPreorder(raw, { shelf: 9, pool: 0 });
  transportDefaults(raw);
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  const placed = await addThenBuy(db, { productId: 'prd_model', qty: 1, transportMethod: 'air' });
  assert.equal(placed.success, false, JSON.stringify(placed));
  assert.deepEqual(modelShelf(raw), { stock: 9, reserved: 0 }, 'the shelf beside the full quota was never touched');
  assert.deepEqual(ledger(raw), []);
});

test('a DIRECT bundle component is still read against the shelf — the read fix drops no counter', async () => {
  const raw = seedCatalogue();
  addModelPreorder(raw, { shelf: 0, pool: 4 });
  // Make the member direct-sale-only: its counter is the shelf, which is empty,
  // so it must still be refused. If the pre-order branch leaked into a direct
  // component, this line would wrongly succeed on the import quota.
  raw.exec(`UPDATE products SET sale_types = '["direct_sale"]', selling_type = 'direct_sale' WHERE id = 'p_model'`);
  transportDefaults(raw);
  addBundle(raw, {
    id: 'prd_model',
    slug: 'modelbundle',
    priceIqd: 600_000,
    components: [{ id: 'bc_model', product: 'p_model', qty: 1, optionValueIds: ['v_model'] }],
  });
  const db = asD1(raw);

  const placed = await addThenBuy(db, { productId: 'prd_model', qty: 1 });
  assert.equal(placed.success, false, `an empty shelf still stops a direct component: ${JSON.stringify(placed)}`);
  assert.deepEqual(cell(raw), { capacity: 4, capacity_reserved: 0 }, 'and the import quota was not spent instead');
});
