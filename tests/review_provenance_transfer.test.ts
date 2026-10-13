/**
 * REVIEW (provenance, 2c48bf1b): a PARTIAL transfer of a tracked lot moves
 * whichever origins sort first (`planMoveUnitOrigins` → `availableLotOrigins`
 * ORDER BY received_at, unit_index), not the cartons that physically moved.
 * The transfer API has no way to name them, and the existing guard that keeps
 * identified units with their location (SERIAL_TRANSFER: "transfer a
 * serialized lot whole") only looks at stock_serial_links, so it does not
 * cover origins that carry supplier references and internal unit IDs but no
 * serial yet.
 *
 * After this, the system says carton #1 (supplier order SUP-1) is in W2 while
 * the carton labelled #3 (SUP-3) is the one that is there: the next sale from
 * W2 is assigned #1's supplier references, and the physical-label check in
 * InventoryOriginsPanel (typed ID must equal the assigned origin) cannot pass.
 *
 * Expected: either the partial transfer is refused for a tracked lot (like
 * SERIAL_TRANSFER) or it moves exactly the named unit. FAILS on 10c6541a:
 * 200, and t-1 is moved although the request names t-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, json, OWNER } from './fixtures/app';
import { planAtomicAdjustment } from '../worker/lib/inventoryAdjustment';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';

test('a partial transfer of a tracked lot must not guess which identified units moved', async () => {
  const raw = freshDb();
  try {
    raw.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES ('usr_owner','Owner','boss@x.co','h','admin');
      INSERT INTO products(id,name,slug,price_iqd,inventory_mode,stock) VALUES ('prd','Printer','printer',2000,'BASE',3);
      INSERT INTO stock_locations(id,name) VALUES ('w1','Warehouse 1'),('w2','Warehouse 2');
      INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
        VALUES ('lotT','prd','base','',3,3,1000,'received','2026-10-01T09:00:00.000Z');
      INSERT INTO inventory_lot_locations(lot_id,location_id) VALUES ('lotT','w1');
      INSERT INTO inventory_unit_origins(id,incoming_id,purchase_line_id,purchase_id,unit_index,supplier_order_no,tracking_no,received_lot_id,current_lot_id,received_at) VALUES
        ('t-1','inT','plT','poT',1,'SUP-1','TRK-1','lotT','lotT','2026-10-01T09:00:00.000Z'),
        ('t-2','inT','plT','poT',2,'SUP-2','TRK-2','lotT','lotT','2026-10-01T09:00:00.000Z'),
        ('t-3','inT','plT','poT',3,'SUP-3','TRK-3','lotT','lotT','2026-10-01T09:00:00.000Z');`);
    const app = stubApp(asD1(raw), OWNER, (a) => a.route('/s', adminStockOperationsRoutes));
    // Staff carry the carton labelled t-3 to warehouse 2.
    const res = await post(app, '/s/transfers', { operation_id: 'transfer-t3-001', lot_id: 'lotT', location_id: 'w2', qty: 1, unit_origin_ids: ['t-3'] });
    const body = await json(res);
    const moved = (raw.prepare(`SELECT u.id FROM inventory_unit_origins u JOIN inventory_lot_locations l ON l.lot_id=u.current_lot_id
      WHERE l.location_id='w2' ORDER BY u.id`).all() as Array<{ id: string }>).map((r) => r.id);
    if (res.status === 200) assert.deepEqual(moved, ['t-3'], `transfer recorded ${JSON.stringify(moved)} in W2 instead of the carton that moved`);
    else assert.equal(moved.length, 0, JSON.stringify(body));
  } finally {
    raw.close();
  }
});

/* Fix (review 2026-10-13, PROV-3): a part of a tracked lot names its pieces.
 * Without names nothing moves; the lot's pieces are listed for the screen; a
 * lot count names the missing ones; a product-level write-off is sent to the
 * lot count instead of guessing. */

function trackedLot() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES ('usr_owner','Owner','boss@x.co','h','admin');
    INSERT INTO products(id,name,slug,price_iqd,inventory_mode,stock) VALUES ('prd','Printer','printer',2000,'BASE',4);
    INSERT INTO stock_locations(id,name) VALUES ('w1','Warehouse 1'),('w2','Warehouse 2');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES ('lotT','prd','base','',4,4,1000,'received','2026-10-01T09:00:00.000Z');
    INSERT INTO inventory_lot_locations(lot_id,location_id) VALUES ('lotT','w1');
    INSERT INTO inventory_unit_origins(id,incoming_id,purchase_line_id,purchase_id,unit_index,supplier_order_no,tracking_no,received_lot_id,current_lot_id,received_at) VALUES
      ('t-1','inT','plT','poT',1,'SUP-1','TRK-1','lotT','lotT','2026-10-01T09:00:00.000Z'),
      ('t-2','inT','plT','poT',2,'SUP-2','TRK-2','lotT','lotT','2026-10-01T09:00:00.000Z'),
      ('t-3','inT','plT','poT',3,'SUP-3','TRK-3','lotT','lotT','2026-10-01T09:00:00.000Z');`);
  return { raw, app: stubApp(asD1(raw), OWNER, (a) => a.route('/s', adminStockOperationsRoutes)) };
}

test('an unnamed partial transfer of a tracked lot is refused and moves nothing; the lot lists its pieces', async () => {
  const { raw, app } = trackedLot();
  try {
    const units = await json(await get(app, '/s/lots/lotT/units'));
    assert.deepEqual({ ids: units.units.map((u: { id: string }) => u.id), unidentified: units.unidentified }, { ids: ['t-1', 't-2', 't-3'], unidentified: 1 });
    assert.ok(!JSON.stringify(units).includes('1000'), 'no cost in the piece list');
    const res = await post(app, '/s/transfers', { operation_id: 'transfer-unnamed-01', lot_id: 'lotT', location_id: 'w2', qty: 1 });
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'UNIT_ORIGIN_SELECTION_REQUIRED');
    assert.equal((raw.prepare("SELECT COUNT(*) n FROM inventory_lots").get() as { n: number }).n, 1);
    // The one unidentified unit may move alone when the list says so.
    const legacy = await post(app, '/s/transfers', { operation_id: 'transfer-legacy-01', lot_id: 'lotT', location_id: 'w2', qty: 1, unit_origin_ids: [] });
    assert.equal(legacy.status, 200, JSON.stringify(await json(legacy)));
    assert.deepEqual(raw.prepare("SELECT id FROM inventory_unit_origins WHERE current_lot_id='lotT' ORDER BY id").all().map((r) => (r as { id: string }).id), ['t-1', 't-2', 't-3']);
  } finally { raw.close(); }
});

test('a lot count names the missing pieces; a product-level write-off of part of a tracked lot is sent to the lot count', async () => {
  const { raw, app } = trackedLot();
  try {
    const unnamed = await post(app, '/s/lot-counts', { operation_id: 'count-unnamed-01', lot_id: 'lotT', counted_qty: 3 });
    assert.equal(unnamed.status, 409);
    const named = await post(app, '/s/lot-counts', { operation_id: 'count-named-001', lot_id: 'lotT', counted_qty: 3, unit_origin_ids: ['t-2'] });
    assert.equal(named.status, 200, JSON.stringify(await json(named)));
    assert.deepEqual(raw.prepare("SELECT id,unavailable_reason FROM inventory_unit_origins ORDER BY id").all().map((r) => ({ ...r })),
      [{ id: 't-1', unavailable_reason: null }, { id: 't-2', unavailable_reason: 'lot_count' }, { id: 't-3', unavailable_reason: null }]);
    await assert.rejects(planAtomicAdjustment(asD1(raw), { productId: 'prd', scope: 'base', scopeId: '', delta: -1, reason: 'damaged', note: '', operationId: 'adj-1', actorUserId: 'usr_owner' }),
      { code: 'UNIT_ORIGIN_LOT_COUNT_REQUIRED' });
  } finally { raw.close(); }
});
