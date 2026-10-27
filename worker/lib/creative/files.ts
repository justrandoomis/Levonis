/**
 * THE STUDIO'S FILES — private, sniffed, sized, served only through the studio
 * (spec §24, §32; docs/CREATIVE_STUDIO.md §1 "Files").
 *
 *   - TYPE FROM THE BYTES, NEVER FROM THE NAME OR THE BROWSER'S LABEL: PNG,
 *     JPEG and WebP only (worker/lib/imageConvert.ts `sniffImageBytes`). SVG,
 *     HTML or anything markup-shaped is refused (an SVG is a document that can
 *     carry script; spec §32 «نظّف SVG، وامنع XSS» — refusing it is the
 *     cleanest clean). An animated image is refused too: the canvas draws one
 *     frame.
 *   - 15 MB at most, refused from the declared length before a byte is read
 *     where the request says it, and from the real length always.
 *   - Width and height read from the image HEADER only (worker/lib/imageMetadata.ts);
 *     no untrusted image is decoded on the Worker.
 *   - Stored EXACTLY as uploaded in the PRIVATE bucket through the one media
 *     door (`putMediaObject`, which records the `file_objects` ledger) under
 *     `creative-studio/…`. Not converted to WebP like catalogue photos: a logo
 *     re-encoded is a different logo, and an export is the file the owner
 *     approved, byte for byte (its sha256 is recorded).
 *   - Served with `private, no-store`, `nosniff` and a sandboxing CSP, never
 *     through /files (which serves no `creative-studio/` prefix).
 */
import { isAnimatedPng, isAnimatedWebp, looksLikeMarkup, sniffImageBytes } from '../imageConvert';
import { rasterDimensions, validRasterDimensions } from '../imageMetadata';
import { buildMediaKey, getMediaObject, putMediaObject } from '../mediaStorage';
import type { Env } from '../types';
import { HttpError } from '../http';

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_PROJECT_JSON_BYTES = 512 * 1024;

export type StudioImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface SniffedStudioImage {
  mime: StudioImageMime;
  ext: 'png' | 'jpg' | 'webp';
  width: number | null;
  height: number | null;
}

export const unsupported = (msg = 'Only PNG, JPEG and WebP pictures are accepted.') => new HttpError(415, msg, 'UNSUPPORTED_MEDIA');
export const tooLarge = () => new HttpError(413, 'The file is larger than 15 MB.', 'FILE_TOO_LARGE');

/** Refuse a request whose declared body is already over the cap (plus a small multipart allowance). */
export function assertDeclaredSize(contentLength: string | undefined, cap = MAX_FILE_BYTES): void {
  const n = Number(contentLength ?? '');
  if (Number.isFinite(n) && n > cap + 64 * 1024) throw tooLarge();
}

/** The bytes → a studio picture, or a refusal (415 / 413). */
export function sniffStudioImage(bytes: Uint8Array): SniffedStudioImage {
  if (bytes.byteLength === 0) throw unsupported('The file is empty.');
  if (bytes.byteLength > MAX_FILE_BYTES) throw tooLarge();
  if (looksLikeMarkup(bytes)) throw unsupported('SVG and other markup files are not accepted; upload a PNG, JPEG or WebP picture.');
  const s = sniffImageBytes(bytes);
  if (!s || (s.mime !== 'image/png' && s.mime !== 'image/jpeg' && s.mime !== 'image/webp')) throw unsupported();
  if ((s.mime === 'image/png' && isAnimatedPng(bytes)) || (s.mime === 'image/webp' && isAnimatedWebp(bytes))) {
    throw unsupported('Animated pictures are not accepted; the canvas draws one frame.');
  }
  const dims = rasterDimensions(bytes, s.mime);
  const ok = validRasterDimensions(dims);
  return { mime: s.mime, ext: s.ext as SniffedStudioImage['ext'], width: ok ? dims!.width : null, height: ok ? dims!.height : null };
}

export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

type FileEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>;

/** Is there a private bucket at all? (A unit test or a local run without R2 is told so honestly.) */
export function storageAvailable(env: FileEnv): boolean {
  return !!(env.R2_PRIVATE ?? env.BUCKET);
}

export const storageUnavailable = () => new HttpError(503, 'File storage is not configured on this deployment.', 'STORAGE_UNAVAILABLE');

/** Store bytes privately under `creative-studio/<entity>/<kind>/<id>.<ext>`; returns the key. */
export async function putStudioFile(
  env: FileEnv,
  place: { entityId: string; kind: string; objectId: string; ext: 'png' | 'jpg' | 'webp' | 'json' },
  bytes: Uint8Array,
  meta: { mime: string; width: number | null; height: number | null; ownerId: string }
): Promise<string> {
  if (!storageAvailable(env)) throw storageUnavailable();
  const key = buildMediaKey({ visibility: 'private', domain: 'creative-studio', entityId: place.entityId, kind: place.kind, objectId: place.objectId, extension: place.ext });
  await putMediaObject(
    env,
    { key, visibility: 'private', domain: 'creative-studio', mime: meta.mime, bytes: bytes.byteLength, ownerId: meta.ownerId, entityId: place.entityId, width: meta.width, height: meta.height },
    bytes,
    { httpMetadata: { contentType: meta.mime, cacheControl: 'private, no-store' } }
  );
  return key;
}

/** Stream a stored studio file, or null when it is gone. */
export async function streamStudioFile(env: FileEnv, key: string, mime: string, downloadName: string | null): Promise<Response | null> {
  if (!storageAvailable(env)) return null;
  const obj = await getMediaObject(env, 'private', key);
  if (!obj) return null;
  const headers = new Headers({
    'Content-Type': mime,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (downloadName) headers.set('Content-Disposition', `attachment; filename="${downloadName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}"`);
  return new Response(obj.body, { status: 200, headers });
}
