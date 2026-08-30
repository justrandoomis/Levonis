#!/usr/bin/env node
/**
 * The two "قريباً" features that were real code problems, now working.
 *
 * THE CALCULATOR. "احسب سعر طباعتك" was a dead card on /community and a page
 * that said "قريباً". Shipping one honestly is not about the arithmetic, it
 * is about the numbers: a calculator seeded with invented filament prices is
 * worse than no calculator, because a customer plans around a figure they
 * then do not meet at checkout. So this checks the thing that matters —
 * every price comes from a product the shop actually sells, divided by the
 * net weight on its own spec sheet — and that a spool with no weight is left
 * out rather than guessed at.
 *
 * It also checks the honest gap. What LEVONIS charges for machine time is a
 * business decision the owner has not published, so the page must say the
 * figure is material-only rather than quietly present it as a total.
 *
 * THE MERCHANT MESSAGE BUTTON. Disabled with "قريباً" on it since launch,
 * while direct chats have existed since the first migration — nothing was
 * ever wired to open one.
 *
 *   node scripts/e2e-tools.mjs        (expects wrangler dev on :8787)
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

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
  throw new Error('the dev server did not come back');
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
  put(p, b) { return this.call('PUT', p, b); }
}

const rnd = Math.random().toString(36).slice(2, 7);
const password = 'tools-pass-1';

async function main() {
  // Registration and sign-in are rate limited per IP, and a suite that has
  // been run a few times in a row while it was being written will trip that
  // limit — every later check then fails with "Authentication required" and
  // reads like a permissions bug rather than a spent budget. Local only.
  try {
    sql('DELETE FROM rate_limits');
  } catch {
    /* the table may not exist on a very old local database */
  }

  console.log(`\nLEVONIS tools — the calculator and the merchant chat — ${BASE}\n`);

  console.log('0. an admin, and two real filaments in the catalog');
  const admin = new Client();
  const adminEmail = `tla-${rnd}@test.local`;
  await admin.post('/api/auth/register', { email: adminEmail, username: `tla${rnd}`, name: 'A', password });
  sql(`UPDATE users SET role='admin' WHERE email='${adminEmail}'`);
  await settle();
  // The sign-in is CONFIRMED, not assumed. `wrangler d1 execute --local`
  // re-binds the database under the running server, and /api/health can
  // answer from the instance that is on its way out — so a login issued
  // immediately after can land nowhere. Every later check would then fail
  // with "Authentication required" and read like a permissions bug.
  let signedIn = false;
  for (let attempt = 0; attempt < 5 && !signedIn; attempt++) {
    await admin.post('/api/auth/login', { email: adminEmail, password });
    const me = await admin.get('/api/auth/me');
    signedIn = me.data?.user?.role === 'admin';
    if (!signedIn) await new Promise((r) => setTimeout(r, 750));
  }
  check('the admin is signed in', signedIn);
  if (!signedIn) throw new Error('could not sign the admin in');

  const cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const materials = cats.find((c) => c.effective_template_family === 'materials');
  check('the catalog has a materials section', !!materials, JSON.stringify(cats.map((c) => c.effective_template_family)));

  // A spool with a real price and a real net weight, and one WITHOUT a weight
  // — the second must be left out rather than priced from a guess.
  const priced = await admin.post('/api/admin/products-v2', {
    name_en: `Calc PLA ${rnd}`, description_en: 'x', price_iqd: 20000, status: 'active',
    sale_types: ['direct_sale'], category_id: materials?.id ?? null, stock: 30,
    template_family: 'materials', spec_fields: { net_weight: '1000', material_type: 'PLA' },
  });
  check('a filament with a net weight saves', priced.status === 200, JSON.stringify(priced.data).slice(0, 200));
  const weightless = await admin.post('/api/admin/products-v2', {
    name_en: `Calc Mystery ${rnd}`, description_en: 'x', price_iqd: 33000, status: 'active',
    sale_types: ['direct_sale'], category_id: materials?.id ?? null, stock: 30,
    template_family: 'materials', spec_fields: { material_type: 'PETG' },
  });
  check('a filament with NO net weight also saves', weightless.status === 200, JSON.stringify(weightless.data).slice(0, 200));

  console.log('\n1. the calculator prices from real products only');
  // Establish the precondition rather than assume it. A previous run that was
  // interrupted before its cleanup would leave rates published, and this
  // check would then fail for a reason that has nothing to do with the code.
  await admin.put('/api/admin/settings/printServicePricing', {
    value: { machine_iqd_per_hour: null, setup_fee_iqd: null, margin_percent: null },
  });
  const calc = await admin.get('/api/products/print-calculator');
  check('the endpoint answers', calc.status === 200, `status=${calc.status}`);
  const list = calc.data?.filaments ?? [];
  const mine = list.find((f) => f.name === `Calc PLA ${rnd}`);
  check('the weighed filament is offered', !!mine, JSON.stringify(list.map((f) => f.name)).slice(0, 200));
  check('with the price per gram derived from ITS OWN price and weight',
    mine && mine.iqd_per_gram === 20, JSON.stringify(mine));
  check('and the weightless one is left OUT, not guessed at',
    !list.some((f) => f.name?.includes(`Calc Mystery ${rnd}`)),
    JSON.stringify(list.map((f) => f.name)).slice(0, 200));
  check('the service rates start unpublished, not invented',
    calc.data?.rates?.configured === false && calc.data?.rates?.machine_iqd_per_hour === null,
    JSON.stringify(calc.data?.rates));

  console.log('\n2. and the page adds exactly what the owner published');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    // /tools is behind ProtectedRoute, so sign in first — as the admin, who
    // is just an ordinary signed-in customer as far as this page cares.
    await page.goto(`${BASE}/auth`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async (creds) => {
      await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
    }, { email: adminEmail, password });
    await page.goto(`${BASE}/tools`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-print-calculator]', { timeout: 15_000 });
    check('the calculator renders instead of a "قريباً" placeholder', true);
    const soon = await page.locator('text=/قريباً/').count();
    check('and nothing on the page says "قريباً" any more', soon === 0, String(soon));

    await page.selectOption('#calc-filament', mine.id);
    await page.locator('#calc-grams').fill('100');
    await page.locator('#calc-hours').fill('5');
    await page.locator('#calc-qty').fill('2');
    // 20 IQD/g x 100g = 2,000, times two parts = 4,000. Nothing else is
    // published, so nothing else may be added.
    const total = await page.locator('[data-calc-total]').innerText();
    check('the total is material cost only, and correct', /4,000/.test(total), total);
    const warning = await page.locator('text=/لم تُنشر|not published yet/').count();
    check('and the page SAYS the rest is not published', warning > 0, String(warning));

    // Publish a rate and watch it appear — the honest gap closes when the
    // owner closes it, not before.
    await admin.put('/api/admin/settings/printServicePricing', {
      value: { machine_iqd_per_hour: 1000, setup_fee_iqd: 500, margin_percent: 10 },
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-print-calculator]', { timeout: 10_000 });
    await page.selectOption('#calc-filament', mine.id);
    await page.locator('#calc-grams').fill('100');
    await page.locator('#calc-hours').fill('5');
    await page.locator('#calc-qty').fill('2');
    // material 4,000 + machine (1,000 x 5 x 2 = 10,000) + setup 500 = 14,500,
    // +10% margin = 15,950.
    const total2 = await page.locator('[data-calc-total]').innerText();
    check('once rates are published the total includes them', /15,950/.test(total2), total2);
    const warning2 = await page.locator('text=/لم تُنشر|not published yet/').count();
    check('and the warning is gone', warning2 === 0, String(warning2));
    check('no runtime errors on the calculator', errs.length === 0, errs.join(' | ').slice(0, 200));

    // ----------------------------------------------------- merchant chat
    console.log('\n3. the merchant "مراسلة" button opens a real conversation');
    const merchant = new Client(), shopper = new Client();
    const mEmail = `tlm-${rnd}@test.local`, sEmail = `tls-${rnd}@test.local`;
    await merchant.post('/api/auth/register', { email: mEmail, username: `tlm${rnd}`, name: 'Merchant', password });
    await merchant.post('/api/auth/login', { email: mEmail, password });
    await shopper.post('/api/auth/register', { email: sEmail, username: `tls${rnd}`, name: 'Shopper', password });
    await shopper.post('/api/auth/login', { email: sEmail, password });
    // A merchant profile is a PLUS/PRO benefit and the check is server-side,
    // so the fixture earns it through the memberships ledger rather than
    // being handed a client-side flag the real code would ignore.
    sql(`INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, source, starts_at, expires_at) SELECT 'mem_tlm_${rnd}', id, 'pro_12mo', 'pro', 'active', 12, 0, 'admin', '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z' FROM users WHERE email='${mEmail}'`);
    await settle();
    const store = await merchant.post('/api/community/my-store', { name: `Store ${rnd}`, bio: 'A real store' });
    const storeId = store.data?.id;
    check('a merchant store exists', !!storeId, JSON.stringify(store.data).slice(0, 200));

    const view = await shopper.get(`/api/community/store/${storeId}`);
    check('the store page carries the merchant account id, so a chat can be opened',
      !!view.data?.merchant?.user_id, JSON.stringify(view.data?.merchant));

    const shopCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const shopPage = await shopCtx.newPage();
    shopPage.on('pageerror', (e) => errs.push(String(e)));
    await shopPage.goto(`${BASE}/auth`, { waitUntil: 'domcontentloaded' });
    await shopPage.evaluate(async (creds) => {
      await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
    }, { email: sEmail, password });
    await shopPage.goto(`${BASE}/community/store/${storeId}`, { waitUntil: 'networkidle' });
    const msgBtn = shopPage.getByRole('button', { name: /^مراسلة$|^Message$/ });
    check('the button is present and no longer says "قريباً"', await msgBtn.count() > 0);
    check('and it is enabled', await msgBtn.first().isEnabled());
    await msgBtn.first().click();
    await shopPage.waitForURL(/\/chat\//, { timeout: 10_000 });
    check('tapping it lands on a real conversation', /\/chat\//.test(shopPage.url()), shopPage.url());

    // Idempotent: opening again must not fork the thread.
    const firstUrl = shopPage.url();
    await shopPage.goto(`${BASE}/community/store/${storeId}`, { waitUntil: 'networkidle' });
    await shopPage.getByRole('button', { name: /^مراسلة$|^Message$/ }).first().click();
    await shopPage.waitForURL(/\/chat\//, { timeout: 10_000 });
    check('opening it twice reuses the same thread, it does not fork', shopPage.url() === firstUrl,
      `${firstUrl} vs ${shopPage.url()}`);

    // ------------------------------------------- the chat attachment menu
    console.log('\n4. the chat attachments that were real code problems');
    // The "+" carries a data hook rather than being hunted for among every
    // icon button on the screen — an icon-only control is not findable by
    // text, and guessing at it is how a passing test starts lying.
    await shopPage.waitForSelector('[data-chat-plus]', { timeout: 10_000 });
    await shopPage.locator('[data-chat-plus]').click();
    const opened = await shopPage
      .locator('text=/^الموقع$|^Location$/')
      .first()
      .waitFor({ timeout: 5_000 })
      .then(() => true, () => false);
    check('the attachment menu opens', opened);
    if (opened) {
      const menu = await shopPage.locator('text=/الموقع|Location|المتجر|Store|بطاقة شخصية|Profile Card/').allInnerTexts();
      check('«الموقع» is no longer marked قريباً', menu.some((t) => /^الموقع$|^Location$/.test(t.trim())), JSON.stringify(menu));
      check('«المتجر» is no longer marked قريباً', menu.some((t) => /^المتجر$|^Store$/.test(t.trim())), JSON.stringify(menu));
      check('«بطاقة شخصية» is no longer marked قريباً',
        menu.some((t) => /^بطاقة شخصية$|^Profile Card$/.test(t.trim())), JSON.stringify(menu));
      // These two move money between users and stay visibly off until the
      // owner sets a policy — that is the honest state, not a missed button.
      const stillOff = await shopPage.locator('text=/مغلف أحمر|Red Envelope/').count();
      check('«مغلف أحمر» is still marked قريباً, deliberately', stillOff > 0, String(stillOff));
    }
    check('no runtime errors anywhere', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    await browser.close();
  }

  // Put the rates back so the next person's manual look is not pre-configured.
  await admin.put('/api/admin/settings/printServicePricing', {
    value: { machine_iqd_per_hour: null, setup_fee_iqd: null, margin_percent: null },
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('\nfailures:'); for (const f of failures) console.log(`  - ${f}`); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
