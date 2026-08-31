/**
 * Where a newly spawned object actually goes (S4 editor-core).
 *
 * THE BUG THIS FIXES, at its source.
 *
 * The engine seats every object it creates without an explicit position from a
 * single monotonic cursor. Verbatim from viewer/dist/Viewport.js (the `ut`
 * spawn helper, which `spawnSnapshot` — i.e. Duplicate, Paste and Split —
 * calls with a null position):
 *
 *     const Ke = (Ae.boundingBox.max.x - Ae.boundingBox.min.x) * (R ? Math.abs(R.x) : 1)
 *     a.current.length === 0 && (l.current = 0)
 *     const Mt = $(o.current)
 *     _e.position.set(Mt.x + l.current + Ke / 2, 0, Mt.z), l.current += Ke + 8
 *
 * `l.current` only ever grows, and only ever resets when the scene becomes
 * completely empty. It does not know the bed's width, does not know that the
 * user moved the last copy somewhere else, and does not know that the space
 * next to the original is free. So the first duplicate lands beside the model,
 * the third lands at the bed edge, and the fifth lands in open space far past
 * it — which is exactly what the owner reported: the copy is thrown far away
 * while there is free room right there.
 *
 * This module computes where the copy SHOULD go: the free spot nearest to the
 * object it came from, inside the printable area, overlapping nothing. The
 * shell then puts it there via the engine's own `placeObjectOnPlate`.
 *
 * Why here and not as a patch to the engine's cursor: this fixes every path at
 * once (the toolbar button, the context menu, Ctrl+K, paste, and a file
 * dropped on the canvas), it is pure geometry that Node can test exactly, and
 * it does not depend on the shape of a minified expression that a version bump
 * would change underneath it.
 *
 * Pure — no DOM, no engine, no imports. tests/spawn-seating.test.mjs.
 */

/** Footprint of something already on a plate, in plate-centre-relative mm. */
export interface SeatedFootprint {
  id: number;
  plate: number;
  /** Centre offset from the plate centre, model mm (+Y = depth). */
  offsetX: number;
  offsetY: number;
  width: number;
  depth: number;
}

/** An object that needs a home. */
export interface SeatRequest {
  id: number;
  width: number;
  depth: number;
}

export interface SeatPlanOptions {
  bedWidth: number;
  bedDepth: number;
  /** Plate to try first — normally the plate the copy's source sits on. */
  preferredPlate?: number;
  /** Plates that may be used at all, in the order they should be tried. */
  availablePlates?: readonly number[];
  /**
   * Where the object would ideally land (plate-relative mm) — the source
   * object's centre for a duplicate. The nearest free spot to this point wins.
   */
  nearOffsetX?: number;
  nearOffsetY?: number;
}

export interface Seat {
  id: number;
  plate: number;
  offsetX: number;
  offsetY: number;
}

export interface SeatPlan {
  seats: Seat[];
  /** Objects with nowhere to go. Reported, never squeezed, scaled or rotated. */
  unseated: number[];
}

/** Matches the arrange planner's clearances, so both agree on what "fits" means. */
const MARGIN = 8;
const GAP = 6;
const MIN_FOOTPRINT = 0.01;

interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function finiteSize(value: number): number {
  return Number.isFinite(value) ? Math.max(MIN_FOOTPRINT, Math.abs(value)) : MIN_FOOTPRINT;
}

function rectOf(centreX: number, centreY: number, width: number, depth: number): Rect {
  return {
    minX: centreX - width / 2,
    minY: centreY - depth / 2,
    maxX: centreX + width / 2,
    maxY: centreY + depth / 2,
  };
}

/** True when two rectangles are closer than the packing gap in both axes. */
function collides(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX + GAP
    && b.minX < a.maxX + GAP
    && a.minY < b.maxY + GAP
    && b.minY < a.maxY + GAP;
}

/**
 * Above this many objects on a plate, the candidate set is trimmed to the
 * far-edge corners only. The full set is (3n+1)² positions each tested against
 * n rectangles, which is fine for the handful of objects a bed holds and is
 * not something to run unbounded on a scene someone has filled. The trimmed
 * set still only ever proposes positions flush against the bed or another
 * object — it just offers fewer of them.
 */
const FULL_CANDIDATE_SET_LIMIT = 48;

/**
 * Free-corner placement: the candidate positions are the bed's own corner plus
 * the edges of everything already placed. That is the standard corner-point
 * heuristic — it can only ever produce a position flush against the bed or
 * against another object, so the copy lands beside its source rather than in
 * open space, and the search is exact rather than sampling a grid and hoping.
 *
 * Both sides of each occupant are offered, and its own near edges as well: a
 * copy can sit to the right of the original, to its left, in front of it, or
 * behind it, and only offering the far corners would leave the obvious spot —
 * directly beside, aligned — unreachable.
 */
function seatOnPlate(
  request: SeatRequest,
  occupied: readonly Rect[],
  bedWidth: number,
  bedDepth: number,
  nearX: number,
  nearY: number,
): { offsetX: number; offsetY: number } | null {
  const usableWidth = Math.max(20, bedWidth - MARGIN * 2);
  const usableDepth = Math.max(20, bedDepth - MARGIN * 2);
  const width = finiteSize(request.width);
  const depth = finiteSize(request.depth);
  if (width > usableWidth || depth > usableDepth) return null;

  const minX = -usableWidth / 2;
  const minY = -usableDepth / 2;
  const maxX = usableWidth / 2;
  const maxY = usableDepth / 2;

  const trimmed = occupied.length > FULL_CANDIDATE_SET_LIMIT;
  const xs = new Set<number>([minX]);
  const ys = new Set<number>([minY]);
  for (const rect of occupied) {
    xs.add(rect.maxX + GAP);
    ys.add(rect.maxY + GAP);
    if (trimmed) continue;
    // Aligned with the occupant's own near edge (beside it, same row) …
    xs.add(rect.minX);
    ys.add(rect.minY);
    // … and on its near side (to its left / in front of it).
    xs.add(rect.minX - GAP - width);
    ys.add(rect.minY - GAP - depth);
  }

  const candidates: Array<{ x: number; y: number; score: number }> = [];
  for (const y of ys) {
    if (y < minY - 1e-6 || y + depth > maxY + 1e-6) continue;
    for (const x of xs) {
      if (x < minX - 1e-6 || x + width > maxX + 1e-6) continue;
      const dx = x + width / 2 - nearX;
      const dy = y + depth / 2 - nearY;
      candidates.push({ x, y, score: dx * dx + dy * dy });
    }
  }
  // Nearest first, then lowest, then leftmost — so an identical scene always
  // produces an identical seat.
  candidates.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x);

  for (const candidate of candidates) {
    const box = { minX: candidate.x, minY: candidate.y, maxX: candidate.x + width, maxY: candidate.y + depth };
    if (occupied.some((rect) => collides(box, rect))) continue;
    return { offsetX: candidate.x + width / 2, offsetY: candidate.y + depth / 2 };
  }
  return null;
}

/**
 * Seats each requested object in the nearest free spot, trying the preferred
 * plate first and then the remaining available plates in order. Objects that
 * fit nowhere are returned in `unseated` — the caller reports that honestly
 * and leaves them where the engine put them; nothing is scaled or rotated to
 * force a fit, and nothing is stacked on top of another object.
 */
export function planSeats(
  requests: readonly SeatRequest[],
  occupied: readonly SeatedFootprint[],
  options: SeatPlanOptions,
): SeatPlan {
  const seats: Seat[] = [];
  const unseated: number[] = [];
  if (!requests.length) return { seats, unseated };

  const preferred = Number.isInteger(options.preferredPlate) ? (options.preferredPlate as number) : 0;
  const available = options.availablePlates?.length ? [...options.availablePlates] : [preferred];
  const order = [preferred, ...available.filter((plate) => plate !== preferred)];

  // Live occupancy per plate: seats made in this run block later ones, so two
  // objects duplicated together never land on top of each other.
  const byPlate = new Map<number, Rect[]>();
  for (const item of occupied) {
    const rects = byPlate.get(item.plate) ?? [];
    rects.push(rectOf(item.offsetX, item.offsetY, finiteSize(item.width), finiteSize(item.depth)));
    byPlate.set(item.plate, rects);
  }

  const nearX = Number.isFinite(options.nearOffsetX) ? (options.nearOffsetX as number) : 0;
  const nearY = Number.isFinite(options.nearOffsetY) ? (options.nearOffsetY as number) : 0;

  for (const request of requests) {
    let seated = false;
    for (const plate of order) {
      const rects = byPlate.get(plate) ?? [];
      // Only the preferred plate aims at the source object; an overflow plate
      // is empty space, so the copy belongs at its centre, not in a corner.
      const targetX = plate === preferred ? nearX : 0;
      const targetY = plate === preferred ? nearY : 0;
      const spot = seatOnPlate(request, rects, options.bedWidth, options.bedDepth, targetX, targetY);
      if (!spot) continue;
      seats.push({ id: request.id, plate, offsetX: spot.offsetX, offsetY: spot.offsetY });
      rects.push(rectOf(spot.offsetX, spot.offsetY, finiteSize(request.width), finiteSize(request.depth)));
      byPlate.set(plate, rects);
      seated = true;
      break;
    }
    if (!seated) unseated.push(request.id);
  }

  return { seats, unseated };
}
