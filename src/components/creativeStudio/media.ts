/**
 * THE MEASURER AND THE PICTURES THE CANVAS DRAWS.
 *
 * ONE MEASURER. The layout engine (buildFromTemplate, fitText), the renderer
 * (our own wrapped lines) and the quality check (text_fit) all measure with
 * the same canvas `measureText` under the same font string Konva uses, so the
 * overflow the check reports is the overflow the export shows. It is created
 * after the fonts load (a measurer made earlier would have measured the
 * fallback font) and re-created when a face arrives later.
 *
 * SAME-ORIGIN PICTURES ONLY. A product picture is its `/files/…` path, a
 * studio asset its `/api/admin/creative-studio/assets/<id>/file`, the site
 * logo the one url src/lib/siteLogo.ts serves. A cross-origin picture would
 * taint the canvas and make every export fail, so anything that is not a
 * same-origin path is refused here, before a request is made.
 */
import { SITE_LOGO_VERSIONED_URL } from '../../lib/siteLogo';
import type { AssetRef } from '../../../packages/creativeDoc/src/schema';
import type { TextMeasurer } from '../../../packages/creativeDoc/src/text';
import { knockoutWhite, type KnockoutResult } from '../../../packages/creativeDoc/src/knockout';
import { assetFileUrl } from './client';

export function canvasMeasurer(): TextMeasurer {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas?.getContext('2d') ?? null;
  const cache = new Map<string, number>();
  return (text, font) => {
    const css = `${font.weight} ${font.size}px "${font.family}"`;
    const key = `${css}\u0000${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (!ctx) return 0;
    ctx.font = css;
    const w = ctx.measureText(text).width;
    if (cache.size > 6000) cache.clear();
    cache.set(key, w);
    return w;
  };
}

/** The same-origin url for an asset reference, or null for anything that is not one. */
export function urlForRef(ref: AssetRef): string | null {
  if (ref.kind === 'product') return /^\/files\/[A-Za-z0-9]/.test(ref.ref) && !ref.ref.includes('..') && !ref.ref.startsWith('//') ? ref.ref : null;
  if (ref.kind === 'logo' && ref.ref === 'site') return SITE_LOGO_VERSIONED_URL;
  if ((ref.kind === 'asset' || ref.kind === 'logo') && /^[A-Za-z0-9_-]{6,64}$/.test(ref.ref)) return assetFileUrl(ref.ref);
  return null;
}

type Entry = { state: 'loading' | 'loaded' | 'failed'; img: HTMLImageElement; waiters: Array<(ok: boolean) => void> };

/**
 * Loads and keeps the decoded pictures. `loadedRefs()` is the set the quality
 * check reads (`assetsLoaded`): a ref is in it only after the picture decoded.
 * `decodedSizes()` is the size each one REALLY decoded at (`decodedSizes`,
 * keyed the same way): a file replaced in place, or a photo whose EXIF
 * rotation the upload's header read missed, has another ratio than the one
 * recorded — the renderer then draws it contained and the checks say so.
 */
export class ImageStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();

  private keyOf(ref: AssetRef): string {
    return `${ref.kind}:${ref.ref}`;
  }

  get(ref: AssetRef): HTMLImageElement | null {
    const e = this.entries.get(this.keyOf(ref));
    return e && e.state === 'loaded' ? e.img : null;
  }

  state(ref: AssetRef): 'loading' | 'loaded' | 'failed' | 'none' {
    return this.entries.get(this.keyOf(ref))?.state ?? 'none';
  }

  load(ref: AssetRef): Promise<boolean> {
    const key = this.keyOf(ref);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.state === 'loaded') return Promise.resolve(true);
      if (existing.state === 'failed') return Promise.resolve(false);
      return new Promise((resolve) => existing.waiters.push(resolve));
    }
    const url = urlForRef(ref);
    if (!url || typeof Image === 'undefined') {
      this.entries.set(key, { state: 'failed', img: null as unknown as HTMLImageElement, waiters: [] });
      this.emit();
      return Promise.resolve(false);
    }
    const img = new Image();
    img.decoding = 'async';
    const entry: Entry = { state: 'loading', img, waiters: [] };
    this.entries.set(key, entry);
    return new Promise((resolve) => {
      entry.waiters.push(resolve);
      const settle = (ok: boolean) => {
        entry.state = ok ? 'loaded' : 'failed';
        const waiters = entry.waiters.splice(0);
        for (const w of waiters) w(ok);
        this.emit();
      };
      img.onload = () => {
        if (typeof img.decode === 'function') img.decode().then(() => settle(true), () => settle(img.naturalWidth > 0));
        else settle(img.naturalWidth > 0);
      };
      img.onerror = () => settle(false);
      img.src = url;
    });
  }

  /** The decoded pixel size of each picture that loaded, by `asset.ref` (like `loadedRefs`). */
  decodedSizes(): Record<string, { width: number; height: number }> {
    const out: Record<string, { width: number; height: number }> = {};
    for (const [key, e] of this.entries) {
      if (e.state === 'loaded' && e.img.naturalWidth > 0 && e.img.naturalHeight > 0) out[key.slice(key.indexOf(':') + 1)] = { width: e.img.naturalWidth, height: e.img.naturalHeight };
    }
    return out;
  }

  /** Refs (as stored in the document, `asset.ref`) whose picture decoded. */
  loadedRefs(): Set<string> {
    const out = new Set<string>();
    for (const [key, e] of this.entries) if (e.state === 'loaded') out.add(key.slice(key.indexOf(':') + 1));
    return out;
  }

  failedRefs(): string[] {
    return [...this.entries].filter(([, e]) => e.state === 'failed').map(([k]) => k.slice(k.indexOf(':') + 1));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** The longest side a knocked-out picture is processed at (the drawn size is never larger on a post). */
const KNOCKOUT_MAX = 1600;
const knocked = new WeakMap<HTMLImageElement, { canvas: HTMLCanvasElement; bounds: KnockoutResult['bounds'] }>();

/**
 * A product picture with its white backdrop made transparent (packages/creativeDoc/src/knockout.ts),
 * once per decoded picture. `bounds` are in the picture's NATURAL pixels. Null when the pixels cannot
 * be read (a cross-origin picture; the studio never places one).
 */
export function knockedOut(img: HTMLImageElement): { canvas: HTMLCanvasElement; bounds: KnockoutResult['bounds'] } | null {
  const hit = knocked.get(img);
  if (hit) return hit;
  if (!img.naturalWidth || !img.naturalHeight || typeof document === 'undefined') return null;
  const k = Math.min(1, KNOCKOUT_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  let data: ImageData;
  try {
    data = g.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  const r = knockoutWhite(data.data, canvas.width, canvas.height);
  g.putImageData(data, 0, 0);
  const sx = img.naturalWidth / canvas.width;
  const sy = img.naturalHeight / canvas.height;
  const bounds = r.bounds
    ? { x: Math.floor(r.bounds.x * sx), y: Math.floor(r.bounds.y * sy), width: Math.min(img.naturalWidth - Math.floor(r.bounds.x * sx), Math.ceil(r.bounds.width * sx)), height: Math.min(img.naturalHeight - Math.floor(r.bounds.y * sy), Math.ceil(r.bounds.height * sy)) }
    : null;
  const out = { canvas, bounds };
  knocked.set(img, out);
  return out;
}

/**
 * The content box of a product picture once its white backdrop is knocked out, in the pixels of the size
 * the store RECORDED for it (`recorded`, which the document's `natural` carries), or null.
 */
export function knockoutBounds(url: string, recorded: { width: number; height: number }): Promise<KnockoutResult['bounds']> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const b = knockedOut(img)?.bounds ?? null;
      if (!b) return resolve(null);
      const kx = recorded.width / img.naturalWidth;
      const ky = recorded.height / img.naturalHeight;
      const x = Math.max(0, Math.floor(b.x * kx));
      const y = Math.max(0, Math.floor(b.y * ky));
      resolve({ x, y, width: Math.min(recorded.width - x, Math.ceil(b.width * kx)), height: Math.min(recorded.height - y, Math.ceil(b.height * ky)) });
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
