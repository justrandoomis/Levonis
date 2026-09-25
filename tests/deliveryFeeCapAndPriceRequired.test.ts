/**
 * OWNER DECISION 2026-09-25 (review W2-5 finding 2, probe p5): COMMISSION
 * CANNOT BE BYPASSED THROUGH THE DELIVERY FEE.
 *
 * The probe: a product at 0 IQD with a 1,000,000 IQD delivery fee placed an
 * order on which the platform took no commission. Now:
 *   (a) a platform-wide maximum merchant delivery fee (admin setting
 *       `merchantDeliveryFeeMaxIqd`, default 25,000, financial scope + audit)
 *       is enforced by the SAME validator on PUT /api/merchant/delivery
 *       (DELIVERY_FEE_ABOVE_MAX {max_fee_iqd}) and re-applied by the resolver
 *       at quote/place: a stored fee above the current cap is charged AT the
 *       cap, and the fingerprint carries the clamped fee;
 *   (b) a PUBLISHED product must cost more than 0 (and each active variant):
 *       PRODUCT_PRICE_REQUIRED on publish/edit, and checkout refuses a
 *       0-priced line. A 0-priced product published before the rule stays
 *       published, flagged `price_required`, and is unpurchasable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, patch, put, json, row, count, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { merchantApp, seedCatalog, variantBody } from './fixtures/catalog';
import { SETTING_DEFAULTS } from '../worker/lib/settings';
import { DEFAULT_MERCHANT_DELIVERY_FEE_MAX_IQD, validateDeliveryConfig } from '../packages/shipping/src/merchantDelivery';

function seed(opts: { price: number; deliverySettings: string }) {
  const raw = freshDb();
  seedCatalog(raw);
  raw.exec(`
    UPDATE users SET admin_scope = 'full' WHERE id = 'boss';
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('aide','Aide','aide@x.co','h','admin','assistant');
    UPDATE merchant_stores SET delivery_settings = '${opts.deliverySettings}' WHERE id = 's_ali';
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',${opts.price},100,0);
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES ('dep','buyer','deposit','USD',100000000,'approved','seed');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
  `);
  return raw;
}
const buyer = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
  });
const admin = (raw: DatabaseSync, who: StubUser) => stubApp(asD1(raw), who, (a) => a.route('/api/admin/community', adminCommunityRoutes));
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: 'full' };
const AIDE: StubUser = { id: 'aide', role: 'admin', email: 'aide@x.co', admin_scope: 'assistant' };

async function quote(raw: DatabaseSync) {
  const b = buyer(raw);
  assert.equal((await post(b, '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 })).status, 201);
  const res = await post(b, '/api/store-orders/quote', { addressId: 'a1' });
  return { status: res.status, body: await json(res) };
}

test('p5: goods at 0 IQD with a 1,000,000 IQD delivery fee — the order is refused, nothing is charged', async () => {
  const raw = seed({ price: 0, deliverySettings: '{"fee_iqd":1000000}' });
  const q = await quote(raw);
  assert.equal(q.status, 409);
  assert.equal(q.body.code, 'PRODUCT_PRICE_REQUIRED');
  const placed = await post(buyer(raw), '/api/store-orders', { idempotencyKey: 'probe-key-0001', addressId: 'a1', quoteFingerprint: 'x' });
  assert.equal(placed.status, 409);
  assert.equal((await json(placed)).code, 'PRODUCT_PRICE_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);
});

test('a stored fee above the cap is charged AT the cap at quote and place — with the commission on the goods', async () => {
  const raw = seed({ price: 14_000, deliverySettings: '{"fee_iqd":1000000}' });
  const q = await quote(raw);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.quote.delivery_iqd, DEFAULT_MERCHANT_DELIVERY_FEE_MAX_IQD);
  assert.equal(q.body.quote.total_iqd, 14_000 + 25_000);
  const placed = await json(await post(buyer(raw), '/api/store-orders', { idempotencyKey: 'cap-key-0001', addressId: 'a1', quoteFingerprint: q.body.quote.quote_fingerprint }));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const o = row<{ total_iqd: number; platform_fee_iqd: number; shipping_iqd: number }>(raw, 'SELECT total_iqd, platform_fee_iqd, shipping_iqd FROM orders')!;
  assert.equal(o.total_iqd, 39_000);
  assert.ok(o.platform_fee_iqd > 0, 'the platform took its commission');
});

test('the cap at save: the same validator refuses a fee above it — DELIVERY_FEE_ABOVE_MAX with the max; GET shows the max', async () => {
  const raw = seed({ price: 14_000, deliverySettings: '{}' });
  const m = merchantApp(raw);
  const cfg = await json(await get(m, '/api/merchant/delivery'));
  assert.equal(cfg.max_fee_iqd, 25_000);
  const save = (profile: Record<string, unknown>, rules: unknown[] = [], version = cfg.profile.version) =>
    put(m, '/api/merchant/delivery', { version, profile: { default_mode: 'fee', ...profile }, rules });
  const over = await save({ default_fee_iqd: 25_001 });
  assert.equal(over.status, 400);
  const ob = await json(over);
  assert.equal(ob.code, 'DELIVERY_FEE_ABOVE_MAX');
  assert.equal(ob.details.max_fee_iqd, 25_000);
  const rule = await save({ default_fee_iqd: 5_000 }, [{ governorate_id: 'basra', mode: 'fee', fee_iqd: 30_000 }]);
  assert.equal((await json(rule)).code, 'DELIVERY_FEE_ABOVE_MAX');
  assert.equal((await save({ default_fee_iqd: 25_000 })).status, 200);
  // The legacy door honours it too.
  const legacy = await patch(m, '/api/merchant/store', { delivery_settings: { fee_iqd: 90_000 } });
  assert.equal((await json(legacy)).code, 'DELIVERY_FEE_ABOVE_MAX');
  // And the shared validator (the editor runs it as the merchant types).
  const v = validateDeliveryConfig({ profile: { default_mode: 'fee', default_fee_iqd: 30_000 }, rules: [] }, { maxFeeIqd: 25_000 });
  assert.ok(!v.ok && v.issues.some((i) => i.code === 'fee_above_max' && i.path === 'profile.default_fee_iqd'));
});

test('the cap is an admin setting: financial scope + audit; a lowered cap re-prices at quote, and an old fingerprint is refused', async () => {
  const raw = seed({ price: 14_000, deliverySettings: '{"fee_iqd":20000}' });
  assert.equal(SETTING_DEFAULTS.merchantDeliveryFeeMaxIqd, 25_000);
  assert.equal((await json(await get(admin(raw, BOSS), '/api/admin/community/settings'))).settings.merchantDeliveryFeeMaxIqd, '25000');
  assert.equal((await patch(admin(raw, AIDE), '/api/admin/community/settings', { merchantDeliveryFeeMaxIqd: 5_000 })).status, 403);
  const q1 = await quote(raw);
  assert.equal(q1.body.quote.delivery_iqd, 20_000);
  const set = await patch(admin(raw, BOSS), '/api/admin/community/settings', { merchantDeliveryFeeMaxIqd: 10_000 });
  assert.equal(set.status, 200);
  assert.ok(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.community_settings'") >= 1);
  // The fee the customer saw is no longer the fee: place refuses, the new quote is at the cap.
  const stale = await post(buyer(raw), '/api/store-orders', { idempotencyKey: 'cap-key-0002', addressId: 'a1', quoteFingerprint: q1.body.quote.quote_fingerprint });
  assert.equal(stale.status, 409);
  const q2 = await json(await post(buyer(raw), '/api/store-orders/quote', { addressId: 'a1' }));
  assert.equal(q2.quote.delivery_iqd, 10_000);
  assert.equal((await json(await get(merchantApp(raw), '/api/merchant/delivery'))).max_fee_iqd, 10_000);
});

test('a published product needs a price above 0 — on create, on publish, in bulk, per active variant', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const m = merchantApp(raw);
  const zero = await post(m, '/api/merchant/products', { name: 'Free thing', price_iqd: 0, state: 'published' });
  assert.equal(zero.status, 409);
  assert.equal((await json(zero)).code, 'PRODUCT_PRICE_REQUIRED');
  const draft = await json(await post(m, '/api/merchant/products', { name: 'Free thing', price_iqd: 0, state: 'draft' }));
  assert.equal(draft.product.state, 'draft', 'a draft may be unpriced');
  const id = draft.product.id;
  assert.equal((await json(await patch(m, `/api/merchant/products/${id}`, { state: 'published' }))).code, 'PRODUCT_PRICE_REQUIRED');
  const bulk = await json(await post(m, '/api/merchant/products/bulk', { action: 'publish', ids: [id] }));
  assert.deepEqual(bulk.results, [{ id, ok: false, code: 'PRODUCT_PRICE_REQUIRED' }]);
  // A variant on sale at its own 0 price.
  const body = variantBody();
  (body.variant_model.variants[1] as Record<string, unknown>).price_iqd = 0;
  assert.equal((await json(await post(m, '/api/merchant/products', body))).code, 'PRODUCT_PRICE_REQUIRED');
  // Priced, it publishes; a bulk price of 0 on it is refused.
  assert.equal((await patch(m, `/api/merchant/products/${id}`, { state: 'published', price_iqd: 5_000 })).status, 200);
  const toZero = await json(await post(m, '/api/merchant/products/bulk', { action: 'set_price', ids: [id], price_iqd: 0 }));
  assert.deepEqual(toZero.results, [{ id, ok: false, code: 'PRODUCT_PRICE_REQUIRED' }]);
  assert.equal(row<{ price_iqd: number }>(raw, 'SELECT price_iqd FROM community_products WHERE id = ?', id)!.price_iqd, 5_000);
});

test('a product left published at 0 from before the rule stays published, flagged price_required — never silently unpublished', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  raw.exec(`INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,publish_state,price_iqd,stock,track_stock)
            VALUES ('cp_old','m_ali','s_ali','old-free','Old free','active','active','published',0,5,0)`);
  const p = (await json(await get(merchantApp(raw), '/api/merchant/products/cp_old'))).product;
  assert.equal(p.state, 'published');
  assert.equal(p.price_required, true);
});
