/**
 * THE OWNER'S TWENTY TESTS (brief §32), AS ONE MAP — and the cases of them
 * the other serialPrep* files leave out.
 *
 * Each §32 item is a concrete case somewhere in tests/serialPrep*.test.ts or
 * tests/serialReturnWarranty.test.ts, named «§32.N …». The last test here
 * pins that: a §32 number without a test fails the suite, so the map cannot
 * quietly lose one. The cases in THIS file are the ones that need more than
 * one route to state: the camera read from pixels to binding (§32.11), the
 * USB / Bluetooth reader's keystrokes to binding (§32.12), slow typing
 * (§32.13), the whole two-printer order through the gate to its warranty units
 * (§32.3), the stock return beside the cancel (§32.6), the post-delivery
 * edges of removal (§32.14), the lot chosen and not chosen (§32.17), a
 * receipt-only delivered device (§32.9) and the whole timeline with its
 * actors (§32.20).
 *
 * Run: node --import tsx --test tests/serialPrepBrief.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { json, post, patch, put, get, row, count, all } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { world, order, op, SN, SN2, SN3, BOX, EAN } from './fixtures/serialPrep';
import { blank, code128Modules, drawModules, ean13Modules, type Luma } from './fixtures/barcodeImages';
import { decodeLuminance } from '../src/components/scanner/zxingReader';
import { CodeWindow, LABEL_REGIONS, cropLuminance } from '../src/components/scanner/decodeEngine';
import { WedgeTracker, isTerminator } from '../src/components/adminOrders/serials/wedge';
import { classifyLabel } from '../packages/catalog/src/deviceSerials';

type W = ReturnType<typeof world>;
type Who = 'boss' | 'adm' | 'ast';
const scan = (w: W, who: Who, o: string, item: string, unit: number, code: string, extra: Record<string, unknown> = {}) =>
  post(w.as(who), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: unit, code, source: 'scanner', op_id: op(), ...extra });

// ------------------------------------------------------------------ §32.11 the camera

/** The owner's label as printed: the Product SN wide across the top, the box SN and the EAN below. */
function label(): Luma {
  const img = blank(1100, 700);
  drawModules(img, code128Modules(SN), 60, 120, 4, 130);
  drawModules(img, code128Modules(BOX), 40, 400, 2, 120);
  drawModules(img, ean13Modules(EAN), 650, 400, 3, 120);
  return img;
}

test('§32.11 scan by camera: the label\'s pixels → the scanner\'s reader → the label classifier → the route, source camera, the companions kept', async () => {
  // What the camera sheet does, frame by frame: read regions, keep a short window, classify.
  const img = label();
  const window = new CodeWindow(1400);
  LABEL_REGIONS.forEach((r, tick) => {
    const part = cropLuminance(img.data, img.width, img.height, r);
    const hit = decodeLuminance(part.data, part.width, part.height);
    if (hit) window.add([{ text: hit.text, format: hit.format, y: part.top + hit.y }], tick * 110);
  });
  const read = classifyLabel(window.recent(4 * 110));
  assert.deepEqual(read, { productSn: SN, boxSn: BOX, ean: EAN, receipt: null }, 'the Product SN, never the box SN or the EAN');

  const w = world();
  order(w.raw, 'ORD-CAM', [{ id: 'l1', product: 'pA1' }]);
  order(w.raw, 'ORD-CAM2', [{ id: 'l2', product: 'pA1' }]);
  const res = await scan(w, 'ast', 'ORD-CAM', 'l1', 1, read.productSn!, { source: 'camera', ean: read.ean, box_sn: read.boxSn });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.outcome, 'created');
  assert.equal(body.message, 'تم ربط الرقم التسلسلي بالطلب.');
  assert.equal(row(w.raw, 'SELECT source FROM serial_assignments WHERE order_id = ?', 'ORD-CAM')!.source, 'camera');
  assert.deepEqual({ ...row(w.raw, 'SELECT source, box_sn, ean FROM serial_inventory WHERE serial_norm = ?', SN)! }, { source: 'scan', box_sn: BOX, ean: EAN });
  const linked = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.linked'")!.detail);
  assert.equal(linked.source, 'camera');
  // Later the camera catches only the box: it is the same device.
  assert.equal((await json(await scan(w, 'adm', 'ORD-CAM2', 'l2', 1, BOX, { source: 'camera' }))).code, 'SERIAL_IN_USE');
  // And the EAN alone is never a device.
  assert.equal((await json(await scan(w, 'adm', 'ORD-CAM2', 'l2', 1, EAN, { source: 'camera' }))).details.problem, 'SERIAL_LOOKS_LIKE_EAN');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory'), 1);
});

// ------------------------------------------------------------------ §32.12 the external reader

/** A USB / Bluetooth reader typing `text` through a keyboard layout, `gap` ms per key. */
function readerKeys(text: string, gap: number, layout: (ch: string) => string = (c) => c) {
  return [...text].map((ch, i) => ({
    code: /\d/.test(ch) ? `Digit${ch}` : /[A-Z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch === '-' ? 'Minus' : 'Space',
    key: layout(ch),
    shiftKey: false,
    timeStamp: 5000 + i * gap,
  }));
}

test('§32.12 an external barcode scanner: its burst — even through an Arabic keyboard layout, ended by Enter or Tab — links with source scanner', async () => {
  const w = world();
  order(w.raw, 'ORD-USB', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  // USB reader at ~8 ms a key on an Arabic layout: D arrives as «ي», B as «لا».
  const arabic: Record<string, string> = { D: 'ي', B: 'لا' };
  const t = new WedgeTracker();
  for (const k of readerKeys(SN, 8, (c) => arabic[c] ?? c)) t.push(k);
  assert.equal(isTerminator('Enter', t.inBurst), true);
  const usb = t.finish('03919ي580607841');
  assert.deepEqual(usb, { text: SN, source: 'scanner' }, 'rebuilt from the physical keys');
  const r1 = await scan(w, 'adm', 'ORD-USB', 'l1', 1, usb.text, { source: usb.source });
  assert.equal(r1.status, 200, await r1.clone().text());
  // A Bluetooth reader at ~30 ms that ends its read with Tab.
  const bt = new WedgeTracker();
  for (const k of readerKeys('03919-D58-0607842', 30)) bt.push(k);
  assert.equal(isTerminator('Tab', bt.inBurst), true, 'Tab ends a read only inside a burst');
  const read = bt.finish('03919-D58-0607842');
  assert.equal(read.source, 'scanner');
  const r2 = await scan(w, 'adm', 'ORD-USB', 'l1', 2, read.text, { source: read.source });
  assert.equal(r2.status, 200, await r2.clone().text());
  assert.deepEqual(all<{ source: string; serial_norm: string }>(w.raw, "SELECT source, serial_norm FROM serial_assignments WHERE order_id = 'ORD-USB' ORDER BY unit_index").map((a) => `${a.source}:${a.serial_norm}`), [`scanner:${SN}`, `scanner:${SN2}`]);
  assert.equal(row(w.raw, 'SELECT source FROM serial_inventory WHERE serial_norm = ?', SN)!.source, 'scan');
});

// ------------------------------------------------------------------ §32.13 typing

test('§32.13 manual entry: a person typing slowly (with a dash, a space, lower case) is `manual`; the value is the printed one, the key the canonical one', async () => {
  const w = world();
  order(w.raw, 'ORD-TYP', [{ id: 'l1', product: 'pA1' }]);
  const t = new WedgeTracker();
  for (const k of readerKeys('0391-9d58 0607841', 160)) t.push(k);
  const typed = t.finish('0391-9d58 0607841');
  assert.deepEqual(typed, { text: '0391-9d58 0607841', source: 'manual' }, 'a person keeps exactly what they typed');
  const body = await json(await scan(w, 'adm', 'ORD-TYP', 'l1', 1, typed.text, { source: typed.source }));
  assert.equal(body.outcome, 'created', JSON.stringify(body));
  const a = row<{ source: string; serial_raw: string; serial_norm: string }>(w.raw, "SELECT source, serial_raw, serial_norm FROM serial_assignments WHERE order_id = 'ORD-TYP'")!;
  assert.deepEqual({ ...a }, { source: 'manual', serial_raw: '0391-9d58 0607841', serial_norm: SN });
  assert.equal(row(w.raw, 'SELECT source FROM serial_inventory WHERE serial_norm = ?', SN)!.source, 'manual');
});

// ------------------------------------------------------------------ §32.3 the whole two-printer order

test('§32.3 an order with two printers on one line and one on another: three slots, the gate passes once all three are linked, three warranty units each with its own serial', async () => {
  const w = world();
  await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: true, since: '2026-01-01T00:00:00.000Z' } });
  order(w.raw, 'ORD-TWO', [{ id: 'l1', product: 'pA1', qty: 2 }, { id: 'l2', product: 'pX2D' }, { id: 'lp', product: 'pPLA', qty: 4 }]);
  await scan(w, 'adm', 'ORD-TWO', 'l1', 1, SN);
  await scan(w, 'ast', 'ORD-TWO', 'l1', 2, SN2);
  const held = await json(await patch(w.as('adm'), '/api/admin/orders/ORD-TWO/stage', { stage: 'out_for_delivery' }));
  assert.equal(held.code, 'SERIALS_REQUIRED');
  assert.deepEqual(held.details.missing.map((m: { order_item_id: string; unit_index: number }) => `${m.order_item_id}:${m.unit_index}`), ['l2:1']);
  await scan(w, 'adm', 'ORD-TWO', 'l2', 1, '00X01B123456789');
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-TWO/stage', { stage: 'out_for_delivery' })).status, 200);
  assert.equal((await patch(w.as('adm'), '/api/admin/orders/ORD-TWO/stage', { stage: 'delivered' })).status, 200);
  const units = all<{ order_item_id: string; unit_index: number; serial_norm: string }>(
    w.raw,
    "SELECT u.order_item_id, u.unit_index, d.serial_norm FROM order_item_units u LEFT JOIN device_serials d ON d.unit_id = u.id WHERE u.order_id = 'ORD-TWO' ORDER BY u.order_item_id, u.unit_index"
  );
  assert.deepEqual(units.map((u) => `${u.order_item_id}:${u.unit_index}:${u.serial_norm}`), [`l1:1:${SN}`, `l1:2:${SN2}`, 'l2:1:00X01B123456789'], 'the filament gets no unit');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_id = 'ORD-TWO' AND activated_at IS NOT NULL"), 3);
});

// ------------------------------------------------------------------ §32.6 the stock beside the cancel

test('§32.6 cancel before delivery: the binding is released by every door — even a raw status write — and the stock comes back exactly as without a serial', async () => {
  const w = world();
  w.raw.exec(`UPDATE products SET stock = 5 WHERE id = 'pA1'`);
  // Twin orders, one scanned and one not, each with its checkout reserve and its deduct.
  for (const [o, item] of [['ORD-S', 'ls'], ['ORD-N', 'ln']] as const) {
    order(w.raw, o, [{ id: item, product: 'pA1' }]);
    w.raw.exec(`
      INSERT INTO inventory_ledger (id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key)
        VALUES ('r_${o}','pA1','base','','reserve',1,'${o}','reserve:${o}:${item}:base:-'),
               ('d_${o}','pA1','base','','deduct',1,'${o}','deduct:${o}:${item}:base:-');
    `);
  }
  assert.equal((await scan(w, 'adm', 'ORD-S', 'ls', 1, SN)).status, 200);
  for (const o of ['ORD-S', 'ORD-N']) assert.equal((await patch(w.as('adm'), `/api/admin/orders/${o}/stage`, { stage: 'cancelled' })).status, 200);
  const effects = (o: string) =>
    all<{ kind: string; qty: number }>(w.raw, "SELECT kind, qty FROM inventory_ledger WHERE order_id = ? ORDER BY rowid", o).map((x) => `${x.kind}:${x.qty}`);
  assert.deepEqual(effects('ORD-S'), ['reserve:1', 'deduct:1', 'restore:1'], 'the unit goes back on the shelf');
  assert.deepEqual(effects('ORD-S'), effects('ORD-N'), 'the serial changes nothing about the stock return (§26)');
  assert.equal(row(w.raw, "SELECT stock FROM products WHERE id = 'pA1'")!.stock, 7, 'one unit back from each order — never twice');
  assert.equal(row(w.raw, "SELECT release_reason FROM serial_assignments WHERE order_id = 'ORD-S'")!.release_reason, 'order_cancelled');
  assert.equal(row(w.raw, `SELECT status FROM (SELECT CASE WHEN EXISTS (SELECT 1 FROM serial_assignments WHERE serial_norm = '${SN}' AND released_at IS NULL) THEN 'reserved' ELSE 'in_stock' END AS status)`)!.status, 'in_stock');

  // A door with no route at all — a sweep's raw UPDATE — releases too (the trigger).
  order(w.raw, 'ORD-RAW', [{ id: 'lr', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-RAW', 'lr', 1, SN2);
  w.raw.exec(`UPDATE orders SET status = 'cancelled', updated_at = '2026-10-08T00:00:00.000Z' WHERE id = 'ORD-RAW'`);
  const raw = row<{ release_reason: string; release_note: string; released_by: string | null }>(w.raw, "SELECT release_reason, release_note, released_by FROM serial_assignments WHERE order_id = 'ORD-RAW'")!;
  assert.deepEqual({ ...raw }, { release_reason: 'order_cancelled', release_note: 'from:processing', released_by: null });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm IN (?, ?)', SN, SN2), 2, 'both assets kept');
  const page = await json(await get(w.as('boss'), `/api/devices/admin/serial-inventory/${SN2}`));
  assert.equal(page.story.status, 'in_stock', 'the serial returns to available');
});

// ------------------------------------------------------------------ §32.14 after delivery

test('§32.14 remove during preparation only: after delivery neither remove nor change touches the delivered binding — the way is a return or the owner', async () => {
  const w = world();
  order(w.raw, 'ORD-RM', [{ id: 'l1', product: 'pA1' }]);
  const a = await json(await scan(w, 'adm', 'ORD-RM', 'l1', 1, SN));
  await patch(w.as('adm'), '/api/admin/orders/ORD-RM/stage', { stage: 'delivered' });
  for (const who of ['adm', 'boss'] as const) {
    const un = await json(await post(w.as(who), '/api/admin/orders/ORD-RM/serials/unlink', { assignment_id: a.assignment_id, reason: 'trying after delivery' }));
    assert.equal(un.code, 'SERIAL_ALREADY_ACTIVATED', who);
    const ch = await json(await post(w.as(who), '/api/admin/orders/ORD-RM/serials/change', { assignment_id: a.assignment_id, code: SN2, source: 'manual', op_id: op() }));
    assert.equal(ch.code, 'ORDER_NOT_PREPARABLE', who);
  }
  assert.equal(row(w.raw, 'SELECT released_at FROM serial_assignments WHERE id = ?', a.assignment_id)!.released_at, null);
  assert.equal(row(w.raw, 'SELECT serial_norm FROM device_serials')!.serial_norm, SN);
});

// ------------------------------------------------------------------ §32.17 the lot

test('§32.17 the lot: with no serial→lot link the line\'s allocated lot is noted but never written onto the warranty as fact; with no lots at all, nothing', async () => {
  const w = world();
  order(w.raw, 'ORD-AL', [{ id: 'la', product: 'pA1' }]);
  order(w.raw, 'ORD-NO', [{ id: 'ln', product: 'pA1' }]);
  w.raw.exec(`
    INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, cost_basis, received_at)
      VALUES ('lotA','pA1','base','',3,2,'received','2026-09-01T00:00:00.000Z');
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, idempotency_key)
      VALUES ('al1','ORD-AL','la','lotA','base','',1,'alloc:ORD-AL:la:lotA');
  `);
  const inferred = await json(await scan(w, 'adm', 'ORD-AL', 'la', 1, SN));
  assert.equal(inferred.slot.assignment.lot.id, 'lotA');
  assert.equal(inferred.slot.assignment.lot_source, 'allocation', 'FIFO\'s choice, labelled as such');
  const none = await json(await scan(w, 'adm', 'ORD-NO', 'ln', 1, SN2));
  assert.equal(none.slot.assignment.lot, null);
  assert.equal(none.slot.assignment.lot_source, null);
  for (const o of ['ORD-AL', 'ORD-NO']) await patch(w.as('adm'), `/api/admin/orders/${o}/stage`, { stage: 'delivered' });
  assert.deepEqual(all<{ inventory_lot_id: string | null }>(w.raw, "SELECT inventory_lot_id FROM order_item_units WHERE order_id IN ('ORD-AL','ORD-NO') ORDER BY order_id").map((u) => u.inventory_lot_id), [null, null], 'L12: only a serial-verified lot becomes the unit\'s lot');
});

// ------------------------------------------------------------------ §32.9 a receipt alone

test('§32.9 a device known only by a live warranty receipt (no unit link yet) is a delivered device too', async () => {
  const w = world();
  order(w.raw, 'ORD-RC', [{ id: 'l1', product: 'pA1' }]);
  w.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-OLD','u2','delivered','{}','home','{}','cash',1,1400,1,0,'2026-08-01T00:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES ('lo','ORD-OLD','pA1','A1',1,1,1);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_start_at, warranty_end_at)
      VALUES ('unit_old','ORD-OLD','lo','pA1','u2',1,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z','2027-08-01T00:00:00.000Z');
    INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, serial_norm, serial_raw, status)
      VALUES ('wr_old','WR-2026-0801-001','unit_old','ORD-OLD','lo','${SN3}','${SN3}','active');
  `);
  const staff = await scan(w, 'adm', 'ORD-RC', 'l1', 1, SN3);
  assert.equal(staff.status, 409);
  assert.equal((await json(staff)).code, 'SERIAL_DELIVERED');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0);
});

// ------------------------------------------------------------------ §32.20 the whole timeline

test('§32.20 audit history: added → linked ORD-111 → released (cancelled) → linked ORD-222 → warranty activated, newest first, each with its actor and the §25 keys', async () => {
  const w = world();
  order(w.raw, 'ORD-111', [{ id: 'l1', product: 'pA1' }]);
  order(w.raw, 'ORD-222', [{ id: 'l2', product: 'pA1' }]);
  const first = await json(await scan(w, 'adm', 'ORD-111', 'l1', 1, SN));
  await patch(w.as('adm'), '/api/admin/orders/ORD-111/stage', { stage: 'cancelled' });
  const second = await json(await scan(w, 'ast', 'ORD-222', 'l2', 1, SN));
  assert.equal(second.outcome, 'existing');
  await patch(w.as('boss'), '/api/admin/orders/ORD-222/stage', { stage: 'delivered' });

  const page = await json(await get(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}`));
  const serialRows = page.story.history.filter((h: { action: string }) => h.action.startsWith('serial'));
  assert.deepEqual(
    serialRows.map((h: { action: string }) => h.action),
    ['serial.warranty_activated', 'serial.linked', 'serial.released', 'serial.linked', 'serial_inventory.add'],
    'the whole story, newest first'
  );
  const [activated, relinked, released, linked, added] = serialRows;
  // Who: each row its actor; the trigger's release is attributed through the order's own history (§25).
  assert.equal(added.actor.id, 'adm');
  assert.equal(linked.actor.id, 'adm');
  assert.equal(released.actor.id, 'adm');
  assert.equal(released.actor.via, 'order_status_history');
  assert.equal(relinked.actor.id, 'ast');
  assert.equal(activated.actor, null, 'delivery activation is the system');
  // What: the §25 keys on each.
  for (const k of ['assignment_id', 'order_id', 'order_item_id', 'unit_index', 'source', 'previous_assignment']) assert.ok(k in linked.detail, `linked has ${k}`);
  assert.equal(linked.detail.order_id, 'ORD-111');
  assert.equal(linked.detail.previous_assignment, null);
  assert.deepEqual(
    { order_id: released.detail.order_id, reason: released.detail.reason, assignment_id: released.detail.assignment_id, from: released.detail.from_status },
    { order_id: 'ORD-111', reason: 'order_cancelled', assignment_id: first.assignment_id, from: 'processing' }
  );
  assert.equal(relinked.detail.order_id, 'ORD-222');
  assert.equal(relinked.detail.previous_assignment, first.assignment_id, 'previous → new assignment');
  assert.equal(relinked.detail.previous_order_id, 'ORD-111');
  assert.equal(activated.detail.order_id, 'ORD-222');
  const unit = row<{ id: string; delivered_at: string; warranty_end_at: string }>(w.raw, "SELECT id, delivered_at, warranty_end_at FROM order_item_units WHERE order_id = 'ORD-222'")!;
  assert.equal(activated.detail.unit_id, unit.id, 'the unit identifier');
  assert.equal(activated.detail.warranty_start_at, unit.delivered_at);
  assert.equal(activated.detail.warranty_end_at, unit.warranty_end_at);
  // When: every row is stamped, newest first.
  const stamps = page.story.history.map((h: { created_at: string }) => h.created_at);
  assert.deepEqual([...stamps].sort().reverse(), stamps);
  // The page around it (§16).
  assert.equal(page.story.status, 'sold');
  assert.equal(page.story.current_order.order_id, 'ORD-222');
  assert.deepEqual(page.story.previous_orders.map((p: { order_id: string; reason: string }) => `${p.order_id}:${p.reason}`), ['ORD-111:order_cancelled']);
  assert.equal(page.story.warranty.state, 'ACTIVE');
  assert.equal(page.story.product.id, 'pA1');
});

// ------------------------------------------------------------------ the map itself

test('the map: every one of the brief\'s twenty tests (§32.1–§32.20) is a named test in the serial suites', () => {
  const files = readdirSync(join(ROOT, 'tests')).filter((f) => /^serial(Prep\w*|ReturnWarranty)\.test\.ts$/.test(f));
  assert.ok(files.length >= 8, files.join(', '));
  const names = files.flatMap((f) => [...readFileSync(join(ROOT, 'tests', f), 'utf8').matchAll(/^test\((['"`])(.*?)\1/gm)].map((m) => m[2]));
  const covered = new Set<number>();
  for (const n of names) for (const m of n.matchAll(/§32\.(\d+)/g)) covered.add(Number(m[1]));
  const missing = Array.from({ length: 20 }, (_, i) => i + 1).filter((n) => !covered.has(n));
  assert.deepEqual(missing, [], `§32 items with no test: ${missing.join(', ')}`);
});
