#!/usr/bin/env node
/**
 * THE OWNER'S JOURNEY, end to end against a running worker.
 *
 * The report was: "the price changes, but a product already in a customer's
 * cart keeps the old price, and the order is placed on the old price."
 *
 * What this suite pins:
 *   1. a plain product's price change reaches the cart AND the order
 *   2. an option that carries its own price does NOT follow — and the save
 *      says so, by name and count, instead of leaving it silent
 *   3. moving the pinned rows by the same difference makes the cart agree
 *      with the storefront
 *   4. clearing them to follow the base makes every FUTURE change reach the
 *      cart with no dialog at all
 *   5. none of it touches an order already placed
 */
import { execSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const ROOT = '/home/user/Levonis';
const rnd = Math.random().toString(36).slice(2, 8);
const sql = (s) => execSync(`npx wrangler d1 execute levonis-db --local --command ${JSON.stringify(s)}`, { cwd: ROOT, stdio: 'pipe' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

class C {
  constructor() { this.cookie = ''; }
  async call(m, p, b) {
    const h = this.cookie ? { Cookie: this.cookie } : {};
    if (b !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let d = null; try { d = await r.json(); } catch { /* */ }
    return { status: r.status, data: d };
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  put(p, b) { return this.call('PUT', p, b); }
  del(p) { return this.call('DELETE', p); }
}

/** Exactly what the admin form does to change a price: load, edit, POST back. */
async function setBasePrice(admin, id, price) {
  const cur = (await admin.get(`/api/admin/products-v2/${id}`)).data?.product;
  return admin.post('/api/admin/products-v2', { ...cur, price_iqd: price });
}
const cartPrice = async (buyer, productId) =>
  ((await buyer.get('/api/cart')).data?.items ?? []).find((i) => i.productId === productId)?.unit_price_iqd;

async function main() {
  console.log(`\nPRICE CHANGE suite — ${BASE}\n`);
  const admin = new C(), buyer = new C();
  const password = 'price-change-12345';
  const aEmail = `pc-${rnd}@test.local`;
  await admin.post('/api/auth/register', { email: aEmail, username: `pc${rnd}`, name: 'Admin', password });
  sql(`UPDATE users SET role='admin' WHERE email='${aEmail}'`);
  await sleep(800);
  let r = await admin.post('/api/auth/login', { email: aEmail, password });
  check('admin signed in', r.status === 200);
  const bEmail = `pcb-${rnd}@test.local`;
  await buyer.post('/api/auth/register', { email: bEmail, username: `pcb${rnd}`, name: 'Buyer', password });
  await buyer.post('/api/auth/login', { email: bEmail, password });

  // ------------------------------------- 1. a plain product follows the price
  console.log('\n1. a product with one price follows a change everywhere');
  const plain = (await admin.post('/api/admin/products-v2', {
    name_en: `Plain ${rnd}`, price_iqd: 100000, status: 'active', sale_types: ['direct_sale'], stock: 50,
  })).data?.product;
  await buyer.post('/api/cart/items', { productId: plain.id, qty: 2 });
  check('the cart shows the price it was added at', (await cartPrice(buyer, plain.id)) === 100000);
  r = await setBasePrice(admin, plain.id, 150000);
  check('the price saves', r.status === 200 && r.data?.product?.price_iqd === 150000);
  check('a product ALREADY in the cart follows the new price', (await cartPrice(buyer, plain.id)) === 150000, String(await cartPrice(buyer, plain.id)));
  check('and nothing is reported as left behind', !r.data?.pinned_prices, JSON.stringify(r.data?.pinned_prices));

  // the order charges what the cart says
  const addr = (await buyer.post('/api/addresses', {
    label: 'Home', name: `زبون ${rnd}`, phone: '07701112233', address: 'شارع 14 رمضان',
    landmark: 'قرب السوق', governorate: 'baghdad', area: 'المنصور', isDefault: true,
  })).data?.id;
  const methods = (await buyer.get('/api/settings/public')).data?.settings?.checkoutDeliveryMethods ?? [];
  const pol = await buyer.get('/api/policies');
  const acceptance = (pol.data?.policies ?? [])
    .filter((x) => x.key === 'terms' || x.key === 'privacy')
    .map((x) => ({ key: x.key, version: Number(x.version) }));
  const placed = await buyer.post('/api/orders', {
    addressId: addr, deliveryMethodId: methods[0]?.id ?? 'standard', paymentMethodId: 'cash',
    policyAcceptance: acceptance, idempotencyKey: `pc-${rnd}-1`,
  });
  const orderId = placed.data?.order?.id;
  const items = (await buyer.get(`/api/orders/${orderId}`)).data?.order?.items ?? [];
  check('the order is charged at the NEW price, never the old one', items[0]?.unit_price_iqd === 150000, JSON.stringify(items.map((i) => i.unit_price_iqd)));

  // ------------------------------- 2. an option with its own price does not
  console.log('\n2. an option that carries its own price keeps it — and says so');
  const opt = (await admin.post('/api/admin/products-v2', {
    name_en: `Optioned ${rnd}`, price_iqd: 200000, status: 'active', sale_types: ['direct_sale'], stock: 50,
  })).data?.product;
  r = await admin.put(`/api/admin/products/${opt.id}/relations`, {
    inventory_mode: 'OPTION',
    groups: [{
      id: `g_${rnd}`, name_en: 'Size', sort: 0, active: true,
      values: [
        { id: `vs_${rnd}`, name_en: 'Small', sku_part: 'S', image: '', sort: 0, active: true, stock: 20, low_stock_threshold: null, regular_price_iqd: 200000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
        { id: `vl_${rnd}`, name_en: 'Large', sku_part: 'L', image: '', sort: 1, active: true, stock: 20, low_stock_threshold: null, regular_price_iqd: 260000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      ],
    }],
    colors: [], variants: [],
  });
  check('the options save with their own prices', r.status === 200, JSON.stringify(r.data?.errors ?? '').slice(0, 120));
  await buyer.post('/api/cart/items', { productId: opt.id, qty: 1, optionValueIds: [`vs_${rnd}`] });
  check('the cart charges the option price', (await cartPrice(buyer, opt.id)) === 200000);

  r = await setBasePrice(admin, opt.id, 350000);
  const pinned = r.data?.pinned_prices;
  check('the save REPORTS the rows that will not follow', !!pinned && pinned.count === 2, JSON.stringify(pinned && { count: pinned.count }));
  check('it names them and what each charges today', JSON.stringify(pinned?.rows ?? []).includes('Small') && JSON.stringify(pinned?.rows ?? []).includes('260000'), JSON.stringify(pinned?.rows));
  check('it says where the base moved from and to', pinned?.from === 200000 && pinned?.to === 350000);
  check('nothing was rewritten behind the owner’s back', (await cartPrice(buyer, opt.id)) === 200000);
  const pubMid = (await buyer.get(`/api/products/${opt.slug ?? opt.id}`)).data?.product;
  check('the storefront and the cart genuinely disagree at this point', pubMid?.price_iqd === 350000 && (await cartPrice(buyer, opt.id)) === 200000, `${pubMid?.price_iqd} vs ${await cartPrice(buyer, opt.id)}`);

  // ------------------------------------- 3. moving them makes the two agree
  console.log('\n3. moving the pinned rows makes the cart agree with the shelf');
  r = await admin.post(`/api/admin/products-v2/${opt.id}/reprice`, { mode: 'delta', from_price_iqd: 200000, to_price_iqd: 350000 });
  check('the move is accepted and reports every row it touched', r.status === 200 && r.data?.moved >= 2, JSON.stringify(r.data?.moved));
  check('the same difference is applied, not the same price', JSON.stringify(r.data?.changes ?? []).includes('410000'), JSON.stringify((r.data?.changes ?? []).map((c) => [c.label, c.from, c.to])));
  check('the cart now charges the new price', (await cartPrice(buyer, opt.id)) === 350000, String(await cartPrice(buyer, opt.id)));
  const pubAfter = (await buyer.get(`/api/products/${opt.slug ?? opt.id}`)).data?.product;
  check('and the storefront agrees with it', pubAfter?.price_iqd === 350000);

  // ------------------------- 4. inherit makes every future change automatic
  console.log('\n4. clearing them makes the next change reach the cart on its own');
  r = await admin.post(`/api/admin/products-v2/${opt.id}/reprice`, { mode: 'inherit', from_price_iqd: 350000, to_price_iqd: 350000 });
  check('the rows are cleared to follow the base', r.status === 200 && r.data?.moved >= 2);
  r = await setBasePrice(admin, opt.id, 500000);
  check('a later price change reports nothing left behind', !r.data?.pinned_prices, JSON.stringify(r.data?.pinned_prices));
  check('and the cart follows it with no further action', (await cartPrice(buyer, opt.id)) === 500000, String(await cartPrice(buyer, opt.id)));

  // ----------------------------------- 5. a placed order is never rewritten
  console.log('\n5. an order already placed keeps the price it was charged');
  const stillItems = (await buyer.get(`/api/orders/${orderId}`)).data?.order?.items ?? [];
  check('the earlier order still shows what the customer actually paid', stillItems[0]?.unit_price_iqd === 150000, JSON.stringify(stillItems.map((i) => i.unit_price_iqd)));

  // ------------------------------------------------ the refusals
  console.log('\n6. the move refuses what it should');
  r = await admin.post(`/api/admin/products-v2/${opt.id}/reprice`, { mode: 'sideways', from_price_iqd: 1, to_price_iqd: 2 });
  check('an unknown mode is refused by name', r.status === 400 && r.data?.code === 'BAD_MODE', JSON.stringify(r.data).slice(0, 120));
  r = await admin.post('/api/admin/products-v2/prd_does_not_exist/reprice', { mode: 'delta', from_price_iqd: 1, to_price_iqd: 2 });
  check('an unknown product is a plain 404', r.status === 404);
  const anon = new C();
  r = await anon.post(`/api/admin/products-v2/${opt.id}/reprice`, { mode: 'delta', from_price_iqd: 1, to_price_iqd: 2 });
  check('a stranger cannot move anyone’s prices', r.status === 401 || r.status === 403, `status=${r.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
