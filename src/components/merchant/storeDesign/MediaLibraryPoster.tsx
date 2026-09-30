/**
 * A POSTER FROM THE VIDEO ITSELF (docs/MERCHANT_PLATFORM_V2.md storefront W8,
 * B1; P5). A hero or background video needs its still — it is what phones,
 * reduced motion and the first paint show, and publishing without one is
 * refused (LAYOUT_POSTER_REQUIRED) — so the picker takes one for the merchant:
 * the frame at 0.5 s (or halfway, for a shorter clip), drawn to a canvas no
 * wider than 1280 px, encoded WebP (JPEG where the browser cannot), stepped
 * down until it fits the poster slot's cap.
 *
 * Loaded on demand by the media picker (its own chunk): a builder that never
 * picks a video never downloads it. No server transcoding exists
 * (worker/lib/videoSniff.ts only sniffs), so a codec this browser cannot
 * decode (AV1 or HEVC on some phones) yields no frame — the answer is then
 * null and the inspector asks for a poster picture instead.
 */

const EDGES = [1280, 960, 720] as const;
const QUALITIES = [0.82, 0.7, 0.6] as const;

function once<T extends Event>(el: HTMLElement, type: string, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      el.removeEventListener(type, on as EventListener);
      reject(new Error(`${type} timed out`));
    }, ms);
    const on = (e: T) => {
      window.clearTimeout(t);
      resolve(e);
    };
    el.addEventListener(type, on as EventListener, { once: true });
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/** The second the frame is taken at: 0.5 s, or halfway through a clip shorter than a second. */
export function posterMoment(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0.5;
  return Math.min(0.5, duration / 2);
}

/** Width × height scaled to fit `edge` on the long side, never up. */
export function fitEdge(width: number, height: number, edge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (!(long > edge)) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const k = edge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/**
 * The poster, as a File ready for the upload door, or null when no frame
 * could be read. `source` is the picked file (before or after its upload) or
 * a same-origin address of the merchant's own video.
 */
export async function capturePoster(source: Blob | string, opts: { maxBytes?: number } = {}): Promise<File | null> {
  if (typeof document === 'undefined') return null;
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  try {
    video.src = url;
    await once(video, 'loadeddata', 10_000);
    video.currentTime = posterMoment(video.duration);
    await once(video, 'seeked', 10_000);
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    for (const edge of EDGES) {
      const size = fitEdge(w, h, edge);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, size.width, size.height);
      for (const q of QUALITIES) {
        // WebP first; a browser without a WebP encoder answers PNG, and JPEG is then the lighter still.
        let blob = await toBlob(canvas, 'image/webp', q);
        if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', q);
        if (!blob) return null;
        if (!opts.maxBytes || blob.size <= opts.maxBytes) {
          const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
          return new File([blob], `poster.${ext}`, { type: blob.type, lastModified: Date.now() });
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}
