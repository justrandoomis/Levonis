#!/usr/bin/env node
/**
 * QUICK EDIT in a real browser — the part an API script cannot prove.
 *
 * The owner's measure is time: the daily price change must not require opening
 * the full product form. So what is checked here is the interaction, not the
 * arithmetic (tests/priceGrid.test.ts and scripts/e2e-quick-price.mjs hold
 * that):
 *
 *   - the button is on the product row itself, one click from the list;
 *   - the drawer opens on the whole price table, one row per model x route;
 *   - typing in a cell marks it dirty and ENTER saves everything pending, with
 *     no page reload — the grid comes back from the same response;
 *   - ESCAPE throws the pending edits away and puts the old numbers back;
 *   - a price below cost does not save silently and does not flatly refuse:
 *     it shows the warning and offers to go ahead;
 *   - an undo appears after a save and puts the price back;
 *   - the bulk tab will not apply anything until a preview has been read;
 *   - and on a 390px phone the same rows render as CARDS, with no sideways
 *     scroll anywhere in the window.
 *
 *   node scripts/e2e-quick-price-ui.mjs        (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const OUT = path.join(ROOT, 'docs', 'evidence', 'quick-price');

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
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sql = (statement) =>
  execSync(`npx wrangler d1 execute levonis-db --local --command ${JSON.stringify(statement)}`, {
    cwd: ROOT,
    stdio: 'pipe',
  });

const rnd = Math.random().toString(36).slice(2, 8);

/** The grid becomes cards below `md`, which is also where the list drops its
 *  table view — so one predicate answers for both. */
const isPhoneWidth = (w) => w < 768;

const templateFor = (slug) => `template_version=2
slug=${slug}
name_ar=QP UI ${rnd}
name_en=QP UI ${rnd}
status=active
price_iqd=500000
prime_price_iqd=480000
pro_price_iqd=460000
product_cost_iqd=400000
selling_type=mixed
transports.1.method=air
transports.1.commission_iqd=25000
transports.1.active=true

options.1.id=${slug}-pre
options.1.name_ar=Model S - Pre-order
options.1.availability_type=pre_order
options.1.variant_key=s
options.1.variant_label=Model S
options.1.stock=__NULL__
options.1.regular_price_iqd=500000
options.1.cost_iqd=400000

options.2.id=${slug}-dir
options.2.name_ar=Model S - Direct Sale
options.2.availability_type=direct_sale
options.2.variant_key=s
options.2.variant_label=Model S
options.2.stock=5
options.2.regular_price_iqd=550000
options.2.cost_iqd=420000
`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nQUICK EDIT window — ${BASE}\n`);

  const email = `qpui-${rnd}@test.local`;
  const password = 'quick-price-ui-1';
  let cookie = '';
  const call = async (p, body) => {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  };

  check('admin registered', (await call('/api/auth/register', { email, username: `qu${rnd}`, name: 'QP UI', password })).status === 200);
  sql(`UPDATE users SET role='admin' WHERE email='${email}'`);
  check('admin signed in', (await call('/api/auth/login', { email, password })).status === 200);

  const slug = `qp-ui-${rnd}`;
  const applied = await call('/api/admin/template/apply', { text: templateFor(slug), mode: 'draft', confirm: true });
  const productId = applied.data?.product_id;
  check('the two-cell product exists', !!productId, JSON.stringify(applied.data).slice(0, 200));
  if (!productId) return report();
  sql(`UPDATE products SET status='active' WHERE id='${productId}'`);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  for (const width of [390, 1280]) {
    const label = `${width}px`;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: 'ar' });
    await ctx.addCookies([
      { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' },
    ]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    if ((await page.locator('[data-tab="products"]:visible').count()) === 0) {
      await page.locator('[data-action="open-sidebar"]').first().click();
      await page.waitForTimeout(400);
    }
    await page.locator('[data-tab="products"]:visible').first().click({ timeout: 15000 });
    await page.waitForTimeout(900);

    // ----------------------------- 0. the price is editable where it is read
    // The table view only exists above the phone breakpoint; the inline field
    // is the desktop shortcut, and the drawer is the answer everywhere.
    if (!isPhoneWidth(width)) {
      const priceBtn = page.locator(`[data-inline-price="${productId}"]:visible`).first();
      check(`${label} — the list price is clickable`, (await priceBtn.count()) === 1);
      if ((await priceBtn.count()) === 1) {
        await priceBtn.click();
        const field = page.locator(`[data-inline-price-input="${productId}"]:visible`).first();
        await field.fill('530K');
        await field.press('Enter');
        await page.waitForTimeout(1200);
        const shown = await page.locator(`[data-inline-price="${productId}"]:visible`).first().innerText();
        check(`${label} — it saves in place and shows the new price`, shown.replace(/[^0-9]/g, '') === '530000', shown);
        // put it back, so the drawer assertions below start from the fixture
        await page.locator(`[data-inline-price="${productId}"]:visible`).first().click();
        const again = page.locator(`[data-inline-price-input="${productId}"]:visible`).first();
        await again.fill('500000');
        await again.press('Enter');
        await page.waitForTimeout(1000);
      }
    }

    // ------------------------------------------- 1. one click from the row
    const trigger = page.locator(`[data-quick-price="${productId}"]:visible`).first();
    check(`${label} — the row carries a quick-price button`, (await trigger.count()) === 1);
    if ((await trigger.count()) !== 1) {
      await ctx.close();
      continue;
    }
    await trigger.click({ timeout: 15000 });
    await page.waitForSelector('[data-qp="panel"]', { timeout: 15000 });
    await page.waitForTimeout(700);

    const panel = page.locator('[data-qp="panel"]');
    check(`${label} — the drawer opens without leaving the list`, (await panel.count()) === 1 && page.url().endsWith('/admin'));

    // -------------------------------------------- 2. the whole table at once
    const isPhone = isPhoneWidth(width);
    const rowSel = isPhone ? '[data-qp-card]' : '[data-qp-row]';
    const rowCount = await page.locator(`${rowSel}:visible`).count();
    check(`${label} — the base row and both option rows are all here`, rowCount === 3, `n=${rowCount}`);
    check(
      `${label} — a phone gets cards, a desktop gets the table`,
      isPhone
        ? (await page.locator('[data-qp="cards"]:visible').count()) === 1 &&
            (await page.locator('[data-qp="table"]:visible').count()) === 0
        : (await page.locator('[data-qp="table"]:visible').count()) === 1
    );
    check(
      `${label} — every cell says which mode it is in`,
      (await page.locator(`[data-qp-cell="option:${slug}-dir:regular"][data-qp-mode]:visible`).count()) === 1
    );
    check(
      `${label} — and the profit is on the row`,
      (await page.locator(`[data-qp-profit="option:${slug}-dir"]:visible`).count()) === 1
    );

    // ------------------------------------------ 3. type, Enter, no reload
    const cell = page.locator(`[data-qp-input="option:${slug}-dir:regular"]:visible`).first();
    await cell.click();
    await cell.fill('600K');
    await page.waitForTimeout(250);
    check(
      `${label} — the cell is marked unsaved as it is typed`,
      (await page.locator(`[data-qp-cell="option:${slug}-dir:regular"][data-qp-dirty-cell="1"]:visible`).count()) === 1
    );
    check(`${label} — and the count is shown`, (await page.locator('[data-qp-dirty="1"]:visible').count()) === 1);

    // Mark the document so a full reload would be detectable.
    await page.evaluate(() => {
      window.__qpNoReload = true;
    });
    await cell.press('Enter');
    await page.waitForTimeout(1200);
    check(`${label} — Enter saved without a page reload`, (await page.evaluate(() => window.__qpNoReload === true)) === true);
    check(`${label} — nothing is pending afterwards`, (await page.locator('[data-qp-dirty="0"]:visible').count()) === 1);
    const savedValue = await page.locator(`[data-qp-input="option:${slug}-dir:regular"]:visible`).first().inputValue();
    check(`${label} — the shorthand was expanded`, savedValue === '600000', savedValue);
    check(`${label} — and a confirmation is shown`, (await page.locator('[data-qp="toast"]:visible').count()) === 1);

    // ---------------------------------------------- 4. undo the last save
    check(`${label} — an undo is offered after a save`, (await page.locator('[data-qp="undo"]:visible').count()) === 1);
    await page.locator('[data-qp="undo"]:visible').first().click();
    await page.waitForTimeout(1200);
    const undone = await page.locator(`[data-qp-input="option:${slug}-dir:regular"]:visible`).first().inputValue();
    check(`${label} — the undo put the price back`, undone === '550000', undone);

    // ------------------------------------------------ 5. Escape discards
    await cell.click();
    await cell.fill('123456');
    await page.waitForTimeout(200);
    await cell.press('Escape');
    await page.waitForTimeout(400);
    const afterEscape = await page.locator(`[data-qp-input="option:${slug}-dir:regular"]:visible`).first().inputValue();
    check(`${label} — Escape throws the pending edit away`, afterEscape === '550000', afterEscape);
    check(
      `${label} — and the drawer is still open`,
      (await page.locator('[data-qp="panel"]').count()) === 1
    );

    // ---------------------------------------- 6. the guard warns, not vetoes
    await cell.click();
    await cell.fill('300000');
    await page.waitForTimeout(200);
    await page.locator('[data-qp="save"]:visible').first().click();
    await page.waitForTimeout(1400);
    check(`${label} — a price below cost brings up a warning`, (await page.locator('[data-qp="guard"]:visible').count()) === 1);
    check(
      `${label} — which names the reason`,
      (await page.locator('[data-qp-guard="BELOW_COST"]:visible').count()) >= 1
    );
    const stillPending = await page.locator('[data-qp-dirty="1"]:visible').count();
    check(`${label} — and nothing was saved yet`, stillPending === 1, `pending blocks=${stillPending}`);
    await page.locator('[data-qp="save"]:visible').first().click();
    await page.waitForTimeout(1400);
    const confirmed = await page.locator(`[data-qp-input="option:${slug}-dir:regular"]:visible`).first().inputValue();
    check(`${label} — confirming goes through`, confirmed === '300000', confirmed);
    // put it back so the next viewport starts clean
    await page.locator('[data-qp="undo"]:visible').first().click();
    await page.waitForTimeout(1200);

    // ------------------------------------- 7. no bulk apply without a preview
    await page.locator('[data-qp-tab="bulk"]:visible').first().click();
    await page.waitForTimeout(400);
    check(
      `${label} — the bulk apply is unavailable before a preview`,
      await page.locator('[data-qp="bulk-apply"]:visible').first().isDisabled()
    );
    await page.locator('[data-qp="bulk-value"]:visible').first().fill('25000');
    await page.locator('[data-qp="bulk-preview"]:visible').first().click();
    await page.waitForTimeout(1200);
    check(`${label} — the preview lists the cells it would move`, (await page.locator('[data-qp="preview"]:visible').count()) === 1);
    check(
      `${label} — and only then can it be applied`,
      !(await page.locator('[data-qp="bulk-apply"]:visible').first().isDisabled())
    );
    // Changing the request invalidates the preview, so Apply can never send
    // something other than what was read.
    await page.locator('[data-qp="bulk-value"]:visible').first().fill('30000');
    await page.waitForTimeout(300);
    check(
      `${label} — editing the request withdraws the preview`,
      (await page.locator('[data-qp="preview"]:visible').count()) === 0 &&
        (await page.locator('[data-qp="bulk-apply"]:visible').first().isDisabled())
    );

    // ------------------------------------------------ 8. it fits the screen
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return { doc: de.scrollWidth - de.clientWidth, body: document.body.scrollWidth - document.body.clientWidth };
    });
    check(`${label} — the window never scrolls sideways`, overflow.doc <= 1 && overflow.body <= 1, JSON.stringify(overflow));

    await page.screenshot({ path: path.join(OUT, `quick-price-${width}.png`), fullPage: false });
    await ctx.close();
  }

  await browser.close();
  report();
}

function report() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
