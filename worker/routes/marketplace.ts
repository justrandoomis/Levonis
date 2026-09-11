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
import { requireAuth, badRequest, forbidden, notFound, conflict, str, int } from '../lib/http';
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
import { requireSellingPrivileges, storeForUser } from '../lib/merchantAuth';
import { feeFor, autoCompleteDays } from '../lib/merchantOps';
import { holdEscrow, escrowForOrder, releaseEscrow, refundEscrow, disputeEscrow } from '../lib/escrowOps';
import {
  REQUEST_OPEN_STATES,
  canMoveRequest,
  canMoveCommunityOrder,
  cancellationPolicy,
  orderIsActive,
  type RequestState,
  type CommunityOrderState,
} from '../lib/communityStates';

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
marketplaceRoutes.get('/requests', async (c) => {
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

marketplaceRoutes.get('/requests/:id', async (c) => {
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
  if (!isOwner && (r.visibility !== 'public' || !REQUEST_OPEN_STATES.includes(r.state as RequestState))) {
    // A closed or private request is only visible to the customer who made
    // it and, below, to the merchant actually engaged on it.
    const engaged = user
      ? await c.env.DB.prepare(
          `SELECT 1 FROM community_offers o
             JOIN community_merchants m ON m.id = o.merchant_id
            WHERE o.request_id = ? AND m.user_id = ? AND o.state = 'accepted'`
        ).bind(id, user.id).first()
      : null;
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

marketplaceRoutes.post('/requests/:id/files', requireAuth, async (c) => {
  await rateLimit(c, 'request-file', 40, 3600);
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const r = await requestForFiles(c, id, user.id);

  // Attachments are part of what merchants priced against. Adding one after
  // an offer was accepted would change the job under a signed contract, so
  // the window closes when the request stops taking offers.
  if (!REQUEST_OPEN_STATES.includes(r.state as RequestState) && r.state !== 'draft') {
    throw conflict('This request is no longer open, so its attachments cannot change');
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
  await c.env.BUCKET.put(key, buf, {
    httpMetadata: { contentType: kind.mime, cacheControl: 'private, max-age=0' },
  });

  const fileId = newId('crf');
  const name = safeFileName(file.name, kind.ext);
  try {
    await c.env.DB.prepare(
      `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(fileId, id, key, name, kind.mime, buf.byteLength, kind.kind).run();
  } catch (e) {
    // The row is what makes the object reachable. If it cannot be written,
    // delete the object rather than leaving a file nothing points at.
    await c.env.BUCKET.delete(key).catch(() => {});
    throw e;
  }

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
            r.customer_id, r.state, r.visibility
       FROM community_request_files f
       JOIN community_requests r ON r.id = f.request_id
      WHERE f.id = ? AND f.request_id = ?`
  ).bind(fileId, id).first<{
    file_key: string; file_name: string; content_type: string; kind: string;
    customer_id: string; state: string; visibility: string;
  }>();
  if (!row) throw notFound('File not found');

  const isOwner = row.customer_id === user.id;
  const openToOffers =
    row.visibility === 'public' && REQUEST_OPEN_STATES.includes(row.state as RequestState);

  if (!isOwner && !openToOffers && user.role !== 'admin') {
    const engaged = await c.env.DB.prepare(
      `SELECT 1 FROM community_offers o
         JOIN community_merchants m ON m.id = o.merchant_id
        WHERE o.request_id = ? AND m.user_id = ? AND o.state = 'accepted'`
    ).bind(id, user.id).first();
    if (!engaged) throw notFound('File not found');
  }

  const obj = await c.env.BUCKET.get(row.file_key);
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
  // after they quoted, would leave the price attached to a job nobody can see.
  if (!REQUEST_OPEN_STATES.includes(r.state as RequestState) && r.state !== 'draft') {
    throw conflict('This request is no longer open, so its attachments cannot change');
  }

  const row = await c.env.DB.prepare(
    'SELECT file_key FROM community_request_files WHERE id = ? AND request_id = ?'
  ).bind(fileId, id).first<{ file_key: string }>();
  if (!row) throw notFound('File not found');

  // Row first: while it exists the object is reachable, so removing it last
  // can only leave an unreferenced object, never a broken reference.
  await c.env.DB.prepare('DELETE FROM community_request_files WHERE id = ? AND request_id = ?')
    .bind(fileId, id).run();
  await c.env.BUCKET.delete(row.file_key).catch(() => {});

  return c.json({ success: true });
});

marketplaceRoutes.post('/requests', requireAuth, async (c) => {
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
     VALUES (?,?,?,?,'open','open',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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

  await audit(c.env.DB, user.id, 'community.request_created', id, { title });
  const row = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ?').bind(id).first();
  return c.json({ success: true, request: publicRequest(row as Record<string, unknown>) }, 201);
});

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

/** Close a request. Only the customer, and only while nothing is committed. */
marketplaceRoutes.post('/requests/:id/cancel', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const r = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ? AND customer_id = ?')
    .bind(id, user.id)
    .first<Record<string, unknown>>();
  if (!r) throw notFound('Request not found');

  const from = String(r.state) as RequestState;
  if (!canMoveRequest(from, 'cancelled')) {
    throw conflict(`A request that is ${from} cannot be cancelled here`);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_requests SET state = 'cancelled', status = 'closed', updated_at = ?
        WHERE id = ? AND customer_id = ? AND state = ?`
    ).bind(nowIso(), id, user.id, from),
    // Pending offers are told why they will never be answered, rather than
    // being left hanging forever.
    c.env.DB.prepare(
      `UPDATE community_offers SET state = 'rejected', updated_at = ?
        WHERE request_id = ? AND state = 'pending'`
    ).bind(nowIso(), id),
  ]);

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
            s.slug AS s_slug
       FROM community_offers o
       JOIN community_merchants m ON m.id = o.merchant_id
       LEFT JOIN merchant_stores s ON s.id = o.store_id
      WHERE o.request_id = ?
        AND (? = 1 OR o.merchant_id = ?)
      ORDER BY o.created_at ASC`
  ).bind(requestId, isCustomer ? 1 : 0, mine?.merchant.id ?? '').all();

  const proBadges = await usersWithEntitlement(c.env.DB, results.map((row) => row.m_user_id), 'proMerchantBadge');
  return c.json({ success: true, offers: results.map((row) => offerShape(row, proBadges)), is_customer: isCustomer });
});

marketplaceRoutes.post('/requests/:id/offers', requireAuth, async (c) => {
  await rateLimit(c, 'offer-create', 30, 3600);
  const user = c.get('user')!;
  const ctx = await requireSellingPrivileges(c);
  const tier = await getTierStatus(c.env.DB, user.id);
  if (!benefits.communityOffers(tier)) throw forbidden('Your plan does not include community offers');

  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const req = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ?')
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (!req) throw notFound('Request not found');
  if (!REQUEST_OPEN_STATES.includes(String(req.state) as RequestState)) {
    throw conflict('This request is no longer accepting offers');
  }
  if (req.customer_id === user.id) throw badRequest('You cannot bid on your own request');

  const body = await c.req.json().catch(() => ({}));
  const price = int(body.price_iqd, 'price_iqd', { min: 1, max: 1_000_000_000 });

  const id = newId('off');
  const ts = nowIso();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO community_offers
           (id, request_id, merchant_id, store_id, price_iqd, completion_days, delivery_method,
            message, materials, included, warranty_terms, state, expires_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)`
      ).bind(
        id, requestId, ctx.merchant.id, ctx.store.id, price,
        int(body.completion_days, 'completion_days', { min: 0, max: 365, def: 0 }),
        str(body.delivery_method, 'delivery_method', { min: 0, max: 60, required: false }),
        str(body.message, 'message', { min: 0, max: 2000, required: false }),
        str(body.materials, 'materials', { min: 0, max: 500, required: false }),
        str(body.included, 'included', { min: 0, max: 500, required: false }),
        str(body.warranty_terms, 'warranty_terms', { min: 0, max: 500, required: false }),
        str(body.expires_at, 'expires_at', { min: 0, max: 40, required: false }) || null,
        ts, ts
      ),
      // The board should show a live count without a COUNT(*) per row.
      c.env.DB.prepare(
        `UPDATE community_requests
            SET offer_count = offer_count + 1,
                state = CASE WHEN state = 'open' THEN 'receiving_offers' ELSE state END,
                updated_at = ?
          WHERE id = ?`
      ).bind(ts, requestId),
    ]);
  } catch {
    // The partial unique index on (request_id, merchant_id) WHERE state is
    // live. A merchant already has an offer here; withdrawing frees the slot.
    throw conflict('You already have an active offer on this request');
  }

  await audit(c.env.DB, user.id, 'community.offer_created', id, { request: requestId, price });
  const row = await c.env.DB.prepare('SELECT * FROM community_offers WHERE id = ?').bind(id).first();
  return c.json({ success: true, offer: offerShape(row as Record<string, unknown>) }, 201);
});

/** Withdraw an offer. Only while it is still pending. */
marketplaceRoutes.post('/offers/:id/withdraw', requireAuth, async (c) => {
  const user = c.get('user')!;
  const ctx = await requireSellingPrivileges(c);
  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const res = await c.env.DB.prepare(
    `UPDATE community_offers SET state = 'withdrawn', updated_at = ?
      WHERE id = ? AND merchant_id = ? AND state = 'pending'`
  ).bind(nowIso(), offerId, ctx.merchant.id).run();
  if (!res.meta.changes) throw conflict('That offer can no longer be withdrawn');
  await audit(c.env.DB, user.id, 'community.offer_withdrawn', offerId, {});
  return c.json({ success: true });
});

/** Edit an offer — pending only. After acceptance it is the contract (§26). */
marketplaceRoutes.patch('/offers/:id', requireAuth, async (c) => {
  const ctx = await requireSellingPrivileges(c);
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };

  if (body.price_iqd !== undefined) put('price_iqd', int(body.price_iqd, 'price_iqd', { min: 1, max: 1_000_000_000 }));
  if (body.completion_days !== undefined)
    put('completion_days', int(body.completion_days, 'completion_days', { min: 0, max: 365 }));
  if (body.message !== undefined) put('message', str(body.message, 'message', { min: 0, max: 2000, required: false }));
  if (body.materials !== undefined) put('materials', str(body.materials, 'materials', { min: 0, max: 500, required: false }));
  if (body.included !== undefined) put('included', str(body.included, 'included', { min: 0, max: 500, required: false }));
  if (body.warranty_terms !== undefined)
    put('warranty_terms', str(body.warranty_terms, 'warranty_terms', { min: 0, max: 500, required: false }));
  if (!sets.length) throw badRequest('Nothing to update');

  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  put('updated_at', nowIso());
  vals.push(offerId, ctx.merchant.id);
  // `state = 'pending'` is in the WHERE clause, so an accepted offer cannot be
  // edited even by a request that tries.
  const res = await c.env.DB.prepare(
    `UPDATE community_offers SET ${sets.join(', ')} WHERE id = ? AND merchant_id = ? AND state = 'pending'`
  ).bind(...vals).run();
  if (!res.meta.changes) throw conflict('That offer can no longer be changed');

  const row = await c.env.DB.prepare('SELECT * FROM community_offers WHERE id = ?').bind(offerId).first();
  return c.json({ success: true, offer: offerShape(row as Record<string, unknown>) });
});

// ------------------------------------------------------------- acceptance

/**
 * Accept one offer. The single most important transaction in the marketplace.
 *
 * ATOMICITY. The request is moved to `offer_selected` by a CONDITIONAL update
 * that requires it to still be open. Whoever wins that update owns the
 * acceptance; a concurrent second attempt changes zero rows and is told the
 * request already has a winner. Everything after it — freezing the offer,
 * rejecting the others, creating the order — happens only for the winner.
 *
 * ORDER OF OPERATIONS. The order is created BEFORE the escrow, because the
 * escrow references it. If funding then fails, the order is cancelled and the
 * request is reopened, so a customer who cannot pay does not lose their
 * request and the merchants do not lose their offers.
 */
marketplaceRoutes.post('/offers/:id/accept', requireAuth, async (c) => {
  await rateLimit(c, 'offer-accept', 20, 3600);
  const user = c.get('user')!;
  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });

  const offer = await c.env.DB.prepare(
    `SELECT o.*, r.customer_id, r.state AS request_state, r.id AS req_id
       FROM community_offers o JOIN community_requests r ON r.id = o.request_id
      WHERE o.id = ?`
  ).bind(offerId).first<Record<string, unknown>>();
  if (!offer) throw notFound('Offer not found');
  if (offer.customer_id !== user.id) throw forbidden('This request is not yours');
  if (offer.state !== 'pending') throw conflict('That offer is no longer available');

  const ts = nowIso();
  // THE RACE GUARD. Only one request can move out of an open state.
  const won = await c.env.DB.prepare(
    `UPDATE community_requests
        SET state = 'offer_selected', status = 'closed', accepted_offer_id = ?, updated_at = ?
      WHERE id = ? AND customer_id = ? AND state IN ('open','receiving_offers')`
  ).bind(offerId, ts, offer.req_id, user.id).run();
  if (!won.meta.changes) throw conflict('This request already has an accepted offer');

  const price = Number(offer.price_iqd);
  const split = await feeFor(c.env.DB, 'request', price);
  const autoDays = await autoCompleteDays(c.env.DB);
  const orderId = newId('cord');

  await c.env.DB.batch([
    // The offer is frozen, and every rival is closed in the same breath.
    c.env.DB.prepare(`UPDATE community_offers SET state = 'accepted', updated_at = ? WHERE id = ?`)
      .bind(ts, offerId),
    c.env.DB.prepare(
      `UPDATE community_offers SET state = 'rejected', updated_at = ?
        WHERE request_id = ? AND id != ? AND state = 'pending'`
    ).bind(ts, offer.req_id, offerId),
    c.env.DB.prepare(
      `INSERT INTO community_orders
         (id, request_id, offer_id, customer_id, merchant_id, store_id, state,
          price_iqd, commission_percent_x100, platform_fee_iqd, merchant_receivable_iqd,
          completion_days, delivery_method, offer_snapshot, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'accepted', ?,?,?,?,?,?,?,?,?)`
    ).bind(
      orderId, offer.req_id, offerId, user.id, offer.merchant_id, offer.store_id,
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
        accepted_at: ts,
      }),
      ts, ts
    ),
    c.env.DB.prepare(`UPDATE community_requests SET community_order_id = ? WHERE id = ?`)
      .bind(orderId, offer.req_id),
  ]);

  // Now reserve the money. Idempotent on the order id, so a retry of this
  // whole request cannot hold twice.
  const escrow = await holdEscrow(c.env.DB, {
    communityOrderId: orderId,
    customerId: user.id,
    merchantId: String(offer.merchant_id),
    grossIqd: price,
    platformFeeIqd: split.platform_fee_iqd,
    merchantReceivableIqd: split.merchant_receivable_iqd,
    idempotencyKey: `accept:${orderId}`,
  });

  if (!escrow.ok) {
    // Funding failed. Undo cleanly: the customer keeps their request, the
    // merchants keep their offers, and nobody is left holding a contract that
    // was never paid for.
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE community_orders SET state = 'cancelled', cancelled_at = ? WHERE id = ?`)
        .bind(ts, orderId),
      c.env.DB.prepare(
        `UPDATE community_requests
            SET state = 'receiving_offers', status = 'open', accepted_offer_id = NULL,
                community_order_id = NULL, updated_at = ?
          WHERE id = ?`
      ).bind(ts, offer.req_id),
      c.env.DB.prepare(`UPDATE community_offers SET state = 'pending', updated_at = ? WHERE id = ?`)
        .bind(ts, offerId),
      c.env.DB.prepare(
        `UPDATE community_offers SET state = 'pending', updated_at = ?
          WHERE request_id = ? AND id != ? AND state = 'rejected' AND updated_at = ?`
      ).bind(ts, offer.req_id, offerId, ts),
    ]);
    if (escrow.reason === 'INSUFFICIENT_FUNDS') {
      throw badRequest(
        'Your wallet balance does not cover this offer. Top up and try again.',
        'INSUFFICIENT_FUNDS',
        { required_iqd: price }
      );
    }
    throw badRequest('Could not reserve the funds for this offer', 'ESCROW_FAILED', { reason: escrow.reason });
  }

  // Funded. Open the order for work and start the confirmation clock.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_orders SET state = 'funded', updated_at = ? WHERE id = ? AND state = 'accepted'`
    ).bind(ts, orderId),
    c.env.DB.prepare(`UPDATE community_requests SET state = 'in_progress', updated_at = ? WHERE id = ?`)
      .bind(ts, offer.req_id),
  ]);

  await audit(c.env.DB, user.id, 'community.offer_accepted', offerId, {
    order: orderId,
    price,
    fee: split.platform_fee_iqd,
    auto_complete_days: autoDays,
  });

  const order = await c.env.DB.prepare('SELECT * FROM community_orders WHERE id = ?').bind(orderId).first();
  return c.json({ success: true, order, escrow_id: (escrow as { escrowId: string }).escrowId }, 201);
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
  await c.env.DB.prepare(
    `UPDATE community_orders SET state = 'in_progress', updated_at = ? WHERE id = ? AND state = 'funded'`
  ).bind(nowIso(), orderId).run();
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
    // client does.
    idempotencyKey: `confirm:${orderId}`,
  });
  if (!released.ok) {
    throw conflict(`The funds could not be released (${(released as { reason: string }).reason})`);
  }

  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_orders SET state = 'completed', confirmed_at = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'merchant_marked_delivered'`
    ).bind(ts, ts, ts, orderId),
    c.env.DB.prepare(
      `UPDATE community_requests SET state = 'completed', status = 'closed', updated_at = ? WHERE id = ?`
    ).bind(ts, row.request_id),
    // Reputation is a raw EVENT, never a number someone edits (§41).
    c.env.DB.prepare(
      `INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, community_order_id)
       VALUES (?,?,'order_completed',10,?)`
    ).bind(newId('rep'), row.merchant_id, orderId),
    c.env.DB.prepare(
      `UPDATE community_merchants SET completed_orders = completed_orders + 1 WHERE id = ?`
    ).bind(row.merchant_id),
  ]);

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
    throw conflict('This order is already settled');
  }

  const escrow = await escrowForOrder(c.env.DB, orderId);
  const ts = nowIso();
  const complaintId = newId('cmp');

  await c.env.DB.batch([
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
    c.env.DB.prepare(
      `UPDATE community_orders SET state = 'disputed', updated_at = ? WHERE id = ?`
    ).bind(ts, orderId),
    c.env.DB.prepare(
      `UPDATE community_requests SET state = 'disputed', updated_at = ? WHERE id = ?`
    ).bind(ts, row.request_id),
  ]);

  if (escrow) {
    await disputeEscrow(c.env.DB, {
      escrowId: escrow.id,
      actorId: user.id,
      actorRole: isCustomer ? 'customer' : 'merchant',
      reason: description.slice(0, 200),
      idempotencyKey: `dispute:${orderId}`,
    });
  }

  await audit(c.env.DB, user.id, 'community.order_disputed', orderId, { complaint: complaintId });
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

  const escrow = await escrowForOrder(c.env.DB, orderId);
  if (escrow) {
    const refund = await refundEscrow(c.env.DB, {
      escrowId: escrow.id,
      actorId: user.id,
      actorRole: role,
      reason: 'cancelled before work started',
      idempotencyKey: `cancel:${orderId}`,
    });
    if (!refund.ok) throw conflict(`Could not refund (${(refund as { reason: string }).reason})`);
  }

  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_orders SET state = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`
    ).bind(ts, ts, orderId),
    c.env.DB.prepare(
      `UPDATE community_requests SET state = 'cancelled', status = 'closed', updated_at = ? WHERE id = ?`
    ).bind(ts, row.request_id),
  ]);

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
