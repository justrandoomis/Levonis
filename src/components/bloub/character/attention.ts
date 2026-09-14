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
   * Unit direction from the character to the thing it attends to, in SCREEN
   * space: x grows right, y grows DOWN. The engine flips y itself when it
   * turns this into a pitch, because a head that looks up is a positive pitch
   * and a point above the character has a negative y.
   */
  x: number;
  y: number;
  /** 0..1 — how much of the gaze the target claims. Zero is indistinguishable
   *  from having no target at all, which is what makes releasing attention a
   *  fade rather than a switch. */
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
 * How far away a thing can be and still be worth turning towards, as a
 * fraction of the viewport's diagonal.
 *
 * Generous on purpose. The character usually lives in the bottom navigation
 * bar, so on a phone almost everything the user touches is within a third of
 * a diagonal of it, and a tighter reach would mean the mascot ignored the page
 * it sits under. What keeps this from becoming a mascot that stares at
 * everything is the SHAPE of the falloff below, not the radius.
 */
const REACH = 0.62;

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
 * The falloff is deliberately not linear in distance. Linear falloff gives a
 * character that is always half-interested in everything, which reads as
 * vacancy rather than attention. A smoothstep concentrates the response near
 * the character and lets it genuinely ignore the far corners of a desktop
 * window — and ignoring things is most of what makes noticing them legible.
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

  const diagonal = Math.hypot(Math.max(1, input.viewport.w), Math.max(1, input.viewport.h));
  const reach = diagonal * REACH;
  const near = clamp(1 - distance / reach);
  // smoothstep: flat at both ends, steep in the middle.
  const proximity = near * near * (3 - 2 * near);

  const curiousBand = clamp((near - (1 - CURIOUS_AT)) / CURIOUS_AT);
  const interest = curiousBand * curiousBand;

  return {
    x: dx / distance,
    y: dy / distance,
    // A DELIBERATE target is worth looking at from across the room: the
    // character noticing the checkout button is the whole point of §10, and
    // that button is often nowhere near the navigation bar.
    weight: clamp((input.deliberate ? Math.max(proximity, 0.72) : proximity) * engagement),
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
