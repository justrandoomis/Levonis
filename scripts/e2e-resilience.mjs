#!/usr/bin/env node
/**
 * RESILIENCE, ON THE REAL BUILD — the four behaviours the P2 review found
 * only a browser can see (docs/PERFORMANCE_LOG.md «P2 review fixes»):
 *
 *   1. the motion-features chunk FAILS → a sheet still paints inside the
 *      viewport, its scrim is visible, no uncaught page error (before: the
 *      dialog stayed parked at y=280 below an 800 px viewport, at opacity 1
 *      but off screen, and the scrim at opacity 0);
 *   2. a full-screen route chunk FAILS (/auth) → the ChunkBoundary card with
 *      its «reload» button, in ar/en/ckb (before: React unmounted the root and
 *      the page was blank);
 *   3. the Kurdish patch face is CONSULTED on a Sorani page: the woff2 is
 *      requested and the ە ێ ۆ run of the H1 is not drawn by a system fallback
 *      (before: `font-weight: 100 900` put the patch in a different weight
 *      group from Cairo's `300 900`, and Chromium never asked for it);
 *   4. reduced motion honoured MID-SESSION: the header search panel springs
 *      open under full motion and is at full height on its first frame after
 *      `emulateMedia({ reducedMotion: 'reduce' })` with no reload.
 *
 * Runs against `npx vite preview --port 4173` of a REAL `npm run build` (the
 * headers file, the hashed chunk names). Service workers are blocked in every
 * context so `page.route` sees the chunk requests.
 *
 *   npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1 &
 *   node scripts/e2e-resilience.mjs [baseUrl]
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
  }
}

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) passed++;
  else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const VIEWPORT = { width: 360, height: 800 };
const KURDISH = /[ړڕڵۆێە]/;

async function context(browser, lang, extra = {}) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
    serviceWorkers: 'block',
    ...extra,
  });
  await ctx.addInitScript((l) => {
    try {
      localStorage.setItem('levo_lang', l);
    } catch {
      /* storage unavailable */
    }
  }, lang);
  return ctx;
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function main() {
  console.log(`\nLEVONIS resilience — ${BASE}\n`);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });

  // ------------------------------------------------ 1. motion chunk failure
  console.log('1. a sheet opened after the motion-features chunk failed is on screen');
  for (const lang of ['ar', 'en']) {
    const ctx = await context(browser, lang);
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    let aborted = 0;
    // The features bundle and the lazy `vendor-motion` chunk — NOT
    // `vendor-motion-core`, which is the entry's static import.
    await page.route(/\/assets\/(motionFeaturesBundle|vendor-motion(?!-core))-[^/]+\.js(\?.*)?$/, (route) => {
      aborted++;
      return route.abort('failed');
    });
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('[data-lang-theme-trigger]', { timeout: 15000 });
    await page.waitForTimeout(600);
    await page.locator('[data-lang-theme-trigger]').first().click();
    await page.waitForTimeout(900);
    const dialog = await page
      .locator('[role="dialog"]')
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), opacity: Number(cs.opacity), transform: cs.transform };
      })
      .catch(() => null);
    check(`${lang}: the chunk was really refused`, aborted >= 1, `aborted=${aborted}`);
    check(`${lang}: the sheet mounted`, !!dialog, 'no [role="dialog"]');
    check(
      `${lang}: the sheet is INSIDE the viewport`,
      !!dialog && dialog.top < VIEWPORT.height - 40 && dialog.bottom > 40 && dialog.height > 40,
      JSON.stringify(dialog)
    );
    check(`${lang}: the sheet is opaque`, !!dialog && dialog.opacity === 1, String(dialog?.opacity));
    const scrim = await page
      .locator('[data-overlay-scrim]')
      .first()
      .evaluate((el) => Number(getComputedStyle(el).opacity))
      .catch(() => null);
    check(`${lang}: the scrim is visible`, scrim === 1, String(scrim));
    const imported = errors.filter((e) => /dynamically imported module|Failed to fetch/i.test(e));
    check(`${lang}: no uncaught chunk error reached the page`, imported.length === 0, imported.join(' | '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    check(`${lang}: Escape still closes it`, (await page.locator('[role="dialog"]').count()) === 0);
    await ctx.close();
  }
  // Control: with the chunk allowed the same sheet animates in and settles opaque.
  {
    const ctx = await context(browser, 'ar');
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('[data-lang-theme-trigger]', { timeout: 15000 });
    await page.waitForTimeout(600);
    await page.locator('[data-lang-theme-trigger]').first().click();
    await page.waitForTimeout(80);
    const mid = await page
      .locator('[role="dialog"]')
      .first()
      .evaluate((el) => Math.round(el.getBoundingClientRect().top))
      .catch(() => null);
    await page.waitForTimeout(900);
    const settled = await page
      .locator('[role="dialog"]')
      .first()
      .evaluate((el) => ({ top: Math.round(el.getBoundingClientRect().top), opacity: Number(getComputedStyle(el).opacity) }))
      .catch(() => null);
    check('control: with the chunk the sheet travels (mid-flight top differs from settled top)', mid !== null && !!settled && mid !== settled.top, JSON.stringify({ mid, settled }));
    check('control: and settles opaque inside the viewport', !!settled && settled.opacity === 1 && settled.top < VIEWPORT.height - 40, JSON.stringify(settled));
    check('control: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ------------------------------------------- 2. full-screen route chunk failure
  console.log('\n2. a failed route chunk on /auth shows the ChunkBoundary card, not a blank root');
  for (const lang of ['ar', 'en', 'ckb']) {
    const ctx = await context(browser, lang);
    const page = await ctx.newPage();
    let aborted = 0;
    await page.route(/\/assets\/Auth-[^/]+\.js(\?.*)?$/, (route) => {
      aborted++;
      return route.abort('failed');
    });
    await page.goto(`${BASE}/auth`, { waitUntil: 'load' });
    const card = await page.waitForSelector('[data-chunk-boundary]', { timeout: 8000 }).then(() => true).catch(() => false);
    const rootLen = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0);
    check(`${lang}: the Auth chunk was refused`, aborted >= 1, `aborted=${aborted}`);
    check(`${lang}: the root is not blank`, rootLen > 0, `rootLen=${rootLen}`);
    check(`${lang}: the ChunkBoundary card is shown`, card);
    if (card) {
      const text = await page.locator('[data-chunk-boundary]').innerText();
      const button = await page.locator('[data-chunk-boundary] button').count();
      check(`${lang}: the card has a reload button`, button >= 1, `buttons=${button}`);
      const expected = { ar: /تحديث|إعادة|تحميل/, en: /reload|refresh|load/i, ckb: /نوێ|بار/ }[lang];
      check(`${lang}: the card speaks the language`, expected.test(text), text.slice(0, 120));
    }
    await ctx.close();
  }

  // --------------------------------------------------- 3. the Kurdish patch face
  console.log('\n3. the Kurdish patch face is fetched and drawn on a Sorani page');
  {
    const ctx = await context(browser, 'ckb');
    const page = await ctx.newPage();
    const fonts = [];
    page.on('request', (r) => {
      if (/\.woff2(\?.*)?$/.test(r.url())) fonts.push(new URL(r.url()).pathname);
    });
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    check('the patch woff2 is requested', fonts.some((f) => f.endsWith('/fonts/cairo-kurdish-patch.woff2')), fonts.join(', '));
    const patchStatus = await page.evaluate(() => {
      const faces = [...document.fonts].filter((f) => /kurdish-patch/.test(String(f.src ?? '')) || (f.family.replace(/"/g, '') === 'Cairo' && /U\+6D5/i.test(f.unicodeRange)));
      return faces.map((f) => `${f.weight}:${f.status}`);
    });
    check('the patch face is loaded (not merely declared)', patchStatus.some((s) => /:loaded$/.test(s)), JSON.stringify(patchStatus));
    check('the patch face declares Cairo\'s 300 900 range', patchStatus.some((s) => s.startsWith('300 900')), JSON.stringify(patchStatus));
    // The platform fonts actually used for a run that contains ە ێ ۆ.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    // The weight-900 H1 first (the heaviest run, where a fallback shows most),
    // then any element whose own text carries one of the six letters.
    const handle = await page.evaluateHandle((re) => {
      const h1 = document.querySelector('h1');
      if (h1 && re.test(h1.textContent || '')) return h1;
      const els = [...document.querySelectorAll('h2, p, span, a, button')];
      return els.find((el) => el.children.length === 0 && re.test(el.textContent || '')) ?? els.find((el) => re.test(el.textContent || '')) ?? null;
    }, new RegExp(KURDISH.source));
    const el = handle.asElement();
    check('a run with the six Kurdish letters is on the page', !!el);
    if (el) {
      const { nodeId } = await cdp.send('DOM.requestNode', { objectId: (await el.evaluateHandle((e) => e))._objectId ?? undefined }).catch(() => ({ nodeId: 0 }));
      let platform = null;
      if (nodeId) platform = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
      else {
        // Fallback: resolve by walking the flattened document for the element's backend id.
        const { nodeId: qid } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: await el.evaluate((e) => (e.id ? `#${CSS.escape(e.id)}` : e.tagName.toLowerCase())) });
        if (qid) platform = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId: qid })).fonts;
      }
      const families = (platform ?? []).map((f) => `${f.familyName}×${f.glyphCount}`);
      check('no system fallback (DejaVu/Noto/Liberation) draws the run', !!platform && !platform.some((f) => /DejaVu|Noto|Liberation/i.test(f.familyName)), families.join(', '));
      check('Cairo draws most of the run', !!platform && platform.some((f) => /Cairo/i.test(f.familyName)), families.join(', '));
    }
    await ctx.close();
  }

  // --------------------------------------------- 4. reduced motion, mid-session
  console.log('\n4. reduced motion is honoured mid-session on the header search panel');
  {
    const ctx = await context(browser, 'ar');
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    const input = page.locator('input[role="combobox"]').first();
    await input.waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    // The sampler is armed BEFORE the keystrokes: on the first open the panel's
    // chunk still has to arrive, and a sampler started after `waitForSelector`
    // would miss the first frames of the spring.
    const openAndSample = async () => {
      await page.evaluate(() => {
        window.__panelFrames = new Promise((resolve) => {
          const obs = new MutationObserver(() => {
            const el = document.querySelector('[data-testid="search-panel"]');
            if (!el) return;
            obs.disconnect();
            const heights = [];
            const tick = () => {
              heights.push(Math.round(el.getBoundingClientRect().height));
              if (heights.length < 12) requestAnimationFrame(tick);
              else resolve(heights);
            };
            tick();
          });
          obs.observe(document.body, { childList: true, subtree: true });
        });
      });
      await input.focus();
      await page.keyboard.type('pla');
      await page.waitForSelector('[data-testid="search-panel"]', { timeout: 10000 });
      return page.evaluate(() => window.__panelFrames);
    };
    const close = async () => {
      await page.keyboard.press('Escape');
      await input.fill('');
      await page.locator('body').click({ position: { x: 5, y: 700 } });
      await page.waitForSelector('[data-testid="search-panel"]', { state: 'detached', timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
    };
    const full = await openAndSample();
    const fullRatio = full[0] / Math.max(1, full[full.length - 1]);
    check('full motion: the panel grows over several frames', full[full.length - 1] > 0 && fullRatio < 0.8, JSON.stringify(full));
    await close();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await openAndSample();
    const reducedRatio = reduced[0] / Math.max(1, reduced[reduced.length - 1]);
    check('reduced motion (set mid-session, no reload): full height on the first frame', reduced[reduced.length - 1] > 0 && reducedRatio >= 0.9, JSON.stringify(reduced));
    await close();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const back = await openAndSample();
    const backRatio = back[0] / Math.max(1, back[back.length - 1]);
    check('toggled back: it springs again', back[back.length - 1] > 0 && backRatio < 0.8, JSON.stringify(back));
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
