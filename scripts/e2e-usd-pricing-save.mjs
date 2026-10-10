#!/usr/bin/env node
/**
 * «التسعير بالدولار والشحن» — WHAT THE OWNER TYPES IS KEPT (owner report 2026-10-10:
 * «بالرغم من كتابة التسعير بالدولار والشحن وملء الحقول فعند الضغط على كلمة نشر
 * والحفظ لا يحفظ وعند الرجوع إلى تعديل المنتج تبقى القيم فارغة»; docs/DECISIONS.md row 211).
 *
 * The browser regression of the fix: the real built SPA, the real worker and a
 * real local D1, in the three rate worlds the owner can be in —
 *   L  no approved FX rate (every pair holds its first value for review), no
 *      central shipping rate (the state the brief describes);
 *   B  the same FX state, plus the CHINA_SEA central rate (what the owner's
 *      screenshot shows live has);
 *   N  the rates approved (1 USD = 1,600 IQD, EUR/USD 1.1, CNY/USD 0.14) and
 *      CHINA_SEA at 400,000 IQD/CBM.
 * Each case creates the owner's product twin through the real admin API
 * (an invented printer shaped like the owner's: manual price 1,579,000, an invented legacy cost,
 * one OPTION group with one value, direct + sea pre-order, no colours), types
 * the owner's entry KEY BY KEY with Arabic-Indic digits and the Arabic decimal
 * key (USD, «٨٩٩٫٥», CHINA_SEA, box ٦٠ × ٥٢ × ٤٨ cm, extras ١٥٠٠٠, minimum
 * ١٢٠, Direct Sale Extra ٢٥٠٠٠), saves it the way the case says («نشر»,
 * «مسودة» or «حفظ التسعير بالدولار»), reloads, reopens «تعديل المنتج» and
 * checks every value on screen, in GET …/inputs and in the database — and the
 * store price, «التكلفة القديمة», the review sheet, the bar's status, the leave
 * warning and a phone width.
 *
 *   L1 «نشر» saves everything as data (PUT carries data_only); price, old cost and manual mode stay;
 *      the panel names the missing dollar rate with a link to «التسعير والشحن»; «دينار» is disabled
 *   L2 «مسودة» saves it too            L3 «حفظ التسعير بالدولار» alone saves it
 *   L4 «1,250»: said under the field, the save button says why it is disabled, «نشر» saves the
 *      product and the bar says the pricing was not saved with «اعرض» (which opens section ٣);
 *      nothing is stored; corrected to 1250 it is
 *   L5 «رجوع» with unsaved pricing asks first: dismiss stays, accept leaves
 *   B1 «دينار» disabled; the USD entry saved; the central gap (the dollar rate) named with the link
 *   N1 «نشر» stores the data and opens the review at the form's root (section ٨ closed);
 *      «لاحقًا — البيانات محفوظة» keeps the store price; after a reload the values and
 *      «راجع السعر الجديد واعتمده» are there
 *   N2 (same product) «راجع السعر الجديد واعتمده» → «حفظ»: the engine prices it; the old cost stays
 *   N3 «حفظ التسعير بالدولار» opens the review at once (section ٣ open, ٨ closed)
 *   P1 L1 at 390 px: same read-back, the bar's status readable
 *   — after the verifiers' round (2026-10-10) —
 *   L3 also: the box went to pricing only, and the panel and the reload's warning say the product's own
 *      box is not saved yet (F4)
 *   L6 a box corrected after an invalid «نشر» is the box pricing stores (F1)
 *   L7 the sidebar with unsaved pricing asks first: dismiss stays (value kept), accept leaves (F3)
 *   L8 «منتج جديد» knows no dollar rate is approved: «دينار» disabled and the banner shown (F2)
 *   N1 also: the review sheet's first line says the data is already saved, never the held write's intro
 *   N4 «منتج جديد» with «دينار»: the line under it says the rate the save converts at; «نشر» creates the
 *      product and stores the dinars converted at that rate with the rest (F2 / FX plan §12)
 *
 * LOCAL ONLY. BASE must be http://127.0.0.1:<port>; every request to any other
 * host is aborted and counted, and the run fails unless that count is 0 and no
 * page error was thrown. The worlds are applied in order L → B → N to ONE
 * fresh database (an approved rate cannot be un-approved), so PERSIST must be a
 * fresh --persist-to directory.
 *
 * How to run:
 *   npm run build
 *   P=$(mktemp -d)
 *   npx wrangler d1 migrations apply levonis-db --local --persist-to "$P"
 *   npx wrangler dev --local --persist-to "$P" --ip 127.0.0.1 --port 8841 --var INITIAL_ADMIN_EMAIL:owner@levonis.test
 *   BASE=http://127.0.0.1:8841 PERSIST="$P" node scripts/e2e-usd-pricing-save.mjs
 *
 * Env: OUT_DIR (screenshots and results/<case>.json; default /tmp/e2e-usd-pricing-save),
 * ONLY=L1,N1 (a subset, still in world order), CHROMIUM_PATH, PLAYWRIGHT_MODULE, WRANGLER.
 * Takes 6-8 minutes; one heavy process — run it alone.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEEDS = join(ROOT, 'scripts/e2e-usd-pricing-save');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.js');

const BASE = process.env.BASE || 'http://127.0.0.1:8841';
const LOCAL_HOST = new URL(BASE).host;
if (!/^127\.0\.0\.1:\d+$/.test(LOCAL_HOST) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)) throw new Error(`local only: BASE must be http://127.0.0.1:<port>, got ${BASE}`);
const PERSIST = process.env.PERSIST;
if (!PERSIST) throw new Error('PERSIST=<the wrangler dev --persist-to directory> is required (the local D1 the cases seed and read)');
const OUT = process.env.OUT_DIR || '/tmp/e2e-usd-pricing-save';
const RESULTS = join(OUT, 'results');
mkdirSync(RESULTS, { recursive: true });
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const WRANGLER = process.env.WRANGLER || join(ROOT, 'node_modules/.bin/wrangler');

const OWNER = { id: 'u_owner', email: 'owner@levonis.test', password: 'owner-e2e-pass-1' };
/** The words the checks look for (src/components/adminProducts/form/usdPricingStrings.ts, engineSaveStrings.ts — ar). */
const AR = {
  decimalSeparator: 'اكتب الكسر بنقطة (مثل 899.5)، ولا تفصل الآلاف بفاصلة',
  ratesNoUsd: 'لا يوجد سعر دولار معتمد بعد',
  currencyIqdNoRate: 'دينار — يحتاج سعر دولار معتمد',
  leaveUnsaved: 'في «التسعير بالدولار والشحن» تغييرات لم تُحفظ',
  later: 'لاحقًا — البيانات محفوظة',
  sheetDataSaved: 'بيانات التسعير محفوظة مسبقًا. الحفظ هنا لا يحفظها من جديد: يكتب الأسعار أدناه في المتجر فقط، و«لاحقًا» يُبقي سعر المتجر كما هو.',
  adoptIntro: 'هذا الحفظ يُكمل بيانات تسعير المنتج',
  measuresForPricingOnly: 'حُفظ قياس الصندوق أو الوزن للتسعير',
  iqdAtRate: 'يُحوَّل عند الحفظ بسعر الدولار المعتمد: 1600 د.ع للدولار',
  savedAdopted: 'حُفظ واعتُمد التسعير التلقائي وكُتبت الأسعار الجديدة',
  legacyCostStays: '«التكلفة القديمة» لا يغيّرها هذا القسم',
  routeFirst: 'اختر «مسار الشحن الأساسي» أولًا',
  centralMissing: 'ينقص من الإعدادات المركزية',
  fxMissing: 'سعر صرف',
};
const STORE_PRICE = 1_579_000;
/** Invented (never a live product's cost: this repository is public). */
const LEGACY_COST = 1_250_000;
const toArabic = (s) => String(s).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
/** The owner's entry, typed as the owner types it (Arabic-Indic digits, the Arabic decimal key «٫»). */
const ENTRY = { cost: '٨٩٩٫٥', box: { width: toArabic(60), depth: toArabic(52), height: toArabic(48) }, additional: toArabic(15000), minProfit: toArabic(120), dse: toArabic(25000) };
/** What the store must then hold, canonical (the box is L = depth, W, H in mm). */
const STORED = { supplier_cost_amount: '899.5', supplier_cost_currency: 'USD', shipping_profile: 'CHINA_SEA', shipping_length_mm: 520, shipping_width_mm: 600, shipping_height_mm: 480, additional_cost_iqd: 15000, minimum_target_profit_usd: '120', direct_sale_extra_iqd: 25000 };

// ------------------------------------------------------------------ the local database

/** One local D1 statement batch. The running worker holds the same SQLite file: a busy lock is waited out. */
function sql(command) {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execFileSync(WRANGLER, ['d1', 'execute', 'levonis-db', '--local', '--persist-to', PERSIST, '--json', `--command=${command}`], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
      });
      return JSON.parse(out);
    } catch (e) {
      if (attempt >= 6 || !/SQLITE_BUSY|database is locked/.test(`${e?.stdout ?? ''}${e?.stderr ?? ''}${e?.message ?? ''}`)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700 * attempt);
    }
  }
}
const rows = (command) => sql(command).at(-1)?.results ?? [];
/** A seed file's statements (its `--` comment lines dropped: the CLI would read one as an option). */
const seed = (file) => sql(readFileSync(join(SEEDS, file), 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n'));
const clearLoginLimits = () => sql("DELETE FROM rate_limits WHERE key LIKE '%login%'");

function seedOwner() {
  const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const salt = randomBytes(16);
  const hash = `pbkdf2$100000$${b64url(salt)}$${b64url(pbkdf2Sync(OWNER.password, salt, 100000, 32, 'sha256'))}`;
  sql(`INSERT INTO users (id, email, username, name, password_hash, role, locale, email_verified_at)
       VALUES ('${OWNER.id}', '${OWNER.email}', 'owner', 'مالك ليفونيس', '${hash}', 'admin', 'ar', '2026-10-01T00:00:00.000Z')
       ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', email_verified_at = excluded.email_verified_at`);
}

/** What the database holds for one product: its owner pricing rows, its state, its store price and legacy cost. */
function stored(pid) {
  const input = rows(`SELECT supplier_cost_amount, supplier_cost_currency, shipping_profile, shipping_length_mm, shipping_width_mm, shipping_height_mm, additional_cost_iqd FROM pricing_inputs WHERE product_id = '${pid}' AND origin = 'MANUAL_OVERRIDE' AND scope = 'base'`)[0] ?? null;
  const rules = rows(`SELECT kind, state, amount_usd, amount_iqd FROM pricing_rules WHERE product_id = '${pid}' AND scope = 'product'`);
  const state = rows(`SELECT mode FROM product_pricing_state WHERE product_id = '${pid}'`)[0] ?? null;
  const product = rows(`SELECT price_iqd, product_cost_iqd, status FROM products WHERE id = '${pid}'`)[0] ?? null;
  return {
    input,
    minimum_target_profit_usd: rules.find((r) => r.kind === 'target_profit' && r.state === 'ACTIVE')?.amount_usd ?? null,
    direct_sale_extra_iqd: rules.find((r) => r.kind === 'direct_sale_extra' && r.state === 'ACTIVE')?.amount_iqd ?? null,
    mode: state?.mode ?? 'manual',
    price_iqd: product?.price_iqd ?? null,
    product_cost_iqd: product?.product_cost_iqd ?? null,
    status: product?.status ?? null,
  };
}

// ------------------------------------------------------------------ the browser

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const blocked = [];
const pageErrors = [];
let checks = 0;
let passed = 0;
const failures = [];

async function newSession(caseName, width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, locale: 'ar-IQ', serviceWorkers: 'block', hasTouch: width < 600 });
  // LOCAL ONLY: every request that is not the local worker is aborted (and counted).
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    let host = '';
    try {
      host = new URL(u).host;
    } catch {
      /* data: and the like */
    }
    if (host === LOCAL_HOST || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    blocked.push(`${caseName}: ${u.slice(0, 160)}`);
    return route.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  const net = [];
  const dialogs = [];
  let onDialog = null;
  page.on('pageerror', (e) => pageErrors.push(`${caseName}: ${String(e).slice(0, 300)}`));
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (onDialog) return onDialog(d);
    // A beforeunload prompt on a reload means unsaved pricing was left behind: recorded, then accepted.
    return d.accept();
  });
  page.on('response', async (res) => {
    const req = res.request();
    const path = new URL(res.url()).pathname;
    if (!path.startsWith('/api/admin/pricing/') && !path.startsWith('/api/admin/products-v2')) return;
    let body = null;
    try {
      body = req.postData() ? JSON.parse(req.postData()) : null;
    } catch {
      body = null;
    }
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      /* not json */
    }
    net.push({ method: req.method(), path, status: res.status(), code: answer?.code ?? null, data_only: body?.data_only ?? null, has_hash: !!body?.preview_hash });
  });
  clearLoginLimits();
  const login = await page.request.post(`${BASE}/api/auth/login`, { data: { identifier: OWNER.email, password: OWNER.password }, headers: { Origin: BASE } });
  assert.equal(login.status(), 200, `${caseName}: owner sign-in`);
  return { ctx, page, net, dialogs, setDialog: (fn) => (onDialog = fn) };
}

/** The owner's product twin, through the real admin API with the session's own cookie (local host only). */
async function createTwin(page, tag) {
  // The session cookie is `Secure`: a URL filter over http would drop it, so the local host's are taken by domain.
  const cookie = (await page.context().cookies()).filter((c) => c.domain === '127.0.0.1').map((c) => `${c.name}=${c.value}`).join('; ');
  const post = async (method, path, data) => {
    const r = await fetch(`${BASE}${path}`, { method, body: JSON.stringify(data), headers: { Origin: BASE, Cookie: cookie, 'Content-Type': 'application/json' } });
    const body = await r.json().catch(() => null);
    assert.ok(r.ok, `${method} ${path} → ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  };
  const created = await post('POST', '/api/admin/products-v2', {
    name_en: `USD Pricing Twin Printer ${tag}`,
    description_en: 'An invented printer for the USD pricing regression.',
    price_iqd: STORE_PRICE,
    product_cost_iqd: LEGACY_COST,
    status: 'active',
    sale_types: ['direct_sale', 'pre_order'],
    category_id: 'cat_printers',
    stock: 1,
  });
  const id = created.product.id;
  const P = { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null };
  await post('PUT', `/api/admin/products/${id}/relations`, {
    inventory_mode: 'OPTION',
    groups: [
      {
        id: `g_model_${tag}`,
        name_en: 'Model',
        sort: 0,
        active: true,
        values: [
          {
            id: `v_m1_${tag}`, name_en: 'M1', name_ar: '', name_ckb: '', sku_part: '', image: '', sort: 0, active: true, stock: 1, low_stock_threshold: null, ...P,
            availability_type: '', lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null, variant_key: '', variant_label: '',
            fulfillments: [
              { fulfillment_type: 'direct_sale', enabled: true, sort: 0, ...P, lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null, capacity: null, transports: [] },
              {
                fulfillment_type: 'pre_order', enabled: true, sort: 1, ...P, lead_time_text: '', lead_time_min_days: 30, lead_time_max_days: 45, capacity: null,
                transports: [{ method: 'sea', enabled: true, surcharge_iqd: 0, sort: 0, ...P, lead_time_text: '', lead_time_min_days: 30, lead_time_max_days: 45, capacity: null }],
              },
            ],
          },
        ],
      },
    ],
    colors: [], variants: [], images: [], facet_ids: [],
  });
  return id;
}

/** Waits until no /api/ request has been in flight for `quietMs`. */
async function settle(page, quietMs = 1200, maxMs = 30000) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const start = Date.now();
  let last = await page.evaluate(() => performance.getEntriesByType('resource').length);
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(150);
    const n = await page.evaluate(() => performance.getEntriesByType('resource').length);
    if (n !== last) {
      last = n;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) return;
  }
}

const panel = (page) => page.locator('[data-form="usd-pricing"]').first();
const bar = (page) => page.locator('[data-form="save-bar"]').first();

async function openEditForm(page, pid) {
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await settle(page, 800);
  if ((await page.locator('[data-tab="products"]:visible').count()) === 0) {
    await page.locator('[data-action="open-sidebar"]').first().click();
    await page.waitForTimeout(400);
  }
  await page.locator('[data-tab="products"]:visible').first().click({ timeout: 20000 });
  await settle(page, 800);
  const edit = page.locator(`[data-product-id="${pid}"] [data-action="edit"]`).first();
  await edit.waitFor({ timeout: 20000 });
  await edit.click();
  await bar(page).waitFor({ timeout: 20000 });
  await openSection(page, 3);
  await panel(page).waitFor({ timeout: 20000 });
  await page.waitForFunction(() => /تكلفة المورد/.test(document.querySelector('[data-form="usd-pricing"]')?.textContent || ''), null, { timeout: 20000 });
  await settle(page, 1000);
}
/** «منتج جديد» → section ٣, its pricing panel drawn. */
async function openNewForm(page) {
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await settle(page, 800);
  if ((await page.locator('[data-tab="products"]:visible').count()) === 0) {
    await page.locator('[data-action="open-sidebar"]').first().click();
    await page.waitForTimeout(400);
  }
  await page.locator('[data-tab="products"]:visible').first().click({ timeout: 20000 });
  await settle(page, 800);
  await page.getByRole('button', { name: 'منتج جديد' }).first().click();
  await bar(page).waitFor({ timeout: 20000 });
  await openSection(page, 3);
  await panel(page).waitFor({ timeout: 20000 });
  await settle(page, 1000);
}
async function openSection(page, n) {
  const t = page.locator(`[data-section-toggle="${n}"]`).first();
  if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
  await page.waitForTimeout(250);
}
const sectionOpen = async (page, n) => (await page.locator(`[data-section-toggle="${n}"]`).first().getAttribute('aria-expanded')) === 'true';

/** The control a panel label names (a Field's label points at it, or at the Field's own root); `root` another part of the form. */
async function control(page, label, rootSelector = '[data-form="usd-pricing"]') {
  const tag = `c${Buffer.from(label).toString('hex').slice(0, 48)}-${Buffer.from(rootSelector).toString('hex').slice(-12)}`;
  for (let i = 0; i < 25; i++) {
    const ok = await page.evaluate(
      ([text, t, r]) => {
        const root = document.querySelector(r);
        const labels = root ? Array.from(root.querySelectorAll('label')) : [];
        // The label's own words first (an exact name), then a label that starts with them.
        const l = labels.find((x) => (x.childNodes[0]?.textContent || '').trim() === text) ?? labels.find((x) => (x.textContent || '').trim().startsWith(text));
        if (!l) return false;
        const id = l.getAttribute('for');
        let el = id ? document.getElementById(id) : null;
        if (el && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el = el.querySelector('input,select,textarea');
        if (!el) el = l.parentElement?.parentElement?.querySelector('input,select,textarea') ?? null;
        if (!el) return false;
        el.setAttribute('data-e2e', t);
        return true;
      },
      [label, tag, rootSelector]
    );
    if (ok) return page.locator(`[data-e2e="${tag}"]`).first();
    await page.waitForTimeout(200);
  }
  throw new Error(`no control for «${label}»`);
}
async function typeInto(page, label, value, rootSelector) {
  const el = await control(page, label, rootSelector);
  await el.click();
  await el.fill('');
  await el.pressSequentially(value, { delay: 25 });
}
async function pick(page, label, value) {
  await (await control(page, label)).selectOption(value);
  await page.waitForTimeout(250);
}

/** The owner's entry, key by key. */
async function fillEntry(page, { cost = ENTRY.cost } = {}) {
  await pick(page, 'عملة المورد', 'USD');
  await typeInto(page, 'تكلفة المورد للقطعة', cost);
  await pick(page, 'مسار الشحن الأساسي', 'CHINA_SEA');
  await typeInto(page, 'عرض الصندوق', ENTRY.box.width);
  await typeInto(page, 'عمق الصندوق', ENTRY.box.depth);
  await typeInto(page, 'ارتفاع الصندوق', ENTRY.box.height);
  await typeInto(page, 'تكاليف إضافية للقطعة', ENTRY.additional);
  await typeInto(page, 'الحد الأدنى للربح', ENTRY.minProfit);
  await typeInto(page, 'زيادة البيع المباشر', ENTRY.dse);
  // The owner reads the bar before pressing: the 450 ms preview lands.
  await page.waitForTimeout(900);
  await settle(page, 1200);
}

async function press(page, action) {
  await page.locator(`[data-action="${action}"]`).click();
  await page.waitForTimeout(300);
  await page.waitForFunction((a) => !document.querySelector(`[data-action="${a}"]`)?.hasAttribute('disabled'), action, { timeout: 60000 });
  await settle(page, 1500);
}
async function pressPricingSave(page) {
  const btn = panel(page).locator('[data-pricing-save]').first();
  await btn.click({ timeout: 10000 });
  await page.waitForTimeout(300);
  await settle(page, 1500);
}

/** Every field of the panel as shown, keyed by its label's first words. */
async function readFields(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-form="usd-pricing"]');
    const out = {};
    for (const l of Array.from(root?.querySelectorAll('label') ?? [])) {
      const id = l.getAttribute('for');
      let el = id ? document.getElementById(id) : null;
      if (el && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el = el.querySelector('input,select,textarea');
      if (!el) el = l.parentElement?.parentElement?.querySelector('input,select,textarea') ?? null;
      if (el) out[(l.childNodes[0]?.textContent || '').trim()] = el.value;
    }
    return out;
  });
}
const statusNow = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-form="save-bar"] [data-pricing-status]');
    return el ? el.getAttribute('data-pricing-status') : null;
  });

async function shot(page, caseName, name, locator) {
  const file = join(OUT, `${caseName}-${name}.png`);
  if (locator) await locator.screenshot({ path: file }).catch(() => page.screenshot({ path: file }));
  else await page.screenshot({ path: file });
  return file;
}

/** Reload, reopen «تعديل المنتج» → ٣, and read the fields, the answer and the database. */
async function readBack(page, pid) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(page, 800);
  await openEditForm(page, pid);
  const fields = await readFields(page);
  const panelText = await panel(page).innerText();
  const answer = await page.evaluate(async (id) => {
    const r = await fetch(`/api/admin/pricing/products/${id}/inputs`, { credentials: 'include' });
    return r.json();
  }, pid);
  const base = answer.scopes.find((s) => s.scope === 'base');
  return { fields, panelText, answer: { mode: answer.mode, base: { ...base.pricing_inputs, minimum_target_profit_usd: base.minimum_target_profit_usd, direct_sale_extra_iqd: base.direct_sale_extra_iqd }, adoption: answer.adoption && { kind: answer.adoption.kind, complete: answer.adoption.complete } }, db: stored(pid) };
}

function check(caseName, name, ok, detail = '') {
  checks++;
  if (ok) {
    passed++;
    console.log(`ok   ${caseName}: ${name}`);
  } else {
    failures.push(`${caseName}: ${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL ${caseName}: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * The owner's entry is all there: on screen after a reload, in the answer, in the database. The box
 * fields ARE the product's own package dimensions (one copy, saved with «نشر» / «مسودة»); after
 * «حفظ التسعير بالدولار» alone the box is stored for pricing and the panel says so on its measure line.
 */
function checkStored(c, back, { mode = 'manual', price = STORE_PRICE, boxOn = 'fields' } = {}) {
  const f = back.fields;
  const box = boxOn === 'fields' ? f['عرض الصندوق (سم)'] === '60' && f['عمق الصندوق (سم)'] === '52' && f['ارتفاع الصندوق (سم)'] === '48' : back.panelText.includes('52×60×48 cm');
  check(c, `the reopened panel shows every value typed (the box ${boxOn === 'fields' ? 'in its fields' : 'on the pricing measure line'})`, f['تكلفة المورد للقطعة'] === '899.5' && f['عملة المورد'] === 'USD' && f['مسار الشحن الأساسي'] === 'CHINA_SEA' && box && f['تكاليف إضافية للقطعة (د.ع)'] === '15000' && f['الحد الأدنى للربح (USD)'] === '120' && f['زيادة البيع المباشر (د.ع)'] === '25000', JSON.stringify(f));
  const b = back.answer.base;
  check(c, 'GET …/inputs reads them back canonical', b.supplier_cost_amount === STORED.supplier_cost_amount && b.supplier_cost_currency === 'USD' && b.shipping_profile === 'CHINA_SEA' && b.shipping_length_mm === 520 && b.shipping_width_mm === 600 && b.shipping_height_mm === 480 && b.additional_cost_iqd === 15000 && b.minimum_target_profit_usd === '120' && b.direct_sale_extra_iqd === 25000, JSON.stringify(b));
  const d = back.db;
  check(c, 'the database holds them', d.input?.supplier_cost_amount === '899.5' && d.input?.shipping_length_mm === 520 && d.input?.additional_cost_iqd === 15000 && d.minimum_target_profit_usd === '120' && d.direct_sale_extra_iqd === 25000, JSON.stringify(d));
  check(c, `the product is ${mode}`, d.mode === mode, d.mode);
  if (price !== null) check(c, `the store price is ${price}`, d.price_iqd === price, String(d.price_iqd));
  check(c, '«التكلفة القديمة» is unchanged', d.product_cost_iqd === LEGACY_COST, String(d.product_cost_iqd));
}

const results = {};
async function runCase(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return;
  console.log(`\n== ${name}`);
  const out = { case: name, shots: [] };
  try {
    await fn(out);
  } catch (e) {
    out.error = String(e?.stack || e).slice(0, 1500);
    failures.push(`${name}: threw ${String(e).slice(0, 300)}`);
    console.log(`FAIL ${name}: threw ${String(e).slice(0, 300)}`);
  }
  results[name] = out;
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify(out, null, 2));
}

/** L1 / L2 / L3 / P1: fill, save one way, reload, every value is there. */
async function saveAndReadBack(c, out, { action, width = 1280, world }) {
  const s = await newSession(c, width);
  try {
    const pid = await createTwin(s.page, c.toLowerCase());
    out.product = pid;
    await openEditForm(s.page, pid);
    if (world === 'L') {
      const text = await panel(s.page).innerText();
      check(c, 'the panel names the missing dollar rate', text.includes(AR.ratesNoUsd));
      check(c, 'with the way to «التسعير والشحن», in a new tab', (await panel(s.page).locator('[data-open-pricing][target="_blank"][href="/admin?tab=pricing"]').count()) >= 1);
      check(c, '«دينار» is offered disabled and says why', await s.page.evaluate((t) => Array.from(document.querySelectorAll('[data-form="usd-pricing"] option[value="IQD"]')).some((o) => o.disabled && o.textContent === t), AR.currencyIqdNoRate));
      check(c, 'the panel says the old cost does not move', text.includes(AR.legacyCostStays));
      check(c, 'no route yet: it says to pick one first', text.includes(AR.routeFirst));
    }
    out.shots.push(await shot(s.page, c, '1-before', panel(s.page)));
    await fillEntry(s.page);
    out.shots.push(await shot(s.page, c, '2-filled', panel(s.page)));
    if (action === 'pricing-save') await pressPricingSave(s.page);
    else await press(s.page, action);
    const puts = s.net.filter((n) => n.method === 'PUT' && /\/inputs$/.test(n.path));
    out.network = s.net;
    check(c, 'the pricing went in one PUT with data_only, answered 200', puts.length === 1 && puts[0].status === 200 && puts[0].data_only === true, JSON.stringify(puts));
    const status = await statusNow(s.page);
    check(c, 'the bar never says the pricing was refused', status !== 'refused' && status !== 'invalid', String(status));
    out.barStatus = status;
    out.outcome = await panel(s.page).locator('[data-pricing-outcome]').first().innerText().catch(() => null);
    out.shots.push(await shot(s.page, c, '3-after-save-panel', panel(s.page)));
    out.shots.push(await shot(s.page, c, '3-after-save-bar', bar(s.page)));
    if (width < 600) {
      const box = await s.page.locator('[data-form="save-bar"] [data-pricing-status]').first().boundingBox().catch(() => null);
      check(c, 'at 390 px the bar’s status is on screen and readable', !!box && box.width >= 30 && box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify(box));
      check(c, 'no sideways scroll at 390 px', await s.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    }
    if (action === 'pricing-save') {
      // F4: the box went to pricing only; the product's own copy waits for «نشر», and the panel says so.
      const notice = await panel(s.page).locator('[data-pricing-notice]').first().innerText().catch(() => '');
      check(c, 'the panel says the box is saved for pricing and the product’s own box waits for «نشر»', notice.includes(AR.measuresForPricingOnly), notice);
    }
    const before = s.dialogs.length;
    const back = await readBack(s.page, pid);
    out.readBack = back;
    if (action === 'pricing-save') {
      // …and leaving before «نشر» warns (the product's box would be lost), as every way out does.
      check(c, 'the reload warns: the product’s own box is not saved yet (F4)', s.dialogs.slice(before).some((d) => d.type === 'beforeunload'), JSON.stringify(s.dialogs));
    } else check(c, 'leaving after the save needs no warning (nothing unsaved)', s.dialogs.length === before, JSON.stringify(s.dialogs));
    checkStored(c, back, { boxOn: action === 'pricing-save' ? 'line' : 'fields' });
    if (action === 'save-draft') check(c, '«مسودة» left the product a draft', back.db.status === 'draft', back.db.status);
    out.shots.push(await shot(s.page, c, '4-after-reload', panel(s.page)));
  } finally {
    await s.ctx.close();
  }
}

try {
  // ---------------------------------------------------------------- setup
  const usd = rows("SELECT effective_rate FROM fx_rate_pairs WHERE pair = 'USD_IQD'")[0];
  assert.ok(usd && usd.effective_rate === null, 'PERSIST must be a FRESH database (the USD rate is already approved here; the L and B worlds cannot be rebuilt over it)');
  seedOwner();

  // ---------------------------------------------------------------- world L
  seed('rates-livelike.sql');
  await runCase('L1', (out) => saveAndReadBack('L1', out, { action: 'save', world: 'L' }));
  await runCase('L2', (out) => saveAndReadBack('L2', out, { action: 'save-draft', world: 'L' }));
  await runCase('L3', (out) => saveAndReadBack('L3', out, { action: 'pricing-save', world: 'L' }));
  await runCase('P1', (out) => saveAndReadBack('P1', out, { action: 'save', world: 'L', width: 390 }));

  await runCase('L4', async (out) => {
    const c = 'L4';
    const s = await newSession(c);
    try {
      const pid = await createTwin(s.page, 'l4');
      out.product = pid;
      await openEditForm(s.page, pid);
      await pick(s.page, 'عملة المورد', 'USD');
      await typeInto(s.page, 'تكلفة المورد للقطعة', '1,250');
      await s.page.waitForTimeout(600);
      const text = await panel(s.page).innerText();
      check(c, 'the field says why under itself', text.includes(AR.decimalSeparator));
      check(c, '«حفظ التسعير بالدولار» is disabled and says why', (await panel(s.page).locator('[data-pricing-save]').isDisabled()) && (await panel(s.page).locator('[data-pricing-blocked]').count()) === 1);
      out.shots.push(await shot(s.page, c, '1-invalid-field', panel(s.page)));
      await press(s.page, 'save');
      check(c, '«نشر» saved the product and sent no pricing', s.net.some((n) => n.method === 'POST' && n.path === '/api/admin/products-v2' && n.status === 200) && !s.net.some((n) => n.method === 'PUT' && /\/inputs$/.test(n.path)));
      check(c, 'the bar says the pricing was not saved', (await statusNow(s.page)) === 'invalid', String(await statusNow(s.page)));
      out.barText = await bar(s.page).innerText();
      check(c, 'the bar names the field and the reason', out.barText.includes('تكلفة المورد للقطعة') && out.barText.includes(AR.decimalSeparator), out.barText);
      out.shots.push(await shot(s.page, c, '2-bar-invalid', bar(s.page)));
      // «اعرض» opens the section that holds the field.
      await s.page.locator('[data-section-toggle="3"]').first().click();
      await s.page.waitForTimeout(300);
      check(c, 'section ٣ closed before «اعرض»', !(await sectionOpen(s.page, 3)));
      await bar(s.page).getByRole('button', { name: 'اعرض' }).click();
      await s.page.waitForTimeout(800);
      check(c, '«اعرض» opens section ٣', await sectionOpen(s.page, 3));
      out.shots.push(await shot(s.page, c, '3-after-show'));
      check(c, 'nothing is stored', stored(pid).input === null);
      await typeInto(s.page, 'تكلفة المورد للقطعة', '1250');
      await s.page.waitForTimeout(900);
      await press(s.page, 'save');
      const back = stored(pid);
      check(c, 'corrected, «نشر» stores it', back.input?.supplier_cost_amount === '1250' && back.input?.supplier_cost_currency === 'USD', JSON.stringify(back));
      check(c, 'and the bar no longer says refused', !['invalid', 'refused'].includes(String(await statusNow(s.page))));
      out.network = s.net;
    } finally {
      await s.ctx.close();
    }
  });

  await runCase('L5', async (out) => {
    const c = 'L5';
    const s = await newSession(c);
    try {
      const pid = await createTwin(s.page, 'l5');
      out.product = pid;
      await openEditForm(s.page, pid);
      await typeInto(s.page, 'الحد الأدنى للربح', ENTRY.minProfit);
      await s.page.waitForTimeout(400);
      // The product's own «تغييرات غير محفوظة» takes the bar first when the product is dirty too.
      const barNow = await bar(s.page).innerText();
      check(c, 'the bar says changes are unsaved', (await statusNow(s.page)) === 'unsaved' || barNow.includes('تغييرات غير محفوظة'), barNow);
      s.setDialog((d) => d.dismiss());
      await s.page.locator('button[aria-label="رجوع"]').first().click();
      await s.page.waitForTimeout(600);
      check(c, '«رجوع» asks first, in the owner’s words', s.dialogs.some((d) => d.type === 'confirm' && d.message.includes(AR.leaveUnsaved)), JSON.stringify(s.dialogs));
      check(c, 'dismissed: still on the form, the value still there', (await bar(s.page).count()) === 1 && (await readFields(s.page))['الحد الأدنى للربح (USD)'] === '١٢٠');
      out.shots.push(await shot(s.page, c, '1-still-on-form'));
      s.setDialog((d) => d.accept());
      await s.page.locator('button[aria-label="رجوع"]').first().click();
      await s.page.waitForTimeout(1000);
      check(c, 'accepted: back on the product list', (await bar(s.page).count()) === 0 && (await s.page.locator(`[data-product-id="${pid}"]`).count()) >= 1);
      out.dialogs = s.dialogs;
    } finally {
      await s.ctx.close();
    }
  });

  // F1: the box the second «نشر» stores is the box the fields show (never the one frozen by the first, invalid «نشر»).
  await runCase('L6', async (out) => {
    const c = 'L6';
    const s = await newSession(c);
    try {
      const pid = await createTwin(s.page, 'l6');
      out.product = pid;
      await openEditForm(s.page, pid);
      await fillEntry(s.page, { cost: '1,250' });
      await press(s.page, 'save');
      check(c, 'first «نشر»: the pricing is not sent (invalid)', (await statusNow(s.page)) === 'invalid', String(await statusNow(s.page)));
      await openSection(s.page, 3);
      await typeInto(s.page, 'عرض الصندوق', toArabic(70));
      await typeInto(s.page, 'تكلفة المورد للقطعة', '1250');
      await s.page.waitForTimeout(900);
      await settle(s.page, 1200);
      out.shots.push(await shot(s.page, c, '1-corrected', panel(s.page)));
      await press(s.page, 'save');
      const box = rows(`SELECT i.shipping_width_mm AS w, p.package_width_mm AS pw FROM pricing_inputs i JOIN products p ON p.id = i.product_id WHERE i.product_id = '${pid}' AND i.origin = 'MANUAL_OVERRIDE' AND i.scope = 'base'`)[0] ?? null;
      out.box = box;
      check(c, 'pricing stores the corrected box (70 cm), the box the product and its fields hold', box?.w === 700 && box?.pw === 700, JSON.stringify(box));
      check(c, 'and the cost', stored(pid).input?.supplier_cost_amount === '1250', JSON.stringify(stored(pid)));
      out.network = s.net;
    } finally {
      await s.ctx.close();
    }
  });

  // F3: the dashboard's sidebar asks before closing a form that holds unsaved pricing.
  await runCase('L7', async (out) => {
    const c = 'L7';
    const s = await newSession(c);
    try {
      const pid = await createTwin(s.page, 'l7');
      out.product = pid;
      await openEditForm(s.page, pid);
      await typeInto(s.page, 'الحد الأدنى للربح', ENTRY.minProfit);
      await s.page.waitForTimeout(500);
      s.setDialog((d) => d.dismiss());
      const before = s.dialogs.length;
      await s.page.locator('[data-tab="overview"]:visible').first().click();
      await s.page.waitForTimeout(700);
      check(c, 'the sidebar asks first, in the owner’s words', s.dialogs.slice(before).some((d) => d.type === 'confirm' && d.message.includes(AR.leaveUnsaved)), JSON.stringify(s.dialogs));
      check(c, 'dismissed: still on the form, the value still there', (await bar(s.page).count()) === 1 && (await readFields(s.page))['الحد الأدنى للربح (USD)'] === ENTRY.minProfit);
      out.shots.push(await shot(s.page, c, '1-still-on-form'));
      s.setDialog((d) => d.accept());
      await s.page.locator('[data-tab="overview"]:visible').first().click();
      await s.page.waitForTimeout(1000);
      check(c, 'accepted: the other tab opens', (await bar(s.page).count()) === 0);
      out.dialogs = s.dialogs;
    } finally {
      await s.ctx.close();
    }
  });

  // F2: a NEW product knows, before its first save, that no dollar rate is approved.
  await runCase('L8', async (out) => {
    const c = 'L8';
    const s = await newSession(c);
    try {
      await openNewForm(s.page);
      const text = await panel(s.page).innerText();
      check(c, '«منتج جديد»: the panel names the missing dollar rate', text.includes(AR.ratesNoUsd), text.slice(0, 400));
      check(c, '«منتج جديد»: «دينار» is offered disabled and says why', await s.page.evaluate((t) => Array.from(document.querySelectorAll('[data-form="usd-pricing"] option[value="IQD"]')).every((o) => o.disabled && o.textContent === t), AR.currencyIqdNoRate));
      out.shots.push(await shot(s.page, c, '1-new-product-panel', panel(s.page)));
    } finally {
      await s.ctx.close();
    }
  });

  // ---------------------------------------------------------------- world B
  if (!ONLY.length || ONLY.some((n) => /^[BN]/.test(n))) seed('rates-liveB.sql');
  await runCase('B1', async (out) => {
    const c = 'B1';
    const s = await newSession(c);
    try {
      const pid = await createTwin(s.page, 'b1');
      out.product = pid;
      await openEditForm(s.page, pid);
      check(c, '«دينار» is disabled while no dollar rate is approved', await s.page.evaluate(() => Array.from(document.querySelectorAll('[data-form="usd-pricing"] option[value="IQD"]')).every((o) => o.disabled)));
      await fillEntry(s.page);
      await press(s.page, 'save');
      const puts = s.net.filter((n) => n.method === 'PUT' && /\/inputs$/.test(n.path));
      check(c, 'saved as data (one PUT, data_only, 200)', puts.length === 1 && puts[0].status === 200 && puts[0].data_only === true, JSON.stringify(puts));
      const back = await readBack(s.page, pid);
      out.readBack = back;
      checkStored(c, back);
      const where = await panel(s.page).locator('[data-pricing-where]').first().innerText().catch(() => '');
      out.where = where;
      check(c, 'the central gap (the dollar rate) is named with the way to fix it', where.includes(AR.centralMissing) && where.includes(AR.fxMissing) && (await panel(s.page).locator('[data-pricing-where] [data-open-pricing]').count()) === 1, where);
      const barText = await panel(s.page).locator('[data-pricing-summary]').first().innerText().catch(() => '');
      check(c, 'the bar no longer lists the supplier cost, its currency or the minimum profit as missing', !/تكلفة المورد غير موجودة|عملة المورد غير محددة|الحد الأدنى للربح غير مضبوط/.test(barText), barText);
      out.shots.push(await shot(s.page, c, '1-after-reload', panel(s.page)));
      out.network = s.net;
    } finally {
      await s.ctx.close();
    }
  });

  // ---------------------------------------------------------------- world N
  if (!ONLY.length || ONLY.some((n) => /^N/.test(n))) seed('rates-normal.sql');
  let n1Product = null;
  await runCase('N1', async (out) => {
    const c = 'N1';
    const s = await newSession(c);
    try {
      const pid = await createTwin(s.page, 'n1');
      n1Product = pid;
      out.product = pid;
      await openEditForm(s.page, pid);
      await fillEntry(s.page);
      await press(s.page, 'save');
      const puts = s.net.filter((n) => n.method === 'PUT' && /\/inputs$/.test(n.path));
      check(c, 'the data went in one PUT with data_only, answered 200', puts.length === 1 && puts[0].status === 200 && puts[0].data_only === true, JSON.stringify(puts));
      const sheet = s.page.locator('[data-engine-save-sheet]').first();
      check(c, 'the review is open at the form’s root, section ٨ closed', (await sheet.isVisible().catch(() => false)) && !(await sectionOpen(s.page, 8)));
      const sheetText = await sheet.innerText().catch(() => '');
      check(c, 'the review says the data is already saved', sheetText.includes(AR.sheetDataSaved), sheetText);
      check(c, 'and never the held write’s «this save completes the data … in the same step»', !sheetText.includes(AR.adoptIntro), sheetText);
      out.shots.push(await shot(s.page, c, '1-review-sheet'));
      check(c, 'the store price has not moved yet', stored(pid).price_iqd === STORE_PRICE);
      const cancel = s.page.locator('[data-engine-save-cancel]').first();
      check(c, 'its cancel is «لاحقًا — البيانات محفوظة»', (await cancel.innerText()) === AR.later);
      await cancel.click();
      await s.page.waitForTimeout(600);
      check(c, 'the bar says the new price awaits approval', (await statusNow(s.page)) === 'ready', String(await statusNow(s.page)));
      out.shots.push(await shot(s.page, c, '2-bar-ready', bar(s.page)));
      const back = await readBack(s.page, pid);
      out.readBack = back;
      checkStored(c, back);
      check(c, 'the stored data is complete and ready to adopt', back.answer.adoption?.kind === 'adopt' && back.answer.adoption?.complete === true);
      check(c, 'the panel offers «راجع السعر الجديد واعتمده»', (await panel(s.page).locator('[data-pricing-review]').count()) === 1);
      out.shots.push(await shot(s.page, c, '3-after-reload', panel(s.page)));
      out.network = s.net;
    } finally {
      await s.ctx.close();
    }
  });

  await runCase('N2', async (out) => {
    const c = 'N2';
    assert.ok(n1Product, 'N2 continues N1’s product');
    const s = await newSession(c);
    try {
      out.product = n1Product;
      await openEditForm(s.page, n1Product);
      await panel(s.page).locator('[data-pricing-review]').first().click();
      const sheet = s.page.locator('[data-engine-save-sheet]').first();
      await sheet.waitFor({ timeout: 10000 });
      out.shots.push(await shot(s.page, c, '1-review'));
      const tick = s.page.locator('[data-engine-save-large]').first();
      out.largeChange = (await tick.count()) > 0;
      if (out.largeChange) await tick.check();
      await s.page.locator('[data-engine-save-confirm]').first().click();
      await s.page.waitForTimeout(800);
      await settle(s.page, 2000);
      const after = stored(n1Product);
      out.stored = after;
      check(c, 'the engine priced it (mode engine)', after.mode === 'engine', after.mode);
      check(c, 'the store price is the engine’s, not the manual one', typeof after.price_iqd === 'number' && after.price_iqd !== STORE_PRICE && after.price_iqd % 1000 === 0, String(after.price_iqd));
      check(c, '«التكلفة القديمة» is unchanged', after.product_cost_iqd === LEGACY_COST, String(after.product_cost_iqd));
      // Said once, beside the save button (never twice in the panel).
      const outcome = await panel(s.page).locator('[data-pricing-notice]').first().innerText().catch(() => '');
      check(c, 'the panel says it was adopted', outcome.includes(AR.savedAdopted), outcome);
      check(c, 'once', (await panel(s.page).innerText()).split(AR.savedAdopted).length - 1 === 1);
      check(c, 'the bar says saved', (await statusNow(s.page)) === 'saved', String(await statusNow(s.page)));
      out.shots.push(await shot(s.page, c, '2-after-adopt', panel(s.page)));
      out.network = s.net;
    } finally {
      await s.ctx.close();
    }
  });

  await runCase('N3', async (out) => {
    const c = 'N3';
    const s = await newSession(c);
    try {
      const pid = await createTwin(s.page, 'n3');
      out.product = pid;
      await openEditForm(s.page, pid);
      await fillEntry(s.page);
      await pressPricingSave(s.page);
      const sheet = s.page.locator('[data-engine-save-sheet]').first();
      check(c, '«حفظ التسعير بالدولار» opens the review at once (٣ open, ٨ closed)', (await sheet.isVisible().catch(() => false)) && (await sectionOpen(s.page, 3)) && !(await sectionOpen(s.page, 8)));
      out.shots.push(await shot(s.page, c, '1-review-sheet'));
      const db = stored(pid);
      check(c, 'the data is already stored, the price not yet', db.input?.supplier_cost_amount === '899.5' && db.mode === 'manual' && db.price_iqd === STORE_PRICE, JSON.stringify(db));
      await s.page.locator('[data-engine-save-cancel]').first().click();
      out.network = s.net;
    } finally {
      await s.ctx.close();
    }
  });

  // F2 / FX plan §12: a NEW product's dinars, at the rate the panel says, saved with «نشر» with the rest.
  await runCase('N4', async (out) => {
    const c = 'N4';
    const s = await newSession(c);
    try {
      await openNewForm(s.page);
      const name = `USD Pricing New ${Date.now() % 100000}`;
      out.name = name;
      await openSection(s.page, 1);
      const cat = s.page.locator('#pf-category');
      await cat.selectOption(await cat.evaluate((el) => Array.from(el.options).map((o) => o.value).find((v) => v && /printer/i.test(v)) || Array.from(el.options).map((o) => o.value).find(Boolean)));
      await openSection(s.page, 2);
      await typeInto(s.page, 'الاسم', name, 'body');
      await openSection(s.page, 3);
      await typeInto(s.page, 'السعر', String(STORE_PRICE), 'body');
      check(c, '«دينار» is offered (a dollar rate is approved)', await s.page.evaluate(() => Array.from(document.querySelectorAll('[data-form="usd-pricing"] option[value="IQD"]')).every((o) => !o.disabled)));
      await pick(s.page, 'عملة المورد', 'IQD');
      await typeInto(s.page, 'تكلفة المورد بالدينار', toArabic(1450000));
      await pick(s.page, 'مسار الشحن الأساسي', 'CHINA_SEA');
      await typeInto(s.page, 'عرض الصندوق', ENTRY.box.width);
      await typeInto(s.page, 'عمق الصندوق', ENTRY.box.depth);
      await typeInto(s.page, 'ارتفاع الصندوق', ENTRY.box.height);
      await typeInto(s.page, 'الحد الأدنى للربح', ENTRY.minProfit);
      await s.page.waitForTimeout(600);
      const line = await panel(s.page).locator('[data-usd-iqd-rate]').first().innerText().catch(() => '');
      check(c, 'the line under the dinars says the rate the save converts at', line.includes(AR.iqdAtRate), line);
      out.shots.push(await shot(s.page, c, '1-filled', panel(s.page)));
      await press(s.page, 'save');
      const sheet = s.page.locator('[data-engine-save-sheet]').first();
      if (await sheet.isVisible().catch(() => false)) await s.page.locator('[data-engine-save-cancel]').first().click();
      await s.page.waitForTimeout(600);
      const pid = rows(`SELECT id FROM products WHERE name = '${name}'`)[0]?.id ?? null;
      out.product = pid;
      check(c, 'the product was created', !!pid);
      const puts = s.net.filter((n) => n.method === 'PUT' && /\/inputs$/.test(n.path));
      check(c, 'the pricing went in one PUT (data_only, the conversion hash), answered 200', puts.length === 1 && puts[0].status === 200 && puts[0].data_only === true && puts[0].has_hash, JSON.stringify(puts));
      const input = pid ? rows(`SELECT supplier_input_mode, original_input_amount, conversion_rate_snapshot, shipping_profile, shipping_width_mm FROM pricing_inputs WHERE product_id = '${pid}' AND origin = 'MANUAL_OVERRIDE' AND scope = 'base'`)[0] : null;
      out.input = input;
      check(c, 'the dinars are stored converted at the rate shown, with the rest', input?.supplier_input_mode === 'IQD_CONVERTED' && input?.original_input_amount === '1450000' && Number(input?.conversion_rate_snapshot) === 1600 && input?.shipping_profile === 'CHINA_SEA' && input?.shipping_width_mm === 600, JSON.stringify(input));
      check(c, 'the store price is the one typed (manual)', pid ? stored(pid).price_iqd === STORE_PRICE && stored(pid).mode === 'manual' : false, JSON.stringify(pid && stored(pid)));
      out.network = s.net;
    } finally {
      await s.ctx.close();
    }
  });
} finally {
  await browser.close();
}

check('ALL', 'no request left the machine', blocked.length === 0, blocked.slice(0, 5).join(' | '));
check('ALL', 'no page error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
const summary = { checks, passed, failures, blocked, pageErrors, cases: Object.keys(results), out: OUT };
writeFileSync(join(RESULTS, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n${passed}/${checks} checks passed, ${failures.length} failure(s); ${blocked.length} non-local requests blocked; results in ${RESULTS}`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
