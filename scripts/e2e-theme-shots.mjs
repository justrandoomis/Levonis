#!/usr/bin/env node
/**
 * EVERY MAIN SCREEN, IN BOTH THEMES — photographed from the real app.
 *
 * «الثيم المطبق حاليا هو ليس ابيض ولا اسود» — the owner's report was about
 * what a screen LOOKS like, so the theme system is verified by looking: the
 * real SPA (Vite dev: index.html with its pre-paint theme script, src/main.tsx,
 * the real routes) at 390 and 1280 px, Arabic (English spot-checks), light and
 * dark, written to $THEME_SHOTS_DIR as <page>-<width>-<lang>-<theme>.png.
 *
 * DATA. Catalogue reads are the live shop's PUBLIC read-only GETs (the same
 * rule as scripts/e2e-home-v2-shots.mjs): only GET, only /api/* and /files/*,
 * no cookie. Everything a signed-in screen needs is answered here from small
 * fixed data (a customer, an admin with a short order board), and anything
 * else that is not a GET is refused locally — the script cannot write
 * anything anywhere. The merchant workspace is the existing fixture
 * (tests/browser/merchant-workspace.html), which mounts src/App with its own
 * fixed data.
 *
 *   node scripts/e2e-theme-shots.mjs
 *   THEME_SHOTS_ONLY=home,settings THEME_SHOTS_THEMES=light node scripts/e2e-theme-shots.mjs
 *
 * Env: THEME_SHOTS_ORIGIN (default https://levonis-iq.com), THEME_SHOTS_DIR
 * (default /tmp/claude-0/shots/theme), THEME_SHOTS_URL (reuse a running Vite).
 *
 * Besides the pictures it asserts what a picture hides: the first frame is
 * already the chosen theme (no flash), the whole page agrees with <html>, and
 * nothing scrolls sideways.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = process.env.THEME_SHOTS_ORIGIN || 'https://levonis-iq.com';
const OUT = process.env.THEME_SHOTS_DIR || '/tmp/claude-0/shots/theme';
const PORT = 4183;
let BASE = process.env.THEME_SHOTS_URL || '';

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

const cache = new Map();
async function upstream(path) {
  if (!cache.has(path)) {
    cache.set(
      path,
      fetch(ORIGIN + path, { headers: { accept: path.startsWith('/files/') ? '*/*' : 'application/json' } })
        .then(async (r) => ({
          status: r.status,
          type: r.headers.get('content-type') || 'application/octet-stream',
          body: Buffer.from(await r.arrayBuffer()),
        }))
        .catch(() => ({ status: 502, type: 'application/json', body: Buffer.from('{"success":false}') }))
    );
  }
  return cache.get(path);
}

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
      if ((await fetch(BASE)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('vite did not start');
}

// ------------------------------------------------------------ fixed data
const now = Date.now();
const iso = (days) => new Date(now - days * 86_400_000).toISOString();
const USER = (role) => ({
  id: 'u_theme', email: 'reader@example.com', username: 'reader', name: role === 'admin' ? 'Levonis Admin' : 'علي حسن',
  role, isAdmin: role === 'admin', is_investor: false, subscription_plan: 'free', membership_tier: 'plus',
  admin_scope: role === 'admin' ? 'full' : null, can_view_financials: role === 'admin', subscription_expiry: 0, locale: 'ar',
  avatar_key: null, bio: '', website: '', profile: {}, country: 'IQ', phone: '+9647******567', has_phone: true,
  notify_whatsapp: true, has_google: false, onboarding: 'done', completion: { percent: 100, complete: true, missing: [] },
  checkin_streak: 3, last_checkin_day: null, created_at: iso(200),
});
const ORDER = (i, status, stage, label, bucket) => ({
  id: `LV-24${i}1${i}`, status, stage, address: { name: ['حسين علي', 'زينب كريم', 'مصطفى جاسم', 'نور الهدى'][i % 4], governorate: 'baghdad', city: 'الكرادة', phone: '07701234567' },
  delivery_method: { id: 'standard', titleAr: 'توصيل عادي', titleEn: 'Standard', price_iqd: 5000 }, payment_method_id: 'cod',
  subtotal_iqd: 185000 + i * 25000, shipping_iqd: 5000, cod_tax_iqd: 0, points_discount_iqd: 0, wallet_applied_iqd: 0,
  total_iqd: 190000 + i * 25000, due_on_delivery_iqd: 190000 + i * 25000, created_at: iso(i * 0.4), updated_at: iso(i * 0.2),
  items: [{ id: `it${i}`, product_id: 'p', name: 'Bambu Lab A1 mini', name_ar: 'طابعة Bambu Lab A1 mini', quantity: 1, unit_price_iqd: 185000, price_iqd: 185000, image: null }],
  customer_name: 'علي حسن', customer_phone: '07701234567', seller_type: 'levonis', shipping_type: 'direct', due_bucket: bucket, due_label: label,
  quick_next: stage === 'delivered' ? null : { stage: 'preparing', label: 'بدء التجهيز', source: 'manual' },
});
const ORDERS = {
  orders: [
    ORDER(1, 'pending', 'pending', 'اليوم', 'today'),
    ORDER(2, 'confirmed', 'confirmed', 'اليوم', 'today'),
    ORDER(3, 'processing', 'preparing', 'غدًا', 'tomorrow'),
    ORDER(4, 'shipped', 'out_for_delivery', 'الأربعاء', 'week'),
  ],
  total: 4, limit: 50, offset: 0, scope: 'active', due: null, type: null, status: null,
  today: iso(0).slice(0, 10), tomorrow: iso(-1).slice(0, 10), week_end: iso(-6).slice(0, 10), search_kind: 'none', search: null,
  counts: { total: 4, overdue: 0, today: 2, tomorrow: 1, week: 1, later: 0, unscheduled: 0 },
  options: { type: { all: 4, prepare: 3, direct: 4, preorder_air: 0, preorder_sea: 0, preorder_land: 0 }, status: { any: 4, pending: 1, confirmed: 1, processing: 1, shipped: 1, delivered: 0, cancelled: 0 } },
};

// ------------------------------------------------------------ the pages
const SPA = [
  { name: 'home', path: '/', wait: '[data-home-section="latest"]', full: true },
  { name: 'products', path: '/products', wait: 'main a[href^="/product/"]', full: false },
  { name: 'product', path: 'PRODUCT', wait: 'h1', full: true },
  { name: 'cart', path: '/cart', as: 'customer' },
  { name: 'settings', path: '/settings', as: 'customer', wait: '[data-settings-appearance]', full: true },
  { name: 'profile', path: '/profile', as: 'customer' },
  { name: 'orders', path: '/orders', as: 'customer' },
  { name: 'wallet', path: '/wallet', as: 'customer' },
  { name: 'chats', path: '/chats', as: 'customer' },
  { name: 'support', path: '/support' },
  { name: 'requests', path: '/requests' },
  { name: 'compare', path: '/compare' },
  { name: 'tools', path: '/tools' },
  { name: 'rewards', path: '/rewards', as: 'customer' },
  { name: 'games', path: '/games', as: 'customer' },
  { name: 'subscription', path: '/subscription' },
  { name: 'auth', path: '/auth', settle: 4000 },
  { name: 'admin-orders', path: '/admin?tab=orders', as: 'admin', wait: 'text=LV-2411' },
  { name: 'admin-overview', path: '/admin', as: 'admin' },
];
/** The shared kit's overlays (tests/browser/ui-kit.html): a dialog, a sheet, toasts. */
const KIT = [
  { name: 'kit', open: null },
  { name: 'kit-confirm', open: '[data-open="confirm"]' },
  { name: 'kit-sheet', open: '[data-open="sheet"]' },
  { name: 'kit-toasts', toasts: true },
];
const WORKSPACE = [
  { name: 'workspace', path: '/merchant' },
  { name: 'workspace-orders', path: '/merchant/orders' },
];

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};

let productPath = '/products';
async function findProduct() {
  const r = await upstream('/api/products?limit=12');
  try {
    const j = JSON.parse(r.body.toString());
    const list = j.products ?? j.data ?? j.items ?? [];
    const p = list.find((x) => x.slug || x.id);
    if (p) productPath = `/product/${p.slug || p.id}`;
  } catch {
    /* keep /products */
  }
}

async function newContext(browser, { width, lang, theme }) {
  const context = await browser.newContext({
    viewport: { width, height: width < 700 ? 844 : 900 },
    deviceScaleFactor: width < 700 ? 2 : 1,
    // The OS says the OPPOSITE of the chosen theme, so a screen that followed
    // the phone instead of the choice shows up at once.
    colorScheme: theme === 'light' ? 'dark' : 'light',
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
  });
  await context.addInitScript(
    ([l, t]) => {
      try {
        localStorage.setItem('levo_lang', l);
        localStorage.setItem('levonis.displayCurrency.v1', 'IQD');
        localStorage.setItem('levonis.theme.v1', t);
      } catch {
        /* private mode */
      }
    },
    [lang, theme]
  );
  return context;
}

async function wire(page, as) {
  page.on('pageerror', (e) => console.log(`  page error: ${e.message.slice(0, 160)}`));
  await page.route('**/files/**', async (route) => {
    const url = new URL(route.request().url());
    const r = await upstream(url.pathname + url.search);
    return route.fulfill({ status: r.status, contentType: r.type, body: r.body });
  });
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/api/auth/me') return json({ success: true, user: as ? USER(as) : null });
    if (p === '/api/storefront/resolve') return json({ success: true, kind: 'main', store: null });
    if (p === '/api/community/access') return json({ success: true, may_enter: true });
    if (as === 'admin' && p === '/api/admin/orders') return json({ success: true, ...ORDERS });
    if (as && p === '/api/orders') return json({ success: true, orders: [], total: 0 });
    if (as && p === '/api/cart') return json({ success: true, items: [], cart: { items: [] } });
    if (req.method() !== 'GET') return json({ success: false, error: 'READ_ONLY_SHOTS' }, 403);
    // Anything else: the live shop's anonymous answer (a private route says 401, and the screen shows its own state).
    const r = await upstream(p + url.search);
    return route.fulfill({ status: r.status, contentType: r.type.includes('json') ? 'application/json' : r.type, body: r.body });
  });
}

async function settle(page) {
  await page
    .waitForFunction(() => {
      const intro = document.querySelector('.lv-app-intro');
      return !intro || ['docked', 'hidden'].includes(intro.getAttribute('data-phase') ?? '');
    }, null, { timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(1800);
}

async function facts(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const main = document.getElementById('main-scroll-container');
    const bg = getComputedStyle(document.body).backgroundColor;
    return {
      theme: root.getAttribute('data-theme'),
      scheme: getComputedStyle(root).colorScheme,
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
      bodyBg: bg,
      overflow: Math.max(root.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0),
      height: Math.max(main ? main.scrollHeight : 0, root.scrollHeight),
    };
  });
}

const lum = (rgb) => {
  const m = rgb.match(/[\d.]+/g);
  if (!m) return 0;
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(+m[0]) + 0.7152 * f(+m[1]) + 0.0722 * f(+m[2]);
};

async function shootSpa(browser, spec, combo) {
  const { width, lang, theme } = combo;
  const context = await newContext(browser, combo);
  const page = await context.newPage();
  await wire(page, spec.as);
  const path = spec.path === 'PRODUCT' ? productPath : spec.path;
  const name = `${spec.name}-${width}-${lang}-${theme}`;
  // The FIRST frame: the attribute must already be there when the DOM is parsed.
  let first = null;
  page.once('domcontentloaded', async () => {
    first = await page.evaluate(() => document.documentElement.getAttribute('data-theme')).catch(() => null);
  });
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  if (spec.wait) await page.waitForSelector(spec.wait, { timeout: 30000 }).catch(() => console.log(`  (${name}: ${spec.wait} did not appear)`));
  await settle(page);
  if (spec.settle) await page.waitForTimeout(spec.settle);
  const f = await facts(page);
  check(`${name}: <html data-theme> is ${theme} from the first frame`, first === theme && f.theme === theme, `first=${first} now=${f.theme}`);
  check(`${name}: browser chrome follows (${f.meta}, ${f.scheme})`, f.meta === (theme === 'light' ? '#f3f0ea' : '#0b0c0f') && f.scheme === theme);
  const l = lum(f.bodyBg);
  check(`${name}: the page ground is ${theme}`, theme === 'light' ? l > 0.7 : l < 0.05, f.bodyBg);
  check(`${name}: no horizontal scroll`, f.overflow <= 1, `${f.overflow}px`);
  if (spec.full) {
    await page.setViewportSize({ width, height: Math.min(f.height + 40, 9000) });
    await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await context.close();
}

async function shootWorkspace(browser, spec, combo) {
  const { width, lang, theme } = combo;
  const context = await newContext(browser, combo);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  page error: ${e.message.slice(0, 160)}`));
  const name = `${spec.name}-${width}-${lang}-${theme}`;
  await page.goto(`${BASE}/tests/browser/merchant-workspace.html?lang=${lang}&path=${encodeURIComponent(spec.path)}`, { waitUntil: 'domcontentloaded' });
  // The fixture page has no index.html theme script (it mounts src/App directly), so the attribute is set here.
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(3500);
  const f = await facts(page);
  check(`${name}: the page ground is ${theme}`, theme === 'light' ? lum(f.bodyBg) > 0.7 : lum(f.bodyBg) < 0.05, f.bodyBg);
  check(`${name}: no horizontal scroll`, f.overflow <= 1, `${f.overflow}px`);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await context.close();
}

async function shootKit(browser, spec, combo) {
  const { width, lang, theme } = combo;
  const context = await newContext(browser, combo);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  page error: ${e.message.slice(0, 160)}`));
  const name = `${spec.name}-${width}-${lang}-${theme}`;
  await page.goto(`${BASE}/tests/browser/ui-kit.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(1500);
  if (spec.open) {
    await page.click(spec.open);
    await page.waitForTimeout(900);
  }
  if (spec.toasts) {
    for (const k of ['success', 'error', 'undo']) await page.click(`[data-kit-toast="${k}"]`).catch(() => {});
    await page.waitForTimeout(700);
  }
  const f = await facts(page);
  check(`${name}: the page ground is ${theme}`, theme === 'light' ? lum(f.bodyBg) > 0.7 : lum(f.bodyBg) < 0.05, f.bodyBg);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await context.close();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const child = await ensureServer();
  await findProduct();
  const browser = await chromium.launch();
  const only = (process.env.THEME_SHOTS_ONLY || '').split(',').filter(Boolean);
  const themes = (process.env.THEME_SHOTS_THEMES || 'light,dark').split(',');
  const widths = (process.env.THEME_SHOTS_WIDTHS || '390,1280').split(',').map(Number);
  const pick = (s) => !only.length || only.includes(s.name);
  try {
    for (const theme of themes) {
      for (const width of widths) {
        console.log(`\n${theme} ${width} ar`);
        for (const spec of SPA.filter(pick)) await shootSpa(browser, spec, { width, lang: 'ar', theme });
        for (const spec of WORKSPACE.filter(pick)) await shootWorkspace(browser, spec, { width, lang: 'ar', theme });
        if (width < 700) for (const spec of KIT.filter(pick)) await shootKit(browser, spec, { width, lang: 'ar', theme });
      }
      console.log(`\n${theme} 390 en (spot-check)`);
      for (const spec of SPA.filter((s) => ['home', 'settings', 'product', 'admin-orders'].includes(s.name)).filter(pick)) {
        await shootSpa(browser, spec, { width: 390, lang: 'en', theme });
      }
    }
  } finally {
    await browser.close();
    child?.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
