/**
 * «إدارة التوصيل» at the server's checkout (computeCheckout): the governorate
 * door, the method cards, the snapshot frozen with the order and the courier
 * tax charged on the payable after the rule fee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, put, get, json, row, pending } from './fixtures/app';
import { acceptedPolicies } from './lib/policies';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { calculateCodTaxIqd } from '../worker/lib/codTax';

function fixture(opts: { governorate?: string; policy?: (p: Record<string, unknown>) => void; qty?: number; price?: number } = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users(id,name,email,password_hash,role) VALUES('buyer','Sara','buyer@x.co','h','customer');
    INSERT INTO addresses(id,user_id,label,name,phone,address,governorate,is_default)
      VALUES('address','buyer','Home','Sara','+9647701234567','Somewhere','${opts.governorate ?? 'baghdad'}',1);
    INSERT INTO products(id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id)
      VALUES('spool','test-spool','PLA','فلمنت',${opts.price ?? 20000},'active',100,'[]','[]','direct_sale','["direct_sale"]','[]','cat_materials_fdm');
    INSERT INTO cart_items(id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
      VALUES('cart','buyer','spool','','[]','','','','',${opts.qty ?? 12});
  `);
  if (opts.policy) {
    const current = JSON.parse(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key='deliveryPolicy'")!.value);
    opts.policy(current);
    raw.prepare("UPDATE admin_settings SET value=? WHERE key='deliveryPolicy'").run(JSON.stringify(current));
  }
  const app = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/cart', cartRoutes).route('/api/orders', orderRoutes));
  const body = { addressId: 'address', deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: ['cart'] };
  return { raw, app, body };
}

let seq = 0;
const order = (body: Record<string, unknown>) => ({ ...body, idempotencyKey: `delivery-policy-${++seq}`, policyAcceptance: acceptedPolicies() });

test('a stopped governorate refuses standard in three languages; pickup still works and its card says why', async () => {
  const { raw, app, body } = fixture({ governorate: 'anbar', policy: (p) => (p.governorates = { anbar: { stopped: true } }) });
  const refused = await post(app, '/api/orders/quote', body);
  assert.equal(refused.status, 400);
  const r = await json(refused);
  assert.equal(r.code, 'DELIVERY_GOVERNORATE_STOPPED');
  assert.equal(r.details?.governorate ?? r.governorate, 'anbar');
  const message = (r.details?.message ?? r.message_i18n ?? r.message) as { ar: string; en: string; ckb: string } | string;
  const text = typeof message === 'string' ? message : `${message.ar} / ${message.en} / ${message.ckb}`;
  assert.match(text, /التوصيل متوقف حالياً إلى هذه المحافظة/);
  assert.match(text, /Delivery to this governorate is currently stopped/);
  assert.match(text, /گەیاندن بۆ ئەم پارێزگایە ئێستا ڕاگیراوە/);

  const pickup = await json(await post(app, '/api/orders/quote', { ...body, deliveryMethodId: 'pickup' }));
  assert.ok(pickup.quote, JSON.stringify(pickup));
  assert.deepEqual(
    pickup.quote.delivery_method_fees.find((m: { id: string }) => m.id === 'standard'),
    { id: 'standard', fee_iqd: null, available: false, reason: 'governorate_stopped' }
  );
  const placed = await json(await post(app, '/api/orders', order({ ...body, deliveryMethodId: 'pickup' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('the door holds for EVERY home-delivery method: personal cannot reach a stopped governorate or a «لا يُوصَّل» product', async () => {
  const stoppedGov = fixture({ governorate: 'anbar', policy: (p) => (p.governorates = { anbar: { stopped: true } }) });
  const viaPersonal = await post(stoppedGov.app, '/api/orders', order({ ...stoppedGov.body, deliveryMethodId: 'personal' }));
  assert.equal(viaPersonal.status, 400);
  assert.equal((await json(viaPersonal)).code, 'DELIVERY_GOVERNORATE_STOPPED');
  assert.equal(row(stoppedGov.raw, 'SELECT COUNT(*) AS n FROM orders')?.n, 0);
  stoppedGov.raw.close();

  const stoppedProduct = fixture({
    policy: (p) =>
      (p.groups = [
        { id: 'g_stopped', name: { ar: 'لا يُوصَّل', en: 'Not delivered', ckb: 'ناگەیەندرێت' }, enabled: true, mode: 'stopped', fee_iqd: 0, block_size: 1, catalog_ids: [], product_ids: ['spool'] },
      ]),
  });
  const refused = await post(stoppedProduct.app, '/api/orders/quote', { ...stoppedProduct.body, deliveryMethodId: 'personal' });
  assert.equal(refused.status, 400);
  const r = await json(refused);
  assert.equal(r.code, 'DELIVERY_METHOD_UNAVAILABLE');
  assert.deepEqual(r.details?.unavailable_product_ids, ['spool']);
  assert.equal(r.details?.delivery_method_id, 'personal');
  stoppedProduct.raw.close();
});

test('a printer by the owner\'s catalog flag that no rule names pays the printers rule, not the default', async () => {
  const { raw, app, body } = fixture();
  // «أجهزة الليزر» itself is a printer catalog (0102) the seeded printers rule leaves out.
  raw.exec(`
    INSERT INTO products(id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id)
      VALUES('lz','test-laser','Laser','ليزر',900000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','cat_laser');
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('lz','cat_laser',0);
    UPDATE cart_items SET product_id='lz', qty=2 WHERE id='cart';
  `);
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.ok(q.quote, JSON.stringify(q));
  assert.equal(q.quote.shipping.total_iqd, 20_000);
  const part = q.quote.shipping.components.find((c: { rule_id?: string }) => c.rule_id === 'g_printers');
  assert.ok(part, JSON.stringify(q.quote.shipping.components));
  assert.equal(part.rule_name.ar, 'الطابعات');
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('the order freezes the matched rule, its mode and block, and the governorate answer', async () => {
  const { raw, app, body } = fixture({ qty: 12 });
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.ok(q.quote, JSON.stringify(q));
  assert.equal(q.quote.shipping.total_iqd, 10_000, '12 spools = two blocks of 10 at 5,000');
  const placed = await json(await post(app, '/api/orders', order(body)));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const snap = JSON.parse(
    row<{ delivery_method_snapshot: string }>(raw, 'SELECT delivery_method_snapshot FROM orders WHERE id=?', placed.order.id)!.delivery_method_snapshot
  );
  const comp = snap.quote.components.find((c: { rule_id?: string }) => c.rule_id === 'g_filament');
  assert.ok(comp, JSON.stringify(snap.quote.components));
  assert.equal(comp.kind, 'rule');
  assert.equal(comp.mode, 'per_block');
  assert.equal(comp.block_size, 10);
  assert.equal(comp.units, 12);
  assert.equal(snap.quote.delivery_policy.governorate, 'baghdad');
  assert.equal(snap.quote.delivery_policy.governorate_rule, 'default');
  assert.equal(placed.order.shipping_iqd, 10_000);
  await Promise.allSettled(pending.splice(0));
  raw.close();
});

test('a governorate price replaces the default only', async () => {
  const { raw, app, body } = fixture({ qty: 2, policy: (p) => ((p.governorates = { baghdad: { fee_iqd: 3_000 } }), (p.groups = [])) });
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.ok(q.quote, JSON.stringify(q));
  assert.equal(q.quote.shipping.total_iqd, 3_000);
  raw.close();
});

test('the courier tax is charged on the payable AFTER the rule fee', async () => {
  // 11 spools at 45,000 = 495,000 of goods: below one 500,000 block on its own,
  // over it with the filament rule's 10,000 (two blocks of 10).
  const { raw, app, body } = fixture({ qty: 11, price: 45_000 });
  const q = await json(await post(app, '/api/orders/quote', body));
  assert.ok(q.quote, JSON.stringify(q));
  assert.equal(q.quote.shipping.total_iqd, 10_000);
  const merchandise = q.quote.total_iqd - q.quote.shipping.total_iqd - q.quote.cod_tax_iqd;
  const rate = {
    perBlockIqd: Number(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key='codTaxPerBlockIqd'")?.value ?? 3000),
    blockIqd: Number(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key='codTaxBlockIqd'")?.value ?? 500000),
  };
  assert.equal(merchandise, 495_000);
  assert.equal(calculateCodTaxIqd(merchandise, rate), 0, 'the goods alone stay under one block');
  assert.equal(q.quote.cod_tax_iqd, calculateCodTaxIqd(merchandise + 10_000, rate));
  assert.ok(q.quote.cod_tax_iqd > 0, 'the fee carried the payable over a block');
  raw.close();
});

test('the admin save is strict: unknown targets and duplicates are refused in three languages, a good save is stamped and audited', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users(id,name,email,password_hash,role) VALUES('boss','Boss','boss@x.co','h','admin')");
  const app = stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null }, (a) => a.route('/api/admin', adminRoutes));
  const loaded = await json(await get(app, '/api/admin/delivery-policy'));
  assert.equal(loaded.success, true, JSON.stringify(loaded));
  const policy = loaded.policy;
  // On a database without H2S/H2D or stopped products those two groups are empty and inert (dropped on read).
  assert.deepEqual(policy.groups.map((g: { id: string }) => g.id), ['g_printers', 'g_filament']);

  const unknown = structuredClone(policy);
  unknown.groups[0].catalog_ids.push('cat_does_not_exist');
  const r1 = await json(await put(app, '/api/admin/settings/deliveryPolicy', { value: unknown }));
  assert.equal(r1.code, 'DELIVERY_POLICY_TARGET');
  assert.ok(r1.details?.message?.ckb ?? r1.message);

  const dup = structuredClone(policy);
  const filament = dup.groups.find((g: { id: string }) => g.id === 'g_filament');
  filament.catalog_ids = [...filament.catalog_ids, dup.groups[0].catalog_ids[0]];
  const r2 = await json(await put(app, '/api/admin/settings/deliveryPolicy', { value: dup }));
  assert.equal(r2.code, 'DELIVERY_POLICY_INVALID');

  const ok = structuredClone(policy);
  ok.default_fee_iqd = 6000;
  ok.governorates = { baghdad: { fee_iqd: 3000 }, anbar: { stopped: true } };
  const r3 = await json(await put(app, '/api/admin/settings/deliveryPolicy', { value: ok }));
  assert.equal(r3.success, true, JSON.stringify(r3));
  const saved = JSON.parse(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key='deliveryPolicy'")!.value);
  assert.equal(saved.default_fee_iqd, 6000);
  assert.equal(saved.updated_by, 'boss');
  assert.ok(saved.updated_at);
  const audit = row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action='settings.update' AND target='deliveryPolicy'");
  assert.ok(audit && audit.detail.includes('6000'), 'the audit keeps the whole value');

  const resolved = await json(await get(app, '/api/admin/delivery-policy/resolve?category_id=cat_materials_fdm'));
  assert.equal(resolved.group.id, 'g_filament');
  assert.match(resolved.summary.ar, /لكل 10 قطع/);
  assert.match(resolved.summary.ckb, /پارچە/);
  raw.close();
});
