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

/**
 * A conversation also carries a WebM clip, a voice note and a PDF
 * (worker/routes/uploads.ts `sniffChat`), and those travel through here
 * untouched too. Their ceilings are the SERVER'S, not a picture's: 40 MB for a
 * clip (`VIDEO_MAX`), 10 MB for a voice note or a document
 * (`CHAT_DOCUMENT_MAX`). Checking them against the 8 MB picture limit refused a
 * 9 MB scanned PDF in the browser that the server would have stored. A purpose
 * that does not admit the type is still refused by the server, by name.
 */
export const CHAT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

function passthroughLimit(b: Uint8Array): number {
  const isWebm = b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  if (isMp4(b) || isWebm) return PRODUCT_VIDEO_MAX_BYTES;
  const isPdf = b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
  const isOgg = b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53;
  const isMp3 = b.length >= 3 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0));
  if (isPdf || isOgg || isMp3) return CHAT_DOCUMENT_MAX_BYTES;
  return PRODUCT_IMAGE_MAX_BYTES;
}

export function webpFilename(name: string): string {
  const clean = name.split(/[\\/]/).pop()?.trim() || 'image';
  const stem = clean.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._ -]/gu, '').trim() || 'image';
  return `${stem.slice(0, 120)}.webp`;
}

function rasterFilename(name: string, mime: string): string {
  if (mime === 'image/webp') return webpFilename(name);
  const clean = name.split(/[\\/]/).pop()?.trim() || 'image';
  const stem = clean.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._ -]/gu, '').trim() || 'image';
  const extension = mime === 'image/jpeg' ? 'jpg' : 'png';
  return `${stem.slice(0, 120)}.${extension}`;
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
  /**
   * WEBP OR NOTHING FROM THE CANVAS — and this line used to be the opposite.
   *
   * `canvas.toBlob(cb, 'image/webp')` DOES NOT FAIL on a browser with no WebP
   * encoder. The specification tells it to fall back to PNG, silently, with a
   * perfectly valid Blob whose `type` is `image/png`. The previous version of
   * this check accepted that Blob as a successful conversion, so the file was
   * renamed, uploaded, sniffed by the server as PNG and stored as PNG — while
   * every screen in between said the image had been converted.
   *
   * That is exactly the «تحويل وهمي» the owner reported: it claims to have
   * converted and the database holds the original format. A conversion that
   * cannot be trusted is worse than one that refuses, because nobody goes
   * looking for it.
   *
   * So anything that is not WebP is a FAILED rung. The ladder tries a smaller
   * canvas, and if every rung fails the caller says so out loud.
   */
  if (blob.type !== 'image/webp') return null;
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
    /**
     * EVERY RUNG FAILED — AND THE SERVER WILL DO IT INSTEAD.
     *
     * This is now a shrink, not a conversion. `env.IMAGES` converts on the
     * server for every device and every browser alike, so a canvas that cannot
     * encode WebP is no longer a reason anybody's upload fails: the original
     * travels and comes back WebP.
     *
     * What the browser pass is still FOR is the uplink. A 12 MB camera JPEG on
     * Iraqi mobile data is a minute of waiting before the server ever sees it,
     * and this pass makes that 400 KB when the device can. When it cannot, the
     * upload is slower and still correct, which is the right way round — the
     * previous version of this line threw, and made the owner's own phone the
     * reason a product could not get a photo.
     */
    return { blob: file, width: decoded.width, height: decoded.height };
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
 * PNG/JPEG are optimised before upload when the browser provides a usable
 * encoder. A browser that cannot encode WebP may return PNG/JPEG or the
 * original file; the upload endpoint validates those bytes server-side.
 * GIF/AVIF/video are left alone because converting them can destroy motion.
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

/**
 * THE CEILING EACH KIND OF PICTURE DESERVES.
 *
 * Until now only `product` and `avatar` were converted at all: a photograph
 * sent in a chat, a payment receipt and a merchant's community image were
 * stored exactly as the phone produced them — several megabytes of camera
 * JPEG each. The owner asked for «جميع الصور بدون استثناء», and this is the
 * table that makes that true.
 *
 * A chat photo and a receipt are read at screen size and never printed, so
 * 2048 is generous. An avatar's largest box is a profile hero.
 */
export const UPLOAD_MAX_EDGE: Record<string, number> = {
  product: PRODUCT_IMAGE_MAX_EDGE,
  avatar: AVATAR_IMAGE_MAX_EDGE,
  chat: 2_048,
  receipt: 2_048,
  community: 2_048,
  // A ticket attachment is read at the same size a chat attachment is — inside
  // a bubble, on a phone — and it is the evidence for a complaint, so it gets
  // the conversation edge rather than the catalogue's.
  support: 2_048,
  // A complaint's evidence is read the same way, in the same kind of thread.
  complaint: 2_048,
};

/**
 * Prepare ANY upload, whatever it is for. One door, so a new purpose cannot be
 * added without deciding what its pictures should weigh — and cannot silently
 * default to "store whatever the camera produced", which is how three of the
 * five purposes ended up unconverted.
 */
export async function prepareUploadImage(file: File, purpose: string): Promise<PreparedProductImage> {
  const edge = UPLOAD_MAX_EDGE[purpose] ?? PRODUCT_IMAGE_MAX_EDGE;
  return prepareProductImage(file, (f) => encodeProductRasterAsWebp(f, edge));
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function prepareProductImage(file: File, encoder: WebpEncoder = encodeProductRasterAsWebp): Promise<PreparedProductImage> {
  const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());

  // Prefer the optimised result. When the runtime has no WebP encoder, the
  // encoder may safely return PNG/JPEG or the original itself; the 8 MB
  // ceiling still applies to the bytes that actually travel.
  if (detectConvertibleRaster(signature)) {
    if (file.size > PRODUCT_IMAGE_MAX_SOURCE_BYTES) {
      throw new Error(
        `الملف ${megabytes(file.size)} — أكبر من أن يُفتح (الحد ${megabytes(PRODUCT_IMAGE_MAX_SOURCE_BYTES)}) / source file too large`
      );
    }
    const result = await encoder(file);
    const mime = result.blob.type || file.type || (detectConvertibleRaster(signature) === 'jpeg' ? 'image/jpeg' : 'image/png');
    const sameBytes = result.blob === file;
    return {
      file: sameBytes
        ? file
        : new File([result.blob], rasterFilename(file.name, mime), { type: mime, lastModified: file.lastModified }),
      converted: !sameBytes,
      width: result.width,
      height: result.height,
    };
  }

  /**
   * Everything else travels exactly as picked — GIF and AVIF are deliberately
   * not re-encoded, and MP4 is not an image at all — so for these the ceiling
   * really is the ceiling.
   *
   * THE GIF EXCEPTION IS A DECISION, NOT AN OVERSIGHT. A canvas can only draw
   * ONE frame, so "converting" an animated GIF to WebP would silently throw the
   * animation away and hand back a still picture — the same class of quiet
   * damage as the fake conversion this file was just fixed for. AVIF is already
   * a modern compressed format and arrives from vendor CDNs rather than from a
   * camera. Both are stored honestly under their own type.
   */
  const limit = passthroughLimit(signature);
  if (file.size > limit) {
    throw new Error(`الملف ${megabytes(file.size)} — الحد ${megabytes(limit)} / file exceeds the limit`);
  }
  return { file, converted: false };
}
