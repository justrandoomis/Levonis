/**
 * THE POINTS SHOP SELLS PRODUCTS (owner, 2026-11-05; migration 0229; DECISIONS row 299),
 * THROUGH THE REAL ROUTERS.
 *
 *   «23000 points to redeem filament of esun pla plus beige , 23100 points to redeem
 *    filament of esun pla plus black and 23250 points to redeem filament of esun pla plus
 *    cold white»
 *
 * The owner's colours at the owner's prices, end to end: swap → a gift in /api/gifts as
 * REDEEMED → a cart line at 0 → a quote that charges delivery only → an order → delivered
 * → fulfilled, the points moved exactly once. A replay refused; not enough points refused
 * and nothing moved; a cancelled order hands the gift back with the points still spent; a
 * cancel by the team before ordering gives them back, once.
 *
 * Real migrations, real triggers, real cart and checkout; only the session is stubbed.
 * Run: node --import tsx --test tests/rewardsShopItems.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, dbThrough, get, json, patch, post, put, row, stubApp, type App, type StubUser } from './fixtures/app';
import { BOSS, BUYER, addGiftToCart, giftRow, grantProduct, myGift, NOZZLE_04_RED, placeOrder, quoteBody, redeem, type J } from './fixtures/giftWorld';
import { publishSeededV2 } from './fixtures/autoPublish';
import { serialD1 } from './fixtures/serialD1';
import { ESUN_GIFT_VALUE_IQD, ESUN_ITEMS, esunWorld, givePoints, mountShop, ownersPrices, points, setTerms, shopApps } from './fixtures/shopWorld';
import { MAX_SHOP_PRODUCTS, normalizeRewardConfig, validateRewardConfig } from '../worker/lib/rewards/config';
import { rewardText } from '../worker/lib/rewards/strings';

const swap = (app: App, id: string) => post(app, `/api/rewards/program/shop/items/${id}`);
const hubOf = async (app: App): Promise<J> => json(await get(app, '/api/rewards/program'));
const pointTxs = (raw: ReturnType<typeof esunWorld>) =>
  all<{ id: string; type: string; amount: number; ref: string | null }>(raw, "SELECT id, type, amount, ref FROM wallet_transactions WHERE user_id = 'buyer' AND currency = 'POINT' AND id NOT LIKE 'pts_test_%' ORDER BY rowid");

/** The swap, asserted, answering its gift. */
async function swapped(app: App, id: string): Promise<J> {
  const res = await swap(app, id);
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  return out.gift;
}

// ------------------------------------------------------------------ the whole road

test('the owner’s three colours at the owner’s prices: swap → gift → cart at 0 → delivery only → order → delivered, the points moved once', async () => {
  for (const item of ESUN_ITEMS) {
    const raw = esunWorld();
    ownersPrices(raw);
    givePoints(raw, 30_000);
    const a = shopApps(raw);

    // ---- The hub offers it, with what this customer has. ----------------------------
    const hub = await hubOf(a.buyer);
    const offered = hub.shop_items.find((s: J) => s.id === item.id);
    assert.deepEqual(
      { points: offered.points, affordable: offered.affordable, short: offered.points_short, holding: offered.holding, available: offered.available },
      { points: item.points, affordable: true, short: 0, holding: false, available: true }
    );
    assert.equal(offered.product.id, 'p_esun');
    assert.equal(offered.product.name.en, 'eSUN PLA+ Filament — 1 kg');
    assert.equal(offered.product.option.en, 'With spool — 1 kg');
    assert.ok(offered.product.color.en, 'the colour is named');

    // ---- The swap. ------------------------------------------------------------------
    const gift = await swapped(a.buyer, item.id);
    assert.equal(gift.status, 'REDEEMED');
    assert.equal(gift.reason, 'reward');
    assert.equal(gift.mode, 'product');
    assert.equal(gift.level, null, 'a product of the shop belongs to no level');
    assert.equal(gift.points_spent, item.points);
    assert.equal(gift.chosen.product_id, 'p_esun');
    assert.equal(gift.chosen.color.hex.length, 7);
    assert.equal(points(raw), 30_000 - item.points, 'the price, exactly');
    const stored = giftRow(raw, gift.id);
    assert.deepEqual(
      { state: stored.state, level: stored.level, points_spent: stored.points_spent, tx: stored.points_tx_id, item: stored.shop_item_id, by: stored.granted_by },
      { state: 'redeemed', level: 1, points_spent: item.points, tx: `wtx_rwshop_${gift.id}`, item: item.id, by: 'buyer' }
    );
    assert.deepEqual(pointTxs(raw), [{ id: `wtx_rwshop_${gift.id}`, type: 'withdrawal', amount: item.points, ref: `reward_shop:${gift.id}` }]);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_redemptions WHERE entitlement_id = ?', gift.id), 1, 'the row every redeemed gift has');
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.grant' AND target = ?", gift.id), 1);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ?', 'buyer'), 0, 'they did this themself: no «you received a gift»');
    assert.equal((await myGift(a.buyer, gift.id))!.status, 'REDEEMED', 'and it is there in «هداياي»');

    // ---- The cart line at 0, and delivery only at the checkout. ----------------------
    const added = await addGiftToCart(a.buyer, gift.id);
    assert.equal(added.status, 200, JSON.stringify(await added.clone().json()));
    const cart = await json(await get(a.buyer, '/api/cart'));
    assert.equal(cart.items.length, 1);
    assert.equal(cart.items[0].unit_price_iqd, 0, 'the product is free');
    assert.equal(cart.items[0].gift.level, 0, 'it belongs to no level, so its line says «هدية», not «هدية · المستوى 1»');
    const quote = (await json(await post(a.buyer, '/api/orders/quote', quoteBody()))).quote;
    assert.equal(quote.merchandise_iqd, 0);
    assert.equal(quote.lines[0].is_gift, true);
    assert.equal(quote.lines[0].gift.value_iqd, ESUN_GIFT_VALUE_IQD, 'its value is shown, never charged');
    assert.ok(quote.shipping.total_iqd > 0, 'delivery is charged as usual');
    assert.equal(quote.cod_tax_iqd, 0, 'under the courier’s block: no tax on a delivery this small');
    assert.equal(quote.total_iqd, quote.shipping.total_iqd, 'the delivery is all they pay');
    assert.equal(quote.points.earn_eligible_iqd, 0, 'a gift earns no points');

    // ---- The order, its delivery, and the gift fulfilled. ---------------------------
    const order = await placeOrder(a.buyer);
    assert.equal(order.order_kind, 'gift');
    assert.equal((await myGift(a.buyer, gift.id))!.status, 'ORDERED');
    assert.equal(row<{ n: number }>(raw, "SELECT reserved AS n FROM product_variants WHERE combo_key = ?", `o:v_esun|c:${item.color_id}`)!.n, 1, 'it reserves its own colour’s real stock');
    assert.equal(row<{ n: number }>(raw, 'SELECT line_total_iqd AS n FROM order_items WHERE order_id = ?', order.id)!.n, 0);
    assert.equal((await patch(a.admin, `/api/admin/orders/${order.id}`, { status: 'confirmed' })).status, 200);
    assert.equal((await patch(a.admin, `/api/admin/orders/${order.id}`, { status: 'delivered' })).status, 200);
    assert.equal((await myGift(a.buyer, gift.id))!.status, 'FULFILLED');
    assert.equal(row<{ n: number }>(raw, 'SELECT reserved AS n FROM product_variants WHERE combo_key = ?', `o:v_esun|c:${item.color_id}`)!.n, 0, 'its stock left with the order');
    assert.equal(points(raw), 30_000 - item.points, 'the points moved exactly once, whatever came after');
    assert.equal(pointTxs(raw).length, 1);
  }
});

test('the owner’s other price: 3,000 points for one coupon of 5,000 off the delivery on an order above 100,000', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 3_000);
  const a = shopApps(raw);
  const hub = await hubOf(a.buyer);
  assert.deepEqual(hub.shop.map((s: J) => [s.kind, s.points, s.affordable]), [['free_shipping', 3_000, true]]);
  const bought = await json(await post(a.buyer, '/api/rewards/program/shop/free_shipping'));
  assert.equal(bought.success, true, JSON.stringify(bought));
  assert.deepEqual([bought.coupon.amount_iqd, bought.coupon.min_total_iqd, bought.coupon.points_spent], [5_000, 100_000, 3_000]);
  assert.equal(points(raw), 0);
});

test('a pre-order for points keeps its route and charges no commission: the delivery is still all they pay', async () => {
  const raw = esunWorld();
  setTerms(raw, { shop: { items: [{ id: 'plate_air', product_id: 'p_plate', option_value_ids: ['v_pei'], color_id: 'c_black', qty: 1, sale_type: 'pre_order', transport_method: 'air', points: 40_000, enabled: true }] } });
  givePoints(raw, 40_000);
  const a = shopApps(raw);
  const offered = (await hubOf(a.buyer)).shop_items[0];
  assert.equal(offered.available, true);
  const gift = await swapped(a.buyer, 'plate_air');
  assert.equal(gift.chosen.sale_type, 'pre_order');
  assert.equal(gift.chosen.transport_method, 'air');
  assert.equal(gift.chosen.lead_time_max_days, 14);
  assert.equal((await addGiftToCart(a.buyer, gift.id)).status, 200);
  const quote = (await json(await post(a.buyer, '/api/orders/quote', quoteBody()))).quote;
  assert.equal(quote.merchandise_iqd, 0, 'no route commission on a gift');
  assert.equal(quote.total_iqd, quote.shipping.total_iqd + quote.cod_tax_iqd);
  const order = await placeOrder(a.buyer);
  assert.equal(giftRow(raw, gift.id).state, 'ordered');
  assert.equal(giftRow(raw, gift.id).order_id, order.id);
});

// ------------------------------------------------------------------ refusals

test('a replay is refused and moves nothing; a second one of the same product waits until the first is ordered', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 70_000);
  const a = shopApps(raw);
  const gift = await swapped(a.buyer, 'esun_black');
  const again = await swap(a.buyer, 'esun_black');
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'REWARD_SHOP_HOLDING');
  assert.equal(points(raw), 70_000 - 23_100, 'once');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_redemptions'), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.grant'"), 1, 'a refused swap leaves no audit row');

  let hub = await hubOf(a.buyer);
  assert.equal(hub.shop_items.find((s: J) => s.id === 'esun_black').holding, true, 'the page says what the swap would');
  assert.equal(hub.shop_items.find((s: J) => s.id === 'esun_beige').holding, false, 'held per item, not per shop');
  assert.equal((await swap(a.buyer, 'esun_beige')).status, 200, 'another colour is another item');

  // In the cart it is still un-ordered: held. Ordered, it is not.
  await addGiftToCart(a.buyer, gift.id);
  assert.equal((await json(await swap(a.buyer, 'esun_black'))).code, 'REWARD_SHOP_HOLDING', 'a line in the cart is not an order');
  await placeOrder(a.buyer, { itemIds: all<{ id: string }>(raw, 'SELECT id FROM cart_items').map((c) => c.id) });
  hub = await hubOf(a.buyer);
  assert.equal(hub.shop_items.find((s: J) => s.id === 'esun_black').holding, false);
});

test('not enough points is refused and nothing moves: no gift, no audit row, no withdrawal, and the hub says what is short', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 22_999);
  const a = shopApps(raw);
  const offered = (await hubOf(a.buyer)).shop_items.find((s: J) => s.id === 'esun_beige');
  assert.deepEqual([offered.affordable, offered.points_short], [false, 1]);
  const res = await swap(a.buyer, 'esun_beige');
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'INSUFFICIENT_POINTS');
  assert.equal(points(raw), 22_999);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_redemptions'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'gift.%'"), 0);
  assert.equal(pointTxs(raw).length, 0);
  givePoints(raw, 1);
  assert.equal((await swap(a.buyer, 'esun_beige')).status, 200, 'at exactly the price it goes through');
  assert.equal(points(raw), 0);
});

test('the server reads no figure from the client: a body naming a price or another product changes nothing', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  const a = shopApps(raw);
  const res = await post(a.buyer, '/api/rewards/program/shop/items/esun_beige', { points: 1, price: 1, product_id: 'p_plain', qty: 9, color_id: 'c_esun_black' });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(points(raw), 7_000);
  assert.equal(out.gift.chosen.product_id, 'p_esun');
  assert.equal(out.gift.chosen.qty, 1);
  assert.equal(giftRow(raw, out.gift.id).gift_color_id, 'c_esun_beige');
});

test('what is not on sale answers one refusal: an unknown id, a row switched off, a row with no price, a product gone', async () => {
  const raw = esunWorld();
  setTerms(raw, {
    shop: {
      items: [
        { ...ESUN_ITEMS[0], enabled: false },
        { ...ESUN_ITEMS[1], points: null },
        ESUN_ITEMS[2],
      ],
    },
  });
  givePoints(raw, 90_000);
  const a = shopApps(raw);
  await get(a.buyer, '/api/gifts');
  for (const id of ['nope', 'esun_beige', 'esun_black']) {
    const res = await swap(a.buyer, id);
    assert.equal(res.status, 409, id);
    assert.equal((await json(res)).code, 'REWARD_SHOP_UNAVAILABLE', id);
  }
  assert.deepEqual((await hubOf(a.buyer)).shop_items.map((s: J) => s.id), ['esun_white'], 'only what is on sale is shown');

  raw.exec("UPDATE products SET status = 'draft' WHERE id = 'p_esun'");
  assert.deepEqual((await hubOf(a.buyer)).shop_items, [], 'a product no customer may see is not shown here either');
  assert.equal((await json(await swap(a.buyer, 'esun_white'))).code, 'REWARD_SHOP_UNAVAILABLE');
  assert.equal(points(raw), 90_000);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);
});

test('an empty shelf: still named so the customer sees what the points are for, not swappable, and nothing moves', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  const a = shopApps(raw);
  await get(a.buyer, '/api/gifts');
  // Stock is per colour on this product: one colour empty, the others untouched.
  raw.exec("UPDATE product_variants SET stock = 0 WHERE id = 'var_beige'");
  const items = (await hubOf(a.buyer)).shop_items as J[];
  const offered = items.find((s) => s.id === 'esun_beige')!;
  assert.equal(offered.available, false);
  assert.equal(offered.product.color.en, 'BEIGE');
  assert.equal(items.find((s) => s.id === 'esun_black')!.available, true, 'the black has its own shelf');
  assert.equal((await json(await swap(a.buyer, 'esun_beige'))).code, 'REWARD_SHOP_UNAVAILABLE');
  assert.equal(points(raw), 30_000);
  assert.equal((await swap(a.buyer, 'esun_black')).status, 200);
});

// ------------------------------------------------------------------ races

test('two presses at once: one gift and one withdrawal, and the other is told it holds one', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 70_000);
  await publishSeededV2(raw);
  const a = shopApps(raw, serialD1(raw));
  const answers = await Promise.all([swap(a.buyer, 'esun_beige'), swap(a.buyer, 'esun_beige')]);
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409]);
  const refused = answers.find((r) => r.status === 409)!;
  assert.equal((await json(refused)).code, 'REWARD_SHOP_HOLDING');
  assert.equal(points(raw), 70_000 - 23_000);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1);
  assert.equal(pointTxs(raw).length, 1);
});

test('two colours at once with points for one: exactly one goes through, and the balance never goes below zero', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 23_500);
  await publishSeededV2(raw);
  const a = shopApps(raw, serialD1(raw));
  const answers = await Promise.all([swap(a.buyer, 'esun_beige'), swap(a.buyer, 'esun_white')]);
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await json(answers.find((r) => r.status === 409)!)).code, 'INSUFFICIENT_POINTS');
  assert.ok(points(raw) >= 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1, 'the losing batch rolled back whole');
});

// ------------------------------------------------------------------ what comes back

test('an order cancelled: the gift can be ordered again, the points stay spent, and the same gift is what is held', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  const a = shopApps(raw);
  const gift = await swapped(a.buyer, 'esun_beige');
  await addGiftToCart(a.buyer, gift.id);
  const order = await placeOrder(a.buyer);
  assert.equal((await post(a.buyer, `/api/orders/${order.id}/cancel`, {})).status, 200, 'the customer cancels it, through the real door');
  assert.equal((await myGift(a.buyer, gift.id))!.status, 'REDEEMED', 'back in «هداياي»');
  assert.equal(points(raw), 7_000, 'the points stay spent');
  assert.equal(pointTxs(raw).length, 1);
  assert.equal((await hubOf(a.buyer)).shop_items.find((s: J) => s.id === 'esun_beige').holding, true);

  assert.equal((await addGiftToCart(a.buyer, gift.id)).status, 200);
  const second = await placeOrder(a.buyer);
  assert.equal((await myGift(a.buyer, gift.id))!.status, 'ORDERED');
  assert.equal(giftRow(raw, gift.id).order_id, second.id);
  assert.equal(points(raw), 7_000, 'and ordering it again costs nothing more');
});

test('an order cancelled while another of the same product is held: both stand, and the cancel is not refused', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 60_000);
  const a = shopApps(raw);
  const first = await swapped(a.buyer, 'esun_beige');
  await addGiftToCart(a.buyer, first.id);
  const order = await placeOrder(a.buyer);
  const second = await swapped(a.buyer, 'esun_beige');
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  assert.equal(giftRow(raw, first.id).state, 'redeemed');
  assert.equal(giftRow(raw, second.id).state, 'redeemed', 'no index stands in the way of the 0175 trigger');
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM orders WHERE id = ?', order.id)!.status, 'cancelled');
  assert.equal((await json(await swap(a.buyer, 'esun_beige'))).code, 'REWARD_SHOP_HOLDING');
});

test('the team cancels before it is ordered: the points come back once, in the batch, with an audit fact and one notice', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  const a = shopApps(raw);
  const gift = await swapped(a.buyer, 'esun_white');
  await addGiftToCart(a.buyer, gift.id);
  assert.equal(points(raw), 6_750);

  const res = await post(a.admin, `/api/gifts/admin/grants/${gift.id}/cancel`, { reason: 'the owner withdrew it' });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.grant.status, 'CANCELLED');
  assert.deepEqual(out.grant.shop, { item_id: 'esun_white', points_spent: 23_250, points_returned: true });
  assert.equal(points(raw), 30_000, 'all of it');
  assert.deepEqual(pointTxs(raw).map((t) => [t.id, t.type, t.amount, t.ref]), [
    [`wtx_rwshop_${gift.id}`, 'withdrawal', 23_250, `reward_shop:${gift.id}`],
    [`wtx_rwshop_back_${gift.id}`, 'deposit', 23_250, `reward_shop_back:${gift.id}`],
  ]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', gift.id), 0, 'its cart line went with it');
  const audit = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'gift.cancel' AND target = ?", gift.id)!.detail);
  assert.equal(audit.points_returned, 23_250);
  assert.equal(audit.points_tx_id, `wtx_rwshop_${gift.id}`);
  const notice = row<Record<string, string>>(raw, "SELECT * FROM user_notifications WHERE user_id = 'buyer' AND kind = 'reward'")!;
  assert.equal(notice.link, '/rewards/shop');
  assert.match(notice.body_ar, /23,250/);
  assert.ok(JSON.parse(notice.meta).body_ckb.includes('23,250'));

  // Pressed again, by either door: refused, and nothing moves.
  const again = await post(a.admin, `/api/gifts/admin/grants/${gift.id}/cancel`, { reason: 'pressed twice' });
  assert.equal(again.status, 409);
  assert.equal(points(raw), 30_000);
  assert.equal((await post(a.admin, `/api/reviews/admin/gifts/${gift.id}/cancel`, { reason: 'the old door' })).status, 409);
  assert.equal(points(raw), 30_000);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'reward'"), 1);

  // And the shop opens again: a cancelled gift is not held.
  assert.equal((await hubOf(a.buyer)).shop_items.find((s: J) => s.id === 'esun_white').holding, false);
  assert.equal((await swap(a.buyer, 'esun_white')).status, 200);
});

test('the old door cancels by the same rule: the points come back once there too', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  const a = shopApps(raw);
  const gift = await swapped(a.buyer, 'esun_beige');
  assert.equal((await post(a.admin, `/api/reviews/admin/gifts/${gift.id}/cancel`, { reason: 'through the old door' })).status, 200);
  assert.equal(points(raw), 30_000);
  assert.equal((await post(a.admin, `/api/gifts/admin/grants/${gift.id}/cancel`, { reason: 'and again by the new' })).status, 409);
  assert.equal(points(raw), 30_000);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE id LIKE 'wtx_rwshop_back_%'"), 1);
});

test('the points history carries both movements, in the note the page words', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  const a = shopApps(raw);
  const gift = await swapped(a.buyer, 'esun_white');
  await post(a.admin, `/api/gifts/admin/grants/${gift.id}/cancel`, { reason: 'taken back' });
  const history = (await json(await get(a.buyer, '/api/rewards'))).history as J[];
  const of = (re: RegExp) => history.filter((h) => re.test(h.note));
  assert.deepEqual(of(/^Points shop product/).map((h) => [h.direction, h.points]), [['spend', 23_250]]);
  assert.deepEqual(of(/^Points shop refund/).map((h) => [h.direction, h.points]), [['earn', 23_250]]);
  assert.ok(of(/^Points shop product/)[0].note.includes('eSUN PLA+ Filament'), 'it names what was bought');
});

test('a guest cannot swap, and a signed-in customer swaps only for their own account', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  const guest = stubApp(asD1(raw), null, mountShop, { publishV2: 'always' });
  assert.equal((await swap(guest, 'esun_beige')).status, 401);
  assert.equal(points(raw), 30_000);
  const a = shopApps(raw);
  const refused = await swap(a.other, 'esun_beige');
  assert.equal((await json(refused)).code, 'INSUFFICIENT_POINTS', 'the other customer pays with their own points, of which they have none');
  assert.equal(points(raw), 30_000);
});

test('a gift in an order or delivered gives nothing back at the cancel door; its rules stand', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  const a = shopApps(raw);
  const gift = await swapped(a.buyer, 'esun_beige');
  await addGiftToCart(a.buyer, gift.id);
  const order = await placeOrder(a.buyer);
  const ordered = await post(a.admin, `/api/gifts/admin/grants/${gift.id}/cancel`, { reason: 'too late' });
  assert.equal(ordered.status, 409);
  assert.equal((await json(ordered)).code, 'GIFT_ALREADY_ORDERED');
  assert.equal(points(raw), 7_000);
  assert.equal((await patch(a.admin, `/api/admin/orders/${order.id}`, { status: 'confirmed' })).status, 200);
  assert.equal((await patch(a.admin, `/api/admin/orders/${order.id}`, { status: 'delivered' })).status, 200);
  const delivered = await post(a.admin, `/api/gifts/admin/grants/${gift.id}/cancel`, { reason: 'far too late' });
  assert.equal(delivered.status, 409);
  assert.equal((await json(delivered)).code, 'GIFT_STATE');
  assert.equal(points(raw), 7_000);
});

test('a lost race at the cancel writes no refund: the fence comes first', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  await publishSeededV2(raw);
  const a = shopApps(raw, serialD1(raw));
  const gift = await swapped(a.buyer, 'esun_beige');
  const answers = await Promise.all([
    post(a.admin, `/api/gifts/admin/grants/${gift.id}/cancel`, { reason: 'first press' }),
    post(a.admin, `/api/gifts/admin/grants/${gift.id}/cancel`, { reason: 'second press' }),
  ]);
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409]);
  assert.equal(points(raw), 30_000, 'back once');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE type = 'deposit' AND currency = 'POINT' AND id LIKE 'wtx_rwshop_back_%'"), 1);
});

test('an ordinary gift is untouched: no points columns on its row, a notice as ever, and a cancel gives nothing back', async () => {
  const raw = esunWorld();
  givePoints(raw, 500);
  const a = shopApps(raw);
  const grant = await grantProduct(a.admin, NOZZLE_04_RED);
  assert.equal(grant.shop, null);
  const stored = giftRow(raw, grant.id);
  assert.deepEqual([stored.state, stored.points_spent, stored.points_tx_id, stored.shop_item_id], ['ready_to_redeem', 0, null, null]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted'"), 1);
  assert.equal((await redeem(a.buyer, grant.id)).status, 200);
  const view = await myGift(a.buyer, grant.id);
  assert.equal(view!.level.n, 2, 'it keeps its level');
  assert.equal(view!.points_spent, 0);
  assert.equal((await post(a.admin, `/api/gifts/admin/grants/${grant.id}/cancel`, { reason: 'an ordinary cancel' })).status, 200);
  assert.equal(points(raw), 500);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'reward'"), 0);
});

test('the customer’s view of a shop gift holds no internal field, and another customer cannot reach it', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 30_000);
  const a = shopApps(raw);
  const gift = await swapped(a.buyer, 'esun_beige');
  const body = JSON.stringify(await json(await get(a.buyer, '/api/gifts')));
  for (const secret of ['admin_note', 'granted_by', 'points_tx_id', 'wtx_rwshop', 'cost_iqd']) assert.ok(!body.includes(secret), secret);
  assert.equal((await addGiftToCart(a.other, gift.id)).status, 404);
  assert.equal((await post(a.other, `/api/gifts/${gift.id}/redeem`, {})).status, 404);
});

test('the swap shares the coupon swap’s bucket', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  const a = shopApps(raw);
  await swap(a.buyer, 'esun_beige');
  assert.deepEqual(all<{ key: string }>(raw, "SELECT key FROM rate_limits WHERE key LIKE 'reward_shop%'").map((r) => r.key), ['reward_shop:u:buyer']);
  raw.prepare("UPDATE rate_limits SET count = 20 WHERE key LIKE 'reward_shop%'").run();
  assert.equal((await swap(a.buyer, 'esun_beige')).status, 429);
  assert.equal((await post(a.buyer, '/api/rewards/program/shop/free_shipping')).status, 429, 'the coupon door counts the same presses');
});

// ------------------------------------------------------------------ the hub's cost

test('nothing on sale costs the hub no read at all: not the gifts table, not the products', async () => {
  const raw = esunWorld();
  const seen: string[] = [];
  const db = asD1(raw);
  const spy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          seen.push(sql);
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const app = stubApp(spy as unknown as D1Database, BUYER, mountShop, { publishV2: false });
  const out = await hubOf(app);
  assert.deepEqual(out.shop_items, []);
  assert.ok(!seen.some((sql) => /shop_item_id/.test(sql)), 'no holding read');
});

// ------------------------------------------------------------------ the owner's terms

const validBody = () => ({
  enabled: true,
  valid_days: 7,
  weekly: { enabled: true, months: 12 },
  free_shipping: { enabled: true, amount_iqd: 5_000, min_order_iqd: 100_000 },
  filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: [] as string[], max_pieces: 1 },
  shop: { free_shipping: { enabled: true, points: 3_000 }, filament_discount: { enabled: false, points: null as number | null } },
});
const FULL: StubUser = { id: 'fin', role: 'admin', email: 'fin@x.co', admin_scope: 'full' };

test('the terms read tolerantly: absent is none, a damaged row is not on sale alone, at most 50, and no price is never on sale', () => {
  assert.deepEqual(normalizeRewardConfig(null).shop.items, []);
  assert.deepEqual(normalizeRewardConfig({ shop: { items: 'lots' } }).shop.items, []);
  const n = normalizeRewardConfig({
    shop: {
      items: [
        ESUN_ITEMS[0],
        { ...ESUN_ITEMS[1], points: 'free' },
        { ...ESUN_ITEMS[2], sale_type: 'gift' },
        { ...ESUN_ITEMS[0], color_id: 'c_other' },
        { id: 'bad id!', product_id: 'p', sale_type: 'direct_sale', enabled: true, points: 1 },
        { id: 'route', product_id: 'p', sale_type: 'direct_sale', transport_method: 'air', qty: 2, enabled: true, points: 9 },
        { id: 'qty', product_id: 'p', sale_type: 'direct_sale', qty: 100, enabled: true, points: 9 },
        null,
      ],
    },
  });
  assert.deepEqual(n.shop.items.map((i) => i.id), ['esun_beige', 'esun_black', 'route']);
  assert.deepEqual(n.shop.items[1].points, null);
  assert.equal(n.shop.items[1].enabled, false, 'a row with no price is off, whatever its switch says');
  assert.equal(n.shop.items[2].transport_method, '', 'a direct sale has no route');
  const many = Array.from({ length: MAX_SHOP_PRODUCTS + 5 }, (_, i) => ({ ...ESUN_ITEMS[0], id: `i${i}` }));
  assert.equal(normalizeRewardConfig({ shop: { items: many } }).shop.items.length, MAX_SHOP_PRODUCTS);
});

test('the terms write strictly, in the words of a code: and an older screen that sends no list keeps what is stored', () => {
  const body = validBody();
  const stored = normalizeRewardConfig({ shop: { items: ESUN_ITEMS } });
  const old = validateRewardConfig(body, stored);
  assert.ok(old.ok);
  assert.equal(old.ok && old.value.shop.items.length, 3, 'absent keeps what is stored');
  const fresh = validateRewardConfig(body);
  assert.ok(fresh.ok);
  assert.deepEqual(fresh.ok && fresh.value.shop.items, [], 'and on a first save, none');

  const withItems = (items: unknown) => validateRewardConfig({ ...body, shop: { ...body.shop, items } }, stored);
  const code = (items: unknown) => {
    const c = withItems(items);
    return c.ok ? 'ok' : c.code;
  };
  assert.equal(code('x'), 'REWARD_SHOP_ITEM_INVALID');
  assert.equal(code([{ ...ESUN_ITEMS[0], points: null }]), 'REWARD_SHOP_PRICE_REQUIRED');
  assert.equal(code([{ ...ESUN_ITEMS[0], enabled: false, points: null }]), 'ok', 'a draft row with no price is allowed');
  assert.equal(code([{ ...ESUN_ITEMS[0], points: 'lots' }]), 'REWARD_SHOP_ITEM_INVALID');
  assert.equal(code([{ ...ESUN_ITEMS[0], points: 0 }]), 'REWARD_SHOP_ITEM_INVALID');
  assert.equal(code([{ ...ESUN_ITEMS[0], points: 1.5 }]), 'REWARD_SHOP_ITEM_INVALID');
  assert.equal(code([{ ...ESUN_ITEMS[0], qty: 100 }]), 'REWARD_SHOP_ITEM_INVALID');
  assert.equal(code([{ ...ESUN_ITEMS[0], product_id: '' }]), 'REWARD_SHOP_ITEM_INVALID');
  assert.equal(code([{ ...ESUN_ITEMS[0], sale_type: 'free' }]), 'REWARD_SHOP_ITEM_INVALID');
  assert.equal(code([{ ...ESUN_ITEMS[0], enabled: 'yes' }]), 'REWARD_SHOP_ITEM_INVALID');
  assert.equal(code([ESUN_ITEMS[0], ESUN_ITEMS[0]]), 'REWARD_SHOP_ITEM_INVALID', 'one id twice');
  assert.equal(code([ESUN_ITEMS[0], { ...ESUN_ITEMS[0], id: 'twin' }]), 'REWARD_SHOP_ITEM_DUPLICATE', 'one product on sale twice');
  assert.equal(code([ESUN_ITEMS[0], { ...ESUN_ITEMS[0], id: 'twin', enabled: false }]), 'ok', 'a twin that is off sells nothing');
  assert.equal(code(Array.from({ length: MAX_SHOP_PRODUCTS + 1 }, (_, i) => ({ ...ESUN_ITEMS[0], id: `i${i}` }))), 'REWARD_SHOP_ITEMS_TOO_MANY');
  const refused = withItems([ESUN_ITEMS[0], { ...ESUN_ITEMS[1], points: null }]);
  assert.ok(!refused.ok);
  assert.deepEqual(!refused.ok && refused.details, { item_index: 1 }, 'the screen can point at the row');

  const minted = withItems([{ ...ESUN_ITEMS[0], id: undefined }, { ...ESUN_ITEMS[1], id: '' }]);
  assert.ok(minted.ok);
  const ids = minted.ok ? minted.value.shop.items.map((i) => i.id) : [];
  assert.ok(ids[0].startsWith('rsi') && ids[1].startsWith('rsi') && ids[0] !== ids[1], 'a new row is named by the server');
});

test('PUT /config judges every row on sale with the gift code’s own rule: a typo is refused with its code and nothing is stored', async () => {
  const raw = esunWorld();
  const a = shopApps(raw);
  const save = (items: unknown) => put(a.admin, '/api/admin/rewards/config', { ...validBody(), shop: { ...validBody().shop, items } });
  const refuses = async (items: unknown, code: string, label: string) => {
    const res = await save(items);
    const out = await json(res);
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(out)}`);
    assert.equal(out.code, code, label);
    return out;
  };
  raw.exec(`INSERT INTO products (id,slug,name,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
    VALUES ('p_estimate','guess','Guess',9000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE')`);
  const one = ESUN_ITEMS[0];
  await refuses([{ ...one, product_id: 'p_none' }], 'GIFT_PRODUCT_NOT_FOUND', 'no such product');
  await refuses([{ ...one, color_id: 'c_nope' }], 'GIFT_SELECTION_INVALID', 'a colour of nothing');
  await refuses([{ ...one, option_value_ids: [] }], 'GIFT_SELECTION_INVALID', 'no model');
  await refuses([{ ...one, option_value_ids: ['o_x'] }], 'GIFT_SELECTION_INVALID', 'a model of another product');
  await refuses([{ ...one, sale_type: 'pre_order', transport_method: 'air' }], 'GIFT_SALE_TYPE_UNAVAILABLE', 'a pre-order the product does not offer');
  await refuses([{ ...one, product_id: 'p_draft', option_value_ids: [], color_id: '' }], 'GIFT_PRODUCT_INACTIVE', 'a draft');
  await refuses([{ ...one, product_id: 'p_bundle', option_value_ids: [], color_id: '' }], 'GIFT_COMPOSITION_UNSUPPORTED', 'a bundle');
  const second = await refuses([ESUN_ITEMS[1], { ...one, color_id: 'c_nope' }], 'GIFT_SELECTION_INVALID', 'the second row');
  assert.equal(second.details.item_index, 1, 'the screen can point at the row');
  assert.equal(second.details.item_id, one.id);
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'rewardProgramConfig'")!.n, 0, 'nothing was stored');

  // A row that is off is a draft: it is not judged. And an empty shelf is no typo.
  assert.equal((await save([{ ...one, color_id: 'c_nope', enabled: false }])).status, 200);
  raw.exec("UPDATE product_variants SET stock = 0 WHERE product_id = 'p_esun'");
  const good = await save(ESUN_ITEMS);
  const out = await json(good);
  assert.equal(good.status, 200, JSON.stringify(out));
  assert.deepEqual(out.config.shop.items.map((i: J) => [i.id, i.points, i.enabled]), [['esun_beige', 23_000, true], ['esun_black', 23_100, true], ['esun_white', 23_250, true]]);
  assert.deepEqual(out.shop_products.map((p: J) => [p.id, p.available, p.reason, p.value_iqd]), [
    ['esun_beige', false, 'OUT_OF_STOCK', ESUN_GIFT_VALUE_IQD],
    ['esun_black', false, 'OUT_OF_STOCK', ESUN_GIFT_VALUE_IQD],
    ['esun_white', false, 'OUT_OF_STOCK', ESUN_GIFT_VALUE_IQD],
  ]);
});

test('an older screen’s save keeps the products and does not answer for them; the owner alone saves', async () => {
  const raw = esunWorld();
  raw.exec("INSERT OR IGNORE INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('fin','Fin','fin@x.co','h','admin','full')");
  ownersPrices(raw);
  const a = shopApps(raw);
  await get(a.buyer, '/api/gifts');
  // The product has gone since: the old screen knows nothing of it and may still save.
  raw.exec("UPDATE products SET status = 'draft' WHERE id = 'p_esun'");
  const res = await put(a.admin, '/api/admin/rewards/config', validBody());
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.config.shop.items.length, 3);
  assert.deepEqual(out.shop_products.map((p: J) => [p.product.name.en, p.product.color, p.available, p.reason]), Array(3).fill(['eSUN PLA+ Filament — 1 kg', null, false, 'GIFT_PRODUCT_INACTIVE']), 'the admin screen says which product, and why');

  const fin = stubApp(asD1(raw), FULL, mountShop, { publishV2: false });
  const refused = await put(fin, '/api/admin/rewards/config', { ...validBody(), shop: { ...validBody().shop, items: [] } });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'OWNER_REQUIRED');
  const stored = JSON.parse(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key = 'rewardProgramConfig'")!.value);
  assert.equal(stored.shop.items.length, 3);
});

test('the admin reads what each row has done: swapped, points taken, and a cancelled gift counts for nothing', async () => {
  const raw = esunWorld();
  ownersPrices(raw);
  givePoints(raw, 90_000);
  const a = shopApps(raw);
  const one = await swapped(a.buyer, 'esun_beige');
  await swapped(a.buyer, 'esun_black');
  const read = async () => (await json(await get(a.admin, '/api/admin/rewards/config'))).shop_products as J[];
  let rows = await read();
  assert.deepEqual(rows.map((p) => [p.id, p.swapped, p.points_taken, p.available]), [['esun_beige', 1, 23_000, true], ['esun_black', 1, 23_100, true], ['esun_white', 0, 0, true]]);
  assert.equal(rows[0].product.color.en, 'BEIGE');
  assert.doesNotMatch(JSON.stringify(rows), /cost/i);
  let overview = await json(await get(a.admin, '/api/admin/rewards/overview'));
  assert.equal(overview.points_taken_by_shop, 46_100, 'the overview counts the products too');
  assert.equal(overview.switches.shop_products, 3);

  await post(a.admin, `/api/gifts/admin/grants/${one.id}/cancel`, { reason: 'taken back' });
  rows = await read();
  assert.deepEqual(rows[0].swapped, 0);
  overview = await json(await get(a.admin, '/api/admin/rewards/overview'));
  assert.equal(overview.points_taken_by_shop, 23_100, 'a cancel gave its points back');

  const detail = await json(await get(a.admin, `/api/gifts/admin/grants/${one.id}`));
  assert.equal(detail.grant.level, null);
  assert.deepEqual(detail.grant.shop, { item_id: 'esun_beige', points_spent: 23_000, points_returned: true });
});

// ------------------------------------------------------------------ the words

test('the refund’s notice is in three languages, the Sorani its own', () => {
  const t = rewardText({ kind: 'shop_gift_refund', name: { ar: 'eSUN PLA+', en: 'eSUN PLA+', ckb: 'eSUN PLA+' }, points: 23_000 });
  for (const part of [t.title, t.body]) {
    assert.ok(part.ar && part.en && part.ckb);
    assert.notEqual(part.ckb, part.ar);
    assert.notEqual(part.ckb, part.en);
  }
  assert.ok(t.body.ar.includes('23,000') && t.body.en.includes('23,000') && t.body.ckb.includes('23,000'));
  assert.ok(t.body.ar.includes('eSUN PLA+'));
});

// ------------------------------------------------------------------ deploy-ahead

test('deploy-ahead: before 0229 the hub offers no product, the swap answers 503, an ordinary grant and its cancel still work', async () => {
  const raw = dbThrough('0225');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','buyer@x.co','h','customer'), ('boss','The Admin','boss@x.co','h','admin');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_plain','plain','Plain','سادة',15000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts','buyer','deposit','POINT',30000,'approved');
  `);
  setTerms(raw, { shop: { items: [{ id: 'plain', product_id: 'p_plain', option_value_ids: [], color_id: '', qty: 1, sale_type: 'direct_sale', transport_method: '', points: 100, enabled: true }] } });
  const mount = (x: Parameters<typeof mountShop>[0]) => mountShop(x);
  const buyer = stubApp(asD1(raw), BUYER, mount, { publishV2: 'always' });
  const admin = stubApp(asD1(raw), BOSS, mount, { publishV2: 'always' });

  const hub = await get(buyer, '/api/rewards/program');
  const out = await json(hub);
  assert.equal(hub.status, 200, JSON.stringify(out));
  assert.deepEqual(out.shop_items, []);
  assert.equal(out.point_balance, 30_000);

  const refused = await post(buyer, '/api/rewards/program/shop/items/plain');
  assert.equal(refused.status, 503);
  assert.equal((await json(refused)).code, 'REWARDS_NOT_INSTALLED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);
  assert.equal(row<{ n: number }>(raw, "SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) AS n FROM wallet_transactions WHERE user_id='buyer' AND currency='POINT'")!.n, 30_000);

  const config = await json(await get(admin, '/api/admin/rewards/config'));
  assert.equal(config.shop_products[0].swapped, 0, 'the admin screen reads zero');
  assert.equal((await get(admin, '/api/admin/rewards/overview')).status, 200);
  assert.equal((await json(await get(admin, '/api/admin/rewards/overview'))).points_taken_by_shop, 0);

  const grant = await post(admin, '/api/gifts/admin/grants', { userId: 'buyer', mode: 'product', level: 2, reason: 'admin_gift', note: '', idempotencyKey: 'before-0229-grant', product: { productId: 'p_plain', saleType: 'direct_sale', optionValueIds: [], colorId: '', qty: 1 } });
  const granted = await json(grant);
  assert.equal(grant.status, 200, JSON.stringify(granted));
  assert.equal((await get(buyer, '/api/gifts')).status, 200);
  assert.equal((await post(admin, `/api/gifts/admin/grants/${granted.grant.id}/cancel`, { reason: 'before the migration' })).status, 200);
});
