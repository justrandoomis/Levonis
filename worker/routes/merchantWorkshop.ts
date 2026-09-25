/**
 * THE WORKSHOP'S SIDE OF THE REQUEST BOARD — /api/merchant/workshop/* (W5-B).
 *
 *   GET  /board                      «مناسب لي»: the open requests this
 *                                    workshop's verdict says it can make,
 *                                    filtered and cursor-paged, with a thumbnail
 *   GET  /requests/:id/eligibility   the live verdict for one request, with every
 *                                    failing reason (what to fix, in codes)
 *   POST /requests/:id/cost          cost the request's own model on one of the
 *                                    workshop's printers — PRIVATE to the workshop
 *   GET  /requests/:id/costs         this workshop's costings of that request
 *
 * Every answer is scoped to the session's own merchant in SQL; no id from the
 * client names whose data it is. The verdicts are worker/lib/eligibility.ts's,
 * read through worker/lib/printMatchingStore.ts.
 *
 * COSTING READS THE CUSTOMER'S FILE ON THE SERVER AND NEVER HANDS IT OVER
 * (audit 03 §9 G22, §11 item 21). The model is measured from the stored bytes
 * by the same `analyseModel` + `analysisFromGeometry` the calculator uses, and
 * priced by the same `priceForPrinter` on the workshop's own machine and
 * spools. The analysis row it leaves has NO file key and NO owner — nothing can
 * serve the bytes back through it — and the quote is the workshop's alone
 * (`print_quotes.merchant_id`, `request_id`). Its price reaches the customer
 * only if the workshop sends it as an offer («استخدم هذا كعرضي»), which then
 * marks the quote `offered`.
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, badRequest, conflict, int, notFound, oneOf, requireAuth, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { requireStoreOwner } from '../lib/merchantAuth';
import { communityClosedRefusal, communityMayEnter, readCommunityGate } from '../lib/communityGate';
import { merchantTakesNewWork, type RequestForAccess } from '../lib/communityRequests';
import { getMediaObject } from '../lib/mediaStorage';
import { analyseModel } from '../lib/modelGeometry';
import { analysisFromGeometry } from '../lib/printQuote/geometryAdapter';
import { analysisFingerprint } from '../lib/printQuote/slicerAdapter';
import { analysisStatements, loadMerchantPrinters, quoteStatements } from '../lib/printQuote/repository';
import {
  PLATFORM_TARGET_MARGIN_PERCENT,
  merchantQuote,
  platformMachineHourIqd,
  platformMinimumJobIqd,
  priceForPrinter,
} from './printQuote';
import { liveVerdict, merchantRematchPending, rematchNow, MATCH_ENGINE } from '../lib/printMatchingStore';
import { fileReadStatement, fileReader } from '../lib/requestFilePolicy';

export const merchantWorkshopRoutes = new Hono<AppContext>();
merchantWorkshopRoutes.use('*', requireAuth);

const nowIso = () => new Date().toISOString();

// ----------------------------------------------------------------- the board

/** `<sort instant>~<request id>`, both from rows this route returned. */
function readCursor(raw: string | undefined): { at: string; id: string } | null {
  if (!raw) return null;
  const i = raw.lastIndexOf('~');
  const at = i > 0 ? raw.slice(0, i) : '';
  const id = i > 0 ? raw.slice(i + 1) : '';
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) || !/^[\w-]{1,60}$/.test(id)) throw badRequest('Bad cursor', 'BAD_CURSOR');
  return { at, id };
}

/**
 * «مناسب لي» — THE REQUESTS THIS WORKSHOP CAN MAKE, NEWEST FIRST.
 *
 * Read from the persisted verdicts of the request's CURRENT revision decided
 * by engine 2 (0132) — never an older revision's. A workshop whose own
 * re-match is still queued (it just changed a printer) is re-matched first,
 * and so is one that has no engine-2 verdict yet (the first visit after W5-B
 * shipped), so the list is never behind the workshop's own edit. A workshop
 * that cannot take new work at all (store paused, plan lapsed, not taking
 * custom requests) gets an empty list and the reason, not a stale one.
 *
 * Filters: `process` (fdm|resin — a request whose customer was unsure of the
 * process is in both), `material` (a catalogue id), `governorate` (an id).
 */
merchantWorkshopRoutes.get('/board', async (c) => {
  const user = c.get('user')!;
  const ctx = await requireStoreOwner(c);
  // The board is Levo Community (DECISIONS 110): shut to this merchant, shut here.
  if (!communityMayEnter(await readCommunityGate(c.env.DB), user)) throw communityClosedRefusal();
  const q = c.req.query();
  const limit = int(q.limit, 'limit', { min: 1, max: 30, def: 20 });
  const process = q.process ? oneOf(q.process, 'process', ['fdm', 'resin'] as const) : '';
  const material = q.material ? str(q.material, 'material', { max: 60 }) : '';
  const governorate = q.governorate ? str(q.governorate, 'governorate', { max: 40 }) : '';
  const cursor = readCursor(q.cursor);

  const open = await merchantTakesNewWork(c.env.DB, {
    merchantStatus: ctx.merchant.status,
    storeStatus: ctx.store.status,
    ownerUserId: user.id,
  });
  const accepts = Number((ctx.store as unknown as Record<string, unknown>).accepts_custom_requests ?? 1) === 1;
  if (!open || !accepts) {
    return c.json({ success: true, requests: [], next_cursor: null, blocked: !open ? 'CANNOT_TAKE_WORK' : 'NOT_TAKING_REQUESTS' });
  }

  const decided = await c.env.DB.prepare(
    `SELECT 1 AS x FROM community_request_matches WHERE merchant_id = ? AND engine >= ? LIMIT 1`
  ).bind(ctx.merchant.id, MATCH_ENGINE).first();
  if (!decided || (await merchantRematchPending(c.env.DB, ctx.merchant.id))) {
    await rematchNow(c.env, 'merchant', ctx.merchant.id, decided ? 'board' : 'first_board');
  }

  const ts = nowIso();
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.title, r.description, r.quantity, r.material, r.color, r.dimensions, r.budget_iqd,
            r.deadline, r.governorate, r.delivery_pref, r.state, r.offer_count, r.created_at, r.expires_at,
            r.revision, r.customer_notes, COALESCE(r.published_at, r.created_at) AS sort_at,
            p.process, p.process_unsure, p.material_id, p.material_unsure,
            p.estimate_low_iqd, p.estimate_high_iqd,
            (SELECT f.id FROM community_request_files f
              WHERE f.request_id = r.id AND f.content_type LIKE 'image/%'
              ORDER BY f.created_at, f.id LIMIT 1) AS thumb_id,
            (SELECT COUNT(*) FROM community_request_files f WHERE f.request_id = r.id) AS file_count,
            EXISTS (SELECT 1 FROM community_request_files f
                     WHERE f.request_id = r.id AND f.kind = 'model' AND f.preview_key <> '') AS has_preview,
            (SELECT o.state FROM community_offers o
              WHERE o.request_id = r.id AND o.merchant_id = ?1 AND o.state IN ('pending','superseded','accepted')
              LIMIT 1) AS my_offer
       FROM community_request_matches m
       JOIN community_requests r ON r.id = m.request_id
       LEFT JOIN community_print_requests p ON p.request_id = r.id
      WHERE m.merchant_id = ?1 AND m.eligible = 1 AND m.engine >= ?2 AND m.revision = r.revision
        AND r.state IN ('open','receiving_offers') AND r.visibility = 'public'
        AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?3)
        AND r.customer_id <> ?4
        AND (?5 = '' OR COALESCE(p.process_unsure, 0) = 1 OR p.process = ?5)
        AND (?6 = '' OR (p.material_id = ?6 AND COALESCE(p.material_unsure, 0) = 0))
        AND (?7 = '' OR r.governorate = ?7)
        AND (?8 = '' OR COALESCE(r.published_at, r.created_at) < ?8
             OR (COALESCE(r.published_at, r.created_at) = ?8 AND r.id < ?9))
      ORDER BY sort_at DESC, r.id DESC
      LIMIT ?10`
  )
    .bind(ctx.merchant.id, MATCH_ENGINE, ts, user.id, process, material, governorate, cursor?.at ?? '', cursor?.id ?? '', limit + 1)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    success: true,
    requests: page.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      quantity: r.quantity,
      material: r.material,
      color: r.color,
      dimensions: r.dimensions,
      budget_iqd: r.budget_iqd,
      deadline: r.deadline,
      governorate: r.governorate,
      delivery_pref: r.delivery_pref,
      state: r.state,
      offer_count: r.offer_count,
      created_at: r.created_at,
      expires_at: r.expires_at,
      revision: r.revision,
      customer_notes: r.customer_notes ?? '',
      process: Number(r.process_unsure ?? 0) === 1 ? null : (r.process ?? null),
      material_id: Number(r.material_unsure ?? 0) === 1 ? null : (r.material_id || null),
      estimate_low_iqd: r.estimate_low_iqd ?? null,
      estimate_high_iqd: r.estimate_high_iqd ?? null,
      file_count: Number(r.file_count ?? 0),
      // The picture is read through the file route, which re-derives this
      // workshop's right to it (eligible → pictures) on every read.
      thumb_url: r.thumb_id ? `/api/marketplace/requests/${r.id}/files/${r.thumb_id}` : null,
      has_preview: !!Number(r.has_preview ?? 0),
      my_offer: r.my_offer ?? null,
    })),
    next_cursor: rows.length > limit && last ? `${last.sort_at}~${last.id}` : null,
  });
});

// ----------------------------------------------------------- one verdict

/** A request a merchant may ask about: anything but somebody's draft. */
async function requestRow(c: { env: AppContext['Bindings'] }, id: string) {
  const r = await c.env.DB.prepare(
    'SELECT id, customer_id, state, visibility, expires_at, revision FROM community_requests WHERE id = ?'
  ).bind(id).first<RequestForAccess & { revision: number }>();
  if (!r || r.state === 'draft') throw notFound('Request not found');
  return r;
}

/**
 * THE LIVE VERDICT for this workshop and one request — the same one the offer
 * route will ask — with every failing reason, the dimension each belongs to,
 * the machine it would run on, and whether the workshop would be told.
 */
merchantWorkshopRoutes.get('/requests/:id/eligibility', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  await requestRow(c, id);
  const live = await liveVerdict(c.env, id, ctx.merchant.id);
  if (!live) throw notFound('Request not found');
  const v = live.verdict;
  return c.json({
    success: true,
    request_id: id,
    revision: live.request.revision,
    eligible: v.eligible,
    reason: v.reason,
    reasons: v.reasons,
    dims: v.dims,
    notify: v.notify,
    notify_block: v.notify_block,
    printer: v.printer_id ? { id: v.printer_id, name: live.candidate.printer_names.get(v.printer_id) ?? '' } : null,
    stock_tracked: live.candidate.stock !== 'untracked',
  });
});

// ----------------------------------------------------------------- costing

/** The quote engine's quality words; a request's «ultra» is costed at its finest, «fine». */
const QUOTE_QUALITIES = ['draft', 'standard', 'fine'] as const;

/**
 * COST THIS REQUEST ON ONE OF MY PRINTERS — private, from the customer's own
 * file, without a copy. See the header for why nothing here can leak the file
 * or the price. May cost: an ELIGIBLE workshop (the live verdict) or the one
 * whose offer was accepted.
 */
merchantWorkshopRoutes.post('/requests/:id/cost', async (c) => {
  await rateLimit(c, 'request-costing', 30, 3600);
  const user = c.get('user')!;
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const r = await requestRow(c, id);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const { reader, gateClosed, verdict } = await fileReader(c.env, r, user, { allowAdmin: false });
  if (gateClosed) throw communityClosedRefusal();
  if (reader !== 'eligible' && reader !== 'engaged') {
    throw new HttpError(
      403,
      'Only a workshop that can make this request may cost it',
      'COSTING_NOT_ELIGIBLE',
      verdict ? { reason: verdict.reason, reasons: verdict.reasons } : undefined
    );
  }

  // THE MODEL: the one asked for, else the request's primary model, else its first.
  const print = await c.env.DB.prepare(
    'SELECT primary_file_id, material_id, material_unsure, quality, supports FROM community_print_requests WHERE request_id = ?'
  ).bind(id).first<Record<string, unknown>>();
  const wantedFile = str(body.file_id, 'file_id', { max: 60, required: false }) || String(print?.primary_file_id ?? '');
  const file = await c.env.DB.prepare(
    `SELECT id, file_key, file_name, size_bytes FROM community_request_files
      WHERE request_id = ?1 AND kind = 'model' AND (?2 = '' OR id = ?2)
      ORDER BY CASE WHEN id = ?2 THEN 0 ELSE 1 END, created_at LIMIT 1`
  ).bind(id, wantedFile).first<{ id: string; file_key: string; file_name: string; size_bytes: number }>();
  if (!file) throw conflict('This request has no 3D model to cost', 'COSTING_NO_MODEL');

  // THE PRINTER: the one asked for, else the one the verdict would run it on.
  const printers = await loadMerchantPrinters(c.env.DB, ctx.merchant.id);
  const wantedPrinter = str(body.merchant_printer_id, 'merchant_printer_id', { max: 60, required: false }) || verdict?.printer_id || '';
  const mp = printers.find((p) => p.id === wantedPrinter) ?? printers.find((p) => p.model.technology === 'fdm') ?? printers[0];
  if (!mp) throw conflict('Add a printer to cost a request', 'COSTING_NO_PRINTER');
  if (mp.model.technology !== 'fdm') {
    // The geometry path models EXTRUSION; resin cures a layer at a time.
    // Pricing resin with it would be a number dressed as a cost (§53).
    throw conflict('Costing resin prints from a file is not available yet', 'COSTING_RESIN_UNSUPPORTED');
  }

  // THE MATERIAL, in the quote engine's catalogue (print_materials). The
  // request's own choice when that catalogue has it; else the workshop names one.
  const requested = Number(print?.material_unsure ?? 0) === 1 ? '' : String(print?.material_id ?? '');
  const materialId = str(body.material_id, 'material_id', { max: 60, required: false }) || requested;
  const materialRow = materialId
    ? await c.env.DB.prepare('SELECT * FROM print_materials WHERE id = ? AND active = 1').bind(materialId).first<Record<string, unknown>>()
    : null;
  if (!materialRow || !(Number(materialRow.density_g_cm3 ?? 0) > 0)) {
    const { results } = await c.env.DB.prepare(
      'SELECT id, material_type, name, name_ar FROM print_materials WHERE active = 1 AND density_g_cm3 > 0 ORDER BY material_type'
    ).all<Record<string, unknown>>();
    throw new HttpError(409, 'Choose the material to cost it in', 'COSTING_MATERIAL_REQUIRED', {
      materials: (results ?? []).map((m) => ({ id: m.id, type: m.material_type, name_en: m.name, name_ar: m.name_ar })),
    });
  }

  const requestQuality = String(print?.quality ?? 'standard');
  const qualityId = oneOf(
    body.quality_id ?? (requestQuality === 'ultra' ? 'fine' : (QUOTE_QUALITIES as readonly string[]).includes(requestQuality) ? requestQuality : 'standard'),
    'quality_id',
    QUOTE_QUALITIES
  );
  const strengthId = oneOf(body.strength_id ?? 'standard', 'strength_id', ['light', 'standard', 'strong'] as const);
  const supports = body.supports === undefined ? Number(print?.supports ?? 1) === 1 : body.supports !== false;
  const quantityRow = await c.env.DB.prepare('SELECT quantity FROM community_requests WHERE id = ?').bind(id).first<{ quantity: number }>();
  const quantity = Math.max(1, Math.min(999, Number(quantityRow?.quantity ?? 1) || 1));
  const nozzleMm = mp.model.defaultNozzleMm;

  // THE BYTES, read here and nowhere else — never returned, never copied.
  const object = await getMediaObject(c.env, 'private', file.file_key);
  if (!object) throw notFound('The model is no longer stored');
  const bytes = new Uint8Array(await object.arrayBuffer());
  const fileSha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const geometry = analyseModel(bytes, file.file_name);
  const built = analysisFromGeometry({
    geometry,
    printer: mp.model,
    fileSha256: fileSha,
    material: {
      materialId,
      materialType: String(materialRow.material_type ?? ''),
      colorHex: '#D9D9D9',
      densityGPerCm3: Number(materialRow.density_g_cm3),
    },
    qualityId,
    strengthId,
    supports,
    nozzleMm,
    quantity,
  });
  if (built.refusal) {
    throw badRequest(`The model could not be measured (${built.refusal.code})`, built.refusal.code, { reasons: built.refusal.detail ?? {} });
  }

  const priced = await priceForPrinter(c, {
    analysis: built.analysis,
    printer: { ...mp.model, multiMaterial: mp.multiMaterial, toolheadCount: mp.toolheadCount },
    merchantId: ctx.merchant.id,
    merchantPrinter: mp,
    quantity: 1,
    targetMarginPercent: Number(body.target_margin_percent) || PLATFORM_TARGET_MARGIN_PERCENT,
    minimumJobIqd: await platformMinimumJobIqd(c.env.DB),
    platformMachineHourIqd: await platformMachineHourIqd(c.env.DB, 'fdm'),
  });

  // THE RECORD. An analysis with no file key and no owner (nothing can serve
  // bytes through it), and the workshop's own quote of this request revision.
  const ts = nowIso();
  const analysisId = newId('pa');
  const quoteId = newId('pq');
  // A canonical machine is referenced by id; a self-declared one has no row to point at.
  const printerModelId = mp.unlinked ? null : mp.model.id;
  const orientationKey = `qty:${quantity}`;
  const fingerprint = analysisFingerprint({
    fileSha256: fileSha,
    printerModelId: printerModelId ?? mp.model.id,
    profileRevision: built.analysis.profileRevision,
    slicerVersion: built.analysis.slicerVersion,
    qualityId,
    strengthId,
    nozzleMm,
    supports,
    materialIds: [materialId],
    orientationKey,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO print_analyses
         (id, owner_id, guest_token_hash, file_key, file_name, file_sha256, file_bytes, source, fingerprint,
          state, expires_at, created_at, updated_at)
       VALUES (?, NULL, NULL, '', '', ?, ?, 'file', ?, 'analyzing', NULL, ?, ?)`
    ).bind(analysisId, fileSha, Number(file.size_bytes ?? bytes.byteLength), fingerprint, ts, ts),
    ...analysisStatements(
      c.env.DB,
      {
        id: analysisId,
        ownerId: null,
        fileKey: '',
        fileName: '',
        fileBytes: Number(file.size_bytes ?? bytes.byteLength),
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
        expiresAt: null,
      },
      built.analysis,
      ts,
      () => newId('pam')
    ),
    ...quoteStatements(
      c.env.DB,
      {
        id: quoteId,
        analysisId,
        merchantId: ctx.merchant.id,
        merchantPrinterId: mp.id,
        printerModelId,
        requestId: id,
        quantity: 1,
        snapshot: { ...priced.snapshot, request_revision: Number(r.revision ?? 1), request_file_id: file.id, material_id: materialId },
      },
      priced.result,
      ts,
      () => newId('pqc')
    ),
    fileReadStatement(c.env.DB, { requestId: id, fileId: file.id, userId: user.id, reader, what: 'costing', revision: Number(r.revision ?? 1) }, ts),
  ]);
  await audit(c.env.DB, user.id, 'merchant.request_costed', quoteId, { request: id, printer: mp.id, material: materialId });

  return c.json({
    success: true,
    quote_id: quoteId,
    request_revision: Number(r.revision ?? 1),
    printer: { id: mp.id, name: mp.name },
    material_id: materialId,
    quality_id: qualityId,
    strength_id: strengthId,
    quantity,
    bounding_box_mm: built.analysis.boundingBoxMm,
    quote: merchantQuote(priced.result),
  });
});

/** This workshop's costings of a request, newest first — its own quotes only. */
merchantWorkshopRoutes.get('/requests/:id/costs', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const r = await requestRow(c, id);
  const { results } = await c.env.DB.prepare(
    `SELECT q.id, q.price_iqd, q.true_cost_iqd, q.profit_iqd, q.margin_percent, q.machine_hours, q.confidence,
            q.range_low_iqd, q.range_high_iqd, q.state, q.created_at, q.snapshot, q.merchant_printer_id, p.name AS printer_name
       FROM print_quotes q
       LEFT JOIN merchant_printers p ON p.id = q.merchant_printer_id
      WHERE q.merchant_id = ? AND q.request_id = ?
      ORDER BY q.created_at DESC LIMIT 10`
  ).bind(ctx.merchant.id, id).all<Record<string, unknown>>();
  return c.json({
    success: true,
    revision: Number(r.revision ?? 1),
    costs: (results ?? []).map((q) => {
      const snap = safeParse<Record<string, unknown>>(q.snapshot, {});
      const rev = Number(snap.request_revision ?? 0);
      return {
        id: q.id,
        price_iqd: Number(q.price_iqd ?? 0),
        true_cost_iqd: Number(q.true_cost_iqd ?? 0),
        profit_iqd: Number(q.profit_iqd ?? 0),
        margin_percent: Number(q.margin_percent ?? 0),
        machine_hours: Number(q.machine_hours ?? 0),
        confidence: q.confidence,
        range_iqd: { low: Number(q.range_low_iqd ?? 0), high: Number(q.range_high_iqd ?? 0) },
        state: q.state,
        created_at: q.created_at,
        printer: { id: q.merchant_printer_id ?? null, name: q.printer_name ?? '' },
        material_id: typeof snap.material_id === 'string' ? snap.material_id : null,
        request_revision: rev,
        /** Costed against an older revision of the job — re-cost before offering. */
        stale: rev > 0 && rev < Number(r.revision ?? 1),
      };
    }),
  });
});
