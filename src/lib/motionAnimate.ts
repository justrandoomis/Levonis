/**
 * THE VALUE ANIMATOR, AS A CHUNK OF ITS OWN (speed audit 2026-10-16).
 *
 * The rails (src/lib/useRail.ts) spring to a resting place after a mouse drag
 * and on their arrow buttons — on a phone the browser scrolls them natively
 * and no spring runs at all. Imported statically, `animate` made the
 * library's core (`vendor-motion-core`, 32 KB gzip) part of every first
 * download, the home page's included. useRail now asks for this module on the
 * first press or arrow, and from idle once the first screen is painted.
 *
 * A statement of its own, not a bare re-export: a dynamic entry with no code
 * of its own is folded back into its importer's chunk
 * (src/lib/motionFeaturesBundle.ts tells that story).
 */
import { animate } from 'motion/react';

/** The options the rails pass: a spring to a number, frame by frame. */
export interface ValueSpring {
  type: 'spring';
  bounce: number;
  duration: number;
  velocity?: number;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}

export default function springValue(from: number, to: number, options: ValueSpring): { stop: () => void } {
  return animate(from, to, options);
}
