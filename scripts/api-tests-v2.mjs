#!/usr/bin/env node
/**
 * v2 API verification — product platform + memberships mandate.
 * Runs after scripts/api-tests.mjs against the same base (local wrangler dev
 * or staging). Uses the same cookie-jar client + PROMOTE_CMD contract.
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
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`FAIL  ${name} ${extra}`); }
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const headers = {};
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
  post(p, b) { return this.req('POST', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
}

function promoteAdmin(email) {
  const sql = `UPDATE users SET role='admin' WHERE email='${email}'`;
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(sql)), { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
}

async function main() {
  await loadPolicyAcceptance();
  const rnd = Math.random().toString(36).slice(2, 8);
  const admin = new Client();
  const buyer = new Client();
  const anon = new Client();

  console.log('\n— setup');
  let r = await admin.post('/api/auth/register', { email: `v2adm-${rnd}@test.local`, username: `v2adm${rnd}`, name: 'V2 Admin', password: 'v2-admin-pass-1' });
  check('admin account', r.status === 200);
  promoteAdmin(`v2adm-${rnd}@test.local`);
  r = await buyer.post('/api/auth/register', { email: `v2buy-${rnd}@test.local`, username: `v2buy${rnd}`, name: 'V2 Buyer', password: 'v2-buyer-pass-1' });
  check('buyer account', r.status === 200);

  console.log('\n— taxonomy + canonical product');
  r = await admin.post('/api/admin/products-v2/brands', { name_ar: 'بامبو لاب', name_en: 'Bambu Lab' });
  const brandId = r.data?.brand?.id ?? r.data?.id;
  check('brand created', r.status === 200 && !!brandId, JSON.stringify(r.data).slice(0, 120));
  r = await admin.post('/api/admin/products-v2/catalogs', { name_ar: 'طابعات', name_en: 'Printers', is_printer_catalog: true });
  const catalogId = r.data?.catalog?.id ?? r.data?.id;
  check('printer catalog created', r.status === 200 && !!catalogId);

  const doc = {
    name_ar: `طابعة اختبار ${rnd}`, name_en: `V2 Printer ${rnd}`,
    description_ar: 'وصف عربي', price_iqd: 100000, pro_price_iqd: 90000,
    original_price_iqd: 120000, product_cost_iqd: 60000,
    selling_type: 'pre_order',
    preorder_transports: [{ method: 'sea', commission_iqd: 15000, active: true }],
    warranty_plans: [{ id: 'w24', title_ar: 'سنتان', duration_months: 24, duration_kind: 'total', fee_iqd: 20000, order: 0, active: true }],
    options: [{ id: 'optA', name_ar: 'خيار أ', name_en: 'Option A', regular_price_iqd: null, pro_price_iqd: null, compare_at_iqd: null, cost_iqd: null, order: 0, active: true, image: '' }],
    colors: [{ id: 'colB', name_ar: 'أسود', name_en: 'Black', hex: '#000000', option_id: 'optA', regular_price_iqd: 110000, pro_price_iqd: null, compare_at_iqd: null, cost_iqd: null, order: 0, active: true, image: '' }],
    stock: 10, status: 'active', brand_id: brandId, catalog_ids: [catalogId],
    spec_groups: [{ id: 'g1', title_ar: 'عام', title_en: 'General', order: 0, rows: [{ id: 'r1', label_ar: 'الحجم', label_en: 'Size', value_ar: '٢٥٦', value_en: '256', unit: 'mm', order: 0 }] }],
    media: [], labels: [], content_blocks: [], payment_options: [], hashtags: [], how_to_use: '',
  };
  r = await admin.post('/api/admin/products-v2', doc);
  const productId = r.data?.product?.id;
  const slug = r.data?.product?.slug;
  check('canonical product saved', r.status === 200 && !!productId, JSON.stringify(r.data).slice(0, 200));

  r = await admin.get(`/api/admin/products-v2/${productId}`);
  check('full-doc reload preserves groups', r.status === 200 && r.data?.product?.spec_groups?.[0]?.rows?.length === 1 && r.data?.product?.colors?.[0]?.option_id === 'optA');
  check('reload preserves null-vs-explicit prices', r.data?.product?.options?.[0]?.regular_price_iqd === null && r.data?.product?.colors?.[0]?.regular_price_iqd === 110000);

  console.log('\n— public projections + quotes');
  r = await anon.get(`/api/products/${slug}`);
  check('public detail has no cost anywhere', r.status === 200 && !r.text.includes('cost_iqd') && !r.text.includes('product_cost'));
  check('public detail carries brand + transports', !!(r.data?.brand?.id) && r.data?.product?.preorder_transports?.length === 1, JSON.stringify({brand: r.data?.brand, t: r.data?.product?.preorder_transports}).slice(0, 150));

  r = await anon.post(`/api/products/${slug}/quote`, { optionId: 'optA', colorId: 'colB', transportMethod: 'sea', warrantyPlanId: 'w24' });
  check('public quote: color replaces price + fees added', r.status === 200 && r.data?.quote?.unit_subtotal_iqd === 110000 + 15000 + 20000, JSON.stringify(r.data).slice(0, 200));
  r = await anon.post(`/api/products/${slug}/quote`, { optionId: 'optA', colorId: 'colB' });
  check('public quote: preorder without transport rejected', (r.data?.quote?.errors ?? r.data?.errors ?? []).includes('TRANSPORT_REQUIRED') || r.status === 400);

  r = await admin.post(`/api/admin/products-v2/${productId}/quote`, { tier: 'pro' });
  check('admin quote shows PRO price + cost', r.status === 200 && r.data?.quote?.applied_iqd === 90000 && r.data?.quote?.cost_iqd === 60000, JSON.stringify(r.data?.quote ?? {}).slice(0, 160));

  console.log('\n— stale edit + slug stability');
  r = await admin.post('/api/admin/products-v2', { ...doc, id: productId, slug, name_en: `V2 Printer ${rnd} EDITED`, expected_updated_at: '2000-01-01T00:00:00Z' });
  check('stale expected_updated_at → 409', r.status === 409);
  r = await admin.post('/api/admin/products-v2', { ...doc, id: productId, slug: 'hijack-slug', name_en: `V2 Printer ${rnd}` });
  const after = await admin.get(`/api/admin/products-v2/${productId}`);
  check('slug stays stable without allow_slug_change', after.data?.product?.slug === slug, `got ${after.data?.product?.slug}`);

  console.log('\n— membership plans + purchase');
  r = await anon.get('/api/memberships/plans');
  const plans = r.data?.plans ?? [];
  const plus1 = plans.find((p) => p.id === 'plus_1mo');
  const pro12 = plans.find((p) => p.id === 'pro_12mo');
  // The owner PRICED the PLUS tier after this suite was written (task #19),
  // so "PLUS unpriced" stopped being the truth. The durable invariant is:
  // plans come from the DB and purchasable mirrors priced-ness exactly.
  check('plans from DB: PRO 499000, purchasable === priced for every plan',
    !!plus1 && pro12?.price_iqd === 499000 && plans.every((p) => p.purchasable === (p.price_iqd !== null && p.price_iqd !== undefined)),
    JSON.stringify(plans).slice(0, 200));
  r = await buyer.post('/api/memberships/subscribe', { planId: 'plus_1mo', idempotencyKey: `k-${rnd}-1` });
  check('priced-plan purchase without balance rejected',
    r.status === 400 && (r.data?.code === 'PLAN_UNPRICED' || r.data?.code === 'INSUFFICIENT_BALANCE' || /رصيد|balance|غير متاحة|unpriced/i.test(r.data?.error ?? '')),
    JSON.stringify(r.data).slice(0, 140));
  r = await buyer.post('/api/memberships/subscribe', { planId: 'pro_12mo', idempotencyKey: `k-${rnd}-2` });
  check('PRO purchase without balance rejected', r.status === 400, JSON.stringify(r.data).slice(0, 120));

  // Fund the buyer via admin manual credit, then buy PRO.
  const me = await buyer.get('/api/auth/me');
  const buyerId = me.data?.user?.id;
  const rate = (await anon.get('/api/settings/public')).data?.settings?.exchangeRate ?? 1400;
  const cents = Math.ceil((499000 * 100) / rate);
  r = await admin.post('/api/admin/wallet/credit', { userId: buyerId, currency: 'USD', amount: cents + 1000, note: 'v2 test funding' });
  check('admin manual credit', r.status === 200);
  const launchActivated = (await anon.get('/api/memberships/plans')).data?.launch?.activated === true;
  r = await buyer.post('/api/memberships/subscribe', { planId: 'pro_12mo', idempotencyKey: `k-${rnd}-3` });
  const memState = r.data?.membership?.state ?? r.data?.state;
  const memId = r.data?.membership?.id ?? r.data?.id;
  check('PRO purchase succeeds', r.status === 200, JSON.stringify(r.data).slice(0, 200));
  check('purchase state matches launch config', launchActivated ? memState === 'active' : memState === 'prepaid_pending_launch', `state=${memState} launchActivated=${launchActivated}`);
  const replay = await buyer.post('/api/memberships/subscribe', { planId: 'pro_12mo', idempotencyKey: `k-${rnd}-3` });
  check('idempotent replay returns same membership', replay.status === 200 && (replay.data?.membership?.id ?? replay.data?.id) === (r.data?.membership?.id ?? r.data?.id));
  r = await buyer.get('/api/memberships/mine');
  check('mine shows referral code + correct state', !!r.data?.referral?.code && (launchActivated ? !!r.data?.status?.active : !!r.data?.status?.pending_launch), JSON.stringify({p: r.data?.status, c: r.data?.referral?.code}).slice(0, 180));

  if (process.env.ALLOW_LAUNCH_ACTIVATION === '1') {
    console.log('\n— launch activation (admin, idempotent — LOCAL ONLY)');
    r = await admin.post('/api/memberships/admin/activate-launch', { confirm: 'ACTIVATE' });
    check('launch activation', r.status === 200, JSON.stringify(r.data).slice(0, 120));
    const again = await admin.post('/api/memberships/admin/activate-launch', { confirm: 'ACTIVATE' });
    check('second activation is a no-op', again.status === 200);
  } else if (!launchActivated) {
    // Staging keeps its prepaid launch state for the owner's own testing —
    // activate ONLY this test membership through the SQL channel.
    const sql = `UPDATE memberships SET state='active', starts_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+12 months') WHERE id='${memId}'`;
    const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
    execSync(tpl.replace('{SQL}', JSON.stringify(sql)), { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
    console.log('      (activated the test membership via SQL — launchConfig untouched)');
  }
  r = await buyer.get('/api/memberships/mine');
  check('membership active with expiry', JSON.stringify(r.data).includes('"active"'), JSON.stringify(r.data?.status ?? {}).slice(0, 160));

  console.log('\n— PRO entitlements at checkout');
  r = await buyer.get(`/api/products/${slug}`);
  check('PRO viewer sees PRO display price', r.data?.product?.display_price_iqd === 90000 || r.data?.display_price_iqd === 90000, JSON.stringify(r.data).slice(0, 160));
  // Cart with transport (PRO → commission waived) + warranty (never waived).
  r = await buyer.post('/api/cart/items', { productId, qty: 1, optionId: 'optA', colorId: 'colB', transportMethod: 'sea', warrantyPlanId: 'w24' });
  check('cart accepts variant+transport+warranty', r.status === 200, JSON.stringify(r.data).slice(0, 200));
  const line = r.data?.items?.[0];
  check('PRO line: commission waived, warranty kept', line && line.unit_price_iqd === 90000 + 0 + 20000, `unit=${line?.unit_price_iqd}`);
  r = await buyer.post('/api/addresses', { label: 'Home', name: 'V2 Buyer', phone: '+9647701112233', address: 'Baghdad, Test District 9' });
  const addressId = r.data?.id;
  r = await buyer.post('/api/orders', { policyAcceptance: POLICY_ACC, addressId, deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], idempotencyKey: `v2o-${rnd}` });
  check('PRO order created', r.status === 200, JSON.stringify(r.data).slice(0, 250));
  const order = r.data?.order;
  // CONFIRMED owner rule (final-phase §6.3, docs/DECISIONS.md row 15): the PRO
  // free-delivery waiver requires the approved default PRO address AND order
  // value strictly above 75,000 IQD. This buyer has NO approved default
  // address, so ordinary delivery (5,000 IQD) applies — the old unconditional
  // "PRO free delivery" expectation was wrong.
  check('PRO delivery not waived without approved default address (5000)', order && order.shipping_iqd === 5000, `shipping=${order?.shipping_iqd}`);
  check('order snapshots tier', JSON.stringify(r.data).includes('pro') || order?.membership_tier_snapshot === 'pro');

  console.log('\n— template round-trip');
  r = await admin.get(`/api/admin/template/export/${productId}`);
  const tpl = r.text;
  check('export produces a template', r.status === 200 && tpl.includes('template_version=2') && tpl.includes('options.1.'), tpl.slice(0, 100));
  r = await admin.post('/api/admin/template/parse', { text: tpl });
  check('parse of own export: no errors, no unknown keys', r.status === 200 && (r.data?.errors ?? []).length === 0 && (r.data?.unknown_keys ?? []).length === 0, JSON.stringify({ e: r.data?.errors, u: r.data?.unknown_keys }).slice(0, 200));
  // Round-trip apply as update should be a no-op-ish valid save.
  r = await admin.post('/api/admin/template/apply', { text: tpl, mode: 'update', confirm: true });
  check('apply own export as update succeeds', r.status === 200, JSON.stringify(r.data).slice(0, 200));
  const reload = await admin.get(`/api/admin/products-v2/${productId}`);
  check('round-trip preserves option/color links + prices', reload.data?.product?.colors?.[0]?.option_id === 'optA' && reload.data?.product?.colors?.[0]?.regular_price_iqd === 110000 && reload.data?.product?.pro_price_iqd === 90000);

  console.log('\n— extraction v2 gates');
  r = await buyer.post('/api/admin/extract-v2', { url: 'https://example.com/x' });
  check('extract-v2 gone for non-admins too', r.status === 404 || r.status === 403);
  // The extraction feature was REMOVED outright (a later mandate); the
  // endpoints answering 404 is pinned by e2e-product-form and
  // tests/migrations.test.ts — no URL ever gets fetched, SSRF included.
  r = await admin.post('/api/admin/extract-v2', { url: 'http://127.0.0.1/x' });
  check('extract-v2 removed (404 — nothing is ever fetched)', r.status === 404);

  console.log('\n— community PLUS gate');
  const freeUser = new Client();
  await freeUser.post('/api/auth/register', { email: `v2free-${rnd}@test.local`, username: `v2f${rnd}`, name: 'Free', password: 'free-user-pass-1' });
  r = await freeUser.post('/api/community/my-store', { name: 'متجر مجاني', bio: '' });
  check('free tier blocked from creating a store', r.status === 403, JSON.stringify(r.data).slice(0, 120));
  r = await buyer.post('/api/community/my-store', { name: 'متجر برو', bio: 'اختبار' });
  check('active PRO can create a store', r.status === 200);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(' -', f);
    process.exit(1);
  }
}

main().catch((e) => { console.error('v2 test run crashed:', e); process.exit(1); });
