/** «هداياي» and the admin «الهدايا» screens, mounted with explicit API
 * fixtures (tests/browser/gifts.html). Run against Vite:
 * PLAYWRIGHT_MODULE=/path/to/playwright GIFTS_TEST_URL=http://127.0.0.1:4196/tests/browser/gifts.html node scripts/e2e-gifts.mjs
 * OUT_DIR picks where the screenshots go; CHROMIUM_PATH may select an already-installed browser. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.GIFTS_TEST_URL || 'http://127.0.0.1:4196/tests/browser/gifts.html';
const output = process.env.OUT_DIR || '/tmp/levonis-gifts-ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
let checks = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  checks++;
  console.log(`ok ${name}`);
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const requests = (page) => page.evaluate(() => window.giftRequests || []);
/** Every API call a screen made must be one the fixture answers. */
const unstubbed = (page) => page.evaluate(() => window.giftUnstubbed || []);
const T = {
  ar: { choose: 'تأكيد الاختيار', redeem: 'استرداد الهدية', confirm: 'استرداد', add: 'أضف إلى السلة', redeemed: 'تم استرداد الهدية', inCart: 'الهدية في سلتك', grant: 'منح هدية', grantAction: 'منح الهدية', addItem: 'إضافة منتج' },
  en: { choose: 'Confirm choice', redeem: 'Redeem gift', confirm: 'Redeem', add: 'Add to cart', redeemed: 'Gift redeemed', inCart: 'The gift is in your cart', grant: 'Grant a gift', grantAction: 'Grant gift', addItem: 'Add product' },
  ckb: { choose: 'پشتڕاستکردنەوەی هەڵبژاردن', redeem: 'وەرگرتنەوەی دیاری', confirm: 'وەرگرتنەوە', add: 'زیادکردن بۆ سەبەتە', redeemed: 'دیارییەکە وەرگیرایەوە', inCart: 'دیارییەکە لە سەبەتەکەتدایە', grant: 'بەخشینی دیاری', grantAction: 'بەخشینی دیاری', addItem: 'زیادکردنی بەرهەم' },
};

async function open(params, { width = 390, reduced = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 600, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const crashes = [];
  page.on('pageerror', (e) => crashes.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) crashes.push(m.text());
  });
  await page.goto(`${base}?${new URLSearchParams(params)}`, { waitUntil: 'networkidle' });
  return { page, crashes };
}

try {
  // ---------------------------------------------------------------- 1. every status, every language and theme
  for (const lang of ['ar', 'en', 'ckb']) {
    for (const theme of ['dark', 'light']) {
      const tag = `customer-all-${lang}-${theme}-390`;
      const { page, crashes } = await open({ view: 'customer', scenario: 'all', lang, theme });
      await page.locator('[data-gift-card]').first().waitFor();
      const statuses = await page.locator('[data-gift-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-gift-status')));
      check(`${tag}: one card per status, actionable first`, JSON.stringify(statuses) === JSON.stringify(['GRANTED', 'READY_TO_REDEEM', 'REDEEMED', 'ADDED_TO_ORDER', 'ORDERED', 'LEGACY', 'FULFILLED', 'CANCELLED']));
      check(`${tag}: the level's three alternatives, the sold-out one disabled`, (await page.locator('[data-gift-choice]').count()) === 3 && (await page.locator('[data-gift-choice="gpi_cleaner"]').getAttribute('aria-disabled')) === 'true');
      check(`${tag}: each status offers its own action`, (await page.locator('[data-gift-action="redeem"]').count()) === 1 && (await page.locator('[data-gift-action="add-to-cart"]').count()) === 1 && (await page.locator('[data-gift-action="go-to-cart"]').count()) === 1 && (await page.locator('[data-gift-action="view-order"]').count()) === 2);
      check(`${tag}: the ordered card links its order`, (await page.locator('[data-gift-card="gift_ordered"] [data-gift-action="view-order"]').getAttribute('href')) === '/orders/ORD-7F3A21C9');
      check(`${tag}: the price is 0 and the value is shown`, (await page.locator('[data-gift-card="gift_redeemed"]').innerText()).includes(lang === 'en' ? '0 IQD' : '0 د.ع'));
      const lead = { ar: 'يصل خلال 10–14 يومًا', en: 'Arrives in 10–14 days', ckb: 'لە ماوەی 10–14 ڕۆژدا دەگات' }[lang];
      check(`${tag}: a pre-order's lead time reads in the page's language`, (await page.locator('[data-gift-card="gift_ordered"]').innerText()).includes(lead) && !(await page.locator('main, body').first().innerText()).includes('10-14 days'));
      check(`${tag}: no page overflow`, await noOverflow(page));
      check(`${tag}: no crashes`, crashes.length === 0);
      check(`${tag}: every call answered by the fixture`, (await unstubbed(page)).length === 0);
      await page.screenshot({ path: `${output}/${tag}.png`, fullPage: true });
      await page.close();
    }
  }
  {
    const { page, crashes } = await open({ view: 'customer', scenario: 'all', lang: 'ar', theme: 'dark' }, { width: 1280 });
    await page.locator('[data-gift-card]').first().waitFor();
    check('customer-all-ar-dark-1280: no overflow, no crash', (await noOverflow(page)) && crashes.length === 0);
    await page.screenshot({ path: `${output}/customer-all-ar-dark-1280.png`, fullPage: true });
    await page.close();
  }

  // ---------------------------------------------------------------- 2. one gift through the flow
  for (const [lang, theme, reduced] of [['ar', 'dark', false], ['en', 'light', true], ['ckb', 'dark', false]]) {
    const t = T[lang];
    const tag = `customer-flow-${lang}-${theme}`;
    const { page, crashes } = await open({ view: 'customer', scenario: 'flow', lang, theme }, { reduced });
    const card = page.locator('[data-gift-card="gift_flow"]');
    await card.waitFor();
    check(`${tag}: starts at «اختر هديتك»`, (await card.getAttribute('data-gift-status')) === 'GRANTED');
    check(`${tag}: nothing chosen, nothing confirmable`, await page.getByRole('button', { name: t.choose }).isDisabled());
    // Keyboard first: Tab to the first alternative, its focus is visible, Enter picks it.
    let focused = '';
    for (let i = 0; i < 12 && !focused; i++) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.getAttribute('data-gift-choice') || '');
    }
    check(`${tag}: the alternatives are reachable by keyboard`, focused === 'gpi_nozzle');
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    check(`${tag}: keyboard focus is visible`, outline !== 'none');
    await page.keyboard.press('Enter');
    check(`${tag}: the picked alternative is checked`, (await page.locator('[data-gift-choice="gpi_nozzle"]').getAttribute('aria-checked')) === 'true');
    await page.locator('[data-gift-choice="gpi_cleaner"]').click({ force: true });
    check(`${tag}: a sold-out alternative cannot be picked`, (await page.locator('[data-gift-choice="gpi_cleaner"]').getAttribute('aria-checked')) === 'false');
    await page.screenshot({ path: `${output}/${tag}-1-choose.png`, fullPage: true });
    await page.getByRole('button', { name: t.choose }).click();
    await page.locator('[data-gift-card="gift_flow"][data-gift-status="READY_TO_REDEEM"]').waitFor();
    check(`${tag}: chosen → ready to redeem, with a way to change it`, (await page.locator('[data-gift-action="change"]').count()) === 1);
    await page.screenshot({ path: `${output}/${tag}-2-ready.png`, fullPage: true });
    await page.getByRole('button', { name: t.redeem }).click();
    const dialog = page.locator('[data-overlay="gift-redeem-confirm"]');
    await dialog.waitFor();
    check(`${tag}: redeeming asks first`, await dialog.isVisible());
    await page.screenshot({ path: `${output}/${tag}-3-confirm.png`, fullPage: true });
    check(`${tag}: the dialog's action says what it does`, (await dialog.locator('[data-confirm-action]').innerText()).trim() === t.confirm);
    await dialog.locator('[data-confirm-action]').click();
    await page.locator('[data-gift-card="gift_flow"][data-gift-status="REDEEMED"]').waitFor();
    await dialog.waitFor({ state: 'detached' });
    check(`${tag}: «تم استرداد الهدية ✓»`, (await card.innerText()).includes(t.redeemed));
    await page.screenshot({ path: `${output}/${tag}-4-redeemed.png`, fullPage: true });
    await page.getByRole('button', { name: t.add }).click();
    await page.locator('[data-gift-card="gift_flow"][data-gift-status="ADDED_TO_ORDER"]').waitFor();
    check(`${tag}: in the cart, with the way to it`, (await card.innerText()).includes(t.inCart) && (await page.locator('[data-gift-action="go-to-cart"]').getAttribute('href')) === '/cart');
    await page.screenshot({ path: `${output}/${tag}-5-in-cart.png`, fullPage: true });
    const sent = (await requests(page)).filter((r) => r.method === 'POST');
    check(
      `${tag}: one choose, one redeem, one add — and the add sends nothing but the gift`,
      JSON.stringify(sent.map((r) => [r.path, r.body])) ===
        JSON.stringify([
          ['/api/gifts/gift_flow/choose', { itemId: 'gpi_nozzle' }],
          ['/api/gifts/gift_flow/redeem', {}],
          ['/api/cart/gift-items', { giftId: 'gift_flow' }],
        ])
    );
    check(`${tag}: no overflow`, await noOverflow(page));
    check(`${tag}: no crashes`, crashes.length === 0);
    check(`${tag}: every call answered by the fixture`, (await unstubbed(page)).length === 0);
    await page.close();
  }

  // ---------------------------------------------------------------- 2b. the cart holds another shipping type
  const CONFLICT = {
    ar: { title: 'نوع شحن مختلف', action: 'إفراغ السلة وإضافة الهدية' },
    en: { title: 'A different shipping type', action: 'Empty cart and add the gift' },
  };
  for (const [lang, theme, answer] of [['ar', 'dark', 'confirm'], ['en', 'light', 'cancel']]) {
    const tag = `customer-conflict-${lang}-${theme}`;
    const { page, crashes } = await open({ view: 'customer', scenario: 'all', lang, theme, conflict: 'shipping' });
    const card = page.locator('[data-gift-card="gift_redeemed"]');
    await card.waitFor();
    await card.locator('[data-gift-action="add-to-cart"]').click();
    const dialog = page.locator('[data-overlay="gift-shipping-conflict"]');
    await dialog.waitFor();
    check(`${tag}: the server's refusal becomes a question`, (await dialog.innerText()).includes(CONFLICT[lang].title));
    check(`${tag}: the action says what it does`, (await dialog.locator('[data-confirm-action]').innerText()).trim() === CONFLICT[lang].action);
    await page.screenshot({ path: `${output}/${tag}.png`, fullPage: true });
    if (answer === 'confirm') {
      await dialog.locator('[data-confirm-action]').click();
      await page.locator('[data-gift-card="gift_redeemed"][data-gift-status="ADDED_TO_ORDER"]').waitFor();
    } else {
      await page.keyboard.press('Escape');
    }
    await dialog.waitFor({ state: 'detached' });
    const sent = (await requests(page)).filter((r) => r.method === 'POST').map((r) => [r.path, r.body]);
    const expected = [['/api/cart/gift-items', { giftId: 'gift_redeemed' }]];
    if (answer === 'confirm') expected.push(['/api/cart/gift-items', { giftId: 'gift_redeemed', replaceCart: true }]);
    check(`${tag}: ${answer === 'confirm' ? 'the cart is emptied only on «yes»' : '«no» leaves the cart and the gift alone'}`, JSON.stringify(sent) === JSON.stringify(expected));
    check(`${tag}: the gift ends ${answer === 'confirm' ? 'in the cart' : 'still redeemed'}`, (await card.getAttribute('data-gift-status')) === (answer === 'confirm' ? 'ADDED_TO_ORDER' : 'REDEEMED'));
    check(`${tag}: no overflow, no crash`, (await noOverflow(page)) && crashes.length === 0);
    await page.close();
  }

  // ---------------------------------------------------------------- 3. the admin levels
  for (const [lang, theme, width] of [['ar', 'dark', 390], ['ar', 'dark', 1280], ['en', 'light', 1280], ['ckb', 'dark', 390], ['ar', 'light', 390]]) {
    const tag = `admin-levels-${lang}-${theme}-${width}`;
    const { page, crashes } = await open({ view: 'admin', tab: 'levels', lang, theme }, { width });
    await page.locator('[data-gift-level]').first().waitFor();
    check(`${tag}: five levels`, (await page.locator('[data-gift-level]').count()) === 5);
    check(`${tag}: level 3 lists its products, the stopped one last`, (await page.locator('[data-gift-level="3"] [data-gift-level-item]').count()) === 3);
    check(`${tag}: no overflow`, await noOverflow(page));
    await page.screenshot({ path: `${output}/${tag}.png`, fullPage: true });
    if (lang === 'ar' && theme === 'dark') {
      await page.locator('[data-gift-add-item="1"]').click();
      const sheet = page.locator('[data-gift-item-sheet]');
      await sheet.waitFor();
      await sheet.locator('#gift-item-product button').first().click();
      await sheet.getByRole('option').first().click();
      await sheet.locator('select').first().waitFor();
      const selects = sheet.locator('select');
      await selects.nth(1).selectOption('v_04');
      await selects.nth(2).selectOption('c_blue');
      await page.screenshot({ path: `${output}/${tag}-item-sheet.png`, fullPage: true });
      await sheet.locator('[data-gift-item-save]').click();
      await sheet.waitFor({ state: 'detached' });
      const post = (await requests(page)).find((r) => r.method === 'POST' && r.path === '/api/gifts/admin/levels/1/items');
      check(`${tag}: the item sheet sends the pinned selection`, !!post && post.body.productId === 'p_nozzle' && JSON.stringify(post.body.optionValueIds) === '["v_04"]' && post.body.colorId === 'c_blue' && post.body.qty === 1 && post.body.saleType === 'direct_sale');
    }
    check(`${tag}: no crashes`, crashes.length === 0);
    check(`${tag}: every call answered by the fixture`, (await unstubbed(page)).length === 0);
    await page.close();
  }

  // ---------------------------------------------------------------- 4. the admin grants, detail and grant sheet
  for (const [lang, theme, width] of [['ar', 'dark', 1280], ['ar', 'dark', 390], ['en', 'light', 390], ['ckb', 'light', 1280]]) {
    const t = T[lang];
    const tag = `admin-grants-${lang}-${theme}-${width}`;
    const { page, crashes } = await open({ view: 'admin', tab: 'grants', lang, theme }, { width });
    await page.locator('[data-gift-grant-row]').first().waitFor();
    check(`${tag}: every grant listed`, (await page.locator('[data-gift-grant-row]').count()) === 8);
    check(`${tag}: no overflow`, await noOverflow(page));
    await page.screenshot({ path: `${output}/${tag}.png`, fullPage: true });
    await page.locator('[data-gift-grant-row="gift_ordered"]').click();
    const detail = page.locator('[data-gift-detail="gift_ordered"]');
    await detail.locator('[data-gift-timeline] li').first().waitFor();
    check(`${tag}: the detail carries the internal note and the timeline`, (await detail.locator('textarea').last().inputValue()).includes('تأخر الطلب السابق') && (await detail.locator('[data-gift-timeline] li').count()) === 7);
    // Every step reads as words in the page's language — no raw action code.
    check(`${tag}: the timeline names the cart steps in words`, !(await detail.locator('[data-gift-timeline]').innerText()).includes('gift.'));
    await page.screenshot({ path: `${output}/${tag}-detail.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await detail.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: t.grant }).first().click();
    const sheet = page.locator('[data-gift-grant-sheet]');
    await sheet.waitFor();
    await sheet.locator('#gift-grant-user').fill('sara');
    await sheet.getByRole('listbox').getByRole('option').first().click();
    await sheet.locator('[data-gift-grant-level="3"]').click();
    await sheet.locator('[data-gift-grant-how="item"]').click();
    await sheet.getByRole('radio').first().click();
    await sheet.locator('select').first().selectOption('compensation');
    await sheet.locator('textarea').first().fill('تعويض عن التأخير');
    await page.screenshot({ path: `${output}/${tag}-grant-sheet.png`, fullPage: true });
    await sheet.locator('[data-gift-grant-submit]').click();
    await sheet.waitFor({ state: 'detached' });
    const post = (await requests(page)).find((r) => r.method === 'POST' && r.path === '/api/gifts/admin/grants');
    check(
      `${tag}: the grant sends who, which level item, why, the internal note and a request key`,
      !!post && post.body.userId === 'u_sara' && post.body.mode === 'level' && post.body.level === 3 && post.body.itemId === 'gpi_nozzle' && post.body.reason === 'compensation' && post.body.note === 'تعويض عن التأخير' && /^gift-grant-/.test(post.body.idempotencyKey)
    );
    await page.locator('[data-gift-detail]').first().waitFor();
    await page.screenshot({ path: `${output}/${tag}-granted.png`, fullPage: true });
    check(`${tag}: no crashes`, crashes.length === 0);
    check(`${tag}: every call answered by the fixture`, (await unstubbed(page)).length === 0);
    await page.close();
  }
  // ---------------------------------------------------------------- 5. the gift line in the cart, the order and the orders list
  const WORD = { ar: 'هدية', en: 'Gift', ckb: 'دیاری' };
  const ITEMS_TAB = { ar: 'المنتجات', en: 'Items', ckb: 'کاڵاکان' };
  for (const [lang, theme] of [['ar', 'dark'], ['en', 'light'], ['ckb', 'dark']]) {
    {
      const tag = `cart-${lang}-${theme}-390`;
      const { page, crashes } = await open({ view: 'cart', lang, theme });
      const line = page.locator('[data-cart-gift-line]');
      await line.waitFor();
      check(`${tag}: the gift line says «${WORD[lang]}» and costs 0`, (await line.innerText()).includes(WORD[lang]) && (await line.innerText()).includes('0 د.ع'));
      check(`${tag}: nothing on the gift line can be edited`, (await line.locator('input').count()) === 0);
      check(`${tag}: the bought line keeps its stepper`, (await page.locator('input[inputmode="numeric"]').count()) >= 1);
      check(`${tag}: no overflow, no crash`, (await noOverflow(page)) && crashes.length === 0);
      check(`${tag}: every call answered by the fixture`, (await unstubbed(page)).length === 0);
      await page.screenshot({ path: `${output}/${tag}.png`, fullPage: true });
      await page.close();
    }
    {
      const tag = `order-${lang}-${theme}-390`;
      const { page, crashes } = await open({ view: 'order', lang, theme });
      await page.getByRole('tab', { name: ITEMS_TAB[lang] }).click();
      const line = page.locator('[data-order-gift-line]');
      await line.waitFor();
      check(`${tag}: the order says «${WORD[lang]} — 0»`, (await line.innerText()).includes(WORD[lang]) && (await line.innerText()).includes('0'));
      check(`${tag}: exactly one gift line`, (await page.locator('[data-order-gift-line]').count()) === 1);
      check(`${tag}: no overflow, no crash`, (await noOverflow(page)) && crashes.length === 0);
      await page.screenshot({ path: `${output}/${tag}.png`, fullPage: true });
      await page.close();
    }
    {
      const tag = `orders-${lang}-${theme}-390`;
      const { page, crashes } = await open({ view: 'orders', lang, theme });
      await page.locator('[data-order-card-gift]').first().waitFor();
      await page.locator('[data-gifts-count]').waitFor();
      check(`${tag}: the order card marks the gift`, (await page.locator('[data-order-card-gift]').innerText()).includes(WORD[lang]));
      check(`${tag}: «هداياي» counts what waits for the customer`, (await page.locator('[data-gifts-count]').getAttribute('data-gifts-count')) === '4');
      check(`${tag}: no overflow, no crash`, (await noOverflow(page)) && crashes.length === 0);
      check(`${tag}: every call answered by the fixture`, (await unstubbed(page)).length === 0);
      await page.screenshot({ path: `${output}/${tag}.png`, fullPage: true });
      await page.close();
    }
  }
  console.log(`${checks} checks passed; screenshots in ${output}`);
} finally {
  await browser.close();
}
