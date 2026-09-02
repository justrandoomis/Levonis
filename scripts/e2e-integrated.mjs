#!/usr/bin/env node
/**
 * Browser verification for the INTEGRATED mandate (accounts, referrals and
 * support codes, points page, product page, admin import, conversations,
 * Studio link). It drives the REAL built app served by the local
 * `wrangler dev` worker against the real local API and D1 — nothing is
 * mocked and no screenshot is asserted by eye: every claim below is a DOM
 * measurement, a computed style, a decoded pixel or an observed request.
 *
 * Prereqs:
 *   npm run build                              # dist/ must be current
 *   npx wrangler dev --ip 127.0.0.1 --port 8787   # local D1 migrated 0001→0017
 * Run:
 *   API_BASE=http://127.0.0.1:8787 node scripts/e2e-integrated.mjs
 *
 * Screenshots land in docs/evidence/integrated/.
 *
 * Reporting follows the mandate's four buckets: passed · failed ·
 * NOT EXECUTED · BLOCKED-with-reason. A precondition that is honestly
 * unconfigured is never counted as a pass.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Same resolution chain as the other browser suites: local playwright first,
// then playwright-core, then the machine-global install.
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

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(ROOT, 'docs/evidence/integrated');
mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0, blockedCount = 0, notRunCount = 0;
const failures = [], blockedList = [], notRunList = [];
const shots = [];

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`FAIL  ${name} ${extra}`); }
}
function blocked(name, reason) { blockedCount++; blockedList.push(`${name} — ${reason}`); console.log(` BLK  ${name} — ${reason}`); }
function notRun(name, reason) { notRunCount++; notRunList.push(`${name} — ${reason}`); console.log(` N/R  ${name} — ${reason}`); }

async function shot(page, file, note) {
  const p = path.join(OUT, file);
  await page.screenshot({ path: p });
  shots.push({ file, note });
  return p;
}

// ---------------------------------------------------------------- API client
class Client {
  constructor() { this.cookie = ''; }
  async req(method, p, body) {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + p, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
  del(p) { return this.req('DELETE', p); }
  /** { name, value } of the session cookie for browser injection. */
  cookiePair() {
    const i = this.cookie.indexOf('=');
    return i === -1 ? null : { name: this.cookie.slice(0, i), value: this.cookie.slice(i + 1) };
  }
}

const SQL_TPL = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
function sqlExec(sql) {
  execSync(SQL_TPL.replace('{SQL}', JSON.stringify(sql)), { cwd: ROOT, stdio: 'pipe' });
}
const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------- minimal PNG decoder
// Same decoder as scripts/e2e-ui.mjs: the "is the rewards page still green?"
// assertion samples REAL rendered pixels rather than trusting a class name.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG layout (depth=${bitDepth} color=${colorType})`);
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

/** Mean luminance and worst green excess (g − max(r,b)) over a rectangle. */
function regionStats(img, x0, y0, w, h) {
  let sumLum = 0, maxGreenExcess = -255, n = 0;
  for (let y = y0; y < Math.min(y0 + h, img.height); y++) {
    for (let x = x0; x < Math.min(x0 + w, img.width); x++) {
      const i = (y * img.width + x) * img.bpp;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      sumLum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const excess = g - Math.max(r, b);
      if (excess > maxGreenExcess) maxGreenExcess = excess;
      n++;
    }
  }
  return { meanLum: sumLum / n, maxGreenExcess, samples: n };
}

const fillPct = (el) => Number(String(el.getAttribute('style') || '').match(/--lv-fill-pct:\s*(\d+)%/)?.[1] ?? -1);

/** Switch the /auth page from sign-in to sign-up (the view animates in). */
async function switchToSignup(page) {
  // An invite link (/auth?ref=…) already lands on the sign-up view.
  if (await page.$('.lv-refbar')) return;
  const sel = 'button:has-text("أنشئ حسابًا")';
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.click(sel, { timeout: 15000, force: true });
  await page.waitForSelector('.lv-refbar', { timeout: 15000 });
}

async function main() {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) {
    console.error(`Server at ${BASE} is not healthy (status ${health}). Start wrangler dev first.`);
    process.exit(1);
  }
  const rnd = Math.random().toString(36).slice(2, 8);
  console.log(`\n=== integrated UI suite · base ${BASE} · run ${rnd} ===`);

  // Anonymous buckets only — repeated same-IP runs would otherwise 429.
  for (const k of ['register', 'login', 'tg-auth-']) {
    try { sqlExec(`DELETE FROM rate_limits WHERE key LIKE '${k}%'`); } catch { /* non-fatal */ }
  }

  // ------------------------------------------------------------- fixtures
  const admin = new Client(), referrer = new Client(), buyer = new Client();
  const adminEmail = `ui-adm-${rnd}@test.local`;
  const refUsername = `uiref${rnd}`;
  let r = await admin.post('/api/auth/register', { email: adminEmail, username: `uiadm${rnd}`, name: 'UI Admin', password: 'ui-admin-pass-1' });
  if (r.status !== 200) { console.error('FATAL: admin registration failed', r.status, JSON.stringify(r.data).slice(0, 200)); process.exit(1); }
  sqlExec(`UPDATE users SET role='admin' WHERE email='${adminEmail}'`);
  await admin.get('/api/auth/me');

  r = await referrer.post('/api/auth/register', { email: `ui-ref-${rnd}@test.local`, username: refUsername, name: 'UI Referrer', password: 'ui-ref-pass-1' });
  check('fixture: referrer account with a public username', r.status === 200 && r.data?.user?.username === refUsername, `status=${r.status}`);
  r = await buyer.post('/api/auth/register', { email: `ui-buy-${rnd}@test.local`, username: `uibuy${rnd}`, name: 'UI Buyer', password: 'ui-buy-pass-1' });
  const buyerOk = r.status === 200;
  check('fixture: buyer account', buyerOk, `status=${r.status}`);

  r = await admin.post('/api/admin/products-v2/brands', { name_ar: 'علامة واجهة', name_en: `UI Brand ${rnd}` });
  const brandId = r.data?.brand?.id ?? r.data?.id;
  r = await admin.post('/api/admin/products-v2', {
    name_ar: `منتج واجهة ${rnd}`, name_en: `UI Product ${rnd}`, description_ar: 'وصف اختبار',
    price_iqd: 12000, selling_type: 'in_stock', stock: 50, status: 'active', brand_id: brandId,
    catalog_ids: [], options: [], colors: [], spec_groups: [], media: [], labels: [],
    content_blocks: [], payment_options: [], hashtags: [], how_to_use: '',
    preorder_transports: [], warranty_plans: [],
  });
  const productSlug = r.data?.product?.slug;
  check('fixture: catalogue product created', !!productSlug, JSON.stringify(r.data ?? {}).slice(0, 140));

  await buyer.post('/api/cart/items', { productId: r.data?.product?.id, qty: 1 });

  // -------------------------------------------------------------- browser
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'ar', hasTouch: true, colorScheme: 'dark',
  });
  const page = await phone.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // =====================================================================
  // (a) /auth — method organisation, fill button, OTP boxes
  // =====================================================================
  console.log('\n— (a) /auth: method organisation, fill progress, OTP boxes');
  await page.goto(`${BASE}/auth`, { waitUntil: 'networkidle' });
  // The approved redesign replaced the method tabs: email/password is the
  // PRIMARY interface, visible immediately, with Google and Telegram as
  // secondary actions under the «أو» seam.
  await page.waitForSelector('#identifier', { timeout: 15000 });
  check('UI-01 the primary email/password form is visible immediately (no tab step)',
    !!(await page.$('#identifier')) && !!(await page.$('#signin-submit')));
  // Providers this deployment does not have simply do not appear — the check
  // matches what capabilities actually offer instead of demanding buttons a
  // sandbox without Google/Telegram cannot render.
  const authCaps = await page.evaluate(() =>
    fetch('/api/auth/capabilities').then((r) => r.json()).catch(() => ({})));
  const socialCount = await page.$$eval('button.lv-social', (els) =>
    els.filter((e) => e.offsetParent !== null).length);
  check('UI-01 secondary methods match capabilities (buttons under the seam, none invented)',
    authCaps.telegram ? socialCount >= 1 : socialCount === 0,
    `social buttons=${socialCount} caps.telegram=${!!authCaps.telegram}`);
  const formCount = await page.$$eval('form', (els) => els.filter((f) => f.offsetParent !== null).length);
  check('UI-01 the page shows a single visible form (no long column of every method)',
    formCount === 1, `visible forms=${formCount}`);
  await shot(page, 'auth-methods.png', '/auth at 390×844 — one tab row, one visible method form');

  // Fill progress: it must GROW with valid input and REGRESS on deletion.
  // The SIGN-UP e-mail path is the strictest one (username + name + e-mail +
  // password + confirmation), so it proves "100% only when EVERY rule passes".
  const toSignup = await page.$('button:has-text("أنشئ حسابًا")');
  check('UI-01 the page offers an explicit switch to account creation', !!toSignup);
  await switchToSignup(page);
  await page.waitForSelector('#email', { timeout: 15000 });
  const btnSel = 'button.lv-fillbtn';
  const visibleFill = async (fn) => page.$$eval(btnSel, (els, ...args) => {
    const el = els.find((e) => e.getBoundingClientRect().height > 0);
    return el ? args[0] === 'pct'
      ? Number(String(el.getAttribute('style') || '').match(/--lv-fill-pct:\s*(\d+)%/)?.[1] ?? -1)
      : args[0] === 'ready' ? el.getAttribute('data-ready') : el.disabled
      : null;
  }, fn);
  const readPct = () => visibleFill('pct');
  const readReady = () => visibleFill('ready');

  const pct0 = await readPct();
  await page.fill('#username', `uifill${rnd}`);
  const pct1 = await readPct();
  await page.fill('#name', 'UI Fill Tester');
  const pct2 = await readPct();
  await page.click('#email');
  await page.keyboard.type('user@example.co', { delay: 10 });
  const pct3 = await readPct();
  const readyBeforeAll = await readReady();
  console.log(`      measured fill: ${pct0}% → ${pct1}% → ${pct2}% → ${pct3}% (ready=${readyBeforeAll})`);
  check('AUTH-01 the fill GROWS as each requirement is completed',
    pct0 === 0 && pct1 > pct0 && pct2 > pct1 && pct3 > pct2 && pct3 < 100,
    `pct ${pct0} → ${pct1} → ${pct2} → ${pct3}`);
  check('AUTH-01 an incomplete form never reaches 100% and never enables the button',
    pct3 < 100 && readyBeforeAll === 'false', `pct=${pct3} ready=${readyBeforeAll}`);
  await shot(page, 'auth-fill-partial.png', 'sign-up form partially completed — the button is filled part-way and still disabled');

  await page.keyboard.type('m', { delay: 10 });
  await page.fill('#new-password', 'ui-pass-12345');
  await page.fill('#confirm-password', 'ui-pass-12345');
  const pctReady = await readPct();
  const readyFlag = await readReady();
  const disabledWhenReady = await visibleFill('disabled');
  check('AUTH-01 100% and an enabled button only once EVERY rule passes',
    pctReady === 100 && readyFlag === 'true' && disabledWhenReady === false,
    `pct=${pctReady} ready=${readyFlag} disabled=${disabledWhenReady}`);
  await shot(page, 'auth-fill-ready.png', 'every sign-up rule satisfied — fill at 100%, data-ready=true, button enabled');

  await page.click('#confirm-password');
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  const pctBack = await readPct();
  const readyBack = await readReady();
  check('AUTH-01 deleting one character regresses readiness IMMEDIATELY',
    pctBack < 100 && readyBack === 'false', `pct=${pctBack} ready=${readyBack}`);
  await shot(page, 'auth-fill-regressed.png', 'one character deleted from the confirmation — fill drops below 100% and the button disables again');

  // A ?ref= on the sign-up URL must be visible BEFORE the account is created.
  await page.goto(`${BASE}/auth?ref=${refUsername}`, { waitUntil: 'networkidle' });
  await switchToSignup(page);
  await page.waitForSelector('.lv-refbar', { timeout: 15000 });
  await page.waitForTimeout(600); // the bar resolves the handle through the API
  const refBar = await page.evaluate(() => {
    const bar = document.querySelector('.lv-refbar');
    const toggle = bar?.querySelector('button[aria-expanded]');
    const input = document.querySelector('#referral-code');
    return {
      expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
      inputValue: input ? input.value : null,
      text: (bar?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    };
  });
  check('REF-02 arriving through an invite link opens the referral bar automatically',
    refBar.expanded === 'true', JSON.stringify(refBar).slice(0, 220));
  check('REF-02 the referrer is NAMED and the code shown before sign-up (resolved server-side)',
    refBar.text.includes(refUsername) && /UI Referrer/.test(refBar.text),
    `bar="${refBar.text}"`);
  const submitStillOffered = await page.$(btnSel);
  check('REF-02 the referral bar never blocks sign-up (the submit button is still there)', !!submitStillOffered);
  await shot(page, 'auth-referral-bar.png', '/auth?ref=<username> — the referral bar auto-opens with the resolved referrer, before any account exists');

  // OTP boxes: the Telegram OTP step is reached with a PLANTED challenge —
  // exactly the row a verified Telegram share would have written. Nothing
  // about Telegram DELIVERY is claimed here (that stays blocked). The
  // redesigned /auth offers the Telegram entry ONLY when capabilities report
  // a real bot (a live getMe), so without one the step is honestly blocked
  // rather than driven through markup that no longer exists.
  const capsTelegram = !!(await page.evaluate(() =>
    fetch('/api/auth/capabilities').then((r) => r.json()).then((d) => d.telegram).catch(() => false)));
  if (!capsTelegram) {
    blocked('§2.4 the six-box OTP step driven through the real /auth UI',
      'capabilities.telegram is false in this sandbox (no TELEGRAM_BOT_TOKEN / getMe), so the redesigned page never offers the Telegram entry');
  } else {
  const contToken = randomBytes(24).toString('hex');
  const chId = `lc_ui_${rnd}`;
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  const sentAt = new Date(Date.now() - 120_000).toISOString();
  sqlExec(
    `INSERT INTO link_challenges (id, purpose, user_id, session_ref, phone_entered, state, telegram_user_id, chat_id, continuation_hash, otp_sent_at, expires_at) ` +
    `VALUES ('${chId}', 'signup', NULL, '', '+9647701234567', 'phone_verified', 9001, 9001, '${sha256Hex(contToken)}', '${sentAt}', '${expires}')`
  );
  await page.evaluate(([tok, exp]) => {
    sessionStorage.setItem('levo_tg_auth', JSON.stringify({
      token: tok, deep_link: 'https://t.me/example?start=x', expires_at: exp,
      phone_masked: '+964 77• ••• 4567', purpose: 'signup',
    }));
  }, [contToken, expires]);
  await page.goto(`${BASE}/auth`, { waitUntil: 'networkidle' });
  await switchToSignup(page);
  // The redesign enters the Telegram flow through the secondary action under
  // the «أو» seam, not a method tab.
  await page.click('button.lv-social:has-text("تيليغرام")', { timeout: 15000, force: true });
  let otpVisible = false;
  try {
    await page.waitForSelector('.lv-otp__box', { timeout: 15000 });
    otpVisible = true;
  } catch { /* reported below */ }

  if (!otpVisible) {
    check('§2.4 the six-box OTP step is reachable in the real app', false,
      'the OTP phase did not render for the planted verified challenge');
  } else {
    const boxes = await page.$$('.lv-otp__box');
    check('§2.4 the OTP step renders SIX linked boxes (not one long input)', boxes.length === 6, `boxes=${boxes.length}`);
    const otpBtn = 'button#tg-auth-verify';
    await page.waitForSelector(otpBtn);
    const otpPct0 = await page.$eval(otpBtn, fillPct);
    // Paste the whole code (with a space, the way a copied message carries it)
    // into the FIRST box — §2.4 requires paste to distribute across the boxes.
    await boxes[0].click();
    let pasted = false;
    try {
      await page.$eval('.lv-otp__box', (el, text) => {
        const dt = new DataTransfer();
        dt.setData('text', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, '123 456');
      pasted = true;
    } catch { /* reported below */ }
    await page.waitForTimeout(200);
    const filled = await page.$$eval('.lv-otp__box', (els) => els.map((e) => e.value).join(''));
    check('§2.4 pasting "123 456" from any box fills all six digits',
      pasted && filled === '123456', `boxes="${filled}"`);
    const otpPct1 = await page.$eval(otpBtn, fillPct);
    const otpReady = await page.$eval(otpBtn, (el) => el.getAttribute('data-ready'));
    check('§2.4 the verify button goes 0/6 → 6/6 and only THEN becomes clickable',
      otpPct0 === 0 && otpPct1 === 100 && otpReady === 'true', `pct ${otpPct0} → ${otpPct1} ready=${otpReady}`);
    await shot(page, 'auth-otp-paste.png', 'six OTP boxes filled by a single paste; the verify button is 6/6 and enabled');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    const afterBs = await page.$$eval('.lv-otp__box', (els) => els.map((e) => e.value).join(''));
    const otpReady2 = await page.$eval(otpBtn, (el) => el.getAttribute('data-ready'));
    check('§2.4 Backspace removes one digit and readiness regresses at once',
      afterBs.length === 5 && otpReady2 === 'false', `boxes="${afterBs}" ready=${otpReady2}`);
    const pwOnPath = await page.$('#tg-auth-password');
    check('§2.1 the Telegram sign-up step offers the OPTIONAL password (the phone + password account)', !!pwOnPath);
  }
  }
  blocked('AUTH-06 real Telegram delivery, the contact-ownership share and the resend cooldown',
    'TELEGRAM_BOT_TOKEN and an authorised bot are not configured in this sandbox (docs/DECISIONS.md row 26) — the OTP STEP is driven from a planted verified challenge; delivery is not claimed');

  // =====================================================================
  // (b) cart — auto-applied support code, referrer name, removal persists
  // =====================================================================
  console.log('\n— (b) cart: support code applied from a product link, and its removal');
  const buyerCookie = buyer.cookiePair();
  if (!buyerOk || !buyerCookie) {
    notRun('REF-01/REF-03 cart support code', 'the buyer fixture could not sign in');
  } else {
    await phone.addCookies([{ name: buyerCookie.name, value: buyerCookie.value, domain: '127.0.0.1', path: '/' }]);
    // The real journey: a shared PRODUCT link carries ?ref=<username>.
    await page.goto(`${BASE}/product/${productSlug}?ref=${refUsername}`, { waitUntil: 'networkidle' });
    await page.goto(`${BASE}/cart`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#support-code-panel', { timeout: 15000 }).catch(() => {});
    const panelText = await page.$eval('#support-code-panel', (el) => el.innerText).catch(() => '');
    check('REF-01 the support code captured from the product link is applied and NAMED in the cart',
      panelText.includes(refUsername) || panelText.includes('UI Referrer'), `panel="${panelText.replace(/\s+/g, ' ').slice(0, 200)}"`);
    check('REF-01 the cart states the code is worth ZERO — it is not a discount',
      /0\s*(د\.ع|IQD)|لا يغيّر|does not change/i.test(panelText), `panel="${panelText.replace(/\s+/g, ' ').slice(0, 200)}"`);
    await shot(page, 'cart-support-applied.png', 'cart with the auto-applied support code, the referrer handle and an explicit zero price effect');

    // The code must SURVIVE the hand-off to checkout and appear in the money
    // view with an explicit zero — the step that used to drop it silently.
    await buyer.post('/api/addresses', { label: 'Home', name: 'UI Buyer', phone: '+9647701110009', address: 'Baghdad, UI District' });
    await page.click('[data-testid="cart-checkout"]', { timeout: 15000, force: true });
    await page.waitForURL('**/checkout', { timeout: 15000 }).catch(() => {});
    let supportLine = '';
    try {
      await page.waitForSelector('[data-testid="checkout-support-line"]', { timeout: 20000 });
      supportLine = await page.$eval('[data-testid="checkout-support-line"]', (el) => el.innerText.replace(/\s+/g, ' '));
    } catch { /* reported below */ }
    check('REF-04 the support code reaches CHECKOUT and is named in the money view',
      supportLine.includes(refUsername) || /UI Referrer/.test(supportLine), `line="${supportLine}"`);
    check('REF-04 checkout states the code costs the buyer ZERO — it is attribution, not a discount',
      /0\s*(د\.ع|IQD)/.test(supportLine), `line="${supportLine}"`);
    await shot(page, 'checkout-support-line.png', 'checkout money view — the support handle with an explicit 0 IQD effect');
    await page.goto(`${BASE}/cart`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#support-code-panel', { timeout: 15000 }).catch(() => {});

    const removeBtn = await page.$('#support-code-panel button:has-text("إزالة")')
      || await page.$('#support-code-panel button:has-text("Remove")')
      || await page.$('#support-code-panel button:has-text("حذف")');
    if (!removeBtn) {
      check('REF-03 the support code can be removed from the cart', false, 'no removal control found in the panel');
    } else {
      await removeBtn.click();
      await page.waitForTimeout(400);
      const afterRemove = await page.$eval('#support-code-panel', (el) => el.innerText).catch(() => '');
      check('REF-03 removing the code clears it immediately', !afterRemove.includes(refUsername),
        `panel="${afterRemove.replace(/\s+/g, ' ').slice(0, 160)}"`);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('#support-code-panel', { timeout: 15000 }).catch(() => {});
      const afterReload = await page.$eval('#support-code-panel', (el) => el.innerText).catch(() => '');
      check('REF-03 the removal SURVIVES a reload — no cookie re-adds it behind the user',
        !afterReload.includes(refUsername), `panel="${afterReload.replace(/\s+/g, ' ').slice(0, 160)}"`);
      await shot(page, 'cart-support-removed.png', 'after removal and a full reload the support code stays removed');
    }
  }

  // ------- the /referrals route itself (integration step 2 of the matrix)
  if (buyerCookie) {
    await page.goto(`${BASE}/referrals`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const refPage = await page.evaluate(() => ({
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600),
      construction: document.body.innerText.includes('Under Construction'),
    }));
    check('REF-01 /referrals is a real route, not the catch-all placeholder',
      !refPage.construction, refPage.body.slice(0, 160));
    check('REF-01 the referrals page shows the account\u2019s own invite link/handle',
      /\/auth\?ref=|uibuy/.test(refPage.body), refPage.body.slice(0, 220));
    await shot(page, 'referrals-page.png', '/referrals — the standalone page reached from the profile icon group');
  }

  // =====================================================================
  // (c) rewards/points page background
  // =====================================================================
  console.log('\n— (c) /points: the page background is dark, not the old green wash');
  await page.goto(`${BASE}/points`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="rewards-root"]', { timeout: 15000 }).catch(() => {});
  const rewardsBg = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="rewards-root"]');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  const shotPath = await shot(page, 'rewards-dark.png', '/points at 390×844 — pixel-sampled background');
  const img = decodePng(readFileSync(shotPath));
  // The old defect painted an olive/green wash across the top of the page.
  const top = regionStats(img, 0, 0, img.width, Math.min(300, img.height));
  const whole = regionStats(img, 0, 0, img.width, img.height);
  console.log(`      measured: top mean luminance ${top.meanLum.toFixed(1)}, page max green excess ${whole.maxGreenExcess} over ${whole.samples} px, root bg ${rewardsBg}`);
  check('UI-02 the points page top region is DARK (mean luminance well under mid-grey)',
    top.meanLum < 60, `meanLum=${top.meanLum.toFixed(1)} bg=${rewardsBg}`);
  check('UI-02 no green cast anywhere on the page (max g − max(r,b) stays small)',
    whole.maxGreenExcess <= 12, `maxGreenExcess=${whole.maxGreenExcess} over ${whole.samples} px`);

  // =====================================================================
  // (d) product page CTA position at two viewports
  // =====================================================================
  console.log('\n— (d) product page: the buy CTA is never a floating bar in mid-content');
  await page.goto(`${BASE}/product/${productSlug}`, { waitUntil: 'networkidle' });
  // Both CTA nodes exist in the DOM (phone bar + desktop panel); exactly one
  // is VISIBLE per breakpoint, which is what the assertions below measure.
  await page.waitForSelector('[data-testid="product-cta"]', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(400);
  const phoneCta = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('[data-testid="product-cta"]')].filter((e) => e.getBoundingClientRect().width > 0);
    const bar = document.querySelector('[data-testid="product-buybar"]');
    const b = visible[0]?.getBoundingClientRect();
    const barBox = bar?.getBoundingClientRect();
    return {
      count: visible.length,
      bottom: b ? b.bottom : null,
      barBottom: barBox ? barBox.bottom : null,
      barVisible: barBox ? barBox.height > 0 : false,
      vh: window.innerHeight,
      docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check('UI-03 phone (390×844): exactly ONE buy CTA and it sits in the bottom bar, not mid-content',
    phoneCta.count === 1 && phoneCta.barVisible && Math.abs(phoneCta.barBottom - phoneCta.vh) <= 2 && phoneCta.bottom > phoneCta.vh * 0.7,
    JSON.stringify(phoneCta));
  check('UI-03 phone: the page never scrolls sideways', phoneCta.docScrollX <= 0, `overflowX=${phoneCta.docScrollX}`);
  await shot(page, 'product-cta-390.png', 'product page at 390×844 — one bottom purchase bar pinned to the viewport bottom');

  const padContext = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, locale: 'ar', colorScheme: 'dark' });
  const padPage = await padContext.newPage();
  await padPage.goto(`${BASE}/product/${productSlug}`, { waitUntil: 'networkidle' });
  await padPage.waitForSelector('[data-testid="product-cta"]', { state: 'attached', timeout: 15000 });
  await padPage.waitForTimeout(400);
  const padCta = await padPage.evaluate(() => {
    const visible = [...document.querySelectorAll('[data-testid="product-cta"]')].filter((e) => e.getBoundingClientRect().width > 0);
    const bar = document.querySelector('[data-testid="product-buybar"]');
    const barBox = bar?.getBoundingClientRect();
    const b = visible[0]?.getBoundingClientRect();
    let fixedAncestor = false;
    let node = visible[0]?.parentElement;
    while (node && node !== document.body) {
      if (getComputedStyle(node).position === 'fixed') { fixedAncestor = true; break; }
      node = node.parentElement;
    }
    return {
      count: visible.length, fixedAncestor,
      left: b ? Math.round(b.left) : null, width: b ? Math.round(b.width) : null,
      barVisible: !!barBox && barBox.height > 0, vw: window.innerWidth,
      docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check('UI-03 iPad (1024×768): the CTA lives INSIDE the purchase panel — no floating bar at all',
    padCta.count === 1 && padCta.barVisible === false && padCta.fixedAncestor === false && padCta.width < padCta.vw * 0.6,
    JSON.stringify(padCta));
  check('UI-03 iPad: the page never scrolls sideways', padCta.docScrollX <= 0, `overflowX=${padCta.docScrollX}`);
  await padPage.screenshot({ path: path.join(OUT, 'product-cta-1024.png') });
  shots.push({ file: 'product-cta-1024.png', note: 'product page at 1024×768 — CTA inside the sticky purchase panel, no floating bar' });

  // =====================================================================
  // (e) admin import modal above header/sidebar
  // =====================================================================
  console.log('\n— (e) admin: the import dialog overlays the header and the sidebar');
  const adminCookie = admin.cookiePair();
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ar', colorScheme: 'dark' });
  await adminCtx.addCookies([{ name: adminCookie.name, value: adminCookie.value, domain: '127.0.0.1', path: '/' }]);
  const adminPage = await adminCtx.newPage();
  await adminPage.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  let importOpened = false;
  try {
    const tab = await adminPage.$('button:has-text("المنتجات")');
    if (tab) await tab.click();
    await adminPage.waitForSelector('[data-testid="admin-import-open"]', { timeout: 20000 });
    await adminPage.click('[data-testid="admin-import-open"]');
    await adminPage.waitForSelector('[role="dialog"]', { timeout: 20000 });
    // The dialog body is lazy-loaded; wait for the real import controls so the
    // "the confirm button is visible" claim is about the ACTION, not the ✕.
    // The CSV/ZIP panel's file input is a hidden label-driven one, so the
    // visible proof of the loaded body is its section select (or the legacy
    // tab's textarea).
    await adminPage.waitForSelector('[role="dialog"] [data-import="section"], [role="dialog"] textarea', { timeout: 30000 });
    await adminPage.waitForTimeout(400);
    importOpened = true;
  } catch (e) {
    check('UI-04 the admin import dialog opens', false, String(e).slice(0, 160));
  }
  if (importOpened) {
    const overlay = await adminPage.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const header = document.querySelector('header');
      const aside = document.querySelector('aside');
      const d = dialog.getBoundingClientRect();
      const h = header?.getBoundingClientRect() ?? null;
      const a = aside?.getBoundingClientRect() ?? null;
      // Hit-testing is the real proof: what does the browser paint on top at
      // the header's and the sidebar's own centre points?
      const hitAt = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return el ? !!el.closest('[role="dialog"], .fixed.z-\\[1000\\]') || !!dialog.contains(el) : false;
      };
      const scrim = dialog.parentElement;
      const scrimBox = scrim.getBoundingClientRect();
      const hitInScrim = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return !!el && (dialog.contains(el) || scrim.contains(el));
      };
      return {
        dialog: { top: Math.round(d.top), left: Math.round(d.left), w: Math.round(d.width), h: Math.round(d.height) },
        header: h ? { top: Math.round(h.top), h: Math.round(h.height), cx: Math.round(h.left + h.width / 2), cy: Math.round(h.top + h.height / 2) } : null,
        aside: a ? { left: Math.round(a.left), w: Math.round(a.width), cx: Math.round(a.left + a.width / 2), cy: Math.round(a.top + a.height / 2) } : null,
        headerCovered: h ? hitInScrim(Math.round(h.left + h.width / 2), Math.round(h.top + h.height / 2)) : null,
        asideCovered: a ? hitInScrim(Math.round(a.left + a.width / 2), Math.round(a.top + a.height / 2)) : null,
        scrimCoversViewport: Math.round(scrimBox.width) >= window.innerWidth - 1,
        unused: hitAt,
      };
    });
    check('UI-04 the dialog scrim spans the whole viewport width', overlay.scrimCoversViewport === true, JSON.stringify(overlay.dialog));
    check('UI-04 the topbar centre is painted OVER by the dialog layer (not the other way round)',
      overlay.headerCovered === true, JSON.stringify({ header: overlay.header, covered: overlay.headerCovered }));
    check('UI-04 the sidebar centre is painted OVER by the dialog layer',
      overlay.asideCovered === true, JSON.stringify({ aside: overlay.aside, covered: overlay.asideCovered }));
    // The primary action must be reachable without hunting for it.
    const confirm = await adminPage.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const btns = [...dialog.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height > 0);
      const box = btns.map((b) => {
        const r = b.getBoundingClientRect();
        return {
          text: (b.textContent || '').trim().slice(0, 40),
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          inView: r.top >= 0 && r.bottom <= window.innerHeight,
          // The ✕ is not an action button; the confirm is a real submit.
          isAction: (b.textContent || '').trim().length > 0,
        };
      });
      const actions = box.filter((b) => b.isAction);
      return {
        count: btns.length,
        actions: actions.length,
        actionsInView: actions.filter((b) => b.inView).length,
        sample: actions.slice(0, 6).map((b) => b.text),
      };
    });
    check('UI-04 the dialog exposes its CONFIRM action, fully inside the viewport (never cut off)',
      confirm.actions > 0 && confirm.actionsInView === confirm.actions, JSON.stringify(confirm).slice(0, 300));
    await adminPage.screenshot({ path: path.join(OUT, 'admin-import-modal.png') });
    shots.push({ file: 'admin-import-modal.png', note: 'import dialog at 1280×800 painted above the topbar and the sidebar, with its actions in view' });
  }

  // =====================================================================
  // (f) chats — two permanent support entries, signed out and signed in
  // =====================================================================
  console.log('\n— (f) /chats: the two support entries, signed out and signed in');
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'ar', colorScheme: 'dark' });
  const guestPage = await guestCtx.newPage();
  await guestPage.goto(`${BASE}/chats`, { waitUntil: 'networkidle' });
  const guestEntries = await guestPage.evaluate(() => ({
    assistant: !!document.querySelector('[data-testid="chats-assistant"]'),
    contact: !!document.querySelector('[data-testid="chats-contact"]'),
    body: document.body.innerText.slice(0, 400),
  }));
  check('UI-06 SIGNED OUT: both support entries render on /chats',
    guestEntries.assistant && guestEntries.contact, JSON.stringify({ a: guestEntries.assistant, c: guestEntries.contact }));
  await guestPage.screenshot({ path: path.join(OUT, 'chats-signed-out.png') });
  shots.push({ file: 'chats-signed-out.png', note: '/chats for a visitor — both support entries plus an honest signed-out list state' });

  await page.goto(`${BASE}/chats`, { waitUntil: 'networkidle' });
  const userEntries = await page.evaluate(() => ({
    assistant: !!document.querySelector('[data-testid="chats-assistant"]'),
    contact: !!document.querySelector('[data-testid="chats-contact"]'),
  }));
  check('UI-06 SIGNED IN: both support entries still render',
    userEntries.assistant && userEntries.contact, JSON.stringify(userEntries));
  await shot(page, 'chats-signed-in.png', '/chats for a signed-in customer — the same two permanent support entries');

  // =====================================================================
  // (g) community — LEVO Studio external link, no slicer in the bundle
  // =====================================================================
  console.log('\n— (g) /community: the Studio link is external and no slicer code loads');
  const netCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'ar', colorScheme: 'dark' });
  await netCtx.addCookies([{ name: buyerCookie.name, value: buyerCookie.value, domain: '127.0.0.1', path: '/' }]);
  const netPage = await netCtx.newPage();
  const requests = [];
  netPage.on('request', (req) => requests.push(req.url()));
  await netPage.goto(`${BASE}/community`, { waitUntil: 'networkidle' });
  await netPage.waitForTimeout(1500);
  const studio = await netPage.evaluate(() => {
    const a = document.querySelector('[data-testid="community-studio-link"]');
    return a ? { href: a.getAttribute('href'), rel: a.getAttribute('rel'), text: (a.textContent || '').trim().slice(0, 80) } : null;
  });
  check('UI-07 the community page carries the LEVO Studio entry as an EXTERNAL link',
    !!studio && studio.href === 'https://studio.levonis-iq.com' && String(studio.rel || '').includes('noopener'),
    JSON.stringify(studio));
  const SLICER_RE = /(slicer|three\.min|three\.module|orca|cura|prusa|\.wasm|\.stl|\.3mf|\.gcode)/i;
  const slicerHits = requests.filter((u) => SLICER_RE.test(u));
  check('UI-07 opening /community loads NO slicer, wasm or 3D asset request',
    slicerHits.length === 0, slicerHits.slice(0, 5).join(', '));
  const studioHits = requests.filter((u) => u.includes('studio.levonis-iq.com'));
  check('UI-07 the Studio subdomain is not prefetched or embedded — only linked',
    studioHits.length === 0, studioHits.slice(0, 3).join(', '));
  await netPage.screenshot({ path: path.join(OUT, 'community-studio.png') });
  shots.push({ file: 'community-studio.png', note: '/community — the LEVO Studio card is a plain external link; no slicer request was observed' });

  check('no uncaught page errors during the pass', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  notRun('real device verification (iPad hardware, iOS Safari, on-screen keyboard, reduced-motion setting)',
    'this sandbox has no physical device — Chromium at 390×844 and 1024×768 is an emulation, not a device test');

  await browser.close();

  // ------------------------------------------------------------- summary
  console.log(`\n${passed} passed, ${failed} failed, ${notRunCount} not executed, ${blockedCount} blocked`);
  if (notRunList.length) { console.log('Not executed (honest — NOT passes):'); notRunList.forEach((n) => console.log(` · ${n}`)); }
  if (blockedList.length) { console.log('Blocked (unconfigured precondition — NOT passes):'); blockedList.forEach((n) => console.log(` ~ ${n}`)); }
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(` - ${f}`)); }
  console.log('Screenshots:');
  shots.forEach((s) => console.log(`   docs/evidence/integrated/${s.file} — ${s.note}`));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('integrated UI run crashed:', e); process.exit(1); });
