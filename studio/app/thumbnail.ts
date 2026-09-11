/**
 * Real project thumbnails (slice S5). Captures the engine's WebGL canvas via
 * the S4 engine adapter and downscales it to a small PNG for the drafts list
 * and the account revision upload.
 *
 * Honesty rules (owner mandate §4 — "صور مصغرة حقيقية"):
 *  - the capture is the actual viewport pixels, never a placeholder render;
 *  - WebGL canvases without preserveDrawingBuffer read back blank outside the
 *    engine's own render tick — a blank/uniform capture is DETECTED and
 *    reported as null, so no caller ever stores or uploads an empty square
 *    pretending to be a preview.
 */

/** Structural slice of the S4 EngineAdapter this module needs. */
export interface EngineViewSource {
  root(): ShadowRoot | null;
  frame(): boolean;
}

export interface ThumbnailOptions {
  /** Output width in px (default 512). */
  width?: number;
  /** Output height in px (default 384). */
  height?: number;
  /** Background fill behind transparent viewport pixels. */
  background?: string;
  /** PNG (default) or JPEG/WebP for smaller uploads. */
  type?: "image/png" | "image/jpeg" | "image/webp";
  quality?: number;
}

const DEFAULTS = { width: 512, height: 384, background: "#101216", type: "image/png" as const };

/**
 * True when the sampled pixel grid is a single uniform color (a blank WebGL
 * read-back or an empty scene fill). Exported for reuse; sampling stays cheap
 * (a 12×12 grid) so capture can run inside a save without jank.
 */
export function isUniformImage(data: Uint8ClampedArray, width: number, height: number, tolerance = 3): boolean {
  if (width <= 0 || height <= 0 || data.length < 4) return true;
  const steps = 12;
  let first: [number, number, number, number] | null = null;
  for (let sy = 0; sy < steps; sy += 1) {
    for (let sx = 0; sx < steps; sx += 1) {
      const x = Math.min(width - 1, Math.floor(((sx + 0.5) / steps) * width));
      const y = Math.min(height - 1, Math.floor(((sy + 0.5) / steps) * height));
      const i = (y * width + x) * 4;
      const px: [number, number, number, number] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (!first) {
        first = px;
      } else if (
        Math.abs(px[0] - first[0]) > tolerance ||
        Math.abs(px[1] - first[1]) > tolerance ||
        Math.abs(px[2] - first[2]) > tolerance ||
        Math.abs(px[3] - first[3]) > tolerance
      ) {
        return false;
      }
    }
  }
  return true;
}

function findViewportCanvas(root: ShadowRoot | null): HTMLCanvasElement | null {
  if (!root) return null;
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  const visit = (scope: ParentNode): void => {
    for (const canvas of scope.querySelectorAll("canvas")) {
      const area = canvas.width * canvas.height;
      if (area > bestArea) {
        bestArea = area;
        best = canvas;
      }
    }
    for (const element of scope.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(root);
  return best;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/**
 * Draws `source` into a small offscreen canvas (cover crop, centered) and
 * returns a PNG blob — or null when the pixels read back blank/uniform.
 */
export async function captureCanvasThumbnail(
  source: HTMLCanvasElement,
  options: ThumbnailOptions = {}
): Promise<Blob | null> {
  const width = options.width ?? DEFAULTS.width;
  const height = options.height ?? DEFAULTS.height;
  if (source.width === 0 || source.height === 0) return null;

  const target = document.createElement("canvas");
  target.width = width;
  target.height = height;
  const ctx = target.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = options.background ?? DEFAULTS.background;
  ctx.fillRect(0, 0, width, height);

  // Cover crop: scale to fill, center the overflow.
  const scale = Math.max(width / source.width, height / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;
  try {
    ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  } catch {
    return null; // tainted or unreadable canvas
  }

  let pixels: ImageData;
  try {
    pixels = ctx.getImageData(0, 0, width, height);
  } catch {
    return null;
  }
  // The background fill makes a blank WebGL read-back a uniform image.
  if (isUniformImage(pixels.data, width, height)) return null;

  return new Promise<Blob | null>((resolve) => {
    target.toBlob(
      (blob) => resolve(blob),
      options.type ?? DEFAULTS.type,
      options.quality
    );
  });
}

/**
 * Captures the engine viewport through the adapter: re-frames nothing, waits
 * one frame so the engine's render loop has painted, then reads the largest
 * canvas in the engine's shadow tree. Returns null honestly when the engine
 * is not mounted or the read-back is blank.
 */
export async function captureEngineThumbnail(
  adapter: EngineViewSource,
  options: ThumbnailOptions = {}
): Promise<Blob | null> {
  const canvas = findViewportCanvas(adapter.root());
  if (!canvas) return null;
  await nextFrame();
  return captureCanvasThumbnail(canvas, options);
}
