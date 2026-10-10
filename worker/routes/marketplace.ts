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
import { fanOutMerchantNotice, notifyDisputeOpened, notifyPayoutAvailable, offerAcceptedNotice } from '../lib/merchantNotify';
import type { Context } from 'hono';
import type { AppContext, Env } from '../lib/types';
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
import { getTierStatus, benefits, membershipBadges } from '../lib/entitlements';
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
import { merchantSuspension } from '../lib/merchantLedger';
import { announceAfterResponse } from '../lib/adminTopicRouting';
// Levo Community's maintenance switch, on the routes that START trade here
// (the owner closed /requests with the community — docs/DECISIONS.md).
import { communityClosedRefusal, requireCommunityOpen } from '../lib/communityGate';
import { notifyOfferReceived } from '../lib/engagementNotify';
import {
  notifyCustomOrderCancelledByCustomer,
  notifyCustomOrderDelivered,
  notifyCustomOrderDisputedByMerchant,
  notifyCustomOrderStarted,
} from '../lib/customOrderNotify';
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
  notifyOffersRejected,
  offerAcceptedNotification,
  offerCountStatement,
  onPublicBoard,
  requestMovedFence,
  revokeViewerTokensStatement,
  staleOfferNotifications,
  type RequestForAccess,
} from '../lib/communityRequests';
import {
  DRAFT_TTL_DAYS,
  OFFER_DELIVERY_METHODS,
  OFFER_MAX_MATERIALS,
  OFFER_VALIDITY_MAX_DAYS,
  composeSnapshot,
  contactFor,
  contactSnapshot,
  publicEstimate,
  recordOfferRevisionStatement,
  recordRevisionStatement,
  reviseIfOfferedStatement,
  supersedeStatement,
} from '../lib/requestRevisions';
import { getSetting } from '../lib/settings';
import { feedCursor, nextFeedCursor } from '../lib/feedCursor';
import { requestBoardVisible } from '../lib/requestBoard';
import { likePattern } from '../lib/sqlLike';
import { notifyStatement, notifyGrouped, peopleAr, stampGroupedCkb } from '../lib/notifications';
import { merchantHref } from '@levonis/contracts/merchantRoutes';
// Eligibility as data (W5-B): the offer gate, the file matrix and the re-match.
import { assertMayOffer, eligibleVerdictSql, liveVerdict, rematchNow } from '../lib/printMatchingStore';
// A request addressed to ONE store (0151): its store quotes it without matching.
import { assertMayQuote, directRequest } from '../lib/directRequests';
import { isDirectMerchant } from '../lib/communityRequests';
import { announceCustomOrder, customOrderCard, postSystemCard } from '../lib/chatCards';
import { fileClass, fileReadStatement, fileReader, mayReadBytes, previewGrantFor } from '../lib/requestFilePolicy';
// Phase 5b (docs/COMMUNITY_ECOSYSTEM.md §9.5): the discussion's server-written
// rows on a close or a revision, and the timeline's «started» row.
import { writeRequestSystemUpdate } from './requestDiscussion';
import { recordOrderEvent } from './communityOrderTimeline';
// Offers V2 (0159, §9.5): a file key is the caller's own private upload or nothing.
import { ownedFileObject } from '../lib/fileOwnership';
import { isSchemaMissing } from '../lib/membershipBenefits';
// A board deal's conversation: the request thread, found or created by the chat door's own helper.
import { openStoreThread } from './chats';

export const marketplaceRoutes = new Hono<AppContext>();

const nowIso = () => new Date().toISOString();

// --------------------------------------------------------------- shapes

/**
 * The public view of a request.
 *
 * Note what is absent: no customer email, phone, address or user id. A
 * merchant browsing the board sees a job to quote on and a display name,
 * which is everything they need to decide whether to offer.
 *
 * Exported for the community page's list (worker/routes/community.ts), so the
 * two lists of the same rows answer with ONE whitelist.
 */
export function publicRequest(r: Record<string, unknown>) {
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
    /** The job's version. It moves when a published request's terms change
     *  after an offer priced it; that offer is then superseded (0116, 0130). */
    revision: r.revision ?? 1,
    /** Notes the customer wrote FOR the merchants (0130) — a real column. The
     *  private `notes` (where the old wizard stashed a link) is never shown. */
    customer_notes: r.customer_notes ?? '',
  };
}

/** A JSON id list column, read defensively. */
function parseIds(raw: unknown): string[] {
  const v = safeParse<unknown>(raw, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, OFFER_MAX_MATERIALS) : [];
}

/** The delivery fee an offer row carries (0159); a row from before it carries none. */
const offerFee = (o: Record<string, unknown>): number => Math.max(0, Number(o.delivery_fee_iqd ?? 0) || 0);
/** What the customer agrees to: price plus fee, computed HERE and never read from a client. */
const offerTotal = (o: Record<string, unknown>): number => (Number(o.price_iqd ?? 0) || 0) + offerFee(o);

export function offerShape(o: Record<string, unknown>, badges: { pro: Set<string>; premium: Set<string> } = { pro: new Set(), premium: new Set() }) {
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
    updated_at: o.updated_at ?? o.created_at,
    /** Catalogue materials (0130); `materials` stays the free-text note. */
    material_ids: parseIds(o.material_ids),
    /**
     * THE VERSION THE CUSTOMER IS LOOKING AT. Acceptance sends it back with
     * the price, and only that exact version can be accepted (audit 03 §10 B).
     */
    revision: Number(o.revision ?? 1),
    /** The job revision this offer priced. */
    request_revision: Number(o.request_revision ?? 1),
    /**
     * STALE: the customer changed the job after this offer priced it (audit 03
     * §10 K). Since W5-A the offer is `superseded` in the same write; a row
     * written before 0130 may still be `pending` behind the revision. Either
     * way it cannot be accepted until its merchant re-confirms or edits it.
     */
    stale:
      o.state === 'superseded' ||
      (o.state === 'pending' && o.r_revision !== undefined && o.r_revision !== null
        ? Number(o.request_revision ?? 1) < Number(o.r_revision)
        : false),
    /** Past its own validity — shown as expired even before the sweep writes it. */
    expired: o.state === 'expired' || (o.state === 'pending' && isPast(o.expires_at as string | null)),
    /**
     * OFFERS V2 (0159, docs/COMMUNITY_ECOSYSTEM.md §9.5). The fee is part of
     * what the customer agrees to, so the total is computed on the server;
     * `revised` is the «عرض معدّل» the customer sees (revision > 1);
     * `valid_until` the validity under the name the card reads. `files` are
     * attached by the routes that can say who is asking. A draft is never one
     * of these rows (`draftShape`), so `draft` is false here by construction.
     */
    delivery_fee_iqd: offerFee(o),
    total_iqd: offerTotal(o),
    quantity: o.quantity === null || o.quantity === undefined ? null : Number(o.quantity),
    color: String(o.color ?? ''),
    terms: String(o.terms ?? ''),
    revised: Number(o.revision ?? 1) > 1,
    valid_until: (o.expires_at as string | null) ?? null,
    draft: false,
    // What a customer needs to compare offers (§27) — reputation, not contact
    // details.
    merchant: o.m_name
      ? {
          id: o.merchant_id,
          name: o.m_name,
          verified: !!o.m_verified,
          /** Membership status badge, separate from the moderation mark. */
          pro_badge: badges.pro.has(String(o.m_user_id)),
          premium_badge: badges.premium.has(String(o.m_user_id)),
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

/**
 * The public board. Only states a merchant can still act on — the community
 * page's rule (`requestBoardVisible`), searchable the same way (`q`, title and
 * description). Paged by (created_at, id): the bare timestamp it used dropped
 * a request that shared its second with the last one on a page.
 */
marketplaceRoutes.get('/requests', requireCommunityOpen, async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  const cursor = feedCursor(c.req.query('cursor'));
  const q = likePattern(c.req.query('q'));
  const category = c.req.query('category') || '';
  const governorate = c.req.query('governorate') || '';

  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.title, r.description, r.category, r.quantity, r.material, r.color,
            r.dimensions, r.budget_iqd, r.deadline, r.governorate, r.delivery_pref,
            r.state, r.offer_count, r.created_at, r.expires_at,
            u.name AS customer_name,
            (SELECT COUNT(*) FROM community_request_files f WHERE f.request_id = r.id) AS file_count
       FROM community_requests r JOIN users u ON u.id = r.customer_id
      WHERE ${requestBoardVisible('?1', '?2')}
        AND (?3 = '' OR r.category = ?3)
        AND (?4 = '' OR r.governorate = ?4)
        AND (?5 = '' OR r.created_at < ?5 OR (r.created_at = ?5 AND r.id < ?6))
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?7`
  ).bind(nowIso(), q, category, governorate, cursor.at, cursor.id, limit).all<Record<string, unknown>>();

  return c.json({
    success: true,
    requests: results.map(publicRequest),
    next_cursor: nextFeedCursor(results, limit),
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
    // …and the store a DIRECT request is addressed to (0151): it was sent to
    // them to quote, and is nobody else's to read.
    const engaged = user
      ? (await isEngagedMerchant(c.env.DB, id, user.id)) || (await isDirectMerchant(c.env.DB, id, user.id))
      : false;
    if (!engaged) throw notFound('Request not found');
  }

  const files = await c.env.DB.prepare(
    'SELECT id, file_name, content_type, size_bytes, kind, preview_key FROM community_request_files WHERE request_id = ?'
  ).bind(id).all<Record<string, unknown>>();
  // WHAT THIS CALLER MAY DO WITH EACH FILE (W5-B's matrix, worker/lib/
  // requestFilePolicy.ts): the list is the request's, the bytes are not. A
  // file this caller may not read carries no URL; a model an eligible
  // merchant may only preview says so. Asked only when there are files.
  const { reader } = files.results.length && user
    ? await fileReader(c.env, r as unknown as RequestForAccess, user, { allowAdmin: true })
    : { reader: null };

  return c.json({
    success: true,
    request: publicRequest(r),
    // R2 keys are NEVER returned. What a caller gets is a route on this
    // worker, which re-derives their right to the file on every read — so a
    // link shared after the request closes simply stops working.
    files: files.results.map(({ preview_key, ...f }) => {
      const cls = fileClass(String(f.kind ?? ''), String(f.content_type ?? ''));
      const readable = mayReadBytes(reader, cls);
      return {
        ...f,
        inline: String(f.content_type ?? '').startsWith('image/'),
        url: readable ? `/api/marketplace/requests/${id}/files/${f.id}` : null,
        /** download (the original) | view (a picture or a drawing) | preview (the 3D preview only) | none */
        access: readable ? (cls === 'model' ? 'download' : 'view') : cls === 'model' && preview_key && previewGrantFor(reader) ? 'preview' : 'none',
      };
    }),
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
 * A PUBLISHED JOB'S ATTACHMENTS CHANGED (migrations 0116, 0130). If a merchant
 * has a pending offer on the current revision, the revision moves and those
 * offers are superseded — in the same batch as the file row. If nobody has
 * priced it, the revision stays and its snapshot is rewritten afterwards
 * (`recordFilesRevision`). Conditional on the request taking offers, so a
 * DRAFT (the wizard uploading its files) revises nothing.
 */
function reviseStatements(db: D1Database, requestId: string, ts: string): D1PreparedStatement[] {
  return [
    reviseIfOfferedStatement(db, requestId, ts),
    supersedeStatement(db, requestId, ts),
    offerCountStatement(db, requestId),
  ];
}

/**
 * After an attachment change on a published job: record the revision as it
 * now stands, and tell every merchant whose offer it superseded. Never throws —
 * the file change itself has already committed.
 */
async function afterFilesChanged(db: D1Database, requestId: string, userId: string): Promise<void> {
  try {
    const row = await db
      .prepare(`SELECT revision FROM community_requests WHERE id = ? AND state IN ('open','receiving_offers')`)
      .bind(requestId)
      .first<{ revision: number }>();
    if (!row) return;
    const snap = await composeSnapshot(db, requestId);
    const stmts = await staleOfferNotifications(db, requestId, Number(row.revision));
    if (snap) stmts.unshift(recordRevisionStatement(db, requestId, snap, 'files', userId, nowIso()));
    if (stmts.length) await db.batch(stmts);
    // «تغيّر الطلب» in the discussion (§9.5) — after the revision committed.
    if (snap) await writeRequestSystemUpdate(db, requestId, 'revised', { change: 'files', revision: Number(row.revision) });
  } catch (e) {
    console.error('revision after a file change not recorded for', requestId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * A PUBLISHED JOB'S FILES CHANGED: its verdicts are decided again (W5-B) — a
 * new model may be bigger than it was, and a new revision retires the old
 * verdicts. Inline and bounded, with a queue row the sweep finishes if this
 * pass cannot; never throws.
 */
async function rematchAfterFiles(env: Env, requestId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT 1 AS x FROM community_requests WHERE id = ? AND state IN ('open','receiving_offers')`)
    .bind(requestId)
    .first()
    .catch(() => null);
  if (row) await rematchNow(env, 'request', requestId, 'files');
}

/**
 * «أضاف سارة ملفات إلى الطلب» — GROUPED FILE NOTIFICATIONS TO THE WORKSHOPS
 * (0158, docs/COMMUNITY_ECOSYSTEM.md §9.4). The merchants ON A REQUEST'S
 * MATCHES hear that its files changed: the owners of the workshops the
 * eligibility engine marked eligible (`community_request_matches`) and of
 * those standing behind a live offer — never the whole workshop list, and
 * never the customer's own account. ONE row per owner keyed
 * `request_files:<requestId>` (`notifyGrouped`, counted by people like every
 * grouped kind), the Sorani stamped into `meta` after the count is known.
 * Never throws: the file is stored whatever the bell does.
 */
async function notifyRequestFiles(
  db: D1Database,
  requestId: string,
  actor: { id: string; name?: string | null; username?: string | null }
): Promise<void> {
  try {
    const req = await db.prepare('SELECT title FROM community_requests WHERE id = ?').bind(requestId).first<{ title: string }>();
    const { results } = await db
      .prepare(
        `SELECT DISTINCT m.user_id FROM community_merchants m
          WHERE m.user_id <> ?1 AND (
            m.id IN (SELECT rm.merchant_id FROM community_request_matches rm WHERE rm.request_id = ?2 AND rm.eligible = 1)
            OR m.id IN (SELECT o.merchant_id FROM community_offers o WHERE o.request_id = ?2 AND o.state IN ('pending','superseded','accepted'))
          )`
      )
      .bind(actor.id, requestId)
      .all<{ user_id: string }>();
    const title = String(req?.title ?? '').trim();
    const name = actor.name || actor.username || '';
    const aboutAr = title ? ` «${title}»` : '';
    const aboutEn = title ? ` “${title}”` : '';
    for (const r of results ?? []) {
      const written = await notifyGrouped(db, {
        userId: String(r.user_id),
        kind: 'request_files',
        groupKey: `request_files:${requestId}`,
        actor: { id: actor.id, name },
        title: (n, a) => ({
          ar: n === 1 ? `أضاف ${a} ملفات إلى الطلب${aboutAr}` : `أضاف ${peopleAr(n)} ملفات إلى الطلب${aboutAr}`,
          en: n === 1 ? `${a} added files to the request${aboutEn}` : `${n} people added files to the request${aboutEn}`,
        }),
        body: { ar: 'راجع الملفات الجديدة قبل تأكيد عرضك.', en: 'Review the new files before you confirm your offer.' },
        link: merchantHref.request(requestId),
        entity_type: 'request',
        entity_id: requestId,
      });
      if (written) {
        await stampGroupedCkb(db, written.id, {
          title_ckb:
            written.count === 1
              ? `${name} فایلی زیاد کرد بۆ داواکارییەکە${aboutAr}`
              : `${written.count} کەس فایلیان زیاد کرد بۆ داواکارییەکە${aboutAr}`,
          body_ckb: 'پێش پشتڕاستکردنەوەی ئۆفەرەکەت فایلە نوێیەکان بپشکنە.',
        });
      }
    }
  } catch (e) {
    console.error('request file notice not written for', requestId, e instanceof Error ? e.message : String(e));
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
      // priced without this file is superseded until its merchant re-confirms.
      ...reviseStatements(c.env.DB, id, ts),
    ]);
  } catch (e) {
    // The row is what makes the object reachable. If it cannot be written,
    // delete the object rather than leaving a file nothing points at.
    await deleteMediaObject(c.env, 'private', key).catch(() => {});
    throw e;
  }
  await afterFilesChanged(c.env.DB, id, user.id);
  // The workshops on this request's matches hear «أضاف … ملفات», grouped (0158)
  // — BEFORE the re-match: the ones who were weighing the job as it stood are
  // the ones the change concerns; a workshop the new file makes eligible gets
  // the engine's own «طلب يناسب ورشتك» from the re-match itself.
  await notifyRequestFiles(c.env.DB, id, user);
  await rematchAfterFiles(c.env, id);

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
            r.id, r.customer_id, r.state, r.visibility, r.expires_at, r.revision
       FROM community_request_files f
       JOIN community_requests r ON r.id = f.request_id
      WHERE f.id = ? AND f.request_id = ?`
  ).bind(fileId, id).first<{
    file_key: string; file_name: string; content_type: string; kind: string; revision: number;
  } & RequestForAccess>();
  if (!row) throw notFound('File not found');

  // ONE policy for every door onto a request's files (worker/lib/
  // requestFilePolicy.ts, W5-B): the customer, an admin and the accepted
  // merchant read everything; a merchant whose live verdict is ELIGIBLE reads
  // the pictures and drawings — never the original model, which it previews
  // instead; anyone else nothing. The board part still means NOT EXPIRED and
  // Levo Community letting this caller in (audit 03 §10 G).
  const { reader, gateClosed, visible } = await fileReader(c.env, row, user, { allowAdmin: true });
  if (gateClosed) throw communityClosedRefusal();
  // A request this caller cannot see at all (a draft, a closed or private one)
  // has no files as far as they know.
  if (!visible) throw notFound('File not found');
  const cls = fileClass(row.kind, row.content_type);
  if (!mayReadBytes(reader, cls)) {
    // The request (and its file list) may well be visible to this caller, so
    // a 404 would lie; the refusal says which kind of «no» it is.
    throw new HttpError(
      403,
      'You may not open this file',
      reader === 'eligible' ? 'FILE_ORIGINAL_RESTRICTED' : 'FILE_NOT_ALLOWED'
    );
  }

  const obj = await getMediaObject(c.env, 'private', row.file_key);
  if (!obj) throw notFound('File not found');
  // Every read is counted (0132 `request_file_reads`). Never blocks the file.
  await fileReadStatement(c.env.DB, {
    requestId: id, fileId, userId: user.id, reader: reader!, what: cls === 'model' ? 'original' : 'inline', revision: row.revision,
  }).run().catch((e) => console.error('file read not counted', fileId, e instanceof Error ? e.message : String(e)));

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
    ...reviseStatements(c.env.DB, id, nowIso()),
  ]);
  await deleteMediaObject(c.env, 'private', row.file_key).catch(() => {});
  await afterFilesChanged(c.env.DB, id, user.id);
  await rematchAfterFiles(c.env, id);

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

  const id = newId('req');
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO community_requests
       (id, customer_id, title, description, status, state, category, quantity, material, color,
        dimensions, budget_iqd, deadline, governorate, delivery_pref, notes, visibility,
        created_at, expires_at, updated_at, customer_notes)
     VALUES (?,?,?,?,'closed','draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
    // The ABANDONED-DRAFT clock (W5-A): every save pushes it ahead, and the
    // publish replaces it with the board's own expiry.
    new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000).toISOString(),
    ts,
    str(body.customer_notes, 'customer_notes', { min: 0, max: 1000, required: false })
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
          WHERE request_id = ? AND state IN ('pending','superseded')`
      ).bind(ts, id),
      offerCountStatement(c.env.DB, id),
      revokeViewerTokensStatement(c.env.DB, id, ts),
    ]);
  } catch (e) {
    if (!isConstraintAbort(e)) throw e;
    throw conflict('This request changed while you were cancelling it — reload it', 'REQUEST_CHANGED');
  }

  await audit(c.env.DB, user.id, 'community.request_cancelled', id, { from });
  // The discussion records the close (§9.5) — after the commit, never inside it.
  if (from !== 'draft') await writeRequestSystemUpdate(c.env.DB, id, 'cancelled', { by: 'customer', from });
  if (from !== 'draft') await notifyOffersRejected(c.env.DB, id, ts, 'request_cancelled');
  return c.json({ success: true });
});

// ---------------------------------------------------------------- offers

/**
 * OFFERS v2 (W5-A, audit 03 G15): an offer is price, completion days, a
 * delivery method from a closed list, materials from the catalogue,
 * inclusions, warranty terms, a validity and a message. The same reader for a
 * new offer and an edit, so the two can never accept different things.
 */
export interface OfferTerms {
  price_iqd?: number;
  completion_days?: number;
  delivery_method?: string;
  message?: string;
  materials?: string;
  material_ids?: string[];
  included?: string;
  warranty_terms?: string;
  expires_at?: string | null;
}

/** The catalogue ids a merchant may name: the active print materials. */
async function catalogueIds(db: D1Database): Promise<Set<string>> {
  const list = (await getSetting(db, 'printMaterials')) as unknown;
  return new Set(
    (Array.isArray(list) ? list : [])
      .filter((m): m is { id: unknown; active?: unknown } => !!m && typeof m === 'object' && (m as { active?: unknown }).active !== false)
      .map((m) => String(m.id))
  );
}

export async function readOfferTerms(
  db: D1Database,
  body: Record<string, unknown>,
  now: string,
  opts: { partial: boolean }
): Promise<OfferTerms> {
  const t: OfferTerms = {};
  const has = (k: string) => !opts.partial || body[k] !== undefined;
  if (!opts.partial || body.price_iqd !== undefined) t.price_iqd = int(body.price_iqd, 'price_iqd', { min: 1, max: 1_000_000_000 });
  if (has('completion_days')) {
    t.completion_days = int(body.completion_days, 'completion_days', { min: 0, max: 365, def: opts.partial ? undefined : 0 });
  }
  if (has('delivery_method')) {
    const dm = str(body.delivery_method, 'delivery_method', { min: 0, max: 60, required: false });
    // '' is "not stated" (every offer written before v2). Anything else is one
    // of the closed list — free text here was what a customer could not compare.
    if (dm && !(OFFER_DELIVERY_METHODS as readonly string[]).includes(dm)) {
      throw badRequest('Choose how the job is handed over from the list', 'OFFER_DELIVERY_INVALID');
    }
    t.delivery_method = dm;
  }
  if (has('message')) t.message = str(body.message, 'message', { min: 0, max: 2000, required: false });
  if (has('materials')) t.materials = str(body.materials, 'materials', { min: 0, max: 500, required: false });
  if (has('included')) t.included = str(body.included, 'included', { min: 0, max: 500, required: false });
  if (has('warranty_terms')) t.warranty_terms = str(body.warranty_terms, 'warranty_terms', { min: 0, max: 500, required: false });
  if (body.material_ids !== undefined || !opts.partial) {
    const raw = body.material_ids === undefined || body.material_ids === null ? [] : body.material_ids;
    if (!Array.isArray(raw) || raw.length > OFFER_MAX_MATERIALS) {
      throw badRequest(`Name up to ${OFFER_MAX_MATERIALS} materials from the catalogue`, 'OFFER_MATERIAL_INVALID');
    }
    const ids = [...new Set(raw.map((x) => String(x).slice(0, 60)))];
    if (ids.length) {
      const known = await catalogueIds(db);
      if (ids.some((id) => !known.has(id))) {
        throw badRequest('A material on this offer is not in the catalogue', 'OFFER_MATERIAL_INVALID');
      }
    }
    t.material_ids = ids;
  }
  // Validity: `valid_days` (1–60, what the offer form sends) or an explicit
  // `expires_at` (a real future instant, as before). Neither = open-ended.
  if (body.valid_days !== undefined && body.valid_days !== null && body.valid_days !== '') {
    const days = int(body.valid_days, 'valid_days', { min: 1, max: OFFER_VALIDITY_MAX_DAYS });
    t.expires_at = new Date(Date.parse(now) + days * 86_400_000).toISOString();
  } else if (has('expires_at')) {
    t.expires_at = offerExpiry(body.expires_at, now);
  }
  return t;
}

// ------------------------------------------------------------- offers v2

/** The most files one offer carries (§9.5). */
export const OFFER_FILES_MAX = 6;
const OFFER_FEE_MAX_IQD = 1_000_000_000;
const OFFER_COLOR_MAX = 40;
const OFFER_TERMS_MAX = 500;

export interface OfferExtras {
  delivery_fee_iqd?: number;
  quantity?: number | null;
  color?: string;
  terms?: string;
}

/**
 * THE V2 TERMS (0159): the delivery fee (whole dinars, zero or more — the
 * total is price + fee and is never read from the client), the quantity the
 * offer prices, the colour, the merchant's terms. `partial` (an edit, a draft)
 * reads only what the body names; a new offer reads all, with «not stated»
 * defaults. One reader for create, edit, draft and send, so none can accept
 * a different thing.
 */
export function readOfferExtras(body: Record<string, unknown>, opts: { partial: boolean }): OfferExtras {
  const t: OfferExtras = {};
  const named = (k: string) => body[k] !== undefined;
  if (!opts.partial || named('delivery_fee_iqd')) {
    const raw = body.delivery_fee_iqd;
    if (raw === undefined || raw === null || raw === '') {
      if (!opts.partial) t.delivery_fee_iqd = 0;
    } else {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isSafeInteger(n) || n < 0 || n > OFFER_FEE_MAX_IQD) {
        throw badRequest('The delivery fee must be a whole number of dinars, zero or more', 'OFFER_FEE_INVALID');
      }
      t.delivery_fee_iqd = n;
    }
  }
  if (!opts.partial || named('quantity')) {
    t.quantity = body.quantity === undefined || body.quantity === null || body.quantity === ''
      ? null
      : int(body.quantity, 'quantity', { min: 1, max: 100_000 });
  }
  if (!opts.partial || named('color')) t.color = str(body.color, 'color', { min: 0, max: OFFER_COLOR_MAX, required: false });
  if (!opts.partial || named('terms')) t.terms = str(body.terms, 'terms', { min: 0, max: OFFER_TERMS_MAX, required: false });
  return t;
}

/**
 * A PICKUP CARRIES NO DELIVERY FEE — the composer's rule, held here too
 * (review 2026-09-30): the customer collects from the workshop, so there is
 * nothing to deliver and nothing to charge for it. `method` and `fee` are the
 * EFFECTIVE values (the body's, else the stored offer's or draft's); `named`
 * says the body itself named that fee. A fee the body names above zero beside
 * a pickup is refused `OFFER_PICKUP_FEE`; a fee only inherited (an edit that
 * switches the method to pickup and says nothing of the fee) answers 'zero',
 * and the caller writes 0 in the same statement — so the total the customer
 * is told and funds is the price.
 */
export function pickupFeeRule(method: unknown, fee: unknown, named: boolean): 'ok' | 'zero' {
  if (method !== 'pickup' || !(Number(fee ?? 0) > 0)) return 'ok';
  if (named) throw badRequest('A pickup from the workshop carries no delivery fee', 'OFFER_PICKUP_FEE');
  return 'zero';
}

export type OfferFileKind = 'image' | 'pdf' | 'model';
export interface OfferFileInput {
  key: string;
  kind: OfferFileKind;
  name: string;
  bytes: number;
  content_type: string;
}

/**
 * `files: [{key}]` — each key must be the caller's OWN private upload for an
 * offer ON THIS REQUEST (`ownedFileObject`, worker/lib/fileOwnership.ts): a
 * key is a string and a string can name anybody's object, so nothing here
 * trusts it. The door is the strict one (review 2026-09-30): purpose exactly
 * `offer` (a legacy '' row — a bank-transfer receipt, an old chat picture —
 * is never an offer file), the key under the merchant's own
 * `merchants/<uid>/offers/` placement, and `file_objects.entity_id` the
 * request the upload door filed it under (another job's quote does not ride
 * this one). At most six; a picture, a PDF or a model. `undefined` when the
 * body does not name files at all (an edit that leaves them as they are).
 */
async function readOfferFiles(db: D1Database, body: Record<string, unknown>, userId: string, requestId: string): Promise<OfferFileInput[] | undefined> {
  if (body.files === undefined) return undefined;
  const raw = body.files === null ? [] : body.files;
  if (!Array.isArray(raw)) throw badRequest('files must be a list of {key}');
  if (raw.length > OFFER_FILES_MAX) throw badRequest(`An offer may carry at most ${OFFER_FILES_MAX} files`, 'OFFER_FILE_LIMIT');
  const out: OfferFileInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const key = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { key?: unknown }).key : '';
    const owned = await ownedFileObject(db, key, userId, ['offer'], {
      exactPurpose: true,
      prefix: `merchants/${userId}/offers/`,
      entityId: requestId,
    });
    if (!owned) throw new HttpError(403, 'That file is not one you uploaded for an offer', 'OFFER_FILE_NOT_OWNED');
    if (seen.has(owned.key)) continue;
    seen.add(owned.key);
    const kind: OfferFileKind | null =
      owned.kind === 'image' ? 'image' : owned.kind === 'model' ? 'model' : owned.mime === 'application/pdf' ? 'pdf' : null;
    if (!kind) throw badRequest('An offer carries a picture, a PDF or a model', 'UPLOAD_KIND_NOT_ALLOWED');
    const ext = owned.key.includes('.') ? owned.key.slice(owned.key.lastIndexOf('.') + 1) : 'bin';
    out.push({ key: owned.key, kind, name: safeFileName(owned.original_name ?? '', ext), bytes: owned.bytes, content_type: owned.mime });
  }
  return out;
}

/**
 * The file rows of an offer, REPLACED as a set inside the caller's batch: what
 * the new list no longer names is deleted, what it adds is inserted, every
 * statement fenced on the offer row existing and — for an edit, `fenceTs` —
 * on the edit having landed (`updated_at = ts`), so a lost race writes no
 * file onto an offer that did not move.
 */
function offerFileStatements(db: D1Database, offerId: string, files: OfferFileInput[], ts: string, fenceTs: string | null): D1PreparedStatement[] {
  const fence = `EXISTS (SELECT 1 FROM community_offers o WHERE o.id = ?1 AND (?2 IS NULL OR o.updated_at = ?2))`;
  return [
    db
      .prepare(`DELETE FROM community_offer_files WHERE offer_id = ?1 AND file_key NOT IN (SELECT value FROM json_each(?3)) AND ${fence}`)
      .bind(offerId, fenceTs, JSON.stringify(files.map((f) => f.key))),
    ...files.map((f) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO community_offer_files (id, offer_id, file_key, kind, name, bytes, content_type, created_at)
           SELECT ?3, ?1, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${fence}`
        )
        .bind(offerId, fenceTs, newId('ofl'), f.key, f.kind, f.name, f.bytes, f.content_type, ts)
    ),
  ];
}

/** The files of these offers, grouped by offer — none on a database behind 0159. */
async function offerFilesFor(db: D1Database, offerIds: string[]): Promise<Map<string, Array<Record<string, unknown>>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  if (!offerIds.length) return out;
  try {
    const { results } = await db
      .prepare(
        `SELECT id, offer_id, file_key, kind, name, bytes, content_type FROM community_offer_files
          WHERE offer_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`
      )
      .bind(JSON.stringify([...new Set(offerIds)]))
      .all<Record<string, unknown>>();
    for (const f of results ?? []) {
      const k = String(f.offer_id);
      out.set(k, [...(out.get(k) ?? []), f]);
    }
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }
  return out;
}

/**
 * The files of the offers a SUBQUERY names (`SELECT o.id FROM community_offers
 * o WHERE …`, bound with `binds`) — the page's own rule in SQL, so the read
 * rides the same wave as the offers instead of waiting for their ids
 * (review 2026-09-30).
 */
async function offerFilesWhere(db: D1Database, offerIdsSql: string, binds: readonly unknown[]): Promise<Map<string, Array<Record<string, unknown>>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  try {
    const { results } = await db
      .prepare(
        `SELECT f.id, f.offer_id, f.file_key, f.kind, f.name, f.bytes, f.content_type FROM community_offer_files f
          WHERE f.offer_id IN (${offerIdsSql})
          ORDER BY f.created_at, f.rowid`
      )
      .bind(...binds)
      .all<Record<string, unknown>>();
    for (const f of results ?? []) {
      const k = String(f.offer_id);
      out.set(k, [...(out.get(k) ?? []), f]);
    }
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }
  return out;
}

/**
 * The files of every offer on a request the caller may see — the offers
 * list's own rule (the customer: all; a merchant: their own).
 */
function offerFilesInScope(db: D1Database, requestId: string, all: 0 | 1, merchantId: string): Promise<Map<string, Array<Record<string, unknown>>>> {
  return offerFilesWhere(db, 'SELECT o.id FROM community_offers o WHERE o.request_id = ?1 AND (?2 = 1 OR o.merchant_id = ?3)', [requestId, all, merchantId]);
}

/**
 * An offer file as a party sees it: a URL on this Worker, which re-derives the
 * caller's right on every read (GET /offers/:id/files/:fileId) — NEVER the
 * key, except to its uploader (the offer's merchant, `keys`), who sends the
 * keys back on an edit.
 */
function offerFilePublic(f: Record<string, unknown>, offerId: string, opts: { keys: boolean }) {
  return {
    id: f.id,
    kind: f.kind,
    name: f.name,
    bytes: Number(f.bytes ?? 0),
    content_type: String(f.content_type ?? ''),
    url: `/api/marketplace/offers/${encodeURIComponent(offerId)}/files/${encodeURIComponent(String(f.id))}`,
    ...(opts.keys ? { key: f.file_key } : {}),
  };
}

/** The offers' rows with their files, for a reader who may see them all. */
function withFiles(rows: Array<Record<string, unknown>>, files: Map<string, Array<Record<string, unknown>>>, keys: boolean) {
  return rows.map((row) => ({
    ...offerShape(row),
    files: (files.get(String(row.id)) ?? []).map((f) => offerFilePublic(f, String(row.id), { keys })),
  }));
}

// ------------------------------------------------------------------ drafts

/**
 * «احفظ مسودة» (0159, §9.5) lives in `community_offer_drafts`, not in
 * `community_offers`: 0031's one-live-offer index is `WHERE state IN
 * ('pending','accepted')` and cannot be widened, so a draft stored as a
 * pending row would collide with the same merchant's later live offer and
 * every reader of `state = 'pending'` would have to skip it. A draft is a
 * payload the send route feeds to the same fenced INSERT a new offer uses.
 * The client sees ONE concept: an offer with `draft: true`.
 */
interface DraftRow {
  id: string;
  request_id: string;
  merchant_id: string;
  payload_json: string;
  files_json: string;
  created_at: string;
  updated_at: string;
}

/** What a draft's payload holds: the validated terms as the readers returned them, plus what «send» needs. */
interface DraftPayload extends OfferTerms, OfferExtras {
  store_id?: string | null;
  quote_id?: string;
  /** Kept raw so the validity is recomputed from the SEND, not from the day the draft was saved. */
  valid_days?: number | null;
}

/** A merchant's own draft by id — null when none, and on a database behind 0159. */
async function loadDraft(db: D1Database, draftId: string, merchantId: string): Promise<DraftRow | null> {
  try {
    return (await db.prepare('SELECT * FROM community_offer_drafts WHERE id = ? AND merchant_id = ?').bind(draftId, merchantId).first<DraftRow>()) ?? null;
  } catch (e) {
    if (isSchemaMissing(e)) return null;
    throw e;
  }
}

/** A merchant's draft on a request — at most one (UNIQUE (request_id, merchant_id)). */
async function draftOnRequest(db: D1Database, requestId: string, merchantId: string): Promise<DraftRow | null> {
  try {
    return (await db.prepare('SELECT * FROM community_offer_drafts WHERE request_id = ? AND merchant_id = ?').bind(requestId, merchantId).first<DraftRow>()) ?? null;
  } catch (e) {
    if (isSchemaMissing(e)) return null;
    throw e;
  }
}

/** Every draft of a merchant with its request, newest first — «عروضي» flags them. */
async function merchantDrafts(db: D1Database, merchantId: string): Promise<Array<DraftRow & Record<string, unknown>>> {
  try {
    const { results } = await db
      .prepare(
        `SELECT d.*, r.title AS request_title, r.state AS request_state, r.revision AS r_revision, r.expires_at AS request_expires_at
           FROM community_offer_drafts d JOIN community_requests r ON r.id = d.request_id
          WHERE d.merchant_id = ? ORDER BY d.updated_at DESC, d.id DESC LIMIT 50`
      )
      .bind(merchantId)
      .all<DraftRow & Record<string, unknown>>();
    return results ?? [];
  } catch (e) {
    if (isSchemaMissing(e)) return [];
    throw e;
  }
}

/** The `valid_days` a body names (1..60), null for none — the offer form's field, kept raw on a draft. */
function readValidDays(body: Record<string, unknown>): number | null | undefined {
  if (body.valid_days === undefined) return undefined;
  if (body.valid_days === null || body.valid_days === '') return null;
  return int(body.valid_days, 'valid_days', { min: 1, max: OFFER_VALIDITY_MAX_DAYS });
}

/**
 * A DRAFT IN THE OFFER'S SHAPE — `draft: true`, `state: 'draft'`, revision 0 —
 * so the composer restores it and the lists flag it, with one concept on the
 * client. Returned to its author only, who may therefore see its file keys
 * (they are sent back on the next save).
 */
function draftShape(d: DraftRow, request: { revision?: unknown } = {}) {
  const p = safeParse<DraftPayload>(d.payload_json, {});
  const rawFiles = safeParse<OfferFileInput[]>(d.files_json, []);
  const files = Array.isArray(rawFiles) ? rawFiles : [];
  const price = p.price_iqd === undefined || p.price_iqd === null ? null : Number(p.price_iqd);
  const fee = Math.max(0, Number(p.delivery_fee_iqd ?? 0) || 0);
  return {
    id: d.id,
    request_id: d.request_id,
    merchant_id: d.merchant_id,
    store_id: p.store_id ?? null,
    price_iqd: price,
    completion_days: Number(p.completion_days ?? 0) || 0,
    delivery_method: String(p.delivery_method ?? ''),
    message: String(p.message ?? ''),
    materials: String(p.materials ?? ''),
    included: String(p.included ?? ''),
    warranty_terms: String(p.warranty_terms ?? ''),
    material_ids: Array.isArray(p.material_ids) ? p.material_ids : [],
    state: 'draft' as const,
    draft: true as const,
    expires_at: p.expires_at ?? null,
    valid_days: p.valid_days ?? null,
    created_at: d.created_at,
    updated_at: d.updated_at,
    revision: 0,
    request_revision: Number(request.revision ?? 0) || 0,
    stale: false,
    expired: false,
    revised: false,
    delivery_fee_iqd: fee,
    total_iqd: price === null ? null : price + fee,
    quantity: p.quantity ?? null,
    color: String(p.color ?? ''),
    terms: String(p.terms ?? ''),
    valid_until: p.expires_at ?? null,
    files: files.map((f) => ({ id: null, kind: f.kind, name: f.name, bytes: f.bytes, content_type: f.content_type ?? '', url: null, key: f.key })),
    merchant: null,
    quote_id: p.quote_id ?? null,
  };
}

/**
 * THE OFFER INSERT — one statement for a new offer and for a draft being sent,
 * so the two cannot write different things. It writes ONLY while the request
 * is still on the board, not the merchant's own, not expired, and the verdict
 * row for its CURRENT revision says eligible (`eligibleVerdictSql`, written
 * by `assertMayOffer` a moment earlier — a revision landing in between leaves
 * it behind and the write matches nothing; audit 03 §10 P). The batch also
 * moves the request to receiving_offers, records the first revision (0130)
 * and recomputes the board's count (never increments it).
 */
function insertOfferStatements(
  db: D1Database,
  p: { id: string; requestId: string; merchantId: string; storeId: string | null; customerId: string; terms: OfferTerms; extras: OfferExtras; ts: string }
): D1PreparedStatement[] {
  const { terms: t, extras: x } = p;
  return [
    db
      .prepare(
        `INSERT INTO community_offers
           (id, request_id, merchant_id, store_id, price_iqd, completion_days, delivery_method,
            message, materials, included, warranty_terms, state, expires_at, revision, request_revision,
            created_at, updated_at, material_ids, delivery_fee_iqd, quantity, color, terms)
         SELECT ?1, r.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, 1, r.revision, ?12, ?12, ?15, ?16, ?17, ?18, ?19
           FROM community_requests r
          WHERE r.id = ?13 AND r.state IN ('open','receiving_offers') AND r.visibility = 'public'
            AND r.customer_id <> ?14
            AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?12)
            AND ${eligibleVerdictSql('r', '?2')}`
      )
      .bind(
        p.id, p.merchantId, p.storeId, t.price_iqd!,
        t.completion_days ?? 0, t.delivery_method ?? '', t.message ?? '', t.materials ?? '',
        t.included ?? '', t.warranty_terms ?? '',
        t.expires_at ?? null, p.ts, p.requestId, p.customerId, JSON.stringify(t.material_ids ?? []),
        x.delivery_fee_iqd ?? 0, x.quantity ?? null, x.color ?? '', x.terms ?? ''
      ),
    db
      .prepare(
        `UPDATE community_requests
            SET state = CASE WHEN state = 'open' THEN 'receiving_offers' ELSE state END,
                updated_at = ?
          WHERE id = ? AND state IN ('open','receiving_offers')
            AND EXISTS (SELECT 1 FROM community_offers WHERE id = ?)`
      )
      .bind(p.ts, p.requestId, p.id),
    // What the customer will see as this offer's first version (0130).
    recordOfferRevisionStatement(db, p.id, 'create'),
    // The board shows a live count; it is recomputed, never incremented.
    offerCountStatement(db, p.requestId),
  ];
}

/** Offers on a request. The customer sees all; a merchant sees only their own. */
marketplaceRoutes.get('/requests/:id/offers', requireAuth, async (c) => {
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const [req, mine] = await Promise.all([
    c.env.DB.prepare('SELECT customer_id, state, revision FROM community_requests WHERE id = ?')
      .bind(requestId)
      .first<{ customer_id: string; state: string; revision: number }>(),
    storeForUser(c.env.DB, user.id),
  ]);
  // A draft does not exist for anyone but its customer — not even as an
  // empty offer list that confirms the id (W5-A: draft invisibility).
  if (!req || (req.state === 'draft' && req.customer_id !== user.id)) throw notFound('Request not found');

  const isCustomer = req.customer_id === user.id;
  const scope = [requestId, isCustomer ? 1 : 0, mine?.merchant.id ?? ''] as const;

  /**
   * ONE WAVE for everything the caller may see (review 2026-09-30): the
   * offers, every revision of them, their files and the merchant's own draft
   * are read side by side — the files by the same visibility rule as the
   * offers, in SQL, rather than keyed on the offer rows read first. The
   * badges follow, being keyed on the merchants those rows name.
   */
  // A merchant must not be able to read a competitor's price on the same job.
  const offersRead = c.env.DB.prepare(
    `SELECT o.*, m.user_id AS m_user_id, m.name AS m_name, m.verified AS m_verified, m.badge AS m_badge,
            m.badge_override AS m_badge_override, m.rating_avg_x100 AS m_rating,
            m.rating_count AS m_rating_count, m.completed_orders AS m_completed,
            s.slug AS s_slug, r.revision AS r_revision, r.community_order_id AS r_order_id,
            r.accepted_offer_id AS r_accepted_offer_id, vm.eligible AS vm_eligible
       FROM community_offers o
       JOIN community_requests r ON r.id = o.request_id
       JOIN community_merchants m ON m.id = o.merchant_id
       LEFT JOIN merchant_stores s ON s.id = o.store_id
       LEFT JOIN community_request_matches vm
              ON vm.request_id = r.id AND vm.merchant_id = o.merchant_id AND vm.revision = r.revision
      WHERE o.request_id = ?
        AND (? = 1 OR o.merchant_id = ?)
      ORDER BY o.created_at ASC`
  ).bind(...scope).all();

  /**
   * EVERY VERSION OF EVERY OFFER THIS CALLER MAY SEE (0130). An edit is a new
   * revision the customer sees as such — «كان ٥٠٬٠٠٠» — and the merchant sees
   * their own trail. Same visibility rule as the offers themselves, in SQL.
   */
  const revsRead = c.env.DB.prepare(
    `SELECT v.offer_id, v.revision, v.request_revision, v.price_iqd, v.terms, v.reason, v.created_at
       FROM community_offer_revisions v
      WHERE v.offer_id IN (SELECT o.id FROM community_offers o
                            WHERE o.request_id = ? AND (? = 1 OR o.merchant_id = ?))
      ORDER BY v.offer_id, v.revision`
  ).bind(...scope).all<Record<string, unknown>>();
  const [{ results }, { results: revs }, files, myDraft] = await Promise.all([
    offersRead,
    revsRead,
    offerFilesInScope(c.env.DB, ...scope),
    !isCustomer && mine ? draftOnRequest(c.env.DB, requestId, mine.merchant.id) : Promise.resolve(null),
  ]);
  const history = new Map<string, Array<Record<string, unknown>>>();
  for (const v of revs ?? []) {
    const terms = safeParse<Record<string, unknown>>(v.terms, {});
    const list = history.get(String(v.offer_id)) ?? [];
    list.push({
      revision: Number(v.revision),
      request_revision: Number(v.request_revision ?? 1),
      price_iqd: Number(v.price_iqd),
      completion_days: terms.completion_days ?? null,
      delivery_method: terms.delivery_method ?? '',
      reason: String(v.reason ?? ''),
      created_at: String(v.created_at ?? ''),
    });
    history.set(String(v.offer_id), list);
  }

  // OFFERS V2 (0159): each offer's files as URLs — keys only to their uploader
  // (the merchant reading their own offers) — and the merchant's own saved
  // draft on this request, which a customer never sees (`draft: null`).
  const badges = await membershipBadges(c.env.DB, results.map((row) => row.m_user_id));
  return c.json({
    success: true,
    draft: myDraft ? draftShape(myDraft, { revision: req.revision }) : null,
    offers: results.map((row) => ({
      ...offerShape(row, badges),
      files: (files.get(String(row.id)) ?? []).map((f) => offerFilePublic(f, String(row.id), { keys: !isCustomer })),
      history: history.get(String(row.id)) ?? [],
      // The order this offer became — only the winning offer, only to its two parties.
      order_id: row.state === 'accepted' && row.r_accepted_offer_id === row.id ? (row.r_order_id ?? null) : null,
      /**
       * THE WORKSHOP CAN NO LONGER MAKE THIS JOB (review F2): the stored
       * verdict for the request's CURRENT revision says ineligible — its
       * printer went, or the job moved past it. Only on an open offer; the
       * customer's card says «هذه الورشة لم تعد قادرة على تنفيذ الطلب» and
       * acceptance refuses `OFFER_NOT_ELIGIBLE`. No reasons: those are between
       * the workshop and Levonis.
       */
      workshop_unable: row.state === 'pending' && row.vm_eligible !== null && row.vm_eligible !== undefined && Number(row.vm_eligible) === 0,
    })),
    is_customer: isCustomer,
  });
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

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // «احفظ مسودة» (0159): a draft may be saved without a price; a sent offer may not.
  const asDraft = body.draft === true;
  const t = await readOfferTerms(c.env.DB, body, ts, { partial: asDraft });
  const x = readOfferExtras(body, { partial: asDraft });
  // Nothing is stored yet: every fee here is one the body named.
  pickupFeeRule(t.delivery_method, x.delivery_fee_iqd, true);
  const files = (await readOfferFiles(c.env.DB, body, user.id, requestId)) ?? [];
  /**
   * ELIGIBILITY IS THE PERMISSION (W5-B; audit 03 §9 G7). A plan used to be
   * enough to bid on anything; now the workshop must be able to make THIS job
   * — printers, stock, delivery reach, preferences — by the one verdict the
   * board and the notifications read (worker/lib/eligibility.ts). Refused with
   * `403 OFFER_NOT_ELIGIBLE` and the reasons; the INSERT below fences on the
   * verdict row this call just wrote, so a revision landing in between cannot
   * slip an offer onto a job it was not judged against. A DRAFT asks the same
   * bar: saving one opens the upload door for its files (purpose `offer`), and
   * that door is a workshop's that may quote the job.
   */
  await assertMayOffer(c.env, requestId, ctx.merchant.id);
  // «استخدم هذا كعرضي» (costing v2): the private quote this offer came from.
  const quoteId = str(body.quote_id, 'quote_id', { max: 60, required: false }) || '';

  if (asDraft) {
    // A draft beside a live offer would only be a second promise waiting to
    // collide with the first (OFFER_EXISTS on send); refused now, with the
    // same answer.
    const live = await c.env.DB.prepare(
      `SELECT id FROM community_offers WHERE request_id = ? AND merchant_id = ? AND state IN ('pending','superseded','accepted') LIMIT 1`
    ).bind(requestId, ctx.merchant.id).first();
    if (live) throw conflict('You already have an active offer on this request', 'OFFER_EXISTS');
    const payload: DraftPayload = { ...t, ...x, store_id: ctx.store.id, quote_id: quoteId || undefined, valid_days: readValidDays(body) ?? null };
    const draftId = newId('ofd');
    try {
      await c.env.DB.prepare(
        `INSERT INTO community_offer_drafts (id, request_id, merchant_id, payload_json, files_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(draftId, requestId, ctx.merchant.id, JSON.stringify(payload), JSON.stringify(files), ts, ts).run();
    } catch (e) {
      // UNIQUE (request_id, merchant_id): one draft per job — edit it (PATCH /offers/:draftId).
      if (!(isConstraintAbort(e) && /UNIQUE/i.test(e instanceof Error ? e.message : String(e)))) throw e;
      const existing = await draftOnRequest(c.env.DB, requestId, ctx.merchant.id);
      throw new HttpError(409, 'You already have a saved draft on this request — edit it instead', 'OFFER_DRAFT_EXISTS', { draft_id: existing?.id ?? null });
    }
    await audit(c.env.DB, user.id, 'community.offer_draft_saved', draftId, { request: requestId });
    const saved = await loadDraft(c.env.DB, draftId, ctx.merchant.id);
    // No notice and no count: the customer does not know a draft exists.
    return c.json({ success: true, offer: draftShape(saved!, { revision: req.revision }) }, 201);
  }

  const id = newId('off');
  let inserted = 0;
  try {
    const res = await c.env.DB.batch([
      // The offer is written ONLY while the request is still on the board —
      // re-checked here, in the write, not just above (audit 03 §10 P). It
      // prices the job's CURRENT revision. Its files land in the same batch,
      // fenced on the offer row.
      ...insertOfferStatements(c.env.DB, {
        id, requestId, merchantId: ctx.merchant.id, storeId: ctx.store.id, customerId: user.id, terms: t, extras: x, ts,
      }),
      ...offerFileStatements(c.env.DB, id, files, ts, null),
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
    // The request left the board between the read above and the write — or
    // it was revised, and the verdict the fence read is for the old revision.
    const still = await c.env.DB.prepare(
      `SELECT 1 AS x FROM community_requests WHERE id = ? AND state IN ('open','receiving_offers')`
    ).bind(requestId).first();
    if (still) throw conflict('The request changed while you were offering — check it and try again', 'REQUEST_CHANGED');
    throw conflict('This request is no longer accepting offers', 'REQUEST_NOT_OPEN');
  }
  if (quoteId) {
    // The quote is now an offer. Only this merchant's own draft quote OF THIS
    // request moves; its price stayed private until this offer was sent.
    await c.env.DB.prepare(
      `UPDATE print_quotes SET state = 'offered', updated_at = ?
        WHERE id = ? AND merchant_id = ? AND request_id = ? AND state = 'draft'`
    ).bind(ts, quoteId, ctx.merchant.id, requestId).run();
  }

  await audit(c.env.DB, user.id, 'community.offer_created', id, {
    request: requestId, price: t.price_iqd, fee: x.delivery_fee_iqd ?? 0, files: files.length, quote: quoteId || null,
  });
  /**
   * THE CUSTOMER WHOSE REQUEST THIS IS HEARS THAT AN OFFER ARRIVED — outside
   * the batch: a failed notification must never roll back a merchant's bid;
   * `notifyOfferReceived` cannot throw, and its replay protection is per offer.
   */
  try {
    c.executionCtx.waitUntil(notifyOfferReceived(c.env, id));
  } catch {
    // No ExecutionContext on this path. Already in flight, cannot reject.
    void notifyOfferReceived(c.env, id);
  }
  const row = await c.env.DB.prepare('SELECT * FROM community_offers WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, offer: withFiles([row!], await offerFilesFor(c.env.DB, [id]), true)[0] }, 201);
});

/**
 * «تعذّر» or a success — the one answer for the four merchant writes below
 * when their conditional UPDATE matched nothing, or a re-opened offer hit the
 * one-live-offer index.
 */
function offerWriteConflict(e: unknown): HttpError | null {
  if (isConstraintAbort(e) && /UNIQUE/i.test(e instanceof Error ? e.message : String(e))) {
    return conflict('You already have an active offer on this request', 'OFFER_EXISTS');
  }
  return null;
}

/** Withdraw an offer — pending, or superseded by a change to the job. */
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
        WHERE id = ? AND merchant_id = ? AND state IN ('pending','superseded')`
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
 * «عرض محدَّث» — the customer hears that an offer they may be comparing
 * changed, keyed per offer AND revision. The figure is the TOTAL — price plus
 * delivery fee, what acceptance funds (DECISIONS 178 (١), §4e) — with the fee
 * named when there is one: a fee-only edit changes what the customer pays,
 * and «the price is now X» would quote the one number that did not move
 * (review 2026-09-30). The meta carries the three figures, and the Sorani.
 */
function offerUpdatedNotice(
  db: D1Database,
  p: { customerId: string; requestId: string; offerId: string; revision: number; priceIqd: number; feeIqd: number; totalIqd: number }
): D1PreparedStatement {
  const n = (v: number) => v.toLocaleString('en-US');
  const fee = p.feeIqd > 0;
  return notifyStatement(db, {
    userId: p.customerId,
    kind: 'offer_received',
    title_ar: 'عدّل تاجر عرضه على طلبك',
    title_en: 'A merchant updated their offer',
    body_ar: `الإجمالي الآن ${n(p.totalIqd)} د.ع${fee ? ` (منها ${n(p.feeIqd)} توصيل)` : ''}. راجع العرض قبل القبول.`,
    body_en: `The total is now ${n(p.totalIqd)} IQD${fee ? ` (${n(p.feeIqd)} of it delivery)` : ''}. Review the offer before accepting.`,
    link: `/requests/${encodeURIComponent(p.requestId)}`,
    entity_type: 'offer',
    entity_id: p.offerId,
    meta: {
      request_id: p.requestId,
      revision: p.revision,
      price_iqd: p.priceIqd,
      delivery_fee_iqd: p.feeIqd,
      total_iqd: p.totalIqd,
      title_ckb: 'بازرگانێک ئۆفەرەکەی سەر داواکاریەکەتی دەستکاری کرد',
      body_ckb: `کۆی گشتی ئێستا ${n(p.totalIqd)} د.ع${fee ? ` (${n(p.feeIqd)}ی بۆ گەیاندنە)` : ''}. پێش قبوڵکردن سەیری ئۆفەرەکە بکە.`,
    },
    eventKey: `offer_updated:${p.offerId}:${p.revision}`,
  }).stmt;
}

/**
 * Edit an offer — pending or superseded only. After acceptance it is the
 * contract (§26).
 *
 * AN EDIT IS A NEW VERSION (audit 03 §10 B; 0130). Every edit writes
 * `revision + 1` and appends the terms to `community_offer_revisions`; the
 * customer's acceptance names the revision and price they confirmed, and an
 * older one is refused with the fresh offer (`OFFER_CHANGED`). The edit also
 * prices the job AS IT STANDS, so it re-opens an offer the customer's own
 * change superseded. What it replaced is on the audit record, and the
 * customer is told.
 */
marketplaceRoutes.patch('/offers/:id', requireCommunityOpen, requireAuth, async (c) => {
  // An edit re-prices and re-confirms: a new promise (audit 03 V).
  const ctx = await requireOfferPrivileges(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ts = nowIso();
  const t = await readOfferTerms(c.env.DB, body, ts, { partial: true });
  // Offers V2 (0159): the fee, quantity, colour, terms and the file set.
  const x = readOfferExtras(body, { partial: true });
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (t.price_iqd !== undefined) put('price_iqd', t.price_iqd);
  if (t.completion_days !== undefined) put('completion_days', t.completion_days);
  if (t.delivery_method !== undefined) put('delivery_method', t.delivery_method);
  if (t.message !== undefined) put('message', t.message);
  if (t.materials !== undefined) put('materials', t.materials);
  if (t.included !== undefined) put('included', t.included);
  if (t.warranty_terms !== undefined) put('warranty_terms', t.warranty_terms);
  if (t.material_ids !== undefined) put('material_ids', JSON.stringify(t.material_ids));
  if (t.expires_at !== undefined) put('expires_at', t.expires_at);
  if (x.delivery_fee_iqd !== undefined) put('delivery_fee_iqd', x.delivery_fee_iqd);
  if (x.quantity !== undefined) put('quantity', x.quantity);
  if (x.color !== undefined) put('color', x.color);
  if (x.terms !== undefined) put('terms', x.terms);
  if (!sets.length && body.files === undefined) throw badRequest('Nothing to update');
  // A fee the body names is checked against the method it ends up with (the
  // body's, else the stored one) below, once the stored row is known.
  const feeNamed = x.delivery_fee_iqd !== undefined;

  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const before = await c.env.DB.prepare(
    `SELECT o.price_iqd, o.completion_days, o.delivery_method, o.delivery_fee_iqd, o.message, o.materials, o.included,
            o.warranty_terms, o.revision, o.state, o.request_id, r.customer_id
       FROM community_offers o JOIN community_requests r ON r.id = o.request_id
      WHERE o.id = ? AND o.merchant_id = ?`
  ).bind(offerId, ctx.merchant.id).first<Record<string, unknown>>();
  if (!before) {
    /**
     * A DRAFT (0159) is edited by the same door, in place: no revision, no
     * notice, nobody but its author knows it exists. The payload is merged
     * field by field; a named file list replaces the old one.
     */
    const draft = await loadDraft(c.env.DB, offerId, ctx.merchant.id);
    if (!draft) throw notFound('Offer not found');
    const files = await readOfferFiles(c.env.DB, body, c.get('user')!.id, draft.request_id);
    const payload: DraftPayload = { ...safeParse<DraftPayload>(draft.payload_json, {}), ...t, ...x };
    if (pickupFeeRule(payload.delivery_method, payload.delivery_fee_iqd, feeNamed) === 'zero') payload.delivery_fee_iqd = 0;
    const validDays = readValidDays(body);
    if (validDays !== undefined) payload.valid_days = validDays;
    const keptFiles = safeParse<OfferFileInput[]>(draft.files_json, []);
    await c.env.DB.prepare(
      'UPDATE community_offer_drafts SET payload_json = ?, files_json = ?, updated_at = ? WHERE id = ? AND merchant_id = ?'
    ).bind(JSON.stringify(payload), JSON.stringify(files ?? (Array.isArray(keptFiles) ? keptFiles : [])), ts, offerId, ctx.merchant.id).run();
    await audit(c.env.DB, c.get('user')!.id, 'community.offer_draft_saved', offerId, { request: draft.request_id });
    const saved = await loadDraft(c.env.DB, offerId, ctx.merchant.id);
    return c.json({ success: true, offer: draftShape(saved!) });
  }
  const files = await readOfferFiles(c.env.DB, body, c.get('user')!.id, String(before.request_id));
  // Switching a delivered offer to pickup leaves no fee behind it.
  if (pickupFeeRule(t.delivery_method ?? before.delivery_method, x.delivery_fee_iqd ?? before.delivery_fee_iqd, feeNamed) === 'zero') {
    put('delivery_fee_iqd', 0);
  }
  // An edit prices the job AS IT NOW IS: a new promise, so the same bar as a
  // new offer (W5-B) — a workshop the revised job no longer fits cannot re-price it.
  if (before.state === 'pending' || before.state === 'superseded') {
    // A DIRECT request's store quotes it without matching (0151).
    await assertMayQuote(c.env, String(before.request_id), ctx.merchant.id);
  }

  // `state IN (pending, superseded)` is in the WHERE clause, so an accepted
  // offer cannot be edited even by a request that tries; and only while its
  // request is still on the board.
  let changes = 0;
  try {
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE community_offers
            SET ${sets.length ? `${sets.join(', ')}, ` : ''}state = 'pending', revision = revision + 1,
                request_revision = (SELECT r.revision FROM community_requests r WHERE r.id = community_offers.request_id),
                updated_at = ?
          WHERE id = ? AND merchant_id = ? AND state IN ('pending','superseded')
            AND EXISTS (SELECT 1 FROM community_requests r
                         WHERE r.id = community_offers.request_id AND r.state IN ('open','receiving_offers')
                           AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?))`
      ).bind(...vals, ts, offerId, ctx.merchant.id, ts),
      recordOfferRevisionStatement(c.env.DB, offerId, 'edit'),
      offerCountStatement(c.env.DB, String(before.request_id)),
      // A new file set rides the same edit, fenced on the edit having landed.
      ...(files ? offerFileStatements(c.env.DB, offerId, files, ts, ts) : []),
    ]);
    changes = Number(res[0]?.meta.changes ?? 0);
  } catch (e) {
    throw offerWriteConflict(e) ?? e;
  }
  if (!changes) throw conflict('That offer can no longer be changed', 'OFFER_NOT_AVAILABLE');

  const row = await c.env.DB.prepare('SELECT * FROM community_offers WHERE id = ?').bind(offerId).first<Record<string, unknown>>();
  await audit(c.env.DB, c.get('user')!.id, 'community.offer_edited', offerId, {
    before,
    after: {
      price_iqd: row?.price_iqd, completion_days: row?.completion_days, delivery_method: row?.delivery_method,
      warranty_terms: row?.warranty_terms, revision: row?.revision, expires_at: row?.expires_at,
    },
  });
  await c.env.DB.batch([
    offerUpdatedNotice(c.env.DB, {
      customerId: String(before.customer_id),
      requestId: String(before.request_id),
      offerId,
      revision: Number(row?.revision ?? 1),
      priceIqd: Number(row?.price_iqd ?? 0),
      feeIqd: row ? offerFee(row) : 0,
      totalIqd: row ? offerTotal(row) : 0,
    }),
  ]).catch((e) => console.error('offer-updated notice not written', offerId, e instanceof Error ? e.message : String(e)));
  return c.json({ success: true, offer: withFiles([row!], await offerFilesFor(c.env.DB, [offerId]), true)[0] });
});

/**
 * «أرسل العرض» — a saved draft becomes a live offer (0159, §9.5). The payload
 * is validated again AS A WHOLE (a draft may have been saved without a
 * price), the validity recomputed from `valid_days` as of NOW, the file keys
 * re-checked as the author's own, the eligibility asked again
 * (`assertMayOffer`), and the offer written through the same fenced INSERT a
 * new offer uses — in ONE batch with its files and the draft's deletion, so a
 * draft never both stays and becomes an offer. Refused OFFER_REQUEST_CLOSED
 * when the request no longer takes offers (the draft stays); OFFER_NOT_DRAFT
 * for an id that is already a sent offer.
 */
marketplaceRoutes.post('/offers/:id/send', requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'offer-create', 30, 3600);
  const user = c.get('user')!;
  const ctx = await requireOfferPrivileges(c);
  const tier = await getTierStatus(c.env.DB, user.id);
  if (!benefits.communityOffers(tier)) throw forbidden('Your plan does not include community offers');
  const draftId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const draft = await loadDraft(c.env.DB, draftId, ctx.merchant.id);
  if (!draft) {
    const sent = await c.env.DB.prepare('SELECT id FROM community_offers WHERE id = ? AND merchant_id = ?').bind(draftId, ctx.merchant.id).first();
    if (sent) throw conflict('This offer was already sent — it is not a draft', 'OFFER_NOT_DRAFT');
    throw notFound('Offer not found');
  }
  const requestId = draft.request_id;
  const req = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ?').bind(requestId).first<Record<string, unknown>>();
  const ts = nowIso();
  if (
    !req || req.state === 'draft' || req.visibility !== 'public' ||
    !REQUEST_OPEN_STATES.includes(String(req.state) as RequestState) || isPast(req.expires_at as string | null, ts)
  ) {
    throw conflict('This request no longer takes offers — your draft was kept', 'OFFER_REQUEST_CLOSED');
  }
  if (req.customer_id === user.id) throw badRequest('You cannot bid on your own request', 'OWN_REQUEST');

  const payload = safeParse<DraftPayload>(draft.payload_json, {});
  // The validity runs from the SEND, not from the day the draft was saved.
  const source: Record<string, unknown> = { ...payload };
  if (payload.valid_days) delete source.expires_at;
  else delete source.valid_days;
  const t = await readOfferTerms(c.env.DB, source, ts, { partial: false });
  const x = readOfferExtras(source, { partial: false });
  // A saved draft cannot hold a fee beside a pickup (the save refuses or
  // zeroes it); a payload from before that rule is refused here, draft kept.
  pickupFeeRule(t.delivery_method, x.delivery_fee_iqd, true);
  const draftFiles = safeParse<OfferFileInput[]>(draft.files_json, []);
  const files = (await readOfferFiles(c.env.DB, { files: Array.isArray(draftFiles) ? draftFiles : [] }, user.id, requestId)) ?? [];
  await assertMayOffer(c.env, requestId, ctx.merchant.id);
  const quoteId = typeof payload.quote_id === 'string' ? payload.quote_id : '';

  const id = newId('off');
  let inserted = 0;
  try {
    const res = await c.env.DB.batch([
      ...insertOfferStatements(c.env.DB, {
        id, requestId, merchantId: ctx.merchant.id, storeId: ctx.store.id, customerId: user.id, terms: t, extras: x, ts,
      }),
      ...offerFileStatements(c.env.DB, id, files, ts, null),
      // The draft goes only if the offer landed — else it stays, to be sent again.
      c.env.DB.prepare('DELETE FROM community_offer_drafts WHERE id = ? AND EXISTS (SELECT 1 FROM community_offers WHERE id = ?)').bind(draftId, id),
    ]);
    inserted = Number(res[0]?.meta.changes ?? 0);
  } catch (e) {
    throw offerWriteConflict(e) ?? e;
  }
  if (!inserted) {
    const still = await c.env.DB.prepare(
      `SELECT 1 AS x FROM community_requests WHERE id = ? AND state IN ('open','receiving_offers')`
    ).bind(requestId).first();
    if (still) throw conflict('The request changed while you were sending — check it and try again', 'REQUEST_CHANGED');
    throw conflict('This request no longer takes offers — your draft was kept', 'OFFER_REQUEST_CLOSED');
  }
  if (quoteId) {
    await c.env.DB.prepare(
      `UPDATE print_quotes SET state = 'offered', updated_at = ?
        WHERE id = ? AND merchant_id = ? AND request_id = ? AND state = 'draft'`
    ).bind(ts, quoteId, ctx.merchant.id, requestId).run();
  }
  await audit(c.env.DB, user.id, 'community.offer_sent', id, {
    request: requestId, draft: draftId, price: t.price_iqd, fee: x.delivery_fee_iqd ?? 0, files: files.length, quote: quoteId || null,
  });
  // The customer hears now — a draft told nobody (outside the batch, cannot throw).
  try {
    c.executionCtx.waitUntil(notifyOfferReceived(c.env, id));
  } catch {
    void notifyOfferReceived(c.env, id);
  }
  const row = await c.env.DB.prepare('SELECT * FROM community_offers WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, offer: withFiles([row!], await offerFilesFor(c.env.DB, [id]), true)[0] }, 201);
});

/**
 * Stream one offer file to a party of the offer — the request's customer, the
 * offer's merchant, or an admin — after re-deriving that right on every read.
 * Anyone else, a rival workshop included, is told the file does not exist.
 * Never a key, never a public URL (§9.5): the object sits under a private
 * prefix `/files/*` refuses, and this route is the only door.
 */
marketplaceRoutes.get('/offers/:id/files/:fileId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const fileId = str(c.req.param('fileId'), 'fileId', { min: 1, max: 60 });
  const row = await c.env.DB.prepare(
    `SELECT f.file_key, f.name, f.kind, f.content_type, r.customer_id, m.user_id AS merchant_user_id
       FROM community_offer_files f
       JOIN community_offers o ON o.id = f.offer_id
       JOIN community_requests r ON r.id = o.request_id
       JOIN community_merchants m ON m.id = o.merchant_id
      WHERE f.id = ? AND f.offer_id = ?`
  ).bind(fileId, offerId).first<{ file_key: string; name: string; kind: string; content_type: string; customer_id: string; merchant_user_id: string }>()
    .catch((e) => {
      if (isSchemaMissing(e)) return null;
      throw e;
    });
  if (!row) throw notFound('File not found');
  const party = user.id === row.customer_id || user.id === row.merchant_user_id || user.role === 'admin';
  if (!party) throw notFound('File not found');
  const obj = await getMediaObject(c.env, 'private', row.file_key);
  if (!obj) throw notFound('File not found');
  // A picture may render in place; a PDF or a model is handed over as a
  // download. Sandboxed with `nosniff` either way, and a stored page can never
  // render (an HTML type is downgraded to bytes).
  const mime = row.content_type && !/^text\/html/i.test(row.content_type) ? row.content_type : 'application/octet-stream';
  const inline = mime.startsWith('image/');
  const safe = safeFileName(row.name, row.kind === 'pdf' ? 'pdf' : 'bin');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
});

/**
 * «أؤكد عرضي» — the merchant stands by their offer for the job AS IT NOW IS.
 *
 * The customer changed a published request after this offer priced it, so
 * the offer was superseded and cannot be accepted (audit 03 §10 K, W5-A).
 * Re-confirming writes the request's current revision onto it and a new offer
 * revision, and makes it pending again — the customer is then accepting a
 * promise made against the job they see. To change the terms instead, the
 * merchant edits (PATCH) or withdraws.
 */
marketplaceRoutes.post('/offers/:id/reconfirm', requireCommunityOpen, requireAuth, async (c) => {
  const ctx = await requireOfferPrivileges(c);
  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const ts = nowIso();
  // Standing by an offer for the job as it NOW is — only if the workshop can
  // still make it (W5-B). A revision that outgrew the printer is not re-confirmable.
  const standing = await c.env.DB.prepare(
    `SELECT request_id FROM community_offers WHERE id = ? AND merchant_id = ? AND state IN ('pending','superseded')`
  ).bind(offerId, ctx.merchant.id).first<{ request_id: string }>();
  if (standing) await assertMayQuote(c.env, standing.request_id, ctx.merchant.id);
  let changes = 0;
  try {
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE community_offers
            SET state = 'pending', revision = revision + 1,
                request_revision = (SELECT r.revision FROM community_requests r WHERE r.id = community_offers.request_id),
                updated_at = ?1
          WHERE id = ?2 AND merchant_id = ?3 AND state IN ('pending','superseded')
            AND request_revision < (SELECT r.revision FROM community_requests r WHERE r.id = community_offers.request_id)
            AND EXISTS (SELECT 1 FROM community_requests r
                         WHERE r.id = community_offers.request_id AND r.state IN ('open','receiving_offers')
                           AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?1))`
      ).bind(ts, offerId, ctx.merchant.id),
      recordOfferRevisionStatement(c.env.DB, offerId, 'reconfirm'),
      c.env.DB.prepare(
        `UPDATE community_requests
            SET offer_count = (SELECT COUNT(*) FROM community_offers o
                                WHERE o.request_id = community_requests.id AND o.state IN ('pending','accepted'))
          WHERE id = (SELECT request_id FROM community_offers WHERE id = ?)`
      ).bind(offerId),
    ]);
    changes = Number(res[0]?.meta.changes ?? 0);
  } catch (e) {
    throw offerWriteConflict(e) ?? e;
  }
  if (!changes) {
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

/**
 * «لا، شكرًا» — the CUSTOMER declines one offer (W5-A). Only a pending or
 * superseded offer on their own request while it takes offers; the merchant
 * is told (`offer_rejected`) and the slot is free for a better offer. Outside
 * the community wall, like acceptance: it answers trade already in flight.
 */
marketplaceRoutes.post('/offers/:id/decline', requireAuth, async (c) => {
  const user = c.get('user')!;
  const offerId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const offer = await c.env.DB.prepare(
    `SELECT o.request_id FROM community_offers o JOIN community_requests r ON r.id = o.request_id
      WHERE o.id = ? AND r.customer_id = ?`
  ).bind(offerId, user.id).first<{ request_id: string }>();
  if (!offer) throw notFound('Offer not found');
  const ts = nowIso();
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_offers SET state = 'rejected', updated_at = ?1
        WHERE id = ?2 AND state IN ('pending','superseded')
          AND EXISTS (SELECT 1 FROM community_requests r
                       WHERE r.id = community_offers.request_id AND r.customer_id = ?3
                         AND r.state IN ('open','receiving_offers'))`
    ).bind(ts, offerId, user.id),
    offerCountStatement(c.env.DB, offer.request_id),
  ]);
  if (!res[0]?.meta.changes) throw conflict('That offer can no longer be declined', 'OFFER_NOT_AVAILABLE');
  await audit(c.env.DB, user.id, 'community.offer_declined', offerId, { request: offer.request_id });
  await notifyOffersRejected(c.env.DB, offer.request_id, ts, 'declined');
  return c.json({ success: true });
});

/**
 * THE MERCHANT'S OWN OFFERS, across requests — the workspace's «عروضي» list
 * (W5-A). Scoped in SQL to the caller's merchant; newest change first, cursor
 * `updated_at|id`. Each row carries what the list needs to say what to do:
 * superseded (re-confirm or edit), expired, accepted (the order), rejected.
 */
marketplaceRoutes.get('/my-offers', requireAuth, async (c) => {
  const user = c.get('user')!;
  const mine = await storeForUser(c.env.DB, user.id);
  if (!mine) return c.json({ success: true, offers: [], next_cursor: null });
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  const cursor = str(c.req.query('cursor') ?? '', 'cursor', { min: 0, max: 120, required: false });
  const [cAt, cId] = cursor.includes('|') ? cursor.split('|') : ['', ''];
  const state = c.req.query('state') ?? '';
  // DRAFTS (0159) ride the FIRST page, flagged `draft: true` and `state:
  // 'draft'` — one per request, never many; `state=draft` lists only them.
  const onlyDrafts = state === 'draft';
  // ONE WAVE after the store (review 2026-09-30): the drafts, the page and the
  // page's files start together — the files by the page's own WHERE/ORDER/LIMIT
  // as a subquery, not keyed on ids the page has yet to return.
  const draftsRead = cAt === '' && (state === '' || onlyDrafts) ? merchantDrafts(c.env.DB, mine.merchant.id) : Promise.resolve([]);
  const pageBinds = [mine.merchant.id, ['pending', 'superseded', 'accepted', 'rejected', 'withdrawn', 'expired'].includes(state) ? state : '', cAt, cId, limit] as const;
  const PAGE_WHERE = `o.merchant_id = ?1
            AND (?2 = '' OR o.state = ?2)
            AND (?3 = '' OR o.updated_at < ?3 OR (o.updated_at = ?3 AND o.id < ?4))
          ORDER BY o.updated_at DESC, o.id DESC LIMIT ?5`;
  const [{ results }, drafts, files] = await Promise.all([
    onlyDrafts
      ? Promise.resolve({ results: [] as Record<string, unknown>[] })
      : c.env.DB.prepare(
          `SELECT o.*, r.title AS request_title, r.state AS request_state, r.revision AS r_revision,
                  r.expires_at AS request_expires_at, r.community_order_id AS order_id_for_request,
                  r.accepted_offer_id AS request_accepted_offer_id
             FROM community_offers o
             JOIN community_requests r ON r.id = o.request_id
            WHERE ${PAGE_WHERE}`
        ).bind(...pageBinds).all<Record<string, unknown>>(),
    draftsRead,
    onlyDrafts ? Promise.resolve(new Map<string, Array<Record<string, unknown>>>()) : offerFilesWhere(c.env.DB, `SELECT o.id FROM community_offers o WHERE ${PAGE_WHERE}`, pageBinds),
  ]);
  const last = results.length === limit ? results[results.length - 1] : null;
  const requestOf = (row: Record<string, unknown>) => ({
    id: row.request_id,
    title: row.request_title,
    state: row.request_state,
    revision: Number(row.r_revision ?? 1),
    expires_at: row.request_expires_at ?? null,
  });
  return c.json({
    success: true,
    offers: [
      ...drafts.map((d) => ({ ...draftShape(d, { revision: d.r_revision }), request: requestOf(d), order_id: null })),
      ...results.map((row) => ({
        ...offerShape(row),
        // The merchant is the uploader: the keys come back so an edit can keep them.
        files: (files.get(String(row.id)) ?? []).map((f) => offerFilePublic(f, String(row.id), { keys: true })),
        request: requestOf(row),
        // The job this offer became, once it won.
        order_id: row.state === 'accepted' && row.request_accepted_offer_id === row.id ? (row.order_id_for_request ?? null) : null,
      })),
    ],
    next_cursor: last ? `${String(last.updated_at)}|${String(last.id)}` : null,
  });
});

// ------------------------------------------------------------- acceptance

/**
 * WHERE THE MERCHANT BEHIND THIS OFFER STANDS NOW: taking new work at all
 * (review S2), and — for a pending offer — still ABLE to make this job as it
 * stands (review F2). An offer made while the workshop could make the job
 * outlives the printer that qualified it: a printer deleted, set offline, or
 * the request revised past what it can do. The customer must not fund a job
 * the workshop can no longer make, so acceptance asks the LIVE verdict
 * (`liveVerdict`, which also writes it back to the verdict row the offers list
 * reads) before any money is reserved.
 */
type OfferStanding = 'ok' | 'unavailable' | 'ineligible';
async function offerMerchantStanding(env: Env, offer: Record<string, unknown>): Promise<OfferStanding> {
  const takesWork = await merchantTakesNewWork(env.DB, {
    merchantStatus: offer.m_status,
    storeStatus: offer.s_status,
    ownerUserId: String(offer.m_user_id ?? ''),
  });
  if (!takesWork) return 'unavailable';
  if (offer.state !== 'pending') return 'ok';
  // A DIRECT request (0151) was addressed to this store by the customer: there
  // is no printer matching to ask — the store taking new work is the whole bar.
  if (offer.r_visibility === 'direct') return 'ok';
  const live = await liveVerdict(env, String(offer.req_id ?? offer.request_id), String(offer.merchant_id));
  return live && !live.verdict.eligible ? 'ineligible' : 'ok';
}

/** The offer, its request and its merchant — everything acceptance decides on. */
async function offerForAcceptance(db: D1Database, offerId: string) {
  return db
    .prepare(
      `SELECT o.*, r.customer_id, r.state AS request_state, r.id AS req_id, r.revision AS r_revision,
              r.expires_at AS r_expires_at, r.visibility AS r_visibility, r.title AS r_title,
              r.accepted_offer_id AS r_accepted_offer_id, r.community_order_id AS r_order_id,
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
  expected: { total: number; revision: number },
  now: string,
  standing: OfferStanding
): HttpError | null {
  const fresh = { offer: offerShape(offer) };
  // Superseded by the customer's own change to the job (W5-A): the same
  // answer a stale offer always got — accept it once its merchant re-confirms.
  if (offer.state === 'superseded') {
    return new HttpError(
      409,
      'You changed this request after the merchant made this offer — it can be accepted once they re-confirm it',
      'OFFER_STALE',
      fresh
    );
  }
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
  if (standing === 'unavailable') {
    return conflict('This merchant is not taking new work right now — choose another offer', 'MERCHANT_UNAVAILABLE');
  }
  // The workshop can no longer make this job (review F2): its printer went, or
  // the job moved past it. The customer is told plainly and chooses another.
  if (standing === 'ineligible') {
    return conflict('This workshop can no longer make this request — choose another offer', 'OFFER_NOT_ELIGIBLE');
  }
  if (Number(offer.request_revision ?? 1) < Number(offer.r_revision ?? 1)) {
    return new HttpError(
      409,
      'You changed this request after the merchant made this offer — it can be accepted once they re-confirm it',
      'OFFER_STALE',
      fresh
    );
  }
  // The TOTAL (price + delivery fee, 0159) and the revision the confirmation showed.
  if (expected.total !== offerTotal(offer) || expected.revision !== Number(offer.revision ?? 1)) {
    return new HttpError(409, 'This offer changed since you opened it — review it again', 'OFFER_CHANGED', fresh);
  }
  return null;
}

/** A stored order's request snapshot, its estimate stripped to what the parties may read. */
function publicSnapshot(raw: unknown): Record<string, unknown> {
  const snap = safeParse<Record<string, unknown>>(raw, {}) ?? {};
  return snap.estimate === undefined ? snap : { ...snap, estimate: publicEstimate(JSON.stringify(snap.estimate)) };
}

/**
 * Accept one offer. The single most important transaction in the marketplace.
 *
 * THE CUSTOMER ACCEPTS WHAT THEY SAW (audit 03 §10 B). The body carries the
 * `expected_total_iqd` (price + delivery fee, 0159 — the fee is part of what
 * was agreed) and `offer_revision` the confirmation showed. If the merchant
 * edited the offer since, the answer is `OFFER_CHANGED` with the fresh offer
 * — never a hold at a price nobody confirmed. Missing values are treated
 * exactly like changed ones: the customer is shown the offer and asked again.
 * `expected_price_iqd` is still read for one release, from a client that
 * predates the fee, and only for an offer that HAS no fee. A STALE offer (priced before the customer changed the job) is
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

  const offer = await offerForAcceptance(c.env.DB, offerId);
  if (!offer) throw notFound('Offer not found');
  if (offer.customer_id !== user.id) throw forbidden('This request is not yours');
  // What was agreed is the TOTAL. A price alone is accepted only from an
  // older client and only when the offer carries no fee — with a fee, a price
  // is not what was shown, and is answered OFFER_CHANGED like any mismatch.
  const fee = offerFee(offer);
  const asInt = (v: unknown) => (Number.isSafeInteger(Number(v)) ? Number(v) : NaN);
  const expected = {
    total: body.expected_total_iqd !== undefined ? asInt(body.expected_total_iqd) : fee === 0 ? asInt(body.expected_price_iqd) : NaN,
    revision: asInt(body.offer_revision),
  };

  /**
   * A REPLAY OF AN ACCEPTANCE THAT LANDED (docs/COMMUNITY_COMMERCE_CHAT.md §6.6).
   * A double tap, or a retry after a lost response, used to be answered
   * `409 OFFER_NOT_AVAILABLE` — safe, but it told a customer who HAD accepted
   * that they had not. The same customer accepting the same offer at the same
   * price and revision it was frozen at is answered with the order that
   * acceptance made — never a second hold, never a second order.
   */
  if (
    offer.state === 'accepted' &&
    offer.r_accepted_offer_id === offerId &&
    offer.r_order_id &&
    expected.total === offerTotal(offer) &&
    expected.revision === Number(offer.revision ?? 1)
  ) {
    const placed = await c.env.DB.prepare('SELECT * FROM community_orders WHERE id = ? AND customer_id = ? AND offer_id = ?')
      .bind(String(offer.r_order_id), user.id, offerId)
      .first<Record<string, unknown>>();
    if (placed) {
      const esc = await c.env.DB.prepare('SELECT id FROM community_escrows WHERE community_order_id = ?')
        .bind(String(placed.id))
        .first<{ id: string }>();
      return c.json({ success: true, order: { ...placed, request_snapshot: JSON.stringify(publicSnapshot(placed.request_snapshot)) }, escrow_id: esc?.id ?? null, replayed: true });
    }
  }

  const refusal = acceptanceRefusal(offer, expected, nowIso(), await offerMerchantStanding(c.env, offer));
  if (refusal) throw refusal;

  const requestId = String(offer.req_id);
  // THE CONVERSATION THE DEAL CAME FROM (0151): a direct request's order is
  // written with its thread, and the thread is told once the money is held.
  // Read before the batch, so a database behind 0151 simply has none.
  const direct = offer.r_visibility === 'direct' ? await directRequest(c.env.DB, requestId) : null;
  const originChatId = direct?.origin_chat_id ?? null;
  /**
   * WHAT THE ORDER KEEPS (W5-A, §4.7). The job revision the offer priced —
   * its recorded snapshot, or for a request older than 0130 the job as it
   * stands (the race guard below only lets THIS revision through) — and the
   * contact each side receives now and not before: the customer's delivery
   * details for the merchant (the address they chose in the sheet, or their
   * default; name and phone only for a pickup), the store's contact for the
   * customer. A named address that is not theirs is refused before any money
   * moves.
   */
  const addressId = body.address_id === undefined || body.address_id === null || body.address_id === ''
    ? null
    : str(body.address_id, 'address_id', { min: 1, max: 60 });
  const acceptTs = nowIso();
  const contact = await contactSnapshot(c.env.DB, {
    customerId: user.id,
    merchantId: String(offer.merchant_id),
    storeId: (offer.store_id as string | null) ?? null,
    addressId,
    deliveryMethod: String(offer.delivery_method ?? ''),
    ts: acceptTs,
  });
  if (!contact) throw badRequest('Choose one of your saved addresses', 'ADDRESS_NOT_FOUND');
  const revRow = await c.env.DB.prepare(
    'SELECT revision, spec, files, estimate, hash FROM community_request_revisions WHERE request_id = ? AND revision = ?'
  ).bind(requestId, Number(offer.r_revision ?? 1)).first<Record<string, unknown>>();
  const requestSnapshot = revRow
    ? {
        revision: Number(revRow.revision),
        hash: String(revRow.hash ?? ''),
        spec: safeParse(revRow.spec, {}),
        files: safeParse(revRow.files, []),
        // Never the cost lines, cost, floor or margin (review W2-5 p6): a
        // revision backfilled by 0130 held the RAW estimate.
        estimate: publicEstimate(revRow.estimate),
      }
    : { revision: Number(offer.r_revision ?? 1), ...((await composeSnapshot(c.env.DB, requestId)) ?? {}), source: 'live' };
  const merchantUserId = String(offer.m_user_id);
  /**
   * THE MONEY IS THE TOTAL (0159, §9.5): the price plus the delivery fee is
   * what the customer agreed to and what the escrow holds; the platform's
   * split is taken on that gross, and the order's `price_iqd` — the figure
   * every money identity checks against (`platform_fee + receivable =
   * price_iqd`) — is the same gross. The item price and the fee are kept
   * apart in the snapshot.
   */
  const price = Number(offer.price_iqd);
  const total = price + fee;
  const split = await feeFor(c.env.DB, 'request', total);
  const autoDays = await autoCompleteDays(c.env.DB);
  const orderId = newId('cord');
  const escrowInput: HoldEscrowInput = {
    communityOrderId: orderId,
    customerId: user.id,
    merchantId: String(offer.merchant_id),
    grossIqd: total,
    platformFeeIqd: split.platform_fee_iqd,
    merchantReceivableIqd: split.merchant_receivable_iqd,
    idempotencyKey: `accept:${orderId}`,
  };
  /**
   * THE CONVERSATION OF A BOARD DEAL (0159, §9.5). A request accepted from the
   * board gets the request's thread — the one `POST /api/chats/open
   * {requestId, merchantId}` opens, found or created by the chat door's own
   * helper (one per request × store, 0124's unique index) — and the order is
   * written with it, so «تم إنشاء الطلب» and every later move are told there
   * exactly as a direct request's are. Opened BEFORE the money is reserved: a
   * thread between a customer and a workshop with a live offer is allowed
   * regardless, so a refusal below leaves nothing that should not exist; a
   * thread that could not be opened costs the deal nothing (chat_id stays null).
   */
  let chatId: string | null = originChatId;
  if (!direct && offer.store_id) {
    chatId = await openStoreThread(c.env.DB, {
      contextType: 'request',
      contextId: requestId,
      storeId: String(offer.store_id),
      merchantId: String(offer.merchant_id),
      customerId: user.id,
      sellerId: merchantUserId,
    }).catch((e) => {
      console.error('accept: request thread not opened', requestId, e instanceof Error ? e.message : String(e));
      return null;
    });
  }

  // 1. The money, before anything else. A refusal here has nothing to undo.
  const reserved = await reserveEscrowFunds(c.env.DB, escrowInput);
  if (!reserved.ok) {
    if (reserved.reason === 'INSUFFICIENT_FUNDS') {
      throw badRequest(
        'Your wallet balance does not cover this offer. Top up and try again.',
        'INSUFFICIENT_FUNDS',
        { required_iqd: total }
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
      // The offer is frozen — the exact version the customer confirmed: the
      // revision (every edit, a fee change included, bumps it) and the price
      // the loaded row carried, which the total check above tied to the fee.
      db.prepare(
        `UPDATE community_offers SET state = 'accepted', updated_at = ?1
          WHERE id = ?2 AND request_id = ?3 AND state = 'pending'
            AND revision = ?4 AND price_iqd = ?5 AND request_revision = ?6
            AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?1)`
      ).bind(ts, offerId, requestId, expected.revision, price, Number(offer.r_revision ?? 1)),
      db.prepare(
        `UPDATE community_offers
            SET updated_at = CASE WHEN state = 'accepted' AND updated_at = ?2 THEN updated_at ELSE NULL END
          WHERE id = ?1`
      ).bind(offerId, ts),
      // Every rival is closed in the same breath — superseded ones included.
      db.prepare(
        `UPDATE community_offers SET state = 'rejected', updated_at = ?
          WHERE request_id = ? AND id != ? AND state IN ('pending','superseded')`
      ).bind(ts, requestId, offerId),
      // The order is born FUNDED: its escrow commits in this same batch.
      db.prepare(
        `INSERT INTO community_orders
           (id, request_id, offer_id, customer_id, merchant_id, store_id, state,
            price_iqd, commission_percent_x100, platform_fee_iqd, merchant_receivable_iqd,
            completion_days, delivery_method, offer_snapshot, created_at, updated_at,
            request_revision, request_snapshot, contact_snapshot, chat_id)
         VALUES (?,?,?,?,?,?, 'funded', ?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        orderId, requestId, offerId, user.id, offer.merchant_id, offer.store_id,
        total, split.commission_percent_x100, split.platform_fee_iqd, split.merchant_receivable_iqd,
        offer.completion_days, offer.delivery_method,
        // The snapshot. Everything the merchant promised, frozen at this
        // instant, so editing the offer later cannot change the deal. The
        // item price, the delivery fee and their total are kept apart (0159).
        JSON.stringify({
          price_iqd: price,
          delivery_fee_iqd: fee,
          total_iqd: total,
          quantity: offer.quantity ?? null,
          color: offer.color ?? '',
          terms: offer.terms ?? '',
          completion_days: offer.completion_days,
          delivery_method: offer.delivery_method,
          message: offer.message,
          materials: offer.materials,
          included: offer.included,
          warranty_terms: offer.warranty_terms,
          material_ids: parseIds(offer.material_ids),
          expires_at: offer.expires_at ?? null,
          offer_revision: Number(offer.revision ?? 1),
          request_revision: Number(offer.r_revision ?? 1),
          accepted_at: ts,
        }),
        ts, ts,
        Number(offer.r_revision ?? 1),
        JSON.stringify(requestSnapshot),
        JSON.stringify(contact),
        chatId
      ),
      ...escrowRecordStatements(db, escrowInput, reserved.reservation, escrowId, ts),
      offerCountStatement(db, requestId),
      // A merchant who lost the job loses its preview links with it.
      revokeViewerTokensStatement(db, requestId, ts, [user.id, merchantUserId]),
      // «قبل العميل عرضك» — in the same commit as the acceptance it announces
      // (audit 03 §10 N). INSERT OR IGNORE on a per-offer key: it cannot fail
      // the batch and cannot be sent twice.
      offerAcceptedNotification(db, { merchantUserId, requestId, offerId, orderId, priceIqd: total }),
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
        ? acceptanceRefusal(fresh, expected, nowIso(), await offerMerchantStanding(c.env, fresh))
        : notFound('Offer not found');
      throw why ?? conflict('This request changed while you were accepting — reload it and try again', 'ACCEPT_CONFLICT');
    }
    console.error('accept: the batch committed but reported an error', orderId, e instanceof Error ? e.message : String(e));
  }

  await audit(db, user.id, 'community.offer_accepted', offerId, {
    order: orderId,
    price: total,
    item_price: price,
    delivery_fee: fee,
    offer_revision: expected.revision,
    fee: split.platform_fee_iqd,
    auto_complete_days: autoDays,
  });

  // The merchants who were not chosen are told (W5-A) — after the commit, never inside it.
  await notifyOffersRejected(db, requestId, ts, 'other_accepted');
  // «اختار صاحب الطلب عرضًا» in the request's discussion (0160) — ids only,
  // never a price or a contact line; never throws.
  await writeRequestSystemUpdate(db, requestId, 'accepted', { offer_id: offerId, order_id: orderId });
  // The in-app notice rode in the batch; its outside channels follow, per the merchant's switch (W2-E).
  await fanOutMerchantNotice(c.env, { merchant_id: String(offer.merchant_id), user_id: merchantUserId }, offerAcceptedNotice({ requestId, offerId, orderId, priceIqd: total }));
  const order = await db.prepare('SELECT * FROM community_orders WHERE id = ?').bind(orderId).first<Record<string, unknown>>();
  // «تم إنشاء الطلب» IN THE CONVERSATION IT CAME FROM (D8) — a direct request's
  // origin thread, or the board request's thread opened above (0159) — after
  // the commit, once per order, only into a thread of this store and this
  // customer, and never able to undo the payment (postSystemCard does not throw).
  if (chatId && order) {
    await postSystemCard(c.env, {
      chatId,
      actorId: user.id,
      card: customOrderCard(order, direct?.title ?? String(offer.r_title ?? ''), 'funded'),
      eventKey: `custom_order:${orderId}:funded`,
      expect: { storeId: String(offer.store_id ?? ''), customerId: user.id },
    });
  }
  return c.json({ success: true, order: order ? { ...order, request_snapshot: JSON.stringify(publicSnapshot(order.request_snapshot)) } : null, escrow_id: escrowId }, 201);
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
  const [escrow, autoDays] = await Promise.all([escrowForOrder(c.env.DB, orderId), autoCompleteDays(c.env.DB)]);
  return c.json({
    success: true,
    /**
     * The confirmation window the «سلّمت العمل» dialog names BEFORE delivery
     * stamps `auto_complete_at` (review 2026-09-30): the admin setting, whose
     * default is 7 days and whose 0 turns auto-release off — never a number
     * written into the client's copy.
     */
    auto_complete_days: autoDays,
    order: {
      ...row,
      merchant_user_id: undefined,
      offer_snapshot: safeParse(row.offer_snapshot, {}),
      // The job revision this order was accepted on (0130) — both sides see
      // the same job; neither can rewrite it.
      // Its estimate as the parties may read it, whatever an old row holds (review W2-5 p6).
      request_snapshot: publicSnapshot(row.request_snapshot),
      // Never the raw pair: each side gets the OTHER side's contact, below.
      contact_snapshot: undefined,
    },
    role: isCustomer ? 'customer' : 'merchant',
    /**
     * CONTACT, REVEALED BY ACCEPTANCE AND NOT BEFORE (§4.7). The merchant gets
     * the customer's delivery contact frozen at acceptance; the customer gets
     * the merchant's. An order accepted before 0130 has none (`null`) — the
     * request thread below is how those two talk.
     */
    //
    // CLOSED WITHOUT THE JOB (review F3): once the order is cancelled or
    // refunded the merchant no longer holds the customer's phone and address —
    // the same rule that takes the original file away (`isEngagedMerchant`).
    // A completed job keeps it (docs/DECISIONS.md).
    contact:
      !isCustomer && (row.state === 'cancelled' || row.state === 'refunded')
        ? null
        : contactFor(isCustomer ? 'customer' : 'merchant', row.contact_snapshot),
    /** Both parties may open the request's thread (POST /api/chats/open { requestId, merchantId }). */
    thread: { request_id: row.request_id, merchant_id: row.merchant_id },
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
    throw new HttpError(409, `An order that is ${row.state} cannot be started`, 'CUSTOM_ORDER_CANNOT_START', { state: row.state });
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
  // «بدأ التنفيذ» is an instant on the order too (0160 `started_at`), and the
  // first row of its timeline (worker/routes/communityOrderTimeline.ts).
  const startedAt = nowIso();
  const res = await c.env.DB.prepare(
    `UPDATE community_orders SET state = 'in_progress', started_at = COALESCE(started_at, ?1), updated_at = ?1
      WHERE id = ?2 AND state = 'funded'
        AND EXISTS (SELECT 1 FROM community_escrows e
                     WHERE e.community_order_id = community_orders.id AND e.state = 'held')`
  ).bind(startedAt, orderId).run();
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
  // The timeline's «started» row — once, whatever the caller retries (§9.5).
  await recordOrderEvent(c.env.DB, orderId, c.get('user')!.id, 'started', startedAt);
  // The customer hears work began (review F4; keyed on the order, once).
  await notifyCustomOrderStarted(c.env, orderId);
  // …and the conversation the deal came from shows it (D8).
  await announceCustomOrder(c.env, orderId, 'started', c.get('user')!.id);
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
    throw new HttpError(409, `An order that is ${row.state} cannot be marked delivered`, 'CUSTOM_ORDER_CANNOT_DELIVER', { state: row.state });
  }

  const days = await autoCompleteDays(c.env.DB);
  const ts = nowIso();
  // 0 disables auto-release entirely: the money then waits for a human, which
  // is the safe default for a platform that has not decided its policy yet.
  const autoAt = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;

  const res = await c.env.DB.prepare(
    `UPDATE community_orders
        SET state = 'merchant_marked_delivered', delivered_at = ?, auto_complete_at = ?, updated_at = ?
      WHERE id = ? AND state = 'in_progress'`
  ).bind(ts, autoAt, ts, orderId).run();
  /*
   * A FLIP THAT MATCHED NOTHING IS NOT A SUCCESS (docs/COMMUNITY_COMMERCE_CHAT.md
   * §1.3). This answered 200 whatever the UPDATE did: a dispute or a cancel
   * that landed after the read above left the order where it was while the
   * merchant was told it was delivered — and the customer was asked to
   * confirm a delivery that never happened. A second tap that lost to the
   * first is the replay it is; anything else is ORDER_CHANGED.
   */
  if (!Number(res.meta.changes ?? 0)) {
    const now = await c.env.DB.prepare('SELECT state, auto_complete_at FROM community_orders WHERE id = ?')
      .bind(orderId)
      .first<{ state: string; auto_complete_at: string | null }>();
    if (now?.state === 'merchant_marked_delivered') {
      return c.json({ success: true, replayed: true, auto_complete_at: now.auto_complete_at });
    }
    throw conflict('This order changed — reload it', 'ORDER_CHANGED');
  }

  await audit(c.env.DB, c.get('user')!.id, 'community.order_delivered', orderId, { auto_complete_at: autoAt });
  // «أكّد الاستلام», with the auto-complete date if the owner set one (review F4).
  await notifyCustomOrderDelivered(c.env, orderId);
  await announceCustomOrder(c.env, orderId, 'delivered', c.get('user')!.id);
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
  // Already confirmed while the merchant was suspended: the confirmation
  // stands and the money waits in escrow (DECISIONS row 137).
  if (row.state === 'customer_confirmed') return c.json({ success: true, replayed: true, released: false, held: true });
  if (!canMoveCommunityOrder(String(row.state) as CommunityOrderState, 'customer_confirmed')) {
    throw new HttpError(409, `An order that is ${row.state} cannot be confirmed`, 'CUSTOM_ORDER_CANNOT_CONFIRM', { state: row.state });
  }

  const escrow = await escrowForOrder(c.env.DB, orderId);
  if (!escrow) throw conflict('This order has no escrow to release', 'CUSTOM_ORDER_NO_ESCROW');

  /**
   * THE MERCHANT OR ITS STORE IS SUSPENDED (owner decision, DECISIONS row
   * 136): the customer's confirmation is RECORDED — the order reads
   * `customer_confirmed` and cannot be disputed or auto-confirmed any more —
   * and the money stays in escrow. The auto-confirm sweep releases it the
   * first run after the suspension lifts. `releaseEscrow` asks the same
   * question inside its own flip, so a suspension landing after this read
   * holds the money too.
   */
  const holdForSuspension = async () => {
    const ts = nowIso();
    await c.env.DB.prepare(
      `UPDATE community_orders SET state = 'customer_confirmed', confirmed_at = ?1, updated_at = ?1
        WHERE id = ?2 AND state = 'merchant_marked_delivered'`
    ).bind(ts, orderId).run();
    await audit(c.env.DB, user.id, 'community.order_confirmed_held', orderId, { escrow: escrow.id, reason: 'merchant suspended' });
    await announceCustomOrder(c.env, orderId, 'confirmed', user.id);
    return c.json({ success: true, released: false, held: true });
  };
  if (await merchantSuspension(c.env.DB, String(row.merchant_id))) return holdForSuspension();

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
    if (reason === 'MERCHANT_SUSPENDED') return holdForSuspension();
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
  // The request's discussion records the completion (§9.5).
  await writeRequestSystemUpdate(c.env.DB, String(row.request_id), 'completed', { order_id: orderId });
  await announceCustomOrder(c.env, orderId, 'completed', user.id);
  // «صار مبلغ متاحًا» — the escrow released the merchant's share (W2-E; keyed on the order, once).
  await notifyPayoutAvailable(c.env, { merchantId: String(row.merchant_id), amountIqd: Number(row.merchant_receivable_iqd) || 0, sourceKey: `community_order:${orderId}`, communityOrderId: orderId });
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
  // The request's discussion records the dispute (§9.5).
  await writeRequestSystemUpdate(c.env.DB, String(row.request_id), 'disputed', { by: isCustomer ? 'customer' : 'merchant', order_id: orderId });
  await announceCustomOrder(c.env, orderId, 'disputed', user.id);
  // The merchant is told the money is frozen and why (W2-E; forced on, §61).
  if (isCustomer) await notifyDisputeOpened(c.env, { communityOrderId: orderId, complaintId, merchantId: String(row.merchant_id) });
  // …and the customer when the MERCHANT raised it (review F4).
  else await notifyCustomOrderDisputedByMerchant(c.env, orderId, complaintId);
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
    throw policy.by.includes('admin')
      ? conflict('Work has already started — open a dispute and Levonis will decide', 'CUSTOM_ORDER_CANCEL_NEEDS_DISPUTE')
      : new HttpError(409, `An order that is ${state} cannot be cancelled`, 'CUSTOM_ORDER_CANNOT_CANCEL', { state });
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
  // The request's discussion records the close (§9.5).
  await writeRequestSystemUpdate(c.env.DB, String(row.request_id), 'cancelled', { by: role, order_id: orderId });
  await announceCustomOrder(c.env, orderId, 'cancelled', user.id);
  // The workshop is told not to start (review F4; keyed on the order, once).
  if (isCustomer) await notifyCustomOrderCancelledByCustomer(c.env, orderId);
  return c.json({ success: true, refunded: !!escrow });
});

/** Every community order this user is a party to, either side. */
marketplaceRoutes.get('/orders', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.state, o.price_iqd, o.merchant_receivable_iqd, o.created_at,
            o.delivered_at, o.completed_at, o.auto_complete_at, o.request_id, o.merchant_id,
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
