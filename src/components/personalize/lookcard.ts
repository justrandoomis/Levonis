/**
 * THE LOOK CARD — the 2D picture of a configuration, no WebGL (docs/
 * LEVO_PROJECT_PROGRAMME.md §B.2 «Fallback — the look card»; survey (C)).
 *
 * The builder captures, once per publish: a neutral grey POSTER of the model
 * (src/lib/viewer/studio.ts `capture({mode: 'neutral'})`, the model's albedo
 * is NEUTRAL = 0.72 grey), a flat REGION-ID MAP (`capture({mode: 'ids'})`:
 * red = region index + 1, 0 = nothing) and each area's QUAD (its frame's four
 * corners through `lookMatrix()` — `frameQuad` below). Any configuration then
 * paints in 2D:
 *
 *   pixel = poster luminance ÷ NEUTRAL × the pixel's region colour
 *
 * and each area's artwork (the name, the code, the icon, the picture — ./art)
 * is warped into its quad. A photo-only blueprint paints the merchant's own
 * photo for the chosen value instead (no id map; its colours ARE the photos).
 *
 * It serves no WebGL, a lost context, no DecompressionStream (iOS < 16.4),
 * Save-Data, and later cart lines, cards and My Designs rows (C3) — no WebGL
 * context per card. Deterministic: the same inputs draw the same pixels.
 *
 * THE ID-MAP FORMAT (the builder writes it with `encodeIdMap`, L5 stores it
 * as base64 ≤ 8 KB decoded, the studio reads it with `decodeIdMap`):
 *   'L' 'I' '1' | u16 w | u16 h (little-endian) | runs of (u8 id, LEB128 count)
 * row-major from the top-left, ids 0–16 (region index + 1). Region k is the
 * k-th entry of the blueprint's `regions` (the order the builder maps parts
 * to regions in).
 *
 * THE QUAD ORDER: top-left, top-right, bottom-right, bottom-left of the
 * artwork as seen, each [x, y] in 0..1 of the poster. A frame's «up» is its
 * `u` (BlueprintSpec v1), its width axis up × n.
 */

export type Rgb255 = readonly [number, number, number];
export type Pt = readonly [number, number];
export type QuadPts = readonly [Pt, Pt, Pt, Pt];
export interface IdMap { w: number; h: number; ids: Uint8Array }
export interface CardSource { image: CanvasImageSource; w: number; h: number }
export interface CardLayer { quad: QuadPts; art: HTMLCanvasElement }

/** The neutral render's grey (studioShaders.ts `vec4(0.72, 0.72, 0.72, …)`). */
export const NEUTRAL = 0.72;
const MAGIC = [0x4c, 0x49, 0x31];

/** Region ids (0 = nothing, k + 1 = region k), row-major → the stored base64. */
export function encodeIdMap(ids: ArrayLike<number>, w: number, h: number): string {
  const out = [...MAGIC, w & 255, w >> 8, h & 255, h >> 8];
  for (let i = 0; i < w * h; ) {
    const v = ids[i];
    let n = 0;
    while (i < w * h && ids[i] === v) {
      i++;
      n++;
    }
    out.push(v);
    for (; n > 127; n >>>= 7) out.push((n & 127) | 128);
    out.push(n);
  }
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The stored base64 → the map; null when it is not one (never reads past its own size). */
export function decodeIdMap(b64: string): IdMap | null {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const at = (i: number) => bin.charCodeAt(i);
  if (bin.length < 7 || at(0) !== MAGIC[0] || at(1) !== MAGIC[1] || at(2) !== MAGIC[2]) return null;
  const w = at(3) | (at(4) << 8);
  const h = at(5) | (at(6) << 8);
  if (!w || !h || w > 1024 || h > 1024) return null;
  const ids = new Uint8Array(w * h);
  let o = 0;
  for (let i = 7; i < bin.length && o < ids.length; ) {
    const v = at(i++);
    let n = 0;
    for (let s = 0; i < bin.length; s += 7) {
      const b = at(i++);
      n |= (b & 127) << s;
      if (b < 128) break;
    }
    ids.fill(v, o, Math.min(ids.length, o + n));
    o += n;
  }
  return { w, h, ids };
}

type V3 = readonly number[];
const cross = (a: V3, b: V3) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A frame's width axis: up × n (so that n × width = up, as the studio's decals read it). */
export const frameWidthAxis = (f: { n: V3; u: V3 }): number[] => norm(cross(f.u, f.n));

/** A frame's corners through the look card's camera (`lookMatrix()`, column-major clip-from-mm) → the quad, 0..1. */
export function frameQuad(f: { o: V3; n: V3; u: V3; w: number; h: number }, m: readonly number[]): QuadPts {
  const x = frameWidthAxis(f);
  const up = norm(f.u);
  const at = (sx: number, sy: number): Pt => {
    const p = [0, 1, 2].map((i) => f.o[i] + (x[i] * sx * f.w + up[i] * sy * f.h) / 2);
    const c = [0, 1, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    return [(c[0] / c[2] + 1) / 2, (1 - c[1] / c[2]) / 2];
  };
  return [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
}

/** One triangle of `art` (source points s) onto the context (destination points d), by an affine map. */
function tri(ctx: CanvasRenderingContext2D, art: HTMLCanvasElement, s: Pt[], d: Pt[]) {
  const [[a0, b0], [a1, b1], [a2, b2]] = s;
  const [[x0, y0], [x1, y1], [x2, y2]] = d;
  const den = (a1 - a0) * (b2 - b0) - (a2 - a0) * (b1 - b0);
  if (!den) return;
  const a = ((x1 - x0) * (b2 - b0) - (x2 - x0) * (b1 - b0)) / den;
  const b = ((x2 - x0) * (a1 - a0) - (x1 - x0) * (a2 - a0)) / den;
  const c = ((y1 - y0) * (b2 - b0) - (y2 - y0) * (b1 - b0)) / den;
  const e = ((y2 - y0) * (a1 - a0) - (y1 - y0) * (a2 - a0)) / den;
  // The clip grows half a pixel out of its centre, so neighbouring triangles leave no seam.
  const cx = (x0 + x1 + x2) / 3;
  const cy = (y0 + y1 + y2) / 3;
  ctx.save();
  ctx.beginPath();
  for (const [x, y] of d) {
    const l = Math.hypot(x - cx, y - cy) || 1;
    ctx.lineTo(x + ((x - cx) / l) * 0.6, y + ((y - cy) / l) * 0.6);
  }
  ctx.clip();
  ctx.setTransform(a, c, b, e, x0 - a * a0 - b * b0, y0 - c * a0 - e * b0);
  ctx.drawImage(art, 0, 0);
  ctx.restore();
}

/** `art` warped into `quad` (pixels of the context), as a 6 × 6 grid of affine pieces. */
export function warp(ctx: CanvasRenderingContext2D, art: HTMLCanvasElement, quad: readonly Pt[]) {
  const N = 6;
  const [p0, p1, p2, p3] = quad;
  const at = (u: number, v: number): Pt => {
    const top = [p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u];
    const bot = [p3[0] + (p2[0] - p3[0]) * u, p3[1] + (p2[1] - p3[1]) * u];
    return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
  };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const [u0, u1, v0, v1] = [i / N, (i + 1) / N, j / N, (j + 1) / N];
      const s: Pt[] = [[u0 * art.width, v0 * art.height], [u1 * art.width, v0 * art.height], [u1 * art.width, v1 * art.height], [u0 * art.width, v1 * art.height]];
      const d = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
      tri(ctx, art, [s[0], s[1], s[2]], [d[0], d[1], d[2]]);
      tri(ctx, art, [s[0], s[2], s[3]], [d[0], d[2], d[3]]);
    }
  }
}

/**
 * Paints the card into `out` at the source's own size (CSS scales it). With
 * `ids`, every pixel of region k takes `colours[k]` (0–255) shaded by the
 * poster; without, the source is drawn as it is (a photo-only product's photo).
 */
export function paintCard(out: HTMLCanvasElement, src: CardSource, ids: IdMap | null, colours: readonly Rgb255[], layers: readonly CardLayer[]) {
  out.width = src.w;
  out.height = src.h;
  const ctx = out.getContext('2d', { willReadFrequently: !!ids });
  if (!ctx) return;
  ctx.clearRect(0, 0, src.w, src.h);
  ctx.drawImage(src.image, 0, 0, src.w, src.h);
  if (ids) {
    const img = ctx.getImageData(0, 0, src.w, src.h);
    const d = img.data;
    const idAt = (x: number, y: number) => ids.ids[Math.min(ids.h - 1, Math.max(0, y)) * ids.w + Math.min(ids.w - 1, Math.max(0, x))];
    const kx = ids.w / src.w;
    const ky = ids.h / src.h;
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const i = (y * src.w + x) * 4;
        if (!d[i + 3]) continue;
        // The coarser map is read bilinearly over its regions only: a pixel
        // between two regions blends their colours, never the grey of «nothing».
        const fx = (x + 0.5) * kx - 0.5;
        const fy = (y + 0.5) * ky - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        let r = 0;
        let g = 0;
        let b = 0;
        let w = 0;
        for (let k = 0; k < 4; k++) {
          const id = idAt(x0 + (k & 1), y0 + (k >> 1));
          const c = id ? colours[id - 1] : undefined;
          if (!c) continue;
          const wk = (k & 1 ? fx - x0 : 1 - fx + x0) * (k >> 1 ? fy - y0 : 1 - fy + y0) + 1e-6;
          r += c[0] * wk;
          g += c[1] * wk;
          b += c[2] * wk;
          w += wk;
        }
        // An edge pixel with no region round it takes the nearest one within two cells.
        for (let k = 0; !w && k < 16; k++) {
          const id = idAt(x0 + (k % 4) - 1, y0 + (k >> 2) - 1);
          const c = id ? colours[id - 1] : undefined;
          if (c) [r, g, b, w] = [c[0], c[1], c[2], 1];
        }
        if (!w) continue;
        const l = d[i] / 255 / NEUTRAL / w;
        d[i] = Math.min(255, r * l);
        d[i + 1] = Math.min(255, g * l);
        d[i + 2] = Math.min(255, b * l);
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  for (const layer of layers) warp(ctx, layer.art, layer.quad.map(([x, y]) => [x * src.w, y * src.h] as Pt));
}
