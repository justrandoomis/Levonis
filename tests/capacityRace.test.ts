/**
 * THE PRE-ORDER HOLD IS THE ROW'S, NOT THE PLAN'S (0075).
 *
 * Every writer of a (model x order type) cell reads the product's current
 * cells first — for their row ids, and to refuse a save that would strand a
 * live pre-order. That read happens BEFORE the batch, and between the two a
 * real buyer can check out against the very counter the save is about to
 * rewrite. Two defects lived in that window, and this file is one failing
 * reproduction per defect, run against the real migrations, the real cart and
 * order routes and the real product planner. Nothing here is a mock of the
 * code under test.
 *
 *  R1  `fulfillmentStatements` deleted every cell and route of the product and
 *      re-inserted them binding `kept.capacity_reserved` — the count read when
 *      the PLAN was built. A reserve that committed in the window was written
 *      back to the stale number: the ledger kept its `reserve` row, the counter
 *      did not, and `planOrderReturn` for that live order then answered
 *      `rejected: [{ scope: 'preorder', reason: 'INSUFFICIENT_STOCK' }]` —
 *      the units were gone, invisibly, after a save that changed nothing.
 *      `product_option_values` never had this defect because its upsert lists
 *      `stock` and never `reserved`; this is the same shape, applied to the
 *      two columns 0075 added.
 *
 *  R2  The read-back net compared the stored `capacity_reserved` against
 *      `plan.cells.held` — the very plan-time number R1 forced back into the
 *      row — so it could not fail for the failure it was added for. It now
 *      also compares the row IDENTITY (nothing but a writer re-ids a row, so
 *      that check has no race window) and the quota this save wrote against
 *      the hold THE ROW IS ACTUALLY CARRYING (both sides read after the
 *      commit, which is the only way to see the race the plan-time guard
 *      structurally cannot).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, post, json, row, all, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import {
  planProductSave,
  reloadForVerification,
  saveProductAtomic,
  verifyApplied,
  type ProductSavePlan,
} from '../worker/lib/productPersistence';
import { planOrderDeduction, planOrderReturn } from '../worker/lib/orderInventory';
import { parseProductRow } from '../worker/lib/productModel';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

let seq = 0;

// ---------------------------------------------------------------- the shop
//
// ONE model with ONE pre-order cell and ONE route, because the defects are
// about a single counter being rewritten by a save. The pool and the route
// quota are parameters so the same shop can be configured to charge the SHARED
// pool (route quota NULL) or the ROUTE'S OWN quota (a number) — the order type
// and the route configuration alone decide which, never both.
function seedShop(o: { pool?: number | null; routeQuota?: number | null } = {}): DatabaseSync {
  const { pool = 5, routeQuota = null } = o;
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('boss','B','b@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','A1','ايه1','ئەی١',500000,'active',NULL,'[]','[]',
            'pre_order','["pre_order"]',
            '[{"method":"air","active":true,"commission_iqd":7500}]',
            '["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_m','p_a1','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved)
      VALUES ('v_mini','p_a1','g_m','A1 mini','ايه1 ميني',0,1,9,0);
    INSERT INTO product_option_fulfillment
      (id,product_id,option_id,fulfillment_type,enabled,capacity,capacity_reserved)
      VALUES ('f_pre','p_a1','v_mini','pre_order',1,${pool === null ? 'NULL' : pool},0);
    INSERT INTO product_option_transports
      (id,product_id,fulfillment_id,method,enabled,capacity,capacity_reserved)
      VALUES ('t_air','p_a1','f_pre','air',1,${routeQuota === null ? 'NULL' : routeQuota},0);
    INSERT INTO admin_settings (key,value) VALUES ('shippingPolicy','{"ordinary_iqd":5000}');
  `);
  return raw;
}

interface Counter {
  id: string;
  capacity: number | null;
  capacity_reserved: number;
}
const cell = (raw: DatabaseSync) =>
  row<Counter>(raw, 'SELECT id, capacity, capacity_reserved FROM product_option_fulfillment WHERE id = ?', 'f_pre')!;
const route = (raw: DatabaseSync) =>
  row<Counter>(raw, 'SELECT id, capacity, capacity_reserved FROM product_option_transports WHERE id = ?', 't_air')!;
const modelReserved = (raw: DatabaseSync) =>
  row<{ reserved: number }>(raw, 'SELECT reserved FROM product_option_values WHERE id = ?', 'v_mini')!.reserved;

/** A real pre-order, through the real cart and the real checkout. */
async function buy(db: unknown, qty = 1): Promise<string> {
  const added = await json(
    await post(appFor(db), '/api/cart/items', {
      productId: 'p_a1',
      qty,
      optionValueIds: ['v_mini'],
      fulfillmentType: 'pre_order',
      transportMethod: 'air',
    })
  );
  assert.equal(added.success, true, `the cart must accept the pre-order: ${JSON.stringify(added)}`);
  const bought = await json(
    await post(appFor(db), '/api/orders', {
      addressId: 'addr_b',
      deliveryMethodId: 'standard',
      paymentMethodId: 'cash',
      useWallet: false,
      usePoints: false,
      itemIds: [],
      idempotencyKey: `capacity-race-${++seq}`,
    })
  );
  assert.equal(bought.success, true, `the checkout must take the pre-order: ${JSON.stringify(bought)}`);
  return String(bought.order.id);
}

/**
 * The wire body a TXT import / CSV apply sends: models live under
 * `groups[].values[]`, and a model's order types ride on its `fulfillments`
 * key. `transports: undefined` drops the route from the payload entirely,
 * which is how a file removes one.
 */
const relationsBody = (o: { capacity?: number | null; routeCapacity?: number | null; dropRoute?: boolean } = {}) => ({
  inventory_mode: 'OPTION',
  groups: [
    {
      id: 'g_m',
      name_en: 'Model',
      sort: 0,
      active: true,
      values: [
        {
          id: 'v_mini',
          name_en: 'A1 mini',
          sort: 0,
          active: true,
          stock: 9,
          availability_type: 'pre_order',
          // A setting that CHANGES across the save, so a replace that was
          // skipped as a no-op cannot pass for a replace that ran.
          lead_time_text: 'ships in about a month',
          fulfillments: [
            {
              fulfillment_type: 'pre_order',
              enabled: true,
              capacity: o.capacity === undefined ? 5 : o.capacity,
              transports: o.dropRoute
                ? []
                : [
                    {
                      method: 'air',
                      enabled: true,
                      surcharge_iqd: 7500,
                      capacity: o.routeCapacity === undefined ? null : o.routeCapacity,
                    },
                  ],
            },
          ],
        },
      ],
    },
  ],
  colors: [],
  variants: [],
});

/** The plan an admin save builds — the read of the live cells happens HERE. */
async function planSave(raw: DatabaseSync, body: Record<string, unknown>): Promise<ProductSavePlan> {
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', 'p_a1')!;
  return planProductSave(asD1(raw), {
    mode: 'update',
    doc: null,
    prev: parseProductRow(stored),
    relations: body,
    actor: { adminId: 'boss', money: true },
  });
}

const capacityMismatches = async (raw: DatabaseSync, plan: ProductSavePlan) => {
  const stored = await reloadForVerification(asD1(raw), 'p_a1');
  assert.ok(stored, 'the product must read back');
  return verifyApplied(plan, stored, { documentKeys: null }).filter((m) => m.key.startsWith('fulfillment.'));
};

// =========================================================================
//  R1 — a save that changes nothing may not eat a hold taken beside it
// =========================================================================

test('R1: a reserve committed between the plan and the batch survives the save (shared pool)', async () => {
  const raw = seedShop({ pool: 5, routeQuota: null });
  const db = asD1(raw);

  // 1. The admin's save is PLANNED. The cell is holding nothing at this moment,
  //    and that zero is what the old writer put in its hand.
  const plan = await planSave(raw, relationsBody());
  assert.equal(cell(raw).capacity_reserved, 0, 'the plan is built against an empty hold');

  // 2. A real buyer pre-orders in the window. One counter moves: the cell's
  //    shared pool, because this route claims no quota of its own.
  const orderId = await buy(db);
  assert.equal(cell(raw).capacity_reserved, 1, 'the checkout really took a unit from the pool');
  assert.equal(route(raw).capacity_reserved, 0, 'and NOT from the route, which draws on that same pool');
  assert.equal(modelReserved(raw), 0, 'and never from the model stock — a pre-order is not a direct sale');

  // 3. The admin's save commits. It asks for exactly what is already stored.
  await saveProductAtomic(db, plan);

  assert.equal(cell(raw).capacity_reserved, 1, 'a save may not carry a held count in its hand');
  assert.equal(cell(raw).id, 'f_pre', 'and the row the ledger names is still the row');
  assert.equal(cell(raw).capacity, 5, 'the setting the save DID write is written');

  // 4. THE POINT: the hold is still releasable. This is the assertion that
  //    failed before the fix, with reason INSUFFICIENT_STOCK.
  const ret = await planOrderReturn(db, orderId, null);
  assert.deepEqual(ret.plan?.rejected ?? [], [], 'the release must still find the units it has to give back');
  await db.batch(ret.plan!.statements);
  assert.equal(cell(raw).capacity_reserved, 0, 'and the unit really came back');
});

test('R1: the same, when the ROUTE holds its own quota — the other counter, the same rule', async () => {
  const raw = seedShop({ pool: 5, routeQuota: 3 });
  const db = asD1(raw);

  const plan = await planSave(raw, relationsBody({ routeCapacity: 3 }));
  const orderId = await buy(db);

  assert.equal(route(raw).capacity_reserved, 1, 'a route with its own quota charges the route');
  assert.equal(cell(raw).capacity_reserved, 0, 'and NOT the shared pool as well — one counter per sale');

  await saveProductAtomic(db, plan);

  assert.equal(route(raw).capacity_reserved, 1, 'the route is a ledger scope_id of its own');
  assert.equal(route(raw).id, 't_air');
  assert.equal(route(raw).capacity, 3);

  const ret = await planOrderReturn(db, orderId, null);
  assert.deepEqual(ret.plan?.rejected ?? [], []);
  await db.batch(ret.plan!.statements);
  assert.equal(route(raw).capacity_reserved, 0);
});

test('R1: the row is not frozen — settings still land, and a dropped route is still deleted', async () => {
  const raw = seedShop({ pool: 5, routeQuota: 2 });
  const db = asD1(raw);

  await saveProductAtomic(db, await planSave(raw, relationsBody({ capacity: 9, routeCapacity: 4 })));
  assert.equal(cell(raw).capacity, 9, 'a raised pool is stored');
  assert.equal(route(raw).capacity, 4, "and so is the route's own quota");
  assert.equal(cell(raw).id, 'f_pre', 'under the same row id');
  assert.equal(
    row<{ lead_time_text: string }>(raw, 'SELECT lead_time_text FROM product_option_values WHERE id = ?', 'v_mini')!
      .lead_time_text,
    'ships in about a month',
    'the replace really ran'
  );

  // A file that stops describing the route removes it — nothing is holding it.
  await saveProductAtomic(db, await planSave(raw, relationsBody({ capacity: 9, dropRoute: true })));
  assert.equal(all(raw, 'SELECT id FROM product_option_transports').length, 0, 'a replace is still a replace');
  assert.equal(cell(raw).capacity_reserved, 0);
});

test('R1: the delete asks the ROW, so a route that took a hold in the window is not dropped with it', async () => {
  const raw = seedShop({ pool: 5, routeQuota: 3 });
  const db = asD1(raw);

  // The admin plans a save that REMOVES the route. Nothing is held, so
  // `refuseStrandedCapacity` rightly allows it…
  const plan = await planSave(raw, relationsBody({ dropRoute: true }));
  // …and then a buyer takes a unit on that very route.
  const orderId = await buy(db);
  assert.equal(route(raw).capacity_reserved, 1);

  await saveProductAtomic(db, plan);

  assert.equal(route(raw).capacity_reserved, 1, 'the units are still there to give back');
  const ret = await planOrderReturn(db, orderId, null);
  assert.deepEqual(ret.plan?.rejected ?? [], [], 'a held unit must always be releasable');

  // Losing the admin's removal is recoverable, and it is REPORTED rather than
  // silent: the replace no longer leaves exactly the payload's set.
  const miss = await capacityMismatches(raw, plan);
  assert.deepEqual(
    miss.find((m) => m.key === 'fulfillment.routes'),
    { section: 'inventory', key: 'fulfillment.routes', requested: 0, stored: 1 },
    'the read-back net names the row the delete refused to drop'
  );
});

// =========================================================================
//  R2 — the net must compare something the save cannot dictate
// =========================================================================

test('R2: a quota written BELOW the hold the row is actually carrying is reported', async () => {
  const raw = seedShop({ pool: 5, routeQuota: null });
  const db = asD1(raw);

  // The admin cuts the pool to 2. Nothing is held when the plan is built, so
  // CAPACITY_BELOW_RESERVED cannot fire — it is judged on that same read.
  const plan = await planSave(raw, relationsBody({ capacity: 2 }));
  await buy(db, 4); // legal against the stored 5
  assert.equal(cell(raw).capacity_reserved, 4);

  await saveProductAtomic(db, plan);
  assert.equal(cell(raw).capacity, 2, 'the save wrote exactly what it was asked for');
  assert.equal(cell(raw).capacity_reserved, 4, 'and did not touch the hold');

  assert.deepEqual(
    await capacityMismatches(raw, plan),
    [
      {
        section: 'inventory',
        key: 'fulfillment.v_mini.pre_order.capacity_below_reserved',
        requested: 2,
        stored: 4,
      },
    ],
    'a pool of 2 holding 4 is oversold, and only a read-back of BOTH stored numbers can see it'
  );
});

test('R2: a counter taken UNTRACKED while it holds units is reported, and the units really are stuck', async () => {
  const raw = seedShop({ pool: 5, routeQuota: null });
  const db = asD1(raw);

  // __CLEAR__ reaches the writer as `capacity: null`. With nothing held at
  // plan time, CAPACITY_UNTRACKED_WHILE_HELD cannot fire either.
  const plan = await planSave(raw, relationsBody({ capacity: null }));
  const orderId = await buy(db);
  await saveProductAtomic(db, plan);

  assert.equal(cell(raw).capacity, null, 'NULL is untracked — never COALESCE(capacity, 0)');
  assert.equal(cell(raw).capacity_reserved, 1);

  assert.deepEqual(
    await capacityMismatches(raw, plan),
    [
      {
        section: 'inventory',
        key: 'fulfillment.v_mini.pre_order.capacity_untracked_while_held',
        requested: null,
        stored: 1,
      },
    ],
    'untracked claims nothing is outstanding; one unit is'
  );

  // Not a cosmetic report: the deduct guard is `<on_hand> IS NOT NULL AND …`,
  // so this order can never be confirmed against the counter it reserved.
  const deduction = await planOrderDeduction(db, orderId, null);
  assert.deepEqual(
    (deduction?.rejected ?? []).map((r) => ({ scope: r.scope, reason: r.reason })),
    [{ scope: 'preorder', reason: 'NOT_TRACKED' }],
    'the read-back net is naming a state that really does break confirmation'
  );
});

test('R2: a ROW ID that came back different is reported — the ledger names that id', async () => {
  const raw = seedShop({ pool: 5, routeQuota: 3 });
  const db = asD1(raw);
  const plan = await planSave(raw, relationsBody({ routeCapacity: 3 }));
  await saveProductAtomic(db, plan);
  assert.deepEqual(await capacityMismatches(raw, plan), [], 'a clean save reports nothing');

  // What a delete-then-insert writer that minted a fresh id leaves behind. The
  // FK is dropped for the doctoring only; both rows are moved together so the
  // stored shape is exactly what such a writer would produce.
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    UPDATE product_option_fulfillment SET id = 'f_new' WHERE id = 'f_pre';
    UPDATE product_option_transports SET id = 't_new', fulfillment_id = 'f_new' WHERE id = 't_air';
    PRAGMA foreign_keys = ON;
  `);

  assert.deepEqual(
    await capacityMismatches(raw, plan),
    [
      { section: 'inventory', key: 'fulfillment.v_mini.pre_order.id', requested: 'f_pre', stored: 'f_new' },
      { section: 'inventory', key: 'fulfillment.v_mini.pre_order.air.id', requested: 't_air', stored: 't_new' },
    ],
    'every inventory_ledger row for this cell names the old id; nothing else in the shop re-ids a row'
  );
});

test('R2: a hold that GREW under a concurrent checkout is not an admin apply failure', async () => {
  const raw = seedShop({ pool: 5, routeQuota: null });
  const db = asD1(raw);

  const plan = await planSave(raw, relationsBody({ capacity: 9 }));
  await buy(db); // the hold rises from 0 to 1 in the window
  await saveProductAtomic(db, plan);

  assert.equal(cell(raw).capacity, 9);
  assert.equal(cell(raw).capacity_reserved, 1);
  assert.deepEqual(
    await capacityMismatches(raw, plan),
    [],
    'somebody else buying a unit is not this save failing to land — a quota of 9 covers the 1 held'
  );
});
