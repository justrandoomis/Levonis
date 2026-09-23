#!/usr/bin/env node
/**
 * THE ORDER CELEBRATION AND THE BUSY OVERLAY, IN A REAL BROWSER.
 *
 * Drives tests/browser/celebration.html (real NavigationRouter, AppIntro,
 * AppBusy, OrderCelebration; no API) through the four things the owner
 * reported, on a phone-sized viewport with the CPU throttled like a weak
 * phone:
 *
 *   1. BOOT — the shell's route wait must not draw the overlay over the
 *      character's centred intro.
 *   2. A LAZY NAVIGATION — the overlay covers the old page while the chunk
 *      downloads (it used to stay live and silent), and a cached route never
 *      flashes it.
 *   3. THE ORDER — the character APPEARS on the stage (no journey from the
 *      header, no `travelling` phase), pops and hops on the compositor, the
 *      burst goes off, and the frame timing is recorded.
 *   4. REDUCED MOTION — no burst, and the entrance is opacity only.
 *
 * Run:  npx vite --port 4179 --strictPort --host 127.0.0.1   (from the repo)
 *       node scripts/e2e-celebration.mjs
 * Env:  CELEBRATION_TEST_URL, OUT_DIR (screenshots, trace, frames.json),
 *       CPU_THROTTLE (default 4), PLAYWRIGHT_MODULE.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.CELEBRATION_TEST_URL || 'http://127.0.0.1:4179/tests/browser/celebration.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/bloub';
const CPU = Number(process.env.CPU_THROTTLE || 4);
await mkdir(out, { recursive: true });

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Watches, from the first byte, when the overlay appears and in what intro phase. */
function recorder() {
  window.__busyLog = [];
  window.__phaseLog = [];
  const observe = () => {
    new MutationObserver(() => {
      const busy = document.querySelector('[data-app-busy]');
      const phase = document.querySelector('.lv-app-intro')?.getAttribute('data-phase') ?? null;
      const last = window.__busyLog[window.__busyLog.length - 1];
      const now = busy ? busy.getAttribute('data-app-busy') : null;
      if (!last || last.reason !== now) window.__busyLog.push({ t: performance.now(), reason: now, phase });
      const lastPhase = window.__phaseLog[window.__phaseLog.length - 1];
      if (phase && (!lastPhase || lastPhase.phase !== phase)) window.__phaseLog.push({ t: performance.now(), phase });
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase', 'data-app-busy'] });
  };
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe);
}

/** Every animation frame for `ms`: its timestamp, where the character is, and its pose. */
const frames = (page, ms) =>
  page.evaluate(
    (ms) =>
      new Promise((done) => {
        const rows = [];
        const t0 = performance.now();
        const step = (t) => {
          const node = document.querySelector('.lv-app-intro__character');
          const pose = document.querySelector('.lv-app-intro__pose');
          const m = node?.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px[^)]*\)\s*scale\(([\d.]+)\)/);
          rows.push({
            t,
            x: m ? Number(m[1]) : null,
            y: m ? Number(m[2]) : null,
            scale: m ? Number(m[3]) : null,
            pose: pose ? getComputedStyle(pose).transform : null,
            phase: document.querySelector('.lv-app-intro')?.getAttribute('data-phase'),
            state: document.querySelector('.lv-app-intro')?.getAttribute('data-mascot-state'),
            busy: document.querySelector('[data-app-busy]')?.getAttribute('data-app-busy') ?? null,
          });
          if (t - t0 < ms) requestAnimationFrame(step);
          else done(rows);
        };
        requestAnimationFrame(step);
      }),
    ms
  );

function stats(deltas) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    frames: deltas.length,
    meanMs: +(deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length)).toFixed(2),
    p95Ms: +pick(0.95).toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2),
    over33ms: deltas.filter((d) => d > 33.4).length,
    over50ms: deltas.filter((d) => d > 50).length,
  };
}

const browser = await chromium.launch();
const results = {};
try {
  // ------------------------------------------------------------- 1. boot
  {
    const context = await browser.newContext(PHONE);
    await context.addInitScript(recorder);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    await page.goto(`${base}?boot=1200`);
    await delay(700);
    await page.screenshot({ path: `${out}/1-boot-intro.png` });
    await page.waitForSelector('.lv-app-intro[data-phase="docked"]', { timeout: 10000 });
    const busyLog = await page.evaluate(() => window.__busyLog);
    const overIntro = busyLog.filter((e) => e.reason && e.phase === 'loading');
    assert.deepEqual(overIntro, [], 'the route overlay covered the booting character');
    results.boot = { busyLog };
    console.log('✓ boot: the route wait never drew the overlay over the intro');

    // ------------------------------------------------ 2. lazy navigation
    await page.click('#slow');
    await delay(450);
    assert.equal(await page.locator('[data-app-busy="route"]').count(), 1, 'the pending navigation holds the screen');
    assert.equal(await page.locator('[data-page="checkout"]').count(), 1, 'the old page stays underneath, not a black fallback');
    await page.screenshot({ path: `${out}/2-route-pending.png` });
    // A tap on the page underneath is swallowed.
    await page.mouse.click(195, 300);
    await page.waitForSelector('[data-page="slow"]', { timeout: 8000 });
    await page.waitForFunction(() => !document.querySelector('[data-app-busy]'), null, { timeout: 2000 });
    console.log('✓ route: overlay covered the pending chunk and let go when it arrived');

    // A navigation to a page whose code is already here must not flash it.
    await page.evaluate(() => { window.__busyLog = []; });
    await page.goBack();
    await page.waitForSelector('[data-page="checkout"]');
    await delay(500);
    const flashes = (await page.evaluate(() => window.__busyLog)).filter((e) => e.reason);
    assert.deepEqual(flashes, [], 'a cached route flashed the overlay');
    console.log('✓ route: a cached navigation showed nothing');
    await context.close();
  }

  // ---------------------------------------------- 3. the order, measured
  {
    const context = await browser.newContext(PHONE);
    await context.addInitScript(recorder);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    await page.goto(`${base}?boot=300&order=700`);
    await page.waitForSelector('.lv-app-intro[data-phase="docked"]', { timeout: 10000 });
    await delay(600);

    await browser.startTracing(page, { path: `${out}/order-trace.json`, screenshots: false });
    const recording = frames(page, 2600);
    await delay(50);
    await page.click('#place');
    const rows = await recording;
    await browser.stopTracing();

    const placedAt = await page.evaluate(() => window.__placedAt);
    assert.ok(placedAt, 'the order was placed');
    const after = rows.filter((r) => r.t >= placedAt && r.t <= placedAt + 1500);
    const stage = await page.locator('[data-bloub-anchor="stage"]').boundingBox();

    // NO JOURNEY: never `travelling`, and the character is at the stage from
    // its first frame there — not a series of positions down the page.
    assert.ok(!rows.some((r) => r.t >= placedAt && r.phase === 'travelling'), 'the character travelled to the stage');
    const positions = [...new Set(after.map((r) => `${Math.round(r.x)},${Math.round(r.y)}`))];
    assert.ok(positions.length <= 2, `the character moved through ${positions.length} positions: ${positions.join(' ')}`);
    const landed = after[after.length - 1];
    assert.ok(Math.abs(landed.y - stage.y) < 2 && Math.abs(landed.x - stage.x) < 2, 'it is standing on the stage');
    // THE ENTRANCE RAN on the pose wrapper (a non-identity transform mid-way)
    // and ended at rest.
    assert.ok(after.some((r) => r.pose && r.pose !== 'none' && r.pose !== 'matrix(1, 0, 0, 1, 0, 0)'), 'no entrance played');
    const settled = await page.evaluate(() => getComputedStyle(document.querySelector('.lv-app-intro__pose')).transform);
    assert.ok(settled === 'none' || settled === 'matrix(1, 0, 0, 1, 0, 0)', `the entrance left a transform behind: ${settled}`);
    // The scrim did not fade over the celebration.
    assert.ok(!after.slice(1).some((r) => r.busy), 'the order overlay was still up over the confirmation');
    // It celebrates from the landing, and is still celebrating as the body
    // comes to rest (the entrance is 1.3s).
    const celebrating = after.filter((r) => r.t >= placedAt + 100 && r.t <= placedAt + 1350);
    assert.ok(celebrating.length > 0 && celebrating.every((r) => r.state === 'celebrate'), 'the face was not celebrating throughout the entrance');

    const deltas = after.slice(1).map((r, i) => r.t - after[i].t);
    results.order = { cpuThrottle: CPU, successWindow: stats(deltas), positions };
    await writeFile(`${out}/frames.json`, JSON.stringify({ placedAt, rows }, null, 1));
    console.log('✓ order: appeared on the stage, no journey; frame timing', JSON.stringify(results.order.successWindow));

    // Leaving the stage: it appears on the next dock, again without a journey.
    await page.click('#home');
    await page.waitForSelector('[data-page="elsewhere"]');
    await delay(600);
    const phases = (await page.evaluate(() => window.__phaseLog)).filter((p) => p.t > placedAt).map((p) => p.phase);
    assert.ok(!phases.includes('travelling'), `left the stage by travelling: ${phases.join(' → ')}`);
    assert.equal(await page.getAttribute('.lv-app-intro', 'data-phase'), 'docked');
    results.leave = { phases };
    console.log('✓ leave: back on the header dock without a journey', phases.join(' → '));
    await context.close();
  }

  // ------------------------------- screenshots, scrubbed to exact times
  // Every running animation on the page — the pose entrance (WAAPI) and the
  // burst (CSS) — is paused and set to the same moment, so each picture is a
  // frame of the real animation at a known time rather than wherever a
  // screenshot happened to land.
  {
    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    await page.goto(`${base}?boot=300&order=600`);
    await page.waitForSelector('.lv-app-intro[data-phase="docked"]', { timeout: 10000 });
    await delay(400);
    await page.click('#place');
    await delay(300);
    await page.screenshot({ path: `${out}/3-order-overlay.png` });
    await page.waitForSelector('[data-page="confirmation"]', { timeout: 5000 });
    await page.evaluate(() => {
      window.__celebration = document.getAnimations();
      for (const a of window.__celebration) a.pause();
    });
    for (const [i, ms] of [0, 120, 220, 330, 520, 690, 800, 1000, 1300].entries()) {
      await page.evaluate((ms) => {
        for (const a of window.__celebration) a.currentTime = ms;
      }, ms);
      await delay(120);
      await page.screenshot({ path: `${out}/4-celebration-${String(i).padStart(2, '0')}-${ms}ms.png` });
    }
    await page.evaluate(() => {
      for (const a of window.__celebration) a.play();
    });
    await delay(1600);
    await page.screenshot({ path: `${out}/5-confirmation-settled.png` });
    await context.close();
  }

  // ------------------------------------------------- 4. reduced motion
  {
    const context = await browser.newContext({ ...PHONE, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(`${base}?boot=300&order=300`);
    await page.waitForSelector('.lv-app-intro[data-phase="docked"]', { timeout: 10000 });
    await delay(300);
    // Slowed, so the 200ms fade is still running when it is inspected.
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.02 });
    await page.click('#place');
    await page.waitForSelector('[data-page="confirmation"]', { timeout: 5000 });
    const burst = await page.evaluate(() => getComputedStyle(document.querySelector('.lv-celebration__burst')).display);
    assert.equal(burst, 'none', 'the burst is drawn under reduced motion');
    const keys = await page.evaluate(() =>
      [...document.querySelector('.lv-app-intro__pose').getAnimations()].flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k)))
    );
    assert.ok(keys.includes('opacity'), 'the character still fades in on the stage');
    assert.ok(!keys.includes('transform'), `the reduced entrance moves: ${keys.join(',')}`);
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
    await delay(400);
    await page.screenshot({ path: `${out}/6-reduced-motion.png` });
    results.reduced = { burst, keys: [...new Set(keys)] };
    console.log('✓ reduced motion: no burst, entrance keys', results.reduced.keys.join(','));
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
}
console.log(`results and screenshots in ${out}`);
