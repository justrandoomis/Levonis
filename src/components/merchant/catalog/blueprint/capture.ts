/**
 * THE LOOK CARD, CAPTURED BY THE BUILDER (docs/LEVO_PROJECT_PROGRAMME.md §B.2
 * «Fallback — the look card»): once per publish, from the draft's own model,
 *
 *   poster   the neutral grey render (src/lib/viewer/studio.ts
 *            `capture({mode: 'neutral'})`) as PNG, ≤ 400 KB — the size and
 *            the format step down (PNG → WebP → smaller) until it fits; a
 *            256² PNG always does (256² × 4 bytes is under the cap)
 *   idmap    the flat region-id pass (`capture({mode: 'ids'})`: red = region
 *            index + 1) at 256², run-length coded, ≤ 8 KB (a busier model
 *            steps down to 192², then 128²)
 *   quads    each area frame's four corners through the capture camera
 *            (`lookMatrix()`), 0..1 of the poster
 *   camera   that matrix, 16 numbers, column-major clip-from-mm
 *
 * PUT …/blueprint/look stores them (worker/lib/personalize/blueprints.ts
 * `saveLook`); the studio's look card paints any design from them without
 * WebGL (src/components/personalize/lookcard.ts).
 *
 * THE FORMATS ARE THE STUDIO'S: the id map is 'L' 'I' '1' | u16 w | u16 h
 * (little-endian) | runs of (u8 id, LEB128 count), row-major from the
 * top-left, as lookcard.ts `decodeIdMap` reads it; a quad is top-left,
 * top-right, bottom-right, bottom-left of the artwork as seen, a frame's up
 * its `u` and its width axis u × n (lookcard.ts `frameQuad`).
 * tests/blueprintBuilderUi.test.ts round-trips both through the studio's
 * readers. Pure except `blobBase64` (a Blob).
 */
import type { Frame, Quad } from '../../../../../packages/catalog/src/personalize/types';
import { widthAxis, unit } from './model';

/** The server's caps (worker/lib/personalize/blueprints.ts LOOK_POSTER_MAX_BYTES / LOOK_IDMAP_MAX_BYTES). */
export const POSTER_MAX_BYTES = 400 * 1024;
export const IDMAP_MAX_BYTES = 8 * 1024;
/** The render the poster is cut from. */
export const POSTER_SIZE = 1024;
/** The id map's sides, largest first. */
export const IDMAP_SIZES = [256, 192, 128] as const;

/** What PUT …/blueprint/look takes. */
export interface LookBody {
  poster: string;
  idmap: string;
  quads: Record<string, Quad>;
  camera: number[];
}

const MAGIC = [0x4c, 0x49, 0x31];

/** Bytes → base64, in slices (a 400 KB poster would overflow one `fromCharCode` call). */
export function bytesBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The id map's bytes: 'LI1', the size, then (id, run length) pairs — run lengths in LEB128. */
export function idMapBytes(ids: ArrayLike<number>, w: number, h: number): Uint8Array {
  const out: number[] = [...MAGIC, w & 255, w >> 8, h & 255, h >> 8];
  const n = w * h;
  for (let i = 0; i < n; ) {
    const v = ids[i];
    let run = 0;
    while (i < n && ids[i] === v) {
      i++;
      run++;
    }
    out.push(v);
    for (; run > 127; run >>>= 7) out.push((run & 127) | 128);
    out.push(run);
  }
  return Uint8Array.from(out);
}

/** The red channel of an `ids` capture (size² RGBA, rows top-down). */
export function idsOf(rgba: ArrayLike<number>, size: number): Uint8Array {
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
  return out;
}

/** Downsample an id map by nearest neighbour (regions are labels, never blended). */
export function shrinkIds(ids: Uint8Array, from: number, to: number): Uint8Array {
  const out = new Uint8Array(to * to);
  for (let y = 0; y < to; y++) {
    const sy = Math.min(from - 1, Math.floor(((y + 0.5) * from) / to));
    for (let x = 0; x < to; x++) out[y * to + x] = ids[sy * from + Math.min(from - 1, Math.floor(((x + 0.5) * from) / to))];
  }
  return out;
}

/** The first id map within 8 KB (256², else 192², else 128²), as base64 — null when even 128² is not. */
export function fitIdMap(ids: Uint8Array, size: number): { b64: string; size: number; bytes: number } | null {
  for (const s of IDMAP_SIZES) {
    const bytes = idMapBytes(s === size ? ids : shrinkIds(ids, size, s), s, s);
    if (bytes.length <= IDMAP_MAX_BYTES) return { b64: bytesBase64(bytes), size: s, bytes: bytes.length };
  }
  return null;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, Math.round(x * 1e4) / 1e4)) : 0);

/** A frame's corners through the capture camera (column-major clip-from-mm) → the quad, 0..1 of the poster. */
export function quadOf(f: Frame, m: readonly number[]): Quad {
  const x = widthAxis(f);
  const up = unit(f.u);
  const at = (sx: number, sy: number): [number, number] => {
    const p = [0, 1, 2].map((i) => f.o[i] + (x[i] * sx * f.w + up[i] * sy * f.h) / 2);
    const c = [0, 1, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    return [clamp01((c[0] / c[2] + 1) / 2), clamp01((1 - c[1] / c[2]) / 2)];
  };
  return [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
}

/** The poster's steps: the size, the format and its quality — tried in order until one is ≤ 400 KB. */
export const POSTER_LADDER: ReadonlyArray<readonly [size: number, type: 'image/png' | 'image/webp', quality?: number]> = [
  [1024, 'image/png'],
  [1024, 'image/webp', 0.9],
  [768, 'image/webp', 0.85],
  [512, 'image/png'],
  [512, 'image/webp', 0.8],
  [384, 'image/png'],
  [256, 'image/png'],
];

/**
 * The first rung of the ladder whose encoding fits 400 KB. `encode` draws the
 * render at that size and encodes it (canvas.toBlob in the browser); a
 * browser that cannot write WebP answers PNG, and the size is what is judged.
 */
export async function fitPoster(
  encode: (size: number, type: 'image/png' | 'image/webp', quality?: number) => Promise<Blob | null>
): Promise<{ blob: Blob; size: number } | null> {
  for (const [size, type, quality] of POSTER_LADDER) {
    const blob = await encode(size, type, quality);
    if (blob && blob.size > 0 && blob.size <= POSTER_MAX_BYTES) return { blob, size };
  }
  return null;
}

export async function blobBase64(blob: Blob): Promise<string> {
  return bytesBase64(new Uint8Array(await blob.arrayBuffer()));
}
