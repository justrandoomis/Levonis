/**
 * THE CUSTOMER'S PATH TO A NUMBER, and the line it must not cross.
 *
 * `geometryAdapter` is what answers «احسب سعر طباعتك» when there is no slicer —
 * which is every customer, because the slicer lives on the Studio origin and
 * the store bundle carries none of it (docs/STUDIO_PLAN.md decision 6). These
 * tests hold it to the two things that make that acceptable:
 *
 *   1. the numbers it derives are physically right for a shape we can compute
 *      by hand, and
 *   2. it never claims to have measured them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyseModel } from '../worker/lib/modelGeometry';
import {
  STANDARD_PRINTING_MODEL,
  STRENGTH_PRESETS,
  analysisFromGeometry,
  piecesPerPlate,
  printingModelFor,
} from '../worker/lib/printQuote/geometryAdapter';
import { materialTotalGrams, totalPrintMinutes } from '../worker/lib/printQuote/model';
import type { PrinterModel } from '../worker/lib/printQuote/printers';

// ------------------------------------------------------------------ fixtures

/** A binary STL of an axis-aligned box. Real bytes through the real parser —
 *  a hand-built ModelAnalysis would test the adapter against my own arithmetic
 *  instead of against the geometry engine the Worker actually runs. */
function boxStl(sx: number, sy: number, sz: number): Uint8Array {
  const v: Array<[number, number, number]> = [
    [0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0],
    [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz],
  ];
  // Outward-facing winding on all six faces.
  const tris: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], // bottom (-Z)
    [4, 5, 6], [4, 6, 7], // top (+Z)
    [0, 1, 5], [0, 5, 4], // -Y
    [1, 2, 6], [1, 6, 5], // +X
    [2, 3, 7], [2, 7, 6], // +Y
    [3, 0, 4], [3, 4, 7], // -X
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    o += 12; // normal left zero: the parser recomputes from the winding
    for (const i of [a, b, c]) {
      dv.setFloat32(o, v[i][0], true);
      dv.setFloat32(o + 4, v[i][1], true);
      dv.setFloat32(o + 8, v[i][2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

const PRINTER: PrinterModel = {
  id: 'test-a1',
  manufacturer: 'Test',
  model: 'A1',
  generation: '',
  technology: 'fdm',
  buildMm: { x: 256, y: 256, z: 256 },
  nozzleSizesMm: [0.4],
  defaultNozzleMm: 0.4,
  toolheadCount: 1,
  independentToolheads: false,
  maxSimultaneousMaterials: 4,
  multiMaterial: 'single_nozzle_changer',
  enclosed: false,
  heatedChamber: false,
  hardenedNozzleAvailable: false,
  materials: ['PLA', 'PETG'],
  power: { idleWatts: 8, bedHeatingWatts: 220, nozzleHeatingWatts: 60, printingWatts: 110 },
  purchaseIqd: 0,
  residualIqd: 0,
  usefulPrintHours: 0,
  maintenanceIqdPerHour: 0,
  baselineSuccessRate: 0.9,
  maxVolumetricFlowMm3PerS: 28,
  sustainedFlowFraction: 0.55,
  layerOverheadSeconds: 2,
  warmupMinutes: 4,
};

const PLA = { materialId: 'pla', materialType: 'PLA', colorHex: '#000000', densityGPerCm3: 1.24 };

const measure = (bytes: Uint8Array, over: Record<string, unknown> = {}) =>
  analysisFromGeometry({
    geometry: analyseModel(bytes, 'part.stl'),
    printer: PRINTER,
    fileSha256: 'sha',
    material: PLA,
    ...over,
  });

// ------------------------------------------------------------------- the maths

test('a 20 mm cube weighs what a 20 mm cube weighs', () => {
  const g = analyseModel(boxStl(20, 20, 20), 'cube.stl');
  // The geometry half is EXACT and this pins it: 8,000 mm³ and 2,400 mm².
  assert.ok(Math.abs(g.volume_mm3 - 8_000) < 1, `volume ${g.volume_mm3}`);
  assert.ok(Math.abs(g.surface_area_mm2 - 2_400) < 1, `area ${g.surface_area_mm2}`);

  const { analysis, refusal } = measure(boxStl(20, 20, 20));
  assert.equal(refusal, undefined);

  // wall = 2400 mm² × (0.42 × 2) = 2,016 mm³; interior = 5,984; at 15% infill
  // the extrusion is 2,016 + 897.6 = 2,913.6 mm³ → 3.61 g of PLA.
  const grams = materialTotalGrams(analysis.materials[0]);
  assert.ok(grams > 3.4 && grams < 3.9, `${grams} g is not what a 20 mm cube at 15% weighs`);

  // 100 layers at 0.2, and a print measured in minutes rather than seconds.
  assert.equal(analysis.layerCount, 100);
  assert.ok(analysis.printMinutesPerPlate > 5 && analysis.printMinutesPerPlate < 40);
});

test('more walls and more infill make the same part heavier, in that order', () => {
  const cube = boxStl(30, 30, 30);
  const light = measure(cube, { strengthId: 'light' });
  const standard = measure(cube, { strengthId: 'standard' });
  const strong = measure(cube, { strengthId: 'strong' });

  const g = (r: ReturnType<typeof measure>) => materialTotalGrams(r.analysis.materials[0]);
  assert.ok(g(light) < g(standard), 'lighter infill must weigh less');
  assert.ok(g(standard) < g(strong), 'four walls at 30% must weigh more than two at 15%');
  // And the presets are not secretly the same object.
  assert.notEqual(STRENGTH_PRESETS.light.infillFraction, STRENGTH_PRESETS.strong.infillFraction);
});

test('a finer layer takes longer and weighs the same', () => {
  const cube = boxStl(25, 25, 25);
  const draft = measure(cube, { qualityId: 'draft' });
  const fine = measure(cube, { qualityId: 'fine' });

  // Layer height does not change how much plastic a solid contains…
  const grams = (r: ReturnType<typeof measure>) => materialTotalGrams(r.analysis.materials[0]);
  assert.ok(Math.abs(grams(draft) - grams(fine)) < 0.01, 'layer height must not move the mass');
  // …it changes how many passes lay it down.
  assert.ok(fine.analysis.layerCount > draft.analysis.layerCount * 2);
  assert.ok(totalPrintMinutes(fine.analysis) > totalPrintMinutes(draft.analysis));
});

test('a part thinner than its own walls is solid, never more than solid', () => {
  // A 0.5 mm sheet: surface area × 0.84 mm of wall would claim far MORE plastic
  // than the sheet physically contains. The cap is the whole reason that term
  // is written `Math.min(..., volume)`.
  const sheet = boxStl(60, 60, 0.5);
  const g = analyseModel(sheet, 's.stl');
  const { analysis } = measure(sheet);
  const solidGrams = (g.volume_mm3 / 1000) * 1.24;
  assert.ok(
    materialTotalGrams(analysis.materials[0]) <= solidGrams + 0.001,
    'the estimate claims more material than the part is made of'
  );
});

test('a bigger nozzle lays a thicker wall and a heavier part', () => {
  const cube = boxStl(30, 30, 30);
  const fine = measure(cube, { nozzleMm: 0.4 });
  const fat = measure(cube, { nozzleMm: 0.8 });
  assert.ok(
    materialTotalGrams(fat.analysis.materials[0]) > materialTotalGrams(fine.analysis.materials[0]),
    'a 0.8 nozzle must not produce the same wall as a 0.4'
  );
  assert.ok(printingModelFor({
    geometry: analyseModel(cube, 'c.stl'), printer: PRINTER, fileSha256: '', material: PLA, nozzleMm: 0.8,
  }).extrusionWidthMm > STANDARD_PRINTING_MODEL.extrusionWidthMm);
});

// ------------------------------------------------------------------- refusals

test('a part that does not fit is refused, not quoted', () => {
  const huge = boxStl(400, 100, 100);
  const r = measure(huge);
  assert.equal(r.refusal?.code, 'DOES_NOT_FIT');
  // And the analysis it returns is empty, so a caller that ignores the refusal
  // prices nothing rather than pricing a job nobody can print.
  assert.deepEqual(r.analysis.materials, []);
  assert.equal(r.analysis.modelVolumeMm3, 0);
});

test('a part that fits only when turned is not refused', () => {
  // 240 × 100 does not fit 256 × 256 the way it is written if you compare axis
  // to axis carelessly — it does fit, and a bed is not oriented.
  const r = measure(boxStl(100, 240, 50));
  assert.equal(r.refusal, undefined);
});

test('a file with no volume is refused rather than costed at zero', () => {
  const flat = boxStl(50, 50, 0); // degenerate: no height, no solid
  const r = measure(flat);
  assert.ok(r.refusal, 'a zero-volume model must not produce a price');
});

// ------------------------------------------------------------------ the plate

test('pieces per plate come from a real packing, not from dividing areas', () => {
  // 100 × 100 parts on a 256 × 256 bed with a 6 mm gap: two per row, two rows.
  // Dividing areas would promise 6.
  assert.equal(piecesPerPlate({ x: 100, y: 100 }, { x: 256, y: 256 }), 4);
  // A long thin part tiles far better turned 90°, and the packer tries both.
  assert.ok(piecesPerPlate({ x: 240, y: 20 }, { x: 256, y: 120 }) >= 4);
  // Nothing fits: zero, not one.
  assert.equal(piecesPerPlate({ x: 400, y: 400 }, { x: 256, y: 256 }), 0);
});

test('a batch too big for one plate becomes more plates, and more warm-ups', () => {
  const one = measure(boxStl(100, 100, 20), { quantity: 1 });
  const many = measure(boxStl(100, 100, 20), { quantity: 9 });
  assert.equal(one.analysis.plateCount, 1);
  assert.equal(many.analysis.plateCount, 3, '9 parts at 4 a plate is 3 plates');
  assert.ok(
    totalPrintMinutes(many.analysis) > totalPrintMinutes(one.analysis) * 8,
    'nine parts across three plates must carry three warm-ups'
  );
});

// --------------------------------------------------------------- the honesty

test('nothing this path produces is ever called a measurement', () => {
  const r = measure(boxStl(20, 20, 20));
  // THE assertion this file exists for. A geometric estimate that reported
  // `measured` would be presented as a single exact price by the cost engine,
  // which is the §53 failure in its purest form.
  assert.equal(r.analysis.provenance, 'platform');
  assert.match(r.analysis.slicerVersion, /^levonis-geometry@/);
  assert.doesNotMatch(r.analysis.slicerVersion, /slicer|bambu|orca/i);

  // And it says which buckets it structurally cannot measure (§8), rather than
  // reporting them as zero.
  assert.ok(r.unmeasured.includes('SUPPORT_PLACEMENT'));
  assert.ok(r.unmeasured.includes('SEAM_AND_TRAVEL'));
});

test('supports are charged only when the customer leaves them on', () => {
  // A cube sitting on the bed has one downward face — its own bottom — so the
  // support term is driven by a real measured overhang area either way.
  const cube = boxStl(40, 40, 40);
  const on = measure(cube, { supports: true });
  const off = measure(cube, { supports: false });
  assert.equal(off.analysis.materials[0].supportGrams, 0);
  assert.equal(off.analysis.materials[0].supportInterfaceGrams, 0);
  assert.ok(on.analysis.materials[0].supportGrams >= 0);
  // Whatever support is charged, it is sparse — never a solid block.
  const solidIfDense = (on.analysis.modelVolumeMm3 / 1000) * 1.24;
  assert.ok(on.analysis.materials[0].supportGrams < solidIfDense);
});

test('the build plate is not something the part needs supporting from', () => {
  // The bug this pins, found by the 20 mm cube weighing 4.03 g instead of 3.61:
  // `analyseModel` counts every downward face as overhang, and the largest
  // downward face on a flat-bottomed part is the one resting on the bed. Left
  // uncorrected, a cube is charged ~12% of its own mass to support its base.
  const cube = boxStl(20, 20, 20);
  const g = analyseModel(cube, 'cube.stl');
  assert.ok(Math.abs(g.overhang_area_mm2 - 400) < 1, 'the bottom face IS 400 mm² of overhang');
  assert.ok(Math.abs(g.bed_contact_area_mm2 - 400) < 1, 'and all 400 of it is on the bed');

  const r = measure(cube, { supports: true });
  assert.equal(r.analysis.materials[0].supportGrams, 0, 'a cube on the plate needs no support');
  assert.equal(r.analysis.materials[0].supportInterfaceGrams, 0);

  // Bed contact is never reported as more overhang than there is.
  assert.ok(g.bed_contact_area_mm2 <= g.overhang_area_mm2);
});

test('a single-material job flushes nothing, and says so as a fact not a boast', () => {
  const r = measure(boxStl(20, 20, 20));
  const m = r.analysis.materials[0];
  assert.equal(m.purgeGrams, 0);
  assert.equal(m.primeTowerGrams, 0);
  assert.equal(r.analysis.toolChanges, 0);
  // §9's rule is about not pretending a MACHINE changes material for free. With
  // one material loaded there is no change to be free — and the multi-material
  // defaults still charge every architecture, which printQuoteEngine pins.
});
