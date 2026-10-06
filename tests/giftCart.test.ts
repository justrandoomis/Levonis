/**
 * THE REDEEMED GIFT IN THE REAL CART (owner brief 2026-10-06 §1;
 * docs/GIFTS_QUICK_BUY.md D4, §1.2).
 *
 *   «بعد الاسترداد: أضف إلى السلة الحالية مرة واحدة بسعر 0 د.ع»
 *
 * The add door reads nothing but the gift id: the product, model, colour,
 * quantity, sale type and route come from the gift the server froze. The line
 * is locked, priced 0 with its value beside it, re-verified on every read, and
 * «في السلة» is derived from it — so removing it returns the gift to
 * «تم استرداد الهدية» by itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, row } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import {
  NOZZLE_04_RED,
  PLAIN,
  PLATE_AIR,
  addGiftToCart,
  addLevelItem,
  apps,
  appsFor,
  get,
  giftInCart,
  giftRow,
  giftWorld,
  grantOk,
  grantProduct,
  json,
  legacyBox,
  myGift,
  orderBody,
  paidLine,
  patch,
  placeOrder,
  post,
  quoteBody,
  redeem,
  redeemedGift,
  send,
} from './fixtures/giftWorld';

/** A JSON body as the routes answer it, read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

type Raw = ReturnType<typeof giftWorld>;
const giftLines = (raw: Raw) =>
  all<Record<string, unknown>>(raw, 'SELECT * FROM cart_items WHERE gift_entitlement_id IS NOT NULL ORDER BY created_at');
const giftItem = (body: J) => (body.items as Array<J>).find((i) => i.kind === 'gift');

test('the redeemed gift is added to the cart once, locked, at 0 IQD with its value beside it', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await redeemedGift(a, NOZZLE_04_RED);

  const res = await addGiftToCart(a.buyer, id);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.already_in_cart, undefined, 'a first add is not a replay');

  // ONE row, written by the server from the gift's frozen selection.
  const [line] = giftLines(raw);
  assert.equal(giftLines(raw).length, 1);
  assert.equal(line.user_id, 'buyer');
  assert.equal(line.product_id, 'p_nozzle');
  assert.equal(line.qty, 1);
  assert.equal(line.option_value_ids, '["v_04"]');
  assert.equal(line.color_id, 'c_red');
  assert.equal(line.fulfillment_type, 'direct_sale');
  assert.equal(line.transport_method, '');
  assert.equal(line.warranty_plan_id, '');
  assert.equal(line.shipping_method_id, `gift:${id}`, 'the discriminator keeps it out of every ordinary line identity');
  assert.equal(line.gift_entitlement_id, id);

  // The cart says it: a locked gift line at 0, «هدية», its value beside it.
  const item = giftItem(body)!;
  assert.equal(item.locked, true);
  assert.equal(item.unit_price_iqd, 0);
  assert.equal(item.breakdown.applied_iqd, 0);
  assert.equal(item.breakdown.unit_subtotal_iqd, 0);
  assert.equal(item.breakdown.regular_iqd, 40000, 'the gift keeps its value visible');
  assert.deepEqual(item.gift, { id, level: 2, value_iqd: 40000 });
  assert.equal(item.support_gift_eligible, false);
  assert.deepEqual(item.warranty_plans, []);
  assert.deepEqual(item.options, [], 'no option editor');
  assert.deepEqual(item.colors, [], 'no colour editor');
  assert.equal(item.availability.mode, 'direct_sale');
  assert.equal(item.availability.reason, null);
  assert.equal(item.shipping_method_id, '', 'the discriminator is server identity, never echoed');

  // GET /api/cart answers the same.
  const cart = await json(await get(a.buyer, '/api/cart'));
  assert.equal(giftItem(cart)?.unit_price_iqd, 0);

  // «في السلة» is DERIVED; nothing was consumed and nothing reserved.
  assert.equal(giftRow(raw, id).state, 'redeemed');
  const card = await myGift(a.buyer, id);
  assert.equal(card?.status, 'ADDED_TO_ORDER');
  assert.equal(card?.cart_item_id, line.id);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
});

test('a second add — sequential or concurrent — makes no second line', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await redeemedGift(a);
  assert.equal((await addGiftToCart(a.buyer, id)).status, 200);
  const second = await json(await addGiftToCart(a.buyer, id));
  assert.equal(second.success, true);
  assert.equal(second.already_in_cart, true, 'a second press answers «already in the cart»');
  assert.equal(giftLines(raw).length, 1);

  // A CONCURRENT double tap: both read «no line yet», both write — the UNIQUE
  // index lets one INSERT through and the other answers already_in_cart.
  const raw2 = giftWorld();
  const a2 = apps(raw2);
  const id2 = await redeemedGift(a2);
  const s = appsFor(serialD1(raw2));
  const [x, y] = await Promise.all([addGiftToCart(s.buyer, id2), addGiftToCart(s.buyer, id2)]);
  const [jx, jy] = [await json(x), await json(y)];
  assert.equal(x.status, 200, JSON.stringify(jx));
  assert.equal(y.status, 200, JSON.stringify(jy));
  assert.equal([jx.already_in_cart, jy.already_in_cart].filter((v) => v === true).length, 1, 'exactly one was the replay');
  assert.equal(count(raw2, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', id2), 1);
});

test('removing the gift line returns it to «redeemed»; it can be added again', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  const lineId = String(giftLines(raw)[0].id);

  const removed = await json(await send(a.buyer, 'DELETE', `/api/cart/items/${lineId}`));
  assert.equal(removed.success, true);
  assert.equal(giftLines(raw).length, 0);
  assert.equal(giftRow(raw, id).state, 'redeemed', 'no state was written either way');
  assert.equal((await myGift(a.buyer, id))?.status, 'REDEEMED');

  const readded = await json(await addGiftToCart(a.buyer, id));
  assert.equal(readded.success, true);
  assert.equal(readded.already_in_cart, undefined);

  // «Empty the cart» does the same.
  await send(a.buyer, 'DELETE', '/api/cart');
  assert.equal(giftLines(raw).length, 0);
  assert.equal((await myGift(a.buyer, id))?.status, 'REDEEMED');
  assert.equal((await addGiftToCart(a.buyer, id)).status, 200);
});

test('an ordered or delivered gift cannot be added again (GIFT_ALREADY_ORDERED)', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  const order = await placeOrder(a.buyer);
  assert.equal(giftRow(raw, id).state, 'ordered');

  const res = await addGiftToCart(a.buyer, id);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'GIFT_ALREADY_ORDERED');
  assert.equal(giftLines(raw).length, 0, 'nothing was added back');

  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), order.id);
  assert.equal(giftRow(raw, id).state, 'fulfilled');
  const again = await addGiftToCart(a.buyer, id);
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'GIFT_ALREADY_ORDERED');
});

test('the door checks the owner, the redemption and the state', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  await addLevelItem(a.admin, 1, PLAIN);
  const mine = await redeemedGift(a);
  const unchosen = (await grantOk(a.admin, { mode: 'level', level: 1, reason: 'review' })).id;
  const unredeemed = (await grantProduct(a.admin, NOZZLE_04_RED)).id;
  const cancelled = (await grantProduct(a.admin, PLAIN)).id;
  await post(a.admin, `/api/gifts/admin/grants/${cancelled}/cancel`, { reason: 'by mistake' });
  legacyBox(raw, 'ge_legacy');

  const refuse = async (app: typeof a.buyer, id: string) => {
    const res = await addGiftToCart(app, id);
    return { status: res.status, code: (await json(res)).code as string };
  };
  // Another account's gift and an unknown id answer alike: nothing is disclosed.
  assert.deepEqual(await refuse(a.other, mine), { status: 404, code: 'GIFT_NOT_FOUND' });
  assert.deepEqual(await refuse(a.buyer, 'gift_nope'), { status: 404, code: 'GIFT_NOT_FOUND' });
  assert.deepEqual(await refuse(a.buyer, unchosen), { status: 409, code: 'GIFT_NOT_REDEEMED' });
  assert.deepEqual(await refuse(a.buyer, unredeemed), { status: 409, code: 'GIFT_NOT_REDEEMED' });
  assert.deepEqual(await refuse(a.buyer, cancelled), { status: 409, code: 'GIFT_NOT_AVAILABLE' });
  assert.deepEqual(await refuse(a.buyer, 'ge_legacy'), { status: 409, code: 'GIFT_NOT_AVAILABLE' });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0, 'no refusal wrote a line');
  assert.equal((await post(a.buyer, '/api/cart/gift-items', {})).status, 400, 'a gift id is required');
});

test('nothing in the body but the gift id is read; the ordinary door never makes a line free', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await redeemedGift(a);
  const res = await post(a.buyer, '/api/cart/gift-items', {
    giftId: id,
    productId: 'p_plate',
    qty: 5,
    optionValueIds: ['v_06'],
    colorId: 'c_blue',
    unit_price_iqd: 0,
  });
  assert.equal(res.status, 200);
  const line = giftLines(raw)[0];
  assert.deepEqual([line.product_id, line.qty, line.option_value_ids, line.color_id], ['p_nozzle', 1, '["v_04"]', 'c_red']);

  const paid = await json(
    await post(a.buyer, '/api/cart/items', {
      productId: 'p_nozzle',
      optionValueIds: ['v_04'],
      colorId: 'c_blue',
      qty: 1,
      gift_entitlement_id: id,
      giftEntitlementId: id,
      giftId: id,
      unit_price_iqd: 0,
    })
  );
  assert.equal(paid.success, true, JSON.stringify(paid));
  const blue = row<Record<string, unknown>>(raw, "SELECT * FROM cart_items WHERE color_id = 'c_blue'")!;
  assert.equal(blue.gift_entitlement_id, null);
  assert.equal(blue.shipping_method_id, '');
  const blueItem = (paid.items as Array<J>).find((i) => i.color_id === 'c_blue')!;
  assert.equal(blueItem.unit_price_iqd, 40000);
  assert.equal(blueItem.kind, undefined);
});

test('the gift line never merges with a paid line of the same product, and nothing on it can be edited', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const add = () => post(a.buyer, '/api/cart/items', { productId: 'p_nozzle', optionValueIds: ['v_04'], colorId: 'c_red', qty: 1 });
  assert.equal((await add()).status, 200);
  const id = await giftInCart(a);
  const cart = await json(await add());
  assert.equal(cart.success, true, JSON.stringify(cart));

  const rows = all<Record<string, unknown>>(raw, 'SELECT qty, shipping_method_id, gift_entitlement_id FROM cart_items ORDER BY shipping_method_id');
  assert.deepEqual(
    rows.map((r) => [r.qty, r.shipping_method_id, r.gift_entitlement_id]),
    [[2, '', null], [1, `gift:${id}`, id]],
    'the paid line merged with itself; the gift line stayed 1 and apart'
  );
  const items = cart.items as Array<J>;
  assert.deepEqual(items.map((i) => [i.kind ?? 'ordinary', i.qty, i.unit_price_iqd]).sort(), [['gift', 1, 0], ['ordinary', 2, 40000]]);

  const giftLineId = String(giftLines(raw)[0].id);
  for (const change of [{ qty: 2 }, { colorId: 'c_blue' }, { optionValueIds: ['v_06'] }, { warrantyPlanId: 'w1' }, { transportMethod: 'air' }, {}]) {
    const res = await patch(a.buyer, `/api/cart/items/${giftLineId}`, change);
    assert.equal(res.status, 409, JSON.stringify(change));
    assert.equal((await json(res)).code, 'GIFT_LINE_LOCKED');
  }
  assert.deepEqual(
    { ...row<Record<string, unknown>>(raw, 'SELECT qty, color_id, option_value_ids FROM cart_items WHERE id = ?', giftLineId)! },
    { qty: 1, color_id: 'c_red', option_value_ids: '["v_04"]' }
  );
});

test('a line written around the door is never priced at 0', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  // The row no longer matches the gift's frozen selection.
  raw.prepare("UPDATE cart_items SET color_id = 'c_blue' WHERE gift_entitlement_id = ?").run(id);
  const cart = await json(await get(a.buyer, '/api/cart'));
  const item = giftItem(cart)!;
  assert.equal(item.availability.mode, 'unavailable');
  assert.equal(item.availability.reason, 'GIFT_NOT_ORDERABLE');
  const quote = await post(a.buyer, '/api/orders/quote', quoteBody());
  assert.equal(quote.status, 409);
  assert.equal((await json(quote)).code, 'GIFT_NOT_ORDERABLE');
  const order = await post(a.buyer, '/api/orders', orderBody());
  assert.equal(order.status, 409);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);

  // A line naming SOMEONE ELSE's gift, or a gift that is not redeemed, is refused the same way.
  raw.prepare('DELETE FROM cart_items').run();
  const theirs = await grantProduct(a.admin, PLAIN, { userId: 'other' });
  await redeem(a.other, theirs.id);
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,
                               fulfillment_type,warranty_plan_id,qty,gift_entitlement_id)
       VALUES ('ci_forged','buyer','p_plain','','[]','',?, '', 'direct_sale', '', 1, ?)`
    )
    .run(`gift:${theirs.id}`, theirs.id);
  const forged = await post(a.buyer, '/api/orders', orderBody());
  assert.equal(forged.status, 409);
  assert.equal((await json(forged)).code, 'GIFT_NOT_ORDERABLE');
  assert.equal(giftRow(raw, theirs.id).state, 'redeemed', 'the other customer’s gift is untouched');
});

test('an unavailable gift shows as blocked instead of vanishing, and is refused at the checkout', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);

  raw.prepare("UPDATE products SET status = 'hidden' WHERE id = 'p_nozzle'").run();
  const cart = await json(await get(a.buyer, '/api/cart'));
  const item = giftItem(cart);
  assert.ok(item, 'still listed');
  assert.equal(item!.availability.mode, 'unavailable');
  assert.equal(item!.availability.reason, 'GIFT_NOT_AVAILABLE');
  assert.equal(item!.unit_price_iqd, 0);
  const res = await post(a.buyer, '/api/orders/quote', quoteBody());
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'GIFT_NOT_AVAILABLE');

  // Sold out after the redemption: the add door and the checkout say so with the stock code.
  raw.prepare("UPDATE products SET status = 'active' WHERE id = 'p_nozzle'").run();
  raw.prepare("UPDATE product_option_values SET stock = 0 WHERE id = 'v_04'").run();
  const quote = await post(a.buyer, '/api/orders/quote', quoteBody());
  assert.equal(quote.status, 400);
  assert.equal((await json(quote)).code, 'OUT_OF_STOCK');
  const lineId = String(giftLines(raw)[0].id);
  assert.equal((await send(a.buyer, 'DELETE', `/api/cart/items/${lineId}`)).status, 200, 'removing it is always possible');
  const readd = await addGiftToCart(a.buyer, id);
  assert.equal(readd.status, 400);
  assert.equal((await json(readd)).code, 'OUT_OF_STOCK');
  assert.equal(giftRow(raw, id).state, 'redeemed', 'the gift waits for the stock');
});

test('one shipping type per cart holds for a gift, and replaceCart empties the cart in the same batch', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const direct = await redeemedGift(a, NOZZLE_04_RED);
  const pre = await redeemedGift(a, PLATE_AIR);

  // A paid pre-order line by air holds the cart; the direct gift conflicts.
  paidLine(raw, 'ci_plate', 'p_plate', { optionValueIds: ['v_pei'], colorId: 'c_black', fulfillmentType: 'pre_order', transport: 'air' });
  const conflict = await addGiftToCart(a.buyer, direct);
  const body = await json(conflict);
  assert.equal(conflict.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'CART_SHIPPING_CONFLICT');

  // The pre-order gift by air sits beside it, its route waived as part of the gift.
  const added = await json(await addGiftToCart(a.buyer, pre));
  assert.equal(added.success, true, JSON.stringify(added));
  const preItem = (added.items as Array<J>).find((i) => i.kind === 'gift')!;
  assert.equal(preItem.availability.mode, 'preorder');
  assert.equal(preItem.transport_method, 'air');
  assert.equal(preItem.breakdown.transport.commission_iqd, 0, 'the route commission is part of the gift');

  // «Empty the cart and add this»: the paid line AND the other gift's line go.
  const replaced = await json(await addGiftToCart(a.buyer, direct, { replaceCart: true }));
  assert.equal(replaced.success, true, JSON.stringify(replaced));
  assert.deepEqual(all<{ gift_entitlement_id: string | null }>(raw, 'SELECT gift_entitlement_id FROM cart_items').map((r) => r.gift_entitlement_id), [direct]);
  assert.equal((await myGift(a.buyer, pre))?.status, 'REDEEMED', 'the removed gift is waiting again');
});
