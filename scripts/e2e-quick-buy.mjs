#!/usr/bin/env node
/**
 * QUICK BUY, THE CUSTOMER FLOWS, IN A REAL BROWSER (docs/GIFTS_QUICK_BUY.md §3.5–§3.6).
 *
 * Drives tests/browser/quick-buy.html — the real product page, «طلباتي»,
 * Settings, bottom navigation and toaster behind a stub that plays the API as
 * built — through: activation from the product page (four unticked consents,
 * versioned policy links, the address, no auto-buy), the add and its toast,
 * insufficient balance with both amounts, a dropped answer retried under the
 * SAME idempotency key, the orders card (server clock against a skewed device
 * clock, one PATCH per settled stepper, removal as PATCH {qty: 0}), the lock at
 * 00:00 and the one refresh at zero, the session becoming an ordinary order
 * (owner spec §13: no card after submission, one transient toast), a failed
 * submission's one line, the printer standard-delivery warning (same request,
 * same key, with the acceptance), a deleted address, Settings, re-consent and
 * the inline address form. Screenshots of each state.
 *
 * Run:  npx vite --port 4195 --strictPort --host 127.0.0.1   (from the repo)
 *       node scripts/e2e-quick-buy.mjs <scenario[,scenario]|all> [width] [theme] [lang] [reduced]
 * Env:  QUICK_BUY_TEST_URL, OUT_DIR (screenshots), PLAYWRIGHT_MODULE.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const OUT = process.env.OUT_DIR || '/tmp/quick-buy-e2e';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.QUICK_BUY_TEST_URL || 'http://127.0.0.1:4195/tests/browser/quick-buy.html';

const [scenarioArg = 'activation', widthArg = '360', theme = 'dark', lang = 'ar', reducedArg] = process.argv.slice(2);
const width = Number(widthArg);
const reduced = reducedArg === 'reduced';
const tag = `${width}-${theme}-${lang}${reduced ? '-reduced' : ''}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function open(browser, query) {
  const page = await browser.newPage({
    viewport: { width, height: width >= 1000 ? 860 : 780 },
    deviceScaleFactor: width >= 1000 ? 1 : 2,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/storefront\/resolve|Failed to load resource|chunk load failed/.test(m.text())) page.errors.push(m.text().slice(0, 300));
  });
  await page.goto(`${BASE}?${query}&theme=${theme}&lang=${lang}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return page;
}

const shot = async (page, name, opts = {}) => {
  const file = `${OUT}/${name}-${tag}.png`;
  await page.screenshot({ path: file, ...opts });
  console.log(`  shot ${file}`);
};

const visible = (page, sel) => page.locator(`${sel} >> visible=true`).first();
const requests = (page) => page.evaluate(() => window.quickBuyRequests.map((r) => ({ ...r })));
const toastText = (page) => page.evaluate(() => [...document.querySelectorAll('[data-toast], [role="status"], [role="alert"]')].map((n) => n.textContent.trim()).filter(Boolean).join(' | '));

async function scrollMain(page, selector, block = 'start') {
  await page.evaluate(([sel, blk]) => document.querySelector(sel)?.scrollIntoView({ block: blk }), [selector, block]);
  await page.waitForTimeout(350);
}

async function untilMode(page, mode) {
  await page.waitForFunction((m) => [...document.querySelectorAll('[data-quick-buy-bar]')].some((b) => b.dataset.mode === m && b.getBoundingClientRect().width > 0), mode, { timeout: 6000 });
}

async function barMode(page) {
  await page.waitForTimeout(650);
  return page.evaluate(() => [...document.querySelectorAll('[data-quick-buy-bar]')].find((b) => b.getBoundingClientRect().width > 0)?.dataset.mode ?? 'none');
}

const scenarios = {
  // First use: toggle → sheet (nothing ticked) → tick + address → activate → back on the product, ready → buy → toast → «عرض الطلب».
  async activation(browser) {
    const page = await open(browser, 'view=product&profile=inactive');
    await shot(page, 'product-off');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForSelector('[data-overlay="quick-buy-sheet"] [data-quick-buy-activate]');
    await page.waitForTimeout(900);
    await shot(page, 'sheet-empty');
    const unticked = await page.$$eval('[data-overlay="quick-buy-sheet"] input[type=checkbox]', (els) => els.map((e) => e.checked));
    check('four consents, none ticked by default', unticked.length === 4 && unticked.every((c) => !c), JSON.stringify(unticked));
    const disabledBefore = await page.$eval('[data-quick-buy-activate]', (b) => b.disabled);
    check('activate is disabled until everything is answered', disabledBefore === true);
    const links = await page.$$eval('[data-overlay="quick-buy-sheet"] a[target=_blank]', (as) => as.map((a) => a.getAttribute('href')));
    check('each policy links its required version', links.length === 3 && /\/policies\/terms\?version=4/.test(links[0]) && /\/policies\/privacy\?version=3/.test(links[1]) && /\/policies\/quick_buy\?version=2/.test(links[2]), JSON.stringify(links));
    for (const box of await page.$$('[data-overlay="quick-buy-sheet"] input[type=checkbox]')) await box.click();
    await page.click('[data-quick-buy-address="adr_work"]');
    await page.waitForTimeout(300);
    await shot(page, 'sheet-filled');
    // The footer, scrolled into view inside the sheet body.
    await page.click('[data-quick-buy-activate]');
    await page.waitForSelector('[data-overlay="quick-buy-sheet"]', { state: 'detached', timeout: 8000 });
    await page.waitForTimeout(700);
    const activateReq = (await requests(page)).find((r) => r.path === '/api/quick-buy/activate');
    check('activation sends the three versions, walletConsent and the address', !!activateReq && activateReq.body.walletConsent === true && activateReq.body.addressId === 'adr_work' && JSON.stringify(activateReq.body.policyAcceptance) === JSON.stringify([{ key: 'terms', version: 4 }, { key: 'privacy', version: 3 }, { key: 'quick_buy', version: 2 }]) && typeof activateReq.body.idempotencyKey === 'string', JSON.stringify(activateReq?.body));
    const cta = await visible(page, '[data-quick-buy-capsule="quick"]').textContent();
    const toggleState = await barMode(page);
    check('back on the product with Quick Buy ready (no auto-buy)', toggleState === 'quick' && !(await requests(page)).some((r) => r.path === '/api/quick-buy/items'), `${toggleState} / ${cta}`);
    await shot(page, 'product-on');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForTimeout(1300);
    await shot(page, 'added-toast');
    const add = (await requests(page)).find((r) => r.path === '/api/quick-buy/items');
    check('the add carries the page selection and a key', !!add && add.body.productId === 'prod_a1mini' && add.body.qty === 1 && add.body.colorId === 'c-black' && typeof add.body.idempotencyKey === 'string', JSON.stringify(add?.body));
    const txt = await toastText(page);
    check('success toast with the remaining time and «view order»', /(تمت الإضافة|Added|زیادکرا)/.test(txt) && /\d\d:\d\d/.test(txt), txt.slice(0, 200));
    const action = page.locator('button', { hasText: lang === 'en' ? 'View order' : lang === 'ckb' ? 'بینینی داواکاری' : 'عرض الطلب' }).first();
    await action.click();
    await page.waitForSelector('[data-quick-buy-card="open"]', { timeout: 8000 });
    await page.waitForTimeout(800);
    await shot(page, 'orders-after-add');
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  async balance(browser) {
    const page = await open(browser, 'view=product&profile=active&balance=low');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await untilMode(page, 'quick');
    check('an active account gets no sheet', (await page.$('[data-overlay="quick-buy-sheet"]')) === null);
    await shot(page, 'product-on-active');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForTimeout(1300);
    await shot(page, 'refusal-balance');
    const txt = await toastText(page);
    check('insufficient balance is said with both amounts', /(رصيد محفظة Levo غير كافٍ|Levo Wallet balance|باڵانسی جزدانی Levo)/.test(txt) && /125,000/.test(txt) && /460,000/.test(txt), txt.slice(0, 240));
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  async flaky(browser) {
    const page = await open(browser, 'view=product&profile=active&flaky=1');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await untilMode(page, 'quick');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForTimeout(1300);
    const first = await toastText(page);
    await shot(page, 'refusal-network');
    const retry = page.locator('button', { hasText: lang === 'en' ? 'Try again' : lang === 'ckb' ? 'دووبارە هەوڵ بدەرەوە' : 'إعادة المحاولة' }).first();
    await retry.click();
    await page.waitForTimeout(1300);
    const adds = (await requests(page)).filter((r) => r.path === '/api/quick-buy/items' && r.method === 'POST');
    const session = await page.evaluate(() => window.quickBuyServer.session);
    check('the retry resends the SAME key and nothing is added twice', adds.length === 2 && adds[0].body.idempotencyKey === adds[1].body.idempotencyKey && session && session.items.length === 1 && session.items[0].qty === 1, `${adds.map((a) => a.body.idempotencyKey).join(' / ')} qty=${session?.items?.[0]?.qty}`);
    check('network failure said, then success', /(انقطع الاتصال|connection dropped|پەیوەندی پچڕا)/.test(first) && /(تمت الإضافة|Added|زیادکرا)/.test(await toastText(page)), first.slice(0, 160));
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForTimeout(1300);
    const adds2 = (await requests(page)).filter((r) => r.path === '/api/quick-buy/items' && r.method === 'POST');
    check('a NEW tap after success is a new action with a new key', adds2.length === 3 && adds2[2].body.idempotencyKey !== adds2[1].body.idempotencyKey);
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  async orders(browser) {
    const page = await open(browser, 'view=orders&profile=active&session=open&remaining=1722');
    await page.waitForSelector('[data-quick-buy-card="open"]');
    await page.waitForTimeout(600);
    const clock = await page.$eval('[data-quick-buy-clock]', (n) => n.textContent.trim());
    const [mm, ss] = clock.split(':').map(Number);
    const secs = mm * 60 + ss;
    check('the clock reads the SERVER time (7-minute skew ignored)', secs <= 1722 && secs >= 1712, clock);
    await page.waitForTimeout(2100);
    const clock2 = await page.$eval('[data-quick-buy-clock]', (n) => n.textContent.trim());
    check('the clock ticks', clock2 !== clock, `${clock} → ${clock2}`);
    const chip = await page.$('[data-nav-badge="quick-buy"]');
    const navLabel = await page.$eval('[data-bottom-nav] a[href="/profile"]', (a) => a.getAttribute('aria-label'));
    check('the account tab carries the ⚡ chip and the time in its name', !!chip && /\d\d:\d\d/.test(navLabel), navLabel);
    const names = await page.$$eval('[data-quick-buy-item] bdi', (ns) => ns.map((n) => n.textContent.trim()));
    const wantA1 = lang === 'en' ? 'Bambu Lab A1 mini' : lang === 'ckb' ? 'بامبو لاب A1 مینی' : 'بامبو لاب A1 ميني';
    const wantPla = lang === 'en' ? 'Bambu PLA Basic 1 kg' : 'خيط بامبو PLA بيسك 1 كغم';
    check("each line is named in the reader's language (Sorani falls back to Arabic)", names.includes(wantA1) && names.includes(wantPla), JSON.stringify(names.slice(0, 6)));
    const dl = await page.$eval('[data-quick-buy-card] dl', (d) => d.textContent);
    const wantFree = lang === 'en' ? 'Free standard delivery — paid in full from Levo Wallet' : lang === 'ckb' ? 'گەیاندنی ئاسایی بەخۆڕایی — بۆ پارەدانی تەواو لە جزدانی Levo' : 'توصيل عادي مجاني — للدفع الكامل من محفظة Levo';
    check("the free-delivery line is the server's label in the reader's language", dl.includes(wantFree), dl.slice(0, 160));
    await shot(page, 'orders-open');
    await scrollMain(page, '[data-quick-buy-item="qbi_2"]', 'center');
    await shot(page, 'orders-open-items');
    // + on the second line, twice quickly → ONE PATCH with qty 4.
    const plus = page.locator('[data-quick-buy-item="qbi_2"] button').filter({ has: page.locator('svg.lucide-plus') }).first();
    await plus.click();
    await plus.click();
    await page.waitForTimeout(1400);
    const patches = (await requests(page)).filter((r) => r.method === 'PATCH');
    check('two quick taps settle into one PATCH', patches.length === 1 && patches[0].body.qty === 4, JSON.stringify(patches.map((p) => p.body)));
    await scrollMain(page, '[data-quick-buy-card]', 'end');
    await shot(page, 'orders-open-totals');
    await page.click('[data-quick-buy-remove="qbi_2"]');
    await page.waitForTimeout(1200);
    const del = (await requests(page)).filter((r) => r.method === 'PATCH' && r.body?.qty === 0);
    const left = await page.$$eval('[data-quick-buy-item]', (n) => n.map((x) => x.getAttribute('data-quick-buy-item')));
    check('remove is PATCH {qty: 0} with its own key, and the line goes', del.length === 1 && typeof del[0].body?.idempotencyKey === 'string' && del[0].body.idempotencyKey !== patches[0].body.idempotencyKey && !left.includes('qbi_2'), `${JSON.stringify(del[0]?.body)} left=${left}`);
    // The last item asks first.
    await page.click('[data-quick-buy-remove="qbi_1"]');
    await page.waitForSelector('[data-overlay="confirm-dialog"]');
    await page.waitForTimeout(500);
    await shot(page, 'orders-remove-last-confirm');
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // §13: at 00:00 the store asks once; the session becomes an ORDINARY order in the list, the card goes,
  // and all that is left is one transient toast with the way to the order.
  async expiry(browser) {
    const page = await open(browser, 'view=orders&profile=active&session=open&remaining=4');
    await page.waitForSelector('[data-quick-buy-card="open"]');
    const before = (await requests(page)).filter((r) => r.path === '/api/quick-buy/session').length;
    await page.waitForFunction(() => document.querySelector('[data-quick-buy-clock]')?.textContent.trim() === '00:00', null, { timeout: 9000 });
    // Within a frame of «00:00»: the card re-renders once, when its clock says the window closed.
    const locked = await page
      .waitForFunction(() => {
        const bs = [...document.querySelectorAll('[data-quick-buy-item] button')];
        return bs.length > 0 && bs.every((b) => b.disabled);
      }, null, { timeout: 700 })
      .then(() => true, () => false);
    check('everything locks at 00:00', locked);
    await shot(page, 'orders-locked-at-zero');
    await page.waitForTimeout(2500);
    const after = (await requests(page)).filter((r) => r.path === '/api/quick-buy/session').length;
    check('the store asks the server ONCE at zero', after - before === 1, `GETs at zero: ${after - before}`);
    const card = await page.$('[data-quick-buy-card]');
    const listed = await page.evaluate(() => document.getElementById('main-scroll-container').textContent.includes('LV-260107'));
    check('the card is gone and the order is in the list as an ordinary order', !card && listed, `card=${!!card} listed=${listed}`);
    const txt = await toastText(page);
    check('one transient line: «sent» with the way to the order', /(تم إرسال طلب الشراء السريع|Quick Buy order sent|داواکاری کڕینی خێرا نێردرا)/.test(txt), txt.slice(0, 160));
    await shot(page, 'orders-submitted-live');
    const chipAfter = await page.$('[data-nav-badge="quick-buy"]');
    const navAfter = await page.$eval('[data-bottom-nav] a[href="/profile"]', (a) => a.getAttribute('aria-label'));
    check('the chip leaves with the session and the tab gets its plain name back', !chipAfter && !/\d\d:\d\d/.test(navAfter ?? ''), navAfter);
    await page.locator('button', { hasText: lang === 'en' ? 'View order' : lang === 'ckb' ? 'بینینی داواکاری' : 'عرض الطلب' }).first().click();
    const opened = await page.waitForSelector('[data-fixture-order]', { timeout: 4000 }).then(() => true, () => false);
    check('the toast opens /orders/<order_id>', opened);
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  async locked(browser) {
    const page = await open(browser, 'view=orders&profile=active&session=locked');
    await page.waitForSelector('[data-quick-buy-card]');
    await page.waitForTimeout(500);
    const disabled = await page.$$eval('[data-quick-buy-item] button', (bs) => bs.length > 0 && bs.every((b) => b.disabled));
    check('a session past its deadline (editable: false, still being sent) is read-only', disabled);
    await shot(page, 'orders-locked');
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // A session the server could not submit: no card, no order — one line.
  async failed(browser) {
    const page = await open(browser, 'view=orders&profile=active&session=failed');
    const said = await page.waitForSelector('[data-quick-buy-notice="failed"]', { timeout: 8000 }).then(() => true, () => false);
    const card = await page.$('[data-quick-buy-card]');
    const txt = said ? await page.$eval('[data-quick-buy-notice="failed"]', (n) => n.textContent.trim()) : '';
    check('failed: one line that the money is still held, and no card', said && !card && /(محجوز|held|گیراوە)/.test(txt), txt);
    await shot(page, 'orders-failed');
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // Arriving after the session was sent: nothing Quick-Buy-specific at all, just the order in the list.
  async submitted(browser) {
    const page = await open(browser, 'view=orders&profile=active&session=submitted');
    await page.waitForTimeout(800);
    const card = await page.$('[data-quick-buy-card]');
    const notice = await page.$('[data-quick-buy-notice]');
    const listed = await page.evaluate(() => document.getElementById('main-scroll-container').textContent.includes('LV-260107'));
    const txt = await toastText(page);
    check('a submitted session has no card, no notice, no toast — the order is in the list', !card && !notice && listed && !/(تم إرسال طلب الشراء السريع|Quick Buy order sent)/.test(txt), `card=${!!card} notice=${!!notice} listed=${listed}`);
    await shot(page, 'orders-submitted');
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // A printer: refused until the standard-delivery warning is accepted, then the SAME request again.
  async printer(browser) {
    const page = await open(browser, 'view=product&profile=active&printer=1');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await untilMode(page, 'quick');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForSelector('[data-overlay="quick-buy-printer-sheet"] [data-quick-buy-printer-accept]', { timeout: 8000 });
    await page.waitForTimeout(900);
    await shot(page, 'printer-warning');
    const text = await page.$eval('[data-overlay="quick-buy-printer-sheet"] [data-printer-standard-warning]', (n) => n.textContent);
    check("the server's Arabic warning is shown (with a translation outside Arabic)", /قد يتعرض الطلب لأضرار/.test(text) && (lang === 'ar' || /(Standard delivery can damage|زیانی پێبگات)/.test(text)), text.slice(0, 160));
    const tick = await page.$eval('[data-overlay="quick-buy-printer-sheet"] input[type=checkbox]', (b) => b.checked);
    const off = await page.$eval('[data-quick-buy-printer-accept]', (b) => b.disabled);
    check('nothing ticked, and the accept is off until it is', tick === false && off === true);
    await page.click('[data-overlay="quick-buy-printer-sheet"] [data-quick-buy-printer-tick] input[type=checkbox]', { force: true });
    await page.waitForTimeout(250);
    await shot(page, 'printer-warning-ticked');
    await page.click('[data-quick-buy-printer-accept]');
    await page.waitForSelector('[data-overlay="quick-buy-printer-sheet"]', { state: 'detached', timeout: 8000 });
    await page.waitForTimeout(1300);
    const adds = (await requests(page)).filter((r) => r.path === '/api/quick-buy/items' && r.method === 'POST');
    const ack = adds[1]?.body?.printerStandardDeliveryAcceptance;
    check('the accept resends the SAME request with the acceptance', adds.length === 2 && adds[0].body.idempotencyKey === adds[1].body.idempotencyKey && !adds[0].body.printerStandardDeliveryAcceptance && ack?.accepted === true && ack?.version === 1, JSON.stringify(adds.map((a) => a.body)));
    const txt = await toastText(page);
    check('added after the acceptance', /(تمت الإضافة|Added|زیادکرا)/.test(txt), txt.slice(0, 120));
    await shot(page, 'printer-added');
    // Once per session: the next add needs no warning.
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForTimeout(1300);
    const adds2 = (await requests(page)).filter((r) => r.path === '/api/quick-buy/items' && r.method === 'POST');
    check('the next add in the session asks nothing, under a new key', adds2.length === 3 && !adds2[2].body.printerStandardDeliveryAcceptance && (await page.$('[data-overlay="quick-buy-printer-sheet"]')) === null && adds2[2].body.idempotencyKey !== adds2[1].body.idempotencyKey);
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // Declining the printer warning adds nothing and keeps Quick Buy on.
  async printerdecline(browser) {
    const page = await open(browser, 'view=product&profile=active&printer=1');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await untilMode(page, 'quick');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForSelector('[data-overlay="quick-buy-printer-sheet"] [data-quick-buy-printer-accept]', { timeout: 8000 });
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-overlay="quick-buy-printer-sheet"]', { state: 'detached', timeout: 6000 });
    await page.waitForTimeout(400);
    const state = await barMode(page);
    const session = await page.evaluate(() => window.quickBuyServer.session);
    check('declined: nothing added, Quick Buy still on', state === 'quick' && session === null, `${state} ${JSON.stringify(session)}`);
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // The saved address was deleted: the sheet asks only for a new one.
  async addressmissing(browser) {
    const page = await open(browser, 'view=product&profile=addressMissing');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForSelector('[data-overlay="quick-buy-sheet"] [data-quick-buy-activate]', { timeout: 8000 });
    await page.waitForTimeout(900);
    await shot(page, 'sheet-address-missing');
    const consents = await page.$$('[data-overlay="quick-buy-sheet"] [data-quick-buy-consent]');
    check('the address face asks no consents', consents.length === 0, String(consents.length));
    await page.click('[data-quick-buy-address="adr_work"]');
    await page.click('[data-quick-buy-activate]');
    await page.waitForSelector('[data-overlay="quick-buy-sheet"]', { state: 'detached', timeout: 8000 });
    await page.waitForTimeout(500);
    const put = (await requests(page)).find((r) => r.method === 'PUT');
    const state = await barMode(page);
    check('a new address is PUT {addressId, enabled} and Quick Buy is ready', put?.body?.addressId === 'adr_work' && put?.body?.enabled === true && state === 'quick' && !(await requests(page)).some((r) => r.path === '/api/quick-buy/activate'), JSON.stringify(put?.body));
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
    const settings = await open(browser, 'view=settings&profile=addressMissing');
    const said = await settings.waitForSelector('[data-quick-buy-address-missing]', { timeout: 8000 }).then(() => true, () => false);
    await scrollMain(settings, '#settings-quick-buy', 'start');
    await shot(settings, 'settings-address-missing');
    check('settings says the saved address is gone', said);
    await settings.close();
  },
  async settings(browser) {
    const page = await open(browser, 'view=settings&profile=active');
    await page.waitForSelector('[data-quick-buy-settings-switch]');
    await scrollMain(page, '#settings-quick-buy', 'start');
    await page.waitForTimeout(300);
    await shot(page, 'settings');
    await page.click('[data-quick-buy-settings-address]');
    await page.waitForSelector('[data-quick-buy-settings-address-option="adr_work"]');
    await page.waitForTimeout(300);
    await shot(page, 'settings-address-picker');
    await page.click('[data-quick-buy-settings-address-option="adr_work"]');
    await page.waitForTimeout(900);
    const put = (await requests(page)).find((r) => r.method === 'PUT');
    check('changing the address is PUT {addressId}', put?.body?.addressId === 'adr_work' && typeof put?.body?.idempotencyKey === 'string', JSON.stringify(put?.body));
    await page.click('[data-quick-buy-settings-switch] [role=switch]');
    await page.waitForTimeout(900);
    const off = (await requests(page)).filter((r) => r.method === 'PUT').pop();
    check('the switch is PUT {enabled:false}', off?.body?.enabled === false, JSON.stringify(off?.body));
    await shot(page, 'settings-off');
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  async reconsent(browser) {
    const page = await open(browser, 'view=settings&profile=reconsent');
    await page.waitForSelector('[data-quick-buy-reconsent]');
    await scrollMain(page, '#settings-quick-buy', 'start');
    await shot(page, 'settings-reconsent');
    await page.click('[data-quick-buy-reconsent] button');
    await page.waitForSelector('[data-overlay="quick-buy-sheet"] [data-quick-buy-activate]');
    await page.waitForTimeout(900);
    await shot(page, 'sheet-reconsent');
    await page.close();
  },

  async noaddress(browser) {
    const page = await open(browser, 'view=product&profile=inactive&addresses=0');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForSelector('[data-quick-buy-address-form] #addr-name', { timeout: 8000 });
    await page.waitForTimeout(700);
    await page.evaluate(() => document.querySelector('[data-quick-buy-address-form]')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await shot(page, 'sheet-no-address');
    await page.fill('#addr-name', 'زهراء علي');
    await page.fill('#addr-phone', '07701234567');
    await page.selectOption('#addr-gov', 'baghdad');
    await page.fill('#addr-street', 'شارع 62، دار 14');
    await page.locator('[data-quick-buy-address-form] button', { hasText: lang === 'en' ? 'Save address' : lang === 'ckb' ? 'پاشەکەوتی ناونیشان' : 'حفظ العنوان' }).click();
    await page.waitForSelector('[data-quick-buy-address]', { timeout: 8000 });
    const chosen = await page.$eval('[data-quick-buy-address]', (b) => b.getAttribute('aria-checked'));
    check('the address written inline is the one chosen', chosen === 'true');
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  async dismiss(browser) {
    const page = await open(browser, 'view=product&profile=inactive');
    await visible(page, '[data-quick-buy-capsule="quick"]').click();
    await page.waitForSelector('[data-overlay="quick-buy-sheet"] [data-quick-buy-activate]');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-overlay="quick-buy-sheet"]', { state: 'detached', timeout: 6000 });
    await page.waitForTimeout(400);
    const state = await barMode(page);
    check('closing without activating leaves the bar in cart mode', state === 'cart', state);
    await page.close();
  },

};

(async () => {
  const browser = await pw.chromium.launch();
  for (const name of scenarioArg === 'all' ? Object.keys(scenarios) : scenarioArg.split(',')) {
    console.log(`\n# ${name} (${tag})`);
    try {
      await scenarios[name](browser);
    } catch (e) {
      check(`${name} ran to the end`, false, String(e && e.message ? e.message : e).slice(0, 400));
    }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
