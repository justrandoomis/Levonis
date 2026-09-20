/**
 * RECEIVING AND ADJUSTING — «إضافة إلى المخزون الحالي» AND «تعديل المخزون».
 *
 * The brief's §80 groups A (receiving), B (double receipt) and G (adjustments),
 * against the real routes and the real migrations. Only the session is stubbed.
 *
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING
 *
 *  - A double tap must produce ONE lot, ONE ledger row and ONE increment. This
 *    is the operation where a retry is expensive, and the guard is the
 *    database's UNIQUE index rather than a disabled button.
 *  - A receipt is all-or-nothing: no arrangement of failures may leave the
 *    counter moved with no lot behind it, or a lot with no units on the shelf.
 *  - Cost must be STATED before units become sellable, and zero is a statement.
 *  - An assistant admin may run the warehouse and may not see what it cost —
 *    enforced server-side, on the payload, not by hiding a column.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { planReceive, readyToReceive, statusAfterReceipt, planAdjustmentLedger, counterTarget, type IncomingRow } from '../worker/lib/inventoryReceiving';
import { freshDb, asD1, stubApp, post, patch, get, json, row, all, count, type StubUser } from './fixtures/app';

// ----------------------------------------------------------------- harness

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null };
const ASSISTANT: StubUser = { id: 'asst', role: 'admin', email: 'a@x.co', admin_scope: 'assistant' };

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('asst','Asst','a@x.co','h','admin','assistant');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,images,stock,inventory_mode)
      VALUES ('p1','p1','Printer','طابعة',900000,'[]',0,'BASE');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,images,stock,inventory_mode)
      VALUES ('p2','p2','Filament','فلامنت',20000,'[]',NULL,'BASE');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,images,stock,inventory_mode)
      VALUES ('p3','p3','Resin','ريزن',30000,'[]',0,'OPTION');
    INSERT INTO product_option_groups (id,product_id,name_en) VALUES ('g1','p3','Model');
    INSERT INTO product_option_values (id,product_id,group_id,name_en,stock) VALUES ('o1','p3','g1','1kg',0);
  `);
}

/** A purchase, with costs stated unless the test says otherwise. */
function purchase(raw: DatabaseSync, over: Partial<Record<string, unknown>> = {}) {
  const r = {
    id: 'inc1', product_id: 'p1', scope: 'base', scope_id: '',
    qty_ordered: 10, purchase_unit_iqd: 400_000,
    shipping_total_iqd: 400_000, internal_delivery_total_iqd: 100_000,
    status: 'incoming', ...over,
  } as Record<string, unknown>;
  const keys = Object.keys(r);
  raw.prepare(
    `INSERT INTO incoming_inventory (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...(keys.map((k) => r[k]) as never[]));
  return r;
}

const app = (raw: DatabaseSync, user: StubUser = OWNER) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/admin/inventory', adminInventoryRoutes));

const incomingRow = (raw: DatabaseSync, id = 'inc1') =>
  row<IncomingRow>(raw, 'SELECT * FROM incoming_inventory WHERE id = ?', id)!;

// =====================================================================
//  A. THE GATE — what may be received, and what may not
// =====================================================================

test('cost must be STATED before units become sellable — and zero is a statement', () => {
  const base = {
    id: 'x', product_id: 'p1', scope: 'base', scope_id: '', qty_ordered: 10, qty_received: 0,
    purchase_unit_iqd: 400_000, supplier_id: null, purchase_date: null, status: 'incoming',
  } as const;

  const blank = readyToReceive({ ...base, shipping_total_iqd: null, internal_delivery_total_iqd: null } as IncomingRow, 10);
  assert.equal(blank.ok, false);
  assert.equal(blank.ok === false && blank.code, 'COST_NOT_STATED');
  assert.deepEqual(blank.ok === false && 'missing' in blank ? blank.missing : [], ['shipping', 'internal_delivery']);

  // THE WHOLE POINT: the owner carried the boxes themselves, so the internal
  // delivery really was zero. `!value` would call that "not entered".
  const zero = readyToReceive({ ...base, shipping_total_iqd: 0, internal_delivery_total_iqd: 0 } as IncomingRow, 10);
  assert.equal(zero.ok, true);
  assert.equal(zero.ok && zero.cost.unitCostIqd, 400_000);

  // One stated, one blank: the refusal names the blank one only.
  const half = readyToReceive({ ...base, shipping_total_iqd: 0, internal_delivery_total_iqd: null } as IncomingRow, 10);
  assert.deepEqual(half.ok === false && 'missing' in half ? half.missing : [], ['internal_delivery']);
});

test('a receipt may never exceed what was ordered, and says how much is left', () => {
  const r = {
    id: 'x', product_id: 'p1', scope: 'base', scope_id: '', qty_ordered: 10, qty_received: 7,
    purchase_unit_iqd: 400_000, shipping_total_iqd: 0, internal_delivery_total_iqd: 0,
    supplier_id: null, purchase_date: null, status: 'partial',
  } as IncomingRow;
  const over = readyToReceive(r, 4);
  assert.equal(over.ok === false && over.code, 'QTY_EXCEEDS_ORDER');
  assert.equal(over.ok === false && 'remaining' in over ? over.remaining : -1, 3);
  assert.equal(readyToReceive(r, 3).ok, true);

  assert.equal(readyToReceive({ ...r, qty_received: 10 }, 1).ok === false
    && (readyToReceive({ ...r, qty_received: 10 }, 1) as { code: string }).code, 'ALREADY_RECEIVED');
  assert.equal((readyToReceive({ ...r, status: 'cancelled' }, 1) as { code: string }).code, 'CANCELLED');
  assert.equal((readyToReceive(r, 0) as { code: string }).code, 'QTY_INVALID');
  assert.equal((readyToReceive(r, 1.5) as { code: string }).code, 'QTY_INVALID');
});

test('statusAfterReceipt: partial until the last unit, received on it', () => {
  const r = { qty_ordered: 10, qty_received: 0 } as IncomingRow;
  assert.equal(statusAfterReceipt(r, 4), 'partial');
  assert.equal(statusAfterReceipt(r, 10), 'received');
  assert.equal(statusAfterReceipt({ ...r, qty_received: 6 }, 4), 'received');
});

test('a capacity scope has no shelf, so nothing can be received into it', () => {
  assert.equal(counterTarget('preorder'), null);
  assert.equal(counterTarget('preorder_transport'), null);
  assert.deepEqual(counterTarget('base'), { table: 'products', column: 'stock' });
  assert.deepEqual(counterTarget('option'), { table: 'product_option_values', column: 'stock' });
  assert.deepEqual(counterTarget('color'), { table: 'product_colors', column: 'stock' });
  assert.deepEqual(counterTarget('variant'), { table: 'product_variants', column: 'stock' });
});

// =====================================================================
//  B. THE COMMIT — five writes, one batch, one outcome
// =====================================================================

test('receiving writes the lot, the receipt, the counter, the ledger row and the progress — together', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw);

  const res = await post(app(raw), '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'r-1', qty: 10 });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.success, true);
  assert.equal(body.status, 'received');

  // 400,000 + 40,000 shipping + 10,000 delivery = 450,000 a unit.
  const lot = row<Record<string, number | string | null>>(raw, 'SELECT * FROM inventory_lots WHERE incoming_id = ?', 'inc1')!;
  assert.equal(lot.qty_received, 10);
  assert.equal(lot.qty_remaining, 10);
  assert.equal(lot.unit_cost_iqd, 450_000);
  assert.equal(lot.total_cost_iqd, 4_500_000);
  assert.equal(lot.cost_basis, 'received');

  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM incoming_inventory_receipts WHERE incoming_id = 'inc1'`), 1);
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id = 'p1'`)!.stock, 10);
  assert.equal(incomingRow(raw).qty_received, 10);
  assert.equal(incomingRow(raw).status, 'received');

  const led = all<{ kind: string; qty: number }>(raw, `SELECT kind, qty FROM inventory_ledger WHERE product_id = 'p1'`);
  assert.deepEqual(led, [{ kind: 'adjust_in', qty: 10 }]);
});

test('THE DOUBLE TAP: the same receipt id twice makes one lot and one increment', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw);
  const a = app(raw);

  const first = await json(await post(a, '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'same', qty: 10 }));
  const second = await json(await post(a, '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'same', qty: 10 }));

  assert.equal(first.success, true);
  // §17: the second press is NOT an error. The first one worked.
  assert.equal(second.success, true);
  assert.equal(second.already, true);

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM incoming_inventory_receipts'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 1);
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id = 'p1'`)!.stock, 10);
  assert.equal(incomingRow(raw).qty_received, 10);
});

test('the read-before-write is not the guard: replaying the SAME batch moves nothing', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw);
  const db = asD1(raw);
  const row0 = incomingRow(raw);

  const plan = planReceive(db, {
    row: row0, qty: 10, receiptId: 'r-9', lotId: 'lot-9', actorUserId: 'boss', receivedAt: '2026-01-01T00:00:00.000Z',
  });
  await db.batch(plan.statements);

  // The SECOND planning is built from the SAME stale row — what a retry that
  // never re-read would send. The receipt goes in with a HARD insert, so the
  // duplicate raises and D1 discards the whole batch. Ten free units is what
  // the gentler `INSERT OR IGNORE` + `WHERE EXISTS (the receipt)` spelling
  // produced, and that is the defect this test exists for.
  const replay = planReceive(db, {
    row: row0, qty: 10, receiptId: 'r-9', lotId: 'lot-9b', actorUserId: 'boss', receivedAt: '2026-01-01T00:00:00.000Z',
  });
  await assert.rejects(db.batch(replay.statements));

  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id = 'p1'`)!.stock, 10);
  assert.equal(incomingRow(raw).qty_received, 10);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM incoming_inventory_receipts'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 1);
  // Not one stray row: the replay's batch was rolled back whole, so even the
  // lot it tried to write (under its own new id) is gone.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots'), 1);
});

test('a losing racer gets the units on the shelf, not a failure', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw);
  const a = app(raw);
  // Both presses read "no receipt yet" before either writes — the interleaving
  // the route's early return cannot catch. The batch's UNIQUE key does.
  const [first, second] = await Promise.all([
    post(a, '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'race', qty: 10 }),
    post(a, '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'race', qty: 10 }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const bodies = [await json(first), await json(second)];
  assert.equal(bodies.filter((b) => b.already === true).length, 1, 'exactly one press is told it was a repeat');
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id = 'p1'`)!.stock, 10);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 1);
});

test('two partial receipts make two cost layers, and the purchase closes exactly once', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw, { qty_ordered: 10, purchase_unit_iqd: 400_000, shipping_total_iqd: 400_000, internal_delivery_total_iqd: 100_000 });
  const a = app(raw);

  await post(a, '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'r1', qty: 4 });
  assert.equal(incomingRow(raw).status, 'partial');
  await post(a, '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'r2', qty: 6 });
  assert.equal(incomingRow(raw).status, 'received');

  const lots = all<{ qty_received: number; unit_cost_iqd: number }>(
    raw, 'SELECT qty_received, unit_cost_iqd FROM inventory_lots ORDER BY received_at, id'
  );
  assert.equal(lots.length, 2);
  assert.equal(lots[0].qty_received, 4);
  assert.equal(lots[1].qty_received, 6);
  // THE FREIGHT IS SPREAD OVER WHAT WAS ORDERED, NOT OVER WHAT ARRIVED TODAY.
  // Charging the whole 400,000 to the first four units would make them cost
  // 500,000 and the next six 400,000 — the same shipment, two truths.
  assert.equal(lots[0].unit_cost_iqd, 450_000);
  assert.equal(lots[1].unit_cost_iqd, 450_000);
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id = 'p1'`)!.stock, 10);

  // And the whole shipment's cost is accounted for to the dinar.
  const total = count(raw, 'SELECT COALESCE(SUM(total_cost_iqd),0) AS n FROM inventory_lots');
  assert.equal(total, 10 * 400_000 + 400_000 + 100_000);
});

test('a NULL counter is never received into: untracked is not zero', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw, { product_id: 'p2' });
  const res = await post(app(raw), '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'r-1', qty: 10 });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'STOCK_NOT_TRACKED');
  // Nothing at all happened — not a lot, not a receipt, not a ledger row.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM incoming_inventory_receipts'), 0);
  assert.equal(row<{ stock: number | null }>(raw, `SELECT stock FROM products WHERE id = 'p2'`)!.stock, null);
});

test('a purchase cannot be filed against a rung the product does not sell from', async () => {
  const raw = freshDb();
  seed(raw);
  // p3 sells by OPTION. A colour purchase would increment a counter nothing reads.
  const bad = await post(app(raw), '/api/admin/inventory/incoming', {
    product_id: 'p3', scope: 'color', scope_id: 'c1', qty_ordered: 5, purchase_unit_iqd: 1000,
  });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'SCOPE_NOT_AUTHORITATIVE');

  const good = await post(app(raw), '/api/admin/inventory/incoming', {
    product_id: 'p3', scope: 'option', scope_id: 'o1', qty_ordered: 5, purchase_unit_iqd: 1000,
    shipping_total_iqd: 0, internal_delivery_total_iqd: 0, status: 'incoming',
  });
  assert.equal(good.status, 200);
  const id = (await json(good)).id as string;

  await post(app(raw), `/api/admin/inventory/incoming/${id}/receive`, { receipt_id: 'r-o', qty: 5 });
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM product_option_values WHERE id = 'o1'`)!.stock, 5);
  // The product's own base counter is untouched: levels are never summed.
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id = 'p3'`)!.stock, 0);
});

test('a blank cost is refused at the door with the missing component named', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw, { shipping_total_iqd: null, internal_delivery_total_iqd: null });
  const res = await post(app(raw), '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'r-1', qty: 10 });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'COST_NOT_STATED');
  assert.deepEqual(body.details?.missing, ['shipping', 'internal_delivery']);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots'), 0);
});

// =====================================================================
//  C. AFTER THE FACT — frozen costs, cancellation
// =====================================================================

test('once a unit is received the costs are frozen, but the paperwork is not', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw, { qty_ordered: 10 });
  const a = app(raw);
  await post(a, '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'r1', qty: 4 });

  const frozen = await patch(a, '/api/admin/inventory/incoming/inc1', { shipping_total_iqd: 0 });
  assert.equal(frozen.status, 400);
  assert.equal((await json(frozen)).code, 'COSTS_FROZEN');
  assert.equal(incomingRow(raw).shipping_total_iqd, 400_000);

  const paperwork = await patch(a, '/api/admin/inventory/incoming/inc1', { tracking: 'TR-77', notes: 'وصلت جزئياً' });
  assert.equal(paperwork.status, 200);
  assert.equal(row<{ tracking: string }>(raw, `SELECT tracking FROM incoming_inventory WHERE id='inc1'`)!.tracking, 'TR-77');

  // And a partly received purchase cannot be cancelled out from under its lots.
  const cancel = await patch(a, '/api/admin/inventory/incoming/inc1', { status: 'cancelled' });
  assert.equal(cancel.status, 400);
  assert.equal((await json(cancel)).code, 'ALREADY_RECEIVED');
});

test('an untouched purchase is still fully editable', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw, { shipping_total_iqd: null, internal_delivery_total_iqd: null, status: 'draft' });
  const res = await patch(app(raw), '/api/admin/inventory/incoming/inc1', {
    shipping_total_iqd: 0, internal_delivery_total_iqd: 0, purchase_unit_iqd: 380_000, status: 'incoming',
  });
  assert.equal(res.status, 200);
  const r = incomingRow(raw);
  assert.equal(r.shipping_total_iqd, 0);
  assert.equal(r.internal_delivery_total_iqd, 0);
  assert.equal(r.purchase_unit_iqd, 380_000);
  assert.equal(r.status, 'incoming');
});

// =====================================================================
//  G. ADJUSTMENTS — a correction is a movement, not an overwrite
// =====================================================================

test('a negative adjustment lowers the shelf, eats the OLDEST lots and records why', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw, { id: 'incA', qty_ordered: 10, purchase_unit_iqd: 400_000, shipping_total_iqd: 400_000, internal_delivery_total_iqd: 100_000 });
  purchase(raw, { id: 'incB', qty_ordered: 10, purchase_unit_iqd: 500_000, shipping_total_iqd: 500_000, internal_delivery_total_iqd: 100_000 });
  const a = app(raw);
  await post(a, '/api/admin/inventory/incoming/incA/receive', { receipt_id: 'rA', qty: 10 });
  await post(a, '/api/admin/inventory/incoming/incB/receive', { receipt_id: 'rB', qty: 10 });
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id='p1'`)!.stock, 20);

  const res = await post(a, '/api/admin/inventory/adjustments', {
    product_id: 'p1', scope: 'base', scope_id: '', delta: -3, reason: 'damaged', note: 'تلف بالنقل',
  });
  assert.equal(res.status, 200);
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id='p1'`)!.stock, 17);

  const lots = all<{ unit_cost_iqd: number; qty_remaining: number }>(
    raw, 'SELECT unit_cost_iqd, qty_remaining FROM inventory_lots ORDER BY received_at, id'
  );
  // The write-off came out of the 450,000 layer, not the 560,000 one.
  assert.equal(lots[0].unit_cost_iqd, 450_000);
  assert.equal(lots[0].qty_remaining, 7);
  assert.equal(lots[1].qty_remaining, 10);

  const led = row<{ kind: string; qty: number; reason: string }>(
    raw, `SELECT kind, qty, reason FROM inventory_ledger WHERE kind = 'adjust_out'`
  )!;
  assert.equal(led.qty, 3);
  assert.equal(led.reason, 'damaged: تلف بالنقل');
});

test('an adjustment needs a reason from the list, and zero is not an adjustment', async () => {
  const raw = freshDb();
  seed(raw);
  const a = app(raw);
  const noReason = await post(a, '/api/admin/inventory/adjustments', { product_id: 'p1', scope: 'base', delta: -1 });
  assert.equal((await json(noReason)).code, 'REASON_REQUIRED');
  const invented = await post(a, '/api/admin/inventory/adjustments', { product_id: 'p1', scope: 'base', delta: -1, reason: 'vibes' });
  assert.equal((await json(invented)).code, 'REASON_REQUIRED');
  const zero = await post(a, '/api/admin/inventory/adjustments', { product_id: 'p1', scope: 'base', delta: 0, reason: 'count' });
  assert.equal((await json(zero)).code, 'ZERO_DELTA');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
});

test('stock is never driven below zero, and the ledger does not claim it was', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw, { qty_ordered: 2, purchase_unit_iqd: 100_000, shipping_total_iqd: 0, internal_delivery_total_iqd: 0 });
  const a = app(raw);
  await post(a, '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'r1', qty: 2 });

  const res = await post(a, '/api/admin/inventory/adjustments', { product_id: 'p1', scope: 'base', delta: -5, reason: 'lost' });
  // §40: refused in words, with the number the admin is arguing with.
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'INSUFFICIENT_STOCK');
  assert.equal(body.details?.on_hand, 2);

  // AND NOTHING PARTLY HAPPENED. The old shape left an `adjust_out` of 5 in the
  // ledger and drained both lots while the counter refused to move — three
  // records of one event that disagreed with each other.
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id='p1'`)!.stock, 2);
  assert.equal(count(raw, `SELECT COALESCE(SUM(qty_remaining),0) AS n FROM inventory_lots`), 2);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind = 'adjust_out'`), 0);

  // What DOES fit still goes through.
  assert.equal((await post(a, '/api/admin/inventory/adjustments', { product_id: 'p1', scope: 'base', delta: -2, reason: 'lost' })).status, 200);
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id='p1'`)!.stock, 0);
  assert.equal(count(raw, `SELECT COALESCE(SUM(qty_remaining),0) AS n FROM inventory_lots`), 0);
});

test('an adjustment is idempotent per operation id, and replays change nothing', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`UPDATE products SET stock = 10 WHERE id = 'p1'`);
  const db = asD1(raw);
  const plan = () => planAdjustmentLedger(db, {
    productId: 'p1', scope: 'base', scopeId: '', delta: -2, reason: 'count', note: '',
    operationId: 'op-1', actorUserId: 'boss',
  });
  await db.batch(plan());
  // The replay must raise rather than quietly take two more units: the ledger
  // row's UNIQUE key is what makes the batch un-repeatable.
  await assert.rejects(db.batch(plan()));
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id='p1'`)!.stock, 8);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 1);
});

test('a positive adjustment puts units back on an existing shelf', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`UPDATE products SET stock = 4 WHERE id = 'p1'`);
  const res = await post(app(raw), '/api/admin/inventory/adjustments', {
    product_id: 'p1', scope: 'base', delta: 3, reason: 'count', note: 'جرد',
  });
  assert.equal(res.status, 200);
  assert.equal(row<{ stock: number }>(raw, `SELECT stock FROM products WHERE id='p1'`)!.stock, 7);
  assert.equal(row<{ kind: string }>(raw, `SELECT kind FROM inventory_ledger`)!.kind, 'adjust_in');
});

test('an untracked level is not quietly turned into a tracked one by an adjustment', async () => {
  const raw = freshDb();
  seed(raw);
  const res = await post(app(raw), '/api/admin/inventory/adjustments', { product_id: 'p2', scope: 'base', delta: 5, reason: 'count' });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'STOCK_NOT_TRACKED');
  assert.equal(row<{ stock: number | null }>(raw, `SELECT stock FROM products WHERE id='p2'`)!.stock, null);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
});

// =====================================================================
//  §11 / §52 — the assistant runs the warehouse and sees no money
// =====================================================================

test('an assistant admin sees the units and none of the costs — stripped server-side', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw);
  await post(app(raw), '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'r1', qty: 10 });

  const owner = await json(await get(app(raw, OWNER), '/api/admin/inventory/overview'));
  assert.equal(owner.on_hand_units, 10);
  assert.equal(owner.inventory_value_iqd, 4_500_000);

  const asst = await json(await get(app(raw, ASSISTANT), '/api/admin/inventory/overview'));
  assert.equal(asst.on_hand_units, 10, 'the assistant still counts units');
  assert.equal('inventory_value_iqd' in asst, false, 'and never sees what they cost');

  const lines = await json(await get(app(raw, ASSISTANT), '/api/admin/inventory/lines'));
  assert.equal(lines.lines[0].on_hand, 10);
  for (const forbidden of ['inventory_value_iqd', 'oldest_unit_cost_iqd', 'newest_unit_cost_iqd']) {
    assert.equal(forbidden in lines.lines[0], false, `${forbidden} reached an assistant`);
  }

  const lots = await json(await get(app(raw, ASSISTANT), '/api/admin/inventory/lots?product_id=p1'));
  assert.equal(lots.lots[0].qty_remaining, 10);
  for (const forbidden of ['unit_cost_iqd', 'total_cost_iqd', 'purchase_unit_iqd', 'shipping_share_iqd', 'internal_share_iqd']) {
    assert.equal(forbidden in lots.lots[0], false, `${forbidden} reached an assistant`);
  }

  // The profit preview has nothing left once the money is removed, so it is
  // refused outright rather than returned as a stripped shell.
  assert.equal((await get(app(raw, ASSISTANT), '/api/admin/inventory/incoming/inc1/profit-preview')).status, 404);
  assert.equal((await get(app(raw, OWNER), '/api/admin/inventory/incoming/inc1/profit-preview')).status, 200);
});

test('the confirmation sheet is computed by the server, and matches the commit exactly', async () => {
  const raw = freshDb();
  seed(raw);
  purchase(raw, { qty_ordered: 7, purchase_unit_iqd: 300_000, shipping_total_iqd: 100_000, internal_delivery_total_iqd: 0 });
  const a = app(raw);

  const preview = await json(await get(a, '/api/admin/inventory/incoming/inc1/receive-preview?qty=7'));
  assert.equal(preview.ok, true);
  const committed = await json(await post(a, '/api/admin/inventory/incoming/inc1/receive', { receipt_id: 'r1', qty: 7 }));
  assert.deepEqual(committed.cost, preview.cost);
  // 100,000 over 7 units is 14,285.71…: the remainder goes to the first units,
  // and the lot's total is the shipment's total to the dinar.
  assert.equal(row<{ total_cost_iqd: number }>(raw, 'SELECT total_cost_iqd FROM inventory_lots')!.total_cost_iqd, 7 * 300_000 + 100_000);
});
