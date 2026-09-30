/**
 * THE STORE'S MOVING PICTURE (storefront L3/L4, P5) — the hero's video after
 * the visitor's tap, or the page background's once the browser is idle.
 *
 * ITS OWN TINY LAZY CHUNK (review 2026-09-30): it lived in ./blocks/extra.tsx,
 * the non-classic blocks' chunk, so a classic page with a background video
 * fetched those 9 KB of blocks to play it. ./BackgroundMedia.tsx loads this
 * module alone, and only when a video is about to mount — no store visit
 * downloads a video element's code, let alone a video, before it is asked for.
 *
 * Muted, inline, looping, no controls, hidden from assistive technology (the
 * still and the page's words carry the meaning); it fades in over the still
 * only once frames are playing — opacity, never movement — and not at all
 * under reduced motion, where it never mounts (./BackgroundMedia.tsx decides
 * that).
 */
import { useCallback, useState } from 'react';

export default function StoreVideo({ src, poster, loop = true }: { src: string; poster: string; loop?: boolean }) {
  const [shown, setShown] = useState(false);
  // Muted BEFORE play(): browsers allow a video to start on its own only muted.
  const start = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return;
    el.muted = true;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  }, []);
  return (
    <video
      ref={start}
      src={src}
      poster={poster || undefined}
      muted
      loop={loop}
      playsInline
      autoPlay
      preload="auto"
      aria-hidden="true"
      data-store-video=""
      onPlaying={() => setShown(true)}
      className={`absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-150 motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}
