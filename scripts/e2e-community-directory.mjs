#!/usr/bin/env node
/**
 * THE COMMUNITY DIRECTORY, DRIVEN IN A REAL BROWSER (community UI plan C5):
 * the stores page (IMG_8469) and the makers page (IMG_8476) on the fixture
 * tests/browser/community-directory.html, whose answers honour the filters as
 * the server does (plan B3).
 *
 *   filters     each chip writes the address (`gov`, `tech`, `design`;
 *               `sort`, `has_store`, `approved`) and the next read carries
 *               it to the server; FDM and resin release each other; a
 *               filter with no answer says so and «مسح الفلاتر» clears it
 *   the sheet   the governorate sheet is a radio group of 19: the arrows
 *               move the check, Enter applies and closes, Escape closes
 *               without applying, focus back on the chip both ways; the
 *               makers sheet: the order radio group (arrows apply), the two
 *               pressed chips, Escape back to the filter button
 *   the cards   one link per card, named «زيارة المتجر: <name>» /
 *               «عرض الملف: <name>»; the works strip `aria-hidden`; no phone
 *               anywhere; the place line is the governorate
 *   following   a followed store and a followed maker say so (`aria-pressed`);
 *               a press flips it; a guest is sent to sign in; the own store
 *               of a merchant has no follow button and «متجرك» shows
 *   the matrix  both pages in dark and light, ar, en and ckb, at 390x844,
 *               1440x1000 and 320x700: no sideways scroll, no page error,
 *               every control at least 44px tall (or wearing `lv-hit`)
 *
 * Screenshots go to OUT_DIR (default /tmp/claude-0/shots/community-directory/).
 *
 * Run: serve the repo with vite (`npx vite --port 4192`), then
 *      node scripts/e2e-community-directory.mjs
 *      (COMMUNITY_DIRECTORY_URL, PLAYWRIGHT_MODULE as for the other e2e scripts)
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.COMMUNITY_DIRECTORY_URL || 'http://127.0.0.1:4192/tests/browser/community-directory.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/community-directory';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passes += 1;
    console.log(`ok   ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`FAIL ${name} ${detail}`);
  }
}

async function open(browser, { page = 'stores', theme = 'dark', lang = 'ar', viewer = 'guest', width = 390, height = 844, extra = '', state = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce', hasTouch: width < 800, isMobile: width < 800 });
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (e) => errors.push(e.message));
  const q = new URLSearchParams({ page, theme, lang, viewer });
  if (extra) q.set('extra', extra);
  if (state) q.set('state', state);
  await tab.goto(`${base}?${q}`, { waitUntil: 'domcontentloaded' });
  await tab.waitForSelector('[data-community-section]');
  await tab.waitForSelector(state === 'error' ? '[data-community-panel] button' : state === 'empty' ? '[data-community-panel]' : '[data-directory-card]', { timeout: 15000 });
  await tab.waitForTimeout(400);
  return { context, tab, errors, tag: `${page}-${theme}-${lang}-${viewer}-${width}` };
}

const address = (tab) => tab.evaluate(() => document.documentElement.getAttribute('data-address') ?? '');
const lastCall = (tab, path) => tab.evaluate((p) => [...window.__directoryCalls].reverse().find((c) => c.includes(p)) ?? '', path);
const settle = (tab) => tab.waitForTimeout(450);

const browser = await chromium.launch();

// ------------------------------------------------------------ stores: cards
{
  const { context, tab, errors, tag } = await open(browser, {});
  const cards = await tab.evaluate(() =>
    [...document.querySelectorAll('[data-directory-card="store"]')].map((c) => ({
      id: c.getAttribute('data-community-store'),
      links: c.querySelectorAll('a').length,
      name: c.querySelector('a')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      works: c.querySelector('[data-directory-works]')?.getAttribute('aria-hidden') ?? 'none',
      place: c.querySelector('[data-store-place]')?.textContent ?? '',
      text: c.textContent ?? '',
    }))
  );
  check(`${tag}: four stores`, cards.length === 4, String(cards.length));
  for (const c of cards) {
    check(`${tag}: ${c.id} has one link`, c.links === 1, String(c.links));
    check(`${tag}: ${c.id} link is named for the store`, /زيارة المتجر\s*:/.test(c.name), c.name);
    check(`${tag}: ${c.id} works are hidden from assistive tech`, c.works === 'true' || c.works === 'none', c.works);
    check(`${tag}: ${c.id} carries no phone`, !/0770\d{7}/.test(c.text));
  }
  check(`${tag}: the place line is the governorate`, cards[0].place.includes('بغداد') && !/حي|شارع|الكرادة/.test(cards[0].place), cards[0].place);
  check(`${tag}: a store with no works draws no strip`, cards.find((c) => c.id === 'cm_eve')?.works === 'none');
  // A guest who presses «متابعة» is sent to sign in.
  await tab.locator('[data-community-store="cm_baghdad"] [data-social="follow-store"]').click();
  await tab.waitForSelector('[data-elsewhere]');
  check(`${tag}: a guest follow goes to sign in`, (await tab.getAttribute('[data-elsewhere]', 'data-elsewhere')).startsWith('/auth'));
  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

// ------------------------------------------------------------ stores: filters in the address
{
  const { context, tab, errors, tag } = await open(browser, { viewer: 'customer' });
  await tab.click('[data-directory-filter="fdm"]');
  await settle(tab);
  check(`${tag}: FDM writes tech=fdm`, (await address(tab)).includes('tech=fdm'));
  check(`${tag}: the read carries tech=fdm`, (await lastCall(tab, '/api/community/merchants')).includes('tech=fdm'));
  check(`${tag}: FDM says it is on`, (await tab.getAttribute('[data-directory-filter="fdm"]', 'aria-pressed')) === 'true');
  await tab.click('[data-directory-filter="resin"]');
  await settle(tab);
  check(`${tag}: resin releases FDM`, (await address(tab)).includes('tech=resin') && (await tab.getAttribute('[data-directory-filter="fdm"]', 'aria-pressed')) === 'false');
  await tab.click('[data-directory-filter="design"]');
  await settle(tab);
  check(`${tag}: design writes design=1 and reads service=design`, (await address(tab)).includes('design=1') && (await lastCall(tab, '/api/community/merchants')).includes('service=design'));
  check(`${tag}: resin and design leave no store`, (await tab.locator('[data-directory-card]').count()) === 0);
  check(`${tag}: the filtered empty state offers «مسح الفلاتر»`, (await tab.locator('[data-directory-clear-filters]').count()) === 1);
  await tab.click('[data-directory-clear-filters]');
  await settle(tab);
  check(`${tag}: «مسح الفلاتر» empties the address`, !/tech=|design=|gov=/.test(await address(tab)), await address(tab));

  // The governorate sheet: a radio group, the keyboard, Escape.
  const chip = tab.locator('[data-governorate-chip]');
  await chip.focus();
  await tab.keyboard.press('Enter');
  await tab.waitForSelector('[data-governorate-options] [role="radio"]');
  await tab.waitForTimeout(350);
  const radios = await tab.locator('[data-governorate-options] [role="radio"]').count();
  check(`${tag}: the sheet holds all governorates and «كل المحافظات»`, radios === 19, String(radios));
  check(`${tag}: the sheet is a radiogroup`, (await tab.locator('[data-governorate-options][role="radiogroup"]').count()) === 1);
  check(`${tag}: the checked option takes focus`, (await tab.evaluate(() => document.activeElement?.getAttribute('data-governorate'))) === 'all');
  await tab.keyboard.press('ArrowDown');
  check(`${tag}: ArrowDown moves the check and the focus`, (await tab.evaluate(() => [document.activeElement?.getAttribute('data-governorate'), document.activeElement?.getAttribute('aria-checked')].join()))
    === 'baghdad,true');
  await tab.keyboard.press('Escape');
  await tab.waitForTimeout(400);
  check(`${tag}: Escape closes without applying`, (await tab.locator('[data-governorate-options]').count()) === 0 && !(await address(tab)).includes('gov='));
  check(`${tag}: Escape gives focus back to the chip`, (await tab.evaluate(() => document.activeElement?.hasAttribute('data-governorate-chip'))) === true);
  await tab.keyboard.press('Enter');
  await tab.waitForSelector('[data-governorate-options] [role="radio"]');
  await tab.waitForTimeout(350);
  for (let i = 0; i < 4; i++) await tab.keyboard.press('ArrowDown');
  await tab.keyboard.press('Enter');
  await settle(tab);
  check(`${tag}: Enter applies erbil`, (await address(tab)).includes('gov=erbil') && (await lastCall(tab, '/api/community/merchants')).includes('governorate=erbil'));
  check(`${tag}: Enter gives focus back to the chip`, (await tab.evaluate(() => document.activeElement?.hasAttribute('data-governorate-chip'))) === true);
  check(`${tag}: the chip says the governorate`, (await tab.textContent('[data-governorate-chip]')).includes('أربيل'));
  check(`${tag}: only the Erbil store is left`, (await tab.locator('[data-directory-card]').count()) === 1);
  await tab.screenshot({ path: `${out}/${tag}-gov-erbil.png` });

  // Following: a followed store says so; a press flips another.
  check(`${tag}: a followed store says so`, (await tab.getAttribute('[data-community-store="cm_tabaa"] [data-social="follow-store"]', 'aria-pressed')) === 'true');
  await tab.click('[data-filter-select] button[aria-label]:not([data-governorate-chip])');
  await settle(tab);
  check(`${tag}: the × clears the governorate`, !(await address(tab)).includes('gov='));
  await tab.click('[data-community-store="cm_baghdad"] [data-social="follow-store"]');
  await tab.waitForTimeout(300);
  check(`${tag}: a press follows`, (await tab.getAttribute('[data-community-store="cm_baghdad"] [data-social="follow-store"]', 'aria-pressed')) === 'true');
  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

// ------------------------------------------------------------ stores: the own store of a merchant
{
  const { context, tab, errors, tag } = await open(browser, { viewer: 'merchant' });
  check(`${tag}: the own store has no follow button`, (await tab.locator('[data-community-store="cm_eve"] [data-social="follow-store"]').count()) === 0);
  check(`${tag}: other stores have one`, (await tab.locator('[data-community-store="cm_baghdad"] [data-social="follow-store"]').count()) === 1);
  check(`${tag}: «متجرك» shows under the chips`, (await tab.locator('[data-community-your-store="manage"]').count()) === 1);
  await tab.click('[data-directory-filter="fdm"]');
  await settle(tab);
  check(`${tag}: «متجرك» steps aside while a filter is on`, (await tab.locator('[data-community-your-store]').count()) === 0);
  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

// ------------------------------------------------------------ makers
{
  const { context, tab, errors, tag } = await open(browser, { page: 'makers', viewer: 'customer' });
  check(`${tag}: «صنّاع مميزون» heads the featured order`, (await tab.getAttribute('[data-directory-head]', 'data-directory-head')) === 'featured');
  check(`${tag}: the featured read asks featured=1`, (await lastCall(tab, '/api/community/creators')).includes('featured=1'));
  const cards = await tab.evaluate(() =>
    [...document.querySelectorAll('[data-directory-card="maker"]')].map((c) => ({
      id: c.getAttribute('data-community-creator'),
      links: c.querySelectorAll('a').length,
      name: c.querySelector('a')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      works: c.querySelector('[data-directory-works]')?.getAttribute('aria-hidden') ?? 'none',
      line: c.querySelector('[data-maker-line]')?.textContent ?? '',
    }))
  );
  check(`${tag}: most projects first`, cards[0]?.id === 'u_sara', cards.map((c) => c.id).join());
  for (const c of cards) {
    check(`${tag}: ${c.id} has one link`, c.links === 1, String(c.links));
    check(`${tag}: ${c.id} link is named for the maker`, /عرض الملف\s*:/.test(c.name), c.name);
    check(`${tag}: ${c.id} works are hidden from assistive tech`, c.works === 'true' || c.works === 'none', c.works);
  }
  check(`${tag}: the specialty is the first line of the bio`, cards[0].line === 'تصميم ومنتجات عملية', cards[0].line);
  check(`${tag}: a followed maker says so`, (await tab.getAttribute('[data-community-creator="u_ali"] [data-social="follow"]', 'aria-pressed')) === 'true');

  const button = tab.locator('[data-makers-filter-button]');
  await button.focus();
  await tab.keyboard.press('Enter');
  await tab.waitForSelector('[data-makers-sort] [role="radio"]');
  await tab.waitForTimeout(350);
  check(`${tag}: the order is a radiogroup of three`, (await tab.locator('[data-makers-sort][role="radiogroup"] [role="radio"]').count()) === 3);
  check(`${tag}: the order on screen is checked and focused`, (await tab.evaluate(() => document.activeElement?.getAttribute('data-sort'))) === 'featured');
  await tab.keyboard.press('ArrowDown');
  await settle(tab);
  check(`${tag}: ArrowDown applies «الأكثر متابعين»`, (await address(tab)).includes('sort=followers') && (await lastCall(tab, '/api/community/creators')).includes('sort=followers'));
  await tab.click('[data-makers-filter="has_store"]');
  await settle(tab);
  check(`${tag}: «لديهم متجر» writes has_store=1`, (await address(tab)).includes('has_store=1') && (await lastCall(tab, '/api/community/creators')).includes('has_store=1'));
  check(`${tag}: «لديهم متجر» says it is on`, (await tab.getAttribute('[data-makers-filter="has_store"]', 'aria-pressed')) === 'true');
  await tab.screenshot({ path: `${out}/${tag}-sheet.png` });
  await tab.keyboard.press('Escape');
  await tab.waitForTimeout(400);
  check(`${tag}: Escape closes the sheet onto the filter button`, (await tab.locator('[data-makers-sort]').count()) === 0 && (await tab.evaluate(() => document.activeElement?.hasAttribute('data-makers-filter-button'))) === true);
  check(`${tag}: the button counts the filters`, (await button.getAttribute('aria-label')).includes('2'), await button.getAttribute('aria-label'));
  check(`${tag}: most followed first among those with a store`, (await tab.getAttribute('[data-directory-card]', 'data-community-creator')) === 'u_ali');
  await tab.click('[data-community-creator="u_ali"] [data-social="follow"]');
  await tab.waitForTimeout(300);
  check(`${tag}: a press unfollows`, (await tab.getAttribute('[data-community-creator="u_ali"] [data-social="follow"]', 'aria-pressed')) === 'false');
  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

// ------------------------------------------------------------ the states
for (const [page, state] of [['stores', 'empty'], ['stores', 'error'], ['makers', 'empty'], ['makers', 'error']]) {
  const { context, tab, errors, tag } = await open(browser, { page, state });
  const says = await tab.textContent('[data-community-panel]');
  check(`${tag}-${state}: says something`, (says ?? '').trim().length > 0);
  if (state === 'error') check(`${tag}-${state}: offers a retry`, (await tab.locator('[data-community-panel] button').count()) >= 1);
  check(`${tag}-${state}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await tab.screenshot({ path: `${out}/${tag}-${state}.png` });
  await context.close();
}

// ------------------------------------------------------------ the matrix
const MATRIX = [];
for (const page of ['stores', 'makers']) {
  for (const theme of ['dark', 'light']) {
    for (const [w, h] of [[390, 844], [1440, 1000]]) MATRIX.push({ page, theme, lang: 'ar', width: w, height: h });
  }
  MATRIX.push({ page, theme: 'dark', lang: 'en', width: 390, height: 844 });
  MATRIX.push({ page, theme: 'dark', lang: 'ckb', width: 390, height: 844 });
  MATRIX.push({ page, theme: 'dark', lang: 'ckb', width: 320, height: 700 });
}
for (const m of MATRIX) {
  const extra = m.page === 'stores' ? 'tech=fdm' : 'has_store=1';
  for (const filters of ['', extra]) {
    const { context, tab, errors, tag } = await open(browser, { ...m, viewer: 'customer', extra: filters });
    const name = `${tag}${filters ? '-filtered' : ''}`;
    const over = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${name}: no sideways scroll`, over <= 0, `${over}px`);
    const small = await tab.evaluate(() =>
      [...document.querySelectorAll('[data-community-section] button, [data-community-section] a, [data-community-section] input')]
        .filter((el) => !el.classList.contains('lv-hit') && el.getClientRects().length > 0)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.height < 44 - 0.5)
        .map(({ el, r }) => `${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}] ${Math.round(r.height)}px`)
    );
    check(`${name}: every control is at least 44px tall`, small.length === 0, small.slice(0, 3).join(', '));
    check(`${name}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await tab.screenshot({ path: `${out}/${name}.png`, fullPage: m.width >= 800 });
    await context.close();
  }
}

await browser.close();
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
