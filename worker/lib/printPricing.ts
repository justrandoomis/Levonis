/**
 * PRINT PRICING — what a job actually costs to make, and what it should sell for.
 *
 * THE RULE THE OWNER SET: "لا تستخدم grams × fixed number فقط". A price built
 * that way is wrong in both directions at once — it overcharges a solid block
 * and undercharges a twelve-hour lattice — and a merchant who accepts it loses
 * money on exactly the jobs they should want. So this computes a COST first,
 * from the geometry, the material and the machine, and derives a price from it.
 *
 * WHAT MAKES THE ESTIMATE HONEST:
 *
 *  - It is a RANGE with a CONFIDENCE, never a single number pretending to be a
 *    fact. A measured STL in a known material is High; a MakerWorld link with
 *    no dimensions is Low, and says so.
 *  - It is a Levonis ESTIMATE, not an offer. The merchant's offer is the price.
 *  - It never goes below what the work costs. `min_margin_percent` is a floor
 *    the arithmetic cannot cross, because an estimate a merchant cannot afford
 *    to match is worse than no estimate: it teaches customers that every real
 *    offer is a rip-off.
 *  - Nothing here is a constant. Every rate, factor and threshold arrives in
 *    `PrintPricingConfig` from admin settings, so the owner re-prices the whole
 *    catalogue by editing numbers rather than by asking for a deploy.
 *
 * FDM AND RESIN ARE NOT THE SAME MACHINE. On FDM, time follows the VOLUME of
 * plastic pushed through a nozzle. On MSLA resin, a whole layer cures at once,
 * so time follows the HEIGHT and barely notices the volume. Pricing them with
 * one formula is the most common way a print shop loses money, so they are two
 * code paths here.
 */

import type { ModelAnalysis } from './modelGeometry';

// ------------------------------------------------------------- the catalogue

export type PrintProcess = 'fdm' | 'resin';

export interface PrintMaterial {
  id: string;
  process: PrintProcess;
  name_en: string;
  name_ar: string;
  /** g/cm³ — turns printed volume into grams, and grams into money. */
  density_g_cm3: number;
  /** The reference cost of the raw material to a merchant. */
  price_iqd_per_kg: number;
  /** Spillage, failed first layers, leftover on the spool. 0.05 = 5%. */
  waste_factor: number;
  /** How much support this material needs relative to the norm; bridging PLA
   *  needs less than drooping TPU. Multiplies the geometric support estimate. */
  support_factor: number;
  /**
   * A per-material floor in dinars, and it is ZERO IN EVERY SEEDED ROW.
   *
   * The owner ruled it: «لا يوجد حد أدنى لأي طلب طباعة» — no minimum for any
   * print job, in any material. The argument the seeds used to carry (the
   * setup and the spool change cost the same whether the part weighs 2 g or
   * 20 g) is a real cost and it is still CHARGED: it arrives through
   * `setup_minutes` and the labour rate, priced into the estimate like every
   * other cost. What the owner removed is the second, flat charge stacked on
   * top of that — a small part now quotes what it actually costs plus the
   * margin, and nothing rounds it up to a number nobody computed.
   *
   * The FIELD stays, and stays editable per material in the admin, because a
   * decision is not the same as a capability: the owner can put a floor back
   * on resin-castable tomorrow without a deploy. A merchant can also set their
   * own floor on their own printer (`min_job_iqd` in merchant preferences,
   * worker/routes/merchantPrinters.ts) — which is where a floor belongs, since
   * it is the merchant who walks to the machine.
   */
  min_economic_iqd: number;
  /** 0..1. Warping, adhesion, moisture: how likely a run is to fail. Feeds the
   *  failure-risk provision, which is a real cost, not a markup. */
  difficulty: number;
  /** ABS and ASA need a chamber; a merchant with an open printer cannot take
   *  the job at all, so this is a MATCHING fact as much as a pricing one. */
  needs_enclosure: boolean;
  /** Abrasive fill (CF/GF) needs a hardened nozzle. Same: a matching fact. */
  abrasive: boolean;
  active: boolean;
}

/**
 * The seed catalogue. Every row is a starting point the owner overwrites in the
 * admin — the densities are physical constants, the prices are Iraqi market
 * reference points that will drift, and drifting is exactly why they live in a
 * setting rather than in this file.
 */
export const DEFAULT_MATERIALS: PrintMaterial[] = [
  fdm('pla', 'PLA', 'PLA', 1.24, 18000, 0.05, 1.0, 0, 0.1, false, false),
  fdm('petg', 'PETG', 'PETG', 1.27, 22000, 0.06, 1.1, 0, 0.2, false, false),
  fdm('abs', 'ABS', 'ABS', 1.04, 20000, 0.08, 1.1, 0, 0.45, true, false),
  fdm('asa', 'ASA', 'ASA', 1.07, 26000, 0.08, 1.1, 0, 0.45, true, false),
  fdm('tpu', 'TPU', 'TPU مرن', 1.21, 32000, 0.08, 1.4, 0, 0.35, false, false),
  fdm('pa', 'PA (Nylon)', 'نايلون PA', 1.14, 45000, 0.10, 1.2, 0, 0.5, true, false),
  fdm('pc', 'PC', 'بولي كربونيت PC', 1.20, 48000, 0.10, 1.2, 0, 0.55, true, false),
  fdm('pla-cf', 'PLA-CF', 'PLA كربون', 1.30, 34000, 0.06, 1.0, 0, 0.2, false, true),
  fdm('petg-cf', 'PETG-CF', 'PETG كربون', 1.32, 38000, 0.07, 1.1, 0, 0.3, false, true),
  fdm('pa-cf', 'PA-CF', 'نايلون كربون', 1.18, 65000, 0.10, 1.2, 0, 0.55, true, true),
  resin('resin-standard', 'Standard Resin', 'ريزن قياسي', 1.10, 38000, 0.10, 1.0, 0, 0.25),
  resin('resin-abs-like', 'ABS-Like Resin', 'ريزن شبيه ABS', 1.10, 42000, 0.10, 1.0, 0, 0.25),
  resin('resin-tough', 'Tough Resin', 'ريزن متين', 1.12, 55000, 0.10, 1.0, 0, 0.3),
  resin('resin-flexible', 'Flexible Resin', 'ريزن مرن', 1.09, 60000, 0.12, 1.0, 0, 0.35),
  resin('resin-washable', 'Water Washable Resin', 'ريزن يغسل بالماء', 1.10, 40000, 0.10, 1.0, 0, 0.25),
  resin('resin-castable', 'Castable Resin', 'ريزن للصب', 1.05, 90000, 0.12, 1.0, 0, 0.4),
  resin('resin-high-temp', 'High Temp Resin', 'ريزن حراري', 1.15, 75000, 0.12, 1.0, 0, 0.4),
  resin('resin-clear', 'Clear Resin', 'ريزن شفاف', 1.10, 45000, 0.12, 1.0, 0, 0.35),
];

function fdm(
  id: string, name_en: string, name_ar: string, density: number, price: number,
  waste: number, support: number, minJob: number, difficulty: number,
  enclosure: boolean, abrasive: boolean
): PrintMaterial {
  return {
    id, process: 'fdm', name_en, name_ar,
    density_g_cm3: density, price_iqd_per_kg: price, waste_factor: waste,
    support_factor: support, min_economic_iqd: minJob, difficulty,
    needs_enclosure: enclosure, abrasive, active: true,
  };
}
function resin(
  id: string, name_en: string, name_ar: string, density: number, price: number,
  waste: number, support: number, minJob: number, difficulty: number
): PrintMaterial {
  return {
    id, process: 'resin', name_en, name_ar,
    density_g_cm3: density, price_iqd_per_kg: price, waste_factor: waste,
    support_factor: support, min_economic_iqd: minJob, difficulty,
    needs_enclosure: false, abrasive: false, active: true,
  };
}

// ------------------------------------------------------------- the settings

export type PrintQuality = 'draft' | 'standard' | 'fine' | 'ultra';

export interface PrintPricingConfig {
  /** What an hour of a person's attention costs. */
  labor_iqd_per_hour: number;
  /** Slicing, plate prep, spool change — paid once per JOB, not per part. */
  setup_minutes: number;
  /** Removing, inspecting and packing ONE part — paid per part. */
  handling_minutes_per_part: number;

  energy_iqd_per_kwh: number;
  /** Depreciation + maintenance per machine-hour, when the merchant has not
   *  declared their own. A machine is a cost even while it runs unattended. */
  machine_hour_iqd: Record<PrintProcess, number>;
  machine_watts: Record<PrintProcess, number>;

  /** FDM extrusion geometry. Layer height comes from the quality tier. */
  extrusion_width_mm: number;
  wall_count: number;
  /** Theoretical flow is never achieved: acceleration, travel and corners eat
   *  it. 0.45 means a slicer realises 45% of the nozzle's paper throughput. */
  flow_efficiency: number;
  /** Seconds lost per layer to the layer change itself. */
  layer_overhead_s: number;

  /** MSLA: a whole layer cures at once, so this is the entire time model. */
  resin_layer_exposure_s: number;
  resin_lift_s: number;
  /** Washing and curing after the print — real minutes of a real machine. */
  resin_post_minutes: number;

  /** Fraction of the part's height that support has to climb, on average. */
  support_height_ratio: number;
  /** How solid support material is. Slicers default near 15%. */
  support_density: number;
  /** Minutes of hand work per cm² of support interface. */
  support_removal_min_per_cm2: number;

  /** Purged on every filament change, per colour beyond the first. */
  purge_mm3_per_color: number;
  multicolor_setup_minutes: number;
  /** Tool changes make the print itself slower, not just the setup. */
  multicolor_time_multiplier: number;

  /** A run that fails is paid for twice. Provisioned, not marked up. */
  failure_risk_base_percent: number;
  failure_risk_per_hour_percent: number;
  failure_risk_max_percent: number;

  /** Layer height per quality tier, in millimetres. */
  quality_layer_mm: Record<PrintQuality, number>;
  /** Extra care, slower speed and tighter tolerance, as a multiplier on time. */
  quality_time_multiplier: Record<PrintQuality, number>;

  /** How much a convoluted model adds, at complexity 1.0. */
  complexity_uplift_percent: number;

  /**
   * MARGIN IS A SHARE OF THE SELLING PRICE, not a markup on cost — the same
   * reading the rest of the platform uses (worker/lib/priceGrid.ts). "35%"
   * means 35 dinars of every 100 taken, so price = cost / (1 - 0.35). Reading
   * it as a markup would quietly deliver 26% and no screen would show the gap.
   */
  target_margin_percent: number;
  /** The floor the estimate may never cross, whatever else the numbers say. */
  min_margin_percent: number;
  /**
   * The PLATFORM's floor, and it is 0 by the owner's decision — «لا يوجد حد
   * أدنى لأي طلب طباعة». See `min_economic_iqd` above for why the setting
   * survives its own value: the owner edits this in the admin, and a floor
   * that only moves on a deploy is not a setting.
   */
  min_job_iqd: number;

  /** Half-width of the published range, as a percent of the point estimate. */
  range_spread_percent: number;
  /** Repeat parts share the setup; this is how fast the saving decays. */
  quantity_discount_percent: number;
  quantity_discount_cap_percent: number;

  /** Rounded to this so a quote never reads 18,437 IQD. */
  round_to_iqd: number;
}

export const DEFAULT_PRICING: PrintPricingConfig = {
  labor_iqd_per_hour: 6000,
  setup_minutes: 12,
  handling_minutes_per_part: 4,
  energy_iqd_per_kwh: 120,
  machine_hour_iqd: { fdm: 1200, resin: 2000 },
  machine_watts: { fdm: 120, resin: 60 },
  extrusion_width_mm: 0.42,
  wall_count: 2,
  flow_efficiency: 0.45,
  layer_overhead_s: 1.5,
  resin_layer_exposure_s: 2.4,
  resin_lift_s: 3.2,
  resin_post_minutes: 25,
  support_height_ratio: 0.25,
  support_density: 0.15,
  support_removal_min_per_cm2: 0.35,
  purge_mm3_per_color: 900,
  multicolor_setup_minutes: 6,
  multicolor_time_multiplier: 1.25,
  failure_risk_base_percent: 3,
  failure_risk_per_hour_percent: 0.8,
  failure_risk_max_percent: 25,
  quality_layer_mm: { draft: 0.28, standard: 0.2, fine: 0.12, ultra: 0.08 },
  quality_time_multiplier: { draft: 0.85, standard: 1, fine: 1.25, ultra: 1.6 },
  complexity_uplift_percent: 18,
  target_margin_percent: 35,
  min_margin_percent: 15,
  min_job_iqd: 0,
  range_spread_percent: 12,
  quantity_discount_percent: 6,
  quantity_discount_cap_percent: 30,
  round_to_iqd: 250,
};

// -------------------------------------------------------------- the request

export interface QuoteInput {
  /** null when the customer gave a link with no measurable geometry. */
  analysis: ModelAnalysis | null;
  materialId: string;
  quality: PrintQuality;
  /** 0..1. 0.2 = 20% infill. Ignored for resin, which prints hollow or solid. */
  infill: number;
  quantity: number;
  colors: number;
  /** The customer asked for supports off — so no support cost, and the model's
   *  overhangs become the merchant's problem to raise, not ours to charge for. */
  supports: boolean;
  /** Minutes of finishing the customer asked for (sanding, painting, gluing). */
  post_processing_minutes: number;
  /** When the geometry is unknown, this is all we have. Explicitly a guess. */
  fallback_volume_cm3?: number;
  /** A merchant's own machine cost, when quoting for a specific merchant. */
  machine_hour_iqd?: number;
}

export interface CostLine {
  key:
    | 'material' | 'waste' | 'support_material' | 'purge'
    | 'machine' | 'energy' | 'setup' | 'labor'
    | 'support_removal' | 'post_processing' | 'failure_risk' | 'complexity';
  iqd: number;
}

export interface Quote {
  /** false when there was not enough information to price anything at all. */
  priced: boolean;
  reason?: string;

  process: PrintProcess;
  material_id: string;

  /** Plastic actually pushed through the nozzle, supports and purge included. */
  printed_volume_cm3: number;
  material_grams: number;
  print_time_minutes: number;
  /** Everything for the WHOLE job, quantity included. */
  total_time_minutes: number;

  cost_lines: CostLine[];
  cost_iqd: number;
  /** The point estimate: cost plus the target margin, floored and rounded. */
  price_iqd: number;
  price_low_iqd: number;
  price_high_iqd: number;
  /** What the floor would allow. Never above price_low_iqd. */
  floor_iqd: number;
  margin_percent: number;

  confidence: 'high' | 'medium' | 'low';
  confidence_reasons: string[];
  /** Per-part, so a customer can see what the quantity bought them. */
  unit_price_iqd: number;
}

const MIN = 1 / 60;

/**
 * The whole estimate.
 *
 * Never throws and never returns a number it cannot defend: an input it cannot
 * price comes back as `priced: false` with a reason, because the wizard has to
 * carry on and tell the customer what is missing.
 */
export function quotePrint(
  input: QuoteInput,
  materials: PrintMaterial[],
  cfg: PrintPricingConfig
): Quote {
  const material = materials.find((m) => m.id === input.materialId && m.active !== false);
  if (!material) return unpriced('MATERIAL_UNKNOWN', input.materialId);

  const quantity = Math.max(1, Math.floor(input.quantity || 1));
  const colors = Math.max(1, Math.floor(input.colors || 1));
  const a = input.analysis;
  const confidenceReasons: string[] = [];

  // ---- 1. how much plastic, and how long the machine is busy --------------
  const measured = !!a && a.measured && a.volume_mm3 > 0;
  let solidVolumeMm3: number;
  if (measured) {
    solidVolumeMm3 = a!.volume_mm3;
  } else if (input.fallback_volume_cm3 && input.fallback_volume_cm3 > 0) {
    solidVolumeMm3 = input.fallback_volume_cm3 * 1000;
    confidenceReasons.push('VOLUME_ESTIMATED_BY_CUSTOMER');
  } else {
    return unpriced('NO_GEOMETRY', input.materialId);
  }

  const heightMm = measured ? Math.max(a!.dimensions_mm.z, 0.1) : Math.cbrt(solidVolumeMm3);
  const areaMm2 = measured ? a!.surface_area_mm2 : 6 * Math.pow(solidVolumeMm3, 2 / 3);
  const overhangMm2 = measured && input.supports ? a!.overhang_area_mm2 : 0;
  const complexity = measured ? a!.complexity : 0.3;

  const layerMm = cfg.quality_layer_mm[input.quality] ?? cfg.quality_layer_mm.standard;
  const qualityTime = cfg.quality_time_multiplier[input.quality] ?? 1;

  // Support material: overhang area lifted from below, at slicer-typical
  // density. A heuristic, and named as one — the alternative is to slice the
  // model on the server, which is a different product.
  const supportVolumeMm3 =
    overhangMm2 * heightMm * cfg.support_height_ratio * cfg.support_density * material.support_factor;

  let printedMm3: number;
  let printMinutes: number;

  if (material.process === 'fdm') {
    // Walls first: the shell is printed solid whatever the infill says. Capped
    // at the solid volume, or a thin part would be quoted more plastic than it
    // physically contains.
    const wallThickness = cfg.wall_count * cfg.extrusion_width_mm;
    const shellMm3 = Math.min(areaMm2 * wallThickness, solidVolumeMm3);
    const infillMm3 = Math.max(solidVolumeMm3 - shellMm3, 0) * clamp(input.infill, 0, 1);
    const purgeMm3 = (colors - 1) * cfg.purge_mm3_per_color;
    printedMm3 = shellMm3 + infillMm3 + supportVolumeMm3 + purgeMm3;

    // Time follows the volume through the nozzle. Flow is the cross-section of
    // one extruded bead times the head speed; the efficiency factor is what
    // acceleration and travel take back.
    const speedMmS = 100; // the reference speed the flow efficiency is measured against
    const flowMm3S = Math.max(layerMm * cfg.extrusion_width_mm * speedMmS * cfg.flow_efficiency, 0.5);
    const extrudeSeconds = printedMm3 / flowMm3S;
    const layers = Math.max(1, Math.ceil(heightMm / layerMm));
    printMinutes = (extrudeSeconds + layers * cfg.layer_overhead_s) / 60;
    printMinutes *= qualityTime;
    if (colors > 1) printMinutes *= cfg.multicolor_time_multiplier;
  } else {
    // MSLA. The vat cures a whole layer at once, so the volume of the part
    // hardly touches the clock — the HEIGHT does. A tall thin tower and a full
    // plate of the same height take the same time, which is why a resin shop
    // batches and an FDM shop does not.
    printedMm3 = solidVolumeMm3 + supportVolumeMm3;
    const layers = Math.max(1, Math.ceil(heightMm / layerMm));
    printMinutes = (layers * (cfg.resin_layer_exposure_s + cfg.resin_lift_s)) / 60;
    printMinutes *= qualityTime;
    printMinutes += cfg.resin_post_minutes;
  }

  // A convoluted model is slower than its volume suggests: more retractions,
  // more direction changes, more of the head not extruding.
  printMinutes *= 1 + (complexity * cfg.complexity_uplift_percent) / 100;

  const printedCm3 = printedMm3 / 1000;
  const gramsPerPart = printedCm3 * material.density_g_cm3;
  const grams = gramsPerPart * quantity;

  // ---- 2. the machine time for the whole job ------------------------------
  // FDM prints parts one after another; resin cures a plate at once, so a
  // second copy is nearly free until the plate fills. Modelled as a sublinear
  // exponent rather than a flat multiply.
  const batchExponent = material.process === 'resin' ? 0.35 : 1;
  const jobPrintMinutes = printMinutes * Math.pow(quantity, batchExponent);

  const setupMinutes = cfg.setup_minutes + (colors > 1 ? cfg.multicolor_setup_minutes : 0);
  const handlingMinutes = cfg.handling_minutes_per_part * quantity;
  const supportRemovalMinutes =
    input.supports && overhangMm2 > 0
      ? (overhangMm2 / 100) * cfg.support_removal_min_per_cm2 * quantity
      : 0;
  const postMinutes = Math.max(0, input.post_processing_minutes || 0) * quantity;

  // ---- 3. the money -------------------------------------------------------
  const machineHourIqd =
    input.machine_hour_iqd && input.machine_hour_iqd > 0
      ? input.machine_hour_iqd
      : cfg.machine_hour_iqd[material.process];

  const materialIqd = (grams / 1000) * material.price_iqd_per_kg;
  // Waste is charged on the material, not on the whole job: a spool ends, a
  // first layer fails, a purge tower is thrown away.
  const wasteIqd = materialIqd * material.waste_factor;
  const supportShare = printedMm3 > 0 ? supportVolumeMm3 / printedMm3 : 0;
  const supportMaterialIqd = materialIqd * supportShare;
  const purgeIqd =
    material.process === 'fdm' && colors > 1
      ? (((colors - 1) * cfg.purge_mm3_per_color) / 1000) * material.density_g_cm3 * (material.price_iqd_per_kg / 1000) * quantity
      : 0;

  const machineIqd = (jobPrintMinutes * MIN) * machineHourIqd;
  const energyIqd = (jobPrintMinutes * MIN) * (cfg.machine_watts[material.process] / 1000) * cfg.energy_iqd_per_kwh;
  const setupIqd = (setupMinutes * MIN) * cfg.labor_iqd_per_hour;
  const laborIqd = (handlingMinutes * MIN) * cfg.labor_iqd_per_hour;
  const supportRemovalIqd = (supportRemovalMinutes * MIN) * cfg.labor_iqd_per_hour;
  const postIqd = (postMinutes * MIN) * cfg.labor_iqd_per_hour;

  // Everything above is what one attempt costs. A share of attempts fail, and
  // the provision for that is a cost the merchant really carries — longer runs
  // and harder materials fail more, so it is not a flat percentage.
  const attemptIqd =
    materialIqd + wasteIqd + supportMaterialIqd + purgeIqd + machineIqd + energyIqd + setupIqd + laborIqd;
  const riskPercent = Math.min(
    cfg.failure_risk_max_percent,
    cfg.failure_risk_base_percent +
      jobPrintMinutes * MIN * cfg.failure_risk_per_hour_percent * (1 + material.difficulty)
  );
  const failureIqd = attemptIqd * (riskPercent / 100);

  const complexityIqd = attemptIqd * ((complexity * cfg.complexity_uplift_percent) / 100) * 0.5;

  const rawLines: CostLine[] = [
    { key: 'material', iqd: materialIqd - supportMaterialIqd },
    { key: 'support_material', iqd: supportMaterialIqd },
    { key: 'waste', iqd: wasteIqd },
    { key: 'purge', iqd: purgeIqd },
    { key: 'machine', iqd: machineIqd },
    { key: 'energy', iqd: energyIqd },
    { key: 'setup', iqd: setupIqd },
    { key: 'labor', iqd: laborIqd },
    { key: 'support_removal', iqd: supportRemovalIqd },
    { key: 'post_processing', iqd: postIqd },
    { key: 'failure_risk', iqd: failureIqd },
    { key: 'complexity', iqd: complexityIqd },
  ];
  const lines: CostLine[] = rawLines
    .filter((l) => l.iqd > 0.5)
    .map((l) => ({ key: l.key, iqd: Math.round(l.iqd) }));

  // Summed from the ROUNDED lines, so the breakdown the customer reads adds up
  // to the total they are quoted. A total computed separately would differ by a
  // few dinars and make the itemisation look wrong.
  const cost = lines.reduce((n, l) => n + l.iqd, 0);

  // ---- 4. cost -> price ---------------------------------------------------
  // Repeat parts share the setup, so the saving is real; it is capped because
  // the material and the machine hours never get cheaper.
  const discountPercent = Math.min(
    cfg.quantity_discount_cap_percent,
    Math.log2(quantity) * cfg.quantity_discount_percent
  );
  const withMargin = priceForMargin(cost, cfg.target_margin_percent) * (1 - discountPercent / 100);

  // THE FLOOR, AND WHAT IS LEFT OF IT.
  //
  // The price that yields exactly the minimum MARGIN is the part that always
  // applies: an estimate under it is an estimate no merchant can honour, and a
  // margin floor is not a minimum charge — it moves with the job's own cost.
  //
  // The two flat minimums beside it are now 0 in every seed, because the owner
  // ruled that no print job has a minimum («لا يوجد حد أدنى لأي طلب طباعة»).
  // They are still READ rather than deleted: both remain admin-editable, and
  // dropping them from this Math.max would mean a floor the owner typed into
  // the admin did nothing.
  const floor = Math.max(
    priceForMargin(cost, cfg.min_margin_percent),
    material.min_economic_iqd,
    cfg.min_job_iqd
  );

  const point = roundTo(Math.max(withMargin, floor), cfg.round_to_iqd);
  const spread = cfg.range_spread_percent / 100;
  const low = Math.max(roundTo(point * (1 - spread), cfg.round_to_iqd), roundTo(floor, cfg.round_to_iqd));
  const high = roundTo(Math.max(point * (1 + spread), low + cfg.round_to_iqd), cfg.round_to_iqd);

  // ---- 5. how much to trust it -------------------------------------------
  if (!measured) confidenceReasons.push('GEOMETRY_NOT_MEASURED');
  // An assumed unit is only a DOUBT when the assumption looks wrong. STL and OBJ
  // never declare a unit and are millimetres essentially always, so treating the
  // assumption itself as uncertainty would put every ordinary upload below the
  // top tier and make the confidence badge mean nothing. What earns the doubt is
  // a resulting size no one prints: metres or inches read as millimetres.
  if (
    measured &&
    a!.unit_source === 'assumed' &&
    a!.warnings.some((w) => w.code === 'VERY_LARGE' || w.code === 'VERY_SMALL')
  ) {
    confidenceReasons.push('UNIT_ASSUMED_AND_SIZE_IMPLAUSIBLE');
  }
  if (measured && a!.watertight === false) confidenceReasons.push('MESH_NOT_WATERTIGHT');
  if (measured && a!.watertight === null) confidenceReasons.push('TOPOLOGY_NOT_ANALYSED');
  if (measured && a!.shell_count !== null && a!.shell_count > 4) confidenceReasons.push('MANY_PARTS');
  if (input.post_processing_minutes > 0) confidenceReasons.push('POST_PROCESSING_ESTIMATED');
  if (colors > 1) confidenceReasons.push('MULTICOLOR');

  const confidence: Quote['confidence'] = !measured
    ? 'low'
    : confidenceReasons.some((r) => r === 'MESH_NOT_WATERTIGHT' || r === 'VOLUME_ESTIMATED_BY_CUSTOMER')
      ? 'low'
      : confidenceReasons.length === 0
        ? 'high'
        : confidenceReasons.length <= 2
          ? 'medium'
          : 'low';

  return {
    priced: true,
    process: material.process,
    material_id: material.id,
    printed_volume_cm3: round(printedCm3 * quantity, 2),
    material_grams: round(grams, 1),
    print_time_minutes: Math.round(printMinutes),
    total_time_minutes: Math.round(jobPrintMinutes + setupMinutes + handlingMinutes + supportRemovalMinutes + postMinutes),
    cost_lines: lines,
    cost_iqd: Math.round(cost),
    price_iqd: point,
    price_low_iqd: low,
    price_high_iqd: high,
    floor_iqd: roundTo(floor, cfg.round_to_iqd),
    margin_percent: point > 0 ? round(((point - cost) / point) * 100, 1) : 0,
    confidence,
    confidence_reasons: confidenceReasons,
    unit_price_iqd: Math.round(point / quantity),
  };
}

function unpriced(reason: string, materialId: string): Quote {
  return {
    priced: false,
    reason,
    process: 'fdm',
    material_id: materialId,
    printed_volume_cm3: 0,
    material_grams: 0,
    print_time_minutes: 0,
    total_time_minutes: 0,
    cost_lines: [],
    cost_iqd: 0,
    price_iqd: 0,
    price_low_iqd: 0,
    price_high_iqd: 0,
    floor_iqd: 0,
    margin_percent: 0,
    confidence: 'low',
    confidence_reasons: [reason],
    unit_price_iqd: 0,
  };
}

/**
 * The selling price at which `margin` percent of the money taken is profit.
 *
 * price = cost / (1 - margin). The obvious-looking cost x (1 + margin) is a
 * MARKUP, and it is the classic way a shop set to "20% minimum" quietly runs at
 * 16.7% — so the division is the whole point of this function existing.
 */
export function priceForMargin(cost: number, marginPercent: number): number {
  const m = clamp(marginPercent, 0, 95) / 100;
  return m <= 0 ? cost : cost / (1 - m);
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const round = (v: number, p: number) => {
  const m = 10 ** p;
  return Number.isFinite(v) ? Math.round(v * m) / m : 0;
};
const roundTo = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : Math.round(v));

// ------------------------------------------------------------- the vocabulary

/** Materials a merchant with these capabilities can actually run. Shared by the
 *  matching engine so "can print it" means the same thing in both places. */
export function materialsFor(
  materials: PrintMaterial[],
  caps: { processes: string[]; enclosed: boolean; hardened_nozzle: boolean }
): PrintMaterial[] {
  return materials.filter(
    (m) =>
      m.active !== false &&
      caps.processes.includes(m.process) &&
      (!m.needs_enclosure || caps.enclosed) &&
      (!m.abrasive || caps.hardened_nozzle)
  );
}
