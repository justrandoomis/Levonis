/**
 * THE BLUEPRINT COMPILER — a merchant's model in, the mesh a customer's
 * browser draws out (Programme C, C1; docs/LEVO_PROJECT_PROGRAMME.md §B.2
 * items 1, 2 and 6, §0 row 21).
 *
 * WHAT IT WRITES. LVM1 byte-for-byte — 'LVM1' | u32 triangles | 6×f32 bbox,
 * then 9×f32 per triangle, millimetres, little-endian, centred ONCE on the
 * whole assembly's bbox centre — followed by the region trailer
 *
 *     'LVR1' | u16 parts | u16 0 | parts × (u32 start, u32 count)
 *
 * counted in triangles, contiguous, in part order. The trailer carries RANGES
 * ONLY: part names and colours are the merchant's (they go back to the caller
 * for the merchant-only `product_blueprints.parts`) and never enter the file.
 * Today's `parseLvm` (src/pages/ModelViewer.tsx) ignores trailing bytes, so a
 * compiled mesh still opens in the existing viewer.
 *
 * THE RULES IT KEEPS.
 *   - Never decimated. Above `maxTriangles` (the admin's
 *     `customizationConfig.max_triangles`, default 60,000) the answer is a
 *     refusal, `BLUEPRINT_TOO_HEAVY {triangles, max}` — never a stride-thinned
 *     copy, which drops whole triangles and shreds text (`viewerMesh` does
 *     that for request previews; a customer's name must not have holes).
 *   - Every coordinate snapped to max(0.2 mm, longest side / 500) — finer
 *     than any nozzle, coarse enough that the public copy is a preview and
 *     not the merchant's production file.
 *   - At most 64 parts. A file with more is merged BY ITS OWN GROUPING first
 *     (a 3MF build item's object, an OBJ `o`, a glTF root node), the smallest
 *     groups first, only as far as needed; if that is still more than 64, the
 *     63 largest pieces stay and the rest become one «Other parts» piece.
 *     Either way the result says `PARTS_MERGED`. Refusing would punish a
 *     merchant for how their CAD names bolts.
 *   - Pure apart from the Web platform: CompressionStream / DecompressionStream
 *     and crypto.subtle exist in Workers and in Node 22 alike; nothing here
 *     touches R2 or D1 (the routes do — worker/routes/merchantBlueprints.ts).
 *
 * THE PUBLIC COPY. `withoutParts` removes the hidden parts' ranges by range
 * copy and KEEPS EVERY INDEX: a hidden part stays in the trailer with count 0,
 * so region indices, area frames and the engine's part numbers mean the same
 * thing in the merchant's full mesh and the customer's public one. The
 * coordinates are not re-centred (area frames live in the full assembly's
 * frame); only the header bbox is recomputed over what remains.
 *
 * WHERE THE BYTES LIVE. Stored gzip (`application/gzip`, CompressionStream)
 * and inflated in the browser with DecompressionStream:
 *   - public  `merchants/<uid>/public/bp/<blueprintId>-r<rev>-<hash12>.lvm.gz`
 *     — `isAnonymousPublicMediaKey` already answers yes for
 *     `merchants/<uid>/public/…`, so `/files/*` serves it with no change:
 *     the stored content type, `public, max-age=31536000, immutable` (the key
 *     is content-addressed, so the promise is true), edge-cached, Range;
 *   - private `merchants/<uid>/blueprints/<productId>-<hash12>.lvm.gz` — the
 *     merchant's full draft mesh; the public reader answers 404 for it (not a
 *     public prefix, not one of the private prefixes it gates), so only the
 *     builder's own owner-checked route can serve it.
 * The hash is SHA-256 over the UNCOMPRESSED mesh, so the content address does
 * not depend on which zlib a runtime ships.
 */
import {
  parseModelParts,
  sniffFormat,
  type ModelFormat,
  type ModelPart,
  type ModelPartsHint,
  type ModelPartsWarning,
} from '../modelGeometry';

// -------------------------------------------------------------- vocabulary

/** Parts one mesh may carry (the engine's cap; the LVR1 field itself is u16). */
export const BLUEPRINT_MAX_PARTS = 64;
/** STL files one blueprint may be assembled from. */
export const BLUEPRINT_MAX_SOURCE_FILES = 12;
/** The admin default for `customizationConfig.max_triangles`. */
export const BLUEPRINT_DEFAULT_MAX_TRIANGLES = 60_000;
/** The snap floor and divisor: max(0.2 mm, longest side / 500). */
export const MESH_SNAP_MIN_MM = 0.2;
export const MESH_SNAP_DIVISOR = 500;
/** How a mesh is stored and served: raw gzip bytes, inflated by the client — never `Content-Encoding`. */
export const MESH_CONTENT_TYPE = 'application/gzip';
/** The most a stored mesh may inflate to (250k triangles would be 9 MB; the blueprint cap is 60k ≈ 2.2 MB). */
export const MESH_INFLATE_MAX_BYTES = 32 * 1024 * 1024;

const LVM1 = [0x4c, 0x56, 0x4d, 0x31];
const LVR1 = [0x4c, 0x56, 0x52, 0x31];
const HEADER_BYTES = 32;
const TRIANGLE_BYTES = 36;

export type CompileWarning = ModelPartsWarning | 'PARTS_MERGED' | 'BBOX_MISMATCH';
/** `ModelPartsHint` plus the two a set of files can earn. */
export type BlueprintSourceHint = ModelPartsHint | 'mixed_files' | 'too_many_files';

/** One part of a compiled mesh, for the merchant-only `product_blueprints.parts`. */
export interface CompiledPart {
  /** The LVR1 index — the number the spec's parts, the shader's regions and picking use. */
  n: number;
  /** The file's name for it (merchant-only; never in the mesh). */
  name: string;
  triangles: number;
  /** [minX, minY, minZ, maxX, maxY, maxZ] in the mesh's centred frame, snapped, millimetres. */
  bbox_mm: [number, number, number, number, number, number];
  /** 0..1 of the assembly: by enclosed volume, by surface area when the pieces enclose none. */
  share: number;
  /** Enclosed volume (exact for a closed piece) — what a gram estimate multiplies. */
  volume_mm3: number;
  /** `#rrggbb` as the file states it — merchant-only. */
  colour?: string;
  extruder?: number;
}

export type CompileResult =
  | {
      ok: true;
      /** LVM1 + LVR1, uncompressed. */
      lvm: Uint8Array;
      /** SHA-256 hex of `lvm` — the content address of both stored keys. */
      hash: string;
      format: ModelFormat;
      parts: CompiledPart[];
      triangles: number;
      /** [x, y, z] extents of the snapped mesh, millimetres. */
      dims_mm: [number, number, number];
      /** The header's box: [minX, minY, minZ, maxX, maxY, maxZ], centred frame. */
      bbox_mm: [number, number, number, number, number, number];
      snap_mm: number;
      warnings: CompileWarning[];
    }
  | { ok: false; code: 'BLUEPRINT_TOO_HEAVY'; triangles: number; max: number }
  | { ok: false; code: 'BLUEPRINT_MODEL_UNREADABLE'; format: ModelFormat; hint: BlueprintSourceHint };

/** A stored bbox as the analysis keeps it (`{x, y, z}`) or as a triple. */
export type Vec3Like = { x: number; y: number; z: number } | readonly [number, number, number];

export interface StlSourceFile {
  name: string;
  bytes: Uint8Array;
  /** Where this piece sits in the assembly (the file's `analysis.bbox_min_mm/max_mm`). */
  bbox_min_mm?: Vec3Like;
  bbox_max_mm?: Vec3Like;
}

export type CompileInput =
  | { kind: 'model'; parts: ModelPart[]; format?: ModelFormat; warnings?: readonly ModelPartsWarning[] }
  | { kind: 'stl_set'; files: StlSourceFile[] };

// ------------------------------------------------------------- the compile

/** The snap grid for an assembly whose longest side is `longestMm`. */
export function meshSnapMm(longestMm: number): number {
  return Math.max(MESH_SNAP_MIN_MM, (Number.isFinite(longestMm) ? longestMm : 0) / MESH_SNAP_DIVISOR);
}

/**
 * Parts (from `parseModelParts`) or ≤ 12 STL files placed by their stored
 * bboxes → one LVM1+LVR1 mesh. See the file header for the rules.
 */
export async function compileBlueprintMesh(input: CompileInput, opts: { maxTriangles: number }): Promise<CompileResult> {
  const max = Math.max(0, Math.floor(opts.maxTriangles));
  const warnings: CompileWarning[] = [];
  let parts: ModelPart[];
  let format: ModelFormat;
  if (input.kind === 'stl_set') {
    const placed = placeStlSet(input.files, max, warnings);
    if (!placed.ok) return placed.refusal;
    parts = placed.parts;
    format = 'stl';
  } else {
    parts = input.parts.filter((p) => p.triangles > 0 && p.positions.length >= p.triangles * 9);
    format = input.format ?? 'unknown';
    warnings.push(...(input.warnings ?? []));
  }
  const total = parts.reduce((n, p) => n + p.triangles, 0);
  if (total > max) return { ok: false, code: 'BLUEPRINT_TOO_HEAVY', triangles: total, max };
  if (total === 0) return { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format, hint: 'empty' };
  if (parts.length > BLUEPRINT_MAX_PARTS) {
    parts = capParts(parts, BLUEPRINT_MAX_PARTS);
    warnings.push('PARTS_MERGED');
  }
  const mesh = writeMesh(parts, total);
  return { ok: true, ...mesh, hash: await meshHash(mesh.lvm), format, warnings: [...new Set(warnings)] };
}

/**
 * THE ONE CALL THE ATTACH ROUTE MAKES: the merchant's source files → a
 * compiled mesh. One model file (3MF, OBJ, GLB/glTF, AMF) is read into its
 * parts; one to twelve STL files are one part each, placed by their stored
 * bboxes; anything else is refused with a hint the builder words.
 */
export async function compileBlueprintSource(files: StlSourceFile[], opts: { maxTriangles: number }): Promise<CompileResult> {
  const formats = files.map((f) => sniffFormat(f.bytes, f.name));
  if (files.length === 0) return { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format: 'unknown', hint: 'empty' };
  if (files.length > BLUEPRINT_MAX_SOURCE_FILES) {
    return { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format: formats[0], hint: 'too_many_files' };
  }
  if (formats.every((f) => f === 'stl')) return compileBlueprintMesh({ kind: 'stl_set', files }, opts);
  if (files.length > 1) {
    return { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format: formats.find((f) => f !== 'stl') ?? 'unknown', hint: 'mixed_files' };
  }
  const read = parseModelParts(files[0].bytes, files[0].name, { maxTriangles: opts.maxTriangles });
  if (!read.ok) {
    // A count exists only when the file could be opened; without one the
    // refusal is the hint alone, never a made-up number.
    return read.code === 'TOO_HEAVY' && read.triangles !== undefined
      ? { ok: false, code: 'BLUEPRINT_TOO_HEAVY', triangles: read.triangles, max: Math.max(0, Math.floor(opts.maxTriangles)) }
      : { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format: read.format, hint: read.hint };
  }
  return compileBlueprintMesh({ kind: 'model', parts: read.parts, format: read.format, warnings: read.warnings }, opts);
}

type Placed = { ok: true; parts: ModelPart[] } | { ok: false; refusal: CompileResult };

/** Each STL is one part, moved so its own bbox centre lands on its stored bbox centre. */
function placeStlSet(files: StlSourceFile[], max: number, warnings: CompileWarning[]): Placed {
  if (files.length === 0) return { ok: false, refusal: { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format: 'stl', hint: 'empty' } };
  if (files.length > BLUEPRINT_MAX_SOURCE_FILES) {
    return { ok: false, refusal: { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format: 'stl', hint: 'too_many_files' } };
  }
  const parts: ModelPart[] = [];
  let total = 0;
  for (const file of files) {
    const format = sniffFormat(file.bytes, file.name);
    if (format !== 'stl') return { ok: false, refusal: { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format, hint: 'mixed_files' } };
    const read = parseModelParts(file.bytes, file.name, { maxTriangles: max });
    if (!read.ok) {
      if (read.code === 'TOO_HEAVY' && read.triangles !== undefined) total += read.triangles;
      else return { ok: false, refusal: { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format, hint: read.hint } };
      continue;
    }
    total += read.triangles;
    if (total > max) continue; // keep counting for an exact refusal, stop holding geometry
    warnings.push(...read.warnings);
    const one = read.parts.length === 1 ? read.parts[0] : mergeParts(read.parts, '');
    const positions = one.positions;
    const box = boxOf([positions]);
    const lo = vec3(file.bbox_min_mm);
    const hi = vec3(file.bbox_max_mm);
    if (lo && hi) {
      const shift = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2 - (box[k] + box[k + 3]) / 2);
      for (let i = 0; i < positions.length; i++) positions[i] += shift[i % 3];
      const off = [0, 1, 2].some((k) => {
        const own = box[k + 3] - box[k];
        return Math.abs(hi[k] - lo[k] - own) > Math.max(0.5, own * 0.01);
      });
      if (off) warnings.push('BBOX_MISMATCH');
    }
    parts.push({ ...one, name: fileLabel(file.name) || one.name, positions });
  }
  if (total > max) return { ok: false, refusal: { ok: false, code: 'BLUEPRINT_TOO_HEAVY', triangles: total, max } };
  return { ok: true, parts };
}

const vec3 = (v: Vec3Like | undefined): number[] | null => {
  if (!v || typeof v !== 'object') return null;
  const t = 'x' in v ? [v.x, v.y, v.z] : [v[0], v[1], v[2]];
  return t.every((n) => typeof n === 'number' && Number.isFinite(n)) ? t : null;
};

const fileLabel = (name: string) =>
  (name.split(/[\\/]/).pop() ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/\s+/g, ' ').trim().slice(0, 80);

/** [minX, minY, minZ, maxX, maxY, maxZ] over flat triangle soups. */
function boxOf(soups: Float32Array[]): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of soups) {
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (z < b[2]) b[2] = z;
      if (x > b[3]) b[3] = x;
      if (y > b[4]) b[4] = y;
      if (z > b[5]) b[5] = z;
    }
  }
  return b;
}

/** Pieces concatenated in order into one; it keeps a colour only when the pieces agree, else the largest's. */
function mergeParts(members: ModelPart[], name: string): ModelPart {
  const triangles = members.reduce((n, p) => n + p.triangles, 0);
  const positions = new Float32Array(triangles * 9);
  let at = 0;
  for (const p of members) {
    positions.set(p.positions.subarray(0, p.triangles * 9), at);
    at += p.triangles * 9;
  }
  const largest = members.reduce((a, b) => (b.triangles > a.triangles ? b : a), members[0]);
  const same = <K extends 'colour' | 'extruder'>(k: K) => (members.every((p) => p[k] === members[0][k]) ? members[0][k] : largest[k]);
  const colour = same('colour');
  const extruder = same('extruder');
  return {
    name: name || largest.name,
    ...(colour !== undefined ? { colour } : {}),
    ...(extruder !== undefined ? { extruder } : {}),
    ...(largest.group !== undefined ? { group: largest.group } : {}),
    positions,
    triangles,
  };
}

/**
 * ≤ `max` parts. First the file's own groups, smallest first, each merged
 * whole and named by the group, until the count fits; then, if it still does
 * not, the `max − 1` largest pieces stay and the rest become «Other parts».
 */
function capParts(parts: ModelPart[], max: number): ModelPart[] {
  const groups = new Map<string, number[]>();
  parts.forEach((p, i) => {
    if (!p.group) return;
    groups.set(p.group, [...(groups.get(p.group) ?? []), i]);
  });
  const candidates = [...groups.entries()]
    .filter(([, idx]) => idx.length > 1)
    .map(([label, idx]) => ({ label, idx, tris: idx.reduce((n, i) => n + parts[i].triangles, 0) }))
    .sort((a, b) => a.tris - b.tris || a.idx[0] - b.idx[0]);
  let count = parts.length;
  const mergeInto = new Map<number, { label: string; idx: number[] }>(); // first index → group
  const absorbed = new Set<number>();
  for (const c of candidates) {
    if (count <= max) break;
    mergeInto.set(c.idx[0], c);
    for (const i of c.idx.slice(1)) absorbed.add(i);
    count -= c.idx.length - 1;
  }
  const grouped: ModelPart[] = [];
  parts.forEach((p, i) => {
    if (absorbed.has(i)) return;
    const g = mergeInto.get(i);
    grouped.push(g ? mergeParts(g.idx.map((k) => parts[k]), g.label) : p);
  });
  if (grouped.length <= max) return grouped;

  const keep = new Set(
    grouped
      .map((p, i) => ({ i, tris: p.triangles }))
      .sort((a, b) => b.tris - a.tris || a.i - b.i)
      .slice(0, max - 1)
      .map((x) => x.i)
  );
  const rest = grouped.filter((_, i) => !keep.has(i));
  return [...grouped.filter((_, i) => keep.has(i)), mergeParts(rest, 'Other parts')];
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The bytes and the facts: one centring, one snap, contiguous ranges in part order. */
function writeMesh(parts: ModelPart[], total: number) {
  const box = boxOf(parts.map((p) => p.positions.subarray(0, p.triangles * 9)));
  const centre = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
  const snap = meshSnapMm(Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]));

  const trailerAt = HEADER_BYTES + total * TRIANGLE_BYTES;
  const lvm = new Uint8Array(trailerAt + 8 + parts.length * 8);
  const dv = new DataView(lvm.buffer);
  const floats = LITTLE_ENDIAN ? new Float32Array(lvm.buffer, HEADER_BYTES, total * 9) : null;
  const put = (i: number, v: number) => {
    if (floats) floats[i] = v;
    else dv.setFloat32(HEADER_BYTES + i * 4, v, true);
  };

  const all = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const facts: Array<{ bbox: number[]; volume: number; area: number }> = [];
  let written = 0;
  for (const part of parts) {
    const pb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let volume = 0;
    let area = 0;
    const src = part.positions;
    const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let t = 0; t < part.triangles; t++) {
      for (let k = 0; k < 9; k++) {
        const axis = k % 3;
        // Centred, snapped, and read back at float32 — the value the file holds.
        const v = Math.fround(Math.round((src[t * 9 + k] - centre[axis]) / snap) * snap);
        c[k] = v;
        put(written * 9 + k, v);
        if (v < pb[axis]) pb[axis] = v;
        if (v > pb[axis + 3]) pb[axis + 3] = v;
      }
      volume += (c[0] * (c[4] * c[8] - c[5] * c[7]) - c[1] * (c[3] * c[8] - c[5] * c[6]) + c[2] * (c[3] * c[7] - c[4] * c[6])) / 6;
      const ux = c[3] - c[0], uy = c[4] - c[1], uz = c[5] - c[2];
      const vx = c[6] - c[0], vy = c[7] - c[1], vz = c[8] - c[2];
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      written++;
    }
    for (let k = 0; k < 3; k++) {
      if (pb[k] < all[k]) all[k] = pb[k];
      if (pb[k + 3] > all[k + 3]) all[k + 3] = pb[k + 3];
    }
    facts.push({ bbox: pb, volume: Math.abs(volume), area });
  }

  lvm.set(LVM1, 0);
  dv.setUint32(4, total, true);
  for (let k = 0; k < 6; k++) dv.setFloat32(8 + k * 4, all[k], true);
  lvm.set(LVR1, trailerAt);
  dv.setUint16(trailerAt + 4, parts.length, true);
  dv.setUint16(trailerAt + 6, 0, true);
  let start = 0;
  parts.forEach((p, i) => {
    dv.setUint32(trailerAt + 8 + i * 8, start, true);
    dv.setUint32(trailerAt + 12 + i * 8, p.triangles, true);
    start += p.triangles;
  });

  const volumeTotal = facts.reduce((n, f) => n + f.volume, 0);
  const areaTotal = facts.reduce((n, f) => n + f.area, 0);
  const byVolume = volumeTotal > 1e-6;
  const compiled: CompiledPart[] = parts.map((p, n) => {
    const f = facts[n];
    const share = byVolume ? f.volume / volumeTotal : areaTotal > 0 ? f.area / areaTotal : 0;
    return {
      n,
      name: p.name,
      triangles: p.triangles,
      bbox_mm: f.bbox.map(r3) as CompiledPart['bbox_mm'],
      share: Math.round(share * 10_000) / 10_000,
      volume_mm3: Math.round(f.volume * 100) / 100,
      ...(p.colour ? { colour: p.colour } : {}),
      ...(p.extruder !== undefined ? { extruder: p.extruder } : {}),
    };
  });
  return {
    lvm,
    parts: compiled,
    triangles: total,
    dims_mm: [r3(all[3] - all[0]), r3(all[4] - all[1]), r3(all[5] - all[2])] as [number, number, number],
    bbox_mm: all.map(r3) as CompiledPart['bbox_mm'],
    snap_mm: Math.round(snap * 1e6) / 1e6,
  };
}

// --------------------------------------------------------- reading a mesh

const isLvm1 = (b: Uint8Array) => b.byteLength >= HEADER_BYTES && LVM1.every((v, i) => b[i] === v);

/**
 * The part ranges of a compiled mesh, or null — for bytes that are not LVM1,
 * a mesh with no trailer, or a trailer whose ranges are not contiguous in
 * order and do not cover exactly the mesh's triangles.
 */
export function readLvr1(bytes: Uint8Array): { triangles: number; ranges: Array<[start: number, count: number]> } | null {
  if (!isLvm1(bytes)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = dv.getUint32(4, true);
  const at = HEADER_BYTES + triangles * TRIANGLE_BYTES;
  if (bytes.byteLength < at + 8 || !LVR1.every((v, i) => bytes[at + i] === v)) return null;
  const count = dv.getUint16(at + 4, true);
  if (dv.getUint16(at + 6, true) !== 0 || bytes.byteLength < at + 8 + count * 8) return null;
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const start = dv.getUint32(at + 8 + i * 8, true);
    const n = dv.getUint32(at + 12 + i * 8, true);
    if (start !== cursor || cursor + n > triangles) return null;
    ranges.push([start, n]);
    cursor += n;
  }
  return cursor === triangles ? { triangles, ranges } : null;
}

/**
 * THE PUBLIC COPY: the mesh without the hidden parts. Their triangles are
 * removed by range copy; every part keeps its index (a hidden one stays in
 * the trailer with count 0); the header bbox is recomputed over what remains;
 * coordinates are not re-centred. Indices outside the trailer are ignored. A
 * mesh with no trailer is one part. Throws for bytes that are not LVM1.
 */
export function withoutParts(lvm: Uint8Array, hidden: readonly number[]): Uint8Array {
  if (!isLvm1(lvm)) throw new TypeError('withoutParts: not an LVM1 mesh');
  const dvIn = new DataView(lvm.buffer, lvm.byteOffset, lvm.byteLength);
  const total = dvIn.getUint32(4, true);
  if (lvm.byteLength < HEADER_BYTES + total * TRIANGLE_BYTES) throw new TypeError('withoutParts: truncated mesh');
  const ranges = readLvr1(lvm)?.ranges ?? [[0, total] as [number, number]];
  const hide = new Set(hidden.filter((i) => Number.isInteger(i) && i >= 0 && i < ranges.length));
  const kept = ranges.reduce((n, [, count], i) => (hide.has(i) ? n : n + count), 0);

  const trailerAt = HEADER_BYTES + kept * TRIANGLE_BYTES;
  const out = new Uint8Array(trailerAt + 8 + ranges.length * 8);
  const dv = new DataView(out.buffer);
  let cursor = 0;
  ranges.forEach(([start, count], i) => {
    dv.setUint32(trailerAt + 8 + i * 8, cursor, true);
    if (hide.has(i)) return; // count stays 0
    dv.setUint32(trailerAt + 12 + i * 8, count, true);
    out.set(lvm.subarray(HEADER_BYTES + start * TRIANGLE_BYTES, HEADER_BYTES + (start + count) * TRIANGLE_BYTES), HEADER_BYTES + cursor * TRIANGLE_BYTES);
    cursor += count;
  });

  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < kept * 9; i++) {
    const v = dv.getFloat32(HEADER_BYTES + i * 4, true);
    const k = i % 3;
    if (v < box[k]) box[k] = v;
    if (v > box[k + 3]) box[k + 3] = v;
  }
  out.set(LVM1, 0);
  dv.setUint32(4, kept, true);
  for (let k = 0; k < 6; k++) dv.setFloat32(8 + k * 4, kept > 0 ? box[k] : 0, true);
  out.set(LVR1, trailerAt);
  dv.setUint16(trailerAt + 4, ranges.length, true);
  dv.setUint16(trailerAt + 6, 0, true);
  return out;
}

// ------------------------------------------------------------ the storage

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('MESH_TOO_LARGE');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** gzip through CompressionStream (Workers and Node 22 alike; zlib's default level). */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return drain(streamOf(bytes).pipeThrough(new CompressionStream('gzip')), Number.POSITIVE_INFINITY);
}

/** gunzip through DecompressionStream, refusing (`MESH_TOO_LARGE`) past `maxBytes` of output. */
export async function gunzipBytes(bytes: Uint8Array, maxBytes = MESH_INFLATE_MAX_BYTES): Promise<Uint8Array> {
  return drain(streamOf(bytes).pipeThrough(new DecompressionStream('gzip')), maxBytes);
}

/** SHA-256 hex of the (uncompressed) mesh — the content address of its stored keys. */
export async function meshHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One key segment, as `buildMediaKey` admits them (worker/lib/mediaStorage.ts). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const HASH = /^[0-9a-f]{12,64}$/;

function segment(value: string, what: string): string {
  if (!SEGMENT.test(value)) throw new Error(`Invalid mesh key ${what}`);
  return value;
}

/**
 * `merchants/<uid>/public/bp/<blueprintId>-r<rev>-<hash12>.lvm.gz` — the
 * live revision's public mesh. Public by prefix (`isAnonymousPublicMediaKey`),
 * content-addressed, so `/files/*` may promise `immutable` and the edge may
 * keep it; a republished mesh is a new key, never an overwrite.
 */
export function publicMeshKey(userId: string, blueprintId: string, rev: number, hash: string): string {
  if (!Number.isInteger(rev) || rev < 1) throw new Error('Invalid mesh key revision');
  if (!HASH.test(hash)) throw new Error('Invalid mesh key hash');
  return `merchants/${segment(userId, 'owner')}/public/bp/${segment(blueprintId, 'blueprint')}-r${rev}-${hash.slice(0, 12)}.lvm.gz`;
}

/**
 * `merchants/<uid>/blueprints/<productId>-<hash12>.lvm.gz` — the merchant's
 * full draft mesh (every part, hidden ones included). PRIVATE: not a public
 * prefix and not one `/files/*` gates, so the public reader answers 404 and
 * only the builder's owner-checked route serves it.
 */
export function draftMeshKey(userId: string, productId: string, hash: string): string {
  if (!HASH.test(hash)) throw new Error('Invalid mesh key hash');
  return `merchants/${segment(userId, 'owner')}/blueprints/${segment(productId, 'product')}-${hash.slice(0, 12)}.lvm.gz`;
}
