/**
 * The one place the slicer's numbers become the engine's numbers.
 *
 * Two things get pinned here because both are silent when wrong:
 *
 *  1. THE UNIT CONVERSION. The engine reports filament as LENGTH; everything
 *     downstream is priced per kilogram. A wrong diameter is a 165% error and
 *     produces a perfectly plausible price.
 *  2. THE PURGE DOUBLE-COUNT. `filament_mm_purge` is, in the engine's own
 *     words, "already counted inside the per-tool figures". Adding it instead
 *     of subtracting it bills every multi-colour job twice for its tower.
 *
 * And the rule that matters most: a bucket this engine cannot separate is
 * reported as UNMEASURED, never as zero — because a support line reading 0
 * says "no support", which is a different and false claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FILAMENT_DIAMETER_MM,
  analysisFingerprint,
  analysisFromStats,
  attributeSupport,
  filamentMmToGrams,
  gramsToFilamentMm,
  volumeFromImageEstimate,
  type SlicerStatsInput,
  type ToolAssignment,
} from '../worker/lib/printQuote/slicerAdapter';
import { materialTotalGrams } from '../worker/lib/printQuote/model';

const PLA: ToolAssignment = {
  slot: 0,
  materialId: 'pla-black',
  materialType: 'PLA',
  colorHex: '#000000',
  densityGPerCm3: 1.24,
};

const opts = (over: Partial<Parameters<typeof analysisFromStats>[1]> = {}) => ({
  fileSha256: 'b'.repeat(64),
  slicerVersion: 'three-slicer@0.2.2',
  profileRevision: 'bbl-a1-0.4-r1',
  tools: [PLA],
  boundingBoxMm: { x: 100, y: 80, z: 40 },
  modelVolumeMm3: 96_000,
  partCount: 1,
  layerHeightMm: 0.2,
  plateCount: 1,
  piecesPerPlate: 1,
  preparationMinutes: 8,
  ...over,
});

const stats = (over: Partial<SlicerStatsInput> = {}): SlicerStatsInput => ({
  filament_mm: 60_000,
  time_estimate: 14_400,
  layers: 200,
  model_layers: 200,
  raft_layers: 0,
  ...over,
});

// ------------------------------------------------------------- the conversion

test('filament length becomes grams by real geometry, and the diameter is not a detail', () => {
  // 1 m of 1.75 mm PLA. Cross-section π·(0.875)² = 2.4053 mm²; 1000 mm of it is
  // 2405.3 mm³ = 2.4053 cm³; at 1.24 g/cm³ that is 2.982 g.
  const oneMetre = filamentMmToGrams(1000, 1.24);
  assert.ok(Math.abs(oneMetre - 2.982) < 0.005, `expected ~2.982 g, got ${oneMetre}`);

  // 2.85 mm stock carries 2.65× the volume per millimetre. Getting this wrong
  // silently triples a bill.
  const fat = filamentMmToGrams(1000, 1.24, 2.85);
  assert.ok(Math.abs(fat / oneMetre - 2.652) < 0.01, `2.85mm must carry 2.65x, got ${fat / oneMetre}`);

  // Round trip.
  assert.ok(Math.abs(gramsToFilamentMm(oneMetre, 1.24) - 1000) < 0.001);
  assert.equal(DEFAULT_FILAMENT_DIAMETER_MM, 1.75);

  // Nonsense in, zero out — never NaN, which would travel silently into a price.
  assert.equal(filamentMmToGrams(-5, 1.24), 0);
  assert.equal(filamentMmToGrams(1000, 0), 0);
  assert.equal(filamentMmToGrams(1000, 1.24, 0), 0);
});

// ----------------------------------------------------------- a single-material

test('a single-material slice attributes every measured millimetre and nothing more', () => {
  const { analysis, unmeasured, refusal } = analysisFromStats(stats(), opts());
  assert.equal(refusal, undefined);
  assert.equal(analysis.materials.length, 1);

  const m = analysis.materials[0];
  // The TOTAL is exactly what the slicer measured — no rounding drift into the
  // breakdown, because the material bill is computed from these grams.
  const expected = filamentMmToGrams(60_000, 1.24);
  assert.ok(Math.abs(materialTotalGrams(m) - expected) < 1e-9);
  assert.equal(m.purgeGrams, 0);

  // Time comes from the engine; warm-up comes from the machine profile, and the
  // two are kept apart because only one of them is a measurement.
  assert.equal(analysis.printMinutesPerPlate, 240);
  assert.equal(analysis.preparationMinutes, 8);
  assert.equal(analysis.provenance, 'measured');

  // What it could not separate is NAMED. A zero support line without this would
  // read as "this part needs no support".
  assert.ok(unmeasured.includes('SUPPORT_MATERIAL'));
  assert.ok(unmeasured.includes('SUPPORT_INTERFACE'));
  assert.ok(unmeasured.includes('BRIM_RAFT'));
  assert.equal(m.supportGrams, 0);
});

// ------------------------------------------------------------ multi-material

test('purge is subtracted from the per-tool figure, never added to it', () => {
  const tools: ToolAssignment[] = [
    PLA,
    { ...PLA, slot: 1, materialId: 'pla-white', colorHex: '#ffffff' },
  ];
  const { analysis } = analysisFromStats(
    stats({
      filament_mm: 50_000,
      filament_mm_by_tool: [30_000, 20_000],
      filament_mm_purge: 9_000,
      filament_mm_purge_by_tool: [5_000, 4_000],
    }),
    opts({ tools, toolChanges: 84 })
  );

  const [black, white] = analysis.materials;
  // Tool 0: 30,000 mm total, of which 5,000 was flushed.
  assert.ok(Math.abs(black.purgeGrams - filamentMmToGrams(5_000, 1.24)) < 1e-9);
  assert.ok(Math.abs(black.modelGrams - filamentMmToGrams(25_000, 1.24)) < 1e-9);
  assert.ok(Math.abs(materialTotalGrams(black) - filamentMmToGrams(30_000, 1.24)) < 1e-9);

  assert.ok(Math.abs(white.modelGrams - filamentMmToGrams(16_000, 1.24)) < 1e-9);

  // The two tools together are exactly the engine's total. If purge had been
  // added rather than subtracted this would be 9,000 mm too high.
  const combined = materialTotalGrams(black) + materialTotalGrams(white);
  assert.ok(Math.abs(combined - filamentMmToGrams(50_000, 1.24)) < 1e-9);

  assert.equal(analysis.toolChanges, 84);
});

test('a slice that reports no purge at all says purge is unmeasured', () => {
  const { unmeasured } = analysisFromStats(stats(), opts());
  assert.ok(unmeasured.includes('PURGE'), 'no purge figure must be reported as unmeasured, not as zero');

  const { unmeasured: withPurge } = analysisFromStats(stats({ filament_mm_purge: 900 }), opts());
  assert.ok(!withPurge.includes('PURGE'));
});

// ------------------------------------------------------------------- refusals

test('the adapter refuses rather than producing a quotable analysis from nothing', () => {
  assert.equal(analysisFromStats(stats({ error: 'canceled' }), opts()).refusal, 'slice_failed');
  assert.equal(analysisFromStats(stats({ filament_mm: 0 }), opts()).refusal, 'no_filament');
  assert.equal(analysisFromStats(stats(), opts({ tools: [] })).refusal, 'no_tools');

  // Economy mode skips the time estimate. A job with no machine hours is a
  // material bill, not a quote.
  assert.equal(analysisFromStats(stats({ time_estimate: 0, economy: true }), opts()).refusal, 'no_time_estimate');

  // A skirt clipping the edge is a setting; the MODEL off the bed is a job this
  // machine cannot do, and only the second one is a refusal.
  assert.equal(analysisFromStats(stats({ over_bed: true }), opts()).refusal, undefined);
  assert.equal(analysisFromStats(stats({ over_bed_model: true }), opts()).refusal, 'off_bed');
});

// ------------------------------------------------------------ support by delta

test('support is measured by a second slice, not divided out of a time budget', () => {
  const base = analysisFromStats(stats({ filament_mm: 60_000, time_estimate: 14_400 }), opts()).analysis;

  // Same file, supports off: less filament and less time. The difference IS
  // the support — a measurement, not a share.
  const attributed = attributeSupport(base, { filament_mm: 48_000, time_estimate: 11_400 }, [PLA]);
  assert.equal(attributed.measured, true);
  assert.ok(Math.abs(attributed.analysis.materials[0].supportGrams - filamentMmToGrams(12_000, 1.24)) < 1e-6);
  assert.equal(attributed.supportMinutes, 50);

  // The total is unchanged — support moved OUT of modelGrams, it was not added.
  assert.ok(
    Math.abs(materialTotalGrams(attributed.analysis.materials[0]) - materialTotalGrams(base.materials[0])) < 1e-9
  );
});

test('two runs that are not the same job produce no support figure at all', () => {
  const base = analysisFromStats(stats({ filament_mm: 60_000 }), opts()).analysis;

  // A no-support slice that used MORE filament means the profiles differed.
  // Attributing a negative difference would hand the customer a credit.
  assert.equal(attributeSupport(base, { filament_mm: 70_000, time_estimate: 14_400 }, [PLA]).measured, false);
  // ...and one that used nothing would claim the whole part is support.
  assert.equal(attributeSupport(base, { filament_mm: 0, time_estimate: 0 }, [PLA]).measured, false);
});

// -------------------------------------------------------------- the cache key

test('the fingerprint changes when anything that changes the measurement changes', () => {
  const base = {
    fileSha256: 'c'.repeat(64),
    printerModelId: 'a1-mini',
    profileRevision: 'r1',
    slicerVersion: '0.2.2',
    qualityId: 'standard',
    strengthId: 'standard',
    nozzleMm: 0.4,
    supports: true,
    materialIds: ['pla-black'],
    orientationKey: 'z+',
  };
  const key = analysisFingerprint(base);
  assert.equal(analysisFingerprint(base), key, 'the same inputs must reuse the same analysis');

  // Every one of these makes it a different job.
  for (const change of [
    { qualityId: 'fine' },
    { strengthId: 'strong' },
    { nozzleMm: 0.6 },
    { supports: false },
    { printerModelId: 'h2d' },
    { profileRevision: 'r2' },
    { slicerVersion: '0.2.3' },
    { orientationKey: 'x+' },
    { materialIds: ['petg-black'] },
    { fileSha256: 'd'.repeat(64) },
  ]) {
    assert.notEqual(analysisFingerprint({ ...base, ...change }), key, `${JSON.stringify(change)} must bust the cache`);
  }

  // Material ORDER is not a difference — the same two spools loaded the other
  // way round is the same slice.
  assert.equal(
    analysisFingerprint({ ...base, materialIds: ['b', 'a'] }),
    analysisFingerprint({ ...base, materialIds: ['a', 'b'] })
  );
});

// ------------------------------------------------------------ image estimates

test('a photo with no scale is refused, and with one it is only ever inferred', () => {
  // §50: ask for more information rather than print a number that cannot be meant.
  assert.equal(volumeFromImageEstimate({ solidity: 0.4, infillRatio: 0.3 }), null);

  const one = volumeFromImageEstimate({ heightMm: 60, solidity: 0.4, infillRatio: 0.3 });
  assert.ok(one);
  assert.equal(one!.provenance, 'inferred');
  // With one dimension the others take the smallest known value, and the UI
  // says so — it is an assumption, not a measurement.
  assert.deepEqual(one!.boundingBoxMm, { x: 60, y: 60, z: 60 });
  assert.ok(Math.abs(one!.volumeMm3 - 60 * 60 * 60 * 0.4 * 0.3) < 1e-6);

  const three = volumeFromImageEstimate({ widthMm: 100, depthMm: 80, heightMm: 40, solidity: 0.4, infillRatio: 0.3 });
  assert.deepEqual(three!.boundingBoxMm, { x: 100, y: 80, z: 40 });

  // The ratios are clamped: a caller passing 0 or 5 gets a sane volume rather
  // than zero grams or five times the bounding box.
  const clamped = volumeFromImageEstimate({ heightMm: 60, solidity: 0, infillRatio: 9 });
  assert.ok(clamped!.volumeMm3 > 0);
  assert.ok(clamped!.volumeMm3 <= 60 * 60 * 60);
});
