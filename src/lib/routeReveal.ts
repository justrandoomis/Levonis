import React from 'react';

/**
 * A ROUTE WHOSE CODE HAS ARRIVED IS SHOWN NOW — NOT UP TO 300 MS LATER
 * (speed audit 2026-10-16, the lazy-route finding).
 *
 * WHAT WAS MEASURED. Every storefront page except Home is a lazy chunk. On a
 * cold load the first commit is the route's Suspense fallback; when the chunk
 * lands, React re-renders the boundary in a RETRY lane, and React 19 holds a
 * retry commit until 300 ms after the last fallback appeared
 * (react-dom-client: `globalMostRecentFallbackTime + 300 - now()`, labelled
 * "Throttled"). Live, on a phone: /products sat 311–377 ms on the blank
 * fallback with every chunk already downloaded; the grid of cards committed
 * 552 ms after the first commit against 269 ms with the hold removed. The
 * hold applies to retry lanes only — an ordinary update is never throttled.
 *
 * WHAT THIS DOES. A route fallback on screen `hold()`s; when a route module
 * (src/App.tsx `prefetchable`) settles while one is held, `settled()` bumps a
 * version the app shell subscribes to (`useSyncExternalStore`), and the shell
 * re-renders in an ordinary update: the boundary renders its now-resolved
 * route and commits at once. Nothing re-renders when no fallback is waiting
 * (an idle prefetch, a pointer-down prefetch): an in-app navigation is a
 * transition that keeps the previous page on screen (NavigationRouter) and
 * never mounts the fallback.
 *
 * `settled()` is called from the route module's OWN reaction to its import,
 * which is registered before React's (React attaches its handlers when it
 * first renders the lazy component, after the import was started): React's
 * reaction has marked the module resolved by the time the update this
 * schedules is rendered (a microtask later).
 */
let version = 0;
let holds = 0;
const listeners = new Set<() => void>();

export const routeReveal = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot(): number {
    return version;
  },
  /** A route fallback is on screen. Returns its release (idempotent). */
  hold(): () => void {
    holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
    };
  },
  /** A route module settled: when a fallback is waiting, re-render the shell in an ordinary update. */
  settled(): void {
    if (holds === 0) return;
    version += 1;
    for (const listener of [...listeners]) listener();
  },
  /** For the tests: how many fallbacks are waiting. */
  waiting(): number {
    return holds;
  },
};

/**
 * A LAZY ROUTE THAT CAN BE FETCHED BEFORE IT IS NEEDED (moved here from
 * src/App.tsx with the reveal, which it reports to).
 *
 * `React.lazy` gives a component that downloads its chunk on first render —
 * which is the moment the user is already waiting. This wraps the same loader
 * so the chunk can also be requested EARLY, from idle time, and memoises the
 * promise so asking twice costs one request.
 *
 * The result is the best half of both: nothing extra in the entry bundle, and
 * nothing to wait for at the tap.
 */
export function prefetchable<P extends object>(load: () => Promise<{ default: React.ComponentType<P> }>) {
  type Mod = { default: React.ComponentType<P> };
  let started: Promise<Mod> | null = null;
  /**
   * THE MODULE, ONCE IT IS HERE (speed audit 2026-10-16). `React.lazy` reads
   * its loader's `then` synchronously, so a loader that answers a module
   * already in memory with a thenable that resolves AT ONCE renders the route
   * in the same pass, with no Suspense fallback at all — instead of a fallback
   * frame and React's throttled reveal, even for chunks long downloaded.
   */
  let settled: Mod | null = null;
  const once = (): Promise<Mod> => {
    if (settled) {
      const mod = settled;
      return { then: (resolve?: (m: Mod) => unknown) => resolve?.(mod) } as unknown as Promise<Mod>;
    }
    if (!started) {
      const p = load();
      started = p;
      // Registered BEFORE React's own handlers (React attaches them when it
      // first renders the route, after this): see the header of this file.
      p.then(
        (mod) => {
          settled = mod;
          routeReveal.settled();
        },
        () => {
          // A load that fails is not an error the customer should ever see
          // here: the route will simply fetch again, and report properly,
          // when it is actually rendered. Handling it also stops an unhandled
          // rejection from a flaky network becoming a console error.
          if (started === p) started = null;
        }
      );
    }
    return started;
  };
  const Comp = React.lazy(once);
  (Comp as unknown as { preload: () => void }).preload = () => {
    if (settled) return;
    void once().then(undefined, () => {});
  };
  return Comp;
}
