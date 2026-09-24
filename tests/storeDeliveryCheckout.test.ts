/**
 * MERCHANT DELIVERY BY GOVERNORATE, END TO END — the real routes over every
 * migration (merchant platform W2-A, docs/MERCHANT_PLATFORM.md §2 decisions
 * 3–4, §4.2; audit 02 §8.1).
 *
 *   the checkout   the fee comes from the customer's SAVED address and the
 *                  merchant's rows — at the quote and again at place-order;
 *                  the quote fingerprint binds the address, the governorate,
 *                  the rule, the fee and the profile version; the order
 *                  snapshots what was applied;
 *   the merchant   GET/PUT /api/merchant/delivery, strictly validated,
 *                  versioned, audited, mirrored to the legacy JSON; the wave-1
 *                  PATCH door; an open store must deliver somewhere;
 *   the public     GET /api/storefront/:slug/delivery and the store payload's
 *                  summary and «delivery to you».
 *
 * Run: node --import tsx --test tests/storeDeliveryCheckout.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, put, patch, get, json, count, row, holds, pending } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { merchantRoutes } from '../worker/routes/merchant';
import { storefrontRoutes } from '../worker/routes/storefront';

const DEP = 100_000; // 1,400,000 IQD at 1,400
const FUTURE = '2099-01-01T00:00:00.000Z';

function seed(raw: DatabaseSync, opts: { aliDelivery?: string } = {}) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('ali','Ali','ali@x.co','h','merchant'),
      ('zain','Zain','zain@x.co','h','merchant'), ('other','Omar','other@x.co','h','customer');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_zain','zain','Zain Print','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,governorate,delivery_settings) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D','active','baghdad','${opts.aliDelivery ?? '{"fee_iqd":5000}'}'),
      ('s_zain','m_zain','zain','zainprint','Zain Print','active','basra','{}');
    INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES ('ali3d','s_ali',1), ('zainprint','s_zain',1);
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,prep_days) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,100,0,0),
      ('cp_slow','m_ali','s_ali','ali-slow','Made to order','active','active',20000,100,0,5),
      ('cp_zain','m_zain','s_zain','zain-spool','Zain spool','active','active',9000,100,0,0);
    INSERT INTO addresses (id,user_id,label,name,phone,address,governorate,is_default,created_at) VALUES
      ('a_bag','buyer','Home','Sara','+9647700000000','Karrada','baghdad',1,'2026-01-02T00:00:00.000Z'),
      ('a_bas','buyer','Work','Sara','+9647700000000','Ashar','basra',0,'2026-01-03T00:00:00.000Z'),
      ('a_old','buyer','Old','Sara','+9647700000000','Somewhere','',0,'2026-01-01T00:00:00.000Z'),
      ('a_name','buyer','Named','Sara','+9647700000000','Ankawa','Erbil',0,'2026-01-01T00:00:00.000Z'),
      ('a_other','other','Home','Omar','+9647711111111','Mansour','baghdad',1,'2026-01-01T00:00:00.000Z');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES
      ('dep_buyer','buyer','deposit','USD',${DEP},'approved','seed');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem_zain','zain','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
  `);
}

const buyer = (db: D1Database, id = 'buyer') =>
  stubApp(db, { id, role: 'customer', email: `${id}@x.co` }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
    a.route('/api/storefront', storefrontRoutes);
  });
const merchant = (db: D1Database, who = 'ali') =>
  stubApp(db, { id: who, role: 'merchant', email: `${who}@x.co` }, (a) => a.route('/api/merchant', merchantRoutes));
const guest = (db: D1Database) => stubApp(db, null, (a) => a.route('/api/storefront', storefrontRoutes));
type App = ReturnType<typeof buyer>;

const add = (app: App, productId = 'cp_ali', qty = 1) => post(app, '/api/cart/merchant-items', { productId, qty });
const quote = async (app: App, body: Record<string, unknown> = {}) => {
  const res = await post(app, '/api/store-orders/quote', body);
  return { status: res.status, body: await json(res) };
};
const place = async (app: App, body: Record<string, unknown>) => {
  const res = await post(app, '/api/store-orders', body);
  return { status: res.status, body: await json(res) };
};
/** Quote for an address, then place exactly that agreement — what the checkout page does. */
async function quoteAndPlace(app: App, key: string, where: Record<string, unknown> = { addressId: 'a_bag' }) {
  const q = await quote(app, where);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const p = await place(app, { idempotencyKey: key, ...where, quoteFingerprint: q.body.quote.quote_fingerprint });
  return { q: q.body.quote, p };
}

/** Ali's configuration: 5,000 default; Baghdad 3,000; Erbil free; Duhok off; free over 50,000; pickup in Baghdad. */
const ALI_CONFIG = {
  profile: {
    default_mode: 'fee',
    default_fee_iqd: 5000,
    free_over_iqd: 50_000,
    pickup_enabled: true,
    pickup_governorate: 'baghdad',
    pickup_note: 'Karrada, call first',
    prep_days: 1,
    note: 'Delivered by our own courier',
  },
  rules: [
    { governorate_id: 'baghdad', mode: 'fee', fee_iqd: 3000, eta_note: 'Same day' },
    { governorate_id: 'erbil', mode: 'free' },
    { governorate_id: 'duhok', mode: 'disabled' },
  ],
};
async function configure(db: D1Database, cfg: Record<string, unknown> = ALI_CONFIG, who = 'ali') {
  const m = merchant(db, who);
  const now = await json(await get(m, '/api/merchant/delivery'));
  const res = await put(m, '/api/merchant/delivery', { version: now.profile.version, ...cfg });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

const orderRow = (raw: DatabaseSync) => row<Record<string, unknown>>(raw, 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 1');

// ================================================================ the checkout

test('the quote prices the SAVED address’s governorate from the merchant’s rules, and place-order charges exactly that', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app);

  const { q, p } = await quoteAndPlace(app, 'deliv-parity-01');
  assert.deepEqual(
    { ...q.delivery, served: q.delivery.served.length },
    {
      fulfilment: 'delivery', address_id: 'a_bag', governorate: 'baghdad', rule: 'override', fee_iqd: 3000, base_fee_iqd: 3000,
      free_over_iqd: 50_000, prep_days: 1, eta_note: 'Same day', note: 'Delivered by our own courier',
      pickup: { governorate: 'baghdad', note: 'Karrada, call first' }, served: 17,
    }
  );
  assert.equal(q.delivery_iqd, 3000);
  assert.equal(q.total_iqd, 17_000);
  assert.ok(!('profile_version' in q.delivery), 'the customer is not handed the merchant’s editor state');

  assert.equal(p.status, 201, JSON.stringify(p.body));
  const o = orderRow(raw)!;
  assert.deepEqual(
    [o.shipping_iqd, o.total_iqd, o.delivery_governorate, o.delivery_rule, o.delivery_prep_days, o.delivery_method_id, o.quote_fingerprint],
    [3000, 17_000, 'baghdad', 'override', 1, 'merchant', q.quote_fingerprint]
  );
  const snap = JSON.parse(String(o.delivery_method_snapshot));
  assert.equal(snap.by, 'merchant');
  assert.equal(snap.store, 'Ali 3D');
  assert.equal(snap.profile_version, 1);
  assert.equal(snap.profile_source, 'profile');
  assert.deepEqual(snap.applied_rule, { governorate_id: 'baghdad', mode: 'fee', fee_iqd: 3000, free_over_iqd: null, prep_days: null, eta_note: 'Same day', note: '' });
  // The fee is the MERCHANT's: in the receivable beside the goods' share, never in the commission's base.
  assert.equal(Number(o.platform_fee_iqd), 700, '5% of the 14,000 goods only');
  assert.equal(Number(o.merchant_receivable_iqd), 14_000 - 700 + 3000);
  await Promise.allSettled(pending);
});

test('a body that names a fee or a governorate changes nothing — the server reads the saved address', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app);
  const q = await quote(app, { addressId: 'a_bas', governorate: 'baghdad', delivery_iqd: 0, fee_iqd: 0, deliveryFee: 1 });
  assert.equal(q.body.quote.delivery.governorate, 'basra');
  assert.equal(q.body.quote.delivery_iqd, 5000);
});

test('without an addressId the quote prices the customer’s default address and says which', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app);
  const q = await quote(app);
  assert.equal(q.body.quote.delivery.address_id, 'a_bag');
  // …but place-order has no default: it names the address it ships to.
  const p = await place(app, { idempotencyKey: 'no-address-001', quoteFingerprint: q.body.quote.quote_fingerprint });
  assert.equal(p.status, 400);
  assert.equal(p.body.code, 'ADDRESS_REQUIRED');
});

test('the address changed between the quote and the tap: 409 QUOTE_CHANGED with the fresh quote, nothing charged', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app);
  const q = await quote(app, { addressId: 'a_bag' });
  const p = await place(app, { idempotencyKey: 'moved-addr-01', addressId: 'a_bas', quoteFingerprint: q.body.quote.quote_fingerprint });
  assert.equal(p.status, 409);
  assert.equal(p.body.code, 'QUOTE_CHANGED');
  assert.equal(p.body.details.quote.delivery.governorate, 'basra');
  assert.equal(p.body.details.quote.total_iqd, 19_000);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);
  assert.equal(holds(raw, 'buyer').length, 0, 'refused before any reservation');

  // The SAME address edited to another governorate in between is the same answer.
  const q2 = await quote(app, { addressId: 'a_bag' });
  raw.exec("UPDATE addresses SET governorate = 'basra' WHERE id = 'a_bag'");
  const p2 = await place(app, { idempotencyKey: 'moved-addr-02', addressId: 'a_bag', quoteFingerprint: q2.body.quote.quote_fingerprint });
  assert.equal(p2.body.code, 'QUOTE_CHANGED');
  assert.equal(p2.body.details.quote.delivery_iqd, 5000);
});

test('the merchant edits their delivery mid-checkout: 409 QUOTE_CHANGED — even when this customer’s fee did not move', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app);
  const q = await quote(app, { addressId: 'a_bag' });
  // Only Basra's fee changes; Baghdad stays 3,000 — but the profile version moved.
  await configure(db, { ...ALI_CONFIG, rules: [...ALI_CONFIG.rules, { governorate_id: 'basra', mode: 'fee', fee_iqd: 7000 }] });
  const p = await place(app, { idempotencyKey: 'mid-edit-0001', addressId: 'a_bag', quoteFingerprint: q.body.quote.quote_fingerprint });
  assert.equal(p.status, 409);
  assert.equal(p.body.code, 'QUOTE_CHANGED');
  assert.equal(p.body.details.quote.total_iqd, q.body.quote.total_iqd, 'same total — the agreement is still new');
  // Confirming the fresh quote places it.
  const again = await place(app, { idempotencyKey: 'mid-edit-0002', addressId: 'a_bag', quoteFingerprint: p.body.details.quote.quote_fingerprint });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  await Promise.allSettled(pending);
});

test('an edit landing between the price check and the commit aborts the order batch — QUOTE_CHANGED, the hold handed back', async () => {
  const raw = freshDb();
  seed(raw);
  const { failing, db } = failingD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app);
  const q = await quote(app, { addressId: 'a_bag' });
  let raced = false;
  failing.beforeBatch = (stmts) => {
    if (raced || !stmts.some((s) => /INSERT INTO orders/.test(s.sql))) return;
    raced = true;
    raw.exec("UPDATE merchant_delivery_profiles SET version = version + 1, default_fee_iqd = 6000 WHERE store_id = 's_ali'");
  };
  const p = await place(app, { idempotencyKey: 'race-fence-01', addressId: 'a_bag', quoteFingerprint: q.body.quote.quote_fingerprint });
  assert.equal(p.status, 409, JSON.stringify(p.body));
  assert.equal(p.body.code, 'QUOTE_CHANGED');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id = 'buyer' AND type = 'withdrawal'"), 0);
  assert.deepEqual(holds(raw, 'buyer').map((h) => h.state), ['released']);
});

test('a legacy address with no governorate is refused — ADDRESS_GOVERNORATE_REQUIRED, never the default fee — with the cart kept on screen', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app);
  const q = await quote(app, { addressId: 'a_old' });
  assert.equal(q.status, 409);
  assert.equal(q.body.code, 'ADDRESS_GOVERNORATE_REQUIRED');
  assert.equal(q.body.details.address_id, 'a_old');
  assert.equal(q.body.details.preview.lines.length, 1);
  assert.equal(q.body.details.preview.subtotal_iqd, 14_000);
  assert.ok(!('total_iqd' in q.body.details.preview) && !('quote_fingerprint' in q.body.details.preview), 'a preview is not an agreement');
  assert.equal(q.body.details.served.length, 17);
  const p = await place(app, { idempotencyKey: 'legacy-addr-1', addressId: 'a_old', quoteFingerprint: 'anything' });
  assert.equal(p.status, 409);
  assert.equal(p.body.code, 'ADDRESS_GOVERNORATE_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);
  // A legacy address holding the NAME is read by its id.
  assert.equal((await quote(app, { addressId: 'a_name' })).body.quote.delivery.governorate, 'erbil');
});

test('a disabled governorate is refused with the served list — and refused at place-order even when it was quoted earlier', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app);
  raw.exec("UPDATE addresses SET governorate = 'duhok' WHERE id = 'a_bas'");
  const q = await quote(app, { addressId: 'a_bas' });
  assert.equal(q.status, 409);
  assert.equal(q.body.code, 'DELIVERY_UNAVAILABLE');
  assert.equal(q.body.details.reason, 'governorate_disabled');
  assert.equal(q.body.details.served.includes('duhok'), false);
  assert.deepEqual(q.body.details.pickup, { governorate: 'baghdad', note: 'Karrada, call first' });

  // Quoted while Baghdad was served; the merchant switches Baghdad off; the tap is refused.
  const ok = await quote(app, { addressId: 'a_bag' });
  assert.equal(ok.status, 200);
  await configure(db, { ...ALI_CONFIG, rules: [{ governorate_id: 'baghdad', mode: 'disabled' }] });
  const p = await place(app, { idempotencyKey: 'disabled-late', addressId: 'a_bag', quoteFingerprint: ok.body.quote.quote_fingerprint });
  assert.equal(p.status, 409);
  assert.equal(p.body.code, 'DELIVERY_UNAVAILABLE');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);
});

test('no saved address at all: ADDRESS_REQUIRED with the preview; another customer’s address is not found', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  raw.exec("DELETE FROM addresses WHERE user_id = 'buyer'");
  const app = buyer(db);
  await add(app);
  const q = await quote(app);
  assert.equal(q.status, 409);
  assert.equal(q.body.code, 'ADDRESS_REQUIRED');
  assert.equal(q.body.details.preview.store_name, 'Ali 3D');
  const foreign = await quote(app, { addressId: 'a_other' });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'ADDRESS_NOT_FOUND');
  const bad = await quote(app, { addressId: 'a_bag', fulfilment: 'drone' });
  assert.equal(bad.body.code, 'FULFILMENT_INVALID');
});

test('replay is answered from the order as placed, unaffected by later edits; the same key with another agreement is spent', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app);
  const { q, p } = await quoteAndPlace(app, 'replay-key-001');
  assert.equal(p.status, 201);
  await configure(db, { ...ALI_CONFIG, rules: [{ governorate_id: 'baghdad', mode: 'fee', fee_iqd: 9999 }] });
  raw.exec("UPDATE community_products SET price_iqd = 99000 WHERE id = 'cp_ali'");

  const replay = await place(app, { idempotencyKey: 'replay-key-001', addressId: 'a_bag', quoteFingerprint: q.quote_fingerprint });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.order.id, p.body.order.id);
  assert.equal(replay.body.order.total_iqd, 17_000, 'the order as it was placed');
  assert.equal(replay.body.order.shipping_iqd, 3000);

  const reused = await place(app, { idempotencyKey: 'replay-key-001', addressId: 'a_bas', quoteFingerprint: 'another-agreement' });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 1);
  await Promise.allSettled(pending);
});

test('free delivery over the threshold is judged on the goods AFTER the merchant’s coupon', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db, { ...ALI_CONFIG, profile: { ...ALI_CONFIG.profile, free_over_iqd: 28_000 } });
  raw.exec(`INSERT INTO merchant_coupons (id,store_id,merchant_id,code,kind,value,max_uses,used_count) VALUES ('mc1','s_ali','m_ali','HALF','percent',50,NULL,0)`);
  const app = buyer(db);
  await add(app, 'cp_ali', 2); // 28,000 of goods
  const full = (await quote(app, { addressId: 'a_bas' })).body.quote;
  assert.deepEqual([full.delivery.rule, full.delivery_iqd, full.total_iqd], ['free_over', 0, 28_000]);
  const coupon = (await quote(app, { addressId: 'a_bas', couponCode: 'HALF' })).body.quote;
  assert.deepEqual([coupon.discount_iqd, coupon.delivery.rule, coupon.delivery_iqd, coupon.total_iqd], [14_000, 'default', 5000, 19_000]);
  const p = await place(app, { idempotencyKey: 'threshold-001', addressId: 'a_bas', couponCode: 'HALF', quoteFingerprint: coupon.quote_fingerprint });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(orderRow(raw)!.delivery_rule, 'default');
  await Promise.allSettled(pending);
});

test('pickup: offered → free, recorded as merchant_pickup even with a legacy address; not offered → refused', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const app = buyer(db);
  await add(app, 'cp_slow');
  const q = await quote(app, { addressId: 'a_old', fulfilment: 'pickup' });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.deepEqual(
    [q.body.quote.delivery.rule, q.body.quote.delivery_iqd, q.body.quote.delivery.governorate, q.body.quote.delivery.prep_days, q.body.quote.delivery.note],
    ['pickup', 0, 'baghdad', 5, 'Karrada, call first'],
    'the longer of the store’s and the product’s own preparation days'
  );
  const p = await place(app, { idempotencyKey: 'pickup-00001', addressId: 'a_old', fulfilment: 'pickup', quoteFingerprint: q.body.quote.quote_fingerprint });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const o = orderRow(raw)!;
  assert.deepEqual([o.delivery_method_id, o.delivery_rule, o.delivery_governorate, o.shipping_iqd, o.payment_method_id], ['merchant_pickup', 'pickup', 'baghdad', 0, 'wallet']);
  // Switching fulfilment is a new agreement.
  await add(app, 'cp_ali');
  const qd = await quote(app, { addressId: 'a_bag', fulfilment: 'delivery' });
  const cross = await place(app, { idempotencyKey: 'pickup-00002', addressId: 'a_bag', fulfilment: 'pickup', quoteFingerprint: qd.body.quote.quote_fingerprint });
  assert.equal(cross.body.code, 'QUOTE_CHANGED');

  await configure(db, { ...ALI_CONFIG, profile: { ...ALI_CONFIG.profile, pickup_enabled: false, pickup_governorate: '' } });
  const off = await quote(app, { addressId: 'a_bag', fulfilment: 'pickup' });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, 'DELIVERY_UNAVAILABLE');
  assert.equal(off.body.details.reason, 'pickup_disabled');
  await Promise.allSettled(pending);
});

test('a store never configured is priced from its legacy JSON (version 0), exactly as before', async () => {
  const raw = freshDb();
  seed(raw, { aliDelivery: '{"fee_iqd":4000,"free_over_iqd":20000}' });
  const app = buyer(asD1(raw));
  await add(app);
  const q = (await quote(app, { addressId: 'a_bas' })).body.quote;
  assert.deepEqual([q.delivery.rule, q.delivery_iqd, q.delivery.free_over_iqd], ['default', 4000, 20_000]);
  const p = await place(app, { idempotencyKey: 'legacy-json-1', addressId: 'a_bas', quoteFingerprint: q.quote_fingerprint });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(JSON.parse(String(orderRow(raw)!.delivery_method_snapshot)).profile_source, 'legacy');
  await Promise.allSettled(pending);
});

test('cross-merchant isolation: one store’s rules never price another store’s cart, and a merchant edits only their own', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db); // Ali: Baghdad 3,000
  await configure(db, { profile: { default_mode: 'fee', default_fee_iqd: 11_000 }, rules: [{ governorate_id: 'baghdad', mode: 'disabled' }, { governorate_id: 'basra', mode: 'fee', fee_iqd: 2000 }] }, 'zain');
  const app = buyer(db);
  await add(app, 'cp_zain');
  assert.equal((await quote(app, { addressId: 'a_bag' })).body.code, 'DELIVERY_UNAVAILABLE', 'Zain does not deliver to Baghdad whatever Ali does');
  assert.equal((await quote(app, { addressId: 'a_bas' })).body.quote.delivery_iqd, 2000);
  assert.equal((await quote(app, { addressId: 'a_name' })).body.quote.delivery_iqd, 11_000, 'Ali’s free Erbil is Ali’s');

  // The merchant API resolves the store from the session: there is no store id to swap.
  const z = await json(await get(merchant(db, 'zain'), '/api/merchant/delivery'));
  assert.equal(z.profile.default_fee_iqd, 11_000);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_delivery_rules WHERE store_id = 's_ali'"), 3);
  const sneaky = await put(merchant(db, 'zain'), '/api/merchant/delivery', { version: z.profile.version, store_id: 's_ali', ...ALI_CONFIG });
  assert.equal(sneaky.status, 200);
  assert.equal(row<{ default_fee_iqd: number }>(raw, "SELECT default_fee_iqd FROM merchant_delivery_profiles WHERE store_id = 's_ali'")!.default_fee_iqd, 5000);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_delivery_rules WHERE store_id = 's_ali'"), 3, 'Ali untouched');
  assert.equal((await get(merchant(db, 'buyer'), '/api/merchant/delivery')).status, 404, 'no store, no delivery');
});

// ================================================================= the merchant

test('GET/PUT /api/merchant/delivery: versioned, audited, mirrored to the legacy JSON, and every figure validated', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const m = merchant(db);
  const first = await json(await get(m, '/api/merchant/delivery'));
  // The backfill does not see stores inserted after migrations, so this one reads its legacy JSON.
  assert.deepEqual([first.configured, first.profile.version, first.profile.default_fee_iqd, first.coverage.serviceable], [false, 0, 5000, true]);

  const saved = await configure(db);
  assert.deepEqual([saved.configured, saved.profile.version, saved.rules.length, saved.coverage.served.length], [true, 1, 3, 17]);
  assert.deepEqual(JSON.parse(row<{ d: string }>(raw, "SELECT delivery_settings d FROM merchant_stores WHERE id='s_ali'")!.d), {
    fee_iqd: 5000, free_over_iqd: 50_000, note: 'Delivered by our own courier',
  });
  const audit = row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'merchant.delivery_updated'")!;
  assert.match(audit.detail, /"version":1/);
  assert.match(audit.detail, /baghdad:fee:3000/);

  // A stale editor (another tab saved in between) is a conflict with the fresh config — nothing written.
  const stale = await put(m, '/api/merchant/delivery', { version: 0, ...ALI_CONFIG, profile: { ...ALI_CONFIG.profile, default_fee_iqd: 1 } });
  const staleBody = await json(stale);
  assert.equal(stale.status, 409);
  assert.equal(staleBody.code, 'DELIVERY_VERSION_CONFLICT');
  assert.equal(staleBody.details.config.profile.version, 1);
  assert.equal(row<{ v: number }>(raw, "SELECT default_fee_iqd v FROM merchant_delivery_profiles WHERE store_id='s_ali'")!.v, 5000);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'merchant.delivery_updated'"), 1);

  // Strict: a fee as text, an unknown governorate, a fraction — refused with paths.
  const invalid = await put(m, '/api/merchant/delivery', {
    version: 1,
    profile: { default_mode: 'fee', default_fee_iqd: '5000' },
    rules: [{ governorate_id: 'Baghdad', mode: 'free' }, { governorate_id: 'basra', mode: 'fee', fee_iqd: 1.5 }],
  });
  const invalidBody = await json(invalid);
  assert.equal(invalid.status, 400);
  assert.equal(invalidBody.code, 'DELIVERY_INVALID');
  assert.deepEqual(
    invalidBody.details.issues.map((i: { path: string; code: string }) => `${i.path}:${i.code}`),
    ['profile.default_fee_iqd:not_integer', 'rules[0].governorate_id:governorate_unknown', 'rules.basra.fee_iqd:not_integer']
  );
  assert.equal((await json(await put(m, '/api/merchant/delivery', { profile: ALI_CONFIG.profile }))).code, 'DELIVERY_INVALID', 'no version, no save');
});

test('an OPEN store must deliver somewhere or offer pickup; a paused one may save anything, but cannot re-open so', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const m = merchant(db);
  const nowhere = { profile: { default_mode: 'disabled', default_fee_iqd: 0 }, rules: [] };
  const refused = await put(m, '/api/merchant/delivery', { version: 0, ...nowhere });
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'DELIVERY_NO_COVERAGE');
  // Pickup alone is coverage.
  assert.equal((await put(m, '/api/merchant/delivery', { version: 0, profile: { ...nowhere.profile, pickup_enabled: true, pickup_governorate: 'baghdad' } })).status, 200);

  assert.equal((await patch(m, '/api/merchant/store', { open: false })).status, 200);
  assert.equal((await put(m, '/api/merchant/delivery', { version: 1, ...nowhere })).status, 200, 'a paused store is being set up');
  const reopen = await patch(m, '/api/merchant/store', { open: true });
  assert.equal(reopen.status, 409);
  assert.equal((await json(reopen)).code, 'DELIVERY_NO_COVERAGE');
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM merchant_stores WHERE id='s_ali'")!.status, 'paused');
  await configure(db);
  assert.equal((await patch(m, '/api/merchant/store', { open: true })).status, 200);
});

test('the wave-1 PATCH door: an unchanged echo moves nothing; a real edit reaches the profile and bumps its version', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const m = merchant(db);
  await configure(db, { ...ALI_CONFIG, profile: { ...ALI_CONFIG.profile, default_mode: 'disabled' } });
  const version = () => row<{ v: number; fee: number; mode: string }>(raw, "SELECT version v, default_fee_iqd fee, default_mode mode FROM merchant_delivery_profiles WHERE store_id='s_ali'")!;
  // A cached form re-sends what it loaded (the mirror) with an unrelated edit.
  const echo = await patch(m, '/api/merchant/store', { name: 'Ali 3D Studio', delivery_settings: { fee_iqd: 5000, free_over_iqd: 50_000, note: 'Delivered by our own courier' } });
  assert.equal(echo.status, 200);
  assert.deepEqual({ ...version() }, { v: 1, fee: 5000, mode: 'disabled' });
  // A real edit of the fee.
  assert.equal((await patch(m, '/api/merchant/store', { delivery_settings: { fee_iqd: 6500, free_over_iqd: 50_000, note: 'Delivered by our own courier' } })).status, 200);
  assert.deepEqual({ ...version() }, { v: 2, fee: 6500, mode: 'disabled' }, 'a disabled default stays disabled');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_delivery_rules WHERE store_id='s_ali'"), 3, 'rules untouched');
});

// ================================================================== the public

test('GET /api/storefront/:slug/delivery: fees and availability only; the viewer’s own governorate without a query', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const byQuery = await json(await get(guest(db), '/api/storefront/ali3d/delivery?governorate=duhok'));
  assert.equal(byQuery.delivery.source, 'query');
  assert.equal(byQuery.delivery.quote.available, false);
  assert.equal(byQuery.delivery.areas.length, 17);
  assert.ok(!('version' in byQuery.delivery) && !('rules' in byQuery.delivery), 'no editor state');
  const guestOwn = await json(await get(guest(db), '/api/storefront/ali3d/delivery'));
  assert.equal(guestOwn.delivery.quote, null);
  const mine = await json(await get(buyer(db), '/api/storefront/ali3d/delivery'));
  assert.deepEqual([mine.delivery.source, mine.delivery.governorate, mine.delivery.quote.fee_iqd, mine.delivery.quote.free_over_iqd], ['address', 'baghdad', 3000, 50_000]);
  const bad = await get(guest(db), '/api/storefront/ali3d/delivery?governorate=atlantis');
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'GOVERNORATE_INVALID');
});

test('the store payload carries the delivery summary, and «delivery to you» only for the signed-in viewer', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await configure(db);
  const signed = (await json(await get(buyer(db), '/api/storefront/ali3d'))).store;
  assert.deepEqual(signed.delivery_to_you, {
    governorate: 'baghdad', available: true, reason: null, fee_iqd: 3000, free: false, free_over_iqd: 50_000, prep_days: 1, eta_note: 'Same day',
  });
  assert.equal(signed.delivery.areas.find((a: { governorate: string }) => a.governorate === 'erbil').free, true);
  assert.deepEqual(signed.delivery_settings, { note: 'Delivered by our own courier' });
  const anon = (await json(await get(guest(db), '/api/storefront/ali3d'))).store;
  assert.equal(anon.delivery_to_you, null);
  const product = (await json(await get(buyer(db), '/api/storefront/ali3d/products/ali-spool'))).store;
  assert.equal(product.delivery_to_you.fee_iqd, 3000);
});
