#!/usr/bin/env node
/**
 * TRADE-IN V2 — THE PHONE SCREENS AND THE DESK, END TO END IN A REAL BROWSER
 * (Services V2 S-P2, docs/DECISIONS.md row 238; spec §13.9).
 *
 * The real built SPA, the real Worker under `wrangler dev --local` and a real
 * local D1 at the newest migration (0192 included). An invented catalogue: a
 * «Bambu Lab A1» (plain and Combo) and a «Bambu Lab P1S», both V2-published
 * through the real writer (tests/fixtures/v2Publish.ts), filed under a printer
 * catalog, with a picture each. Sara bought an A1 and an A1 Combo; both were
 * delivered twenty days ago, the A1 with its serial on record.
 *
 *   1  CUSTOMER (phone, 390×844, Arabic, light). The P1S page shows the
 *      trade-in entry; it opens «أجهزتك» with the P1S kept as the device she
 *      wants. The Combo opens the scope sheet; the A1 opens the condition
 *      screen (hours with its screen photo, overall, no damage, every
 *      required angle), the device she wants (preselected), «عرضك» (asked
 *      once on open; the figure is the server's) and «أرسل الطلب». The
 *      timeline says «بانتظار جهازك».
 *   2  ASSISTANT (desktop). The services group carries the trade-in badge;
 *      the queue finds the request by the serial on record and by the phone's
 *      last digits; the intake sheet takes the serial typed and more hours
 *      than declared: the hours flag is raised. No value buttons, no cost key.
 *   3  FINANCIAL ADMIN. The value panel shows the server's ceiling; «اعتماد»
 *      fixes it. No FINANCIAL_FIELDS key in any answer.
 *   4  CUSTOMER. The timeline says the credit is ready; «أكمل الشراء» puts
 *      the P1S in the cart with the credit and opens checkout. «خدماتي» on the
 *      profile lists the request.
 *   5  OWNER. The valuation record and the trade-in settings (P&L, policy,
 *      component references, rules with each family's offer parameters).
 *   6  DARK, DESKTOP, OTHER LANGUAGES. The Combo's draft (two parts) through
 *      the condition, the target search and the offer, in dark; the list and
 *      the timeline on a desktop in light and dark; the timeline in Sorani and
 *      the list in English.
 *   7  360 PX AND REDUCED MOTION. The five screens and the timeline at 360×780
 *      (no horizontal scroll, the document's nor the app's scroller's), once
 *      more with `reducedMotion: 'reduce'`; the Combo sent at 360 px and the
 *      desk's intake sheet opened at the same width.
 *
 * LOCAL ONLY. The Worker listens on 127.0.0.1; every browser request to any
 * other host is aborted and counted, and the run fails unless that count is 0
 * and no page error was thrown. No live site, no production database: the
 * database is a fresh `--persist-to` directory this script creates.
 *
 * How to run (one heavy process — run it alone; ~4-6 minutes):
 *   npm run build
 *   OUT_DIR=/tmp/e2e-trade-in-v2 node --import tsx scripts/e2e-trade-in-v2.mjs
 *
 * Env: OUT_DIR (results.json, the wrangler log, the persist dir), SHOTS_DIR
 * (default OUT_DIR/screenshots), PORT (default 8853), CHROMIUM_PATH,
 * PLAYWRIGHT_MODULE, KEEP_DEV=1 (leave the dev server running at the end).
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
const PORT = Number(process.env.PORT || 8853);
const BASE = `http://127.0.0.1:${PORT}`;
const LOCAL_HOST = new URL(BASE).host;
const OUT = process.env.OUT_DIR || '/tmp/e2e-trade-in-v2';
const SHOTS = process.env.SHOTS_DIR || join(OUT, 'screenshots');
const PERSIST = join(OUT, 'persist');
const WRANGLER = process.env.WRANGLER || join(ROOT, 'node_modules/.bin/wrangler');
if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('dist/ is missing: run `npm run build` first');
mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------------ the invented people and catalogue

const OWNER = { id: 'u_owner', email: 'owner@levonis.test', password: 'owner-e2e-pass-1', name: 'مالك ليفونيس', scope: null };
const FIN = { id: 'u_fin', email: 'fin@levonis.test', password: 'fin-e2e-pass-1', name: 'مدير مالي', scope: 'full' };
const ASSIST = { id: 'u_assist', email: 'assist@levonis.test', password: 'assist-e2e-pass-1', name: 'مساعد الاستلام', scope: 'assistant' };
const SARA = { id: 'u_sara', email: 'sara@levonis.test', password: 'sara-e2e-pass-1', name: 'سارة', phone: '+9647701234567' };
const SERIAL = 'A1E2E0001';
const A1_PAID = 850_000;
const COMBO_PAID = 1_150_000;
const PLAIN_ITEM = 'oi_e2e_a1';
const COMBO_ITEM = 'oi_e2e_combo';

// ------------------------------------------------------------------ the local database

function initLocalD1() {
  rmSync(PERSIST, { recursive: true, force: true });
  mkdirSync(PERSIST, { recursive: true });
  execFileSync(WRANGLER, ['d1', 'execute', 'levonis-db', '--local', '--persist-to', PERSIST, '--command', 'SELECT 1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  const dir = join(PERSIST, 'v3/d1/miniflare-D1DatabaseObject');
  const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (!file) throw new Error(`no local D1 file under ${dir}`);
  return join(dir, file);
}

/** Every migration the way D1 applies it (one transaction each, bookkeeping in d1_migrations) — scripts/migrate-check.mjs. */
function applyMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
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
  }
  return files.at(-1);
}

function passwordHash(password) {
  const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const salt = randomBytes(16);
  return `pbkdf2$100000$${b64url(salt)}$${b64url(pbkdf2Sync(password, salt, 100000, 32, 'sha256'))}`;
}

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

function seed(db) {
  const now = new Date().toISOString();
  const delivered = daysAgo(20);
  const warrantyEnd = new Date(Date.parse(delivered) + 365 * 86_400_000).toISOString();
  db.exec('BEGIN');
  try {
    for (const u of [OWNER, FIN, ASSIST]) {
      db.prepare(`INSERT INTO users (id, email, username, name, password_hash, role, locale, email_verified_at, admin_scope) VALUES (?, ?, ?, ?, ?, 'admin', 'ar', ?, ?)`).run(
        u.id,
        u.email,
        u.id.replace('u_', 'e2e_'),
        u.name,
        passwordHash(u.password),
        now,
        u.scope
      );
    }
    db.prepare(`INSERT INTO users (id, email, username, name, password_hash, role, locale, email_verified_at, phone_e164) VALUES (?, ?, ?, ?, ?, 'customer', 'ar', ?, ?)`).run(
      SARA.id,
      SARA.email,
      'e2e_sara',
      SARA.name,
      passwordHash(SARA.password),
      now,
      SARA.phone
    );
    db.exec(`
      INSERT INTO addresses (id, user_id, label, name, phone, address, landmark, is_default)
      VALUES ('addr_e2e_sara', '${SARA.id}', 'Home', 'Sara', '${SARA.phone}', 'Baghdad, Karrada 12', '', 1);
      INSERT INTO products (id, slug, name, name_ar, name_ku, price_iqd, status, stock, options, colors, selling_type, sale_types, images, category_id, sub_category_id,
                            package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES ('p_a1', 'a1', 'Bambu Lab A1', 'بامبو لاب A1', 'بامبو لاب A1', ${A1_PAID}, 'active', 10, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', 'cat_printers', 'cat_printers_fdm', 9000, 450, 450, 450),
             ('p_p1s', 'p1s', 'Bambu Lab P1S', 'بامبو لاب P1S', 'بامبو لاب P1S', 1500000, 'active', 5, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', 'cat_printers', 'cat_printers_fdm', 12000, 500, 500, 500);
      INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_a1', 'p_a1', 'Model', 0, 1);
      INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, regular_price_iqd, variant_key) VALUES
        ('v_a1', 'p_a1', 'g_a1', 'A1', 'A1', 'A1', 0, 1, ${A1_PAID}, 'a1'),
        ('v_a1c', 'p_a1', 'g_a1', 'A1 Combo', 'A1 كومبو', 'A1 کۆمبۆ', 1, 1, ${COMBO_PAID}, 'a1-combo');
    `);
    // Filed under the printer catalogs (worker/lib/printerIdentity.ts): the product page's entry is a printer's.
    const catalogs = db.prepare("SELECT id FROM catalogs WHERE is_printer_catalog = 1 AND id IN ('cat_printers', 'cat_printers_fdm')").all();
    for (const c of catalogs) {
      for (const p of ['p_a1', 'p_p1s']) {
        const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM product_catalogs WHERE catalog_id = ?').get(c.id).n;
        db.prepare('INSERT OR IGNORE INTO product_catalogs (product_id, catalog_id, position) VALUES (?, ?, ?)').run(p, c.id, pos);
      }
    }
    for (const [order, item, value, label, paid, unit] of [
      ['ORD-E2E-A1', PLAIN_ITEM, 'v_a1', 'A1', A1_PAID, 'unit_e2e_a1'],
      ['ORD-E2E-COMBO', COMBO_ITEM, 'v_a1c', 'A1 Combo', COMBO_PAID, 'unit_e2e_combo'],
    ]) {
      db.exec(`
        INSERT INTO orders (id, user_id, status, stage, address_snapshot, delivery_method_id, delivery_method_snapshot, payment_method_id,
                            subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, created_at, updated_at, delivered_at)
        VALUES ('${order}', '${SARA.id}', 'delivered', 'delivered', '{}', 'standard', '{}', 'cash', ${paid}, 0, 1400, ${paid}, 0, '${daysAgo(25)}', '${delivered}', '${delivered}');
        INSERT INTO order_items (id, order_id, product_id, name_snapshot, image_snapshot, option_snapshot, qty, unit_price_iqd, line_total_iqd, option_id, option_value_ids)
        VALUES ('${item}', '${order}', 'p_a1', 'Bambu Lab A1', '/files/products/p_a1/main.webp', '${label}', 1, ${paid}, ${paid}, '${value}', '["${value}"]');
        INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at, policy_version)
        VALUES ('${unit}', '${order}', '${item}', 'p_a1', '${SARA.id}', 1, '${delivered}', 12, 0, '${delivered}', '${warrantyEnd}', '{}');
      `);
    }
    // Accounts that already answered the first-run questions (no «أكمل ملفك» sheet over the screens).
    db.prepare("UPDATE users SET onboarding_state = 'done', profile_prompt_at = ? WHERE id IN (?, ?, ?, ?)").run(now, OWNER.id, FIN.id, ASSIST.id, SARA.id);
    db.prepare('INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES (?, ?, ?, ?)').run(SERIAL, SERIAL, 'unit_e2e_a1', ASSIST.id);
    for (const p of [
      { id: 'p_a1', name: 'Bambu Lab A1' },
      { id: 'p_p1s', name: 'Bambu Lab P1S' },
    ]) {
      const key = `products/${p.id}/main.webp`;
      db.prepare('UPDATE products SET images = ? WHERE id = ?').run(JSON.stringify([{ id: `img_${p.id}`, url: `/files/${key}`, key, role: 'gallery', alt_ar: '', alt_en: p.name, alt_ckb: '', order: 0, primary: true }]), p.id);
      db.prepare("INSERT INTO product_images (id, product_id, url, r2_key, alt_en, sort_order, is_primary, content_type) VALUES (?, ?, ?, ?, ?, 0, 1, 'image/webp')").run(`img_${p.id}`, p.id, `/files/${key}`, key, p.name);
    }
    // Test catalogues are minimal (no cost, no full box data): the owner's «إخفاء المنتجات الناقصة» switch
    // starts OFF here, as in tests/fixtures/app.ts dbThrough — the switch has its own tests.
    db.exec("DELETE FROM admin_settings WHERE key = 'catalogHideIncomplete'");
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const sharp = createRequire(join(ROOT, 'package.json'))('sharp');
/** A WebP picture (a real one: no server conversion is needed for WebP). */
async function picture(label, colour, w = 800, h = 800) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${colour}"/><text x="${w / 2}" y="${h / 2 + 16}" font-size="${Math.round(w / 16)}" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${label}</text></svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer();
}
async function seedPictures() {
  const dir = join(OUT, 'media');
  mkdirSync(dir, { recursive: true });
  for (const [id, label, colour] of [
    ['p_a1', 'A1', '#2d4a6b'],
    ['p_p1s', 'P1S', '#3b3b3b'],
  ]) {
    const file = join(dir, `${id}.webp`);
    writeFileSync(file, await picture(label, colour));
    execFileSync(WRANGLER, ['r2', 'object', 'put', `levonis-media-public/products/${id}/main.webp`, '--file', file, '--content-type', 'image/webp', '--local', '--persist-to', PERSIST], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    });
  }
}

// ------------------------------------------------------------------ checks and results

const results = { started_at: new Date().toISOString(), base: BASE, cases: {}, blocked: [], page_errors: [], failures: [], shots: [] };
let current = 'setup';
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  const entry = { name, ok: !!ok, ...(detail === undefined ? {} : { detail }) };
  (results.cases[current] ??= []).push(entry);
  console.log(`${ok ? '  ok  ' : '  FAIL'} [${current}] ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!ok) results.failures.push(`[${current}] ${name}`);
  return !!ok;
}

/** FINANCIAL_FIELDS, read from the server's own list (worker/lib/adminScope.ts). */
const FINANCIAL_FIELDS = (() => {
  const src = readFileSync(join(ROOT, 'worker/lib/adminScope.ts'), 'utf8');
  const start = src.indexOf('export const FINANCIAL_FIELDS = [');
  const block = src.slice(start, src.indexOf('] as const;', start));
  return new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
})();
function financialKeys(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => financialKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const snake = k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
      if (FINANCIAL_FIELDS.has(k) || FINANCIAL_FIELDS.has(snake)) out.push(`${path}.${k}`);
      financialKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}
/** Every FINANCIAL_FIELDS key in the JSON answers a session received. */
function leakedKeys(answers) {
  const out = [];
  for (const a of answers) {
    let body = null;
    try {
      body = JSON.parse(a.text);
    } catch {
      continue;
    }
    for (const k of financialKeys(body)) out.push(`${a.method} ${a.path} ${k}`);
  }
  return out;
}

// ------------------------------------------------------------------ the dev server

let dev = null;
async function startDev() {
  const log = createWriteStream(join(OUT, 'wrangler-dev.log'));
  dev = spawn(
    WRANGLER,
    ['dev', '--local', '--persist-to', PERSIST, '--ip', '127.0.0.1', '--port', String(PORT), '--var', `INITIAL_ADMIN_EMAIL:${OWNER.email}`, '--show-interactive-dev-session=false'],
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
  throw new Error('wrangler dev did not answer in 120 s (see wrangler-dev.log)');
}
function stopDev() {
  if (dev && !process.env.KEEP_DEV) {
    dev.kill('SIGINT');
    dev = null;
  }
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
const PHONE = { width: 390, height: 844 };
/** The spec's narrowest phone (§10, «phone first at 360 px»). */
const NARROW = { width: 360, height: 780 };
const DESKTOP = { width: 1280, height: 900 };

/** A browser session for one person. Every non-local request is aborted and counted. */
async function session(who, { size = DESKTOP, lang = 'ar', dark = false, reducedMotion = false } = {}) {
  const phone = size.width < 600;
  const ctx = await browser.newContext({
    viewport: size,
    deviceScaleFactor: phone ? 2 : 1,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
    colorScheme: dark ? 'dark' : 'light',
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    serviceWorkers: 'block',
    hasTouch: phone,
    isMobile: phone,
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
    results.blocked.push(`${current}: ${u.slice(0, 160)}`);
    return route.abort('blockedbyclient');
  });
  await ctx.addInitScript(
    ([l, ids]) => {
      try {
        localStorage.setItem('levo_lang', l); // src/LanguageContext.tsx LANG_KEY
        // The theme sheet already seen (src/lib/firstRun.ts THEME_INTRO_KEY): the screens, not the first-run sheets.
        localStorage.setItem('levonis.themeIntro.v1', JSON.stringify(Object.fromEntries(ids.map((id) => [id, 'seen']))));
      } catch {
        /* storage blocked */
      }
    },
    [lang, [OWNER.id, FIN.id, ASSIST.id, SARA.id]]
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
    answers.push({ method: res.request().method(), path: new URL(url).pathname + new URL(url).search, status: res.status(), text });
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  if (who) {
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: { identifier: who.email, password: who.password }, headers: { Origin: BASE } });
    if (login.status() !== 200) throw new Error(`sign-in ${who.email}: ${login.status()} ${(await login.text()).slice(0, 200)}`);
  }
  return { ctx, page, answers };
}

async function settle(page, quietMs = 800, maxMs = 30000) {
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
/**
 * A screenshot as a person sees it. The app scrolls inside `#main-scroll-container` (and a sheet or
 * a dialog inside its own body), so a "full page" capture would show one screen: a long screen is
 * taken in parts instead — the open dialog's body, else the page's scroller, from the top, at most
 * four screens (name-1.png, name-2.png …). The pointer is parked first (no hover left on a row).
 */
const shot = async (page, name, full = true) => {
  await page.mouse.move(1, 1).catch(() => {});
  await page.waitForTimeout(250);
  const parts = full
    ? await page
        .evaluate((maxParts) => {
          const scrollable = (x) => {
            const o = getComputedStyle(x).overflowY;
            return (o === 'auto' || o === 'scroll') && x.scrollHeight > x.clientHeight + 8 && x.clientHeight > 160;
          };
          const open = [...document.querySelectorAll('[role="dialog"], [data-overlay]')].filter((d) => d.getBoundingClientRect().height > 0);
          const scope = open.length ? open[open.length - 1] : null;
          let el = null;
          if (!scope) {
            const main = document.getElementById('main-scroll-container');
            if (main && main.scrollHeight > main.clientHeight + 8) el = main;
            else if (document.scrollingElement && document.scrollingElement.scrollHeight > window.innerHeight + 8) el = document.scrollingElement;
          }
          if (!el) {
            const all = [...(scope ?? document).querySelectorAll('*')].filter(scrollable);
            all.sort((a, b) => b.clientHeight - a.clientHeight);
            el = all[0] ?? null;
          }
          window.__shotEl = el;
          if (!el) return 1;
          el.scrollTop = 0;
          const step = Math.round(el.clientHeight * 0.8);
          return Math.min(maxParts, 1 + Math.ceil((el.scrollHeight - el.clientHeight) / step));
        }, 4)
        .catch(() => 1)
    : 1;
  for (let i = 0; i < parts; i += 1) {
    if (i) {
      await page.evaluate((k) => {
        const el = window.__shotEl;
        if (el) el.scrollTop = Math.round(el.clientHeight * 0.8) * k;
      }, i);
    }
    await page.waitForTimeout(300);
    const path = join(SHOTS, `${name}${parts > 1 ? `-${i + 1}` : ''}.png`);
    await page
      .screenshot({ path, fullPage: false })
      .then(() => results.shots.push(path))
      .catch((e) => console.log(`  (screenshot ${name}: ${e.message})`));
  }
};
const visible = async (locator, timeout = 20000) => {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
};
/** Waits for an answer to a request matching `test`, made after `mark`. */
async function answerAfter(who, mark, test, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const hit = who.answers.slice(mark).find(test);
    if (hit) return hit;
    await who.page.waitForTimeout(150);
  }
  return null;
}

const PHOTO = await picture('trade-in photo', '#5b6b4a', 640, 480);
/** One photograph through the phone's file input (the screen's own upload path). */
async function upload(who, selector) {
  const mark = who.answers.length;
  await who.page.locator(selector).first().setInputFiles({ name: 'photo.webp', mimeType: 'image/webp', buffer: PHOTO });
  const res = await answerAfter(who, mark, (a) => a.method === 'POST' && /\/photos$/.test(a.path.split('?')[0]));
  return res?.status ?? 0;
}

/**
 * The condition of one part: hours (and its photo), «جيدة», no damage, all accessories, every
 * required angle. Nothing is chosen before she chooses it (review F-23): «متابعة» waits for each.
 */
async function answerCondition(who, hours) {
  const page = who.page;
  const pressed = await page.locator('[data-overall][aria-checked="true"], [data-accessories][aria-checked="true"], [data-damage][aria-checked="true"]').count();
  check('nothing on the condition screen reads as chosen before she chose it', pressed === 0, pressed);
  const hoursInput = page.locator('[data-hours]');
  if (await hoursInput.count()) {
    check('the hours field starts empty', (await hoursInput.first().inputValue()) === '');
    await hoursInput.first().fill(String(hours));
    if (await page.locator('input[data-upload="hours"]').count()) check('the hours photo uploads', (await upload(who, 'input[data-upload="hours"]')) === 201);
  }
  await page.locator('[data-overall="good"]').first().click();
  if (await page.locator('[data-damage="none"]').count()) await page.locator('[data-damage="none"]').first().click();
  await page.locator('[data-accessories="all"]').first().click();
  const angles = await page.locator('input[data-upload^="angle:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-upload')));
  let ok = 0;
  for (const a of angles) if ((await upload(who, `input[data-upload="${a}"]`)) === 201) ok += 1;
  check(`every required angle uploads (${ok}/${angles.length})`, angles.length > 0 && ok === angles.length);
  await settle(page, 600);
}

/** No horizontal scroll (spec §10): neither the document nor the app's own scroller is wider than the screen. */
async function noSideScroll(page, label) {
  const o = await page
    .evaluate(() => {
      const main = document.getElementById('main-scroll-container');
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((d) => d.scrollWidth - d.clientWidth);
      return {
        doc: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        main: main ? main.scrollWidth - main.clientWidth : 0,
        dialog: dialogs.length ? Math.max(...dialogs) : 0,
      };
    })
    .catch(() => null);
  check(`${label}: no horizontal scroll at ${o?.inner ?? '?'} px`, !!o && o.doc <= o.inner && o.main <= 1 && o.dialog <= 1, o);
}

// ================================================================== run
const failHard = (e) => {
  results.failures.push(`[${current}] crashed: ${e?.stack ?? e}`);
  console.error(e);
};
let requestId = null;
let comboDraft = null;
try {
  current = 'setup';
  dbFile = initLocalD1();
  {
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA foreign_keys = ON');
    const last = applyMigrations(db);
    check('the database stands at the newest migration (0192 included)', Number(String(last).slice(0, 4)) >= 192, last);
    seed(db);
    // The real V2 writer (price-first, reproducing each product's dinar price): «listed and V2-priced».
    const { publishAllV2 } = await import('../tests/fixtures/v2Publish.ts');
    const done = await publishAllV2(db, { ids: ['p_a1', 'p_p1s'] });
    check('the A1 and the P1S are V2-published through the real writer', done.length === 2, done);
    db.close();
  }
  await seedPictures();
  await startDev();

  // ---------------------------------------------------------------- 1. the customer: product page → five screens → sent
  current = '1-customer';
  const sara = await session(SARA, { size: PHONE });
  {
    const page = sara.page;
    await page.goto(`${BASE}/product/p1s`, { waitUntil: 'domcontentloaded' });
    const entry = page.locator('[data-product-trade-in]');
    check('the P1S page shows the trade-in entry (a printer, a signed-in customer with a device)', await visible(entry, 30000));
    await entry.first().scrollIntoViewIfNeeded().catch(() => {});
    await settle(page);
    await shot(page, 'phone-light-1-product-entry', false);
    await entry.first().click();
    await page.waitForURL(/\/trade-in\?.*target=p_p1s/, { timeout: 20000 }).catch(() => {});
    check('the entry opens «أجهزتك» keeping the P1S as the device she wants', page.url().includes('target=p_p1s'), page.url());
    check('«أجهزتك» lists both devices', (await visible(page.locator(`[data-unit="${PLAIN_ITEM}:1"]`), 30000)) && (await page.locator(`[data-unit="${COMBO_ITEM}:1"]`).count()) === 1);
    await settle(page);
    await shot(page, 'phone-light-2-devices');

    await page.locator(`[data-unit="${COMBO_ITEM}:1"]`).first().click();
    const scope = page.locator('[data-overlay="trade-in-scope"]');
    check('the Combo opens the scope sheet (whole / printer only / AMS only)', (await visible(scope)) && (await scope.locator('[data-scope]').count()) === 3);
    await settle(page, 500);
    await shot(page, 'phone-light-3-scope-sheet', false);
    await page.keyboard.press('Escape');
    await scope.first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

    await page.locator(`[data-unit="${PLAIN_ITEM}:1"]`).first().click();
    await page.waitForURL(/step=condition/, { timeout: 30000 }).catch(() => {});
    check('the A1 opens the condition screen (a draft, step in the URL)', await visible(page.locator('[data-condition="device"]'), 30000), page.url());
    await answerCondition(sara, 300);
    await shot(page, 'phone-light-4-condition');
    const next = page.locator('[data-trade-in-next]');
    check('«التالي» is enabled once every proof is there', await next.first().isEnabled());
    await next.first().click();
    await page.waitForURL(/step=target/, { timeout: 30000 }).catch(() => {});
    check('the device she wants is preselected from the product page (P1S)', await visible(page.locator('[data-target-chosen="p_p1s"]'), 30000));
    await settle(page);
    await shot(page, 'phone-light-5-target', false);
    await page.locator('[data-target-change]').first().click();
    const search = page.locator('[data-target-search]');
    if (await visible(search)) {
      await search.first().fill('P1S');
      check('the target search finds the listed P1S', await visible(page.locator('[data-target-results] [data-target="p_p1s"]'), 20000));
      await settle(page, 500);
      await shot(page, 'phone-light-5b-target-search', false);
      await page.keyboard.press('Escape');
      await page.locator('[data-overlay="trade-in-target"]').first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    } else check('the target search opens', false);
    const markOffer = sara.answers.length;
    await page.locator('[data-trade-in-next]').first().click();
    await page.waitForURL(/step=offer/, { timeout: 30000 }).catch(() => {});
    const figure = page.locator('[data-offer-figure]');
    check('«عرضك» shows a figure', await visible(figure, 30000));
    await settle(page, 1000);
    const previews = sara.answers.slice(markOffer).filter((a) => a.method === 'POST' && /\/preview$/.test(a.path.split('?')[0]));
    check('«عرضك» asked the preview once on open', previews.length === 1, previews.map((p) => p.status));
    let offerIqd = null;
    try {
      offerIqd = JSON.parse(previews[0]?.text ?? '{}')?.offer?.offer_iqd ?? null;
    } catch {
      offerIqd = null;
    }
    await visible(page.locator('[data-offer-figure] [data-offer-iqd]'), 30000);
    const shown = Number((await page.locator('[data-offer-figure] [data-offer-iqd]').first().getAttribute('data-offer-iqd')) ?? NaN);
    check("the figure on screen is the server's offer", offerIqd !== null && shown === offerIqd, { offerIqd, shown });
    await shot(page, 'phone-light-6-offer');
    await page.locator('[data-trade-in-send]').first().click();
    await page.waitForURL(/request=/, { timeout: 30000 }).catch(() => {});
    requestId = new URL(page.url()).searchParams.get('request');
    check('«أرسل الطلب» opens the request timeline', !!requestId && (await visible(page.locator(`[data-trade-in-request="${requestId}"]`), 30000)), page.url());
    await settle(page);
    check('the timeline says the shop waits for her device', (await page.locator(`[data-trade-in-request="${requestId}"][data-stage="awaiting_device"]`).count()) === 1);
    await shot(page, 'phone-light-7-timeline-sent');
    const row = one('SELECT status, offer_iqd FROM trade_in_requests WHERE id = ?', requestId);
    check('the request is submitted with the offer she was shown', row?.status === 'submitted' && row?.offer_iqd === offerIqd, row);
    check('the customer read no FINANCIAL_FIELDS key', leakedKeys(sara.answers).length === 0, leakedKeys(sara.answers).slice(0, 5));
  }

  // ---------------------------------------------------------------- 2. the assistant: queue, search, intake
  current = '2-assistant';
  const assist = await session(ASSIST, { size: DESKTOP });
  {
    const page = assist.page;
    await page.goto(`${BASE}/admin?tab=trade_in`, { waitUntil: 'domcontentloaded' });
    check('the desk opens the trade-in queue', await visible(page.locator('[data-trade-in-queue]'), 30000));
    await page.locator('[data-queue-search]').first().fill(SERIAL);
    check('the queue finds the request by the serial on record', await visible(page.locator(`[data-row="${requestId}"]`), 20000));
    await settle(page);
    await shot(page, 'desktop-light-a1-queue-serial');
    await page.locator('[data-queue-search]').first().fill('4567');
    check("…and by the phone's last digits", await visible(page.locator(`[data-row="${requestId}"]`), 20000));
    await page.locator(`[data-row="${requestId}"]`).first().click();
    const sheet = page.locator('[data-intake-sheet]');
    check('the request opens with the intake sheet', await visible(sheet, 20000));
    check('an assistant sees no value panel', (await page.locator('[data-value-panel]').count()) === 0);
    await page.locator('[data-intake-serial]').first().fill(SERIAL);
    await page.locator('[data-intake-hours]').first().fill('900');
    for (const part of await page.locator('[data-intake-part]').all()) {
      const good = part.locator('[data-intake-overall="good"]');
      if (await good.count()) await good.first().click();
    }
    const store = page.locator('[data-intake-handover="store"]');
    if (await store.count()) await store.first().click();
    await settle(page, 500);
    await shot(page, 'desktop-light-a2-intake-sheet');
    const mark = assist.answers.length;
    await page.locator('[data-intake-submit]').first().click();
    const res = await answerAfter(assist, mark, (a) => a.method === 'POST' && a.path.endsWith('/intake'));
    check('the intake is recorded', res?.status === 200, res ? `${res.status} ${res.text.slice(0, 300)}` : 'no answer');
    check('the intake record shows on the request', await visible(page.locator('[data-intake-record]'), 20000));
    await settle(page);
    await shot(page, 'desktop-light-a3-intake-recorded');
    const intake = one('SELECT intake_at, intake_json FROM trade_in_requests WHERE id = ?', requestId);
    check('the database holds the intake (serial matched, hours as seen)', !!intake?.intake_at && String(intake.intake_json).includes('900'), intake);
    check('an assistant read no FINANCIAL_FIELDS key', leakedKeys(assist.answers).length === 0, leakedKeys(assist.answers).slice(0, 5));
    await page.keyboard.press('Escape');
    await page.locator('[data-queue-search]').first().fill('');
    await settle(page);
    check('the row carries the hours flag', await visible(page.locator(`[data-row="${requestId}"] [data-flag="hoursFlag"]`), 15000));
    await shot(page, 'desktop-light-a4-queue-flags');
  }
  await assist.ctx.close();

  // ---------------------------------------------------------------- 3. the financial admin: the ceiling, «اعتماد»
  current = '3-financial';
  const fin = await session(FIN, { size: DESKTOP });
  {
    const page = fin.page;
    await page.goto(`${BASE}/admin?tab=trade_in`, { waitUntil: 'domcontentloaded' });
    await visible(page.locator(`[data-row="${requestId}"]`), 30000);
    await page.locator(`[data-row="${requestId}"]`).first().click();
    const panel = page.locator('[data-value-panel]');
    check('a financial admin sees the value panel with the server ceiling', await visible(panel, 20000));
    const ceiling = Number((await page.locator('[data-ceiling]').first().getAttribute('data-ceiling')) ?? NaN);
    const dbCeiling = one('SELECT ceiling_iqd FROM trade_in_requests WHERE id = ?', requestId)?.ceiling_iqd ?? null;
    check('the ceiling on screen is the one the server stored at intake', Number.isFinite(ceiling) && ceiling === dbCeiling, { ceiling, dbCeiling });
    await settle(page);
    await shot(page, 'desktop-light-f1-value-panel');
    const mark = fin.answers.length;
    await page.locator('[data-act="approve"]').first().click();
    const res = await answerAfter(fin, mark, (a) => a.method === 'POST' && a.path.endsWith('/approve'));
    check('«اعتماد» is accepted', res?.status === 200, res ? `${res.status} ${res.text.slice(0, 300)}` : 'no answer');
    await settle(page);
    await shot(page, 'desktop-light-f2-approved');
    check('a financial admin read no FINANCIAL_FIELDS key', leakedKeys(fin.answers).length === 0, leakedKeys(fin.answers).slice(0, 5));
  }
  await fin.ctx.close();

  // ---------------------------------------------------------------- 4. the customer: credit ready → checkout; «خدماتي»
  current = '4-customer';
  {
    const page = sara.page;
    await page.goto(`${BASE}/trade-in?request=${encodeURIComponent(requestId)}`, { waitUntil: 'domcontentloaded' });
    const pay = page.locator('[data-pay]');
    check('the timeline offers «أكمل الشراء» once the credit is ready', await visible(pay, 30000));
    await settle(page);
    await shot(page, 'phone-light-8-credit-ready');
    await pay.first().click();
    await page.waitForURL(/\/checkout/, { timeout: 30000 }).catch(() => {});
    check('«أكمل الشراء» opens checkout with the P1S in the cart', page.url().includes('/checkout') && one('SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ? AND product_id = ?', SARA.id, 'p_p1s')?.n >= 1, page.url());
    await settle(page, 1200);
    await shot(page, 'phone-light-9-checkout', false);
    await page.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
    check('«خدماتي» on the profile lists the trade-in', await visible(page.locator('[data-profile-services] [data-services-row]'), 30000));
    await page.locator('[data-profile-services]').first().scrollIntoViewIfNeeded().catch(() => {});
    await settle(page);
    await shot(page, 'phone-light-10-my-services', false);
    check('the customer read no FINANCIAL_FIELDS key', leakedKeys(sara.answers).length === 0, leakedKeys(sara.answers).slice(0, 5));
  }

  // ---------------------------------------------------------------- 5. the owner: valuation record, settings
  current = '5-owner';
  const owner = await session(OWNER, { size: DESKTOP });
  {
    const page = owner.page;
    await page.goto(`${BASE}/admin?tab=trade_in`, { waitUntil: 'domcontentloaded' });
    await visible(page.locator(`[data-row="${requestId}"]`), 30000);
    await page.locator(`[data-row="${requestId}"]`).first().click();
    check("the owner reads the request's valuation record", await visible(page.locator('[data-owner-valuation]'), 30000));
    await settle(page);
    await shot(page, 'desktop-light-o1-owner-valuation');
    await page.keyboard.press('Escape');
    await page.locator('[data-trade-in-view="settings"]').first().click();
    check('the owner opens the trade-in settings (P&L, policy, references, rules)', await visible(page.locator('[data-trade-in-settings] [data-trade-in-policy] [data-policy]'), 30000));
    check("the rules editor shows each family's offer parameters", await visible(page.locator('[data-offer-params]'), 30000));
    await settle(page, 1200);
    await shot(page, 'desktop-light-o2-owner-settings');
  }
  await owner.ctx.close();

  // ---------------------------------------------------------------- 6. dark, desktop, other languages
  current = '6-dark-phone';
  const saraDark = await session(SARA, { size: PHONE, dark: true });
  {
    const page = saraDark.page;
    await page.goto(`${BASE}/trade-in`, { waitUntil: 'domcontentloaded' });
    await visible(page.locator(`[data-unit="${COMBO_ITEM}:1"]`), 30000);
    await settle(page);
    await shot(page, 'phone-dark-1-devices');
    await page.locator(`[data-unit="${COMBO_ITEM}:1"]`).first().click();
    await visible(page.locator('[data-overlay="trade-in-scope"]'));
    await settle(page, 500);
    await shot(page, 'phone-dark-2-scope-sheet', false);
    await page.locator('[data-scope="whole"]').first().click();
    await page.locator('[data-scope-continue]').first().click();
    await page.waitForURL(/step=condition/, { timeout: 30000 }).catch(() => {});
    check('the whole Combo opens the condition screen with two parts', (await visible(page.locator('[data-condition]'), 30000)) && (await page.locator('[data-part]').count()) >= 2);
    await answerCondition(saraDark, 120);
    await shot(page, 'phone-dark-3-condition-printer');
    await page.locator('[data-next-part]').first().click();
    await visible(page.locator('[data-condition="ams"]'), 15000);
    await answerCondition(saraDark, 0);
    await shot(page, 'phone-dark-4-condition-ams');
    await page.locator('[data-trade-in-next]').first().click();
    await page.waitForURL(/step=target/, { timeout: 30000 }).catch(() => {});
    await page.locator('[data-target-open]').first().click();
    const search = page.locator('[data-target-search]');
    await visible(search);
    await search.first().fill('P1S');
    check('the dark target search lists the P1S', await visible(page.locator('[data-target-results] [data-target="p_p1s"]'), 20000));
    await settle(page, 500);
    await shot(page, 'phone-dark-5-target-search', false);
    await page.locator('[data-target-results] [data-target="p_p1s"]').first().click();
    const confirm = page.locator('[data-target-confirm]');
    if (await visible(confirm, 10000)) await confirm.first().click();
    check('the chosen device shows on the target step', await visible(page.locator('[data-target-chosen="p_p1s"]'), 20000));
    await page.locator('[data-trade-in-next]').first().click();
    await page.waitForURL(/step=offer/, { timeout: 30000 }).catch(() => {});
    check('the Combo offer shows a figure', await visible(page.locator('[data-offer-figure]'), 30000));
    comboDraft = new URL(page.url()).searchParams.get('draft');
    await settle(page, 1000);
    await shot(page, 'phone-dark-6-offer');
    await page.goto(`${BASE}/trade-in?request=${encodeURIComponent(requestId)}`, { waitUntil: 'domcontentloaded' });
    await visible(page.locator(`[data-trade-in-request="${requestId}"]`), 30000);
    await settle(page);
    await shot(page, 'phone-dark-7-timeline');
    await page.goto(`${BASE}/product/p1s`, { waitUntil: 'domcontentloaded' });
    if (await visible(page.locator('[data-product-trade-in]'), 30000)) {
      await page.locator('[data-product-trade-in]').first().scrollIntoViewIfNeeded().catch(() => {});
      await settle(page);
      await shot(page, 'phone-dark-8-product-entry', false);
    }
  }
  await saraDark.ctx.close();
  await sara.ctx.close();

  current = '6-desktop';
  for (const dark of [false, true]) {
    const s = await session(SARA, { size: DESKTOP, dark });
    const tag = dark ? 'dark' : 'light';
    await s.page.goto(`${BASE}/trade-in`, { waitUntil: 'domcontentloaded' });
    check(`desktop ${tag}: «أجهزتك»`, await visible(s.page.locator('[data-trade-in-devices]'), 30000));
    await settle(s.page);
    await shot(s.page, `desktop-${tag}-c1-devices`);
    await s.page.goto(`${BASE}/trade-in?request=${encodeURIComponent(requestId)}`, { waitUntil: 'domcontentloaded' });
    await visible(s.page.locator(`[data-trade-in-request="${requestId}"]`), 30000);
    await settle(s.page);
    await shot(s.page, `desktop-${tag}-c2-timeline`);
    if (comboDraft) {
      for (const step of ['condition', 'offer']) {
        await s.page.goto(`${BASE}/trade-in?draft=${encodeURIComponent(comboDraft)}&step=${step}`, { waitUntil: 'domcontentloaded' });
        check(`desktop ${tag}: the draft's ${step} step`, await visible(s.page.locator(step === 'offer' ? '[data-offer-figure]' : '[data-condition]'), 30000));
        await settle(s.page, 1000);
        await shot(s.page, `desktop-${tag}-c3-${step}`);
      }
    }
    await s.ctx.close();
  }
  {
    const s = await session(ASSIST, { size: DESKTOP, dark: true });
    await s.page.goto(`${BASE}/admin?tab=trade_in`, { waitUntil: 'domcontentloaded' });
    await visible(s.page.locator(`[data-row="${requestId}"]`), 30000);
    await settle(s.page);
    await shot(s.page, 'desktop-dark-a5-queue');
    await s.page.locator(`[data-row="${requestId}"]`).first().click();
    await visible(s.page.locator('[data-intake-record]'), 20000);
    await settle(s.page);
    await shot(s.page, 'desktop-dark-a6-request');
    await s.ctx.close();
  }
  {
    const s = await session(OWNER, { size: PHONE, dark: false });
    await s.page.goto(`${BASE}/admin?tab=trade_in`, { waitUntil: 'domcontentloaded' });
    check('phone: the desk queue opens', await visible(s.page.locator('[data-trade-in-queue]'), 30000));
    await settle(s.page);
    await shot(s.page, 'phone-light-a1-desk-queue');
    await s.ctx.close();
  }

  current = '6-languages';
  for (const [lang, path, name, probe] of [
    ['ckb', `/trade-in?request=${encodeURIComponent(requestId)}`, 'phone-light-ckb-timeline', `[data-trade-in-request="${requestId}"]`],
    ['en', '/trade-in', 'phone-light-en-devices', '[data-trade-in-devices]'],
  ]) {
    const s = await session(SARA, { size: PHONE, lang });
    await s.page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    check(`${lang}: the page renders`, await visible(s.page.locator(probe), 30000));
    await settle(s.page);
    const dir = await s.page.evaluate(() => document.documentElement.dir);
    check(`${lang}: the document direction is ${lang === 'en' ? 'ltr' : 'rtl'}`, dir === (lang === 'en' ? 'ltr' : 'rtl'), dir);
    await shot(s.page, name);
    await s.ctx.close();
  }

  // ---------------------------------------------------------------- 7. 360 px, and reduced motion (spec §10; review F-34)
  for (const reduced of [false, true]) {
    current = reduced ? '7-narrow-reduced-motion' : '7-narrow';
    const tag = reduced ? 'phone360-reduced' : 'phone360';
    const s = await session(SARA, { size: NARROW, reducedMotion: reduced });
    const page = s.page;
    if (reduced) check('reduced motion is what the page sees', await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
    await page.goto(`${BASE}/trade-in`, { waitUntil: 'domcontentloaded' });
    check(`${tag}: «أجهزتك»`, await visible(page.locator('[data-trade-in-devices]'), 30000));
    await settle(page);
    await noSideScroll(page, `${tag} devices`);
    await shot(page, `${tag}-1-devices`, false);
    await page.locator(`[data-unit="${COMBO_ITEM}:1"]`).first().click();
    if (await visible(page.locator('[data-overlay="trade-in-scope"]'), 15000)) {
      await settle(page, 500);
      await noSideScroll(page, `${tag} scope sheet`);
      await shot(page, `${tag}-2-scope`, false);
      await page.keyboard.press('Escape');
      await page.locator('[data-overlay="trade-in-scope"]').first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    if (comboDraft) {
      for (const [n, step, probe] of [
        [3, 'condition', '[data-condition]'],
        [4, 'target', '[data-trade-in-target]'],
        [5, 'offer', '[data-offer-figure]'],
      ]) {
        await page.goto(`${BASE}/trade-in?draft=${encodeURIComponent(comboDraft)}&step=${step}`, { waitUntil: 'domcontentloaded' });
        check(`${tag}: the draft's ${step} step`, await visible(page.locator(probe), 30000));
        await settle(page, 800);
        await noSideScroll(page, `${tag} ${step}`);
        await shot(page, `${tag}-${n}-${step}`, false);
      }
    }
    await page.goto(`${BASE}/trade-in?request=${encodeURIComponent(requestId)}`, { waitUntil: 'domcontentloaded' });
    check(`${tag}: the timeline`, await visible(page.locator(`[data-trade-in-request="${requestId}"]`), 30000));
    await settle(page);
    await noSideScroll(page, `${tag} timeline`);
    await shot(page, `${tag}-6-timeline`, false);
    // The Combo is sent at 360 px (on the last pass), so the desk can open its intake sheet at the same width.
    if (reduced && comboDraft) {
      await page.goto(`${BASE}/trade-in?draft=${encodeURIComponent(comboDraft)}&step=offer`, { waitUntil: 'domcontentloaded' });
      await visible(page.locator('[data-trade-in-send]'), 30000);
      await settle(page, 800);
      await page.locator('[data-trade-in-send]').first().click();
      await page.waitForURL(/request=/, { timeout: 30000 }).catch(() => {});
    }
    await s.ctx.close();
  }
  {
    current = '7-narrow-intake';
    const sent = one("SELECT id FROM trade_in_requests WHERE status = 'submitted' AND intake_at IS NULL ORDER BY created_at DESC LIMIT 1")?.id ?? null;
    check('the Combo was sent at 360 px', !!sent, sent);
    const s = await session(ASSIST, { size: NARROW });
    await s.page.goto(`${BASE}/admin?tab=trade_in`, { waitUntil: 'domcontentloaded' });
    check('phone360: the desk queue', await visible(s.page.locator('[data-trade-in-queue]'), 30000));
    await settle(s.page);
    await noSideScroll(s.page, 'phone360 desk queue');
    if (sent && (await visible(s.page.locator(`[data-row="${sent}"]`), 20000))) {
      await s.page.locator(`[data-row="${sent}"]`).first().click();
      check('phone360: the intake sheet opens', await visible(s.page.locator('[data-intake-sheet]'), 20000));
      await settle(s.page);
      await noSideScroll(s.page, 'phone360 intake sheet');
      check('phone360: «سجّل الاستلام» waits for the hours read off the device', !(await s.page.locator('[data-intake-submit]').first().isEnabled()));
      await shot(s.page, 'phone360-a1-intake');
    }
    await s.ctx.close();
  }
} catch (e) {
  failHard(e);
} finally {
  current = 'teardown';
  check('no request left the local host', results.blocked.length === 0, results.blocked.slice(0, 10));
  check('no page error', results.page_errors.length === 0, results.page_errors.slice(0, 10));
  await browser.close().catch(() => {});
  stopDev();
  results.finished_at = new Date().toISOString();
  results.checks = checks;
  results.request_id = requestId;
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${results.failures.length ? 'FAILED' : 'PASSED'}: ${checks} checks, ${results.failures.length} failures. Results: ${join(OUT, 'results.json')}`);
  process.exitCode = results.failures.length ? 1 : 0;
}
