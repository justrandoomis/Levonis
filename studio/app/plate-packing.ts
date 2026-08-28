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
  shelves: Shelf[];
  nextY: number;
}

const MIN_FOOTPRINT = 0.01;

function finiteSize(value: number) {
  return Number.isFinite(value) ? Math.max(MIN_FOOTPRINT, Math.abs(value)) : MIN_FOOTPRINT;
}

/**
 * Deterministic shelf packing for ZIP imports. Coordinates are returned relative
 * to each plate's centre, matching three-slicer's placeObjectOnPlate contract.
 */
export function packModelsAcrossPlates(
  models: PackableModel[],
  bedWidth: number,
  bedDepth: number,
  startPlate = 0,
  maxPlateCount = 9,
): PlatePackingResult {
  const margin = 8;
  const gap = 6;
  const usableWidth = Math.max(20, bedWidth - margin * 2);
  const usableDepth = Math.max(20, bedDepth - margin * 2);
  const capacity = Math.max(0, maxPlateCount - startPlate);
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
    if (plates.length >= capacity) return null;
    const plate: PlateState = { shelves: [], nextY: 0 };
    plates.push(plate);
    return plate;
  };

  for (const model of sorted) {
    const oversized = model.width > usableWidth || model.depth > usableDepth;
    if (oversized) {
      const plate = newPlate();
      if (!plate) { overflowCount += 1; continue; }
      oversizedCount += 1;
      placements.push({ id: model.id, plate: startPlate + plates.length - 1, offsetX: 0, offsetY: 0, oversized: true });
      continue;
    }

    let placed = false;
    for (let plateIndex = 0; plateIndex < plates.length && !placed; plateIndex += 1) {
      const plate = plates[plateIndex];
      for (const shelf of plate.shelves) {
        if (model.depth <= shelf.height && shelf.x + model.width <= usableWidth) {
          placements.push({
            id: model.id,
            plate: startPlate + plateIndex,
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
          plate: startPlate + plateIndex,
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
      plate: startPlate + plates.length - 1,
      offsetX: -usableWidth / 2 + model.width / 2,
      offsetY: -usableDepth / 2 + model.depth / 2,
      oversized: false,
    });
  }

  return { placements, platesUsed: plates.length, overflowCount, oversizedCount };
}
