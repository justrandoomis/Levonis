/**
 * A RETURN PUTS THE UNITS BACK THROUGH THE LEDGER — docs/BUNDLES_MYSTERY.md
 * §3.4, and half of case 12 of the owner's seventeen.
 *
 * A LIVE BUG, FIXED BEFORE ANYTHING DEPENDS ON IT. `worker/routes/returns.ts`
 * credited an approved refund with
 * `UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL`.
 * That bypassed `inventory_ledger` entirely and ALWAYS credited the BASE row:
 *
 *   - for an OPTION, COLOR or VARIANT_COMBINATION product it added units to a
 *     row that never sold them, while the row that did stayed short — silently,
 *     for ever, with no ledger entry to notice it by;
 *   - for a product whose base stock is NULL it did nothing at all and said so
 *     to nobody;
 *   - and it would have been wrong once per component for a bundle.
 *
 * It is now `planInventory({kind:'restore'})` replayed from the order's stored
 * `deduct` rows, with its own fence row in the same batch.
 *
 * The second fix here: RELEASE VERSUS RESTORE IS DECIDED PER LEDGER ROW. The
 * old rule asked "has this order any deduct row?" once and applied the answer to
 * everything, so a PARTIALLY deducted order tried to restore rows that were
 * never deducted — each of which fails its own guard and matches zero rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, json, count, row, all } from './fixtures/app';
import { returnRoutes } from '../worker/routes/returns';
import { planInventory, type StockMove } from '../worker/lib/inventory';
import { deductOrderStock, planOrderReturn, returnOrderStock, stockReturnNote } from '../worker/lib/orderInventory';

/**
 * One order of four lines, one per inventory mode, each already RESERVED and
 * DEDUCTED exactly as a delivered order's would be.
 */
function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('boss','Admin','a@x.co','h','admin');
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types) VALUES
      ('p_base','base','Base',25000,'active',10,'BASE','direct_sale','["direct_sale"]'),
      ('p_opt','opt','Option',30000,'active',99,'OPTION','direct_sale','["direct_sale"]'),
      ('p_col','col','Colour',40000,'active',99,'COLOR','direct_sale','["direct_sale"]'),
      ('p_var','var','Variant',50000,'active',99,'VARIANT_COMBINATION','direct_sale','["direct_sale"]');
    INSERT INTO product_option_groups (id,product_id,name_en,sort) VALUES ('g_opt','p_opt','Size',0),('g_var','p_var','Size',0);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,stock,reserved) VALUES
      ('ov_l','p_opt','g_opt','Large',6,0), ('ov_v','p_var','g_var','Large',NULL,0);
    INSERT INTO product_colors (id,product_id,name_en,hex,stock,reserved) VALUES ('pc_black','p_col','Black','#000',4,0);
    INSERT INTO product_variants (id,product_id,combo_key,stock,reserved,active) VALUES ('pv_1','p_var','o:ov_v',7,0,1);
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',145000,0,1400,145000,0,'2026-06-01T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids,color_id)
      VALUES ('oi_base','ORD-1','p_base','Base','',2,25000,50000,'','[]',''),
             ('oi_opt','ORD-1','p_opt','Option','Large',2,30000,60000,'ov_l','["ov_l"]',''),
             ('oi_col','ORD-1','p_col','Colour','Black',1,40000,40000,'','[]','pc_black'),
             ('oi_var','ORD-1','p_var','Variant','Large',1,50000,50000,'ov_v','["ov_v"]','');
  `);
}

const target = (scope: 'base' | 'option' | 'color' | 'variant', scopeId: string) => ({
  scope,
  scope_id: scopeId,
  stock: 0,
  reserved: 0,
  low_stock_threshold: null,
  label: scopeId || 'base',
});

const MOVES: StockMove[] = [
  { product_id: 'p_base', qty: 2, line_id: 'oi_base', targets: [target('base', '')] },
  { product_id: 'p_opt', qty: 2, line_id: 'oi_opt', targets: [target('option', 'ov_l')] },
  { product_id: 'p_col', qty: 1, line_id: 'oi_col', targets: [target('color', 'pc_black')] },
  { product_id: 'p_var', qty: 1, line_id: 'oi_var', targets: [target('variant', 'pv_1')] },
];

/** Checkout then confirmation, exactly as the routes do them. */
async function reserveAndDeduct(db: D1Database) {
  const plan = await planInventory(db, MOVES, { kind: 'reserve', operationId: 'ORD-1', orderId: 'ORD-1', reason: 'checkout' });
  assert.deepEqual(plan.rejected, []);
  await db.batch(plan.statements);
  const res = await deductOrderStock(db, 'ORD-1', 'boss');
  assert.equal(res.rejected, 0);
}

function openCase(raw: DatabaseSync, id: string, itemId: string, qty: number) {
  raw
    .prepare(
      `INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,within_window,delivered_at_snapshot)
       VALUES (?,'ORD-1',?,'buyer',?,'defective','inspected',1,'2026-06-01T00:00:00.000Z')`
    )
    .run(id, itemId, qty);
}

const adminApp = (db: D1Database) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'a@x.co' }, (a) => {
    a.route('/api/returns', returnRoutes);
  });

const stockOf = (raw: DatabaseSync, sql: string, id: string) => row<{ stock: number | null; reserved: number }>(raw, sql, id)!;
const baseRow = (raw: DatabaseSync, id: string) =>
  row<{ stock: number | null; stock_reserved: number }>(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', id)!;

// --------------------------------------------------------- the four modes

test('an approved refund credits the AUTHORITATIVE row for every inventory mode', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await reserveAndDeduct(db);

  // Deducted: base 10→8, option 6→4, colour 4→3, variant 7→6.
  assert.equal(baseRow(raw, 'p_base').stock, 8);
  assert.equal(stockOf(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'ov_l').stock, 4);
  assert.equal(stockOf(raw, 'SELECT stock, reserved FROM product_colors WHERE id = ?', 'pc_black').stock, 3);
  assert.equal(stockOf(raw, 'SELECT stock, reserved FROM product_variants WHERE id = ?', 'pv_1').stock, 6);

  const app = adminApp(db);
  for (const [caseId, itemId, qty] of [
    ['rc_base', 'oi_base', 2],
    ['rc_opt', 'oi_opt', 2],
    ['rc_col', 'oi_col', 1],
    ['rc_var', 'oi_var', 1],
  ] as Array<[string, string, number]>) {
    openCase(raw, caseId, itemId, qty);
    const res = await json(await post(app, `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' }));
    assert.equal(res.success, true, caseId);
  }

  // Every unit is back ON THE ROW IT CAME OFF — and the base row of the three
  // non-BASE products was never touched, which is precisely what the raw
  // `UPDATE products SET stock = stock + ?` got wrong.
  assert.equal(baseRow(raw, 'p_base').stock, 10);
  assert.equal(stockOf(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'ov_l').stock, 6);
  assert.equal(stockOf(raw, 'SELECT stock, reserved FROM product_colors WHERE id = ?', 'pc_black').stock, 4);
  assert.equal(stockOf(raw, 'SELECT stock, reserved FROM product_variants WHERE id = ?', 'pv_1').stock, 7);
  assert.equal(baseRow(raw, 'p_opt').stock, 99, 'the OPTION product’s base row is untouched and irrelevant');
  assert.equal(baseRow(raw, 'p_col').stock, 99);
  assert.equal(baseRow(raw, 'p_var').stock, 99);

  // ...and every movement is in the ledger, keyed to the case that caused it.
  const restores = all<{ scope: string; scope_id: string; qty: number; reason: string }>(
    raw,
    "SELECT scope, scope_id, qty, reason FROM inventory_ledger WHERE kind='restore' ORDER BY scope"
  );
  assert.deepEqual(restores, [
    { scope: 'base', scope_id: '', qty: 2, reason: 'return' },
    { scope: 'color', scope_id: 'pc_black', qty: 1, reason: 'return' },
    { scope: 'option', scope_id: 'ov_l', qty: 2, reason: 'return' },
    { scope: 'variant', scope_id: 'pv_1', qty: 1, reason: 'return' },
  ]);
  // The restore carries its own fence row: a guard that matched nothing would
  // have rolled the credit back with it.
  assert.deepEqual(row(raw, "SELECT expected, actual FROM order_reservation_fence WHERE order_id='ORD-1' AND kind='restore'"), {
    expected: 4,
    actual: 4,
  });
});

test('a partial-qty return gives back exactly what came back', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await reserveAndDeduct(db);
  openCase(raw, 'rc_half', 'oi_opt', 1); // one of the two
  await json(await post(adminApp(db), '/api/returns/admin/rc_half/transition', { to: 'resolved', resolution: 'refund' }));
  assert.equal(stockOf(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'ov_l').stock, 5);
});

test('the restore is idempotent: a replayed approval moves nothing a second time', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await reserveAndDeduct(db);
  openCase(raw, 'rc_base', 'oi_base', 2);
  const app = adminApp(db);
  await json(await post(app, '/api/returns/admin/rc_base/transition', { to: 'resolved', resolution: 'refund' }));
  assert.equal(baseRow(raw, 'p_base').stock, 10);

  // The state flip is conditional, so a replay is refused there first...
  const again = await json(await post(app, '/api/returns/admin/rc_base/transition', { to: 'resolved', resolution: 'refund' }));
  assert.equal(again.success, false, 'the conditional state flip refuses the replay first');
  assert.equal(baseRow(raw, 'p_base').stock, 10);

  // ...and even if it were not, the ledger key is the second guard.
  const replay = await planInventory(
    db,
    [{ product_id: 'p_base', qty: 2, line_id: 'oi_base', targets: [target('base', '')] }],
    { kind: 'restore', operationId: 'rc_base', orderId: 'ORD-1', reason: 'return' }
  );
  assert.equal(replay.statements.length, 0);
  assert.equal(replay.skipped, 1);
});

test('a line that was never deducted has nothing to give back, and no forged units appear', async () => {
  // The old raw UPDATE credited `kase.qty` whatever the ledger said.
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const plan = await planInventory(db, MOVES, { kind: 'reserve', operationId: 'ORD-1', orderId: 'ORD-1', reason: 'checkout' });
  await db.batch(plan.statements); // reserved, never confirmed
  openCase(raw, 'rc_base', 'oi_base', 2);
  const res = await json(await post(adminApp(db), '/api/returns/admin/rc_base/transition', { to: 'resolved', resolution: 'refund' }));
  assert.equal(res.success, true, 'the refund itself still happens');
  assert.equal(baseRow(raw, 'p_base').stock, 10, 'stock was never taken, so nothing is invented');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind='restore'"), 0);
});

// ------------------------------------------- release vs restore, PER ROW

test('a PARTIALLY deducted order releases what was held and restores what was taken', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const plan = await planInventory(db, MOVES, { kind: 'reserve', operationId: 'ORD-1', orderId: 'ORD-1', reason: 'checkout' });
  await db.batch(plan.statements);

  // Only two of the four lines were ever deducted — the shape a confirmation
  // whose guard rejected two lines actually leaves behind.
  const partial = await planInventory(
    db,
    MOVES.filter((m) => m.line_id === 'oi_base' || m.line_id === 'oi_col'),
    { kind: 'deduct', operationId: 'ORD-1', orderId: 'ORD-1', reason: 'order confirmed' }
  );
  await db.batch(partial.statements);
  assert.equal(baseRow(raw, 'p_base').stock, 8);
  assert.equal(stockOf(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'ov_l').stock, 6);
  assert.equal(stockOf(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'ov_l').reserved, 2, 'still held');

  const planned = await planOrderReturn(db, 'ORD-1', 'boss');
  assert.equal(planned.kind, 'mixed');
  assert.deepEqual(planned.parts.map((p) => p.kind).sort(), ['release', 'restore']);
  assert.deepEqual(planned.plan!.rejected, [], 'nothing is asked to restore units it never took');

  const out = await returnOrderStock(db, 'ORD-1', 'boss');
  assert.equal(out.kind, 'mixed');
  assert.equal(out.applied, 4, 'all four rows moved — none silently matched zero');

  // Everything is back where it started.
  assert.deepEqual(baseRow(raw, 'p_base'), { stock: 10, stock_reserved: 0 });
  assert.deepEqual(stockOf(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'ov_l'), { stock: 6, reserved: 0 });
  assert.deepEqual(stockOf(raw, 'SELECT stock, reserved FROM product_colors WHERE id = ?', 'pc_black'), { stock: 4, reserved: 0 });
  assert.deepEqual(stockOf(raw, 'SELECT stock, reserved FROM product_variants WHERE id = ?', 'pv_1'), { stock: 7, reserved: 0 });

  // Two kinds, two fence rows, each balancing on its own.
  assert.deepEqual(
    all<{ kind: string; expected: number; actual: number }>(
      raw,
      "SELECT kind, expected, actual FROM order_reservation_fence WHERE order_id='ORD-1' ORDER BY kind"
    ),
    [
      { kind: 'release', expected: 2, actual: 2 },
      { kind: 'restore', expected: 2, actual: 2 },
    ]
  );
});

test('a wholly undeducted order still releases, and a wholly deducted one still restores', async () => {
  for (const deduct of [false, true]) {
    const raw = freshDb();
    seed(raw);
    const db = asD1(raw);
    const plan = await planInventory(db, MOVES, { kind: 'reserve', operationId: 'ORD-1', orderId: 'ORD-1', reason: 'checkout' });
    await db.batch(plan.statements);
    if (deduct) await deductOrderStock(db, 'ORD-1', 'boss');
    const out = await returnOrderStock(db, 'ORD-1', 'boss');
    assert.equal(out.kind, deduct ? 'restore' : 'release');
    assert.deepEqual(baseRow(raw, 'p_base'), { stock: 10, stock_reserved: 0 });
  }
});

test('the operator note says what happened, and never “Stock mixedd”', () => {
  assert.equal(stockReturnNote('release', 2), 'Stock released for 2 row(s).');
  assert.equal(stockReturnNote('restore', 2), 'Stock restored for 2 row(s).');
  assert.equal(stockReturnNote('mixed', 4), 'Stock returned for 4 row(s) — some released, some restored.');
  assert.equal(stockReturnNote('none', 0), null);
});
