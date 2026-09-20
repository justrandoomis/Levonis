/**
 * THE PRINT QUOTE ENGINE'S DOOR.
 *
 * What this Worker does and does not do is the whole design (§4):
 *
 *   IT DOES NOT SLICE. `three-slicer` is a multi-megabyte WASM core that has
 *   already OOM'd an Android phone in this repo; it runs in the browser, in
 *   LEVO Studio, lazily. This module ORCHESTRATES — it authorises, stores the
 *   measurement, prices it, and freezes the result.
 *
 *   IT NEVER RE-DERIVES A MEASURED NUMBER. If the slicer said 347.6 g, nothing
 *   here says 320 (§2). What it does do is refuse a measurement that cannot be
 *   true, and record where every number came from.
 *
 * WHO SEES WHAT (§22). A customer is shown a price, a time and a material. A
 * merchant is shown their own economics. The two are DIFFERENT PAYLOADS built
 * by different functions, not one payload with a flag — `publicQuote` below
 * strips cost, margin and every component line, the same way
 * printRequests.ts:311 strips them from the composition quote. A breakdown that
 * reaches a customer is the platform's margin structure published.
 *
 * PRIVACY. A customer's STL is their intellectual property (§34). Bytes are
 * stored with `visibility: 'private'` and are NEVER served through `/files/*`:
 * that route's private branch is a hardcoded if/else over `receipts/` and
 * `chat/`, it participates in `caches.default` — which is shared across every
 * visitor in a colo — and its public predicate also skips the session lookup.
 * Adding a branch there would be three separate ways to leak a model. So reads
 * go through this module's own authorised handler, exactly as print-request
 * attachments already do in marketplace.ts.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, forbidden, int, notFound, oneOf, requireAuth, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { sha256Hex } from '../lib/crypto';
import { classifyAttachment } from '../lib/attachments';
import { buildMediaKey, getMediaObject, putMediaObject } from '../lib/mediaStorage';
import { storeForUser } from '../lib/merchantAuth';
import { priceJob, type LaborTask, type PricingInputs } from '../lib/printQuote/cost';
import {
  PRICING_ENGINE_VERSION,
  materialTotalGrams,
  materialWasteGrams,
  sourced,
  type AnalysisMaterial,
  type PrintAnalysis,
  type QuoteResult,
} from '../lib/printQuote/model';
import {
  MULTI_MATERIAL_DEFAULTS,
  machineIqdPerHour,
  printerEligibility,
  resolveFactor,
  resolveSuccessRate,
  type PrinterModel,
} from '../lib/printQuote/printers';
import { analyseModel } from '../lib/modelGeometry';
import { analysisFromGeometry } from '../lib/printQuote/geometryAdapter';
import {
  analysisFingerprint,
  analysisFromStats,
  attributeSupport,
  type SlicerStatsInput,
  type ToolAssignment,
} from '../lib/printQuote/slicerAdapter';
import {
  analysisStatements,
  findCachedAnalysis,
  loadAnalysis,
  loadCalibration,
  loadMaterialPhysics,
  loadMaterialPrices,
  loadMerchantPrinters,
  loadPrinterModels,
  printerModelFromRow,
  quoteStatements,
  type MerchantPrinter,
} from '../lib/printQuote/repository';
// THE MINIMUM CHARGE LIVES IN THE OWNER'S OWN CONFIGURATION, not in this file
// and certainly not in a React component. `printPricingConfig` is the row the
// admin screen (src/components/adminCommunity/PrintPricingAdmin.tsx) already
// edits and `worker/routes/printRequests.ts` already prices against, so reading
// it here is what stops the calculator and the print-request wizard from
// disagreeing about the smallest job a shop will take.
import { getSetting } from '../lib/settings';
import { DEFAULT_PRICING } from '../lib/printPricing';

export const printQuoteRoutes = new Hono<AppContext>();

/** A model file is large; the cap is the same 40 MB the upload route allows a
 *  video, because a detailed 3MF genuinely reaches it. */
const MODEL_MAX_BYTES = 40 * 1024 * 1024;
/** A guest's analysis is temporary (§35). Long enough to finish deciding,
 *  short enough that an abandoned upload is not kept for ever. */
const GUEST_RETENTION_HOURS = 48;

/** The platform's own defaults, used only when nothing better exists and always
 *  reported as `platform` so the panel can say the figure is not the shop's. */
const PLATFORM_ELECTRICITY_IQD_PER_KWH = 120;
const PLATFORM_LABOR_IQD_PER_HOUR = 6_000;
const PLATFORM_TARGET_MARGIN_PERCENT = 35;

/**
 * THE OWNER'S MINIMUM JOB CHARGE — WHICH IS NOW ZERO, BY THEIR DECISION.
 *
 * «لا يوجد حد أدنى لأي طلب طباعة». `DEFAULT_PRICING.min_job_iqd` is 0 and so is
 * every seeded material's own floor, so a small part is now quoted at what it
 * costs plus the margin and nothing rounds it up to a figure nobody computed.
 *
 * The cost this floor used to stand in for is still CHARGED, and that is the
 * point the ruling turns on: setup, the spool change and the walk to the
 * machine really do cost the same whether the part weighs 2 g or 200 g, and
 * they reach the customer through `setup_minutes` and the labour rate like
 * every other real cost. What the owner removed was the SECOND, flat charge
 * stacked on top of them.
 *
 * So why does this function still exist? Because a decision is not the same as
 * a capability. The floor is an admin setting: the owner can type one back in
 * tomorrow without a deploy, and if this read were deleted the number they
 * typed would do nothing. It is fetched rather than imported for exactly that
 * reason — a floor that only moves on a deploy is not a setting.
 *
 * Why BOTH the file path and the grams path read it: a floor on one and not
 * the other is two pricing rules wearing one name. The customer who uploads a
 * tiny model and the customer who types its weight must be told the same
 * price, or whichever screen they happened to open decides what the shop
 * charges. That stays true at 0 and stays true at whatever the owner sets.
 */
async function platformMinimumJobIqd(db: D1Database): Promise<number> {
  try {
    const cfg = await getSetting(db, 'printPricingConfig');
    const value = Number((cfg as { min_job_iqd?: unknown } | null)?.min_job_iqd);
    if (Number.isFinite(value) && value >= 0) return value;
  } catch {
    // A settings row that will not parse must not take the quote down with it;
    // the seeded default is a real number the owner already agreed to.
  }
  return DEFAULT_PRICING.min_job_iqd;
}

/**
 * A guest needs to read back the analysis they just made, and they have no
 * account to prove it with. The client keeps a random token; the server keeps
 * only its HASH, so a leaked database row is not a key to anybody's model.
 * Same reasoning as `model_view_tokens`, which stores a SHA-256 and not the
 * token it was minted from.
 */
async function guestHash(token: string): Promise<string> {
  return sha256Hex(`print-analysis:${token}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The file's own hash — half of the cache fingerprint, and the only identity a
 *  model file has. `sha256Hex` in lib/crypto takes a STRING, so bytes get their
 *  own digest rather than being stringified into a different hash. */
async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- the catalogue

/**
 * The canonical printers. Public on purpose: a visitor choosing a machine for
 * an estimate needs to see what exists, and a build volume is not a secret.
 *
 * The ECONOMICS are not here. `purchase_iqd`, `maintenance_iqd_per_hour` and
 * the rest never leave the Worker for an anonymous caller — they are how a
 * shop's costs are computed, and §22 keeps them out of the customer view.
 */
printQuoteRoutes.get('/printers', async (c) => {
  const models = await loadPrinterModels(c.env.DB);
  return c.json({
    success: true,
    printers: models.map((m) => ({
      id: m.id,
      manufacturer: m.manufacturer,
      model: m.model,
      technology: m.technology,
      build_mm: m.buildMm,
      nozzle_sizes_mm: m.nozzleSizesMm,
      default_nozzle_mm: m.defaultNozzleMm,
      toolhead_count: m.toolheadCount,
      max_simultaneous_materials: m.maxSimultaneousMaterials,
      multi_material: m.multiMaterial,
      enclosed: m.enclosed,
      heated_chamber: m.heatedChamber,
      materials: m.materials,
      // What a comparison needs to explain itself, with no cost attached.
      change_seconds: MULTI_MATERIAL_DEFAULTS[m.multiMaterial].secondsPerChange,
      purge_mm3_per_change: MULTI_MATERIAL_DEFAULTS[m.multiMaterial].purgeMm3PerChange,
    })),
  });
});

printQuoteRoutes.get('/materials', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, material_type, name, name_ar, density_g_cm3, diameter_mm,
            needs_enclosure, abrasive, nozzle_temp_c, bed_temp_c
       FROM print_materials WHERE active = 1 ORDER BY material_type`
  ).all<Record<string, unknown>>();
  return c.json({ success: true, materials: results ?? [] });
});

// ------------------------------------------------------------------- the upload

/**
 * The model file itself. A guest may upload (§23) — the calculator is how
 * somebody finds out the shop exists, and demanding an account first is how
 * they find out somewhere else instead.
 */
printQuoteRoutes.post('/uploads', async (c) => {
  // First line, always: a rate limit after an expensive read has already paid
  // for the abuse it was meant to stop.
  await rateLimit(c, 'print-quote-upload', 20, 3600);
  const user = c.get('user');

  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');
  if (file.size > MODEL_MAX_BYTES) {
    throw badRequest(`File is too large (max ${Math.round(MODEL_MAX_BYTES / 1024 / 1024)} MB)`, 'FILE_TOO_LARGE');
  }
  if (file.size === 0) throw badRequest('The file is empty');

  const buf = new Uint8Array(await file.arrayBuffer());
  // Magic bytes and structure, never the declared MIME — the same classifier
  // the print-request attachments already go through, so a renamed .exe is
  // refused here for the same reason it is refused there.
  const kind = classifyAttachment(buf, file.name);
  if (!kind) throw badRequest('Unsupported file — upload an STL, 3MF, OBJ or STEP model', 'UNSUPPORTED_MODEL');
  if (kind.kind !== 'model' && kind.kind !== 'reference') {
    throw badRequest('That is not a 3D model or a reference picture', 'UNSUPPORTED_MODEL');
  }

  const guestToken = str(form.get('guest_token'), 'guest_token', { max: 80, required: false });
  if (!user && !guestToken) throw badRequest('A guest analysis needs a guest token', 'GUEST_TOKEN_REQUIRED');
  const guest = user ? null : await guestHash(guestToken);

  // `entityId` has to satisfy buildMediaKey's segment regex, and a guest hash
  // is hex, so both branches are safe without further escaping.
  const entityId = user ? user.id : `g${(guest ?? '').slice(0, 32)}`;
  const key = buildMediaKey({
    visibility: 'private',
    domain: 'print-requests',
    entityId,
    kind: 'models',
    extension: kind.ext,
    objectId: newId(),
  });

  await putMediaObject(
    c.env,
    {
      key,
      // PRIVATE, and the argument is what decides it — a key carries no
      // visibility of its own (mediaStorage deliberately keeps it out of the
      // path), so getting this wrong would put a customer's model in the
      // public bucket with nothing to complain.
      visibility: 'private',
      domain: 'print-requests',
      mime: kind.mime,
      bytes: buf.byteLength,
      ownerId: user?.id ?? null,
      entityId,
      originalName: file.name,
    },
    buf,
    { httpMetadata: { contentType: kind.mime, cacheControl: 'private, max-age=0, no-store' } }
  );

  const sha = await sha256Bytes(buf);
  const id = newId('pa');
  const expires = user
    ? null
    : new Date(Date.now() + GUEST_RETENTION_HOURS * 3600 * 1000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO print_analyses
       (id, owner_id, guest_token_hash, file_key, file_name, file_sha256, file_bytes,
        source, fingerprint, state, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'validating',?,?,?)`
  )
    .bind(
      id,
      user?.id ?? null,
      guest,
      key,
      file.name.slice(0, 200),
      sha,
      buf.byteLength,
      kind.kind === 'model' ? 'file' : 'image',
      '',
      expires,
      nowIso(),
      nowIso()
    )
    .run();

  return c.json(
    {
      success: true,
      analysis_id: id,
      file_sha256: sha,
      kind: kind.kind,
      extension: kind.ext,
      bytes: buf.byteLength,
      expires_at: expires,
    },
    201
  );
});

/** Owner, or the guest who holds the token this row was created with. Returns
 *  notFound rather than forbidden for a stranger, so the route cannot be used
 *  to discover which analysis ids exist — the same choice marketplace.ts makes
 *  for request files, and for the same reason. */
async function readableAnalysis(c: Context<AppContext>, id: string) {
  const loaded = await loadAnalysis(c.env.DB, id);
  if (!loaded) throw notFound('Analysis not found');
  const user = c.get('user');
  const ownerId = loaded.record.owner_id ? String(loaded.record.owner_id) : null;

  if (ownerId && user && user.id === ownerId) return loaded;
  if (user && user.role === 'admin') return loaded;

  if (!ownerId) {
    const token = c.req.header('X-Guest-Token') ?? '';
    if (token) {
      const hash = await guestHash(token);
      if (hash === String(loaded.record.guest_token_hash ?? '')) return loaded;
    }
  }
  throw notFound('Analysis not found');
}

// ----------------------------------------------------------------- the analysis

/**
 * The slicer's measurement, arriving from the browser that produced it.
 *
 * WHAT THE SERVER CAN AND CANNOT VERIFY. It cannot re-slice — that is the whole
 * architecture — so it does what the existing print-request flow does: it takes
 * the client's numbers as the SHAPE of the job and refuses the ones that cannot
 * be true. A negative gram count, a print that takes no time, a part larger than
 * the machine it claims to have been sliced for: all refused here.
 *
 * What it does NOT do is let that measurement become a binding price on its
 * own. A customer's figure produces a customer ESTIMATE; a merchant's offer is
 * priced against the merchant's own machine and spools, by a merchant who is
 * looking at the model. That split is why a doctored payload buys nothing.
 */
/**
 * MEASURE IT HERE, ON THE SERVER. The route the customer flow actually uses.
 *
 * WHY NOT THE SLICER. Two invariants meet at this endpoint and both point the
 * same way. §4 forbids a native slicer inside a Worker. And the store bundle
 * carries zero slicer payload and never embeds LEVO Studio
 * (docs/STUDIO_PLAN.md decision 6, pinned by tests/store-isolation.test.ts) —
 * for a PRICING reason stated in that test: "a number the customer's machine
 * computed is a number the customer could change, and this one decides money."
 *
 * So the geometry is measured from the stored bytes by the same
 * `analyseModel` the print-request flow already trusts. Volume, surface area,
 * bounding box and overhang area are exact integrals over the real triangles.
 * Turning that solid into extrusion and minutes is a stated physical model
 * (`geometryAdapter.ts`), which is why everything this route produces is
 * `platform` provenance, comes back as a RANGE, and is replaced wholesale the
 * moment a merchant's real slice arrives for the same file and profile.
 *
 * Nothing in the request body can change a measured number: the printer, the
 * quality and the strength choose the PROFILE, and the geometry comes from R2.
 */
printQuoteRoutes.post('/analyses/:id/measure', async (c) => {
  await rateLimit(c, 'print-quote-measure', 40, 3600);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const loaded = await readableAnalysis(c, id);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const printerModelId = str(body.printer_model_id, 'printer_model_id', { min: 1, max: 60 });
  const modelRow = await c.env.DB.prepare('SELECT * FROM printer_models WHERE id = ? AND active = 1')
    .bind(printerModelId)
    .first<Record<string, unknown>>();
  if (!modelRow) throw badRequest('Unknown printer', 'UNKNOWN_PRINTER');
  const printer = printerModelFromRow(modelRow);

  const materialId = str(body.material_id, 'material_id', { min: 1, max: 60 });
  const materialRow = await c.env.DB.prepare('SELECT * FROM print_materials WHERE id = ? AND active = 1')
    .bind(materialId)
    .first<Record<string, unknown>>();
  if (!materialRow) throw badRequest('Unknown material', 'UNKNOWN_MATERIAL');
  const density = Number(materialRow.density_g_cm3 ?? 0);
  // Without a density there is no mm³→gram conversion, and a default would be
  // a fabricated physical constant. Refuse instead (§53).
  if (!(density > 0)) throw badRequest('That material has no density on file', 'MATERIAL_NOT_WEIGHABLE');

  const qualityId = oneOf(body.quality_id ?? 'standard', 'quality_id', ['draft', 'standard', 'fine'] as const);
  const strengthId = oneOf(body.strength_id ?? 'standard', 'strength_id', ['light', 'standard', 'strong'] as const);
  const nozzleMm = Number(body.nozzle_mm) || printer.defaultNozzleMm;
  const supports = body.supports !== false;
  const quantity = int(body.quantity ?? 1, 'quantity', { min: 1, max: 999 });

  const fileKey = String(loaded.record.file_key ?? '');
  if (!fileKey) throw badRequest('This upload has no stored file', 'NO_FILE');
  const object = await getMediaObject(c.env, 'private', fileKey);
  if (!object) throw notFound('The uploaded model is no longer stored');
  const bytes = new Uint8Array(await object.arrayBuffer());

  const geometry = analyseModel(bytes, String(loaded.record.file_name ?? ''));
  const built = analysisFromGeometry({
    geometry,
    printer,
    fileSha256: String(loaded.record.file_sha256 ?? ''),
    material: {
      materialId,
      materialType: String(materialRow.material_type ?? ''),
      colorHex: str(body.color_hex, 'color_hex', { max: 9, required: false }) || '#D9D9D9',
      densityGPerCm3: density,
    },
    qualityId,
    strengthId,
    supports,
    nozzleMm,
    quantity,
  });

  if (built.refusal) {
    await c.env.DB.prepare(`UPDATE print_analyses SET state = 'failed', refusal = ?, updated_at = ? WHERE id = ?`)
      .bind(built.refusal.code, nowIso(), id)
      .run();
    throw badRequest(`The model could not be measured (${built.refusal.code})`, built.refusal.code, {
      reasons: built.refusal.detail ?? {},
    });
  }

  const analysis = built.analysis;
  const fingerprint = analysisFingerprint({
    fileSha256: analysis.fileSha256,
    printerModelId,
    profileRevision: analysis.profileRevision,
    slicerVersion: analysis.slicerVersion,
    qualityId,
    strengthId,
    nozzleMm,
    supports,
    materialIds: [materialId],
    orientationKey: `qty:${quantity}`,
  });

  const stmts = analysisStatements(
    c.env.DB,
    {
      id,
      ownerId: loaded.record.owner_id ? String(loaded.record.owner_id) : null,
      fileKey,
      fileName: String(loaded.record.file_name ?? ''),
      fileBytes: Number(loaded.record.file_bytes ?? 0),
      source: 'file',
      fingerprint,
      printerModelId,
      qualityId,
      strengthId,
      nozzleMm,
      supports,
      orientationKey: `qty:${quantity}`,
      unmeasured: built.unmeasured,
      refusal: null,
      expiresAt: loaded.record.expires_at ? String(loaded.record.expires_at) : null,
    },
    analysis,
    nowIso(),
    () => newId('pam')
  );
  await c.env.DB.batch(stmts);

  return c.json({
    success: true,
    analysis_id: id,
    analysis: publicAnalysis(analysis, built.unmeasured),
    // The measured half, returned separately so the UI can show what is a FACT
    // about the file and what is the model's reading of it.
    geometry: {
      volume_mm3: geometry.volume_mm3,
      surface_area_mm2: geometry.surface_area_mm2,
      dimensions_mm: geometry.dimensions_mm,
      triangle_count: geometry.triangle_count,
      shell_count: geometry.shell_count,
      watertight: geometry.watertight,
      overhang_ratio: geometry.overhang_ratio,
      unit_source: geometry.unit_source,
      warnings: geometry.warnings,
    },
  });
});

printQuoteRoutes.post('/analyses/:id', async (c) => {
  await rateLimit(c, 'print-quote-analyze', 60, 3600);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const loaded = await readableAnalysis(c, id);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const printerModelId = str(body.printer_model_id, 'printer_model_id', { min: 1, max: 60 });
  const modelRow = await c.env.DB.prepare('SELECT * FROM printer_models WHERE id = ? AND active = 1')
    .bind(printerModelId)
    .first<Record<string, unknown>>();
  if (!modelRow) throw badRequest('Unknown printer', 'UNKNOWN_PRINTER');
  const printer = printerModelFromRow(modelRow);

  const stats = readStats(body.stats);
  const tools = await readTools(c.env.DB, body.tools);
  if (!tools.length) throw badRequest('tools: at least one material must be named', 'NO_TOOLS');

  const qualityId = oneOf(body.quality_id ?? 'standard', 'quality_id', ['draft', 'standard', 'fine'] as const);
  const strengthId = oneOf(body.strength_id ?? 'standard', 'strength_id', ['light', 'standard', 'strong'] as const);
  const nozzleMm = Number(body.nozzle_mm) || printer.defaultNozzleMm;
  const supports = body.supports !== false;
  const orientationKey = str(body.orientation_key, 'orientation_key', { max: 40, required: false }) || 'as-sliced';

  const bbox = readBox(body.bounding_box_mm);
  const built = analysisFromStats(stats, {
    fileSha256: String(loaded.record.file_sha256 ?? ''),
    slicerVersion: str(body.slicer_version, 'slicer_version', { max: 60, required: false }) || 'unknown',
    profileRevision: str(body.profile_revision, 'profile_revision', { max: 80, required: false }) || printerModelId,
    tools,
    boundingBoxMm: bbox,
    modelVolumeMm3: Math.max(0, Number(body.model_volume_mm3) || 0),
    partCount: int(body.part_count ?? 1, 'part_count', { min: 1, max: 999 }),
    layerHeightMm: Math.max(0, Number(body.layer_height_mm) || 0),
    plateCount: int(body.plate_count ?? 1, 'plate_count', { min: 1, max: 200 }),
    piecesPerPlate: int(body.pieces_per_plate ?? 1, 'pieces_per_plate', { min: 1, max: 999 }),
    preparationMinutes: Math.max(0, Number(body.preparation_minutes) || 0),
    toolChanges: int(body.tool_changes ?? 0, 'tool_changes', { min: 0, max: 100_000 }),
  });

  if (built.refusal) {
    await c.env.DB.prepare(
      `UPDATE print_analyses SET state = 'failed', refusal = ?, updated_at = ? WHERE id = ?`
    )
      .bind(built.refusal, nowIso(), id)
      .run();
    throw badRequest(`The model could not be analysed (${built.refusal})`, built.refusal.toUpperCase());
  }

  // THE ONE CHECK THE SERVER CAN GENUINELY MAKE: does the thing fit the machine
  // it claims to have been sliced on? A payload can lie about grams; it cannot
  // make a 300 mm part fit a 180 mm bed, and accepting that would produce a
  // quote for a job nobody can print.
  const eligibility = printerEligibility(printer, {
    boundingBoxMm: bbox,
    materialTypes: tools.map((t) => t.materialType),
    simultaneousMaterials: tools.length,
  });
  if (!eligibility.eligible) {
    throw badRequest(`This printer cannot take the job: ${eligibility.reasons.join(', ')}`, 'PRINTER_INELIGIBLE', {
      reasons: eligibility.reasons,
    });
  }

  let analysis: PrintAnalysis = built.analysis;
  // The optional second slice: supports off, and the DIFFERENCE is the support
  // (§8). Measured, not divided out of a time budget.
  const noSupport = body.no_support_stats;
  if (supports && noSupport && typeof noSupport === 'object') {
    const alt = readStats(noSupport);
    const attributed = attributeSupport(analysis, alt, tools);
    if (attributed.measured) analysis = attributed.analysis;
  }

  const fingerprint = analysisFingerprint({
    fileSha256: analysis.fileSha256,
    printerModelId,
    profileRevision: analysis.profileRevision,
    slicerVersion: analysis.slicerVersion,
    qualityId,
    strengthId,
    nozzleMm,
    supports,
    materialIds: tools.map((t) => t.materialId),
    orientationKey,
  });

  const stmts = analysisStatements(
    c.env.DB,
    {
      id,
      ownerId: loaded.record.owner_id ? String(loaded.record.owner_id) : null,
      fileKey: String(loaded.record.file_key ?? ''),
      fileName: String(loaded.record.file_name ?? ''),
      fileBytes: Number(loaded.record.file_bytes ?? 0),
      source: 'file',
      fingerprint,
      printerModelId,
      qualityId,
      strengthId,
      nozzleMm,
      supports,
      orientationKey,
      unmeasured: built.unmeasured,
      refusal: null,
      expiresAt: loaded.record.expires_at ? String(loaded.record.expires_at) : null,
    },
    analysis,
    nowIso(),
    () => newId('pam')
  );

  // One batch: the row and its materials land together or not at all, because a
  // half-written analysis would still be quotable.
  await c.env.DB.batch(stmts);

  return c.json({ success: true, analysis: publicAnalysis(analysis, built.unmeasured), analysis_id: id });
});

/**
 * "HAVE YOU ALREADY MEASURED THIS?" — asked BEFORE the browser slices (§36).
 *
 * This is where the cache actually pays: slicing a real model takes tens of
 * seconds of a phone's CPU, and the same file at the same settings produces the
 * same measurement however many people ask. The fingerprint carries every input
 * that can change a measurable output, so a hit is a genuine hit — the file
 * hash alone would not be, because the same file at a different layer height is
 * a different job.
 *
 * It answers with the MEASUREMENT only. Whether the caller may read the model
 * behind it is a separate question, answered separately by the file route — a
 * cached analysis is a fact about a file, not a key to it.
 */
printQuoteRoutes.post('/analyses/:id/lookup', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const loaded = await readableAnalysis(c, id);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const fingerprint = analysisFingerprint({
    fileSha256: String(loaded.record.file_sha256 ?? ''),
    printerModelId: str(body.printer_model_id, 'printer_model_id', { min: 1, max: 60 }),
    profileRevision: str(body.profile_revision, 'profile_revision', { max: 80, required: false }) || '',
    slicerVersion: str(body.slicer_version, 'slicer_version', { max: 60, required: false }) || 'unknown',
    qualityId: oneOf(body.quality_id ?? 'standard', 'quality_id', ['draft', 'standard', 'fine'] as const),
    strengthId: oneOf(body.strength_id ?? 'standard', 'strength_id', ['light', 'standard', 'strong'] as const),
    nozzleMm: Number(body.nozzle_mm) || 0.4,
    supports: body.supports !== false,
    materialIds: Array.isArray(body.material_ids) ? body.material_ids.map(String) : [],
    orientationKey: str(body.orientation_key, 'orientation_key', { max: 40, required: false }) || 'as-sliced',
  });

  const hitId = await findCachedAnalysis(c.env.DB, fingerprint, nowIso());
  if (!hitId) return c.json({ success: true, hit: false });

  const hit = await loadAnalysis(c.env.DB, hitId);
  if (!hit) return c.json({ success: true, hit: false });
  return c.json({
    success: true,
    hit: true,
    analysis_id: hitId,
    analysis: publicAnalysis(hit.analysis, safeJsonArray(hit.record.unmeasured)),
  });
});

printQuoteRoutes.get('/analyses/:id', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const loaded = await readableAnalysis(c, id);
  const unmeasured = safeJsonArray(loaded.record.unmeasured);
  return c.json({ success: true, analysis: publicAnalysis(loaded.analysis, unmeasured), analysis_id: id });
});

/**
 * The bytes back. Deliberately NOT through `/files/*` — see the file header.
 * `no-store` and an attachment disposition, because a customer's model must
 * not sit in any cache, shared or otherwise.
 */
printQuoteRoutes.get('/analyses/:id/file', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const loaded = await readableAnalysis(c, id);
  const key = String(loaded.record.file_key ?? '');
  if (!key) throw notFound('File not found');
  const object = await getMediaObject(c.env, 'private', key);
  if (!object) throw notFound('File not found');

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${String(loaded.record.file_name ?? 'model').replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'private, max-age=0, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});

// -------------------------------------------------------------------- the quote

printQuoteRoutes.post('/analyses/:id/quote', async (c) => {
  await rateLimit(c, 'print-quote-price', 60, 3600);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const loaded = await readableAnalysis(c, id);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // QUANTITY BELONGS TO THE MEASUREMENT, NOT TO THE PRICE. How many copies are
  // wanted decides how they pack onto a plate, how many plates there are and
  // therefore how many warm-ups the job carries — none of which a multiplier
  // applied afterwards can recover. `PrintAnalysis` already describes the WHOLE
  // job (see model.ts), so pricing it is always one job. Changing the quantity
  // means measuring again, which is also the honest answer: 9 parts on a small
  // bed is a genuinely different job from 1.
  const quantity = 1;

  const user = c.get('user');
  // A merchant pricing their own job gets their own economics; everyone else
  // gets the platform's estimate. `storeForUser` returning null is the ordinary
  // case for a customer, not an error.
  const store = user ? await storeForUser(c.env.DB, user.id) : null;
  const merchantId = store?.merchant?.id ?? null;

  const printerModelId = loaded.record.printer_model_id ? String(loaded.record.printer_model_id) : '';
  const modelRow = printerModelId
    ? await c.env.DB.prepare('SELECT * FROM printer_models WHERE id = ?').bind(printerModelId).first<Record<string, unknown>>()
    : null;
  if (!modelRow) throw badRequest('This analysis has no printer to price against', 'NO_PRINTER');

  const priced = await priceForPrinter(c, {
    analysis: loaded.analysis,
    printer: printerModelFromRow(modelRow),
    merchantId,
    merchantPrinter: null,
    quantity,
    targetMarginPercent: Number(body.target_margin_percent) || PLATFORM_TARGET_MARGIN_PERCENT,
    minimumJobIqd: await platformMinimumJobIqd(c.env.DB),
  });

  const quoteId = newId('pq');
  await c.env.DB.batch(
    quoteStatements(
      c.env.DB,
      {
        id: quoteId,
        analysisId: id,
        merchantId,
        merchantPrinterId: null,
        printerModelId,
        requestId: null,
        quantity,
        snapshot: priced.snapshot,
      },
      priced.result,
      nowIso(),
      () => newId('pqc')
    )
  );

  return c.json({
    success: true,
    quote_id: quoteId,
    // TWO PAYLOADS, NOT ONE WITH A FLAG. The customer's shape physically cannot
    // carry a cost line, so no future edit can leak one by forgetting a check.
    quote: merchantId ? merchantQuote(priced.result) : publicQuote(priced.result),
  });
});

// ------------------------------------------------- the quote that has no file

/**
 * «عدد الغرامات… ليحسب السعر، أو من الملف» — a price from a WEIGHT.
 *
 * WHY THIS EXISTS. The calculator above is built on the idea that the file
 * answers everything, and for a customer holding an STL it does. But a shop's
 * real counter question is «شكد يطلع سعر مئة غرام PLA أسود؟», and today the only
 * way to ask it is to produce a model file you may not have. A customer who
 * already knows the mass should not have to invent a file to be told a price,
 * and sending them away to find one is how they find another shop instead.
 *
 * ONE PRICING FUNCTION, NOT TWO. Everything below builds a `PrintAnalysis` and
 * hands it to `priceForPrinter`, which is the SAME path `/analyses/:id/quote`
 * takes into the same `priceJob`. That is deliberate and it is the whole point
 * of the route: a second cost model would drift from the first, and the number
 * the customer was shown would stop being the number the shop charges. The
 * per-gram rate comes from `loadMaterialPrices` (spool → merchant → catalogue →
 * platform), the material correction from `loadCalibration`, the floor from
 * `platformMinimumJobIqd` — every one of them the same source the file path
 * reads, none of them typed into this file.
 *
 * WHAT A WEIGHT CANNOT SAY, AND WHY THE ANSWER SAYS SO.
 *
 * A file yields a print TIME; a gram count does not. Machine hours are a real
 * cost — depreciation, maintenance, electricity — and a quote that silently
 * leaves them out is not "a simpler quote", it is a wrong one. So the caller
 * either states an estimated print time, in which case the hours are priced
 * exactly as they are for a file, or states none, in which case the response
 * says in `covers` that machine time is EXCLUDED and the screen has to repeat
 * it. Nothing here guesses an hour count from a weight: grams and minutes are
 * independent (a 100 g solid cube and a 100 g lattice are hours apart), and a
 * fabricated figure is precisely what §53 forbids.
 *
 * NOTHING IS STORED. A weight is not a file: there is no upload to authorise,
 * no R2 object to keep private and nothing for a later merchant slice to
 * replace. Persisting it would mean an additive migration for a row that only
 * ever describes what somebody typed, so the answer is computed and returned.
 */

/** A fat-fingered "100000" is a spool and a half, not a print. */
const GRAMS_MAX_PER_ROW = 20_000;
const GRAMS_MAX_TOTAL = 50_000;
/** The owner said «بلون واحد أو أكثر» — more than one, not unlimited. Eight
 *  rows is past any real multi-colour job and keeps the `IN (…)` lookup far
 *  under D1's 100-parameter refusal. */
const GRAMS_MAX_ROWS = 8;
/** Two weeks of machine time. Past this the caller has mistyped, and an
 *  accepted mistype becomes a depreciation line in the millions. */
const GRAMS_MAX_PRINT_MINUTES = 20_160;

/** One line of the form: this much of this filament, in this colour. */
export interface GramsRow {
  materialId: string;
  materialType: string;
  colorHex: string;
  densityGPerCm3: number;
  grams: number;
}

/**
 * A stated weight, in the shape the cost engine prices.
 *
 * EVERY GRAM IS `modelGrams`. Support, purge and brim are left at zero and are
 * NOT silently folded into the customer's figure — the customer said how much
 * plastic the part is, not how much the machine will flush, and inventing a
 * waste fraction here would be a coefficient nobody can defend. That those
 * buckets are unknown rather than zero is what `covers.excluded` exists to say.
 *
 * `provenance: 'inferred'`, because the mass came from a person rather than
 * from a measurement. It is the lowest rung on the ladder in model.ts, so the
 * result can never come back `exact` and is always shown as a range.
 */
export function analysisFromGrams(input: {
  printer: PrinterModel;
  rows: GramsRow[];
  /** Minutes the caller estimates the machine will run. 0 = they did not say. */
  printMinutes: number;
}): PrintAnalysis {
  const printMinutes = Math.max(0, input.printMinutes);
  const materials: AnalysisMaterial[] = input.rows.map((r, index) => ({
    slot: index,
    materialId: r.materialId,
    materialType: r.materialType,
    colorHex: r.colorHex,
    modelGrams: r.grams,
    supportGrams: 0,
    supportInterfaceGrams: 0,
    purgeGrams: 0,
    primeTowerGrams: 0,
    brimRaftGrams: 0,
    otherWasteGrams: 0,
  }));

  return {
    // No file, so no hash and nothing to cache against — the fingerprint in
    // §36 identifies a FILE at a profile, and there is no file here.
    fileSha256: '',
    // Named for what produced it, the same way `levonis-geometry@1` is. A
    // stated weight and a measured mesh must never be indistinguishable in a
    // payload, a log or a screen.
    slicerVersion: 'levonis-grams@1',
    profileRevision: input.printer.id,
    provenance: 'inferred',
    // A weight has no shape. Zeros rather than a fabricated box: nothing in
    // the cost engine reads these, and a made-up bounding box would be a lie
    // that the eligibility check might one day believe.
    boundingBoxMm: { x: 0, y: 0, z: 0 },
    // Mass ÷ density IS the volume, so this one derived figure is physics
    // rather than a guess.
    modelVolumeMm3: input.rows.reduce(
      (sum, r) => sum + (r.densityGPerCm3 > 0 ? (r.grams / r.densityGPerCm3) * 1000 : 0),
      0
    ),
    partCount: 1,
    layerCount: 0,
    layerHeightMm: 0,
    printMinutesPerPlate: printMinutes,
    // Warm-up is a fact about the MACHINE, so it comes from the printer profile
    // — but only when there is a print to warm up for. With no stated time the
    // quote covers material and handling, and charging a bed heat-up inside a
    // "material only" answer would contradict what `covers` promises.
    preparationMinutes: printMinutes > 0 ? input.printer.warmupMinutes : 0,
    // The stated grams are the WHOLE job, the way `PrintAnalysis.materials`
    // requires. There is no per-piece figure here to multiply, which is why the
    // route leaves quantity at one exactly as the file routes do.
    plateCount: 1,
    piecesPerPlate: 1,
    materials,
    // Each extra filament beyond the first is a change the machine has to make.
    // It buys no purge grams here (nobody measured them) but it does tell the
    // engine that other tools sit warm and idle, which is a real watt.
    toolChanges: Math.max(0, input.rows.length - 1),
  };
}

/**
 * The form's rows, refused rather than repaired.
 *
 * A zero or a negative gram count is the failure this guards: `Number('')` is
 * 0 and `Number('-5')` is -5, and either one sailing through produces a
 * confident price for nothing at all. `resolveMaterialPrice` would price 0 g at
 * 0 IQD, the floor would lift it to the minimum job, and the customer would be
 * quoted 5,000 dinars for having typed nothing.
 */
async function readGramRows(db: D1Database, v: unknown): Promise<GramsRow[]> {
  if (!Array.isArray(v) || v.length === 0) {
    throw badRequest('Add at least one filament and the grams you need', 'NO_GRAM_ROWS');
  }
  if (v.length > GRAMS_MAX_ROWS) {
    throw badRequest(`A quote takes at most ${GRAMS_MAX_ROWS} filament rows`, 'TOO_MANY_GRAM_ROWS');
  }

  const wanted = v.map((x, index) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const materialId = str(o.material_id, `rows[${index}].material_id`, { min: 1, max: 60 });
    const grams = Number(o.grams);
    if (!Number.isFinite(grams) || grams <= 0) {
      throw badRequest(
        `rows[${index}]: the grams must be a number greater than zero`,
        'BAD_GRAMS',
        { row: index }
      );
    }
    if (grams > GRAMS_MAX_PER_ROW) {
      throw badRequest(
        `rows[${index}]: ${GRAMS_MAX_PER_ROW} g is more than one job — split it or ask a merchant directly`,
        'GRAMS_TOO_LARGE',
        { row: index }
      );
    }
    return {
      materialId,
      grams,
      colorHex: str(o.color_hex, `rows[${index}].color_hex`, { max: 9, required: false }) || '#D9D9D9',
    };
  });

  const total = wanted.reduce((sum, r) => sum + r.grams, 0);
  if (total > GRAMS_MAX_TOTAL) {
    throw badRequest(`${GRAMS_MAX_TOTAL} g in one quote is a production run, not a print`, 'GRAMS_TOO_LARGE');
  }

  // The DENSITY comes from the catalogue, never from the payload — the same
  // rule `readTools` states for the slicer path, for the same reason: letting a
  // request choose a density lets a request choose its own bill.
  const ids = [...new Set(wanted.map((r) => r.materialId))];
  const physics = await loadMaterialPhysics(db, ids);

  return wanted.map((r, index) => {
    const known = physics[r.materialId];
    if (!known) throw badRequest(`rows[${index}]: unknown material "${r.materialId}"`, 'UNKNOWN_MATERIAL', { row: index });
    if (!(known.densityGPerCm3 > 0)) {
      throw badRequest(`rows[${index}]: that material has no density on file`, 'MATERIAL_NOT_WEIGHABLE', { row: index });
    }
    return {
      materialId: r.materialId,
      materialType: known.materialType,
      colorHex: r.colorHex,
      densityGPerCm3: known.densityGPerCm3,
      grams: r.grams,
    };
  });
}

/**
 * WHAT THIS PRICE DOES AND DOES NOT COVER, as codes rather than sentences.
 *
 * Codes because the screen speaks three languages and an English sentence built
 * in a Worker can only ever be one of them. The customer-facing wording lives
 * in src/components/tools/, where `loc(ar, en, ckb)` can say it properly.
 *
 * This is the part of the response that keeps the quote honest. A grams quote
 * that showed a number and said nothing else would read as a full price, and
 * the customer would discover the machine hours when the merchant's real offer
 * arrived at twice the figure.
 */
function gramsCoverage(rows: GramsRow[], printMinutes: number) {
  const timed = printMinutes > 0;
  const included = ['MATERIAL', 'HANDLING_LABOUR', 'FAILURE_RESERVE'];
  const excluded: string[] = [];
  if (timed) included.push('MACHINE_TIME', 'ELECTRICITY');
  else excluded.push('MACHINE_TIME', 'ELECTRICITY');
  // Support is a property of a SHAPE. There is no shape here, so it is not
  // zero — it is unknown, and saying so is the whole of §8 applied to a form.
  excluded.push('SUPPORT_MATERIAL');
  if (rows.length > 1) excluded.push('PURGE_ON_COLOR_CHANGE');
  excluded.push('FINISHING', 'DELIVERY');
  return {
    /** True when the answer is a material bill and the customer must be told so. */
    material_only: !timed,
    included,
    excluded,
  };
}

/**
 * The route. Open to a guest for the same reason the upload is (§23) — this is
 * how somebody finds out the shop exists.
 */
printQuoteRoutes.post('/grams-quote', async (c) => {
  await rateLimit(c, 'print-quote-grams', 60, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const printerModelId = str(body.printer_model_id, 'printer_model_id', { min: 1, max: 60 });
  const modelRow = await c.env.DB.prepare('SELECT * FROM printer_models WHERE id = ? AND active = 1')
    .bind(printerModelId)
    .first<Record<string, unknown>>();
  if (!modelRow) throw badRequest('Unknown printer', 'UNKNOWN_PRINTER');
  const printer = printerModelFromRow(modelRow);

  const rows = await readGramRows(c.env.DB, body.rows);

  // Optional, and optional on purpose: a customer who knows their print time
  // gets the machine hours priced, and one who does not gets an answer that
  // says which half it is. What is NOT offered is a guess in between.
  const printMinutes =
    body.print_minutes === undefined || body.print_minutes === null || body.print_minutes === ''
      ? 0
      : int(body.print_minutes, 'print_minutes', { min: 0, max: GRAMS_MAX_PRINT_MINUTES });

  // A machine that cannot run the filament cannot quote it. The same rule the
  // file path applies through `printerEligibility`, applied to the one fact a
  // weight actually carries: which materials are on the plate. The bounding box
  // is a zero box on purpose — a weight has no shape, and a zero can never fail
  // the fit test, so the only thing this check can refuse is a real refusal:
  // ABS on an open frame, or four colours on a single-tool machine.
  const eligibility = printerEligibility(printer, {
    boundingBoxMm: { x: 0, y: 0, z: 0 },
    materialTypes: rows.map((r) => r.materialType),
    simultaneousMaterials: new Set(rows.map((r) => r.materialId)).size,
  });
  if (!eligibility.eligible) {
    throw badRequest(`This printer cannot take the job: ${eligibility.reasons.join(', ')}`, 'PRINTER_INELIGIBLE', {
      reasons: eligibility.reasons,
    });
  }

  const user = c.get('user');
  const store = user ? await storeForUser(c.env.DB, user.id) : null;
  const merchantId = store?.merchant?.id ?? null;

  const priced = await priceForPrinter(c, {
    analysis: analysisFromGrams({ printer, rows, printMinutes }),
    printer,
    merchantId,
    merchantPrinter: null,
    // The stated grams already describe the whole job, so there is nothing left
    // for a quantity to multiply — the same reading the file routes take.
    quantity: 1,
    targetMarginPercent: Number(body.target_margin_percent) || PLATFORM_TARGET_MARGIN_PERCENT,
    minimumJobIqd: await platformMinimumJobIqd(c.env.DB),
  });

  return c.json({
    success: true,
    // §22 again: the same two shapes, chosen the same way. A merchant asking
    // the counter question sees their own economics; a customer never does.
    quote: merchantId ? merchantQuote(priced.result) : publicQuote(priced.result),
    // Echoed so the screen can show the rows it priced without adding anything
    // up itself — a total computed in the browser is a total that can disagree
    // with the one the engine charged.
    rows: rows.map((r) => ({
      material_id: r.materialId,
      material_type: r.materialType,
      color_hex: r.colorHex,
      grams: Math.round(r.grams * 100) / 100,
    })),
    grams_total: Math.round(rows.reduce((sum, r) => sum + r.grams, 0) * 100) / 100,
    print_minutes: printMinutes,
    covers: gramsCoverage(rows, printMinutes),
  });
});

/**
 * EVERY MACHINE THIS SHOP OWNS, PRICED, WITH THE REASONS (§25, §41).
 *
 * Not one hidden score: each printer carries its own cost, time, waste and
 * margin, and an ineligible one is returned WITH the reasons it cannot take the
 * job rather than silently dropped — a missing printer is a question, and a
 * comparison table that answers it is the difference between a recommendation
 * and an oracle.
 */
printQuoteRoutes.post('/analyses/:id/compare', requireAuth, async (c) => {
  await rateLimit(c, 'print-quote-compare', 30, 3600);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const loaded = await readableAnalysis(c, id);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // Same rule as the quote route: the analysis already describes the whole job.
  const quantity = 1;

  const user = c.get('user')!;
  const store = await storeForUser(c.env.DB, user.id);
  if (!store) throw forbidden('Only a merchant can compare their own printers');
  const merchantId = store.merchant.id;

  const printers = await loadMerchantPrinters(c.env.DB, merchantId);
  // Read once for the whole comparison: the floor is a property of the shop's
  // settings, not of the machine, so re-reading it per printer would be the
  // same row fetched a dozen times for the same answer.
  const minimumJobIqd = await platformMinimumJobIqd(c.env.DB);
  const analysis = loaded.analysis;
  const materialTypes = analysis.materials.map((m) => m.materialType).filter(Boolean);

  const rows: Array<Record<string, unknown>> = [];
  for (const mp of printers) {
    const eligibility = printerEligibility(mp.model, {
      boundingBoxMm: analysis.boundingBoxMm,
      materialTypes,
      simultaneousMaterials: Math.max(1, analysis.materials.length),
    });
    if (!eligibility.eligible) {
      rows.push({
        merchant_printer_id: mp.id,
        name: mp.name,
        model: mp.model.model,
        eligible: false,
        reasons: eligibility.reasons,
        unlinked: mp.unlinked,
      });
      continue;
    }

    const priced = await priceForPrinter(c, {
      analysis,
      printer: { ...mp.model, multiMaterial: mp.multiMaterial, toolheadCount: mp.toolheadCount },
      merchantId,
      merchantPrinter: mp,
      quantity,
      targetMarginPercent: Number(body.target_margin_percent) || PLATFORM_TARGET_MARGIN_PERCENT,
      minimumJobIqd,
    });

    rows.push({
      merchant_printer_id: mp.id,
      name: mp.name,
      model: mp.model.model,
      eligible: true,
      unlinked: mp.unlinked,
      availability: mp.availability,
      ...merchantQuote(priced.result),
      // WHY, in facts rather than a score. §25 forbids a black box.
      because: {
        plates: analysis.plateCount,
        machine_hours: priced.result.machineHours,
        waste_grams: priced.result.wasteGrams,
        change_seconds: MULTI_MATERIAL_DEFAULTS[mp.multiMaterial].secondsPerChange,
        machine_iqd_per_hour: Math.round(
          mp.overrides.purchaseIqd !== undefined
            ? machineIqdPerHour({
                purchaseIqd: mp.overrides.purchaseIqd,
                residualIqd: mp.overrides.residualIqd ?? 0,
                usefulPrintHours: mp.overrides.usefulPrintHours ?? mp.model.usefulPrintHours,
              })
            : machineIqdPerHour(mp.model)
        ),
      },
    });
  }

  return c.json({ success: true, printers: rows });
});

// ------------------------------------------------------------------- internals

interface PriceForPrinterInput {
  analysis: PrintAnalysis;
  printer: PrinterModel;
  merchantId: string | null;
  merchantPrinter: MerchantPrinter | null;
  quantity: number;
  targetMarginPercent: number;
  /** The owner's configured floor, from `platformMinimumJobIqd`. Passed in
   *  rather than read here because this function touches no settings of its
   *  own and a comparison loop must not re-read the same row per printer. */
  minimumJobIqd: number;
}

/** Assembles the frozen input set and hands it to the pure engine. Everything
 *  that reads the database happens HERE; `priceJob` never sees a connection. */
async function priceForPrinter(
  c: Context<AppContext>,
  input: PriceForPrinterInput
): Promise<{ result: QuoteResult; snapshot: Record<string, unknown> }> {
  const materialIds = input.analysis.materials.map((m) => m.materialId).filter(Boolean);
  const materialPrices = await loadMaterialPrices(c.env.DB, input.merchantId, materialIds);

  const calibration = await loadCalibration(c.env.DB, {
    merchantId: input.merchantId,
    merchantPrinterId: input.merchantPrinter?.id ?? null,
    printerModelId: input.printer.id,
    materialId: materialIds[0] ?? null,
  });

  const overrides = input.merchantPrinter?.overrides ?? {};
  const electricity =
    overrides.electricityIqdPerKwh !== undefined
      ? sourced(overrides.electricityIqdPerKwh, 'merchant')
      : sourced(PLATFORM_ELECTRICITY_IQD_PER_KWH, 'platform');
  const labor =
    overrides.laborIqdPerHour !== undefined
      ? sourced(overrides.laborIqdPerHour, 'merchant')
      : sourced(PLATFORM_LABOR_IQD_PER_HOUR, 'platform');

  // §19: never charge for an operation nobody performs. Support removal is
  // offered only when there IS support to remove.
  const hasSupport = input.analysis.materials.some((m) => m.supportGrams + m.supportInterfaceGrams > 0);
  const laborTasks: LaborTask[] = [
    { id: 'prepare', minutes: 6 },
    { id: 'bed', minutes: 4, perPlate: true },
    ...(hasSupport ? [{ id: 'support_removal', minutes: 8 } as LaborTask] : []),
  ];

  const successRate = resolveSuccessRate(input.printer, {
    ...overrides,
    successRate: calibration.successRate,
    successRateSamples: calibration.samples,
  });

  const pricing: PricingInputs = {
    analysis: input.analysis,
    printer: input.printer,
    materialPrices,
    electricity,
    laborIqdPerHour: labor,
    machineIqdPerHourOverride:
      overrides.purchaseIqd !== undefined
        ? sourced(
            machineIqdPerHour({
              purchaseIqd: overrides.purchaseIqd,
              residualIqd: overrides.residualIqd ?? 0,
              usefulPrintHours: overrides.usefulPrintHours ?? input.printer.usefulPrintHours,
            }),
            'merchant'
          )
        : undefined,
    maintenanceIqdPerHourOverride:
      overrides.maintenanceIqdPerHour !== undefined
        ? sourced(overrides.maintenanceIqdPerHour, 'merchant')
        : undefined,
    laborTasks,
    risk: {
      successRate,
      averageFailureFraction: calibration.averageFailureFraction,
    },
    targetMarginPercent: input.targetMarginPercent,
    minimumJobIqd: input.minimumJobIqd,
    timeFactor: resolveFactor(calibration.timeFactor, calibration.samples),
    materialFactor: resolveFactor(calibration.materialFactor, calibration.samples),
    quantity: input.quantity,
  };

  const result = priceJob(pricing);

  // THE SNAPSHOT IS WHAT MAKES THE ROW REPRODUCIBLE (§30). Without it the quote
  // records what was charged; with it, it can be recomputed and explained after
  // the catalogue, the margins and the engine have all moved on.
  return {
    result,
    snapshot: {
      engine_version: PRICING_ENGINE_VERSION,
      printer: input.printer,
      material_prices: materialPrices,
      electricity,
      labor,
      labor_tasks: laborTasks,
      calibration,
      target_margin_percent: input.targetMarginPercent,
      // §30: the floor is an INPUT to the price, so a quote that was lifted to
      // it is only explainable afterwards if the row remembers what it was.
      minimum_job_iqd: input.minimumJobIqd,
      quantity: input.quantity,
      analysis: input.analysis,
    },
  };
}

/** What a customer may see: a price, a time, a material, a waste figure — and
 *  not one line of what it cost the shop (§22). */
function publicQuote(r: QuoteResult) {
  return {
    confidence: r.confidence,
    price_iqd: r.recommendedPriceIqd,
    range_iqd: r.rangeIqd,
    machine_hours: r.machineHours,
    waste_grams: r.wasteGrams,
    waste_percent: r.wastePercent,
    engine_version: r.engineVersion,
  };
}

/** What a merchant may see: all of it. */
function merchantQuote(r: QuoteResult) {
  return {
    confidence: r.confidence,
    lines: r.lines,
    base_cost_iqd: r.baseCostIqd,
    failure_reserve_iqd: r.failureReserveIqd,
    true_cost_iqd: r.trueExpectedCostIqd,
    price_iqd: r.recommendedPriceIqd,
    profit_iqd: r.profitIqd,
    margin_percent: r.marginPercent,
    markup_percent: r.markupPercent,
    break_even_iqd: r.breakEvenIqd,
    range_iqd: r.rangeIqd,
    waste_grams: r.wasteGrams,
    waste_percent: r.wastePercent,
    machine_hours: r.machineHours,
    engine_version: r.engineVersion,
  };
}

function publicAnalysis(a: PrintAnalysis, unmeasured: string[]) {
  return {
    bounding_box_mm: a.boundingBoxMm,
    model_volume_mm3: a.modelVolumeMm3,
    part_count: a.partCount,
    layer_count: a.layerCount,
    layer_height_mm: a.layerHeightMm,
    print_minutes_per_plate: a.printMinutesPerPlate,
    preparation_minutes: a.preparationMinutes,
    plate_count: a.plateCount,
    pieces_per_plate: a.piecesPerPlate,
    tool_changes: a.toolChanges,
    provenance: a.provenance,
    // NAMED, not a single "filament" figure: §8's whole point is that the
    // customer can see that a support-heavy orientation costs more plastic.
    // `grams` is the total of the named buckets, computed here rather than
    // left for three different screens to add up differently.
    materials: a.materials.map((m) => ({
      ...m,
      grams: Math.round(materialTotalGrams(m) * 100) / 100,
      wasteGrams: Math.round(materialWasteGrams(m) * 100) / 100,
    })),
    // WHICH ENGINE PRODUCED THIS. A geometric estimate and a real slice are not
    // interchangeable, and the UI has to be able to say which one it is holding
    // without inferring it from `provenance` alone.
    engine: a.slicerVersion,
    // The buckets this slice could not separate. A zero support line WITHOUT
    // this reads as "no support", which is a different and false claim.
    unmeasured,
  };
}

function safeJsonArray(v: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof v === 'string' ? v : '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function readBox(v: unknown): { x: number; y: number; z: number } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const n = (k: string) => Math.max(0, Number(o[k]) || 0);
  const box = { x: n('x'), y: n('y'), z: n('z') };
  if (!(box.x > 0 && box.y > 0 && box.z > 0)) {
    throw badRequest('bounding_box_mm: every dimension must be positive', 'BAD_BOUNDING_BOX');
  }
  return box;
}

/**
 * The slicer's own numbers, bounded. A payload cannot be re-sliced here, so
 * what this can do is refuse figures that cannot describe a real print: a
 * negative length, a job that takes no time, a layer count of zero.
 */
function readStats(v: unknown): SlicerStatsInput {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const n = (k: string) => {
    const value = Number(o[k]);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const arr = (k: string): number[] | undefined => {
    const raw = o[k];
    if (!Array.isArray(raw)) return undefined;
    return raw.map((x) => {
      const value = Number(x);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    });
  };
  return {
    filament_mm: n('filament_mm'),
    filament_mm_by_tool: arr('filament_mm_by_tool'),
    filament_mm_purge: o.filament_mm_purge === undefined ? undefined : n('filament_mm_purge'),
    filament_mm_purge_by_tool: arr('filament_mm_purge_by_tool'),
    time_estimate: n('time_estimate'),
    first_layer_time: n('first_layer_time'),
    layers: n('layers'),
    model_layers: n('model_layers'),
    raft_layers: n('raft_layers'),
    over_bed: o.over_bed === true,
    over_bed_model: o.over_bed_model === true,
    economy: o.economy === true,
    error: typeof o.error === 'string' && o.error ? o.error : undefined,
  };
}

/**
 * Which material each tool carried — the one thing the SLICER cannot know,
 * because it knows tool numbers. The density comes from the catalogue and not
 * from the client: without a real density the millimetres cannot become grams
 * at all, and letting a payload choose it would let a payload choose the bill.
 */
async function readTools(db: D1Database, v: unknown): Promise<ToolAssignment[]> {
  if (!Array.isArray(v)) return [];
  const wanted = v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .slice(0, 16);
  const ids = wanted.map((t) => String(t.material_id ?? '')).filter(Boolean);
  const physics = await loadMaterialPhysics(db, ids);

  const out: ToolAssignment[] = [];
  wanted.forEach((t, index) => {
    const materialId = String(t.material_id ?? '');
    const known = physics[materialId];
    if (!known || !(known.densityGPerCm3 > 0)) {
      throw badRequest(`tools[${index}]: unknown material "${materialId}"`, 'UNKNOWN_MATERIAL');
    }
    out.push({
      slot: Math.max(0, Math.floor(Number(t.slot) || index)),
      materialId,
      materialType: known.materialType,
      colorHex: String(t.color_hex ?? '').slice(0, 9),
      densityGPerCm3: known.densityGPerCm3,
      diameterMm: known.diameterMm,
    });
  });
  return out;
}
