/**
 * WHICH COUNTER A LINE CONSUMES IS DECIDED BY THE ORDER TYPE ALONE.
 *
 * Migration 0075 gave a (model x pre-order) cell an OPTIONAL capacity and each
 * of its routes an optional quota of its own. This file pins the five facts
 * that make that safe, against the REAL migrations, the REAL constraints and
 * the REAL checkout batch — because every one of them is a way to sell a unit
 * twice, and none of them is visible from a green route:
 *
 *  1. ONE COUNTER PER SALE. A direct sale moves the model's stock and never
 *     the capacity; a pre-order moves the capacity and never the stock. A
 *     model sold out for direct sale is still pre-orderable, which is the
 *     behaviour the owner asked for and the reason 0073's refusal was
 *     overruled.
 *
 *  2. SHARED VERSUS INDEPENDENT. Routes with no quota of their own all spend
 *     the cell's pool — selling by air lowers what sea can sell — and a route
 *     WITH a quota spends only that quota. A route never spends both, or one
 *     unit would be deducted twice and the shop would run out at half its
 *     stated capacity.
 *
 *  3. NULL IS NOT ZERO. NULL capacity is untracked: unlimited, nothing
 *     reserved, always sellable — exactly how every pre-order behaved before
 *     0075, which is what makes the migration back-compatible. 0 is a tracked
 *     counter that is empty and refuses.
 *
 *  4. ATOMIC AND RELEASED EXACTLY ONCE. Two checkouts for the last place: one
 *     commits, the other is refused. A cancellation releases the hold once and
 *     a repeat is a no-op, through the ledger's UNIQUE idempotency key.
 *
 *  5. PAYMENT METHOD IS NOT ORDER TYPE. Cash on delivery re-prices a pre-order
 *     and must not re-target it: a COD pre-order consumes capacity and leaves
 *     the shelf untouched, byte for byte, exactly as a prepaid one does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, post, json, all, row, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { planInventory } from '../worker/lib/inventory';
import {
  resolveCapacity,
  resolveForOrderType,
  type CapacitySnapshot,
  type InventorySnapshot,
} from '../worker/lib/inventory';
import { capacityFrom } from '../worker/lib/productOverlay';
import { loadRelationsView } from '../worker/lib/productOverlay';
import { saleAvailability } from '../worker/routes/products';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown, user: StubUser = buyer) =>
  stubApp(db, user, (a) => {
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
  idempotencyKey: `stock-by-order-type-${++seq}`,
  ...over,
});

// ---------------------------------------------------------------- the shop
//
// ONE product, ONE model, TWO order types — the smallest catalogue in which
// "sold out for direct sale, open for pre-order" is a sentence. `A1 mini` has
// one unit on the shelf and two pre-order places in the shared pool; `land`
// holds a quota of ONE that belongs to it alone.

interface ShopOptions {
  /** the model's shelf (product_option_values.stock) */
  stock?: number | null;
  /** the (model x pre-order) shared pool; null = untracked = unlimited */
  pool?: number | null;
  /** per-route quotas; a method left out draws on the shared pool */
  routeQuota?: Partial<Record<'air' | 'sea' | 'land', number>>;
}

function seedShop(o: ShopOptions = {}): DatabaseSync {
  const { stock = 1, pool = 2, routeQuota = { land: 1 } } = o;
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','A1','ايه1','ئەی١',500000,'active',NULL,'[]','[]',
            'direct_sale','["direct_sale","pre_order"]',
            '[{"method":"air","active":true,"commission_iqd":7500},
              {"method":"sea","active":true,"commission_iqd":3000},
              {"method":"land","active":true,"commission_iqd":2000}]',
            '["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_m','p_a1','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved)
      VALUES ('v_mini','p_a1','g_m','A1 mini','ايه1 ميني',0,1,${stock === null ? 'NULL' : stock},0);
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity)
      VALUES ('f_direct','p_a1','v_mini','direct_sale',1,NULL),
             ('f_pre','p_a1','v_mini','pre_order',1,${pool === null ? 'NULL' : pool});
  `);
  for (const method of ['air', 'sea', 'land'] as const) {
    const q = routeQuota[method];
    raw
      .prepare(
        `INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,capacity)
         VALUES (?,?, 'f_pre', ?, 1, ?)`
      )
      .run(`t_${method}`, 'p_a1', method, q === undefined ? null : q);
  }
  raw
    .prepare("INSERT INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)")
    .run(JSON.stringify({ ordinary_iqd: 5000 }));
  return raw;
}

const optionRow = (raw: DatabaseSync) =>
  row<{ stock: number | null; reserved: number }>(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'v_mini')!;
const cellRow = (raw: DatabaseSync) =>
  row<{ capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT capacity, capacity_reserved FROM product_option_fulfillment WHERE id = ?',
    'f_pre'
  )!;
const routeRow = (raw: DatabaseSync, method: string) =>
  row<{ capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT capacity, capacity_reserved FROM product_option_transports WHERE id = ?',
    `t_${method}`
  )!;
const ledger = (raw: DatabaseSync) =>
  all<{ scope: string; scope_id: string; kind: string; qty: number; idempotency_key: string }>(
    raw,
    'SELECT scope, scope_id, kind, qty, idempotency_key FROM inventory_ledger ORDER BY rowid'
  );

async function addLine(db: unknown, body: Record<string, unknown>) {
  return await json(await post(appFor(db), '/api/cart/items', { productId: 'p_a1', qty: 1, optionId: 'v_mini', ...body }));
}
async function buy(db: unknown, over: Record<string, unknown> = {}) {
  return await json(await post(appFor(db), '/api/orders', orderBody(over)));
}
const clearCart = (raw: DatabaseSync) => raw.exec("DELETE FROM cart_items");

// =========================================================== the resolver

const shelf = (stock: number | null): InventorySnapshot => ({
  inventory_mode: 'OPTION',
  base: { stock: 99, reserved: 0, low_stock_threshold: null },
  option_values: [{ id: 'v_mini', group_id: 'g_m', name_en: 'A1 mini', stock, reserved: 0, low_stock_threshold: null }],
  colors: [],
  variants: [],
  group_ids: ['g_m'],
});

const snapshot = (pool: number | null, quotas: Partial<Record<string, number | null>> = {}): CapacitySnapshot => ({
  cell: { id: 'f_pre', capacity: pool, reserved: 0, label: 'A1 mini' },
  transports: (['air', 'sea', 'land'] as const).map((method) => ({
    id: `t_${method}`,
    method,
    enabled: true,
    capacity: quotas[method] ?? null,
    reserved: 0,
    label: `A1 mini — ${method}`,
  })),
});

test('a pre-order reads the capacity and a direct sale reads the shelf — on the SAME model', () => {
  const stock = shelf(0); // sold out on the shelf
  const cap = snapshot(2); // two pre-order places
  const sel = { option_value_ids: ['v_mini'], color_id: null };

  const direct = resolveForOrderType('direct_sale', stock, sel, cap, '');
  assert.equal(direct.available, 0, 'the shelf is empty');
  assert.deepEqual(direct.targets.map((t) => t.scope), ['option']);

  const pre = resolveForOrderType('pre_order', stock, sel, cap, 'air');
  assert.equal(pre.available, 2, 'the pre-order is open even though the shelf is not');
  assert.deepEqual(pre.targets.map((t) => [t.scope, t.scope_id]), [['preorder', 'f_pre']]);
});

test('a route with no quota of its own draws on the shared pool; one with a quota does not', () => {
  const cap = snapshot(5, { land: 1 });
  for (const method of ['air', 'sea']) {
    const r = resolveCapacity(cap, method);
    assert.deepEqual(r.targets.map((t) => [t.scope, t.scope_id]), [['preorder', 'f_pre']], `${method} shares the pool`);
    assert.equal(r.available, 5);
  }
  const land = resolveCapacity(cap, 'land');
  assert.deepEqual(land.targets.map((t) => [t.scope, t.scope_id]), [['preorder_transport', 't_land']]);
  assert.equal(land.available, 1, 'its own quota, not the pool');
});

test('NULL capacity is UNTRACKED — unlimited and reserving nothing — and 0 is not the same thing', () => {
  const untracked = resolveCapacity(snapshot(null), 'air');
  assert.equal(untracked.tracked, false);
  assert.equal(untracked.available, null, 'null = no limit is claimed');
  assert.deepEqual(untracked.targets, [], 'nothing to reserve');

  const empty = resolveCapacity(snapshot(0), 'air');
  assert.equal(empty.tracked, true);
  assert.equal(empty.available, 0, 'zero is a tracked counter that is empty');
  assert.equal(empty.targets.length, 1, 'and it is still a real target, so the guard refuses the sale');

  // The same distinction one level down: a route quota of 0 is not "inherit".
  const zeroRoute = resolveCapacity(snapshot(5, { land: 0 }), 'land');
  assert.equal(zeroRoute.available, 0, 'a route that is full does not fall back to the pool');
});

test('a model with no pre-order cell is untracked — the catalogue as it stood before 0075', () => {
  const none = resolveCapacity(null, 'air');
  assert.equal(none.available, null);
  assert.deepEqual(none.targets, []);
  assert.equal(
    resolveForOrderType('pre_order', shelf(0), { option_value_ids: ['v_mini'], color_id: null }, null, 'air').available,
    null,
    'and a pre-order against it is still sellable, exactly as it was'
  );
});

// ================================================== the migration, unchanged

test('the migration leaves every existing row untracked, and touches no reservation', () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,stock_reserved,options,colors,images)
      VALUES ('p_old','old','Old','قديم','کۆن',1000,'active',7,3,'[]','[]','[]');
    INSERT INTO product_option_groups (id,product_id,name_en) VALUES ('g','p_old','G');
    INSERT INTO product_option_values (id,product_id,group_id,name_en,stock,reserved) VALUES ('v','p_old','g','V',4,2);
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type) VALUES ('f','p_old','v','pre_order');
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method) VALUES ('t','p_old','f','air');
  `);
  assert.deepEqual(cellRowOf(raw, 'f'), { capacity: null, capacity_reserved: 0 });
  assert.deepEqual(
    row(raw, 'SELECT capacity, capacity_reserved FROM product_option_transports WHERE id = ?', 't'),
    { capacity: null, capacity_reserved: 0 }
  );
  // The stock counters the migration must not have touched.
  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_old'), {
    stock: 7,
    stock_reserved: 3,
  });
  assert.deepEqual(row(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'v'), {
    stock: 4,
    reserved: 2,
  });
});

function cellRowOf(raw: DatabaseSync, id: string) {
  return row(raw, 'SELECT capacity, capacity_reserved FROM product_option_fulfillment WHERE id = ?', id);
}

test('the ledger accepts the two new scopes and still refuses an invented one', () => {
  const raw = seedShop();
  raw.exec(`
    INSERT INTO inventory_ledger (id,product_id,scope,scope_id,kind,qty,idempotency_key)
      VALUES ('l1','p_a1','preorder','f_pre','reserve',1,'k1'),
             ('l2','p_a1','preorder_transport','t_land','reserve',1,'k2');
  `);
  assert.equal(ledger(raw).length, 2);
  assert.throws(
    () =>
      raw.exec(
        `INSERT INTO inventory_ledger (id,product_id,scope,scope_id,kind,qty,idempotency_key)
           VALUES ('l3','p_a1','capacity','f_pre','reserve',1,'k3')`
      ),
    /CHECK constraint failed/
  );
});

// ============================================ the engine, on the real schema

const move = (scope: 'preorder' | 'preorder_transport', id: string, qty = 1, line = 'line1') => ({
  product_id: 'p_a1',
  qty,
  line_id: line,
  targets: [{ scope, scope_id: id, stock: 0, reserved: 0, low_stock_threshold: null, label: id }] as const,
});

async function apply(
  db: D1Database,
  kind: 'reserve' | 'deduct' | 'release' | 'restore',
  operationId: string,
  m: ReturnType<typeof move>
) {
  const plan = await planInventory(db, [{ ...m, targets: [...m.targets] }], { kind, operationId, orderId: 'o1' });
  if (plan.statements.length) await db.batch(plan.statements);
  return plan;
}

test('reserve / deduct / release move a capacity row exactly as they move a stock row', async () => {
  const raw = seedShop({ pool: 2 });
  const db = asD1(raw);

  await apply(db, 'reserve', 'op1', move('preorder', 'f_pre'));
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 1 }, 'a hold moves only the reserved side');
  assert.deepEqual(optionRow(raw), { stock: 1, reserved: 0 }, 'and the shelf is untouched');

  await apply(db, 'deduct', 'op1', move('preorder', 'f_pre'));
  assert.deepEqual(cellRow(raw), { capacity: 1, capacity_reserved: 0 }, 'confirmation turns the hold into a decrement');
  assert.deepEqual(optionRow(raw), { stock: 1, reserved: 0 });

  await apply(db, 'restore', 'op1', move('preorder', 'f_pre'));
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 0 }, 'a return puts the place back');
});

test('a hold is released exactly once — a repeat plans nothing and changes nothing', async () => {
  const raw = seedShop({ pool: 2 });
  const db = asD1(raw);
  await apply(db, 'reserve', 'op1', move('preorder', 'f_pre'));

  const first = await apply(db, 'release', 'op1', move('preorder', 'f_pre'));
  assert.equal(first.applied, 1);
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 0 });

  const again = await apply(db, 'release', 'op1', move('preorder', 'f_pre'));
  assert.equal(again.applied, 0, 'the UNIQUE idempotency key makes the repeat a no-op');
  assert.equal(again.skipped, 1);
  assert.equal(again.statements.length, 0, 'nothing is even planned, so nothing can go negative');
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 0 });
});

test('an untracked capacity reserves nothing, and a full one is refused rather than driven negative', async () => {
  const untracked = seedShop({ pool: null });
  const u = await apply(asD1(untracked), 'reserve', 'op1', move('preorder', 'f_pre'));
  assert.equal(u.applied, 0);
  assert.deepEqual(u.rejected.map((r) => r.reason), ['NOT_TRACKED']);

  const full = seedShop({ pool: 0 });
  const f = await apply(asD1(full), 'reserve', 'op1', move('preorder', 'f_pre'));
  assert.equal(f.applied, 0);
  assert.deepEqual(f.rejected.map((r) => r.reason), ['INSUFFICIENT_STOCK']);
  assert.deepEqual(cellRow(full), { capacity: 0, capacity_reserved: 0 });
});

// ================================================== the doors, end to end

test('direct sale sells out while the pre-order stays open on the SAME model', async () => {
  const raw = seedShop({ stock: 1, pool: 2 });
  const db = asD1(raw);

  // The one unit on the shelf goes to a direct buyer.
  assert.equal((await addLine(db, { fulfillmentType: 'direct_sale' })).success, true);
  const first = await buy(db);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual(optionRow(raw), { stock: 1, reserved: 1 }, 'held, not yet deducted');
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 0 }, 'a direct sale never touches the capacity');

  // A second direct sale has nothing left to take.
  clearCart(raw);
  const soldOut = await addLine(db, { fulfillmentType: 'direct_sale' });
  assert.equal(soldOut.success, false);
  assert.equal(soldOut.code, 'OUT_OF_STOCK');

  // The pre-order is unaffected.
  clearCart(raw);
  assert.equal((await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'air' })).success, true);
  const pre = await buy(db);
  assert.equal(pre.success, true, JSON.stringify(pre));
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 1 });
  assert.deepEqual(optionRow(raw), { stock: 1, reserved: 1 }, 'and the shelf is exactly where the direct sale left it');
});

test('three routes share one pool: selling by air is one fewer for sea', async () => {
  const raw = seedShop({ stock: 1, pool: 2, routeQuota: {} }); // no route has a quota
  const db = asD1(raw);

  await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'air' });
  assert.equal((await buy(db)).success, true);
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 1 });

  const view = await loadRelationsView(db, 'p_a1', 'OPTION');
  const cap = capacityFrom(view, ['v_mini'])!;
  assert.equal(resolveCapacity(cap, 'sea').available, 1, 'the air sale came out of the pool sea spends');
  assert.equal(resolveCapacity(cap, 'land').available, 1);
  assert.deepEqual(resolveCapacity(cap, 'sea').targets[0].scope_id, 'f_pre');

  // The second and last place goes by sea; the third is refused on every route.
  clearCart(raw);
  await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'sea' });
  assert.equal((await buy(db)).success, true);
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 2 });

  clearCart(raw);
  const third = await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'land' });
  assert.equal(third.success, false);
  assert.equal(third.code, 'PREORDER_CAPACITY_EXHAUSTED', JSON.stringify(third));
});

test('a route with its own quota is independent of the pool AND of the other routes, and spends ONE counter', async () => {
  const raw = seedShop({ stock: 1, pool: 2, routeQuota: { land: 1 } });
  const db = asD1(raw);

  await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'land' });
  assert.equal((await buy(db)).success, true);

  assert.deepEqual(routeRow(raw, 'land'), { capacity: 1, capacity_reserved: 1 }, 'its own quota moved');
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 0 }, 'and the shared pool did NOT — one counter per sale');
  assert.deepEqual(routeRow(raw, 'air'), { capacity: null, capacity_reserved: 0 }, 'no quantity was copied onto the other routes');
  assert.deepEqual(routeRow(raw, 'sea'), { capacity: null, capacity_reserved: 0 });
  assert.deepEqual(
    ledger(raw).map((l) => [l.scope, l.scope_id, l.kind]),
    [['preorder_transport', 't_land', 'reserve']],
    'exactly one ledger row, naming the route'
  );

  // Land is now full; air and sea still have the whole pool.
  clearCart(raw);
  const full = await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'land' });
  assert.equal(full.success, false);
  assert.equal(full.code, 'PREORDER_CAPACITY_EXHAUSTED');

  clearCart(raw);
  assert.equal((await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'air' })).success, true);
  assert.equal((await buy(db)).success, true);
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 1 });
  assert.deepEqual(routeRow(raw, 'land'), { capacity: 1, capacity_reserved: 1 }, 'land is untouched by the air sale');
});

test('an untracked pre-order is unlimited, and a pool of 0 is refused — the two are not the same', async () => {
  const unlimited = seedShop({ stock: 1, pool: null, routeQuota: {} });
  const udb = asD1(unlimited);
  for (let i = 0; i < 3; i += 1) {
    clearCart(unlimited);
    assert.equal((await addLine(udb, { fulfillmentType: 'pre_order', transportMethod: 'air' })).success, true);
    const res = await buy(udb);
    assert.equal(res.success, true, `pre-order ${i + 1} should be unlimited: ${JSON.stringify(res)}`);
  }
  assert.deepEqual(cellRow(unlimited), { capacity: null, capacity_reserved: 0 }, 'nothing was ever reserved');
  assert.equal(ledger(unlimited).length, 0, 'and nothing was written to the ledger');

  const none = seedShop({ stock: 1, pool: 0, routeQuota: {} });
  const refused = await addLine(asD1(none), { fulfillmentType: 'pre_order', transportMethod: 'air' });
  assert.equal(refused.success, false);
  assert.equal(refused.code, 'PREORDER_CAPACITY_EXHAUSTED', JSON.stringify(refused));
});

// ================================================== payment method is not order type

test('a CASH ON DELIVERY pre-order consumes capacity and leaves the shelf untouched', async () => {
  const raw = seedShop({ stock: 1, pool: 2, routeQuota: {} });
  const db = asD1(raw);
  await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'air' });

  const res = await buy(db, { paymentMethodId: 'cash' });
  assert.equal(res.success, true, JSON.stringify(res));
  assert.deepEqual(cellRow(raw), { capacity: 2, capacity_reserved: 1 }, 'the capacity is what a COD pre-order spends');
  assert.deepEqual(optionRow(raw), { stock: 1, reserved: 0 }, 'cash on delivery did NOT turn it into a direct sale');
  assert.deepEqual(
    ledger(raw).map((l) => [l.scope, l.scope_id]),
    [['preorder', 'f_pre']],
    'one ledger row, and it names the pre-order pool'
  );
});

test('prepaid and cash on delivery reserve the SAME counter — the basis prices, it never re-targets', async () => {
  const targets = [] as string[];
  for (const paymentMethodId of ['wallet', 'cash']) {
    const raw = seedShop({ stock: 1, pool: 2, routeQuota: {} });
    raw.exec("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('d','buyer','deposit','USD',500000,'approved')");
    const db = asD1(raw);
    await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'sea' });
    const res = await buy(db, { paymentMethodId, useWallet: paymentMethodId === 'wallet' });
    assert.equal(res.success, true, `${paymentMethodId}: ${JSON.stringify(res)}`);
    targets.push(ledger(raw).map((l) => `${l.scope}:${l.scope_id}`).join(','));
    assert.deepEqual(optionRow(raw), { stock: 1, reserved: 0 }, `${paymentMethodId} left the shelf alone`);
  }
  assert.equal(targets[0], targets[1]);
  assert.equal(targets[0], 'preorder:f_pre');
});

// ================================================== concurrency and release

test('two checkouts for the LAST pre-order place: exactly one commits', async () => {
  const raw = seedShop({ stock: 1, pool: 1, routeQuota: {} });
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('rival','Ali','a@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_r','rival','Home','Ali','+9647701234599','Baghdad, Karrada 13','',1);
  `);
  const db = asD1(raw);
  const rival: StubUser = { id: 'rival', role: 'customer', email: 'a@x.co' };

  // BOTH LINES ARE VALIDATED WHILE THE PLACE IS STILL FREE, which is the race
  // the door has to survive: a cart check cannot hold anything, so two buyers
  // reach checkout each believing the last place is theirs. Only the batch
  // decides — the guarded INSERT/UPDATE match nothing for the loser and its
  // reservation fence, CHECK (actual = expected), rolls the whole batch back.
  const line = { productId: 'p_a1', qty: 1, optionId: 'v_mini', fulfillmentType: 'pre_order', transportMethod: 'air' };
  assert.equal((await json(await post(appFor(db), '/api/cart/items', line))).success, true);
  assert.equal((await json(await post(appFor(db, rival), '/api/cart/items', line))).success, true);
  assert.deepEqual(cellRow(raw), { capacity: 1, capacity_reserved: 0 }, 'a cart holds nothing');

  const first = await buy(db);
  assert.equal(first.success, true, JSON.stringify(first));
  const second = await json(await post(appFor(db, rival), '/api/orders', orderBody({ addressId: 'addr_r' })));
  assert.equal(second.success, false, 'the second buyer cannot have the same place');
  assert.equal(second.code, 'PREORDER_CAPACITY_EXHAUSTED', JSON.stringify(second));

  assert.deepEqual(cellRow(raw), { capacity: 1, capacity_reserved: 1 }, 'exactly one hold exists');
  assert.equal(ledger(raw).filter((l) => l.kind === 'reserve').length, 1);
  assert.equal(all(raw, 'SELECT id FROM orders').length, 1, 'and exactly one order');
});

test('cancelling gives the pre-order place back once, and cancelling again changes nothing', async () => {
  const raw = seedShop({ stock: 1, pool: 2, routeQuota: { land: 1 } });
  const db = asD1(raw);
  await addLine(db, { fulfillmentType: 'pre_order', transportMethod: 'land' });
  const res = await buy(db);
  assert.equal(res.success, true, JSON.stringify(res));
  const orderId = String(res.order.id);
  assert.deepEqual(routeRow(raw, 'land'), { capacity: 1, capacity_reserved: 1 });

  const cancel = await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, { reason: 'changed my mind' }));
  assert.equal(cancel.success, true, JSON.stringify(cancel));
  assert.deepEqual(routeRow(raw, 'land'), { capacity: 1, capacity_reserved: 0 }, 'the quota is free again');

  const again = await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, { reason: 'again' }));
  void again; // a second cancel may be refused by the order state; the counter is what matters
  assert.deepEqual(routeRow(raw, 'land'), { capacity: 1, capacity_reserved: 0 }, 'and it is not released twice');
  assert.equal(ledger(raw).filter((l) => l.kind === 'release').length, 1, 'one release row, for ever');
});

// ================================================== what the storefront says

test('availability reports the counter that actually limits the line, per route', async () => {
  const raw = seedShop({ stock: 0, pool: 2, routeQuota: { land: 1 } });
  const db = asD1(raw);
  const view = await loadRelationsView(db, 'p_a1', 'OPTION');
  const cap = capacityFrom(view, ['v_mini']);

  const a = saleAvailability(
    {
      selling_type: 'direct_sale',
      stock: null,
      options: [{ id: 'v_mini', name_en: 'A1 mini', active: true } as never],
      colors: [],
      preorder_transports: [
        { method: 'air', active: true, commission_iqd: 7500 },
        { method: 'sea', active: true, commission_iqd: 3000 },
        { method: 'land', active: true, commission_iqd: 2000 },
      ] as never,
      sale_types: ['direct_sale', 'pre_order'],
    } as never,
    {
      optionValueIds: ['v_mini'],
      inventory: shelf(0),
      capacity: cap,
      transportMethod: 'land',
      preferredType: 'pre_order',
    }
  );

  assert.equal(a.mode, 'preorder', 'sold out on the shelf, open for pre-order');
  assert.equal(a.stock.available, 0, 'the shelf block still tells the truth about the shelf');
  assert.equal(a.preorder.capacity.scope, 'preorder_transport', 'land holds its own quota');
  assert.equal(a.preorder.capacity.available, 1);
  assert.equal(a.stock.max_qty, 1, 'the stepper is capped by the counter that limits the line');
  assert.deepEqual(
    a.preorder.routes.map((r) => [r.method, r.scope, r.available]),
    [
      ['air', 'preorder', 2],
      ['sea', 'preorder', 2],
      ['land', 'preorder_transport', 1],
    ],
    'air and sea show the shared pool; land shows its own'
  );
});
