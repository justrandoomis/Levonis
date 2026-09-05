#!/usr/bin/env node
/**
 * Local API verification against `wrangler dev` (http://127.0.0.1:8787)
 * with the local emulated D1/R2. Run:
 *
 *   npm run db:migrate:local
 *   npm run dev            # in another terminal
 *   node scripts/api-tests.mjs
 *
 * Exercises: auth + sessions, authorization boundaries, removal of the SQL
 * endpoints, product visibility, checkout totals/idempotency/stock, wallet
 * review flow, rewards dedupe, upload validation.
 */
import { execSync } from 'node:child_process';

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';

// Once versioned checkout policies are published (final phase §7), every
// order requires policyAcceptance. Fetched once; empty before publishing.
let POLICY_ACC = [];
async function loadPolicyAcceptance() {
  try {
    const res = await fetch(`${BASE}/api/policies`);
    const j = await res.json();
    POLICY_ACC = (j?.policies ?? [])
      .filter((p) => p.required_for_checkout)
      .map((p) => ({ key: p.key, version: p.version }));
  } catch { POLICY_ACC = []; }
}
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

class Client {
  constructor() {
    this.cookie = '';
  }
  async req(method, path, body, contentType = 'application/json') {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = contentType;
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload });
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
  put(p, b) { return this.req('PUT', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
}

/**
 * Promotes an account to admin outside the API (simulating the controlled
 * bootstrap). Default targets the local emulated DB; set PROMOTE_CMD to a
 * command containing {SQL} to target a remote/staging database, e.g.:
 *   PROMOTE_CMD='npx wrangler d1 execute levonis-db-staging --remote --command {SQL}'
 */
function promoteAdmin(email) {
  const sql = `UPDATE users SET role='admin' WHERE email='${email}'`;
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  const cmd = tpl.replace('{SQL}', JSON.stringify(sql));
  execSync(cmd, { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
}

// 1x1 transparent PNG
const PNG_BYTES = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
), (c) => c.charCodeAt(0));

async function main() {
  await loadPolicyAcceptance();
  const rnd = Math.random().toString(36).slice(2, 8);
  const adminEmail = `admin-${rnd}@test.local`;
  const userEmail = `user-${rnd}@test.local`;
  const anon = new Client();
  const admin = new Client();
  const user = new Client();

  console.log('\n— health & removed endpoints');
  check('GET /api/health', (await anon.get('/api/health')).status === 200);
  check('POST /api/d1/query returns 410', (await anon.post('/api/d1/query', { sql: 'SELECT 1' })).status === 410);
  check('POST /api/d1/init returns 410', (await anon.post('/api/d1/init', {})).status === 410);
  check('GET /api/make-all-investors returns 410', (await anon.req('GET', '/api/make-all-investors')).status === 410);

  console.log('\n— registration & sessions');
  let r = await admin.post('/api/auth/register', { email: adminEmail, username: `adm${rnd}`, name: 'Admin', password: 'correct-horse-9' });
  check('register admin account', r.status === 200 && r.data?.user?.email === adminEmail, JSON.stringify(r.data));
  r = await user.post('/api/auth/register', { email: userEmail, username: `usr${rnd}`, name: 'User', password: 'battery-staple-7' });
  check('register user account', r.status === 200);
  check('weak password rejected', (await anon.post('/api/auth/register', { email: `x${rnd}@t.local`, password: 'short' })).status === 400);
  check('duplicate email rejected', (await anon.post('/api/auth/register', { email: userEmail, password: 'battery-staple-7' })).status === 409);
  check('session cookie works (/api/auth/me)', (await user.get('/api/auth/me')).data?.user?.email === userEmail);
  check('registered user is NOT admin', (await user.get('/api/auth/me')).data?.user?.isAdmin === false);
  check('wrong password rejected', (await anon.post('/api/auth/login', { email: userEmail, password: 'wrong-password-1' })).status === 401);
  check('forgot-password honest 503 without email service', (await anon.post('/api/auth/forgot-password', { email: userEmail })).status === 503);

  console.log('\n— authorization boundaries');
  check('anon cart rejected (401)', (await anon.get('/api/cart')).status === 401);
  check('anon wallet rejected (401)', (await anon.get('/api/wallet')).status === 401);
  check('non-admin /api/admin/overview rejected (403)', (await user.get('/api/admin/overview')).status === 403);
  check('non-admin product create rejected (403)', (await user.post('/api/admin/products', { name: 'X', price_iqd: 1 })).status === 403);
  check('non-admin user role change rejected (403)', (await user.patch('/api/admin/users/anything', { role: 'admin' })).status === 403);
  check('non-investor /api/invest rejected (403)', (await user.get('/api/invest')).status === 403);

  // Google sign-in must never trust an unverified credential. A structurally
  // valid but unsigned JWT exercises the verification path: expect 401 when
  // GOOGLE_CLIENT_ID is set, or an honest 503 when it is not.
  const fakeJwt =
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'nope' })).toString('base64url') +
    '.' + Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'x', sub: '1', email: 'a@b.co', email_verified: true, exp: 9999999999 })).toString('base64url') +
    '.' + Buffer.from('sig').toString('base64url');
  r = await anon.post('/api/auth/google', { credential: fakeJwt });
  check('google: forged credential rejected', r.status === 401 || r.status === 503, `status ${r.status}`);
  console.log(`      (google endpoint mode: ${r.status === 503 ? 'NOT CONFIGURED — honest 503' : 'configured — signature verification active'})`);

  // Promote the admin account server-side (simulates the controlled bootstrap).
  promoteAdmin(adminEmail);
  check('admin overview after promotion', (await admin.get('/api/admin/overview')).status === 200);

  // Telegram integration — honest live report (send only happens when both
  // the bot token and the admin chat id are configured on the worker).
  r = await admin.post('/api/admin/telegram/test');
  check('telegram test endpoint responds', r.status === 200);
  console.log(`      (telegram: tokenValid=${r.data?.tokenValid} chatConfigured=${r.data?.chatConfigured} sent=${r.data?.sent})`);

  console.log('\n— products & visibility');
  r = await admin.post('/api/admin/products', {
    name: `Test Printer ${rnd}`, price_iqd: 10000, original_price_iqd: 12000, stock: 3, status: 'active',
    images: ['https://example.com/x.jpg'], membership_prices: { pro: 9000 },
  });
  const productId = r.data?.product?.id;
  const slug = r.data?.product?.slug;
  check('admin creates product', r.status === 200 && !!productId, JSON.stringify(r.data));
  check('product appears publicly', (await anon.get('/api/products')).data?.products?.some((p) => p.id === productId));
  r = await anon.get(`/api/products/${slug}`);
  check('public detail excludes cost price', r.status === 200 && !('product_cost_iqd' in (r.data?.product ?? {})));
  await admin.post('/api/admin/products', { id: productId, name: `Test Printer ${rnd}`, slug, price_iqd: 10000, original_price_iqd: 12000, stock: 3, status: 'hidden' });
  check('hidden product leaves the public list', !(await anon.get('/api/products')).data?.products?.some((p) => p.id === productId));
  check('hidden product detail 404', (await anon.get(`/api/products/${slug}`)).status === 404);
  await admin.post('/api/admin/products', { id: productId, name: `Test Printer ${rnd}`, slug, price_iqd: 10000, original_price_iqd: 12000, stock: 3, status: 'active' });

  console.log('\n— cart & checkout');
  r = await user.post('/api/cart/items', { productId, qty: 2 });
  check('add to cart', r.status === 200 && r.data?.items?.length === 1, JSON.stringify(r.data));
  check('cart rejects qty over stock', (await user.post('/api/cart/items', { productId, qty: 50 })).status === 400);
  r = await user.post('/api/addresses', { label: 'Home', name: 'Test User', phone: '+9647701234567', address: 'Baghdad, Test St 1' });
  const addressId = r.data?.id;
  check('create address', r.status === 200 && !!addressId);

  const idem = `test-${rnd}-1`;
  r = await user.post('/api/orders', { policyAcceptance: POLICY_ACC, addressId, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], idempotencyKey: idem });
  const orderId = r.data?.order?.id;
  check('order created', r.status === 200 && !!orderId, JSON.stringify(r.data));
  check('server-computed total (2×10000 + 5000 shipping)', r.data?.order?.total_iqd === 25000, `got ${r.data?.order?.total_iqd}`);
  r = await user.post('/api/orders', { policyAcceptance: POLICY_ACC, addressId, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], idempotencyKey: idem });
  check('idempotent replay returns same order', r.data?.order?.id === orderId && r.data?.replay === true);
  r = await anon.get(`/api/products/${slug}`);
  check('stock decremented to 1', r.data?.product?.stock === 1, `got ${r.data?.product?.stock}`);
  check('cart emptied after order', (await user.get('/api/cart')).data?.items?.length === 0);

  await user.post('/api/cart/items', { productId, qty: 1 });
  r = await user.post('/api/orders', { policyAcceptance: POLICY_ACC, addressId, deliveryMethodId: 'nope', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], idempotencyKey: `test-${rnd}-2` });
  check('invalid delivery method rejected', r.status === 400);
  r = await user.post('/api/orders', { policyAcceptance: POLICY_ACC, addressId, deliveryMethodId: 'standard', paymentMethodId: 'wallet', useWallet: true, usePoints: false, itemIds: [], idempotencyKey: `test-${rnd}-3` });
  check('advance payment without balance rejected', r.status === 400 && r.data?.code === 'INSUFFICIENT_BALANCE', JSON.stringify(r.data));

  console.log('\n— cross-user access (IDOR)');
  const stranger = new Client();
  await stranger.post('/api/auth/register', { email: `s-${rnd}@test.local`, username: `str${rnd}`, name: 'S', password: 'stranger-pass-1' });
  check("stranger cannot read another user's order", (await stranger.get(`/api/orders/${orderId}`)).status === 404);
  check("stranger cannot cancel another user's order", (await stranger.post(`/api/orders/${orderId}/cancel`)).status === 404);
  check("stranger cannot edit another user's address", (await stranger.put(`/api/addresses/${addressId}`, { label: 'X', name: 'X Y', phone: '+9647700000000', address: 'Somewhere far 2' })).status === 404);

  console.log('\n— uploads & wallet review');
  const form = new FormData();
  form.append('purpose', 'receipt');
  form.append('file', new File([PNG_BYTES], 'r.png', { type: 'image/png' }));
  r = await user.req('POST', '/api/uploads', form);
  const receiptKey = r.data?.key;
  check('receipt upload (valid PNG)', r.status === 200 && receiptKey?.startsWith('receipts/'), JSON.stringify(r.data));
  const badForm = new FormData();
  badForm.append('purpose', 'receipt');
  badForm.append('file', new File([new TextEncoder().encode('not an image')], 'x.png', { type: 'image/png' }));
  check('non-image content rejected by sniffing', (await user.req('POST', '/api/uploads', badForm)).status === 400);
  const prodForm = new FormData();
  prodForm.append('purpose', 'product');
  prodForm.append('file', new File([PNG_BYTES], 'p.png', { type: 'image/png' }));
  check('non-admin product upload rejected', (await user.req('POST', '/api/uploads', prodForm)).status === 403);

  r = await user.post('/api/wallet/deposits', { amount_usd_cents: 5000, receiptKey, paymentMethod: 'ZainCash' });
  const depId = r.data?.id;
  check('deposit request pending', r.status === 200 && r.data?.status === 'pending');
  check('deposit without receipt rejected', (await user.post('/api/wallet/deposits', { amount_usd_cents: 5000, receiptKey: 'receipts/other/none.png' })).status === 400);
  check('balance still 0 before review', (await user.get('/api/wallet')).data?.balance_usd_cents === 0);
  check("stranger cannot fetch the receipt", (await stranger.req('GET', `/files/${receiptKey}`)).status === 403);
  check('owner can fetch the receipt', (await user.req('GET', `/files/${receiptKey}`)).status === 200);
  check('stranger cannot approve requests', (await stranger.post(`/api/admin/wallet-requests/${depId}/decide`, { status: 'approved' })).status === 403);
  r = await admin.post(`/api/admin/wallet-requests/${depId}/decide`, { status: 'approved' });
  check('admin approves deposit', r.status === 200, JSON.stringify(r.data));
  check('balance updated to 5000 cents', (await user.get('/api/wallet')).data?.balance_usd_cents === 5000);
  check('double-decide rejected', (await admin.post(`/api/admin/wallet-requests/${depId}/decide`, { status: 'approved' })).status === 404);
  check('withdrawal over balance rejected', (await user.post('/api/wallet/withdrawals', { amount_usd_cents: 999999 })).status === 400);

  console.log('\n— order cancel refund');
  r = await user.post('/api/orders', { policyAcceptance: POLICY_ACC, addressId, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: true, usePoints: false, itemIds: [], idempotencyKey: `test-${rnd}-4` });
  const order2 = r.data?.order;
  check('order with wallet applied', r.status === 200 && order2?.wallet_applied_iqd > 0, JSON.stringify(r.data?.order));
  const balAfterOrder = (await user.get('/api/wallet')).data?.balance_usd_cents;
  r = await user.post(`/api/orders/${order2.id}/cancel`);
  check('cancel pending order', r.status === 200 && r.data?.order?.status === 'cancelled');
  const balAfterCancel = (await user.get('/api/wallet')).data?.balance_usd_cents;
  check('wallet refunded on cancel', balAfterCancel > balAfterOrder, `before ${balAfterOrder} after ${balAfterCancel}`);
  check('second cancel rejected', (await user.post(`/api/orders/${order2.id}/cancel`)).status === 400);

  console.log('\n— rewards dedupe');
  r = await user.post('/api/rewards/checkin');
  check('daily check-in', r.status === 200 && r.data?.points > 0);
  check('second check-in same day rejected', (await user.post('/api/rewards/checkin')).status === 409);
  const pts = (await user.get('/api/rewards')).data?.point_balance;
  check('points credited once', pts > 0, `got ${pts}`);

  console.log('\n— logout & session revocation');
  await user.post('/api/auth/logout');
  check('session revoked after logout', (await user.get('/api/auth/me')).data?.user === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(' -', f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Test run crashed:', e);
  process.exit(1);
});
