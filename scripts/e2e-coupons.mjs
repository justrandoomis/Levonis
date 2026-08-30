#!/usr/bin/env node
/**
 * Promo codes, from the admin creating one to the discount on the order.
 *
 * WHY THIS EXISTS. The engine behind coupons has been in the schema since
 * migration 0002 — tiers, date windows, global and per-user limits, fixed and
 * percentage discounts — and none of it was reachable: no admin screen could
 * create a code, and the storefront's promo box was disabled with "قريباً"
 * written on the button. So there was a validated, tested engine that had
 * never once run against a real order.
 *
 * This walks the whole path. It also pins the two things a half-built version
 * would get wrong: a coupon must reduce the total the customer actually pays,
 * and a customer who is refused must be told WHY — "invalid" for a minimum
 * spend they are twenty dinars short of is how support tickets are made.
 *
 * PRIME is checked deliberately. `coupons.tier_required` had a CHECK
 * constraint admitting only ('plus','pro'), written before PRIME existed, and
 * the tier test compared by equality — so a PRIME member, the TOP tier, was
 * refused every coupon a PRO member got.
 *
 *   node scripts/e2e-coupons.mjs        (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const settle = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* rebinding */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the dev server did not come back after a direct SQL statement');
};
const sql = (statement) => {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  return execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' }).toString();
};

class Client {
  constructor() { this.cookie = ''; }
  async call(method, p, body) {
    const h = {};
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    // `wrangler d1 execute --local` re-binds the SQLite file the dev server
    // has mapped, and miniflare drops every open socket when it does. The
    // request after a direct statement can therefore die on a closed socket
    // through no fault of the code under test — retried once, so a transport
    // hiccup never reads as a failed assertion.
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  patch(p, b) { return this.call('PATCH', p, b); }
  del(p) { return this.call('DELETE', p); }
}

const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
const lower = rnd.toLowerCase();
const password = 'coupon-pass-1';

async function main() {
  console.log(`\nLEVONIS promo codes — admin to order — ${BASE}\n`);

  console.log('0. an admin, a customer and something to buy');
  const admin = new Client(), buyer = new Client();
  const adminEmail = `cpa-${lower}@test.local`, buyerEmail = `cpb-${lower}@test.local`;
  await admin.post('/api/auth/register', { email: adminEmail, username: `cpa${lower}`, name: 'A', password });
  sql(`UPDATE users SET role='admin' WHERE email='${adminEmail}'`);
  await settle();
  await admin.post('/api/auth/login', { email: adminEmail, password });
  await buyer.post('/api/auth/register', { email: buyerEmail, username: `cpb${lower}`, name: 'B', password });
  await buyer.post('/api/auth/login', { email: buyerEmail, password });

  const cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const section = cats.find((c) => c.effective_template_family === 'devices') ?? cats[0];
  const productId = (await admin.post('/api/admin/products-v2', {
    name_en: `Coupon fixture ${rnd}`, description_en: 'x', price_iqd: 200000, status: 'active',
    sale_types: ['direct_sale'], category_id: section?.id ?? null, stock: 20,
  })).data?.product?.id;
  check('a product exists', !!productId);

  // -------------------------------------------------------------- creating
  console.log('\n1. an admin can create a coupon at all');
  const made = await admin.post('/api/admin/coupons', {
    code: `save10${lower}`, kind: 'percent', value: 10, max_per_user: 5,
  });
  check('a percentage coupon is created', made.status === 200, JSON.stringify(made.data).slice(0, 160));
  check('and the code is stored uppercased', made.data?.code === `SAVE10${rnd}`, String(made.data?.code));

  const dup = await admin.post('/api/admin/coupons', { code: `SAVE10${rnd}`, kind: 'percent', value: 5 });
  check('a duplicate code is refused', dup.status === 400 && dup.data?.code === 'CODE_TAKEN', `${dup.status} ${dup.data?.code}`);

  const bad = await admin.post('/api/admin/coupons', { code: `PCT${rnd}`, kind: 'percent', value: 250 });
  check('a percentage over 100 is refused', bad.status === 400, `status=${bad.status}`);
  const badWindow = await admin.post('/api/admin/coupons', {
    code: `WIN${rnd}`, kind: 'fixed_iqd', value: 1000,
    starts_at: '2026-06-01T00:00:00Z', ends_at: '2026-01-01T00:00:00Z',
  });
  check('a window that closes before it opens is refused', badWindow.status === 400, `status=${badWindow.status}`);

  const listed = (await admin.get('/api/admin/coupons')).data?.coupons ?? [];
  check('the new coupon appears in the admin list', listed.some((c) => c.code === `SAVE10${rnd}`), String(listed.length));
  check('with its redemption count', listed.find((c) => c.code === `SAVE10${rnd}`)?.redeemed === 0);

  // ------------------------------------------------------------ the refusals
  console.log('\n2. a customer is told WHY, not just "invalid"');
  await buyer.del('/api/cart');
  const emptyCart = await buyer.post('/api/cart/coupon-check', { code: `SAVE10${rnd}` });
  check('an empty cart is refused as an empty cart', emptyCart.status === 400 && emptyCart.data?.code === 'CART_EMPTY', JSON.stringify(emptyCart.data).slice(0, 140));

  await buyer.post('/api/cart/items', { productId, qty: 1 });
  const unknown = await buyer.post('/api/cart/coupon-check', { code: 'DEFINITELY-NOT-REAL' });
  check('an unknown code says so', unknown.data?.reason === 'CODE_NOT_FOUND', String(unknown.data?.reason));
  check('and reveals no minimum for a code that does not exist', unknown.data?.min_total_iqd === null, String(unknown.data?.min_total_iqd));

  await admin.post('/api/admin/coupons', { code: `BIG${rnd}`, kind: 'fixed_iqd', value: 5000, min_total_iqd: 9_000_000 });
  const tooSmall = await buyer.post('/api/cart/coupon-check', { code: `BIG${rnd}` });
  check('a minimum-spend refusal names the minimum', tooSmall.data?.reason === 'MIN_TOTAL_NOT_MET' && tooSmall.data?.min_total_iqd === 9_000_000, JSON.stringify(tooSmall.data));

  await admin.post('/api/admin/coupons', { code: `OFF${rnd}`, kind: 'fixed_iqd', value: 5000, active: false });
  const off = await buyer.post('/api/cart/coupon-check', { code: `OFF${rnd}` });
  check('a deactivated code is refused as inactive', off.data?.reason === 'INACTIVE', String(off.data?.reason));

  // --------------------------------------------------------------- PRIME
  console.log('\n3. PRIME — the tier that could not exist and could not qualify');
  const primeCoupon = await admin.post('/api/admin/coupons', { code: `PRIME${rnd}`, kind: 'fixed_iqd', value: 7000, tier_required: 'prime' });
  check('a PRIME-only coupon can be created at all', primeCoupon.status === 200, JSON.stringify(primeCoupon.data).slice(0, 160));

  const freeUser = await buyer.post('/api/cart/coupon-check', { code: `PRIME${rnd}` });
  check('a free customer is refused it', freeUser.data?.reason === 'TIER_REQUIRED', String(freeUser.data?.reason));

  const proCoupon = await admin.post('/api/admin/coupons', { code: `PRO${rnd}`, kind: 'fixed_iqd', value: 3000, tier_required: 'pro' });
  check('a PRO-only coupon is created', proCoupon.status === 200);

  // Make the buyer PRIME through the memberships ledger the tier resolver
  // actually reads — not by poking users.membership_tier, which is a cache
  // and would prove nothing about the real path.
  sql(`INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, source, starts_at, expires_at) SELECT 'mem_prime_${lower}', id, 'prime_12mo', 'prime', 'active', 12, 0, 'admin', '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z' FROM users WHERE email='${buyerEmail}'`);
  await settle();
  const membership = sql(`SELECT tier, state FROM memberships WHERE id='mem_prime_${lower}'`);
  check('the buyer holds an active PRIME membership', membership.includes('prime') && membership.includes('active'), membership.replace(/\s+/g, ' ').slice(0, 160));

  const primeNow = await buyer.post('/api/cart/coupon-check', { code: `PRIME${rnd}` });
  check('a PRIME customer may use a PRIME coupon', primeNow.data?.valid === true, JSON.stringify(primeNow.data));
  // The bug: equality meant PRIME failed `tier === 'pro'`.
  const proAsPrime = await buyer.post('/api/cart/coupon-check', { code: `PRO${rnd}` });
  check('and a PRIME customer may use a PRO coupon — a higher tier satisfies a lower one',
    proAsPrime.data?.valid === true, JSON.stringify(proAsPrime.data));

  // ------------------------------------------------------- money off the order
  console.log('\n4. the discount reaches the order');
  const addr = await buyer.post('/api/addresses', {
    label: 'Home', name: 'Coupon Buyer', phone: '07701234567',
    address: 'شارع 62', governorate: 'baghdad', area: 'الجادرية', isDefault: true,
  });
  const addressId = addr.data?.id;
  const methods = (await buyer.get('/api/settings/public')).data?.settings?.checkoutDeliveryMethods ?? [];
  const deliveryId = methods[0]?.id ?? 'standard';
  const pol = await buyer.get('/api/policies');
  const policyAcceptance = (pol.data?.policies ?? []).filter((p) => p.key === 'terms' || p.key === 'privacy')
    .map((p) => ({ key: p.key, version: Number(p.version) }));
  const quoteBody = { addressId, deliveryMethodId: deliveryId, paymentMethodId: 'cash' };

  const plain = await buyer.post('/api/orders/quote', quoteBody);
  check('a quote without a code prices normally', plain.status === 200, JSON.stringify(plain.data).slice(0, 160));
  const plainTotal = plain.data?.quote?.total_iqd;

  const withCode = await buyer.post('/api/orders/quote', { ...quoteBody, couponCode: `SAVE10${rnd}` });
  check('the quote accepts the code', withCode.status === 200, JSON.stringify(withCode.data).slice(0, 200));
  check('and it names the coupon', withCode.data?.quote?.coupon?.code === `SAVE10${rnd}`, JSON.stringify(withCode.data?.quote?.coupon));
  check('and the total actually falls', withCode.data?.quote?.total_iqd < plainTotal,
    `${plainTotal} -> ${withCode.data?.quote?.total_iqd}`);

  const rejectedQuote = await buyer.post('/api/orders/quote', { ...quoteBody, couponCode: `BIG${rnd}` });
  check('a quote with an ineligible code fails with the REASON, not a generic error',
    rejectedQuote.status === 400 && rejectedQuote.data?.code === 'MIN_TOTAL_NOT_MET',
    `${rejectedQuote.status} ${rejectedQuote.data?.code}`);

  const placed = await buyer.post('/api/orders', {
    ...quoteBody, policyAcceptance, couponCode: `SAVE10${rnd}`, idempotencyKey: `cpn-${lower}-1`,
  });
  check('the order is placed with the coupon', placed.status === 200, JSON.stringify(placed.data).slice(0, 240));
  const orderId = placed.data?.order?.id;
  check('the order records the discount', Number(placed.data?.order?.coupon_discount_iqd) > 0,
    String(placed.data?.order?.coupon_discount_iqd));
  check('and its total matches the quote the customer agreed to',
    placed.data?.order?.total_iqd === withCode.data?.quote?.total_iqd,
    `${withCode.data?.quote?.total_iqd} vs ${placed.data?.order?.total_iqd}`);

  const redemption = sql(`SELECT coupon_id, order_id FROM coupon_redemptions WHERE order_id='${orderId}'`);
  check('a redemption row was written', redemption.includes(orderId), redemption.replace(/\s+/g, ' ').slice(0, 160));
  const after = (await admin.get('/api/admin/coupons')).data?.coupons ?? [];
  check('and the admin list counts it', after.find((c) => c.code === `SAVE10${rnd}`)?.redeemed === 1,
    String(after.find((c) => c.code === `SAVE10${rnd}`)?.redeemed));

  // ------------------------------------------------------------ the limits
  console.log('\n5. the per-user limit is real');
  await admin.post('/api/admin/coupons', { code: `ONCE${rnd}`, kind: 'fixed_iqd', value: 2000, max_per_user: 1 });
  await buyer.del('/api/cart');
  await buyer.post('/api/cart/items', { productId, qty: 1 });
  const first = await buyer.post('/api/orders', {
    ...quoteBody, policyAcceptance, couponCode: `ONCE${rnd}`, idempotencyKey: `cpn-${lower}-2`,
  });
  check('the first use is allowed', first.status === 200, JSON.stringify(first.data).slice(0, 200));
  await buyer.del('/api/cart');
  await buyer.post('/api/cart/items', { productId, qty: 1 });
  const second = await buyer.post('/api/orders', {
    ...quoteBody, policyAcceptance, couponCode: `ONCE${rnd}`, idempotencyKey: `cpn-${lower}-3`,
  });
  check('the second use is refused', second.status === 400 && second.data?.code === 'PER_USER_LIMIT_REACHED',
    `${second.status} ${second.data?.code}`);

  // ------------------------------------------------------- in a browser
  console.log('\n6. the panel and the storefront box, in a real browser');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    try {
      ({ chromium } = require('playwright-core'));
    } catch {
      ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
    }
  }
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));

    // Sign in as the admin through the API, then load the panel.
    await page.goto(`${BASE}/auth`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async (creds) => {
      await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
    }, { email: adminEmail, password });
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /أكواد الخصم|Promo codes/ }).first().click();
    await page.waitForSelector('[data-admin-coupons]', { timeout: 10_000 });
    check('the coupon panel opens', true);
    const codesShown = await page.locator('[data-admin-coupons] td').allInnerTexts();
    check('and it lists the codes created above', codesShown.some((t) => t.includes(`SAVE10${rnd}`)), JSON.stringify(codesShown.slice(0, 8)));

    // Create one through the form, not the API.
    const uiCode = `UI${rnd}`;
    await page.locator('#cpn-code').fill(uiCode);
    await page.locator('#cpn-value').fill('15');
    await page.getByRole('button', { name: /إنشاء الكود|Create coupon/ }).click();
    await page.waitForSelector('[role="status"]', { timeout: 10_000 });
    const afterUi = (await admin.get('/api/admin/coupons')).data?.coupons ?? [];
    check('a coupon created from the panel reaches the database', afterUi.some((cp) => cp.code === uiCode), uiCode);

    // The storefront box: a real customer, a real refusal, a real acceptance.
    const shopper = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const shop = await shopper.newPage();
    shop.on('pageerror', (e) => errs.push(String(e)));
    await shop.goto(`${BASE}/auth`, { waitUntil: 'domcontentloaded' });
    await shop.evaluate(async (creds) => {
      await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
    }, { email: buyerEmail, password });
    await shop.evaluate(async (pid) => {
      await fetch('/api/cart', { method: 'DELETE' });
      await fetch('/api/cart/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: pid, qty: 1 }) });
    }, productId);
    await shop.goto(`${BASE}/cart`, { waitUntil: 'networkidle' });
    // The promo box lives inside the collapsed "العروض والخصومات" section,
    // which is where a customer looks for it.
    await shop.locator('text=/العروض والخصومات|Deals & Discounts/').first().click();
    await shop.waitForSelector('[data-promo-field]', { timeout: 10_000 });
    check('the cart shows a working promo box, not a disabled "قريباً" button', true);
    const disabledSoon = await shop.locator('[data-promo-field] button[disabled]:has-text("قريباً")').count();
    check('and no "coming soon" button remains in it', disabledSoon === 0, String(disabledSoon));

    await shop.locator('[data-promo-field] input').fill('NOT-A-REAL-CODE');
    await shop.getByRole('button', { name: /تطبيق|Apply/ }).first().click();
    await shop.waitForSelector('[data-promo-field] [role="alert"]', { timeout: 10_000 });
    const msg = await shop.locator('[data-promo-field] [role="alert"]').innerText();
    check('a bad code is refused with a readable reason', msg.length > 0 && !/invalid$/i.test(msg), msg);

    await shop.locator('[data-promo-field] input').fill(`SAVE10${rnd}`);
    await shop.getByRole('button', { name: /تطبيق|Apply/ }).first().click();
    await shop.waitForSelector(`[data-promo-field] :text("SAVE10${rnd}")`, { timeout: 10_000 });
    check('a good code is accepted and shown back', true);
    check('no runtime errors anywhere in the flow', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('\nfailures:'); for (const f of failures) console.log(`  - ${f}`); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
