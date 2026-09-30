/**
 * COLOUR — the palette as numbers, CIEDE2000, WCAG contrast and the shop's
 * shelf (docs/LEVO_PROJECT_PROGRAMME.md §A C1.10–C1.13; survey §5.3 «Colour»).
 *
 * PALETTE_RGB is the swatch stylesheet (src/components/catalog/swatches.css)
 * as numbers: a solid rule is its colour; a gradient rule is the rounded mean
 * of its colour stops as written (repeats counted); an `rgb(… / a)` stop counts
 * its r g b. tests/personalizeThemes.test.ts parses the CSS and pins every key.
 *
 * THE SHELF (merchant_material_stock: material_id, color_hex, color_name,
 * grams). `stockFor` turns the rows of one look's material into the per-look
 * stock map the public blueprint carries: a palette key is `in` when a row is
 * that colour (its name says so — «Silk Gold», «ذهبي» — or, unnamed, its hex
 * is nearest that key); else `sub:<key>` when a stocked colour stands in for
 * it; else `out`. A SUBSTITUTE is the stocked colour nearest by CIEDE2000 when
 * within SUBSTITUTE_MAX_DE = 10 — a visible but same-family difference (navy
 * for a darker blue; never blue for teal, ΔE ≈ 19) — and never across a
 * FINISH: silver, gold, bronze, wood, marble, clear and glow are a material
 * effect, so each stands in only for itself and none for a plain colour.
 *
 * The studio reads the stock map the Worker computed (`lookStock`,
 * `stockKey`); «the nearest colour a part may wear» is CIEDE2000 over the
 * palette (rules.ts `nearestColour`); `nearestKey` is a cheaper weighted-RGB
 * ranking for callers that need no CIEDE2000.
 * Pure: no DOM, no clock, no randomness.
 */
import type { PaletteKey, PublicBlueprint, StockState } from './types';
import { PAINT_KEYS } from './vocab';
import { SWATCH_NAMES, SWATCH_NAMES_CKB } from '../palette';

export type RGB = readonly [number, number, number];
export type Lab = readonly [number, number, number];

/** The swatch stylesheet's colours (see the header for gradients). */
export const PALETTE_RGB: Readonly<Record<PaletteKey, RGB>> = {
  black: [22, 22, 26],
  white: [244, 244, 242],
  gray: [138, 141, 147],
  silver: [193, 196, 201],
  red: [215, 38, 61],
  orange: [242, 140, 40],
  yellow: [245, 209, 48],
  green: [47, 166, 90],
  teal: [26, 166, 160],
  blue: [47, 111, 222],
  navy: [31, 45, 92],
  purple: [125, 75, 209],
  pink: [236, 111, 169],
  brown: [122, 75, 42],
  beige: [220, 202, 167],
  gold: [214, 176, 83],
  bronze: [176, 122, 73],
  wood: [155, 103, 55],
  marble: [222, 223, 224],
  clear: [255, 255, 255],
  glow: [185, 243, 91],
};

/** CIEDE2000 above which a stocked colour is not offered as a substitute. */
export const SUBSTITUTE_MAX_DE = 10;

/** Keys that are a material effect: each substitutes only for itself. */
export const FINISH_KEYS: readonly PaletteKey[] = ['silver', 'gold', 'bronze', 'wood', 'marble', 'clear', 'glow'];

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** sRGB (0–255) → CIE L*a*b* under D65. */
export function rgbToLab(rgb: RGB): Lab {
  const [r, g, b] = rgb.map(lin);
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const RAD = Math.PI / 180;
const hue = (b: number, a: number): number => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / RAD + 360) % 360);

/** CIEDE2000 (Sharma, Wu and Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(a: Lab, b: Lab): number {
  const [L1, a1, b1] = a;
  const [L2, a2, b2] = b;
  const c7 = ((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2) ** 7;
  const g = 1.5 - 0.5 * Math.sqrt(c7 / (c7 + 25 ** 7));
  const c1 = Math.hypot(g * a1, b1);
  const c2 = Math.hypot(g * a2, b2);
  const h1 = hue(b1, g * a1);
  const h2 = hue(b2, g * a2);
  const prod = c1 * c2;
  let dh = prod === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(prod) * Math.sin((dh / 2) * RAD);
  const l50 = ((L1 + L2) / 2 - 50) ** 2;
  const cp = (c1 + c2) / 2;
  let hBar = h1 + h2;
  if (prod !== 0) hBar = Math.abs(h1 - h2) <= 180 ? hBar / 2 : hBar < 360 ? (hBar + 360) / 2 : (hBar - 360) / 2;
  const t = 1 - 0.17 * Math.cos((hBar - 30) * RAD) + 0.24 * Math.cos(2 * hBar * RAD) + 0.32 * Math.cos((3 * hBar + 6) * RAD) - 0.2 * Math.cos((4 * hBar - 63) * RAD);
  const cp7 = cp ** 7;
  const rt = -2 * Math.sqrt(cp7 / (cp7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hBar - 275) / 25) ** 2)) * RAD);
  const x = (L2 - L1) / (1 + (0.015 * l50) / Math.sqrt(20 + l50));
  const y = (c2 - c1) / (1 + 0.045 * cp);
  const z = dH / (1 + 0.015 * cp * t);
  return Math.sqrt(x * x + y * y + z * z + rt * y * z);
}

const lum = (c: RGB): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);

/** WCAG 2 contrast ratio, 1–21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Two palette keys' contrast (their swatch colours). */
export const keyContrast = (a: PaletteKey, b: PaletteKey): number => contrastRatio(PALETTE_RGB[a], PALETTE_RGB[b]);

/** The candidate nearest `key` by weighted RGB distance («redmean»; ties: list order); null for none. */
export function nearestKey(key: PaletteKey, candidates: readonly PaletteKey[]): PaletteKey | null {
  const [r, g, b] = PALETTE_RGB[key];
  let best: PaletteKey | null = null;
  let bd = Infinity;
  for (const k of candidates) {
    const [r2, g2, b2] = PALETTE_RGB[k];
    const m = (r + r2) / 512;
    const d = (2 + m) * (r - r2) ** 2 + 4 * (g - g2) ** 2 + (3 - m) * (b - b2) ** 2;
    if (d < bd) [best, bd] = [k, d];
  }
  return best;
}

const isFinish = (k: PaletteKey): boolean => FINISH_KEYS.includes(k);

/**
 * The stocked colour that stands in for `key`: the same key when stocked (the
 * nearest of them when several), else the nearest plain colour within
 * SUBSTITUTE_MAX_DE; a finish key only matches itself. `delta` = CIEDE2000
 * from the palette's `key`. Null when nothing qualifies.
 */
export function nearestStocked(
  key: PaletteKey,
  stocked: ReadonlyArray<{ key: PaletteKey; rgb: RGB; name?: string; material_id?: string }>,
): { key: PaletteKey; rgb: RGB; name?: string; material_id?: string; delta: number } | null {
  const want = rgbToLab(PALETTE_RGB[key]);
  let best: { key: PaletteKey; rgb: RGB; name?: string; material_id?: string; delta: number } | null = null;
  for (const s of stocked) {
    const same = s.key === key;
    if (!same && (isFinish(key) || isFinish(s.key))) continue;
    const delta = deltaE2000(want, rgbToLab(s.rgb));
    if (!same && delta > SUBSTITUTE_MAX_DE) continue;
    const bestSame = best?.key === key;
    if (!best || (same && !bestSame) || (same === bestSame && delta < best.delta)) best = { ...s, delta };
  }
  return best;
}

// -------------------------------------------------------------------- stock

/** A look's stock map: the look of the chosen variant, else `default`; null when the shop tracks nothing. */
export function lookStock(pub: Pick<PublicBlueprint, 'axes' | 'variants' | 'stock'>, variantId: string | null): Partial<Record<PaletteKey, StockState>> | null {
  const ax = pub.axes.look;
  const v = pub.variants.find((x) => x.id === variantId);
  const look = ax && v ? ax.values[v.values[ax.group]]?.look : undefined;
  return (look && pub.stock?.[look]) || pub.stock?.default || null;
}

/** What prints for `key` under a stock map: itself, its substitute, or null (out); no map = everything is in. */
export function stockKey(stock: Partial<Record<PaletteKey, StockState>> | null | undefined, key: PaletteKey): PaletteKey | null {
  const s = stock ? stock[key] ?? 'out' : 'in';
  return s === 'in' ? key : s.startsWith('sub:') ? (s.slice(4) as PaletteKey) : null;
}

/** One `merchant_material_stock` row. */
export interface ShelfRow { material_id: string; color_hex: string; color_name?: string; grams: number }

/** Words that name a key on a spool label, most specific first («Navy Blue» is navy). */
const NAMED: ReadonlyArray<[PaletteKey, string]> = [
  ['glow', 'glow|luminous|فسفوري'], ['clear', 'clear|transparent|translucent'], ['marble', 'marble'], ['wood', 'wood'],
  ['gold', 'gold'], ['silver', 'silver'], ['bronze', 'bronze|copper'], ['navy', 'navy'], ['teal', 'teal|turquoise|cyan|mint'],
  ['beige', 'beige|cream|ivory|sand|skin'], ['pink', 'pink|magenta|rose'], ['purple', 'purple|violet|lilac|lavender'], ['brown', 'brown|chocolate|coffee'],
  ['orange', 'orange'], ['yellow', 'yellow|lemon'], ['green', 'green|olive|lime'], ['blue', 'blue|sky'], ['red', 'red|maroon|burgundy'],
  ['gray', 'gray|grey'], ['black', 'black'], ['white', 'white'],
];

/** A spool's palette key: from its name (English, Arabic or Sorani), else its hex's nearest plain or metallic key; null for neither. */
export function shelfKey(row: Pick<ShelfRow, 'color_hex' | 'color_name'>): PaletteKey | null {
  const name = (row.color_name ?? '').toLowerCase();
  for (const [k, words] of NAMED) {
    if ([...words.split('|'), SWATCH_NAMES[k].ar, SWATCH_NAMES_CKB[k]].some((w) => name.includes(w))) return k;
  }
  const rgb = hexRgb(row.color_hex);
  if (!rgb) return null;
  const lab = rgbToLab(rgb);
  let best: PaletteKey | null = null;
  let bd = Infinity;
  for (const k of PAINT_KEYS) {
    if (k === 'wood' || k === 'marble' || k === 'clear' || k === 'glow') continue;
    const d = deltaE2000(lab, rgbToLab(PALETTE_RGB[k]));
    if (d < bd) [best, bd] = [k, d];
  }
  return best;
}

const hexRgb = (hex: string): RGB | null => (/^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as RGB : null);

/** The shelf's colours for one look's material (grams ≥ `minGrams`): key, the spool's own colour (else the swatch's), name. */
export function shelfColours(look: { material_id: string }, shelf: readonly ShelfRow[], minGrams = 1): Array<{ key: PaletteKey; rgb: RGB; name: string; material_id: string }> {
  const out: Array<{ key: PaletteKey; rgb: RGB; name: string; material_id: string }> = [];
  for (const row of shelf) {
    if (row.material_id !== look.material_id || row.grams < minGrams) continue;
    const key = shelfKey(row);
    if (key) out.push({ key, rgb: hexRgb(row.color_hex) ?? PALETTE_RGB[key], name: row.color_name ?? '', material_id: row.material_id });
  }
  return out;
}

/** The per-look stock map the public blueprint carries: every paintable key `in`, `sub:<key>` or `out`. */
export function stockFor(look: { material_id: string }, shelf: readonly ShelfRow[], minGrams = 1): Record<PaletteKey, StockState> {
  const have = shelfColours(look, shelf, minGrams);
  const map = {} as Record<PaletteKey, StockState>;
  for (const k of PAINT_KEYS) {
    const n = nearestStocked(k, have);
    map[k] = !n ? 'out' : n.key === k ? 'in' : `sub:${n.key}`;
  }
  return map;
}
