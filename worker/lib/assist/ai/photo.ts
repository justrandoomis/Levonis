/**
 * A PHOTO THE CUSTOMER ATTACHED, FOR CLAUDE TO READ (owner, 2026-11-18: «understand
 * all hms from text or photo»; DECISIONS row 349).
 *
 * Only a still image the SAME signed-in customer uploaded to the assistant
 * chat (`assist/<their id>/attachments/…`, worker/lib/assist/attachments.ts):
 * the key's prefix is the ownership check, so nobody can have Claude read
 * another customer's file. The bytes are read from the private bucket, scaled
 * down by the `IMAGES` binding when they are large, and handed over in memory.
 * Nothing derived from the photo is stored or logged.
 */
import type { Env } from '../../types';
import { getMediaObject, isSafeMediaKey } from '../../mediaStorage';
import { sniffImageBytes } from '../../imageConvert';
import { assistKindOf } from '../attachments';

export interface ClaudeImage {
  media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  data: string;
}

/** The provider takes up to 5 MB per image; base64 adds a third, so the raw bytes stay under this. */
export const PHOTO_SEND_MAX_BYTES = 3_600_000;
/** Longer edges are scaled down: the provider would downscale them anyway, after billing the upload. */
export const PHOTO_EDGE = 1568;
const PHOTO_READ_MAX_BYTES = 20 * 1024 * 1024;
const SENDABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** The shape and ownership check, without I/O. */
export function ownedPhotoKey(raw: unknown, userId: string | null): string | null {
  if (!userId || typeof raw !== 'string' || !isSafeMediaKey(raw)) return null;
  if (!raw.startsWith(`assist/${userId}/`)) return null;
  return assistKindOf(raw) === 'image' ? raw : null;
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function scaledDown(env: Pick<Env, 'IMAGES'>, bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!env.IMAGES) return null;
  try {
    const result = await env.IMAGES.input(new Blob([bytes]).stream())
      .transform({ width: PHOTO_EDGE, height: PHOTO_EDGE, fit: 'scale-down' })
      .output({ format: 'image/jpeg', quality: 82 });
    const res = result.response();
    if (!res.ok) return null;
    const out = new Uint8Array(await res.arrayBuffer());
    return out.byteLength <= PHOTO_SEND_MAX_BYTES ? out : null;
  } catch {
    return null;
  }
}

/** The photo as an image block, or null (not theirs, gone, not an image, too large to send). Never throws. */
export async function loadPhoto(env: Env, key: string): Promise<ClaudeImage | null> {
  try {
    const obj = await getMediaObject(env, 'private', key);
    if (!obj || obj.size > PHOTO_READ_MAX_BYTES) return null;
    let bytes = new Uint8Array(await obj.arrayBuffer());
    let mime = sniffImageBytes(bytes)?.mime ?? '';
    if (!SENDABLE.has(mime)) return null;
    if (bytes.byteLength > PHOTO_SEND_MAX_BYTES || mime !== 'image/jpeg') {
      const small = await scaledDown(env, bytes);
      if (small) {
        bytes = small;
        mime = 'image/jpeg';
      } else if (bytes.byteLength > PHOTO_SEND_MAX_BYTES) return null;
    }
    return { media_type: mime as ClaudeImage['media_type'], data: base64(bytes) };
  } catch {
    return null;
  }
}
