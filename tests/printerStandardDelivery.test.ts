import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { freshDb, asD1, stubApp, post, get, json, row, count, pending } from './fixtures/app';
import { acceptedPolicies } from './lib/policies';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { SETTING_DEFAULTS } from '../worker/lib/settings';
import { PRINTER_STANDARD_DELIVERY_POLICY, chooseDeliveryMethod, isPrinterStandardAcceptance, printerStandardAcceptanceContext, requiresPrinterStandardAcceptance } from '../packages/shipping/src/printerDeliveryPolicy';
import type { ProductDeliveryOptions } from '../packages/shipping/src/shipping';
import DeliveryAvailabilityNotice from '../src/components/adminProducts/DeliveryAvailabilityNotice';
import { seedCatalogue, addBundle, orderBody as bundleOrderBody } from './lib/bundles';

const acceptance = { version: PRINTER_STANDARD_DELIVERY_POLICY.version, accepted: true };
const enabled: ProductDeliveryOptions = {
  standard: { enabled: true, quantity_step: 1, fee_iqd: 0 },
  personal: { enabled: true, quantity_step: 1, fee_iqd: 12000 },
};

function fixture(product = 'printer', opts: { prime?: boolean; rules?: ProductDeliveryOptions; size?: string } = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users(id,name,email,password_hash,role) VALUES('buyer','Sara','buyer@x.co','h','customer');
    INSERT INTO addresses(id,user_id,label,name,phone,address,is_default) VALUES('address','buyer','Home','Sara','+9647701234567','Baghdad, Karrada',1);
    INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status) VALUES('deposit','buyer','deposit','USD',100000,'approved');
    INSERT INTO catalogs(id,slug,name_ar,is_printer_catalog) VALUES('test_print','test-printer','طابعات',1);
    INSERT INTO products(id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images)
      VALUES('printer','test-printer','Printer','طابعة',200000,'active',30,'[]','[]','direct_sale','["direct_sale"]','[]'),
            ('ordinary','test-ordinary','Filament','فلمنت',200000,'active',30,'[]','[]','direct_sale','["direct_sale"]','[]');
    INSERT INTO product_catalogs(product_id,catalog_id,position) VALUES('printer','test_print',0);
    INSERT INTO cart_items(id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
      VALUES('cart','buyer','${product}','','[]','','','','',2);
  `);
  if (opts.rules || opts.size) raw.prepare('UPDATE products SET ops_policy=? WHERE id=?').run(JSON.stringify({ delivery_options: opts.rules, size_class: opts.size }), product);
  if (opts.prime) raw.exec(`INSERT INTO memberships(id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
    VALUES('membership','buyer','prime_12mo','prime','active',12,199000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')`);
  const app = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/cart', cartRoutes).route('/api/orders', orderRoutes));
  const body = { addressId: 'address', deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: ['cart'] };
  return { raw, app, body };
}

let sequence = 0;
function order(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...body, idempotencyKey: `printer-policy-${++sequence}`, policyAcceptance: acceptedPolicies(), ...extra };
}

test('legacy products inherit delivery availability; explicit disables are honored independently of a zero fee', async () => {
  for (const rules of [undefined, enabled, { ...enabled, standard: { ...enabled.standard, enabled: false } }]) {
    const { raw, app, body } = fixture('ordinary', { rules });
    const cart = await json(await get(app, '/api/cart'));
    assert.equal(cart.items[0].delivery_availability.standard, rules?.standard.enabled !== false);
    const quote = await json(await post(app, '/api/orders/quote', body));
    if (rules?.standard.enabled === false) {
      assert.equal(quote.code, 'DELIVERY_METHOD_UNAVAILABLE');
      const personal = await json(await post(app, '/api/orders/quote', { ...body, deliveryMethodId: 'personal' }));
      assert.ok(personal.quote, JSON.stringify(personal));
      assert.deepEqual(personal.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard'), { id: 'standard', fee_iqd: null, available: false });
    } else {
      assert.ok(quote.quote, JSON.stringify(quote));
      assert.deepEqual(quote.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard'), { id: 'standard', fee_iqd: 5000, available: true });
      assert.equal(quote.quote.printer_standard_warning, null);
    }
    raw.close();
  }
});

test('ordinary membership-free shipping is available at zero and needs no printer acknowledgment', async () => {
  const { raw, app, body } = fixture('ordinary', { prime: true });
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.deepEqual(q.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard'), { id: 'standard', fee_iqd: 0, available: true });
  const res = await json(await post(app, '/api/orders', order(body)));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.order.shipping_iqd, 0);
  assert.equal(res.order.delivery_method.printer_standard_transport_acceptance, undefined);
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('an option/color selection with no product delivery override inherits the normal standard consignment', async () => {
  const { raw, app, body } = fixture('ordinary');
  raw.prepare('UPDATE products SET options=?,colors=? WHERE id=?').run(
    JSON.stringify([{ id: 'opt', name: '1 kg', name_ar: '١ كغ', active: true }]),
    JSON.stringify([{ id: 'color', name: 'Black', name_ar: 'أسود', hex: '#000', active: true }]), 'ordinary');
  raw.exec("UPDATE cart_items SET option_id='opt',color_id='color' WHERE id='cart'");
  const cart = await json(await get(app, '/api/cart'));
  assert.deepEqual(cart.items[0].delivery_availability, { standard: true, personal: true });
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.ok(q.quote, JSON.stringify(q));
  assert.equal(q.quote.shipping.total_iqd, 5000);
  const placed = await json(await post(app, '/api/orders', order(body)));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.shipping_iqd, 5000);
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('printer standard delivery rejects absent, unchecked and stale consent before any order, hold or stock write', async () => {
  const { raw, app, body } = fixture();
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.deepEqual(q.quote.printer_standard_warning, PRINTER_STANDARD_DELIVERY_POLICY);
  assert.equal(q.quote.shipping.total_iqd, 10000, 'one printer consignment for two printers');
  const walletBefore = count(raw, 'SELECT COUNT(*) n FROM wallet_transactions');
  for (const invalid of [undefined, { accepted: false, version: 1 }, { accepted: true, version: 0 }, { accepted: 'true', version: 1 }]) {
    const res = await post(app, '/api/orders', order(body, { printerStandardDeliveryAcceptance: invalid }));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED');
  }
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_holds'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions'), walletBefore);
  assert.equal(row<{ stock: number }>(raw, "SELECT stock FROM products WHERE id='printer'")?.stock, 30);
  raw.close();
});

test('a printer inside a bundle requires its own standard-transport acknowledgment', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_bundle', slug: 'test-policy-bundle', priceIqd: 400000 });
  const app = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/cart', cartRoutes).route('/api/orders', orderRoutes));
  assert.equal((await json(await post(app, '/api/cart/items', { productId: 'prd_bundle', qty: 1 }))).success, true);
  const input = bundleOrderBody({ printerStandardDeliveryAcceptance: undefined });
  const q = await json(await post(app, '/api/orders/quote', input));
  assert.equal(q.quote.shipping.total_iqd, 10000);
  assert.deepEqual(q.quote.printer_standard_warning, PRINTER_STANDARD_DELIVERY_POLICY);
  assert.equal((await json(await post(app, '/api/orders', input))).code, 'PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);
  const placed = await json(await post(app, '/api/orders', { ...input, printerStandardDeliveryAcceptance: acceptance }));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('accepted printer transport policy is frozen with server time; replay keeps its original acceptance', async () => {
  const { raw, app, body } = fixture();
  const input = order(body, { printerStandardDeliveryAcceptance: { ...acceptance, accepted_at: '1900-01-01', user_id: 'someone' } });
  const before = Date.now();
  const placed = await json(await post(app, '/api/orders', input));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const snapshot = JSON.parse(row<{ delivery_method_snapshot: string }>(raw, 'SELECT delivery_method_snapshot FROM orders WHERE id=?', placed.order.id)!.delivery_method_snapshot);
  assert.deepEqual(snapshot.printer_standard_transport_acceptance, {
    ...PRINTER_STANDARD_DELIVERY_POLICY, accepted: true, accepted_at: snapshot.printer_standard_transport_acceptance.accepted_at, user_id: 'buyer',
  });
  assert.ok(Date.parse(snapshot.printer_standard_transport_acceptance.accepted_at) >= before);
  assert.ok(Date.parse(snapshot.printer_standard_transport_acceptance.accepted_at) <= Date.now());
  const replay = await json(await post(app, '/api/orders', { ...input, printerStandardDeliveryAcceptance: undefined }));
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(replay.order.id, placed.order.id);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 1);
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('membership-free printer standard delivery still requires acknowledgment; personal and pickup do not', async () => {
  for (const method of ['standard', 'personal', 'pickup']) {
    const { raw, app, body } = fixture('printer', { prime: true, rules: enabled });
    const input = { ...body, deliveryMethodId: method };
    const q = await json(await post(app, '/api/orders/quote', input));
    assert.ok(q.quote, JSON.stringify(q));
    if (method === 'standard') {
      assert.equal(q.quote.shipping.total_iqd, 0);
      assert.equal(q.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard').available, true);
      assert.equal((await json(await post(app, '/api/orders', order(input)))).code, 'PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED');
    } else assert.equal(q.quote.printer_standard_warning, null);
    const placed = await json(await post(app, '/api/orders', order(input, method === 'standard' ? { printerStandardDeliveryAcceptance: acceptance } : {})));
    assert.equal(placed.success, true, JSON.stringify(placed));
    await Promise.allSettled(pending.splice(0));
    raw.close();
  }
});

test('unconfigured personal printer shipping is unavailable rather than falsely advertised as free', async () => {
  const { raw, app, body } = fixture('printer', { size: 'printer_small' });
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.deepEqual(q.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'personal'), { id: 'personal', fee_iqd: null, available: false, reason: 'needs_configuration' });
  assert.deepEqual(q.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard'), { id: 'standard', fee_iqd: 10000, available: true });
  const configured = { ...SETTING_DEFAULTS.shippingPolicy, printer_small_iqd: 25000 };
  raw.prepare('INSERT OR REPLACE INTO admin_settings(key,value) VALUES(?,?)').run('shippingPolicy', JSON.stringify(configured));
  const changed = await json(await post(app, '/api/orders/quote', body));
  assert.equal(changed.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'personal').available, true);
  raw.close();
});

test('printer initial choice prefers personal, explicit standard choice stays, and a missing method safely falls back', () => {
  assert.equal(chooseDeliveryMethod('', ['standard', 'personal', 'pickup'], true), 'personal');
  assert.equal(chooseDeliveryMethod('', ['standard', 'personal', 'pickup'], false), 'standard');
  assert.equal(chooseDeliveryMethod('standard', ['standard', 'personal'], true), 'standard');
  assert.equal(chooseDeliveryMethod('personal', ['standard', 'pickup'], true), 'standard');
  assert.equal(chooseDeliveryMethod('standard', [], true), '');
  assert.equal(requiresPrinterStandardAcceptance('standard', true), true);
  assert.equal(requiresPrinterStandardAcceptance('standard', false), false);
  assert.equal(requiresPrinterStandardAcceptance('personal', true), false);
  assert.equal(isPrinterStandardAcceptance(acceptance), true);
});

test('all-unconfigured quote fees keep a stable visible selection; a free eligible method is still preferred', () => {
  const visible = ['personal'];
  const missing = [{ id: 'personal', available: false }];
  let method = chooseDeliveryMethod('', visible, true);
  assert.equal(method, 'personal');
  for (let quote = 0; quote < 4; quote++) {
    method = chooseDeliveryMethod('', visible, true, missing);
    assert.equal(method, 'personal', 'the quote never clears the configured method and never needs to be discarded');
  }
  assert.deepEqual(visible, ['personal'], 'quote configuration blockers do not remove visible choices');
  assert.equal(chooseDeliveryMethod('', ['standard', 'personal'], true, [
    { id: 'standard', available: true }, { id: 'personal', available: false },
  ]), 'standard');
  assert.equal(chooseDeliveryMethod('', ['standard', 'personal'], true, [
    { id: 'standard', available: true, fee_iqd: 5000 }, { id: 'personal', available: true, fee_iqd: 0 },
  ] as Array<{ id: string; available: boolean; fee_iqd: number }>), 'personal', 'zero is a fee, not an availability signal');
  assert.equal(chooseDeliveryMethod('standard', ['standard', 'personal'], true, missing), 'standard', 'a valid explicit choice is preserved');
});

test('printer acknowledgment cannot follow a changed method, address, item selection, locale or policy version', () => {
  const original = printerStandardAcceptanceContext('standard', true, 'address', 'cart:1:100000', 1, 'ar');
  assert.ok(original);
  assert.equal(printerStandardAcceptanceContext('standard', true, 'address', 'cart:1:100000', 1, 'ar'), original);
  assert.equal(printerStandardAcceptanceContext('personal', true, 'address', 'cart:1:100000', 1, 'ar'), null);
  assert.equal(printerStandardAcceptanceContext('standard', false, 'address', 'cart:1:100000', 1, 'ar'), null);
  for (const changed of [
    printerStandardAcceptanceContext('standard', true, 'new-address', 'cart:1:100000', 1, 'ar'),
    printerStandardAcceptanceContext('standard', true, 'address', 'cart:2:100000', 1, 'ar'),
    printerStandardAcceptanceContext('standard', true, 'address', 'new-cart:1:100000', 1, 'ar'),
    printerStandardAcceptanceContext('standard', true, 'address', 'cart:1:100000', 2, 'ar'),
    printerStandardAcceptanceContext('standard', true, 'address', 'cart:1:100000', 1, 'en'),
  ]) assert.notEqual(changed, original);
});

test('admin shipping preview exposes both disabled methods and a concrete save-to-repair action without changing the rules', () => {
  const options = { standard: { ...enabled.standard, enabled: false }, personal: { ...enabled.personal, enabled: false } };
  const markup = renderToStaticMarkup(createElement(DeliveryAvailabilityNotice, { options, printer: false }));
  assert.match(markup, /role="alert"/);
  assert.match(markup, /كل طرق التوصيل للمنزل معطّلة/);
  assert.match(markup, /استخدام التعرفة العامة/);
  assert.match(markup, /ثم احفظ المنتج/);
  assert.equal(options.standard.enabled, false);
  assert.equal(options.personal.enabled, false);
  const legacy = renderToStaticMarkup(createElement(DeliveryAvailabilityNotice, { options: null, printer: true }));
  assert.match(legacy, /10,000/);
  assert.doesNotMatch(legacy, /role="alert"/);
});
