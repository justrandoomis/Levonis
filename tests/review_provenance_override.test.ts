/**
 * REVIEW (provenance, 2c48bf1b): the owner's audited «batch» exception (0178
 * L11, tests/serialPrepScan.test.ts §32.17) no longer works on any slot that
 * carries a supplier origin, or for any serial enrolled on a purchase origin.
 *
 * `classifyLink` (worker/lib/serialAssignments.ts ~985-999 and ~1187) throws
 * SERIAL_BATCH_MISMATCH reason 'inventory_origin' BEFORE the override kind is
 * consulted, while the pre-existing lot check (~1203) still says
 * `if (ov !== 'batch') throw`. Result: when the planned carton is damaged or
 * missing, nobody — the owner included — can prepare that slot with the
 * physical device actually on hand, and an enrolled serial can never be
 * corrected (inventory_origin_identity_immutable + INVENTORY_ORIGIN_SERIAL_LOCKED).
 *
 * The control reproduces §32.17 on untracked lots: the owner override is 200.
 * The tracked case FAILS on 10c6541a with 400 SERIAL_BATCH_MISMATCH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, json } from './fixtures/app';
import { seed, order, USERS } from './fixtures/serialPrep';
import { planLotConsumption } from '../worker/lib/inventoryLots';
import type { StockMove } from '../worker/lib/inventory';
import { adminOrderSerialRoutes } from '../worker/routes/adminOrderSerials';

const ON_HAND = '03919D580609999';

async function world(tracked: boolean) {
  const raw = freshDb(); seed(raw);
  order(raw, 'ORD-OV', [{ id: 'ov-item', product: 'pA1', qty: 1 }]);
  raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES
    ('lotA','pA1','base','',2,2,100,'received','2026-10-01T00:00:00Z'),
    ('lotB','pA1','base','',1,1,100,'received','2026-10-02T00:00:00Z');
    INSERT INTO serial_inventory(serial_norm,serial_raw,product_id,created_by) VALUES ('${ON_HAND}','${ON_HAND}','pA1','boss');
    INSERT INTO stock_serial_links(serial_norm,lot_id,linked_by,linked_at) VALUES ('${ON_HAND}','lotB','boss','2026-10-02T00:00:00Z');`);
  if (tracked) {
    raw.exec(`INSERT INTO inventory_unit_origins(id,incoming_id,purchase_line_id,purchase_id,unit_index,supplier_order_no,tracking_no,received_lot_id,current_lot_id,received_at) VALUES
      ('a-1','inA','plA','poA',1,'SUP-A','','lotA','lotA','2026-10-01T00:00:00Z'),
      ('a-2','inA','plA','poA',2,'SUP-A','','lotA','lotA','2026-10-01T00:00:00Z'),
      ('b-1','inB','plB','poB',1,'SUP-B','','lotB','lotB','2026-10-02T00:00:00Z');
      UPDATE inventory_unit_origins SET serial_norm='${ON_HAND}' WHERE id='b-1';`);
  }
  const db = asD1(raw);
  const move: StockMove = { product_id: 'pA1', line_id: 'ov-item', qty: 1, targets: [{ scope: 'base', scope_id: '', stock: 1, reserved: 1, low_stock_threshold: null, label: 'A1' }] };
  await db.batch((await planLotConsumption(db, 'ORD-OV', [move])).statements);
  const as = (who: keyof typeof USERS) => stubApp(db, USERS[who], (app) => app.route('/api/admin/orders', adminOrderSerialRoutes));
  return { raw, db, as };
}

async function ownerBatchOverride(tracked: boolean, inspect?: (raw: ReturnType<typeof freshDb>) => void) {
  const w = await world(tracked);
  try {
    // Staff scan the box actually on hand (from lot B): refused, as designed.
    const staff = await post(w.as('adm'), '/api/admin/orders/ORD-OV/serials/scan', { order_item_id: 'ov-item', unit_index: 1, code: ON_HAND, source: 'manual', op_id: 'ov-scan-1' });
    assert.equal(staff.status, 400);
    // The owner records the audited exception (L11).
    const res = await post(w.as('boss'), '/api/admin/orders/ORD-OV/serials/override', {
      order_item_id: 'ov-item', unit_index: 1, code: ON_HAND, kind: 'batch', reason: 'planned carton damaged, shipping the box on hand', op_id: 'ov-owner-1',
    });
    const out = { status: res.status, body: await json(res) };
    inspect?.(w.raw);
    return out;
  } finally {
    w.raw.close();
  }
}

test('control: untracked lots — the owner batch override is accepted (0178 L11)', async () => {
  const r = await ownerBatchOverride(false);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('tracked lots — the owner batch override must still be accepted', async () => {
  const r = await ownerBatchOverride(true);
  // FAILS on 10c6541a: 400 SERIAL_BATCH_MISMATCH { reason: 'inventory_origin' }.
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

/* Fix (review 2026-10-13, PROV-2): the exception re-pins the slot. The
 * planned piece goes back to stock and the shipped piece leaves it, in the
 * same batch, audited; the cost allocation stays as L11 records it. */
test('tracked lots — the owner batch override re-pins the slot to the shipped piece', async () => {
  let facts: Record<string, unknown> = {};
  const r = await ownerBatchOverride(true, (raw) => {
    const rows = raw.prepare(`SELECT origin_id, released_at IS NOT NULL AS released, release_reason, lot_id FROM order_item_inventory_unit_assignments
      WHERE order_item_id='ov-item' ORDER BY assigned_at, id`).all().map((row) => ({ ...row }));
    const serial = { ...(raw.prepare("SELECT lot_id, lot_source, allocation_id, override_kind FROM serial_assignments WHERE order_item_id='ov-item' AND released_at IS NULL").get() as object) };
    const audit = raw.prepare("SELECT detail FROM audit_log WHERE action='serial.override'").get() as { detail: string } | undefined;
    facts = { rows, serial, repin: audit ? JSON.parse(audit.detail).origin_repin : null };
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(facts.rows, [
    { origin_id: 'a-1', released: 1, release_reason: 'batch_override', lot_id: 'lotA' },
    { origin_id: 'b-1', released: 0, release_reason: null, lot_id: 'lotB' },
  ]);
  assert.deepEqual(facts.serial, { lot_id: 'lotB', lot_source: 'serial_link', allocation_id: null, override_kind: 'batch' });
  assert.deepEqual(facts.repin, { released_assignment: (facts.repin as { released_assignment: string }).released_assignment, from_origin: 'a-1', to_origin: 'b-1' });
});
