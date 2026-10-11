import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, json, all, row, failingD1 } from './fixtures/app';
import { seed, order, USERS } from './fixtures/serialPrep';
import { planLotConsumption } from '../worker/lib/inventoryLots';
import type { StockMove } from '../worker/lib/inventory';
import { adminOrderSerialRoutes } from '../worker/routes/adminOrderSerials';
import { adminOrderInventoryOriginRoutes } from '../worker/routes/adminOrderInventoryOrigins';

async function setup(lots: Array<{ id: string; qty: number; tracked: boolean }>) {
  const raw = freshDb(); seed(raw);
  const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
  order(raw, 'ORD-PICK', [{ id: 'pick-item', product: 'pA1', qty }]);
  for (const [index, lot] of lots.entries()) {
    const date = `2026-10-0${index + 1}T00:00:00Z`;
    raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES (?,'pA1','base','',?,?,100,'received',?)`).run(lot.id, lot.qty, lot.qty, date);
    if (lot.tracked) for (let n = 1; n <= lot.qty; n++) {
      raw.prepare(`INSERT INTO inventory_unit_origins(id,incoming_id,purchase_line_id,purchase_id,unit_index,supplier_order_no,tracking_no,received_lot_id,current_lot_id,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`${lot.id}-unit-${n}`, `${lot.id}-in`, `${lot.id}-line`, `${lot.id}-purchase`, n, `SUP-${lot.id}-${n}`, `TRACK-${lot.id}-${n}`, lot.id, lot.id, date);
    }
  }
  const db = asD1(raw);
  const move: StockMove = { product_id: 'pA1', line_id: 'pick-item', qty, targets: [{ scope: 'base', scope_id: '', stock: qty, reserved: qty, low_stock_threshold: null, label: 'A1 Combo' }] };
  await db.batch((await planLotConsumption(db, 'ORD-PICK', [move])).statements);
  const as = (override: D1Database = db) => stubApp(override, USERS.ast, (app) => {
    app.route('/api/admin/orders', adminOrderSerialRoutes);
    app.route('/api/admin/orders', adminOrderInventoryOriginRoutes);
  });
  const scan = (slot: number, code = `03919D5806088${String(slot).padStart(2, '0')}`, override?: D1Database) =>
    post(as(override), '/api/admin/orders/ORD-PICK/serials/scan', { order_item_id: 'pick-item', unit_index: slot, code, source: 'manual', op_id: `pick-scan-${slot}-${code}` });
  return { raw, db, as, scan };
}

test('2 + 3 + 5 FIFO origins retain exact slot lots when serials are scanned in reverse order, then physically confirmed', async () => {
  const w = await setup([{ id: 'z-old', qty: 2, tracked: true }, { id: 'm-middle', qty: 3, tracked: true }, { id: 'a-new', qty: 5, tracked: true }]);
  for (const slot of [10, 6, 5, 2, 1, 3, 4, 7, 8, 9]) {
    const response = await w.scan(slot), body = await json(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    const origin = row<{id:string;origin_id:string;lot_id:string}>(w.raw, 'SELECT id,origin_id,lot_id FROM order_item_inventory_unit_assignments WHERE order_item_id=? AND unit_index=?', 'pick-item', slot)!;
    const serial = row<{id:string;lot_id:string}>(w.raw, 'SELECT id,lot_id FROM serial_assignments WHERE order_item_id=? AND unit_index=? AND released_at IS NULL', 'pick-item', slot)!;
    assert.equal(origin.lot_id, slot <= 2 ? 'z-old' : slot <= 5 ? 'm-middle' : 'a-new');
    assert.equal(serial.lot_id, origin.lot_id, `slot ${slot} follows its own FIFO source`);
    const confirmed = await post(w.as(), `/api/admin/orders/ORD-PICK/inventory-origins/${origin.id}/confirm`, { inventory_unit_id: origin.origin_id, serial_assignment_id: serial.id });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
  }
  assert.equal(row(w.raw, 'SELECT COUNT(*) AS n FROM order_item_inventory_unit_assignments WHERE physical_verified_at IS NOT NULL')?.n, 10);
  assert.deepEqual(all(w.raw, 'SELECT qty_remaining FROM inventory_lots ORDER BY id'), [{ qty_remaining: 0 }, { qty_remaining: 0 }, { qty_remaining: 0 }]);
});

test('a legacy gap scanned first cannot steal a later identified unit’s lot capacity', async () => {
  const w = await setup([{ id: 'z-legacy', qty: 1, tracked: false }, { id: 'a-tracked', qty: 2, tracked: true }]);
  w.raw.exec("UPDATE inventory_unit_origins SET serial_norm='03919D580608802' WHERE id='a-tracked-unit-1'");
  assert.equal((await w.scan(1, '03919D580608802')).status, 400, 'legacy slot cannot take a serial already tied to a different physical source');
  for (const slot of [1, 3, 2]) {
    const response = await w.scan(slot);
    assert.equal(response.status, 200, await response.clone().text());
  }
  assert.deepEqual(all(w.raw, 'SELECT unit_index,lot_id FROM serial_assignments ORDER BY unit_index'), [
    { unit_index: 1, lot_id: 'z-legacy' }, { unit_index: 2, lot_id: 'a-tracked' }, { unit_index: 3, lot_id: 'a-tracked' },
  ]);
});

test('a known physical serial or a concurrent source release cannot be bypassed by scanning another device', async () => {
  const w = await setup([{ id: 'only-lot', qty: 2, tracked: true }]);
  w.raw.exec("UPDATE inventory_unit_origins SET serial_norm='03919D580609999' WHERE id='only-lot-unit-1'");
  let response = await w.scan(1);
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await json(response)).code, 'SERIAL_BATCH_MISMATCH');
  response = await w.scan(2, '03919D580609999');
  assert.equal(response.status, 400, 'a serial known to another physical origin cannot be scanned into this one');
  const race = failingD1(w.raw);
  race.failing.beforeBatch = () => { race.failing.beforeBatch = null; w.raw.exec("UPDATE order_item_inventory_unit_assignments SET released_at='2026-10-11',release_reason='return:test' WHERE unit_index=2"); };
  response = await w.scan(2, undefined, race.db);
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(row(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments')?.n, 0);
});
