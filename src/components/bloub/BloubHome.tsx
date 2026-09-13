import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { CROSS_FADE, SPRING } from '../../lib/motion';

export type BloubState = 'idle' | 'thinking' | 'navigation' | 'success' | 'notify' | 'tap' | 'error';

const SHAPES: Record<BloubState, string> = {
  idle: 'M50 7 C74 6 91 23 92 47 C94 71 78 91 52 93 C26 95 7 80 8 53 C9 25 24 8 50 7 Z',
  thinking: 'M50 9 C76 5 94 28 89 53 C86 78 72 94 47 91 C22 89 5 74 10 47 C14 22 27 11 50 9 Z',
  navigation: 'M50 11 C80 4 96 29 88 52 C80 75 67 91 43 89 C19 87 3 69 12 43 C20 20 30 16 50 11 Z',
  success: 'M50 8 C75 5 92 20 93 45 C95 70 77 88 53 94 C29 98 9 79 8 54 C7 29 25 11 50 8 Z',
  notify: 'M50 5 C74 7 93 25 91 50 C89 75 77 94 50 94 C23 94 9 77 9 50 C9 23 26 3 50 5 Z',
  tap: 'M50 13 C71 10 87 25 90 48 C93 71 76 86 52 88 C28 90 11 76 11 52 C11 28 29 16 50 13 Z',
  error: 'M50 8 C76 9 91 27 89 52 C87 78 70 92 46 91 C21 90 8 73 11 47 C14 22 28 7 50 8 Z',
};

const FACE_Y: Record<BloubState, number> = {
  idle: 49,
  thinking: 47,
  navigation: 49,
  success: 50,
  notify: 46,
  tap: 51,
  error: 48,
};

/**
 * LEVONIS' own quiet home character. The implementation adapts the general
 * SVG-path-morph technique from the MIT-licensed Bloub project, but the shape,
 * palette, face and state behaviour are original to this product.
 */
export default function BloubHome({ state = 'idle', className = '' }: { state?: BloubState; className?: string }) {
  const reduced = !!useReducedMotion();
  const faceY = FACE_Y[state];
  const isSuccess = state === 'success';
  const isThinking = state === 'thinking' && !reduced;

  return (
    <motion.svg
      viewBox="0 0 100 100"
      className={`lv-bloub lv-bloub--${state} ${className}`}
      aria-hidden="true"
      focusable="false"
      animate={
        reduced
          ? undefined
          : {
              rotate: state === 'notify' ? [0, -3, 3, 0] : 0,
              scale: state === 'tap' ? 0.92 : state === 'success' ? 1.04 : 1,
            }
      }
      transition={reduced ? CROSS_FADE : SPRING.quick}
    >
      <defs>
        <linearGradient id="levonis-bloub-fill" x1="18" y1="8" x2="82" y2="94" gradientUnits="userSpaceOnUse">
          <stop stopColor="#30391c" />
          <stop offset="0.58" stopColor="#1b2010" />
          <stop offset="1" stopColor="#10130a" />
        </linearGradient>
        <linearGradient id="levonis-bloub-edge" x1="20" y1="10" x2="80" y2="90" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d0bd83" stopOpacity="0.72" />
          <stop offset="1" stopColor="#786b43" stopOpacity="0.22" />
        </linearGradient>
      </defs>

      <motion.path
        d={SHAPES[state]}
        animate={{ d: SHAPES[state] }}
        transition={reduced ? CROSS_FADE : SPRING.ui}
        fill="url(#levonis-bloub-fill)"
        stroke="url(#levonis-bloub-edge)"
        strokeWidth="2"
      />
      <path
        d="M24 28 C38 15 66 15 79 32"
        fill="none"
        stroke="#f2e7c6"
        strokeOpacity="0.12"
        strokeWidth="4"
        strokeLinecap="round"
      />

      {isSuccess ? (
        <>
          <path d={`M31 ${faceY} Q37 ${faceY + 5} 43 ${faceY}`} fill="none" stroke="#f3ead0" strokeWidth="3" strokeLinecap="round" />
          <path d={`M57 ${faceY} Q63 ${faceY + 5} 69 ${faceY}`} fill="none" stroke="#f3ead0" strokeWidth="3" strokeLinecap="round" />
        </>
      ) : (
        <>
          <motion.ellipse
            cx="37"
            cy={faceY}
            ry={4}
            animate={{ cy: faceY, ry: isThinking ? [4, 1, 4] : 4 }}
            rx="3.4"
            fill="#f3ead0"
            transition={reduced ? CROSS_FADE : { duration: 1.6, repeat: isThinking ? Infinity : 0, repeatDelay: 0.8 }}
          />
          <motion.ellipse
            cx="64"
            cy={faceY}
            ry={4}
            animate={{ cy: faceY, ry: isThinking ? [4, 1, 4] : 4 }}
            rx="3.4"
            fill="#f3ead0"
            transition={reduced ? CROSS_FADE : { duration: 1.6, repeat: isThinking ? Infinity : 0, repeatDelay: 0.8 }}
          />
        </>
      )}

      <motion.path
        d={isSuccess ? 'M42 66 Q50 73 59 65' : state === 'error' ? 'M42 69 Q50 63 58 69' : state === 'notify' ? 'M45 67 Q50 63 55 67' : 'M44 65 Q50 68 56 65'}
        animate={{ d: isSuccess ? 'M42 66 Q50 73 59 65' : state === 'error' ? 'M42 69 Q50 63 58 69' : state === 'notify' ? 'M45 67 Q50 63 55 67' : 'M44 65 Q50 68 56 65' }}
        fill="none"
        stroke="#f3ead0"
        strokeOpacity="0.82"
        strokeWidth="2.4"
        strokeLinecap="round"
        transition={reduced ? CROSS_FADE : SPRING.quick}
      />
    </motion.svg>
  );
}
