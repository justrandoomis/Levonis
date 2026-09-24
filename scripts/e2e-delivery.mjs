#!/usr/bin/env node
/**
 * DELIVERY BY GOVERNORATE IN A REAL BROWSER (merchant platform W2-A).
 *
 * Drives tests/browser/delivery.html — the shipped StoreCheckout and
 * DeliverySettingsEditor over a scripted API — in Arabic (RTL) and English
 * (LTR), dark, at 360px and 1280px: every checkout state (a fee, free over the
 * threshold, pickup, a governorate the store does not serve, an address with
 * no governorate, no address) and the editor with a governorate row open.
 * Checks: no horizontal overflow; the Place button is live only with a
 * placeable quote; the unavailable state offers pickup and switching to it
 * gives a live button. Screenshots go to OUT_DIR (default /tmp/claude-0/shots/w2a/).
 *
 *   npx vite --port 4191 --host 127.0.0.1 &
 *   DELIVERY_URL=http://127.0.0.1:4191/tests/browser/delivery.html node scripts/e2e-delivery.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.DELIVERY_URL || 'http://127.0.0.1:4191/tests/browser/delivery.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/w2a';
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

    for (const state of ['fee', 'free_over', 'pickup', 'unavailable', 'governorate', 'no_address']) {
      await page.goto(`${base}?lang=${lang}&view=checkout&state=${state}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-store-delivery]', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (state === 'pickup') {
        await page.locator('[data-segmented="store-fulfilment"] [role="radio"]').nth(1).click();
        await page.waitForTimeout(600);
      }
      check(`${tag} ${state}: no horizontal overflow`, (await overflow()) <= 0);
      const live = await page.locator('button.lv-button-primary:not([disabled])').count();
      const placeable = ['fee', 'free_over', 'pickup'].includes(state);
      check(`${tag} ${state}: Place is ${placeable ? 'live' : 'not offered'}`, placeable ? live === 1 : live === 0, `live=${live}`);
      const panel = await page.locator('[data-delivery-state]').first().getAttribute('data-delivery-state').catch(() => null);
      const expected = { fee: 'fee', free_over: 'free', pickup: 'pickup', unavailable: 'unavailable', governorate: 'governorate-required', no_address: null }[state];
      if (expected) check(`${tag} ${state}: the panel says ${expected}`, panel === expected, `got ${panel}`);
      await page.screenshot({ path: `${out}/checkout-${state}-${tag}.png`, fullPage: true });
      if (state === 'unavailable') {
        // The way out it offers: collect from the store — and the button comes alive.
        const pickupBtn = page.locator('[data-delivery-state="unavailable"] button');
        check(`${tag} unavailable: offers pickup`, (await pickupBtn.count()) === 1);
        await pickupBtn.click();
        await page.waitForTimeout(700);
        const liveNow = await page.locator('button.lv-button-primary:not([disabled])').count();
        check(`${tag} unavailable → pickup: Place is live`, liveNow === 1, `live=${liveNow}`);
        await page.screenshot({ path: `${out}/checkout-unavailable-then-pickup-${tag}.png`, fullPage: true });
      }
      if (state === 'governorate') {
        await page.locator('[data-delivery-state="governorate-required"] button').click();
        await page.waitForTimeout(400);
        check(`${tag} governorate: the address form opens in place`, (await page.locator('select').count()) >= 1);
        await page.screenshot({ path: `${out}/checkout-governorate-form-${tag}.png`, fullPage: true });
      }
    }

    await page.goto(`${base}?lang=${lang}&view=editor`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-delivery-editor]', { timeout: 8000 });
    await page.waitForTimeout(400);
    check(`${tag} editor: no horizontal overflow`, (await overflow()) <= 0);
    check(`${tag} editor: eighteen governorate rows`, (await page.locator('[data-gov-row]').count()) === 18);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('[data-gov-row] > button')].filter((b) => b.getBoundingClientRect().height < 44).length
    );
    check(`${tag} editor: every row is a 44px target`, small === 0, `${small} short`);
    await page.screenshot({ path: `${out}/editor-${tag}.png`, fullPage: true });
    await page.locator('[data-gov-row="baghdad"] > button').click();
    await page.waitForTimeout(300);
    await page.locator('[data-gov-row="baghdad"] summary').click();
    await page.waitForTimeout(300);
    // An edit makes the draft dirty and the save live.
    await page.locator('[data-segmented="delivery-row-baghdad"] [role="radio"]').nth(2).click();
    await page.waitForTimeout(300);
    check(`${tag} editor: an edit enables Save`, (await page.locator('[data-delivery-editor] button.lv-button-primary:not([disabled])').count()) === 1);
    await page.locator('[data-segmented="delivery-row-baghdad"] [role="radio"]').nth(1).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/editor-row-open-${tag}.png`, fullPage: true });
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
