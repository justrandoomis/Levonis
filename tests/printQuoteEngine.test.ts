/**
 * The print quote engine's deterministic core.
 *
 * These are the §51 scenarios that a pure cost model can actually decide —
 * single vs multi colour, support-heavy vs none, one plate vs four, two
 * printers on the same file, material incompatibility, the failure reserve,
 * merchant calibration, and the provenance rules that keep an estimate from
 * being presented as a measurement.
 *
 * Nothing here needs a browser, a slicer or a database, which is the point: the
 * layer that decides what a job COSTS has to be provable on its own, before
 * anything is wired to it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PRICING_ENGINE_VERSION,
  materialTotalGrams,
  materialWasteGrams,
  totalPrintMinutes,
  sourced,
  weakestProvenance,
  type AnalysisMaterial,
  type PrintAnalysis,
} from '../worker/lib/printQuote/model';
import {
  MULTI_MATERIAL_DEFAULTS,
  MIN_CALIBRATION_SAMPLES,
  machineIqdPerHour,
  printerEligibility,
  resolveFactor,
  resolveSuccessRate,
  type PrinterModel,
} from '../worker/lib/printQuote/printers';
import {
  DEFAULT_FAILURE_FRACTION,
  failureReserveIqd,
  energyKwh,
  predictedChangeWasteGrams,
  priceJob,
  resolveMaterialPrice,
  type PricingInputs,
} from '../worker/lib/printQuote/cost';

// ------------------------------------------------------------------ fixtures

const material = (over: Partial<AnalysisMaterial> = {}): AnalysisMaterial => ({
  slot: 0,
  materialId: 'pla-black',
  materialType: 'PLA',
  colorHex: '#000000',
  modelGrams: 180,
  supportGrams: 0,
  supportInterfaceGrams: 0,
  purgeGrams: 0,
  primeTowerGrams: 0,
  brimRaftGrams: 4,
  otherWasteGrams: 0,
  ...over,
});

const analysis = (over: Partial<PrintAnalysis> = {}): PrintAnalysis => ({
  fileSha256: 'a'.repeat(64),
  slicerVersion: 'three-slicer@0.2.2',
  profileRevision: 'bbl-a1-0.4-r1',
  provenance: 'measured',
  boundingBoxMm: { x: 120, y: 90, z: 60 },
  modelVolumeMm3: 144_000,
  partCount: 1,
  layerCount: 300,
  layerHeightMm: 0.2,
  printMinutesPerPlate: 402,
  preparationMinutes: 8,
  plateCount: 1,
  piecesPerPlate: 1,
  materials: [material()],
  toolChanges: 0,
  ...over,
});

/** A small, cheap, single-material machine. */
const SMALL: PrinterModel = {
  id: 'a1-mini',
  manufacturer: 'Bambu Lab',
  model: 'A1 mini',
  generation: '1',
  technology: 'fdm',
  buildMm: { x: 180, y: 180, z: 180 },
  nozzleSizesMm: [0.2, 0.4, 0.6, 0.8],
  defaultNozzleMm: 0.4,
  toolheadCount: 1,
  independentToolheads: false,
  maxSimultaneousMaterials: 4,
  multiMaterial: 'single_nozzle_changer',
  enclosed: false,
  heatedChamber: false,
  hardenedNozzleAvailable: true,
  materials: ['PLA', 'PETG', 'TPU'],
  power: { idleWatts: 8, bedHeatingWatts: 180, nozzleHeatingWatts: 60, printingWatts: 95 },
  purchaseIqd: 350_000,
  residualIqd: 70_000,
  usefulPrintHours: 6_000,
  maintenanceIqdPerHour: 18,
  baselineSuccessRate: 0.9,
};

/** A larger, dearer machine with two independent toolheads. */
const BIG: PrinterModel = {
  ...SMALL,
  id: 'h2d',
  model: 'H2D',
  buildMm: { x: 350, y: 320, z: 325 },
  toolheadCount: 2,
  independentToolheads: true,
  maxSimultaneousMaterials: 8,
  multiMaterial: 'independent_toolheads',
  enclosed: true,
  heatedChamber: true,
  materials: ['PLA', 'PETG', 'TPU', 'ABS', 'ASA', 'PC', 'PA'],
  power: { idleWatts: 14, bedHeatingWatts: 350, nozzleHeatingWatts: 120, printingWatts: 180 },
  purchaseIqd: 2_600_000,
  residualIqd: 600_000,
  usefulPrintHours: 8_000,
  maintenanceIqdPerHour: 42,
  baselineSuccessRate: 0.93,
};

const inputs = (over: Partial<PricingInputs> = {}): PricingInputs => ({
  analysis: analysis(),
  printer: SMALL,
  materialPrices: { platformByType: { PLA: 18_000 } },
  electricity: sourced(120, 'merchant'),
  laborIqdPerHour: sourced(6_000, 'merchant'),
  laborTasks: [
    { id: 'prepare', minutes: 6 },
    { id: 'bed', minutes: 3, perPlate: true },
    { id: 'support_removal', minutes: 0 },
  ],
  packagingIqd: 1_000,
  overheadIqd: 2_000,
  risk: { successRate: sourced(0.9, 'platform') },
  targetMarginPercent: 35,
  ...over,
});

const lineOf = (r: ReturnType<typeof priceJob>, c: string) => r.lines.find((l) => l.component === c);
const iqdOf = (r: ReturnType<typeof priceJob>, c: string) => lineOf(r, c)?.iqd ?? 0;

// ------------------------------------------------------------- the basic maths

test('grams are split by purpose, and waste is everything that is not the part', () => {
  const m = material({ modelGrams: 180, supportGrams: 26, supportInterfaceGrams: 8, purgeGrams: 40, brimRaftGrams: 4 });
  assert.equal(materialTotalGrams(m), 258);
  assert.equal(materialWasteGrams(m), 78);

  // Machine time counts every plate, warm-up included.
  assert.equal(totalPrintMinutes(analysis({ plateCount: 4, printMinutesPerPlate: 100, preparationMinutes: 8 })), 432);
});

test('a quote is components, not one number, and a support-heavy job says so', () => {
  const plain = priceJob(inputs());
  const supported = priceJob(
    inputs({
      analysis: analysis({
        materials: [material({ supportGrams: 46, supportInterfaceGrams: 12 })],
        printMinutesPerPlate: 470,
      }),
    })
  );

  // The support is its OWN line — §8's whole point is that it must be visible.
  assert.equal(iqdOf(plain, 'SUPPORT_MATERIAL'), 0);
  assert.ok(iqdOf(supported, 'SUPPORT_MATERIAL') > 0);
  assert.ok(iqdOf(supported, 'SUPPORT_INTERFACE') > 0);
  assert.ok(supported.trueExpectedCostIqd > plain.trueExpectedCostIqd);
  assert.ok(supported.wasteGrams > plain.wasteGrams);
  // And the reason is legible, not buried in the filament total.
  assert.match(lineOf(supported, 'SUPPORT_MATERIAL')!.detail!, /46\.0 g PLA @ 18,000\/kg/);
});

// ----------------------------------------------------- multi-material economics

test('two multi-colour architectures do not waste the same, and neither wastes nothing', () => {
  const changes = 120;
  const layers = 60;
  const density = 1.24; // PLA

  const ams = predictedChangeWasteGrams(changes, layers, density, MULTI_MATERIAL_DEFAULTS.single_nozzle_changer);
  const dual = predictedChangeWasteGrams(changes, layers, density, MULTI_MATERIAL_DEFAULTS.independent_toolheads);

  // A single nozzle must flush; independent heads have nothing to flush.
  assert.ok(ams.purgeGrams > 9, 'a flushing machine wastes real grams per change');
  assert.equal(dual.purgeGrams, 0);
  assert.ok(ams.towerGrams > 0);
  assert.equal(dual.towerGrams, 0);

  // ...but the efficient architecture is NOT free. §9 forbids "zero waste".
  assert.ok(dual.primeGrams > 0, 'a parked head oozes and a returning head is re-primed');
  assert.ok(dual.extraSeconds > 0);
  assert.ok(ams.purgeGrams + ams.towerGrams > dual.primeGrams * 5, 'and it is dramatically less');

  // Not one of these is a branded special case.
  for (const p of Object.values(MULTI_MATERIAL_DEFAULTS)) {
    if (p.kind === 'none') continue;
    assert.ok(p.secondsPerChange > 0, `${p.kind} pretends a change is instant`);
    assert.ok(p.purgeMm3PerChange + p.primeMm3PerChange > 0, `${p.kind} pretends a change is free`);
  }
});

// -------------------------------------------------------------- printer choice

test('the same file on two printers legitimately costs two different amounts', () => {
  const small = priceJob(inputs({ printer: SMALL }));
  const big = priceJob(inputs({ printer: BIG }));
  assert.notEqual(small.trueExpectedCostIqd, big.trueExpectedCostIqd);
  // The larger machine's hour is dearer: more to buy, more to maintain, more
  // to power. On a job that fits either, that shows up as a higher cost.
  assert.ok(machineIqdPerHour(BIG) > machineIqdPerHour(SMALL));
  assert.ok(big.trueExpectedCostIqd > small.trueExpectedCostIqd);
});

test('a batch that needs four plates on a small printer can beat one plate on a big one', () => {
  // Same 24 pieces. The small machine fits 6 a plate; the big one fits all 24.
  const perPiece = 34;
  const small = priceJob(
    inputs({
      printer: SMALL,
      analysis: analysis({ plateCount: 4, piecesPerPlate: 6, printMinutesPerPlate: perPiece * 6, preparationMinutes: 8 }),
      laborTasks: [
        { id: 'prepare', minutes: 6 },
        // Every plate is a fresh bed to clear and set — this is the cost §12
        // says a comparison has to see.
        { id: 'bed', minutes: 12, perPlate: true },
      ],
    })
  );
  const big = priceJob(
    inputs({
      printer: BIG,
      analysis: analysis({ plateCount: 1, piecesPerPlate: 24, printMinutesPerPlate: perPiece * 24, preparationMinutes: 12 }),
      laborTasks: [
        { id: 'prepare', minutes: 6 },
        { id: 'bed', minutes: 12, perPlate: true },
      ],
    })
  );

  assert.ok(small.machineHours > 0 && big.machineHours > 0);
  // Four warm-ups and four bed changes against one.
  assert.ok(iqdOf(small, 'LABOR') > iqdOf(big, 'LABOR'), 'four plates must cost four setups');
  assert.ok(
    small.machineHours > big.machineHours,
    'four warm-ups are four warm-ups, even when the print time per piece is identical'
  );
});

test('an ineligible printer is not an expensive option — it is no option, with reasons', () => {
  const tooBig = printerEligibility(SMALL, {
    boundingBoxMm: { x: 300, y: 90, z: 60 },
    materialTypes: ['PLA'],
    simultaneousMaterials: 1,
  });
  assert.equal(tooBig.eligible, false);
  assert.deepEqual(tooBig.reasons, ['build_volume']);

  const needsChamber = printerEligibility(SMALL, {
    boundingBoxMm: { x: 100, y: 90, z: 60 },
    materialTypes: ['ABS'],
    simultaneousMaterials: 1,
    needsEnclosure: true,
  });
  assert.equal(needsChamber.eligible, false);
  assert.deepEqual(needsChamber.reasons, ['material:ABS', 'enclosure']);
  assert.equal(
    printerEligibility(BIG, { boundingBoxMm: { x: 100, y: 90, z: 60 }, materialTypes: ['ABS'], simultaneousMaterials: 1, needsEnclosure: true }).eligible,
    true
  );

  // Six colours at once on a four-lane changer is a refusal, not a slower job.
  assert.deepEqual(
    printerEligibility(SMALL, { boundingBoxMm: { x: 100, y: 90, z: 60 }, materialTypes: ['PLA'], simultaneousMaterials: 6 }).reasons,
    ['materials_at_once']
  );
});

// ----------------------------------------------------------- failure economics

test('the failure reserve is not the price times one plus a percentage', () => {
  const variable = 100_000;
  const risk = { successRate: 0.8, averageFailureFraction: 0.5, restartMinutes: 10, laborIqdPerHour: 6_000 };
  const reserve = failureReserveIqd(variable, risk);

  // 1/0.8 − 1 = 0.25 expected failed attempts, each burning HALF the variable
  // cost plus ten minutes of clean-up — not a whole job.
  const expected = 0.25 * (0.5 * variable + (10 / 60) * 6_000);
  assert.ok(Math.abs(reserve - expected) < 1);

  // The naive multiplier would charge 0.25 × the whole thing. It does not.
  assert.ok(reserve < 0.25 * variable, 'a failure does not consume a whole print');

  // A perfect machine reserves nothing; a bad one reserves more.
  assert.equal(failureReserveIqd(variable, { ...risk, successRate: 1 }), 0);
  assert.ok(failureReserveIqd(variable, { ...risk, successRate: 0.5 }) > reserve);
  assert.equal(DEFAULT_FAILURE_FRACTION > 0 && DEFAULT_FAILURE_FRACTION < 1, true);
});

test('the reserve rides on what a retry repeats, and not on what it does not', () => {
  const lean = priceJob(inputs({ risk: { successRate: sourced(0.75, 'platform') } }));
  // Packaging, overhead and the platform's cut are paid once per ORDER. A job
  // that needed two attempts does not need two boxes.
  const fat = priceJob(
    inputs({ risk: { successRate: sourced(0.75, 'platform') }, packagingIqd: 50_000, overheadIqd: 50_000 })
  );
  assert.equal(lean.failureReserveIqd, fat.failureReserveIqd);
  assert.ok(fat.trueExpectedCostIqd > lean.trueExpectedCostIqd);

  // And it is a line of its own, never folded into the filament.
  assert.ok(iqdOf(lean, 'FAILURE_RESERVE') > 0);
  assert.equal(lean.trueExpectedCostIqd, lean.baseCostIqd + lean.failureReserveIqd);
});

// ------------------------------------------------------- margin, not markup

test('margin and markup are different numbers and the engine keeps them apart', () => {
  const r = priceJob(inputs({ targetMarginPercent: 40 }));
  // A 40% MARGIN means profit is 40% of the PRICE. The markup is higher.
  assert.ok(Math.abs(r.marginPercent - 40) < 0.6, `margin was ${r.marginPercent}`);
  assert.ok(r.markupPercent > r.marginPercent);
  assert.equal(r.breakEvenIqd, r.trueExpectedCostIqd);
  assert.equal(r.profitIqd, r.recommendedPriceIqd - r.trueExpectedCostIqd);
});

test('a minimum job charge and a rush multiplier both raise the floor', () => {
  const plain = priceJob(inputs());
  assert.ok(priceJob(inputs({ minimumJobIqd: plain.recommendedPriceIqd * 3 })).recommendedPriceIqd >= plain.recommendedPriceIqd * 3);
  assert.ok(priceJob(inputs({ rushMultiplier: 1.5 })).recommendedPriceIqd > plain.recommendedPriceIqd);
});

// ------------------------------------------------------------------ provenance

test('a merchant spool outranks every catalogue, and the quote records which', () => {
  const m = material();
  const spool = resolveMaterialPrice(m, {
    spool: { 'pla-black': { iqdPerKg: 14_000, spoolId: 'sp_7' } },
    catalogue: { 'pla-black': 22_000 },
    platformByType: { PLA: 18_000 },
  });
  assert.deepEqual(spool, { iqdPerKg: 14_000, from: 'merchant', ref: 'spool:sp_7' });

  assert.equal(resolveMaterialPrice(m, { catalogue: { 'pla-black': 22_000 } })!.from, 'profile');
  assert.equal(resolveMaterialPrice(m, { platformByType: { PLA: 18_000 } })!.from, 'platform');
  // Nothing prices it: null, so the quote stops rather than costing it at zero.
  assert.equal(resolveMaterialPrice(m, {}), null);
});

test('a material nobody can price makes the quote insufficient, never free', () => {
  const r = priceJob(inputs({ materialPrices: {} }));
  assert.equal(r.confidence, 'insufficient');
  assert.equal(iqdOf(r, 'MODEL_MATERIAL'), 0);
});

test('the weakest input decides what the quote may claim to be', () => {
  assert.equal(weakestProvenance(['measured', 'merchant']), 'merchant');
  assert.equal(weakestProvenance(['measured', 'platform', 'merchant']), 'platform');
  assert.equal(weakestProvenance(['platform', 'inferred']), 'inferred');

  // A sliced file priced from the merchant's own spool is exact, and shows one
  // number.
  const exact = priceJob(
    inputs({ materialPrices: { spool: { 'pla-black': { iqdPerKg: 14_000, spoolId: 'sp_7' } } }, risk: { successRate: sourced(0.92, 'merchant') } })
  );
  assert.equal(exact.confidence, 'exact');
  assert.equal(exact.rangeIqd.low, exact.rangeIqd.high);

  // A photo can never be exact, however good the rest of the inputs are (§3).
  const fromPhoto = priceJob(
    inputs({
      analysis: analysis({ provenance: 'inferred' }),
      materialPrices: { spool: { 'pla-black': { iqdPerKg: 14_000, spoolId: 'sp_7' } } },
      risk: { successRate: sourced(0.92, 'merchant') },
    })
  );
  assert.equal(fromPhoto.confidence, 'estimated');
  assert.ok(fromPhoto.rangeIqd.high > fromPhoto.rangeIqd.low);
});

// -------------------------------------------------------------- calibration

test('a shop’s own numbers count only once there are enough of them', () => {
  // Three prints is an anecdote; the baseline stands and says `platform`.
  const thin = resolveSuccessRate(SMALL, { successRate: 1, successRateSamples: 3 });
  assert.equal(thin.value, SMALL.baselineSuccessRate);
  assert.equal(thin.from, 'platform');

  const real = resolveSuccessRate(SMALL, { successRate: 0.97, successRateSamples: MIN_CALIBRATION_SAMPLES });
  assert.equal(real.value, 0.97);
  assert.equal(real.from, 'merchant');

  assert.equal(resolveFactor(1.08, 2).value, 1, 'a factor from two prints is noise');
  assert.equal(resolveFactor(1.08, MIN_CALIBRATION_SAMPLES).value, 1.08);
});

test('a shop that runs slower than the slicer is priced as the shop it is', () => {
  const nominal = priceJob(inputs());
  const slow = priceJob(inputs({ timeFactor: sourced(1.2, 'merchant', 'samples:20') }));
  assert.ok(slow.machineHours > nominal.machineHours);
  assert.ok(iqdOf(slow, 'DEPRECIATION') > iqdOf(nominal, 'DEPRECIATION'));
  assert.ok(iqdOf(slow, 'ELECTRICITY') > iqdOf(nominal, 'ELECTRICITY'));
  // Material is untouched by a TIME correction — they are separate observations.
  assert.equal(iqdOf(slow, 'MODEL_MATERIAL'), iqdOf(nominal, 'MODEL_MATERIAL'));
});

// ------------------------------------------------------------------- energy

test('heating is charged per plate, and idle toolheads draw while another prints', () => {
  const one = energyKwh({ plateCount: 1, printMinutesPerPlate: 120, preparationMinutes: 10 }, BIG.power);
  const four = energyKwh({ plateCount: 4, printMinutesPerPlate: 120, preparationMinutes: 10 }, BIG.power);
  assert.ok(Math.abs(four - one * 4) < 1e-9, 'four plates are four warm-ups');

  const withStandby = energyKwh({ plateCount: 1, printMinutesPerPlate: 120, preparationMinutes: 10 }, BIG.power, 1, 35);
  assert.ok(withStandby > one, 'a second hot head is not free');
});

// -------------------------------------------------------------- reproducibility

test('the engine is pure, versioned, and gives the same answer twice', () => {
  const a = priceJob(inputs());
  const b = priceJob(inputs());
  assert.deepEqual(a, b, 'a quote must be reproducible from its snapshot');
  assert.equal(a.engineVersion, PRICING_ENGINE_VERSION);

  // No clock and no randomness anywhere in the engine — that is what makes an
  // old order still explainable after the algorithm moves (§30, §31).
  for (const f of ['cost.ts', 'printers.ts', 'model.ts']) {
    const source = readFileSync(new URL(`../worker/lib/printQuote/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Math\.random\(/, `${f} must not be random`);
    assert.doesNotMatch(source, /Date\.now\(|new Date\(/, `${f} must not read a clock`);
    assert.doesNotMatch(source, /\bfetch\(/, `${f} must not call out`);
  }
});
