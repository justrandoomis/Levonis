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
 *   GET    /requests/:id                      the request, its timeline and the rules that price it
 *   PATCH  /requests/:id                      save answers / target / note (draft only)
 *   POST   /requests/:id/photos               one photograph (multipart: file, component, angle)
 *   DELETE /requests/:id/photos/:pid          remove one (draft only)
 *   POST   /requests/:id/submit               send for review — the server enforces answers, photos, target
 *   POST   /requests/:id/cancel
 *   POST   /requests/:id/accept | /reject     answer a changed value ({offer_no})
 *   POST   /requests/:id/checkout             the credit coupon for the real checkout
 *
 * ADMIN (mounted at /api/admin/trade-in):
 *   GET    /requests  · GET /requests/:id
 *   POST   /requests/:id/inspect              any admin
 *   POST   /requests/:id/approve              FINANCIAL — fixes money
 *   POST   /requests/:id/value                FINANCIAL — proposes money
 *   POST   /requests/:id/complete             any admin (the exchange happened)
 *   POST   /requests/:id/cancel               any admin, with a reason
 *   GET    /rules                             every family's rules in force + history
 *   PUT    /rules/:family                     FINANCIAL — saves a NEW version
 *   POST   /rules/:family/test                validate a draft rule set and price a sample
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest, int, notFound, oneOf, requireAdmin, requireAuth, str, unavailable } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { newId } from '../lib/crypto';
import { requireFinancialScope } from '../lib/walletAdjust';
import { canViewFinancials } from '../lib/adminScope';
import { buildMediaKey, deleteMediaObject, putMediaObject } from '../lib/mediaStorage';
import { convertToWebp, extensionFor, isConvertibleToWebp } from '../lib/imageConvert';
import { rasterDimensions } from '../lib/imageMetadata';
import { HEIF_REFUSAL, isHeifBytes, sniff } from './uploads';
import { processOutbox } from '../lib/outbox';
import { safeParse } from '../lib/types';
import {
  TradeInError,
  adminList,
  approveEstimate,
  cancelRequest,
  changeValue,
  checkoutCredit,
  completeRequest,
  createDraft,
  decideValue,
  listEligible,
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
  publicRules,
  requestView,
  ruleSetHistory,
  saveDraft,
  saveRuleSet,
  stampCustomerPrompt,
  submitRequest,
} from '../lib/tradeIn';
import {
  MAX_DAMAGE_PHOTOS,
  MAX_PHOTOS_PER_ANGLE,
  MAX_PHOTOS_PER_REQUEST,
  OPTIONAL_PHOTO,
  TRADE_IN_FAMILIES,
  TRADE_IN_SCOPES,
  TRADE_IN_STATUSES,
  blankInputs,
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

// =========================================================================
//  CUSTOMER
// =========================================================================

export const tradeInRoutes = new Hono<AppContext>();
tradeInRoutes.use('*', requireAuth);

tradeInRoutes.get('/eligible', async (c) => {
  const user = c.get('user')!;
  const units = await run(() => listEligible(c.env, user.id));
  const book = await loadRuleBook(c.env.DB);
  return c.json({
    success: true,
    units,
    // The rule sets the preview will need for these units' families — the
    // same numbers the server prices with, so the first estimate on the phone
    // is already the real one.
    rules: Object.fromEntries(TRADE_IN_FAMILIES.map((f) => [f, publicRules(book[f])])),
  });
});

tradeInRoutes.get('/targets', async (c) => {
  await rateLimit(c, 'trade_in_read', 120, 60);
  return c.json({ success: true, targets: await listTargets(c.env) });
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
  const req = await run(() => saveDraft(c.env, user.id, id, body));
  return c.json({ success: true, request: await requestView(c.env, req, 'customer') });
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
  if (!isAllowedAngle(comp.family, angle)) throw badRequest('That photo angle does not apply to this device.', 'TRADE_IN_PHOTO_ANGLE');
  const photos = await loadPhotos(c.env.DB, id);
  const sameAngle = photos.filter((p) => p.component_role === role && p.angle === angle).length;
  const perAngle = angle === OPTIONAL_PHOTO.id ? MAX_DAMAGE_PHOTOS : MAX_PHOTOS_PER_ANGLE;
  if (sameAngle >= perAngle || photos.length >= MAX_PHOTOS_PER_REQUEST) {
    throw new HttpError(409, 'You reached the photo limit for this angle or request.', 'TRADE_IN_PHOTO_LIMIT');
  }
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
  const photoId = newId('tip');
  const key = buildMediaKey({ visibility: 'private', domain: 'trade-in', entityId: id, kind: 'photos', extension: ext, objectId: newId() });
  await putMediaObject(
    c.env,
    {
      key,
      visibility: 'private',
      domain: 'trade-in',
      mime,
      bytes: buf.byteLength,
      ownerId: user.id,
      entityId: id,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      originalName: String(form.get('originalName') || file.name || '').slice(0, 200),
    },
    buf,
    { httpMetadata: { contentType: mime, cacheControl: 'private, max-age=300' } }
  );
  const now = new Date().toISOString();
  // Draft-fenced: a photo cannot attach to a request that was sent while the
  // bytes were in flight. The INSERT … SELECT writes nothing in that case.
  const res = await c.env.DB.prepare(
    `INSERT INTO trade_in_photos (id, request_id, component_role, angle, file_key, mime, bytes, width, height, uploaded_by, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
      WHERE EXISTS (SELECT 1 FROM trade_in_requests WHERE id = ?2 AND user_id = ?10 AND status = 'draft')`
  )
    .bind(photoId, id, role, angle, key, mime, buf.byteLength, dims?.width ?? null, dims?.height ?? null, user.id, now)
    .run();
  if (!res.meta?.changes) {
    await deleteMediaObject(c.env, 'private', key).catch(() => undefined);
    throw new HttpError(409, 'This request was already sent and can no longer be edited.', 'TRADE_IN_NOT_EDITABLE');
  }
  return c.json(
    { success: true, photo: { id: photoId, component: role, angle, url: `/files/${key}`, width: dims?.width ?? null, height: dims?.height ?? null, created_at: now } },
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
      afterResponse(c, Promise.all([stampCustomerPrompt(c.env, res.request), notifyAdmins(c.env, res.request, decision === 'accept' ? 'accepted' : 'rejected')]));
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
  return c.json({
    success: true,
    coupon_code: credit.code,
    order_id: credit.order_id,
    target: {
      product_id: req.target_product_id,
      slug: tgt.slug ?? null,
      option_value_ids: safeParse<string[]>(req.target_option_value_ids, []),
      color_id: req.target_color_id,
    },
    credit_iqd: req.credit_iqd,
    difference_iqd: req.difference_iqd,
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

adminTradeInRoutes.get('/requests', async (c) => {
  const status = c.req.query('status') || null;
  const family = c.req.query('family') || null;
  if (status && !(TRADE_IN_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown status');
  if (family && !(TRADE_IN_FAMILIES as readonly string[]).includes(family)) throw badRequest('Unknown family');
  const search = (c.req.query('q') || '').trim().slice(0, 120) || null;
  const page = int(c.req.query('page'), 'page', { min: 1, max: 1000, def: 1 });
  const limit = 30;
  const out = await adminList(c.env.DB, { status, family, search, limit, offset: (page - 1) * limit });
  return c.json({ success: true, ...out, page, limit });
});

adminTradeInRoutes.get('/requests/:id', async (c) => {
  const req = await adminRequest(c);
  const view = await requestView(c.env, req, 'admin');
  const customer = await c.env.DB.prepare('SELECT id, name, email, phone_e164, username FROM users WHERE id = ?').bind(req.user_id).first();
  return c.json({ success: true, request: view, customer, financial_scope: canViewFinancials(c.env, c.get('user')) });
});

adminTradeInRoutes.post('/requests/:id/inspect', async (c) => {
  const admin = c.get('user')!;
  const req = await run(async () => markInspected(c.env, await adminRequest(c), admin.id));
  return c.json({ success: true, request: await requestView(c.env, req, 'admin') });
});

adminTradeInRoutes.post('/requests/:id/approve', requireFinancialScope, async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in', 120, 3600);
  const req = await run(async () => approveEstimate(c.env, await adminRequest(c), admin.id));
  return c.json({ success: true, request: await requestView(c.env, req, 'admin') });
});

adminTradeInRoutes.post('/requests/:id/value', requireFinancialScope, async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-trade-in', 120, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { max: 500, required: false });
  const raw = body.value_iqd;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw badRequest('The value must be a whole number of dinars.', 'TRADE_IN_INVALID_VALUE');
  }
  const req = await run(async () => changeValue(c.env, await adminRequest(c), admin.id, raw, reason));
  afterResponse(
    c,
    notifyCustomerOfValue(c.env, req).then(() => processOutbox(c.env, 5, { eventKeyPrefix: `trade_in:${req.id}:` }))
  );
  return c.json({ success: true, request: await requestView(c.env, req, 'admin') });
});

adminTradeInRoutes.post('/requests/:id/complete', async (c) => {
  const admin = c.get('user')!;
  const req = await run(async () => completeRequest(c.env, await adminRequest(c), admin.id));
  return c.json({ success: true, request: await requestView(c.env, req, 'admin') });
});

adminTradeInRoutes.post('/requests/:id/cancel', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { min: 3, max: 500 });
  const req = await run(async () => cancelRequest(c.env, await adminRequest(c), { id: admin.id, role: 'admin' }, reason));
  return c.json({ success: true, request: await requestView(c.env, req, 'admin') });
});

adminTradeInRoutes.get('/rules', async (c) => {
  const book = await loadRuleBook(c.env.DB);
  const history = Object.fromEntries(await Promise.all(TRADE_IN_FAMILIES.map(async (f) => [f, await ruleSetHistory(c.env.DB, f)] as const)));
  return c.json({
    success: true,
    rules: Object.fromEntries(TRADE_IN_FAMILIES.map((f) => [f, { ...publicRules(book[f]), id: book[f].id, note: book[f].note, created_at: book[f].created_at }])),
    history,
    financial_scope: canViewFinancials(c.env, c.get('user')),
  });
});

function familyOf(c: Context<AppContext>): TradeInFamily {
  const f = c.req.param('family') ?? '';
  if (!(TRADE_IN_FAMILIES as readonly string[]).includes(f)) throw notFound('Unknown family');
  return f as TradeInFamily;
}

adminTradeInRoutes.put('/rules/:family', requireFinancialScope, async (c) => {
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

