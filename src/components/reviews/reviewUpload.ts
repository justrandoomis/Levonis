/**
 * THE CLIENT HALF OF THE ONE REVIEW UPLOAD DOOR (docs/REVIEWS_GIFTS.md §5, §8 C1).
 *
 * Two things live here, and nothing else:
 *
 *  1. THE PICKER'S RULES, as pure functions the tests drive directly: what a
 *     picked file is (photo, video or refused, and why), how many of each a
 *     review may hold (10 photos, 2 videos — the server's own numbers from
 *     packages/catalog/src/reviewRules.ts), what is refused instead of being
 *     sliced off, and why «نشر» is not available yet. The server re-checks all
 *     of it from the BYTES; these checks only spare the customer an upload
 *     that would bounce.
 *
 *  2. THE UPLOAD, through the existing door — `POST /api/reviews/uploads`,
 *     multipart `{purpose:'media', file}` → `{key, kind, sha256, bytes, url}`.
 *     XHR and not `fetch`, because a photograph on a slow line needs a
 *     progress bar and fetch has none (the TradeInWizard idiom). There is no
 *     second uploader, no upload session and no other storage.
 *
 * A JPEG or PNG is prepared first by the app's existing image door
 * (src/lib/imagePreprocess.ts, loaded only at upload time): WebP at a 2048 px
 * edge, which turns a several-megabyte camera photo into a few hundred
 * kilobytes on Iraqi mobile data. When the device cannot convert, the
 * original travels and the server converts it instead.
 */
import { ApiError, uploadTimeoutMs } from '../../lib/api';
import { REVIEW_LIMITS } from '../../../packages/catalog/src/reviewRules';
import type { ReviewTextVerdict } from '../../../packages/catalog/src/reviewRules';

export type ReviewMediaKind = 'image' | 'video';

export const MEDIA_LIMITS = {
  maxImages: REVIEW_LIMITS.maxImages,
  maxVideos: REVIEW_LIMITS.maxVideos,
  /** What may TRAVEL (the server's IMAGE_MAX / VIDEO_MAX). */
  imageMaxBytes: REVIEW_LIMITS.imageMaxBytes,
  videoMaxBytes: REVIEW_LIMITS.videoMaxBytes,
  /** A JPEG/PNG is shrunk before it travels, so only its source must be openable. */
  imageSourceMaxBytes: 64 * 1024 * 1024,
  /** Uploads in flight at once; the rest wait their turn. */
  concurrency: 2,
} as const;

/** The upload door's refusals, and the picker's own count/duplicate refusals. */
export type ReviewPickRefusal =
  | 'REVIEW_UPLOAD_UNSUPPORTED'
  | 'REVIEW_UPLOAD_TOO_LARGE'
  | 'IMAGE_HEIC_UNSUPPORTED'
  | 'REVIEW_MEDIA_TOO_MANY_IMAGES'
  | 'REVIEW_MEDIA_TOO_MANY_VIDEOS'
  | 'REVIEW_MEDIA_DUPLICATE';

/** Exactly what the inputs offer (the plan's types; HEIC is not offered, so iOS hands over a JPEG). */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif';
export const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const CONVERTIBLE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']);
const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'avif']);
const CONVERTIBLE_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm']);
const HEIC_EXT = new Set(['heic', 'heif']);
/** A type that says nothing, so the extension decides (some Android pickers). */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** The facts of a picked file the rules read — a `File` satisfies it. */
export interface PickedFile {
  name: string;
  type: string;
  size: number;
  lastModified?: number;
}

export type FileVerdict =
  | { ok: true; kind: ReviewMediaKind; convertible: boolean }
  | { ok: false; code: ReviewPickRefusal };

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(name ?? '').trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * What a picked file is, before a byte travels. The browser's type first; a
 * blank or generic type falls back to the extension. HEIC is named as HEIC,
 * because «unsupported» alone leaves an iPhone owner with nothing to do.
 */
export function classifyReviewFile(file: PickedFile): FileVerdict {
  const type = String(file.type ?? '').toLowerCase().trim();
  const ext = extensionOf(file.name);
  if (HEIC_TYPES.has(type) || HEIC_EXT.has(ext)) return { ok: false, code: 'IMAGE_HEIC_UNSUPPORTED' };
  let kind: ReviewMediaKind | null = null;
  let convertible = false;
  if (IMAGE_TYPES.has(type)) {
    kind = 'image';
    convertible = CONVERTIBLE_TYPES.has(type);
  } else if (VIDEO_TYPES.has(type)) {
    kind = 'video';
  } else if (GENERIC_TYPES.has(type)) {
    if (IMAGE_EXT.has(ext)) {
      kind = 'image';
      convertible = CONVERTIBLE_EXT.has(ext);
    } else if (VIDEO_EXT.has(ext)) {
      kind = 'video';
    }
  }
  if (!kind || !(file.size > 0)) return { ok: false, code: 'REVIEW_UPLOAD_UNSUPPORTED' };
  const cap =
    kind === 'video' ? MEDIA_LIMITS.videoMaxBytes : convertible ? MEDIA_LIMITS.imageSourceMaxBytes : MEDIA_LIMITS.imageMaxBytes;
  if (file.size > cap) return { ok: false, code: 'REVIEW_UPLOAD_TOO_LARGE' };
  return { ok: true, kind, convertible };
}

/** name|size|lastModified — the same file picked twice, caught before the server's SHA-256 has to. */
export function fingerprintOf(file: PickedFile): string {
  return `${file.name}|${file.size}|${file.lastModified ?? 0}`;
}

// ------------------------------------------------------------------ slots

export type SlotStatus = 'queued' | 'preparing' | 'uploading' | 'done' | 'failed';

/** Still on its way to the door: blocks «نشر». */
export function isPending(slot: Pick<MediaSlot, 'status'>): boolean {
  return slot.status === 'queued' || slot.status === 'preparing' || slot.status === 'uploading';
}

/** One tile of the picker, in gallery order. Serializable on purpose: the File lives beside it. */
export interface MediaSlot {
  id: string;
  kind: ReviewMediaKind;
  status: SlotStatus;
  /** 0..1 while uploading (the request body, not the server's work). */
  progress: number;
  /** A `blob:` preview of the picked file, or the stored media's URL. */
  previewUrl: string;
  /** The stored key once the door accepted the file, or the key of media already on the review. */
  key: string | null;
  /** The refusal code of a failed upload (mapped through refusalStrings). */
  error: string | null;
  name: string;
  fingerprint: string | null;
  /** Already stored on the review being edited — never re-uploaded. */
  existing?: boolean;
}

export function mediaCounts(slots: readonly MediaSlot[]): { images: number; videos: number } {
  let images = 0;
  let videos = 0;
  for (const s of slots) {
    if (s.kind === 'video') videos += 1;
    else images += 1;
  }
  return { images, videos };
}

export interface PickPlan {
  /** Indexes into the picked list that become new tiles, with their kind. */
  accepted: Array<{ index: number; kind: ReviewMediaKind; convertible: boolean }>;
  /** Files refused for what they are (type, size, HEIC) or for being a duplicate. */
  refused: Array<{ index: number; name: string; code: ReviewPickRefusal }>;
  /** Over the per-review limit — refused, never sliced silently. */
  skippedImages: number;
  skippedVideos: number;
}

/**
 * Which of the picked files join the review. Files are taken in the order
 * they were picked until a kind is full; the rest of that kind are counted
 * and reported, so «11 photos» answers «10 added, 1 not added» instead of
 * quietly dropping one. `replacingId` frees that tile's place first (replace
 * keeps the slot; it never costs room).
 */
export function planPick(slots: readonly MediaSlot[], files: readonly PickedFile[], replacingId?: string | null): PickPlan {
  const kept = replacingId ? slots.filter((s) => s.id !== replacingId) : slots;
  let { images, videos } = mediaCounts(kept);
  const seen = new Set(kept.map((s) => s.fingerprint).filter((f): f is string => !!f));
  const plan: PickPlan = { accepted: [], refused: [], skippedImages: 0, skippedVideos: 0 };
  files.forEach((file, index) => {
    const verdict = classifyReviewFile(file);
    // `in`, not `!ok`: the app's config narrows a union by a property it has.
    if ('code' in verdict) {
      plan.refused.push({ index, name: file.name, code: verdict.code });
      return;
    }
    const fp = fingerprintOf(file);
    if (seen.has(fp)) {
      plan.refused.push({ index, name: file.name, code: 'REVIEW_MEDIA_DUPLICATE' });
      return;
    }
    if (verdict.kind === 'image') {
      if (images >= MEDIA_LIMITS.maxImages) {
        plan.skippedImages += 1;
        return;
      }
      images += 1;
    } else {
      if (videos >= MEDIA_LIMITS.maxVideos) {
        plan.skippedVideos += 1;
        return;
      }
      videos += 1;
    }
    seen.add(fp);
    plan.accepted.push({ index, kind: verdict.kind, convertible: verdict.convertible });
  });
  return plan;
}

/** The refusal code of a text verdict, or null when the text passes. */
export function textCode(v: ReviewTextVerdict): string | null {
  return 'code' in v ? v.code : null;
}

export type SubmitBlock =
  | { reason: 'stars' }
  | { reason: 'text'; code: string }
  | { reason: 'limit' }
  | { reason: 'failed'; count: number }
  | { reason: 'uploading'; count: number };

/**
 * WHY «نشر» IS NOT AVAILABLE YET — the one sentence the footer says, or
 * null when it is. An upload still running or failed blocks the review: a
 * review sent without the photo the customer just watched upload would be a
 * quiet loss, and the server cannot attach a file it never received.
 */
export function submitBlock(input: { stars: number; text: ReviewTextVerdict; slots: readonly MediaSlot[] }): SubmitBlock | null {
  if (!(input.stars >= 1 && input.stars <= 5)) return { reason: 'stars' };
  const code = textCode(input.text);
  if (code) return { reason: 'text', code };
  const { images, videos } = mediaCounts(input.slots);
  if (images > MEDIA_LIMITS.maxImages || videos > MEDIA_LIMITS.maxVideos) return { reason: 'limit' };
  const failed = input.slots.filter((s) => s.status === 'failed').length;
  if (failed > 0) return { reason: 'failed', count: failed };
  const pending = input.slots.filter(isPending).length;
  if (pending > 0) return { reason: 'uploading', count: pending };
  return null;
}

/** The `media` field of POST/PUT /api/reviews: every stored key, in gallery order. */
export function mediaPayload(slots: readonly MediaSlot[]): Array<{ key: string }> {
  return slots.filter((s) => s.status === 'done' && !!s.key).map((s) => ({ key: s.key as string }));
}

const MEDIA_DOOR = '/api/reviews/media/';

/**
 * The key of a stored review file. The owner's `existing_review.media` carries
 * `key` (§6.1); an older answer carries only the URL the door builds from it
 * (`/api/reviews/media/<key>`), which names the same key. The server re-checks
 * that every key is the caller's own before attaching it.
 */
export function keyOfStoredMedia(m: { key?: unknown; url?: unknown }): string | null {
  if (typeof m.key === 'string' && m.key) return m.key;
  const url = typeof m.url === 'string' ? m.url : '';
  const at = url.indexOf(MEDIA_DOOR);
  if (at < 0) return null;
  try {
    const key = decodeURIComponent(url.slice(at + MEDIA_DOOR.length).split(/[?#]/)[0]);
    return key || null;
  } catch {
    return null;
  }
}

/** Tiles for the media a review already has (edit mode): stored, never re-uploaded. */
export function slotsFromStored(media: ReadonlyArray<{ url: string; kind: string; key?: string }>): MediaSlot[] {
  return media.map((m, i) => ({
    id: `stored-${i}-${keyOfStoredMedia(m) ?? m.url}`,
    kind: m.kind === 'video' ? 'video' : 'image',
    status: 'done' as const,
    progress: 1,
    previewUrl: m.url,
    key: keyOfStoredMedia(m),
    error: null,
    name: '',
    fingerprint: null,
    existing: true,
  }));
}

/** True when every stored item of an edited review has a key, so PUT may send the full list. */
export function storedKeysComplete(slots: readonly MediaSlot[]): boolean {
  return slots.every((s) => !s.existing || !!s.key);
}

// ------------------------------------------------------------------ the upload

/** What the door answers on success. */
export interface ReviewUploadResult {
  key: string;
  kind: ReviewMediaKind;
  sha256: string;
  bytes: number;
  url: string;
}

/**
 * A JPEG or PNG, as the existing image door prepares it for any upload: WebP
 * at a 2048 px edge. Anything else, and any device that cannot convert,
 * travels as picked; the 8 MiB rule then applies to the bytes that travel.
 */
export async function prepareReviewImage(file: File): Promise<File> {
  let prepared: File = file;
  try {
    const mod = await import('../../lib/imagePreprocess');
    const out = await mod.prepareProductImage(file, (f) => mod.encodeProductRasterAsWebp(f, 2048));
    prepared = out.file;
  } catch {
    prepared = file;
  }
  if (prepared.size > MEDIA_LIMITS.imageMaxBytes) {
    throw new ApiError(400, 'File too large', 'REVIEW_UPLOAD_TOO_LARGE', { max_bytes: MEDIA_LIMITS.imageMaxBytes });
  }
  return prepared;
}

/**
 * POST one file to the review door with progress. Errors are `ApiError`s with
 * the server's code, exactly what `api.post` would have thrown, so the
 * caller maps them through refusalStrings like any other refusal. No 20 s
 * deadline: the timeout is sized for the body (`uploadTimeoutMs`), so a slow
 * line is slow, and only a stalled one fails.
 */
export function uploadReviewMedia(
  file: Blob & { name?: string },
  onProgress: (fraction: number) => void,
  signal?: AbortSignal
): Promise<ReviewUploadResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError(0, 'Request cancelled', 'ABORTED'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/reviews/uploads');
    xhr.withCredentials = true;
    xhr.timeout = uploadTimeoutMs(file.size);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort);
    const done = () => signal?.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      done();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        data = {};
      }
      const ok = xhr.status >= 200 && xhr.status < 300 && data.success !== false && typeof data.key === 'string';
      if (ok) {
        resolve({
          key: data.key as string,
          kind: data.kind === 'video' ? 'video' : 'image',
          sha256: typeof data.sha256 === 'string' ? data.sha256 : '',
          bytes: Number(data.bytes) || 0,
          url: typeof data.url === 'string' ? data.url : `${MEDIA_DOOR}${data.key as string}`,
        });
        return;
      }
      reject(
        new ApiError(
          xhr.status,
          typeof data.error === 'string' && data.error ? data.error : `Upload failed (${xhr.status})`,
          typeof data.code === 'string' ? data.code : undefined,
          data.details && typeof data.details === 'object' ? (data.details as Record<string, unknown>) : undefined,
          data
        )
      );
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError(0, 'Network error — check your connection and try again', 'NETWORK'));
    };
    xhr.ontimeout = () => {
      done();
      reject(new ApiError(0, 'Upload timed out', 'TIMEOUT'));
    };
    xhr.onabort = () => {
      done();
      reject(new ApiError(0, 'Request cancelled', 'ABORTED'));
    };
    const form = new FormData();
    form.set('purpose', 'media');
    form.set('file', file, file.name || 'upload');
    xhr.send(form);
  });
}
