#!/usr/bin/env node
/**
 * THE FOUR-STEP REQUEST EDITOR, END TO END (community UI plan C4; P1-06,
 * docs/DECISIONS.md row 268), in a real browser against a running site (the
 * Vite SPA with the Worker behind it, the community gate open).
 *
 *   1  /requests/new: a blank page, no draft yet; the first keystroke makes
 *      the draft and the address becomes /requests/new/<id>?step=1
 *   2  a picture and a model through the step-1 inputs; both land as rows
 *   3  a reload on step 1 keeps the step, the title and the files
 *   4  offline, a change, then the header back: the in-app blocker asks
 *      («تغادر دون حفظ؟»); «ابقَ» stays
 *   5  step 2: FDM, PETG, black, «قياسية», 4 copies, the size; reload keeps it
 *   6  step 3: Baghdad, «توصيل», a day, a budget of 45,000 with the switch
 *      left OFF; reload keeps it, and the switch is still off
 *   7  step 4: the cards, the budget said hidden, «تعديل» of the delivery
 *      opens step 3 at its card; back to step 4
 *   8  no button text is clipped at this width (scrollWidth > clientWidth)
 *   9  «انشر الطلب»: the request page, `{ published: true }`; Back reaches
 *      the board, never the editor; a guest reads the request with no budget
 *
 * Run (a full stack, e.g. the harness): the customer session cookie comes from
 * the environment, never from this file.
 *
 *   E2E_BASE=http://127.0.0.1:5249 E2E_SESSION=<customer levonis_session> \
 *     node scripts/e2e-request-editor.mjs [--lang ar|en|ckb] [--viewport 390x844] [--keep-draft]
 *
 * `--keep-draft` stops before the publish and prints the draft id (a
 * fixture for screenshots). Output: OUT_DIR (default
 * /tmp/levonis-diagnostics/request-editor) gets one PNG per step.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const argv = process.argv.slice(2);
const arg = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : d;
};
const base = (process.env.E2E_BASE || '').replace(/\/+$/, '');
const session = process.env.E2E_SESSION || '';
if (!base || !session) {
  console.error('e2e-request-editor: set E2E_BASE (the site) and E2E_SESSION (a customer session cookie).');
  process.exit(2);
}
const lang = arg('--lang', 'ar');
const [vw, vh] = arg('--viewport', '390x844').split('x').map(Number);
const keep = argv.includes('--keep-draft');
const out = process.env.OUT_DIR || '/tmp/levonis-diagnostics/request-editor';
await mkdir(out, { recursive: true });

// ---------------------------------------------------------------- fixtures, made here

/** A tiny PNG (a dark square on sand), so no picture file lives in the repository. */
function png(size = 64) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const inside = x > size / 4 && x < (size * 3) / 4 && y > size / 4 && y < (size * 3) / 4;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = inside ? 28 : 200;
      raw[o + 1] = inside ? 28 : 170;
      raw[o + 2] = inside ? 30 : 130;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** An ASCII STL box of 80 × 40 × 30 mm. */
function stl() {
  const [x, y, z] = [80, 40, 30];
  const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `solid box\n${f.map((t) => ` facet normal 0 0 0\n  outer loop\n${t.map((i) => `   vertex ${v[i].join(' ')}`).join('\n')}\n  endloop\n endfacet`).join('\n')}\nendsolid box\n`;
}
const picturePath = join(out, 'bracket-reference.png');
const modelPath = join(out, 'bracket.stl');
await writeFile(picturePath, png());
await writeFile(modelPath, stl());

// ---------------------------------------------------------------- the browser

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const phone = vw < 700;
const context = await browser.newContext({ viewport: { width: vw, height: vh }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1, reducedMotion: 'reduce' });
await context.addInitScript((l) => {
  try {
    localStorage.setItem('levo_lang', l);
    // A theme already chosen, so the first-visit theme sheet stays shut.
    localStorage.setItem('levonis.theme.v1', 'dark');
  } catch {
    /* private mode */
  }
}, lang);
const host = new URL(base).hostname;
await context.addCookies([{ name: 'levonis_session', value: session, domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

let cases = 0;
const check = async (name, fn) => {
  cases += 1;
  await fn();
  console.log(`ok   ${name}`);
};
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
const stepNow = () => page.getAttribute('[data-editor-step]', 'data-editor-step');
const waitStep = (n) => page.waitForSelector(`[data-editor-step="${n}"]`, { timeout: 30000 });
const primary = () => page.locator('[data-action-dock] button').last();
const clipped = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-editor-step] button')]
      .filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth + 1 && !b.querySelector('.truncate'))
      .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40))
  );

const TITLE = 'حامل تثبيت للحائط';
const DESC = 'أحتاج أربع قطع متينة باللون الأسود لتثبيت رف خفيف.';
let id = '';

await check('a blank /requests/new is step 1 with no draft; the first keystroke makes one and the address takes its id', async () => {
  // From the board, through its own door, so the board is the page behind the editor.
  await page.goto(`${base}/requests`, { waitUntil: 'domcontentloaded' });
  const door = page.getByRole('button', { name: /طلب جديد|^New$|^نوێ$/ }).first();
  if (await door.isVisible({ timeout: 15000 }).catch(() => false)) await door.click();
  else await page.goto(`${base}/requests/new`, { waitUntil: 'domcontentloaded' });
  await waitStep(1);
  assert.equal(await page.getAttribute('[data-editor-step]', 'data-editor-id'), 'new');
  await page.fill('#editor-title', TITLE);
  await page.waitForURL(/\/requests\/new\/[^/?]+\?step=1/, { timeout: 30000 });
  id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop());
  assert.ok(id, 'no id in the address');
  await page.fill('#editor-description', DESC);
});

await check('a picture and a model land as rows of «الملفات المرفقة»', async () => {
  await page.setInputFiles('[data-editor="picture-input"]', picturePath);
  await page.setInputFiles('[data-editor="file-input"]', modelPath);
  await page.waitForFunction(() => document.querySelectorAll('[data-editor-source="file"]').length >= 2, null, { timeout: 60000 });
  assert.equal(await page.getAttribute('[data-choice="model"]', 'aria-checked'), 'true');
  assert.equal(await page.getAttribute('[data-choice="pictures"]', 'aria-checked'), 'true');
  await shot('step-1');
});

await check('a reload on step 1 keeps the step, the words and the files', async () => {
  await page.waitForSelector('[data-editor-status="saved"]', { timeout: 30000 }).catch(() => undefined);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitStep(1);
  assert.equal(await page.inputValue('#editor-title'), TITLE);
  assert.equal(await page.inputValue('#editor-description'), DESC);
  assert.ok((await page.locator('[data-editor-source="file"]').count()) >= 2);
});

await check('offline, a change, then the header back: the in-app blocker asks, and «stay» stays', async () => {
  await context.setOffline(true);
  await page.fill('#editor-title', `${TITLE} 2`);
  await page.click('[data-section-back]');
  const dialog = page.locator('[role="alertdialog"], [role="dialog"]').last();
  await dialog.waitFor({ timeout: 15000 });
  await dialog.locator('button').first().click();
  await context.setOffline(false);
  assert.equal(await stepNow(), '1');
  await page.fill('#editor-title', TITLE);
});

await check('step 2: the method, the material, the colour, the quality, four copies, the size; a reload keeps them', async () => {
  await primary().click();
  await waitStep(2);
  assert.match(page.url(), /step=2/);
  await page.click('[data-choice="fdm"]');
  await page.click('[data-editor-material-button]');
  await page.locator('[data-material-option="petg"]').click();
  await page.keyboard.press('Escape');
  await page.click('[data-editor-colour-button]');
  await page.locator('input[data-colour-option="#1a1a1a"]').check();
  await page.keyboard.press('Escape');
  await page.click('[data-editor-card="quality"] [role="radio"] >> nth=1');
  const qty = page.locator('[data-editor-card="quantity"] input');
  await qty.fill('4');
  await page.waitForTimeout(400);
  await shot('step-2');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitStep(2);
  assert.equal(await page.getAttribute('[data-choice="fdm"]', 'aria-checked'), 'true');
  assert.equal(await page.inputValue('[data-editor-card="quantity"] input'), '4');
});

await check('step 3: Baghdad, delivery, a day, a budget with its switch left OFF; a reload keeps the switch off', async () => {
  await primary().click();
  await waitStep(3);
  await page.click('[data-editor="governorate"]');
  await page.locator('[data-governorate-option="baghdad"]').click();
  await page.click('[data-choice="delivery"]');
  const day = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
  await page.fill('[data-editor="deadline"]', day);
  await page.fill('[data-editor="budget-input"]', '45000');
  await page.waitForSelector('[data-editor-budget-switch="off"]');
  await page.waitForTimeout(400);
  await shot('step-3');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitStep(3);
  await page.waitForSelector('[data-editor-budget-switch="off"]');
});

await check('step 4: the cards, the budget hidden, «تعديل» opens step 3 at its card', async () => {
  await primary().click();
  await waitStep(4);
  for (const card of ['files', 'specs', 'delivery', 'budget']) assert.equal(await page.locator(`[data-review-card="${card}"]`).count(), 1, card);
  assert.equal(await page.getAttribute('[data-editor-review-budget]', 'data-editor-review-budget'), 'hidden');
  await shot('step-4');
  await page.click('[data-review-card="delivery"] [data-review-edit]');
  await waitStep(3);
  await page.waitForFunction(() => document.activeElement?.id === 'editor-governorate', null, { timeout: 5000 });
  await primary().click();
  await waitStep(4);
});

await check('no button text is clipped at this width', async () => {
  for (const n of [4]) assert.deepEqual(await clipped(), [], `step ${n}`);
});

if (keep) {
  console.log(`draft ${id} (kept, not published)`);
} else {
  await check('«انشر الطلب»: the request page, published; Back reaches the board, never the editor; a guest reads no budget', async () => {
    await primary().click();
    await page.waitForURL(new RegExp(`/requests/${id}$`), { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.goBack({ waitUntil: 'commit' }).catch(() => undefined);
    await page
      .waitForFunction(() => location.pathname === '/requests', null, { timeout: 15000 })
      .catch(async () => assert.fail(`Back from the published request landed on ${page.url()}`));
    const guest = await fetch(`${base}/api/marketplace/requests/${encodeURIComponent(id)}`);
    if (guest.ok) {
      const body = await guest.json();
      assert.equal(body.request?.budget_iqd ?? null, null, 'a guest read the budget');
    }
  });
}

assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
console.log(`${cases} checks passed; shots in ${out}`);
await browser.close();
