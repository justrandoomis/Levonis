/**
 * ASK FOR THE MOTION FEATURES WITHOUT CARRYING THE LIBRARY (speed audit
 * 2026-10-16).
 *
 * The shell asks for the animation features from idle and on the first
 * pointer (src/App.tsx), and the header's search field on its first touch
 * (LiveSearch). Importing `preloadMotionFeatures` from ./motionFeatures.tsx
 * made that module — and the `LazyMotion` it renders, from the library's
 * eager core (`vendor-motion-core`, 32 KB gzip) — a static part of the entry:
 * downloaded and parsed before every first paint, for animations no first
 * screen runs. The question is asked through a dynamic import instead: the
 * module and the core arrive at the moment the features are wanted anyway
 * (vite.config.ts keeps ./motionFeatures.tsx inside the core's chunk).
 */
export function preloadMotionFeatures(): void {
  void import('./motionFeatures')
    .then((mod) => mod.preloadMotionFeatures())
    .catch(() => {
      // The first window that opens asks again (src/lib/motionFeatures.tsx).
    });
}
