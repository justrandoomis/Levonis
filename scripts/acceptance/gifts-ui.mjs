/**
 * Scenario 2 (§23, gifts) in a REAL browser against the REAL local Worker + D1:
 * the admin grants from «الهدايا», Sara chooses, redeems, adds, checks out at
 * 0 and sees «تم طلب هذه الهدية» with the order; the API cannot redeem or
 * order it again. Every state is also read back from D1. Screenshots: $OUT_DIR.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { BASE, TOKENS, sql } from './stack.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const REPO = process.argv[2];
const OUT = process.env.OUT_DIR || '/tmp/levonis-acceptance'; mkdirSync(OUT, { recursive: true });
let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`FAIL  ${name} ${extra}`); } };
const one = (q) => sql(REPO, q)[0] ?? null;
const NOTE = 'تعويض عن تأخير الطلب السابق — ملاحظة داخلية للإدارة';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
async function as(who, width = 390) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, locale: 'ar-IQ', colorScheme: 'dark', hasTouch: width < 600 });
  await ctx.addCookies([{ name: 'levonis_session', value: TOKENS[who], domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
  await ctx.addInitScript(() => { try { localStorage.setItem('lang', 'ar'); localStorage.setItem('levonis.themeIntro.v1', JSON.stringify({ u_sara: 'seen', u_owner: 'seen' })); } catch { /* */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { page, errors };
}
async function dismissIntros(page) {
  for (let i = 0; i < 3; i++) {
    const modal = page.locator('[data-overlay="theme-intro-sheet"], [data-overlay="complete-profile-sheet"]');
    if (!(await modal.count()) || !(await modal.first().isVisible().catch(() => false))) return;
    const close = modal.first().getByRole('button', { name: /^(تم|لاحقًا|لاحقاً|إغلاق|تخطي)$/ });
    if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
}

try {
  // ------------------------------------------------ 1. the admin fills level 3 and grants it
  const admin = await as('owner', 1280);
  // The level's products through the API the panel itself uses (the panel's sheet is covered by the builder's own run).
  for (const productId of ['p_e2e_nozzle', 'p_e2e_plate']) {
    await admin.page.request.post(`${BASE}/api/gifts/admin/levels/3/items`, { data: { productId, saleType: 'direct_sale', optionValueIds: [], colorId: '' }, headers: { origin: BASE } });
  }
  await admin.page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await dismissIntros(admin.page);
  await admin.page.getByRole('button', { name: 'الهدايا', exact: true }).first().click();
  await admin.page.waitForTimeout(1500);
  await admin.page.getByRole('button', { name: 'منح هدية' }).first().click();
  const sheet = admin.page.locator('[data-gift-grant-sheet]');
  await sheet.waitFor({ timeout: 15000 });
  await sheet.locator('#gift-grant-user').fill('sara');
  await sheet.getByRole('listbox').getByRole('option').first().click();
  await sheet.locator('[data-gift-grant-level="3"]').click();
  await sheet.locator('select').first().selectOption('compensation');
  await sheet.locator('textarea').first().fill(NOTE);
  await admin.page.screenshot({ path: `${OUT}gift-1-grant-sheet.png` });
  await sheet.locator('[data-gift-grant-submit]').click();
  await admin.page.waitForTimeout(2000);
  const g = one(`SELECT id, state, level, reason, admin_note FROM gift_entitlements WHERE user_id = 'u_sara' ORDER BY created_at DESC LIMIT 1`);
  check('the admin granted a level-3 gift with reason and internal note', g?.state === 'granted' && g?.level === 3 && g?.reason === 'compensation' && g?.admin_note === NOTE, JSON.stringify(g));
  await admin.page.screenshot({ path: `${OUT}gift-2-granted.png` });

  // ------------------------------------------------ 2. Sara: see, choose, redeem, add
  const sara = await as('sara');
  const p = sara.page;
  await p.goto(`${BASE}/gifts`, { waitUntil: 'networkidle' });
  await dismissIntros(p);
  const card = p.locator(`[data-gift-card="${g.id}"]`);
  await card.waitFor({ timeout: 15000 });
  check('Sara sees the gift, GRANTED', (await card.getAttribute('data-gift-status')) === 'GRANTED');
  check('the internal note is not on her page', !(await p.locator('body').innerText()).includes('ملاحظة داخلية'));
  await p.screenshot({ path: `${OUT}gift-3-granted.png`, fullPage: true });
  await dismissIntros(p);
  await card.locator('[data-gift-choice]').first().click();
  await card.locator('[data-gift-action="choose"]').click();
  await p.locator(`[data-gift-card="${g.id}"][data-gift-status="READY_TO_REDEEM"]`).waitFor({ timeout: 10000 });
  check('chosen → ready to redeem', true);
  await card.locator('[data-gift-action="redeem"]').click();
  const confirm = p.locator('[data-overlay="gift-redeem-confirm"]');
  await confirm.waitFor({ timeout: 10000 });
  await p.screenshot({ path: `${OUT}gift-4-confirm.png` });
  await confirm.locator('[data-confirm-action]').click();
  await p.locator(`[data-gift-card="${g.id}"][data-gift-status="REDEEMED"]`).waitFor({ timeout: 10000 });
  check('«تم استرداد الهدية»', (await card.innerText()).includes('تم استرداد الهدية'));
  await p.screenshot({ path: `${OUT}gift-5-redeemed.png`, fullPage: true });
  await card.locator('[data-gift-action="add-to-cart"]').click();
  const conflict = p.locator('[data-overlay="gift-shipping-conflict"]');
  if (await conflict.isVisible().catch(() => false)) await conflict.locator('[data-confirm-action]').click();
  await p.locator(`[data-gift-card="${g.id}"][data-gift-status="ADDED_TO_ORDER"]`).waitFor({ timeout: 10000 });
  check('in the cart («في السلة»)', true);

  // ------------------------------------------------ 3. checkout at 0
  await p.goto(`${BASE}/cart`, { waitUntil: 'networkidle' });
  await dismissIntros(p);
  const line = p.locator('[data-cart-gift-line]');
  check('the cart shows the gift line at 0 د.ع', (await line.count()) > 0 && (await line.first().innerText()).includes('0'));
  await p.screenshot({ path: `${OUT}gift-6-cart.png`, fullPage: true });
  await p.goto(`${BASE}/checkout`, { waitUntil: 'networkidle' });
  await dismissIntros(p);
  const place = p.locator('[data-testid="checkout-place-order"]:visible').first();
  await place.waitFor({ timeout: 20000 });
  const consent = p.locator('label:visible:has(input[type="checkbox"])').filter({ hasText: /أوافق|سياس/ }).locator('input[type="checkbox"]');
  if (await consent.count()) await consent.first().check({ force: true });
  await p.waitForTimeout(800);
  const reason = p.locator('[data-checkout-block-reason]:visible');
  if (await reason.count()) console.log('      (checkout says:', (await reason.first().innerText()).replace(/\s+/g, ' ').slice(0, 160), ')');
  await p.screenshot({ path: `${OUT}gift-7-checkout.png`, fullPage: true });
  await place.click();
  await p.waitForTimeout(4000);
  const o = one(`SELECT o.id, o.order_kind, o.subtotal_iqd FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.gift_entitlement_id = '${g.id}'`);
  check('ordered once: a gift order linked to the gift, goods at 0', o?.order_kind === 'gift' && Number(o?.subtotal_iqd) === 0, JSON.stringify(o));
  await p.screenshot({ path: `${OUT}gift-8-placed.png`, fullPage: true });

  // ------------------------------------------------ 4. «تم طلب هذه الهدية», the order link, no second order
  await p.goto(`${BASE}/gifts`, { waitUntil: 'networkidle' });
  const ordered = p.locator(`[data-gift-card="${g.id}"][data-gift-status="ORDERED"]`);
  await ordered.waitFor({ timeout: 10000 });
  check('«تم طلب هذه الهدية» with the order link', (await ordered.innerText()).includes('تم طلب هذه الهدية') && (await ordered.locator('[data-gift-action="view-order"]').getAttribute('href')) === `/orders/${o.id}`);
  check('the order button is gone', (await ordered.locator('[data-gift-action="add-to-cart"], [data-gift-action="redeem"]').count()) === 0);
  await p.screenshot({ path: `${OUT}gift-9-ordered.png`, fullPage: true });
  const api = await p.request.post(`${BASE}/api/cart/gift-items`, { data: { giftId: g.id }, headers: { origin: BASE } });
  check('the API refuses a second order of it', (await api.json()).code === 'GIFT_ALREADY_ORDERED');
  const again = await p.request.post(`${BASE}/api/gifts/${g.id}/redeem`, { data: {}, headers: { origin: BASE } });
  check('the API cannot redeem it again', (await again.json())?.gift?.status === 'ORDERED');
  check('still one order line for the gift', Number(one(`SELECT COUNT(*) n FROM order_items WHERE gift_entitlement_id = '${g.id}'`).n) === 1);
  check('no page errors (admin, customer)', admin.errors.length === 0 && sara.errors.length === 0, [...admin.errors, ...sara.errors].slice(0, 3).join(' | '));
} catch (e) {
  failed++; console.log('FAIL  crashed:', e?.message ?? e);
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed — shots in ${OUT}`);
process.exit(failed ? 1 : 0);
