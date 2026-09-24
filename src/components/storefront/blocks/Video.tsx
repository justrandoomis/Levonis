/**
 * VIDEO — the merchant's OWN uploaded clip, served from this platform. Never an
 * embed: the CSP allows no third-party frame, and a layout cannot name one.
 * Autoplay is muted and looping, and does not start for a visitor who asked
 * for reduced motion.
 */
import { useEffect, useState } from 'react';
import { mediaSrc } from '../../../../packages/storeLayout/src/refs';
import { BlockHeading, Column, useText } from '../parts';
import type { BlockProps } from '../types';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

export default function VideoBlock({ block }: BlockProps<'video'>) {
  const s = block.settings;
  const text = useText();
  const reduced = usePrefersReducedMotion();
  const src = mediaSrc(s.video, 'video');
  if (!src) return null;
  const poster = mediaSrc(s.poster) || undefined;
  const auto = s.autoplay && !reduced;
  const caption = text(s.caption);
  return (
    <Column>
      <BlockHeading title={text(s.title)} />
      <figure>
        <video
          src={src}
          poster={poster}
          controls
          playsInline
          preload="metadata"
          muted={auto}
          autoPlay={auto}
          loop={auto}
          className="w-full sf-r-lg sf-well aspect-video"
        />
        {caption && (
          <figcaption className="text-zinc-400 text-[12px] mt-2" dir="auto">
            {caption}
          </figcaption>
        )}
      </figure>
    </Column>
  );
}
