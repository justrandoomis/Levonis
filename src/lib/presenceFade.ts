/**
 * A FADE WITHOUT THE ANIMATION LIBRARY, ON THE HOUSE SPRINGS' CLOCK (speed
 * audit 2026-10-16).
 *
 * The two layers every shell mounts at boot — the busy scrim
 * (src/components/ui/AppBusy.tsx) and the update line
 * (src/components/pwa/UpdateReadyToast.tsx) — animated with the library's
 * `m.div` and `AnimatePresence`, which made its core (`vendor-motion-core`,
 * 32 KB gzip) part of the first download of every visit, for elements no
 * first screen draws. They animate opacity (and the update line 16 px of
 * travel), which the Web Animations API does on the compositor with no code
 * to download. This is their timing: the named spring's response as the
 * duration, on a critically damped curve, and the house cross-fade
 * (src/lib/motion.ts CROSS_FADE) under reduced motion. The Web Animations API
 * is not touched by the stylesheet's reduced-motion sweep, so the cross-fade
 * survives it exactly as it did under the library.
 */
import { CROSS_FADE, SPRING, type SpringName } from './motion';

/** A critically damped spring settles on this curve, near enough to read as the same motion. */
const SETTLE = 'cubic-bezier(0.2, 0, 0, 1)';

export function fadeTiming(reduced: boolean, spring: SpringName = 'ui'): KeyframeAnimationOptions {
  if (reduced) return { duration: CROSS_FADE.duration * 1000, easing: `cubic-bezier(${CROSS_FADE.ease.join(', ')})` };
  return { duration: SPRING[spring].duration * 1000, easing: SETTLE };
}
