#!/usr/bin/env node
/**
 * v4 API verification — INTEGRATED mandate (accounts, referrals & support
 * codes, points, wallet, unified payment policy). Runs after
 * scripts/api-tests.mjs, api-tests-v2.mjs and api-tests-v3.mjs against the
 * same base (local `wrangler dev` or an isolated staging worker).
 *
 * Same contracts as v2/v3:
 *   - cookie-jar Client, fresh random synthetic users per run (rate limits
 *     key per USER on authenticated endpoints, per IP when anonymous),
 *   - PROMOTE_CMD as the test-only SQL side door ({SQL} placeholder +
 *     JSON.stringify quoting) for states no API may create,
 *   - the anonymous register bucket is cleared at start so re-runs stay
 *     reproducible,
 *   - policy-acceptance tolerance: every checkout attaches whatever
 *     versions are currently required for checkout.
 *
 * MANDATE §14 REPORTING — FOUR buckets, never three:
 *   passed · failed · NOT-EXECUTED (غير منفذ) · BLOCKED with a reason
 *     (محجوب مع السبب).
 * A precondition that is honestly unconfigured (no TELEGRAM_BOT_TOKEN, no
 * EMAIL_API_KEY, an owner decision that has not been made) is BLOCKED — it
 * is never counted as a pass. A check whose subject is a browser-only
 * behaviour, or whose route is not mounted yet, is NOT-EXECUTED with the
 * reason printed. Only real, observed server behaviour passes.
 *
 * Fixtures are SYNTHETIC only — no real identity data, no real money, no
 * product that a production shopper could see (every name carries the run id).
 *
 * The mandated §5 arithmetic is asserted digit by digit:
 *   merchandise 75,000 · points 739 → 74,261 · delivery 5,000 · total 79,261
 *   wallet 30,000 · COD 49,261 · pending points floor(74,261/100) = 742.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';
let passed = 0, failed = 0, blockedCount = 0, notRunCount = 0;
const failures = [];
const blockedList = [];
const notRunList = [];

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`FAIL  ${name} ${extra}`); }
}
/** Honestly unconfigured precondition (secret/owner decision). NOT a pass. */
function blocked(name, reason) {
  blockedCount++;
  blockedList.push(`${name} — ${reason}`);
  console.log(` BLK  ${name} — ${reason}`);
}
/** Not executed in this environment (browser-only, unmounted route). NOT a pass. */
function notRun(name, reason) {
  notRunCount++;
  notRunList.push(`${name} — ${reason}`);
  console.log(` N/R  ${name} — ${reason}`);
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data, text };
  }
  get(p) { return this.req('GET', p); }
  post(p, b, h) { return this.req('POST', p, b, h); }
  put(p, b) { return this.req('PUT', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
}

// ---------------------------------------------------------------- SQL channel
//
// The test-only side door for states NO API may create: promote an admin,
// plant the row a verified Telegram flow would have written, backdate an
// accrual clock, insert the coupon an admin coupon screen would insert (no
// coupon API exists yet — see docs/INTEGRATED_PHASE.md), and rewrite ONE
// accrual to the legacy rule for PTS-07. It never fakes a result the code
// under test is supposed to produce.
function sqlExec(sql) {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(sql)), { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
}
/** Runs SQL that is EXPECTED to fail (constraint proof). true = it failed. */
function sqlFails(sql) {
  try { sqlExec(sql); return false; } catch { return true; }
}
function promoteAdmin(email) {
  sqlExec(`UPDATE users SET role='admin' WHERE email='${email}'`);
}

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
const DAY = 86_400_000;

// 1×1 transparent PNG — valid magic + IHDR, enough for the server's sniffing.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function uploadReceipt(client, name) {
  const form = new FormData();
  form.set('purpose', 'receipt');
  form.set('file', new Blob([PNG_BYTES]), name);
  return client.req('POST', '/api/uploads', form);
}

async function clearCart(client) {
  const r = await client.get('/api/cart');
  for (const it of r.data?.items ?? []) await client.del(`/api/cart/items/${it.id}`);
}

/**
 * Some post-delivery work (the support-gift evaluation) is dispatched with
 * ctx.waitUntil, so it completes shortly AFTER the response. Polling for the
 * observable outcome is honest — it proves the effect happens without a user
 * action — and it is bounded: the caller asserts on whatever the last read
 * returned, so a hook that never runs still fails the check.
 */
async function poll(read, ready, tries = 12, delayMs = 250) {
  let last = await read();
  for (let i = 0; i < tries && !ready(last); i++) {
    await new Promise((res) => setTimeout(res, delayMs));
    last = await read();
  }
  return last;
}

async function deliverOrder(admin, orderId) {
  let last = null;
  for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
    last = await admin.patch(`/api/admin/orders/${orderId}`, { status });
    if (last.status !== 200) return last;
  }
  return last;
}

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const anon = new Client();
  const admin = new Client();
  const buyerMoney = new Client();   // §5 arithmetic, COD gating, refunds
  const buyerPoints = new Client();  // redemption cap + concurrent spend
  const refA = new Client();         // referrer / supported user
  const refB = new Client();         // second referrer (no silent swap)
  const invited = new Client();      // signed up through refA's username link
  const giftBuyer = new Client();    // support-gift entitlement
  const walletUser = new Client();   // deposits, withdrawals, holds
  const otp1 = new Client();
  const otp2 = new Client();
  const phoneUser = new Client();

  console.log(`\n=== v4 integrated-mandate suite · base ${BASE} · run ${rnd} ===`);

  // Repeated same-IP runs can exhaust the anonymous register bucket
  // (30/hour/IP) — clear ONLY that bucket through the SQL channel.
  try { sqlExec("DELETE FROM rate_limits WHERE key LIKE 'register:%'"); } catch { /* non-fatal */ }
  try { sqlExec("DELETE FROM rate_limits WHERE key LIKE 'login:%'"); } catch { /* non-fatal */ }
  try { sqlExec("DELETE FROM rate_limits WHERE key LIKE 'forgot:%'"); } catch { /* non-fatal */ }
  // Same reason for the anonymous Telegram sign-up buckets (6 per 10 minutes
  // per IP): a second run inside the window would answer 429 to the AUTH-04/05
  // phone-validation checks and make a rate limit look like a broken rule.
  // Only these anonymous buckets are cleared — no per-user limit is touched,
  // and the limiter itself is never bypassed at runtime.
  try { sqlExec("DELETE FROM rate_limits WHERE key LIKE 'tg-auth-%'"); } catch { /* non-fatal */ }

  // ------------------------------------------------------------------ setup
  console.log('\n— setup (fresh synthetic users, taxonomy, fixtures)');
  let r = await admin.post('/api/auth/register', { email: `v4adm-${rnd}@test.local`, username: `v4adm${rnd}`, name: 'V4 Admin', password: 'v4-admin-pass-1' });
  if (r.status === 429) {
    console.error('FATAL: registration rate-limited — the register:<ip> bucket is exhausted and the SQL channel could not clear it.');
    process.exit(1);
  }
  check('admin account created', r.status === 200, JSON.stringify(r.data).slice(0, 140));
  promoteAdmin(`v4adm-${rnd}@test.local`);

  for (const [client, tag, name] of [
    [buyerMoney, 'mon', 'V4 Money Buyer'],
    [buyerPoints, 'pts', 'V4 Points Buyer'],
    [refA, 'ra', 'V4 Referrer A'],
    [refB, 'rb', 'V4 Referrer B'],
    [giftBuyer, 'gift', 'V4 Gift Buyer'],
    [walletUser, 'wal', 'V4 Wallet User'],
    [otp1, 'otp1', 'V4 OTP One'],
    [otp2, 'otp2', 'V4 OTP Two'],
    [phoneUser, 'ph', 'V4 Phone User'],
  ]) {
    const res = await client.post('/api/auth/register', {
      email: `v4${tag}-${rnd}@test.local`, username: `v4${tag}${rnd}`, name, password: `v4-${tag}-pass-1`,
    });
    check(`account ${tag} created`, res.status === 200, JSON.stringify(res.data).slice(0, 140));
  }
  const idOf = async (c) => (await c.get('/api/auth/me')).data?.user?.id;
  const buyerMoneyId = await idOf(buyerMoney);
  const buyerPointsId = await idOf(buyerPoints);
  const refAId = await idOf(refA);
  const refBId = await idOf(refB);
  const walletUserId = await idOf(walletUser);
  const otp1Id = await idOf(otp1);
  const otp2Id = await idOf(otp2);
  const phoneUserId = await idOf(phoneUser);
  check('every setup account has a server id', [buyerMoneyId, buyerPointsId, refAId, refBId, walletUserId, otp1Id, otp2Id, phoneUserId].every(Boolean));

  // Published checkout policies (if any) must be accepted by every checkout.
  let ACC = [];
  async function refreshAcceptance() {
    const pr = await anon.get('/api/policies');
    ACC = (pr.data?.policies ?? [])
      .filter((p) => p.required_for_checkout)
      .map((p) => ({ key: p.key, version: p.version }));
  }
  await refreshAcceptance();

  // Taxonomy + fixtures through the canonical products-v2 editor.
  r = await admin.post('/api/admin/products-v2/brands', { name_ar: 'علامة اختبار', name_en: `V4 Brand ${rnd}` });
  const brandId = r.data?.brand?.id ?? r.data?.id;
  r = await admin.post('/api/admin/products-v2/catalogs', { name_ar: 'طابعات اختبار', name_en: `V4 Printers ${rnd}`, is_printer_catalog: true });
  const printerCatalogId = r.data?.catalog?.id ?? r.data?.id;
  check('brand + explicit printer catalog created', !!brandId && !!printerCatalogId, JSON.stringify(r.data ?? {}).slice(0, 140));

  const baseDoc = (nameEn, priceIqd, extra = {}) => ({
    name_ar: `منتج ${nameEn} ${rnd}`, name_en: `${nameEn} ${rnd}`,
    description_ar: 'وصف اختبار', price_iqd: priceIqd,
    selling_type: 'in_stock', stock: 500, status: 'active', brand_id: brandId,
    catalog_ids: [], options: [], colors: [], spec_groups: [],
    media: [], labels: [], content_blocks: [], payment_options: [], hashtags: [], how_to_use: '',
    preorder_transports: [], warranty_plans: [],
    ...extra,
  });
  async function createProduct(nameEn, priceIqd, extra = {}) {
    const res = await admin.post('/api/admin/products-v2', baseDoc(nameEn, priceIqd, extra));
    return { id: res.data?.product?.id, slug: res.data?.product?.slug, status: res.status, data: res.data };
  }
  const p99 = await createProduct('V4-99', 99);
  const p100 = await createProduct('V4-100', 100);
  const p199 = await createProduct('V4-199', 199);
  const p500 = await createProduct('V4-500', 500);
  const p12000 = await createProduct('V4-12000', 12000);
  const p75000 = await createProduct('V4-75000', 75000);
  const pPrinter = await createProduct('V4-Printer', 20000, { catalog_ids: [printerCatalogId] });
  const pAccessory = await createProduct('V4-Accessory', 3000);
  check('fixture products created',
    [p99, p100, p199, p500, p12000, p75000, pPrinter, pAccessory].every((p) => !!p.id),
    JSON.stringify(p99.data ?? {}).slice(0, 160));

  // Addresses (one per buyer that checks out).
  const addrOf = async (client, name, phone, address) =>
    (await client.post('/api/addresses', { label: 'Home', name, phone, address })).data?.id;
  const addrMoney = await addrOf(buyerMoney, 'V4 Money Buyer', '+9647701110001', 'Baghdad, V4 District 1');
  const addrPoints = await addrOf(buyerPoints, 'V4 Points Buyer', '+9647701110002', 'Erbil, V4 District 2');
  const addrGift = await addrOf(giftBuyer, 'V4 Gift Buyer', '+9647701110003', 'Basra, V4 District 3');
  const addrWallet = await addrOf(walletUser, 'V4 Wallet User', '+9647701110004', 'Najaf, V4 District 4');
  check('addresses created', !!addrMoney && !!addrPoints && !!addrGift && !!addrWallet);

  const quote = (client, body) => client.post('/api/orders/quote', {
    deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], ...body,
  });
  const order = (client, body) => client.post('/api/orders', {
    deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [],
    policyAcceptance: ACC, ...body,
  });
  const pointsOf = async (client) => (await client.get('/api/wallet')).data?.balances?.points_settled;
  const centsOf = async (client) => (await client.get('/api/wallet')).data?.balances;

  // ================================================================ §14.1 AUTH
  console.log('\n— §14.1 accounts and sign-up methods (AUTH-02..05)');

  // AUTH-02 — email shapes. The mandate names these three as VALID and
  // forbids hardcoding com/ru or a fixed TLD length.
  for (const [addr, label] of [
    [`v4mail-${rnd}@example.com`, 'user@example.com'],
    [`v4mailru-${rnd}@example.ru`, 'user@example.ru'],
    [`v4name+tag-${rnd}@sub.example.co.uk`, 'name+tag@sub.example.co.uk'],
  ]) {
    const c = new Client();
    const res = await c.post('/api/auth/register', { email: addr, name: 'V4 Mail Shape', password: 'v4-mail-pass-1' });
    check(`AUTH-02 valid email accepted: ${label}`, res.status === 200, `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  }
  for (const [addr, label] of [
    [`v4bad-${rnd}.example.com`, 'missing @'],
    [`v4bad-${rnd}@nodot`, 'domain without a dot'],
    [`v4bad-${rnd}@.com`, 'empty domain label'],
    [`v4 bad-${rnd}@example.com`, 'space in the local part'],
  ]) {
    const c = new Client();
    const res = await c.post('/api/auth/register', { email: addr, name: 'V4 Bad Mail', password: 'v4-mail-pass-1' });
    check(`AUTH-02 malformed email rejected: ${label}`, res.status === 400, `status=${res.status}`);
  }
  // Non-enumeration: recovery answers identically for a known and an unknown
  // address (mandate §2.5 / §14.1 "never reveal whether an account exists").
  const known = await anon.post('/api/auth/forgot-password', { email: `v4mon-${rnd}@test.local` });
  const unknown = await anon.post('/api/auth/forgot-password', { email: `v4nobody-${rnd}@test.local` });
  check('AUTH-02 recovery response identical for known and unknown addresses',
    known.status === unknown.status && JSON.stringify(known.data) === JSON.stringify(unknown.data),
    `${known.status}/${unknown.status} ${JSON.stringify(known.data).slice(0, 100)}`);
  if (known.status === 503) {
    blocked('AUTH-08 live reset link issue/consume/expire', 'EMAIL_API_KEY/EMAIL_FROM unset in this environment (docs/DECISIONS.md row 14) — only the honest 503 branch is asserted');
  }

  // AUTH-03 — 8 characters is the sign-up minimum; 7 is refused.
  {
    const c7 = new Client();
    let res = await c7.post('/api/auth/register', { email: `v4pw7-${rnd}@test.local`, name: 'V4 Short', password: '1234567' });
    check('AUTH-03 seven-character sign-up password refused', res.status === 400, `status=${res.status}`);
    const c8 = new Client();
    res = await c8.post('/api/auth/register', { email: `v4pw8-${rnd}@test.local`, name: 'V4 Eight', password: '12345678' });
    check('AUTH-03 eight-character sign-up password accepted', res.status === 200, `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
    // …and an eight-character password of NON-Latin characters is equally
    // valid: the rule counts characters, not English letters.
    const cAr = new Client();
    res = await cAr.post('/api/auth/register', { email: `v4pwar-${rnd}@test.local`, name: 'V4 Arabic Pw', password: 'كلمةمرور' });
    check('AUTH-03 eight NON-Latin characters accepted (not "8 English letters")', res.status === 200, `status=${res.status}`);
  }
  notRun('AUTH-03 legacy short passwords still log in after the new UI rule',
    'no pre-existing production account exists in a fresh isolated DB; the server only enforces the minimum on WRITE paths (register/change/reset) — verify on a restored copy before launch');

  // AUTH-04 — one phone = one identity. The verified-ownership write is what
  // the Telegram flow performs; here the SAME row is planted through the SQL
  // channel so the identity rules can be exercised without a bot token.
  {
    // The number is RUN-UNIQUE: users.phone_e164 carries a partial UNIQUE
    // index, so a fixed literal would collide with the previous run's row and
    // abort the suite on any database that is not wiped first. The four input
    // forms below are all derived from this one identity, so the assertion
    // ("every accepted spelling resolves to ONE account") is unchanged.
    const national = `77${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`; // 7XXXXXXXXX
    const e164 = `+964${national}`;
    const local = `0${national}`;
    const arabicIndic = local.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
    const spaced = `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
    sqlExec(`UPDATE users SET phone_e164='${e164}' WHERE id='${phoneUserId}'`);
    for (const [form, label] of [
      [local, 'local 07…'],
      [e164, 'international +964…'],
      [arabicIndic, 'Arabic-Indic digits'],
      [spaced, 'local with spaces'],
    ]) {
      const c = new Client();
      const res = await c.post('/api/auth/login', { identifier: form, password: 'v4-ph-pass-1' });
      const uid = res.data?.user?.id;
      check(`AUTH-04 ${label} resolves to the SAME single identity`, res.status === 200 && uid === phoneUserId, `status=${res.status} id=${uid}`);
    }
    check('AUTH-04 a second account cannot claim the same phone identity (UNIQUE)',
      sqlFails(`UPDATE users SET phone_e164='${e164}' WHERE id='${otp1Id}'`),
      'the partial UNIQUE index on users(phone_e164) must reject the duplicate');
    // A phone typed into the email form is never stored without proof.
    const cp = new Client();
    let res = await cp.post('/api/auth/register', { email: `v4phone-${rnd}@test.local`, password: 'v4-phone-pass-1', phone: '07701234567' });
    check('AUTH-04 email sign-up refuses to store an unproven phone (PHONE_REQUIRES_VERIFICATION)',
      res.status === 400 && res.data?.code === 'PHONE_REQUIRES_VERIFICATION', `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
    // Length alone never makes a number valid.
    for (const [bad, label] of [
      ['+96412345678', '+964 landline-shaped (not a mobile)'],
      ['0770111', 'too short'],
      ['abcdefghij', 'ten non-digits'],
    ]) {
      res = await anon.post('/api/auth/telegram/start', { phone: bad, purpose: 'signup' });
      check(`AUTH-04 invalid phone rejected before any Telegram call: ${label}`,
        res.status === 400 && res.data?.code === 'INVALID_PHONE', `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
    }
  }

  // AUTH-05 — OTP purpose, single use, wrong/expired/consumed, attempt cap.
  // The challenge row is planted through the SQL channel exactly as a real
  // send would have written it (verifier = sha256("<row id>:<code>"), the
  // scheme in worker/lib/telegram.ts). Nothing about Telegram DELIVERY is
  // claimed — that stays blocked below.
  {
    const idA = `otp_v4a_${rnd}`;
    sqlExec(
      `INSERT INTO otp_challenges (id, user_id, purpose, verifier, chat_id, attempts, max_attempts, expires_at) ` +
      `VALUES ('${idA}', '${otp1Id}', 'reset', '${sha256Hex(`${idA}:123456`)}', 0, 0, 5, '${iso(NOW + 10 * 60_000)}')`
    );
    let res = await otp1.post('/api/telegram/otp/verify', { purpose: 'login', code: '123456' });
    check('AUTH-05 a code issued for one purpose cannot complete another (OTP_NOT_FOUND)',
      res.status === 400 && res.data?.code === 'OTP_NOT_FOUND', `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
    res = await otp1.post('/api/telegram/otp/verify', { purpose: 'reset', code: '000000' });
    check('AUTH-05 wrong six-digit code rejected (OTP_WRONG)', res.status === 400 && res.data?.code === 'OTP_WRONG', `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
    res = await otp1.post('/api/telegram/otp/verify', { purpose: 'reset', code: '12345' });
    check('AUTH-05 FIVE digits never verify (six is the only accepted length)',
      res.status === 400 && res.data?.code === 'OTP_WRONG', `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
    res = await otp1.post('/api/telegram/otp/verify', { purpose: 'reset', code: '123456' });
    check('AUTH-05 the correct six-digit code verifies once', res.status === 200, `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
    res = await otp1.post('/api/telegram/otp/verify', { purpose: 'reset', code: '123456' });
    check('AUTH-05 a consumed code cannot be replayed (single use)',
      res.status === 400 && res.data?.code === 'OTP_NOT_FOUND', `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);

    const idExp = `otp_v4x_${rnd}`;
    sqlExec(
      `INSERT INTO otp_challenges (id, user_id, purpose, verifier, chat_id, attempts, max_attempts, expires_at) ` +
      `VALUES ('${idExp}', '${otp2Id}', 'reset', '${sha256Hex(`${idExp}:123456`)}', 0, 0, 5, '${iso(NOW - 60_000)}')`
    );
    res = await otp2.post('/api/telegram/otp/verify', { purpose: 'reset', code: '123456' });
    check('AUTH-05 an expired code is refused even when correct (OTP_EXPIRED)',
      res.status === 400 && res.data?.code === 'OTP_EXPIRED', `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);

    const idLock = `otp_v4l_${rnd}`;
    sqlExec(
      `INSERT INTO otp_challenges (id, user_id, purpose, verifier, chat_id, attempts, max_attempts, expires_at) ` +
      `VALUES ('${idLock}', '${otp2Id}', 'login', '${sha256Hex(`${idLock}:123456`)}', 0, 0, 3, '${iso(NOW + 10 * 60_000)}')`
    );
    let wrongs = 0;
    for (let i = 0; i < 3; i++) {
      res = await otp2.post('/api/telegram/otp/verify', { purpose: 'login', code: '000000' });
      if (res.status === 400 && res.data?.code === 'OTP_WRONG') wrongs++;
    }
    check('AUTH-05 every wrong attempt burns one of the allowed attempts', wrongs === 3, `wrong-answers=${wrongs}`);
    res = await otp2.post('/api/telegram/otp/verify', { purpose: 'login', code: '123456' });
    check('AUTH-05 after the attempt cap even the CORRECT code is refused (OTP_LOCKED)',
      res.status === 400 && res.data?.code === 'OTP_LOCKED', `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
  }
  {
    // The honest unconfigured branches of the real sign-in flow.
    const res = await anon.post('/api/auth/telegram/start', { phone: '07701234567', purpose: 'signup' });
    if (res.status === 503) {
      check('AUTH-05 telegram sign-in reports honest 503 while unconfigured', true);
      blocked('AUTH-05/AUTH-06 real OTP delivery, contact-ownership match and resend cooldown',
        'TELEGRAM_BOT_TOKEN not configured in this environment (docs/DECISIONS.md row 26) — planted challenges prove the verification rules, not the delivery');
    } else {
      check('AUTH-05 start issues an opaque deep link with no phone in the URL',
        res.status === 200 && String(res.data?.deep_link ?? '').startsWith('https://t.me/') && !String(res.data?.deep_link).includes('7701234567'),
        JSON.stringify(res.data).slice(0, 160));
      blocked('AUTH-06 contact-ownership match (contact.user_id vs sender) and a consumed link session',
        'requires a real Telegram client sharing a contact — manual staging step with a synthetic account');
    }
    const bogus = await anon.post('/api/auth/telegram/complete', { token: 'v4-bogus-continuation-token', code: '123456' });
    check('AUTH-05 a forged continuation token never completes a sign-up',
      bogus.status >= 400 && bogus.status < 500 && bogus.data?.code === 'NO_CHALLENGE', `status=${bogus.status} ${JSON.stringify(bogus.data).slice(0, 100)}`);
  }
  notRun('AUTH-01 fill-button progress states (incomplete → ready → submitting)',
    'browser-only behaviour — covered by tests/fillButton.test.ts (pure rules) and the UI suite, not by an API run');

  // ============================================== §14.2 referrals & support
  console.log('\n— §14.2 referrals and support codes (REF-02..07)');

  const refAName = `v4ra${rnd}`;
  const refBName = `v4rb${rnd}`;

  // Mount probe first: every "nothing happened" assertion below would pass
  // vacuously against a 404, so the router is checked explicitly and the
  // diagnostic names the missing wiring instead of leaving 20 confusing rows.
  const refProbe = await refA.get('/api/referrals/me');
  const referralsMounted = refProbe.status === 200;
  check('REF-01 the referrals API is mounted at /api/referrals',
    referralsMounted,
    `status=${refProbe.status} — worker/index.ts must app.route('/api/referrals', referralRoutes) (docs/INTEGRATED_PHASE.md, integration step 1)`);

  // REF-02 — the username link attributes the SIGN-UP exactly once.
  r = await anon.get(`/api/auth/referrer-info?ref=${refAName}`);
  check('REF-02 the invite link resolves the referrer for display before sign-up',
    r.status === 200 && String(JSON.stringify(r.data)).includes(refAName), JSON.stringify(r.data).slice(0, 140));
  r = await invited.post('/api/auth/register', {
    email: `v4inv-${rnd}@test.local`, username: `v4inv${rnd}`, name: 'V4 Invited', password: 'v4-inv-pass-1', ref: refAName,
  });
  check('REF-02 e-mail sign-up through a username link succeeds', r.status === 200, JSON.stringify(r.data).slice(0, 140));
  const invitedId = await idOf(invited);
  r = await refA.get('/api/referrals/me');
  const invitesA = r.data?.signup_invites ?? 0;
  check('REF-02 the inviter records exactly one signup attribution', r.status === 200 && invitesA === 1, `status=${r.status} invites=${invitesA}`);
  check('REF-02 the referrals page exposes the username invite path, no legacy-code leak',
    r.data?.invite_path === `/auth?ref=${refAName}` && r.data?.username === refAName,
    JSON.stringify({ p: r.data?.invite_path, u: r.data?.username }).slice(0, 140));
  {
    // An empty or unknown code never blocks a sign-up (§2.6).
    const cEmpty = new Client();
    let res = await cEmpty.post('/api/auth/register', { email: `v4empty-${rnd}@test.local`, password: 'v4-empty-pass-1', ref: '' });
    check('REF-02 an EMPTY referral code never blocks sign-up', res.status === 200, `status=${res.status}`);
    const cUnknown = new Client();
    res = await cUnknown.post('/api/auth/register', { email: `v4unk-${rnd}@test.local`, password: 'v4-unk-pass-1', ref: `nobody-${rnd}` });
    check('REF-02 an UNKNOWN referral code never blocks sign-up', res.status === 200, `status=${res.status}`);
    // …and a client-supplied referrer id is ignored: only codes are read.
    const cInject = new Client();
    res = await cInject.post('/api/auth/register', { email: `v4inj-${rnd}@test.local`, password: 'v4-inj-pass-1', referrer_user_id: refBId });
    const injected = res.status === 200;
    const refBMe = await refB.get('/api/referrals/me');
    check('REF-02 an arbitrary referrer_user_id in the body attributes nothing',
      injected && refBMe.status === 200 && (refBMe.data?.signup_invites ?? -1) === 0,
      `signup=${res.status} me=${refBMe.status} invitesB=${refBMe.data?.signup_invites}`);
  }

  // REF-03/04 — the support code is attribution, never money.
  r = await invited.get(`/api/referrals/support/resolve?ref=${refAName}`);
  check('REF-04 support/resolve names the supported user and states a ZERO price effect',
    r.status === 200 && r.data?.username === refAName && r.data?.price_effect_iqd === 0, JSON.stringify(r.data).slice(0, 140));
  r = await refA.get(`/api/referrals/support/resolve?ref=${refAName}`);
  check('REF-07 self-support is refused with its own code (SELF_SUPPORT)',
    r.status === 400 && r.data?.code === 'SELF_SUPPORT', `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);

  const addrInvited = await addrOf(invited, 'V4 Invited', '+9647701110005', 'Kirkuk, V4 District 5');
  await clearCart(invited);
  await invited.post('/api/cart/items', { productId: p12000.id, qty: 1 });
  const plain = await quote(invited, { addressId: addrInvited });
  const supported = await quote(invited, { addressId: addrInvited, supportCode: refAName });
  check('REF-04 the support code changes NO price: merchandise, delivery and total identical',
    plain.status === 200 && supported.status === 200 &&
    plain.data?.quote?.merchandise_iqd === supported.data?.quote?.merchandise_iqd &&
    plain.data?.quote?.shipping?.total_iqd === supported.data?.quote?.shipping?.total_iqd &&
    plain.data?.quote?.total_iqd === supported.data?.quote?.total_iqd,
    `plain=${plain.data?.quote?.total_iqd} supported=${supported.data?.quote?.total_iqd}`);
  check('REF-04 the quote shows the supported handle with an explicit 0 IQD effect',
    supported.data?.quote?.support?.referrer_username === refAName && supported.data?.quote?.support?.discount_iqd === 0,
    JSON.stringify(supported.data?.quote?.support ?? {}).slice(0, 140));

  // REF-04 — coexistence with a discount coupon AND points on the same order.
  // No admin coupon API exists yet, so the row an admin coupon screen would
  // write is inserted through the SQL channel (documented gap).
  const couponCode = `V4CPN${rnd.toUpperCase()}`;
  sqlExec(
    `INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active) ` +
    `VALUES ('cpn_v4_${rnd}', '${couponCode}', 'fixed_iqd', 1000, 0, 5, 1)`
  );
  r = await admin.post('/api/admin/wallet/credit', { userId: invitedId, currency: 'POINT', amount: 50, note: 'v4 coexistence test points' });
  check('points funded for the coexistence check', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  const combo = await quote(invited, { addressId: addrInvited, supportCode: refAName, couponCode, usePoints: true });
  check('REF-04 support code + discount coupon + points all apply together',
    combo.status === 200 &&
    (combo.data?.quote?.coupon?.discount_iqd ?? 0) === 1000 &&
    combo.data?.quote?.points?.applied_iqd === 50 &&
    combo.data?.quote?.support?.discount_iqd === 0 &&
    combo.data?.quote?.total_iqd === plain.data?.quote?.total_iqd - 1000 - 50,
    JSON.stringify({ c: combo.data?.quote?.coupon, p: combo.data?.quote?.points?.applied_iqd, t: combo.data?.quote?.total_iqd }).slice(0, 200));

  // REF-05 — no silent beneficiary swap, and the snapshot is frozen.
  const swapKey = `v4swap-${rnd}`;
  const firstOrder = await order(invited, { addressId: addrInvited, supportCode: refAName, idempotencyKey: swapKey });
  check('REF-05 the confirmed order freezes the supporter it was placed with',
    firstOrder.status === 200 && firstOrder.data?.order?.financial?.support?.referrer_username === refAName,
    JSON.stringify(firstOrder.data?.order?.financial?.support ?? {}).slice(0, 140));
  const swapOrderId = firstOrder.data?.order?.id;
  const replayDifferent = await order(invited, { addressId: addrInvited, supportCode: refBName, idempotencyKey: swapKey });
  check('REF-05 replaying the idempotency key with ANOTHER code returns the original attribution, never a swap',
    replayDifferent.status === 200 && replayDifferent.data?.order?.id === swapOrderId &&
    replayDifferent.data?.order?.financial?.support?.referrer_username === refAName,
    JSON.stringify(replayDifferent.data?.order?.financial?.support ?? {}).slice(0, 140));
  r = await admin.patch(`/api/admin/orders/${swapOrderId}`, { support_snapshot: JSON.stringify({ referrer_user_id: refBId }), status: 'confirmed' });
  const afterAdminEdit = await invited.get(`/api/orders/${swapOrderId}`);
  check('REF-05 an admin order update cannot re-point the beneficiary after purchase',
    afterAdminEdit.data?.order?.financial?.support?.referrer_username === refAName,
    JSON.stringify(afterAdminEdit.data?.order?.financial?.support ?? {}).slice(0, 140));
  r = await refA.get('/api/referrals/me');
  check('REF-05 a support code on a new order never rewrites the account\'s signup inviter',
    (r.data?.signup_invites ?? 0) === 1, `invites=${r.data?.signup_invites}`);

  // REF-06 — the filament gift: delivered AND settled AND an eligible printer.
  const giftKey = `v4gift-${rnd}`;
  await clearCart(giftBuyer);
  await giftBuyer.post('/api/cart/items', { productId: pPrinter.id, qty: 1 });
  // Wallet-funded so the order is settled at purchase (COD is exercised in §5).
  const rate0 = (await anon.get('/api/settings/public')).data?.settings?.exchangeRate ?? 1400;
  r = await admin.post('/api/admin/wallet/credit', { userId: await idOf(giftBuyer), currency: 'USD', amount: Math.ceil((30000 * 100) / rate0) + 500, note: 'v4 gift order funding' });
  check('gift buyer funded', r.status === 200);
  const giftOrder = await order(giftBuyer, { addressId: addrGift, paymentMethodId: 'wallet', useWallet: true, idempotencyKey: giftKey, supportCode: refAName });
  const giftOrderId = giftOrder.data?.order?.id;
  check('REF-06 eligible printer order placed and fully prepaid',
    giftOrder.status === 200 && giftOrder.data?.order?.financial?.due_on_delivery_iqd === 0,
    JSON.stringify(giftOrder.data?.order?.financial ?? {}).slice(0, 200));
  const preDelivery = await refA.get('/api/referrals/me');
  let gifts = preDelivery.data?.support_gifts ?? [];
  check('REF-06 before delivery the claim is NOT due (pending eligibility, or not yet created)',
    preDelivery.status === 200 && gifts.every((g) => g.state !== 'due' && g.state !== 'paid'),
    `status=${preDelivery.status} ${JSON.stringify(gifts).slice(0, 180)}`);
  const del = await deliverOrder(admin, giftOrderId);
  check('REF-06 the gift order reaches delivered', del.status === 200, JSON.stringify(del.data).slice(0, 140));
  gifts = await poll(
    async () => (await refA.get('/api/referrals/me')).data?.support_gifts ?? [],
    (g) => g.length > 0 && g.some((x) => x.state !== 'pending_eligibility')
  );
  const dueGifts = gifts.filter((g) => g.state === 'due' || g.state === 'reserved' || g.state === 'paid');
  check('REF-06 delivered + settled + eligible printer produces exactly ONE entitlement',
    gifts.length === 1 && dueGifts.length === 1, JSON.stringify(gifts).slice(0, 240));
  // Replays: a repeated delivered transition, the admin evaluate endpoint and
  // the reconcile sweep must all be no-ops.
  const replayDelivered = await admin.patch(`/api/admin/orders/${giftOrderId}`, { status: 'delivered' });
  const evalAgain = await admin.post('/api/referrals/admin/gifts/evaluate', { orderId: giftOrderId });
  const reconcile = await admin.post('/api/referrals/admin/gifts/reconcile', { limit: 50 });
  gifts = (await refA.get('/api/referrals/me')).data?.support_gifts ?? [];
  check('REF-06 delivered-replay + evaluate + reconcile never create a second gift',
    gifts.length === 1,
    `deliveredReplay=${replayDelivered.status} evaluate=${evalAgain.status} reconcile=${reconcile.status} gifts=${gifts.length}`);
  // A non-eligible product never qualifies, no matter the support code.
  await clearCart(giftBuyer);
  await giftBuyer.post('/api/cart/items', { productId: pAccessory.id, qty: 1 });
  const accOrder = await order(giftBuyer, { addressId: addrGift, idempotencyKey: `v4acc-${rnd}`, supportCode: refAName });
  const accOrderId = accOrder.data?.order?.id;
  await deliverOrder(admin, accOrderId);
  await admin.post(`/api/orders/${accOrderId}/settlement`, { amountIqd: accOrder.data?.order?.financial?.due_on_delivery_iqd ?? 0, eventKey: `v4acc-collect-${rnd}`, reference: `V4ACC${rnd}` });
  gifts = (await refA.get('/api/referrals/me')).data?.support_gifts ?? [];
  check('REF-06 an accessory that is not flagged eligible never produces a gift',
    gifts.length === 1, `gifts=${gifts.length} ${JSON.stringify(gifts.map((g) => g.state)).slice(0, 120)}`);
  // REF-07 self-support: an order carrying the buyer's own handle is placed,
  // but it is never attributed and can never produce a gift.
  const refAAddr = await addrOf(refA, 'V4 Referrer A', '+9647701110006', 'Mosul, V4 District 6');
  await clearCart(refA);
  await refA.post('/api/cart/items', { productId: pPrinter.id, qty: 1 });
  const selfOrder = await order(refA, { addressId: refAAddr, idempotencyKey: `v4self-${rnd}`, supportCode: refAName });
  check('REF-07 an order carrying the buyer\'s OWN handle stores no attribution',
    selfOrder.status === 200 && (selfOrder.data?.order?.financial?.support ?? null) === null,
    JSON.stringify(selfOrder.data?.order?.financial?.support ?? null).slice(0, 140));
  const selfOrderId = selfOrder.data?.order?.id;
  await deliverOrder(admin, selfOrderId);
  gifts = (await refA.get('/api/referrals/me')).data?.support_gifts ?? [];
  check('REF-07 self-support never becomes an entitlement', gifts.length === 1, `gifts=${gifts.length}`);
  notRun('REF-03 removal of the support code survives refresh and return',
    'browser-state behaviour (src/pages/Cart.tsx + Referrals helpers) — no server state is involved by design; covered by the UI suite');
  blocked('REF-06/REF-07 partial delivery, return-after-gift settlement and multi-printer orders',
    'one gift per qualifying ORDER is the shipped default; per-printer counting, repeat limits and post-payout clawback are owner decisions (docs/DECISIONS.md row 11 / mandate §13.2)');

  // ==================================================== §14.3 points (PTS)
  console.log('\n— §14.3 points: 100 IQD = 1 point, seven-day hold, settlement gate');

  // PTS-01 — 99 → 0, 100 → 1, 199 → 1 on the ACCRUAL basis (read-only quote).
  for (const [prod, expect, label] of [[p99, 0, '99'], [p100, 1, '100'], [p199, 1, '199']]) {
    await clearCart(buyerPoints);
    await buyerPoints.post('/api/cart/items', { productId: prod.id, qty: 1 });
    const q = await quote(buyerPoints, { addressId: addrPoints });
    check(`PTS-01 ${label} IQD of eligible merchandise accrues exactly ${expect} point(s)`,
      q.status === 200 && q.data?.quote?.points?.earn_pending === expect && q.data?.quote?.points?.iqd_per_point === 100,
      `pending=${q.data?.quote?.points?.earn_pending} rate=${q.data?.quote?.points?.iqd_per_point}`);
  }
  {
    await clearCart(buyerPoints);
    await buyerPoints.post('/api/cart/items', { productId: p75000.id, qty: 1 });
    const q = await quote(buyerPoints, { addressId: addrPoints });
    check('PTS-01 75,000 IQD accrues exactly 750 points (rule v2, one floor on the total)',
      q.data?.quote?.points?.earn_pending === 750 && q.data?.quote?.points?.rule_version === 'v2',
      `pending=${q.data?.quote?.points?.earn_pending} rule=${q.data?.quote?.points?.rule_version}`);
    const qPickup = await quote(buyerPoints, { addressId: addrPoints, deliveryMethodId: 'pickup' });
    check('PTS-01 changing the delivery method alone never changes the points earned',
      qPickup.data?.quote?.points?.earn_pending === 750 && qPickup.data?.quote?.shipping?.total_iqd !== q.data?.quote?.shipping?.total_iqd,
      `pickup=${qPickup.data?.quote?.points?.earn_pending}/${qPickup.data?.quote?.shipping?.total_iqd} standard=${q.data?.quote?.shipping?.total_iqd}`);
  }

  // ---- §5 arithmetic, digit by digit ---------------------------------------
  // The wallet ledger is USD cents, so an EXACT 30,000 IQD contribution needs
  // a rate at which 30,000 is representable. The rate is pinned for this block
  // only and restored immediately afterwards.
  let ratePinned = false;
  const representable = (rate) => Math.floor((Math.ceil(3_000_000 / rate) * rate) / 100) === 30000;
  let rate = rate0;
  if (!representable(rate0)) {
    const put = await admin.put('/api/admin/settings/exchangeRate', { value: 1000 });
    ratePinned = put.status === 200;
    rate = ratePinned ? 1000 : rate0;
    check('§5 exchange rate pinned so a 30,000 IQD wallet contribution is exactly representable', ratePinned, `status=${put.status}`);
  }
  const fundCents = Math.ceil(3_000_000 / rate);
  r = await admin.post('/api/admin/wallet/credit', { userId: buyerMoneyId, currency: 'USD', amount: fundCents, note: 'v4 section-5 wallet funding' });
  check('§5 wallet funded', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  r = await admin.post('/api/admin/wallet/credit', { userId: buyerMoneyId, currency: 'POINT', amount: 739, note: 'v4 section-5 points funding' });
  check('§5 exactly 739 spendable points funded', r.status === 200, JSON.stringify(r.data).slice(0, 120));

  await clearCart(buyerMoney);
  await buyerMoney.post('/api/cart/items', { productId: p75000.id, qty: 1 });
  const q5 = await quote(buyerMoney, { addressId: addrMoney, usePoints: true, useWallet: true });
  const Q = q5.data?.quote ?? {};
  check('§5 wallet balance reads exactly 30,000 IQD', Q.wallet?.balance_iqd === 30000, `balance=${Q.wallet?.balance_iqd}`);
  check('§5 net merchandise after commercial discounts = 75,000', Q.merchandise_iqd === 75000, `merchandise=${Q.merchandise_iqd}`);
  check('§5 739 points redeem exactly 739 IQD (no rounding to 500/1,000)', Q.points?.applied_iqd === 739, `points=${Q.points?.applied_iqd}`);
  check('§5 goods payable after points = 74,261', Q.points?.earn_eligible_iqd === 74261, `earn_basis=${Q.points?.earn_eligible_iqd}`);
  check('§5 delivery = 5,000', Q.shipping?.total_iqd === 5000, `shipping=${Q.shipping?.total_iqd}`);
  check('§5 total = 79,261', Q.total_iqd === 79261, `total=${Q.total_iqd}`);
  check('§5 wallet payment = 30,000', Q.wallet?.applied_iqd === 30000, `wallet=${Q.wallet?.applied_iqd}`);
  check('§5 remaining COD = 49,261', Q.due_on_delivery_iqd === 49261, `cod=${Q.due_on_delivery_iqd}`);
  check('§5 pending purchase points = floor(74,261 / 100) = 742', Q.points?.earn_pending === 742, `pending=${Q.points?.earn_pending}`);
  check('§5 the seven-day hold is stated in the quote', Q.points?.hold_days === 7, `hold=${Q.points?.hold_days}`);

  const o5 = await order(buyerMoney, { addressId: addrMoney, usePoints: true, useWallet: true, idempotencyKey: `v4s5-${rnd}` });
  const order5 = o5.data?.order;
  const F = order5?.financial ?? {};
  check('§5 the order records the same numbers the quote promised',
    o5.status === 200 && F.merchandise_iqd === 75000 && F.points_used === 739 && F.shipping_iqd === 5000 &&
    F.total_iqd === 79261 && F.wallet_applied_iqd === 30000 && F.due_on_delivery_iqd === 49261,
    JSON.stringify(F).slice(0, 260));
  check('§5 the wallet payment carries its own ledger reference', typeof F.wallet_tx_id === 'string' && F.wallet_tx_id.length > 0, `tx=${F.wallet_tx_id}`);
  check('§5 the order is NOT "paid" at creation — the COD balance is outstanding',
    F.payment_state !== 'paid' && F.collected_iqd === 30000 && F.outstanding_iqd === 49261,
    `state=${F.payment_state} collected=${F.collected_iqd} outstanding=${F.outstanding_iqd}`);
  check('§5 the accrual is created PENDING with the rate frozen at 100 (v2)',
    F.points?.state === 'pending' && F.points?.pending === 742 && F.points?.iqd_per_point === 100 && F.points?.rule_version === 'v2',
    JSON.stringify(F.points ?? {}).slice(0, 200));
  const purchaseAt = Date.parse(order5?.financial?.points?.available_at ?? '') - 7 * DAY;
  check('§5 available_at is exactly purchase + 7×24h', Number.isFinite(purchaseAt) && Math.abs(purchaseAt - Date.parse(order5?.created_at ?? '')) < 5 * 60_000,
    `available_at=${F.points?.available_at} created=${order5?.created_at}`);
  const order5Id = order5?.id;
  check('§5 the spendable point balance did NOT rise at purchase', (await pointsOf(buyerMoney)) === 0, `points=${await pointsOf(buyerMoney)}`);
  if (ratePinned) {
    const restore = await admin.put('/api/admin/settings/exchangeRate', { value: rate0 });
    check('§5 exchange rate restored to the value the environment had', restore.status === 200, `status=${restore.status}`);
  }

  // PTS-02 — the seven-day hold and the settlement gate.
  await deliverOrder(admin, order5Id);
  let snap = (await buyerMoney.get(`/api/orders/${order5Id}`)).data?.order?.financial;
  check('PTS-02 delivery alone releases nothing (points still pending)',
    snap?.points?.state === 'pending' && (await pointsOf(buyerMoney)) === 0, JSON.stringify(snap?.points ?? {}).slice(0, 160));
  let settle = await admin.post(`/api/orders/${order5Id}/settlement`, { amountIqd: 49261, eventKey: `v4s5-collect-${rnd}`, reference: `V4COD${rnd}` });
  check('PTS-02 the COD collection is recorded with its own reference',
    settle.status === 200 && settle.data?.settlement?.collected_iqd === 79261 && settle.data?.settlement?.fully_settled === true,
    JSON.stringify(settle.data?.settlement ?? {}).slice(0, 180));
  check('PTS-02 a second before the seven days nothing releases, even fully settled',
    (settle.data?.points_released?.released ?? false) === false && (await pointsOf(buyerMoney)) === 0,
    JSON.stringify(settle.data?.points_released ?? {}).slice(0, 160));
  // Day 9: the clock started at purchase and is never restarted by delivery.
  sqlExec(
    `UPDATE points_accruals SET purchase_at='${iso(NOW - 9 * DAY)}', available_at='${iso(NOW - 2 * DAY)}' ` +
    `WHERE order_id='${order5Id}' AND kind='purchase'`
  );
  settle = await admin.post(`/api/orders/${order5Id}/settlement`, { amountIqd: 0, eventKey: `v4s5-recheck-${rnd}`, note: 'release re-check after backdating' });
  check('PTS-02 a day-9 collection releases the accrual then and there — exactly 742 points',
    settle.data?.points_released?.released === true && settle.data?.points_released?.points === 742 && (await pointsOf(buyerMoney)) === 742,
    `${JSON.stringify(settle.data?.points_released ?? {}).slice(0, 140)} balance=${await pointsOf(buyerMoney)}`);
  snap = (await buyerMoney.get(`/api/orders/${order5Id}`)).data?.order?.financial;
  check('PTS-02 the seven-day window was NOT restarted from delivery',
    Math.abs(Date.parse(snap?.points?.available_at ?? '') - (NOW - 2 * DAY)) < 5 * 60_000, `available_at=${snap?.points?.available_at}`);
  const replaySettle = await admin.post(`/api/orders/${order5Id}/settlement`, { amountIqd: 0, eventKey: `v4s5-recheck-${rnd}`, note: 'replay' });
  const thirdSettle = await admin.post(`/api/orders/${order5Id}/settlement`, { amountIqd: 0, eventKey: `v4s5-third-${rnd}`, note: 'another event, already released' });
  check('PTS-02 replayed settlement events never award a second time',
    replaySettle.data?.settlement?.duplicate === true && (thirdSettle.data?.points_released?.released ?? false) === false &&
    (await pointsOf(buyerMoney)) === 742,
    `dup=${replaySettle.data?.settlement?.duplicate} balance=${await pointsOf(buyerMoney)}`);

  // COD collection gate on a second order: delivered, NOT collected, no points.
  await clearCart(buyerMoney);
  await buyerMoney.post('/api/cart/items', { productId: p12000.id, qty: 1 });
  const codOrder = await order(buyerMoney, { addressId: addrMoney, idempotencyKey: `v4cod-${rnd}` });
  const codOrderId = codOrder.data?.order?.id;
  check('PTS-02 a COD order accrues 120 pending points on 12,000 IQD',
    codOrder.data?.order?.financial?.points?.pending === 120, JSON.stringify(codOrder.data?.order?.financial?.points ?? {}).slice(0, 160));
  await deliverOrder(admin, codOrderId);
  check('PTS-02 an uncollected COD order stays pending after delivery (no free points)',
    (await pointsOf(buyerMoney)) === 742 &&
    (await buyerMoney.get(`/api/orders/${codOrderId}`)).data?.order?.financial?.points?.state === 'pending',
    `balance=${await pointsOf(buyerMoney)}`);

  // PTS-07 — the rule change never multiplies or re-grants old balances. The
  // accrual is rewritten to the OLD rule (1,000 IQD = 1 point) exactly as a
  // pre-0014 order carries it, then released: the frozen per-row rate must win.
  sqlExec(
    `UPDATE points_accruals SET iqd_per_point=1000, rule_version='v1', points=12, ` +
    `purchase_at='${iso(NOW - 9 * DAY)}', available_at='${iso(NOW - 2 * DAY)}' ` +
    `WHERE order_id='${codOrderId}' AND kind='purchase'`
  );
  const legacySettle = await admin.post(`/api/orders/${codOrderId}/settlement`, { amountIqd: codOrder.data?.order?.financial?.due_on_delivery_iqd ?? 0, eventKey: `v4legacy-${rnd}`, reference: `V4LEG${rnd}` });
  check('PTS-07 an old-rule accrual releases at ITS rate — 12 points, not 120',
    legacySettle.data?.points_released?.released === true && legacySettle.data?.points_released?.points === 12 &&
    (await pointsOf(buyerMoney)) === 742 + 12,
    `${JSON.stringify(legacySettle.data?.points_released ?? {}).slice(0, 140)} balance=${await pointsOf(buyerMoney)}`);
  const legacySnap = (await buyerMoney.get(`/api/orders/${codOrderId}`)).data?.order?.financial;
  check('PTS-07 the old row keeps its own rate and version after release (no re-pricing of history)',
    legacySnap?.points?.iqd_per_point === 1000 && legacySnap?.points?.rule_version === 'v1' && legacySnap?.points?.released === 12,
    JSON.stringify(legacySnap?.points ?? {}).slice(0, 180));
  blocked('PTS-07 the effective date the NEW rule starts applying to new purchases',
    'pointsRuleConfig.effective_at is seeded to the migration instant so nothing is recomputed; the commercial start date is an owner decision (docs/DECISIONS.md row 20 / mandate §13.4)');

  // PTS-03 — redemption is capped by eligible merchandise, never delivery.
  r = await admin.post('/api/admin/wallet/credit', { userId: buyerPointsId, currency: 'POINT', amount: 5000, note: 'v4 redemption cap test' });
  check('redemption-cap points funded', r.status === 200);
  await clearCart(buyerPoints);
  await buyerPoints.post('/api/cart/items', { productId: p500.id, qty: 1 });
  const capQuote = await quote(buyerPoints, { addressId: addrPoints, usePoints: true });
  check('PTS-03 points never pay for delivery: 500 IQD of goods absorbs 500 points, not 5,500',
    capQuote.data?.quote?.points?.applied_iqd === 500 && capQuote.data?.quote?.total_iqd === 5000,
    `applied=${capQuote.data?.quote?.points?.applied_iqd} total=${capQuote.data?.quote?.total_iqd}`);
  const capOrder = await order(buyerPoints, { addressId: addrPoints, usePoints: true, idempotencyKey: `v4cap-${rnd}` });
  check('PTS-03 the balance above the cap stays with the user',
    capOrder.status === 200 && (await pointsOf(buyerPoints)) === 4500,
    `balance=${await pointsOf(buyerPoints)}`);

  // PTS-04 — the same points can never be spent by two concurrent orders.
  await clearCart(buyerPoints);
  // TWO DIFFERENT products on purpose: POST /api/cart/items upserts on
  // (product, option, colour, transport, warranty), so adding the same product
  // twice merges into ONE line with qty 2 and there would be nothing to race.
  // 12,000 + 500 of merchandise both want points from a 4,500 balance, so the
  // two checkouts genuinely contend for the same points.
  await buyerPoints.post('/api/cart/items', { productId: p12000.id, qty: 1 });
  await buyerPoints.post('/api/cart/items', { productId: p500.id, qty: 1 });
  const cartLines = (await buyerPoints.get('/api/cart')).data?.items ?? [];
  const beforeConcurrent = await pointsOf(buyerPoints);
  const [c1, c2] = cartLines.length >= 2
    ? await Promise.all([
        order(buyerPoints, { addressId: addrPoints, usePoints: true, itemIds: [cartLines[0].id], idempotencyKey: `v4cc1-${rnd}` }),
        order(buyerPoints, { addressId: addrPoints, usePoints: true, itemIds: [cartLines[1].id], idempotencyKey: `v4cc2-${rnd}` }),
      ])
    : [{ status: 0, data: {} }, { status: 0, data: {} }];
  const spent1 = c1.data?.order?.financial?.points_used ?? 0;
  const spent2 = c2.data?.order?.financial?.points_used ?? 0;
  const afterConcurrent = await pointsOf(buyerPoints);
  check('PTS-04 two concurrent orders never spend more points than the balance held',
    cartLines.length >= 2 && spent1 + spent2 <= beforeConcurrent && afterConcurrent >= 0 &&
    afterConcurrent === beforeConcurrent - spent1 - spent2,
    `before=${beforeConcurrent} spent=${spent1}+${spent2} after=${afterConcurrent}`);
  const failedCheckout = await order(buyerPoints, { addressId: 'addr_does_not_exist', usePoints: true, idempotencyKey: `v4fail-${rnd}` });
  check('PTS-04 a failed checkout loses no points',
    failedCheckout.status >= 400 && (await pointsOf(buyerPoints)) === afterConcurrent,
    `status=${failedCheckout.status} balance=${await pointsOf(buyerPoints)}`);
  notRun('PTS-05/PTS-06 daily mission and ad-video anti-replay',
    'mission/video claim rules are outside this slice\'s scope this round — they are exercised by the base suite; the video-session tightening is tracked in docs/INTEGRATED_PHASE.md');

  // ============================================ §14.4 wallet, payment (WAL/PAY)
  console.log('\n— §14.4 wallet, holds and the unified payment policy');

  // WAL-01 — a deposit is a REQUEST; nothing is spendable before approval.
  const up = await uploadReceipt(walletUser, 'v4-receipt.png');
  check('WAL-01 receipt uploaded to the private prefix', up.status === 200 && String(up.data?.key ?? '').startsWith(`receipts/${walletUserId}/`), JSON.stringify(up.data).slice(0, 140));
  const receiptKey = up.data?.key;
  let before = await centsOf(walletUser);
  let dep = await walletUser.post('/api/wallet/deposits', { amount_usd_cents: 5000, receiptKey, provider: 'zaincash', channel: 'agent', reference: `V4REF${rnd}` });
  const depositId = dep.data?.id;
  let after = await centsOf(walletUser);
  check('WAL-01 the deposit is created pending — available unchanged, pending shown separately',
    dep.status === 200 && dep.data?.status === 'pending' &&
    after.usd_cents_available === before.usd_cents_available &&
    after.usd_cents_pending_deposits === before.usd_cents_pending_deposits + 5000,
    `${JSON.stringify(after)} ${JSON.stringify(dep.data).slice(0, 120)}`);
  const dupRef = await walletUser.post('/api/wallet/deposits', { amount_usd_cents: 5000, receiptKey, provider: 'zaincash', channel: 'agent', reference: `V4REF${rnd}` });
  check('WAL-01 the same transfer reference cannot buy a second credit (fresh key, same event)',
    dupRef.status === 409, `status=${dupRef.status} ${JSON.stringify(dupRef.data).slice(0, 120)}`);

  // WAL-02 — two approvals of the SAME deposit: one credit, one conflict.
  before = await centsOf(walletUser);
  const [a1, a2] = await Promise.all([
    admin.post(`/api/wallet/admin/deposits/${depositId}/approve`, { adminNote: 'v4 concurrent A' }),
    admin.post(`/api/wallet/admin/deposits/${depositId}/approve`, { adminNote: 'v4 concurrent B' }),
  ]);
  after = await centsOf(walletUser);
  const oks = [a1, a2].filter((x) => x.status === 200).length;
  check('WAL-02 two concurrent approvals produce exactly one financial entry',
    oks === 1 && after.usd_cents_available === before.usd_cents_available + 5000,
    `ok=${oks} statuses=${a1.status}/${a2.status} available ${before.usd_cents_available}→${after.usd_cents_available}`);
  const approveAgain = await admin.post(`/api/wallet/admin/deposits/${depositId}/approve`, { adminNote: 'v4 replay' });
  check('WAL-02 a later replay is refused and credits nothing',
    approveAgain.status === 409 && (await centsOf(walletUser)).usd_cents_available === after.usd_cents_available,
    `status=${approveAgain.status}`);

  // WAL-01/03 — rejection changes no balance; approve-vs-reject races resolve once.
  const up2 = await uploadReceipt(walletUser, 'v4-receipt-2.png');
  const dep2 = await walletUser.post('/api/wallet/deposits', { amount_usd_cents: 2500, receiptKey: up2.data?.key, provider: 'zaincash', channel: 'agent', reference: `V4REJ${rnd}` });
  before = await centsOf(walletUser);
  const rej = await admin.post(`/api/wallet/admin/deposits/${dep2.data?.id}/reject`, { reason: 'v4 synthetic rejection' });
  after = await centsOf(walletUser);
  check('WAL-01 rejection moves no money and clears the pending figure',
    rej.status === 200 && after.usd_cents_available === before.usd_cents_available &&
    after.usd_cents_pending_deposits === before.usd_cents_pending_deposits - 2500,
    `${JSON.stringify(after)}`);
  const up3 = await uploadReceipt(walletUser, 'v4-receipt-3.png');
  const dep3 = await walletUser.post('/api/wallet/deposits', { amount_usd_cents: 1500, receiptKey: up3.data?.key, provider: 'zaincash', channel: 'agent', reference: `V4RACE${rnd}` });
  before = await centsOf(walletUser);
  const [ra, rb] = await Promise.all([
    admin.post(`/api/wallet/admin/deposits/${dep3.data?.id}/approve`, { adminNote: 'v4 race approve' }),
    admin.post(`/api/wallet/admin/deposits/${dep3.data?.id}/reject`, { reason: 'v4 race reject' }),
  ]);
  after = await centsOf(walletUser);
  const winners = [ra, rb].filter((x) => x.status === 200).length;
  const credited = after.usd_cents_available - before.usd_cents_available;
  check('WAL-03 approve and reject racing: exactly one transition, and the loser writes no side entry',
    winners === 1 && (credited === 1500 || credited === 0) && (ra.status === 200 ? credited === 1500 : credited === 0),
    `winners=${winners} approve=${ra.status} reject=${rb.status} credited=${credited}`);

  // WAL-04 — authority: a customer can never approve, not even their own.
  const selfApprove = await walletUser.post(`/api/wallet/admin/deposits/${depositId}/approve`, { adminNote: 'self' });
  check('WAL-04 a customer calling the admin approval route is refused',
    selfApprove.status === 401 || selfApprove.status === 403 || selfApprove.status === 404, `status=${selfApprove.status}`);

  // WAL-10 — money guards: negative, fractional, overflow, foreign attachment.
  for (const [amount, label] of [[-100, 'negative'], [10.5, 'fractional'], [100_000_001, 'above the maximum'], ['abc', 'not a number']]) {
    const bad = await walletUser.post('/api/wallet/deposits', { amount_usd_cents: amount, receiptKey, provider: 'zaincash', channel: 'agent', reference: `V4BAD${rnd}${String(label).slice(0, 3)}` });
    check(`WAL-10 deposit amount refused: ${label}`, bad.status === 400, `status=${bad.status}`);
  }
  const foreignProofDeposit = await walletUser.post('/api/wallet/deposits', { amount_usd_cents: 1000, receiptKey: `receipts/${buyerMoneyId}/not-mine.png`, provider: 'zaincash', channel: 'agent', reference: `V4FGN${rnd}` });
  check('WAL-10 a deposit cannot attach somebody else\'s proof', foreignProofDeposit.status === 400, `status=${foreignProofDeposit.status}`);
  const foreignView = await buyerMoney.get(`/files/${receiptKey}`);
  check('WAL-10 another user cannot view that proof (no bytes served)',
    (foreignView.status === 403 || foreignView.status === 404) && !foreignView.text.includes('PNG'), `status=${foreignView.status}`);
  const ownerView = await walletUser.get(`/files/${receiptKey}`);
  check('WAL-10 the owner can still view their own proof', ownerView.status === 200, `status=${ownerView.status}`);

  // WAL-07 — withdrawal holds: reserve once, release once, commit once.
  r = await admin.post('/api/admin/wallet/credit', { userId: walletUserId, currency: 'USD', amount: 20000, note: 'v4 withdrawal test funding' });
  check('withdrawal test wallet funded', r.status === 200);
  before = await centsOf(walletUser);
  const wd1 = await walletUser.post('/api/wallet/withdrawals', { amount_usd_cents: 6000, destinationAccount: 'V4-TEST-ACCOUNT-1', destinationKind: 'manual_transfer', idempotencyKey: `v4wd1-${rnd}` });
  after = await centsOf(walletUser);
  check('WAL-07 requesting a withdrawal holds the amount once: available drops, settled does not',
    wd1.status === 200 && after.usd_cents_available === before.usd_cents_available - 6000 &&
    after.usd_cents_settled === before.usd_cents_settled && after.usd_cents_held === before.usd_cents_held + 6000,
    `${JSON.stringify(after)}`);
  const wd1Replay = await walletUser.post('/api/wallet/withdrawals', { amount_usd_cents: 6000, destinationAccount: 'V4-TEST-ACCOUNT-1', destinationKind: 'manual_transfer', idempotencyKey: `v4wd1-${rnd}` });
  check('WAL-07 the same request key holds nothing twice',
    wd1Replay.data?.replayed === true && (await centsOf(walletUser)).usd_cents_held === after.usd_cents_held,
    `replayed=${wd1Replay.data?.replayed}`);
  const rejectWd = await admin.post(`/api/wallet/admin/withdrawals/${wd1.data?.id}/reject`, { reason: 'v4 synthetic rejection' });
  const afterReject = await centsOf(walletUser);
  check('WAL-07 rejection releases the hold exactly once',
    rejectWd.status === 200 && afterReject.usd_cents_available === before.usd_cents_available && afterReject.usd_cents_held === before.usd_cents_held,
    `${JSON.stringify(afterReject)}`);
  const rejectAgain = await admin.post(`/api/wallet/admin/withdrawals/${wd1.data?.id}/reject`, { reason: 'v4 replay' });
  check('WAL-07 a repeated rejection never releases a second time',
    (rejectAgain.status === 200 ? rejectAgain.data?.replayed === true : rejectAgain.status === 409) &&
    (await centsOf(walletUser)).usd_cents_available === afterReject.usd_cents_available,
    `status=${rejectAgain.status}`);

  const wd2 = await walletUser.post('/api/wallet/withdrawals', { amount_usd_cents: 4000, destinationAccount: 'V4-TEST-ACCOUNT-2', destinationKind: 'manual_transfer', idempotencyKey: `v4wd2-${rnd}` });
  const wd2Id = wd2.data?.id;
  const approved = await admin.post(`/api/wallet/admin/withdrawals/${wd2Id}/approve`, {});
  check('WAL-07 approval means "approved for processing", never "transferred"',
    approved.status === 200 && approved.data?.withdrawal?.state === 'approved' &&
    approved.data?.withdrawal?.money_sent === false && !approved.data?.withdrawal?.payout_at &&
    /not a payout confirmation/i.test(String(approved.data?.note ?? '')),
    JSON.stringify(approved.data?.withdrawal ?? {}).slice(0, 180));
  await admin.post(`/api/wallet/admin/withdrawals/${wd2Id}/processing`, {});
  const beforePaid = await centsOf(walletUser);
  const paid = await admin.post(`/api/wallet/admin/withdrawals/${wd2Id}/paid`, { payoutReference: `V4PAY${rnd}`, note: 'synthetic manual transfer reference' });
  const afterPaid = await centsOf(walletUser);
  check('WAL-07 completing the payout commits the hold — settled falls once, available is unchanged',
    paid.status === 200 && afterPaid.usd_cents_settled === beforePaid.usd_cents_settled - 4000 &&
    afterPaid.usd_cents_available === beforePaid.usd_cents_available && afterPaid.usd_cents_held === beforePaid.usd_cents_held - 4000,
    `${JSON.stringify(afterPaid)}`);
  const paidReplay = await admin.post(`/api/wallet/admin/withdrawals/${wd2Id}/paid`, { payoutReference: `V4PAY${rnd}` });
  check('WAL-07 replaying the payout debits nothing a second time',
    (await centsOf(walletUser)).usd_cents_settled === afterPaid.usd_cents_settled, `status=${paidReplay.status}`);
  for (const [amount, label] of [[-500, 'negative'], [0.5, 'fractional'], [100_000_001, 'above the maximum']]) {
    const bad = await walletUser.post('/api/wallet/withdrawals', { amount_usd_cents: amount, destinationAccount: 'V4-TEST-ACCOUNT-3' });
    check(`WAL-10 withdrawal amount refused: ${label}`, bad.status === 400, `status=${bad.status}`);
  }
  // Well inside the per-operation maximum, far above this wallet's balance.
  const overdraw = await walletUser.post('/api/wallet/withdrawals', { amount_usd_cents: 10_000_000, destinationAccount: 'V4-TEST-ACCOUNT-4', idempotencyKey: `v4over-${rnd}` });
  check('WAL-08 a withdrawal above the available balance is refused (no negative available)',
    overdraw.status >= 400 && (await centsOf(walletUser)).usd_cents_available >= 0, `status=${overdraw.status}`);

  // WAL-08 — a purchase and a withdrawal racing for the same limited balance.
  const raceBalance = await centsOf(walletUser);
  await clearCart(walletUser);
  await walletUser.post('/api/cart/items', { productId: p12000.id, qty: 1 });
  const [buyRace, wdRace] = await Promise.all([
    order(walletUser, { addressId: addrWallet, paymentMethodId: 'wallet', useWallet: true, idempotencyKey: `v4race-${rnd}` }),
    walletUser.post('/api/wallet/withdrawals', { amount_usd_cents: Math.max(100, raceBalance.usd_cents_available - 200), destinationAccount: 'V4-TEST-ACCOUNT-5', idempotencyKey: `v4wdrace-${rnd}` }),
  ]);
  const afterRace = await centsOf(walletUser);
  check('WAL-08 a concurrent purchase and withdrawal never produce a negative available balance',
    afterRace.usd_cents_available >= 0 && afterRace.usd_cents_settled >= 0,
    `buy=${buyRace.status} wd=${wdRace.status} ${JSON.stringify(afterRace)}`);
  check('WAL-08 pending money is never spendable: available excludes pending deposits and held funds',
    afterRace.usd_cents_available === afterRace.usd_cents_settled - afterRace.usd_cents_held,
    JSON.stringify(afterRace));
  blocked('WAL-05/WAL-06 Telegram approval buttons, webhook secret and group delivery',
    'TELEGRAM_BOT_TOKEN / an authorised test group are not configured here (docs/DECISIONS.md row 26) — v3 covers the webhook secret branches that run unconfigured');
  blocked('WAL-07 live payout execution, eligible balance sources, limits and fees',
    'no payout channel or fee policy is approved yet (mandate §13.1; no register row exists — one must be added). The suite only proves the hold/commit/release ledger.');

  // PAY-01 — wallet-only, and the honest state of a COD order.
  r = await admin.post('/api/admin/wallet/credit', { userId: buyerMoneyId, currency: 'USD', amount: Math.ceil((20000 * 100) / rate0) + 500, note: 'v4 wallet-only order funding' });
  await clearCart(buyerMoney);
  await buyerMoney.post('/api/cart/items', { productId: p12000.id, qty: 1 });
  const walletOnly = await order(buyerMoney, { addressId: addrMoney, paymentMethodId: 'wallet', useWallet: true, idempotencyKey: `v4wonly-${rnd}` });
  const WF = walletOnly.data?.order?.financial ?? {};
  check('PAY-01 a wallet-only order is fully collected at purchase and marked paid',
    walletOnly.status === 200 && WF.due_on_delivery_iqd === 0 && WF.collected_iqd === WF.total_iqd && WF.payment_state === 'paid',
    JSON.stringify(WF).slice(0, 200));
  check('PAY-01 its accrual is stamped settled at purchase but still waits the seven days',
    WF.points?.state === 'pending' && WF.settlement?.fully_settled === true,
    JSON.stringify({ p: WF.points?.state, s: WF.settlement }).slice(0, 180));

  // PAY-03 — COD never activates a paid subscription and never buys points.
  const subUser = new Client();
  await subUser.post('/api/auth/register', { email: `v4sub-${rnd}@test.local`, username: `v4sub${rnd}`, name: 'V4 Sub', password: 'v4-sub-pass-1' });
  const subCod = await subUser.post('/api/memberships/subscribe', { planId: 'pro_12mo', paymentMethodId: 'cash', idempotencyKey: `v4sub-${rnd}` });
  const mine = await subUser.get('/api/memberships/mine');
  // The membership READ always carries an `active` boolean, so a substring
  // test on the serialized body can never distinguish "no membership" from
  // "membership active". Assert the STATE instead: the tier stays free, the
  // status flag is false and not a single membership row exists.
  const subMemberships = mine.data?.memberships ?? [];
  check('PAY-03 a subscription cannot be created without wallet funds — COD never activates it',
    subCod.status >= 400 && mine.data?.status?.active !== true && mine.data?.status?.tier === 'free' &&
    subMemberships.length === 0,
    `status=${subCod.status} ${JSON.stringify(subCod.data).slice(0, 120)} mine=${JSON.stringify(mine.data?.status ?? {}).slice(0, 120)} rows=${subMemberships.length}`);
  {
    const codSnap = (await buyerMoney.get(`/api/orders/${codOrderId}`)).data?.order?.financial;
    check('PAY-03 points on a COD order appear only after a RECORDED collection, never at delivery',
      codSnap?.settlement?.fully_settled === true && codSnap?.points?.released === 12 && codSnap?.collected_iqd === codSnap?.total_iqd,
      JSON.stringify({ s: codSnap?.settlement, p: codSnap?.points?.released, c: codSnap?.collected_iqd }).slice(0, 200));
  }

  // PAY-03 — a refund never exceeds what was actually paid, and never repeats.
  await clearCart(buyerMoney);
  await buyerMoney.post('/api/cart/items', { productId: p500.id, qty: 1 });
  r = await admin.post('/api/admin/wallet/credit', { userId: buyerMoneyId, currency: 'POINT', amount: 100, note: 'v4 refund test points' });
  const beforeRefund = await centsOf(buyerMoney);
  const pointsBeforeRefund = await pointsOf(buyerMoney);
  const refundOrder = await order(buyerMoney, { addressId: addrMoney, paymentMethodId: 'wallet', useWallet: true, usePoints: true, idempotencyKey: `v4ref-${rnd}` });
  const RO = refundOrder.data?.order;
  const paidCents = beforeRefund.usd_cents_settled - (await centsOf(buyerMoney)).usd_cents_settled;
  const cancel1 = await buyerMoney.post(`/api/orders/${RO?.id}/cancel`, {});
  const afterRefundCents = await centsOf(buyerMoney);
  const afterRefundPoints = await pointsOf(buyerMoney);
  check('PAY-03 cancelling returns exactly what was paid — cash to cash, points to points',
    cancel1.status === 200 && afterRefundCents.usd_cents_settled === beforeRefund.usd_cents_settled &&
    afterRefundPoints === pointsBeforeRefund,
    `paid=${paidCents} settled ${beforeRefund.usd_cents_settled}→${afterRefundCents.usd_cents_settled} points ${pointsBeforeRefund}→${afterRefundPoints}`);
  const cancel2 = await buyerMoney.post(`/api/orders/${RO?.id}/cancel`, {});
  check('PAY-03 a repeated refund is refused and pays nothing twice',
    cancel2.status >= 400 && (await centsOf(buyerMoney)).usd_cents_settled === afterRefundCents.usd_cents_settled &&
    (await pointsOf(buyerMoney)) === afterRefundPoints,
    `status=${cancel2.status}`);
  check('PAY-03 the cancelled order\'s pending accrual is cancelled, never released',
    (await buyerMoney.get(`/api/orders/${RO?.id}`)).data?.order?.financial?.points?.state === 'cancelled',
    JSON.stringify((await buyerMoney.get(`/api/orders/${RO?.id}`)).data?.order?.financial?.points ?? {}).slice(0, 160));
  blocked('PAY-02 COD eligibility per product class / community store, and mixed-payment limits',
    'which orders may use COD is an owner decision (mandate §13.3); today every checkout path shares one server-side computation, and the digital subscription path has no COD branch at all');
  notRun('PAY-04 staff-role separation on cost/profit fields',
    'only admin/customer roles exist today — granular finance/support roles are not built, so there is no unauthorised assistant to test');

  // ------------------------------------------------------------------ summary
  console.log(`\n${passed} passed, ${failed} failed, ${notRunCount} not executed, ${blockedCount} blocked`);
  if (notRunList.length) {
    console.log('Not executed (honest — NOT passes):');
    for (const n of notRunList) console.log(' ·', n);
  }
  if (blockedList.length) {
    console.log('Blocked (unconfigured precondition or owner decision — NOT passes):');
    for (const b of blockedList) console.log(' ~', b);
  }
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(' -', f);
    process.exit(1);
  }
}

main().catch((e) => { console.error('v4 test run crashed:', e); process.exit(1); });
