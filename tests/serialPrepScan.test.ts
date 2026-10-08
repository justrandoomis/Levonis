/**
 * «Scan Serial» AT ORDER PREPARATION (migration 0178; owner brief 2026-10-07,
 * §32 tests 1–17, 19, 20) — through the real routes over the real migrations.
 *
 * One serial asset per device (serial_inventory, primary key), one live
 * binding per device and per unit slot (serial_assignments), the warranty
 * record only at delivery (order_item_units), history in audit_log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, put, get, all, row, count } from './fixtures/app';
import { world, order, op, SN, SN2, SN3, BOX, EAN, BEFORE_SERIALS } from './fixtures/serialPrep';
import {
  classifyScanInput,
  scanWindowSql,
  serialScanWindow,
  serialFamilyConflict,
} from '../worker/lib/serialAssignments';
import { DIRECT_STAGES, PREORDER_STAGES } from '../worker/lib/orderStages';

const scanPath = (o: string) => `/api/admin/orders/${o}/serials/scan`;
const scan = (a: ReturnType<ReturnType<typeof world>['as']>, o: string, item: string, unit: number, code: string, extra: Record<string, unknown> = {}) =>
  post(a, scanPath(o), { order_item_id: item, unit_index: unit, code, source: 'camera', op_id: op(), ...extra });

const live = (raw: ReturnType<typeof world>['raw'], serial: string) =>
  all(raw, 'SELECT * FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL', serial);

// ------------------------------------------------------------------ §32.1

test('§32.1 a new printer serial: ONE asset, ONE live binding, warranty pending, no stock moved, audited', async () => {
  const w = world();
  order(w.raw, 'ORD-111', [{ id: 'l1', product: 'pA1' }]);
  const ledgerBefore = count(w.raw, 'SELECT COUNT(*) AS n FROM inventory_ledger');
  const res = await scan(w.as('adm'), 'ORD-111', 'l1', 1, SN);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.outcome, 'created');
  assert.equal(body.code, 'SERIAL_LINKED');
  assert.equal(body.message, 'تم ربط الرقم التسلسلي بالطلب.');
  assert.equal(body.slot.assignment.warranty.state, 'PENDING_DELIVERY');
  assert.equal(body.slot.assignment.serial_full, SN, 'a full-scope admin sees the whole serial');

  const asset = row(w.raw, 'SELECT * FROM serial_inventory WHERE serial_norm = ?', SN)!;
  assert.equal(asset.product_id, 'pA1', 'the asset is filed under the line it was scanned for');
  assert.equal(asset.source, 'scan');
  assert.equal(asset.note, '', 'the order is never part of the asset (§6)');
  assert.equal(live(w.raw, SN).length, 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM order_item_units WHERE order_id = ?', 'ORD-111'), 0, 'no warranty unit before delivery');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), ledgerBefore, '§26: the scan moves no stock');
  const actions = all<{ action: string }>(w.raw, 'SELECT action FROM audit_log WHERE target = ? ORDER BY id', SN).map((a) => a.action);
  assert.deepEqual(actions, ['serial_inventory.add', 'serial.linked']);
  const linked = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.linked'")!.detail);
  for (const k of ['assignment_id', 'order_id', 'order_item_id', 'unit_index', 'source', 'previous_assignment']) assert.ok(k in linked, `§25 audit carries ${k}`);
});

// ------------------------------------------------------------------ §32.2 / §29

test('§32.2/§29 AMS: no slot until the OWNER sets the section policy; accessories never; a sub-section can opt out', async () => {
  const w = world();
  order(w.raw, 'ORD-AMS', [{ id: 'la', product: 'pAMS' }, { id: 'lp', product: 'pPLA' }]);
  assert.equal((await json(await scan(w.as('adm'), 'ORD-AMS', 'la', 1, SN))).code, 'SERIAL_NOT_REQUIRED');

  const refused = await put(w.as('adm'), '/api/admin/taxonomy/catalogs/ct_acc/serial-policy', { policy: 'required' });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'OWNER_ONLY');
  const set = await json(await put(w.as('boss'), '/api/admin/taxonomy/catalogs/ct_ams/serial-policy', { policy: 'required' }));
  assert.deepEqual(set.requires_serial, ['pAMS']);

  const detail = await json(await get(w.as('adm'), '/api/admin/orders/ORD-AMS'));
  assert.deepEqual(detail.order.serials.slots.map((s: { order_item_id: string }) => s.order_item_id), ['la'], 'the AMS line has a slot, the filament none');
  const ok = await scan(w.as('adm'), 'ORD-AMS', 'la', 1, '00N00A123456789');
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.equal((await json(await scan(w.as('adm'), 'ORD-AMS', 'lp', 1, SN2))).code, 'SERIAL_NOT_REQUIRED');

  // Required on the parent, OFF on the filament section: the nearest wins.
  await put(w.as('boss'), '/api/admin/taxonomy/catalogs/ct_acc/serial-policy', { policy: 'required' });
  await put(w.as('boss'), '/api/admin/taxonomy/catalogs/ct_fil/serial-policy', { policy: 'off' });
  assert.equal((await json(await scan(w.as('adm'), 'ORD-AMS', 'lp', 1, SN2))).code, 'SERIAL_NOT_REQUIRED');
  // The product's own explicit word beats every section.
  w.raw.exec(`UPDATE products SET ops_policy = '{"serialized":false}' WHERE id = 'pAMS'`);
  const after = await json(await get(w.as('adm'), '/api/admin/orders/ORD-AMS'));
  assert.equal(after.order.serials.required, 0);
});

// ------------------------------------------------------------------ §32.3 / §18

test('§32.3/§18 two printers on one line and one on another: a slot per physical unit, each linked once', async () => {
  const w = world();
  order(w.raw, 'ORD-3', [{ id: 'l1', product: 'pA1', qty: 2 }, { id: 'l2', product: 'pX2D' }]);
  const detail = await json(await get(w.as('adm'), '/api/admin/orders/ORD-3'));
  assert.equal(detail.order.serials.installed, true);
  assert.equal(detail.order.serials.window, true);
  assert.deepEqual(
    detail.order.serials.slots.map((s: { order_item_id: string; unit_index: number }) => `${s.order_item_id}:${s.unit_index}`),
    ['l1:1', 'l1:2', 'l2:1']
  );
  for (const [item, unit, code] of [['l1', 1, SN], ['l1', 2, SN2], ['l2', 1, '00X01B123456789']] as const) {
    const r = await scan(w.as('adm'), 'ORD-3', item, unit, code);
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  }
  const after = await json(await get(w.as('adm'), '/api/admin/orders/ORD-3'));
  assert.equal(after.order.serials.linked, 3);
  assert.deepEqual(after.order.serials.missing, []);
  // §18: the same serial twice in one order (§32.4).
  const twice = await json(await scan(w.as('adm'), 'ORD-3', 'l1', 2, SN));
  assert.ok(['UNIT_ALREADY_LINKED', 'SERIAL_IN_USE_THIS_ORDER'].includes(twice.code));
});

test('§32.4 the same serial on a second unit of the same order: SERIAL_IN_USE_THIS_ORDER, still one live row', async () => {
  const w = world();
  order(w.raw, 'ORD-4', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  assert.equal((await scan(w.as('adm'), 'ORD-4', 'l1', 1, SN)).status, 200);
  const r = await scan(w.as('adm'), 'ORD-4', 'l1', 2, SN);
  const body = await json(r);
  assert.equal(r.status, 409);
  assert.equal(body.code, 'SERIAL_IN_USE_THIS_ORDER');
  assert.equal(body.details.unit_index, 1);
  assert.equal(live(w.raw, SN).length, 1);
});

// ------------------------------------------------------------------ §32.5 / §10

test('§32.5/§10 the same serial on another order: refused; the order number for the owner only', async () => {
  const w = world();
  order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
  order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }]);
  assert.equal((await scan(w.as('adm'), 'ORD-A', 'la', 1, SN)).status, 200);
  const asOwner = await json(await scan(w.as('boss'), 'ORD-B', 'lb', 1, SN));
  assert.equal(asOwner.code, 'SERIAL_IN_USE');
  assert.equal(asOwner.error, 'هذا الرقم التسلسلي مرتبط حالياً بطلب آخر.');
  assert.equal(asOwner.details.order_id, 'ORD-A');
  const asAssistant = await scan(w.as('ast'), 'ORD-B', 'lb', 1, SN);
  assert.equal(asAssistant.status, 409);
  assert.ok(!(await asAssistant.text()).includes('ORD-A'), 'an assistant never learns which order holds it');
  assert.equal(live(w.raw, SN).length, 1);
});

// ------------------------------------------------------------------ §32.6/7 §12/§13/§20

test('§32.6/§32.7 cancel releases (trigger, every door); the same serial links to a new order as EXISTING, one asset, history kept', async () => {
  const w = world();
  order(w.raw, 'ORD-111', [{ id: 'l1', product: 'pA1' }]);
  order(w.raw, 'ORD-222', [{ id: 'l2', product: 'pA1' }]);
  order(w.raw, 'ORD-333', [{ id: 'l3', product: 'pA1' }]);
  await scan(w.as('adm'), 'ORD-111', 'l1', 1, SN);
  // The stage door.
  const cancel = await patch(w.as('adm'), '/api/admin/orders/ORD-111/stage', { stage: 'cancelled' });
  assert.equal(cancel.status, 200, await cancel.clone().text());
  const released = row(w.raw, "SELECT * FROM serial_assignments WHERE order_id = 'ORD-111'")!;
  assert.equal(released.release_reason, 'order_cancelled');
  assert.equal(released.release_note, 'from:processing');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 1, 'the asset is kept');
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'serial.released' AND target = ?", SN));

  const again = await json(await scan(w.as('adm'), 'ORD-222', 'l2', 1, SN));
  assert.equal(again.outcome, 'existing');
  assert.equal(again.code, 'SERIAL_EXISTING_LINKED');
  assert.equal(again.message, 'الرقم موجود مسبقاً وتم ربطه بهذا الطلب.', '§31, the one wording (critique-1 #32)');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 1, 'never a second asset');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE serial_norm = ?', SN), 2);
  const linked = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.linked' ORDER BY id DESC LIMIT 1")!.detail);
  assert.equal(linked.previous_assignment, released.id, '§25 the previous assignment is named');

  // The legacy status door releases too.
  await scan(w.as('adm'), 'ORD-333', 'l3', 1, SN2);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-333', { status: 'cancelled' })).status, 200);
  assert.equal(live(w.raw, SN2).length, 0);

  // §20 the serial page tells the story newest first.
  const page = await json(await get(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(page.story.status, 'reserved');
  assert.equal(page.story.current_order.order_id, 'ORD-222');
  assert.deepEqual(page.story.previous_orders.map((p: { order_id: string }) => p.order_id), ['ORD-111']);
  const story = page.story.history.map((h: { action: string }) => h.action);
  assert.deepEqual(story.slice(0, 3), ['serial.linked', 'serial.released', 'serial.linked']);
  assert.equal(story[story.length - 1], 'serial_inventory.add');
  const masked = await json(await get(w.as('ast'), `/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(masked.story.serial, undefined);
  assert.match(masked.story.serial_display, /^\*{4}/);
  assert.equal(masked.story.current_order.order_id, null, 'no order numbers for an assistant');
});

// ------------------------------------------------------------------ §32.13 / H1

test('§32.13/H1 one canonicaliser: manual typing, an EAN of any length, a receipt, a short value, «SN 0391…», a box SN', async () => {
  const w = world();
  order(w.raw, 'ORD-M', [{ id: 'l1', product: 'pA1', qty: 3 }]);
  const a = w.as('adm');
  const typed = await json(await scan(a, 'ORD-M', 'l1', 1, '0391-9d58 0607841', { source: 'manual' }));
  assert.equal(typed.outcome, 'created');
  assert.ok(row(w.raw, 'SELECT 1 AS x FROM serial_inventory WHERE serial_norm = ?', SN));
  for (const [code, problem] of [
    [EAN, 'SERIAL_LOOKS_LIKE_EAN'],
    ['012345678905', 'SERIAL_LOOKS_LIKE_EAN'], // UPC-A
    ['WR-2026-0905-001', 'SERIAL_LOOKS_LIKE_RECEIPT'],
    ['A1B2', 'SERIAL_TOO_SHORT'],
    [BOX, 'BOX_ONLY'],
  ] as const) {
    const r = await scan(a, 'ORD-M', 'l1', 2, code);
    const body = await json(r);
    assert.equal(r.status, 400, code);
    assert.equal(body.code, 'SERIAL_INVALID');
    assert.equal(body.details.problem, problem, code);
  }
  // «SN 0391…» with only a space is the SAME device, not SN0391….
  assert.equal(classifyScanInput(`SN ${SN}`).kind === 'serial' && (classifyScanInput(`SN ${SN}`) as { norm: string }).norm, SN);
  assert.equal((await json(await scan(a, 'ORD-M', 'l1', 2, `SN ${SN}`))).code, 'SERIAL_IN_USE_THIS_ORDER');
  // A box SN the store knows resolves to its device.
  w.raw.exec(`UPDATE serial_inventory SET box_sn = '${BOX}' WHERE serial_norm = '${SN}'`);
  assert.equal((await json(await scan(a, 'ORD-M', 'l1', 2, BOX))).code, 'SERIAL_IN_USE_THIS_ORDER', 'resolved to SN through its box');
  // A new serial whose value is another asset's box SN is the same box read twice.
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, box_sn, created_by) VALUES ('03919D580600009','03919D580600009','03919D580600010','boss')`);
  const boxAsSerial = await json(await scan(a, 'ORD-M', 'l1', 3, '03919D580600010'));
  assert.equal(boxAsSerial.code, 'SERIAL_INVALID');
  assert.equal(boxAsSerial.details.problem, 'BOX_SN');
});

// ------------------------------------------------------------------ §32.14 / §20

test('§32.14/§20 unlink keeps the asset; a replay is `already`; change is atomic; after delivery or outside the window it is refused', async () => {
  const w = world();
  order(w.raw, 'ORD-U', [{ id: 'l1', product: 'pA1' }]);
  order(w.raw, 'ORD-V', [{ id: 'lv', product: 'pA1' }]);
  const a = w.as('adm');
  const first = await json(await scan(a, 'ORD-U', 'l1', 1, SN));
  const id = first.assignment_id;

  // Change to a serial that is in use elsewhere: refused, the old link intact.
  await scan(a, 'ORD-V', 'lv', 1, SN2);
  const bad = await json(await post(a, '/api/admin/orders/ORD-U/serials/change', { assignment_id: id, code: SN2, source: 'scanner', op_id: op() }));
  assert.equal(bad.code, 'SERIAL_IN_USE');
  assert.equal(row(w.raw, 'SELECT released_at FROM serial_assignments WHERE id = ?', id)!.released_at, null);

  // A good change: old released 'changed', new live, same slot.
  const changed = await json(await post(a, '/api/admin/orders/ORD-U/serials/change', { assignment_id: id, code: SN3, source: 'scanner', op_id: op() }));
  assert.equal(changed.success, true, JSON.stringify(changed));
  assert.equal(row(w.raw, 'SELECT release_reason FROM serial_assignments WHERE id = ?', id)!.release_reason, 'changed');
  // M11: the mistaken first scan had filed SN under pA1 — with no other history it is un-filed.
  assert.equal(row(w.raw, 'SELECT product_id FROM serial_inventory WHERE serial_norm = ?', SN)!.product_id, null);

  const un = await json(await post(a, '/api/admin/orders/ORD-U/serials/unlink', { assignment_id: changed.assignment_id }));
  assert.equal(un.code, 'SERIAL_UNLINKED');
  assert.equal(row(w.raw, 'SELECT release_reason FROM serial_assignments WHERE id = ?', changed.assignment_id)!.release_reason, 'unlinked');
  assert.ok(row(w.raw, 'SELECT 1 AS x FROM serial_inventory WHERE serial_norm = ?', SN3), 'the asset is never deleted');
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'serial.unlinked' AND target = ?", SN3));
  const replay = await json(await post(a, '/api/admin/orders/ORD-U/serials/unlink', { assignment_id: changed.assignment_id }));
  assert.equal(replay.already, true);

  // Outside the window: an assistant/admin is refused, the owner needs a reason.
  const again = await json(await scan(a, 'ORD-U', 'l1', 1, SN3));
  w.raw.exec(`UPDATE orders SET status = 'shipped', stage = 'out_for_delivery' WHERE id = 'ORD-U'`);
  assert.equal((await json(await post(a, '/api/admin/orders/ORD-U/serials/unlink', { assignment_id: again.assignment_id }))).code, 'ORDER_NOT_PREPARABLE');
  assert.equal((await json(await post(w.as('boss'), '/api/admin/orders/ORD-U/serials/unlink', { assignment_id: again.assignment_id }))).code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal((await json(await post(w.as('boss'), '/api/admin/orders/ORD-U/serials/unlink', { assignment_id: again.assignment_id, reason: 'wrong box packed' }))).success, true);
});

// ------------------------------------------------------------------ §32.15/16/17

test('§32.15 product mismatch: an asset filed under X2D never links to an A1 line; nor does an EAN learned for X2D', async () => {
  const w = world();
  order(w.raw, 'ORD-P', [{ id: 'l1', product: 'pA1' }]);
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN}','${SN}','pX2D','boss')`);
  const r = await scan(w.as('adm'), 'ORD-P', 'l1', 1, SN);
  const body = await json(r);
  assert.equal(r.status, 400);
  assert.equal(body.code, 'SERIAL_PRODUCT_MISMATCH');
  assert.equal(body.error, 'الرقم التسلسلي لا يطابق المنتج المحدد.');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0, 'nothing written');
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, ean, created_by) VALUES ('X2DLEARNT00001','X2DLEARNT00001','pX2D','${EAN}','boss')`);
  assert.equal((await json(await scan(w.as('adm'), 'ORD-P', 'l1', 1, SN2, { ean: EAN }))).code, 'SERIAL_PRODUCT_MISMATCH');
  // §17 serial model metadata: prefix 030 is the A1 mini family, not an «A1 Combo».
  assert.deepEqual(serialFamilyConflict('03000A123456789', ['Bambu Lab A1 Combo']), { serial_family: 'A1 mini', product_family: 'Bambu Lab A1 Combo' });
  assert.equal(serialFamilyConflict(SN, ['Bambu Lab A1 Combo']), null);
  const fam = await json(await scan(w.as('adm'), 'ORD-P', 'l1', 1, '03000A123456789'));
  assert.equal(fam.code, 'SERIAL_MODEL_MISMATCH');
  const ownerOk = await post(w.as('boss'), '/api/admin/orders/ORD-P/serials/override', {
    order_item_id: 'l1', unit_index: 1, code: '03000A123456789', kind: 'model_family', reason: 'relabelled box, checked', op_id: op(),
  });
  assert.equal(ownerOk.status, 200, await ownerOk.clone().text());
});

test('§32.16 variant mismatch: the Combo serial on a non-Combo line is refused; a variant-less asset adopts the line (audited)', async () => {
  const w = world();
  w.raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, sku) VALUES ('v_combo','pA1','o:ov_combo','A1-C'), ('v_solo','pA1','o:ov_solo','A1-S')`);
  order(w.raw, 'ORD-V', [{ id: 'l1', product: 'pA1', option_value_ids: ['ov_solo'] }, { id: 'l2', product: 'pA1', option_value_ids: ['ov_solo'] }]);
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, variant_id, created_by) VALUES ('${SN}','${SN}','pA1','v_combo','boss')`);
  assert.equal((await json(await scan(w.as('adm'), 'ORD-V', 'l1', 1, SN))).code, 'SERIAL_OPTION_MISMATCH');
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN2}','${SN2}','pA1','boss')`);
  assert.equal((await scan(w.as('adm'), 'ORD-V', 'l2', 1, SN2)).status, 200);
  assert.equal(row(w.raw, 'SELECT variant_id FROM serial_inventory WHERE serial_norm = ?', SN2)!.variant_id, 'v_solo');
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'serial_inventory.update' AND target = ?", SN2));
});

test('§32.17 batch: the serial must come from a lot this line was allocated; FIFO confirms, never chooses; no cost in any answer', async () => {
  const w = world();
  order(w.raw, 'ORD-L', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  w.raw.exec(`
    INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at)
      VALUES ('lotA','pA1','base','',5,3,700000,'received','2026-09-01T00:00:00.000Z'),
             ('lotB','pA1','base','',5,5,710000,'received','2026-09-10T00:00:00.000Z');
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, unit_cost_iqd, cogs_iqd, idempotency_key)
      VALUES ('al1','ORD-L','l1','lotA','base','',1,700000,700000,'alloc:ORD-L:l1:lotA');
    INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES
      ('${SN}','${SN}','pA1','boss'), ('${SN2}','${SN2}','pA1','boss'), ('${SN3}','${SN3}','pA1','boss');
    INSERT INTO stock_serial_links (serial_norm, lot_id, linked_by, linked_at) VALUES
      ('${SN}','lotB','boss','2026-09-10T00:00:00.000Z'), ('${SN2}','lotA','boss','2026-09-01T00:00:00.000Z'),
      ('${SN3}','lotA','boss','2026-09-01T00:00:00.000Z');
  `);
  const wrong = await scan(w.as('adm'), 'ORD-L', 'l1', 1, SN);
  const text = await wrong.text();
  assert.equal(wrong.status, 400);
  assert.equal(JSON.parse(text).code, 'SERIAL_BATCH_MISMATCH');
  assert.deepEqual(JSON.parse(text).details.expected_lots.map((l: { id: string }) => l.id), ['lotA']);
  assert.ok(!/cost|700000/i.test(text), 'never a cost figure');
  const right = await json(await scan(w.as('adm'), 'ORD-L', 'l1', 1, SN2));
  assert.equal(right.slot.assignment.lot.id, 'lotA');
  assert.equal(right.slot.assignment.lot_source, 'serial_link');
  // One allocated unit on lotA: a second serial cannot claim it (S8).
  assert.equal((await json(await scan(w.as('adm'), 'ORD-L', 'l1', 2, SN3))).code, 'SERIAL_BATCH_MISMATCH');
  // L11: the owner may record the exception — audited, nothing re-pinned.
  const ov = await post(w.as('boss'), '/api/admin/orders/ORD-L/serials/override', {
    order_item_id: 'l1', unit_index: 2, code: SN, kind: 'batch', reason: 'box from lot B by mistake, accepted', op_id: op(),
  });
  assert.equal(ov.status, 200, await ov.clone().text());
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'serial.override' AND target = ?", SN));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_item_inventory_allocations WHERE order_item_id = 'l1'"), 1, 'no allocation written');
});

// ------------------------------------------------------------------ §32.19 / §11 / §25

test('§32.19 owner overrides: everyone else is refused; a reason is required; take_from_order releases the other order and is audited', async () => {
  const w = world();
  order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
  order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }]);
  await scan(w.as('adm'), 'ORD-A', 'la', 1, SN);
  const body = { order_item_id: 'lb', unit_index: 1, code: SN, kind: 'take_from_order', op_id: op() };
  for (const who of ['adm', 'ast'] as const) {
    const r = await post(w.as(who), '/api/admin/orders/ORD-B/serials/override', { ...body, reason: 'customer swap ok' });
    assert.equal(r.status, 403);
    assert.equal((await json(r)).code, 'OWNER_ONLY');
  }
  assert.equal((await json(await post(w.as('boss'), '/api/admin/orders/ORD-B/serials/override', { ...body, reason: 'no' }))).code, 'OVERRIDE_REASON_REQUIRED');
  const ok = await post(w.as('boss'), '/api/admin/orders/ORD-B/serials/override', { ...body, reason: 'urgent customer, A re-picked' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const other = row(w.raw, "SELECT release_reason, release_note FROM serial_assignments WHERE order_id = 'ORD-A'")!;
  assert.equal(other.release_reason, 'owner_override');
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.override'")!.detail);
  assert.equal(audit.kind, 'take_from_order');
  assert.equal(audit.reason, 'urgent customer, A re-picked');
  assert.equal(audit.other_order_id, 'ORD-A');
  assert.ok(audit.new_assignment && audit.previous_assignment);
});

// ------------------------------------------------------------------ the window, its twin and M1

test('the scan window: TypeScript and SQL agree on every stage × status; outside it staff are refused', async () => {
  const w = world();
  const statuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
  let n = 0;
  for (const shipping of ['direct', 'preorder_air']) {
    for (const stage of [...new Set([...DIRECT_STAGES, ...PREORDER_STAGES, 'cancelled'])]) {
      for (const status of statuses) {
        const id = `W-${++n}`;
        w.raw.prepare(`INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage) VALUES (?,'u1',?,'{}','home','{}','cash',1,1400,1,0,?,?)`).run(id, status, shipping, stage);
        const sql = row<{ x: number }>(w.raw, `SELECT ${scanWindowSql('o')} AS x FROM orders o WHERE o.id = ?`, id)!.x === 1;
        assert.equal(sql, serialScanWindow(shipping, stage, status), `${shipping}/${stage}/${status}`);
      }
    }
  }
  order(w.raw, 'ORD-W', [{ id: 'l1', product: 'pA1' }], { status: 'pending', stage: 'received' });
  assert.equal((await json(await scan(w.as('adm'), 'ORD-W', 'l1', 1, SN))).code, 'ORDER_NOT_PREPARABLE');
  // M1: a tracked line whose stock was reserved but never deducted.
  order(w.raw, 'ORD-D', [{ id: 'ld', product: 'pA1' }]);
  w.raw.exec(`INSERT INTO inventory_ledger (id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key) VALUES ('lg1','pA1','base','','reserve',1,'ORD-D','reserve:ORD-D:ld:base:-')`);
  const notDeducted = await json(await scan(w.as('adm'), 'ORD-D', 'ld', 1, SN));
  assert.equal(notDeducted.code, 'ORDER_NOT_PREPARABLE');
  assert.equal(notDeducted.details.reason, 'stock_not_deducted');
  w.raw.exec(`INSERT INTO inventory_ledger (id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key) VALUES ('lg2','pA1','base','','deduct',1,'ORD-D','deduct:ORD-D:ld:base:-')`);
  assert.equal((await scan(w.as('adm'), 'ORD-D', 'ld', 1, SN)).status, 200);
});

// ------------------------------------------------------------------ hardened doors (§4.13)

test('§4.13 the existing doors cannot go round the rules', async () => {
  const w = world();
  order(w.raw, 'ORD-H', [{ id: 'lh', product: 'pA1' }]);
  await scan(w.as('adm'), 'ORD-H', 'lh', 1, SN);
  // A customer typing a reserved serial gets the one non-enumerating answer.
  w.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-OLD','u2','delivered','{}','home','{}','cash',1,1400,1,0,'2026-09-01T00:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES ('lo','ORD-OLD','pA1','A1',1,1,1);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
      VALUES ('unit_old1','ORD-OLD','lo','pA1','u2',1,'2026-09-01T00:00:00.000Z',12,'2026-09-01T00:00:00.000Z','2027-09-01T00:00:00.000Z');
  `);
  const claim = await post(w.as('u2'), '/api/devices/register', { serial: SN });
  assert.equal(claim.status, 404, 'a serial reserved for an order is nobody\'s to claim');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM device_serials WHERE serial_norm = ?', SN), 0);
  // The post-delivery door refuses it, and refuses what is not a serial.
  const assign = await json(await post(w.as('boss'), '/api/devices/admin/units/unit_old1/serial', { serial: SN }));
  assert.equal(assign.code, 'SERIAL_IN_USE');
  assert.equal((await json(await post(w.as('boss'), '/api/devices/admin/units/unit_old1/serial', { serial: EAN }))).code, 'SERIAL_INVALID');
  // Its own write is now a binding the indexes see.
  const ok = await post(w.as('boss'), '/api/devices/admin/units/unit_old1/serial', { serial: SN2 });
  assert.equal(ok.status, 200, await ok.clone().text());
  const post2 = row(w.raw, 'SELECT * FROM serial_assignments WHERE serial_norm = ?', SN2)!;
  assert.equal(post2.source, 'post_delivery');
  assert.equal(post2.unit_id, 'unit_old1');
  assert.ok(post2.activated_at);
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'device.serial_assign' AND target = 'unit_old1'"));
  // Moving a serial off an open warranty is the owner's.
  w.raw.exec(`INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
      VALUES ('unit_old2','ORD-OLD','lo','pA1','u2',2,'2026-09-01T00:00:00.000Z',12,'2026-09-01T00:00:00.000Z','2027-09-01T00:00:00.000Z')`);
  const move = await json(await post(w.as('adm'), '/api/devices/admin/units/unit_old2/serial', { serial: SN2, reassign: true, reason: 'typo on the order screen' }));
  assert.equal(move.code, 'OWNER_ONLY');
  // Inventory edits: void refused while bound; re-filing a serial with history is the owner's.
  assert.equal((await json(await post(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}/void`, { reason: 'label damaged' }))).code, 'SERIAL_IN_USE');
  const refile = await json(await patch(w.as('adm'), `/api/devices/admin/serial-inventory/${SN}`, { product_id: 'pX2D' }));
  assert.equal(refile.code, 'OWNER_ONLY');
  assert.equal((await patch(w.as('adm'), `/api/devices/admin/serial-inventory/${SN}`, { note: 'shelf 3' })).status, 200, 'notes stay open');
  // A closed (returned) unit gets no new receipt.
  w.raw.exec(`UPDATE order_item_units SET warranty_closed_at = '2026-10-01T00:00:00.000Z', warranty_closed_reason = 'returned' WHERE id = 'unit_old1'`);
  const receipt = await post(w.as('boss'), '/api/admin/warranties', { unit_id: 'unit_old1' });
  assert.equal(receipt.status, 409, await receipt.clone().text());
  assert.equal((await json(receipt)).code, 'WARRANTY_CLOSED');
});

// ------------------------------------------------------------------ M7

test('M7 a device stored under a pre-2026-09-26 key (Arabic-Indic digits) is still that delivered device', async () => {
  const w = world();
  order(w.raw, 'ORD-M7', [{ id: 'lm', product: 'pA1' }]);
  // The old normaliser kept Arabic-Indic digits and invisible marks in the key.
  const legacyKey = '٠٣٩١٩D580607841';
  w.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-L','u2','delivered','{}','home','{}','cash',1,1400,1,0,'2026-09-01T00:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES ('ll','ORD-L','pA1','A1',1,1,1);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
      VALUES ('unit_leg','ORD-L','ll','pA1','u2',1,'2026-09-01T00:00:00.000Z',12,'2026-09-01T00:00:00.000Z','2099-09-01T00:00:00.000Z');
  `);
  w.raw.prepare("INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES (?, ?, ?, 'boss')").run(legacyKey, legacyKey, 'unit_leg');
  const staff = await scan(w.as('adm'), 'ORD-M7', 'lm', 1, SN);
  assert.equal(staff.status, 409);
  const body = await json(staff);
  assert.equal(body.code, 'SERIAL_DELIVERED');
  assert.equal(body.details?.legacy_serial, undefined, 'the stored key is the owner\'s to see');
  assert.equal((await json(await scan(w.as('boss'), 'ORD-M7', 'lm', 1, SN))).details.legacy_serial, legacyKey);
  // The owner's override cannot move a key it does not hold: the unit's serial is re-entered first.
  const ov = await json(
    await post(w.as('boss'), '/api/admin/orders/ORD-M7/serials/override', {
      order_item_id: 'lm', unit_index: 1, code: SN, kind: 'delivered_device', reason: 'resold after inspection', op_id: op(),
    })
  );
  assert.equal(ov.code, 'OVERRIDE_UNAVAILABLE');
  assert.equal(ov.details.reason, 'legacy_serial_form');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 0, 'no second identity for the device');
  // Closed (returned) under its old key: not sellable until the key is rewritten.
  w.raw.exec(`UPDATE order_item_units SET warranty_closed_at = '2026-10-01T00:00:00.000Z', warranty_closed_reason = 'returned' WHERE id = 'unit_leg'`);
  const closed = await json(await scan(w.as('adm'), 'ORD-M7', 'lm', 1, SN));
  assert.equal(closed.code, 'SERIAL_NOT_AVAILABLE');
  assert.equal(closed.details.reason, 'legacy_serial_form');
});

// ------------------------------------------------------------------ deploy-ahead

test('deploy-ahead: before migration 0178 the screen still opens, the doors answer 503, and delivery is HEAD behaviour', async () => {
  const w = world({ through: BEFORE_SERIALS });
  order(w.raw, 'ORD-0', [{ id: 'l1', product: 'pA1' }]);
  const detail = await get(w.as('adm'), '/api/admin/orders/ORD-0');
  assert.equal(detail.status, 200);
  assert.equal((await json(detail)).order.serials.installed, false);
  const s = await scan(w.as('adm'), 'ORD-0', 'l1', 1, SN);
  assert.equal(s.status, 503);
  assert.equal((await json(s)).code, 'SERIALS_NOT_INSTALLED');
  const moved = await patch(w.as('adm'), '/api/admin/orders/ORD-0/stage', { stage: 'delivered' });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_item_units WHERE order_id = 'ORD-0'"), 1);
  assert.equal((await get(w.as('adm'), '/api/devices/admin/serial-inventory')).status, 200);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-0', { status: 'shipped' })).status, 200);
});
