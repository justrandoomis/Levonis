/**
 * THE DOOR TO THE STORE PAGE'S MOVING MEDIA (storefront L3/L4, P5) — the page
 * background and the hero's video, as the renderer and the hero import them.
 *
 * The pieces themselves are ./BackgroundMedia.tsx, ONE LAZY CHUNK: the store
 * pages are held to 47 KB gzip beyond the first paint
 * (tests/bundleBudget.test.ts), and a page with neither a background nor a
 * hero video never downloads a byte of it. What stays in the storefront chunk
 * is this file: four lazy wrappers, each fetching the chunk only when it has
 * something to draw. Nothing here sits in the page's flow — the layer is
 * behind the blocks, the hero's pieces over its picture, the «stop» control
 * after the footer — so nothing moves when the chunk arrives; until then the
 * page is its blocks on the theme's own ground (StoreRenderer carding them).
 *
 * The rules (when a video may play, one <video> at a time) and their reasons
 * are written where they are kept: ./BackgroundMedia.tsx.
 */
import { lazy, Suspense } from 'react';
import type { StoreBackground } from '../../../packages/storeLayout/src/schema';

const media = () => import('./BackgroundMedia');
const Layer = lazy(() => media().then((m) => ({ default: m.BackgroundLayer })));
const Toggle = lazy(() => media().then((m) => ({ default: m.BackgroundToggle })));
const Stage = lazy(() => media().then((m) => ({ default: m.HeroVideoStage })));
const Glyph = lazy(() => media().then((m) => ({ default: m.HeroVideoButton })));

/** The page background: the still, its dim, and — where it may move — its video. */
export default function BackgroundLayer({ background, stopped }: { background: StoreBackground; stopped: boolean }) {
  return (
    <Suspense fallback={null}>
      <Layer background={background} stopped={stopped} />
    </Suspense>
  );
}

/** «إيقاف حركة الخلفية» — drawn only while a moving background (a video, or a GIF) may move. */
export function BackgroundToggle(props: { background: StoreBackground; stopped: boolean; onToggle: () => void }) {
  if (props.background.kind !== 'video' && !(props.background.kind === 'image' && /\.gif$/i.test(String(props.background.media ?? '')))) return null;
  return (
    <Suspense fallback={null}>
      <Toggle {...props} />
    </Suspense>
  );
}

/** The hero's video over its cover, once the visitor starts it. A hero without one fetches nothing. */
export function HeroVideoStage(props: { video: string; poster: string; onPhone: boolean }) {
  if (!props.video) return null;
  return (
    <Suspense fallback={null}>
      <Stage {...props} />
    </Suspense>
  );
}

/** The hero's play control (inert in the builder's preview). A hero without a video fetches nothing. */
export function HeroVideoButton(props: { video: string; onPhone: boolean }) {
  if (!props.video) return null;
  return (
    <Suspense fallback={null}>
      <Glyph {...props} />
    </Suspense>
  );
}
