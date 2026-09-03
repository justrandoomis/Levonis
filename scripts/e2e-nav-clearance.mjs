#!/usr/bin/env node
/**
 * The floating bottom nav must never cover page content.
 *
 * WHY THIS EXISTS. The owner reported "الشريط السفلي يظهر فوق المحتوى". It was
 * true on four routes and the cause took three wrong guesses to find, so it is
 * pinned here rather than left to a screenshot:
 *
 *   1. #main-scroll-container is a FLEX COLUMN, so every routed page is a flex
 *      item — and flex items shrink by default. A page 1180px tall was squashed
 *      to the container's 844px while its content overflowed the box, so the
 *      clearance below it sat ABOVE the overflow. This was the real cause.
 *   2. `min-h-screen` inside the container forces 100vh, taller than the
 *      container's content box, cancelling the reserved space.
 *   3. The clearance was a `padding-bottom` on the scroll container, and a
 *      scrolling flex container does not honour its own padding-bottom at the
 *      end of the scroll. It is a real element now.
 *
 * The check scrolls each route to its true bottom and then measures, in
 * pixels, the worst overlap between the nav and any text-bearing element.
 *
 * REACHING THE BOTTOM IS THE HARD PART, and getting it wrong invents a bug.
 * The nav is `position: fixed` and floats OVER the page, so mid-scroll it
 * covers content by design — the clearance only promises that the LAST content
 * clears it. An earlier version of this loop watched "the last scrollable
 * element's scrollTop" and stopped when that stopped changing; on the home
 * page, whose grid grows as it loads, that halted ~2,300px short and then
 * reported a product card passing under the nav as a 27px overlap. It was
 * measuring a floating nav doing its job.
 *
 * So the loop now watches #main-scroll-container itself and only measures once
 * that container is BOTH pinned to its own maximum scrollTop AND has stopped
 * growing for three consecutive passes. A route that never settles FAILS
 * loudly rather than being measured half-scrolled — a measurement taken at the
 * wrong scroll position is worthless in both directions, and this loop got a
 * false PASS at 390px for the same reason it got a false failure at 768px.
 *
 *   node scripts/e2e-nav-clearance.mjs        (expects wrangler dev on :8787)
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

// Routes the nav renders on, chosen to cover the layout shapes that broke:
// a plain page, one with its own scroll container, and two with min-h-screen.
const ROUTES = ['/', '/subscription', '/profile', '/referrals', '/points', '/wallet', '/orders', '/products'];
const rnd = Math.random().toString(36).slice(2, 8);

async function main() {
  console.log(`\nLEVONIS bottom-nav clearance — ${BASE}\n`);

  let cookie = '';
  const call = async (p, body) => {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return res.status;
  };
  const email = `nav-${rnd}@test.local`;
  await call('/api/auth/register', { email, username: `nav${rnd}`, name: 'Nav Probe', password: 'nav-pass-1' });
  const signedIn = (await call('/api/auth/login', { email, password: 'nav-pass-1' })) === 200;
  check('a signed-in session exists (the member pages need one)', signedIn);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  for (const width of [390, 768, 1024]) {
    console.log(`\n${width}px`);
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ar' });
    await ctx.addCookies([
      { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' },
    ]);
    const page = await ctx.newPage();

    for (const route of ROUTES) {
      await page.goto(BASE + route, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(1100);

      // To the TRUE bottom of the SCROLL CONTAINER, and only then measure.
      // Settled = pinned to its own maximum AND the height has stopped growing
      // three passes running, because lazy content keeps extending the page.
      let settled = 0;
      let lastHeight = -1;
      let state = null;
      for (let i = 0; i < 240 && settled < 3; i++) {
        state = await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
              el.scrollTop = el.scrollHeight;
            }
          }
          window.scrollTo(0, document.body.scrollHeight);
          const m = document.getElementById('main-scroll-container');
          if (!m) return null;
          return { top: m.scrollTop, height: m.scrollHeight, client: m.clientHeight };
        });
        if (!state) break;
        await page.waitForTimeout(220);
        const atBottom = state.top >= state.height - state.client - 2;
        if (atBottom && state.height === lastHeight) settled += 1;
        else settled = 0;
        lastHeight = state.height;
      }
      // A route that never settles must not be measured: half-scrolled, a
      // fixed nav legitimately covers content and the result means nothing.
      check(
        `${width}px ${route} — the page reached its true bottom before measuring`,
        !state || settled >= 3,
        state ? `stopped at ${state.top} of ${state.height - state.client}` : 'no scroll container'
      );

      const out = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="LEVONIS"]');
        if (!nav) return { nav: false };
        const n = nav.getBoundingClientRect();
        let worst = null;
        for (const el of document.querySelectorAll('main *')) {
          if (el.closest('nav[aria-label="LEVONIS"]')) continue;
          const t = (el.textContent || '').trim();
          // Text-bearing leaves only: a wrapper "overlapping" the nav is
          // meaningless, what matters is whether a WORD is covered.
          if (!t || el.children.length > 0) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          const oy = Math.min(n.bottom, r.bottom) - Math.max(n.top, r.top);
          const ox = Math.min(n.right, r.right) - Math.max(n.left, r.left);
          if (oy > 2 && ox > 2) {
            const px = Math.round(oy);
            if (!worst || px > worst.px) worst = { px, text: t.slice(0, 40) };
          }
        }
        // The invariant behind the pixel measurement: at the bottom of the
        // page the clearance element must span the whole band the nav floats
        // in. Overlap is the SYMPTOM; this is the cause, and it is exact.
        const sp = document.querySelector('[data-nav-clearance]');
        const spr = sp ? sp.getBoundingClientRect() : null;
        return {
          nav: true,
          worst,
          spacer: !!sp,
          covers: !!spr && spr.top <= n.top + 1 && spr.bottom >= n.bottom - 1,
          band: spr ? `spacer ${Math.round(spr.top)}-${Math.round(spr.bottom)} vs nav ${Math.round(n.top)}-${Math.round(n.bottom)}` : '',
        };
      });

      if (!out.nav) {
        // A route that hides the nav needs no clearance — and must not reserve
        // a phantom gap either.
        check(`${width}px ${route} — no nav, nothing to clear`, true);
        continue;
      }
      check(
        `${width}px ${route} — the nav covers no text at the bottom of the page`,
        !out.worst,
        out.worst ? `${out.worst.px}px over "${out.worst.text}"` : ''
      );
      check(`${width}px ${route} — the clearance element is present`, out.spacer === true);
      check(
        `${width}px ${route} — the clearance spans the whole band the nav floats in`,
        out.covers === true,
        out.band
      );
    }
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
