/**
 * WHO MAY FILE A UPLOAD UNDER WHICH THING — shared by the whole-body route
 * (`POST /api/uploads`) and the resumable sessions (`/api/uploads/sessions`),
 * so the two doors cannot drift into two answers about the same thread,
 * ticket, request or store (docs/COMMUNITY_ECOSYSTEM.md §9.4).
 *
 * Every check runs BEFORE a byte is stored, so a key can never name an entity
 * the uploader was not entitled to write to. The uploader's claims — the
 * purpose, the entity id, the file name — decide only WHICH check runs; the
 * check itself reads the database.
 */
import type { MediaDomain, MediaVisibility } from './mediaStorage';
import { HttpError, badRequest, conflict, forbidden, notFound, str } from './http';
import { storeForUser } from './merchantAuth';
import { assertMayWriteInThread } from '../routes/chats';
import { getSetting, type UploadLimits, type UploadQuotas } from './settings';
import type { UploadKind } from './attachments';
import type { Env } from './types';
import { onPublicBoard } from './communityRequests';
import { liveVerdictForUser } from './printMatchingStore';
import { assertDesignAssetDoor } from './personalize/access';

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

/**
 * Every purpose either door accepts. A purpose is listed here only once a
 * route CONSUMES its keys: `order_update` returned with the order timeline
 * (worker/routes/communityOrderTimeline.ts, §9.5) — a photo of the work in
 * progress, filed under the order and read back by its two parties.
 */
export const UPLOAD_PURPOSES = [
  'receipt', 'avatar', 'chat', 'product', 'community', 'support', 'complaint', 'post',
  'request', 'product_file',
  'order_update',
  'offer',
  // A person's own logo or photo for a personalised product (Programme C C1):
  // consumed by POST /api/personalize/configs (`mintConfig`) and served back to
  // its owner alone by GET /api/personalize/assets/<key>. Session-only — the
  // whole-body route has no placement for it.
  'design_asset',
] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** What the whole-body route takes: small pictures, clips, voice notes and PDFs. */
export const SIMPLE_UPLOAD_PURPOSES = ['receipt', 'avatar', 'chat', 'product', 'community', 'support', 'complaint', 'post'] as const;
export type SimpleUploadPurpose = (typeof SIMPLE_UPLOAD_PURPOSES)[number];

/** What a resumable session may be opened for. */
export const SESSION_PURPOSES = [
  'post', 'community', 'chat', 'request', 'product_file',
  'order_update',
  'offer',
  'design_asset',
] as const;
export type SessionPurpose = (typeof SESSION_PURPOSES)[number];

/**
 * The purposes whose consumers send the KEY back (a post's media list, a
 * store's product media, a product file row). A chat or a request answers
 * with its own row instead, so the completed session hands those no key.
 */
export const KEY_PURPOSES: ReadonlySet<string> = new Set([
  'post', 'community', 'product_file',
  // An order update's photo: the merchant posts the key back to the timeline.
  'order_update',
  // An offer's files (0159, §9.5): the composer sends the keys back as `files: [{key}]`.
  'offer',
  // A design picture (C1): the studio puts the key in the configuration's `logo` / `photo` choice.
  'design_asset',
]);

const SESSION_KINDS: Record<SessionPurpose, readonly UploadKind[]> = {
  post: ['image', 'video', 'model', 'document'],
  community: ['image', 'video'],
  chat: ['image', 'video', 'document'],
  request: ['image', 'model', 'document'],
  product_file: ['image', 'model', 'document'],
  // A picture of the work in progress — what «photo» on the timeline means.
  order_update: ['image'],
  // What an offer may show the customer: a photo of a sample, a PDF quote, a model.
  offer: ['image', 'model', 'document'],
  // A logo or a photo to put on a personalised product — pictures only (never SVG: no such extension).
  design_asset: ['image'],
};

/** May a session for this purpose carry this kind of file? */
export function purposeAdmits(purpose: SessionPurpose, kind: UploadKind): boolean {
  return SESSION_KINDS[purpose].includes(kind);
}

export interface UploadActor {
  id: string;
  role: string;
}

/**
 * The order states in which the workshop still writes on the order's
 * timeline (worker/routes/communityOrderTimeline.ts) — and so the states in
 * which the `order_update` upload door opens.
 */
export const ORDER_UPDATE_LIVE_STATES: ReadonlySet<string> = new Set(['funded', 'in_progress', 'merchant_marked_delivered']);

/** A request may carry this many attachments (the marketplace's own cap). */
export const MAX_FILES_PER_REQUEST = 6;
const REQUEST_FILE_STATES = new Set(['draft', 'open', 'receiving_offers']);

/**
 * Verify the entity a purpose files under, and return its id ('' for the
 * purposes that file under the uploader). Throws the same refusals the
 * whole-body route always threw: 403 for a thread, ticket, complaint or store
 * that is not the uploader's; 404 for a request, product, offer or order that
 * is not theirs (so a stranger cannot tell it exists).
 */
export async function assertUploadEntity(
  db: D1Database,
  user: UploadActor,
  purpose: UploadPurpose,
  entityRaw: unknown
): Promise<string> {
  const entity = (required: boolean) => str(entityRaw, 'entity_id', { max: 64, min: required ? 1 : 0, required });

  switch (purpose) {
    case 'receipt':
    case 'avatar':
    case 'post':
      return '';

    case 'product':
      if (user.role !== 'admin') throw forbidden('Only administrators can upload product media');
      return '';

    /**
     * PUBLIC MERCHANT MEDIA NEEDS A STORE (review W2-5 p3): purpose=community
     * files are public and served from the merchant prefix, and any signed-in
     * account could otherwise store 40 MB videos there.
     */
    case 'community':
      if (!(await storeForUser(db, user.id))) {
        throw new HttpError(403, 'Open your store first — store pictures and videos belong to a store', 'STORE_REQUIRED');
      }
      return '';

    /**
     * A CHAT FILE BELONGS TO THE CONVERSATION, NOT TO WHOEVER SENT IT — and
     * storing a file under a thread is writing in it: the same rule as the
     * message door (a participant; on a store thread only its customer or its
     * seller; 403 CHAT_READ_ONLY for read-only staff).
     */
    case 'chat': {
      const chatId = entity(true);
      await assertMayWriteInThread(db, chatId, user.id);
      return chatId;
    }

    /** A support attachment belongs to the ticket: its owner, or any admin. */
    case 'support': {
      const ticket = entity(true);
      const own = await db
        .prepare(
          user.role === 'admin'
            ? 'SELECT 1 AS x FROM support_tickets WHERE id = ? LIMIT 1'
            : 'SELECT 1 AS x FROM support_tickets WHERE id = ? AND user_id = ? LIMIT 1'
        )
        .bind(...(user.role === 'admin' ? [ticket] : [ticket, user.id]))
        .first();
      if (!own) throw forbidden('Not your ticket');
      return ticket;
    }

    /** A complaint's evidence belongs to the complaint: its reporter, or staff. */
    case 'complaint': {
      const complaint = entity(true);
      const allowed = await db
        .prepare(
          user.role === 'admin'
            ? 'SELECT 1 AS x FROM community_complaints WHERE id = ? LIMIT 1'
            : 'SELECT 1 AS x FROM community_complaints WHERE id = ? AND reporter_id = ? LIMIT 1'
        )
        .bind(...(user.role === 'admin' ? [complaint] : [complaint, user.id]))
        .first();
      if (!allowed) throw forbidden('Not your complaint');
      return complaint;
    }

    /**
     * A request's files are its owner's, and only while the request is still
     * taking offers: attachments are what merchants priced against, so the
     * window closes with the request (worker/routes/marketplace.ts).
     */
    case 'request': {
      const requestId = entity(true);
      const r = await db
        .prepare('SELECT id, customer_id, state FROM community_requests WHERE id = ?')
        .bind(requestId)
        .first<{ id: string; customer_id: string; state: string }>();
      if (!r || r.customer_id !== user.id) throw notFound('Request not found');
      if (!REQUEST_FILE_STATES.has(r.state)) {
        throw conflict('This request is no longer open, so its attachments cannot change', 'REQUEST_NOT_EDITABLE');
      }
      return requestId;
    }

    /**
     * AN ORDER UPDATE'S PHOTO BELONGS TO THE ORDER (0160, §9.5): the entity is
     * a community order id, and the door opens exactly where its only
     * consumer does (review 2026-09-30): POST /orders/:id/updates kind
     * `photo` is written by the WORKSHOP'S OWNER while the order is live
     * (`ORDER_UPDATE_LIVE_STATES`). The customer's `modification_request`
     * takes no file, and a closed order takes no update, so an upload there
     * could only ever be an orphan nothing references. A stranger, and the
     * customer, get the 404 every order door gives; a closed order is
     * ORDER_UPDATE_TOO_LATE, the POST's own answer.
     */
    case 'order_update': {
      const orderId = entity(true);
      const order = await db
        .prepare(
          `SELECT o.state FROM community_orders o JOIN community_merchants m ON m.id = o.merchant_id
            WHERE o.id = ?1 AND m.user_id = ?2 LIMIT 1`
        )
        .bind(orderId, user.id)
        .first<{ state: string }>();
      if (!order) throw notFound('Order not found');
      if (!ORDER_UPDATE_LIVE_STATES.has(order.state)) {
        throw new HttpError(409, `An order that is ${order.state} takes no more updates`, 'ORDER_UPDATE_TOO_LATE', { state: order.state });
      }
      return orderId;
    }

    /**
     * AN OFFER'S FILE IS FILED UNDER THE REQUEST IT QUOTES (0159, §9.5): the
     * entity is a request id, and the uploader must be a workshop that may
     * quote it — the author of an offer or a saved draft on it, or a merchant
     * whose LIVE verdict for the job is eligible (the same authority the offer
     * route asks, `liveVerdictForUser`). Anyone else — no store, the request's
     * own customer, a workshop the job does not fit — is answered 404, so the
     * door confirms nothing about the request.
     */
    case 'offer': {
      const requestId = entity(true);
      const store = await storeForUser(db, user.id);
      if (!store) throw notFound('Request not found');
      const r = await db
        .prepare('SELECT id, customer_id, state, visibility, expires_at FROM community_requests WHERE id = ?')
        .bind(requestId)
        .first<{ id: string; customer_id: string; state: string; visibility: string; expires_at: string | null }>();
      if (!r || r.state === 'draft' || r.customer_id === user.id) throw notFound('Request not found');
      if (await offerAuthorOnRequest(db, requestId, store.merchant.id)) return requestId;
      if (!onPublicBoard(r)) throw notFound('Request not found');
      // The matcher reads only the database, so the binding alone is its Env.
      const live = await liveVerdictForUser({ DB: db } as unknown as Env, requestId, user.id);
      if (!live?.verdict.eligible) throw notFound('Request not found');
      return requestId;
    }

    /**
     * A DESIGN PICTURE (Programme C C1): the entity is the PRODUCT being
     * personalised, and the door opens exactly where its consumer does — a
     * blueprint asking for a logo or a photo that personalisation is on for
     * (or a previewer's draft), within the owner's `design_quota` files
     * (worker/lib/personalize/access.ts). Everything else is one 404.
     */
    case 'design_asset': {
      const productId = entity(true);
      await assertDesignAssetDoor(db, user, productId);
      return productId;
    }

    /** A product file sits under the store owner's prefix; a named product must be the store's own. */
    case 'product_file': {
      const store = await storeForUser(db, user.id);
      if (!store) throw new HttpError(403, 'Open your store first — product files belong to a store', 'STORE_REQUIRED');
      const productId = entity(false);
      if (productId) {
        const own = await db
          .prepare('SELECT 1 AS x FROM community_products WHERE id = ? AND merchant_id = ? LIMIT 1')
          .bind(productId, store.merchant.id)
          .first();
        if (!own) throw notFound('Product not found');
      }
      return productId;
    }
  }
}

/**
 * Has this workshop an offer (live or superseded) or a saved draft on this
 * request? The author of either may keep adding files to it whatever the
 * verdict says today. The drafts table arrives with 0159; behind it there are
 * no drafts.
 */
async function offerAuthorOnRequest(db: D1Database, requestId: string, merchantId: string): Promise<boolean> {
  const offer = await db
    .prepare(
      `SELECT 1 AS x FROM community_offers
        WHERE request_id = ?1 AND merchant_id = ?2 AND state IN ('pending','superseded','accepted') LIMIT 1`
    )
    .bind(requestId, merchantId)
    .first();
  if (offer) return true;
  const draft = await db
    .prepare('SELECT 1 AS x FROM community_offer_drafts WHERE request_id = ?1 AND merchant_id = ?2 LIMIT 1')
    .bind(requestId, merchantId)
    .first()
    .catch(() => null);
  return !!draft;
}

/** The room left on a request for one more attachment — the marketplace's cap of six. */
export async function assertRequestFileRoom(db: D1Database, requestId: string): Promise<void> {
  const existing = await db
    .prepare('SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?')
    .bind(requestId)
    .first<{ n: number }>();
  if (Number(existing?.n ?? 0) >= MAX_FILES_PER_REQUEST) {
    throw badRequest(`A request may have at most ${MAX_FILES_PER_REQUEST} attachments`);
  }
}

/**
 * The folder a chat attachment is filed in — `chat/<chatId>/<folder>/…` — and
 * therefore what the message route (worker/routes/chats.ts
 * `chatAttachmentKind`) reads it back as. The folder, not a client claim, is
 * the record of what the bytes were sniffed as.
 */
export function chatKeyKind(mime: string): string {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'files';
  return 'attachments';
}

export interface UploadPlacement {
  visibility: MediaVisibility;
  domain: MediaDomain;
  entityId: string;
  kind: string;
}

/**
 * WHERE A SESSION'S OBJECT LIVES. Public only where the whole-body route is
 * already public (a post's pictures and clips, a store's media); everything a
 * consumer serves through its own gated route — a model on a post, a request
 * file, a product file — is private and
 * `/files/<key>` answers 404 for it, exactly as for every other private prefix
 * the file gate does not know.
 */
export function placementFor(
  purpose: SessionPurpose,
  kind: UploadKind,
  ctx: { userId: string; entityId: string; mime: string }
): UploadPlacement {
  switch (purpose) {
    case 'post':
      return kind === 'image' || kind === 'video'
        ? { visibility: 'public', domain: 'users', entityId: ctx.userId, kind: 'posts' }
        : { visibility: 'private', domain: 'users', entityId: ctx.userId, kind: 'post-files' };
    case 'community':
      return { visibility: 'public', domain: 'merchants', entityId: ctx.userId, kind: 'public' };
    case 'chat':
      return { visibility: 'private', domain: 'chat', entityId: ctx.entityId, kind: chatKeyKind(ctx.mime) };
    case 'request':
      return { visibility: 'private', domain: 'requests', entityId: ctx.userId, kind: 'files' };
    case 'product_file':
      return { visibility: 'private', domain: 'merchants', entityId: ctx.userId, kind: 'product-files' };
    case 'order_update':
      return { visibility: 'private', domain: ORDER_UPDATE_DOMAIN, entityId: ctx.entityId, kind: 'updates' };
    // `merchants/<uid>/offers/<id>.<ext>`, private: the request the file quotes
    // is recorded on the ledger row (`file_objects.entity_id`) rather than in
    // the key — `buildMediaKey` admits one segment per part, and the prefix is
    // the merchant's own, which is what `ownedFileObject` checks.
    case 'offer':
      return { visibility: 'private', domain: 'merchants', entityId: ctx.userId, kind: 'offers' };
    // `users/<uid>/design-assets/<id>.<ext>`, PRIVATE — the person's own; the
    // product it was uploaded for is on the ledger row (`entity_id`). `/files`
    // answers 404; GET /api/personalize/assets/<key> serves it to its owner.
    case 'design_asset':
      return { visibility: 'private', domain: 'users', entityId: ctx.userId, kind: 'design-assets' };
  }
}

/**
 * The prefix an order update's photo lives under: `community-orders/<orderId>/
 * updates/<id>.<ext>` (§9.5). PRIVATE — `/files/*` knows no such prefix and
 * answers 404; the order's own file route serves it to its two parties.
 */
export const ORDER_UPDATE_DOMAIN: MediaDomain = 'community-orders';
export const orderUpdateKeyPrefix = (orderId: string) => `community-orders/${orderId}/updates/`;

/** The visibility a session key was opened under, read back from its shape (the sweep has only the key). */
export function visibilityForKey(key: string): MediaVisibility {
  return /^users\/[^/]+\/posts\//.test(key) || /^merchants\/[^/]+\/public\//.test(key) ? 'public' : 'private';
}

/** The ceiling, in bytes, for a kind of file under the current limits. */
export function kindLimitBytes(limits: UploadLimits, kind: UploadKind): number {
  const mb =
    kind === 'image' ? limits.image_mb :
    kind === 'video' ? limits.video_mb :
    kind === 'model' ? limits.model_mb :
    kind === 'archive' ? limits.archive_mb :
    limits.document_mb;
  return Math.max(1, Math.floor(mb)) * MiB;
}

/** The multipart part size in bytes — never under R2's 5 MiB minimum for a non-final part. */
/**
 * The largest part a session will ever accept: the admin ceiling of `chunk_mb`
 * (worker/routes/adminCommunity.ts bounds it to 5..40) in bytes — 40 MiB because
 * that is the largest body the platform accepts anywhere (the gateway's
 * `no class is wider` rule, services/gateway/test/uploadClasses.test.ts). The
 * gateway's body class for `PUT /api/uploads/sessions/:id/parts/:n` is read
 * from this constant (services/gateway/src/uploadClasses.ts), so the two
 * cannot drift.
 */
export const SESSION_PART_MAX_BYTES = 40 * 1024 * 1024;

export function chunkBytesFor(limits: UploadLimits): number {
  return Math.min(SESSION_PART_MAX_BYTES, Math.max(5, Math.floor(limits.chunk_mb)) * MiB);
}

/** The quota for a purpose in bytes, or null when the purpose has none. */
export function quotaBytesFor(quotas: UploadQuotas, purpose: string): number | null {
  const gb =
    purpose === 'post' ? quotas.post_gb :
    purpose === 'product_file' ? quotas.product_file_gb :
    purpose === 'request' ? quotas.request_gb :
    // An offer's files share the request files' ceiling: both are job attachments, bounded per owner.
    purpose === 'offer' ? quotas.request_gb :
    // An order update's photos too (review 2026-09-30): a job's pictures, bounded per owner like the rest.
    purpose === 'order_update' ? quotas.request_gb :
    // A person's design pictures (C1): their own quota, 0.5 GiB unless the owner sets it.
    purpose === 'design_asset' ? (quotas.design_asset_gb ?? 0.5) :
    null;
  return gb === null ? null : Math.max(0, gb) * GiB;
}

export interface QuotaCountOptions {
  /** A session re-asserting its own quota on complete: its declared bytes are the `bytes` argument, not a second count. */
  excludeSessionId?: string;
  now?: string;
}

/**
 * The owner's bytes under a purpose: the LIVE objects (deleted ones free
 * their share) PLUS the open, unexpired sessions' declared sizes. A session
 * is a promise of bytes the bucket will hold: counting completed objects only
 * let N sessions opened one after another all pass the same cap and all land
 * (files-security review, 2026-09-30). Two SELECTs in one D1 batch — one
 * round trip.
 */
export async function usedQuotaBytes(db: D1Database, ownerId: string, purpose: string, opts: QuotaCountOptions = {}): Promise<number> {
  try {
    const [objects, sessions] = await db.batch<{ bytes: number }>([
      db
        .prepare(
          `SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM file_objects
            WHERE owner_id = ? AND purpose = ? AND deleted_at IS NULL`
        )
        .bind(ownerId, purpose),
      db
        .prepare(
          `SELECT COALESCE(SUM(declared_bytes), 0) AS bytes FROM upload_sessions
            WHERE owner_id = ?1 AND purpose = ?2 AND state = 'open' AND expires_at > ?3 AND id <> ?4`
        )
        .bind(ownerId, purpose, opts.now ?? new Date().toISOString(), opts.excludeSessionId ?? ''),
    ]);
    return (Number(objects.results?.[0]?.bytes) || 0) + (Number(sessions.results?.[0]?.bytes) || 0);
  } catch {
    // A Worker ahead of migration 0156 has no `purpose` column or session
    // table yet; an upload is not refused because the quota cannot be counted.
    return 0;
  }
}

/**
 * Refuse a file that would take the owner past their quota for this purpose
 * (UPLOAD_QUOTA_EXCEEDED, with the figures the client can show). Open
 * sessions count, so sessions opened in turn cannot each pass the same cap;
 * the session's `complete` asks again (excluding itself) before it writes the
 * ledger row, so two sessions opened in the same instant cannot both land.
 */
export async function assertQuota(db: D1Database, ownerId: string, purpose: string, bytes: number, opts: QuotaCountOptions = {}): Promise<void> {
  const quotas = await getSetting(db, 'uploadQuotas');
  const limit = quotaBytesFor(quotas, purpose);
  if (limit === null) return;
  const used = await usedQuotaBytes(db, ownerId, purpose, opts);
  if (used + bytes > limit) {
    throw badRequest('You have reached the storage limit for this kind of file — remove a file you no longer need', 'UPLOAD_QUOTA_EXCEEDED', {
      limit_bytes: limit,
      used_bytes: used,
      purpose,
    });
  }
}
