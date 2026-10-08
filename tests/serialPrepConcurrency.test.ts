/**
 * RACES FROM MORE THAN ONE DEVICE (serial scan; owner brief §24, §32 test 18;
 * critique-2 H2, M14, L13) — real routes, run concurrently over the
 * single-writer D1 adapter (tests/fixtures/serialD1.ts), so requests
 * interleave between every read and every batch exactly as two phones and a
 * USB scanner would against the live database.
 *
 * Each test states the invariant that must survive EVERY interleaving rather
 * than one lucky order: one live binding per serial and per unit, one asset
 * per device, no live binding on a cancelled order, no order leaving with a
 * missing serial while the gate is on.
 *
 * Run: node --import tsx --test tests/serialPrepConcurrency.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, put, row, count, all } from './fixtures/app';
import { world, order, op, SN, SN2, afterReadsOf } from './fixtures/serialPrep';
import { createUnitsOnDelivery } from '../worker/lib/deviceOps';
import { sweepUnactivatedSerials, activateOrderSerials } from '../worker/lib/serialAssignments';

type W = ReturnType<typeof world>;
type Who = 'boss' | 'adm' | 'ast';
const scanBody = (item: string, unit: number, code: string, opId = op()) => ({ order_item_id: item, unit_index: unit, code, source: 'camera', op_id: opId });
const scan = (w: W, who: Who, o: string, item: string, unit: number, code: string, opId?: string) =>
  post(w.as(who), `/api/admin/orders/${o}/serials/scan`, scanBody(item, unit, code, opId));
const liveOf = (w: W, serial: string) => count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', serial);

test('§32.18/§24 five devices, five orders, one never-seen serial at the same instant: exactly one wins, ONE asset, the rest hear SERIAL_IN_USE', async () => {
  const w = world({ serial: true });
  const who: Who[] = ['adm', 'ast', 'boss', 'adm', 'ast'];
  for (let i = 1; i <= 5; i++) order(w.raw, `ORD-R${i}`, [{ id: `l${i}`, product: 'pA1' }]);
  const res = await Promise.all(who.map((u, i) => scan(w, u, `ORD-R${i + 1}`, `l${i + 1}`, 1, SN)));
  const statuses = res.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409, 409]);
  const bodies = await Promise.all(res.map((r) => json(r)));
  assert.ok(bodies.filter((b) => !b.success).every((b) => b.code === 'SERIAL_IN_USE'), JSON.stringify(bodies.map((b) => b.code)));
  assert.equal(bodies.find((b) => b.success)!.outcome, 'created');
  assert.equal(liveOf(w, SN), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 1, 'one device, one asset row');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial_inventory.add' AND target = ?", SN), 1, 'and one «added to system» line');
});

test('§24 two devices scan the SAME serial into the SAME unit at once (two reads, two op_ids): one link, and both are told it is linked', async () => {
  const w = world({ serial: true });
  order(w.raw, 'ORD-SAME', [{ id: 'l1', product: 'pA1' }]);
  const [a, b] = await Promise.all([scan(w, 'adm', 'ORD-SAME', 'l1', 1, SN), scan(w, 'ast', 'ORD-SAME', 'l1', 1, SN)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const outcomes = [(await json(a)).outcome, (await json(b)).outcome].sort();
  assert.deepEqual(outcomes, ['already', 'created']);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 1);
});

test('§24 both read the same state before either writes — the partial unique indexes decide: two orders, one unit, one slot', async () => {
  // Same serial, two orders: B passed its pre-read before A linked it.
  {
    const w = world({ serial: true });
    order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
    order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }]);
    const r = await afterReadsOf(w, 'ast', (app) => post(app, '/api/admin/orders/ORD-B/serials/scan', scanBody('lb', 1, SN)), () => scan(w, 'adm', 'ORD-A', 'la', 1, SN));
    assert.ok(r.bReachedBatch, 'B really got past its reads');
    assert.equal(r.a.status, 200);
    assert.equal(r.b.status, 409);
    assert.equal((await json(r.b)).code, 'SERIAL_IN_USE', 'the honest reason, re-read after the index refused');
    assert.equal(liveOf(w, SN), 1);
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory'), 1, 'and one asset, though both inserted it');
  }
  // One unit, two serials.
  {
    const w = world({ serial: true });
    order(w.raw, 'ORD-U', [{ id: 'l1', product: 'pA1' }]);
    const r = await afterReadsOf(w, 'adm', (app) => post(app, '/api/admin/orders/ORD-U/serials/scan', scanBody('l1', 1, SN2)), () => scan(w, 'ast', 'ORD-U', 'l1', 1, SN));
    assert.equal(r.a.status, 200);
    assert.equal((await json(r.b)).code, 'UNIT_ALREADY_LINKED');
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_item_id = 'l1' AND released_at IS NULL"), 1);
  }
  // The same serial into the same unit from two devices: the second is told it is linked.
  {
    const w = world({ serial: true });
    order(w.raw, 'ORD-S', [{ id: 'l1', product: 'pA1' }]);
    const r = await afterReadsOf(w, 'adm', (app) => post(app, '/api/admin/orders/ORD-S/serials/scan', scanBody('l1', 1, SN)), () => scan(w, 'ast', 'ORD-S', 'l1', 1, SN));
    assert.equal((await json(r.b)).outcome, 'already');
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 1);
  }
});

test('§24 scan and cancel racing, in both orders: no live binding ever survives on a cancelled order; the asset is kept', async () => {
  // Concurrently, as it happens.
  {
    const w = world({ serial: true });
    order(w.raw, 'ORD-X', [{ id: 'l1', product: 'pA1' }]);
    await Promise.all([patch(w.as('adm'), '/api/admin/orders/ORD-X/stage', { stage: 'cancelled' }), scan(w, 'ast', 'ORD-X', 'l1', 1, SN)]);
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_id = 'ORD-X' AND released_at IS NULL"), 0);
  }
  // The scan read the order in the window, then the cancel landed: S1, inside the scan's batch, refuses.
  {
    const w = world({ serial: true });
    order(w.raw, 'ORD-X', [{ id: 'l1', product: 'pA1' }]);
    const r = await afterReadsOf(w, 'ast', (app) => post(app, '/api/admin/orders/ORD-X/serials/scan', scanBody('l1', 1, SN)), () => patch(w.as('adm'), '/api/admin/orders/ORD-X/stage', { stage: 'cancelled' }));
    assert.ok(r.bReachedBatch);
    assert.equal(r.a.status, 200, await r.a.clone().text());
    assert.equal(r.b.status, 409);
    assert.equal((await json(r.b)).code, 'ORDER_NOT_PREPARABLE');
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0);
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory'), 0, 'nothing of the scan survived');
  }
  // The cancel read the order, then the scan landed: the cancel's own flip fires the trigger, which releases it.
  {
    const w = world({ serial: true });
    order(w.raw, 'ORD-X', [{ id: 'l1', product: 'pA1' }]);
    const r = await afterReadsOf(w, 'adm', (app) => patch(app, '/api/admin/orders/ORD-X/stage', { stage: 'cancelled' }), () => scan(w, 'ast', 'ORD-X', 'l1', 1, SN));
    assert.ok(r.bReachedBatch);
    assert.equal(r.a.status, 200);
    assert.equal(r.b.status, 200, await r.b.clone().text());
    assert.equal(row(w.raw, "SELECT status FROM orders WHERE id = 'ORD-X'")!.status, 'cancelled');
    assert.equal(row(w.raw, "SELECT release_reason FROM serial_assignments WHERE order_id = 'ORD-X'")!.release_reason, 'order_cancelled');
    assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'serial.released' AND target = ?", SN), 'audited');
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 1, 'the asset is kept');
  }
});

test('§24 scan during a status change: linked before the move, or refused — never a binding written after the parcel left', async () => {
  // The scan read «preparing»; the move landed first.
  {
    const w = world({ serial: true });
    order(w.raw, 'ORD-Y', [{ id: 'l1', product: 'pA1' }]);
    const r = await afterReadsOf(w, 'ast', (app) => post(app, '/api/admin/orders/ORD-Y/serials/scan', scanBody('l1', 1, SN)), () => patch(w.as('adm'), '/api/admin/orders/ORD-Y/stage', { stage: 'out_for_delivery' }));
    assert.equal(r.a.status, 200);
    assert.equal((await json(r.b)).code, 'ORDER_NOT_PREPARABLE');
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0);
  }
  // The move read the order; the scan landed first: the link predates the move.
  {
    const w = world({ serial: true });
    order(w.raw, 'ORD-Y', [{ id: 'l1', product: 'pA1' }]);
    const r = await afterReadsOf(w, 'adm', (app) => patch(app, '/api/admin/orders/ORD-Y/stage', { stage: 'out_for_delivery' }), () => scan(w, 'ast', 'ORD-Y', 'l1', 1, SN));
    assert.equal(r.a.status, 200);
    assert.equal(r.b.status, 200, await r.b.clone().text());
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_id = 'ORD-Y' AND released_at IS NULL"), 1);
  }
});

test('§20/§24 change and remove on the same link racing, both ways: one wins; the unit never holds two serials', async () => {
  const setup = async () => {
    const w = world({ serial: true });
    order(w.raw, 'ORD-CU', [{ id: 'l1', product: 'pA1' }]);
    const first = await json(await scan(w, 'adm', 'ORD-CU', 'l1', 1, SN));
    const change = (app = w.as('adm')) => post(app, '/api/admin/orders/ORD-CU/serials/change', { assignment_id: first.assignment_id, code: SN2, source: 'scanner', op_id: op() });
    const unlink = (app = w.as('ast')) => post(app, '/api/admin/orders/ORD-CU/serials/unlink', { assignment_id: first.assignment_id });
    const liveSerials = () => all<{ serial_norm: string }>(w.raw, "SELECT serial_norm FROM serial_assignments WHERE order_item_id = 'l1' AND released_at IS NULL").map((x) => x.serial_norm);
    const reason = () => row<{ release_reason: string }>(w.raw, 'SELECT release_reason FROM serial_assignments WHERE id = ?', first.assignment_id)!.release_reason;
    return { w, change, unlink, liveSerials, reason };
  };
  // The change read the link; the remove landed first.
  {
    const t = await setup();
    const r = await afterReadsOf(t.w, 'adm', (app) => t.change(app), () => t.unlink());
    assert.ok(r.bReachedBatch);
    assert.equal(r.a.status, 200);
    assert.equal(r.b.status, 409);
    assert.equal((await json(r.b)).code, 'SERIAL_RACE', '«the order changed while you scanned — try again»');
    assert.equal(t.reason(), 'unlinked');
    assert.deepEqual(t.liveSerials(), []);
    assert.equal(count(t.w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE serial_norm = ?', SN2), 0, 'the half-made change left nothing');
  }
  // The remove read the link; the change landed first.
  {
    const t = await setup();
    const r = await afterReadsOf(t.w, 'ast', (app) => t.unlink(app), () => t.change());
    assert.equal(r.a.status, 200);
    const b = await json(r.b);
    assert.equal(b.already, true, 'the link it meant to remove is gone — and the new one is not touched');
    assert.equal(t.reason(), 'changed');
    assert.deepEqual(t.liveSerials(), [SN2]);
  }
});

test('H2 remove and the gated move racing, both ways: exactly one happens — the order never leaves with a missing serial', async () => {
  const setup = async () => {
    const w = world({ serial: true });
    await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: true, since: '2026-01-01T00:00:00.000Z' } });
    order(w.raw, 'ORD-G', [{ id: 'l1', product: 'pA1' }]);
    const a = await json(await scan(w, 'adm', 'ORD-G', 'l1', 1, SN));
    return {
      w,
      unlink: (app = w.as('ast')) => post(app, '/api/admin/orders/ORD-G/serials/unlink', { assignment_id: a.assignment_id }),
      move: (app = w.as('adm')) => patch(app, '/api/admin/orders/ORD-G/stage', { stage: 'out_for_delivery' }),
      state: () => ({
        moved: row<{ stage: string }>(w.raw, "SELECT stage FROM orders WHERE id = 'ORD-G'")!.stage === 'out_for_delivery',
        linked: count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_id = 'ORD-G' AND released_at IS NULL") === 1,
      }),
    };
  };
  // The move read a linked order; the remove landed first: the fence inside the flip refuses.
  {
    const t = await setup();
    const r = await afterReadsOf(t.w, 'adm', (app) => t.move(app), () => t.unlink());
    assert.ok(r.bReachedBatch);
    assert.equal(r.a.status, 200);
    assert.equal(r.b.status, 409);
    assert.equal((await json(r.b)).code, 'SERIALS_REQUIRED');
    assert.deepEqual(t.state(), { moved: false, linked: false });
  }
  // The remove read an order in the window; the move landed first: the remove's own fence refuses.
  {
    const t = await setup();
    const r = await afterReadsOf(t.w, 'ast', (app) => t.unlink(app), () => t.move());
    assert.equal(r.a.status, 200);
    assert.equal((await json(r.b)).code, 'ORDER_NOT_PREPARABLE');
    assert.deepEqual(t.state(), { moved: true, linked: true });
  }
  // And concurrently, as it happens.
  {
    const t = await setup();
    const [u, m] = await Promise.all([t.unlink(), t.move()]);
    assert.equal([u.status, m.status].filter((s) => s === 200).length, 1);
    const st = t.state();
    assert.ok(!(st.moved && !st.linked), 'never moved without its serial');
  }
});

test('L13/M14 the owner takes a serial from one order while staff scan it into another, both ways: one binding, never two', async () => {
  const setup = () => {
    const w = world({ serial: true });
    order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
    order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }]);
    order(w.raw, 'ORD-C', [{ id: 'lc', product: 'pA1' }]);
    const take = (app = w.as('boss')) =>
      post(app, '/api/admin/orders/ORD-B/serials/override', { order_item_id: 'lb', unit_index: 1, code: SN, kind: 'take_from_order', reason: 'urgent customer, A re-picked', op_id: op() });
    const staff = (app = w.as('adm')) => post(app, '/api/admin/orders/ORD-C/serials/scan', scanBody('lc', 1, SN));
    return { w, take, staff };
  };
  {
    const t = setup();
    await scan(t.w, 'adm', 'ORD-A', 'la', 1, SN);
    const [ov, st] = await Promise.all([t.take(), t.staff()]);
    assert.equal(ov.status, 200, await ov.clone().text());
    assert.equal((await json(st)).code, 'SERIAL_IN_USE', 'the release and the new binding are one batch: staff never see a gap');
    assert.equal(liveOf(t.w, SN), 1);
    assert.equal(row(t.w.raw, 'SELECT order_id FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', SN)!.order_id, 'ORD-B');
    // L13: an order already with the courier is never stripped by the owner's take.
    t.w.raw.exec(`UPDATE orders SET delivery_remote_id = 'AW-9' WHERE id = 'ORD-B'`);
    const strip = await json(await post(t.w.as('boss'), '/api/admin/orders/ORD-C/serials/override', { order_item_id: 'lc', unit_index: 1, code: SN, kind: 'take_from_order', reason: 'try to take it back', op_id: op() }));
    assert.equal(strip.code, 'OVERRIDE_UNAVAILABLE');
    assert.equal(strip.details.reason, 'other_order_shipped');
  }
  // The serial was free when staff read it; the owner took it for ORD-B first.
  {
    const t = setup();
    const r = await afterReadsOf(t.w, 'adm', (app) => t.staff(app), () => t.take());
    assert.equal(r.a.status, 200, await r.a.clone().text());
    assert.equal((await json(r.b)).code, 'SERIAL_IN_USE');
    assert.equal(liveOf(t.w, SN), 1);
  }
  // The owner read ORD-A holding it; staff could not take it meanwhile; the owner's batch lands as read.
  {
    const t = setup();
    await scan(t.w, 'adm', 'ORD-A', 'la', 1, SN);
    const r = await afterReadsOf(t.w, 'boss', (app) => t.take(app), () => t.staff());
    assert.equal((await json(r.a)).code, 'SERIAL_IN_USE');
    assert.equal(r.b.status, 200, await r.b.clone().text());
    assert.equal(liveOf(t.w, SN), 1);
  }
  // ORD-A was cancelled after the owner read it holding the serial: the take's
  // release finds nothing to release, so its batch refuses rather than guess —
  // «try again», and the retry is an ordinary link of a now-free serial.
  {
    const t = setup();
    await scan(t.w, 'adm', 'ORD-A', 'la', 1, SN);
    const r = await afterReadsOf(t.w, 'boss', (app) => t.take(app), () => patch(t.w.as('adm'), '/api/admin/orders/ORD-A/stage', { stage: 'cancelled' }));
    assert.equal(r.a.status, 200);
    assert.equal(r.b.status, 409);
    assert.equal((await json(r.b)).code, 'SERIAL_RACE');
    assert.equal(liveOf(t.w, SN), 0, 'nothing half-done');
    const retry = await t.take();
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal(liveOf(t.w, SN), 1);
  }
});

test('§24 a double tap on «change» (one op_id, sent twice at once): one new link, the old one released once', async () => {
  const w = world({ serial: true });
  order(w.raw, 'ORD-DT', [{ id: 'l1', product: 'pA1' }]);
  const first = await json(await scan(w, 'adm', 'ORD-DT', 'l1', 1, SN));
  const id = op();
  const body = { assignment_id: first.assignment_id, code: SN2, source: 'scanner', op_id: id };
  const [a, b] = await Promise.all([post(w.as('adm'), '/api/admin/orders/ORD-DT/serials/change', body), post(w.as('adm'), '/api/admin/orders/ORD-DT/serials/change', body)]);
  const codes = [a.status, b.status];
  assert.ok(codes.includes(200), JSON.stringify(codes));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_item_id = 'l1' AND released_at IS NULL"), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE serial_norm = ?', SN2), 1, 'one new link');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.released' AND target = ?", SN), 1, 'the old one released once');
});

test('§8/§24 delivery, the courier replay and the cron activating at the same instant: ONE device_serials row, ONE activation line', async () => {
  const w = world({ serial: true });
  order(w.raw, 'ORD-ACT', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  await scan(w, 'adm', 'ORD-ACT', 'l1', 1, SN);
  await scan(w, 'adm', 'ORD-ACT', 'l1', 2, SN2);
  // The order flips to delivered by a door that does not run the effects (the courier's report lands mid-sweep).
  w.raw.exec(`UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = '2026-10-07T12:00:00.000Z' WHERE id = 'ORD-ACT'`);
  const results = await Promise.all([
    createUnitsOnDelivery(w.env, 'ORD-ACT', '2026-10-07T12:00:00.000Z'),
    sweepUnactivatedSerials(w.env, 10),
    activateOrderSerials(w.env, 'ORD-ACT'),
    createUnitsOnDelivery(w.env, 'ORD-ACT', '2026-10-07T12:00:00.000Z'),
  ]);
  assert.ok(results.every(Boolean));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_item_units WHERE order_id = 'ORD-ACT'"), 2);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM device_serials'), 2);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_id = 'ORD-ACT' AND activated_at IS NOT NULL"), 2);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.warranty_activated'"), 2, 'one activation line per device, whoever got there first');
  const pairs = all<{ serial_norm: string; unit_index: number }>(w.raw, 'SELECT d.serial_norm, u.unit_index FROM device_serials d JOIN order_item_units u ON u.id = d.unit_id ORDER BY u.unit_index');
  assert.deepEqual(pairs.map((p) => `${p.unit_index}:${p.serial_norm}`), [`1:${SN}`, `2:${SN2}`], 'each serial on the unit it was scanned for');
});
