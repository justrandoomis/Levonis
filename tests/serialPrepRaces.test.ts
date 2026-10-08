/**
 * Races and the preparation gate (migration 0177; owner brief §19, §24; §32
 * test 18; critique H2).
 *
 * D1 has no row locks: one serial can never hold two live bindings because
 * the partial UNIQUE indexes decide inside each batch, the window is
 * re-asserted inside the scan's own batch (S1), and the gate's count is
 * re-asserted inside the stage flip's own batch. These tests run the real
 * routes concurrently, and inject the competing write between a door's
 * pre-read and its batch where a real race would land.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, put, get, row, count, all, stubApp, failingD1 } from './fixtures/app';
import { world, order, op, SN, SN2, USERS } from './fixtures/serialPrep';
import { adminOrderSerialRoutes } from '../worker/routes/adminOrderSerials';
import { adminRoutes } from '../worker/routes/admin';
import { deleteCancelledOrder } from '../worker/lib/orderDeletion';

type W = ReturnType<typeof world>;
const scanBody = (item: string, unit: number, code: string, opId = op()) => ({ order_item_id: item, unit_index: unit, code, source: 'camera', op_id: opId });

test('§32.18/§24 two staff, one serial, two orders, at the same moment: exactly one wins', async () => {
  const w = world({ serial: true });
  order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
  order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }]);
  const [r1, r2] = await Promise.all([
    post(w.as('adm'), '/api/admin/orders/ORD-A/serials/scan', scanBody('la', 1, SN)),
    post(w.as('boss'), '/api/admin/orders/ORD-B/serials/scan', scanBody('lb', 1, SN)),
  ]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [200, 409]);
  const loser = (await json(r1.status === 409 ? r1 : r2)).code;
  assert.equal(loser, 'SERIAL_IN_USE');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', SN), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 1, 'a first-ever serial scanned twice is ONE asset');
});

test('§24 one unit, two serials, two devices: one link, the other UNIT_ALREADY_LINKED', async () => {
  const w = world({ serial: true });
  order(w.raw, 'ORD-U', [{ id: 'l1', product: 'pA1' }]);
  const [r1, r2] = await Promise.all([
    post(w.as('adm'), '/api/admin/orders/ORD-U/serials/scan', scanBody('l1', 1, SN)),
    post(w.as('adm'), '/api/admin/orders/ORD-U/serials/scan', scanBody('l1', 1, SN2)),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal((await json(r1.status === 409 ? r1 : r2)).code, 'UNIT_ALREADY_LINKED');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_item_id = 'l1' AND released_at IS NULL"), 1);
});

test('§24 a double tap (same op_id) and the same account on two devices: one row, then `already`', async () => {
  const w = world({ serial: true });
  order(w.raw, 'ORD-T', [{ id: 'l1', product: 'pA1' }]);
  const id = op();
  const [r1, r2] = await Promise.all([
    post(w.as('adm'), '/api/admin/orders/ORD-T/serials/scan', scanBody('l1', 1, SN, id)),
    post(w.as('adm'), '/api/admin/orders/ORD-T/serials/scan', scanBody('l1', 1, SN, id)),
  ]);
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  assert.deepEqual([(await json(r1)).outcome, (await json(r2)).outcome].sort(), ['already', 'created']);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 1);
  // The same op_id for different content is not a replay.
  const other = await post(w.as('adm'), '/api/admin/orders/ORD-T/serials/scan', scanBody('l1', 1, SN2, id));
  assert.equal((await json(other)).code, 'IDEMPOTENCY_MISMATCH');
  // M10: a replay after the link was removed says so — never a false «linked».
  const assignment = row<{ id: string }>(w.raw, 'SELECT id FROM serial_assignments')!.id;
  await post(w.as('adm'), '/api/admin/orders/ORD-T/serials/unlink', { assignment_id: assignment });
  assert.equal((await json(await post(w.as('adm'), '/api/admin/orders/ORD-T/serials/scan', scanBody('l1', 1, SN, id)))).code, 'SERIAL_LINK_RELEASED');
});

test('§24 scan against cancel: cancel first → the scan is refused; scan first → the cancel releases it', async () => {
  const w = world();
  order(w.raw, 'ORD-C1', [{ id: 'l1', product: 'pA1' }]);
  order(w.raw, 'ORD-C2', [{ id: 'l2', product: 'pA1' }]);
  await patch(w.as('adm'), '/api/admin/orders/ORD-C1/stage', { stage: 'cancelled' });
  assert.equal((await json(await post(w.as('adm'), '/api/admin/orders/ORD-C1/serials/scan', scanBody('l1', 1, SN)))).code, 'ORDER_NOT_PREPARABLE');
  assert.equal((await post(w.as('adm'), '/api/admin/orders/ORD-C2/serials/scan', scanBody('l2', 1, SN))).status, 200);
  await patch(w.as('adm'), '/api/admin/orders/ORD-C2', { status: 'cancelled' });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE released_at IS NULL'), 0);
});

test('§24 a stage change that lands between the scan\'s read and its batch aborts the scan (S1 inside the batch)', async () => {
  const w = world();
  order(w.raw, 'ORD-S', [{ id: 'l1', product: 'pA1' }]);
  const { failing, db } = failingD1(w.raw);
  failing.beforeBatch = (s) => {
    if (s.some((x) => /INSERT INTO serial_assignments/.test(x.sql))) {
      w.raw.exec(`UPDATE orders SET stage = 'out_for_delivery', status = 'shipped' WHERE id = 'ORD-S'`);
    }
  };
  const app = stubApp(db, USERS.adm, (a) => a.route('/api/admin/orders', adminOrderSerialRoutes));
  const r = await post(app, '/api/admin/orders/ORD-S/serials/scan', scanBody('l1', 1, SN));
  assert.equal(r.status, 409);
  assert.equal((await json(r)).code, 'ORDER_NOT_PREPARABLE');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory'), 0, 'nothing of the batch survived');
});

// ------------------------------------------------------------------ the gate (§19)

async function enableGate(w: W, since?: string) {
  const r = await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: true, ...(since ? { since } : {}) } });
  assert.equal(r.status, 200, await r.clone().text());
}

test('§19 the gate ships OFF; switching it is the owner\'s; on, it stamps a cutover', async () => {
  const w = world();
  order(w.raw, 'ORD-G0', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-G0/stage', { stage: 'out_for_delivery' })).status, 200, 'off: nothing is blocked');
  const refused = await put(w.as('adm'), '/api/admin/settings/serialPrepGate', { value: { enabled: true } });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'OWNER_ONLY');
  await enableGate(w);
  const stored = JSON.parse(row<{ value: string }>(w.raw, "SELECT value FROM admin_settings WHERE key = 'serialPrepGate'")!.value);
  assert.equal(stored.enabled, true);
  assert.ok(Date.parse(stored.since) > 0, 'orders already in flight are never blocked');
});

test('§19 every hand-over door refuses with the missing units; the owner may override with a reason, audited in the move', async () => {
  const w = world();
  await enableGate(w, '2026-01-01T00:00:00.000Z');
  order(w.raw, 'ORD-G', [{ id: 'l1', product: 'pA1', qty: 2 }, { id: 'lp', product: 'pPLA' }]);
  await post(w.as('adm'), '/api/admin/orders/ORD-G/serials/scan', scanBody('l1', 1, SN));
  const stage = await patch(w.as('adm'), '/api/admin/orders/ORD-G/stage', { stage: 'out_for_delivery' });
  const body = await json(stage);
  assert.equal(stage.status, 409);
  assert.equal(body.code, 'SERIALS_REQUIRED');
  assert.equal(body.error, 'تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.');
  assert.deepEqual(body.details.missing.map((m: { order_item_id: string; unit_index: number }) => `${m.order_item_id}:${m.unit_index}`), ['l1:2']);
  const legacy = await patch(w.as('adm'), '/api/admin/orders/ORD-G', { status: 'shipped' });
  assert.equal((await json(legacy)).code, 'SERIALS_REQUIRED');
  assert.equal(row(w.raw, "SELECT status FROM orders WHERE id = 'ORD-G'")!.status, 'processing');
  const detail = await json(await get(w.as('adm'), '/api/admin/orders/ORD-G'));
  assert.equal(detail.order.serials.gate.applies, true);
  assert.equal(detail.order.serials.missing.length, 1);

  // The override: owner only, a reason, and the audit row rides the move.
  const notOwner = await patch(w.as('adm'), '/api/admin/orders/ORD-G/stage', { stage: 'out_for_delivery', serials_override_reason: 'courier waiting' });
  assert.equal((await json(notOwner)).code, 'OWNER_ONLY');
  const ok = await patch(w.as('boss'), '/api/admin/orders/ORD-G/stage', { stage: 'out_for_delivery', serials_override_reason: 'second unit shipped sealed' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.prep_gate_override' AND target = 'ORD-G'")!.detail);
  assert.equal(audit.reason, 'second unit shipped sealed');
  // H2: once out, staff can no longer change serials.
  assert.equal((await json(await post(w.as('adm'), '/api/admin/orders/ORD-G/serials/scan', scanBody('l1', 2, SN2)))).code, 'ORDER_NOT_PREPARABLE');
  // Backward corrections are never gated.
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-G/stage', { stage: 'preparing' })).status, 200);
});

test('§19 the cutover and a fully linked order pass; an unlink between the door\'s read and the flip is caught INSIDE the move (H2)', async () => {
  const w = world();
  await enableGate(w, '2026-06-01T00:00:00.000Z');
  order(w.raw, 'ORD-OLD', [{ id: 'lo', product: 'pA1' }], { created_at: '2026-05-01T00:00:00.000Z' });
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-OLD/stage', { stage: 'out_for_delivery' })).status, 200, 'before the cutover: never blocked');

  order(w.raw, 'ORD-F', [{ id: 'l1', product: 'pA1' }]);
  const linked = await json(await post(w.as('adm'), '/api/admin/orders/ORD-F/serials/scan', scanBody('l1', 1, SN)));
  const { failing, db } = failingD1(w.raw);
  failing.beforeBatch = (s) => {
    if (s.some((x) => /UPDATE orders\s+SET stage/.test(x.sql))) {
      w.raw.prepare("UPDATE serial_assignments SET released_at = '2026-10-07T00:00:00.000Z', release_reason = 'unlinked' WHERE id = ?").run(linked.assignment_id);
    }
  };
  const app = stubApp(db, USERS.adm, (a) => a.route('/api/admin', adminRoutes));
  const r = await patch(app, '/api/admin/orders/ORD-F/stage', { stage: 'out_for_delivery' });
  assert.equal(r.status, 409, await r.clone().text());
  assert.equal((await json(r)).code, 'SERIALS_REQUIRED');
  assert.equal(row(w.raw, "SELECT stage FROM orders WHERE id = 'ORD-F'")!.stage, 'preparing', 'nothing moved');
});

test('order deletion keeps a cancelled order\'s serial history (unlinked, order_ref kept) and refuses while a binding is live', async () => {
  const w = world();
  order(w.raw, 'ORD-DEL', [{ id: 'l1', product: 'pA1' }]);
  await post(w.as('adm'), '/api/admin/orders/ORD-DEL/serials/scan', scanBody('l1', 1, SN));
  await patch(w.as('adm'), '/api/admin/orders/ORD-DEL/stage', { stage: 'cancelled' });
  // A live row cannot exist on a cancelled order (the trigger); forced here to prove the second guard.
  w.raw.exec(`UPDATE serial_assignments SET released_at = NULL, release_reason = NULL WHERE order_id = 'ORD-DEL'`);
  await assert.rejects(deleteCancelledOrder(w.db as never, 'ORD-DEL'), /ORDER_HAS_FULFILMENT_HISTORY|serial/i);
  w.raw.exec(`UPDATE serial_assignments SET released_at = '2026-10-07T00:00:00.000Z', release_reason = 'order_cancelled' WHERE order_id = 'ORD-DEL'`);
  const res = await deleteCancelledOrder(w.db as never, 'ORD-DEL');
  assert.equal(res.deleted, true);
  const kept = all<Record<string, unknown>>(w.raw, 'SELECT order_id, order_item_id, order_ref FROM serial_assignments');
  assert.deepEqual(kept, [{ order_id: null, order_item_id: null, order_ref: 'ORD-DEL' }]);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 1);
});
