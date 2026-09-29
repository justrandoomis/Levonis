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
  { tab: 'foryou', viewer: 'guest', mark: '[data-community-panel="foryou"] [data-community-cover]', issue: true },
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
          // Search: the page becomes its results.
          await page.locator('[data-community-search]').fill('تنين');
          const grid = await page.waitForSelector('[data-projects-grid]', { timeout: 8000 }).then(() => true).catch(() => false);
          check(`${name}: a term turns «لك» into the projects search`, grid);
          check(`${name}: the verbs step aside while searching`, (await page.locator('[data-community-quick-actions]').count()) === 0);
          await page.screenshot({ path: `${out}/search-${tag}.png`, fullPage: false });
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
