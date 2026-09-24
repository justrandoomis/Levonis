#!/usr/bin/env node
/**
 * THE WORKSPACE PRIMITIVES, DRIVEN IN A REAL BROWSER (wave 3, W3-0).
 *
 * tests/uiPrimitives.test.ts pins what the source must say; this proves what
 * it DOES, on the shipped components (tests/browser/ui-kit-fixture.tsx), in
 * Arabic (RTL) and English (LTR), dark, at 360px (a phone: touch, coarse
 * pointer) and 1280px (a desktop), plus one compact-density and one
 * reduced-motion pass:
 *
 *   - no horizontal overflow at any width;
 *   - DataList mounts ONE layout (a table when its container is wide, cards
 *     when not) and a network failure renders the error with retry, never
 *     the empty state;
 *   - the Tabs keyboard (roving focus, arrows in the writing direction,
 *     Home/End, aria-controls → a real tabpanel);
 *   - the Menu keyboard (↓ opens on the first item, arrows, End/Home,
 *     typeahead, Escape closes and hands focus back) — a popover on the
 *     desktop, a sheet on the phone;
 *   - ConfirmDialog: an alertdialog, focus starts on Cancel, Tab cannot
 *     leave it, Escape closes it and focus returns to the opener;
 *   - THE STACK: a confirmation over a sheet — one Escape closes only the
 *     confirmation, focus comes back inside the sheet, a second closes the
 *     sheet; the confirmation paints above the sheet;
 *   - Sheet v2 on a phone: opens at the medium detent, the grabber button
 *     expands it, the body scrolls without moving the sheet, a slow drag
 *     settles back to a detent and a fast one dismisses;
 *   - the dirty guard: Escape asks instead of discarding, and Escape again
 *     answers "keep editing";
 *   - toasts reach the polite / assertive live regions and sit above the
 *     safe area; Undo works;
 *   - ⌘K / Ctrl+K by key position, typing filters, Enter navigates, the
 *     choice comes back as a recent, Escape clears before it closes;
 *   - NumberInput reads ١٢٥٠٠٠ as 125,000 and refuses 12.5 dinars;
 *   - an async Button refuses a double press;
 *   - compact density: 32px drawn, 44px hit.
 *
 * Screenshots of every section and every open state go to OUT_DIR
 * (default /tmp/claude-0/shots/ui-kit/).
 *
 * Run: serve the repo with vite (`npx vite --port 4181`), then
 *      node scripts/e2e-ui-kit.mjs
 *      (PLAYWRIGHT_MODULE / PLAYWRIGHT_BROWSERS_PATH as for the other e2e scripts)
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.UI_KIT_URL || 'http://127.0.0.1:4181/tests/browser/ui-kit.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/ui-kit';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passes += 1;
    console.log(`ok   ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`FAIL ${name} ${detail}`);
  }
}

const settle = (page, ms = 450) => page.waitForTimeout(ms);
const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return null;
    return {
      tag: a.tagName.toLowerCase(),
      role: a.getAttribute('role'),
      text: (a.textContent || '').trim().slice(0, 40),
      item: a.getAttribute('data-menu-item'),
      tab: a.getAttribute('data-tab'),
      open: a.getAttribute('data-open'),
      inPanel: !!a.closest('[data-overlay-panel]'),
      overlay: a.closest('[data-overlay]')?.getAttribute('data-overlay') ?? null,
      kitTrigger: a.hasAttribute('data-kit-menu-trigger'),
    };
  });
const overlayCount = (page, id) => page.locator(`[data-overlay="${id}"]`).count();
/** True once the window has left the DOM — its exit animation included — within 3s. */
const gone = (page, id) =>
  page
    .waitForSelector(`[data-overlay="${id}"]`, { state: 'detached', timeout: 3000 })
    .then(() => true)
    .catch(() => false);

async function run(browser, { lang, width, density, reduced }) {
  const phone = width < 640;
  const tag = `${lang}-${width}${density ? '-compact' : ''}${reduced ? '-reduced' : ''}`;
  const context = await browser.newContext({
    viewport: { width, height: phone ? 780 : 900 },
    deviceScaleFactor: 2,
    locale: lang === 'ar' ? 'ar-IQ' : 'en-US',
    colorScheme: 'dark',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    hasTouch: phone,
    isMobile: phone,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${base}?lang=${lang}${density ? '&density=compact' : ''}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-kit="datalist"] [data-datalist="table"], [data-kit="datalist"] [data-datalist="cards"]');
  await settle(page, 600);
  console.log(`\n== ${tag}`);

  // ---------------------------------------------------------- the page
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${tag}: no horizontal overflow`, overflow <= 0, `(${overflow}px)`);
  check(`${tag}: html dir is ${lang === 'ar' ? 'rtl' : 'ltr'}`, (await page.getAttribute('html', 'dir')) === (lang === 'ar' ? 'rtl' : 'ltr'));

  // ---------------------------------------------------------- DataList
  const main = page.locator('[data-kit="datalist"] > [data-datalist]').first();
  const layout = await main.getAttribute('data-datalist');
  check(`${tag}: DataList picks ${phone ? 'cards' : 'a table'} for its container`, layout === (phone ? 'cards' : 'table'), layout);
  const tables = await main.locator('table').count();
  const cardLists = await main.locator('ul').count();
  check(`${tag}: exactly one layout is mounted`, phone ? tables === 0 && cardLists === 1 : tables === 1 && cardLists === 0, `tables=${tables} lists=${cardLists}`);
  if (!phone) {
    check(`${tag}: a narrow container gets cards even on a wide screen`, (await page.getAttribute('[data-kit-list="narrow"] [data-datalist]', 'data-datalist')) === 'cards');
    const sticky = await main.locator('tbody tr td:last-child').first().evaluate((td) => getComputedStyle(td).position);
    check(`${tag}: the actions column is sticky`, sticky === 'sticky', sticky);
  }
  const errorList = page.locator('[data-kit-list="error"] [data-datalist]');
  check(`${tag}: a network failure is the error view`, (await errorList.getAttribute('data-view')) === 'error');
  check(`${tag}: … with a retry button, and not the empty state`, (await errorList.locator('[role="alert"] button').count()) === 1 && (await errorList.locator('[role="status"]').count()) === 0);
  check(`${tag}: an empty answer is the empty view`, (await page.getAttribute('[data-kit-list="empty"] [data-datalist]', 'data-view')) === 'empty');
  check(`${tag}: not loaded is a skeleton`, (await page.getAttribute('[data-kit-list="loading"] [data-datalist]', 'data-view')) === 'skeleton');

  // ---------------------------------------------------------- Tabs
  const forward = lang === 'ar' ? 'ArrowLeft' : 'ArrowRight';
  await page.focus('[data-kit="tabs"] [role="tab"][data-tab="details"]');
  await page.keyboard.press(forward);
  // The old panel leaves before the new one arrives (mode="wait").
  await settle(page, 700);
  let a = await active(page);
  const selected = await page.getAttribute('[data-kit="tabs"] [data-tab="items"]', 'aria-selected');
  check(`${tag}: ${forward} moves forward in the writing direction and selects`, a?.tab === 'items' && selected === 'true', JSON.stringify(a));
  const controls = await page.getAttribute('[data-kit="tabs"] [data-tab="items"]', 'aria-controls');
  const panelRole = controls ? await page.evaluate((id) => document.getElementById(id)?.getAttribute('role') ?? null, controls) : null;
  check(`${tag}: aria-controls names a real tabpanel`, panelRole === 'tabpanel', `${controls} → ${panelRole}`);
  await page.keyboard.press('End');
  await settle(page, 250);
  check(`${tag}: End jumps to the last tab`, (await active(page))?.tab === 'timeline');
  await page.keyboard.press('Home');
  await settle(page, 250);
  check(`${tag}: Home jumps to the first tab`, (await active(page))?.tab === 'details');
  const stops = await page.locator('[data-kit="tabs"] [role="tab"][tabindex="0"]').count();
  check(`${tag}: the strip is one Tab stop`, stops === 1, String(stops));
  check(`${tag}: link-mode tabs are links with aria-current`, (await page.locator('[data-kit="tabs"] nav a[aria-current="page"]').count()) === 1);

  // ---------------------------------------------------------- Menu
  const trigger = page.locator('[data-kit-menu-trigger]');
  if (!phone) {
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await settle(page);
    a = await active(page);
    check(`${tag}: ↓ on the trigger opens the menu on its first item`, a?.item === 'edit', JSON.stringify(a));
    check(`${tag}: the trigger says it is expanded`, (await trigger.getAttribute('aria-expanded')) === 'true');
    await page.screenshot({ path: `${out}/${tag}-open-menu.png` });
    await page.keyboard.press('ArrowDown');
    check(`${tag}: ↓ moves to the next item`, (await active(page))?.item === 'print');
    await page.keyboard.press('End');
    check(`${tag}: End jumps to the last item (past the separator)`, (await active(page))?.item === 'cancel');
    await page.keyboard.press('Home');
    check(`${tag}: Home jumps to the first`, (await active(page))?.item === 'edit');
    // keyboard.type() sends NO keydown for a character outside the US layout
    // (only an input event), so an Arabic keyboard's «ط» is dispatched as the
    // keydown a real Arabic layout produces.
    await page.evaluate((key) => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }, lang === 'ar' ? 'ط' : 'p');
    check(`${tag}: typeahead finds the print item`, (await active(page))?.item === 'print');
    await page.keyboard.press('ArrowDown');
    a = await active(page);
    check(`${tag}: a disabled item is still reachable (it says why)`, a?.item === 'ship', JSON.stringify(a));
    await page.keyboard.press('Escape');
    await settle(page);
    a = await active(page);
    check(`${tag}: Escape closes the menu and focus goes back to the trigger`, (await page.locator('[role="menu"]').count()) === 0 && a?.kitTrigger === true, JSON.stringify(a));
  } else {
    await trigger.click();
    await settle(page, 600);
    const sheets = await overlayCount(page, 'menu-sheet');
    const popovers = await page.locator('[data-anchored="menu"]').count();
    check(`${tag}: on a phone the menu is a sheet`, sheets === 1 && popovers === 0, `sheets=${sheets} popovers=${popovers}`);
    a = await active(page);
    check(`${tag}: … focused on its first item`, a?.item === 'edit', JSON.stringify(a));
    await page.screenshot({ path: `${out}/${tag}-open-menu.png` });
    await page.keyboard.press('Escape');
    await settle(page, 600);
    a = await active(page);
    check(`${tag}: Escape closes the menu sheet and focus goes back to the trigger`, (await gone(page, 'menu-sheet')) && a?.kitTrigger === true, JSON.stringify(a));
  }

  // ---------------------------------------------------------- ConfirmDialog
  await page.click('[data-open="confirm"]');
  await settle(page);
  const dialog = page.locator('[data-overlay="confirm-dialog"] [data-overlay-panel]');
  check(`${tag}: the confirmation is an alertdialog`, (await dialog.getAttribute('role')) === 'alertdialog');
  check(`${tag}: … named and described`, !!(await dialog.getAttribute('aria-labelledby')) && !!(await dialog.getAttribute('aria-describedby')));
  a = await active(page);
  check(`${tag}: a destructive confirmation starts on Cancel`, a?.inPanel && /إلغاء|Cancel/.test(a?.text ?? ''), JSON.stringify(a));
  await page.screenshot({ path: `${out}/${tag}-open-confirm.png` });
  let trapped = true;
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    if (!(await active(page))?.inPanel) trapped = false;
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+Tab');
    if (!(await active(page))?.inPanel) trapped = false;
  }
  check(`${tag}: Tab and Shift+Tab cannot leave the dialog`, trapped);
  await page.keyboard.press('Escape');
  await settle(page, 600);
  a = await active(page);
  check(`${tag}: Escape closes it and focus returns to the opener`, (await gone(page, 'confirm-dialog')) && a?.open === 'confirm', JSON.stringify(a));

  // ---------------------------------------------------------- the stack
  await page.click('[data-open="sheet"]');
  await settle(page, 600);
  check(`${tag}: the sheet opens`, (await overlayCount(page, 'kit-sheet')) === 1);
  const sheetPanel = page.locator('[data-overlay="kit-sheet"] [data-overlay-panel]');
  if (phone && !reduced) {
    const vh = await page.evaluate(() => window.innerHeight);
    const h0 = (await sheetPanel.boundingBox())?.height ?? 0;
    check(`${tag}: it opens at the medium detent (~50%)`, Math.abs(h0 - vh * 0.5) < 24, `${Math.round(h0)} of ${vh}`);
    await page.screenshot({ path: `${out}/${tag}-open-sheet-medium.png` });
    const body = page.locator('[data-overlay="kit-sheet"] [data-sheet-body]');
    await body.evaluate((el) => {
      el.scrollTop = 200;
    });
    await settle(page, 200);
    const scrolled = await body.evaluate((el) => el.scrollTop);
    const h1 = (await sheetPanel.boundingBox())?.height ?? 0;
    check(`${tag}: the body scrolls and the sheet stays where it is`, scrolled > 100 && Math.abs(h1 - h0) < 2, `scrollTop=${scrolled} h=${Math.round(h1)}`);
    await page.click('[data-overlay="kit-sheet"] [data-sheet-grabber]');
    await settle(page, 700);
    const h2 = (await sheetPanel.boundingBox())?.height ?? 0;
    check(`${tag}: the grabber button expands it to large`, h2 > vh * 0.8, `${Math.round(h2)} of ${vh}`);
    check(`${tag}: … and says so`, (await page.getAttribute('[data-overlay="kit-sheet"] [data-sheet-grabber]', 'aria-expanded')) === 'true');
    await page.screenshot({ path: `${out}/${tag}-open-sheet-large.png` });
    // A slow drag down from large settles at a detent, not at the finger.
    const grab = await page.locator('[data-overlay="kit-sheet"] [data-sheet-grabber]').boundingBox();
    const x = grab.x + grab.width / 2;
    const y = grab.y + grab.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(x, y + i * 12);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(250);
    await page.mouse.up();
    await settle(page, 800);
    const h3 = (await sheetPanel.boundingBox())?.height ?? 0;
    check(`${tag}: a slow 240px drag settles at the medium detent`, Math.abs(h3 - vh * 0.5) < 24, `${Math.round(h3)}`);
  }
  await page.click('[data-overlay="kit-sheet"] [data-open="nested"]');
  await settle(page);
  check(`${tag}: a confirmation opens over the sheet`, (await overlayCount(page, 'kit-nested-confirm')) === 1);
  const zSheet = await page.evaluate(() => Number(getComputedStyle(document.querySelector('[data-overlay="kit-sheet"]')).zIndex));
  const zConfirm = await page.evaluate(() => Number(getComputedStyle(document.querySelector('[data-overlay="kit-nested-confirm"]')).zIndex));
  check(`${tag}: … and paints above it`, zConfirm > zSheet, `${zConfirm} > ${zSheet}`);
  await page.screenshot({ path: `${out}/${tag}-open-stack.png` });
  await page.keyboard.press('Escape');
  await settle(page, 600);
  a = await active(page);
  check(`${tag}: ONE Escape closes only the top window`, (await gone(page, 'kit-nested-confirm')) && (await overlayCount(page, 'kit-sheet')) === 1);
  check(`${tag}: … and focus returns inside the sheet, to the button that asked`, a?.open === 'nested' && a?.overlay === 'kit-sheet', JSON.stringify(a));
  await page.keyboard.press('Escape');
  await settle(page, 700);
  a = await active(page);
  check(`${tag}: the second Escape closes the sheet; focus back on its opener`, (await gone(page, 'kit-sheet')) && a?.open === 'sheet', JSON.stringify(a));

  if (phone && !reduced) {
    // A fast flick down dismisses outright.
    await page.click('[data-open="sheet"]');
    await settle(page, 700);
    const grab = await page.locator('[data-overlay="kit-sheet"] [data-sheet-grabber]').boundingBox();
    const x = grab.x + grab.width / 2;
    const y = grab.y + grab.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(x, y + i * 30);
      await page.waitForTimeout(8);
    }
    await page.mouse.up();
    await settle(page, 900);
    check(`${tag}: a fast flick down dismisses the sheet`, (await gone(page, 'kit-sheet')));
  }

  // ---------------------------------------------------------- dirty guard
  await page.click('[data-open="dirty"]');
  await settle(page);
  await page.fill('[data-kit-draft]', lang === 'ar' ? 'وصف جديد' : 'A new description');
  await page.keyboard.press('Escape');
  await settle(page);
  check(`${tag}: Escape on unsaved work asks instead of closing`, (await overlayCount(page, 'kit-dirty')) === 1 && (await page.locator('[data-overlay-guard]').count()) === 1);
  a = await active(page);
  check(`${tag}: … with focus on «keep editing»`, a?.inPanel && /متابعة التحرير|Keep editing/.test(a?.text ?? ''), JSON.stringify(a));
  await page.screenshot({ path: `${out}/${tag}-open-dirty-guard.png` });
  await page.keyboard.press('Escape');
  await settle(page, 300);
  a = await active(page);
  check(`${tag}: Escape again keeps editing — the text survives`, (await page.locator('[data-overlay-guard]').count()) === 0 && (await page.inputValue('[data-kit-draft]')).length > 0 && a?.tag === 'textarea', JSON.stringify(a));
  await page.keyboard.press('Escape');
  await settle(page, 300);
  await page.click('[data-overlay-guard] .lv-button-danger');
  await settle(page, 600);
  check(`${tag}: «discard & close» closes it`, (await gone(page, 'kit-dirty')));

  // ---------------------------------------------------------- toasts
  await page.click('[data-kit-toast="success"]');
  await page.click('[data-kit-toast="error"]');
  await settle(page, 500);
  const polite = await page.locator('[data-toaster] ~ [role="status"][aria-live="polite"]').textContent();
  const assertive = await page.locator('[role="alert"][aria-live="assertive"]').last().textContent();
  check(`${tag}: a success toast is announced politely`, /تم الحفظ|Saved/.test(polite ?? ''), polite);
  check(`${tag}: an error toast is announced assertively`, /تعذّر|save the product/.test(assertive ?? ''), assertive);
  const toastBox = await page.locator('[data-toaster] [data-toast="error"]').boundingBox();
  const vh2 = await page.evaluate(() => window.innerHeight);
  check(`${tag}: toasts sit clear of the bottom edge`, !!toastBox && toastBox.y + toastBox.height <= vh2 - 10, JSON.stringify(toastBox));
  await page.click('[data-kit-toast="undo"]');
  await settle(page, 500);
  await page.screenshot({ path: `${out}/${tag}-toasts.png` });
  await page.locator('[data-toaster] [data-toast="info"] .lv-button').click();
  await settle(page, 500);
  check(`${tag}: Undo runs its action`, /أُعيد المنتج|Product restored/.test((await page.locator('[data-toaster]').textContent()) ?? ''));

  // ---------------------------------------------------------- palette
  await page.locator('[data-kit="buttons"] button').first().focus();
  await page.keyboard.press('Control+KeyK');
  await settle(page);
  check(`${tag}: Ctrl+K opens the palette (matched by key position)`, (await overlayCount(page, 'command-palette')) === 1);
  a = await active(page);
  check(`${tag}: … with the search field focused`, a?.role === 'combobox', JSON.stringify(a));
  await page.keyboard.type(lang === 'ar' ? 'المنتج' : 'prod');
  await settle(page, 200);
  const first = await page.locator('[data-overlay="command-palette"] [role="option"]').first().getAttribute('data-command');
  check(`${tag}: typing filters to the match`, first === 'products', first);
  await page.screenshot({ path: `${out}/${tag}-open-palette.png` });
  await page.keyboard.press('Enter');
  await settle(page);
  check(`${tag}: Enter goes there`, (await gone(page, 'command-palette')) && (await page.textContent('[data-kit-location]')) === '/merchant/products');
  await page.keyboard.press('Control+KeyK');
  await settle(page);
  const recent = await page.locator('[data-overlay="command-palette"] [data-command-group="__recent"] [role="option"]').first().getAttribute('data-command');
  check(`${tag}: the choice comes back first, as a recent`, recent === 'products', recent);
  await page.keyboard.type('zz');
  await page.keyboard.press('Escape');
  await settle(page, 200);
  check(`${tag}: the first Escape clears the query and keeps the palette`, (await overlayCount(page, 'command-palette')) === 1 && (await page.inputValue('[data-overlay="command-palette"] input')) === '');
  await page.keyboard.press('Escape');
  await settle(page);
  check(`${tag}: the second Escape closes it`, (await gone(page, 'command-palette')));

  // ---------------------------------------------------------- NumberInput
  const price = page.locator('[data-kit-price]');
  await price.click();
  await price.fill('١٢٥٠٠٠');
  await page.locator('h1').click();
  await settle(page, 150);
  check(`${tag}: ١٢٥٠٠٠ is read as 125,000`, (await price.inputValue()) === '125,000' && /^125000 valid/.test((await page.textContent('[data-kit-price-state]')) ?? ''));
  await price.click();
  await price.fill('12.5');
  check(`${tag}: 12.5 dinars is refused, not rounded`, (await price.getAttribute('aria-invalid')) === 'true' && /invalid/.test((await page.textContent('[data-kit-price-state]')) ?? ''));
  await price.fill('125000');
  await page.locator('h1').click();

  // ---------------------------------------------------------- async Button
  const asyncButton = page.locator('[data-kit-async]');
  await asyncButton.click();
  await asyncButton.click({ force: true });
  check(`${tag}: the async button is busy while its promise runs`, (await asyncButton.getAttribute('aria-busy')) === 'true');
  await settle(page, 1300);
  const savedCount = await page.locator('[data-toaster] [data-toast="success"]', { hasText: lang === 'ar' ? 'تم الحفظ' : 'Saved' }).count();
  check(`${tag}: a double press saved once`, savedCount <= 1, String(savedCount));

  // ---------------------------------------------------------- density
  if (density) {
    const box = await page.locator('[data-kit="buttons"] .lv-button').first().boundingBox();
    check(`${tag}: a compact button is drawn 32px tall`, Math.round(box.height) === 32, String(box.height));
    const hit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.lv-button'), { x: box.x + box.width / 2, y: box.y - 5 });
    check(`${tag}: … and still hits 5px above its drawn edge (44px target)`, hit);
    const icon = await page.locator('[data-kit="buttons"] [data-icon-button]').first().boundingBox();
    check(`${tag}: a compact icon button is 32px`, Math.round(icon.height) === 32 && Math.round(icon.width) === 32, JSON.stringify(icon));
    await page.locator('[data-kit="buttons"]').screenshot({ path: `${out}/${tag}-buttons.png` });
  }

  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  // LAST: an element screenshot re-applies device metrics and drops the touch
  // emulation ((pointer: fine) turns true), so nothing that depends on the
  // pointer may run after it.
  if (!density && !reduced) {
    for (const section of await page.$$('[data-kit]')) {
      const id = await section.getAttribute('data-kit');
      await section.screenshot({ path: `${out}/${tag}-${id}.png` });
    }
  }
  await context.close();
}

const browser = await chromium.launch();
for (const lang of ['ar', 'en']) {
  for (const width of [360, 1280]) await run(browser, { lang, width });
}
await run(browser, { lang: 'en', width: 1280, density: true });
await run(browser, { lang: 'ar', width: 360, reduced: true });
await browser.close();

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
