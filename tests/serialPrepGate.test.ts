/**
 * THE §19 GATE AND THE WAYS AROUND IT (serial scan; owner brief §19, §24;
 * critique-2 H2, M1, M8, M9, L5, L13) — through the real routes over the real
 * migrations.
 *
 * H2 named three bypasses, and each is closed here by a test that drives the
 * bypass itself:
 *   1. the courier shipment is the real point of no return, yet the order
 *      stays at «preparing» after it — so serial edits must FREEZE for staff
 *      the moment a `delivery_remote_id` exists, and the courier door itself
 *      must refuse a missing serial before anything leaves the building;
 *   2. the gate is a pre-read: an unlink landing between it and the flip
 *      must be caught INSIDE the flip's own batch, at the stage door
 *      (tests/serialPrepRaces.test.ts) and at the legacy status door (here);
 *   3. the courier's own report and the cron are never gated — the parcel
 *      really moved — which is exactly why the doors above must hold.
 *
 * Run: node --import tsx --test tests/serialPrepGate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, put, get, row, count, all, stubApp, failingD1 } from './fixtures/app';
import { world, order, op, SN, SN2, SN3, USERS } from './fixtures/serialPrep';
import { adminOrderSerialRoutes } from '../worker/routes/adminOrderSerials';
import { adminRoutes } from '../worker/routes/admin';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { serialGateState } from '../worker/lib/serialAssignments';

type W = ReturnType<typeof world>;
type Who = 'boss' | 'adm' | 'ast';
const scan = (w: W, who: Who, o: string, item: string, unit: number, code: string) =>
  post(w.as(who), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: unit, code, source: 'scanner', op_id: op() });
const live = (w: W, o: string) => count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE order_id = ? AND released_at IS NULL', o);

async function gateOn(w: W, since = '2026-01-01T00:00:00.000Z') {
  const r = await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: true, since } });
  assert.equal(r.status, 200, await r.clone().text());
}

// ------------------------------------------------------------------ 1. the shipment freezes the serials

test('H2 once a courier shipment exists the serials freeze for staff — scan, change and remove — though the order still reads «preparing»', async () => {
  const w = world();
  order(w.raw, 'ORD-SH', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  const first = await json(await scan(w, 'adm', 'ORD-SH', 'l1', 1, SN));
  assert.equal(first.success, true, JSON.stringify(first));
  w.raw.exec(`UPDATE orders SET delivery_remote_id = 'AW-77', delivery_provider = 'alwaseet' WHERE id = 'ORD-SH'`);
  assert.equal(row(w.raw, "SELECT stage FROM orders WHERE id = 'ORD-SH'")!.stage, 'preparing', 'the shipment does not move the stage — the bypass H2 found');

  for (const who of ['adm', 'ast'] as const) {
    const s = await json(await scan(w, who, 'ORD-SH', 'l1', 2, SN2));
    assert.equal(s.code, 'ORDER_NOT_PREPARABLE', `${who} scan`);
    assert.equal(s.details.reason, 'shipment');
    const ch = await json(await post(w.as(who), '/api/admin/orders/ORD-SH/serials/change', { assignment_id: first.assignment_id, code: SN3, source: 'scanner', op_id: op() }));
    assert.equal(ch.code, 'ORDER_NOT_PREPARABLE', `${who} change`);
    const un = await json(await post(w.as(who), '/api/admin/orders/ORD-SH/serials/unlink', { assignment_id: first.assignment_id, reason: 'wrong unit packed' }));
    assert.equal(un.code, 'ORDER_NOT_PREPARABLE', `${who} unlink`);
    assert.equal(un.details.reason, 'shipment');
  }
  assert.equal(live(w, 'ORD-SH'), 1, 'nothing changed');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm IN (?, ?)', SN2, SN3), 0, 'no asset was created by a refused scan');

  const view = await json(await get(w.as('adm'), '/api/admin/orders/ORD-SH/serials'));
  assert.equal(view.serials.shipment_locked, true, 'the screen knows why the field is read-only');

  // The owner: may complete the parcel's record; removing needs a reason, audited.
  assert.equal((await json(await post(w.as('boss'), '/api/admin/orders/ORD-SH/serials/unlink', { assignment_id: first.assignment_id }))).code, 'OVERRIDE_REASON_REQUIRED');
  const ownerScan = await scan(w, 'boss', 'ORD-SH', 'l1', 2, SN2);
  assert.equal(ownerScan.status, 200, await ownerScan.clone().text());
  const ok = await json(await post(w.as('boss'), '/api/admin/orders/ORD-SH/serials/unlink', { assignment_id: first.assignment_id, reason: 'box swapped at the courier desk' }));
  assert.equal(ok.success, true);
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.unlinked' AND target = ?", SN)!.detail);
  assert.equal(audit.outside_window, true);
  assert.equal(audit.reason, 'box swapped at the courier desk');
});

test('H2 a shipment stored between a staff scan\'s read and its batch aborts the scan inside the batch; an unlink likewise', async () => {
  const w = world();
  order(w.raw, 'ORD-R', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  const kept = await json(await scan(w, 'adm', 'ORD-R', 'l1', 1, SN));
  const { failing, db } = failingD1(w.raw);
  const app = stubApp(db, USERS.adm, (a) => a.route('/api/admin/orders', adminOrderSerialRoutes));
  failing.beforeBatch = (s) => {
    if (s.some((x) => /INSERT INTO serial_assignments|UPDATE serial_assignments SET released_at/.test(x.sql))) {
      w.raw.exec(`UPDATE orders SET delivery_remote_id = 'AW-RACE' WHERE id = 'ORD-R'`);
    }
  };
  const s = await post(app, '/api/admin/orders/ORD-R/serials/scan', { order_item_id: 'l1', unit_index: 2, code: SN2, source: 'camera', op_id: op() });
  assert.equal(s.status, 409, await s.clone().text());
  assert.equal((await json(s)).code, 'ORDER_NOT_PREPARABLE');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN2), 0, 'nothing of the batch survived');

  w.raw.exec(`UPDATE orders SET delivery_remote_id = '' WHERE id = 'ORD-R'`);
  const u = await post(app, '/api/admin/orders/ORD-R/serials/unlink', { assignment_id: kept.assignment_id });
  assert.equal(u.status, 409, await u.clone().text());
  assert.equal((await json(u)).code, 'ORDER_NOT_PREPARABLE');
  assert.equal(row(w.raw, 'SELECT released_at FROM serial_assignments WHERE id = ?', kept.assignment_id)!.released_at, null, 'the link the parcel left with is still there');
});

// ------------------------------------------------------------------ 1b. the courier door

const COURIER_ENV = { ALWASEET_BASE_URL: 'https://courier.invalid', ALWASEET_USERNAME: 'u', ALWASEET_PASSWORD: 'p' };

async function withCourier<T>(during: (() => void) | null, run: (sent: unknown[]) => Promise<T>): Promise<T> {
  const sent: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    during?.();
    return new Response(JSON.stringify({ id: `AW-${sent.length}`, tracking_number: `T-${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await run(sent);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('H2 the courier door refuses a missing serial BEFORE the courier is called; the owner may pass with a reason, audited once the shipment exists', async () => {
  const w = world();
  w.raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('deliveryConfig', ?)").run(JSON.stringify({ createPath: '/create', createFields: { amountIqd: 'price', orderId: 'ref' } }));
  await gateOn(w);
  order(w.raw, 'ORD-C1', [{ id: 'c1', product: 'pA1' }, { id: 'c1p', product: 'pPLA' }]);
  order(w.raw, 'ORD-C2', [{ id: 'c2', product: 'pA1' }]);
  const ship = (who: Who, o: string, body: Record<string, unknown> = {}) => post(w.as(who, COURIER_ENV), `/api/admin/orders/${o}/delivery`, body);

  await withCourier(null, async (sent) => {
    const refused = await ship('adm', 'ORD-C1');
    const body = await json(refused);
    assert.equal(refused.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'SERIALS_REQUIRED');
    assert.deepEqual(body.details.missing.map((m: { order_item_id: string }) => m.order_item_id), ['c1'], 'the filament needs nothing');
    assert.equal(sent.length, 0, 'nothing left the building');
    assert.ok(!row(w.raw, "SELECT delivery_remote_id FROM orders WHERE id = 'ORD-C1'")!.delivery_remote_id, 'so the courier sync can never pick it up');

    const notOwner = await ship('adm', 'ORD-C1', { serials_override_reason: 'courier is waiting outside' });
    assert.equal(notOwner.status, 403);
    assert.equal((await json(notOwner)).code, 'OWNER_ONLY');
    assert.equal((await json(await ship('boss', 'ORD-C1', { serials_override_reason: 'no' }))).code, 'OVERRIDE_REASON_REQUIRED');
    assert.equal(sent.length, 0);

    const owner = await ship('boss', 'ORD-C1', { serials_override_reason: 'sealed box, serial read at the door' });
    assert.equal(owner.status, 200, await owner.clone().text());
    assert.equal(sent.length, 1);
    const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.prep_gate_override' AND target = 'ORD-C1'")!.detail);
    assert.equal(audit.reason, 'sealed box, serial read at the door');
    assert.equal(audit.to_stage, 'out_for_delivery');

    // A fully linked order goes through for anyone, with no note.
    assert.equal((await scan(w, 'adm', 'ORD-C2', 'c2', 1, SN)).status, 200);
    const linked = await ship('adm', 'ORD-C2');
    const lb = await json(linked);
    assert.equal(linked.status, 200, JSON.stringify(lb));
    assert.equal(lb.notes, undefined);
    assert.equal(sent.length, 2);
  });
});

test('H2 an unlink that lands while the courier is being called is recorded as a breach and reported — never shipped in silence', async () => {
  const w = world();
  w.raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('deliveryConfig', ?)").run(JSON.stringify({ createPath: '/create', createFields: { orderId: 'ref' } }));
  await gateOn(w);
  order(w.raw, 'ORD-C3', [{ id: 'c3', product: 'pA1' }]);
  const a = await json(await scan(w, 'adm', 'ORD-C3', 'c3', 1, SN));
  const unlinkDuringCall = () => {
    w.raw.prepare("UPDATE serial_assignments SET released_at = '2026-10-08T00:00:00.000Z', release_reason = 'unlinked' WHERE id = ?").run(a.assignment_id);
  };
  await withCourier(unlinkDuringCall, async (sent) => {
    const res = await post(w.as('adm', COURIER_ENV), '/api/admin/orders/ORD-C3/delivery', {});
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(sent.length, 1);
    assert.deepEqual(body.notes, ['SERIALS_MISSING_AFTER_SHIPMENT']);
  });
  const breach = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.prep_gate_breach' AND target = 'ORD-C3'")!.detail);
  assert.deepEqual(breach.missing.map((m: { order_item_id: string; unit_index: number }) => `${m.order_item_id}:${m.unit_index}`), ['c3:1']);
  assert.equal(breach.remote_id, 'AW-1');
  // And from here on the parcel's serials are the owner's alone.
  assert.equal((await json(await scan(w, 'adm', 'ORD-C3', 'c3', 1, SN))).code, 'ORDER_NOT_PREPARABLE');
});

// ------------------------------------------------------------------ 2. the legacy door's fence

test('H2 the legacy status door carries the count fence: an unlink between its read and its flip ships nothing', async () => {
  const w = world();
  await gateOn(w);
  order(w.raw, 'ORD-LG', [{ id: 'l1', product: 'pA1' }]);
  const a = await json(await scan(w, 'adm', 'ORD-LG', 'l1', 1, SN));
  const { failing, db } = failingD1(w.raw);
  let fenced = false;
  failing.beforeBatch = (s) => {
    if (s.some((x) => /UPDATE orders/.test(x.sql)) && s.some((x) => /ops_guards/.test(x.sql))) {
      fenced = true;
      w.raw.prepare("UPDATE serial_assignments SET released_at = '2026-10-08T00:00:00.000Z', release_reason = 'unlinked' WHERE id = ?").run(a.assignment_id);
    }
  };
  const app = stubApp(db, USERS.adm, (x) => x.route('/api/admin', adminRoutes));
  const r = await patch(app, '/api/admin/orders/ORD-LG', { status: 'shipped' });
  assert.equal(r.status, 409, await r.clone().text());
  assert.equal((await json(r)).code, 'SERIALS_REQUIRED');
  assert.ok(fenced, 'the fence rode the flip\'s own batch');
  assert.equal(row(w.raw, "SELECT status FROM orders WHERE id = 'ORD-LG'")!.status, 'processing', 'nothing moved');
});

// ------------------------------------------------------------------ 3. what is gated and what is not

test('§19 straight to «delivered» is gated at both doors and for a pre-order; cancels, backward moves, the courier\'s report and the cron are not', async () => {
  const w = world();
  await gateOn(w);
  order(w.raw, 'ORD-D', [{ id: 'ld', product: 'pA1' }]);
  assert.equal((await json(await patch(w.as('adm'), '/api/admin/orders/ORD-D/stage', { stage: 'delivered' }))).code, 'SERIALS_REQUIRED');
  assert.equal((await json(await patch(w.as('adm'), '/api/admin/orders/ORD-D', { status: 'delivered' }))).code, 'SERIALS_REQUIRED');
  order(w.raw, 'ORD-PRE', [{ id: 'lp', product: 'pA1' }], { shipping_type: 'preorder_air', stage: 'local_delivery_prep' });
  assert.equal((await json(await patch(w.as('adm'), '/api/admin/orders/ORD-PRE/stage', { stage: 'out_for_delivery' }))).code, 'SERIALS_REQUIRED', 'a pre-order hands over at the same stage');
  // A cancel is never held hostage by a missing serial.
  const cancel = await patch(w.as('adm'), '/api/admin/orders/ORD-D/stage', { stage: 'cancelled' });
  assert.equal(cancel.status, 200, await cancel.clone().text());

  // The courier reports what happened — the order moves whatever the gate says.
  order(w.raw, 'ORD-K', [{ id: 'lk', product: 'pA1' }]);
  const courier = await moveOrderStage(w.env, { orderId: 'ORD-K', to: 'delivered', source: 'delivery_api', changedBy: '', force: true });
  assert.equal(courier.moved, true, JSON.stringify(courier));
  assert.equal(row(w.raw, "SELECT status FROM orders WHERE id = 'ORD-K'")!.status, 'delivered');
  const after = await json(await get(w.as('boss'), '/api/admin/orders/ORD-K/serials'));
  assert.deepEqual(after.serials.slots[0].flags, ['SERIAL_MISSING_AT_DELIVERY'], 'and the screen says what is missing');
  // Backward correction of a delivered order: never gated.
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-K/stage', { stage: 'out_for_delivery' })).status, 200);
});

test('§19 the switch: off by default, owner-only, normalised (garbage is OFF), and the owner can switch it off again', async () => {
  const w = world();
  const settings = await json(await get(w.as('boss'), '/api/admin/settings'));
  const shipped = settings.settings?.serialPrepGate ?? settings.serialPrepGate;
  assert.deepEqual(shipped, { enabled: false, since: null }, 'ships OFF');
  for (const who of ['adm', 'ast'] as const) {
    const r = await put(w.as(who), '/api/admin/settings/serialPrepGate', { value: { enabled: true } });
    assert.equal(r.status, 403, who);
    assert.equal((await json(r)).code, 'OWNER_ONLY');
  }
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'serialPrepGate'"), 0, 'a refused write stores nothing');
  await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: 'yes', since: 'tomorrow' } });
  assert.deepEqual(JSON.parse(row<{ value: string }>(w.raw, "SELECT value FROM admin_settings WHERE key = 'serialPrepGate'")!.value), { enabled: false, since: null });
  await gateOn(w, '2026-03-01T10:00:00Z');
  assert.equal(JSON.parse(row<{ value: string }>(w.raw, "SELECT value FROM admin_settings WHERE key = 'serialPrepGate'")!.value).since, '2026-03-01T10:00:00.000Z');
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'settings.update' AND target = 'serialPrepGate'"), 'the switch is audited');
  order(w.raw, 'ORD-OFF', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await json(await patch(w.as('adm'), '/api/admin/orders/ORD-OFF/stage', { stage: 'out_for_delivery' }))).code, 'SERIALS_REQUIRED');
  await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: false } });
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-OFF/stage', { stage: 'out_for_delivery' })).status, 200, 'off again: nothing is held');
});

test('M8/M9 a bundle parent and a community-store order never hold the gate; the bundle\'s printer component does', async () => {
  const w = world();
  await gateOn(w);
  order(w.raw, 'ORD-BU', [{ id: 'lb', product: 'pA1', name: 'A1 starter bundle' }]);
  w.raw.exec(`
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd, bundle_parent_item_id)
      VALUES ('lb_p','ORD-BU','pA1','A1 (in bundle)',1,0,0,'lb'), ('lb_f','ORD-BU','pPLA','PLA (in bundle)',2,0,0,'lb');
  `);
  const g = await serialGateState(w.env, 'ORD-BU');
  assert.deepEqual(g.missing.map((m) => m.order_item_id), ['lb_p'], 'one box, one serial — the component\'s, never the parent\'s too');
  assert.equal((await json(await scan(w, 'adm', 'ORD-BU', 'lb', 1, SN))).code, 'SERIAL_NOT_REQUIRED');
  assert.equal((await scan(w, 'adm', 'ORD-BU', 'lb_p', 1, SN)).status, 200);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-BU/stage', { stage: 'out_for_delivery' })).status, 200, 'the one real device is linked');

  order(w.raw, 'ORD-MER', [{ id: 'lm', product: 'pA1' }]);
  w.raw.exec(`UPDATE orders SET seller_type = 'merchant' WHERE id = 'ORD-MER'`);
  const m = await serialGateState(w.env, 'ORD-MER');
  assert.equal(m.applies, false);
  assert.deepEqual(m.missing, []);
  assert.equal((await json(await get(w.as('adm'), '/api/admin/orders/ORD-MER/serials'))).serials.required, 0);
});

test('M1 at dispatch: a serial whose own lot is no longer among the line\'s allocations (re-allocated after a re-confirm) holds the gate', async () => {
  const w = world();
  order(w.raw, 'ORD-LOT', [{ id: 'l1', product: 'pA1' }]);
  w.raw.exec(`
    INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, cost_basis, received_at)
      VALUES ('lotA','pA1','base','',2,1,'received','2026-09-01T00:00:00.000Z'), ('lotB','pA1','base','',2,1,'received','2026-09-05T00:00:00.000Z');
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, idempotency_key)
      VALUES ('al1','ORD-LOT','l1','lotA','base','',1,'alloc:ORD-LOT:l1:lotA');
    INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN}','${SN}','pA1','boss');
    INSERT INTO stock_serial_links (serial_norm, lot_id, linked_by, linked_at) VALUES ('${SN}','lotA','boss','2026-09-01T00:00:00.000Z');
  `);
  const linked = await json(await scan(w, 'adm', 'ORD-LOT', 'l1', 1, SN));
  assert.equal(linked.slot.assignment.lot_source, 'serial_link');
  await gateOn(w);
  // A move back and a re-confirm released lot A and FIFO took lot B.
  w.raw.exec(`
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, idempotency_key, released_at)
      VALUES ('al1r','ORD-LOT','l1','lotA','base','',1,'release:ORD-LOT:l1:lotA','2026-10-02T00:00:00.000Z');
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, idempotency_key)
      VALUES ('al2','ORD-LOT','l1','lotB','base','',1,'alloc2:ORD-LOT:l1:lotB');
  `);
  const r = await patch(w.as('adm'), '/api/admin/orders/ORD-LOT/stage', { stage: 'out_for_delivery' });
  const body = await json(r);
  assert.equal(r.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'SERIALS_REQUIRED');
  assert.deepEqual(body.details.missing, [], 'every unit has a serial…');
  assert.deepEqual(body.details.lot_conflicts.map((c: { assignment_id: string }) => c.assignment_id), [linked.assignment_id], '…but that box is not from a lot this line now holds');
  assert.ok(!/cost|cogs/i.test(JSON.stringify(body)), 'never a cost figure');
  // Every one of them is listed for the owner's decision, not silently re-pinned.
  assert.equal(all(w.raw, "SELECT lot_id FROM serial_assignments WHERE order_id = 'ORD-LOT'")[0].lot_id, 'lotA');
});
