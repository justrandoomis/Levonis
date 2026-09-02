#!/usr/bin/env node
/**
 * Live verification of the /auth SCREEN itself, in a real browser against
 * the real origin — the companion of e2e-live-auth.mjs, which proves the
 * API paths. This one proves what a person sees: the page renders at phone
 * and desktop widths without overflow, the providers the deployment
 * advertises are the ones on screen (Google's own identity iframe, the
 * Telegram entry that opens the phone panel), the forgot-password link
 * appears only when mail is configured, the three-step sign-up opens with
 * its stepper and posts nothing until the last step, and a REAL sign-in with
 * the run's throwaway identity leaves /auth for the destination.
 *
 * It never creates an account (the API scenario already did), never sends
 * mail, and signs out at the end so the live session table is left as it
 * was. Screenshots go to OUT_DIR for the run artifact.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const { chromium } = require2('playwright');

const APEX = (process.env.APEX || 'https://levonis-iq.com').replace(/\/+$/, '');
const EMAIL = process.env.TEST_EMAIL || '';
const PASSWORD = process.env.TEST_PASSWORD || '';
const OUT = process.env.OUT_DIR || '/tmp/live-auth-ui';
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, evidence = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${evidence ? `  — ${evidence}` : ''}`);
};

async function main() {
  const caps = await fetch(`${APEX}/api/auth/capabilities`).then((r) => r.json());
  console.log(`live capabilities: google=${!!caps.google} telegram=${!!caps.telegram} passwordReset=${!!caps.passwordReset} emailVerification=${!!caps.emailVerification}`);

  const browser = await chromium.launch();
  const open = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'ar', colorScheme: 'dark', hasTouch: w < 800 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${APEX}/auth`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('#identifier', { timeout: 30000 });
    await page.waitForTimeout(800);
    return { ctx, page, errors };
  };

  for (const [w, h] of [[390, 844], [1440, 900]]) {
    const { ctx, page, errors } = await open(w, h);
    const g = await page.evaluate(() => {
      const card = document.querySelector('.lv-card').getBoundingClientRect();
      const fonts = [...document.querySelectorAll('.lv-auth input')].map((i) => parseFloat(getComputedStyle(i).fontSize));
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, cardL: Math.round(card.left), cardR: Math.round(card.right), minFont: Math.min(...fonts), dir: document.querySelector('.lv-auth')?.getAttribute('dir') };
    });
    check(`${w}px: /auth renders the blueprint sign-in inside the viewport (RTL, no overflow, 16px inputs)`,
      g.overflow <= 0 && g.cardL >= 0 && g.cardR <= w && g.minFont >= 16 && g.dir === 'rtl', JSON.stringify(g));
    const googleIframe = await page.locator('iframe[src*="accounts.google.com"]').count();
    check(`${w}px: Google slot matches capabilities (real GIS iframe, never a fake)`, caps.google ? googleIframe > 0 : googleIframe === 0, `iframe=${googleIframe}`);
    const tg = page.locator('button.lv-social', { hasText: 'تيليغرام' });
    check(`${w}px: Telegram entry matches capabilities`, caps.telegram ? (await tg.count()) === 1 : (await tg.count()) === 0, `buttons=${await tg.count()}`);
    const forgot = await page.locator('text=نسيت كلمة المرور؟').count();
    check(`${w}px: forgot-password link only when mail is configured`, caps.passwordReset ? forgot === 1 : forgot === 0, `links=${forgot}`);
    await page.screenshot({ path: path.join(OUT, `live-auth-signin-${w}.png`) });
    check(`${w}px: zero page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
    await ctx.close();
  }

  // Telegram panel, forgot screen, sign-up stepper — on the phone width.
  {
    const { ctx, page } = await open(390, 844);
    if (caps.telegram) {
      await page.locator('button.lv-social', { hasText: 'تيليغرام' }).click();
      await page.waitForSelector('#tg-auth-phone', { timeout: 15000 });
      const owns = await page.evaluate(() => {
        const phone = document.getElementById('tg-auth-phone');
        const form = phone && phone.closest('form');
        return !!form && !form.querySelector('#identifier') && !!form.querySelector('button[type=submit]');
      });
      check('Telegram entry opens the phone panel in its own form', owns);
      await page.screenshot({ path: path.join(OUT, 'live-auth-telegram-390.png') });
      await page.locator('.lv-back').first().click();
      await page.waitForSelector('#identifier');
    }
    if (caps.passwordReset) {
      await page.locator('text=نسيت كلمة المرور؟').click();
      await page.waitForSelector('#forgot-submit', { timeout: 15000 });
      check('forgot-password screen renders its email form (not submitted here)', !!(await page.$('#email')));
      await page.screenshot({ path: path.join(OUT, 'live-auth-forgot-390.png') });
      await page.locator('.lv-back').first().click();
      await page.waitForSelector('#identifier');
    }
    const posts = [];
    page.on('request', (rq) => { if (rq.url().includes('/api/auth/register') && rq.method() === 'POST') posts.push(1); });
    await page.click('button:has-text("أنشئ حسابًا")');
    await page.waitForSelector('#email', { timeout: 15000 });
    const stepper = await page.textContent('.lv-stepper__count').catch(() => '');
    check('sign-up opens on step 1 of 3 with its own meter and the referral bar', /01/.test(stepper || '') && !!(await page.$('#signup-next-1')) && !!(await page.$('.lv-refbar')));
    await page.fill('#email', 'preview@example.com');
    await page.fill('#username', 'previewhandle');
    await page.fill('#new-password', 'preview-pass-1');
    await page.fill('#confirm-password', 'preview-pass-1');
    await page.waitForTimeout(600);
    await page.click('#signup-next-1');
    await page.waitForSelector('#name', { timeout: 10000 });
    check('step 2 (name + country) reached with nothing posted', !!(await page.$('#country')) && posts.length === 0, `posts=${posts.length}`);
    await page.screenshot({ path: path.join(OUT, 'live-auth-signup-2-390.png') });
    await ctx.close();
  }

  // A REAL sign-in with the run's identity, through the form.
  if (EMAIL && PASSWORD) {
    const { ctx, page, errors } = await open(390, 844);
    await page.fill('#identifier', EMAIL);
    await page.fill('#current-password', PASSWORD);
    check('the sign-in button is ready only after both fields pass', (await page.getAttribute('#signin-submit', 'data-ready')) === 'true');
    await page.click('#signin-submit');
    await page.waitForFunction(() => !location.pathname.startsWith('/auth'), null, { timeout: 30000 }).catch(() => {});
    const me = await page.evaluate(() => fetch('/api/auth/me', { credentials: 'include' }).then((r) => r.json()).catch(() => null));
    check('a real sign-in through the redesigned form leaves /auth with a live session', !page.url().includes('/auth') && !!me?.user?.id, `url=${page.url().replace(APEX, '')} me=${me?.user ? 'user' : 'none'}`);
    check('zero page errors during sign-in', errors.length === 0, errors.join(' | ').slice(0, 200));
    await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => null));
    await ctx.close();
  } else {
    check('a real sign-in through the form (skipped: no TEST_EMAIL/TEST_PASSWORD)', false, 'identity missing');
  }

  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('live UI probe crashed:', e); process.exit(1); });
