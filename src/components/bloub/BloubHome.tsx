import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { type MascotDirection, type MascotState } from '../../lib/mascot';
export type { BloubState } from './events';

/** Same Bloub path topology and Levonis palette as the deployed character.
 * All curves have matching commands, allowing the existing morph engine to
 * interpolate rather than replacing an SVG or cross-fading two mascots.
 */
const BASE = {
  idle: 'M50 7 C74 6 91 23 92 47 C94 71 78 91 52 93 C26 95 7 80 8 53 C9 25 24 8 50 7 Z',
  loading: 'M50 9 C76 5 94 28 89 53 C86 78 72 94 47 91 C22 89 5 74 10 47 C14 22 27 11 50 9 Z',
  navigating: 'M50 11 C80 4 96 29 88 52 C80 75 67 91 43 89 C19 87 3 69 12 43 C20 20 30 16 50 11 Z',
  success: 'M50 8 C75 5 92 20 93 45 C95 70 77 88 53 94 C29 98 9 79 8 54 C7 29 25 11 50 8 Z',
  notify: 'M50 5 C74 7 93 25 91 50 C89 75 77 94 50 94 C23 94 9 77 9 50 C9 23 26 3 50 5 Z',
  tap: 'M50 13 C71 10 87 25 90 48 C93 71 76 86 52 88 C28 90 11 76 11 52 C11 28 29 16 50 13 Z',
  error: 'M50 8 C76 9 91 27 89 52 C87 78 70 92 46 91 C21 90 8 73 11 47 C14 22 28 7 50 8 Z',
};
export const BLOUB_SHAPES: Record<MascotState, string> = {
  ...BASE, typing: BASE.loading, warning: BASE.error, returning: BASE.navigating,
  arrival: BASE.success, sleep: BASE.tap,
};
// The union of the actual cubic-curve bounds (plus stroke and small breathing
// excursions) fits here. Old viewBox 0 0 100 100 wasted space around the body.
// Keep explicit breathing room; geometry tests inspect the PATH, not its box.
export const BLOUB_VIEWBOX = '3 3 94 94';

export default function BloubHome({ state = 'idle', direction = { x: 0, y: 0 }, sequence = 0, className = '' }: {
  state?: MascotState; direction?: MascotDirection; sequence?: number; className?: string;
}) {
  const reduced = !!useReducedMotion();
  const travelling = state === 'navigating' || state === 'returning';
  const happy = state === 'success';
  const rest = state === 'sleep';
  const transition = { duration: reduced ? 0.10 : 0.23, ease: 'easeInOut' as const };
  const eyeY = state === 'loading' || state === 'typing' ? 47 : state === 'notify' ? 46 : 49;
  const eyeHeight = rest ? 0.7 : state === 'error' ? 6.4 : state === 'warning' ? 5 : 4.8;
  const mouth = happy ? 'M42 65 Q50 74 59 65' : state === 'error' ? 'M42 69 Q50 62 58 69'
    : state === 'warning' ? 'M43 68 Q50 65 57 68' : rest ? 'M44 66 Q50 66 56 66' : 'M44 65 Q50 69 56 65';

  return (
    <svg viewBox={BLOUB_VIEWBOX} className={`lv-bloub lv-bloub--${state} ${className}`}
      data-expression={state} data-expression-sequence={sequence} data-reduced={reduced ? 'true' : 'false'}
      aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="levonis-bloub-fill" x1="18" y1="8" x2="82" y2="94" gradientUnits="userSpaceOnUse">
          <stop stopColor="#30391c" /><stop offset="0.58" stopColor="#1b2010" /><stop offset="1" stopColor="#10130a" />
        </linearGradient>
        <linearGradient id="levonis-bloub-edge" x1="20" y1="10" x2="80" y2="90" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d0bd83" stopOpacity="0.72" /><stop offset="1" stopColor="#786b43" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <g className="lv-bloub-breath">
        <motion.g className="lv-bloub-posture" initial={false}
          animate={{ scaleX: !reduced && travelling ? 1 + Math.abs(direction.x) * 0.025 : 1,
            scaleY: !reduced && travelling ? 1 + Math.abs(direction.y) * 0.025 : 1 }}
          style={{ transformOrigin: '50px 50px' }} transition={transition}>
          <motion.path data-bloub-body d={BASE.idle} initial={false} animate={{ d: BLOUB_SHAPES[state] }}
            transition={transition} fill="url(#levonis-bloub-fill)" stroke="url(#levonis-bloub-edge)" strokeWidth="2" />
          <path d="M24 28 C38 15 66 15 79 32" fill="none" stroke="#f2e7c6" strokeOpacity="0.12" strokeWidth="4" strokeLinecap="round" />
          <motion.g data-bloub-direction initial={false} animate={{ x: travelling ? direction.x * 7 : 0, y: travelling ? direction.y * 7 : 0 }} transition={transition}>
            <g className="lv-bloub-gaze" data-bloub-gaze>
              <g className="lv-bloub-blink">
                {[37, 64].map((x, i) => (
                  <motion.ellipse key={x} data-bloub-eye={i} cx={x} cy={49} rx={3.8} ry={4.8}
                    initial={false} animate={{ cy: eyeY, ry: eyeHeight, rx: state === 'error' ? 4.6 : 3.8, opacity: happy ? 0 : 1 }}
                    transition={transition} fill="#f3ead0" />
                ))}
              </g>
              <motion.g initial={false} animate={{ opacity: happy ? 1 : 0 }} transition={transition}>
                <path d="M31 49 Q37 56 43 49 M57 49 Q63 56 69 49" fill="none" stroke="#f3ead0" strokeWidth="3" strokeLinecap="round" />
              </motion.g>
            </g>
          </motion.g>
          <motion.path d="M44 65 Q50 69 56 65" initial={false} animate={{ d: mouth }} transition={transition}
            fill="none" stroke="#f3ead0" strokeOpacity="0.9" strokeWidth="2.4" strokeLinecap="round" />
          <motion.g data-bloub-alert initial={false} animate={{ opacity: state === 'error' ? 1 : state === 'warning' ? 0.55 : 0 }} transition={transition}>
            <path d="M76 35 V42 M76 46 V47" stroke="#f3ead0" strokeWidth="2.6" strokeLinecap="round" />
          </motion.g>
        </motion.g>
      </g>
    </svg>
  );
}
