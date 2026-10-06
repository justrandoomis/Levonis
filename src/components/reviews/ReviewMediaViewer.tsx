/**
 * THE FULL-SIZE VIEWER OF A REVIEW'S PHOTOS AND VIDEOS — lazy, loaded on the
 * first tap of a gallery or picker tile, never part of a page's first paint.
 *
 * It is the product page's own photo viewer (src/pages/Product.tsx, «THE PHOTO
 * VIEWER»): `Overlay`, `solid` so nothing tinted sits behind a customer's
 * photo, scaled out of the tile that was tapped and back into it, a 44 px close
 * button, the scrim and Escape close it. Pinch zoom stays the browser's.
 *
 * VIDEO NEVER PLAYS BY ITSELF. `controls playsInline preload="metadata"` and no
 * autoplay: the customer presses play, with sound, and only the slide on
 * screen exists, so leaving a video's slide stops it.
 *
 * Several items: previous / next (44 px), the arrow keys in the reading
 * direction, and a horizontal swipe over a photo (never over a video, whose
 * scrubber owns that gesture). «3 / 7» is a Latin island.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Overlay } from '../ui/Overlay';
import { reviewStrings } from './reviewStrings';
import type { ReviewMediaItem } from './ReviewMediaGallery';

export interface ReviewMediaViewerProps {
  open: boolean;
  onClose: () => void;
  media: ReviewMediaItem[];
  /** The item shown on opening. */
  index: number;
  /** The tile it opened from, so it scales out of it. */
  anchor?: React.RefObject<HTMLElement | null>;
  label?: string;
}

const SWIPE_PX = 48;

export default function ReviewMediaViewer({ open, onClose, media, index, anchor, label }: ReviewMediaViewerProps) {
  const { lang, dir } = useLanguage();
  const s = reviewStrings(lang);
  const n = media.length;
  const [at, setAt] = useState(index);
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);

  // Every opening starts on the tile that was tapped.
  useEffect(() => {
    if (open) setAt(Math.max(0, Math.min(n - 1, index)));
  }, [open, index, n]);

  const go = (step: number) => {
    if (n < 2) return;
    setAt((i) => (i + step + n) % n);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // In Arabic and Sorani the next item is to the LEFT.
    const next = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const prev = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === next) go(1);
    else if (e.key === prev) go(-1);
    else return;
    e.preventDefault();
  };

  const item = n > 0 ? media[Math.max(0, Math.min(n - 1, at))] : null;
  const PrevIcon = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const NextIcon = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const roundBtn =
    'inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  return (
    <Overlay
      open={open && !!item}
      onClose={onClose}
      label={label || s.viewerLabel}
      anchor={anchor}
      solid
      z={230}
      testId="review-media-viewer"
      panelClassName="bg-black max-w-full max-h-[calc(100dvh-2rem)] overflow-hidden"
    >
      {() =>
        item ? (
          <div className="relative" onKeyDown={onKeyDown} data-review-viewer data-at={at}>
            {item.kind === 'video' ? (
              <video
                key={item.url}
                src={item.url}
                controls
                playsInline
                preload="metadata"
                data-review-video
                className="block bg-black"
                style={{ width: 'min(calc(100vw - 2rem), 960px)', maxHeight: 'calc(100dvh - 2rem)' }}
              />
            ) : broken[item.url] ? (
              <div className="flex flex-col items-center justify-center gap-2 p-8 text-snow/60" style={{ width: 'min(calc(100vw - 2rem), 480px)' }}>
                <ImageOff className="h-8 w-8" aria-hidden />
                <span className="text-[13px]">{s.imageFailed}</span>
              </div>
            ) : (
              <img
                key={item.url}
                src={item.url}
                alt={s.photoN(at + 1, n)}
                referrerPolicy="no-referrer"
                decoding="async"
                onError={() => setBroken((b) => ({ ...b, [item.url]: true }))}
                onPointerDown={(e) => {
                  swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
                }}
                onPointerUp={(e) => {
                  const st = swipe.current;
                  swipe.current = null;
                  if (!st || st.id !== e.pointerId) return;
                  const dx = e.clientX - st.x;
                  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(e.clientY - st.y)) return;
                  // A swipe toward the reading start shows the next item.
                  const towardStart = dir === 'rtl' ? dx > 0 : dx < 0;
                  go(towardStart ? 1 : -1);
                }}
                className="block max-w-full max-h-[calc(100dvh-2rem)] object-contain select-none"
                draggable={false}
              />
            )}

            <button type="button" onClick={onClose} aria-label={s.close} data-viewer-close className={`absolute top-3 end-3 z-10 ${roundBtn}`}>
              <X className="h-5 w-5" aria-hidden />
            </button>

            {n > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => go(-1)}
                  aria-label={s.prev}
                  data-viewer-prev
                  className={`absolute start-2 z-10 ${roundBtn}`}
                  style={{ top: '50%', transform: 'translateY(-50%)' }}
                >
                  <PrevIcon className="h-5 w-5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  aria-label={s.next}
                  data-viewer-next
                  className={`absolute end-2 z-10 ${roundBtn}`}
                  style={{ top: '50%', transform: 'translateY(-50%)' }}
                >
                  <NextIcon className="h-5 w-5" aria-hidden />
                </button>
                <span
                  dir="ltr"
                  aria-live="polite"
                  data-viewer-count
                  className="pointer-events-none absolute top-3 start-3 z-10 rounded-full bg-black/70 px-2.5 py-1 text-[12px] font-bold text-white tabular-nums"
                >
                  {at + 1} / {n}
                </span>
              </>
            )}
          </div>
        ) : null
      }
    </Overlay>
  );
}
