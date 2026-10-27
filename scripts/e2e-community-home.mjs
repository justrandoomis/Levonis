#!/usr/bin/env node
/**
 * THE COMMUNITY HOME, PHOTOGRAPHED — tests/browser/community-home.html
 * through Playwright (community UI plan C1; IMG_8487, IMG_8462): the guest,
 * the member and the merchant, the empty community, in Arabic, English and
 * Sorani, dark and cream, on a phone and a wide screen. Checks: one <h1>
 * after the wordmark, the six sections as links with «لك» the page on screen,
 * the two verbs (the gold one first), the featured project (its alt is the
 * project's title, its kicker the honest «مشروع رائج»), the trending cards,
 * the request rows (never a budget), the makers, the Studio anchor, no
 * horizontal overflow, no page errors, the feed's rows once reached, the
 * search turning the page into its results, the avatar opening the sections
 * and account menu (Escape closes it, focus comes back), ONE GET /api/chats
 * a page with the badge on the top bar, a like and a follow flipping, and
 * every old `?tab=` address landing on its section page with its term.
 *
 *   «طلبات تناسبك» (Phase 5d, §9.5): a signed-in WORKSHOP's home has its own
 *   board under the sections, above the featured project, «عرض الكل» to the
 *   board; the home's own section keeps its plain «طلبات الطباعة»; an empty
 *   board says so in one sentence with the preferences one tap away; a
 *   customer and a guest see no rail at all.
 *
 *   Link cards (§9.4): a post whose words name a model page carries its card,
 *   a video's card has no print door, an address nobody resolved draws
 *   nothing, and the page asks GET /api/link-cards ONCE per distinct address;
 *   the project's story draws the full card and its door opens the request
 *   editor with `?link=`.
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

/** The fixture's trending list opens with card(1), whose title is «مزهرية حلزونية», the featured project. */
const COVER_TITLE = 'مزهرية حلزونية';
/** hub/strings.ts trendingKicker: the pick is the 30-day trending one, never «مميز». */
const KICKERS = ['مشروع رائج', 'Trending project', 'پڕۆژەی باو'];
/** The old `?tab=` addresses and their section pages (hub/tabs.ts). */
const REDIRECTS = [
  ['following', '/community/following'],
  ['projects', '/community/projects?q=dragon'],
  ['requests', '/requests?q=dragon'],
  ['stores', '/community/stores?q=dragon'],
  ['merchants', '/community/stores?q=dragon'],
  ['creators', '/community/makers?q=dragon'],
];
/** hub/strings.ts requestsForYou — the title of a merchant's own board (hub/BoardRail.tsx). */
const MERCHANT_HEADS = ['طلبات تناسبك', 'Requests for your workshop', 'داواکاری گونجاو بۆ تۆ'];
/** hub/strings.ts printRequests — the issue's own section, the board's newest three, for everyone. */
const PLAIN_HEADS = ['طلبات الطباعة', 'Print requests', 'داواکارییەکانی چاپ'];
/** The model page several fixture posts name (one ask for all of them) and its door into the wizard. */
const LINKED_MODEL = 'https://www.printables.com/model/1234-articulated-dragon';
const PRINT_DOOR = `/requests?view=new&link=${encodeURIComponent(LINKED_MODEL)}`;
/** Our re-hosted copy of a card's picture (`/files/link-cards/<id>.webp`), served here since there is no worker. */
const LINK_PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9e2d3"/><stop offset="1" stop-color="#b8ad96"/></linearGradient></defs><rect width="1200" height="630" fill="url(#g)"/><path d="M260 470 q120 -300 380 -220 t330 90 q80 60 -40 120 t-300 -30 q-170 -30 -230 110 z" fill="#6c7a4a"/><circle cx="880" cy="290" r="22" fill="#111"/></svg>`;

const SCENES = [
  { viewer: 'guest', extra: 'recent=1', mark: '[data-community-panel="foryou"] [data-community-featured]', issue: true },
  { viewer: 'merchant', mark: '[data-community-section="requests"]', merchant: true },
  // «طلبات تناسبك» (Phase 5d): a customer's home has no rail; a workshop with nothing that fits is told so.
  { viewer: 'customer', mark: '[data-community-panel="foryou"] [data-community-featured]', key: 'foryou-customer', noRail: true, member: true },
  { viewer: 'merchant', extra: 'empty=1', mark: '[data-community-board-empty]', key: 'foryou-merchant-empty', boardEmpty: true },
  { viewer: 'guest', extra: 'extra=list%3Dproducts', mark: '[data-community-panel="products"] [data-community-product]', key: 'products' },
  { viewer: 'guest', extra: 'empty=1', mark: '[data-community-featured="typeset"]', key: 'foryou-empty', empty: true },
  { viewer: 'customer', extra: 'path=/community/projects/prj_2', mark: '[data-link-card][data-link-variant="full"]', key: 'project-link', project: true },
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
        // The Sorani pass is also the reduced-motion pass: the cards must land without their travel.
        reducedMotion: lang === 'ckb' ? 'reduce' : 'no-preference',
      });
      // Every layout shift not caused by input, summed per page load (the rail's frame check below).
      await context.addInitScript(() => {
        window.__lvShifts = [];
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) if (!e.hadRecentInput) window.__lvShifts.push(e.value);
          }).observe({ type: 'layout-shift', buffered: true });
        } catch {
          /* no layout-shift entries in this browser */
        }
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/files/link-cards/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: LINK_PICTURE }));
      const tag = `${lang}-${theme}-${width}`;
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

      for (const s of SCENES) {
        if (theme === 'light' && !(s.issue || s.merchant || s.member)) continue; // cream: the home of each viewer
        const key = s.key ?? `foryou-${s.viewer}`;
        const name = `${tag} ${key}`;
        await page.goto(`${base}?lang=${lang}&theme=${theme}&viewer=${s.viewer}${s.extra ? `&${s.extra}` : ''}`, { waitUntil: 'networkidle' });
        const found = await page.waitForSelector(s.mark, { timeout: 10000, state: 'attached' }).then(() => true).catch(() => false);
        await page.waitForTimeout(500);
        check(`${name}: ${s.mark} present`, found);
        check(`${name}: no horizontal overflow`, (await overflow()) <= 0, `overflow=${await overflow()}`);
        if (s.project) {
          // THE PROJECT'S STORY (§9.4): its first link as the full card — picture on top, description, host — and the door into the wizard.
          const full = page.locator('[data-link-card][data-link-variant="full"]');
          check(`${name}: the story's link is one full card`, (await full.count()) === 1);
          const open = full.locator('a[data-link-open]');
          check(`${name}: the card opens in a new tab with no referrer and no follow`, (await open.getAttribute('target')) === '_blank' && (await open.getAttribute('rel')) === 'noopener noreferrer nofollow');
          check(`${name}: the picture is our copy, not theirs`, ((await full.locator('img').first().getAttribute('src').catch(() => '')) ?? '').startsWith('/files/link-cards/'));
          check(`${name}: the description is on the full card`, (await full.innerText()).includes('24 joints'));
          check(`${name}: a model page offers «اطلب طباعته»`, (await full.locator('[data-link-print]').count()) === 1);
          check(`${name}: one ask for the story's address`, ((await page.evaluate(() => window.__linkAsks)) ?? []).length === 1);
          await full.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${out}/${key}-${tag}.png`, fullPage: true });
          await full.locator('[data-link-print]').click();
          const went = await page.waitForSelector('[data-elsewhere]', { timeout: 8000 }).then((el) => el.getAttribute('data-elsewhere')).catch(() => null);
          check(`${name}: «اطلب طباعته» opens the wizard with the link in it`, went === PRINT_DOOR, String(went));
          continue;
        }
        check(`${name}: one h1`, (await page.locator('h1').count()) === 1);
        // The six sections are links (D-7): «لك» is the page on screen, each other one its own page.
        const sections = await page.locator('[data-community-sections] a').evaluateAll((els) => els.map((el) => [el.getAttribute('href'), el.getAttribute('aria-current')]));
        check(`${name}: six section links, «لك» current`, sections.length === 6 && sections[0][0] === '/community' && sections[0][1] === 'page' && sections.slice(1).every(([, c]) => c === null), JSON.stringify(sections));
        check(`${name}: no tab strip`, (await page.locator('[role="tab"]').count()) === 0);
        // No section label is cut (Sorani «شوێنکەوتووەکانم» at 360 px): words wrap whole.
        const cut = await page.evaluate(() => [...document.querySelectorAll('[data-community-sections] a span')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
        check(`${name}: no section label is cut`, cut.length === 0, JSON.stringify(cut));
        if (s.issue) {
          check(`${name}: a guest's home has no workshop rail`, (await page.locator('[data-community-board-rail]').count()) === 0);
          // The top bar reads «LEVONIS», then the page heading (D-8).
          const order = await page.evaluate(() => {
            const bar = document.querySelector('[data-community-topbar]');
            const word = bar?.querySelector('p[lang="en"]');
            const h1 = document.querySelector('h1');
            return !!word && !!h1 && (word.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 && word.textContent?.trim() === 'LEVONIS';
          });
          check(`${name}: the wordmark comes before the h1`, order);
          const alt = await page.locator('[data-community-featured="post"] img').first().getAttribute('alt').catch(() => null);
          check(`${name}: the featured project's alt is its title`, alt === COVER_TITLE, `alt=${alt}`);
          const kicker = (await page.locator('[data-community-featured="post"] p').first().innerText()).trim();
          check(`${name}: the kicker is the honest one`, KICKERS.includes(kicker), kicker);
          const verbs = await page.locator('[data-community-actions] a').evaluateAll((els) => els.map((el) => [el.getAttribute('data-testid'), el.getAttribute('href')]));
          check(`${name}: the two verbs, the request first, a guest through sign-in`, verbs.length === 2 && verbs[0][0] === 'community-new-request' && verbs[1][0] === 'community-share-project' && verbs.every(([, h]) => h === '/auth'), JSON.stringify(verbs));
          check(`${name}: two trending cards beside the featured project`, (await page.locator('[data-community-section="trending"] [data-project-feature]').count()) === (width < 1024 ? 2 : 3));
          const reqRows = await page.locator('[data-community-section="requests"] [data-community-request]').evaluateAll((els) => els.map((el) => [el.getAttribute('href'), el.textContent ?? '']));
          check(`${name}: two request rows, each its own page, never a budget`, reqRows.length === 2 && reqRows.every(([h, t]) => /^\/requests\/[^/?#]+$/.test(h ?? '') && !/45,000|45٬000|ميزانية|budget|بودجە/i.test(t)), JSON.stringify(reqRows));
          check(`${name}: the makers`, (await page.locator('[data-community-section="creators"] [data-community-creator]').count()) >= 2);
          const studio = page.locator('[data-testid="community-studio-link"]');
          check(`${name}: the Studio anchor opens its own tab, without an opener`, (await studio.count()) === 1 && (await studio.getAttribute('target')) === '_blank' && (await studio.getAttribute('rel')) === 'noopener noreferrer');
          // Every control of the first screens is a 44 px target.
          const small = await page.evaluate(() => [...document.querySelectorAll('[data-community-topbar] a, [data-community-topbar] button, [data-community-actions] a, [data-community-sections] a, [data-community-featured] a')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && (r.width < 44 || r.height < 44)).length);
          check(`${name}: the first screen's targets are 44 px`, small === 0, String(small));
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
            // LINK CARDS (§9.4): the words name a model page → its card, a compact row beside the story.
            const linked = await page.waitForSelector('[data-community-feed="foryou"] [data-post-card] [data-link-card]', { timeout: 8000 }).then(() => true).catch(() => false);
            check(`${name}: a post that names a link carries its card`, linked);
            if (linked) {
              const open = page.locator('[data-post-card] [data-link-card] a[data-link-open]').first();
              check(`${name}: the card opens in a new tab with no referrer and no follow`, (await open.getAttribute('target')) === '_blank' && (await open.getAttribute('rel')) === 'noopener noreferrer nofollow');
              check(`${name}: the model card shows our copy of the picture`, ((await page.locator('[data-post-card] [data-link-card][data-link-kind="model_page"] img').first().getAttribute('src').catch(() => '')) ?? '').startsWith('/files/link-cards/'));
              check(`${name}: a model page offers «اطلب طباعته», a video does not`, (await page.locator('[data-post-card] [data-link-card][data-link-kind="model_page"] [data-link-print]').count()) >= 1 && (await page.locator('[data-post-card] [data-link-card][data-link-kind="video"] [data-link-print]').count()) === 0);
              check(`${name}: a link nobody resolved draws nothing`, (await page.locator('[data-link-card][data-link-host="example.org"]').count()) === 0);
              const asks = (await page.evaluate(() => window.__linkAsks)) ?? [];
              check(`${name}: one ask per distinct address (three addresses, five cards)`, asks.length === 3 && new Set(asks).size === 3, JSON.stringify(asks));
              // The card's doors are pressable through the card's stretched title link.
              const door = page.locator('[data-post-card] [data-link-card][data-link-kind="model_page"] [data-link-print]').first();
              await door.scrollIntoViewIfNeeded();
              await page.waitForTimeout(400);
              await page.screenshot({ path: `${out}/link-card-${tag}.png`, fullPage: false });
              check(`${name}: the print door is a 44 px target`, ((await door.boundingBox())?.height ?? 0) >= 44);
            }
            // Auto-load: the sentinel near the end of the list fetches the next page.
            await page.locator('[data-load-more], [data-community-colophon]').first().scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(900);
            const after = await page.locator('[data-community-feed="foryou"] [data-post-card]').count();
            check(`${name}: the next page arrived on its own`, after > 12, `rows=${after}`);
            check(`${name}: the next page asked nothing new about the same addresses`, ((await page.evaluate(() => window.__linkAsks)) ?? []).length === 3);
          }
          check(`${name}: the colophon counts`, (await page.locator('[data-community-colophon]').count()) === 1);
          check(`${name}: «وسوم رائجة» under the feed`, (await page.locator('[data-community-trending-tags] a').count()) === 4);
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
          check(`${name}: the home stays behind the panel`, (await page.locator('[data-community-actions]').count()) === 1 && (await page.locator('[data-projects-grid]').count()) === 0);
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
          check(`${name}: once the panel closes, the term turns the home into the projects search`, grid);
          check(`${name}: the verbs step aside while searching`, (await page.locator('[data-community-actions]').count()) === 0);
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
          // «طلبات تناسبك» is the workshop's own board, leading the home; the issue's section keeps its plain title.
          const rail = await page.waitForSelector('[data-community-board-rail] [data-community-board-cards] [data-community-request]', { timeout: 10000 }).then(() => true).catch(() => false);
          check(`${name}: a merchant's home leads with «طلبات تناسبك»`, rail);
          const head = (await page.locator('[data-community-board-rail] h2').innerText().catch(() => '')).trim();
          check(`${name}: the rail is called «طلبات تناسبك»`, MERCHANT_HEADS.includes(head), head);
          const plain = (await page.locator('[data-community-section="requests"] h2').innerText()).trim();
          check(`${name}: the issue's section keeps «طلبات الطباعة» — one «طلبات تناسبك» on the page`, PLAIN_HEADS.includes(plain), plain);
          const cards = await page.locator('[data-community-board-cards] [data-community-request]').evaluateAll((els) => els.map((el) => el.getAttribute('href')));
          // Review 2026-09-30: a request's own address, never the board's ?request= and its redirect (+26 KB, a serial hop).
          check(`${name}: the rail's cards open their requests`, cards.length >= 1 && cards.length <= 6 && cards.every((h) => /^\/requests\/[^/?#]+$/.test(h ?? '')), cards.join(' '));
          check(`${name}: «عرض الكل» opens the whole board`, (await page.locator('[data-community-board-all]').getAttribute('href')) === '/requests');
          const navY = (await page.locator('[data-community-sections]').boundingBox())?.y ?? Infinity;
          const railY = (await page.locator('[data-community-board-rail]').boundingBox())?.y ?? Infinity;
          const coverY = (await page.locator('[data-community-featured]').first().boundingBox())?.y ?? -Infinity;
          check(`${name}: the rail sits under the sections, above the featured project`, navY < railY && railY < coverY, `nav=${navY} rail=${railY} featured=${coverY}`);
          const cardBox = await page.locator('[data-community-board-cards] [data-community-request]').first().boundingBox();
          check(`${name}: a rail card is a card, not the screen`, !!cardBox && cardBox.width <= 300, JSON.stringify(cardBox));
          await page.locator('[data-community-board-rail]').screenshot({ path: `${out}/board-rail-${tag}.png` });
          // THE RAIL'S FRAME IS THERE FROM THE FIRST PAINT on a return visit (perf review 2026-09-30: the rail
          // mounted above an issue already on screen once /api/merchant/me answered — CLS 0 → 0.206).
          const firstCls = await page.evaluate(() => (window.__lvShifts ?? []).reduce((a, x) => a + x, 0));
          await page.reload({ waitUntil: 'networkidle' });
          await page.waitForSelector('[data-community-board-rail] [data-community-board-cards] [data-community-request]', { timeout: 10000 }).catch(() => null);
          await page.waitForTimeout(800);
          const cls = await page.evaluate(() => (window.__lvShifts ?? []).reduce((a, x) => a + x, 0));
          console.log(`  info ${name}: layout shift, first visit ${firstCls.toFixed(3)}, return visit ${cls.toFixed(3)}`);
          check(`${name}: a return visit reserves the rail's frame — no layout shift`, cls < 0.02, cls.toFixed(4));
        }
        if (s.noRail) {
          await page.waitForTimeout(600);
          check(`${name}: no «طلبات تناسبك» rail for a customer`, (await page.locator('[data-community-board-rail]').count()) === 0);
          const plain = (await page.locator('[data-community-section="requests"] h2').innerText().catch(() => '')).trim();
          check(`${name}: the issue's section reads «طلبات الطباعة»`, PLAIN_HEADS.includes(plain), plain);
        }
        if (s.boardEmpty) {
          const text = (await page.locator('[data-community-board-empty]').innerText()).trim();
          check(`${name}: an empty board says so in one sentence`, text.length > 20, text);
          check(`${name}: the request preferences are one tap away`, (await page.locator('[data-community-board-empty] a').getAttribute('href')) === '/merchant/printers#preferences');
        }
        if (s.empty) {
          await page.locator('[data-community-section="feed"]').scrollIntoViewIfNeeded();
          const emptyFeed = await page.waitForSelector('[data-community-section="feed"] [role="status"], [data-community-section="feed"] h3', { timeout: 10000 }).then(() => true).catch(() => false);
          check(`${name}: the empty feed says the first issue is being written`, emptyFeed);
        }
        if (s.member) {
          // ONE GET /api/chats a page: the bottom bar reads it, the top bar shows the same count.
          await page.waitForTimeout(600);
          const asks = ((await page.evaluate(() => window.__chatAsks)) ?? []).length;
          check(`${name}: one GET /api/chats for the page`, asks === 1, String(asks));
          const chats = page.locator('[data-community-chats]');
          check(`${name}: the top bar says the unread messages`, /3/.test((await chats.getAttribute('aria-label')) ?? '') && (await chats.locator('[data-nav-badge="messages"]').innerText()).trim() === '3');
          // The avatar opens the sections and account menu, Escape closes it, focus comes back.
          const avatar = page.locator('[data-community-avatar]');
          check(`${name}: the avatar is a dialog door`, (await avatar.getAttribute('aria-haspopup')) === 'dialog' && (await avatar.getAttribute('aria-expanded')) === 'false');
          await avatar.click();
          const menu = await page.waitForSelector('[role="dialog"]', { timeout: 8000 }).then(() => true).catch(() => false);
          check(`${name}: the avatar opens the menu`, menu && (await avatar.getAttribute('aria-expanded')) === 'true');
          await page.waitForTimeout(500);
          await page.screenshot({ path: `${out}/menu-${tag}.png`, fullPage: false });
          await page.keyboard.press('Escape');
          await page.waitForTimeout(600);
          check(`${name}: Escape closes the menu`, (await avatar.getAttribute('aria-expanded')) === 'false');
          check(`${name}: focus comes back to the avatar`, await page.evaluate(() => document.activeElement?.hasAttribute('data-community-avatar') ?? false));
          // A like on a trending card flips, and a follow on a maker row.
          const like = page.locator('[data-community-section="trending"] [data-social="like"]').first();
          const was = await like.getAttribute('aria-pressed');
          await like.click();
          await page.waitForTimeout(500);
          check(`${name}: a trending like flips`, (await like.getAttribute('aria-pressed')) !== was);
          const follow = page.locator('[data-community-section="creators"] [data-social="follow"]').first();
          const before = await follow.getAttribute('aria-pressed');
          await follow.click();
          await page.waitForTimeout(500);
          check(`${name}: a maker follow flips`, (await follow.getAttribute('aria-pressed')) !== before, String(before));
        }
        await page.screenshot({ path: `${out}/${key}-${tag}.png`, fullPage: true });
      }
      // THE OLD ADDRESSES (§3): each lands on its section page, with its term, and never loops.
      if (theme === 'dark' && lang === 'ar') {
        for (const [old, target] of REDIRECTS) {
          await page.goto(`${base}?lang=${lang}&theme=${theme}&viewer=guest&tab=${old}${old === 'following' ? '' : `&extra=${encodeURIComponent('q=dragon')}`}`, { waitUntil: 'networkidle' });
          const went = await page.waitForSelector('[data-elsewhere]', { timeout: 8000 }).then((el) => el.getAttribute('data-elsewhere')).catch(() => null);
          check(`${tag} ?tab=${old}: lands on ${target}`, went === target, String(went));
        }
        await page.goto(`${base}?lang=${lang}&theme=${theme}&viewer=guest&tab=products`, { waitUntil: 'networkidle' });
        check(`${tag} ?tab=products: the home's products list`, await page.waitForSelector('[data-community-panel="products"]', { timeout: 8000 }).then(() => true).catch(() => false));
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
