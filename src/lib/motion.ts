/**
 * THE HOUSE MOTION SYSTEM — Apple's fluid-interface rules, as values.
 *
 * Every animated thing in LEVONIS reaches for a preset here instead of
 * inventing a duration and an easing curve. That is not tidiness for its own
 * sake: the presets encode decisions that are easy to get wrong and impossible
 * to eyeball, and having one place for them is what lets the whole app be
 * corrected at once.
 *
 * WHY SPRINGS AND NOT TRANSITIONS. A CSS transition or a @keyframes animation
 * runs from a value it captured when it started, for a duration fixed in
 * advance. It cannot be grabbed mid-flight and reversed, and it cannot inherit
 * the speed of the finger that caused it. A spring can: new input just moves
 * the target, and the motion continues from wherever it currently is at
 * whatever speed it currently has. Apple's own framing — "think of animation as
 * a conversation between you and the object, not something prescribed by the
 * interface." So: transitions are fine for a colour or an opacity that nobody
 * can interrupt; anything a user can touch, drag, or dismiss uses a spring.
 *
 * WHY THESE TWO NUMBERS. Apple deliberately replaced the physics triplet
 * (mass, stiffness, damping) with two parameters a designer can reason about:
 *
 *   DAMPING RATIO — how much it overshoots. 1.0 = critically damped, settles
 *                   with no bounce at all. Below 1.0 it overshoots; lower is
 *                   bouncier.
 *   RESPONSE      — how quickly it reaches the target, in seconds. NOT a
 *                   duration: a spring has no fixed duration, its settle time
 *                   emerges from the parameters.
 *
 * `motion` expresses the same pair as `bounce` + `duration`, where
 * bounce ≈ 1 − dampingRatio. So Apple's damping 1.0 is bounce 0, and damping
 * 0.8 is bounce 0.2. The presets below are Apple's shipped values converted.
 *
 * THE RULE ABOUT BOUNCE. Default to no overshoot. Add bounce ONLY when the
 * gesture itself carried momentum — a flick, a throw, a drag release. Overshoot
 * on a menu that merely appeared is wrong and reads as decoration; overshoot on
 * a card you threw reads as physics.
 *
 * REDUCED MOTION IS NOT NO FEEDBACK. `useMotion()` collapses every spring to a
 * short opacity cross-fade and asks callers to drop their transforms, which is
 * the accessible equivalent — not a dead interface.
 */

import { useMemo } from 'react';
import { useReducedMotion } from 'motion/react';
import { useLanguage } from '../LanguageContext';

// ---------------------------------------------------------------- presets

export interface Spring {
  type: 'spring';
  bounce: number;
  duration: number;
}

const spring = (bounce: number, duration: number): Spring => ({ type: 'spring', bounce, duration });

/**
 * The only springs this app uses. Each name says WHEN, not what it looks like,
 * so a call site picks by the kind of interaction it is.
 */
export const SPRING = {
  /** The default for anything appearing, moving or resizing on its own.
   *  Apple: move/reposition — damping 1.0, response 0.4. */
  ui: spring(0, 0.35),

  /** A thing repositioning across the screen (a card flying to a new slot, a
   *  sliding tab indicator). Apple's PiP window value: damping 1.0 / 0.4. */
  move: spring(0, 0.4),

  /** A drawer or a sheet. Apple: damping 0.8, response 0.3 — the small
   *  overshoot is right here because a sheet is a thing being thrown into
   *  place, and it is usually opened or closed by a drag. */
  sheet: spring(0.2, 0.3),

  /** The landing of a flick or a throw: the gesture carried momentum, so the
   *  overshoot is the momentum being spent. Pair with a velocity handoff. */
  momentum: spring(0.2, 0.4),

  /** Rotation. Apple: damping 0.8, response 0.4. */
  rotate: spring(0.2, 0.4),

  /** Faster than `ui`, for something small and local — a chevron flipping, a
   *  chip toggling. Still critically damped. */
  quick: spring(0, 0.25),
} as const;

export type SpringName = keyof typeof SPRING;

/** What a spring becomes when the viewer asked for less motion. */
export const CROSS_FADE = { duration: 0.15, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/**
 * Press feedback duration, in ms, for the CSS `:active` layer. Short enough to
 * feel like contact rather than an animation — the point of press feedback is
 * that it has already happened by the time the finger registers it.
 */
export const PRESS_MS = 100;

// ------------------------------------------------------------- the hook

export interface MotionKit {
  /** True when the viewer asked for reduced motion. */
  reduced: boolean;
  /** A spring by name, already collapsed to a cross-fade when reduced. */
  spring: (name?: SpringName) => Spring | typeof CROSS_FADE;
  /**
   * +1 or -1: the sign that means "forward" along the inline axis for the
   * current writing direction. In RTL, forward is to the LEFT, so a slide that
   * hardcodes a positive x is backwards for most of this app's users.
   */
  dir: 1 | -1;
  /**
   * An offset along the inline axis, sign-corrected for the writing direction.
   * `inline(24)` is 24px forward — right in English, left in Arabic.
   */
  inline: (px: number) => number;
  /** 0 when reduced motion is on, so a caller can drop a transform in one place. */
  travel: (px: number) => number;
}

/**
 * The one hook every animated component uses. It answers three questions a
 * call site would otherwise get wrong: which spring, which direction is
 * forward, and whether to move at all.
 */
export function useMotion(): MotionKit {
  const prefersReduced = useReducedMotion();
  const { dir: writingDir } = useLanguage();
  const reduced = !!prefersReduced;
  const dir: 1 | -1 = writingDir === 'rtl' ? -1 : 1;

  return useMemo(
    () => ({
      reduced,
      spring: (name: SpringName = 'ui') => (reduced ? CROSS_FADE : SPRING[name]),
      dir,
      inline: (px: number) => px * dir,
      travel: (px: number) => (reduced ? 0 : px),
    }),
    [reduced, dir]
  );
}

// -------------------------------------------------- gesture mathematics

/**
 * WHERE A FLICK IS GOING, not where the finger left off.
 *
 * Apple's projection function from the Designing Fluid Interfaces sample code.
 * Snapping to the nearest point measured from the RELEASE point ignores the
 * throw entirely — a hard flick and a slow nudge that end in the same place
 * land in the same place, which is exactly what makes a carousel feel dead.
 * Projecting first and snapping to whatever is nearest the PROJECTION is what
 * makes a flick actually throw the thing.
 *
 * Note this is the exponential-decay form, the same maths as scroll
 * deceleration — NOT the textbook v²/(2a), which Apple does not ship.
 *
 * @param velocity px per second at release
 * @param decelerationRate 0.998 for a normal scroll feel, 0.99 for snappier
 * @returns the distance, in px, the thing would still travel on its own
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * PROGRESSIVE RESISTANCE AT A BOUNDARY. A hard stop reads as frozen — the
 * user cannot tell a limit from a bug. Resistance that grows the further they
 * pull reads as "responsive, but there is nothing more here".
 *
 * @param overshoot how far past the boundary the pointer has gone
 * @param dimension the size of the thing being dragged, which sets the scale
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** The snap target nearest a projected resting point. */
export function nearestSnap(projected: number, points: number[]): number {
  if (points.length === 0) return projected;
  return points.reduce((best, p) => (Math.abs(p - projected) < Math.abs(best - projected) ? p : best), points[0]);
}

/**
 * A short position history, which is what velocity actually needs. The single
 * last pointermove is noisy — a finger resting still for one frame before
 * release reports zero velocity and the throw is lost.
 */
export class VelocityTracker {
  private samples: Array<{ v: number; t: number }> = [];
  /** Samples older than this are stale for the purpose of a release velocity. */
  private readonly windowMs: number;

  constructor(windowMs = 100) {
    this.windowMs = windowMs;
  }

  add(value: number, now: number): void {
    this.samples.push({ v: value, t: now });
    while (this.samples.length > 1 && now - this.samples[0].t > this.windowMs) this.samples.shift();
  }

  /** px per second across the retained window; 0 when there is nothing to say. */
  velocity(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    return ((last.v - first.v) / dt) * 1000;
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * The threshold a drag must cross before it counts as a drag rather than a tap
 * (Apple's ~10px hysteresis). Below it, the touch is still a candidate for
 * every gesture and must not commit to one.
 */
export const DRAG_THRESHOLD_PX = 10;
