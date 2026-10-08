/**
 * Serial → warranty at DELIVERY, and back on a RETURN (migration 0177; owner
 * brief §8, §11, §12, §14, §28, §30; §32 tests 8, 9, 10, 19, 20).
 *
 * The warranty record stays `order_item_units`, created at delivery with the
 * existing computeCoverage; the preparation serial is bound to it in a batch
 * of its own (critique H3), the lot lands on inventory_lot_id (§28), and a
 * return CLOSES the unit with its dates kept — the device's identity and
 * history continue on the next sale (carry = the original end, H4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, all, row, count, failingD1 } from './fixtures/app';
import { world, order, op, SN, SN2 } from './fixtures/serialPrep';
import { createUnitsOnDelivery } from '../worker/lib/deviceOps';
import { sweepUnactivatedSerials, activateOrderSerials, sweepReturnedSerials } from '../worker/lib/serialAssignments';
import { addMonths } from '../worker/lib/membershipOps';

type W = ReturnType<typeof world>;
type R = Record<string, string | number | null>;
const scan = (w: W, who: 'adm' | 'boss', o: string, item: string, unit: number, code: string) =>
  post(w.as(who), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: unit, code, source: 'scanner', op_id: op() });
const deliver = (w: W, o: string) => patch(w.as('adm'), `/api/admin/orders/${o}/stage`, { stage: 'delivered' });
const unitOf = (w: W, o: string) => row<R>(w.raw, 'SELECT * FROM order_item_units WHERE order_id = ? ORDER BY unit_index', o)!;

function receipt(w: W, id: string, unitId: string, o: string, item: string, serial: string) {
  w.raw
    .prepare(
      `INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, serial_norm, serial_raw, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
    )
    .run(id, `WR-2026-1007-${id.slice(-3)}`, unitId, o, item, serial, serial);
}

test('§32.8 delivery starts the warranty from delivered_at with the existing coverage, binds the serial and the lot, once', async () => {
  const w = world();
  order(w.raw, 'ORD-D', [{ id: 'l1', product: 'pA1' }, { id: 'l2', product: 'pA1' }]);
  w.raw.exec(`
    UPDATE order_items SET warranty_snapshot = '{"plan_id":"wp_ext12","duration_kind":"extension","duration_months":12,"total_months":24,"base_months":12}' WHERE id = 'l2';
    INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, cost_basis, received_at)
      VALUES ('lotA','pA1','base','',3,1,'received','2026-09-01T00:00:00.000Z');
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, idempotency_key)
      VALUES ('al1','ORD-D','l1','lotA','base','',1,'alloc:ORD-D:l1:lotA'), ('al2','ORD-D','l2','lotA','base','',1,'alloc:ORD-D:l2:lotA');
    INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN}','${SN}','pA1','boss');
    INSERT INTO stock_serial_links (serial_norm, lot_id, linked_by, linked_at) VALUES ('${SN}','lotA','boss','2026-09-01T00:00:00.000Z');
  `);
  assert.equal((await scan(w, 'adm', 'ORD-D', 'l1', 1, SN)).status, 200);
  assert.equal((await scan(w, 'adm', 'ORD-D', 'l2', 1, SN2)).status, 200);
  const moved = await deliver(w, 'ORD-D');
  assert.equal(moved.status, 200, await moved.clone().text());
  const delivered = row<{ delivered_at: string }>(w.raw, "SELECT delivered_at FROM orders WHERE id = 'ORD-D'")!.delivered_at;
  const units = all<R>(w.raw, "SELECT u.*, d.serial_norm FROM order_item_units u LEFT JOIN device_serials d ON d.unit_id = u.id WHERE u.order_id = 'ORD-D' ORDER BY u.order_item_id");
  assert.equal(units.length, 2);
  assert.equal(units[0].warranty_start_at, delivered, '§8 the warranty starts at delivery, never at the scan');
  assert.equal(units[0].warranty_end_at, addMonths(delivered, 12));
  assert.equal(units[1].warranty_end_at, addMonths(delivered, 24), 'the checkout-frozen 24 months (computeCoverage)');
  assert.deepEqual(units.map((u) => u.serial_norm), [SN, SN2]);
  assert.equal(units[0].inventory_lot_id, 'lotA', '§28 the verified lot reaches the warranty record');
  assert.equal(units[1].inventory_lot_id, null, 'an inferred lot is never written as fact (L12)');
  const a = all<R>(w.raw, "SELECT * FROM serial_assignments WHERE order_id = 'ORD-D'");
  assert.ok(a.every((x) => x.activated_at && x.unit_id && !x.released_at));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.warranty_activated'"), 2);

  // Replays — the courier door, the backfill, the sweep — change nothing.
  const env = w.env;
  assert.deepEqual(await createUnitsOnDelivery(env, 'ORD-D', delivered), { serialized_items: 2, planned_units: 2, created: 0 });
  assert.equal((await sweepUnactivatedSerials(env, 50)).scanned, 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.warranty_activated'"), 2);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM device_serials'), 2);
  const page = await json(await (w.as('boss')).request(`/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(page.story.status, 'sold');
  assert.equal(page.story.warranty.state, 'ACTIVE');
});

test('H3 activation is its own batch: when it fails the units still exist, and the sweep binds them later', async () => {
  const w = world();
  order(w.raw, 'ORD-H3', [{ id: 'l1', product: 'pA1' }], { status: 'delivered', stage: 'delivered' });
  w.raw.exec(`UPDATE orders SET delivered_at = '2026-10-01T10:00:00.000Z' WHERE id = 'ORD-H3'`);
  // A live binding made while it was prepared (written directly: the order is already delivered here).
  w.raw.exec(`
    INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN}','${SN}','pA1','adm');
    INSERT INTO serial_assignments (id, serial_norm, serial_raw, order_id, order_item_id, order_ref, unit_index, source, idempotency_key, linked_by)
      VALUES ('sa_h3','${SN}','${SN}','ORD-H3','l1','ORD-H3',1,'camera','scan:h3','adm');
  `);
  const { failing, db } = failingD1(w.raw);
  failing.failWhen = (s) => s.some((x) => /INSERT INTO device_serials/.test(x.sql));
  const env = { DB: db } as never;
  const r = await createUnitsOnDelivery(env, 'ORD-H3', '2026-10-01T10:00:00.000Z');
  assert.equal(r.created, 1, 'the warranty unit exists whatever the activation did');
  assert.equal(r.activation?.conflicts, 1);
  assert.equal(row(w.raw, "SELECT activation_attempts FROM serial_assignments WHERE id = 'sa_h3'")!.activation_attempts, 1);
  failing.failWhen = null;
  const swept = await sweepUnactivatedSerials(env, 10);
  assert.equal(swept.activated, 1);
  assert.ok(row(w.raw, "SELECT activated_at FROM serial_assignments WHERE id = 'sa_h3'")!.activated_at);
});

test('§32.9/§11 a delivered device: staff refused (§11 sentence), legacy-only devices and live receipts too; the owner override moves the warranty at the new delivery', async () => {
  const w = world();
  order(w.raw, 'ORD-1', [{ id: 'l1', product: 'pA1' }]);
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-1', 'l1', 1, SN);
  await deliver(w, 'ORD-1');
  const first = unitOf(w, 'ORD-1');
  receipt(w, 'wr_001', String(first.id), 'ORD-1', 'l1', SN);
  w.raw.exec(`INSERT INTO device_registrations (unit_id, user_id) VALUES ('${first.id}','u1')`);

  const refused = await scan(w, 'adm', 'ORD-2', 'l2', 1, SN);
  const body = await json(refused);
  assert.equal(refused.status, 409);
  assert.equal(body.code, 'SERIAL_DELIVERED');
  assert.equal(body.error, 'هذا الجهاز تم تسليمه مسبقاً ومربوط بضمان فعال.');
  assert.equal(body.details.order_id, undefined, 'only the owner sees whose order it is');

  // A device sold before any of this existed — only device_serials knows it.
  w.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-LEG','u2','delivered','{}','home','{}','cash',1,1400,1,0,'2026-01-01T00:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES ('lleg','ORD-LEG','pA1','A1',1,1,1);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_start_at, warranty_end_at)
      VALUES ('unit_leg','ORD-LEG','lleg','pA1','u2',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z');
    INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES ('${SN2}','${SN2}','unit_leg','boss');
  `);
  assert.equal((await json(await scan(w, 'adm', 'ORD-2', 'l2', 1, SN2))).code, 'SERIAL_DELIVERED');

  // The owner's exception: a reason, and the original customer's binding stays live until the new delivery (M14).
  const ov = await post(w.as('boss'), '/api/admin/orders/ORD-2/serials/override', {
    order_item_id: 'l2', unit_index: 1, code: SN, kind: 'delivered_device', reason: 'device bought back from the customer', op_id: op(),
  });
  assert.equal(ov.status, 200, await ov.clone().text());
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL", SN), 2);
  await deliver(w, 'ORD-2');
  const before = row<R>(w.raw, 'SELECT * FROM order_item_units WHERE id = ?', first.id)!;
  assert.equal(before.warranty_closed_reason, 'owner_override');
  assert.equal(before.warranty_end_at, first.warranty_end_at, 'dates are history, never zeroed');
  assert.equal(row(w.raw, "SELECT status FROM warranty_receipts WHERE id = 'wr_001'")!.status, 'void');
  assert.ok(row(w.raw, 'SELECT revoked_at FROM device_registrations WHERE unit_id = ?', first.id)!.revoked_at);
  const second = unitOf(w, 'ORD-2');
  assert.equal(row(w.raw, 'SELECT unit_id FROM device_serials WHERE serial_norm = ?', SN)!.unit_id, second.id);
  assert.equal(second.warranty_end_at, first.warranty_end_at, 'carry: the original end by default');
  assert.equal(row(w.raw, "SELECT release_reason FROM serial_assignments WHERE order_id = 'ORD-1'")!.release_reason, 'owner_override');
});

test('§32.10/§14 return after delivery: the unit closes with its dates, receipt void, link revoked; resale carries the original end', async () => {
  const w = world();
  order(w.raw, 'ORD-111', [{ id: 'l1', product: 'pA1' }]);
  order(w.raw, 'ORD-222', [{ id: 'l2', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-111', 'l1', 1, SN);
  await deliver(w, 'ORD-111');
  const u1 = unitOf(w, 'ORD-111');
  receipt(w, 'wr_111', String(u1.id), 'ORD-111', 'l1', SN);
  w.raw.exec(`
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('${u1.id}','u1');
    INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state)
      VALUES ('rc_1','ORD-111','l1','${u1.id}','u1',1,'defective','inspected');
  `);
  const res = await post(w.as('adm'), '/api/returns/admin/rc_1/transition', { to: 'resolved', resolution: 'refund' });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.serials.closed, [u1.id]);
  const closed = unitOf(w, 'ORD-111');
  assert.equal(closed.warranty_closed_reason, 'returned');
  assert.equal(closed.return_case_id, 'rc_1');
  assert.equal(closed.warranty_start_at, u1.warranty_start_at);
  assert.equal(closed.warranty_end_at, u1.warranty_end_at, '§14 never zeroed');
  assert.equal(row(w.raw, "SELECT status FROM warranty_receipts WHERE id = 'wr_111'")!.status, 'void');
  assert.ok(row(w.raw, 'SELECT revoked_at FROM device_registrations WHERE unit_id = ?', u1.id)!.revoked_at);
  assert.equal(row(w.raw, "SELECT release_reason FROM serial_assignments WHERE order_id = 'ORD-111'")!.release_reason, 'returned');
  const page = await json(await (w.as('boss')).request(`/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(page.story.status, 'returned');
  assert.equal(page.story.warranty.state, 'RETURNED');
  // The buyer cannot take the returned device back onto their account, it is
  // gone from «add from my orders», and the order says it came back.
  assert.equal((await post(w.as('u1'), '/api/devices/register', { serial: SN })).status, 404);
  const eligible = await json(await w.as('u1').request('/api/devices/eligible'));
  assert.ok(!eligible.units.some((x: { unit_id?: string; id?: string }) => (x.unit_id ?? x.id) === u1.id), 'a returned device is not eligible');
  const units = await json(await w.as('u1').request('/api/orders/ORD-111/units'));
  assert.equal(units.units[0].warranty.state, 'closed');
  assert.equal(units.units[0].returned, true);
  assert.equal(units.units[0].warranty.end_at, u1.warranty_end_at, 'the dates stay on screen');

  // Resale: the same asset, the same identity — the original end carries.
  const again = await json(await scan(w, 'adm', 'ORD-222', 'l2', 1, SN));
  assert.equal(again.outcome, 'existing');
  assert.equal(again.slot.assignment.warranty.mode, 'carry');
  assert.equal(again.slot.assignment.warranty.carries_until, u1.warranty_end_at);
  await deliver(w, 'ORD-222');
  const u2 = unitOf(w, 'ORD-222');
  assert.equal(u2.warranty_end_at, u1.warranty_end_at);
  const pv = JSON.parse(String(u2.policy_version));
  assert.equal(pv.carried, 'original_end', 'H4: the marker every reader already honours');
  assert.equal(pv.resale_of, u1.id);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 1, 'one asset, ever');
  // A new receipt can be issued for the new unit (the old one was voided).
  const wr = await post(w.as('boss'), '/api/admin/warranties', { unit_id: u2.id });
  assert.notEqual((await json(wr)).code, 'WARRANTY_EXISTS');
});

test('§14 a return inspected as quarantine closes the unit as unsellable; staff cannot resell it; an ambiguous case changes nothing', async () => {
  const w = world();
  order(w.raw, 'ORD-Q', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  order(w.raw, 'ORD-N', [{ id: 'ln', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-Q', 'l1', 1, SN);
  await scan(w, 'adm', 'ORD-Q', 'l1', 2, SN2);
  await deliver(w, 'ORD-Q');
  const units = all<R>(w.raw, "SELECT u.id, d.serial_norm FROM order_item_units u JOIN device_serials d ON d.unit_id = u.id WHERE u.order_id = 'ORD-Q' ORDER BY u.unit_index");
  // One of two units, picked by the customer: the hook does not trust it (M6) — unattributed.
  w.raw.exec(`INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state)
      VALUES ('rc_amb','ORD-Q','l1','${units[0].id}','u1',1,'defective','inspected')`);
  const amb = await json(await post(w.as('adm'), '/api/returns/admin/rc_amb/transition', { to: 'resolved', resolution: 'refund' }));
  assert.deepEqual(amb.serials, { closed: [], unattributed: true });
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'serial.return_unattributed' AND target = 'rc_amb'"));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_item_units WHERE order_id = 'ORD-Q' AND warranty_closed_at IS NOT NULL"), 0);
  // The serial scanned at inspection decides — and a serial that is not this line's is refused before any money moves.
  w.raw.exec(`
    INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state)
      VALUES ('rc_q','ORD-Q','l1',NULL,'u1',1,'defective','inspected');
    INSERT INTO stock_return_inspections (id, order_item_id, qty, disposition, actor_id, created_at, return_case_id)
      VALUES ('ins_q','l1',1,'quarantine','adm','2026-10-07T00:00:00.000Z','rc_q');
  `);
  const wrong = await post(w.as('adm'), '/api/returns/admin/rc_q/transition', { to: 'resolved', resolution: 'refund', serials: ['03919D580609999'] });
  assert.equal((await json(wrong)).code, 'RETURN_SERIAL_MISMATCH');
  assert.equal(row(w.raw, "SELECT state FROM return_cases WHERE id = 'rc_q'")!.state, 'inspected', 'nothing moved');
  const ok = await json(await post(w.as('adm'), '/api/returns/admin/rc_q/transition', { to: 'resolved', resolution: 'refund', serials: [SN2] }));
  assert.deepEqual(ok.serials.closed, [units[1].id]);
  assert.equal(row(w.raw, 'SELECT warranty_closed_reason FROM order_item_units WHERE id = ?', units[1].id)!.warranty_closed_reason, 'returned_unsellable');
  const resell = await json(await scan(w, 'adm', 'ORD-N', 'ln', 1, SN2));
  assert.equal(resell.code, 'SERIAL_NOT_AVAILABLE');
  assert.equal((await sweepReturnedSerials(w.env, 10)).scanned, 0, 'nothing left for the sweep');
});

test('§12/L3 a delivery undone and then cancelled closes the unit (order_cancelled); a re-opened, re-scanned, re-delivered order re-opens it', async () => {
  const w = world();
  order(w.raw, 'ORD-R', [{ id: 'l1', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-R', 'l1', 1, SN);
  await deliver(w, 'ORD-R');
  const u = unitOf(w, 'ORD-R');
  receipt(w, 'wr_r01', String(u.id), 'ORD-R', 'l1', SN);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-R/stage', { stage: 'out_for_delivery' })).status, 200);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-R/stage', { stage: 'cancelled' })).status, 200);
  assert.equal(unitOf(w, 'ORD-R').warranty_closed_reason, 'order_cancelled');
  assert.equal(row(w.raw, "SELECT status FROM warranty_receipts WHERE id = 'wr_r01'")!.status, 'void');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_id = 'ORD-R' AND released_at IS NULL"), 0);
  // §30 re-open: nothing is revived; the slot shows the previous serial as a suggestion.
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-R/stage', { stage: 'confirmed' })).status, 200);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-R/stage', { stage: 'preparing' })).status, 200);
  const detail = await json(await (w.as('boss')).request('/api/admin/orders/ORD-R'));
  const slot = detail.order.serials.slots[0];
  assert.equal(slot.assignment, null);
  assert.equal(slot.previous.serial_full, SN);
  assert.equal(slot.previous.free, true);
  const relink = await post(w.as('adm'), '/api/admin/orders/ORD-R/serials/scan', { order_item_id: 'l1', unit_index: 1, code: SN, source: 'relink', op_id: op() });
  assert.equal(relink.status, 200, await relink.clone().text());
  await deliver(w, 'ORD-R');
  const reopened = unitOf(w, 'ORD-R');
  assert.equal(reopened.warranty_closed_at, null, 'the re-delivered unit covers again');
  assert.equal(reopened.warranty_start_at, u.warranty_start_at, 'with the one delivery date it ever had');
});

test('M5 a slot whose line is no longer serialized at delivery releases its serial (policy_changed) instead of holding it for ever', async () => {
  const w = world();
  await (w.as('boss')).request('/api/admin/taxonomy/catalogs/ct_ams/serial-policy', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy: 'required' }),
  });
  order(w.raw, 'ORD-M5', [{ id: 'la', product: 'pAMS' }]);
  assert.equal((await scan(w, 'adm', 'ORD-M5', 'la', 1, '00N00A123456789')).status, 200);
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'inherit' WHERE id = 'ct_ams'`);
  await deliver(w, 'ORD-M5');
  assert.equal(row(w.raw, "SELECT release_reason FROM serial_assignments WHERE order_id = 'ORD-M5'")!.release_reason, 'policy_changed');
  assert.deepEqual(await activateOrderSerials(w.env, 'ORD-M5'), { pending: 0, activated: 0, released_policy: 0, conflicts: 0 });
});
