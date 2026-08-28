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

  const retry = (e: React.MouseEvent) => {
    // Cards are often wrapped in a <Link>; retrying must not navigate.
    e.preventDefault();
    e.stopPropagation();
    setStatus('loading');
    setAttempt((a) => a + 1);
  };

  const aspectCls = aspect === 'square' ? 'aspect-square' : aspect === 'video' ? 'aspect-video' : '';
  const showFallback = !cleanSrc || status === 'error';

  return (
    <div className={`relative overflow-hidden ${aspectCls} ${bgClassName} ${className}`}>
      {cleanSrc && status !== 'error' && (
        <img
          key={`${cleanSrc}#${attempt}`}
          ref={imgRef}
          src={cleanSrc}
          alt={alt}
          referrerPolicy={referrerPolicy}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={eager ? 'high' : 'auto'}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
          className={`absolute inset-0 w-full h-full ${
            fit === 'contain' ? 'object-contain' : 'object-cover'
          } transition-opacity duration-300 ${status === 'loaded' ? 'opacity-100' : 'opacity-0'} ${imgClassName}`}
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
