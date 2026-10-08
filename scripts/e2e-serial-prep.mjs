#!/usr/bin/env node
/**
 * «SCAN SERIAL» PRESSED AND PHOTOGRAPHED (owner brief 2026-10-07; serial spec
 * §5 and §6, critiques applied) — tests/browser/serial-prep.html through
 * Playwright, on canned answers that follow the server's contract:
 *
 *   one slot per physical unit; a USB / Bluetooth reader's burst typed into
 *   the slot's own field links with source 'scanner' and moves on to the
 *   next empty unit — but never after a BOX SN (critique-2 H1); a refusal in
 *   the reader's language under the unit, the owner's exception with a
 *   mandatory reason; the camera sheet (a real camera read through a fake
 *   device that films a label, §32.11) with its typed field; «✓ تم ربط
 *   الرقم التسلسلي»; the serial / warranty page with its history; remove;
 *   the §19 blocker, the refused move and «اذهب إلى الوحدة»; the masked
 *   serial for an assistant; the orders board chip; the owner's gate switch;
 *   the product and section policy controls, locked for everyone else.
 *
 * Arabic, English and Sorani; dark and light; 390 and 1280 px; the Sorani
 * pass is also the reduced-motion pass. Every step: no horizontal overflow,
 * no page error.
 *
 *   npx vite --port 4191 --host 127.0.0.1 &
 *   node --import tsx scripts/e2e-serial-prep.mjs
 *   (SERIAL_URL, OUT_DIR, PLAYWRIGHT_MODULE, CHROMIUM_PATH override the defaults)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { blank, code128Modules, drawModules, ean13Modules } from '../tests/fixtures/barcodeImages.ts';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SERIAL_URL || 'http://127.0.0.1:4191/tests/browser/serial-prep.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/serial-prep';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes += 1;
  else failures.push(`${name} ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : detail}`);
};

// ------------------------------------------------------- the filmed label
// A fake camera (Chromium's file capture) that films a Bambu-style label: the
// Product SN as Code 128 and the EAN-13 under it. A second one films a blank
// label, so the sheet can be photographed while it is still looking.
const SN_CAMERA = '03919D580607843';
async function y4m(path, draw) {
  const W = 640;
  const H = 480;
  const img = blank(W, H);
  draw(img);
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`);
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Buffer.from(img.data), chroma]);
  await writeFile(path, Buffer.concat([header, ...Array.from({ length: 10 }, () => frame)]));
}
const labelPath = join(out, 'label.y4m');
const blankPath = join(out, 'blank.y4m');
await y4m(labelPath, (img) => {
  // Laid out as on the box: the Product SN across the top, the EAN at the
  // bottom-left (the reader looks at the label's halves in turn).
  const sn = code128Modules(SN_CAMERA);
  drawModules(img, sn, Math.floor((640 - sn.length * 2) / 2), 150, 2, 64);
  const ean = ean13Modules('6977252425445');
  drawModules(img, ean, 140, 300, 2, 60);
});
await y4m(blankPath, (img) => {
  // A label with no code on it: grey text blocks only.
  for (const [x, y, w, h] of [[150, 160, 340, 14], [150, 190, 220, 14], [150, 260, 300, 40]]) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) img.data[yy * 640 + xx] = 200;
  }
});

const launch = (file) =>
  chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${file}`],
  });
const browsers = { blank: await launch(blankPath), label: await launch(labelPath) };

async function session(kind, { lang, theme, width, reduced = false }) {
  const phone = width < 640;
  const context = await browsers[kind].newContext({
    viewport: { width, height: phone ? 844 : 900 },
    deviceScaleFactor: 2,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    permissions: ['camera'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors };
}

const url = (q) => `${base}?${new URLSearchParams(q).toString()}`;
const sent = (page) => page.evaluate(() => window.__sent ?? []);
const lastPost = async (page, suffix) => (await sent(page)).filter((s) => s.method === 'POST' && s.path.endsWith(suffix)).at(-1);
const slot = (page, key) => page.locator(`[data-serial-slot="${key}"]`);
/** Horizontal overflow of the page and of the modal's scrolling body. */
const overflow = (page) =>
  page.evaluate(() => {
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const inner = [...document.querySelectorAll('[data-serial-slots], [data-serial-scan-sheet], [data-serial-detail], [data-serial-blocker]')].map((el) => el.scrollWidth - el.clientWidth);
    return Math.max(doc, 0, ...inner);
  });
const activeSlot = (page) => page.evaluate(() => document.activeElement?.closest('[data-serial-slot]')?.getAttribute('data-serial-slot') ?? null);

async function openOrder(page, q) {
  await page.goto(url({ scene: 'order', ...q }), { waitUntil: 'networkidle' });
  await page.locator('[data-order-modal]').waitFor({ state: 'visible', timeout: 15000 });
  if (q.tab !== 'stages') {
    await page.locator('[data-serial-slots]').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-warranty-section]').scrollIntoViewIfNeeded();
  }
  await page.waitForTimeout(300);
}
const shot = (target, name) => target.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' }).catch((e) => console.log(`(shot ${name}: ${e.message})`));

const AR_IN_USE = 'هذا الرقم التسلسلي مرتبط بطلب آخر.';
const LINKED = { ar: 'تم ربط الرقم التسلسلي', en: 'Serial linked', ckb: 'ژمارەی زنجیرەیی بەسترا' };
const PASSES = [
  { lang: 'ar', theme: 'dark', width: 390, full: true },
  { lang: 'en', theme: 'light', width: 390, full: true },
  { lang: 'ckb', theme: 'dark', width: 390, full: false, reduced: true },
  { lang: 'ar', theme: 'light', width: 1280, full: false },
];

for (const pass of PASSES) {
  const tag = `${pass.lang}-${pass.theme}-${pass.width}`;
  const L = { lang: pass.lang, theme: pass.theme };

  // ------------------------------------------- the slots, partly linked (§21)
  {
    const { context, page, errors } = await session('blank', pass);
    await openOrder(page, { ...L, state: 'partial' });
    const states = await page.locator('[data-serial-slot]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-serial-slot')}=${e.getAttribute('data-serial-state')}`));
    check(`${tag}: one slot per physical unit (A1 ×2 + AMS ×1, the filament none)`, states.join(' ') === 'oi_a1:1=linked oi_a1:2=empty oi_ams:1=linked', states.join(' '));
    check(`${tag}: «✓ ${LINKED[pass.lang]}» on a linked unit`, (await slot(page, 'oi_a1:1').innerText()).includes(LINKED[pass.lang]));
    check(`${tag}: the empty unit is ONE control — a form with the reader field and the camera inside`, (await slot(page, 'oi_a1:2').locator('form[data-serial-form] input[data-serial-input]').count()) === 1 && (await slot(page, 'oi_a1:2').locator('[data-serial-camera]').count()) === 1);
    check(`${tag}: the line cards carry «n/m»`, (await page.locator('[data-serial-chip="oi_a1"]').innerText()).includes('1/2'));
    check(`${tag}: no horizontal overflow`, (await overflow(page)) <= 1, String(await overflow(page)));
    await shot(page.locator('[data-warranty-section]'), `01-slots-${tag}`);
    if (pass.full) await shot(page, `01b-order-window-${tag}`);
    check(`${tag}: no page error (slots)`, errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ----------------------- a USB reader's burst, then the box-SN rule (§4, H1)
  {
    const { context, page, errors } = await session('blank', pass);
    await openOrder(page, { ...L, state: 'fresh' });
    await slot(page, 'oi_a1:1').locator('input[data-serial-input]').focus();
    await page.keyboard.type('03919D580607841', { delay: 8 });
    await page.keyboard.press('Enter');
    await slot(page, 'oi_a1:1').locator('[data-serial-value]').waitFor({ timeout: 8000 });
    const p = await lastPost(page, '/serials/scan');
    check(`${tag}: a reader's burst links with source 'scanner'`, p?.body?.source === 'scanner' && p?.body?.code === '03919D580607841', JSON.stringify(p?.body));
    await page.waitForTimeout(150);
    check(`${tag}: …and the cursor moves on to Unit 2`, (await activeSlot(page)) === 'oi_a1:2', String(await activeSlot(page)));

    await page.keyboard.type('B07119G5811000AB', { delay: 8 });
    await page.keyboard.press('Enter');
    await slot(page, 'oi_a1:2').locator('[data-serial-error]').waitFor({ timeout: 8000 });
    check(`${tag}: a BOX SN alone is refused (BOX_ONLY) in words`, (await slot(page, 'oi_a1:2').getAttribute('data-serial-state')) === 'empty' && (await slot(page, 'oi_a1:2').locator('[data-serial-error="SERIAL_INVALID"]').count()) === 1);
    check(`${tag}: …and the cursor stays on that unit (H1)`, (await activeSlot(page)) === 'oi_a1:2', String(await activeSlot(page)));
    await shot(slot(page, 'oi_a1:2'), `02-box-sn-refused-${tag}`);

    await page.keyboard.type('03919D580607841', { delay: 8 });
    await page.keyboard.press('Enter');
    await slot(page, 'oi_a1:2').locator('[data-serial-error="SERIAL_IN_USE_THIS_ORDER"]').waitFor({ timeout: 8000 });
    check(`${tag}: the same serial twice in one order is refused (§18)`, true);

    // A person typing slowly, with the separators a label prints: the server normalises.
    await page.keyboard.press('Control+A');
    await page.keyboard.type('0391-9d58 0607842', { delay: 90 });
    await page.keyboard.press('Enter');
    await slot(page, 'oi_a1:2').locator('[data-serial-value]').waitFor({ timeout: 8000 });
    const typed = await lastPost(page, '/serials/scan');
    check(`${tag}: typed by hand → source 'manual' (§13)`, typed?.body?.source === 'manual', JSON.stringify(typed?.body));
    await page.waitForTimeout(150);
    check(`${tag}: …and on to the AMS unit`, (await activeSlot(page)) === 'oi_ams:1', String(await activeSlot(page)));
    check(`${tag}: no page error (wedge)`, errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // --------------- a refusal, the owner's exception, the sheet (§10, §11, §22)
  {
    const { context, page, errors } = await session('blank', pass);
    await openOrder(page, { ...L, state: 'fresh', owner: '1' });
    await slot(page, 'oi_a1:1').locator('input[data-serial-input]').fill('03919D580600001');
    await slot(page, 'oi_a1:1').locator('[data-serial-link]').click();
    await slot(page, 'oi_a1:1').locator('[data-serial-error="SERIAL_IN_USE"]').waitFor({ timeout: 8000 });
    if (pass.lang === 'ar') check(`${tag}: §31 «${AR_IN_USE}»`, (await slot(page, 'oi_a1:1').innerText()).includes(AR_IN_USE));
    const over = slot(page, 'oi_a1:1').locator('[data-serial-owner-override="take_from_order"]');
    check(`${tag}: the owner is offered the matching exception`, (await over.count()) === 1);
    await shot(slot(page, 'oi_a1:1'), `03-refusal-inline-${tag}`);
    await over.click();
    const sheet = page.locator('[data-overlay="serial-prep-scan"]');
    await sheet.locator('[data-serial-refusal="SERIAL_IN_USE"]').waitFor({ timeout: 8000 });
    check(`${tag}: §10 the other order is named to the owner`, (await sheet.locator('[data-serial-other-order]').innerText()).includes('ORD-2026-0139'));
    await sheet.locator('[data-serial-owner-override]').click();
    await sheet.locator('textarea').fill(pass.lang === 'en' ? 'Customer swapped orders' : 'الزبون بدّل الطلبين');
    await page.waitForTimeout(250);
    await shot(sheet, `04-sheet-owner-override-${tag}`);
    await sheet.locator('[data-serial-override-submit]').click();
    await slot(page, 'oi_a1:1').locator('[data-serial-value]').waitFor({ timeout: 8000 });
    const ov = await lastPost(page, '/serials/override');
    check(`${tag}: the exception carries its kind and reason`, ov?.body?.kind === 'take_from_order' && String(ov?.body?.reason ?? '').length >= 5, JSON.stringify(ov?.body));
    check(`${tag}: the linked unit is badged as the owner's exception`, (await slot(page, 'oi_a1:1').innerText()).length > 0 && (await slot(page, 'oi_a1:1').locator('[data-serial-chips]').innerText()).length > 0);
    check(`${tag}: no page error (exception)`, errors.length === 0, errors.join(' | '));
    await context.close();
  }
  {
    // A staff member gets the refusal and no exception.
    const { context, page } = await session('blank', pass);
    await openOrder(page, { ...L, state: 'fresh', owner: '0' });
    await slot(page, 'oi_a1:1').locator('input[data-serial-input]').fill('03919D580600002');
    await slot(page, 'oi_a1:1').locator('[data-serial-link]').click();
    await slot(page, 'oi_a1:1').locator('[data-serial-error="SERIAL_DELIVERED"]').waitFor({ timeout: 8000 });
    check(`${tag}: staff see §11 and no owner exception`, (await slot(page, 'oi_a1:1').locator('[data-serial-owner-override]').count()) === 0);
    if (pass.lang === 'ar') check(`${tag}: §11 «…ومربوط بضمان فعال.»`, (await slot(page, 'oi_a1:1').innerText()).includes('هذا الجهاز تم تسليمه مسبقاً ومربوط بضمان فعال.'));
    await context.close();
  }

  // ------------------- the camera sheet: looking, then typed, then success (§3, §22)
  {
    const { context, page, errors } = await session('blank', pass);
    await openOrder(page, { ...L, state: 'partial' });
    await slot(page, 'oi_a1:2').locator('[data-serial-camera]').click();
    const sheet = page.locator('[data-overlay="serial-prep-scan"]');
    await sheet.locator('[data-serial-scan-sheet]').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1600);
    check(`${tag}: the camera sheet is a bottom sheet over the order window`, (await sheet.count()) === 1);
    check(`${tag}: «use a reader or keyboard» is offered`, (await sheet.locator('[data-serial-use-reader]').count()) === 1);
    await shot(page, `05-camera-sheet-${tag}`);
    await sheet.locator('[data-serial-use-reader]').click();
    const field = sheet.locator('input:focus');
    check(`${tag}: …and puts the cursor in the typed field`, (await field.count()) === 1);
    await page.keyboard.type('03919D580600003', { delay: 70 });
    await page.keyboard.press('Enter');
    await sheet.locator('[data-serial-verdict="done"]').waitFor({ timeout: 8000 });
    const lines = await sheet.locator('[data-serial-verdict="done"] [data-serial-existing-line]').count();
    check(`${tag}: §13 an existing device reads as two ticked lines`, lines === 2, String(lines));
    await shot(sheet, `06-sheet-existing-success-${tag}`);
    await sheet.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    check(`${tag}: the sheet closes itself after a success`, (await page.locator('[data-overlay="serial-prep-scan"]').count()) === 0);
    check(`${tag}: …and the unit shows linked`, (await slot(page, 'oi_a1:2').getAttribute('data-serial-state')) === 'linked');
    check(`${tag}: no page error (sheet)`, errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ------------------------------------- the camera itself reads the label (§32.11)
  if (pass.width < 640) {
    const { context, page, errors } = await session('label', pass);
    await openOrder(page, { ...L, state: 'fresh' });
    await slot(page, 'oi_a1:1').locator('[data-serial-camera]').click();
    const ok = await slot(page, 'oi_a1:1').locator('[data-serial-value]').waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    const p = await lastPost(page, '/serials/scan');
    check(`${tag}: the camera read the label and linked it (source 'camera')`, ok && p?.body?.source === 'camera' && p?.body?.code === SN_CAMERA, JSON.stringify(p?.body));
    check(`${tag}: …with the label's EAN alongside (critique-2 L2)`, p?.body?.ean === '6977252425445', JSON.stringify(p?.body));
    check(`${tag}: the camera stops — one read, one request`, (await sent(page)).filter((s) => s.path.endsWith('/serials/scan')).length === 1);
    check(`${tag}: no page error (camera)`, errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ------------------------------------ the serial page and remove (§16, §20)
  {
    const { context, page, errors } = await session('blank', pass);
    await openOrder(page, { ...L, state: 'partial', owner: pass.full ? '1' : '0', scope: pass.full ? 'full' : 'assistant' });
    const value = slot(page, 'oi_a1:1').locator('[data-serial-value]');
    const text = await value.innerText();
    check(`${tag}: the serial is ${pass.full ? 'whole' : 'masked'} for this viewer`, pass.full ? text.includes('03919D580607841') : text.includes('****7841') && !text.includes('03919D58'), text);
    if (pass.full) {
      await value.click();
      const page2 = page.locator('[data-serial-detail]');
      await page2.locator('[data-serial-detail-value]').waitFor({ timeout: 8000 });
      await page.waitForTimeout(500);
      const events = await page2.locator('[data-serial-event]').count();
      check(`${tag}: the serial page shows the history, newest first`, events >= 3, String(events));
      check(`${tag}: …with the reserved status`, (await page2.locator('[data-serial-detail-status="reserved"]').count()) === 1);
      await shot(page, `07-serial-page-${tag}`);
      await page2.locator('[data-serial-timeline]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot(page, `07b-serial-history-${tag}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    } else {
      await shot(page.locator('[data-warranty-section]'), `07-masked-${tag}`);
    }
    await slot(page, 'oi_a1:1').locator('[data-serial-remove]').click();
    const confirm = page.locator('[data-confirm-action]');
    await confirm.waitFor({ timeout: 5000 });
    await page.waitForTimeout(250);
    await shot(page, `08-remove-confirm-${tag}`);
    await confirm.click();
    await page.waitForFunction(() => document.querySelector('[data-serial-slot="oi_a1:1"]')?.getAttribute('data-serial-state') === 'empty', null, { timeout: 8000 });
    const un = await lastPost(page, '/serials/unlink');
    check(`${tag}: remove releases the link by its id (§20)`, typeof un?.body?.assignment_id === 'string');
    check(`${tag}: no page error (page/remove)`, errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ------------------------------- the gate: blocker, refused move, «go to unit» (§19)
  {
    const { context, page, errors } = await session('blank', pass);
    await openOrder(page, { ...L, state: 'partial', gate: '1', owner: pass.full ? '1' : '0', tab: 'stages' });
    await page.locator('[data-order-tab="stages"]').click();
    const blocker = page.locator('[data-serial-blocker]');
    await blocker.waitFor({ timeout: 8000 });
    if (pass.lang === 'ar') check(`${tag}: §19 «تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.»`, (await blocker.innerText()).includes('تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.'));
    check(`${tag}: the blocker names the missing unit`, (await blocker.locator('[data-serial-goto]').count()) === 1);
    await shot(blocker, `09-blocker-${tag}`);
    const move = page.locator('[data-order-stages] button', { hasText: pass.lang === 'en' ? 'On the way to you' : pass.lang === 'ckb' ? 'لە ڕێگەیە بۆ لات' : 'في الطريق إليك' }).first();
    await move.click();
    const refusal = page.locator('[data-serial-gate-refusal]');
    await refusal.waitFor({ timeout: 8000 });
    check(`${tag}: the refused move says the units are listed above`, (await refusal.locator('[data-serial-gate-listed-above]').count()) === 1);
    check(`${tag}: the owner may proceed with a reason — and only the owner`, (await refusal.locator('[data-serial-gate-override]').count()) === (pass.full ? 1 : 0));
    await shot(page, `10-gate-refusal-${tag}`);
    await blocker.locator('[data-serial-goto]').click();
    await page.waitForTimeout(900);
    check(`${tag}: «go to unit» opens the order tab on that unit`, (await activeSlot(page)) === 'oi_a1:2', String(await activeSlot(page)));
    check(`${tag}: no page error (gate)`, errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ------------------------- past preparation: staff read only, the owner's exception
  if (pass.width < 640 && pass.lang !== 'en') {
    for (const owner of ['0', '1']) {
      const { context, page, errors } = await session('blank', pass);
      await openOrder(page, { ...L, state: 'partial', shipped: '1', owner });
      const field = slot(page, 'oi_a1:2').locator('input[data-serial-input]');
      check(`${tag}: past preparation, ${owner === '1' ? 'the owner may still try' : 'staff have no field'}`, (await field.count()) === (owner === '1' ? 1 : 0));
      if (owner === '1') {
        await field.fill('03919D580607842');
        await slot(page, 'oi_a1:2').locator('[data-serial-link]').click();
        await slot(page, 'oi_a1:2').locator('[data-serial-owner-override="outside_window"]').waitFor({ timeout: 8000 });
        check(`${tag}: …and the refusal offers the «outside the window» exception`, true);
        await shot(page.locator('[data-warranty-section]'), `11b-owner-outside-window-${tag}`);
      }
      check(`${tag}: no page error (past preparation, owner=${owner})`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  }

  // ------------------------------------------------------ re-open (§30)
  if (pass.width < 640) {
    const { context, page } = await session('blank', pass);
    await openOrder(page, { ...L, state: 'reopen' });
    check(`${tag}: a re-opened order suggests the free previous serial`, (await slot(page, 'oi_a1:1').locator('[data-serial-relink]').count()) === 1);
    check(`${tag}: …and only says so for one that was taken since`, (await slot(page, 'oi_a1:2').locator('[data-serial-relink]').count()) === 0 && (await slot(page, 'oi_a1:2').locator('[data-serial-previous]').count()) === 1);
    await shot(page.locator('[data-warranty-section]'), `11-reopen-${tag}`);
    await slot(page, 'oi_a1:1').locator('[data-serial-relink]').click();
    await slot(page, 'oi_a1:1').locator('[data-serial-value]').waitFor({ timeout: 8000 });
    check(`${tag}: relink goes through the normal scan (source 'relink')`, (await lastPost(page, '/serials/scan'))?.body?.source === 'relink');
    await context.close();
  }

  // -------------------------------------------- board, gate card, policy, AMS page
  if (pass.width < 640 || pass.lang === 'ar') {
    const { context, page, errors } = await session('blank', pass);
    await page.goto(url({ ...L, scene: 'board', gate: '1' }), { waitUntil: 'networkidle' });
    await page.locator('[data-serial-board-chip]').first().waitFor({ timeout: 8000 });
    const chips = await page.locator('[data-serial-board-chip]').evaluateAll((els) => els.map((e) => e.getAttribute('data-serial-board-chip')));
    check(`${tag}: board chips — held, complete; none for a filament order`, chips.join(',') === 'held,complete', chips.join(','));
    check(`${tag}: a held order offers no one-tap move`, (await page.locator('[data-order-card="ORD-2026-0142"] [data-action="quick-advance"]').count()) === 0 && (await page.locator('[data-order-card="ORD-2026-0143"] [data-action="quick-advance"]').count()) === 1);
    await shot(page, `12-board-${tag}`);

    for (const owner of ['1', '0']) {
      await page.goto(url({ ...L, scene: 'gate', owner }), { waitUntil: 'networkidle' });
      await page.locator('[data-serial-gate-card]').waitFor({ timeout: 8000 });
      check(`${tag}: the gate switch is ${owner === '1' ? 'the owner\'s' : 'locked for staff'}`, (await page.locator('[data-serial-gate-card] [role="switch"]').isDisabled()) === (owner === '0'));
      await shot(page.locator('[data-serial-gate-card]'), `13-gate-card-${owner === '1' ? 'owner' : 'staff'}-${tag}`);
    }

    for (const owner of ['1', '0']) {
      await page.goto(url({ ...L, scene: 'policy', owner }), { waitUntil: 'networkidle' });
      await page.locator('[data-form="serial-tracking"]').waitFor({ timeout: 8000 });
      const effective = await page.locator('[data-form="serial-tracking"]').getAttribute('data-serial-effective');
      check(`${tag}: an AMS product under a «required» section needs a serial`, effective === 'required');
      check(`${tag}: product policy ${owner === '1' ? 'editable by the owner' : 'locked for staff'}`, (await page.locator('[data-form="serial-tracking"] [data-serial-policy-locked]').count()) === (owner === '1' ? 0 : 1));
      await shot(page.locator('[data-policy-product="ams"]'), `14-product-policy-${owner === '1' ? 'owner' : 'staff'}-${tag}`);
      check(`${tag}: the section list badges a «required» section`, (await page.locator('[data-tax-row="ct_ams"] [data-tax-serial-policy="required"]').count()) === 1);
      // The section editor: the three-way control for the owner, the answer with a lock for staff.
      await page.locator('[data-tax-row="ct_ams"] [data-tax-action="edit"]').click();
      const editor = page.locator('[data-tax-serial-policy-editor]');
      await editor.waitFor({ timeout: 5000 });
      check(`${tag}: section policy ${owner === '1' ? 'is a three-way choice for the owner' : 'is read-only for staff'}`, (await editor.locator('[role="radio"]').count()) === (owner === '1' ? 3 : 0), String(await editor.locator('[role="radio"]').count()));
      check(`${tag}: the printer flag is ${owner === '1' ? 'the owner\'s' : 'locked for staff'}`, (await page.locator('#sec-printer').isDisabled()) === (owner === '0'));
      await page.waitForTimeout(300);
      await shot(editor, `15-section-policy-${owner === '1' ? 'owner' : 'staff'}-${tag}`);
    }

    // A returned AMS sold again: the owner's resale warranty control (§14).
    await page.goto(url({ ...L, scene: 'detail', state: 'partial', serial: '00N00A2B1234567', owner: '1' }), { waitUntil: 'networkidle' });
    await page.locator('[data-serial-detail-value]').waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    check(`${tag}: a resold returned device offers the owner «continue / restart»`, (await page.locator('[data-serial-resale] [role="radiogroup"], [data-serial-resale] form').count()) >= 1);
    await shot(page, `16-serial-page-resale-${tag}`);
    check(`${tag}: no page error (board/gate/policy/page)`, errors.length === 0, errors.join(' | '));
    await context.close();
  }
}

await browsers.blank.close();
await browsers.label.close();
console.log(`\n${passes} passed, ${failures.length} failed — shots in ${out}`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
