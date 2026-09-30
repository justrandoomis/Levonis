/**
 * SMART FIT — a long name resizes and reflows by itself; nobody drags a scale
 * control (docs/LEVO_PROJECT_PROGRAMME.md §A C1.8; survey §5.3 «Smart Fit»).
 *
 * One pure loop over ONE committed table (./cairoAdvances.ts, measured once in
 * Chromium by scripts/cairo-advances.mjs from the very Cairo faces the studio
 * draws with — the three subsets and the Kurdish patch). The Worker has no
 * shaper, so the Arabic shaping that decides a letter's width lives here: the
 * joining classes (dual, right, non-joining, join-causing, transparent), the
 * positional form each letter takes, the lam-alef ligatures and the pairs the
 * faces space wider. The browser and the Worker run this same function on
 * this same table, so they decide alike; the table is never below what the
 * browser draws (the script checks every pair and a corpus of names), so the
 * Worker never promises a fit the browser cannot draw.
 *
 * The order (§5.3): the typed lines at the largest cap height the box holds
 * (TEXT_OK; TEXT_FITTED when that is below FITTED_BELOW of what the height
 * alone allows — the name was made noticeably smaller) → a balanced wrap up to
 * the area's lines (when the typed lines fall below the minimum, or wrapping
 * makes the text WRAP_GAIN larger) → a bolder style when strokes would print
 * thinner than MIN_STROKE_MM → a priced suggestion to size up (the smallest
 * larger size that fits) → blocked (TEXT_TOO_LONG).
 *
 * Millimetres: the area frame × the size value's scale (a photo-only area: its
 * quad over the face the size's two largest dimensions span). Cap height ↔
 * font size through Cairo's cap ratio. No DOM, no canvas, no clock.
 */
import type { Area, PublicBlueprint, PublicVariant, StyleKey, TextSpec, Vec3 } from './types';
import { CAIRO } from './cairoAdvances';
import { STYLE_PRESETS, styleBox, stylesFor } from './styles';

export type FitCode = 'TEXT_OK' | 'TEXT_FITTED' | 'TEXT_TWO_LINES' | 'TEXT_STYLE_BOLDER' | 'SIZE_UP_FOR_TEXT' | 'TEXT_TOO_LONG';
/**
 * `lines` and `cap_mm` are what to draw at the CURRENT size (a text that does
 * not fit: its largest layout); `style` the style they use — a bolder one
 * after TEXT_STYLE_BOLDER; `size_value` the size SIZE_UP_FOR_TEXT moves to.
 */
export interface FitResult { lines: string[]; cap_mm: number; fits: boolean; code: FitCode; style: StyleKey; size_value?: string }
/** A size the text may move up to; `dims_mm` sizes a photo-only area, `variant` names the product variant. */
export interface FitSize { value: string; scale: number; iqd_delta?: number; dims_mm?: Vec3; variant?: string }
export interface FitOptions { style: StyleKey; scale: number; sizes?: ReadonlyArray<FitSize>; dims_mm?: Vec3 }

/** The thinnest stroke that prints: one 0.4 mm line. */
export const MIN_STROKE_MM = 0.4;
/** A text that fits as typed is wrapped only when wrapping makes it this much larger. */
export const WRAP_GAIN = 1.25;
/** Drawn below this share of the height its area allows, a text reads as made smaller (TEXT_FITTED), not as it is (TEXT_OK). */
export const FITTED_BELOW = 0.8;

// ------------------------------------------------------------------ joining

/** U non-joining · R right-joining · D dual-joining · C join-causing (tatweel, ZWJ) · T transparent (marks). */
export type Joining = 'U' | 'R' | 'D' | 'C' | 'T';
const RIGHT = 'آأؤإاةدذرزوړڕژۆە';
/** پ چ ڤ ک گ ڵ ھ ی ێ — the Persian-block letters Sorani writes that join both ways. */
const DUAL = 'پچڤکگڵھیێ';
const ALEFS = 'آأإا';

export function joiningClass(cp: number): Joining {
  const ch = String.fromCodePoint(cp);
  return cp === 0x640 || cp === 0x200d ? 'C'
    : (cp > 0x64a && cp < 0x660) || cp === 0x670 ? 'T'
    : RIGHT.includes(ch) ? 'R'
    : (cp > 0x625 && cp < 0x64b) || DUAL.includes(ch) ? 'D' : 'U';
}

/** Entries a code point holds in the table: isolated, initial, medial, final / isolated, final / one. */
export const formCount = (cp: number): number => ({ D: 4, R: 2 })[joiningClass(cp) as 'D'] ?? 1;

const hasArabic = (s: string): boolean => /[\u0600-\u06ff]/.test(s);

// -------------------------------------------------------------------- table

let index: Map<number, number[][]> | undefined;

/** key → its forms' values at the table's weights (data units); decoded on first use. Ligature keys: lam × 0x10000 + alef. */
function table(): Map<number, number[][]> {
  if (index) return index;
  const keys: number[] = [];
  for (const part of CAIRO.cps.split(',')) {
    const [a, b = a] = part.split('-').map((h) => parseInt(h, 16));
    for (let cp = a; cp <= b; cp++) keys.push(cp);
  }
  for (const lam of CAIRO.lig) for (const alef of ALEFS) keys.push(lam.charCodeAt(0) * 0x10000 + alef.charCodeAt(0));
  const n = CAIRO.w.length + 1;
  let e = 0;
  const entry = (): number[] => {
    const c = (i: number): number => CAIRO.data.charCodeAt(e * n + i) - 48;
    const v = [c(0) * 64 + c(1)];
    for (let k = 2; k < n; k++) v.push(v[k - 2] + 3 * (c(k) - 16));
    e++;
    return v;
  };
  return (index = new Map(keys.map((k) => [k, Array.from({ length: k > 0xffff ? 2 : formCount(k) }, entry)])));
}

/** Values at the table's weights read at `weight`, in em: a lighter weight reads the first, between two a straight line. */
function at(v: readonly number[], weight: number): number {
  const w = CAIRO.w;
  let k = 0;
  while (k < w.length - 2 && weight > w[k + 1]) k++;
  const t = Math.min(1, Math.max(0, (weight - w[k]) / (w[k + 1] - w[k])));
  return (v[k] + (v[k + 1] - v[k]) * t) / CAIRO.u;
}

/** A Latin letter without its own entry reads its NFD base (é → e) — the script checks the base is never narrower. */
const fold = (cp: number): number => (cp < 0xc0 || cp > 0x24f || table().has(cp) ? cp : String.fromCodePoint(cp).normalize('NFD').codePointAt(0)!);

/** Does the table measure this code point (itself, folded, or as a zero-width joiner)? */
export const inTable = (cp: number): boolean => cp === 0x200c || cp === 0x200d || table().has(fold(cp));

/** A key's advance in em in its form (0 isolated, 1 initial, 2 medial, 3 final); 1.5 em for anything unknown. */
function advance(key: number, form: number, weight: number): number {
  const forms = table().get(key > 0xffff ? key : fold(key));
  return forms ? at(forms[forms.length === 4 ? form : forms.length === 2 && form === 3 ? 1 : 0], weight) : 1.5;
}

/** A glyph: [key, form]. */
export type Glyph = [key: number, form: number];

/**
 * The glyphs a line shapes into, in logical order: each Arabic letter in the
 * positional form its neighbours give it (ZWNJ breaks a join, ZWJ and tatweel
 * cause one, marks are transparent), lam + alef (ZWJ between or not) as their
 * ligature. ZWNJ, ZWJ and marks take no advance and are left out.
 */
export function glyphRun(text: string): Glyph[] {
  const cps = Array.from(text, (c) => c.codePointAt(0)!).filter((c) => joiningClass(c) !== 'T');
  const j = cps.map(joiningClass);
  const out: Glyph[] = [];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === 0x200c || c === 0x200d) continue;
    const prev = j[i] !== 'U' && /[DC]/.test(j[i - 1] ?? 'U');
    const next = /[DC]/.test(j[i]) && /[RDC]/.test(j[i + 1] ?? 'U');
    const a = cps[i + 1] === 0x200d ? i + 2 : i + 1;
    if (CAIRO.lig.includes(String.fromCodePoint(c)) && ALEFS.includes(String.fromCodePoint(cps[a] ?? 32))) {
      out.push([c * 0x10000 + cps[a], prev ? 3 : 0]);
      i = a;
    } else out.push([c, j[i] === 'D' ? (prev ? (next ? 2 : 3) : next ? 1 : 0) : j[i] === 'R' && prev ? 3 : 0]);
  }
  return out;
}

/** A line's advance in em at a Cairo weight (300–900), without tracking. */
export function measureEm(text: string, weight: number): number {
  let em = 0;
  let prev = -1;
  for (const [key, form] of glyphRun(text)) {
    em += advance(key, form, weight);
    if (prev >= 0) {
      const l = String.fromCharCode(prev & 0xffff);
      const r = String.fromCharCode(key > 0xffff ? key >>> 16 : key);
      const rule = CAIRO.kern.find(([ls, rs]) => ls.includes(l) && rs.includes(r));
      if (rule) em += at(rule[2], weight);
    }
    prev = key;
  }
  return em;
}

// ------------------------------------------------------------------ metrics

/** Font size in mm for a cap height in mm (the studio draws at `fontMm(cap_mm)`). */
export const fontMm = (cap_mm: number): number => cap_mm / CAIRO.cap;

/** The thinnest stroke / em at a weight (a weight between two rows reads the lighter row). */
export const stemEm = (weight: number): number => CAIRO.stem[Math.min(6, Math.max(0, Math.floor(weight / 100 - 3 + 1e-9)))];

/** How the studio stacks `lines`, in em: ascent above the first baseline, descent below the last, the gap between line boxes. */
export function lineMetrics(lines: readonly string[]): { asc: number; desc: number; gap: number } {
  const c = lines.some(hasArabic) ? 1 : 0;
  return { asc: Math.max(CAIRO.asc[0], CAIRO.asc[c]), desc: Math.max(CAIRO.desc[0], CAIRO.desc[c]), gap: CAIRO.gap };
}

/** Letter spacing in em the studio gives a line in a style — none on a line with Arabic letters. */
export const lineTracking = (line: string, style: StyleKey): number => (hasArabic(line) ? 0 : STYLE_PRESETS[style].tracking);

/** The smallest cap height (mm) a style prints at: the area's minimum, or where its strokes reach MIN_STROKE_MM. */
export const minCapFor = (style: StyleKey, text: Pick<TextSpec, 'min_cap_mm'>): number =>
  Math.max(text.min_cap_mm, Math.ceil(((MIN_STROKE_MM * CAIRO.cap) / stemEm(STYLE_PRESETS[style].weight)) * 100) / 100);

// ------------------------------------------------------------------ fitting

type Box = [w: number, h: number];
/** [lines, cap mm, the cap the height alone allows, the typed arrangement's line count] */
type Laid = [string[], number, number, number];

function boxOf(area: Area, scale: number, dims?: Vec3): Box | null {
  const f = area.frame;
  if (f) return [f.w * scale, f.h * scale];
  const q = area.photo_frame?.quad;
  if (!q || !dims) return null;
  const [a, b] = [...dims].sort((x, y) => y - x);
  const span = (i: number): number => Math.max(...q.map((p) => p[i])) - Math.min(...q.map((p) => p[i]));
  return [span(0) * a, span(1) * b];
}

/**
 * Every arrangement of the entries within `text.lines`, the typed one first:
 * names (count > 1) whole, grouped onto lines and joined by « و » (Arabic
 * script) or « & »; lines (count 1) as typed, each free to break at a space.
 */
function arrangements(value: readonly string[], text: TextSpec): string[][] {
  const names = text.count > 1;
  const joiner = !names ? ' ' : value.some(hasArabic) ? ' و ' : ' & ';
  const units = names ? value.map((v): [string, boolean] => [v, false]) : value.flatMap((v) => v.split(' ').map((w, i): [string, boolean] => [w, i < 1]));
  const out: string[][] = [];
  const rec = (i: number, lines: string[]): void => {
    if (lines.length > text.lines) return;
    if (i === units.length) return void out.push(lines);
    const [u, forced] = units[i];
    if (i && !forced) rec(i + 1, [...lines.slice(0, -1), lines[lines.length - 1] + joiner + u]);
    if (!i || forced || lines.length < text.lines) rec(i + 1, [...lines, u]);
  };
  rec(0, []);
  return out;
}

/** The largest cap height (mm) an arrangement reaches in a style and box, and the one its height alone allows. */
function capOf(lines: string[], style: StyleKey, box: Box, memo: Map<string, number>): [number, number] {
  const p = STYLE_PRESETS[style];
  const m = lineMetrics(lines);
  const x = styleBox(style, m.asc + m.desc);
  let w = 0;
  for (const l of lines) {
    const k = p.weight + l;
    const a = memo.get(k) ?? measureEm(l, p.weight);
    memo.set(k, a);
    const ar = hasArabic(l);
    w = Math.max(w, a + (ar ? 0 : p.tracking * [...l].length) + 2 * CAIRO.over[ar ? 1 : 0] + x.x);
  }
  const fw = box[0] / w;
  const fh = box[1] / (lines.length * (m.asc + m.desc + m.gap) - m.gap + x.y);
  const mm = (f: number): number => Math.floor(f * CAIRO.cap * 100) / 100;
  return [mm(Math.min(fw, fh)), mm(fh)];
}

/** The typed arrangement, unless it falls below `min` or another is WRAP_GAIN larger (then the largest, fewest lines on a tie). */
function pick(arrs: string[][], style: StyleKey, box: Box, min: number, memo: Map<string, number>): Laid {
  let typed: Laid | undefined;
  let best: Laid | undefined;
  for (const a of arrs) {
    const [cap, high] = capOf(a, style, box, memo);
    const l: Laid = [a, cap, high, arrs[0].length];
    typed ??= l;
    if (!best || cap > best[1] || (cap === best[1] && a.length < best[0].length)) best = l;
  }
  return typed![1] >= min && best![1] < typed![1] * WRAP_GAIN ? typed! : best!;
}

/**
 * Fit a text area's entries (`value`, canonical: trimmed, no empty entry) in
 * the area at `opts.scale`, in `opts.style` or a bolder allowed style, or name
 * the smallest larger size in `opts.sizes` that fits. An area without a
 * millimetre box (a photo-only area given no `dims_mm`) is not measured.
 */
export function fitText(value: readonly string[], area: Area, opts: FitOptions): FitResult {
  const text = area.text;
  const style = opts.style;
  const entries = value.filter(Boolean);
  const box = boxOf(area, opts.scale, opts.dims_mm);
  const out = (lines: string[], cap_mm: number, fits: boolean, code: FitCode, s = style, size_value?: string): FitResult =>
    ({ lines, cap_mm, fits, code, style: s, ...(size_value && { size_value }) });
  if (!text || !box || !entries.length) return out(entries, 0, true, 'TEXT_OK');
  const arrs = arrangements(entries, text);
  const memo = new Map<string, number>();
  const w0 = STYLE_PRESETS[style].weight;
  const ladder = [style, ...stylesFor(area).filter((s) => STYLE_PRESETS[s].weight > w0)];
  const tryAt = (b: Box, s: StyleKey): Laid | null => {
    const min = minCapFor(s, text);
    const l = arrs.length ? pick(arrs, s, b, min, memo) : null;
    return l && l[1] >= min ? l : null;
  };
  for (const s of ladder) {
    const l = tryAt(box, s);
    if (l) return out(l[0], l[1], true, s !== style ? 'TEXT_STYLE_BOLDER' : l[0].length > l[3] ? 'TEXT_TWO_LINES' : l[1] < FITTED_BELOW * l[2] ? 'TEXT_FITTED' : 'TEXT_OK', s);
  }
  const now = arrs.length ? pick(arrs, style, box, Infinity, memo) : ([entries, 0] as const);
  const next = [...(opts.sizes ?? [])]
    .filter((z) => z.scale > opts.scale)
    .sort((a, b) => a.scale - b.scale || (a.iqd_delta ?? 0) - (b.iqd_delta ?? 0))
    .find((z) => {
      const b = boxOf(area, z.scale, z.dims_mm);
      return b && ladder.some((s) => tryAt(b, s));
    });
  return out(now[0], now[1], false, next ? 'SIZE_UP_FOR_TEXT' : 'TEXT_TOO_LONG', style, next?.value);
}

/**
 * The sizes a configuration may move to (fitText's `sizes`): every in-stock
 * variant that differs from the chosen one by its size value only, with its
 * scale, dimensions, variant id and price difference; and the chosen size's
 * own scale and dimensions (1 and none without a size axis).
 */
export function sizeSteps(pub: Pick<PublicBlueprint, 'axes' | 'variants'>, variantId: string | null): { scale: number; dims_mm?: Vec3; sizes: FitSize[] } {
  const ax = pub.axes.size;
  const cur = pub.variants.find((v) => v.id === variantId);
  const val = (v: PublicVariant) => ax?.values[v.values[ax.group]];
  const sizes: FitSize[] = [];
  for (const v of cur ? pub.variants : []) {
    const z = val(v);
    if (z && v !== cur && v.in_stock && Object.keys(cur!.values).every((g) => g === ax!.group || cur!.values[g] === v.values[g])) {
      sizes.push({ value: v.values[ax!.group], scale: z.scale, dims_mm: z.dims_mm, iqd_delta: v.price_iqd - cur!.price_iqd, variant: v.id });
    }
  }
  const mine = cur && val(cur);
  return { scale: mine ? mine.scale : 1, dims_mm: mine ? mine.dims_mm : undefined, sizes };
}
