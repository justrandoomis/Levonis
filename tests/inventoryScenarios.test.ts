/**
 * THE SCENARIO MATRIX — the feature end to end, as the shop actually runs it.
 *
 * ###########################################################################
 * #  CURRENT STOCK MAY CARRY SEVERAL HISTORICAL COSTS, AND EVERY SALE EATS  #
 * #  THE OLDEST AVAILABLE COST LAYER FIRST.                                 #
 * ###########################################################################
 *
 * The unit suites each prove one piece. This one runs the pieces TOGETHER, in
 * the order a real week happens in: buy, receive, sell, return, count, sell
 * again — through the real routes, against the real migrations, with only the
 * session stubbed. It is the suite that would catch a defect that lives in the
 * seam between two correct modules.
 *
 * Every expected figure is written out as an integer and derived by hand in
 * the comment beside it. A test that recomputes a number the way the code does
 * proves only that the code agrees with itself.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { planLotConsumption, planLotRestore, cogsByLine } from '../worker/lib/inventoryLots';
import { planOrderDeduction, planOrderReturn } from '../worker/lib/orderInventory';
import { planInventory } from '../worker/lib/inventory';
import type { StockMove } from '../worker/lib/inventory';
import { freshDb, asD1, stubApp, post, get, json, row, all, count, type StubUser } from './fixtures/app';

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null };

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Boss','boss@x.co','h','admin'),
      ('buyer','Sara','sara@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,images,stock,inventory_mode)
      VALUES ('p1','printer','Printer','طابعة',900000,'[]',0,'BASE');
  `);
}

const app = (raw: DatabaseSync) =>
  stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/inventory', adminInventoryRoutes));

/** A purchase, straight into the table, so a scenario reads as a sequence of
 *  ACTIONS rather than a wall of setup. */
function purchase(raw: DatabaseSync, id: string, qty: number, unit: number, freight: number, delivery: number) {
  raw.prepare(
    `INSERT INTO incoming_inventory
       (id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,
        shipping_total_iqd,internal_delivery_total_iqd,status)
     VALUES (?,'p1','base','',?,?,?,?,'incoming')`
  ).run(id, qty, unit, freight, delivery);
}

function order(raw: DatabaseSync, id: string, lines: Array<{ item: string; qty: number }>) {
  raw.prepare(
    `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
        payment_method_id,subtotal_iqd,shipping_iqd,points_discount_iqd,cod_tax_iqd,exchange_rate,
        total_iqd,due_on_delivery_iqd,seller_type,created_at)
     VALUES (?,'buyer','delivered','{}','standard','{}','cash',0,0,0,0,1400,0,0,'levonis','2026-03-01T00:00:00.000Z')`
  ).run(id);
  for (const l of lines) {
    raw.prepare(
      `INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
       VALUES (?,?,'p1','Printer',?,900000,?,NULL,'unpriced')`
    ).run(l.item, id, l.qty, l.qty * 900000);
  }
  return id;
}

const move = (line: string, qty: number): StockMove =>
  ({ line_id: line, product_id: 'p1', qty, targets: [{ scope: 'base', scope_id: '' }] }) as StockMove;

const shelf = (raw: DatabaseSync) => row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id='p1'`)!.stock;
const lots = (raw: DatabaseSync) =>
  all<{ unit_cost_iqd: number; qty_remaining: number }>(
    raw, 'SELECT unit_cost_iqd, qty_remaining FROM inventory_lots ORDER BY received_at, id'
  );

// ===========================================================================
//  A. THE OWNER'S OWN EXAMPLE, THROUGH THE WHOLE STACK
// ===========================================================================

test('A — two purchases, one sale of twelve: the shelf, the layers and the COGS all agree', async () => {
  const raw = freshDb();
  seed(raw);
  const a = app(raw);

  // Two shipments. 400,000 a unit + 400,000 freight + 100,000 delivery over 10
  // units is 450,000 each; 500,000 + 500,000 + 100,000 over 10 is 560,000.
  purchase(raw, 'incA', 10, 400_000, 400_000, 100_000);
  purchase(raw, 'incB', 10, 500_000, 500_000, 100_000);
  await post(a, '/api/admin/inventory/incoming/incA/receive', { receipt_id: 'rA', qty: 10 });
  await post(a, '/api/admin/inventory/incoming/incB/receive', { receipt_id: 'rB', qty: 10 });

  assert.equal(shelf(raw), 20);
  assert.deepEqual(lots(raw), [
    { unit_cost_iqd: 450_000, qty_remaining: 10 },
    { unit_cost_iqd: 560_000, qty_remaining: 10 },
  ]);

  const oid = order(raw, 'o1', [{ item: 'i1', qty: 12 }]);
  const plan = await planLotConsumption(asD1(raw), oid, [move('i1', 12)]);
  await asD1(raw).batch(plan.statements);

  // 10 x 450,000 + 2 x 560,000 = 4,500,000 + 1,120,000 = 5,620,000.
  const cogs = (await cogsByLine(asD1(raw), [oid])).get('i1')!;
  assert.equal(cogs.cogs_iqd, 5_620_000, 'the owner’s exact number');
  assert.notEqual(cogs.cogs_iqd, 12 * 560_000, 'newest-first');
  assert.notEqual(cogs.cogs_iqd, 12 * 505_000, 'weighted average');
  assert.deepEqual(lots(raw), [
    { unit_cost_iqd: 450_000, qty_remaining: 0 },
    { unit_cost_iqd: 560_000, qty_remaining: 8 },
  ]);

  // And the screen's own summary agrees with the ledger: 8 x 560,000.
  const over = await json(await get(a, '/api/admin/inventory/overview'));
  assert.equal(over.on_hand_units, 8);
  assert.equal(over.inventory_value_iqd, 4_480_000);
});

// ===========================================================================
//  B. A RETURN PUTS THE UNITS BACK WHERE THEY CAME FROM
// ===========================================================================

test('B — a return credits the layers it took from, not the newest one', async () => {
  const raw = freshDb();
  seed(raw);
  const a = app(raw);
  purchase(raw, 'incA', 2, 400_000, 0, 0);
  purchase(raw, 'incB', 10, 560_000, 0, 0);
  await post(a, '/api/admin/inventory/incoming/incA/receive', { receipt_id: 'rA', qty: 2 });
  await post(a, '/api/admin/inventory/incoming/incB/receive', { receipt_id: 'rB', qty: 10 });

  const oid = order(raw, 'o1', [{ item: 'i1', qty: 3 }]);
  await asD1(raw).batch((await planLotConsumption(asD1(raw), oid, [move('i1', 3)])).statements);
  // 2 from the old layer, 1 from the new.
  assert.deepEqual(lots(raw), [
    { unit_cost_iqd: 400_000, qty_remaining: 0 },
    { unit_cost_iqd: 560_000, qty_remaining: 9 },
  ]);

  await asD1(raw).batch((await planLotRestore(asD1(raw), oid)).statements);
  // CREDITING ALL THREE TO THE NEWEST LAYER would invent 320,000 dinars of
  // inventory value out of a refund, and the next sale would then report a
  // cost the shop never paid.
  assert.deepEqual(lots(raw), [
    { unit_cost_iqd: 400_000, qty_remaining: 2 },
    { unit_cost_iqd: 560_000, qty_remaining: 10 },
  ]);
});

// ===========================================================================
//  C. A MISCOUNT, AND THE SALE THAT FOLLOWS IT
// ===========================================================================

test('C — a write-off eats the oldest layer, and the next sale is costed from what is left', async () => {
  const raw = freshDb();
  seed(raw);
  const a = app(raw);
  purchase(raw, 'incA', 5, 400_000, 0, 0);
  purchase(raw, 'incB', 5, 600_000, 0, 0);
  await post(a, '/api/admin/inventory/incoming/incA/receive', { receipt_id: 'rA', qty: 5 });
  await post(a, '/api/admin/inventory/incoming/incB/receive', { receipt_id: 'rB', qty: 5 });

  // Three boxes crushed in transit.
  const adj = await post(a, '/api/admin/inventory/adjustments', {
    product_id: 'p1', scope: 'base', delta: -3, reason: 'damaged', note: 'تلف بالنقل',
  });
  assert.equal(adj.status, 200);
  assert.equal(shelf(raw), 7);
  assert.deepEqual(lots(raw), [
    { unit_cost_iqd: 400_000, qty_remaining: 2 },
    { unit_cost_iqd: 600_000, qty_remaining: 5 },
  ]);

  // The next sale of four therefore costs 2 x 400,000 + 2 x 600,000.
  const oid = order(raw, 'o1', [{ item: 'i1', qty: 4 }]);
  await asD1(raw).batch((await planLotConsumption(asD1(raw), oid, [move('i1', 4)])).statements);
  const cogs = (await cogsByLine(asD1(raw), [oid])).get('i1')!;
  assert.equal(cogs.cogs_iqd, 2_000_000);
  assert.equal(cogs.lots, 2, 'the sale crossed two layers');
});

// ===========================================================================
//  D. THE WEEK, IN ORDER
// ===========================================================================

test('D — buy, receive, sell, return, count, sell: the counter and the layers never part', async () => {
  /**
   * THE ONE THAT GOES THROUGH THE REAL ORDER PATH.
   *
   * `planOrderDeduction` and `planOrderReturn` are what checkout and returns
   * actually call, and they move the COUNTER and the LAYERS in one `db.batch`.
   * Driving the lot layer directly, as the scenarios above do, proves FIFO; it
   * cannot prove that the shelf and the queue stay equal, and that equality is
   * the invariant everything else rests on. So this one reserves, deducts,
   * returns and adjusts exactly as the shop does, and checks the two numbers
   * against each other after every single step.
   */
  const raw = freshDb();
  seed(raw);
  const a = app(raw);
  const db = asD1(raw);

  const layers = () => lots(raw).reduce((n, l) => n + l.qty_remaining, 0);
  const agree = (step: string) =>
    assert.equal(shelf(raw), layers(), `after ${step}: the shelf and the cost layers disagree`);

  // Monday: two shipments arrive.
  purchase(raw, 'incA', 10, 450_000, 0, 0);
  purchase(raw, 'incB', 10, 560_000, 0, 0);
  await post(a, '/api/admin/inventory/incoming/incA/receive', { receipt_id: 'rA', qty: 10 });
  await post(a, '/api/admin/inventory/incoming/incB/receive', { receipt_id: 'rB', qty: 10 });
  assert.equal(shelf(raw), 20);
  agree('receiving');

  // Tuesday: a customer orders twelve. Reserved at checkout, deducted on
  // confirmation — the two steps the shop really has.
  const o1 = order(raw, 'o1', [{ item: 'i1', qty: 12 }]);
  const reserve = await planInventory(db, [move('i1', 12)], {
    kind: 'reserve', operationId: o1, orderId: o1, actorUserId: 'boss', reason: 'checkout',
  });
  await db.batch(reserve.statements);
  const deduct = await planOrderDeduction(db, o1, 'boss');
  assert.ok(deduct, 'the order had nothing to deduct');
  await db.batch(deduct.statements);

  assert.equal(shelf(raw), 8);
  agree('the sale');
  assert.equal((await cogsByLine(db, [o1])).get('i1')!.cogs_iqd, 5_620_000, 'the owner\u2019s exact number');
  assert.deepEqual(lots(raw), [
    { unit_cost_iqd: 450_000, qty_remaining: 0 },
    { unit_cost_iqd: 560_000, qty_remaining: 8 },
  ]);

  // Wednesday: the whole order comes back.
  const ret = await planOrderReturn(db, o1, 'boss');
  for (const part of ret.parts) await db.batch(part.plan.statements);
  assert.equal(shelf(raw), 20);
  agree('the return');
  // Each layer got back exactly what it gave, not three into the newest.
  assert.deepEqual(lots(raw), [
    { unit_cost_iqd: 450_000, qty_remaining: 10 },
    { unit_cost_iqd: 560_000, qty_remaining: 10 },
  ]);

  // Thursday: a stock count finds one missing.
  await post(a, '/api/admin/inventory/adjustments', { product_id: 'p1', scope: 'base', delta: -1, reason: 'count' });
  assert.equal(shelf(raw), 19);
  agree('the stock count');
  assert.deepEqual(lots(raw), [
    { unit_cost_iqd: 450_000, qty_remaining: 9 },
    { unit_cost_iqd: 560_000, qty_remaining: 10 },
  ]);

  // Friday: a sale of ten. 9 x 450,000 + 1 x 560,000 = 4,050,000 + 560,000.
  const o2 = order(raw, 'o2', [{ item: 'i2', qty: 10 }]);
  const reserve2 = await planInventory(db, [move('i2', 10)], {
    kind: 'reserve', operationId: o2, orderId: o2, actorUserId: 'boss', reason: 'checkout',
  });
  await db.batch(reserve2.statements);
  const deduct2 = await planOrderDeduction(db, o2, 'boss');
  assert.ok(deduct2);
  await db.batch(deduct2.statements);

  assert.equal((await cogsByLine(db, [o2])).get('i2')!.cogs_iqd, 4_610_000);
  assert.equal(shelf(raw), 9);
  agree('the second sale');
  // The week closes holding nine units, all from the 560,000 layer.
  assert.deepEqual(lots(raw), [
    { unit_cost_iqd: 450_000, qty_remaining: 0 },
    { unit_cost_iqd: 560_000, qty_remaining: 9 },
  ]);
});

// ===========================================================================
//  E. TWO PRODUCTS DO NOT SHARE A QUEUE
// ===========================================================================

test('E — each stock identity has its own FIFO queue', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,images,stock,inventory_mode)
            VALUES ('p2','filament','Filament','فلامنت',20000,'[]',0,'BASE')`);
  const a = app(raw);
  purchase(raw, 'incA', 5, 400_000, 0, 0);
  raw.prepare(
    `INSERT INTO incoming_inventory (id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,
       shipping_total_iqd,internal_delivery_total_iqd,status)
     VALUES ('incC','p2','base','',5,10000,0,0,'incoming')`
  ).run();
  await post(a, '/api/admin/inventory/incoming/incA/receive', { receipt_id: 'rA', qty: 5 });
  await post(a, '/api/admin/inventory/incoming/incC/receive', { receipt_id: 'rC', qty: 5 });

  assert.equal(shelf(raw), 5);
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id='p2'`)!.stock, 5);

  const oid = order(raw, 'o1', [{ item: 'i1', qty: 5 }]);
  await asD1(raw).batch((await planLotConsumption(asD1(raw), oid, [move('i1', 5)])).statements);

  // The filament's layer is untouched: the printer's sale did not reach into
  // another product's queue.
  assert.equal(
    count(raw, `SELECT qty_remaining AS n FROM inventory_lots WHERE product_id = 'p2'`),
    5
  );
  assert.equal(
    count(raw, `SELECT qty_remaining AS n FROM inventory_lots WHERE product_id = 'p1'`),
    0
  );
});

// ===========================================================================
//  F. THE INVARIANT, STATED ONCE
// ===========================================================================

test('F — no arrangement of these operations produces negative stock or a negative layer', async () => {
  const raw = freshDb();
  seed(raw);
  const a = app(raw);
  purchase(raw, 'incA', 3, 100_000, 0, 0);
  await post(a, '/api/admin/inventory/incoming/incA/receive', { receipt_id: 'rA', qty: 3 });

  // Every one of these is refused or capped, and none of them leaves a
  // negative number behind.
  await post(a, '/api/admin/inventory/adjustments', { product_id: 'p1', scope: 'base', delta: -99, reason: 'lost' });
  await post(a, '/api/admin/inventory/incoming/incA/receive', { receipt_id: 'rB', qty: 5 });
  const oid = order(raw, 'o1', [{ item: 'i1', qty: 99 }]);
  const plan = await planLotConsumption(asD1(raw), oid, [move('i1', 99)]);
  await asD1(raw).batch(plan.statements);

  assert.ok(shelf(raw) >= 0, 'the counter went negative');
  for (const l of lots(raw)) assert.ok(l.qty_remaining >= 0, 'a layer went negative');
  // The demand it could not meet is REPORTED rather than silently rounded
  // away — a bookkeeping gap must not refuse a paid order.
  assert.equal(plan.shortfall.length, 1);
  assert.equal(plan.shortfall[0].qty, 96);
});
