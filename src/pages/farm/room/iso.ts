/**
 * Isometric geometry for the print room. Pure — tests import it directly.
 *
 * A 2:1 projection: one world unit along x moves TILE/2 right and TILE/4 down,
 * one unit along y moves TILE/2 LEFT and TILE/4 down, z rises straight up.
 * Everything in the room — floor tiles, walls, the shelf, the table and each
 * printer's anchor — is placed in world units and projected once.
 */

export const TILE = 64;
/**
 * Wall height in px. Low on purpose: the walls are a backdrop, the floor and
 * the machines are the picture — at 74 the hero was mostly empty wall.
 */
export const WALL_H = 40;

export interface Pt {
  x: number;
  y: number;
}

export function iso(x: number, y: number, z = 0): Pt {
  return { x: (x - y) * (TILE / 2), y: (x + y) * (TILE / 4) - z };
}

export function pts(points: Pt[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/** Columns × rows for `n` printer slots — roughly 3:2, never narrower than a slot. */
export function gridFor(n: number): { cols: number; rows: number } {
  const count = Math.max(1, Math.floor(n));
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * 1.5)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows };
}

export function slotCell(slot: number, cols: number): { col: number; row: number } {
  return { col: slot % cols, row: Math.floor(slot / cols) };
}

export interface ViewBox {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

export interface RoomTile {
  slot: number;
  col: number;
  row: number;
  /** Floor centre of the tile, projected. */
  cx: number;
  cy: number;
  /** The diamond's four corners, projected. */
  corners: Pt[];
}

export interface RoomLayout {
  cols: number;
  rows: number;
  viewBox: ViewBox;
  tiles: RoomTile[];
  /** Back-left wall (the x = 0 edge) and back-right wall (the y = 0 edge). */
  wallLeft: Pt[];
  wallRight: Pt[];
  /** The skirting line where the two walls meet the floor. */
  skirting: Pt[];
  /** Two shelf planks along the left wall (top faces), their brackets, and the spool anchors on the upper plank. */
  shelf: { planks: Pt[][]; brackets: Array<{ a: Pt; b: Pt }>; spoolAnchors: Pt[] };
  /** The work table as its three visible faces. */
  table: { top: Pt[]; left: Pt[]; right: Pt[] };
  /** A small toolbox on the table, three faces. */
  toolbox: { top: Pt[]; left: Pt[]; right: Pt[] };
}

/** The three visible faces of a box standing on z = z0 with its top at z1. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): { top: Pt[]; left: Pt[]; right: Pt[] } {
  return {
    top: [iso(x0, y0, z1), iso(x1, y0, z1), iso(x1, y1, z1), iso(x0, y1, z1)],
    left: [iso(x0, y1, z0), iso(x1, y1, z0), iso(x1, y1, z1), iso(x0, y1, z1)],
    right: [iso(x1, y0, z0), iso(x1, y1, z0), iso(x1, y1, z1), iso(x1, y0, z1)],
  };
}

/**
 * The whole room for a location with `maxPrinters` slots. The floor grid has
 * one extra row of depth at the back so the shelf and table sit against the
 * walls rather than on a printer's tile.
 */
export function roomLayout(maxPrinters: number): RoomLayout {
  const { cols, rows } = gridFor(maxPrinters);
  const depth = rows + 1; // one back row for furniture
  const width = cols;

  const tiles: RoomTile[] = [];
  for (let slot = 0; slot < Math.max(1, Math.floor(maxPrinters)); slot++) {
    const { col, row } = slotCell(slot, cols);
    const x = col;
    const y = row + 1; // printers start behind the furniture row
    const c = iso(x + 0.5, y + 0.5);
    tiles.push({
      slot,
      col,
      row,
      cx: c.x,
      cy: c.y,
      corners: [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)],
    });
  }

  const wallLeft = [iso(0, 0), iso(0, depth), iso(0, depth, WALL_H), iso(0, 0, WALL_H)];
  const wallRight = [iso(0, 0), iso(width, 0), iso(width, 0, WALL_H), iso(0, 0, WALL_H)];
  const skirting = [iso(0, depth, 2), iso(0, 0, 2), iso(width, 0, 2)];

  // Shelf on the left wall: two planks 0.32 deep on brackets, spanning most of
  // the wall, both under the wall's top edge. The spools sit on the upper one.
  const shelfY0 = 0.15;
  const shelfY1 = Math.max(shelfY0 + 0.6, depth - 0.35);
  const shelfZ = [Math.round(WALL_H * 0.65), Math.round(WALL_H * 0.32)];
  const plank = (z: number): Pt[] => [iso(0, shelfY0, z), iso(0.32, shelfY0, z), iso(0.32, shelfY1, z), iso(0, shelfY1, z)];
  const planks = shelfZ.map(plank);
  const brackets: Array<{ a: Pt; b: Pt }> = [];
  for (const z of shelfZ) {
    for (const y of [shelfY0 + 0.08, shelfY1 - 0.08]) brackets.push({ a: iso(0.3, y, z), b: iso(0, y, z - 7) });
  }
  const spoolAnchors: Pt[] = [];
  const span = shelfY1 - shelfY0;
  const slots = Math.max(1, Math.floor(span / 0.42));
  for (let i = 0; i < slots; i++) spoolAnchors.push(iso(0.16, shelfY0 + 0.24 + i * (span / slots), shelfZ[0]));

  // Work table against the right wall, in the back-right corner tile, with a
  // toolbox on it — the corner reads as a workbench, not a stray block.
  const tx0 = Math.max(0.5, width - 1.0);
  const tx1 = width - 0.1;
  const ty0 = 0.1;
  const ty1 = 0.62;
  const th = 24;
  const table = box(tx0, tx1, ty0, ty1, 0, th);
  const toolbox = box(tx1 - 0.42, tx1 - 0.12, ty0 + 0.12, ty0 + 0.36, th, th + 8);

  const all: Pt[] = [...wallLeft, ...wallRight, iso(width, depth), iso(0, depth), iso(width, 0)];
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const padX = 18;
  const padTop = 14;
  const padBottom = 30; // room for the two-line label under the front row
  const minX = Math.min(...xs) - padX;
  const maxX = Math.max(...xs) + padX;
  const minY = Math.min(...ys) - padTop;
  const maxY = Math.max(...ys) + padBottom;

  return {
    cols,
    rows,
    viewBox: { minX, minY, w: maxX - minX, h: maxY - minY },
    tiles,
    wallLeft,
    wallRight,
    skirting,
    shelf: { planks, brackets, spoolAnchors },
    table,
    toolbox,
  };
}

/** Percent position of a viewBox point inside the rendered SVG box, for HTML overlays. */
export function at(vb: ViewBox, p: Pt): { left: string; top: string } {
  return {
    left: `${(((p.x - vb.minX) / vb.w) * 100).toFixed(2)}%`,
    top: `${(((p.y - vb.minY) / vb.h) * 100).toFixed(2)}%`,
  };
}
