/**
 * WHO SEES WHAT, AND WHO MAY DO WHAT (serial scan; owner brief §10, §11, §16,
 * §19, §25, §29; owner defaults 3 and 6; critique-2 L7) — through the real
 * routes over the real migrations.
 *
 *   - Every admin — the owner (INITIAL_ADMIN_EMAIL), full-scope admins and
 *     assistants — sees the whole serial on every serial surface (owner
 *     decision 1, 2026-10-09); an assistant sees no order numbers on the
 *     serial page (option A). tests/serialVisibilityRoles.test.ts walks the
 *     whole matrix.
 *   - The order that holds a serial is named to the Main Admin only (§10).
 *   - Every exception, the serial policy and the gate switch are the owner's.
 *   - The owner can take the `receive` capability from a member of staff.
 *   - No serial answer ever carries a cost (§27 «never its cost»).
 *
 * Run: node --import tsx --test tests/serialPrepPrivacy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, put, get, row, count } from './fixtures/app';
import { world, order, op, SN, SN2, SN3 } from './fixtures/serialPrep';
import { OVERRIDE_KINDS } from '../worker/lib/serialAssignments';
import { serverMessage } from '../packages/contracts/src/costRefusals';

type W = ReturnType<typeof world>;
type Who = 'boss' | 'adm' | 'ast';
const scan = (w: W, who: Who, o: string, item: string, unit: number, code: string, extra: Record<string, unknown> = {}) =>
  post(w.as(who), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: unit, code, source: 'scanner', op_id: op(), ...extra });
const MASKED = /^\*{4}[0-9A-Z]{4}$|^\*+[0-9A-Z]{1,6}$/;

// ------------------------------------------------------------------ masking

test('owner decision 1: the owner, a full-scope admin and an assistant all see the whole serial on every serial surface', async () => {
  const w = world();
  order(w.raw, 'ORD-M', [{ id: 'l1', product: 'pA1', qty: 3 }]);
  order(w.raw, 'ORD-N', [{ id: 'l2', product: 'pA1' }]);

  // The scan answer.
  for (const [who, unit, code] of [['boss', 1, SN], ['adm', 2, SN2], ['ast', 3, SN3]] as const) {
    const res = await scan(w, who, 'ORD-M', 'l1', unit, code);
    const text = await res.clone().text();
    const body = await json(res);
    assert.equal(res.status, 200, text);
    assert.equal(body.slot.assignment.serial_full, code, who);
    assert.equal(body.slot.assignment.serial_display, code, who);
    assert.doesNotMatch(body.slot.assignment.serial_display, MASKED, `${who}: never the masked form`);
  }

  // The order window and the serials door.
  for (const path of ['/api/admin/orders/ORD-M', '/api/admin/orders/ORD-M/serials']) {
    for (const who of ['ast', 'adm', 'boss'] as const) {
      const body = await json(await get(w.as(who), path));
      const slots = (body.order?.serials ?? body.serials).slots as Array<{ assignment: { serial_full: string; serial_display: string } }>;
      assert.deepEqual(slots.map((x) => x.assignment.serial_full), [SN, SN2, SN3], `${path}: ${who} sees them whole`);
      assert.deepEqual(slots.map((x) => x.assignment.serial_display), [SN, SN2, SN3], `${path}: ${who}`);
    }
  }

  // A re-opened order's suggestion of its previous serial.
  await patch(w.as('adm'), '/api/admin/orders/ORD-N/stage', { stage: 'cancelled' });
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('03919D580600001','03919D580600001','pA1','boss')`);
  w.raw.exec(`
    INSERT INTO serial_assignments (id, serial_norm, serial_raw, order_id, order_item_id, order_ref, unit_index, source, idempotency_key, linked_by, released_at, release_reason)
      VALUES ('sa_prev','03919D580600001','03919D580600001','ORD-N','l2','ORD-N',1,'camera','scan:prev-1','adm','2026-10-01T00:00:00.000Z','order_cancelled')`);
  await patch(w.as('boss'), '/api/admin/orders/ORD-N/stage', { stage: 'confirmed' });
  const prevAst = (await json(await get(w.as('ast'), '/api/admin/orders/ORD-N/serials'))).serials.slots[0].previous;
  assert.equal(prevAst.serial_full, '03919D580600001', 'the assistant sees the previous serial whole too');
  assert.equal(prevAst.serial_display, '03919D580600001');
  const prevBoss = (await json(await get(w.as('boss'), '/api/admin/orders/ORD-N/serials'))).serials.slots[0].previous;
  assert.equal(prevBoss.serial_full, '03919D580600001');
});

test('L7 the serial page: an assistant sees the whole serial (decision 1) and no order numbers (option A) — in the story and in every history line', async () => {
  const w = world();
  order(w.raw, 'ORD-111', [{ id: 'l1', product: 'pA1' }]);
  order(w.raw, 'ORD-222', [{ id: 'l2', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-111', 'l1', 1, SN);
  await patch(w.as('adm'), '/api/admin/orders/ORD-111/stage', { stage: 'cancelled' });
  await scan(w, 'adm', 'ORD-222', 'l2', 1, SN);

  const ast = await json(await get(w.as('ast'), `/api/devices/admin/serial-inventory/${SN}`));
  const story = ast.story;
  assert.equal(story.serial, SN);
  assert.equal(story.serial_norm, SN);
  assert.equal(story.serial_display, SN);
  assert.equal(ast.row.serial, SN, 'the row too');
  assert.equal(story.current_order.order_id, null);
  assert.ok(story.previous_orders.every((p: { order_id: string | null }) => p.order_id === null));
  const storyText = JSON.stringify(story);
  for (const o of ['ORD-111', 'ORD-222']) assert.ok(!storyText.includes(o), `no ${o} anywhere in the assistant's story`);
  assert.ok(story.history.length >= 4, 'the timeline is still there, only without the order numbers');
  assert.ok(!JSON.stringify(ast.row).includes('ORD-'), 'and no order number in the row');

  const adm = await json(await get(w.as('adm'), `/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(adm.story.serial, SN);
  assert.equal(adm.story.current_order.order_id, 'ORD-222');
  assert.deepEqual(adm.story.previous_orders.map((p: { order_id: string }) => p.order_id), ['ORD-111']);
});

test('§10/§11 which order holds a serial — or delivered it — is said to the Main Admin only', async () => {
  const w = world();
  order(w.raw, 'ORD-A', [{ id: 'la', product: 'pA1' }]);
  order(w.raw, 'ORD-B', [{ id: 'lb', product: 'pA1' }]);
  order(w.raw, 'ORD-C', [{ id: 'lc', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-A', 'la', 1, SN);
  for (const who of ['adm', 'ast'] as const) {
    const r = await scan(w, who, 'ORD-B', 'lb', 1, SN);
    const text = await r.text();
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(text).code, 'SERIAL_IN_USE');
    assert.ok(!text.includes('ORD-A'), `${who}: no order number`);
  }
  assert.equal((await json(await scan(w, 'boss', 'ORD-B', 'lb', 1, SN))).details.order_id, 'ORD-A');

  // Delivered: the same rule.
  await scan(w, 'adm', 'ORD-C', 'lc', 1, SN2);
  await patch(w.as('adm'), '/api/admin/orders/ORD-C/stage', { stage: 'delivered' });
  for (const who of ['adm', 'ast'] as const) {
    const text = await (await scan(w, who, 'ORD-B', 'lb', 1, SN2)).text();
    assert.equal(JSON.parse(text).code, 'SERIAL_DELIVERED');
    assert.ok(!text.includes('ORD-C'), `${who}: no order number`);
  }
  const owner = await json(await scan(w, 'boss', 'ORD-B', 'lb', 1, SN2));
  assert.equal(owner.details.order_id, 'ORD-C');
  assert.ok(owner.details.warranty_end_at);
});

// ------------------------------------------------------------------ owner-only

test('§11/§25 every exception kind is the owner\'s: a full-scope admin and an assistant are refused, nothing is written', async () => {
  const w = world();
  order(w.raw, 'ORD-O', [{ id: 'l1', product: 'pA1' }]);
  for (const kind of OVERRIDE_KINDS) {
    for (const who of ['adm', 'ast'] as const) {
      const r = await post(w.as(who), '/api/admin/orders/ORD-O/serials/override', {
        order_item_id: 'l1', unit_index: 1, code: SN, kind, reason: 'a perfectly good reason', op_id: op(),
      });
      assert.equal(r.status, 403, `${who} · ${kind}`);
      const body = await json(r);
      assert.equal(body.code, 'OWNER_ONLY');
      // The programme contract's one sentence for the code (migration review #1).
      assert.equal(body.error, serverMessage('OWNER_ONLY'));
    }
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory'), 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'serial%'"), 0);
  // An unknown kind is refused even for the owner.
  const odd = await post(w.as('boss'), '/api/admin/orders/ORD-O/serials/override', {
    order_item_id: 'l1', unit_index: 1, code: SN, kind: 'anything_goes', reason: 'a perfectly good reason', op_id: op(),
  });
  assert.equal(odd.status, 400);
});

test('owner default 6: the serial policy, the gate switch and a resale\'s warranty mode are the owner\'s writes', async () => {
  const w = world();
  for (const who of ['adm', 'ast'] as const) {
    const pol = await put(w.as(who), '/api/admin/taxonomy/catalogs/ct_ams/serial-policy', { policy: 'required' });
    assert.equal(pol.status, 403, who);
    assert.equal((await json(pol)).code, 'OWNER_ONLY');
    const gate = await put(w.as(who), '/api/admin/settings/serialPrepGate', { value: { enabled: true } });
    assert.equal(gate.status, 403, who);
    const flag = await post(w.as(who), '/api/devices/admin/products/pAMS/ops-policy', { serialized: true });
    assert.equal((await json(flag)).code, 'OWNER_ONLY', who);
    const mode = await post(w.as(who), `/api/devices/admin/serial-inventory/${SN}/warranty-mode`, { mode: 'restart', reason: 'goodwill for the buyer' });
    assert.equal(mode.status, 403, who);
    assert.equal((await json(mode)).code, 'OWNER_ONLY');
  }
  assert.equal(row(w.raw, "SELECT serial_policy FROM catalogs WHERE id = 'ct_ams'")!.serial_policy, 'inherit');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'catalog.serial_policy'"), 0);

  // The owner's own writes, each audited.
  const pol = await json(await put(w.as('boss'), '/api/admin/taxonomy/catalogs/ct_ams/serial-policy', { policy: 'required' }));
  assert.equal(pol.success, true);
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'catalog.serial_policy' AND target = 'ct_ams'")!.detail);
  assert.deepEqual(audit, { from: 'inherit', to: 'required' });
  assert.equal((await put(w.as('boss'), '/api/admin/taxonomy/catalogs/ct_ams/serial-policy', { policy: 'sometimes' })).status, 400);
  // The warranty mode needs a resale to act on.
  const notResale = await json(await post(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}/warranty-mode`, { mode: 'restart', reason: 'goodwill for the buyer' }));
  assert.equal(notResale.code, 'SERIAL_ASSIGNMENT_NOT_FOUND');
});

test('the owner can take the `receive` capability from a member of staff: scan, change and remove are then refused; the owner is never locked out', async () => {
  const w = world();
  order(w.raw, 'ORD-CAP', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  const linked = await json(await scan(w, 'ast', 'ORD-CAP', 'l1', 1, SN));
  w.raw.exec(`INSERT INTO ops_permissions (user_id, capability, allowed) VALUES ('ast','receive',0), ('boss','receive',0)`);
  const s = await scan(w, 'ast', 'ORD-CAP', 'l1', 2, SN2);
  assert.equal(s.status, 403);
  assert.equal((await post(w.as('ast'), '/api/admin/orders/ORD-CAP/serials/change', { assignment_id: linked.assignment_id, code: SN2, source: 'scanner', op_id: op() })).status, 403);
  assert.equal((await post(w.as('ast'), '/api/admin/orders/ORD-CAP/serials/unlink', { assignment_id: linked.assignment_id })).status, 403);
  assert.equal((await get(w.as('ast'), '/api/admin/orders/ORD-CAP/serials')).status, 200, 'reading is not receiving');
  assert.equal((await scan(w, 'boss', 'ORD-CAP', 'l1', 2, SN2)).status, 200, 'the owner is never locked out');
  assert.equal((await scan(w, 'adm', 'ORD-CAP', 'l1', 2, SN2)).status, 200, 'and the others keep theirs');
});

test('a customer never reaches a serial door — not the scan, the order\'s serials, the serial page nor the policy', async () => {
  const w = world();
  order(w.raw, 'ORD-CU', [{ id: 'l1', product: 'pA1' }]);
  await scan(w, 'adm', 'ORD-CU', 'l1', 1, SN);
  const u = w.as('u1');
  for (const [method, path, body] of [
    ['POST', '/api/admin/orders/ORD-CU/serials/scan', { order_item_id: 'l1', unit_index: 1, code: SN2, source: 'manual', op_id: op() }],
    ['POST', '/api/admin/orders/ORD-CU/serials/unlink', { assignment_id: 'x' }],
    ['POST', '/api/admin/orders/ORD-CU/serials/override', { order_item_id: 'l1', unit_index: 1, code: SN2, kind: 'outside_window', reason: 'let me in please', op_id: op() }],
    ['GET', '/api/admin/orders/ORD-CU/serials', null],
    ['GET', `/api/devices/admin/serial-inventory/${SN}`, null],
    ['PUT', '/api/admin/taxonomy/catalogs/ct_ams/serial-policy', { policy: 'required' }],
  ] as const) {
    const r = await u.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok([401, 403, 404].includes(r.status), `${method} ${path} → ${r.status}`);
    assert.ok(!(await r.text()).includes(SN), 'and learns nothing about the serial');
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE released_at IS NULL'), 1);
});

// ------------------------------------------------------------------ no cost, anywhere

test('§27 no serial answer carries a cost — scan, refusal, change, remove, exception, the order window, the board, the serial page, a return', async () => {
  const w = world();
  // Distinctive cost figures, so a leak cannot hide among ordinary numbers.
  const COST_A = 700_001;
  const COST_B = 710_003;
  order(w.raw, 'ORD-COST', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  w.raw.exec(`
    INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at)
      VALUES ('lotA','pA1','base','',5,3,${COST_A},'received','2026-09-01T00:00:00.000Z'),
             ('lotB','pA1','base','',5,5,${COST_B},'received','2026-09-10T00:00:00.000Z');
    INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, unit_cost_iqd, cogs_iqd, idempotency_key)
      VALUES ('al1','ORD-COST','l1','lotA','base','',2,${COST_A},${COST_A * 2},'alloc:ORD-COST:l1:lotA');
    INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN}','${SN}','pA1','boss'), ('${SN2}','${SN2}','pA1','boss'), ('${SN3}','${SN3}','pA1','boss');
    INSERT INTO stock_serial_links (serial_norm, lot_id, linked_by, linked_at) VALUES
      ('${SN}','lotA','boss','2026-09-01T00:00:00.000Z'), ('${SN2}','lotB','boss','2026-09-10T00:00:00.000Z'), ('${SN3}','lotA','boss','2026-09-01T00:00:00.000Z');
  `);
  const answers: Array<[string, string]> = [];
  const keep = async (label: string, res: Response) => {
    const text = await res.text();
    answers.push([label, text]);
    return JSON.parse(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  for (const who of ['boss', 'adm', 'ast'] as const) {
    await keep(`batch refusal (${who})`, await scan(w, who, 'ORD-COST', 'l1', 1, SN2));
  }
  const linked = await keep('scan', await scan(w, 'boss', 'ORD-COST', 'l1', 1, SN));
  assert.equal(linked.slot.assignment.lot.id, 'lotA', 'the lot is shown — its id, date and place, never its cost');
  const changed = await keep('change', await post(w.as('boss'), '/api/admin/orders/ORD-COST/serials/change', { assignment_id: linked.assignment_id, code: SN3, source: 'scanner', op_id: op() }));
  assert.equal(changed.success, true, JSON.stringify(changed));
  assert.equal((await keep('unlink', await post(w.as('boss'), '/api/admin/orders/ORD-COST/serials/unlink', { assignment_id: changed.assignment_id }))).success, true);
  const ov = await keep('override batch', await post(w.as('boss'), '/api/admin/orders/ORD-COST/serials/override', {
    order_item_id: 'l1', unit_index: 2, code: SN2, kind: 'batch', reason: 'box from lot B by mistake', op_id: op(),
  }));
  assert.deepEqual(ov.warnings, ['BATCH_OVERRIDDEN']);
  assert.equal((await keep('scan again', await scan(w, 'boss', 'ORD-COST', 'l1', 1, SN))).success, true);
  for (const who of ['boss', 'adm', 'ast'] as const) {
    await keep(`serials (${who})`, await get(w.as(who), '/api/admin/orders/ORD-COST/serials'));
    const detail = JSON.parse(await (await get(w.as(who), '/api/admin/orders/ORD-COST')).text());
    answers.push([`order window serials (${who})`, JSON.stringify(detail.order.serials)]);
    const boardRows = JSON.parse(await (await get(w.as(who), '/api/admin/orders?scope=all&limit=50')).text()).orders as Array<{ id: string; serials?: unknown }>;
    answers.push([`board (${who})`, JSON.stringify(boardRows.find((o) => o.id === 'ORD-COST')?.serials ?? null)]);
    await keep(`serial page (${who})`, await get(w.as(who), `/api/devices/admin/serial-inventory/${SN}`));
  }
  // Delivered and returned: the activation history and the return answer.
  await patch(w.as('boss'), '/api/admin/orders/ORD-COST/stage', { stage: 'delivered' });
  const unit = row<{ id: string }>(w.raw, "SELECT u.id FROM order_item_units u JOIN device_serials d ON d.unit_id = u.id WHERE d.serial_norm = ?", SN)!;
  w.raw.exec(`INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state) VALUES ('rc_cost','ORD-COST','l1','${unit.id}','u1',1,'defective','inspected')`);
  const ret = await keep('return', await post(w.as('boss'), '/api/returns/admin/rc_cost/transition', { to: 'resolved', resolution: 'refund', serials: [SN] }));
  assert.deepEqual(ret.serials.closed, [unit.id]);
  await keep('serial page after return', await get(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}`));

  assert.ok(answers.length >= 18);
  for (const [label, text] of answers) {
    assert.ok(!text.includes(String(COST_A)) && !text.includes(String(COST_B)) && !text.includes(String(COST_A * 2)), `${label}: a cost figure leaked`);
    assert.ok(!/"[a-z_]*(cost|cogs)[a-z_]*"\s*:/i.test(text), `${label}: a cost field leaked`);
  }
});
