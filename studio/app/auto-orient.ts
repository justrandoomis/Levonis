/**
 * Auto-orient — a TypeScript port of BambuStudio's `AutoOrienter`.
 *
 * Source: https://github.com/bambulab/BambuStudio, `src/libslic3r/Orient.cpp`
 * and `src/libslic3r/Orient.hpp`, GNU AGPL-3.0. LEVO Web Slicer is
 * AGPL-3.0-or-later, so this port is a derivative work under the same licence;
 * the attribution lives in OPEN_SOURCE_NOTICES.md and must stay there.
 *
 * WHAT IT DOES. Given the raw triangles of one object it picks the orientation
 * that prints best — the one whose score balances four things the printer
 * actually cares about: how much unsupported overhang the part would have, how
 * much of it lands flat on the bed, how stable its convex-hull footprint is,
 * and how many near-horizontal faces would come out stepped. It is the same
 * scoring function BambuStudio uses, with the same constants.
 *
 * PURE GEOMETRY. No DOM, no three.js, no engine — so tests/auto-orient.test.mjs
 * can run every claim here in plain Node. The caller (engine-adapter) is the
 * only place that touches the scene.
 *
 * THE FRAME, AND THE TRAP IN IT. BambuStudio is Z-up; the engine this ships in
 * is three.js, which is Y-up. Most of the search really is frame-agnostic — a
 * candidate is "the direction of the local mesh that should end up pointing
 * up", and every measurement is a dot product against it. But upstream names
 * the up axis in four places that are easy to copy without noticing: the seed
 * candidate (0,0,-1), the test for "already upright" (0,0,1), the anti-flip
 * target n1, and the 18 supplementary directions, which are laid out around Z.
 * All four are derived from {@link UP} here instead. Copying them verbatim is
 * not a subtle mistake: it rotates every single result by a quarter turn, which
 * is exactly what the first run of tests/auto-orient.test.mjs caught.
 *
 * WHAT IS FAITHFULLY MISSING. Two upstream inputs do not exist here and are not
 * faked:
 *   - `is_apperance` marks facets a 3MF declared as visible-surface, so that
 *     supports scarring them costs more. Our meshes carry no such property, so
 *     the term is present, documented, and evaluates to "no appearance faces" —
 *     exactly what upstream computes for a plain STL.
 *   - `area_projected` is summed into the denominator upstream but never
 *     assigned in `get_features`, so it is always 0 there too. It is kept as a
 *     named zero rather than silently dropped, so the formula still reads like
 *     the original.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Where a printed part's "up" is in the engine this result is applied to. */
export const UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Slic3r's own EPSILON (libslic3r.h), used for the same comparisons. */
const EPSILON = 1e-4;

/**
 * `OrientParamsArea` from Orient.hpp — the set `orient(ModelObject*)` uses.
 * The names are upstream's on purpose: someone comparing the two files should
 * not have to translate.
 */
export interface OrientParams {
  RELATIVE_F: number;
  CONTOUR_F: number;
  BOTTOM_F: number;
  BOTTOM_HULL_F: number;
  TAR_C: number;
  TAR_D: number;
  TAR_LAF: number;
  TAR_PROJ_AREA: number;
  FIRST_LAY_H: number;
  LAF_MAX: number;
  LAF_MIN: number;
  BOTTOM_MIN: number;
  APPERANCE_FACE_SUPP: number;
  /** Degrees. Drives ASCENT: a face steeper than this needs support. */
  overhang_angle: number;
  use_low_angle_face: boolean;
}

export const ORIENT_PARAMS: OrientParams = {
  RELATIVE_F: 20,
  CONTOUR_F: 0.5,
  BOTTOM_F: 2.5,
  BOTTOM_HULL_F: 0.1,
  TAR_C: 0.1,
  TAR_D: 1,
  TAR_LAF: 0.001,
  TAR_PROJ_AREA: 0.1,
  FIRST_LAY_H: 0.2,
  LAF_MAX: 0.999,
  LAF_MIN: 0.97,
  BOTTOM_MIN: 0.1,
  APPERANCE_FACE_SUPP: 3,
  overhang_angle: 30,
  use_low_angle_face: true,
};

export interface OrientCosts {
  overhang: number;
  bottom: number;
  bottom_hull: number;
  contour: number;
  area_laf: number;
  /** Always 0 — see the file header. Kept so the formula reads like upstream. */
  area_projected: number;
  unprintability: number;
}

export interface OrientResult {
  /** The local-space direction that should end up pointing at {@link UP}. */
  orientation: Vec3;
  /** three.js XYZ Euler that takes `orientation` to {@link UP}, in radians. */
  euler: Vec3;
  costs: OrientCosts;
  /** Score of leaving the object exactly as its local mesh sits. */
  identityUnprintability: number;
  /** How many distinct candidate orientations survived de-duplication. */
  candidates: number;
  /** False when the object is already in (or ties) its best orientation. */
  improved: boolean;
  triangles: number;
  hullFaces: number;
}

// ---------------------------------------------------------------- small maths

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
const negate = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z });

function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? { x: a.x / n, y: a.y / n, z: a.z / n } : { x: 0, y: 0, z: 0 };
}

/** `Eigen::isApprox`: ‖a−b‖ ≤ prec·min(‖a‖,‖b‖). Zero only matches zero. */
function isApprox(a: Vec3, b: Vec3, prec: number): boolean {
  return norm(sub(a, b)) <= prec * Math.min(norm(a), norm(b));
}

const max3 = (a: number, b: number, c: number): number => Math.max(a, Math.max(b, c));

/** `floor(n*1000)/1000` — upstream's `quantize_vec3f`. */
const q = (n: number): number => Math.floor(n * 1000) / 1000;
const qkey = (n: Vec3): string => `${q(n.x)},${q(n.y)},${q(n.z)}`;

// -------------------------------------------------------------- the mesh view

interface FaceSet {
  /** 9 floats per triangle: v0 xyz, v1 xyz, v2 xyz. */
  positions: Float32Array;
  count: number;
  normals: Vec3[];
  areas: Float64Array;
}

function facesOf(positions: Float32Array): FaceSet {
  const count = Math.floor(positions.length / 9);
  const normals: Vec3[] = new Array(count);
  const areas = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    const e1 = { x: bx - ax, y: by - ay, z: bz - az };
    const e2 = { x: cx - ax, y: cy - ay, z: cz - az };
    const n = cross(e1, e2);
    const len = norm(n);
    // A zero-length cross product is a degenerate triangle: it has no normal
    // and no area, so it votes for nothing rather than poisoning a direction.
    areas[i] = len / 2;
    normals[i] = len > 0 ? { x: n.x / len, y: n.y / len, z: n.z / len } : { x: 0, y: 0, z: 0 };
  }
  return { positions, count, normals, areas };
}

// ------------------------------------------------------------- 3D convex hull

/**
 * Incremental 3D convex hull, returned as a triangle soup so the caller can
 * measure it exactly like the mesh.
 *
 * WHY A CAP. Upstream runs the hull over every vertex on a desktop CPU. This
 * runs in a browser, sometimes on a phone, so above {@link HULL_INPUT_CAP}
 * distinct vertices the input is first reduced to the extreme vertex in each of
 * many sampled directions. That is not a random sample: every point kept is
 * genuinely on the true hull, so the result is a subset of the real hull rather
 * than an invented shape, and it converges to it as the direction count grows.
 * `hullApproximated` reports when this happened instead of hiding it.
 */
const HULL_INPUT_CAP = 20000;
const HULL_DIRECTIONS = 512;

export interface HullResult {
  positions: Float32Array;
  approximated: boolean;
}

function uniqueVertices(positions: Float32Array): Vec3[] {
  const seen = new Set<string>();
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const v = { x: positions[i], y: positions[i + 1], z: positions[i + 2] };
    const key = `${v.x},${v.y},${v.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Deterministic direction set on the sphere (golden-angle spiral). */
function sampleDirections(count: number): Vec3[] {
  const dirs: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    dirs.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return dirs;
}

function reduceToExtremes(points: Vec3[]): Vec3[] {
  const kept = new Map<number, Vec3>();
  for (const dir of sampleDirections(HULL_DIRECTIONS)) {
    let best = -Infinity;
    let bestIndex = -1;
    for (let i = 0; i < points.length; i++) {
      const d = dot(points[i], dir);
      if (d > best) {
        best = d;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) kept.set(bestIndex, points[bestIndex]);
  }
  return [...kept.values()];
}

interface HullFace {
  a: number;
  b: number;
  c: number;
  normal: Vec3;
  offset: number;
}

function makeFace(points: Vec3[], a: number, b: number, c: number): HullFace {
  const n = normalize(cross(sub(points[b], points[a]), sub(points[c], points[a])));
  return { a, b, c, normal: n, offset: dot(n, points[a]) };
}

export function convexHull3d(positions: Float32Array): HullResult {
  let points = uniqueVertices(positions);
  let approximated = false;
  if (points.length > HULL_INPUT_CAP) {
    points = reduceToExtremes(points);
    approximated = true;
  }
  if (points.length < 4) return { positions: new Float32Array(0), approximated };

  // Seed with a non-degenerate tetrahedron. Without one there is no volume to
  // grow, and every later face test would divide a plane by nothing.
  let i1 = -1;
  for (let i = 1; i < points.length; i++) {
    if (norm(sub(points[i], points[0])) > 1e-9) { i1 = i; break; }
  }
  if (i1 < 0) return { positions: new Float32Array(0), approximated };
  let i2 = -1;
  for (let i = 1; i < points.length; i++) {
    if (i === i1) continue;
    if (norm(cross(sub(points[i1], points[0]), sub(points[i], points[0]))) > 1e-9) { i2 = i; break; }
  }
  if (i2 < 0) return { positions: new Float32Array(0), approximated };
  const base = makeFace(points, 0, i1, i2);
  let i3 = -1;
  let bestDist = 1e-9;
  for (let i = 1; i < points.length; i++) {
    if (i === i1 || i === i2) continue;
    const d = Math.abs(dot(base.normal, points[i]) - base.offset);
    if (d > bestDist) { bestDist = d; i3 = i; }
  }
  if (i3 < 0) return { positions: new Float32Array(0), approximated };

  // Orient every seed face outward from the tetrahedron's own centroid.
  const seeds = [0, i1, i2, i3];
  const centroid: Vec3 = seeds.reduce(
    (acc, i) => ({ x: acc.x + points[i].x / 4, y: acc.y + points[i].y / 4, z: acc.z + points[i].z / 4 }),
    { x: 0, y: 0, z: 0 },
  );
  const outward = (f: HullFace): HullFace =>
    dot(f.normal, centroid) - f.offset > 0 ? makeFace(points, f.a, f.c, f.b) : f;

  let faces: HullFace[] = [
    outward(makeFace(points, seeds[0], seeds[1], seeds[2])),
    outward(makeFace(points, seeds[0], seeds[1], seeds[3])),
    outward(makeFace(points, seeds[0], seeds[2], seeds[3])),
    outward(makeFace(points, seeds[1], seeds[2], seeds[3])),
  ];

  const tol = 1e-9 * Math.max(1, bestDist);
  for (let p = 0; p < points.length; p++) {
    if (seeds.includes(p)) continue;
    const point = points[p];
    const visible = faces.filter((f) => dot(f.normal, point) - f.offset > tol);
    if (!visible.length) continue;

    // The horizon is every edge of the visible set that the hidden set shares:
    // an edge seen exactly once is a boundary, an edge seen twice is interior.
    const edgeCount = new Map<string, { a: number; b: number; n: number }>();
    for (const f of visible) {
      for (const [a, b] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]] as Array<[number, number]>) {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        const found = edgeCount.get(key);
        if (found) found.n++;
        else edgeCount.set(key, { a, b, n: 1 });
      }
    }
    const visibleSet = new Set(visible);
    faces = faces.filter((f) => !visibleSet.has(f));
    for (const edge of edgeCount.values()) {
      if (edge.n !== 1) continue;
      faces.push(makeFace(points, edge.a, edge.b, p));
    }
    // A hull that lost all its faces to a numerical edge case is not a hull.
    if (faces.length < 4) return { positions: new Float32Array(0), approximated };
  }

  const out = new Float32Array(faces.length * 9);
  faces.forEach((f, i) => {
    const o = i * 9;
    const vs = [points[f.a], points[f.b], points[f.c]];
    vs.forEach((v, k) => {
      out[o + k * 3] = v.x;
      out[o + k * 3 + 1] = v.y;
      out[o + k * 3 + 2] = v.z;
    });
  });
  return { positions: out, approximated };
}

// ------------------------------------------------------------ candidate search

/**
 * `area_cumulation_accurate`: group faces by quantized normal, rank the groups
 * by total area, and return the ACCURATE normal of each group's biggest face.
 * Quantizing only decides the grouping — returning a quantized normal is what
 * upstream's comment warns accumulates error and picks bad orientations.
 */
function areaCumulationAccurate(faces: FaceSet, numDirections: number): Vec3[] {
  const groups = new Map<string, { sum: number; maxArea: number; normal: Vec3 }>();
  for (let i = 0; i < faces.count; i++) {
    const key = qkey(faces.normals[i]);
    const area = faces.areas[i];
    const found = groups.get(key);
    if (!found) {
      groups.set(key, { sum: area, maxArea: area, normal: faces.normals[i] });
      continue;
    }
    found.sum += area;
    if (area > found.maxArea) {
      found.maxArea = area;
      found.normal = faces.normals[i];
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.sum - a.sum)
    .slice(0, numDirections)
    .map((g) => g.normal);
}

/**
 * `add_supplements` — the 18 fixed directions upstream always considers, as
 * (right, forward, up) coefficients rather than literal xyz. Upstream writes
 * them with Z as the pole; expressing them in a basis built from {@link UP}
 * gives the identical set when UP is +Z and the correctly rotated set here.
 */
const SUPPLEMENT_COEFFS: Array<[number, number, number]> = [
  [0, 0, -1],
  [0.70710678, 0, -0.70710678],
  [0, 0.70710678, -0.70710678],
  [-0.70710678, 0, -0.70710678],
  [0, -0.70710678, -0.70710678],
  [1, 0, 0],
  [0.70710678, 0.70710678, 0],
  [0, 1, 0],
  [-0.70710678, 0.70710678, 0],
  [-1, 0, 0],
  [-0.70710678, -0.70710678, 0],
  [0, -1, 0],
  [0.70710678, -0.70710678, 0],
  [0.70710678, 0, 0.70710678],
  [0, 0.70710678, 0.70710678],
  [-0.70710678, 0, 0.70710678],
  [0, -0.70710678, 0.70710678],
  [0, 0, 1],
];

/** Right/forward vectors completing an orthonormal basis whose pole is `up`. */
function basisFor(up: Vec3): { right: Vec3; forward: Vec3 } {
  const seed = Math.abs(up.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const right = normalize(cross(seed, up));
  return { right, forward: normalize(cross(up, right)) };
}

function supplements(up: Vec3): Vec3[] {
  const { right, forward } = basisFor(up);
  return SUPPLEMENT_COEFFS.map(([r, f, u]) => ({
    x: right.x * r + forward.x * f + up.x * u,
    y: right.y * r + forward.y * f + up.y * u,
    z: right.z * r + forward.z * f + up.z * u,
  }));
}

function removeDuplicates(orientations: Vec3[], tol = 1e-7): Vec3[] {
  const kept: Vec3[] = [];
  for (const candidate of orientations) {
    if (norm(candidate) <= 0) continue;
    if (kept.some((k) => isApprox(k, candidate, tol))) continue;
    kept.push(candidate);
  }
  return kept;
}

// ------------------------------------------------------------------- scoring

interface Projection {
  zMax: Float64Array;
  zMean: Float64Array;
  minZ: number;
}

function project(faces: FaceSet, o: Vec3): Projection {
  const zMax = new Float64Array(faces.count);
  const zMean = new Float64Array(faces.count);
  let minZ = Infinity;
  const p = faces.positions;
  for (let i = 0; i < faces.count; i++) {
    const k = i * 9;
    const z0 = p[k] * o.x + p[k + 1] * o.y + p[k + 2] * o.z;
    const z1 = p[k + 3] * o.x + p[k + 4] * o.y + p[k + 5] * o.z;
    const z2 = p[k + 6] * o.x + p[k + 7] * o.y + p[k + 8] * o.z;
    zMax[i] = max3(z0, z1, z2);
    zMean[i] = (z0 + z1 + z2) / 3;
    const lo = Math.min(z0, Math.min(z1, z2));
    if (lo < minZ) minZ = lo;
  }
  return { zMax, zMean, minZ };
}

function projectMax(faces: FaceSet, o: Vec3): Float64Array {
  const zMax = new Float64Array(faces.count);
  const p = faces.positions;
  for (let i = 0; i < faces.count; i++) {
    const k = i * 9;
    zMax[i] = max3(
      p[k] * o.x + p[k + 1] * o.y + p[k + 2] * o.z,
      p[k + 3] * o.x + p[k + 4] * o.y + p[k + 5] * o.z,
      p[k + 6] * o.x + p[k + 7] * o.y + p[k + 8] * o.z,
    );
  }
  return zMax;
}

function getFeatures(
  mesh: FaceSet,
  hull: FaceSet,
  o: Vec3,
  params: OrientParams,
  ascent: number,
): OrientCosts {
  const proj = project(mesh, o);
  const hullZMax = hull.count ? projectMax(hull, o) : new Float64Array(0);
  const totalMinZ = proj.minZ;
  const firstLayer = totalMinZ + params.FIRST_LAY_H - EPSILON;
  const halfLayer = totalMinZ + params.FIRST_LAY_H / 2 - EPSILON;

  let bottomFirst = 0;
  let bottomHalf = 0;
  let overhang = 0;
  let areaLaf = 0;
  for (let i = 0; i < mesh.count; i++) {
    const area = mesh.areas[i];
    const zMax = proj.zMax[i];
    const inBottom = zMax < firstLayer;
    const inBottomHalf = zMax < halfLayer;
    if (inBottom) bottomFirst += area;
    if (inBottomHalf) bottomHalf += area;

    const np = dot(mesh.normals[i], o);
    // No 3MF appearance data exists here, so the appearance multiplier is 1 —
    // see the file header. The constant stays referenced so the term is real.
    const appearance = area * (0 * params.APPERANCE_FACE_SUPP + 1);
    if (np < ascent && !inBottomHalf) overhang += Math.abs(appearance);

    const npAbs = Math.abs(np);
    if (npAbs < params.LAF_MAX && npAbs > params.LAF_MIN && zMax > totalMinZ + params.FIRST_LAY_H) {
      areaLaf += area;
    }
  }

  let bottomHull = 0;
  for (let i = 0; i < hull.count; i++) {
    // The hull is compared against the MESH's minimum, exactly as upstream: the
    // question is what the hull covers at the bed, not where the hull's own
    // lowest facet happens to be.
    if (hullZMax[i] < firstLayer) bottomHull += hull.areas[i];
  }

  const bottom = bottomFirst * 0.5 + bottomHalf;
  return {
    overhang,
    bottom,
    bottom_hull: bottomHull,
    // Upstream keeps the cheap form and notes it is even better for the faces
    // of small bridges than summing real contour edges.
    contour: 4 * Math.sqrt(bottom),
    area_laf: areaLaf,
    area_projected: 0,
    unprintability: 0,
  };
}

function targetFunction(costs: OrientCosts, params: OrientParams): number {
  const laf = params.use_low_angle_face ? costs.area_laf : 0;
  const numerator = params.RELATIVE_F * (costs.overhang * params.TAR_C + params.TAR_D + params.TAR_LAF * laf);
  const denominator =
    params.TAR_D +
    params.CONTOUR_F * costs.contour +
    params.BOTTOM_F * costs.bottom +
    params.BOTTOM_HULL_F * costs.bottom_hull +
    params.TAR_PROJ_AREA * costs.area_projected;
  // A part with almost nothing touching the bed is not "cheap to print", it is
  // a part that falls over. Upstream's flat +100 says so.
  return numerator / denominator + (costs.bottom < params.BOTTOM_MIN ? 100 : 0);
}

// ------------------------------------------------------------ the rotation

/**
 * Rotation matrix (row-major) taking unit `from` onto unit `to`.
 * Antiparallel is the case that needs care: the cross product vanishes, so an
 * arbitrary perpendicular axis is chosen rather than dividing by zero.
 */
export function rotationFromTwoVectors(from: Vec3, to: Vec3): number[][] {
  const f = normalize(from);
  const t = normalize(to);
  const c = dot(f, t);
  if (c > 1 - 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let axis: Vec3;
  let angle: number;
  if (c < -1 + 1e-12) {
    const seed = Math.abs(f.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    axis = normalize(cross(f, seed));
    angle = Math.PI;
  } else {
    axis = normalize(cross(f, t));
    angle = Math.acos(Math.min(1, Math.max(-1, c)));
  }
  const s = Math.sin(angle);
  const co = Math.cos(angle);
  const k = 1 - co;
  const { x, y, z } = axis;
  return [
    [co + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, co + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, co + z * z * k],
  ];
}

/**
 * Matrix → three.js XYZ Euler.
 *
 * Deliberately three.js's convention rather than Slic3r's `extract_euler_angles`:
 * the number produced here is written straight into `mesh.rotation`, so it has
 * to mean what three.js will do with it. three.js 'XYZ' builds R = Rx·Ry·Rz.
 */
export function eulerFromRotationXYZ(m: number[][]): Vec3 {
  const m02 = Math.min(1, Math.max(-1, m[0][2]));
  const y = Math.asin(m02);
  if (Math.abs(m02) < 0.9999999) {
    return { x: Math.atan2(-m[1][2], m[2][2]), y, z: Math.atan2(-m[0][1], m[0][0]) };
  }
  // Gimbal lock: pitch is ±90°, so roll and yaw are the same rotation. Put it
  // all in x and leave z at zero rather than emitting two coupled numbers.
  return { x: Math.atan2(m[2][1], m[1][1]), y, z: 0 };
}

export function applyEulerXYZ(e: Vec3, v: Vec3): Vec3 {
  const cx = Math.cos(e.x), sx = Math.sin(e.x);
  const cy = Math.cos(e.y), sy = Math.sin(e.y);
  const cz = Math.cos(e.z), sz = Math.sin(e.z);
  // R = Rx·Ry·Rz, matching three.js Matrix4.makeRotationFromEuler('XYZ').
  const m = [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ];
  return {
    x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  };
}

// ------------------------------------------------------------------ the entry

/**
 * Score ONE orientation, for callers that want to explain a result rather than
 * only take it — and for tests that need to pin a term (the overhang cost of a
 * known slope, say) instead of inspecting whichever orientation happened to
 * win. `o` is the local direction that would end up pointing at {@link UP}.
 */
export function scoreOrientation(
  positions: Float32Array,
  o: Vec3,
  options: AutoOrientOptions = {},
): OrientCosts | null {
  const params: OrientParams = { ...ORIENT_PARAMS, ...options.params };
  if (options.overhangAngleDeg !== undefined) params.overhang_angle = options.overhangAngleDeg;
  const ascent = Math.cos(Math.PI - (params.overhang_angle * Math.PI) / 180);
  const mesh = facesOf(positions);
  if (mesh.count < 1) return null;
  const hull = facesOf(convexHull3d(positions).positions);
  const costs = getFeatures(mesh, hull, normalize(o), params, ascent);
  costs.unprintability = targetFunction(costs, params);
  return costs;
}

export interface AutoOrientOptions {
  params?: Partial<OrientParams>;
  /** Overrides `overhang_angle`; the process preset's support threshold. */
  overhangAngleDeg?: number;
}

/**
 * The whole of upstream's `AutoOrienter::process()`.
 *
 * `positions` is a non-indexed triangle soup in the object's LOCAL space — the
 * engine's `localPos`. Local, not world, is the point: the answer is a property
 * of the shape, so it does not drift with whatever the user rotated it to
 * before pressing the button.
 */
export function autoOrient(positions: Float32Array, options: AutoOrientOptions = {}): OrientResult | null {
  const params: OrientParams = { ...ORIENT_PARAMS, ...options.params };
  if (options.overhangAngleDeg !== undefined) params.overhang_angle = options.overhangAngleDeg;
  const ascent = Math.cos(Math.PI - (params.overhang_angle * Math.PI) / 180);

  const mesh = facesOf(positions);
  if (mesh.count < 4) return null;

  const hullResult = convexHull3d(positions);
  const hull = facesOf(hullResult.positions);

  // The original orientation is candidate zero, so "leave it alone" always
  // competes on the same scale as every alternative.
  const raw: Vec3[] = [negate(UP)];
  raw.push(...areaCumulationAccurate(mesh, 10));
  if (hull.count) raw.push(...areaCumulationAccurate(hull, 14));
  raw.push(...supplements(UP));
  const orientations = removeDuplicates(raw);

  let best: { o: Vec3; costs: OrientCosts } | null = null;
  let identity = Infinity;
  for (const candidate of orientations) {
    const o = negate(candidate);
    const costs = getFeatures(mesh, hull, o, params, ascent);
    costs.unprintability = targetFunction(costs, params);
    // Candidate zero negates to UP: the mesh exactly as it already sits.
    if (dot(o, UP) > 1 - 1e-9) identity = costs.unprintability;
    if (!best || costs.unprintability < best.costs.unprintability) best = { o, costs };
  }
  if (!best) return null;

  /**
   * ANTI-FLIP. When several orientations score the same, upstream prefers the
   * one that leaves the object alone — otherwise a symmetric part visibly
   * somersaults for a score it already had.
   */
  const upright: Vec3 = UP;
  if (Math.abs(dot(best.o, upright) - 1) > EPSILON) {
    for (const candidate of orientations) {
      const o = negate(candidate);
      if (Math.abs(dot(o, upright) - 1) >= EPSILON * EPSILON) continue;
      const costs = getFeatures(mesh, hull, o, params, ascent);
      costs.unprintability = targetFunction(costs, params);
      if (Math.abs(costs.unprintability - best.costs.unprintability) < EPSILON) {
        best = { o, costs };
      }
      break;
    }
  }

  const matrix = rotationFromTwoVectors(best.o, UP);
  return {
    orientation: best.o,
    euler: eulerFromRotationXYZ(matrix),
    costs: best.costs,
    identityUnprintability: identity,
    candidates: orientations.length,
    improved: identity - best.costs.unprintability > EPSILON,
    triangles: mesh.count,
    hullFaces: hull.count,
  };
}

/**
 * Lowest point of `positions` along {@link UP} once `euler` and `scale` apply.
 *
 * Re-seating is done by DIFFERENCE, not by assuming a convention: the caller
 * moves the object by (old lowest − new lowest), so whatever rule the engine
 * used to sit it on the bed keeps holding after the rotation.
 */
export function lowestPoint(positions: Float32Array, euler: Vec3, scale: Vec3): number {
  let lowest = Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const v = applyEulerXYZ(euler, {
      x: positions[i] * scale.x,
      y: positions[i + 1] * scale.y,
      z: positions[i + 2] * scale.z,
    });
    if (v.y < lowest) lowest = v.y;
  }
  return Number.isFinite(lowest) ? lowest : 0;
}
