/**
 * The arithmetic every other character module is written in.
 *
 * Everything here is a PURE function of its arguments — no clocks, no random
 * state, no DOM. That is not tidiness for its own sake: the whole motion system
 * is sampled as `f(t)`, so pausing on a hidden tab, resuming, or jumping the
 * clock forward all produce exactly the frame that time deserves. A generator
 * that carried internal state would drift apart from the clock the moment the
 * browser throttled a frame, and the character would arrive at a different pose
 * than the one the position animation was written against.
 */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const deg = (d: number) => (d * Math.PI) / 180;

/** Short rounding for values that end up in an SVG path string. Halves the
 * bytes handed to the parser 60 times a second and is invisible at any size
 * the character is drawn at. */
export const r2 = (v: number) => Math.round(v * 100) / 100;

export type Easing = (t: number) => number;

/**
 * The curve library.
 *
 * There is deliberately no single "app easing" here. The mandate is explicit
 * that everything must not ride one spring, and the reason is perceptual: a
 * body that settles, a pupil that flicks, and a scale that shrinks are three
 * different physical events. Sharing a curve between them is what makes an
 * interface read as scripted. Each consumer below names the curve it wants and
 * says why in a comment at the call site.
 */
export const easings = {
  /** Linear. Only for values that are already a phase, never for motion. */
  linear: (t: number) => t,
  /** The workhorse settle: fast departure, long tail, no overshoot. */
  easeOutCubic: (t: number) => 1 - (1 - t) ** 3,
  /** A harder stop than cubic — for a value that must be visibly *arrived*. */
  easeOutQuint: (t: number) => 1 - (1 - t) ** 5,
  /** Symmetrical. For a rotation or a traversal, which is an object turning
   * rather than a value landing; an ease-out swallows two thirds of it in the
   * first fifth of the time and reads as a jolt. */
  easeInOutCubic: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  /** Slow build. This is the anticipation curve: the character gathers itself
   * before it goes, so the departure is not the first thing that happens. */
  easeInQuad: (t: number) => t * t,
} satisfies Record<string, Easing>;

/**
 * A CSS-grade cubic Bezier, solved numerically.
 *
 * Needed because the travel curve has to be smooth in its FIRST DERIVATIVE,
 * not just continuous. The body's stretch is driven by speed, so a curve
 * stitched together from two polynomials — however well their values match at
 * the seam — makes the character lurch and snap taut at the join. Two handles
 * describe the whole journey with no seam to get wrong.
 *
 * Newton-Raphson with a bisection fallback, which is what browsers do.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const A = (a: number, b: number) => 1 - 3 * b + 3 * a;
  const B = (a: number, b: number) => 3 * b - 6 * a;
  const C = (a: number) => 3 * a;
  const calc = (t: number, a: number, b: number) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t: number, a: number, b: number) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = slope(t, x1, x2);
      if (d === 0) break;
      const err = calc(t, x1, x2) - x;
      if (Math.abs(err) < 1e-6) return calc(t, y1, y2);
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24 && hi - lo > 1e-6; i++) {
      if (calc(t, x1, x2) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return calc(t, y1, y2);
  };
}

/**
 * THE TRAVEL CURVE.
 *
 * Handles chosen, not borrowed from a preset. The first is low and far along
 * x, so the character gathers before it commits — an ease-out would have it
 * leave at full speed with no wind-up at all. The second is pulled hard to the
 * finish, giving the long deceleration that makes an arrival read as arriving
 * rather than as stopping. A symmetrical ease-in-out was tried first and is
 * wrong for a different reason: it slows in the middle, so the character
 * appears to hesitate halfway through a journey it has already committed to.
 */
export const travelEase: Easing = cubicBezier(0.32, 0, 0.18, 1);

/**
 * Periodic 1-D noise: seamless on `period`, bounded to roughly ±1.
 *
 * Three harmonics rather than one sine, because a single sine is recognisable
 * as a sine within two cycles — the eye is very good at seeing a pendulum. The
 * character's idle drift sums several of these at periods that share no small
 * common multiple (11.3s, 9.1s, 7.9s, …), so the combination does not visibly
 * repeat inside any span a person will watch. That is the whole answer to
 * "avoid obvious repeating loops": not a longer keyframe, an incommensurable
 * one.
 */
export function loopNoise(t: number, period: number, seed = 0): number {
  const p = (t / period) * TAU;
  return (
    0.55 * Math.sin(p + seed) +
    0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) +
    0.15 * Math.sin(3 * p + seed * 2.3 + 2.4)
  );
}

/** Deterministic PRNG (mulberry32). Used only to lay down fixed schedules at
 * module load — never per frame — so every visit gets the same irregular
 * rhythm rather than a fresh random one. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A damped oscillation that starts at 0, swings, and returns to 0.
 *
 * This is the settle. It is NOT applied to the character's position — a body
 * that overshoots its dock and comes back reads as bouncy, which the mandate
 * forbids. It is applied to the body's SHAPE: the character arrives, its mass
 * catches up, and it squashes and recovers once. `freq` is in cycles over the
 * normalised span, `decay` how fast the swing dies.
 */
export function damped(t: number, freq = 1.35, decay = 4.2): number {
  if (t <= 0 || t >= 1) return 0;
  return Math.sin(t * TAU * freq) * Math.exp(-t * decay);
}

/** Normalised progress of `elapsed` through a window that starts at `start`
 * and lasts `span`, clamped to 0..1. Returns 1 for a zero-length window so a
 * disabled phase reads as "already finished" rather than dividing by zero. */
export function phaseProgress(elapsed: number, start: number, span: number): number {
  if (span <= 0) return 1;
  return clamp((elapsed - start) / span);
}
