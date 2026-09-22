#!/usr/bin/env node
/**
 * THE HOME BELTS REALLY MOVE, AND A FINGER CAN STILL MOVE THEM.
 *
 * «الشريط الإعلاني وشريط أبرز العلامات يجب أن يستمر في الحركة لكنه قابل
 *  للتحريك اليدوي — لا تحذف التحريك التلقائي.»
 *
 * WHY THIS IS A BROWSER TEST AND NOT A SOURCE-TEXT ASSERTION. The belt shipped
 * broken under a green suite: tests/homeSectionsLayout.test.ts pinned the drift
 * by matching the SOURCE of `el.scrollLeft += sign * speed * dt`. Every one of
 * those assertions passes on a belt that has not moved a pixel — which is
 * exactly what the owner then met on an iPad. A test that reads the code can
 * only ever confirm the code is the code.
 *
 * So this drives the REAL component in a REAL engine and measures the REAL
 * scroll position across real animation frames. It fails on the implementation
 * it replaces, for three independent reasons, and each case below names which.
 *
 * Run: node scripts/e2e-marquee-drift.mjs   (a vite dev server on :4175)
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium, webkit } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const base = process.env.MARQUEE_TEST_URL || 'http://127.0.0.1:4175/tests/browser/marquee.html';
const out = process.env.OUT_DIR || '/tmp/levonis-diagnostics/marquee';
await mkdir(out, { recursive: true });

const measurements = [];
let cases = 0;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The belt's position in the direction-free space the component works in.
 *
 * Read through `Math.abs` of the raw `scrollLeft` ONLY for reporting: what the
 * assertions use is the DISTANCE travelled, which is convention-independent
 * and therefore the same statement in Arabic and in English. That matters
 * because this repo has already been bitten once by asserting a sign.
 */
const pos = (page, belt) =>
  page.$eval(`[data-belt="${belt}"] .lv-mq`, (el) => Math.abs(el.scrollLeft));

/** Sample the position across painted frames rather than sleeping in Node: a
 *  loaded runner can defer a paint, and a wall-clock sleep would then measure
 *  the runner instead of the belt. */
async function travel(page, belt, ms) {
  return page.$eval(
    `[data-belt="${belt}"] .lv-mq`,
    (el, ms) =>
      new Promise((resolve) => {
        const start = Math.abs(el.scrollLeft);
        const t0 = performance.now();
        let min = start;
        let max = start;
        let prev = start;
        // DISTANCE TRAVELLED, not start-to-max.
        //
        // An endless belt RECYCLES: once per stride it folds a whole set
        // back, and after that fold the position is numerically lower while
        // the pixels on screen are identical. Measured as `max - start`, a
        // belt reads as barely moving whenever the window happens to straddle
        // that fold — a measurement artefact, not a stopped belt, and the
        // difference between testing the feature and testing where in the
        // loop the sample began.
        let moved = 0;
        const step = () => {
          const at = Math.abs(el.scrollLeft);
          const d = at - prev;
          // Forward, and small. A fold is one big jump backwards; a gesture is
          // a big jump either way. Both are excluded, so `moved` is the drift
          // and nothing else.
          if (d > 0 && d < 40) moved += d;
          prev = at;
          if (at < min) min = at;
          if (at > max) max = at;
          if (performance.now() - t0 < ms) requestAnimationFrame(step);
          else resolve({ start, end: at, min, max, moved, elapsed: performance.now() - t0 });
        };
        requestAnimationFrame(step);
      }),
    ms
  );
}

async function run(engine, name) {
  const browser = await engine.launch();
  const context = await browser.newContext({
    viewport: { width: 834, height: 1112 },
    hasTouch: true,
    isMobile: false,
    locale: 'ar',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-belt="brands"] .lv-mq');
  // One measurement pass has to land before anything can drift.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-belt="brands"] .lv-mq');
      return !!el && el.scrollWidth > el.clientWidth + 100;
    },
    { timeout: 8000 }
  );

  for (const belt of ['ads', 'brands']) {
    // ---------------------------------------------------------------- A
    // IT MOVES AT ALL, AND AT THE SPEED IT WAS ASKED FOR.
    //
    // This is the sub-pixel test. The old loop did `scrollLeft += 0.57` per
    // frame (0.28 on a 120 Hz panel) with no accumulator, so an engine that
    // hands the value back quantised rounded every increment away and the belt
    // sat still forever. A float position of its own is the fix, and a real
    // engine is the only place that can prove it.
    const a = await travel(page, belt, 1200);
    measurements.push({ engine: name, belt, case: 'drift', ...a });
    assert.ok(
      a.moved > 12,
      `${name}/${belt}: the belt must drift on its own — moved ${a.moved.toFixed(2)}px in ${Math.round(a.elapsed)}ms`
    );
    cases++;

    // ---------------------------------------------------------------- B
    // A TAP DOES NOT STOP IT FOR EVER.
    //
    // The defect the owner actually hit. `onMouseEnter` set a `hovered` flag
    // that only `onMouseLeave` cleared, and iPadOS synthesises the enter for a
    // tap and withholds the leave until the customer taps something else. One
    // touch and the belt was dead. Fails on the old implementation.
    const box = await page.locator(`[data-belt="${belt}"] .lv-mq`).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await delay(400);
    const b = await travel(page, belt, 1000);
    measurements.push({ engine: name, belt, case: 'after-tap', ...b });
    assert.ok(
      b.moved > 10,
      `${name}/${belt}: a tap must not latch the belt off — moved ${b.moved.toFixed(2)}px after a tap`
    );
    cases++;

    // ---------------------------------------------------------------- C
    // A HUMAN STILL MOVES IT, AND THE DRIFT COMES BACK AFTERWARDS.
    //
    // Both halves of the owner's sentence in one case: the manual movement the
    // rewrite was for, and the automatic motion they asked us not to remove.
    //
    // The input is a WHEEL rather than a synthetic mouse drag, and that is not
    // a convenience. Dragging with a mouse does not pan a scroll container in
    // any engine — panning is a touch gesture the compositor owns, and a
    // Playwright `mouse.down/move` cannot produce one. A wheel is a real input
    // event that really scrolls the container, and it exercises the exact
    // property under test: the loop must ADOPT a position it did not write,
    // yield the belt while the human is moving it, and resume when they stop.
    // A finger produces the same class of event; the fixture cannot fake one
    // honestly, so it tests the mechanism rather than pretending to touch.
    const before = await pos(page, belt);
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(90, 0);
      await delay(24);
    }
    const dragged = await pos(page, belt);
    measurements.push({ engine: name, belt, case: 'wheel', before, dragged });
    assert.ok(
      Math.abs(dragged - before) > 25,
      `${name}/${belt}: a human input must move the belt (${before.toFixed(1)} → ${dragged.toFixed(1)})`
    );
    cases++;

    // ---------------------------------------------------------------- C0
    // A FINGER HELD STILL ON THE BELT STOPS IT.
    //
    // This is NOT covered by the drag case and it is the regression the first
    // draft of the rewrite shipped: a stationary finger scrolls nothing, so a
    // loop that only notices movement never notices the finger, and the belt
    // slides out from under a thumb trying to press a mark. `pointerdown` is
    // the only evidence that exists, and it has to be cleared from the window
    // rather than the element or it becomes the very latch this replaced.
    // It has to be a TOUCH pointer, and that is the whole point. A
    // `mouse.down()` also fires `pointerenter`, so the belt would park on
    // HOVER and the case would pass on an implementation that ignores the
    // press entirely — a test that is satisfied for the wrong reason. A
    // dispatched touch pointer sets no hover, so only the press can stop it.
    //
    // The cursor is parked in the corner first for the same reason: a mouse
    // left resting on the belt by the case above would park it, and this case
    // would then prove nothing at all.
    await page.mouse.move(4, 4);
    await delay(250);
    await page.$eval(`[data-belt="${belt}"] .lv-mq`, (el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: 'touch',
          isPrimary: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        })
      );
    });
    await delay(200);
    const held = await travel(page, belt, 700);
    measurements.push({ engine: name, belt, case: 'held', ...held });
    assert.ok(
      held.moved < 3,
      `${name}/${belt}: a held finger must park the belt (moved ${held.moved.toFixed(2)}px)`
    );
    cases++;

    // AND THE LIFT IS HEARD ON THE WINDOW, wherever it happens. That is what
    // makes the press a signal and not the latch this file was rewritten to
    // kill: a `pointerup` on the element can be withheld, one on the window
    // cannot.
    await page.evaluate(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true })
      );
    });
    await delay(250);
    const lifted = await travel(page, belt, 800);
    measurements.push({ engine: name, belt, case: 'lifted', ...lifted });
    assert.ok(
      lifted.moved > 8,
      `${name}/${belt}: the drift must resume when the finger lifts (moved ${lifted.moved.toFixed(2)}px)`
    );
    cases++;

    // A MOUSE RESTING ON THE BELT PARKS IT. A mark sliding out from under a
    // cursor that is trying to click it is the reason hover exists at all,
    // and this is the ONLY thing allowed to stop the belt without expiring —
    // allowed to, because a mouse genuinely leaves and genuinely returns,
    // which is exactly what a touch screen's synthesised hover does not do.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await delay(400);
    const parked = await travel(page, belt, 700);
    measurements.push({ engine: name, belt, case: 'hover-parked', ...parked });
    assert.ok(
      parked.moved < 3,
      `${name}/${belt}: a resting mouse must park the belt (moved ${parked.moved.toFixed(2)}px)`
    );
    cases++;

    // AND THE DRIFT COMES BACK. The second half of the owner's sentence: the
    // automatic motion is not something a human can spend. On a touch screen
    // there is no hover at all, which is why the tap case above is the one
    // that matters on their iPad — this is the desktop half of the same rule.
    await page.mouse.move(box.x + box.width / 2, box.y - 60);
    await delay(350);
    const c = await travel(page, belt, 900);
    measurements.push({ engine: name, belt, case: 'resume', ...c });
    assert.ok(
      c.moved > 8,
      `${name}/${belt}: the drift must resume once the pointer leaves — moved ${c.moved.toFixed(2)}px`
    );
    cases++;

    // ---------------------------------------------------------------- D
    // IT NEVER RUNS OUT OF TRACK.
    //
    // The recycle is what makes the belt endless. If it ever stopped
    // recycling, the position would pin at `scrollWidth - clientWidth` and
    // stay there — a belt that drifts for ten seconds and then dies is the
    // same complaint arriving later.
    const long = await travel(page, belt, 2500);
    const ceiling = await page.$eval(
      `[data-belt="${belt}"] .lv-mq`,
      (el) => el.scrollWidth - el.clientWidth
    );
    measurements.push({ engine: name, belt, case: 'endless', ...long, ceiling });
    assert.ok(
      long.max < ceiling - 1,
      `${name}/${belt}: the belt must recycle, not park at the end (${long.max.toFixed(1)} of ${ceiling})`
    );
    assert.ok(
      long.moved > 40,
      `${name}/${belt}: it must still be moving after several seconds`
    );
    cases++;
  }

  // ------------------------------------------------------------------ E
  // LEFT TO RIGHT WORKS TOO, AND THE APP LANGUAGE IS NOT WHAT DECIDES IT.
  //
  // The file this replaces asserted "scrollLeft IS NEGATIVE IN RTL in every
  // browser this ships to" and derived a sign from the UI language, while
  // src/lib/useRail.ts in the same repo had already measured three
  // incompatible conventions. On the wrong one the belt drives straight into a
  // clamp and dies. The fixture flips the document direction without touching
  // the language, which is precisely the disagreement that used to be fatal.
  const ltr = await travel(page, 'ltr', 1200);
  measurements.push({ engine: name, belt: 'ltr', case: 'ltr', ...ltr });
  assert.ok(
    ltr.moved > 12,
    `${name}: the belt must drift in LTR as well — moved ${ltr.moved.toFixed(2)}px`
  );
  cases++;

  // ------------------------------------------------------------------ F
  // REDUCED MOTION PARKS IT AND LEAVES IT SWIPEABLE — it is not faked back on.
  const reduced = await context.newPage();
  await reduced.emulateMedia({ reducedMotion: 'reduce' });
  await reduced.goto(base, { waitUntil: 'networkidle' });
  await reduced.waitForSelector('[data-belt="brands"] .lv-mq');
  await delay(700);
  const still = await travel(reduced, 'brands', 1000);
  const swipeable = await reduced.$eval(
    '[data-belt="brands"] .lv-mq',
    (el) => el.scrollWidth > el.clientWidth + 50
  );
  measurements.push({ engine: name, belt: 'brands', case: 'reduced', ...still, swipeable });
  assert.ok(
    still.moved < 3,
    `${name}: prefers-reduced-motion must stop the drift (moved ${still.moved.toFixed(2)}px)`
  );
  assert.ok(swipeable, `${name}: and must still leave a rail a finger can drag`);
  cases += 2;
  await reduced.close();

  assert.deepEqual(errors, [], `${name}: the page threw`);
  await browser.close();
  console.log(`${name}: ok`);
}

const engines = [[chromium, 'chromium']];
// WebKit is the engine the shop is actually run from. It is included when the
// runner has it; a missing WebKit is reported, never silently skipped.
if (process.env.MARQUEE_SKIP_WEBKIT !== '1') engines.push([webkit, 'webkit']);

const failures = [];
for (const [engine, name] of engines) {
  try {
    await run(engine, name);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

await writeFile(`${out}/marquee-drift.json`, JSON.stringify({ cases, measurements, failures }, null, 2));
console.log(`\n${cases} assertions across ${engines.length} engine(s); report at ${out}/marquee-drift.json`);
if (failures.length) {
  console.error('\nFAILED:\n' + failures.join('\n'));
  process.exit(1);
}
