#!/usr/bin/env node
/**
 * THE COMMUNITY HOME, PHOTOGRAPHED — tests/browser/community-home.html
 * through Playwright: the six tabs, the two old tab names, the guest and the
 * member and the merchant, the empty community, in Arabic, English and
 * Sorani, dark and cream, on a phone and a wide screen. Checks: the landmark
 * each tab promises, no horizontal overflow, no page errors, one <h1>, six
 * tabs, the cover's alt = the project's title, numbered section heads, the
 * feed's rows and the composer dock once the feed is reached, the search
 * turning the page into its results, and a follow flipping on a rail.
 *
 *   npx vite --port 4191 &   node scripts/e2e-community-home.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.COMMUNITY_URL || 'http://127.0.0.1:4191/tests/browser/community-home.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/community-home';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes += 1;
  else failures.push(`${name} ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : detail}`);
};

/** The fixture's trending list opens with card(1), whose title is «مزهرية حلزونية». */
const COVER_TITLE = 'مزهرية حلزونية';
/** hub/strings.ts requestsForYou — what a merchant's second section is called. */
const MERCHANT_HEADS = ['طلبات تناسبك', 'Requests for your workshop', 'داواکاری گونجاو بۆ تۆ'];

const SCENES = [
  { tab: 'foryou', viewer: 'guest', extra: 'recent=1', mark: '[data-community-panel="foryou"] [data-community-cover]', issue: true },
  { tab: 'foryou', viewer: 'merchant', mark: '[data-community-section="requests"]', merchant: true },
  { tab: 'following', viewer: 'guest', mark: '[data-community-following-guest]' },
  { tab: 'following', viewer: 'customer', mark: '[data-community-following-empty]' },
  { tab: 'following', viewer: 'customer', extra: 'follows=1', mark: '[data-community-feed="following"] [data-post-card]', key: 'following-feed' },
  { tab: 'projects', viewer: 'guest', mark: '[data-community-panel="projects"] [data-projects-grid]' },
  { tab: 'requests', viewer: 'guest', mark: '[data-community-panel="requests"] [data-community-request]' },
  { tab: 'stores', viewer: 'customer', mark: '[data-community-panel="merchants"] [data-community-store]', storeFollow: true },
  { tab: 'creators', viewer: 'customer', mark: '[data-community-panel="creators"] [data-community-creator]', creatorFollow: true },
  { tab: 'products', viewer: 'guest', mark: '[data-community-panel="products"] [data-community-product]', legacy: true },
  { tab: 'merchants', viewer: 'guest', mark: '[data-community-panel="merchants"]', legacy: true },
  { tab: 'foryou', viewer: 'guest', extra: 'empty=1', mark: '[data-community-cover="typeset"]', key: 'foryou-empty', empty: true },
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
        if (theme === 'light' && !(s.issue || s.tab === 'creators' || s.tab === 'requests')) continue; // cream: the issue and two directories
        const key = s.key ?? `${s.tab}-${s.viewer}`;
        const name = `${tag} ${key}`;
        await page.goto(`${base}?lang=${lang}&theme=${theme}&tab=${s.tab}&viewer=${s.viewer}${s.extra ? `&${s.extra}` : ''}`, { waitUntil: 'networkidle' });
        const found = await page.waitForSelector(s.mark, { timeout: 10000, state: 'attached' }).then(() => true).catch(() => false);
        await page.waitForTimeout(500);
        check(`${name}: ${s.mark} present`, found);
        check(`${name}: no horizontal overflow`, (await overflow()) <= 0, `overflow=${await overflow()}`);
        check(`${name}: one h1`, (await page.locator('h1').count()) === 1);
        check(`${name}: six tabs`, (await page.locator('[role="tab"]').count()) === 6, String(await page.locator('[role="tab"]').count()));
        if (s.legacy) {
          const active = await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-tab');
          check(`${name}: the old name opens ${s.tab === 'products' ? 'foryou' : 'stores'}`, active === (s.tab === 'products' ? 'foryou' : 'stores'), `active=${active}`);
        }
        if (s.issue) {
          const alt = await page.locator('[data-community-cover="post"] img').first().getAttribute('alt').catch(() => null);
          check(`${name}: the cover's alt is the project's title`, alt === COVER_TITLE, `alt=${alt}`);
          const numbers = await page.locator('[data-section-number]').allInnerTexts();
          check(`${name}: numbered section heads`, numbers.length >= 5, numbers.join(','));
          const arabicIndic = numbers.every((n) => /^[٠-٩]+$/.test(n.trim()));
          check(`${name}: digits follow the language`, lang === 'en' ? !arabicIndic : arabicIndic, numbers.join(','));
          check(`${name}: quick actions present`, (await page.locator('[data-community-quick-actions] a').count()) === 4);
          // The four verbs are READABLE: a label wraps to a second line rather
          // than being cut mid-word (Sorani «پڕۆژەیەک هاوبەش بکە» at 360 px).
          const clipped = await page.evaluate(() =>
            [...document.querySelectorAll('[data-community-quick-actions] a > span:last-child')]
              .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
              .map((el) => el.textContent)
          );
          check(`${name}: no quick-action label is clipped`, clipped.length === 0, JSON.stringify(clipped));
          check(`${name}: the studio link is there`, (await page.locator('[data-testid="community-studio-link"]').count()) === 1);
          // Reach the feed: it is a lazy chunk mounted as its section approaches.
          await page.locator('[data-community-section="feed"]').scrollIntoViewIfNeeded();
          const rows = await page.waitForSelector('[data-community-feed="foryou"] [data-post-card]', { timeout: 10000 }).then(() => true).catch(() => false);
          check(`${name}: the feed has rows`, rows);
          if (rows) {
            check(`${name}: the composer dock is there`, (await page.locator('[data-community-dock] a').count()) === 1);
            check(`${name}: a project row carries «اطلب طباعته»`, (await page.locator('[data-post-kind="project"] [data-post-print]').count()) >= 1);
            check(`${name}: the social row is on each post`, (await page.locator('[data-post-card] [data-action-row]').count()) >= 12);
            check(`${name}: no horizontal overflow with the feed`, (await overflow()) <= 0, `overflow=${await overflow()}`);
            await page.screenshot({ path: `${out}/feed-${tag}.png`, fullPage: false });
            // Auto-load: the sentinel near the end of the list fetches the next page.
            await page.locator('[data-load-more], [data-community-colophon]').first().scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(900);
            const after = await page.locator('[data-community-feed="foryou"] [data-post-card]').count();
            check(`${name}: the next page arrived on its own`, after > 12, `rows=${after}`);
          }
          check(`${name}: the colophon counts`, (await page.locator('[data-community-colophon]').count()) === 1);
          check(`${name}: «وسوم رائجة» under the cover`, (await page.locator('[data-community-trending-tags] a').count()) === 4);
          await page.evaluate(() => window.scrollTo(0, 0));

          // THE OVERLAY (Phase 3). Focus opens it on its empty state: this
          // browser's recent terms and the trending tags.
          const input = page.locator('[data-community-search]');
          await input.focus();
          const panel = await page.waitForSelector('[data-overlay="community-search"] [data-search-panel]', { timeout: 10000 }).then(() => true).catch(() => false);
          check(`${name}: focus opens the search overlay`, panel);
          await page.waitForTimeout(450); // the panel's spring has settled: sizes are true
          check(`${name}: the input is a combobox naming the listbox`, (await input.getAttribute('role')) === 'combobox' && (await input.getAttribute('aria-expanded')) === 'true' && (await page.locator(`#${await input.getAttribute('aria-controls')}[role="listbox"]`).count()) === 1);
          check(`${name}: the empty box shows recent terms`, (await page.locator('[data-search-recent] [data-search-recent-term]').count()) === 2);
          check(`${name}: the empty box shows trending tags`, (await page.locator('[data-search-trending] [role="option"]').count()) === 4);
          // The listbox owns options and groups only; the recent group is: two terms, their «×», «مسح السجل».
          const listId = await input.getAttribute('aria-controls');
          check(`${name}: the listbox owns only options and groups`, await page.evaluate((id) => {
            const box = document.getElementById(id);
            if (!box) return false;
            return [...box.querySelectorAll('h1,h2,h3,h4,section,p,[role="button"],button:not([role="option"]),a:not([role="option"])')].length === 0 && box.querySelectorAll('[role="group"]').length >= 2;
          }, listId));
          check(`${name}: the recent group holds its «×» and «مسح السجل» as options`, (await page.locator('[data-search-recent] [role="option"]').count()) === 5);
          check(`${name}: the recent options carry no term in their id`, await page.locator('[data-search-recent] [role="option"]').evaluateAll((els) => els.every((el) => /^community-search-listbox-recent-(\d+(-x)?|clear)$/.test(el.id))));
          check(`${name}: «×» is a 44 px target`, ((await page.locator('[data-search-recent] [role="option"][aria-label]').first().boundingBox())?.width ?? 0) >= 44);
          // ↓ ↓ — past «مسح السجل» (the group's head) to the first term — and Delete forgets it.
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('ArrowDown');
          check(`${name}: ↓↓ lights the first recent term`, (await input.getAttribute('aria-activedescendant')) === 'community-search-listbox-recent-0');
          await page.keyboard.press('Delete');
          await page.waitForTimeout(150);
          check(`${name}: Delete forgets the lit recent term`, (await page.locator('[data-search-recent] [data-search-recent-term]').count()) === 1);
          check(`${name}: no horizontal overflow with the overlay`, (await overflow()) <= 0, `overflow=${await overflow()}`);
          await page.screenshot({ path: `${out}/overlay-empty-${tag}.png`, fullPage: false });
          // Escape closes it and the caret stays in the box.
          await page.keyboard.press('Escape');
          const gone = await page.waitForSelector('[data-overlay="community-search"]', { state: 'detached', timeout: 5000 }).then(() => true).catch(() => false);
          check(`${name}: Escape closes the overlay`, gone);
          check(`${name}: focus stays in the box after Escape`, await page.evaluate(() => document.activeElement?.hasAttribute('data-community-search') ?? false));
          // Typing reopens it: suggestions first, then the sections.
          await page.keyboard.type('تنين');
          const sugg = await page.waitForSelector('[data-search-suggestion]', { timeout: 8000 }).then(() => true).catch(() => false);
          check(`${name}: two characters bring suggestions`, sugg);
          const sections = await page.waitForSelector('[data-search-sections]', { timeout: 8000 }).then(() => true).catch(() => false);
          check(`${name}: the term brings the sections`, sections);
          const sectionNames = await page.locator('[data-search-section]').evaluateAll((els) => els.map((el) => el.getAttribute('data-search-section')));
          check(`${name}: projects and products answer «تنين», in the owner's order`, sectionNames.join(',') === 'projects,products', sectionNames.join(','));
          check(`${name}: every section has «الكل»`, (await page.locator('[data-search-more]').count()) === sectionNames.length);
          // A card's own <h3> inside an option is presentational; the LIST has no heading of its own.
          check(`${name}: every section is a labelled group, its heading no heading element`, (await page.locator('[data-search-section][role="group"][aria-labelledby]').count()) === sectionNames.length && (await page.locator(`#${listId} h1, #${listId} h2, #${listId} h3, #${listId} section, #${listId} p`).evaluateAll((els) => els.filter((el) => !el.closest('[role="option"]')).length)) === 0);
          check(`${name}: «الكل» is a 44 px target`, ((await page.locator('[data-search-more]').first().boundingBox())?.height ?? 0) >= 44);
          check(`${name}: no follow pill inside the panel`, (await page.locator('[data-search-panel] [data-community-follow], [data-search-panel] [data-social="follow"]').count()) === 0);
          check(`${name}: the results are said`, ((await page.locator('[data-search-panel] [aria-live="polite"]').innerText()).trim().length) > 0);
          check(`${name}: no horizontal overflow with results`, (await overflow()) <= 0, `overflow=${await overflow()}`);
          // The page behind HOLDS STILL while the panel is open: no ?q= yet, the issue and its verbs remain.
          await page.waitForTimeout(700);
          check(`${name}: the URL waits while the panel is open`, !new URL(page.url()).searchParams.has('q'), page.url());
          check(`${name}: the issue stays behind the panel`, (await page.locator('[data-community-quick-actions]').count()) === 1 && (await page.locator('[data-projects-grid]').count()) === 0);
          // A new letter does not remount the rows: the sections node is the same element
          // («تني» still answers, so the block stays; a space would take the grey word).
          const before = await page.evaluate(() => { const el = document.querySelector('[data-search-sections]'); if (el) el.setAttribute('data-e2e-mark', '1'); return !!el; });
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(900);
          check(`${name}: the results block survives a keystroke`, before && (await page.locator('[data-search-sections][data-e2e-mark="1"]').count()) === 1);
          await page.keyboard.type('ن');
          await page.waitForTimeout(700);
          await page.screenshot({ path: `${out}/search-${tag}.png`, fullPage: false });
          // Escape: the panel steps aside and the URL contract resumes — the page becomes the projects search.
          await page.keyboard.press('Escape');
          const grid = await page.waitForSelector('[data-projects-grid]', { timeout: 8000, state: 'attached' }).then(() => true).catch(() => false);
          check(`${name}: once the panel closes, the term turns «لك» into the projects search`, grid);
          check(`${name}: the verbs step aside while searching`, (await page.locator('[data-community-quick-actions]').count()) === 0);
          check(`${name}: the box keeps its direction after closing`, (await input.getAttribute('dir')) === 'auto');
          // A click reopens it with the term still in the box; ↓ ↓ Enter: past the «ابحث في…» chip to the first suggestion, and through it.
          await input.click();
          const again = await page.waitForSelector('[data-search-suggestion]', { timeout: 8000 }).then(() => true).catch(() => false);
          check(`${name}: a click reopens the panel on the same term`, again);
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('ArrowDown');
          const lit = await input.getAttribute('aria-activedescendant');
          check(`${name}: ↓↓ lights the first suggestion`, !!lit && (await page.locator(`#${lit}[data-search-suggestion]`).count()) === 1, String(lit));
          await page.keyboard.press('Enter');
          const went = await page.waitForSelector('[data-elsewhere]', { timeout: 8000 }).then((el) => el.getAttribute('data-elsewhere')).catch(() => null);
          check(`${name}: Enter opens the lit row`, !!went && went.startsWith('/community/projects/prj_'), String(went));
          continue;
        }
        if (s.merchant) {
          const head = (await page.locator('[data-community-section="requests"] h2').innerText()).trim();
          check(`${name}: a merchant sees «طلبات تناسبك»`, MERCHANT_HEADS.includes(head), head);
        }
        if (s.empty) {
          await page.locator('[data-community-section="feed"]').scrollIntoViewIfNeeded();
          const emptyFeed = await page.waitForSelector('[data-community-section="feed"] [role="status"], [data-community-section="feed"] h3', { timeout: 10000 }).then(() => true).catch(() => false);
          check(`${name}: the empty feed says the first issue is being written`, emptyFeed);
        }
        if (s.storeFollow) {
          const btn = page.locator('[data-community-panel="merchants"] [data-community-follow]').first();
          check(`${name}: store follow starts off`, (await btn.getAttribute('aria-pressed')) === 'false');
          await btn.click();
          await page.waitForTimeout(500);
          check(`${name}: store follow flips on`, (await btn.getAttribute('aria-pressed')) === 'true');
        }
        if (s.creatorFollow) {
          const btn = page.locator('[data-community-panel="creators"] [data-social="follow"]').first();
          check(`${name}: creator follow starts off`, (await btn.getAttribute('aria-pressed')) === 'false');
          await btn.click();
          await page.waitForTimeout(500);
          check(`${name}: creator follow flips on`, (await btn.getAttribute('aria-pressed')) === 'true');
        }
        await page.screenshot({ path: `${out}/${key}-${tag}.png`, fullPage: true });
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
