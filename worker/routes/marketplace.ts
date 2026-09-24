/**
 * The customer-request marketplace — /api/marketplace/*.
 *
 * A customer describes a job, merchants offer, the customer picks one, and
 * the money is held until the work is done. Three rules shape every handler:
 *
 *   1. ONE OFFER WINS. Acceptance must be atomic. Two taps, or two tabs, must
 *      not produce two contracts on one request — so the winning UPDATE is
 *      conditional on the request still being open, and the loser sees a
 *      conflict rather than a second order (§27).
 *
 *   2. THE CUSTOMER'S DETAILS ARE NOT PUBLIC. A request listing shows the
 *      job, not the person. A merchant learns how to reach the customer when
 *      they are engaged — after their offer is accepted — and not before
 *      (§24). This is enforced by the SELECT list, not by the frontend
 *      choosing what to render.
 *
 *   3. AN ACCEPTED OFFER IS FROZEN. Its price and promise are snapshot onto
 *      the community order, and the offer becomes immutable. A merchant
 *      cannot revise what they owe after the customer has committed (§26).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, forbidden, notFound, conflict, str, int, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import {
  classifyAttachment,
  maxBytesFor,
  safeFileName,
  MODEL_MAX_BYTES,
} from '../lib/attachments';
import { getTierStatus, benefits, usersWithEntitlement } from '../lib/entitlements';
import { requireOfferPrivileges, requireSellingPrivileges, storeForUser } from '../lib/merchantAuth';
import { feeFor, autoCompleteDays } from '../lib/merchantOps';
import {
  escrowForOrder,
  escrowRecordStatements,
  releaseEscrow,
  releaseEscrowReservation,
  refundEscrow,
  disputeEscrow,
  reserveEscrowFunds,
  type HoldEscrowInput,
} from '../lib/escrowOps';
import { assertHoldStateStatement, isConstraintAbort } from '../lib/walletOps';
import { announceAfterResponse } from '../lib/adminTopicRouting';
// Levo Community's maintenance switch, on the routes that START trade here
// (the owner closed /requests with the community — docs/DECISIONS.md).
import { communityClosedRefusal, requireCommunityOpen } from '../lib/communityGate';
import { notifyOfferReceived } from '../lib/engagementNotify';
import { deleteMediaObject, getMediaObject, headMediaObject, isSafeMediaKey, putMediaObject } from '../lib/mediaStorage';
import {
  REQUEST_OPEN_STATES,
  canMoveRequest,
  canMoveCommunityOrder,
  cancellationPolicy,
  orderIsActive,
  type RequestState,
  type CommunityOrderState,
} from '../lib/communityStates';
import {
  BOARD_STATES,
  CUSTOMER_CANCELLABLE_STATES,
  completionStatements,
  isEngagedMerchant,
  isPast,
  merchantTakesNewWork,
  offerAcceptedNotification,
  offerCountStatement,
  onPublicBoard,
  requestFileAccess,
  requestMovedFence,
  revokeViewerTokensStatement,
  staleOfferNotifications,
  type RequestForAccess,
} from '../lib/communityRequests';

export const marketplaceRoutes = new Hono<AppContext>();

const nowIso = () => new Date().toISOString();

// --------------------------------------------------------------- shapes

/**
 * The public view of a request.
 *
 * Note what is absent: no customer email, phone, address or user id. A
 * merchant browsing the board sees a job to quote on and a display name,
 * which is everything they need to decide whether to offer.
 */
function publicRequest(r: Record<string, unknown>) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
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
    customer_name: r.customer_name ?? null,
    file_count: r.file_count ?? 0,
    /** The job's version. It moves when a published request's terms change,
     *  and an offer priced against an older one is stale (migration 0116). */
    revision: r.revision ?? 1,
  };
}

function offerShape(o: Record<string, unknown>, proBadges: Set<string> = new Set()) {
  return {
    id: o.id,
    request_id: o.request_id,
    merchant_id: o.merchant_id,
    store_id: o.store_id,
    price_iqd: o.price_iqd,
    completion_days: o.completion_days,
    delivery_method: o.delivery_method,
    message: o.message,
    materials: o.materials,
    included: o.included,
    warranty_terms: o.warranty_terms,
    state: o.state,
    expires_at: o.expires_at,
    created_at: o.created_at,
    /**
     * THE VERSION THE CUSTOMER IS LOOKING AT. Acceptance sends it back with
     * the price, and only that exact version can be accepted (audit 03 §10 B).
     */
    revision: Number(o.revision ?? 1),
    /**
     * STALE: the customer changed the job after this offer priced it (audit 03
     * §10 K). It cannot be accepted until its merchant re-confirms it. Known
     * only where the request's own revision was read alongside the offer.
     */
    stale:
      o.state === 'pending' && o.r_revision !== undefined && o.r_revision !== null
        ? Number(o.request_revision ?? 1) < Number(o.r_revision)
        : false,
    // What a customer needs to compare offers (§27) — reputation, not contact
    // details.
    merchant: o.m_name
      ? {
          id: o.merchant_id,
          name: o.m_name,
          verified: !!o.m_verified,
          /** Membership status badge, separate from the moderation mark. */
          pro_badge: proBadges.has(String(o.m_user_id)),
          badge: o.m_badge_override || o.m_badge,
          rating: o.m_rating_count ? Number(o.m_rating) / 100 : null,
          rating_count: o.m_rating_count,
          completed_orders: o.m_completed,
          store_slug: o.s_slug ?? null,
        }
      : null,
  };
}

// -------------------------------------------------------------- requests

/** The public board. Only states a merchant can still act on. */
marketplaceRoutes.get('/requests', requireCommunityOpen, async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  const cursor = c.req.query('cursor') || '';
  const category = c.req.query('category') || '';
  const governorate = c.req.query('governorate') || '';

  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.title, r.description, r.category, r.quantity, r.material, r.color,
            r.dimensions, r.budget_iqd, r.deadline, r.governorate, r.delivery_pref,
            r.state, r.offer_count, r.created_at, r.expires_at,
            u.name AS customer_name,
            (SELECT COUNT(*) FROM community_request_files f WHERE f.request_id = r.id) AS file_count
       FROM community_requests r JOIN users u ON u.id = r.customer_id
      WHERE r.state IN ('open','receiving_offers')
        AND r.visibility = 'public'
        AND (r.expires_at IS NULL OR r.expires_at > ?)
        AND (? = '' OR r.category = ?)
        AND (? = '' OR r.governorate = ?)
        AND (? = '' OR r.created_at < ?)
      ORDER BY r.created_at DESC LIMIT ?`
  ).bind(nowIso(), category, category, governorate, governorate, cursor, cursor, limit).all();

  return c.json({
    success: true,
    requests: results.map(publicRequest),
    next_cursor: results.length === limit ? String(results[results.length - 1].created_at) : null,
  });
});

marketplaceRoutes.get('/requests/:id', requireCommunityOpen, async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const user = c.get('user');
  const r = await c.env.DB.prepare(
    `SELECT r.*, u.name AS customer_name,
            (SELECT COUNT(*) FROM community_request_files f WHERE f.request_id = r.id) AS file_count
       FROM community_requests r JOIN users u ON u.id = r.customer_id
      WHERE r.id = ?`
  ).bind(id).first<Record<string, unknown>>();
  if (!r) throw notFound('Request not found');

  const isOwner = !!user && user.id === r.customer_id;
  // A draft, a closed, a private or an EXPIRED request is only visible to the
  // customer who made it and to the merchant actually engaged on it. Expiry is
  // part of the question (audit 03 §10 I): the board hid an expired request
  // while this page still served it to anyone holding the link.
  if (!isOwner && !onPublicBoard(r as unknown as RequestForAccess)) {
    const engaged = user ? await isEngagedMerchant(c.env.DB, id, user.id) : false;
    if (!engaged) throw notFound('Request not found');
  }

  const files = await c.env.DB.prepare(
    'SELECT id, file_name, content_type, size_bytes, kind FROM community_request_files WHERE request_id = ?'
  ).bind(id).all<Record<string, unknown>>();

  return c.json({
    success: true,
    request: publicRequest(r),
    // R2 keys are NEVER returned. What a caller gets is a route on this
    // worker, which re-derives their right to the file on every read — so a
    // link shared after the request closes simply stops working.
    files: files.results.map((f) => ({
      ...f,
      inline: String(f.content_type ?? '').startsWith('image/'),
      url: `/api/marketplace/requests/${id}/files/${f.id}`,
    })),
    is_owner: isOwner,
  });
});

// ------------------------------------------------------------ attachments

/**
 * Attachments for a print request.
 *
 * A "make me this" request without the thing to make is half a request, so a
 * customer attaches reference photos, a PDF drawing, or the model itself.
 * Three decisions govern the whole section:
 *
 * THE KEY NEVER LEAVES THE SERVER. Files are stored under `requests/<user>/`,
 * a prefix `/files/*` refuses outright, so there is no URL to guess and no
 * bucket to walk. Every read goes through the route below, which re-derives
 * the caller's right to the file from the request it belongs to (§22, §67).
 *
 * WHO MAY READ IS DERIVED FROM THE REQUEST. The customer always; any signed-in
 * caller while the request is public and open, because a merchant cannot quote
 * a model they are not allowed to look at; the engaged merchant afterwards;
 * an admin. When the request closes, the general permission closes with it.
 *
 * A FILE IS ROW AND OBJECT TOGETHER. The row is written after the object
 * lands and deleted before it, so the failure mode is an orphaned object that
 * costs storage rather than a row pointing at nothing that breaks a page.
 */

const MAX_FILES_PER_REQUEST = 6;

/** Where an attachment lives. Deliberately outside every public prefix. */
const attachmentKey = (userId: string, ext: string) => `requests/${userId}/${newId()}.${ext}`;

async function requestForFiles(c: Context<AppContext>, id: string, userId: string) {
  const r = await c.env.DB.prepare(
    'SELECT id, customer_id, state, visibility FROM community_requests WHERE id = ?'
  ).bind(id).first<{ id: string; customer_id: string; state: string; visibility: string }>();
  if (!r) throw notFound('Request not found');
  if (r.customer_id !== userId) throw notFound('Request not found');
  return r;
}

/**
 * A PUBLISHED JOB CHANGED — its revision moves (migration 0116). Conditional
 * on the request taking offers, so editing a DRAFT (the wizard uploading its
 * files) revises nothing: no merchant has priced it yet.
 */
function reviseStatement(db: D1Database, requestId: string, ts: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE community_requests SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND state IN ('open','receiving_offers')`
    )
    .bind(ts, requestId);
}

/** Tell every merchant whose pending offer priced an older revision. Never throws. */
async function notifyStaleOffers(db: D1Database, requestId: string): Promise<void> {
  try {
    const row = await db
      .prepare(`SELECT revision FROM community_requests WHERE id = ? AND state IN ('open','receiving_offers')`)
      .bind(requestId)
      .first<{ revision: number }>();
    if (!row) return;
    const stmts = await staleOfferNotifications(db, requestId, Number(row.revision));
    if (stmts.length) await db.batch(stmts);
  } catch (e) {
    console.error('stale-offer notifications not written for', requestId, e instanceof Error ? e.message : String(e));
  }
}

marketplaceRoutes.post('/requests/:id/files', requireAuth, async (c) => {
  await rateLimit(c, 'request-file', 40, 3600);
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const r = await requestForFiles(c, id, user.id);

  // Attachments are part of what merchants priced against. Adding one after
  // an offer was accepted would change the job under a signed contract, so
  // the window closes when the request stops taking offers.
  if (!REQUEST_OPEN_STATES.includes(r.state as RequestState) && r.state !== 'draft') {
    throw conflict('This request is no longer open, so its attachments cannot change', 'REQUEST_NOT_EDITABLE');
  }

  const existing = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?'
  ).bind(id).first<{ n: number }>();
  if (Number(existing?.n ?? 0) >= MAX_FILES_PER_REQUEST) {
    throw badRequest(`A request may have at most ${MAX_FILES_PER_REQUEST} attachments`);
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');

  // Read the ceiling from the DECLARED size first, so a 900 MB upload is
  // refused before it is pulled into memory. The real size is re-checked
  // against the real kind after classification, below.
  if (file.size > MODEL_MAX_BYTES) {
    throw badRequest(`File is too large (max ${Math.round(MODEL_MAX_BYTES / 1024 / 1024)} MB)`);
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = classifyAttachment(buf, file.name);
  if (!kind) {
    throw badRequest(
      'Unsupported file — attach a JPEG, PNG, WebP or GIF image, a PDF, or an STL, 3MF or OBJ model'
    );
  }
  const max = maxBytesFor(kind.kind);
  if (buf.byteLength > max) {
    throw badRequest(`That file is too large (max ${Math.round(max / 1024 / 1024)} MB for this type)`);
  }

  const key = attachmentKey(user.id, kind.ext);
  await putMediaObject(
    c.env,
    {
      key,
      visibility: 'private',
      domain: 'requests',
      mime: kind.mime,
      bytes: buf.byteLength,
      ownerId: user.id,
      entityId: id,
      originalName: file.name,
    },
    buf,
    { httpMetadata: { contentType: kind.mime, cacheControl: 'private, max-age=0' } }
  );

  const fileId = newId('crf');
  const name = safeFileName(file.name, kind.ext);
  const ts = nowIso();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(fileId, id, key, name, kind.mime, buf.byteLength, kind.kind),
      // A PUBLISHED job changed: revise it in the same write, so every offer
      // priced without this file is stale until its merchant re-confirms.
      reviseStatement(c.env.DB, id, ts),
    ]);
  } catch (e) {
    // The row is what makes the object reachable. If it cannot be written,
    // delete the object rather than leaving a file nothing points at.
    await deleteMediaObject(c.env, 'private', key).catch(() => {});
    throw e;
  }
  await notifyStaleOffers(c.env.DB, id);

  return c.json({
    success: true,
    file: {
      id: fileId,
      file_name: name,
      content_type: kind.mime,
      size_bytes: buf.byteLength,
      kind: kind.kind,
      inline: kind.inline,
      url: `/api/marketplace/requests/${id}/files/${fileId}`,
    },
  }, 201);
});

/**
 * Stream one attachment, after re-deriving the caller's right to it.
 *
 * The permission is recomputed on every read rather than baked into a URL:
 * a link shared after the request closed stops working, which is the point of
 * not having a public key in the first place.
 */
marketplaceRoutes.get('/requests/:id/files/:fileId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const fileId = str(c.req.param('fileId'), 'fileId', { min: 1, max: 60 });

  const row = await c.env.DB.prepare(
    `SELECT f.file_key, f.file_name, f.content_type, f.kind,
            r.id, r.customer_id, r.state, r.visibility, r.expires_at
       FROM community_request_files f
       JOIN community_requests r ON r.id = f.request_id
      WHERE f.id = ? AND f.request_id = ?`
  ).bind(fileId, id).first<{
    file_key: string; file_name: string; content_type: string; kind: string;
  } & RequestForAccess>();
  if (!row) throw notFound('File not found');

  // ONE policy for every door onto a request's files (worker/lib/
  // communityRequests.ts): the customer, an admin, the engaged merchant — and
  // the board, which means NOT EXPIRED and Levo Community letting this caller
  // in (audit 03 §10 G: the board answered 503 while this answered 200).
  const { access, gateClosed } = await requestFileAccess(c.env, row, user, { allowAdmin: true });
  if (gateClosed) throw communityClosedRefusal();
  if (!access) throw notFound('File not found');

  const obj = await getMediaObject(c.env, 'private', row.file_key);
  if (!obj) throw notFound('File not found');

  // Pictures may render in place; a model or a document is handed over as a
  // download. Even for a picture the response is sandboxed with `nosniff`, so
  // a file that somehow passed classification cannot be run as script.
  const inline = row.content_type.startsWith('image/');
  const headers = new Headers({
    'Content-Type': row.content_type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${row.file_name}"`,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
});

marketplaceRoutes.delete('/requests/:id/files/:fileId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const fileId = str(c.req.param('fileId'), 'fileId', { min: 1, max: 60 });
  const r = await requestForFiles(c, id, user.id);

  // Same window as adding. Removing the model a merchant quoted against,
  // after they quoted, would leave the price attached to a job nobody can see
  // — so on a published request it revises the job and the offers go stale.
  if (!REQUEST_OPEN_STATES.includes(r.state as RequestState) && r.state !== 'draft') {
    throw conflict('This request is no longer open, so its attachments cannot change', 'REQUEST_NOT_EDITABLE');
  }

  const row = await c.env.DB.prepare(
    'SELECT file_key FROM community_request_files WHERE id = ? AND request_id = ?'
  ).bind(fileId, id).first<{ file_key: string }>();
  if (!row) throw notFound('File not found');

  // Row first: while it exists the object is reachable, so removing it last
  // can only leave an unreferenced object, never a broken reference.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM community_request_files WHERE id = ? AND request_id = ?').bind(fileId, id),
    reviseStatement(c.env.DB, id, nowIso()),
  ]);
  await deleteMediaObject(c.env, 'private', row.file_key).catch(() => {});
  await notifyStaleOffers(c.env.DB, id);

  return c.json({ success: true });
});

/**
 * CREATE A REQUEST — AS A DRAFT (audit 03 §10 E).
 *
 * The print wizard calls this at the end of its FIRST step, because a file
 * belongs to a request and must be uploaded (and measured) before the customer
 * has chosen a material. The row used to be created `open` and public, so an
 * abandoned wizard left a live job on the board that merchants could bid on
 * with no matching, no estimate and no spec — and PRINT_REQUESTS.md promised
 * the opposite: publishing is the last moment before any merchant sees it.
 *
 * So the row is born `draft` (status `closed`, the coarse mirror every older
 * reader already treats as "not on the board"): invisible to everyone but its
 * customer, not biddable, and made public by exactly one transition —
 * `POST /api/marketplace/print/requests/:id/publish`, which also runs the
 * matching. The expiry clock starts there, not here.
 */
marketplaceRoutes.post('/requests', requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'request-create', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));

  const title = str(body.title, 'title', { min: 4, max: 140 });
  const description = str(body.description, 'description', { min: 10, max: 6000 });
  const expiryDays = await requestExpiryDays(c.env.DB);

  const id = newId('req');
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO community_requests
       (id, customer_id, title, description, status, state, category, quantity, material, color,
        dimensions, budget_iqd, deadline, governorate, delivery_pref, notes, visibility,
        created_at, expires_at, updated_at)
     VALUES (?,?,?,?,'closed','draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, user.id, title, description,
    str(body.category, 'category', { min: 0, max: 60, required: false }),
    int(body.quantity, 'quantity', { min: 1, max: 100_000, def: 1 }),
    str(body.material, 'material', { min: 0, max: 60, required: false }),
    str(body.color, 'color', { min: 0, max: 60, required: false }),
    str(body.dimensions, 'dimensions', { min: 0, max: 120, required: false }),
    body.budget_iqd === undefined || body.budget_iqd === null
      ? null
      : int(body.budget_iqd, 'budget_iqd', { min: 0, max: 1_000_000_000 }),
    str(body.deadline, 'deadline', { min: 0, max: 40, required: false }) || null,
    str(body.governorate, 'governorate', { min: 0, max: 60, required: false }),
    str(body.delivery_pref, 'delivery_pref', { min: 0, max: 40, required: false }),
    str(body.notes, 'notes', { min: 0, max: 2000, required: false }),
    body.visibility === 'private' ? 'private' : 'public',
    ts,
    new Date(Date.now() + expiryDays * 86_400_000).toISOString(),
    ts
  ).run();

  await audit(c.env.DB, user.id, 'community.request_created', id, { title, state: 'draft' });
  const row = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ?').bind(id).first();
  return c.json({ success: true, request: publicRequest(row as Record<string, unknown>) }, 201);
});

/**
 * AN OFFER'S OWN VALIDITY, OR NONE. The column took forty characters of free
 * text and nothing ever read it; now it is either absent or a real instant in
 * the future, stored as ISO so the expiry sweep and the acceptance can compare
 * it (audit 03 §10 I).
 */
function offerExpiry(raw: unknown, now: string): string | null {
  const text = str(raw, 'expires_at', { min: 0, max: 40, required: false });
  if (!text) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) throw badRequest('The offer validity is not a date', 'OFFER_EXPIRY_INVALID');
  const iso = new Date(at).toISOString();
  if (iso <= now) throw badRequest('The offer validity is already in the past', 'OFFER_EXPIRY_INVALID');
  return iso;
}

async function requestExpiryDays(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM admin_settings WHERE key = 'communityRequestExpiryDays'")
    .first<{ value: string }>();
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

/** The customer's own requests, including the closed ones. */
marketplaceRoutes.get('/my-requests', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, u.name AS customer_name,
            (SELECT COUNT(*) FROM community_request_files f WHERE f.request_id = r.id) AS file_count
       FROM community_requests r JOIN users u ON u.id = r.customer_id
      WHERE r.customer_id = ? ORDER BY r.created_at DESC LIMIT 50`
  ).bind(user.id).all();
  return c.json({ success: true, requests: results.map(publicRequest) });
});

/**
 * Close a request. Only the customer, and only while nothing is committed.
 *
 * ONCE AN ORDER EXISTS, THIS IS THE WRONG DOOR (audit 03 §10 J). The state
 * table lets a request in `in_progress` become `cancelled` — that is the
 * ORDER's cancellation and the admin's dispute ruling reaching the request —
 * and this route used to take the same path, so a customer could cancel the
 * request while its paid order kept running: request `cancelled`, order
 * `in_progress`, escrow `held`. A funded order is cancelled through
 * `/orders/:id/cancel` before work starts (which refunds it) and through a
 * dispute after, so here the customer may cancel only a draft or a request
 * still taking offers, and anything later is `REQUEST_HAS_ORDER`.
 */
marketplaceRoutes.post('/requests/:id/cancel', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const r = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ? AND customer_id = ?')
    .bind(id, user.id)
    .first<Record<string, unknown>>();
  if (!r) throw notFound('Request not found');

  const from = String(r.state) as RequestState;
  if (from === 'cancelled') return c.json({ success: true, replayed: true });
  if (!(CUSTOMER_CANCELLABLE_STATES as readonly string[]).includes(from) || !canMoveRequest(from, 'cancelled')) {
    throw conflict(
      ['offer_selected', 'in_progress', 'delivered', 'disputed'].includes(from)
        ? 'This request has a paid order. Cancel the order before work starts, or open a dispute.'
        : `A request that is ${from} cannot be cancelled here`,
      ['offer_selected', 'in_progress', 'delivered', 'disputed'].includes(from) ? 'REQUEST_HAS_ORDER' : 'REQUEST_NOT_CANCELLABLE'
    );
  }

  const ts = nowIso();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE community_requests SET state = 'cancelled', status = 'closed', updated_at = ?
          WHERE id = ? AND customer_id = ? AND state IN ('draft','open','receiving_offers')`
      ).bind(ts, id, user.id),
      // Nothing below runs unless the line above really moved it: an offer
      // accepted a moment ago must not be "rejected" by a cancel that lost.
      requestMovedFence(c.env.DB, id, 'cancelled', ts),
      // Pending offers are told why they will never be answered, rather than
      // being left hanging forever.
      c.env.DB.prepare(
        `UPDATE community_offers SET state = 'rejected', updated_at = ?
          WHERE request_id = ? AND state = 'pending'`
      ).bind(ts, id),
      offerCountStatement(c.env.DB, id),
      revokeViewerTokensStatement(c.env.DB, id, ts),
    ]);
  } catch (e) {
    if (!isConstraintAbort(e)) throw e;
    throw conflict('This request changed while you were cancelling it — reload it', 'REQUEST_CHANGED');
  }

  await audit(c.env.DB, user.id, 'community.request_cancelled', id, { from });
  return c.json({ success: true });
});

// ---------------------------------------------------------------- offers

/** Offers on a request. The customer sees all; a merchant sees only their own. */
marketplaceRoutes.get('/requests/:id/offers', requireAuth, async (c) => {
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const req = await c.env.DB.prepare('SELECT customer_id FROM community_requests WHERE id = ?')
    .bind(requestId)
    .first<{ customer_id: string }>();
  if (!req) throw notFound('Request not found');

  const isCustomer = req.customer_id === user.id;
  const mine = await storeForUser(c.env.DB, user.id);

  // A merchant must not be able to read a competitor's price on the same job.
  const { results } = await c.env.DB.prepare(
    `SELECT o.*, m.user_id AS m_user_id, m.name AS m_name, m.verified AS m_verified, m.badge AS m_badge,
            m.badge_override AS m_badge_override, m.rating_avg_x100 AS m_rating,
            m.rating_count AS m_rating_count, m.completed_orders AS m_completed,
            s.slug AS s_slug, r.revision AS r_revision
       FROM community_offers o
       JOIN community_requests r ON r.id = o.request_id
       JOIN community_merchants m ON m.id = o.merchant_id
       LEFT JOIN merchant_stores s ON s.id = o.store_id
      WHERE o.request_id = ?
        AND (? = 1 OR o.merchant_id = ?)
      ORDER BY o.created_at ASC`
  ).bind(requestId, isCustomer ? 1 : 0, mine?.merchant.id ?? '').all();

  const proBadges = await usersWithEntitlement(c.env.DB, results.map((row) => row.m_user_id), 'proMerchantBadge');
  return c.json({ success: true, offers: results.map((row) => offerShape(row, proBadges)), is_customer: isCustomer });
});

marketplaceRoutes.post('/requests/:id/offers', requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'offer-create', 30, 3600);
  const user = c.get('user')!;
  // A new promise: a restricted merchant makes none (audit 03 V).
  const ctx = await requireOfferPrivileges(c);
  const tier = await getTierStatus(c.env.DB, user.id);
  if (!benefits.communityOffers(tier)) throw forbidden('Your plan does not include community offers');

  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const req = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ?')
    .bind(requestId)
    .first<Record<string, unknown>>();
  // A draft or a private request is not on the board: to a merchant it does
  // not exist (audit 03 §10 E, V).
  if (!req || req.state === 'draft' || req.visibility !== 'public') throw notFound('Request not found');
  if (req.customer_id === user.id) throw badRequest('You cannot bid on your own request', 'OWN_REQUEST');
  const ts = nowIso();
  if (!REQUEST_OPEN_STATES.includes(String(req.state) as RequestState)) {
    throw conflict('This request is no longer accepting offers', 'REQUEST_NOT_OPEN');
  }
  if (isPast(req.expires_at as string | null, ts)) {
    throw conflict('This request has expired and no longer takes offers', 'REQUEST_EXPIRED');
  }

  const body = await c.req.json().catch(() => ({}));
  const price = int(body.price_iqd, 'price_iqd', { min: 1, max: 1_000_000_000 });
  const expiresAt = offerExpiry(body.expires_at, ts);

  const id = newId('off');
  let inserted = 0;
  try {
    const res = await c.env.DB.batch([
      // The offer is written ONLY while the request is still on the board —
      // re-checked here, in the write, not just above (audit 03 §10 P). It
      // prices the job's CURRENT revision.
      c.env.DB.prepare(
        `INSERT INTO community_offers
           (id, request_id, merchant_id, store_id, price_iqd, completion_days, delivery_method,
            message, materials, included, warranty_terms, state, expires_at, revision, request_revision,
            created_at, updated_at)
         SELECT ?1, r.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, 1, r.revision, ?12, ?12
           FROM community_requests r
          WHERE r.id = ?13 AND r.state IN ('open','receiving_offers') AND r.visibility = 'public'
            AND r.customer_id <> ?14
            AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?12)`
      ).bind(
        id, ctx.merchant.id, ctx.store.id, price,
        int(body.completion_days, 'completion_days', { min: 0, max: 365, def: 0 }),
        str(body.delivery_method, 'delivery_method', { min: 0, max: 60, required: false }),
        str(body.message, 'message', { min: 0, max: 2000, required: false }),
        str(body.materials, 'materials', { min: 0, max: 500, required: false }),
        str(body.included, 'included', { min: 0, max: 500, required: false }),
        str(body.warranty_terms, 'warranty_terms', { min: 0, max: 500, required: false }),
        expiresAt, ts, requestId, user.id
      ),
      c.env.DB.prepare(
        `UPDATE community_requests
            SET state = CASE WHEN state = 'open' THEN 'receiving_offers' ELSE state END,
                updated_at = ?
          WHERE id = ? AND state IN ('open','receiving_offers')
            AND EXISTS (SELECT 1 FROM community_offers WHERE id = ?)`
      ).bind(ts, requestId, id),
      // The board shows a live count; it is recomputed, never incremented.
      offerCountStatement(c.env.DB, requestId),
    ]);
    inserted = Number(res[0]?.meta.changes ?? 0);
  } catch (e) {
    // The partial unique index on (request_id, merchant_id) WHERE state is
    // live. A merchant already has an offer here; withdrawing frees the slot.
    // Anything else is a real failure and is not dressed up as this one.
    if (!(isConstraintAbort(e) && /UNIQUE/i.test(e instanceof Error ? e.message : String(e)))) throw e;
    throw conflict('You already have an active offer on this request', 'OFFER_EXISTS');
  }
  if (!inserted) {
    // The request left the board between the read above and the write.
    throw conflict('This request is no longer accepting offers', 'REQUEST_NOT_OPEN');
  }

  await audit(c.env.DB, user.id, 'community.offer_created', id, { request: requestId, price });
  /**
   * THE CUSTOMER WHOSE REQUEST THIS IS HEARS THAT AN OFFER ARRIVED.
   *
   * `'offer_received'` has been a declared `NotificationKind` since 0045 and was
   * never written by anything — a grep found the declaration and no sender. So
   * the whole community flow told the MERCHANTS a request matched them
   * (printRequests.ts) and told the CUSTOMER nothing at all when the answers
   * came back. They had to keep reopening the board to find out, which is what
   * the offer to send them a notification was supposed to end.
   *
   * It is deliberately NOT inside the batch above. That batch is the offer and
   * the request's counter, and a failed notification must never roll back a
   * merchant's bid; `notifyOfferReceived` cannot throw, and its replay
   * protection is per offer, so a retry cannot buzz the customer twice.
   */
  try {
    c.executionCtx.waitUntil(notifyOfferReceived(c.env, id));
  } catch {
    // No ExecutionContext on this path. Already in flight, cannot reject.
    void notifyOfferReceived(c.env, id);
  }
  const row = await c.env.DB.prepare('SELECT * FROM community_offers WHERE id = ?').bind(id).first();
  return c.json({ success: true, offer: offerShape(row as Record<string, unknown>) }, 201);
});

/** Withdraw an offer. Only while it is still pending. */
marketplaceRoutes.post('/offers/:id/withdraw', requireAuth, async (c) => {
  const user = c.get('user')!;
  const ctx = await requireSellingPrivileges(c);
  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const offer = await c.env.DB.prepare('SELECT request_id FROM community_offers WHERE id = ? AND merchant_id = ?')
    .bind(offerId, ctx.merchant.id)
    .first<{ request_id: string }>();
  if (!offer) throw notFound('Offer not found');
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_offers SET state = 'withdrawn', updated_at = ?
        WHERE id = ? AND merchant_id = ? AND state = 'pending'`
    ).bind(nowIso(), offerId, ctx.merchant.id),
    // The count comes down with the offer (audit 03 §10 H): it used to stay,
    // and a re-offer then advertised one more offer than existed.
    offerCountStatement(c.env.DB, offer.request_id),
  ]);
  if (!res[0]?.meta.changes) throw conflict('That offer can no longer be withdrawn', 'OFFER_NOT_AVAILABLE');
  await audit(c.env.DB, user.id, 'community.offer_withdrawn', offerId, {});
  return c.json({ success: true });
});

/**
 * Edit an offer — pending only. After acceptance it is the contract (§26).
 *
 * AN EDIT IS A NEW VERSION (audit 03 §10 B). It used to rewrite the offer in
 * place, unaudited, and acceptance took whatever the row said at that moment —
 * so a price changed after the customer read it was the price they paid. Now
 * every edit writes `revision + 1`; the customer's acceptance names the
 * revision and price they confirmed, and an older one is refused with the
 * fresh offer (`OFFER_CHANGED`). The edit also prices the job AS IT STANDS,
 * so it re-confirms an offer the customer's own change had made stale. What it
 * replaced is on the audit record.
 */
marketplaceRoutes.patch('/offers/:id', requireCommunityOpen, requireAuth, async (c) => {
  // An edit re-prices and re-confirms: a new promise (audit 03 V).
  const ctx = await requireOfferPrivileges(c);
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };

  if (body.price_iqd !== undefined) put('price_iqd', int(body.price_iqd, 'price_iqd', { min: 1, max: 1_000_000_000 }));
  if (body.completion_days !== undefined)
    put('completion_days', int(body.completion_days, 'completion_days', { min: 0, max: 365 }));
  if (body.delivery_method !== undefined)
    put('delivery_method', str(body.delivery_method, 'delivery_method', { min: 0, max: 60, required: false }));
  if (body.message !== undefined) put('message', str(body.message, 'message', { min: 0, max: 2000, required: false }));
  if (body.materials !== undefined) put('materials', str(body.materials, 'materials', { min: 0, max: 500, required: false }));
  if (body.included !== undefined) put('included', str(body.included, 'included', { min: 0, max: 500, required: false }));
  if (body.warranty_terms !== undefined)
    put('warranty_terms', str(body.warranty_terms, 'warranty_terms', { min: 0, max: 500, required: false }));
  if (!sets.length) throw badRequest('Nothing to update');

  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const before = await c.env.DB.prepare(
    `SELECT price_iqd, completion_days, delivery_method, message, materials, included, warranty_terms, revision
       FROM community_offers WHERE id = ? AND merchant_id = ?`
  ).bind(offerId, ctx.merchant.id).first<Record<string, unknown>>();
  if (!before) throw notFound('Offer not found');

  const ts = nowIso();
  // `state = 'pending'` is in the WHERE clause, so an accepted offer cannot be
  // edited even by a request that tries; and only while its request is still
  // on the board.
  const res = await c.env.DB.prepare(
    `UPDATE community_offers
        SET ${sets.join(', ')}, revision = revision + 1,
            request_revision = (SELECT r.revision FROM community_requests r WHERE r.id = community_offers.request_id),
            updated_at = ?
      WHERE id = ? AND merchant_id = ? AND state = 'pending'
        AND EXISTS (SELECT 1 FROM community_requests r
                     WHERE r.id = community_offers.request_id AND r.state IN ('open','receiving_offers')
                       AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?))`
  ).bind(...vals, ts, offerId, ctx.merchant.id, ts).run();
  if (!res.meta.changes) throw conflict('That offer can no longer be changed', 'OFFER_NOT_AVAILABLE');

  const row = await c.env.DB.prepare('SELECT * FROM community_offers WHERE id = ?').bind(offerId).first<Record<string, unknown>>();
  await audit(c.env.DB, c.get('user')!.id, 'community.offer_edited', offerId, {
    before,
    after: {
      price_iqd: row?.price_iqd, completion_days: row?.completion_days, delivery_method: row?.delivery_method,
      warranty_terms: row?.warranty_terms, revision: row?.revision,
    },
  });
  return c.json({ success: true, offer: offerShape(row as Record<string, unknown>) });
});

/**
 * «أؤكد عرضي» — the merchant stands by their offer for the job AS IT NOW IS.
 *
 * The customer changed a published request (a re-publish with a different
 * spec, an attachment added or removed) after this offer priced it, so the
 * offer is stale and cannot be accepted (audit 03 §10 K). Re-confirming
 * writes the request's current revision onto it and a new offer revision —
 * the customer is then accepting a promise made against the job they see.
 * To change the terms instead, the merchant edits (PATCH) or withdraws.
 */
marketplaceRoutes.post('/offers/:id/reconfirm', requireCommunityOpen, requireAuth, async (c) => {
  const ctx = await requireOfferPrivileges(c);
  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const ts = nowIso();
  const res = await c.env.DB.prepare(
    `UPDATE community_offers
        SET revision = revision + 1,
            request_revision = (SELECT r.revision FROM community_requests r WHERE r.id = community_offers.request_id),
            updated_at = ?1
      WHERE id = ?2 AND merchant_id = ?3 AND state = 'pending'
        AND request_revision < (SELECT r.revision FROM community_requests r WHERE r.id = community_offers.request_id)
        AND EXISTS (SELECT 1 FROM community_requests r
                     WHERE r.id = community_offers.request_id AND r.state IN ('open','receiving_offers')
                       AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?1))`
  ).bind(ts, offerId, ctx.merchant.id).run();
  if (!res.meta.changes) {
    const o = await c.env.DB.prepare(
      `SELECT o.state, o.request_revision, r.revision AS r_revision FROM community_offers o
         JOIN community_requests r ON r.id = o.request_id WHERE o.id = ? AND o.merchant_id = ?`
    ).bind(offerId, ctx.merchant.id).first<{ state: string; request_revision: number; r_revision: number }>();
    if (!o) throw notFound('Offer not found');
    if (o.state === 'pending' && Number(o.request_revision) >= Number(o.r_revision)) {
      throw conflict('This offer already matches the request as it is', 'OFFER_NOT_STALE');
    }
    throw conflict('That offer can no longer be changed', 'OFFER_NOT_AVAILABLE');
  }
  const row = await c.env.DB.prepare('SELECT * FROM community_offers WHERE id = ?').bind(offerId).first<Record<string, unknown>>();
  await audit(c.env.DB, c.get('user')!.id, 'community.offer_reconfirmed', offerId, {
    revision: row?.revision,
    request_revision: row?.request_revision,
  });
  return c.json({ success: true, offer: offerShape(row as Record<string, unknown>) });
});

// ------------------------------------------------------------- acceptance

/** Whether the merchant behind this offer row may take on new work now (review S2). */
function offerMerchantTakesWork(db: D1Database, offer: Record<string, unknown>): Promise<boolean> {
  return merchantTakesNewWork(db, {
    merchantStatus: offer.m_status,
    storeStatus: offer.s_status,
    ownerUserId: String(offer.m_user_id ?? ''),
  });
}

/** The offer, its request and its merchant — everything acceptance decides on. */
async function offerForAcceptance(db: D1Database, offerId: string) {
  return db
    .prepare(
      `SELECT o.*, r.customer_id, r.state AS request_state, r.id AS req_id, r.revision AS r_revision,
              r.expires_at AS r_expires_at,
              m.user_id AS m_user_id, m.name AS m_name, m.verified AS m_verified, m.badge AS m_badge,
              m.badge_override AS m_badge_override, m.rating_avg_x100 AS m_rating,
              m.rating_count AS m_rating_count, m.completed_orders AS m_completed,
              m.status AS m_status, s.status AS s_status,
              s.slug AS s_slug
         FROM community_offers o
         JOIN community_requests r ON r.id = o.request_id
         JOIN community_merchants m ON m.id = o.merchant_id
         LEFT JOIN merchant_stores s ON s.id = o.store_id
        WHERE o.id = ?`
    )
    .bind(offerId)
    .first<Record<string, unknown>>();
}

/**
 * WHY THIS OFFER CANNOT BE ACCEPTED AS SENT — or null when it can. One reading
 * for the checks before the money is reserved and for the classification
 * after a batch refused, so the two can never disagree about the reason.
 */
function acceptanceRefusal(
  offer: Record<string, unknown>,
  expected: { price: number; revision: number },
  now: string,
  merchantTakesWork: boolean
): HttpError | null {
  if (offer.state !== 'pending') return conflict('That offer is no longer available', 'OFFER_NOT_AVAILABLE');
  if (!(BOARD_STATES as readonly string[]).includes(String(offer.request_state))) {
    return conflict('This request already has an accepted offer', 'REQUEST_NOT_OPEN');
  }
  if (isPast(offer.r_expires_at as string | null, now)) {
    return conflict('This request has expired', 'REQUEST_EXPIRED');
  }
  if (isPast(offer.expires_at as string | null, now)) return conflict('This offer has expired', 'OFFER_EXPIRED');
  // A merchant who could not MAKE this offer today cannot be handed the
  // contract either (audit 03 V, review S2): the SAME allow-list as offer
  // creation — merchant active, store active, owner's plan valid
  // (`merchantTakesNewWork`, worker/lib/communityRequests.ts) — decided by the
  // caller before any money is reserved. The customer is told the merchant is
  // not taking work, never why: a paused shop, a lapsed plan and a sanction are
  // between the merchant and Levonis.
  if (!merchantTakesWork) {
    return conflict('This merchant is not taking new work right now — choose another offer', 'MERCHANT_UNAVAILABLE');
  }
  const fresh = { offer: offerShape(offer) };
  if (Number(offer.request_revision ?? 1) < Number(offer.r_revision ?? 1)) {
    return new HttpError(
      409,
      'You changed this request after the merchant made this offer — it can be accepted once they re-confirm it',
      'OFFER_STALE',
      fresh
    );
  }
  if (expected.price !== Number(offer.price_iqd) || expected.revision !== Number(offer.revision ?? 1)) {
    return new HttpError(409, 'This offer changed since you opened it — review it again', 'OFFER_CHANGED', fresh);
  }
  return null;
}

/**
 * Accept one offer. The single most important transaction in the marketplace.
 *
 * THE CUSTOMER ACCEPTS WHAT THEY SAW (audit 03 §10 B). The body carries the
 * `expected_price_iqd` and `offer_revision` the confirmation showed. If the
 * merchant edited the offer since, the answer is `OFFER_CHANGED` with the
 * fresh offer — never a hold at a price nobody confirmed. Missing values are
 * treated exactly like changed ones: the customer is shown the offer and asked
 * again. A STALE offer (priced before the customer changed the job) is
 * `OFFER_STALE`; an expired request or offer is `REQUEST_EXPIRED` /
 * `OFFER_EXPIRED` (§10 I).
 *
 * THE MONEY IS RESERVED FIRST, then everything is written in ONE batch. The
 * old order — move the request to `offer_selected`, create the order, THEN ask
 * whether the customer can pay — left a cancelled order that locked the offer
 * for ever when they could not, a 500 on their retry after topping up, and a
 * request stranded in `offer_selected` (audit 03 §10 A, 04 B12). Now a
 * customer who cannot pay is refused before anything is written, and the
 * request moves `open → in_progress` in the same commit as the offer freeze,
 * the rivals' rejection, the FUNDED order and its escrow — or none of them
 * happen.
 *
 * ONE ACCEPTANCE WINS. The batch is fenced: the request's move is conditional
 * on it still taking offers at this revision, the offer's freeze on it still
 * being the exact pending version confirmed (a concurrent withdraw or edit
 * matches nothing — §10 O), and a fence after each aborts the whole batch if
 * its guard matched nothing. A refused batch gives the reservation back and
 * says why; a crash before the batch leaves only a reservation, which the
 * reconciliation sweep releases (worker/lib/communityRequests.ts).
 */
marketplaceRoutes.post('/offers/:id/accept', requireAuth, async (c) => {
  await rateLimit(c, 'offer-accept', 20, 3600);
  const user = c.get('user')!;
  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const expected = {
    price: Number.isSafeInteger(Number(body.expected_price_iqd)) ? Number(body.expected_price_iqd) : NaN,
    revision: Number.isSafeInteger(Number(body.offer_revision)) ? Number(body.offer_revision) : NaN,
  };

  const offer = await offerForAcceptance(c.env.DB, offerId);
  if (!offer) throw notFound('Offer not found');
  if (offer.customer_id !== user.id) throw forbidden('This request is not yours');
  const refusal = acceptanceRefusal(offer, expected, nowIso(), await offerMerchantTakesWork(c.env.DB, offer));
  if (refusal) throw refusal;

  const requestId = String(offer.req_id);
  const merchantUserId = String(offer.m_user_id);
  const price = Number(offer.price_iqd);
  const split = await feeFor(c.env.DB, 'request', price);
  const autoDays = await autoCompleteDays(c.env.DB);
  const orderId = newId('cord');
  const escrowInput: HoldEscrowInput = {
    communityOrderId: orderId,
    customerId: user.id,
    merchantId: String(offer.merchant_id),
    grossIqd: price,
    platformFeeIqd: split.platform_fee_iqd,
    merchantReceivableIqd: split.merchant_receivable_iqd,
    idempotencyKey: `accept:${orderId}`,
  };

  // 1. The money, before anything else. A refusal here has nothing to undo.
  const reserved = await reserveEscrowFunds(c.env.DB, escrowInput);
  if (!reserved.ok) {
    if (reserved.reason === 'INSUFFICIENT_FUNDS') {
      throw badRequest(
        'Your wallet balance does not cover this offer. Top up and try again.',
        'INSUFFICIENT_FUNDS',
        { required_iqd: price }
      );
    }
    throw badRequest('Could not reserve the funds for this offer', 'ESCROW_FAILED', { reason: reserved.reason });
  }
  const holdId = reserved.reservation.holdId;

  // 2. Everything else, together.
  const ts = nowIso();
  const escrowId = newId('esc');
  const db = c.env.DB;
  try {
    await db.batch([
      // The reservation is still ours and still active.
      assertHoldStateStatement(db, holdId, 'active'),
      // THE RACE GUARD. Only one acceptance can move the request off the
      // board, and only at the revision the offer priced.
      db.prepare(
        `UPDATE community_requests
            SET state = 'in_progress', status = 'closed', accepted_offer_id = ?1, community_order_id = ?2,
                updated_at = ?3
          WHERE id = ?4 AND customer_id = ?5 AND state IN ('open','receiving_offers') AND revision = ?6
            AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?3)`
      ).bind(offerId, orderId, ts, requestId, user.id, Number(offer.r_revision ?? 1)),
      db.prepare(
        `UPDATE community_requests
            SET updated_at = CASE WHEN community_order_id = ?2 THEN updated_at ELSE NULL END
          WHERE id = ?1`
      ).bind(requestId, orderId),
      // The offer is frozen — the exact version the customer confirmed.
      db.prepare(
        `UPDATE community_offers SET state = 'accepted', updated_at = ?1
          WHERE id = ?2 AND request_id = ?3 AND state = 'pending'
            AND revision = ?4 AND price_iqd = ?5 AND request_revision = ?6
            AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?1)`
      ).bind(ts, offerId, requestId, expected.revision, expected.price, Number(offer.r_revision ?? 1)),
      db.prepare(
        `UPDATE community_offers
            SET updated_at = CASE WHEN state = 'accepted' AND updated_at = ?2 THEN updated_at ELSE NULL END
          WHERE id = ?1`
      ).bind(offerId, ts),
      // Every rival is closed in the same breath.
      db.prepare(
        `UPDATE community_offers SET state = 'rejected', updated_at = ?
          WHERE request_id = ? AND id != ? AND state = 'pending'`
      ).bind(ts, requestId, offerId),
      // The order is born FUNDED: its escrow commits in this same batch.
      db.prepare(
        `INSERT INTO community_orders
           (id, request_id, offer_id, customer_id, merchant_id, store_id, state,
            price_iqd, commission_percent_x100, platform_fee_iqd, merchant_receivable_iqd,
            completion_days, delivery_method, offer_snapshot, created_at, updated_at)
         VALUES (?,?,?,?,?,?, 'funded', ?,?,?,?,?,?,?,?,?)`
      ).bind(
        orderId, requestId, offerId, user.id, offer.merchant_id, offer.store_id,
        price, split.commission_percent_x100, split.platform_fee_iqd, split.merchant_receivable_iqd,
        offer.completion_days, offer.delivery_method,
        // The snapshot. Everything the merchant promised, frozen at this
        // instant, so editing the offer later cannot change the deal.
        JSON.stringify({
          price_iqd: price,
          completion_days: offer.completion_days,
          delivery_method: offer.delivery_method,
          message: offer.message,
          materials: offer.materials,
          included: offer.included,
          warranty_terms: offer.warranty_terms,
          offer_revision: Number(offer.revision ?? 1),
          request_revision: Number(offer.r_revision ?? 1),
          accepted_at: ts,
        }),
        ts, ts
      ),
      ...escrowRecordStatements(db, escrowInput, reserved.reservation, escrowId, ts),
      offerCountStatement(db, requestId),
      // A merchant who lost the job loses its preview links with it.
      revokeViewerTokensStatement(db, requestId, ts, [user.id, merchantUserId]),
      // «قبل العميل عرضك» — in the same commit as the acceptance it announces
      // (audit 03 §10 N). INSERT OR IGNORE on a per-offer key: it cannot fail
      // the batch and cannot be sent twice.
      offerAcceptedNotification(db, { merchantUserId, requestId, offerId, orderId, priceIqd: price }),
    ]);
  } catch (e) {
    /**
     * DID IT LAND? (review F8) An error here is what the Worker was told, not
     * what the database did: a batch can commit and its response be lost. An
     * escrow on this reservation means the acceptance happened — it is
     * answered as the success it was, and the hold under it is left alone.
     * The release below re-asks the same question inside its own UPDATE, so
     * even a commit that becomes visible between the two cannot be undone.
     */
    const landed = await db
      .prepare('SELECT id FROM community_escrows WHERE hold_id = ? AND community_order_id = ?')
      .bind(holdId, orderId)
      .first<{ id: string }>()
      .catch(() => null);
    if (!landed) {
      // Nothing of the batch landed. Give the reservation back; if even that
      // fails, the reconciliation sweep finds the orphaned hold and releases it.
      await releaseEscrowReservation(db, holdId, 'Offer acceptance did not complete').catch((err) =>
        console.error('accept: reservation not released', holdId, err instanceof Error ? err.message : String(err))
      );
      if (!isConstraintAbort(e)) throw e;
      const fresh = await offerForAcceptance(db, offerId);
      const why = fresh
        ? acceptanceRefusal(fresh, expected, nowIso(), await offerMerchantTakesWork(db, fresh))
        : notFound('Offer not found');
      throw why ?? conflict('This request changed while you were accepting — reload it and try again', 'ACCEPT_CONFLICT');
    }
    console.error('accept: the batch committed but reported an error', orderId, e instanceof Error ? e.message : String(e));
  }

  await audit(db, user.id, 'community.offer_accepted', offerId, {
    order: orderId,
    price,
    offer_revision: expected.revision,
    fee: split.platform_fee_iqd,
    auto_complete_days: autoDays,
  });

  const order = await db.prepare('SELECT * FROM community_orders WHERE id = ?').bind(orderId).first();
  return c.json({ success: true, order, escrow_id: escrowId }, 201);
});

// -------------------------------------------------------- order lifecycle

/** Both sides of a community order see the same row, from their own angle. */
async function loadOrderForParty(c: Context<AppContext>, orderId: string) {
  const user = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT o.*, m.user_id AS merchant_user_id, m.name AS merchant_name,
            s.slug AS store_slug, r.title AS request_title,
            u.name AS customer_name
       FROM community_orders o
       JOIN community_merchants m ON m.id = o.merchant_id
       LEFT JOIN merchant_stores s ON s.id = o.store_id
       JOIN community_requests r ON r.id = o.request_id
       JOIN users u ON u.id = o.customer_id
      WHERE o.id = ?`
  ).bind(orderId).first<Record<string, unknown>>();
  if (!row) throw notFound('Order not found');

  const isCustomer = row.customer_id === user.id;
  const isMerchant = row.merchant_user_id === user.id;
  // Neither party, no order. An id from another transaction reveals nothing.
  if (!isCustomer && !isMerchant) throw notFound('Order not found');
  return { row, isCustomer, isMerchant };
}

marketplaceRoutes.get('/orders/:id', requireAuth, async (c) => {
  const orderId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const { row, isCustomer, isMerchant } = await loadOrderForParty(c, orderId);
  const escrow = await escrowForOrder(c.env.DB, orderId);
  return c.json({
    success: true,
    order: {
      ...row,
      merchant_user_id: undefined,
      offer_snapshot: safeParse(row.offer_snapshot, {}),
    },
    role: isCustomer ? 'customer' : 'merchant',
    // Both parties may see the state of the money. Neither may move it here.
    escrow: escrow
      ? {
          state: escrow.state,
          gross_iqd: escrow.gross_iqd,
          // The merchant sees what they will receive; the customer sees what
          // they paid. The commission is shown to both — it is part of the
          // deal, not a platform secret.
          platform_fee_iqd: escrow.platform_fee_iqd,
          merchant_receivable_iqd: escrow.merchant_receivable_iqd,
          released_at: escrow.released_at,
          refunded_at: escrow.refunded_at,
        }
      : null,
    can: {
      mark_delivered: isMerchant && row.state === 'in_progress',
      start_work: isMerchant && row.state === 'funded',
      confirm: isCustomer && row.state === 'merchant_marked_delivered',
      dispute: orderIsActive(String(row.state) as CommunityOrderState),
      cancel: cancellationPolicy(String(row.state) as CommunityOrderState).by.includes(
        isCustomer ? 'customer' : 'merchant'
      ),
    },
  });
});

/** The merchant starts work. */
marketplaceRoutes.post('/orders/:id/start', requireAuth, async (c) => {
  const orderId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const { row, isMerchant } = await loadOrderForParty(c, orderId);
  if (!isMerchant) throw forbidden('Only the merchant can start this work');
  if (!canMoveCommunityOrder(String(row.state) as CommunityOrderState, 'in_progress')) {
    throw conflict(`An order that is ${row.state} cannot be started`);
  }
  /**
   * WORK STARTS ONLY ON MONEY THAT IS STILL HELD (review F2). The flip used to
   * ask the order alone, and a customer's cancel racing this tap refunded the
   * escrow while the order went `in_progress` — a live job over money that
   * was already back in the customer's wallet, which nothing could ever pay
   * the merchant for. The escrow's state is now part of the same UPDATE (the
   * cancel moves the escrow and the order in ONE batch), and a flip that
   * matched nothing is reported, never answered with a success.
   */
  const res = await c.env.DB.prepare(
    `UPDATE community_orders SET state = 'in_progress', updated_at = ?
      WHERE id = ? AND state = 'funded'
        AND EXISTS (SELECT 1 FROM community_escrows e
                     WHERE e.community_order_id = community_orders.id AND e.state = 'held')`
  ).bind(nowIso(), orderId).run();
  if (!res.meta.changes) {
    const now = await c.env.DB.prepare(
      `SELECT o.state, (SELECT e.state FROM community_escrows e WHERE e.community_order_id = o.id) AS escrow_state
         FROM community_orders o WHERE o.id = ?`
    ).bind(orderId).first<{ state: string; escrow_state: string | null }>();
    // A second tap that lost to the first: the work IS started.
    if (now?.state === 'in_progress') return c.json({ success: true, replayed: true });
    if (now?.state === 'funded') {
      throw conflict('The money for this order is not held, so work cannot start — contact support', 'ESCROW_NOT_HELD');
    }
    throw conflict('This order changed — reload it', 'ORDER_CHANGED');
  }
  await audit(c.env.DB, c.get('user')!.id, 'community.order_started', orderId, {});
  return c.json({ success: true });
});

/**
 * The merchant says the work is done.
 *
 * THIS DOES NOT RELEASE MONEY (§33). It asks the customer to confirm, and
 * starts the auto-completion clock if the owner has enabled one. A merchant
 * marking their own work delivered and being paid for it would make escrow
 * decorative.
 */
marketplaceRoutes.post('/orders/:id/delivered', requireAuth, async (c) => {
  const orderId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const { row, isMerchant } = await loadOrderForParty(c, orderId);
  if (!isMerchant) throw forbidden('Only the merchant can mark this delivered');
  if (!canMoveCommunityOrder(String(row.state) as CommunityOrderState, 'merchant_marked_delivered')) {
    throw conflict(`An order that is ${row.state} cannot be marked delivered`);
  }

  const days = await autoCompleteDays(c.env.DB);
  const ts = nowIso();
  // 0 disables auto-release entirely: the money then waits for a human, which
  // is the safe default for a platform that has not decided its policy yet.
  const autoAt = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;

  await c.env.DB.prepare(
    `UPDATE community_orders
        SET state = 'merchant_marked_delivered', delivered_at = ?, auto_complete_at = ?, updated_at = ?
      WHERE id = ? AND state = 'in_progress'`
  ).bind(ts, autoAt, ts, orderId).run();

  await audit(c.env.DB, c.get('user')!.id, 'community.order_delivered', orderId, { auto_complete_at: autoAt });
  return c.json({ success: true, auto_complete_at: autoAt });
});

/**
 * The customer confirms. THIS is what releases the money.
 */
marketplaceRoutes.post('/orders/:id/confirm', requireAuth, async (c) => {
  await rateLimit(c, 'order-confirm', 30, 3600);
  const user = c.get('user')!;
  const orderId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const { row, isCustomer } = await loadOrderForParty(c, orderId);
  if (!isCustomer) throw forbidden('Only the customer can confirm this order');
  if (!canMoveCommunityOrder(String(row.state) as CommunityOrderState, 'customer_confirmed')) {
    throw conflict(`An order that is ${row.state} cannot be confirmed`);
  }

  const escrow = await escrowForOrder(c.env.DB, orderId);
  if (!escrow) throw conflict('This order has no escrow to release');

  const released = await releaseEscrow(c.env.DB, {
    escrowId: escrow.id,
    actorId: user.id,
    actorRole: 'customer',
    reason: 'customer confirmed delivery',
    // Keyed on the ORDER, not the request: a retry releases once whatever the
    // client does — and the auto-confirm sweep uses the same key, so the two
    // can never release twice between them.
    idempotencyKey: `confirm:${orderId}`,
    // Still delivered-and-waiting WHEN the money moves, not only when this
    // route read it (review F1): a dispute that landed in between wins.
    orderStates: ['merchant_marked_delivered'],
  });
  if (!released.ok) {
    const reason = (released as { reason: string }).reason;
    if (reason === 'ORDER_CHANGED') throw conflict('This order changed — reload it', 'ORDER_CHANGED');
    throw new HttpError(409, `The funds could not be released (${reason})`, 'ESCROW_RELEASE_FAILED', { reason });
  }

  // THE COMPLETION COUNTS ONCE (audit 04 B9). Two taps racing each other both
  // got `ok` above — the second as a replay — and both used to add one to
  // `completed_orders` and +10 to the merchant's reputation. The statements
  // are gated on this batch being the one that completed the order and on no
  // completion event existing yet (worker/lib/communityRequests.ts).
  await c.env.DB.batch(
    completionStatements(
      c.env.DB,
      { id: orderId, request_id: String(row.request_id), merchant_id: String(row.merchant_id) },
      nowIso(),
      { confirmedByCustomer: true }
    )
  );

  await audit(c.env.DB, user.id, 'community.order_completed', orderId, { escrow: escrow.id });
  return c.json({ success: true, review_available: true });
});

/**
 * Either party raises a problem. Settlement freezes until an admin decides
 * (§45) — which is the entire reason the money was held rather than paid.
 */
marketplaceRoutes.post('/orders/:id/dispute', requireAuth, async (c) => {
  await rateLimit(c, 'order-dispute', 10, 3600);
  const user = c.get('user')!;
  const orderId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const { row, isCustomer } = await loadOrderForParty(c, orderId);
  const body = await c.req.json().catch(() => ({}));
  const description = str(body.description, 'description', { min: 10, max: 4000 });

  if (!orderIsActive(String(row.state) as CommunityOrderState)) {
    throw conflict('This order is already settled', 'ORDER_SETTLED');
  }

  const escrow = await escrowForOrder(c.env.DB, orderId);
  const complaintId = newId('cmp');

  // THE MONEY FREEZES FIRST, AND ONLY IF IT IS STILL THERE TO FREEZE (audit 03
  // §10 R). This route used to flip the order and the request to `disputed`
  // unconditionally and then ignore what `disputeEscrow` said — so a dispute
  // racing a confirmation (or the auto-confirm clock) could leave a `disputed`
  // order sitting on a `released` escrow. Now an escrow that has already been
  // settled refuses the dispute, and nothing else is written.
  if (escrow) {
    const frozen = await disputeEscrow(c.env.DB, {
      escrowId: escrow.id,
      actorId: user.id,
      actorRole: isCustomer ? 'customer' : 'merchant',
      reason: description.slice(0, 200),
      idempotencyKey: `dispute:${orderId}`,
    });
    if (!frozen.ok) throw conflict('This order is already settled', 'ORDER_SETTLED');
  }

  const ts = nowIso();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE community_orders SET state = 'disputed', updated_at = ?
          WHERE id = ? AND state IN ('funded','in_progress','merchant_marked_delivered','disputed')`
      ).bind(ts, orderId),
      // The complaint is only filed against an order this batch really holds
      // in `disputed`.
      c.env.DB.prepare(
        `UPDATE community_orders
            SET updated_at = CASE WHEN state = 'disputed' AND updated_at = ?2 THEN updated_at ELSE NULL END
          WHERE id = ?1`
      ).bind(orderId, ts),
      c.env.DB.prepare(
        `UPDATE community_requests SET state = 'disputed', status = 'closed', updated_at = ?
          WHERE id = ? AND state IN ('offer_selected','in_progress','delivered','disputed')`
      ).bind(ts, row.request_id),
      c.env.DB.prepare(
        `INSERT INTO community_complaints
           (id, reporter_id, reported_user_id, merchant_id, store_id, community_order_id,
            category, description, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?, 'order', ?, 'submitted', ?, ?)`
      ).bind(
        complaintId, user.id,
        isCustomer ? row.merchant_user_id : row.customer_id,
        row.merchant_id, row.store_id, orderId, description, ts, ts
      ),
    ]);
  } catch (e) {
    if (!isConstraintAbort(e)) throw e;
    throw conflict('This order is already settled', 'ORDER_SETTLED');
  }

  await audit(c.env.DB, user.id, 'community.order_disputed', orderId, { complaint: complaintId });
  /**
   * MONEY IS NOW FROZEN AND A HUMAN HAS TO DECIDE — SO A HUMAN IS TOLD.
   *
   * This is the strongest case in the whole platform for «❗ Report», the
   * owner's «الإبلاغات أو الشكاوي» topic: the route above flips the order
   * and the request to 'disputed' and calls `disputeEscrow`, and §45 is
   * explicit that settlement then stops until an admin decides. Until this
   * line nothing told that admin. Two people's money sat frozen for as long as
   * it took somebody to open the complaints queue on their own initiative —
   * and neither party can do anything but wait.
   *
   * THE DESCRIPTION IS NOT IN THE MESSAGE. It is up to 4000 characters of one
   * party accusing the other, often by name; a group chat is not where that
   * gets read, and the complaint id opens it in the admin panel. Who raised it
   * IS here, as a role and not as an identity, because "the merchant is
   * disputing" and "the customer is disputing" are two different afternoons.
   */
  announceAfterResponse(
    c,
    'report',
    `❗ Dispute on community order ${orderId}` +
      `\nComplaint: ${complaintId}` +
      `\nRaised by: ${isCustomer ? 'customer' : 'merchant'}` +
      (escrow ? `\nEscrow frozen: ${escrow.id}` : '\nNo escrow on this order')
  );
  return c.json({ success: true, complaint_id: complaintId }, 201);
});

/**
 * Cancel — but only when the stage allows it (§35).
 * Before work starts this refunds cleanly. Once work is under way it is an
 * admin decision, not a button either party can press, because walking away
 * then imposes a real loss on the other side.
 */
marketplaceRoutes.post('/orders/:id/cancel', requireAuth, async (c) => {
  const user = c.get('user')!;
  const orderId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const { row, isCustomer } = await loadOrderForParty(c, orderId);
  const state = String(row.state) as CommunityOrderState;
  const policy = cancellationPolicy(state);
  const role = isCustomer ? 'customer' : 'merchant';

  if (!policy.allowed || !policy.by.includes(role)) {
    throw conflict(
      policy.by.includes('admin')
        ? 'Work has already started — open a dispute and Levonis will decide'
        : `An order that is ${state} cannot be cancelled`
    );
  }

  /**
   * THE REFUND AND THE CANCELLATION ARE ONE BATCH (review F2).
   *
   * They were two: the escrow was refunded first, and the order's flip —
   * conditional on `accepted`/`funded` — ran afterwards and quietly matched
   * nothing when the merchant's «ابدأ العمل» had landed in between, while the
   * request was still marked cancelled. The customer had their money back and
   * the merchant a live job nobody could ever pay for. Now the escrow's own
   * UPDATE requires the order to still be `accepted`/`funded`, and the
   * order's and the request's moves ride in the SAME batch
   * (`refundEscrow` … `alsoWrite`): either the work had not started and all
   * of it happens, or it had and none of it does (409 ORDER_CHANGED). The
   * merchant's start, for its part, requires a `held` escrow.
   */
  const escrow = await escrowForOrder(c.env.DB, orderId);
  const ts = nowIso();
  const cancelStatements = [
    c.env.DB.prepare(
      `UPDATE community_orders SET state = 'cancelled', cancelled_at = ?1, updated_at = ?1
        WHERE id = ?2 AND state IN ('accepted','funded')`
    ).bind(ts, orderId),
    // A fence: this batch's flip landed, or nothing in it stands.
    c.env.DB.prepare(
      `UPDATE community_orders
          SET updated_at = CASE WHEN state = 'cancelled' AND cancelled_at = ?2 THEN updated_at ELSE NULL END
        WHERE id = ?1`
    ).bind(orderId, ts),
    c.env.DB.prepare(
      `UPDATE community_requests SET state = 'cancelled', status = 'closed', updated_at = ?
        WHERE id = ? AND state IN ('offer_selected','in_progress')`
    ).bind(ts, row.request_id),
    revokeViewerTokensStatement(c.env.DB, String(row.request_id), ts),
  ];
  const workStarted = () => conflict('This order changed — the work may already have started. Reload it.', 'ORDER_CHANGED');

  if (escrow) {
    const refund = await refundEscrow(c.env.DB, {
      escrowId: escrow.id,
      actorId: user.id,
      actorRole: role,
      reason: 'cancelled before work started',
      idempotencyKey: `cancel:${orderId}`,
      orderStates: ['accepted', 'funded'],
      alsoWrite: cancelStatements,
    });
    if (!refund.ok) {
      const reason = (refund as { reason: string }).reason;
      if (reason === 'ORDER_CHANGED') throw workStarted();
      throw new HttpError(409, `Could not refund (${reason})`, 'ESCROW_REFUND_FAILED', { reason });
    }
    if (refund.replayed) {
      // The escrow was ALREADY refunded. This cancel's own batch, retried, is
      // done. An order still waiting for its work over refunded money is the
      // other half of a cancel that stopped between its two steps before they
      // were one batch: it is finished here, and no money moves (the refund is
      // behind it, and the merchant's start refuses an escrow that is not
      // held). Anything else was decided elsewhere — say so.
      const again = await c.env.DB.prepare('SELECT state FROM community_orders WHERE id = ?')
        .bind(orderId)
        .first<{ state: string }>();
      if (again?.state === 'cancelled') return c.json({ success: true, refunded: true, replayed: true });
      if (again?.state !== 'accepted' && again?.state !== 'funded') throw workStarted();
      try {
        await c.env.DB.batch(cancelStatements);
      } catch (e) {
        if (!isConstraintAbort(e)) throw e;
        throw workStarted();
      }
    }
  } else {
    try {
      await c.env.DB.batch(cancelStatements);
    } catch (e) {
      if (!isConstraintAbort(e)) throw e;
      throw workStarted();
    }
  }

  await audit(c.env.DB, user.id, 'community.order_cancelled', orderId, { by: role, state });
  return c.json({ success: true, refunded: !!escrow });
});

/** Every community order this user is a party to, either side. */
marketplaceRoutes.get('/orders', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.state, o.price_iqd, o.merchant_receivable_iqd, o.created_at,
            o.delivered_at, o.completed_at, o.auto_complete_at,
            r.title AS request_title, m.name AS merchant_name, s.slug AS store_slug,
            CASE WHEN o.customer_id = ? THEN 'customer' ELSE 'merchant' END AS role
       FROM community_orders o
       JOIN community_merchants m ON m.id = o.merchant_id
       LEFT JOIN merchant_stores s ON s.id = o.store_id
       JOIN community_requests r ON r.id = o.request_id
      WHERE o.customer_id = ? OR m.user_id = ?
      ORDER BY o.created_at DESC LIMIT 50`
  ).bind(user.id, user.id, user.id).all();
  return c.json({ success: true, orders: results });
});

// ------------------------------------------------------ complaints (reporter)

/**
 * «الشكاوى» FROM THE OTHER SIDE OF THE DESK — the reporter's own thread.
 *
 * WHAT WAS MISSING. A complaint could be FILED (the dispute route above) and
 * ANSWERED (POST /api/admin/community/complaints/:id/messages), and nothing
 * between the two let the person who filed it read the answer or say anything
 * back. The admin's reply reached them as one row in the bell, clamped to two
 * lines, with no link — a paragraph about their frozen money that could not be
 * read in full anywhere on the site, and a conversation that could only go one
 * way.
 *
 * WHO MAY READ IT: THE REPORTER. The complaint is their account of a dispute,
 * and the admin console labels a public reply «رد يراه صاحب الشكوى» — the
 * reporter, not the party complained about. Widening that to the other party
 * would change what every past reply meant after it was written, so it is not
 * done here; it is an owner decision (docs/DECISIONS.md).
 *
 * WHAT IT SHOWS: every message except the INTERNAL notes (migration 0031,
 * "admin-only note, never shown to parties"), filtered in the SQL rather than
 * in a map, so a note cannot reach this response by a forgotten field. Staff
 * identity stays internal; a row says only whether it came from the shop.
 * The key never ships — the URL does, and /files/ decides who may read it.
 */
interface ComplaintMsgRow extends Record<string, unknown> {
  id: string;
  sender_id: string;
  sender_role: string;
  body: string;
  file_key: string | null;
  created_at: string;
}

function complaintFileKind(key: string | null): 'text' | 'image' | 'video' {
  if (!key) return 'text';
  return key.split('/')[2] === 'video' ? 'video' : 'image';
}

export function complaintMessagePublic(m: ComplaintMsgRow, viewerId: string) {
  const fileKey = typeof m.file_key === 'string' && m.file_key ? m.file_key : null;
  return {
    id: m.id,
    body: m.body ?? '',
    is_staff: m.sender_role === 'admin',
    mine: m.sender_id === viewerId,
    created_at: m.created_at,
    kind: complaintFileKind(fileKey),
    file_url: fileKey ? `/files/${fileKey}` : null,
  };
}

async function ownComplaint(c: Context<AppContext>, id: string) {
  const user = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT ct.id, ct.category, ct.description, ct.status, ct.resolution, ct.created_at, ct.updated_at,
            ct.community_order_id, ct.merchant_id, m.name AS merchant_name, m.user_id AS merchant_user_id
       FROM community_complaints ct
       LEFT JOIN community_merchants m ON m.id = ct.merchant_id
      WHERE ct.id = ? AND ct.reporter_id = ?`
  )
    .bind(id, user.id)
    .first<Record<string, unknown>>();
  // Not theirs and not there are the same answer: an id reveals nothing.
  if (!row) throw notFound('Complaint not found');
  return row;
}

function complaintPublic(r: Record<string, unknown>) {
  return {
    id: r.id,
    category: r.category,
    description: r.description,
    status: r.status,
    resolution: r.resolution ?? '',
    created_at: r.created_at,
    updated_at: r.updated_at,
    community_order_id: r.community_order_id ?? null,
    merchant_name: r.merchant_name ?? null,
    message_count: typeof r.message_count === 'number' ? r.message_count : undefined,
  };
}

marketplaceRoutes.get('/complaints', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT ct.id, ct.category, ct.description, ct.status, ct.resolution, ct.created_at, ct.updated_at,
            ct.community_order_id, m.name AS merchant_name,
            (SELECT COUNT(*) FROM community_complaint_messages cm
              WHERE cm.complaint_id = ct.id AND cm.internal = 0) AS message_count
       FROM community_complaints ct
       LEFT JOIN community_merchants m ON m.id = ct.merchant_id
      WHERE ct.reporter_id = ?
      ORDER BY ct.updated_at DESC
      LIMIT 50`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  return c.json({ success: true, complaints: results.map(complaintPublic) });
});

marketplaceRoutes.get('/complaints/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const complaint = await ownComplaint(c, id);
  const { results } = await c.env.DB.prepare(
    `SELECT id, sender_id, sender_role, body, file_key, created_at
       FROM community_complaint_messages
      WHERE complaint_id = ? AND internal = 0
      ORDER BY created_at, rowid
      LIMIT 500`
  )
    .bind(id)
    .all<ComplaintMsgRow>();
  return c.json({
    success: true,
    complaint: complaintPublic(complaint),
    messages: results.map((m) => complaintMessagePublic(m, user.id)),
  });
});

/**
 * THE REPORTER ANSWERS BACK — text, a photograph, or a clip.
 *
 * The same contract as a ticket reply (worker/routes/support.ts): text or a
 * file, never neither; the key must be THIS complaint's, in a folder the
 * upload route writes to, and actually stored; and the response is the row
 * that was written, so the thread appends one bubble instead of reloading.
 *
 * THE BALL COMES BACK TO STAFF. A complaint parked «بانتظار العميل» /
 * «بانتظار التاجر» moves to «قيد المراجعة» when the party answers — the
 * admin's filter chips are how the desk finds work, and a reply that left the
 * complaint marked as waiting on the customer would be invisible there. A
 * decided complaint keeps its status: re-opening a settled escrow dispute is
 * a decision, not a side effect of a message.
 *
 * THE DESK IS TOLD IN «❗ Report», the topic the dispute itself was announced
 * to — but only when this message is news: a second line typed right after
 * the first says nothing the first did not. The text is never in it.
 */
marketplaceRoutes.post('/complaints/:id/messages', requireAuth, async (c) => {
  await rateLimit(c, 'complaint-msg', 30, 3600);
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const complaint = await ownComplaint(c, id);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = str(body.body, 'body', { min: 0, max: 4000, required: false });
  let fileKey: string | null = null;
  const rawKey = body.fileKey;
  if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
    if (!isSafeMediaKey(rawKey) || !rawKey.startsWith(`complaints/${id}/`)) {
      throw badRequest('That file does not belong to this complaint');
    }
    const folder = rawKey.split('/')[2] ?? '';
    if (folder !== 'attachments' && folder !== 'video') throw badRequest('Invalid file reference');
    if (!(await headMediaObject(c.env, 'private', rawKey))) {
      throw badRequest('That attachment was not uploaded — attach it again', 'ATTACHMENT_NOT_FOUND');
    }
    fileKey = rawKey;
  } else if (text.trim().length === 0) {
    throw badRequest('Message is empty');
  }

  const previous = await c.env.DB.prepare(
    `SELECT sender_id FROM community_complaint_messages
      WHERE complaint_id = ? AND internal = 0
      ORDER BY created_at DESC, rowid DESC LIMIT 1`
  )
    .bind(id)
    .first<{ sender_id: string }>();

  const role = complaint.merchant_user_id && complaint.merchant_user_id === user.id ? 'merchant' : 'user';
  const status = String(complaint.status);
  const nextStatus = status === 'waiting_customer' || status === 'waiting_merchant' ? 'under_review' : status;
  const messageId = newId('cmsg');
  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO community_complaint_messages (id, complaint_id, sender_id, sender_role, body, file_key, internal, created_at)
       VALUES (?,?,?,?,?,?,0,?)`
    ).bind(messageId, id, user.id, role, text, fileKey, ts),
    c.env.DB.prepare('UPDATE community_complaints SET status = ?, updated_at = ? WHERE id = ?').bind(nextStatus, ts, id),
  ]);
  await audit(c.env.DB, user.id, 'community.complaint_message', id, { kind: complaintFileKind(fileKey), length: text.length });

  const closed = status === 'resolved' || status === 'rejected' || status === 'closed';
  if (!previous || previous.sender_id !== user.id || nextStatus !== status) {
    announceAfterResponse(
      c,
      'report',
      `❗ Reply on complaint ${id}` +
        `\nFrom: ${role === 'merchant' ? 'merchant' : 'customer'}` +
        (fileKey ? '\nWith an attachment' : '') +
        (closed ? `\nThe complaint is already ${status}` : '')
    );
  }

  return c.json({
    success: true,
    message: complaintMessagePublic(
      { id: messageId, sender_id: user.id, sender_role: role, body: text, file_key: fileKey, created_at: ts },
      user.id
    ),
    status: nextStatus,
    updated_at: ts,
  });
});
