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

/** The cap as the owner reads it, so no message hard-codes the number twice. */
export const IMAGE_SOURCE_CAP_MB = IMAGE_SOURCE_CAP / (1024 * 1024);

/** Quality: high enough that a product photo survives a pinch-zoom, low enough
 *  that the file is a fraction of the camera original. */
const WEBP_QUALITY = 85;

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
  | { ok: true; bytes: Uint8Array; mime: 'image/webp' }
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
    const out = new Uint8Array(await result.response().arrayBuffer());
    // A converter that returns nothing has failed, whatever it reported.
    if (out.byteLength === 0) return { ok: false, reason: 'failed', detail: 'the converter returned no bytes' };
    return { ok: true, bytes: out, mime: 'image/webp' };
  } catch (e) {
    return { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
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
