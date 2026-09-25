#!/usr/bin/env node
/**
 * W3-B IN A REAL BROWSER — the analytics page, the order screen, the
 * customers screens and the prompt dialog, at 360 / 768 / 1280 px, in Arabic
 * (RTL) and English (LTR), on the workspace fixture
 * (tests/browser/merchant-workspace-fixture.tsx) and the prompt fixture.
 *
 *   - every screen renders inside the shell with no horizontal overflow;
 *   - analytics: the KPI row, both small multiples (never one dual-axis
 *     chart), the funnel, sources, products, customers, governorates,
 *     coupons; a chart's readout appears on hover AND on keyboard focus; the
 *     table view shows the same numbers; the range presets re-ask the server;
 *   - the order screen: items with SKU, timeline oldest-first with the
 *     expected release marked, money from the ledger, a status move asks
 *     first (the confirm dialog), the print button exists;
 *   - customers: the list links to a customer, the customer's orders link to
 *     the order screen;
 *   - the prompt dialog: an empty required answer is refused in place, a bad
 *     number too, and a valid answer comes back trimmed.
 *
 * Screenshots: OUT_DIR (default /tmp/claude-0/shots/w3b/).
 * Run: npx vite --port 4191 &  PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright node scripts/e2e-merchant-w3b.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WORKSPACE_URL || 'http://127.0.0.1:4191';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/w3b';
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
  ['analytics', '/merchant/analytics', '[data-analytics-kpis]'],
  ['order', '/merchant/orders/ORD-22EE1B07', '[data-order-timeline]'],
  ['order-new', '/merchant/orders/ORD-7F3A21C9', '[data-order-actions]'],
  ['orders', '/merchant/orders', '[data-merchant-shell]'],
  ['customers', '/merchant/customers', '[data-customers]'],
  ['customer', '/merchant/customers/ORD-22EE1B07', '[data-customer-detail]'],
];
const WIDTHS = [
  [360, 780],
  [768, 1024],
  [1280, 860],
];
const url = (path, lang) => `${origin}/tests/browser/merchant-workspace.html?lang=${lang}&path=${encodeURIComponent(path)}`;

async function overflow(page) {
  return page.evaluate(() => {
    const owner = document.querySelector('[data-scroll-owner]');
    return { page: document.documentElement.scrollWidth - window.innerWidth, owner: owner ? owner.scrollWidth - owner.clientWidth : 0 };
  });
}

const browser = await chromium.launch();
try {
  for (const [w, h] of WIDTHS) {
    for (const lang of ['ar', 'en']) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 640, isMobile: w < 640, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      for (const [name, path, marker] of ROUTES) {
        await page.goto(url(path, lang), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-merchant-shell]', { timeout: 20000 });
        const found = await page.waitForSelector(marker, { timeout: 10000 }).then(() => true, () => false);
        await page.waitForTimeout(500);
        const tag = `${name}-${w}-${lang}`;
        check(`${tag}: renders`, found);
        const o = await overflow(page);
        check(`${tag}: no horizontal overflow`, o.page <= 0 && o.owner <= 1, JSON.stringify(o));
        await page.screenshot({ path: `${out}/${tag}.png`, fullPage: false });
        // A full-length capture of the long screens.
        if (name === 'analytics' || name === 'order') {
          const full = await page.evaluate(() => {
            const el = document.querySelector('[data-scroll-owner]');
            return el ? el.scrollHeight : document.documentElement.scrollHeight;
          });
          await page.setViewportSize({ width: w, height: Math.min(full + 120, 6000) });
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${out}/${tag}-full.png` });
          await page.setViewportSize({ width: w, height: h });
        }
      }

      // ---- analytics behaviour
      await page.goto(url('/merchant/analytics', lang), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-analytics-kpis]', { timeout: 15000 });
      const a = await page.evaluate(() => ({
        kpis: document.querySelectorAll('[data-analytics-kpis] [data-kpi]').length,
        daily: [...document.querySelectorAll('[data-daily-chart]')].map((e) => e.getAttribute('data-daily-chart')),
        cards: [...document.querySelectorAll('[data-chart-card]')].map((e) => e.getAttribute('data-chart-card')),
        deltas: document.querySelectorAll('[data-analytics-kpis] [data-kpi] .text-success, [data-analytics-kpis] [data-kpi] .text-danger').length,
      }));
      check(`analytics-${w}-${lang}: 7 KPI tiles`, a.kpis === 7, String(a.kpis));
      check(`analytics-${w}-${lang}: two small multiples (line + columns)`, a.daily.join() === 'line,columns', a.daily.join());
      for (const c of ['funnel', 'sources', 'top-products', 'views', 'customers', 'governorates', 'coupons', 'requests']) {
        check(`analytics-${w}-${lang}: ${c}`, a.cards.includes(c), a.cards.join());
      }
      check(`analytics-${w}-${lang}: period deltas where both periods exist`, a.deltas >= 6, String(a.deltas));
      const svg = page.locator('[data-daily-chart="line"] svg');
      await svg.scrollIntoViewIfNeeded();
      const box = await svg.boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.waitForTimeout(150);
      check(`analytics-${w}-${lang}: hover shows the readout`, (await page.locator('[data-daily-chart="line"] [data-chart-readout]').count()) === 1);
      await page.screenshot({ path: `${out}/analytics-hover-${w}-${lang}.png` });
      await page.mouse.move(2, 2);
      await svg.focus();
      await page.keyboard.press(lang === 'ar' ? 'ArrowRight' : 'ArrowLeft');
      check(`analytics-${w}-${lang}: keyboard focus shows the readout`, (await page.locator('[data-daily-chart="line"] [data-chart-readout]').count()) === 1);
      await page.locator('[data-chart-card="daily-orders"] [data-chart-view="table"]').click();
      const rows = await page.locator('[data-chart-card="daily-orders"] [data-chart-table] tbody tr').count();
      check(`analytics-${w}-${lang}: the table view has every day`, rows === 30, String(rows));
      await page.locator('[data-chart-card="daily-orders"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/analytics-table-${w}-${lang}.png` });
      const calls = () => page.evaluate(() => (window.__apiCalls ?? []).filter((c) => c.startsWith('/api/merchant/analytics/report')));
      const before = (await calls()).length;
      await page.locator('[data-range="7"]').click();
      await page.waitForTimeout(400);
      const after = await calls();
      check(`analytics-${w}-${lang}: a preset re-asks the server`, after.length > before && /from=.*&to=/.test(after[after.length - 1]), after.slice(-1)[0]);
      await page.locator('[data-range="custom"]').click();
      await page.waitForSelector('[data-custom-range]');
      await page.locator('[data-analytics-filters]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/analytics-custom-${w}-${lang}.png` });

      // ---- order screen behaviour
      await page.goto(url('/merchant/orders/ORD-7F3A21C9', lang), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-order-actions]', { timeout: 15000 });
      await page.locator('[data-order-move="confirmed"]').click();
      const asked = await page.waitForSelector('[data-overlay="confirm-dialog"], [data-testid="confirm-dialog"], [role="alertdialog"]', { timeout: 5000 }).then(() => true, () => false);
      check(`order-${w}-${lang}: a status move asks first`, asked);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/order-confirm-${w}-${lang}.png` });
      await page.keyboard.press('Escape');
      await page.goto(url('/merchant/orders/ORD-22EE1B07', lang), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-order-timeline]', { timeout: 15000 });
      const t = await page.evaluate(() => ({
        events: [...document.querySelectorAll('[data-order-timeline] [data-event]')].map((e) => e.getAttribute('data-event')),
        sku: document.querySelector('[data-order-items]')?.textContent?.includes('DR-01-GL'),
        ledger: !!document.querySelector('[data-order-ledger]'),
        print: !!document.querySelector('[data-print-order]'),
        slipHidden: getComputedStyle(document.querySelector('[data-print-slip]')).display === 'none',
      }));
      check(`order-${w}-${lang}: the timeline, oldest first, the expected release last`, t.events[0] === 'placed' && t.events[t.events.length - 1] === 'release_due', t.events.join());
      check(`order-${w}-${lang}: SKU snapshot, ledger money, print`, t.sku && t.ledger && t.print && t.slipHidden, JSON.stringify(t));
      await page.emulateMedia({ media: 'print' });
      await page.screenshot({ path: `${out}/order-print-${w}-${lang}.png` });
      await page.emulateMedia({ media: 'screen' });

      // ---- customers
      await page.goto(url('/merchant/customers', lang), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-customers] a[href*="/merchant/customers/"]', { timeout: 15000 });
      await page.locator('[data-customers] a[href*="/merchant/customers/"]').first().click();
      await page.waitForSelector('[data-customer-detail]', { timeout: 10000 });
      check(`customers-${w}-${lang}: a row opens the customer`, new URL(page.url()).pathname.startsWith('/merchant/customers/ORD-'));
      await page.locator('[data-customer-order]').first().click();
      await page.waitForSelector('[data-order-detail]', { timeout: 10000 });
      check(`customers-${w}-${lang}: their order opens the order screen`, new URL(page.url()).pathname.startsWith('/merchant/orders/'));

      check(`errors-${w}-${lang}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
      await ctx.close();
    }
  }

  // ---- the prompt dialog
  for (const lang of ['ar', 'en']) {
    for (const [w, h] of [[360, 740], [1280, 800]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 640, isMobile: w < 640 });
      const page = await ctx.newPage();
      await page.goto(`${origin}/tests/browser/prompt-dialog.html?lang=${lang}`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-open="reason"]').click();
      await page.waitForSelector('[data-prompt-input]');
      await page.waitForTimeout(350);
      const focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-prompt-input'));
      check(`prompt-${w}-${lang}: focus lands in the field`, !!focused);
      await page.locator('[data-prompt-submit]').click();
      await page.waitForTimeout(150);
      check(`prompt-${w}-${lang}: an empty required answer is refused in place`, (await page.locator('[data-prompt-input][aria-invalid="true"]').count()) === 1);
      await page.screenshot({ path: `${out}/prompt-required-${w}-${lang}.png` });
      await page.locator('[data-prompt-input]').fill('   the model has no supports  ');
      await page.locator('[data-prompt-submit]').click();
      await page.waitForTimeout(400);
      check(`prompt-${w}-${lang}: the answer comes back trimmed`, (await page.locator('[data-answer]').textContent()) === 'reason:the model has no supports');
      await page.locator('[data-open="points"]').click();
      await page.waitForSelector('[data-prompt-input]');
      await page.locator('[data-prompt-input]').fill('0');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      check(`prompt-${w}-${lang}: a bad number is refused in place`, (await page.locator('[data-prompt-input][aria-invalid="true"]').count()) === 1);
      await page.screenshot({ path: `${out}/prompt-number-${w}-${lang}.png` });
      await page.locator('[data-prompt-input]').fill('-5');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      check(`prompt-${w}-${lang}: Enter submits a valid number`, (await page.locator('[data-answer]').textContent()) === 'points:-5');
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
