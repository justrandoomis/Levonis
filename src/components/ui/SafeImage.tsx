import React, { useEffect, useRef, useState } from 'react';
import { ImageOff, RefreshCw } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * Image with a reserved box so nothing jumps (no CLS), lazy loading by
 * default, a subtle pulse while pending, and an EXPLICIT fallback — an image
 * that fails, or a product with no image at all (the "empty image card"
 * case), shows an icon instead of sitting as an empty box forever. A failed
 * image also offers a retry tap that re-requests the same URL.
 */

const STRINGS = {
  ar: { failed: 'تعذر تحميل الصورة', retry: 'إعادة تحميل الصورة', noImage: 'لا توجد صورة' },
  en: { failed: 'Image failed to load', retry: 'Reload image', noImage: 'No image' },
  ckb: { failed: 'وێنەکە بارنەبوو', retry: 'دووبارە بارکردنی وێنە', noImage: 'وێنە نییە' },
} as const;

/**
 * THE WIDTHS THE SERVER WILL CUT — `GET /files/<key>?w=` answers exactly
 * these (worker/lib/imageConvert.ts IMAGE_VARIANT_WIDTHS; the two lists are
 * pinned equal by tests/imageVariants.test.ts). A card that says how wide it
 * is (`sizes`) lets the browser pick the smallest that covers its pixels,
 * in the format it decodes best (AVIF/WebP by `Accept`), instead of the
 * 3000 px file the camera produced.
 */
export const IMAGE_VARIANT_WIDTHS = [160, 320, 480, 640, 1080] as const;

/** A same-origin `/files/` still picture with no query of its own — the only source a variant can be cut from. */
const VARIANT_SOURCE = /^(?:https?:\/\/[^/?#]+)?\/files\/[^?#]+\.(?:webp|jpe?g|png)$/i;

/**
 * The `srcset` for a `/files/` picture, or undefined when the source is
 * anything else (an external URL, a GIF, a data URI, a URL that already
 * carries a query) — those pass through exactly as before. `src` stays the
 * original: it is the fallback candidate and the address every other reader
 * (the document's image preload, the compare tray) still names.
 */
export function variantSrcSet(src: string): string | undefined {
  if (!VARIANT_SOURCE.test(src)) return undefined;
  return IMAGE_VARIANT_WIDTHS.map((w) => `${src}?w=${w} ${w}w`).join(', ');
}

export default function SafeImage({
  src,
  alt = '',
  aspect = 'auto',
  fit = 'cover',
  eager = false,
  className = '',
  imgClassName = '',
  bgClassName = 'bg-zinc-900',
  fallbackClassName = 'text-zinc-600',
  fallbackIconClassName = 'w-6 h-6',
  referrerPolicy = 'no-referrer',
  sizes,
  onStatus,
}: {
  src?: string | null;
  alt?: string;
  /** 'square' | 'video' reserve their own ratio; 'auto' fills a parent-sized wrapper (pass w/h via className). */
  aspect?: 'square' | 'video' | 'auto';
  fit?: 'cover' | 'contain';
  /** Above-the-fold/LCP images: eager load + high fetch priority. Default lazy. */
  eager?: boolean;
  className?: string;
  imgClassName?: string;
  bgClassName?: string;
  fallbackClassName?: string;
  fallbackIconClassName?: string;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
  /**
   * How wide this picture is drawn, in the `sizes` grammar (`(min-width:
   * 1024px) 20vw, 50vw`). Given, AND when `src` is a `/files/` still image,
   * the element carries a `srcset` of the server's sized variants and the
   * browser downloads the smallest that covers the slot. Opt-in on purpose:
   * a full-bleed hero the document already preloads at its original address
   * (worker/lib/socialPreview.ts) must keep requesting that address, or the
   * preload becomes a second download.
   */
  sizes?: string;
  /**
   * Told whenever this image settles, so a PARENT can act on the fact that a
   * picture is broken. The admin image grid uses it to notice that the primary
   * image no longer loads while a healthy one sits beside it — a thing the
   * customer would see on the product page and the admin would not.
   *
   * It reports, it does not repair: nothing here mutates a caller's state.
   */
  onStatus?: (status: 'loading' | 'loaded' | 'error', src: string) => void;
}) {
  const { lang } = useLanguage();
  const s = STRINGS[lang];
  const cleanSrc = typeof src === 'string' ? src.trim() : '';
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // A new src is a new load — never keep a previous image's state.
  useEffect(() => {
    setStatus('loading');
    setAttempt(0);
  }, [cleanSrc]);

  // Cached images may be complete before the load event handler attaches.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) setStatus('loaded');
  }, [cleanSrc, attempt]);

  // Reported from an effect rather than from the DOM handlers, so a parent
  // that re-renders on the news cannot re-enter setState during React's own
  // event dispatch, and so the cached-image path above reports too.
  useEffect(() => {
    onStatus?.(status, cleanSrc);
    // `onStatus` is deliberately not a dependency: a caller passing an inline
    // arrow would otherwise fire this on every render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, cleanSrc]);

  const retry = (e: React.MouseEvent) => {
    // Cards are often wrapped in a <Link>; retrying must not navigate.
    e.preventDefault();
    e.stopPropagation();
    setStatus('loading');
    setAttempt((a) => a + 1);
  };

  const aspectCls = aspect === 'square' ? 'aspect-square' : aspect === 'video' ? 'aspect-video' : '';
  const showFallback = !cleanSrc || status === 'error';
  const srcSet = sizes && cleanSrc ? variantSrcSet(cleanSrc) : undefined;
  /**
   * NO FADE ON AN EAGER PICTURE. The 300 ms opacity ramp is a courtesy for a
   * lazy card scrolling into view; on the above-the-fold picture it is 300 ms
   * added to the moment the largest paint is complete, on every visit, for
   * nothing the visitor can see happen. Eager images are simply there.
   */
  const revealCls = eager
    ? 'opacity-100'
    : `transition-opacity duration-300 ${status === 'loaded' ? 'opacity-100' : 'opacity-0'}`;

  return (
    <div className={`relative overflow-hidden ${aspectCls} ${bgClassName} ${className}`}>
      {cleanSrc && status !== 'error' && (
        <img
          key={`${cleanSrc}#${attempt}`}
          ref={imgRef}
          src={cleanSrc}
          srcSet={srcSet}
          sizes={srcSet ? sizes : undefined}
          alt={alt}
          referrerPolicy={referrerPolicy}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={eager ? 'high' : 'auto'}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
          className={`absolute inset-0 w-full h-full ${
            fit === 'contain' ? 'object-contain' : 'object-cover'
          } ${revealCls} ${imgClassName}`}
        />
      )}
      {cleanSrc && status === 'loading' && (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-zinc-800/40 animate-pulse motion-reduce:animate-none"
        />
      )}
      {showFallback && (
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center ${fallbackClassName}`}
        >
          <ImageOff aria-hidden="true" className={fallbackIconClassName} />
          <span className="sr-only">{cleanSrc ? s.failed : alt || s.noImage}</span>
          {cleanSrc ? (
            <button
              type="button"
              onClick={retry}
              className="flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 text-current opacity-80 hover:opacity-100 transition-opacity"
            >
              <RefreshCw aria-hidden="true" className="w-4 h-4" />
              <span className="sr-only">{s.retry}</span>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
