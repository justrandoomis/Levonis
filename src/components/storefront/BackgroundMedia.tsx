/**
 * THE PAGE BACKGROUND (storefront L4, P5) — the merchant's picture, GIF or
 * video behind the store's blocks, and the rules for when a video may play.
 *
 * WHAT PAINTS. The still always: the image itself for `kind: 'image'` (a GIF
 * included), the poster for `kind: 'video'` — it is what phones, reduced
 * motion and Save-Data see, and what every page paints first. Over it, the dim (one of three
 * overlay classes, theme.ts `dimClass`). The VIDEO is a separate, lazy piece
 * (./StoreVideo.tsx, its own tiny chunk): it mounts only on the live page, only
 * after the browser is idle, and only when `backgroundVideoAllowed` says so —
 * never under reduced motion or Save-Data, and on a phone only when the
 * merchant ticked «phones» (docs/MERCHANT_PLATFORM_V2.md storefront §5; the
 * weight audit, worker/lib/storeSpeed.ts, reads the same rule).
 *
 * ONE <video> AT A TIME. A store page mounts at most one of its hero /
 * background videos: the hero's, once the visitor starts it (`setHeroPlaying`,
 * synchronous on the tap, so the background's video leaves in the same
 * render), else the background's. The video BLOCK is its own thing (controls,
 * metadata only) and is not part of this.
 *
 * WHERE IT SITS. On the live page the layer is `fixed` to the viewport — the
 * picture stays while the page scrolls past it. In the builder's preview the
 * canvas is a transformed box (PreviewCanvas.tsx), inside which `fixed` would
 * cover the whole page height; there the layer is `absolute` over the page and
 * its picture `sticky` at the canvas's top, which reads the same.
 *
 * THIS FILE IS ITS OWN LAZY CHUNK (the storefront's 47 KB budget,
 * tests/bundleBudget.test.ts): ./BackgroundLayer.tsx is the small door the
 * renderer and the hero import, and it fetches this module only for a page
 * that has a background or a hero video. Everything here is positioned over
 * or behind the blocks — nothing in the page's flow moves when it arrives.
 * The video, its fade and its element are a second, tiny lazy piece
 * (./StoreVideo.tsx) — not the non-classic blocks' chunk, which a classic page
 * with a background video would otherwise fetch just to play it.
 */
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Play, Square } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { mediaSrc } from '../../../packages/storeLayout/src/refs';
import type { StoreBackground } from '../../../packages/storeLayout/src/schema';
import { useStorefrontRuntime } from './runtime';
import { storefrontStrings } from './strings';
import { dimClass } from './theme';
import { Column } from './parts';

const StoreVideo = lazy(() => import('./StoreVideo'));

// ------------------------------------------------------------ environment

/** What the visitor's device says about moving pictures. */
export interface MediaEnv {
  /** `prefers-reduced-motion: reduce`. */
  reduced: boolean;
  /** `navigator.connection.saveData` — the visitor asked for lighter pages. */
  saveData: boolean;
  /** The page is at least 48rem wide (the renderer's own phone/desktop line). */
  wide: boolean;
}

/**
 * Before the first effect runs (and on the server) the most careful answer:
 * no video. A video is only ever mounted by the client, after it has read the
 * device — so the first paint of every page is the still.
 */
export const CAREFUL_ENV: MediaEnv = { reduced: true, saveData: true, wide: false };

type Connection = { saveData?: boolean; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };

/** Reads the device once mounted, and follows its changes (a rotated tablet, a toggled setting). */
export function useMediaEnv(): MediaEnv {
  const [env, setEnv] = useState<MediaEnv>(CAREFUL_ENV);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = (q: string) => (typeof window.matchMedia === 'function' ? window.matchMedia(q) : null);
    const motion = mq('(prefers-reduced-motion: reduce)');
    const width = mq('(min-width: 48rem)');
    const conn = (navigator as Navigator & { connection?: Connection }).connection;
    const read = () => setEnv({ reduced: !!motion?.matches, saveData: conn?.saveData === true, wide: !!width?.matches });
    read();
    motion?.addEventListener?.('change', read);
    width?.addEventListener?.('change', read);
    conn?.addEventListener?.('change', read);
    return () => {
      motion?.removeEventListener?.('change', read);
      width?.removeEventListener?.('change', read);
      conn?.removeEventListener?.('change', read);
    };
  }, []);
  return env;
}

/** The background's video may play: never under reduced motion or Save-Data; on a phone only when the merchant allowed it. */
export function backgroundVideoAllowed(env: MediaEnv, phones: boolean): boolean {
  return !env.reduced && !env.saveData && (env.wide || phones === true);
}

/**
 * A GIF MOVES TOO (review 2026-09-30). The builder invites «صورة أو GIF
 * متحرك» for the background, and a GIF painted as a plain <img> kept moving
 * under reduced motion, under Save-Data and on phones, with no stop control.
 * An image background whose file is a GIF is therefore MOVING MEDIA under the
 * video's own rule (`backgroundVideoAllowed`), with the same «stop».
 */
export function isAnimatedBackground(background: Pick<StoreBackground, 'kind' | 'media'>): boolean {
  return background.kind === 'image' && /\.gif$/i.test(String(background.media ?? ''));
}

/** The hero's video may be offered (tap to play): the same rule, with the hero's own `video_on_phone`. */
export function heroVideoAllowed(env: MediaEnv, onPhone: boolean): boolean {
  return !env.reduced && !env.saveData && (env.wide || onPhone === true);
}

/** True once the browser is idle (or after 1.5 s where it cannot say), from the moment `enabled` is. */
export function useIdle(enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!enabled || idle) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setIdle(true), { timeout: 4000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(() => setIdle(true), 1500);
    return () => window.clearTimeout(t);
  }, [enabled, idle]);
  return idle;
}

// ------------------------------------------------------- one video at a time

let heroPlaying = false;
const listeners = new Set<() => void>();

/** The visitor started (true) or stopped (false) the hero's video; the background's video yields while it plays. */
export function setHeroPlaying(on: boolean): void {
  if (heroPlaying === on) return;
  heroPlaying = on;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/**
 * THE ONE-VIDEO RULE, as data: which of the page's two videos may be mounted
 * now. The hero's only once the visitor started it (and only where it is
 * offered); the background's only where it may move, while the hero's is not
 * playing and the visitor has not stopped it. Never both.
 */
export function videosToMount(s: { heroOffered: boolean; heroPlaying: boolean; backgroundAllowed: boolean; backgroundStopped: boolean }): { hero: boolean; background: boolean } {
  const hero = s.heroOffered && s.heroPlaying;
  return { hero, background: !hero && !s.heroPlaying && s.backgroundAllowed && !s.backgroundStopped };
}

export function useHeroPlaying(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => heroPlaying,
    () => false
  );
}

// ------------------------------------------------------------- hero video

/**
 * THE HERO'S VIDEO (storefront L3): the cover is its poster and stays the
 * page's first paint; the video is offered with a play control over the
 * picture and plays inline, muted, when the visitor taps it — never on its own
 * on the store page (DECISIONS row 170). Offered only on the live page, never
 * under reduced motion or Save-Data, and on a phone only when the merchant set
 * `video_on_phone`; otherwise the cover is all there is. In the builder's
 * preview the control is drawn, inert, so the merchant sees where it sits.
 *
 * Two pieces, because they sit at two depths of the picture: the STAGE right
 * over the cover image (under the cover's fade and its words), the BUTTON on
 * top of everything, at the picture's top right (clear of the header's ⋯, and
 * of the profile's avatar, which is anchored left in every language).
 */
function useHeroOffer(video: string, onPhone: boolean) {
  const rt = useStorefrontRuntime();
  const env = useMediaEnv();
  const src = mediaSrc(video, 'video');
  const live = rt.mode === 'live';
  return { src, live, offered: live && !!src && heroVideoAllowed(env, onPhone) };
}

export function HeroVideoStage({ video, poster, onPhone }: { video: string; poster: string; onPhone: boolean }) {
  const { src, offered } = useHeroOffer(video, onPhone);
  const playing = useHeroPlaying();
  if (!offered || !playing) return null;
  return (
    <Suspense fallback={null}>
      <StoreVideo src={src} poster={poster} loop />
    </Suspense>
  );
}

const GLYPH = 'absolute top-12 end-3 size-11 rounded-full bg-black/60 text-snow flex items-center justify-center';

export function HeroVideoButton({ video, onPhone }: { video: string; onPhone: boolean }) {
  const { src, live, offered } = useHeroOffer(video, onPhone);
  const playing = useHeroPlaying();
  const { lang } = useLanguage();
  const s = storefrontStrings(lang).media;
  // The device changed under a playing video (reduced motion switched on, the window narrowed): stop it.
  useEffect(() => {
    if (playing && !offered && live) setHeroPlaying(false);
  }, [playing, offered, live]);
  // Leaving the page stops it, so the next store opens on its still.
  useEffect(() => () => setHeroPlaying(false), []);
  if (!src) return null;
  if (!live) {
    return (
      <div dir="ltr" aria-hidden="true" className="absolute inset-0 pointer-events-none" data-hero-video="preview">
        <span className={GLYPH}>
          <Play className="w-4 h-4 fill-current" strokeWidth={1.75} />
        </span>
      </div>
    );
  }
  if (!offered) return null;
  // ONE mechanism (review 2026-09-30): the label says what a press does, so the
  // button carries no `aria-pressed` beside it — «Play …, pressed» contradicted itself.
  const label = playing ? s.stopVideo : s.playVideo;
  return (
    // `dir="ltr"`: `end-3` is the picture's physical right in every language.
    <div dir="ltr" className="absolute inset-0 pointer-events-none" data-hero-video={playing ? 'playing' : 'still'}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => setHeroPlaying(!playing)}
        className={`${GLYPH} pointer-events-auto press-scale focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      >
        {playing ? <Square className="w-3.5 h-3.5 fill-current" strokeWidth={1.75} aria-hidden="true" /> : <Play className="w-4 h-4 fill-current" strokeWidth={1.75} aria-hidden="true" />}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ layer

/**
 * Whether the page background's video may move now: the live page, a video
 * background, a device that allows it — and then the one-video rule decides
 * against the hero's and the visitor's «stop».
 */
function useBackgroundVideo(background: StoreBackground, stopped: boolean) {
  const rt = useStorefrontRuntime();
  const env = useMediaEnv();
  const heroPlaying = useHeroPlaying();
  const live = rt.mode === 'live';
  const animates = background.kind === 'video' || isAnimatedBackground(background);
  const moving = live && animates && backgroundVideoAllowed(env, background.phones);
  const mount = videosToMount({ heroOffered: live, heroPlaying, backgroundAllowed: moving, backgroundStopped: stopped });
  return { live, moving, heroPlaying, mount: mount.background, saveData: env.saveData };
}

/**
 * A GIF'S FIRST FRAME, STILL: the file drawn once into a canvas, which does
 * not animate. What reduced motion, a phone and a stopped background see of a
 * GIF when the merchant gave it no still of its own (`poster`).
 */
function GifStill({ src }: { src: string }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const c = canvas.current;
      if (!c || !img.naturalWidth) return;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src]);
  return <canvas ref={canvas} className="w-full h-full object-cover" data-sf-background-still="" />;
}

export function BackgroundLayer({ background, stopped }: { background: StoreBackground; stopped: boolean }) {
  const { live, mount, saveData } = useBackgroundVideo(background, stopped);
  const isVideo = background.kind === 'video';
  const gif = isAnimatedBackground(background);
  // A GIF moves only where a video may (and not once stopped); else its still: the poster the
  // merchant gave, or its first frame — and under Save-Data nothing is fetched for it at all.
  const gifStill = live && gif && !mount;
  const still = mediaSrc(isVideo || gifStill ? background.poster : background.media);
  const clip = isVideo ? mediaSrc(background.media, 'video') : '';
  const wanted = live && mount && !!clip;
  const idle = useIdle(wanted);
  const frame = gifStill && !still && !saveData ? mediaSrc(background.media) : '';
  return (
    <div aria-hidden="true" data-sf-background={background.kind} className={`${live ? 'fixed' : 'absolute'} inset-0 z-0 pointer-events-none`}>
      <div className={live ? 'relative h-full w-full' : 'sticky top-0 h-dvh max-h-full w-full'}>
        {still && <img src={still} alt="" className="w-full h-full object-cover" loading="eager" decoding="async" />}
        {frame && <GifStill src={frame} />}
        {wanted && idle && (
          <Suspense fallback={null}>
            <StoreVideo src={clip} poster={still} loop />
          </Suspense>
        )}
        <div className={`absolute inset-0 ${dimClass(background.dim)}`} />
      </div>
    </div>
  );
}

/**
 * «إيقاف حركة الخلفية» (WCAG 2.2.2): a moving background — a video, or a GIF —
 * can be stopped — at the page's end, where it covers nothing, and only while
 * it may move (not while the hero's video plays, when the background has
 * already yielded).
 */
export function BackgroundToggle({ background, stopped, onToggle }: { background: StoreBackground; stopped: boolean; onToggle: () => void }) {
  const { moving, heroPlaying } = useBackgroundVideo(background, stopped);
  const { lang } = useLanguage();
  if (!moving || heroPlaying) return null;
  const words = storefrontStrings(lang).media;
  return (
    <Column className="mt-4 flex justify-center">
      {/* The words say what a press does; no `aria-pressed` beside them (one mechanism). */}
      <button
        type="button"
        onClick={onToggle}
        className="min-h-11 rounded-full sf-bg border border-white/10 px-4 text-[12px] text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        data-store-bg-toggle=""
      >
        {stopped ? words.playBackground : words.stopBackground}
      </button>
    </Column>
  );
}
