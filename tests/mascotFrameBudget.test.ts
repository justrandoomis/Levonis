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

/**
 * A NAMED SLICE OF THE SOURCE, so a guard can say WHERE it applies.
 *
 * These are source-shape assertions, which means they are only as good as
 * their boundaries; each one asserts its own, loudly, so a rename fails with
 * "has `tick` been renamed?" rather than by silently guarding nothing.
 */
function slice(fromNeedle: string, toNeedle: string, what: string): string {
  const from = code.indexOf(fromNeedle);
  assert.ok(from > 0, `${what} should be findable — has it been renamed? (looking for \`${fromNeedle}\`)`);
  const to = code.indexOf(toNeedle, from);
  assert.ok(to > from, `${what} should be followed by \`${toNeedle}\``);
  return code.slice(from, to);
}

/** The body of the per-frame tick, from its declaration to the `start` that arms it. */
function frameBody(): string {
  return slice('const tick = (now: number)', 'const start = ', 'the loop body');
}

/**
 * The body of the anchor measurement, from its declaration to the `schedule`
 * that asks for it.
 *
 * THE SLICE THE OLD TEST DID NOT LOOK AT, and the reflow came back through it.
 * `frameBody()` stops at `const start = `; `measure` is declared after that, so
 * for as long as it ran on a `requestAnimationFrame` of its own it was outside
 * every guard here — and it landed in the SAME frame as the loop, after it,
 * once per scroll event, reading `getBoundingClientRect`, `getComputedStyle`
 * and `offsetParent` immediately downstream of the loop's `style.transform`
 * write. The character looked perfect; the page stuttered.
 *
 * Note the rule that applies here is NOT the one `frameBody` enforces.
 * Measuring layout is this function's entire job, so "contains no readers"
 * would be an absurd assertion. What has to hold is the ORDER — every read
 * before every write, and the whole of it before the frame draws.
 */
function measureBody(): string {
  return slice('const measure = () => {', 'function schedule(', 'the anchor measurement');
}

/** The layout questions a browser cannot answer without recomputing layout. */
const LAYOUT_READERS = [
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
];

test('the loop never measures layout', () => {
  const frame = frameBody();
  // Each of these forces the browser to recompute layout before it can answer.
  // In a function that also writes style, every one of them is a reflow.
  for (const reader of LAYOUT_READERS) {
    assert.ok(
      !frame.includes(reader),
      `${reader} is read inside the animation frame — cache it from the resize listeners instead`
    );
  }
});

test('the frame reads before it writes: the measurement is folded in, first', () => {
  const frame = frameBody();
  // The read phase exists at all...
  assert.match(
    frame,
    /if \(measurePending\) \{\s*measurePending = false;\s*measure\(\);/,
    'the frame should consume a pending measurement, once, at the top'
  );
  // ...and it is ahead of everything this frame writes. `writeFrame` sets
  // `style.transform` and `handle.current?.apply` pushes attributes onto the
  // SVG; a measurement after either of them is the forced reflow again.
  const read = frame.indexOf('measure()');
  const write = frame.indexOf('writeFrame(');
  const draw = frame.indexOf('handle.current?.apply');
  assert.ok(read > 0 && write > 0 && draw > 0, 'read phase, writeFrame and apply should all be findable');
  assert.ok(read < write, 'the measurement must come BEFORE the frame writes any transform');
  assert.ok(read < draw, 'the measurement must come BEFORE the frame draws the face');
});

test('the measurement has no frame of its own', () => {
  /**
   * This is the whole mechanism. A second `requestAnimationFrame` cannot be
   * ordered against the loop's own — `tick` re-arms itself on its first line,
   * so anything queued after frame N runs after it in frame N+1 — and that is
   * precisely how a read ended up downstream of a write. One frame, one
   * callback, and a flag in between.
   */
  assert.ok(
    !/requestAnimationFrame\(measure\)/.test(code),
    'measure must not own a requestAnimationFrame — raise `measurePending` and let the loop consume it'
  );
  for (const raf of code.match(/requestAnimationFrame\((\w+)\)/g) ?? []) {
    assert.equal(raf, 'requestAnimationFrame(tick)', `only the loop may be scheduled on a frame, found ${raf}`);
  }
  assert.match(
    code,
    /function schedule\(animate = false\) \{[\s\S]*?measurePending = true;/,
    'schedule must raise the flag rather than queue a frame'
  );
});

test('the measurement itself asks every question before it writes anything', () => {
  /**
   * Reading layout is what this function is FOR, so the guard is order, not
   * absence: the last `getBoundingClientRect` / `getComputedStyle` /
   * `offsetParent` must come before the first `writeFrame`. Reverse that and
   * the reflow is back inside a single function, where the loop's ordering
   * cannot save it.
   */
  const body = measureBody();
  const firstWrite = body.indexOf('writeFrame(');
  assert.ok(firstWrite > 0, 'measure should still write the frame it measured');
  for (const reader of LAYOUT_READERS) {
    const last = body.lastIndexOf(reader);
    if (last === -1) continue;
    assert.ok(
      last < firstWrite,
      `${reader} is read AFTER measure() has already written a transform — that is the forced reflow, one function further in`
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
