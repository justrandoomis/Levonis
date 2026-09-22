#!/usr/bin/env node
/**
 * THE «!» REALLY OPENS, AND WHAT IT OPENS DOES NOT COVER THE NEXT NUMBER.
 *
 * «ثم علامة تعجب أمام كلمة تكلفة التوصيل إلى البيت حيث عند الضغط عليها يوضح
 *  أن توصيل حسب المنتج وعدد القطع ويوضح تكاليف التوصيل.»
 *
 * WHY THIS IS A BROWSER TEST. The failure mode of a disclosure is geometric,
 * and geometry is invisible to a test that reads source. Three ways this could
 * ship "working" and be useless on the owner's iPad:
 *
 *   1. a HOVER affordance — the source contains a panel, the finger never
 *      opens it;
 *   2. an ABSOLUTE panel — it opens, and lands on top of the next figure,
 *      which is the number the customer opened it to check;
 *   3. a panel INSIDE the `justify-between` row — it opens between the label
 *      and the price and squeezes the money off the line.
 *
 * Every one of those passes a grep. None of them passes this file, which taps
 * with a real touch pointer and measures real boxes.
 *
 * Run: node scripts/e2e-summary-info.mjs   (a vite dev server on :4176)
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium, webkit } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const base = process.env.SUMMARY_TEST_URL || 'http://127.0.0.1:4176/tests/browser/summary.html';
const out = process.env.OUT_DIR || '/tmp/levonis-diagnostics/summary';
await mkdir(out, { recursive: true });

const notes = [];
let cases = 0;

const box = (page, sel) => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());

/** A real finger, not a mouse: the owner has no pointer that can hover. */
async function tap(page, sel) {
  await page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: 'touch',
      isPrimary: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.click();
  });
  await page.waitForTimeout(60);
}

async function check(name, fn) {
  cases += 1;
  await fn();
  notes.push(`ok   ${name}`);
  console.log(`ok   ${name}`);
}

async function run(engine, label, width, height) {
  const browser = await engine.launch();
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-summary-info="delivery"]');

  const btn = '[data-summary-info="delivery"]';
  const panel = '[data-summary-info-panel="delivery"]';
  const next = '[data-summary-row="cod-tax"]';

  await check(`${label}: closed by default — the row costs one glyph and nothing else`, async () => {
    assert.equal(await page.$(panel), null, 'the answer was showing before anybody asked');
    assert.equal(await page.getAttribute(btn, 'aria-expanded'), 'false');
  });

  const rowBefore = await box(page, '[data-summary-row="delivery"]');
  const nextBefore = await box(page, next);

  await check(`${label}: a TOUCH tap opens it (a hover affordance would not)`, async () => {
    await tap(page, btn);
    assert.ok(await page.$(panel), 'the finger did not open the answer');
    assert.equal(await page.getAttribute(btn, 'aria-expanded'), 'true');
  });

  await check(`${label}: it answers what the owner asked it to answer`, async () => {
    const text = await page.textContent(panel);
    assert.match(text, /حسب كل منتج وعدد قطعه/, 'the answer must say per product and per piece');
    assert.match(text, /توصيل حسب المنتج/, 'the answer must show the cost breakdown');
  });

  await check(`${label}: the answer PUSHES the next figure down, never covers it`, async () => {
    const p = await box(page, panel);
    const nextAfter = await box(page, next);
    // Below the row it explains...
    assert.ok(p.top >= rowBefore.bottom - 1, `the panel (top ${p.top}) is not under its row (bottom ${rowBefore.bottom})`);
    // ...and the next figure moved down by at least the panel's height, which
    // an absolutely-positioned overlay could never do.
    const moved = nextAfter.top - nextBefore.top;
    assert.ok(moved >= p.height - 2, `the next row moved only ${moved.toFixed(1)}px for a ${p.height.toFixed(1)}px panel`);
    // Nothing overlaps.
    assert.ok(p.bottom <= nextAfter.top + 1, 'the answer overlaps the next figure');
    notes.push(`     next row moved ${moved.toFixed(1)}px for a ${p.height.toFixed(1)}px answer`);
  });

  await check(`${label}: the price stays on the label's line while the answer is open`, async () => {
    const row = await box(page, '[data-summary-row="delivery"] > div:first-child');
    assert.ok(row.height < 40, `the money line grew to ${row.height.toFixed(1)}px — the panel opened inside the flex`);
  });

  await check(`${label}: it closes the way it opened`, async () => {
    await tap(page, btn);
    assert.equal(await page.$(panel), null, 'the answer would not close');
    assert.equal(await page.getAttribute(btn, 'aria-expanded'), 'false');
    const nextBack = await box(page, next);
    assert.ok(Math.abs(nextBack.top - nextBefore.top) < 2, 'the column did not spring back');
  });

  await check(`${label}: two answers can be open at once without colliding`, async () => {
    await tap(page, btn);
    await tap(page, '[data-summary-info="cod-tax"]');
    const a = await box(page, panel);
    const b = await box(page, '[data-summary-info-panel="cod-tax"]');
    assert.ok(b.top >= a.bottom - 1, 'the second answer sits on top of the first');
    await tap(page, btn);
    await tap(page, '[data-summary-info="cod-tax"]');
  });

  await check(`${label}: a label with no room for it still leaves the «!» reachable`, async () => {
    const row = await box(page, '[data-summary-row="cod-commission"]');
    const mark = await box(page, '[data-summary-info="cod-commission"]');
    const value = await box(page, '[data-summary-row="cod-commission"] > div:first-child > span:last-child');
    assert.ok(mark.width >= 20 && mark.height >= 20, `the tap target shrank to ${mark.width}×${mark.height}`);
    assert.ok(mark.left >= row.left - 1 && mark.right <= row.right + 1, 'the «!» was pushed outside the row');
    assert.ok(value.left >= row.left - 1 && value.right <= row.right + 1, 'the figure was pushed outside the row');
    // RTL: the figure sits on the LEFT of a right-to-left row, and the «!»
    // must not have crossed over it.
    assert.ok(mark.left > value.right - 1, 'the «!» overlapped the figure');
    assert.ok(row.height < 40, `the long label wrapped the row to ${row.height.toFixed(1)}px`);
  });

  await check(`${label}: nothing overflows the viewport sideways`, async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page scrolls ${overflow}px sideways`);
  });

  await tap(page, btn);
  await page.screenshot({ path: `${out}/${label}-open.png`, fullPage: true });
  await tap(page, btn);
  await page.screenshot({ path: `${out}/${label}-closed.png`, fullPage: true });

  await browser.close();
}

await run(chromium, 'chromium-phone', 390, 844);
await run(chromium, 'chromium-ipad', 834, 1112);
if (process.env.SUMMARY_SKIP_WEBKIT !== '1') {
  await run(webkit, 'webkit-ipad', 834, 1112);
}

await writeFile(`${out}/proof.txt`, notes.join('\n') + '\n');
console.log(`\n${cases} checks passed. Screenshots and notes in ${out}`);
