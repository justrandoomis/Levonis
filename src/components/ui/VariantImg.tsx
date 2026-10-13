import type { ImgHTMLAttributes } from 'react';
import { variantSrcSet } from '../../../packages/contracts/src/imageSizing';

/**
 * A PLAIN `<img>` THAT DOWNLOADS A SMALL COPY (owner 2026-10-13: «أريد تحويل
 * الصور كلها وضغطها بتكون بحجم صغير»).
 *
 * The raw-`<img>` twin of `ui/SafeImage`, for the places that draw their own
 * box (a 32 px avatar, a 64 px cart line, a store logo): when `src` is a
 * `/files/` still picture it carries the `srcset` of the server's copies
 * (packages/contracts/src/imageSizing.ts) and the `sizes` the caller states,
 * so the browser fetches the 160 px copy for a 64 px box instead of the
 * stored original. Any other source — a blob preview, a data URI, a GIF,
 * somebody else's URL — is drawn exactly as given.
 *
 * Every other attribute passes through. `naturalWidth` (the stored original's
 * width, from the media JSON) stops the list at the original's own size;
 * `maxVariant` caps a place; `priority` is the page's largest paint (eager,
 * high priority). Otherwise it is lazy and decoded off the main thread.
 * No icons, no strings: it costs a route chunk a few hundred bytes.
 */
export type VariantImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes'> & {
  src?: string | null;
  /** How wide the picture is drawn — CSS px or a preset of IMAGE_SIZES. Required: a srcset without it is a guess. */
  sizes: string;
  naturalWidth?: number | null;
  maxVariant?: number;
  priority?: boolean;
};

export default function VariantImg({ src, sizes, naturalWidth, maxVariant, priority = false, loading, decoding, fetchPriority, alt = '', ...rest }: VariantImgProps) {
  const clean = typeof src === 'string' ? src.trim() : '';
  const srcSet = clean ? variantSrcSet(clean, { width: naturalWidth ?? null, max: maxVariant }) : undefined;
  return (
    <img
      {...rest}
      src={clean || undefined}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      loading={priority ? 'eager' : loading ?? 'lazy'}
      decoding={decoding ?? 'async'}
      fetchPriority={priority ? 'high' : fetchPriority}
    />
  );
}
