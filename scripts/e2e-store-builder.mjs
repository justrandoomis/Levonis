#!/usr/bin/env node
/**
 * THE STORE BUILDER, DRIVEN IN A REAL BROWSER (W4-A).
 *
 * The real application at /merchant/store/design (tests/browser/store-builder-fixture.tsx
 * renders src/App) against the REAL store-layout, merchant, catalogue and
 * storefront routes on SQLite (tests/browser/store-builder-api.mts — started
 * here, fresh for every run). In Arabic (RTL) and English (LTR), at 1280 and 360:
 *
 *   - first run: «ابدأ من قالب» writes the chosen template to the DRAFT only;
 *   - the picker (categories, live preview), adding a block, the inspector;
 *     markup typed into a title is stored and shown as characters, and no
 *     script element ever reaches the preview;
 *   - a `javascript:` link is shown as an error and is NEVER saved; fixing it saves;
 *   - clicking a block in the preview selects it; ↑/↓ on the grip reorder and
 *     keep focus; dragging the grip reorders; delete + «تراجع»;
 *   - theme and page panels; a second tab saving first gives the conflict
 *     banner and «أبقِ تعديلاتي» saves over it; publish shows the changes and
 *     the public storefront then serves the page; history; device widths;
 *   - on a phone: edit / preview switch, the inspector, the picker sheet, and
 *     no horizontal overflow.
 *
 * Screenshots go to OUT_DIR (default /tmp/claude-0/shots/w4a/), <step>-<width>-<lang>.png.
 *
 * Run: serve the repo with vite (`npx vite --port 4192`), then
 *      PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright node scripts/e2e-store-builder.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.BUILDER_URL || 'http://127.0.0.1:4192';
const OUT = process.env.OUT_DIR || '/tmp/claude-0/shots/w4a';
const PORT = Number(process.env.BUILDER_API_PORT || 8792);
const API = `http://127.0.0.1:${PORT}`;
await mkdir(OUT, { recursive: true });

let failures = 0;
let passes = 0;
const check = (cond, msg) => {
  if (cond) {
    passes += 1;
    console.log('ok', msg);
  } else {
    failures += 1;
    console.log('FAIL', msg);
  }
};

/** A fresh backend: every migration, the fixture store, nothing saved or published. */
async function backend() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/browser/store-builder-api.mts', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('builder api on') && resolve());
    child.on('exit', (code) => reject(new Error(`backend exited ${code}`)));
  });
  return child;
}

const b = await chromium.launch();

async function run(lang, width, steps) {
  const L = (ar, en) => (lang === 'en' ? en : ar);
  const ctx = await b.newContext({ viewport: { width, height: width < 700 ? 780 : 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text().slice(0, 200)));
  await p.route('**/files/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#1f3b4d"/><stop offset="1" stop-color="#0e7490"/></linearGradient></defs><rect width="800" height="500" fill="url(#g)"/><circle cx="600" cy="140" r="90" fill="#d2c392" opacity=".35"/></svg>' }));
  const shot = async (name) => {
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${OUT}/${name}-${width}-${lang}.png`, fullPage: false });
    console.log('shot', name);
  };
  const saved = async () => {
    await p.waitForSelector('[data-sd-save="saved"]', { timeout: 15000 });
  };


  await p.goto(`${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}`);
  await p.waitForSelector('[data-store-design]', { timeout: 30000 });

  if (steps.includes('full')) {
    // 1. First run: «ابدأ من قالب».
    check(await p.locator('[data-sd-first-run]').isVisible(), 'first-run template card is shown');
    await shot('01-first-run');
    await p.click('[data-sd-starter="workshop"]');
    await saved();
    const st = await (await fetch(`${API}/api/merchant/store/layout`)).json();
    check(st.draft.exists && st.draft.layout.theme === 'workshop' && !st.published, 'the template is written to the DRAFT only');
    await shot('02-workshop-draft');

    // 2. The picker: categories, live preview, add.
    await p.click('[data-sd-open-picker]');
    await p.waitForSelector('[data-overlay="sd-block-picker"]');
    await p.getByRole('radio', { name: L('محتوى', 'Content') }).click();
    await p.click('[data-sd-type="faq"]');
    await shot('03-picker-faq');
    await p.click('[data-sd-type="text"]');
    await p.click('[data-sd-add="text"]');
    await p.waitForSelector('[data-sd-inspector="text"]');
    const title = p.getByRole('textbox', { name: new RegExp(L('العنوان — العربية', 'Title — English')) });
    await title.fill('<script>alert(1)</script> مرحبًا بكم في الورشة');
    await p.getByRole('textbox', { name: new RegExp(L('النص — العربية', 'Text — English')) }).fill('نطبع قطع الغيار والمجسمات بدقة عالية.\n\nأرسل ملفك واحصل على عرض سعر.');
    await saved();
    const st2 = await (await fetch(`${API}/api/merchant/store/layout`)).json();
    const txt = st2.draft.layout.blocks.find((x) => x.type === 'text');
    check(txt && (txt.settings.title.ar || txt.settings.title.en).startsWith('<script>'), 'markup is stored as characters');
    const scripts = await p.evaluate(() => [...document.querySelectorAll('[data-sd-canvas] script')].length);
    check(scripts === 0, 'no script element reached the preview');
    await shot('04-inspector-text');

    // 3. A dangerous link: blocked inline, never saved.
    await p.getByRole('button', { name: L('كل الأقسام', 'All sections') }).click();
    await p.click('[data-sd-open-picker]');
    await p.getByRole('radio', { name: L('العروض والدعوات', 'Offers and calls') }).click();
    await p.click('[data-sd-type="cta"]');
    await p.click('[data-sd-add="cta"]');
    await p.waitForSelector('[data-sd-inspector="cta"]');
    await saved();
    const before = (await (await fetch(`${API}/api/merchant/store/layout`)).json()).draft.version;
    await p.getByRole('combobox', { name: L('نوع الرابط', 'Link kind') }).selectOption('external');
    await p.getByRole('textbox', { name: L('عنوان الرابط', 'Web address') }).fill('javascript:alert(document.cookie)');
    await p.waitForSelector('[data-sd-save="blocked"]');
    await p.waitForTimeout(2000);
    const after = (await (await fetch(`${API}/api/merchant/store/layout`)).json()).draft.version;
    check(before === after, 'a javascript: link is never saved');
    await shot('05-unsafe-link-blocked');
    await p.getByRole('textbox', { name: L('عنوان الرابط', 'Web address') }).fill('https://instagram.com/raf3d');
    await saved();
    check(true, 'fixed link saves');

    // 4. Click a block in the preview to select it.
    await p.getByRole('button', { name: L('كل الأقسام', 'All sections') }).click();
    await p.locator('[data-sd-canvas] [data-block-id="services"]').scrollIntoViewIfNeeded();
    await p.waitForTimeout(400);
    const box = await p.locator('[data-sd-canvas] [data-block-id="services"]').boundingBox();
    if (box) {
      await p.mouse.click(box.x + box.width / 2, box.y + Math.min(40, box.height / 2));
      await p.waitForSelector('[data-sd-inspector="services"]', { timeout: 5000 }).then(() => check(true, 'clicking the preview selects the block'), () => check(false, 'clicking the preview selects the block'));
      await shot('06-selected-from-preview');
      await p.getByRole('button', { name: L('كل الأقسام', 'All sections') }).click();
    } else check(false, 'services block visible in preview');

    // 5. Keyboard reorder.
    const order0 = await p.$$eval('[data-sd-row]', (els) => els.map((e) => e.getAttribute('data-sd-row')));
    await p.locator(`[data-sd-row="${order0[1]}"] .sd-grip`).focus();
    await p.keyboard.press('ArrowDown');
    await p.waitForTimeout(300);
    const order1 = await p.$$eval('[data-sd-row]', (els) => els.map((e) => e.getAttribute('data-sd-row')));
    check(order1[2] === order0[1], 'ArrowDown on the grip moves the section down');
    const focused = await p.evaluate(() => document.activeElement?.closest('[data-sd-row]')?.getAttribute('data-sd-row'));
    check(focused === order0[1], 'focus stays on the moved section');

    // 6. Drag reorder with the pointer.
    const g = await p.locator(`[data-sd-row="${order1[0]}"] .sd-grip`).boundingBox();
    const t = await p.locator(`[data-sd-row="${order1[3]}"]`).boundingBox();
    await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await p.mouse.down();
    for (let i = 1; i <= 12; i++) await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + ((t.y + t.height / 2 - g.y - g.height / 2) * i) / 12);
    await p.mouse.up();
    await p.waitForTimeout(600);
    const order2 = await p.$$eval('[data-sd-row]', (els) => els.map((e) => e.getAttribute('data-sd-row')));
    check(order2.indexOf(order1[0]) >= 2, `dragging the grip moves the section (${order2.join(',')})`);
    await saved();

    // 7. Delete with undo.
    const victim = order2[order2.length - 1];
    await p.locator(`[data-sd-row="${victim}"]`).getByRole('button', { name: new RegExp(L('إجراءات', 'actions')) }).click();
    await p.getByRole('menuitem', { name: L('حذف', 'Delete') }).click();
    await p.waitForTimeout(300);
    check((await p.locator(`[data-sd-row="${victim}"]`).count()) === 0, 'deleted');
    await shot('07-deleted-undo-toast');
    await p.getByRole('button', { name: L('تراجع', 'Undo') }).last().click();
    await p.waitForTimeout(400);
    check((await p.locator(`[data-sd-row="${victim}"]`).count()) === 1, '«تراجع» brings it back');
    await saved();

    // 8. Theme.
    await p.getByRole('tab', { name: L('الشكل', 'Look') }).click();
    await p.click('[data-sd-preset="premium_dark"]');
    await saved();
    await shot('08-theme');
    await p.getByRole('tab', { name: L('الصفحة', 'Page') }).click();
    await shot('09-page');

    // 9. Conflict: another tab saves; this one gets DRAFT_CHANGED.
    const cur = await (await fetch(`${API}/api/merchant/store/layout`)).json();
    await fetch(`${API}/api/merchant/store/layout/draft`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: cur.draft.version, layout: cur.draft.layout }) });
    await p.getByRole('radio', { name: L('بلا تذييل', 'None') }).last().click();
    await p.waitForSelector('[data-sd-conflict]', { timeout: 15000 });
    await shot('10-conflict');
    await p.getByRole('button', { name: L('أبقِ تعديلاتي', 'Keep mine') }).click();
    await saved();
    const kept = await (await fetch(`${API}/api/merchant/store/layout`)).json();
    check(kept.draft.layout.footer.variant === 'none', '«keep mine» saved over the other tab');

    // 10. Publish with the changes summary.
    await p.click('[data-sd-publish]');
    await p.waitForSelector('[data-overlay="sd-publish-dialog"] [data-sd-changes]');
    await shot('11-publish-confirm');
    await p.click('[data-overlay="sd-publish-dialog"] [data-confirm-action]');
    await p.waitForSelector('[data-sd-publish-state]');
    await p.waitForTimeout(1200);
    const pub = await (await fetch(`${API}/api/storefront/raf3d`)).json();
    check(pub.store.layout_source === 'published' && pub.store.layout.theme === 'premium_dark', 'the storefront now serves the published page');
    await shot('12-published');

    // 11. History.
    await p.getByRole('tab', { name: L('السجل', 'History') }).click();
    await shot('13-history');
    await p.getByRole('radio', { name: '1280' }).click();
    await shot('14-preview-device-1280');
    await p.getByRole('radio', { name: '768' }).click();
    await shot('15-preview-device-768');
  }

  if (steps.includes('phone')) {
    // Phone: edit list, a block inspector, the preview, the picker sheet.
    await p.waitForSelector('[data-sd-sections], [data-sd-first-run]');
    if (await p.locator('[data-sd-first-run]').isVisible()) {
      await p.click('[data-sd-starter="product_focused"]');
      await saved();
    }
    await shot('p1-sections');
    await p.locator('[data-sd-row]').nth(1).locator('button').nth(1).click();
    await p.waitForSelector('[data-sd-inspector]');
    await shot('p2-inspector');
    await p.getByRole('button', { name: L('كل الأقسام', 'All sections') }).click();
    await p.getByRole('radio', { name: L('معاينة', 'Preview') }).click();
    await p.waitForSelector('[data-sd-canvas]');
    await shot('p3-preview');
    await p.getByRole('radio', { name: L('تحرير', 'Edit') }).click();
    await p.click('[data-sd-open-picker]');
    await p.waitForSelector('[data-overlay="sd-block-picker"]');
    await shot('p4-picker');
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `no horizontal overflow (${overflow})`);
  }

  check(errors.length === 0, `no page errors (${errors.join(' | ').slice(0, 400)})`);
  await ctx.close();
}

for (const [lang, width, steps] of [
  ['ar', 1280, ['full']],
  ['en', 1280, ['full']],
  ['ar', 360, ['phone']],
  ['en', 360, ['phone']],
]) {
  const api = await backend();
  try {
    console.log(`== ${lang} ${width} ${steps.join(',')}`);
    await run(lang, width, steps);
  } catch (e) {
    check(false, `${lang} ${width}: ${String(e).slice(0, 300)}`);
  } finally {
    api.kill();
  }
}
await b.close();
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
