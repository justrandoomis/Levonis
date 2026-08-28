/**
 * Plate packing and arrangement planning (S4 editor-core).
 *
 * Pure geometry — no DOM, no engine, no imports — so every function here is
 * unit-testable in Node (tests/arrange.test.mjs, tests/editor-capabilities.test.mjs).
 *
 * Declared limits (kept honest in the UI):
 * - the installed three-slicer engine supports at most {@link PLATE_CAP} plates;
 * - packing assumes a rectangular bed (the engine's bed model);
 * - locked objects are never moved: their plates are excluded from packing and
 *   everything that no longer fits is reported in `overflowCount` instead of
 *   being silently squeezed, scaled, or rotated.
 */

/** The engine's real plate limit. Never present "unlimited" while this holds. */
export const PLATE_CAP = 9;

export interface PackableModel {
  id: number;
  width: number;
  depth: number;
}

export interface PlatePlacement {
  id: number;
  plate: number;
  offsetX: number;
  offsetY: number;
  oversized: boolean;
}

export interface PlatePackingResult {
  placements: PlatePlacement[];
  platesUsed: number;
  overflowCount: number;
  oversizedCount: number;
}

interface Shelf {
  y: number;
  height: number;
  x: number;
}

interface PlateState {
  plate: number;
  shelves: Shelf[];
  nextY: number;
}

const MIN_FOOTPRINT = 0.01;

function finiteSize(value: number) {
  return Number.isFinite(value) ? Math.max(MIN_FOOTPRINT, Math.abs(value)) : MIN_FOOTPRINT;
}

/**
 * Deterministic shelf packing into an ordered list of available plate indices.
 * Coordinates are relative to each plate's centre, matching three-slicer's
 * `placeObjectOnPlate` contract (model mm, +Y = depth).
 */
function packIntoPlateSlots(
  models: PackableModel[],
  bedWidth: number,
  bedDepth: number,
  plateSlots: readonly number[],
): PlatePackingResult {
  const margin = 8;
  const gap = 6;
  const usableWidth = Math.max(20, bedWidth - margin * 2);
  const usableDepth = Math.max(20, bedDepth - margin * 2);
  const plates: PlateState[] = [];
  const placements: PlatePlacement[] = [];
  let overflowCount = 0;
  let oversizedCount = 0;

  const sorted = models.map((model, order) => ({
    ...model,
    order,
    width: finiteSize(model.width),
    depth: finiteSize(model.depth),
  })).sort((a, b) => (
    Math.max(b.width, b.depth) - Math.max(a.width, a.depth)
    || b.width * b.depth - a.width * a.depth
    || a.order - b.order
  ));

  const newPlate = () => {
    if (plates.length >= plateSlots.length) return null;
    const plate: PlateState = { plate: plateSlots[plates.length], shelves: [], nextY: 0 };
    plates.push(plate);
    return plate;
  };

  for (const model of sorted) {
    const oversized = model.width > usableWidth || model.depth > usableDepth;
    if (oversized) {
      const plate = newPlate();
      if (!plate) { overflowCount += 1; continue; }
      oversizedCount += 1;
      placements.push({ id: model.id, plate: plate.plate, offsetX: 0, offsetY: 0, oversized: true });
      continue;
    }

    let placed = false;
    for (let plateIndex = 0; plateIndex < plates.length && !placed; plateIndex += 1) {
      const plate = plates[plateIndex];
      for (const shelf of plate.shelves) {
        if (model.depth <= shelf.height && shelf.x + model.width <= usableWidth) {
          placements.push({
            id: model.id,
            plate: plate.plate,
            offsetX: -usableWidth / 2 + shelf.x + model.width / 2,
            offsetY: -usableDepth / 2 + shelf.y + model.depth / 2,
            oversized: false,
          });
          shelf.x += model.width + gap;
          placed = true;
          break;
        }
      }
      if (!placed && plate.nextY + model.depth <= usableDepth) {
        const shelf = { y: plate.nextY, height: model.depth, x: model.width + gap };
        plate.shelves.push(shelf);
        plate.nextY += model.depth + gap;
        placements.push({
          id: model.id,
          plate: plate.plate,
          offsetX: -usableWidth / 2 + model.width / 2,
          offsetY: -usableDepth / 2 + shelf.y + model.depth / 2,
          oversized: false,
        });
        placed = true;
      }
    }

    if (placed) continue;
    const plate = newPlate();
    if (!plate) { overflowCount += 1; continue; }
    plate.shelves.push({ y: 0, height: model.depth, x: model.width + gap });
    plate.nextY = model.depth + gap;
    placements.push({
      id: model.id,
      plate: plate.plate,
      offsetX: -usableWidth / 2 + model.width / 2,
      offsetY: -usableDepth / 2 + model.depth / 2,
      oversized: false,
    });
  }

  return { placements, platesUsed: plates.length, overflowCount, oversizedCount };
}

/**
 * Deterministic shelf packing for ZIP imports (historic entry point — behavior
 * unchanged). Packs into the contiguous plate range [startPlate, maxPlateCount).
 */
export function packModelsAcrossPlates(
  models: PackableModel[],
  bedWidth: number,
  bedDepth: number,
  startPlate = 0,
  maxPlateCount = PLATE_CAP,
): PlatePackingResult {
  const slots: number[] = [];
  for (let plate = startPlate; plate < maxPlateCount; plate += 1) slots.push(plate);
  return packIntoPlateSlots(models, bedWidth, bedDepth, slots);
}

// ---------------------------------------------------------------------------
// General arrangement of the CURRENT scene (not ZIP-only)
// ---------------------------------------------------------------------------

export interface ArrangeCandidate extends PackableModel {
  /** Locked objects are never moved; their plates are excluded from packing. */
  locked?: boolean;
  /** Current plate of the object (required to honor a locked object's plate). */
  plate?: number;
}

export interface ArrangePlanOptions {
  bedWidth: number;
  bedDepth: number;
  /** Defaults to {@link PLATE_CAP}. Values above the cap are clamped. */
  plateCap?: number;
}

export interface ArrangePlan extends PlatePackingResult {
  /** Number of locked objects that were left untouched. */
  lockedCount: number;
  /** Plates excluded from packing because a locked object lives there. */
  lockedPlates: number[];
  /** Plates that received at least one placement, ascending. */
  targetPlates: number[];
}

/**
 * Plans a general auto-arrange for the current objects. Locked objects keep
 * their exact position and plate; the plates they occupy are excluded from the
 * packing so nothing is placed on top of them (a declared, conservative
 * trade-off — it costs plate space but can never overlap a locked object).
 * Objects that do not fit within the plate cap are counted in `overflowCount`
 * and left for the caller to report honestly.
 */
export function planGeneralArrangement(
  candidates: readonly ArrangeCandidate[],
  options: ArrangePlanOptions,
): ArrangePlan {
  const cap = Math.max(1, Math.min(PLATE_CAP, Math.floor(options.plateCap ?? PLATE_CAP)));
  const lockedPlateSet = new Set<number>();
  const movable: PackableModel[] = [];
  let lockedCount = 0;

  for (const candidate of candidates) {
    if (candidate.locked) {
      lockedCount += 1;
      const plate = Number.isInteger(candidate.plate) ? (candidate.plate as number) : 0;
      lockedPlateSet.add(Math.max(0, plate));
      continue;
    }
    movable.push({ id: candidate.id, width: candidate.width, depth: candidate.depth });
  }

  const slots: number[] = [];
  for (let plate = 0; plate < cap; plate += 1) {
    if (!lockedPlateSet.has(plate)) slots.push(plate);
  }

  const packed = packIntoPlateSlots(movable, options.bedWidth, options.bedDepth, slots);
  const targetPlates = [...new Set(packed.placements.map((placement) => placement.plate))].sort((a, b) => a - b);

  return {
    ...packed,
    lockedCount,
    lockedPlates: [...lockedPlateSet].sort((a, b) => a - b),
    targetPlates,
  };
}

// ---------------------------------------------------------------------------
// Footprint math (extracted from the monolith's snapshotFootprint)
// ---------------------------------------------------------------------------

export interface FootprintSource {
  id: number;
  /** Flat triangle vertex buffer (x,y,z triplets) in local model space. */
  localPos: ArrayLike<number>;
  /** Euler rotation in radians (XYZ order, matching three-slicer snapshots). */
  rot: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

/**
 * Axis-aligned bed footprint (width along X, depth along the bed's Y) of an
 * object snapshot after applying its scale and XYZ Euler rotation. Matches the
 * math the ZIP arrangement has been using in slicer-client.
 */
export function snapshotFootprint(snapshot: FootprintSource): PackableModel {
  const positions = snapshot.localPos;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]);
    maxX = Math.max(maxX, positions[index]);
    minY = Math.min(minY, positions[index + 1]);
    maxY = Math.max(maxY, positions[index + 1]);
    minZ = Math.min(minZ, positions[index + 2]);
    maxZ = Math.max(maxZ, positions[index + 2]);
  }
  const halfX = Math.max(0.005, (maxX - minX) * Math.abs(snapshot.scale.x) / 2);
  const halfY = Math.max(0.005, (maxY - minY) * Math.abs(snapshot.scale.y) / 2);
  const halfZ = Math.max(0.005, (maxZ - minZ) * Math.abs(snapshot.scale.z) / 2);
  const cx = Math.cos(snapshot.rot.x);
  const sx = Math.sin(snapshot.rot.x);
  const cy = Math.cos(snapshot.rot.y);
  const sy = Math.sin(snapshot.rot.y);
  const cz = Math.cos(snapshot.rot.z);
  const sz = Math.sin(snapshot.rot.z);
  const r11 = cy * cz;
  const r12 = sx * sy * cz - cx * sz;
  const r13 = cx * sy * cz + sx * sz;
  const r31 = -sy;
  const r32 = sx * cy;
  const r33 = cx * cy;
  return {
    id: snapshot.id,
    width: 2 * (Math.abs(r11) * halfX + Math.abs(r12) * halfY + Math.abs(r13) * halfZ),
    depth: 2 * (Math.abs(r31) * halfX + Math.abs(r32) * halfY + Math.abs(r33) * halfZ),
  };
}
