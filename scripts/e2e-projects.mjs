#!/usr/bin/env node
/**
 * THE PROJECTS' PAGES, PHOTOGRAPHED — tests/browser/projects.html through
 * Playwright: a project (guest, author, the asked customer), a creator, the
 * composer and the list, in Arabic, English and Sorani, dark and cream, on a
 * phone and a wide screen. Checks: no horizontal overflow, no page errors,
 * the landmarks each page promises.
 *
 *   npx vite --port 4191 &   node scripts/e2e-projects.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PROJECTS_URL || 'http://127.0.0.1:4191/tests/browser/projects.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/projects';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes += 1;
  else failures.push(`${name} ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : detail}`);
};

const SCENES = [
  { page: 'project', viewer: 'guest', mark: '[data-project-specs]' },
  { page: 'project', viewer: 'author', mark: '[data-project-publish]' },
  { page: 'project', viewer: 'customer', mark: '[data-project-consent]' },
  { page: 'creator', viewer: 'guest', mark: '[data-creator-projects]' },
  { page: 'compose', viewer: 'author', mark: '[data-project-composer]' },
  { page: 'list', viewer: 'guest', mark: '[data-projects-grid]' },
];

const browser = await chromium.launch();
for (const lang of ['ar', 'en', 'ckb']) {
  for (const theme of ['dark', 'light']) {
    for (const width of [360, 1280]) {
      if (lang === 'ckb' && (theme === 'light' || width === 1280)) continue; // Sorani: one representative pass
      const phone = width < 640;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 800 : 900 },
        deviceScaleFactor: 2,
        locale: lang === 'en' ? 'en-US' : 'ar-IQ',
        colorScheme: theme,
        hasTouch: phone,
        isMobile: phone,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const tag = `${lang}-${theme}-${width}`;
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

      for (const s of SCENES) {
        if (theme === 'light' && s.viewer !== 'guest' && s.page === 'project') continue;
        await page.goto(`${base}?lang=${lang}&theme=${theme}&page=${s.page}&viewer=${s.viewer}`, { waitUntil: 'networkidle' });
        const found = await page.waitForSelector(s.mark, { timeout: 8000, state: 'attached' }).then(() => true).catch(() => false);
        await page.waitForTimeout(400);
        check(`${tag} ${s.page}/${s.viewer}: ${s.mark} present`, found);
        check(`${tag} ${s.page}/${s.viewer}: no horizontal overflow`, (await overflow()) <= 0, `overflow=${await overflow()}`);
        await page.screenshot({ path: `${out}/${s.page}-${s.viewer}-${tag}.png`, fullPage: true });
      }
      check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  }
}
await browser.close();
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
