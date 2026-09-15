/**
 * FOUR DEFECTS IN THE 0075 PRE-ORDER COUNTER, PINNED AGAINST THE REAL ROUTES.
 *
 * Migration 0075 gave a (model x pre-order) cell an OPTIONAL capacity and each
 * of its routes an optional quota. NULL = UNTRACKED (unlimited, reserves
 * nothing), 0 = tracked and empty. The order type alone picks the counter.
 * Three reviewers then found four ways the feature sells or strands a unit it
 * should not, and this file is one test per way, written against the FAILURE:
 *
 *  E1  `capacityFrom` resolved the pre-order counter as "the FIRST selected
 *      value that has a pre-order cell". A selection naming two such values
 *      charged one pool and left the other unenforced, and the answer depended
 *      on ARRAY ORDER — which differs between the doors, because the cart add
 *      keeps the client's order and the checkout reads the canonically sorted
 *      list `cart_items.option_value_ids` stores. So the counter the door
 *      validated was not always the counter the sale consumed.
 *
 *  E2  `refuseStrandedCapacity` guarded `capacity !== null && capacity < held`,
 *      so setting a capacity to NULL while units were held was allowed. That is
 *      worse than lowering it to 0: the deduct guard is `<on_hand> IS NOT NULL
 *      AND …`, so once the column is NULL the hold can never be deducted and
 *      never released.
 *
 *  E3  The whole hold-preserving replace sat behind "does any value carry a
 *      `fulfillments` key?". A file that DELETES a model carries no such key,
 *      so the guard never ran — while the CASCADE took the cell, its routes and
 *      their `capacity_reserved` with the model.
 *
 *  E4  `verifyApplied`, the read-back safety net, compared every number a save
 *      writes except `capacity` and `capacity_reserved`.
 *
 * Nothing here is a mock of the code under test: the real migrations, the real
 * cart and order routes, and the real planner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, post, json, all, row, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { capacityFrom, loadRelationsView } from '../worker/lib/productOverlay';
import { resolveCapacity } from '../worker/lib/inventory';
import { existingCellsFrom, refuseStrandedCapacity, type FulfillmentCell } from '../worker/lib/optionFulfillment';
import {
  planProductSave,
  reloadForVerification,
  saveProductAtomic,
  verifyApplied,
} from '../worker/lib/productPersistence';
import { parseProductRow } from '../worker/lib/productModel';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

let seq = 0;
const orderBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `stock-capacity-defects-${++seq}`,
  ...over,
});

// ---------------------------------------------------------------- the shop
//
// TWO option groups, each with one model, and EACH model carrying its own
// (model x pre-order) cell. That is the configuration E1 is about: a single
// selection — one value per group, which `validateSelection` requires — names
// two pre-order counters at once.
//
// The ids are chosen so that SORTING them changes which one comes first:
// `v_a_case` sorts before `v_b_mini`, and the cart add keeps the client's
// order while the checkout re-reads the sorted list. A fix that still answers
// "the first one" therefore gives the two doors two different counters.

interface ShopOptions {
  /** the pre-order pool on the `Case` model's cell; null = untracked */
  casePool?: number | null;
  /** the pre-order pool on the `Model` model's cell; null = untracked */
  miniPool?: number | null;
}

function seedShop(o: ShopOptions = {}): DatabaseSync {
  const { casePool = 5, miniPool = 1 } = o;
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
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES
      ('g_case','p_a1','Case',0,1),
      ('g_model','p_a1','Model',1,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved) VALUES
      ('v_a_case','p_a1','g_case','Hard case','حقيبة',0,1,9,0),
      ('v_b_mini','p_a1','g_model','A1 mini','ايه1 ميني',0,1,9,0);
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity) VALUES
      ('f_case','p_a1','v_a_case','pre_order',1,${casePool === null ? 'NULL' : casePool}),
      ('f_mini','p_a1','v_b_mini','pre_order',1,${miniPool === null ? 'NULL' : miniPool});
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,capacity) VALUES
      ('t_case_air','p_a1','f_case','air',1,NULL),
      ('t_mini_air','p_a1','f_mini','air',1,NULL);
    INSERT INTO admin_settings (key,value) VALUES ('shippingPolicy','{"ordinary_iqd":5000}');
  `);
  return raw;
}

const cell = (raw: DatabaseSync, id: string) =>
  row<{ capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT capacity, capacity_reserved FROM product_option_fulfillment WHERE id = ?',
    id
  )!;

/** The client's own order, preserved by the add door exactly as sent. */
const addLine = async (db: unknown, ids: string[], over: Record<string, unknown> = {}) =>
  await json(
    await post(appFor(db), '/api/cart/items', {
      productId: 'p_a1',
      qty: 1,
      optionValueIds: ids,
      fulfillmentType: 'pre_order',
      transportMethod: 'air',
      ...over,
    })
  );
const buy = async (db: unknown) => await json(await post(appFor(db), '/api/orders', orderBody()));

// =========================================================================
// E1 — one selection, two tracked counters
// =========================================================================

test('E1: a selection naming TWO tracked pre-order counters is refused, not silently charged to one', async () => {
  const raw = seedShop({ casePool: 5, miniPool: 1 });
  const db = asD1(raw);

  // The reviewer's reproduction: four units against a configuration whose
  // smallest counter is 1. Before the fix the first id won, so the pool of 5
  // absorbed all four and the cell of capacity 1 stayed at 0 — never enforced.
  for (let i = 0; i < 4; i += 1) {
    raw.exec('DELETE FROM cart_items');
    const added = await addLine(db, ['v_a_case', 'v_b_mini'], { qty: 1 });
    assert.equal(added.success, false, `add ${i + 1} must be refused: ${JSON.stringify(added)}`);
    assert.equal(added.code, 'PREORDER_CAPACITY_EXHAUSTED', JSON.stringify(added));
  }

  assert.deepEqual(cell(raw, 'f_case'), { capacity: 5, capacity_reserved: 0 }, 'nothing was charged to the big pool');
  assert.deepEqual(cell(raw, 'f_mini'), { capacity: 1, capacity_reserved: 0 }, 'and the tracked cell of 1 is untouched');
  assert.equal(all(raw, 'SELECT id FROM orders').length, 0, 'no order exists');
});

test('E1: the checkout door refuses the same configuration, so the two doors cannot disagree', async () => {
  const raw = seedShop({ casePool: 5, miniPool: 1 });
  const db = asD1(raw);

  // Straight into the cart, in the CANONICAL order the add door stores —
  // the shape the checkout actually reads, and the one that used to resolve
  // to a different counter than the add door had validated.
  raw.exec(`
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,
                            shipping_method_id,transport_method,fulfillment_type,warranty_plan_id,qty)
    VALUES ('ci_1','buyer','p_a1','v_a_case','["v_a_case","v_b_mini"]','','','air','pre_order','',1);
  `);

  const bought = await buy(db);
  assert.equal(bought.success, false, JSON.stringify(bought));
  assert.equal(bought.code, 'PREORDER_CAPACITY_EXHAUSTED', JSON.stringify(bought));
  assert.deepEqual(cell(raw, 'f_case'), { capacity: 5, capacity_reserved: 0 });
  assert.deepEqual(cell(raw, 'f_mini'), { capacity: 1, capacity_reserved: 0 });
});

test('E1: the answer no longer depends on the order the caller lists its selection in', async () => {
  const raw = seedShop({ casePool: 5, miniPool: 1 });
  const view = await loadRelationsView(asD1(raw), 'p_a1', 'OPTION');

  const clientOrder = capacityFrom(view, ['v_b_mini', 'v_a_case']);
  const storedOrder = capacityFrom(view, ['v_a_case', 'v_b_mini']);
  assert.deepEqual(clientOrder, storedOrder, 'the add door and the checkout must resolve the same thing');

  for (const snap of [clientOrder, storedOrder]) {
    const res = resolveCapacity(snap, 'air');
    assert.equal(res.error, 'PREORDER_CAPACITY_AMBIGUOUS');
    assert.equal(res.tracked, true, 'tracked, so every door stops on it');
    assert.equal(res.available, 0, 'and nothing may be sold against it');
    assert.deepEqual(res.targets, [], 'no counter is charged, because there is no ONE counter');
  }
  assert.deepEqual(clientOrder?.conflict?.labels, ['Hard case', 'A1 mini'], 'the refusal names both models');
});

test('E1: ONE tracked counter among the selected values is THE counter, whichever order it arrives in', async () => {
  // The case the old code got wrong in the other direction: with the untracked
  // cell listed first it answered "untracked" and sold without limit, while a
  // tracked counter of 1 sat right beside it.
  const raw = seedShop({ casePool: null, miniPool: 1 });
  const view = await loadRelationsView(asD1(raw), 'p_a1', 'OPTION');

  for (const ids of [
    ['v_a_case', 'v_b_mini'],
    ['v_b_mini', 'v_a_case'],
  ]) {
    const res = resolveCapacity(capacityFrom(view, ids), 'air');
    assert.equal(res.error, null, `${ids.join(',')} is not ambiguous: exactly one cell claims a limit`);
    assert.equal(res.tracked, true);
    assert.equal(res.available, 1, `${ids.join(',')} must answer from the tracked cell`);
    assert.deepEqual(res.targets.map((t) => t.scope_id), ['f_mini']);
  }
});

test('E1: untracked cells stay inert — the catalogue as it stands today refuses nothing', async () => {
  // Every row in every existing catalogue carries capacity NULL (0075 adds the
  // column NULL and copies nothing into it), so this is the shape of the whole
  // shop on the day the fix ships.
  const raw = seedShop({ casePool: null, miniPool: null });
  const view = await loadRelationsView(asD1(raw), 'p_a1', 'OPTION');

  for (const ids of [
    ['v_a_case', 'v_b_mini'],
    ['v_b_mini', 'v_a_case'],
  ]) {
    const snap = capacityFrom(view, ids);
    assert.equal(snap?.conflict ?? null, null, 'two UNTRACKED cells are not a conflict — neither claims a limit');
    const res = resolveCapacity(snap, 'air');
    assert.equal(res.tracked, false);
    assert.equal(res.available, null, 'untracked is unlimited, exactly as before 0075');
    assert.equal(snap?.cell?.id, 'f_case', 'and the scope is stable between the doors');
  }

  // …and the sale really goes through, at both doors.
  const db = asD1(raw);
  assert.equal((await addLine(db, ['v_b_mini', 'v_a_case'])).success, true);
  const bought = await buy(db);
  assert.equal(bought.success, true, JSON.stringify(bought));
  assert.deepEqual(cell(raw, 'f_case'), { capacity: null, capacity_reserved: 0 }, 'nothing was reserved');
  assert.deepEqual(cell(raw, 'f_mini'), { capacity: null, capacity_reserved: 0 });
});

// =========================================================================
// E2 — going UNTRACKED while units are held
// =========================================================================

/** One model, a pool of 5 with 2 held, and a `land` route with 3 of which 1 is held. */
function seedHeld(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','B','b@x.co','h','admin');
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','A1','ايه1','ئەی١',500000,'active',NULL,'[]','[]',
            'pre_order','["pre_order"]',
            '[{"method":"land","active":true,"commission_iqd":2000}]',
            '["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_m','p_a1','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved)
      VALUES ('v_mini','p_a1','g_m','A1 mini','ايه1 ميني',0,1,4,0);
    INSERT INTO product_option_fulfillment
      (id,product_id,option_id,fulfillment_type,enabled,capacity,capacity_reserved)
      VALUES ('f_pre','p_a1','v_mini','pre_order',1,5,2);
    INSERT INTO product_option_transports
      (id,product_id,fulfillment_id,method,enabled,capacity,capacity_reserved)
      VALUES ('t_land','p_a1','f_pre','land',1,3,1);
  `);
  return raw;
}

const heldNow = (raw: DatabaseSync) =>
  existingCellsFrom(
    all(raw, 'SELECT id, option_id, fulfillment_type, capacity_reserved FROM product_option_fulfillment'),
    all(raw, 'SELECT id, fulfillment_id, method, capacity_reserved FROM product_option_transports')
  );

const blankCell = (over: Partial<FulfillmentCell> = {}): FulfillmentCell => ({
  option_id: 'v_mini',
  fulfillment_type: 'pre_order',
  enabled: true,
  sort: 0,
  capacity: null,
  transports: [],
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  regular_adjust_iqd: null,
  prime_adjust_iqd: null,
  pro_adjust_iqd: null,
  cost_adjust_iqd: null,
  lead_time_text: '',
  lead_time_min_days: null,
  lead_time_max_days: null,
  ...over,
});

const route = (over: Record<string, unknown> = {}) => ({
  method: 'land' as const,
  enabled: true,
  surcharge_iqd: null,
  sort: 0,
  capacity: null as number | null,
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  regular_adjust_iqd: null,
  prime_adjust_iqd: null,
  pro_adjust_iqd: null,
  cost_adjust_iqd: null,
  lead_time_text: '',
  lead_time_min_days: null,
  lead_time_max_days: null,
  ...over,
});

test('E2: a CELL cannot go untracked while it is holding units', () => {
  const raw = seedHeld();
  const existing = heldNow(raw);

  assert.throws(
    () => refuseStrandedCapacity(existing, [blankCell({ capacity: null, transports: [route({ capacity: 3 })] })]),
    (e: unknown) => {
      const err = e as { code?: string; message?: string; status?: number };
      assert.equal(err.code, 'CAPACITY_UNTRACKED_WHILE_HELD', err.message);
      assert.match(String(err.message), /holding 2 pre-ordered unit/, 'the refusal names the count');
      assert.match(String(err.message), /at least 2|cancel or fulfil/, 'and says what to do instead');
      return true;
    }
  );

  // Lowering it to a number that still covers the hold is NOT refused: the
  // guard is about stranding units, not about editing a capacity.
  refuseStrandedCapacity(existing, [blankCell({ capacity: 2, transports: [route({ capacity: 3 })] })]);
});

test('E2: a ROUTE cannot go untracked while it is holding units', () => {
  const raw = seedHeld();
  const existing = heldNow(raw);

  assert.throws(
    () => refuseStrandedCapacity(existing, [blankCell({ capacity: 5, transports: [route({ capacity: null })] })]),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, 'CAPACITY_UNTRACKED_WHILE_HELD', err.message);
      assert.match(String(err.message), /land/, 'the route is named');
      assert.match(String(err.message), /holding 1 pre-ordered unit/);
      return true;
    }
  );

  refuseStrandedCapacity(existing, [blankCell({ capacity: 5, transports: [route({ capacity: 1 })] })]);
});

test('E2: the file door inherits the refusal, and the stored rows are left exactly as they were', async () => {
  const raw = seedHeld();
  const db = asD1(raw);
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', 'p_a1')!;
  // A TXT/CSV body that blanks the capacity boxes — '' is UNTRACKED, which is
  // exactly the payload an admin produces by clearing the field.
  const body = {
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
            stock: 4,
            availability_type: 'pre_order',
            fulfillments: [
              {
                fulfillment_type: 'pre_order',
                enabled: true,
                capacity: '',
                transports: [{ method: 'land', enabled: true, surcharge_iqd: 2000, capacity: 3 }],
              },
            ],
          },
        ],
      },
    ],
    colors: [],
    variants: [],
  };

  await assert.rejects(
    () =>
      planProductSave(db, {
        mode: 'update',
        doc: null,
        prev: parseProductRow(stored),
        relations: body,
        actor: { adminId: 'boss', money: true },
      }),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'CAPACITY_UNTRACKED_WHILE_HELD', String((e as Error).message));
      return true;
    }
  );

  assert.deepEqual(
    row(raw, 'SELECT capacity, capacity_reserved FROM product_option_fulfillment WHERE id = ?', 'f_pre'),
    { capacity: 5, capacity_reserved: 2 },
    'a refused save writes nothing'
  );
});

// =========================================================================
// E3 — deleting a model that is holding pre-ordered units
// =========================================================================

const clearedBody = {
  // What `options=__CLEAR__` becomes by the time it reaches the planner: a
  // structure with no groups at all, and — the point of the defect — NO
  // `fulfillments` key anywhere, because a file that deletes a model has no
  // model to hang one on.
  inventory_mode: 'BASE',
  groups: [],
  colors: [],
  variants: [],
};

const planClear = (raw: DatabaseSync) => {
  const db = asD1(raw);
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', 'p_a1')!;
  return planProductSave(db, {
    mode: 'update',
    doc: null,
    prev: parseProductRow(stored),
    relations: clearedBody,
    actor: { adminId: 'boss', money: true },
  });
};

test('E3: a file cannot delete a model that is holding pre-ordered units', async () => {
  const raw = seedHeld();
  raw.exec(`
    INSERT INTO inventory_ledger (id,product_id,scope,scope_id,kind,qty,order_id,idempotency_key,reason)
    VALUES ('l1','p_a1','preorder','f_pre','reserve',2,'o_1','reserve:o_1:f_pre','checkout'),
           ('l2','p_a1','preorder_transport','t_land','reserve',1,'o_2','reserve:o_2:t_land','checkout');
  `);

  await assert.rejects(planClear(raw), (e: unknown) => {
    const err = e as { code?: string; message?: string };
    // The planner reports structure refusals as RELATIONS_VALIDATION with the
    // sentences inside; what matters is that the count is named.
    assert.match(String(err.message), /holding 3 pre-ordered unit/, String(err.message));
    return true;
  });

  assert.equal(all(raw, 'SELECT id FROM product_option_values').length, 1, 'the model is still there');
  assert.deepEqual(
    row(raw, 'SELECT capacity, capacity_reserved FROM product_option_fulfillment WHERE id = ?', 'f_pre'),
    { capacity: 5, capacity_reserved: 2 }
  );

  // The join the reviewer ran after the apply: every hold in the journal must
  // still resolve to a live counter.
  const orphans = all(
    raw,
    `SELECT l.scope, l.scope_id FROM inventory_ledger l
      WHERE (l.scope = 'preorder'
              AND NOT EXISTS (SELECT 1 FROM product_option_fulfillment f WHERE f.id = l.scope_id))
         OR (l.scope = 'preorder_transport'
              AND NOT EXISTS (SELECT 1 FROM product_option_transports t WHERE t.id = l.scope_id))`
  );
  assert.deepEqual(orphans, [], 'no ledger row was left pointing at a counter that no longer exists');
});

test('E3: a model holding NOTHING is still deletable — the guard refuses holds, not edits', async () => {
  const raw = seedHeld();
  raw.exec(`
    UPDATE product_option_fulfillment SET capacity_reserved = 0 WHERE id = 'f_pre';
    UPDATE product_option_transports SET capacity_reserved = 0 WHERE id = 't_land';
  `);

  const plan = await planClear(raw);
  await saveProductAtomic(asD1(raw), plan);
  assert.equal(all(raw, 'SELECT id FROM product_option_values').length, 0, 'an unheld model deletes as it always did');
  assert.equal(all(raw, 'SELECT id FROM product_option_fulfillment').length, 0);
});

// =========================================================================
// E4 — the read-back net never looked at the capacity
// =========================================================================

const capacityBody = (capacity: number, routeCapacity: number) => ({
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
          stock: 4,
          availability_type: 'pre_order',
          fulfillments: [
            {
              fulfillment_type: 'pre_order',
              enabled: true,
              capacity,
              transports: [{ method: 'land', enabled: true, surcharge_iqd: 2000, capacity: routeCapacity }],
            },
          ],
        },
      ],
    },
  ],
  colors: [],
  variants: [],
});

async function savedPlan(raw: DatabaseSync, capacity = 9, routeCapacity = 4) {
  const db = asD1(raw);
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', 'p_a1')!;
  const plan = await planProductSave(db, {
    mode: 'update',
    doc: null,
    prev: parseProductRow(stored),
    relations: capacityBody(capacity, routeCapacity),
    actor: { adminId: 'boss', money: true },
  });
  await saveProductAtomic(db, plan);
  return plan;
}

const capacityMismatches = async (raw: DatabaseSync, plan: Awaited<ReturnType<typeof savedPlan>>) => {
  const stored = await reloadForVerification(asD1(raw), 'p_a1');
  assert.ok(stored, 'the product must read back');
  return verifyApplied(plan, stored, { documentKeys: null }).filter((m) => m.key.startsWith('fulfillment.'));
};

test('E4: a capacity that did not land is REPORTED by the read-back net', async () => {
  const raw = seedHeld();
  const plan = await savedPlan(raw);
  assert.deepEqual(await capacityMismatches(raw, plan), [], 'a clean save reports nothing');

  // The failure the net exists for: the row is there, the number is not the
  // one the file asked for.
  raw.exec("UPDATE product_option_fulfillment SET capacity = 3 WHERE id = 'f_pre'");
  const cellMiss = await capacityMismatches(raw, plan);
  assert.equal(cellMiss.length, 1, JSON.stringify(cellMiss));
  assert.deepEqual(cellMiss[0], {
    section: 'inventory',
    key: 'fulfillment.v_mini.pre_order.capacity',
    requested: 9,
    stored: 3,
  });
});

test('E4: a ROUTE quota that did not land, and a capacity silently blanked, are both reported', async () => {
  const raw = seedHeld();
  const plan = await savedPlan(raw);

  raw.exec("UPDATE product_option_transports SET capacity = NULL WHERE id = 't_land'");
  const routeMiss = await capacityMismatches(raw, plan);
  assert.deepEqual(routeMiss, [
    { section: 'inventory', key: 'fulfillment.v_mini.pre_order.land.capacity', requested: 4, stored: null },
  ]);
});

test('E4: a HOLD that the save lost is reported; one that grew under a concurrent checkout is not', async () => {
  const raw = seedHeld();
  const plan = await savedPlan(raw);
  assert.deepEqual(await capacityMismatches(raw, plan), []);

  // A replace that minted a new row, or reset the column, loses the units.
  raw.exec("UPDATE product_option_fulfillment SET capacity_reserved = 0 WHERE id = 'f_pre'");
  const lost = await capacityMismatches(raw, plan);
  assert.deepEqual(lost, [
    { section: 'inventory', key: 'fulfillment.v_mini.pre_order.capacity_reserved', requested: 2, stored: 0 },
  ]);

  // Somebody else's checkout reserving against the same row in the window
  // between the plan and the read-back is not the admin's failure.
  raw.exec("UPDATE product_option_fulfillment SET capacity_reserved = 3 WHERE id = 'f_pre'");
  assert.deepEqual(await capacityMismatches(raw, plan), [], 'a hold that GREW is not a failed apply');
});
