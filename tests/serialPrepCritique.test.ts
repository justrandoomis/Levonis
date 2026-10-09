/**
 * THE CRITIQUES' REMAINING HIGH AND MEDIUM ITEMS, EACH DRIVEN THROUGH ITS OWN
 * SCENARIO (serial scan; critique-2 H4, M2, M3, M4, M13, M15, M1, L6, L14;
 * critique-1 #3, #4, #5, #6, #7, #9).
 *
 * H1/H2 have their own files (serialPrepCanonical, serialPrepGate), H3 / M5 /
 * M6 / M14 / L3 live in serialReturnWarranty, M7 / M10 / M11 in
 * serialPrepScan and serialPrepRaces, M8 / M9 in serialPrepGate, M12 in
 * serialPrepUi. What is left is here, one scenario per finding, written the
 * way the critique described the failure.
 *
 * Run: node --import tsx --test tests/serialPrepCritique.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, get, row, count, all } from './fixtures/app';
import { world, order, op, SN, SN2, SN3 } from './fixtures/serialPrep';
import { sweepReturnedSerials } from '../worker/lib/serialAssignments';
import { addMonths } from '../worker/lib/membershipOps';

type W = ReturnType<typeof world>;
type Who = 'boss' | 'adm' | 'ast';
type R = Record<string, string | number | null>;
const scan = (w: W, who: Who, o: string, item: string, unit: number, code: string, extra: Record<string, unknown> = {}) =>
  post(w.as(who), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: unit, code, source: 'scanner', op_id: op(), ...extra });
const deliver = (w: W, o: string) => patch(w.as('adm'), `/api/admin/orders/${o}/stage`, { stage: 'delivered' });
const unitOf = (w: W, o: string) => row<R>(w.raw, 'SELECT * FROM order_item_units WHERE order_id = ? ORDER BY unit_index', o)!;

/** Sell SN on ORD-111, deliver it, take it back on a refund: the device is home again, its first unit closed. */
async function soldAndReturned(w: W) {
  order(w.raw, 'ORD-111', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-111', 'l1', 1, SN)).status, 200);
  assert.equal((await deliver(w, 'ORD-111')).status, 200);
  const u1 = unitOf(w, 'ORD-111');
  w.raw.exec(`INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state) VALUES ('rc_1','ORD-111','l1','${u1.id}','u1',1,'defective','inspected')`);
  const ret = await json(await post(w.as('adm'), '/api/returns/admin/rc_1/transition', { to: 'resolved', resolution: 'refund', serials: [SN] }));
  assert.deepEqual(ret.serials.closed, [u1.id]);
  return u1;
}

// ------------------------------------------------------------------ H4

test('H4 a resold device keeps its ORIGINAL end through a later delivery-date correction, and its months are not the lever', async () => {
  const w = world();
  const u1 = await soldAndReturned(w);
  order(w.raw, 'ORD-222', [{ id: 'l2', product: 'pA1' }]);
  assert.equal((await json(await scan(w, 'adm', 'ORD-222', 'l2', 1, SN))).slot.assignment.warranty.mode, 'carry');
  await deliver(w, 'ORD-222');
  const u2 = unitOf(w, 'ORD-222');
  assert.equal(u2.warranty_end_at, u1.warranty_end_at);
  // The routine, audited correction: the courier delivered three days before it was recorded.
  const earlier = new Date(Date.parse(String(u2.delivered_at)) - 3 * 86_400_000).toISOString();
  const corr = await patch(w.as('adm'), `/api/devices/admin/units/${u2.id}/delivery`, { delivered_at: earlier, reason: 'courier delivered earlier' });
  assert.equal(corr.status, 200, await corr.clone().text());
  const after = unitOf(w, 'ORD-222');
  assert.equal(after.delivered_at, earlier);
  assert.equal(after.warranty_end_at, u1.warranty_end_at, 'never a full new warranty from a date correction');
  assert.equal(after.warranty_start_at, u1.warranty_start_at, 'S9: the carried START stays too — the warranty runs from the first delivery');
  const months = await patch(w.as('boss'), `/api/devices/admin/units/${u2.id}/warranty`, { base_months: 24, reason: 'goodwill extension' });
  assert.equal(months.status, 409);
  assert.equal((await json(months)).code, 'CARRIED_END');
});

// ------------------------------------------------------------------ M15

test('M15 / owner decision 3 a purchased plan on the resale line never restarts the warranty: no warning, carry, restart refused for everyone, the plan\'s months added to the ORIGINAL end', async () => {
  const w = world();
  const u1 = await soldAndReturned(w);
  order(w.raw, 'ORD-333', [{ id: 'l3', product: 'pA1' }]);
  w.raw.exec(`UPDATE order_items SET warranty_snapshot = '{"plan_id":"wp_ext12","duration_kind":"extension","duration_months":12,"total_months":24,"base_months":12}' WHERE id = 'l3'`);
  const s = await json(await scan(w, 'ast', 'ORD-333', 'l3', 1, SN));
  assert.deepEqual(s.warnings, [], 'nothing to suggest: the warranty is never restarted');
  assert.equal(s.slot.assignment.warranty.mode, 'carry');
  assert.equal(s.slot.assignment.warranty.carries_until, u1.warranty_end_at);
  // Not even the owner restarts it (row 193); nothing is written.
  const restart = await post(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}/warranty-mode`, { mode: 'restart', reason: 'the buyer paid for the 24-month plan' });
  assert.equal(restart.status, 409);
  assert.equal((await json(restart)).code, 'WARRANTY_RESTART_RETIRED');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.warranty_mode'"), 0);
  await deliver(w, 'ORD-333');
  const u3 = unitOf(w, 'ORD-333');
  assert.equal(u3.warranty_start_at, u1.warranty_start_at, 'the original start');
  assert.equal(u3.warranty_end_at, addMonths(String(u1.warranty_end_at), 12), 'the purchased months, added to the ORIGINAL end');
  assert.equal(u3.warranty_base_months, u1.warranty_base_months);
  assert.equal(Number(u3.warranty_ext_months), Number(u1.warranty_ext_months) + 12);
  const pv = JSON.parse(String(u3.policy_version));
  assert.equal(pv.carried, 'original_end');
  assert.equal(pv.origin_unit_id, u1.id);
  assert.equal(pv.origin_start_at, u1.warranty_start_at);
});

// ------------------------------------------------------------------ M2 / critique-1 #4, #5

test('M2 a typo corrected after delivery on a prep-scanned unit: the old binding is released, the new one takes the same unit — no UNIQUE wall, the wrong serial is free again', async () => {
  const w = world();
  order(w.raw, 'ORD-TY', [{ id: 'l1', product: 'pA1' }]);
  const first = await json(await scan(w, 'adm', 'ORD-TY', 'l1', 1, SN));
  await deliver(w, 'ORD-TY');
  const unit = unitOf(w, 'ORD-TY');
  // The unit's warranty is open: replacing its serial frees the old one for
  // sale, so it is the owner's (integrity review #2) — a full-scope admin and
  // an assistant are refused and nothing moves.
  for (const who of ['adm', 'ast'] as const) {
    const refused = await json(await post(w.as(who), `/api/devices/admin/units/${unit.id}/serial`, { serial: SN2, reassign: true, reason: 'typo at the packing desk' }));
    assert.equal(refused.code, 'OWNER_ONLY', who);
  }
  assert.equal(row(w.raw, 'SELECT serial_norm FROM device_serials WHERE unit_id = ?', unit.id)!.serial_norm, SN);
  const fix = await post(w.as('boss'), `/api/devices/admin/units/${unit.id}/serial`, { serial: SN2, reassign: true, reason: 'typo at the packing desk' });
  assert.equal(fix.status, 200, await fix.clone().text());
  const rows = all<R>(w.raw, 'SELECT id, serial_norm, unit_id, source, released_at, release_reason FROM serial_assignments WHERE unit_id = ? ORDER BY linked_at', unit.id);
  assert.equal(rows.length, 2, 'both rows keep the unit as history');
  assert.equal(rows.find((r) => r.id === first.assignment_id)!.release_reason, 'changed');
  const live = rows.filter((r) => !r.released_at);
  assert.deepEqual(live.map((r) => `${r.serial_norm}:${r.source}`), [`${SN2}:post_delivery`]);
  assert.equal(row(w.raw, 'SELECT serial_norm FROM device_serials WHERE unit_id = ?', unit.id)!.serial_norm, SN2);
  // The wrongly typed serial is a free device again — scannable on the next order.
  const page = await json(await get(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(page.story.status, 'in_stock');
  order(w.raw, 'ORD-NX', [{ id: 'ln', product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', 'ORD-NX', 'ln', 1, SN)).status, 200);
  // A second correction on the same unit is no wall either.
  assert.equal((await post(w.as('boss'), `/api/devices/admin/units/${unit.id}/serial`, { serial: SN3, reassign: true, reason: 'second look at the label' })).status, 200);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE unit_id = ? AND released_at IS NULL', unit.id), 1);
});

// ------------------------------------------------------------------ M3 / critique-1 #9

test('M3 every CHECK list already holds the values later phases name — a CHECK cannot be widened without a rebuild', () => {
  const w = world();
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, created_by) VALUES ('${SN}','${SN}','boss')`);
  let n = 0;
  const insert = (cols: Record<string, string | number | null>) => {
    n++;
    const base: Record<string, string | number | null> = {
      id: `sa_m3_${n}`, serial_norm: SN, serial_raw: SN, order_ref: 'ORD-X', unit_index: n, source: 'manual', idempotency_key: `m3:${n}`, linked_by: 'boss',
      released_at: '2026-10-01T00:00:00.000Z', release_reason: 'unlinked',
    };
    const all2 = { ...base, ...cols };
    const keys = Object.keys(all2);
    w.raw.prepare(`INSERT INTO serial_assignments (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(Object.values(all2) as never[]));
  };
  for (const source of ['camera', 'scanner', 'manual', 'relink', 'post_delivery', 'owner_override', 'replacement', 'import']) insert({ source });
  for (const reason of ['unlinked', 'changed', 'order_cancelled', 'owner_override', 'returned', 'replaced', 'reassigned', 'policy_changed', 'order_deleted', 'traded_in']) insert({ release_reason: reason });
  for (const kind of ['take_from_order', 'delivered_device', 'unavailable', 'outside_window', 'batch', 'model_family', 'after_shipment']) insert({ override_kind: kind, override_reason: 'owner reason here' });
  insert({ part: 'ams', part_index: 3 });
  for (const mode of ['new', 'carry', 'restart']) insert({ warranty_mode: mode });
  assert.throws(() => insert({ source: 'magic' }), /CHECK/);
  assert.throws(() => insert({ release_reason: 'because' }), /CHECK/);
  assert.throws(() => insert({ override_kind: 'batch', override_reason: 'no' }), /CHECK/, 'an exception always carries its reason');
  assert.throws(() => insert({ released_at: null }), /CHECK/, 'a reason only on a released row');
  assert.throws(() => insert({ released_at: null, release_reason: null, unit_id: 'unit_x' }), /CHECK/, 'a unit only with an activation');
  // The unit's closure reasons.
  w.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('ORD-M3','u1','delivered','{}','home','{}','cash',1,1400,1,0);
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES ('lm3','ORD-M3','pA1','A1',9,1,9);
  `);
  let u = 0;
  for (const reason of ['returned', 'returned_unsellable', 'owner_override', 'order_cancelled', 'traded_in', 'replaced']) {
    u++;
    w.raw.exec(`INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, warranty_closed_at, warranty_closed_reason)
                VALUES ('u_m3_${u}','ORD-M3','lm3','pA1','u1',${u},'2026-10-01T00:00:00.000Z','${reason}')`);
  }
  assert.throws(() => w.raw.exec(`INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, warranty_closed_reason) VALUES ('u_bad','ORD-M3','lm3','pA1','u1',9,'lost')`), /CHECK/);
  assert.throws(() => w.raw.exec(`UPDATE catalogs SET serial_policy = 'sometimes' WHERE id = 'ct_ams'`), /CHECK/);
});

// ------------------------------------------------------------------ M4 / critique-1 #6

test('M4 the replacement door: a serial promised to another order is not a spare; the swap releases the old binding and binds the new device; the replaced box is the owner\'s to resell', async () => {
  const w = world();
  order(w.raw, 'ORD-SOLD', [{ id: 'ls', product: 'pA1' }]);
  order(w.raw, 'ORD-PREP', [{ id: 'lp', product: 'pA1' }]);
  order(w.raw, 'ORD-NEXT', [{ id: 'ln', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-SOLD', 'ls', 1, SN);
  await deliver(w, 'ORD-SOLD');
  const sold = unitOf(w, 'ORD-SOLD');
  await scan(w, 'adm', 'ORD-PREP', 'lp', 1, SN2);
  // SN2 is reserved for ORD-PREP: never handed out as a replacement.
  const promised = await post(w.as('adm'), `/api/devices/admin/units/${sold.id}/replace`, { reason: 'dead on arrival, swapped', new_serial: SN2 });
  const pb = await json(promised);
  assert.equal(promised.status, 409, JSON.stringify(pb));
  assert.equal(pb.code, 'SERIAL_IN_USE');
  assert.equal(pb.details?.order_id, undefined, 'and staff are not told which order');
  // A spare from the shelf: the old binding ends 'replaced', the new device is bound to the new unit.
  const ok = await post(w.as('adm'), `/api/devices/admin/units/${sold.id}/replace`, { reason: 'dead on arrival, swapped', new_serial: SN3 });
  const ob = await json(ok);
  assert.equal(ok.status, 200, JSON.stringify(ob));
  const oldBinding = row<R>(w.raw, "SELECT release_reason, unit_id FROM serial_assignments WHERE serial_norm = ? AND order_id = 'ORD-SOLD'", SN)!;
  assert.equal(oldBinding.release_reason, 'replaced');
  const newBinding = row<R>(w.raw, 'SELECT source, unit_id, activated_at, released_at FROM serial_assignments WHERE serial_norm = ?', SN3)!;
  assert.deepEqual({ source: newBinding.source, unit_id: newBinding.unit_id, live: !newBinding.released_at, activated: !!newBinding.activated_at }, { source: 'replacement', unit_id: ob.new_unit_id, live: true, activated: true });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN3), 1, 'the replacement device has its asset row');
  // The replaced box: staff cannot sell it; the owner may, with a reason, and delivery moves it.
  const staff = await json(await scan(w, 'adm', 'ORD-NEXT', 'ln', 1, SN));
  assert.equal(staff.code, 'SERIAL_NOT_AVAILABLE');
  assert.equal(staff.details.reason, 'replaced');
  const owner = await post(w.as('boss'), '/api/admin/orders/ORD-NEXT/serials/override', {
    order_item_id: 'ln', unit_index: 1, code: SN, kind: 'unavailable', reason: 'repaired and re-certified', op_id: op(),
  });
  assert.equal(owner.status, 200, await owner.clone().text());
  await deliver(w, 'ORD-NEXT');
  const next = unitOf(w, 'ORD-NEXT');
  assert.equal(row(w.raw, 'SELECT unit_id FROM device_serials WHERE serial_norm = ?', SN)!.unit_id, next.id);
  assert.ok(row(w.raw, "SELECT activated_at FROM serial_assignments WHERE serial_norm = ? AND order_id = 'ORD-NEXT'", SN)!.activated_at);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 1);
});

// ------------------------------------------------------------------ M13 / critique-1 #7

test('M13 one serial→order-item link: the stock door cannot point a bound serial at another line, and a serial an older link ties to a live order is not free', async () => {
  const w = world();
  order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
  order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }]);
  w.raw.exec(`
    INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, cost_basis, received_at)
      VALUES ('lotA','pA1','base','',4,2,'received','2026-09-01T00:00:00.000Z');
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, idempotency_key)
      VALUES ('al_a','ORD-A','la','lotA','base','',1,'alloc:ORD-A:la:lotA'), ('al_b','ORD-B','lb','lotA','base','',1,'alloc:ORD-B:lb:lotA');
  `);
  await scan(w, 'adm', 'ORD-A', 'la', 1, SN);
  const other = await post(w.as('adm'), '/api/admin/stock-operations/serial-link', { serial_norm: SN, lot_id: 'lotA', order_item_id: 'lb' });
  assert.equal(other.status, 409, await other.clone().text());
  assert.equal((await json(other)).code, 'SERIAL_IN_USE');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM stock_serial_links WHERE serial_norm = ?', SN), 0);
  const own = await post(w.as('adm'), '/api/admin/stock-operations/serial-link', { serial_norm: SN, lot_id: 'lotA', order_item_id: 'la' });
  assert.equal(own.status, 200, await own.clone().text());
  // The older table names ORD-B's line for SN2 — ORD-A cannot take it as if it were free.
  w.raw.exec(`
    INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN2}','${SN2}','pA1','boss');
    INSERT INTO stock_serial_links (serial_norm, lot_id, order_item_id, linked_by, linked_at) VALUES ('${SN2}','lotA','lb','boss','2026-09-02T00:00:00.000Z');
  `);
  order(w.raw, 'ORD-C', [{ id: 'lc', product: 'pA1' }]);
  assert.equal((await json(await scan(w, 'adm', 'ORD-C', 'lc', 1, SN2))).code, 'SERIAL_IN_USE');
});

// ------------------------------------------------------------------ M1 / L14 / critique-1 #19

test('M1/L14 the scan says what it could not prove: no allocation behind a reserved line, stock not taken again after a re-open, a device cancelled after it left', async () => {
  const w = world();
  // A tracked line, reserved and deducted, but the lots were never allocated.
  order(w.raw, 'ORD-NA', [{ id: 'la', product: 'pA1' }]);
  w.raw.exec(`
    INSERT INTO inventory_ledger (id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key)
      VALUES ('r1','pA1','base','','reserve',1,'ORD-NA','reserve:ORD-NA:la:base:-'), ('d1','pA1','base','','deduct',1,'ORD-NA','deduct:ORD-NA:la:base:-');
  `);
  const na = await json(await scan(w, 'adm', 'ORD-NA', 'la', 1, SN));
  assert.deepEqual(na.warnings, ['ALLOCATION_MISSING']);
  const flags = (await json(await get(w.as('adm'), '/api/admin/orders/ORD-NA/serials'))).serials.slots[0].flags;
  assert.deepEqual(flags, ['ALLOCATION_MISSING']);

  // Re-opened after a cancel that returned the stock (DECISIONS 184(15)): a flag, never a gate.
  order(w.raw, 'ORD-RO', [{ id: 'lr', product: 'pA1' }]);
  w.raw.exec(`
    INSERT INTO inventory_ledger (id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key, created_at)
      VALUES ('r2','pA1','base','','reserve',1,'ORD-RO','reserve:ORD-RO:lr:base:-','2026-10-01T00:00:00.000Z'),
             ('d2','pA1','base','','deduct',1,'ORD-RO','deduct:ORD-RO:lr:base:-','2026-10-01T00:00:01.000Z'),
             ('s2','pA1','base','','restore',1,'ORD-RO','restore:ORD-RO:lr:base:-','2026-10-02T00:00:00.000Z');
  `);
  const ro = await json(await scan(w, 'adm', 'ORD-RO', 'lr', 1, SN2));
  assert.ok(ro.warnings.includes('STOCK_NOT_RETAKEN'), JSON.stringify(ro.warnings));
  assert.ok((await json(await get(w.as('adm'), '/api/admin/orders/ORD-RO/serials'))).serials.slots[0].flags.includes('STOCK_NOT_RETAKEN'));

  // L14: the device's last order was cancelled AFTER it left the shop — the next scan says so.
  order(w.raw, 'ORD-SH', [{ id: 'ls', product: 'pA1' }]);
  order(w.raw, 'ORD-AG', [{ id: 'lg', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-SH', 'ls', 1, SN3);
  w.raw.exec(`UPDATE orders SET status = 'shipped', stage = 'out_for_delivery' WHERE id = 'ORD-SH'`);
  w.raw.exec(`UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id = 'ORD-SH'`);
  assert.equal(row(w.raw, "SELECT release_note FROM serial_assignments WHERE order_id = 'ORD-SH'")!.release_note, 'from:shipped');
  const again = await json(await scan(w, 'adm', 'ORD-AG', 'lg', 1, SN3));
  assert.equal(again.success, true);
  assert.ok(again.warnings.includes('CANCELLED_AFTER_DISPATCH'), 'check the box is really back on the shelf');
});

// ------------------------------------------------------------------ L6 / critique-1 #21

test('L6/critique-1 #21 a refund resolved on an order delivered before this feature never rewrites that order\'s units', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-PRE','u1','delivered','{}','home','{}','cash',1,1400,1,0,'2026-05-01T00:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES ('lpre','ORD-PRE','pA1','A1',1,1,1);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_start_at, warranty_end_at)
      VALUES ('unit_pre','ORD-PRE','lpre','pA1','u1',1,'2026-05-01T00:00:00.000Z','2026-05-01T00:00:00.000Z','2027-05-01T00:00:00.000Z');
    INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES ('${SN}','${SN}','unit_pre','boss');
    INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state) VALUES ('rc_pre','ORD-PRE','lpre','unit_pre','u1',1,'defective','inspected');
  `);
  const res = await json(await post(w.as('adm'), '/api/returns/admin/rc_pre/transition', { to: 'resolved', resolution: 'refund' }));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.deepEqual(res.serials, { closed: [], unattributed: false }, 'no evidence and no feature binding: nothing is touched');
  assert.equal((await sweepReturnedSerials(w.env, 50)).scanned, 0, 'and the sweep never picks it up');
  assert.equal(row(w.raw, "SELECT warranty_closed_at FROM order_item_units WHERE id = 'unit_pre'")!.warranty_closed_at, null);
});
