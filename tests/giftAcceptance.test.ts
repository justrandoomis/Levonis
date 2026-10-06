/**
 * THE GIFTS ACCEPTANCE SCENARIO, END TO END (owner brief 2026-10-06 §1 and
 * §23; docs/GIFTS_QUICK_BUY.md §5) — one customer, one admin, every step
 * through the real routes on a fully migrated database, in the order the owner
 * walks it:
 *
 *   the admin names a level and puts two real store products in it → grants
 *   Sara a gift of that level, with an internal note → Sara is notified →
 *   «اختر هديتك» → «استرداد الهدية» → «تم استرداد الهدية ✓» → «أضف إلى السلة»
 *   (her current cart, beside a product she is buying) → «في السلة» → checkout
 *   at 0 IQD for the gift → «تم طلب هذه الهدية» with the order link → she
 *   cancels, the gift comes back, she orders it again → delivered →
 *   «تم التسليم». Duplicate redemption and duplicate ordering are tried at
 *   every step, and every step is in the audit timeline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, row } from './fixtures/app';
import { deductOrderStock } from '../worker/lib/orderInventory';
import {
  BOSS,
  NOZZLE_04_RED,
  PLATE_AIR,
  addGiftToCart,
  apps,
  choose,
  get,
  giftRow,
  giftWorld,
  json,
  myGift,
  optionStock,
  orderBody,
  patch,
  placeOrder,
  post,
  put,
  quoteBody,
  redeem,
} from './fixtures/giftWorld';
import { asD1 } from './fixtures/app';

/** A JSON body as the routes answer it, read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

const NOTE = 'تعويض عن تأخير الطلب السابق — اتصلت بها الإدارة';

test('acceptance: from the admin’s level to the delivered gift, with every duplicate refused', async () => {
  const raw = giftWorld();
  const a = apps(raw);

  // ---- 1. The admin names level 3 and puts two real products in it. -------
  const level = await json(
    await put(a.admin, '/api/gifts/admin/levels/3', {
      name_ar: 'الهدية الذهبية',
      name_en: 'Gold gift',
      name_ckb: 'دیاریی زێڕین',
      description_ar: 'اختر قطعة أصلية لطابعتك',
      description_en: 'Pick a genuine part for your printer',
      description_ckb: 'پارچەیەکی ڕەسەن بۆ چاپکەرەکەت هەڵبژێرە',
    })
  );
  assert.equal(level.success, true, JSON.stringify(level));
  const nozzle = await json(await post(a.admin, '/api/gifts/admin/levels/3/items', NOZZLE_04_RED));
  const plate = await json(await post(a.admin, '/api/gifts/admin/levels/3/items', PLATE_AIR));
  assert.equal(nozzle.success && plate.success, true);

  // ---- 2. The admin grants Sara a level-3 gift, with an internal note. -----
  const granted = await json(
    await post(a.admin, '/api/gifts/admin/grants', {
      userId: 'buyer',
      mode: 'level',
      level: 3,
      reason: 'compensation',
      note: NOTE,
      idempotencyKey: 'acceptance-grant-001',
    })
  );
  assert.equal(granted.success, true, JSON.stringify(granted));
  const id = granted.grant.id as string;
  // A double press of «منح» is the same grant.
  const pressedTwice = await json(
    await post(a.admin, '/api/gifts/admin/grants', {
      userId: 'buyer',
      mode: 'level',
      level: 3,
      reason: 'compensation',
      note: NOTE,
      idempotencyKey: 'acceptance-grant-001',
    })
  );
  assert.equal(pressedTwice.grant.id, id);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1);

  // ---- 3. Sara is notified. -----------------------------------------------
  const notice = row<Record<string, string>>(raw, "SELECT * FROM user_notifications WHERE user_id = 'buyer' AND kind = 'gift_granted'")!;
  assert.equal(notice.link, '/gifts');
  assert.ok(JSON.parse(notice.meta).title_ckb);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted'"), 1, 'one notice for one grant');

  // ---- 4. «هداياي»: one card, the level's two choices, no note. ------------
  const listed = await get(a.buyer, '/api/gifts');
  const listedText = await listed.text();
  assert.ok(!listedText.includes('تعويض عن تأخير'), 'the internal note never reaches Sara');
  let card = JSON.parse(listedText).gifts[0];
  assert.equal(card.status, 'GRANTED');
  assert.equal(card.level.name.ar, 'الهدية الذهبية');
  assert.equal(card.level.name.ckb, 'دیاریی زێڕین');
  assert.deepEqual(card.choices.map((c: J) => c.product_id), ['p_nozzle', 'p_plate']);

  // ---- 5. «اختر هديتك». ----------------------------------------------------
  card = (await json(await choose(a.buyer, id, nozzle.item.id))).gift;
  assert.equal(card.status, 'READY_TO_REDEEM');
  assert.equal(card.chosen.value_iqd, 40000);

  // ---- 6. «استرداد الهدية» — once, whatever is pressed twice. --------------
  card = (await json(await redeem(a.buyer, id))).gift;
  assert.equal(card.status, 'REDEEMED');
  const doubleRedeem = await json(await redeem(a.buyer, id));
  assert.equal(doubleRedeem.replay, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_redemptions'), 1);
  assert.equal((await choose(a.buyer, id, plate.item.id)).status, 409, 'the choice is final after redemption');

  // ---- 7. «أضف إلى السلة» — the CURRENT cart, beside a bought product. -----
  assert.equal((await post(a.buyer, '/api/cart/items', { productId: 'p_plain', qty: 1 })).status, 200);
  const added = await json(await addGiftToCart(a.buyer, id));
  assert.equal(added.success, true, JSON.stringify(added));
  const giftLine = (added.items as Array<J>).find((i) => i.kind === 'gift')!;
  assert.equal(giftLine.unit_price_iqd, 0);
  assert.equal(giftLine.locked, true);
  assert.equal((added.items as unknown[]).length, 2, 'the bought product is still there');
  assert.equal((await json(await addGiftToCart(a.buyer, id))).already_in_cart, true, 'a second add is the same line');
  assert.equal((await patch(a.buyer, `/api/cart/items/${giftLine.id}`, { qty: 3 })).status, 409, 'its quantity is fixed');
  assert.equal((await myGift(a.buyer, id))?.status, 'ADDED_TO_ORDER', '«في السلة»');

  // ---- 8. The checkout: the gift at 0, the bought product priced. ----------
  const quote = (await json(await post(a.buyer, '/api/orders/quote', quoteBody()))).quote;
  assert.equal(quote.merchandise_iqd, 15000, 'only the bought product is merchandise');
  assert.equal(quote.lines.find((l: J) => l.is_gift).line_total_iqd, 0);
  const order = await placeOrder(a.buyer);
  assert.equal(order.subtotal_iqd, 15000);
  assert.equal(order.order_kind, 'normal');
  const giftItem = order.items.find((i: J) => i.is_gift);
  assert.equal(giftItem.unit_price_iqd, 0);
  assert.equal(giftItem.gift_id, id);
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 1 }, 'the gift reserved its real stock with the order');

  // ---- 9. «تم طلب هذه الهدية» + the order link; nothing orders it twice. ---
  card = await myGift(a.buyer, id);
  assert.equal(card.status, 'ORDERED');
  assert.equal(card.order.id, order.id);
  const readd = await addGiftToCart(a.buyer, id);
  assert.equal((await json(readd)).code, 'GIFT_ALREADY_ORDERED');
  assert.equal((await json(await redeem(a.buyer, id))).gift.status, 'ORDERED', 'a late redeem changes nothing');
  const emptyCheckout = await post(a.buyer, '/api/orders', orderBody());
  assert.notEqual(emptyCheckout.status, 200, 'the cart is empty: there is nothing to order twice');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items WHERE gift_entitlement_id = ?', id), 1);

  // ---- 10. Sara cancels: the gift comes back and is ordered again. --------
  assert.equal((await post(a.buyer, `/api/orders/${order.id}/cancel`, {})).status, 200);
  assert.equal((await myGift(a.buyer, id))?.status, 'REDEEMED');
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 0 });
  assert.equal((await addGiftToCart(a.buyer, id)).status, 200);
  const reorder = await placeOrder(a.buyer);
  assert.equal(reorder.order_kind, 'gift', 'only the gift this time');
  assert.equal(giftRow(raw, id).order_seq, 2);

  // ---- 11. Confirmed (stock deducted once) and delivered: «تم التسليم». -----
  assert.equal((await patch(a.admin, `/api/admin/orders/${reorder.id}`, { status: 'confirmed' })).status, 200);
  await deductOrderStock(asD1(raw), reorder.id, null);
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 2, reserved: 0 }, 'one unit left the shelf, through the order');
  assert.equal((await patch(a.admin, `/api/admin/orders/${reorder.id}`, { status: 'delivered' })).status, 200);
  card = await myGift(a.buyer, id);
  assert.equal(card.status, 'FULFILLED');
  assert.equal(card.order.id, reorder.id);
  assert.equal((await json(await addGiftToCart(a.buyer, id))).code, 'GIFT_ALREADY_ORDERED');

  // ---- 12. The admin's timeline names every step, and the note is intact. --
  const detail = await json(await get(a.admin, `/api/gifts/admin/grants/${id}`));
  assert.equal(detail.grant.note, NOTE);
  assert.equal(detail.grant.status, 'FULFILLED');
  assert.deepEqual(detail.audit.map((x: J) => x.action), [
    'gift.grant',
    'gift.choose',
    'gift.redeem',
    'gift.cart_add',
    'gift.order',
    'gift.order_cancelled',
    'gift.cart_add',
    'gift.order',
    'gift.delivered',
  ]);
  assert.equal(detail.audit[0].actor.id, BOSS.id);
  assert.equal(detail.audit[1].actor.id, 'buyer');
  const fulfilledList = await json(await get(a.admin, '/api/gifts/admin/grants?status=FULFILLED&q=sara'));
  assert.deepEqual(fulfilledList.grants.map((g: J) => g.id), [id]);
});
