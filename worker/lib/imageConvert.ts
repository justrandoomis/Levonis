/**
 * EVERY PICTURE BECOMES WEBP HERE, ON THE SERVER.
 *
 * WHY THIS EXISTS AT ALL. The conversion used to run in the visitor's browser,
 * on a canvas, and a browser is not a place a rule can be enforced:
 * `canvas.toBlob(cb, 'image/webp')` is SPECIFIED to fall back to PNG on a
 * runtime with no WebP encoder — silently, with a perfectly valid Blob whose
 * type is `image/png`. So the format a product photo was stored in depended on
 * which phone the owner happened to be holding, and on the wrong phone every
 * screen said "converted" while the database held the original. The owner's
 * word for it was «التحويل وهمي», and they were right.
 *
 * Moving it here removes the question. `env.IMAGES` takes the bytes the Worker
 * is already holding and returns WebP the same way for every visitor, every
 * device, every browser — including the ones that do not exist yet.
 *
 * WHY NOT `fetch(url, { cf: { image } })`, WHICH THIS REPO ALREADY TRIED.
 * That mechanism transforms an image addressable by URL, not bytes in memory,
 * so an upload would have to be stored first and re-fetched. Worse, in THIS
 * Worker `/files/*` is in `run_worker_first`, so the re-fetch re-enters the
 * same Worker — and Cloudflare's resizing is "forgotten as soon as one Worker
 * calls another" (9403/9524). That is the live bug behind the hand-written
 * MEDIA_TRANSFORM_UNAVAILABLE fallback in `routes/media.ts`.
 *
 * WHAT IT REFUSES TO DO. It does not re-encode an animated GIF: a transform
 * that keeps one frame throws the animation away, which is the same quiet
 * damage as the fake conversion pointing the other way. Those pass through
 * under their own type, honestly recorded.
 *
 * WHAT HAPPENS WITHOUT THE BINDING. `env.IMAGES` is undefined on an account
 * without the entitlement, in `wrangler dev`, and in tests. This module is the
 * ONLY place that reads it, so "what then" has one answer instead of one per
 * call site: `convertToWebp` reports `unavailable` and the caller decides, and
 * `webpConversionAvailable` lets a caller that writes to R2 ask BEFORE it
 * writes rather than after. It never pretends a conversion happened.
 */

import type { Env } from './types';
import { GuardedFetchError, readResponseBytes } from './fetchGuard';
import { rasterDimensions, validRasterDimensions, type RasterDimensions } from './imageMetadata';

/** What the Images binding will accept in one call. */
export const IMAGES_MAX_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * THE ONE SIZE LIMIT A PICTURE ENTERING THIS CATALOGUE HAS TO MEET.
 *
 * It lives here, next to the converter, because the owner meets it through
 * three different doors — the product form, a ZIP entry in an import, and a
 * URL cell in the same import — and until it was one constant those doors
 * disagreed. The product form allowed 8 MB; the import's ZIP path refused at
 * 4 MB and then told the owner the file was «غير موجود في مجلد images/» about
 * a file sitting in the ZIP in front of them. Raising the ZIP path alone
 * simply inverted the contradiction: the same 6 MB photograph imported as a
 * ZIP entry and was refused as a URL, in the same run, with two different
 * numbers in the message.
 *
 * It is a SOURCE-size limit. The message then names a file the owner can look
 * at and act on, rather than the size of something the server produced.
 * `IMAGES_MAX_INPUT_BYTES` above is a separate, larger ceiling imposed by the
 * binding itself.
 */
export const IMAGE_SOURCE_CAP = 8 * 1024 * 1024;

/** Converted bytes are bounded separately from source bytes. */
export const IMAGE_OUTPUT_CAP = 8 * 1024 * 1024;

/** The cap as the owner reads it, so no message hard-codes the number twice. */
export const IMAGE_SOURCE_CAP_MB = IMAGE_SOURCE_CAP / (1024 * 1024);

/** Quality: high enough that a product photo survives a pinch-zoom, low enough
 *  that the file is a fraction of the camera original. */
const WEBP_QUALITY = 85;

const byteString = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

function isoBrand(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 12 || byteString(bytes, 4, 4) !== 'ftyp') return null;
  return byteString(bytes, 8, 4);
}

function isoCompatibleBrands(bytes: Uint8Array): string[] {
  if (bytes.byteLength < 16 || byteString(bytes, 4, 4) !== 'ftyp') return [];
  const declared =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.byteLength, declared >= 16 ? declared : bytes.byteLength, 80);
  const brands: string[] = [];
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(byteString(bytes, offset, 4));
  return brands;
}

/** AVIF may be the major ISO-BMFF brand or only a compatible brand. */
export function declaresAvif(bytes: Uint8Array): boolean {
  const major = isoBrand(bytes);
  if (major === 'avif' || major === 'avis') return true;
  return major !== null && isoCompatibleBrands(bytes).some((brand) => brand === 'avif' || brand === 'avis');
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/** HEIF is deliberately not accepted as a browser-ready image. */
export function isHeifImageBytes(bytes: Uint8Array): boolean {
  const major = isoBrand(bytes);
  return major !== null && HEIF_BRANDS.has(major) && !declaresAvif(bytes);
}

export interface SniffedImage {
  ext: 'jpg' | 'png' | 'gif' | 'webp' | 'avif';
  mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif';
}

/** Content labels are untrusted; these signatures are read from the body. */
export function sniffImageBytes(bytes: Uint8Array): SniffedImage | null {
  if (bytes.byteLength < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (byteString(bytes, 0, 4) === 'GIF8') return { ext: 'gif', mime: 'image/gif' };
  if (byteString(bytes, 0, 4) === 'RIFF' && byteString(bytes, 8, 4) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (declaresAvif(bytes)) return { ext: 'avif', mime: 'image/avif' };
  return null;
}

/** An explicit fast-path for common masquerading HTML/XML responses. */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
  const sample = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return sample.startsWith('<!doctype') || sample.startsWith('<html') || sample.startsWith('<?xml') || sample.startsWith('<svg');
}

function skipGifSubBlocks(bytes: Uint8Array, offset: number): number | null {
  while (offset < bytes.byteLength) {
    const size = bytes[offset];
    offset += 1;
    if (size === 0) return offset;
    if (offset + size > bytes.byteLength) return null;
    offset += size;
  }
  return null;
}

/** Returns null for a malformed/truncated GIF, otherwise its frame count. */
export function gifFrameCount(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 13 || !['GIF87a', 'GIF89a'].includes(byteString(bytes, 0, 6))) return null;
  let offset = 13;
  const packed = bytes[10];
  if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1));
  if (offset > bytes.byteLength) return null;

  let frames = 0;
  while (offset < bytes.byteLength) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return frames > 0 ? frames : null;
    if (marker === 0x21) {
      if (offset >= bytes.byteLength) return null;
      offset += 1; // extension label
      const next = skipGifSubBlocks(bytes, offset);
      if (next === null) return null;
      offset = next;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.byteLength) return null;
    frames += 1;
    const imagePacked = bytes[offset + 8];
    offset += 9;
    if ((imagePacked & 0x80) !== 0) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
    if (offset >= bytes.byteLength) return null;
    offset += 1; // LZW minimum code size
    const next = skipGifSubBlocks(bytes, offset);
    if (next === null) return null;
    offset = next;
  }
  return null;
}

/**
 * Formats this converter will re-encode.
 *
 * GIF is deliberately absent — see the note above. AVIF is absent because it is
 * already a modern compressed format, arrives from vendor CDNs rather than a
 * camera, and re-encoding it to WebP would usually make the file BIGGER.
 */
const CONVERTIBLE = new Set(['image/png', 'image/jpeg']);

export function isConvertibleToWebp(mime: string): boolean {
  return CONVERTIBLE.has(mime);
}

/**
 * CAN THIS DEPLOYMENT CONVERT AT ALL — asked BEFORE any byte is written.
 *
 * `convertToWebp` already answers `unavailable`, but it answers it with the
 * image in hand, and a caller that stores first and asks afterwards has
 * already put the unconverted bytes in R2 by the time it hears the word. The
 * import needs the answer one step earlier: it writes image objects during
 * PREVIEW, so «تحققت أن الصور تتحول إلى WebP قبل التخزين» has to be decidable
 * before the first `put`, not after the fortieth.
 *
 * This stays in this module for the reason the header gives: `env.IMAGES` is
 * read in exactly one file, so "what does an account without the entitlement
 * do" keeps having one answer instead of one per call site.
 */
export function webpConversionAvailable(env: Pick<Env, 'IMAGES'>): boolean {
  return Boolean(env.IMAGES);
}

export type ConvertOutcome =
  | { ok: true; bytes: Uint8Array; mime: 'image/webp'; width: number; height: number }
  /** Nothing to do: already WebP, or a format we deliberately keep. */
  | { ok: false; reason: 'not_convertible' }
  /** No binding on this deployment. The caller decides what that means. */
  | { ok: false; reason: 'unavailable' }
  /** The binding is there and the image defeated it. */
  | { ok: false; reason: 'failed'; detail: string }
  | { ok: false; reason: 'too_large' };

/**
 * Convert to WebP, or say precisely why not.
 *
 * FOUR ANSWERS, NOT TWO, and the caller needs all four: "already fine",
 * "this deployment cannot", "this image could not" and "this image is too big"
 * have four different remedies, and collapsing them is how an operator ends up
 * staring at "upload failed".
 */
export async function convertToWebp(
  env: Pick<Env, 'IMAGES'>,
  bytes: Uint8Array,
  mime: string
): Promise<ConvertOutcome> {
  if (!isConvertibleToWebp(mime)) return { ok: false, reason: 'not_convertible' };
  if (bytes.byteLength > IMAGES_MAX_INPUT_BYTES) return { ok: false, reason: 'too_large' };
  const images = env.IMAGES;
  if (!images) return { ok: false, reason: 'unavailable' };

  try {
    // A ReadableStream, not the buffer: the binding streams, and handing it the
    // whole array would hold two copies of a 20 MB image in an isolate that has
    // 128 MB for everything.
    const stream = new Blob([bytes]).stream();
    const result = await images.input(stream).output({ format: 'image/webp', quality: WEBP_QUALITY });
    const response = result.response();
    if (!response.ok) {
      return { ok: false, reason: 'failed', detail: `the converter returned HTTP ${response.status}` };
    }
    const out = await readResponseBytes(response, {
      maxBytes: IMAGE_OUTPUT_CAP,
      tooLargeMessage: `Converted image exceeds the ${IMAGE_OUTPUT_CAP} byte limit`,
    });
    const kind = sniffImageBytes(out);
    const dimensions = kind?.mime === 'image/webp' ? rasterDimensions(out, kind.mime) : null;
    if (kind?.mime !== 'image/webp' || !validRasterDimensions(dimensions)) {
      return { ok: false, reason: 'failed', detail: 'the converter returned no valid WebP image' };
    }
    return { ok: true, bytes: out, mime: 'image/webp', width: dimensions.width, height: dimensions.height };
  } catch (e) {
    if (e instanceof GuardedFetchError && e.code === 'SOURCE_TOO_LARGE') {
      return { ok: false, reason: 'too_large' };
    }
    return { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

export type ProductWebpOutcome =
  | { ok: true; bytes: Uint8Array; mime: 'image/webp'; width: number; height: number; converted: boolean }
  | { ok: false; reason: 'unsupported' | 'animated_gif' | 'unavailable' | 'failed' | 'too_large'; detail?: string };

/**
 * Stricter product policy: every accepted still image leaves as verified WebP.
 * Animated GIF is refused rather than silently flattened to one frame.
 */
export async function productImageToWebp(
  env: Pick<Env, 'IMAGES'>,
  bytes: Uint8Array,
  mime?: string
): Promise<ProductWebpOutcome> {
  if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_SOURCE_CAP) return { ok: false, reason: 'too_large' };
  if (looksLikeMarkup(bytes)) return { ok: false, reason: 'unsupported', detail: 'HTML/XML is not an image' };

  const sniffed = sniffImageBytes(bytes);
  if (!sniffed || (mime && mime !== sniffed.mime)) {
    return { ok: false, reason: 'unsupported', detail: 'The bytes are not a supported image' };
  }

  if (sniffed.mime === 'image/gif') {
    const frames = gifFrameCount(bytes);
    if (frames === null) return { ok: false, reason: 'unsupported', detail: 'The GIF is malformed or truncated' };
    if (frames > 1) return { ok: false, reason: 'animated_gif', detail: 'Animated GIF product images are not supported' };
  }

  const images = env.IMAGES;
  if (!images) return { ok: false, reason: 'unavailable' };

  if (sniffed.mime === 'image/webp') {
    if (bytes.byteLength > IMAGE_OUTPUT_CAP) return { ok: false, reason: 'too_large' };
    // RIFF/WEBP magic and a plausible VP8 header are not proof that compressed
    // pixels decode. The binding's info() performs that decode without changing
    // already-WebP bytes. Older local stubs without info fall through to a
    // re-encode, which is also a decode and therefore still fails closed.
    const info = (images as ImagesBinding & { info?: ImagesBinding['info'] }).info;
    if (typeof info === 'function') {
      try {
        const decoded = await info.call(images, new Blob([bytes]).stream());
        const decodedFormat = decoded.format.toLowerCase();
        if (!('width' in decoded)) {
          return { ok: false, reason: 'failed', detail: 'The WebP decoder returned no raster dimensions' };
        }
        const dimensions = { width: decoded.width, height: decoded.height };
        if ((decodedFormat !== 'image/webp' && decodedFormat !== 'webp') || !validRasterDimensions(dimensions)) {
          return { ok: false, reason: 'failed', detail: 'The WebP could not be decoded or has unsupported dimensions' };
        }
        return {
          ok: true,
          bytes,
          mime: 'image/webp',
          width: dimensions.width,
          height: dimensions.height,
          converted: false,
        };
      } catch (error) {
        return {
          ok: false,
          reason: 'failed',
          detail: `The WebP could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }

  try {
    const stream = new Blob([bytes]).stream();
    const result = await images.input(stream).output({ format: 'image/webp', quality: WEBP_QUALITY });
    const response = result.response();
    if (!response.ok) {
      return { ok: false, reason: 'failed', detail: `the converter returned HTTP ${response.status}` };
    }
    const out = await readResponseBytes(response, {
      maxBytes: IMAGE_OUTPUT_CAP,
      tooLargeMessage: `Converted image exceeds the ${IMAGE_OUTPUT_CAP} byte limit`,
    });
    const outputKind = sniffImageBytes(out);
    const dimensions: RasterDimensions | null =
      outputKind?.mime === 'image/webp' ? rasterDimensions(out, outputKind.mime) : null;
    if (outputKind?.mime !== 'image/webp' || !validRasterDimensions(dimensions)) {
      return { ok: false, reason: 'failed', detail: 'the converter returned no valid WebP image' };
    }
    return {
      ok: true,
      bytes: out,
      mime: 'image/webp',
      width: dimensions.width,
      height: dimensions.height,
      converted: true,
    };
  } catch (error) {
    if (error instanceof GuardedFetchError && error.code === 'SOURCE_TOO_LARGE') {
      return { ok: false, reason: 'too_large' };
    }
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The file extension that must accompany a mime, so a key never lies. */
export function extensionFor(mime: string): string {
  switch (mime) {
    case 'image/webp': return 'webp';
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/avif': return 'avif';
    case 'video/mp4': return 'mp4';
    default: return 'bin';
  }
}

// ------------------------------------------------------------- variants

/**
 * A CARD DOES NOT NEED THE PHOTOGRAPH THE CAMERA TOOK.
 *
 * Every picture on the site is stored once, at up to 3000 px on its long
 * edge (`src/lib/imagePreprocess.ts`), and until this existed it was
 * DELIVERED at that size to a 174 px card on a phone: a twenty-tile rail was
 * twenty full-size downloads for a screen that could show a tenth of the
 * pixels. `GET /files/<key>?w=<width>` (worker/routes/uploads.ts) answers a
 * public still image at one of the widths below through the same `IMAGES`
 * binding that converts uploads, and in the format the browser's `Accept`
 * header says it can decode — AVIF before WebP before the stored format.
 *
 * FIVE WIDTHS, NOT A FREE PARAMETER. Each width × format is a separate
 * transformation billed once per object and a separate entry in the edge
 * cache; an open `?w=` would let one visitor mint a thousand of both. The
 * client's `srcset` (`src/components/ui/SafeImage.tsx`) names exactly these
 * five, and tests/imageVariants.test.ts pins the two lists to each other.
 *   160  a 36–64 CSS px thumbnail at DPR 2;
 *   320  a card in a 2–3 column grid at DPR 1–2 (148–174 CSS px);
 *   480  a wider phone card at DPR 2, without a jump from 320 to 640;
 *   640  the same card at DPR 3, or a 2-up tile on a wide phone;
 *   1080 a full-width picture on a phone at DPR 3, or a card on desktop.
 * `fit: scale-down` never enlarges: a 500 px original asked for at 1080
 * comes back at 500 px, which is the honest answer.
 */
export const IMAGE_VARIANT_WIDTHS = [160, 320, 480, 640, 1080] as const;
export type ImageVariantWidth = (typeof IMAGE_VARIANT_WIDTHS)[number];

/** The `w` query value, or null when it is absent, or 'invalid' when it names a width not on the list. */
export function parseVariantWidth(raw: string | null | undefined): ImageVariantWidth | null | 'invalid' {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return (IMAGE_VARIANT_WIDTHS as readonly number[]).includes(n) ? (n as ImageVariantWidth) : 'invalid';
}

export type ImageVariantFormat = 'image/avif' | 'image/webp' | 'image/jpeg' | 'image/png';

/**
 * The still-image formats a variant can be cut from, read from the KEY's
 * extension — a key never lies about its bytes here (`extensionFor`), and
 * reading the extension lets the route refuse a video or a GIF before it
 * touches the cache or the bucket. GIF is excluded on purpose: a resize
 * keeps one frame, and a merchant's animated banner turning into a still is
 * the same quiet damage the converter refuses at upload.
 */
export function variantSourceMime(key: string): ImageVariantFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(key);
  switch ((m?.[1] ?? '').toLowerCase()) {
    case 'webp': return 'image/webp';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    default: return null;
  }
}

/**
 * The format the browser gets, from its own `Accept` header: AVIF when it
 * lists it, else WebP when it lists that, else the stored format (a PNG stays
 * a PNG, so a picture with transparency keeps it). Safari 16, every Chrome
 * and Firefox of the last years send `image/avif`; the stored WebP is the
 * floor, never a step down.
 */
export function negotiateVariantFormat(accept: string | null | undefined, source: ImageVariantFormat): ImageVariantFormat {
  const a = (accept ?? '').toLowerCase();
  if (a.includes('image/avif')) return 'image/avif';
  if (a.includes('image/webp')) return 'image/webp';
  return source;
}

/**
 * Quality per output format. WebP keeps the converter's own 85, so a variant
 * is never a lower grade than the stored picture; AVIF's scale is not WebP's
 * — the same visual grade sits lower on it — and 75 is the value the plan
 * takes until the owner's own zone measures it (docs/PERFORMANCE_LOG.md P2c
 * records that this pair was NOT measured in the lab, which has no encoder).
 */
export const VARIANT_QUALITY: Record<ImageVariantFormat, number | undefined> = {
  'image/avif': 75,
  'image/webp': WEBP_QUALITY,
  'image/jpeg': WEBP_QUALITY,
  'image/png': undefined,
};

export type VariantOutcome =
  | { ok: true; body: ReadableStream<Uint8Array>; mime: ImageVariantFormat }
  /** No binding on this deployment: the caller serves the original. */
  | { ok: false; reason: 'unavailable' }
  /** The binding is there and the image defeated it: the caller serves the original. */
  | { ok: false; reason: 'failed'; detail: string };

/**
 * Cut one variant. The output is a STREAM, not bytes: the route hands it to
 * the client and to the edge cache and never holds a whole picture in the
 * isolate. Failure is never an error for the visitor — the route falls back
 * to the stored file, which is exactly what they got before this existed.
 */
export async function renderImageVariant(
  env: Pick<Env, 'IMAGES'>,
  source: ReadableStream<Uint8Array>,
  variant: { width: ImageVariantWidth; format: ImageVariantFormat }
): Promise<VariantOutcome> {
  const images = env.IMAGES;
  if (!images) {
    // Nobody is listening; let the source go rather than leak a stream.
    await source.cancel().catch(() => undefined);
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const quality = VARIANT_QUALITY[variant.format];
    const result = await images
      .input(source)
      .transform({ width: variant.width, fit: 'scale-down' })
      .output(quality === undefined ? { format: variant.format } : { format: variant.format, quality });
    const response = result.response();
    if (!response.ok || !response.body) {
      return { ok: false, reason: 'failed', detail: `the converter returned HTTP ${response.status}` };
    }
    return { ok: true, body: response.body as ReadableStream<Uint8Array>, mime: variant.format };
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
