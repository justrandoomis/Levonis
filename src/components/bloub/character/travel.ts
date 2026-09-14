import { clamp, damped, easings, phaseProgress, travelEase } from './math';

/**
 * A JOURNEY, NOT A TRANSITION.
 *
 * What the character used to do between two docks was a single CSS
 * `transition: transform 520ms`. One curve, applied to position and scale
 * together, starting the instant the destination was known. That is why it
 * read as a thing being moved rather than a thing going somewhere: nothing
 * preceded the motion, nothing trailed it, and the size changed in lockstep
 * with the position, which nothing physical ever does.
 *
 * A journey here has four beats, and they overlap:
 *
 *   ANTICIPATION  the gaze turns to the destination and the body gathers very
 *                 slightly away from it. This beat is what makes the departure
 *                 legible: the viewer knows where the character is going
 *                 before it goes, so the movement confirms an intention
 *                 instead of surprising them.
 *   TRAVEL        position on its own curve, scale on a different and later
 *                 one, so the character is still nearly full size as it leaves
 *                 and does its shrinking into the dock.
 *   DECELERATION  the tail of the travel curve, long on purpose.
 *   SETTLE        the body's mass catches up: one damped squash, no positional
 *                 overshoot. Position overshoot is a bounce and the brief
 *                 rules it out; shape overshoot is weight and the brief asks
 *                 for it.
 */

export interface TravelFrame {
  x: number;
  y: number;
  size: number;
}

export type TravelPhase = 'anticipate' | 'move' | 'settle' | 'done';

export interface TravelPlan {
  from: TravelFrame;
  to: TravelFrame;
  /** Direction of travel in radians, screen frame (y down). */
  angle: number;
  distance: number;
  anticipate: number;
  move: number;
  settle: number;
  total: number;
  /** How far the wind-up pulls back, in pixels, opposite the travel. */
  windup: number;
  /** A journey planned under a reduced-motion preference carries the flag, so
   * every sample of it is flat. Zeroing only the wind-up was not enough: the
   * stretch and the arrival squash are derived from SPEED, and a reduced
   * journey still has speed, so the body went on deforming. */
  reduced: boolean;
}

export interface TravelSample {
  x: number;
  y: number;
  size: number;
  phase: TravelPhase;
  /** 0..1 — how strongly the gaze should point at the destination. */
  lead: number;
  /** Stretch along the direction of travel, fraction of the radius. */
  stretch: number;
  /** Bulge trailing the direction of travel. */
  trail: number;
  /** Vertical impact squash. */
  squash: number;
  /** Direction of travel, carried through so the body and gaze agree. */
  angle: number;
  /** 0..1 over the whole journey, for anything that just needs progress. */
  progress: number;
}

/** Below this the two docks are effectively the same place: a relayout of a
 * few pixels is not a journey and must not be animated as one, or every
 * keyboard appearance would launch the character across the screen. */
const MIN_DISTANCE = 6;

export function planTravel(from: TravelFrame, to: TravelFrame, opts: { reduced?: boolean; boot?: boolean } = {}): TravelPlan {
  const dx = to.x + to.size / 2 - (from.x + from.size / 2);
  const dy = to.y + to.size / 2 - (from.y + from.size / 2);
  const distance = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  if (opts.reduced) {
    // Reduced motion is not "no feedback": it is the same journey without the
    // vestibular part. The character still crosses, briefly, and still looks
    // where it is going — it simply does not wind up, stretch or squash.
    return { from, to, angle, distance, anticipate: 0, move: 0.2, settle: 0, total: 0.2, windup: 0, reduced: true };
  }

  // Duration follows distance, but sub-linearly: a journey twice as long
  // should not feel twice as slow, or crossing a tablet becomes a wait.
  const move = clamp(0.34 + Math.sqrt(distance) * 0.022, 0.34, 0.82);
  // The first arrival earns a longer wind-up than a page change, because it
  // is the one moment the character has the viewer's whole attention.
  const anticipate = opts.boot ? 0.34 : clamp(0.13 + distance * 0.00035, 0.13, 0.26);
  const settle = 0.4;
  return {
    from,
    to,
    angle,
    distance,
    anticipate,
    move,
    settle,
    total: anticipate + move + settle,
    // Capped hard. Anticipation is a hint, and a hint that is visible as a
    // movement in the wrong direction has become a mistake.
    windup: Math.min(distance * 0.035, 7),
    reduced: false,
  };
}

export function isTravelWorthAnimating(plan: TravelPlan): boolean {
  return plan.distance >= MIN_DISTANCE || Math.abs(plan.to.size - plan.from.size) >= 2;
}

/**
 * The gaze lead: up fast during the wind-up, held through most of the travel,
 * then released before the body has finished settling so the eyes are already
 * back on the viewer when the character stops.
 *
 * Shared with the reduced-motion path on purpose. Dropping the wind-up, the
 * stretch and the squash is the right response to that preference; dropping
 * the part that tells the viewer where the character is going is not — that is
 * comprehension, and the guidance is to keep what aids it.
 */
function lead0(plan: TravelPlan, aP: number, mP: number, sP: number, phase: TravelPhase): number {
  if (phase === 'anticipate') return easings.easeOutQuint(aP);
  if (phase === 'move') return 1 - easings.easeInQuad(clamp((mP - 0.62) / 0.38)) * 0.55;
  return 0.45 * (1 - easings.easeOutCubic(sP));
}

export function sampleTravel(plan: TravelPlan, elapsed: number): TravelSample {
  const { from, to, anticipate, move, settle, angle } = plan;
  const fromCx = from.x + from.size / 2;
  const fromCy = from.y + from.size / 2;
  const toCx = to.x + to.size / 2;
  const toCy = to.y + to.size / 2;

  const aP = phaseProgress(elapsed, 0, anticipate);
  const mP = phaseProgress(elapsed, anticipate, move);
  const sP = phaseProgress(elapsed, anticipate + move, settle);

  const phase: TravelPhase =
    elapsed >= plan.total ? 'done' : mP >= 1 ? 'settle' : aP >= 1 ? 'move' : 'anticipate';

  // Wind-up: out and back on a symmetrical curve so it reads as gathering,
  // never as a false start. It is fully spent by the time travel begins.
  const windOut = anticipate > 0 ? Math.sin(aP * Math.PI) * plan.windup : 0;
  const windX = -Math.cos(angle) * windOut;
  const windY = -Math.sin(angle) * windOut;

  const pos = travelEase(mP);
  const cx = fromCx + (toCx - fromCx) * pos + windX * (1 - mP);
  const cy = fromCy + (toCy - fromCy) * pos + windY * (1 - mP);

  // SCALE IS NOT POSITION. It starts a little after the body does and lands a
  // little before, on a gentler curve, so the character shrinks *into* its
  // dock rather than the two changes reading as one linear resize.
  const sizeP = easings.easeInOutCubic(clamp((mP - 0.1) / 0.82));
  const size = from.size + (to.size - from.size) * sizeP;

  // Speed drives the deformation, so the body is stretched exactly when it is
  // moving fastest and round again the instant it stops. Differentiating the
  // travel curve numerically keeps that true even if the curve is retuned.
  const h = 0.012;
  const speed = move > 0 ? Math.abs(travelEase(clamp(mP + h)) - travelEase(clamp(mP - h))) / (2 * h) : 0;
  const reach = clamp(plan.distance / 320);
  // Coefficients sized so the fastest possible journey peaks just under the
  // ceiling rather than against it. A clipped peak holds one deformation flat
  // for a few frames, and a body that stops deforming while it is still
  // accelerating is the exact "freeze during movement" the brief forbids.
  if (plan.reduced) {
    return { x: cx - size / 2, y: cy - size / 2, size, phase, lead: clamp(lead0(plan, aP, mP, sP, phase)), stretch: 0, trail: 0, squash: 0, angle, progress: plan.total > 0 ? clamp(elapsed / plan.total) : 1 };
  }
  const stretch = phase === 'anticipate' ? 0 : clamp(speed * 0.034 * reach, 0, 0.12);
  const trail = phase === 'anticipate' ? 0 : clamp(speed * 0.016 * reach, 0, 0.06);

  // One damped squash on arrival. Amplitude follows how far it came, so a
  // short hop lands quietly and the long first journey lands with weight.
  const squash = settle > 0 && sP > 0 && sP < 1 ? damped(sP) * 0.075 * reach : 0;

  const lead = lead0(plan, aP, mP, sP, phase);

  return {
    x: cx - size / 2,
    y: cy - size / 2,
    size,
    phase,
    lead: clamp(lead),
    stretch,
    trail,
    squash,
    angle,
    progress: plan.total > 0 ? clamp(elapsed / plan.total) : 1,
  };
}
