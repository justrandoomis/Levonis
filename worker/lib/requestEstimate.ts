/**
 * THE REQUEST ESTIMATE — one job priced the v1 way, or a job of parts priced
 * part by part with an honest account of what the total covers (plan P1-05,
 * docs/DECISIONS.md row 267; Community V3 R10).
 *
 * Pure: no I/O, no clock. The routes (worker/routes/printRequests.ts) load the
 * catalogue, the pricing configuration and the stored analyses and pass them
 * in, exactly as they always did for `estimateFor`.
 *
 * ONE JOB, THE V1 WAY. A request of one part, one piece a set, in at most one
 * material is priced by `estimateFor` with the inputs of its v1 mirror — the
 * very call it always took, so its stored quote is byte for byte what a v1
 * request of the same facts stores (`pricesAsOneJob`).
 *
 * A JOB OF PARTS, PART BY PART (`estimateModel`). Each part is priced on its
 * own:
 *
 *   geometry   the stored analysis of the part's own measured file — never a
 *              body's, never another part's
 *   pieces     pieces per set × sets (`part.quantity × job.quantity`)
 *   colours    the colour entries of the part's material rows
 *   material   one material: that material; «لست متأكدًا»: the honest range
 *              across every material of its process (`estimateFor`); several
 *              materials in one part: a range across those materials, low
 *              confidence, still ONE part (never split behind the customer)
 *
 * The job's extras — the accessories, the post-processing minutes and a
 * volume the customer typed for a one-part job — are priced ONCE, on the first
 * part that can be priced. The totals are sums over the PRICED parts, and the
 * `coverage` block says exactly which parts those are and why the others are
 * not; `complete` is «every part is priced», and nothing else. A sum over
 * some parts is never the job's price: the matcher treats an incomplete
 * estimate as unknown, and the screens label it «مجموع القطع المسعّرة فقط».
 *
 * Setup and minimum costs are counted once per part: separate parts are
 * separate prints, so the sum is honest and can be higher than one plate.
 */
import {
  quotePrint,
  type PrintMaterial,
  type PrintPricingConfig,
  type PrintProcess,
  type PrintQuality,
  type Quote,
  type QuoteInput,
  type CostLine,
} from './printPricing';
import type { AccessorySelection, PrintAccessory } from './printAccessories';
import type { ModelAnalysis } from './modelGeometry';
import {
  ESTIMATE_REASON_CODES,
  type EstimateCoverage,
  type EstimatePart,
  type EstimateReasonCode,
  type EstimateUnpricedPart,
} from './printEstimate';
import type { ModelFile, ModelPart, ModelState } from './requestModel';
import type { RequestPublishRefusalCode } from '@levonis/contracts/requestModel';

// ------------------------------------------------------------ the v1 inputs

/**
 * «لست متأكدًا» (wizard v2, audit 03 G2). The old wizard auto-picked the first
 * FDM material, so a customer who did not care was matched only to PLA shops.
 * Now "not sure" is an answer: `process: 'unsure'` (or `process_unsure`) and
 * `material_id: 'unsure'` (or `material_unsure`). A CHOSEN material fixes the
 * process — a material is either FDM or resin — so an unsure process with a
 * known material is not unsure at all (`normalizeChoices` in the route).
 */
export interface Choices {
  processUnsure: boolean;
  materialUnsure: boolean;
}

export interface SpecBody {
  process: PrintProcess;
  material_id: string;
  quality: PrintQuality;
  infill_percent: number;
  supports: boolean;
  colors_count: number;
  post_processing_minutes: number;
  quantity: number;
  color_hex: string;
  color_name: string;
  /** «6× مغناطيس، 1× ليد» — the hardware the model calls for, per part. */
  accessories: AccessorySelection[];
}

export type RangedQuote = Quote & { range_basis?: 'materials' };
export type CoveredQuote = RangedQuote & { coverage?: EstimateCoverage };

/**
 * THE ESTIMATE, INCLUDING FOR A CUSTOMER WHO IS NOT SURE.
 *
 * With a material chosen it is `quotePrint`, unchanged. With the material (or
 * the process) left open, no material is assumed — the owner's rule is no
 * auto-PLA — so the job is priced with EVERY active material it could be made
 * in (of the chosen process, or of both) and the answer is the honest range:
 * the cheapest one's low end to the dearest one's high end, confidence low,
 * `range_basis: 'materials'`. Per-material facts that depend on the material
 * (grams, time) are zeroed rather than reported for a material nobody chose.
 */
export function estimateFor(
  spec: SpecBody,
  choices: Choices,
  base: Omit<QuoteInput, 'materialId'>,
  mats: PrintMaterial[],
  cfg: PrintPricingConfig
): RangedQuote {
  if (!choices.materialUnsure && !choices.processUnsure) {
    return quotePrint({ ...base, materialId: spec.material_id }, mats, cfg);
  }
  const candidates = mats.filter((m) => m.active !== false && (choices.processUnsure || m.process === spec.process));
  const quotes = candidates.map((m) => quotePrint({ ...base, materialId: m.id }, mats, cfg));
  const priced = quotes.filter((q) => q.priced);
  if (!priced.length) {
    return { ...(quotes[0] ?? quotePrint({ ...base, materialId: '' }, mats, cfg)), material_id: '' };
  }
  const low = priced.reduce((a, b) => (b.price_low_iqd < a.price_low_iqd ? b : a));
  const high = Math.max(...priced.map((q) => q.price_high_iqd));
  const mid = Math.round((low.price_low_iqd + high) / 2);
  return {
    ...low,
    process: choices.processUnsure ? low.process : spec.process,
    material_id: '',
    material_grams: 0,
    print_time_minutes: 0,
    total_time_minutes: 0,
    price_iqd: mid,
    price_low_iqd: low.price_low_iqd,
    price_high_iqd: high,
    unit_price_iqd: Math.round(mid / Math.max(1, spec.quantity)),
    confidence: 'low',
    confidence_reasons: [...new Set([...low.confidence_reasons, 'MATERIAL_NOT_CHOSEN'])],
    range_basis: 'materials',
  };
}

// -------------------------------------------------- what a publish refuses

const activeMaterial = (mats: ReadonlyArray<PrintMaterial>, id: string) => mats.find((m) => m.id === id && m.active !== false);

/**
 * WHY A PUBLISH REFUSES THIS PART, or null (D2). A part made in an FDM
 * material and a resin together cannot be printed as one part; a resin part
 * cures in one vat of one material; a material that left the catalogue
 * cannot be priced or matched. A chosen-but-empty material is «not chosen»,
 * not unknown. A part is resin by its chosen materials OR by the process the
 * customer named for it, so a resin part of two open material rows is refused
 * too: no workshop could ever make it (its open rows read as two colours).
 */
export function unsupportedPart(part: Pick<ModelPart, 'materials' | 'process' | 'process_unsure'>, mats: ReadonlyArray<PrintMaterial>): RequestPublishRefusalCode | null {
  const chosen = part.materials.filter((x) => !x.material_unsure && x.material_id);
  if (chosen.some((x) => !activeMaterial(mats, x.material_id))) return 'PART_MATERIAL_UNKNOWN';
  const processes = new Set(chosen.map((x) => activeMaterial(mats, x.material_id)!.process));
  if (processes.size > 1) return 'PART_PROCESS_MIXED';
  const resin = processes.has('resin') || (!part.process_unsure && part.process === 'resin');
  if (resin && part.materials.length > 1) return 'PART_RESIN_MULTI_MATERIAL';
  return null;
}

/** A job the v1 estimate prices as it always did: one part, one piece a set, one material at most. */
export function pricesAsOneJob(m: Pick<ModelState, 'parts'>): boolean {
  return m.parts.length === 1 && m.parts[0].materials.length <= 1 && m.parts[0].quantity === 1;
}

/**
 * THE MODEL FILES THE ESTIMATE DID NOT PRICE (R10): every model file of the
 * request that no part is measured from, an original (role `source`, Q5)
 * aside — it is never what the public job is priced on. For a v1 request
 * this is «the model files beside the primary one». Read, never stored.
 */
export function modelsUnpriced(
  m: Pick<ModelState, 'parts' | 'sources'>,
  files: ReadonlyArray<Pick<ModelFile, 'id' | 'kind'>>,
  extraPriced: ReadonlyArray<string> = []
): number {
  const measured = new Set([...m.parts.map((p) => p.measured_file_id).filter((x): x is string => !!x), ...extraPriced]);
  const originals = new Set(m.sources.filter((x) => x.role === 'source' && x.file_id).map((x) => String(x.file_id)));
  return files.filter((f) => f.kind === 'model' && !measured.has(f.id) && !originals.has(f.id)).length;
}

// --------------------------------------------------- a job, part by part

export interface ModelEstimateContext {
  mats: PrintMaterial[];
  cfg: PrintPricingConfig;
  quality: PrintQuality;
  /** 0..1 */
  infill: number;
  supports: boolean;
  /** The job's finishing minutes per piece — priced once, on the first priced part. */
  postProcessingMinutes: number;
  accessories: AccessorySelection[];
  accessoryCatalogue: readonly PrintAccessory[];
  /** A volume the customer typed — only for a one-part job. */
  volumeCm3?: number;
}

const REASONS = new Set<string>(ESTIMATE_REASON_CODES);
const known = (codes: ReadonlyArray<string>): EstimateReasonCode[] =>
  [...new Set(codes)].filter((c): c is EstimateReasonCode => REASONS.has(c));
const RANK: Record<'high' | 'medium' | 'low', number> = { high: 2, medium: 1, low: 0 };

const parseAnalysis = (raw: string | undefined): ModelAnalysis | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ModelAnalysis | null;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

/** One part's quote: one material, «not sure», or a range across the part's own materials. */
function partQuote(
  part: ModelPart,
  base: Omit<QuoteInput, 'materialId'>,
  mats: PrintMaterial[],
  cfg: PrintPricingConfig
): RangedQuote {
  const rows = part.materials;
  const chosen = [...new Set(rows.filter((x) => !x.material_unsure && x.material_id).map((x) => x.material_id))];
  const unsure = rows.length === 0 || rows.some((x) => x.material_unsure || !x.material_id);
  const process: PrintProcess | null = part.process_unsure || !part.process ? null : part.process;
  const spec = { process: process ?? 'fdm', material_id: chosen[0] ?? '', quantity: base.quantity } as SpecBody;
  if (rows.length <= 1) {
    return estimateFor(spec, { processUnsure: unsure && !process, materialUnsure: unsure }, base, mats, cfg);
  }
  // Several materials in one part: the range across them (and, for a row
  // left open, across every material of the part's process).
  const candidates = new Set(chosen);
  if (unsure) for (const m of mats) if (m.active !== false && (!process || m.process === process)) candidates.add(m.id);
  const quotes = [...candidates].map((id) => quotePrint({ ...base, materialId: id }, mats, cfg));
  const priced = quotes.filter((q) => q.priced);
  if (!priced.length) return { ...(quotes[0] ?? quotePrint({ ...base, materialId: '' }, mats, cfg)), material_id: '' };
  const low = priced.reduce((a, b) => (b.price_low_iqd < a.price_low_iqd ? b : a));
  const high = Math.max(...priced.map((q) => q.price_high_iqd));
  const mid = Math.round((low.price_low_iqd + high) / 2);
  return {
    ...low,
    material_id: '',
    material_grams: 0,
    print_time_minutes: 0,
    total_time_minutes: 0,
    price_iqd: mid,
    price_low_iqd: low.price_low_iqd,
    price_high_iqd: high,
    unit_price_iqd: Math.round(mid / Math.max(1, base.quantity)),
    confidence: 'low',
    confidence_reasons: [...new Set([...priced.flatMap((q) => q.confidence_reasons), ...(unsure ? ['MATERIAL_NOT_CHOSEN'] : [])])],
    range_basis: 'materials',
  };
}

function sumLines(quotes: Quote[]): CostLine[] {
  const by = new Map<string, CostLine>();
  for (const q of quotes) {
    for (const l of q.cost_lines) {
      const was = by.get(l.key);
      by.set(l.key, was ? { ...was, iqd: was.iqd + l.iqd } : { ...l });
    }
  }
  return [...by.values()];
}

/**
 * THE JOB OF PARTS, PRICED PART BY PART — the summed quote and its
 * `coverage`. A part a publish would refuse (`unsupportedPart`) is shown
 * unpriced with the code as its `refusal`; a draft and the live estimate keep
 * it.
 */
export function estimateModel(
  m: Pick<ModelState, 'parts' | 'job'>,
  files: ReadonlyArray<Pick<ModelFile, 'id' | 'analysis'>>,
  ctx: ModelEstimateContext
): CoveredQuote {
  const sets = Math.max(1, Math.floor(m.job.quantity || 1));
  const priced: Array<{ part: ModelPart; q: RangedQuote; pieces: number }> = [];
  const unpricedParts: EstimateUnpricedPart[] = [];
  let extrasPlaced = false;
  let firstUnpriced: RangedQuote | null = null;
  const parts = [...m.parts].sort((a, b) => a.position - b.position);
  for (const part of parts) {
    const pieces = Math.max(1, part.quantity) * sets;
    const refusal = unsupportedPart(part, ctx.mats);
    if (refusal) {
      unpricedParts.push({ part_id: part.id, position: part.position, reason: '', refusal });
      continue;
    }
    const file = part.measured_file_id ? files.find((f) => f.id === part.measured_file_id) : undefined;
    const colours = Math.max(1, part.materials.reduce((n, x) => n + x.colors.length, 0));
    const base = (withExtras: boolean): Omit<QuoteInput, 'materialId'> => ({
      analysis: parseAnalysis(file?.analysis),
      quality: ctx.quality,
      infill: ctx.infill,
      quantity: pieces,
      colors: colours,
      supports: ctx.supports,
      post_processing_minutes: withExtras ? ctx.postProcessingMinutes : 0,
      accessories: withExtras ? ctx.accessories : [],
      accessory_catalogue: ctx.accessoryCatalogue,
      fallback_volume_cm3: parts.length === 1 && ctx.volumeCm3 && ctx.volumeCm3 > 0 ? ctx.volumeCm3 : undefined,
    });
    let q = partQuote(part, base(!extrasPlaced), ctx.mats, ctx.cfg);
    if (q.priced && !extrasPlaced) extrasPlaced = true;
    else if (!q.priced && !extrasPlaced) q = partQuote(part, base(false), ctx.mats, ctx.cfg);
    if (q.priced) priced.push({ part, q, pieces });
    else {
      firstUnpriced = firstUnpriced ?? q;
      unpricedParts.push({ part_id: part.id, position: part.position, reason: known([q.reason ?? ''])[0] ?? 'NO_GEOMETRY' });
    }
  }

  const entries: EstimatePart[] = priced.map(({ part, q, pieces }) => ({
    part_id: part.id,
    position: part.position,
    pieces,
    price_iqd: q.price_iqd,
    price_low_iqd: q.price_low_iqd,
    price_high_iqd: q.price_high_iqd,
    confidence: q.confidence,
    reasons: q.confidence === 'high' ? [] : known(q.confidence_reasons),
    material_id: q.material_id,
    process: q.process,
    material_grams: q.material_grams,
    time_minutes: q.total_time_minutes,
    ...(q.range_basis ? { range_basis: q.range_basis } : {}),
  }));
  const coverage: EstimateCoverage = {
    parts_total: parts.length,
    complete: unpricedParts.length === 0 && priced.length === parts.length,
    priced_parts: entries,
    unpriced_parts: unpricedParts,
  };

  if (!priced.length) {
    const reason = unpricedParts.find((x) => x.reason)?.reason || 'NO_GEOMETRY';
    const empty = firstUnpriced ?? quotePrint({ ...base0(ctx, sets), materialId: '' }, ctx.mats, ctx.cfg);
    return {
      ...empty,
      priced: false,
      reason,
      material_id: '',
      confidence: 'low',
      confidence_reasons: [reason],
      coverage,
    };
  }

  const quotes = priced.map((x) => x.q);
  const first = quotes[0];
  const processes = new Set(quotes.map((q) => q.process));
  const materialsChosen = new Set(m.parts.flatMap((p) => p.materials).map((x) => (x.material_unsure ? '' : x.material_id)));
  const oneMaterial = materialsChosen.size === 1 && !materialsChosen.has('') && quotes.every((q) => !q.range_basis) ? first.material_id : '';
  const sum = (k: 'price_iqd' | 'price_low_iqd' | 'price_high_iqd' | 'cost_iqd' | 'floor_iqd' | 'printed_volume_cm3' | 'material_grams' | 'print_time_minutes' | 'total_time_minutes') =>
    quotes.reduce((n, q) => n + (Number(q[k]) || 0), 0);
  const price = sum('price_iqd');
  const cost = sum('cost_iqd');
  const worst = quotes.reduce((a, q) => (RANK[q.confidence] < RANK[a] ? q.confidence : a), 'high' as Quote['confidence']);
  const confidence: Quote['confidence'] = coverage.complete ? worst : 'low';
  const reasons = confidence === 'high' ? [] : [...new Set(quotes.flatMap((q) => q.confidence_reasons))];
  const extras = quotes.find((q) => q.accessory_lines.length || q.accessories_unknown.length) ?? first;
  return {
    priced: true,
    process: processes.size === 1 ? first.process : first.process,
    material_id: oneMaterial,
    printed_volume_cm3: Math.round(sum('printed_volume_cm3') * 100) / 100,
    material_grams: Math.round(sum('material_grams') * 10) / 10,
    print_time_minutes: Math.round(sum('print_time_minutes')),
    total_time_minutes: Math.round(sum('total_time_minutes')),
    cost_lines: sumLines(quotes),
    cost_iqd: cost,
    price_iqd: price,
    price_low_iqd: sum('price_low_iqd'),
    price_high_iqd: sum('price_high_iqd'),
    floor_iqd: sum('floor_iqd'),
    margin_percent: price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : 0,
    confidence,
    confidence_reasons: reasons,
    unit_price_iqd: Math.round(price / sets),
    accessory_lines: extras.accessory_lines,
    accessories_unknown: extras.accessories_unknown,
    ...(quotes.some((q) => q.range_basis === 'materials') ? { range_basis: 'materials' as const } : {}),
    coverage,
  };
}

function base0(ctx: ModelEstimateContext, quantity: number): Omit<QuoteInput, 'materialId'> {
  return {
    analysis: null,
    quality: ctx.quality,
    infill: ctx.infill,
    quantity,
    colors: 1,
    supports: ctx.supports,
    post_processing_minutes: 0,
    accessories: [],
    accessory_catalogue: ctx.accessoryCatalogue,
  };
}
