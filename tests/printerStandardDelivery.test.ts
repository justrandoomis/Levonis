import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, json, row, count, pending } from './fixtures/app';
import { acceptedPolicies } from './lib/policies';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { SETTING_DEFAULTS } from '../worker/lib/settings';
import { PRINTER_STANDARD_DELIVERY_POLICY, chooseDeliveryMethod } from '../packages/shipping/src/printerDeliveryPolicy';
import { seedCatalogue, addBundle, orderBody as bundleOrderBody } from './lib/bundles';

const acceptance = { version: PRINTER_STANDARD_DELIVERY_POLICY.version, accepted: true };
function fixture(product = 'printer', opts: { prime?: boolean; stopped?: boolean; size?: string } = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users(id,name,email,password_hash,role) VALUES('buyer','Sara','buyer@x.co','h','customer');
    INSERT INTO addresses(id,user_id,label,name,phone,address,is_default) VALUES('address','buyer','Home','Sara','+9647701234567','Baghdad, Karrada',1);
    INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status) VALUES('deposit','buyer','deposit','USD',100000,'approved');
    INSERT INTO products(id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images)
      VALUES('printer','test-printer','Printer','طابعة',200000,'active',30,'[]','[]','direct_sale','["direct_sale"]','[]'),
            ('ordinary','test-ordinary','Filament','فلمنت',200000,'active',30,'[]','[]','direct_sale','["direct_sale"]','[]');
    INSERT INTO product_catalogs(product_id,catalog_id,position) VALUES('printer','cat_printers_fdm',0);
    INSERT INTO cart_items(id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
      VALUES('cart','buyer','${product}','','[]','','','','',2);
  `);
  if (opts.size) raw.prepare('UPDATE products SET ops_policy=? WHERE id=?').run(JSON.stringify({ size_class: opts.size }), product);
  // «لا يُوصَّل» is a rule group of the delivery policy (0201's g_stopped), not a product field.
  if (opts.stopped) {
    raw.prepare("UPDATE admin_settings SET value=json_set(value,'$.groups[3].product_ids',json(?)) WHERE key='deliveryPolicy'").run(JSON.stringify([product]));
  }
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

test('a product in the «لا يُوصَّل» group makes standard unavailable; every other product keeps it', async () => {
  for (const stopped of [false, true]) {
    const { raw, app, body } = fixture('ordinary', { stopped });
    const cart = await json(await get(app, '/api/cart'));
    assert.equal(cart.items[0].delivery_availability.standard, !stopped);
    assert.equal(cart.delivery_methods.standard.available, !stopped);
    const quote = await json(await post(app, '/api/orders/quote', body));
    if (stopped) {
      assert.equal(quote.code, 'DELIVERY_METHOD_UNAVAILABLE');
      const pickup = await json(await post(app, '/api/orders/quote', { ...body, deliveryMethodId: 'pickup' }));
      assert.ok(pickup.quote, JSON.stringify(pickup));
      assert.deepEqual(pickup.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard'), { id: 'standard', fee_iqd: null, available: false });
    } else {
      assert.ok(quote.quote, JSON.stringify(quote));
      assert.deepEqual(quote.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard'), { id: 'standard', fee_iqd: 5000, available: true });
      assert.equal(quote.quote.printer_standard_warning, undefined);
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
  // The clean start (A.12.1): V2 publishes a product whose selectors live in the relation tables (the JSON mirrors them).
  raw.exec(`INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_weight','ordinary','Weight',0,1);
            INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active) VALUES ('opt','ordinary','g_weight','1 kg','١ كغ',0,1);
            INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active) VALUES ('color','ordinary','Black','أسود','#000',0,1);`);
  raw.exec(`UPDATE cart_items SET option_id='opt',option_value_ids='["opt"]',color_id='color' WHERE id='cart'`);
  const cart = await json(await get(app, '/api/cart'));
  assert.deepEqual(cart.items[0].delivery_availability, { standard: true, personal: false });
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.ok(q.quote, JSON.stringify(q));
  assert.equal(q.quote.shipping.total_iqd, 5000);
  const placed = await json(await post(app, '/api/orders', order(body)));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.shipping_iqd, 5000);
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

/**
 * RETIRED WITH PERSONAL DELIVERY (owner, 2026-10-18). The transport warning a
 * printer sent by standard delivery once had to accept existed because the
 * customer could still pick personal delivery; with that method cancelled the
 * warning is never shown, asked for or required, and an older client's
 * acceptance is ignored rather than frozen onto the order.
 */
test('printer standard delivery needs no transport acknowledgment: no warning on the quote, the order places', async () => {
  const { raw, app, body } = fixture();
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.equal(q.quote.printer_standard_warning, undefined);
  assert.equal(q.quote.shipping.total_iqd, 20000, 'the printers rule: 10,000 per piece (owner, 2026-10-18)');
  const placed = await json(await post(app, '/api/orders', order(body)));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.delivery_method.printer_standard_transport_acceptance, undefined);
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('a printer inside a bundle places by standard delivery with no acknowledgment', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_bundle', slug: 'test-policy-bundle', priceIqd: 400000 });
  const app = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/cart', cartRoutes).route('/api/orders', orderRoutes));
  assert.equal((await json(await post(app, '/api/cart/items', { productId: 'prd_bundle', qty: 1 }))).success, true);
  const input = bundleOrderBody({ printerStandardDeliveryAcceptance: undefined });
  const q = await json(await post(app, '/api/orders/quote', input));
  assert.equal(q.quote.shipping.total_iqd, 10000);
  assert.equal(q.quote.printer_standard_warning, undefined);
  const placed = await json(await post(app, '/api/orders', input));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('an older client still sending the acceptance is ignored, never frozen; replay keeps the same order', async () => {
  const { raw, app, body } = fixture();
  const input = order(body, { printerStandardDeliveryAcceptance: acceptance });
  const placed = await json(await post(app, '/api/orders', input));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const snapshot = JSON.parse(row<{ delivery_method_snapshot: string }>(raw, 'SELECT delivery_method_snapshot FROM orders WHERE id=?', placed.order.id)!.delivery_method_snapshot);
  assert.equal(snapshot.printer_standard_transport_acceptance, undefined);
  const replay = await json(await post(app, '/api/orders', { ...input, printerStandardDeliveryAcceptance: undefined }));
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(replay.order.id, placed.order.id);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 1);
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('membership-free printer delivery places with no acknowledgment on any method', async () => {
  for (const method of ['standard', 'personal', 'pickup']) {
    const { raw, app, body } = fixture('printer', { prime: true });
    const input = { ...body, deliveryMethodId: method };
    const q = await json(await post(app, '/api/orders/quote', input));
    assert.ok(q.quote, JSON.stringify(q));
    assert.equal(q.quote.printer_standard_warning, undefined);
    if (method === 'standard') {
      assert.equal(q.quote.shipping.total_iqd, 0);
      assert.equal(q.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard').available, true);
    }
    const placed = await json(await post(app, '/api/orders', order(input)));
    assert.equal(placed.success, true, JSON.stringify(placed));
    await Promise.allSettled(pending.splice(0));
    raw.close();
  }
});

test('unconfigured personal printer shipping is unavailable rather than falsely advertised as free', async () => {
  const { raw, app, body } = fixture('printer', { size: 'printer_small' });
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.deepEqual(q.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'personal'), { id: 'personal', fee_iqd: null, available: false, reason: 'needs_configuration' });
  assert.deepEqual(q.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard'), { id: 'standard', fee_iqd: 20000, available: true });
  const configured = { ...SETTING_DEFAULTS.shippingPolicy, printer_small_iqd: 25000 };
  raw.prepare('INSERT OR REPLACE INTO admin_settings(key,value) VALUES(?,?)').run('shippingPolicy', JSON.stringify(configured));
  const changed = await json(await post(app, '/api/orders/quote', body));
  assert.equal(changed.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'personal').available, true);
  raw.close();
});

test('the initial choice is the first visible method, an explicit choice stays, and a missing method safely falls back', () => {
  assert.equal(chooseDeliveryMethod('', ['standard', 'personal', 'pickup']), 'standard');
  assert.equal(chooseDeliveryMethod('', ['pickup', 'standard']), 'pickup');
  assert.equal(chooseDeliveryMethod('pickup', ['standard', 'pickup']), 'pickup');
  assert.equal(chooseDeliveryMethod('personal', ['standard', 'pickup']), 'standard');
  assert.equal(chooseDeliveryMethod('standard', []), '');
});

test('all-unconfigured quote fees keep a stable visible selection; a priced method is preferred over an unpriced one', () => {
  const visible = ['standard'];
  const missing = [{ id: 'standard', available: false }];
  let method = chooseDeliveryMethod('', visible);
  assert.equal(method, 'standard');
  for (let quote = 0; quote < 4; quote++) {
    method = chooseDeliveryMethod('', visible, missing);
    assert.equal(method, 'standard', 'the quote never clears the configured method and never needs to be discarded');
  }
  assert.deepEqual(visible, ['standard'], 'quote configuration blockers do not remove visible choices');
  assert.equal(chooseDeliveryMethod('', ['standard', 'pickup'], [
    { id: 'standard', available: false }, { id: 'pickup', available: true },
  ]), 'pickup');
  assert.equal(chooseDeliveryMethod('', ['standard', 'pickup'], [
    { id: 'standard', available: true, fee_iqd: 0 }, { id: 'pickup', available: true, fee_iqd: 0 },
  ] as Array<{ id: string; available: boolean; fee_iqd: number }>), 'standard', 'zero is a fee, not an availability signal');
  assert.equal(chooseDeliveryMethod('standard', ['standard', 'pickup'], missing), 'standard', 'a valid explicit choice is preserved');
});
