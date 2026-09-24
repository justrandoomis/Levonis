/**
 * D1 ↔ the engine. The only place a row becomes a type the cost model accepts.
 *
 * It exists as its own layer for one reason: `cost.ts` is pure and must stay
 * pure, because that purity is what makes a stored quote reproducible (§30).
 * Everything that touches the database — and therefore the clock, the network
 * and whatever an admin changed this morning — lives here, and hands the engine
 * a frozen set of inputs.
 *
 * The other rule it enforces is the provenance hierarchy (§7): a merchant's
 * spool beats their material default, which beats the catalogue, which beats
 * the platform. That order is expressed once, here, so no route can accidentally
 * price a job at the catalogue rate for a merchant who bought cheaper.
 */

import {
  iqd,
  type AnalysisMaterial,
  type CostLine,
  type PrintAnalysis,
  type Provenance,
  type QuoteResult,
} from './model';
import type { MaterialPriceSources } from './cost';
import {
  MULTI_MATERIAL_DEFAULTS,
  type MerchantPrinterOverrides,
  type MultiMaterialKind,
  type PrinterModel,
} from './printers';

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const optNum = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';
const jsonArray = <T>(v: unknown, fallback: T[]): T[] => {
  try {
    const parsed = JSON.parse(str(v) || '[]');
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
};

const MULTI_MATERIAL_KINDS: ReadonlySet<string> = new Set(Object.keys(MULTI_MATERIAL_DEFAULTS));

/**
 * Seeded rows carry the COSTLIER multi-material reading until a human confirms
 * the machine (migration 0078's `multi_material_verified`). Reading an unknown
 * value as `none` — "this machine changes material for free" — is the one
 * mistake here that under-charges every multi-colour job, so an unrecognised
 * string falls back to the flushing architecture rather than to nothing.
 */
function readMultiMaterial(value: unknown): MultiMaterialKind {
  const raw = str(value);
  if (MULTI_MATERIAL_KINDS.has(raw)) return raw as MultiMaterialKind;
  return 'single_nozzle_changer';
}

/** The platform's conservative floor, used only when a model has no baseline of
 *  its own. Stated here rather than inside the engine so it is visibly a
 *  DEFAULT and shows up as `platform` in the quote. */
export const PLATFORM_BASELINE_SUCCESS_RATE = 0.9;

export function printerModelFromRow(row: Row): PrinterModel {
  return {
    id: str(row.id),
    manufacturer: str(row.manufacturer),
    model: str(row.model),
    generation: str(row.generation),
    technology: str(row.technology) === 'resin' ? 'resin' : 'fdm',
    buildMm: { x: num(row.build_x_mm), y: num(row.build_y_mm), z: num(row.build_z_mm) },
    nozzleSizesMm: jsonArray<number>(row.nozzle_sizes, [0.4]),
    defaultNozzleMm: num(row.default_nozzle_mm) || 0.4,
    toolheadCount: Math.max(1, num(row.toolhead_count)),
    independentToolheads: bool(row.independent_toolheads),
    maxSimultaneousMaterials: Math.max(1, num(row.max_simultaneous_materials)),
    multiMaterial: readMultiMaterial(row.multi_material),
    enclosed: bool(row.enclosed),
    heatedChamber: bool(row.heated_chamber),
    hardenedNozzleAvailable: bool(row.hardened_nozzle_available),
    materials: jsonArray<string>(row.materials, []),
    power: {
      idleWatts: num(row.idle_watts),
      bedHeatingWatts: num(row.bed_heating_watts),
      nozzleHeatingWatts: num(row.nozzle_heating_watts),
      printingWatts: num(row.printing_watts),
    },
    // NULL economics stay zero, which makes depreciation zero — honest, and
    // visible, rather than a made-up purchase price flowing into every quote.
    purchaseIqd: num(row.purchase_iqd),
    residualIqd: num(row.residual_iqd),
    usefulPrintHours: num(row.useful_print_hours),
    maintenanceIqdPerHour: num(row.maintenance_iqd_per_hour),
    baselineSuccessRate: optNum(row.baseline_success_rate) ?? PLATFORM_BASELINE_SUCCESS_RATE,
    // The geometry path's time model. Unlike the economics above, a missing
    // value here CANNOT stay zero: a flow of zero is an infinite print. These
    // are physical facts about a class of machine rather than a shop's private
    // numbers, so a conservative FDM baseline stands in — and 0078 seeds a real
    // figure for every model it ships.
    maxVolumetricFlowMm3PerS: optNum(row.max_volumetric_flow_mm3_s) ?? 8,
    sustainedFlowFraction: optNum(row.sustained_flow_fraction) ?? 0.55,
    layerOverheadSeconds: optNum(row.layer_overhead_seconds) ?? 1.5,
    warmupMinutes: optNum(row.warmup_minutes) ?? 5,
  };
}

export async function loadPrinterModels(db: D1Database, ids?: string[]): Promise<PrinterModel[]> {
  const stmt =
    ids && ids.length
      ? db
          .prepare(
            `SELECT * FROM printer_models WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order`
          )
          .bind(...ids)
      : db.prepare('SELECT * FROM printer_models WHERE active = 1 ORDER BY sort_order');
  const { results } = await stmt.all<Row>();
  return (results ?? []).map(printerModelFromRow);
}

/**
 * A merchant's machine: the canonical model, with only what they are allowed to
 * change layered on top (§46).
 *
 * The PHYSICAL fields deliberately keep coming from `printer_models` even
 * though `merchant_printers` has its own copies from 0045 — those copies are
 * what §24 calls the duplication to stop, and trusting them would let two
 * merchants disagree about whether a part fits the same machine.
 */
export interface MerchantPrinter {
  id: string;
  merchantId: string;
  name: string;
  active: boolean;
  availability: string;
  model: PrinterModel;
  overrides: MerchantPrinterOverrides;
  /** The material-changer actually FITTED, which may be less than the machine
   *  supports: a printer that can take an AMS and has not got one prints one
   *  colour today. */
  multiMaterial: MultiMaterialKind;
  toolheadCount: number;
  /** True when this row has no canonical model behind it — a legacy 0045
   *  printer nobody has linked yet. It can still be listed; it cannot be priced
   *  with confidence, and the UI says so rather than guessing a model. */
  unlinked: boolean;
}

/**
 * EVERY COLUMN THE JOIN SHARES WITH `merchant_printers` IS ALIASED (audit 03
 * §10 L). `p.*` and `m.build_x_mm` both produce a column named `build_x_mm`,
 * and a row object keeps only the LAST of two same-named columns — so for an
 * unlinked printer (every printer the dashboard has ever created, since
 * nothing writes `model_id`) the LEFT JOIN's NULLs overwrote the build volume
 * the merchant typed, `buildMm` read {0,0,0}, and the Costing tab refused a
 * 20 mm cube on a 300 mm machine as `build_volume`. The canonical dimensions
 * now arrive as `m_build_*_mm` and the merchant's own as `build_*_mm`.
 */
export async function loadMerchantPrinters(db: D1Database, merchantId: string): Promise<MerchantPrinter[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, m.id AS m_id, m.manufacturer, m.model AS m_model, m.generation, m.technology AS m_technology,
              m.build_x_mm AS m_build_x_mm, m.build_y_mm AS m_build_y_mm, m.build_z_mm AS m_build_z_mm,
              m.nozzle_sizes, m.default_nozzle_mm,
              m.toolhead_count AS m_toolhead_count, m.independent_toolheads, m.max_simultaneous_materials,
              m.multi_material AS m_multi_material, m.enclosed AS m_enclosed, m.heated_chamber,
              m.hardened_nozzle_available, m.materials AS m_materials,
              m.idle_watts, m.bed_heating_watts, m.nozzle_heating_watts, m.printing_watts,
              m.purchase_iqd AS m_purchase_iqd, m.residual_iqd AS m_residual_iqd,
              m.useful_print_hours AS m_useful_print_hours,
              m.maintenance_iqd_per_hour AS m_maintenance_iqd_per_hour, m.baseline_success_rate
         FROM merchant_printers p
         LEFT JOIN printer_models m ON m.id = p.model_id
        WHERE p.merchant_id = ? AND p.active = 1
        ORDER BY p.sort_order, p.created_at`
    )
    .bind(merchantId)
    .all<Row>();

  return (results ?? []).map((row) => {
    const linked = !!row.m_id;
    const model: PrinterModel = linked
      ? printerModelFromRow({
          id: row.m_id,
          manufacturer: row.manufacturer,
          model: row.m_model,
          generation: row.generation,
          technology: row.m_technology,
          build_x_mm: row.m_build_x_mm,
          build_y_mm: row.m_build_y_mm,
          build_z_mm: row.m_build_z_mm,
          nozzle_sizes: row.nozzle_sizes,
          default_nozzle_mm: row.default_nozzle_mm,
          toolhead_count: row.m_toolhead_count,
          independent_toolheads: row.independent_toolheads,
          max_simultaneous_materials: row.max_simultaneous_materials,
          multi_material: row.m_multi_material,
          enclosed: row.m_enclosed,
          heated_chamber: row.heated_chamber,
          hardened_nozzle_available: row.hardened_nozzle_available,
          materials: row.m_materials,
          idle_watts: row.idle_watts,
          bed_heating_watts: row.bed_heating_watts,
          nozzle_heating_watts: row.nozzle_heating_watts,
          printing_watts: row.printing_watts,
          purchase_iqd: row.m_purchase_iqd,
          residual_iqd: row.m_residual_iqd,
          useful_print_hours: row.m_useful_print_hours,
          maintenance_iqd_per_hour: row.m_maintenance_iqd_per_hour,
          baseline_success_rate: row.baseline_success_rate,
        })
      : // An unlinked legacy row still has the physical facts it was typed with
        // in 0045. Using them is better than refusing to show the printer at
        // all; `unlinked` is what tells the UI to stop short of a confident
        // price.
        printerModelFromRow({
          id: `legacy:${str(row.id)}`,
          manufacturer: row.brand,
          model: row.model,
          technology: row.technology,
          build_x_mm: row.build_x_mm,
          build_y_mm: row.build_y_mm,
          build_z_mm: row.build_z_mm,
          nozzle_sizes: JSON.stringify([num(row.nozzle_mm) || 0.4]),
          default_nozzle_mm: row.nozzle_mm,
          toolhead_count: 1,
          independent_toolheads: 0,
          max_simultaneous_materials: bool(row.multicolor) ? 4 : 1,
          multi_material: bool(row.multicolor) ? 'single_nozzle_changer' : 'none',
          enclosed: row.enclosed,
          hardened_nozzle_available: row.hardened_nozzle,
          materials: row.materials,
        });

    return {
      id: str(row.id),
      merchantId: str(row.merchant_id),
      name: str(row.name),
      active: bool(row.active),
      availability: str(row.availability) || 'available',
      model,
      overrides: {
        purchaseIqd: optNum(row.purchase_iqd),
        residualIqd: optNum(row.residual_iqd),
        usefulPrintHours: optNum(row.useful_print_hours),
        maintenanceIqdPerHour: optNum(row.maintenance_iqd_per_hour),
        electricityIqdPerKwh: optNum(row.electricity_iqd_per_kwh),
        laborIqdPerHour: optNum(row.labor_iqd_per_hour),
      },
      multiMaterial: row.multi_material ? readMultiMaterial(row.multi_material) : model.multiMaterial,
      toolheadCount: optNum(row.toolhead_count) ?? model.toolheadCount,
      unlinked: !linked,
    };
  });
}

// ------------------------------------------------------------ material prices

/**
 * WHAT A KILOGRAM COSTS THIS MERCHANT, and the ladder that decides it (§7).
 *
 * A spool's rate is what they PAID divided by what they bought — not the
 * remaining weight, which would make filament get more expensive as it is used.
 * A merchant with three spools of the same material gets the CHEAPEST, because
 * that is the one a sensible shop reaches for first.
 */
export async function loadMaterialPrices(
  db: D1Database,
  merchantId: string | null,
  materialIds: string[]
): Promise<MaterialPriceSources> {
  const sources: MaterialPriceSources = {};
  if (!materialIds.length) return sources;
  const placeholders = materialIds.map(() => '?').join(',');

  if (merchantId) {
    const { results } = await db
      .prepare(
        `SELECT id, material_id, purchase_iqd, original_grams
           FROM merchant_spools
          WHERE merchant_id = ? AND active = 1 AND original_grams > 0 AND purchase_iqd > 0
            AND material_id IN (${placeholders})`
      )
      .bind(merchantId, ...materialIds)
      .all<Row>();
    const spool: NonNullable<MaterialPriceSources['spool']> = {};
    for (const row of results ?? []) {
      const id = str(row.material_id);
      const perKg = (num(row.purchase_iqd) / num(row.original_grams)) * 1000;
      if (!(perKg > 0)) continue;
      const current = spool[id];
      if (!current || perKg < current.iqdPerKg) spool[id] = { iqdPerKg: perKg, spoolId: str(row.id) };
    }
    if (Object.keys(spool).length) sources.spool = spool;
  }

  // The catalogue rung: the shop's own filament PRODUCT, priced from its net
  // weight exactly as the old calculator did — that part of it was right, and
  // reusing it is what §32 means by not building a parallel system.
  const { results: mats } = await db
    .prepare(
      `SELECT m.id, m.material_type, m.default_iqd_per_kg, p.price_iqd, p.spec_fields
         FROM print_materials m
         LEFT JOIN products p ON p.id = m.product_id AND p.status = 'active'
        WHERE m.active = 1 AND m.id IN (${placeholders})`
    )
    .bind(...materialIds)
    .all<Row>();

  const catalogue: Record<string, number> = {};
  const platformByType: Record<string, number> = {};
  const wantedTypes = new Set<string>();
  for (const row of mats ?? []) {
    const id = str(row.id);
    const price = num(row.price_iqd);
    if (price > 0) {
      const grams = netWeightGrams(row.spec_fields);
      if (grams > 0) catalogue[id] = (price / grams) * 1000;
    }
    const type = str(row.material_type).trim().toUpperCase();
    if (type) wantedTypes.add(type);
    const fallback = optNum(row.default_iqd_per_kg);
    if (fallback && fallback > 0 && type) platformByType[type] = fallback;
  }

  // THE SHOP'S OWN FILAMENT, FOUND BY TYPE RATHER THAN BY A LINK NOBODY DRAWS.
  //
  // «لا يمكن تسعير هذه المادة» on PLA — the commonest filament there is — and
  // the reason was two systems looking for the same thing in two places.
  //
  // The rung above prices a material from the product it is SOLD as, through
  // `print_materials.product_id`. That column is written by nothing in this
  // application: migration 0078 seeds the nine materials without it, no admin
  // screen sets it, and `productDeletion` only ever clears it. So the rung is
  // unreachable in practice. The rung below it reads `default_iqd_per_kg`,
  // which 0078 deliberately leaves NULL — «a made-up filament price is exactly
  // the kind of number §53 forbids» — and which nothing writes either.
  //
  // Both are right to refuse to invent a number. But the shop is not silent
  // about what a kilo of PLA costs: it SELLS PLA, as a `materials`-family
  // product with a real price and a real net weight, and
  // `GET /api/products/print-calculator` has been reading exactly that since
  // before this engine existed. The engine simply could not see it.
  //
  // So it reads the same products, the same way, matched on the material TYPE
  // the product states rather than on a foreign key. Nothing is invented: a
  // shop that sells no PLA still cannot price PLA, and says so.
  //
  // IT LANDS ON THE `platform` RUNG ON PURPOSE, below the merchant's spool and
  // below a deliberately linked product. A type match is not this exact
  // material — «PLA» priced from whichever PLA the shop sells — and `platform`
  // is the provenance that makes `cost.ts` answer `estimated` with a ±12%
  // band rather than `exact` to the dinar.
  if (wantedTypes.size) {
    const { results: filaments } = await db
      .prepare(
        `SELECT price_iqd, spec_fields
           FROM products
          WHERE status = 'active' AND template_family = 'materials' AND price_iqd > 0
          LIMIT 500`
      )
      .all<Row>();
    for (const row of filaments ?? []) {
      const price = num(row.price_iqd);
      if (!(price > 0)) continue;
      const grams = netWeightGrams(row.spec_fields);
      if (!(grams > 0)) continue;
      const type = productMaterialType(row.spec_fields, wantedTypes);
      if (!type) continue;
      const perKg = (price / grams) * 1000;
      // The cheapest, for the same reason the spool rung takes the cheapest:
      // it is the one a sensible shop reaches for first.
      const current = platformByType[type];
      if (current === undefined || perKg < current) platformByType[type] = perKg;
    }
  }

  if (Object.keys(catalogue).length) sources.catalogue = catalogue;
  if (Object.keys(platformByType).length) sources.platformByType = platformByType;
  return sources;
}

/**
 * The material type a filament PRODUCT states, when it is one the engine knows.
 *
 * The field is free text on the `materials` template — shops write «PLA»,
 * «PLA Basic», «PETG HF», «pla». It is matched against the types the engine
 * actually holds, and only by EXACT equality of the first word.
 *
 * Exactness is the whole point. A prefix match would read «PLA-CF» as PLA and
 * price a carbon-filled, abrasive filament at plain PLA's rate — a real number
 * for the wrong material is worse than no number, which is the rule the rest of
 * this file is built on. First-word-only is what lets «PLA Basic» through while
 * «PLA-CF Basic» still resolves to PLA-CF and nothing else. «PLA+» matches
 * neither, and is left unpriced rather than assumed.
 */
export function productMaterialType(specFields: unknown, known: ReadonlySet<string>): string {
  let stated = '';
  try {
    const specs = JSON.parse(str(specFields) || '{}') as Record<string, unknown>;
    stated = str(specs.material_type) || str(specs.material);
  } catch {
    return '';
  }
  const normalised = stated.trim().toUpperCase();
  if (!normalised) return '';
  if (known.has(normalised)) return normalised;
  const first = normalised.split(/\s+/)[0] ?? '';
  return first && known.has(first) ? first : '';
}

/** The materials template stores net weight as a string: "1000", "1000 g",
 *  "1,000g". Anything that is not a positive number is refused rather than
 *  coerced, because a stray value here becomes a wrong price per gram. */
export function netWeightGrams(specFields: unknown): number {
  try {
    const specs = JSON.parse(str(specFields) || '{}') as Record<string, unknown>;
    const raw = str(specs.net_weight).replace(/[,\s]/g, '');
    const grams = Number(raw.replace(/[^0-9.]/g, ''));
    return Number.isFinite(grams) && grams > 0 ? grams : 0;
  } catch {
    return 0;
  }
}

/** Density per material, for the mm→grams conversion. Without it the slicer's
 *  measurement cannot be turned into a weight at all, so a material missing
 *  from the catalogue is reported rather than defaulted to PLA. */
export async function loadMaterialPhysics(
  db: D1Database,
  materialIds: string[]
): Promise<Record<string, { densityGPerCm3: number; diameterMm: number; materialType: string; needsEnclosure: boolean; abrasive: boolean }>> {
  if (!materialIds.length) return {};
  const { results } = await db
    .prepare(
      `SELECT id, material_type, density_g_cm3, diameter_mm, needs_enclosure, abrasive
         FROM print_materials WHERE id IN (${materialIds.map(() => '?').join(',')})`
    )
    .bind(...materialIds)
    .all<Row>();
  const out: Record<string, { densityGPerCm3: number; diameterMm: number; materialType: string; needsEnclosure: boolean; abrasive: boolean }> = {};
  for (const row of results ?? []) {
    out[str(row.id)] = {
      densityGPerCm3: num(row.density_g_cm3),
      diameterMm: num(row.diameter_mm) || 1.75,
      materialType: str(row.material_type),
      needsEnclosure: bool(row.needs_enclosure),
      abrasive: bool(row.abrasive),
    };
  }
  return out;
}

// -------------------------------------------------------------- calibration

export interface CalibrationScope {
  merchantId?: string | null;
  merchantPrinterId?: string | null;
  printerModelId?: string | null;
  materialId?: string | null;
}

export interface Calibration {
  samples: number;
  timeFactor?: number;
  materialFactor?: number;
  successRate?: number;
  averageFailureFraction?: number;
}

/**
 * The most specific calibration that exists, narrowest first.
 *
 * A merchant's own figure for THIS machine beats their figure for the model,
 * which beats the platform's roll-up. The engine then applies its own sample
 * threshold on top (`resolveFactor`), so a narrow row with two prints behind it
 * still does not move a price — which is the point of keeping `samples` on the
 * row rather than only a factor.
 */
export async function loadCalibration(db: D1Database, scope: CalibrationScope): Promise<Calibration> {
  const attempts: Array<[string, unknown[]]> = [];
  if (scope.merchantId && scope.merchantPrinterId) {
    attempts.push([
      'merchant_id = ? AND merchant_printer_id = ? AND COALESCE(material_id, \'\') = ?',
      [scope.merchantId, scope.merchantPrinterId, scope.materialId ?? ''],
    ]);
    attempts.push(['merchant_id = ? AND merchant_printer_id = ? AND material_id IS NULL', [scope.merchantId, scope.merchantPrinterId]]);
  }
  if (scope.merchantId && scope.printerModelId) {
    attempts.push([
      'merchant_id = ? AND printer_model_id = ? AND merchant_printer_id IS NULL',
      [scope.merchantId, scope.printerModelId],
    ]);
  }
  if (scope.printerModelId) {
    attempts.push(['merchant_id IS NULL AND printer_model_id = ?', [scope.printerModelId]]);
  }

  for (const [where, binds] of attempts) {
    const row = await db
      .prepare(`SELECT samples, time_factor, material_factor, success_rate, average_failure_fraction
                  FROM printer_calibration_stats WHERE ${where} LIMIT 1`)
      .bind(...binds)
      .first<Row>();
    if (row && num(row.samples) > 0) {
      return {
        samples: num(row.samples),
        timeFactor: optNum(row.time_factor),
        materialFactor: optNum(row.material_factor),
        successRate: optNum(row.success_rate),
        averageFailureFraction: optNum(row.average_failure_fraction),
      };
    }
  }
  return { samples: 0 };
}

// ----------------------------------------------------------- analysis storage

export interface AnalysisRecord {
  id: string;
  ownerId: string | null;
  fileKey: string;
  fileName: string;
  fileBytes: number;
  source: 'file' | 'image' | 'gcode';
  fingerprint: string;
  printerModelId: string | null;
  qualityId: string;
  strengthId: string;
  nozzleMm: number;
  supports: boolean;
  orientationKey: string;
  unmeasured: string[];
  refusal: string | null;
  expiresAt: string | null;
}

/**
 * The statements that turn the UPLOAD's shell row into a measured analysis.
 *
 * AN UPDATE, NOT A DELETE-AND-INSERT, and the difference was a real defect: the
 * insert rewrote only the columns this function knows about, so every column
 * the upload had already written and this one did not name was silently lost.
 * The first casualty was `guest_token_hash` — a guest uploaded a model,
 * analysed it, and was locked out of their own file by the very request that
 * measured it. An UPDATE cannot have that bug for a column it does not mention,
 * and it cannot grow it when a column is added later.
 *
 * Returned rather than executed so the caller can put them in ONE batch with
 * whatever else the request writes, which is how every other writer here
 * behaves: a half-written analysis would be quotable and wrong.
 */
export function analysisStatements(
  db: D1Database,
  record: AnalysisRecord,
  analysis: PrintAnalysis,
  nowIso: string,
  materialRowId: (index: number) => string
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE print_analyses SET
            file_sha256 = ?, source = ?, fingerprint = ?, printer_model_id = ?,
            slicer_version = ?, profile_revision = ?, quality_id = ?, strength_id = ?,
            nozzle_mm = ?, supports = ?, orientation_key = ?, provenance = ?,
            bbox_x_mm = ?, bbox_y_mm = ?, bbox_z_mm = ?, model_volume_mm3 = ?,
            part_count = ?, layer_count = ?, layer_height_mm = ?,
            print_minutes_per_plate = ?, preparation_minutes = ?,
            plate_count = ?, pieces_per_plate = ?, tool_changes = ?,
            unmeasured = ?, refusal = ?, state = ?, updated_at = ?
          WHERE id = ?`
      )
      .bind(
        analysis.fileSha256,
        record.source,
        record.fingerprint,
        record.printerModelId,
        analysis.slicerVersion,
        analysis.profileRevision,
        record.qualityId,
        record.strengthId,
        record.nozzleMm,
        record.supports ? 1 : 0,
        record.orientationKey,
        analysis.provenance,
        analysis.boundingBoxMm.x,
        analysis.boundingBoxMm.y,
        analysis.boundingBoxMm.z,
        analysis.modelVolumeMm3,
        analysis.partCount,
        analysis.layerCount,
        analysis.layerHeightMm,
        analysis.printMinutesPerPlate,
        analysis.preparationMinutes,
        analysis.plateCount,
        analysis.piecesPerPlate,
        analysis.toolChanges,
        JSON.stringify(record.unmeasured),
        record.refusal,
        record.refusal ? 'failed' : 'complete',
        nowIso,
        record.id
      ),
    // Re-analysing the same upload at different settings replaces its materials
    // rather than accumulating a second set beside the first.
    db.prepare('DELETE FROM print_analysis_materials WHERE analysis_id = ?').bind(record.id),
  ];

  analysis.materials.forEach((m, index) => {
    stmts.push(
      db
        .prepare(
          `INSERT INTO print_analysis_materials
             (id, analysis_id, slot, material_id, material_type, color_hex, model_grams,
              support_grams, support_interface_grams, purge_grams, prime_tower_grams,
              brim_raft_grams, other_waste_grams)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          materialRowId(index),
          record.id,
          m.slot,
          m.materialId || null,
          m.materialType,
          m.colorHex,
          m.modelGrams,
          m.supportGrams,
          m.supportInterfaceGrams,
          m.purgeGrams,
          m.primeTowerGrams,
          m.brimRaftGrams,
          m.otherWasteGrams
        )
    );
  });

  return stmts;
}

export async function loadAnalysis(
  db: D1Database,
  id: string
): Promise<{ record: Row; analysis: PrintAnalysis } | null> {
  const row = await db.prepare('SELECT * FROM print_analyses WHERE id = ?').bind(id).first<Row>();
  if (!row) return null;
  const { results } = await db
    .prepare('SELECT * FROM print_analysis_materials WHERE analysis_id = ? ORDER BY slot')
    .bind(id)
    .all<Row>();

  const materials: AnalysisMaterial[] = (results ?? []).map((m) => ({
    slot: num(m.slot),
    materialId: str(m.material_id),
    materialType: str(m.material_type),
    colorHex: str(m.color_hex),
    modelGrams: num(m.model_grams),
    supportGrams: num(m.support_grams),
    supportInterfaceGrams: num(m.support_interface_grams),
    purgeGrams: num(m.purge_grams),
    primeTowerGrams: num(m.prime_tower_grams),
    brimRaftGrams: num(m.brim_raft_grams),
    otherWasteGrams: num(m.other_waste_grams),
  }));

  return {
    record: row,
    analysis: {
      fileSha256: str(row.file_sha256),
      slicerVersion: str(row.slicer_version),
      profileRevision: str(row.profile_revision),
      provenance: (str(row.provenance) || 'measured') as Provenance,
      boundingBoxMm: { x: num(row.bbox_x_mm), y: num(row.bbox_y_mm), z: num(row.bbox_z_mm) },
      modelVolumeMm3: num(row.model_volume_mm3),
      partCount: Math.max(1, num(row.part_count)),
      layerCount: num(row.layer_count),
      layerHeightMm: num(row.layer_height_mm),
      printMinutesPerPlate: num(row.print_minutes_per_plate),
      preparationMinutes: num(row.preparation_minutes),
      plateCount: Math.max(1, num(row.plate_count)),
      piecesPerPlate: Math.max(1, num(row.pieces_per_plate)),
      materials,
      toolChanges: num(row.tool_changes),
    },
  };
}

/**
 * REUSE A CACHED ANALYSIS ONLY WHEN EVERY INPUT MATCHED (§36).
 *
 * The fingerprint already carries every setting that can change a measurement,
 * so matching on it is the whole test. Note what this does NOT do: it does not
 * filter by owner. The analysis is a property of the file and the settings, and
 * the ROUTE decides who may read it — mixing identity in here would defeat the
 * cache without adding any protection the route does not already provide.
 */
export async function findCachedAnalysis(db: D1Database, fingerprint: string, nowIso: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM print_analyses
        WHERE fingerprint = ? AND state = 'complete' AND refusal IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC LIMIT 1`
    )
    .bind(fingerprint, nowIso)
    .first<Row>();
  return row ? str(row.id) : null;
}

// -------------------------------------------------------------- quote storage

export function quoteStatements(
  db: D1Database,
  quote: {
    id: string;
    analysisId: string;
    merchantId: string | null;
    merchantPrinterId: string | null;
    printerModelId: string | null;
    requestId: string | null;
    quantity: number;
    snapshot: unknown;
  },
  result: QuoteResult,
  nowIso: string,
  componentRowId: (index: number) => string
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO print_quotes
           (id, analysis_id, merchant_id, merchant_printer_id, printer_model_id, engine_version,
            confidence, quantity, base_cost_iqd, failure_reserve_iqd, true_cost_iqd, price_iqd,
            profit_iqd, margin_percent, markup_percent, break_even_iqd, range_low_iqd, range_high_iqd,
            waste_grams, waste_percent, machine_hours, snapshot, state, request_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        quote.id,
        quote.analysisId,
        quote.merchantId,
        quote.merchantPrinterId,
        quote.printerModelId,
        result.engineVersion,
        result.confidence,
        quote.quantity,
        result.baseCostIqd,
        result.failureReserveIqd,
        result.trueExpectedCostIqd,
        result.recommendedPriceIqd,
        result.profitIqd,
        result.marginPercent,
        result.markupPercent,
        result.breakEvenIqd,
        result.rangeIqd.low,
        result.rangeIqd.high,
        result.wasteGrams,
        result.wastePercent,
        result.machineHours,
        // THE SNAPSHOT IS THE WHOLE POINT (§30). Without it the row records
        // what was charged; with it the row can be RECOMPUTED and explained
        // after the catalogue, the margins and the engine have all moved on.
        JSON.stringify(quote.snapshot ?? {}),
        'draft',
        quote.requestId,
        nowIso,
        nowIso
      ),
  ];

  result.lines.forEach((line: CostLine, index) => {
    stmts.push(
      db
        .prepare(
          `INSERT INTO print_quote_cost_components (id, quote_id, component, iqd, source, detail)
           VALUES (?,?,?,?,?,?)`
        )
        .bind(componentRowId(index), quote.id, line.component, iqd(line.iqd), line.from, line.detail ?? '')
    );
  });

  return stmts;
}
