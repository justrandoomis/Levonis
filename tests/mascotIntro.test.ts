/**
 * THE FIRST LOAD: ONE TURN, ONE BLINK, AND THE PAGE IS NEVER WAITED FOR.
 *
 * The owner, 2026-10-07, with a screen recording attached:
 *
 *   «في انميشن bloub تقليل فتره الزمنيه لاول تحميل، لانه يستغرق وقتا طويلا الى
 *   ان يفتح الصفحه — لان الموقع جاهز لكن انميشن الbloub ياخذ وقت طويل —
 *   وجعل الانميشن (العيون) في بدايه التحميل يبدو كانه يدور حول نفسه، وكما في
 *   الفيديو»
 *
 * Two changes, and this file pins both.
 *
 *   1. THE PAGE OPENS WHEN IT IS READY. The intro used to cover an already
 *      painted page with an opaque veil until every boot request settled, then
 *      fly 1.5s to the dock. Now there is no veil, the centre is held for the
 *      intro's own length (INTRO_HOLD) and not for data, and the boot journey
 *      is about 0.85s. A slow request is shown by the docked character's face.
 *
 *   2. THE EYES GO ROUND. Measured off the reference frame by frame: the eyes
 *      creep, slide off the RIGHT edge, the ball is faceless for a beat, they
 *      come back in from the LEFT edge, sweep across and settle where they
 *      started, then one quick blink. Under a reduced-motion preference none
 *      of it happens.
 *
 * And what two reviews of the first build found, each pinned here: a faceless
 * beat short enough to read as a flicker; a ball that was SEE-THROUGH while it
 * faded in, with the page's buttons showing through it; a mouth that turned
 * into a "v" at the edge; eyes that vanished short of the silhouette; a tab
 * opened in the background that played the whole intro when it was shown; a
 * guest's cold `/cart` docking in a bottom bar the redirect then removed; a
 * slow route chunk that made the character JUMP into the header; and a busy
 * overlay held off for the whole of a slow home-data wait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  BODY_R, CENTER, INTRO_BLINK, INTRO_END, INTRO_HOLD, INTRO_LIMB_R, INTRO_SPIN, introOverlay, sampleCharacter,
  type CharacterInput, type CharacterRender,
} from '../src/components/bloub/character/engine';
import { POSES } from '../src/components/bloub/character/expressions';
import { easings } from '../src/components/bloub/character/math';
import { planTravel, sampleTravel } from '../src/components/bloub/character/travel';
import { bootstrapCharacterFrame } from '../src/components/bloub/anchors';
import { entranceFor, ENTRANCE_ORIGIN, playEntrance } from '../src/components/bloub/character/entrance';
import type { MascotState } from '../src/lib/mascot';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const STATES = Object.keys(POSES) as MascotState[];

/** One frame of the boot as AppIntro draws it: the `loading` face (the
 *  bootstrap activity is on), no pointer, standing still, `age` seconds into
 *  the intro. The engine clock runs a few ms ahead of the intro's, as it does
 *  in the app, where the loop's epoch is stamped before its first frame. */
function frame(age: number, opts: Partial<CharacterInput> = {}): CharacterRender {
  return sampleCharacter({ t: 0.03 + age, state: 'loading', from: null, age: 9, travel: null, attention: null, intro: age, reduced: false, ...opts });
}
const matrix = (m: string) => m.match(/matrix\(([^)]+)\)/)![1].trim().split(/\s+/).map(Number);
const eyeX = (r: CharacterRender, i: 0 | 1) => matrix(r.eyes[i].matrix)[4] - CENTER;
/** The pair's horizontal centre, or null while neither eye is on the front. */
function pairX(r: CharacterRender): number | null {
  const xs = ([0, 1] as const).filter((i) => r.eyes[i].visible).map((i) => eyeX(r, i));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
/** The body's outline as the polygon of its anchor points. The curve through
 *  them bulges a hair outside it, so "inside the polygon" is the strict test. */
function outline(r: CharacterRender): Array<[number, number]> {
  const n = r.body.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const pts: Array<[number, number]> = [];
  for (let i = 2 + 4; i + 1 < n.length; i += 6) pts.push([n[i], n[i + 1]]);
  return pts;
}
/** How far a point is inside a closed polygon (negative when outside). */
function depthInside(poly: Array<[number, number]>, x: number, y: number): number {
  let inside = false;
  let nearest = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    const dx = xj - xi;
    const dy = yj - yi;
    const k = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / (dx * dx + dy * dy)));
    nearest = Math.min(nearest, Math.hypot(x - (xi + k * dx), y - (yi + k * dy)));
  }
  return inside ? nearest : -nearest;
}
/** Furthest any point of an eye's ellipse reaches from the body's centre. */
function inkRadius(eye: CharacterRender['eyes'][number]): number {
  const [a, b, c, d, ex, ey] = matrix(eye.matrix);
  let worst = 0;
  for (let k = 0; k < 96; k++) {
    const th = (k / 96) * Math.PI * 2;
    const u = Math.cos(th) * eye.rx;
    const v = Math.sin(th) * eye.ry;
    worst = Math.max(worst, Math.hypot(a * u + c * v + ex - CENTER, b * u + d * v + ey - CENTER));
  }
  return worst;
}

/* ------------------------------------------------------------- timings */

test('the intro is one turn and a blink, and the hold is exactly that long', () => {
  assert.equal(INTRO_SPIN, 0.72);
  assert.equal(INTRO_BLINK, 0.14);
  assert.equal(INTRO_HOLD, INTRO_SPIN + INTRO_BLINK);
  // The reference turns in 1.33s and blinks in 0.13s; compressed so the
  // whole first load fits inside the reference's own 1.7s.
  assert.ok(INTRO_HOLD <= 0.9, `hold ${INTRO_HOLD}s`);
  assert.ok(INTRO_END > INTRO_HOLD, 'the overlay outlives the hold, so nothing steps when it ends');
});

test('the first load is about 1.7s end to end, where it was the data wait plus 1.7s', () => {
  // Phone: the bootstrap frame at the centre of a 390x844 viewport, down to a
  // bottom-nav dock, the drop the previous measurement recorded (366px).
  const phone = bootstrapCharacterFrame({ width: 390, height: 844 });
  const dock = { x: 167, y: 760, size: 56 };
  const boot = planTravel(phone, dock, { boot: true });
  assert.ok(boot.total >= 0.7 && boot.total <= 0.9, `boot journey ${boot.total.toFixed(3)}s (was 1.50s)`);
  assert.ok(boot.anticipate > 0 && boot.anticipate <= 0.1, 'a token gather, still above zero so the gaze leads');
  assert.ok(boot.settle <= 0.2);
  const firstLoad = INTRO_HOLD + boot.total;
  assert.ok(firstLoad <= 1.8, `hold + journey = ${firstLoad.toFixed(3)}s`);

  // The longest boot drop the app can plan (a large tablet) stays bounded.
  const tablet = planTravel(bootstrapCharacterFrame({ width: 1366, height: 1024 }), { x: 655, y: 940, size: 56 }, { boot: true });
  assert.ok(tablet.total <= 0.9, `tablet boot journey ${tablet.total.toFixed(3)}s`);
});

test('route journeys are untouched — only the first arrival got shorter', () => {
  for (const [from, to] of [
    [{ x: 167, y: 760, size: 56 }, { x: 167, y: 8, size: 48 }],
    [{ x: 40, y: 60, size: 72 }, { x: 300, y: 700, size: 98 }],
  ] as const) {
    const plan = planTravel(from, to);
    const d = plan.distance;
    assert.equal(plan.move, Math.min(0.82, Math.max(0.34, 0.34 + Math.sqrt(d) * 0.022)));
    assert.equal(plan.anticipate, Math.min(0.26, Math.max(0.13, 0.13 + d * 0.00035)));
    assert.equal(plan.settle, 0.4);
  }
  // A hand-over keeps its own shape even when it is the boot's.
  const over = planTravel({ x: 0, y: 0, size: 200 }, { x: 0, y: 600, size: 56 }, { boot: true, continuation: true });
  assert.equal(over.anticipate, 0);
  assert.equal(over.settle, 0.4);
});

test('the boot journey still lands exactly, still leads with the gaze, still squashes', () => {
  const plan = planTravel(bootstrapCharacterFrame({ width: 390, height: 844 }), { x: 167, y: 760, size: 56 }, { boot: true });
  const lead = sampleTravel(plan, plan.anticipate * 0.95);
  assert.equal(lead.phase, 'anticipate');
  assert.ok(lead.lead > 0.9);
  let squashed = false;
  for (let i = 0; i <= 120; i++) if (Math.abs(sampleTravel(plan, (i / 120) * plan.total).squash) > 0.01) squashed = true;
  assert.ok(squashed, 'the arrival still has weight');
  const done = sampleTravel(plan, plan.total);
  assert.equal(done.phase, 'done');
  assert.ok(Math.abs(done.y + done.size / 2 - (760 + 28)) < 0.51 && Math.abs(done.size - 56) < 0.51);
});

/* ---------------------------------------------------------- the turn */

test('the eyes start at rest, leave by the RIGHT edge, are gone, come back from the LEFT, and settle', () => {
  const rest = frame(0);
  const restX = pairX(rest)!;
  // Sampled at 240Hz over the turn: the pair's centre, or null while hidden.
  const trace: Array<{ at: number; x: number | null; xs: Array<number | null> }> = [];
  for (let i = 0; i <= Math.round(INTRO_SPIN * 240); i++) {
    const at = i / 240;
    const r = frame(at);
    trace.push({ at, x: pairX(r), xs: ([0, 1] as const).map((k) => (r.eyes[k].visible ? eyeX(r, k) : null)) });
  }
  const hiddenFrom = trace.findIndex((f) => f.x === null);
  const hiddenTo = trace.findIndex((f, i) => i > hiddenFrom && f.x !== null);
  assert.ok(hiddenFrom > 0 && hiddenTo > hiddenFrom, 'there is a faceless beat');

  // OUT: rightward all the way to the edge, never back.
  const out = trace.slice(0, hiddenFrom);
  for (let i = 1; i < out.length; i++) {
    if (out[i].xs.includes(null) !== out[i - 1].xs.includes(null)) continue; // the leading eye going round shifts the centre
    assert.ok(out[i].x! >= out[i - 1].x! - 0.05, `the pair drifted left at ${out[i].at.toFixed(3)}s`);
  }
  const lastSeen = Math.max(...trace[hiddenFrom - 1].xs.filter((x): x is number => x !== null));
  assert.ok(lastSeen > 28, `the last eye leaves near the right edge (x ${lastSeen.toFixed(1)} of ${BODY_R})`);

  // GONE: both eyes, and the mouth with them, for a beat long enough to read
  // as the ball TURNING. The cubic turn managed 0.11s — four frames at 30fps,
  // a flicker on a phone — against the reference's 0.27s.
  const gone = (hiddenTo - hiddenFrom) / 240;
  assert.ok(gone >= 0.16 && gone <= 0.27, `faceless for ${gone.toFixed(3)}s`);
  const away = frame(INTRO_SPIN / 2);
  assert.ok(!away.eyes[0].visible && !away.eyes[1].visible && !away.mouthVisible, 'nothing is drawn on the back of the head');

  // IN: from the left edge, rightward, back to where it started.
  const firstBack = Math.min(...trace[hiddenTo].xs.filter((x): x is number => x !== null));
  assert.ok(firstBack < -28, `the first eye returns at the left edge (x ${firstBack.toFixed(1)})`);
  const back = trace.slice(hiddenTo);
  for (let i = 1; i < back.length; i++) {
    if (back[i].xs.includes(null) !== back[i - 1].xs.includes(null)) continue; // the second eye arriving shifts the centre
    assert.ok(back[i].x! >= back[i - 1].x! - 0.05, `the pair drifted left on the way back at ${back[i].at.toFixed(3)}s`);
  }
  const settled = frame(INTRO_SPIN);
  assert.ok(Math.abs(pairX(settled)! - restX) < 0.3, 'it ends where it began: one whole turn');

  // Proportions of the reference: out by about a third, back by about two.
  assert.ok(hiddenFrom / 240 / INTRO_SPIN > 0.3 && hiddenFrom / 240 / INTRO_SPIN < 0.45);
  assert.ok(hiddenTo / 240 / INTRO_SPIN > 0.55 && hiddenTo / 240 / INTRO_SPIN < 0.7);
});

test('the turn is a sine, not a cubic: half the top speed, the same length', () => {
  // The whole turn is still INTRO_SPIN; only its middle is slower. A cubic
  // reaches 3x the average speed there, the sine pi/2.
  const engine = strip(read('src/components/bloub/character/engine.ts'));
  assert.match(engine, /const turn = easings\.easeInOutSine\(clamp\(at \/ INTRO_SPIN\)\);/);
  const slope = (f: (t: number) => number) => (f(0.5005) - f(0.4995)) / 0.001;
  assert.ok(Math.abs(slope(easings.easeInOutSine) - Math.PI / 2) < 0.01);
  assert.ok(slope(easings.easeInOutSine) < slope(easings.easeInOutCubic) * 0.6);
  assert.equal(easings.easeInOutSine(0), 0);
  assert.equal(easings.easeInOutSine(1), 1);
});

test('it turns the same way in Arabic as in English — the screen\'s right, not the reading direction', () => {
  // The engine knows nothing of the language, and must not: the reference
  // turns to the right, and a mirrored turn in RTL would be a different
  // gesture. Positive yaw is screen-right by construction (character/face.ts).
  const early = frame(INTRO_SPIN * 0.25);
  assert.ok(pairX(early)! > pairX(frame(0))! + 5);
  assert.doesNotMatch(read('src/components/bloub/character/engine.ts'), /\b(dir|rtl|lang)\b/);
});

test('then one blink, to a slit and back, before it leaves', () => {
  const open = frame(INTRO_SPIN);
  const shut = frame(INTRO_SPIN + INTRO_BLINK / 2);
  const after = frame(INTRO_HOLD);
  const height = (r: CharacterRender) => Math.abs(matrix(r.eyes[0].matrix)[3]);
  assert.ok(height(shut) < height(open) * 0.15, 'shut at the middle of the blink');
  assert.ok(Math.abs(height(after) - height(open)) < 0.02, 'open again when the hold ends');
  // Exactly one: no calendar blink is allowed to answer it while the overlay
  // runs (the calendar's first entry is about a second in).
  let closings = 0;
  let wasShut = false;
  for (let i = 0; i <= INTRO_END * 200; i++) {
    const s = height(frame(i / 200)) < height(open) * 0.5;
    if (s && !wasShut) closings += 1;
    wasShut = s;
  }
  assert.equal(closings, 1);
});

test('the eyes go out to the body\'s surface and are cut off BY it — never drawn past it', () => {
  // The face sphere is 25 and the body 41. As the eyes go round they are
  // carried out to INTRO_LIMB_R, so the last sliver leaves AT the silhouette,
  // as the reference's does, and not 8px inside it (the old 36).
  assert.ok(INTRO_LIMB_R >= 39 && INTRO_LIMB_R < BODY_R);
  let ink = 0;
  let margin = Infinity;
  let where = '';
  for (const state of STATES) {
    for (let i = 0; i <= 360; i++) {
      const age = (i / 360) * INTRO_SPIN;
      const r = frame(age, { state, t: 0.03 + age * 2.7 });
      const body = outline(r);
      for (const eye of r.eyes) {
        if (!eye.visible) continue;
        ink = Math.max(ink, inkRadius(eye));
        const [, , , , ex, ey] = matrix(eye.matrix);
        const inside = depthInside(body, ex, ey);
        if (inside < margin) { margin = inside; where = `${state} at ${age.toFixed(3)}s`; }
      }
      assert.ok(!r.eyes[0].matrix.includes('NaN') && !r.mouth.includes('NaN'));
    }
  }
  // The ink reaches the silhouette — that is the cut the reference shows…
  assert.ok(ink >= BODY_R - 0.5, `the eyes reach the edge (ink ${ink.toFixed(2)} of ${BODY_R})`);
  // …but every eye's CENTRE stays on the ball, inside its actual outline (a
  // pressed body is squashed wider, and so is the face on it), so what the
  // clip leaves is a sliver at the edge, never a mark hanging off the side.
  assert.ok(margin >= 0.25, `an eye centre came within ${margin.toFixed(2)} of the outline (${where})`);

  // THE CUT IS THE BODY'S OWN OUTLINE: eyes and mouth are drawn inside a group
  // clipped to a path written with the body on every frame. That, and not a
  // margin, is what guarantees no state at any size draws an eye off the ball.
  const home = strip(read('src/components/bloub/BloubHome.tsx'));
  assert.match(home, /<clipPath id=\{clip\}>\s*<path ref=\{outline\} d=\{FIRST\.body\} \/>\s*<\/clipPath>/);
  assert.match(home, /put\(body\.current, 'body', 'd', r\.body\);\s*put\(outline\.current, 'outline', 'd', r\.body\);/);
  const face = /<g data-bloub-face clipPath=\{`url\(#\$\{clip\}\)`\}>([\s\S]*?)<\/g>/.exec(home)?.[1] ?? '';
  assert.match(face, /data-bloub-eye="0"/);
  assert.match(face, /data-bloub-eye="1"/);
  assert.match(face, /data-bloub-mouth/);
  // One drawing's clip is never another's: the id is per instance.
  assert.match(home, /const clip = `levonis-bloub-face-\$\{React\.useId\(\)\.replace\(/);
});

test('the mouth goes before it can turn into a "v" — narrowed, flattened and thinned on the way', () => {
  // At the edge it used to be 1.4 units wide and 0.9 deep under a 1.58 round
  // stroke: a heart, for a frame on the way out and another on the way back.
  for (const state of STATES) {
    for (let i = 0; i <= 720; i++) {
      const age = (i / 720) * INTRO_SPIN;
      const r = frame(age, { state, t: 0.03 + age });
      if (!r.mouthVisible) continue;
      const n = r.mouth.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const chord = Math.hypot(n[4] - n[0], n[5] - n[1]);
      assert.ok(chord >= r.mouthWeight * 2, `${state} at ${age.toFixed(3)}s: a ${chord.toFixed(2)} mouth under a ${r.mouthWeight} stroke`);
    }
  }
  // At rest nothing about the mouth changed: the same weight it always had.
  for (const state of STATES) {
    const r = sampleCharacter({ t: 3, state, from: null, age: 9, travel: null, intro: null, reduced: false });
    assert.equal(r.mouthWeight, Math.round(1.75 * POSES[state].mouth.weight * 100) / 100);
  }
});

test('nothing else pulls on the face while it turns, and nothing steps when it hands back', () => {
  // A pointer hard left, the loading sweep and the saccades all held off: at
  // the turn's halfway mark with the face fully round, and at its end, the
  // pointer changes nothing.
  const pointer = { x: -1, y: 0.2, weight: 1, curiosity: 1 };
  for (const at of [INTRO_SPIN * 0.1, INTRO_SPIN]) {
    const plain = frame(at);
    const pulled = frame(at, { attention: pointer });
    assert.equal(pulled.eyes[0].matrix, plain.eyes[0].matrix, `the pointer moved the eyes at ${at}s`);
  }
  // From the end of the overlay on, the face is the ordinary one exactly.
  for (const at of [INTRO_END, INTRO_END + 0.5, 4]) {
    const t = 0.03 + at;
    const a = sampleCharacter({ t, state: 'loading', from: null, age: 9, travel: null, attention: null, intro: at, reduced: false });
    const b = sampleCharacter({ t, state: 'loading', from: null, age: 9, travel: null, attention: null, intro: null, reduced: false });
    assert.deepEqual(a, b);
  }
  // And the hand-back itself is continuous: no eye jumps more than a frame's
  // worth of ordinary drift between 120Hz samples once the turn is over.
  let last = frame(INTRO_SPIN);
  for (let i = 1; i <= (INTRO_END - INTRO_SPIN) * 120 + 2; i++) {
    const r = frame(INTRO_SPIN + i / 120);
    assert.ok(Math.abs(eyeX(r, 0) - eyeX(last, 0)) < 0.6, `the gaze stepped at ${(INTRO_SPIN + i / 120).toFixed(3)}s`);
    last = r;
  }
});

test('the settled face is the ordinary face: the turn adds nothing at rest', () => {
  for (const state of STATES) {
    const plain = sampleCharacter({ t: 3, state, from: null, age: 9, travel: null, intro: null, reduced: false });
    assert.equal(plain.mouthVisible, true, `${state} hides its mouth outside the intro`);
    for (const yaw of [-90, 90]) {
      // Even a pose pushed against the clamp keeps its mouth: only the turn
      // ever takes the face round the back.
      const turned = sampleCharacter({ t: 3, state, from: null, age: 9, travel: null, attention: { x: yaw / 90, y: 0, weight: 1, curiosity: 1 }, reduced: false });
      assert.equal(turned.mouthVisible, true);
    }
  }
});

test('under reduced motion there is no turn at all', () => {
  for (const at of [0, INTRO_SPIN * 0.3, INTRO_SPIN / 2, INTRO_SPIN + INTRO_BLINK / 2, 1.2]) {
    const reduced = frame(at, { reduced: true });
    const none = frame(at, { reduced: true, intro: null });
    assert.deepEqual(reduced, none, `the intro changed a reduced-motion frame at ${at}s`);
    assert.ok(reduced.eyes[0].visible && reduced.eyes[1].visible && reduced.mouthVisible);
  }
});

test('introOverlay refuses nonsense rather than drawing NaN', () => {
  assert.equal(introOverlay(Number.NaN), null);
  assert.equal(introOverlay(Number.POSITIVE_INFINITY), null);
  assert.deepEqual(introOverlay(-1), introOverlay(0), 'a clock a hair behind the first frame is the first frame');
});

/* ------------------------------------------------------- the entrance */

test('the first appearance fades in from pale and grows from nine-tenths, about the ball\'s centre', () => {
  const { keyframes, options } = entranceFor('boot', false);
  for (const k of keyframes) for (const key of Object.keys(k)) assert.ok(['offset', 'opacity', 'transform', 'easing'].includes(key), `boot animates ${key}`);
  assert.equal(keyframes[0].opacity, 0);
  assert.equal(keyframes[keyframes.length - 1].opacity, 1);
  assert.ok(Number(options.duration) <= 400, 'solid before the eyes leave the front');
  const parse = (s: string) => {
    const m = /^translate3d\(0, (-?[\d.]+)%, 0\) scale\(([\d.]+), ([\d.]+)\)$/.exec(s)!;
    return { y: Number(m[1]), s: Number(m[2]) };
  };
  const first = parse(String(keyframes[0].transform));
  const last = parse(String(keyframes[keyframes.length - 1].transform));
  assert.equal(first.s, 0.9);
  assert.deepEqual(last, { y: 0, s: 1 }, 'it ends at the identity, so nothing is left behind');
  // The wrapper scales about the feet (ENTRANCE_ORIGIN); the translate holds
  // the BODY'S CENTRE still: origin + y + s * (centre - origin) = centre.
  const origin = Number(/(\d+)%$/.exec(ENTRANCE_ORIGIN)![1]);
  assert.ok(Math.abs(origin + first.y + first.s * (CENTER - origin) - CENTER) < 0.01);
});

test('the first appearance is PALE, never see-through: on screen in a quarter, washed out with the page\'s colour', () => {
  // With no veil behind it, a ball fading in by opacity alone showed the black
  // «تسوّق الآن» button and the cream page through itself for 150ms.
  const { keyframes, options, wash } = entranceFor('boot', false);
  const solid = keyframes.find((k) => k.opacity === 1)!;
  assert.ok(Number(solid.offset) <= 0.2, 'fully opaque within the first fifth of the entrance');
  assert.ok(Number(options.duration) * Number(solid.offset) <= 60, 'within about four frames');
  const offsets = keyframes.map((k) => Number(k.offset));
  assert.deepEqual([...offsets].sort((a, b) => a - b), offsets, 'ordered, or the browser rejects it');
  // The paleness is the wash: from most of the way to the page's colour, to
  // nothing, over the whole entrance, so the ball darkens as the reference's
  // does while staying solid.
  assert.ok(wash, 'the boot has a wash');
  assert.ok(Number(wash.keyframes[0].opacity) >= 0.8);
  assert.equal(wash.keyframes[wash.keyframes.length - 1].opacity, 0);
  assert.equal(wash.options.duration, options.duration);
  assert.equal(wash.options.fill, 'backwards', 'pale from the first frame, nothing left behind');
  for (const k of wash.keyframes) for (const key of Object.keys(k)) assert.ok(['offset', 'opacity', 'easing'].includes(key));
  // Only the boot has one.
  assert.equal(entranceFor('dock', false).wash, undefined);
  assert.equal(entranceFor('stage', false).wash, undefined);

  // The layer: the page's own colour, cut to the body, OVER the body and its
  // gloss and UNDER the face, invisible at rest.
  const home = strip(read('src/components/bloub/BloubHome.tsx'));
  const layer = /<rect data-bloub-wash [^>]*\/>/.exec(home)?.[0] ?? '';
  assert.match(layer, /clipPath=\{`url\(#\$\{clip\}\)`\}/);
  assert.match(layer, /opacity="0"/);
  assert.match(layer, /fill: 'var\(--color-canvas/);
  assert.ok(home.indexOf('data-bloub-gloss') < home.indexOf('data-bloub-wash'));
  assert.ok(home.indexOf('data-bloub-wash') < home.indexOf('data-bloub-face'));
});

test('playEntrance plays the wash with the boot, and a later entrance cancels it', () => {
  const washCalls: unknown[][] = [];
  let washCancelled = 0;
  const layer = {
    animate: (...args: unknown[]) => { washCalls.push(args); return { cancel() {} }; },
    getAnimations: () => [{ cancel: () => { washCancelled += 1; } }],
  };
  const element = {
    animate: () => ({ cancel() {} }) as unknown as Animation,
    querySelector: (sel: string) => (sel === '[data-bloub-wash]' ? layer : null),
  } as unknown as HTMLElement;
  playEntrance(element, 'boot', false);
  assert.deepEqual(washCalls[0], [entranceFor('boot', false).wash!.keyframes, entranceFor('boot', false).wash!.options]);
  playEntrance(element, 'dock', false);
  assert.equal(washCalls.length, 1, 'a dock pop has no wash');
  assert.equal(washCancelled, 2, 'and whatever wash was running is cancelled first');
  // Under the motion preference the boot is a plain fade with no wash.
  playEntrance(element, 'boot', true);
  assert.equal(washCalls.length, 1);
});

test('under reduced motion the first appearance is a short fade and nothing else', () => {
  const { keyframes, options, wash } = entranceFor('boot', true);
  for (const k of keyframes) assert.ok(!('transform' in k));
  assert.ok(Number(options.duration) <= 150);
  assert.equal(wash, undefined);
});

/* --------------------------------------------- AppIntro: the page first */

const intro = strip(read('src/components/bloub/AppIntro.tsx'));
const css = read('src/index.css');

test('there is no veil: the page is never covered by the intro', () => {
  assert.doesNotMatch(intro, /lv-app-intro__veil/);
  assert.doesNotMatch(css, /lv-app-intro__veil/);
  // The layer still owns no taps, so a page under the turning character is a
  // page that can be used.
  assert.match(css, /\.lv-app-intro \{[\s\S]*?pointer-events: none;/);
});

const measureOf = (src: string) => /const measure = \(\) => \{[\s\S]*?\n {4}\};\n/.exec(src)?.[0] ?? '';

test('the boot pin is the intro\'s length, clocked from the first drawn frame, and the home DATA does not hold it', () => {
  assert.match(intro, /const BOOT_PIN_MAX_MS = Math\.round\(INTRO_HOLD \* 1000\);/);
  // Stamped by the loop, so a first frame held up by a busy main thread does
  // not spend the turn before anyone sees it — and the same frame decides,
  // once, whether this load has an intro at all.
  assert.match(intro, /const tick = \(now: number\) => \{\s*rafId = [^\n]+\n\s*if \(!firstFrameAt\) \{\s*firstFrameAt = now;\s*withIntro = introLive = !bornHidden && !reducedRef\.current && !arrivedLate\(now\);\s*\}/);
  assert.match(intro, /intro: introLive \? \(now - firstFrameAt\) \/ 1000 : null,/);
  const hold = /const bootHoldLeft = \(now: number\) => \{[\s\S]*?\n {4}\};/.exec(intro)?.[0] ?? '';
  assert.ok(hold, 'the hold is findable');
  // Nothing on a hidden tab.
  assert.match(hold, /if \(document\.hidden \|\| !firstFrameAt\) return 0;/);
  // While THE SHELL is settling (the quiet latch), up to BOOT_SHELL_MAX_MS
  // from the first frame, with or without an intro; the turn and the blink
  // only when there is a turn to watch — and nothing else.
  assert.match(hold, /const cap = BOOT_SHELL_MAX_MS - since;\s*const shell = waiting \? cap : Math\.min\(cap, BOOT_QUIET_MS - \(now - endedAt\)\);/);
  assert.match(hold, /return withIntro && !reducedRef\.current \? Math\.max\(BOOT_PIN_MAX_MS - since, shell\) : shell;/);
  // The shell's wait as the loop sees it: the same `shellWaiting` the overlay
  // reads, stamped when it ENDS, and a wait that ended before the character
  // mounted counts as quiet all along — a reduced-motion load is not kept at
  // the centre for a quiet window that has already passed.
  assert.match(intro, /const shellWait = React\.useRef\(\{ waiting: shellWaiting, endedAt: Number\.NEGATIVE_INFINITY \}\);/);
  assert.match(intro, /React\.useLayoutEffect\(\(\) => \{\s*const \{ waiting, endedAt \} = shellWait\.current;\s*shellWait\.current = \{ waiting: shellWaiting, endedAt: waiting && !shellWaiting \? performance\.now\(\) : endedAt \};\s*scheduleRef\.current\(true\);\s*\}, \[shellWaiting\]\);/);
  assert.doesNotMatch(hold, /readyRef/, 'the home page\'s data neither holds the character nor extends the hold');
  assert.match(intro, /const BOOT_SHELL_MAX_MS = 2500;/);
  // …but the data is still SHOWN, by the face, wherever the character is.
  const measure = measureOf(intro);
  assert.match(measure, /const pending = !readyRef\.current \|\| routePending;\s*mascot\.activity\('anchor-loading', pending \? 'loading' : null\);/);
  assert.match(intro, /mascot\.activity\('bootstrap', ready \? null : 'loading'\);/);
});

test('the boot hold always ends in a journey — it can never reach the deadline\'s silent dock', () => {
  // The hold used to share the handoff's stopwatch, which started with the
  // turn: three seconds later, with a slow route chunk, the deadline branch
  // teleported the character from the centre into the header in one frame.
  const measure = measureOf(intro);
  assert.match(measure, /const holdLeft = completedRef\.current \? 0 : bootHoldLeft\(now\);\s*if \(holdLeft > 0\) \{\s*stopWaiting\(\);\s*writeFrame\(centerFrame\(\)\);[\s\S]*?\}\s*remeasureAfter\(holdLeft\);\s*return;\s*\}/);
  // A load whose appearance was kept for its dock is shown at the centre only
  // while the shell is still WAITING, and only after a moment of it — never in
  // the quiet tail just before it appears at the dock.
  assert.match(measure, /if \(entrance\.current\?\.playState === 'paused' && shellWait\.current\.waiting\) \{\s*const unseen = BOOT_QUIET_MS - \(now - firstFrameAt\);\s*if \(unseen > 0\) \{ remeasureAfter\(Math\.min\(holdLeft, unseen\)\); return; \}\s*entrance\.current\.play\(\);\s*\}/);
  // The silent dock exists only for a character ALREADY docked.
  const handoff = measure.slice(measure.indexOf("if (completedRef.current && routePending && target.kind === 'top-fallback')"));
  assert.ok(handoff.length > 0 && handoff.indexOf('occupy(target.element, target.kind);') < handoff.indexOf('stopWaiting();\n      const previous'));
  assert.equal((measure.match(/HANDOFF_MAX_MS/g) ?? []).length, 1);
  // Each kind of wait has its own stopwatch.
  assert.match(intro, /const waited = \(kind: 'orphan' \| 'handoff', now: number\) => \{\s*if \(waitingFor !== kind\) \{ waitingFor = kind; waitingSince = now; \}/);
  assert.match(measure, /ORPHAN_GRACE_MS - waited\('orphan', now\)/);
  assert.match(measure, /HANDOFF_MAX_MS - waited\('handoff', now\)/);
});

test('past the hold a first arrival is a journey — or, with no intro, an appearance at the dock', () => {
  const measure = measureOf(intro);
  assert.match(measure, /const boot = !completedRef\.current;/);
  assert.match(measure, /if \(document\.hidden \|\| \(boot && \(!withIntro \|\| reducedRef\.current\)\)\) \{\s*writeFrame\(next\);\s*setPhase\('docked'\);\s*mascot\.navigationComplete\(\);\s*if \(boot && !document\.hidden\) entrance\.current = playEntrance\(pose\.current, 'boot', reducedRef\.current, entrance\.current\);\s*return;\s*\}/);
  assert.match(measure, /planTravel\(last, next, \{ reduced: reducedRef\.current, boot, continuation: !!inFlight \}\)/);
});

test('a load with no intro: the motion preference, a tab opened in the background, an intro that arrived late', () => {
  // The tab's state when the loop was created, not when it is first drawn: a
  // tab opened in the background is drawn for the first time when shown.
  assert.match(intro, /const bornHidden = document\.hidden;/);
  assert.match(intro, /const BOOT_LATE_MS = 1000;/);
  const late = /const arrivedLate = \(now: number\) => \{[\s\S]*?\n {4}\};/.exec(intro)?.[0] ?? '';
  assert.match(late, /getEntriesByName\('first-contentful-paint'\)/);
  assert.match(late, /now - paint\.startTime > BOOT_LATE_MS/);
  assert.match(late, /window\.scrollY > 0 \|\| \(scroller\?\.scrollTop \?\? 0\) > 0/, 'or the page has already been scrolled');
});

test('the boot fade starts before the first paint, on the pose wrapper — paused, invisible, for a load with no intro', () => {
  assert.match(intro, /React\.useLayoutEffect\(\(\) => \{\s*entrance\.current = playEntrance\(pose\.current, 'boot', reducedRef\.current, entrance\.current\);\s*if \(document\.hidden \|\| reducedRef\.current\) entrance\.current\?\.pause\(\);\s*\}, \[\]\);/);
});

test('screen readers hear "preparing" for the shell\'s wait, not for the animation', () => {
  assert.match(intro, /aria-busy=\{preparing\}/);
  assert.match(intro, /\{preparing \? <span className="sr-only">\{loc\('جارٍ تجهيز Levonis…', 'Preparing Levonis…', 'Levonis ئامادە دەکرێت…'\)\}<\/span> : null\}/);
});
