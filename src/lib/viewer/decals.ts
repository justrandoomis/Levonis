/**
 * DECALS — the studio's painted content (docs/LEVO_PROJECT_PROGRAMME.md §B.2
 * item 4): at most four areas share ONE 1024² canvas atlas, uploaded through an
 * ogl `Texture` — the one ogl import this programme adds, and this file is the
 * only one that makes it (tests/viewerCore.test.ts). The projection onto the
 * model (per-area projective coordinates, the region mask, the facing test)
 * happens in the studio's vertex shader (./studioShaders); `mountStudio`'s
 * `setDecals` wires an atlas to it and re-uploads after every draw here.
 *
 * Text is drawn with the browser's own `fillText` in the app's self-hosted Cairo
 * (the @font-face rules in index.html, /fonts/cairo/ plus the Kurdish patch in
 * src/index.css) after `document.fonts.load`, so shaping and bidi give real
 * Arabic and Sorani; the Worker has no shaper. Never a remote font.
 *
 * The 2D look-card renderer is not here (src/components/personalize owns it).
 */
import { Texture } from 'ogl';
import type { OGLRenderingContext } from 'ogl';

export const ATLAS_SIZE = 1024;
/** One atlas holds this many areas — the blueprint's own limit (BlueprintSpec v1). */
export const ATLAS_SLOTS = 4;
const QUAD = ATLAS_SIZE / 2;
/** Transparent pixels kept round each area, so filtering never reaches a neighbour. */
const GUTTER = 2;

/** 0–1 floats, the scene's colour unit. */
export type Rgb = readonly [number, number, number];

/** An area's place in the atlas, canvas pixels from the top-left. */
export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DecalAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Slot → its rectangle, shaped like the area's frame (w / h). */
  readonly rects: readonly AtlasRect[];
  /** Bumped by every draw. */
  version: number;
  /** Set by the scene (`setDecals`): after a draw, redraw. */
  onchange: (() => void) | null;
  /** The texture the last `bind` made; every draw marks it for re-upload. */
  texture: Texture | null;
  /** The ogl texture over the canvas for this context — made once per context. */
  bind(gl: OGLRenderingContext): Texture;
}

/**
 * Slot k owns the k-th 512² quadrant; inside it, a rectangle of the area's
 * aspect (frame w / h), as large as fits, centred. Pure — the tests call it.
 */
export function atlasRects(aspects: readonly number[] = []): AtlasRect[] {
  const room = QUAD - 2 * GUTTER;
  return Array.from({ length: ATLAS_SLOTS }, (_, k) => {
    const a = aspects[k] > 0 ? aspects[k] : 1;
    const w = Math.round(a >= 1 ? room : room * a);
    const h = Math.round(a >= 1 ? room / a : room);
    return {
      x: (k % 2) * QUAD + GUTTER + Math.floor((room - w) / 2),
      y: (k >> 1) * QUAD + GUTTER + Math.floor((room - h) / 2),
      w,
      h,
    };
  });
}

/** `aspects[k]` = area k's frame width / height, in millimetres. */
export function createAtlas(aspects: readonly number[] = []): DecalAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS_SIZE;
  return {
    canvas,
    ctx: canvas.getContext('2d') as CanvasRenderingContext2D,
    rects: atlasRects(aspects),
    version: 0,
    onchange: null,
    texture: null,
    bind(gl) {
      // Premultiplied, so filtering at a glyph's edge never darkens it.
      if (this.texture?.gl !== gl) this.texture = new Texture(gl, { image: canvas, premultiplyAlpha: true, minFilter: gl.LINEAR_MIPMAP_LINEAR });
      return this.texture;
    },
  };
}

const css = ([r, g, b]: Rgb, a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

/** After a draw: re-upload on the next frame, and ask for that frame. */
function touch(atlas: DecalAtlas) {
  atlas.version++;
  if (atlas.texture) atlas.texture.needsUpdate = true;
  atlas.onchange?.();
}

/** The slot's whole quadrant, gutter included. */
const wipe = ({ ctx }: DecalAtlas, slot: number) => ctx.clearRect((slot % 2) * QUAD, (slot >> 1) * QUAD, QUAD, QUAD);

/** Empties a slot. */
export function clearArea(atlas: DecalAtlas, slot: number): void {
  wipe(atlas, slot);
  touch(atlas);
}

/** Joining scripts (Arabic, Sorani) must never be letter-spaced or jittered. */
const JOINING = /[\u0600-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

export interface TextStyle {
  /** The lines as the engine's Smart Fit broke them (1–4). */
  lines: readonly string[];
  /** A family the document declares; the app's self-hosted Cairo by default. */
  font?: string;
  /** 300–900 (Cairo's variable range). */
  weight?: number;
  /** Letter spacing in em — Latin only: a joining script is never spaced. */
  tracking?: number;
  /** A stroke round the letters, its width in em. */
  outline?: { width: number; colour: Rgb } | null;
  /** A soft shadow, lengths in em. */
  shadow?: { blur: number; x?: number; y?: number; colour: Rgb } | null;
  /** Horizontal shear, tan of the slant (0.2 ≈ 11°). */
  skew?: number;
  colour: Rgb;
}

/**
 * Draws the lines into the slot, as large as the rectangle allows (the engine
 * already chose the breaks; this only scales). Waits for the font first —
 * measuring a fallback face would fit the wrong widths. Answers the font size
 * used, in atlas pixels.
 */
export async function drawTextArea(atlas: DecalAtlas, slot: number, style: TextStyle): Promise<number> {
  const { ctx } = atlas;
  const r = atlas.rects[slot];
  const lines = style.lines.length ? style.lines : [''];
  const family = `${style.weight ?? 700} 100px ${style.font ?? 'Cairo'}`;
  await document.fonts?.load(family, lines.join(' ')).catch(() => undefined);
  ctx.font = family;
  const pad = r.h * 0.06;
  let widest = 1;
  for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width * (1 + Math.abs(style.skew ?? 0) * 0.3));
  const px = Math.max(1, Math.min((r.h - 2 * pad) / (lines.length * 1.3), ((r.w - 2 * pad) / widest) * 100));
  wipe(atlas, slot);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.font = family.replace('100px', `${px}px`);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const cx = r.x + r.w / 2;
  const top = r.y + (r.h - lines.length * px * 1.3) / 2;
  lines.forEach((line, i) => {
    ctx.save();
    ctx.direction = RTL.test(line) ? 'rtl' : 'ltr';
    if ('letterSpacing' in ctx) ctx.letterSpacing = JOINING.test(line) ? '0px' : `${(style.tracking ?? 0) * px}px`;
    ctx.translate(cx, top + (i + 0.5) * px * 1.3);
    ctx.transform(1, 0, -(style.skew ?? 0), 1, 0, 0);
    const s = style.shadow;
    if (s) {
      ctx.shadowColor = css(s.colour, 0.6);
      ctx.shadowBlur = s.blur * px;
      ctx.shadowOffsetX = (s.x ?? 0) * px;
      ctx.shadowOffsetY = (s.y ?? 0.06) * px;
    }
    if (style.outline) {
      ctx.strokeStyle = css(style.outline.colour);
      ctx.lineWidth = style.outline.width * px * 2;
      ctx.strokeText(line, 0, 0);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = css(style.colour);
    ctx.fillText(line, 0, 0);
    ctx.restore();
  });
  ctx.restore();
  touch(atlas);
  return px;
}

/**
 * A logo or a photo into the slot. `crop` is [x0, y0, x1, y1] in 0–1 of the
 * source (the configuration's own crop); `posterize` n = n levels a channel
 * (a logo printed in few colours); `mono` = grey (the lithophane's back-lit
 * plate); `fit` contain (a logo, whole) or cover (a photo, filled).
 */
export function drawImageArea(
  atlas: DecalAtlas,
  slot: number,
  bitmap: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  { crop = [0, 0, 1, 1], posterize, mono, fit = 'contain' }: { crop?: readonly [number, number, number, number]; posterize?: number; mono?: boolean; fit?: 'contain' | 'cover' } = {}
): void {
  const r = atlas.rects[slot];
  const sw = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
  const sh = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
  const cw = Math.max(1e-6, (crop[2] - crop[0]) * sw);
  const ch = Math.max(1e-6, (crop[3] - crop[1]) * sh);
  const k = (fit === 'cover' ? Math.max : Math.min)(r.w / cw, r.h / ch);
  const steps = posterize && posterize >= 2 ? posterize - 1 : 0;
  // Posterized or grey: drawn on a canvas of its own and read back once there;
  // the atlas itself is never read back.
  const own = steps || mono ? document.createElement('canvas') : null;
  if (own) {
    own.width = r.w;
    own.height = r.h;
  }
  const ctx = own ? (own.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D) : atlas.ctx;
  const x = own ? 0 : r.x;
  const y = own ? 0 : r.y;
  wipe(atlas, slot);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, r.w, r.h);
  ctx.clip();
  ctx.drawImage(bitmap, crop[0] * sw, crop[1] * sh, cw, ch, x + (r.w - cw * k) / 2, y + (r.h - ch * k) / 2, cw * k, ch * k);
  ctx.restore();
  if (own) {
    const img = ctx.getImageData(0, 0, r.w, r.h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (mono) d[i] = d[i + 1] = d[i + 2] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (steps) for (let c = 0; c < 3; c++) d[i + c] = (Math.round((d[i + c] / 255) * steps) * 255) / steps;
    }
    atlas.ctx.putImageData(img, r.x, r.y);
  }
  touch(atlas);
}

/**
 * A QR code from its module matrix (the app's own encoder — the caller passes
 * `qrEncode`'s modules), whole modules of whole pixels so it scans, with a
 * two-module quiet zone. `off` null leaves the light modules transparent (the
 * surface shows through); give it a colour when the surface is dark.
 */
export function drawQrArea(
  atlas: DecalAtlas,
  slot: number,
  matrix: readonly (readonly boolean[])[],
  colours: { on: Rgb; off?: Rgb | null }
): void {
  const { ctx } = atlas;
  const r = atlas.rects[slot];
  const n = matrix.length;
  const m = Math.max(1, Math.floor(Math.min(r.w, r.h) / (n + 4)));
  const size = m * (n + 4);
  const x0 = r.x + Math.floor((r.w - size) / 2);
  const y0 = r.y + Math.floor((r.h - size) / 2);
  wipe(atlas, slot);
  if (colours.off) {
    ctx.fillStyle = css(colours.off);
    ctx.fillRect(x0, y0, size, size);
  }
  ctx.fillStyle = css(colours.on);
  matrix.forEach((row, y) => row.forEach((dark, x) => dark && ctx.fillRect(x0 + (x + 2) * m, y0 + (y + 2) * m, m, m)));
  touch(atlas);
}

/**
 * An icon of the closed set: SVG path data in a 24×24 box, stroked the way the
 * app's icons are (width 2, round caps and joins), centred and as large as fits.
 */
export function drawIconArea(atlas: DecalAtlas, slot: number, svgPathData: string | readonly string[], colour: Rgb): void {
  const { ctx } = atlas;
  const r = atlas.rects[slot];
  const s = (Math.min(r.w, r.h) / 24) * 0.9;
  wipe(atlas, slot);
  ctx.save();
  ctx.translate(r.x + (r.w - 24 * s) / 2, r.y + (r.h - 24 * s) / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = css(colour);
  ctx.lineWidth = 2;
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const d of typeof svgPathData === 'string' ? [svgPathData] : svgPathData) ctx.stroke(new Path2D(d));
  ctx.restore();
  touch(atlas);
}
