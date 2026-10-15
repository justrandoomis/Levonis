#!/usr/bin/env node
/**
 * CATALOG-ONLY PRODUCTS AND «طلب السعر», END TO END IN A REAL BROWSER
 * (DECISIONS rows 239 (3)-(4) and 240; spec §7.6).
 *
 * The real built SPA, the real Worker under `wrangler dev --local` and a real
 * local D1 at the newest migration (0193), seeded by
 * scripts/lib/e2e-catalog-only-seed.ts with the server suite's own fixtures:
 * the live catalogue published through the real V2 writer, the invented
 * catalog-only «Levo E2E Catalog Printer» (2 models × 2 colours, every money
 * column on a legacy SENTINEL) and «Levo E2E Partial Printer» (four priced
 * SKUs and a Jade colour added after publication, whose SKUs have no price).
 *
 *   1  GUEST. The category page shows the priced printers first, then the
 *      catalog-only one with «السعر غير متوفر حالياً» — no number, no stock
 *      word, no «مجاني». Its page shows the options, colours and specs and no
 *      buying control.
 *   2  «طلب السعر» SIGNED OUT → the sign-in sheet → /auth?next=…&price_request
 *      → signed in, back on the page with the SAME selection pre-chosen and
 *      nothing sent → tap → «طلبت السعر»; a reload keeps it; withdraw → back.
 *   3  A SECOND CUSTOMER asks for the same SKU and the first re-taps through
 *      the door (repeat): the owner's queue shows «شخصان طلبا السعر», first.
 *   4  PER SKU. The partial printer sells Black / White and shows the label,
 *      «بلا سعر» and «طلب السعر» for Jade only — never another SKU's price,
 *      not even while Jade is chosen and the model is not.
 *   5  THE CART REFUSES IT. The door answers 409 PRICE_NOT_AVAILABLE, and an
 *      old cart line reads that refusal's sentence with no number.
 *   6  ENGLISH AND SORANI: the card, the page, «طلب السعر» and the requested
 *      state in en and ckb (and never the Arabic in a ckb slot).
 *   7  THE PRICE ARRIVES. The owner's «تحديد السعر» opens the product form;
 *      the real V2 writer publishes the printer (the e2e stops the Worker
 *      around it, the browser publish is scripts/e2e-pricing-v2-clean-start.mjs's),
 *      the quarter-hour tick runs through miniflare's /cdn-cgi/handler/scheduled,
 *      and the consenting customer's bell says «صار السعر متوفراً» while the
 *      page sells.
 * Screens at 390×844 and 1280×900, light and dark, in OUT_DIR/shots.
 *
 * LOCAL ONLY. The Worker listens on 127.0.0.1; every browser request to any
 * other host is aborted and counted, and the run fails unless that count is 0
 * and no page or console error was thrown. No live site, no production
 * database: the database is a fresh `--persist-to` directory this script
 * creates. Each person signs in once (the login door is rate limited); the
 * session cookie is reused. A Worker that dies under the run (the machine is
 * shared) is started again on the same database and reported.
 *
 * How to run (one heavy process — run it alone; ~10 minutes):
 *   npm run build
 *   OUT_DIR=/tmp/e2e-catalog-only node scripts/e2e-catalog-only.mjs
 *
 * Env: OUT_DIR (results.json, shots/, the wrangler log, the persist dir),
 * SHOTS_DIR (the screens elsewhere), PORT (default 8853), CHROMIUM_PATH,
 * PLAYWRIGHT_MODULE, KEEP_DEV=1.
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
const OUT = process.env.OUT_DIR || '/tmp/e2e-catalog-only';
const SHOTS = process.env.SHOTS_DIR || join(OUT, 'shots');
const PERSIST = join(OUT, 'persist');
const WRANGLER = process.env.WRANGLER || join(ROOT, 'node_modules/.bin/wrangler');
if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('dist/ is missing: run `npm run build` first');
mkdirSync(SHOTS, { recursive: true });

const OWNER = { id: 'u_e2e_owner', email: 'owner@levonis.test', password: 'owner-e2e-pass-1' };
const BUYER = { id: 'u_e2e_buyer', email: 'buyer@levonis.test', password: 'buyer-e2e-pass-1' };
const BUYER2 = { id: 'u_e2e_buyer2', email: 'buyer2@levonis.test', password: 'buyer2-e2e-pass-1' };
const UNPRICED = { ar: 'السعر غير متوفر حالياً', en: 'Price not available yet', ckb: 'نرخ هێشتا بەردەست نییە' };
const REQUEST = { ar: 'طلب السعر', en: 'Request price', ckb: 'داوای نرخ بکە' };
const REQUESTED = { ar: 'طلبت السعر', en: 'Price requested', ckb: 'داوای نرخت کردووە' };

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

/** Every migration the way D1 applies it (one transaction each, bookkeeping in d1_migrations). */
function applyMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    db.exec('BEGIN');
    try {
      for (const s of splitStatements(readFileSync(join(ROOT, 'migrations', f), 'utf8'))) db.exec(s);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`${f}: ${e.message}`);
    }
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
  }
  return files;
}

function passwordHash(password) {
  const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const salt = randomBytes(16);
  return `pbkdf2$100000$${b64url(salt)}$${b64url(pbkdf2Sync(password, salt, 100000, 32, 'sha256'))}`;
}

/** Real WebP pictures in the local public bucket, and the rows that name them. */
async function seedPictures(dbFile, ids, names) {
  const sharp = createRequire(join(ROOT, 'package.json'))('sharp');
  const dir = join(OUT, 'media');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  const palette = ['#1f3a5f', '#3f6b3a', '#6b3a5f', '#5f4b1f', '#1f5f5a', '#4a4a6b'];
  try {
    for (const [i, id] of ids.entries()) {
      const key = `products/${id}/main.webp`;
      const label = (names[id] ?? id).slice(0, 26).replace(/[<&>]/g, '');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="${palette[i % palette.length]}"/><rect x="230" y="220" width="340" height="300" rx="28" fill="#ffffff" fill-opacity="0.16"/><text x="400" y="640" font-size="44" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${label}</text></svg>`;
      const file = join(dir, `${id}.webp`);
      writeFileSync(file, await sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer());
      execFileSync(WRANGLER, ['r2', 'object', 'put', `levonis-media-public/${key}`, '--file', file, '--content-type', 'image/webp', '--local', '--persist-to', PERSIST], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
      });
      db.prepare('DELETE FROM product_images WHERE product_id = ?').run(id);
      db.prepare('UPDATE products SET images = ? WHERE id = ?').run(
        JSON.stringify([{ id: `img_${id}`, url: `/files/${key}`, key, role: 'gallery', alt_ar: '', alt_en: names[id] ?? '', alt_ckb: '', order: 0, primary: true }]),
        id
      );
      db.prepare("INSERT INTO product_images (id, product_id, url, r2_key, alt_en, sort_order, is_primary, content_type) VALUES (?, ?, ?, ?, ?, 0, 1, 'image/webp')").run(
        `img_${id}`,
        id,
        `/files/${key}`,
        key,
        names[id] ?? ''
      );
    }
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ checks and results

const results = { started_at: new Date().toISOString(), base: BASE, cases: {}, blocked: [], page_errors: [], console_errors: [], failures: [], shots: [], dev_exits: [] };
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
/** A legacy sentinel in a text, as digits with or without thousands separators. */
function legacyHits(text, numbers) {
  return numbers.filter((n) => text.includes(String(n)) || text.includes(n.toLocaleString('en-US')));
}

// ------------------------------------------------------------------ the dev server

let dev = null;
let devStarts = 0;
/** The pending restart after the Worker died under the run (null when none). */
let devReady = null;
async function startDev() {
  devStarts += 1;
  const log = createWriteStream(join(OUT, `wrangler-dev${devStarts > 1 ? `-${devStarts}` : ''}.log`));
  dev = spawn(
    WRANGLER,
    [
      'dev',
      '--local',
      '--persist-to',
      PERSIST,
      '--ip',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--var',
      `INITIAL_ADMIN_EMAIL:${OWNER.email}`,
      // The quarter-hour tick on demand at /cdn-cgi/handler/scheduled (scenario 7), local only.
      '--test-scheduled',
      '--show-interactive-dev-session=false',
    ],
    // detached: wrangler and its workerd child form one process group, so a stop (or a crash) takes both.
    {
      cwd: ROOT,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_UPDATE_NOTIFIER: '1', WRANGLER_LOG: process.env.WRANGLER_LOG || 'log' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  );
  const mine = dev;
  mine.on('exit', (code, signal) => {
    if (mine.stopping) return;
    // Started again on the same persisted database once the dead one's workerd has let go of the port.
    results.dev_exits.push(`${current}: wrangler dev exited (code ${code}, signal ${signal}); started again`);
    killGroup(mine, 'SIGKILL');
    if (dev === mine) devReady = portFree().then(() => startDev());
  });
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
/** The whole group (wrangler and workerd); a no-op once it is gone. */
function killGroup(d, signal) {
  try {
    process.kill(-d.pid, signal);
  } catch {
    /* already gone */
  }
}
/** Waits until nothing answers on the port. */
async function portFree() {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/settings/public`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
function stopDev() {
  if (dev && !process.env.KEEP_DEV) {
    dev.stopping = true;
    killGroup(dev, 'SIGINT');
    dev = null;
  }
}
/** Stops the Worker and waits until the port is free (the database file is then the script's alone). */
async function stopDevAndWait() {
  const d = dev;
  if (!d) return;
  d.stopping = true;
  const gone = new Promise((r) => d.once('exit', r));
  killGroup(d, 'SIGINT');
  dev = null;
  await Promise.race([gone, new Promise((r) => setTimeout(r, 15000))]);
  killGroup(d, 'SIGKILL');
  await portFree();
}
/**
 * The machine is shared: a Worker that died under the run (another process's
 * cleanup, a workerd crash) is started again on the same persisted database,
 * and the restart is recorded in results.dev_exits.
 */
async function ensureDev() {
  if (devReady) {
    await devReady;
    devReady = null;
  }
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/settings/public`)).status < 500) return;
    } catch {
      /* dying or restarting */
    }
    await new Promise((r) => setTimeout(r, 250));
    if (devReady) {
      await devReady;
      devReady = null;
    }
  }
  if (!dev || dev.exitCode !== null || dev.signalCode !== null) await startDev();
}

// ------------------------------------------------------------------ the browser

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const VIEW = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } };

/** A browser session for one person (null: a guest). Every non-local request is aborted and counted. */
async function session(who, { view = 'desktop', lang = 'ar', theme = 'light' } = {}) {
  await ensureDev();
  const ctx = await browser.newContext({
    viewport: VIEW[view],
    deviceScaleFactor: 1,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
    serviceWorkers: 'block',
    hasTouch: view === 'phone',
    isMobile: view === 'phone',
    colorScheme: theme,
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
    ([l, t]) => {
      try {
        localStorage.setItem('levo_lang', l); // src/LanguageContext.tsx
        localStorage.setItem('levonis.theme.v1', t); // src/lib/theme.ts THEME_STORAGE_KEY
      } catch {
        /* storage blocked */
      }
    },
    [lang, theme]
  );
  const page = await ctx.newPage();
  // A context closes only once its page has gone quiet: nothing is cut off mid-flight in the Worker.
  const closeCtx = ctx.close.bind(ctx);
  ctx.close = async (...a) => {
    await settle(page, 500, 8000).catch(() => {});
    return closeCtx(...a);
  };
  page.on('pageerror', (e) => results.page_errors.push(`${current}: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // A refused API call logs its status line; the run checks those answers itself.
    if (/Failed to load resource/.test(t)) return;
    results.console_errors.push(`${current}: ${t.slice(0, 300)}`);
  });
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
  // One sign-in per person for the whole run (the login door is rate limited): its cookies are reused.
  if (who && cookieJar.has(who.email)) await ctx.addCookies(cookieJar.get(who.email));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  // The home page's own reads finish before the first visit, so none is cut off mid-flight.
  await settle(page, 700);
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
  if (who) {
    const whoAmI = async () => (cookieJar.has(who.email) ? api('GET', '/api/auth/me') : null);
    let me = null;
    try {
      me = await whoAmI();
    } catch {
      await ensureDev();
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      me = await whoAmI();
    }
    if (me?.body?.user?.email !== who.email) await signIn(page, who);
  }
  return { ctx, page, api, answers };
}
const cookieJar = new Map();
async function signIn(page, who) {
  await ensureDev();
  const login = await page.request.post(`${BASE}/api/auth/login`, { data: { identifier: who.email, password: who.password }, headers: { Origin: BASE } });
  if (login.status() !== 200) throw new Error(`sign-in ${who.email}: ${login.status()} ${(await login.text()).slice(0, 200)}`);
  // Every cookie, not `cookies(BASE)`: the session cookie is Secure and a URL filter on http drops it.
  cookieJar.set(who.email, (await page.context().cookies()).filter((c) => c.name === 'levonis_session'));
}

/** Waits until no request has been made for `quietMs`. */
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
async function shot(page, name, fullPage = false) {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage }).catch((e) => console.log(`  (screenshot ${name}: ${e.message})`));
  results.shots.push(path);
}
/** No horizontal scroll at this width. */
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function visit(page, path) {
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    // The Worker died under the run: once more, after it is back.
    if (!/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/.test(String(e))) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    await ensureDev();
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  }
  await settle(page, 1100);
}
const bodyText = (page) => page.locator('body').innerText();
/** A chooser chip by its exact visible label (option and colour names are English in every language). */
const chipOf = (page, label) => page.locator('button.lv-choice:visible').filter({ has: page.getByText(label, { exact: true }) }).first();
/** Makes sure the chip is chosen: a chip is a toggle, and the page may have pre-chosen it (initial_selection). */
async function choose(page, label) {
  const chip = chipOf(page, label);
  await chip.scrollIntoViewIfNeeded().catch(() => {});
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  await page.waitForTimeout(350);
}
/** Makes sure the chip is NOT chosen. */
async function unchoose(page, label) {
  const chip = chipOf(page, label);
  await chip.scrollIntoViewIfNeeded().catch(() => {});
  if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
  await page.waitForTimeout(350);
}

// ================================================================== run
const failHard = (e) => {
  results.failures.push(`[${current}] crashed: ${e?.stack ?? e}`);
  console.error(e);
};
let W = null;
let dbFile = '';
try {
  current = 'setup';
  dbFile = initLocalD1();
  {
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA foreign_keys = ON');
    const files = applyMigrations(db);
    check('the database stands at the newest migration (0193 price requests)', files.at(-1)?.startsWith('0193'), files.at(-1));
    const now = '2026-10-15T09:00:00.000Z';
    for (const [u, role, name] of [
      [OWNER, 'admin', 'مالك ليفونيس'],
      [BUYER, 'customer', 'زبون التجربة'],
      [BUYER2, 'customer', 'زبون ثانٍ'],
    ]) {
      // onboarding_state 'done': the one-time «أكمل ملفك الشخصي» sheet is not what this run looks at.
      db.prepare(
        `INSERT INTO users (id, email, username, name, password_hash, role, locale, email_verified_at, onboarding_state) VALUES (?, ?, ?, ?, ?, ?, 'ar', ?, 'done')`
      ).run(
        u.id,
        u.email,
        u.id.replace('u_', ''),
        name,
        passwordHash(u.password),
        role,
        now
      );
    }
    db.close();
  }
  W = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/lib/e2e-catalog-only-seed.ts'), dbFile], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').at(-1));
  check('the seed priced the live catalogue through the real V2 writer', W.priced > 10, W.priced);
  {
    const db = new DatabaseSync(dbFile);
    const names = Object.fromEntries(db.prepare('SELECT id, name FROM products').all().map((r) => [r.id, String(r.name).split(' / ')[0]]));
    // An old cart line of the catalog-only printer (it was in a cart before the clean start).
    db.prepare(
      `INSERT INTO cart_items (id, user_id, product_id, option_id, color_id, option_value_ids, fulfillment_type, qty) VALUES ('ci_e2e_cat', ?, ?, ?, ?, ?, 'direct_sale', 1)`
    ).run(BUYER.id, W.catalog.id, W.catalog.sel.std, W.catalog.sel.grey, JSON.stringify([W.catalog.sel.std]));
    db.close();
    await seedPictures(dbFile, [W.catalog.id, W.partial.id, ...W.printers.filter((id) => id !== W.catalog.id && id !== W.partial.id).slice(0, 6)], names);
  }
  await startDev();
  check('wrangler dev answers on 127.0.0.1', true, BASE);
  const catKey = `o:${W.catalog.sel.std}|c:${W.catalog.sel.grey}`;

  // ---------------------------------------------------------------- 1. the guest: category page and product page
  current = '1-guest';
  for (const view of ['phone', 'desktop']) {
    for (const theme of ['light', 'dark']) {
      const guest = await session(null, { view, theme });
      await visit(guest.page, `/categories/${W.category_slug}`);
      const card = guest.page.locator('[data-product-card]').filter({ hasText: W.catalog.name }).first();
      await card.scrollIntoViewIfNeeded().catch(() => {});
      const cardText = (await card.innerText().catch(() => '')).trim();
      if (view === 'phone' && theme === 'light') {
        check('the category page shows the catalog-only printer', cardText.includes(W.catalog.name), cardText.slice(0, 120));
        check('…with «السعر غير متوفر حالياً» and no number', cardText.includes(UNPRICED.ar) && !/[0-9٠-٩]{2,}/.test(cardText.replace(/E2E/g, '')), cardText);
        check('…no stock word and no «مجاني» / «0 د.ع»', !/نفد|غير متوفر الآن|متوفر الآن|مجاني|0 د\.ع/.test(cardText.replace(UNPRICED.ar, '')), cardText);
        const order = await guest.page.locator('[data-product-card]').evaluateAll((els) => els.map((e) => (e.querySelector('[data-price-status="unpriced"]') ? 'u' : 'p')).join(''));
        check('priced cards come first, catalog-only after (rule R1)', /^p+u+$/.test(order), order);
        const all = await bodyText(guest.page);
        check('no legacy sentinel anywhere on the page', legacyHits(all, W.legacy).length === 0, legacyHits(all, W.legacy));
      }
      check(`${view}/${theme}: no horizontal scroll on the category page`, await noSideScroll(guest.page));
      await shot(guest.page, `1-category-${view}-${theme}`);
      if (cardText) {
        await card.scrollIntoViewIfNeeded().catch(() => {});
        await shot(guest.page, `1-category-card-${view}-${theme}`);
      }

      await visit(guest.page, `/product/${W.catalog.slug}`);
      const text = await bodyText(guest.page);
      if (view === 'phone' && theme === 'light') {
        check('the product page states «السعر غير متوفر حالياً» and the browse sentence', text.includes(UNPRICED.ar) && text.includes('يمكنك تصفّح المنتج الآن'));
        check('…shows its options and colours', text.includes('H2D Combo') && text.includes('Grey') && text.includes('White'));
        check('…and no buying control: no add to cart, no quantity, no «طريقة التوفر»', !/أضف إلى السلة|سجّل الدخول للشراء/.test(text) && (await guest.page.locator('[data-fulfilment-chooser]').count()) === 0);
        check('…no «وجدتها بمكان أرخص» and no sales-mode chip', !text.includes('وجدتها بمكان أرخص') && !/بيع مباشر/.test(await guest.page.locator('[data-product-signals]').first().innerText().catch(() => '')));
        check('…and no legacy sentinel', legacyHits(text, W.legacy).length === 0, legacyHits(text, W.legacy));
        const cta = guest.page.locator('[data-price-request-bar] [data-price-request-cta]');
        check('the phone bar holds «طلب السعر», waiting for the choice (aria-disabled)', (await cta.count()) === 1 && (await cta.getAttribute('aria-disabled')) === 'true');
      }
      check(`${view}/${theme}: no horizontal scroll on the product page`, await noSideScroll(guest.page));
      await shot(guest.page, `1-product-${view}-${theme}`);
      if (view === 'desktop') await shot(guest.page, `1-product-${view}-${theme}-full`, true);
      await guest.ctx.close();
    }
  }

  // ---------------------------------------------------------------- 2. «طلب السعر» signed out → sign in → requested → withdraw
  current = '2-request';
  {
    const g = await session(null, { view: 'phone' });
    await visit(g.page, `/product/${W.catalog.slug}`);
    await choose(g.page, 'H2D');
    await choose(g.page, 'Grey');
    const cta = g.page.locator('[data-price-request-bar] [data-price-request-cta]');
    check('with the model and colour chosen the button is live (signed out)', (await cta.getAttribute('data-price-request-cta')) === 'signed_out' && (await cta.getAttribute('aria-disabled')) === null);
    const before = g.answers.length;
    await cta.click();
    const sheet = g.page.locator('[data-overlay="price-request-signin"]');
    await sheet.waitFor({ timeout: 10000 }).catch(() => {});
    await g.page.waitForTimeout(500);
    const sheetText = await sheet.innerText().catch(() => '');
    check('the sign-in sheet opens with «سجّل الدخول لطلب السعر»', sheetText.includes('سجّل الدخول لطلب السعر') && sheetText.includes('نحسب كل شخص مرة واحدة'), sheetText.slice(0, 200));
    check('…and nothing was sent', !g.answers.slice(before).some((a) => a.method === 'POST' && a.path.startsWith('/api/price-requests')));
    await shot(g.page, '2-signin-sheet-phone-light');
    await g.page.locator('[data-price-request-signin]').click();
    await g.page.waitForURL(/\/auth\?/, { timeout: 15000 }).catch(() => {});
    const authUrl = new URL(g.page.url());
    const next = authUrl.searchParams.get('next') ?? '';
    check('/auth carries the selection home in ?next=…price_request=', authUrl.pathname === '/auth' && next.includes(`price_request=${encodeURIComponent(catKey)}`), g.page.url());
    await signIn(g.page, BUYER);
    await visit(g.page, next);
    const chosen = await g.page.evaluate(() => [...document.querySelectorAll('button.lv-choice[aria-pressed="true"]')].map((b) => b.textContent?.trim()));
    check('back on the page the same model and colour are chosen', chosen.some((t) => t?.startsWith('H2D') && !t.includes('Combo')) && chosen.some((t) => t?.startsWith('Grey')), chosen);
    check('…the parameter left the URL (replace)', !g.page.url().includes('price_request='), g.page.url());
    check('…and still nothing was sent', !g.answers.some((a) => a.method === 'POST' && a.path.startsWith('/api/price-requests')));
    const sw = g.page.locator('[data-price-request] [role="switch"]');
    check('signed in: the notify switch is visible and ON before the first tap', (await sw.count()) === 1 && (await sw.getAttribute('aria-checked')) === 'true');
    await shot(g.page, '2-ready-phone-light');
    await g.page.locator('[data-price-request-bar] [data-price-request-cta]').click();
    await g.page.locator('[data-price-request="requested"]').waitFor({ timeout: 10000 }).catch(() => {});
    const post = g.answers.find((a) => a.method === 'POST' && a.path === '/api/price-requests');
    check('one tap = one POST, which the server answers open', post?.status === 200 && JSON.parse(post.text)?.request?.state === 'open', post?.text?.slice(0, 200));
    check('«طلبت السعر» replaces the button', (await g.page.locator('[data-price-request="requested"]').count()) === 1 && (await bodyText(g.page)).includes(REQUESTED.ar));
    await g.page.waitForTimeout(600); // the switch's own transition
    await shot(g.page, '2-requested-phone-light');
    await visit(g.page, `/product/${W.catalog.slug}`);
    await choose(g.page, 'H2D');
    await choose(g.page, 'Grey');
    await g.page.locator('[data-price-request="requested"]').waitFor({ timeout: 10000 }).catch(() => {});
    check('a reload keeps «طلبت السعر» (the caller’s own rows)', (await g.page.locator('[data-price-request="requested"]').count()) === 1);
    await g.page.locator('[data-price-request-withdraw]').click();
    await g.page.locator('[data-price-request="ready"]').waitFor({ timeout: 10000 }).catch(() => {});
    check('«سحب الطلب» → back to the button', (await g.page.locator('[data-price-request="ready"]').count()) === 1);
    // Ask again for the queue (the server reopens the same row).
    await g.page.locator('[data-price-request-bar] [data-price-request-cta]').click();
    await g.page.locator('[data-price-request="requested"]').waitFor({ timeout: 10000 }).catch(() => {});
    check('…and asking again reopens it', (await g.page.locator('[data-price-request="requested"]').count()) === 1);
    await g.ctx.close();
    for (const theme of ['dark']) {
      const s = await session(BUYER, { view: 'phone', theme });
      await visit(s.page, `/product/${W.catalog.slug}`);
      await choose(s.page, 'H2D');
      await choose(s.page, 'Grey');
      await s.page.locator('[data-price-request="requested"]').waitFor({ timeout: 10000 }).catch(() => {});
      await shot(s.page, `2-requested-phone-${theme}`);
      await s.ctx.close();
    }
    for (const theme of ['light', 'dark']) {
      const s = await session(BUYER, { view: 'desktop', theme });
      await visit(s.page, `/product/${W.catalog.slug}`);
      await choose(s.page, 'H2D');
      await choose(s.page, 'Grey');
      await s.page.locator('[data-price-request="requested"]').waitFor({ timeout: 10000 }).catch(() => {});
      check(`desktop/${theme}: the request, still open, sits in the price card`, (await s.page.locator('aside [data-price-status="unpriced"] [data-price-request="requested"]').count()) === 1);
      if (theme === 'light') check('…where the status line replaces the button (no second «طلبت السعر»)', (await s.page.locator('aside [data-price-request-done]').count()) === 0);
      await shot(s.page, `2-requested-desktop-${theme}`);
      await s.ctx.close();
    }
  }

  // ---------------------------------------------------------------- 3. a second customer; the first re-taps; the owner's queue
  current = '3-queue';
  {
    const b2 = await session(BUYER2, { view: 'phone' });
    const r2 = await b2.api('POST', '/api/price-requests', { product_id: W.catalog.id, option_value_ids: [W.catalog.sel.std], color_id: W.catalog.sel.grey, notify: true });
    check('a second customer asks the same SKU', r2.status === 200 && r2.body?.repeat === false, r2.text.slice(0, 200));
    const r2b = await b2.api('POST', '/api/price-requests', { product_id: W.catalog.id, option_value_ids: [W.catalog.sel.combo], color_id: W.catalog.sel.white, notify: false });
    check('…and another selection of it', r2b.status === 200, r2b.text.slice(0, 200));
    await b2.ctx.close();
    const b1 = await session(BUYER, { view: 'phone' });
    const again = await b1.api('POST', '/api/price-requests', { product_id: W.catalog.id, option_value_ids: [W.catalog.sel.std], color_id: W.catalog.sel.grey, notify: true });
    check('the first customer re-taps through the door: a repeat, never a second person', again.status === 200 && again.body?.repeat === true, again.text.slice(0, 200));
    const p1 = await b1.api('POST', '/api/price-requests', { product_id: W.partial.id, option_value_ids: [W.partial.values.basic], color_id: W.partial.colors.jade, notify: true });
    check('the partial printer’s Jade SKU can be requested', p1.status === 200, p1.text.slice(0, 200));
    await b1.ctx.close();
    for (const [view, theme] of [
      ['desktop', 'light'],
      ['desktop', 'dark'],
      ['phone', 'light'],
    ]) {
      const owner = await session(OWNER, { view, theme });
      await visit(owner.page, '/admin?tab=products&view=needs-pricing');
      await owner.page.locator('[data-needs-pricing-queue]').first().waitFor({ timeout: 20000 }).catch(() => {});
      await settle(owner.page, 1000);
      const first = owner.page.locator('[data-queue-product]').first();
      const firstText = await first.innerText().catch(() => '');
      if (view === 'desktop' && theme === 'light') {
        check('the queue opens with the most requested product first', (await first.getAttribute('data-queue-product')) === W.catalog.id, firstText.slice(0, 160));
        check('…saying «شخصان طلبا السعر» and «آخر طلب»', firstText.includes('شخصان طلبا السعر') && firstText.includes('آخر طلب'), firstText);
        check('…with «تحديد السعر» as its action', (await first.locator(`[data-queue-open="${W.catalog.id}"]`).innerText().catch(() => '')).includes('تحديد السعر'));
        const sel = first.locator('[data-queue-selections]');
        if (await sel.count()) await sel.locator('summary').click();
        await owner.page.waitForTimeout(300);
        const selText = await sel.innerText().catch(() => '');
        check('the per-selection counts fold under the row', selText.includes('H2D') && /شخصان طلبا السعر|شخص واحد طلب السعر/.test(selText), selText);
        await owner.page.locator('[data-queue-filter="most_requested"]').click();
        await settle(owner.page, 900);
        const rowsShown = await owner.page.locator('[data-queue-product]').count();
        check('«الأكثر طلباً» lists only products somebody asked about', rowsShown === 1, rowsShown);
        await owner.page.locator('[data-queue-filter="all"]').click();
        await settle(owner.page, 900);
      }
      check(`${view}/${theme}: no horizontal scroll on the queue`, await noSideScroll(owner.page));
      await shot(owner.page, `3-queue-${view}-${theme}`);
      if (view === 'desktop') {
        await visit(owner.page, '/admin?tab=products');
        const sortSel = owner.page.locator('select').filter({ has: owner.page.locator('option[value="requests"]') }).first();
        await sortSel.selectOption('requests').catch(() => {});
        await settle(owner.page, 1000);
        const chip = owner.page.locator('[data-price-requests]').first();
        await chip.scrollIntoViewIfNeeded().catch(() => {});
        await owner.page.waitForTimeout(300);
        if (theme === 'light') {
          check('the products list sorts by requests with a «طلبات السعر: N» chip', (await chip.count()) > 0 && (await chip.innerText()).includes('طلبات السعر'), await chip.innerText().catch(() => ''));
          const chips = await owner.page.locator('[data-price-requests]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-price-requests'))));
          check('…in descending order', chips.every((n, i) => i === 0 || chips[i - 1] >= n), chips);
        }
        await shot(owner.page, `3-products-list-requests-${theme}`);
      }
      await owner.ctx.close();
    }
  }

  // ---------------------------------------------------------------- 4. per SKU: the partial printer
  current = '4-partial';
  for (const view of ['phone', 'desktop']) {
    for (const theme of ['light', 'dark']) {
      const s = await session(BUYER, { view, theme });
      await visit(s.page, `/product/${W.partial.slug}`);
      await choose(s.page, 'Basic');
      await choose(s.page, 'Black');
      await settle(s.page, 900);
      const pricedText = await bodyText(s.page);
      if (view === 'phone' && theme === 'light') {
        check('a priced SKU shows its price and the cart button', /د\.ع|IQD/.test(pricedText) && /أضف إلى السلة/.test(pricedText) && !pricedText.includes(UNPRICED.ar), pricedText.slice(0, 300));
        check('…and Jade wears «بلا سعر» in the chooser, never disabled', (await s.page.locator('[data-no-price]').count()) >= 1 && (await s.page.locator('button.lv-choice:disabled').count()) === 0);
      }
      await shot(s.page, `4-partial-priced-${view}-${theme}`);
      await choose(s.page, 'Jade');
      await settle(s.page, 900);
      const text = await bodyText(s.page);
      if (view === 'phone' && theme === 'light') {
        check('Jade: the label, the selection sentence and «طلب السعر» for this SKU only', text.includes(UNPRICED.ar) && text.includes('هذا الاختيار بلا سعر بعد'), text.slice(0, 400));
        check('…already requested by this customer: «طلبت السعر»', (await s.page.locator('[data-price-request="requested"]').count()) === 1);
        check('…no cart button and no price figure for it', !/أضف إلى السلة|د\.ع/.test(await s.page.locator('[data-testid="product-buybar"]').innerText()));
        await unchoose(s.page, 'Basic');
        await settle(s.page, 900);
        const half = await s.page.locator('[data-price-status="unpriced"]').first().innerText().catch(() => '');
        check('Jade with no model chosen: still the label, no figure (every way to finish it is unpriced)', half.includes(UNPRICED.ar) && !/د\.ع|[0-9٠-٩]{3}/.test(half) && (await s.page.locator('[data-price-request="choose"]').count()) === 1, half);
        await shot(s.page, `4-partial-jade-no-model-${view}-${theme}`);
        await choose(s.page, 'Basic');
        await choose(s.page, 'White');
        await settle(s.page, 900);
        check('back on White: the price and the cart button return', /أضف إلى السلة/.test(await bodyText(s.page)) && !(await bodyText(s.page)).includes(UNPRICED.ar));
        await choose(s.page, 'Jade');
        await settle(s.page, 900);
      }
      check(`${view}/${theme}: no horizontal scroll on the partial printer`, await noSideScroll(s.page));
      await shot(s.page, `4-partial-jade-${view}-${theme}`);
      await s.ctx.close();
    }
  }

  // ---------------------------------------------------------------- 5. the cart refuses it
  current = '5-cart';
  for (const theme of ['light', 'dark']) {
    const s = await session(BUYER, { view: 'phone', theme });
    if (theme === 'light') {
      const add = await s.api('POST', '/api/cart/items', { productId: W.catalog.id, qty: 1, optionValueIds: [W.catalog.sel.std], colorId: W.catalog.sel.grey, fulfillmentType: 'direct_sale' });
      check('the cart door answers 409 PRICE_NOT_AVAILABLE', add.status === 409 && add.body?.code === 'PRICE_NOT_AVAILABLE', { status: add.status, code: add.body?.code });
      const quote = await s.api('POST', `/api/products/${W.catalog.slug}/quote`, { qty: 1, optionValueIds: [W.catalog.sel.std], colorId: W.catalog.sel.grey });
      check('the quote door answers 409 PRICE_NOT_AVAILABLE', quote.status === 409 && quote.body?.code === 'PRICE_NOT_AVAILABLE', { status: quote.status, code: quote.body?.code });
      const cart = await s.api('GET', '/api/cart');
      const line = (cart.body?.unavailable_lines ?? []).find((l) => l.product_id === W.catalog.id);
      check('the old cart line is unavailable with code PRICE_NOT_AVAILABLE', line?.code === 'PRICE_NOT_AVAILABLE', cart.body?.unavailable_lines);
      check('…and the cart answer carries no legacy sentinel', legacyHits(cart.text, W.legacy).length === 0);
    }
    await visit(s.page, '/cart');
    const text = await bodyText(s.page);
    if (theme === 'light') check('the cart page says the refusal’s sentence, with no number', text.includes('سعر هذا المنتج غير متوفر حالياً') && legacyHits(text, W.legacy).length === 0);
    await shot(s.page, `5-cart-phone-${theme}`);
    await s.ctx.close();
  }

  // ---------------------------------------------------------------- 6. English and Sorani
  current = '6-languages';
  for (const lang of ['en', 'ckb']) {
    for (const [view, theme] of [
      ['phone', 'light'],
      ['phone', 'dark'],
      ['desktop', 'light'],
      ['desktop', 'dark'],
    ]) {
      const tag = `${lang}-${view}-${theme}`;
      const guest = await session(null, { view, theme, lang });
      await visit(guest.page, `/categories/${W.category_slug}`);
      const card = guest.page.locator('[data-product-card]').filter({ hasText: W.catalog.name }).first();
      await card.scrollIntoViewIfNeeded().catch(() => {});
      const cardText = await card.innerText().catch(() => '');
      if (view === 'phone' && theme === 'light') {
        check(`${lang}: the card says «${UNPRICED[lang]}», no number`, cardText.includes(UNPRICED[lang]) && !cardText.includes(UNPRICED.ar) && !/[0-9٠-٩]{2,}/.test(cardText.replace(/E2E/g, '')), cardText);
      }
      await shot(guest.page, `6-category-card-${tag}`);
      await visit(guest.page, `/product/${W.catalog.slug}`);
      const text = await bodyText(guest.page);
      if (view === 'phone' && theme === 'light') {
        check(`${lang}: the page says «${UNPRICED[lang]}» and «${REQUEST[lang]}»`, text.includes(UNPRICED[lang]) && text.includes(REQUEST[lang]) && !text.includes(UNPRICED.ar) && !text.includes(REQUEST.ar));
      }
      check(`${tag}: no horizontal scroll on the product page`, await noSideScroll(guest.page));
      await shot(guest.page, `6-product-${tag}`);
      await guest.ctx.close();
      const s = await session(BUYER, { view, theme, lang });
      await visit(s.page, `/product/${W.catalog.slug}`);
      await choose(s.page, 'H2D');
      await choose(s.page, 'Grey');
      await s.page.locator('[data-price-request="requested"]').waitFor({ timeout: 10000 }).catch(() => {});
      const req = await s.page.locator('[data-price-request="requested"]').first().innerText().catch(() => '');
      if (view === 'phone' && theme === 'light') check(`${lang}: the requested state reads «${REQUESTED[lang]}»`, req.includes(REQUESTED[lang]), req);
      await shot(s.page, `6-requested-${tag}`);
      await s.ctx.close();
    }
  }

  // ---------------------------------------------------------------- 7. the price arrives
  current = '7-priced';
  {
    const owner = await session(OWNER, { view: 'desktop' });
    await visit(owner.page, '/admin?tab=products&view=needs-pricing');
    await owner.page.locator(`[data-queue-open="${W.catalog.id}"]`).first().click();
    await owner.page.locator('[data-form="save-bar"]').first().waitFor({ timeout: 30000 }).catch(() => {});
    await settle(owner.page, 1200);
    check('«تحديد السعر» opens the product form', (await owner.page.locator('[data-form="save-bar"]').count()) > 0, owner.page.url());
    await shot(owner.page, '7-owner-set-price-form-desktop-light');
    await owner.ctx.close();
    // The real V2 writer publishes the printer while the Worker is stopped (the database file is ours alone).
    await stopDevAndWait();
    const pub = JSON.parse(
      execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/lib/e2e-catalog-only-seed.ts'), dbFile, '--publish', W.catalog.id], { cwd: ROOT, encoding: 'utf8' })
        .trim()
        .split('\n')
        .at(-1)
    );
    check('the real V2 writer published the printer', pub.v2 === true, pub);
    await startDev();
    // The quarter-hour tick, on demand: miniflare's scheduled-handler route (local only).
    const tick = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('*/15 * * * *')}`);
    check('the quarter-hour tick ran', tick.status === 200, tick.status);
    let states = [];
    for (let i = 0; i < 40; i += 1) {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      states = db.prepare('SELECT user_id, selection, state, notify FROM product_price_requests WHERE product_id = ? ORDER BY user_id, selection').all(W.catalog.id);
      db.close();
      if (states.length && states.every((r) => r.state !== 'open')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check('the sweep moved every request of the printer on (notified or priced, none open)', states.length > 0 && states.every((r) => r.state !== 'open'), states);
    for (const [view, theme] of [
      ['phone', 'light'],
      ['phone', 'dark'],
      ['desktop', 'light'],
    ]) {
      const s = await session(BUYER, { view, theme });
      const notes = await s.api('GET', '/api/notifications');
      const note = (notes.body?.notifications ?? notes.body?.items ?? []).find((n) => n.kind === 'price_available' || n.type === 'price_available');
      if (view === 'phone' && theme === 'light') check('the consenting customer has «صار السعر متوفراً»', !!note && JSON.stringify(note).includes('صار السعر متوفراً'), notes.text.slice(0, 400));
      await visit(s.page, '/');
      const bell = s.page.locator('[data-notif="bell"]:visible').first();
      if (await bell.count()) {
        await bell.click();
        await s.page.locator('[data-notif="panel"]').first().waitFor({ timeout: 10000 }).catch(() => {});
        await settle(s.page, 700);
        const panel = await s.page.locator('[data-notif="panel"]').first().innerText().catch(() => '');
        if (view === 'phone' && theme === 'light') check('…and the bell shows it', panel.includes('صار السعر متوفراً'), panel.slice(0, 300));
        await shot(s.page, `7-bell-${view}-${theme}`);
      } else if (view === 'phone' && theme === 'light') {
        check('…and the bell is on the home page', false);
      }
      await visit(s.page, `/product/${W.catalog.slug}`);
      await choose(s.page, 'H2D');
      await choose(s.page, 'Grey');
      await settle(s.page, 900);
      const text = await bodyText(s.page);
      if (view === 'phone' && theme === 'light') {
        check('the printer now sells: a price and the cart button, no label', /د\.ع/.test(text) && /أضف إلى السلة/.test(text) && !text.includes(UNPRICED.ar), text.slice(0, 300));
        check('…and still no legacy sentinel', legacyHits(text, W.legacy).length === 0, legacyHits(text, W.legacy));
      }
      await shot(s.page, `7-product-priced-${view}-${theme}`);
      await s.ctx.close();
    }
  }
} catch (e) {
  failHard(e);
} finally {
  current = 'teardown';
  check('no request left the local host', results.blocked.length === 0, results.blocked.slice(0, 10));
  check('no page error', results.page_errors.length === 0, results.page_errors.slice(0, 10));
  check('no console error', results.console_errors.length === 0, results.console_errors.slice(0, 10));
  // Not a failure of the product: the machine is shared. Reported, and every check after it ran on a live Worker.
  if (results.dev_exits.length) console.log(`  note [teardown] the Worker was restarted ${results.dev_exits.length}× under the run: ${results.dev_exits.join(' | ')}`);
  await browser.close().catch(() => {});
  stopDev();
  results.finished_at = new Date().toISOString();
  results.checks = checks;
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${results.failures.length ? 'FAILED' : 'PASSED'}: ${checks} checks, ${results.failures.length} failures. Results: ${join(OUT, 'results.json')}`);
  process.exitCode = results.failures.length ? 1 : 0;
}
