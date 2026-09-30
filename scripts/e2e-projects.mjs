#!/usr/bin/env node
/**
 * THE PROJECTS' PAGES, PHOTOGRAPHED — tests/browser/projects.html through
 * Playwright: a project (guest, author, the asked customer), a creator, the
 * composer, the list and the saved list, in Arabic, English and Sorani, dark
 * and cream, on a phone and a wide screen. Checks: no horizontal overflow, no
 * page errors, the landmarks each page promises, and the social row's
 * behaviour (Phase 2): a like flips its `aria-pressed` and rolls its count, a
 * follow flips and moves the follower count, the comments sheet opens with
 * its rows and its composer. Phase 4 (§9.4): the project's file rows — two
 * rows, «عرض ثلاثي الأبعاد» minting ONE token for a double tap and opening
 * the viewer, the download hidden from a guest and from a kept file with the
 * sentence why — and the composer's file picker: an STL dropped in becomes an
 * upload tile, then a named row with its «قابل للتنزيل» switch. The cream
 * pass runs with reduced motion on.
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

/** The file rows (§9.4), as a guest, a stranger and the author each see them. */
async function files(page, viewer, tag, check) {
  const rows = await page.locator('[data-project-files] [data-project-file]').count();
  check(`${tag} files: two rows`, rows === 2, `rows=${rows}`);
  const views = await page.locator('[data-project-file-view]').count();
  check(`${tag} files: one «عرض ثلاثي الأبعاد» (the PDF has no mesh)`, views === 1, `views=${views}`);
  const downloads = await page.locator('[data-project-file-download]').count();
  const whys = await page.locator('[data-project-file-why]').count();
  if (viewer === 'guest') {
    check(`${tag} files: a guest gets no download`, downloads === 0, `downloads=${downloads}`);
    check(`${tag} files: a guest is told why, twice`, whys === 2, `whys=${whys}`);
  } else {
    check(`${tag} files: one download — the downloadable file only`, downloads === 1, `downloads=${downloads}`);
    const href = await page.locator('[data-project-file-download]').getAttribute('href');
    check(`${tag} files: the anchor points at the gated route`, href === '/api/community/posts/prj_0/files/f1/download', `href=${href}`);
    check(`${tag} files: the kept file says why`, whys === 1, `whys=${whys}`);
  }
  // A double tap mints ONE token and opens the viewer once.
  const view = page.locator('[data-project-file-view]');
  await view.click();
  await view.click({ force: true }).catch(() => {});
  await page.waitForTimeout(900);
  const lab = await page.evaluate(() => window.__lab);
  check(`${tag} files: a double tap minted one token`, lab.mints === 1, `mints=${lab.mints}`);
  check(`${tag} files: the viewer opened once, on /model-viewer/<token>`, lab.opened.length === 1 && lab.opened[0] === '/model-viewer/tok_1', JSON.stringify(lab.opened));
  check(`${tag} files: no horizontal overflow`, (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
}

/** The composer's file picker: an STL becomes a tile, then a row. */
async function composeFile(page, tag, check, shot) {
  const input = page.locator('[data-project-file-input]');
  check(`${tag} compose: the file input is there`, (await input.count()) === 1);
  // 96 KiB of a binary STL: an 80-byte header, a triangle count, and bytes.
  const bytes = Buffer.alloc(96 * 1024);
  bytes.write('levonis e2e', 0, 'ascii');
  bytes.writeUInt32LE(Math.floor((bytes.length - 84) / 50), 80);
  await input.setInputFiles({ name: 'dragon-body.stl', mimeType: 'model/stl', buffer: bytes });
  const row = await page.waitForSelector('[data-composer-file]', { timeout: 15000 }).then(() => true).catch(() => false);
  check(`${tag} compose: the upload landed as a row`, row);
  if (row) {
    const name = await page.locator('[data-composer-file-name]').inputValue();
    check(`${tag} compose: the row is named after the file`, name === 'dragon-body', `name=${name}`);
    check(`${tag} compose: the «قابل للتنزيل» switch starts off`, (await page.locator('[data-composer-file] [role="switch"]').getAttribute('aria-checked')) === 'false');
    await page.locator('[data-composer-file] [role="switch"]').click();
    await page.waitForTimeout(300);
    check(`${tag} compose: the switch turns on`, (await page.locator('[data-composer-file] [role="switch"]').getAttribute('aria-checked')) === 'true');
    const lab = await page.evaluate(() => window.__lab);
    check(`${tag} compose: one session, one part, one complete`, lab.sessions === 1 && lab.parts === 1 && lab.completed === 1, JSON.stringify({ s: lab.sessions, p: lab.parts, c: lab.completed }));
    await page.locator('[data-composer-files]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/compose-file-${shot}.png`, fullPage: false });
  }
  check(`${tag} compose: no horizontal overflow with the file row`, (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
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
        // The cream pass doubles as the reduced-motion pass: every spring
        // collapses to a cross-fade and the pages must read the same.
        reducedMotion: theme === 'light' ? 'reduce' : 'no-preference',
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
        if (s.page === 'project' && found) await files(page, s.viewer, `${tag} ${s.page}/${s.viewer}`, check);
        if (s.page === 'compose' && found) await composeFile(page, `${tag} ${s.page}/${s.viewer}`, check, tag);
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
