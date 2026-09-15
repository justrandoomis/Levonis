import type { MascotState } from '../../../lib/mascot';
import { clamp, easings, lerp, type Easing } from './math';
import type { Attention } from './attention';
import { EYE_SPLIT, REST_GAZE, type HeadGaze } from './face';

/**
 * WHAT THE CHARACTER LOOKS LIKE IN EACH STATE — declared, never computed.
 *
 * Every entry here is a constant. The engine's only job at runtime is to
 * interpolate between two of them on a named curve. That constraint is load
 * bearing and comes straight from the reference's hardest-won lesson: an
 * earlier version of its eye placement re-solved geometry every frame and
 * every variant of it shimmered, jumped or swelled, not because any of the
 * geometry was wrong but because re-solving per frame is not monotone.
 * Interpolating between two constants is monotone by construction, so a whole
 * class of motion artefact simply cannot occur.
 *
 * The face has four levers and only four: where the head is pointed, how far
 * apart the eyes sit on it, the proportions of each eye, and each eye's own
 * tilt. The last is what makes concern possible — it needs the two eyes tilted
 * in MIRROR, and head roll can only tip both the same way.
 */

/** Per-eye geometry. `w`/`h` multiply the neutral eye; `tilt` is degrees
 * within the sphere's surface, positive tipping the capsule's top towards
 * screen right; `open` is the lid before idle blinking is added.
 *
 * COMPUTED, not asserted: at tilt +17 the top of the screen-LEFT capsule moves
 * 2.35 units RIGHT, i.e. inwards. So a POSITIVE tilt on `eyes[0]` converges the
 * two tops (Λ) and a negative one diverges them (V). tests/mascotGaze.test.ts
 * re-derives that from eyePoses/eyeMatrix rather than trusting this sentence,
 * because a comment asserting the opposite is exactly how the angry face
 * shipped. */
export interface EyeCfg {
  w: number;
  h: number;
  tilt: number;
  open: number;
}

/** The mouth. Small enough a full path table would be overkill, expressive
 * enough that leaving it out costs a whole register of feeling. `curve` is the
 * smile: positive lifts the corners, negative drops them. */
export interface MouthCfg {
  width: number;
  curve: number;
  open: number;
  y: number;
  /** Stroke weight multiplier — a heavier line reads as a firmer expression. */
  weight: number;
}

export interface Pose {
  gaze: HeadGaze;
  split: number;
  eyes: [EyeCfg, EyeCfg];
  mouth: MouthCfg;
  /** How much idle drift survives in this state. A reacting character should
   * not stop breathing, but it should not keep wandering either. */
  wander: number;
  /** How much of the idle blink calendar reaches the eyes, 0..1.
   *
   * A weight rather than a flag because it has to INTERPOLATE. As a boolean it
   * was switched at the halfway point of a blend, so a blend that crossed the
   * midpoint while an eye was halfway shut snapped it open in a single frame —
   * a face changing abruptly, which is the one thing the brief rules out. */
  blink: number;
  /** How much of the searching sweep the gaze performs, 0..1.
   *
   * Also a weight, and for the same reason: as a `state === 'loading'` test in
   * the engine it added fifteen degrees of yaw the instant work began and
   * removed them the instant it ended, so the whole face jumped twice per
   * request. Carried on the pose, it arrives and leaves on the blend. */
  sweep: number;

  /** Resting deformation of the body: how much it bulges, and how fast the
   * bulge travels round the outline. Zero is a perfect blob. */
  wobble: number;
  wobbleRate: number;
  /** Uniform scale applied to the whole body. Reactions that need presence
   * grow by a couple of percent; nothing here ever pulses. */
  swell: number;

  /** Resting vertical squash — how pressed the body is, 0..1-ish.
   *
   * The press used to be a sine pulse driven by the tap state's own age, which
   * made it a step at both ends: the pulse was keyed off `state === 'tap'`, so
   * the instant the state changed the squash vanished in a single frame. As a
   * pose field the blends provide the shape for free — 70ms in, because a
   * press must answer immediately, and the following state's own blend out. */
  squash: number;
  /** How long the change INTO this state takes, seconds, and on what curve.
   * These differ per state on purpose — the brief forbids one shared spring,
   * and the reason is physical: falling asleep and flinching are not the same
   * kind of event and must not share a duration. */
  blend: number;
  ease: Easing;
}

const eye = (w = 1, h = 1, tilt = 0, open = 1): EyeCfg => ({ w, h, tilt, open });
/** Both eyes alike, tilts mirrored — the only lever that reaches concern, since
 * head roll can only ever tip both the same way. `tilt` is given to the
 * screen-LEFT eye, so a POSITIVE argument converges the tops (Λ, concern or a
 * squeezed smile) and a negative one diverges them (V, the angry brow). No pose
 * in this table is allowed to be negative. */
const pair = (w = 1, h = 1, tilt = 0, open = 1): [EyeCfg, EyeCfg] => [eye(w, h, tilt, open), eye(w, h, -tilt, open)];
const mouth = (width = 1, curve = 1, open = 0, y = 0, weight = 1): MouthCfg => ({ width, curve, open, y, weight });

const BASE: Pose = {
  gaze: { ...REST_GAZE },
  split: EYE_SPLIT,
  eyes: pair(),
  mouth: mouth(1, 1, 0, 0, 1),
  wander: 1,
  blink: 1,
  sweep: 0,
  squash: 0,
  wobble: 0.006,
  wobbleRate: 0.17,
  swell: 1,
  blend: 0.42,
  ease: easings.easeOutCubic,
};

const make = (over: Partial<Pose>): Pose => ({ ...BASE, ...over });

export const POSES: Record<MascotState, Pose> = {
  /** Calm, attentive, looking very slightly up and past the viewer. */
  idle: BASE,

  /**
   * Working. The eyes narrow a little and the head lifts, which is what a
   * face does when it is attending to something rather than at rest. The
   * searching sweep itself is not here — it is time-driven, and the engine
   * adds it, because a static pose cannot express "still looking".
   */
  loading: make({
    gaze: { yaw: 4, pitch: 11, roll: -2 },
    // Barely narrowed, where this used to be 0.94 x 0.84. At the 80px the
    // character is drawn, a sixth off the height of the capsule is not
    // "attending", it is a squint — and "loading, then failed" is the commonest
    // state pair in the app, so that squint was the first half of every angry
    // frame the user saw. Concentration is a fraction of a unit, not a sixth.
    eyes: pair(1.0, 0.92),
    mouth: mouth(0.7, 0.2, 0, 0.6, 0.9),
    sweep: 1,
    wander: 0.45,
    wobble: 0.02,
    wobbleRate: 0.42,
    blend: 0.5,
    ease: easings.easeInOutCubic,
  }),

  /** Someone is typing to us. Listening, not performing: the head tips a
   * little and the eyes open slightly, and that is the whole gesture. */
  typing: make({
    gaze: { yaw: 6, pitch: 2, roll: -7 },
    eyes: pair(1.08, 1.05),
    mouth: mouth(0.55, 0.35, 0, 0.4, 0.85),
    wander: 0.55,
    wobble: 0.009,
    wobbleRate: 0.3,
    blend: 0.38,
  }),

  /**
   * On its way somewhere. Short blend on purpose: this pose has to be on the
   * face BEFORE the body starts moving, or the character reads as being
   * dragged rather than going. The direction it looks is supplied by the
   * travel plan, not by this table.
   */
  navigating: make({
    eyes: pair(1.02, 0.95),
    mouth: mouth(0.7, 0.55, 0, 0.2, 0.9),
    wander: 0.25,
    wobble: 0.004,
    blend: 0.26,
    ease: easings.easeOutQuint,
  }),

  /** Coming home. Same mechanics as navigating, a touch warmer. */
  returning: make({
    eyes: pair(1.02, 0.98),
    mouth: mouth(0.78, 0.7, 0, 0.15, 0.9),
    wander: 0.25,
    wobble: 0.004,
    blend: 0.26,
    ease: easings.easeOutQuint,
  }),

  /** Just landed. A beat of slightly wider eyes before calm returns — the
   * visual equivalent of catching one's breath. */
  arrival: make({
    eyes: pair(1.1, 1.06),
    mouth: mouth(0.9, 0.85),
    wander: 0.5,
    blend: 0.2,
    ease: easings.easeOutQuint,
  }),

  /** Something worked. Eyes squeezed into arcs, tops converging — the shape a
   * real smile makes of them — and the mouth follows rather than leads. */
  success: make({
    gaze: { yaw: 5, pitch: 12, roll: 0 },
    split: EYE_SPLIT + 2,
    eyes: pair(1.16, 0.32, 15),
    mouth: mouth(1.15, 1.6, 0.25, -0.2, 1.15),
    wander: 0.4,
    blink: 0,
    swell: 1.025,
    blend: 0.24,
    ease: easings.easeOutQuint,
  }),

  /** Something arrived. The head squares up to the viewer — dropping the
   * resting yaw is itself the signal of having been noticed — and the eyes
   * open wide. */
  notify: make({
    gaze: { yaw: 2, pitch: 4, roll: 1 },
    split: EYE_SPLIT + 3,
    eyes: pair(1.22, 1.18),
    mouth: mouth(0.6, 0.5, 0.15, 0.3, 0.95),
    wander: 0.3,
    swell: 1.02,
    blend: 0.18,
    ease: easings.easeOutQuint,
  }),

  /** Touched. Near-instant, because feedback that waits for the release is
   * feedback that has already been missed. */
  tap: make({
    eyes: pair(1.05, 0.5, 0, 0.55),
    mouth: mouth(0.85, 1.1, 0, 0.1),
    squash: 0.055,
    wander: 0.2,
    blink: 0,
    blend: 0.07,
    ease: easings.easeOutQuint,
  }),

  /**
   * Something failed — and the character is CONCERNED about it, never cross.
   *
   * This pose shipped inverted: it tilted the tops apart into a V, narrowed the
   * eyes and hung the heaviest frown in the table under them, which is the
   * canonical angry face, under a comment claiming a V was the geometry of
   * worry. It is not. Worry CONVERGES the tops (Λ) — that is the raised inner
   * brow — so the tilt is positive here and nothing in the table is negative.
   *
   * Three things carry it beyond the sign. The eyes stay TALLER and wider than
   * neutral (1.08 of a 19.3-unit capsule): on a tall eye a converging tilt
   * reads as worry, on a narrowed one it reads as a pinch, and a pinch is the
   * other half of a glower. The mouth is a small open "o" — `open` deepens the
   * bow in the SMILE direction while lifting the corners, so a round little
   * mouth is a short `width` plus a large `open`, never a negative `curve`; its
   * stroke drops to 1.0 because a flat mouth at a heavy weight is a set jaw.
   * And the head comes UP and cocks four degrees: alarm looks AT you and tips
   * to one side, sulking looks at the floor. Roll is safe to spend on that —
   * it tips both eyes the same way and can never make the mirrored V.
   */
  error: make({
    gaze: { yaw: -3, pitch: 4, roll: 4 },
    split: EYE_SPLIT + 2,
    eyes: pair(1.16, 1.08, 7),
    mouth: mouth(0.36, 0.1, 0.8, 0.2, 1),
    wander: 0.4,
    wobble: 0.012,
    wobbleRate: 0.75,
    swell: 1.015,
    blend: 0.16,
    ease: easings.easeOutQuint,
  }),

  /** A smaller concern. Same four levers as error at about half the amplitude,
   * so the two read as one character at two intensities rather than two moods.
   * Worth being careful with: `warning` fires far more often than `error`, so
   * whatever grammar it uses is the one users actually live with — which is
   * why it faithfully reproduced the angry geometry for as long as error did.
   * The mouth here is very nearly the flat line a small concern wants, lifted
   * just enough that its stroke cannot read as a stern bar. */
  warning: make({
    gaze: { yaw: 4, pitch: 2, roll: 3 },
    split: EYE_SPLIT + 1,
    eyes: pair(1.08, 1.02, 4),
    mouth: mouth(0.58, 0.05, 0.3, 0.3, 0.9),
    wander: 0.5,
    wobble: 0.008,
    wobbleRate: 0.5,
    blend: 0.2,
    ease: easings.easeOutQuint,
  }),

  /**
   * NOTICING. The quietest reaction in the table, and the one that happens
   * most: every time the pointer settles on a control worth attending to.
   *
   * Everything about it is under-stated on purpose. The eyes open a little and
   * the head tips a few degrees — the amount a person's face changes when they
   * see where a conversation is going, not when they are startled. The mouth
   * shortens and lifts into the smallest interested curve the geometry can
   * make. If this read as a REACTION rather than as attention it would fire
   * hundreds of times a session and the character would be exhausting.
   *
   * `wander` stays high: being interested in something does not stop a
   * creature breathing, and dropping it here made the character freeze
   * whenever the pointer crossed a button.
   */
  curious: make({
    gaze: { yaw: 7, pitch: 6, roll: -4 },
    split: EYE_SPLIT + 1,
    eyes: pair(1.08, 1.07, 2),
    mouth: mouth(0.5, 0.45, 0.05, 0.35, 0.85),
    wander: 0.7,
    wobble: 0.008,
    wobbleRate: 0.24,
    blend: 0.3,
    ease: easings.easeOutCubic,
  }),

  /**
   * TAKEN ABACK — a quantity that jumped, a line removed from the cart.
   *
   * The whole expression is in the mouth: a tiny open "o", which is the one
   * shape the single-curve mouth can make that is unmistakably not a smile and
   * not a frown. `open` lifts the corners into a bow while `curve` stays
   * barely positive, so it reads round rather than as a grin.
   *
   * Eyes go WIDE and slightly further apart. Crucially the tilt stays at zero:
   * tilt is what carries worry, and surprise is not worry. «Oh, that's a lot»
   * — not «oh no».
   */
  surprised: make({
    gaze: { yaw: 1, pitch: 5, roll: 0 },
    split: EYE_SPLIT + 3,
    eyes: pair(1.3, 1.26),
    mouth: mouth(0.34, 0.15, 0.95, 0.15, 1.05),
    wander: 0.3,
    swell: 1.03,
    wobble: 0.004,
    blend: 0.13,
    ease: easings.easeOutQuint,
  }),

  /**
   * THE ORDER WENT THROUGH.
   *
   * The same grammar as `success` — eyes squeezed to arcs, tops converging —
   * pushed one notch further and held four times as long, because an order is
   * not an add-to-cart. It is still an arc and a smile, not a jump: the brief
   * asks for stronger, and then asks twice for restrained.
   */
  celebrate: make({
    gaze: { yaw: 3, pitch: 14, roll: 0 },
    split: EYE_SPLIT + 3,
    eyes: pair(1.24, 0.2, 19),
    mouth: mouth(1.05, 1.9, 0.4, -0.3, 1.2),
    wander: 0.45,
    blink: 0,
    swell: 1.045,
    wobble: 0.012,
    wobbleRate: 0.5,
    blend: 0.26,
    ease: easings.easeOutQuint,
  }),

  /**
   * Dormant. The long blend is the expression: you cannot snap into sleepy.
   * Ease-in-out because this is a body settling, not a value landing.
   */
  sleep: make({
    gaze: { yaw: 10, pitch: -12, roll: -6 },
    eyes: pair(1.0, 0.7, 4, 0.1),
    mouth: mouth(0.5, 0.25, 0, 0.7, 0.8),
    wander: 0.25,
    blink: 0,
    swell: 0.985,
    blend: 0.9,
    ease: easings.easeInOutCubic,
  }),
};

/**
 * HOW FAR THE HEAD TURNS TO FOLLOW SOMETHING, at full attention.
 *
 * Under the sphere projection these are real head angles, not pixel offsets,
 * so the far eye narrows and the near one moves further — the whole set of
 * cues that makes a turn read as a turn.
 *
 * These used to be 27/19, held down by a note claiming the far eye leaves round
 * the limb past ~34 degrees. It does not: its depth crosses zero at 77. The
 * real ceiling is the two capsules MERGING, because orthographic projection
 * shrinks the gap between them by cos(yaw) — which is `splitFor`'s job in
 * face.ts, and which the engine's clamp on the COMPOSED gaze backstops. With
 * both of those in place this term is nowhere near any limit (the composed gaze
 * peaks around 30 of the 38 available), so it is set by how far a character
 * SHOULD turn rather than by how far it safely can. Measured through the whole
 * pipeline on a 390x844 phone, the eight edge probes move the eye 17.3 viewBox
 * units horizontally and 14.8 vertically — 20.6% and 17.6% of the body's width,
 * against the 9.05 units / 11% the browser measured before. Raising it further
 * costs nothing structurally and everything in restraint: past about 24 the
 * eyes start to read as swivelling rather than as a head turning.
 */
const TRACK_YAW = 22;
const TRACK_PITCH = 22;

/**
 * THE FACE, TOLD WHAT IT IS LOOKING AT.
 *
 * Attention is applied as a POSE MODIFIER rather than as a separate gaze added
 * downstream, and that is the whole reason the character reads as one creature
 * rather than as a face with a tracking layer bolted to it. The brief's §21 is
 * explicit: gaze, eyes, mouth and body must coordinate. Here they cannot do
 * anything else — one number moves all four, so there is no arrangement of
 * inputs that produces eyes pointed at a button above a mouth that has not
 * noticed it.
 *
 * What changes, and why:
 *  - the head turns towards the target, by `weight`;
 *  - the idle wander is damped by the same amount, because a creature locked
 *    onto something stops drifting — without this the eyes shimmer around the
 *    target and the tracking reads as loose rather than attentive;
 *  - `curiosity` alone opens the eyes and moves them very slightly apart,
 *    which is the face widening rather than merely turning;
 *  - the mouth shortens and lifts a little. This is the smallest of the four
 *    changes and the one that stops a widened pair of eyes reading as alarm;
 *  - and each eye changes SHAPE a few percent with where it is pointed, which
 *    is the difference between a head that turns and a mask that swivels.
 *
 * Returns the SAME pose object when there is nothing to attend to, so the
 * common case allocates nothing.
 */
export function applyAttention(pose: Pose, attention: Attention | null, reduced = false): Pose {
  if (!attention || attention.weight <= 0.002) return pose;
  const w = clamp(attention.weight);
  const c = clamp(attention.curiosity);
  // Reduced motion keeps the gaze — the brief asks for semantic feedback to
  // survive — at a fraction of the swing, and drops the widening entirely.
  const swing = reduced ? 0.45 : 1;
  const open = reduced ? 0 : c;

  // `x`/`y` are signed per-axis excursions in -1..1, already shaped by
  // attention.ts's response curve — NOT a unit direction. That distinction is
  // the whole of §4: a unit vector divides each axis by the full hypotenuse, so
  // on a bottom-docked character the vertical distance ate the horizontal
  // signal and a diagonal arrived at 0.707 of a cardinal. A viewport corner is
  // now 1 on BOTH axes, which is what makes a diagonal read as a diagonal.
  const nx = clamp(attention.x, -1, 1);
  const ny = clamp(attention.y, -1, 1);
  const yaw = nx * TRACK_YAW;
  // Screen y grows downwards; a head that looks up has a POSITIVE pitch.
  const pitch = -ny * TRACK_PITCH;

  const widen = 1 + open * 0.14;
  const tall = 1 + open * 0.1;
  // THE EYE CHANGES SHAPE WITH WHERE IT IS POINTED, by a few percent of itself:
  // a capsule aimed hard sideways shows a little more width, one aimed up opens
  // and one aimed down hoods. Half a unit on an 8.6-wide eye — nobody sees it
  // happen, and its absence is what reads as a decal rather than a face. It
  // rides `morph` rather than `swing` so the motion preference drops it
  // outright: the gaze is semantic and survives, this is not.
  const morph = reduced ? 0 : 1;
  const leanW = 1 + morph * 0.06 * Math.abs(nx);
  const leanH = 1 + morph * (ny < 0 ? 0.07 * -ny : -0.08 * ny);
  // A LEAN: the SAME sign on both eyes. Mirrored tilt is the register concern
  // is authored in, and tracking must never write into it, or looking left
  // would come with a free expression nobody asked for.
  const leanTilt = morph * 3.5 * nx;
  const eyes: [EyeCfg, EyeCfg] = [
    { ...pose.eyes[0], w: pose.eyes[0].w * widen * leanW, h: pose.eyes[0].h * tall * leanH, tilt: pose.eyes[0].tilt + leanTilt },
    { ...pose.eyes[1], w: pose.eyes[1].w * widen * leanW, h: pose.eyes[1].h * tall * leanH, tilt: pose.eyes[1].tilt + leanTilt },
  ];

  return {
    ...pose,
    gaze: {
      yaw: lerp(pose.gaze.yaw, yaw, w * swing),
      pitch: lerp(pose.gaze.pitch, pitch, w * swing),
      // Roll is the character's own tilt, not a property of what it is looking
      // at, so following straightens it out rather than replacing it.
      roll: pose.gaze.roll * (1 - w * 0.55),
    },
    split: pose.split + open * 1.6,
    eyes,
    mouth: {
      ...pose.mouth,
      width: pose.mouth.width * (1 - open * 0.22),
      curve: pose.mouth.curve + open * 0.18,
      y: pose.mouth.y + open * 0.22,
    },
    wander: pose.wander * (1 - w * 0.62),
  };
}

/**
 * How far the body leans towards what it is attending to, as a `stretch`.
 *
 * Three percent at full attention. The brief asks for a lean and then twice
 * for restraint, and at this scale it is not consciously visible — what is
 * visible is its absence, because a head that turns while the mass behind it
 * stays perfectly still reads as a mask rather than as a body.
 *
 * Scaled by the excursion's MAGNITUDE and not by weight alone. Weight is now
 * how much the character cares, which is 1 for as long as a pointer exists —
 * multiplying by it by itself leant the body three percent permanently, and
 * leant it to screen right when the pointer was sitting on the character and
 * there was no direction to lean in at all. Magnitude also gives the engine its
 * guard for free: no excursion, no lean, so no axis to misread.
 */
export function attentionLean(attention: Attention | null, reduced = false): number {
  if (!attention || reduced) return 0;
  return clamp(Math.hypot(attention.x, attention.y)) * clamp(attention.weight) * 0.03;
}

/** Linear blend of two poses. Every field interpolates; nothing switches. A
 * field that jumped would be the one abrupt expression change the brief rules
 * out, and it would be invisible in review until it happened on a device. */
export function blendPose(a: Pose, b: Pose, t: number): Pose {
  // Written this way rather than `x + (y - x) * t` so t = 0 and t = 1 are
  // EXACT: a pose that lands a float epsilon away from its target is a pose
  // that never quite arrives, and the error accumulates across a blend chain.
  const m = (x: number, y: number) => (1 - t) * x + t * y;
  const mixEye = (x: EyeCfg, y: EyeCfg): EyeCfg => ({
    w: m(x.w, y.w),
    h: m(x.h, y.h),
    tilt: m(x.tilt, y.tilt),
    open: m(x.open, y.open),
  });
  return {
    gaze: { yaw: m(a.gaze.yaw, b.gaze.yaw), pitch: m(a.gaze.pitch, b.gaze.pitch), roll: m(a.gaze.roll, b.gaze.roll) },
    split: m(a.split, b.split),
    eyes: [mixEye(a.eyes[0], b.eyes[0]), mixEye(a.eyes[1], b.eyes[1])],
    mouth: {
      width: m(a.mouth.width, b.mouth.width),
      curve: m(a.mouth.curve, b.mouth.curve),
      open: m(a.mouth.open, b.mouth.open),
      y: m(a.mouth.y, b.mouth.y),
      weight: m(a.mouth.weight, b.mouth.weight),
    },
    wander: m(a.wander, b.wander),
    blink: m(a.blink, b.blink),
    sweep: m(a.sweep, b.sweep),
    wobble: m(a.wobble, b.wobble),
    wobbleRate: m(a.wobbleRate, b.wobbleRate),
    swell: m(a.swell, b.swell),
    squash: m(a.squash, b.squash),
    blend: b.blend,
    ease: b.ease,
  };
}
