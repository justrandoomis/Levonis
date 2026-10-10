/**
 * A RECEIVED PURCHASE'S COST IS FROZEN IN THE DATABASE — AND EVERY LIVE PATH
 * STILL WORKS (FX programme plan §4.3 "Locks"; master plan v2 0180 M3,
 * critique F8; migration 0182).
 *
 * The code already refused a cost edit after a receipt (PUT
 * /procurement/documents/:id → PURCHASE_FROZEN, PATCH /inventory/incoming/:id
 * → COSTS_FROZEN). 0182 adds the database's half: value-compared triggers on
 * the cost columns of incoming_inventory, purchase_lines, purchase_orders and
 * purchase_charges, no DELETE of a received row, and no re-INSERT of one under
 * its own id (INSERT OR REPLACE fires no UPDATE or DELETE trigger). Each
 * statement live code runs after a receipt is replayed here and still
 * succeeds: a second receipt, a rejected quantity, a supplier payment,
 * closing the remainder, paperwork on a bare incoming record, a product
 * deletion's pointer clearing, FIFO consumption — and a draft's re-save.
 *
 * Run: node --import tsx --test tests/receivedPurchaseFreezeLivePaths.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, freshDb, get, json, patch, post, put, row, stubApp } from './fixtures/app';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { baghdadDay } from '../worker/lib/operations';

const OWNER = { id: 'admin', email: 'boss@x.co', role: 'admin' as const };

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('admin','boss@x.co','admin');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode)
      VALUES ('part','Part','freeze-part','FRZ',30000,10000,0,'BASE');`);
  const app = stubApp(asD1(raw), OWNER, (a) => {
    a.route('/p', adminProcurementRoutes);
    a.route('/i', adminInventoryRoutes);
  });
  return { raw, app };
}

const body = (over: Record<string, unknown> = {}) => ({
  operation_id: crypto.randomUUID(),
  supplier_id: 'supplier',
  currency: 'IQD',
  purchase_day: baghdadDay(),
  status: 'ordered',
  cost_state: 'final',
  lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 4, source_unit_amount: 10000 }],
  charges: [{ title: 'شحن', amount_iqd: 400, basis: 'quantity' }],
  ...over,
});

async function ok(res: Response, what: string) {
  assert.equal(res.status, 200, `${what}: ${JSON.stringify(await json(res.clone()))}`);
  return json(res);
}

const refused = (raw: DatabaseSync, sql: string) => assert.throws(() => raw.exec(sql), /PURCHASE_FROZEN/, sql);

test('every live path after a receipt still works under the freeze', async () => {
  const { raw, app } = setup();
  const { id } = await ok(await post(app, '/p/documents', body()), 'create');
  let detail = await json(await get(app, `/p/documents/${id}`));
  const line = detail.lines[0].line_id as string;
  // 1. a partial receipt, then 2. a rejected quantity and 3. a second receipt
  await ok(await post(app, `/p/documents/${id}/receive`, { operation_id: crypto.randomUUID(), lines: [{ line_id: line, qty: 1 }] }), 'first receipt');
  await ok(await post(app, `/p/documents/${id}/receive`, { operation_id: crypto.randomUUID(), lines: [{ line_id: line, qty: 0, rejected_qty: 1 }] }), 'reject');
  await ok(await post(app, `/p/documents/${id}/receive`, { operation_id: crypto.randomUUID(), lines: [{ line_id: line, qty: 1 }] }), 'second receipt');
  // 4. a supplier payment (version bump on the received purchase)
  detail = await json(await get(app, `/p/documents/${id}`));
  await ok(await post(app, `/p/documents/${id}/payments`, { operation_id: crypto.randomUUID(), amount_iqd: 1000, payment_day: baghdadDay() }), 'payment');
  // 5. closing the remainder (status of incoming and purchase, the note)
  await ok(await post(app, `/p/documents/${id}/close`, { reason: 'supplier short' }), 'close remainder');
  detail = await json(await get(app, `/p/documents/${id}`));
  assert.equal(detail.purchase.status, 'received');
  assert.equal(count(raw, "SELECT stock n FROM products WHERE id='part'"), 2);
  // 6. the route still answers a cost edit with its own refusal, before the database is asked
  const edit = await put(app, `/p/documents/${id}`, { ...body(), version: detail.purchase.version });
  assert.equal(edit.status, 409);
  assert.equal((await json(edit)).code, 'PURCHASE_FROZEN');
  // 7. a product deletion clears the pointers; FIFO consumption moves qty_remaining
  const incoming = detail.lines[0].id as string;
  raw.exec(`UPDATE inventory_lots SET qty_remaining = qty_remaining - 1 WHERE incoming_id = '${incoming}' AND qty_remaining > 0`);
  raw.exec(`UPDATE incoming_inventory SET product_id = NULL WHERE id = '${incoming}'`);
  raw.exec(`UPDATE inventory_lots SET product_id = NULL WHERE incoming_id = '${incoming}'`);
  // 8. the paperwork of a received purchase stays editable
  raw.exec(`UPDATE incoming_inventory SET notes = 'box 3', tracking = 'TRK', updated_at = '2026-10-10T00:00:00.000Z' WHERE id = '${incoming}'`);
  raw.exec(`UPDATE purchase_orders SET note = note || ' checked', tracking = 'TRK', attachment_url = '' WHERE id = '${id}'`);
  raw.exec(`UPDATE purchase_lines SET label = 'Part (renamed)', selling_price_iqd = 31000 WHERE purchase_id = '${id}'`);
  raw.exec(`UPDATE purchase_charges SET title = 'شحن جوي' WHERE purchase_id = '${id}'`);
});

test('the database refuses a received purchase\'s cost change, its deletion and its re-insertion', async () => {
  const { raw, app } = setup();
  const { id } = await ok(await post(app, '/p/documents', body()), 'create');
  const detail = await json(await get(app, `/p/documents/${id}`));
  const line = detail.lines[0].line_id as string;
  const incoming = detail.lines[0].id as string;
  await ok(await post(app, `/p/documents/${id}/receive`, { operation_id: crypto.randomUUID(), lines: [{ line_id: line, qty: 1 }] }), 'receipt');
  for (const sql of [
    `UPDATE incoming_inventory SET purchase_unit_iqd = 1 WHERE id = '${incoming}'`,
    `UPDATE incoming_inventory SET shipping_total_iqd = 0 WHERE id = '${incoming}'`,
    `UPDATE incoming_inventory SET qty_ordered = 9 WHERE id = '${incoming}'`,
    `UPDATE incoming_inventory SET source_currency = 'USD' WHERE id = '${incoming}'`,
    `DELETE FROM incoming_inventory WHERE id = '${incoming}'`,
    `UPDATE purchase_lines SET source_unit_amount = 1 WHERE id = '${line}'`,
    `UPDATE purchase_lines SET charges_iqd = 0 WHERE id = '${line}'`,
    `DELETE FROM purchase_lines WHERE id = '${line}'`,
    `UPDATE purchase_orders SET exchange_rate = 2 WHERE id = '${id}'`,
    `UPDATE purchase_orders SET currency = 'USD' WHERE id = '${id}'`,
    `UPDATE purchase_orders SET cost_state = 'estimated' WHERE id = '${id}'`,
    `UPDATE purchase_charges SET amount_iqd = 1 WHERE purchase_id = '${id}'`,
    `DELETE FROM purchase_charges WHERE purchase_id = '${id}'`,
    `INSERT OR REPLACE INTO purchase_orders SELECT * FROM purchase_orders WHERE id = '${id}'`,
    `INSERT OR REPLACE INTO purchase_lines SELECT * FROM purchase_lines WHERE id = '${line}'`,
    `INSERT OR REPLACE INTO purchase_charges SELECT * FROM purchase_charges WHERE purchase_id = '${id}'`,
    `INSERT OR REPLACE INTO incoming_inventory SELECT * FROM incoming_inventory WHERE id = '${incoming}'`,
  ]) refused(raw, sql);
  // Writing the SAME value is no change: value-compared, never "any UPDATE OF".
  raw.exec(`UPDATE incoming_inventory SET purchase_unit_iqd = purchase_unit_iqd WHERE id = '${incoming}'`);
  assert.equal(row(raw, 'SELECT purchase_unit_iqd n FROM incoming_inventory WHERE id = ?', incoming)!.n, 10000);
});

test('before any receipt nothing is frozen: a draft and an ordered purchase re-save, lines and charges replaced', async () => {
  const { raw, app } = setup();
  const draft = body({ status: 'draft' });
  const { id } = await ok(await post(app, '/p/documents', draft), 'create draft');
  let detail = await json(await get(app, `/p/documents/${id}`));
  await ok(await put(app, `/p/documents/${id}`, { ...draft, charges: [{ title: 'شحن', amount_iqd: 800, basis: 'quantity' }], version: detail.purchase.version }), 'draft re-save');
  detail = await json(await get(app, `/p/documents/${id}`));
  await ok(await put(app, `/p/documents/${id}`, { ...draft, status: 'ordered', version: detail.purchase.version }), 'confirm');
  detail = await json(await get(app, `/p/documents/${id}`));
  await ok(await put(app, `/p/documents/${id}`, { ...draft, status: 'ordered', note: 'edited', version: detail.purchase.version }), 'ordered re-save');
  assert.equal(count(raw, `SELECT COUNT(*) n FROM purchase_charges WHERE purchase_id = '${id}'`), 1);
  // …and the FX snapshot taken at the first confirmation survives every later save.
  assert.ok(row(raw, 'SELECT fx_snapshot_at at FROM purchase_orders WHERE id = ?', id)!.at);
});

test('a bare incoming record: paperwork after a receipt saves; a cost edit is refused by the route, then the database', async () => {
  const { raw, app } = setup();
  raw.exec(`INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,status)
    VALUES ('inc1','part','base','',3,10000,0,0,'incoming')`);
  await ok(await post(app, '/i/incoming/inc1/receive', { receipt_id: 'r-1', qty: 1 }), 'receipt');
  await ok(await patch(app, '/i/incoming/inc1', { notes: 'arrived damaged box', tracking: 'T-1' }), 'paperwork');
  const costEdit = await patch(app, '/i/incoming/inc1', { purchase_unit_iqd: 1 });
  assert.equal(costEdit.status, 400);
  assert.equal((await json(costEdit)).code, 'COSTS_FROZEN');
  refused(raw, "UPDATE incoming_inventory SET purchase_unit_iqd = 1 WHERE id = 'inc1'");
  await ok(await post(app, '/i/incoming/inc1/receive', { receipt_id: 'r-2', qty: 2 }), 'the rest');
});
