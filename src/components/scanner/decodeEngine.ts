/**
 * FRAMES IN, CODES OUT — the part of the scanner that does not draw.
 *
 * Two engines behind one call:
 *
 *  - NATIVE: `BarcodeDetector` (Chrome on Android, desktop Chrome/Edge on
 *    some platforms). It returns EVERY code in the frame at once, each with
 *    its box, which is exactly what a three-barcode box label needs.
 *  - LIBRARY: `@zxing/library`'s 1-D readers (./zxingReader.ts, a lazy chunk)
 *    plus jsQR for QR codes. It returns ONE code per call, so each tick reads
 *    one REGION of the guide frame in rotation — the whole frame, its top half
 *    (where the product SN barcode sits on the owner's label), and the two
 *    lower corners (box SN, EAN) — and `CodeWindow` gathers what the last
 *    second of ticks saw. Four ticks cover the label in about half a second.
 *
 * Only what lies inside the guide frame is read, so the label of the NEXT box
 * on the table cannot pair its EAN with this box's serial.
 */
import type { DecodedCode } from '../../../packages/catalog/src/deviceSerials';

interface DetectedBarcodeLike {
  rawValue: string;
  format?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}
interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcodeLike[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

const NATIVE_FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'code_39', 'qr_code', 'data_matrix'];

/** A region of the guide frame, as fractions of its width and height. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The library engine's rotation over the guide frame (see the header). */
export const LABEL_REGIONS: readonly Region[] = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0, y: 0, w: 1, h: 0.55 },
  { x: 0, y: 0.4, w: 0.62, h: 0.6 },
  { x: 0.38, y: 0.4, w: 0.62, h: 0.6 },
];

/** A rectangle of the video frame, in the video's own pixels. */
export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The part of a region of a grayscale image, copied out row by row — what
 * the library engine hands to the 1-D reader for one tick.
 */
export function cropLuminance(
  luma: Uint8ClampedArray,
  width: number,
  height: number,
  r: Region
): { data: Uint8ClampedArray; width: number; height: number; top: number } {
  const x0 = Math.max(0, Math.floor(r.x * width));
  const y0 = Math.max(0, Math.floor(r.y * height));
  const w = Math.max(1, Math.min(width - x0, Math.round(r.w * width)));
  const h = Math.max(1, Math.min(height - y0, Math.round(r.h * height)));
  const out = new Uint8ClampedArray(w * h);
  for (let row = 0; row < h; row++) out.set(luma.subarray((y0 + row) * width + x0, (y0 + row) * width + x0 + w), row * w);
  return { data: out, width: w, height: h, top: y0 };
}

/**
 * What the last moment of ticks saw. A code read at 0 ms and another at
 * 400 ms are the same label when the camera has not moved away; one read two
 * seconds ago is not.
 */
export class CodeWindow {
  private seen = new Map<string, { code: DecodedCode; at: number }>();
  constructor(private readonly spanMs = 1400) {}

  add(codes: readonly DecodedCode[], now: number): void {
    for (const code of codes) {
      const key = code.text.trim();
      if (key) this.seen.set(key, { code, at: now });
    }
  }

  recent(now: number): DecodedCode[] {
    const out: DecodedCode[] = [];
    for (const [key, v] of this.seen) {
      if (now - v.at > this.spanMs) this.seen.delete(key);
      else out.push(v.code);
    }
    return out;
  }

  clear(): void {
    this.seen.clear();
  }
}

type ZxingModule = typeof import('./zxingReader');
type JsQR = typeof import('jsqr').default;
let zxingPromise: Promise<ZxingModule> | null = null;
let jsqrPromise: Promise<JsQR> | null = null;
const loadZxing = () => (zxingPromise ??= import('./zxingReader'));
const loadJsQR = () => (jsqrPromise ??= import('jsqr').then((m) => m.default));

async function createNativeDetector(): Promise<BarcodeDetectorLike | null> {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
  try {
    // A detector that exists but cannot read Code 128 (some desktop builds
    // report only QR) is worse than the library: it would read nothing.
    const supported = (await Ctor.getSupportedFormats?.()) ?? NATIVE_FORMATS;
    if (!supported.includes('code_128')) return null;
    return new Ctor({ formats: NATIVE_FORMATS.filter((f) => supported.includes(f)) });
  } catch {
    return null;
  }
}

export type EngineKind = 'native' | 'library';

/** The longest side the library engine reads at — enough for ~4 px per bar module on a label-sized frame. */
const LIBRARY_MAX_WIDTH = 1280;

export class DecodeEngine {
  private native: BarcodeDetectorLike | null = null;
  private zxing: ZxingModule | null = null;
  private jsqr: JsQR | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private tick = 0;
  kind: EngineKind = 'library';

  constructor(private readonly opts: { qr: boolean }) {}

  async init(): Promise<EngineKind> {
    this.native = await createNativeDetector();
    if (this.native) {
      this.kind = 'native';
      return this.kind;
    }
    this.kind = 'library';
    const [z, q] = await Promise.all([loadZxing(), this.opts.qr ? loadJsQR() : Promise.resolve(null)]);
    this.zxing = z;
    this.jsqr = q;
    return this.kind;
  }

  private surface(w: number, h: number): CanvasRenderingContext2D | null {
    this.canvas ??= document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    return this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** One tick over the guide-frame crop of a live video (or a still image). */
  async decode(source: CanvasImageSource & ImageBitmapSource, crop: Crop, allRegions = false): Promise<DecodedCode[]> {
    if (crop.sw < 8 || crop.sh < 8) return [];
    if (this.native) {
      try {
        const found = await this.native.detect(source);
        return found
          .filter((d) => d.rawValue && d.rawValue.trim())
          .filter((d) => {
            const b = d.boundingBox;
            if (!b) return true;
            const cx = b.x + b.width / 2;
            const cy = b.y + b.height / 2;
            return cx >= crop.sx && cx <= crop.sx + crop.sw && cy >= crop.sy && cy <= crop.sy + crop.sh;
          })
          .map((d) => ({ text: d.rawValue.trim(), format: d.format, y: d.boundingBox?.y }));
      } catch {
        // It exists but refuses this source (a detached frame, an old build):
        // fall back to the library for good.
        this.native = null;
        this.kind = 'library';
        if (!this.zxing) this.zxing = await loadZxing();
        if (this.opts.qr && !this.jsqr) this.jsqr = await loadJsQR();
      }
    }
    const z = this.zxing ?? (this.zxing = await loadZxing());
    const scale = Math.min(1, LIBRARY_MAX_WIDTH / crop.sw);
    const w = Math.max(8, Math.round(crop.sw * scale));
    const h = Math.max(8, Math.round(crop.sh * scale));
    const ctx = this.surface(w, h);
    if (!ctx) return [];
    ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const luma = z.rgbaToLuminance(img.data, w, h);
    const regions = allRegions ? LABEL_REGIONS : [LABEL_REGIONS[this.tick % LABEL_REGIONS.length]];
    const out: DecodedCode[] = [];
    for (const r of regions) {
      const part = cropLuminance(luma, w, h, r);
      const hit = z.decodeLuminance(part.data, part.width, part.height);
      if (hit) out.push({ text: hit.text.trim(), format: hit.format, y: crop.sy + (part.top + hit.y) / scale });
    }
    // A receipt's QR code, every fourth tick (or always, for a still photo).
    if (this.jsqr && (allRegions || this.tick % 4 === 3)) {
      const q = this.jsqr(img.data, w, h, { inversionAttempts: 'attemptBoth' });
      const text = q?.data?.trim();
      if (text) out.push({ text, format: 'qr_code', y: crop.sy + (q?.location?.topLeftCorner.y ?? 0) / scale });
    }
    this.tick++;
    return out;
  }
}

/**
 * Where the on-screen guide frame falls in the video's own pixels. The video
 * is drawn `object-fit: cover`, so part of it is cut off on one axis; the
 * mapping undoes that scale and offset. A small margin is kept around the
 * frame so a label held a little off-centre is still read whole.
 */
export function guideCrop(video: HTMLVideoElement, guide: HTMLElement, margin = 0.08): Crop | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const vr = video.getBoundingClientRect();
  const gr = guide.getBoundingClientRect();
  if (!vr.width || !vr.height) return null;
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const offX = (vr.width - vw * scale) / 2;
  const offY = (vr.height - vh * scale) / 2;
  const mx = gr.width * margin;
  const my = gr.height * margin;
  const x0 = (gr.left - mx - vr.left - offX) / scale;
  const y0 = (gr.top - my - vr.top - offY) / scale;
  const x1 = (gr.right + mx - vr.left - offX) / scale;
  const y1 = (gr.bottom + my - vr.top - offY) / scale;
  const sx = Math.max(0, Math.floor(x0));
  const sy = Math.max(0, Math.floor(y0));
  return { sx, sy, sw: Math.min(vw, Math.ceil(x1)) - sx, sh: Math.min(vh, Math.ceil(y1)) - sy };
}
