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
 * The check scrolls each route to its true bottom (repeatedly, because lazy
 * content changes the height) and then measures, in pixels, the worst overlap
 * between the nav and any text-bearing element.
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

      // To the TRUE bottom: one pass lands short because lazy content changes
      // the height after the first jump.
      let prev = -1;
      for (let i = 0; i < 12; i++) {
        const pos = await page.evaluate(() => {
          let last = 0;
          for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
              el.scrollTop = el.scrollHeight;
              last = el.scrollTop;
            }
          }
          window.scrollTo(0, document.body.scrollHeight);
          return last;
        });
        await page.waitForTimeout(350);
        if (pos === prev) break;
        prev = pos;
      }

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
        return { nav: true, worst, spacer: !!document.querySelector('[data-nav-clearance]') };
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
