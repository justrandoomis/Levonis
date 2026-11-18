/**
 * PRINTER SERVICES PHASE 3 — THE MONEY BREAKDOWN (DECISIONS row 347; plan §F.2).
 *
 * A serviced printer line's net goods N split into the printer and its services: services_gross =
 * qty × the frozen per-unit fee; services_net = line_total > 0 ? min(gross, floor(N × gross / line_total)) : 0;
 * printer_net = N − services_net; each service by allocateExact over its frozen fee. Kits and the
 * membership line are their own figures; the courier fee is carried. The parts add up to the
 * existing net exactly, in integer dinars, and garbage never becomes NaN.
 *
 * Run: node --import tsx --test tests/printerFinanceBreakdown.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRINTER_SERVICE_KEYS, printerBreakdown, splitServicedLine } from '../worker/lib/printerFinance';

const snap = (fees: Record<string, number>) => JSON.stringify({
  lines: Object.entries(fees).map(([service, fee_iqd]) => ({ service, choice: 'x', fee_iqd })),
  fee_iqd: Object.values(fees).reduce((a, b) => a + b, 0),
});
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

test('a full-price line: the services keep exactly their fee, the printer the rest', () => {
  // 2 printers at 900,000 + 44,000 of services each.
  const s = splitServicedLine({ qty: 2, line_total_iqd: 1_888_000, net_goods_iqd: 1_888_000, services_snapshot: snap({ warranty: 25_000, care: 19_000 }) });
  assert.deepEqual([s.gross, s.services_net, s.printer_net], [88_000, 88_000, 1_800_000]);
  assert.deepEqual([s.services.warranty, s.services.care], [50_000, 38_000]);
  assert.equal(s.printer_net + s.services_net, 1_888_000);
});

test('a discounted line: the services take their share of the NET, pro rata, floored; every dinar is placed', () => {
  // A 10% coupon: N = 849,600 of 944,000.
  const s = splitServicedLine({ qty: 1, line_total_iqd: 944_000, net_goods_iqd: 849_600, services_snapshot: snap({ warranty: 25_000, care: 19_000, packaging: 7_000 }) });
  assert.equal(s.services_net, Math.floor((849_600 * 51_000) / 944_000));
  assert.equal(sum(s.services), s.services_net);
  assert.equal(s.printer_net + s.services_net, 849_600);
  for (const v of Object.values(s.services)) assert.ok(Number.isInteger(v));
});

test('edge lines: no line total, a zero or negative net, garbage — zeros, never NaN; huge figures stay exact', () => {
  const zero = splitServicedLine({ qty: 1, line_total_iqd: 0, net_goods_iqd: 0, services_snapshot: snap({ care: 19_000 }) });
  assert.deepEqual([zero.services_net, zero.printer_net], [0, 0]);
  const neg = splitServicedLine({ qty: 1, line_total_iqd: 100, net_goods_iqd: -50, services_snapshot: snap({ care: 19 }) });
  assert.deepEqual([neg.services_net, neg.printer_net], [0, -50]);
  const junk = splitServicedLine({ qty: 'x', line_total_iqd: null, net_goods_iqd: undefined, services_snapshot: '{not json' });
  for (const v of [junk.gross, junk.services_net, junk.printer_net, ...Object.values(junk.services)]) assert.ok(Number.isFinite(v), String(v));
  assert.equal(junk.serviced, false);
  // floor(N × gross / total) past 2^53.
  const big = splitServicedLine({ qty: 1000, line_total_iqd: 900_000_000_000, net_goods_iqd: 899_999_999_999, services_snapshot: snap({ warranty: 250_000_000 }) });
  assert.equal(big.services_net, Number((899_999_999_999n * 250_000_000_000n) / 900_000_000_000n));
  assert.equal(big.printer_net + big.services_net, 899_999_999_999);
});

test('the period: serviced printers, kits, the membership and the courier — parts add up to the net they came from', () => {
  const bases = [
    {
      totals: { courier_fee_iqd: 5_000 },
      lines: [
        { qty: 1, line_total_iqd: 944_000, net_goods_iqd: 900_000, services_snapshot: snap({ warranty: 25_000, care: 19_000 }) },
        { qty: 2, line_total_iqd: 50_000, net_goods_iqd: 50_000, kit_id: 'a1-starter', services_snapshot: null },
        { qty: 1, line_total_iqd: 30_000, net_goods_iqd: 30_000, line_kind: 'membership', services_snapshot: null },
        { qty: 1, line_total_iqd: 10_000, net_goods_iqd: 10_000, services_snapshot: null },
      ],
    },
    { totals: { courier_fee_iqd: 'oops' }, lines: [{ qty: 1, line_total_iqd: 944_000, net_goods_iqd: 944_000, services_snapshot: snap({ inspection: 5_000, academy: 39_000 }) }] },
  ];
  const b = printerBreakdown(bases as never);
  assert.equal(b.printer_lines, 2);
  assert.equal(b.printer_net_iqd + b.services_net_iqd, 900_000 + 944_000);
  assert.equal(sum(b.services), b.services_net_iqd);
  assert.equal(b.services_gross_iqd, 44_000 + 44_000);
  assert.deepEqual([b.kits_net_iqd, b.membership_iqd, b.courier_fee_iqd], [50_000, 30_000, 5_000]);
  for (const k of PRINTER_SERVICE_KEYS) assert.ok(Number.isInteger(b.services[k]), k);
  assert.ok(!JSON.stringify(b).includes('null') && !Number.isNaN(b.printer_net_iqd));
});

test('phase 4 (DECISIONS row 355): add-on lines are their own net; the discounts given are summed, never taken off again; absent columns read 0', () => {
  const lines = [
    { qty: 1, line_total_iqd: 944_000, net_goods_iqd: 944_000, services_snapshot: snap({ warranty: 25_000 }) },
    // A kit line at 22,500 a unit after a 2,500 discount (×2) and an add-on at 10,000 after 5,000 off.
    { qty: 2, line_total_iqd: 45_000, net_goods_iqd: 45_000, kit_id: 'a1-starter', printer_discount_iqd: 5_000, services_snapshot: null },
    { qty: 1, line_total_iqd: 10_000, net_goods_iqd: 9_000, addon_id: 'nozzle-04', printer_discount_iqd: 5_000, services_snapshot: null },
    { qty: 1, line_total_iqd: 3_000, net_goods_iqd: 3_000, addon_id: 'plate', printer_discount_iqd: 'junk', services_snapshot: null },
  ];
  const b = printerBreakdown([{ totals: { courier_fee_iqd: 0 }, lines }] as never);
  assert.deepEqual([b.kits_net_iqd, b.addons_net_iqd, b.printer_discounts_iqd], [45_000, 12_000, 10_000]);
  // The parts still add up to the net they came from: the discount is inside the prices, not a further part.
  assert.equal(b.printer_net_iqd + b.services_net_iqd + b.kits_net_iqd + b.addons_net_iqd, 944_000 + 45_000 + 12_000);
  // A database before 0242: no addon_id / printer_discount_iqd on any line — zeros, the phase 3 figures unchanged.
  const old = printerBreakdown([{ totals: { courier_fee_iqd: 0 }, lines: [lines[0], { qty: 1, line_total_iqd: 50_000, net_goods_iqd: 50_000, kit_id: 'k', services_snapshot: null }] }] as never);
  assert.deepEqual([old.addons_net_iqd, old.printer_discounts_iqd, old.kits_net_iqd], [0, 0, 50_000]);
  assert.ok(!JSON.stringify(b).includes('null'));
});

test('phase 4: the printer discounts given are net of returns, like the lines they sit on (floor of discount × kept / qty)', () => {
  const lines = [
    // 3 kit spools, 1,000 off in all; one returned → floor(1,000 × 2 / 3) = 666.
    { qty: 3, returned_qty: 1, line_total_iqd: 66_000, net_goods_iqd: 44_000, kit_id: 'k', printer_discount_iqd: 1_000, services_snapshot: null },
    // An add-on returned whole → nothing given.
    { qty: 2, returned_qty: 2, line_total_iqd: 16_000, net_goods_iqd: 0, addon_id: 'nozzle', printer_discount_iqd: 4_000, services_snapshot: null },
    // No returns (or junk) → the whole discount; returns above qty are clamped.
    { qty: 1, returned_qty: 'junk', line_total_iqd: 8_000, net_goods_iqd: 8_000, addon_id: 'plate', printer_discount_iqd: 2_000, services_snapshot: null },
    { qty: 1, returned_qty: 5, line_total_iqd: 8_000, net_goods_iqd: 0, addon_id: 'brush', printer_discount_iqd: 2_000, services_snapshot: null },
  ];
  const b = printerBreakdown([{ totals: { courier_fee_iqd: 0 }, lines }] as never);
  assert.equal(b.printer_discounts_iqd, 666 + 0 + 2_000 + 0);
  assert.ok(Number.isInteger(b.printer_discounts_iqd));
});
