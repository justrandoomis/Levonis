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
 *   - «سرعة متجري» (P4, steps `speed` / `pulse`): `?tab=speed` opens the tab;
 *     a fresh store shows the collecting state with the weight audit (the REAL
 *     routes); with the fixture's figures (`&speed=numbers`) the verdict is a
 *     word, the bands and bars are drawn, the lab link opens a new tab without
 *     an opener, device / window / draft switch, «افتح القسم» opens the hero in
 *     the Sections tab; Today's Pulse line (`&pulse=speed`) opens the tab. In
 *     ar, en and ckb, at 360 and 1280, with reduced motion on and off, dark and
 *     light (`light`). Step `stale` (the fixture's `&speedfail=7`): a failed
 *     refresh keeps the figures it had, dimmed and named for their own window,
 *     under one notice with its retry. Step `vitals`: both store pages (the
 *     store's own host) fetch the reporter after load + idle and send ONE
 *     beacon when left.
 *   - MEDIA EVERYWHERE (P5, step `media`): the Page tab's notice (words, link,
 *     window), footer links, the background (a library picture with its weight
 *     and dim; a video whose poster is captured from its frame), a library file
 *     deleted, the hero's video field and schedule, «معاينة على هاتفي». Step
 *     `announce`: the Counter's «📣 إعلان» door publishes the notice after its
 *     confirm, the store's own host serves it, and the door takes it down.
 *
 * E2E_ONLY=speed,pulse runs only the entries with those steps; E2E_LANG=ckb and
 * E2E_WIDTH=1280 narrow them further (comma lists).
 *
 * Screenshots go to OUT_DIR (default /tmp/claude-0/shots/w4a/), <step>-<width>-<lang>[-rm][-light].png
 * (-rm: reduced motion; -light: the «cream» theme).
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
  const reduced = steps.includes('reduced');
  const light = steps.includes('light');
  const ctx = await b.newContext({ viewport: { width, height: width < 700 ? 780 : 900 }, deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference', ...(light ? { colorScheme: 'light' } : {}) });
  // The «cream» theme: the stored choice the app's own switch writes (src/lib/theme.ts), and the fixture's `&theme=light`.
  if (light) await ctx.addInitScript(() => localStorage.setItem('levonis.theme.v1', 'light'));
  const themeQ = light ? '&theme=light' : '';
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text().slice(0, 200)));
  // Media under `/files/` only — a glob like `**/files/**` also caught the dev server's
  // `/src/components/community/files/api.ts`, a module the product page imports.
  await p.route((u) => u.pathname.startsWith('/files/'), (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#1f3b4d"/><stop offset="1" stop-color="#0e7490"/></linearGradient></defs><rect width="800" height="500" fill="url(#g)"/><circle cx="600" cy="140" r="90" fill="#d2c392" opacity=".35"/></svg>' }));
  const shot = async (name) => {
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${OUT}/${name}-${width}-${lang}${reduced ? '-rm' : ''}${light ? '-light' : ''}.png`, fullPage: false });
    console.log('shot', name);
  };
  const saved = async () => {
    await p.waitForSelector('[data-sd-save="saved"]', { timeout: 15000 });
  };


  await p.goto(`${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}${themeQ}`);
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

  if (steps.includes('speed')) {
    // «سرعة متجري» (P4). The words the checks read, per language (storeDesign/strings.ts).
    const tag = `${lang} ${width}${reduced ? ' reduced' : ''}`;
    const word = { ok: { ar: 'مقبول', en: 'Fair', ckb: 'مامناوەند' }[lang], good: { ar: 'جيد', en: 'Good', ckb: 'باش' }[lang] };
    const at = (extra) => `${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}${themeQ}${extra}&path=${encodeURIComponent('/merchant/store/design?tab=speed')}`;
    const noOverflow = async (what) => {
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `${tag}: no horizontal overflow on ${what} (${overflow})`);
    };

    // 1. A fresh store, the REAL speed routes: no reading yet — and the weight audit all the same.
    await p.goto(at(''));
    await p.waitForSelector('[data-sd-speed] [data-speed-weight]', { timeout: 30000 });
    check((await p.locator('[data-tab="speed"][aria-selected="true"]').count()) === 1, `${tag}: ?tab=speed opens the «السرعة» tab`);
    check(await p.locator('[data-speed-collecting]').isVisible(), `${tag}: no reading yet — the collecting state`);
    check((await p.locator('[data-speed-verdict]').count()) === 0, `${tag}: no verdict is claimed without readings`);
    check((await p.locator('[data-weight-row="fixed"]').count()) === 1, `${tag}: the weight audit stands without visitors`);
    // A starter gives the page its sections, so every door below has somewhere to open.
    if (await p.locator('[data-sd-first-run]').isVisible()) {
      await p.click('[data-sd-starter="product_focused"]');
      await saved();
    }
    await p.locator('[data-sd-speed]').scrollIntoViewIfNeeded();
    await shot('s1-speed-empty');
    if (width < 700) await noOverflow('the empty speed tab');

    // 2. The figures: a month of phone readings (the fixture's `&speed=numbers`).
    await p.goto(at('&speed=numbers'));
    await p.waitForSelector('[data-speed-verdict]', { timeout: 30000 });
    const verdict = (await p.locator('[data-speed-verdict]').innerText()).trim();
    check(verdict === word.ok, `${tag}: the verdict is a word («${verdict}»)`);
    check((await p.locator('[data-speed-verdict] [data-status-chip="warning"]').count()) === 1, `${tag}: the word carries its tone`);
    check((await p.locator('[data-speed-tiles] [data-kpi]').count()) === 5, `${tag}: the verdict and four vitals`);
    check((await p.locator('[data-speed-band]').count()) === 3, `${tag}: three bands, each with its word`);
    const firstRow = await p.locator('[data-weight-row]').first().getAttribute('data-weight-row');
    check(firstRow === 'hero_image', `${tag}: the heaviest row first (${firstRow})`);
    const heroBar = await p.locator('[data-weight-row="hero_image"] [data-weight-bar]').evaluate((el) => el.style.width);
    check(heroBar === '100%', `${tag}: the heaviest bar is full (${heroBar})`);
    const psi = p.locator('[data-speed-psi]');
    check(
      (await psi.getAttribute('target')) === '_blank' && /\bnoopener\b/.test((await psi.getAttribute('rel')) || '') && ((await psi.getAttribute('href')) || '').startsWith('https://pagespeed.web.dev/analysis?url='),
      `${tag}: the lab link opens a new tab without an opener`
    );
    await shot('s2-speed-numbers');
    if (width < 700) await noOverflow('the speed tab with figures');
    await p.locator('[data-speed-weight]').scrollIntoViewIfNeeded();
    await shot('s3-speed-weight');
    await p.locator('[data-speed-lab]').scrollIntoViewIfNeeded();
    await shot('s3b-speed-lab');

    // 3. A computer, the last 7 days: the server's parameters, read again.
    await p.click('[data-speed-device="desktop"]');
    await p.waitForSelector('[data-speed-verdict="good"]', { timeout: 10000 });
    await p.click('[data-speed-days="7"]');
    await p.waitForSelector('[data-speed-days="7"][aria-checked="true"]');
    await p.waitForTimeout(400);
    const good = (await p.locator('[data-speed-verdict]').innerText()).trim();
    check(good === word.good, `${tag}: a computer's verdict («${good}»)`);
    await p.waitForSelector('[data-speed-real]:not([data-speed-stale])', { timeout: 10000 }).catch(() => null);
    check((await p.locator('[data-speed-stale]').count()) === 0, `${tag}: the figures on screen answer the device and window asked`);
    const d7 = { ar: 'آخر 7 أيام', en: 'Last 7 days', ckb: '٧ ڕۆژی ڕابردوو' }[lang];
    check((await p.locator('[data-speed-tiles]').innerText()).includes(d7), `${tag}: the visits line names the 7-day window`);
    await p.locator('[data-sd-speed]').scrollIntoViewIfNeeded();
    await shot('s4-speed-desktop-7');

    // 4. The draft's weight: the fixes, before they are published.
    await p.click('[data-speed-source="draft"]');
    await p.waitForSelector('[data-speed-finding="OK_IMAGES"]', { timeout: 10000 });
    check(/WebP/.test(await p.locator('[data-weight-row="hero_image"]').innerText()), `${tag}: the draft's weight is the draft's`);
    await p.locator('[data-speed-weight]').scrollIntoViewIfNeeded();
    await shot('s5-speed-draft');
    await p.click('[data-speed-source="published"]');
    await p.waitForSelector('[data-speed-finding="HERO_GIF"]', { timeout: 10000 });

    // 5. «افتح القسم» opens the hero in the Sections tab.
    await p.locator('[data-speed-finding="HERO_GIF"] [data-speed-open="block"]').click();
    await p.waitForSelector('[data-sd-inspector="hero"]', { timeout: 5000 }).then(
      () => check(true, `${tag}: «افتح القسم» opens the hero's inspector`),
      () => check(false, `${tag}: «افتح القسم» opens the hero's inspector`)
    );
    check((await p.locator('[data-tab="sections"][aria-selected="true"]').count()) === 1, `${tag}: back on the Sections tab`);
    await shot('s6-opened-hero');
  }

  if (steps.includes('stale')) {
    // A failed refresh (the fixture's `&speedfail=7`): the 28-day figures stay, dimmed and still
    // named for their own window, under ONE notice with its retry; asking for them again clears it.
    const tag = `${lang} ${width}${reduced ? ' reduced' : ''}`;
    const d28 = { ar: 'آخر 28 يومًا', en: 'Last 28 days', ckb: '٢٨ ڕۆژی ڕابردوو' }[lang];
    await p.goto(`${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}${themeQ}&speed=numbers&speedfail=7&path=${encodeURIComponent('/merchant/store/design?tab=speed')}`);
    await p.waitForSelector('[data-speed-verdict]', { timeout: 30000 });
    await p.click('[data-speed-days="7"]');
    const failed = await p.waitForSelector('[data-sd-speed] [role="alert"]', { timeout: 10000 }).then(() => true, () => false);
    check(failed, `${tag}: a failed refresh says so`);
    check((await p.locator('[data-sd-speed] [role="alert"]').count()) === 1, `${tag}: one notice, not one per part`);
    check((await p.locator('[data-speed-stale] [data-speed-tiles]').count()) === 1, `${tag}: the figures it had stay, marked stale`);
    check((await p.locator('[data-speed-tiles]').innerText()).includes(d28), `${tag}: they still name their own window`);
    check((await p.locator('[data-sd-speed] [role="alert"] button').count()) === 1, `${tag}: the notice carries its retry`);
    await p.locator('[data-sd-speed]').scrollIntoViewIfNeeded();
    await shot('s7-speed-stale');
    await p.click('[data-speed-days="28"]');
    // The figures are the 28-day ones again at once; the notice goes when the new read lands.
    await p.waitForSelector('[data-sd-speed] [role="alert"]', { state: 'detached', timeout: 10000 }).catch(() => null);
    check((await p.locator('[data-sd-speed] [role="alert"]').count()) === 0 && (await p.locator('[data-speed-stale]').count()) === 0, `${tag}: asking for what answered clears the notice`);
  }

  if (steps.includes('pulse')) {
    // Today's Pulse: the speed line exists only with the attention source, and opens the tab.
    const tag = `${lang} ${width}${reduced ? ' reduced' : ''}`;
    await p.goto(`${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}${themeQ}&pulse=speed&speed=numbers&path=${encodeURIComponent('/merchant')}`);
    await p.waitForSelector('[data-pulse-line="speed"]', { timeout: 30000 });
    const line = (await p.locator('[data-pulse-line="speed"]').innerText()).trim();
    const pulseWord = { ar: 'سرعة الصفحة على الهاتف: ضعيفة', en: 'Page speed on phones: poor', ckb: 'خێرایی پەڕە لە مۆبایلدا: لاواز' }[lang];
    check(line === pulseWord && (await p.locator('[data-pulse-line="speed"][data-tone="warning"]').count()) === 1, `${tag}: the Pulse's speed line («${line}»)`);
    await shot('t1-pulse-speed');
    await p.locator('[data-pulse-line="speed"] a').click();
    await p.waitForSelector('[data-sd-speed]', { timeout: 30000 });
    check((await p.locator('[data-tab="speed"][aria-selected="true"]').count()) === 1, `${tag}: the door opens the builder on its speed tab`);
    check(new URL(p.url()).search.includes('tab=speed'), `${tag}: the address carries ?tab=speed (${new URL(p.url()).pathname}${new URL(p.url()).search})`);
    await p.waitForSelector('[data-speed-verdict]', { timeout: 30000 });
    await shot('t2-pulse-door');
  }

  if (steps.includes('vitals')) {
    // The reporter (src/lib/storeVitals.ts): fetched after `load` + idle by both store pages — a
    // dynamic import — and ONE beacon when the page is left: the store, the device, the readings.
    const tag = `${lang} ${width}${reduced ? ' reduced' : ''}`;
    for (const [what, path] of [['home', '/'], ['product', '/p/raf3d-p5']]) {
      const loaded = p.waitForRequest((r) => /\/src\/lib\/storeVitals\.ts|\/storeVitals-[\w-]+\.js/.test(r.url()), { timeout: 20000 }).then(() => true, () => false);
      await p.goto(`${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}${themeQ}&host=store&path=${encodeURIComponent(path)}`);
      check(await loaded, `${tag}: the ${what} page fetches the speed reporter after load + idle`);
      await p.waitForTimeout(300);
      const beacon = p.waitForRequest((r) => r.url().endsWith('/api/storefront/events/vitals') && r.method() === 'POST', { timeout: 10000 }).catch(() => null);
      await p.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      const req = await beacon;
      let body = null;
      try {
        body = JSON.parse(req?.postData() ?? 'null');
      } catch {
        body = null;
      }
      const fields = ['store', 'device', 'lcp_ms', 'cls_x1000', 'inp_ms', 'ttfb_ms'];
      check(
        !!body && body.store === 's1' && body.device === (width < 768 ? 'phone' : 'desktop') && Object.keys(body).every((k) => fields.includes(k)) && Number.isFinite(body.ttfb_ms),
        `${tag}: one beacon from the ${what} page, the readings and nothing else (${JSON.stringify(body)})`
      );
    }
  }

  if (steps.includes('media')) {
    // MEDIA EVERYWHERE (P5, builder B1–B3, storefront L3–L8), on the REAL layout routes: the Page tab's
    // notice (words, link, window — an end before the start is said), footer links (add, label, move,
    // remove), the background (picture from the library with its weight and «مستخدم في», dim, then a
    // video whose poster is captured from its frame), a library file deleted, the hero's video field,
    // and «معاينة على هاتفي» (1280) / its `?view=preview` address (360).
    const tag = `media ${lang} ${width}${reduced ? ' reduced' : ''}`;
    const layoutNow = async () => (await (await fetch(`${API}/api/merchant/store/layout`)).json()).draft.layout;
    const words = { ar: 'توصيل مجاني هذا الأسبوع', en: 'Free delivery this week', ckb: 'گەیاندنی بێ بەرامبەر ئەم هەفتەیە' }[lang];
    const noOverflow = async (what) => {
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `${tag}: no horizontal overflow on ${what} (${overflow})`);
    };
    // A small real WebM for the video library's thumbnails and the poster capture.
    const webmPath = `${OUT}/p5-clip.webm`;
    let webm = null;
    try {
      webm = await (await import('node:fs/promises')).readFile(webmPath);
    } catch {
      const rc = await b.newContext({ viewport: { width: 640, height: 360 }, recordVideo: { dir: `${OUT}/p5-rec`, size: { width: 640, height: 360 } } });
      const rp = await rc.newPage();
      await rp.setContent('<body style="margin:0"><div id="d" style="width:640px;height:360px;background:linear-gradient(120deg,#0e7490,#d2c392)"></div><script>let t=0;setInterval(()=>{t+=1;d.style.filter="hue-rotate("+t*6+"deg)"},40)</script></body>');
      await rp.waitForTimeout(1800);
      const rv = rp.video();
      await rc.close();
      await (await import('node:fs/promises')).copyFile(await rv.path(), webmPath);
      webm = await (await import('node:fs/promises')).readFile(webmPath);
    }
    await p.route((u) => u.pathname.startsWith('/files/') && /\.(mp4|webm)$/.test(u.pathname), (r) => r.fulfill({ status: 200, contentType: 'video/webm', body: webm }));

    if (await p.locator('[data-sd-first-run]').isVisible()) {
      await p.click('[data-sd-starter="classic"]');
      await saved();
    }
    if (width < 700) await p.getByRole('radio', { name: L('تحرير', 'Edit') }).click().catch(() => {});

    // 1. The notice: words, a store page, a window — an end before its start is refused on the spot.
    await p.click('[data-tab="page"]');
    await p.waitForSelector('[data-sd-notice]');
    await p.locator('[data-sd-notice] input').first().fill(words);
    await p.locator('[data-sd-notice] select').first().selectOption('route');
    await p.locator('[data-sd-notice] select').nth(1).selectOption('deals');
    const dates = p.locator('[data-sd-notice] input[type="datetime-local"]');
    await dates.nth(0).fill('2026-10-10T09:00');
    await dates.nth(1).fill('2026-10-01T09:00');
    check(await p.locator('[data-sd-notice-order]').isVisible(), `${tag}: an end before the start is said next to the window`);
    await dates.nth(1).fill('2099-10-17T21:00');
    await dates.nth(0).fill('2026-01-01T09:00');
    check((await p.locator('[data-sd-notice-order]').count()) === 0, `${tag}: a window in order says nothing`);
    await saved();
    let draft = await layoutNow();
    check(Object.values(draft.header.notice).includes(words) && draft.header.notice_link.route === 'deals' && !!draft.header.notice_from && !!draft.header.notice_until, `${tag}: the notice, its link and its window are in the draft`);
    await p.locator('[data-sd-notice]').scrollIntoViewIfNeeded();
    await shot('p5-page-notice');

    // 2. Footer links: add two, label them, swap them, remove one.
    await p.click('[data-sd-add-footer-link]');
    await p.click('[data-sd-add-footer-link]');
    await p.locator('[data-sd-footer-link="0"] input').first().fill(L('الأسئلة الشائعة', 'FAQ'));
    await p.locator('[data-sd-footer-link="1"] input').first().fill(L('السياسات', 'Policies'));
    await p.locator('[data-sd-footer-link="1"]').getByRole('button').first().click(); // «للأعلى»
    await saved();
    draft = await layoutNow();
    check(draft.footer.links.length === 2 && Object.values(draft.footer.links[0].label).includes(L('السياسات', 'Policies')), `${tag}: two footer links, the second moved up`);
    await p.locator('[data-sd-footer-link="1"]').getByRole('button').nth(2).click(); // «حذف الرابط»
    await saved();
    check((await layoutNow()).footer.links.length === 1, `${tag}: a footer link removed`);
    await p.locator('[data-sd-footer-links]').scrollIntoViewIfNeeded();
    await shot('p5-page-links');

    // 3. A picture background from the library: its weight, then «مستخدم في» once it is used; the dim.
    await p.locator('[data-sd-background] [role="radio"]').nth(1).click();
    await p.waitForSelector('[data-sd-background="image"]');
    await p.locator('[data-sd-background] [data-sd-media-control="image"] button').first().click();
    await p.waitForSelector('[data-overlay="sd-media-picker"] [data-media-library="image"]', { timeout: 15000 });
    check((await p.locator('[data-overlay="sd-media-picker"] [data-media-bytes]').count()) >= 2, `${tag}: every library file says its weight`);
    check(/1\.5 MB/.test(await p.locator('[data-overlay="sd-media-picker"] [data-sd-media-cap]').innerText()), `${tag}: the picker names this slot's cap`);
    await shot('p5-library');
    // Review 2026-09-30: a plain list of buttons named by their place (`aria-pressed` for the chosen one), not a listbox.
    await p.locator('[data-media-item="merchants/owner/public/hero0001.webp"] button[aria-pressed]').click();
    await p.waitForSelector('[data-overlay="sd-media-picker"]', { state: 'detached', timeout: 10000 });
    await p.locator('[data-sd-background] [role="radiogroup"]').nth(1).getByRole('radio').nth(2).click();
    await saved();
    draft = await layoutNow();
    check(draft.background.kind === 'image' && draft.background.media === 'merchants/owner/public/hero0001.webp' && draft.background.dim === 'heavy', `${tag}: the background is the picked picture, deeply dimmed`);
    check(/1 KB/.test(await p.locator('[data-sd-background] [data-sd-media-meta]').innerText().catch(() => '')), `${tag}: the control shows the file's weight`);
    if (width >= 1024) {
      await p.waitForSelector('[data-sd-canvas] [data-sf-background="image"]', { timeout: 10000 });
      check((await p.locator('[data-sd-canvas] [data-store-notice]').count()) === 1, `${tag}: the preview draws the notice`);
    }
    await p.locator('[data-sd-background]').scrollIntoViewIfNeeded();
    await shot('p5-page-background-image');

    // 4. A video background: the poster is captured from its frame and lands WITH it.
    await p.locator('[data-sd-background] [role="radio"]').nth(2).click();
    await p.waitForSelector('[data-sd-background="video"]');
    await p.locator('[data-sd-background] [data-sd-media-control="video"] button').first().click();
    await p.waitForSelector('[data-overlay="sd-media-picker"] [data-media-library="video"]', { timeout: 15000 });
    await p.locator('[data-media-item="merchants/owner/public/clip0001.mp4"] button[aria-pressed]').click();
    await p.waitForSelector('[data-overlay="sd-media-picker"]', { state: 'detached', timeout: 20000 });
    await saved();
    draft = await layoutNow();
    check(draft.background.kind === 'video' && draft.background.media === 'merchants/owner/public/clip0001.mp4' && draft.background.poster === 'merchants/owner/public/pic00002.webp', `${tag}: the video and its captured poster, in one change (${JSON.stringify(draft.background)})`);
    check((await p.locator('[data-sd-poster-required]').count()) === 0, `${tag}: no poster warning once it has one`);
    await p.locator('[data-sd-background]').scrollIntoViewIfNeeded();
    await shot('p5-page-background-video');

    // 5. The library: the picture no page shows any more is deleted; the poster in use offers no delete.
    await p.locator('[data-sd-background] [data-sd-media-control="image"] button').first().click();
    await p.waitForSelector('[data-overlay="sd-media-picker"] [data-media-library="image"]', { timeout: 15000 });
    check((await p.locator('[data-media-delete="merchants/owner/public/pic00002.webp"]').count()) === 0, `${tag}: a file in use offers no delete`);
    check(/\S/.test(await p.locator('[data-media-item="merchants/owner/public/pic00002.webp"] [data-media-used]').innerText()), `${tag}: …and says where it is used`);
    await p.click('[data-media-delete="merchants/owner/public/hero0001.webp"]');
    await p.locator('[data-confirm-action]').last().click();
    await p.waitForSelector('[data-media-item="merchants/owner/public/hero0001.webp"]', { state: 'detached', timeout: 10000 });
    const lib = (await (await fetch(`${API}/api/merchant/store/layout/media?kind=image`)).json()).items.map((i) => i.key);
    check(!lib.includes('merchants/owner/public/hero0001.webp'), `${tag}: the deleted file left the library`);
    await shot('p5-library-deleted');
    await p.keyboard.press('Escape');
    await p.waitForSelector('[data-overlay="sd-media-picker"]', { state: 'detached', timeout: 10000 }).catch(() => {});
    if (width < 700) await noOverflow('the Page panel');

    // 6. The hero's video field, where the classic (profile) hero draws a picture.
    await p.click('[data-tab="sections"]');
    await p.locator('[data-sd-row="hero"]').locator('button').nth(1).click().catch(async () => p.locator('[data-sd-row="hero"]').click());
    await p.waitForSelector('[data-sd-inspector="hero"]');
    check((await p.locator('[data-sd-inspector="hero"] [data-sd-media-control="video"]').count()) === 1, `${tag}: the hero offers its video field`);
    await p.locator('[data-sd-inspector="hero"] [data-sd-media-control="video"]').scrollIntoViewIfNeeded();
    await shot('p5-hero-video-field');
    // The schedule, on the same inspector: an end before its start is said.
    const sched = p.locator('[data-sd-inspector="hero"] [data-sd-schedule] input[type="datetime-local"]');
    await sched.nth(0).fill('2026-10-10T09:00');
    await sched.nth(1).fill('2026-10-01T09:00');
    check(await p.locator('[data-sd-schedule-order]').isVisible(), `${tag}: a schedule's end before its start is said`);
    await p.locator('[data-sd-inspector="hero"] [data-sd-schedule]').getByRole('button').last().click();
    await saved();
    check(!('schedule' in (await layoutNow()).blocks.find((x) => x.id === 'hero')), `${tag}: «بلا جدولة» leaves no schedule`);

    // 7. «معاينة على هاتفي»: the code of the builder's own preview view — and that address opens it.
    if (width >= 1024) {
      await p.click('[data-sd-phone-preview]');
      await p.waitForSelector('[data-overlay="sd-preview-qr"] [data-sd-qr-code]', { timeout: 10000 });
      const url = await p.locator('[data-sd-qr-url]').innerText();
      check(/\/merchant\/store\/design\?view=preview$/.test(url.trim()), `${tag}: the code opens the builder's preview (${url})`);
      await shot('p5-qr');
      await p.keyboard.press('Escape');
    } else {
      await p.goto(`${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}${themeQ}&path=${encodeURIComponent('/merchant/store/design?view=preview')}`);
      await p.waitForSelector('[data-sd-canvas]', { timeout: 30000 });
      check((await p.locator('[data-sd-canvas] [data-store-notice]').count()) === 1, `${tag}: ?view=preview opens a phone on the preview — the draft's notice on it`);
      await shot('p5-phone-preview');
      await noOverflow('the phone preview');
    }
  }

  if (steps.includes('announce')) {
    // «📣 إعلان» (P5, the Counter's dock door): the store page's notice line written from Today, through the
    // layout's own draft and publish on the REAL routes — nothing goes live before «نعم، انشر الآن» — then
    // served by the storefront on the store's own host, and taken down again from the same door.
    const tag = `announce ${lang} ${width}${reduced ? ' reduced' : ''}${light ? ' light' : ''}`;
    const words = { ar: 'خصم ١٠٪ حتى الجمعة', en: '10% off until Friday', ckb: '١٠٪ داشکاندن تا هەینی' }[lang];
    const layoutState = async () => (await fetch(`${API}/api/merchant/store/layout`)).json();
    const today = `${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}${themeQ}&path=${encodeURIComponent('/merchant')}`;
    const openSheet = async () => {
      await p.goto(today);
      await p.waitForSelector('[data-quick-dock] [data-dock="announce"]', { timeout: 30000 });
      await p.click('[data-dock="announce"]');
      await p.waitForSelector('[data-overlay="announce-sheet"] [data-announce-text]', { timeout: 15000 });
    };
    await openSheet();
    check((await p.locator('[data-announce-state="none"]').count()) === 1, `${tag}: a store with no notice says so`);
    check(await p.locator('[data-announce-publish]').isDisabled(), `${tag}: nothing to publish before a word is written`);
    await p.locator('[data-announce-text]').fill(words);
    await p.locator('[data-announce-link]').selectOption('route');
    await p.locator('[data-announce-route]').selectOption('deals');
    await p.locator('[data-announce-from]').fill('2026-10-10T09:00');
    await p.locator('[data-announce-until]').fill('2026-10-01T09:00');
    check(await p.locator('[data-announce-publish]').isDisabled(), `${tag}: an end before its start cannot be published`);
    await p.locator('[data-announce-from]').fill('');
    await p.locator('[data-announce-until]').fill('2099-10-17T21:00');
    check((await p.locator('[data-announce-preview]').innerText()).includes(words), `${tag}: the sheet previews the line`);
    await shot('p5-announce-edit');
    await p.click('[data-announce-publish]');
    await p.waitForSelector('[data-announce-confirm="publish"]');
    // Review 2026-09-30: the button that asked is gone — the question takes focus (read on arrival), never <body>.
    const asked = await p.waitForFunction(() => document.activeElement?.hasAttribute('data-announce-question'), null, { timeout: 3000 }).then(() => true).catch(() => false);
    check(asked, `${tag}: the confirm question takes the focus`);
    check(!(await layoutState()).published, `${tag}: nothing is published before the confirm`);
    await shot('p5-announce-confirm');
    await p.click('[data-announce-confirm-publish]');
    await p.waitForSelector('[data-overlay="announce-sheet"]', { state: 'detached', timeout: 15000 });
    const h = (await layoutState()).published?.layout?.header ?? {};
    check(Object.values(h.notice ?? {}).includes(words) && h.notice_link?.route === 'deals' && !!h.notice_until && !h.notice_from, `${tag}: published — the words, the page, the end (${JSON.stringify(h).slice(0, 240)})`);
    await p.goto(`${origin}/tests/browser/store-builder.html?lang=${lang}&api=${encodeURIComponent(API)}${themeQ}&host=store&path=/`);
    await p.waitForSelector('[data-store-notice]', { timeout: 30000 });
    check((await p.locator('[data-store-notice]').innerText()).includes(words), `${tag}: the store page shows the line`);
    await p.locator('[data-store-notice]').scrollIntoViewIfNeeded();
    await shot('p5-announce-storefront');
    await openSheet();
    check((await p.locator('[data-announce-state="live"]').count()) === 1, `${tag}: the door says the line is live`);
    await p.click('[data-announce-remove]');
    await p.waitForSelector('[data-announce-confirm="remove"]');
    await p.click('[data-announce-confirm-publish]');
    await p.waitForSelector('[data-overlay="announce-sheet"]', { state: 'detached', timeout: 15000 });
    const gone = (await layoutState()).published?.layout?.header?.notice ?? {};
    check(!Object.values(gone).some((v) => String(v).trim()), `${tag}: taken down — the published page holds no notice`);
  }

  check(errors.length === 0, `no page errors (${errors.join(' | ').slice(0, 400)})`);
  await ctx.close();
}

const ONLY = (process.env.E2E_ONLY || '').split(',').filter(Boolean);
const LANGS = (process.env.E2E_LANG || '').split(',').filter(Boolean);
const WIDTHS = (process.env.E2E_WIDTH || '').split(',').filter(Boolean).map(Number);
for (const [lang, width, steps] of [
  ['ar', 1280, ['full']],
  ['en', 1280, ['full']],
  ['ar', 360, ['phone']],
  ['en', 360, ['phone']],
  // «سرعة متجري» (P4): the tab and the Pulse door, in three languages, both widths, reduced motion on and off.
  ['ar', 1280, ['speed']],
  ['en', 1280, ['speed', 'pulse', 'reduced', 'stale']],
  ['ar', 360, ['speed', 'pulse', 'stale']],
  ['en', 360, ['speed', 'reduced']],
  ['ckb', 360, ['speed', 'pulse']],
  ['ckb', 1280, ['speed']],
  ['ar', 360, ['speed', 'pulse', 'light']],
  ['en', 1280, ['speed', 'light']],
  ['ar', 360, ['vitals']],
  ['en', 1280, ['vitals']],
  // Media everywhere (P5, step `media`): the Page panel, the library, the poster capture, the hero's video, the QR.
  ['ar', 1280, ['media']],
  ['en', 1280, ['media', 'reduced']],
  ['ar', 360, ['media']],
  ['ckb', 360, ['media', 'light']],
  // «📣 إعلان» (P5, step `announce`): the Counter's door writes, confirms, publishes and takes down the notice.
  ['ar', 360, ['announce']],
  ['en', 1280, ['announce', 'reduced']],
  ['ckb', 360, ['announce', 'light']],
].filter(([lg, w, st]) => (!ONLY.length || st.some((x) => ONLY.includes(x))) && (!LANGS.length || LANGS.includes(lg)) && (!WIDTHS.length || WIDTHS.includes(w)))) {
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
