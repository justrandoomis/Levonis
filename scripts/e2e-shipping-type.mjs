#!/usr/bin/env node
/**
 * A cart holds exactly ONE shipping type.
 *
 * WHY THIS EXISTS. The owner's rule is short — "السلة الحالية تحتوي منتجات
 * بنوع شحن مختلف. يجب إفراغ السلة لإضافة هذا المنتج" — but it has four
 * forbidden mixes behind it, and each one is a different pair of journeys
 * that cannot share a delivery date or a tracking path:
 *
 *     direct + preorder      air + sea      air + land      sea + land
 *
 * Unit tests already pin cartShippingType() (tests/shippingType.test.ts).
 * They cannot answer the question that actually matters in production: does
 * the HTTP endpoint refuse the write, and does it refuse it WITHOUT having
 * already changed the cart? A rule that returns 400 after inserting the row
 * is worse than no rule, because the customer sees an error and a mixed cart.
 * So every refusal here is followed by a re-read of the cart.
 *
 * It also pins the two ways out the owner named — "إفراغ السلة وإضافة
 * المنتج" (replaceCart) and "إلغاء" (leave it alone, which is the refusal
 * path already checked) — and that the chosen type is written onto the ORDER
 * at checkout, read back from the stored column rather than re-derived.
 *
 *   node scripts/e2e-shipping-type.mjs        (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// `wrangler d1 execute --local` re-binds the SQLite file the dev server has
// mapped and drops every open socket, so we wait for it rather than race it.
const settle = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* still re-binding */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the dev server did not come back after a direct SQL statement');
};

const sqlCmd = (statement) => {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  return execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' }).toString();
};
const sql = (statement) => {
  sqlCmd(statement);
};

class Client {
  constructor() {
    this.cookie = '';
  }
  async call(method, p, body) {
    const h = {};
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, data };
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  del(p, b) { return this.call('DELETE', p, b); }
}

const rnd = Math.random().toString(36).slice(2, 8);
const password = 'shipping-pass-1';

/** Add an item and report what the cart looked like AFTER the attempt. */
async function attempt(buyer, payload) {
  const res = await buyer.post('/api/cart/items', payload);
  const cart = await buyer.get('/api/cart');
  return {
    status: res.status,
    code: res.data?.code,
    details: res.data?.details,
    cartType: cart.data?.shipping_type ?? null,
    count: (cart.data?.items ?? []).length,
  };
}

async function main() {
  console.log(`\nLEVONIS shipping type — one type per cart — ${BASE}\n`);

  // -------------------------------------------------------------- fixtures
  console.log('0. a buyer, an admin, a direct product and a pre-order product');
  const buyer = new Client();
  const admin = new Client();
  const buyerEmail = `ship-${rnd}@test.local`;
  const adminEmail = `shipa-${rnd}@test.local`;

  await buyer.post('/api/auth/register', { email: buyerEmail, username: `ship${rnd}`, name: 'Ship Buyer', password });
  await buyer.post('/api/auth/login', { email: buyerEmail, password });
  await admin.post('/api/auth/register', { email: adminEmail, username: `shipa${rnd}`, name: 'Ship Admin', password });
  sql(`UPDATE users SET role='admin' WHERE email='${adminEmail}'`);
  await settle();
  await admin.post('/api/auth/login', { email: adminEmail, password });

  const cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const section = cats.find((c) => c.effective_template_family === 'devices') ?? cats[0];

  const mk = async (label, saleTypes, transports) => {
    const r = await admin.post('/api/admin/products-v2', {
      name_en: label,
      description_en: 'A shipping-type fixture.',
      price_iqd: 120000,
      status: 'active',
      sale_types: saleTypes,
      preorder_transports: transports,
      category_id: section?.id ?? null,
      stock: 40,
    });
    return { id: r.data?.product?.id, status: r.status, data: r.data };
  };

  const direct = await mk(`Ship Direct ${rnd}`, ['direct_sale'], []);
  const pre = await mk(`Ship Pre ${rnd}`, ['pre_order'], [
    { method: 'air', commission_iqd: 1000 },
    { method: 'sea', commission_iqd: 500 },
    { method: 'land', commission_iqd: 700 },
  ]);
  check('a direct product exists', !!direct.id, JSON.stringify(direct.data).slice(0, 160));
  check('a pre-order product exists', !!pre.id, JSON.stringify(pre.data).slice(0, 160));
  if (!direct.id || !pre.id) throw new Error('fixtures did not save');

  // A pre-order product whose transports came back INACTIVE would refuse
  // every add with TRANSPORT_NOT_OFFERED and every mix check below would
  // "pass" for the wrong reason. This is the control that caught exactly
  // that bug in worker/lib/productModel.ts.
  const stored = await admin.get(`/api/admin/products-v2/${pre.id}`);
  const offered = (stored.data?.product?.preorder_transports ?? []).filter((t) => t.active).map((t) => t.method).sort();
  check(
    'all three transports saved ACTIVE on the pre-order product',
    offered.join(',') === 'air,land,sea',
    `active=${JSON.stringify(offered)}`
  );

  // ---------------------------------------------------------- the baseline
  console.log('\n1. an empty cart has no type, and the first item sets it');
  await buyer.del('/api/cart');
  let cart = await buyer.get('/api/cart');
  check('an empty cart reports shipping_type null', (cart.data?.shipping_type ?? null) === null, JSON.stringify(cart.data?.shipping_type));

  let a = await attempt(buyer, { productId: direct.id, qty: 1 });
  check('a direct product is accepted into an empty cart', a.status === 200, `status=${a.status}`);
  check('and the cart is now direct', a.cartType === 'direct', String(a.cartType));

  a = await attempt(buyer, { productId: direct.id, qty: 1 });
  check('a SECOND item of the same type is still accepted', a.status === 200, `status=${a.status}`);
  check('the rule did not block a legitimate add', a.cartType === 'direct', String(a.cartType));

  // ------------------------------------------------------- forbidden mixes
  console.log('\n2. the four forbidden mixes, each refused without touching the cart');

  // Each row: a starting cart, then the add that must be refused.
  const MIXES = [
    ['direct + pre-order (air)', { productId: direct.id, qty: 1 }, 'direct',
      { productId: pre.id, qty: 1, transportMethod: 'air' }, 'preorder_air'],
    ['pre-order (air) + direct', { productId: pre.id, qty: 1, transportMethod: 'air' }, 'preorder_air',
      { productId: direct.id, qty: 1 }, 'direct'],
    ['air + sea', { productId: pre.id, qty: 1, transportMethod: 'air' }, 'preorder_air',
      { productId: pre.id, qty: 1, transportMethod: 'sea' }, 'preorder_sea'],
    ['air + land', { productId: pre.id, qty: 1, transportMethod: 'air' }, 'preorder_air',
      { productId: pre.id, qty: 1, transportMethod: 'land' }, 'preorder_land'],
    ['sea + land', { productId: pre.id, qty: 1, transportMethod: 'sea' }, 'preorder_sea',
      { productId: pre.id, qty: 1, transportMethod: 'land' }, 'preorder_land'],
  ];

  for (const [label, seed, seedType, intruder, intruderType] of MIXES) {
    await buyer.del('/api/cart');
    const first = await attempt(buyer, seed);
    check(`${label}: the cart starts as ${seedType}`, first.status === 200 && first.cartType === seedType, `status=${first.status} type=${first.cartType}`);

    const blocked = await attempt(buyer, intruder);
    check(`${label}: the mix is refused`, blocked.status === 400, `status=${blocked.status}`);
    check(`${label}: with code CART_SHIPPING_CONFLICT`, blocked.code === 'CART_SHIPPING_CONFLICT', String(blocked.code));
    check(
      `${label}: naming both types so the UI can explain itself`,
      blocked.details?.cart_shipping_type === seedType && blocked.details?.incoming_shipping_type === intruderType,
      JSON.stringify(blocked.details)
    );
    check(`${label}: the cart is UNCHANGED — still ${seedType}, still 1 line`, blocked.cartType === seedType && blocked.count === 1, `type=${blocked.cartType} count=${blocked.count}`);
  }

  // ------------------------------------------- the second door: editing a line
  console.log('\n2b. the rule has a second door — editing an existing line\'s transport');
  await buyer.del('/api/cart');
  await attempt(buyer, { productId: pre.id, qty: 1, transportMethod: 'air' });
  const second = await buyer.post('/api/cart/items', { productId: pre.id, qty: 1, transportMethod: 'air', optionId: '', colorId: '' });
  // The two adds collapse onto one row (same selection), so seed a second
  // DISTINCT line by quantity change instead and read what is actually there.
  let lines = (await buyer.get('/api/cart')).data?.items ?? [];
  check('the cart has at least one line to edit', lines.length >= 1, `lines=${lines.length} add2=${second.status}`);

  // Re-typing the ONLY line is legal — that is how a customer switches air to
  // sea without emptying anything.
  const retype = await buyer.call('PATCH', `/api/cart/items/${lines[0].id}`, { transportMethod: 'sea' });
  check('re-typing the only line is allowed', retype.status === 200, JSON.stringify(retype.data).slice(0, 160));
  cart = await buyer.get('/api/cart');
  check('and the whole cart became preorder_sea', cart.data?.shipping_type === 'preorder_sea', String(cart.data?.shipping_type));

  // With a SECOND line present, re-typing one of them is the forbidden mix
  // reached from the cart screen instead of the product screen.
  const other = await mk(`Ship Pre Two ${rnd}`, ['pre_order'], [
    { method: 'air', commission_iqd: 1000 },
    { method: 'sea', commission_iqd: 500 },
  ]);
  check('a second pre-order product exists', !!other.id, JSON.stringify(other.data).slice(0, 160));
  const added2 = await attempt(buyer, { productId: other.id, qty: 1, transportMethod: 'sea' });
  check('a same-type second line is accepted', added2.status === 200 && added2.count === 2, `status=${added2.status} count=${added2.count}`);

  lines = (await buyer.get('/api/cart')).data?.items ?? [];
  const edited = await buyer.call('PATCH', `/api/cart/items/${lines[0].id}`, { transportMethod: 'air' });
  check('re-typing ONE of two lines is refused', edited.status === 400, `status=${edited.status}`);
  check('with code CART_SHIPPING_CONFLICT', edited.data?.code === 'CART_SHIPPING_CONFLICT', String(edited.data?.code));
  check(
    'naming the type the rest of the cart holds',
    edited.data?.details?.cart_shipping_type === 'preorder_sea' && edited.data?.details?.incoming_shipping_type === 'preorder_air',
    JSON.stringify(edited.data?.details)
  );
  cart = await buyer.get('/api/cart');
  check('and the cart is still unmixed', cart.data?.shipping_type === 'preorder_sea' && (cart.data?.items ?? []).length === 2, JSON.stringify(cart.data?.shipping_type));

  // --------------------------------------------------- "إفراغ السلة وإضافة"
  console.log('\n3. the way out the owner named: empty the cart and add the product');
  await buyer.del('/api/cart');
  await attempt(buyer, { productId: direct.id, qty: 2 });
  const replaced = await attempt(buyer, { productId: pre.id, qty: 1, transportMethod: 'air', replaceCart: true });
  check('replaceCart is accepted', replaced.status === 200, `status=${replaced.status}`);
  check('the cart flipped to preorder_air', replaced.cartType === 'preorder_air', String(replaced.cartType));
  check('and the old type is gone — exactly one line remains', replaced.count === 1, `count=${replaced.count}`);

  console.log('\n4. "إلغاء" leaves the cart alone, and the cart can be emptied outright');
  const cleared = await buyer.del('/api/cart');
  check('DELETE /api/cart answers', cleared.status === 200, `status=${cleared.status}`);
  cart = await buyer.get('/api/cart');
  check('the cart is empty and typeless again', (cart.data?.shipping_type ?? null) === null && (cart.data?.items ?? []).length === 0, JSON.stringify(cart.data?.shipping_type));

  // ------------------------------------------------- the type on the ORDER
  console.log('\n5. the chosen type is written onto the order at checkout');
  const addr = await buyer.post('/api/addresses', {
    label: 'Home',
    name: 'Ship Buyer',
    phone: '07701234567',
    address: 'شارع 62، محلة 909، دار 15',
    governorate: 'baghdad',
    area: 'الجادرية',
    isDefault: true,
  });
  const addressId = addr.data?.id;
  check('the buyer has an address to ship to', !!addressId, JSON.stringify(addr.data).slice(0, 160));

  const methods = (await buyer.get('/api/settings/public')).data?.settings?.checkoutDeliveryMethods ?? [];
  const deliveryId = methods[0]?.id ?? 'standard';
  const pol = await buyer.get('/api/policies');
  const policyAcceptance = (pol.data?.policies ?? [])
    .filter((p) => p.key === 'terms' || p.key === 'privacy')
    .map((p) => ({ key: p.key, version: Number(p.version) }));

  const placeOrder = async (key) =>
    buyer.post('/api/orders', {
      addressId,
      deliveryMethodId: deliveryId,
      paymentMethodId: 'cash',
      policyAcceptance,
      idempotencyKey: key,
    });

  for (const [label, add, expected] of [
    ['a direct order', { productId: direct.id, qty: 1 }, 'direct'],
    ['a sea pre-order', { productId: pre.id, qty: 1, transportMethod: 'sea' }, 'preorder_sea'],
  ]) {
    await buyer.del('/api/cart');
    const seeded = await attempt(buyer, add);
    check(`${label}: the cart is ready (${expected})`, seeded.status === 200 && seeded.cartType === expected, `status=${seeded.status} type=${seeded.cartType}`);

    const placed = await placeOrder(`ship-${rnd}-${expected}-key`);
    check(`${label}: the order was placed`, placed.status === 200, JSON.stringify(placed.data).slice(0, 220));
    const orderId = placed.data?.order?.id;
    check(`${label}: the API reports shipping_type=${expected}`, placed.data?.order?.shipping_type === expected, String(placed.data?.order?.shipping_type));

    if (orderId) {
      // Read the COLUMN, not the serializer. A value only ever computed on
      // read would satisfy the assertion above and still leave the order row
      // blank for every later consumer (tracking, the Al-Waseet driver, the
      // admin panel filter).
      const row = sqlCmd(`SELECT shipping_type FROM orders WHERE id='${orderId}'`);
      check(`${label}: and the stored column holds it too`, row.includes(expected), row.replace(/\s+/g, ' ').slice(0, 200));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
