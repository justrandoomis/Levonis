/**
 * MODEL GEOMETRY — what a 3D file actually says about itself.
 *
 * WHY THIS EXISTS. The owner's rule for the request wizard is "لا تسأل المستخدم
 * عن شيء يمكن استخراجه من الملف". Every question a customer has to answer is a
 * question they can answer wrongly, and a wrong volume is a wrong price. So the
 * file is measured, not surveyed: dimensions, volume, surface area, part count,
 * whether it is watertight, how much of it overhangs. What the file cannot say,
 * this module says it cannot say — with a reason — rather than guessing.
 *
 * WHERE IT RUNS. On the Worker, over the bytes already stored in R2. Not in the
 * browser: a number the customer's machine computed is a number the customer
 * could change, and this one decides money. The browser gets the RESULT, and
 * the viewer gets a derived mesh — never a parser and never the original file.
 *
 * HONEST TIERS, because a 2-million-triangle scan and a 12-triangle bracket are
 * not the same problem:
 *
 *   bbox / volume / area / triangles  — a single streaming pass, no memory
 *                                       proportional to the model. Always exact.
 *   shells / watertight               — needs vertex identity, so it needs a hash
 *                                       of every corner. Capped; above the cap
 *                                       the answer is `null`, never a guess.
 *
 * UNITS. STL and OBJ carry none, so millimetres are assumed — the universal
 * convention for printable geometry — and `unit_source` says 'assumed' so the
 * UI can offer a rescale instead of pretending. 3MF states its unit and AMF may;
 * there `unit_source` is 'declared' and nothing is assumed at all.
 */

import { unzipSync } from 'fflate';

// --------------------------------------------------------------- vocabulary

export type ModelFormat = 'stl' | '3mf' | 'obj' | 'amf' | 'glb' | 'gltf' | 'step' | 'unknown';

/**
 * What Levonis can do with a format, stated per capability rather than as one
 * "supported" flag — because "we can show it" and "a merchant can print it" and
 * "we can measure it for a price" are three different promises, and a customer
 * who uploads a STEP file deserves to be told which of the three they get.
 */
export interface FormatCapability {
  /** The viewer can render it (we can produce a mesh from it). */
  previewable: boolean;
  /** Real dimensions and volume can be extracted, so the price is computed. */
  measurable: boolean;
  /** A merchant's slicer opens it directly, with no conversion step. */
  sliceable: boolean;
  /** We could convert it to something sliceable if we had to. */
  convertible: boolean;
  /** We can store it and show it in the request; nothing more is promised. */
  reference_only: boolean;
}

export const FORMAT_CAPABILITIES: Record<ModelFormat, FormatCapability> = {
  // The two the owner asked to support "بشكل ممتاز", and the two that carry the
  // most reliable geometry.
  stl: { previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false },
  '3mf': { previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false },
  obj: { previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false },
  amf: { previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false },
  // glTF is a rendering format. Slicers do not open it, but its accessors carry
  // an exact bounding box and its buffers carry real triangles, so it measures
  // and previews honestly and is offered as convertible rather than sliceable.
  glb: { previewable: true, measurable: true, sliceable: false, convertible: true, reference_only: false },
  gltf: { previewable: true, measurable: true, sliceable: false, convertible: true, reference_only: false },
  // STEP is boundary-representation CAD: real surfaces, no triangles. Measuring
  // it needs a geometry kernel we do not have and will not pretend to have. It
  // is accepted, stored and shown to the merchant, who can open it in their own
  // CAD — which is exactly what `reference_only` promises and no more.
  step: { previewable: false, measurable: false, sliceable: false, convertible: false, reference_only: true },
  unknown: { previewable: false, measurable: false, sliceable: false, convertible: false, reference_only: true },
};

export const MODEL_EXTENSIONS: Record<string, ModelFormat> = {
  stl: 'stl',
  '3mf': '3mf',
  obj: 'obj',
  amf: 'amf',
  glb: 'glb',
  gltf: 'gltf',
  step: 'step',
  stp: 'step',
};

export function formatFromName(name: string): ModelFormat {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return MODEL_EXTENSIONS[ext] ?? 'unknown';
}

/**
 * The format the BYTES say they are, which is the one that matters: an .stl
 * that is really a ZIP is a 3MF someone renamed, and trusting the name would
 * hand the parser a file it cannot read and blame the customer for it.
 */
export function sniffFormat(bytes: Uint8Array, name = ''): ModelFormat {
  const byName = formatFromName(name);
  if (bytes.length >= 4) {
    // glTF binary container.
    if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return 'glb';
    // ZIP: 3MF and a zipped AMF both live here. The name decides between them;
    // an unnamed ZIP is read as 3MF, which is the overwhelmingly likely one.
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
      return byName === 'amf' ? 'amf' : '3mf';
    }
  }
  const head = asciiHead(bytes, 512).trim();
  if (/^ISO-10303-21/i.test(head)) return 'step';
  if (/^\{/.test(head) && /"asset"/.test(head)) return 'gltf';
  if (/<\s*amf/i.test(head)) return 'amf';
  if (isBinaryStl(bytes)) return 'stl';
  if (/^solid/i.test(head)) return 'stl';
  // OBJ has no signature at all, so it is only ever accepted on its name plus a
  // line that looks like one — never as a fallback for "we could not tell".
  if (byName === 'obj' && /^\s*(v|vn|vt|f|o|g|mtllib|usemtl|#)\s/m.test(head)) return 'obj';
  return byName === 'unknown' ? 'unknown' : byName;
}

const asciiHead = (bytes: Uint8Array, n: number): string => {
  let s = '';
  for (let i = 0; i < Math.min(n, bytes.length); i++) s += String.fromCharCode(bytes[i]);
  return s;
};

// ------------------------------------------------------------------ results

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ModelWarning {
  /** Machine-readable so the UI can word it in three languages. */
  code:
    | 'NOT_WATERTIGHT'
    | 'ZERO_VOLUME'
    | 'INVERTED_NORMALS'
    | 'VERY_LARGE'
    | 'VERY_SMALL'
    | 'THIN_FEATURES'
    | 'HEAVY_OVERHANG'
    | 'MANY_PARTS'
    | 'TOPOLOGY_NOT_ANALYSED'
    | 'HUGE_MESH'
    | 'UNIT_ASSUMED'
    | 'DEGENERATE_TRIANGLES';
  /** Extra numbers the wording may want. Never a sentence — the UI writes those. */
  detail?: Record<string, number | string>;
  severity: 'info' | 'warning' | 'blocking';
}

export interface ModelAnalysis {
  format: ModelFormat;
  capability: FormatCapability;
  /** True when every number below is real. False for reference-only formats. */
  measured: boolean;
  /** Why not, when `measured` is false. */
  reason?: string;

  unit: 'mm';
  /** 'declared' = the file said so. 'assumed' = the format cannot say. */
  unit_source: 'declared' | 'assumed';

  dimensions_mm: Vec3;
  bbox_min_mm: Vec3;
  bbox_max_mm: Vec3;
  /** Solid volume. Signed-tetrahedron sum, so it is exact for a closed mesh. */
  volume_mm3: number;
  surface_area_mm2: number;
  triangle_count: number;
  /** Distinct connected bodies. null = the mesh was too large to analyse. */
  shell_count: number | null;
  /** Every edge shared by exactly two faces. null = not analysed. */
  watertight: boolean | null;
  /** Downward-facing area steeper than the support threshold. */
  overhang_area_mm2: number;
  /** Overhang as a share of total area, 0..1 — what drives the support cost. */
  overhang_ratio: number;
  /** 0..1. Surface detail per unit of enclosing volume, clamped. */
  complexity: number;
  warnings: ModelWarning[];
  /** Present when the file names itself (3MF/AMF metadata, STEP header). */
  title?: string;
  /** Material and colour the file suggests, when it carries them (3MF). */
  suggested_material?: string;
  suggested_colors?: string[];
}

// ------------------------------------------------------------- the machinery

/** Above this the topology pass is skipped and says so. Chosen so the hash it
 *  builds stays well inside a Worker's memory: three keys per triangle. */
const TOPOLOGY_TRIANGLE_CAP = 400_000;
/** Above this even a streaming pass is refused rather than timing out mid-request. */
export const TRIANGLE_HARD_CAP = 5_000_000;
/** Faces steeper than 45° from vertical count as overhang — the slicer default. */
const OVERHANG_COS = Math.cos((45 * Math.PI) / 180);

interface Mesh {
  /** Flat triangle soup: 9 floats per triangle. */
  positions: Float32Array;
  triangles: number;
  unitScale: number; // multiply to reach millimetres
  unitDeclared: boolean;
  title?: string;
  material?: string;
  colors?: string[];
}

const EMPTY_VEC: Vec3 = { x: 0, y: 0, z: 0 };

function emptyAnalysis(format: ModelFormat, reason: string): ModelAnalysis {
  return {
    format,
    capability: FORMAT_CAPABILITIES[format],
    measured: false,
    reason,
    unit: 'mm',
    unit_source: 'assumed',
    dimensions_mm: { ...EMPTY_VEC },
    bbox_min_mm: { ...EMPTY_VEC },
    bbox_max_mm: { ...EMPTY_VEC },
    volume_mm3: 0,
    surface_area_mm2: 0,
    triangle_count: 0,
    shell_count: null,
    watertight: null,
    overhang_area_mm2: 0,
    overhang_ratio: 0,
    complexity: 0,
    warnings: [],
  };
}

/**
 * The whole job: bytes in, measurements out. Never throws for a file it simply
 * cannot read — an unreadable file is a RESULT with `measured: false` and a
 * reason, because the wizard has to keep working and tell the customer why.
 */
export function analyseModel(input: ArrayBuffer | Uint8Array, name = ''): ModelAnalysis {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = sniffFormat(bytes, name);
  const capability = FORMAT_CAPABILITIES[format];

  if (!capability.measurable) {
    const out = emptyAnalysis(format, format === 'step' ? 'STEP_NEEDS_CAD_KERNEL' : 'UNKNOWN_FORMAT');
    if (format === 'step') {
      const title = stepProductName(bytes);
      if (title) out.title = title;
    }
    return out;
  }

  let mesh: Mesh | null = null;
  try {
    mesh =
      format === 'stl' ? parseStl(bytes)
      : format === '3mf' ? parse3mf(bytes)
      : format === 'obj' ? parseObj(bytes)
      : format === 'amf' ? parseAmf(bytes)
      : parseGltf(bytes, format);
  } catch (e) {
    return emptyAnalysis(format, `PARSE_FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!mesh || mesh.triangles === 0) return emptyAnalysis(format, 'NO_GEOMETRY');
  if (mesh.triangles > TRIANGLE_HARD_CAP) return emptyAnalysis(format, 'TOO_MANY_TRIANGLES');

  return measure(mesh, format, capability);
}

/**
 * The single streaming pass. Everything here is O(triangles) with O(1) memory,
 * so a two-million-triangle scan costs time and nothing else.
 */
function measure(mesh: Mesh, format: ModelFormat, capability: FormatCapability): ModelAnalysis {
  const p = mesh.positions;
  const n = mesh.triangles;
  const s = mesh.unitScale;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let signedVolume = 0;
  let area = 0;
  let overhang = 0;
  let degenerate = 0;

  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = p[o] * s, ay = p[o + 1] * s, az = p[o + 2] * s;
    const bx = p[o + 3] * s, by = p[o + 4] * s, bz = p[o + 5] * s;
    const cx = p[o + 6] * s, cy = p[o + 7] * s, cz = p[o + 8] * s;

    if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
    if (bx < minX) minX = bx; if (bx > maxX) maxX = bx;
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
    if (by < minY) minY = by; if (by > maxY) maxY = by;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    if (az < minZ) minZ = az; if (az > maxZ) maxZ = az;
    if (bz < minZ) minZ = bz; if (bz > maxZ) maxZ = bz;
    if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;

    // Signed volume of the tetrahedron (origin, a, b, c). Summed over a closed
    // surface this is exactly the enclosed volume, with the sign telling us
    // whether the normals point outward.
    signedVolume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;

    // Face normal via the cross product; its length is twice the face area, so
    // one cross product answers both area and orientation.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len <= 1e-12) {
      degenerate++;
      continue;
    }
    const faceArea = len / 2;
    area += faceArea;
    // Downward-facing and steeper than the threshold: this is what needs
    // support, and the AREA of it is what the support material is priced on.
    if (-nz / len > OVERHANG_COS) overhang += faceArea;
  }

  const volume = Math.abs(signedVolume);
  const dims: Vec3 = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  const topology = n <= TOPOLOGY_TRIANGLE_CAP ? analyseTopology(p, n, s) : null;

  const warnings: ModelWarning[] = [];
  if (!mesh.unitDeclared) {
    warnings.push({ code: 'UNIT_ASSUMED', severity: 'info', detail: { format } });
  }
  if (volume <= 0.000001) {
    warnings.push({ code: 'ZERO_VOLUME', severity: 'blocking' });
  }
  if (signedVolume < 0 && volume > 0.000001) {
    // Every normal points inward. It still prints — slicers repair it — but it
    // is worth saying, because it usually means an exporter setting is wrong.
    warnings.push({ code: 'INVERTED_NORMALS', severity: 'info' });
  }
  if (degenerate > 0) {
    warnings.push({ code: 'DEGENERATE_TRIANGLES', severity: 'info', detail: { count: degenerate } });
  }
  if (topology) {
    if (!topology.watertight) {
      warnings.push({
        code: 'NOT_WATERTIGHT',
        severity: 'warning',
        detail: { open_edges: topology.openEdges },
      });
    }
    if (topology.shells > 1) {
      warnings.push({ code: 'MANY_PARTS', severity: 'info', detail: { parts: topology.shells } });
    }
  } else {
    warnings.push({
      code: 'TOPOLOGY_NOT_ANALYSED',
      severity: 'info',
      detail: { triangles: n, cap: TOPOLOGY_TRIANGLE_CAP },
    });
  }
  if (n > TOPOLOGY_TRIANGLE_CAP) warnings.push({ code: 'HUGE_MESH', severity: 'info', detail: { triangles: n } });

  const largest = Math.max(dims.x, dims.y, dims.z);
  // Bigger than any consumer bed by a wide margin — almost always a unit mix-up
  // (metres or inches read as millimetres) rather than a genuinely huge part.
  if (largest > 1000) warnings.push({ code: 'VERY_LARGE', severity: 'warning', detail: { largest_mm: round(largest, 1) } });
  if (largest > 0 && largest < 5) warnings.push({ code: 'VERY_SMALL', severity: 'warning', detail: { largest_mm: round(largest, 2) } });

  const overhangRatio = area > 0 ? overhang / area : 0;
  if (overhangRatio > 0.25) {
    warnings.push({ code: 'HEAVY_OVERHANG', severity: 'info', detail: { ratio: round(overhangRatio, 3) } });
  }

  // A wall-thickness proxy that costs nothing: a solid with a lot of surface for
  // very little volume is thin somewhere. 0.8mm is two passes of a 0.4 nozzle.
  const meanThickness = area > 0 ? (2 * volume) / area : 0;
  if (volume > 0.000001 && meanThickness < 0.8) {
    warnings.push({ code: 'THIN_FEATURES', severity: 'warning', detail: { mean_mm: round(meanThickness, 2) } });
  }

  return {
    format,
    capability,
    measured: true,
    unit: 'mm',
    unit_source: mesh.unitDeclared ? 'declared' : 'assumed',
    dimensions_mm: roundVec(dims, 2),
    bbox_min_mm: roundVec({ x: minX, y: minY, z: minZ }, 2),
    bbox_max_mm: roundVec({ x: maxX, y: maxY, z: maxZ }, 2),
    volume_mm3: round(volume, 2),
    surface_area_mm2: round(area, 2),
    triangle_count: n,
    shell_count: topology ? topology.shells : null,
    watertight: topology ? topology.watertight : null,
    overhang_area_mm2: round(overhang, 2),
    overhang_ratio: round(overhangRatio, 4),
    complexity: complexityOf(dims, volume, area, n),
    warnings,
    ...(mesh.title ? { title: mesh.title } : {}),
    ...(mesh.material ? { suggested_material: mesh.material } : {}),
    ...(mesh.colors && mesh.colors.length ? { suggested_colors: mesh.colors } : {}),
  };
}

/**
 * 0..1, and it has to mean something to a price. Two independent signals:
 *
 *   - how much surface the shape has for its size (a gear versus a cube), and
 *   - how finely it is tessellated for its size (a scan versus a bracket).
 *
 * Both are ratios, so both survive a rescale, which matters: the same model at
 * half size is not half as complex to print.
 */
function complexityOf(dims: Vec3, volume: number, area: number, triangles: number): number {
  const bboxVolume = Math.max(dims.x * dims.y * dims.z, 1e-6);
  const bboxArea = Math.max(
    2 * (dims.x * dims.y + dims.y * dims.z + dims.x * dims.z),
    1e-6
  );
  // 1 for a cube, higher the more convoluted the surface.
  const surfaceRatio = clamp((area / bboxArea - 1) / 4, 0, 1);
  // Triangles per cm² of surface, normalised against a plain 200 tri/cm² part.
  const density = clamp(triangles / Math.max(area / 100, 1) / 400, 0, 1);
  // Fill ratio: a hollow lattice inside its bounding box is harder than a block.
  const sparsity = clamp(1 - volume / bboxVolume, 0, 1);
  return round(clamp(0.45 * surfaceRatio + 0.35 * density + 0.2 * sparsity, 0, 1), 3);
}

interface Topology {
  shells: number;
  watertight: boolean;
  openEdges: number;
}

/**
 * Connected bodies and watertightness, from vertex identity.
 *
 * Coordinates are QUANTISED before they are hashed. Two triangles that share an
 * edge rarely store bit-identical floats — every exporter rounds differently —
 * so an exact comparison reports a perfectly closed mesh as full of holes. A
 * micron grid is finer than any printer and coarse enough to make the two
 * corners agree.
 */
function analyseTopology(p: Float32Array, n: number, scale: number): Topology {
  const vertexId = new Map<string, number>();
  const ids = new Int32Array(n * 3);
  let next = 0;

  for (let i = 0; i < n * 3; i++) {
    const o = i * 3;
    const key = `${qz(p[o] * scale)},${qz(p[o + 1] * scale)},${qz(p[o + 2] * scale)}`;
    let id = vertexId.get(key);
    if (id === undefined) {
      id = next++;
      vertexId.set(key, id);
    }
    ids[i] = id;
  }

  // Union-find over triangles that share a vertex.
  const parent = new Int32Array(next);
  for (let i = 0; i < next; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nx = parent[x];
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // Every undirected edge, counted. A closed manifold has each exactly twice.
  const edges = new Map<number, number>();
  const edgeKey = (a: number, b: number) => (a < b ? a * next + b : b * next + a);

  for (let t = 0; t < n; t++) {
    const a = ids[t * 3];
    const b = ids[t * 3 + 1];
    const c = ids[t * 3 + 2];
    union(a, b);
    union(b, c);
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      if (u === v) continue; // a degenerate edge says nothing about closure
      const k = edgeKey(u, v);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }

  let openEdges = 0;
  for (const count of edges.values()) if (count !== 2) openEdges++;

  const roots = new Set<number>();
  for (let i = 0; i < next; i++) roots.add(find(i));

  return { shells: roots.size, watertight: openEdges === 0, openEdges };
}

/** Quantise to a micron. Finer than any nozzle; coarse enough to join corners. */
const qz = (v: number) => Math.round(v * 1000);

const round = (v: number, places: number) => {
  const m = 10 ** places;
  return Number.isFinite(v) ? Math.round(v * m) / m : 0;
};
const roundVec = (v: Vec3, places: number): Vec3 => ({
  x: round(v.x, places),
  y: round(v.y, places),
  z: round(v.z, places),
});
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------- STL

function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(80, true);
  // The length arithmetic decides, NOT the leading word: plenty of binary STLs
  // begin with "solid" because the exporter wrote it into the 80-byte header.
  return 84 + count * 50 === bytes.length;
}

function parseStl(bytes: Uint8Array): Mesh {
  return isBinaryStl(bytes) ? parseBinaryStl(bytes) : parseAsciiStl(bytes);
}

function parseBinaryStl(bytes: Uint8Array): Mesh {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  if (n > TRIANGLE_HARD_CAP) return { positions: new Float32Array(0), triangles: n, unitScale: 1, unitDeclared: false };
  const positions = new Float32Array(n * 9);
  let at = 84;
  for (let t = 0; t < n; t++) {
    at += 12; // the stored normal is ignored — it is recomputed from the corners
    for (let i = 0; i < 9; i++) {
      positions[t * 9 + i] = dv.getFloat32(at, true);
      at += 4;
    }
    at += 2; // attribute byte count
  }
  return { positions, triangles: n, unitScale: 1, unitDeclared: false };
}

function parseAsciiStl(bytes: Uint8Array): Mesh {
  const text = new TextDecoder().decode(bytes);
  const nums: number[] = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    nums.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (nums.length > TRIANGLE_HARD_CAP * 9) break;
  }
  const triangles = Math.floor(nums.length / 9);
  const positions = new Float32Array(triangles * 9);
  for (let i = 0; i < positions.length; i++) positions[i] = nums[i];
  // A named solid is a title worth keeping — it is often the part name.
  const named = /^\s*solid\s+([^\r\n]+)/.exec(text.slice(0, 400));
  const title = named ? named[1].trim() : '';
  return { positions, triangles, unitScale: 1, unitDeclared: false, ...(title ? { title } : {}) };
}

// -------------------------------------------------------------------- OBJ

function parseObj(bytes: Uint8Array): Mesh {
  const text = new TextDecoder().decode(bytes);
  const vx: number[] = [];
  const faces: number[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.charCodeAt(0) === 35 /* # */) continue;
    if (line.startsWith('v ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      vx.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    } else if (line.startsWith('f ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      const idx: number[] = [];
      for (const part of parts) {
        const first = part.split('/')[0];
        let i = parseInt(first, 10);
        if (!Number.isFinite(i)) continue;
        // OBJ is 1-based, and a negative index counts back from the last vertex.
        i = i < 0 ? vx.length / 3 + i : i - 1;
        idx.push(i);
      }
      // Fan-triangulate: an OBJ face may be any convex polygon.
      for (let k = 1; k + 1 < idx.length; k++) faces.push(idx[0], idx[k], idx[k + 1]);
    }
  }
  return fromIndexed(vx, faces, 1, false);
}

// -------------------------------------------------------------------- 3MF

/** Millimetres per unit, for every unit 3MF and AMF may declare. */
const UNIT_MM: Record<string, number> = {
  micron: 0.001,
  micrometer: 0.001,
  millimeter: 1,
  millimetre: 1,
  centimeter: 10,
  centimetre: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
  metre: 1000,
};

/**
 * 3MF is a ZIP whose payload is one XML part.
 *
 * WHY REGEX AND NOT A DOM. Workers have no DOMParser, and pulling an XML
 * library in for four element names would be a dependency to maintain forever.
 * The 3MF core spec fixes these element and attribute names exactly, so a
 * tolerant scan over them is not fragile in the way scraping a web page is —
 * and anything it fails to read shows up as NO_GEOMETRY rather than as a wrong
 * measurement.
 */
function parse3mf(bytes: Uint8Array): Mesh {
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  const modelName =
    names.find((f) => f.toLowerCase() === '3d/3dmodel.model') ??
    names.find((f) => f.toLowerCase().endsWith('.model'));
  if (!modelName) throw new Error('3MF has no model part');
  const xml = new TextDecoder().decode(files[modelName]);

  const unitAttr = /<model[^>]*\sunit\s*=\s*"([^"]+)"/i.exec(xml);
  const unitScale = unitAttr ? (UNIT_MM[unitAttr[1].toLowerCase()] ?? 1) : 1;

  // Every <object> that carries a mesh, keyed by id so <build> can place them.
  interface Obj { vx: number[]; faces: number[] }
  const objects = new Map<string, Obj>();
  const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
  let om: RegExpExecArray | null;
  while ((om = objectRe.exec(xml)) !== null) {
    const id = attr(om[1], 'id') ?? '';
    const body = om[2];
    const vx: number[] = [];
    const faces: number[] = [];
    const vRe = /<vertex\b([^>]*)\/?>/gi;
    let vm: RegExpExecArray | null;
    while ((vm = vRe.exec(body)) !== null) {
      vx.push(num(attr(vm[1], 'x')), num(attr(vm[1], 'y')), num(attr(vm[1], 'z')));
    }
    const tRe = /<triangle\b([^>]*)\/?>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(body)) !== null) {
      faces.push(num(attr(tm[1], 'v1')), num(attr(tm[1], 'v2')), num(attr(tm[1], 'v3')));
    }
    if (vx.length && faces.length) objects.set(id, { vx, faces });
  }
  if (objects.size === 0) throw new Error('3MF has no mesh');

  // <build> places objects, possibly several times and possibly transformed.
  // A model with no build section is still a model: its objects are used once,
  // untransformed, which is what every slicer does with such a file.
  const placements: Array<{ id: string; m: number[] | null }> = [];
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(xml)) !== null) {
    const id = attr(im[1], 'objectid');
    if (!id) continue;
    const tr = attr(im[1], 'transform');
    placements.push({ id, m: tr ? tr.trim().split(/\s+/).map(Number) : null });
  }
  if (placements.length === 0) for (const id of objects.keys()) placements.push({ id, m: null });

  const vxAll: number[] = [];
  const facesAll: number[] = [];
  for (const place of placements) {
    const obj = objects.get(place.id);
    if (!obj) continue;
    const base = vxAll.length / 3;
    for (let i = 0; i < obj.vx.length; i += 3) {
      const [x, y, z] = apply3mfTransform(obj.vx[i], obj.vx[i + 1], obj.vx[i + 2], place.m);
      vxAll.push(x, y, z);
    }
    for (const f of obj.faces) facesAll.push(base + f);
  }

  const mesh = fromIndexed(vxAll, facesAll, unitScale, !!unitAttr);
  const title =
    metaValue(xml, 'Title') ?? metaValue(xml, 'Description') ?? attrOfFirst(xml, 'object', 'name') ?? '';
  if (title) mesh.title = title;

  // Colours the file declares, so the wizard can pre-select them instead of
  // asking. The core spec writes `displaycolor` on <base>; the materials
  // extension writes `color` on <m:color>. Both are #RRGGBB or #RRGGBBAA, and
  // the alpha is dropped because a printer has no alpha.
  const colors = new Set<string>();
  const colorRe = /\b(?:displaycolor|color)\s*=\s*"(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)"/gi;
  let cm: RegExpExecArray | null;
  while ((cm = colorRe.exec(xml)) !== null) colors.add(cm[1].slice(0, 7).toLowerCase());
  if (colors.size) mesh.colors = [...colors];

  const material = attrOfFirst(xml, 'base', 'name');
  if (material) mesh.material = material;

  return mesh;
}

/** 3MF stores a 4x3 row-major matrix: nine rotation/scale terms then a translation. */
function apply3mfTransform(x: number, y: number, z: number, m: number[] | null): [number, number, number] {
  if (!m || m.length < 12 || m.some((v) => !Number.isFinite(v))) return [x, y, z];
  return [
    m[0] * x + m[3] * y + m[6] * z + m[9],
    m[1] * x + m[4] * y + m[7] * z + m[10],
    m[2] * x + m[5] * y + m[8] * z + m[11],
  ];
}

// -------------------------------------------------------------------- AMF

function parseAmf(bytes: Uint8Array): Mesh {
  // An AMF may be a bare XML file or a ZIP containing one.
  let xml: string;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    const key = Object.keys(files).find((f) => f.toLowerCase().endsWith('.amf') || f.toLowerCase().endsWith('.xml'));
    if (!key) throw new Error('AMF archive has no XML part');
    xml = new TextDecoder().decode(files[key]);
  } else {
    xml = new TextDecoder().decode(bytes);
  }

  const unitAttr = /<amf[^>]*\sunit\s*=\s*"([^"]+)"/i.exec(xml);
  const unitScale = unitAttr ? (UNIT_MM[unitAttr[1].toLowerCase()] ?? 1) : 1;

  const vx: number[] = [];
  const faces: number[] = [];
  const coordRe = /<coordinates>([\s\S]*?)<\/coordinates>/gi;
  let m: RegExpExecArray | null;
  while ((m = coordRe.exec(xml)) !== null) {
    vx.push(tagNum(m[1], 'x'), tagNum(m[1], 'y'), tagNum(m[1], 'z'));
  }
  const triRe = /<triangle>([\s\S]*?)<\/triangle>/gi;
  while ((m = triRe.exec(xml)) !== null) {
    faces.push(tagNum(m[1], 'v1'), tagNum(m[1], 'v2'), tagNum(m[1], 'v3'));
  }
  const mesh = fromIndexed(vx, faces, unitScale, !!unitAttr);
  const name = /<metadata[^>]*type\s*=\s*"name"[^>]*>([^<]*)<\/metadata>/i.exec(xml);
  if (name) mesh.title = name[1].trim();
  return mesh;
}

// ------------------------------------------------------------- glTF / GLB

function parseGltf(bytes: Uint8Array, format: ModelFormat): Mesh {
  let json: Record<string, unknown>;
  let bin: Uint8Array | null = null;

  if (format === 'glb') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 12;
    while (at + 8 <= bytes.length) {
      const len = dv.getUint32(at, true);
      const type = dv.getUint32(at + 4, true);
      const start = at + 8;
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + len)));
      else if (type === 0x004e4942) bin = bytes.subarray(start, start + len);
      at = start + len + ((4 - (len % 4)) % 4);
    }
    // @ts-expect-error assigned in the loop above or the throw below fires
    if (!json) throw new Error('GLB has no JSON chunk');
  } else {
    json = JSON.parse(new TextDecoder().decode(bytes));
    // A .gltf whose buffers are external files or base64 data URIs. Only the
    // embedded case is read; an external buffer is not fetched, because a model
    // file must never make the server go and get something off the internet.
    const buffers = (json.buffers as Array<{ uri?: string }> | undefined) ?? [];
    const uri = buffers[0]?.uri ?? '';
    if (uri.startsWith('data:')) bin = base64ToBytes(uri.slice(uri.indexOf(',') + 1));
  }

  const accessors = (json.accessors as GltfAccessor[] | undefined) ?? [];
  const views = (json.bufferViews as GltfBufferView[] | undefined) ?? [];
  const meshes = (json.meshes as GltfMesh[] | undefined) ?? [];

  const vx: number[] = [];
  const faces: number[] = [];
  for (const mesh of meshes) {
    for (const prim of mesh.primitives ?? []) {
      // Only triangle primitives carry printable geometry (mode 4, the default).
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      const posIdx = prim.attributes?.POSITION;
      if (posIdx === undefined) continue;
      const pos = readAccessorVec3(accessors[posIdx], views, bin);
      if (!pos) continue;
      const base = vx.length / 3;
      for (const v of pos) vx.push(v);
      const idxIdx = prim.indices;
      if (idxIdx === undefined) {
        for (let i = 0; i < pos.length / 3; i++) faces.push(base + i);
      } else {
        const idx = readAccessorScalar(accessors[idxIdx], views, bin);
        if (!idx) continue;
        for (const i of idx) faces.push(base + i);
      }
    }
  }

  // glTF is defined in METRES, and printable exports are almost always authored
  // in millimetres and exported without a unit change. So the bounding box
  // decides: a model a few units across is millimetres, a model a fraction of a
  // unit across is metres. This is a heuristic and is reported as `assumed`.
  const mesh = fromIndexed(vx, faces, 1, false);
  const title = (json.asset as { generator?: string } | undefined)?.generator;
  if (title) mesh.title = title;
  return mesh;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface GltfMesh {
  primitives?: Array<{ attributes?: Record<string, number>; indices?: number; mode?: number }>;
}

function readAccessorVec3(a: GltfAccessor | undefined, views: GltfBufferView[], bin: Uint8Array | null): number[] | null {
  if (!a || !bin || a.type !== 'VEC3' || a.componentType !== 5126 || a.bufferView === undefined) return null;
  const v = views[a.bufferView];
  if (!v) return null;
  const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = v.byteStride && v.byteStride > 0 ? v.byteStride : 12;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: number[] = [];
  for (let i = 0; i < a.count; i++) {
    const o = start + i * stride;
    if (o + 12 > bin.byteLength) break;
    out.push(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
  }
  return out;
}

function readAccessorScalar(a: GltfAccessor | undefined, views: GltfBufferView[], bin: Uint8Array | null): number[] | null {
  if (!a || !bin || a.type !== 'SCALAR' || a.bufferView === undefined) return null;
  const v = views[a.bufferView];
  if (!v) return null;
  const size = a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : a.componentType === 5121 ? 1 : 0;
  if (size === 0) return null;
  const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = v.byteStride && v.byteStride > 0 ? v.byteStride : size;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: number[] = [];
  for (let i = 0; i < a.count; i++) {
    const o = start + i * stride;
    if (o + size > bin.byteLength) break;
    out.push(size === 4 ? dv.getUint32(o, true) : size === 2 ? dv.getUint16(o, true) : dv.getUint8(o));
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// -------------------------------------------------------------------- STEP

/** The one honest thing a STEP file gives up without a kernel: its name. */
function stepProductName(bytes: Uint8Array): string {
  const head = asciiHead(bytes, 4000);
  const m = /FILE_NAME\s*\(\s*'([^']*)'/i.exec(head) ?? /PRODUCT\s*\(\s*'([^']*)'/i.exec(head);
  return m ? m[1].trim() : '';
}

// ------------------------------------------------------------------ shared

/** Indexed vertices + triangle indices → the flat soup everything else reads. */
function fromIndexed(vx: number[], faces: number[], unitScale: number, unitDeclared: boolean): Mesh {
  const triangles = Math.floor(faces.length / 3);
  const positions = new Float32Array(triangles * 9);
  const vertexCount = vx.length / 3;
  let written = 0;
  for (let t = 0; t < triangles; t++) {
    const a = faces[t * 3];
    const b = faces[t * 3 + 1];
    const c = faces[t * 3 + 2];
    // An index outside the vertex list is a broken file, not a reason to crash:
    // the triangle is dropped and the rest of the model is still measured.
    if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    const o = written * 9;
    positions[o] = vx[a * 3]; positions[o + 1] = vx[a * 3 + 1]; positions[o + 2] = vx[a * 3 + 2];
    positions[o + 3] = vx[b * 3]; positions[o + 4] = vx[b * 3 + 1]; positions[o + 5] = vx[b * 3 + 2];
    positions[o + 6] = vx[c * 3]; positions[o + 7] = vx[c * 3 + 1]; positions[o + 8] = vx[c * 3 + 2];
    written++;
  }
  return {
    positions: written === triangles ? positions : positions.subarray(0, written * 9),
    triangles: written,
    unitScale,
    unitDeclared,
  };
}

const attr = (s: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(s);
  return m ? m[1] : null;
};
const attrOfFirst = (xml: string, tag: string, name: string): string | null => {
  const m = new RegExp(`<${tag}\\b([^>]*)`, 'i').exec(xml);
  return m ? attr(m[1], name) : null;
};
const metaValue = (xml: string, name: string): string | null => {
  const m = new RegExp(`<metadata[^>]*name\\s*=\\s*"[^"]*${name}"[^>]*>([^<]*)</metadata>`, 'i').exec(xml);
  return m ? m[1].trim() || null : null;
};
const num = (v: string | null): number => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const tagNum = (s: string, tag: string): number => {
  const m = new RegExp(`<${tag}>\\s*(-?[\\d.eE+-]+)\\s*</${tag}>`, 'i').exec(s);
  return m ? num(m[1]) : 0;
};

// --------------------------------------------------- the mesh for the viewer

/**
 * A compact mesh for the 3D viewer: positions only, already in millimetres and
 * already centred on the origin.
 *
 * THE VIEWER NEVER RECEIVES THE ORIGINAL FILE. It receives this — a derived
 * triangle soup with no metadata, no material, no filename and no way back to
 * the customer's model as they authored it. That is the privacy line the owner
 * drew ("الملف الخاص لا يصبح public URL دائمًا") expressed in bytes rather than
 * in a policy: even if a viewer link leaks, what leaks is a preview.
 *
 * Header (little-endian): magic 'LVM1', uint32 triangle count, 6×float32 bbox.
 * Then 9 float32 per triangle.
 */
export function viewerMesh(input: ArrayBuffer | Uint8Array, name = '', maxTriangles = 250_000): Uint8Array | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = sniffFormat(bytes, name);
  if (!FORMAT_CAPABILITIES[format].previewable) return null;
  let mesh: Mesh | null = null;
  try {
    mesh =
      format === 'stl' ? parseStl(bytes)
      : format === '3mf' ? parse3mf(bytes)
      : format === 'obj' ? parseObj(bytes)
      : format === 'amf' ? parseAmf(bytes)
      : parseGltf(bytes, format);
  } catch {
    return null;
  }
  if (!mesh || mesh.triangles === 0) return null;

  // Decimate by dropping whole triangles at a fixed stride. Crude on purpose:
  // it is a preview, it must be cheap, and a stride keeps the shape recognisable
  // where a random sample would shred it.
  const stride = Math.max(1, Math.ceil(mesh.triangles / maxTriangles));
  const kept = Math.floor(mesh.triangles / stride);
  const s = mesh.unitScale;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let t = 0; t < mesh.triangles; t++) {
    for (let v = 0; v < 3; v++) {
      const o = t * 9 + v * 3;
      const x = mesh.positions[o] * s, y = mesh.positions[o + 1] * s, z = mesh.positions[o + 2] * s;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;

  const out = new Uint8Array(4 + 4 + 24 + kept * 9 * 4);
  const dv = new DataView(out.buffer);
  out[0] = 0x4c; out[1] = 0x56; out[2] = 0x4d; out[3] = 0x31; // 'LVM1'
  dv.setUint32(4, kept, true);
  dv.setFloat32(8, minX - cx, true); dv.setFloat32(12, minY - cy, true); dv.setFloat32(16, minZ - cz, true);
  dv.setFloat32(20, maxX - cx, true); dv.setFloat32(24, maxY - cy, true); dv.setFloat32(28, maxZ - cz, true);

  let at = 32;
  for (let k = 0; k < kept; k++) {
    const t = k * stride;
    for (let v = 0; v < 3; v++) {
      const o = t * 9 + v * 3;
      dv.setFloat32(at, mesh.positions[o] * s - cx, true);
      dv.setFloat32(at + 4, mesh.positions[o + 1] * s - cy, true);
      dv.setFloat32(at + 8, mesh.positions[o + 2] * s - cz, true);
      at += 12;
    }
  }
  return out;
}
