/**
 * «الاستبدال (Trade-in)» — the HTTP doors of worker/lib/tradeIn.ts.
 *
 * CUSTOMER (mounted at /api/trade-in; every route signed in, every request
 * the caller's OWN — another customer's id answers 404, never 403):
 *   GET    /eligible                          «طلباتك السابقة»: device lines of delivered orders
 *   GET    /targets                           the new devices on offer (no prices — see target-quote)
 *   POST   /target-quote                      the server's direct-sale price for one selection
 *   GET    /requests                          «طلباتي للاستبدال»
 *   POST   /requests                          open a draft on one unit (claims its parts)
 *   GET    /requests/:id                      the request, its timeline and what the wizard asks (never the rules)
 *   PATCH  /requests/:id                      save answers / target / note (draft only)
 *   POST   /requests/:id/preview              the figure for unsaved answers (draft only, counted: 20 a request, 60 a day)
 *   POST   /requests/:id/photos               one photograph (multipart: file, component, angle)
 *   DELETE /requests/:id/photos/:pid          remove one (draft only)
 *   POST   /requests/:id/submit               send for review — the server enforces answers, photos, target
 *   POST   /requests/:id/cancel
 *   POST   /requests/:id/accept | /reject     answer a changed value ({offer_no})
 *   POST   /requests/:id/checkout             the credit coupon for the real checkout
 *
 * ADMIN (mounted at /api/admin/trade-in):
 *   GET    /requests  · GET /requests/:id
 *   POST   /requests/:id/intake               any admin (not their own request) — the device is received (S-P2)
 *   POST   /requests/:id/photos               any admin — an intake photograph
 *   POST   /requests/:id/device-returned      any admin — a received device handed back
 *   POST   /requests/:id/inspect              retired by intake: 409 TRADE_IN_INTAKE_REQUIRED
 *   POST   /requests/:id/approve              FINANCIAL up to the ceiling — fixes money (or proposes the ceiling)
 *   POST   /requests/:id/value                FINANCIAL up to the ceiling; above it the OWNER with a reason
 *   POST   /requests/:id/complete             OWNER — after the new order is delivered (normally automatic)
 *   POST   /requests/:id/cancel               any admin, with a reason
 *   GET    /rules                             OWNER (cost read) — every family's rules in force + history
 *   PUT    /rules/:family                     OWNER — saves a NEW version
 *   POST   /rules/:family/test                validate a draft rule set and price a sample
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest, int, notFound, oneOf, requireAdmin, requireAuth, str, unavailable } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { newId } from '../lib/crypto';
import { assertMoneyAuthority, requireMoneyAuthority } from '../lib/moneyAuthority';
import { canMoveMoney, canViewCost, isOwner, isUnverifiedOwner } from '../lib/adminScope';
import { buildMediaKey, deleteMediaObject, putMediaObject } from '../lib/mediaStorage';
import { convertToWebp, extensionFor, isConvertibleToWebp } from '../lib/imageConvert';
import { rasterDimensions } from '../lib/imageMetadata';
import { HEIF_REFUSAL, isHeifBytes, sniff } from './uploads';
import { processOutbox } from '../lib/outbox';
import { safeParse } from '../lib/types';
import {
  TradeInError,
  adminList,
  approvalCeiling,
  approveEstimate,
  cancelRequest,
  changeValue,
  checkoutCredit,
  completeRequest,
  createDraft,
  decideValue,
  listEligible,
  publicUnit,
  listMine,
  listTargets,
  loadComponents,
  loadPhotos,
  loadRequest,
  loadRuleBook,
  markInspected,
  notifyAdmins,
  notifyCustomerOfValue,
  ownRequest,
  parseTargetSelection,
  priceTarget,
  previewDraft,
  publicQuestions,
  publicRules,
  requestView,
  ruleSetHistory,
  saveDraft,
  saveRuleSet,
  setHandover,
  stampCustomerPrompt,
  submitRequest,
} from '../lib/tradeIn';
import { requireTradeInV2, tradeInV2Installed } from '../lib/tradeInSchema';
import { requireCostRead } from '../lib/costAccess';
import { deviceReturned, intakeRequest } from '../lib/tradeInIntake';
import { bookTradeInStock } from '../lib/tradeInStock';
import { overrideRecord, valuationsOf } from '../lib/tradeInOffer';
import { QUEUE_CHIPS, adminQueue, isUsdText, listComponentRefs, tradeInPnl, type QueueChip } from '../lib/tradeInAdminQueue';
import { getSetting, normalizeTradeInPolicy, setSetting, TRADE_IN_POLICY_DEFAULTS, TRADE_IN_POLICY_RANGES } from '../lib/settings';
import { auditStatements } from '../lib/audit';
import { isListedDeviceTarget, searchTargets } from '../lib/tradeInTargets';
import { listMyDevices } from '../lib/services/myDevices';
import type { DeviceFacts } from '../../packages/contracts/src/myDevices';
import {
  MAX_DAMAGE_PHOTOS,
  MAX_PHOTOS_PER_ANGLE,
  MAX_PHOTOS_PER_REQUEST,
  OPTIONAL_PHOTO,
  TRADE_IN_FAMILIES,
  TRADE_IN_SCOPES,
  TRADE_IN_STATUSES,
  blankInputs,
  checklistOf,
  isAllowedAngle,
  tradeInSettlement,
  validateInputs,
  validateRuleSet,
  valuateComponent,
  type TradeInFamily,
} from '@levonis/pricing/tradeIn';


const REQ_ID_RE = /^tin_[0-9a-f]{20}$/;
const PHOTO_ID_RE = /^tip_[0-9a-f]{20}$/;
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** The same ceiling a support or chat photograph has (worker/routes/uploads.ts). */
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
/** Photographs the desk may add at intake (the serial plate, the hours screen, every finding). */
const MAX_INTAKE_PHOTOS = 20;

function toHttp(e: unknown): never {
  if (e instanceof TradeInError) throw new HttpError(e.status, e.message, e.code, e.details);
  throw e;
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    toHttp(e);
  }
}

/** Runs after the response; a notification never fails the request. */
function afterResponse(c: Context<AppContext>, work: Promise<unknown>): void {
  const safe = work.catch((e) => console.error('trade-in follow-up failed', e instanceof Error ? e.message : String(e)));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // No ExecutionContext (a test harness): the promise is already running.
  }
}

function requestIdOf(c: Context<AppContext>): string {
  const id = c.req.param('id') ?? '';
  if (!REQ_ID_RE.test(id)) throw notFound('Trade-in request not found');
  return id;
}

function offerNoOf(body: Record<string, unknown>): number {
  const n = body.offer_no;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) throw badRequest('offer_no is required', 'TRADE_IN_OFFER_STALE');
  return n;
}

/**
 * The uploads door's rules for one photograph of a request: the bytes are sniffed (the declared type
 * is never trusted), only a still image is taken, HEIC is named, the server converts to WebP, and the
 * object lands under `trade-in/<request id>/<kind>/` (the file gate serves `photos/` to the request's
 * customer and to admins, `intake/` to admins only).
 */
async function storePhoto(
  c: Context<AppContext>,
  file: File,
  where: { requestId: string; ownerId: string; kind: 'photos' | 'intake'; originalName: string }
): Promise<{ key: string; mime: string; buf: Uint8Array; dims: { width: number; height: number } | null }> {
  if (file.size > PHOTO_MAX_BYTES) throw badRequest(`Image is too large (max ${PHOTO_MAX_BYTES / 1024 / 1024} MB)`);
  let buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind && isHeifBytes(buf)) throw badRequest(HEIF_REFUSAL, 'IMAGE_HEIC_UNSUPPORTED');
  if (!kind || !['image/jpeg', 'image/png', 'image/webp'].includes(kind.mime)) {
    throw badRequest('Unsupported file type — please upload a JPEG, PNG or WebP photo');
  }
  let mime = kind.mime;
  let ext = kind.ext;
  if (isConvertibleToWebp(kind.mime)) {
    const converted = await convertToWebp(c.env, buf, kind.mime);
    if (converted.ok) {
      buf = converted.bytes;
      mime = converted.mime;
      ext = extensionFor(converted.mime);
    } else if (converted.reason === 'unavailable') {
      throw unavailable(
        'تحويل الصور غير مفعّل على الخادم حالياً. / Server-side image conversion is not enabled on this deployment.',
        'IMAGE_CONVERT_UNAVAILABLE'
      );
    } else if (converted.reason === 'too_large') {
      throw badRequest('Image is too large to convert.', 'IMAGE_TOO_LARGE_TO_CONVERT');
    } else if (converted.reason === 'failed') {
      throw badRequest('This image could not be converted. Try another one.', 'IMAGE_CONVERT_FAILED');
    }
  }
  const dims = rasterDimensions(buf, mime);
  const key = buildMediaKey({ visibility: 'private', domain: 'trade-in', entityId: where.requestId, kind: where.kind, extension: ext, objectId: newId() });
  await putMediaObject(
    c.env,
    {
      key,
      visibility: 'private',
      domain: 'trade-in',
      mime,
      bytes: buf.byteLength,
      ownerId: where.ownerId,
      entityId: where.requestId,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      originalName: where.originalName.slice(0, 200),
    },
    buf,
    { httpMetadata: { contentType: mime, cacheControl: 'private, max-age=300' } }
  );
  return { key, mime, buf, dims: dims ? { width: dims.width, height: dims.height } : null };
}

// =========================================================================
//  CUSTOMER
// =========================================================================

export const tradeInRoutes = new Hono<AppContext>();
tradeInRoutes.use('*', requireAuth);

tradeInRoutes.get('/eligible', async (c) => {
  const user = c.get('user')!;
  const units = await run(() => listEligible(c.env, user.id));
  const book = await loadRuleBook(c.env.DB);
  // S-P2: where each device is and the stage of its open trade-in, from the device service.
  const facts = (await tradeInV2Installed(c.env.DB)) ? new Map((await listMyDevices(c.env, user.id)).map((f) => [f.key, f])) : new Map<string, DeviceFacts>();
  return c.json({
    success: true,
    // Never the AMS split or the bases it priced from: on a Combo they carry
    // the owner's private AMS reference (DECISIONS row 220, `publicUnit`).
    units: units.map((u) => {
      const f = facts.get(u.key);
      return publicUnit(u, f ? { in_shop: f.in_shop, stage: f.open.trade_in?.stage ?? null } : undefined);
    }),
    // What the wizard asks for each family — never the numbers the answers
    // are valued with (DECISIONS row 220): the Worker prices the answers
    // (POST /requests/:id/preview) and the customer reads the final figure.
    questions: Object.fromEntries(TRADE_IN_FAMILIES.map((f) => [f, publicQuestions(book[f])])),
  });
});

/**
 * The devices a credit can buy. v2 (0192): the server's search — `q` (≥ 2
 * characters; else the featured twenty), `family`, keyset `cursor` — each with
 * THIS customer's lowest direct-sale price (never `products.price_iqd`).
 */
tradeInRoutes.get('/targets', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_read', 120, 60);
  if (!(await tradeInV2Installed(c.env.DB))) return c.json({ success: true, targets: await listTargets(c.env) });
  const family = c.req.query('family') || null;
  if (family && !(['fdm', 'resin', 'laser', 'ams'] as const).includes(family as 'fdm')) throw badRequest('Unknown family');
  const out = await searchTargets(c.env, user.id, { q: c.req.query('q') ?? '', family: family as TradeInFamily | null, cursor: c.req.query('cursor') ?? null });
  return c.json({ success: true, ...out });
});

/**
 * THE PRODUCT-PAGE ENTRY (S-P2 §10.2): how many of the caller's units can be
 * traded in now, and whether this product is a listed device a credit can buy.
 * Signed in only (the router); a database without 0192 answers 503.
 */
tradeInRoutes.get('/entry', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_read', 120, 60);
  await requireTradeInV2(c.env.DB);
  const productId = c.req.query('product_id') ?? '';
  const [units, targetOk] = await Promise.all([
    listEligible(c.env, user.id),
    ITEM_ID_RE.test(productId) ? isListedDeviceTarget(c.env, productId) : Promise.resolve(false),
  ]);
  return c.json({ success: true, eligible_units: units.filter((u) => u.available).length, target_ok: targetOk });
});

tradeInRoutes.post('/target-quote', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_quote', 120, 60);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sel = parseTargetSelection(body.target);
  if (!sel) throw badRequest('Choose a product', 'TRADE_IN_TARGET_REQUIRED');
  const priced = await run(() => priceTarget(c.env, user.id, sel));
  return c.json({ success: true, target: { ...priced.snapshot, ...priced.selection, price_iqd: priced.price_iqd } });
});

tradeInRoutes.get('/requests', async (c) => {
  const user = c.get('user')!;
  return c.json({ success: true, requests: await listMine(c.env.DB, user.id) });
});

tradeInRoutes.post('/requests', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_create', 10, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const orderItemId = str(body.order_item_id, 'order_item_id', { min: 1, max: 80 });
  if (!ITEM_ID_RE.test(orderItemId)) throw notFound('Order item not found');
  const unitIndex = int(body.unit_index, 'unit_index', { min: 1, max: 500, def: 1 });
  const scope = oneOf(body.scope ?? 'whole', 'scope', TRADE_IN_SCOPES);
  const req = await run(() => createDraft(c.env, user.id, { orderItemId, unitIndex, scope }));
  return c.json({ success: true, request: await requestView(c.env, req, 'customer') }, 201);
});

tradeInRoutes.get('/requests/:id', async (c) => {
  const user = c.get('user')!;
  const req = await run(() => ownRequest(c.env.DB, user.id, requestIdOf(c)));
  return c.json({ success: true, request: await requestView(c.env, req, 'customer') });
});

tradeInRoutes.patch('/requests/:id', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_save', 240, 3600);
  const id = requestIdOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // v2: how the device reaches the shop — while a draft, or sent and not yet received.
  if (body.handover !== undefined) {
    await requireTradeInV2(c.env.DB);
    const handover = oneOf(body.handover, 'handover', ['store', 'pickup'] as const);
    await run(() => setHandover(c.env, user.id, id, handover));
  }
  const { handover: _h, ...rest } = body;
  void _h;
  const req = Object.keys(rest).length ? await run(() => saveDraft(c.env, user.id, id, rest)) : await run(() => ownRequest(c.env.DB, user.id, id));
  return c.json({ success: true, request: await requestView(c.env, req, 'customer') });
});

/**
 * The figure for the answers so far — priced here and counted (see
 * `previewDraft`): 20 per request and 60 per account a day, enforced in the
 * database; the hourly bucket below only stops a burst before it costs a read.
 */
tradeInRoutes.post('/requests/:id/preview', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_preview', 60, 3600);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const answer = await run(() => previewDraft(c.env, user.id, requestIdOf(c), body));
  // v2: `offer` is the one figure; `estimate.total_iqd` repeats it for a phone still holding the old wizard (§7.4).
  return c.json({ success: true, ...(answer.offer ? { offer: answer.offer } : {}), estimate: answer.estimate, previews_left: answer.previews_left });
});

/**
 * ONE PHOTOGRAPH, INTO THE REQUEST'S OWN PRIVATE FOLDER.
 *
 * The uploads door's rules, applied here because the key must name a request
 * the uploader owns — checked BEFORE a byte is stored: the bytes are sniffed
 * (the declared type is never trusted), only a still image is taken, HEIC is
 * named rather than refused blindly, the server converts to WebP, and the
 * object lands under `trade-in/<request id>/photos/`, which the file gate
 * (worker/routes/uploads.ts) serves to the owner and to admins only.
 */
tradeInRoutes.post('/requests/:id/photos', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_upload', 80, 3600);
  const id = requestIdOf(c);
  const req = await run(() => ownRequest(c.env.DB, user.id, id));
  if (req.status !== 'draft') throw new HttpError(409, 'This request was already sent and can no longer be edited.', 'TRADE_IN_NOT_EDITABLE');
  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');
  const role = oneOf(form.get('component'), 'component', ['device', 'ams'] as const);
  const angle = str(form.get('angle'), 'angle', { min: 2, max: 40 });
  const comps = await loadComponents(c.env.DB, id);
  const comp = comps.find((x) => x.role === role);
  if (!comp) throw badRequest('Unknown component', 'TRADE_IN_PHOTO_ANGLE');
  const version = req.valuation_version ?? 1;
  if (!isAllowedAngle(comp.family, angle, version)) throw badRequest('That photo angle does not apply to this device.', 'TRADE_IN_PHOTO_ANGLE');
  // v2 (G14): what the photograph proves — the hours screen, or one ticked fault (a fault id of the family's checklist).
  const v2 = await tradeInV2Installed(c.env.DB);
  const proves = v2 ? str(form.get('proves'), 'proves', { max: 40, required: false }) : '';
  if (proves && proves !== 'hours') {
    const faults = checklistOf((await loadRuleBook(c.env.DB))[comp.family], 'faults').map((f) => f.id);
    if (!faults.includes(proves) || angle !== OPTIONAL_PHOTO.id) throw badRequest('That photo angle does not apply to this device.', 'TRADE_IN_PHOTO_ANGLE');
  }
  const photos = await loadPhotos(c.env.DB, id);
  const sameAngle = photos.filter((p) => p.component_role === role && p.angle === angle).length;
  const perAngle = angle === OPTIONAL_PHOTO.id ? MAX_DAMAGE_PHOTOS : MAX_PHOTOS_PER_ANGLE;
  if (sameAngle >= perAngle || photos.length >= MAX_PHOTOS_PER_REQUEST) {
    throw new HttpError(409, 'You reached the photo limit for this angle or request.', 'TRADE_IN_PHOTO_LIMIT');
  }
  const stored = await storePhoto(c, file, { requestId: id, ownerId: user.id, kind: 'photos', originalName: String(form.get('originalName') || file.name || '') });
  const { key, mime, buf, dims } = stored;
  const photoId = newId('tip');
  const now = new Date().toISOString();
  // Draft-fenced: a photo cannot attach to a request that was sent while the
  // bytes were in flight. The INSERT … SELECT writes nothing in that case.
  const res = await c.env.DB.prepare(
    `INSERT INTO trade_in_photos (id, request_id, component_role, angle, file_key, mime, bytes, width, height, uploaded_by, created_at${v2 ? ', phase, proves' : ''})
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11${v2 ? ", 'customer', ?12" : ''}
      WHERE EXISTS (SELECT 1 FROM trade_in_requests WHERE id = ?2 AND user_id = ?10 AND status = 'draft')`
  )
    .bind(photoId, id, role, angle, key, mime, buf.byteLength, dims?.width ?? null, dims?.height ?? null, user.id, now, ...(v2 ? [proves] : []))
    .run();
  if (!res.meta?.changes) {
    await deleteMediaObject(c.env, 'private', key).catch(() => undefined);
    throw new HttpError(409, 'This request was already sent and can no longer be edited.', 'TRADE_IN_NOT_EDITABLE');
  }
  return c.json(
    { success: true, photo: { id: photoId, component: role, angle, proves, url: `/files/${key}`, width: dims?.width ?? null, height: dims?.height ?? null, created_at: now } },
    201
  );
});

tradeInRoutes.delete('/requests/:id/photos/:pid', async (c) => {
  const user = c.get('user')!;
  const id = requestIdOf(c);
  const pid = c.req.param('pid') ?? '';
  if (!PHOTO_ID_RE.test(pid)) throw notFound('Photo not found');
  const req = await run(() => ownRequest(c.env.DB, user.id, id));
  if (req.status !== 'draft') throw new HttpError(409, 'This request was already sent and can no longer be edited.', 'TRADE_IN_NOT_EDITABLE');
  const photo = await c.env.DB.prepare('SELECT file_key FROM trade_in_photos WHERE id = ? AND request_id = ?').bind(pid, id).first<{ file_key: string }>();
  if (!photo) throw notFound('Photo not found');
  await c.env.DB.prepare(
    `DELETE FROM trade_in_photos WHERE id = ?1 AND request_id = ?2
        AND EXISTS (SELECT 1 FROM trade_in_requests WHERE id = ?2 AND status = 'draft')`
  )
    .bind(pid, id)
    .run();
  await deleteMediaObject(c.env, 'private', photo.file_key).catch(() => undefined);
  return c.json({ success: true });
});

tradeInRoutes.post('/requests/:id/submit', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_submit', 20, 3600);
  const req = await run(() => submitRequest(c.env, user.id, requestIdOf(c)));
  afterResponse(c, notifyAdmins(c.env, req, 'submitted'));
  return c.json({ success: true, request: await requestView(c.env, req, 'customer') });
});

tradeInRoutes.post('/requests/:id/cancel', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_decide', 30, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { max: 500, required: false });
  const req = await run(async () => cancelRequest(c.env, await ownRequest(c.env.DB, user.id, requestIdOf(c)), { id: user.id, role: 'customer' }, reason));
  if (req.intake_at) afterResponse(c, notifyAdmins(c.env, req, 'device_to_return'));
  return c.json({ success: true, request: await requestView(c.env, req, 'customer') });
});

for (const decision of ['accept', 'reject'] as const) {
  tradeInRoutes.post(`/requests/:id/${decision}`, async (c) => {
    const user = c.get('user')!;
    await rateLimit(c, 'trade_in_decide', 30, 3600);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const offerNo = offerNoOf(body);
    const res = await run(async () => decideValue(c.env, await ownRequest(c.env.DB, user.id, requestIdOf(c)), offerNo, decision, 'web'));
    if (!res.replayed) {
      afterResponse(
        c,
        Promise.all([
          stampCustomerPrompt(c.env, res.request),
          notifyAdmins(c.env, res.request, decision === 'accept' ? 'accepted' : 'rejected'),
          ...(decision === 'reject' && res.request.intake_at ? [notifyAdmins(c.env, res.request, 'device_to_return')] : []),
        ])
      );
    }
    return c.json({ success: true, replayed: res.replayed, request: await requestView(c.env, res.request, 'customer') });
  });
}

/**
 * «إتمام الدفع». Answers with the credit code and the target selection; the
 * page adds the target to the cart (the ordinary cart door, which re-checks
 * stock and price) and opens the real checkout with the code applied. The
 * checkout — not this route — decides what the credit is worth on that cart.
 */
tradeInRoutes.post('/requests/:id/checkout', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'trade_in_decide', 30, 3600);
  const req = await run(() => ownRequest(c.env.DB, user.id, requestIdOf(c)));
  const credit = await run(() => checkoutCredit(c.env, req));
  const tgt = safeParse<Record<string, unknown>>(req.target_snapshot_json, {});
  // A credit given back (row 237) buys any device sold directly: no target, the customer chooses.
  const any = credit.any_device === true;
  return c.json({
    success: true,
    coupon_code: credit.code,
    order_id: credit.order_id,
    target: any
      ? null
      : {
          product_id: req.target_product_id,
          slug: tgt.slug ?? null,
          option_value_ids: safeParse<string[]>(req.target_option_value_ids, []),
          color_id: req.target_color_id,
        },
    any_device: any,
    credit_iqd: req.credit_iqd,
    difference_iqd: any ? null : req.difference_iqd,
    ends_at: credit.ends_at ?? null,
  });
});

// =========================================================================
//  ADMIN
// =========================================================================

export const adminTradeInRoutes = new Hono<AppContext>();
adminTradeInRoutes.use('*', requireAdmin);

async function adminRequest(c: Context<AppContext>) {
  const req = await loadRequest(c.env.DB, requestIdOf(c));
  if (!req) throw notFound('Trade-in request not found');
  return req;
}

/**
 * THE QUEUE (S-P2 §6.13, any admin): `q` searches the customer (name, e-mail, the phone's last
 * digits), the request and order ids, the serials and the device names; `chip` is a work stage;
 * `cursor` the keyset of the next page. Rows carry staff figures (offer, ceiling, final), never a
 * cost. A database without 0192 answers the old list.
 */
adminTradeInRoutes.get('/requests', async (c) => {
  const status = c.req.query('status') || null;
  const family = c.req.query('family') || null;
  if (status && !(TRADE_IN_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown status');
  if (family && !(TRADE_IN_FAMILIES as readonly string[]).includes(family)) throw badRequest('Unknown family');
  const search = (c.req.query('q') || '').trim().slice(0, 120) || null;
  c.header('Cache-Control', 'private, no-store');
  if (await tradeInV2Installed(c.env.DB)) {
    const chip = c.req.query('chip') || null;
    if (chip && !(QUEUE_CHIPS as readonly string[]).includes(chip)) throw badRequest('Unknown chip');
    const cursor = (c.req.query('cursor') || '').slice(0, 120) || null;
    const out = await adminQueue(c.env.DB, { q: search, chip: chip as QueueChip | null, family, status, cursor });
    return c.json({ success: true, ...out });
  }
  const page = int(c.req.query('page'), 'page', { min: 1, max: 1000, def: 1 });
  const limit = 30;
  const out = await adminList(c.env.DB, { status, family, search, limit, offset: (page - 1) * limit });
  return c.json({ success: true, ...out, page, limit });
});

/** The verified owner: the one admin who may go above the estimate (decision 3) and edit the rules. */
const ownerScope = (c: Context<AppContext>) => {
  const user = c.get('user');
  return isOwner(c.env, user) && !isUnverifiedOwner(c.env, user);
};

/** B.10: the rules, the factor lines and the owner's own figures are the owner's; every other admin reads the staff view. */
const adminAudience = (c: Context<AppContext>): 'owner' | 'staff' => (ownerScope(c) && canViewCost(c.env, c.get('user')) ? 'owner' : 'staff');

adminTradeInRoutes.get('/requests/:id', async (c) => {
  const req = await adminRequest(c);
  const view = await requestView(c.env, req, adminAudience(c));
  const customer = await c.env.DB.prepare('SELECT id, name, email, phone_e164, username FROM users WHERE id = ?').bind(req.user_id).first();
  return c.json({ success: true, request: view, customer, financial_scope: canMoveMoney(c.env, c.get('user')), owner_scope: ownerScope(c) });
});

/**
 * WHO MAY DO WHAT HERE (owner decision 3, worker/lib/moneyAuthority.ts; S-P2 spec §6.5–§6.6).
 *   intake, intake photos, device hand-back   ANY admin (an assistant too: no money moves) — never on
 *                                             their own request (TRADE_IN_OWN_REQUEST); a serial that
 *                                             does not match is the owner's, with a recorded reason
 *   approve, value                            FINANCIAL, up to the server's ceiling from intake; above
 *                                             it the owner, with a private reason (`owner_reason`) and,
 *                                             past the store's own cap, an acknowledgement
 *   complete                                  the OWNER, after the new order is delivered (it is
 *                                             normally automatic on delivery)
 * None of these acts is the customer's own: an admin who is the trade-in's customer leaves them to
 * the owner (a conflict of interest, decided with a reason). A unit with no serial on record, or one
 * received over a mismatch, is the owner's to approve (§16 D-5).
 */
adminTradeInRoutes.post('/requests/:id/inspect', async (c) => {
  // S-P2: retired — the device is received at intake. A cached desk tab reads a sentence.
  if (await tradeInV2Installed(c.env.DB)) throw new HttpError(409, 'Receive the device and record its serial and hours first.', 'TRADE_IN_INTAKE_REQUIRED');
  const admin = c.get('user')!;
  const current = await adminRequest(c);
  assertMoneyAuthority(c, { act: 'trade_in_inspect', beneficiaryUserId: current.user_id, reason: await ownerReasonOf(c) });
  const req = await run(async () => markInspected(c.env, current, admin.id));
  return c.json({ success: true, request: await requestView(c.env, req, adminAudience(c)) });
});

/** The owner's private reason, when the body carries one (`owner_reason`); empty otherwise. */
async function ownerReasonOf(c: Context<AppContext>): Promise<string> {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return str(body.owner_reason, 'owner_reason', { max: 500, required: false });
}

const intakeRequired = () => new HttpError(409, 'Receive the device and record its serial and hours first.', 'TRADE_IN_INTAKE_REQUIRED');

/** A unit with no serial on record, or received over a mismatch: approving its money is the owner's (§16 D-5). */
const serialNeedsOwner = (req: Awaited<ReturnType<typeof adminRequest>>) =>
  req.intake_serial_match === 'unrecorded' || req.intake_serial_match === 'mismatch';

/**
 * «استلام الجهاز» — the device is in the shop (decision 2). Any admin; never the request's own
 * customer. Body: `{ serial, hours, components: { device?, ams? }, findings, handover,
 * serial_override_reason? }`. The server checks the serial, flags the hours, recomputes the ceiling.
 */
adminTradeInRoutes.post('/requests/:id/intake', async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in', 120, 3600);
  await requireTradeInV2(c.env.DB);
  const current = await adminRequest(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const serial = str(body.serial, 'serial', { max: 80, required: false });
  const hours = body.hours === null || body.hours === undefined || body.hours === '' ? null : int(body.hours, 'hours', { min: 0, max: 1_000_000 });
  const handover = oneOf(body.handover ?? current.handover ?? 'store', 'handover', ['store', 'pickup'] as const);
  const findings = str(body.findings, 'findings', { max: 1000, required: false });
  const components = typeof body.components === 'object' && body.components !== null && !Array.isArray(body.components) ? (body.components as Record<string, unknown>) : {};
  const overrideReason = str(body.serial_override_reason, 'serial_override_reason', { max: 500, required: false });
  const out = await run(() =>
    intakeRequest(c.env, current, { id: admin.id }, {
      serial,
      hours,
      components: { ...(components.device !== undefined ? { device: components.device } : {}), ...(components.ams !== undefined ? { ams: components.ams } : {}) },
      findings,
      handover,
      serialOverrideReason: overrideReason || null,
      authorizeSerialOverride: (reason) =>
        void assertMoneyAuthority(c, { act: 'trade_in_serial_override', beneficiaryUserId: current.user_id, reason }),
    })
  );
  if (out.revalued) {
    afterResponse(c, notifyCustomerOfValue(c.env, out.request).then(() => processOutbox(c.env, 5, { eventKeyPrefix: `trade_in:${out.request.id}:` })));
  }
  afterResponse(c, notifyAdmins(c.env, out.request, 'received'));
  // A request completed before its device was received (cut-over, §7): the device is stock now.
  let request = out.request;
  if (request.status === 'completed' && (await run(() => bookTradeInStock(c.env, request, { id: admin.id, role: 'admin' })))) {
    request = (await loadRequest(c.env.DB, request.id)) ?? request;
  }
  return c.json({ success: true, request: await requestView(c.env, request, adminAudience(c)) });
});

/**
 * An intake photograph (multipart: file, component, proves?) — any admin, never on their own request;
 * stored under `trade-in/<id>/intake/` (admins only). Not on a draft (nothing was sent).
 */
adminTradeInRoutes.post('/requests/:id/photos', async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in-upload', 120, 3600);
  await requireTradeInV2(c.env.DB);
  const current = await adminRequest(c);
  if (current.user_id === admin.id) throw new HttpError(403, 'Staff do not receive their own trade-in; a colleague handles it.', 'TRADE_IN_OWN_REQUEST');
  if (current.status === 'draft') throw new HttpError(409, 'This request is not in a state that allows this action.', 'TRADE_IN_BAD_STATE');
  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');
  const role = oneOf(form.get('component') ?? 'device', 'component', ['device', 'ams'] as const);
  const proves = str(form.get('proves'), 'proves', { max: 40, required: false });
  if (proves && !/^[a-z0-9_:-]{1,40}$/.test(proves)) throw badRequest('That photo angle does not apply to this device.', 'TRADE_IN_PHOTO_ANGLE');
  const photos = await loadPhotos(c.env.DB, current.id);
  if (photos.filter((p) => p.phase === 'intake').length >= MAX_INTAKE_PHOTOS) {
    throw new HttpError(409, 'You reached the photo limit for this angle or request.', 'TRADE_IN_PHOTO_LIMIT');
  }
  const { key, mime, buf, dims } = await storePhoto(c, file, { requestId: current.id, ownerId: admin.id, kind: 'intake', originalName: String(form.get('originalName') || file.name || '') });
  const photoId = newId('tip');
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO trade_in_photos (id, request_id, component_role, angle, file_key, mime, bytes, width, height, uploaded_by, created_at, phase, proves)
     VALUES (?1, ?2, ?3, 'intake', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'intake', ?11)`
  )
    .bind(photoId, current.id, role, key, mime, buf.byteLength, dims?.width ?? null, dims?.height ?? null, admin.id, now, proves)
    .run();
  return c.json({ success: true, photo: { id: photoId, component: role, angle: 'intake', proves, url: `/files/${key}`, width: dims?.width ?? null, height: dims?.height ?? null, created_at: now } }, 201);
});

/** «أُعيد الجهاز للزبون» — a received device handed back after a cancel or a decline. Any admin, once. */
adminTradeInRoutes.post('/requests/:id/device-returned', async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in', 120, 3600);
  await requireTradeInV2(c.env.DB);
  const req = await run(async () => deviceReturned(c.env, await adminRequest(c), admin.id));
  return c.json({ success: true, request: await requestView(c.env, req, adminAudience(c)) });
});

adminTradeInRoutes.post('/requests/:id/approve', requireMoneyAuthority('trade_in_approve'), async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in', 120, 3600);
  const current = await adminRequest(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { max: 500, required: false });
  const v2 = await tradeInV2Installed(c.env.DB);
  if (v2 && !current.intake_at) throw intakeRequired();
  // v2: the figure is the server's ceiling from intake; before S-P2, the submit-time estimate.
  const ceiling = v2 ? approvalCeiling(current) : current.estimated_iqd;
  const grant = assertMoneyAuthority(c, {
    act: 'trade_in_approve',
    amountIqd: ceiling,
    ceilingIqd: ceiling,
    conflictOfInterest: v2 && serialNeedsOwner(current),
    beneficiaryUserId: current.user_id,
    reason: await ownerReasonOf(c),
  });
  const req = await run(async () => approveEstimate(c.env, current, admin.id, grant, reason));
  if (req.status === 'value_changed') {
    afterResponse(c, notifyCustomerOfValue(c.env, req).then(() => processOutbox(c.env, 5, { eventKeyPrefix: `trade_in:${req.id}:` })));
  }
  return c.json({ success: true, request: await requestView(c.env, req, adminAudience(c)) });
});

adminTradeInRoutes.post('/requests/:id/value', requireMoneyAuthority('trade_in_value'), async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in', 120, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { max: 500, required: false });
  // The owner's reason for going above the ceiling: the audit row, the owner's valuation record and
  // the reports read it, the customer never does (`reason` above is theirs).
  const ownerReason = str(body.owner_reason, 'owner_reason', { max: 500, required: false });
  const raw = body.value_iqd;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw badRequest('The value must be a whole number of dinars.', 'TRADE_IN_INVALID_VALUE');
  }
  const current = await adminRequest(c);
  const v2 = await tradeInV2Installed(c.env.DB);
  if (v2 && !current.intake_at) throw intakeRequired();
  // M1 / decision 3: «value ≤ the server's figure unless owner». v2: the ceiling from intake; before
  // S-P2 the estimate fixed at submit — never a figure the client sends.
  const ceiling = v2 ? approvalCeiling(current) : (current.estimated_iqd ?? 0);
  const grant = assertMoneyAuthority(c, {
    act: 'trade_in_value',
    amountIqd: raw,
    ceilingIqd: ceiling,
    conflictOfInterest: v2 && serialNeedsOwner(current),
    beneficiaryUserId: current.user_id,
    reason: ownerReason,
  });
  let override: Awaited<ReturnType<typeof overrideRecord>> | null = null;
  if (v2 && grant.above_ceiling) {
    // Past the store's own cap (owner-only figure) the owner acknowledges the margin may be a loss.
    override = await overrideRecord(c.env.DB, current.id, raw, ceiling, ownerReason, body.ack_below_margin === true);
    if (override.needs_ack) throw new HttpError(400, 'Confirm you understand the margin shrinks and may be a loss.', 'TRADE_IN_MARGIN_ACK_REQUIRED');
  }
  const req = await run(async () => changeValue(c.env, current, admin.id, raw, reason, grant, override?.row ?? null));
  afterResponse(
    c,
    notifyCustomerOfValue(c.env, req).then(() => processOutbox(c.env, 5, { eventKeyPrefix: `trade_in:${req.id}:` }))
  );
  return c.json({ success: true, request: await requestView(c.env, req, adminAudience(c)) });
});

adminTradeInRoutes.post('/requests/:id/complete', requireMoneyAuthority('trade_in_complete'), async (c) => {
  const admin = c.get('user')!;
  const current = await adminRequest(c);
  assertMoneyAuthority(c, { act: 'trade_in_complete', beneficiaryUserId: current.user_id, reason: await ownerReasonOf(c) });
  const req = await run(async () => completeRequest(c.env, current, admin.id));
  return c.json({ success: true, request: await requestView(c.env, req, adminAudience(c)) });
});

adminTradeInRoutes.post('/requests/:id/cancel', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { min: 3, max: 500 });
  const req = await run(async () => cancelRequest(c.env, await adminRequest(c), { id: admin.id, role: 'admin' }, reason));
  if (req.intake_at) afterResponse(c, notifyAdmins(c.env, req, 'device_to_return'));
  return c.json({ success: true, request: await requestView(c.env, req, adminAudience(c)) });
});

/** The rules (weights, cap, floor, references, offer parameters) price every offer: the owner's to read (B.10). */
adminTradeInRoutes.get('/rules', requireCostRead, async (c) => {
  const book = await loadRuleBook(c.env.DB);
  const history = Object.fromEntries(await Promise.all(TRADE_IN_FAMILIES.map(async (f) => [f, await ruleSetHistory(c.env.DB, f)] as const)));
  return c.json({
    success: true,
    rules: Object.fromEntries(TRADE_IN_FAMILIES.map((f) => [f, { ...publicRules(book[f]), id: book[f].id, note: book[f].note, created_at: book[f].created_at }])),
    history,
    financial_scope: canMoveMoney(c.env, c.get('user')),
    // The valuation rules decide every estimate a financial admin may approve: the owner's alone (decision 3).
    owner_scope: ownerScope(c),
  });
});

/**
 * THE OWNER'S VALUATION RECORD of one request (cost_read): every valuation row — the store cap,
 * the expected margin, each component's resale, costs and offer, the parameters — and the stock
 * it became (lot, hidden draft, cost basis). The same refusal for a real and an invented id.
 */
adminTradeInRoutes.get('/requests/:id/valuation', requireCostRead, async (c) => {
  await requireTradeInV2(c.env.DB);
  c.header('Cache-Control', 'private, no-store');
  const req = await adminRequest(c);
  const [valuations, stock] = await Promise.all([
    valuationsOf(c.env.DB, req.id),
    c.env.DB.prepare('SELECT lot_id, product_id, cost_basis_iqd, order_id, created_at FROM trade_in_stock WHERE request_id = ?')
      .bind(req.id)
      .first<{ lot_id: string; product_id: string; cost_basis_iqd: number; order_id: string; created_at: string }>(),
  ]);
  return c.json({
    success: true,
    request_id: req.id,
    valuations,
    stock: stock ? { lot_id: stock.lot_id, draft_product_id: stock.product_id, cost_basis_iqd: stock.cost_basis_iqd, order_id: stock.order_id, booked_at: stock.created_at } : null,
  });
});

/** The owner's trade-in windows and fees (§4.4): read with the costs, written by the owner. */
adminTradeInRoutes.get('/policy', requireCostRead, async (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, policy: await getSetting(c.env.DB, 'tradeInPolicy'), ranges: TRADE_IN_POLICY_RANGES, defaults: TRADE_IN_POLICY_DEFAULTS });
});

adminTradeInRoutes.put('/policy', requireMoneyAuthority('trade_in_rules'), async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in-policy', 60, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const current = await getSetting(c.env.DB, 'tradeInPolicy');
  const errors: string[] = [];
  const next: Record<string, unknown> = { ...current };
  for (const [k, [lo, hi]] of Object.entries(TRADE_IN_POLICY_RANGES)) {
    if (!(k in body)) continue;
    const v = body[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) errors.push(k);
    else next[k] = v;
  }
  if ('require_serial_match' in body) {
    if (typeof body.require_serial_match !== 'boolean') errors.push('require_serial_match');
    else next.require_serial_match = body.require_serial_match;
  }
  if (errors.length) throw new HttpError(400, 'Some policy values are out of range.', 'TRADE_IN_POLICY_INVALID', { errors });
  const policy = normalizeTradeInPolicy(next);
  await setSetting(c.env.DB, 'tradeInPolicy', policy);
  await c.env.DB.batch((await auditStatements(c.env.DB, admin.id, 'trade_in.policy.save', 'tradeInPolicy', { policy })).statements);
  return c.json({ success: true, policy });
});

/**
 * THE OWNER'S COMPONENT REFERENCES (§4.3 rules 3–4): for a model whose printer-only or AMS-only
 * part has no price of its own today, a listed product that stands for it, or a USD figure.
 * Read with the costs; written by the owner.
 */
adminTradeInRoutes.get('/component-refs', requireCostRead, async (c) => {
  await requireTradeInV2(c.env.DB);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, refs: await listComponentRefs(c.env.DB) });
});

function refKeyOf(body: Record<string, unknown>) {
  const product_id = str(body.product_id, 'product_id', { min: 1, max: 80 });
  const option_value_id = str(body.option_value_id, 'option_value_id', { max: 80, required: false }) ?? '';
  const role = oneOf(body.role, 'role', ['device', 'ams'] as const);
  return { product_id, option_value_id, role };
}

adminTradeInRoutes.put('/component-refs', requireMoneyAuthority('trade_in_rules'), async (c) => {
  await requireTradeInV2(c.env.DB);
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in-refs', 120, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const key = refKeyOf(body);
  const refProduct = body.ref_product_id === null || body.ref_product_id === undefined || body.ref_product_id === '' ? null : str(body.ref_product_id, 'ref_product_id', { max: 80 });
  const refUsd = body.ref_price_usd === null || body.ref_price_usd === undefined || body.ref_price_usd === '' ? null : String(body.ref_price_usd).trim();
  if (refUsd !== null && !isUsdText(refUsd)) throw badRequest('ref_price_usd must be a dollar figure above zero with at most two decimals', 'TRADE_IN_REF_INVALID');
  if (!refProduct && !refUsd) throw badRequest('Name a reference product or a dollar figure', 'TRADE_IN_REF_INVALID');
  const exists = await c.env.DB.prepare(
    `SELECT (SELECT 1 FROM products WHERE id = ?1) AS model, (SELECT 1 FROM products WHERE id = ?2) AS ref`
  )
    .bind(key.product_id, refProduct ?? '')
    .first<{ model: number | null; ref: number | null }>();
  if (!exists?.model) throw notFound('Product not found');
  if (refProduct && !exists.ref) throw notFound('Reference product not found');
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO trade_in_component_refs (product_id, option_value_id, role, ref_product_id, ref_price_usd, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (product_id, option_value_id, role) DO UPDATE SET ref_product_id = ?4, ref_price_usd = ?5, updated_by = ?6, updated_at = ?7`
    ).bind(key.product_id, key.option_value_id, key.role, refProduct, refUsd, admin.id, now),
    ...(await auditStatements(c.env.DB, admin.id, 'trade_in.component_ref.save', key.product_id, { ...key, ref_product_id: refProduct, ref_price_usd: refUsd })).statements,
  ]);
  return c.json({ success: true, refs: await listComponentRefs(c.env.DB) });
});

adminTradeInRoutes.delete('/component-refs', requireMoneyAuthority('trade_in_rules'), async (c) => {
  await requireTradeInV2(c.env.DB);
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const key = refKeyOf(body);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM trade_in_component_refs WHERE product_id = ? AND option_value_id = ? AND role = ?').bind(key.product_id, key.option_value_id, key.role),
    ...(await auditStatements(c.env.DB, admin.id, 'trade_in.component_ref.delete', key.product_id, key)).statements,
  ]);
  return c.json({ success: true, refs: await listComponentRefs(c.env.DB) });
});

/** The owner's trade-in P&L over [from, to) — ISO dates; the last 30 days by default (cost_read). */
adminTradeInRoutes.get('/pnl', requireCostRead, async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const day = (v: string | undefined, d: Date) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(`${v}T00:00:00.000Z`) : d);
  const to = day(c.req.query('to'), new Date(Date.now() + 86_400_000));
  const from = day(c.req.query('from'), new Date(to.getTime() - 31 * 86_400_000));
  if (from >= to) throw badRequest('from must be before to');
  return c.json({ success: true, pnl: await tradeInPnl(c.env.DB, from.toISOString(), to.toISOString()) });
});

function familyOf(c: Context<AppContext>): TradeInFamily {
  const f = c.req.param('family') ?? '';
  if (!(TRADE_IN_FAMILIES as readonly string[]).includes(f)) throw notFound('Unknown family');
  return f as TradeInFamily;
}

adminTradeInRoutes.put('/rules/:family', requireMoneyAuthority('trade_in_rules'), async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in-rules', 60, 3600);
  const family = familyOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const note = str(body.note, 'note', { max: 300, required: false });
  const saved = await run(() => saveRuleSet(c.env, family, body.rules, admin.id, note));
  return c.json({ success: true, rules: { ...publicRules(saved), id: saved.id, note: saved.note, created_at: saved.created_at } });
});

/**
 * «جرّب القواعد» — the editor's calculator, answered by the same validator
 * and engine a save and a customer's estimate use. Nothing is stored.
 */
adminTradeInRoutes.post('/rules/:family/test', async (c) => {
  const family = familyOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const checked = validateRuleSet(body.rules, family);
  if (!checked.ok) throw new HttpError(400, 'Some rule values are invalid.', 'TRADE_IN_RULES_INVALID', { errors: checked.errors });
  const rules = { ...checked.value, version: 0, is_default: false };
  const s = (body.sample ?? {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi ? v : d);
  const inputs = validateInputs({ ...blankInputs(family), ...((s.inputs ?? {}) as object) }, rules);
  if (!inputs.ok) throw new HttpError(400, 'Some sample answers are invalid.', 'TRADE_IN_INPUTS_INVALID', { errors: inputs.errors });
  const valuation = valuateComponent(
    rules,
    {
      base_iqd: num(s.base_iqd, 0, 1_000_000_000, 1_000_000),
      usage_months: num(s.usage_months, 0, 240, 12),
      warranty_remaining_months: num(s.warranty_remaining_months, 0, 240, 0),
      product_id: typeof s.product_id === 'string' ? s.product_id.slice(0, 80) : '',
    },
    inputs.value
  );
  const target = num(s.target_price_iqd, 0, 1_000_000_000, 0);
  return c.json({ success: true, valuation, settlement: target ? tradeInSettlement(target, valuation.value_iqd) : null });
});

