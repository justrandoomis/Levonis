/**
 * THE COST ENGINE.
 *
 * §6 is explicit that `cost = grams × price` is the thing this replaces. What
 * follows is a component model: every line is computed separately, kept
 * separately, and shown separately to the merchant, because a shop cannot
 * answer "why is this job unprofitable" from a single total.
 *
 * Two rules decide most of the shape:
 *
 *  1. WASTE IS NAMED. Support, interface, purge, tower, brim — each is its own
 *     line. §8 forbids folding support grams invisibly into "total filament":
 *     the whole reason a support-heavy model costs more must be visible in the
 *     breakdown, or the merchant learns nothing from it.
 *
 *  2. RISK IS NOT A MULTIPLIER. §13 rules out `price × (1 + failureRate)`
 *     explicitly, and it is wrong for a reason worth stating: a print that
 *     fails does not consume the whole job. It consumes the material and the
 *     hours up to the moment it failed, plus the labour to clear the bed and
 *     start again — and it consumes none of the packaging, none of the
 *     overhead, and none of the fixed setup that is paid once per ORDER. See
 *     `failureReserve` below.
 */

import {
  VARIABLE_COMPONENTS,
  iqd,
  materialTotalGrams,
  materialWasteGrams,
  totalPrintMinutes,
  weakestProvenance,
  type AnalysisMaterial,
  type CostComponent,
  type CostLine,
  type PrintAnalysis,
  type Provenance,
  type QuoteConfidence,
  type QuoteResult,
  type Sourced,
} from './model';
import { PRICING_ENGINE_VERSION } from './model';
import {
  MULTI_MATERIAL_DEFAULTS,
  machineIqdPerHour,
  type MultiMaterialProfile,
  type PowerProfile,
  type PrinterModel,
} from './printers';

// ------------------------------------------------------------------- material

/**
 * WHAT A GRAM COSTS, AND WHY THAT PRICE (§7).
 *
 * The order is not a preference, it is a correctness rule: a merchant printing
 * from a spool they bought at 14,000 is not spending the catalogue's 22,000,
 * and pricing their job at the catalogue rate quietly hands the difference to
 * nobody. Whichever rung answers is recorded, so the merchant panel can say
 * «من بكرتك» rather than presenting a platform average as their cost.
 */
export interface MaterialPrice {
  /** IQD per kilogram. */
  iqdPerKg: number;
  from: Provenance;
  ref?: string;
}

export interface MaterialPriceSources {
  /** This merchant's actual spool, by material id. Beats everything. */
  spool?: Record<string, { iqdPerKg: number; spoolId: string }>;
  /** This merchant's default for the material type. */
  merchantDefault?: Record<string, number>;
  /** The Levonis catalogue's price for the material id. */
  catalogue?: Record<string, number>;
  /** The last resort, by material TYPE ('PLA'), so an unknown id still prices. */
  platformByType?: Record<string, number>;
}

export function resolveMaterialPrice(
  material: Pick<AnalysisMaterial, 'materialId' | 'materialType'>,
  sources: MaterialPriceSources
): MaterialPrice | null {
  const spool = sources.spool?.[material.materialId];
  if (spool && spool.iqdPerKg > 0) {
    return { iqdPerKg: spool.iqdPerKg, from: 'merchant', ref: `spool:${spool.spoolId}` };
  }
  const own = sources.merchantDefault?.[material.materialId];
  if (own && own > 0) return { iqdPerKg: own, from: 'merchant', ref: `material:${material.materialId}` };
  const cat = sources.catalogue?.[material.materialId];
  if (cat && cat > 0) return { iqdPerKg: cat, from: 'profile', ref: `catalogue:${material.materialId}` };
  const byType = sources.platformByType?.[material.materialType.toUpperCase()];
  if (byType && byType > 0) return { iqdPerKg: byType, from: 'platform', ref: `type:${material.materialType}` };
  // Deliberately null rather than zero: a material nobody can price must stop
  // the quote, not silently make the job look free.
  return null;
}

/** Grams grouped by the component each gram belongs to. */
const GRAM_BUCKETS: ReadonlyArray<[CostComponent, (m: AnalysisMaterial) => number]> = [
  ['MODEL_MATERIAL', (m) => m.modelGrams],
  ['SUPPORT_MATERIAL', (m) => m.supportGrams],
  ['SUPPORT_INTERFACE', (m) => m.supportInterfaceGrams],
  ['PURGE', (m) => m.purgeGrams],
  ['PRIME_TOWER', (m) => m.primeTowerGrams],
  ['BRIM_RAFT', (m) => m.brimRaftGrams],
  ['OTHER_WASTE', (m) => m.otherWasteGrams],
];

// -------------------------------------------------------------- multi-material

/**
 * The waste a MACHINE adds for changing material, when the slicer has not
 * already accounted for it.
 *
 * Preferring the slicer is the point: a 3MF sliced with a real profile already
 * contains its purge and its tower, and adding a coefficient on top would
 * double-charge. This exists for the case the slicer cannot answer — an
 * image-based estimate, or a comparison against a printer the file was not
 * sliced for, which is exactly what §41's printer comparison needs.
 */
export function predictedChangeWasteGrams(
  toolChanges: number,
  changeLayers: number,
  densityGPerCm3: number,
  profile: MultiMaterialProfile
): { purgeGrams: number; primeGrams: number; towerGrams: number; extraSeconds: number } {
  const changes = Math.max(0, Math.floor(toolChanges));
  const layers = Math.max(0, Math.floor(changeLayers));
  const gPerMm3 = Math.max(0, densityGPerCm3) / 1000;
  return {
    purgeGrams: changes * profile.purgeMm3PerChange * gPerMm3,
    primeGrams: changes * profile.primeMm3PerChange * gPerMm3,
    towerGrams: layers * profile.towerMm3PerChangeLayer * gPerMm3,
    extraSeconds: changes * profile.secondsPerChange,
  };
}

// -------------------------------------------------------------------- energy

/**
 * Kilowatt-hours for the job, by phase rather than one flat wattage.
 *
 * A bed coming up to temperature draws several times what it draws holding, so
 * a single average overstates a six-hour print and understates a twenty-minute
 * one. Heating is charged once per PLATE, because each plate is a fresh warm-up.
 */
export function energyKwh(
  a: Pick<PrintAnalysis, 'plateCount' | 'printMinutesPerPlate' | 'preparationMinutes'>,
  power: PowerProfile,
  idleToolCount = 0,
  standbyWattsPerIdleTool = 0
): number {
  const plates = Math.max(1, Math.floor(a.plateCount));
  const heatMinutes = Math.max(0, a.preparationMinutes);
  const printMinutes = Math.max(0, a.printMinutesPerPlate);
  const heatWatts = Math.max(0, power.bedHeatingWatts) + Math.max(0, power.nozzleHeatingWatts);
  const standby = Math.max(0, idleToolCount) * Math.max(0, standbyWattsPerIdleTool);
  const perPlateWh =
    (heatWatts * heatMinutes) / 60 + ((Math.max(0, power.printingWatts) + standby) * printMinutes) / 60;
  return (plates * perPlateWh) / 1000;
}

// --------------------------------------------------------------------- labour

/** One human task, its minutes, and whether this job actually needs it. §19:
 *  never charge automatically for an operation nobody performs. */
export interface LaborTask {
  id: string;
  minutes: number;
  /** True when the task is a per-PLATE cost rather than per-job. */
  perPlate?: boolean;
}

export const laborMinutes = (tasks: LaborTask[], plateCount: number): number =>
  tasks.reduce((sum, t) => sum + Math.max(0, t.minutes) * (t.perPlate ? Math.max(1, plateCount) : 1), 0);

// ----------------------------------------------------------------------- risk

export interface RiskInputs {
  /** 0 < p <= 1. Resolved by `resolveSuccessRate`, never assumed. */
  successRate: number;
  /**
   * The average fraction of a job that is already printed when it fails. THIS
   * is what stops the naive multiplier: prints do not fail uniformly at 100%.
   * Derived from `print_failures.stage` once there is history; until then a
   * conservative platform default.
   */
  averageFailureFraction: number;
  /** Minutes a person spends clearing the bed and restarting. */
  restartMinutes: number;
  laborIqdPerHour: number;
}

/**
 * THE EXPECTED COST OF THE ATTEMPTS THAT FAIL.
 *
 * Expected attempts until one succeeds is 1/p, so expected FAILED attempts is
 * 1/p − 1. Each failed attempt burns:
 *
 *   - the variable cost up to the point it died — material, power, machine
 *     hours, maintenance — scaled by `averageFailureFraction`;
 *   - the labour to clear up and start again, in full.
 *
 * and burns NONE of the packaging, overhead or platform fees, which are paid
 * once per order however many attempts it took. That distinction is the whole
 * difference between this and `× (1 + failureRate)`.
 */
export function failureReserveIqd(variableCostIqd: number, risk: RiskInputs): number {
  const p = Math.min(1, Math.max(0.01, risk.successRate));
  const expectedFailures = 1 / p - 1;
  if (expectedFailures <= 0) return 0;
  const fraction = Math.min(1, Math.max(0, risk.averageFailureFraction));
  const restartIqd = (Math.max(0, risk.restartMinutes) / 60) * Math.max(0, risk.laborIqdPerHour);
  return expectedFailures * (fraction * Math.max(0, variableCostIqd) + restartIqd);
}

/** Until a shop has failures of its own recorded, this is the assumed average
 *  completion at failure. Mid-print is the honest guess: adhesion failures die
 *  early, spaghetti and layer shifts die late, and assuming either extreme
 *  would bias every quote in one direction. */
export const DEFAULT_FAILURE_FRACTION = 0.45;

// ------------------------------------------------------------------- the quote

export interface PricingInputs {
  analysis: PrintAnalysis;
  printer: PrinterModel;
  materialPrices: MaterialPriceSources;
  /** Density per material id, for predicted (not sliced) change waste. */
  densityGPerCm3?: Record<string, number>;

  electricity: Sourced;
  laborIqdPerHour: Sourced;
  /** Overrides depreciation when the merchant has costed their own machine. */
  machineIqdPerHourOverride?: Sourced;
  maintenanceIqdPerHourOverride?: Sourced;

  laborTasks: LaborTask[];
  packagingIqd?: number;
  /** A flat shop overhead for the job, and the platform's cut. Both excluded
   *  from the failure reserve — they are paid once per order. */
  overheadIqd?: number;
  platformFeeIqd?: number;

  risk: { successRate: Sourced; averageFailureFraction?: number; restartMinutes?: number };

  /** Fraction of the PRICE, not of the cost — a margin, per §21. */
  targetMarginPercent: number;
  /** A floor the shop will not go under, whatever the margin works out to. */
  minimumJobIqd?: number;
  /** The +% a job that jumps the queue carries. */
  rushMultiplier?: number;

  /** Time/material corrections from this shop's own history (§15), already
   *  gated on sample count by `resolveFactor`. */
  timeFactor?: Sourced;
  materialFactor?: Sourced;

  quantity?: number;
}

function push(lines: CostLine[], component: CostComponent, value: number, from: Provenance, detail?: string) {
  const rounded = iqd(value);
  if (rounded === 0) return;
  lines.push(detail === undefined ? { component, iqd: rounded, from } : { component, iqd: rounded, from, detail });
}

/**
 * Prices one analysis on one printer. Pure: no clock, no database, no network —
 * which is what makes a stored quote reproducible from its snapshot (§30).
 */
export function priceJob(input: PricingInputs): QuoteResult {
  const { analysis, printer } = input;
  const lines: CostLine[] = [];
  const provenances: Provenance[] = [analysis.provenance];
  const quantity = Math.max(1, Math.floor(input.quantity ?? 1));

  const materialFactor = input.materialFactor?.value ?? 1;
  const timeFactor = input.timeFactor?.value ?? 1;
  // A factor of exactly 1 is what `resolveFactor` returns when a shop has too
  // little history to calibrate with — it changes no number, so it must not
  // drag the quote's provenance down to 'platform' either. Only a correction
  // that actually moves a figure gets to speak for where that figure came from.
  const materialFactorFrom = materialFactor !== 1 ? input.materialFactor?.from : undefined;
  const timeFactorFrom = timeFactor !== 1 ? input.timeFactor?.from : undefined;
  if (materialFactorFrom) provenances.push(materialFactorFrom);
  if (timeFactorFrom) provenances.push(timeFactorFrom);

  // ---- 1. material, split by where every gram goes ------------------------
  const bucketIqd = new Map<CostComponent, number>();
  const bucketDetail = new Map<CostComponent, string[]>();
  // Per COMPONENT, not per quote: a line that came from the merchant's own
  // spool says 'merchant' even when some unrelated input to the same quote is
  // weaker. Rolling the running weakest into every material line is how a real
  // measurement gets mislabelled as a platform default — and the merchant panel
  // reads these to decide whether a number is theirs or ours.
  const bucketFrom = new Map<CostComponent, Provenance[]>();
  let wasteGrams = 0;
  let totalGrams = 0;
  let unpriced: string | null = null;

  for (const m of analysis.materials) {
    const price = resolveMaterialPrice(m, input.materialPrices);
    if (!price) {
      unpriced = m.materialId || m.materialType || `slot ${m.slot}`;
      continue;
    }
    provenances.push(price.from);
    totalGrams += materialTotalGrams(m) * materialFactor;
    wasteGrams += materialWasteGrams(m) * materialFactor;
    for (const [component, take] of GRAM_BUCKETS) {
      const grams = Math.max(0, take(m)) * materialFactor;
      if (grams <= 0) continue;
      bucketIqd.set(component, (bucketIqd.get(component) ?? 0) + (grams / 1000) * price.iqdPerKg);
      const label = `${grams.toFixed(1)} g ${m.materialType || m.materialId} @ ${Math.round(price.iqdPerKg).toLocaleString('en-US')}/kg`;
      const list = bucketDetail.get(component);
      if (list) list.push(label);
      else bucketDetail.set(component, [label]);
      const froms = bucketFrom.get(component);
      if (froms) froms.push(price.from);
      else bucketFrom.set(component, [price.from]);
    }
  }

  for (const [component] of GRAM_BUCKETS) {
    const value = bucketIqd.get(component);
    if (value === undefined) continue;
    // The grams are the analysis's, the rate is the price's, and the factor (if
    // it moved anything) is the shop's history. The weakest of exactly those
    // three is what this line is worth believing.
    const from = weakestProvenance([
      analysis.provenance,
      ...(bucketFrom.get(component) ?? []),
      ...(materialFactorFrom ? [materialFactorFrom] : []),
    ]);
    push(lines, component, value * quantity, from, bucketDetail.get(component)?.join(' · '));
  }

  // ---- 2. machine time ----------------------------------------------------
  const minutes = totalPrintMinutes(analysis) * timeFactor;
  const hours = (minutes / 60) * quantity;

  const idleTools = Math.max(0, printer.toolheadCount - 1);
  const mm = MULTI_MATERIAL_DEFAULTS[printer.multiMaterial];
  const kwh =
    energyKwh(analysis, printer.power, analysis.toolChanges > 0 ? idleTools : 0, mm.standbyWattsPerIdleTool) *
    timeFactor *
    quantity;
  // Every time-driven line inherits the analysis's provenance too: an estimated
  // print time priced at a measured electricity rate is still an estimate.
  const timed = (rateFrom: Provenance): Provenance =>
    weakestProvenance([analysis.provenance, rateFrom, ...(timeFactorFrom ? [timeFactorFrom] : [])]);

  push(lines, 'ELECTRICITY', kwh * input.electricity.value, timed(input.electricity.from), `${kwh.toFixed(2)} kWh`);
  provenances.push(input.electricity.from);

  const depPerHour = input.machineIqdPerHourOverride?.value ?? machineIqdPerHour(printer);
  const depFrom: Provenance = input.machineIqdPerHourOverride?.from ?? 'profile';
  push(lines, 'DEPRECIATION', hours * depPerHour, timed(depFrom), `${hours.toFixed(2)} h @ ${Math.round(depPerHour).toLocaleString('en-US')}/h`);
  provenances.push(depFrom);

  const maintPerHour = input.maintenanceIqdPerHourOverride?.value ?? printer.maintenanceIqdPerHour;
  const maintFrom: Provenance = input.maintenanceIqdPerHourOverride?.from ?? 'profile';
  push(lines, 'MAINTENANCE', hours * maintPerHour, timed(maintFrom), `${hours.toFixed(2)} h`);
  provenances.push(maintFrom);

  // ---- 3. people ----------------------------------------------------------
  const postIds = new Set(['support_removal', 'sanding', 'finishing']);
  const prep = input.laborTasks.filter((t) => !postIds.has(t.id));
  const post = input.laborTasks.filter((t) => postIds.has(t.id));
  const rate = input.laborIqdPerHour.value;
  provenances.push(input.laborIqdPerHour.from);
  push(lines, 'LABOR', (laborMinutes(prep, analysis.plateCount) / 60) * rate, input.laborIqdPerHour.from);
  push(
    lines,
    'POST_PROCESSING',
    (laborMinutes(post, analysis.plateCount) / 60) * rate * quantity,
    input.laborIqdPerHour.from
  );

  // ---- 4. the costs a retry does NOT repeat -------------------------------
  push(lines, 'PACKAGING', (input.packagingIqd ?? 0) * quantity, 'merchant');
  push(lines, 'OVERHEAD', input.overheadIqd ?? 0, 'merchant');
  push(lines, 'PLATFORM_FEES', input.platformFeeIqd ?? 0, 'platform');

  // ---- 5. risk ------------------------------------------------------------
  const variableCost = lines
    .filter((l) => VARIABLE_COMPONENTS.has(l.component))
    .reduce((sum, l) => sum + l.iqd, 0);
  const reserve = failureReserveIqd(variableCost, {
    successRate: input.risk.successRate.value,
    averageFailureFraction: input.risk.averageFailureFraction ?? DEFAULT_FAILURE_FRACTION,
    restartMinutes: input.risk.restartMinutes ?? 10,
    laborIqdPerHour: rate,
  });
  provenances.push(input.risk.successRate.from);
  push(lines, 'FAILURE_RESERVE', reserve, input.risk.successRate.from);

  // ---- 6. the totals ------------------------------------------------------
  const baseCost = lines
    .filter((l) => l.component !== 'FAILURE_RESERVE')
    .reduce((sum, l) => sum + l.iqd, 0);
  const trueCost = baseCost + iqd(reserve);

  const margin = Math.min(0.95, Math.max(0, input.targetMarginPercent / 100));
  // price = cost / (1 − margin), because a MARGIN is a share of the price. The
  // other reading — cost × (1 + margin) — is a markup, and confusing the two is
  // how a shop aiming at 40% quietly runs at 28.6%.
  const priced = margin >= 1 ? trueCost : trueCost / (1 - margin);
  const rushed = priced * Math.max(1, input.rushMultiplier ?? 1);
  // THE FLOOR IS A FLOOR FOR THE WHOLE QUOTE, NOT ONLY FOR ITS MIDPOINT.
  //
  // It is 0 today — the owner ruled «لا يوجد حد أدنى لأي طلب طباعة» — and this
  // code is written for the day they set one, which the admin lets them do
  // without a deploy.
  //
  // `floor` is then applied twice below — once to the price and once to the
  // LOW end of the range — and that is not belt and braces. The range is built
  // as price × (1 ± spread), so a tiny job lifted to a 5,000 د.ع minimum was
  // being shown to the customer as «5,000 د.ع، المتوقع 4,400 – 5,600»: an
  // expected low end BELOW the very figure the floor exists to make
  // impossible. Both screens render the range whenever high > low, so the
  // contradiction was on the customer's screen, not in a log.
  const floor = input.minimumJobIqd ?? 0;
  const price = iqd(Math.max(rushed, floor));

  const profit = price - trueCost;
  const confidence: QuoteConfidence = unpriced
    ? 'insufficient'
    : weakestProvenance(provenances) === 'inferred'
      ? 'estimated'
      : weakestProvenance(provenances) === 'platform'
        ? 'estimated'
        : 'exact';

  // A range only where the inputs justify one. ±12% is not a guess dressed as
  // precision — it is the band the engine will not claim to be inside when a
  // material price or a geometry came from a default rather than a measurement.
  const spread = confidence === 'exact' ? 0 : 0.12;
  const grams = totalGrams * quantity;

  return {
    engineVersion: PRICING_ENGINE_VERSION,
    confidence,
    lines,
    baseCostIqd: iqd(baseCost),
    failureReserveIqd: iqd(reserve),
    trueExpectedCostIqd: iqd(trueCost),
    recommendedPriceIqd: price,
    profitIqd: iqd(profit),
    marginPercent: price > 0 ? Math.round((profit / price) * 1000) / 10 : 0,
    markupPercent: trueCost > 0 ? Math.round((profit / trueCost) * 1000) / 10 : 0,
    breakEvenIqd: iqd(trueCost),
    wasteGrams: Math.round(wasteGrams * quantity * 10) / 10,
    wastePercent: grams > 0 ? Math.round(((wasteGrams * quantity) / grams) * 1000) / 10 : 0,
    machineHours: Math.round(hours * 100) / 100,
    // The low end is clamped to the same floor as the price (see above). The
    // HIGH end is not: a job can legitimately cost more than the minimum, and
    // capping it would understate what a real merchant will quote.
    rangeIqd: { low: iqd(Math.max(price * (1 - spread), floor)), high: iqd(price * (1 + spread)) },
  };
}
