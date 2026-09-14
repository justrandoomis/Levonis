import type { MascotState } from '../../../lib/mascot';
import { bodyPoints, glossPath, pathFromPoints } from './body';
import { EYE_H, EYE_W, FACE_R, eyeMatrix, eyePoses, liveliness, saccade, type HeadGaze } from './face';
import { POSES, blendPose, type Pose } from './expressions';
import { clamp, deg, lerp, r2 } from './math';
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
  gloss: string;
  eyes: [EyeRender, EyeRender];
  mouth: string;
  mouthWeight: number;
  /** 0..1. Drives the notification badge, which exists only in `notify`. */
  alert: number;
  /** Whole-character offset in viewBox units — the last trace of idle float. */
  driftX: number;
  driftY: number;
}

/** How far the gaze is allowed to swing towards a destination. Past roughly
 * this the far eye starts to leave round the limb, which is a real and
 * attractive effect but not one to spend on every page change. */
const LEAD_YAW = 26;
const LEAD_PITCH = 20;

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
  const pose = currentPose(input);
  const { t, travel, reduced } = input;

  // Idle life runs UNDERNEATH whatever the state is doing, damped by the
  // state's own `wander`. A character that stops breathing when it reacts is
  // a slideshow of poses, not a character.
  const life = liveliness(t, { wander: reduced ? 0 : pose.wander, float: !reduced });
  // A blink that is fading out closes less far each frame rather than being
  // cut off partway down.
  const lidLife = 1 - (1 - life.lid) * clamp(pose.blink);
  const flick = reduced || pose.wander <= 0 ? { yaw: 0, pitch: 0 } : saccade(t);

  let gaze: HeadGaze = {
    yaw: pose.gaze.yaw + life.dYaw + flick.yaw * pose.wander,
    pitch: pose.gaze.pitch + life.dPitch + flick.pitch * pose.wander,
    roll: pose.gaze.roll + life.dRoll,
  };

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

  const points = bodyPoints({
    radius: BODY_R,
    t,
    wobble: reduced ? 0 : pose.wobble,
    wobbleRate: pose.wobbleRate,
    swell: pose.swell * (reduced ? 1 : life.breath),
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
  const poses = eyePoses(gaze, FACE_R, pose.split);
  const eyes = poses.map((p, i) => {
    const cfg = pose.eyes[i]!;
    const lid = Math.min(clamp(cfg.open), clamp(lidLife));
    const [a, b, c, d] = eyeMatrix(p, cfg.tilt, lid);
    // Stretch the eye placement with the body but not the eye itself: eyes
    // that stretch with the head look like a reflection, not a face.
    const ex = CENTER + p.x * faceScale * (1 + squash * 0.9) + driftX;
    const ey = CENTER + p.y * (1 - squash) + driftY;
    return {
      matrix: `matrix(${r2(a)} ${r2(b)} ${r2(c)} ${r2(d)} ${r2(ex)} ${r2(ey)})`,
      rx: r2((EYE_W * cfg.w) / 2),
      ry: r2((EYE_H * cfg.h) / 2),
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
    eyes,
    mouth: mouthPath(pose, gaze, squash, driftX, driftY),
    mouthWeight: r2(1.9 * pose.mouth.weight),
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
  const half = 8.4 * m.width * (1 + squash * 0.9);
  const depth = 5.2 * m.curve * (1 - squash);
  const lift = m.open * 3.2;
  const roll = deg(gaze.roll) * 0.6;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const at = (dx: number, dy: number): string => `${r2(cx + dx * cr - dy * sr)} ${r2(cy + dx * sr + dy * cr)}`;
  return `M ${at(-half, -lift * 0.3)} Q ${at(0, depth + lift)} ${at(half, -lift * 0.3)}`;
}
