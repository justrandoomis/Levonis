/**
 * THE CHARACTER STAYS ON ITS ANCHOR — arithmetic, and the structure around it.
 *
 * The owner reported the mascot "slowly drifting / crawling away" whenever the
 * viewport changed, and sent screenshots of it stranded: once at its 320px
 * introduction size in the middle of a page that had finished loading, once
 * floating at the upper-left of the content with no anchor anywhere near it.
 *
 * Four separate mechanisms produced that, and this file pins the fixes for the
 * ones a node test can reach: the position arithmetic (which must be a pure
 * function of the CURRENT rectangle, never an accumulation), the coordinate
 * space (one, throughout), and the structural guarantees in AppIntro that no
 * arithmetic can express — that every refusal to dock has a deadline, that the
 * transform has exactly one writer, and that a journey is retargeted rather
 * than restarted while the viewport is still moving.
 *
 * scripts/e2e-bloub-continuation.mjs then drives the real thing across eight
 * viewports and a simulated window drag, which is the acceptance test; this is
 * what stops it regressing between browser runs.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  CHARACTER_CANVAS, beginCharacterRouteLoad, bootstrapCharacterFrame, characterLayout,
  characterTransform, frameFromRect, layoutViewport, visibleViewport, type ViewportHost,
} from '../src/components/bloub/anchors';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Source with comments stripped, so an assertion about what the code DOES is
 *  never satisfied — or defeated — by prose describing what it avoids. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

/**
 * Where the drawn 128x128 canvas actually lands, given the frame.
 *
 * `.lv-app-intro__character` is `position: fixed; top: 0; left: 0` with
 * `transform-origin: 0 0`, so the CSS matrix for `translate3d(x,y,0) scale(s)`
 * maps a local point p to `translate + s*p` with no origin term. The algebra
 * is done here rather than assumed because the whole of the owner's third
 * complaint lives in it.
 */
function drawnBox(frame: { x: number; y: number; size: number }) {
  const m = /translate3d\((-?[\d.]+)px, *(-?[\d.]+)px, *0(?:px)?\) *scale\(([\d.]+)\)/.exec(characterTransform(frame));
  assert.ok(m, `unparseable transform: ${characterTransform(frame)}`);
  const [tx, ty, s] = [Number(m![1]), Number(m![2]), Number(m![3])];
  return { left: tx, top: ty, width: CHARACTER_CANVAS * s, height: CHARACTER_CANVAS * s };
}

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

/* ------------------------------------------------ the position arithmetic */

test('the character lands EXACTLY on the anchor’s centre, square or not', () => {
  for (const r of [rect(10, 20, 102, 102), rect(0, 700, 120, 64), rect(640, 0, 66, 84), rect(-4, 12, 48, 48)]) {
    const frame = frameFromRect(r);
    assert.ok(frame, `no frame for ${JSON.stringify(r)}`);
    const box = drawnBox(frame!);
    assert.ok(Math.abs(box.left + box.width / 2 - (r.left + r.width / 2)) < 1e-9, 'horizontally centred on the anchor');
    assert.ok(Math.abs(box.top + box.height / 2 - (r.top + r.height / 2)) < 1e-9, 'vertically centred on the anchor');
    // The drawn square is the anchor's SHORT side, so it never spills out.
    assert.ok(Math.abs(box.width - Math.min(r.width, r.height)) < 1e-9);
  }
});

test('a frame is a function of the CURRENT rectangle and of nothing else', () => {
  // This is the whole of "never accumulate". Feeding the same rectangle twice
  // must give the same answer; feeding one that moved must give the answer for
  // where it moved TO, never for how far it travelled.
  const a = frameFromRect(rect(10, 20, 80, 80))!;
  const b = frameFromRect(rect(10, 20, 80, 80))!;
  assert.deepEqual(a, b);

  // Walk a rectangle across the screen in a hundred steps, the way a dragged
  // window edge arrives, and land it back where it started.
  let last = a;
  for (let i = 1; i <= 100; i++) last = frameFromRect(rect(10 + i, 20 + i * 2, 80, 80))!;
  for (let i = 99; i >= 0; i--) last = frameFromRect(rect(10 + i, 20 + i * 2, 80, 80))!;
  assert.deepEqual(last, a, 'a hundred steps out and back must leave no residue');
});

test('a rectangle that cannot be drawn on is refused rather than guessed at', () => {
  for (const bad of [rect(0, 0, 0, 40), rect(0, 0, 40, 0), rect(NaN, 0, 40, 40), rect(0, Infinity, 40, 40)]) {
    assert.equal(frameFromRect(bad), null, `${JSON.stringify(bad)} produced a frame`);
  }
});

/* ------------------------------------------------------- one coordinate space */

const host = (over: Partial<ViewportHost> = {}): ViewportHost => ({
  innerWidth: 834, innerHeight: 1194,
  document: { documentElement: { clientWidth: 834, clientHeight: 1194 } },
  ...over,
});

test('the visible area is reported in the SAME space as an anchor rectangle', () => {
  // getBoundingClientRect() is layout-viewport space. visualViewport is a
  // different one, and offsetLeft/offsetTop are exactly the vector between
  // them — so they must be carried OUT, not discarded. Mixing the two is
  // invisible on a desktop and offsets the whole character by the visual
  // offset on an iPad with a collapsing URL bar.
  const shifted = visibleViewport(host({ visualViewport: { width: 834, height: 900, offsetLeft: 0, offsetTop: 120 } }));
  assert.equal(shifted.offsetTop, 120);
  const frame = bootstrapCharacterFrame(shifted);
  // The centre of what the user can see, expressed where the anchors live.
  assert.ok(Math.abs(frame.y + frame.size / 2 - (120 + 900 / 2)) < 1e-9, 'centred in the VISIBLE area, in layout coordinates');
  assert.ok(Math.abs(frame.x + frame.size / 2 - 834 / 2) < 1e-9);

  // With no visual viewport the two spaces are the same one, so a zero offset
  // is correct rather than a missing value.
  const plain = visibleViewport(host({ visualViewport: null }));
  assert.deepEqual(plain, { width: 834, height: 1194, offsetLeft: 0, offsetTop: 0 });
});

test('the gaze denominator is the LAYOUT viewport, which a pinch-zoom does not move', () => {
  // A pinch shrinks the visual viewport while leaving every client coordinate
  // exactly where it was. Dividing a client-space distance by the visual
  // viewport would change the character's reach without anything it measures
  // having moved.
  const zoomed = host({ visualViewport: { width: 300, height: 420, offsetLeft: 200, offsetTop: 300 } });
  assert.deepEqual(layoutViewport(zoomed), { w: 834, h: 1194 });
  assert.deepEqual(layoutViewport(host({ document: null })), { w: 834, h: 1194 }, 'innerWidth is the fallback, not zero');
});

test('the bootstrap size is read from the SHORT side, and is capped', () => {
  const phone = bootstrapCharacterFrame({ width: 390, height: 844 });
  assert.ok(phone.size >= 180 && phone.size <= 320);
  assert.ok(Math.abs(phone.size - 390 * 0.52) < 1e-9, 'a tall narrow phone is constrained by its width');
  const desk = bootstrapCharacterFrame({ width: 1920, height: 1080 });
  assert.equal(desk.size, 320, 'past the cap it stops being a character and becomes a splash screen');
});

/* ------------------------------------------------------- the pending counter */

test('the route-load counter cannot leak, and a release is idempotent', () => {
  assert.equal(characterLayout.pending(), false);
  const a = beginCharacterRouteLoad();
  const b = beginCharacterRouteLoad();
  assert.equal(characterLayout.pending(), true);
  a(); a(); a();
  assert.equal(characterLayout.pending(), true, 'the second hold is still open');
  b();
  assert.equal(characterLayout.pending(), false);
  b();
  assert.equal(characterLayout.pending(), false, 'a double release must not drive the counter negative');
});

/* --------------------------------------------- the structure around it */

test('every refusal to dock has a deadline', () => {
  // The character used to be pinned to the viewport centre by a bare `return`
  // whose only exit was an upstream promise settling. One request that never
  // settled left it parked there for the life of the tab, re-centring itself
  // on every resize. A UI state with an unbounded lifetime is a hang.
  const src = code('src/components/bloub/AppIntro.tsx');
  for (const deadline of ['BOOT_PIN_MAX_MS', 'HANDOFF_MAX_MS', 'ORPHAN_GRACE_MS']) {
    assert.match(src, new RegExp(`const ${deadline} = \\d+`), `${deadline} must be a named constant`);
    assert.ok(src.split(deadline).length > 2, `${deadline} is declared but never consulted`);
  }
  assert.match(src, /remeasureAfter/, 'a refusal has to wake itself up again');
  // …and the waking is a single-shot timer, not a poll.
  assert.match(src, /clearTimeout\(settleTimer\)[\s\S]{0,160}setTimeout/);
});

test('the transform has exactly one writer', () => {
  // React's style diff compares the string from the PREVIOUS render with the
  // one from this render, so an inline transform committed a frame after it
  // was computed put back a stale position mid-journey.
  const src = code('src/components/bloub/AppIntro.tsx');
  const markup = src.slice(src.indexOf('className="lv-app-intro__character"'));
  assert.equal(/transform:/.test(markup.slice(0, 400)), false, 'the inline style must not carry transform');
  assert.equal((src.match(/style\.transform\s*=/g) ?? []).length, 1, 'exactly one imperative writer');
  assert.match(src, /useLayoutEffect\(\(\) => \{ writeFrame\(frameRef\.current\); \}\)/, 'the live frame is re-asserted before paint');
});

test('a viewport that is still moving retargets the journey instead of restarting it', () => {
  // Re-planning resets startedAt, and a resize that fires every frame therefore
  // reset it every frame: the journey never reached plan.total, never finished,
  // and its size stayed whatever it was when the viewport started moving. That
  // is the crawl.
  const src = code('src/components/bloub/AppIntro.tsx');
  assert.match(src, /function retargetTravel/);
  assert.match(src, /if \(inFlight && !animate\) \{[\s\S]{0,200}retargetTravel\(inFlight\.plan, next\)/);
  const fn = src.slice(src.indexOf('function retargetTravel'), src.indexOf('class CharacterBoundary'));
  assert.equal(/startedAt/.test(fn), false, 'retargeting must leave the clock alone');
  assert.match(fn, /\.\.\.plan/, 'the beats and the departure are kept');
});

test('the geometry that actually moves an anchor is observed', () => {
  // Both anchor slots are clamp()-pinned to a constant box at every tablet
  // width, so a ResizeObserver on the anchor alone is silent through the one
  // event that moves it furthest — a rotation.
  const src = code('src/components/bloub/AppIntro.tsx');
  assert.match(src, /resizeObserver\?\.observe\(document\.documentElement\)/);
  assert.match(src, /offsetParent[\s\S]{0,400}resizeObserver\?\.observe\(observedContainer\)/);
  assert.match(src, /addEventListener\('orientationchange', onResize\)/);
  assert.match(src, /removeEventListener\('orientationchange', onResize\)/, 'and it has to come off again');
  // A rotation is not finished when the event announcing it fires, so the
  // measurement is taken again once it settles.
  //
  // `onResize` reaches that through `onScroll`, which is where the re-measure
  // now lives: the two were split so that a SCROLL — which fires for the whole
  // length of every swipe, on every scroller in the app — re-measures the
  // anchor without also re-measuring the viewport, whose cached size is what
  // keeps a forced layout read out of the animation frame. A rotation is a
  // size change and a scroll is not; both still move the anchor.
  assert.match(src, /const SETTLE_MS = \d+/);
  assert.match(src, /onScroll = \(\) => \{[\s\S]{0,200}remeasureAfter\(SETTLE_MS\)/);
  assert.match(src, /onResize = \(\) => \{[\s\S]{0,200}onScroll\(\)/, 'a resize must still settle');
});

test('the draw loop still reads no layout, and positions come from a measured rect', () => {
  const src = code('src/components/bloub/AppIntro.tsx');
  const tick = src.slice(src.indexOf('const tick = '), src.indexOf('const start = '));
  assert.ok(tick.length > 400, 'the draw loop was not found — this test would assert nothing');
  assert.equal(/getBoundingClientRect/.test(tick), false, 'the draw loop reads no layout');
  assert.equal(/set[A-Z]\w*\(/.test(tick), false, 'and re-renders nothing');
  // Nothing anywhere adds a delta to the last position.
  assert.equal(/frameRef\.current\.[xy]\s*\+/.test(src), false, 'a position must never be derived from the previous one');
  assert.match(code('src/components/bloub/anchors.ts'), /frameFromRect\(anchor\.element\.getBoundingClientRect\(\)\)/);
});

test('the character is never left drawn at a coordinate from a layout that is gone', () => {
  const src = code('src/components/bloub/AppIntro.tsx');
  // Past the orphan grace with no anchor anywhere, the honest answer is that
  // it has nowhere to be — so it is not drawn, and comes back the instant one
  // registers.
  assert.match(src, /if \(!target\) \{[\s\S]{0,400}setPhase\('hidden'\)/);
  assert.match(code('src/index.css'), /\[data-phase='hidden'\] \.lv-app-intro__character/);
});
