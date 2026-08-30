#!/usr/bin/env node
/**
 * v3 API verification — final-phase mandate (customer protection, after-sales,
 * PRO operations). Runs after scripts/api-tests.mjs and api-tests-v2.mjs
 * against the same base (local wrangler dev or staging).
 *
 * Same contracts as v2: cookie-jar Client, PROMOTE_CMD with {SQL} +
 * JSON.stringify quoting, launch-state tolerance, fresh random users per run
 * (rate limits key per user).
 *
 * Results are reported in THREE buckets (mandate §14): passed, failed and
 * BLOCKED. A check whose precondition is honestly unconfigured (no
 * TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET, no KYC_ENC_KEY, no EMAIL_API_KEY,
 * printer-fee mapping pending the owner — docs/DECISIONS.md) records as
 * blocked-with-reason, never as passed.
 *
 * Fixtures are SYNTHETIC only — no real identity data anywhere.
 */
import { execSync } from 'node:child_process';

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';
let passed = 0, failed = 0, blockedCount = 0;
const failures = [];
const blockedList = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`FAIL  ${name} ${extra}`); }
}
function blocked(name, reason) {
  blockedCount++;
  blockedList.push(`${name} — ${reason}`);
  console.log(` BLK  ${name} — ${reason}`);
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
// Test-only side door for states no API may create (promote admin, activate a
// test membership, insert an approved PRO address, backdate delivered_at).
function sqlExec(sql) {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(sql)), { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
}
function promoteAdmin(email) {
  sqlExec(`UPDATE users SET role='admin' WHERE email='${email}'`);
}

// ------------------------------------------------------------- file fixtures
// 1×1 transparent PNG (valid magic + IHDR) and a minimal MP4 ftyp box — enough
// for the server's magic-byte sniffing. Synthetic bytes, no real media.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // ....ftyp
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00, // mp42....
  0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d, // mp42isom
]);
async function uploadReviewFile(client, purpose, bytes, filename) {
  const form = new FormData();
  form.set('purpose', purpose);
  form.set('file', new Blob([bytes]), filename);
  return client.req('POST', '/api/reviews/uploads', form);
}

// ---------------------------------------------------------------- helpers
async function deliverOrder(admin, orderId) {
  let last = null;
  for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
    last = await admin.patch(`/api/admin/orders/${orderId}`, { status });
    if (last.status !== 200) return last;
  }
  return last;
}

async function clearCart(client) {
  const r = await client.get('/api/cart');
  for (const it of r.data?.items ?? []) await client.del(`/api/cart/items/${it.id}`);
}

/** POST that tolerates a route being mounted at one of two candidate paths
 *  (contract path first, observed implementation path second). */
async function postAt(client, paths, body) {
  let last = null;
  for (const p of paths) {
    last = await client.post(p, body);
    if (last.status !== 404) return { ...last, path: p };
  }
  return { ...last, path: paths[paths.length - 1] };
}

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const admin = new Client();
  const buyerA = new Client();
  const buyerB = new Client();
  const pointsBuyer = new Client();
  const proBuyer = new Client();
  const anon = new Client();

  // -------------------------------------------------------------- mounted?
  // The final-phase routers must be registered in worker/index.ts. If they
  // are not, every check below would fail confusingly — probe once, honestly.
  {
    const probe = await anon.get('/api/policies');
    if (probe.status === 404) {
      check('final-phase routes mounted (/api/policies reachable)', false,
        'worker/index.ts does not mount the final-phase routers yet — integration wiring pending');
      console.log(`\n${passed} passed, ${failed} failed, ${blockedCount} blocked`);
      console.log('Failures:');
      for (const f of failures) console.log(' -', f);
      process.exit(1);
    }
  }

  // Persistent-DB idempotency: a previous run may have published checkout
  // policies, so EVERY ordinary checkout in this suite attaches the current
  // required acceptances (empty list before anything is published).
  let ACC = [];
  async function refreshAcceptance() {
    const pr = await anon.get('/api/policies');
    ACC = (pr.data?.policies ?? [])
      .filter((p) => p.required_for_checkout)
      .map((p) => ({ key: p.key, version: p.version }));
  }
  await refreshAcceptance();

  console.log('\n— setup (fresh synthetic users)');
  // Repeated same-IP runs (local re-runs, CI retries) can exhaust the
  // anonymous register bucket (30/hour/IP) — clear ONLY that bucket through
  // the test SQL channel so re-runs stay reproducible. Best-effort.
  try { sqlExec("DELETE FROM rate_limits WHERE key LIKE 'register:%'"); } catch { /* non-fatal */ }

  let r = await admin.post('/api/auth/register', { email: `v3adm-${rnd}@test.local`, username: `v3adm${rnd}`, name: 'V3 Admin', password: 'v3-admin-pass-1' });
  if (r.status === 429) {
    console.error('FATAL: registration rate-limited — the register:<ip> bucket is exhausted and the SQL channel could not clear it.');
    process.exit(1);
  }
  check('admin account', r.status === 200);
  promoteAdmin(`v3adm-${rnd}@test.local`);
  r = await buyerA.post('/api/auth/register', { email: `v3a-${rnd}@test.local`, username: `v3a${rnd}`, name: 'V3 Buyer A', password: 'v3-buyer-pass-1' });
  check('buyer A account', r.status === 200);
  r = await buyerB.post('/api/auth/register', { email: `v3b-${rnd}@test.local`, username: `v3b${rnd}`, name: 'V3 Buyer B', password: 'v3-buyer-pass-2' });
  check('buyer B account', r.status === 200);
  await pointsBuyer.post('/api/auth/register', { email: `v3p-${rnd}@test.local`, username: `v3p${rnd}`, name: 'V3 Points', password: 'v3-points-pass-1' });
  await proBuyer.post('/api/auth/register', { email: `v3pro-${rnd}@test.local`, username: `v3pro${rnd}`, name: 'Pro Buyer', password: 'v3-pro-pass-1' });
  const buyerAId = (await buyerA.get('/api/auth/me')).data?.user?.id;
  const proId = (await proBuyer.get('/api/auth/me')).data?.user?.id;

  // Taxonomy + fixture products (canonical products-v2 editor).
  r = await admin.post('/api/admin/products-v2/brands', { name_ar: 'بامبو لاب', name_en: 'Bambu Lab' });
  const brandId = r.data?.brand?.id ?? r.data?.id;
  r = await admin.post('/api/admin/products-v2/catalogs', { name_ar: 'طابعات', name_en: 'Printers', is_printer_catalog: true });
  const printerCatalogId = r.data?.catalog?.id ?? r.data?.id;
  check('brand + printer catalog', !!brandId && !!printerCatalogId);

  const baseDoc = (nameEn, priceIqd, extra = {}) => ({
    name_ar: `منتج ${nameEn} ${rnd}`, name_en: `${nameEn} ${rnd}`,
    description_ar: 'وصف اختبار', price_iqd: priceIqd,
    selling_type: 'in_stock', stock: 100, status: 'active', brand_id: brandId,
    catalog_ids: [], options: [], colors: [], spec_groups: [],
    media: [], labels: [], content_blocks: [], payment_options: [], hashtags: [], how_to_use: '',
    preorder_transports: [], warranty_plans: [],
    ...extra,
  });
  async function createProduct(nameEn, priceIqd, extra = {}) {
    const res = await admin.post('/api/admin/products-v2', baseDoc(nameEn, priceIqd, extra));
    return { id: res.data?.product?.id, slug: res.data?.product?.slug, status: res.status, data: res.data, doc: baseDoc(nameEn, priceIqd, extra) };
  }

  const prodOrdinary = await createProduct('Ordinary', 10000);
  const prodPrinter = await createProduct('Printer A1', 200000, {
    catalog_ids: [printerCatalogId],
    warranty_plans: [{ id: 'ext24', title_ar: 'تمديد سنتان', duration_months: 24, duration_kind: 'extension', fee_iqd: 20000, order: 0, active: true }],
  });
  const prodAms = await createProduct('AMS 2 Pro', 50000);
  const prodP999 = await createProduct('P999', 999);
  const prodP1000 = await createProduct('P1000', 1000);
  const prodP1999 = await createProduct('P1999', 1999);
  const prodReturn = await createProduct('Returnable', 12000);
  const prodDrop = await createProduct('Droppable', 10000);
  const prod75000 = await createProduct('T75000', 75000);
  const prod75001 = await createProduct('T75001', 75001);
  const prodPrinterClass = await createProduct('PrinterSized', 30000);
  check('fixture products created', [prodOrdinary, prodPrinter, prodAms, prodP999, prodP1000, prodP1999, prodReturn, prodDrop, prod75000, prod75001, prodPrinterClass].every((p) => !!p.id),
    JSON.stringify(prodOrdinary.data ?? {}).slice(0, 160));

  // Device eligibility is explicit configuration, never name-guessing:
  r = await admin.post(`/api/devices/admin/products/${prodPrinter.id}/ops-policy`, { serialized: true, warranty_base_months: 12 });
  check('printer ops-policy: serialized + 12 base months', r.status === 200 && r.data?.ops_policy?.serialized === true && r.data?.ops_policy?.warranty_base_months === 12);
  r = await admin.post(`/api/devices/admin/products/${prodAms.id}/ops-policy`, { serialized: true });
  check('AMS ops-policy: serialized, base months honestly unconfigured', r.status === 200 && r.data?.ops_policy?.warranty_base_months === null);
  // size_class is part of ops_policy — set through the test SQL channel (the
  // owner mapping itself is decision row 16; the class only marks the product).
  sqlExec(`UPDATE products SET ops_policy='{"serialized":false,"size_class":"printer_small"}' WHERE id='${prodPrinterClass.id}'`);

  // Addresses.
  r = await buyerA.post('/api/addresses', { label: 'Home', name: 'V3 Buyer A', phone: '+9647701112233', address: 'Baghdad, Test District 3' });
  const addrA = r.data?.id;
  r = await buyerB.post('/api/addresses', { label: 'Home', name: 'V3 Buyer B', phone: '+9647702223344', address: 'Basra, Test District 4' });
  const addrB = r.data?.id;
  r = await pointsBuyer.post('/api/addresses', { label: 'Home', name: 'V3 Points', phone: '+9647703334455', address: 'Erbil, Test District 5' });
  const addrP = r.data?.id;
  check('addresses created', !!addrA && !!addrB && !!addrP);

  // ================================================================ policies
  console.log('\n— policies: empty-honest before publishing (§7)');
  r = await anon.get('/api/policies');
  const prePublished = r.data?.policies ?? [];
  if (r.status === 200 && prePublished.length === 0) {
    check('policy list is honestly empty before publishing', true);
  } else if (r.status === 200) {
    blocked('policy list is honestly empty before publishing', `persistent DB already has ${prePublished.length} published policies — pre-publish state not reproducible this run`);
  } else {
    check('policy list is honestly empty before publishing', false, `status=${r.status}`);
  }
  r = await anon.get('/api/policies/terms');
  check('unpublished policy body → 404 (never a draft leak)', prePublished.length > 0 || r.status === 404, `status=${r.status}`);

  // ================================================================ telegram
  console.log('\n— telegram linking, webhook, OTP (§2)');
  r = await buyerA.post('/api/telegram/link/start', { phone: '07701112233' });
  if (r.status === 503) {
    check('link/start honest 503 while TELEGRAM_BOT_TOKEN unset', (r.data?.code === 'NOT_CONFIGURED' || /not configured|unreachable/i.test(r.data?.error ?? '')), JSON.stringify(r.data).slice(0, 120));
    blocked('deep link issuance + phone-masked challenge', 'TELEGRAM_BOT_TOKEN not configured in this environment (decision row 26 secrets)');
  } else {
    check('link/start issues an opaque deep link (no phone in URL)', r.status === 200 && String(r.data?.deep_link ?? '').startsWith('https://t.me/') && !String(r.data?.deep_link).includes('7701112233'), JSON.stringify(r.data).slice(0, 160));
    check('link/start masks the phone', typeof r.data?.phone_masked === 'string' && !r.data.phone_masked.includes('7701112233'.slice(0, 8)));
  }
  r = await buyerA.post('/api/telegram/link/start', { phone: 'not-a-phone' });
  check('link/start rejects an invalid phone (before any Telegram call)', r.status === 400, `status=${r.status}`);
  r = await buyerA.get('/api/telegram/link/status');
  check('link/status reachable, not linked yet', r.status === 200 && r.data?.linked === false, JSON.stringify(r.data).slice(0, 120));

  // Webhook: 503 honest when the secret is unset; 403 on a wrong header when
  // it is set; update_id dedupe with the real secret (only if the runner has it).
  r = await anon.post('/api/telegram/webhook', { update_id: 1 }, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' });
  if (r.status === 503) {
    check('webhook honest 503 while TELEGRAM_WEBHOOK_SECRET unset', true);
    blocked('webhook wrong-secret 403 + update_id dedupe', 'TELEGRAM_WEBHOOK_SECRET not configured in this environment');
  } else {
    check('webhook rejects a wrong secret header (403)', r.status === 403, `status=${r.status}`);
    const secret = process.env.TEST_TELEGRAM_WEBHOOK_SECRET || '';
    if (secret) {
      const upd = { update_id: Math.floor(Math.random() * 1e9) };
      const w1 = await anon.post('/api/telegram/webhook', upd, { 'X-Telegram-Bot-Api-Secret-Token': secret });
      const w2 = await anon.post('/api/telegram/webhook', upd, { 'X-Telegram-Bot-Api-Secret-Token': secret });
      check('webhook accepts the real secret and dedupes a replayed update_id (both 200)', w1.status === 200 && w2.status === 200, `${w1.status}/${w2.status}`);
    } else {
      blocked('webhook update_id dedupe with the real secret', 'TEST_TELEGRAM_WEBHOOK_SECRET not provided to the test runner (never hardcoded)');
    }
  }
  r = await buyerA.post('/api/telegram/otp/verify', { purpose: 'reset', code: '000000' });
  check('otp/verify with no active challenge → OTP_NOT_FOUND', r.status === 400 && r.data?.code === 'OTP_NOT_FOUND', JSON.stringify(r.data).slice(0, 120));

  // Telegram SIGN-IN/SIGN-UP endpoints (auth/UI mandate §4) — anonymous.
  r = await anon.post('/api/auth/telegram/start', { phone: 'abcdefghij', purpose: 'signup' });
  check('tg-auth start rejects an invalid phone (400 INVALID_PHONE)', r.status === 400 && r.data?.code === 'INVALID_PHONE', JSON.stringify(r.data).slice(0, 120));
  r = await anon.post('/api/auth/telegram/start', { phone: '٠٧٧٠١٢٣٤٥٦٧', purpose: 'signup' });
  if (r.status === 503) {
    blocked('tg-auth start deep link (Arabic-digit phone accepted)', 'TELEGRAM_BOT_TOKEN not configured in this environment');
  } else {
    check('tg-auth start: Arabic-digit phone accepted, opaque link + masked phone, no phone in URL',
      r.status === 200 && !!r.data?.deep_link && !!r.data?.continuation_token &&
      !String(r.data.deep_link).includes('7701234567') && String(r.data?.phone_masked ?? '').includes('*'),
      JSON.stringify(r.data).slice(0, 160));
  }
  r = await anon.get('/api/auth/telegram/status?token=bogus-continuation-token');
  check('tg-auth status with a bogus token answers generically (no 500, no data)', r.status !== 500 && !JSON.stringify(r.data ?? {}).includes('@'), `status=${r.status}`);
  r = await anon.post('/api/auth/telegram/complete', { token: 'bogus-continuation-token', code: '000000' });
  check('tg-auth complete with a bogus token/code rejected safely', r.status >= 400 && r.status < 500, `status=${r.status}`);

  // ===================================================== email verification
  console.log('\n— email verification + password flows (§3)');
  r = await buyerA.get('/api/auth/verify-email/status');
  const emailConfigured = r.data?.emailConfigured === true;
  check('verify-email/status reports config + unverified', r.status === 200 && r.data?.verified === false, JSON.stringify(r.data).slice(0, 120));
  r = await buyerA.post('/api/auth/verify-email/send', {});
  if (!emailConfigured) {
    check('verify-email/send honest 503 while EMAIL_API_KEY unset', r.status === 503 && r.data?.code === 'EMAIL_NOT_CONFIGURED', JSON.stringify(r.data).slice(0, 120));
    blocked('email verification end-to-end (send → confirm)', 'EMAIL_API_KEY/EMAIL_FROM not configured (decision row 14)');
  } else {
    check('verify-email/send enqueues generically (no enumeration)', r.status === 200, JSON.stringify(r.data).slice(0, 120));
    blocked('email verification confirm with a real token', 'requires reading the owner-approved test inbox — manual staging step');
  }
  r = await anon.req('GET', '/api/auth/verify-email/confirm');
  check('confirm is POST-only (a scanner GET cannot consume a token)', r.status === 404 || r.status === 405, `status=${r.status}`);
  r = await anon.post('/api/auth/verify-email/confirm', { token: 'x'.repeat(43) });
  check('confirm with an unknown token is rejected', r.status === 400, `status=${r.status}`);

  // ================================================================ invoices
  console.log('\n— invoices: one per order, owner-gated (§3)');
  r = await buyerA.post('/api/cart/items', { productId: prodOrdinary.id, qty: 2 });
  check('cart accepts ordinary product', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  r = await buyerA.post('/api/orders', { addressId: addrA, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], policyAcceptance: ACC, idempotencyKey: `v3inv-${rnd}` });
  check('order created with an invoice number', r.status === 200 && !!r.data?.invoice_no, JSON.stringify(r.data).slice(0, 200));
  const orderInv = r.data?.order?.id;
  const invoiceNo1 = r.data?.invoice_no;
  check('ordinary delivery 5,000 IQD on the order', r.data?.order?.shipping_iqd === 5000, `shipping=${r.data?.order?.shipping_iqd}`);
  const replayInv = await buyerA.post('/api/orders', { addressId: addrA, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], policyAcceptance: ACC, idempotencyKey: `v3inv-${rnd}` });
  check('idempotency replay returns the same order + same invoice', replayInv.status === 200 && replayInv.data?.order?.id === orderInv && replayInv.data?.invoice_no === invoiceNo1, JSON.stringify({ o: replayInv.data?.order?.id, i: replayInv.data?.invoice_no }).slice(0, 140));
  r = await buyerA.get('/api/invoices/mine');
  const myInvoices = (r.data?.invoices ?? []).filter((i) => i.order_id === orderInv);
  check('exactly ONE invoice exists for the order after replay', myInvoices.length === 1, `count=${myInvoices.length}`);
  const invoiceId = myInvoices[0]?.id;
  check('invoice honestly unpaid for cash-on-delivery (never "paid")', ['cod_due', 'unpaid'].includes(myInvoices[0]?.payment_status), `status=${myInvoices[0]?.payment_status}`);
  r = await buyerA.get(`/api/invoices/${invoiceId}`);
  check('owner reads own invoice with snapshot', r.status === 200 && !!r.data?.invoice?.snapshot, JSON.stringify(r.data).slice(0, 120));
  r = await buyerB.get(`/api/invoices/${invoiceId}`);
  check('IDOR: user B cannot read A\'s invoice (404, no data)', r.status === 404 && !r.text.includes(orderInv), `status=${r.status}`);
  r = await anon.get(`/api/invoices/${invoiceId}`);
  check('anonymous invoice read → 401', r.status === 401);

  // ========================================================== devices (§4)
  console.log('\n— serialized devices: 5 printers + 1 AMS = 6 units (§4)');
  r = await buyerA.post('/api/cart/items', { productId: prodPrinter.id, qty: 5, warrantyPlanId: 'ext24' });
  check('cart: 5 printers with +24 extension', r.status === 200, JSON.stringify(r.data).slice(0, 160));
  r = await buyerA.post('/api/cart/items', { productId: prodAms.id, qty: 1 });
  check('cart: 1 AMS', r.status === 200);
  r = await buyerA.post('/api/orders', { addressId: addrA, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], policyAcceptance: ACC, idempotencyKey: `v3dev-${rnd}` });
  check('device order created', r.status === 200, JSON.stringify(r.data).slice(0, 200));
  const devOrder = r.data?.order?.id;

  let del = await deliverOrder(admin, devOrder);
  check('delivered transition creates 6 physical units', del.status === 200 && del.data?.device_units?.created === 6, JSON.stringify(del.data).slice(0, 160));
  const replayDel = await admin.patch(`/api/admin/orders/${devOrder}`, { status: 'delivered' });
  check('replayed delivered transition rejected (no duplicate units/awards)', replayDel.status === 400, `status=${replayDel.status}`);

  r = await admin.get(`/api/devices/admin/orders/${devOrder}/units`);
  const units = r.data?.units ?? [];
  check('admin unit list shows exactly 6 units', units.length === 6, `count=${units.length}`);
  const deliveredAt = r.data?.order?.delivered_at;
  const printerUnits = units.filter((u) => u.product?.id === prodPrinter.id);
  const amsUnit = units.find((u) => u.product?.id === prodAms.id);
  check('printer units: 12 base + 24 purchased extension months', printerUnits.length === 5 && printerUnits.every((u) => u.warranty?.base_months === 12 && u.warranty?.ext_months === 24), JSON.stringify(printerUnits[0]?.warranty ?? {}).slice(0, 140));
  check('warranty_start_at equals authenticated delivered_at', printerUnits.every((u) => u.warranty?.start_at === deliveredAt && u.delivered_at === deliveredAt), `start=${printerUnits[0]?.warranty?.start_at} delivered=${deliveredAt}`);
  check('AMS coverage honestly needs_config (no invented duration)', !!amsUnit && amsUnit.warranty?.end_at === null && amsUnit.warranty?.state === 'needs_config', JSON.stringify(amsUnit?.warranty ?? {}).slice(0, 140));

  const unit1 = printerUnits[0]?.unit_id;
  const unit2 = printerUnits[1]?.unit_id;
  const serial1 = `V3SN-${rnd}-0001`;
  r = await admin.post(`/api/devices/admin/units/${unit1}/serial`, { serial: serial1 });
  check('admin assigns a serial to unit 1', r.status === 200 && r.data?.serial === serial1, JSON.stringify(r.data).slice(0, 120));
  r = await admin.post(`/api/devices/admin/units/${unit2}/serial`, { serial: serial1 });
  check('duplicate serial on another unit rejected (409 REASSIGN_REQUIRED)', r.status === 409, `status=${r.status}`);
  r = await admin.post(`/api/devices/admin/units/${unit2}/serial`, { serial: `V3SN-${rnd}-0002` });
  check('distinct serial for unit 2 accepted', r.status === 200);

  // Registration: non-enumerating for foreign/unknown; never touches dates.
  const foreign = await buyerB.post('/api/devices/register', { serial: serial1 });
  const unknown = await buyerB.post('/api/devices/register', { serial: `V3SN-${rnd}-NOPE` });
  check('foreign serial → non-enumerating 404 (no owner/order leak)', foreign.status === 404 && !foreign.text.includes(devOrder) && !foreign.text.includes(String(buyerAId)), foreign.text.slice(0, 120));
  check('unknown serial → the SAME generic answer as a foreign one', unknown.status === 404 && unknown.data?.error === foreign.data?.error, `${unknown.status}`);
  r = await buyerA.post('/api/devices/register', { serial: ` v3sn-${rnd}-0001 ` });
  check('owner registers (normalized lookup, exact serial preserved masked)', r.status === 200 && r.data?.device?.unit_id === unit1, JSON.stringify(r.data).slice(0, 200));
  check('registration does NOT restart the clock (start still delivered_at)', r.data?.device?.warranty?.start_at === deliveredAt, `start=${r.data?.device?.warranty?.start_at}`);
  const rereg = await buyerA.post('/api/devices/register', { serial: serial1 });
  check('duplicate registration idempotent', rereg.status === 200 && rereg.data?.already_registered === true);
  r = await buyerA.get('/api/devices/mine');
  check('devices/mine lists the registered device', r.status === 200 && (r.data?.devices ?? []).some((d) => d.unit_id === unit1));

  // End-of-month/leap-year math: delivered 2024-02-29 + 12 base + 24 ext = 36
  // months → 2027-02-28 (2027 is not a leap year).
  r = await admin.patch(`/api/devices/admin/units/${unit2}/delivery`, { delivered_at: '2024-02-29T10:00:00.000Z', reason: 'v3 test: leap-day delivery correction' });
  check('+36 months from 2024-02-29 clamps to 2027-02-28 (leap/end-of-month safe)', r.status === 200 && String(r.data?.warranty_end_at ?? '').startsWith('2027-02-28'), `end=${r.data?.warranty_end_at}`);

  // Claims: owner-only on the unit.
  const claimPaths = [`/api/devices/${unit1}/claims`, `/api/devices/units/${unit1}/claims`];
  let cl = await postAt(buyerA, claimPaths, { subject: 'Nozzle jams', description: 'The nozzle clogs after every print since delivery. Synthetic test claim.' });
  check('owner opens a warranty claim on the registered unit', cl.status === 200 && !!cl.data?.id && !!cl.data?.warranty_facts, `${cl.status} via ${cl.path}`);
  const claimId = cl.data?.id;
  const clB = await postAt(buyerB, claimPaths, { subject: 'Not mine', description: 'Attempting a claim on a foreign unit for the IDOR test.' });
  check('IDOR: user B cannot open a claim on A\'s unit (404)', clB.status === 404, `status=${clB.status}`);
  r = await buyerB.get(`/api/devices/claims/${claimId}`);
  check('IDOR: user B cannot read A\'s claim (404)', r.status === 404, `status=${r.status}`);
  r = await buyerA.get(`/api/devices/claims/${claimId}`);
  check('owner reads own claim with authorized warranty facts', r.status === 200 && r.data?.warranty_facts?.order_id === devOrder);

  // ===================================================== reviews and gifts
  console.log('\n— printer reviews, quality score, gift levels (§5)');
  const up1 = await uploadReviewFile(buyerA, 'media', PNG_BYTES, 'photo1.png');
  const up2 = await uploadReviewFile(buyerA, 'media', MP4_BYTES, 'video1.mp4');
  const upE = await uploadReviewFile(buyerA, 'evidence', PNG_BYTES, 'story.png');
  check('review media + evidence uploads (sniffed)', up1.status === 200 && up2.status === 200 && up2.data?.kind === 'video' && upE.status === 200, JSON.stringify({ a: up1.status, b: up2.status, c: upE.status }));
  const reviewBody =
    'صراحة النتيجة خيبت ظني: طبقات غير متساوية بعد المعايرة، وضجيج المراوح عالٍ جدًا ليلًا. ' +
    'التغليف كان جيدًا والتجميع سهل، لكن جودة الطباعة الافتراضية تحتاج ضبطًا يدويًا طويلًا. Honest critical test review.';
  r = await buyerA.post('/api/reviews', {
    productId: prodPrinter.id, orderId: devOrder, stars: 1, body: reviewBody,
    photoKeys: [up1.data?.key], videoKey: up2.data?.key, instagram: { key: upE.data?.key },
  });
  check('delivered buyer submits a 1-star critical review with full proof', r.status === 200 && !!r.data?.review, JSON.stringify(r.data).slice(0, 200));
  const reviewId = r.data?.review?.id;
  const dup = await buyerA.post('/api/reviews', { productId: prodPrinter.id, orderId: devOrder, stars: 1, body: reviewBody, photoKeys: [up1.data?.key], videoKey: up2.data?.key, instagram: { key: upE.data?.key } });
  check('duplicate review rejected (one per user+product)', dup.status === 409, `status=${dup.status}`);
  const noBuy = await buyerB.post('/api/reviews', { productId: prodPrinter.id, orderId: devOrder, stars: 5, body: reviewBody, photoKeys: [], instagram: {} });
  check('non-buyer cannot review with someone else\'s order id', noBuy.status === 404, `status=${noBuy.status}`);

  r = await admin.post(`/api/reviews/admin/${reviewId}/reward`, { action: 'approve', qualityScore: 3, reason: 'Detailed critical writing, photos, video and Instagram evidence all present — quality is not sentiment.' });
  check('admin approves quality score 3 on the 1-star review (score ≠ stars)', r.status === 200 && r.data?.quality_score === 3 && !!r.data?.entitlement_id, JSON.stringify(r.data).slice(0, 160));
  const entId = r.data?.entitlement_id;
  const reApprove = await admin.post(`/api/reviews/admin/${reviewId}/reward`, { action: 'approve', qualityScore: 5, reason: 'Replay must not duplicate the entitlement — testing idempotency.' });
  check('re-approving the same reward rejected (no duplicate entitlement)', reApprove.status === 409, `status=${reApprove.status}`);

  r = await buyerA.get('/api/reviews/gifts');
  const myGift = (r.data?.gifts ?? []).find((g) => g.id === entId);
  check('entitlement visible with max level 3', r.status === 200 && myGift?.max_level === 3 && myGift?.state === 'available', JSON.stringify(myGift ?? {}).slice(0, 160));
  r = await buyerA.post(`/api/reviews/gifts/${entId}/redeem`, { level: 4 });
  check('score 3: box 4 locked (LEVEL_LOCKED)', r.status === 400 && r.data?.code === 'LEVEL_LOCKED', JSON.stringify(r.data).slice(0, 120));
  r = await buyerA.post(`/api/reviews/gifts/${entId}/redeem`, { level: 2 });
  check('unstocked pool → honest GIFT_POOL_UNCONFIGURED (503), gift preserved', r.status === 503 && r.data?.code === 'GIFT_POOL_UNCONFIGURED', JSON.stringify(r.data).slice(0, 140));

  r = await admin.post('/api/reviews/admin/pools', { level: 1, kind: 'accessory', label_ar: 'مغناطيسات بامبو', label_en: 'Bambu magnets', stock: 2 });
  check('admin stocks a level-1 accessory pool item', r.status === 200 && !!r.data?.item?.id, JSON.stringify(r.data).slice(0, 140));
  const poolsBefore = new Map(((await admin.get('/api/reviews/admin/pools')).data?.items ?? []).map((i) => [i.id, i.stock]));
  r = await buyerA.post(`/api/reviews/gifts/${entId}/redeem`, { level: 1 });
  const redeemedContents = JSON.stringify(r.data?.gift?.contents ?? null);
  check('box 1 redeems once with server-chosen persisted contents', r.status === 200 && r.data?.gift?.state === 'selected' && r.data?.gift?.chosen_level === 1 && (r.data?.gift?.contents ?? []).length === 1, JSON.stringify(r.data).slice(0, 200));
  const again = await buyerA.post(`/api/reviews/gifts/${entId}/redeem`, { level: 1 });
  check('second redeem cannot spend again (409, or replay of the SAME selection — no reroll)',
    again.status === 409 || (again.status === 200 && again.data?.replay === true && JSON.stringify(again.data?.gift?.contents ?? null) === redeemedContents),
    JSON.stringify(again.data).slice(0, 140));
  r = await admin.get('/api/reviews/admin/pools');
  // Random selection may draw a leftover in-stock level-1 item from a
  // previous run on a persistent DB — assert on the item the redemption
  // actually selected (contents[].item_id), not on the one seeded above.
  const selectedItemId = (JSON.parse(redeemedContents) ?? [])[0]?.item_id;
  const stockAfter = ((r.data?.items ?? []).find((i) => i.id === selectedItemId))?.stock;
  const stockBefore = poolsBefore.get(selectedItemId);
  check('selected pool item stock decremented exactly once',
    Number.isInteger(stockAfter) && stockAfter === Number(stockBefore) - 1,
    `selected=${selectedItemId} before=${stockBefore} after=${stockAfter}`);
  const foreignRedeem = await buyerB.post(`/api/reviews/gifts/${entId}/redeem`, { level: 1 });
  check('IDOR: user B cannot redeem A\'s gift (404)', foreignRedeem.status === 404, `status=${foreignRedeem.status}`);

  // ============================================ points (INTEGRATED §4.2/§4.3)
  //
  // SUPERSEDED RULE: this section used to assert the final-phase rule
  // (1,000 IQD = 1 point, awarded at the `delivered` event). The integrated
  // mandate replaces it and explicitly overrides earlier phases:
  //   * 100 IQD of NET ELIGIBLE MERCHANDISE = 1 point (floor once, on the
  //     order total — delivery fees never earn),
  //   * the accrual is created PENDING at purchase, and releases only when
  //     BOTH the payment is settled AND seven days have passed.
  // These orders are COD and nothing has been collected, so `delivered`
  // must release NOTHING — the exactly-once guarantee is asserted on the
  // settlement path instead, which is where the release now happens.
  // The full new-rule matrix (99/100/199, the §5 arithmetic, the day-9
  // collection, the legacy-rate row) lives in scripts/api-tests-v4.mjs.
  console.log('\n— purchase points: 100 IQD = 1 point, pending until settled + 7 days');
  const pointsOrders = [];
  for (const [prod, key, label, expected] of [
    [prodP999, 'a', '999', 9],
    [prodP1000, 'b', '1,000', 10],
    [prodP1999, 'c', '1,999', 19],
  ]) {
    await pointsBuyer.post('/api/cart/items', { productId: prod.id, qty: 1 });
    const o = await pointsBuyer.post('/api/orders', { addressId: addrP, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], policyAcceptance: ACC, idempotencyKey: `v3pt-${key}-${rnd}` });
    pointsOrders.push({ id: o.data?.order?.id, due: o.data?.order?.financial?.due_on_delivery_iqd });
    const pts = o.data?.order?.financial?.points ?? {};
    check(`${label} IQD of merchandise accrues exactly ${expected} PENDING points (100:1, floor)`,
      pts.pending === expected && pts.state === 'pending' && pts.iqd_per_point === 100,
      JSON.stringify(pts).slice(0, 160));
  }
  check('three point-test orders created', pointsOrders.every((o) => !!o.id), JSON.stringify(pointsOrders.map((o) => o.id)));
  const beforeDelivery = (await pointsBuyer.get('/api/rewards')).data?.point_balance;
  for (const o of pointsOrders) {
    const d = await deliverOrder(admin, o.id);
    check(`delivery of ${o.id} succeeded`, d.status === 200, JSON.stringify(d.data).slice(0, 120));
  }
  const afterDelivery = (await pointsBuyer.get('/api/rewards')).data?.point_balance;
  check('delivery alone releases NOTHING while the COD cash is uncollected',
    afterDelivery === beforeDelivery, `balance ${beforeDelivery}→${afterDelivery}`);
  const replayPts = await admin.patch(`/api/admin/orders/${pointsOrders[1].id}`, { status: 'delivered' });
  const afterReplay = await pointsBuyer.get('/api/rewards');
  check('replayed delivered transition is refused and awards nothing',
    replayPts.status === 400 && afterReplay.data?.point_balance === beforeDelivery,
    `status=${replayPts.status} balance=${afterReplay.data?.point_balance}`);
  // Settlement past the seven-day mark: the clock started at PURCHASE, so
  // backdating the accrual is the only thing needed — then a recorded
  // collection releases exactly the pending amount, exactly once.
  sqlExec(
    `UPDATE points_accruals SET purchase_at='${iso(NOW - 9 * 86400_000)}', available_at='${iso(NOW - 2 * 86400_000)}' ` +
    `WHERE order_id='${pointsOrders[1].id}' AND kind='purchase'`
  );
  const collect = await admin.post(`/api/orders/${pointsOrders[1].id}/settlement`, {
    amountIqd: pointsOrders[1].due, eventKey: `v3pts-collect-${rnd}`, reference: `V3PTS${rnd}`,
  });
  const afterCollect = (await pointsBuyer.get('/api/rewards')).data?.point_balance;
  check('a recorded collection past seven days releases exactly the 10 pending points',
    collect.status === 200 && collect.data?.points_released?.released === true &&
    collect.data?.points_released?.points === 10 && afterCollect === beforeDelivery + 10,
    `${JSON.stringify(collect.data?.points_released ?? {}).slice(0, 140)} balance=${afterCollect}`);
  const collectReplay = await admin.post(`/api/orders/${pointsOrders[1].id}/settlement`, {
    amountIqd: pointsOrders[1].due, eventKey: `v3pts-collect-${rnd}`, reference: `V3PTS${rnd}`,
  });
  check('a replayed collection records once and never releases twice',
    collectReplay.data?.settlement?.duplicate === true &&
    (await pointsBuyer.get('/api/rewards')).data?.point_balance === afterCollect,
    `duplicate=${collectReplay.data?.settlement?.duplicate}`);

  // ========================================================= returns (§6.2)
  console.log('\n— returns: 7-day window from actual delivery (§6.2)');
  await buyerA.post('/api/cart/items', { productId: prodReturn.id, qty: 2 });
  r = await buyerA.post('/api/orders', { addressId: addrA, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], policyAcceptance: ACC, idempotencyKey: `v3ret-${rnd}` });
  const retOrder = r.data?.order?.id;
  del = await deliverOrder(admin, retOrder);
  check('return-test order delivered', del.status === 200);
  r = await buyerA.get(`/api/orders/${retOrder}`);
  const retItemId = r.data?.order?.items?.[0]?.id;
  check('order detail exposes the item id', !!retItemId, JSON.stringify(r.data?.order?.items ?? []).slice(0, 120));
  r = await buyerA.post('/api/returns', { orderItemId: retItemId, qty: 1, reason: 'defective', description: 'Arrived with a cracked casing (synthetic test).' });
  check('within-7-days return accepted as requested/within-window', r.status === 200 && r.data?.case?.state === 'requested', JSON.stringify(r.data).slice(0, 160));
  const retCaseId = r.data?.case?.id;
  r = await buyerB.get(`/api/returns/${retCaseId}`);
  check('IDOR: user B cannot read A\'s return case (404)', r.status === 404, `status=${r.status}`);
  // Backdate the SAME order's delivery to 8 days ago via the test SQL channel,
  // then the remaining unit is outside the window.
  sqlExec(`UPDATE orders SET delivered_at='${iso(NOW - 8 * 86400_000)}' WHERE id='${retOrder}'`);
  r = await buyerA.post('/api/returns', { orderItemId: retItemId, qty: 1, reason: 'defective', description: 'Second unit request after the window (synthetic test).' });
  check('after-7-days return rejected (RETURN_WINDOW_CLOSED)', r.status === 400 && r.data?.code === 'RETURN_WINDOW_CLOSED', JSON.stringify(r.data).slice(0, 140));

  // ================================================= price protection (§6.8)
  console.log('\n— price protection: pending claim, no auto payout (§6.8)');
  await buyerA.post('/api/cart/items', { productId: prodDrop.id, qty: 1 });
  r = await buyerA.post('/api/orders', { addressId: addrA, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], policyAcceptance: ACC, idempotencyKey: `v3pp-${rnd}` });
  const ppOrder = r.data?.order?.id;
  del = await deliverOrder(admin, ppOrder);
  check('price-protection test order delivered', del.status === 200);
  r = await buyerA.get(`/api/orders/${ppOrder}`);
  const ppItemId = r.data?.order?.items?.[0]?.id;
  // The price drops AFTER delivery (admin edit through the canonical editor).
  r = await admin.post('/api/admin/products-v2', { ...prodDrop.doc, id: prodDrop.id, slug: prodDrop.slug, price_iqd: 8000 });
  check('admin lowers the product price 10,000 → 8,000', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  const ppPaths = ['/api/price-protection/claims', '/api/returns/price-protection/claims'];
  const walletBefore = await buyerA.get('/api/wallet');
  const ptsBefore = (await buyerA.get('/api/rewards')).data?.point_balance;
  const claim = await postAt(buyerA, ppPaths, { orderItemId: ppItemId });
  check('price-protection claim recorded as pending — NOT auto-paid', claim.status === 200 && claim.data?.claim?.state === 'requested' && claim.data?.claim?.credited_iqd === 0, `${claim.status} ${JSON.stringify(claim.data).slice(0, 160)} via ${claim.path}`);
  const walletAfter = await buyerA.get('/api/wallet');
  const ptsAfter = (await buyerA.get('/api/rewards')).data?.point_balance;
  check('no wallet/points movement before an admin decision', JSON.stringify(walletBefore.data) === JSON.stringify(walletAfter.data) && ptsBefore === ptsAfter, `points ${ptsBefore}→${ptsAfter}`);
  blocked('price-protection payout execution', 'compensation channel is an owner decision (docs/DECISIONS.md row 22) — only the pending-claim ledger is asserted');

  // ================================================== PRO shipping (§6.3)
  console.log('\n— PRO free-delivery rule: strict >75,000 at the approved address only (§6.3)');
  // Fund + subscribe PRO (same pattern as v2, launch-state tolerant).
  const rate = (await anon.get('/api/settings/public')).data?.settings?.exchangeRate ?? 1400;
  const cents = Math.ceil((499000 * 100) / rate);
  r = await admin.post('/api/admin/wallet/credit', { userId: proId, currency: 'USD', amount: cents + 1000, note: 'v3 test funding' });
  check('admin funds the PRO test wallet', r.status === 200);
  r = await proBuyer.post('/api/memberships/subscribe', { planId: 'pro_12mo', idempotencyKey: `v3sub-${rnd}` });
  check('PRO purchase succeeds', r.status === 200, JSON.stringify(r.data).slice(0, 160));
  const memId = r.data?.membership?.id ?? r.data?.id;
  const memState = r.data?.membership?.state ?? r.data?.state;
  if (memState !== 'active') {
    // Launch tolerance: activate ONLY this test membership via SQL.
    sqlExec(`UPDATE memberships SET state='active', starts_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+12 months') WHERE id='${memId}'`);
    console.log('      (activated the test membership via SQL — launchConfig untouched)');
  }
  r = await proBuyer.get('/api/memberships/mine');
  check('PRO membership active', JSON.stringify(r.data).includes('"active"'), JSON.stringify(r.data?.status ?? {}).slice(0, 140));

  r = await proBuyer.post('/api/addresses', { label: 'Default', name: 'Pro Buyer', phone: '+9647705556677', address: 'Baghdad, Approved District 1' });
  const proAddrDefault = r.data?.id;
  r = await proBuyer.post('/api/addresses', { label: 'Alt', name: 'Pro Buyer', phone: '+9647705556677', address: 'Erbil, Alternate Street 9' });
  const proAddrAlt = r.data?.id;
  check('PRO addresses created', !!proAddrDefault && !!proAddrAlt);

  const proQuote = (addressId) => proBuyer.post('/api/orders/quote', { addressId, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [] });

  await clearCart(proBuyer);
  await proBuyer.post('/api/cart/items', { productId: prod75001.id, qty: 1 });
  r = await proQuote(proAddrDefault);
  check('quote breakdown carries reasons + needs_config + tier context', r.status === 200 && Array.isArray(r.data?.quote?.shipping?.reasons) && Array.isArray(r.data?.quote?.shipping?.needs_config) && typeof r.data?.quote?.tier?.at_approved_default_address === 'boolean', JSON.stringify(r.data?.quote?.shipping ?? {}).slice(0, 200));
  check('PRO with NO approved default address pays ordinary even at 75,001', r.data?.quote?.shipping?.total_iqd === 5000 && r.data?.quote?.shipping?.pro_waiver_applied === false, `shipping=${r.data?.quote?.shipping?.total_iqd}`);

  // Approve the default address through the test SQL channel (the approval
  // API itself is an audited staff flow — the SQL insert mirrors its result).
  sqlExec(`INSERT INTO approved_addresses (id, user_id, version, name, phone_e164, address, landmark, state, approved_by, approved_at, source_address_id) VALUES ('apa_v3_${rnd}', '${proId}', 1, 'Pro Buyer', '+9647705556677', 'Baghdad, Approved District 1', '', 'approved', 'v3-test-sql', strftime('%Y-%m-%dT%H:%M:%fZ','now'), '${proAddrDefault}')`);

  r = await proQuote(proAddrDefault);
  check('75,001 at the approved address → free delivery (strictly greater)', r.data?.quote?.shipping?.total_iqd === 0 && r.data?.quote?.shipping?.pro_waiver_applied === true, `shipping=${r.data?.quote?.shipping?.total_iqd}`);
  await clearCart(proBuyer);
  await proBuyer.post('/api/cart/items', { productId: prod75000.id, qty: 1 });
  r = await proQuote(proAddrDefault);
  check('exactly 75,000 does NOT qualify — 5,000 IQD charged', r.data?.quote?.shipping?.total_iqd === 5000 && r.data?.quote?.shipping?.pro_waiver_applied === false, `shipping=${r.data?.quote?.shipping?.total_iqd}`);
  await clearCart(proBuyer);
  await proBuyer.post('/api/cart/items', { productId: prod75001.id, qty: 1 });
  r = await proQuote(proAddrAlt);
  check('alternate address → ordinary pricing even above the threshold', r.data?.quote?.shipping?.total_iqd === 5000 && r.data?.quote?.tier?.at_approved_default_address === false, `shipping=${r.data?.quote?.shipping?.total_iqd}`);
  r = await proQuote(proAddrDefault);
  check('returning to the approved address restores the waiver automatically', r.data?.quote?.shipping?.total_iqd === 0, `shipping=${r.data?.quote?.shipping?.total_iqd}`);

  // Ordinary/PLUS shoppers never get the PRO waiver.
  await clearCart(buyerB);
  await buyerB.post('/api/cart/items', { productId: prod75001.id, qty: 1 });
  r = await buyerB.post('/api/orders/quote', { addressId: addrB, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [] });
  check('ordinary shopper at 75,001 still pays 5,000 (waiver is PRO-only)', r.data?.quote?.shipping?.total_iqd === 5000 && r.data?.quote?.shipping?.pro_waiver_applied === false, `shipping=${r.data?.quote?.shipping?.total_iqd}`);
  await clearCart(buyerB);

  // Printer delivery fees: honest needs_config until the owner maps 25k/50k.
  await buyerB.post('/api/cart/items', { productId: prodPrinterClass.id, qty: 1 });
  r = await buyerB.post('/api/orders/quote', { addressId: addrB, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [] });
  check('printer-class fee unconfigured → honest needs_config blocker in the quote', r.status === 200 && (r.data?.quote?.shipping?.needs_config ?? []).includes('printer_small_fee_unconfigured') && r.data?.quote?.can_checkout === false, JSON.stringify(r.data?.quote?.shipping ?? {}).slice(0, 160));
  r = await buyerB.post('/api/orders', { addressId: addrB, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], policyAcceptance: ACC, idempotencyKey: `v3blk-${rnd}` });
  check('checkout with an unpriced printer fee refused (SHIPPING_NEEDS_CONFIG)', r.status === 400 && r.data?.code === 'SHIPPING_NEEDS_CONFIG', JSON.stringify(r.data).slice(0, 140));
  await clearCart(buyerB);
  blocked('printer 25,000/50,000 IQD fee amounts + advance-payment accounting', 'size→fee mapping is an owner decision (docs/DECISIONS.md rows 3/16) — the honest needs_config branch is what ships');
  blocked('extra-carton fee for >10 spools', 'amount/threshold are owner configuration (docs/DECISIONS.md rows 3/16) — unconfigured means no invented fee');
  blocked('BNPL exposure/repayment flows', 'PRO-only BNPL rules pending owner decisions (docs/DECISIONS.md rows 10/21) — structure ships disabled');

  // ==================================================== checkout consent (§7)
  console.log('\n— checkout consent: versioned policy acceptance (§7)');
  r = await admin.post('/api/policies/admin/seed-drafts', {});
  check('policy drafts seeded (or already present)', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  r = await admin.post('/api/policies/admin/publish', { key: 'terms', version: 1, confirm: 'PUBLISH terms v1' });
  const publishedNow = r.status === 200;
  const alreadyPublished = r.status === 400 && r.data?.code === 'ALREADY_PUBLISHED';
  check('terms v1 published (idempotent across runs)', publishedNow || alreadyPublished, JSON.stringify(r.data).slice(0, 140));
  r = await anon.get('/api/policies');
  const requiredPolicies = (r.data?.policies ?? []).filter((p) => p.required_for_checkout);
  check('published policy list marks checkout-required keys', requiredPolicies.length >= 1, JSON.stringify(r.data?.policies ?? []).slice(0, 160));
  await refreshAcceptance(); // later checkouts in this run must accept the just-published versions

  await buyerB.post('/api/cart/items', { productId: prodOrdinary.id, qty: 1 });
  r = await buyerB.post('/api/orders', { addressId: addrB, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], idempotencyKey: `v3con1-${rnd}` });
  check('checkout without acceptance fails POLICY_ACCEPTANCE_REQUIRED', r.status === 400 && r.data?.code === 'POLICY_ACCEPTANCE_REQUIRED', JSON.stringify(r.data).slice(0, 140));
  r = await buyerB.post('/api/orders', {
    addressId: addrB, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [],
    idempotencyKey: `v3con2-${rnd}`,
    policyAcceptance: requiredPolicies.map((p) => ({ key: p.key, version: p.version })),
  });
  check('checkout with the current versions accepted succeeds', r.status === 200, JSON.stringify(r.data).slice(0, 160));
  const consentOrder = r.data?.order?.id;
  check('consent order recorded', !!consentOrder);

  // ================================================================ KYC (§9)
  console.log('\n— KYC: honest 503 unconfigured / gated submission (§9)');
  r = await buyerA.get('/api/kyc/mine');
  const kycConfigured = r.data?.configured === true;
  check('kyc/mine reports its configuration honestly', r.status === 200 && typeof r.data?.configured === 'boolean', JSON.stringify(r.data).slice(0, 120));
  r = await buyerA.post('/api/kyc/submit', { fullName: 'Test Synthetic Person', dob: '1990-01-01', docType: 'national_id', docNumber: 'SYN-000', evidenceKeys: [] });
  if (!kycConfigured) {
    check('kyc/submit honest 503 while KYC_ENC_KEY unset', r.status === 503, `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    blocked('KYC submission/review with encrypted fields', 'KYC_ENC_KEY not configured in this environment (docs/DECISIONS.md rows 24/26)');
  } else {
    check('kyc/submit gated behind Telegram phone verification', r.status === 400 && (r.data?.code === 'PHONE_NOT_VERIFIED' || r.data?.code === 'NAME_THREE_PARTS' || /evidenceKeys/.test(r.data?.error ?? '')), JSON.stringify(r.data).slice(0, 140));
    blocked('full KYC submit→review→verify cycle', 'requires a real Telegram-verified phone — manual staging step with synthetic documents');
  }

  // ============================================================ support (§8)
  console.log('\n— deterministic support assistant + tickets (§8, §10)');
  r = await buyerB.post('/api/support/assistant', {});
  check('assistant with no intent asks a clarifying question', r.status === 200 && r.data?.reply?.intent === 'clarify' && Array.isArray(r.data?.reply?.choices), JSON.stringify(r.data).slice(0, 160));
  r = await buyerB.post('/api/support/assistant', { intent: 'order_status', params: { order_id: orderInv } });
  check('assistant: foreign order id → not-found-in-your-account, zero leak', r.status === 200 && !JSON.stringify(r.data?.reply ?? {}).includes(orderInv), JSON.stringify(r.data?.reply ?? {}).slice(0, 160));
  r = await buyerA.post('/api/support/assistant', { intent: 'order_status', params: { order_id: orderInv } });
  check('assistant: own order id answers with real status', r.status === 200 && JSON.stringify(r.data?.reply ?? {}).includes(orderInv), JSON.stringify(r.data?.reply ?? {}).slice(0, 160));

  r = await buyerB.post('/api/support/tickets', { subject: 'Help with my order', body: 'Testing ticket creation without confirmation.' });
  check('ticket without explicit confirmation refused (CONFIRM_REQUIRED)', r.status === 400 && r.data?.code === 'CONFIRM_REQUIRED', JSON.stringify(r.data).slice(0, 120));
  r = await buyerB.post('/api/support/tickets', { subject: 'Foreign order ref', body: 'Trying to attach another user\'s order.', confirm: true, order_id: orderInv });
  check('ticket with a foreign order id refused (ORDER_NOT_FOUND)', r.status === 400 && r.data?.code === 'ORDER_NOT_FOUND', JSON.stringify(r.data).slice(0, 120));
  r = await buyerB.post('/api/support/tickets', { subject: 'Ordinary ticket', body: 'A ordinary-tier support ticket for queue-order testing.', confirm: true });
  check('ordinary ticket created with priority 0', r.status === 200 && r.data?.ticket?.priority === 0, JSON.stringify(r.data).slice(0, 140));
  const ticketB = r.data?.ticket?.id;
  r = await proBuyer.post('/api/support/tickets', { subject: 'PRO ticket', body: 'An eligible active PRO ticket that must rank first in the admin queue.', confirm: true });
  check('PRO ticket created with priority 1', r.status === 200 && r.data?.ticket?.priority === 1, JSON.stringify(r.data).slice(0, 140));
  const ticketPro = r.data?.ticket?.id;
  r = await admin.get('/api/support/admin/tickets');
  const queue = (r.data?.tickets ?? []).map((t) => t.id);
  check('admin queue ranks the PRO ticket above the earlier ordinary one', queue.includes(ticketPro) && queue.includes(ticketB) && queue.indexOf(ticketPro) < queue.indexOf(ticketB), JSON.stringify(queue.slice(0, 6)));
  r = await buyerA.get(`/api/support/tickets/${ticketB}`);
  check('IDOR: user A cannot read B\'s ticket (404)', r.status === 404, `status=${r.status}`);

  // ------------------------------------------------------------------ summary
  console.log(`\n${passed} passed, ${failed} failed, ${blockedCount} blocked`);
  if (blockedList.length) {
    console.log('Blocked (honest unconfigured preconditions — NOT passes):');
    for (const b of blockedList) console.log(' ~', b);
  }
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(' -', f);
    process.exit(1);
  }
}

main().catch((e) => { console.error('v3 test run crashed:', e); process.exit(1); });
