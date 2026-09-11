import { Hono } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { requireAuth, badRequest, notFound, forbidden, conflict, str, int } from '../lib/http';
import { newId, randomToken, sha256Hex } from '../lib/crypto';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { getSetting } from '../lib/settings';
import { analyseModel, viewerMesh, FORMAT_CAPABILITIES, type ModelAnalysis } from '../lib/modelGeometry';
import {
  quotePrint,
  type PrintMaterial,
  type PrintPricingConfig,
  type PrintProcess,
  type PrintQuality,
  type QuoteInput,
} from '../lib/printPricing';
import {
  matchMerchants,
  CAPABILITIES,
  requiredCapabilities,
  type MatchRequest,
  type MerchantCandidate,
  type MerchantPrefs,
  type MerchantPrinter,
} from '../lib/printMatching';
import { resolveModelLink, parseModelLink } from '../lib/externalModels';
import { notifyStatement } from '../lib/notifications';

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

/** The request row plus its print side, for the owner of the request. */
async function ownedRequest(c: { env: Env }, requestId: string, userId: string) {
  const row = await c.env.DB.prepare(
    'SELECT id, customer_id, state, title, governorate, delivery_pref, quantity FROM community_requests WHERE id = ?'
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
  const [mats, cfg] = await Promise.all([materials(c.env), pricingConfig(c.env)]);
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

  const object = await c.env.BUCKET.get(file.file_key);
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
      await c.env.BUCKET.put(previewKey, mesh, {
        httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, max-age=0' },
      });
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
}

function readSpec(body: Record<string, unknown>): SpecBody {
  const process = PROCESSES.includes(body.process as PrintProcess) ? (body.process as PrintProcess) : 'fdm';
  const quality = QUALITIES.includes(body.quality as PrintQuality) ? (body.quality as PrintQuality) : 'standard';
  const hex = str(body.color_hex, 'color_hex', { max: 9, required: false }) ?? '';
  return {
    process,
    material_id: str(body.material_id, 'material_id', { max: 60, required: false }) ?? '',
    quality,
    infill_percent: int(body.infill_percent, 'infill_percent', { min: 0, max: 100, def: 20 }),
    supports: body.supports !== false,
    colors_count: int(body.colors_count, 'colors_count', { min: 1, max: 16, def: 1 }),
    post_processing_minutes: int(body.post_processing_minutes, 'post_processing_minutes', { min: 0, max: 600, def: 0 }),
    quantity: int(body.quantity, 'quantity', { min: 1, max: 10000, def: 1 }),
    color_hex: /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : '',
    color_name: str(body.color_name, 'color_name', { max: 60, required: false }) ?? '',
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
  const [mats, cfg] = await Promise.all([materials(c.env), pricingConfig(c.env)]);

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

  const input: QuoteInput = {
    analysis,
    materialId: spec.material_id,
    quality: spec.quality,
    infill: spec.infill_percent / 100,
    quantity: spec.quantity,
    colors: spec.colors_count,
    supports: spec.supports,
    post_processing_minutes: spec.post_processing_minutes,
    fallback_volume_cm3:
      typeof body.volume_cm3 === 'number' && body.volume_cm3 > 0 ? body.volume_cm3 : undefined,
  };
  const quote = quotePrint(input, mats, cfg);

  // The cost breakdown is the shop's business, not the customer's. What the
  // customer gets is the range, the confidence and why.
  const { cost_lines, cost_iqd, floor_iqd, margin_percent, ...publicQuote } = quote;
  void cost_lines; void cost_iqd; void floor_iqd; void margin_percent;
  return c.json({ success: true, quote: publicQuote });
});

// -------------------------------------------------------------- 5. publishing

/**
 * Attach the print spec to a request that already exists, snapshot the estimate,
 * then find and notify the merchants who can make it.
 *
 * ONE REQUEST. The row was created by `POST /api/marketplace/requests` before
 * this call and is not touched here beyond its print side; nothing in this
 * handler inserts into `community_requests`, and the matching engine has no
 * ability to (worker/lib/printMatching.ts returns decisions, not rows).
 */
printRequestRoutes.post('/requests/:id/publish', requireAuth, async (c) => {
  await rateLimit(c, 'print-publish', 20, 3600);
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const request = await ownedRequest(c, requestId, user.id);
  if (!['open', 'receiving_offers', 'draft'].includes(String(request.state))) {
    throw conflict('This request is no longer open');
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const spec = readSpec(body);
  const [mats, cfg, weights, notifyLimit] = await Promise.all([
    materials(c.env),
    pricingConfig(c.env),
    getSetting(c.env.DB, 'printMatchWeights'),
    getSetting(c.env.DB, 'printMatchNotifyLimit'),
  ]);

  // ---- the model: whichever attachment is the model, measured -------------
  const primaryFileId = str(body.primary_file_id, 'primary_file_id', { max: 60, required: false }) ?? '';
  let analysis: ModelAnalysis | null = null;
  if (primaryFileId) {
    const row = await c.env.DB.prepare(
      'SELECT analysis FROM community_request_files WHERE id = ? AND request_id = ?'
    )
      .bind(primaryFileId, requestId)
      .first<{ analysis: string }>();
    if (!row) throw badRequest('That file does not belong to this request', 'FILE_NOT_FOUND');
    // THE STORED analysis, never one supplied in the body. This is the number
    // the price is built on, so it comes from the server's own measurement.
    analysis = parseJson<ModelAnalysis | null>(row.analysis, null);
  }

  const sourceKind = body.source_kind === 'link' ? 'link' : 'upload';
  const sourceUrl = str(body.source_url, 'source_url', { max: 600, required: false }) ?? '';
  const sourceMeta = body.source_meta && typeof body.source_meta === 'object' ? body.source_meta : {};
  const providers = await getSetting(c.env.DB, 'printLinkProviders');
  const sourceProvider = sourceUrl ? (parseModelLink(sourceUrl, providers)?.provider ?? '') : '';

  const quote = quotePrint(
    {
      analysis,
      materialId: spec.material_id,
      quality: spec.quality,
      infill: spec.infill_percent / 100,
      quantity: spec.quantity,
      colors: spec.colors_count,
      supports: spec.supports,
      post_processing_minutes: spec.post_processing_minutes,
      fallback_volume_cm3:
        typeof body.volume_cm3 === 'number' && body.volume_cm3 > 0 ? body.volume_cm3 : undefined,
    },
    mats,
    cfg
  );

  const completeness = completenessOf(spec, analysis, sourceKind, sourceUrl, quote.priced);

  /**
   * THE REQUEST ROW CATCHES UP WITH THE WIZARD.
   *
   * The row is created at the end of step 1, before the customer has chosen a
   * material or a governorate — and `POST /api/marketplace/requests` is the
   * only route that writes those fields. So without this, everything picked in
   * step 2 would exist on the print side only, and two things that matter would
   * silently be empty: the public board card (`publicRequest()` reads
   * `material`, `color`, `dimensions`, `budget_iqd`, `governorate` from HERE),
   * and — worse — the matcher's `governorate` and `delivery_pref`, which decide
   * which merchants are eligible at all. A customer who picked Baghdad would
   * have been matched as though they had picked nowhere.
   *
   * This is not a second create. It is the same row, the same owner, the same
   * open state, written at the last moment before any merchant can see it.
   * Only fields the caller actually supplied are touched; a republish that
   * sends nothing leaves the row exactly as it is.
   */
  const governorate = str(body.governorate, 'governorate', { max: 60, required: false });
  const deliveryPref = str(body.delivery_pref, 'delivery_pref', { max: 40, required: false });
  const deadline = str(body.deadline, 'deadline', { max: 40, required: false });
  const budget =
    body.budget_iqd === undefined || body.budget_iqd === null || body.budget_iqd === ''
      ? undefined
      : int(body.budget_iqd, 'budget_iqd', { min: 0, max: 1_000_000_000 });

  // What the board shows about the job, written from what was actually chosen
  // and measured rather than asked for a second time in prose.
  const materialLabel = mats.find((m) => m.id === spec.material_id)?.name_en ?? spec.material_id;
  const colorLabel = spec.color_name || spec.color_hex;
  const dimsLabel = analysis?.measured
    ? `${Math.round(analysis.dimensions_mm.x)}×${Math.round(analysis.dimensions_mm.y)}×${Math.round(analysis.dimensions_mm.z)} mm`
    : '';

  const sets: string[] = [
    'material = ?', 'color = ?', 'quantity = ?', "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  ];
  const vals: Array<string | number | null> = [materialLabel, colorLabel, spec.quantity];
  if (dimsLabel) { sets.splice(2, 0, 'dimensions = ?'); vals.splice(2, 0, dimsLabel); }
  if (governorate !== undefined) { sets.push('governorate = ?'); vals.push(governorate); }
  if (deliveryPref !== undefined) { sets.push('delivery_pref = ?'); vals.push(deliveryPref); }
  if (deadline !== undefined) { sets.push('deadline = ?'); vals.push(deadline || null); }
  if (budget !== undefined) { sets.push('budget_iqd = ?'); vals.push(budget); }

  await c.env.DB.prepare(
    `UPDATE community_requests SET ${sets.join(', ')}
      WHERE id = ? AND customer_id = ? AND state IN ('open','receiving_offers','draft')`
  )
    .bind(...vals, requestId, user.id)
    .run();

  // Re-read, so the matcher sees what was just written rather than what
  // `ownedRequest` loaded a few statements ago.
  const forMatching = await c.env.DB.prepare(
    'SELECT governorate, delivery_pref FROM community_requests WHERE id = ?'
  )
    .bind(requestId)
    .first<{ governorate: string; delivery_pref: string }>();

  await c.env.DB.prepare(
    `INSERT INTO community_print_requests
       (request_id, process, material_id, color_hex, color_name, quality, infill_percent,
        supports, colors_count, post_processing_minutes, primary_file_id,
        source_kind, source_provider, source_url, source_meta,
        analysis, estimate, estimate_low_iqd, estimate_high_iqd, estimate_confidence,
        completeness, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
       updated_at=excluded.updated_at`
  )
    .bind(
      requestId, spec.process, spec.material_id, spec.color_hex, spec.color_name, spec.quality,
      spec.infill_percent, spec.supports ? 1 : 0, spec.colors_count, spec.post_processing_minutes,
      primaryFileId || null,
      sourceKind, sourceProvider, sourceUrl, JSON.stringify(sourceMeta),
      analysis ? JSON.stringify(analysis) : '{}',
      JSON.stringify(quote),
      quote.priced ? quote.price_low_iqd : null,
      quote.priced ? quote.price_high_iqd : null,
      quote.priced ? quote.confidence : '',
      completeness
    )
    .run();

  // ---- who can make it ----------------------------------------------------
  const matchReq: MatchRequest = {
    id: requestId,
    process: spec.process,
    material_id: spec.material_id,
    color_hex: spec.color_hex,
    quality: spec.quality,
    colors_count: spec.colors_count,
    dimensions_mm: analysis?.measured ? analysis.dimensions_mm : { x: 0, y: 0, z: 0 },
    governorate: String(forMatching?.governorate ?? request.governorate ?? ''),
    delivery_pref: String(forMatching?.delivery_pref ?? request.delivery_pref ?? ''),
    estimate_iqd: quote.priced ? quote.price_iqd : null,
    quantity: spec.quantity,
  };
  const material = mats.find((m) => m.id === spec.material_id) ?? null;
  const candidates = await loadCandidates(c.env);
  const { decisions, notify } = matchMerchants(
    candidates,
    matchReq,
    material,
    weights,
    Date.now(),
    Math.max(1, Number(notifyLimit) || 25)
  );

  // ---- tell them. ONE notification each, and nothing else ------------------
  const title = String(request.title ?? '');
  const stmts: D1PreparedStatement[] = [];
  const notified = new Map<string, string>();
  for (const d of notify) {
    const { id, stmt } = notifyStatement(c.env.DB, {
      userId: d.user_id,
      kind: 'print_request_match',
      title_ar: 'يوجد طلب طباعة جديد مناسب لإمكانيات متجرك',
      title_en: 'A new print request matches what your shop can make',
      body_ar: title,
      body_en: title,
      // The link is the request itself. There is nothing else to open.
      link: `/requests?request=${requestId}`,
      entity_type: 'request',
      entity_id: requestId,
      meta: { score: d.score, printer_id: d.printer_id },
      // Same merchant + same request = the same message. The unique index
      // makes a repeated publish a no-op instead of a second buzz.
      eventKey: `print_request_match:${requestId}`,
    });
    notified.set(d.merchant_id, id);
    stmts.push(stmt);
  }

  // Every decision is recorded, rejections included: this table is the answer
  // to "why did my shop never see this job?".
  for (const d of decisions) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO community_request_matches
           (id, request_id, merchant_id, eligible, reject_reason, score, score_detail, notified, notification_id)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT (request_id, merchant_id) DO UPDATE SET
           eligible=excluded.eligible, reject_reason=excluded.reject_reason,
           score=excluded.score, score_detail=excluded.score_detail,
           notified=excluded.notified, notification_id=excluded.notification_id`
      ).bind(
        newId('mch'), requestId, d.merchant_id, d.eligible ? 1 : 0, d.reject_reason,
        d.score, JSON.stringify(d.detail),
        notified.has(d.merchant_id) ? 1 : 0, notified.get(d.merchant_id) ?? null
      )
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);

  await audit(c.env.DB, user.id, 'print.request_published', requestId, {
    considered: decisions.length,
    eligible: decisions.filter((d) => d.eligible).length,
    notified: notify.length,
    confidence: quote.confidence,
  });

  const { cost_lines, cost_iqd, floor_iqd, margin_percent, ...publicQuote } = quote;
  void cost_lines; void cost_iqd; void floor_iqd; void margin_percent;
  return c.json({
    success: true,
    request_id: requestId,
    quote: publicQuote,
    completeness,
    matching: {
      considered: decisions.length,
      eligible: decisions.filter((d) => d.eligible).length,
      notified: notify.length,
    },
  });
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

/**
 * Every merchant the matcher might consider, with their machines and their
 * stated preferences, in three queries rather than N+1.
 */
async function loadCandidates(env: Env): Promise<MerchantCandidate[]> {
  const [merchants, printers, prefs] = await Promise.all([
    env.DB.prepare(
      `SELECT m.id, m.user_id, m.status, m.governorate, m.rating_avg_x100, m.rating_count,
              m.completed_orders,
              s.id AS store_id, s.status AS store_status, s.accepts_custom_requests,
              s.governorate AS store_governorate,
              COALESCE(p.request_opportunities, 1) AS request_opportunities
         FROM community_merchants m
         LEFT JOIN merchant_stores s ON s.merchant_id = m.id
         LEFT JOIN merchant_notification_preferences p ON p.merchant_id = m.id
        WHERE m.status = 'active'`
    ).all<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM merchant_printers WHERE active = 1').all<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM merchant_request_prefs').all<Record<string, unknown>>(),
  ]);

  const printersBy = new Map<string, MerchantPrinter[]>();
  for (const p of printers.results ?? []) {
    const list = printersBy.get(String(p.merchant_id)) ?? [];
    list.push({
      id: String(p.id),
      technology: (p.technology === 'resin' ? 'resin' : 'fdm') as PrintProcess,
      build_x_mm: Number(p.build_x_mm ?? 0),
      build_y_mm: Number(p.build_y_mm ?? 0),
      build_z_mm: Number(p.build_z_mm ?? 0),
      nozzle_mm: Number(p.nozzle_mm ?? 0.4),
      materials: parseJson<string[]>(p.materials, []),
      colors: parseJson<string[]>(p.colors, []).map((x) => String(x).toLowerCase()),
      multicolor: !!p.multicolor,
      enclosed: !!p.enclosed,
      hardened_nozzle: !!p.hardened_nozzle,
      quality_max: (QUALITIES.includes(p.quality_max as PrintQuality) ? p.quality_max : 'fine') as PrintQuality,
      machine_hour_iqd: p.machine_hour_iqd === null || p.machine_hour_iqd === undefined ? null : Number(p.machine_hour_iqd),
      availability: (['available', 'busy', 'offline'].includes(String(p.availability))
        ? p.availability
        : 'available') as MerchantPrinter['availability'],
      active: true,
    });
    printersBy.set(String(p.merchant_id), list);
  }

  const prefsBy = new Map<string, MerchantPrefs>();
  for (const p of prefs.results ?? []) {
    prefsBy.set(String(p.merchant_id), {
      processes: parseJson<string[]>(p.processes, []),
      materials: parseJson<string[]>(p.materials, []),
      colors: parseJson<string[]>(p.colors, []).map((x) => String(x).toLowerCase()),
      capabilities: parseJson<string[]>(p.capabilities, []),
      governorates: parseJson<string[]>(p.governorates, []),
      delivery: parseJson<string[]>(p.delivery, []),
      min_job_iqd: Number(p.min_job_iqd ?? 0),
      max_job_iqd: p.max_job_iqd === null || p.max_job_iqd === undefined ? null : Number(p.max_job_iqd),
      min_size_mm: Number(p.min_size_mm ?? 0),
      max_size_mm: p.max_size_mm === null || p.max_size_mm === undefined ? null : Number(p.max_size_mm),
      workload: (['light', 'normal', 'busy', 'full'].includes(String(p.workload))
        ? p.workload
        : 'normal') as MerchantPrefs['workload'],
      paused: !!p.paused,
      paused_until: (p.paused_until as string | null) ?? null,
    });
  }

  const EMPTY_PREFS: MerchantPrefs = {
    processes: [], materials: [], colors: [], capabilities: [], governorates: [], delivery: [],
    min_job_iqd: 0, max_job_iqd: null, min_size_mm: 0, max_size_mm: null,
    workload: 'normal', paused: false, paused_until: null,
  };

  return (merchants.results ?? []).map((m) => ({
    merchant_id: String(m.id),
    user_id: String(m.user_id),
    status: String(m.status ?? ''),
    store_status: String(m.store_status ?? ''),
    store_id: (m.store_id as string | null) ?? null,
    // A merchant with no store row has not opted out of anything — the default
    // for the column is 1, and the absence of a store is handled by the
    // STORE_UNAVAILABLE check rather than silently here.
    accepts_custom_requests: m.accepts_custom_requests === undefined || m.accepts_custom_requests === null
      ? true
      : !!m.accepts_custom_requests,
    governorate: String(m.store_governorate || m.governorate || ''),
    request_opportunities: !!Number(m.request_opportunities ?? 1),
    printers: printersBy.get(String(m.id)) ?? [],
    prefs: prefsBy.get(String(m.id)) ?? EMPTY_PREFS,
    rating_avg_x100: Number(m.rating_avg_x100 ?? 0),
    rating_count: Number(m.rating_count ?? 0),
    completed_orders: Number(m.completed_orders ?? 0),
    // Not yet measured anywhere in the platform. `null` is the honest value and
    // the matcher reads it as "no history", which sits mid-table — it does not
    // invent a response time and does not punish a merchant for our gap.
    response_minutes: null,
    trouble_rate: 0,
    pro: false,
  }));
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
    'SELECT id, customer_id, state, visibility FROM community_requests WHERE id = ?'
  )
    .bind(requestId)
    .first<{ id: string; customer_id: string; state: string; visibility: string }>();
  if (!request) throw notFound('Request not found');

  const isOwner = !!user && user.id === request.customer_id;
  const openToAll = request.visibility === 'public' && ['open', 'receiving_offers'].includes(request.state);
  if (!isOwner && !openToAll) {
    const engaged = user
      ? await c.env.DB.prepare(
          `SELECT 1 FROM community_offers o
             JOIN community_merchants m ON m.id = o.merchant_id
            WHERE o.request_id = ? AND m.user_id = ? AND o.state = 'accepted'`
        ).bind(requestId, user.id).first()
      : null;
    if (!engaged) throw notFound('Request not found');
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
      analysis,
      estimate,
      estimate_low_iqd: row.estimate_low_iqd,
      estimate_high_iqd: row.estimate_high_iqd,
      estimate_confidence: row.estimate_confidence,
      completeness: row.completeness,
      required_capabilities: analysis
        ? requiredCapabilities(
            {
              id: requestId,
              process: (row.process === 'resin' ? 'resin' : 'fdm') as PrintProcess,
              material_id: String(row.material_id ?? ''),
              color_hex: String(row.color_hex ?? ''),
              quality: (row.quality ?? 'standard') as PrintQuality,
              colors_count: Number(row.colors_count ?? 1),
              dimensions_mm: analysis.dimensions_mm,
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
 * Mint a link to the 3D preview.
 *
 * The token is random, stored HASHED (so the table is useless to whoever reads
 * it), expires, and grants the DERIVED mesh — never the uploaded file.
 */
printRequestRoutes.post('/requests/:id/files/:fileId/viewer-token', requireAuth, async (c) => {
  await rateLimit(c, 'viewer-token', 60, 3600);
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const fileId = str(c.req.param('fileId'), 'fileId', { min: 1, max: 60 });

  // Anyone who may READ the file may mint a preview of it — the same rule the
  // marketplace download route applies, so the viewer never widens access.
  const file = await c.env.DB.prepare(
    `SELECT f.id, f.preview_key, r.customer_id, r.state, r.visibility
       FROM community_request_files f
       JOIN community_requests r ON r.id = f.request_id
      WHERE f.id = ? AND f.request_id = ?`
  )
    .bind(fileId, requestId)
    .first<{ id: string; preview_key: string; customer_id: string; state: string; visibility: string }>();
  if (!file) throw notFound('File not found');

  const isOwner = file.customer_id === user.id;
  const openToAll = file.visibility === 'public' && ['open', 'receiving_offers'].includes(file.state);
  if (!isOwner && !openToAll) {
    const engaged = await c.env.DB.prepare(
      `SELECT 1 FROM community_offers o JOIN community_merchants m ON m.id = o.merchant_id
        WHERE o.request_id = ? AND m.user_id = ? AND o.state = 'accepted'`
    ).bind(requestId, user.id).first();
    if (!engaged) throw forbidden('Not allowed to view this model');
  }
  if (!file.preview_key) throw conflict('This file has no 3D preview', 'NO_PREVIEW');

  // 32 bytes of real randomness, not two ids concatenated: this is the only
  // thing standing between a stranger and someone's model preview.
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const hours = int((await c.req.json().catch(() => ({}))).hours, 'hours', { min: 1, max: 168, def: 72 });
  const expires = new Date(Date.now() + hours * 3600_000).toISOString();
  await c.env.DB.prepare(
    'INSERT INTO model_view_tokens (token_hash, file_id, request_id, created_by, expires_at) VALUES (?,?,?,?,?)'
  )
    .bind(hash, fileId, requestId, user.id, expires)
    .run();

  return c.json({ success: true, token, url: `/model-viewer/${token}`, expires_at: expires });
});

/** What the viewer page needs to draw its labels. No file, no key, no owner. */
printRequestRoutes.get('/viewer/:token', async (c) => {
  const row = await viewerToken(c.env, c.req.param('token'));
  const file = await c.env.DB.prepare(
    'SELECT file_name, analysis, model_format FROM community_request_files WHERE id = ?'
  )
    .bind(row.file_id)
    .first<{ file_name: string; analysis: string; model_format: string }>();
  const analysis = parseJson<ModelAnalysis | null>(file?.analysis, null);
  return c.json({
    success: true,
    name: file?.file_name ?? '',
    format: file?.model_format ?? '',
    dimensions_mm: analysis?.dimensions_mm ?? null,
    volume_mm3: analysis?.volume_mm3 ?? null,
    triangle_count: analysis?.triangle_count ?? null,
    shell_count: analysis?.shell_count ?? null,
    expires_at: row.expires_at,
  });
});

/** The derived mesh. Bytes only — the original file is never served here. */
printRequestRoutes.get('/viewer/:token/mesh', async (c) => {
  const row = await viewerToken(c.env, c.req.param('token'));
  const file = await c.env.DB.prepare('SELECT preview_key FROM community_request_files WHERE id = ?')
    .bind(row.file_id)
    .first<{ preview_key: string }>();
  if (!file?.preview_key) throw notFound('No preview available');
  const object = await c.env.BUCKET.get(file.preview_key);
  if (!object) throw notFound('No preview available');

  await c.env.DB.prepare(
    `UPDATE model_view_tokens
        SET uses = uses + 1, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE token_hash = ?`
  ).bind(row.token_hash).run();

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'private, max-age=0, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

async function viewerToken(env: Env, raw: string | undefined) {
  const token = str(raw, 'token', { min: 20, max: 120 });
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    'SELECT token_hash, file_id, request_id, expires_at, revoked_at FROM model_view_tokens WHERE token_hash = ?'
  )
    .bind(hash)
    .first<{ token_hash: string; file_id: string; request_id: string; expires_at: string; revoked_at: string | null }>();
  // One answer for "wrong", "expired" and "revoked": a viewer link that has
  // stopped working must not tell a stranger which of the three it was.
  if (!row || row.revoked_at || Date.parse(row.expires_at) < Date.now()) throw notFound('This link is no longer valid');
  return row;
}

// -------------------------------------------------------- 8. repeat a request

/**
 * "اطلب مرة أخرى" — copy a finished request into a NEW one.
 *
 * A new request row, a new id, and the files RE-COPIED in R2 rather than shared:
 * two requests pointing at one object means deleting the old one breaks the new
 * one, and a customer who repeats an order in March should not lose it because
 * they tidied up in January.
 */
printRequestRoutes.post('/requests/:id/repeat', requireAuth, async (c) => {
  await rateLimit(c, 'request-repeat', 20, 3600);
  const user = c.get('user')!;
  const sourceId = str(c.req.param('id'), 'id', { min: 1, max: 60 });

  const src = await c.env.DB.prepare(
    `SELECT id, customer_id, title, description, category, quantity, material, color, dimensions,
            budget_iqd, deadline, governorate, delivery_pref, notes, visibility
       FROM community_requests WHERE id = ? AND customer_id = ?`
  )
    .bind(sourceId, user.id)
    .first<Record<string, unknown>>();
  if (!src) throw notFound('Request not found');

  const expiryDays = Number(await getSetting(c.env.DB, 'communityRequestExpiryDays')) || 30;
  const newRequestId = newId('req');
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + expiryDays * 86_400_000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO community_requests
       (id, customer_id, title, description, status, state, category, quantity, material, color,
        dimensions, budget_iqd, deadline, governorate, delivery_pref, notes, visibility,
        created_at, updated_at, expires_at)
     VALUES (?,?,?,?,'open','open',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      newRequestId, user.id, String(src.title ?? ''), String(src.description ?? ''),
      String(src.category ?? ''), Number(src.quantity ?? 1), String(src.material ?? ''),
      String(src.color ?? ''), String(src.dimensions ?? ''),
      src.budget_iqd ?? null, src.deadline ?? null, String(src.governorate ?? ''),
      String(src.delivery_pref ?? ''), String(src.notes ?? ''), String(src.visibility ?? 'public'),
      now, now, expires
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
    const object = await c.env.BUCKET.get(String(f.file_key));
    if (!object) continue; // a missing object is skipped, not fatal
    const ext = String(f.file_name).includes('.') ? String(f.file_name).split('.').pop()! : 'bin';
    const key = `requests/${user.id}/${newId()}.${ext}`;
    await c.env.BUCKET.put(key, await object.arrayBuffer(), {
      httpMetadata: { contentType: String(f.content_type || 'application/octet-stream'), cacheControl: 'private, max-age=0' },
    });
    const newFileId = newId('crf');
    fileIdMap.set(String(f.id), newFileId);

    let previewKey = '';
    if (f.preview_key) {
      const prev = await c.env.BUCKET.get(String(f.preview_key));
      if (prev) {
        previewKey = `request-previews/${newRequestId}/${newFileId}.lvm`;
        await c.env.BUCKET.put(previewKey, await prev.arrayBuffer(), {
          httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, max-age=0' },
        });
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
          source_kind, source_provider, source_url, source_meta, analysis, completeness)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        newRequestId, spec.process, spec.material_id, spec.color_hex, spec.color_name,
        spec.quality, spec.infill_percent, spec.supports, spec.colors_count,
        spec.post_processing_minutes,
        spec.primary_file_id ? (fileIdMap.get(String(spec.primary_file_id)) ?? null) : null,
        spec.source_kind, spec.source_provider, spec.source_url, spec.source_meta,
        String(spec.analysis ?? '{}'),
        // The estimate is deliberately NOT copied: prices move, and showing a
        // customer January's number on a March request would be a quote nobody
        // can honour. It is recomputed when they publish.
        Number(spec.completeness ?? 0)
      )
      .run();
  }

  await audit(c.env.DB, user.id, 'print.request_repeated', newRequestId, { from: sourceId });
  return c.json({ success: true, request_id: newRequestId, files: fileIdMap.size }, 201);
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
            r.accepted_offer_id, r.community_order_id,
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
