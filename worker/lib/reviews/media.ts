/**
 * REVIEW MEDIA — the existing review upload path, fixed and extended
 * (docs/REVIEWS_GIFTS.md §Media). Owner: lane S1. Lane S2 (gifts.ts, the admin
 * gift queue) only READS `publicMedia`, `mediaUrl` and `parseEvidence`.
 *
 * One storage, one uploader: POST /api/reviews/uploads → `storeMedia`
 * (worker/lib/mediaStorage.ts) → private `reviews/<uid>/photos|video/<id>.<ext>`,
 * served only by GET /api/reviews/media/*. No platform upload sessions, no
 * second door.
 */
import type { Env } from '../types';
import { safeParse } from '../types';
import type { ReviewQualityMedia } from '../reviewQuality';
import { HttpError } from '../http';
import { newId } from '../crypto';
import { headMediaObject, isSafeMediaKey } from '../mediaStorage';
import { isHeifImageBytes, sniffImageBytes } from '../imageConvert';
import { sniffVideo } from '../videoSniff';
import { protectMediaObjectFromCleanup } from '../productDeletion';
import { REVIEW_LIMITS } from './text';

/** One stored media item of a review, as `reviews.media` holds it (JSON array, gallery order). */
export type MediaEntry = ReviewQualityMedia;

/** Private Instagram evidence of a LEGACY reward (no longer collected; admins still read it). */
export interface InstagramEvidence {
  link: string;
  key: string;
}

export function parseEvidence(raw: unknown): InstagramEvidence | null {
  const v = safeParse<Partial<InstagramEvidence> | null>(raw, null);
  if (!v || (typeof v.link !== 'string' && typeof v.key !== 'string')) return null;
  const link = typeof v.link === 'string' ? v.link : '';
  const key = typeof v.key === 'string' ? v.key : '';
  if (!link && !key) return null;
  return { link, key };
}

export function mediaUrl(key: string): string {
  return `/api/reviews/media/${key}`;
}

/**
 * The public shape of a review's media: `[{url, kind}]` in gallery order.
 * S1 may ADD optional fields (e.g. `bytes`), never rename these two — the
 * product page, the admin queue and MyReviewsTab read them.
 */
export function publicMedia(raw: unknown): Array<{ url: string; kind: 'image' | 'video' }> {
  const list = safeParse<MediaEntry[]>(raw, []);
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m.key === 'string')
    .map((m) => ({ url: mediaUrl(m.key), kind: m.kind === 'video' ? 'video' : 'image' }));
}

// ----------------------------------------------------------------- S1 fills

/** Refusal codes of the media path. Every one has ar/en/ckb in src/lib/refusalStrings.ts. */
export type ReviewMediaRefusal =
  | 'REVIEW_MEDIA_TOO_MANY_IMAGES' // > 10 images in one review            (400, details {max, got})
  | 'REVIEW_MEDIA_TOO_MANY_VIDEOS' // > 2 videos in one review             (400, details {max, got})
  | 'REVIEW_MEDIA_NOT_OWNED' //     key not under reviews/<uid>/, or no object (400, details {index})
  | 'REVIEW_MEDIA_KIND' //          stored object is neither image/* nor video/* (400, details {index})
  | 'REVIEW_MEDIA_DUPLICATE' //     same key or same sha256 twice in one review (400, details {index, duplicate_of})
  | 'REVIEW_MEDIA_REUSED' //        sha256 already in another review of this user (400, details {index})
  | 'REVIEW_MEDIA_IN_USE' //        key already attached to another review  (409, details {index})
  | 'REVIEW_UPLOAD_UNSUPPORTED' //  upload: signature is not JPEG/PNG/WebP/GIF/AVIF/MP4/MOV/WebM (400)
  | 'REVIEW_UPLOAD_TOO_LARGE' //    upload: image > 8 MiB or video > 40 MiB (400, details {max_bytes})
  | 'IMAGE_HEIC_UNSUPPORTED' //     upload: HEIC/HEIF photo (existing trilingual refusal, uploads.ts)
  | 'VIDEO_UNSUPPORTED'; //         upload: container without a playable video track (videoSniff.ts)

/** What the upload door decided from the BYTES (never the name or the browser's type). */
export type SniffedReviewUpload =
  | { ok: true; kind: 'image' | 'video'; mime: string }
  | { ok: false; code: 'REVIEW_UPLOAD_UNSUPPORTED' | 'IMAGE_HEIC_UNSUPPORTED' | 'VIDEO_UNSUPPORTED' };

/**
 * Sniff an uploaded review file from its BYTES: `sniffImageBytes` (the same
 * JPEG/PNG/GIF/WebP/AVIF signatures `sniff()` in worker/routes/uploads.ts
 * reads, from the library so no route module is imported here),
 * `isHeifImageBytes` → IMAGE_HEIC_UNSUPPORTED, and EVERY video (MP4,
 * QuickTime MOV, WebM) proven over the whole body by `sniffVideo`
 * (worker/lib/videoSniff.ts): the container walked end to end and a real video
 * track in a codec browsers play. A MOV is stored as `video/mp4`.
 */
export function sniffReviewUpload(buf: Uint8Array): SniffedReviewUpload {
  const image = sniffImageBytes(buf);
  if (image) return { ok: true, kind: 'image', mime: image.mime };
  if (isHeifImageBytes(buf)) return { ok: false, code: 'IMAGE_HEIC_UNSUPPORTED' };
  const video = sniffVideo(buf);
  if (video.ok) return { ok: true, kind: 'video', mime: video.mime };
  // The bytes START like a video container (ftyp / EBML) but are not a video
  // a browser plays: an audio-only M4A, a truncated or glued-on file, a codec
  // no player here supports. That is a video problem with its own remedy
  // (export as MP4), not "unsupported type".
  if (video.reason !== 'not_video') return { ok: false, code: 'VIDEO_UNSUPPORTED' };
  return { ok: false, code: 'REVIEW_UPLOAD_UNSUPPORTED' };
}

const refusal = (status: 400 | 409, message: string, code: ReviewMediaRefusal, details?: Record<string, unknown>) =>
  new HttpError(status, message, code, details);
const notOwned = (index: number) =>
  refusal(400, 'One of the uploaded files could not be found — upload it again', 'REVIEW_MEDIA_NOT_OWNED', { index });
const duplicate = (index: number, duplicateOf: number) =>
  refusal(400, 'The same file was added twice — remove the duplicate', 'REVIEW_MEDIA_DUPLICATE', { index, duplicate_of: duplicateOf });
const tooManyImages = (got: number) =>
  refusal(400, `A review can have up to ${REVIEW_LIMITS.maxImages} photos`, 'REVIEW_MEDIA_TOO_MANY_IMAGES', { max: REVIEW_LIMITS.maxImages, got });
const tooManyVideos = (got: number) =>
  refusal(400, `A review can have up to ${REVIEW_LIMITS.maxVideos} videos`, 'REVIEW_MEDIA_TOO_MANY_VIDEOS', { max: REVIEW_LIMITS.maxVideos, got });

/**
 * The keys a POST/PUT asks for, in gallery order — or null when the request
 * names no media at all (PUT: keep what the review has; POST: none).
 *
 * `media: [{key}]` is the contract. For ONE release the old tab's
 * `photoKeys[]` / `videoKey` (and `videoKeys[]`) are mapped into the same
 * list; as before, a legacy field that is omitted on an edit keeps that kind
 * of the review's media, and `videoKey: ''` removes the video.
 */
function requestedKeys(input: Record<string, unknown>, existing: MediaEntry[]): unknown[] | null {
  if (input.media !== undefined && input.media !== null) {
    if (!Array.isArray(input.media)) throw notOwned(0);
    return input.media.map((m) =>
      typeof m === 'string' ? m : m && typeof m === 'object' ? (m as { key?: unknown }).key : undefined
    );
  }
  const photosGiven = input.photoKeys !== undefined && input.photoKeys !== null;
  const videosGiven = input.videoKey !== undefined || (input.videoKeys !== undefined && input.videoKeys !== null);
  if (!photosGiven && !videosGiven) return null;
  if (photosGiven && !Array.isArray(input.photoKeys)) throw notOwned(0);
  const photos: unknown[] = photosGiven
    ? (input.photoKeys as unknown[])
    : existing.filter((m) => m.kind === 'image').map((m) => m.key);
  let videos: unknown[];
  if (!videosGiven) {
    videos = existing.filter((m) => m.kind === 'video').map((m) => m.key);
  } else {
    videos = Array.isArray(input.videoKeys) ? [...(input.videoKeys as unknown[])] : [];
    if (typeof input.videoKey === 'string' && input.videoKey !== '') videos.push(input.videoKey);
  }
  return [...photos, ...videos];
}

/** The kind segment a key was minted with (`reviews/<uid>/<kind>/<id>.<ext>`); legacy keys have none. */
function keyKindSegment(key: string, prefix: string): string {
  const rest = key.slice(prefix.length).split('/');
  return rest.length > 1 ? rest[0] : '';
}

/**
 * Resolve the media list of a POST/PUT into stored entries, refusing (never
 * slicing) with the codes above. Input: `media: [{key}]` in gallery order, or
 * the legacy `photoKeys[]`/`videoKey` of an old tab (one release). Kind, mime,
 * bytes and sha256 come from the OBJECT (R2 head: httpMetadata.contentType,
 * size, customMetadata.sha256 written by the upload door) — never from the
 * client slot. Entries already on the review being edited are kept as stored.
 *
 * Side effect, on purpose: every NEW key is protected from the media cleanup
 * (`protectMediaObjectFromCleanup`, 15 min) BEFORE its object is read, so the
 * staging cleanup cannot delete it between this check and the review's batch.
 */
export async function resolveReviewMedia(
  env: Env,
  args: { userId: string; reviewId: string | null; input: Record<string, unknown>; existing: MediaEntry[] | null }
): Promise<MediaEntry[]> {
  const { userId, reviewId, input } = args;
  const existing = (args.existing ?? []).filter((m) => m && typeof m.key === 'string');
  const requested = requestedKeys(input, existing);
  if (requested === null) return existing;

  // 1. Every key is this customer's own review upload: `reviews/<uid>/…`, a
  //    safe key, never a traversal. Anything else is "not found" — whose file
  //    it might be is not this route's business to say.
  const prefix = `reviews/${userId}/`;
  const keys: string[] = requested.map((key, index) => {
    if (
      typeof key !== 'string' ||
      key.length > 300 ||
      key.includes('..') ||
      !key.startsWith(prefix) ||
      !isSafeMediaKey(key)
    ) {
      throw notOwned(index);
    }
    return key;
  });

  // 2. The same key twice is refused, never collapsed.
  const keyAt = new Map<string, number>();
  keys.forEach((key, index) => {
    const first = keyAt.get(key);
    if (first !== undefined) throw duplicate(index, first);
    keyAt.set(key, index);
  });

  // 3. REFUSED, NEVER SLICED. Past the combined ceiling one kind is over its
  //    own limit whatever the objects turn out to be; the kind is read from
  //    the segment the upload door minted the key with, so this costs no
  //    request per file. Within the ceiling the objects decide (step 5).
  if (keys.length > REVIEW_LIMITS.maxImages + REVIEW_LIMITS.maxVideos) {
    const videos = keys.filter((k) => keyKindSegment(k, prefix) === 'video').length;
    if (videos > REVIEW_LIMITS.maxVideos) throw tooManyVideos(videos);
    throw tooManyImages(keys.length - videos);
  }

  // 4. Each NEW key: protect it from the staging cleanup FIRST (a claim
  //    already taken by the cleanup means the bytes are going or gone), THEN
  //    read the object. Kind, MIME, size and digest come from the object the
  //    upload door wrote — never from the client's slot or the file name.
  //    Entries the review already holds are kept exactly as stored.
  const stored = new Map(existing.map((m) => [m.key, m]));
  const entries: MediaEntry[] = [];
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const kept = stored.get(key);
    if (kept) {
      entries.push(kept);
      continue;
    }
    if (!(await protectMediaObjectFromCleanup(env.DB, key))) throw notOwned(index);
    const head = await headMediaObject(env, 'private', key);
    if (!head) throw notOwned(index);
    const mime = String(head.httpMetadata?.contentType ?? '').toLowerCase();
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : null;
    if (!kind) {
      throw refusal(400, 'One of the files is neither a photo nor a video', 'REVIEW_MEDIA_KIND', { index });
    }
    const sha = String(head.customMetadata?.sha256 ?? '').toLowerCase();
    entries.push({
      key,
      kind,
      sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : undefined,
      bytes: Number(head.size) || undefined,
      mime,
    });
  }

  // 5. The limits, by what the objects ARE.
  const images = entries.filter((m) => m.kind === 'image').length;
  const videos = entries.length - images;
  if (images > REVIEW_LIMITS.maxImages) throw tooManyImages(images);
  if (videos > REVIEW_LIMITS.maxVideos) throw tooManyVideos(videos);

  // 6. The same BYTES twice in one review (two uploads of one photo).
  const shaAt = new Map<string, number>();
  entries.forEach((m, index) => {
    if (!m.sha256) return;
    const first = shaAt.get(m.sha256);
    if (first !== undefined) throw duplicate(index, first);
    shaAt.set(m.sha256, index);
  });

  // 7. Against this customer's OTHER reviews: a key attached elsewhere is in
  //    use; the same bytes already published in another review are reused.
  //    Keys are owner-scoped (step 1), so only their own reviews can hold them.
  const fresh = entries.map((m, index) => ({ m, index })).filter(({ m }) => !stored.has(m.key));
  if (fresh.length > 0) {
    const { results } = await env.DB.prepare('SELECT id, media FROM reviews WHERE user_id = ? AND id <> ?')
      .bind(userId, reviewId ?? '')
      .all<{ id: string; media: string }>();
    const otherKeys = new Set<string>();
    const otherShas = new Set<string>();
    for (const r of results ?? []) {
      for (const m of safeParse<MediaEntry[]>(r.media, [])) {
        if (m && typeof m.key === 'string') otherKeys.add(m.key);
        if (m && typeof m.sha256 === 'string' && m.sha256) otherShas.add(m.sha256);
      }
    }
    for (const { m, index } of fresh) {
      if (otherKeys.has(m.key)) {
        throw refusal(409, 'This file belongs to another review — upload a new one', 'REVIEW_MEDIA_IN_USE', { index });
      }
      if (m.sha256 && otherShas.has(m.sha256)) {
        throw refusal(400, 'This file is already in one of your earlier reviews', 'REVIEW_MEDIA_REUSED', { index });
      }
    }
  }
  return entries;
}

/** Why a review upload's cleanup job exists — distinct from the product paths' reasons. */
export const REVIEW_MEDIA_STAGING_REASON = 'review_media_staging';
/** How long an upload may wait for its review before the cleanup takes it. */
export const REVIEW_MEDIA_STAGING_MS = 24 * 60 * 60 * 1000;

/**
 * The staging intent of an upload that is never attached: a pending
 * `media_cleanup_jobs` row, reason 'review_media_staging', visibility
 * 'private', not_before = now + 24 h. The existing guarded cron
 * (`runGuardedMediaCleanup`, step `media_cleanup`) deletes it unless
 * `reviews.media` references it by then.
 *
 * `delayMs` (default 24 h) only ever moves a pending job EARLIER: a POST
 * whose own batch failed passes 0, so the bytes of a review that was never
 * created go on the cleanup's next run instead of a day later — and the
 * cleanup still re-checks every reference (and every attach's protection)
 * before it deletes anything.
 */
export function reviewMediaStagingStatement(
  db: D1Database,
  key: string,
  nowMs: number,
  delayMs: number = REVIEW_MEDIA_STAGING_MS
): D1PreparedStatement {
  const notBefore = new Date(nowMs + Math.max(0, delayMs)).toISOString();
  return db
    .prepare(
      `INSERT INTO media_cleanup_jobs
         (id, object_key, visibility, reason, source_product_id, state, attempts, last_error, not_before)
       VALUES (?1, ?2, 'private', '${REVIEW_MEDIA_STAGING_REASON}', '', 'pending', 0, ?3, ?4)
       ON CONFLICT(object_key) WHERE state = 'pending' DO UPDATE SET
         not_before = CASE
           WHEN media_cleanup_jobs.not_before = '' OR media_cleanup_jobs.not_before <= excluded.not_before
             THEN media_cleanup_jobs.not_before
           ELSE excluded.not_before END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .bind(newId('mcj'), key, 'review upload staged: deleted unless a review attaches it', notBefore);
}

/**
 * In the review's own batch: close the staging jobs of the keys it attaches.
 * Fenced on the review ROW, not on the request: a job is closed only for a
 * key the review's stored media really holds once the earlier statements of
 * the batch have run, so a write that lost a race (0 rows changed) can never
 * orphan an upload by closing its job. Closed as `skipped_shared` — the
 * queue's state for "left alone because something references it".
 */
export function closeReviewMediaStagingStatement(db: D1Database, keys: string[], reviewId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE media_cleanup_jobs
          SET state = 'skipped_shared', last_error = ?3,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE state = 'pending'
          AND object_key IN (SELECT value FROM json_each(?1))
          AND EXISTS (SELECT 1 FROM reviews r, json_each(r.media) m
                       WHERE r.id = ?2 AND json_extract(m.value, '$.key') = media_cleanup_jobs.object_key)`
    )
    .bind(JSON.stringify(keys), reviewId, `attached to review ${reviewId}`);
}
