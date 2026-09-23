/**
 * HOW THE CHARACTER APPEARS SOMEWHERE WITHOUT TRAVELLING THERE.
 *
 * `anchors.ts` decides WHEN (a stage is appeared at, never flown to); this
 * decides WHAT IT LOOKS LIKE. Two entrances, as data:
 *
 *   stage  the order went through. It pops into being at the confirmation
 *          stage — small and transparent, overshooting, settling — and then
 *          hops for joy twice, the second hop smaller than the first, squashing
 *          on every landing. This is the «مرح» the owner asked for: a jump, not
 *          a slightly wider smile.
 *   dock   it is leaving the stage for an ordinary dock. A short pop in place,
 *          so it arrives the same way it left: by appearing.
 *
 * WHY WAAPI KEYFRAMES AND NOT THE ENGINE. The engine draws the BODY — its
 * outline, eyes and mouth — as SVG attributes on the main thread, and that is
 * right for a face that has to follow a pointer. A pop and two hops follow
 * nothing; they are a fixed gesture. Handed to `Element.animate()` with only
 * `transform` and `opacity` in the frames, the browser runs them on the
 * compositor: a stalled main thread (the checkout tree unmounting, the
 * confirmation mounting) cannot make them stutter. That is the second half of
 * «بشكل يظهر فيه lagging».
 *
 * WHY ON AN INNER WRAPPER. The outer node's `transform` is the character's
 * POSITION, written by AppIntro and nothing else (tests/mascotAnchor.test.ts
 * pins that single writer). The entrance animates the wrapper inside it, whose
 * resting transform is the identity, so the two can never fight over one
 * property and a finished entrance leaves nothing behind.
 *
 * Everything here is a constant and a pure function of it, so the shape of the
 * gesture is asserted in tests/orderCelebration.test.ts rather than taken on
 * trust.
 */

export type EntranceKind = 'stage' | 'dock';

export interface Entrance {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

/**
 * The pivot the pose wrapper scales and squashes around: the bottom of the
 * body, where its feet would be. The body's resting radius is 41 in a 0-100
 * box centred on 50 (character/engine.ts), so it touches down at 91%.
 * Growing from there reads as springing up off the page; growing from the
 * centre reads as a balloon inflating.
 */
export const ENTRANCE_ORIGIN = '50% 91%';

// Gravity, both ways: leave the ground fast and slow into the apex, then
// fall slowly out of it and fast into the landing.
const RISE = 'cubic-bezier(0.2, 0.75, 0.35, 1)';
const FALL = 'cubic-bezier(0.55, 0, 0.8, 0.35)';
const SETTLE = 'cubic-bezier(0.3, 0.7, 0.4, 1)';

const at = (y: number, sx: number, sy = sx) => `translate3d(0, ${y}%, 0) scale(${sx}, ${sy})`;

/**
 * THE CELEBRATION. 1.3s, which is inside the celebrate expression's own
 * window (MASCOT_STATES.celebrate) with room to spare: the face is still
 * beaming when the body comes to rest, rather than the other way round.
 *
 * The hop heights are a fraction of the character's OWN canvas (translate
 * percentages resolve against the element), so a 96px stage on a small phone
 * and a 128px one on a tablet make the same-looking jump.
 */
const STAGE: Entrance = {
  keyframes: [
    // Pop: from a third of its size at its feet, overshooting past full size.
    { offset: 0, opacity: 0, transform: at(0, 0.35), easing: RISE },
    { offset: 0.16, opacity: 1, transform: at(0, 1.12), easing: SETTLE },
    { offset: 0.26, opacity: 1, transform: at(0, 0.95), easing: SETTLE },
    { offset: 0.33, opacity: 1, transform: at(0, 1), easing: SETTLE },
    // First hop: gather (wide and low), launch (tall and thin), land (squash).
    { offset: 0.41, opacity: 1, transform: at(0, 1.08, 0.9), easing: RISE },
    { offset: 0.53, opacity: 1, transform: at(-22, 0.94, 1.08), easing: FALL },
    { offset: 0.63, opacity: 1, transform: at(0, 1.1, 0.88), easing: SETTLE },
    { offset: 0.7, opacity: 1, transform: at(0, 1), easing: SETTLE },
    // Second hop, smaller: the joy spending itself rather than stopping dead.
    { offset: 0.76, opacity: 1, transform: at(0, 1.05, 0.94), easing: RISE },
    { offset: 0.85, opacity: 1, transform: at(-10, 0.97, 1.04), easing: FALL },
    { offset: 0.93, opacity: 1, transform: at(0, 1.05, 0.95), easing: SETTLE },
    { offset: 1, opacity: 1, transform: at(0, 1) },
  ],
  options: { duration: 1300, easing: 'linear', fill: 'backwards' },
};

/** Arriving back on an ordinary dock: a quick pop, no hops. */
const DOCK: Entrance = {
  keyframes: [
    { offset: 0, opacity: 0, transform: at(0, 0.6), easing: RISE },
    { offset: 0.6, opacity: 1, transform: at(0, 1.06), easing: SETTLE },
    { offset: 1, opacity: 1, transform: at(0, 1) },
  ],
  options: { duration: 320, easing: 'linear', fill: 'backwards' },
};

/**
 * UNDER REDUCED MOTION IT FADES IN WHERE IT IS GOING. No scale, no hop, no
 * squash: a body that grows and bounces is exactly the vestibular motion the
 * preference asks to remove. The arrival itself is still shown — as opacity,
 * which is not motion — and the celebrate FACE still plays, because an
 * expression is information and survives the preference everywhere else in
 * the character.
 */
const REDUCED: Record<EntranceKind, Entrance> = {
  stage: { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 200, easing: 'ease-out', fill: 'backwards' } },
  dock: { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 150, easing: 'ease-out', fill: 'backwards' } },
};

export function entranceFor(kind: EntranceKind, reduced: boolean): Entrance {
  if (reduced) return REDUCED[kind];
  return kind === 'stage' ? STAGE : DOCK;
}

/**
 * Plays an entrance on the pose wrapper, replacing any that is still running,
 * and returns the animation so the caller can cancel it on teardown.
 *
 * `animate` is feature-tested, not assumed: an engine without the Web
 * Animations API simply shows the character where it already is, which is the
 * correct final frame of every entrance here.
 */
export function playEntrance(
  element: HTMLElement | null,
  kind: EntranceKind,
  reduced: boolean,
  previous?: Animation | null
): Animation | null {
  previous?.cancel();
  if (!element || typeof element.animate !== 'function') return null;
  const { keyframes, options } = entranceFor(kind, reduced);
  try {
    return element.animate(keyframes, options);
  } catch {
    // An engine that rejects a keyframe (an old per-keyframe easing parser)
    // leaves the character exactly where it already is, which is correct.
    return null;
  }
}
