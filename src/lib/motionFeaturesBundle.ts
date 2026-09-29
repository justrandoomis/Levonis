/**
 * THE ANIMATION FEATURES, AS THEIR OWN DYNAMIC IMPORT.
 *
 * `domMax` is the full feature set — animation, exit, gestures (whileTap,
 * whileHover, drag, pan) and layout/projection — and it is the half of the
 * library that never needs to be parsed before the first paint. Nothing
 * imports this module statically: `src/lib/motionFeatures.tsx` requests it
 * the first time an `m.*` component mounts (or earlier, from idle), and
 * vite.config.ts keeps every module it reaches in the lazy `vendor-motion`
 * chunk. Re-exported from its own file rather than as
 * `import('motion/react').then((x) => x.domMax)` because a dynamic import of
 * the whole package namespace would mark every export as used and pull the
 * features back into the eager chunk.
 *
 * `domMax` and not `domAnimation`: the sheets drag (Overlay's `Sheet`), the
 * toasts and the segmented control animate layout (`layout`, `layoutId`), and
 * `domAnimation` has neither — a sheet that could no longer be thrown away
 * would be a behaviour change, not a performance one.
 */
import { domMax, type FeatureBundle } from 'motion/react';

/**
 * A module of its own, with a statement of its own. A bare
 * `export { domMax as default } from 'motion/react'` has no code Rollup needs
 * to render, and an empty dynamic entry is folded back into the chunk that
 * imports it — which turned the lazy import into a static one and put the
 * features back before the first paint (measured: the entry importing
 * `domMax` from vendor-motion). The copy below is the statement.
 */
const features: FeatureBundle = { ...domMax };

export default features;
