/**
 * Plane cut — split one object into two along a plane, and close the wound.
 *
 * WHY THIS EXISTS. "Cut" was the second capability the matrix listed as
 * Missing, and it is the one an ordinary user reaches for when a part is taller
 * than the bed: cut it, print the halves, glue them. It is also how a part with
 * an awkward overhang becomes two parts with none.
 *
 * RELATIONSHIP TO BambuStudio. Unlike app/auto-orient.ts, this is NOT a
 * line-by-line port. Upstream's `cut_mesh` (src/libslic3r/TriangleMeshSlicer.cpp)
 * is fused to libslic3r's scaled-integer slicer, its ExPolygon machinery and its
 * 2D triangulation library; bringing that across would mean porting the polygon
 * stack too. What is taken from upstream is the SHAPE of the operation — split
 * every facet against the plane, collect the intersection segments, chain them
 * into closed loops, triangulate those loops, and give each half the cap with
 * the winding that faces out of it. The geometry below is written for this
 * codebase and tested on its own terms (tests/plane-cut.test.mjs), including
 * the two properties that catch a capping bug outright: both halves stay
 * watertight, and their volumes still add up to the original.
 *
 * PURE GEOMETRY. No DOM, no three.js, no engine.
 *
 * THE FRAME. Positions are the engine's `localPos` — a non-indexed triangle
 * soup, 9 floats per triangle, in the object's own local space. The plane is
 * given as a unit normal and an offset (n·x = offset); "upper" means the n > 0
 * side.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CutPlane {
  /** Unit normal. "Upper" is the side this points at. */
  normal: Vec3;
  /** Plane is n·x = offset. */
  offset: number;
}

export interface CutResult {
  upper: Float32Array;
  lower: Float32Array;
  upperTriangles: number;
  lowerTriangles: number;
  /** Closed cross-section loops that were capped. */
  cappedLoops: number;
  /**
   * Chains that never closed — a symptom of a mesh that was not watertight to
   * begin with. Reported, never silently dropped: an unclosed cap is a hole,
   * and a hole is something the person cutting deserves to be told about.
   */
  openChains: number;
  /** Loops skipped for being larger than {@link LOOP_VERTEX_CAP}. */
  skippedLoops: number;
  /** The offset actually used, after {@link resolveOffset} moved it clear. */
  offset: number;
  /** True when the requested plane sat exactly on geometry and was nudged. */
  nudged: boolean;
}

/**
 * Ear clipping is O(n²) in a loop's vertex count. A cross-section with more
 * points than this is pathological (a scanned mesh cut through fur, say), and
 * spending a minute on it in the browser would be worse than saying so.
 */
export const LOOP_VERTEX_CAP = 20000;

// ------------------------------------------------------------------- vectors

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function normalize(a: Vec3): Vec3 {
  const n = Math.sqrt(dot(a, a));
  return n > 0 ? { x: a.x / n, y: a.y / n, z: a.z / n } : { x: 0, y: 0, z: 0 };
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

// ------------------------------------------------------------------ the split

interface Builder {
  data: number[];
}

function push(out: Builder, a: Vec3, b: Vec3, c: Vec3): void {
  out.data.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

/**
 * Tolerance for "this vertex is ON the plane".
 *
 * Scaled to the model, not a fixed epsilon: a 300mm part and a 3mm part have
 * very different float resolutions, and a fixed 1e-6 would treat a real
 * crossing on the big one as a touch.
 */
function planeEpsilon(positions: Float32Array): number {
  let extent = 0;
  for (let i = 0; i < positions.length; i++) {
    const v = Math.abs(positions[i]);
    if (v > extent) extent = v;
  }
  return Math.max(1e-7, extent * 1e-6);
}

interface Segment {
  a: Vec3;
  b: Vec3;
}

/**
 * Moves the plane off any vertex it sits exactly on.
 *
 * THE DEGENERACY THIS EXISTS FOR. A cut through a cube's corners runs along
 * whole mesh EDGES. No facet crosses there, so those sides of the cross-section
 * produce no intersection segment at all, the loop cannot close, and the cap is
 * silently missing — which is exactly what the first run of
 * tests/plane-cut.test.mjs caught on a 45-degree cut. Upstream handles this
 * with a dedicated facet-classification state machine; the cheaper and equally
 * honest answer is to refuse to sit on the geometry in the first place.
 *
 * The nudge is bounded and tiny: `eps` is the model's extent times 1e-6, so on
 * a 200mm part the largest possible move is a few microns — orders of magnitude
 * below anything a printer can resolve, and reported through `nudged` rather
 * than hidden.
 */
function resolveOffset(positions: Float32Array, normal: Vec3, offset: number, eps: number): { offset: number; nudged: boolean } {
  const clear = (candidate: number): boolean => {
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const d = positions[i] * normal.x + positions[i + 1] * normal.y + positions[i + 2] * normal.z - candidate;
      if (Math.abs(d) <= eps) return false;
    }
    return true;
  };
  if (clear(offset)) return { offset, nudged: false };
  for (let step = 1; step <= 8; step++) {
    const up = offset + step * eps * 3;
    if (clear(up)) return { offset: up, nudged: true };
    const down = offset - step * eps * 3;
    if (clear(down)) return { offset: down, nudged: true };
  }
  // Nowhere clear within a few microns — a mesh that dense will be reported
  // through `openChains` rather than quietly mis-capped.
  return { offset, nudged: false };
}

/**
 * Splits one triangle against the plane.
 *
 * The interesting case is a genuine crossing: one vertex on one side, two on
 * the other. The lone vertex keeps one triangle; the pair becomes two. The
 * intersection segment is oriented `n × m` (m being the facet's outward
 * normal), which is the direction that leaves the solid on the left when the
 * plane is viewed from +n — so the chained loops come out wound correctly for
 * the LOWER half's cap without a second pass to guess at it.
 */
function splitTriangle(
  v: [Vec3, Vec3, Vec3],
  d: [number, number, number],
  eps: number,
  normal: Vec3,
  upper: Builder,
  lower: Builder,
  segments: Segment[],
): void {
  const above = d.map((x) => x > eps);
  const below = d.map((x) => x < -eps);
  const nAbove = above.filter(Boolean).length;
  const nBelow = below.filter(Boolean).length;

  if (nBelow === 0) {
    // Entirely above, or lying in the plane. A facet in the plane belongs to
    // the upper half only, or both halves would carry the same skin.
    push(upper, v[0], v[1], v[2]);
    return;
  }
  if (nAbove === 0) {
    push(lower, v[0], v[1], v[2]);
    return;
  }

  const facetNormal = normalize(cross(sub(v[1], v[0]), sub(v[2], v[0])));
  const along = cross(normal, facetNormal);

  // Index of the vertex alone on its side of the plane.
  let lone = 0;
  for (let i = 0; i < 3; i++) {
    if (nAbove === 1 ? above[i] : below[i]) lone = i;
  }
  const i0 = lone;
  const i1 = (lone + 1) % 3;
  const i2 = (lone + 2) % 3;

  const cutAt = (a: number, b: number): Vec3 => {
    const denom = d[a] - d[b];
    // A zero denominator means both ends are at the same height, which cannot
    // happen for an edge the classification says crosses — but if float noise
    // produces one, the midpoint is the honest answer rather than a NaN.
    const t = Math.abs(denom) > 0 ? d[a] / denom : 0.5;
    return lerp(v[a], v[b], Math.min(1, Math.max(0, t)));
  };

  const p01 = cutAt(i0, i1);
  const p02 = cutAt(i0, i2);

  const loneSide = nAbove === 1 ? upper : lower;
  const otherSide = nAbove === 1 ? lower : upper;
  // The lone vertex keeps the winding it had.
  push(loneSide, v[i0], p01, p02);
  // The remaining quad, fanned. Winding follows the original triangle.
  push(otherSide, p01, v[i1], v[i2]);
  push(otherSide, p01, v[i2], p02);

  // One segment per crossing facet, pointed the way the loop should run.
  const forward = dot(sub(p02, p01), along) >= 0;
  segments.push(forward ? { a: p01, b: p02 } : { a: p02, b: p01 });
}

// ------------------------------------------------------------ loop chaining

/** Quantised key, so two endpoints computed from different facets meet. */
function keyOf(p: Vec3, scale: number): string {
  const q = (n: number) => Math.round(n / scale);
  return `${q(p.x)},${q(p.y)},${q(p.z)}`;
}

interface Chained {
  loops: Vec3[][];
  openChains: number;
}

function chainLoops(segments: Segment[], scale: number): Chained {
  const starts = new Map<string, number[]>();
  segments.forEach((s, i) => {
    const key = keyOf(s.a, scale);
    const list = starts.get(key);
    if (list) list.push(i);
    else starts.set(key, [i]);
  });

  const used = new Array<boolean>(segments.length).fill(false);
  const loops: Vec3[][] = [];
  let openChains = 0;

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const startKey = keyOf(segments[i].a, scale);
    const loop: Vec3[] = [segments[i].a];
    let current = segments[i];

    for (;;) {
      loop.push(current.b);
      const endKey = keyOf(current.b, scale);
      if (endKey === startKey) {
        // Closed. The last point repeats the first, so drop it.
        loop.pop();
        if (loop.length >= 3) loops.push(loop);
        break;
      }
      const candidates = starts.get(endKey);
      const next = candidates?.find((index) => !used[index]);
      if (next === undefined) {
        // The chain ran out before returning to its start: the source mesh had
        // a hole along this cut. Counted, and left uncapped.
        openChains++;
        break;
      }
      used[next] = true;
      current = segments[next];
      if (loop.length > LOOP_VERTEX_CAP) {
        openChains++;
        break;
      }
    }
  }
  return { loops, openChains };
}

// ------------------------------------------------------- 2D, holes, ear clip

interface Basis {
  u: Vec3;
  v: Vec3;
}

function basisFor(normal: Vec3): Basis {
  const seed = Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = normalize(cross(seed, normal));
  return { u, v: normalize(cross(normal, u)) };
}

interface Pt2 {
  x: number;
  y: number;
  source: Vec3;
}

const to2d = (p: Vec3, b: Basis): Pt2 => ({ x: dot(p, b.u), y: dot(p, b.v), source: p });

function signedArea(ring: Pt2[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  }
  return sum / 2;
}

function pointInRing(p: Pt2, ring: Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

const area2 = (a: Pt2, b: Pt2, c: Pt2): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function pointInTriangle(p: Pt2, a: Pt2, b: Pt2, c: Pt2): boolean {
  const d1 = area2(p, a, b);
  const d2 = area2(p, b, c);
  const d3 = area2(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Bridges one hole into its containing ring with a two-way "keyhole" cut, the
 * standard way to make a ring-with-holes into a single simple polygon that ear
 * clipping can eat. The bridge is taken from the hole's rightmost vertex to the
 * nearest outer vertex that can see it.
 */
function bridgeHole(outer: Pt2[], hole: Pt2[]): Pt2[] {
  let holeIndex = 0;
  for (let i = 1; i < hole.length; i++) {
    if (hole[i].x > hole[holeIndex].x) holeIndex = i;
  }
  const h = hole[holeIndex];

  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < outer.length; i++) {
    if (outer[i].x < h.x) continue;
    const dx = outer[i].x - h.x;
    const dy = outer[i].y - h.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) {
    // Nothing to the right — fall back to the nearest vertex in any direction
    // rather than refusing to cap.
    bestDistance = Infinity;
    for (let i = 0; i < outer.length; i++) {
      const dx = outer[i].x - h.x;
      const dy = outer[i].y - h.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
  }

  const rotated = [...hole.slice(holeIndex), ...hole.slice(0, holeIndex)];
  return [
    ...outer.slice(0, bestIndex + 1),
    ...rotated,
    rotated[0],
    ...outer.slice(bestIndex),
  ];
}

const samePoint = (a: Pt2, b: Pt2, tol: number): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

/**
 * Ear clipping on a simple CCW polygon. Returns triangles, or an EMPTY array if
 * it could not finish — never a partial fan.
 *
 * WHY NOT PARTIAL. A half-triangulated cap still looks like a cap and still
 * passes a glance, but it makes the solid wrong: the tube test measured the
 * lower half 1024 mm³ light because a bailed-out clip emitted some of the ring
 * and the caller counted it as capped. An incomplete cap is now reported as a
 * skipped loop instead, so the failure is visible rather than baked into the
 * geometry.
 *
 * THE COINCIDENT-VERTEX TRAP. Bridging a hole is a keyhole cut, so the bridge
 * vertices appear TWICE in the merged ring by design. An inclusive
 * point-in-triangle test therefore reports every duplicate as "inside" any
 * triangle that touches it, no ear is ever found, and the clip stalls at the
 * first bridge. Points coincident with the candidate ear's own corners are
 * skipped for that reason.
 */
function earClip(ring: Pt2[]): Array<[Pt2, Pt2, Pt2]> {
  const out: Array<[Pt2, Pt2, Pt2]> = [];
  const indices = ring.map((_, i) => i);
  const wanted = ring.length - 2;
  let extent = 0;
  for (const p of ring) extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
  const tol = Math.max(1e-9, extent * 1e-9);
  let guard = indices.length * indices.length + 16;

  while (indices.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < indices.length; i++) {
      const ia = indices[(i + indices.length - 1) % indices.length];
      const ib = indices[i];
      const ic = indices[(i + 1) % indices.length];
      const a = ring[ia];
      const b = ring[ib];
      const c = ring[ic];
      if (area2(a, b, c) <= 0) continue; // reflex or degenerate

      let contains = false;
      for (const other of indices) {
        if (other === ia || other === ib || other === ic) continue;
        const p = ring[other];
        // A bridge duplicates its endpoints on purpose; a duplicate sitting on
        // a corner is not a point INSIDE the ear.
        if (samePoint(p, a, tol) || samePoint(p, b, tol) || samePoint(p, c, tol)) continue;
        if (pointInTriangle(p, a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      out.push([a, b, c]);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    // No ear found: the ring is self-intersecting or fully degenerate. Give up
    // completely rather than hand back half a cap.
    if (!clipped) return [];
  }
  if (indices.length === 3) {
    out.push([ring[indices[0]], ring[indices[1]], ring[indices[2]]]);
  }
  return out.length === wanted ? out : [];
}

// ------------------------------------------------------------------- the cut

export function cutByPlane(
  positions: Float32Array,
  plane: CutPlane,
  options: { cap?: boolean } = {},
): CutResult | null {
  const triangles = Math.floor(positions.length / 9);
  if (triangles < 1) return null;
  const normal = normalize(plane.normal);
  if (!normal.x && !normal.y && !normal.z) return null;

  const eps = planeEpsilon(positions);
  const resolved = resolveOffset(positions, normal, plane.offset, eps);
  const upper: Builder = { data: [] };
  const lower: Builder = { data: [] };
  const segments: Segment[] = [];

  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const v: [Vec3, Vec3, Vec3] = [
      { x: positions[o], y: positions[o + 1], z: positions[o + 2] },
      { x: positions[o + 3], y: positions[o + 4], z: positions[o + 5] },
      { x: positions[o + 6], y: positions[o + 7], z: positions[o + 8] },
    ];
    const d: [number, number, number] = [
      dot(v[0], normal) - resolved.offset,
      dot(v[1], normal) - resolved.offset,
      dot(v[2], normal) - resolved.offset,
    ];
    splitTriangle(v, d, eps, normal, upper, lower, segments);
  }

  let cappedLoops = 0;
  let openChains = 0;
  let skippedLoops = 0;

  if (options.cap !== false && segments.length) {
    const chained = chainLoops(segments, Math.max(eps * 8, 1e-6));
    openChains = chained.openChains;
    const basis = basisFor(normal);

    const rings = chained.loops.map((loop) => loop.map((p) => to2d(p, basis)));
    // Even depth is an outer ring, odd is a hole — the standard nesting rule,
    // and the reason a cut tube ends up with a bore rather than a filled disc.
    const depth = rings.map((ring, i) =>
      rings.reduce((count, other, j) => (i !== j && pointInRing(ring[0], other) ? count + 1 : count), 0));

    rings.forEach((ring, i) => {
      if (depth[i] % 2 !== 0) return;
      const holes = rings.filter((_, j) => j !== i && depth[j] === depth[i] + 1 && pointInRing(rings[j][0], ring));
      // Outer rings CCW, holes CW: ear clipping needs one consistent sense.
      let merged = signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
      for (const hole of holes) {
        const oriented = signedArea(hole) > 0 ? [...hole].reverse() : [...hole];
        merged = bridgeHole(merged, oriented);
      }
      if (merged.length > LOOP_VERTEX_CAP) {
        skippedLoops++;
        return;
      }
      const fan = earClip(merged);
      if (!fan.length) {
        skippedLoops++;
        return;
      }
      for (const [a, b, c] of fan) {
        // The lower half's cap faces +n; the upper half's faces -n. Same
        // triangle, opposite winding, so each half stays a closed solid.
        push(lower, a.source, b.source, c.source);
        push(upper, a.source, c.source, b.source);
      }
      cappedLoops++;
    });
  }

  return {
    upper: new Float32Array(upper.data),
    lower: new Float32Array(lower.data),
    upperTriangles: upper.data.length / 9,
    lowerTriangles: lower.data.length / 9,
    cappedLoops,
    openChains,
    skippedLoops,
    offset: resolved.offset,
    nudged: resolved.nudged,
  };
}

/** Extent of `positions` along `normal` — what a cut-height control needs. */
export function extentAlong(positions: Float32Array, normal: Vec3): { min: number; max: number } {
  const n = normalize(normal);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const d = positions[i] * n.x + positions[i + 1] * n.y + positions[i + 2] * n.z;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

/**
 * Signed volume of a closed triangle soup. Used by the tests to prove the two
 * halves still add up to the whole — the check that catches a capping mistake
 * that merely LOOKS right.
 */
export function meshVolume(positions: Float32Array): number {
  let sum = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    sum += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return sum;
}
