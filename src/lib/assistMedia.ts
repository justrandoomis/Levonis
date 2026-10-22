/**
 * FRAMES FROM A CLIP, TAKEN IN THE BROWSER (push B1; plan §5.3, §11).
 *
 * Loaded with a dynamic import, the first time a clip is read or the owner
 * runs the vision Test, so neither the assistant page nor the + sheet carries
 * any of it (tests/bundleBudget.test.ts).
 *
 * There is no video decoding on the server. A hidden, muted video element
 * plays the clip on this device, seeks to four points and draws each one to a
 * canvas no wider or taller than 1024 px, and the canvas encodes a JPEG. A
 * canvas JPEG carries no EXIF, so nothing about where or when the clip was
 * filmed leaves with it. The frames live in memory only: they are posted once
 * and never stored, on either side.
 *
 * The source is the File still in memory when the customer attached it in
 * this visit, or `/files/<key>` after a reload (the owner of a file may read
 * it). An object URL made here is always revoked.
 */

/** Where the frames are taken: 15, 40, 65 and 90 percent of the clip. */
export const FRAME_FRACTIONS = [0.15, 0.4, 0.65, 0.9] as const;
/** A longer clip is read over its first two minutes only. */
export const MAX_PICK_SECONDS = 120;
/** The longest side of a frame, in pixels. */
export const FRAME_EDGE = 1024;
/** JPEG quality first tried, and the lower ones tried when a frame is too heavy. */
export const FRAME_QUALITIES = [0.8, 0.65, 0.5] as const;
/** The server takes at most 400 KB a frame, counted in thousands (worker/lib/ai/jpeg.ts FRAME_LIMITS). */
export const FRAME_MAX_BYTES = 400_000;
export const SEEK_TIMEOUT_MS = 6000;
export const TOTAL_TIMEOUT_MS = 10000;
/** Fewer than this many frames is no reading: the page says so and calls nothing. */
export const MIN_FRAMES = 2;

/** The four seek points inside (0, d), or none for a clip with no usable length. */
export function frameTimes(duration: number): number[] {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return [];
  const d = Math.min(duration, MAX_PICK_SECONDS);
  return FRAME_FRACTIONS.map((f) => f * d);
}

/** A width and height scaled down (never up) so the longer side is at most `max`. */
export function fitEdge(width: number, height: number, max: number): { width: number; height: number } {
  if (![width, height, max].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.min(Math.round(max), Math.max(1, Math.round(width * scale))),
    height: Math.min(Math.round(max), Math.max(1, Math.round(height * scale))),
  };
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    } catch {
      resolve(null);
    }
  });
}

/** The lightest JPEG of the canvas under the server limit, or null. */
async function encodeFrame(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const q of FRAME_QUALITIES) {
    const blob = await toJpeg(canvas, q);
    if (blob && blob.size > 0 && blob.size <= FRAME_MAX_BYTES) return blob;
  }
  return null;
}

/** Resolves on the event, rejects on an error or when the time is up; always removes its listeners. */
function once(video: HTMLVideoElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const done = (ok: boolean) => {
      window.clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
      if (ok) resolve();
      else reject(new Error(event));
    };
    const onEvent = () => done(true);
    const onError = () => done(false);
    timer = window.setTimeout(() => done(false), Math.max(0, ms));
    video.addEventListener(event, onEvent);
    video.addEventListener('error', onError);
  });
}

/**
 * Two to four JPEG frames of the clip, in order, or fewer when this device
 * cannot decode it (the caller then shows `frames_failed` and calls nothing).
 * Never throws.
 */
export async function extractFrames(source: Blob | string): Promise<Blob[]> {
  if (typeof document === 'undefined') return [];
  const owned = typeof source !== 'string';
  let url = '';
  const frames: Blob[] = [];
  const video = document.createElement('video');
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const left = () => deadline - Date.now();
  try {
    url = owned ? URL.createObjectURL(source) : source;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    // In the page but out of sight: some phone browsers decode nothing for a detached element.
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;inset-inline-start:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(video);
    const ready = once(video, 'loadeddata', Math.min(SEEK_TIMEOUT_MS, left()));
    video.src = url;
    video.load();
    await ready;
    const times = frameTimes(video.duration);
    if (!times.length) return frames;
    // A muted play and pause wakes the decoder on the browsers that draw black until it runs once.
    try {
      await video.play();
      video.pause();
    } catch {
      /* autoplay refused: seeking alone still works on most devices */
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return frames;
    for (const t of times) {
      if (left() <= 0) break;
      try {
        const seeked = once(video, 'seeked', Math.min(SEEK_TIMEOUT_MS, left()));
        video.currentTime = t;
        await seeked;
      } catch {
        continue;
      }
      const size = fitEdge(video.videoWidth, video.videoHeight, FRAME_EDGE);
      if (!size.width || !size.height) continue;
      canvas.width = size.width;
      canvas.height = size.height;
      ctx.drawImage(video, 0, 0, size.width, size.height);
      const frame = await encodeFrame(canvas);
      if (frame) frames.push(frame);
    }
    return frames;
  } catch {
    return frames;
  } finally {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    } catch {
      /* already gone */
    }
    if (owned && url) URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------- the owner vision Test

const HEX = '0123456789ABCDEF';

/**
 * A code in the shape of a printer error code («0300-0100-0001-0007»), made up
 * for one Test: four groups of four, the first starting with 0 so the shape
 * reader takes it as a printer code. Never a real fault of any printer.
 */
export function testCode(random: () => number = Math.random): string {
  const group = (lead?: string) =>
    (lead ?? '') + Array.from({ length: lead ? 3 : 4 }, () => HEX[Math.floor(random() * 16) % 16]).join('');
  return [group('0'), group(), group(), group()].join('-');
}

/**
 * The image the owner vision Test sends: the code in large light type on a
 * dark, screen-like panel, as a printer shows it. Drawn here, so the Test
 * needs no stored file and stores none.
 */
export async function drawCodeTestImage(code: string): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#15171a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0b0c0e';
  ctx.fillRect(80, 110, 800, 320);
  ctx.strokeStyle = '#3a3f46';
  ctx.lineWidth = 6;
  ctx.strokeRect(80, 110, 800, 320);
  ctx.fillStyle = '#c7ccd3';
  ctx.font = '600 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('HMS', 480, 190);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 64px monospace';
  ctx.fillText(code, 480, 290);
  return toJpeg(canvas, 0.9);
}
