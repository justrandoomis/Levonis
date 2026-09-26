#!/usr/bin/env node
/**
 * The home page, photographed full-length from the REAL app with the REAL
 * catalogue.
 *
 * WHY THIS EXISTS. The home page was redesigned section by section against the
 * owner's spec board (docs/design/home-v2-*.png), and a redesign of a
 * storefront is only honest when it is looked at with the shop's own products,
 * the shop's own category tree and the shop's own photographs — a fixture
 * someone typed makes every layout look better than the one the customer
 * gets. So this drives the real SPA (Vite dev, the real components, the real
 * data flow in src/pages/Home.tsx) and answers its catalogue calls from the
 * PUBLIC, read-only endpoints of a running Levonis origin (default: the live
 * shop). Only GETs to public catalogue routes are forwarded; every other call
 * is answered with a small stand-in (signed-out guest, empty cart), so the
 * script can never write anything anywhere.
 *
 *   node scripts/e2e-home-v2-shots.mjs
 *
 * Env: HOME_SHOTS_THEME (light | dark, default light — the app's two themes;
 *      scripts/e2e-theme-shots.mjs photographs every screen in both),
 *      HOME_SHOTS_ORIGIN (default https://levonis-iq.com),
 *      HOME_SHOTS_DIR (default /tmp/claude-0/shots/home-v2),
 *      HOME_SHOTS_URL (reuse a running Vite instead of starting one on :4181).
 *
 * Besides the pictures it asserts what a picture cannot show at a glance: the
 * section order the owner fixed, no horizontal scroll, and that every link in
 * the new sections points at an in-app route or the Studio.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = process.env.HOME_SHOTS_ORIGIN || 'https://levonis-iq.com';
const OUT = process.env.HOME_SHOTS_DIR || '/tmp/claude-0/shots/home-v2';
const PORT = 4181;
const THEME = process.env.HOME_SHOTS_THEME === 'dark' ? 'dark' : 'light';
let BASE = process.env.HOME_SHOTS_URL || '';

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

/** Public, read-only catalogue reads. Anything else never leaves this machine. */
const FORWARDED = [/^\/api\/home$/, /^\/api\/home\/sections$/, /^\/api\/products$/];
const cache = new Map();
async function upstream(path) {
  if (!cache.has(path)) {
    cache.set(
      path,
      fetch(ORIGIN + path, { headers: { accept: path.startsWith('/files/') ? '*/*' : 'application/json' } }).then(
        async (r) => ({
          status: r.status,
          type: r.headers.get('content-type') || 'application/octet-stream',
          body: Buffer.from(await r.arrayBuffer()),
        })
      )
    );
  }
  return cache.get(path);
}

async function ensureServer() {
  if (BASE) return null;
  BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, BROWSER: 'none' },
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('vite did not start');
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};

/** The order the owner fixed for everything below the ticker. */
const EXPECTED_ORDER = ['categories_bento', 'printer_finder', 'latest', 'editorial', 'community', 'services'];

async function shoot(browser, { width, lang }) {
  const context = await browser.newContext({
    viewport: { width, height: width < 700 ? 844 : 900 },
    deviceScaleFactor: width < 700 ? 2 : 1,
    colorScheme: 'dark',
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
  });
  await context.addInitScript(([l, theme]) => {
    try {
      localStorage.setItem('levonis.theme.v1', theme);
      localStorage.setItem('levo_lang', l);
      localStorage.setItem('levonis.displayCurrency.v1', 'IQD');
    } catch {
      /* private mode */
    }
  }, [lang, THEME]);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
  await page.route('**/files/**', async (route) => {
    const url = new URL(route.request().url());
    const r = await upstream(url.pathname);
    return route.fulfill({ status: r.status, contentType: r.type, body: r.body });
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'GET' && FORWARDED.some((re) => re.test(url.pathname))) {
      const r = await upstream(url.pathname + url.search);
      return route.fulfill({ status: r.status, contentType: 'application/json', body: r.body });
    }
    if (url.pathname === '/api/storefront/resolve') return json({ success: true, kind: 'main', store: null });
    if (url.pathname === '/api/auth/me') return json({ success: true, user: null });
    if (url.pathname === '/api/community/access') return json({ success: true, may_enter: true });
    return json({ success: false, error: 'not part of this picture' }, 404);
  });

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(process.env.HOME_SHOTS_WAIT || '[data-home-section="latest"]', { timeout: 45000 });
  await page
    .waitForFunction(() => {
      const intro = document.querySelector('.lv-app-intro');
      return !intro || ['docked', 'hidden'].includes(intro.getAttribute('data-phase') ?? '');
    }, null, { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  const name = `home-${width}-${lang}-${THEME}`;

  const facts = await page.evaluate(() => {
    const main = document.getElementById('main-scroll-container');
    const sections = [...document.querySelectorAll('[data-home-section]')].map((e) => e.getAttribute('data-home-section'));
    const links = [...document.querySelectorAll('[data-home-v2] a[href]')].map((a) => a.getAttribute('href'));
    return {
      sections,
      links,
      overflow: Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0),
      // The compact product card (CATALOG_DISCOVERY §4): width and height of
      // each one, and whether any of them nests a button inside its link.
      cards: [...document.querySelectorAll('[data-product-card="compact"]')].map((c) => {
        const r = c.getBoundingClientRect();
        return [r.width, r.height];
      }),
      nestedButtons: [...document.querySelectorAll('[data-product-card] a')].filter((a) => a.querySelector('button')).length,
      height: main ? main.scrollHeight : document.documentElement.scrollHeight,
    };
  });
  const seen = facts.sections.filter((s) => EXPECTED_ORDER.includes(s));
  const expected = EXPECTED_ORDER.filter((s) => seen.includes(s));
  check(`${name}: sections in the owner's order`, JSON.stringify(seen) === JSON.stringify(expected), seen.join(' → '));
  check(`${name}: no «features» strip between hero and categories`, !facts.sections.includes('services') || facts.sections.indexOf('services') > facts.sections.indexOf('categories_bento'));
  check(`${name}: no horizontal scroll`, facts.overflow <= 1, `overflow ${facts.overflow}px`);
  // THE COMPACT CARD'S HEIGHT IS FIXED: a 6:5 photograph plus a 119 px body
  // (262 px at 174 px wide, 242 px on the 148 px rail), whatever the name's
  // length and whether a member line is drawn — so a rail never stairsteps.
  const offBy = facts.cards.map(([w, h]) => Math.abs(h - (w * 5) / 6 - 119));
  check(
    `${name}: every compact card is 6:5 photo + 119 px (±4)`,
    facts.cards.length > 0 && offBy.every((d) => d <= 4),
    facts.cards.map(([w, h]) => `${w.toFixed(1)}×${h.toFixed(1)}`).join(', ')
  );
  check(`${name}: no button inside a card's link`, facts.nestedButtons === 0, `${facts.nestedButtons}`);
  const bad = facts.links.filter((h) => !(h.startsWith('/') || h.startsWith('https://studio.levonis-iq.com')));
  check(`${name}: every link is in-app or the Studio`, bad.length === 0, bad.join(', '));

  // Full length: the app scrolls inside #main-scroll-container, so the page
  // is photographed by growing the viewport to the content rather than by
  // Playwright's fullPage (which only sees the window).
  await page.setViewportSize({ width, height: Math.min(facts.height + 40, 16000) });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, `${name}-full.png`) });
  await context.close();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const child = await ensureServer();
  const browser = await chromium.launch();
  try {
    const only = process.env.HOME_SHOTS_ONLY;
    for (const combo of [
      { width: 390, lang: 'ar' },
      { width: 1440, lang: 'ar' },
      { width: 390, lang: 'en' },
    ]) {
      if (only && only !== `${combo.width}-${combo.lang}`) continue;
      console.log(`\n${combo.width} ${combo.lang}`);
      await shoot(browser, combo);
    }
  } finally {
    await browser.close();
    child?.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
