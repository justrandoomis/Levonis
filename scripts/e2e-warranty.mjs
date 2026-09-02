#!/usr/bin/env node
/**
 * The warranty receipt, end to end against a running worker.
 *
 * Everything here is real: a customer registers, buys TWO physical units of a
 * serialized product through the real checkout, an admin delivers the order,
 * enters a serial per device and issues a receipt for each. The invariants
 * the owner named are then asserted against the API and the database:
 *
 *   1. no serial -> no receipt
 *   2. a serial already carrying a live receipt cannot get a second one
 *   3. two physical units produce two receipts with two numbers
 *   4. the purchase price on the receipt is a SNAPSHOT (the product's price
 *      may change afterwards; the paper may not)
 *   5. one year means the same date next year
 *   6. an order cancelled before delivery issues nothing
 *   7. public verification proves coverage and publishes nothing private
 *   8. a replaced device keeps the old receipt as history
 *   9. a void receipt never verifies as active
 *  10. reprinting counts a copy and creates no second receipt
 *  11. every receipt number is unique
 *
 *   BASE_URL=http://127.0.0.1:8787 node scripts/e2e-warranty.mjs
 */
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const rnd = Math.random().toString(36).slice(2, 8);

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

class Client {
  constructor() {
    this.cookie = '';
  }
  async raw(method, p, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    const res = await fetch(BASE + p, { method, headers: h, body });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return res;
  }
  async json(method, p, body) {
    const res = await this.raw(method, p, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  }
  get(p) {
    return this.json('GET', p);
  }
  post(p, b) {
    return this.json('POST', p, b);
  }
  put(p, b) {
    return this.json('PUT', p, b);
  }
}

function sql(statement) {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' });
}
const settle = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* rebinding */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('dev server gone');
};

async function placeOrder(admin, buyer, { productId, qty, label }) {
  const addr = await buyer.post('/api/addresses', {
    label,
    name: `زبون الضمان ${rnd}`,
    phone: '07801234567',
    address: 'شارع 62، محلة 909، دار 15',
    landmark: 'قرب الجامع',
    governorate: 'baghdad',
    area: 'الكرادة',
    isDefault: true,
  });
  await buyer.post('/api/cart/items', { productId, qty });
  const methods = (await buyer.get('/api/settings/public')).data?.settings?.checkoutDeliveryMethods ?? [];
  const pol = await buyer.get('/api/policies');
  const policyAcceptance = (pol.data?.policies ?? [])
    .filter((p) => p.key === 'terms' || p.key === 'privacy')
    .map((p) => ({ key: p.key, version: Number(p.version) }));
  const placed = await buyer.post('/api/orders', {
    addressId: addr.data?.id,
    deliveryMethodId: methods[0]?.id ?? 'standard',
    paymentMethodId: 'cash',
    policyAcceptance,
    idempotencyKey: `wr-${rnd}-${label}`,
  });
  return placed;
}

async function main() {
  console.log(`\nLEVONIS warranty receipts — ${BASE}\n`);

  // ------------------------------------------------------------ fixtures
  console.log('0. a serialized product, an order of two units, delivered');
  const admin = new Client();
  const adminEmail = `wra-${rnd}@test.local`;
  const password = 'warranty-pass-1';
  let r = await admin.post('/api/auth/register', { email: adminEmail, username: `wra${rnd}`, name: 'Warranty Admin', password });
  check('admin account', r.status === 200, JSON.stringify(r.data).slice(0, 140));
  sql(`UPDATE users SET role='admin' WHERE email='${adminEmail}'`);
  await settle();
  await admin.post('/api/auth/login', { email: adminEmail, password });

  const cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const section = cats.find((c) => c.effective_template_family === 'devices' && c.active) ?? cats[0];
  const created = await admin.post('/api/admin/products-v2', {
    name_en: `Warranty Printer ${rnd}`,
    description_en: 'A serialized device to warrant.',
    price_iqd: 1_850_000,
    status: 'active',
    sale_types: ['direct_sale'],
    category_id: section?.id ?? null,
    stock: 20,
  });
  const productId = created.data?.product?.id;
  check('a product to sell', created.status === 200 && !!productId, JSON.stringify(created.data).slice(0, 200));

  // Serialized + 12 months of base coverage, through the real policy route.
  r = await admin.post(`/api/devices/admin/products/${productId}/ops-policy`, {
    serialized: true,
    warranty_base_months: 12,
  });
  check('the product is marked serialized with a 12-month base', r.status === 200, JSON.stringify(r.data).slice(0, 160));

  const buyer = new Client();
  const buyerEmail = `wrb-${rnd}@test.local`;
  await buyer.post('/api/auth/register', { email: buyerEmail, username: `wrb${rnd}`, name: 'Warranty Buyer', password });
  await buyer.post('/api/auth/login', { email: buyerEmail, password });
  const placed = await placeOrder(admin, buyer, { productId, qty: 2, label: 'home' });
  const orderId = placed.data?.order?.id;
  check('an order of TWO units was placed', placed.status === 200 && !!orderId, JSON.stringify(placed.data).slice(0, 220));
  if (!orderId) throw new Error('no order');

  // ----------------------------------------------- 6. cancelled ≠ warranty
  console.log('\n1. an order cancelled before delivery issues nothing');
  const buyer2 = new Client();
  const buyer2Email = `wrc-${rnd}@test.local`;
  await buyer2.post('/api/auth/register', { email: buyer2Email, username: `wrc${rnd}`, name: 'Cancel Buyer', password });
  await buyer2.post('/api/auth/login', { email: buyer2Email, password });
  const cancelledOrder = await placeOrder(admin, buyer2, { productId, qty: 1, label: 'cancel' });
  const cancelledId = cancelledOrder.data?.order?.id;
  // Deliver it first so units exist, then cancel: the units survive, the
  // receipt must still refuse once the order is cancelled and undelivered.
  sql(`UPDATE orders SET status='delivered', delivered_at='2026-08-01T10:00:00.000Z' WHERE id='${cancelledId}'`);
  await settle();
  await admin.post(`/api/devices/admin/orders/${cancelledId}/units/backfill`, {});
  sql(`UPDATE orders SET status='cancelled', delivered_at=NULL WHERE id='${cancelledId}'`);
  await settle();
  const cancelledUnits = (await admin.get(`/api/admin/warranties/orders/${cancelledId}`)).data?.units ?? [];
  if (cancelledUnits[0]) {
    await admin.post(`/api/devices/admin/units/${cancelledUnits[0].id}/serial`, { serial: `SN-CANCEL-${rnd}` });
    r = await admin.post('/api/admin/warranties', { unit_id: cancelledUnits[0].id });
    check('a cancelled, undelivered order cannot activate a warranty', r.status === 409 && r.data?.code === 'ORDER_CANCELLED', JSON.stringify(r.data).slice(0, 200));
  } else {
    check('a cancelled, undelivered order cannot activate a warranty', false, 'no units were created to test with');
  }

  // ------------------------------------------------------ deliver the real one
  sql(`UPDATE orders SET status='delivered', delivered_at='2026-09-02T09:00:00.000Z' WHERE id='${orderId}'`);
  await settle();
  r = await admin.post(`/api/devices/admin/orders/${orderId}/units/backfill`, {});
  check('delivery created the physical units', r.status === 200, JSON.stringify(r.data).slice(0, 160));

  let payload = (await admin.get(`/api/admin/warranties/orders/${orderId}`)).data;
  const units = payload?.units ?? [];
  check('two units, one per physical device', units.length === 2, `units=${units.length}`);
  check('the order section carries the customer for the paper', !!payload?.order?.customer?.name && !!payload?.order?.customer?.phone, JSON.stringify(payload?.order?.customer));

  // --------------------------------------------------- 1. serial is mandatory
  console.log('\n2. no serial, no receipt');
  r = await admin.post('/api/admin/warranties', { unit_id: units[0].id });
  check('a unit with no serial is refused by name', r.status === 400 && r.data?.code === 'SERIAL_REQUIRED', JSON.stringify(r.data).slice(0, 200));

  // --------------------------------------------- 3. two devices, two receipts
  console.log('\n3. one receipt per physical device');
  const serialA = `SN-A${rnd}0001`;
  const serialB = `SN-B${rnd}0002`;
  await admin.post(`/api/devices/admin/units/${units[0].id}/serial`, { serial: serialA });
  await admin.post(`/api/devices/admin/units/${units[1].id}/serial`, { serial: serialB });

  const genA = await admin.post('/api/admin/warranties', { unit_id: units[0].id });
  const genB = await admin.post('/api/admin/warranties', { unit_id: units[1].id });
  const recA = genA.data?.receipt;
  const recB = genB.data?.receipt;
  check('the first device got a receipt', genA.status === 200 && !!recA?.receipt_no, JSON.stringify(genA.data).slice(0, 200));
  check('the second device got its OWN receipt', genB.status === 200 && !!recB?.receipt_no);
  check('the two numbers are different', recA?.receipt_no !== recB?.receipt_no, `${recA?.receipt_no} vs ${recB?.receipt_no}`);
  check('the numbers follow WR-YYYY-MMDD-NNN', /^WR-\d{4}-\d{4}-\d{3,}$/.test(recA?.receipt_no ?? ''), recA?.receipt_no);
  check('each receipt carries its own serial', recA?.serial_raw === serialA && recB?.serial_raw === serialB, `${recA?.serial_raw} / ${recB?.serial_raw}`);

  // ----------------------------------------------- 2. duplicate serial blocked
  console.log('\n4. a live receipt is never duplicated');
  r = await admin.post('/api/admin/warranties', { unit_id: units[0].id });
  check('a second receipt for the same unit is refused', r.status === 409 && r.data?.code === 'WARRANTY_EXISTS', JSON.stringify(r.data).slice(0, 200));

  // ------------------------------------------------------- 5. the date math
  console.log('\n5. the dates on the paper');
  check('the warranty starts on the delivery date', (recA?.warranty_start_at ?? '').startsWith('2026-09-02'), recA?.warranty_start_at);
  check('one year later, to the day', (recA?.warranty_end_at ?? '').startsWith('2027-09-02'), recA?.warranty_end_at);
  check('the period is recorded in months', recA?.warranty_months === 12, String(recA?.warranty_months));

  // --------------------------------------------------- 4. the price snapshot
  console.log('\n6. the price on the paper is a snapshot');
  check('the receipt carries the price actually paid', recA?.purchase_price_iqd === 1_850_000, String(recA?.purchase_price_iqd));
  await admin.post('/api/admin/products-v2', { id: productId, name_en: `Warranty Printer ${rnd}`, price_iqd: 999_000, status: 'active', sale_types: ['direct_sale'] });
  const afterPriceChange = (await admin.get(`/api/admin/warranties/${recA.id}`)).data?.receipt;
  check('changing the product price does NOT change an issued receipt', afterPriceChange?.purchase_price_iqd === 1_850_000, String(afterPriceChange?.purchase_price_iqd));

  // ---------------------------------------------------------- the document
  console.log('\n7. the printed document');
  let res = await admin.raw('GET', `/api/admin/warranties/${recA.id}/document`);
  const html = await res.text();
  check('the document renders', res.status === 200 && html.includes('<html'), `status=${res.status}`);
  check('it is A4, not a thermal roll', html.includes('size: A4') && !html.includes('80mm'));
  check('it prints the receipt number, the serial and the customer', html.includes(recA.receipt_no) && html.includes(serialA) && html.includes(`زبون الضمان ${rnd}`));
  check('it prints the retailer block', html.includes('LEVONIS-IQ.COM') && html.includes('@LEVONIS_IQ') && html.includes('07838455220'));
  check('it carries a vector QR of the verification address', html.includes('<svg class="qr"') && !html.includes('<img'));
  const enDoc = await (await admin.raw('GET', `/api/admin/warranties/${recA.id}/document?lang=en`)).text();
  check('the English copy is the same document in English', enDoc.includes('Warranty Receipt') && enDoc.includes('Authorized Retailer Information'));

  // ---------------------------------------------- 10. reprint ≠ new receipt
  console.log('\n8. reprinting');
  const before = (await admin.get('/api/admin/warranties?limit=100')).data?.total ?? 0;
  r = await admin.post(`/api/admin/warranties/${recA.id}/printed`, {});
  check('a reprint is counted', r.status === 200 && r.data?.print_count === 1, JSON.stringify(r.data));
  const after = (await admin.get('/api/admin/warranties?limit=100')).data?.total ?? 0;
  check('a reprint creates NO second receipt', after === before, `${before} -> ${after}`);
  const hist = (await admin.get(`/api/admin/warranties/${recA.id}`)).data?.history ?? [];
  check('the reprint is in the audit trail', hist.some((h) => h.action === 'warranty.reprinted'), JSON.stringify(hist.map((h) => h.action)));
  check('the creation is in the audit trail', hist.some((h) => h.action === 'warranty.created'));

  // ------------------------------------------------- 7. public verification
  console.log('\n9. public verification tells the truth and nothing private');
  const anon = new Client();
  r = await anon.get(`/api/warranty/verify/${recA.receipt_no}`);
  const view = r.data?.warranty;
  check('anyone holding the number can verify it', r.status === 200 && r.data?.found === true, JSON.stringify(r.data).slice(0, 200));
  check('it reports the coverage as active', view?.status === 'active', JSON.stringify(view?.status));
  check('the serial is masked, not published', view?.serial_masked?.startsWith('****') && !JSON.stringify(view).includes(serialA), JSON.stringify(view?.serial_masked));
  const leaked = ['زبون الضمان', '07801234567', 'الكرادة', orderId, '1850000', buyerEmail].filter((s) => JSON.stringify(view).includes(s));
  check('no customer name, phone, address, order or price is published', leaked.length === 0, leaked.join(', '));
  r = await anon.get(`/api/warranty/verify/${encodeURIComponent(serialB)}`);
  check('the device serial verifies too', r.status === 200 && r.data?.warranty?.receipt_no === recB.receipt_no, JSON.stringify(r.data).slice(0, 160));
  r = await anon.get('/api/admin/warranties');
  check('the admin list refuses a stranger', r.status === 401 || r.status === 403, `status=${r.status}`);

  // ------------------------------------------------------- 8. replacement
  console.log('\n10. a replaced device keeps its history');
  const newSerial = `SN-R${rnd}0003`;
  r = await admin.post(`/api/devices/admin/units/${units[1].id}/replace`, {
    reason: `device failed on arrival ${rnd}`,
    new_serial: newSerial,
  });
  const newUnitId = r.data?.new_unit_id;
  check('the device was replaced and a new unit exists', r.status === 200 && !!newUnitId, JSON.stringify(r.data).slice(0, 200));
  // The old receipt is superseded by hand (the admin decides), and the new
  // unit gets its own receipt: both must remain readable afterwards.
  await admin.post(`/api/admin/warranties/${recB.id}/void`, { reason: `replaced by ${newSerial}` });
  const genC = await admin.post('/api/admin/warranties', { unit_id: newUnitId });
  const recC = genC.data?.receipt;
  check('the replacement device gets its own receipt', genC.status === 200 && !!recC?.receipt_no && recC.receipt_no !== recB.receipt_no, JSON.stringify(genC.data).slice(0, 200));
  check('the replacement carries the NEW serial', recC?.serial_raw === newSerial, recC?.serial_raw);
  check('the replacement keeps the original warranty end', (recC?.warranty_end_at ?? '').startsWith('2027-09-02'), recC?.warranty_end_at);
  const oldStill = (await admin.get(`/api/admin/warranties/${recB.id}`)).data?.receipt;
  check('the OLD receipt is still readable with its old serial', oldStill?.serial_raw === serialB, oldStill?.serial_raw);

  // --------------------------------------------------- 9. void ≠ verifiable
  console.log('\n11. a void receipt never verifies as covered');
  r = await anon.get(`/api/warranty/verify/${recB.receipt_no}`);
  check('a voided receipt verifies as void, not as active', r.data?.warranty?.status === 'void', JSON.stringify(r.data?.warranty?.status));
  check('and it reports no remaining days', r.data?.warranty?.days_remaining === null);

  // ------------------------------------------------------------ reissue
  console.log('\n12. reissue replaces the paper, not the history');
  r = await admin.post(`/api/admin/warranties/${recA.id}/reissue`, { reason: `address corrected ${rnd}` });
  const reissued = r.data?.receipt;
  check('a new number is issued', r.status === 200 && !!reissued?.receipt_no && reissued.receipt_no !== recA.receipt_no, JSON.stringify(r.data).slice(0, 200));
  check('the reissued receipt points back at the one it replaces', reissued?.replaces_receipt_id === recA.id);
  const oldA = (await admin.get(`/api/admin/warranties/${recA.id}`)).data?.receipt;
  check('the old number is retired with its reason, not deleted', oldA?.status === 'void' && String(oldA?.void_reason).includes('address corrected'), JSON.stringify(oldA?.void_reason));
  r = await anon.get(`/api/warranty/verify/${reissued.receipt_no}`);
  check('the new number verifies as active', r.data?.warranty?.status === 'active');

  // ---------------------------------------------------- 11. unique numbers
  console.log('\n13. every number is unique');
  const all = (await admin.get('/api/admin/warranties?limit=100')).data?.receipts ?? [];
  const numbers = all.map((x) => x.receipt_no);
  check('no number is issued twice', new Set(numbers).size === numbers.length, `${numbers.length} receipts`);
  check('the dashboard finds a receipt by its serial', ((await admin.get(`/api/admin/warranties?search=${encodeURIComponent(serialA)}`)).data?.receipts ?? []).length >= 1);
  check('the dashboard finds a receipt by customer phone', ((await admin.get('/api/admin/warranties?search=07801234567')).data?.receipts ?? []).length >= 1);
  const activeOnly = (await admin.get('/api/admin/warranties?status=active&limit=100')).data?.receipts ?? [];
  check('the active filter returns only live receipts', activeOnly.every((x) => x.status === 'active'), JSON.stringify(activeOnly.map((x) => x.status)));

  // ------------------------------------------------------------- config
  console.log('\n14. the terms are the admin’s to change');
  const cfg = (await admin.get('/api/admin/warranties/config')).data?.config;
  check('the config is readable', !!cfg?.terms?.length && cfg?.retailer?.name === 'LEVONIS', JSON.stringify(cfg?.retailer));
  r = await admin.put('/api/admin/warranties/config', {
    ...cfg,
    terms: [...cfg.terms, { ar: `شرط إضافي ${rnd}`, en: `Extra term ${rnd}` }],
  });
  check('an admin can add a term', r.status === 200 && r.data?.config?.terms?.length === cfg.terms.length + 1);
  const laterDoc = await (await admin.raw('GET', `/api/admin/warranties/${reissued.id}/document`)).text();
  check('a receipt issued BEFORE the change keeps its own terms', !laterDoc.includes(`شرط إضافي ${rnd}`));
  await admin.put('/api/admin/warranties/config', cfg);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
