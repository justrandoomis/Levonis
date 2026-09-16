/**
 * WHAT THE CHARACTER'S LOOP IS ALLOWED TO DO IN ONE FRAME.
 *
 * The mascot runs a `requestAnimationFrame` loop for the whole life of the
 * page — it is a living character, which is the point of it, and stopping it
 * would be a different product. What it may not do is make the browser lay the
 * document out again on its way past.
 *
 * `aimAt` called `layoutViewport()` every frame. That reads
 * `documentElement.clientWidth/clientHeight`, and the same tick had already
 * written `style.transform` onto the character node while travelling. A write
 * followed by a read of layout is a FORCED SYNCHRONOUS REFLOW: the browser
 * cannot answer until it has recomputed the layout of the entire page. Sixty
 * times a second, on every route, for every visitor, on a phone.
 *
 * The owner reported it as «التعليك lagging والتشنج في الموقع يحدث بين فترات
 * متقاربه ومستمره» — sticking and freezing recurring at short, continuous
 * intervals, with nobody touching anything. That is what a forced reflow on a
 * timer feels like from the outside.
 *
 * The viewport is now measured when it CHANGES, from listeners this component
 * already registers. These tests keep the read out of the frame, and keep the
 * listeners that make the cached value correct.
 *
 * Source guards, not renders: the defect is a call in a hot path, and no
 * render assertion would have caught it — the character looked perfect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/components/bloub/AppIntro.tsx', import.meta.url), 'utf8');
/** Prose about a rule is not the rule — every comment here quotes what was removed. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The body of the per-frame tick, from its declaration to the `start` that arms it. */
function frameBody(): string {
  const from = code.indexOf('const tick = (now: number)');
  assert.ok(from > 0, 'the loop body should be findable — has `tick` been renamed?');
  const to = code.indexOf('const start = ', from);
  assert.ok(to > from, 'the loop should be followed by `start`');
  return code.slice(from, to);
}

test('the loop never measures layout', () => {
  const frame = frameBody();
  // Each of these forces the browser to recompute layout before it can answer.
  // In a function that also writes style, every one of them is a reflow.
  for (const reader of [
    'layoutViewport(',
    'getBoundingClientRect',
    'getComputedStyle',
    'clientWidth',
    'clientHeight',
    'offsetWidth',
    'offsetHeight',
    'offsetParent',
    'scrollTop',
    'scrollHeight',
    'innerWidth',
    'innerHeight',
  ]) {
    assert.ok(
      !frame.includes(reader),
      `${reader} is read inside the animation frame — cache it from the resize listeners instead`
    );
  }
});

test('the viewport is measured once, then refreshed only when it can have changed', () => {
  // One read at setup, and one refresher. More than one call site for
  // `layoutViewport()` in this file is how the per-frame read came back.
  const calls = code.match(/layoutViewport\(\)/g) ?? [];
  assert.equal(calls.length, 2, 'expected exactly the initial read and the refresher');
  assert.match(code, /let viewportSize = layoutViewport\(\);/);
  assert.match(code, /const refreshViewport = \(\) => \{ viewportSize = layoutViewport\(\); \};/);
});

test('every event that can change the viewport refreshes it', () => {
  /**
   * The cache is only as correct as this list. A rotation, a window resize, a
   * keyboard and a URL bar all reach `onResize`; a change to the root
   * element's own box reaches the ResizeObserver; and a tab resized while it
   * was HIDDEN reports the old size until it comes back, which is what the
   * visibility branch is for. Lose any one and the gaze aims at a screen that
   * is not there.
   */
  const onResize = /const onResize = \(\) => \{([\s\S]*?)\n {4}\};/.exec(code)?.[1] ?? '';
  assert.ok(onResize, 'onResize should be findable');
  assert.match(onResize, /refreshViewport\(\)/);

  assert.match(
    code,
    /new ResizeObserver\(\(\) => \{ refreshViewport\(\); schedule\(false\); \}\)/,
    'the observer watching documentElement must refresh the cache'
  );

  const visibility = /const onVisibility = \(\)[\s\S]*?\n {4}\};/.exec(code)?.[0] ?? '';
  assert.ok(visibility, 'onVisibility should be findable');
  assert.match(visibility, /refreshViewport\(\)/, 'a tab resized while hidden reports the old size');

  for (const wiring of [
    "window.addEventListener('resize', onResize)",
    "window.addEventListener('orientationchange', onResize)",
    "window.visualViewport?.addEventListener('resize', onResize)",
    'resizeObserver?.observe(document.documentElement)',
  ]) {
    assert.ok(code.includes(wiring), `missing: ${wiring}`);
  }
});

test('a scroll re-measures the anchor but never re-measures the viewport', () => {
  /**
   * The capture-phase listener on `document` is the app's every scroller at
   * once — the window, the inner `#main-scroll-container`, every horizontal
   * rail — and it fires for the whole length of a swipe. Putting the cached
   * viewport's refresh on that path would return `clientWidth`/`clientHeight`,
   * a forced layout read, to the hottest path in the app, which is exactly
   * what the cache exists to remove.
   *
   * A scroll moves the page PAST the viewport; it does not resize it. The two
   * handlers say so.
   */
  const onScroll = /const onScroll = \(\) => \{([\s\S]*?)\n {4}\};/.exec(code)?.[1] ?? '';
  assert.ok(onScroll, 'onScroll should be findable');
  assert.ok(!onScroll.includes('refreshViewport'), 'a scroll must not re-measure the viewport');
  assert.match(onScroll, /schedule\(false\)/, 'it must still re-measure the ANCHOR — that is its job');

  for (const wiring of [
    "document.addEventListener('scroll', onScroll, true)",
    "window.visualViewport?.addEventListener('scroll', onScroll)",
  ]) {
    assert.ok(code.includes(wiring), `missing: ${wiring}`);
  }
  // Every listener is removed with the same handler it was added with — a
  // mismatch here leaks a listener for the life of the page.
  for (const [add, remove] of [
    ["addEventListener('scroll', onScroll, true)", "removeEventListener('scroll', onScroll, true)"],
    ["visualViewport?.addEventListener('scroll', onScroll)", "visualViewport?.removeEventListener('scroll', onScroll)"],
    ["visualViewport?.addEventListener('resize', onResize)", "visualViewport?.removeEventListener('resize', onResize)"],
  ]) {
    assert.ok(code.includes(add) && code.includes(remove), `add/remove mismatch around ${add}`);
  }
});

test('the gaze still divides by the layout viewport, not the visual one', () => {
  // The cache must not quietly become the VISUAL viewport. `centre` comes from
  // a client rectangle and the pointer from clientX/clientY; a pinch-zoom
  // shrinks the visual viewport while leaving every client coordinate where it
  // was, so mixing the two changes the character's reach without anything it
  // measures having moved. That was a real bug once.
  assert.match(code, /const viewport = viewportSize;/);
  assert.ok(
    !/visualViewport\s*\.\s*(width|height)/.test(code),
    'the denominator must stay the LAYOUT viewport'
  );
});

test('the loop still stops when the tab goes away', () => {
  // The one thing that did pause it correctly, and the cheapest win there is.
  const visibility = /const onVisibility = \(\)[\s\S]*?\n {4}\};/.exec(code)?.[0] ?? '';
  assert.match(visibility, /if \(document\.hidden\) \{[\s\S]*?stop\(\);/);
  assert.match(code, /return \(\) => \{[\s\S]*?stop\(\);/, 'and on unmount');
});
