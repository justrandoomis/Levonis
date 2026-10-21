/**
 * ELIGIBILITY OF A JOB OF PARTS (P1-05, docs/DECISIONS.md row 267, D4) — the
 * per-part path of worker/lib/eligibility.ts, pure.
 *
 * Pinned: four parts in one different colour each never ask for a multicolour
 * machine; a workshop that can make some parts is eligible for the job and
 * not for every part (`covers_all`); one that can make none is refused with
 * the parts' reasons together; a part in two materials needs ONE machine that
 * runs both with two colours at once; stock is asked per material and colour;
 * a part preference narrows a part and a request preference narrows the
 * request; and without `parts` the verdict is exactly today's (randomised).
 *
 * Run: node --import tsx --test tests/eligibilityParts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_PREFS,
  evaluateEligibility,
  evaluatePart,
  printerCannotPart,
  type CapabilityPrinter,
  type CatalogueMaterial,
  type EligibilityCandidate,
  type EligibilityPart,
  type EligibilityRequest,
  type MerchantPrefs,
} from '../worker/lib/eligibility';
import { DEFAULT_DELIVERY_PROFILE } from '@levonis/shipping/merchantDelivery';
import { DEFAULT_MATERIALS } from '../worker/lib/printPricing';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const CAT = new Map<string, CatalogueMaterial>(DEFAULT_MATERIALS.map((m) => [m.id, m]));

const printer = (o: Partial<CapabilityPrinter> = {}): CapabilityPrinter => ({
  id: 'p1', technology: 'fdm', build_x_mm: 256, build_y_mm: 256, build_z_mm: 256, nozzle_mm: 0.4,
  materials: [], enclosed: false, hardened_nozzle: false, max_colors: 1, quality_max: 'fine',
  machine_hour_iqd: null, availability: 'available', active: true, canonical: true, ...o,
});
const prefs = (o: Partial<MerchantPrefs> = {}): MerchantPrefs => ({ ...EMPTY_PREFS, ...o });
const shop = (o: Partial<EligibilityCandidate> = {}): EligibilityCandidate => ({
  merchant_id: 'm1', user_id: 'u1', merchant_status: 'active', approved: true, store_status: 'active', store_id: 's1',
  accepts_custom_requests: true, plan_ok: true, printers: [printer()], stock: 'untracked',
  reach: { profile: { ...DEFAULT_DELIVERY_PROFILE, version: 1 }, rules: [] }, prefs: prefs(),
  request_opportunities: true, ...o,
});
const part = (id: string, o: Partial<EligibilityPart> = {}): EligibilityPart => ({
  id, process: 'fdm', materials: [{ material_id: 'pla', colours: [] }], colors_count: 1, dims_mm: { x: 50, y: 50, z: 20 }, grams: null, ...o,
});
const job = (parts: EligibilityPart[] | undefined, o: Partial<EligibilityRequest> = {}): EligibilityRequest => ({
  id: 'r1', customer_id: 'c1', revision: 1, on_board: true, process: 'fdm', material_id: null,
  color_hex: '', quality: 'standard', colors_count: 1, dims_mm: { x: 50, y: 50, z: 20 },
  grams: null, governorate: 'baghdad', delivery_pref: '', estimate_iqd: null, quantity: 1, parts, ...o,
});
const verdict = (m: EligibilityCandidate, r: EligibilityRequest) => evaluateEligibility(m, r, CAT, NOW);

test('four parts in one different colour each: eligible on a single-colour printer, never MULTICOLOR', () => {
  const colours = ['#d32f2f', '#1976d2', '#388e3c', '#fbc02d'];
  const parts = colours.map((hex, i) => part(`pt${i}`, { materials: [{ material_id: 'pla', colours: [hex] }] }));
  const v = verdict(shop(), job(parts, { colors_count: 1 }));
  assert.equal(v.eligible, true, JSON.stringify(v));
  assert.equal(v.covers_all, true);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.printer_id, 'p1');
  assert.ok(!JSON.stringify(v).includes('MULTICOLOR'));
  assert.deepEqual(v.parts!.map((p) => p.eligible), [true, true, true, true]);
});

test('a TPU part on a workshop without TPU: the job is eligible, not every part — that part answers MATERIAL', () => {
  const m = shop({ printers: [printer({ materials: ['pla', 'petg'] })] });
  const v = verdict(m, job([part('a'), part('b', { materials: [{ material_id: 'tpu', colours: [] }] })]));
  assert.equal(v.eligible, true);
  assert.equal(v.covers_all, false);
  assert.deepEqual(v.reasons, [], 'a job some part of which the shop can make carries no refusal');
  assert.deepEqual(v.parts!.find((p) => p.part_id === 'b')!.reasons, ['MATERIAL']);
  assert.equal(v.parts!.find((p) => p.part_id === 'a')!.eligible, true);
  assert.equal(v.dims.capability, 'pass');
});

test('no part makeable: ineligible, with every part reason together in policy order', () => {
  const m = shop({ printers: [printer({ materials: ['petg'], build_x_mm: 100, build_y_mm: 100, build_z_mm: 100 })] });
  const v = verdict(m, job([part('a'), part('b', { dims_mm: { x: 300, y: 50, z: 20 }, materials: [{ material_id: 'petg', colours: [] }] })]));
  assert.equal(v.eligible, false);
  assert.equal(v.covers_all, false);
  assert.deepEqual(v.reasons, ['BUILD_VOLUME', 'MATERIAL'], 'policy order: BUILD_VOLUME before MATERIAL');
  assert.equal(v.reason, 'BUILD_VOLUME');
  assert.equal(v.dims.capability, 'fail');
  assert.equal(v.printer_id, '');
  assert.equal(v.notify, false);
});

test('a part in two materials needs ONE machine running both, with two colours at once', () => {
  const multi = part('mm', { materials: [{ material_id: 'pla', colours: [] }, { material_id: 'tpu', colours: [] }], colors_count: 2 });
  // Two single machines, one for each material: neither makes the part.
  const two = shop({ printers: [printer({ id: 'pla', materials: ['pla'] }), printer({ id: 'tpu', materials: ['tpu'] })] });
  const a = verdict(two, job([multi]));
  assert.equal(a.eligible, false);
  assert.ok(a.reasons.includes('MATERIAL') || a.reasons.includes('MULTICOLOR'), JSON.stringify(a.reasons));
  // One machine that runs every material but lays down one at a time.
  assert.equal(printerCannotPart(printer(), multi, job([multi]), CAT), 'MULTICOLOR');
  // One machine, both materials, two at once.
  const ams = shop({ printers: [printer({ id: 'ams', max_colors: 4 })] });
  const b = verdict(ams, job([multi]));
  assert.equal(b.eligible, true);
  assert.equal(b.printer_id, 'ams');
});

test('stock is asked per material and per colour; a multicolour part needs the colours present and the grams in total', () => {
  const red = '#d32f2f';
  const blue = '#1976d2';
  const twoColour = part('tc', { materials: [{ material_id: 'pla', colours: [red, blue] }], colors_count: 2, grams: 100 });
  const m = (stock: EligibilityCandidate['stock']) => shop({ printers: [printer({ max_colors: 4 })], stock });
  const eval1 = (stock: EligibilityCandidate['stock'], p: EligibilityPart) => evaluatePart(m(stock), job([p]), p, CAT);
  // Both colours present, 60 g each: no one spool holds 100 g, together they do.
  assert.equal(eval1([{ material_id: 'pla', color_hex: red, grams: 60 }, { material_id: 'pla', color_hex: blue, grams: 60 }], twoColour).stock, '');
  // A colour missing.
  assert.equal(eval1([{ material_id: 'pla', color_hex: red, grams: 600 }], twoColour).stock, 'STOCK_COLOR');
  // Not enough in total.
  assert.equal(eval1([{ material_id: 'pla', color_hex: red, grams: 30 }, { material_id: 'pla', color_hex: blue, grams: 30 }], twoColour).stock, 'STOCK_GRAMS');
  // The material absent.
  assert.equal(eval1([{ material_id: 'petg', color_hex: '', grams: 900 }], twoColour).stock, 'STOCK_MATERIAL');
  // Each part asks its own material: the PLA part passes, the PETG part does not.
  const v = verdict(m([{ material_id: 'pla', color_hex: '', grams: 900 }]), job([part('a'), part('b', { materials: [{ material_id: 'petg', colours: [] }] })]));
  assert.equal(v.eligible, true);
  assert.deepEqual(v.parts!.map((p) => [p.part_id, p.reasons]), [['a', []], ['b', ['STOCK_MATERIAL']]]);
});

test('preferences only narrow: a part preference fails that part, a request preference fails the request', () => {
  const parts = [part('a'), part('b', { materials: [{ material_id: 'petg', colours: [] }] })];
  // PLA only: part b fails PREF_MATERIAL, the job stays eligible on part a.
  const plaOnly = verdict(shop({ prefs: prefs({ materials: ['pla'] }) }), job(parts));
  assert.equal(plaOnly.eligible, true);
  assert.deepEqual(plaOnly.parts!.find((p) => p.part_id === 'b')!.reasons, ['PREF_MATERIAL']);
  assert.equal(plaOnly.covers_all, false);
  // Basra only: the request fails, whatever the parts.
  const basra = verdict(shop({ prefs: prefs({ governorates: ['basra'] }) }), job(parts));
  assert.equal(basra.eligible, false);
  assert.deepEqual(basra.reasons, ['PREF_GOVERNORATE']);
  assert.equal(basra.dims.preference, 'fail');
  // A job-value band reads the request's estimate (null when it is not the whole job's).
  const band = verdict(shop({ prefs: prefs({ min_job_iqd: 100_000 }) }), job(parts, { estimate_iqd: 20_000 }));
  assert.deepEqual(band.reasons, ['PREF_JOB_TOO_SMALL']);
  assert.equal(verdict(shop({ prefs: prefs({ min_job_iqd: 100_000 }) }), job(parts, { estimate_iqd: null })).eligible, true);
  // A trade reason is still the request's.
  assert.deepEqual(verdict(shop({ plan_ok: false }), job(parts)).reasons, ['PLAN_LAPSED']);
});

test('without parts the single-job path runs: an empty list is no list, and no part key is added (randomised; tests/eligibility.test.ts pins the path itself)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  for (let i = 0; i < 300; i++) {
    const m = shop({
      printers: [printer({ max_colors: pick([1, 4]), materials: pick([[], ['pla'], ['petg', 'tpu']]), quality_max: pick(['standard', 'ultra'] as const) })],
      stock: pick(['untracked', [{ material_id: 'pla', color_hex: '', grams: pick([0, 50, 5000]) }]] as const) as EligibilityCandidate['stock'],
      prefs: prefs({
        materials: pick([[], ['pla'], ['petg']]),
        colors: pick([[], ['#000000']]),
        capabilities: pick([[], ['multicolor'], ['high_detail']]),
        min_job_iqd: pick([0, 30_000]),
        governorates: pick([[], ['baghdad'], ['basra']]),
      }),
    });
    const r = job(undefined, {
      material_id: pick([null, 'pla', 'petg', 'tpu']),
      color_hex: pick(['', '#000000']),
      colors_count: pick([1, 2, 3]),
      quality: pick(['standard', 'fine', 'ultra'] as const),
      estimate_iqd: pick([null, 20_000, 90_000]),
      grams: pick([null, 40, 400]),
    });
    const without = verdict(m, r);
    const empty = verdict(m, { ...r, parts: [] });
    assert.deepEqual(empty, without, 'an empty parts list is the single-job path');
    assert.equal('covers_all' in without, false);
    assert.equal('parts' in without, false);
  }
});
