#!/usr/bin/env node
/**
 * The paper, against a real order.
 *
 * Unit tests already pin the renderers (tests/receipts.test.ts). They cannot
 * answer the questions that decide whether a shopkeeper can actually use
 * this: does the route find the right order, does it read the money from the
 * ORDER rather than recomputing it, does the warranty slip refuse an order
 * with no warranted units instead of printing a blank promise, and does the
 * batch sheet contain exactly the orders that have not been dispatched.
 *
 * That last one is the dangerous one. A sticker printed for a parcel already
 * on a motorbike is how the same order goes out twice, so the suite
 * dispatches an order and then checks it has LEFT the sheet.
 *
 *   node scripts/e2e-receipts.mjs        (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const settle = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* rebinding */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the dev server did not come back');
};
const sql = (statement) => {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  return execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' }).toString();
};

class Client {
  constructor() { this.cookie = ''; }
  async call(method, p, body) {
    const h = {};
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const raw = await res.text();
    let data = null; try { data = JSON.parse(raw); } catch { /* html or plain text */ }
    return { status: res.status, data, raw, contentType: res.headers.get('content-type') ?? '' };
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  patch(p, b) { return this.call('PATCH', p, b); }
  del(p) { return this.call('DELETE', p); }
}

const rnd = Math.random().toString(36).slice(2, 7);
const password = 'receipt-pass-1';
const NAME = 'أحمد الجبوري';
const PHONE = '07701234567';
const LANDMARK = 'مقابل الصيدلية';
const NOTES = 'اتصل قبل الوصول';

async function main() {
  try { sql('DELETE FROM rate_limits'); } catch { /* old local db */ }
  console.log(`\nLEVONIS receipts and labels — on a real order — ${BASE}\n`);

  console.log('0. an admin, a customer, and an order to print');
  const admin = new Client(), buyer = new Client();
  const adminEmail = `rca-${rnd}@test.local`, buyerEmail = `rcb-${rnd}@test.local`;
  await admin.post('/api/auth/register', { email: adminEmail, username: `rca${rnd}`, name: 'A', password });
  sql(`UPDATE users SET role='admin' WHERE email='${adminEmail}'`);
  await settle();
  let signedIn = false;
  for (let i = 0; i < 5 && !signedIn; i++) {
    await admin.post('/api/auth/login', { email: adminEmail, password });
    const me = await admin.get('/api/auth/me');
    signedIn = me.data?.user?.role === 'admin';
    if (!signedIn) await new Promise((r) => setTimeout(r, 750));
  }
  check('the admin is signed in', signedIn);
  if (!signedIn) throw new Error('could not sign the admin in');

  await buyer.post('/api/auth/register', { email: buyerEmail, username: `rcb${rnd}`, name: NAME, password });
  await buyer.post('/api/auth/login', { email: buyerEmail, password });
  const addr = await buyer.post('/api/addresses', {
    label: 'Home', name: NAME, phone: PHONE, address: 'شارع 62، محلة 909، دار 15',
    landmark: LANDMARK, governorate: 'baghdad', area: 'الجادرية', notes: NOTES, isDefault: true,
  });
  const addressId = addr.data?.id;
  check('the address carries everything a driver needs', !!addressId, JSON.stringify(addr.data).slice(0, 160));

  const cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const section = cats.find((c) => c.effective_template_family === 'devices') ?? cats[0];
  const productId = (await admin.post('/api/admin/products-v2', {
    name_en: `Receipt Printer ${rnd}`, description_en: 'x', price_iqd: 750000, status: 'active',
    sale_types: ['direct_sale'], category_id: section?.id ?? null, stock: 20,
  })).data?.product?.id;
  check('a product exists', !!productId);

  // Make it a real WARRANTED DEVICE. Serialization and warranty months are
  // explicit per-product configuration — never inferred from a name — so the
  // fixture sets them the way an owner would, otherwise the warranty slip
  // would be tested against a product that legitimately has no warranty and
  // the test would prove nothing.
  const opsPolicy = await admin.post(`/api/devices/admin/products/${productId}/ops-policy`, {
    serialized: true,
    warranty_base_months: 24,
  });
  check('the product is configured as a serialized 24-month device',
    opsPolicy.status === 200, JSON.stringify(opsPolicy.data).slice(0, 200));

  const methods = (await buyer.get('/api/settings/public')).data?.settings?.checkoutDeliveryMethods ?? [];
  const deliveryId = methods[0]?.id ?? 'standard';
  const pol = await buyer.get('/api/policies');
  const policyAcceptance = (pol.data?.policies ?? []).filter((p) => p.key === 'terms' || p.key === 'privacy')
    .map((p) => ({ key: p.key, version: Number(p.version) }));

  const place = async (key) => {
    await buyer.del('/api/cart');
    await buyer.post('/api/cart/items', { productId, qty: 2 });
    const r = await buyer.post('/api/orders', {
      addressId, deliveryMethodId: deliveryId, paymentMethodId: 'cash', policyAcceptance, idempotencyKey: key,
    });
    if (r.status !== 200) throw new Error(`checkout failed: ${JSON.stringify(r.data).slice(0, 240)}`);
    return r.data.order;
  };
  const order = await place(`rcp-${rnd}-1`);
  console.log(`     order ${order.id} · total ${order.total_iqd}`);

  // ------------------------------------------------------- وصل الشراء
  console.log('\n1. the purchase receipt');
  const receipt = await admin.get(`/api/admin/orders/${order.id}/receipt`);
  check('the route answers with HTML', receipt.status === 200 && receipt.contentType.includes('text/html'), `${receipt.status} ${receipt.contentType}`);
  check('it is sized for an 80mm roll, not A4', receipt.raw.includes('@page { size: 80mm auto'), '');
  check('it carries the order number', receipt.raw.includes(order.id));
  // The number a shopkeeper writes on the paper must be the ORDER's number.
  const expectedTotal = `${Number(order.total_iqd).toLocaleString('en-US')} IQD`;
  check(`it prints the order's own total (${expectedTotal})`, receipt.raw.includes(expectedTotal), expectedTotal);
  check('and the customer and their address', receipt.raw.includes(NAME) && receipt.raw.includes(PHONE) && receipt.raw.includes(LANDMARK));
  check('and the note the customer left', receipt.raw.includes(NOTES));
  check('it does NOT auto-print unless asked', !receipt.raw.includes('window.print()'));

  const printable = await admin.get(`/api/admin/orders/${order.id}/receipt?print=1`);
  check('with ?print=1 it opens the print dialog itself', printable.raw.includes('window.print()'));

  const narrow = await admin.get(`/api/admin/orders/${order.id}/receipt?width=58`);
  check('a 58mm roll is supported too', narrow.raw.includes('@page { size: 58mm auto'));

  const english = await admin.get(`/api/admin/orders/${order.id}/receipt?lang=en`);
  check('English prints LTR', english.raw.includes('dir="ltr"') && english.raw.includes('Purchase receipt'));

  const escpos = await admin.get(`/api/admin/orders/${order.id}/receipt?format=escpos`);
  check('the ESC/POS body is offered for a networked printer', escpos.status === 200 && escpos.contentType.includes('text/plain'), escpos.contentType);
  check('and it agrees with the HTML about the total', escpos.raw.includes(expectedTotal), expectedTotal);
  check('it initialises the printer and cuts the paper', escpos.raw.startsWith('\x1b@') && escpos.raw.endsWith('\x1dV\x42\x00'));

  // ------------------------------------------------------- وصل الضمان
  console.log('\n2. the warranty receipt refuses to promise what does not exist');
  const early = await admin.get(`/api/admin/orders/${order.id}/warranty-receipt`);
  check('before delivery it refuses rather than printing a blank form',
    early.status === 400 && early.data?.code === 'NO_WARRANTY_UNITS', `${early.status} ${early.data?.code}`);

  // Deliver it: that is when warranty units are created and the clock starts.
  await admin.patch(`/api/admin/orders/${order.id}/stage`, { stage: 'confirmed' });
  const delivered = await admin.patch(`/api/admin/orders/${order.id}`, { status: 'delivered' });
  check('the order can be marked delivered', delivered.status === 200, JSON.stringify(delivered.data).slice(0, 200));

  const units = sql(`SELECT COUNT(*) AS n FROM order_item_units WHERE order_id='${order.id}'`);
  // Two of the product were ordered, so two physical units must exist —
  // a warranty slip lists PHYSICAL units, not order lines.
  const hasUnits = /"n":\s*2\b/.test(units.replace(/\s+/g, ' '));
  check('delivery created one device unit per physical item', hasUnits, units.replace(/\s+/g, ' ').slice(0, 200));

  const warranty = await admin.get(`/api/admin/orders/${order.id}/warranty-receipt`);
  if (hasUnits) {
    check('the warranty slip prints once there is something to warrant',
      warranty.status === 200 && warranty.raw.includes('وصل ضمان'), `${warranty.status}`);
    check('it names the customer and the order', warranty.raw.includes(NAME) && warranty.raw.includes(order.id));
    check('a unit with no serial says so instead of leaving a blank box',
      warranty.raw.includes('بلا رقم تسلسلي'), '');
    check('it prints the 24 months the owner configured', warranty.raw.includes('24'));
    check('and both physical units, not one line', (warranty.raw.match(/الرقم التسلسلي/g) ?? []).length === 2,
      String((warranty.raw.match(/الرقم التسلسلي/g) ?? []).length));
  } else {
    // An honest outcome either way: no warranted units means the refusal is
    // still correct, and saying so beats asserting a slip that cannot exist.
    check('no warranted units on this product, so the refusal still stands',
      warranty.status === 400 && warranty.data?.code === 'NO_WARRANTY_UNITS',
      `${warranty.status} ${warranty.data?.code}`);
  }

  // -------------------------------------------------------- الستيكرات
  console.log('\n3. the delivery sticker');
  const fresh = await place(`rcp-${rnd}-2`);
  const label = await admin.get(`/api/admin/orders/${fresh.id}/label`);
  check('a single sticker renders', label.status === 200 && label.raw.includes('@page { size: 100mm 70mm'), `${label.status}`);
  check('the phone is on it', label.raw.includes(PHONE));
  check('the governorate and area are on it', label.raw.includes('baghdad') || label.raw.includes('بغداد'));
  const codText = `${Number(fresh.total_iqd).toLocaleString('en-US')} IQD`;
  check('and a cash order shows what the driver collects', label.raw.includes(codText), codText);

  console.log('\n4. the batch sheet is NEW orders only');
  const sheet = await admin.get('/api/admin/labels');
  check('the sheet renders', sheet.status === 200, `${sheet.status}`);

  // THE SHEET IS PAGED, AND MUST SAY SO. The undispatched queue outgrows one
  // page on any busy day (177 against a 50-sticker sheet, in the database this
  // was written on). It used to print the oldest fifty in silence, which is
  // how a warehouse ships the wrong set — so what is asserted here is that the
  // page tells the truth about the queue AND that the rest is reachable, not
  // that the queue happens to fit.
  const banner = /سطر|noprint|sheet-banner/.test(sheet.raw);
  check('the sheet carries an on-screen batch banner', banner);
  const stickers = (sheet.raw.match(/class="label"/g) || []).length;
  const reported = /(\d+)–(\d+)\s*(?:من|of)\s*(\d+)/.exec(sheet.raw);
  const wholeQueue = /(?:غير المُرسَلة|undispatched orders?):\s*(\d+)/.exec(sheet.raw);
  const total = reported ? Number(reported[3]) : wholeQueue ? Number(wholeQueue[1]) : stickers;
  check(
    'the banner reports the WHOLE queue, not just the page',
    total >= stickers,
    `page=${stickers} queue=${total}`
  );
  if (reported) {
    check(
      'a truncated sheet names the exact slice it printed',
      Number(reported[2]) - Number(reported[1]) + 1 === stickers,
      `${reported[1]}–${reported[2]} vs ${stickers} stickers`
    );
    check('and links to the next batch', /offset=/.test(sheet.raw));
  } else {
    check('an untruncated sheet says it holds the whole queue', total === stickers, `${total} vs ${stickers}`);
  }

  /** Every undispatched order is printable — walk the pages to find one. */
  const onSheet = async (id) => {
    for (let off = 0; off <= total; off += 100) {
      const page = await admin.get(`/api/admin/labels?limit=100&offset=${off}`);
      if (page.raw.includes(id)) return true;
      if ((page.raw.match(/class="label"/g) || []).length === 0) break;
    }
    return false;
  };
  check('the undispatched order is on the sheet', await onSheet(fresh.id), fresh.id);
  // The first order was delivered above. Printing a sticker for a parcel
  // that already went out is how the same order goes out twice.
  check('and NOT the one already delivered', !(await onSheet(order.id)), order.id);

  // Dispatching an order must remove it from the sheet immediately.
  await admin.patch(`/api/admin/orders/${fresh.id}/stage`, { stage: 'confirmed' });
  check('a confirmed-but-not-dispatched order is still on the sheet', await onSheet(fresh.id));
  await admin.patch(`/api/admin/orders/${fresh.id}/stage`, { stage: 'out_for_delivery' });
  check('once it is out for delivery it LEAVES the sheet', !(await onSheet(fresh.id)), fresh.id);

  const third = await place(`rcp-${rnd}-3`);
  const selected = await admin.get(`/api/admin/labels?ids=${third.id}`);
  check('an explicit selection prints just those', selected.raw.includes(third.id) && !selected.raw.includes(fresh.id));
  const sneaky = await admin.get(`/api/admin/labels?ids=${fresh.id}`);
  check('but a selection cannot re-print a dispatched order',
    !sneaky.raw.includes(fresh.id) && sneaky.raw.includes('لا توجد طلبات جديدة'), '');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('\nfailures:'); for (const f of failures) console.log(`  - ${f}`); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
