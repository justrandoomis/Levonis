/**
 * A TRADE-IN KEEPS THE ORIGINAL WARRANTY (owner decision 3, 2026-10-09;
 * docs/DECISIONS.md row 193; warranty policy version 4).
 *
 * «Do NOT close the old warranty when a trade-in completes. The warranty stays
 * linked to the same serial and runs from the ORIGINAL order's delivery date.
 * Example: 12-month warranty, delivered 30 days ago, then traded in → about 11
 * months remain. No new warranty from zero, no reset … If the device is
 * resold, same serial and same warranty history, showing the true remaining
 * warranty.» Each test below is one sentence of that, through the real routes
 * on a real database (tests/fixtures/serialPrep.ts) with the real trade-in,
 * device, order, warranty-receipt and support doors mounted.
 *
 * The trade-in requests are written straight into `awaiting_payment` with no
 * credit (the money journey is tests/tradeInFlow.test.ts): what is proved
 * here is what completing one does to the DEVICE.
 *
 * Run: node --import tsx --test tests/tradeInWarrantyContinuity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, get, row, count, stubApp, failingD1, type StubUser } from './fixtures/app';
import { world, order, op, SN, USERS, mountSerialWorld } from './fixtures/serialPrep';
import { adminTradeInRoutes } from '../worker/routes/tradeIn';
import { supportRoutes } from '../worker/routes/support';
import { completeRequest, loadRequest } from '../worker/lib/tradeIn';
import { createUnitsOnDelivery, recomputeUnitWindow, coverageState, type UnitRow } from '../worker/lib/deviceOps';
import { addMonths } from '../worker/lib/membershipOps';
import { publicView, type WarrantyReceiptRow } from '../worker/lib/warranty';
import { warrantyTimeLeft } from '../packages/pricing/src/warrantyTime';
import { warrantyMonthsLeft } from '../packages/pricing/src/tradeIn';

type W = ReturnType<typeof world>;
type R = Record<string, string | number | null>;
const DAY = 86_400_000;

const PREP: StubUser = { id: 'prep', role: 'admin', email: 'prep@x.co', admin_scope: 'assistant' };
const MERCHANT: StubUser = { id: 'm1', role: 'merchant', email: 'm1@x.co' };
type Who = keyof typeof USERS | 'prep' | 'merchant' | 'anon';

/** The serial world plus the trade-in desk and the support assistant. */
const as = (w: W, who: Who) =>
  stubApp(w.db, who === 'anon' ? null : who === 'prep' ? PREP : who === 'merchant' ? MERCHANT : USERS[who], (a) => {
    a.route('/api/admin/trade-in', adminTradeInRoutes);
    a.route('/api/support', supportRoutes);
    mountSerialWorld(a);
  });

const scan = (w: W, who: Who, o: string, item: string, unit: number, code: string) =>
  post(as(w, who), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: unit, code, source: 'scanner', op_id: op() });
const deliver = (w: W, o: string) => patch(as(w, 'adm'), `/api/admin/orders/${o}/stage`, { stage: 'delivered' });
const unitOf = (w: W, o: string) => row<R>(w.raw, 'SELECT * FROM order_item_units WHERE order_id = ? ORDER BY unit_index', o)!;

let reqSeq = 0;
/** A trade-in request for one unit, waiting only for «إتمام الاستبدال» (no credit to redeem). */
function tradeIn(w: W, o: { user: string; order: string; item: string; scope?: 'whole' | 'printer_only' | 'ams_only' }): string {
  const id = `tin_${(++reqSeq).toString(16).padStart(20, '0')}`;
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

function receipt(w: W, id: string, no: string, unitId: string, o: string, item: string, serial: string) {
  w.raw
    .prepare(
      `INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, serial_norm, serial_raw, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
    )
    .run(id, no, unitId, o, item, serial, serial);
}

/**
 * THE OWNER'S EXAMPLE, SET UP: Sara (u1) bought an A1 with the 12-month
 * warranty, delivered 30 days ago, linked it to her account and holds its
 * receipt. Returns the unit.
 */
async function saraBought(w: W, o = 'ORD-1', item = 'l1', serial = SN, receiptNo = 'WR-2026-1009-101') {
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
  receipt(w, `wr_${o}`, receiptNo, String(u.id), o, item, serial);
  return u;
}

// ============================================================ the owner's example

test('the owner\'s example: 12 months, traded in on day 30 → about 11 months remain on the SAME warranty; nothing is closed, nothing restarts', async () => {
  const w = world();
  const u = await saraBought(w);
  const id = tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' });
  const res = await complete(w, 'adm', id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await json(res)).request.status, 'completed');

  const after = unitOf(w, 'ORD-1');
  assert.equal(after.warranty_closed_at, null, 'the warranty is NOT closed');
  assert.equal(after.warranty_closed_reason, null);
  assert.equal(after.warranty_start_at, u.warranty_start_at, 'it runs from the original delivery');
  assert.equal(after.warranty_end_at, u.warranty_end_at, 'its end is unchanged');
  const cov = coverageState(String(after.delivered_at), String(after.warranty_end_at));
  assert.equal(cov.state, 'active');
  assert.equal(cov.remaining_days, 335, '365 − 30 days remain');
  // The trader's link ends on the trade-in date; the serial is the shop's to sell again.
  assert.ok(row(w.raw, 'SELECT revoked_at FROM device_registrations WHERE unit_id = ?', u.id)!.revoked_at);
  const a = row<R>(w.raw, "SELECT release_reason, release_note, released_by FROM serial_assignments WHERE order_id = 'ORD-1'")!;
  assert.deepEqual(a, { release_reason: 'traded_in', release_note: `trade_in:${id}`, released_by: 'adm' });
  assert.equal(row(w.raw, "SELECT status FROM warranty_receipts WHERE id = 'wr_ORD-1'")!.status, 'active', 'the receipt is untouched');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM order_item_units'), 1, 'no new warranty record');
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.traded_in' AND target = ?", SN)!.detail);
  assert.equal(audit.request_id, id);
  assert.equal(audit.unit_id, u.id);
  assert.equal(audit.start_at, u.warranty_start_at);
  assert.equal(audit.end_at, u.warranty_end_at);
  assert.ok(audit.traded_in_at);
  // The serial page: back in stock, its one warranty still running from the first delivery.
  const page = await json(await get(as(w, 'boss'), `/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(page.story.status, 'returned');
  assert.equal(page.story.warranty.start_at, u.warranty_start_at);
  assert.equal(page.story.warranty.end_at, u.warranty_end_at);
  assert.ok(page.story.warranty.traded_in_at);
});

test('what is left reads in calendar months and days — «11 months 0 days» where the rounded-up money rule says 12 (display only)', () => {
  const delivered = '2026-04-01T09:00:00.000Z';
  const end = addMonths(delivered, 12);
  const tradedIn = '2026-05-01T09:00:00.000Z'; // day 30
  assert.deepEqual(warrantyTimeLeft(end, tradedIn), { months: 11, days: 0 });
  assert.equal((Date.parse(end) - Date.parse(tradedIn)) / DAY, 335);
  assert.equal(warrantyMonthsLeft(end, tradedIn), 12, 'the valuation keeps its own rounding — a money rule, unchanged');
  assert.deepEqual(warrantyTimeLeft(end, '2026-05-11T09:00:00.000Z'), { months: 10, days: 21 });
  assert.deepEqual(warrantyTimeLeft(end, end), { months: 0, days: 0 });
  assert.deepEqual(warrantyTimeLeft(null, tradedIn), { months: 0, days: 0 });
  // Month-end clamping, as addMonths does it.
  assert.deepEqual(warrantyTimeLeft('2027-02-28T00:00:00.000Z', '2027-01-31T00:00:00.000Z'), { months: 1, days: 0 });
});

test('the completion is ONE batch behind the request\'s fence: when it fails, no link is revoked, no binding released, no history written', async () => {
  const w = world();
  const u = await saraBought(w);
  const id = tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' });
  const { failing, db } = failingD1(w.raw);
  failing.failWhen = (s) => s.some((x) => /release_reason = 'traded_in'/.test(x.sql));
  const env = { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co' } as never;
  await assert.rejects(completeRequest(env, (await loadRequest(db, id))!, 'adm'));
  assert.equal(row(w.raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'awaiting_payment');
  assert.equal(row(w.raw, 'SELECT revoked_at FROM device_registrations WHERE unit_id = ?', u.id)!.revoked_at, null);
  assert.equal(row(w.raw, "SELECT released_at FROM serial_assignments WHERE order_id = 'ORD-1'")!.released_at, null);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.traded_in'"), 0);
  failing.failWhen = null;
  await completeRequest(env, (await loadRequest(db, id))!, 'adm');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.traded_in'"), 1);
});

// ============================================================ the customer's doors

test('every customer door treats a traded-in device as no longer the trader\'s — and a stranger gets the one non-enumerating answer', async () => {
  const w = world();
  const u = await saraBought(w);
  const mine = await json(await get(as(w, 'u1'), '/api/devices/mine'));
  assert.equal(mine.devices.length, 1, 'before the trade-in it is hers');
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  // A trade-in completed BEFORE this code left the link live: every door must still say no.
  w.raw.prepare('UPDATE device_registrations SET revoked_at = NULL WHERE unit_id = ?').run(u.id);

  assert.equal((await json(await get(as(w, 'u1'), '/api/devices/mine'))).devices.length, 0, '«أجهزتي» no longer lists it');
  const eligible = await json(await get(as(w, 'u1'), '/api/devices/eligible'));
  assert.ok(!eligible.units.some((x: { unit_id: string }) => x.unit_id === u.id), '«أضف من طلباتي» no longer offers it');
  for (const who of ['u1', 'u2'] as const) {
    for (const typed of [SN, 'WR-2026-1009-101']) {
      const r = await post(as(w, who), '/api/devices/register', { serial: typed });
      assert.equal(r.status, 404, `${who} typing ${typed}`);
      assert.equal((await json(r)).code, 'SERIAL_NOT_FOUND_OR_IN_USE');
    }
  }
  const relink = await post(as(w, 'u1'), `/api/devices/units/${u.id}/register`);
  assert.equal(relink.status, 409);
  assert.equal((await json(relink)).code, 'DEVICE_NOT_WITH_CUSTOMER');
  const claim = await post(as(w, 'u1'), `/api/devices/units/${u.id}/claims`, { subject: 'نوزل مسدود', description: 'the nozzle clogs after an hour of printing' });
  assert.equal(claim.status, 409);
  assert.equal((await json(claim)).code, 'DEVICE_NOT_WITH_CUSTOMER');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM warranty_claims'), 0);
  // A stranger is told nothing about whose it is.
  assert.equal((await post(as(w, 'u2'), `/api/devices/units/${u.id}/claims`, { subject: 'x'.repeat(5), description: 'y'.repeat(20) })).status, 404);
  // The support assistant's device card no longer shows it.
  const reply = (await json(await post(as(w, 'u1'), '/api/support/assistant', { locale: 'en', intent: 'my_devices' }))).reply;
  assert.equal((reply.cards ?? []).length, 0, 'the support card hides it');
  // The order says so, with the warranty that stays with the device.
  const units = await json(await get(as(w, 'u1'), '/api/orders/ORD-1/units'));
  assert.ok(units.units[0].traded_in_at);
  assert.equal(units.units[0].warranty.state, 'active');
  assert.equal(units.units[0].warranty.end_at, u.warranty_end_at);
});

test('a returned device cannot be re-linked by its buyer through «من طلباتي» (/units/:id/register): DEVICE_NOT_WITH_CUSTOMER', async () => {
  const w = world();
  const u = await saraBought(w);
  w.raw.exec(`INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state) VALUES ('rc_1','ORD-1','l1','${u.id}','u1',1,'defective','inspected')`);
  assert.equal((await post(as(w, 'adm'), '/api/returns/admin/rc_1/transition', { to: 'resolved', resolution: 'refund', serials: [SN] })).status, 200);
  const relink = await post(as(w, 'u1'), `/api/devices/units/${u.id}/register`);
  assert.equal(relink.status, 409);
  assert.equal((await json(relink)).code, 'DEVICE_NOT_WITH_CUSTOMER');
  assert.ok(row(w.raw, 'SELECT revoked_at FROM device_registrations WHERE unit_id = ?', u.id)!.revoked_at, 'the return\'s revocation stands');
});

test('an AMS-only trade-in leaves the printer with its owner: linked, listed, its serial binding active', async () => {
  const w = world();
  const u = await saraBought(w);
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1', scope: 'ams_only' }));
  assert.equal(row(w.raw, 'SELECT revoked_at FROM device_registrations WHERE unit_id = ?', u.id)!.revoked_at, null);
  assert.equal((await json(await get(as(w, 'u1'), '/api/devices/mine'))).devices.length, 1);
  assert.equal(row(w.raw, "SELECT released_at FROM serial_assignments WHERE order_id = 'ORD-1'")!.released_at, null);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial.traded_in'"), 0);
  // …and the device is still the customer's to the serial scan: staff cannot sell it.
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }], { user: 'u2' });
  assert.equal((await json(await scan(w, 'adm', 'ORD-2', 'l2', 1, SN))).code, 'SERIAL_DELIVERED');
});

// ============================================================ resale

/** A used listing of the A1: graded `used`, one month of used-sale cover, a copy of pA1. */
function usedListing(w: W) {
  w.raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, price_iqd, ops_policy, condition_doc)
      VALUES ('pA1u', 'sp-a1-used', 'Bambu Lab A1 Combo (used)', 'طابعة A1 كومبو مستعملة', 650000,
              '{"serialized":true,"warranty_base_months":1}',
              '{"kind":"used","grade":"good","warranty_months":1,"new_product_id":"pA1"}');
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pA1u', 'ct_print', 9);
  `);
}

test('resale under the used listing: no owner exception, the SAME warranty (start, end, base, ext, origin), the old receipt replaced, the used-sale cover kept apart, a claim accepted while either runs, and a second resale keeps the origin', async () => {
  const w = world();
  usedListing(w);
  const u1 = await saraBought(w);
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));

  // Staff scan it onto Omar's order for the used listing — a normal resale.
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1u' }], { user: 'u2' });
  const s = await json(await scan(w, 'ast', 'ORD-2', 'l2', 1, SN));
  assert.equal(s.success, true, JSON.stringify(s));
  assert.equal(s.slot.assignment.override_kind, null, 'no owner exception is needed');
  assert.equal(s.slot.assignment.warranty.mode, 'carry');
  assert.equal(s.slot.assignment.warranty.carries_until, u1.warranty_end_at);
  assert.deepEqual(s.warnings, []);
  assert.equal((await deliver(w, 'ORD-2')).status, 200);
  const u2 = unitOf(w, 'ORD-2');
  assert.equal(u2.warranty_start_at, u1.warranty_start_at, 'the original start');
  assert.equal(u2.warranty_end_at, u1.warranty_end_at, 'the original end');
  assert.equal(u2.warranty_base_months, u1.warranty_base_months, 'the original base, not the used listing\'s month');
  assert.equal(Number(u2.warranty_ext_months), Number(u1.warranty_ext_months));
  const pv = JSON.parse(String(u2.policy_version));
  assert.equal(pv.carried, 'original_end');
  assert.equal(pv.resale_of, u1.id);
  assert.equal(pv.origin_unit_id, u1.id);
  assert.equal(pv.origin_start_at, u1.warranty_start_at);
  assert.deepEqual(pv.used_sale, { months: 1, start_at: u2.delivered_at, end_at: addMonths(String(u2.delivered_at), 1) });
  // The first unit is history, never closed; its receipt is superseded.
  const old = unitOf(w, 'ORD-1');
  assert.equal(old.warranty_closed_at, null);
  assert.equal(old.warranty_end_at, u1.warranty_end_at);
  const oldReceipt = row<R>(w.raw, "SELECT status, void_reason FROM warranty_receipts WHERE id = 'wr_ORD-1'")!;
  assert.deepEqual(oldReceipt, { status: 'replaced', void_reason: 'resold' });
  assert.equal(row(w.raw, 'SELECT unit_id FROM device_serials WHERE serial_norm = ?', SN)!.unit_id, u2.id);

  // The new receipt prints the ORIGINAL window, the true days remaining, and the used-sale line.
  const issued = await post(as(w, 'boss'), '/api/admin/warranties', { unit_id: u2.id });
  assert.equal(issued.status, 200, await issued.clone().text());
  const wr = row<WarrantyReceiptRow>(w.raw, "SELECT * FROM warranty_receipts WHERE unit_id = ? AND status = 'active'", u2.id)!;
  assert.equal(wr.warranty_start_at, u1.warranty_start_at);
  assert.equal(wr.warranty_end_at, u1.warranty_end_at);
  assert.match(wr.coverage_text, /تغطية بيع المستعمل: 1 شهر/);
  assert.match(wr.coverage_text_en, /Used-sale cover: 1 month\(s\)/);
  const view = publicView(wr, new Date().toISOString());
  assert.ok(view.days_remaining! >= 334 && view.days_remaining! <= 336, `true days remaining, not a fresh year: ${view.days_remaining}`);

  // Omar links it; his card shows the carried warranty and the dates-only history.
  assert.equal((await post(as(w, 'u2'), `/api/devices/units/${u2.id}/register`)).status, 200);
  const card = (await json(await get(as(w, 'u2'), '/api/devices/mine'))).devices[0];
  assert.equal(card.warranty.carried, true);
  assert.equal(card.warranty.origin_start_at, u1.warranty_start_at);
  assert.equal(card.warranty.used_sale.months, 1);
  assert.deepEqual(card.history.map((h: { kind: string }) => h.kind), ['first', 'traded_in', 'resold']);
  assert.equal(card.order_id, u2.order_id, 'his own order');
  assert.ok(!JSON.stringify(card.history).includes('u1') && !JSON.stringify(card.history).includes('ORD-1'), 'no identity of the previous owner');

  // Months later the original warranty has run out, the used-sale cover has not: covered.
  w.raw.prepare('UPDATE order_item_units SET warranty_end_at = ? WHERE id = ?').run(new Date(Date.now() - DAY).toISOString(), u2.id);
  const claim = await post(as(w, 'u2'), `/api/devices/units/${u2.id}/claims`, { subject: 'شاشة لا تعمل', description: 'the screen stays black after power on' });
  assert.equal(claim.status, 200, await claim.clone().text());
  assert.equal((await json(claim)).warranty_facts.state, 'active', 'accepted while either is in force');
  assert.equal((await json(await get(as(w, 'u2'), '/api/devices/mine'))).devices[0].warranty.state, 'active');
  w.raw.prepare('UPDATE order_item_units SET warranty_end_at = ? WHERE id = ?').run(u1.warranty_end_at, u2.id);

  // Omar trades it in too; resold again on a new listing: the SAME origin.
  w.raw.prepare('UPDATE device_registrations SET revoked_at = NULL WHERE unit_id = ?').run(u2.id);
  await complete(w, 'adm', tradeIn(w, { user: 'u2', order: 'ORD-2', item: 'l2' }));
  order(w.raw, 'ORD-3', [{ id: 'l3', product: 'pA1' }], { user: 'u1' });
  assert.equal((await scan(w, 'adm', 'ORD-3', 'l3', 1, SN)).status, 200);
  assert.equal((await deliver(w, 'ORD-3')).status, 200);
  const u3 = unitOf(w, 'ORD-3');
  const pv3 = JSON.parse(String(u3.policy_version));
  assert.equal(pv3.origin_unit_id, u1.id, 'the origin stays the first sale');
  assert.equal(pv3.origin_start_at, u1.warranty_start_at);
  assert.equal(pv3.resale_of, u2.id);
  assert.equal(u3.warranty_start_at, u1.warranty_start_at);
  assert.equal(u3.warranty_end_at, u1.warranty_end_at);
  assert.equal(pv3.used_sale, undefined, 'a new listing carries no used-sale cover');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 1, 'one asset, ever');
});

test('a resale on a new listing with a purchased +12 plan: end = the ORIGINAL end + 12 months, start unchanged', async () => {
  const w = world();
  const u1 = await saraBought(w);
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }], { user: 'u2' });
  w.raw.exec(`UPDATE order_items SET warranty_snapshot = '{"plan_id":"wp_ext12","duration_kind":"extension","duration_months":12,"total_months":24,"base_months":12}' WHERE id = 'l2'`);
  assert.equal((await scan(w, 'adm', 'ORD-2', 'l2', 1, SN)).status, 200);
  assert.equal((await deliver(w, 'ORD-2')).status, 200);
  const u2 = unitOf(w, 'ORD-2');
  assert.equal(u2.warranty_start_at, u1.warranty_start_at);
  assert.equal(u2.warranty_end_at, addMonths(String(u1.warranty_end_at), 12));
  assert.equal(Number(u2.warranty_ext_months), Number(u1.warranty_ext_months) + 12);
  assert.equal(JSON.parse(String(u2.policy_version)).total, 24, 'the original 12 plus the 12 bought');
});

test('restart is retired: 409 WARRANTY_RESTART_RETIRED at the warranty-mode door and at the owner\'s override, for the owner too', async () => {
  const w = world();
  await saraBought(w);
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }], { user: 'u2' });
  const mode = await post(as(w, 'boss'), `/api/devices/admin/serial-inventory/${SN}/warranty-mode`, { mode: 'restart', reason: 'a fresh year for the buyer' });
  assert.equal(mode.status, 409);
  assert.equal((await json(mode)).code, 'WARRANTY_RESTART_RETIRED');
  const ov = await post(as(w, 'boss'), '/api/admin/orders/ORD-2/serials/override', {
    order_item_id: 'l2', unit_index: 1, code: SN, kind: 'delivered_device', reason: 'a fresh year for the buyer', warranty_mode: 'restart', op_id: op(),
  });
  assert.equal(ov.status, 409);
  assert.equal((await json(ov)).code, 'WARRANTY_RESTART_RETIRED');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_assignments WHERE order_id = 'ORD-2'"), 0, 'nothing was linked');
});

test('S8 an activation that fails leaves NO reset window: the unit is born with the carried window, and the sweep only confirms it', async () => {
  const w = world();
  const u1 = await saraBought(w);
  await complete(w, 'adm', tradeIn(w, { user: 'u1', order: 'ORD-1', item: 'l1' }));
  order(w.raw, 'ORD-2', [{ id: 'l2', product: 'pA1' }], { user: 'u2' });
  assert.equal((await scan(w, 'adm', 'ORD-2', 'l2', 1, SN)).status, 200);
  const delivered = new Date().toISOString();
  w.raw.prepare("UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = ? WHERE id = 'ORD-2'").run(delivered);
  const { failing, db } = failingD1(w.raw);
  failing.failWhen = (s) => s.some((x) => /INSERT INTO device_serials/.test(x.sql));
  const r = await createUnitsOnDelivery({ DB: db } as never, 'ORD-2', delivered);
  assert.equal(r.created, 1);
  assert.equal(r.activation?.conflicts, 1, 'activation failed');
  const born = unitOf(w, 'ORD-2');
  assert.equal(born.warranty_start_at, u1.warranty_start_at, 'never a fresh start between the batches');
  assert.equal(born.warranty_end_at, u1.warranty_end_at);
  assert.equal(JSON.parse(String(born.policy_version)).carried, 'original_end');
  failing.failWhen = null;
  const again = await createUnitsOnDelivery({ DB: db } as never, 'ORD-2', delivered);
  assert.equal(again.activation?.activated, 1);
  const done = unitOf(w, 'ORD-2');
  assert.equal(done.warranty_end_at, u1.warranty_end_at, 'activation writes the same window once more, never twice the extension');
  assert.equal(row(w.raw, 'SELECT unit_id FROM device_serials WHERE serial_norm = ?', SN)!.unit_id, done.id);
});

test('S9 recomputeUnitWindow keeps a carried START as well as its end; only the used-sale cover follows a corrected delivery date', () => {
  const unit = {
    id: 'unit_x', order_id: 'O', order_item_id: 'I', product_id: 'p', owner_user_id: 'u', unit_index: 1,
    delivered_at: '2026-10-01T00:00:00.000Z', warranty_base_months: 12, warranty_ext_months: 0,
    warranty_start_at: '2026-01-10T00:00:00.000Z', warranty_end_at: '2027-01-10T00:00:00.000Z',
    policy_version: JSON.stringify({ v: 1, carried: 'original_end', resale_of: 'unit_0', used_sale: { months: 1, start_at: '2026-10-01T00:00:00.000Z', end_at: '2026-11-01T00:00:00.000Z' } }),
    replaced_by_unit_id: null, replacement_of_unit_id: null,
  } as UnitRow;
  const win = recomputeUnitWindow(unit, '2026-09-28T00:00:00.000Z');
  assert.equal(win.start_at, '2026-01-10T00:00:00.000Z');
  assert.equal(win.end_at, '2027-01-10T00:00:00.000Z');
  assert.deepEqual(JSON.parse(win.policy_version!).used_sale, { months: 1, start_at: '2026-09-28T00:00:00.000Z', end_at: '2026-10-28T00:00:00.000Z' });
  // A unit that carries nothing still moves with its delivery, as before.
  const plain = recomputeUnitWindow({ ...unit, policy_version: JSON.stringify({ v: 1, total: 12 }) }, '2026-09-28T00:00:00.000Z');
  assert.deepEqual(plain, { start_at: '2026-09-28T00:00:00.000Z', end_at: '2027-09-28T00:00:00.000Z' });
});

// ============================================================ per-role authorization

test('completion is `op` for every admin — owner, full, assistant, and a preparer whose «الاستلام» is off; customers, merchants and strangers get nothing', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('prep','Prep','prep@x.co','h','admin','assistant'), ('m1','Shop','m1@x.co','h','merchant',NULL);
    INSERT INTO ops_permissions (user_id, capability, allowed) VALUES ('prep','receive',0);
  `);
  const admins = ['boss', 'adm', 'ast', 'prep'] as const;
  let n = 0;
  for (const who of admins) {
    n++;
    const o = `ORD-R${n}`;
    order(w.raw, o, [{ id: `lr${n}`, product: 'pA1' }], { status: 'delivered', stage: 'delivered' });
    w.raw.exec(`INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_start_at, warranty_end_at)
                VALUES ('unit_r${n}','${o}','lr${n}','pA1','u1',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2027-09-01T00:00:00.000Z')`);
    const id = tradeIn(w, { user: 'u1', order: o, item: `lr${n}` });
    const res = await complete(w, who, id);
    assert.equal(res.status, 200, `${who}: ${await res.clone().text()}`);
    const audit = row<{ actor_id: string; target: string }>(w.raw, "SELECT actor_id, target FROM audit_log WHERE action = 'serial.traded_in' AND target = ?", `unit_r${n}`)!;
    assert.equal(audit.actor_id, who, 'a unit with no serial on file is recorded by its unit id');
  }
  order(w.raw, 'ORD-X', [{ id: 'lx', product: 'pA1' }], { status: 'delivered', stage: 'delivered' });
  const id = tradeIn(w, { user: 'u1', order: 'ORD-X', item: 'lx' });
  for (const who of ['u1', 'u2', 'merchant', 'anon'] as const) {
    const listed = await get(as(w, who), '/api/admin/trade-in/requests');
    assert.ok(listed.status === 401 || listed.status === 403, `${who} list: ${listed.status}`);
    const done = await complete(w, who, id);
    assert.ok(done.status === 401 || done.status === 403, `${who} complete: ${done.status}`);
  }
  assert.equal(row(w.raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'awaiting_payment');
});
