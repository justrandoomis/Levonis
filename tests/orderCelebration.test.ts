/**
 * THE MOMENT AN ORDER GOES THROUGH.
 *
 * «الانيميشن bloub عند تأكيد الطلب غير مناسب وغير مرح ويظهر الانيميشن عندما
 * ينتقل من فوق الى الاسفل بشكل خاطئ وبشكل يظهر فيه lagging».
 *
 * Three claims, each held here by what it IS rather than by what a comment
 * says about it:
 *
 *   1. THE CHARACTER DOES NOT TRAVEL TO THE STAGE (or away from it). The rule
 *      is a pure function, and AppIntro is pinned to consult it before it can
 *      plan a journey.
 *   2. THE ENTRANCE IS FUN AND IS ONLY TRANSFORM AND OPACITY. The keyframes
 *      are data: a pop that overshoots, two hops the second smaller than the
 *      first, a squash on each landing, never a move below the dock — and
 *      under reduced motion, opacity and nothing else.
 *   3. THE BURST IS COMPOSITOR-ONLY AND ONE-SHOT. Its CSS keyframes animate
 *      nothing but transform and opacity, with literal values, and finish
 *      inside the celebration's motion window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appearsInsteadOfTravelling, type AnchorKind } from '../src/components/bloub/anchors';
import { ENTRANCE_ORIGIN, entranceFor, playEntrance } from '../src/components/bloub/character/entrance';
import { BODY_R, CENTER } from '../src/components/bloub/character/engine';
import { BURST_START_MS, burstPieces } from '../src/components/bloub/OrderCelebration';
import { CELEBRATION_MOTION_MS, MASCOT_STATES } from '../src/lib/mascot';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const intro = stripComments(read('../src/components/bloub/AppIntro.tsx'));
const css = read('../src/index.css');
const celebration = read('../src/components/bloub/OrderCelebration.tsx');

// ------------------------------------------------------------- 1. no journey

test('a stage is appeared at, and left, without a journey — every other dock still walks', () => {
  const docks: AnchorKind[] = ['bottom-home', 'top-header', 'top-fallback'];
  for (const from of [...docks, null]) {
    assert.equal(appearsInsteadOfTravelling(from, 'stage'), true, `${from} -> stage`);
  }
  for (const to of docks) {
    assert.equal(appearsInsteadOfTravelling('stage', to), true, `stage -> ${to}`);
    for (const from of [...docks, null]) {
      assert.equal(appearsInsteadOfTravelling(from, to), false, `${from} -> ${to} is an ordinary route journey`);
    }
  }
});

test('AppIntro asks the rule BEFORE anything can plan a journey, and only when the dock changed', () => {
  const measure = /const measure = \(\) => \{[\s\S]*?\n {4}\};\n/.exec(intro)?.[0] ?? '';
  assert.ok(measure, 'measure() should be findable');
  const rule = measure.indexOf('appearsInsteadOfTravelling(previousKind, target.kind)');
  assert.ok(rule > 0, 'measure consults the rule');
  for (const later of ['isTravelWorthAnimating(', 'retargetTravel(', 'planTravel(']) {
    assert.ok(measure.indexOf(later) > rule, `${later} must come after the stage check`);
  }
  // The dock must have CHANGED: a stage that merely scrolled is re-positioned
  // by the ordinary path and never popped a second time.
  assert.match(measure, /if \(target\.element !== previous && appearsInsteadOfTravelling\(previousKind, target\.kind\)\) \{\s*completedRef\.current = true;\s*appear\(target\);\s*return;/);
  // `previous` is read BEFORE this pass occupies the new dock.
  assert.match(measure, /const previous = occupied;\s*const previousKind = occupiedKind;\s*occupy\(target\.element, target\.kind\);/);
});

test('appearing is one write of the destination and an entrance — no plan, no travel phase', () => {
  const appear = /const appear = \(target: CharacterAnchor & \{ frame: CharacterFrame \}\) => \{[\s\S]*?\n {4}\};/.exec(intro)?.[0] ?? '';
  assert.ok(appear, 'appear() should be findable');
  assert.match(appear, /journeyRef\.current = null;/);
  assert.match(appear, /writeFrame\(target\.frame\);/);
  assert.match(appear, /setPhase\('docked'\);/);
  assert.ok(!/planTravel|setPhase\('travelling'\)/.test(appear), 'appearing is not travelling');
  assert.match(appear, /playEntrance\(pose\.current, stage \? 'stage' : 'dock', reducedRef\.current, entrance\.current\)/);
  // Arriving on a stage IS the celebration.
  assert.match(appear, /mascot\.navigationComplete\(stage \? 'stage' : 'route'\);/);
});

test('when the stage goes away the character goes with it, instead of floating over the next page', () => {
  assert.match(
    intro,
    /if \(occupied && !occupied\.isConnected\) \{\s*if \(occupiedKind === 'stage'\) \{\s*journeyRef\.current = null;\s*setPhase\('hidden'\);\s*\}\s*occupy\(null\);/
  );
  // `occupiedKind` is sticky: clearing `occupied` must not forget where it was.
  assert.match(intro, /const occupy = \(element: HTMLElement \| null, kind\?: AnchorKind\) => \{\s*if \(element && kind\) occupiedKind = kind;/);
});

test('the entrance animates a wrapper, never the node whose transform is the position', () => {
  // The outer node's transform has exactly one writer (tests/mascotAnchor).
  assert.match(intro, /<div ref=\{pose\} className="lv-app-intro__pose" style=\{\{ transformOrigin: ENTRANCE_ORIGIN \}\}>/);
  assert.ok(/playEntrance\(pose\.current/.test(intro));
  assert.ok(!/playEntrance\(character\.current/.test(intro));
  // And a running entrance is cancelled with the component.
  assert.match(intro, /entrance\.current\?\.cancel\(\);\s*entrance\.current = null;/);
});

// ---------------------------------------------------------- 2. the entrance

type Frame = { y: number; sx: number; sy: number };
function parse(transform: string): Frame {
  const m = /^translate3d\(0, (-?[\d.]+)%, 0\) scale\(([\d.]+), ([\d.]+)\)$/.exec(transform);
  assert.ok(m, `unexpected transform shape: ${transform}`);
  return { y: Number(m[1]), sx: Number(m[2]), sy: Number(m[3]) };
}

test('the stage entrance is transform and opacity ONLY — a compositor animation', () => {
  for (const kind of ['stage', 'dock'] as const) {
    for (const reduced of [false, true]) {
      const { keyframes } = entranceFor(kind, reduced);
      for (const frame of keyframes) {
        for (const key of Object.keys(frame)) {
          assert.ok(['offset', 'opacity', 'transform', 'easing'].includes(key), `${kind}/${reduced}: animates ${key}`);
        }
      }
    }
  }
});

test('it pops in — from nothing, overshooting, settling — and ends exactly at rest', () => {
  const { keyframes, options } = entranceFor('stage', false);
  const frames = keyframes.map((k) => parse(String(k.transform)));
  assert.equal(keyframes[0].opacity, 0, 'it starts invisible');
  assert.ok(frames[0].sx < 0.5, 'and small');
  assert.ok(Math.max(...frames.map((f) => f.sx)) > 1.05, 'it overshoots — a pop, not a fade');
  const last = frames[frames.length - 1];
  assert.deepEqual(last, { y: 0, sx: 1, sy: 1 }, 'it ends at the identity, so nothing is left behind');
  assert.equal(keyframes[keyframes.length - 1].opacity, 1);
  assert.equal(keyframes[keyframes.length - 1].offset, 1);
  // Offsets are ordered, or the browser rejects the whole animation.
  const offsets = keyframes.map((k) => Number(k.offset));
  assert.deepEqual([...offsets].sort((a, b) => a - b), offsets);
  // And it is over inside the window the page waits before its own work.
  assert.ok(Number(options.duration) <= CELEBRATION_MOTION_MS);
  assert.ok(MASCOT_STATES.celebrate.duration > Number(options.duration), 'the face outlasts the body');
});

test('it hops for joy twice, the second smaller, squashing on every landing — and never drops below its dock', () => {
  const frames = entranceFor('stage', false).keyframes.map((k) => parse(String(k.transform)));
  // «من فوق الى الاسفل بشكل خاطئ»: nothing in the entrance moves DOWN past the
  // place it lands. Up and back, never down through the page.
  assert.ok(frames.every((f) => f.y <= 0), 'no frame is below the dock');
  const apexes = frames.filter((f) => f.y < 0);
  assert.equal(apexes.length, 2, 'two hops');
  assert.ok(Math.abs(apexes[1].y) < Math.abs(apexes[0].y), 'the second hop is smaller');
  assert.ok(Math.abs(apexes[0].y) >= 15, 'a hop that can be seen');
  // Stretched tall in the air, squashed wide on the ground after each apex.
  for (const apex of apexes) assert.ok(apex.sy > apex.sx, 'tall and thin at the apex');
  const landings = frames.filter((f, i) => i > 0 && f.y === 0 && frames[i - 1].y < 0);
  assert.equal(landings.length, 2);
  for (const landing of landings) assert.ok(landing.sx > 1 && landing.sy < 1, 'squashed on landing');
});

test('arriving back on a dock is a short pop with no hop', () => {
  const { keyframes, options } = entranceFor('dock', false);
  const frames = keyframes.map((k) => parse(String(k.transform)));
  assert.ok(frames.every((f) => f.y === 0), 'no hop');
  assert.equal(keyframes[0].opacity, 0);
  assert.ok(Number(options.duration) <= 400);
});

test('under reduced motion it fades in where it is going — no scale, no hop, no squash', () => {
  for (const kind of ['stage', 'dock'] as const) {
    const { keyframes, options } = entranceFor(kind, true);
    for (const frame of keyframes) assert.ok(!('transform' in frame), `${kind} moves under reduced motion`);
    assert.equal(keyframes[0].opacity, 0);
    assert.equal(keyframes[keyframes.length - 1].opacity, 1);
    assert.ok(Number(options.duration) <= 200);
  }
});

test('the pivot is the body\'s feet, derived from the drawing rather than guessed', () => {
  assert.equal(ENTRANCE_ORIGIN, `50% ${CENTER + BODY_R}%`);
});

test('playEntrance replaces a running entrance, and degrades to "already there" without WAAPI', () => {
  const calls: unknown[][] = [];
  let cancelled = 0;
  const previous = { cancel: () => { cancelled += 1; } } as unknown as Animation;
  const animation = { cancel() {} } as unknown as Animation;
  const element = {
    animate: (...args: unknown[]) => {
      calls.push(args);
      return animation;
    },
  } as unknown as HTMLElement;

  assert.equal(playEntrance(element, 'stage', false, previous), animation);
  assert.equal(cancelled, 1, 'the previous entrance is cancelled first');
  assert.deepEqual(calls[0], [entranceFor('stage', false).keyframes, entranceFor('stage', false).options]);

  // No Web Animations API, no element, or an engine that rejects a keyframe:
  // the character is simply where it already is — the correct last frame.
  assert.equal(playEntrance({} as HTMLElement, 'stage', false), null);
  assert.equal(playEntrance(null, 'dock', false), null);
  const throwing = { animate: () => { throw new Error('unsupported easing'); } } as unknown as HTMLElement;
  assert.equal(playEntrance(throwing, 'stage', false), null);
});

// -------------------------------------------------------------- 3. the burst

test('the burst is fourteen pieces round the whole circle, leaving in waves after the pop begins', () => {
  const pieces = burstPieces();
  assert.equal(pieces.length, 14);
  const angles = pieces.map((p) => p.angle);
  assert.equal(new Set(angles).size, angles.length, 'no two pieces share a direction');
  // Evenly spread: every quarter of the circle gets some.
  for (let q = 0; q < 4; q += 1) {
    assert.ok(angles.some((a) => ((a % 360) + 360) % 360 >= q * 90 && ((a % 360) + 360) % 360 < (q + 1) * 90), `quarter ${q}`);
  }
  for (const piece of pieces) {
    assert.ok(piece.delay >= BURST_START_MS && piece.delay < BURST_START_MS + 100, `delay ${piece.delay}`);
  }
  assert.deepEqual(new Set(pieces.map((p) => p.reach)), new Set(['near', 'mid', 'far']));
  assert.deepEqual(new Set(pieces.map((p) => p.shape)), new Set(['dot', 'strip']));
  // Deterministic: the same burst on every order, so its shape can be held.
  assert.deepEqual(burstPieces(), pieces);
});

function keyframeBlock(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  assert.ok(start >= 0, `@keyframes ${name} is missing`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unterminated @keyframes ${name}`);
}

test('every burst keyframe animates transform and opacity alone, with literal values', () => {
  for (const name of ['lv-celebration-ring', 'lv-celebration-near', 'lv-celebration-mid', 'lv-celebration-far']) {
    const block = keyframeBlock(name);
    const properties = [...block.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(properties.length > 0);
    for (const property of properties) {
      assert.ok(['transform', 'opacity'].includes(property), `${name} animates ${property}`);
    }
    // A custom property inside a keyframe is a value some engines decline to
    // hand to the compositor. Direction comes from the arm's static rotation.
    assert.ok(!/var\(/.test(block), `${name} reads a custom property`);
    // Every piece flies OUTWARDS (up, in its arm's rotated frame), never back.
    if (name !== 'lv-celebration-ring') assert.match(block, /100% \{ opacity: 0; transform: translate3d\(0, -\d+px, 0\)/);
  }
  // Each reach is wired to its track, and nothing loops.
  for (const reach of ['near', 'mid', 'far']) {
    assert.match(css, new RegExp(`\\.lv-celebration__bit--${reach} \\{ animation-name: lv-celebration-${reach}; \\}`));
  }
  assert.ok(!/lv-celebration[\s\S]{0,400}infinite/.test(css), 'a celebration that loops is decoration');
});

test('nothing of the burst is visible before it goes off', () => {
  // `both` holds each 0% keyframe through its delay, so every track must
  // START invisible — a ring standing on the stage before the character
  // arrives reads as a placeholder.
  for (const name of ['lv-celebration-ring', 'lv-celebration-near', 'lv-celebration-mid', 'lv-celebration-far']) {
    assert.match(keyframeBlock(name), /^\s*0% \{ opacity: 0;/m, `${name} is visible during its delay`);
  }
});

test('the burst is over inside the celebration window', () => {
  const bit = /\.lv-celebration__bit \{[^}]*animation-duration: (\d+)ms;/.exec(css);
  assert.ok(bit, 'the piece duration should be findable');
  const lastPiece = Math.max(...burstPieces().map((p) => p.delay)) + Number(bit[1]);
  assert.ok(lastPiece <= CELEBRATION_MOTION_MS, `the last piece lands at ${lastPiece}ms`);
  const ring = /lv-celebration-ring (\d+)ms [^;]*? (\d+)ms both;/.exec(css);
  assert.ok(ring, 'the ring animation should be findable');
  assert.ok(Number(ring[1]) + Number(ring[2]) <= CELEBRATION_MOTION_MS);
});

test('under reduced motion the burst is not drawn at all', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.lv-celebration__burst \{ display: none; \}/);
});

test('the pieces sit under the character and take no taps; the stage is the same box', () => {
  assert.match(css, /\.lv-celebration__burst \{ position: absolute; inset: 0; pointer-events: none; \}/);
  assert.match(celebration, /<div className="lv-celebration__burst" aria-hidden="true">/);
  assert.match(celebration, /<MotionCharacterAnchor kind="stage" \/>\s*<\/div>\s*\);/);
  // The direction is a STATIC rotation on the arm; the piece's own animation
  // is one of three shared tracks.
  assert.match(celebration, /style=\{\{ transform: `rotate\(\$\{piece\.angle\}deg\)` \}\}/);
  assert.match(celebration, /style=\{\{ animationDelay: `\$\{piece\.delay\}ms` \}\}/);
});
