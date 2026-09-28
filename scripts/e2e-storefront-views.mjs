#!/usr/bin/env node
/**
 * THE PUBLIC STORE PAGE'S OWN LINKS, IN A REAL BROWSER (review of the store
 * builder, 2026-09-28).
 *
 * Layouts are published through the REAL layout routes
 * (tests/browser/store-builder-api.mts, started here), then the public store
 * page is opened as the store's own host serves it
 * (tests/browser/store-builder.html?host=store). In Arabic and English, at
 * 360 and 1280:
 *
 *   - on a starter with NO tab strip, `/products`, `/about`, `?tab=services`
 *     and `?section=…` each open that part as a page of its own (they used to
 *     draw the home page again), with a way back to the store's home, clear of
 *     the overlay header's controls;
 *   - a tab strip WITHOUT a Products tab shows a picked collection's products
 *     in place (picking one used to do nothing);
 *   - the reviews block draws the variant the merchant picked;
 *   - the showcase follows the order the merchant gave its kinds;
 *   - the profile hero draws the merchant's own button;
 *   - no horizontal overflow, no page errors.
 *
 * Screenshots go to OUT_DIR (default /tmp/claude-0/shots/sf-views/).
 *
 * Run: serve the repo with vite (`npx vite --port 4192`), then
 *      PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright node scripts/e2e-storefront-views.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.BUILDER_URL || 'http://127.0.0.1:4192';
const OUT = process.env.OUT_DIR || '/tmp/claude-0/shots/sf-views';
const PORT = Number(process.env.BUILDER_API_PORT || 8796);
const API = `http://127.0.0.1:${PORT}`;
await mkdir(OUT, { recursive: true });

let passes = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) passes += 1;
  else {
    failures.push(`${name} ${detail}`);
    console.log(`FAIL ${name} ${detail}`);
  }
}

const child = spawn(process.execPath, ['--import', 'tsx', 'tests/browser/store-builder-api.mts', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => String(d).includes('builder api on') && resolve());
  child.on('exit', (code) => reject(new Error(`backend exited ${code}`)));
});

const starters = JSON.parse(
  execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./packages/storeLayout/src/starters.ts').then((m) => process.stdout.write(JSON.stringify(Object.fromEntries(m.STARTER_THEMES.map((t) => [t, m.starterLayout(t)])))))"], { encoding: 'utf8' })
);

async function publish(layout) {
  const cur = await (await fetch(`${API}/api/merchant/store/layout`)).json();
  const put = await fetch(`${API}/api/merchant/store/layout/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: cur.draft?.version ?? 0, layout }),
  });
  const saved = await put.json();
  const pub = await fetch(`${API}/api/merchant/store/layout/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: saved.draft?.version }),
  });
  if (!pub.ok) throw new Error(`publish ${put.status}/${pub.status} ${JSON.stringify(await pub.json().catch(() => null))}`);
}

const url = (path, lang) => `${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}&host=store&path=${encodeURIComponent(path)}`;

const browser = await chromium.launch();
const sections = await (await fetch(`${API}/api/storefront/raf3d/sections`)).json();
const sectionId = sections.sections?.[0]?.id;

async function open(ctxPage, path, lang, ready) {
  await ctxPage.goto(url(path, lang), { waitUntil: 'domcontentloaded' });
  await ctxPage.waitForSelector(ready, { timeout: 20000 });
  await ctxPage.waitForTimeout(250);
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

try {
  // ---------------------------------------------------------------- 1. minimal (bar header, no tabs)
  const minimal = starters.minimal;
  minimal.blocks[0].settings.cta_label = { ar: 'تصفّح المنتجات', en: 'Browse products', ckb: '' };
  minimal.blocks[0].settings.cta_link = { kind: 'route', route: 'products' };
  await publish(minimal);
  for (const [w, lang] of [[360, 'ar'], [1280, 'en']]) {
    const tag = `minimal-${w}-${lang}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 700 ? 780 : 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await open(page, '/', lang, '[data-block="hero"]');
    check(`${tag} home: blocks, no view`, (await page.locator('[data-store-view]').count()) === 0);

    // The hero's button goes to the products page — and the page CHANGES.
    const cta = page.getByRole('link', { name: lang === 'ar' ? 'تصفّح المنتجات' : 'Browse products' });
    check(`${tag} hero button drawn`, (await cta.count()) === 1);
    await cta.click();
    await page.waitForSelector('[data-store-view="products"]', { timeout: 10000 }).catch(() => {});
    check(`${tag} the hero button opens the products page`, (await page.locator('[data-store-view="products"]').count()) === 1);
    check(`${tag} the products page lists products`, (await page.locator('[data-store-view] a[href*="/p/"]').count()) >= 6);
    check(`${tag} the products page is not the home page again`, (await page.locator('[data-block="hero"]').count()) === 0);
    await page.screenshot({ path: `${OUT}/${tag}-products.png` });

    // The way back.
    await page.locator('[data-store-view-home]').click();
    await page.waitForSelector('[data-block="hero"]', { timeout: 10000 }).catch(() => {});
    check(`${tag} «store home» returns to the home page`, (await page.locator('[data-block="hero"]').count()) === 1);

    for (const [path, view, probe] of [
      ['/about', 'about', null],
      ['/?tab=services', 'services', lang === 'ar' ? 'طباعة حسب الطلب' : 'طباعة حسب الطلب'],
      ['/?tab=showcase', 'showcase', 'Bambu Lab X1C'],
      ['/?tab=collections', 'collections', null],
    ]) {
      await open(page, path, lang, `[data-store-view="${view}"]`);
      check(`${tag} ${path} opens its own page`, (await page.locator(`[data-store-view="${view}"]`).count()) === 1);
      if (probe) check(`${tag} ${path} shows its content`, (await page.getByText(probe, { exact: false }).count()) > 0);
      check(`${tag} ${path} no overflow`, (await overflow(page)) <= 1, `${await overflow(page)}px`);
    }
    // A collection from the Collections page shows its products in place.
    await page.locator('[data-store-view="collections"] button').first().click();
    await page.waitForSelector('[data-store-view="products"] a[href*="/p/"]', { timeout: 10000 }).catch(() => {});
    check(`${tag} a picked collection shows its products`, (await page.locator('[data-store-view="products"] a[href*="/p/"]').count()) > 0);

    if (sectionId) {
      await open(page, `/products?section=${sectionId}`, lang, '[data-store-view="products"]');
      await page.waitForSelector('[data-store-view="products"] a[href*="/p/"]', { timeout: 10000 }).catch(() => {});
      check(`${tag} ?section= opens the collection's products`, (await page.locator('[data-store-view="products"] a[href*="/p/"]').count()) > 0);
    }
    check(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------------- 2. portfolio (overlay header): clear of the controls; reviews list; showcase kinds
  const portfolio = starters.portfolio;
  await publish(portfolio);
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await open(page, '/about', 'ar', '[data-store-view="about"]');
    const home = await page.locator('[data-store-view-home]').boundingBox();
    check('portfolio /about: the home link sits below the overlay header', !!home && home.y >= 48, JSON.stringify(home));
    await page.screenshot({ path: `${OUT}/portfolio-360-ar-about.png` });
    await ctx.close();
  }

  // ---------------------------------------------------------------- 3. modern: reviews as cards
  await publish(starters.modern);
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await open(page, '/', 'ar', '[data-block="reviews"]');
    await page.locator('[data-block="reviews"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    check('modern: the reviews block draws its «cards» variant', (await page.locator('[data-block="reviews"] [data-reviews-variant="cards"]').count()) === 1);
    check('modern: no overflow with a sideways row of review cards', (await overflow(page)) <= 1, `${await overflow(page)}px`);
    await page.locator('[data-block="reviews"]').screenshot({ path: `${OUT}/modern-360-ar-reviews.png` });
    await ctx.close();
  }

  // ---------------------------------------------------------------- 4. the showcase follows the kinds' order; tabs without Products
  const custom = JSON.parse(JSON.stringify(starters.classic));
  // The profile hero with the merchant's own button (it used to leave it out).
  custom.blocks[0].settings.cta_label = { ar: 'من نحن', en: 'Who we are', ckb: '' };
  custom.blocks[0].settings.cta_link = { kind: 'route', route: 'about' };
  const tabs = custom.blocks.find((b) => b.type === 'tabs');
  tabs.settings.items = ['collections', 'about'];
  custom.blocks.push(
    { id: 'sc-grouped', type: 'showcase', variant: 'grouped', settings: { title: { ar: '', en: '', ckb: '' }, kinds: ['material', 'printer', 'work'], limit: 60 }, visibility: { mobile: true, desktop: true }, hidden: false },
    { id: 'sc-grid', type: 'showcase', variant: 'grid', settings: { title: { ar: '', en: '', ckb: '' }, kinds: ['printer', 'work'], limit: 60 }, visibility: { mobile: true, desktop: true }, hidden: false }
  );
  await publish(custom);
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await open(page, '/', 'en', '[data-block="tabs"]');
    check('profile hero: the merchant\'s own button is drawn', (await page.locator('[data-block="hero"] a', { hasText: 'Who we are' }).count()) === 1);
    await page.locator('[data-block-id="sc-grouped"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const groupText = await page.locator('[data-block-id="sc-grouped"]').innerText();
    const iMat = groupText.indexOf('PETG');
    const iPrinter = groupText.indexOf('Bambu Lab X1C');
    const iWork = groupText.indexOf('مجسم معماري');
    check('showcase grouped: materials, then printers, then works — the order given', iMat >= 0 && iMat < iPrinter && iPrinter < iWork, `${iMat}/${iPrinter}/${iWork}`);
    const gridText = await page.locator('[data-block-id="sc-grid"]').innerText();
    check('showcase grid: the printer before the works', gridText.indexOf('Bambu Lab X1C') >= 0 && gridText.indexOf('Bambu Lab X1C') < gridText.indexOf('مجسم معماري'));

    // Tabs without a Products tab: a picked collection shows its products in place.
    await page.getByRole('tab', { name: 'Sections' }).click();
    await page.locator('[data-block="tabs"] [data-tab-panel="collections"] button').first().click();
    await page.waitForSelector('[data-block="tabs"] a[href*="/p/"]', { timeout: 10000 }).catch(() => {});
    check('tabs without Products: a picked collection shows its products', (await page.locator('[data-block="tabs"] a[href*="/p/"]').count()) > 0);
    await page.screenshot({ path: `${OUT}/custom-1280-en.png`, fullPage: true });
    await ctx.close();
  }
} finally {
  await browser.close();
  child.kill();
}

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
