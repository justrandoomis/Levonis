#!/usr/bin/env node
/**
 * Browser-level UI verification for the auth/UI fleet pass.
 *
 * Drives the REAL app (wrangler dev serving the built dist/ plus the real
 * local API + D1) with Playwright Chromium at a 390x844 phone viewport,
 * Arabic default (RTL). Every check runs against real server responses —
 * fixtures are created through the public/admin APIs exactly like
 * scripts/api-tests.mjs does; nothing is mocked and no fake success is
 * asserted.
 *
 * Prereqs:
 *   npm run build                     # dist/ must be current
 *   npx wrangler dev --port 8787      # with local D1 migrated
 * Run:
 *   API_BASE=http://127.0.0.1:8787 node scripts/e2e-ui.mjs
 *
 * Screenshots land in docs/evidence/ (viewport PNGs, deviceScaleFactor 1).
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // Global install (CI image): resolve from the node prefix.
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
}

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';
const OUT = path.resolve(new URL('..', import.meta.url).pathname, 'docs/evidence');
mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`FAIL  ${name} ${extra}`);
  }
}

// ---------------------------------------------------------------- API client
class Client {
  constructor() {
    this.cookie = '';
  }
  async req(method, p, body) {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + p, { method, headers, body: payload });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
}

function promoteAdmin(email) {
  const sql = `UPDATE users SET role='admin' WHERE email='${email}'`;
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(sql)), {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'pipe',
  });
}

// ------------------------------------------------------- minimal PNG decoder
// Decodes an 8-bit RGB/RGBA non-interlaced PNG (what Playwright emits) so
// the green-glow assertion samples REAL rendered pixels, not a guess.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG layout (depth=${bitDepth} color=${colorType} interlace=${interlace})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      cur[x] = v;
    }
  }
  return { width, height, bpp, data: out };
}

/** Stats over a rect: mean luminance, max luminance, worst green excess. */
function regionStats(img, x0, y0, w, h) {
  let sumLum = 0, maxLum = 0, maxGreenExcess = -255, n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * img.bpp;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumLum += lum;
      if (lum > maxLum) maxLum = lum;
      const excess = g - Math.max(r, b);
      if (excess > maxGreenExcess) maxGreenExcess = excess;
      n++;
    }
  }
  return { meanLum: sumLum / n, maxLum, maxGreenExcess };
}

// -------------------------------------------------------------------- main
async function main() {
  // Server must be up and honest before anything is asserted.
  const health = await fetch(`${BASE}/api/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) {
    console.error(`Server at ${BASE} is not healthy (status ${health}). Start wrangler dev first.`);
    process.exit(1);
  }

  const rnd = Math.random().toString(36).slice(2, 8);
  const admin = new Client();
  const user = new Client();
  const adminEmail = `e2e-admin-${rnd}@test.local`;
  const userEmail = `e2e-user-${rnd}@test.local`;
  const fixtureProducts = [];

  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  }
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    locale: 'ar',
    hasTouch: true,
    // The LEVONIS identity is dark; pages use dark: variants. Emulate a
    // dark-scheme device (see docs/UI_FIX_EVIDENCE.md for the light-scheme
    // caveat on Profile/Chats, which is page-internal and out of scope here).
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  const shot = async (name) => {
    const buf = await page.screenshot({ type: 'png' });
    writeFileSync(path.join(OUT, name), buf);
    return buf;
  };

  try {
    // ============================================== (a) /auth in ar (RTL)
    console.log('\n— (a) /auth Arabic RTL, labels, method slots, honest states');
    await page.goto(`${BASE}/auth`, { waitUntil: 'networkidle' });
    const authRoot = page.locator('.lv-auth');
    await authRoot.waitFor({ timeout: 10000 });
    check('auth container is RTL', (await authRoot.getAttribute('dir')) === 'rtl');
    const labelCount = await page.locator('.lv-auth label').count();
    check('real <label> elements above inputs', labelCount >= 2, `labels=${labelCount}`);
    check('LEVONIS wordmark rendered', (await page.getByText('LEVONIS', { exact: true }).count()) >= 1);
    // Since the blueprint redesign there are no method tabs: email/password
    // is the primary form, and Google/Telegram sit under the «أو» seam ONLY
    // when the deployment's capabilities offer them — an honest absence,
    // never a dead fake button.
    const uiCaps = await page.evaluate(() => fetch('/api/auth/capabilities').then((r) => r.json()).catch(() => ({})));
    check('primary email/password form is visible immediately (no tab step)',
      (await page.locator('#identifier').count()) === 1 && (await page.locator('#signin-submit').count()) === 1);
    const googleIframe = await page.locator('iframe[src*="accounts.google.com"]').count();
    check('google slot present only when configured (real GSI button, never a fake)',
      uiCaps.google ? googleIframe > 0 : googleIframe === 0, `iframe=${googleIframe} caps.google=${!!uiCaps.google}`);
    const tgButton = page.locator('button.lv-social', { hasText: 'تيليغرام' });
    if (uiCaps.telegram) {
      await tgButton.first().click({ force: true });
      const tgPhone = page.locator('#tg-auth-phone');
      await tgPhone.waitFor({ timeout: 10000 });
      check('telegram method slot with labeled phone input', (await tgPhone.count()) === 1);
      // Regression guard: TelegramAuth's <form> must NOT be nested inside the
      // signin form (browsers drop nested form tags, which would make the
      // Telegram submit button submit the credentials form instead).
      const tgFormOwnsButton = await page.evaluate(() => {
        const phone = document.getElementById('tg-auth-phone');
        const form = phone && phone.closest('form');
        return !!form && !form.querySelector('#identifier') && !!form.querySelector('button[type=submit]');
      });
      check('telegram flow owns its own form (no nested-form fallout)', tgFormOwnsButton);
    } else {
      check('telegram entry is honestly absent when capabilities report no bot', (await tgButton.count()) === 0);
    }
    await shot('a-auth-ar-rtl.png');

    // ============================== (b) home bottom area — no green glow
    console.log('\n— (b) home bottom corners: near-black, no green glow');
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700); // let images/fonts settle
    await page.evaluate(() => {
      const el = document.getElementById('main-scroll-container');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);
    const homeBuf = await shot('b-home-bottom.png');
    const img = decodePng(homeBuf);
    check('screenshot decodes at viewport size', img.width === 390 && img.height === 844,
      `${img.width}x${img.height}`);
    const bl = regionStats(img, 0, img.height - 40, 40, 40);
    const br = regionStats(img, img.width - 40, img.height - 40, 40, 40);
    for (const [name, s] of [['bottom-left', bl], ['bottom-right', br]]) {
      // Near-black: the shell background is #000 and the nav pill edge is
      // black/20+blur — mean must stay very dark. Green glow: no pixel may
      // have green meaningfully above red/blue (the old olive gradient had
      // g ≈ 2x r). Thresholds leave room for anti-aliasing noise only.
      check(`${name} 40x40 region near-black (mean lum < 40)`, s.meanLum < 40, `meanLum=${s.meanLum.toFixed(1)}`);
      check(`${name} 40x40 region has no green dominance (max g-excess <= 12)`, s.maxGreenExcess <= 12,
        `maxGreenExcess=${s.maxGreenExcess}`);
    }
    console.log(`      (bottom-left meanLum=${bl.meanLum.toFixed(1)} maxLum=${bl.maxLum.toFixed(0)} gEx=${bl.maxGreenExcess}; ` +
      `bottom-right meanLum=${br.meanLum.toFixed(1)} maxLum=${br.maxLum.toFixed(0)} gEx=${br.maxGreenExcess})`);

    // ==================================== (c1) profile signed-out (guest)
    console.log('\n— (c) profile: guest vs member');
    await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
    const guestTitle = page.getByText('أنت تتصفح كزائر', { exact: false });
    await guestTitle.waitFor({ timeout: 10000 });
    check('guest card shown when signed out', (await guestTitle.count()) === 1);
    const bodyText = await page.locator('body').innerText();
    // Member stat labels ("النقاط"/"الرصيد" tiles) must never render for a
    // guest; the guest badge ("زائر") must.
    check('guest sees no member-only points/balance tiles', !/النقاط|الرصيد/.test(bodyText));
    check('guest badge shown', bodyText.includes('زائر'));
    await shot('c1-profile-guest.png');

    // -------- fixtures: real accounts, product, order — via the real API
    let r = await admin.post('/api/auth/register', { email: adminEmail, username: `e2a${rnd}`, name: 'E2E Admin', password: 'correct-horse-9' });
    check('fixture: admin registered', r.status === 200, JSON.stringify(r.data));
    promoteAdmin(adminEmail);
    r = await user.post('/api/auth/register', { email: userEmail, username: `e2u${rnd}`, name: 'E2E User', password: 'battery-staple-7' });
    check('fixture: user registered', r.status === 200, JSON.stringify(r.data));

    const mkProduct = async (name) => {
      const res = await admin.post('/api/admin/products', {
        name, price_iqd: 10000, original_price_iqd: 12000, stock: 5, status: 'active',
        images: [], membership_prices: {},
      });
      check(`fixture: product "${name}" created`, res.status === 200 && !!res.data?.product?.id, JSON.stringify(res.data));
      fixtureProducts.push(res.data.product);
      return res.data.product;
    };
    const p1 = await mkProduct(`UI Evidence Alpha ${rnd}`);
    const p2 = await mkProduct(`UI Evidence Beta ${rnd}`);

    const pol = await user.get('/api/policies');
    const policyAcceptance = (pol.data?.policies ?? [])
      .filter((p) => p.required_for_checkout)
      .map((p) => ({ key: p.key, version: p.version }));
    r = await user.post('/api/cart/items', { productId: p1.id, qty: 1 });
    check('fixture: added to cart', r.status === 200);
    r = await user.post('/api/addresses', { label: 'Home', name: 'E2E User', phone: '+9647701234567', address: 'Baghdad, Evidence St 1' });
    const addressId = r.data?.id;
    check('fixture: address created', r.status === 200 && !!addressId);
    r = await user.post('/api/orders', {
      policyAcceptance, addressId, deliveryMethodId: 'standard', paymentMethodId: 'cash',
      useWallet: false, usePoints: false, itemIds: [], idempotencyKey: `e2e-${rnd}-1`,
    });
    const order = r.data?.order;
    check('fixture: order created via real checkout', r.status === 200 && !!order?.id, JSON.stringify(r.data));
    check('fixture: order starts in pending', order?.status === 'pending', `status=${order?.status}`);

    // ------------------------------------------ (c2) profile signed-in
    const sessionCookie = user.cookie.split('=');
    await context.addCookies([{
      name: sessionCookie[0],
      value: sessionCookie.slice(1).join('='),
      url: BASE,
    }]);
    await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
    // Profile displays the username (displayName = username || name || email).
    await page.getByText(`e2u${rnd}`, { exact: false }).first().waitFor({ timeout: 10000 });
    check('member profile shows the real account identity', true);
    check('member profile shows NO guest card', (await page.getByText('أنت تتصفح كزائر').count()) === 0);
    // Icon grid: the three utility actions render as equal 44px+ buttons.
    const gridBtns = page.locator('button[aria-label="العنوان"], button[aria-label="خدمة العملاء"], button[aria-label="الاعدادات"]');
    const gridBoxes = [];
    const gridCount = await gridBtns.count();
    for (let i = 0; i < gridCount; i++) gridBoxes.push(await gridBtns.nth(i).boundingBox());
    const tops = gridBoxes.filter(Boolean).map((b) => Math.round(b.y));
    const aligned = tops.length >= 3 && Math.max(...tops) - Math.min(...tops) <= 2;
    check('icon grid: address/support/settings aligned on one row', aligned, `tops=${tops.join(',')}`);
    const bigEnough = gridBoxes.filter(Boolean).every((b) => b.width >= 43.5 && b.height >= 43.5);
    check('icon grid: touch targets >= 44px', bigEnough, JSON.stringify(gridBoxes.map((b) => b && [Math.round(b.width), Math.round(b.height)])));
    await shot('c2-profile-member.png');

    // ======================= (d) orders filter chips apply the filter
    console.log('\n— (d) orders status-filter navigation');
    // From the profile, tap the "pending payment" chip → /orders?status=pending.
    await page.getByRole('button', { name: 'بانتظار الدفع' }).first().click();
    await page.waitForURL('**/orders?status=pending', { timeout: 10000 });
    check('profile chip lands on /orders?status=pending', true);
    const activeChip = page.locator('button[aria-pressed="true"]');
    await activeChip.waitFor({ timeout: 10000 });
    // Orders labels the chip "انتظار الدفع" (+ live count badge).
    check('pending chip is the active (aria-pressed) one', (await activeChip.innerText()).includes('انتظار الدفع'),
      await activeChip.innerText());
    await page.getByText(`#${order.id}`.slice(0, 9), { exact: false }).first().waitFor({ timeout: 10000 }).catch(() => {});
    const listText = await page.locator('body').innerText();
    check('pending list contains the fixture order', listText.includes(order.id.slice(0, 8)) || listText.includes('UI Evidence Alpha'),
      'order id/product name not found in filtered list');
    await shot('d-orders-filter-pending.png');
    // Switch to "shipped" — a filter with zero orders must show the honest
    // empty-filtered state, not the unfiltered list.
    await page.getByRole('button', { name: 'مشحونة' }).click();
    await page.waitForURL('**/orders?status=shipped', { timeout: 10000 });
    await page.getByText('لا توجد طلبات بهذه الحالة', { exact: false }).waitFor({ timeout: 10000 });
    check('shipped filter applies (honest empty state, fixture order hidden)',
      !(await page.locator('body').innerText()).includes('UI Evidence Alpha'));
    await shot('d2-orders-filter-shipped-empty.png');

    // ==================== (e) product skeleton → content, no stale flash
    console.log('\n— (e) product detail loading without stale flash');
    await page.goto(`${BASE}/product/${p1.slug}`, { waitUntil: 'networkidle' });
    await page.getByText(p1.name, { exact: false }).first().waitFor({ timeout: 10000 });
    check('product 1 detail renders real content', true);
    // In-app slug change (component stays mounted): every painted frame
    // between the two products must show either the skeleton or product 2 —
    // NEVER product 1's name under product 2's URL.
    const frames = await page.evaluate(async ([n1, n2, slug2]) => {
      window.history.pushState({}, '', `/product/${slug2}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 8000) {
        await new Promise((res) => requestAnimationFrame(res));
        const txt = document.body.innerText;
        out.push({ p1: txt.includes(n1), p2: txt.includes(n2) });
        if (txt.includes(n2)) break;
      }
      return out;
    }, [p1.name, p2.name, p2.slug]);
    const staleFrames = frames.filter((f) => f.p1).length;
    const loaded = frames.length > 0 && frames[frames.length - 1].p2;
    check('product 2 content loaded after in-app slug change', loaded, `frames=${frames.length}`);
    check('no stale product-1 frame during the transition', staleFrames === 0, `staleFrames=${staleFrames}`);
    await page.getByText(p2.name, { exact: false }).first().waitFor({ timeout: 10000 });
    await shot('e-product-detail.png');

    // ============================ (f) customer service entry → /support
    console.log('\n— (f) customer-service entry lands on /support');
    await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
    // Two buttons share the accessible name: the compact one (aria-label)
    // lives in the scrolled-state fixed header, opacity-0 + pointer-events-
    // none until scroll; the in-flow grid button (visible text, DOM-last) is
    // the one a user actually taps.
    await page.getByRole('button', { name: 'خدمة العملاء' }).last().click();
    await page.waitForURL('**/support', { timeout: 10000 });
    check('support route reached from profile', true);
    await page.waitForTimeout(800);
    check('support page rendered content', (await page.locator('body').innerText()).trim().length > 0);
    await shot('f-support.png');

    // Console errors collected across the whole run (informational, but a
    // crash-level error fails the pass).
    const fatal = consoleErrors.filter((e) => /Uncaught|ReferenceError|TypeError/.test(e));
    check('no uncaught console errors during the run', fatal.length === 0, fatal.slice(0, 3).join(' | '));
    if (consoleErrors.length) {
      console.log(`      (console errors observed: ${consoleErrors.length})`);
      for (const e of consoleErrors.slice(0, 5)) console.log(`        - ${e.slice(0, 160)}`);
    }
  } finally {
    // Fixture hygiene: hide the evidence products so repeated runs do not
    // pollute the public catalog (soft, reversible — no deletions).
    for (const p of fixtureProducts) {
      await admin.post('/api/admin/products', {
        id: p.id, name: p.name, slug: p.slug, price_iqd: p.price_iqd,
        original_price_iqd: p.original_price_iqd, stock: p.stock, status: 'hidden',
      }).catch(() => {});
    }
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
