#!/usr/bin/env node
/**
 * The wallet, in a real browser.
 *
 * WHAT THE OWNER REPORTED, and what each check here holds:
 *
 *   "دمج عمليات السحب والايداع في قائمة العمليات" — there must be ONE list.
 *   The page used to carry a withdrawals section and an activity section, so
 *   a customer counted the same money twice and then went hunting for the
 *   cancel button in the other one.
 *
 *   "هناك مشكلة في النافذة المنبثقة للسحب والايداع" — the modal. It was
 *   rendered inline, and under an ancestor with a transform `position: fixed`
 *   stops meaning the viewport, which is what put the order modal at the
 *   bottom of the page a week earlier. So this measures where the dialog
 *   actually lands, in pixels, on a phone-sized viewport — a screenshot
 *   cannot prove that and a unit test cannot see it at all.
 *
 *   "واريد العمليه بسيطه" — three steps, each refusing to advance until its
 *   own field is right, so an error is never about something two screens
 *   back. The checks walk both flows and assert the refusals.
 *
 *   node scripts/e2e-wallet.mjs        (expects wrangler dev on :8787)
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const rnd = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let pass = 0, fail = 0;
const check = (l, ok, d='') => { if (ok) { pass++; console.log('  ok   '+l); } else { fail++; console.log('  FAIL '+l+(d?' — '+d:'')); } };
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read','clipboard-write'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(BASE + '/auth', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (r) => {
    await fetch('/api/auth/register', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email:`wal-${r}@test.local`, username:`wal${r}`, name:'Wallet User', password:'wallet-pass-1' })});
    await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email:`wal-${r}@test.local`, password:'wallet-pass-1' })});
  }, rnd);
  await page.goto(BASE + '/wallet', { waitUntil: 'networkidle' });
  check('the wallet page renders', await page.locator('h1').first().isVisible());
  check('no runtime errors on load', errs.length === 0, errs.join(' | ').slice(0,200));

  // There must be ONE operations list, not a separate withdrawals section.
  const headings = await page.locator('h2').allInnerTexts();
  check('exactly one list heading, not two', headings.filter(h => h.includes('العمليات') || h.includes('طلبات السحب')).length === 1, JSON.stringify(headings));

  // Deposit modal: portalled to body, and stepped.
  await page.getByRole('button', { name: /إضافة رصيد|Add funds/ }).first().click();
  await page.waitForSelector('[data-wallet-modal="deposit"]', { timeout: 5000 });
  const parent = await page.evaluate(() => {
    const el = document.querySelector('[data-wallet-modal="deposit"]');
    return el?.parentElement?.parentElement?.tagName ?? '';
  });
  check('the deposit modal is portalled to <body>', parent === 'BODY', parent);
  const box = await page.locator('[data-wallet-modal="deposit"]').boundingBox();
  const vp = page.viewportSize();
  check('and it is on screen, not below the fold', !!box && box.y < vp.height && box.y + box.height > 0, JSON.stringify(box));

  // Step 1 must refuse to advance without a channel.
  await page.getByRole('button', { name: /^التالي$|^Next$/ }).click();
  const alert = await page.locator('[role="alert"]').first().innerText().catch(() => '');
  check('step 1 refuses to advance without a channel', alert.length > 0, alert);
  const amountVisible = await page.locator('input[inputmode="decimal"]').isVisible().catch(() => false);
  check('and it did NOT jump to the amount step', !amountVisible);

  await page.keyboard.press('Escape');
  await page.locator('[data-wallet-modal="deposit"] button[aria-label]').first().click();

  // Withdrawal modal: channel + account, then amount.
  await page.getByRole('button', { name: /سحب رصيد|Withdraw/ }).first().click();
  await page.waitForSelector('[data-wallet-modal="withdrawal"]', { timeout: 5000 });
  check('the withdrawal modal opens', true);
  const kinds = await page.locator('[data-wallet-modal="withdrawal"] button').allInnerTexts();
  check('step 1 offers the payout channels as buttons', kinds.some(k => /زين كاش|ZainCash/.test(k)), JSON.stringify(kinds).slice(0,200));
  await page.getByRole('button', { name: /^التالي$|^Next$/ }).click();
  const a2 = await page.locator('[role="alert"]').first().innerText().catch(() => '');
  check('it refuses to advance without an account number', a2.length > 0, a2);
  await page.locator('[data-wallet-modal="withdrawal"] input[dir="ltr"]').first().fill('07701234567');
  await page.getByRole('button', { name: /^التالي$|^Next$/ }).click();
  check('with an account it reaches the amount step',
    await page.locator('input[inputmode="decimal"]').isVisible());
  // The balance is zero, so any amount must be refused as over balance.
  await page.locator('input[inputmode="decimal"]').fill('50');
  await page.getByRole('button', { name: /^التالي$|^Next$/ }).click();
  const a3 = await page.locator('[role="alert"]').first().innerText().catch(() => '');
  check('an amount beyond the balance is refused at the amount step', a3.length > 0, a3);

  check('still no runtime errors', errs.length === 0, errs.join(' | ').slice(0,300));
  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  await browser.close();
}
process.exit(fail ? 1 : 0);
