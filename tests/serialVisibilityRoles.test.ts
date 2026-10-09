/**
 * OWNER DECISION 1 (2026-10-09; DECISIONS row 192) — WHO SEES THE WHOLE
 * SERIAL, AND WHO MAY ADD ONE — through the real routes over the real
 * migrations (the serialPrep world; only the session is stubbed).
 *
 *   «Assistant admins see the FULL serial and can add it per their work
 *   permissions. The preparer can scan and add the serial during order
 *   preparation … Support can see the full serial … Any sensitive edit or
 *   exceptional override stays under the current permission and audit
 *   system.»
 *
 * Roles on top of the world's boss (owner), adm (full) and ast (assistant,
 * no permission row):
 *   prep — the preparer: an assistant with an explicit `receive = 1`
 *   sup  — support: an assistant whose `receive` the owner revoked (`= 0`)
 *   mer  — a merchant; and an anonymous visitor
 *
 *   1. every admin reads the whole serial on every admin serial surface;
 *      order numbers on the serial page and in every history follow
 *      canMoveMoney (option A) — one receipt's own record keeps its
 *      `order_id`, the documented exception (docs/SERIAL_SCAN.md);
 *   2. customers, merchants and visitors see what they saw before;
 *   3. adding, changing or removing a serial follows `receive`, refused as
 *      SERIAL_WRITE_NOT_ALLOWED in three languages — a warranty replacement
 *      that names a new serial included; edits keep their own gates;
 *   4. every exception stays the owner's, audited in its own batch;
 *   5. no cost reaches the newly unmasked roles;
 *   6. the predicate, and the static nets that keep a serial apart from cost.
 *
 * Run: node --import tsx --test tests/serialVisibilityRoles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { json, post, patch, put, get, row, count, stubApp, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { codeOf } from './fixtures/source';
import { world, order, op, mountSerialWorld, USERS, SN, SN2, SN3, BOX } from './fixtures/serialPrep';
import { OVERRIDE_KINDS } from '../worker/lib/serialAssignments';
import { SERIAL_WRITE_NOT_ALLOWED_TEXT } from '../worker/lib/operations';
import { maskSerial } from '../worker/lib/deviceOps';
import { canSeeFullSerial, canMoveMoney, FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import { supportRoutes } from '../worker/routes/support';
import { warrantyPublicRoutes } from '../worker/routes/warranty';

const SN4 = '03919D580607844';
const SN5 = '03919D580607845';

const MORE: Record<'prep' | 'sup' | 'mer', StubUser> = {
  prep: { id: 'prep', role: 'admin', email: 'prep@x.co', admin_scope: 'assistant' },
  sup: { id: 'sup', role: 'admin', email: 'sup@x.co', admin_scope: 'assistant' },
  mer: { id: 'mer', role: 'merchant', email: 'mer@x.co' },
};
type Who = keyof typeof USERS | keyof typeof MORE | 'anon';
type W = ReturnType<typeof world>;
const ADMINS = ['boss', 'adm', 'ast', 'prep', 'sup'] as const;
const MONEY = new Set<Who>(['boss', 'adm']);

/** The serial world plus the public doors a customer and a visitor use. */
const mountAll = (a: Hono<AppContext>) => {
  mountSerialWorld(a);
  a.route('/api/support', supportRoutes);
  a.route('/api/warranty', warrantyPublicRoutes);
};

function roles(w: W) {
  w.raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('prep','Preparer','prep@x.co','h','admin','assistant'),
      ('sup','Support','sup@x.co','h','admin','assistant'),
      ('mer','Merchant','mer@x.co','h','merchant',NULL);
    INSERT INTO ops_permissions (user_id, capability, allowed) VALUES ('prep','receive',1), ('sup','receive',0);
  `);
  return (who: Who) => stubApp(w.db, who === 'anon' ? null : ((USERS as Record<string, StubUser>)[who] ?? MORE[who as keyof typeof MORE]), mountAll);
}

const scanBody = (item: string, unit: number, code: string) => ({ order_item_id: item, unit_index: unit, code, source: 'scanner', op_id: op() });

// ====================================================================== 1

test('decision 1 matrix: the owner, a full admin, an assistant, the preparer and support read the whole serial on every admin serial surface; order numbers on the serial page and in every history follow canMoveMoney', async () => {
  const w = world();
  const as = roles(w);
  order(w.raw, 'ORD-VIS', [{ id: 'l1', product: 'pA1', qty: 4 }]);

  // The scan answer: everyone who may add a serial gets it back whole.
  const scanned: Array<[Who, string]> = [['boss', SN], ['adm', SN2], ['ast', SN3], ['prep', SN4]];
  for (const [i, [who, code]] of scanned.entries()) {
    const res = await post(as(who), '/api/admin/orders/ORD-VIS/serials/scan', scanBody('l1', i + 1, code));
    const body = await json(res);
    assert.equal(res.status, 200, `${who}: ${JSON.stringify(body)}`);
    assert.equal(body.slot.assignment.serial_full, code, who);
    assert.equal(body.slot.assignment.serial_display, code, who);
  }
  const all = [SN, SN2, SN3, SN4];

  // The order window and the serials door, before delivery.
  for (const who of ADMINS) {
    for (const path of ['/api/admin/orders/ORD-VIS', '/api/admin/orders/ORD-VIS/serials']) {
      const body = await json(await get(as(who), path));
      const slots = (body.order?.serials ?? body.serials).slots as Array<{ assignment: { serial_full?: string; serial_display: string } }>;
      assert.deepEqual(slots.map((s) => s.assignment.serial_full), all, `${who} ${path}`);
      assert.deepEqual(slots.map((s) => s.assignment.serial_display), all, `${who} ${path}`);
    }
  }

  // Delivered: units, a receipt, and history rows that name another device and the order.
  assert.equal((await patch(as('boss'), '/api/admin/orders/ORD-VIS/stage', { stage: 'delivered' })).status, 200);
  const unit = row<{ id: string }>(w.raw, 'SELECT u.id FROM order_item_units u JOIN device_serials d ON d.unit_id = u.id WHERE d.serial_norm = ?', SN)!;
  assert.ok(unit, 'delivery made the unit');
  w.raw.exec(`
    INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id, serial_norm, serial_raw, status)
      VALUES ('wr_vis','LV-W-000777','${unit.id}','ORD-VIS','l1','pA1','u1','${SN}','${SN}','active');
    INSERT INTO audit_log (actor_id, action, target, detail) VALUES
      ('boss','device.serial_reassign','${unit.id}','{"serial_norm":"${SN}","detached_serial":"${SN5}","order_id":"ORD-VIS","reason":"swap"}'),
      ('boss','warranty.replaced','wr_vis','{"replaced_serial":"${SN5}","new_serial":"${SN}","order_id":"ORD-VIS"}'),
      ('boss','serial_inventory.update','${SN}','{"from":{"box_sn":"${BOX}","order_id":"ORD-VIS"},"to":{"box_sn":null}}');
  `);

  for (const who of ADMINS) {
    const money = MONEY.has(who);
    const tag = `${who} (${money ? 'order numbers' : 'no order numbers'})`;

    // The serial page: row, story and every history line.
    const page = await json(await get(as(who), `/api/devices/admin/serial-inventory/${SN}`));
    assert.equal(page.success, true, `${tag}: ${JSON.stringify(page)}`);
    assert.equal(page.row.serial, SN, tag);
    assert.equal(page.row.serial_norm, SN, tag);
    assert.equal(page.story.serial, SN, tag);
    assert.equal(page.story.serial_norm, SN, tag);
    assert.equal(page.story.serial_display, SN, tag);
    const update = page.history.find((h: { action: string }) => h.action === 'serial_inventory.update');
    assert.equal(update.detail.from.box_sn, BOX, `${tag}: the box SN in a history line is whole`);
    assert.equal(page.story.current_order.order_id, money ? 'ORD-VIS' : null, tag);
    assert.equal(page.row.unit?.order_id ?? null, money ? 'ORD-VIS' : null, tag);
    assert.equal(update.detail.from.order_id, money ? 'ORD-VIS' : null, tag);
    assert.equal(JSON.stringify(page).includes('ORD-VIS'), money, `${tag}: the order number anywhere on the page`);

    // The unit history.
    const hist = await json(await get(as(who), `/api/devices/admin/units/${unit.id}/history`));
    assert.deepEqual(hist.history[0].detail, { serial_norm: SN, detached_serial: SN5, order_id: money ? 'ORD-VIS' : null, reason: 'swap' }, tag);

    // The receipt and its history. The history follows canMoveMoney; the
    // receipt's OWN record keeps its order number for every admin — the
    // documented exception (docs/SERIAL_SCAN.md, the assistants' answer:
    // receipts are found by serial, phone or order), pinned here so a change
    // to it is a decision, not a drift.
    const receipt = await json(await get(as(who), '/api/admin/warranties/wr_vis'));
    assert.equal(receipt.success, true, tag);
    assert.ok(JSON.stringify(receipt.receipt).includes(SN), `${tag}: the receipt's own serial`);
    assert.equal(receipt.receipt.order_id, 'ORD-VIS', `${tag}: the receipt's own record names its order (documented exception)`);
    const replaced = (receipt.history as Array<{ action: string; detail: Record<string, unknown> }>).find((h) => h.action === 'warranty.replaced')!;
    assert.deepEqual(replaced.detail, { replaced_serial: SN5, new_serial: SN, order_id: money ? 'ORD-VIS' : null }, tag);

    // «أجهزة الطلبات», the admin unit lookup and the inventory list.
    const orderUnits = JSON.stringify(await json(await get(as(who), '/api/devices/admin/orders/ORD-VIS/units')));
    for (const s of all) assert.ok(orderUnits.includes(s), `${tag}: ${s} in the order's devices`);
    const lookup = await json(await get(as(who), `/api/devices/admin/units?serial=${SN}`));
    assert.equal(lookup.units[0]?.serial, SN, `${tag}: the unit lookup`);
    const list = JSON.stringify(await json(await get(as(who), '/api/devices/admin/serial-inventory?limit=50')));
    for (const s of all) assert.ok(list.includes(s), `${tag}: ${s} in the inventory list`);

    // The order's serials after delivery.
    const after = await json(await get(as(who), '/api/admin/orders/ORD-VIS/serials'));
    assert.deepEqual(after.serials.slots.map((s: { assignment: { serial_full?: string } }) => s.assignment.serial_full), all, tag);
  }
});

// ====================================================================== 2

test('decision 1 leaves customers, merchants and visitors exactly where they were: masked, 404, or refused', async () => {
  const w = world();
  const as = roles(w);
  order(w.raw, 'ORD-CU', [{ id: 'l1', product: 'pA1' }]);
  assert.equal((await post(as('prep'), '/api/admin/orders/ORD-CU/serials/scan', scanBody('l1', 1, SN))).status, 200);
  assert.equal((await patch(as('boss'), '/api/admin/orders/ORD-CU/stage', { stage: 'delivered' })).status, 200);
  const unit = row<{ id: string }>(w.raw, 'SELECT u.id FROM order_item_units u JOIN device_serials d ON d.unit_id = u.id WHERE d.serial_norm = ?', SN)!;
  w.raw.exec(`
    INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id, serial_norm, serial_raw, status)
      VALUES ('wr_cu','LV-W-000778','${unit.id}','ORD-CU','l1','pA1','u1','${SN}','${SN}','active');
    INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, subject, evidence, stage, status, priority)
      VALUES ('cl_cu','u1','l1','A1 Combo','It stopped heating','${unit.id}','Heater','[]','received','submitted',0);
  `);

  // u1 links the device bought on their order, then reads it everywhere a customer can.
  const linked = await post(as('u1'), `/api/devices/units/${unit.id}/register`, {});
  assert.equal(linked.status, 200, await linked.clone().text());
  const masked = maskSerial(SN);
  const mine = await json(await get(as('u1'), '/api/devices/mine'));
  assert.equal(mine.devices?.[0]?.serial ?? mine.units?.[0]?.serial, masked, JSON.stringify(mine).slice(0, 400));
  const units = await json(await get(as('u1'), '/api/orders/ORD-CU/units'));
  assert.equal(units.units[0].serial, masked);
  const claim = await get(as('u1'), '/api/devices/claims/cl_cu');
  assert.equal(claim.status, 200);
  const card = await json(await post(as('u1'), '/api/support/assistant', { intent: 'my_devices', locale: 'ar' }));
  assert.ok(JSON.stringify(card).includes(masked), `the support card shows the masked serial: ${JSON.stringify(card).slice(0, 400)}`);
  for (const [label, res] of [
    ['mine', JSON.stringify(mine)],
    ['order units', JSON.stringify(units)],
    ['claim', await claim.text()],
    ['support card', JSON.stringify(card)],
  ] as const) assert.equal(res.includes(SN), false, `${label}: a customer never reads the whole serial`);

  // u2 on u1's order and claim, and registering u1's serial.
  assert.equal((await get(as('u2'), '/api/orders/ORD-CU/units')).status, 404);
  assert.equal((await get(as('u2'), '/api/devices/claims/cl_cu')).status, 404);
  const taken = await post(as('u2'), '/api/devices/register', { serial: SN });
  assert.equal(taken.status, 404);
  assert.equal((await json(taken)).code, 'SERIAL_NOT_FOUND_OR_IN_USE');

  // A merchant and a visitor never reach an admin serial door.
  const doors: Array<[string, string, unknown]> = [
    ['GET', `/api/devices/admin/units?serial=${SN}`, null],
    ['GET', `/api/devices/admin/units/${unit.id}/history`, null],
    ['GET', '/api/devices/admin/orders/ORD-CU/units', null],
    ['POST', `/api/devices/admin/units/${unit.id}/serial`, { serial: SN2 }],
    ['GET', '/api/admin/orders/ORD-CU/serials', null],
    ['POST', '/api/admin/orders/ORD-CU/serials/scan', scanBody('l1', 1, SN2)],
    ['POST', '/api/admin/orders/ORD-CU/serials/override', { ...scanBody('l1', 1, SN2), kind: 'outside_window', reason: 'let me in please' }],
    ['GET', '/api/devices/admin/serial-inventory', null],
    ['GET', `/api/devices/admin/serial-inventory/${SN}`, null],
    ['POST', '/api/devices/admin/serial-inventory/scan', { serial: SN2 }],
    ['POST', '/api/devices/admin/serial-inventory/commit', { text: SN2 }],
    ['GET', '/api/admin/warranties', null],
    ['GET', '/api/admin/warranties/wr_cu', null],
  ];
  for (const who of ['mer', 'anon', 'u2'] as const) {
    for (const [method, path, body] of doors) {
      const r = await as(who).request(path, {
        method,
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.ok([401, 403, 404].includes(r.status), `${who} ${method} ${path} → ${r.status}`);
      assert.equal((await r.text()).includes(SN), false, `${who} ${method} ${path}: nothing about the serial`);
    }
  }
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = '${SN2}'`), 0, 'nothing was added');

  // The anonymous verification page shows the last four only.
  const verify = await get(as('anon'), `/api/warranty/verify/${SN}`);
  const vText = await verify.text();
  assert.equal(verify.status, 200, vText);
  assert.ok(vText.includes(masked) && !vText.includes(SN), vText);
});

// ====================================================================== 3

test('decision 1 writes: adding, changing or removing a serial follows `receive` on every door — refused as SERIAL_WRITE_NOT_ALLOWED; edits keep their gates; the owner is never refused', async () => {
  const w = world();
  const as = roles(w);
  w.raw.exec(`INSERT INTO ops_permissions (user_id, capability, allowed) VALUES ('boss','receive',0)`);
  order(w.raw, 'ORD-W', [{ id: 'l1', product: 'pA1', qty: 3 }]);
  const linked = await json(await post(as('prep'), '/api/admin/orders/ORD-W/serials/scan', scanBody('l1', 1, SN)));
  assert.equal(linked.success, true, JSON.stringify(linked));

  // Support (receive = 0) is refused every door that adds, changes or removes a serial.
  const supDoors: Array<[string, unknown]> = [
    ['/api/admin/orders/ORD-W/serials/scan', scanBody('l1', 2, SN2)],
    ['/api/admin/orders/ORD-W/serials/change', { assignment_id: linked.assignment_id, code: SN2, source: 'scanner', op_id: op() }],
    ['/api/admin/orders/ORD-W/serials/unlink', { assignment_id: linked.assignment_id }],
    ['/api/devices/admin/serial-inventory/commit', { text: SN3, source: 'bulk' }],
    ['/api/devices/admin/serial-inventory/scan', { serial: SN3 }],
    ['/api/devices/admin/serial-inventory/link-ean', { ean: '6977252425445', product_id: 'pA1' }],
  ];
  for (const [path, body] of supDoors) {
    const r = await post(as('sup'), path, body);
    assert.equal(r.status, 403, `sup ${path}: ${await r.clone().text()}`);
    // Its own code, so every serial screen can say why in the admin's
    // language — not FORBIDDEN, which the inventory panel read as "try again".
    const refused = await json(r);
    assert.equal(refused.code, 'SERIAL_WRITE_NOT_ALLOWED', `sup ${path}`);
    assert.equal(refused.error ?? refused.message, SERIAL_WRITE_NOT_ALLOWED_TEXT, `sup ${path}: the server's sentence`);
  }
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm IN ('${SN2}','${SN3}')`), 0, 'nothing was added');
  assert.equal(row(w.raw, 'SELECT released_at FROM serial_assignments WHERE id = ?', linked.assignment_id)!.released_at, null, 'the link is intact');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = 'sup'"), 0);

  // Reading is not adding.
  assert.equal((await get(as('sup'), '/api/admin/orders/ORD-W/serials')).status, 200);
  assert.equal((await get(as('sup'), `/api/devices/admin/serial-inventory/${SN}`)).status, 200);

  // Not NEWLY refused: PATCH, void and restore keep their own gates (a serial with no history).
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, created_by) VALUES ('${SN5}','${SN5}','boss')`);
  assert.equal((await patch(as('sup'), `/api/devices/admin/serial-inventory/${SN5}`, { note: 'shelf B' })).status, 200);
  assert.equal((await post(as('sup'), `/api/devices/admin/serial-inventory/${SN5}/void`, { reason: 'damaged in storage' })).status, 200);
  assert.equal((await post(as('sup'), `/api/devices/admin/serial-inventory/${SN5}/restore`, { reason: 'found it was fine' })).status, 200);

  // The preparer (receive = 1) and an assistant with no row add serials on every door.
  assert.equal((await post(as('ast'), '/api/admin/orders/ORD-W/serials/scan', scanBody('l1', 2, SN2))).status, 200);
  for (const [who, code] of [['prep', SN3], ['ast', SN4]] as const) {
    const sc = await json(await post(as(who), '/api/devices/admin/serial-inventory/scan', { serial: code }));
    assert.match(String(sc.outcome), /^added/, `${who}: ${JSON.stringify(sc)}`);
    assert.equal(sc.row.serial, code, `${who} gets the whole serial back`);
  }
  const commit = await post(as('prep'), '/api/devices/admin/serial-inventory/commit', { text: '03919D580607846', source: 'bulk' });
  assert.equal(commit.status, 200, await commit.clone().text());
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, ean, created_by) VALUES ('03919D580607847','03919D580607847','6977252425445','boss')`);
  const ean = await post(as('ast'), '/api/devices/admin/serial-inventory/link-ean', { ean: '6977252425445', product_id: 'pA1' });
  assert.equal(ean.status, 200, await ean.clone().text());

  // The post-delivery assign follows `receive` too.
  assert.equal((await patch(as('boss'), '/api/admin/orders/ORD-W/stage', { stage: 'delivered' })).status, 200);
  const open = row<{ id: string }>(w.raw, "SELECT u.id FROM order_item_units u WHERE u.order_id = 'ORD-W' AND NOT EXISTS (SELECT 1 FROM device_serials d WHERE d.unit_id = u.id) ORDER BY u.unit_index LIMIT 1")!;
  assert.ok(open, 'a delivered unit with no serial');
  const supAssign = await post(as('sup'), `/api/devices/admin/units/${open.id}/serial`, { serial: '03919D580607848' });
  assert.equal(supAssign.status, 403, await supAssign.clone().text());
  assert.equal((await json(supAssign)).code, 'SERIAL_WRITE_NOT_ALLOWED');
  const prepAssign = await post(as('prep'), `/api/devices/admin/units/${open.id}/serial`, { serial: '03919D580607848' });
  assert.equal(prepAssign.status, 200, await prepAssign.clone().text());

  // A warranty replacement that NAMES a new serial adds it (its asset row and
  // an activated binding): that half follows `receive`. Support is refused it
  // and nothing changes; the replacement itself, with no new serial, keeps the
  // gate it always had; the preparer adds the serial through it.
  const units = (w.raw.prepare("SELECT u.id FROM order_item_units u WHERE u.order_id = 'ORD-W' ORDER BY u.unit_index").all() as Array<{ id: string }>).map((u) => u.id);
  const fresh = '03919D580607851';
  const supReplace = await post(as('sup'), `/api/devices/admin/units/${units[0]}/replace`, { new_serial: fresh, reason: 'dead on arrival' });
  assert.equal(supReplace.status, 403, await supReplace.clone().text());
  assert.equal((await json(supReplace)).code, 'SERIAL_WRITE_NOT_ALLOWED');
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = '${fresh}'`), 0, 'nothing was added');
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM device_serials WHERE serial_norm = '${fresh}'`), 0);
  assert.equal(row<{ r: string | null }>(w.raw, 'SELECT replaced_by_unit_id AS r FROM order_item_units WHERE id = ?', units[0])!.r, null, 'the unit was not replaced');
  const supPlain = await post(as('sup'), `/api/devices/admin/units/${units[1]}/replace`, { reason: 'swapped at the counter' });
  assert.equal(supPlain.status, 200, `a replacement with no new serial keeps its gate: ${await supPlain.clone().text()}`);
  const prepReplace = await post(as('prep'), `/api/devices/admin/units/${units[0]}/replace`, { new_serial: fresh, reason: 'dead on arrival' });
  assert.equal(prepReplace.status, 200, await prepReplace.clone().text());
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM device_serials WHERE serial_norm = '${fresh}'`), 1, 'the preparer added it');

  // The owner, with `receive = 0` on their own row, is never locked out.
  order(w.raw, 'ORD-W2', [{ id: 'l2', product: 'pA1' }]);
  assert.equal((await post(as('boss'), '/api/admin/orders/ORD-W2/serials/scan', scanBody('l2', 1, '03919D580607849'))).status, 200);
  const bossScan = await json(await post(as('boss'), '/api/devices/admin/serial-inventory/scan', { serial: '03919D580607850' }));
  assert.match(String(bossScan.outcome), /^added/);
});

// ====================================================================== 4

test('decision 1 exceptions stay the owner\'s for the preparer and support: overrides, outside the window, warranty mode, history edits, policies and the gate — each owner success audited', async () => {
  const w = world();
  const as = roles(w);
  order(w.raw, 'ORD-X', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  const linked = await json(await post(as('prep'), '/api/admin/orders/ORD-X/serials/scan', scanBody('l1', 1, SN)));
  assert.equal(linked.success, true);
  const boxBefore = row<{ box_sn: string | null }>(w.raw, 'SELECT box_sn FROM serial_inventory WHERE serial_norm = ?', SN)!.box_sn;

  for (const who of ['prep', 'sup'] as const) {
    for (const kind of OVERRIDE_KINDS) {
      const r = await post(as(who), '/api/admin/orders/ORD-X/serials/override', { ...scanBody('l1', 2, SN2), kind, reason: 'a perfectly good reason' });
      assert.equal(r.status, 403, `${who} · ${kind}`);
      assert.equal((await json(r)).code, 'OWNER_ONLY');
    }
    const mode = await post(as(who), `/api/devices/admin/serial-inventory/${SN}/warranty-mode`, { mode: 'restart', reason: 'goodwill for the buyer' });
    assert.equal((await json(mode)).code, 'OWNER_ONLY', who);
    const pol = await put(as(who), '/api/admin/taxonomy/catalogs/ct_ams/serial-policy', { policy: 'required' });
    assert.equal((await json(pol)).code, 'OWNER_ONLY', who);
    const flag = await post(as(who), '/api/devices/admin/products/pAMS/ops-policy', { serialized: true });
    assert.equal((await json(flag)).code, 'OWNER_ONLY', who);
    const gate = await put(as(who), '/api/admin/settings/serialPrepGate', { value: { enabled: true } });
    assert.equal(gate.status, 403, who);
    // A serial with history: its product and box SN, and voiding it, are the owner's.
    const box = await patch(as(who), `/api/devices/admin/serial-inventory/${SN}`, { box_sn: 'B07119G5811000AC' });
    assert.equal((await json(box)).code, 'OWNER_ONLY', who);
    const refile = await patch(as(who), `/api/devices/admin/serial-inventory/${SN}`, { product_id: 'pX2D' });
    assert.equal((await json(refile)).code, 'OWNER_ONLY', who);
  }
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = '${SN2}'`), 0);
  assert.equal(row(w.raw, "SELECT serial_policy FROM catalogs WHERE id = 'ct_ams'")!.serial_policy, 'inherit');
  assert.equal(row(w.raw, 'SELECT box_sn FROM serial_inventory WHERE serial_norm = ?', SN)!.box_sn, boxBefore, 'the box SN is unchanged');
  assert.equal(row(w.raw, 'SELECT product_id FROM serial_inventory WHERE serial_norm = ?', SN)!.product_id, 'pA1', 'and so is its product');

  // The owner's own: an override, the policy, the gate — each with its audit row.
  const ov = await json(await post(as('boss'), '/api/admin/orders/ORD-X/serials/override', { ...scanBody('l1', 2, SN2), kind: 'outside_window', reason: 'owner checked the box' }));
  assert.equal(ov.success, true, JSON.stringify(ov));
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE actor_id = 'boss' AND action LIKE 'serial.%' AND detail LIKE '%owner checked the box%'"), 'the override is audited');
  assert.equal((await put(as('boss'), '/api/admin/taxonomy/catalogs/ct_ams/serial-policy', { policy: 'required' })).status, 200);
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'catalog.serial_policy' AND target = 'ct_ams'"));

  // Outside the window (the order has left preparation): staff are refused, the owner needs a reason.
  w.raw.exec(`UPDATE orders SET status = 'shipped', stage = 'out_for_delivery' WHERE id = 'ORD-X'`);
  for (const who of ['prep', 'sup'] as const) {
    const r = await post(as(who), '/api/admin/orders/ORD-X/serials/unlink', { assignment_id: linked.assignment_id, reason: 'wrong box packed' });
    assert.ok([403, 409].includes(r.status), `${who}: ${await r.clone().text()}`);
  }
  assert.equal(row(w.raw, 'SELECT released_at FROM serial_assignments WHERE id = ?', linked.assignment_id)!.released_at, null);
  const bossUnlink = await json(await post(as('boss'), '/api/admin/orders/ORD-X/serials/unlink', { assignment_id: linked.assignment_id, reason: 'wrong box packed' }));
  assert.equal(bossUnlink.success, true, JSON.stringify(bossUnlink));
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE actor_id = 'boss' AND action = 'serial.unlinked' AND target = ?", SN));

  // The §19 gate override: the owner's alone.
  await put(as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: true, since: '2026-01-01T00:00:00.000Z' } });
  order(w.raw, 'ORD-G', [{ id: 'lg', product: 'pA1' }]);
  for (const who of ['prep', 'sup'] as const) {
    const r = await patch(as(who), '/api/admin/orders/ORD-G/stage', { stage: 'out_for_delivery', serials_override_reason: 'courier is waiting outside' });
    assert.ok(r.status >= 400, `${who}: ${await r.clone().text()}`);
  }
  assert.notEqual(row(w.raw, "SELECT stage FROM orders WHERE id = 'ORD-G'")!.stage, 'out_for_delivery');
  const bossMove = await patch(as('boss'), '/api/admin/orders/ORD-G/stage', { stage: 'out_for_delivery', serials_override_reason: 'sealed box, read at the door' });
  assert.equal(bossMove.status, 200, await bossMove.clone().text());
  assert.ok(row(w.raw, "SELECT 1 AS x FROM audit_log WHERE action = 'serial.prep_gate_override' AND target = 'ORD-G'"));

  // Voiding a serial with history is the owner's too (the delivered unit is its history).
  order(w.raw, 'ORD-V', [{ id: 'lv', product: 'pA1' }]);
  await post(as('prep'), '/api/admin/orders/ORD-V/serials/scan', scanBody('lv', 1, SN3));
  assert.equal((await patch(as('boss'), '/api/admin/orders/ORD-V/stage', { stage: 'delivered' })).status, 200);
  for (const who of ['prep', 'sup'] as const) {
    const v = await post(as(who), `/api/devices/admin/serial-inventory/${SN3}/void`, { reason: 'damaged in storage' });
    assert.equal((await json(v)).code, 'OWNER_ONLY', who);
  }
  assert.equal(row(w.raw, 'SELECT voided_at FROM serial_inventory WHERE serial_norm = ?', SN3)!.voided_at, null);
});

// ====================================================================== 5

test('decision 1 carries no cost: with a distinctive lot cost, no serial answer to the preparer, support or an assistant names it', async () => {
  const w = world();
  const as = roles(w);
  const COST = 733_331;
  order(w.raw, 'ORD-COST', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  w.raw.exec(`
    INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at)
      VALUES ('lotV','pA1','base','',5,3,${COST},'received','2026-09-01T00:00:00.000Z');
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, unit_cost_iqd, cogs_iqd, idempotency_key)
      VALUES ('alV','ORD-COST','l1','lotV','base','',2,${COST},${COST * 2},'alloc:ORD-COST:l1:lotV');
    INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN}','${SN}','pA1','boss'), ('${SN2}','${SN2}','pA1','boss');
    INSERT INTO stock_serial_links (serial_norm, lot_id, linked_by, linked_at) VALUES
      ('${SN}','lotV','boss','2026-09-01T00:00:00.000Z'), ('${SN2}','lotV','boss','2026-09-01T00:00:00.000Z');
  `);
  const answers: Array<[string, string]> = [];
  // Every kept answer is a 200: a refusal carries no cost by construction and
  // would make the check below pass without reading the surface at all.
  const keep = async (label: string, res: Response) => {
    const text = await res.text();
    assert.equal(res.status, 200, `${label}: ${text.slice(0, 300)}`);
    answers.push([label, text]);
    return text;
  };
  const first = JSON.parse(await keep('scan (prep)', await post(as('prep'), '/api/admin/orders/ORD-COST/serials/scan', scanBody('l1', 1, SN))));
  assert.equal(first.slot.assignment.lot?.id, 'lotV', 'the slot names its lot — never its cost');
  await keep('scan (ast)', await post(as('ast'), '/api/admin/orders/ORD-COST/serials/scan', scanBody('l1', 2, SN2)));
  for (const who of ['prep', 'sup', 'ast'] as const) {
    await keep(`serials (${who})`, await get(as(who), '/api/admin/orders/ORD-COST/serials'));
    const detail = JSON.parse(await (await get(as(who), '/api/admin/orders/ORD-COST')).text());
    answers.push([`order window serials (${who})`, JSON.stringify(detail.order.serials)]);
    const page = JSON.parse(await keep(`serial page (${who})`, await get(as(who), `/api/devices/admin/serial-inventory/${SN}`)));
    assert.equal(page.story.serial, SN, `${who} reads the serial whole`);
    assert.equal(page.story.lot?.id, 'lotV', `${who}: the story names its lot`);
    if (who === 'sup') {
      // The stock trace needs `receive`, which support does not hold: a
      // refusal, and still nothing about the lot's cost in it.
      const refused = await get(as(who), `/api/admin/stock-operations/trace?serial=${SN}`);
      assert.equal(refused.status, 403, 'support reads no stock trace');
      const text = await refused.text();
      assert.ok(!text.includes(String(COST)), 'nor its cost');
    } else {
      await keep(`stock trace (${who})`, await get(as(who), `/api/admin/stock-operations/trace?serial=${SN}`));
    }
  }
  assert.equal(answers.length, 13);
  const privateKey = new RegExp(`"(${(FINANCIAL_FIELDS as readonly string[]).join('|')})"\\s*:\\s*(?!null)`);
  for (const [label, text] of answers) {
    assert.ok(!text.includes(String(COST)) && !text.includes(String(COST * 2)), `${label}: the lot's cost leaked`);
    assert.doesNotMatch(text, privateKey, `${label}: a FINANCIAL_FIELDS key carries a value`);
  }
});

// ====================================================================== 6

test('decision 1 predicate: canSeeFullSerial is true for every admin scope, false for everyone else, and never cost', () => {
  const env = { INITIAL_ADMIN_EMAIL: 'boss@x.co' } as never;
  const admin = (admin_scope: string | null, email = 'staff@x.co', email_verified_at: string | null = '2026-01-01T00:00:00.000Z') => ({ role: 'admin' as const, email, admin_scope, email_verified_at });
  for (const [label, user] of [
    ['owner', admin('assistant', 'boss@x.co')],
    ['owner, address not verified', admin(null, 'boss@x.co', null)],
    ['full', admin('full')],
    ['legacy NULL', admin(null)],
    ['assistant', admin('assistant')],
    ['a typo that reads as assistant', admin('assisstant')],
  ] as const) {
    assert.equal(canSeeFullSerial(env, user), true, label);
  }
  for (const [label, user] of [
    ['customer', { role: 'customer' as const, email: 'u1@x.co' }],
    ['merchant', { role: 'merchant' as const, email: 'mer@x.co' }],
    ['customer holding the owner address', { role: 'customer' as const, email: 'boss@x.co' }],
    ['nobody', null],
  ] as const) {
    assert.equal(canSeeFullSerial(env, user), false, label);
  }
  // Order numbers are a different question: an assistant reads none.
  assert.equal(canMoveMoney(env, admin('assistant')), false);
  assert.equal(canMoveMoney(env, admin('full')), true);
});

test('decision 1 static nets: serialActor reads canSeeFullSerial for the serial and canMoveMoney for order numbers; the predicate stays out of every cost path', () => {
  const assignments = codeOf('worker/lib/serialAssignments.ts');
  assert.match(assignments, /fullSerial: canSeeFullSerial\(env, user\), orderRefs: canMoveMoney\(env, user\)/);
  assert.doesNotMatch(assignments, /fullSerial: canMoveMoney/);
  assert.equal(codeOf('worker/lib/costAccess.ts').includes('canSeeFullSerial'), false, 'not a cost predicate');
  const scope = codeOf('worker/lib/adminScope.ts');
  const start = scope.indexOf('export function projectForAdmin');
  assert.ok(start > 0);
  const body = scope.slice(start, scope.indexOf('\n}\n', start));
  assert.equal(body.includes('canSeeFullSerial'), false, 'projectForAdmin never reads it');
  for (const name of ['canViewCost', 'canWriteCost', 'canMoveMoney']) {
    const fn = scope.slice(scope.indexOf(`export function ${name}`), scope.indexOf('\n}\n', scope.indexOf(`export function ${name}`)));
    assert.equal(fn.includes('canSeeFullSerial'), false, `${name} does not depend on it`);
  }
  // The intake doors carry the one rule.
  const inventory = readFileSync(join(ROOT, 'worker/routes/serialInventory.ts'), 'utf8');
  for (const door of ['/commit', '/scan', '/link-ean']) {
    const at = inventory.indexOf(`serialInventoryRoutes.post('${door}'`);
    assert.ok(at > 0, door);
    assert.match(inventory.slice(at, at + 220), /await requireSerialWrite\(c\.env, admin\);/, `${door} follows receive`);
  }
  for (const door of ['/preview']) {
    const at = inventory.indexOf(`serialInventoryRoutes.post('${door}'`);
    assert.doesNotMatch(inventory.slice(at, at + 400), /requireSerialWrite/, `${door} keeps its gate`);
  }
  const devices = readFileSync(join(ROOT, 'worker/routes/devices.ts'), 'utf8');
  const assign = devices.indexOf("deviceRoutes.post('/admin/units/:unitId/serial'");
  assert.match(devices.slice(assign, assign + 400), /await requireSerialWrite\(c\.env, admin\);/);
  const replace = devices.indexOf("deviceRoutes.post('/admin/units/:unitId/replace'");
  const replaceHead = devices.slice(replace, devices.indexOf('const unit = await', replace));
  assert.match(replaceHead, /if \(typedNewSerial\) await requireSerialWrite\(c\.env, admin\);/, 'a replacement that names a new serial follows receive, before any read or write');
  // The preparation unlink follows the same helper (same rule, translated refusal).
  const prep = readFileSync(join(ROOT, 'worker/routes/adminOrderSerials.ts'), 'utf8');
  for (const door of ['scan', 'change', 'unlink']) {
    const at = prep.indexOf(`adminOrderSerialRoutes.post('/:id/serials/${door}'`);
    assert.ok(at > 0, door);
    assert.match(prep.slice(at, at + 400), /await requireSerialWrite\(c\.env, user\);/, `${door} follows receive`);
  }
});
