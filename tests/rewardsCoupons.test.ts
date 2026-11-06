/**
 * THE PRINTER'S REWARD COUPONS, THROUGH THE REAL CHECKOUT (owner, 2026-11-03;
 * migration 0220; docs/DECISIONS.md row 286).
 *
 *   «1 coupon free shipping for every printer on 1 week and 1 coupon
 *    discounted on selected filament also for every printer on 1 week.»
 *
 * The owner's answers: 15% off one piece of the selected filaments, at most
 * 25,000 IQD; 5,000 IQD off the delivery on an order over 100,000 IQD (2026-11-05,
 * row 295; tests/rewardsWeekly.test.ts has the weeks and the pool); issued when
 * the printer is DELIVERED; one pair per printer unit; seven days.
 *
 * Real migrations, real triggers, the real cart and checkout routers; only the
 * session is stubbed. Issuing goes through `runOrderDeliveredEffects`, the one
 * function every delivered door calls.
 *
 * Run: node --import tsx --test tests/rewardsCoupons.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, get, row, send, stubApp, type Mount } from './fixtures/app';
import { BUYER, BOSS, apps, giftWorld, json, paidLine, placeOrder, post, quoteBody, type J } from './fixtures/giftWorld';
import type { Env } from '../worker/lib/types';
import { runOrderDeliveredEffects } from '../worker/lib/orderDeliveredEffects';
import { issuePrinterRewards, listUserRewardCoupons, revokeRewardsForReturn } from '../worker/lib/rewards/coupons';
import { REWARD_CONFIG_KEY } from '../worker/lib/rewards/config';
import { runRewardSweep } from '../worker/lib/rewards/sweep';
import { rewardProgramRoutes } from '../worker/routes/rewardsProgram';
import { adminRewardsRoutes } from '../worker/routes/adminRewards';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';

const DAY = 86_400_000;
const envOf = (raw: DatabaseSync) => ({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' }) as unknown as Env;

/**
 * The gift world, plus a printer (in a catalog flagged as a printer catalog)
 * and a filament: `p_plain` filed under the FDM filament section.
 */
function world(): DatabaseSync {
  const raw = giftWorld();
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,name_ckb,is_printer_catalog)
      VALUES ('rw_printers',NULL,'rw-printers','طابعات','Printers','چاپکەرەکان',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_printer','reward-printer','A1 mini','طابعة A1 mini','چاپکەری A1 mini',200000,'active',6,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','rw_printers',0);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_tool','reward-tool','Scraper','مكشطة','کەرەستەی پاککردنەوە',10000,'active',9,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE');
    UPDATE products SET category_id = 'cat_materials_fdm' WHERE id = 'p_plain';
  `);
  return raw;
}

const mountRewards: Mount = (a) => {
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/rewards/program', rewardProgramRoutes);
  a.route('/api/admin/rewards', adminRewardsRoutes);
  a.route('/api/admin', adminRoutes);
};
const rewardsApp = (raw: DatabaseSync, user = BUYER) => stubApp(asD1(raw), user, mountRewards, { publishV2: 'always' });

/** A printer order placed through the real checkout, then delivered through the real hook. */
async function deliveredPrinterOrder(raw: DatabaseSync, qty = 2): Promise<string> {
  const a = apps(raw);
  paidLine(raw, `ci_pr_${qty}_${Date.now()}`, 'p_printer', { qty, fulfillmentType: 'direct_sale' });
  const order = await placeOrder(a.buyer, { deliveryMethodId: 'pickup', paymentMethodId: 'cash' });
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), order.id);
  await runOrderDeliveredEffects(envOf(raw), order.id);
  return order.id as string;
}

const grantsOf = (raw: DatabaseSync, orderId: string) =>
  all<{ id: string; kind: string; coupon_id: string; unit_index: number; source_ref: string; expires_at: string; issued_at: string; revoked_at: string | null; revoke_reason: string }>(
    raw,
    'SELECT * FROM reward_grants WHERE order_id = ? ORDER BY unit_index, kind',
    orderId
  );

const couponOf = (raw: DatabaseSync, id: string) => row<Record<string, unknown>>(raw, 'SELECT * FROM coupons WHERE id = ?', id)!;
const codeOf = (raw: DatabaseSync, orderId: string, kind: string) =>
  String(row<{ code: string }>(raw, "SELECT c.code FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id WHERE g.order_id = ? AND g.kind = ? AND g.unit_index = 1", orderId, kind)!.code);

// ------------------------------------------------------------------ issuing

test('a delivered printer order earns one free-delivery and one filament coupon PER PRINTER, personal, single use, seven days', async () => {
  const raw = world();
  const orderId = await deliveredPrinterOrder(raw, 2);

  const grants = grantsOf(raw, orderId);
  assert.equal(grants.length, 4, 'two printers × two coupons');
  assert.deepEqual(grants.map((g) => `${g.unit_index}:${g.kind}`), ['1:filament_discount', '1:free_shipping', '2:filament_discount', '2:free_shipping']);
  for (const g of grants) {
    assert.equal(Date.parse(g.expires_at) - Date.parse(g.issued_at), 7 * DAY, 'valid exactly seven days');
    const c = couponOf(raw, g.coupon_id);
    assert.equal(c.assigned_user_id, 'buyer', 'personal');
    assert.equal(c.max_global, 1);
    assert.equal(c.max_per_user, 1);
    assert.equal(c.active, 1);
    assert.equal(c.reward_grant_id, g.id);
    assert.equal(c.ends_at, g.expires_at);
    if (g.kind === 'free_shipping') {
      assert.match(String(c.code), /^RWS[A-Z2-9]{10}$/);
      assert.deepEqual(
        [c.kind, c.applies_to, c.value, c.min_total_iqd, c.scope, c.stacks],
        ['fixed_iqd', 'delivery', 5_000, 100_000, 'global', 1],
        '5,000 IQD off the delivery on an order over 100,000 IQD, nothing off the goods'
      );
    } else {
      assert.match(String(c.code), /^RWF[A-Z2-9]{10}$/);
      assert.deepEqual(
        [c.kind, c.applies_to, c.value, c.max_discount_iqd, c.max_quantity, c.scope, c.category_id, c.stacks],
        ['percent', 'merchandise', 15, 25_000, 1, 'category', 'cat_materials_fdm', 1],
        '15% of ONE PIECE of the FDM filaments, at most 25,000 IQD, on a line already on sale too (owner, 2026-11-06)'
      );
    }
  }

  const notes = all<{ kind: string; event_key: string; meta: string; link: string }>(raw, "SELECT * FROM user_notifications WHERE user_id = 'buyer' AND kind = 'reward'");
  assert.equal(notes.length, 1, 'one notice for the order, not one per coupon');
  assert.equal(notes[0].event_key, `reward:printer:${orderId}`);
  assert.equal(notes[0].link, '/rewards/coupons');
  const meta = JSON.parse(notes[0].meta);
  assert.ok(meta.title_ckb && meta.body_ckb, 'the Sorani rides in meta');
  assert.notEqual(meta.body_ckb, row<{ body_ar: string }>(raw, "SELECT body_ar FROM user_notifications WHERE user_id = 'buyer' AND kind = 'reward'")!.body_ar);
  assert.match(meta.body_ckb, /فیلامێنت/);
});

test('a replayed delivery — a second door, a walk-back and re-delivery, the sweep — issues nothing twice', async () => {
  const raw = world();
  const orderId = await deliveredPrinterOrder(raw, 1);
  assert.equal(grantsOf(raw, orderId).length, 2);
  const again = await issuePrinterRewards(envOf(raw), orderId);
  assert.deepEqual(again, { issued: 0, reason: 'already_issued' });
  raw.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(orderId);
  raw.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(orderId);
  await runOrderDeliveredEffects(envOf(raw), orderId);
  assert.equal(grantsOf(raw, orderId).length, 2, 'still one pair for the one printer');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'reward'"), 1);
});

test('what is not a printer earns nothing: a non-printer order, an undelivered order, a gift line, a store order, a switched-off programme', async () => {
  const raw = world();
  const a = apps(raw);
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });
  const plain = await placeOrder(a.buyer, { deliveryMethodId: 'pickup' });
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), plain.id);
  assert.deepEqual(await issuePrinterRewards(envOf(raw), plain.id), { issued: 0, reason: 'no_printer' });

  paidLine(raw, 'ci_pr_wait', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  const waiting = await placeOrder(a.buyer, { deliveryMethodId: 'pickup' });
  assert.deepEqual(await issuePrinterRewards(envOf(raw), waiting.id), { issued: 0, reason: 'not_delivered' });

  // A printer given as a gift (a gift line) is not a printer bought (S8).
  raw.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(waiting.id);
  raw.prepare('UPDATE order_items SET gift_entitlement_id = ? WHERE order_id = ?').run('ge_fake', waiting.id);
  assert.deepEqual(await issuePrinterRewards(envOf(raw), waiting.id), { issued: 0, reason: 'no_printer' });

  raw.prepare('UPDATE order_items SET gift_entitlement_id = NULL WHERE order_id = ?').run(waiting.id);
  raw.prepare("UPDATE orders SET seller_type = 'merchant' WHERE id = ?").run(waiting.id);
  assert.deepEqual(await issuePrinterRewards(envOf(raw), waiting.id), { issued: 0, reason: 'merchant_order' });

  raw.prepare("UPDATE orders SET seller_type = 'levonis' WHERE id = ?").run(waiting.id);
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(
    REWARD_CONFIG_KEY,
    JSON.stringify({ enabled: false })
  );
  assert.deepEqual(await issuePrinterRewards(envOf(raw), waiting.id), { issued: 0, reason: 'disabled' });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants'), 0);
});

test('the owner’s ticked filaments become the coupon’s list: only they are discounted, and an empty list never widens', async () => {
  const raw = world();
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(
    REWARD_CONFIG_KEY,
    JSON.stringify({ filament: { enabled: true, percent: 20, max_discount_iqd: null, product_ids: ['p_plain'] }, free_shipping: { enabled: false } })
  );
  const orderId = await deliveredPrinterOrder(raw, 1);
  const grants = grantsOf(raw, orderId);
  assert.deepEqual(grants.map((g) => g.kind), ['filament_discount'], 'free delivery switched off: the filament coupon alone');
  const c = couponOf(raw, grants[0].coupon_id);
  assert.deepEqual([c.scope, c.product_ids, c.category_id, c.value, c.max_discount_iqd], ['products', '["p_plain"]', null, 20, null]);
});

// ------------------------------------------------------------------ the checkout

test('the filament coupon applies at checkout to the selected filaments only, once, and only for its owner', async () => {
  const raw = world();
  const orderId = await deliveredPrinterOrder(raw, 1);
  const code = codeOf(raw, orderId, 'filament_discount');
  const a = apps(raw);

  paidLine(raw, 'ci_fil', 'p_plain', { qty: 2, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_other', 'p_tool', { qty: 1, fulfillmentType: 'direct_sale' });
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.equal(quote.quote.coupon.code, code);
  assert.equal(quote.quote.coupon.merchandise_iqd, 2_250, '15% of ONE of the 2 × 15,000 of filament — nothing off the other product');
  assert.equal(quote.quote.coupon.delivery_iqd ?? 0, 0);

  // Somebody else typing the same code meets a code that does not exist.
  paidLine(raw, 'ci_o_fil', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale', userId: 'other' });
  const stranger = await json(await post(a.other, '/api/orders/quote', quoteBody({ addressId: 'addr_o', couponCode: code })));
  assert.equal(stranger.success, false);
  assert.equal(stranger.code, 'CODE_NOT_FOUND');

  const order = await placeOrder(a.buyer, { couponCode: code });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ? AND state = 'active'", order.id), 1);
  const views = await listUserRewardCoupons(asD1(raw), 'buyer');
  const used = views.find((v) => v.code === code)!;
  assert.equal(used.state, 'used');
  assert.equal(used.used_on_order_id, order.id);

  // Single use: the next order cannot spend it again.
  paidLine(raw, 'ci_fil2', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });
  const again = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })));
  assert.equal(again.success, false);
  assert.match(String(again.code), /LIMIT/);
});

test('the free-delivery coupon takes up to its 5,000 IQD off the delivery of an order over 100,000 IQD, and nothing off the goods', async () => {
  const raw = world();
  const orderId = await deliveredPrinterOrder(raw, 1);
  const code = codeOf(raw, orderId, 'free_shipping');
  const a = apps(raw);
  paidLine(raw, 'ci_other', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  const plainQuote = await json(await post(a.buyer, '/api/orders/quote', quoteBody()));
  const fee = Number(plainQuote.quote.shipping.total_iqd);
  assert.ok(fee > 0, 'standard delivery costs something');
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.equal(quote.quote.coupon.delivery_iqd, Math.min(fee, 5_000), 'the delivery fee, up to the coupon’s 5,000 IQD');
  assert.equal(quote.quote.coupon.merchandise_iqd ?? 0, 0, 'nothing off the goods');

  // In the cart (no address yet) the code is valid and waits for the delivery.
  const cartCheck = await json(await post(a.buyer, '/api/cart/coupon-check', { code }));
  assert.equal(cartCheck.valid, true, JSON.stringify(cartCheck));
});

// ------------------------------------------------------------------ expiry

test('after seven days the coupon is refused at checkout and shows as expired', async () => {
  const raw = world();
  const orderId = await deliveredPrinterOrder(raw, 1);
  const code = codeOf(raw, orderId, 'filament_discount');
  const past = new Date(Date.now() - 60_000).toISOString();
  raw.prepare('UPDATE coupons SET ends_at = ? WHERE code = ?').run(past, code);
  const a = apps(raw);
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })));
  assert.equal(quote.success, false);
  assert.equal(quote.code, 'EXPIRED');
  const view = (await listUserRewardCoupons(asD1(raw), 'buyer')).find((v) => v.code === code)!;
  assert.equal(view.state, 'expired');
});

test('the 24-hour reminder: one notice per customer for coupons still unused, never twice', async () => {
  const raw = world();
  const orderId = await deliveredPrinterOrder(raw, 1);
  const soon = new Date(Date.now() + 6 * 3600_000).toISOString();
  raw.prepare('UPDATE coupons SET ends_at = ? WHERE reward_grant_id IN (SELECT id FROM reward_grants WHERE order_id = ?)').run(soon, orderId);
  raw.prepare('UPDATE reward_grants SET expires_at = ? WHERE order_id = ?').run(soon, orderId);
  const first = await runRewardSweep(envOf(raw));
  assert.deepEqual(first.reminders, { coupons: 2, customers: 1 });
  const notes = all<{ event_key: string; meta: string; link: string }>(raw, "SELECT event_key, meta, link FROM user_notifications WHERE user_id = 'buyer' AND event_key LIKE 'reward:expiring:%'");
  assert.equal(notes.length, 1);
  assert.ok(JSON.parse(notes[0].meta).body_ckb);
  assert.equal(notes[0].link, '/rewards/coupons', 'the reminder opens «كوبوناتي» itself (DECISIONS row 290)');
  const second = await runRewardSweep(envOf(raw));
  assert.deepEqual(second.reminders, { coupons: 0, customers: 0 }, 'reminded once');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants WHERE reminded_at IS NULL AND order_id = ?', orderId), 0);
});

test('the catch-up sweep issues what a failed delivery hook missed — never for an order delivered before 0220 arrived', async () => {
  const raw = world();
  raw.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const a = apps(raw);
  paidLine(raw, 'ci_pr_a', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  const before = await placeOrder(a.buyer, { deliveryMethodId: 'pickup' });
  paidLine(raw, 'ci_pr_b', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  const after = await placeOrder(a.buyer, { deliveryMethodId: 'pickup' });
  const launch = new Date(Date.now() - 3600_000);
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date(launch.getTime() - 60_000).toISOString(), before.id);
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), after.id);
  // Without the bookkeeping row the sweep cannot tell when the programme began: it issues nothing.
  assert.equal((await runRewardSweep(envOf(raw))).catch_up.scanned, 0);
  raw.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES ('0220_rewards_program.sql', ?)").run(launch.toISOString().replace('T', ' ').slice(0, 19));
  const out = await runRewardSweep(envOf(raw));
  assert.deepEqual(out.catch_up, { scanned: 1, issued: 2, errors: 0 });
  assert.equal(grantsOf(raw, before.id).length, 0, 'delivered before the programme: nothing after the fact');
  assert.equal(grantsOf(raw, after.id).length, 2);
});

// ------------------------------------------------------------------ withdrawal

test('a cancel by any door withdraws the printer’s unused coupons; a coupon already spent stays with its order; a reopen gives them back', async () => {
  const raw = world();
  const orderId = await deliveredPrinterOrder(raw, 1);
  const shipCode = codeOf(raw, orderId, 'free_shipping');
  const a = apps(raw);
  paidLine(raw, 'ci_other', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  const spent = await placeOrder(a.buyer, { couponCode: shipCode });

  raw.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(orderId);
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
  const g = grantsOf(raw, orderId);
  assert.ok(g.every((x) => x.revoke_reason === 'order_cancelled'));
  const states = Object.fromEntries((await listUserRewardCoupons(asD1(raw), 'buyer')).map((v) => [v.kind, v.state]));
  assert.deepEqual(states, { free_shipping: 'used', filament_discount: 'revoked' });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ? AND state = 'active'", spent.id), 1, 'the spending order keeps its discount');

  raw.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(orderId);
  const back = Object.fromEntries((await listUserRewardCoupons(asD1(raw), 'buyer')).map((v) => [v.kind, v.state]));
  assert.deepEqual(back, { free_shipping: 'used', filament_discount: 'active' }, 'the reopen restores what the cancel withdrew');
});

test('a returned printer takes back its coupons not yet used — up to the units returned, once per case', async () => {
  const raw = world();
  const orderId = await deliveredPrinterOrder(raw, 2);
  const a = apps(raw);
  // One piece of filament under the delivery coupon's minimum: one coupon of the four spends.
  paidLine(raw, 'ci_other', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });
  await placeOrder(a.buyer, { couponCode: codeOf(raw, orderId, 'filament_discount') });
  // The first printer's coupon is the one spent, every time: a random id used to decide, and this test failed about one run in two.
  const spent = row<{ unit_index: number }>(
    raw,
    "SELECT g.unit_index FROM reward_grants g JOIN coupon_redemptions r ON r.coupon_id = g.coupon_id AND r.state = 'active' WHERE g.user_id = 'buyer'"
  )!;
  assert.equal(spent.unit_index, 1);

  const item = row<{ id: string }>(raw, "SELECT id FROM order_items WHERE order_id = ? AND product_id = 'p_printer'", orderId)!;
  const out = await revokeRewardsForReturn(envOf(raw), { caseId: 'rc_1', orderItemId: item.id, qty: 1 });
  assert.equal(out.revoked, 2, 'one free-delivery coupon and one filament coupon go off with the one printer');
  const live = (await listUserRewardCoupons(asD1(raw), 'buyer')).reduce<Record<string, number>>((acc, v) => {
    acc[`${v.kind}:${v.state}`] = (acc[`${v.kind}:${v.state}`] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(live, { 'free_shipping:active': 1, 'free_shipping:revoked': 1, 'filament_discount:used': 1, 'filament_discount:revoked': 1 });
  assert.deepEqual(await revokeRewardsForReturn(envOf(raw), { caseId: 'rc_1', orderItemId: item.id, qty: 1 }), { revoked: 0 }, 'the same case twice withdraws nothing more');
});

// ------------------------------------------------------------------ the points shop

test('the points shop: a coupon for points in one batch; not enough points or a coupon still held moves nothing', async () => {
  const raw = world();
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(
    REWARD_CONFIG_KEY,
    JSON.stringify({ shop: { free_shipping: { enabled: true, points: 3000 }, filament_discount: { enabled: false, points: null } } })
  );
  const app = rewardsApp(raw);
  const poor = await post(app, '/api/rewards/program/shop/free_shipping');
  assert.equal(poor.status, 409);
  assert.equal((await json(poor)).code, 'INSUFFICIENT_POINTS');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupons WHERE reward_grant_id IS NOT NULL'), 0, 'a refusal writes no coupon');

  raw.exec("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts_b','buyer','deposit','POINT',5000,'approved')");
  const bought = await json(await post(app, '/api/rewards/program/shop/free_shipping'));
  assert.equal(bought.success, true, JSON.stringify(bought));
  assert.equal(bought.coupon.kind, 'free_shipping');
  assert.equal(bought.coupon.source, 'points_shop');
  assert.equal(bought.coupon.points_spent, 3000);
  assert.equal(
    row<{ n: number }>(raw, "SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) AS n FROM wallet_transactions WHERE user_id='buyer' AND currency='POINT' AND status='approved'")!.n,
    2000
  );
  const again = await post(app, '/api/rewards/program/shop/free_shipping');
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'REWARD_SHOP_HOLDING', 'one unused shop coupon of a kind at a time');
  const off = await post(app, '/api/rewards/program/shop/filament_discount');
  assert.equal((await json(off)).code, 'REWARD_SHOP_UNAVAILABLE');
});

test('the shop says what the swap would: held while a bought coupon is live and unused, free again once used or expired; short by the price less the balance', async () => {
  const raw = world();
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(
    REWARD_CONFIG_KEY,
    JSON.stringify({ shop: { free_shipping: { enabled: true, points: 3000 }, filament_discount: { enabled: true, points: 4000 } } })
  );
  const app = rewardsApp(raw);
  const hub = async () => json(await get(app, '/api/rewards/program'));
  const shopOf = async () => {
    const h = await hub();
    return { balance: h.point_balance as number, counts: h.coupon_counts, ...Object.fromEntries(h.shop.map((s: J) => [s.kind, s])) } as J;
  };
  const deposit = (id: string, n: number) =>
    raw.prepare("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES (?,'buyer','deposit','POINT',?,'approved')").run(id, n);

  let shop = await shopOf();
  assert.equal(shop.balance, 0);
  assert.deepEqual(shop.free_shipping, { kind: 'free_shipping', points: 3000, affordable: false, holding: false, points_short: 3000 });
  assert.deepEqual(shop.filament_discount, { kind: 'filament_discount', points: 4000, affordable: false, holding: false, points_short: 4000 });

  deposit('pts_1', 5000);
  shop = await shopOf();
  assert.deepEqual([shop.free_shipping.affordable, shop.free_shipping.points_short, shop.filament_discount.points_short], [true, 0, 0]);
  const bought = await json(await post(app, '/api/rewards/program/shop/free_shipping'));
  assert.equal(bought.success, true, JSON.stringify(bought));
  shop = await shopOf();
  assert.deepEqual(shop.free_shipping, { kind: 'free_shipping', points: 3000, affordable: false, holding: true, points_short: 1000 }, '2,000 left of 5,000');
  assert.deepEqual(shop.filament_discount, { kind: 'filament_discount', points: 4000, affordable: false, holding: false, points_short: 2000 }, 'one held per kind, not per shop');
  assert.deepEqual(shop.counts, { active: 1, past: 0 });
  deposit('pts_2', 4000);
  assert.equal((await json(await post(app, '/api/rewards/program/shop/free_shipping'))).code, 'REWARD_SHOP_HOLDING', 'the swap refuses what the page calls held');

  // Used on an order: no longer held, and the swap agrees.
  const a = apps(raw);
  paidLine(raw, 'ci_other', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  await placeOrder(a.buyer, { couponCode: bought.coupon.code });
  shop = await shopOf();
  assert.equal(shop.free_shipping.holding, false);
  assert.deepEqual(shop.counts, { active: 0, past: 1 });
  const again = await json(await post(app, '/api/rewards/program/shop/free_shipping'));
  assert.equal(again.success, true, JSON.stringify(again));
  assert.equal((await shopOf()).free_shipping.holding, true);

  // Expired unused: no longer held either.
  raw.prepare('UPDATE coupons SET ends_at = ? WHERE code = ?').run(new Date(Date.now() - 60_000).toISOString(), again.coupon.code);
  shop = await shopOf();
  assert.equal(shop.free_shipping.holding, false);
  assert.deepEqual(shop.counts, { active: 0, past: 2 });
  assert.equal((await json(await post(app, '/api/rewards/program/shop/free_shipping'))).success, true, 'and the swap sells one again');
});

// ------------------------------------------------------------------ the hub and the admin

test('GET /api/rewards/program: my coupons, the printer to rate, pending points and the programme’s terms', async () => {
  const raw = world();
  await deliveredPrinterOrder(raw, 1);
  const hub = await json(await get(rewardsApp(raw), '/api/rewards/program'));
  assert.equal(hub.success, true, JSON.stringify(hub));
  assert.equal(hub.installed, true);
  assert.equal(hub.coupons.length, 2);
  assert.ok(hub.coupons.every((c: J) => c.state === 'active'));
  assert.deepEqual(hub.printers.map((p: J) => [p.product_id, p.state]), [['p_printer', 'to_rate']]);
  assert.equal(hub.program.filament.percent, 15);
  assert.equal(hub.program.filament.section.id, 'cat_materials_fdm');
  assert.deepEqual(hub.shop, [], 'no price set: no shop');
  assert.ok(hub.pending_points.points >= 0);

  // DECISIONS row 290: what the rewards area reads instead of working it out.
  assert.deepEqual(hub.coupon_counts, { active: 2, past: 0 });
  const ship = hub.coupons.find((c: J) => c.kind === 'free_shipping');
  const fil = hub.coupons.find((c: J) => c.kind === 'filament_discount');
  assert.equal(ship.targets, null, 'free delivery goes on any order: nothing to choose');
  assert.deepEqual([fil.targets.products, fil.targets.products_total], [[], 0], 'nothing ticked: a section-wide coupon');
  const section = row<{ slug: string }>(raw, "SELECT slug FROM catalogs WHERE id = 'cat_materials_fdm'")!;
  assert.equal(fil.targets.section.id, 'cat_materials_fdm', 'its section, from its own category_id');
  assert.equal(fil.targets.section.slug, section.slug);
  assert.ok(fil.targets.section.path.startsWith('/categories/') && fil.targets.section.path.endsWith(`/${encodeURIComponent(section.slug)}`));
  assert.deepEqual(fil.targets.section, hub.program.filament.section, 'the same section read the programme states');
  assert.equal(hub.rating.no_level_points, null, 'review points not configured: nothing invented');

  raw.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('reviewPointsConfig', ?)").run(JSON.stringify({ enabled: true, points: 500 }));
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(
    REWARD_CONFIG_KEY,
    JSON.stringify({ shop: { free_shipping: { enabled: true, points: 3000 }, filament_discount: { enabled: false, points: null } } })
  );
  raw.exec("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts_hub','buyer','deposit','POINT',1200,'approved')");
  const priced = await json(await get(rewardsApp(raw), '/api/rewards/program'));
  assert.equal(priced.point_balance, 1200);
  assert.equal(priced.rating.review_points, 500);
  assert.equal(priced.rating.no_level_points, 1000, 'twice the base: the award path’s own rule (noLevelReviewPoints)');
  assert.deepEqual(priced.shop, [{ kind: 'free_shipping', points: 3000, affordable: false, holding: false, points_short: 1800 }]);
});

test('a filament coupon names what IT covers, frozen when issued: its products still on sale, twenty by name, all of them counted', async () => {
  const raw = world();
  const add = raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode,category_id)
     VALUES (?,?,?,?,?,15000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]',?,'BASE','cat_materials_fdm')`
  );
  const spools = Array.from({ length: 23 }, (_, i) => `p_spool_${String(i).padStart(2, '0')}`);
  spools.forEach((id, i) => add.run(id, `spool-${i}`, `Spool ${i}`, `بكرة ${i}`, `بکرە ${i}`, JSON.stringify([`/files/products/${id}.webp`, '/files/products/second.webp'])));
  const setFilaments = (product_ids: string[]) =>
    raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(
      REWARD_CONFIG_KEY,
      JSON.stringify({ free_shipping: { enabled: false }, filament: { enabled: true, percent: 15, max_discount_iqd: 25000, product_ids } })
    );

  // A: the owner ticks the nozzle cleaner and the 23 spools, and a printer is delivered.
  setFilaments(['p_plain', ...spools]);
  await deliveredPrinterOrder(raw, 1);
  // B: the owner unticks them all and ticks the scraper; two of the coupon’s own products leave the shop.
  setFilaments(['p_tool']);
  raw.prepare("UPDATE products SET status = 'draft' WHERE id IN (?, ?)").run(spools[0], spools[5]);

  const hub = await json(await get(rewardsApp(raw), '/api/rewards/program'));
  assert.equal(hub.success, true, JSON.stringify(hub));
  assert.equal(hub.coupons.length, 1, 'free delivery switched off: the filament coupon alone');
  const fil = hub.coupons[0];
  assert.equal(fil.scope, 'products');
  const onSale = ['p_plain', ...spools].filter((id) => id !== spools[0] && id !== spools[5]);
  assert.equal(fil.targets.products_total, 22, 'every product of its own list still on sale, counted');
  assert.deepEqual(fil.targets.products.map((p: J) => p.id), onSale.slice(0, 20), 'in its own order, the first twenty by name');
  assert.equal(fil.targets.section, null);
  assert.deepEqual(fil.targets.products[0], { id: 'p_plain', slug: 'nozzle-cleaner', name: { ar: 'منظف فوهات', en: 'Nozzle cleaner', ckb: 'پاککەرەوەی نۆزڵ' }, image: '' });
  assert.deepEqual(fil.targets.products[1], { id: spools[1], slug: 'spool-1', name: { ar: 'بكرة 1', en: 'Spool 1', ckb: 'بکرە 1' }, image: `/files/products/${spools[1]}.webp` }, 'the first image');
  assert.ok(!fil.targets.products.some((p: J) => p.id === 'p_tool'), 'today’s ticks never widen an issued coupon');
  assert.deepEqual(hub.program.filament.products.map((p: J) => p.id), ['p_tool'], 'while the programme itself has moved on');

  // A past coupon is spent on nothing: no targets.
  raw.prepare('UPDATE coupons SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), row<{ coupon_id: string }>(raw, 'SELECT coupon_id FROM reward_grants')!.coupon_id);
  const later = await json(await get(rewardsApp(raw), '/api/rewards/program'));
  assert.deepEqual([later.coupons[0].state, later.coupons[0].targets], ['expired', null]);
  assert.deepEqual(later.coupon_counts, { active: 0, past: 1 });
});

test('the admin: the promo-code list leaves reward coupons out, the code editor refuses them, Admin → Rewards lists and withdraws them', async () => {
  const raw = world();
  const orderId = await deliveredPrinterOrder(raw, 1);
  const boss = rewardsApp(raw, BOSS);
  const promo = await json(await get(boss, '/api/admin/coupons'));
  assert.ok(!promo.coupons.some((c: J) => c.reward_grant_id), 'not one reward coupon among the promo codes');
  const g = grantsOf(raw, orderId)[0];
  const edit = await send(boss, 'PATCH', `/api/admin/coupons/${g.coupon_id}`, { kind: 'percent', value: 90 });
  assert.equal(edit.status, 409);
  assert.equal((await json(edit)).code, 'REWARD_COUPON_MANAGED');

  const list = await json(await get(boss, '/api/admin/rewards/grants?state=active'));
  assert.equal(list.grants.length, 2);
  assert.ok(list.grants.every((x: J) => x.user.id === 'buyer'));
  const revoke = await json(await post(boss, `/api/admin/rewards/grants/${g.id}/revoke`, { reason: 'test withdrawal' }));
  assert.equal(revoke.success, true, JSON.stringify(revoke));
  assert.equal(couponOf(raw, g.coupon_id).active, 0);
  assert.equal((await json(await get(boss, '/api/admin/rewards/grants?state=revoked'))).grants.length, 1);
});

test('the terms are the owner’s: an assistant cannot change them; the owner’s write is validated and audited', async () => {
  const raw = world();
  const assistant = rewardsApp(raw, { id: 'asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' });
  raw.exec("INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('asst','Assistant','asst@x.co','h','admin','assistant')");
  const body = {
    enabled: true,
    valid_days: 7,
    free_shipping: { enabled: true },
    filament: { enabled: true, percent: 15, max_discount_iqd: 25000, product_ids: ['p_plain'] },
    shop: { free_shipping: { enabled: true, points: 4000 }, filament_discount: { enabled: false, points: null } },
  };
  const refused = await send(assistant, 'PUT', '/api/admin/rewards/config', body);
  assert.equal(refused.status, 403);
  const boss = rewardsApp(raw, BOSS);
  const bad = await send(boss, 'PUT', '/api/admin/rewards/config', { ...body, shop: { ...body.shop, filament_discount: { enabled: true, points: null } } });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'REWARD_SHOP_PRICE_REQUIRED');
  const ok = await json(await send(boss, 'PUT', '/api/admin/rewards/config', body));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.deepEqual(ok.config.filament.product_ids, ['p_plain']);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'rewards.config'"), 1);
  const cfg = await json(await get(boss, '/api/admin/rewards/config'));
  assert.ok(cfg.filaments.some((f: J) => f.id === 'p_plain'), 'the FDM filament catalogue offers p_plain to tick');
});


