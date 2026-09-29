/**
 * MOTION, LOADED WHEN SOMETHING MOVES — the `LazyMotion` seam of the house
 * motion system (docs/MERCHANT_PLATFORM_V2.md §B.1 #6).
 *
 * WHAT WAS WRONG. Every window, toast and popover rendered `motion.div` from
 * `motion/react`. That proxy bundles every feature the library has — the
 * projection tree, drag and pan, layout animation — so the entry chunk's
 * static closure carried 46 KB gzip of animation code that no first screen
 * uses, and parsed it (×4 CPU: ~150 ms) before the first paint.
 *
 * WHAT THIS DOES. The components that are in the entry render `m.*` instead:
 * the same component, with no features of its own. Features arrive through
 * `<MotionFeatures>` — a `LazyMotion` whose bundle (`domMax`, the full set:
 * see ./motionFeaturesBundle.ts) is a dynamic import. Until it has loaded, an
 * `m` element renders at its `initial` values and animates to `animate` the
 * moment the bundle lands; once loaded, every later mount is synchronous
 * (`features` is passed as the bundle itself, not the loader, so there is no
 * state flip and no frame without motion).
 *
 * WHERE IT MOUNTS. Inside each primitive, around the elements it animates —
 * not once at the root. The primitives live in a portal, they open only on a
 * tap, and a provider at the root would request the bundle at boot, which is
 * exactly the moment this file exists to keep clear. `App.tsx` prefetches the
 * bundle from idle (after the home's critical request and the fonts) and on
 * the first pointer, so a window opened by a person almost never waits for
 * it; a window opened before that simply materializes a beat later — and a
 * window opened after the chunk has FAILED paints at rest at once
 * (`useMotionFeaturesFailed`, below).
 *
 * Pages that already render the full `motion.*` proxy (the lazy routes) keep
 * working unchanged: the proxy carries its own features and does not need
 * this provider. `strict` is therefore off — an `m` element and a `motion`
 * element can share a tree.
 */
import React from 'react';
import { LazyMotion, type FeatureBundle } from 'motion/react';

let loaded: FeatureBundle | null = null;
let loading: Promise<FeatureBundle> | null = null;
let failed = false;
const watchers = new Set<() => void>();

function setFailed(next: boolean): void {
  if (failed === next) return;
  failed = next;
  for (const w of watchers) w();
}

/** The bundle, fetched once per page and memoised; a failed fetch is retried on the next ask. */
export function loadMotionFeatures(): Promise<FeatureBundle> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import('./motionFeaturesBundle')
    .then((mod) => {
      loaded = mod.default;
      setFailed(false);
      return loaded;
    })
    .catch((err: unknown) => {
      loading = null;
      setFailed(true);
      throw err;
    });
  return loading;
}

/** Ask for the bundle now, from idle or a first interaction; nothing waits on the answer. */
export function preloadMotionFeatures(): void {
  void loadMotionFeatures().catch(() => {
    // The chunk will be asked for again by the first window that opens; a
    // prefetch that fails is not an error anyone should see.
  });
}

/** For tests and diagnostics: whether the features are already in memory. */
export function motionFeaturesLoaded(): boolean {
  return loaded !== null;
}

const subscribe = (fn: () => void) => {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
};
const readFailed = () => failed;
const readServer = () => false;

/**
 * THE FAILURE PATH (P2 review). An `m` element renders at its `initial`
 * values and waits for the features to drive it to `animate`. When the
 * bundle's chunk cannot be fetched — a deploy between two navigations, a
 * proxy that drops one request, a captive portal — nothing ever drives it: a
 * sheet stays parked below the viewport, a toast at opacity 0, the busy
 * layer swallowing taps while drawing nothing. The person sees nothing
 * happen and cannot tell why.
 *
 * So the primitives ask this hook and, when the bundle has failed, render
 * with `initial={false}`: an `m` element then PAINTS at its `animate`
 * values with no feature bundle at all — the sheet is on screen, the toast
 * readable, the scrim visible — and simply does not animate. The next mount
 * asks for the chunk again (`loadMotionFeatures` retries), and a success
 * clears the flag, so the fallback lasts exactly as long as the outage.
 */
export function useMotionFeaturesFailed(): boolean {
  return React.useSyncExternalStore(subscribe, readFailed, readServer);
}

/**
 * The loader `LazyMotion` is handed: its own `.then` has no catch, so a
 * rejected import would surface as an uncaught error on the page. A failure
 * is recorded for `useMotionFeaturesFailed` and the promise is left pending —
 * `LazyMotion` then never flips, which is the honest state: no features.
 */
function quietLoader(): Promise<FeatureBundle> {
  return loadMotionFeatures().catch(() => new Promise<FeatureBundle>(() => {}));
}

/**
 * Wrap the `m.*` elements of a primitive. Renders children immediately; the
 * animation features attach when the bundle is in memory (at once, after the
 * first load).
 */
export function MotionFeatures({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={loaded ?? quietLoader}>{children}</LazyMotion>;
}
