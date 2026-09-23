#!/usr/bin/env node
/**
 * /subscription, photographed in every state it has to be designed for.
 *
 * WHY THIS EXISTS. «اختر بطاقتك», the checkout bar and «مقارنة الخطط» were
 * redesigned, and a redesign is only as good as its worst state. This drives
 * the real page in Chromium at 360 / 768 / 1280, in Arabic (RTL) and English,
 * with the phone set to dark AND light (the app is dark-only; it must stay so),
 * for a guest, a free account, a PLUS member, a PRO member and an account
 * whose wallet falls short — and saves one screenshot per combination.
 *
 * THE MEMBERSHIP API IS THE REAL ONE. `/api/memberships/*` is answered by the
 * Worker's own `membershipsRoutes` over an in-memory SQLite built from every
 * migration, seeded with real benefit rules and real wallet rows — so every
 * figure on a screenshot is what the server computes, not a fixture someone
 * typed. The rest of the app's boot calls (session, settings, wallet) are
 * answered with small stand-ins, because this is a picture of one page.
 *
 *   node --import tsx scripts/e2e-subscription-shots.mjs
 *
 * Starts its own Vite dev server on :4179 unless SUB_SHOTS_URL is set.
 * Screenshots land in SUB_SHOTS_DIR (default /tmp/claude-0/shots/subscription).
 * It also asserts the things a picture cannot show at a glance: no
 * reservation copy anywhere, no horizontal scroll, and the checkout bar never
 * covering the last of the content.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SUB_SHOTS_DIR || '/tmp/claude-0/shots/subscription';
const PORT = 4179;
let BASE = process.env.SUB_SHOTS_URL || '';

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

const { SqliteD1 } = await import('../tests/fixtures/d1.ts');
const { membershipsRoutes } = await import('../worker/routes/memberships.ts');
const { HttpError } = await import('../worker/lib/http.ts');
const { classifyHost } = await import('../worker/lib/hosts.ts');

// ------------------------------------------------------------- the server
function buildDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,username) VALUES
      ('u_free','Sara Ali','sara@x.co','h','sara'),
      ('u_plus','Omar Karim','omar@x.co','h','omar'),
      ('u_pro','Lina Hassan','lina@x.co','h','lina'),
      ('u_short','Zaid Noor','zaid@x.co','h','zaid'),
      ('u_buy_ar','Huda Salim','huda@x.co','h','huda'),
      ('u_buy_en','Adam Rafi','adam@x.co','h','adam');
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,is_printer_catalog) VALUES
      ('shot_printers',NULL,'shot-printers','الطابعات','Printers',1),
      ('shot_filament',NULL,'shot-filament','الفلمنت','Filament',0);
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,category_id,discount_mode,percent,max_discount_iqd,cap_scope,enabled,priority,label) VALUES
      ('shot-prime-printers','prime','product_discount','category','shot_printers','percent',5,25000,'per_unit',1,0,NULL),
      ('shot-pro-filament','pro','product_discount','category','shot_filament','percent',8,NULL,NULL,1,0,NULL);
  `);
  const product = raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id)
     VALUES (?,?,?,?,?,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','shot_printers',NULL)`
  );
  const rule = raw.prepare(
    `INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,product_id,discount_mode,percent,max_discount_iqd,cap_scope,enabled,priority)
     VALUES (?,'pro','product_discount','product',?,'percent',10,100000,'per_unit',1,0)`
  );
  for (let i = 0; i < 12; i++) {
    product.run(`shot_p${i}`, `shot-p${i}`, `Printer ${i}`, `طابعة ${i}`, 1_500_000);
    rule.run(`shot-pro-p${i}`, `shot_p${i}`);
  }
  const deposit = raw.prepare(
    `INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,created_by,decided_at)
     VALUES (?,?,'deposit','USD',?,'approved','seed','admin',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  );
  deposit.run('shot_w1', 'u_free', 100_000);
  deposit.run('shot_w2', 'u_plus', 100_000);
  deposit.run('shot_w3', 'u_pro', 100_000);
  deposit.run('shot_w4', 'u_short', 3_572); // 50,000 د.ع
  deposit.run('shot_w5', 'u_buy_ar', 100_000);
  deposit.run('shot_w6', 'u_buy_en', 100_000);
  const start = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const end = new Date(Date.now() + 325 * 86_400_000).toISOString();
  raw
    .prepare(
      `INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,credit_basis_iqd,starts_at,expires_at,source)
       VALUES (?,?,?,?,'active',12,?,?,?,?,'purchase')`
    )
    .run('shot_m_plus', 'u_plus', 'plus_12mo', 'plus', 29000, 29000, start, end);
  raw
    .prepare(
      `INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,credit_basis_iqd,starts_at,expires_at,source)
       VALUES (?,?,?,?,'active',12,?,?,?,?,'purchase')`
    )
    .run('shot_m_pro', 'u_pro', 'pro_12mo', 'pro', 499000, 499000, start, end);
  return new SqliteD1(raw);
}

const db = buildDb();
function workerFor(userId) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role: 'customer', created_at: new Date().toISOString() });
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db };
    await next();
  });
  a.route('/api/memberships', membershipsRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status);
    }
    throw err;
  });
  return a;
}

const SCENARIOS = {
  guest: { user: null },
  free: { user: 'u_free', tier: 'free' },
  plus: { user: 'u_plus', tier: 'plus' },
  pro: { user: 'u_pro', tier: 'pro' },
  shortfall: { user: 'u_short', tier: 'free', search: '?tier=pro&plan=pro_12mo' },
  // Buys PREMIUM for real (in the in-memory database) and photographs the result.
  buy: { user: (lang) => (lang === 'en' ? 'u_buy_en' : 'u_buy_ar'), tier: 'free', search: '?tier=prime&plan=prime_12mo', purchase: true },
};

function apiUser(id, tier) {
  return {
    id,
    email: `${id}@x.co`,
    username: id.replace('u_', ''),
    name: { u_free: 'Sara Ali', u_plus: 'Omar Karim', u_pro: 'Lina Hassan', u_short: 'Zaid Noor', u_buy_ar: 'Huda Salim', u_buy_en: 'Adam Rafi' }[id],
    role: 'customer',
    isAdmin: false,
    is_investor: false,
    subscription_plan: tier === 'prime' ? 'free' : tier,
    membership_tier: tier,
    subscription_expiry: tier === 'free' ? 0 : Date.now() + 325 * 86_400_000,
    locale: 'ar',
    avatar_key: null,
    bio: '',
    website: '',
    profile: {},
    country: 'IQ',
    phone: null,
    has_phone: false,
    notify_whatsapp: true,
    created_at: new Date().toISOString(),
  };
}

// ------------------------------------------------------------ the browser
async function ensureServer() {
  if (BASE) return null;
  BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, BROWSER: 'none' },
  });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('vite did not start');
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};

async function shoot(browser, { scenario, width, lang, scheme }) {
  const base = SCENARIOS[scenario];
  const s = { ...base, user: typeof base.user === 'function' ? base.user(lang) : base.user };
  const context = await browser.newContext({
    viewport: { width, height: width < 700 ? 780 : 900 },
    deviceScaleFactor: 1,
    colorScheme: scheme,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
  });
  await context.addInitScript((l) => {
    try {
      localStorage.setItem('levo_lang', l);
      localStorage.setItem('levonis.displayCurrency.v1', 'IQD');
    } catch {
      /* private mode */
    }
  }, lang);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
  const worker = workerFor(s.user);
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api/memberships')) {
      const res = await worker.request(url.pathname + url.search, {
        method: req.method(),
        headers: { 'content-type': 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() ?? undefined,
      });
      return route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/storefront/resolve') return json({ success: true, kind: 'main', store: null });
    if (url.pathname === '/api/auth/me') return json({ success: true, user: s.user ? apiUser(s.user, s.tier) : null });
    if (url.pathname === '/api/settings/public') return json({ success: true, settings: { exchangeRate: 1400 } });
    if (url.pathname === '/api/wallet') return json({ success: true, balance_usd_cents: 100000, balance_iqd: 1400000, point_balance: 0, transactions: [], point_transactions: [] });
    return json({ success: false, error: 'not part of this picture' }, 404);
  });

  await page.goto(`${BASE}/subscription${s.search ?? ''}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('[data-tier-card]', { timeout: 30000 });
  } catch (e) {
    await page.screenshot({ path: join(OUT, `${scenario}-${width}-${lang}-${scheme}-FAILED.png`) });
    throw e;
  }
  // The app's intro veil covers the first frames; wait for it to step aside.
  await page
    .waitForFunction(() => {
      const intro = document.querySelector('.lv-app-intro');
      return !intro || ['docked', 'hidden'].includes(intro.getAttribute('data-phase') ?? '');
    }, null, { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
  const name = `${scenario}-${width}-${lang}-${scheme}`;

  const text = await page.evaluate(() => document.body.innerText);
  check(`${name}: no reservation copy`, !/إطلاق الموقع|محجوزة|site launch|Reserved|تأكيد والحجز/.test(text));
  const overflow = await page.evaluate(() => {
    const main = document.getElementById('main-scroll-container');
    return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0);
  });
  check(`${name}: no horizontal scroll`, overflow <= 1, `overflow ${overflow}px`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(`${name}: stays dark`, /rgb\((\d+), (\d+), (\d+)\)/.test(bg) && Number(bg.match(/\d+/)[0]) < 40, bg);

  await page.screenshot({ path: join(OUT, `${name}-top.png`) });
  // The comparison, and the bottom of the page under the bar.
  await page.evaluate(() => document.getElementById('compare')?.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}-compare.png`) });
  // Twice, a beat apart: a section still arriving (the ledger, the BNPL
  // panel) grows the page after the first jump.
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => {
      const main = document.getElementById('main-scroll-container');
      if (main) main.scrollTop = main.scrollHeight;
    });
    await page.waitForTimeout(500);
  }
  if (width < 1024) {
    const covered = await page.evaluate(() => {
      const bar = document.querySelector('[data-checkout-bar]');
      const content = [...document.querySelectorAll('#compare, [aria-labelledby="membership-title"]')].pop();
      if (!bar || !content) return 0;
      return Math.max(0, content.getBoundingClientRect().bottom - bar.getBoundingClientRect().top);
    });
    check(`${name}: the bar never covers the end of the content`, covered <= 1, `${covered}px under the bar`);
  }
  await page.screenshot({ path: join(OUT, `${name}-bottom.png`) });

  // The confirmation window, where there is something to confirm.
  if (scenario === 'free' || scenario === 'shortfall' || scenario === 'plus' || s.purchase) {
    await page.evaluate(() => {
      const main = document.getElementById('main-scroll-container');
      if (main) main.scrollTop = 0;
    });
    const cta = page.locator('[data-subscribe-cta]');
    if (await cta.isEnabled()) {
      await cta.click();
      await page.waitForSelector('[data-purchase-confirm]', { timeout: 5000 });
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(OUT, `${name}-confirm.png`) });
      if (s.purchase) {
        await page.locator('[data-confirm-accept]').click();
        await page.waitForSelector('[data-confirm-result]', { timeout: 10000 });
        await page.waitForTimeout(900);
        const ok = (await page.locator('[data-confirm-result="ok"]').count()) === 1;
        check(`${name}: the purchase completes and is active at once`, ok);
        await page.screenshot({ path: join(OUT, `${name}-result.png`) });
      }
    }
  }
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const server = await ensureServer();
const browser = await chromium.launch();
try {
  const only = process.env.SUB_SHOTS_ONLY; // e.g. "free-360-ar-dark"
  for (const scenario of Object.keys(SCENARIOS)) {
    for (const width of [360, 768, 1280]) {
      for (const lang of ['ar', 'en']) {
        for (const scheme of ['dark', 'light']) {
          const name = `${scenario}-${width}-${lang}-${scheme}`;
          if (only && !name.startsWith(only)) continue;
          // Light is the "the page stays dark" check: once per scenario is enough.
          if (scheme === 'light' && !(width === 360 && lang === 'ar')) continue;
          // A purchase happens once per account: one phone, one desktop.
          if (scenario === 'buy' && !((width === 360 && lang === 'ar') || (width === 1280 && lang === 'en')) ) continue;
          if (scenario === 'buy' && scheme === 'light') continue;
          console.log(name);
          await shoot(browser, { scenario, width, lang, scheme });
        }
      }
    }
  }
} finally {
  await browser.close();
  server?.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
