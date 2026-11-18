/**
 * «حد الفلامنت الشهري» (owner 2026-11-19; migration 0245, worker/lib/filamentLimits.ts):
 * the pure rule, the phone key and its SQL twin (the backfill), and the order door,
 * the quote and the cart refusing FILAMENT_LIMIT — pooled by account and delivery phone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, json, row } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { acceptedPolicies } from './lib/policies';
import {
  FILAMENT_LIMITS_DEFAULT,
  PHONE_DIGITS_SQL,
  PHONE_KEY_SQL,
  SNAPSHOT_PHONE_SQL,
  evaluateFilamentLimits,
  filamentTierKey,
  nextFilamentTier,
  normalizeFilamentLimits,
  phoneKey,
  requestedByProduct,
  validateFilamentLimits,
} from '../worker/lib/filamentLimits';
import { filamentLimitRefusal } from '../src/lib/refusalStrings';

const NAME = { ar: 'PLA مطفي', en: 'PLA Matte', ckb: 'PLA ماتی' };

// ------------------------------------------------------------------ pure rule

test('the limit per plan: none 50, PLUS 100, PREMIUM 250, PRO unlimited; inactive reads as none', () => {
  const cfg = FILAMENT_LIMITS_DEFAULT;
  assert.equal(filamentTierKey({ tier: 'plus', active: false }), 'none');
  assert.equal(filamentTierKey({ tier: 'free', active: true }), 'none');
  assert.equal(filamentTierKey({ tier: 'prime', active: true }), 'prime');
  const judge = (tier: 'none' | 'plus' | 'prime' | 'pro', used: number, qty: number) =>
    evaluateFilamentLimits({
      config: cfg,
      tier,
      requested: new Map([['p', qty]]),
      filament: new Map([['p', NAME]]),
      used: new Map([['p', used]]),
    });
  assert.equal(judge('none', 40, 10).over.length, 0, 'exactly 50 is allowed');
  const over = judge('none', 40, 11);
  assert.equal(over.over.length, 1);
  assert.deepEqual({ limit: over.over[0].limit, used: over.over[0].used, remaining: over.over[0].remaining }, { limit: 50, used: 40, remaining: 10 });
  assert.deepEqual(over.next_tier, { tier: 'plus', limit: 100 });
  assert.equal(judge('plus', 95, 6).over.length, 1);
  assert.deepEqual(judge('plus', 0, 1).next_tier, { tier: 'prime', limit: 250 });
  assert.equal(judge('prime', 249, 2).over[0].remaining, 1);
  assert.deepEqual(judge('prime', 0, 1).next_tier, { tier: 'pro', limit: null });
  assert.equal(judge('pro', 10_000, 10_000).over.length, 0, 'PRO is unlimited');
  assert.equal(judge('none', 500, 1).over[0].remaining, 0, 'remaining never goes below 0');
});

test('a product that is not filament is never limited; two colours of one kind are one kind', () => {
  const requested = requestedByProduct([
    { product_id: 'pla', qty: 30 },
    { product_id: 'pla', qty: 25 },
    { product_id: 'nozzle', qty: 999 },
  ]);
  assert.equal(requested.get('pla'), 55);
  const v = evaluateFilamentLimits({ config: FILAMENT_LIMITS_DEFAULT, tier: 'none', requested, filament: new Map([['pla', NAME]]), used: new Map() });
  assert.deepEqual(v.over.map((p) => p.product_id), ['pla']);
  assert.equal(v.products.length, 1);
});

test('switched off, nothing is over; the config normalises field by field and the validator is strict', () => {
  const off = normalizeFilamentLimits({ enabled: false });
  const v = evaluateFilamentLimits({ config: off, tier: 'none', requested: new Map([['p', 1000]]), filament: new Map([['p', NAME]]), used: new Map() });
  assert.equal(v.over.length, 0);
  assert.deepEqual(normalizeFilamentLimits({ per_tier: { none: 'x', plus: 120, pro: 5 } }).per_tier, { none: 50, plus: 120, prime: 250, pro: 5 });
  assert.equal(normalizeFilamentLimits({ window_days: 0 }).window_days, 30);
  assert.equal(validateFilamentLimits({ enabled: true, window_days: 30, per_tier: { none: -1, plus: 1, prime: 1, pro: null } }).ok, false);
  assert.equal(validateFilamentLimits({ enabled: true, window_days: 30, per_tier: { none: 60, plus: 120, prime: 300, pro: null } }).ok, true);
  assert.equal(nextFilamentTier(normalizeFilamentLimits({ per_tier: { none: 50, plus: 50, prime: 250, pro: null } }), 'none')?.tier, 'prime', 'a plan that does not raise it is skipped');
});

// ------------------------------------------------------------------ phone key

const IRAQI_SAME = ['+9647701234567', '+964 770 123 4567', '07701234567', '0770-123-4567', '7701234567', '009647701234567', '٠٧٧٠١٢٣٤٥٦٧', '۰۷۷۰۱۲۳۴۵۶۷', '(0770) 123.4567', '‎+964 770 123 4567'];

test('the phone key: every Iraqi shape of one number is one key', () => {
  for (const p of IRAQI_SAME) assert.equal(phoneKey(p), '7701234567', p);
  assert.equal(phoneKey('07801234567'), '7801234567');
  assert.equal(phoneKey(''), null);
  assert.equal(phoneKey('12345'), null, 'too short');
  assert.equal(phoneKey('0770abc4567'), null, 'letters are no phone');
  assert.equal(phoneKey(null), null);
  assert.equal(phoneKey(7701234567), '7701234567');
});

test('the SQL rule (the 0245 backfill) equals phoneKey, and the migration carries exactly that SQL', () => {
  const db = new DatabaseSync(':memory:');
  const cases: unknown[] = [...IRAQI_SAME, '07801234567', '', '12345', '0770abc4567', '+1 (415) 555-0100', '\t0770 123 4567', null];
  // `?1` is one parameter however often the expression names it.
  const stmt = db.prepare(`SELECT ${PHONE_KEY_SQL(`(${PHONE_DIGITS_SQL('?1')})`)} AS k`);
  for (const raw of cases) {
    const got = (stmt.get(raw as string | null) as { k: string | null }).k;
    assert.equal(got, phoneKey(raw), JSON.stringify(raw));
  }

  const sql = readFileSync(`${ROOT}/migrations/0245_filament_limits.sql`, 'utf8');
  assert.ok(sql.includes(PHONE_DIGITS_SQL(SNAPSHOT_PHONE_SQL)), 'step 1 is PHONE_DIGITS_SQL over the snapshot phone');
  assert.ok(sql.includes(PHONE_KEY_SQL('delivery_phone_key')), 'step 2 is PHONE_KEY_SQL');
  assert.ok(sql.includes('-- PRO plan section (added by the subscriptions session)'));

  // The migration's own two UPDATEs over real snapshots.
  db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, address_snapshot TEXT, delivery_phone_key TEXT)`);
  const snapshots: Array<[string, string | null]> = [
    ['a', JSON.stringify({ phone: '+9647701234567' })],
    ['b', JSON.stringify({ phone: '0770 123 4567' })],
    ['c', JSON.stringify({ phone: '٠٧٧٠١٢٣٤٥٦٧' })],
    ['d', JSON.stringify({ name: 'no phone' })],
    ['e', 'not json'],
    ['f', null],
    ['g', JSON.stringify({ phone: 7701234567 })],
  ];
  for (const [id, snap] of snapshots) db.prepare('INSERT INTO orders (id, address_snapshot) VALUES (?, ?)').run(id, snap);
  for (const update of sql.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => /^UPDATE orders/.test(s))) db.exec(update);
  const keys = Object.fromEntries((db.prepare('SELECT id, delivery_phone_key AS k FROM orders').all() as Array<{ id: string; k: string | null }>).map((r) => [r.id, r.k]));
  assert.deepEqual(keys, { a: '7701234567', b: '7701234567', c: '7701234567', d: null, e: null, f: null, g: '7701234567' });
});

test('the customer sentence names the limit, what is left and the plan that raises it, in three languages', () => {
  const err = {
    code: 'FILAMENT_LIMIT',
    details: { window_days: 30, next_tier: { tier: 'plus', limit: 100 }, products: [{ name: NAME, limit: 50, used: 38, requested: 20, remaining: 12 }] },
  };
  assert.equal(filamentLimitRefusal(err, 'ar'), 'الحد الأقصى لـ«PLA مطفي» 50 قطعة كل 30 يومًا — بقي لك 12. اشترك في PLUS لترفعه إلى 100.');
  assert.match(filamentLimitRefusal(err, 'en')!, /PLA Matte.*50 pieces every 30 days.*12 left\. Join PLUS to raise it to 100\./);
  assert.match(filamentLimitRefusal(err, 'ckb')!, /PLA ماتی.*PLUS/);
  assert.equal(filamentLimitRefusal({ code: 'OUT_OF_STOCK' }, 'ar'), null);
});

// ------------------------------------------------------------- through the doors

function world(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('twin','Sara again','s2@x.co','h','customer'),
      ('other','Ali','a@x.co','h','customer'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_twin','twin','Home','Sara','0770 123 4567','Baghdad, Karrada 12','',1),
      ('addr_other','other','Home','Ali','07809998877','Basra','',1),
      ('addr_boss','boss','Home','Boss','07801112233','Erbil','',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id) VALUES
      ('p_pla','pla-matte','PLA Matte','PLA مطفي',1000,'active',1000,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cat_materials','cat_materials_fdm'),
      ('p_basic','pla-basic','PLA Basic','PLA أساسي',1000,'active',1000,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cat_materials','cat_materials_fdm'),
      ('p_nozzle','nozzle','Hardened nozzle','فوهة مقساة',1000,'active',1000,'[]','[]','direct_sale','["direct_sale"]','[]','[]',NULL,NULL);
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_pla','cat_materials_fdm',0), ('p_basic','cat_materials_fdm',1);
  `);
  return raw;
}

let line = 0;
const cart = (raw: DatabaseSync, user: string, productId: string, qty: number) =>
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES (?,?,?,'','[]','','','','',?)`
    )
    .run(`ci_fl_${++line}`, user, productId, qty);

const ADDR: Record<string, string> = { buyer: 'addr', twin: 'addr_twin', other: 'addr_other', boss: 'addr_boss' };
const appFor = (raw: DatabaseSync, user: string) =>
  stubApp(asD1(raw), { id: user, role: user === 'boss' ? 'admin' : 'customer', email: `${user}@x.co` }, (a) => {
    a.route('/api/orders', orderRoutes);
    a.route('/api/cart', cartRoutes);
  });

let key = 0;
const body = (user: string) => ({
  addressId: ADDR[user],
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `filament-limit-${++key}`,
  policyAcceptance: acceptedPolicies(),
});

const place = async (raw: DatabaseSync, user: string) => json(await post(appFor(raw, user), '/api/orders', body(user)));

test('the order door: 45 then 10 of one kind is refused (FILAMENT_LIMIT, nothing written), 5 passes, another kind has its own limit', async () => {
  const raw = world();
  cart(raw, 'buyer', 'p_pla', 45);
  const first = await place(raw, 'buyer');
  assert.equal(first.success, true, JSON.stringify(first));
  const placed = row<{ delivery_phone_key: string }>(raw, "SELECT delivery_phone_key FROM orders WHERE user_id = 'buyer'")!;
  assert.equal(placed.delivery_phone_key, '7701234567', 'the order carries the delivery phone key');

  cart(raw, 'buyer', 'p_pla', 10);
  const quote = await json(await post(appFor(raw, 'buyer'), '/api/orders/quote', body('buyer')));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.ok(quote.quote.blockers.includes('FILAMENT_LIMIT'));
  assert.equal(quote.quote.can_checkout, false);
  assert.equal(quote.quote.filament_limit.products[0].remaining, 5);

  const refused = await place(raw, 'buyer');
  assert.equal(refused.success, false);
  assert.equal(refused.code ?? refused.error?.code, 'FILAMENT_LIMIT', JSON.stringify(refused));
  const details = refused.details ?? refused.error?.details;
  assert.deepEqual(
    { limit: details.products[0].limit, used: details.products[0].used, remaining: details.products[0].remaining, tier: details.tier, next: details.next_tier },
    { limit: 50, used: 45, remaining: 5, tier: 'none', next: { tier: 'plus', limit: 100 } }
  );
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'buyer'")!.n, 1, 'nothing written');

  raw.exec(`UPDATE cart_items SET qty = 5 WHERE user_id = 'buyer' AND product_id = 'p_pla'`);
  cart(raw, 'buyer', 'p_basic', 50);
  cart(raw, 'buyer', 'p_nozzle', 200);
  const ok = await place(raw, 'buyer');
  assert.equal(ok.success, true, JSON.stringify(ok));
});

test('a second account with the same delivery phone pools; another phone does not; a cancelled order frees its units; an admin is not limited', async () => {
  const raw = world();
  cart(raw, 'buyer', 'p_pla', 48);
  assert.equal((await place(raw, 'buyer')).success, true);

  cart(raw, 'twin', 'p_pla', 3);
  const fresh = await json(await post(appFor(raw, 'twin'), '/api/orders/quote', body('twin')));
  assert.ok(fresh.quote.blockers.includes('FILAMENT_LIMIT'), "a fresh PENDING order of another account to the same phone pools (two accounts racing unconfirmed orders)");

  const stale = new Date(Date.now() - 4 * 86_400_000).toISOString();
  raw.exec(`UPDATE orders SET created_at = '${stale}' WHERE user_id = 'buyer'`);
  const old = await json(await post(appFor(raw, 'twin'), '/api/orders/quote', body('twin')));
  assert.equal(old.quote.filament_limit, null, "another account's pending order older than 3 days no longer pools (nobody can use up a stranger's limit for long)");

  raw.exec(`UPDATE orders SET status = 'confirmed' WHERE user_id = 'buyer'`);
  const twin = await place(raw, 'twin');
  assert.equal(twin.code ?? twin.error?.code, 'FILAMENT_LIMIT', 'once confirmed, the same phone in another format pools with the first account for the whole window');

  cart(raw, 'other', 'p_pla', 50);
  assert.equal((await place(raw, 'other')).success, true, 'another phone has its own 50');

  raw.exec(`UPDATE orders SET status = 'cancelled' WHERE user_id = 'buyer'`);
  const again = await place(raw, 'twin');
  assert.equal(again.success, true, JSON.stringify(again));

  cart(raw, 'boss', 'p_pla', 300);
  assert.equal((await place(raw, 'boss')).success, true, 'an admin account is not limited');
});

test('the cart refuses an add or a quantity that would pass the limit with the account history', async () => {
  const raw = world();
  cart(raw, 'buyer', 'p_pla', 40);
  assert.equal((await place(raw, 'buyer')).success, true);
  const app = appFor(raw, 'buyer');
  const add = await json(await post(app, '/api/cart/items', { productId: 'p_pla', qty: 11 }));
  assert.equal(add.code ?? add.error?.code, 'FILAMENT_LIMIT', JSON.stringify(add));
  const fine = await json(await post(app, '/api/cart/items', { productId: 'p_pla', qty: 10 }));
  assert.equal(fine.success, true, JSON.stringify(fine));
  const more = await json(await post(app, '/api/cart/items', { productId: 'p_pla', qty: 1 }));
  assert.equal(more.code ?? more.error?.code, 'FILAMENT_LIMIT', 'the cart line counts toward the limit');
  const nozzle = await json(await post(app, '/api/cart/items', { productId: 'p_nozzle', qty: 500 }));
  assert.equal(nozzle.success, true, 'not filament');
});
