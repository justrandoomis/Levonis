/**
 * THE SIZE OF A MODEL, AS THE PRINTER WILL SEE IT.
 *
 * The reference screen reads «أبعاد المجسم 80 × 40 × 30 mm». Nothing in the
 * shell knew that number: the engine emits no event when a transform changes
 * and reports no bounding box. It can be computed honestly from what the
 * engine does hand out, `sceneSnapshot()`: each object's raw local triangles
 * (`localPos`), its scale and its XYZ Euler rotation. Applying scale then
 * rotation to every vertex gives the world-space box the slicer will print.
 *
 * Every vertex, not the eight corners of the local box: a rotated box's
 * corners over-state the size of anything that is not itself a box, and the
 * whole point of the readout is to be the real number.
 *
 * Axes follow the engine (three.js, Y up): width is world X, depth is world Z
 * (the bed's second axis), height is world Y. Millimetres throughout.
 *
 * Pure and dependency-light (only the shared Euler maths), so the tests run it
 * on synthetic meshes without a browser.
 */
import { applyEulerXYZ, type Vec3 } from "./auto-orient";

/** The rotation matrix of an XYZ Euler, read off the shared helper's columns. */
function rotationMatrix(e: Vec3): number[] {
  const cx = applyEulerXYZ(e, { x: 1, y: 0, z: 0 });
  const cy = applyEulerXYZ(e, { x: 0, y: 1, z: 0 });
  const cz = applyEulerXYZ(e, { x: 0, y: 0, z: 1 });
  return [cx.x, cy.x, cz.x, cx.y, cy.y, cz.y, cx.z, cy.z, cz.z];
}

export interface ModelDimensions {
  width: number;
  depth: number;
  height: number;
}

export interface DimensionSource {
  id: number;
  localPos: ArrayLike<number>;
  rot: Vec3;
  scale: Vec3;
}

/**
 * The world-space extent of one object, or null when it has no measurable
 * geometry (an empty or degenerate buffer). A null is reported as "unknown",
 * never as zero: a zero would read as a model that fits anything.
 */
export function measureSnapshot(snapshot: DimensionSource): ModelDimensions | null {
  const positions = snapshot.localPos;
  if (!positions || positions.length < 3) return null;
  // One matrix for the object, then a plain multiply per vertex: a mesh of a
  // million triangles is nine million numbers, and allocating a vector for
  // each would be the expensive part.
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = rotationMatrix({ x: snapshot.rot.x, y: snapshot.rot.y, z: snapshot.rot.z });
  const sx = snapshot.scale.x;
  const sy = snapshot.scale.y;
  const sz = snapshot.scale.z;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const lx = positions[index] * sx;
    const ly = positions[index + 1] * sy;
    const lz = positions[index + 2] * sz;
    const x = m00 * lx + m01 * ly + m02 * lz;
    const y = m10 * lx + m11 * ly + m12 * lz;
    const z = m20 * lx + m21 * ly + m22 * lz;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxY)) return null;
  const dims = { width: maxX - minX, depth: maxZ - minZ, height: maxY - minY };
  if (!(dims.width > 0) || !(dims.depth > 0) || !(dims.height > 0)) return null;
  return dims;
}

/**
 * A cache keyed by what changes the answer: the object's geometry buffer and
 * its rotation and scale. A move does not change the size, so dragging a
 * model across the bed costs nothing; the vertex pass runs again only when
 * the object really turned, was scaled, or was replaced.
 */
export function createDimensionCache() {
  const cache = new Map<number, { buffer: ArrayLike<number>; key: string; dims: ModelDimensions | null }>();
  return {
    measure(snapshot: DimensionSource): ModelDimensions | null {
      const key = [snapshot.rot.x, snapshot.rot.y, snapshot.rot.z, snapshot.scale.x, snapshot.scale.y, snapshot.scale.z]
        .map((value) => value.toFixed(6))
        .join(",");
      const hit = cache.get(snapshot.id);
      if (hit && hit.buffer === snapshot.localPos && hit.key === key) return hit.dims;
      const dims = measureSnapshot(snapshot);
      cache.set(snapshot.id, { buffer: snapshot.localPos, key, dims });
      return dims;
    },
    /** Forget objects that left the scene. */
    retain(ids: Iterable<number>) {
      const keep = new Set(ids);
      for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
    },
  };
}

/**
 * «80 × 40 × 30 mm». Latin digits in every language (the Studio's readouts
 * are LTR by mandate §5); one decimal under 100 mm, where a tenth is
 * meaningful on a printer, whole millimetres above it, and never a trailing
 * ".0".
 */
export function formatDimensions(dims: ModelDimensions): string {
  const one = (value: number) => {
    const rounded = value < 100 ? Math.round(value * 10) / 10 : Math.round(value);
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  };
  return `${one(dims.width)} × ${one(dims.depth)} × ${one(dims.height)} mm`;
}
