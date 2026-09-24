#!/usr/bin/env node
/**
 * THE MERCHANT WORKSPACE, DRIVEN IN A REAL BROWSER (W3-A).
 *
 * The real application (tests/browser/merchant-workspace-fixture.tsx renders
 * src/App with `fetch` answering the real route shapes), at 360px (a phone),
 * 768px (a tablet) and 1280px (a desktop), in Arabic (RTL) and English (LTR):
 *
 *   - every workspace address renders the shell and its screen — never a
 *     blank page — with no horizontal overflow of the page or the scroller;
 *   - the frame: a sidebar on the desktop, an icon rail on the tablet, the
 *     bottom tabs on the phone; every nav target and tab is at least 44px;
 *   - the router: an unknown address lands on the Command Center, the old
 *     `/merchant/custom-orders` spelling on the custom-order book, and the
 *     same tree is served under `/admin` on the store's own host (whose links
 *     stay under `/admin`); another store's host refuses (audit 01 B16);
 *   - ⌘K / Ctrl+K opens the palette, typing searches the server, Enter opens
 *     the result; the phone's «More» opens its sheet; the sidebar collapses;
 *   - a lapsed PLUS keeps every screen and says why.
 *
 * Screenshots of every address × width × language go to OUT_DIR (default
 * /tmp/claude-0/shots/w3a/), named <route>-<width>-<lang>.png.
 *
 * Run: serve the repo with vite (`npx vite --port 4191`), then
 *      PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright node scripts/e2e-merchant-workspace.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WORKSPACE_URL || 'http://127.0.0.1:4191';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/w3a';
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes += 1;
  else {
    failures.push(`${name} ${detail}`);
    console.log(`FAIL ${name} ${detail}`);
  }
}

const ROUTES = [
  ['home', '/merchant'],
  ['orders', '/merchant/orders'],
  ['order', '/merchant/orders/ORD-7F3A21C9'],
  ['custom-orders', '/merchant/requests/orders'],
  ['products', '/merchant/products'],
  ['product', '/merchant/products/p1'],
  ['collections', '/merchant/collections'],
  ['services', '/merchant/services'],
  ['showcase', '/merchant/showcase'],
  ['coupons', '/merchant/marketing/coupons'],
  ['customers', '/merchant/customers'],
  ['inbox', '/merchant/inbox'],
  ['requests', '/merchant/requests'],
  ['money', '/merchant/money'],
  ['analytics', '/merchant/analytics'],
  ['reviews', '/merchant/reviews'],
  ['notifications', '/merchant/notifications'],
  ['printers', '/merchant/printers'],
  ['costing', '/merchant/costing'],
  ['store-design', '/merchant/store/design'],
  ['store-settings', '/merchant/store/settings'],
  ['store-delivery', '/merchant/store/delivery'],
];
const WIDTHS = [
  [360, 780],
  [768, 1024],
  [1280, 860],
];
const LANGS = ['ar', 'en'];

const url = (path, lang, extra = '') => `${origin}/tests/browser/merchant-workspace.html?lang=${lang}&path=${encodeURIComponent(path)}${extra}`;

async function ready(page) {
  await page.waitForSelector('[data-merchant-shell], [data-not-your-store]', { timeout: 20000 });
  // The screen's own chunk and its data.
  await page.waitForFunction(() => !document.querySelector('[data-merchant-shell] [role="status"][aria-busy="true"]'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
}

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const owner = document.querySelector('[data-scroll-owner]');
    return {
      page: doc.scrollWidth - window.innerWidth,
      owner: owner ? owner.scrollWidth - owner.clientWidth : 0,
    };
  });
}

const browser = await chromium.launch();
try {
  for (const [w, h] of WIDTHS) {
    for (const lang of LANGS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 640, isMobile: w < 640, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      for (const [name, path] of ROUTES) {
        if (only && !only.includes(name)) continue;
        await page.goto(url(path, lang), { waitUntil: 'domcontentloaded' });
        await ready(page);
        const tag = `${name}-${w}-${lang}`;
        check(`${tag}: the shell renders`, (await page.locator('[data-merchant-shell]').count()) === 1);
        check(`${tag}: the address stayed`, new URL(page.url()).pathname === path, new URL(page.url()).pathname);
        const o = await overflow(page);
        check(`${tag}: no horizontal overflow`, o.page <= 0 && o.owner <= 1, JSON.stringify(o));
        const dir = await page.evaluate(() => document.documentElement.dir);
        check(`${tag}: direction`, dir === (lang === 'ar' ? 'rtl' : 'ltr'), dir);
        const boundary = await page.locator('[role="alert"]').filter({ hasText: /تعذّر تحميل|could not load this part/i }).count();
        check(`${tag}: the screen's chunk loaded`, boundary === 0);
        await page.screenshot({ path: `${out}/${tag}.png` });
      }
      // The frame at this width.
      await page.goto(url('/merchant/orders', lang), { waitUntil: 'domcontentloaded' });
      await ready(page);
      const frame = await page.evaluate(() => {
        const vis = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
        };
        const small = [...document.querySelectorAll('[data-nav], [data-tab]')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .filter((el) => el.getBoundingClientRect().height < 44 || el.getBoundingClientRect().width < 44)
          .map((el) => `${el.getAttribute('data-nav') ?? el.getAttribute('data-tab')}:${Math.round(el.getBoundingClientRect().height)}`);
        const aside = document.querySelector('[data-sidebar]');
        return {
          sidebar: vis('[data-sidebar]'),
          sidebarWidth: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
          tabs: vis('[data-bottom-tabs]'),
          small,
          current: document.querySelector('[aria-current="page"]')?.getAttribute('data-nav') ?? document.querySelector('[aria-current="page"]')?.getAttribute('data-tab'),
        };
      });
      if (w < 640) {
        check(`frame-${w}-${lang}: bottom tabs, no sidebar`, frame.tabs && !frame.sidebar, JSON.stringify(frame));
      } else if (w < 1024) {
        check(`frame-${w}-${lang}: icon rail`, frame.sidebar && frame.sidebarWidth <= 80 && !frame.tabs, JSON.stringify(frame));
      } else {
        check(`frame-${w}-${lang}: full sidebar`, frame.sidebar && frame.sidebarWidth >= 240 && !frame.tabs, JSON.stringify(frame));
      }
      check(`frame-${w}-${lang}: every nav target is at least 44px`, frame.small.length === 0, frame.small.join(' '));
      check(`frame-${w}-${lang}: the open screen is marked current`, frame.current === 'orders', String(frame.current));

      // The palette: Ctrl+K by key position, a server search, Enter opens it.
      await page.keyboard.press('Control+KeyK');
      await page.waitForSelector('[data-overlay="command-palette"] input[role="combobox"]', { timeout: 8000 });
      await page.keyboard.type('ORD-91');
      await page.waitForSelector('[data-command="order:ORD-91BC04D2"]', { timeout: 8000 }).catch(() => {});
      check(`palette-${w}-${lang}: a server result`, (await page.locator('[data-command="order:ORD-91BC04D2"]').count()) === 1);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${out}/palette-${w}-${lang}.png` });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      check(`palette-${w}-${lang}: Enter opened the order`, new URL(page.url()).pathname === '/merchant/orders/ORD-91BC04D2', page.url());

      if (w < 640) {
        await page.locator('[data-tab="more"]').click();
        await page.waitForSelector('[data-overlay="merchant-more-sheet"]', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(600);
        check(`more-${w}-${lang}: the sheet lists the rest`, (await page.locator('[data-overlay="merchant-more-sheet"] [data-nav]').count()) >= 14);
        await page.screenshot({ path: `${out}/more-sheet-${w}-${lang}.png` });
      }
      if (w >= 1024) {
        await page.locator('[data-sidebar] button[aria-expanded]').click();
        await page.waitForTimeout(300);
        const width = await page.evaluate(() => Math.round(document.querySelector('[data-sidebar]').getBoundingClientRect().width));
        check(`collapse-${w}-${lang}: the sidebar collapses to the rail`, width <= 80, String(width));
        await page.screenshot({ path: `${out}/collapsed-${w}-${lang}.png` });
      }
      check(`errors-${w}-${lang}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
      await ctx.close();
    }
  }

  // ---- the router and the hosts
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(url('/merchant/nothing-here', 'ar'), { waitUntil: 'domcontentloaded' });
  await ready(page);
  check('router: an unknown address lands on the Command Center', new URL(page.url()).pathname === '/merchant', page.url());
  await page.goto(url('/merchant/custom-orders', 'ar'), { waitUntil: 'domcontentloaded' });
  await ready(page);
  check('router: /merchant/custom-orders is the custom-order book', new URL(page.url()).pathname === '/merchant/requests/orders', page.url());
  await page.goto(url('/merchant/orders', 'ar', '&host=store'), { waitUntil: 'domcontentloaded' });
  await ready(page);
  const hosted = await page.evaluate(() => [...document.querySelectorAll('[data-nav]')].map((a) => a.getAttribute('href')));
  check('store host: the tree lives under /admin', new URL(page.url()).pathname === '/admin/orders' && hosted.every((h) => h.startsWith('/admin')), hosted.slice(0, 3).join(','));
  await page.screenshot({ path: `${out}/store-host-orders-1280-ar.png` });
  await page.goto(url('/merchant', 'ar', '&host=store&state=other'), { waitUntil: 'domcontentloaded' });
  await ready(page);
  check('store host: another store\'s /admin refuses (B16)', (await page.locator('[data-not-your-store]').count()) === 1);
  await page.screenshot({ path: `${out}/other-store-1280-ar.png` });
  for (const lang of LANGS) {
    for (const [w, h] of [[360, 780], [1280, 860]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(url('/merchant', lang, '&state=lapsed'), { waitUntil: 'domcontentloaded' });
      await ready(page);
      check(`lapsed-${w}-${lang}: the problem is named, the figures say why`, (await page.locator('[data-store-problem="subscription_inactive"]').count()) === 1 && (await page.locator('[data-analytics-locked]').count()) === 1);
      await page.screenshot({ path: `${out}/lapsed-home-${w}-${lang}.png` });
      await page.goto(url('/merchant/orders', lang, '&state=lapsed'), { waitUntil: 'domcontentloaded' });
      await ready(page);
      check(`lapsed-${w}-${lang}: every screen stays, the reason is said`, (await page.locator('[data-selling-off="lapsed"]').count()) === 1);
      await page.screenshot({ path: `${out}/lapsed-orders-${w}-${lang}.png` });
      await page.goto(url('/merchant', lang, '&state=calm'), { waitUntil: 'domcontentloaded' });
      await ready(page);
      check(`calm-${w}-${lang}: nothing waiting is said in words`, (await page.locator('[data-attention-clear]').count()) === 1);
      await page.screenshot({ path: `${out}/calm-home-${w}-${lang}.png` });
    }
  }
  await ctx.close();
} finally {
  await browser.close();
}

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
