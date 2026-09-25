import { Hono } from 'hono';
import type { AppContext, Env, SessionUser } from '../lib/types';
import { requireAuth, badRequest, notFound, conflict, str, int, HttpError } from '../lib/http';
import { newId, randomToken, sha256Hex } from '../lib/crypto';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { getSetting } from '../lib/settings';
import {
  MAX_ACCESSORY_QTY,
  type AccessorySelection,
  type PrintAccessory,
} from '../lib/printAccessories';
import { analyseModel, viewerMesh, FORMAT_CAPABILITIES, type ModelAnalysis } from '../lib/modelGeometry';
import {
  quotePrint,
  type PrintMaterial,
  type PrintPricingConfig,
  type PrintProcess,
  type PrintQuality,
  type QuoteInput,
} from '../lib/printPricing';
import { CAPABILITIES, requiredCapabilities } from '../lib/printMatching';
// Eligibility as data (W5-B): one verdict per workshop × revision, kept and re-matched.
import { matchRequest } from '../lib/printMatchingStore';
import {
  coarsePreviewMesh,
  fileReadStatement,
  fileReader,
  previewGrantFor,
  type FileReader,
  type PreviewGrant,
} from '../lib/requestFilePolicy';
import { resolveModelLink, parseModelLink } from '../lib/externalModels';
import { governorateName, normalizeGovernorate } from '../lib/iraqGovernorates';
import { getMediaObject, putMediaObject } from '../lib/mediaStorage';
import { communityClosedRefusal, communityMayEnter, readCommunityGate, requireCommunityOpen } from '../lib/communityGate';
import {
  isEngagedMerchant,
  isPast,
  offerCountStatement,
  onPublicBoard,
  staleOfferNotifications,
  type RequestForAccess,
} from '../lib/communityRequests';
import {
  DRAFT_TTL_DAYS,
  SOURCE_TYPES,
  bumpRevisionIfOfferedSql,
  canonicalFacts,
  effectiveMaterial,
  effectiveProcess,
  effectiveSourceType,
  factsFromRows,
  factsHash,
  parseDims,
  publicEstimate,
  readDims,
  readRevisionFiles,
  recordRevisionStatement,
  snapshotSpec,
  supersedeStatement,
  type Dims,
  type PricedFacts,
  type RevisionFile,
  type SourceType,
} from '../lib/requestRevisions';
import type { Quote } from '../lib/printPricing';

/**
 * THE PRINT REQUEST JOURNEY — upload, measure, estimate, publish, notify.
 *
 * The owner's architecture, in one line and obeyed literally:
 *
 *   ONE published request → Smart Matching finds eligible merchants → ONLY
 *   notifications are sent → the notification opens that same request → many
 *   merchants offer on it → the customer picks one.
 *
 * WHAT THAT RULES OUT, and what this file does instead:
 *
 *   - There is NO second request table and no per-merchant copy. The request is
 *     the ordinary `community_requests` row that worker/routes/marketplace.ts
 *     already creates, lists, guards and accepts offers on. Everything
 *     print-specific hangs off it by id in `community_print_requests`.
 *   - Publishing does not fan out work. It fans out MESSAGES: every eligible
 *     merchant gets one `user_notifications` row whose link is that same
 *     request. `community_request_matches` records the decision for every
 *     merchant considered — including the rejected ones and why — so "why did
 *     my shop never see this?" has an answer.
 *
 * MEASUREMENT HAPPENS HERE, NOT IN THE BROWSER. A number the customer's machine
 * produced is a number the customer can change, and this one becomes a price.
 * The Worker reads the object out of R2 and measures it itself; the browser is
 * shown the result.
 *
 * THE VIEWER NEVER GETS THE FILE. `/model-viewer/{token}` resolves to a derived,
 * decimated, origin-centred triangle soup with no filename, no material and no
 * metadata — so even a leaked link leaks a preview, not the customer's model.
 */

/**
 * WHAT WE KEEP ABOUT SOMEBODY ELSE'S PAGE, and nothing else.
 *
 * `source_meta` used to be stored as whatever object the browser sent:
 * `typeof body.source_meta === 'object'` and straight into D1. Every field in
 * it is read back and shown to a merchant, so "whatever the customer sent" was
 * the wrong contract for a blob that ends up on another person's screen.
 *
 * The keys are fixed here, and `image_url` is the one that needed a rule.
 *
 * THE OWNER'S DECISION ON THE COVER IMAGE: «البيانات فقط، والصورة بالرابط».
 * The picture is shown from the source's own URL and is never downloaded,
 * never re-hosted and never written to R2 — so nothing of theirs is copied,
 * nothing goes stale when they replace it, and the shop stores no bytes it
 * has no licence to. What that costs is that the URL is a LINK TO ANOTHER
 * HOST, which is why it must be an absolute https one: `http` would break the
 * page it is drawn on, and anything else is not a picture.
 *
 * Length is capped at the same 600 as `source_url` — a URL longer than that is
 * not a permalink, it is a payload.
 */
function sanitizeSourceMeta(input: unknown): Record<string, string | boolean> {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = (key: string, max: number): string => {
    const value = raw[key];
    return typeof value === 'string' ? value.slice(0, max) : '';
  };
  const image = typeof raw.image_url === 'string' ? raw.image_url.trim() : '';
  return {
    provider: text('provider', 60),
    external_id: text('external_id', 80),
    name: text('name', 300),
    creator: text('creator', 160),
    image_url: /^https:\/\//i.test(image) && image.length <= 600 ? image : '',
    resolved: raw.resolved === true,
  };
}

export const printRequestRoutes = new Hono<AppContext>();

// ------------------------------------------------------------------ helpers

const QUALITIES: PrintQuality[] = ['draft', 'standard', 'fine', 'ultra'];
const PROCESSES: PrintProcess[] = ['fdm', 'resin'];

async function pricingConfig(env: Env): Promise<PrintPricingConfig> {
  return getSetting(env.DB, 'printPricingConfig');
}
async function materials(env: Env): Promise<PrintMaterial[]> {
  const list = await getSetting(env.DB, 'printMaterials');
  return Array.isArray(list) && list.length ? list : [];
}
/** The hardware catalogue. Empty rather than seeded if the row is unreadable:
 *  a quote with no accessories is right, a quote with prices the owner never
 *  set is not. */
async function accessories(env: Env): Promise<PrintAccessory[]> {
  const list = await getSetting(env.DB, 'printAccessories');
  return Array.isArray(list) ? (list as PrintAccessory[]).filter((a) => a && a.active !== false) : [];
}

/**
 * What a CUSTOMER may know about a material.
 *
 * The buying price, the waste factor and the failure difficulty are the owner's
 * cost structure. They drive the estimate, and the estimate is shown — but the
 * inputs are not, because a competitor should not be able to read the shop's
 * margins off a public wizard.
 */
const publicMaterial = (m: PrintMaterial) => ({
  id: m.id,
  process: m.process,
  name_en: m.name_en,
  name_ar: m.name_ar,
  needs_enclosure: m.needs_enclosure,
  abrasive: m.abrasive,
});

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : (v as T);
  } catch {
    return fallback;
  }
};

/** The request row, for the owner of the request — nobody else gets it. */
async function ownedRequest(c: { env: Env }, requestId: string, userId: string) {
  const row = await c.env.DB.prepare(
    `SELECT * FROM community_requests WHERE id = ?`
  )
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Request not found');
  if (String(row.customer_id) !== userId) throw notFound('Request not found');
  return row;
}

// ------------------------------------------------------------- 1. the catalogue

/**
 * Everything the wizard needs to render its choices, in one call: the materials
 * it may offer, the quality tiers, the capability vocabulary and the file
 * formats with what each one can actually do for the customer.
 */
printRequestRoutes.get('/catalog', async (c) => {
  const [mats, cfg, accs] = await Promise.all([materials(c.env), pricingConfig(c.env), accessories(c.env)]);
  return c.json({
    success: true,
    materials: mats.filter((m) => m.active !== false).map(publicMaterial),
    processes: PROCESSES,
    qualities: QUALITIES.map((q) => ({ id: q, layer_mm: cfg.quality_layer_mm[q] })),
    capabilities: CAPABILITIES,
    formats: Object.entries(FORMAT_CAPABILITIES)
      .filter(([id]) => id !== 'unknown')
      .map(([id, cap]) => ({ id, ...cap })),
    // The wizard shows this so a customer knows what "more detail" buys them.
    min_job_iqd: cfg.min_job_iqd,
    /**
     * «إكسسوارات ميكر وورد». The buying price IS shown here, unlike
     * `publicMaterial`'s — and that is deliberate rather than an oversight.
     * A magnet is a part the customer could buy themselves for the same money;
     * what the shop sells is fitting it. Hiding the per-piece figure would
     * make a bill of materials unreadable and invite the question the whole
     * feature exists to answer.
     */
    accessories: accs.map((a) => ({
      id: a.id,
      name_ar: a.name_ar,
      name_en: a.name_en,
      name_ckb: a.name_ckb,
      unit: a.unit,
      category: a.category,
      cost_iqd: a.cost_iqd,
    })),
  });
});

// -------------------------------------------------------------- 2. measuring

/**
 * Measure one already-uploaded attachment.
 *
 * The file arrived through the marketplace's own upload route, which already
 * proved the caller owns the request and that the bytes are a model rather than
 * something renamed to look like one. This reads it back out of R2 and records
 * what it is — and caches the viewer mesh at the same time, because parsing a
 * 40MB model twice for the same never-changing file is waste.
 */
printRequestRoutes.post('/requests/:id/files/:fileId/analyze', requireAuth, async (c) => {
  await rateLimit(c, 'model-analyze', 60, 3600);
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const fileId = str(c.req.param('fileId'), 'fileId', { min: 1, max: 60 });
  await ownedRequest(c, requestId, user.id);

  const file = await c.env.DB.prepare(
    'SELECT id, file_key, file_name, kind, size_bytes, analysis FROM community_request_files WHERE id = ? AND request_id = ?'
  )
    .bind(fileId, requestId)
    .first<{ id: string; file_key: string; file_name: string; kind: string; size_bytes: number; analysis: string }>();
  if (!file) throw notFound('File not found');
  if (file.kind !== 'model') throw badRequest('That attachment is not a 3D model', 'NOT_A_MODEL');

  // Already measured: the bytes cannot change, so neither can the answer.
  if (file.analysis) {
    return c.json({ success: true, file_id: fileId, analysis: parseJson<ModelAnalysis | null>(file.analysis, null), cached: true });
  }

  const object = await getMediaObject(c.env, 'private', file.file_key);
  if (!object) throw notFound('The stored file is no longer available');
  const bytes = new Uint8Array(await object.arrayBuffer());

  const analysis = analyseModel(bytes, file.file_name);

  // The preview is derived once and stored beside the original under a prefix
  // `/files/*` refuses, so the viewer route never parses and never touches the
  // customer's file.
  let previewKey = '';
  if (analysis.capability.previewable) {
    const mesh = viewerMesh(bytes, file.file_name);
    if (mesh) {
      previewKey = `request-previews/${requestId}/${fileId}.lvm`;
      await putMediaObject(
        c.env,
        {
          key: previewKey,
          visibility: 'private',
          domain: 'print-requests',
          mime: 'application/octet-stream',
          bytes: mesh.byteLength,
          ownerId: user.id,
          entityId: requestId,
        },
        mesh,
        { httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, max-age=0' } }
      );
    }
  }

  await c.env.DB.prepare(
    `UPDATE community_request_files
        SET analysis = ?, model_format = ?, preview_key = ?,
            analysed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND request_id = ?`
  )
    .bind(JSON.stringify(analysis), analysis.format, previewKey, fileId, requestId)
    .run();

  return c.json({ success: true, file_id: fileId, analysis, cached: false });
});

// ------------------------------------------------------------ 3. an external link

/**
 * What a pasted link is, and whatever the provider's own API will tell us.
 *
 * Reads no HTML, ever. See worker/lib/externalModels.ts for why, and for what
 * happens when a provider has no configured endpoint: the link is still parsed
 * and still usable, the lookup simply reports that it did not happen.
 */
printRequestRoutes.post('/link', requireAuth, async (c) => {
  await rateLimit(c, 'model-link', 40, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = str(body.url, 'url', { min: 8, max: 600 });
  const providers = await getSetting(c.env.DB, 'printLinkProviders');
  const parsed = parseModelLink(url, providers);
  if (!parsed) throw badRequest('That does not look like a model link', 'BAD_URL');
  const info = await resolveModelLink(url, providers);
  return c.json({ success: true, link: parsed, info });
});

// ------------------------------------------------------------- 4. the estimate

interface SpecBody {
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

/**
 * The accessory rows off a request body, sanitised.
 *
 * CAPPED AT TWENTY DISTINCT ROWS, not because a model cannot want more but
 * because a request that does is a client that is looping, and a quote assembled
 * from a thousand rows is a quote nobody reads. `priceAccessories` caps each
 * COUNT separately; this caps how many kinds.
 */
function readAccessories(raw: unknown): AccessorySelection[] {
  if (!Array.isArray(raw)) return [];
  const out: AccessorySelection[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as { id?: unknown }).id ?? '').slice(0, 40);
    const qty = Math.floor(Number((item as { qty?: unknown }).qty));
    if (!id || !Number.isFinite(qty) || qty <= 0) continue;
    out.push({ id, qty: Math.min(MAX_ACCESSORY_QTY, qty) });
  }
  return out;
}

/**
 * «لست متأكدًا» (wizard v2, audit 03 G2). The old wizard auto-picked the first
 * FDM material, so a customer who did not care was matched only to PLA shops.
 * Now "not sure" is an answer: `process: 'unsure'` (or `process_unsure`) and
 * `material_id: 'unsure'` (or `material_unsure`). A CHOSEN material fixes the
 * process — a material is either FDM or resin — so an unsure process with a
 * known material is not unsure at all (`normalizeChoices`).
 */
interface Choices {
  processUnsure: boolean;
  materialUnsure: boolean;
}

function readChoices(body: Record<string, unknown>): Choices {
  return {
    processUnsure: body.process === 'unsure' || body.process_unsure === true,
    materialUnsure: body.material_id === 'unsure' || body.material_unsure === true,
  };
}

function normalizeChoices(spec: SpecBody, choices: Choices, mats: PrintMaterial[]): Choices {
  if (choices.materialUnsure || !spec.material_id) return choices;
  const m = mats.find((x) => x.id === spec.material_id);
  if (!m) return choices;
  spec.process = m.process;
  return { processUnsure: false, materialUnsure: false };
}

function readSpec(body: Record<string, unknown>): SpecBody {
  const process = PROCESSES.includes(body.process as PrintProcess) ? (body.process as PrintProcess) : 'fdm';
  const quality = QUALITIES.includes(body.quality as PrintQuality) ? (body.quality as PrintQuality) : 'standard';
  const hex = str(body.color_hex, 'color_hex', { max: 9, required: false }) ?? '';
  const materialUnsure = body.material_id === 'unsure' || body.material_unsure === true;
  return {
    process,
    material_id: materialUnsure ? '' : (str(body.material_id, 'material_id', { max: 60, required: false }) ?? ''),
    quality,
    infill_percent: int(body.infill_percent, 'infill_percent', { min: 0, max: 100, def: 20 }),
    supports: body.supports !== false,
    colors_count: int(body.colors_count, 'colors_count', { min: 1, max: 16, def: 1 }),
    post_processing_minutes: int(body.post_processing_minutes, 'post_processing_minutes', { min: 0, max: 600, def: 0 }),
    quantity: int(body.quantity, 'quantity', { min: 1, max: 10000, def: 1 }),
    color_hex: /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : '',
    color_name: str(body.color_name, 'color_name', { max: 60, required: false }) ?? '',
    accessories: readAccessories(body.accessories),
  };
}

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
function estimateFor(
  spec: SpecBody,
  choices: Choices,
  base: Omit<QuoteInput, 'materialId'>,
  mats: PrintMaterial[],
  cfg: PrintPricingConfig
): Quote & { range_basis?: 'materials' } {
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

/**
 * The Levonis estimate. Computes, stores nothing, and is deliberately callable
 * over and over as the customer moves a slider — the wizard's price updates
 * live, and every recomputation goes through the SAME engine the published
 * snapshot will use, so the number cannot change when they press publish.
 */
printRequestRoutes.post('/quote', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const spec = readSpec(body);
  const [mats, cfg, accs] = await Promise.all([materials(c.env), pricingConfig(c.env), accessories(c.env)]);
  const choices = normalizeChoices(spec, readChoices(body), mats);

  // The geometry may come from an analysed file (the honest path) or from a
  // volume the customer typed because their link could not be measured.
  let analysis: ModelAnalysis | null = null;
  const fileId = str(body.file_id, 'file_id', { max: 60, required: false }) ?? '';
  if (fileId) {
    const user = c.get('user')!;
    const row = await c.env.DB.prepare(
      `SELECT f.analysis FROM community_request_files f
         JOIN community_requests r ON r.id = f.request_id
        WHERE f.id = ? AND r.customer_id = ?`
    )
      .bind(fileId, user.id)
      .first<{ analysis: string }>();
    analysis = parseJson<ModelAnalysis | null>(row?.analysis, null);
  } else if (body.analysis && typeof body.analysis === 'object') {
    // A caller may pass an analysis object back (the wizard does, to avoid a
    // second read). It is only ever used for SHAPE — publishing re-reads the
    // stored one, so a doctored payload cannot survive into a real price.
    analysis = body.analysis as ModelAnalysis;
  }

  const input: Omit<QuoteInput, 'materialId'> = {
    analysis,
    quality: spec.quality,
    infill: spec.infill_percent / 100,
    quantity: spec.quantity,
    colors: spec.colors_count,
    supports: spec.supports,
    post_processing_minutes: spec.post_processing_minutes,
    accessories: spec.accessories,
    accessory_catalogue: accs,
    fallback_volume_cm3:
      typeof body.volume_cm3 === 'number' && body.volume_cm3 > 0 ? body.volume_cm3 : undefined,
  };
  const quote = estimateFor(spec, choices, input, mats, cfg);

  // The cost breakdown is the shop's business, not the customer's. What the
  // customer gets is the range, the confidence and why.
  const { cost_lines, cost_iqd, floor_iqd, margin_percent, ...publicQuote } = quote;
  void cost_lines; void cost_iqd; void floor_iqd; void margin_percent;
  return c.json({ success: true, quote: publicQuote });
});

// ------------------------------------------- 4b. what a matched merchant reads

/**
 * The three languages a notification is read in, carried together so a caller
 * cannot compose one of them and quietly forget the others.
 *
 * Declared here exactly as worker/lib/stockAlerts.ts declares its own: the
 * shape is three strings, and importing it from a product-comparison module
 * would be a dependency, not a saving.
 */
interface Trilingual {
  ar: string;
  en: string;
  ckb: string;
}

/**
 * Does this text use the ARABIC SCRIPT? — not "is this the Arabic language".
 *
 * Sorani Kurdish is written in the SAME Unicode block, so no regex can tell the
 * two apart and this one does not pretend to. It answers the only question we
 * can honestly ask of a sentence a customer typed: does it belong in an
 * Arabic-script slot or a Latin one. Claiming more than that is precisely how
 * Kurdish gets silently filed as Arabic — the class of bug this composer exists
 * to remove, not to relocate.
 */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Quality in the words the CUSTOMER pressed, not the pricing engine's enum.
 *
 * The ar/en wording is the wizard's own quality choices
 * (src/components/community/requests/RequestWizard.tsx) on purpose: the merchant must
 * read the same word the customer chose, or the two halves of one job are
 * describing it differently and the offer that comes back answers a question
 * nobody asked. 'draft' is «سريعة» / "Quick" and never "Draft", because the
 * customer was never shown the word draft.
 */
const QUALITY_LABEL: Record<PrintQuality, Trilingual> = {
  draft: { ar: 'سريعة', en: 'Quick', ckb: 'خێرا' },
  standard: { ar: 'قياسية', en: 'Standard', ckb: 'ستاندارد' },
  fine: { ar: 'دقيقة', en: 'Fine', ckb: 'ورد' },
  ultra: { ar: 'دقيقة جدًا', en: 'Very fine', ckb: 'زۆر ورد' },
};

/** The same three strings worker/lib/compareSpecs.ts already uses for a
 *  technology, so one process has ONE name across the site rather than a second
 *  translation invented here and drifting from the first. */
const PROCESS_LABEL: Record<PrintProcess, Trilingual> = {
  fdm: { ar: 'FDM', en: 'FDM', ckb: 'FDM' },
  resin: { ar: 'راتنج', en: 'Resin', ckb: 'ڕەزین' },
};

/** Western digits with thousands separators and the local currency word —
 *  how worker/lib/orderNotify.ts, receipts.ts and routes/support.ts already
 *  write money, so a merchant sees one format wherever a number reaches them. */
function iqdText(n: number): Trilingual {
  const num = Math.trunc(n).toLocaleString('en-US');
  return { ar: `${num} د.ع`, en: `${num} IQD`, ckb: `${num} دینار` };
}

/**
 * A value that is about to be written into an `_en` slot, or the fallback.
 *
 * THE CATALOGUE IS ADMIN-EDITABLE FREE TEXT. `printMaterials` is a setting the
 * owner types into, and an owner who writes «بي إل إيه» into `name_en` would
 * reopen this exact bug from the settings screen, with no code change and no
 * warning. The material id ('pla') is normally Latin, so it is the thing to
 * fall back to — an ugly English body beats an Arabic one.
 *
 * AND THE FALLBACK IS CHECKED TOO, because it is not a constant either.
 * `readSpec` takes `material_id` as sixty characters of free text straight off
 * the publish body and never matches it against the catalogue, so an
 * off-catalogue id typed as «بي إل إيه» reaches here with `material` null and
 * would have been written, unexamined, into `body_en` — the exact defect this
 * composer exists to close, walking in through the door the composer left
 * open. Returning '' instead is honest: the caller omits the material segment
 * and the merchant opens the request to read it.
 */
const latinOr = (value: string, fallback: string): string => {
  if (value && !ARABIC_SCRIPT.test(value)) return value;
  if (fallback && !ARABIC_SCRIPT.test(fallback)) return fallback;
  return '';
};

/** The facts a merchant actually decides on, read off the row rather than
 *  asked for a second time in prose. */
export interface PrintMatchFacts {
  /** `community_requests.title` — free text, in whatever language it was typed. */
  title: string;
  process: PrintProcess;
  quality: PrintQuality;
  quantity: number;
  /** The catalogue entry. Carries name_ar and name_en; there is no Kurdish one. */
  material: { name_ar: string; name_en: string } | null;
  /** The id, so a material missing from the catalogue still names itself. */
  material_id: string;
  /**
   * '#rrggbb' or ''. The HEX and never `color_name`: the name is 60 characters
   * of free text in an unknown language, and putting it in an `_en` body would
   * walk straight back into the defect this function was written to close.
   */
  color_hex: string;
  /** '120×80×40 mm' or ''. Digits and a unit — identical in all three. */
  dimensions: string;
  /** A governorate id from the closed list of eighteen, or anything at all: a
   *  value that is not one of the eighteen is dropped, never printed. */
  governorate: string;
  /** ISO date or ''. */
  deadline: string;
  budget_iqd: number | null;
}

/**
 * WHAT A MERCHANT IS TOLD WHEN A PUBLISHED REQUEST MATCHES THEIR SHOP.
 *
 * THE DEFECT THIS REPLACES. `body_ar` and `body_en` were both assigned the SAME
 * variable — `request.title`, the sentence the customer typed, which on this
 * site is almost always Arabic. A merchant reading in English therefore got an
 * Arabic sentence inside an otherwise English notification, and so did a
 * Kurdish merchant. migrations/0045_print_requests.sql writes down the promise
 * that broke: titles and bodies are stored per language precisely so a
 * notification read later "must still be in the language the reader is using
 * NOW". One variable in two slots makes that promise unkeepable.
 *
 * WHY THE TITLE IS NOT TRANSLATED. The Worker's translation engine runs EN→ar
 * and EN→ckb and refuses Arabic input by design, and reaching for an outside
 * API is forbidden. There is no honest way to render that sentence in English,
 * so this does not try. It composes the body from the request's STRUCTURED
 * fields instead — material, process, quality, quantity, size, colour,
 * governorate, deadline, budget. Every one of them is enum-like or numeric,
 * which is exactly why every one of them CAN be said in three languages
 * truthfully. They are also the facts a merchant opens a request to check.
 *
 * THE CUSTOMER'S OWN SENTENCE IS STILL WORTH READING, so it is appended — but
 * only to the slots whose SCRIPT it actually is, and always behind «بكلمات
 * العميل» / "In the customer's words". Marked that way it is a QUOTATION, which
 * is true, instead of a translation, which it never was. An Arabic-script title
 * therefore reaches `body_ar` and the Kurdish text and never `body_en`; a Latin
 * title reaches `body_en` and neither of the others. Nothing is lost by the
 * omission: the link opens the request, where the full title is the heading.
 */
export function printMatchNotification(f: PrintMatchFacts): { title: Trilingual; body: Trilingual } {
  const parts: Trilingual[] = [];
  const push = (t: Trilingual) => {
    if (t.ar || t.en || t.ckb) parts.push(t);
  };

  // The material names itself. There is no `name_ckb` in the catalogue and
  // inventing one would be a guess: PLA is PLA, so the Latin designation is the
  // honest Kurdish reading rather than a placeholder for a missing translation.
  const matEn = latinOr(f.material?.name_en ?? '', f.material_id);
  if (matEn) push({ ar: f.material?.name_ar || matEn, en: matEn, ckb: matEn });

  push(PROCESS_LABEL[f.process]);
  push(QUALITY_LABEL[f.quality]);

  // "1 piece" is what every request is unless it says otherwise, so saying it
  // spends a line of a glanceable message on nothing.
  if (f.quantity > 1) {
    // «العدد ٤» and not «٤ قطعة»: Arabic takes the plural for 3–10 («٤ قطع»)
    // and the dual for 2 («قطعتين»), and the singular only from 11 up — so the
    // obvious interpolation is wrong for exactly the range a one-off print job
    // lands in. The merchant needs the number, not the grammar, so the label
    // goes in front and the agreement question disappears. This also matches
    // the «التسليم …» / «الميزانية …» shape of the parts beside it.
    push({ ar: `العدد ${f.quantity}`, en: `${f.quantity} pcs`, ckb: `${f.quantity} دانە` });
  }
  if (f.dimensions) push({ ar: f.dimensions, en: f.dimensions, ckb: f.dimensions });
  if (f.color_hex) push({ ar: f.color_hex, en: f.color_hex, ckb: f.color_hex });

  // ONLY one of the eighteen. `governorateName` deliberately echoes back an
  // unknown id so an old free-text row still shows what it holds — which here
  // would mean an Arabic place name landing in `body_en`. Normalising first is
  // what keeps this function's promise instead of merely stating it.
  const gov = normalizeGovernorate(f.governorate);
  if (gov) {
    push({
      ar: governorateName(gov, 'ar'),
      en: governorateName(gov, 'en'),
      ckb: governorateName(gov, 'ckb'),
    });
  }

  // The column takes 40 characters of whatever the client sent. The date picker
  // sends an ISO day; anything else is a sentence we cannot read, and a
  // sentence is not a deadline.
  if (/^\d{4}-\d{2}-\d{2}/.test(f.deadline)) {
    const day = f.deadline.slice(0, 10);
    push({ ar: `موعد التسليم ${day}`, en: `due ${day}`, ckb: `گەیاندن ${day}` });
  }
  if (f.budget_iqd !== null && f.budget_iqd > 0) {
    const m = iqdText(f.budget_iqd);
    push({ ar: `الميزانية ${m.ar}`, en: `budget ${m.en}`, ckb: `بودجە ${m.ckb}` });
  }

  const body: Trilingual = {
    ar: parts.map((p) => p.ar).join(' · '),
    en: parts.map((p) => p.en).join(' · '),
    ckb: parts.map((p) => p.ckb).join(' · '),
  };

  // Short on purpose. A notification body is read at a glance on a phone, and
  // the full title is one tap away as the heading of the request itself.
  const flat = f.title.replace(/\s+/g, ' ').trim();
  const quoted = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
  const add = (base: string, line: string) => (base ? `${base}\n${line}` : line);
  if (quoted) {
    if (ARABIC_SCRIPT.test(quoted)) {
      body.ar = add(body.ar, `بكلمات العميل: «${quoted}»`);
      body.ckb = add(body.ckb, `بە وشەکانی کڕیار: «${quoted}»`);
    } else {
      body.en = add(body.en, `In the customer's words: “${quoted}”`);
    }
  }

  return {
    // The ar/en headline is left exactly as it has always read: merchants have
    // been receiving these for months and a rewrite would be churn, not a fix.
    // Only the Kurdish is new.
    title: {
      ar: 'يوجد طلب طباعة جديد مناسب لإمكانيات متجرك',
      en: 'A new print request matches what your shop can make',
      ckb: 'داواکاریەکی نوێی چاپکردن هەیە کە لەگەڵ توانای فرۆشگاکەت دەگونجێت',
    },
    body,
  };
}

// -------------------------------------------------------------- 5. publishing

/**
 * The spec a request was last published (or saved) with, as the body a
 * publish takes — so a request can be (re)published AS STORED: the «إعادة
 * الطلب» copy, and a draft published from its own page, carry no wizard state
 * to send.
 */
function storedPublishBody(stored: Record<string, unknown>, request: Record<string, unknown>): Record<string, unknown> {
  const estimate = parseJson<{ accessory_lines?: Array<{ id?: unknown; qty?: unknown }> }>(stored.estimate, {});
  const dims = parseDims(stored.stated_dims);
  return {
    process: Number(stored.process_unsure ?? 0) === 1 ? 'unsure' : stored.process,
    material_id: Number(stored.material_unsure ?? 0) === 1 ? 'unsure' : stored.material_id,
    quality: stored.quality,
    infill_percent: Number(stored.infill_percent ?? 20),
    supports: Number(stored.supports ?? 1) === 1,
    colors_count: Number(stored.colors_count ?? 1),
    post_processing_minutes: Number(stored.post_processing_minutes ?? 0),
    quantity: Number(request.quantity ?? 1),
    color_hex: stored.color_hex ?? '',
    color_name: stored.color_name ?? '',
    accessories: (estimate.accessory_lines ?? []).map((l) => ({ id: l.id, qty: l.qty })),
    primary_file_id: stored.primary_file_id ?? undefined,
    source_kind: stored.source_kind,
    ...((SOURCE_TYPES as readonly string[]).includes(String(stored.source_type ?? '')) ? { source_type: stored.source_type } : {}),
    source_url: stored.source_url ?? '',
    source_meta: parseJson<Record<string, unknown>>(stored.source_meta, {}),
    ...(dims ? { stated_dimensions_mm: dims } : {}),
  };
}

/**
 * A DEADLINE IS A DATE (wizard v2, audit 03 G5). The column took forty
 * characters of free text; a new write takes `YYYY-MM-DD`, from today to a
 * year ahead, or nothing. Rows written before keep what they hold.
 */
function readDeadline(raw: unknown): string {
  const v = str(raw, 'deadline', { max: 40, required: false }) ?? '';
  if (!v) return '';
  const today = new Date().toISOString().slice(0, 10);
  const limit = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) &&
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v && v >= today && v <= limit;
  if (!ok) throw badRequest('The deadline must be a date from today to a year ahead', 'DEADLINE_INVALID');
  return v;
}

/**
 * EVERYTHING THE WIZARD SENDS, READ ONCE — for a publish and for a draft save.
 *
 * `strict` (publish) also checks that the chosen SOURCE is really there: a
 * model request has a model file, a link request a valid link, an images
 * request at least one image. A draft may be half-filled; a published job may
 * not claim a source it does not have. A caller that names no `source_type`
 * (the older wizard, the community page, a repeat) is not held to it — its
 * source is derived from what it has, exactly as before.
 */
interface WizardInput {
  body: Record<string, unknown>;
  asStored: boolean;
  spec: SpecBody;
  choices: Choices;
  primaryFileId: string;
  analysis: ModelAnalysis | null;
  sourceKind: 'upload' | 'link';
  sourceType: SourceType;
  sourceUrl: string;
  sourceProvider: string;
  sourceMeta: Record<string, string | boolean>;
  statedDims: Dims | null;
  files: RevisionFile[];
  governorate?: string;
  deliveryPref?: string;
  deadline?: string;
  budget?: number | null;
  customerNotes?: string;
}

async function readWizardInput(
  env: Env,
  requestId: string,
  input: Record<string, unknown>,
  stored: Record<string, unknown> | null,
  request: Record<string, unknown>,
  mats: PrintMaterial[],
  opts: { strict: boolean }
): Promise<WizardInput> {
  // A body with no spec at all publishes the spec already stored, when there
  // is one — the repeat copy and a draft published from its own page.
  const asStored = !!stored && input.process === undefined && input.material_id === undefined;
  const body = asStored ? { ...storedPublishBody(stored!, request), ...input } : input;
  const spec = readSpec(body);
  const choices = normalizeChoices(spec, readChoices(body), mats);
  const files = await readRevisionFiles(env.DB, requestId);

  // ---- the model: whichever attachment is the model, measured -------------
  const primaryFileId = str(body.primary_file_id, 'primary_file_id', { max: 60, required: false }) ?? '';
  let analysis: ModelAnalysis | null = null;
  if (primaryFileId) {
    const row = await env.DB.prepare(
      'SELECT analysis, kind FROM community_request_files WHERE id = ? AND request_id = ?'
    )
      .bind(primaryFileId, requestId)
      .first<{ analysis: string; kind: string }>();
    if (!row) throw badRequest('That file does not belong to this request', 'FILE_NOT_FOUND');
    // THE STORED analysis, never one supplied in the body. This is the number
    // the price is built on, so it comes from the server's own measurement.
    analysis = parseJson<ModelAnalysis | null>(row.analysis, null);
  }

  const explicitType = (SOURCE_TYPES as readonly string[]).includes(String(body.source_type ?? ''))
    ? (String(body.source_type) as SourceType)
    : null;
  const sourceKind: 'upload' | 'link' = explicitType ? (explicitType === 'link' ? 'link' : 'upload') : body.source_kind === 'link' ? 'link' : 'upload';
  const providers = await getSetting(env.DB, 'printLinkProviders');
  /**
   * THE LINK IS VALIDATED, NOT JUST STORED (audit 03 §10 W). `source_url` was
   * 600 characters of whatever arrived, shown to merchants — one `<a href>`
   * away from a `javascript:` sink. It now passes the same outbound-URL guard
   * the link step itself uses and is stored in its canonical form. A caller
   * sending a bad one is told; a stored legacy value that no longer passes is
   * dropped rather than blocking the republish of an old request.
   */
  const rawSourceUrl = str(body.source_url, 'source_url', { max: 600, required: false }) ?? '';
  const parsedLink = rawSourceUrl ? parseModelLink(rawSourceUrl, providers) : null;
  if (rawSourceUrl && !parsedLink && !asStored) {
    throw badRequest('That link is not a valid https address', 'BAD_URL');
  }
  const sourceUrl = sourceKind === 'link' ? (parsedLink?.canonical_url ?? '') : '';
  const sourceMeta = sanitizeSourceMeta(body.source_meta);
  const sourceType = explicitType ?? effectiveSourceType({ source_kind: sourceKind, primary_file_id: primaryFileId || null }, files.map((f) => f.kind));

  if (opts.strict && explicitType) {
    const model = primaryFileId ? files.find((f) => f.id === primaryFileId) : undefined;
    if (explicitType === 'model' && (!model || model.kind !== 'model')) {
      throw badRequest('Attach the model file this request is about', 'SOURCE_FILE_REQUIRED');
    }
    if (explicitType === 'link' && !sourceUrl) {
      throw badRequest('Add the link to the model this request is about', 'SOURCE_LINK_REQUIRED');
    }
    if (explicitType === 'images' && !files.some((f) => f.kind === 'reference')) {
      throw badRequest('Attach at least one picture of what you want made', 'SOURCE_IMAGES_REQUIRED');
    }
  }

  // Typed dimensions: only meaningful when nothing was measured. A value that
  // is there but not three edges of 1–5000 mm is refused, not dropped.
  let statedDims: Dims | null = null;
  const rawDims = body.stated_dimensions_mm;
  if (rawDims !== undefined && rawDims !== null && rawDims !== '') {
    statedDims = readDims(rawDims);
    if (!statedDims) throw badRequest('Each dimension must be between 1 and 5000 mm', 'DIMENSIONS_INVALID');
  }

  // `str` answers '' for an absent value, so "supplied" is asked of the body
  // itself — a republish that omits a field must not blank it.
  const supplied = (k: string) => body[k] !== undefined;
  return {
    body,
    asStored,
    spec,
    choices,
    primaryFileId,
    analysis,
    sourceKind,
    sourceType,
    sourceUrl,
    sourceProvider: sourceKind === 'link' ? (parsedLink?.provider ?? '') : '',
    sourceMeta: sourceKind === 'link' ? sourceMeta : sanitizeSourceMeta({}),
    statedDims,
    files,
    governorate: supplied('governorate') ? str(body.governorate, 'governorate', { max: 60, required: false }) : undefined,
    deliveryPref: supplied('delivery_pref') ? str(body.delivery_pref, 'delivery_pref', { max: 40, required: false }) : undefined,
    deadline: supplied('deadline') ? readDeadline(body.deadline) : undefined,
    budget:
      body.budget_iqd === undefined || body.budget_iqd === ''
        ? undefined
        : body.budget_iqd === null
          ? null
          : int(body.budget_iqd, 'budget_iqd', { min: 0, max: 1_000_000_000 }),
    customerNotes: supplied('customer_notes')
      ? str(body.customer_notes, 'customer_notes', { max: 1000, required: false })
      : undefined,
  };
}

/** The priced facts the wizard input describes, for the revision hash. */
function factsFromInput(w: WizardInput, request: Record<string, unknown>): PricedFacts {
  return {
    quantity: w.spec.quantity,
    source_type: w.sourceType,
    process: w.choices.processUnsure ? null : w.spec.process,
    material_id: w.choices.materialUnsure ? null : w.spec.material_id || null,
    color_hex: w.spec.color_hex,
    color_name: w.spec.color_name,
    quality: w.spec.quality,
    infill_percent: w.spec.infill_percent,
    supports: w.spec.supports,
    colors_count: w.spec.colors_count,
    post_processing_minutes: w.spec.post_processing_minutes,
    primary_file_id: w.primaryFileId || null,
    source_url: w.sourceUrl,
    stated_dims: w.statedDims,
    governorate: String(w.governorate ?? request.governorate ?? ''),
    delivery_pref: String(w.deliveryPref ?? request.delivery_pref ?? ''),
    deadline: String(w.deadline !== undefined ? w.deadline : (request.deadline ?? '')),
    customer_notes: String(w.customerNotes ?? request.customer_notes ?? ''),
    file_ids: w.files.map((f) => f.id),
  };
}

/** The print side row, written by a publish and by a draft save alike. */
function printRowStatement(
  db: D1Database,
  requestId: string,
  w: WizardInput,
  quote: Quote | null,
  completeness: number,
  ts: string
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO community_print_requests
       (request_id, process, material_id, color_hex, color_name, quality, infill_percent,
        supports, colors_count, post_processing_minutes, primary_file_id,
        source_kind, source_provider, source_url, source_meta,
        analysis, estimate, estimate_low_iqd, estimate_high_iqd, estimate_confidence,
        completeness, updated_at, source_type, process_unsure, material_unsure, stated_dims)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (request_id) DO UPDATE SET
       process=excluded.process, material_id=excluded.material_id, color_hex=excluded.color_hex,
       color_name=excluded.color_name, quality=excluded.quality, infill_percent=excluded.infill_percent,
       supports=excluded.supports, colors_count=excluded.colors_count,
       post_processing_minutes=excluded.post_processing_minutes, primary_file_id=excluded.primary_file_id,
       source_kind=excluded.source_kind, source_provider=excluded.source_provider,
       source_url=excluded.source_url, source_meta=excluded.source_meta,
       analysis=excluded.analysis, estimate=excluded.estimate,
       estimate_low_iqd=excluded.estimate_low_iqd, estimate_high_iqd=excluded.estimate_high_iqd,
       estimate_confidence=excluded.estimate_confidence, completeness=excluded.completeness,
       updated_at=excluded.updated_at, source_type=excluded.source_type,
       process_unsure=excluded.process_unsure, material_unsure=excluded.material_unsure,
       stated_dims=excluded.stated_dims`
  ).bind(
    requestId, w.spec.process, w.spec.material_id, w.spec.color_hex, w.spec.color_name, w.spec.quality,
    w.spec.infill_percent, w.spec.supports ? 1 : 0, w.spec.colors_count, w.spec.post_processing_minutes,
    w.primaryFileId || null,
    w.sourceKind, w.sourceProvider, w.sourceUrl, JSON.stringify(w.sourceMeta),
    w.analysis ? JSON.stringify(w.analysis) : '{}',
    quote ? JSON.stringify(quote) : '{}',
    quote?.priced ? quote.price_low_iqd : null,
    quote?.priced ? quote.price_high_iqd : null,
    quote?.priced ? quote.confidence : '',
    completeness,
    ts,
    w.sourceType,
    w.choices.processUnsure ? 1 : 0,
    w.choices.materialUnsure ? 1 : 0,
    w.statedDims ? JSON.stringify(w.statedDims) : ''
  );
}

export interface PublishOutcome {
  quote: Record<string, unknown>;
  completeness: number;
  matching: { considered: number; eligible: number; notified: number };
  /** A new revision was created and the offers that priced the old one are superseded. */
  revised: boolean;
  /** The job's revision after this call. */
  revision: number;
  /** A re-publish that changed none of the priced facts: nothing was re-matched. */
  replayed: boolean;
}

/**
 * Publish a request: attach the print spec, snapshot the estimate, make it
 * public, and find and notify the merchants who can make it.
 *
 * THE ONLY DOOR ONTO THE BOARD (audit 03 §10 E). `POST /api/marketplace/
 * requests` creates a DRAFT; this is the one transition to `open`, taken in
 * the same write that fixes the job's facts, and the expiry clock starts here.
 *
 * MATCHING RUNS WHEN THE JOB IS NEW OR CHANGED, ONCE. The first publish
 * matches and notifies. A re-publish that changes none of the priced facts
 * (`canonicalFacts`) re-matches nobody and answers `replayed: true`; one that
 * changes them matches again for the job as it now is (a merchant already
 * told about this request is not told twice — the notification key is the
 * request's).
 *
 * A RE-PUBLISH IS AN EDIT, AND AN EDIT AFTER THE FIRST OFFER IS A REVISION
 * (§10 K, W5-A). When the priced facts change and somebody has a pending
 * offer on the current revision, the revision moves in the same write, every
 * pending offer on an older one is `superseded` (unacceptable; its merchant is
 * told and may re-confirm, edit or withdraw), and the new revision's snapshot
 * is recorded. A change nobody priced yet rewrites the current revision's
 * snapshot in place. The decision is made inside the UPDATE, so an offer
 * landing a moment before it is counted.
 *
 * ONE REQUEST. Nothing here inserts into `community_requests`, and the
 * matching engine has no ability to (worker/lib/printMatching.ts returns
 * decisions, not rows).
 */
export async function publishRequest(
  env: Env,
  userId: string,
  requestId: string,
  input: Record<string, unknown>
): Promise<PublishOutcome> {
  const request = await ownedRequest({ env }, requestId, userId);
  const state = String(request.state);
  if (!['open', 'receiving_offers', 'draft'].includes(state)) {
    throw conflict('This request is no longer open', 'REQUEST_NOT_OPEN');
  }
  const firstPublish = state === 'draft';
  if (!firstPublish && isPast(request.expires_at as string | null)) {
    throw conflict('This request has expired', 'REQUEST_EXPIRED');
  }

  const stored = await env.DB.prepare('SELECT * FROM community_print_requests WHERE request_id = ?')
    .bind(requestId)
    .first<Record<string, unknown>>();
  const [mats, cfg, notifyLimit, accs] = await Promise.all([
    materials(env),
    pricingConfig(env),
    getSetting(env.DB, 'printMatchNotifyLimit'),
    accessories(env),
  ]);
  const w = await readWizardInput(env, requestId, input, stored ?? null, request, mats, { strict: true });
  const { spec, choices, analysis } = w;

  const quote = estimateFor(
    spec,
    choices,
    {
      analysis,
      quality: spec.quality,
      infill: spec.infill_percent / 100,
      quantity: spec.quantity,
      colors: spec.colors_count,
      supports: spec.supports,
      post_processing_minutes: spec.post_processing_minutes,
      accessories: spec.accessories,
      accessory_catalogue: accs,
      fallback_volume_cm3:
        typeof w.body.volume_cm3 === 'number' && w.body.volume_cm3 > 0 ? w.body.volume_cm3 : undefined,
    },
    mats,
    cfg
  );

  const completeness = completenessOf(spec, analysis, w.sourceKind, w.sourceUrl, quote.priced);

  /**
   * THE REQUEST ROW CATCHES UP WITH THE WIZARD.
   *
   * The public board card (`publicRequest()` reads `material`, `color`,
   * `dimensions`, `budget_iqd`, `governorate` from the row) and the matcher's
   * `governorate` and `delivery_pref` — which decide which merchants are
   * eligible at all — live on the request row, so the publish writes them there
   * in the same commit that makes it public. Only fields the caller actually
   * supplied are touched; a republish that sends nothing leaves them as they are.
   */
  const material = mats.find((m) => m.id === spec.material_id) ?? null;
  const materialLabel = choices.materialUnsure ? '' : (material?.name_en ?? spec.material_id);
  const colorLabel = spec.color_name || spec.color_hex;
  const measuredDims = analysis?.measured ? analysis.dimensions_mm : null;
  const dimsFrom = measuredDims ?? w.statedDims;
  const dimsLabel = dimsFrom ? `${Math.round(dimsFrom.x)}×${Math.round(dimsFrom.y)}×${Math.round(dimsFrom.z)} mm` : '';

  // Did the facts a merchant priced change? Only a PUBLISHED request can be
  // revised: nobody has priced a draft.
  const nextFacts = factsFromInput(w, request);
  const changed = !firstPublish && canonicalFacts(factsFromRows(request, stored ?? null, w.files)) !== canonicalFacts(nextFacts);

  const ts = new Date().toISOString();
  const readRevision = Number(request.revision ?? 1);
  const expiryDays = Number(await getSetting(env.DB, 'communityRequestExpiryDays')) || 30;
  const expiresAt = new Date(Date.now() + expiryDays * 86_400_000).toISOString();

  const sets: string[] = [
    'material = ?', 'color = ?', 'quantity = ?',
    // Draft → open is THE publish. Every SET reads the row as it was, so the
    // expiry below sees the same `state` this CASE does.
    "state = CASE WHEN state = 'draft' THEN 'open' ELSE state END",
    "status = 'open'",
    "expires_at = CASE WHEN state = 'draft' THEN ? ELSE expires_at END",
    "published_at = CASE WHEN state = 'draft' THEN ? ELSE published_at END",
    // `changed` is the server's own boolean, spliced as a literal 1/0.
    `revision = ${bumpRevisionIfOfferedSql(changed ? '1' : '0')}`,
    'updated_at = ?',
  ];
  const vals: Array<string | number | null> = [materialLabel, colorLabel, spec.quantity, expiresAt, ts, ts];
  if (dimsLabel) { sets.splice(2, 0, 'dimensions = ?'); vals.splice(2, 0, dimsLabel); }
  if (w.governorate !== undefined) { sets.push('governorate = ?'); vals.push(w.governorate); }
  if (w.deliveryPref !== undefined) { sets.push('delivery_pref = ?'); vals.push(w.deliveryPref); }
  if (w.deadline !== undefined) { sets.push('deadline = ?'); vals.push(w.deadline || null); }
  if (w.budget !== undefined) { sets.push('budget_iqd = ?'); vals.push(w.budget); }
  if (w.customerNotes !== undefined) { sets.push('customer_notes = ?'); vals.push(w.customerNotes); }

  const snapshot = {
    spec: snapshotSpec(
      { title: request.title, description: request.description, budget_iqd: w.budget !== undefined ? w.budget : request.budget_iqd },
      nextFacts,
      measuredDims
    ),
    files: w.files,
    estimate: publicEstimate(JSON.stringify(quote)),
    hash: await factsHash(nextFacts),
  };

  try {
    await env.DB.batch([
      // The request, conditional on it being exactly what was read: a file
      // added in between moved its revision and this publish refuses.
      env.DB.prepare(
        `UPDATE community_requests SET ${sets.join(', ')}
          WHERE id = ? AND customer_id = ? AND state IN ('open','receiving_offers','draft') AND revision = ?`
      ).bind(...vals, requestId, userId, readRevision),
      // Nothing below is written unless the line above really was.
      env.DB.prepare(
        `UPDATE community_requests
            SET updated_at = CASE WHEN updated_at = ?2 THEN updated_at ELSE NULL END
          WHERE id = ?1`
      ).bind(requestId, ts),
      printRowStatement(env.DB, requestId, w, quote, completeness, ts),
      // Offers that priced a revision the line above left behind.
      supersedeStatement(env.DB, requestId, ts),
      offerCountStatement(env.DB, requestId),
      // The revision as it now stands: a new row after a bump, else in place.
      recordRevisionStatement(env.DB, requestId, snapshot, firstPublish ? 'publish' : 'edit', userId, ts),
    ]);
  } catch (e) {
    if (!/constraint/i.test(e instanceof Error ? e.message : String(e))) throw e;
    throw conflict('This request changed while you were publishing it — reload it and try again', 'REQUEST_CHANGED');
  }

  // Re-read, so the matcher sees what was just written.
  //
  // `deadline` and `budget_iqd` join the re-read because the merchant's
  // notification is composed from the ROW, not from this call's payload. A
  // republish that does not resend them must still tell merchants the deadline
  // and budget the customer set the first time round.
  const forMatching = await env.DB.prepare(
    'SELECT governorate, delivery_pref, deadline, budget_iqd, revision FROM community_requests WHERE id = ?'
  )
    .bind(requestId)
    .first<{
      governorate: string;
      delivery_pref: string;
      deadline: string | null;
      budget_iqd: number | null;
      revision: number;
    }>();
  const revision = Number(forMatching?.revision ?? readRevision);
  const revised = revision > readRevision;
  const { cost_lines, cost_iqd, floor_iqd, margin_percent, ...publicQuote } = quote;
  void cost_lines; void cost_iqd; void floor_iqd; void margin_percent;

  // ---- nothing a merchant priced changed: nobody is matched again -----------
  if (!firstPublish && !changed) {
    await audit(env.DB, userId, 'print.request_republished', requestId, { revision, revised: false, replayed: true });
    return {
      quote: publicQuote as unknown as Record<string, unknown>,
      completeness,
      matching: { considered: 0, eligible: 0, notified: 0 },
      revised: false,
      revision,
      replayed: true,
    };
  }

  // ---- who can make it, and who is told (W5-B) ---------------------------
  //
  // ONE AUTHORITY. Every active workshop is decided by `evaluateEligibility`
  // (worker/lib/eligibility.ts) — printers, stock, delivery reach, plan and
  // preferences — through `matchRequest`, which records every verdict for
  // this revision and tells the best `printMatchNotifyLimit` of those who are
  // eligible and want to hear, once per request. «لست متأكدًا» is part of the
  // job the eligibility reads (a null process or material), not a second pass.
  //
  // THE MESSAGE IS COMPOSED, NEVER COPIED. `printMatchNotification` builds each
  // language out of the structured fields and quotes the customer's own words
  // only where their script fits; its comment explains why translating that
  // sentence is not on the table.
  const text = printMatchNotification({
    title: String(request.title ?? ''),
    process: spec.process,
    quality: spec.quality,
    quantity: spec.quantity,
    material: choices.materialUnsure ? null : material,
    material_id: choices.materialUnsure ? '' : spec.material_id,
    color_hex: spec.color_hex,
    dimensions: dimsLabel,
    governorate: String(forMatching?.governorate ?? request.governorate ?? ''),
    deadline: String(forMatching?.deadline ?? ''),
    budget_iqd: typeof forMatching?.budget_iqd === 'number' ? forMatching.budget_iqd : null,
  });
  const matched = await matchRequest(env, requestId, {
    notify: true,
    limit: Math.max(1, Number(notifyLimit) || 25),
    text,
  });
  // The merchants whose offers the change superseded hear about it.
  if (revised) {
    const stale = await staleOfferNotifications(env.DB, requestId, revision);
    for (let i = 0; i < stale.length; i += 90) await env.DB.batch(stale.slice(i, i + 90));
  }
  const decisions = { length: matched.considered, eligible: matched.eligible };
  const notify = { length: matched.notified };

  await audit(env.DB, userId, firstPublish ? 'print.request_published' : 'print.request_republished', requestId, {
    considered: decisions.length,
    eligible: decisions.eligible,
    notified: notify.length,
    confidence: quote.confidence,
    revision,
    revised,
    process_unsure: choices.processUnsure,
    material_unsure: choices.materialUnsure,
  });

  return {
    quote: publicQuote as unknown as Record<string, unknown>,
    completeness,
    matching: {
      considered: decisions.length,
      eligible: decisions.eligible,
      notified: notify.length,
    },
    revised,
    revision,
    replayed: false,
  };
}

printRequestRoutes.post('/requests/:id/publish', requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'print-publish', 20, 3600);
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const out = await publishRequest(c.env, user.id, requestId, body);
  return c.json({ success: true, request_id: requestId, published: true, ...out });
});

// ------------------------------------------------------------ 5b. the draft

/**
 * «احفظ كمسودة» — the wizard's answers kept on the DRAFT, without publishing.
 *
 * Only while the request IS a draft (`REQUEST_NOT_DRAFT` otherwise — a
 * published job changes through the publish door, which revises it). Nothing
 * here is visible to anyone but the customer, nothing is matched, and the
 * abandoned-draft clock is pushed `DRAFT_TTL_DAYS` ahead: a draft someone is
 * still working on is not abandoned. The conditional `state = 'draft'` in the
 * write means a publish that won a race is never overwritten by a late save.
 */
printRequestRoutes.put('/requests/:id/draft', requireAuth, async (c) => {
  await rateLimit(c, 'print-draft', 120, 3600);
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const request = await ownedRequest(c, requestId, user.id);
  if (request.state !== 'draft') throw conflict('Only a draft can be saved this way', 'REQUEST_NOT_DRAFT');

  const stored = await c.env.DB.prepare('SELECT * FROM community_print_requests WHERE request_id = ?')
    .bind(requestId)
    .first<Record<string, unknown>>();
  const mats = await materials(c.env);
  // A draft save always carries the wizard's state; an empty body is not "as stored".
  const w = await readWizardInput(c.env, requestId, { process: body.process ?? 'unsure', ...body }, stored ?? null, request, mats, { strict: false });

  const title = body.title === undefined ? undefined : str(body.title, 'title', { min: 4, max: 140 });
  const description = body.description === undefined ? undefined : str(body.description, 'description', { min: 10, max: 6000 });
  const sets: string[] = ['quantity = ?', 'material = ?', 'color = ?', 'expires_at = ?', 'updated_at = ?'];
  const ts = new Date().toISOString();
  const vals: Array<string | number | null> = [
    w.spec.quantity,
    w.choices.materialUnsure ? '' : (mats.find((m) => m.id === w.spec.material_id)?.name_en ?? w.spec.material_id),
    w.spec.color_name || w.spec.color_hex,
    new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000).toISOString(),
    ts,
  ];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
  if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
  if (w.governorate !== undefined) { sets.push('governorate = ?'); vals.push(w.governorate); }
  if (w.deliveryPref !== undefined) { sets.push('delivery_pref = ?'); vals.push(w.deliveryPref); }
  if (w.deadline !== undefined) { sets.push('deadline = ?'); vals.push(w.deadline || null); }
  if (w.budget !== undefined) { sets.push('budget_iqd = ?'); vals.push(w.budget); }
  if (w.customerNotes !== undefined) { sets.push('customer_notes = ?'); vals.push(w.customerNotes); }

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE community_requests SET ${sets.join(', ')} WHERE id = ? AND customer_id = ? AND state = 'draft'`
      ).bind(...vals, requestId, user.id),
      // A publish that landed first leaves this save with nothing to write.
      c.env.DB.prepare(
        `UPDATE community_requests SET updated_at = CASE WHEN state = 'draft' AND updated_at = ?2 THEN updated_at ELSE NULL END
          WHERE id = ?1`
      ).bind(requestId, ts),
      printRowStatement(c.env.DB, requestId, w, null, 0, ts),
    ]);
  } catch (e) {
    if (!/constraint/i.test(e instanceof Error ? e.message : String(e))) throw e;
    throw conflict('This request is no longer a draft — reload it', 'REQUEST_NOT_DRAFT');
  }
  return c.json({ success: true, draft: await draftShape(c.env, requestId) });
});

/**
 * EVERYTHING THE WIZARD NEEDS TO PICK UP WHERE THE CUSTOMER LEFT OFF — a
 * draft to finish, or a published request to edit. Owner only (a stranger's
 * id is a 404, never a refusal that confirms it exists). `live_offers` lets
 * the wizard warn that a material change will supersede standing offers.
 */
async function draftShape(env: Env, requestId: string) {
  const r = await env.DB.prepare('SELECT * FROM community_requests WHERE id = ?').bind(requestId).first<Record<string, unknown>>();
  const p = await env.DB.prepare('SELECT * FROM community_print_requests WHERE request_id = ?')
    .bind(requestId)
    .first<Record<string, unknown>>();
  const { results: files } = await env.DB.prepare(
    `SELECT id, file_name, content_type, size_bytes, kind, analysis FROM community_request_files
      WHERE request_id = ? ORDER BY created_at, id`
  )
    .bind(requestId)
    .all<Record<string, unknown>>();
  const live = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM community_offers WHERE request_id = ? AND state = 'pending'`
  )
    .bind(requestId)
    .first<{ n: number }>();
  return {
    id: String(r?.id ?? requestId),
    state: String(r?.state ?? ''),
    revision: Number(r?.revision ?? 1),
    title: String(r?.title ?? ''),
    description: String(r?.description ?? ''),
    customer_notes: String(r?.customer_notes ?? ''),
    quantity: Number(r?.quantity ?? 1),
    governorate: String(r?.governorate ?? ''),
    delivery_pref: String(r?.delivery_pref ?? ''),
    deadline: r?.deadline ? String(r.deadline) : '',
    budget_iqd: r?.budget_iqd === null || r?.budget_iqd === undefined ? null : Number(r.budget_iqd),
    expires_at: (r?.expires_at as string | null) ?? null,
    live_offers: Number(live?.n ?? 0),
    print: p
      ? {
          source_type: effectiveSourceType(p, (files ?? []).map((f) => String(f.kind))),
          process: effectiveProcess(p) ?? 'unsure',
          material_id: effectiveMaterial(p) ?? (Number(p.material_unsure ?? 0) === 1 ? 'unsure' : ''),
          quality: String(p.quality ?? 'standard'),
          infill_percent: Number(p.infill_percent ?? 20),
          supports: Number(p.supports ?? 1) === 1,
          colors_count: Number(p.colors_count ?? 1),
          post_processing_minutes: Number(p.post_processing_minutes ?? 0),
          color_hex: String(p.color_hex ?? ''),
          color_name: String(p.color_name ?? ''),
          primary_file_id: (p.primary_file_id as string | null) ?? null,
          source_url: String(p.source_url ?? ''),
          source_meta: parseJson<Record<string, unknown>>(p.source_meta, {}),
          stated_dimensions_mm: parseDims(p.stated_dims),
        }
      : null,
    files: (files ?? []).map((f) => ({
      id: String(f.id),
      file_name: String(f.file_name ?? ''),
      content_type: String(f.content_type ?? ''),
      size_bytes: Number(f.size_bytes ?? 0),
      kind: String(f.kind ?? ''),
      inline: String(f.content_type ?? '').startsWith('image/'),
      url: `/api/marketplace/requests/${requestId}/files/${String(f.id)}`,
      analysis: parseJson<ModelAnalysis | null>(f.analysis, null),
    })),
  };
}

printRequestRoutes.get('/requests/:id/draft', requireAuth, async (c) => {
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  await ownedRequest(c, requestId, user.id);
  return c.json({ success: true, draft: await draftShape(c.env, requestId) });
});

// --------------------------------------------------------- 5c. the revisions

/** Which snapshot fields moved between two revisions — named, never diffed as text. */
const REVISION_FIELDS = [
  'quantity', 'source_type', 'process', 'material_id', 'color_hex', 'color_name', 'quality', 'infill_percent',
  'supports', 'colors_count', 'post_processing_minutes', 'primary_file_id', 'source_url', 'stated_dims',
  'governorate', 'delivery_pref', 'deadline', 'customer_notes', 'file_ids',
] as const;

/**
 * THE JOB'S HISTORY — what each revision said, and what moved. For whoever may
 * read the request's print facts (the customer, a merchant while it is on the
 * board and the community lets them in, the engaged merchant): a merchant
 * whose offer was superseded sees exactly what changed before re-pricing.
 */
printRequestRoutes.get('/requests/:id/revisions', async (c) => {
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const user = c.get('user');
  const request = await c.env.DB.prepare(
    'SELECT id, customer_id, state, visibility, expires_at, revision FROM community_requests WHERE id = ?'
  )
    .bind(requestId)
    .first<RequestForAccess & { revision: number }>();
  if (!request) throw notFound('Request not found');
  const isOwner = !!user && user.id === request.customer_id;
  const publicBoard = onPublicBoard(request);
  const boardShut = publicBoard && !isOwner && !communityMayEnter(await readCommunityGate(c.env.DB), user);
  if (!isOwner && !(publicBoard && !boardShut)) {
    const engaged = user ? await isEngagedMerchant(c.env.DB, requestId, user.id) : false;
    if (!engaged) throw boardShut ? communityClosedRefusal() : notFound('Request not found');
  }
  /**
   * PAST REVISIONS ARE NOT PUBLIC (review W2-5 #6). What a request USED to say
   * — an earlier title, description, notes or source link the customer took
   * back — is for the customer, an admin, and a merchant who made an offer on
   * it (any state: the superseded offer is exactly why they need the diff).
   * Anyone else the board lets in gets the CURRENT revision only, which says
   * nothing the board does not already show; `history: false` tells the
   * client why there is one entry.
   */
  const fullHistory =
    isOwner ||
    user?.role === 'admin' ||
    (!!user &&
      !!(await c.env.DB.prepare(
        `SELECT 1 AS x FROM community_offers o JOIN community_merchants m ON m.id = o.merchant_id
          WHERE o.request_id = ? AND m.user_id = ? LIMIT 1`
      )
        .bind(requestId, user.id)
        .first()));
  const { results } = await c.env.DB.prepare(
    `SELECT revision, spec, files, estimate, hash, reason, created_at FROM community_request_revisions
      WHERE request_id = ?1 AND (?2 = 1 OR revision = ?3) ORDER BY revision ASC LIMIT 100`
  )
    .bind(requestId, fullHistory ? 1 : 0, Number(request.revision ?? 1))
    .all<Record<string, unknown>>();
  let prev: Record<string, unknown> | null = null;
  const revisions = (results ?? []).map((row) => {
    const spec = parseJson<Record<string, unknown>>(row.spec, {});
    const changes = prev
      ? REVISION_FIELDS.filter((k) => JSON.stringify(spec[k] ?? null) !== JSON.stringify(prev![k] ?? null))
      : [];
    prev = spec;
    return {
      revision: Number(row.revision),
      reason: String(row.reason ?? ''),
      created_at: String(row.created_at ?? ''),
      hash: String(row.hash ?? ''),
      spec,
      files: parseJson<RevisionFile[]>(row.files, []).map((f) => ({ id: f.id, kind: f.kind, file_name: f.file_name })),
      estimate: publicEstimate(row.estimate),
      changes,
    };
  });
  return c.json({ success: true, current: Number(request.revision ?? 1), history: fullHistory, revisions });
});

/**
 * 0..100 — how much of the picture the customer has given us.
 *
 * NOT a validation gate. The owner was explicit: "لا تجعل التفاصيل غير الضرورية
 * إجبارية". This exists so the wizard can say "more detail means a faster, more
 * accurate price", and for the customer to ignore if they want to.
 */
function completenessOf(
  spec: SpecBody,
  analysis: ModelAnalysis | null,
  sourceKind: string,
  sourceUrl: string,
  priced: boolean
): number {
  let score = 0;
  if (analysis?.measured) score += 40;
  else if (sourceKind === 'link' && sourceUrl) score += 15;
  if (spec.material_id) score += 15;
  if (spec.color_hex || spec.color_name) score += 10;
  if (spec.quality) score += 5;
  if (priced) score += 20;
  if (analysis?.watertight) score += 5;
  if (spec.post_processing_minutes > 0) score += 5;
  return Math.min(100, score);
}

// ------------------------------------------------------- 6. reading it back

/**
 * The print side of a request, for anyone already allowed to see the request.
 *
 * Permission is DERIVED from the request exactly as marketplace.ts derives it,
 * rather than re-implemented: the owner always; anyone while it is public and
 * open, because a merchant cannot quote what they may not look at; the engaged
 * merchant afterwards.
 */
printRequestRoutes.get('/requests/:id', async (c) => {
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const user = c.get('user');
  const request = await c.env.DB.prepare(
    'SELECT id, customer_id, state, visibility, expires_at FROM community_requests WHERE id = ?'
  )
    .bind(requestId)
    .first<RequestForAccess>();
  if (!request) throw notFound('Request not found');

  const isOwner = !!user && user.id === request.customer_id;
  // On the board means public, taking offers AND not expired (audit 03 §10 I).
  const publicBoard = onPublicBoard(request);
  // The public board is Levo Community and closes with it (DECISIONS 110):
  // this is the print twin of the walled GET /api/marketplace/requests/:id.
  // The customer and the merchant already working the job keep their view.
  const boardShut = publicBoard && !isOwner && !communityMayEnter(await readCommunityGate(c.env.DB), user);
  const openToAll = publicBoard && !boardShut;
  if (!isOwner && !openToAll) {
    const engaged = user ? await isEngagedMerchant(c.env.DB, requestId, user.id) : false;
    if (!engaged) throw boardShut ? communityClosedRefusal() : notFound('Request not found');
  }

  const row = await c.env.DB.prepare('SELECT * FROM community_print_requests WHERE request_id = ?')
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ success: true, print: null });

  const analysis = parseJson<ModelAnalysis | null>(row.analysis, null);
  const estimate = parseJson<Record<string, unknown>>(row.estimate, {});
  // The cost breakdown is the platform's, not the merchant's and not the
  // customer's. Everyone sees the range and the confidence; nobody sees how it
  // was built.
  delete estimate.cost_lines;
  delete estimate.cost_iqd;
  delete estimate.floor_iqd;
  delete estimate.margin_percent;

  return c.json({
    success: true,
    print: {
      process: row.process,
      material_id: row.material_id,
      color_hex: row.color_hex,
      color_name: row.color_name,
      quality: row.quality,
      infill_percent: row.infill_percent,
      supports: !!row.supports,
      colors_count: row.colors_count,
      post_processing_minutes: row.post_processing_minutes,
      primary_file_id: row.primary_file_id,
      source_kind: row.source_kind,
      source_provider: row.source_provider,
      source_url: row.source_url,
      source_meta: parseJson<Record<string, unknown>>(row.source_meta, {}),
      // Wizard v2 (W5-A): where the job came from, «لست متأكدًا» as an answer,
      // and the size the customer typed when there is no model to measure.
      source_type: effectiveSourceType(row),
      process_unsure: Number(row.process_unsure ?? 0) === 1,
      material_unsure: Number(row.material_unsure ?? 0) === 1,
      stated_dimensions_mm: parseDims(row.stated_dims),
      range_basis: estimate.range_basis ?? null,
      analysis,
      estimate,
      estimate_low_iqd: row.estimate_low_iqd,
      estimate_high_iqd: row.estimate_high_iqd,
      estimate_confidence: row.estimate_confidence,
      completeness: row.completeness,
      // `analysis` is '{}' when nothing was measured (a link, pictures, words):
      // capabilities then come from the size the customer typed, or none.
      required_capabilities: analysis?.dimensions_mm || parseDims(row.stated_dims)
        ? requiredCapabilities(
            {
              id: requestId,
              process: (row.process === 'resin' ? 'resin' : 'fdm') as PrintProcess,
              material_id: effectiveMaterial(row) ?? '',
              color_hex: String(row.color_hex ?? ''),
              quality: (row.quality ?? 'standard') as PrintQuality,
              colors_count: Number(row.colors_count ?? 1),
              dimensions_mm: analysis?.dimensions_mm ?? parseDims(row.stated_dims) ?? { x: 0, y: 0, z: 0 },
              governorate: '',
              delivery_pref: '',
              estimate_iqd: null,
              quantity: 1,
            },
            null
          )
        : [],
    },
    is_owner: isOwner,
  });
});

// ------------------------------------------------------------- 7. the viewer

/**
 * HOW LONG A PREVIEW LINK LIVES — decided here, never by the caller.
 *
 * The mint used to take `hours` from the body, 1 to 168, default 72: a week
 * of anonymous access to a customer's model preview, chosen by whoever asked
 * for it (audit 03 §10 F). The viewer page loads the metadata and the mesh the
 * moment it opens, so an hour is ample for anyone actually looking — and a
 * link that leaks is dead by the time it is passed around. A body `hours` is
 * ignored rather than refused, so an older client still gets a working link.
 */
export const VIEWER_TOKEN_TTL_MINUTES = 60;

/** Request states in which nobody may preview anything any more. */
const VIEWER_CLOSED_STATES = ['cancelled', 'expired'];

/**
 * Mint a link to the 3D preview.
 *
 * The token is random, stored HASHED (so the table is useless to whoever reads
 * it), expires after `VIEWER_TOKEN_TTL_MINUTES`, and grants a DERIVED mesh —
 * never the uploaded file.
 *
 * WHO MAY MINT, AND WHAT THEY GET (W5-B, worker/lib/requestFilePolicy.ts):
 * the customer and the merchant whose offer was accepted get the stored
 * preview (`full`); a merchant whose LIVE ELIGIBILITY VERDICT says they can
 * make the job — the verdict that lets them offer — gets the coarse preview
 * derived from it (`preview`: decimated and snapped to a grid). Nobody else:
 * not a plain account on the board, not a merchant the job does not fit.
 *
 * THE LINK IS BOUND to the account that minted it and to the request revision
 * it was minted for: another account holding it is refused, and a new revision
 * retires it. It also stops when the request closes (wave 1) and when its
 * minter loses the access it stood on. Minting is counted with every other
 * read of the file.
 */
printRequestRoutes.post('/requests/:id/files/:fileId/viewer-token', requireAuth, async (c) => {
  await rateLimit(c, 'viewer-token', 60, 3600);
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const fileId = str(c.req.param('fileId'), 'fileId', { min: 1, max: 60 });

  const file = await c.env.DB.prepare(
    `SELECT f.id AS file_id, f.preview_key, r.id, r.customer_id, r.state, r.visibility, r.expires_at, r.revision
       FROM community_request_files f
       JOIN community_requests r ON r.id = f.request_id
      WHERE f.id = ? AND f.request_id = ?`
  )
    .bind(fileId, requestId)
    .first<{ file_id: string; preview_key: string; revision: number } & RequestForAccess>();
  if (!file) throw notFound('File not found');
  if (VIEWER_CLOSED_STATES.includes(file.state)) {
    throw conflict('This request is closed, so its model can no longer be previewed', 'REQUEST_CLOSED');
  }

  const { reader, gateClosed, verdict, visible } = await fileReader(c.env, file, user, { allowAdmin: false });
  if (gateClosed) throw communityClosedRefusal();
  if (!visible) throw notFound('File not found');
  const grant = previewGrantFor(reader);
  if (!grant) {
    throw new HttpError(
      403,
      'Only merchants who can make this request may preview its model',
      'VIEWER_NOT_ALLOWED',
      verdict ? { reason: verdict.reason, reasons: verdict.reasons } : undefined
    );
  }
  if (!file.preview_key) throw conflict('This file has no 3D preview', 'NO_PREVIEW');

  // 32 bytes of real randomness, not two ids concatenated: this is the only
  // thing standing between a stranger and someone's model preview.
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const ts = new Date().toISOString();
  const expires = new Date(Date.now() + VIEWER_TOKEN_TTL_MINUTES * 60_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO model_view_tokens (token_hash, file_id, request_id, created_by, expires_at, revision, grant_level, bound_user)
       VALUES (?,?,?,?,?,?,?,1)`
    ).bind(hash, fileId, requestId, user.id, expires, Number(file.revision ?? 1), grant),
    fileReadStatement(c.env.DB, {
      requestId, fileId, userId: user.id, reader: reader!, what: 'preview_link', revision: Number(file.revision ?? 1),
    }, ts),
  ]);

  return c.json({ success: true, token, url: `/model-viewer/${token}`, expires_at: expires, grant });
});

/**
 * What the viewer page needs to draw its labels. No file, no key, no owner —
 * and NO FILE NAME (audit 03 §10 F): the name a customer saved their model
 * under is theirs. The format and the measured size say what the page needs.
 */
printRequestRoutes.get('/viewer/:token', async (c) => {
  const row = await viewerToken(c.env, c.req.param('token'), c.get('user'));
  const file = await c.env.DB.prepare(
    'SELECT analysis, model_format FROM community_request_files WHERE id = ?'
  )
    .bind(row.file_id)
    .first<{ analysis: string; model_format: string }>();
  const analysis = parseJson<ModelAnalysis | null>(file?.analysis, null);
  await countViewerRead(c.env.DB, row, 'preview_meta');
  return c.json({
    success: true,
    format: file?.model_format ?? '',
    dimensions_mm: analysis?.dimensions_mm ?? null,
    volume_mm3: analysis?.volume_mm3 ?? null,
    triangle_count: analysis?.triangle_count ?? null,
    shell_count: analysis?.shell_count ?? null,
    expires_at: row.expires_at,
    /** 'preview' = the coarse mesh a merchant quoting on the board sees. */
    grant: row.grant,
  });
});

/** The derived mesh. Bytes only — the original file is never served here. */
printRequestRoutes.get('/viewer/:token/mesh', async (c) => {
  const row = await viewerToken(c.env, c.req.param('token'), c.get('user'));
  const file = await c.env.DB.prepare('SELECT preview_key FROM community_request_files WHERE id = ?')
    .bind(row.file_id)
    .first<{ preview_key: string }>();
  if (!file?.preview_key) throw notFound('No preview available');
  const object = await getMediaObject(c.env, 'private', file.preview_key);
  if (!object) throw notFound('No preview available');

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE model_view_tokens
          SET uses = uses + 1, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE token_hash = ?`
    ).bind(row.token_hash),
    viewerReadStatement(c.env.DB, row, 'preview_mesh'),
  ]);

  // A merchant quoting on the board gets the coarse mesh, derived here from
  // the stored preview — the stored one is not sent to them at all.
  let body: BodyInit = object.body;
  if (row.grant === 'preview') {
    const coarse = coarsePreviewMesh(new Uint8Array(await new Response(object.body).arrayBuffer()));
    if (!coarse) throw notFound('No preview available');
    body = coarse;
  }
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'private, max-age=0, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

interface ViewerRow {
  token_hash: string;
  file_id: string;
  request_id: string;
  expires_at: string;
  created_by: string;
  revision: number;
  /** What the link grants NOW: its minted grant, never more than the minter's current access. */
  grant: PreviewGrant;
  reader: FileReader;
}

function viewerReadStatement(db: D1Database, row: ViewerRow, what: 'preview_meta' | 'preview_mesh'): D1PreparedStatement {
  return fileReadStatement(db, {
    requestId: row.request_id, fileId: row.file_id, userId: row.created_by, reader: row.reader, what, revision: row.revision,
  });
}

async function countViewerRead(db: D1Database, row: ViewerRow, what: 'preview_meta' | 'preview_mesh'): Promise<void> {
  await viewerReadStatement(db, row, what).run().catch((e) => console.error('viewer read not counted', e instanceof Error ? e.message : String(e)));
}

async function viewerToken(env: Env, raw: string | undefined, viewer: SessionUser | null | undefined): Promise<ViewerRow> {
  const token = str(raw, 'token', { min: 20, max: 120 });
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT t.token_hash, t.file_id, t.request_id, t.expires_at, t.revoked_at, t.created_at, t.created_by,
            t.revision AS token_revision, t.grant_level, t.bound_user,
            r.state AS request_state, r.customer_id, r.visibility, r.expires_at AS request_expires_at,
            r.revision AS request_revision, u.role AS creator_role
       FROM model_view_tokens t
       JOIN community_requests r ON r.id = t.request_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.token_hash = ?`
  )
    .bind(hash)
    .first<{
      token_hash: string; file_id: string; request_id: string; expires_at: string;
      revoked_at: string | null; created_at: string; created_by: string;
      token_revision: number | null; grant_level: string; bound_user: number;
      request_state: string; customer_id: string; visibility: string; request_expires_at: string | null;
      request_revision: number; creator_role: string | null;
    }>();
  const invalid = () => notFound('This link is no longer valid');
  // One answer for "wrong", "expired", "revoked", "not yours", "an older
  // revision" and "the request is closed": a viewer link that has stopped
  // working must not tell a stranger which of them it was.
  if (
    !row ||
    row.revoked_at ||
    !(Date.parse(row.expires_at) > Date.now()) ||
    VIEWER_CLOSED_STATES.includes(row.request_state)
  ) {
    throw invalid();
  }
  // BOUND TO THE PERSON (W5-B): only the account that minted it opens it. The
  // viewer page is opened from the app, in the same browser, signed in.
  if (Number(row.bound_user) !== 1 || !viewer || viewer.id !== row.created_by) throw invalid();
  // AND TO THE REVISION: the customer changed the job, the preview of the old
  // one is not what anyone should be quoting from.
  if (Number(row.token_revision ?? 0) !== Number(row.request_revision ?? 1)) throw invalid();
  /**
   * A LINK MINTED BEFORE THE 60-MINUTE RULE KEEPS NONE OF ITS WEEK (review
   * S8): whatever `expires_at` says, a link lives `VIEWER_TOKEN_TTL_MINUTES`
   * from its own minting.
   */
  const minted = Date.parse(row.created_at);
  if (!(Number.isFinite(minted) && minted + VIEWER_TOKEN_TTL_MINUTES * 60_000 > Date.now())) throw invalid();
  /**
   * AND IT GRANTS NO MORE THAN ITS CREATOR STILL HAS (review S8, W5-B). Re-
   * derived on every use by the rule the mint applied: the customer, the
   * accepted merchant, or a merchant still eligible right now. A restricted
   * merchant, a lapsed plan, a printer sold, a request that left the board:
   * the link stops with the access it stood on — and a merchant who was
   * accepted later never gets more than the grant they minted.
   */
  const creator = { id: row.created_by, role: row.creator_role ?? 'customer' } as SessionUser;
  const request: RequestForAccess = {
    id: row.request_id,
    customer_id: row.customer_id,
    state: row.request_state,
    visibility: row.visibility,
    expires_at: row.request_expires_at,
  };
  const { reader } = await fileReader(env, request, creator, { allowAdmin: false });
  const now = previewGrantFor(reader);
  if (!now || !reader) throw invalid();
  const grant: PreviewGrant = row.grant_level === 'full' && now === 'full' ? 'full' : 'preview';
  return {
    token_hash: row.token_hash,
    file_id: row.file_id,
    request_id: row.request_id,
    expires_at: row.expires_at,
    created_by: row.created_by,
    revision: Number(row.request_revision ?? 1),
    grant,
    reader,
  };
}

// -------------------------------------------------------- 8. repeat a request

/**
 * "اطلب مرة أخرى" — copy a request into a NEW DRAFT.
 *
 * A new request row, a new id, and the files RE-COPIED in R2 rather than shared:
 * two requests pointing at one object means deleting the old one breaks the new
 * one, and a customer who repeats an order in March should not lose it because
 * they tidied up in January.
 *
 * THE COPY IS A DRAFT, AND ONLY A DRAFT (audit 03 §10 E, §11 item 9; W5-A).
 * It used to be inserted straight onto the board — `open`, public, offerable
 * — and never matched. Wave 1 made it a draft published at once; print
 * requests v2 stops there: a repeat is a starting point the customer reviews
 * (a new deadline, a different quantity, today's price) and publishes through
 * the one publish door, which prices it again and runs the matching. Until
 * then nobody but the customer can see it, and an untouched copy expires with
 * the other abandoned drafts. The answer says `published: false, draft: true`.
 */
printRequestRoutes.post('/requests/:id/repeat', requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'request-repeat', 20, 3600);
  const user = c.get('user')!;
  const sourceId = str(c.req.param('id'), 'id', { min: 1, max: 60 });

  const src = await c.env.DB.prepare(
    `SELECT id, customer_id, title, description, category, quantity, material, color, dimensions,
            budget_iqd, deadline, governorate, delivery_pref, notes, visibility, customer_notes
       FROM community_requests WHERE id = ? AND customer_id = ?`
  )
    .bind(sourceId, user.id)
    .first<Record<string, unknown>>();
  if (!src) throw notFound('Request not found');

  const newRequestId = newId('req');
  const now = new Date().toISOString();
  // The abandoned-draft clock, not the board's: nothing is published here.
  const expires = new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO community_requests
       (id, customer_id, title, description, status, state, category, quantity, material, color,
        dimensions, budget_iqd, deadline, governorate, delivery_pref, notes, visibility,
        created_at, updated_at, expires_at, customer_notes)
     VALUES (?,?,?,?,'closed','draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      newRequestId, user.id, String(src.title ?? ''), String(src.description ?? ''),
      String(src.category ?? ''), Number(src.quantity ?? 1), String(src.material ?? ''),
      String(src.color ?? ''), String(src.dimensions ?? ''),
      // The old deadline has usually passed: the customer sets a new one.
      src.budget_iqd ?? null, null, String(src.governorate ?? ''),
      String(src.delivery_pref ?? ''), String(src.notes ?? ''), String(src.visibility ?? 'public'),
      now, now, expires, String(src.customer_notes ?? '')
    )
    .run();

  // Copy the attachments — objects and rows — and carry the measurement across,
  // because the bytes are identical and re-measuring them would cost time to
  // reach the same answer.
  const { results: files } = await c.env.DB.prepare(
    'SELECT * FROM community_request_files WHERE request_id = ?'
  ).bind(sourceId).all<Record<string, unknown>>();

  const fileIdMap = new Map<string, string>();
  for (const f of files ?? []) {
    const object = await getMediaObject(c.env, 'private', String(f.file_key));
    if (!object) continue; // a missing object is skipped, not fatal
    const ext = String(f.file_name).includes('.') ? String(f.file_name).split('.').pop()! : 'bin';
    const key = `requests/${user.id}/${newId()}.${ext}`;
    const copiedBytes = await object.arrayBuffer();
    await putMediaObject(
      c.env,
      {
        key,
        visibility: 'private',
        domain: 'requests',
        mime: String(f.content_type || 'application/octet-stream'),
        bytes: copiedBytes.byteLength,
        ownerId: user.id,
        entityId: newRequestId,
        originalName: String(f.file_name || ''),
      },
      copiedBytes,
      { httpMetadata: { contentType: String(f.content_type || 'application/octet-stream'), cacheControl: 'private, max-age=0' } }
    );
    const newFileId = newId('crf');
    fileIdMap.set(String(f.id), newFileId);

    let previewKey = '';
    if (f.preview_key) {
      const prev = await getMediaObject(c.env, 'private', String(f.preview_key));
      if (prev) {
        previewKey = `request-previews/${newRequestId}/${newFileId}.lvm`;
        const previewBytes = await prev.arrayBuffer();
        await putMediaObject(
          c.env,
          {
            key: previewKey,
            visibility: 'private',
            domain: 'print-requests',
            mime: 'application/octet-stream',
            bytes: previewBytes.byteLength,
            ownerId: user.id,
            entityId: newRequestId,
          },
          previewBytes,
          { httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, max-age=0' } }
        );
      }
    }

    await c.env.DB.prepare(
      `INSERT INTO community_request_files
         (id, request_id, file_key, file_name, content_type, size_bytes, kind,
          model_format, analysis, analysed_at, preview_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        newFileId, newRequestId, key, String(f.file_name), String(f.content_type),
        Number(f.size_bytes ?? 0), String(f.kind), String(f.model_format ?? ''),
        String(f.analysis ?? ''), (f.analysed_at as string | null) ?? null, previewKey
      )
      .run();
  }

  // And the print spec, pointing at the COPIED file rather than the original.
  const spec = await c.env.DB.prepare('SELECT * FROM community_print_requests WHERE request_id = ?')
    .bind(sourceId)
    .first<Record<string, unknown>>();
  if (spec) {
    await c.env.DB.prepare(
      `INSERT INTO community_print_requests
         (request_id, process, material_id, color_hex, color_name, quality, infill_percent,
          supports, colors_count, post_processing_minutes, primary_file_id,
          source_kind, source_provider, source_url, source_meta, analysis, completeness,
          estimate, source_type, process_unsure, material_unsure, stated_dims)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        newRequestId, spec.process, spec.material_id, spec.color_hex, spec.color_name,
        spec.quality, spec.infill_percent, spec.supports, spec.colors_count,
        spec.post_processing_minutes,
        spec.primary_file_id ? (fileIdMap.get(String(spec.primary_file_id)) ?? null) : null,
        spec.source_kind, spec.source_provider, spec.source_url, spec.source_meta,
        String(spec.analysis ?? '{}'),
        Number(spec.completeness ?? 0),
        // The PRICE is deliberately NOT copied — prices move, and the publish
        // prices it again, today. Only the hardware list rides along (its
        // itemised lines are where the accessory choice lives), so publishing
        // the copy as stored keeps the magnets the source asked for.
        JSON.stringify({ accessory_lines: parseJson<{ accessory_lines?: unknown[] }>(spec.estimate, {}).accessory_lines ?? [] }),
        String(spec.source_type ?? ''), Number(spec.process_unsure ?? 0), Number(spec.material_unsure ?? 0),
        String(spec.stated_dims ?? '')
      )
      .run();
  }

  await audit(c.env.DB, user.id, 'print.request_repeated', newRequestId, { from: sourceId, state: 'draft' });
  return c.json(
    { success: true, request_id: newRequestId, files: fileIdMap.size, published: false, draft: true },
    201
  );
});

// ------------------------------------------------------------ 9. my requests

/**
 * THE CUSTOMER'S OWN LIST — richer than the public board, and only ever theirs.
 *
 * `publicRequest()` in worker/routes/marketplace.ts is a privacy WHITELIST: it
 * decides what a stranger may see about somebody's request. The owner's "My
 * requests" screen needs more than that — the estimate, the material, the
 * merchant they chose, the promised ETA — and the wrong way to get it would be
 * to widen the whitelist, because a whitelist that keeps growing stops being
 * one. So this is a separate, owner-scoped route: `WHERE r.customer_id = ?` is
 * in the SQL, not in a filter afterwards, and it joins the print side that the
 * public board does not know about at all.
 *
 * The thumbnail is the preview KEY, not a URL. Turning it into something
 * fetchable goes through the marketplace's existing file route, which checks
 * who is asking; emitting a public URL here would quietly make every uploaded
 * model world-readable.
 */
printRequestRoutes.get('/my-requests', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.title, r.state, r.status, r.quantity, r.material, r.color,
            r.budget_iqd, r.deadline, r.governorate, r.offer_count, r.created_at,
            r.accepted_offer_id, r.community_order_id, r.revision, r.expires_at, r.published_at,
            p.process_unsure, p.material_unsure, p.source_type,
            p.material_id, p.color_hex, p.color_name, p.process, p.quality,
            p.estimate_low_iqd, p.estimate_high_iqd, p.estimate_confidence,
            p.completeness, p.primary_file_id, p.source_kind, p.source_provider,
            f.preview_key AS preview_key, f.file_name AS primary_file_name,
            f.model_format AS primary_format,
            o.price_iqd AS accepted_price_iqd, o.completion_days AS accepted_days,
            m.name AS accepted_merchant_name,
            (SELECT COUNT(*) FROM community_request_files cf WHERE cf.request_id = r.id) AS file_count
       FROM community_requests r
       LEFT JOIN community_print_requests p ON p.request_id = r.id
       LEFT JOIN community_request_files f ON f.id = p.primary_file_id
       LEFT JOIN community_offers o ON o.id = r.accepted_offer_id
       LEFT JOIN community_merchants m ON m.id = o.merchant_id
      WHERE r.customer_id = ?
      ORDER BY r.created_at DESC
      LIMIT 50`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();

  return c.json({
    success: true,
    requests: (results ?? []).map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      state: String(r.state ?? ''),
      quantity: Number(r.quantity ?? 1),
      material: String(r.material ?? ''),
      color: String(r.color ?? ''),
      budget_iqd: r.budget_iqd === null ? null : Number(r.budget_iqd),
      deadline: r.deadline === null ? null : String(r.deadline),
      governorate: String(r.governorate ?? ''),
      offer_count: Number(r.offer_count ?? 0),
      file_count: Number(r.file_count ?? 0),
      created_at: String(r.created_at ?? ''),
      revision: Number(r.revision ?? 1),
      expires_at: (r.expires_at as string | null) ?? null,
      published_at: (r.published_at as string | null) ?? null,
      // The print side is null for a request made before this system, or one
      // that was never published through the wizard. The UI renders the plain
      // card for those rather than pretending there is a measurement.
      print: r.material_id === null && r.estimate_low_iqd === null && r.primary_file_id === null
        ? null
        : {
            process: String(r.process ?? 'fdm'),
            material_id: String(r.material_id ?? ''),
            color_hex: String(r.color_hex ?? ''),
            color_name: String(r.color_name ?? ''),
            quality: String(r.quality ?? 'standard'),
            estimate_low_iqd: r.estimate_low_iqd === null ? null : Number(r.estimate_low_iqd),
            estimate_high_iqd: r.estimate_high_iqd === null ? null : Number(r.estimate_high_iqd),
            estimate_confidence: String(r.estimate_confidence ?? '') || null,
            completeness: Number(r.completeness ?? 0),
            primary_file_id: r.primary_file_id === null ? null : String(r.primary_file_id),
            primary_file_name: String(r.primary_file_name ?? ''),
            primary_format: String(r.primary_format ?? ''),
            // A key, never a URL — see the note above.
            has_preview: !!String(r.preview_key ?? ''),
            source_kind: String(r.source_kind ?? 'upload'),
            source_provider: String(r.source_provider ?? ''),
            source_type: effectiveSourceType(r),
            process_unsure: Number(r.process_unsure ?? 0) === 1,
            material_unsure: Number(r.material_unsure ?? 0) === 1,
          },
      // Present only once the customer has chosen. Before that the merchant is
      // nobody's business, including the customer's own list.
      accepted: r.accepted_offer_id
        ? {
            offer_id: String(r.accepted_offer_id),
            order_id: r.community_order_id === null ? null : String(r.community_order_id),
            merchant_name: String(r.accepted_merchant_name ?? ''),
            price_iqd: r.accepted_price_iqd === null ? null : Number(r.accepted_price_iqd),
            completion_days: r.accepted_days === null ? null : Number(r.accepted_days),
          }
        : null,
    })),
  });
});
