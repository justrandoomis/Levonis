#!/usr/bin/env node
/**
 * THE CREATIVE STUDIO, END TO END, IN A REAL BROWSER.
 *
 * Mounts the real page (src/pages/CreativeStudio.tsx) through
 * tests/browser/creative-studio-fixture.tsx — a stub of the HTTP contract with
 * ONE marked test product (a `test` snapshot, a fixture price, synthetic
 * pictures this script draws) — and walks the main path of the brief:
 *
 *   new design → product → its same-origin picture → three compositions →
 *   choose → the editor draws the Arabic headline «طباعة ثلاثية الأبعاد بدقة
 *   مذهلة», the mixed line «طابعة Bambu Lab A1 Combo مع 4 بكرات (AMS lite)»,
 *   the test price and the test logo → the headline is edited through the
 *   text overlay → the product is scaled with the transformer (its ratio must
 *   not move) → autosave → RELOAD from the stub → the same design → PNG export
 *   pixel-compared with the stage drawn at 1× (expected ~0 %) → screenshots at
 *   1440×900 and 390×844 (and one in Sorani).
 *
 * Run: node scripts/e2e-creative-studio.mjs
 *   PLAYWRIGHT_MODULE  where playwright lives (default: `playwright`)
 *   STUDIO_TEST_URL    an already running fixture (default: starts vite on :4179)
 *   OUT_DIR            screenshots and the exported PNG (default /tmp/levonis-diagnostics/creative-studio)
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = 4179;
const out = process.env.OUT_DIR || '/tmp/levonis-diagnostics/creative-studio';
await mkdir(out, { recursive: true });

const HEADLINE = 'طباعة ثلاثية الأبعاد بدقة مذهلة';
const EDITED = 'طباعة ثلاثية الأبعاد بدقة مذهلة وألوان أكثر';
const MIXED = 'طابعة Bambu Lab A1 Combo مع 4 بكرات (AMS lite)';
const PRICE = 'تجريبي — 1,250,000 د.ع';

let server = null;
let base = process.env.STUDIO_TEST_URL;
if (!base) {
  server = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  base = `http://127.0.0.1:${PORT}/tests/browser/creative-studio.html`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const notes = [];
let cases = 0;
const check = async (name, fn) => {
  cases += 1;
  await fn();
  notes.push(`ok   ${name}`);
  console.log(`ok   ${name}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
/** A server error names its url, so a failure says WHAT failed. */
page.on('response', (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });

// ---- synthetic, MARKED test pictures (never a real product photo or logo) ----
const helper = await context.newPage();
await helper.setContent('<canvas id="c"></canvas>');
const draw = (kind) => helper.evaluate((k) => {
  const c = document.getElementById('c');
  if (k === 'product') {
    c.width = 1200; c.height = 800;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 1200, 800);
    // A grey "printer": body, gantry and a spool — transparent around it, like a cut-out catalogue photo.
    g.fillStyle = '#d9dcdf'; g.fillRect(250, 300, 700, 380);
    g.fillStyle = '#2b2f33'; g.fillRect(300, 340, 600, 280);
    g.fillStyle = '#9aa0a6'; g.fillRect(230, 140, 40, 540); g.fillRect(930, 140, 40, 540); g.fillRect(230, 130, 740, 36);
    g.fillStyle = '#e4572e'; g.beginPath(); g.arc(1040, 420, 90, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff'; g.font = 'bold 64px sans-serif'; g.fillText('TEST PRODUCT', 360, 500);
  } else {
    c.width = 600; c.height = 600;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 600, 600);
    g.fillStyle = '#e9e6dc'; g.beginPath(); g.arc(300, 300, 280, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#111214'; g.font = 'bold 120px sans-serif'; g.textAlign = 'center'; g.fillText('TEST', 300, 280); g.fillText('LOGO', 300, 410);
  }
  return c.toDataURL('image/png').split(',')[1];
}, kind);
const productPng = Buffer.from(await draw('product'), 'base64');
const logoPng = Buffer.from(await draw('logo'), 'base64');
await helper.close();
await context.route('**/files/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname.startsWith('/files/products/test/')) return route.fulfill({ status: 200, contentType: 'image/png', body: productPng });
  if (u.pathname.startsWith('/files/UiUx/Logo/')) return route.fulfill({ status: 200, contentType: 'image/png', body: logoPng });
  return route.fulfill({ status: 404, body: 'not a test picture' });
});
await context.route('https://cdn.example.test/**', (route) => route.fulfill({ status: 404, body: '' }));

/** The editor's Konva stage, read in the page. */
const stageState = () => page.evaluate(() => {
  const K = window.Konva;
  const stage = K && K.stages.find((s) => s.container().hasAttribute('data-stage'));
  if (!stage) return null;
  const texts = stage.find('Text').filter((t) => t.getParent() && t.getParent().name() === 'layer').map((t) => ({ id: t.getParent().id(), text: t.text(), lines: t.textArr.map((l) => l.text), dir: t.direction(), align: t.align(), font: t.fontFamily() }));
  const images = stage.find('Image').map((n) => ({ id: n.getParent().id(), w: n.width(), h: n.height(), natural: n.image() ? n.image().naturalWidth : 0 }));
  return { texts, images, scale: stage.scaleX() };
});
const waitEditor = async () => {
  await page.waitForSelector('[data-editor]', { timeout: 30000 });
  await page.waitForFunction(() => {
    const K = window.Konva;
    const stage = K && K.stages.find((s) => s.container().hasAttribute('data-stage'));
    if (!stage) return false;
    const imgs = stage.find('Image');
    return stage.find('Text').length > 3 && imgs.length >= 2 && imgs.every((n) => n.image() && n.image().naturalWidth > 0);
  }, null, { timeout: 30000 });
};
/** Page coordinates of a node's centre (or of a transformer anchor). */
const centreOf = (selector) => page.evaluate((sel) => {
  const K = window.Konva;
  const stage = K.stages.find((s) => s.container().hasAttribute('data-stage'));
  const node = sel.anchor ? stage.findOne('Transformer').find('._anchor').find((a) => a.name().startsWith(sel.anchor)) : stage.findOne(`#${sel.id}`);
  const r = node.getClientRect();
  const box = stage.container().getBoundingClientRect();
  return { x: box.left + r.x + r.width / 2, y: box.top + r.y + r.height / 2 };
}, selector);
const db = () => page.evaluate(() => window.__csDb());

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  await check('the studio opens on «شنو أنشر اليوم؟» with honest empty states', async () => {
    await page.waitForSelector('[data-studio-home]');
    const text = await page.textContent('[data-studio-home]');
    assert.ok(text.includes('شنو أنشر اليوم؟'));
  });

  await check('new design: search → the product → only its same-origin picture is selectable', async () => {
    await page.getByRole('button', { name: 'منشور منتج' }).first().click();
    await page.waitForSelector('[data-new-design]');
    await page.fill('[data-new-design] input[type="search"]', 'TEST');
    await page.waitForSelector('[data-product-results] button');
    await page.click('[data-product-results] button');
    await page.waitForSelector('[data-picture-choices] button');
    const states = await page.$$eval('[data-picture-choices] button', (bs) => bs.map((b) => b.disabled));
    assert.deepEqual(states, [false, true], 'the remote copy is shown and cannot be chosen');
    await page.click('[data-picture-choices] button:not([disabled])');
  });

  await check('three compositions are built from the template with the real measurer and drawn through the real renderer', async () => {
    await page.fill('[data-copy-headline]', HEADLINE);
    await page.click('[data-build-manual]');
    await page.waitForFunction(() => document.querySelectorAll('[data-compositions] [data-doc-thumb="ready"]').length === 3, null, { timeout: 30000 });
    await page.locator('[data-compositions]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/01-compositions-1440.png`, fullPage: false });
  });

  await check('the editor draws the Arabic headline, the mixed Arabic/Latin line, the test price and the test logo', async () => {
    await page.click('[data-choose="product_first"]');
    await waitEditor();
    const s = await stageState();
    const by = (id) => s.texts.find((t) => t.id === id);
    assert.equal(by('headline').lines.join(' '), HEADLINE);
    assert.equal(by('headline').font, 'IBM Plex Sans Arabic');
    assert.equal(by('headline').dir, 'rtl');
    assert.ok(by('product_name').lines.join(' ').includes(MIXED), JSON.stringify(by('product_name')));
    assert.equal(by('product_name').dir, 'rtl', 'the line starts with Arabic: an RTL run with the Latin inside it');
    assert.equal(by('price').text, PRICE, 'the price comes from the TEST snapshot and says so');
    const logo = s.images.find((i) => i.id === 'logo');
    assert.ok(logo && logo.natural === 600, 'the test logo is drawn');
    const product = s.images.find((i) => i.id === 'product');
    assert.ok(product && Math.abs(product.w / product.h - 1.5) < 1e-9, 'the product keeps its own 3:2 ratio');
    assert.ok(await page.isVisible('[data-test-banner]'), 'the test-data banner is on screen');
    await page.screenshot({ path: `${out}/02-editor-1440.png` });
  });

  let before;
  await check('the headline is edited through the text overlay and saved', async () => {
    const p = await centreOf({ id: 'headline' });
    await page.mouse.dblclick(p.x, p.y);
    await page.waitForSelector('[data-text-overlay="headline"]');
    assert.equal(await page.getAttribute('[data-text-overlay="headline"]', 'dir'), 'rtl');
    await page.fill('[data-text-overlay="headline"]', EDITED);
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction((t) => {
      const stage = window.Konva.stages.find((s) => s.container().hasAttribute('data-stage'));
      const node = stage.findOne('#headline');
      return node && node.findOne('.text').textArr.map((l) => l.text).join(' ') === t;
    }, EDITED);
    await page.waitForSelector('[data-save-state="saved"]', { timeout: 15000 });
    const saved = await db();
    const doc = Object.values(saved.docs)[0];
    assert.equal(doc.content.layers.find((l) => l.id === 'headline').text, EDITED);
    assert.ok(saved.puts >= 1);
  });

  await check('the product is scaled with the transformer: corners only, and its ratio does not move', async () => {
    const s0 = await stageState();
    const p0 = s0.images.find((i) => i.id === 'product');
    const c = await centreOf({ id: 'product' });
    await page.mouse.click(c.x, c.y);
    await page.waitForFunction(() => window.Konva.stages.find((s) => s.container().hasAttribute('data-stage')).findOne('Transformer').nodes().length === 1);
    const anchors = await page.evaluate(() => window.Konva.stages.find((s) => s.container().hasAttribute('data-stage')).findOne('Transformer').find('._anchor').filter((a) => a.visible()).map((a) => a.name().split(' ')[0]).sort());
    assert.deepEqual(anchors.filter((a) => a !== 'rotater'), ['bottom-left', 'bottom-right', 'top-left', 'top-right'], 'only the corners resize a picture');
    assert.ok(!anchors.includes('rotater'), 'a product never rotates');
    const a = await centreOf({ anchor: 'bottom-right' });
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    // A deliberately skewed drag: the transformer keeps the ratio anyway.
    for (let i = 1; i <= 8; i++) await page.mouse.move(a.x - i * 9, a.y - i * 3);
    await page.mouse.up();
    if (await page.isVisible('[data-overlay-panel]').catch(() => false)) {
      const keep = page.getByRole('button', { name: 'طبّق مع التعارض' });
      if (await keep.count()) await keep.click();
    }
    await page.waitForFunction((w0) => {
      const stage = window.Konva.stages.find((s) => s.container().hasAttribute('data-stage'));
      const img = stage.findOne('#product').findOne('Image');
      return img && Math.abs(img.width() - w0) > 1;
    }, p0.w, { timeout: 10000 });
    const s1 = await stageState();
    const p1 = s1.images.find((i) => i.id === 'product');
    assert.ok(Math.abs(p1.w / p1.h - 1.5) < 1e-9, `ratio after the drag: ${p1.w / p1.h}`);
    assert.ok(p1.w < p0.w, 'it got smaller');
    await page.waitForSelector('[data-save-state="saved"]', { timeout: 15000 });
    const doc = Object.values((await db()).docs)[0];
    const layer = doc.content.layers.find((l) => l.id === 'product');
    assert.ok(Math.abs((layer.natural.width * layer.scale) / (layer.natural.height * layer.scale) - 1.5) < 1e-9);
    before = { headline: EDITED, productScale: layer.scale, productX: layer.x, version: doc.version };
  });

  await check('reload from the stubbed server: the same design comes back', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await waitEditor();
    const s = await stageState();
    assert.equal(s.texts.find((t) => t.id === 'headline').lines.join(' '), before.headline);
    const doc = Object.values((await db()).docs)[0];
    const layer = doc.content.layers.find((l) => l.id === 'product');
    assert.equal(layer.scale, before.productScale);
    const img = s.images.find((i) => i.id === 'product');
    assert.ok(Math.abs(img.w - layer.natural.width * layer.scale) < 1e-6, 'drawn at the saved scale');
    assert.ok(await page.textContent('[data-save-state]').then((t) => t.includes(String(before.version))), 'the version on screen is the saved one');
  });

  await check('PNG export: exactly the document size, pixel-identical to the stage drawn at 1×', async () => {
    await page.getByRole('tab', { name: 'التصدير' }).click();
    await page.waitForSelector('[data-export-panel]');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-export-draft="png"]')]);
    assert.match(download.suggestedFilename(), /-draft\.png$/, 'a draft says so in its name');
    const file = `${out}/export-draft.png`;
    await download.saveAs(file);
    const b64 = (await readFile(file)).toString('base64');
    const result = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const W = img.naturalWidth, H = img.naturalHeight;
      const a = document.createElement('canvas');
      a.width = W; a.height = H;
      a.getContext('2d').drawImage(img, 0, 0);
      const exported = a.getContext('2d').getImageData(0, 0, W, H).data;
      const stage = window.Konva.stages.find((s) => s.container().hasAttribute('data-stage'));
      const prev = { size: stage.size(), scale: stage.scale(), pos: stage.position() };
      stage.size({ width: W, height: H });
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });
      const layer = stage.findOne('.content');
      layer.draw();
      const shown = layer.getCanvas()._canvas.getContext('2d').getImageData(0, 0, W, H).data;
      stage.size(prev.size); stage.scale(prev.scale); stage.position(prev.pos); stage.batchDraw();
      let diff = 0;
      for (let i = 0; i < shown.length; i += 4) {
        if (Math.abs(shown[i] - exported[i]) > 2 || Math.abs(shown[i + 1] - exported[i + 1]) > 2 || Math.abs(shown[i + 2] - exported[i + 2]) > 2 || Math.abs(shown[i + 3] - exported[i + 3]) > 2) diff++;
      }
      return { W, H, diff, total: W * H };
    }, b64);
    assert.equal(result.W, 1080);
    assert.equal(result.H, 1080);
    const pct = (100 * result.diff) / result.total;
    notes.push(`     export vs stage at 1x: ${result.diff} of ${result.total} pixels differ (${pct.toFixed(4)} %)`);
    console.log(`     export vs stage at 1x: ${result.diff} of ${result.total} pixels differ (${pct.toFixed(4)} %)`);
    assert.ok(pct < 0.01, `${pct} % of pixels differ`);
    await page.screenshot({ path: `${out}/03-editor-export-1440.png` });
  });

  await check('the checks panel runs with the real measurer and loaded fonts', async () => {
    await page.getByRole('tab', { name: 'الفحص' }).click();
    await page.waitForSelector('[data-qa-panel]');
    const text = await page.textContent('[data-qa-panel]');
    assert.ok(text.includes('اتساع النص'), 'the text-fit check ran');
    assert.ok(!text.includes('خط لم يُحمّل'), 'every font loaded');
    assert.ok(!text.includes('صورة لم تُحمّل'), 'every picture decoded');
    await page.screenshot({ path: `${out}/04-editor-checks-1440.png` });
  });

  await check('a Claude edit scoped to the selection: shown as a diff, applied, saved as an `ai` version with its job', async () => {
    await page.evaluate(() => sessionStorage.setItem('cs-e2e-ai', '1'));
    await page.reload({ waitUntil: 'networkidle' });
    await waitEditor();
    const c = await centreOf({ id: 'headline' });
    await page.mouse.click(c.x, c.y);
    await page.getByRole('tab', { name: 'المحادثة' }).click();
    await page.waitForSelector('[data-chat-panel]');
    const scope = await page.textContent('[data-chat-scope]');
    assert.ok(scope.includes('1') && scope.includes('العنوان'), `the target is spelled out before sending: ${scope}`);
    await page.fill('[data-chat-panel] textarea', 'اختصر العنوان');
    await page.getByRole('button', { name: 'أرسل إلى Claude' }).click();
    await page.waitForSelector('[data-patch-preview]');
    const diff = await page.textContent('[data-patch-preview]');
    assert.ok(diff.includes('العناصر المعدّلة') && diff.includes('العنوان'), diff);
    await page.screenshot({ path: `${out}/08-ai-diff-1440.png` });
    await page.getByRole('button', { name: 'تطبيق' }).click();
    await page.waitForFunction(() => {
      const stage = window.Konva.stages.find((s) => s.container().hasAttribute('data-stage'));
      return stage.findOne('#headline').findOne('.text').text().replace(/\n/g, ' ') === 'طباعة دقيقة بألوان أكثر';
    });
    await page.waitForFunction(() => { const d = window.__csDb(); return d.applied.length === 1; }, null, { timeout: 15000 });
    const saved = await db();
    const id = Object.keys(saved.docs)[0];
    const last = saved.versions[id][saved.versions[id].length - 1];
    assert.equal(last.origin, 'ai');
    assert.equal(last.job_id, 'job_e2e_1');
    assert.deepEqual(saved.applied, [{ job: 'job_e2e_1', version: saved.docs[id].version }], 'the server is told which version the answer became');
  });

  await check('a version conflict stops autosave and offers «open theirs» — nothing is overwritten silently', async () => {
    // Someone else saves first: the stub's copy moves ahead of the version this editor started from.
    const theirs = await page.evaluate(() => {
      const d = window.__csDb();
      const id = Object.keys(d.docs)[0];
      d.docs[id].version += 1;
      d.docs[id].content.layers.find((l) => l.id === 'headline').text = 'نسخة شخص آخر';
      sessionStorage.setItem('cs-e2e-db', JSON.stringify(d));
      return d.docs[id].version;
    });
    const c = await centreOf({ id: 'headline' });
    await page.mouse.click(c.x, c.y);
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('[data-version-conflict]', { timeout: 15000 });
    await page.screenshot({ path: `${out}/09-version-conflict-1440.png` });
    const stillTheirs = await db();
    assert.equal(Object.values(stillTheirs.docs)[0].content.layers.find((l) => l.id === 'headline').text, 'نسخة شخص آخر', 'their save is untouched');
    await page.getByRole('button', { name: 'افتح نسختهم' }).click();
    await page.waitForFunction((t) => {
      const stage = window.Konva.stages.find((s) => s.container().hasAttribute('data-stage'));
      return stage.findOne('#headline').findOne('.text').text().replace(/\n/g, ' ') === t;
    }, 'نسخة شخص آخر');
    assert.ok((await page.textContent('[data-save-state]')).includes(String(theirs)));
    await page.evaluate(() => sessionStorage.removeItem('cs-e2e-ai'));
  });

  await check('every other tab opens on its real state: Brand, Assets, Archive, Settings, Home', async () => {
    const tabs = [
      ['الهوية', '[data-brand-tab]', '10-brand-1440.png'],
      ['الأصول', '[data-assets-tab]', '11-assets-1440.png'],
      ['الأرشيف', '[data-archive-list]', '12-archive-1440.png'],
      ['الإعدادات', '[data-settings-tab] [data-key-source]', '13-settings-1440.png'],
      ['الرئيسية', '[data-recent-drafts]', '14-home-1440.png'],
    ];
    for (const [name, sel, shot] of tabs) {
      await page.getByRole('tab', { name, exact: true }).first().click();
      await page.waitForSelector(sel, { timeout: 15000 });
      // The strip’s indicator travels on a spring; the picture waits for it to land.
      assert.equal(await page.getByRole('tab', { name, exact: true }).first().getAttribute('aria-selected'), 'true');
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${out}/${shot}` });
    }
    // The key field is a password field, empty, with autocomplete off.
    await page.getByRole('tab', { name: 'الإعدادات', exact: true }).first().click();
    const key = await page.$eval('[data-api-key-input]', (el) => ({ type: el.type, value: el.value, ac: el.autocomplete }));
    assert.deepEqual(key, { type: 'password', value: '', ac: 'off' });
    await page.getByRole('tab', { name: 'المحرر', exact: true }).first().click();
    await waitEditor();
  });

  await check('on a phone: the preview owns the screen, panels are bottom sheets with 44 px targets', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle' });
    await waitEditor();
    await page.screenshot({ path: `${out}/05-editor-390.png` });
    const small = await page.$$eval('nav button', (bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.height < 44 || r.width < 44).length);
    assert.equal(small, 0, 'every toolbar target is at least 44 px');
    await page.getByRole('button', { name: 'الطبقات' }).click();
    await page.waitForSelector('[data-layers-panel]');
    await page.screenshot({ path: `${out}/06-editor-layers-sheet-390.png` });
  });

  await check('in Sorani: the editor chrome is Sorani, the ad stays Arabic', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => localStorage.setItem('levo_lang', 'ckb'));
    await page.reload({ waitUntil: 'networkidle' });
    await waitEditor();
    const header = await page.textContent('[data-studio]');
    assert.ok(header.includes('ستۆدیۆی داهێنەرانەی Levonis'));
    await page.screenshot({ path: `${out}/07-editor-ckb-1440.png` });
    await page.evaluate(() => localStorage.setItem('levo_lang', 'ar'));
  });

  await check('nothing was swallowed: no page error reached the console', async () => {
    // The browser's own «Failed to load resource» line names no url; the response listener above
    // records every server error WITH its url instead. Two app-shell requests (the session and the
    // host lookup) are made at import time, before the fixture's stub exists, and reach the dev
    // server's proxy with no Worker behind it — they are not the studio's and are not counted.
    const BOOT = /^HTTP 5\d\d http:\/\/127\.0\.0\.1:\d+\/api\/(auth\/me|storefront\/resolve)$/;
    const fatal = errors.filter((e) => !/^Failed to load resource:/.test(e) && !BOOT.test(e) && !/cdn\.example\.test/.test(e));
    assert.deepEqual(fatal, [], fatal.join('\n'));
  });
} finally {
  await browser.close();
  if (server) server.kill('SIGTERM');
}

await writeFile(`${out}/proof.txt`, notes.join('\n') + '\n');
console.log(`\n${cases} checks passed. Screenshots, the exported PNG and notes in ${out}`);
