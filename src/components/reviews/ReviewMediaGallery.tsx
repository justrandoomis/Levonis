import React, { useRef, useState } from 'react';
import { ImageOff, Play } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { reviewStrings } from './reviewStrings';

/**
 * THE ONE REVIEW MEDIA GALLERY (docs/REVIEWS_GIFTS.md §8 C1) — on the product
 * page, the «my review» card, the profile's reviews, the rated rows of
 * ReviewSheet and the admin's review screens (lane C2 codes against these
 * props; C1 may add optional props, never rename these).
 *
 * Square thumbnails in a 4-column grid on a phone and 6 from `sm` up. Every
 * tile is a button: a photo opens the full-size viewer on that photo, a video
 * opens it on the player. The viewer (`ReviewMediaViewer`) is lazy, so a page
 * of reviews that nobody taps never downloads it.
 *
 * A VIDEO TILE IS NOT A VIDEO. A grid of `<video>` elements would ask the
 * media door for every clip on the page; the tile is a dark square with a
 * play mark, and the bytes move only when the customer presses play in the
 * viewer (`controls playsInline`, never autoplay).
 *
 * `max` caps the thumbnails; the last one shown then says «+N» and opens the
 * viewer there, where every item is reachable. Omitted = all (admin).
 */
export interface ReviewMediaItem {
  url: string;
  kind: 'image' | 'video';
}

export interface ReviewMediaGalleryProps {
  media: ReviewMediaItem[];
  /** Accessible name of the gallery, e.g. «صور المراجعة». */
  label: string;
  /** Thumbnails shown before a «+N» tile; omitted = all (admin). */
  max?: number;
}

const ReviewMediaViewer = React.lazy(() => import('./ReviewMediaViewer'));

export default function ReviewMediaGallery({ media, label, max }: ReviewMediaGalleryProps) {
  const { lang } = useLanguage();
  const s = reviewStrings(lang);
  const list = Array.isArray(media) ? media.filter((m) => m && typeof m.url === 'string' && m.url) : [];
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const tileRef = useRef<HTMLElement | null>(null);
  if (list.length === 0) return null;

  const cap = typeof max === 'number' && max > 0 ? Math.min(max, list.length) : list.length;
  const shown = list.slice(0, cap);
  const hidden = list.length - cap;
  const images = list.filter((m) => m.kind !== 'video');
  const videos = list.filter((m) => m.kind === 'video');

  const open = (i: number, el: HTMLElement) => {
    tileRef.current = el;
    setMounted(true);
    setOpenAt(i);
  };

  return (
    <>
      <ul role="list" aria-label={label} data-review-gallery className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {shown.map((m, i) => {
          const isVideo = m.kind === 'video';
          const nth = isVideo ? videos.indexOf(m) + 1 : images.indexOf(m) + 1;
          const more = i === cap - 1 && hidden > 0;
          const name = more
            ? s.showMore(hidden)
            : isVideo
              ? s.playVideo(nth, videos.length)
              : s.openPhoto(nth, images.length);
          return (
            <li key={`${m.url}-${i}`} className="relative">
              <button
                type="button"
                onClick={(e) => open(i, e.currentTarget)}
                aria-label={name}
                data-media-kind={m.kind}
                className="relative block aspect-square w-full overflow-hidden rounded-xl border border-border-subtle bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {isVideo ? (
                  <span className="flex h-full w-full items-center justify-center bg-black" aria-hidden>
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white ring-1 ring-white/10">
                      <Play className="h-4 w-4" fill="currentColor" aria-hidden />
                    </span>
                  </span>
                ) : broken[m.url] ? (
                  <span className="flex h-full w-full items-center justify-center text-text-muted" aria-hidden>
                    <ImageOff className="h-5 w-5" aria-hidden />
                  </span>
                ) : (
                  <img
                    src={m.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => setBroken((b) => ({ ...b, [m.url]: true }))}
                    className="h-full w-full object-cover"
                  />
                )}
                {more && (
                  <span
                    aria-hidden
                    className="absolute inset-0 flex items-center justify-center bg-black/60 text-[15px] font-bold text-white tabular-nums"
                    dir="ltr"
                  >
                    +{hidden}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {mounted && (
        <React.Suspense fallback={null}>
          <ReviewMediaViewer
            open={openAt !== null}
            onClose={() => setOpenAt(null)}
            media={list}
            index={openAt ?? 0}
            anchor={tileRef}
            label={label}
          />
        </React.Suspense>
      )}
    </>
  );
}
