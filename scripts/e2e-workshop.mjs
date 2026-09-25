#!/usr/bin/env node
/**
 * THE WORKSHOP'S ELIGIBILITY SCREENS IN A REAL BROWSER (stream W5-B) — the
 * «مناسب لي» board, the request's workshop card (eligible and not), the
 * costing sheet with a result, and the printers screen with its canonical
 * picker and stock shelf; at 360 and 1280, Arabic and English. Screenshots go
 * to /tmp/claude-0/shots/w5b/, and each page is checked for a horizontal
 * scroll and for raw reason codes reaching the reader.
 *
 * Run: npx vite --port 4193 &  PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright node scripts/e2e-workshop.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.BASE || 'http://localhost:4193';
const OUT = process.env.OUT || '/tmp/claude-0/shots/w5b';
mkdirSync(OUT, { recursive: true });

const VIEWS = ['board', 'card', 'reasons', 'costing', 'printers'];
const WIDTHS = [360, 1280];
const CODES = /\b(BUILD_VOLUME|STOCK_COLOR|REACH_DELIVERY|OFFER_NOT_ELIGIBLE|MODEL_MATERIAL|FAILURE_RESERVE)\b/;

const browser = await chromium.launch();
let failures = 0;
let checks = 0;
const check = (ok, what) => {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error('FAIL', what);
  }
};

for (const lang of ['ar', 'en']) {
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    for (const view of VIEWS) {
      await page.goto(`${BASE}/tests/browser/workshop.html?lang=${lang}&view=${view}`);
      await page.waitForLoadState('networkidle');
      if (view === 'costing') {
        await page.waitForSelector('[data-costing-run]');
        await page.click('[data-costing-run]');
        await page.waitForSelector('[data-costing-result]');
        await page.click('[data-costing-result] summary');
      }
      if (view === 'printers') {
        await page.waitForSelector('[data-printers="add"]');
        await page.click('[data-printers="add"]');
        await page.waitForSelector('[data-printer-model-select]');
        await page.selectOption('[data-printer-model-select]', 'bbl-p1s');
      }
      if (view === 'board') {
        await page.click('[data-board-filters-toggle]');
        await page.waitForSelector('[data-board-filters]');
      }
      await page.waitForTimeout(350);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `${lang} ${width} ${view}: horizontal overflow ${overflow}px`);
      const text = await page.evaluate(() => document.body.innerText);
      check(!CODES.test(text), `${lang} ${width} ${view}: a raw code reached the reader`);
      if (view === 'reasons') check((await page.$$('[data-reason]')).length === 3, `${lang} ${width}: three reasons listed`);
      if (view === 'board') check((await page.$$('[data-board-request]')).length === 4, `${lang} ${width}: four requests on the board`);
      if (view === 'printers') {
        const lockedBuild = await page.$$eval('input[placeholder="X"]', (els) => els.length);
        check(lockedBuild === 0, `${lang} ${width}: a canonical printer hides the typed build volume`);
      }
      await page.screenshot({ path: `${OUT}/${view}-${lang}-${width}.png`, fullPage: true });
    }
    await page.close();
  }
}
await browser.close();
console.log(`${checks - failures}/${checks} checks passed; screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
