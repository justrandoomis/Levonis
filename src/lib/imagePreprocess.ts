export type ConvertibleRaster = 'png' | 'jpeg';

/**
 * THE CEILING BELONGS TO WHAT IS UPLOADED, NOT TO WHAT WAS PICKED.
 *
 * `PRODUCT_IMAGE_MAX_BYTES` is the server's own limit (`IMAGE_MAX` in
 * `worker/routes/uploads.ts`) and it applies to the bytes that actually travel.
 * For a PNG or a JPEG those bytes are the WebP this module produces, which is
 * routinely an order of magnitude smaller than the camera original — so
 * measuring the ORIGINAL against this number refused uploads that would have
 * succeeded comfortably. A 12 MB iPhone PNG becomes a ~400 KB WebP; refusing it
 * before the conversion is refusing a file that was never going to be sent.
 *
 * `PRODUCT_IMAGE_MAX_SOURCE_BYTES` is the only limit the original needs: a
 * guard against handing something absurd to the decoder on a phone. It is
 * deliberately generous, because the decode is bounded by PIXELS below, and
 * pixels — not bytes — are what exhaust a mobile canvas.
 */
export const PRODUCT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
/** Mirrors `VIDEO_MAX` in `worker/routes/uploads.ts`. */
export const PRODUCT_VIDEO_MAX_BYTES = 40 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_EDGE = 3_000;
/**
 * A CANVAS THAT IS TOO BIG DOES NOT THROW — IT RETURNS NOTHING.
 *
 * Mobile Safari and several Android WebViews cap the backing store of a
 * canvas. Past that cap the element still exists, `drawImage` still returns,
 * and `toBlob` hands back `null` (or a blank surface). 3000x3000 is 9 megapixels
 * and lands over the cap on real devices in the owner's market, which is a
 * failure that looks exactly like "upload failed" with no reason attached.
 *
 * So the encoder steps DOWN instead of giving up. Each rung is still far larger
 * than any box the storefront puts a product image in, so the fallback costs
 * detail nobody sees and saves an upload that would otherwise be lost.
 */
export const ENCODE_EDGE_LADDER = [PRODUCT_IMAGE_MAX_EDGE, 2_048, 1_600, 1_200] as const;
/**
 * AN AVATAR IS NEVER SHOWN LARGE.
 *
 * The biggest box any avatar lands in is a profile hero; the one on every page
 * is the 32x32 chip in the header. Until now `uploadFile` ran the WebP
 * conversion ONLY for `purpose === 'product'`, so an avatar was stored exactly
 * as the phone produced it — a modern camera JPEG of several megabytes — and
 * then downloaded in full to fill 32 device-independent pixels, on every page,
 * for every visitor.
 *
 * 512 is generous for a 2x profile hero and still two orders of magnitude
 * smaller than the original.
 */
export const AVATAR_IMAGE_MAX_EDGE = 512;
export const PRODUCT_IMAGE_MAX_PIXELS = 48_000_000;

/** Detect bytes, never an extension or browser-declared MIME. */
export function detectConvertibleRaster(bytes: Uint8Array): ConvertibleRaster | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

function isMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return false;
  const brand = String.fromCharCode(...bytes.slice(8, 12));
  return brand !== 'avif' && brand !== 'avis';
}

export function webpFilename(name: string): string {
  const clean = name.split(/[\\/]/).pop()?.trim() || 'image';
  const stem = clean.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._ -]/gu, '').trim() || 'image';
  return `${stem.slice(0, 120)}.webp`;
}

export interface WebpEncodeResult {
  blob: Blob;
  width: number;
  height: number;
}

export type WebpEncoder = (file: File) => Promise<WebpEncodeResult>;

type DecodedImage = { source: CanvasImageSource; width: number; height: number; close?: () => void };

async function decodeViaElement(file: File): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    if (image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error('empty decode');
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * TWO DECODERS, AND THE SECOND ONE IS NOT DEAD CODE.
 *
 * `createImageBitmap` was used whenever it EXISTED, and the `<img>` path ran
 * only when it was absent. But the way this call fails in the field is not
 * absence: it is present and it THROWS — an older WebKit that rejects the
 * `imageOrientation` option outright, a WebView that cannot decode a
 * particular PNG chunk, a phone that simply has no memory left for the bitmap.
 * Every one of those ended the upload with an exception the admin saw as
 * "upload failed".
 *
 * `<img>` + `decode()` is a genuinely different decoder with a different memory
 * profile, and it applies EXIF orientation natively — which is what the
 * `from-image` option was asking for in the first place. So a throw is a reason
 * to try it, not a reason to stop.
 */
async function loadImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // fall through to the element decoder
    }
  }
  return decodeViaElement(file);
}

/** One attempt at one edge. Returns `null` for the failures worth retrying
 *  smaller (a canvas the device would not back, an encoder that answered with
 *  nothing) and throws for the ones a smaller canvas cannot fix. */
async function drawAndEncode(decoded: DecodedImage, maxEdge: number): Promise<WebpEncodeResult | null> {
  const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('هذا المتصفح لا يدعم تحويل الصور / image conversion unavailable');
  // An untouched transparent canvas preserves PNG alpha. The browser's
  // decoded source has EXIF orientation applied before this draw.
  try {
    ctx.drawImage(decoded.source, 0, 0, width, height);
  } catch {
    return null;
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/webp', 0.87);
  });
  // `toBlob` reports a canvas it could not back, and an encoder it does not
  // have, in exactly the same way: null. Both are retryable at a smaller edge —
  // and if the smallest rung still yields nothing, the caller says which it was.
  if (!blob || blob.size <= 0) return null;
  // A browser without a WebP encoder silently substitutes PNG. That is not a
  // size problem, so a smaller canvas will never fix it — but a PNG this small
  // is still refused by the server, so it must be named, not retried.
  if (blob.type !== 'image/webp') {
    throw new Error('هذا المتصفح لا ينتج صور WebP — جرّب متصفحًا آخر / no WebP encoder in this browser');
  }
  if (blob.size > PRODUCT_IMAGE_MAX_BYTES) return null;
  return { blob, width, height };
}

/** Browser codec shared by every admin product-image uploader. */
export async function encodeProductRasterAsWebp(
  file: File,
  maxEdge: number = PRODUCT_IMAGE_MAX_EDGE
): Promise<WebpEncodeResult> {
  const decoded = await loadImage(file);
  try {
    if (decoded.width < 1 || decoded.height < 1) {
      throw new Error('تعذّر قراءة أبعاد الصورة / the image could not be decoded');
    }
    if (decoded.width > 12_000 || decoded.height > 12_000) {
      throw new Error(
        `أبعاد الصورة كبيرة جدًا (${decoded.width}×${decoded.height}، الحد 12000) / image is too large`
      );
    }
    if (decoded.width * decoded.height > PRODUCT_IMAGE_MAX_PIXELS) {
      throw new Error(
        `عدد بكسلات الصورة كبير جدًا (${Math.round((decoded.width * decoded.height) / 1e6)} ميغابكسل، الحد 48) / too many pixels`
      );
    }
    // Never start ABOVE the caller's ceiling, and never below it either when it
    // is already smaller than every rung (an avatar asks for 512).
    const ladder = [maxEdge, ...ENCODE_EDGE_LADDER.filter((edge) => edge < maxEdge)];
    for (const edge of ladder) {
      const result = await drawAndEncode(decoded, edge);
      if (result) return result;
    }
    throw new Error('تعذّر إنتاج صورة WebP على هذا الجهاز / this device could not encode the image');
  } finally {
    decoded.close?.();
  }
}

export interface PreparedProductImage {
  file: File;
  converted: boolean;
  width?: number;
  height?: number;
}

/**
 * PNG/JPEG become WebP before network upload. GIF/AVIF/video are deliberately
 * left alone because converting those blindly can destroy animation or media.
 */
/**
 * The same conversion, at an avatar's ceiling. A format the codec does not
 * convert (GIF, AVIF) is passed through untouched, exactly as for a product —
 * blindly re-encoding an animated avatar would destroy it.
 */
export async function prepareAvatarImage(
  file: File,
  encoder: WebpEncoder = (f) => encodeProductRasterAsWebp(f, AVATAR_IMAGE_MAX_EDGE)
): Promise<PreparedProductImage> {
  return prepareProductImage(file, encoder);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function prepareProductImage(file: File, encoder: WebpEncoder = encodeProductRasterAsWebp): Promise<PreparedProductImage> {
  const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());

  // A PNG or a JPEG is never uploaded as it stands — the encoder below replaces
  // it with a WebP, and the 8 MB ceiling is measured on THAT. All the original
  // has to clear is the decoder's own sanity guard.
  if (detectConvertibleRaster(signature)) {
    if (file.size > PRODUCT_IMAGE_MAX_SOURCE_BYTES) {
      throw new Error(
        `الملف ${megabytes(file.size)} — أكبر من أن يُفتح (الحد ${megabytes(PRODUCT_IMAGE_MAX_SOURCE_BYTES)}) / source file too large`
      );
    }
    const result = await encoder(file);
    return {
      file: new File([result.blob], webpFilename(file.name), { type: 'image/webp', lastModified: file.lastModified }),
      converted: true,
      width: result.width,
      height: result.height,
    };
  }

  // Everything else travels exactly as picked — GIF and AVIF are deliberately
  // not re-encoded (it would destroy animation), and MP4 is not an image at
  // all — so for these the ceiling really is the ceiling.
  const limit = isMp4(signature) ? PRODUCT_VIDEO_MAX_BYTES : PRODUCT_IMAGE_MAX_BYTES;
  if (file.size > limit) {
    throw new Error(`الملف ${megabytes(file.size)} — الحد ${megabytes(limit)} / file exceeds the limit`);
  }
  return { file, converted: false };
}
