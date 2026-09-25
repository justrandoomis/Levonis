#!/usr/bin/env node
/**
 * THE W6 HARDENING SWEEP — every screen the merchant-platform work touched, at
 * six widths and in every language the app speaks, measured the same way.
 *
 * It reuses the existing browser fixtures (tests/browser/*.html, one local
 * `vite`) and the store builder's real-route backend
 * (tests/browser/store-builder-api.mts, started here for the storefront) — no
 * new server. Screens:
 *
 *   workspace   every /merchant route (and /admin on the store's own host),
 *               the /requests board in both views
 *               (tests/browser/merchant-workspace.html)
 *   print       the request wizard (new, draft, editing a published one),
 *               offer comparison, the merchant's offer panel with the order
 *               contact, «عروضي», and the 3D viewer with a board merchant's
 *               'preview' grant and a customer's full one (print-requests-v2.html)
 *   workshop    «مناسب لي», the workshop card (eligible / not), costing,
 *               printers + stock + preferences (workshop.html)
 *   finance     the merchant's money screen and the admin payout queue
 *   inbox       the notification centre and the inbox (merchant-notifications.html)
 *   checkout    the store checkout in all six delivery states (delivery.html)
 *   catalog     the product page with variants, the product manager/editor
 *   storefront  the public store page in each of the seven theme presets,
 *               published through the real layout routes
 *
 * On every page: no horizontal overflow (page or scroll owner); the page's
 * direction; every visible control's hit target at least 44×44 (measured by
 * hit-testing, so a pseudo-element that widens a compact control counts);
 * text clipped without an ellipsis; text contrast against its real
 * background (WCAG AA: 4.5, or 3 for large text); unnamed inputs, buttons and
 * images; dialogs without a role, aria-modal or a name; a toast region that
 * is not a live region. Once per page at 1280 (ar, en): keyboard focus is
 * visible on the first focusable controls. Once per group: nothing loops
 * forever under reduced motion except a spinner.
 *
 * Screenshots: OUT_DIR (default /tmp/claude-0/shots/w6/<group>/<name>-<w>-<lang>.png),
 * plus a findings report (findings.json) and contact sheets (sheet-*.png).
 *
 * Run: npx vite --port 4191 &   then
 *      PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright node scripts/e2e-w6-sweep.mjs
 *   ONLY=workspace,print      groups to run
 *   WIDTHS=360,1280  LANGS=ar,en   narrower runs
 *   STRICT=targets,contrast   also fail on these finding kinds (default: they are reported)
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WORKSPACE_URL || 'http://127.0.0.1:4191';
const OUT = process.env.OUT_DIR || '/tmp/claude-0/shots/w6';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const WIDTHS = (process.env.WIDTHS || '320,360,768,1024,1280,1440').split(',').map(Number);
const LANGS = (process.env.LANGS || 'ar,en,ckb').split(',');
const STRICT = new Set((process.env.STRICT || '').split(',').filter(Boolean));
const API_PORT = Number(process.env.BUILDER_API_PORT || 8794);
const heightOf = (w) => (w < 700 ? 780 : w < 1100 ? 1024 : 860);

const hard = [];
const findings = [];
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes += 1;
  else {
    hard.push(`${name} ${detail}`);
    console.log(`FAIL ${name} ${detail}`);
  }
}
function note(kind, where, detail) {
  findings.push({ kind, where, detail });
  if (STRICT.has(kind)) check(`${where}: ${kind}`, false, detail);
}

// ------------------------------------------------------------------ screens

const ws = (path, extra = '') => (lang) => `/tests/browser/merchant-workspace.html?lang=${lang}&path=${encodeURIComponent(path)}${extra}`;
const fx = (file, q) => (lang) => `/tests/browser/${file}.html?lang=${lang}${q ? `&${q}` : ''}`;
// The store's own host (host=store): `/` is the public storefront, `/p/<slug>` a product.
const sb = (path) => (lang) => `/tests/browser/store-builder.html?lang=${lang}&api=http://127.0.0.1:${API_PORT}&host=store&path=${encodeURIComponent(path)}`;

const WORKSPACE_ROUTES = [
  ['home', '/merchant'], ['orders', '/merchant/orders'], ['order', '/merchant/orders/ORD-7F3A21C9'],
  ['custom-orders', '/merchant/requests/orders'], ['products', '/merchant/products'], ['product', '/merchant/products/p1'],
  ['collections', '/merchant/collections'], ['services', '/merchant/services'], ['showcase', '/merchant/showcase'],
  ['coupons', '/merchant/marketing/coupons'], ['customers', '/merchant/customers'], ['inbox', '/merchant/inbox'],
  ['requests', '/merchant/requests'], ['money', '/merchant/money'], ['analytics', '/merchant/analytics'],
  ['reviews', '/merchant/reviews'], ['notifications', '/merchant/notifications'], ['printers', '/merchant/printers'],
  ['costing', '/merchant/costing'], ['store-design', '/merchant/store/design'], ['store-settings', '/merchant/store/settings'],
  ['store-delivery', '/merchant/store/delivery'],
];
const GROUPS = {
  workspace: [
    ...WORKSPACE_ROUTES.map(([n, p]) => ({ name: n, url: ws(p), ready: '[data-merchant-shell]' })),
    { name: 'admin-host-orders', url: ws('/merchant/orders', '&host=store'), ready: '[data-merchant-shell]' },
    // A merchant lands on «مناسب لي»; the other view is one radio away.
    { name: 'board-fits', url: ws('/requests'), ready: '[data-segmented], main' },
    {
      name: 'board-all',
      url: ws('/requests'),
      ready: '[data-segmented], main',
      act: async (page) => {
        const r = page.getByRole('radio', { name: /كل الطلبات|All requests/ });
        if (await r.count()) await r.first().click();
      },
    },
  ],
  print: ['wizard', 'new', 'edit', 'offers', 'merchant', 'mine', 'viewer', 'viewer-full'].map((v) => ({
    name: v,
    url: fx('print-requests-v2', `view=${v}`),
    ready: v.startsWith('viewer') ? '[data-page="model-viewer"]' : '#root > *',
  })),
  workshop: ['board', 'card', 'reasons', 'costing', 'printers'].map((v) => ({ name: v, url: fx('workshop', `view=${v}`), ready: '#root > *' })),
  finance: [
    { name: 'merchant', url: fx('merchant-finance', 'view=merchant'), ready: '#root > *' },
    { name: 'admin-queue', url: fx('merchant-finance', 'view=admin'), ready: '#root > *' },
  ],
  inbox: [
    { name: 'notifications', url: fx('merchant-notifications', ''), ready: '#root > *' },
    { name: 'inbox', url: fx('merchant-notifications', 'view=inbox'), ready: '#root > *' },
  ],
  checkout: ['fee', 'free_over', 'pickup', 'unavailable', 'governorate', 'no_address'].map((s) => ({ name: s, url: fx('delivery', `view=checkout&state=${s}`), ready: '#root > *' })),
  catalog: ['product', 'manager', 'editor'].map((v) => ({ name: v, url: fx('catalog', `view=${v}`), ready: '#root > *' })),
  storefront: [], // filled per theme below
};
const THEMES = ['classic', 'minimal', 'modern', 'premium_dark', 'workshop', 'portfolio', 'product_focused'];

// ------------------------------------------------------------ measurements

/** Everything measured inside the page, in one evaluate. */
async function measure(page) {
  return page.evaluate(() => {
    const out = { overflow: 0, owner: 0, dir: document.documentElement.dir, small: [], clipped: [], contrast: [], unnamed: [], dialogs: [], live: null };
    const doc = document.documentElement;
    out.overflow = doc.scrollWidth - window.innerWidth;
    const own = document.querySelector('[data-scroll-owner]');
    out.owner = own ? own.scrollWidth - own.clientWidth : 0;

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };
    const label = (el) => (el.getAttribute('data-nav') || el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);

    // Hit targets: a control is fine if its box is 44×44, or if hit-testing
    // 22px from its centre along each axis still lands on it (a ::before or
    // ::after that widens a compact pill counts — it hit-tests as the element).
    const CONTROLS = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=tab], [role=radio], [role=switch], [role=checkbox], [role=menuitem], [role=option], [role=button]';
    const inText = (el) => el.tagName === 'A' && el.closest('p, li, dd') && (el.closest('p, li, dd').textContent || '').trim().length > (el.textContent || '').trim().length + 12;
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (!visible(el) || inText(el) || el.closest('[aria-hidden="true"], [inert]')) continue;
      if (el.disabled || el.tabIndex < 0 && !el.matches('[role=radio], [role=tab]')) continue; // not a Tab stop, driven by a visible control
      const r = el.getBoundingClientRect();
      if (r.width <= 2 && r.height <= 2) continue; // visually hidden
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top || !(el === top || el.contains(top) || top.contains(el))) continue; // covered: not what a finger reaches here
      // Inputs inside a label/row whose hit area is the whole row (Checkbox, Switch rows).
      const host = el.closest('label, [data-hit-row]') || el;
      const hits = (x, y) => {
        if (x < 0 || y < 0 || x > window.innerWidth - 1 || y > window.innerHeight - 1) return true;
        const t = document.elementFromPoint(x, y);
        return !!t && (t === el || el.contains(t) || t === host || host.contains(t));
      };
      const w = r.width >= 43.5 || (hits(cx - 21, cy) && hits(cx + 21, cy));
      const h = r.height >= 43.5 || (hits(cx, cy - 21) && hits(cx, cy + 21));
      if (!w || !h) out.small.push(`${label(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }

    // Text: clipped without an ellipsis, and contrast against the real background.
    // Any CSS colour (Tailwind 4 writes oklch/oklab) → sRGB, by painting one pixel.
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = 1;
    const c2d = cvs.getContext('2d', { willReadFrequently: true });
    const memo = new Map();
    const parseRgb = (c) => {
      if (!c || c === 'transparent') return [0, 0, 0, 0];
      if (memo.has(c)) return memo.get(c);
      c2d.clearRect(0, 0, 1, 1);
      c2d.fillStyle = '#000';
      c2d.fillStyle = c;
      c2d.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = c2d.getImageData(0, 0, 1, 1).data;
      const out = [r, g, b, a / 255];
      memo.set(c, out);
      return out;
    };
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const blend = (top, under) => {
      const a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const background = (el) => {
      const stack = [];
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // an image or gradient: not measurable here
        if (cs.filter !== 'none' || cs.backdropFilter && cs.backdropFilter !== 'none' && n !== el) {
          /* a blurred material over unknown content: measure the tint only */
        }
        const c = parseRgb(cs.backgroundColor);
        if (c && c[3] > 0) {
          stack.push(c);
          if (c[3] >= 0.99) break;
        }
      }
      let base = [255, 255, 255, 1];
      const bodyBg = parseRgb(getComputedStyle(document.body).backgroundColor);
      if (bodyBg && bodyBg[3] > 0.99) base = bodyBg;
      for (let i = stack.length - 1; i >= 0; i -= 1) base = stack[i][3] >= 0.99 ? stack[i] : blend(stack[i], base);
      return base;
    };
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (walker.nextNode() && count < 1500) {
      const t = walker.currentNode;
      if (!t.textContent || !t.textContent.trim()) continue;
      const el = t.parentElement;
      if (!el || seen.has(el) || !visible(el) || el.closest('[aria-hidden="true"], svg, [data-page="model-viewer"] canvas')) continue;
      seen.add(el);
      count += 1;
      const cs = getComputedStyle(el);
      // Clipped: the box hides what it cannot fit and says nothing about it.
      for (let n = el, depth = 0; n && depth < 3; n = n.parentElement, depth += 1) {
        const ns = getComputedStyle(n);
        if ((ns.overflowX === 'hidden' || ns.overflowX === 'clip') && n.clientWidth > 2 && n.scrollWidth > n.clientWidth + 2 && ns.textOverflow !== 'ellipsis' && ns.whiteSpace === 'nowrap' && !n.closest('[aria-hidden="true"]')) {
          out.clipped.push(`${label(n)} ${n.scrollWidth}>${n.clientWidth}`);
          break;
        }
      }
      const fg = parseRgb(cs.color);
      const bg = background(el);
      if (!fg || !bg || fg[3] < 0.1 || el.closest('.lv-delay-in, .sr-only')) continue; // screen-reader-only text, or a loader still inside its fade-in delay
      const opacity = (() => {
        let o = 1;
        for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
        return o;
      })();
      const ink = blend([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
      const L1 = lum(ink), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const need = large ? 3 : 4.5;
      const disabled = el.closest('button:disabled, [aria-disabled="true"], input:disabled') || el.closest('label')?.querySelector('input:disabled');
      // Placeholder-like examples and disabled controls are exempt (WCAG 1.4.3).
      if (ratio < need && !disabled) out.contrast.push(`${(t.textContent || '').trim().slice(0, 28)} ${ratio.toFixed(2)}:1 @${size}px`);
    }

    // Names.
    const byLabel = (el) => el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
      if (!el.getClientRects().length || el.tabIndex < 0) continue;
      const named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
      if (!named) out.unnamed.push(`${el.tagName.toLowerCase()}[${el.type || ''}] ${el.getAttribute('placeholder') || el.name || ''}`.trim());
    }
    for (const el of document.querySelectorAll('button, [role=button], a[href]')) {
      if (!el.getClientRects().length) continue;
      const text = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.querySelector('img[alt]:not([alt=""])') || byLabel(el);
      if (!text) out.unnamed.push(`${el.tagName.toLowerCase()} ${el.className.toString().slice(0, 40)}`);
    }
    for (const img of document.querySelectorAll('img')) {
      if (img.getClientRects().length && !img.hasAttribute('alt')) out.unnamed.push(`img ${img.src.slice(0, 50)}`);
    }
    for (const el of document.querySelectorAll('[data-overlay], [role=dialog], [role=alertdialog], dialog')) {
      if (!el.getClientRects().length) continue;
      const d = el.matches('[role=dialog], [role=alertdialog], dialog') ? el : el.querySelector('[role=dialog], [role=alertdialog], dialog');
      if (!d) out.dialogs.push(`${el.getAttribute('data-overlay')}: no dialog role`);
      else if (!d.getAttribute('aria-labelledby') && !d.getAttribute('aria-label')) out.dialogs.push(`${el.getAttribute('data-overlay') || d.tagName}: unnamed dialog`);
      else if (d.tagName !== 'DIALOG' && d.getAttribute('aria-modal') !== 'true' && !el.matches('[data-overlay-nonmodal]')) out.dialogs.push(`${el.getAttribute('data-overlay') || 'dialog'}: not aria-modal`);
    }
    const toaster = document.querySelector('[data-toaster]');
    // The Toaster draws its stack in [data-toaster] and speaks through the two
    // sr-only live regions beside it (polite + assertive).
    const liveNear = (n) => [n, ...n.querySelectorAll('[aria-live]'), ...[n.nextElementSibling, n.nextElementSibling?.nextElementSibling].filter(Boolean)].map((x) => x.getAttribute('aria-live')).filter(Boolean);
    out.live = toaster ? liveNear(toaster).join('+') || null : 'none';
    return out;
  });
}

/** Tab through the first controls: each must show a focus indicator that differs from its resting look. */
async function focusWalk(page, where) {
  const missing = [];
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.scrollTo(0, 0);
  });
  // Styles are read after the controls' transitions (≤150ms) have settled.
  const PICK = `(cs) => [cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? cs.outlineColor + cs.outlineWidth : '', cs.boxShadow, cs.borderColor, cs.backgroundColor].join('|')`;
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(220);
    const on = await page.evaluate((PICK) => {
      const pick = eval(PICK);
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      el.setAttribute('data-w6-focus', '1');
      // A ring drawn by a wrapper (group-focus-visible) or a child also counts.
      return { self: pick(getComputedStyle(el)), kin: [el.parentElement, ...el.children].filter(Boolean).map((n) => pick(getComputedStyle(n))).join('#'), name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30) };
    }, PICK);
    if (!on) break;
    await page.evaluate(() => document.querySelector('[data-w6-focus]')?.blur());
    await page.waitForTimeout(220);
    const off = await page.evaluate((PICK) => {
      const pick = eval(PICK);
      const el = document.querySelector('[data-w6-focus]');
      if (!el) return null; // blurring closed what held it (a sheet's own field)
      const r = { self: pick(getComputedStyle(el)), kin: [el.parentElement, ...el.children].filter(Boolean).map((n) => pick(getComputedStyle(n))).join('#') };
      el.focus();
      el.removeAttribute('data-w6-focus');
      return r;
    }, PICK);
    if (off && on.self === off.self && on.kin === off.kin) missing.push(on.name);
  }
  if (missing.length) note('focus', where, missing.join(' | '));
  check(`${where}: focus walk ran`, true);
}

async function reducedMotionLoops(page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming?.().iterations === Infinity)
      .map((a) => a.effect.target)
      .filter((t) => t && !t.closest('[role=status], [aria-busy="true"], [data-spinner], .animate-spin, [data-skeleton], .lv-skeleton'))
      .map((t) => `${t.tagName}.${String(t.className).slice(0, 40)}`)
  );
}

// ------------------------------------------------------------------ driver

async function visit(ctx, group, s, w, lang, opts) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const where = `${group}/${s.name}-${w}-${lang}`;
  try {
    await page.goto(origin + s.url(lang), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(s.ready, { timeout: 20000 }).catch(() => note('ready', where, `no ${s.ready}`));
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"][role="status"]'), null, { timeout: 6000 }).catch(() => {});
    if (s.act) await s.act(page);
    await page.waitForTimeout(700);
    const m = await measure(page);
    check(`${where}: no horizontal overflow`, m.overflow <= 0 && m.owner <= 1, JSON.stringify({ page: m.overflow, owner: m.owner }));
    const rtl = lang !== 'en';
    check(`${where}: direction`, m.dir === (rtl ? 'rtl' : 'ltr'), m.dir);
    if (m.small.length) note('targets', where, m.small.slice(0, 12).join(' ; '));
    if (m.clipped.length) note('clipped', where, m.clipped.slice(0, 8).join(' ; '));
    if (m.contrast.length) note('contrast', where, m.contrast.slice(0, 10).join(' ; '));
    if (m.unnamed.length) note('names', where, m.unnamed.slice(0, 8).join(' ; '));
    if (m.dialogs.length) note('dialogs', where, m.dialogs.join(' ; '));
    // The toast stack must announce itself: a toaster that is not a live region is a silent one.
    check(`${where}: toasts are announced`, m.live !== null && m.live !== '', String(m.live));
    await mkdir(`${OUT}/${group}`, { recursive: true });
    await page.screenshot({ path: `${OUT}/${group}/${s.name}-${w}-${lang}.png`, fullPage: opts.full });
    if (w === 1280 && lang !== 'ckb') await focusWalk(page, where);
    check(`${where}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (e) {
    check(`${where}: visited`, false, String(e).slice(0, 200));
  } finally {
    await page.close();
  }
}

async function runGroup(browser, group, screens, { full = false } = {}) {
  for (const w of WIDTHS) {
    for (const lang of LANGS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: heightOf(w) }, hasTouch: w < 640, isMobile: w < 640, deviceScaleFactor: 1, colorScheme: 'dark', serviceWorkers: 'block' });
      await ctx.route('**/files/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#2b3a44"/><circle cx="560" cy="200" r="120" fill="#d2c392" opacity=".35"/></svg>' }));
      for (const s of screens) await visit(ctx, group, s, w, lang, { full });
      await ctx.close();
    }
  }
  // Reduced motion, once per group at a phone width.
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, reducedMotion: 'reduce', colorScheme: 'dark', serviceWorkers: 'block' });
  for (const s of screens) {
    const page = await ctx.newPage();
    await page.goto(origin + s.url('ar'), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForSelector(s.ready, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(900);
    const loops = await reducedMotionLoops(page).catch(() => []);
    if (loops.length) note('motion', `${group}/${s.name}-reduced`, loops.slice(0, 5).join(' ; '));
    await page.close();
  }
  await ctx.close();
}

/** The public storefront in each theme preset: publish the starter through the real routes, then visit. */
async function storefront(browser) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/browser/store-builder-api.mts', String(API_PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('builder api on') && resolve());
    child.on('exit', (code) => reject(new Error(`backend exited ${code}`)));
  });
  const API = `http://127.0.0.1:${API_PORT}`;
  const starters = JSON.parse(
    execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./packages/storeLayout/src/starters.ts').then((m) => process.stdout.write(JSON.stringify(Object.fromEntries(m.STARTER_THEMES.map((t) => [t, m.starterLayout(t)])))))"], { encoding: 'utf8' })
  );
  try {
    const products = await (await fetch(`${API}/api/storefront/raf3d/products?limit=1`)).json().catch(() => null);
    const slug = products?.products?.[0]?.slug;
    for (const theme of THEMES) {
      const cur = await (await fetch(`${API}/api/merchant/store/layout`)).json();
      const version = cur.draft?.version ?? 0;
      const put = await fetch(`${API}/api/merchant/store/layout/draft`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version, layout: starters[theme] }) });
      const saved = await put.json();
      const pub = await fetch(`${API}/api/merchant/store/layout/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: saved.draft?.version ?? saved.version ?? version + 1 }) });
      check(`storefront/${theme}: published`, pub.ok, `${put.status}/${pub.status}`);
      const screens = [{ name: theme, url: sb('/'), ready: '[role=tablist], main, #root > *' }];
      if (theme === 'classic' && slug) screens.push({ name: 'product-page', url: sb(`/p/${slug}`), ready: 'main, #root > *' });
      await runGroup(browser, 'storefront', screens, { full: true });
    }
  } finally {
    child.kill();
  }
}

/** Contact sheets: every screenshot of a group, small, on one page — to LOOK at. */
async function sheets(browser, groups) {
  const { readdirSync } = await import('node:fs');
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  for (const g of groups) {
    let files;
    try {
      files = readdirSync(`${OUT}/${g}`).filter((f) => f.endsWith('.png')).sort();
    } catch {
      continue;
    }
    for (const w of WIDTHS) {
      const mine = files.filter((f) => f.includes(`-${w}-`));
      if (!mine.length) continue;
      const cols = w <= 400 ? 9 : w <= 800 ? 6 : 4;
      const html = `<body style="margin:0;background:#222;font:11px system-ui;color:#ddd"><div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:6px">${mine
        .map((f) => `<figure style="margin:0"><img src="file://${OUT}/${g}/${f}" style="width:100%;display:block;max-height:${w <= 400 ? 700 : 520}px;object-fit:cover;object-position:top"><figcaption>${f}</figcaption></figure>`)
        .join('')}</div></body>`;
      await writeFile(`${OUT}/.sheet.html`, html);
      await page.goto(`file://${OUT}/.sheet.html`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/sheet-${g}-${w}.png`, fullPage: true });
    }
  }
  await page.close();
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const ran = [];
try {
  for (const [group, screens] of Object.entries(GROUPS)) {
    if (ONLY && !ONLY.includes(group)) continue;
    console.log(`== ${group}`);
    ran.push(group);
    if (group === 'storefront') await storefront(browser);
    else await runGroup(browser, group, screens, { full: group !== 'workspace' });
  }
  await sheets(browser, ran);
} finally {
  await browser.close();
}

await writeFile(`${OUT}/findings.json`, JSON.stringify(findings, null, 1));
const byKind = findings.reduce((a, f) => ((a[f.kind] = (a[f.kind] ?? 0) + 1), a), {});
console.log(`\n${passes} passed, ${hard.length} failed; findings by kind: ${JSON.stringify(byKind)} (details in ${OUT}/findings.json)`);
if (hard.length) {
  for (const f of hard.slice(0, 60)) console.log(`  - ${f}`);
  process.exit(1);
}
