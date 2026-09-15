import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EYE_SPLIT, FACE_R, REST_GAZE, blinkLid, eyeMatrix, eyePoses, liveliness, saccade } from '../src/components/bloub/character/face';
import { POSES, blendPose } from '../src/components/bloub/character/expressions';
import { bodyPoints } from '../src/components/bloub/character/body';
import { sampleCharacter, currentPose, BODY_R, CENTER } from '../src/components/bloub/character/engine';
import { isTravelWorthAnimating, planTravel, sampleTravel } from '../src/components/bloub/character/travel';
import { travelEase, cubicBezier } from '../src/components/bloub/character/math';
import type { MascotState } from '../src/lib/mascot';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const STATES: MascotState[] = ['idle', 'loading', 'typing', 'navigating', 'returning', 'arrival', 'success', 'notify', 'tap', 'error', 'warning', 'sleep'];

/* ------------------------------------------------ the eyes are on a sphere */

test('an eye is a point on a sphere, so its tangent frame compresses by its own depth', () => {
  // The invariant that makes the whole model honest: the determinant of the
  // projected tangent frame IS the depth, so an eye's AREA follows the
  // sphere's cosine without anyone tuning a foreshortening factor.
  for (const yaw of [0, 12, 28, 45, 70]) {
    for (const [eye] of [eyePoses({ yaw, pitch: 4, roll: -3 })].map((p) => [p[1]] as const)) {
      const det = eye.a * eye.d - eye.b * eye.c;
      assert.ok(Math.abs(det - eye.depth) < 1e-9, `det ${det} vs depth ${eye.depth} at yaw ${yaw}`);
    }
  }
});

test('both eyes share the long axis, so only the width compresses when the head turns', () => {
  // This is what makes a turned head read as a solid object. If the long axis
  // compressed too, the face would read as squashed rather than as turned.
  const [left, right] = eyePoses({ yaw: 26, pitch: 6, roll: -4 });
  const longAxis = (e: typeof left) => Math.hypot(e.c, e.d);
  const shortAxis = (e: typeof left) => Math.hypot(e.a, e.b);
  assert.ok(Math.abs(longAxis(left) - longAxis(right)) < 1e-9, 'long axes identical');
  assert.ok(shortAxis(right) < shortAxis(left) - 0.05, 'the far eye narrows');
});

test('an eye that has gone round the side of the head is not drawn', () => {
  const [, far] = eyePoses({ yaw: 88, pitch: 0, roll: 0 }, FACE_R, EYE_SPLIT);
  assert.ok(far.depth < 0, 'past the limb the depth is negative');
  const frame = sampleCharacter({ t: 3, state: 'idle', from: null, age: 9, travel: null, reduced: false });
  assert.equal(frame.eyes.filter((e) => e.visible).length, 2, 'at rest both eyes are on the face');
});

test('blinking squashes the eye vertically on screen and leaves its width alone', () => {
  const [eye] = eyePoses({ yaw: 18, pitch: 10, roll: -6 });
  const open = eyeMatrix(eye, 0, 1);
  const shut = eyeMatrix(eye, 0, 0);
  assert.equal(open[0], shut[0], 'the x row is untouched');
  assert.equal(open[2], shut[2], 'the x row is untouched');
  assert.ok(Math.abs(shut[1]) < Math.abs(open[1]) * 0.1, 'the y row collapses');
  assert.ok(Math.abs(shut[3]) > 0, 'a closed lid keeps a sliver rather than vanishing');
});

test('an eye tilt is mirrored between the two eyes, which head roll can never do', () => {
  // Concern needs the eye TOPS to CONVERGE (Λ, the raised inner brow); anger
  // is the tops diverging into a V. Head roll tips both the same way, so only
  // per-eye tilt reaches either. What has to mirror is the SCREEN ANGLE of each
  // capsule's long axis. This comment used to state the rule backwards and the
  // assertion below used to encode the backwards version, which is how an angry
  // error face shipped and stayed green; tests/mascotGaze.test.ts now derives
  // the sign from the projection instead of anybody's vocabulary.
  const poses = eyePoses(REST_GAZE);
  const lean = (i: 0 | 1, tilt: number) => {
    const [, , c, d] = eyeMatrix(poses[i], tilt, 1);
    return Math.atan2(d, c);
  };
  const leftShift = lean(0, 17) - lean(0, 0);
  const rightShift = lean(1, -17) - lean(1, 0);
  assert.ok(Math.abs(leftShift) > 0.2 && Math.abs(rightShift) > 0.2, 'each eye visibly leans');
  assert.ok(Math.sign(leftShift) !== Math.sign(rightShift), 'and they lean opposite ways');
  // Head roll alone can only ever tip them together — the thing tilt exists for.
  const rolled = eyePoses({ ...REST_GAZE, roll: REST_GAZE.roll + 17 });
  const rolledLean = (i: 0 | 1) => { const [, , c, d] = eyeMatrix(rolled[i], 0, 1); return Math.atan2(d, c); };
  assert.ok(Math.sign(rolledLean(0) - lean(0, 0)) === Math.sign(rolledLean(1) - lean(1, 0)), 'roll moves both the same way');
  assert.equal(POSES.error.eyes[0].tilt, -POSES.error.eyes[1].tilt, 'concern is authored as a mirrored pair');
  assert.ok(POSES.error.eyes[0].tilt > 0, 'worry CONVERGES the tops; diverging them is the angry-brow geometry');
});

/* --------------------------------------------------- idle is not a loop */

test('idle gaze never repeats inside thirty seconds of watching', () => {
  // The brief's own acceptance test. Drift is a sum of noises on mutually
  // incommensurable periods, so there is no period to catch.
  const sample = (t: number) => {
    const l = liveliness(t);
    return `${l.dYaw.toFixed(3)}|${l.dPitch.toFixed(3)}|${l.dRoll.toFixed(3)}`;
  };
  const seen = new Map<string, number>();
  for (let i = 0; i < 1800; i++) {
    const t = i / 60;
    const key = sample(t);
    assert.equal(seen.has(key), false, `gaze repeated at ${t.toFixed(2)}s (first seen ${seen.get(key)})`);
    seen.set(key, t);
  }
});

test('blinks are irregular, occasionally doubled, and never on a metronome', () => {
  const starts: number[] = [];
  let wasOpen = true;
  for (let i = 0; i < 60 * 120; i++) {
    const open = blinkLid(i / 60) > 0.98;
    if (wasOpen && !open) starts.push(i / 60);
    wasOpen = open;
  }
  assert.ok(starts.length > 20, `blinked ${starts.length} times in two minutes`);
  const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
  const unique = new Set(gaps.map((g) => g.toFixed(1)));
  assert.ok(unique.size > gaps.length * 0.5, 'gaps vary rather than repeating');
  assert.ok(Math.min(...gaps) < 0.6, 'at least one double blink');
  assert.ok(Math.max(...gaps) > 3.5, 'and some long holds');
});

test('a tab left open for hours still blinks, and costs the same to sample', () => {
  // Both schedules used to run out at the half-hour mark and then return a
  // constant — a storefront left open on a counter would simply stop blinking
  // — and both were scanned from index 0 every frame, so the work grew with
  // the uptime. They wrap now, and the lookup is a binary search.
  for (const hours of [0.2, 1, 6, 25]) {
    const base = hours * 3600;
    let blinked = false;
    for (let i = 0; i < 60 * 40 && !blinked; i++) if (blinkLid(base + i / 60) < 0.5) blinked = true;
    assert.ok(blinked, `still blinking after ${hours}h of uptime`);
    const flicks = new Set<string>();
    for (let i = 0; i < 60 * 40; i++) {
      const s = saccade(base + i / 60);
      flicks.add(`${s.yaw.toFixed(2)}|${s.pitch.toFixed(2)}`);
    }
    assert.ok(flicks.size > 20, `gaze still moving after ${hours}h (${flicks.size} distinct)`);
  }
  // Sampling a late moment must not cost more than an early one.
  const time = (base: number) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 60000; i++) { blinkLid(base + i / 60); saccade(base + i / 60); }
    return Number(process.hrtime.bigint() - t0);
  };
  time(0);
  const early = time(5);
  const late = time(9 * 3600);
  assert.ok(late < early * 4, `late sampling stayed cheap (${(late / early).toFixed(2)}x)`);
});

test('the gaze holds still between flicks instead of drifting continuously', () => {
  // Pauses are the point. A gaze that moves every frame reads as a balloon;
  // what makes it read as an eye is that it is mostly STILL and then jumps.
  let moving = 0;
  const total = 60 * 40;
  for (let i = 1; i < total; i++) {
    const a = saccade(i / 60);
    const b = saccade((i - 1) / 60);
    if (Math.abs(a.yaw - b.yaw) > 0.05 || Math.abs(a.pitch - b.pitch) > 0.05) moving++;
  }
  assert.ok(moving / total < 0.2, `flicking only ${((moving / total) * 100).toFixed(1)}% of the time`);
  assert.ok(moving > 0, 'but it does flick');
});

/* ---------------------------------------------- nothing shares one spring */

test('states do not share a blend duration or a curve', () => {
  const durations = new Set(STATES.map((s) => POSES[s].blend));
  assert.ok(durations.size >= 6, `only ${durations.size} distinct blend durations across ${STATES.length} states`);
  assert.ok(POSES.tap.blend < 0.1, 'a press answers immediately');
  assert.ok(POSES.sleep.blend > 0.6, 'you cannot snap into sleepy');
  assert.ok(POSES.error.blend < POSES.idle.blend, 'alarm arrives faster than calm returns');
  const curves = new Set(STATES.map((s) => POSES[s].ease));
  assert.ok(curves.size >= 3, 'more than one curve is in use');
});

test('an expression change interpolates every field and lands exactly', () => {
  const from = POSES.idle;
  const to = POSES.success;
  assert.deepEqual(blendPose(from, to, 0).eyes[0], from.eyes[0], 'starts EXACTLY on the outgoing pose');
  assert.deepEqual(blendPose(from, to, 1).eyes[0], to.eyes[0], 'and lands EXACTLY on the incoming one');
  assert.deepEqual(blendPose(from, to, 1).gaze, to.gaze);
  let previous = from.eyes[0].h;
  for (let i = 1; i <= 20; i++) {
    const h = blendPose(from, to, i / 20).eyes[0].h;
    assert.ok(h <= previous + 1e-9, 'eye height moves monotonically, never jumping back');
    previous = h;
  }
});

test('a repeated reaction replays rather than sticking', () => {
  // `sequence` distinguishes two errors in a row. Without it the second one
  // would find the state already equal and show nothing at all.
  const first = currentPose({ t: 1, state: 'error', from: POSES.idle, age: 0, travel: null, reduced: false });
  const settled = currentPose({ t: 1, state: 'error', from: POSES.idle, age: 5, travel: null, reduced: false });
  assert.notDeepEqual(first.eyes[0], settled.eyes[0], 'the blend is visible at all');
  assert.deepEqual(settled.eyes[0], POSES.error.eyes[0], 'and it completes');
});

test('NO STATE CHANGE IS A STEP: every transition survives timestep refinement', () => {
  // The general form of "never change expression abruptly", and the regression
  // for three separate defects that each broke it in a different place: the
  // loading sweep was applied by a boolean so fifteen degrees of yaw appeared
  // the instant work began; the blink flag was switched at the blend midpoint
  // so a half-shut eye snapped open; and the blend's source was the previous
  // state's TABLE ENTRY rather than the pose on screen, so interrupting a
  // reaction jumped to a face the viewer had never been shown.
  //
  // A flat per-frame bound cannot express this, because the blends are
  // deliberately different lengths — a press answers in 70ms and legitimately
  // covers most of its distance in the first frame, while falling asleep takes
  // 900ms. What separates "fast" from "broken" is not size, it is CONTINUITY:
  // halve the timestep and a continuous curve halves its largest step, while a
  // discontinuity does not shrink at all. So the test refines the timestep.
  //
  // The clock is held still and only the blend's age advances, so liveliness,
  // saccades and blinking contribute a constant and what is measured is the
  // transition alone.
  const eyeCentre = (m: string) => {
    const p = m.slice(7, -1).trim().split(/\s+/).map(Number);
    return { x: p[4]!, y: p[5]! };
  };
  // The previous frame is the OLD state mid-blend — the engine's own output,
  // so the boundary being crossed is the real one. Sampling only from age 0 of
  // the new state misses it entirely: at age 0 the POSE is still the old one,
  // but anything keyed off `input.state` has already flipped, and that gap is
  // exactly where a switch-shaped bug lives.
  const boundary = (from: MascotState) =>
    sampleCharacter({ t: 20, state: from, from: POSES.idle, age: POSES[from].blend * 0.5, travel: null, reduced: false });

  const biggestStep = (from: MascotState, to: MascotState, dt: number) => {
    const last = boundary(from);
    let prev = eyeCentre(last.eyes[0].matrix);
    let max = 0;
    for (let age = 0; age <= 1.0001; age += dt) {
      const r = sampleCharacter({ t: 20, state: to, from: last.pose, age, travel: null, reduced: false });
      const c = eyeCentre(r.eyes[0].matrix);
      max = Math.max(max, Math.hypot(c.x - prev.x, c.y - prev.y));
      prev = c;
    }
    return max;
  };
  for (const from of STATES) {
    for (const to of STATES) {
      if (from === to) continue;
      const coarse = biggestStep(from, to, 1 / 60);
      if (coarse < 0.05) continue; // the two poses put the eye in the same place
      const fine = biggestStep(from, to, 1 / 240);
      // A quarter of the timestep gives about a quarter of the step for a
      // continuous curve. A step function would not shrink at all.
      assert.ok(fine < coarse * 0.6, `${from}->${to} did not shrink with the timestep (${coarse.toFixed(3)} -> ${fine.toFixed(3)}); that is a jump, not a fast blend`);
    }
  }
});

test('a blend interrupted halfway continues from the face on screen', () => {
  const half = blendPose(POSES.idle, POSES.success, 0.5);
  const resumed = currentPose({ t: 4, state: 'error', from: half, age: 0, travel: null, reduced: false });
  assert.deepEqual(resumed.eyes[0], half.eyes[0], 'frame zero of the new blend IS the interrupted pose');
  const landed = currentPose({ t: 4, state: 'error', from: half, age: 9, travel: null, reduced: false });
  assert.deepEqual(landed.eyes[0], POSES.error.eyes[0], 'and it still arrives');
});

test('the searching sweep and the blink calendar are weights, not switches', () => {
  assert.equal(POSES.loading.sweep, 1);
  assert.equal(POSES.idle.sweep, 0);
  assert.equal(blendPose(POSES.idle, POSES.loading, 0.5).sweep, 0.5, 'the sweep arrives gradually');
  assert.equal(blendPose(POSES.idle, POSES.success, 0.5).blink, 0.5, 'and a blink fades rather than being cut');
});

test('reduced motion stills the body during a TAP too, not only at rest', () => {
  const calm = sampleCharacter({ t: 5, state: 'idle', from: null, age: 9, travel: null, reduced: true }).body;
  for (let i = 0; i <= 12; i++) {
    const tapped = sampleCharacter({ t: 5, state: 'tap', from: null, age: i / 60, travel: null, reduced: true }).body;
    assert.equal(tapped, calm, 'a press must not scale the body under the preference');
  }
  // Without the preference it does squash — the press still has to be felt.
  const pressed = sampleCharacter({ t: 5, state: 'tap', from: null, age: 0.1, travel: null, reduced: false }).body;
  assert.notEqual(pressed, sampleCharacter({ t: 5, state: 'idle', from: null, age: 9, travel: null, reduced: false }).body);
});

/* -------------------------------------------------------- the journey */

test('the travel curve is smooth in its first derivative', () => {
  // The body's stretch is driven by speed, so a kink in the curve is a visible
  // snap. This is the regression for the piecewise curve this replaced.
  const h = 1e-3;
  const speed = (t: number) => (travelEase(Math.min(1, t + h)) - travelEase(Math.max(0, t - h))) / (2 * h);
  let previous = speed(0.01);
  for (let i = 2; i < 99; i++) {
    const v = speed(i / 100);
    assert.ok(Math.abs(v - previous) < 0.25, `speed jumped from ${previous.toFixed(3)} to ${v.toFixed(3)} at t=${i / 100}`);
    previous = v;
  }
  assert.ok(speed(0.02) < speed(0.25), 'it gathers before it commits');
  assert.ok(speed(0.95) < speed(0.25) * 0.25, 'and decelerates hard into the dock');
});

test('cubicBezier matches the curve it names at both ends and in the middle', () => {
  const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) assert.ok(Math.abs(linear(t) - t) < 1e-4, `linear at ${t}`);
  assert.equal(travelEase(0), 0);
  assert.equal(travelEase(1), 1);
});

test('THE GAZE LEADS THE BODY: it looks at the destination before it moves', () => {
  // The headline requirement. `lead` must be at its maximum while the body is
  // still at its origin, for every journey the app can plan.
  for (const [from, to] of [
    [{ x: 420, y: 250, size: 300 }, { x: 560, y: 660, size: 88 }],
    [{ x: 560, y: 660, size: 88 }, { x: 560, y: 60, size: 72 }],
    [{ x: 40, y: 60, size: 72 }, { x: 300, y: 700, size: 98 }],
  ] as const) {
    const plan = planTravel(from, to, { boot: from.size > 200 });
    const atLead = sampleTravel(plan, plan.anticipate * 0.95);
    assert.ok(atLead.lead > 0.9, `gaze is committed during anticipation (${atLead.lead.toFixed(2)})`);
    assert.equal(atLead.phase, 'anticipate');
    const originCx = from.x + from.size / 2;
    const targetCx = to.x + to.size / 2;
    const originCy = from.y + from.size / 2;
    const targetCy = to.y + to.size / 2;
    const progressed =
      Math.abs(targetCx - originCx) > Math.abs(targetCy - originCy)
        ? (atLead.x + atLead.size / 2 - originCx) / (targetCx - originCx)
        : (atLead.y + atLead.size / 2 - originCy) / (targetCy - originCy);
    assert.ok(progressed <= 0.001, `body has not set off yet (${(progressed * 100).toFixed(1)}% travelled)`);
  }
});

test('the wind-up pulls AWAY from the destination and is spent before the journey', () => {
  const plan = planTravel({ x: 560, y: 660, size: 88 }, { x: 560, y: 60, size: 72 });
  const origin = 660 + 88 / 2;
  const mid = sampleTravel(plan, plan.anticipate / 2);
  assert.ok(mid.y + mid.size / 2 > origin, 'it gathers downward before going up');
  assert.ok(mid.y + mid.size / 2 - origin <= plan.windup + 0.01, 'and only by the capped amount');
  assert.ok(plan.windup <= 7, 'a hint, never a visible false start');
});

test('the character shrinks INTO its dock rather than resizing as it goes', () => {
  // Size is not position. It starts later and finishes earlier, on its own
  // curve, so the character stays nearly full size as it sets off and does its
  // shrinking on the approach. If the two ever matched, the whole journey
  // would read as one linear resize.
  const plan = planTravel({ x: 420, y: 250, size: 300 }, { x: 560, y: 660, size: 88 }, { boot: true });
  const at = (k: number) => {
    const s = sampleTravel(plan, plan.anticipate + plan.move * k);
    return {
      position: (s.y + s.size / 2 - 400) / (704 - 400),
      size: (300 - s.size) / (300 - 88),
    };
  };
  const early = at(0.15);
  const mid = at(0.5);
  const late = at(0.9);
  assert.ok(early.size < early.position - 0.05, `size lags early (${early.size.toFixed(3)} vs ${early.position.toFixed(3)})`);
  assert.ok(mid.size < mid.position - 0.1, `and through the middle (${mid.size.toFixed(3)} vs ${mid.position.toFixed(3)})`);
  assert.ok(late.size > 0.99 && late.position > 0.98, 'both have landed by the approach');
});

test('the body never overshoots its dock — the settle is in the shape, not the position', () => {
  const plan = planTravel({ x: 420, y: 250, size: 300 }, { x: 560, y: 660, size: 88 }, { boot: true });
  const targetCy = 660 + 88 / 2;
  let sawSquash = false;
  for (let i = 0; i <= 200; i++) {
    const s = sampleTravel(plan, (i / 200) * plan.total);
    if (s.phase === 'settle' || s.phase === 'done') {
      assert.ok(s.y + s.size / 2 <= targetCy + 0.51, 'position does not bounce past the dock');
      if (Math.abs(s.squash) > 0.01) sawSquash = true;
    }
  }
  assert.ok(sawSquash, 'but the mass does catch up — a damped squash on arrival');
  const done = sampleTravel(plan, plan.total);
  assert.ok(Math.abs(done.y + done.size / 2 - targetCy) < 0.51, 'and it lands exactly');
  assert.ok(Math.abs(done.size - 88) < 0.51);
});

test('the body stretches along the direction of travel, fastest first', () => {
  const plan = planTravel({ x: 40, y: 600, size: 90 }, { x: 640, y: 600, size: 90 });
  const extent = (pts: Array<[number, number]>, angle: number) => {
    let lo = Infinity, hi = -Infinity;
    for (const [x, y] of pts) { const u = x * Math.cos(angle) + y * Math.sin(angle); lo = Math.min(lo, u); hi = Math.max(hi, u); }
    return hi - lo;
  };
  let peak = 0;
  for (let i = 0; i <= 60; i++) {
    const s = sampleTravel(plan, (i / 60) * plan.total);
    const pts = bodyPoints({ radius: BODY_R, t: 5, wobble: 0, wobbleRate: 0, swell: 1, stretch: s.stretch, axis: s.angle, trail: s.trail, squash: s.squash });
    const along = extent(pts, s.angle);
    const across = extent(pts, s.angle + Math.PI / 2);
    if (s.phase === 'move') {
      assert.ok(along >= across - 0.01, 'while moving it is longer along the journey than across it');
      peak = Math.max(peak, along / across);
    }
    if (s.phase === 'anticipate') assert.ok(Math.abs(along - across) < 0.01, 'and perfectly round before it sets off');
  }
  assert.ok(peak > 1.1 && peak < 1.45, `stretch is present but restrained (peak ${peak.toFixed(3)})`);
});

test('a journey that replaces one already in flight hands over at speed', () => {
  // A retarget is not a new departure. Planned like one it re-ran the wind-up,
  // so the character stopped dead mid-travel and its stretch — which is driven
  // by speed — collapsed to nothing for a frame at the hand-over.
  const fresh = planTravel({ x: 0, y: 600, size: 90 }, { x: 600, y: 600, size: 90 });
  const over = planTravel({ x: 300, y: 600, size: 90 }, { x: 600, y: 200, size: 72 }, { continuation: true });
  assert.ok(fresh.anticipate > 0.1 && fresh.windup > 0, 'a departure gathers itself');
  assert.equal(over.anticipate, 0, 'a hand-over has nothing left to anticipate');
  assert.equal(over.windup, 0);
  const h = 1e-3;
  const speedAt = (p: typeof fresh, t: number) => (p.ease(Math.min(1, t + h)) - p.ease(Math.max(0, t - h))) / (2 * h);
  assert.ok(speedAt(fresh, 0.01) < 0.35, 'a departure leaves slowly');
  assert.ok(speedAt(over, 0.01) > 2, 'a hand-over leaves at the speed it already had');
  // And it still deforms from the first moment rather than starting round.
  assert.ok(sampleTravel(over, 0.02).stretch > 0.02, 'the body stays stretched through the turn');
});

test('a drift too small to be a journey is not one, in flight or at rest', () => {
  // The question is asked of the DESTINATION, never of the character's live
  // position — which during a journey sweeps past all sorts of places and once
  // made a 1px anchor nudge look like a whole new trip.
  const dockA = { x: 560, y: 660, size: 88 };
  const nudged = { ...dockA, y: 662 };
  assert.equal(isTravelWorthAnimating(planTravel(dockA, nudged)), false, 'destination barely moved');
  const halfway = { x: 560, y: 400, size: 150 };
  assert.equal(isTravelWorthAnimating(planTravel(dockA, nudged)), false,
    'and it is still not a journey just because the character happens to be at ' + JSON.stringify(halfway));
});

test('a relayout of a few pixels is not a journey', () => {
  const dock = { x: 560, y: 660, size: 88 };
  assert.equal(isTravelWorthAnimating(planTravel(dock, { ...dock, y: 662 })), false);
  assert.equal(isTravelWorthAnimating(planTravel(dock, { ...dock, y: 700 })), true);
  assert.equal(isTravelWorthAnimating(planTravel(dock, { ...dock, size: 98 })), true, 'a size change alone is still a journey');
});

test('a longer journey takes longer, but sub-linearly', () => {
  const near = planTravel({ x: 0, y: 0, size: 80 }, { x: 100, y: 0, size: 80 });
  const far = planTravel({ x: 0, y: 0, size: 80 }, { x: 900, y: 0, size: 80 });
  assert.ok(far.move > near.move, 'distance costs time');
  assert.ok(far.move < near.move * 2, 'but nine times the distance is not nine times the wait');
  assert.ok(far.total < 1.55, 'and no journey becomes a wait');
});

/* ---------------------------------------------------- reduced motion */

test('reduced motion stills the body but keeps the character blinking', () => {
  const paths = new Set<string>();
  for (let i = 0; i < 90; i++) paths.add(sampleCharacter({ t: i / 30, state: 'idle', from: null, age: 9, travel: null, reduced: true }).body);
  assert.equal(paths.size, 1, 'the outline does not move at all');
  const lids = new Set<string>();
  for (let i = 0; i < 60 * 12; i++) lids.add(sampleCharacter({ t: i / 60, state: 'idle', from: null, age: 9, travel: null, reduced: true }).eyes[0].matrix);
  assert.ok(lids.size > 1, 'blinking is not vestibular and is kept');
  const plan = planTravel({ x: 0, y: 0, size: 300 }, { x: 500, y: 600, size: 88 }, { reduced: true });
  assert.equal(plan.windup, 0);
  for (let i = 0; i <= 20; i++) {
    const s = sampleTravel(plan, (i / 20) * plan.total);
    assert.equal(s.stretch, 0, 'no stretch at any point of a reduced journey');
    assert.equal(s.trail, 0);
    assert.equal(s.squash, 0);
  }
  // But it still LOOKS where it is going: that is comprehension, not motion.
  assert.ok(sampleTravel(plan, plan.total * 0.3).lead > 0.5, 'the gaze still leads');
});

/* ------------------------------------------------- rendering contract */

test('every state produces a closed body, two eyes and a mouth', () => {
  for (const state of STATES) {
    const r = sampleCharacter({ t: 7.3, state, from: POSES.idle, age: 0.4, travel: null, reduced: false });
    assert.match(r.body, /^M [\d.-]+ [\d.-]+( C [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+)+ Z$/, `${state} body`);
    assert.ok(r.gloss.startsWith('M'), `${state} gloss`);
    assert.ok(r.mouth.startsWith('M'), `${state} mouth`);
    for (const eye of r.eyes) {
      assert.match(eye.matrix, /^matrix\((-?[\d.]+ ){5}-?[\d.]+\)$/, `${state} eye matrix`);
      assert.ok(eye.rx > 0 && eye.ry > 0, `${state} eye size`);
    }
    assert.ok(r.mouthWeight > 0);
  }
});

test('the drawing stays inside its viewBox at the most extreme deformation', () => {
  // A body that clips is a body the viewer sees the edge of. The margin has to
  // survive the fastest journey, not just the resting pose.
  const plan = planTravel({ x: 0, y: 900, size: 300 }, { x: 900, y: 0, size: 88 }, { boot: true });
  for (let i = 0; i <= 80; i++) {
    const travel = sampleTravel(plan, (i / 80) * plan.total);
    for (const state of STATES) {
      const pts = bodyPoints({
        radius: BODY_R, t: i / 8, wobble: POSES[state].wobble, wobbleRate: POSES[state].wobbleRate,
        swell: POSES[state].swell, stretch: travel.stretch, axis: travel.angle, trail: travel.trail, squash: travel.squash,
      });
      for (const [x, y] of pts) {
        // 1.0 of margin is the body stroke's outer half. Anything past that is
        // ink the viewBox does not describe.
        assert.ok(CENTER + x > 1 && CENTER + x < 99, `${state} x ${(CENTER + x).toFixed(1)} left the box`);
        assert.ok(CENTER + y > 1 && CENTER + y < 99, `${state} y ${(CENTER + y).toFixed(1)} left the box`);
      }
    }
  }
});

test('the character carries the loading state instead of a second indicator', () => {
  const app = read('src/App.tsx');
  assert.doesNotMatch(app, />Loading\.\.\.</, 'no untranslated full-page loading screen');
  assert.match(read('src/components/bloub/character/expressions.ts'), /loading:/);
  // The route gate hands waiting to the character rather than painting its own.
  assert.match(app, /const RouteFallback = \(\) => \{\s*useCharacterBusy\(true\);/);
});

test('the engine is actually what the app renders', () => {
  // A motion engine nothing imports is a prototype. These pin the wiring.
  const intro = read('src/components/bloub/AppIntro.tsx');
  const home = read('src/components/bloub/BloubHome.tsx');
  assert.match(home, /sampleCharacter/);
  assert.match(intro, /sampleTravel|planTravel/);
  assert.match(intro, /requestAnimationFrame\(tick\)/);
  assert.equal((intro.match(/<BloubHome\b/g) ?? []).length, 1);
});

test('no CSS animation competes with the engine for the character', () => {
  const css = read('src/index.css');
  assert.doesNotMatch(css, /@keyframes lv-mascot-/, 'the per-state keyframe layer is gone');
  assert.doesNotMatch(css, /\.lv-bloub--/, 'and so are the per-state classes that drove it');
  assert.doesNotMatch(css, /data-phase='travelling'\][^{]*\.lv-app-intro__character\s*\{[^}]*transition:[^}]*transform/,
    'the transform belongs to the loop, not to a transition');
});

test('the Home slot holds nothing that competes with the character for identity', () => {
  const anchor = read('src/components/bloub/MotionCharacterAnchor.tsx');
  assert.match(anchor, /characterLayout\.renderFailed\(\)\s*\?/, 'the letter only appears if the character failed to draw');
  assert.doesNotMatch(read('src/index.css'), /data-bloub-occupied='true'\] \[data-bloub-fallback\]/);
});
