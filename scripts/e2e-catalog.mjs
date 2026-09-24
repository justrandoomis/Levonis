#!/usr/bin/env node
/**
 * THE MERCHANT CATALOGUE IN A REAL BROWSER (merchant platform W2-F).
 *
 * Drives tests/browser/catalog.html — the shipped products tab, product editor
 * (variants open), collections tab and storefront product page (variant
 * picker) over a scripted API — in Arabic (RTL) and English (LTR), dark, at
 * 360px and 1280px. Checks: no horizontal overflow; the picker's price
 * follows the choice; a sold-out combination turns the buy button off; an
 * unsold combination is disabled. Screenshots go to OUT_DIR (default
 * /tmp/claude-0/shots/w2f/).
 *
 *   npx vite --port 4196 --host 127.0.0.1 &
 *   CATALOG_URL=http://127.0.0.1:4196/tests/browser/catalog.html node scripts/e2e-catalog.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.CATALOG_URL || 'http://127.0.0.1:4196/tests/browser/catalog.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/w2f';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes += 1;
  else failures.push(`${name} ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : detail}`);
};

const browser = await chromium.launch();
for (const lang of ['ar', 'en']) {
  for (const width of [360, 1280]) {
    const phone = width < 640;
    const context = await browser.newContext({
      viewport: { width, height: phone ? 800 : 900 },
      deviceScaleFactor: 2,
      locale: lang === 'ar' ? 'ar-IQ' : 'en-US',
      colorScheme: 'dark',
      hasTouch: phone,
      isMobile: phone,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const tag = `${lang}-${width}`;
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // The products tab.
    await page.goto(`${base}?lang=${lang}&view=manager`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-catalog-manager]', { timeout: 8000 });
    await page.waitForTimeout(500);
    check(`${tag} manager: no horizontal overflow`, (await overflow()) <= 0);
    await page.screenshot({ path: `${out}/manager-${tag}.png`, fullPage: true });
    // Select two rows: the bulk bar appears.
    const boxes = page.locator('input[type="checkbox"]');
    if ((await boxes.count()) > 2) {
      await boxes.nth(1).check({ force: true });
      await boxes.nth(2).check({ force: true });
      await page.waitForTimeout(300);
      check(`${tag} manager: bulk bar`, (await page.getByRole('button', { name: lang === 'en' ? 'Hide from store' : 'إخفاء من المتجر' }).count()) >= 1);
      await page.screenshot({ path: `${out}/manager-bulk-${tag}.png`, fullPage: true });
    }

    // The editor, variants open.
    await page.goto(`${base}?lang=${lang}&view=editor`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-product-form]', { timeout: 8000 });
    await page.waitForTimeout(700);
    check(`${tag} editor: variant rows`, (await page.locator('[data-variant-row]').count()) === 6);
    check(`${tag} editor: no horizontal overflow`, (await overflow()) <= 0);
    await page.screenshot({ path: `${out}/editor-${tag}.png`, fullPage: false });
    // Scroll the sheet body through the variants.
    await page.locator('[data-variant-editor]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/editor-variants-${tag}.png`, fullPage: false });
    await page.locator('[data-variants-table], [data-variant-row]').last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/editor-variants-rows-${tag}.png`, fullPage: false });
    await page.locator('[data-disclosure="print"] button').first().click();
    await page.waitForTimeout(400);
    await page.locator('[data-disclosure="print"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/editor-print-${tag}.png`, fullPage: false });

    // Collections.
    await page.goto(`${base}?lang=${lang}&view=collections`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-collections-manager]', { timeout: 8000 });
    await page.waitForTimeout(500);
    check(`${tag} collections: no horizontal overflow`, (await overflow()) <= 0);
    await page.screenshot({ path: `${out}/collections-${tag}.png`, fullPage: true });

    // The storefront product page.
    await page.goto(`${base}?lang=${lang}&view=product`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-variant-picker]', { timeout: 8000 });
    await page.waitForTimeout(500);
    check(`${tag} product: no horizontal overflow`, (await overflow()) <= 0);
    const price = async () => (await page.locator('[data-product-price]').innerText()).replace(/\s+/g, ' ');
    await page.screenshot({ path: `${out}/product-${tag}.png`, fullPage: true });
    // M / Red: 22,000 with a compare-at.
    await page.locator('[data-variant-picker] label').filter({ hasText: /^M/ }).click();
    await page.locator('[data-variant-picker] label').filter({ hasText: lang === 'en' ? 'Red' : 'أحمر' }).click();
    await page.waitForTimeout(200);
    check(`${tag} product: M/Red costs 22,000`, (await price()).includes('22,000'), await price());
    // S / Blue is sold out: the button turns off.
    await page.locator('[data-variant-picker] label').filter({ hasText: /^S/ }).click();
    await page.locator('[data-variant-picker] label').filter({ hasText: lang === 'en' ? 'Blue' : 'أزرق' }).click();
    await page.waitForTimeout(200);
    const buy = page.locator('button', { hasText: lang === 'en' ? 'Unavailable' : 'غير متوفر' });
    check(`${tag} product: sold-out choice disables the button`, (await buy.count()) === 1 && (await buy.isDisabled()));
    await page.screenshot({ path: `${out}/product-soldout-${tag}.png`, fullPage: true });
    // L / Red is not sold at all (inactive): with L chosen, Red is disabled.
    await page.locator('[data-variant-picker] label').filter({ hasText: /^L/ }).click();
    await page.waitForTimeout(200);
    const redState = await page.locator('[data-variant-picker] label').filter({ hasText: lang === 'en' ? 'Red' : 'أحمر' }).getAttribute('data-state');
    check(`${tag} product: an unsold combination is unavailable`, redState === 'unavailable', `got ${redState}`);

    check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
    await context.close();
  }
}
await browser.close();
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
