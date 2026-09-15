/**
 * THE OWNER'S FOUR ACCEPTANCE CRITERIA, AS ARITHMETIC.
 *
 * Three of them are decided by pure functions and can be proved here rather
 * than looked at: whether any face is angry, whether anything glows, and how
 * far the eyes actually travel. The fourth — the anchor — is
 * tests/mascotAnchor.test.ts. The browser suite
 * (scripts/e2e-bloub-continuation.mjs) then drives all four in real motion,
 * which is what the owner asked for; these are what stop them regressing
 * silently between browser runs.
 *
 * Everything here drives the REAL pipeline — attentionFrom, followAttention to
 * convergence, applyAttention, sampleCharacter — because a test that reads
 * constants proves the constants and not the face.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { POSES, applyAttention } from '../src/components/bloub/character/expressions';
import { NO_ATTENTION, attentionFrom, followAttention } from '../src/components/bloub/character/attention';
import { BODY_R, CENTER, sampleCharacter } from '../src/components/bloub/character/engine';
import { EYE_SPLIT, EYE_H, eyeMatrix, eyePoses, splitFor } from '../src/components/bloub/character/face';

/* ------------------------------------------------------------ the rig */

/** Where the character actually lives: docked bottom-centre in the nav bar. */
const dockCentre = (v: { w: number; h: number }) => ({ x: v.w / 2, y: v.h - 46 });

/** The attention a settled pointer earns, run to convergence through the real
 *  follower so what is measured is the gaze the user would be looking at and
 *  not the first frame of it. */
function settled(point: { x: number; y: number } | null, v: { w: number; h: number }) {
  const want = point
    ? attentionFrom({ point, center: dockCentre(v), viewport: v, engagement: 1 })
    : NO_ATTENTION;
  let a = NO_ATTENTION;
  for (let i = 0; i < 900; i++) a = followAttention(a, want, 1 / 60);
  return a;
}

/** One sampled frame. `t` is fixed so idle drift and the saccade calendar
 *  contribute the SAME offset to every case and cancel out of a difference. */
const frameAt = (attention: ReturnType<typeof settled>, reduced = false) =>
  sampleCharacter({ t: 6.0, state: 'idle', from: null, age: 9, travel: null, attention, intro: null, reduced });

const centreOfEye = (matrix: string) => {
  const m = /matrix\(([^)]+)\)/.exec(matrix);
  assert.ok(m, `unparseable eye matrix: ${matrix}`);
  const p = m![1].trim().split(/\s+/).map(Number);
  return { x: p[4]!, y: p[5]! };
};

/** The pair's centre is where the character is looking: under the sphere
 *  projection the two eyes move by different amounts, which is the point of
 *  it, so neither one alone is the gaze. */
function gaze(point: { x: number; y: number } | null, v: { w: number; h: number }, reduced = false) {
  const r = frameAt(settled(point, v), reduced);
  const a = centreOfEye(r.eyes[0].matrix);
  const b = centreOfEye(r.eyes[1].matrix);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, eyes: r.eyes, render: r };
}

/** The body is about 84 viewBox units across, and the owner's travel bands are
 *  fractions of it. Taken from the drawn path rather than assumed. */
const BODY_WIDTH = (() => {
  const d = frameAt(NO_ATTENTION).body;
  const xs = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number).filter((_, i) => i % 2 === 0);
  return Math.max(...xs) - Math.min(...xs);
})();

const PHONE = { w: 390, h: 844 };
const edge = 6;
const CASES = (v: { w: number; h: number }) => ({
  left: { x: edge, y: dockCentre(v).y - 40 },
  right: { x: v.w - edge, y: dockCentre(v).y - 40 },
  up: { x: v.w / 2, y: edge },
  down: { x: v.w / 2, y: v.h - edge },
  upLeft: { x: edge, y: edge },
  upRight: { x: v.w - edge, y: edge },
  downLeft: { x: edge, y: v.h - edge },
  downRight: { x: v.w - edge, y: v.h - edge },
});

/* ----------------------------------------------- §1 nothing is angry */

test('the tilt sign convention is COMPUTED, and the table obeys it', () => {
  // A comment claiming the opposite of the geometry is exactly how the angry
  // face shipped, so this derives the convention from the projection itself.
  const topLeanOf = (tilt: number, side: 0 | 1) => {
    const poses = eyePoses({ yaw: 0, pitch: 0, roll: 0 });
    const p = poses[side]!;
    const [, , c, d] = eyeMatrix(p, side === 0 ? tilt : -tilt, 1);
    // The capsule's own "up" is (0, -ry); the matrix's c/d column carries it.
    return { dx: c * -(EYE_H / 2), dy: d * -(EYE_H / 2), cx: p.x };
  };
  const leftEye = topLeanOf(12, 0);
  const rightEye = topLeanOf(12, 1);
  assert.ok(leftEye.cx < rightEye.cx, 'index 0 is the screen-left eye');
  assert.ok(leftEye.dx > 0, 'a POSITIVE tilt leans the screen-left eye top inwards');
  assert.ok(rightEye.dx < 0, '…and the screen-right eye top inwards too');
  // So positive converges (Λ, the raised inner brow of concern) and negative
  // diverges (V, the lowered inner brow of anger).
  assert.ok(topLeanOf(-12, 0).dx < 0, 'a NEGATIVE tilt is the angry brow');
});

test('no pose in the table is angry', () => {
  for (const [name, pose] of Object.entries(POSES)) {
    assert.ok(
      pose.eyes[0].tilt >= 0,
      `${name} tilts the eye tops apart (${pose.eyes[0].tilt}°) — that is the angry brow`,
    );
    assert.equal(pose.eyes[0].tilt, -pose.eyes[1].tilt, `${name}: the two tilts must stay mirrored`);
    assert.ok(
      pose.mouth.curve >= 0,
      `${name} has a downturned mouth (curve ${pose.mouth.curve})`,
    );
    // The combination the owner named explicitly: narrowed eyes UNDER a mouth
    // that is not smiling. Either alone is fine; together they glower.
    const narrow = pose.eyes[0].h < 0.75;
    const unsmiling = pose.mouth.curve < 0.2 && pose.mouth.open < 0.2;
    assert.ok(!(narrow && unsmiling), `${name} pairs narrowed eyes with an unsmiling mouth`);
  }
});

test('a failure reads as concerned, and loading stays calm', () => {
  const { error, warning, loading, idle } = POSES;

  // CONCERN, not anger: eyes OPEN rather than narrowed, tops converging a
  // little, and a small round mouth instead of a frown.
  for (const [name, p] of [['error', error], ['warning', warning]] as const) {
    assert.ok(p.eyes[0].h > idle.eyes[0].h, `${name} keeps the eyes taller than neutral, not pinched`);
    assert.ok(p.eyes[0].w > idle.eyes[0].w, `${name} widens rather than narrows`);
    assert.ok(p.eyes[0].tilt > 0 && p.eyes[0].tilt < 12, `${name} tilt ${p.eyes[0].tilt}° is a hint of worry, not a scowl`);
    assert.ok(p.mouth.open > 0.2, `${name} carries an open, rounded mouth`);
    assert.ok(p.mouth.width < 0.7, `${name}'s mouth is small — a wide one at this curve is a grimace`);
  }
  // One character at two intensities, not two moods.
  assert.ok(error.eyes[0].tilt > warning.eyes[0].tilt);
  assert.ok(error.mouth.open > warning.mouth.open);

  // LOADING is the commonest state in the app and the first half of every
  // "loading, then failed" pair the user sees. It must not squint.
  assert.ok(loading.eyes[0].h > 0.88, `loading narrows to ${loading.eyes[0].h} — that is a squint`);
  assert.ok(loading.mouth.curve > 0, 'loading keeps a positive mouth');
});

test('no blend between two poses passes through an angrier frame than either end', () => {
  // A face that is angry for 200ms mid-transition is still an angry face, and
  // blendPose interpolates every field linearly — including tilt, which would
  // cross zero if any endpoint were negative.
  const names = Object.keys(POSES) as Array<keyof typeof POSES>;
  for (const a of names) for (const b of names) {
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const tilt = (1 - t) * POSES[a].eyes[0].tilt + t * POSES[b].eyes[0].tilt;
      const curve = (1 - t) * POSES[a].mouth.curve + t * POSES[b].mouth.curve;
      assert.ok(tilt >= -1e-9, `${a}->${b} at ${t} tilts to ${tilt.toFixed(2)}°`);
      assert.ok(curve >= -1e-9, `${a}->${b} at ${t} frowns (${curve.toFixed(2)})`);
    }
  }
});

test('tracking leans both eyes the SAME way, so it can never write a mirrored brow', () => {
  // Mirrored tilt is the register concern is authored in. If following the
  // pointer wrote into it, looking left would come with a free expression.
  for (const point of Object.values(CASES(PHONE))) {
    const a = settled(point, PHONE);
    const p = applyAttention(POSES.idle, a);
    const mirrored = p.eyes[0].tilt + p.eyes[1].tilt;
    assert.ok(
      Math.abs(mirrored) > Math.abs(p.eyes[0].tilt) - 1e-9,
      'a lean adds the same sign to both eyes; it must not become a mirrored pair',
    );
  }
});

/* ------------------------------------------------- §2 nothing glows */

test('the face carries no glow, and the body keeps its highlight', () => {
  const svg = readFileSync(join(ROOT, 'src/components/bloub/BloubHome.tsx'), 'utf8');
  for (const banned of ['eyeglow', 'feGaussianBlur', 'feDropShadow', 'boxShadow', 'textShadow', 'dropShadow']) {
    assert.equal(svg.includes(banned), false, `BloubHome still references ${banned}`);
  }
  assert.equal(/filter\s*[:=]/.test(svg), false, 'no filter on any part of the character');
  assert.equal((svg.match(/data-bloub-eye=/g) ?? []).length, 2, 'exactly two eyes, and nothing behind them');
  // The BODY's integrated highlight is explicitly kept.
  assert.match(svg, /id="levonis-bloub-gloss"/);
  assert.match(svg, /fill="url\(#levonis-bloub-gloss\)"/);
  assert.match(svg, /id="levonis-bloub-fill"/);
  // …and the eyes are still a flat ivory with no stroke.
  assert.match(svg, /data-bloub-eye="0"[^/]*fill="#f7efda"/);
  assert.equal(/data-bloub-eye="0"[^/]*stroke=/.test(svg), false, 'an outlined eye is a line drawn on the character');
});

/* --------------------------------------------- §4 the gaze reaches */

test('the eyes reach the owner’s range, on every viewport', () => {
  for (const v of [PHONE, { w: 834, h: 1194 }, { w: 1366, h: 1024 }, { w: 1920, h: 1080 }]) {
    const c = CASES(v);
    const rest = gaze(null, v);
    const p = Object.fromEntries(Object.entries(c).map(([k, pt]) => [k, gaze(pt, v)]));

    // Direction is unambiguous — no partial credit.
    assert.ok(p.left!.x < rest.x, `${v.w}x${v.h}: far-left looks left`);
    assert.ok(p.right!.x > rest.x, `${v.w}x${v.h}: far-right looks right`);
    assert.ok(p.up!.y < rest.y, `${v.w}x${v.h}: the top of the screen looks up`);
    assert.ok(p.down!.y > rest.y, `${v.w}x${v.h}: the bottom looks down`);

    const hPct = ((p.right!.x - p.left!.x) / BODY_WIDTH) * 100;
    const vPct = ((p.down!.y - p.up!.y) / BODY_WIDTH) * 100;
    // The owner's references are 15-22% across and 12-18% down, to be tuned by
    // eye; the floor is the hard part, because under it is the defect that was
    // reported. A little headroom above, because past it the eyes swivel.
    assert.ok(hPct >= 15 && hPct <= 26, `${v.w}x${v.h}: horizontal travel is ${hPct.toFixed(1)}% of the face`);
    assert.ok(vPct >= 12 && vPct <= 24, `${v.w}x${v.h}: vertical travel is ${vPct.toFixed(1)}% of the face`);
  }
});

test('a diagonal is a real diagonal, not a shrunken cardinal', () => {
  // The old model normalised to a unit direction, so a perfect diagonal spent
  // its whole budget across two axes and reached 71% of each. A viewport
  // corner must now be full excursion on BOTH.
  const v = PHONE;
  const c = CASES(v);
  const rest = gaze(null, v);
  const g = Object.fromEntries(Object.entries(c).map(([k, pt]) => [k, gaze(pt, v)]));
  for (const [name, hx, vy] of [
    ['upLeft', 'left', 'up'], ['upRight', 'right', 'up'],
    ['downLeft', 'left', 'down'], ['downRight', 'right', 'down'],
  ] as const) {
    const h = (g[name]!.x - rest.x) / (g[hx]!.x - rest.x);
    const vv = (g[name]!.y - rest.y) / (g[vy]!.y - rest.y);
    assert.ok(h > 0.8, `${name} reaches only ${(h * 100).toFixed(0)}% of ${hx} horizontally`);
    assert.ok(vv > 0.8, `${name} reaches only ${(vv * 100).toFixed(0)}% of ${vy} vertically`);
  }
});

test('reaching further means looking further — the edge beats the halfway point', () => {
  // The owner asked for this explicitly, and the old model did the opposite:
  // its weight fell off with distance, so a pointer in a far corner produced a
  // SMALLER gaze than one beside the character.
  const v = PHONE;
  const y = dockCentre(v).y - 40;
  // Every probe is ATTENDED. Comparing one of these against the unattended
  // rest pose would measure applyAttention's lerp off the resting head angle
  // rather than the response curve, and that step is not part of the question.
  const at = (k: number) => gaze({ x: v.w / 2 - (v.w / 2 - edge) * k, y }, v).x;
  const [near, quarter, half, full] = [at(0.05), at(0.25), at(0.5), at(1)];
  assert.ok(full < half, 'the edge pulls further than halfway');
  assert.ok(half < quarter, 'halfway pulls further than a quarter');
  assert.ok(quarter < near, 'and a quarter still pulls further than nothing');
  assert.ok(gaze(null, v).x > near, 'any attention at all already turns the head');
  // NON-LINEAR: the OUTER half of the distance has to be worth more eye
  // movement than the inner half, or a small pointer move near the character
  // twitches the eyes as hard as a reach for the far corner does.
  const inner = near - half;
  const outer = half - full;
  assert.ok(outer > inner, `the response accelerates outwards (inner half ${inner.toFixed(2)} units, outer half ${outer.toFixed(2)})`);
});

test('every one of the nine gaze states is tellable from every other', () => {
  const v = PHONE;
  const all: Record<string, { x: number; y: number }> = { rest: gaze(null, v) };
  for (const [k, pt] of Object.entries(CASES(v))) all[k] = gaze(pt, v);
  const names = Object.keys(all);
  let worst = { gap: Infinity, pair: '' };
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const gap = Math.hypot(all[names[i]!]!.x - all[names[j]!]!.x, all[names[i]!]!.y - all[names[j]!]!.y);
    if (gap < worst.gap) worst = { gap, pair: `${names[i]}/${names[j]}` };
  }
  // The character is usually drawn at about 80 CSS px, so one viewBox unit is
  // 0.8px. 1.4 units is a shade over a pixel of real separation on screen.
  assert.ok(worst.gap > 1.4, `${worst.pair} differ by only ${worst.gap.toFixed(2)} viewBox units`);
});

test('the gaze never breaks the face', () => {
  for (const v of [PHONE, { w: 1920, h: 1080 }, { w: 320, h: 480 }]) {
    const probes = [null, ...Object.values(CASES(v))];
    for (const point of probes) {
      for (const state of Object.keys(POSES) as Array<keyof typeof POSES>) {
        const a = settled(point, v);
        const r = sampleCharacter({ t: 6.0, state, from: null, age: 9, travel: null, attention: a, intro: null, reduced: false });
        for (const [i, eye] of r.eyes.entries()) {
          assert.equal(eye.matrix.includes('NaN'), false, `${state} eye ${i}: ${eye.matrix}`);
          assert.ok(eye.rx > 0 && eye.ry > 0, `${state} eye ${i} collapsed`);
          const c = centreOfEye(eye.matrix);
          // The rendered matrix is in viewBox coordinates, so the body's centre
          // is CENTER and not the origin. The eye rides a 25-unit sphere inside
          // a 41-unit body; with its own half-height it must stay inside.
          const fromCentre = Math.hypot(c.x - CENTER, c.y - CENTER);
          assert.ok(fromCentre + eye.ry < BODY_R, `${state} eye ${i} reaches ${(fromCentre + eye.ry).toFixed(1)} of the ${BODY_R}-unit body`);
        }
        const a0 = centreOfEye(r.eyes[0].matrix);
        const a1 = centreOfEye(r.eyes[1].matrix);
        if (r.eyes[0].visible && r.eyes[1].visible) {
          assert.ok(Math.abs(a1.x - a0.x) > r.eyes[0].rx, `${state}: the eyes overlap`);
        }
        assert.match(r.body, /^M .* Z$/);
        assert.match(r.mouth, /^M .* Q .*$/);
      }
    }
  }
});

test('the foreshortening guard keeps the pair apart at full yaw, and never returns NaN', () => {
  for (let yaw = -80; yaw <= 80; yaw += 2) {
    const s = splitFor(EYE_SPLIT, yaw);
    assert.ok(Number.isFinite(s), `splitFor(${yaw}) = ${s}`);
    assert.ok(s >= EYE_SPLIT - 1e-9 && s <= EYE_SPLIT + 3.5 + 1e-9, `splitFor(${yaw}) = ${s} left its band`);
  }
  assert.ok(splitFor(EYE_SPLIT, 30) > splitFor(EYE_SPLIT, 0), 'a turned head gives back the projection it loses');
});

test('reduced motion keeps a gaze, at a fraction of the swing, with no widening', () => {
  const v = PHONE;
  const c = CASES(v);
  const rest = gaze(null, v, true);
  const full = gaze(c.right, v, false);
  const gentle = gaze(c.right, v, true);
  assert.ok(gentle.x > rest.x + 0.4, 'the preference keeps semantic feedback: it still looks');
  assert.ok(gentle.x < full.x, 'at a fraction of the swing');
  assert.ok(gentle.eyes[0].rx <= frameAt(NO_ATTENTION, true).eyes[0].rx + 1e-9, 'and no widening at all');
});
