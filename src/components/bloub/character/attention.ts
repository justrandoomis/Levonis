import { clamp } from './math';

/**
 * WHAT THE CHARACTER IS LOOKING AT, AND HOW HARD.
 *
 * The brief asks for a mascot that notices the pointer, turns towards it,
 * pays more attention the closer it comes, and lets go again when the user
 * stops. That is one value with four numbers in it, and keeping it as one
 * value is what stops the behaviour fragmenting: every part of the face reads
 * the same attention, so the eyes, the mouth and the lean cannot disagree
 * about whether the character is interested.
 *
 * Everything here is pure arithmetic over numbers the caller already has. It
 * reads no clock, touches no DOM and measures nothing — the element rectangles
 * and the pointer position are measured once, elsewhere, by an rAF-throttled
 * caller, because a gaze tracker that calls getBoundingClientRect sixty times
 * a second is a gaze tracker that costs more than the page it decorates.
 */
export interface Attention {
  /**
   * HOW FAR OFF-CENTRE THE TARGET IS, PER AXIS, -1..1 — a signed excursion,
   * not a unit direction. Screen space: x grows right, y grows DOWN, and the
   * engine flips y itself when it turns this into a pitch, because a head that
   * looks up is a positive pitch and a point above the character has a
   * negative y.
   *
   * It was a unit direction, and that is what made the gaze so small. A unit
   * vector divides each axis by the full hypotenuse, so on a character docked
   * at the bottom of a tall phone the vertical distance ate almost the whole
   * horizontal signal — the eyes turned sideways as a function of how far UP
   * the pointer was — and a perfect diagonal lost 29% before anything else
   * touched it. Normalising each axis against its own half-viewport instead
   * means a corner of the screen is 1 on BOTH axes, cardinals and diagonals
   * reach equally far, and the excursion grows towards the edges rather than
   * away from them.
   */
  x: number;
  y: number;
  /** 0..1 — how much of the gaze the target claims. Zero is indistinguishable
   *  from having no target at all, which is what makes releasing attention a
   *  fade rather than a switch.
   *
   *  It is how much the character CARES, and deliberately not how far it looks.
   *  Those were the same number once, which meant a pointer in a far corner
   *  produced a SMALLER gaze than one right beside the character — the exact
   *  inverse of what reaching for something looks like. How far now comes from
   *  `x`/`y`; this stays the release ramp and the priority damper. */
  weight: number;
  /**
   * 0..1 — how INTERESTING it is, which is a different question from how
   * strongly it is being looked at. A pointer drifting across the far side of
   * a wide screen earns a turn of the head and no curiosity; the same pointer
   * arriving on the Add to Cart button earns both. Curiosity is what widens
   * the eyes and lifts the mouth, so it must not rise merely because something
   * is being tracked.
   */
  curiosity: number;
}

export const NO_ATTENTION: Attention = Object.freeze({ x: 0, y: 0, weight: 0, curiosity: 0 });

/**
 * How near a thing has to be to be INTERESTING, as a fraction of the
 * viewport's diagonal.
 *
 * This used to gate `weight` as well, and that was the second half of the
 * small-gaze defect: on a 390x844 phone it made the weight exactly zero for
 * everything above y=232 — the top 27% of the screen — so the character did
 * not merely look less hard at the far corners, it did not look at them at
 * all, and upper-left and upper-right produced byte-identical frames. Distance
 * belongs to curiosity, which is the question it was always asking (how
 * interesting, not how far). Turning towards something is not rationed.
 */
const REACH = 0.62;

/**
 * The smallest half-viewport an axis may be normalised against, as a fraction
 * of the viewport's short side.
 *
 * The character lives in the navigation bar, so there are a few dozen pixels of
 * screen BELOW it. Without a floor, a pointer ten pixels under its chin would
 * be a full-excursion target and the eyes would slam down. 0.12 of the short
 * side is 47px on a phone and 96px on a laptop, and it only ever binds on that
 * one starved axis.
 */
const MIN_SPAN = 0.12;

/**
 * FROM "how far off-centre" TO "how far to look": gentle near the character,
 * and exactly full at the viewport edge.
 *
 * A linear map makes the eyes twitch at every small pointer move. A pure power
 * curve fixes that and makes the near half of the screen do nothing at all.
 * Blending the two keeps a real slope at the origin (0.55) while still reaching
 * 1.0 exactly at the edge rather than clamping early: half the distance out
 * gives 40% of the excursion, so the last stretch towards a corner is where
 * most of the movement is — which is what reaching for something looks like.
 */
function reachCurve(n: number): number {
  const a = Math.min(1, Math.abs(n));
  return Math.sign(n) * (0.55 * a + 0.45 * a ** 2.2);
}

/**
 * Where curiosity starts, as a fraction of REACH.
 *
 * Past this the character is merely tracking; inside it, it is interested. The
 * brief is explicit that this must not be exaggerated, so the band is narrow
 * and the curve inside it is quadratic — a pointer has to come genuinely close
 * before the eyes widen at all.
 */
const CURIOUS_AT = 0.34;

export interface AttentionInput {
  /** Pointer or touch position in viewport CSS pixels; null when there is
   *  nothing to attend to. */
  point: { x: number; y: number } | null;
  /** The character's own centre, same units. The caller already knows this
   *  from the frame it is drawing, so nothing is measured here. */
  center: { x: number; y: number };
  /** Viewport size, for normalising distance. */
  viewport: { w: number; h: number };
  /**
   * 0..1 — how much the caller wants this target honoured at all.
   *
   * This is the release ramp and the priority damper in one. The loop fades it
   * down over the seconds after the user stops, and a reaction that has taken
   * over the face (an error, a journey) hands in a small value so the
   * character stays pointed at what matters.
   */
  engagement: number;
  /**
   * True when the target is a control the character considers meaningful — a
   * primary call to action rather than a patch of page. It does not change
   * WHERE the character looks, only how interested it is when it gets there.
   */
  deliberate?: boolean;
}

/**
 * The attention a pointer at `point` earns.
 *
 * Two answers, and keeping them separate is the point. WHERE to look is a
 * per-axis excursion that grows all the way to the edge of the screen, because
 * a creature reaches further for a thing that is further away. HOW INTERESTED
 * to be falls off with distance on a quadratic band, because a character that
 * is always half-interested in everything reads as vacancy rather than as
 * attention — and ignoring things is most of what makes noticing them legible.
 */
export function attentionFrom(input: AttentionInput): Attention {
  const engagement = clamp(input.engagement);
  if (!input.point || engagement <= 0) return NO_ATTENTION;

  const dx = input.point.x - input.center.x;
  const dy = input.point.y - input.center.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 0.5) {
    // The pointer is ON the character. There is no direction to look in, so
    // it looks straight out and is maximally curious — which is exactly what
    // a creature does when something arrives on top of it.
    return { x: 0, y: 0, weight: engagement, curiosity: engagement };
  }

  const vw = Math.max(1, input.viewport.w);
  const vh = Math.max(1, input.viewport.h);
  // Each axis against ITS OWN half of the viewport, on the side the target is
  // actually on: the character is docked low and off-centre, so the screen
  // above it is nothing like the screen below it, and one shared radius would
  // mean the eyes could reach the top edge or the bottom edge but not both.
  const span = MIN_SPAN * Math.min(vw, vh);
  const spanX = Math.max(dx < 0 ? input.center.x : vw - input.center.x, span);
  const spanY = Math.max(dy < 0 ? input.center.y : vh - input.center.y, span);

  const near = clamp(1 - distance / (Math.hypot(vw, vh) * REACH));
  const curiousBand = clamp((near - (1 - CURIOUS_AT)) / CURIOUS_AT);
  const interest = curiousBand * curiousBand;

  return {
    x: reachCurve(dx / spanX),
    y: reachCurve(dy / spanY),
    weight: engagement,
    // A DELIBERATE target is worth being interested in from across the room:
    // the character noticing the checkout button is the whole point of §10, and
    // that button is often nowhere near the navigation bar.
    curiosity: clamp((input.deliberate ? Math.max(interest, 0.6) : interest) * engagement),
  };
}

/**
 * FRAME-RATE INDEPENDENT FOLLOWING.
 *
 * The brief asks for eyes that LAG behind the cursor rather than teleporting
 * to it. The obvious `value += (target - value) * 0.1` does that — and its
 * speed then depends on how fast the display refreshes, so the same character
 * is noticeably more sluggish on a 120Hz phone than on a 60Hz laptop. Solving
 * the exponential properly costs one `Math.exp` and removes the dependency:
 * `tau` is the time constant in SECONDS and means the same thing everywhere.
 */
export function follow(current: number, target: number, dt: number, tau: number): number {
  if (!(dt > 0) || !(tau > 0)) return target;
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

/** The same, for a whole attention. The direction follows faster than the
 *  weight: the character turns towards a thing quickly and commits to it
 *  slowly, which is the order a real glance happens in. */
export function followAttention(current: Attention, target: Attention, dt: number, scale = 1): Attention {
  const dir = 0.13 * scale;
  const commit = 0.4 * scale;
  return {
    x: follow(current.x, target.x, dt, dir),
    y: follow(current.y, target.y, dt, dir),
    weight: follow(current.weight, target.weight, dt, commit),
    curiosity: follow(current.curiosity, target.curiosity, dt, commit * 1.4),
  };
}

/**
 * HOW LONG THE CHARACTER HOLDS A GAZE AFTER THE USER STOPS, in seconds.
 *
 * The brief asks for two to three seconds, randomised so it never reads as a
 * timer. `roll` is a 0..1 value the caller supplies — from the seeded
 * generator the rest of the character uses, so this stays a pure function and
 * the whole system remains samplable.
 */
export function releaseDelay(roll: number): number {
  return 2 + clamp(roll) * 1.2;
}

/**
 * The engagement multiplier at a given time after the last user activity.
 *
 * Full until the hold expires, then a slow fade rather than a cut — the brief
 * is explicit that the eyes must not snap back to centre. The fade is over
 * 1.1s, long enough to read as letting go and short enough that the character
 * is demonstrably back to its own life before anyone wonders.
 */
export function engagementAfter(sinceActivity: number, hold: number): number {
  if (sinceActivity <= hold) return 1;
  return clamp(1 - (sinceActivity - hold) / 1.1);
}
