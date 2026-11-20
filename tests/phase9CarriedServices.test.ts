/**
 * A CARRIED WINDOW NEVER OVERRIDES WHAT A PRINTER-SERVICES SALE BOUGHT (owner, 2026-11-20; DECISIONS row 365).
 *
 * Owner: «Should a resold device sold as Just Printer keep the first sale's remaining warranty?» — «no, sold as
 * smart choice». A device's cover on a printer-services line is what THAT sale bought (0 / 12 / 24 months from
 * its new delivery): a resold serial sold as Just Printer has no warranty and no receipt; sold as Smart Choice
 * it has twelve months from the new delivery — whether the window it would have carried was longer or shorter.
 * A line sold without the services carries exactly as before (owner decision 3, row 193).
 *
 * Both writers are covered through the real doors: the delivery hook's head start (S8) and the activation (A1).
 *
 * Run: node --import tsx --test tests/phase9CarriedServices.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, row } from './fixtures/app';
import { world, order, op, SN } from './fixtures/serialPrep';
import { addMonths } from '../worker/lib/membershipOps';
import { ownUnitWindow, servicesSaleMonths } from '../worker/lib/deviceOps';

type W = ReturnType<typeof world>;
type R = Record<string, string | number | null>;
const scan = (w: W, o: string, item: string, code: string) =>
  post(w.as('adm'), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: 1, code, source: 'scanner', op_id: op() });
const deliver = (w: W, o: string) => patch(w.as('adm'), `/api/admin/orders/${o}/stage`, { stage: 'delivered' });
const unitOf = (w: W, o: string) => row<R>(w.raw, 'SELECT * FROM order_item_units WHERE order_id = ? ORDER BY unit_index', o)!;

/** The frozen services of a line, as checkout writes them (the fields the device reads). */
const snapshot = (warranty: 0 | 12 | 24, pkg: string): string =>
  JSON.stringify({
    v: 1, fee_iqd: 0, warranty_months: warranty, care_months: 0, care_total_months: 0, revision: 3,
    selection: {
      v: 1, package: pkg, warranty: warranty === 0 ? 'none' : `w${warranty}`, care: 'none', packaging: 'standard',
      inspection: 'none', academy: 'none', delivery: 'economy', confirmed: true, ack_no_warranty: warranty === 0,
    },
  });

/**
 * ORD-111 sells the device, it comes back (a refunded return), and ORD-222 resells the same serial. `carriedEnd`
 * is the first sale's end the resale would carry; `services` is what the resale's line was sold with.
 */
async function resell(services: string | null, carriedEnd: (firstDelivered: string) => string) {
  const w = world();
  order(w.raw, 'ORD-111', [{ id: 'l1', product: 'pA1' }]);
  order(w.raw, 'ORD-222', [{ id: 'l2', product: 'pA1' }]);
  if (services) w.raw.prepare("UPDATE order_items SET services_snapshot = ? WHERE id = 'l2'").run(services);
  await scan(w, 'ORD-111', 'l1', SN);
  await deliver(w, 'ORD-111');
  const first = unitOf(w, 'ORD-111');
  const end = carriedEnd(String(first.delivered_at));
  w.raw.prepare('UPDATE order_item_units SET warranty_end_at = ? WHERE id = ?').run(end, first.id);
  w.raw.exec(`INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state)
    VALUES ('rc_1','ORD-111','l1','${first.id}','u1',1,'defective','inspected')`);
  const back = await post(w.as('adm'), '/api/returns/admin/rc_1/transition', { to: 'resolved', resolution: 'refund' });
  assert.equal(back.status, 200, await back.clone().text());
  const scanned = await json(await scan(w, 'ORD-222', 'l2', SN));
  assert.equal(scanned.outcome, 'existing', JSON.stringify(scanned));
  const moved = await deliver(w, 'ORD-222');
  assert.equal(moved.status, 200, await moved.clone().text());
  const delivered = row<{ delivered_at: string }>(w.raw, "SELECT delivered_at FROM orders WHERE id = 'ORD-222'")!.delivered_at;
  const firstNow: R = { ...first, warranty_end_at: end };
  return { w, first: firstNow, scanned, unit: unitOf(w, 'ORD-222'), delivered };
}

test('the rule is one pure reading: a services snapshot is the whole promise, anything else is «sold without the services»', () => {
  assert.equal(servicesSaleMonths(snapshot(0, 'just')), 0);
  assert.equal(servicesSaleMonths(snapshot(12, 'smart')), 12);
  assert.equal(servicesSaleMonths(snapshot(24, 'complete')), 24);
  for (const v of [null, undefined, '', '{}', 'garbage', JSON.stringify({ warranty_months: 6 }), JSON.stringify({ warranty_months: '12' })]) {
    assert.equal(servicesSaleMonths(v), null, String(v));
  }
  // …and it is the reading the unit's own window uses.
  const d = '2026-11-01T10:00:00.000Z';
  assert.equal(ownUnitWindow(12, null, d, snapshot(0, 'just')).cov.end_at, d);
  assert.equal(ownUnitWindow(12, null, d, snapshot(12, 'smart')).cov.end_at, addMonths(d, 12));
});

test('a resold serial sold as Just Printer has NO warranty — the first sale’s remaining months are not carried, and no receipt is issued', async () => {
  // The first sale still had twenty months to run.
  const { w, first, scanned, unit, delivered } = await resell(snapshot(0, 'just'), (d) => addMonths(d, 20));
  assert.equal(unit.warranty_start_at, delivered, 'the window is this sale’s, from its own delivery');
  assert.equal(unit.warranty_end_at, delivered, 'zero months: it ends where it starts');
  assert.notEqual(unit.warranty_end_at, first.warranty_end_at);
  assert.deepEqual([unit.warranty_base_months, Number(unit.warranty_ext_months)], [0, 0]);
  const pv = JSON.parse(String(unit.policy_version));
  assert.equal(pv.total, 0);
  assert.equal(pv.carried, undefined, 'the unit carries nothing');
  assert.equal(pv.warranty_choice, 'none');
  // The preparation screen never promised a carried warranty for it.
  assert.equal(scanned.slot.assignment.warranty.carries_until, null);
  assert.equal(scanned.slot.assignment.warranty.mode, 'new');
  // The device is this unit's (the serial moved), and the receipt door refuses in words.
  assert.equal(row(w.raw, 'SELECT unit_id FROM device_serials WHERE serial_norm = ?', SN)!.unit_id, unit.id);
  const receipt = await post(w.as('boss'), '/api/admin/warranties', { unit_id: unit.id });
  assert.equal(receipt.status, 409);
  assert.equal((await json(receipt)).code, 'NO_WARRANTY_BOUGHT');
  // The first sale's record is history, untouched.
  assert.equal(row(w.raw, 'SELECT warranty_end_at FROM order_item_units WHERE id = ?', first.id)!.warranty_end_at, first.warranty_end_at);
});

test('a resold serial sold as Smart Choice has twelve months from the NEW delivery — when the carried window was longer', async () => {
  const { first, unit, delivered } = await resell(snapshot(12, 'smart'), (d) => addMonths(d, 30));
  assert.equal(unit.warranty_start_at, delivered);
  assert.equal(unit.warranty_end_at, addMonths(delivered, 12));
  assert.ok(Date.parse(String(unit.warranty_end_at)) < Date.parse(String(first.warranty_end_at)), 'shorter than what would have been carried');
  assert.deepEqual([unit.warranty_base_months, Number(unit.warranty_ext_months)], [12, 0]);
  assert.equal(JSON.parse(String(unit.policy_version)).carried, undefined);
});

test('…and when the carried window was shorter (two months left): still twelve months from the new delivery', async () => {
  const { w, first, unit, delivered } = await resell(snapshot(12, 'smart'), (d) => addMonths(d, 2));
  assert.equal(unit.warranty_start_at, delivered);
  assert.equal(unit.warranty_end_at, addMonths(delivered, 12));
  assert.ok(Date.parse(String(unit.warranty_end_at)) > Date.parse(String(first.warranty_end_at)));
  const pv = JSON.parse(String(unit.policy_version));
  assert.deepEqual([pv.total, pv.carried, pv.warranty_choice], [12, undefined, 'w12']);
  // A receipt for it prints this sale's window.
  const receipt = await json(await post(w.as('boss'), '/api/admin/warranties', { unit_id: unit.id }));
  assert.notEqual(receipt.code, 'NO_WARRANTY_BOUGHT', JSON.stringify(receipt));
});

test('a line sold WITHOUT the services carries exactly as before: the original start, end, months and identity', async () => {
  const { first, scanned, unit } = await resell(null, (d) => addMonths(d, 20));
  assert.equal(scanned.slot.assignment.warranty.mode, 'carry');
  assert.equal(scanned.slot.assignment.warranty.carries_until, first.warranty_end_at);
  assert.equal(unit.warranty_start_at, first.warranty_start_at);
  assert.equal(unit.warranty_end_at, first.warranty_end_at);
  assert.equal(unit.warranty_base_months, first.warranty_base_months);
  const pv = JSON.parse(String(unit.policy_version));
  assert.deepEqual([pv.carried, pv.resale_of, pv.origin_unit_id], ['original_end', first.id, first.id]);
});
