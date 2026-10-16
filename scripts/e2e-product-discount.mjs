#!/usr/bin/env node
/**
 * PRODUCT DISCOUNT — «تخفيض السعر», END TO END IN A REAL BROWSER (docs/ux/PRODUCT-DISCOUNT.md §12
 * "Real browser"; the owner's request of 2026-10-16: «السعر قبل الخصم 600$ بعد الخصم 500$»).
 *
 * The real built SPA, the real Worker under `wrangler dev --local` and a real local D1 taken through
 * every migration to 0197. An invented two-model printer («Levo E2E Discount Printer»: P1S $600 and
 * P1S Combo $750, land pre-order Δ $50) is priced price-first by the REAL V2 writer at U = 1,500, and an
 * invented cost-first AMS by the same writer — before the Worker starts (the clean-start run proves
 * the publishing screens; this one proves the sale).
 *
 *   1  OWNER. Section ٣ → «تخفيض السعر» → «+ إضافة تخفيض» → «سعر بعد الخصم ($)», one price per model:
 *      P1S $500, Combo $640, an end date. The preview reads 900,000 → 750,000 «−17٪» and
 *      1,125,000 → 960,000 «−15٪» before anything is saved; «حفظ التخفيض». «العروض الخاصة» lists the
 *      same row as «$500.00 · 2 موديلات».
 *   2  GUEST AND BUYER, in ar, en and ckb: the listing card (750,000 «يبدأ من», struck 900,000, «−17٪»,
 *      the clock), the product page («سعر العرض» / «Sale price» / «نرخی ئۆفەر», the struck line,
 *      «ينتهي خلال»), the cart line, the checkout summary, a cash-on-delivery direct order, its order
 *      page (the struck before) and its invoice («السعر قبل العرض»).
 *   3  RATE. The owner's rate 1,530 approved and the REAL auto-reprice run (the Worker stopped while the
 *      job writes): the card reads 765,000, struck 918,000; the placed order is unchanged.
 *   4  EDITOR on the cost-first AMS: no dollar figure in section ٣ or the card, the dollar segment
 *      disabled with its sentence, and a percent sale saves.
 *   5  REMOVAL from the «العروض الخاصة» tab: the card says «لا يوجد تخفيض…», the listing strikes nothing.
 *   6  OLDER DATABASE: a second local D1 at 0195 (no 0197): the card shows the dollar segment disabled
 *      and a percent sale works.
 *   7  EVERY PAGE: no page error, no horizontal scroll at 360 px, the card's targets ≥ 44 px, and no
 *      customer answer carries `usd_iqd_rate`, `price_usd_cents`, `offer_usd_prices` or a `*_usd` key.
 *      Screenshots at 360 and 1280, light and dark, ar and ckb (and en).
 *
 * LOCAL ONLY. The Worker listens on 127.0.0.1; every browser request to another host is aborted and
 * counted, and the run fails unless that count is 0. No live site, no production database.
 *
 * How to run (one heavy process — run it alone; a few minutes):
 *   npm run build
 *   OUT_DIR=/tmp/e2e-product-discount node --import tsx scripts/e2e-product-discount.mjs
 *
 * Env: OUT_DIR (results.json, shots/, the wrangler logs, the persist dirs), PORT (default 8861),
 * CHROMIUM_PATH, PLAYWRIGHT_MODULE, KEEP_DEV=1.
 */
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { splitStatements } from './lib/sql-split.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.js');
const PORT = Number(process.env.PORT || 8861);
const OUT = process.env.OUT_DIR || '/tmp/e2e-product-discount';
const SHOTS = join(OUT, 'shots');
const WRANGLER = process.env.WRANGLER || join(ROOT, 'node_modules/.bin/wrangler');
if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('dist/ is missing: run `npm run build` first');
mkdirSync(SHOTS, { recursive: true });

// The repository's own V2 writer, reprice job and rate fixture (TypeScript, through tsx).
const { SqliteD1 } = await import('../tests/fixtures/d1.ts');
const { applyRate } = await import('../tests/fixtures/fx.ts');
const { writeV2 } = await import('../tests/fixtures/pricingV2.ts');
const { repriceStaleEngineProducts } = await import('../worker/lib/pricingEngine/autoReprice.ts');
const { statementBudget } = await import('../worker/lib/fx/budget.ts');
const { acceptedPolicies } = await import('../tests/lib/policies.ts');

// ------------------------------------------------------------------ the invented catalogue

const OWNER = { id: 'u_owner', email: 'owner@levonis.test', password: 'owner-e2e-pass-1' };
const EDITOR = { id: 'u_editor', email: 'editor@levonis.test', password: 'editor-e2e-pass-1' };
const BUYER = { id: 'u_buyer', email: 'buyer@levonis.test', password: 'buyer-e2e-pass-1' };
const A = {
  id: 'e2e_pd_a',
  slug: 'levo-e2e-discount-printer',
  name: 'Levo E2E Discount Printer',
  models: [
    { id: 'e2e_pd_a_p1s', en: 'P1S', ar: 'P1S', ckb: 'P1S', usd: '600' },
    { id: 'e2e_pd_a_combo', en: 'P1S Combo', ar: 'P1S كومبو', ckb: 'P1S کۆمبۆ', usd: '750' },
  ],
};
const C = { id: 'e2e_pd_c', slug: 'levo-e2e-discount-ams', name: 'Levo E2E Discount AMS', model: { id: 'e2e_pd_c_std', en: 'AMS', ar: 'AMS', ckb: 'AMS' } };

// ------------------------------------------------------------------ the local database

function initLocalD1(persist) {
  rmSync(persist, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
  execFileSync(WRANGLER, ['d1', 'execute', 'levonis-db', '--local', '--persist-to', persist, '--command', 'SELECT 1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  const dir = join(persist, 'v3/d1/miniflare-D1DatabaseObject');
  const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (!file) throw new Error(`no local D1 file under ${dir}`);
  return join(dir, file);
}

/** Migrations the way D1 applies them (one transaction each, bookkeeping in d1_migrations). */
function applyMigrations(db, filter) {
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const applied = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql') && filter(f)).sort();
  const done = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const stmts = splitStatements(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
    db.exec('BEGIN');
    try {
      for (const s of stmts) db.exec(s);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw new Error(`${f}: ${e.message}`);
    }
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
    done.push(f);
  }
  return done;
}

function passwordHash(password) {
  const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const salt = randomBytes(16);
  return `pbkdf2$100000$${b64url(salt)}$${b64url(pbkdf2Sync(password, salt, 100000, 32, 'sha256'))}`;
}
/** A customer page in ar or ckb prints Arabic-Indic digits («٧٥٠٬٠٠٠»): the checks read them as 750,000. */
const latin = (t) => String(t).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/٬/g, ',');
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function seedPrinter(db, p, models, category) {
  db.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, description, status, price_iqd, stock, selling_type, sale_types, preorder_transports,
                          inventory_mode, package_weight_g, package_depth_mm, package_width_mm, package_height_mm, net_weight_g, category_id)
    VALUES (${q(p.id)}, ${q(p.slug)}, ${q(p.name)}, 'طابعة ليفو التجريبية', 'چاپکەری تاقیکردنەوەی لیڤۆ', 'An invented product for the discount browser run.', 'active',
            900000, 20, 'direct_sale', '["direct_sale","pre_order"]', '[]', 'OPTION', 2500, 400, 300, 300, 2200, ${q(category)});
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('${p.id}_g', ${q(p.id)}, 'Model', 0, 1);
  `);
  models.forEach((m, j) => {
    db.exec(`
      INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock, variant_key, variant_label)
      VALUES (${q(m.id)}, ${q(p.id)}, '${p.id}_g', ${q(m.en)}, ${q(m.ar)}, ${q(m.ckb)}, ${j}, 1, 10, ${q(`m${j}`)}, ${q(m.en)});
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES ('${m.id}_d', ${q(p.id)}, ${q(m.id)}, 'direct_sale', 1), ('${m.id}_p', ${q(p.id)}, ${q(m.id)}, 'pre_order', 1);
      INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled) VALUES ('${m.id}_p_land', ${q(p.id)}, '${m.id}_p', 'land', 1);
    `);
  });
  const key = `products/${p.id}/main.webp`;
  db.prepare('UPDATE products SET images = ? WHERE id = ?').run(JSON.stringify([{ id: `img_${p.id}`, url: `/files/${key}`, key, role: 'gallery', alt_ar: '', alt_en: p.name, alt_ckb: '', order: 0, primary: true }]), p.id);
  db.prepare("INSERT INTO product_images (id, product_id, url, r2_key, alt_en, sort_order, is_primary, content_type) VALUES (?, ?, ?, ?, ?, 0, 1, 'image/webp')").run(`img_${p.id}`, p.id, `/files/${key}`, key, p.name);
}

/** Users, the approved rates (U = 1,500), the two products, each V2-published by the real writer. */
async function seed(dbFile, { through = null } = {}) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA foreign_keys = ON');
  const applied = applyMigrations(db, (f) => through === null || f.slice(0, 4) <= through);
  const now = '2026-10-10T09:00:00.000Z';
  for (const [u, role, scope, name] of [
    [OWNER, 'admin', null, 'مالك ليفونيس'],
    [EDITOR, 'admin', 'full', 'محرر الأسعار'],
    [BUYER, 'customer', null, 'زبون التجربة'],
  ]) {
    db.prepare(`INSERT INTO users (id, email, username, name, password_hash, role, locale, email_verified_at, admin_scope) VALUES (?, ?, ?, ?, ?, ?, 'ar', ?, ?)`).run(
      u.id, u.email, u.id.replace('u_', 'e2e_'), name, passwordHash(u.password), role, now, scope
    );
  }
  db.exec(`INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status) VALUES ('dep_e2e_pd', ${q(BUYER.id)}, 'deposit', 'USD', 1000000, 'approved')`);
  applyRate(db, 'USD_IQD', '1500');
  applyRate(db, 'EUR_USD', '1.1');
  applyRate(db, 'CNY_USD', '0.14');
  db.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND'`);
  // A main section that exists: without one the catalogue-completeness gate holds the product the
  // moment its editor is opened (CATEGORY, worker/lib/productCompleteness.ts), and it leaves the shop.
  db.exec(`INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, is_printer_catalog) VALUES ('cat_e2e_pd', NULL, 'e2e-pd-printers', 'طابعات التجربة', 'E2E printers', 'چاپکەرەکانی تاقیکردنەوە', 1)`);
  seedPrinter(db, A, A.models, 'cat_e2e_pd');
  seedPrinter(db, C, [C.model], 'cat_e2e_pd');
  const d1 = new SqliteD1(db);
  await writeV2(d1, A.id, {
    method: 'usd',
    points: A.models.map((m) => ({ scope: 'option', scope_id: m.id, kind: 'fixed', usd: m.usd })),
    discounts: [{ scope: 'product', scope_id: '', usd: '50' }],
    actor: OWNER.id,
  });
  await writeV2(d1, C.id, {
    method: 'cost',
    inputs: { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 },
    minimumProfitUsd: '120',
    discounts: [{ scope: 'product', scope_id: '', usd: '50' }],
    actor: OWNER.id,
  });
  db.close();
  return applied;
}

async function seedPictures(persist) {
  const sharp = createRequire(join(ROOT, 'package.json'))('sharp');
  const dir = join(OUT, 'media');
  mkdirSync(dir, { recursive: true });
  for (const [p, colour] of [
    [A, '#1f3a5f'],
    [C, '#5f3a1f'],
  ]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="${colour}"/><text x="400" y="420" font-size="48" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${p.name}</text></svg>`;
    const file = join(dir, `${p.id}.webp`);
    writeFileSync(file, await sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer());
    execFileSync(WRANGLER, ['r2', 'object', 'put', `levonis-media-public/products/${p.id}/main.webp`, '--file', file, '--content-type', 'image/webp', '--local', '--persist-to', persist], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    });
  }
}

// ------------------------------------------------------------------ checks and results

const results = { started_at: new Date().toISOString(), cases: {}, blocked: [], fonts_aborted: [], page_errors: [], failures: [], leaks: [], shots: [] };
let current = 'setup';
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, ...(detail === undefined ? {} : { detail }) };
  (results.cases[current] ??= []).push(entry);
  console.log(`${ok ? '  ok  ' : '  FAIL'} [${current}] ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!ok) results.failures.push(`[${current}] ${name}`);
  return !!ok;
}

/** Keys no customer answer may carry (§11): the rate, the dollar set, the cents, any `*_usd`. */
const CUSTOMER_LEAK = /"(usd_iqd_rate|price_usd_cents|offer_usd_prices|[a-z_]*_usd)"\s*:/;
const CUSTOMER_PATHS = /^\/api\/(products|home|cart|orders|invoices|public)/;

// ------------------------------------------------------------------ the dev server

let dev = null;
let BASE = '';
let LOCAL_HOST = '';
async function startDev(persist, port, tag) {
  BASE = `http://127.0.0.1:${port}`;
  LOCAL_HOST = new URL(BASE).host;
  const log = createWriteStream(join(OUT, `wrangler-dev-${tag}.log`));
  dev = spawn(
    WRANGLER,
    ['dev', '--local', '--persist-to', persist, '--ip', '127.0.0.1', '--port', String(port), '--var', `INITIAL_ADMIN_EMAIL:${OWNER.email}`, '--show-interactive-dev-session=false'],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_UPDATE_NOTIFIER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  dev.stdout.pipe(log);
  dev.stderr.pipe(log);
  for (let i = 0; i < 240; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/settings/public`);
      if (r.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not answer in 120 s (see wrangler-dev-${tag}.log)`);
}
async function stopDev() {
  if (!dev) return;
  const proc = dev;
  dev = null;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill('SIGINT');
    setTimeout(resolve, 8000);
  });
}

let dbFile = '';
function rows(sql, ...params) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
const one = (sql, ...params) => rows(sql, ...params)[0] ?? null;

// ------------------------------------------------------------------ the browser

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });

async function session(who, { width = 1280, lang = 'ar', theme = 'light', customer = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 600 ? 800 : 1000 },
    deviceScaleFactor: 1,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
    colorScheme: theme,
    serviceWorkers: 'block',
    hasTouch: width < 600,
  });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    let host = '';
    try {
      host = new URL(u).host;
    } catch {
      /* data: and the like */
    }
    if (host === LOCAL_HOST || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    // The printable invoice links the Cairo face from Google Fonts (worker/lib/printDocument.ts, as it
    // always has): aborted like every other host, and listed apart — it is not a site of ours.
    if (host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') {
      results.fonts_aborted.push(`${current}: ${u.slice(0, 160)}`);
      return route.abort('blockedbyclient');
    }
    results.blocked.push(`${current}: ${u.slice(0, 160)}`);
    return route.abort('blockedbyclient');
  });
  await ctx.addInitScript(
    ([l, t]) => {
      try {
        localStorage.setItem('levo_lang', l);
        localStorage.setItem('levonis.theme.v1', t);
      } catch {
        /* storage blocked */
      }
    },
    [lang, theme]
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => results.page_errors.push(`${current}: ${String(e).slice(0, 300)}`));
  page.on('dialog', (d) => d.accept());
  const answers = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.startsWith(BASE) || !new URL(url).pathname.startsWith('/api/')) return;
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* a redirect or an aborted body */
    }
    const path = new URL(url).pathname + new URL(url).search;
    answers.push({ method: res.request().method(), path, status: res.status(), text });
    if (customer && CUSTOMER_PATHS.test(new URL(url).pathname) && CUSTOMER_LEAK.test(text)) results.leaks.push(`${current}: ${path} ${text.match(CUSTOMER_LEAK)?.[0]}`);
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  if (who) {
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: { identifier: who.email, password: who.password }, headers: { Origin: BASE } });
    if (login.status() !== 200) throw new Error(`sign-in ${who.email}: ${login.status()} ${(await login.text()).slice(0, 200)}`);
  }
  const api = (method, path, data) =>
    page.evaluate(
      async ([m, p, d]) => {
        const r = await fetch(p, { method: m, credentials: 'include', headers: d === null ? {} : { 'Content-Type': 'application/json' }, body: d === null ? undefined : JSON.stringify(d) });
        const text = await r.text();
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        return { status: r.status, body, text };
      },
      [method, path, data === undefined ? null : data]
    );
  return { ctx, page, api, answers };
}

async function settle(page, quietMs = 900, maxMs = 30000) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const start = Date.now();
  let last = await page.evaluate(() => performance.getEntriesByType('resource').length).catch(() => 0);
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(150);
    const n = await page.evaluate(() => performance.getEntriesByType('resource').length).catch(() => last);
    if (n !== last) {
      last = n;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) return;
  }
}
const shot = async (page, name, fullPage = true) => {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage }).catch((e) => console.log(`  (screenshot ${name}: ${e.message})`));
  results.shots.push(path);
};
/** No horizontal page scroll (the 360 px rule). */
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function openSection(page, n) {
  const t = page.locator(`[data-section-toggle="${n}"]`).first();
  await t.waitFor({ timeout: 20000 });
  if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
  await page.waitForTimeout(300);
}
async function openDiscountCard(page, id) {
  await page.goto(`${BASE}/admin?tab=products&edit=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-form="save-bar"]').first().waitFor({ timeout: 30000 });
  await settle(page, 1000);
  await openSection(page, 3);
  await page.locator('[data-product-discount]').first().waitFor({ timeout: 20000 });
  await settle(page, 900);
  return page.locator('[data-product-discount]').first();
}
async function typeInto(locator, text) {
  await locator.waitFor({ timeout: 15000 });
  await locator.click();
  await locator.fill('');
  await locator.pressSequentially(text, { delay: 20 });
}
/**
 * The card's targets: buttons, radios, links and the disclosure take a ≥ 44 px tap; fields ≥ 40 px (the
 * form's floor). The tap is the box, or the box grown by `.lv-hit`'s ::after (the house rule, §6.7) —
 * measured from the pseudo-element itself, not assumed from the class name.
 */
async function targetsOk(card) {
  return card.evaluate((root) => {
    const bad = [];
    for (const el of root.querySelectorAll('button, [role="radio"], a, summary')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      let tap = r.height;
      const after = getComputedStyle(el, '::after');
      if (after.content !== 'none' && after.position === 'absolute' && getComputedStyle(el).position !== 'static') {
        const top = parseFloat(after.top);
        const bottom = parseFloat(after.bottom);
        if (Number.isFinite(top) && Number.isFinite(bottom)) tap = Math.max(tap, r.height - top - bottom);
      }
      if (tap < 44) bad.push(`${el.tagName}:${(el.textContent || '').trim().slice(0, 30)}:${Math.round(tap)}`);
    }
    for (const el of root.querySelectorAll('input')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.height < 40) bad.push(`INPUT:${Math.round(r.height)}`);
    }
    return bad;
  });
}

// ================================================================== run
const ends = new Date(Date.now() + 9 * 24 * 3600 * 1000 + 3 * 3600 * 1000).toISOString().slice(0, 16); // Baghdad-local text, ~9 days ahead
let orderId = null;
try {
  current = 'setup';
  const PERSIST = join(OUT, 'persist');
  dbFile = initLocalD1(PERSIST);
  const applied = await seed(dbFile);
  check('the local database goes through every migration, 0197 last', applied.at(-1) === '0197_offer_usd_prices.sql', applied.at(-1));
  await seedPictures(PERSIST);
  const before = rows("SELECT combo_key, channel, final_price_iqd, usd_iqd_rate FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel", A.id);
  check('the printer is V2-published by the real writer at U 1,500: 900,000 / 825,000 and 1,125,000 / 1,050,000', JSON.stringify(before.map((r) => r.final_price_iqd).sort((x, y) => x - y)) === JSON.stringify([825000, 900000, 1050000, 1125000]), before);
  await startDev(PERSIST, PORT, 'main');

  // ---------------------------------------------------------------- 1. the owner sets the sale
  current = '1-owner';
  {
    const owner = await session(OWNER);
    const card = await openDiscountCard(owner.page, A.id);
    check('the card says there is no sale yet', (await card.innerText()).includes('لا يوجد تخفيض على هذا المنتج.'));
    await card.getByRole('button', { name: '+ إضافة تخفيض' }).click();
    await owner.page.waitForTimeout(400);
    const usdRadio = card.locator('[data-discount-segment="mode"] [role="radio"]').first();
    check('«سعر بعد الخصم ($)» is the chosen mode', (await usdRadio.getAttribute('aria-checked')) === 'true');
    check('two models at two prices: no scope control, a price per model', (await card.locator('[data-discount-segment="scope"]').count()) === 0);
    await typeInto(card.locator(`[data-discount-table] [data-v2-field="discount-usd-${A.models[0].id}"]`), '500');
    await typeInto(card.locator(`[data-discount-table] [data-v2-field="discount-usd-${A.models[1].id}"]`), '640');
    const dates = card.locator('input[type="datetime-local"]');
    await dates.nth(1).fill(ends);
    await owner.page.waitForTimeout(900);
    await settle(owner.page, 900);
    const text = await card.innerText();
    check('the preview: 900,000 → 750,000 «−17٪»', text.includes('900,000') && text.includes('750,000') && text.includes('−17٪'), text.slice(0, 600));
    check('…and 1,125,000 → 960,000 «−15٪»', text.includes('1,125,000') && text.includes('960,000') && text.includes('−15٪'));
    check('nothing is saved by typing', one('SELECT COUNT(*) AS n FROM offer_windows')?.n === 0);
    check('the card’s targets are ≥ 44 px (fields ≥ 40)', (await targetsOk(card)).length === 0, await targetsOk(card));
    await card.scrollIntoViewIfNeeded();
    await shot(owner.page, 'owner-card-preview-ar-1280-light', false);
    const mark = owner.answers.length;
    await card.getByRole('button', { name: 'حفظ التخفيض' }).click();
    for (let i = 0; i < 60 && !owner.answers.slice(mark).some((a) => a.method === 'PUT'); i += 1) await owner.page.waitForTimeout(250);
    await settle(owner.page, 900);
    const put = owner.answers.slice(mark).find((a) => a.method === 'PUT');
    check('«حفظ التخفيض» saves through the offers door', put?.status === 200, put ? `${put.status} ${put.text.slice(0, 300)}` : 'no PUT');
    check('«حُفظ التخفيض.» is said', (await card.innerText()).includes('حُفظ التخفيض.'));
    const set = rows('SELECT model_id, price_usd_cents FROM offer_usd_prices ORDER BY model_id');
    check('the dollar set is stored in cents, one row per model', JSON.stringify(set.map((r) => r.price_usd_cents).sort()) === JSON.stringify([50000, 64000]), set);
    await shot(owner.page, 'owner-card-saved-ar-1280-light', false);
    await owner.ctx.close();
    // The same card, dark, 360, and in Sorani.
    for (const [w, theme, lang] of [
      [1280, 'dark', 'ar'],
      [360, 'light', 'ar'],
      [360, 'dark', 'ckb'],
      [1280, 'light', 'ckb'],
    ]) {
      const o = await session(OWNER, { width: w, theme, lang });
      const c = await openDiscountCard(o.page, A.id);
      await c.scrollIntoViewIfNeeded();
      await settle(o.page, 700);
      if (w === 360) {
        check(`the card at 360 px (${lang}, ${theme}): no horizontal scroll`, await noSideScroll(o.page));
        check(`…its targets ≥ 44 px`, (await targetsOk(c)).length === 0, await targetsOk(c));
      }
      if (lang === 'ckb') check('the card speaks Sorani', (await c.innerText()).includes('داشکاندنی نرخ'));
      await shot(o.page, `owner-card-${lang}-${w}-${theme}`, false);
      await o.ctx.close();
    }
    const tab = await session(OWNER);
    await tab.page.goto(`${BASE}/admin?tab=offers`, { waitUntil: 'domcontentloaded' });
    await tab.page.locator('[data-panel="offers"]').first().waitFor({ timeout: 20000 });
    await settle(tab.page, 900);
    const line = await tab.page.locator('[data-offer-price-line]').first().innerText().catch(() => '');
    check('«العروض الخاصة» lists the same row as «$500.00 · 2 موديلات»', line.includes('$500.00') && line.includes('2 موديلات'), line);
    await shot(tab.page, 'owner-offers-tab-ar-1280-light');
    await tab.ctx.close();
  }

  // ---------------------------------------------------------------- 2. guest and buyer, three languages
  current = '2-customer';
  {
    for (const lang of ['ar', 'en', 'ckb']) {
      const label = { ar: 'سعر العرض', en: 'Sale price', ckb: 'نرخی ئۆفەر' }[lang];
      const badge = lang === 'en' ? '−17%' : '−17٪';
      for (const [w, theme] of lang === 'en' ? [[1280, 'light']] : [[1280, 'light'], [1280, 'dark'], [360, 'light'], [360, 'dark']]) {
        const guest = await session(null, { width: w, lang, theme, customer: true });
        await guest.page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
        await settle(guest.page, 1400);
        const cardEl = guest.page.locator('[data-product-card]').filter({ hasText: A.name.split(' / ')[0] }).first();
        await cardEl.waitFor({ timeout: 20000 });
        const cardText = latin(await cardEl.innerText());
        if (theme === 'light' && w === 1280) {
          check(`listing card (${lang}): 750,000, struck 900,000, «${badge}»`, cardText.includes('750,000') && cardText.includes('900,000') && cardText.includes(badge), cardText);
          const ends = { ar: 'ينتهي خلال', en: 'Ends in', ckb: 'کۆتایی دێت لە' }[lang];
          const from = { ar: 'يبدأ من', en: 'from', ckb: 'لە' }[lang];
          check(`…«${from}» and the clock «${ends}» (${lang})`, cardText.includes(from) && cardText.includes(ends), cardText);
        }
        if (w === 360) check(`/products at 360 (${lang}, ${theme}): no horizontal scroll`, await noSideScroll(guest.page));
        await shot(guest.page, `guest-listing-${lang}-${w}-${theme}`, false);
        await guest.page.goto(`${BASE}/product/${A.slug}`, { waitUntil: 'domcontentloaded' });
        await settle(guest.page, 1400);
        const pageText = latin(await guest.page.locator('body').innerText());
        if (theme === 'light' && w === 1280) {
          check(`product page (${lang}): «${label}», struck 900,000, «${badge}»`, pageText.includes(label) && pageText.includes('900,000') && pageText.includes(badge), pageText.slice(0, 500));
          const ends = { ar: 'ينتهي خلال', en: 'Ends in', ckb: 'کۆتایی دێت لە' }[lang];
          check(`…«${ends}» while it runs (${lang})`, (await guest.page.locator('[data-testid="product-offer-saving"]').first().innerText()).includes(ends));
        }
        if (w === 360) check(`product page at 360 (${lang}, ${theme}): no horizontal scroll`, await noSideScroll(guest.page));
        await shot(guest.page, `guest-product-${lang}-${w}-${theme}`, false);
        await guest.ctx.close();
      }
    }
    // The buyer: cart, checkout, a cash-on-delivery direct order, its page and its invoice.
    const buyer = await session(BUYER, { customer: true });
    // The «أكمل ملفك الشخصي» sheet would cover the order page: the buyer says «ربما لاحقًا» once.
    await buyer.api('POST', '/api/profile/completion/dismiss', {});
    const addr = await buyer.api('POST', '/api/addresses', { label: 'البيت', name: 'زبون التجربة', phone: '07701234567', address: 'شارع 62', governorate: 'baghdad', area: 'الكرادة', isDefault: true });
    const addressId = addr.body?.id ?? addr.body?.address?.id ?? null;
    check('the buyer has an address', !!addressId, addr.text.slice(0, 200));
    const settings = await buyer.api('GET', '/api/settings/public');
    const methods = (settings.body?.settings?.checkoutDeliveryMethods ?? []).filter((m) => m.enabled !== false);
    const deliveryId = methods[0]?.id ?? 'standard';
    const add = await buyer.api('POST', '/api/cart/items', { productId: A.id, qty: 1, optionId: A.models[0].id, optionValueIds: [A.models[0].id], fulfillmentType: 'direct_sale' });
    check('the P1S goes into the cart', add.status === 200, add.text.slice(0, 200));
    for (const [lang, w, theme] of [
      ['ar', 1280, 'light'],
      ['ckb', 360, 'dark'],
    ]) {
      const b = await session(BUYER, { width: w, lang, theme, customer: true });
      await b.page.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded' });
      await settle(b.page, 1400);
      const cartText = latin(await b.page.locator('body').innerText());
      check(`cart line (${lang}): 750,000, struck 900,000, «−17٪»`, cartText.includes('750,000') && cartText.includes('900,000') && cartText.includes('−17٪'), cartText.slice(0, 400));
      if (w === 360) check(`cart at 360: no horizontal scroll`, await noSideScroll(b.page));
      await shot(b.page, `buyer-cart-${lang}-${w}-${theme}`);
      await b.page.goto(`${BASE}/checkout`, { waitUntil: 'domcontentloaded' });
      await settle(b.page, 1800);
      const coText = latin(await b.page.locator('body').innerText());
      check(`checkout summary (${lang}): struck 900,000 under 750,000`, coText.includes('750,000') && coText.includes('900,000'), coText.slice(0, 400));
      if (w === 360) check(`checkout at 360: no horizontal scroll`, await noSideScroll(b.page));
      await shot(b.page, `buyer-checkout-${lang}-${w}-${theme}`);
      await b.ctx.close();
    }
    const placed = await buyer.api('POST', '/api/orders', {
      addressId,
      deliveryMethodId: deliveryId,
      paymentMethodId: 'cash',
      useWallet: false,
      usePoints: false,
      itemIds: [],
      idempotencyKey: `e2e-pd-${Date.now()}`,
      policyAcceptance: acceptedPolicies(),
    });
    orderId = placed.body?.order?.id ?? null;
    check('a cash-on-delivery direct order is placed at 750,000', placed.status === 200 && placed.body?.order?.items?.[0]?.unit_price_iqd === 750000, placed.text.slice(0, 300));
    const snap = JSON.parse(one('SELECT pricing_snapshot FROM order_items WHERE order_id = ?', orderId)?.pricing_snapshot ?? '{}');
    check('the order snapshot carries the before price and the typed dollars (admin-side)', snap.offer_before_iqd === 900000 && snap.offer?.offer_price_usd === '500.00', snap.offer);
    results.order_snapshot_before = one('SELECT unit_price_iqd, line_total_iqd, pricing_snapshot FROM order_items WHERE order_id = ?', orderId);
    for (const [lang, w, theme] of [
      ['ar', 1280, 'light'],
      ['ckb', 360, 'dark'],
      ['en', 1280, 'light'],
    ]) {
      const b = await session(BUYER, { width: w, lang, theme, customer: true });
      await b.page.goto(`${BASE}/orders/${orderId}?tab=items`, { waitUntil: 'domcontentloaded' });
      await settle(b.page, 1400);
      const odText = latin(await b.page.locator('body').innerText());
      check(`order page (${lang}): the struck before 900,000 and «−17»`, odText.includes('900,000') && /−17[٪%]/.test(odText), odText.slice(0, 400));
      if (w === 360) check('order page at 360: no horizontal scroll', await noSideScroll(b.page));
      await shot(b.page, `buyer-order-${lang}-${w}-${theme}`);
      await b.ctx.close();
    }
    const inv = one('SELECT id FROM invoices WHERE order_id = ?', orderId);
    for (const lang of ['ar', 'en', 'ckb']) {
      const html = await buyer.api('GET', `/api/invoices/${inv?.id}/html?lang=${lang}`);
      const sentence = { ar: 'السعر قبل العرض', en: 'Before the offer', ckb: 'نرخی پێش ئۆفەر' }[lang];
      check(`the invoice (${lang}) prints «${sentence}»`, html.status === 200 && html.text.includes(sentence) && html.text.includes('900,000'), html.status);
    }
    // Last: the invoice document's own CSP (connect-src none) refuses a fetch made from inside it.
    await buyer.page.goto(`${BASE}/api/invoices/${inv?.id}/html?lang=ar`, { waitUntil: 'domcontentloaded' });
    await shot(buyer.page, 'buyer-invoice-ar');
    await buyer.ctx.close();
  }

  // ---------------------------------------------------------------- 3. the rate moves (the real reprice)
  current = '3-rate';
  {
    await stopDev();
    const db = new DatabaseSync(dbFile);
    applyRate(db, 'USD_IQD', '1530');
    const g = globalThis;
    const cachesBefore = g.caches;
    const fetchBefore = g.fetch;
    g.caches = { default: { delete: async () => true, match: async () => undefined, put: async () => undefined } };
    // The job runs in this process: any network call it tried would be refused and counted here.
    g.fetch = async (u) => {
      results.blocked.push(`${current}: reprice fetch ${String(u?.url ?? u).slice(0, 160)}`);
      throw new Error('no network in the e2e reprice');
    };
    const report = await repriceStaleEngineProducts({ DB: new SqliteD1(db), INITIAL_ADMIN_EMAIL: OWNER.email, STORE_ROOT_DOMAIN: 'levonis.test' }, { trigger: 'fx', budget: statementBudget(600) });
    g.caches = cachesBefore;
    g.fetch = fetchBefore;
    db.close();
    check('U 1,530 approved: the real auto-reprice moves the printer', report.repriced.includes(A.id), report);
    // In production the job runs inside the Worker and drops the colo's copies it can name; the listing's
    // parameterised answers age out within their s-maxage (120 s, worker/lib/edgePolicy.ts). The job ran
    // outside the Worker here, so the local colo's cache is dropped by hand — that wait, compressed.
    rmSync(join(OUT, 'persist', 'v3', 'cache'), { recursive: true, force: true });
    await startDev(join(OUT, 'persist'), PORT, 'after-rate');
    const guest = await session(null, { customer: true });
    await guest.page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
    await settle(guest.page, 1400);
    const cardText = latin(await guest.page.locator('[data-product-card]').filter({ hasText: A.name }).first().innerText());
    check('the card reads 765,000, struck 918,000', cardText.includes('765,000') && cardText.includes('918,000'), cardText);
    await shot(guest.page, 'guest-listing-after-rate-ar-1280-light', false);
    await guest.ctx.close();
    const after = one('SELECT unit_price_iqd, line_total_iqd, pricing_snapshot FROM order_items WHERE order_id = ?', orderId);
    check('the placed order is unchanged', JSON.stringify(after) === JSON.stringify(results.order_snapshot_before));
  }

  // ---------------------------------------------------------------- 4. the editor on the cost-first AMS
  current = '4-editor';
  {
    const editor = await session(EDITOR);
    const card = await openDiscountCard(editor.page, C.id);
    await card.getByRole('button', { name: '+ إضافة تخفيض' }).click();
    await editor.page.waitForTimeout(500);
    const section = await editor.page.locator('[data-form="pricing-v2"]').first().innerText().catch(() => '');
    const cardText = await card.innerText();
    check('no dollar figure in section ٣ or the card', !/\$\s?\d/.test(section) && !/\$\s?\d/.test(cardText), (section + cardText).match(/\$\s?\d[\d.,]*/g));
    const usd = card.locator('[data-discount-segment="mode"] [role="radio"]').first();
    check('the dollar segment is disabled, with its sentence', (await usd.isDisabled()) && cardText.includes('هذا المنتج مسعَّر من التكلفة'));
    await typeInto(card.locator('input[inputmode="decimal"]').first(), '10');
    await editor.page.waitForTimeout(900);
    await settle(editor.page, 900);
    const mark = editor.answers.length;
    await card.getByRole('button', { name: 'حفظ التخفيض' }).click();
    for (let i = 0; i < 60 && !editor.answers.slice(mark).some((a) => a.method === 'PUT'); i += 1) await editor.page.waitForTimeout(250);
    const put = editor.answers.slice(mark).find((a) => a.method === 'PUT');
    check('a percent sale saves', put?.status === 200, put ? `${put.status} ${put.text.slice(0, 200)}` : 'no PUT');
    check('…and the editor’s answer carries no cost signal', put && !/below_cost|below_min_profit|OFFER_BELOW_COST|"owner"/.test(put.text));
    await settle(editor.page, 700);
    await card.scrollIntoViewIfNeeded();
    await shot(editor.page, 'editor-cost-first-card-ar-1280-light', false);
    await editor.ctx.close();
  }

  // ---------------------------------------------------------------- 5. removal from the tab
  current = '5-removal';
  {
    const owner = await session(OWNER);
    await owner.page.goto(`${BASE}/admin?tab=offers`, { waitUntil: 'domcontentloaded' });
    await owner.page.locator('[data-panel="offers"]').first().waitFor({ timeout: 20000 });
    await settle(owner.page, 900);
    await owner.page.locator('[data-panel="offers"] li button').filter({ hasText: A.name }).first().click();
    await owner.page.waitForTimeout(400);
    await owner.page.getByRole('button', { name: 'إزالة العرض' }).click();
    await settle(owner.page, 900);
    check('the window, its limits and its dollar rows are gone', one('SELECT COUNT(*) AS n FROM offer_windows WHERE subject_id = ?', A.id)?.n === 0 && one('SELECT COUNT(*) AS n FROM offer_usd_prices')?.n === 0);
    const card = await openDiscountCard(owner.page, A.id);
    check('the card says «لا يوجد تخفيض على هذا المنتج.»', (await card.innerText()).includes('لا يوجد تخفيض على هذا المنتج.'));
    await owner.ctx.close();
    // The product page is purged by name with the window (F3): a guest reads it without the sale at once.
    const pg = await session(null, { customer: true });
    const detail = await pg.api('GET', `/api/products/${A.slug}`);
    check('at once: the product page carries no offer', detail.status === 200 && !detail.body?.product?.offer && !/offer_before_iqd":\d/.test(detail.text), detail.text.slice(0, 200));
    await pg.ctx.close();
    // The listing's parameterised GUEST answers are not named by the purge; they age out at the edge
    // (worker/lib/edgePolicy.ts `purgeAnonymousCache`, a platform contract older than this feature, and
    // the local cache serves them stale longer still). A signed-in customer's listing is built for them
    // alone, never from that cache: it is the server's answer, read at once.
    const guest = await session(BUYER, { customer: true });
    await guest.page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
    await settle(guest.page, 1400);
    const cardText = latin(await guest.page.locator('[data-product-card]').filter({ hasText: A.name }).first().innerText());
    check('the listing (a signed-in customer’s, never edge-cached) strikes nothing', !cardText.includes('918,000') && !/−\d+٪/.test(cardText), cardText);
    await guest.ctx.close();
  }
  await stopDev();

  // ---------------------------------------------------------------- 6. an older database (0195, no 0197)
  current = '6-older-database';
  {
    const OLD = join(OUT, 'persist-0195');
    dbFile = initLocalD1(OLD);
    const appliedOld = await seed(dbFile, { through: '0195' });
    check('the second database stops at 0195', appliedOld.at(-1)?.startsWith('0195'), appliedOld.at(-1));
    await seedPictures(OLD);
    await startDev(OLD, PORT + 1, 'old');
    const owner = await session(OWNER);
    const card = await openDiscountCard(owner.page, A.id);
    await card.getByRole('button', { name: '+ إضافة تخفيض' }).click();
    await owner.page.waitForTimeout(500);
    const usd = card.locator('[data-discount-segment="mode"] [role="radio"]').first();
    check('the dollar segment is disabled, «غير متاح بعد على هذه القاعدة»', (await usd.isDisabled()) && (await card.innerText()).includes('غير متاح بعد على هذه القاعدة'));
    await typeInto(card.locator('input[inputmode="decimal"]').first(), '10');
    await owner.page.waitForTimeout(900);
    await settle(owner.page, 900);
    const mark = owner.answers.length;
    await card.getByRole('button', { name: 'حفظ التخفيض' }).click();
    for (let i = 0; i < 60 && !owner.answers.slice(mark).some((a) => a.method === 'PUT'); i += 1) await owner.page.waitForTimeout(250);
    const put = owner.answers.slice(mark).find((a) => a.method === 'PUT');
    check('a percent sale saves on the older database', put?.status === 200, put ? `${put.status} ${put.text.slice(0, 200)}` : 'no PUT');
    await settle(owner.page, 900);
    const saved = await card.innerText();
    check('…and the saved card reads 900,000 → 810,000 «−10٪»', saved.includes('810,000') && saved.includes('−10٪') && !saved.includes('…\n'), saved.slice(0, 600));
    await card.scrollIntoViewIfNeeded();
    await shot(owner.page, 'owner-card-older-db-ar-1280-light', false);
    await owner.ctx.close();
    const guest = await session(null, { customer: true });
    await guest.page.goto(`${BASE}/product/${A.slug}`, { waitUntil: 'domcontentloaded' });
    await settle(guest.page, 1400);
    const t = latin(await guest.page.locator('body').innerText());
    check('the percent sale strikes on the product page (810,000 for 900,000)', t.includes('810,000') && t.includes('900,000'), t.slice(0, 300));
    await guest.ctx.close();
    await stopDev();
  }
} catch (e) {
  results.failures.push(`[${current}] crashed: ${e?.stack ?? e}`);
  console.error(e);
} finally {
  current = '7-every-page';
  check('no page error was thrown', results.page_errors.length === 0, results.page_errors);
  check('no request left 127.0.0.1', results.blocked.length === 0, results.blocked.slice(0, 5));
  check('no customer answer carried a rate, a dollar set, cents or a *_usd key', results.leaks.length === 0, results.leaks.slice(0, 5));
  await browser.close().catch(() => {});
  await stopDev().catch(() => {});
  results.finished_at = new Date().toISOString();
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const total = Object.values(results.cases).flat().length;
  console.log(`\n${total - results.failures.length}/${total} checks passed; ${results.failures.length} failed. Screenshots: ${SHOTS}`);
  process.exitCode = results.failures.length ? 1 : 0;
}
