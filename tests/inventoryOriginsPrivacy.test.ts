import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, get, post, json, row, dbThrough, failingD1, type StubUser } from './fixtures/app';
import { seed, order, USERS, SN } from './fixtures/serialPrep';
import { adminOrderInventoryOriginRoutes } from '../worker/routes/adminOrderInventoryOrigins';
import { orderRoutes, orderPublic } from '../worker/routes/orders';
import { invoiceRoutes } from '../worker/routes/invoices';
import { stripInventoryProvenance } from '../worker/lib/inventoryProvenancePrivacy';

const privateOrder = 'SUPPLIER-PRIVATE-78319';
const privateTracking = 'TRACK-PRIVATE-2219';
function world() {
  const raw = freshDb(); seed(raw);
  order(raw, 'ORD-ORIGIN', [{ id: 'oi-origin', product: 'pA1', qty: 2 }]);
  raw.exec(`
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES ('lot-origin','pA1','base','',2,0,777888,'received','2026-10-01T00:00:00Z');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES ('alloc-origin','ORD-ORIGIN','oi-origin','lot-origin','base','',2,777888,1555776,'alloc-origin');
    INSERT INTO inventory_unit_origins(id,incoming_id,purchase_line_id,purchase_id,unit_index,supplier_order_no,tracking_no,received_lot_id,current_lot_id,received_at)
      VALUES ('unit-origin','incoming-origin','line-origin','purchase-origin',1,'${privateOrder}','${privateTracking}','lot-origin','lot-origin','2026-10-01T00:00:00Z');
    INSERT INTO order_item_inventory_unit_assignments(id,origin_id,allocation_id,order_id,order_ref,order_item_id,order_item_ref,unit_index,lot_id,purchase_id,purchase_line_id,incoming_id,purchase_unit_index,purchase_name,supplier_order_no,tracking_no)
      VALUES ('assign-origin','unit-origin','alloc-origin','ORD-ORIGIN','ORD-ORIGIN','oi-origin','oi-origin',1,'lot-origin','purchase-origin','line-origin','incoming-origin',1,'October purchase','${privateOrder}','');
    INSERT INTO serial_inventory(serial_norm,serial_raw,product_id,created_by) VALUES ('${SN}','${SN}','pA1','boss');
    INSERT INTO serial_assignments(id,serial_norm,serial_raw,order_id,order_item_id,order_ref,unit_index,product_id,lot_id,lot_source,allocation_id,source,idempotency_key,linked_by)
      VALUES ('serial-origin','${SN}','${SN}','ORD-ORIGIN','oi-origin','ORD-ORIGIN',1,'pA1','lot-origin','allocation','alloc-origin','manual','serial-origin','ast');
    INSERT INTO invoices(id,invoice_no,order_id,revision,snapshot,amount_paid_iqd,amount_due_iqd,payment_status,issued_at)
      VALUES ('invoice-origin','INV-ORIGIN','ORD-ORIGIN',1,'{"version":1,"inventory_origin":{"supplier_order_no":"${privateOrder}","tracking_no":"${privateTracking}"},"lines":[]}',0,0,'paid','2026-10-11T00:00:00Z');
  `);
  const db = asD1(raw);
  const as = (user: StubUser | null, override: D1Database = db, host?: string) => stubApp(override, user, (app) => {
    app.route('/api/admin/orders', adminOrderInventoryOriginRoutes);
    app.route('/api/orders', orderRoutes);
    app.route('/api/invoices', invoiceRoutes);
  }, { host });
  return { raw, db, as };
}
const path = '/api/admin/orders/ORD-ORIGIN/inventory-origins';
const confirmPath = `${path}/assign-origin/confirm`;
const confirmation = { inventory_unit_id: 'unit-origin', serial_assignment_id: 'serial-origin' };

test('supplier origin is available to owner/full/assistant admins without any cost fields; later tracking is visible beside the original snapshot', async () => {
  const w = world();
  for (const user of [USERS.boss, USERS.adm, USERS.ast]) {
    const response = await get(w.as(user), path), body = await json(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(body.units[0].supplier_order_no, privateOrder);
    assert.equal(body.units[0].tracking_no, '');
    assert.equal(body.units[0].current_tracking_no, privateTracking);
    assert.equal(body.units[0].physical_match, false);
    assert.equal(body.units[0].can_confirm, true);
    assert.deepEqual(body.untracked, [{ order_item_id: 'oi-origin', product_name: 'pA1', lot_id: 'lot-origin', qty: 1 }]);
    assert.doesNotMatch(JSON.stringify(body), /777888|1555776|unit_cost_iqd|cogs_iqd|exchange_rate|profit/i);
  }
});

test('visitors/customers/merchants and merchant hosts cannot read or confirm provenance', async () => {
  const w = world();
  for (const user of [null, USERS.u1, { id: 'merchant', role: 'merchant' as const, email: 'merchant@x.co' }]) {
    for (const response of [await get(w.as(user), path), await post(w.as(user), confirmPath, confirmation)]) {
      assert.ok([401, 403].includes(response.status));
      assert.doesNotMatch(await response.text(), new RegExp(`${privateOrder}|${privateTracking}`));
    }
  }
  assert.equal((await get(w.as(USERS.boss, w.db, 'someone.levonis-iq.com'), path)).status, 404);
  assert.equal((await get(w.as(USERS.ast), '/api/admin/orders/missing/inventory-origins')).status, 404);
});

test('customer order and unit responses and invoice snapshots cannot include private provenance, including imported nested fields', async () => {
  const w = world();
  w.raw.prepare('UPDATE order_items SET pricing_snapshot=?,warranty_snapshot=?,transport_snapshot=? WHERE id=?')
    .run(JSON.stringify({ applied_iqd: 100, inventory_origin: { tracking_no: privateTracking }, unit_origins: [{ tracking_no: privateTracking }], unitOriginIds: ['unit-origin'], preorder_origins: [{ tracking_no: privateTracking }], preorderUnitOrigins: [{ purchase_ref: privateOrder }] }), JSON.stringify({ supplier_order_no: privateOrder }), JSON.stringify({ purchaseId: 'purchase-origin' }), 'oi-origin');
  for (const url of ['/api/orders/ORD-ORIGIN', '/api/orders/ORD-ORIGIN/units', '/api/invoices/invoice-origin']) {
    const response = await get(w.as(USERS.u1), url), body = await response.text();
    assert.equal(response.status, 200, body);
    assert.doesNotMatch(body, new RegExp(`${privateOrder}|${privateTracking}|purchase-origin|unit-origin`));
  }
  const projected = orderPublic({ id: 'o', shipping_type: 'direct', delivery_tracking_no: 'CUSTOMER-COURIER-77' }, []);
  assert.equal(projected.tracking_no, 'CUSTOMER-COURIER-77', 'customer delivery tracking remains visible');
  assert.deepEqual(stripInventoryProvenance({ supplierOrderNo: privateOrder, nested: [{ inventoryOrigin: { tracking_no: privateTracking }, price: 5 }], tracking_no: 'courier' }), { nested: [{ price: 5 }], tracking_no: 'courier' });
});

test('assistant can explicitly verify matching box/serial; retries are idempotent and do not move stock, prices or costs', async () => {
  const w = world();
  const before = row(w.raw, 'SELECT * FROM inventory_lots WHERE id=?', 'lot-origin');
  let response = await post(w.as(USERS.ast), confirmPath, confirmation);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(row(w.raw, 'SELECT serial_norm FROM inventory_unit_origins WHERE id=?', 'unit-origin')?.serial_norm, SN);
  response = await post(w.as(USERS.ast), confirmPath, confirmation);
  assert.equal((await json(response)).already, true);
  assert.equal(row(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action='inventory.origin_verified'")?.n, 1);
  const detail = await json(await get(w.as(USERS.ast), path));
  assert.equal(detail.units[0].physical_match, true);
  assert.deepEqual(row(w.raw, 'SELECT * FROM inventory_lots WHERE id=?', 'lot-origin'), before);
  // A changed or unlinked serial cannot leave a green "verified" badge.
  w.raw.exec("UPDATE serial_assignments SET released_at='2026-10-11T10:00:00Z',release_reason='unlinked' WHERE id='serial-origin'");
  assert.equal((await json(await get(w.as(USERS.ast), path))).units[0].physical_match, false);
});

test('wrong internal unit, wrong serial lot, revoked receiving capability and a concurrent cancellation fail closed', async () => {
  const w = world();
  assert.equal((await post(w.as(USERS.ast), confirmPath, { ...confirmation, inventory_unit_id: 'another-unit' })).status, 409);
  w.raw.exec("UPDATE serial_assignments SET lot_id=NULL WHERE id='serial-origin'");
  assert.equal((await post(w.as(USERS.ast), confirmPath, confirmation)).status, 409);
  w.raw.exec("UPDATE serial_assignments SET lot_id='lot-origin' WHERE id='serial-origin'; INSERT INTO ops_permissions(user_id,capability,allowed) VALUES ('ast','receive',0)");
  assert.equal((await post(w.as(USERS.ast), confirmPath, confirmation)).status, 403);
  const race = failingD1(w.raw);
  race.failing.beforeBatch = () => { race.failing.beforeBatch = null; w.raw.exec("UPDATE orders SET status='cancelled' WHERE id='ORD-ORIGIN'"); };
  const response = await post(w.as(USERS.boss, race.db), confirmPath, confirmation);
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(row(w.raw, 'SELECT serial_norm FROM inventory_unit_origins WHERE id=?', 'unit-origin')?.serial_norm, null);
  assert.equal(row(w.raw, 'SELECT physical_verified_at FROM order_item_inventory_unit_assignments WHERE id=?', 'assign-origin')?.physical_verified_at, null);
});

test('deploy-ahead read distinguishes unavailable provenance from an empty allocation', async () => {
  const raw = dbThrough('0186'); seed(raw); order(raw, 'ORD-OLD', [{ id: 'old-item', product: 'pA1' }]);
  const app = stubApp(asD1(raw), USERS.ast, (a) => a.route('/api/admin/orders', adminOrderInventoryOriginRoutes));
  assert.deepEqual(await json(await get(app, '/api/admin/orders/ORD-OLD/inventory-origins')), { success: true, installed: false, units: [], untracked: [] });
});
