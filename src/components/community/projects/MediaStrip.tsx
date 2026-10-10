/**
 * THE PICTURES OF A PROJECT, ONE AT A TIME — a native snap strip.
 *
 * The browser scrolls it (`snap-x snap-mandatory`), so a flick behaves like
 * every other strip on the phone; a mouse gets the rail's drag and arrows
 * (src/lib/useRail.ts). The active dot is one element that moves between
 * slots with the app's `move` spring, not N dots toggling. A video plays on
 * tap, muted and inline, and pauses when it scrolls out of view; nothing
 * autoplays and nothing preloads more than its poster frame.
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Play } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMotion } from '../../../lib/motion';
import { useRail } from '../../../lib/useRail';
import type { PostMedia } from './api';

export default function MediaStrip({ media, title }: { media: PostMedia[]; title: string }) {
  const { loc, dir } = useLanguage();
  const m = useMotion();
  const rail = useRail({ snap: true });
  const [active, setActive] = useState(0);
  const el = useRef<HTMLDivElement | null>(null);
  const setRef = (node: HTMLDivElement | null) => {
    el.current = node;
    rail.ref(node);
  };

  // Which slide is under the viewport's centre — read on scroll, passively.
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onScroll = () => {
      const centre = node.scrollLeft + node.clientWidth / 2;
      let best = 0;
      let bestDist = Infinity;
      Array.from(node.children).forEach((child, i) => {
        const c = child as HTMLElement;
        const mid = c.offsetLeft + c.offsetWidth / 2;
        const d = Math.abs(mid - centre);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      setActive(best);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [media.length]);

  if (media.length === 0) return null;
  const single = media.length === 1;
  const portrait = single && (media[0].height ?? 0) > (media[0].width ?? 1);
  const ratio = portrait ? 'aspect-[4/5]' : 'aspect-[4/3]';
  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;

  return (
    <figure className="relative -mx-4 sm:mx-0">
      <div
        ref={setRef}
        role="group"
        aria-roledescription={loc('شريط صور', 'carousel', 'شریتی وێنە')}
        aria-label={title}
        className={`flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain hide-scrollbar sm:rounded-xl ${single ? '' : 'gap-1'}`}
      >
        {media.map((item, i) => (
          <div key={item.id} className={`relative w-full shrink-0 snap-center overflow-hidden bg-surface-selected ${ratio}`} aria-roledescription={loc('شريحة', 'slide', 'سلاید')} aria-label={`${i + 1} / ${media.length}`}>
            {item.kind === 'video' ? (
              <Video src={item.url} visible={i === active} />
            ) : (
              <img
                src={item.url}
                alt={i === 0 ? title : ''}
                loading={i === 0 ? 'eager' : 'lazy'}
                decoding="async"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
            )}
          </div>
        ))}
      </div>

      {!single && (
        <>
          {/* the dots: one moving indicator over fixed slots */}
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <div className="relative flex gap-1.5 rounded-full bg-onyx/55 px-2 py-1.5">
              {media.map((item, i) => (
                <span key={item.id} className="relative h-[5px] w-[5px] rounded-full bg-white/40">
                  {i === active && (
                    <motion.span
                      layoutId="project-media-dot"
                      transition={m.spring('move')}
                      className="absolute inset-0 rounded-full bg-snow"
                    />
                  )}
                </span>
              ))}
            </div>
          </div>
          {/* arrows for a pointer; a finger has the strip itself */}
          <button
            type="button"
            aria-label={loc('السابقة', 'Previous', 'پێشوو')}
            onClick={() => rail.page(-1)}
            className="absolute start-2 top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-onyx/55 text-snow transition-colors hover:bg-onyx/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:flex"
          >
            <Prev aria-hidden="true" className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label={loc('التالية', 'Next', 'دواتر')}
            onClick={() => rail.page(1)}
            className="absolute end-2 top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-onyx/55 text-snow transition-colors hover:bg-onyx/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:flex"
          >
            <Next aria-hidden="true" className="h-5 w-5" />
          </button>
        </>
      )}
    </figure>
  );
}

/** Tap to play; pauses when it leaves the active slot. */
function Video({ src, visible }: { src: string; visible: boolean }) {
  const { loc } = useLanguage();
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!visible && ref.current && !ref.current.paused) {
      ref.current.pause();
    }
  }, [visible]);
  return (
    <div className="relative h-full w-full">
      <video
        ref={ref}
        src={src}
        preload="metadata"
        playsInline
        muted
        loop
        controls={playing}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="h-full w-full object-cover"
      />
      {!playing && (
        <button
          type="button"
          aria-label={loc('تشغيل الفيديو', 'Play video', 'ڤیدیۆکە لێبدە')}
          onClick={() => void ref.current?.play()}
          className="press-scale absolute inset-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        >
          <span className="flex size-14 items-center justify-center rounded-full bg-onyx/65 text-snow">
            <Play aria-hidden="true" className="h-6 w-6 fill-current" />
          </span>
        </button>
      )}
    </div>
  );
}
