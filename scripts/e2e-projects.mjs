#!/usr/bin/env node
/**
 * THE PROJECTS' PAGES, PHOTOGRAPHED — tests/browser/projects.html through
 * Playwright: a project (guest, author, the asked customer), a creator, the
 * composer, the list and the saved list, in Arabic, English and Sorani, dark
 * and cream, on a phone and a wide screen. Checks: no horizontal overflow, no
 * page errors, the landmarks each page promises, and the social row's
 * behaviour (Phase 2): a like flips its `aria-pressed` and rolls its count, a
 * follow flips and moves the follower count, the comments sheet opens with
 * its rows and its composer.
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
  { page: 'project', viewer: 'eve', mark: '[data-action-row]', social: 'post' },
  { page: 'creator', viewer: 'guest', mark: '[data-creator-projects]' },
  { page: 'creator', viewer: 'eve', mark: '[data-social="follow"]', social: 'creator' },
  { page: 'compose', viewer: 'author', mark: '[data-project-composer]' },
  { page: 'list', viewer: 'guest', mark: '[data-projects-grid]' },
  { page: 'saved', viewer: 'eve', mark: '[data-saved-grid] [data-project-card]' },
];

/** The social row, driven: what a finger does and what must change. */
async function social(page, kind, tag, check) {
  if (kind === 'post') {
    const like = page.locator('[data-action-row] [data-social="like"]');
    const before = await like.getAttribute('aria-pressed');
    check(`${tag} like: starts unpressed`, before === 'false', `aria-pressed=${before}`);
    await like.click();
    await page.waitForTimeout(500);
    check(`${tag} like: aria-pressed flips to true`, (await like.getAttribute('aria-pressed')) === 'true');
    check(`${tag} like: the count moved to 13`, (await like.innerText()).includes('13'), await like.innerText());
    await like.click();
    await page.waitForTimeout(500);
    check(`${tag} like: a second press takes it back`, (await like.getAttribute('aria-pressed')) === 'false');

    const save = page.locator('[data-action-row] [data-social="save"]');
    await save.click();
    await page.waitForTimeout(400);
    check(`${tag} save: aria-pressed flips to true`, (await save.getAttribute('aria-pressed')) === 'true');

    await page.locator('[data-action-row] [data-social="comments"]').click();
    const sheet = await page.waitForSelector('[data-overlay="comments-sheet"]', { timeout: 8000 }).then(() => true).catch(() => false);
    check(`${tag} comments: the sheet opens`, sheet);
    if (sheet) {
      await page.waitForSelector('[data-comments-list] [data-comment]', { timeout: 8000 }).catch(() => {});
      const rows = await page.locator('[data-comments-list] [data-comment]').count();
      check(`${tag} comments: the rows are there (4, one a removed stub)`, rows === 4, `rows=${rows}`);
      check(`${tag} comments: the removed stub keeps its place`, (await page.locator('[data-comment-removed]').count()) === 1);
      check(`${tag} comments: the composer is there for an account`, (await page.locator('[data-comments-composer] textarea').count()) === 1);
      await page.locator('[data-comments-composer] textarea').fill('رائع — كم استغرقت الطباعة؟');
      await page.locator('[data-comments-send]').click();
      await page.waitForTimeout(600);
      const after = await page.locator('[data-comments-list] [data-comment]').count();
      check(`${tag} comments: the new row appears`, after === 5, `rows=${after}`);
      check(`${tag} comments: no horizontal overflow with the sheet open`, (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
      await page.screenshot({ path: `${out}/comments-${tag}.png`, fullPage: false });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
  }
  if (kind === 'creator') {
    const follow = page.locator('header [data-social="follow"]');
    check(`${tag} follow: starts unpressed`, (await follow.getAttribute('aria-pressed')) === 'false');
    await follow.click();
    await page.waitForTimeout(500);
    check(`${tag} follow: aria-pressed flips to true`, (await follow.getAttribute('aria-pressed')) === 'true');
    const followers = await page.locator('[data-creator-followers] [data-count]').innerText();
    check(`${tag} follow: the follower count moved to 42`, followers.trim() === '42', `followers=${followers}`);
    await page.locator('[data-tab="posts"]').click();
    await page.waitForTimeout(500);
    check(`${tag} posts tab: mounts`, (await page.locator('[data-tab-panel="posts"]').count()) === 1);
    check(`${tag} creator menu: present for a stranger`, (await page.locator('[data-creator-menu]').count()) === 1);
  }
}

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
        if (s.social && found) await social(page, s.social, `${tag} ${s.page}/${s.viewer}`, check);
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
