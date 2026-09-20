/**
 * PRINT PRICING, pinned on the properties that decide whether a quote is safe.
 *
 * A pricing test cannot assert "this job costs 18,250 IQD" — that number is the
 * owner's to set and will move the first time filament does. What it CAN assert
 * is that the model behaves like the physical thing it describes:
 *
 *   - doubling the filament price moves the material line and nothing else;
 *   - a hollow part costs less than a solid one of the same size;
 *   - a tall thin resin tower costs about what a tall fat one does, because
 *     MSLA cures a whole layer at once, while on FDM it does not;
 *   - the floor cannot be crossed, whatever the inputs;
 *   - an unmeasurable file is quoted with LOW confidence or not at all.
 *
 * Those are the invariants a merchant loses money by breaking.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseModel, type ModelAnalysis } from '../worker/lib/modelGeometry';
import {
  quotePrint,
  materialsFor,
  DEFAULT_MATERIALS,
  DEFAULT_PRICING,
  type PrintMaterial,
  type PrintPricingConfig,
  type QuoteInput,
} from '../worker/lib/printPricing';

// ---------------------------------------------------------------- fixtures

function boxTriangles(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): number[][] {
  const v = (i: number, j: number, k: number) => [ox + i * sx, oy + j * sy, oz + k * sz];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  return [
    [p000, p110, p100].flat(), [p000, p010, p110].flat(),
    [p001, p101, p111].flat(), [p001, p111, p011].flat(),
    [p000, p100, p101].flat(), [p000, p101, p001].flat(),
    [p010, p011, p111].flat(), [p010, p111, p110].flat(),
    [p000, p001, p011].flat(), [p000, p011, p010].flat(),
    [p100, p110, p111].flat(), [p100, p111, p101].flat(),
  ];
}

function binaryStl(triangles: number[][]): Uint8Array {
  const out = new Uint8Array(84 + triangles.length * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, triangles.length, true);
  let at = 84;
  for (const t of triangles) {
    at += 12;
    for (let i = 0; i < 9; i++) { dv.setFloat32(at, t[i], true); at += 4; }
    at += 2;
  }
  return out;
}

const cube = (mm: number): ModelAnalysis => analyseModel(binaryStl(boxTriangles(mm, mm, mm)), 'c.stl');

const base = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  analysis: cube(50),
  materialId: 'pla',
  quality: 'standard',
  infill: 0.2,
  quantity: 1,
  colors: 1,
  supports: true,
  post_processing_minutes: 0,
  ...over,
});

const line = (q: ReturnType<typeof quotePrint>, key: string) =>
  q.cost_lines.find((l) => l.key === key)?.iqd ?? 0;

const M = DEFAULT_MATERIALS;
const C = DEFAULT_PRICING;

// ------------------------------------------------------- 1. it prices at all

test('a measured cube in a known material is priced with high confidence', () => {
  const q = quotePrint(base(), M, C);
  assert.equal(q.priced, true);
  assert.ok(q.price_iqd > 0, 'a price exists');
  assert.ok(q.material_grams > 0, 'grams are real');
  assert.ok(q.print_time_minutes > 0, 'time is real');
  assert.equal(q.confidence, 'high', q.confidence_reasons.join(','));
});

test('the itemised breakdown adds up to exactly the quoted cost', () => {
  const q = quotePrint(base(), M, C);
  const sum = q.cost_lines.reduce((n, l) => n + l.iqd, 0);
  assert.equal(sum, q.cost_iqd, 'a breakdown that does not add up looks like a mistake');
  assert.ok(q.cost_lines.length >= 6, 'the real drivers are all named');
  for (const key of ['material', 'machine', 'setup', 'labor', 'failure_risk']) {
    assert.ok(q.cost_lines.some((l) => l.key === key), `${key} is charged`);
  }
});

test('the price is a range around the point estimate, never a bare number', () => {
  const q = quotePrint(base(), M, C);
  assert.ok(q.price_low_iqd < q.price_iqd, 'a low end');
  assert.ok(q.price_high_iqd > q.price_iqd, 'a high end');
  assert.ok(q.price_low_iqd >= q.floor_iqd, 'even the low end clears the floor');
});

// ------------------------------------------ 2. it is not grams x fixed number

test('a hollow part costs less than the same shape printed solid', () => {
  const hollow = quotePrint(base({ infill: 0.1 }), M, C);
  const solid = quotePrint(base({ infill: 1 }), M, C);
  assert.ok(solid.material_grams > hollow.material_grams * 2, 'far more plastic');
  assert.ok(solid.price_iqd > hollow.price_iqd, 'and a higher price');
  // The difference is NOT purely material: the machine has to push it all.
  assert.ok(line(solid, 'machine') > line(hollow, 'machine'), 'more machine time too');
});

test('time is charged, so a slow fine print costs more than a fast draft one', () => {
  const draft = quotePrint(base({ quality: 'draft' }), M, C);
  const ultra = quotePrint(base({ quality: 'ultra' }), M, C);
  assert.ok(ultra.print_time_minutes > draft.print_time_minutes * 2, 'thinner layers take far longer');
  assert.ok(ultra.price_iqd > draft.price_iqd);
  // Same plastic, different clock — which is the whole point of not pricing on
  // grams alone.
  assert.ok(Math.abs(ultra.material_grams - draft.material_grams) < 0.5, 'the same grams');
});

test('a convoluted model costs more than a plain one of identical volume', () => {
  const plain = cube(50);
  const gnarly: ModelAnalysis = { ...plain, complexity: 0.9, surface_area_mm2: plain.surface_area_mm2 };
  const a = quotePrint(base({ analysis: plain }), M, C);
  const b = quotePrint(base({ analysis: gnarly }), M, C);
  assert.ok(b.price_iqd > a.price_iqd, 'complexity is paid for');
  assert.ok(b.print_time_minutes > a.print_time_minutes, 'and it is paid for in time');
});

test('overhangs cost support material AND the hands that remove it', () => {
  const withSupports = quotePrint(base({ supports: true }), M, C);
  const without = quotePrint(base({ supports: false }), M, C);
  assert.ok(line(withSupports, 'support_material') > 0);
  assert.ok(line(withSupports, 'support_removal') > 0);
  assert.equal(line(without, 'support_material'), 0, 'supports off means no support cost');
  assert.equal(line(without, 'support_removal'), 0);
  assert.ok(withSupports.price_iqd > without.price_iqd);
});

test('a second colour costs a purge and a slower print, not just a click', () => {
  const one = quotePrint(base(), M, C);
  const three = quotePrint(base({ colors: 3 }), M, C);
  assert.ok(line(three, 'purge') > 0, 'filament is thrown away at every change');
  assert.ok(three.print_time_minutes > one.print_time_minutes, 'tool changes cost time');
  assert.ok(three.confidence_reasons.includes('MULTICOLOR'));
});

test('the failure provision grows with the length of the run', () => {
  const short = quotePrint(base({ analysis: cube(20) }), M, C);
  const long = quotePrint(base({ analysis: cube(120), infill: 0.6 }), M, C);
  const shortShare = line(short, 'failure_risk') / short.cost_iqd;
  const longShare = line(long, 'failure_risk') / long.cost_iqd;
  assert.ok(longShare > shortShare, `${longShare} should exceed ${shortShare}`);
});

test('a difficult material is provisioned for more failure than an easy one', () => {
  const pla = quotePrint(base({ materialId: 'pla' }), M, C);
  const pc = quotePrint(base({ materialId: 'pc' }), M, C);
  assert.ok(
    line(pc, 'failure_risk') / pc.cost_iqd > line(pla, 'failure_risk') / pla.cost_iqd,
    'PC warps; PLA does not'
  );
});

// ------------------------------------------------- 3. FDM and resin differ

test('on FDM the volume drives the clock; on resin the height does', () => {
  // Same height, very different volume.
  const thin = analyseModel(binaryStl(boxTriangles(10, 10, 100)), 'thin.stl');
  const fat = analyseModel(binaryStl(boxTriangles(60, 60, 100)), 'fat.stl');

  const fdmThin = quotePrint(base({ analysis: thin, materialId: 'pla' }), M, C);
  const fdmFat = quotePrint(base({ analysis: fat, materialId: 'pla' }), M, C);
  assert.ok(fdmFat.print_time_minutes > fdmThin.print_time_minutes * 2, 'FDM pushes every mm3');

  const resinThin = quotePrint(base({ analysis: thin, materialId: 'resin-standard' }), M, C);
  const resinFat = quotePrint(base({ analysis: fat, materialId: 'resin-standard' }), M, C);
  const ratio = resinFat.print_time_minutes / resinThin.print_time_minutes;
  assert.ok(ratio < 1.5, `MSLA cures a whole layer at once; ratio was ${ratio}`);
  // The material still costs more, because the vat really is emptier.
  assert.ok(resinFat.material_grams > resinThin.material_grams * 3);
});

test('a resin plate batches; an FDM queue does not', () => {
  const fdm1 = quotePrint(base({ materialId: 'pla', quantity: 1 }), M, C);
  const fdm8 = quotePrint(base({ materialId: 'pla', quantity: 8 }), M, C);
  const res1 = quotePrint(base({ materialId: 'resin-standard', quantity: 1 }), M, C);
  const res8 = quotePrint(base({ materialId: 'resin-standard', quantity: 8 }), M, C);
  const fdmGrowth = fdm8.total_time_minutes / fdm1.total_time_minutes;
  const resinGrowth = res8.total_time_minutes / res1.total_time_minutes;
  assert.ok(resinGrowth < fdmGrowth, `resin ${resinGrowth} should grow slower than FDM ${fdmGrowth}`);
});

// -------------------------------------------------------- 4. admin controls

test('doubling the filament price moves the material line and the price', () => {
  const dearer: PrintMaterial[] = M.map((m) =>
    m.id === 'pla' ? { ...m, price_iqd_per_kg: m.price_iqd_per_kg * 2 } : m
  );
  const before = quotePrint(base(), M, C);
  const after = quotePrint(base(), dearer, C);
  assert.ok(line(after, 'material') > line(before, 'material') * 1.9, 'the material line follows');
  assert.ok(after.price_iqd > before.price_iqd, 'and so does the price');
  // The machine has not got slower just because filament got dearer.
  assert.equal(line(after, 'machine'), line(before, 'machine'));
});

test('raising the labour rate moves labour and setup, not material', () => {
  const cfg: PrintPricingConfig = { ...C, labor_iqd_per_hour: C.labor_iqd_per_hour * 3 };
  const before = quotePrint(base(), M, C);
  const after = quotePrint(base(), M, cfg);
  assert.ok(line(after, 'setup') > line(before, 'setup') * 2.9);
  assert.equal(line(after, 'material'), line(before, 'material'));
});

test('the whole model is settings — nothing is hardcoded into the answer', () => {
  const cheap: PrintPricingConfig = {
    ...C,
    machine_hour_iqd: { fdm: 0, resin: 0 },
    labor_iqd_per_hour: 0,
    energy_iqd_per_kwh: 0,
    failure_risk_base_percent: 0,
    failure_risk_per_hour_percent: 0,
    complexity_uplift_percent: 0,
    min_job_iqd: 0,
    target_margin_percent: 0,
    min_margin_percent: 0,
  };
  const q = quotePrint(base(), M, cheap);
  // With every rate zeroed only the material and its waste survive.
  const keys = q.cost_lines.map((l) => l.key).sort();
  assert.deepEqual(keys, ['material', 'support_material', 'waste'].sort(), keys.join(','));
  // And with all three floors at zero the floor collapses to the cost itself —
  // a zero minimum margin on a real cost is that cost. This line used to read
  // the material's own economic minimum; the owner has since ruled that no
  // print job has a minimum («لا يوجد حد أدنى لأي طلب طباعة») and every seeded
  // material's floor is 0, so reading it here would assert 0 and prove nothing.
  const step = cheap.round_to_iqd;
  assert.equal(q.floor_iqd, Math.round(q.cost_iqd / step) * step);
});

// ------------------------------------------------------------- 5. the floor

test('the estimate never falls below cost plus the minimum margin', () => {
  // A tiny part, where the setup dwarfs everything and a naive gram price would
  // quote a few hundred dinars for an hour of somebody's day.
  const q = quotePrint(base({ analysis: cube(4), infill: 0.05 }), M, C);
  assert.ok(q.price_iqd >= q.floor_iqd, 'the point estimate clears the floor');
  assert.ok(q.price_low_iqd >= q.floor_iqd, 'and so does the bottom of the range');
  // NOT `>= C.min_job_iqd`: that floor is 0 by the owner's decision, so the
  // assertion would hold for any number at all. The platform floor is pinned
  // where it can still fail — tests/printJobMinimum.test.ts.
  assert.ok(q.price_iqd >= q.cost_iqd, 'and never under what the job costs');
  assert.ok(q.margin_percent >= C.min_margin_percent - 0.01, `margin was ${q.margin_percent}%`);
});

test('a big quantity discount still cannot push the price under the floor', () => {
  const greedy: PrintPricingConfig = {
    ...C,
    quantity_discount_percent: 40,
    quantity_discount_cap_percent: 95,
    target_margin_percent: 5,
  };
  const q = quotePrint(base({ quantity: 64 }), M, greedy);
  assert.ok(q.price_iqd >= q.floor_iqd, `${q.price_iqd} must clear ${q.floor_iqd}`);
  assert.ok(q.margin_percent >= greedy.min_margin_percent - 0.01);
});

test('no seeded material imposes a minimum, and one the admin sets still binds', () => {
  /**
   * THIS TEST WAS INVERTED BY A DECISION, NOT BY A BUG. It used to read "the
   * material minimum protects a job too small to be worth setting up" and
   * assert that a 3 mm castable-resin part was lifted to 12,000 د.ع. The owner
   * ruled «لا يوجد حد أدنى لأي طلب طباعة», so the seeds are all 0 — and the old
   * assertions (`>= 0`) would still have PASSED while testing nothing at all.
   * A green test that cannot fail is worse than a deleted one.
   *
   * What is worth pinning now is both halves of the ruling: the seed charges
   * nothing extra, and the FIELD still works, because the owner can put a floor
   * back on one material from the admin without a deploy.
   */
  const tiny = base({ analysis: cube(3), materialId: 'resin-castable' });
  const seeded = quotePrint(tiny, M, C);
  assert.ok(seeded.price_iqd > 0, 'a real job still costs something');
  assert.ok(seeded.price_iqd < 12_000, `${seeded.price_iqd} — a flat material floor is still applied`);

  const withFloor = M.map((m) => (m.id === 'resin-castable' ? { ...m, min_economic_iqd: 12_000 } : m));
  const enforced = quotePrint(tiny, withFloor, C);
  assert.ok(enforced.floor_iqd >= 12_000, `${enforced.floor_iqd} ignored the configured material floor`);
  assert.ok(enforced.price_iqd >= 12_000, `${enforced.price_iqd} ignored the configured material floor`);
});

test('quantity buys a real saving per part, but a bounded one', () => {
  const one = quotePrint(base({ quantity: 1 }), M, C);
  const ten = quotePrint(base({ quantity: 10 }), M, C);
  assert.ok(ten.unit_price_iqd < one.unit_price_iqd, 'setup is shared');
  assert.ok(ten.price_iqd > one.price_iqd * 5, 'but ten parts still cost far more than one');
});

// -------------------------------------------------- 6. honest about not knowing

test('a link with no geometry and no volume is refused rather than guessed', () => {
  const q = quotePrint(base({ analysis: null }), M, C);
  assert.equal(q.priced, false);
  assert.equal(q.reason, 'NO_GEOMETRY');
  assert.equal(q.price_iqd, 0, 'no invented number');
});

test('a customer-supplied volume prices, but only with low confidence', () => {
  const q = quotePrint(base({ analysis: null, fallback_volume_cm3: 30 }), M, C);
  assert.equal(q.priced, true);
  assert.equal(q.confidence, 'low');
  assert.ok(q.confidence_reasons.includes('VOLUME_ESTIMATED_BY_CUSTOMER'));
});

test('a leaky mesh is priced but never with high confidence', () => {
  const tris = boxTriangles(50, 50, 50);
  tris.pop();
  const q = quotePrint(base({ analysis: analyseModel(binaryStl(tris), 'open.stl') }), M, C);
  assert.equal(q.priced, true);
  assert.equal(q.confidence, 'low');
  assert.ok(q.confidence_reasons.includes('MESH_NOT_WATERTIGHT'));
});

test('an unknown material is refused, not silently substituted', () => {
  const q = quotePrint(base({ materialId: 'unobtanium' }), M, C);
  assert.equal(q.priced, false);
  assert.equal(q.reason, 'MATERIAL_UNKNOWN');
});

test('a de-activated material is unknown to the quote', () => {
  const off = M.map((m) => (m.id === 'pla' ? { ...m, active: false } : m));
  assert.equal(quotePrint(base(), off, C).priced, false);
});

// ------------------------------------------ 7. the matching side of materials

test('what a merchant can print is decided by the same catalogue as the price', () => {
  const openFdm = materialsFor(M, { processes: ['fdm'], enclosed: false, hardened_nozzle: false });
  const ids = openFdm.map((m) => m.id);
  assert.ok(ids.includes('pla') && ids.includes('petg'), 'the easy ones');
  assert.ok(!ids.includes('abs'), 'ABS needs a chamber this printer does not have');
  assert.ok(!ids.includes('pla-cf'), 'carbon fill needs a hardened nozzle');
  assert.ok(!ids.some((id) => id.startsWith('resin-')), 'an FDM shop is not a resin shop');

  const full = materialsFor(M, { processes: ['fdm', 'resin'], enclosed: true, hardened_nozzle: true });
  assert.equal(full.length, M.length, 'a fully equipped shop can run everything');
});
