/**
 * DEPLOY-AHEAD: THE SERIAL-SCAN CODE ON A DATABASE WITHOUT ITS MIGRATION
 * (CLAUDE.md rule 2; spec §7 «Deploy-ahead tolerance»; critique-1 #29).
 *
 * Workflow 7 applies the migration before it deploys, but a manual redeploy of
 * this commit — or Workers Builds re-opened in an emergency — can run this
 * Worker against a database one migration behind. Every door here must then
 * behave exactly as it did before the feature: the order screens open, the
 * new writes answer 503 SERIALS_NOT_INSTALLED (never a 500, never a
 * misleading 404), delivery, cancel, returns, devices and receipts work as at
 * HEAD, and the sweeps do nothing. And the moment the migration lands under
 * the same live isolate, the feature works — no cached «not installed».
 *
 * The pre-migration database is found by the migration's NAME
 * (tests/fixtures/serialPrep.ts BEFORE_SERIALS), so renumbering the file at
 * landing keeps this file honest without an edit.
 *
 * Run: node --import tsx --test tests/serialPrepDeployAhead.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { json, post, patch, put, get, row, count, hasColumn } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { world, order, op, SN, SN2, BEFORE_SERIALS, SERIAL_MIGRATION } from './fixtures/serialPrep';
import { createUnitsOnDelivery, sweepDeliveredOrdersWithoutUnits } from '../worker/lib/deviceOps';
import {
  activateOrderSerials,
  boardSerialCounts,
  orderSerialsView,
  serialGateState,
  serialStory,
  sweepReturnedSerials,
  sweepUnactivatedSerials,
} from '../worker/lib/serialAssignments';
import { anySectionSerialPolicy, serializationContext, lineDevicePolicy } from '../worker/lib/serialPolicy';
import { deleteCancelledOrder } from '../worker/lib/orderDeletion';
import { EXPECTED_MIGRATION } from '../worker/lib/schemaVersion';

type W = ReturnType<typeof world>;
const before = () => world({ through: BEFORE_SERIALS });
const scan = (w: W, o: string, item: string, unit: number, code: string) =>
  post(w.as('adm'), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: unit, code, source: 'camera', op_id: op() });
const ACTOR = { id: 'boss', owner: true, fullSerial: true, orderRefs: true };

test('the fixture is what it claims: one migration behind has none of the new schema; the code expects the serial migration', () => {
  const w = before();
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'serial_assignments'"), 0);
  assert.equal(hasColumn(w.raw, 'catalogs', 'serial_policy'), false);
  assert.equal(hasColumn(w.raw, 'order_item_units', 'warranty_closed_at'), false);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'trg_orders_serial_assignments_cancelled'"), 0);
  assert.ok(EXPECTED_MIGRATION >= SERIAL_MIGRATION, 'schemaVersion names the serial migration or a later one');
});

test('every new door answers 503 SERIALS_NOT_INSTALLED — never a 500, never «not found» — and the order screens open as before', async () => {
  const w = before();
  order(w.raw, 'ORD-0', [{ id: 'l1', product: 'pA1' }]);
  const detail = await get(w.as('adm'), '/api/admin/orders/ORD-0');
  assert.equal(detail.status, 200, await detail.clone().text());
  assert.deepEqual((await json(detail)).order.serials, (await json(await get(w.as('adm'), '/api/admin/orders/ORD-0/serials'))).serials);
  assert.equal((await json(await get(w.as('adm'), '/api/admin/orders/ORD-0/serials'))).serials.installed, false);

  const doors: Array<[string, () => Response | Promise<Response>]> = [
    ['scan', () => scan(w, 'ORD-0', 'l1', 1, SN)],
    ['change', () => post(w.as('adm'), '/api/admin/orders/ORD-0/serials/change', { assignment_id: 'sa_x', code: SN, source: 'manual', op_id: op() })],
    ['unlink', () => post(w.as('adm'), '/api/admin/orders/ORD-0/serials/unlink', { assignment_id: 'sa_x' })],
    ['override', () => post(w.as('boss'), '/api/admin/orders/ORD-0/serials/override', { order_item_id: 'l1', unit_index: 1, code: SN, kind: 'outside_window', reason: 'owner before migration', op_id: op() })],
    ['override by assignment', () => post(w.as('boss'), '/api/admin/orders/ORD-0/serials/override', { assignment_id: 'sa_x', code: SN, kind: 'batch', reason: 'owner before migration', op_id: op() })],
    ['section policy', () => put(w.as('boss'), '/api/admin/taxonomy/catalogs/ct_ams/serial-policy', { policy: 'required' })],
    ['warranty mode', () => post(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}/warranty-mode`, { mode: 'restart', reason: 'owner before migration' })],
  ];
  for (const [name, call] of doors) {
    const r = await call();
    const body = await json(r);
    assert.equal(r.status, 503, `${name}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'SERIALS_NOT_INSTALLED', name);
    assert.equal(body.error, 'ميزة ربط الأرقام التسلسلية لم تُفعّل على قاعدة البيانات بعد.', name);
  }
  // Owner-only stays owner-only before anything else is said.
  assert.equal((await json(await post(w.as('adm'), '/api/admin/orders/ORD-0/serials/override', { order_item_id: 'l1', unit_index: 1, code: SN, kind: 'batch', reason: 'not the owner here', op_id: op() }))).code, 'OWNER_ONLY');
  // The board answers as it always did.
  const board = await json(await get(w.as('adm'), '/api/admin/orders?scope=all'));
  assert.equal(board.orders.find((o: { id: string }) => o.id === 'ORD-0').serials, undefined);
});

test('the order\'s life runs exactly as at HEAD: the gate cannot hold it, delivery makes its units, cancel and the legacy door work', async () => {
  const w = before();
  // Even switched on, the gate has nothing to count with.
  const on = await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: true, since: '2026-01-01T00:00:00.000Z' } });
  assert.equal(on.status, 200);
  assert.deepEqual(await serialGateState(w.env, 'ORD-1'), { installed: false, enabled: false, since: null, applies: false, missing: [], lot_conflicts: [], required: [] });
  order(w.raw, 'ORD-1', [{ id: 'l1', product: 'pA1', qty: 2 }, { id: 'lp', product: 'pPLA' }]);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-1/stage', { stage: 'out_for_delivery' })).status, 200);
  const delivered = await patch(w.as('adm'), '/api/admin/orders/ORD-1/stage', { stage: 'delivered' });
  assert.equal(delivered.status, 200, await delivered.clone().text());
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_item_units WHERE order_id = 'ORD-1'"), 2, 'one warranty unit per printer, as at HEAD');
  const at = row<{ delivered_at: string }>(w.raw, "SELECT delivered_at FROM orders WHERE id = 'ORD-1'")!.delivered_at;
  const replay = await createUnitsOnDelivery(w.env, 'ORD-1', at);
  assert.equal(replay.created, 0);
  assert.ok(!replay.activation || (replay.activation.pending === 0 && replay.activation.activated === 0), 'no activation step on this database');
  assert.equal((await sweepDeliveredOrdersWithoutUnits(w.env, 50)).scanned, 0);

  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }]);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-2/stage', { stage: 'cancelled' })).status, 200, 'the stage door cancels');
  order(w.raw, 'ORD-3', [{ id: 'l3', product: 'pA1' }]);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-3', { status: 'shipped' })).status, 200, 'the legacy door moves');
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-3', { status: 'cancelled' })).status, 200, 'and cancels');
  // A cancelled order is still deletable (the registry tolerates the missing table).
  w.raw.exec(`UPDATE orders SET updated_at = '2026-01-01T00:00:00.000Z', cancelled_at = '2026-01-01T00:00:00.000Z' WHERE id = 'ORD-2'`);
  const del = await deleteCancelledOrder(w.db as never, 'ORD-2');
  assert.equal(del.deleted, true);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM orders WHERE id = 'ORD-2'"), 0);
});

test('the library answers «nothing to do» on every entry point — never a throw', async () => {
  const w = before();
  order(w.raw, 'ORD-L', [{ id: 'l1', product: 'pA1' }]);
  assert.deepEqual(await activateOrderSerials(w.env, 'ORD-L'), { pending: 0, activated: 0, released_policy: 0, conflicts: 0, reopened: 0 });
  assert.deepEqual(await sweepUnactivatedSerials(w.env, 10), { scanned: 0, activated: 0, errors: 0 });
  assert.deepEqual(await sweepReturnedSerials(w.env, 10), { scanned: 0, closed: 0, errors: 0 });
  assert.equal((await orderSerialsView(w.env, ACTOR, 'ORD-L')).installed, false);
  assert.equal(await serialStory(w.env, ACTOR, SN), null);
  assert.equal((await boardSerialCounts(w.env, [{ id: 'ORD-L', status: 'processing', created_at: new Date().toISOString() }])).size, 0);
  assert.equal(await anySectionSerialPolicy(w.db), false);
  const ctx = await serializationContext(w.db, ['pA1', 'pAMS']);
  assert.equal(lineDevicePolicy('{}', 'pA1', ctx).serialized, true, 'a printer is serialized, as at HEAD');
  assert.equal(lineDevicePolicy('{}', 'pAMS', ctx).serialized, false, 'an accessory is not, as at HEAD');
});

test('devices, the serial inventory, receipts and returns behave as at HEAD', async () => {
  const w = before();
  w.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-D','u1','delivered','{}','home','{}','cash',1,1400,1,0,'2026-09-01T00:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES ('ld','ORD-D','pA1','A1',1,1,1);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
      VALUES ('unit_d','ORD-D','ld','pA1','u1',1,'2026-09-01T00:00:00.000Z',12,'2026-09-01T00:00:00.000Z','2099-09-01T00:00:00.000Z');
  `);
  // The post-delivery door: HEAD's write, now through the canonicaliser (serial_inventory exists since 0139).
  const assign = await post(w.as('boss'), '/api/devices/admin/units/unit_d/serial', { serial: `SN ${SN}` });
  assert.equal(assign.status, 200, await assign.clone().text());
  assert.equal(row(w.raw, "SELECT serial_norm FROM device_serials WHERE unit_id = 'unit_d'")!.serial_norm, SN);
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'device.serial_assign' AND target = 'unit_d'"));
  // The customer: register, mine, eligible, the order's units.
  assert.equal((await post(w.as('u1'), '/api/devices/register', { serial: SN })).status, 200);
  assert.equal((await get(w.as('u1'), '/api/devices/mine')).status, 200);
  assert.equal((await get(w.as('u1'), '/api/devices/eligible')).status, 200);
  const units = await json(await get(w.as('u1'), '/api/orders/ORD-D/units'));
  assert.equal(units.units[0].returned, false);
  // The inventory page of a delivered serial (no story before the migration), and its edits.
  const page = await get(w.as('adm'), `/api/devices/admin/serial-inventory/${SN2}`);
  assert.equal(page.status, 404, 'unknown, as at HEAD');
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN2}','${SN2}','pA1','boss')`);
  const known = await json(await get(w.as('adm'), `/api/devices/admin/serial-inventory/${SN2}`));
  assert.equal(known.success, true);
  assert.equal(known.story, undefined);
  assert.equal((await patch(w.as('adm'), `/api/devices/admin/serial-inventory/${SN2}`, { product_id: 'pX2D' })).status, 200, 'no history to guard yet');
  assert.equal((await post(w.as('adm'), `/api/devices/admin/serial-inventory/${SN2}/void`, { reason: 'label damaged' })).status, 200);
  // A receipt for the delivered unit.
  const wr = await post(w.as('boss'), '/api/admin/warranties', { unit_id: 'unit_d' });
  assert.equal(wr.status, 200, await wr.clone().text());
  assert.equal((await json(wr)).receipt.serial_norm, SN);
  // A refund: the return works, and the serial hook says it did nothing.
  w.raw.exec(`INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state) VALUES ('rc_0','ORD-D','ld','unit_d','u1',1,'defective','inspected')`);
  const ret = await post(w.as('adm'), '/api/returns/admin/rc_0/transition', { to: 'resolved', resolution: 'refund', serials: [SN] });
  const body = await json(ret);
  assert.equal(ret.status, 200, JSON.stringify(body));
  assert.deepEqual(body.serials ?? { closed: [], unattributed: false }, { closed: [], unattributed: false });
  assert.equal(row(w.raw, "SELECT state FROM return_cases WHERE id = 'rc_0'")!.state, 'resolved');
  // The replacement door.
  w.raw.exec(`
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
      VALUES ('unit_e','ORD-D','ld','pA1','u1',2,'2026-09-01T00:00:00.000Z',12,'2026-09-01T00:00:00.000Z','2099-09-01T00:00:00.000Z');
  `);
  const rp = await post(w.as('boss'), '/api/devices/admin/units/unit_e/replace', { reason: 'dead on arrival, swapped', new_serial: '03919D580609999' });
  assert.equal(rp.status, 200, await rp.clone().text());
  assert.equal(row(w.raw, "SELECT serial_norm FROM device_serials WHERE unit_id = ?", (await json(rp)).new_unit_id)!.serial_norm, '03919D580609999');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', '03919D580609999'), 0, 'HEAD wrote no asset row here, and neither does this Worker before the migration');
});

test('critique-1 #29: the moment the migration lands under a live isolate, the same Worker serves the feature — no cached «not installed»', async () => {
  const w = before();
  order(w.raw, 'ORD-LAND', [{ id: 'l1', product: 'pA1' }]);
  const r = await scan(w, 'ORD-LAND', 'l1', 1, SN);
  assert.equal(r.status, 503);
  // workflow 7 applies the pending migration while this Worker keeps serving.
  w.raw.exec(readFileSync(join(ROOT, 'migrations', SERIAL_MIGRATION), 'utf8'));
  const after = await scan(w, 'ORD-LAND', 'l1', 1, SN);
  assert.equal(after.status, 200, await after.clone().text());
  assert.equal((await json(await get(w.as('adm'), '/api/admin/orders/ORD-LAND/serials'))).serials.installed, true);
  // The cancel trigger came with it.
  await patch(w.as('adm'), '/api/admin/orders/ORD-LAND/stage', { stage: 'cancelled' });
  assert.equal(row(w.raw, "SELECT release_reason FROM serial_assignments WHERE order_id = 'ORD-LAND'")!.release_reason, 'order_cancelled');
  // Applying it again is harmless (workflow 7 proves --twice on a throwaway database).
  assert.doesNotThrow(() => {
    try {
      w.raw.exec(readFileSync(join(ROOT, 'migrations', SERIAL_MIGRATION), 'utf8'));
    } catch (e) {
      // ALTER TABLE … ADD COLUMN has no IF NOT EXISTS in SQLite; the runner records applied files and never re-runs one.
      if (!/duplicate column name/.test(String((e as Error).message))) throw e;
    }
  });
});
