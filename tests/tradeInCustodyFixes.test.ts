/**
 * TRADE-IN CUSTODY, THE REVIEW ROUND (owner decision 3, 2026-10-09; docs/
 * DECISIONS.md row 193). Each test below is one defect two reviews found in
 * the first build, reproduced through the real routes on a real database
 * (tests/fixtures/serialPrep.ts), and the answer the owner's rule requires:
 *
 *   - a warranty REPLACEMENT shows and prints the original start, never its
 *     own delivery (the device card and a new receipt);
 *   - a trade-in of a slot whose device was replaced under warranty takes the
 *     REPLACEMENT — the device in the customer's hands — and decision 3
 *     applies to it (hidden, unlinked, released, resold without an exception);
 *   - a buyer who passed the device on cannot trade it in from under its
 *     holder (TRADE_IN_LINKED_ELSEWHERE, at eligibility, at the request, at
 *     completion and inside the completion batch);
 *   - a traded-in device whose serial was linked to a stock lot at intake is
 *     resold from the line's own allocation, no owner exception;
 *   - a resale whose delivery was undone and cancelled hands on the original
 *     warranty, never a fresh one, never the cancelled line's extension;
 *   - the head start written at delivery (S8) leaves with a carry binding that
 *     never activated;
 *   - the order's units no longer say «delivered without a serial» for a slot
 *     whose device came back;
 *   - the used-sale period is shown consistently (the cover in force and its
 *     end, the public receipt page, the reissued and the order's paper);
 *   - months and days are written with their plurals, in the policy's term.
 *
 * Run: node --import tsx --test tests/tradeInCustodyFixes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { json, post, patch, get, send, row, count, stubApp, failingD1, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { world, order, op, SN, SN2, USERS, mountSerialWorld } from './fixtures/serialPrep';
import { adminTradeInRoutes } from '../worker/routes/tradeIn';
import { warrantyPublicRoutes } from '../worker/routes/warranty';
import { completeRequest, createDraft, listEligible, loadRequest } from '../worker/lib/tradeIn';
import { createUnitsOnDelivery } from '../worker/lib/deviceOps';
import { serialGateState } from '../worker/lib/serialAssignments';
import { addMonths } from '../worker/lib/membershipOps';
import { publicView, type WarrantyReceiptRow } from '../worker/lib/warranty';
import { daysWords, monthsWords, timeLeftWords } from '../packages/pricing/src/warrantyTime';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

type W = ReturnType<typeof world>;
type R = Record<string, string | number | null>;
const DAY = 86_400_000;
type Who = keyof typeof USERS;

const as = (w: W, who: Who, db: D1Database = w.db) =>
  stubApp(db, USERS[who] as StubUser, (a) => {
    a.route('/api/admin/trade-in', adminTradeInRoutes);
    a.route('/api/warranty', warrantyPublicRoutes);
    mountSerialWorld(a);
  });

const scan = (w: W, who: Who, o: string, item: string, unit: number, code: string) =>
  post(as(w, who), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: unit, code, source: 'scanner', op_id: op() });
const deliver = (w: W, o: string) => patch(as(w, 'adm'), `/api/admin/orders/${o}/stage`, { stage: 'delivered' });
const unitOf = (w: W, o: string, index = 1) => row<R>(w.raw, 'SELECT * FROM order_item_units WHERE order_id = ? AND unit_index = ?', o, index)!;

let reqSeq = 0;
function tradeIn(w: W, o: { user: string; order: string; item: string; scope?: 'whole' | 'printer_only' | 'ams_only' }): string {
  const id = `tin_${(++reqSeq).toString(16).padStart(20, 'f')}`;
  const now = new Date().toISOString();
  w.raw
    .prepare(
      `INSERT INTO trade_in_requests (id, user_id, status, order_id, order_item_id, unit_index, family, scope, credit_iqd, created_at, updated_at)
       VALUES (?, ?, 'awaiting_payment', ?, ?, 1, 'fdm', ?, 0, ?, ?)`
    )
    .run(id, o.user, o.order, o.item, o.scope ?? 'whole', now, now);
  return id;
}
const complete = (w: W, who: Who, id: string) => post(as(w, who), `/api/admin/trade-in/requests/${id}/complete`);

/** Sara (u1) bought an A1 (12 months), delivered 30 days ago, linked to her account. */
async function saraBought(w: W, o = 'ORD-1', item = 'l1', serial = SN) {
  order(w.raw, o, [{ id: item, product: 'pA1' }]);
  assert.equal((await scan(w, 'adm', o, item, 1, serial)).status, 200);
  assert.equal((await deliver(w, o)).status, 200);
  const delivered = new Date(Date.now() - 30 * DAY).toISOString();
  w.raw
    .prepare('UPDATE order_item_units SET delivered_at = ?1, warranty_start_at = ?1, warranty_end_at = ?2 WHERE order_id = ?3')
    .run(delivered, addMonths(delivered, 12), o);
  w.raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(delivered, o);
  const u = unitOf(w, o);
  assert.equal((await post(as(w, 'u1'), `/api/devices/units/${u.id}/register`)).status, 200);
  return u;
}

/** A used listing of the A1: graded `used`, one month of used-sale period, a copy of pA1. */
function usedListing(w: W, months = 1) {
  w.raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, price_iqd, ops_policy, condition_doc)
      VALUES ('pA1u', 'sp-a1-used', 'Bambu Lab A1 Combo (used)', 'طابعة A1 كومبو مستعملة', 650000,
              '{"serialized":true,"warranty_base_months":${months}}',
              '{"kind":"used","grade":"good","warranty_months":${months},"new_product_id":"pA1"}');
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pA1u', 'ct_print', 9);
  `);
}

// ============================================================ a warranty replacement

test('a warranty REPLACEMENT shows and prints the original start — never its own delivery date', async () => {
  const w = world();
  const u = await saraBought(w);
  const rp = await json(await post(as(w, 'boss'), `/api/devices/admin/units/${u.id}/replace`, { reason: 'dead on arrival, swapped', new_serial: SN2 }));
  assert.equal(rp.success, true, JSON.stringify(rp));
  const nu = row<R>(w.raw, 'SELECT * FROM order_item_units WHERE id = ?', rp.new_unit_id)!;
  assert.notEqual(nu.delivered_at, u.warranty_start_at, 'the replacement was delivered later');
  assert.equal(nu.warranty_start_at, u.warranty_start_at, 'the stored window is the original one');

  const card = (await json(await get(as(w, 'u1'), '/api/devices/mine'))).devices.find((d: { unit_id: string }) => d.unit_id === rp.new_unit_id);
  assert.ok(card, 'the replacement is on her list');
  assert.equal(card.warranty.carried, true);
  assert.equal(card.warranty.start_at, u.warranty_start_at, 'the card starts at the original delivery');
  assert.equal(card.warranty.origin_start_at, u.warranty_start_at, '«continues from the first delivery» names the original date');

  const issued = await post(as(w, 'boss'), '/api/admin/warranties', { unit_id: rp.new_unit_id });
  assert.equal(issued.status, 200, await issued.clone().text());
  const wr = row<R>(w.raw, "SELECT warranty_start_at, warranty_end_at, warranty_months FROM warranty_receipts WHERE unit_id = ? AND status = 'active'", rp.new_unit_id)!;
  assert.equal(wr.warranty_start_at, u.warranty_start_at, 'the new paper prints the original start');
  assert.equal(wr.warranty_end_at, u.warranty_end_at);
  assert.equal(Number(wr.warranty_months), 12);
});

test('a trade-in of a slot whose device was REPLACED takes the replacement: hidden, unlinked, released, its own serial audited — and staff resell it carrying the original warranty', async () => {
  const w = world();
  const u = await saraBought(w);
  const rp = await json(await post(as(w, 'boss'), `/api/devices/admin/units/${u.id}/replace`, { reason: 'dead on arrival, swapped', new_serial: SN2 }));
  assert.equal(rp.success, true, JSON.stringify(rp));
  assert.equal((await json(await get(as(w, 'u1'), '/api/devices/mine'))).devices.length, 1, 'she holds the replacement');

  // The request names the slot she bought (unit_index 1), as eligibility does.
  const done = await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  assert.equal(done.status, 200, await done.clone().text());

  assert.equal((await json(await get(as(w, 'u1'), '/api/devices/mine'))).devices.length, 0, '«أجهزتي» no longer lists the replacement');
  assert.ok(row(w.raw, 'SELECT revoked_at FROM device_registrations WHERE unit_id = ?', rp.new_unit_id)!.revoked_at, 'its link is revoked');
  const binding = row<R>(w.raw, 'SELECT release_reason FROM serial_assignments WHERE serial_norm = ? ORDER BY linked_at DESC LIMIT 1', SN2)!;
  assert.equal(binding.release_reason, 'traded_in', 'its serial binding is released as traded in');
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.traded_in' AND target = ?", SN2)!.detail);
  assert.equal(audit.unit_id, rp.new_unit_id, 'the audit names the device she handed over');
  const claim = await post(as(w, 'u1'), `/api/devices/units/${rp.new_unit_id}/claims`, { subject: 'نوزل مسدود', description: 'the nozzle clogs after an hour of printing' });
  assert.equal(claim.status, 409);
  assert.equal((await json(claim)).code, 'DEVICE_NOT_WITH_CUSTOMER');
  // The warranty itself is untouched — never closed (owner decision 3).
  const repl = row<R>(w.raw, 'SELECT warranty_closed_at, warranty_end_at FROM order_item_units WHERE id = ?', rp.new_unit_id)!;
  assert.equal(repl.warranty_closed_at, null);
  assert.equal(repl.warranty_end_at, u.warranty_end_at);

  // Staff resell the device they received: a normal scan, carrying the original warranty.
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }], { user: 'u2' });
  const s = await json(await scan(w, 'ast', 'ORD-2', 'l2', 1, SN2));
  assert.equal(s.success, true, JSON.stringify(s));
  assert.equal(s.slot.assignment.override_kind, null, 'no owner exception');
  assert.equal(s.slot.assignment.warranty.mode, 'carry');
  assert.equal((await deliver(w, 'ORD-2')).status, 200);
  const u2 = unitOf(w, 'ORD-2');
  assert.equal(u2.warranty_start_at, u.warranty_start_at, 'the original start');
  assert.equal(u2.warranty_end_at, u.warranty_end_at, 'the original end');
  assert.equal(JSON.parse(String(u2.policy_version)).resale_of, rp.new_unit_id);
});

// ============================================================ a device passed on

/** Sara releases the device and Omar (u2) links it by serial — the supported transfer. */
async function passedToOmar(w: W, unitId: string) {
  assert.equal((await send(as(w, 'u1'), 'DELETE', `/api/devices/units/${unitId}/registration`))!.status, 200);
  assert.equal((await post(as(w, 'u2'), '/api/devices/register', { serial: SN })).status, 200);
  assert.equal((await json(await get(as(w, 'u2'), '/api/devices/mine'))).devices.length, 1);
}

test('a buyer who passed the device on cannot trade it in from under its holder: eligibility, the request and the completion all say TRADE_IN_LINKED_ELSEWHERE', async () => {
  const w = world();
  // Filed under the shop's FDM printer section, so the trade-in screen lists it.
  w.raw.exec("UPDATE products SET category_id = 'cat_printers', sub_category_id = 'cat_printers_fdm' WHERE id = 'pA1'");
  const u = await saraBought(w);
  const mine = (await listEligible(w.env, 'u1')).find((x) => x.order_item_id === 'l1')!;
  assert.ok(mine.scopes.find((sc) => sc.scope === 'whole')!.available, 'while she holds it, she may trade it in');
  await passedToOmar(w, String(u.id));

  const listed = (await listEligible(w.env, 'u1')).find((x) => x.order_item_id === 'l1')!;
  assert.ok(listed, 'the line is listed with its reason');
  const whole = listed.scopes.find((sc) => sc.scope === 'whole')!;
  assert.equal(whole.available, false);
  assert.equal(whole.reason, 'TRADE_IN_LINKED_ELSEWHERE');
  await assert.rejects(createDraft(w.env, 'u1', { orderItemId: 'l1', unitIndex: 1, scope: 'whole' }), (e: { code?: string }) => e.code === 'TRADE_IN_LINKED_ELSEWHERE');

  // A request opened before the device was passed on stops at completion — nothing moves.
  const id = tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' });
  const res = await complete(w, 'adm', id);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'TRADE_IN_LINKED_ELSEWHERE');
  assert.equal(row(w.raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'awaiting_payment');
  assert.equal(row(w.raw, 'SELECT revoked_at FROM device_registrations WHERE unit_id = ?', u.id)!.revoked_at, null, 'Omar keeps his link');
  assert.equal((await json(await get(as(w, 'u2'), '/api/devices/mine'))).devices.length, 1, 'and his device');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.traded_in'"), 0);

  // Once Omar releases it, the trade-in goes through.
  assert.equal((await send(as(w, 'u2'), 'DELETE', `/api/devices/units/${u.id}/registration`))!.status, 200);
  assert.equal((await complete(w, 'adm', id)).status, 200);
});

test('the holder is re-checked INSIDE the completion batch: a link made by another account after the read aborts the whole completion', async () => {
  const w = world();
  const u = await saraBought(w);
  const id = tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' });
  // Between the completion's reads and its batch, Sara passes the device to Omar.
  let moved = false;
  const held = {
    prepare: (sql: string) => w.db.prepare(sql),
    batch: async (stmts: D1PreparedStatement[]) => {
      if (!moved) {
        moved = true;
        w.raw.prepare("UPDATE device_registrations SET user_id = 'u2', revoked_at = NULL WHERE unit_id = ?").run(u.id);
      }
      return w.db.batch(stmts);
    },
  } as unknown as D1Database;
  const env = { DB: held, INITIAL_ADMIN_EMAIL: 'boss@x.co' } as never;
  await assert.rejects(completeRequest(env, (await loadRequest(w.db, id))!, 'adm'), (e: { code?: string }) => e.code === 'TRADE_IN_LINKED_ELSEWHERE');
  assert.equal(row(w.raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'awaiting_payment');
  assert.equal(row(w.raw, 'SELECT revoked_at FROM device_registrations WHERE unit_id = ?', u.id)!.revoked_at, null);
  assert.equal(row(w.raw, "SELECT released_at FROM serial_assignments WHERE order_id = 'ORD-1'")!.released_at, null);
});

test('TRADE_IN_LINKED_ELSEWHERE reads in Arabic, English and real Sorani', () => {
  const e = REFUSAL_STRINGS.TRADE_IN_LINKED_ELSEWHERE;
  assert.ok(e && e.ar && e.en && e.ckb);
  assert.notEqual(e.ckb, e.ar);
  assert.match(e.ckb, /هەژمار/);
});

// ============================================================ intake lot

for (const linkedToLine of [false, true]) {
  test(`a traded-in device linked to a stock lot at intake is resold from the line's own allocation — no lot refusal, no owner exception (intake link ${linkedToLine ? 'names the first line' : 'names no line'})`, async () => {
    const w = world();
    w.raw.exec(`
      INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at)
        VALUES ('lotA','pA1','base','',1,0,700000,'received','2026-09-01T00:00:00.000Z'),
               ('lotT','pA1','base','',1,1,500000,'received','2026-10-05T00:00:00.000Z');
      INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN}','${SN}','pA1','boss');
    `);
    order(w.raw, 'ORD-1', [{ id: 'l1', product: 'pA1' }]);
    w.raw.exec(`INSERT INTO stock_serial_links (serial_norm, lot_id, order_item_id, linked_by, linked_at) VALUES ('${SN}','lotA',${linkedToLine ? "'l1'" : 'NULL'},'boss','2026-09-01T00:00:00.000Z')`);
    assert.equal((await json(await scan(w, 'adm', 'ORD-1', 'l1', 1, SN))).success, true);
    assert.equal((await deliver(w, 'ORD-1')).status, 200);
    assert.equal((await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }))).status, 200);

    order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }], { user: 'u2' });
    w.raw.exec(`INSERT INTO order_item_inventory_allocations (id, order_id, order_item_id, lot_id, scope, scope_id, qty, unit_cost_iqd, cogs_iqd, idempotency_key)
      VALUES ('alT','ORD-2','l2','lotT','base','',1,500000,500000,'alloc:ORD-2:l2:lotT')`);
    const r = await json(await scan(w, 'ast', 'ORD-2', 'l2', 1, SN));
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.slot.assignment.override_kind, null);
    const a = row<R>(w.raw, "SELECT lot_id, lot_source FROM serial_assignments WHERE order_id = 'ORD-2' AND released_at IS NULL")!;
    assert.deepEqual(a, { lot_id: 'lotT', lot_source: 'allocation' }, 'the unit comes from the line\'s own allocation');
    assert.deepEqual((await serialGateState(w.env, 'ORD-2')).lot_conflicts, [], 'the intake lot is history, not a dispatch conflict');
  });
}

// ============================================================ a cancelled resale

test('a resale whose delivery was undone and cancelled hands on the ORIGINAL warranty — never a fresh one from today, never the cancelled line\'s extension', async () => {
  const w = world();
  const u1 = await saraBought(w);
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }], { user: 'u2' });
  w.raw.exec(`UPDATE order_items SET warranty_snapshot = '{"plan_id":"wp_ext12","duration_kind":"extension","duration_months":12,"total_months":24,"base_months":12}' WHERE id = 'l2'`);
  assert.equal((await scan(w, 'adm', 'ORD-2', 'l2', 1, SN)).status, 200);
  assert.equal((await deliver(w, 'ORD-2')).status, 200);
  assert.equal(unitOf(w, 'ORD-2').warranty_end_at, addMonths(String(u1.warranty_end_at), 12), 'the cancelled line had bought +12');
  // The delivery is undone and the order cancelled.
  w.raw.exec(`UPDATE orders SET status = 'shipped', stage = 'out_for_delivery' WHERE id = 'ORD-2'`);
  w.raw.exec(`UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id = 'ORD-2'`);
  assert.equal(unitOf(w, 'ORD-2').warranty_closed_reason, 'order_cancelled');

  order(w.raw, 'ORD-3', [{ id: 'l3', product: 'pA1' }], { user: 'u1' });
  const s = await json(await scan(w, 'adm', 'ORD-3', 'l3', 1, SN));
  assert.equal(s.success, true, JSON.stringify(s));
  assert.equal(s.slot.assignment.warranty.mode, 'carry', 'not a new warranty');
  assert.equal((await deliver(w, 'ORD-3')).status, 200);
  const u3 = unitOf(w, 'ORD-3');
  assert.equal(u3.warranty_start_at, u1.warranty_start_at, 'the original start');
  assert.equal(u3.warranty_end_at, u1.warranty_end_at, 'the original end — not +12 from the cancelled line');
  const pv = JSON.parse(String(u3.policy_version));
  assert.equal(pv.resale_of, u1.id, 'carried from the unit the cancelled sale carried from');
  assert.equal(pv.origin_unit_id, u1.id);
  assert.equal(row(w.raw, 'SELECT unit_id FROM device_serials WHERE serial_norm = ?', SN)!.unit_id, u3.id);
});

// ============================================================ the head start (S8)

/** A resale whose activation failed at delivery: the unit carries the original window, the binding still pending. */
async function headStartLeft(w: W) {
  const u1 = await saraBought(w);
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }], { user: 'u2' });
  assert.equal((await scan(w, 'adm', 'ORD-2', 'l2', 1, SN)).status, 200);
  const delivered = new Date().toISOString();
  w.raw.prepare("UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = ? WHERE id = 'ORD-2'").run(delivered);
  const { failing, db } = failingD1(w.raw);
  failing.failWhen = (st) => st.some((x) => /INSERT INTO device_serials/.test(x.sql));
  const r = await createUnitsOnDelivery({ DB: db } as never, 'ORD-2', delivered);
  assert.equal(r.activation?.conflicts, 1, 'activation failed');
  const born = unitOf(w, 'ORD-2');
  assert.equal(born.warranty_end_at, u1.warranty_end_at, 'born with the carried window (S8)');
  const pending = row<{ id: string }>(w.raw, "SELECT id FROM serial_assignments WHERE order_id = 'ORD-2' AND released_at IS NULL")!;
  return { u1, born, delivered, pending };
}

test('S8 undone: the owner unlinks the never-activated carry binding after delivery → the unit goes back to its own window, audited', async () => {
  const w = world();
  const { born, delivered, pending } = await headStartLeft(w);
  const res = await post(as(w, 'boss'), '/api/admin/orders/ORD-2/serials/unlink', { assignment_id: pending.id, reason: 'wrong device scanned at the counter' });
  assert.equal(res.status, 200, await res.clone().text());
  const after = unitOf(w, 'ORD-2');
  assert.equal(after.warranty_start_at, delivered, 'its own start: this delivery');
  assert.equal(after.warranty_end_at, addMonths(delivered, 12), 'its own line\'s 12 months');
  assert.equal(JSON.parse(String(after.policy_version)).carried, undefined, 'no longer carries another device\'s warranty');
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'device.window_restored' AND target = ?", born.id)!.detail);
  assert.equal(audit.assignment_id, pending.id);
  assert.equal(audit.from.end_at, born.warranty_end_at);
});

test('S8 undone: a different serial typed on the delivered unit displaces the pending carry binding → the unit goes back to its own window', async () => {
  const w = world();
  const { delivered } = await headStartLeft(w);
  const unit = unitOf(w, 'ORD-2');
  const res = await post(as(w, 'boss'), `/api/devices/admin/units/${unit.id}/serial`, { serial: SN2 });
  assert.equal(res.status, 200, await res.clone().text());
  const after = unitOf(w, 'ORD-2');
  assert.equal(after.warranty_start_at, delivered);
  assert.equal(after.warranty_end_at, addMonths(delivered, 12));
  assert.equal(row(w.raw, 'SELECT unit_id FROM device_serials WHERE serial_norm = ?', SN2)!.unit_id, unit.id);
});

// ============================================================ the order's units

test('a slot whose device was traded in no longer reads «delivered without a serial»', async () => {
  const w = world();
  await saraBought(w);
  const before = (await json(await get(as(w, 'adm'), '/api/admin/orders/ORD-1/serials'))).serials.slots[0];
  assert.ok(!before.flags.includes('SERIAL_MISSING_AT_DELIVERY'));
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  const after = (await json(await get(as(w, 'adm'), '/api/admin/orders/ORD-1/serials'))).serials.slots[0];
  assert.equal(after.assignment, null, 'its binding was released on purpose');
  assert.ok(!after.flags.includes('SERIAL_MISSING_AT_DELIVERY'), JSON.stringify(after.flags));
});

// ============================================================ the used-sale period, shown consistently

/** A used-listing resale (one month of used-sale period — a listing offers 1 or 12) whose original warranty has `daysLeft` days to run. */
async function usedResale(w: W, daysLeft: number) {
  usedListing(w, 1);
  const u1 = await saraBought(w);
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1u' }], { user: 'u2' });
  assert.equal((await json(await scan(w, 'ast', 'ORD-2', 'l2', 1, SN))).success, true);
  assert.equal((await deliver(w, 'ORD-2')).status, 200);
  const u2 = unitOf(w, 'ORD-2');
  const end = new Date(Date.now() + daysLeft * DAY).toISOString();
  w.raw.prepare('UPDATE order_item_units SET warranty_end_at = ? WHERE id = ?').run(end, u2.id);
  assert.equal((await post(as(w, 'u2'), `/api/devices/units/${u2.id}/register`)).status, 200);
  return { u1, u2: unitOf(w, 'ORD-2'), usedEnd: JSON.parse(String(u2.policy_version)).used_sale.end_at as string };
}

test('the cover in force and ITS end travel together: the device card, the order units and a claim never pair used-sale days with the original end', async () => {
  const w = world();
  const { u2, usedEnd } = await usedResale(w, 20); // the original has 20 days left, the used-sale period about 30
  const card = (await json(await get(as(w, 'u2'), '/api/devices/mine'))).devices[0];
  assert.equal(card.warranty.state, 'active');
  assert.equal(card.warranty.covered_via, 'used_sale', 'the longer cover is the one in force');
  assert.equal(card.warranty.cover_end_at, usedEnd);
  assert.equal(card.warranty.end_at, u2.warranty_end_at, 'the original end is still reported');
  assert.ok(card.warranty.remaining_days > 25, `${card.warranty.remaining_days}`);
  const units = (await json(await get(as(w, 'u2'), '/api/orders/ORD-2/units'))).units[0];
  assert.equal(units.warranty.covered_via, 'used_sale');
  assert.equal(units.warranty.cover_end_at, usedEnd);
  // The original over: a claim is accepted and says which cover and until when.
  w.raw.prepare('UPDATE order_item_units SET warranty_end_at = ? WHERE id = ?').run(new Date(Date.now() - DAY).toISOString(), u2.id);
  const claim = await post(as(w, 'u2'), `/api/devices/units/${u2.id}/claims`, { subject: 'شاشة لا تعمل', description: 'the screen stays black after power on' });
  assert.equal(claim.status, 200, await claim.clone().text());
  const facts = (await json(claim)).warranty_facts;
  assert.equal(facts.state, 'active');
  assert.equal(facts.covered_via, 'used_sale');
  assert.equal(facts.cover_end_at, usedEnd);
});

test('the public receipt page verifies a used-listing resale as covered while its used-sale period runs — and says so', async () => {
  const w = world();
  const { u2, usedEnd } = await usedResale(w, 20);
  assert.equal((await post(as(w, 'boss'), '/api/admin/warranties', { unit_id: u2.id })).status, 200);
  const wr = row<WarrantyReceiptRow>(w.raw, "SELECT * FROM warranty_receipts WHERE unit_id = ? AND status = 'active'", u2.id)!;
  // The original window over: the paper's own dates say expired, the device is still covered.
  w.raw.prepare('UPDATE warranty_receipts SET warranty_end_at = ? WHERE id = ?').run(new Date(Date.now() - DAY).toISOString(), wr.id);
  const res = await json(await get(as(w, 'u2'), `/api/warranty/verify/${wr.receipt_no}`));
  assert.equal(res.found, true);
  assert.equal(res.warranty.status, 'active');
  assert.equal(res.warranty.covered_via, 'used_sale');
  assert.deepEqual(res.warranty.used_sale, { months: 1, end_at: usedEnd });
  assert.ok(res.warranty.days_remaining > 25);
  // Never for a paper that is not the live one.
  const now = new Date().toISOString();
  const used = { months: 1, start_at: now, end_at: usedEnd };
  assert.equal(publicView({ ...wr, status: 'void' }, now, used).status, 'void');
  assert.equal(publicView({ ...wr, status: 'replaced' }, now, used).status, 'replaced');
  // And a receipt with no used-sale period reads exactly as before.
  const plain = publicView({ ...wr, warranty_end_at: new Date(Date.now() - DAY).toISOString() }, now);
  assert.equal(plain.status, 'expired');
  assert.equal(plain.used_sale, null);
});

test('every paper prints the used-sale period: a reissue with fresh terms keeps it, and the order\'s warranty slip shows it', async () => {
  const w = world();
  const { u1, u2 } = await usedResale(w, 200);
  assert.equal((await post(as(w, 'boss'), '/api/admin/warranties', { unit_id: u2.id })).status, 200);
  const wr = row<R>(w.raw, "SELECT id FROM warranty_receipts WHERE unit_id = ? AND status = 'active'", u2.id)!;
  const re = await post(as(w, 'boss'), `/api/admin/warranties/${wr.id}/reissue`, { reason: 'lost paper, printed again', refresh_terms: true });
  assert.equal(re.status, 200, await re.clone().text());
  const fresh = row<R>(w.raw, "SELECT coverage_text, coverage_text_en, warranty_start_at FROM warranty_receipts WHERE unit_id = ? AND status = 'active'", u2.id)!;
  assert.match(String(fresh.coverage_text), /مدة بيع المستعمل: شهر واحد/);
  assert.match(String(fresh.coverage_text_en), /Used-sale period: 1 month until/);
  assert.equal(fresh.warranty_start_at, u1.warranty_start_at, 'the original start');
  const slip = await get(as(w, 'boss'), '/api/admin/orders/ORD-2/warranty-receipt');
  assert.equal(slip.status, 200, await slip.clone().text());
  const html = await slip.text();
  assert.match(html, /مدة بيع المستعمل/);
  assert.match(html, /شهر واحد/);
  assert.ok(html.includes(String(u1.warranty_start_at).slice(0, 10)), 'the slip starts at the first delivery');
});

test('a reissue of an OLDER resale (recorded before its origin was) prints the first delivery, as «generate» does', async () => {
  const w = world();
  const u1 = await saraBought(w);
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }], { user: 'u2' });
  assert.equal((await scan(w, 'adm', 'ORD-2', 'l2', 1, SN)).status, 200);
  assert.equal((await deliver(w, 'ORD-2')).status, 200);
  const u2 = unitOf(w, 'ORD-2');
  // How the code before decision 3 wrote a resale: the end carried, the start this delivery, no origin.
  w.raw
    .prepare('UPDATE order_item_units SET warranty_start_at = delivered_at, policy_version = ? WHERE id = ?')
    .run(JSON.stringify({ v: 1, carried: 'original_end', resale_of: u1.id, base: 12, ext: 0, total: 12 }), u2.id);
  w.raw
    .prepare(`INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, serial_norm, serial_raw, status, warranty_start_at, warranty_end_at)
              VALUES ('wr_old', 'WR-2026-1009-150', ?, 'ORD-2', 'l2', ?, ?, 'active', ?, ?)`)
    .run(u2.id, SN, SN, u2.delivered_at, u2.warranty_end_at);
  const re = await post(as(w, 'boss'), '/api/admin/warranties/wr_old/reissue', { reason: 'printed again for the customer' });
  assert.equal(re.status, 200, await re.clone().text());
  const fresh = row<R>(w.raw, "SELECT warranty_start_at FROM warranty_receipts WHERE unit_id = ? AND status = 'active'", u2.id)!;
  assert.equal(fresh.warranty_start_at, u1.delivered_at, 'the first delivery, through `resale_of`');
});

// ============================================================ words

test('months and days are written with their plurals in all three languages — the part that is zero is left out', () => {
  assert.deepEqual([1, 2, 3, 10, 11, 12].map((n) => monthsWords(n, 'ar')), ['شهر واحد', 'شهران', '3 أشهر', '10 أشهر', '11 شهرًا', '12 شهرًا']);
  assert.deepEqual([1, 2, 5, 11].map((n) => daysWords(n, 'ar')), ['يوم واحد', 'يومان', '5 أيام', '11 يومًا']);
  assert.deepEqual([1, 2].map((n) => monthsWords(n, 'en')), ['1 month', '2 months']);
  assert.deepEqual([1, 2].map((n) => daysWords(n, 'en')), ['1 day', '2 days']);
  assert.equal(monthsWords(3, 'ckb'), '3 مانگ');
  assert.equal(timeLeftWords({ months: 11, days: 0 }, 'ar'), '11 شهرًا', 'the owner\'s example: no «و0 يوم»');
  assert.equal(timeLeftWords({ months: 11, days: 0 }, 'en'), '11 months');
  assert.equal(timeLeftWords({ months: 1, days: 1 }, 'en'), '1 month 1 day');
  assert.equal(timeLeftWords({ months: 3, days: 5 }, 'ar'), '3 أشهر و5 أيام');
  assert.equal(timeLeftWords({ months: 3, days: 5 }, 'ckb'), '3 مانگ و 5 ڕۆژ');
  assert.equal(timeLeftWords({ months: 0, days: 2 }, 'ar'), 'يومان');
});

test('one term for the used-sale period: the screens and the receipts use the warranty policy\'s own words, in three languages', () => {
  const policy = readFileSync(join(ROOT, 'worker/lib/policies/warranty.ts'), 'utf8');
  const screens = readFileSync(join(ROOT, 'src/components/warranty/strings.ts'), 'utf8');
  const receipts = readFileSync(join(ROOT, 'worker/routes/warranty.ts'), 'utf8');
  for (const term of ['مدة بيع المستعمل', 'used-sale period', 'ماوەی فرۆشتنی بەکارهاتوو']) assert.ok(policy.includes(term), `policy: ${term}`);
  for (const term of ['مدة بيع المستعمل', 'Used-sale period', 'ماوەی فرۆشتنی بەکارهاتوو']) assert.ok(screens.includes(term), `screens: ${term}`);
  for (const old of ['تغطية بيع المستعمل', 'Used-sale cover', 'پاراستنی فرۆشتنی بەکارهاتوو']) {
    assert.ok(!screens.includes(old) && !receipts.includes(old), `the old term is gone: ${old}`);
  }
  // The trade-in line on the order's units names it a trade-in to Levonis — never the bare
  // «استُبدل» the warranty-replacement line on the same screen uses.
  const units = readFileSync(join(ROOT, 'src/components/orders/OrderUnits.tsx'), 'utf8');
  assert.match(units, /استُبدل لدى Levonis \(Trade-in\) في/);
  assert.match(units, /Traded in to Levonis on/);
  assert.match(units, /لای Levonis گۆڕدرایەوە \(Trade-in\)/);
  // The claim form and «add from my orders» read a refusal by its code, in the reader's language.
  for (const f of ['src/components/warranty/ClaimForms.tsx', 'src/components/warranty/AddDevicePanel.tsx']) {
    assert.match(readFileSync(join(ROOT, f), 'utf8'), /apiRefusal\(/, f);
  }
});
