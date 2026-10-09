/**
 * Serial scan at preparation — the three reviews' confirmed findings
 * (integrity, UX, regressions), each driven through the real routes on a
 * real database (tests/fixtures/serialPrep.ts). One test per finding, named
 * after it, so a finding that comes back fails by its own name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, put, get, row, all, count, failingD1, stubApp } from './fixtures/app';
import { world, order, op, SN, SN2, SN3, BOX, USERS, mountSerialWorld, afterReadsOf } from './fixtures/serialPrep';
import { returnedUnits, sweepUnactivatedSerials } from '../worker/lib/serialAssignments';
import { buildBulkRow } from '../packages/catalog/src/deviceSerials';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERIAL_STRINGS } from '../src/components/adminOrders/serials/strings';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

type W = ReturnType<typeof world>;
type R = Record<string, string | number | null>;
type Who = 'boss' | 'adm' | 'ast';
const scanBody = (item: string, unit: number, code: string, opId = op()) => ({ order_item_id: item, unit_index: unit, code, source: 'scanner', op_id: opId });
const scan = (w: W, who: Who, o: string, item: string, unit: number, code: string, opId?: string) =>
  post(w.as(who), `/api/admin/orders/${o}/serials/scan`, scanBody(item, unit, code, opId));
const stage = (w: W, o: string, to: string, extra: Record<string, unknown> = {}) => patch(w.as('adm'), `/api/admin/orders/${o}/stage`, { stage: to, ...extra });
const unitOf = (w: W, o: string) => row<R>(w.raw, 'SELECT * FROM order_item_units WHERE order_id = ? ORDER BY unit_index', o)!;
const pointer = (w: W, serial: string) => row<R>(w.raw, 'SELECT unit_id FROM device_serials WHERE serial_norm = ?', serial)?.unit_id ?? null;

/** Delivered, then moved back, cancelled and put back on the shelf (§30). */
async function deliveredUndoneCancelledReopened(w: W, o: string) {
  assert.equal((await stage(w, o, 'delivered')).status, 200);
  assert.equal((await stage(w, o, 'out_for_delivery')).status, 200);
  assert.equal((await stage(w, o, 'cancelled')).status, 200);
  assert.equal(unitOf(w, o).warranty_closed_reason, 'order_cancelled');
  assert.equal((await stage(w, o, 'confirmed')).status, 200);
  assert.equal((await stage(w, o, 'preparing')).status, 200);
}

function receipt(w: W, id: string, unitId: string, o: string, item: string, serial: string) {
  w.raw
    .prepare(
      `INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, serial_norm, serial_raw, status, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '2026-10-01T00:00:00.000Z')`
    )
    .run(id, `WR-2026-1008-${id.slice(-3)}`, unitId, o, item, serial, serial);
}

// ------------------------------------------------------------ integrity #1, regressions #2

test('integrity #1 / regressions #2: re-delivered after undo + cancel + re-open WITHOUT a new scan — the warranty, the receipt and the device come back; the device is not for sale', async () => {
  const w = world();
  order(w.raw, 'ORD-R', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-R', 'l1', 1, SN)).status, 200);
  await deliveredUndoneCancelledReopened(w, 'ORD-R');
  const u = unitOf(w, 'ORD-R');
  receipt(w, 'wr_x01', String(u.id), 'ORD-R', 'l1', SN);
  w.raw.exec(`UPDATE warranty_receipts SET status = 'void', void_reason = 'order_cancelled', voided_at = '${u.warranty_closed_at}' WHERE id = 'wr_x01'`);
  // Delivered again, nobody re-scanned (the gate ships off).
  assert.equal((await stage(w, 'ORD-R', 'delivered')).status, 200);
  const again = unitOf(w, 'ORD-R');
  assert.equal(again.warranty_closed_at, null, 'the customer holds a device again: the warranty is open');
  assert.equal(again.warranty_start_at, u.warranty_start_at, 'with its one delivery date');
  assert.equal(pointer(w, SN), again.id, 'the device the unit had, still free, stays with it');
  const live = row<R>(w.raw, 'SELECT * FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', SN)!;
  assert.equal(live.source, 'relink');
  assert.equal(live.unit_id, again.id);
  assert.ok(live.activated_at, 'a delivered binding the one-live-binding index sees');
  assert.equal(row(w.raw, "SELECT status FROM warranty_receipts WHERE id = 'wr_x01'")!.status, 'active', 'the paper the cancel voided is valid again');
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'serial.warranty_reopened' AND target = ?", SN), 'and the history says so');
  const units = await json(await get(w.as('u1'), '/api/orders/ORD-R/units'));
  assert.equal(units.units[0].returned, false, '«returned» never shows on a device the customer has');
  // Not a free device: staff cannot sell it to someone else.
  order(w.raw, 'ORD-Z', [{ id: 'lz', product: 'pA1' }], { user: 'u2' });
  assert.equal((await json(await scan(w, 'adm', 'ORD-Z', 'lz', 1, SN))).code, 'SERIAL_DELIVERED');
});

test('integrity #1: a device sold elsewhere between the cancel and the re-delivery is not pulled back — the unit re-opens without it, audited', async () => {
  const w = world();
  order(w.raw, 'ORD-R', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-R', 'l1', 1, SN)).status, 200);
  await deliveredUndoneCancelledReopened(w, 'ORD-R');
  // The free device goes onto another order's shelf.
  order(w.raw, 'ORD-Z', [{ id: 'lz', product: 'pA1' }], { user: 'u2' });
  assert.equal((await json(await scan(w, 'adm', 'ORD-Z', 'lz', 1, SN))).outcome, 'existing');
  assert.equal((await stage(w, 'ORD-R', 'delivered')).status, 200);
  const r = unitOf(w, 'ORD-R');
  assert.equal(r.warranty_closed_at, null, 'R\'s customer has a device: their warranty is open');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM device_serials WHERE unit_id = ?', r.id), 0, 'but not THIS serial — it is Z\'s');
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'serial.detached' AND target = ?", SN));
  assert.equal((await stage(w, 'ORD-Z', 'delivered')).status, 200);
  assert.equal(pointer(w, SN), unitOf(w, 'ORD-Z').id, 'Z\'s delivery moves the device to Z, cleanly');
});

test('integrity #1: a re-opened delivered order that the activation did not reach reads as delivered, and the cron re-opens it', async () => {
  const w = world();
  order(w.raw, 'ORD-R', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-R', 'l1', 1, SN)).status, 200);
  await deliveredUndoneCancelledReopened(w, 'ORD-R');
  // Delivered by a door that did not run the activation (as if it failed).
  w.raw.exec(`UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = '2026-10-08T09:00:00.000Z' WHERE id = 'ORD-R'`);
  order(w.raw, 'ORD-Z', [{ id: 'lz', product: 'pA1' }], { user: 'u2' });
  assert.equal((await json(await scan(w, 'adm', 'ORD-Z', 'lz', 1, SN))).code, 'SERIAL_DELIVERED', 'never a free device in between');
  const swept = await sweepUnactivatedSerials(w.env, 10);
  assert.equal(swept.scanned, 1);
  assert.equal(unitOf(w, 'ORD-R').warranty_closed_at, null);
  assert.equal((await sweepUnactivatedSerials(w.env, 10)).scanned, 0, 'and once is enough');
});

// ------------------------------------------------------------ regressions #1

test('regressions #1: a re-opened, re-scanned, re-delivered device stays its registered holder\'s — a stranger typing the serial gets nothing', async () => {
  const w = world();
  order(w.raw, 'ORD-R', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-R', 'l1', 1, SN)).status, 200);
  assert.equal((await stage(w, 'ORD-R', 'delivered')).status, 200);
  assert.equal((await post(w.as('u1'), '/api/devices/register', { serial: SN })).status, 200);
  assert.equal((await stage(w, 'ORD-R', 'out_for_delivery')).status, 200);
  assert.equal((await stage(w, 'ORD-R', 'cancelled')).status, 200);
  assert.ok(row(w.raw, 'SELECT revoked_at FROM device_registrations')!.revoked_at, 'the cancel takes the device off the account');
  assert.notEqual((await post(w.as('u2'), '/api/devices/register', { serial: SN })).status, 200, 'and nobody can claim it meanwhile');
  assert.equal((await stage(w, 'ORD-R', 'confirmed')).status, 200);
  assert.equal((await stage(w, 'ORD-R', 'preparing')).status, 200);
  assert.equal((await scan(w, 'adm', 'ORD-R', 'l1', 1, SN)).status, 200);
  assert.equal((await stage(w, 'ORD-R', 'delivered')).status, 200);
  const reg = row<R>(w.raw, 'SELECT user_id, revoked_at FROM device_registrations')!;
  assert.deepEqual({ user: reg.user_id, revoked: reg.revoked_at }, { user: 'u1', revoked: null }, 'the account link comes back with the delivery');
  const stranger = await post(w.as('u2'), '/api/devices/register', { serial: SN });
  assert.notEqual(stranger.status, 200, await stranger.clone().text());
  assert.equal(row(w.raw, 'SELECT user_id FROM device_registrations')!.user_id, 'u1');
});

// ------------------------------------------------------------ integrity #2, #5

test('integrity #2: only the owner takes the serial off a delivered unit whose warranty is open; the device never becomes sellable on a staff word', async () => {
  const w = world();
  order(w.raw, 'ORD-D', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-D', 'l1', 1, SN)).status, 200);
  assert.equal((await stage(w, 'ORD-D', 'delivered')).status, 200);
  const u = unitOf(w, 'ORD-D');
  for (const who of ['ast', 'adm'] as const) {
    const r = await json(await post(w.as(who), `/api/devices/admin/units/${u.id}/serial`, { serial: SN2, reassign: true, reason: 'typo fix please' }));
    assert.equal(r.code, 'OWNER_ONLY', who);
  }
  assert.equal(pointer(w, SN), u.id);
  order(w.raw, 'ORD-E', [{ id: 'le', product: 'pA1' }], { user: 'u2' });
  assert.equal((await json(await scan(w, 'adm', 'ORD-E', 'le', 1, SN))).code, 'SERIAL_DELIVERED');
});

test('integrity #5: the post-delivery door serves a delivered order\'s open unit only — not a cancelled order\'s closed unit, not a delivery moved back', async () => {
  const w = world();
  order(w.raw, 'ORD-C', [{ id: 'lc', product: 'pA1' }]);
  assert.equal((await stage(w, 'ORD-C', 'delivered')).status, 200);
  const u = unitOf(w, 'ORD-C');
  assert.equal((await stage(w, 'ORD-C', 'out_for_delivery')).status, 200);
  const movedBack = await json(await post(w.as('boss'), `/api/devices/admin/units/${u.id}/serial`, { serial: SN }));
  assert.equal(movedBack.code, 'ORDER_NOT_PREPARABLE', 'the preparation rules (and the courier freeze) apply, not a side door');
  assert.equal((await stage(w, 'ORD-C', 'cancelled')).status, 200);
  w.raw.exec(`UPDATE order_item_units SET warranty_closed_at = '2026-10-08T00:00:00.000Z', warranty_closed_reason = 'order_cancelled' WHERE id = '${u.id}'`);
  const cancelled = await json(await post(w.as('boss'), `/api/devices/admin/units/${u.id}/serial`, { serial: SN }));
  assert.equal(cancelled.code, 'ORDER_NOT_PREPARABLE');
  // A delivered order's closed (returned) unit.
  order(w.raw, 'ORD-X', [{ id: 'lx', product: 'pA1' }]);
  assert.equal((await stage(w, 'ORD-X', 'delivered')).status, 200);
  const x = unitOf(w, 'ORD-X');
  w.raw.exec(`UPDATE order_item_units SET warranty_closed_at = '2026-10-08T00:00:00.000Z', warranty_closed_reason = 'returned' WHERE id = '${x.id}'`);
  assert.equal((await json(await post(w.as('boss'), `/api/devices/admin/units/${x.id}/serial`, { serial: SN }))).code, 'UNIT_NOT_OPEN');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE released_at IS NULL'), 0, 'no live binding on a cancelled order or a closed unit');
});

// ------------------------------------------------------------ integrity #3

test('integrity #3: a staff scan landing between the post-delivery door\'s read and its write — the door is refused inside its batch', async () => {
  const w = world();
  order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
  order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }], { user: 'u2' });
  assert.equal((await stage(w, 'ORD-A', 'delivered')).status, 200);
  const unitA = unitOf(w, 'ORD-A');
  const { failing, db } = failingD1(w.raw);
  let injected = false;
  failing.beforeBatch = (s) => {
    if (injected || !s.some((x) => /INSERT INTO device_serials/.test(x.sql))) return;
    injected = true;
    w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, source, created_by) VALUES ('${SN}','${SN}','pA1','scan','adm');
      INSERT INTO serial_assignments (id, serial_norm, serial_raw, order_id, order_item_id, order_ref, unit_index, source, idempotency_key, linked_by)
        VALUES ('sa_b','${SN}','${SN}','ORD-B','lb','ORD-B',1,'camera','scan:race-b','adm');`);
  };
  const res = await post(stubApp(db, USERS.boss, mountSerialWorld), `/api/devices/admin/units/${unitA.id}/serial`, { serial: SN });
  assert.ok(injected);
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal((await json(res)).code, 'SERIAL_RACE');
  assert.equal(pointer(w, SN), null, 'the device stays ORD-B\'s, delivered to nobody');
  assert.deepEqual(all<R>(w.raw, 'SELECT order_id FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', SN).map((r) => r.order_id), ['ORD-B']);
});

test('integrity #3: the replacement door re-checks the new serial\'s bindings inside its batch', async () => {
  const w = world();
  order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
  order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }], { user: 'u2' });
  assert.equal((await stage(w, 'ORD-A', 'delivered')).status, 200);
  const unitA = unitOf(w, 'ORD-A');
  const { failing, db } = failingD1(w.raw);
  let injected = false;
  failing.beforeBatch = (s) => {
    if (injected || !s.some((x) => /INSERT INTO order_item_units/.test(x.sql))) return;
    injected = true;
    w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, source, created_by) VALUES ('${SN2}','${SN2}','pA1','scan','adm');
      INSERT INTO serial_assignments (id, serial_norm, serial_raw, order_id, order_item_id, order_ref, unit_index, source, idempotency_key, linked_by)
        VALUES ('sa_b','${SN2}','${SN2}','ORD-B','lb','ORD-B',1,'camera','scan:race-r','adm');`);
  };
  const res = await post(stubApp(db, USERS.boss, mountSerialWorld), `/api/devices/admin/units/${unitA.id}/replace`, { reason: 'dead on arrival', new_serial: SN2 });
  assert.ok(injected);
  assert.equal((await json(res)).code, 'SERIAL_IN_USE');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_item_units WHERE order_id = 'ORD-A'"), 1, 'nothing replaced');
  assert.equal(pointer(w, SN2), null);
});

// ------------------------------------------------------------ integrity #4

function lots(w: W, o: string, item: string) {
  w.raw.exec(`
    INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, cost_basis, received_at)
      VALUES ('lotA','pA1','base','',3,2,'received','2026-09-01T00:00:00.000Z'),
             ('lotB','pA1','base','',3,3,'received','2026-09-15T00:00:00.000Z');
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, idempotency_key)
      VALUES ('al1','${o}','${item}','lotA','base','',1,'alloc:${o}:${item}:lotA');
  `);
}

test('integrity #4: a lot recorded after the scan must be one the line was allocated — refused otherwise, and the gate compares it too', async () => {
  const w = world();
  order(w.raw, 'ORD-L', [{ id: 'la', product: 'pA1' }], { created_at: '2026-10-05T00:00:00.000Z' });
  lots(w, 'ORD-L', 'la');
  assert.equal((await scan(w, 'adm', 'ORD-L', 'la', 1, SN)).status, 200);
  const foreign = await post(w.as('adm'), '/api/admin/stock-operations/serial-link', { serial_norm: SN, lot_id: 'lotB' });
  assert.equal(foreign.status, 400, await foreign.clone().text());
  assert.equal((await json(foreign)).code, 'SERIAL_BATCH_MISMATCH');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM stock_serial_links'), 0);
  // The line's own lot: recorded, and the binding now carries it as verified.
  assert.equal((await post(w.as('adm'), '/api/admin/stock-operations/serial-link', { serial_norm: SN, lot_id: 'lotA' })).status, 200);
  const a = row<R>(w.raw, 'SELECT lot_id, lot_source FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', SN)!;
  assert.deepEqual({ lot: a.lot_id, source: a.lot_source }, { lot: 'lotA', source: 'serial_link' });
  // A link that predates this check and names another lot holds the gate.
  w.raw.exec(`UPDATE stock_serial_links SET lot_id = 'lotB' WHERE serial_norm = '${SN}'; UPDATE serial_assignments SET lot_source = 'allocation' WHERE serial_norm = '${SN}'`);
  assert.equal((await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: true, since: '2026-01-01T00:00:00.000Z' } })).status, 200);
  const move = await stage(w, 'ORD-L', 'out_for_delivery');
  assert.equal(move.status, 409, await move.clone().text());
  assert.equal((await json(move)).details.lot_conflicts.length, 1);
});

// ------------------------------------------------------------ integrity #6

test('integrity #6: the owner\'s take-from-order only takes from an order still on the shelf', async () => {
  const w = world();
  order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
  order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }], { user: 'u2' });
  assert.equal((await scan(w, 'adm', 'ORD-A', 'la', 1, SN)).status, 200);
  const take = () => post(w.as('boss'), '/api/admin/orders/ORD-B/serials/override', { order_item_id: 'lb', unit_index: 1, code: SN, kind: 'take_from_order', reason: 'needed for B', op_id: op() });
  // A is out for delivery (in-house): its device left the shelf.
  w.raw.exec(`UPDATE orders SET stage = 'out_for_delivery', status = 'shipped' WHERE id = 'ORD-A'`);
  const out = await json(await take());
  assert.equal(out.code, 'OVERRIDE_UNAVAILABLE');
  assert.equal(out.details.reason, 'other_order_outside_window');
  // A is delivered and its activation has not run yet.
  w.raw.exec(`UPDATE orders SET stage = 'delivered', status = 'delivered', delivered_at = '2026-10-08T09:00:00.000Z' WHERE id = 'ORD-A'`);
  const delivered = await json(await take());
  assert.equal(delivered.details.reason, 'other_order_delivered');
  assert.equal(row(w.raw, 'SELECT order_id FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', SN)!.order_id, 'ORD-A', 'A keeps its device');
  // On the shelf, it works — and the release re-checks A's window inside the batch.
  w.raw.exec(`UPDATE orders SET stage = 'preparing', status = 'processing', delivered_at = NULL WHERE id = 'ORD-A'`);
  const ok = await take();
  assert.equal(ok.status, 200, await ok.clone().text());
});

// ------------------------------------------------------------ integrity #7

test('integrity #7: an owner\'s reason on an order the gate does not block still carries the fence — an unlink racing the move ships nothing', async () => {
  const w = world();
  order(w.raw, 'ORD-G', [{ id: 'lg', product: 'pA1' }]);
  assert.equal((await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: true, since: '2026-01-01T00:00:00.000Z' } })).status, 200);
  const s = await json(await scan(w, 'adm', 'ORD-G', 'lg', 1, SN));
  const { failing, db } = failingD1(w.raw);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((x) => /UPDATE orders\s+SET stage/.test(x.sql))) {
      w.raw.prepare("UPDATE serial_assignments SET released_at = '2026-10-08T00:00:00.000Z', release_reason = 'unlinked' WHERE id = ?").run(s.assignment_id);
    }
  };
  const r = await patch(stubApp(db, USERS.boss, mountSerialWorld), '/api/admin/orders/ORD-G/stage', { stage: 'out_for_delivery', serials_override_reason: 'customer is waiting outside' });
  assert.equal(r.status, 409, await r.clone().text());
  assert.equal((await json(r)).code, 'SERIALS_REQUIRED');
  assert.equal(row(w.raw, "SELECT stage FROM orders WHERE id = 'ORD-G'")!.stage, 'preparing');
});

// ------------------------------------------------------------ integrity #8, #9

test('integrity #8: a change on a fully allocated line is not refused SERIAL_BATCH_MISMATCH', async () => {
  const w = world();
  order(w.raw, 'ORD-L', [{ id: 'la', product: 'pA1' }]);
  lots(w, 'ORD-L', 'la');
  w.raw.exec(`
    INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, source, created_by) VALUES ('${SN}','${SN}','pA1','bulk','adm'),('${SN2}','${SN2}','pA1','bulk','adm');
    INSERT INTO stock_serial_links (serial_norm, lot_id, order_item_id, linked_by, linked_at) VALUES ('${SN}','lotA',NULL,'adm','2026-09-02'),('${SN2}','lotA',NULL,'adm','2026-09-02');
  `);
  const s = await json(await scan(w, 'adm', 'ORD-L', 'la', 1, SN));
  const c = await post(w.as('adm'), '/api/admin/orders/ORD-L/serials/change', { assignment_id: s.assignment_id, code: SN2, source: 'camera', op_id: op() });
  assert.equal(c.status, 200, await c.clone().text());
  assert.equal(row(w.raw, 'SELECT lot_id FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', SN2)!.lot_id, 'lotA');
});

test('integrity #9: a retried change or override (same op_id) after it succeeded answers the link it made — never «not found»', async () => {
  const w = world();
  order(w.raw, 'ORD-C', [{ id: 'la', product: 'pA1' }]);
  const s = await json(await scan(w, 'adm', 'ORD-C', 'la', 1, SN));
  const opId = op();
  const body = { assignment_id: s.assignment_id, code: SN2, source: 'camera', op_id: opId };
  const first = await json(await post(w.as('adm'), '/api/admin/orders/ORD-C/serials/change', body));
  const retry = await post(w.as('adm'), '/api/admin/orders/ORD-C/serials/change', body);
  assert.equal(retry.status, 200, await retry.clone().text());
  const again = await json(retry);
  assert.equal(again.outcome, 'already');
  assert.equal(again.assignment_id, first.assignment_id);
  // The owner's override by assignment id, retried.
  const ovOp = op();
  const ov = { assignment_id: first.assignment_id, code: SN3, kind: 'model_family', reason: 'label reprinted by the vendor', op_id: ovOp };
  assert.equal((await post(w.as('boss'), '/api/admin/orders/ORD-C/serials/override', ov)).status, 200);
  const ovRetry = await post(w.as('boss'), '/api/admin/orders/ORD-C/serials/override', ov);
  assert.equal(ovRetry.status, 200, await ovRetry.clone().text());
  assert.equal((await json(ovRetry)).outcome, 'already');
});

// ------------------------------------------------------------ integrity #10

test('integrity #10: a void racing a scan never leaves a live binding on a voided asset', async () => {
  const w = world();
  order(w.raw, 'ORD-V', [{ id: 'lv', product: 'pA1' }]);
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, source, created_by) VALUES ('${SN}','${SN}','pA1','bulk','boss')`);
  const { db } = failingD1(w.raw);
  // The void route reads (nothing bound), then the scan lands, then the void writes.
  let landed = false;
  const realPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (!landed && /UPDATE serial_inventory SET voided_at = strftime/.test(sql)) {
      landed = true;
      w.raw.exec(`INSERT INTO serial_assignments (id, serial_norm, serial_raw, order_id, order_item_id, order_ref, unit_index, source, idempotency_key, linked_by)
        VALUES ('sa_v','${SN}','${SN}','ORD-V','lv','ORD-V',1,'camera','scan:race-v','adm')`);
    }
    return realPrepare(sql);
  };
  const res = await post(stubApp(db, USERS.boss, mountSerialWorld), `/api/devices/admin/serial-inventory/${SN}/void`, { reason: 'label damaged' });
  assert.ok(landed);
  assert.equal((await json(res)).code, 'SERIAL_IN_USE');
  assert.equal(row(w.raw, 'SELECT voided_at FROM serial_inventory WHERE serial_norm = ?', SN)!.voided_at, null);
});

// ------------------------------------------------------------ integrity #11

test('integrity #11: an activation that cannot bind leaves the unit\'s old serial where it was — the batch is all or nothing', async () => {
  const w = world();
  order(w.raw, 'ORD-R', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-R', 'l1', 1, SN)).status, 200);
  await deliveredUndoneCancelledReopened(w, 'ORD-R');
  const u = unitOf(w, 'ORD-R');
  assert.equal((await scan(w, 'adm', 'ORD-R', 'l1', 1, SN2)).status, 200);
  // SN2 is now (wrongly, by a legacy door) on another customer's open unit.
  order(w.raw, 'ORD-O', [{ id: 'lo', product: 'pA1' }], { user: 'u2' });
  assert.equal((await stage(w, 'ORD-O', 'delivered')).status, 200);
  w.raw.exec(`INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES ('${SN2}','${SN2}','${unitOf(w, 'ORD-O').id}','boss')`);
  assert.equal((await stage(w, 'ORD-R', 'delivered')).status, 200);
  assert.equal(pointer(w, SN), u.id, 'A0 rolled back with the binding that could not be made');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.detached'"), 0);
  assert.ok(Number(row(w.raw, 'SELECT activation_attempts FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', SN2)!.activation_attempts) >= 1, 'counted as a conflict for the owner');
});

// ------------------------------------------------------------ integrity #13

test('integrity #13: whether a scan filed the asset\'s product is decided in its batch — a filing made meanwhile by another door survives the unlink', async () => {
  const w = world({ serial: true });
  order(w.raw, 'ORD-P', [{ id: 'lp', product: 'pA1' }]);
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, source, created_by) VALUES ('${SN}','${SN}',NULL,'bulk','boss')`);
  const r = await afterReadsOf(
    w,
    'adm',
    (app) => post(app, '/api/admin/orders/ORD-P/serials/scan', scanBody('lp', 1, SN)),
    () => patch(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}`, { product_id: 'pA1' })
  );
  assert.equal(r.a.status, 200, await r.a.clone().text());
  assert.equal(r.b.status, 200, await r.b.clone().text());
  const a = row<R>(w.raw, 'SELECT id, adopted_product FROM serial_assignments WHERE serial_norm = ?', SN)!;
  assert.equal(a.adopted_product, 0, 'the owner filed it, not the scan');
  assert.equal((await post(w.as('adm'), '/api/admin/orders/ORD-P/serials/unlink', { assignment_id: a.id })).status, 200);
  assert.equal(row(w.raw, 'SELECT product_id FROM serial_inventory WHERE serial_norm = ?', SN)!.product_id, 'pA1');
  // And a first scan that DID file it is still undone by its unlink (M11).
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, source, created_by) VALUES ('${SN2}','${SN2}',NULL,'bulk','boss')`);
  const s2 = await json(await scan(w, 'adm', 'ORD-P', 'lp', 1, SN2));
  assert.equal(row(w.raw, 'SELECT adopted_product FROM serial_assignments WHERE id = ?', s2.assignment_id)!.adopted_product, 1);
  assert.equal((await post(w.as('adm'), '/api/admin/orders/ORD-P/serials/unlink', { assignment_id: s2.assignment_id })).status, 200);
  assert.equal(row(w.raw, 'SELECT product_id FROM serial_inventory WHERE serial_norm = ?', SN2)!.product_id, null);
});

// ------------------------------------------------------------ integrity #14

test('integrity #14: the return inspection reads serials through the one canonicaliser; the bulk add refuses barcodes of any length and box SNs', async () => {
  const w = world();
  order(w.raw, 'ORD-RT', [{ id: 'lr', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-RT', 'lr', 1, SN)).status, 200);
  assert.equal((await stage(w, 'ORD-RT', 'delivered')).status, 200);
  const unit = unitOf(w, 'ORD-RT');
  const kase = { id: 'rc_1', order_item_id: 'lr', user_id: 'u1', qty: 1 };
  for (const typed of [`SN ${SN}`, `S/N: ${SN}`, SN.toLowerCase()]) {
    assert.deepEqual((await returnedUnits(w.db, kase, { serials: [typed] })).units, [unit.id], typed);
  }
  assert.equal(buildBulkRow(1, { serial: '036000291452' }).problem, 'SERIAL_LOOKS_LIKE_EAN', 'UPC-A');
  assert.equal(buildBulkRow(1, { serial: '96385074' }).problem, 'SERIAL_LOOKS_LIKE_EAN', 'EAN-8');
  assert.equal(buildBulkRow(1, { serial: BOX }).problem, 'SERIAL_LOOKS_LIKE_BOX');
  assert.equal(buildBulkRow(1, { serial: `SN ${SN}` }).serial_norm, SN, 'the whitespace prefix');
  assert.equal(buildBulkRow(1, { serial: SN, box_sn: BOX }).problem, null, 'a box SN in its own column is welcome');
});

// ------------------------------------------------------------ regressions #3

test('regressions #3: the owner-only placement rule reads the product\'s own category as a placement', async () => {
  const w = world();
  const doc = { id: 'pPLA', name_en: 'PLA spool', name_ar: 'خيط PLA', price_iqd: 25000, status: 'draft', category_id: 'ct_print' };
  const refused = await post(w.as('adm'), '/api/admin/products-v2', doc);
  assert.equal(refused.status, 403, await refused.clone().text());
  assert.equal((await json(refused)).code, 'OWNER_ONLY');
  w.raw.exec(`UPDATE products SET category_id = 'ct_print' WHERE id = 'pA1'`);
  const echo = await put(w.as('adm'), '/api/admin/products-v2/pA1/catalogs', { catalog_ids: ['ct_acc'] });
  assert.equal(echo.status, 200, `the category folds ct_print back in, so the answer does not change: ${await echo.clone().text()}`);
});

// ------------------------------------------------------------ UX #1, #16

test('UX #1 under owner decision 1: the serial page shows an assistant the whole serial everywhere — the row, the copy, and another device named in a change — and no order number', async () => {
  const w = world();
  order(w.raw, 'ORD-M', [{ id: 'lm', product: 'pA1' }]);
  const s = await json(await scan(w, 'adm', 'ORD-M', 'lm', 1, SN));
  assert.equal((await post(w.as('adm'), '/api/admin/orders/ORD-M/serials/change', { assignment_id: s.assignment_id, code: SN2, source: 'camera', op_id: op() })).status, 200);
  const page = await json(await get(w.as('ast'), `/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(page.row.serial, SN);
  assert.equal(page.row.serial_norm, SN);
  assert.equal(page.story.serial, SN, 'the whole serial to copy');
  const change = page.history.find((h: { action: string; detail: { reason?: string } }) => h.action === 'serial.released' && h.detail.reason === 'changed');
  assert.equal(change.detail.new_serial, SN2, 'the other device named whole');
  assert.ok(!JSON.stringify(page).includes('ORD-M'), 'no order number anywhere in the assistant\'s answer');
  const boss = await json(await get(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(boss.row.serial, SN, 'the owner sees it whole');
  assert.ok(JSON.stringify(boss).includes('ORD-M'), 'and the order number');
});

test('UX #16: an assistant re-links a re-opened order\'s previous serial by its binding — the client never sends the serial', async () => {
  const w = world();
  order(w.raw, 'ORD-RL', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-RL', 'l1', 1, SN)).status, 200);
  assert.equal((await stage(w, 'ORD-RL', 'cancelled')).status, 200);
  assert.equal((await stage(w, 'ORD-RL', 'confirmed')).status, 200);
  assert.equal((await stage(w, 'ORD-RL', 'preparing')).status, 200);
  const view = await json(await get(w.as('ast'), '/api/admin/orders/ORD-RL/serials'));
  const prev = view.serials.slots[0].previous;
  assert.equal(prev.serial_full, SN, 'owner decision 1: the assistant sees it whole');
  assert.ok(prev.assignment_id);
  const relink = await post(w.as('ast'), '/api/admin/orders/ORD-RL/serials/scan', { order_item_id: 'l1', unit_index: 1, previous_assignment_id: prev.assignment_id, op_id: op() });
  assert.equal(relink.status, 200, await relink.clone().text());
  const res = await json(relink);
  assert.equal(res.outcome, 'existing');
  assert.equal(res.slot.assignment.serial_display, SN);
  assert.equal(res.slot.assignment.source, 'relink');
  // Another order's binding is not a way to name a serial.
  order(w.raw, 'ORD-OT', [{ id: 'lo', product: 'pA1' }], { user: 'u2' });
  const foreign = await post(w.as('ast'), '/api/admin/orders/ORD-OT/serials/scan', { order_item_id: 'lo', unit_index: 1, previous_assignment_id: prev.assignment_id, op_id: op() });
  assert.equal((await json(foreign)).code, 'SERIAL_ASSIGNMENT_NOT_FOUND');
});

// ------------------------------------------------------------ the screens (UX review #2–#17)
// No DOM runner in this repository (tests/serialPrepUi.test.ts header): the
// words are run, and the source carries each behaviour the review asked for.

const src = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

test('UX #2/#3/#4/#5/#7/#8/#13: focus never falls to the page, a stale «go to unit» never replays, a second burst waits, warnings stay until «تم»', () => {
  const slots = src('src/components/adminOrders/serials/UnitSerialSlots.tsx');
  assert.ok(slots.includes('(inputs.current.get(key) ?? rows.current.get(key))?.focus()'), '#2 the field, else the row — not both');
  assert.ok(!slots.includes('inputs.current.get(key)?.focus() ?? rows.current.get(key)?.focus()'));
  assert.match(slots, /focusHandled\.current\?\.\(\)/, '#4 the request is handed back once carried out');
  assert.match(slots, /behavior: motionPrefs\.reduced \? 'auto' : 'smooth'/, '#13 the one JS scroll honours reduced motion');
  assert.match(slots, /queuedRead\.current = \{ from: key, text: r\.text, source: r\.source \}/, '#5 a reader burst during the check is kept');
  assert.match(slots, /toast\.info\(s\.queuedDropped/, '#5 and said, when it cannot be placed');
  assert.match(slots, /applyLink\(res, read, true\)/, '#7 the sheet\'s own verdict is not toasted twice');
  const sheet = src('src/components/adminOrders/serials/SerialScanSheet.tsx');
  assert.match(sheet, /if \(res\.warnings\.length === 0\) closeTimer\.current = window\.setTimeout\(onClose/, '#7 a warning keeps the sheet open');
  assert.match(sheet, /data-serial-done/);
  assert.match(sheet, /setOverrideOpen\(!!initialRefusal\)/, '#8 the exception opens in one tap');
  for (const ref of ['scanAgainRef', 'reasonRef', 'overrideBtnRef', 'useReaderRef', 'refocusTyped']) assert.ok(sheet.includes(`${ref}.current`), `#3 ${ref}`);
  assert.match(src('src/components/adminOrders/OrderDetailModal.tsx'), /onFocusHandled=\{clearFocusRequest\}/);
});

test('UX #6/#9/#10/#11/#12/#17: the §31 sentence, names that start with what is shown, and something to hear for every glyph', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = SERIAL_STRINGS[lang];
    assert.ok(s.openCamera('A1', 1).startsWith(s.scanSerial), `${lang} #9 the camera button's name starts with its words`);
    assert.ok(s.openCamera('A1', 1).startsWith(s.scanShort), `${lang} #9 also on a narrow phone`);
    for (const k of ['notLinked', 'done', 'queuedDropped'] as const) assert.ok(s[k].trim(), `${lang}.${k}`);
    assert.ok(s.endingIn('7841').includes('7841'));
  }
  for (const k of ['notLinked', 'done', 'queuedDropped'] as const) {
    assert.notEqual(SERIAL_STRINGS.ckb[k], SERIAL_STRINGS.ar[k], `ckb.${k} is not the Arabic`);
    assert.notEqual(SERIAL_STRINGS.ckb[k], SERIAL_STRINGS.en[k], `ckb.${k} is not the English`);
  }
  const sheet = src('src/components/adminOrders/serials/SerialScanSheet.tsx');
  const slots = src('src/components/adminOrders/serials/UnitSerialSlots.tsx');
  assert.match(sheet, /refusalText\('SERIAL_EXISTING_LINKED'/, '#6 the sheet says §31\'s sentence');
  assert.match(slots, /refusalText\('SERIAL_EXISTING_LINKED'/, '#6 and so does the toast');
  assert.equal(REFUSAL_STRINGS.SERIAL_EXISTING_LINKED.ar, 'الرقم موجود مسبقاً وتم ربطه بهذا الطلب.');
  assert.match(slots, /className="sr-only min-\[400px\]:hidden">\{s\.linking\}/, '#10 the busy word is heard on a phone');
  assert.match(slots, /\{s\.notLinked\}/, '#11 an empty unit is not a bare dash');
  assert.match(slots, /s\.endingIn\(masked\[1\]\)/, '#11 a masked serial is read as its last digits');
  for (const f of ['src/components/adminOrders/serials/SerialsBlockerCard.tsx', 'src/components/adminOrders/serials/SerialGateRefusal.tsx']) {
    assert.match(src(f), /aria-label=\{`\$\{s\.goToUnit\} · \$\{missingLabel\(m, lang\)\}`\}/, `#12 ${f}`);
  }
  assert.match(src('src/components/adminOrders/OrderBoardRow.tsx'), /aria-label=\{`\$\{sl\(loc, 'boardChip'\)\}/, '#9 the board chip');
  assert.match(slots, /\$\{HIT_44\}/, '#17 «أعد ربطه» and the exception take a 44 px tap');
  assert.match(src('src/components/adminOrders/OrderDetailModal.tsx'), /before:-inset-y-1\.5/, '#17 the line chip too');
  assert.match(src('src/components/adminWarranty/serial/SerialDetail.tsx'), /aria-describedby=\{`\$\{reasonId\}-hint`\}/, '#17 the resale reason says why «حفظ» waits');
});

test('UX #14/#15: singular and dual forms, the label quoted as the button says it, «outside the preparation stage» in every language', () => {
  const { ar, en, ckb } = SERIAL_STRINGS;
  assert.equal(en.remaining(1), '1 day left');
  assert.equal(en.remaining(5), '5 days left');
  assert.equal(ar.remaining(1), 'متبقٍ يوم واحد');
  assert.equal(ar.remaining(2), 'متبقٍ يومان');
  assert.equal(ar.remaining(5), 'متبقٍ 5 أيام');
  assert.equal(ar.remaining(30), 'متبقٍ 30 يومًا');
  assert.ok(!ar.boardChipTitle(0, 1).includes('1 وحدات'), 'no «0 من 1 وحدات»');
  assert.notEqual(ckb.missingListedAbove(1), ckb.missingListedAbove(2), 'Sorani has its singular');
  assert.ok(ckb.missingListedAbove(1).includes('ناوی هاتووە') && !ckb.missingListedAbove(1).includes('ناویان'));
  assert.ok(ckb.resaleHint.includes(`«${ckb.modeRestart}»`) && ckb.resaleHint.includes(`«${ckb.modeCarry}»`));
  assert.ok(ar.resaleHint.includes(`«${ar.modeRestart}»`) && ar.resaleHint.includes(`«${ar.modeCarry}»`));
  for (const s of [en.ownerOutsideHint, en.removeOutsideBody]) assert.match(s, /outside the preparation stage/);
  for (const s of [ckb.ownerOutsideHint, ckb.removeOutsideBody]) assert.ok(s.includes('دەرەوەی قۆناغی ئامادەکردن'));
  for (const s of [ar.ownerOutsideHint, ar.removeOutsideBody]) assert.ok(s.includes('خارج مرحلة التجهيز'));
});

test('the history names the new events in words: re-opened, detached, shipped with serials missing', async () => {
  const { eventLabel } = await import('../src/components/adminWarranty/serial/SerialDetail');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = SERIAL_STRINGS[lang];
    for (const action of ['serial.warranty_reopened', 'serial.detached', 'serial.prep_gate_breach']) {
      assert.doesNotMatch(eventLabel({ id: 1, action, created_at: '2026-10-08T10:00:00Z', actor: null, detail: {} }, s), /^[a-z_.]+$/, `${lang} ${action}`);
    }
    if (lang === 'ckb') for (const k of ['reopened', 'detached', 'gateBreach'] as const) assert.notEqual(s.action[k], SERIAL_STRINGS.ar.action[k]);
  }
});

test('UX #16 / server: a closed-unit refusal and the owner\'s new override reasons have their words', () => {
  const r = REFUSAL_STRINGS.UNIT_NOT_OPEN;
  assert.ok(r.ar && r.en && r.ckb);
  assert.notEqual(r.ckb, r.ar);
  assert.notEqual(r.ckb, r.en);
  assert.ok(src('src/components/adminOrders/serials/serialsApi.ts').includes("previous_assignment_id: r.previous_assignment_id, source: 'relink'"));
});
