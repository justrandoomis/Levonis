#!/usr/bin/env node
/**
 * CATALOG DISCOVERY, PHOTOGRAPHED FROM THE REAL APP (streams S4/S5,
 * docs/ux/CATALOG_DISCOVERY.md §5–§7): the explorer, a category page, a
 * category that is its own listing, the specialised listing with its filter
 * and sort sheets open, the list view, an applied-filters state and the
 * zero-results way back — at 390 and 1280 px, in the light and the dark theme,
 * in Arabic, with an English spot check.
 *
 * THE DATA IS THE SHOP'S. The real SPA (Vite dev) is driven by Playwright;
 * `/api/catalog/*` and `/api/products` are answered by the REAL Worker routes
 * over the live catalogue (scripts/catalog-discovery-api.ts — the new routes
 * are not deployed yet), with the live shop's own photographs and section
 * names; `/api/home`, `/api/bundles` and every `/files/*` photograph come
 * straight from the live shop's public read-only endpoints. Every other call
 * is answered locally (a signed-out guest), so nothing is written anywhere.
 *
 *   node scripts/e2e-catalog-discovery-shots.mjs
 *
 * Env: SHOTS_DIR (default /tmp/claude-0/shots/s4s5), HOME_SHOTS_ORIGIN
 *      (default https://levonis-iq.com), SHOTS_URL (reuse a running Vite),
 *      SHOTS_ONLY (e.g. `390-light-ar`), SHOTS_PAGES (comma list of scenes).
 *
 * Besides the pictures it asserts what a picture cannot show at a glance: no
 * horizontal scroll, no button inside a card's link, every compact card 6:5 +
 * 119 px, and every control at least 44 px tall (or `.lv-hit`).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = process.env.HOME_SHOTS_ORIGIN || 'https://levonis-iq.com';
const OUT = process.env.SHOTS_DIR || '/tmp/claude-0/shots/s4s5';
const PORT = 4182;
const API_PORT = 4196;
let BASE = process.env.SHOTS_URL || '';

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

const LIVE = [/^\/api\/home$/, /^\/api\/home\/sections$/, /^\/api\/bundles$/];
const LOCAL = [/^\/api\/catalog(\/|$)/, /^\/api\/products$/];
const cache = new Map();
function fetchOnce(url, accept) {
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url, { headers: { accept } }).then(async (r) => ({
        status: r.status,
        type: r.headers.get('content-type') || 'application/octet-stream',
        body: Buffer.from(await r.arrayBuffer()),
      }))
    );
  }
  return cache.get(url);
}

async function waitFor(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startServers() {
  const children = [];
  const api = spawn('node', ['--import', 'tsx', 'scripts/catalog-discovery-api.ts', String(API_PORT)], { cwd: ROOT, stdio: 'pipe' });
  api.stdout.on('data', (d) => process.stdout.write(`  [api] ${d}`));
  children.push(api);
  if (!(await waitFor(`http://127.0.0.1:${API_PORT}/api/catalog/tree`))) throw new Error('catalog api did not start');
  if (!BASE) {
    BASE = `http://127.0.0.1:${PORT}`;
    const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, BROWSER: 'none' },
    });
    children.push(vite);
    if (!(await waitFor(BASE))) throw new Error('vite did not start');
  }
  return children;
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};

/** The scenes: a path, what to wait for, and what to do before the picture. */
const SCENES = [
  { id: 'explorer', path: '/categories', wait: '[data-category-banner]', photos: true },
  { id: 'category-printers', path: '/categories/printers', wait: '[data-shelf]', photos: true },
  { id: 'category-materials', path: '/categories/printing-materials', wait: '[data-product-grid]', photos: true },
  { id: 'listing-fdm', path: '/categories/printers/fdm-printers', wait: '[data-product-grid]', photos: true },
  { id: 'listing-filters-open', path: '/categories/printers/fdm-printers', wait: '[data-product-grid]', act: 'filters', viewport: true },
  { id: 'listing-sort-open', path: '/categories/printers/fdm-printers', wait: '[data-product-grid]', act: 'sort', viewport: true },
  { id: 'listing-applied', path: '/categories/printers/all?avail=1&colors=16-', wait: '[data-product-grid]', photos: true, phoneOnly: false },
  { id: 'listing-list-view', path: '/categories/printers/fdm-printers', wait: '[data-product-grid]', act: 'list', photos: true },
  { id: 'listing-zero', path: '/categories/printers/fdm-printers?avail=1&brand=snapmaker&colors=24-', wait: '[data-empty-filtered]', act: 'undo-counts' },
];

async function settle(page) {
  await page
    .waitForFunction(() => {
      const intro = document.querySelector('.lv-app-intro');
      return !intro || ['docked', 'hidden'].includes(intro.getAttribute('data-phase') ?? '');
    }, null, { timeout: 20000 })
    .catch(() => {});
}

async function photosLoaded(page) {
  await page
    .waitForFunction(
      () => [...document.querySelectorAll('main img')].filter((i) => i.getBoundingClientRect().top < window.innerHeight * 3).every((i) => i.complete),
      null,
      { timeout: 20000 }
    )
    .catch(() => {});
}

async function shoot(browser, { width, theme, lang }, scenes) {
  const context = await browser.newContext({
    viewport: { width, height: width < 700 ? 844 : 900 },
    deviceScaleFactor: width < 700 ? 2 : 1,
    colorScheme: theme,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
  });
  await context.addInitScript(([l, t]) => {
    try {
      localStorage.setItem('levonis.theme.v1', t);
      localStorage.setItem('levo_lang', l);
      localStorage.setItem('levonis.displayCurrency.v1', 'IQD');
      // Every scene starts with the grid view and an empty compare tray.
      localStorage.removeItem('levonis.listing.view.v1');
    } catch {
      /* private mode */
    }
  }, [lang, theme]);
  await context.route('**/files/**', async (route) => {
    const url = new URL(route.request().url());
    const r = await fetchOnce(ORIGIN + url.pathname, '*/*');
    return route.fulfill({ status: r.status, contentType: r.type, body: r.body });
  });
  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'GET' && LOCAL.some((re) => re.test(url.pathname))) {
      const r = await fetch(`http://127.0.0.1:${API_PORT}${url.pathname}${url.search}`);
      return route.fulfill({ status: r.status, contentType: 'application/json', body: Buffer.from(await r.arrayBuffer()) });
    }
    if (req.method() === 'GET' && LIVE.some((re) => re.test(url.pathname))) {
      const r = await fetchOnce(ORIGIN + url.pathname + url.search, 'application/json');
      return route.fulfill({ status: r.status, contentType: 'application/json', body: r.body });
    }
    if (url.pathname === '/api/storefront/resolve') return json({ success: true, kind: 'main', store: null });
    if (url.pathname === '/api/auth/me') return json({ success: true, user: null });
    if (url.pathname === '/api/community/access') return json({ success: true, may_enter: true });
    return json({ success: false, error: 'not part of this picture' }, 404);
  });

  for (const scene of scenes) {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  page error (${scene.id}): ${e.message}`));
    const name = `${scene.id}-${width}-${theme}-${lang}`;
    await page.goto(`${BASE}${scene.path}`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const ok = await page.waitForSelector(scene.wait, { timeout: 30000 }).then(() => true, () => false);
    check(`${name}: ${scene.wait} drawn`, ok);
    if (!ok) {
      await page.screenshot({ path: join(OUT, `${name}-FAILED.png`) });
      await page.close();
      continue;
    }
    if (scene.photos) await photosLoaded(page);
    await page.waitForTimeout(900);

    if (scene.act === 'filters') {
      if (width >= 1024) {
        // The desktop has no sheet: the filters are the side column. Tap one to show it live.
        const chip = page.locator('[data-filter-column] [data-facet="max_colors"] [data-facet-option]').first();
        if (await chip.count()) await chip.click();
        await page.waitForTimeout(1200);
      } else {
        await page.click('[data-open-filters]');
        await page.waitForSelector('[data-overlay="filter-sheet"] [data-filter-panel]', { timeout: 15000 });
        // Toggle one brand so the footer's live count is visible changing.
        const opt = page.locator('[data-overlay="filter-sheet"] [data-facet="max_colors"] [data-facet-option="24-"]');
        if (await opt.count()) await opt.click();
        await page.waitForTimeout(1200);
        await page.evaluate(() => document.querySelector('[data-overlay="filter-sheet"] [data-sheet-body]')?.scrollTo({ top: 0 }));
        await page.waitForTimeout(300);
        const label = await page.locator('[data-filter-apply]').innerText();
        check(`${name}: the sheet's button says the live count`, /\d|طابعت/.test(label), label);
      }
    } else if (scene.act === 'sort') {
      await page.click('[data-open-sort]');
      await page.waitForSelector('[data-overlay="sort-sheet"] [role="radio"]', { timeout: 15000 });
      await page.waitForTimeout(700);
    } else if (scene.act === 'list') {
      await page.click('[data-segmented="listing-view"] [role="radio"]:nth-child(2)');
      await page.waitForSelector('[data-product-list]', { timeout: 10000 });
      await photosLoaded(page);
      await page.waitForTimeout(500);
    } else if (scene.act === 'undo-counts') {
      await page.waitForFunction(() => ![...document.querySelectorAll('[data-undo]')].some((b) => b.textContent?.includes('…')), null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(400);
    }

    const facts = await page.evaluate(() => {
      const main = document.getElementById('main-scroll-container');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const small = [...document.querySelectorAll('main a[href], main button, main [role="radio"], main input:not([type="range"]):not(.sr-only), [data-overlay] button, [data-overlay] a[href]')]
        .filter((el) => visible(el) && !el.classList.contains('lv-hit') && !el.closest('.sr-only') && !el.hasAttribute('data-sheet-grabber'))
        // The UI kit's small Segmented draws 30 px and hits 44 px through a ::after (W6).
        .filter((el) => !String(el.className).includes('after:-inset-y-[7px]'))
        // A field inside a 44 px label is hit through its label.
        .filter((el) => !(el.tagName === 'INPUT' && (el.closest('label')?.getBoundingClientRect().height ?? 0) >= 43.5))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          // A text link inside running prose is exempt; every control is not.
          return r.height < 43.5 && !(el.tagName === 'A' && el.closest('p'));
        })
        .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('data-jump') ? '[jump]' : ''}:${Math.round(el.getBoundingClientRect().height)} «${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}»`);
      return {
        overflow: Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0),
        cards: [...document.querySelectorAll('[data-product-card="compact"]')]
          .map((c) => {
            const r = c.getBoundingClientRect();
            return [r.width, r.height];
          })
          .filter(([w]) => w > 0),
        nested: [...document.querySelectorAll('main a')].filter((a) => a.querySelector('button, a')).length,
        small,
        height: main ? main.scrollHeight : document.documentElement.scrollHeight,
      };
    });
    check(`${name}: no horizontal scroll`, facts.overflow <= 1, `overflow ${facts.overflow}px`);
    check(`${name}: no control nested in a link`, facts.nested === 0, String(facts.nested));
    const offBy = facts.cards.map(([w, h]) => Math.abs(h - (w * 5) / 6 - 119));
    if (facts.cards.length) check(`${name}: compact cards are 6:5 + 119 px (±4)`, offBy.every((d) => d <= 4), facts.cards.map(([w, h]) => `${w.toFixed(0)}×${h.toFixed(0)}`).slice(0, 6).join(', '));
    check(`${name}: every control ≥ 44 px tall`, facts.small.length === 0, facts.small.slice(0, 8).join(' | '));

    if (scene.viewport || scene.act === 'filters' || scene.act === 'sort') {
      await page.screenshot({ path: join(OUT, `${name}.png`) });
    } else {
      await page.setViewportSize({ width, height: Math.min(facts.height + 40, 12000) });
      await page.waitForTimeout(1500);
      // A resize can land mid-transition; wait until the page's own content is painted again.
      await page.waitForSelector(scene.wait, { state: 'visible', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(OUT, `${name}-full.png`) });
    }
    await page.close();
  }
  await context.close();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const children = await startServers();
  const browser = await chromium.launch();
  const only = process.env.SHOTS_ONLY;
  const pick = process.env.SHOTS_PAGES ? new Set(process.env.SHOTS_PAGES.split(',')) : null;
  try {
    const combos = [
      { width: 390, theme: 'light', lang: 'ar' },
      { width: 390, theme: 'dark', lang: 'ar' },
      { width: 1280, theme: 'light', lang: 'ar' },
      { width: 1280, theme: 'dark', lang: 'ar' },
      { width: 390, theme: 'light', lang: 'en', scenes: ['explorer', 'category-printers', 'listing-fdm', 'listing-filters-open', 'listing-zero'] },
    ];
    for (const combo of combos) {
      const key = `${combo.width}-${combo.theme}-${combo.lang}`;
      if (only && only !== key) continue;
      const scenes = SCENES.filter((s) => (!combo.scenes || combo.scenes.includes(s.id)) && (!pick || pick.has(s.id)));
      console.log(`\n${key}`);
      await shoot(browser, combo, scenes);
    }
  } finally {
    await browser.close();
    for (const c of children) c.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
