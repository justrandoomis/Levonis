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
import { zipBombFilter, ARCHIVE_INFLATE_CAP } from './attachments';

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
  /**
   * The part of that overhang that is lying ON THE BED — every downward face
   * at the model's lowest z.
   *
   * It is reported separately because it is the one overhang nothing supports:
   * the build plate is already under it. Without this figure a flat-bottomed
   * part is charged for supporting its own base, which is both wrong and
   * expensive — a 20 mm cube picks up a tenth of its own weight in support it
   * will never print.
   */
  bed_contact_area_mm2: number;
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
    bed_contact_area_mm2: 0,
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
  // The bed-contact pass has to wait for minZ, which is only known now. One
  // more sweep over the same buffer, no extra memory — the same budget the
  // topology pass below already spends.
  const bedContact = bedContactArea(p, n, s, minZ, dims.z);
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
    bed_contact_area_mm2: round(Math.min(bedContact, overhang), 2),
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
/**
 * Area of every downward-facing triangle lying flat at the model's lowest z —
 * the part that rests on the build plate.
 *
 * The tolerance scales with the model so a 500 mm print and a 5 mm one are
 * judged the same way, with a floor that keeps float noise in an exported STL
 * from splitting one flat face into "on the bed" and "just above it".
 */
function bedContactArea(p: Float32Array, n: number, s: number, minZ: number, heightMm: number): number {
  const tolerance = Math.max(0.05, heightMm * 1e-3);
  const ceiling = minZ + tolerance;
  let contact = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const az = p[o + 2] * s, bz = p[o + 5] * s, cz = p[o + 8] * s;
    if (az > ceiling || bz > ceiling || cz > ceiling) continue;
    const ax = p[o] * s, ay = p[o + 1] * s;
    const bx = p[o + 3] * s, by = p[o + 4] * s;
    const cx = p[o + 6] * s, cy = p[o + 7] * s;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len <= 1e-12) continue;
    if (-nz / len > OVERHANG_COS) contact += len / 2;
  }
  return contact;
}

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
  // Bounded before a byte is inflated (worker/lib/attachments.ts): a 3MF is a
  // ZIP, and a ZIP can declare gigabytes behind a few kilobytes.
  const files = unzipSync(bytes, { filter: zipBombFilter() });
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
    const files = unzipSync(bytes, { filter: zipBombFilter() });
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

// ===========================================================================
//  PARTS — the named pieces of a merchant's own model (Programme C, C1)
// ===========================================================================

/**
 * WHY A SECOND READER, AND WHY THE FIRST ONE IS NOT TOUCHED.
 *
 * `analyseModel` and `viewerMesh` answer "how big, how heavy, what does it look
 * like" for a customer's request and a merchant's product file, and those
 * answers are priced and pinned (tests/modelGeometry.test.ts,
 * tests/printQuoteGeometry.test.ts). They flatten a file into one anonymous
 * triangle soup — right for a price, useless for personalisation, which has to
 * know WHICH triangles are the body and which are the name plate.
 *
 * `parseModelParts` reads the same files for that other question and returns
 * the pieces separately: named and coloured as the file states them, in
 * millimetres, in the assembly frame with every transform composed. It shares
 * the low-level readers (the bounded ZIP reader, the STL and AMF readers, the
 * unit table) and nothing else, so every function above keeps its exact
 * output: a request file or a quote can never change because a blueprint
 * feature landed. A Bambu / Orca assembly — a root object whose
 * `<components>` point into `3D/Objects/*.model` — stays unmeasured for
 * `analyseModel`, exactly as before, and is read in full here.
 *
 * WHAT EACH FORMAT GIVES.
 *   3MF   every build item (printable ones), `<components>` followed through
 *         `p:path` into the package's other model parts with the transforms
 *         composed; names from the object, from Bambu/Orca's
 *         `Metadata/model_settings.config` (parts, subtypes, extruders) or
 *         PrusaSlicer's `Metadata/Slic3r_PE_model.config` (volumes as triangle
 *         ranges); colours from the extruder's filament (Bambu
 *         `project_settings.config`, Prusa `Slic3r_PE.config`), else from
 *         `<basematerials displaycolor>` / `<m:colorgroup color>`. Modifier,
 *         negative and support volumes are never parts.
 *   OBJ   one part per `o` / `g` / `usemtl` combination (no colour: the MTL is
 *         another file).
 *   glTF  the scene's nodes with TRS or matrix transforms, a part per node (per
 *         material when a node's mesh carries several); metres read as
 *         millimetres and Y-up turned to the print frame's Z-up.
 *   STL   one part per file (per named solid of an ASCII file); placing
 *         several files is the compiler's job (worker/lib/personalize/compile.ts).
 *   AMF   one part.
 *
 * NAMES AND COLOURS ARE THE MERCHANT'S. They come back so the builder can
 * suggest roles and colours; the compiler keeps them out of the mesh bytes and
 * they are stored only in the merchant-only `product_blueprints.parts`.
 */

/** One named piece of a model, ready to be compiled. */
export interface ModelPart {
  /** The file's own name for the piece. Merchant-only; never written into a mesh. */
  name: string;
  /** `#rrggbb` as the file states it (the extruder's filament, a base material or a colour group). Merchant-only. */
  colour?: string;
  /** The slicer extruder (1-based) the file assigns, where it says. */
  extruder?: number;
  /**
   * The file's own grouping — the placed object of a 3MF build item, an OBJ
   * `o`, a glTF root node. The compiler merges by it when a file has more
   * pieces than one mesh may carry.
   */
  group?: string;
  /** 9 floats per triangle: millimetres, the assembly frame, every transform composed, Z up. */
  positions: Float32Array;
  triangles: number;
}

export type ModelPartsWarning =
  /** STL / OBJ, or a 3MF or AMF with no unit attribute: millimetres assumed. */
  | 'UNIT_ASSUMED'
  /** A glTF (metres by definition) that would be over 2 m long: read as millimetres. */
  | 'UNIT_GUESSED'
  /** Modifier, negative, support-blocker/enforcer or support objects were left out. */
  | 'MODIFIERS_SKIPPED'
  /** Build items marked `printable="0"` were left out. */
  | 'NOT_PRINTABLE_SKIPPED'
  /** Per-triangle painted colours (Bambu `paint_color`, Prusa MMU segmentation) are not separate parts. */
  | 'PAINT_IGNORED'
  /** A reference to an object the package does not contain. */
  | 'MISSING_OBJECT'
  /** Components nested deeper than the reader follows were cut. */
  | 'DEPTH_LIMIT'
  /** Triangles pointing outside their vertex list were dropped. */
  | 'BAD_INDICES'
  /** glTF primitives that are not readable float triangles were skipped. */
  | 'PRIMITIVE_SKIPPED'
  /** A glTF with no nodes: its meshes were read directly, untransformed. */
  | 'NO_SCENE';

/** A machine word the merchant UI turns into a sentence (ar / en / ckb); never a sentence itself. */
export type ModelPartsHint =
  /** STEP or an unknown format: export the model as 3MF, STL, OBJ or GLB. */
  | 'export_mesh'
  /** The file could not be read (truncated, corrupt, not what its bytes claim). */
  | 'damaged'
  /** It holds no printable triangles. */
  | 'empty'
  /** Draco / meshopt / quantised glTF: export without mesh compression. */
  | 'compressed_gltf'
  /** A .gltf whose geometry lives in separate files: export a single .glb. */
  | 'external_buffers'
  /** More triangles than allowed: export a lighter file, or publish photo-only. */
  | 'too_heavy';

export type ModelPartsResult =
  | {
      ok: true;
      format: ModelFormat;
      unit: 'mm';
      /** 'declared' = the file (or its format's definition) states the unit. */
      unit_source: 'declared' | 'assumed';
      parts: ModelPart[];
      triangles: number;
      warnings: ModelPartsWarning[];
    }
  | {
      ok: false;
      code: 'UNREADABLE' | 'NO_GEOMETRY' | 'TOO_HEAVY' | 'UNSUPPORTED';
      format: ModelFormat;
      hint: ModelPartsHint;
      /** The counted total, for TOO_HEAVY — absent when the package was too large to open at all. */
      triangles?: number;
    };

/**
 * The ceiling `parseModelParts` applies when the caller names none: a memory
 * guard (36 MB of positions), not a product rule — the blueprint limit is the
 * admin's `customizationConfig.max_triangles`, passed in by the caller.
 */
export const MODEL_PARTS_DEFAULT_MAX_TRIANGLES = 1_000_000;
/** Components nested deeper than this are cut (a real assembly is 2–3 deep). */
const PARTS_MAX_DEPTH = 16;
/** Placed pieces followed before the reader stops — bounds what a hostile file can ask for. */
const PARTS_MAX_PIECES = 4096;
/** Declared XML bytes budgeted per allowed triangle when a 3MF is opened (real exports use 70–250). */
const PARTS_XML_BYTES_PER_TRIANGLE = 512;

/**
 * THE BOUNDED ZIP READER this file has always used for 3MF and zipped AMF,
 * exported so geometry code elsewhere opens packages through the same bomb
 * filter (`zipBombFilter`, worker/lib/attachments.ts) and fflate stays inside
 * this one allow-listed file (tests/store-isolation.test.ts).
 *
 * `want` narrows what is INFLATED — every entry is still counted against the
 * archive's bound first, so a thumbnail or a sliced G-code costs nothing but
 * cannot hide a bomb; `maxWantedBytes` caps the declared size of what is
 * inflated. Throws (`ARCHIVE_TOO_DEEP`, `ARCHIVE_TOO_LARGE`, or fflate's own
 * error for a damaged archive); never returns a partial package.
 */
export function readModelArchive(
  input: Uint8Array | ArrayBuffer,
  opts: { want?: (name: string) => boolean; maxWantedBytes?: number } = {}
): Record<string, Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bomb = zipBombFilter();
  const cap = opts.maxWantedBytes ?? ARCHIVE_INFLATE_CAP;
  let wanted = 0;
  return unzipSync(bytes, {
    filter: (f) => {
      bomb(f); // counts every entry; throws past the archive's bound
      if (opts.want && !opts.want(f.name)) return false;
      wanted += f.originalSize;
      if (wanted > cap) throw new Error('ARCHIVE_TOO_LARGE');
      return true;
    },
  });
}

/**
 * The pieces of a model file, named and placed. Never throws: an unreadable
 * file is a RESULT with a code and a hint, like `analyseModel`'s.
 *
 * `maxTriangles` is checked against a COUNT taken before any geometry is
 * built (the STL header, the 3MF tags, the glTF accessors, the OBJ faces), so
 * a file over the limit is refused without allocating it.
 */
export function parseModelParts(
  input: Uint8Array | ArrayBuffer,
  name: string,
  opts: { maxTriangles?: number } = {}
): ModelPartsResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = sniffFormat(bytes, name);
  const max =
    opts.maxTriangles !== undefined && Number.isFinite(opts.maxTriangles) && opts.maxTriangles >= 0
      ? Math.floor(opts.maxTriangles)
      : MODEL_PARTS_DEFAULT_MAX_TRIANGLES;
  if (!FORMAT_CAPABILITIES[format].previewable) return { ok: false, code: 'UNSUPPORTED', format, hint: 'export_mesh' };

  let out: PartsOutcome;
  try {
    out =
      format === '3mf' ? threeMfParts(bytes, max)
      : format === 'obj' ? objParts(bytes, max)
      : format === 'stl' ? stlParts(bytes, name, max)
      : format === 'amf' ? amfParts(bytes, name)
      : gltfParts(bytes, format, max);
  } catch (e) {
    if (e instanceof Error && e.message === 'ARCHIVE_TOO_LARGE') return { ok: false, code: 'TOO_HEAVY', format, hint: 'too_heavy' };
    return { ok: false, code: 'UNREADABLE', format, hint: 'damaged' };
  }
  if (!out.ok) return { ok: false, code: out.code, format, hint: out.hint, ...(out.triangles !== undefined ? { triangles: out.triangles } : {}) };

  const parts = out.parts.filter((p) => p.triangles > 0);
  const triangles = parts.reduce((n, p) => n + p.triangles, 0);
  if (triangles === 0) return { ok: false, code: 'NO_GEOMETRY', format, hint: 'empty' };
  if (triangles > max) return { ok: false, code: 'TOO_HEAVY', format, hint: 'too_heavy', triangles };
  nameParts(parts);
  return {
    ok: true,
    format,
    unit: 'mm',
    unit_source: out.declared ? 'declared' : 'assumed',
    parts,
    triangles,
    warnings: [...new Set(out.warnings)],
  };
}

type PartsOutcome =
  | { ok: true; parts: ModelPart[]; declared: boolean; warnings: ModelPartsWarning[] }
  | { ok: false; code: 'UNREADABLE' | 'NO_GEOMETRY' | 'TOO_HEAVY' | 'UNSUPPORTED'; hint: ModelPartsHint; triangles?: number };

const tooHeavy = (triangles?: number): PartsOutcome => ({
  ok: false,
  code: 'TOO_HEAVY',
  hint: 'too_heavy',
  ...(triangles !== undefined ? { triangles } : {}),
});

/** Every piece named, uniquely: the file's name, else «Part N»; repeats numbered «Screw», «Screw 2», … */
function nameParts(parts: ModelPart[]): void {
  const used = new Set<string>();
  parts.forEach((p, i) => {
    const base = p.name || `Part ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
    used.add(name);
    p.name = name;
  });
}

// ---------------------------------------------------------- shared helpers

/** An affine map in 3MF's row-vector layout: p' = p·R + t, R row-major in [0..8], t in [9..11]. */
type Affine = number[];
const AFFINE_IDENTITY: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const scaleAffine = (s: number): Affine => [s, 0, 0, 0, s, 0, 0, 0, s, 0, 0, 0];

/** `a` then `b`: the map that applies `a` first. */
function thenApply(a: Affine, b: Affine): Affine {
  const out = new Array<number>(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  for (let j = 0; j < 3; j++) out[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return out;
}

const affineDet = (m: Affine) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** A 3MF `transform` attribute; anything but twelve finite numbers is the identity, as `parse3mf` treats it. */
function affine3mf(raw: string | undefined): Affine {
  if (!raw) return AFFINE_IDENTITY;
  const v = raw.trim().split(/\s+/).map(Number);
  return v.length >= 12 && v.slice(0, 12).every(Number.isFinite) ? v.slice(0, 12) : AFFINE_IDENTITY;
}

/**
 * Indexed geometry → a flat soup under `m`, winding kept outward when `m`
 * mirrors. `from`/`to` select a triangle range (PrusaSlicer volumes). Returns
 * the positions and how many triangles pointed outside the vertex list.
 */
function soup(vx: ArrayLike<number>, faces: ArrayLike<number>, m: Affine, from = 0, to = faces.length / 3) {
  const vertexCount = Math.floor(vx.length / 3);
  const tv = new Float64Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const x = vx[i * 3], y = vx[i * 3 + 1], z = vx[i * 3 + 2];
    tv[i * 3] = m[0] * x + m[3] * y + m[6] * z + m[9];
    tv[i * 3 + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
    tv[i * 3 + 2] = m[2] * x + m[5] * y + m[8] * z + m[11];
  }
  const flip = affineDet(m) < 0;
  const count = Math.max(0, Math.floor(to) - Math.floor(from));
  const positions = new Float32Array(count * 9);
  let written = 0;
  let bad = 0;
  for (let t = Math.floor(from); t < Math.floor(from) + count; t++) {
    const a = faces[t * 3];
    let b = faces[t * 3 + 1];
    let c = faces[t * 3 + 2];
    if (!(a >= 0 && b >= 0 && c >= 0 && a < vertexCount && b < vertexCount && c < vertexCount)) {
      bad++;
      continue;
    }
    if (flip) [b, c] = [c, b];
    const o = written * 9;
    positions[o] = tv[a * 3]; positions[o + 1] = tv[a * 3 + 1]; positions[o + 2] = tv[a * 3 + 2];
    positions[o + 3] = tv[b * 3]; positions[o + 4] = tv[b * 3 + 1]; positions[o + 5] = tv[b * 3 + 2];
    positions[o + 6] = tv[c * 3]; positions[o + 7] = tv[c * 3 + 1]; positions[o + 8] = tv[c * 3 + 2];
    written++;
  }
  return { positions: written === count ? positions : positions.slice(0, written * 9), triangles: written, bad };
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()] ?? whole;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** A merchant-facing label: entities decoded, control and bidi-override characters dropped, ≤ 80 characters. */
function partLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  let out = '';
  for (const ch of xmlText(raw)) {
    const c = ch.codePointAt(0) ?? 0;
    const hidden = c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    out += hidden ? ' ' : ch;
  }
  return Array.from(out.replace(/\s+/g, ' ').trim()).slice(0, 80).join('').trim();
}

/** `#rrggbb` from `#RRGGBB`, `#RRGGBBAA` or the bare digits; the alpha is dropped (a printer has none). */
function hexColour(raw: string | null | undefined): string | undefined {
  const m = raw ? /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(raw.trim()) : null;
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

const positiveInt = (raw: string | null | undefined): number | undefined => {
  const n = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 && n < 1000 ? n : undefined;
};

const ATTRIBUTE_RE = /([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** Every attribute of a tag, reachable by its full name and by its local name (`p:path` → `path`). */
function attrsOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(ATTRIBUTE_RE)) {
    const value = m[2] ?? m[3] ?? '';
    const colon = m[1].indexOf(':');
    if (!out.has(m[1])) out.set(m[1], value);
    if (colon > 0 && !out.has(m[1].slice(colon + 1))) out.set(m[1].slice(colon + 1), value);
  }
  return out;
}

/**
 * One numeric attribute of the tag occupying `s[from..to)`, read in place —
 * no map, no substring of the tag: the hot path of a 60k-triangle mesh. A
 * missing or unreadable value is 0, as `num` makes it for `parse3mf`.
 */
function attrNumber(s: string, from: number, to: number, attrName: string): number {
  let at = from;
  for (;;) {
    at = s.indexOf(attrName, at);
    if (at < 0 || at >= to) return 0;
    const before = at === from ? 32 : s.charCodeAt(at - 1);
    let k = at + attrName.length;
    while (s.charCodeAt(k) === 32) k++;
    if ((before === 32 || before === 9 || before === 10 || before === 13) && s.charCodeAt(k) === 61 /* = */) {
      k++;
      while (s.charCodeAt(k) === 32) k++;
      const q = s.charCodeAt(k);
      if (q !== 34 && q !== 39) return 0;
      const end = s.indexOf(q === 34 ? '"' : "'", k + 1);
      if (end <= k + 1 || end > to) return 0;
      const n = Number(s.slice(k + 1, end));
      return Number.isFinite(n) ? n : 0;
    }
    at += attrName.length;
  }
}

/** `<tag` openings that are that tag and not a longer one (`<triangle` but not `<triangles>`). */
function countTags(body: string, tag: string): number {
  const open = `<${tag}`;
  let n = 0;
  let at = 0;
  for (;;) {
    at = body.indexOf(open, at);
    if (at < 0) return n;
    const c = body.charCodeAt(at + open.length);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62) n++;
    at += open.length;
  }
}

/** The key/value `<metadata>` children of a slicer config block. */
function metadataOf(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<metadata\s([^>]*)>/gi)) {
    const a = attrsOf(m[1]);
    const key = a.get('key');
    if (key && !out.has(key)) out.set(key, a.get('value') ?? '');
  }
  return out;
}

const baseName = (name: string) => partLabel((name.split(/[\\/]/).pop() ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, ''));

// ----------------------------------------------------------------- 3MF parts

interface ThreeMfObject {
  id: string;
  name: string;
  type: string;
  pid: string;
  pindex: number;
  body: string;
  triangles: number;
  components: Array<{ objectid: string; path: string; m: Affine }>;
}
interface ThreeMfModel {
  path: string;
  objects: Map<string, ThreeMfObject>;
  /** resource id → colours by index (`<basematerials>` and `<m:colorgroup>`). */
  colours: Map<string, Array<string | undefined>>;
}
interface SlicerPart { name: string; extruder?: number; subtype: string }
interface SlicerObject { name: string; extruder?: number; parts: Map<string, SlicerPart> }
interface PrusaVolume { first: number; last: number; name: string; type: string; extruder?: number }

const normPath = (p: string) => p.replace(/^\/+/, '').toLowerCase();

function read3mfModel(path: string, xml: string): ThreeMfModel {
  // The resource scans run over megabytes of vertices; a cheap `includes`
  // decides first whether there is anything to find (3MF element names are
  // case-sensitive XML, lower-case by the schema).
  const colours = new Map<string, Array<string | undefined>>();
  if (xml.includes('basematerials')) {
    for (const m of xml.matchAll(/<(?:[\w-]+:)?basematerials\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?basematerials>/gi)) {
      const id = attrsOf(m[1]).get('id');
      if (id) colours.set(id, [...m[2].matchAll(/<(?:[\w-]+:)?base\s([^>]*)>/gi)].map((b) => hexColour(attrsOf(b[1]).get('displaycolor'))));
    }
  }
  if (xml.includes('colorgroup')) {
    for (const m of xml.matchAll(/<(?:[\w-]+:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?colorgroup>/gi)) {
      const id = attrsOf(m[1]).get('id');
      if (id) colours.set(id, [...m[2].matchAll(/<(?:[\w-]+:)?color\s([^>]*)>/gi)].map((c) => hexColour(attrsOf(c[1]).get('color'))));
    }
  }
  const objects = new Map<string, ThreeMfObject>();
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/gi)) {
    const a = attrsOf(m[1]);
    const id = a.get('id');
    if (!id) continue;
    const body = m[2];
    const components: ThreeMfObject['components'] = [];
    for (const c of body.includes('component') ? body.matchAll(/<(?:[\w-]+:)?component\s([^>]*)>/gi) : []) {
      const ca = attrsOf(c[1]);
      const objectid = ca.get('objectid');
      if (objectid) components.push({ objectid, path: normPath(ca.get('path') ?? '') || path, m: affine3mf(ca.get('transform')) });
    }
    objects.set(id, {
      id,
      name: partLabel(a.get('name')),
      type: (a.get('type') ?? 'model').toLowerCase(),
      pid: a.get('pid') ?? '',
      pindex: Math.max(0, Math.floor(num(a.get('pindex') ?? '0'))),
      body,
      triangles: countTags(body, 'triangle'),
      components,
    });
  }
  return { path, objects, colours };
}

/** Bambu Studio / Orca: `Metadata/model_settings.config` — object and part names, subtypes, extruders. */
function readBambuSettings(xml: string): Map<string, SlicerObject> {
  const out = new Map<string, SlicerObject>();
  for (const m of xml.matchAll(/<object\s([^>]*)>([\s\S]*?)<\/object>/gi)) {
    const id = attrsOf(m[1]).get('id');
    if (!id) continue;
    const parts = new Map<string, SlicerPart>();
    for (const p of m[2].matchAll(/<part\s([^>]*)>([\s\S]*?)<\/part>/gi)) {
      const pa = attrsOf(p[1]);
      const pid = pa.get('id');
      if (!pid) continue;
      const meta = metadataOf(p[2]);
      parts.set(pid, { name: partLabel(meta.get('name')), extruder: positiveInt(meta.get('extruder')), subtype: (pa.get('subtype') ?? 'normal_part').toLowerCase() });
    }
    const meta = metadataOf(m[2].replace(/<part\s[^>]*>[\s\S]*?<\/part>/gi, ''));
    out.set(id, { name: partLabel(meta.get('name')), extruder: positiveInt(meta.get('extruder')), parts });
  }
  return out;
}

/** PrusaSlicer: `Metadata/Slic3r_PE_model.config` — each object's volumes as triangle ranges. */
function readPrusaSettings(xml: string): Map<string, { name: string; extruder?: number; volumes: PrusaVolume[] }> {
  const out = new Map<string, { name: string; extruder?: number; volumes: PrusaVolume[] }>();
  for (const m of xml.matchAll(/<object\s([^>]*)>([\s\S]*?)<\/object>/gi)) {
    const id = attrsOf(m[1]).get('id');
    if (!id) continue;
    const volumes: PrusaVolume[] = [];
    for (const v of m[2].matchAll(/<volume\s([^>]*)>([\s\S]*?)<\/volume>/gi)) {
      const va = attrsOf(v[1]);
      const meta = metadataOf(v[2]);
      const first = Number(va.get('firstid'));
      const last = Number(va.get('lastid'));
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) continue;
      const type = meta.get('volume_type') ?? (meta.get('modifier') === '1' ? 'ParameterModifier' : 'ModelPart');
      volumes.push({ first, last, name: partLabel(meta.get('name')), type, extruder: positiveInt(meta.get('extruder')) });
    }
    const meta = metadataOf(m[2].replace(/<volume\s[^>]*>[\s\S]*?<\/volume>/gi, ''));
    out.set(id, { name: partLabel(meta.get('name')), extruder: positiveInt(meta.get('extruder')), volumes });
  }
  return out;
}

/** The filament colour of each extruder (index 0 = extruder 1), as the slicer project states it. */
function filamentColours(text: (path: string) => string | null): Array<string | undefined> {
  const bambu = text('metadata/project_settings.config');
  if (bambu) {
    const list = /"filament_colou?r"\s*:\s*\[([^\]]*)\]/.exec(bambu);
    if (list) return [...list[1].matchAll(/"([^"]*)"/g)].map((c) => hexColour(c[1]));
  }
  const prusa = text('metadata/slic3r_pe.config');
  if (prusa) {
    const line = (key: string) =>
      (new RegExp(`^;\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(prusa)?.[1] ?? '').split(';').map((s) => hexColour(s.trim().replace(/^"|"$/g, '')));
    const extruder = line('extruder_colour');
    const filament = line('filament_colour');
    return Array.from({ length: Math.max(extruder.length, filament.length) }, (_, i) => extruder[i] ?? filament[i]);
  }
  return [];
}

/** The colour a 3MF object's own resources give it: the object's pid/pindex, else its first triangle's. */
function materialColour(model: ThreeMfModel, obj: ThreeMfObject): string | undefined {
  if (obj.pid) {
    const c = model.colours.get(obj.pid)?.[obj.pindex];
    if (c) return c;
  }
  const first = /<triangle\s([^>]*)>/i.exec(obj.body);
  if (!first) return undefined;
  const a = attrsOf(first[1]);
  const pid = a.get('pid');
  return pid ? model.colours.get(pid)?.[Math.max(0, Math.floor(num(a.get('p1') ?? a.get('pindex') ?? '0')))] : undefined;
}

/**
 * Calls `each` with the attribute text of every `<tag …>` in `body` — an
 * indexOf walk rather than a regex, because a 60k-triangle mesh is 90k tags
 * and this is the whole cost of reading one. Unprefixed tags only, as the 3MF
 * core writes them and as `parse3mf` reads them.
 */
function eachTag(body: string, tag: string, each: (from: number, to: number) => boolean | void): void {
  const open = `<${tag}`;
  let at = 0;
  for (;;) {
    at = body.indexOf(open, at);
    if (at < 0) return;
    const c = body.charCodeAt(at + open.length);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) {
      at += open.length;
      continue;
    }
    const end = body.indexOf('>', at);
    if (end < 0) return;
    if (each(at + open.length, end) === false) return;
    at = end;
  }
}

/** A mesh object's vertices and triangle indices, read tag by tag. */
function meshOf(obj: ThreeMfObject): { vx: Float64Array; faces: Int32Array } {
  const b = obj.body;
  const vxList: number[] = [];
  eachTag(b, 'vertex', (from, to) => {
    vxList.push(attrNumber(b, from, to, 'x'), attrNumber(b, from, to, 'y'), attrNumber(b, from, to, 'z'));
  });
  const faces = new Int32Array(obj.triangles * 3);
  let t = 0;
  eachTag(b, 'triangle', (from, to) => {
    if (t >= obj.triangles) return false;
    faces[t * 3] = attrNumber(b, from, to, 'v1');
    faces[t * 3 + 1] = attrNumber(b, from, to, 'v2');
    faces[t * 3 + 2] = attrNumber(b, from, to, 'v3');
    t++;
  });
  return { vx: Float64Array.from(vxList), faces: t === obj.triangles ? faces : faces.slice(0, t * 3) };
}

function threeMfParts(bytes: Uint8Array, max: number): PartsOutcome {
  const want = (n: string) => {
    const l = n.toLowerCase();
    return l.endsWith('.model') || l.endsWith('.rels') || (l.startsWith('metadata/') && l.endsWith('.config'));
  };
  const cap = Math.min(ARCHIVE_INFLATE_CAP, Math.max(8 * 1024 * 1024, max * PARTS_XML_BYTES_PER_TRIANGLE));
  const raw = readModelArchive(bytes, { want, maxWantedBytes: cap });
  const files = new Map<string, Uint8Array>();
  for (const [n, b] of Object.entries(raw)) files.set(normPath(n), b);
  const decoder = new TextDecoder();
  const text = (p: string) => {
    const b = files.get(p);
    return b ? decoder.decode(b) : null;
  };

  // The root model part: the package relationship's target, else the conventional path, else any.
  const rels = text('_rels/.rels') ?? '';
  const relTarget = [...rels.matchAll(/<Relationship\s([^>]*)>/gi)]
    .map((m) => attrsOf(m[1]))
    .find((a) => /\/3dmodel$/i.test(a.get('Type') ?? ''))
    ?.get('Target');
  const rootPath =
    (relTarget && files.has(normPath(relTarget)) ? normPath(relTarget) : null) ??
    (files.has('3d/3dmodel.model') ? '3d/3dmodel.model' : [...files.keys()].find((k) => k.endsWith('.model')));
  if (!rootPath) throw new Error('3MF has no model part');
  const rootXml = text(rootPath) ?? '';

  const models = new Map<string, ThreeMfModel>();
  const modelAt = (p: string): ThreeMfModel | null => {
    const hit = models.get(p);
    if (hit) return hit;
    const xml = text(p);
    if (xml === null) return null;
    const model = read3mfModel(p, xml);
    models.set(p, model);
    return model;
  };
  const root = modelAt(rootPath);
  if (!root) throw new Error('3MF has no model part');

  const unitAttr = /<model\b[^>]*?\sunit\s*=\s*["']([^"']+)["']/i.exec(rootXml);
  const unitScale = unitAttr ? (UNIT_MM[unitAttr[1].toLowerCase()] ?? 1) : 1;
  const toMm = scaleAffine(unitScale);
  const warnings: ModelPartsWarning[] = unitAttr ? [] : ['UNIT_ASSUMED'];

  const settingsXml = text('metadata/model_settings.config');
  const bambu = settingsXml ? readBambuSettings(settingsXml) : new Map<string, SlicerObject>();
  const prusaXml = text('metadata/slic3r_pe_model.config');
  const prusa = prusaXml ? readPrusaSettings(prusaXml) : new Map<string, { name: string; extruder?: number; volumes: PrusaVolume[] }>();
  const filaments = filamentColours(text);

  // <build> places objects, possibly transformed; a model with no build uses
  // every root object no component references, once, untransformed.
  const buildXml = /<build\b[^>]*>([\s\S]*?)<\/build>/i.exec(rootXml)?.[1] ?? '';
  const items: Array<{ objectid: string; path: string; m: Affine }> = [];
  for (const it of buildXml.matchAll(/<item\s([^>]*)>/gi)) {
    const a = attrsOf(it[1]);
    const objectid = a.get('objectid');
    if (!objectid) continue;
    if (a.get('printable') === '0') {
      warnings.push('NOT_PRINTABLE_SKIPPED');
      continue;
    }
    items.push({ objectid, path: normPath(a.get('path') ?? '') || rootPath, m: affine3mf(a.get('transform')) });
  }
  if (items.length === 0 && !/<item\s/i.test(buildXml)) {
    const referenced = new Set<string>();
    for (const o of root.objects.values()) for (const c of o.components) if (c.path === rootPath) referenced.add(c.objectid);
    for (const id of root.objects.keys()) if (!referenced.has(id)) items.push({ objectid: id, path: rootPath, m: AFFINE_IDENTITY });
  }

  // Follow every item down its components to the meshes, composing transforms.
  interface Leaf { model: ThreeMfModel; obj: ThreeMfObject; m: Affine; item: number; root: ThreeMfObject }
  const leaves: Leaf[] = [];
  const expand = (model: ThreeMfModel, objectid: string, m: Affine, depth: number, item: number, rootObj: ThreeMfObject | null, trail: string) => {
    if (leaves.length >= PARTS_MAX_PIECES) return;
    const obj = model.objects.get(objectid);
    if (!obj) {
      warnings.push('MISSING_OBJECT');
      return;
    }
    if (obj.type === 'support' || obj.type === 'solidsupport' || obj.type === 'other') {
      warnings.push('MODIFIERS_SKIPPED');
      return;
    }
    const top = rootObj ?? obj;
    if (obj.triangles > 0) leaves.push({ model, obj, m, item, root: top });
    for (const c of obj.components) {
      const key = `${c.path}#${c.objectid}`;
      if (depth >= PARTS_MAX_DEPTH || trail.includes(`|${key}|`)) {
        warnings.push('DEPTH_LIMIT');
        continue;
      }
      const child = modelAt(c.path);
      if (!child) {
        warnings.push('MISSING_OBJECT');
        continue;
      }
      expand(child, c.objectid, thenApply(c.m, m), depth + 1, item, top, `${trail}${key}|`);
    }
  };
  items.forEach((it, i) => {
    const model = modelAt(it.path);
    if (!model) warnings.push('MISSING_OBJECT');
    else expand(model, it.objectid, it.m, 0, i, null, `|${it.path}#${it.objectid}|`);
  });

  // Name, skip and count each leaf before any geometry is built.
  interface Piece { leaf: Leaf; name: string; extruder?: number; from: number; to: number }
  const pieces: Piece[] = [];
  const groupLabels: string[] = [];
  for (const leaf of leaves) {
    const settings = bambu.get(leaf.root.id);
    groupLabels[leaf.item] ??= settings?.name || prusa.get(leaf.root.id)?.name || leaf.root.name || '';
    if (leaf.obj.body.includes('paint_color=') || leaf.obj.body.includes('mmu_segmentation=')) warnings.push('PAINT_IGNORED');
    const volumes = leaf.model.path === rootPath ? prusa.get(leaf.obj.id) : undefined;
    if (volumes && volumes.volumes.length > 0) {
      for (const v of volumes.volumes) {
        if (v.type.toLowerCase() !== 'modelpart') {
          warnings.push('MODIFIERS_SKIPPED');
          continue;
        }
        const from = Math.min(v.first, leaf.obj.triangles);
        const to = Math.min(v.last + 1, leaf.obj.triangles);
        if (to > from) pieces.push({ leaf, name: v.name || volumes.name || leaf.obj.name, extruder: v.extruder ?? volumes.extruder, from, to });
      }
      continue;
    }
    const part = settings?.parts.get(leaf.obj.id);
    if (part && part.subtype !== 'normal_part') {
      warnings.push('MODIFIERS_SKIPPED');
      continue;
    }
    const direct = leaf.obj === leaf.root;
    pieces.push({
      leaf,
      name: part?.name || leaf.obj.name || (direct ? settings?.name ?? '' : ''),
      extruder: part?.extruder ?? settings?.extruder,
      from: 0,
      to: leaf.obj.triangles,
    });
  }
  const total = pieces.reduce((n, p) => n + (p.to - p.from), 0);
  if (total > max) return tooHeavy(total);

  // Group labels, unique per placed item.
  const usedGroups = new Set<string>();
  const groups = groupLabels.map((label, i) => {
    const base = label || `Object ${i + 1}`;
    let name = base;
    for (let n = 2; usedGroups.has(name); n++) name = `${base} ${n}`;
    usedGroups.add(name);
    return name;
  });

  const meshes = new Map<ThreeMfObject, { vx: Float64Array; faces: Int32Array }>();
  const parts: ModelPart[] = [];
  for (const p of pieces) {
    let mesh = meshes.get(p.leaf.obj);
    if (!mesh) {
      mesh = meshOf(p.leaf.obj);
      meshes.set(p.leaf.obj, mesh);
    }
    const s = soup(mesh.vx, mesh.faces, thenApply(p.leaf.m, toMm), p.from, Math.min(p.to, mesh.faces.length / 3));
    if (s.bad > 0) warnings.push('BAD_INDICES');
    const colour = (p.extruder !== undefined ? filaments[p.extruder - 1] : undefined) ?? materialColour(p.leaf.model, p.leaf.obj);
    parts.push({
      name: p.name,
      ...(colour ? { colour } : {}),
      ...(p.extruder !== undefined ? { extruder: p.extruder } : {}),
      group: groups[p.leaf.item] ?? '',
      positions: s.positions,
      triangles: s.triangles,
    });
  }
  return { ok: true, parts, declared: !!unitAttr, warnings };
}

// ----------------------------------------------------------------- OBJ parts

function objParts(bytes: Uint8Array, max: number): PartsOutcome {
  const text = new TextDecoder().decode(bytes);
  const vx: number[] = [];
  let vertexCount = 0;
  interface Acc { o: string; g: string; mtl: string; faces: number[] }
  const accs = new Map<string, Acc>();
  let o = '';
  let g = '';
  let mtl = '';
  let total = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.charCodeAt(0) === 35 /* # */) continue;
    const space = line.search(/\s/);
    const head = space < 0 ? line : line.slice(0, space);
    const rest = space < 0 ? '' : line.slice(space + 1).trim();
    if (head === 'v') {
      if (total <= max) {
        const p = rest.split(/\s+/);
        vx.push(Number(p[0]), Number(p[1]), Number(p[2]));
      }
      vertexCount++;
    } else if (head === 'o') {
      o = partLabel(rest);
      g = '';
    } else if (head === 'g') {
      g = rest === 'default' ? '' : partLabel(rest);
    } else if (head === 'usemtl') {
      mtl = partLabel(rest);
    } else if (head === 'f') {
      const idx: number[] = [];
      for (const part of rest.split(/\s+/)) {
        let i = parseInt(part.split('/')[0], 10);
        if (!Number.isFinite(i)) continue;
        // OBJ is 1-based, and a negative index counts back from the last vertex so far.
        i = i < 0 ? vertexCount + i : i - 1;
        idx.push(i);
      }
      total += Math.max(0, idx.length - 2);
      if (total > max) continue; // keep counting, stop storing
      const key = `${o}\u0000${g}\u0000${mtl}`;
      let acc = accs.get(key);
      if (!acc) {
        acc = { o, g, mtl, faces: [] };
        accs.set(key, acc);
      }
      for (let k = 1; k + 1 < idx.length; k++) acc.faces.push(idx[0], idx[k], idx[k + 1]);
    }
  }
  if (total > max) return tooHeavy(total);

  const list = [...accs.values()];
  const baseOf = (a: Acc) => a.g || a.o;
  const materialsPerBase = new Map<string, Set<string>>();
  for (const a of list) {
    const set = materialsPerBase.get(baseOf(a)) ?? new Set<string>();
    set.add(a.mtl);
    materialsPerBase.set(baseOf(a), set);
  }
  const warnings: ModelPartsWarning[] = ['UNIT_ASSUMED'];
  const parts: ModelPart[] = list.map((a) => {
    const base = baseOf(a);
    const name = !base ? a.mtl : a.mtl && (materialsPerBase.get(base)?.size ?? 0) > 1 ? `${base} · ${a.mtl}` : base;
    const s = soup(vx, a.faces, AFFINE_IDENTITY);
    if (s.bad > 0) warnings.push('BAD_INDICES');
    return { name, group: a.o || a.g, positions: s.positions, triangles: s.triangles };
  });
  return { ok: true, parts, declared: false, warnings };
}

// ----------------------------------------------------------------- STL parts

function stlParts(bytes: Uint8Array, name: string, max: number): PartsOutcome {
  const base = baseName(name);
  const warnings: ModelPartsWarning[] = ['UNIT_ASSUMED'];
  if (isBinaryStl(bytes)) {
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (count > max) return tooHeavy(count);
    const mesh = parseBinaryStl(bytes);
    // Materialise / VisCAM write the whole-part colour into the header as `COLOR=` + RGBA.
    const at = asciiHead(bytes, 80).indexOf('COLOR=');
    const colour = at >= 0 && at + 9 < 80 ? `#${[bytes[at + 6], bytes[at + 7], bytes[at + 8]].map((v) => v.toString(16).padStart(2, '0')).join('')}` : undefined;
    return { ok: true, parts: [{ name: base, ...(colour ? { colour } : {}), positions: mesh.positions, triangles: mesh.triangles }], declared: false, warnings };
  }
  const text = new TextDecoder().decode(bytes);
  const count = (text.match(/endfacet/gi) ?? []).length;
  if (count > max) return tooHeavy(count);
  const vertexRe = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  const toPart = (body: string, partName: string): ModelPart => {
    const nums: number[] = [];
    for (const m of body.matchAll(vertexRe)) nums.push(Number(m[1]), Number(m[2]), Number(m[3]));
    const triangles = Math.floor(nums.length / 9);
    return { name: partName, positions: Float32Array.from(nums.slice(0, triangles * 9)), triangles };
  };
  // Several `solid … endsolid` blocks in one file are the file's own pieces.
  const solids = [...text.matchAll(/^[ \t]*solid\b[ \t]*([^\r\n]*)$([\s\S]*?)^[ \t]*endsolid\b/gim)];
  if (solids.length > 1) {
    return { ok: true, parts: solids.map((m) => toPart(m[2], partLabel(m[1]))), declared: false, warnings };
  }
  const only = solids.length === 1 ? partLabel(solids[0][1]) : '';
  return { ok: true, parts: [toPart(text, only || base)], declared: false, warnings };
}

// ----------------------------------------------------------------- AMF parts

function amfParts(bytes: Uint8Array, name: string): PartsOutcome {
  const mesh = parseAmf(bytes);
  const s = mesh.unitScale;
  const positions = s === 1 ? mesh.positions : mesh.positions.map((v) => v * s);
  return {
    ok: true,
    parts: [{ name: mesh.title ? partLabel(mesh.title) : baseName(name), positions, triangles: mesh.triangles }],
    declared: mesh.unitDeclared,
    warnings: mesh.unitDeclared ? [] : ['UNIT_ASSUMED'],
  };
}

// ---------------------------------------------------------------- glTF parts

interface GltfNodeDef {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfPrimitiveDef {
  attributes?: Record<string, number>;
  indices?: number;
  mode?: number;
  material?: number;
}
interface GltfAccessorDef extends GltfAccessor {
  normalized?: boolean;
  sparse?: unknown;
}

/** glTF's column-major 4×4 as the row-vector affine used above. */
function affineOfColumnMajor(m: number[]): Affine {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]];
}

/** A node's local transform: its `matrix`, else translation · rotation · scale. */
function nodeAffine(n: GltfNodeDef): Affine {
  if (Array.isArray(n.matrix) && n.matrix.length === 16 && n.matrix.every(Number.isFinite)) return affineOfColumnMajor(n.matrix);
  const [tx, ty, tz] = n.translation?.length === 3 && n.translation.every(Number.isFinite) ? n.translation : [0, 0, 0];
  const [sx, sy, sz] = n.scale?.length === 3 && n.scale.every(Number.isFinite) ? n.scale : [1, 1, 1];
  const [qx, qy, qz, qw] = n.rotation?.length === 4 && n.rotation.every(Number.isFinite) ? n.rotation : [0, 0, 0, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  // Column-major rotation columns, each scaled, then the translation column.
  return affineOfColumnMajor([
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

/** glTF's Y-up turned into the print frame's Z-up: (x, y, z) → (x, −z, y). A rotation, never a mirror. */
const Y_UP_TO_Z_UP: Affine = [1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0];

/** linear → sRGB, as a display colour: glTF's `baseColorFactor` is linear. */
function srgbHex(rgb: number[]): string | undefined {
  if (rgb.length < 3 || !rgb.slice(0, 3).every((v) => Number.isFinite(v))) return undefined;
  const byte = (l: number) => {
    const c = Math.min(1, Math.max(0, l));
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(s * 255).toString(16).padStart(2, '0');
  };
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`;
}

function gltfParts(bytes: Uint8Array, format: ModelFormat, max: number): PartsOutcome {
  let json: Record<string, unknown> | null = null;
  let glbBin: Uint8Array | null = null;
  if (format === 'glb') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 12;
    while (at + 8 <= bytes.length) {
      const len = dv.getUint32(at, true);
      const type = dv.getUint32(at + 4, true);
      const start = at + 8;
      if (start + len > bytes.length) throw new Error('GLB chunk runs past the end');
      if (type === 0x4e4f534a && !json) json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + len)));
      else if (type === 0x004e4942 && !glbBin) glbBin = bytes.subarray(start, start + len);
      at = start + len + ((4 - (len % 4)) % 4);
    }
  } else {
    json = JSON.parse(new TextDecoder().decode(bytes));
  }
  if (!json || typeof json !== 'object') throw new Error('glTF has no JSON');

  const required = Array.isArray(json.extensionsRequired) ? (json.extensionsRequired as unknown[]).map(String) : [];
  if (required.some((e) => /draco|meshopt|quantization/i.test(e))) return { ok: false, code: 'UNSUPPORTED', hint: 'compressed_gltf' };

  const buffers = (json.buffers as Array<{ uri?: string }> | undefined) ?? [];
  const decoded = new Map<number, Uint8Array | null>();
  let external = false;
  const bufferBytes = (i: number): Uint8Array | null => {
    if (decoded.has(i)) return decoded.get(i) ?? null;
    const b = buffers[i];
    let out: Uint8Array | null = null;
    if (b && b.uri === undefined) out = format === 'glb' && i === 0 ? glbBin : null;
    else if (b && typeof b.uri === 'string' && b.uri.startsWith('data:')) out = base64ToBytes(b.uri.slice(b.uri.indexOf(',') + 1));
    else if (b) external = true;
    decoded.set(i, out);
    return out;
  };
  const accessors = (json.accessors as GltfAccessorDef[] | undefined) ?? [];
  const views = (json.bufferViews as GltfBufferView[] | undefined) ?? [];
  const meshes = (json.meshes as Array<{ name?: string; primitives?: GltfPrimitiveDef[] }> | undefined) ?? [];
  const nodes = (json.nodes as GltfNodeDef[] | undefined) ?? [];
  const materials = (json.materials as Array<{ name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] } }> | undefined) ?? [];
  const warnings: ModelPartsWarning[] = [];

  /** The typed view behind an accessor, bounds-checked; null when it cannot be read here. */
  const view = (a: GltfAccessorDef | undefined, size: number) => {
    if (!a || a.bufferView === undefined || a.sparse !== undefined || !(a.count >= 0)) return null;
    const v = views[a.bufferView];
    if (!v) return null;
    const bin = bufferBytes(v.buffer ?? 0);
    if (!bin) return null;
    const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const stride = v.byteStride && v.byteStride > 0 ? v.byteStride : size;
    const end = a.count === 0 ? start : start + (a.count - 1) * stride + size;
    if (end > (v.byteOffset ?? 0) + v.byteLength || end > bin.byteLength) return null;
    return { dv: new DataView(bin.buffer, bin.byteOffset, bin.byteLength), start, stride, count: a.count };
  };
  const positionsOf = (index: number | undefined): Float64Array | null => {
    const a = index === undefined ? undefined : accessors[index];
    if (!a || a.type !== 'VEC3' || a.componentType !== 5126 || a.normalized) return null;
    const v = view(a, 12);
    if (!v) return null;
    const out = new Float64Array(v.count * 3);
    for (let i = 0; i < v.count; i++) {
      const o = v.start + i * v.stride;
      out[i * 3] = v.dv.getFloat32(o, true);
      out[i * 3 + 1] = v.dv.getFloat32(o + 4, true);
      out[i * 3 + 2] = v.dv.getFloat32(o + 8, true);
    }
    return out;
  };
  const indicesOf = (index: number): Uint32Array | null => {
    const a = accessors[index];
    if (!a || a.type !== 'SCALAR') return null;
    const size = a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : a.componentType === 5121 ? 1 : 0;
    const v = size ? view(a, size) : null;
    if (!v) return null;
    const out = new Uint32Array(v.count);
    for (let i = 0; i < v.count; i++) {
      const o = v.start + i * v.stride;
      out[i] = size === 4 ? v.dv.getUint32(o, true) : size === 2 ? v.dv.getUint16(o, true) : v.dv.getUint8(o);
    }
    return out;
  };
  /** Triangles a primitive yields, counted from its accessors before anything is read. */
  const triangleCount = (p: GltfPrimitiveDef): number => {
    const n = p.indices !== undefined ? accessors[p.indices]?.count ?? 0 : accessors[p.attributes?.POSITION ?? -1]?.count ?? 0;
    const mode = p.mode ?? 4;
    return mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0;
  };

  // The scene's node instances, each with its world transform.
  interface Instance { mesh: number; name: string; m: Affine; root: string }
  const instances: Instance[] = [];
  if (nodes.length === 0) {
    meshes.forEach((m, i) => instances.push({ mesh: i, name: partLabel(m.name), m: AFFINE_IDENTITY, root: '' }));
    if (meshes.length) warnings.push('NO_SCENE');
  } else {
    const scenes = (json.scenes as Array<{ nodes?: number[] }> | undefined) ?? [];
    const sceneIndex = typeof json.scene === 'number' ? json.scene : 0;
    let roots = scenes[sceneIndex]?.nodes;
    if (!Array.isArray(roots)) {
      const children = new Set<number>();
      for (const n of nodes) for (const c of n.children ?? []) children.add(c);
      roots = nodes.map((_, i) => i).filter((i) => !children.has(i));
    }
    let visits = 0;
    const walk = (i: number, parent: Affine, depth: number, root: string, trail: Set<number>) => {
      const n = nodes[i];
      if (!n || trail.has(i) || ++visits > PARTS_MAX_PIECES) return;
      if (depth > 32) {
        warnings.push('DEPTH_LIMIT');
        return;
      }
      const world = thenApply(nodeAffine(n), parent);
      const label = partLabel(n.name);
      const top = depth === 0 ? label || `Group ${i + 1}` : root;
      if (typeof n.mesh === 'number' && meshes[n.mesh]) instances.push({ mesh: n.mesh, name: label || partLabel(meshes[n.mesh].name), m: world, root: top });
      const next = new Set(trail).add(i);
      for (const c of n.children ?? []) walk(c, world, depth + 1, top, next);
    };
    for (const r of roots) walk(r, AFFINE_IDENTITY, 0, '', new Set());
  }

  let total = 0;
  for (const inst of instances) for (const p of meshes[inst.mesh].primitives ?? []) total += triangleCount(p);
  if (total > max) return tooHeavy(total);

  // Geometry, in the file's units, turned Z-up; the unit is decided on the result's size.
  const parts: ModelPart[] = [];
  const extent = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const inst of instances) {
    const prims = meshes[inst.mesh].primitives ?? [];
    const byMaterial = new Map<number, GltfPrimitiveDef[]>();
    for (const p of prims) {
      const key = typeof p.material === 'number' ? p.material : -1;
      byMaterial.set(key, [...(byMaterial.get(key) ?? []), p]);
    }
    const m = thenApply(inst.m, Y_UP_TO_Z_UP);
    for (const [material, group] of byMaterial) {
      const chunks: Float32Array[] = [];
      let triangles = 0;
      for (const p of group) {
        const mode = p.mode ?? 4;
        const pos = mode === 4 || mode === 5 || mode === 6 ? positionsOf(p.attributes?.POSITION) : null;
        const idx = p.indices === undefined ? null : indicesOf(p.indices);
        if (!pos || (p.indices !== undefined && !idx)) {
          if (external) return { ok: false, code: 'UNSUPPORTED', hint: 'external_buffers' };
          warnings.push('PRIMITIVE_SKIPPED');
          continue;
        }
        const order = idx ?? Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        let faces: Uint32Array;
        if (mode === 4) faces = order.length % 3 === 0 ? order : order.slice(0, order.length - (order.length % 3));
        else {
          faces = new Uint32Array(Math.max(0, order.length - 2) * 3);
          for (let t = 0; t + 2 < order.length; t++) {
            const [a, b, c] = mode === 6 ? [order[0], order[t + 1], order[t + 2]] : t % 2 === 0 ? [order[t], order[t + 1], order[t + 2]] : [order[t + 1], order[t], order[t + 2]];
            faces[t * 3] = a;
            faces[t * 3 + 1] = b;
            faces[t * 3 + 2] = c;
          }
        }
        const s = soup(pos, faces, m);
        if (s.bad > 0) warnings.push('BAD_INDICES');
        chunks.push(s.positions);
        triangles += s.triangles;
      }
      if (triangles === 0) continue;
      const positions = chunks.length === 1 ? chunks[0] : new Float32Array(triangles * 9);
      if (chunks.length > 1) {
        let at = 0;
        for (const c of chunks) {
          positions.set(c, at);
          at += c.length;
        }
      }
      for (let i = 0; i < positions.length; i++) {
        const v = positions[i];
        const k = i % 3;
        if (v < extent[k]) extent[k] = v;
        if (v > extent[k + 3]) extent[k + 3] = v;
      }
      const mat = material >= 0 ? materials[material] : undefined;
      const colour = mat?.pbrMetallicRoughness?.baseColorFactor ? srgbHex(mat.pbrMetallicRoughness.baseColorFactor) : undefined;
      const name = byMaterial.size > 1 ? `${inst.name || 'Part'} · ${partLabel(mat?.name) || `material ${material + 1}`}` : inst.name;
      parts.push({ name, ...(colour ? { colour } : {}), group: inst.root, positions, triangles });
    }
  }
  const longest = Math.max(extent[3] - extent[0], extent[4] - extent[1], extent[5] - extent[2]);

  // glTF is defined in METRES. A printable export authored in millimetres and
  // written without the unit change reads as a building; above 2 m it is taken
  // as millimetres and said so, rather than shown as a 50-metre keychain.
  const guessed = longest > 2;
  if (guessed) warnings.push('UNIT_GUESSED');
  else for (const p of parts) for (let i = 0; i < p.positions.length; i++) p.positions[i] *= 1000;
  return { ok: true, parts, declared: !guessed, warnings };
}
