#!/usr/bin/env node
/**
 * CLIENT 5d, PRESSED AND PHOTOGRAPHED — tests/browser/order-timeline.html
 * through Playwright (docs/COMMUNITY_ECOSYSTEM.md §9.5):
 *
 *   the workshop's custom order: the list row opens the order's screen (and a
 *   notification's address opens it at once); the header carries the total
 *   with its fee and the customer; the spine draws the record; a progress
 *   update, «جاهز» (asked first — the mark and the chip follow, nothing
 *   else moves), a photo through the upload session (the key goes in the
 *   body, the page shows the authorised route — never a key in any href or
 *   src), «ابدأ العمل», «سلّمت العمل» (asked first), cancel and dispute
 *   exactly per the server's policy;
 *   the customer's order: the row's «تابع التنفيذ» opens the timeline in a
 *   sheet with detents; «اطلب تعديلًا» before delivery, never after;
 *   «ملف الورشة»: the derived facts are text with doors, the save sends every
 *   filter back with the two edited fields and never the derived pair;
 *   the storefront: the facts row (one line, the height its frame held) under
 *   every hero variant, the two figures on the stats block, nothing at all
 *   for a store without facts.
 *
 * In Arabic, English and Sorani, dark and cream, at 360 and 1280 px; the
 * Sorani pass is also the reduced-motion pass. Every step: no horizontal
 * overflow, no page error.
 *
 *   (the dev server on :4191)   node scripts/e2e-order-timeline.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TIMELINE_URL || 'http://127.0.0.1:4191/tests/browser/order-timeline.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/order-timeline';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes += 1;
  else failures.push(`${name} ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : detail}`);
};

/** The photo route answers a small picture, since there is no worker. */
const PHOTO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#d9d2c3"/><rect x="120" y="70" width="160" height="260" rx="24" fill="#6c7a4a"/><circle cx="200" cy="130" r="22" fill="#2b2b2b"/></svg>';
/** A real PNG the file input takes (1×1). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ORDERS_TAB = { ar: 'تنفيذ طلباتي', en: 'My custom orders', ckb: 'داواکاریە تایبەتەکانم' };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function session(lang, theme, width) {
  const phone = width < 640;
  const context = await browser.newContext({
    viewport: { width, height: phone ? 800 : 900 },
    deviceScaleFactor: 2,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
    reducedMotion: lang === 'ckb' ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/marketplace/orders/*/updates/*/file', (route) => route.fulfill({ contentType: 'image/svg+xml', body: PHOTO }));
  return { context, page, errors };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const kinds = (page) => page.locator('[data-timeline-kind]').evaluateAll((els) => els.map((el) => el.getAttribute('data-timeline-kind')));
/**
 * A figure's digits whatever script the page writes them in: `<Money>` uses the reader's locale (review
 * 2026-09-30: one way to write a dinar amount everywhere), so an Arabic page shows «٥٥٬٠٠٠ د.ع».
 */
const digits = (text) => text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) & 0xf)).replace(/\D/g, '');
/** Every href and src on the page that could carry a storage key. */
const keyLeaks = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[href], [src]')]
      .map((el) => el.getAttribute('href') || el.getAttribute('src') || '')
      .filter((v) => /community-orders\/|merchants\/[^/]+\/|\/files\/community-orders/.test(v))
  );
const sent = (page) => page.evaluate(() => window.__sent ?? []);
/** Confirm the app's own dialog: its primary button, whatever the language. */
async function confirmDialog(page) {
  const dialog = page.locator('[role="alertdialog"], [role="dialog"]').last();
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(250);
  const buttons = dialog.locator('button');
  // The confirm is the dialog's last button (cancel first, the verb after it).
  await buttons.last().click();
}

for (const lang of ['ar', 'en', 'ckb']) {
  for (const theme of ['dark', 'light']) {
    for (const width of [360, 1280]) {
      if (lang === 'ckb' && (theme === 'light' || width === 1280)) continue; // Sorani: one representative pass (reduced motion)
      const tag = `${lang}-${theme}-${width}`;
      const full = theme === 'dark';

      // ------------------------------------------------ the workshop's custom order
      {
        const { context, page, errors } = await session(lang, theme, width);
        const name = `${tag} merchant`;
        await page.goto(`${base}?scene=merchant&state=in_progress&lang=${lang}&theme=${theme}`, { waitUntil: 'networkidle' });
        const row = await page.waitForSelector('[data-custom-order="cord_1"]', { timeout: 10000 }).then(() => true).catch(() => false);
        check(`${name}: the list shows the order as a row`, row);
        check(`${name}: the row is one button (no nested controls)`, (await page.locator('[data-custom-order="cord_1"] button, [data-custom-order="cord_1"] a').count()) === 0);
        if (full) await page.screenshot({ path: `${out}/merchant-list-${tag}.png`, fullPage: true });
        await page.locator('[data-custom-order="cord_1"]').click();
        const screen = await page.waitForSelector('[data-custom-order-screen="cord_1"] [data-order-timeline]', { timeout: 10000 }).then(() => true).catch(() => false);
        check(`${name}: the row opens the order's screen with its timeline`, screen);
        await page.waitForTimeout(400);
        check(`${name}: the total, the fee and the customer are in the header`, digits(await page.locator('[data-custom-order-total]').innerText()).includes('55000') && (await page.locator('[data-custom-order-fee]').count()) === 1 && (await page.locator('[data-custom-order-customer]').count()) === 1);
        check(`${name}: the spine draws the record in order`, (await kinds(page)).join(',') === 'created,funded,started,progress,modification_request,photo', (await kinds(page)).join(','));
        const photoSrc = await page.locator('[data-timeline-kind="photo"] img').first().getAttribute('src');
        check(`${name}: the photo is the authorised route`, photoSrc === '/api/marketplace/orders/cord_1/updates/u_ph1/file', String(photoSrc));
        check(`${name}: «سلّمت العمل» while in progress; no «ابدأ العمل»`, (await page.locator('[data-custom-order-deliver]').count()) === 1 && (await page.locator('[data-custom-order-start]').count()) === 0);
        check(`${name}: in progress the policy is dispute, not cancel`, (await page.locator('[data-timeline-dispute]').count()) === 1 && (await page.locator('[data-timeline-cancel]').count()) === 0);
        check(`${name}: no horizontal overflow on the screen`, (await overflow(page)) <= 0, `overflow=${await overflow(page)}`);
        await page.screenshot({ path: `${out}/merchant-screen-${tag}.png`, fullPage: true });

        // A progress update.
        const before = (await kinds(page)).length;
        await page.locator('[data-timeline-text]').fill(lang === 'en' ? 'Joints printed, assembling now.' : 'طُبعت المفاصل، والتجميع الآن.');
        await page.locator('[data-timeline-send]').click();
        const grew = await page.waitForFunction((n) => document.querySelectorAll('[data-timeline-kind]').length > n, before, { timeout: 8000 }).then(() => true).catch(() => false);
        check(`${name}: a progress update lands on the spine`, grew && (await kinds(page)).at(-1) === 'progress');
        const lastPost = (await sent(page)).filter((s) => s.path.endsWith('/updates')).at(-1);
        check(`${name}: it was sent as progress with its words`, lastPost?.body?.kind === 'progress' && typeof lastPost?.body?.body === 'string' && lastPost.body.body.length > 5);
        check(`${name}: the box empties after sending`, (await page.locator('[data-timeline-text]').inputValue()) === '');
        // Review 2026-09-30: the send button disables itself while sending — focus comes back to the box, never <body>.
        const kept = await page.waitForFunction(() => document.activeElement?.hasAttribute('data-timeline-text'), null, { timeout: 3000 }).then(() => true).catch(() => false);
        check(`${name}: the box keeps the focus for the next update`, kept);

        if (full) {
          // A photo: the upload session hands the key back, the key goes in the body, the page shows the route.
          await page.locator('[data-timeline-photo-input]').setInputFiles({ name: 'clamp.png', mimeType: 'image/png', buffer: PNG });
          const photo = await page.waitForFunction(() => [...document.querySelectorAll('[data-timeline-kind="photo"] img')].length >= 2, null, { timeout: 15000 }).then(() => true).catch(() => false);
          check(`${name}: a photo goes up and lands as a thumbnail`, photo);
          const photoPost = (await sent(page)).filter((s) => s.path.endsWith('/updates') && s.body?.kind === 'photo').at(-1);
          check(`${name}: the photo's key went in the update's body`, typeof photoPost?.body?.file_key === 'string' && photoPost.body.file_key.startsWith('community-orders/cord_1/updates/'));
          check(`${name}: the session was opened for purpose order_update on this order`, (await sent(page)).some((s) => s.path === '/api/uploads/sessions' && s.body?.purpose === 'order_update' && s.body?.entity_id === 'cord_1'));
          const srcs = await page.locator('[data-timeline-kind="photo"] img').evaluateAll((els) => els.map((el) => el.getAttribute('src')));
          check(`${name}: every photo is the route, never a key`, srcs.every((s) => /^\/api\/marketplace\/orders\/cord_1\/updates\/[a-z0-9_]+\/file$/.test(s ?? '')), srcs.join(' '));
          check(`${name}: no key in any href or src on the page`, (await keyLeaks(page)).length === 0, JSON.stringify(await keyLeaks(page)));
        }

        // «جاهز»: asked first; the mark and the chip follow; the state does not move.
        await page.locator('[data-timeline-ready-button]').click();
        await confirmDialog(page);
        const ready = await page.waitForSelector('[data-timeline-kind="ready"] [data-timeline-ready]', { timeout: 8000 }).then(() => true).catch(() => false);
        check(`${name}: «جاهز» is asked, then marked on the spine`, ready);
        const chip = await page.waitForSelector('[data-custom-order-ready]', { timeout: 8000 }).then(() => true).catch(() => false);
        check(`${name}: the header says ready — and the order is still in progress`, chip && (await page.locator('[data-custom-order-screen]').getAttribute('data-custom-order-state')) === 'in_progress');
        check(`${name}: «جاهز» is offered once`, (await page.locator('[data-timeline-ready-button]').count()) === 0);
        await page.locator('[data-custom-order-screen]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${out}/merchant-ready-${tag}.png`, fullPage: true });

        // «سلّمت العمل»: asked first; the order waits for the customer.
        await page.locator('[data-custom-order-deliver]').click();
        await confirmDialog(page);
        const delivered = await page.waitForSelector('[data-custom-order-state="merchant_marked_delivered"]', { timeout: 8000 }).then(() => true).catch(() => false);
        check(`${name}: «سلّمت العمل» moves the order to the customer's confirmation`, delivered);
        await page.waitForTimeout(600);
        check(`${name}: the spine gains «سُلِّم العمل»`, (await kinds(page)).includes('delivered'));
        check(`${name}: nothing more to deliver`, (await page.locator('[data-custom-order-deliver]').count()) === 0);
        check(`${name}: no horizontal overflow after the moves`, (await overflow(page)) <= 0, `overflow=${await overflow(page)}`);

        // «رجوع» returns to the list.
        await page.locator('[data-custom-order-back]').click();
        check(`${name}: «رجوع» returns to the list`, await page.waitForSelector('[data-custom-order="cord_1"]', { timeout: 5000 }).then(() => true).catch(() => false));
        check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
        await context.close();
      }

      // ------------------------------------------------ a funded order, opened by its address
      if (full) {
        const { context, page, errors } = await session(lang, theme, width);
        const name = `${tag} merchant-funded`;
        await page.goto(`${base}?scene=merchant&state=funded&open=1&lang=${lang}&theme=${theme}`, { waitUntil: 'networkidle' });
        const opened = await page.waitForSelector('[data-custom-order-screen="cord_1"] [data-custom-order-start]', { timeout: 10000 }).then(() => true).catch(() => false);
        check(`${name}: the address opens the order's screen at once, with «ابدأ العمل»`, opened);
        check(`${name}: funded: cancel AND dispute per the policy`, (await page.locator('[data-timeline-cancel]').count()) === 1 && (await page.locator('[data-timeline-dispute]').count()) === 1);
        check(`${name}: nothing to write before the work starts but the record`, (await page.locator('[data-timeline-ready-button]').count()) === 0);
        await page.locator('[data-custom-order-start]').click();
        const started = await page.waitForFunction(() => [...document.querySelectorAll('[data-timeline-kind]')].some((el) => el.getAttribute('data-timeline-kind') === 'started'), null, { timeout: 8000 }).then(() => true).catch(() => false);
        check(`${name}: «ابدأ العمل» lands on the spine`, started);
        check(`${name}: and the policy follows — no cancel once started`, await page.waitForFunction(() => !document.querySelector('[data-timeline-cancel]'), null, { timeout: 5000 }).then(() => true).catch(() => false));
        await page.screenshot({ path: `${out}/merchant-started-${tag}.png`, fullPage: true });
        // Dispute: the form asks for words, ten at least.
        await page.locator('[data-timeline-dispute]').click();
        const send = page.locator('[data-timeline-dispute-send]');
        check(`${name}: the dispute cannot be sent empty`, await send.isDisabled());
        await page.locator('[data-timeline-dispute-form] textarea').fill(lang === 'en' ? 'The customer asks for a change that was not agreed.' : 'الزبون يطلب تغييرًا لم نتفق عليه.');
        await send.click();
        check(`${name}: a dispute is filed`, await page.waitForSelector('[data-custom-order-state="disputed"]', { timeout: 8000 }).then(() => true).catch(() => false));
        check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
        await context.close();
      }

      // ------------------------------------------------ the customer's order
      {
        const { context, page, errors } = await session(lang, theme, width);
        const name = `${tag} customer`;
        await page.goto(`${base}?scene=customer&state=in_progress&lang=${lang}&theme=${theme}`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: ORDERS_TAB[lang], exact: true }).click();
        const rowDoor = await page.waitForSelector('[data-community-order-timeline="cord_1"]', { timeout: 10000 }).then(() => true).catch(() => false);
        check(`${name}: the order's row offers its timeline`, rowDoor);
        await page.locator('[data-community-order-timeline="cord_1"]').click();
        const sheet = await page.waitForSelector('[data-overlay="community-order-timeline"] [data-order-timeline]', { timeout: 10000 }).then(() => true).catch(() => false);
        check(`${name}: it opens in a sheet with the record`, sheet);
        await page.waitForTimeout(600);
        check(`${name}: the customer reads the workshop's rows as the workshop, their own as «أنت»`, (await page.locator('[data-timeline-actor="merchant"]').count()) >= 2);
        check(`${name}: no composer for the customer`, (await page.locator('[data-overlay="community-order-timeline"] [data-timeline-composer]').count()) === 0);
        check(`${name}: «اطلب تعديلًا» before delivery`, (await page.locator('[data-timeline-ask-change]').count()) === 1);
        check(`${name}: the row keeps its own cancel / dispute — none drawn twice in the sheet`, (await page.locator('[data-overlay="community-order-timeline"] [data-timeline-actions]').count()) === 0);
        check(`${name}: no horizontal overflow with the sheet`, (await overflow(page)) <= 0, `overflow=${await overflow(page)}`);
        await page.screenshot({ path: `${out}/customer-sheet-${tag}.png`, fullPage: false });
        await page.locator('[data-timeline-ask-change]').click();
        await page.locator('[data-timeline-change-form] textarea').fill(lang === 'en' ? 'Please make the clamp open to 45 mm.' : 'رجاءً اجعل المشبك يفتح حتى 45 مم.');
        await page.locator('[data-timeline-change-send]').click();
        const asked = await page.waitForFunction(() => [...document.querySelectorAll('[data-timeline-kind="modification_request"]')].length >= 2, null, { timeout: 8000 }).then(() => true).catch(() => false);
        check(`${name}: the change request lands on the spine`, asked);
        check(`${name}: it was sent as modification_request`, (await sent(page)).some((s) => s.path.endsWith('/updates') && s.body?.kind === 'modification_request'));
        await page.screenshot({ path: `${out}/customer-asked-${tag}.png`, fullPage: false });
        await page.keyboard.press('Escape');
        check(`${name}: Escape closes the sheet`, await page.waitForSelector('[data-overlay="community-order-timeline"]', { state: 'detached', timeout: 5000 }).then(() => true).catch(() => false));
        check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
        await context.close();
      }
      if (full) {
        const { context, page, errors } = await session(lang, theme, width);
        const name = `${tag} customer-delivered`;
        await page.goto(`${base}?scene=customer&state=merchant_marked_delivered&lang=${lang}&theme=${theme}`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: ORDERS_TAB[lang], exact: true }).click();
        await page.waitForSelector('[data-community-order-timeline="cord_1"]', { timeout: 10000 });
        check(`${name}: after delivery the row asks for the confirmation`, (await page.locator('[data-community-order-confirm="cord_1"]').count()) === 1);
        await page.locator('[data-community-order-timeline="cord_1"]').click();
        await page.waitForSelector('[data-overlay="community-order-timeline"] [data-order-timeline]', { timeout: 10000 });
        await page.waitForTimeout(500);
        check(`${name}: the record shows the delivery and the «جاهز» mark`, (await kinds(page)).includes('delivered') && (await page.locator('[data-timeline-ready]').count()) === 1);
        check(`${name}: no «اطلب تعديلًا» after delivery`, (await page.locator('[data-timeline-ask-change]').count()) === 0);
        await page.screenshot({ path: `${out}/customer-delivered-${tag}.png`, fullPage: false });
        check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
        await context.close();
      }

      // ------------------------------------------------ «ملف الورشة»
      {
        const { context, page, errors } = await session(lang, theme, width);
        const name = `${tag} workshop`;
        await page.goto(`${base}?scene=workshop&lang=${lang}&theme=${theme}`, { waitUntil: 'networkidle' });
        const form = await page.waitForSelector('[data-workshop-profile]', { timeout: 10000 }).then(() => true).catch(() => false);
        check(`${name}: the section draws its form`, form);
        check(`${name}: the derived facts hold no control`, (await page.locator('[data-workshop-derived] input, [data-workshop-derived] textarea, [data-workshop-derived] select, [data-workshop-derived] button').count()) === 0);
        check(`${name}: three doors to where they change`, (await page.locator('[data-workshop-door]').evaluateAll((els) => els.map((el) => el.getAttribute('href')))).join(' ') === '/merchant/printers /merchant/printers#stock /merchant/printers#preferences');
        check(`${name}: nothing to save yet`, await page.locator('[data-workshop-save]').isDisabled());
        check(`${name}: no horizontal overflow`, (await overflow(page)) <= 0, `overflow=${await overflow(page)}`);
        await page.screenshot({ path: `${out}/workshop-${tag}.png`, fullPage: true });
        // A turnaround out of bounds is said beside the field and cannot be saved.
        await page.locator('[data-workshop-turnaround]').fill('99');
        const refusedInPlace = await page.waitForFunction(() => document.querySelector('[data-workshop-turnaround]')?.getAttribute('aria-invalid') === 'true', null, { timeout: 4000 }).then(() => true).catch(() => false);
        check(`${name}: 99 days is refused in place`, refusedInPlace && (await page.locator('[data-workshop-save]').isDisabled()));
        await page.locator('[data-workshop-turnaround]').fill('7');
        await page.locator('[data-workshop-intro]').fill(lang === 'en' ? 'Spare parts and detailed models, since 2021.' : 'قطع غيار ومجسمات دقيقة، منذ 2021.');
        await page.locator('[data-workshop-save]').click();
        const saved = await page.waitForSelector('[data-workshop-saved]', { timeout: 8000 }).then(() => true).catch(() => false);
        check(`${name}: the profile is saved and says so`, saved);
        const put = (await sent(page)).filter((s) => s.method === 'PUT' && s.path === '/api/merchant/request-prefs').at(-1)?.body ?? {};
        check(`${name}: the PUT carries the two fields as edited`, put.turnaround_days === 7 && typeof put.workshop_intro === 'string' && put.workshop_intro.length > 10);
        // Review 2026-09-30: the server keeps every key a body does not name, so the section sends its two fields
        // and NOTHING else — the filters «as read» could be stale and could lift the owner's pause.
        check(`${name}: … and nothing else — no filter, no pause`, Object.keys(put).sort().join(',') === 'turnaround_days,workshop_intro', Object.keys(put).join(','));
        check(`${name}: … and never the derived pair`, !('technologies' in put) && !('max_build_mm' in put));
        await page.screenshot({ path: `${out}/workshop-saved-${tag}.png`, fullPage: true });
        check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
        await context.close();
      }

      // ------------------------------------------------ the storefront's workshop facts
      if (full) {
        for (const hero of ['profile', 'cover', 'minimal']) {
          const { context, page, errors } = await session(lang, theme, width);
          const name = `${tag} storefront-${hero}`;
          await page.goto(`${base}?scene=storefront&hero=${hero}&lang=${lang}&theme=${theme}`, { waitUntil: 'networkidle' });
          const row = await page.waitForSelector('[data-store-workshop]', { timeout: 10000 }).then(() => true).catch(() => false);
          check(`${name}: the facts row under the hero`, row);
          const facts = await page.locator('[data-store-workshop-fact]').evaluateAll((els) => els.map((el) => el.getAttribute('data-store-workshop-fact')));
          check(`${name}: custom requests, the technologies, the build, the turnaround`, facts.join(',') === 'custom,fdm,resin,build,turnaround', facts.join(','));
          const h = (await page.locator('[data-store-workshop]').boundingBox())?.height ?? 0;
          check(`${name}: one line, the 28 px its frame held`, Math.round(h) === 28, `height=${h}`);
          check(`${name}: the stats block adds the two figures`, (await page.locator('[data-stat="turnaround"]').count()) === 1 && (await page.locator('[data-stat="build"]').count()) === 1);
          check(`${name}: no horizontal overflow of the page`, (await overflow(page)) <= 0, `overflow=${await overflow(page)}`);
          await page.locator('[data-store-workshop]').scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${out}/storefront-${hero}-${tag}.png`, fullPage: false });
          check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
          await context.close();
        }
        const { context, page, errors } = await session(lang, theme, width);
        await page.goto(`${base}?scene=storefront&facts=0&lang=${lang}&theme=${theme}`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-block="hero"]', { timeout: 10000 });
        await page.waitForTimeout(500);
        check(`${tag} storefront-bare: a store without facts draws no row and holds no frame`, (await page.locator('[data-store-workshop]').count()) === 0 && (await page.locator('[data-block="hero"] div.h-7[aria-hidden="true"]:empty').count()) === 0);
        check(`${tag} storefront-bare: no workshop figures on the stats block`, (await page.locator('[data-stat="turnaround"], [data-stat="build"]').count()) === 0);
        check(`${tag} storefront-bare: no page errors`, errors.length === 0, errors.join(' | '));
        await context.close();
      }
    }
  }
}
await browser.close();
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
