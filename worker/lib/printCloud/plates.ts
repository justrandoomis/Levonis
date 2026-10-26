/**
 * BUILD PLATE GEOMETRY (docs/PRINT_CLOUD.md §7.3) — pure functions.
 *
 * What this does, exactly: every placed instance is reduced to the
 * axis-aligned rectangle its footprint occupies (its bounding box, scaled and
 * rotated about Z). The footprint is the model's box AS IT STANDS on the bed —
 * the file's box turned by the model's own transform (`orientedFootprint`) —
 * so a part laid flat is checked flat. A placement is VALID when every
 * rectangle, grown by half the spacing on each side, lies inside the bed and
 * overlaps no other, and every instance is no taller than the build height.
 *
 * `shelfPack` is a real arrangement algorithm — rows of bounding boxes,
 * tallest first, each instance tried at 0° and 90° — named `bbox_shelf_v1`.
 * It is NOT true-shape nesting and never claims to be: two L-shaped parts
 * that could interlock are placed as two rectangles. A better nester plugs in
 * through `PlateArranger` without changing the data model.
 */

export interface Footprint {
  /** Model bounding box, micrometres, before scale and rotation. */
  x_um: number;
  y_um: number;
  z_um: number;
}

export interface Placement {
  key: string;
  x_um: number;
  y_um: number;
  rotation_z_mdeg: number;
  scale_ppm: number;
  footprint: Footprint;
}

export interface Bed {
  x_um: number;
  y_um: number;
  z_um: number;
}

export interface PlateIssue {
  /**
   * ORIENTATION_UNKNOWN: the model is auto-oriented, so its footprint is not
   * known until it is sliced. MODEL_CHANGED: a model on the plate was turned
   * or swapped after the plate was checked; the plate must be made again.
   */
  code: 'OUT_OF_BED' | 'TOO_TALL' | 'COLLISION' | 'NOT_ARRANGEABLE' | 'ORIENTATION_UNKNOWN' | 'MODEL_CHANGED';
  keys: string[];
}

// Snapped to 1e-9 so a right angle is exactly a right angle (cos 90° is 6e-17 in floating point).
const snap = (v: number): number => Math.round(v * 1e9) / 1e9;

const radians = (mdeg: number): number => ((mdeg / 1000) * Math.PI) / 180;

/**
 * The file's bounding box turned by the model's own rotation — about X, then
 * Y, then Z (R = Rz·Ry·Rx, the order the slicer applies the transform). Each
 * extent is Σ |R_ij|·size_j: exact for quarter turns, and for any other
 * angle a box that still contains the turned part. A placement then turns
 * this box about Z for its own rotation.
 */
export function orientedFootprint(box: Footprint, rotation: { x_mdeg?: number; y_mdeg?: number; z_mdeg?: number }): Footprint {
  const [ax, ay, az] = [radians(rotation.x_mdeg ?? 0), radians(rotation.y_mdeg ?? 0), radians(rotation.z_mdeg ?? 0)];
  const rx = [[1, 0, 0], [0, Math.cos(ax), -Math.sin(ax)], [0, Math.sin(ax), Math.cos(ax)]];
  const ry = [[Math.cos(ay), 0, Math.sin(ay)], [0, 1, 0], [-Math.sin(ay), 0, Math.cos(ay)]];
  const rz = [[Math.cos(az), -Math.sin(az), 0], [Math.sin(az), Math.cos(az), 0], [0, 0, 1]];
  const mul = (a: number[][], b: number[][]) => a.map((r) => b[0].map((_, j) => r.reduce((sum, v, k) => sum + v * b[k][j], 0)));
  const size = [box.x_um, box.y_um, box.z_um];
  const [x, y, z] = mul(rz, mul(ry, rx)).map((r) => Math.ceil(snap(r.reduce((sum, v, j) => sum + snap(Math.abs(v)) * size[j], 0))));
  return { x_um: x, y_um: y, z_um: z };
}

/** The axis-aligned rectangle (centre-based) an instance occupies on the bed. */
export function occupied(p: Placement): { minX: number; maxX: number; minY: number; maxY: number; height: number } {
  const sx = Math.round((p.footprint.x_um * p.scale_ppm) / 1_000_000);
  const sy = Math.round((p.footprint.y_um * p.scale_ppm) / 1_000_000);
  const sz = Math.round((p.footprint.z_um * p.scale_ppm) / 1_000_000);
  const theta = radians(p.rotation_z_mdeg);
  const c = snap(Math.abs(Math.cos(theta)));
  const s = snap(Math.abs(Math.sin(theta)));
  const w = Math.ceil(sx * c + sy * s);
  const h = Math.ceil(sx * s + sy * c);
  return { minX: p.x_um - w / 2, maxX: p.x_um + w / 2, minY: p.y_um - h / 2, maxY: p.y_um + h / 2, height: sz };
}

/** Every problem with a set of placements; empty means printable as placed. */
export function validatePlacements(placements: Placement[], bed: Bed, spacingUm: number): PlateIssue[] {
  const issues: PlateIssue[] = [];
  const half = spacingUm / 2;
  const boxes = placements.map((p) => ({ key: p.key, r: occupied(p) }));
  for (const b of boxes) {
    if (b.r.minX - half < 0 || b.r.minY - half < 0 || b.r.maxX + half > bed.x_um || b.r.maxY + half > bed.y_um) {
      issues.push({ code: 'OUT_OF_BED', keys: [b.key] });
    }
    if (b.r.height > bed.z_um) issues.push({ code: 'TOO_TALL', keys: [b.key] });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r;
      const b = boxes[j].r;
      const apart = a.maxX + half <= b.minX - half || b.maxX + half <= a.minX - half || a.maxY + half <= b.minY - half || b.maxY + half <= a.minY - half;
      if (!apart) issues.push({ code: 'COLLISION', keys: [boxes[i].key, boxes[j].key] });
    }
  }
  return issues;
}

export interface PackItem {
  key: string;
  footprint: Footprint;
  scale_ppm: number;
}

export interface PlateArranger {
  name: string;
  arrange(items: PackItem[], bed: Bed, spacingUm: number): { placements: Placement[]; unplaced: string[] };
}

/** Rows of bounding boxes, tallest (in Y) first; each item tried at 0° and 90°. */
export const shelfPack: PlateArranger = {
  name: 'bbox_shelf_v1',
  arrange(items, bed, spacingUm) {
    const sized = items.map((it) => {
      const w = Math.round((it.footprint.x_um * it.scale_ppm) / 1_000_000);
      const h = Math.round((it.footprint.y_um * it.scale_ppm) / 1_000_000);
      return { it, w, h };
    });
    sized.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || a.it.key.localeCompare(b.it.key));
    const placements: Placement[] = [];
    const unplaced: string[] = [];
    let cursorX = spacingUm;
    let cursorY = spacingUm;
    let rowHeight = 0;
    for (const { it, w, h } of sized) {
      const tall = Math.round((it.footprint.z_um * it.scale_ppm) / 1_000_000);
      if (tall > bed.z_um) {
        unplaced.push(it.key);
        continue;
      }
      const options = [
        { rot: 0, w, h },
        { rot: 90_000, w: h, h: w },
      ];
      let placed = false;
      for (let attempt = 0; attempt < 2 && !placed; attempt++) {
        for (const o of options) {
          if (cursorX + o.w + spacingUm <= bed.x_um && cursorY + o.h + spacingUm <= bed.y_um) {
            placements.push({
              key: it.key,
              x_um: Math.round(cursorX + o.w / 2),
              y_um: Math.round(cursorY + o.h / 2),
              rotation_z_mdeg: o.rot,
              scale_ppm: it.scale_ppm,
              footprint: it.footprint,
            });
            cursorX += o.w + spacingUm;
            rowHeight = Math.max(rowHeight, o.h);
            placed = true;
            break;
          }
        }
        if (!placed) {
          // Next row, once.
          if (attempt === 0 && rowHeight > 0) {
            cursorX = spacingUm;
            cursorY += rowHeight + spacingUm;
            rowHeight = 0;
          } else {
            break;
          }
        }
      }
      if (!placed) unplaced.push(it.key);
    }
    return { placements, unplaced };
  },
};
