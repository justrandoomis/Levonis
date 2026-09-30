/**
 * THE STUDIO'S MESH LOADER — the LVR1 part ranges and the gzip-aware fetch
 * (docs/LEVO_PROJECT_PROGRAMME.md §B.2 items 2 and 6). Beside ./lvm.ts rather
 * than in it on purpose: the model viewer page shares `parseLvm` with the
 * studio but uses neither of these, and the chunk it loads stays without them
 * (the pair budget «ModelViewer + viewer-core ≤ 7.7 KB»).
 */
import { parseLvm, type ParsedMesh } from './lvm';

/** A fetched mesh: the triangles, and the LVR1 part ranges when the file carries them. */
export interface LoadedMesh {
  mesh: ParsedMesh;
  /** Flat [start0, count0, start1, count1, …] in triangles; null = one part. */
  ranges: Uint32Array | null;
}

/** At most this many parts: the blueprint's own limit (BlueprintSpec v1). */
export const MAX_PARTS = 64;

/**
 * The LVR1 part ranges, flat: [start0, count0, start1, count1, …] in
 * triangles. null when the file carries no trailer, or one we did not write —
 * more than MAX_PARTS parts, ranges that are not contiguous from triangle 0 in
 * part order, or that run past the triangle block. A zero count is kept: a part
 * the compiler removed (hidden) keeps its index, so region maps stay aligned.
 */
export function readRegions(bytes: ArrayBuffer): Uint32Array | null {
  if (bytes.byteLength < 32) return null;
  const view = new DataView(bytes);
  const triangles = view.getUint32(4, true);
  const at = 32 + triangles * 36;
  // 'LVR1' read as one little-endian u32.
  if (bytes.byteLength < at + 8 || view.getUint32(at, true) !== 0x3152564c) return null;
  const parts = view.getUint16(at + 4, true);
  if (!parts || parts > MAX_PARTS || bytes.byteLength < at + 8 + parts * 8) return null;
  const ranges = new Uint32Array(parts * 2);
  let next = 0;
  for (let i = 0; i < parts * 2; i += 2) {
    ranges[i] = view.getUint32(at + 8 + i * 4, true);
    ranges[i + 1] = view.getUint32(at + 12 + i * 4, true);
    if (ranges[i] !== next) return null;
    next += ranges[i + 1];
  }
  return next > triangles ? null : ranges;
}

/**
 * Fetches a viewer mesh — a published blueprint's `.lvm.gz` (stored
 * `application/gzip` under merchants/<uid>/public/bp/ and served by /files as
 * it is, so the body is the gzip itself, not a Content-Encoding), inflated with
 * DecompressionStream; a plain LVM1 body (a builder's draft) is read as it is.
 *
 * Answers `{ unsupported: true }` when the file is gzip and the browser cannot
 * inflate (iOS < 16.4): the caller shows the look card. A `.gz` URL is refused
 * before the download, so such a phone spends nothing on bytes it cannot use.
 * null when the answer is not a mesh (not ok, not LVM1). Rejects when the
 * request itself fails (network, abort) or the gzip is corrupt.
 */
export async function loadMesh(
  url: string,
  { signal }: { signal?: AbortSignal } = {}
): Promise<LoadedMesh | { unsupported: true } | null> {
  const inflate = typeof DecompressionStream === 'function';
  if (!inflate && /\.gz(?:[?#]|$)/.test(url)) return { unsupported: true };
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) return null;
  let bytes = await res.arrayBuffer();
  // Sniffed, not trusted from a header: LVM1 starts with 'L', gzip with 1f 8b.
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    if (!inflate) return { unsupported: true };
    bytes = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  const mesh = parseLvm(bytes);
  return mesh ? { mesh, ranges: readRegions(bytes) } : null;
}
