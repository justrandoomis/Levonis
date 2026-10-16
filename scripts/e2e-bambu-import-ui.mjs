#!/usr/bin/env node
/**
 * THE IMPORTED PRODUCT PAGE IN A REAL BROWSER (the Bambu import spec §G.2–§G.5,
 * §I.1.7; §K.2 step 7 «a Playwright local e2e on fixture data»).
 *
 * The real built SPA, the real Worker under `wrangler dev --local` and a real
 * local D1 at the newest migration, seeded by
 * scripts/lib/e2e-bambu-import-ui-seed.ts with two IMPORTED-STYLE products the
 * import's own package builds from the committed fixtures (PLA Basic: 30
 * colour swatches, a spool group and a single-value weight group, documents;
 * H2D: versions and bundles, 95 typed specifications, the box, representative
 * pictures with their source variant).
 *
 *   1  PLA BASIC, every language × phone / desktop × light / dark:
 *        - the default selection is applied (the default colour, the spool
 *          default and the single-value weight) and the hero is that colour's
 *          own picture;
 *        - the colour group is drawn as swatches whose accessible name is the
 *          value's name; another colour moves the hero and no picture of
 *          another colour stays in the gallery;
 *        - «السعر غير متوفر حالياً», no buying control;
 *        - the knowledge tabs load only near the viewport and list the
 *          documents, each opening in a new tab with noopener noreferrer and
 *          saying it opens on the manufacturer's site.
 *   2  H2D: the specifications tab shows the typed rows (ar/en/ckb); on the
 *      desktop (the review of step 7): the tab strip shows every label whole;
 *      every US 110 V row sits under the collapsed «إصدارات أخرى», which shows
 *      a chevron; each <dl> holds only rows of <dt>/<dd>; the packaging tab
 *      reads the net weight as published («31 kg»); a compatible product opens
 *      in the app (no reload); and the two versions the opening selection
 *      does not offer are pressable, and a press selects one.
 *   3  The leak scan: no store page address, no swatch source and no CBM in any
 *      answer the page received.
 * Screens at 390×844 and 1280×900, light and dark, in SHOTS_DIR.
 *
 * LOCAL ONLY. The Worker listens on 127.0.0.1; every browser request to any
 * other host is aborted and counted, and the run fails unless that count is 0
 * and no page or console error was thrown. The database is a fresh
 * `--persist-to` directory this script creates.
 *
 * How to run (one heavy process — run it alone):
 *   npm run build
 *   OUT_DIR=/tmp/e2e-bambu-ui SHOTS_DIR=/tmp/e2e-bambu-ui/shots node scripts/e2e-bambu-import-ui.mjs
 *
 * Env: OUT_DIR, SHOTS_DIR, PORT (default 8857), CHROMIUM_PATH, PLAYWRIGHT_MODULE, KEEP_DEV=1.
 */
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { splitStatements } from './lib/sql-split.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.js');
const PORT = Number(process.env.PORT || 8857);
const BASE = `http://127.0.0.1:${PORT}`;
const LOCAL_HOST = new URL(BASE).host;
const OUT = process.env.OUT_DIR || '/tmp/e2e-bambu-ui';
const SHOTS = process.env.SHOTS_DIR || join(OUT, 'shots');
const PERSIST = join(OUT, 'persist');
const WRANGLER = process.env.WRANGLER || join(ROOT, 'node_modules/.bin/wrangler');
if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('dist/ is missing: run `npm run build` first');
mkdirSync(SHOTS, { recursive: true });

const UNPRICED = { ar: 'السعر غير متوفر حالياً', en: 'Price not available yet', ckb: 'نرخ هێشتا بەردەست نییە' };
const OPENS = { ar: 'يُفتح في موقع الشركة المصنّعة', en: "Opens on the manufacturer's site", ckb: 'لە ماڵپەڕی بەرهەمهێنەر دەکرێتەوە' };
const TAB_DOCS = { ar: 'المستندات والأدلة', en: 'Documents & manuals', ckb: 'بەڵگەنامە و ڕێنماییەکان' };
const TAB_SPECS = { ar: 'المواصفات', en: 'Specifications', ckb: 'تایبەتمەندییەکان' };
const TAB_PACK = { ar: 'التغليف والشحن', en: 'Packaging & shipping', ckb: 'پاکەتکردن و ناردن' };
const TAB_COMPAT = { ar: 'التوافق', en: 'Compatibility', ckb: 'گونجاوی' };

/** In the open tab: every US 110 V note inside «إصدارات أخرى», and every <dl> holding only rows of <dt>/<dd>. */
async function knowledgeMarkup(page) {
  return page.evaluate(() => {
    const us = [...document.querySelectorAll('[data-knowledge-note="us_110v"]')];
    const outside = us.filter((n) => !n.closest('details[data-knowledge-other]')).map((n) => n.closest('[data-knowledge-row]')?.getAttribute('data-knowledge-row'));
    const badDl = [...document.querySelectorAll('[data-knowledge] dl')].flatMap((dl) =>
      [...dl.children].filter((row) => row.tagName !== 'DIV' || [...row.children].some((c) => c.tagName !== 'DT' && c.tagName !== 'DD')).map((row) => row.outerHTML.slice(0, 120))
    );
    const chevrons = [...document.querySelectorAll('details[data-knowledge-other] > summary')].map((s) => !!s.querySelector('svg'));
    return { us: us.length, outside, badDl, chevrons };
  });
}
const ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_UPDATE_NOTIFIER: '1' };

// ------------------------------------------------------------------ the local database

function initLocalD1() {
  rmSync(PERSIST, { recursive: true, force: true });
  mkdirSync(PERSIST, { recursive: true });
  execFileSync(WRANGLER, ['d1', 'execute', 'levonis-db', '--local', '--persist-to', PERSIST, '--command', 'SELECT 1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
  const dir = join(PERSIST, 'v3/d1/miniflare-D1DatabaseObject');
  const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (!file) throw new Error(`no local D1 file under ${dir}`);
  return join(dir, file);
}

/** Every migration the way D1 applies it (one transaction each, bookkeeping in d1_migrations). */
function applyMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    db.exec('BEGIN');
    try {
      for (const s of splitStatements(readFileSync(join(ROOT, 'migrations', f), 'utf8'))) db.exec(s);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`${f}: ${e.message}`);
    }
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
  }
  return files;
}

// ------------------------------------------------------------------ checks and results

const results = { started_at: new Date().toISOString(), base: BASE, cases: {}, blocked: [], page_errors: [], console_errors: [], failures: [], shots: [], dev_exits: [] };
let current = 'setup';
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  const entry = { name, ok: !!ok, ...(detail === undefined ? {} : { detail }) };
  (results.cases[current] ??= []).push(entry);
  console.log(`${ok ? '  ok  ' : '  FAIL'} [${current}] ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!ok) results.failures.push(`[${current}] ${name}`);
  return !!ok;
}

// ------------------------------------------------------------------ the dev server

let dev = null;
async function startDev() {
  const log = createWriteStream(join(OUT, 'wrangler-dev.log'));
  dev = spawn(WRANGLER, ['dev', '--local', '--persist-to', PERSIST, '--ip', '127.0.0.1', '--port', String(PORT), '--show-interactive-dev-session=false'], {
    cwd: ROOT,
    env: { ...ENV, WRANGLER_LOG: process.env.WRANGLER_LOG || 'log' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const mine = dev;
  mine.on('exit', (code, signal) => {
    if (!mine.stopping) results.dev_exits.push(`${current}: wrangler dev exited (code ${code}, signal ${signal})`);
  });
  dev.stdout.pipe(log);
  dev.stderr.pipe(log);
  for (let i = 0; i < 360; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/settings/public`);
      if (r.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not answer in 180 s (see wrangler-dev.log)');
}
function stopDev() {
  if (dev && !process.env.KEEP_DEV) {
    dev.stopping = true;
    try {
      process.kill(-dev.pid, 'SIGINT');
    } catch {
      /* gone */
    }
    dev = null;
  }
}

// ------------------------------------------------------------------ the browser

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const VIEW = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } };
const answers = [];

/** A guest's browser session. Every non-local request is aborted and counted. */
async function session({ view = 'desktop', lang = 'ar', theme = 'light' } = {}) {
  const ctx = await browser.newContext({
    viewport: VIEW[view],
    deviceScaleFactor: 1,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
    serviceWorkers: 'block',
    hasTouch: view === 'phone',
    isMobile: view === 'phone',
    colorScheme: theme,
  });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    let host = '';
    try {
      host = new URL(u).host;
    } catch {
      /* data: */
    }
    if (host === LOCAL_HOST || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    results.blocked.push(`${current}: ${u.slice(0, 160)}`);
    return route.abort('blockedbyclient');
  });
  await ctx.addInitScript(
    ([l, t]) => {
      try {
        localStorage.setItem('levo_lang', l); // src/LanguageContext.tsx
        localStorage.setItem('levonis.theme.v1', t); // src/lib/theme.ts
      } catch {
        /* storage blocked */
      }
    },
    [lang, theme]
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => results.page_errors.push(`${current}: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;
    results.console_errors.push(`${current}: ${t.slice(0, 300)}`);
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.startsWith(BASE) || !new URL(url).pathname.startsWith('/api/')) return;
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* aborted */
    }
    answers.push({ path: decodeURIComponent(new URL(url).pathname), status: res.status(), text });
  });
  return { ctx, page };
}

/** Waits until no request has been made for `quietMs`. */
async function settle(page, quietMs = 900, maxMs = 30000) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const start = Date.now();
  let last = await page.evaluate(() => performance.getEntriesByType('resource').length).catch(() => 0);
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(150);
    const n = await page.evaluate(() => performance.getEntriesByType('resource').length).catch(() => last);
    if (n !== last) {
      last = n;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) return;
  }
}
async function shot(page, name, fullPage = false) {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage }).catch((e) => console.log(`  (screenshot ${name}: ${e.message})`));
  results.shots.push(path);
}
async function visit(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await settle(page, 1100);
}
/** The main picture's file, and every picture of the gallery strip (thumbnails included). */
const heroUrl = (page) =>
  page.evaluate(() => {
    const img = document.querySelector('main section img, section img');
    return img ? new URL(img.getAttribute('src') || '', location.href).pathname : '';
  });
const galleryUrls = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('section img')?.closest('section');
    return section ? [...section.querySelectorAll('img')].map((i) => new URL(i.getAttribute('src') || '', location.href).pathname) : [];
  });

/**
 * Brings the knowledge slot near the viewport (it takes no room until it has something
 * to show, so it is scrolled to by script) and waits for the tabs to arrive.
 */
async function nearKnowledge(page) {
  await page.evaluate(() => document.querySelector('[data-product-knowledge]')?.scrollIntoView({ block: 'center' }));
  await page.locator('[data-knowledge]').first().waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
}

// ================================================================== run
let W = null;
try {
  current = 'setup';
  const dbFile = initLocalD1();
  {
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA foreign_keys = ON');
    const files = applyMigrations(db);
    check('the database stands at the newest migration (0194 knowledge, 0195 runs)', files.some((f) => f.startsWith('0194')) && files.some((f) => f.startsWith('0195')), files.at(-1));
    db.close();
  }
  const mediaDir = join(OUT, 'media');
  W = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/lib/e2e-bambu-import-ui-seed.ts'), dbFile, mediaDir], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').at(-1));
  check('the seed wrote the two imported-style products', !!W?.pla?.id && !!W?.h2d?.id, Object.keys(W ?? {}));
  for (const u of W.uploads) {
    execFileSync(WRANGLER, ['r2', 'object', 'put', `levonis-media-public/${u.key}`, '--file', u.file, '--content-type', 'image/webp', '--local', '--persist-to', PERSIST], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
  }
  check('every picture is in the local bucket', W.uploads.length > 30, W.uploads.length);
  await startDev();

  const colour = W.pla.groups.find((g) => g.kind === 'color');
  const jade = colour.values.find((v) => v.id === colour.default_value_id);
  const orange = colour.values.find((v) => /^Orange/.test(v.name_en));
  /** The pictures a value shows: bound to it, or to a variant (or a source variant) that contains it. */
  const combo = new Map(W.pla.variants.map((v) => [v.id, v.combo_key.split('|')]));
  const boundTo = (id) =>
    W.pla.images
      .filter((i) => i.option_value_id === id || (combo.get(i.variant_id ?? '') ?? []).includes(`o:${id}`))
      .map((i) => i.url);

  // ---------------------------------------------------------------- 1. PLA Basic, the matrix
  current = '1-pla';
  for (const lang of ['ar', 'en', 'ckb']) {
    for (const view of ['phone', 'desktop']) {
      for (const theme of ['light', 'dark']) {
        const tag = `${lang}-${view}-${theme}`;
        const first = lang === 'ar' && view === 'phone' && theme === 'light';
        const { ctx, page } = await session({ view, lang, theme });
        const before = answers.length;
        await visit(page, `/product/${W.pla.slug}`);
        const text = await page.locator('body').innerText();
        check(`${tag}: «${UNPRICED[lang]}»`, text.includes(UNPRICED[lang]), text.slice(0, 200));
        const jadeSwatch = page.locator(`[data-swatch="${jade.id}"]:visible`).first();
        check(`${tag}: the default colour is preselected`, (await jadeSwatch.getAttribute('aria-pressed')) === 'true');
        check(`${tag}: a swatch's accessible name is the value's name`, ((await jadeSwatch.getAttribute('aria-label')) ?? '').startsWith(jade.name_en));
        if (first) {
          const pressed = await page.locator('[data-option-group] button[aria-pressed="true"]:visible').count();
          check('every group opens chosen: the colour, the spool default and the single-value weight', pressed === W.pla.groups.length, pressed);
          const hero = await heroUrl(page);
          check('the hero is the default colour’s own picture', boundTo(jade.id).includes(hero), { hero, bound: boundTo(jade.id) });
          const fit = await jadeSwatch.locator('img').first().evaluate((i) => [getComputedStyle(i).objectFit, i.getBoundingClientRect().width]);
          check('a swatch is a colour sample: object-fit cover, 28 px', fit[0] === 'cover' && Math.round(fit[1]) === 28, fit);
          check('no add-to-cart, buy-now or Quick Buy control', !/أضف إلى السلة|اشترِ الآن/.test(text));
          const early = answers.slice(before).filter((a) => a.path.endsWith('/knowledge')).length;
          check('the knowledge answer is not fetched on first paint', early === 0, early);
        }
        await shot(page, `pla-top-${tag}`);
        if (orange) {
          await page.locator(`[data-swatch="${orange.id}"]:visible`).first().click();
          await page.waitForTimeout(500);
          if (first) {
            const hero = await heroUrl(page);
            check('Orange moves the hero to the Orange picture', boundTo(orange.id).includes(hero), { hero });
            const shown = await galleryUrls(page);
            const others = colour.values
              .filter((v) => v.id !== orange.id)
              .flatMap((v) => boundTo(v.id))
              .filter((u) => !boundTo(orange.id).includes(u));
            check('no other colour’s picture is in the gallery', !shown.some((u) => others.includes(u)), shown);
          }
          await page.locator(`[data-swatch="${jade.id}"]:visible`).first().click();
          await page.waitForTimeout(300);
        }
        // The knowledge tabs: fetched near the viewport, then the documents.
        await nearKnowledge(page);
        await settle(page, 1100);
        if (view === 'desktop') {
          const tab = page.locator('[role="tab"]').filter({ hasText: TAB_DOCS[lang] }).first();
          if (await tab.count()) await tab.click();
        } else {
          const sec = page.locator('[data-section="knowledge-documents"] > button').first();
          if (await sec.count()) await sec.click();
        }
        await page.waitForTimeout(600);
        const docsBox = page.locator('[data-knowledge-tab="documents"]').first();
        await docsBox.scrollIntoViewIfNeeded().catch(() => {});
        const docs = docsBox.locator('a');
        const n = await docs.count();
        check(`${tag}: the documents are listed`, n > 0, n);
        if (n) {
          const rel = await docs.first().getAttribute('rel');
          const target = await docs.first().getAttribute('target');
          check(`${tag}: a document opens in a new tab, noopener noreferrer`, target === '_blank' && rel === 'noopener noreferrer', { rel, target });
          check(`${tag}: «${OPENS[lang]}»`, (await docsBox.innerText()).includes(OPENS[lang]));
        }
        const noSide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        check(`${tag}: no horizontal scroll`, noSide);
        await shot(page, `pla-knowledge-${tag}`);
        await ctx.close();
      }
    }
  }

  // ---------------------------------------------------------------- 2. H2D
  current = '2-h2d';
  for (const lang of ['ar', 'en', 'ckb']) {
    for (const [view, theme] of [['desktop', 'light'], ['phone', 'dark']]) {
      const tag = `${lang}-${view}-${theme}`;
      const { ctx, page } = await session({ view, lang, theme });
      await visit(page, `/product/${W.h2d.slug}`);
      await shot(page, `h2d-top-${tag}`);
      await nearKnowledge(page);
      await settle(page, 1100);
      if (view === 'phone') {
        const sec = page.locator('[data-section="knowledge-specs"] > button').first();
        if (await sec.count()) await sec.click();
        await page.waitForTimeout(400);
      }
      const specs = page.locator('[data-knowledge-tab="specs"]').first();
      const rows = await specs.locator('[data-knowledge-row]').count();
      check(`${tag}: «${TAB_SPECS[lang]}» shows the typed rows`, rows > 10, rows);
      await specs.scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, `h2d-knowledge-${tag}`);
      if (view === 'desktop') {
        // The tab strip: every label whole, inside the strip (it wraps rather than clip at the 68ch column).
        const strip = await page.evaluate(() => {
          const list = document.querySelector('[data-knowledge="tabs"] [role="tablist"]');
          if (!list) return null;
          const box = list.getBoundingClientRect();
          const tabs = [...list.querySelectorAll('[role="tab"]')].map((t) => t.getBoundingClientRect());
          return { overflow: list.scrollWidth - list.clientWidth, cut: tabs.filter((r) => r.left < box.left - 1 || r.right > box.right + 1).length, tabs: tabs.length };
        });
        check(`${tag}: the knowledge tab strip shows every label whole`, !!strip && strip.tabs >= 4 && strip.overflow <= 1 && strip.cut === 0, strip);
        const specsMarkup = await knowledgeMarkup(page);
        check(`${tag}: the US 110 V rows sit only under «إصدارات أخرى» (L-20)`, specsMarkup.us > 0 && specsMarkup.outside.length === 0, specsMarkup);
        check(`${tag}: «إصدارات أخرى» shows a chevron`, specsMarkup.chevrons.length > 0 && specsMarkup.chevrons.every(Boolean), specsMarkup.chevrons);
        check(`${tag}: each <dl> holds only rows of <dt>/<dd>`, specsMarkup.badDl.length === 0, specsMarkup.badDl.slice(0, 3));
        // Packaging: the weight as published, the US package and weights under «إصدارات أخرى».
        await page.locator('[role="tab"]').filter({ hasText: TAB_PACK[lang] }).first().click();
        await page.waitForTimeout(500);
        const pack = page.locator('[data-knowledge-tab="packaging"]').first();
        const packText = await pack.innerText().catch(() => '');
        check(`${tag}: the net weight reads as published («31 kg»)`, /\b31 kg\b/.test(packText) && !/31000 g/.test(packText), packText.slice(0, 300));
        const packMarkup = await knowledgeMarkup(page);
        check(`${tag}: no US 110 V line among the product's packaging facts`, packMarkup.outside.length === 0 && packMarkup.us > 0, packMarkup);
        // Compatibility: the router's link — the page is not reloaded.
        await page.locator('[role="tab"]').filter({ hasText: TAB_COMPAT[lang] }).first().click();
        await page.waitForTimeout(500);
        await page.evaluate(() => {
          window.__noReload = true;
        });
        const link = page.locator('[data-knowledge-tab="compatibility"] a[href^="/product/"]').first();
        if (await link.count()) {
          await link.click();
          await page.waitForURL(/\/product\/bambu-lab-a1/, { timeout: 10000 }).catch(() => {});
          const same = await page.evaluate(() => window.__noReload === true);
          check(`${tag}: a compatible product opens in the app, no reload`, /\/product\/bambu-lab-a1/.test(page.url()) && same, page.url());
          await visit(page, `/product/${W.h2d.slug}`);
        } else {
          check(`${tag}: a compatible product is linked`, false, 'no link in the compatibility tab');
        }
        // The two versions the opening selection does not offer: pressable, and a press selects one.
        const version = W.h2d.groups.find((g) => g.values.some((v) => v.name_en === 'H2D Laser Full Combo'));
        const laser = version?.values.find((v) => v.name_en === 'H2D Laser Full Combo');
        const groupBox = page.locator(`[data-option-group="${version?.id}"]:visible`).first();
        const disabled = await groupBox.locator('button[disabled]').count();
        check(`${tag}: no version is a disabled button on opening`, disabled === 0, disabled);
        const laserBtn = groupBox.locator('button').filter({ hasText: 'H2D Laser Full Combo' }).first();
        const offeredBefore = await laserBtn.getAttribute('data-offered');
        await laserBtn.click();
        await page.waitForTimeout(400);
        check(
          `${tag}: «H2D Laser Full Combo», not offered with «Standard», is chosen by one press`,
          !!laser && offeredBefore === 'false' && (await laserBtn.getAttribute('aria-pressed')) === 'true',
          { offeredBefore, pressed: await laserBtn.getAttribute('aria-pressed') }
        );
      }
      await ctx.close();
    }
  }

  // ---------------------------------------------------------------- 3. what never reached the browser
  current = '3-leaks';
  const all = answers.map((a) => a.text).join('\n');
  check('no store page address in any answer', !/us\.store\.bambulab\.com/.test(all));
  // A swatch's source address and its hex reference are owner-only (0194 product_option_value_swatches).
  const swatchLeaks = (W.pla.swatchSources ?? []).filter((u) => all.includes(u));
  check('no swatch provenance in any answer', W.pla.swatchSources?.length > 0 && swatchLeaks.length === 0 && !/"hex_source_ref"/.test(all), swatchLeaks.slice(0, 3));
  check('no picture names a source address (every media source_url empty)', !/"source_url":"https?:/.test(all));
  check('no CBM in any answer', !/volume_m3/.test(all));
  const knowledge = answers.filter((a) => a.path.endsWith('/knowledge'));
  check('the knowledge answers were fetched, all 200', knowledge.length > 0 && knowledge.every((a) => a.status === 200), knowledge.map((a) => a.status));
} catch (e) {
  results.failures.push(`[${current}] crashed: ${e?.stack ?? e}`);
  console.error(e);
} finally {
  current = 'teardown';
  check('no request left the local host', results.blocked.length === 0, results.blocked.slice(0, 10));
  check('no page error', results.page_errors.length === 0, results.page_errors.slice(0, 10));
  check('no console error', results.console_errors.length === 0, results.console_errors.slice(0, 10));
  await browser.close().catch(() => {});
  stopDev();
  results.finished_at = new Date().toISOString();
  results.checks = checks;
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${results.failures.length ? 'FAILED' : 'PASSED'}: ${checks} checks, ${results.failures.length} failures. Results: ${join(OUT, 'results.json')}`);
  process.exitCode = results.failures.length ? 1 : 0;
}
