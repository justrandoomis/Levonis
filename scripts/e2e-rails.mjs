#!/usr/bin/env node
/**
 * FLICK PHYSICS ON THE HORIZONTAL RAILS — the gesture half of the motion
 * system, proven in a real browser.
 *
 * src/lib/motion.ts shipped `project()`, `nearestSnap()`, `rubberband()`,
 * `VelocityTracker` and `DRAG_THRESHOLD_PX` with nothing calling them. This
 * proves they are now attached to something and that the something behaves:
 *
 *   1. a flick released BETWEEN two cards rests exactly ON a card — the whole
 *      point, and the thing a screenshot cannot show;
 *   2. the landing follows the PROJECTION, not the release point: the same
 *      displacement thrown fast lands further along than the same displacement
 *      dragged to a stop. That difference is `project()` and nothing else;
 *   3. a press that moves under the 10px threshold is still a TAP and still
 *      navigates, and one that moves past it does not;
 *   4. a mostly-vertical gesture is never claimed from the page;
 *   5. RTL and LTR produce the SAME direction-free numbers, which is the only
 *      honest way to check a right-to-left rail;
 *   6. reduced motion still LANDS on the snap point, it just jumps there;
 *   7. a rail that becomes a wrapped grid above `sm` detaches, so a drag
 *      handler never swallows a click on a layout it does not own;
 *   8. Arabic text never carries letter-spacing, which severs its joins.
 *
 * Nothing here waits on a timer for a spring: every assertion waits on the
 * invariant it is about, so a slow machine cannot make it flake.
 *
 *   node scripts/e2e-rails.mjs                (expects wrangler dev on :8787)
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
  }
}

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const SEL = '[data-home-section="services"] [data-rail]';

/** The probe's own copy of nearestSnap, so the assertion is independent. */
const nearestSnap = (p, pts) =>
  pts.reduce((best, x) => (Math.abs(x - p) < Math.abs(best - p) ? x : best), pts[0]);

async function openHome(browser, { lang = 'ar', width = 480, reducedMotion, expectRail = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  await ctx.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ['levo_lang', lang]
  );
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' }).catch(() => {});
  // At a desktop width the rails FIT, so the hook detaches and `[data-rail]`
  // is legitimately absent — waiting for it there would be waiting for the
  // bug this file exists to rule out.
  await page.waitForSelector(expectRail ? SEL : '[data-home-section="services"]', { timeout: 20000 });
  await page.waitForTimeout(500);
  return { ctx, page };
}

const readRail = (page) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      pos: Number(el.dataset.railPos),
      release: el.dataset.railRelease === undefined ? null : Number(el.dataset.railRelease),
      pts: (el.dataset.railSnap || '').split(',').filter(Boolean).map(Number),
      max: Math.max(0, el.scrollWidth - el.clientWidth),
      dir: cs.direction,
      scrollPaddingInlineStart: cs.scrollPaddingInlineStart,
      paddingInlineStart: cs.paddingInlineStart,
      overscrollX: cs.overscrollBehaviorX,
      box: (() => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })(),
    };
  }, SEL);

/**
 * Waits for the rail to be AT REST on a snap point — never a fixed sleep, and
 * never merely "currently on a snap point": a spring travelling to the end
 * passes THROUGH the points in between, so a predicate that only checks the
 * position would sample a moving rail and report a landing that never
 * happened. Rest means the position has not changed across two consecutive
 * animation frames.
 */
async function settle(page) {
  // SYNCHRONOUS on purpose. An async predicate returns a Promise, and a
  // Promise is a truthy object — with raf polling the wait resolves on the
  // first frame and reports whatever the rail happened to be doing. The
  // stability counter lives on the element so it survives across frames.
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      if (el.hasAttribute('data-rail-dragging')) {
        el.__railStable = 0;
        return false;
      }
      const pos = Number(el.dataset.railPos);
      if (el.__railLast === pos) el.__railStable = (el.__railStable || 0) + 1;
      else {
        el.__railLast = pos;
        el.__railStable = 0;
      }
      const pts = (el.dataset.railSnap || '').split(',').filter(Boolean).map(Number);
      return el.__railStable >= 3 && pts.some((p) => Math.abs(p - pos) <= 1);
    },
    SEL,
    { timeout: 8000, polling: 'raf' }
  );
  return readRail(page);
}

/**
 * Back to the start, and PROVEN to be there before anything is measured.
 *
 * Writing `scrollLeft = 0` is not enough on its own: a spring still in flight
 * keeps writing frames afterwards and drags the rail back off the start, and
 * a card measured in that window is somewhere it will not be a moment later —
 * which is how the tap test ended up pressing the empty space past the last
 * card and concluding that taps were broken.
 */
async function resetRail(page) {
  await settle(page);
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      if (Number(el.dataset.railPos) !== 0) {
        el.scrollLeft = 0;
        el.__railZero = 0;
        return false;
      }
      el.__railZero = (el.__railZero || 0) + 1;
      return el.__railZero >= 3;
    },
    SEL,
    { timeout: 8000, polling: 'raf' }
  );
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.removeAttribute('data-rail-release');
    el.__railStable = 0;
    el.__railLast = undefined;
  }, SEL);
  return readRail(page);
}

/** Drag from the rail's centre by `dx` in DIRECTION-FREE forward pixels. */
async function drag(page, rail, forwardPx, { steps = 4, holdMs = 0 } = {}) {
  const sign = rail.dir === 'rtl' ? 1 : -1; // move the cursor opposite to travel
  const cx = rail.box.x + rail.box.w / 2;
  const cy = rail.box.y + rail.box.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + sign * forwardPx, cy, { steps });
  if (holdMs) await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

async function run(browser, lang) {
  console.log(`\n--- ${lang.toUpperCase()} ---`);
  const { ctx, page } = await openHome(browser, { lang });
  let rail = await readRail(page);

  check(`${lang}: the services rail is live and measured`, !!rail && rail.pts.length >= 2,
    rail ? `pts=${rail.pts.length}` : 'no rail');
  if (!rail || rail.pts.length < 2) { await ctx.close(); return; }

  check(`${lang}: the direction is what the language asks for`,
    rail.dir === (lang === 'en' ? 'ltr' : 'rtl'), rail.dir);
  // Direction-free coordinates: the SAME numbers in both languages. That is
  // the RTL proof — not a mirrored expectation, an identical one.
  check(`${lang}: position starts at 0 whichever way the page reads`, rail.pos === 0, `pos=${rail.pos}`);
  check(`${lang}: the first snap point is the start`, rail.pts[0] === 0, `pts[0]=${rail.pts[0]}`);
  check(`${lang}: the last snap point is the end`,
    Math.abs(rail.pts[rail.pts.length - 1] - rail.max) <= 1, `${rail.pts.at(-1)} vs max ${Math.round(rail.max)}`);

  // The alignment bug the hook closes: CSS snaps to the PADDING box, so a
  // bleeding rail without this lands a padding-width past where card 0 rests.
  check(`${lang}: snap padding matches the rail's own bleed padding`,
    rail.scrollPaddingInlineStart === rail.paddingInlineStart,
    `${rail.scrollPaddingInlineStart} vs ${rail.paddingInlineStart}`);
  // Without this a flick at the start navigates the browser out of the page.
  check(`${lang}: a flick at the start cannot navigate the browser back`,
    rail.overscrollX === 'contain', rail.overscrollX);

  // ---- 1. a flick released off-grid rests on a card
  const stride = rail.pts[1] - rail.pts[0];
  await drag(page, rail, Math.round(stride * 1.5));
  let after = await settle(page);
  const offGrid = Math.min(...rail.pts.map((p) => Math.abs(p - after.release)));
  check(`${lang}: the cursor let go between two cards`, offGrid >= 8, `${offGrid.toFixed(1)}px off the nearest`);
  check(`${lang}: but the rail came to rest exactly on one`,
    after.pts.some((p) => Math.abs(p - after.pos) <= 1), `pos=${after.pos} pts=${after.pts.join(',')}`);
  check(`${lang}: so it kept moving after the cursor left`, after.pos !== after.release,
    `release=${after.release} pos=${after.pos}`);

  // ---- 2. the landing follows the PROJECTION, not the release point
  // Back to the start first, so both trials begin identically.
  rail = await resetRail(page);
  // Slow: the same displacement, then hold still. VelocityTracker's window is
  // 100ms, so a 200ms hold makes the release velocity exactly zero.
  await drag(page, rail, Math.round(stride * 1.4), { steps: 24, holdMs: 200 });
  const slow = await settle(page);
  check(`${lang}: a drag brought to a stop lands nearest where it stopped`,
    Math.abs(slow.pos - nearestSnap(slow.release, slow.pts)) <= 1,
    `pos=${slow.pos} nearest(${slow.release})=${nearestSnap(slow.release, slow.pts)}`);

  rail = await resetRail(page);
  await drag(page, rail, Math.round(stride * 1.4), { steps: 2 });
  const fast = await settle(page);
  check(`${lang}: the same distance THROWN lands further along`, fast.pos > slow.pos,
    `fast=${fast.pos} slow=${slow.pos}`);
  check(`${lang}: and still on a card, not wherever the throw stopped`,
    fast.pts.some((p) => Math.abs(p - fast.pos) <= 1), `pos=${fast.pos}`);

  // ---- 3. tap versus drag: the cards must stay clickable
  rail = await resetRail(page);
  // A GUEST-OPEN destination on purpose: /warranty is behind ProtectedRoute
  // and a tap on it lands on /auth, which would read as "the tap did not
  // work" when in fact it worked perfectly and the router did its job.
  const card = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const link = el.querySelector('a[href="/tools"]');
    if (!link) return null;
    const r = link.getBoundingClientRect();
    return { href: link.getAttribute('href'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, SEL);
  check(`${lang}: the rail holds a real link to press`, !!card, card ? card.href : 'none');
  if (card) {
    await page.mouse.move(card.x, card.y);
    await page.mouse.down();
    await page.mouse.move(card.x + 6, card.y, { steps: 2 }); // under the 10px threshold
    await page.mouse.up();
    await page.waitForURL((u) => new URL(u).pathname === card.href, { timeout: 4000 }).catch(() => {});
    check(`${lang}: a press that barely moved is still a tap`,
      new URL(page.url()).pathname === card.href, page.url());
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForSelector(SEL, { timeout: 20000 });
    await page.waitForTimeout(500);

    rail = await readRail(page);
    const before = page.url();
    const card2 = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const link = el.querySelector('a[href="/tools"]');
      const r = link.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, SEL);
    await page.mouse.move(card2.x, card2.y);
    await page.mouse.down();
    await page.mouse.move(card2.x + (rail.dir === 'rtl' ? 45 : -45), card2.y, { steps: 5 });
    await page.mouse.up();
    await settle(page);
    check(`${lang}: a drag across a card does NOT follow its link`, page.url() === before, page.url());
    const moved = await readRail(page);
    check(`${lang}: and it actually scrolled the rail`, moved.pos > 0, `pos=${moved.pos}`);
  }

  // ---- 4. a vertical gesture belongs to the page
  rail = await resetRail(page);
  const cx = rail.box.x + rail.box.w / 2;
  const cy = rail.box.y + rail.box.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  let claimed = false;
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx + 4, cy + 12 * (i + 1), { steps: 1 });
    if (await page.evaluate((sel) => document.querySelector(sel).hasAttribute('data-rail-dragging'), SEL)) {
      claimed = true;
    }
  }
  await page.mouse.up();
  check(`${lang}: a mostly-vertical gesture is never claimed by the rail`, !claimed);
  const still = await readRail(page);
  check(`${lang}: and the rail did not move`, still.pos === 0, `pos=${still.pos}`);

  // ---- 5. Arabic never carries letter-spacing
  if (lang !== 'en') {
    const spaced = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll('[class*="tracking-"]')) {
        const ls = getComputedStyle(el).letterSpacing;
        if (ls && ls !== 'normal' && Math.abs(parseFloat(ls)) > 0.01) {
          bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} = ${ls}`);
        }
      }
      return bad;
    });
    check('ar: no Arabic element carries letter-spacing (it severs the joins)',
      spaced.length === 0, spaced.slice(0, 3).join(' | '));
  }

  await ctx.close();
}

async function main() {
  console.log(`\nLEVONIS rail gestures — ${BASE}\n`);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  await run(browser, 'ar');
  await run(browser, 'en');

  // ---- reduced motion: it still LANDS on the snap point, it just jumps.
  console.log('\n--- reduced motion ---');
  {
    const { ctx, page } = await openHome(browser, { reducedMotion: 'reduce' });
    const rail = await readRail(page);
    if (rail && rail.pts.length >= 2) {
      const stride = rail.pts[1] - rail.pts[0];
      await drag(page, rail, Math.round(stride * 1.5));
      // Two frames after release the position is already final: no travel.
      const immediate = await page.evaluate(
        (sel) =>
          new Promise((res) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => res(Number(document.querySelector(sel).dataset.railPos)))
            )
          ),
        SEL
      );
      const rest = await settle(page);
      check('reduced motion: it jumps instead of travelling', immediate === rest.pos,
        `two frames in ${immediate}, at rest ${rest.pos}`);
      check('reduced motion: and it still lands on a card',
        rest.pts.some((p) => Math.abs(p - rest.pos) <= 1), `pos=${rest.pos}`);
    } else {
      check('reduced motion: the rail is live', false, 'no rail');
    }
    await ctx.close();
  }

  // ---- above sm the shared strips rail is a wrapped grid and must detach.
  console.log('\n--- the wrapped layout above sm ---');
  {
    const { ctx, page } = await openHome(browser, { width: 1024, expectRail: false });
    const state = await page.evaluate(() => {
      // Every scroller the hook was attached to, at a width where none of them
      // should still be live: the wrapped strips, and the services rail that
      // simply fits.
      const nodes = [
        ...document.querySelectorAll('[data-home-section] [class*="overflow-x-auto"]'),
      ];
      return nodes.map((el) => ({
        section: el.closest('[data-home-section]').getAttribute('data-home-section'),
        live: el.hasAttribute('data-rail'),
        overflowX: getComputedStyle(el).overflowX,
        wraps: getComputedStyle(el).flexWrap === 'wrap',
        overflows: el.scrollWidth - el.clientWidth,
      }));
    });
    check('the home scrollers are found at 1024px', state.length > 0, `n=${state.length}`);
    const wrongly = state.filter((n) => n.live && (n.wraps || n.overflowX === 'visible' || n.overflows < 1));
    check('no rail stays attached to a layout that does not scroll',
      wrongly.length === 0,
      wrongly.map((n) => `${n.section}: wrap=${n.wraps} overflow=${n.overflowX} max=${n.overflows}`).join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
