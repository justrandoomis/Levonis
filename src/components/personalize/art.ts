/**
 * AN AREA'S ARTWORK — what is printed in one content area, drawn once into a
 * canvas shaped like the area's frame, and used twice: the live model's decal
 * atlas (src/lib/viewer/decals.ts `drawImageArea`) and the look card's quad
 * (./lookcard.ts `warp`). One drawing, so the 3D and the 2D never disagree.
 *
 * TEXT IS DRAWN EXACTLY AS SMART FIT MEASURED IT (packages/catalog/src/
 * personalize/fit.ts, lane L3's contract): the fitted lines at the fitted cap
 * height — font size = fontMm(cap_mm), in the self-hosted Cairo after
 * `document.fonts.load`, the style's weight, its tracking on Latin lines only
 * (a joining script is never spaced), its lean, its bounce on Latin lines
 * only, its outline only where it would print (≥ MIN_STROKE_MM), stacked with
 * `lineMetrics` and centred in the frame. The outline is drawn in the text's
 * own colour (a printed rim, never a second colour the price did not count);
 * the soft shadow is a screen effect and is not drawn.
 *
 * Sizes: the mesh does not change with the size a customer picks, so the
 * text is drawn at cap_mm ÷ scale in the frame's millimetres.
 */
import type { DesignConfig, PaletteKey, PublicBlueprint, StyleKey } from '../../../packages/catalog/src/personalize/types';
import { MIN_STROKE_MM, fontMm, lineMetrics, lineTracking, sizeSteps, type FitResult } from '../../../packages/catalog/src/personalize/fit';
import { qrColours, qrPayload } from '../../../packages/catalog/src/personalize/check';
import { STYLE_PRESETS, styleBox } from '../../../packages/catalog/src/personalize/styles';

export type Rgb255 = readonly [number, number, number];

export type Art =
  | { kind: 'text'; lines: readonly string[]; cap_mm: number; style: StyleKey; colour: Rgb255; scale: number }
  | { kind: 'qr'; modules: readonly (readonly boolean[])[]; on: Rgb255 }
  | { kind: 'icon'; paths: readonly string[]; colour: Rgb255 }
  | { kind: 'image'; image: CanvasImageSource & { width: number; height: number }; crop: readonly [number, number, number, number]; fit: 'contain' | 'cover'; mono?: boolean };

const ARABIC = /[؀-ۿ]/;
const css = (c: Rgb255) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** The canvas for a frame of `w × h` mm: `px` on its longer side. */
export function artCanvas(w: number, h: number, px = 512): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const k = px / Math.max(w, h, 1e-6);
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  return c;
}

/** Draws `art` for a frame of `w × h` mm (fonts awaited first); resolves to the canvas. */
export async function drawArt(frame: { w: number; h: number }, art: Art, px = 512): Promise<HTMLCanvasElement> {
  const c = artCanvas(frame.w, frame.h, px);
  const ctx = c.getContext('2d', { willReadFrequently: art.kind === 'image' && !!art.mono });
  if (!ctx) return c;
  const W = c.width;
  const H = c.height;
  if (art.kind === 'text') {
    const p = STYLE_PRESETS[art.style];
    const F = (fontMm(art.cap_mm) / (art.scale || 1)) * (W / frame.w);
    const font = `${p.weight} ${F}px Cairo`;
    await document.fonts?.load(font, art.lines.join(' ')).catch(() => undefined);
    const m = lineMetrics(art.lines);
    const box = styleBox(art.style, m.asc + m.desc);
    const block = (art.lines.length * (m.asc + m.desc) + (art.lines.length - 1) * m.gap + box.y) * F;
    let base = (H - block) / 2 + (box.y / 2 + m.asc) * F;
    const outline = p.outline * fontMm(art.cap_mm) >= MIN_STROKE_MM ? p.outline * F * 2 : 0;
    ctx.font = font;
    ctx.fillStyle = ctx.strokeStyle = css(art.colour);
    ctx.lineJoin = 'round';
    ctx.lineWidth = outline;
    ctx.textBaseline = 'alphabetic';
    for (const line of art.lines) {
      const arabic = ARABIC.test(line);
      const track = lineTracking(line, art.style) * F;
      ctx.save();
      ctx.translate(W / 2, base);
      ctx.transform(1, 0, -p.skew, 1, 0, 0);
      ctx.direction = arabic ? 'rtl' : 'ltr';
      // A joining script (or a style that neither spaces nor bounces) is drawn
      // whole, kerned by the browser; a Latin line is spaced and bounced glyph by glyph.
      const whole = arabic || (!track && !p.jitter);
      const glyphs = whole ? [line] : [...line];
      const widths = glyphs.map((g) => ctx.measureText(g).width);
      const total = widths.reduce((a, b) => a + b, 0) + track * (glyphs.length - 1);
      let x = whole ? 0 : -total / 2;
      ctx.textAlign = whole ? 'center' : 'left';
      glyphs.forEach((g, i) => {
        const y = whole || !p.jitter ? 0 : (i % 2 ? -1 : 1) * p.jitter * F * 0.5;
        if (outline) ctx.strokeText(g, x, y);
        ctx.fillText(g, x, y);
        x += widths[i] + track;
      });
      ctx.restore();
      base += (m.asc + m.desc + m.gap) * F;
    }
  } else if (art.kind === 'qr') {
    const n = art.modules.length;
    const mod = Math.max(1, Math.floor(Math.min(W, H) / (n + 4)));
    const x0 = Math.floor((W - mod * (n + 4)) / 2) + 2 * mod;
    const y0 = Math.floor((H - mod * (n + 4)) / 2) + 2 * mod;
    ctx.fillStyle = css(art.on);
    art.modules.forEach((row, y) => row.forEach((on, x) => on && ctx.fillRect(x0 + x * mod, y0 + y * mod, mod, mod)));
  } else if (art.kind === 'icon') {
    const s = (Math.min(W, H) / 24) * 0.9;
    ctx.translate((W - 24 * s) / 2, (H - 24 * s) / 2);
    ctx.scale(s, s);
    ctx.strokeStyle = css(art.colour);
    ctx.lineWidth = 2;
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const d of art.paths) ctx.stroke(new Path2D(d));
  } else {
    const { image: img, crop } = art;
    const sw = img.width * crop[2];
    const sh = img.height * crop[3];
    const k = (art.fit === 'cover' ? Math.max : Math.min)(W / Math.max(sw, 1e-6), H / Math.max(sh, 1e-6));
    ctx.drawImage(img, img.width * crop[0], img.height * crop[1], sw, sh, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
    if (art.mono) {
      const d = ctx.getImageData(0, 0, W, H);
      for (let i = 0; i < d.data.length; i += 4) d.data[i] = d.data[i + 1] = d.data[i + 2] = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
      ctx.putImageData(d, 0, 0);
    }
  }
  return c;
}

const images = new Map<string, Promise<HTMLImageElement>>();

/** An image, loaded once per page (same-origin, so the look card can read its pixels). */
export function loadImage(url: string): Promise<HTMLImageElement> {
  let p = images.get(url);
  if (!p) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    p = img.decode().then(() => img);
    p.catch(() => images.delete(url));
    images.set(url, p);
  }
  return p;
}

/** What one area prints now, ready to draw: its box, a signature (same = unchanged), and the drawing's inputs. */
export interface AreaArt {
  id: string;
  /** The artwork's box in mm. */
  frame: { w: number; h: number };
  sig: string;
  make: () => Promise<Art>;
}

/**
 * Every filled area's artwork for what will be made: the fitted text (Smart
 * Fit's lines, cap and style, the text's own colour), the QR code of its
 * target (the app's own encoder, loaded when a code is set) in the colour
 * `qrColours` checked, the icon (the closed set, loaded when one is chosen),
 * the owner's picture (its crop; a lithophane in grey). A frame is drawn at
 * cap ÷ the size's scale; a photo-only area's box is its quad over the size's
 * two largest sides (fit.ts's rule).
 */
export function areaArts(
  pub: PublicBlueprint,
  made: DesignConfig,
  fits: Readonly<Record<string, FitResult>>,
  pictures: Readonly<Record<string, { url: string }>>,
  rgb: (key: PaletteKey) => Rgb255
): AreaArt[] {
  const z = sizeSteps(pub, made.variant);
  const dims = [...(z.dims_mm ?? [100, 100, 100])].sort((x, y) => y - x);
  const out: AreaArt[] = [];
  for (const a of pub.areas) {
    const q = a.photo_frame?.quad;
    const span = (i: 0 | 1) => (q ? Math.max(...q.map((p) => p[i])) - Math.min(...q.map((p) => p[i])) : 1);
    const frame = a.frame ? { w: a.frame.w, h: a.frame.h } : { w: span(0) * dims[0], h: span(1) * dims[1] };
    const scale = a.frame ? z.scale : 1;
    const ink = () => rgb(qrColours(pub, made, a.id, rgb)?.on ?? 'black');
    const fit = fits[a.id];
    if (a.text && fit) {
      const art: Art = { kind: 'text', lines: fit.lines, cap_mm: fit.cap_mm || Math.min(frame.h * scale * 0.5, 20), style: fit.style, colour: rgb(made.colors[a.id] ?? a.text.paint.default), scale };
      out.push({ id: a.id, frame, sig: JSON.stringify(art), make: async () => art });
    } else if (a.qr && made.qr[a.id] && made.qr[a.id].kind !== 'reorder') {
      const { kind, value } = made.qr[a.id];
      const on = ink();
      out.push({ id: a.id, frame, sig: `qr|${kind}|${value}|${on}`, make: async () => ({ kind: 'qr', modules: (await import('../profile/qr')).qrEncode(qrPayload(kind, value)).modules, on }) });
    } else if (a.icon && made.icon[a.id]) {
      const key = made.icon[a.id];
      const colour = ink();
      out.push({ id: a.id, frame, sig: `icon|${key}|${colour}`, make: async () => ({ kind: 'icon', paths: (await import('./iconPaths')).ICON_PATHS[key], colour }) });
    } else if ((a.logo || a.photo) && pictures[a.id]) {
      const url = pictures[a.id].url;
      const pick = (a.logo ? made.logo : made.photo)[a.id];
      const crop = pick?.crop ?? [0, 0, 1, 1];
      out.push({
        id: a.id,
        frame,
        sig: `img|${url}|${crop}|${pick?.mode}`,
        make: async () => ({ kind: 'image', image: await loadImage(url), crop, fit: a.logo ? 'contain' : 'cover', mono: pick?.mode === 'lithophane' }),
      });
    }
  }
  return out;
}
