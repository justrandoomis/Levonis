import type { MascotState } from '../../../lib/mascot';
import { bodyPoints, bouncePath, glossPath, pathFromPoints } from './body';
import { EYE_H, EYE_W, FACE_R, eyeMatrix, eyePoses, liveliness, saccade, splitFor, type HeadGaze } from './face';
import { POSES, applyAttention, attentionLean, blendPose, type Pose } from './expressions';
import type { Attention } from './attention';
import { clamp, deg, lerp, loopNoise, r2 } from './math';
import type { TravelSample } from './travel';

/**
 * ONE FRAME OF THE CHARACTER, AS A PURE FUNCTION.
 *
 * Nothing in this file reads a clock, touches the DOM or keeps state between
 * calls. Everything it needs arrives in `CharacterInput`, and the same input
 * always produces the same output. That is what lets the renderer stop the
 * loop on a hidden tab and resume it minutes later without the character
 * jumping: the frame it draws on resume is the frame that moment of the clock
 * has always described.
 *
 * It is also why this is testable at all. A motion system built out of CSS
 * keyframes can only be checked by watching it; this one can be sampled at
 * t = 4.2s and asserted.
 */

/** The drawing is authored in a 100x100 box and shown through this viewBox.
 * The margin past the body's 42 leaves room for stretch, the notification
 * badge, and the gloss without any of them being clipped. */
export const VIEWBOX = '0 0 100 100';
export const CENTER = 50;
/**
 * The resting radius, in a 0-100 box.
 *
 * Not simply "as big as it fits". The outline has to be free to stretch, bulge
 * behind itself and squash on landing — and those multiply — so the resting
 * size is the largest one whose WORST case still keeps its ink inside the box.
 * tests/mascotEngine.test.ts walks every state against the fastest journey the
 * app can plan and fails if any of them reach the edge, so this number and the
 * deformation coefficients in travel.ts cannot drift apart unnoticed.
 */
export const BODY_R = 41;

export interface CharacterInput {
  /** Seconds. Any monotonic clock; the schedules inside are absolute. */
  t: number;
  state: MascotState;
  /**
   * The pose being blended out of — THE ONE THAT WAS ON SCREEN, not the table
   * entry for the previous state.
   *
   * This distinction is the whole reason interruptions look right. Blending
   * out of `POSES[previousState]` assumes the face had finished arriving
   * there; interrupt a reaction halfway and it had not, so the next blend
   * started from a pose the viewer was never shown and the face jumped to it
   * in one frame. Handing in the live pose makes every blend start exactly
   * where the face is, which is what makes a reaction interruptible at all.
   */
  from: Pose | null;
  /** Seconds since the current state was entered. */
  age: number;
  travel: TravelSample | null;
  /**
   * WHAT THE CHARACTER IS LOOKING AT RIGHT NOW — the pointer, a touch, or a
   * control it has noticed — already smoothed by the caller.
   *
   * The smoothing lives outside this function on purpose. Following is the one
   * part of the character that genuinely depends on the PREVIOUS frame rather
   * than on the clock, and putting that state in here would cost the property
   * every other part relies on: that `sampleCharacter(t)` is the frame time t
   * deserves, whatever happened before it. The loop owns the follower; this
   * function is handed the result.
   */
  attention?: Attention | null;
  /**
   * §18 — SECONDS SINCE THE CHARACTER FIRST APPEARED, or null once the
   * introduction is over.
   *
   * On a cold first visit the character owns the middle of the screen for a
   * moment, and the brief asks it not to be found already smiling there. It
   * OPENS: eyes shut, then a first look, then a blink, then it notices where
   * it is. The whole thing is a function of this one number, so it is
   * samplable and cannot desynchronise from anything else on the frame.
   */
  intro?: number | null;
  reduced: boolean;
}

export interface EyeRender {
  matrix: string;
  rx: number;
  ry: number;
  /** False once the eye has gone round the side of the head. */
  visible: boolean;
}

export interface CharacterRender {
  /** The pose this frame resolved to. Hand it back as the next blend's `from`
   * and every interruption starts from what the viewer was actually shown. */
  pose: Pose;
  body: string;
  /** The specular lobe across the upper-left shoulder. */
  gloss: string;
  /** The dim lift along the lower-left edge — light coming back up off the
   *  surface the character sits on. Volume, not decoration. */
  bounce: string;
  eyes: [EyeRender, EyeRender];
  mouth: string;
  mouthWeight: number;
  /** 0..1. Drives the notification badge, which exists only in `notify`. */
  alert: number;
  /** Whole-character offset in viewBox units — the last trace of idle float. */
  driftX: number;
  driftY: number;
}

/** How far the gaze is allowed to swing towards a destination. A journey is
 * worth a bigger turn than a pointer but not the whole range: the lead has to
 * read as intent, and a head at its stop reads as strain. */
const LEAD_YAW = 26;
const LEAD_PITCH = 20;

/**
 * THE CEILING ON THE COMPOSED GAZE.
 *
 * Every contribution — tracking, idle drift, the saccade, the loading sweep,
 * the travel lead, the introduction — is ADDED, and they stack. Bounding any
 * one of them guards nothing, which is why `loading` used to merge its own two
 * eyes in the corner where the sweep landed on top of a fully tracked turn, at
 * a composed yaw no single term ever reaches. So the limit is applied once,
 * here, to the sum, immediately before the projection reads it.
 *
 * 38 and 30 are measured, not chosen. Swept across every pose, both signs, the
 * split hold on and the curiosity widening applied: the far eye's depth never
 * falls below 0.41, the two eye ellipses stay 1.9 units apart, and the eye ink
 * stays 2.8 units inside the silhouette. At 45 they touch.
 *
 * A hard clamp rather than a tanh soft knee: the soft version is tidier and
 * compresses the ENTIRE range to spare a tail that is almost never reached —
 * 12% of the excursion given back for nothing.
 */
const GAZE_YAW_MAX = 38;
const GAZE_PITCH_MAX = 30;

/**
 * The searching sweep.
 *
 * Only `loading` has one, and it is deliberately not a circle: a circling gaze
 * reads as a spinner with a face, which is the exact failure the brief names.
 * Two slow sines at unrelated periods trace an open Lissajous figure that
 * never quite repeats and that pauses naturally at its turning points, so it
 * reads as looking around rather than as rotating.
 */
function searchGaze(t: number): { yaw: number; pitch: number } {
  return {
    yaw: Math.sin((t / 3.4) * Math.PI * 2) * 15 + Math.sin((t / 1.27) * Math.PI * 2) * 2.5,
    pitch: Math.sin((t / 2.15) * Math.PI * 2 + 0.7) * 8,
  };
}

/**
 * THE FIRST TWO SECONDS OF THE CHARACTER'S LIFE.
 *
 * Four beats, and every one of them is a lid or a gaze rather than a motion:
 * a creature waking up does not move, it opens.
 *
 *   0.00-0.28  shut. Present, and not yet awake.
 *   0.28-0.62  opening — a slow lift, not a snap, because the lid is the
 *              expression here and a fast one reads as a flinch.
 *   0.62-1.05  a first look aside, the way anything does when it finds itself
 *              somewhere: not at the viewer, past them.
 *   1.05-1.22  a blink, which is what makes the opening read as an EYE rather
 *              than as an animation of an ellipse.
 *   1.22+      awake; the introduction contributes nothing and the ordinary
 *              state takes over completely.
 *
 * Returns a multiplier on the lid and an additional gaze, both of which reach
 * zero exactly at the end, so there is no step out of it.
 */
export function introOverlay(age: number): { lid: number; yaw: number; pitch: number } | null {
  if (age >= 1.22) return null;
  const at = Math.max(0, age);
  if (at < 0.28) return { lid: 0.04, yaw: 0, pitch: 0 };
  if (at < 0.62) {
    // easeOutCubic on the lid: quick past the first sliver, slow into open.
    const k = (at - 0.28) / 0.34;
    return { lid: 0.04 + (1 - 0.04) * (1 - (1 - k) ** 3), yaw: 0, pitch: 0 };
  }
  if (at < 1.05) {
    // The look. A half-sine so it leaves and returns without a corner.
    const k = (at - 0.62) / 0.43;
    const swing = Math.sin(Math.PI * k);
    return { lid: 1, yaw: -13 * swing, pitch: 5 * swing };
  }
  const k = (at - 1.05) / 0.17;
  // One blink: down and back up inside the beat.
  return { lid: 1 - Math.sin(Math.PI * k) * 0.94, yaw: 0, pitch: 0 };
}

/** Resolve the pose in flight: the state being entered, blended out of the
 * pose that was actually on screen, on the incoming state's own curve. */
export function currentPose(input: CharacterInput): Pose {
  const to = POSES[input.state];
  if (!input.from || to.blend <= 0) return to;
  const k = clamp(input.age / to.blend);
  if (k >= 1) return to;
  return blendPose(input.from, to, to.ease(k));
}

export function sampleCharacter(input: CharacterInput): CharacterRender {
  const { t, travel, reduced } = input;
  /**
   * A JOURNEY OUTRANKS A POINTER.
   *
   * While the character is travelling its gaze belongs to where it is going —
   * that is the lead that makes a journey read as intent rather than as a
   * slide. Letting the pointer pull on the face at the same time produced a
   * character looking at the cursor while flying somewhere else, which reads
   * as being dragged. So attention is faded out across the travel's own lead
   * ramp, and comes back as the character settles.
   */
  const attention = travel && travel.lead > 0 && input.attention
    ? { ...input.attention, weight: input.attention.weight * (1 - travel.lead), curiosity: input.attention.curiosity * (1 - travel.lead) }
    : input.attention ?? null;
  const pose = applyAttention(currentPose(input), attention, reduced);

  // Idle life runs UNDERNEATH whatever the state is doing, damped by the
  // state's own `wander`. A character that stops breathing when it reacts is
  // a slideshow of poses, not a character.
  const life = liveliness(t, { wander: reduced ? 0 : pose.wander, float: !reduced });
  // A blink that is fading out closes less far each frame rather than being
  // cut off partway down.
  let lidLife = 1 - (1 - life.lid) * clamp(pose.blink);

  // §18. The introduction multiplies the lid rather than replacing it, so a
  // blink that happens to land inside the opening still closes the eye — the
  // two are the same mechanism and must not fight over it.
  // `typeof`, not `!== null`: an omitted field is `undefined`, and passing
  // that to the overlay produced NaN lids — an eye matrix full of NaN, which
  // renders as nothing at all and is invisible in a diff.
  const intro = typeof input.intro === 'number' ? introOverlay(input.intro) : null;
  if (intro) lidLife = Math.min(lidLife, intro.lid);
  const flick = reduced || pose.wander <= 0 ? { yaw: 0, pitch: 0 } : saccade(t);

  let gaze: HeadGaze = {
    yaw: pose.gaze.yaw + life.dYaw + flick.yaw * pose.wander,
    pitch: pose.gaze.pitch + life.dPitch + flick.pitch * pose.wander,
    roll: pose.gaze.roll + life.dRoll,
  };

  if (intro) {
    gaze = { yaw: gaze.yaw + intro.yaw, pitch: gaze.pitch + intro.pitch, roll: gaze.roll };
  }

  if (pose.sweep > 0 && !reduced) {
    const sweep = searchGaze(t);
    gaze = { yaw: gaze.yaw + sweep.yaw * pose.sweep, pitch: gaze.pitch + sweep.pitch * pose.sweep, roll: gaze.roll };
  }

  // THE GAZE LEADS THE BODY. `lead` is already at its peak while the wind-up
  // is still happening, so by the time the character moves it has been looking
  // at the destination for a beat. This is the single line that turns "a shape
  // slid across the screen" into "it noticed where it was going".
  let stretch = 0;
  let trail = 0;
  let squash = 0;
  let axis = 0;
  if (travel) {
    axis = travel.angle;
    stretch = travel.stretch;
    trail = travel.trail;
    squash = travel.squash;
    if (travel.lead > 0) {
      // Screen y grows downwards while pitch grows upwards, hence the sign.
      const wantYaw = Math.cos(travel.angle) * LEAD_YAW;
      const wantPitch = -Math.sin(travel.angle) * LEAD_PITCH;
      gaze = {
        yaw: lerp(gaze.yaw, wantYaw, travel.lead),
        pitch: lerp(gaze.pitch, wantPitch, travel.lead),
        roll: gaze.roll * (1 - travel.lead * 0.5),
      };
    }
  }

  // A press squashes the body without a journey. It rides the pose like every
  // other part of an expression, so it arrives and leaves on the blend rather
  // than appearing and vanishing with the state's name.
  if (!reduced) squash += pose.squash;

  // THE BODY LEANS THE WAY THE HEAD TURNED. Only when it is not already
  // travelling: a journey owns the deformation axis, and two things stretching
  // the same body along two different axes is how a character starts to look
  // like it is being pulled apart.
  if (!travel && attention) {
    const lean = attentionLean(attention, reduced);
    if (lean > 0) {
      stretch += lean;
      axis = Math.atan2(attention.y, attention.x);
    }
  }

  gaze = {
    yaw: clamp(gaze.yaw, -GAZE_YAW_MAX, GAZE_YAW_MAX),
    pitch: clamp(gaze.pitch, -GAZE_PITCH_MAX, GAZE_PITCH_MAX),
    roll: gaze.roll,
  };

  const points = bodyPoints({
    radius: BODY_R,
    t,
    wobble: reduced ? 0 : pose.wobble,
    wobbleRate: pose.wobbleRate,
    // UNDER THE MOTION PREFERENCE THE BODY DOES NOT CHANGE SIZE AT ALL.
    // `life.breath` was already neutralised here; `pose.swell` was not, and it
    // is the same kind of thing — a whole-body scale. Several reactions carry
    // one (a percent and a half for a concern, four for an order), and because
    // it rides the blend it kept moving for the length of that blend after the
    // preference had been honoured everywhere else. A body quietly growing and
    // shrinking is precisely the vestibular motion the preference exists to
    // remove; the expression itself is carried by the eyes, the mouth and the
    // gaze, which all survive it.
    swell: reduced ? 1 : pose.swell * life.breath,
    stretch,
    axis,
    trail,
    squash,
  });

  const driftX = life.driftX * BODY_R;
  const driftY = life.driftY * BODY_R;

  // The face rides the same deformation as the body, at a fraction of it, so
  // it stays anchored on the surface instead of sliding across a shape that
  // is changing under it.
  const faceScale = 1 + stretch * 0.35;
  // The split is held open against the turn's own foreshortening, so the pair
  // keeps the spacing that makes it read as a face instead of closing up into
  // one mark at the far end of a look.
  const poses = eyePoses(gaze, FACE_R, splitFor(pose.split, gaze.yaw));

  /**
   * A FACE IS NOT SYMMETRICAL.
   *
   * While the character is interested, one eye opens a third of a unit more
   * than the other and the near one tips a degree — the difference between a
   * creature looking at you and a matched pair of ellipses. Two incommensurable
   * noise periods, so it breathes rather than settling into a fixed
   * lopsidedness, and it rides `curiosity` so it exists only while there is
   * something to be curious about.
   *
   * Applied to the RENDER and never to the pose: the pose is handed back as the
   * next blend's `from`, and asymmetry baked into it would compound every time
   * a state changed.
   */
  const interest = reduced ? 0 : clamp(attention?.curiosity ?? 0);
  const odd = interest * 0.035 * loopNoise(t, 8.3, 0.6);
  const oddTilt = interest * 1.2 * loopNoise(t, 6.7, 2.2);

  const eyes = poses.map((p, i) => {
    const cfg = pose.eyes[i]!;
    const lid = Math.min(clamp(cfg.open), clamp(lidLife));
    const [a, b, c, d] = eyeMatrix(p, cfg.tilt + (i === 0 ? oddTilt : 0), lid);
    // Stretch the eye placement with the body but not the eye itself: eyes
    // that stretch with the head look like a reflection, not a face.
    const ex = CENTER + p.x * faceScale * (1 + squash * 0.9) + driftX;
    const ey = CENTER + p.y * (1 - squash) + driftY;
    return {
      matrix: `matrix(${r2(a)} ${r2(b)} ${r2(c)} ${r2(d)} ${r2(ex)} ${r2(ey)})`,
      rx: r2((EYE_W * cfg.w) / 2),
      ry: r2((EYE_H * cfg.h * (1 + (i === 0 ? odd : -odd))) / 2),
      visible: p.depth > -0.05,
    } satisfies EyeRender;
  }) as [EyeRender, EyeRender];

  return {
    pose,
    // Both paths come from the SAME sampled outline. Recomputing it for the
    // gloss would let the two drift apart by a frame under any future change
    // to the sampler, and the highlight would visibly lag the body it sits on.
    body: pathFromPoints(points, CENTER + driftX, CENTER + driftY),
    gloss: glossPath(points, CENTER + driftX, CENTER + driftY),
    bounce: bouncePath(points, CENTER + driftX, CENTER + driftY),
    eyes,
    mouth: mouthPath(pose, gaze, squash, driftX, driftY),
    mouthWeight: r2(1.75 * pose.mouth.weight),
    alert: input.state === 'notify' ? clamp(input.age / 0.16) : 0,
    driftX: r2(driftX),
    driftY: r2(driftY),
  };
}

/**
 * The mouth, placed on the same sphere as the eyes.
 *
 * It is a single quadratic whose control point carries the smile, drawn below
 * the eyes and shifted by the head's yaw so it stays on the face when the
 * character looks aside. Without that shift the mouth stays nailed to the
 * centre of the silhouette while the eyes travel, and the face comes apart.
 */
function mouthPath(pose: Pose, gaze: HeadGaze, squash: number, driftX: number, driftY: number): string {
  const m = pose.mouth;
  const yawShift = Math.sin(deg(gaze.yaw)) * FACE_R * 0.42;
  const pitchShift = -Math.sin(deg(gaze.pitch)) * FACE_R * 0.34;
  const cx = CENTER + yawShift + driftX;
  const cy = CENTER + 15.5 + pitchShift + m.y * 3 + driftY;
  // MINIMAL, measured off the reference: its mouth spans about an eighth of
  // the body's width, not a fifth. A wider arc starts to dominate the face and
  // the brief is explicit that the mouth supports the eyes rather than leading
  // them — which at this size means it has to be small enough that the eyes
  // are read first.
  const half = 6.8 * m.width * (1 + squash * 0.9);
  const depth = 4.4 * m.curve * (1 - squash);
  const lift = m.open * 3.2;
  const roll = deg(gaze.roll) * 0.6;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const at = (dx: number, dy: number): string => `${r2(cx + dx * cr - dy * sr)} ${r2(cy + dx * sr + dy * cr)}`;
  return `M ${at(-half, -lift * 0.3)} Q ${at(0, depth + lift)} ${at(half, -lift * 0.3)}`;
}
