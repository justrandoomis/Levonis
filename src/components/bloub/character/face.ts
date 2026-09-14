import { clamp, createRng, deg, loopNoise } from './math';

/**
 * THE EYES ARE PAINTED ON A SPHERE, NOT SLID ACROSS A FACE.
 *
 * This is the one idea that separates a character from a smiley. Two dots
 * translated by a few pixels read as two dots being translated; they never
 * read as *looking*. What the eye actually recognises as a gaze is the set of
 * things that happen together when a head turns: the far eye narrows, both
 * eyes shift by different amounts, the pair tilts, and past a certain angle
 * one of them leaves round the side.
 *
 * Reproducing those four effects separately is hopeless — they have to stay in
 * agreement or the face looks broken. So we do not reproduce them at all: we
 * model an actual head orientation and project it. Each eye is given the
 * tangent frame of the sphere at its own position, flattened orthographically
 * to the screen. The narrowing, the tilt and the disappearance then fall out
 * of the projection for free, and they cannot disagree with each other because
 * there is only one thing being computed.
 *
 * The technique is taken from the Bloub reference the brief names
 * (github.com/jeremy-prt/bloub, src/bot/face.ts). The constants below are NOT
 * its constants: they are retuned for a character that is read at 80px inside
 * a navigation bar rather than at 400px on a landing page.
 */

type Vec3 = [number, number, number];

/** Radius of the invisible sphere the face is painted on, in viewBox units.
 * The body is drawn at ~42, so even at full gaze an eye stays 16 units clear
 * of the silhouette — the reference needed a whole solver module for this
 * because its bodies go to triangles and droplets; ours stays a soft blob, so
 * margin is enough and a solver would be ceremony. */
export const FACE_R = 25;

/** Half the angular separation of the eyes on the sphere, degrees. Chosen so
 * the two eyes sit ~1.5 eye-widths apart centre to centre at rest, the ratio
 * the reference lands on and the one that reads as a face rather than as two
 * unrelated marks. */
export const EYE_SPLIT = 13;

/** Neutral eye, full extents in viewBox units.
 *
 * The old face used 7.6 x 9.6 — nearly round. Roundness is exactly what makes
 * an eye unable to say anything: a circle has no axis to squint along, close
 * along, or tilt. A tall capsule can narrow to a happy arc, widen to alarm,
 * and tilt in mirror to read as concern, all without changing anything else.
 * 2.2:1 is the reference's ratio and it survives the size drop intact. */
export const EYE_W = 7.6;
export const EYE_H = 16.6;

/**
 * Where the head rests.
 *
 * Deliberately NOT (0, 0, 0). A head aimed exactly down the camera axis reads
 * as vacant — there is no volume in it, because every depth cue is at its
 * null. A few degrees of yaw give the sphere away, and a positive pitch (the
 * character looking very slightly up) is the difference between attentive and
 * absent. The reference makes the same choice and its comment is worth
 * keeping: the rest pitch is ABSOLUTE, not relative to the current expression,
 * so changing mood does not drop the eyes.
 */
export const REST_GAZE: HeadGaze = { yaw: 8, pitch: 7, roll: -3 };

export interface HeadGaze {
  /** Yaw in degrees; positive looks to the character's right (screen right). */
  yaw: number;
  /** Pitch in degrees; positive looks up. */
  pitch: number;
  /** Roll in degrees; the head tipping within its own plane. */
  roll: number;
}

export interface EyePose {
  x: number;
  y: number;
  /** Tangent 2x2, in SVG `matrix(a,b,c,d,e,f)` order. */
  a: number;
  b: number;
  c: number;
  d: number;
  /** z of the eye's outward normal. Negative means it has gone behind the
   * sphere and must not be drawn. */
  depth: number;
}

/** Rotate two vectors of an orthonormal frame within the plane they span. */
function spin(u: Vec3, v: Vec3, angle: number): [Vec3, Vec3] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
  ];
}

/**
 * The head's frame, then each eye's.
 *
 * Screen axes: x right, y DOWN (SVG), z towards the viewer. Index 0 is the
 * character's left eye on screen, index 1 its right.
 */
export function eyePoses(gaze: HeadGaze, scale = FACE_R, split = EYE_SPLIT): [EyePose, EyePose] {
  let f: Vec3 = [0, 0, 1];
  let right: Vec3 = [1, 0, 0];
  let down: Vec3 = [0, 1, 0];

  // Yaw tips forward towards right.
  [f, right] = spin(f, right, deg(gaze.yaw));
  // Pitch tips down towards forward, so a positive pitch raises the gaze.
  [down, f] = spin(down, f, deg(gaze.pitch));
  // Roll turns the head inside its own plane.
  [right, down] = spin(right, down, deg(gaze.roll));

  const build = (side: number): EyePose => {
    const [ef, er] = spin(f, right, deg(split * side));
    return {
      x: ef[0] * scale,
      y: ef[1] * scale,
      a: er[0],
      b: er[1],
      c: down[0],
      d: down[1],
      depth: ef[2],
    };
  };

  return [build(-1), build(1)];
}

/**
 * Compose an eye's own tilt and its lid closure onto the tangent frame.
 *
 * `tilt` is the eye rotating inside the surface it is painted on — this is the
 * lever that expresses concern and displeasure, because those need the two
 * eyes tilted in MIRROR, which head roll can never produce (roll tips both the
 * same way).
 *
 * `lid` is applied last and in SCREEN space, scaling only the y outputs. A
 * blink squashes an eye vertically as you look at it; it does not shorten the
 * capsule along its own inclined axis. Composing it before the tangent frame
 * would do the latter and looks like the eye shrinking rather than closing.
 */
export function eyeMatrix(pose: EyePose, tiltDeg: number, lid: number): [number, number, number, number] {
  const th = deg(tiltDeg);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const a = pose.a * c + pose.c * s;
  const cc = pose.c * c - pose.a * s;
  const b = pose.b * c + pose.d * s;
  const dd = pose.d * c - pose.b * s;
  const k = lidScale(lid);
  return [a, b * k, cc, dd * k];
}

/** A closed lid keeps a sliver rather than vanishing: an eye that reaches zero
 * height disappears for a frame and reads as a dropout, not a blink. */
export function lidScale(lid: number): number {
  return 0.05 + 0.95 * clamp(lid);
}

/* ------------------------------------------------------------ idle life */

export interface Liveliness {
  dYaw: number;
  dPitch: number;
  dRoll: number;
  /** 1 open, 0 closed. */
  lid: number;
  driftX: number;
  driftY: number;
  /** Multiplier on body height only. */
  breath: number;
}

const BLINK_RNG = createRng(0x1e0075);

/**
 * A blink CALENDAR, drawn once at module load from a seeded generator.
 *
 * Not `Math.random()` per frame, and not a CSS keyframe either. A keyframe
 * blinks on a metronome, which the eye picks up within three repetitions and
 * which is the single loudest tell that a character is a decoration. Real
 * blinking is irregular but not arbitrary: roughly every two to five seconds,
 * occasionally twice in quick succession. A pre-drawn schedule gives exactly
 * that, while keeping the whole system a pure function of time — the same
 * second of the clock always produces the same frame, so nothing drifts when
 * the tab is hidden and resumed.
 */
/**
 * How long the schedules run before they wrap.
 *
 * They HAVE to wrap. A schedule that simply ends stops working — a storefront
 * left open on a counter would blink for ten minutes and then stare — and a
 * schedule scanned from the start every frame gets slower the longer the tab
 * has been open, because the scan is as long as the elapsed time. Ten minutes
 * of irregular rhythm repeating is not something anyone will ever notice; a
 * character that stops blinking is.
 */
const SPAN = 600;

const BLINKS: number[] = (() => {
  const out: number[] = [];
  let t = 1.1;
  // Stop early enough that no blink is cut in half by the wrap.
  while (t < SPAN - 1) {
    out.push(t);
    t += 2.0 + BLINK_RNG() * 3.0;
    // A double blink now and then. Without it the rhythm is irregular but
    // still uniform, and uniform irregularity is its own kind of pattern.
    if (BLINK_RNG() < 0.17 && t < SPAN - 1) {
      out.push(t);
      t += 0.26;
    }
  }
  return out;
})();

/** Index of the last entry at or before `t`, or -1. Binary search rather than a
 * scan so the cost is the same on the first frame and the millionth. */
function lastAtOrBefore(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** Blink duration. Closing is faster than opening, which is how eyelids
 * actually work and is the difference between a blink and a wince. */
const BLINK_DUR = 0.19;
const BLINK_CLOSE = 0.42;

export function blinkLid(t: number, schedule: readonly number[] = BLINKS): number {
  const now = ((t % SPAN) + SPAN) % SPAN;
  const i = lastAtOrBefore(schedule, now);
  if (i < 0) return 1;
  const k = (now - schedule[i]!) / BLINK_DUR;
  if (k > 1) return 1;
  return k < BLINK_CLOSE ? 1 - k / BLINK_CLOSE : (k - BLINK_CLOSE) / (1 - BLINK_CLOSE);
}

/**
 * Everything the character does while nothing is happening to it.
 *
 * Returned as OFFSETS to add to whatever pose the current state asks for, so
 * idle life keeps running underneath a reaction instead of being replaced by
 * it — a character that stops breathing the moment it smiles is a puppet.
 *
 * The periods (11.3, 3.7, 9.1, 4.3, 13.7, 7.9, 5.3, 6.1) are mutually
 * incommensurable on purpose. Their sum has no period a person will ever sit
 * through, so watching for thirty seconds — the bar the brief sets — shows no
 * repetition to catch. `wander` scales the whole thing so a state that needs
 * the character to hold still can damp it without turning it off.
 */
export function liveliness(t: number, opt: { wander?: number; float?: boolean } = {}): Liveliness {
  const { wander = 1, float = true } = opt;
  return {
    dYaw: (loopNoise(t, 11.3, 0.4) * 5.2 + loopNoise(t, 3.7, 2.1) * 1.4) * wander,
    dPitch: (loopNoise(t, 9.1, 1.3) * 3.8 + loopNoise(t, 4.3, 0.7) * 1.2) * wander,
    dRoll: loopNoise(t, 13.7, 3.2) * 2.0 * wander,
    lid: blinkLid(t),
    // The body itself is almost still. All the life is in the gaze and the
    // lids; a body that visibly wobbles at rest reads as a loading animation,
    // which is the specific thing the brief rules out. These are fractions of
    // the body radius — under a third of a viewBox unit at rest.
    driftX: float ? loopNoise(t, 7.9, 1.9) * 0.007 : 0,
    driftY: float ? loopNoise(t, 5.3, 0.3) * 0.008 : 0,
    breath: float ? 1 + Math.sin((t / 6.1) * Math.PI * 2) * 0.007 : 1,
  };
}

/**
 * SACCADES: the gaze does not glide, it holds and then flicks.
 *
 * `liveliness` alone gives a smooth continuous drift, and smooth continuous
 * drift is how a balloon moves, not how an eye does. Real gaze is mostly
 * STILL, punctuated by fast jumps. This returns a settle-weighted step towards
 * a new resting direction at irregular intervals, which is what produces the
 * "glances around, then pauses" the brief asks for — the pauses are the point,
 * and they are the part a keyframe loop cannot express.
 */
const SACCADE_RNG = createRng(0x5acc);
const SACCADES: Array<{ at: number; yaw: number; pitch: number }> = (() => {
  const out: Array<{ at: number; yaw: number; pitch: number }> = [];
  let t = 2.4;
  while (t < SPAN - 1) {
    out.push({
      at: t,
      yaw: (SACCADE_RNG() * 2 - 1) * 11,
      pitch: (SACCADE_RNG() * 2 - 1) * 7,
    });
    // Between 1.8s and 6.3s of stillness. The long end matters more than the
    // short end: it is the long holds that make the short moves read as
    // deliberate rather than nervous.
    t += 1.8 + SACCADE_RNG() * 4.5;
  }
  return out;
})();

/** The flick times alone, hoisted so the per-frame lookup allocates nothing.
 * Building this inside `saccade` cost one array per frame — sixty a second,
 * for the lifetime of the tab, to answer a question whose answer never
 * changes. */
const SACCADE_TIMES: readonly number[] = SACCADES.map((s) => s.at);

/** How long a flick takes. Eyes are quick — anything slower than this stops
 * being a saccade and becomes a pan. */
const SACCADE_DUR = 0.13;

export function saccade(t: number, schedule = SACCADES): { yaw: number; pitch: number } {
  const now = ((t % SPAN) + SPAN) % SPAN;
  const i = lastAtOrBefore(schedule === SACCADES ? SACCADE_TIMES : schedule.map((s) => s.at), now);
  if (i < 0) return { yaw: 0, pitch: 0 };
  const cur = schedule[i]!;
  const prev = i > 0 ? schedule[i - 1]! : { yaw: 0, pitch: 0 };
  const k = (now - cur.at) / SACCADE_DUR;
  if (k > 1) return { yaw: cur.yaw, pitch: cur.pitch };
  // Ease-out on a flick: it leaves fast and arrives soft, so it lands rather
  // than stopping dead.
  const e = 1 - (1 - k) ** 3;
  return { yaw: prev.yaw + (cur.yaw - prev.yaw) * e, pitch: prev.pitch + (cur.pitch - prev.pitch) * e };
}
