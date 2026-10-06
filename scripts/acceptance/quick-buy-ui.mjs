/**
 * Scenario 1 (§23) in a REAL browser against the REAL local Worker + D1.
 * Screens are driven by role/label where the UI names things, and every money
 * and stock claim is read back from D1. Screenshots: $OUT_DIR.
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

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-IQ', colorScheme: 'dark', hasTouch: true });
await ctx.addCookies([{ name: 'levonis_session', value: TOKENS.sara, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('lang', 'ar'); localStorage.setItem('levonis-lang', 'ar');
    // First-run sheets are someone else's journey: mark them seen for both accounts.
    localStorage.setItem('levonis.themeIntro.v1', JSON.stringify({ u_sara: 'seen', u_owner: 'seen' }));
  } catch { /* */ }
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// A refusal the UI handles (409 acknowledgement, 402 balance) logs a resource error in Chrome — not an app error.
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (409|402)/.test(m.text())) errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: `${OUT}qb-${n}.png`, fullPage: false });
/** Close any first-run modal that is not ours (profile/theme intros). */
async function dismissIntros() {
  for (let i = 0; i < 3; i++) {
    const modal = page.locator('[data-overlay-mode="modal"]').filter({ hasNot: page.locator('[data-quick-buy-consent]') });
    if (!(await modal.count()) || !(await modal.first().isVisible().catch(() => false))) return;
    const close = modal.first().getByRole('button', { name: /^(تم|لاحقًا|لاحقاً|إغلاق|تخطي)$/ });
    if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
}

try {
  await page.goto(`${BASE}/product/e2e-a1-combo`, { waitUntil: 'networkidle' });
  await dismissIntros();
  const bar = page.getByTestId('product-buybar');
  const cta = bar.getByTestId('product-cta');
  await cta.waitFor({ timeout: 20000 });
  check('product page shows «أضف إلى السلة»', /أضف إلى السلة/.test(await cta.innerText()), await cta.innerText());
  const toggle = bar.locator('[data-quick-buy-capsule="quick"]');
  const mode = () => bar.locator('[data-quick-buy-bar]').getAttribute('data-mode');
  check('the ⚡ capsule is beside it, named «تفعيل الشراء السريع»', (await toggle.isVisible()) && (await toggle.getAttribute('aria-label')) === 'تفعيل الشراء السريع');
  const box = async (l) => l.boundingBox();
  const [q0, c0] = [await box(toggle), await box(cta)];
  check('⚡ is the small capsule on the right (RTL), the cart the big one', q0.x > c0.x && q0.width < c0.width / 2, JSON.stringify({ q0, c0 }));
  await shot('1-product');

  // Not active yet: ⚡ opens the activation sheet.
  await toggle.click();
  const sheet = page.getByRole('dialog');
  await sheet.waitFor({ timeout: 10000 });
  check('activation sheet opens', /تفعيل الشراء السريع/.test(await sheet.innerText()));
  await sheet.locator('[data-quick-buy-consent]').first().waitFor({ timeout: 15000 });
  const boxes = sheet.getByRole('checkbox');
  const n = await boxes.count();
  let unchecked = 0; for (let i = 0; i < n; i++) if (!(await boxes.nth(i).isChecked())) unchecked++;
  check('no consent is pre-checked', n >= 4 && unchecked === n, `${unchecked}/${n}`);
  await shot('2-sheet-consent');
  for (let i = 0; i < n; i++) await boxes.nth(i).check({ force: true });
  const home = sheet.locator('[data-quick-buy-address="addr_home"]');
  if (await home.count()) await home.click();
  await shot('3-sheet-ready');
  await sheet.getByRole('button', { name: /تفعيل الشراء السريع|تفعيل الآن/ }).last().click();
  await page.waitForTimeout(1500);
  const prof = one(`SELECT enabled, address_id, policy_version FROM quick_buy_profiles WHERE user_id = 'u_sara'`);
  check('activation stored (address + policy version)', prof?.enabled === 1 && prof?.address_id === 'addr_home' && prof?.policy_version >= 1, JSON.stringify(prof));
  await shot('4-activated');

  // The sheet closed and the bar morphed by itself: [🛒][⚡ شراء سريع].
  await page.waitForTimeout(900);
  check('the bar morphed to Quick Buy without a second tap', (await mode()) === 'quick');
  const [q1, c1] = [await box(toggle), await box(cta)];
  check('⚡ took the cart\'s place: big on the right, 🛒 small on the left', q1.width > c1.width * 2 && c1.x < q1.x, JSON.stringify({ q1, c1 }));
  check('the small cart is named «العودة إلى الإضافة للسلة»', (await cta.getAttribute('aria-label')) === 'العودة إلى الإضافة للسلة');
  check('the big capsule reads «شراء سريع»', /شراء سريع/.test(await toggle.innerText()), await toggle.innerText());
  await toggle.click();
  // The printer asks for the standard-delivery acknowledgement first (the
  // server answered PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED).
  const ack = page.getByRole('dialog').filter({ hasText: 'تحذير التوصيل العادي' });
  await ack.waitFor({ timeout: 15000 });
  const go = ack.getByRole('button', { name: /موافقة وإضافة/ });
  check('acknowledgement: unchecked, button disabled until read', !(await ack.getByRole('checkbox').first().isChecked()) && (await go.isDisabled()));
  await shot('5-printer-ack');
  await ack.getByRole('checkbox').first().check({ force: true });
  await go.click();
  await page.waitForTimeout(3000);
  let s = one(`SELECT id, state, total_iqd, held_iqd, shipping_iqd FROM quick_buy_sessions WHERE user_id='u_sara' AND state='open'`);
  check('a session opened with the printer held', s && s.total_iqd === 600000 && s.held_iqd === 600000 && s.shipping_iqd === 0, JSON.stringify(s));
  await shot('6-bought');

  // Filament from another page, three units.
  await page.goto(`${BASE}/product/e2e-pla-basic`, { waitUntil: 'networkidle' });
  await dismissIntros();
  const bar2 = page.getByTestId('product-buybar');
  const plus = bar2.getByRole('button', { name: /زيادة الكمية/ });
  if (await plus.count()) { await plus.first().click(); await plus.first().click(); }
  const quick2 = bar2.locator('[data-quick-buy-capsule="quick"]');
  if ((await bar2.locator('[data-quick-buy-bar]').getAttribute('data-mode')) !== 'quick') { await quick2.click(); await page.waitForTimeout(900); }
  await quick2.click();
  await page.waitForTimeout(2500);
  const lines = sql(REPO, `SELECT product_id, qty FROM quick_buy_items WHERE session_id='${s.id}' AND qty > 0 ORDER BY product_id`);
  check('filament joined the same session', lines.length === 2, JSON.stringify(lines));
  await shot('7-filament');

  // The orders page: the live card with its clock.
  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const body = await page.locator('body').innerText();
  check('the Quick Buy card shows on «طلباتي»', /شراء سريع/.test(body));
  check('a live clock is shown', /\d{1,2}:\d{2}/.test(body));
  await page.screenshot({ path: `${OUT}qb-8-orders-card.png`, fullPage: true });

  // Reduce the filament from the card if it offers a «−».
  const plaRow = page.locator('[data-quick-buy-item]').filter({ hasText: 'PLA' });
  const plaBefore = one(`SELECT qty FROM quick_buy_items WHERE session_id='${s.id}' AND product_id='p_e2e_pla' AND qty > 0`);
  await plaRow.locator('[data-mascot="qty-dec"]').click();
  await page.waitForTimeout(2500);
  const plaAfter = one(`SELECT qty FROM quick_buy_items WHERE session_id='${s.id}' AND product_id='p_e2e_pla' AND qty > 0`);
  check('«−» on the filament line takes one unit off', Number(plaAfter?.qty) === Number(plaBefore?.qty) - 1, JSON.stringify({ plaBefore, plaAfter }));
  const sid = s.id;
  s = one(`SELECT id, total_iqd, held_iqd FROM quick_buy_sessions WHERE id='${sid}'`);
  const hold = one(`SELECT h.amount_cents, q.held_cents FROM wallet_holds h JOIN quick_buy_sessions q ON q.hold_id = h.id WHERE q.id='${sid}' AND h.state='active'`);
  check('money held equals the new total, and the wallet hold agrees', s.total_iqd === s.held_iqd && Number(hold?.amount_cents) === Number(hold?.held_cents), JSON.stringify({ s, hold }));
  await page.screenshot({ path: `${OUT}qb-9-after-edit.png`, fullPage: true });

  // 00:00 — the server submits it.
  sql(REPO, `UPDATE quick_buy_sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id = '${s.id}'`);
  await page.goto('about:blank'); // no page of ours is open: the server alone must finish it
  await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('* * * * *')}`);
  let done = null;
  for (let i = 0; i < 20; i++) { done = one(`SELECT state, order_id, finalize_attempts FROM quick_buy_sessions WHERE id='${s.id}'`); if (done.state !== 'open') break; await page.waitForTimeout(500); }
  check('the cron submitted it into an ordinary order with no page open', done.state === 'submitted', JSON.stringify(done));
  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const after = await page.locator('body').innerText();
  check('the order is listed with the other orders', after.includes(done.order_id.slice(-6)) || after.includes(done.order_id), done.order_id);
  await page.screenshot({ path: `${OUT}qb-10-orders-after.png`, fullPage: true });
  await page.goto(`${BASE}/wallet`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}qb-11-wallet.png`, fullPage: true });
  check('wallet shows the Quick Buy payment label', /شراء سريع/.test(await page.locator('body').innerText()));
} catch (e) {
  failed++; console.log('FAIL  crashed:', e?.message ?? e);
  await shot('crash').catch(() => {});
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed — shots in ${OUT}`);
process.exit(failed ? 1 : 0);
