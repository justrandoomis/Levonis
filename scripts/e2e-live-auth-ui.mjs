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

import zlib from 'node:zlib';

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) for pixel checks. */
function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, colorType = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * bpp]; out[(y * width + x) * 4 + 1] = line[x * bpp + 1]; out[(y * width + x) * 4 + 2] = line[x * bpp + 2]; out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

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

  // The Google identity iframe must sit transparent on the well: its corner
  // pixels are sampled from a screenshot and have to be dark, never the
  // white backdrop a colour-scheme mismatch paints.
  const wellCorners = async (page) => {
    const box = await page.$eval('.lv-google', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
    const { width, height, rgba } = decodePng(png);
    const at = (x, y) => { const i = (y * width + x) * 4; return (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3; };
    const pts = [[2, 2], [width - 3, 2], [2, height - 3], [width - 3, height - 3], [Math.round(width / 2), 1], [Math.round(width / 2), height - 2]];
    return { max: Math.max(...pts.map(([x, y]) => at(x, y))), width, height };
  };

  for (const [w, h] of [[390, 844], [1440, 900]]) {
    const { ctx, page, errors } = await open(w, h);
    if (caps.google && w === 390) {
      await page.waitForSelector('iframe[src*="accounts.google.com"]', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const c = await wellCorners(page);
      check('the Google button sits on a dark well with no white frame', c.max < 90, `max corner luminance=${Math.round(c.max)} (${c.width}×${c.height})`);
    }
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

  // Short viewports (a phone browser with its bars, an iPad in landscape):
  // the sign-in must fit without scrolling and the providers become icons.
  for (const [w, h] of [[390, 600], [1024, 590]]) {
    const { ctx, page } = await open(w, h);
    const fit = await page.evaluate(() => { const sc = document.querySelector('.lv-auth > .absolute'); return { sh: sc.scrollHeight, ch: sc.clientHeight }; });
    check(`${w}×${h}: the live sign-in fits without scrolling`, fit.sh <= fit.ch + 1, JSON.stringify(fit));
    if (caps.google) {
      await page.waitForSelector('iframe[src*="accounts.google.com"]', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const compact = await page.$eval('.lv-google', (el) => el.classList.contains('lv-google--compact') && el.getBoundingClientRect().width < 60);
      check(`${w}×${h}: the Google mark is the icon-only official button`, compact);
      const c = await wellCorners(page);
      check(`${w}×${h}: no white frame around the Google mark`, c.max < 90, `max=${Math.round(c.max)}`);
    }
    await page.screenshot({ path: path.join(OUT, `live-auth-fit-${w}x${h}.png`) });
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
    await page.fill('#new-password', 'preview-pass-1');
    await page.fill('#confirm-password', 'preview-pass-1');
    await page.click('#signup-next-1');
    await page.waitForSelector('#name', { timeout: 10000 });
    check('step 2 (name + handle + country) reached with nothing posted', !!(await page.$('#username')) && !!(await page.$('#country')) && posts.length === 0, `posts=${posts.length}`);
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
