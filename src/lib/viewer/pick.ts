/**
 * PICKING — our own ray–triangle test over the mesh's Float32Array (the viewer
 * core, docs/LEVO_PROJECT_PROGRAMME.md §0 row 20 and §B.2 item 5): a tap →
 * the triangle → its part (a binary search over the LVR1 ranges) → its region
 * → the region's editor. ogl's Raycast is never imported: it costs 3.5 KB and
 * does not return the triangle index. Pure maths, no DOM, no ogl — the unit
 * tests run it in Node.
 */

export type Vec3 = [number, number, number];

/** A ray: origin and unit direction, in whatever space the positions are (millimetres for a mesh). */
export interface Ray {
  o: Vec3;
  d: Vec3;
}

export interface TriangleHit {
  /** Index of the triangle in the LVM1 block (9 floats each). */
  triangle: number;
  /** Where the ray meets it, in the positions' space. */
  point: Vec3;
  /** Along the ray from its origin, in the positions' units. */
  distance: number;
}

/** Column-major 4×4 (ogl's Mat4, a Float32Array, a plain array) applied to a point (w = 1) or a direction (w = 0). */
function apply(m: ArrayLike<number>, v: ArrayLike<number>, w: number): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * w,
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * w,
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * w,
  ];
}

/**
 * The ray through a pixel of a perspective camera. `x`, `y` are CSS pixels from
 * the canvas's top-left corner, `width`, `height` its CSS size. The camera is
 * anything with a column-major `projectionMatrix` and `worldMatrix` (an ogl
 * Camera after `updateMatrixWorld()`). `toLocal` — the inverse of the model's
 * world matrix — brings the ray into the mesh's own millimetres.
 */
export function rayFromScreen(
  camera: { projectionMatrix: ArrayLike<number>; worldMatrix: ArrayLike<number> },
  x: number,
  y: number,
  width: number,
  height: number,
  toLocal?: ArrayLike<number>
): Ray {
  const p = camera.projectionMatrix;
  const w = camera.worldMatrix;
  // The view-space direction through the pixel: for a symmetric frustum the
  // projection's diagonal is all it takes to undo it.
  const view = [((2 * x) / width - 1) / p[0], (1 - (2 * y) / height) / p[5], -1];
  let o = apply(w, [0, 0, 0], 1);
  let d = apply(w, view, 0);
  if (toLocal) {
    o = apply(toLocal, o, 1);
    d = apply(toLocal, d, 0);
  }
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return { o, d: [d[0] / len, d[1] / len, d[2] / len] };
}

/** Slab test: does the ray pass through the box at all (grown by a hair)? */
function meetsBox(ray: Ray, min: ArrayLike<number>, max: ArrayLike<number>): boolean {
  let near = -Infinity;
  let far = Infinity;
  for (let a = 0; a < 3; a++) {
    const pad = (max[a] - min[a]) * 1e-3 + 1e-6;
    const inv = 1 / ray.d[a];
    let t0 = (min[a] - pad - ray.o[a]) * inv;
    let t1 = (max[a] + pad - ray.o[a]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
  }
  return near <= far && far >= 0;
}

/**
 * The nearest triangle the ray crosses (Möller–Trumbore), both faces — an
 * uploaded mesh's winding is not trusted, the same rule as the shader. `bbox`
 * (the LVM1 header's min / max; a ParsedMesh passes as it is) rejects a miss
 * without walking the triangles; `test` skips triangles the caller does not
 * show (a hidden part). null on a miss.
 */
export function pickTriangle(
  ray: Ray,
  positions: ArrayLike<number>,
  opts: { bbox?: { min: ArrayLike<number>; max: ArrayLike<number> }; test?: (triangle: number) => boolean } = {}
): TriangleHit | null {
  if (opts.bbox && !meetsBox(ray, opts.bbox.min, opts.bbox.max)) return null;
  const [ox, oy, oz] = ray.o;
  const [dx, dy, dz] = ray.d;
  const p = positions;
  let best = Infinity;
  let hit = -1;
  for (let t = 0, i = 0; i + 8 < p.length; t++, i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const e1x = p[i + 3] - ax, e1y = p[i + 4] - ay, e1z = p[i + 5] - az;
    const e2x = p[i + 6] - ax, e2y = p[i + 7] - ay, e2z = p[i + 8] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    // Parallel to the plane, or a degenerate (zero-area) triangle.
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist > 0 && dist < best && (!opts.test || opts.test(t))) {
      best = dist;
      hit = t;
    }
  }
  return hit < 0 ? null : { triangle: hit, point: [ox + dx * best, oy + dy * best, oz + dz * best], distance: best };
}

/**
 * The part a triangle belongs to, by binary search over the LVR1 ranges
 * (flat [start, count, …], contiguous, in part order). A part the compiler
 * emptied (count 0) shares its start with the next one, so the search lands on
 * the LAST part starting at or before the triangle. -1 when no range holds it.
 */
export function partOfTriangle(ranges: ArrayLike<number>, triangle: number): number {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ranges[mid * 2] <= triangle) lo = mid;
    else hi = mid - 1;
  }
  const start = ranges[lo * 2];
  return hi >= 0 && triangle >= start && triangle < start + ranges[lo * 2 + 1] ? lo : -1;
}
