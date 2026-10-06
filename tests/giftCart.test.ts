/**
 * THE REVIEW GIFT IN THE REAL CART (docs/REVIEWS_GIFTS.md §6.3, owner brief
 * §13 and §18) — lane S3.
 *
 *   «عند الضغط على إضافة الهدية إلى السلة: تحقق أن entitlement يخص المستخدم.
 *    تحقق أنه مسترد. تحقق أنه لم يتحول إلى Order سابقًا. تحقق أنه غير موجود
 *    بالفعل في Cart. أضفه مرة واحدة فقط.»
 *
 * Every request goes through the real cart and checkout routes on a fully
 * migrated database; the gift rows are the ones lane S2 leaves behind after the
 * code is redeemed (tests/fixtures/giftCommerce.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, row, all, count, json, post, patch, get, send } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import {
  STRANGER,
  NOZZLE_04_RED,
  PLATE_AIR,
  giftWorld,
  grantGift,
  shopApp,
  orderBody,
  paidLine,
} from './fixtures/giftCommerce';

const giftLines = (raw: ReturnType<typeof giftWorld>) =>
  all<Record<string, unknown>>(raw, 'SELECT * FROM cart_items WHERE gift_entitlement_id IS NOT NULL ORDER BY created_at');

test('the gift is added to the cart once at 0 IQD', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1', level: 4 });
  const app = shopApp(asD1(raw));

  const res = await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.already_in_cart, undefined, 'a first add is not a replay');

  // ONE row, written by the server from the entitlement's frozen line.
  const lines = giftLines(raw);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.user_id, 'buyer');
  assert.equal(line.product_id, 'p_nozzle');
  assert.equal(line.qty, 1);
  assert.equal(line.option_id, 'v_04');
  assert.equal(line.option_value_ids, '["v_04"]');
  assert.equal(line.color_id, 'c_red');
  assert.equal(line.fulfillment_type, 'direct_sale');
  assert.equal(line.transport_method, '');
  assert.equal(line.warranty_plan_id, '');
  assert.equal(line.shipping_method_id, 'gift:ge1', 'the discriminator keeps it out of every ordinary line identity');
  assert.equal(line.gift_entitlement_id, 'ge1');

  // The cart says it: a locked gift line at 0 with its value beside it.
  const item = (body.items as Array<Record<string, any>>).find((i) => i.kind === 'gift');
  assert.ok(item, 'the gift line is in the cart payload');
  assert.equal(item.locked, true);
  assert.equal(item.unit_price_iqd, 0);
  assert.equal(item.breakdown.applied_iqd, 0);
  assert.equal(item.breakdown.unit_subtotal_iqd, 0);
  assert.equal(item.breakdown.regular_iqd, 40000, 'the gift keeps its value visible');
  assert.deepEqual(item.gift, { entitlement_id: 'ge1', level: 4, value_iqd: 40000 });
  assert.equal(item.qty, 1);
  assert.equal(item.support_gift_eligible, false);
  assert.deepEqual(item.warranty_plans, []);
  assert.deepEqual(item.options, [], 'no option editor');
  assert.deepEqual(item.colors, [], 'no colour editor');
  assert.equal(item.availability.mode, 'direct_sale');
  assert.equal(item.availability.reason, null);
  assert.equal(item.shipping_method_id, '', 'the discriminator is server identity, never echoed');

  // GET /api/cart answers the same, and the badge counts the gift.
  const cart = await json(await get(app, '/api/cart'));
  const again = (cart.items as Array<Record<string, any>>).find((i) => i.kind === 'gift');
  assert.equal(again?.unit_price_iqd, 0);
  assert.equal(cart.item_count, 1);
  assert.equal(cart.shipping_type, 'direct');
  assert.deepEqual(cart.membership?.lines ?? [], [], 'a gift line feeds no membership benefit');
  assert.equal(cart.membership?.merchandise_iqd ?? 0, 0, 'and adds nothing to the merchandise');

  // The entitlement is NOT consumed by the cart: it is still ready to order.
  assert.equal(row(raw, 'SELECT state FROM gift_entitlements WHERE id = ?', 'ge1')?.state, 'redeemed_ready_to_order');
});

test('a second add, sequential or concurrent, makes no second line', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  const app = shopApp(asD1(raw));

  assert.equal((await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' })).status, 200);
  const second = await json(await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' }));
  assert.equal(second.success, true);
  assert.equal(second.already_in_cart, true, 'a second press answers «already in the cart»');
  assert.equal(giftLines(raw).length, 1);

  // A CONCURRENT double tap: both requests read «no line yet», both validate,
  // both write — the UNIQUE index lets one INSERT through and the other
  // answers already_in_cart. The serial adapter is D1's single-writer model.
  const raw2 = giftWorld();
  grantGift(raw2, { id: 'ge2' });
  const app2 = shopApp(serialD1(raw2));
  const [a, b] = await Promise.all([
    post(app2, '/api/cart/gift-items', { entitlementId: 'ge2' }),
    post(app2, '/api/cart/gift-items', { entitlementId: 'ge2' }),
  ]);
  const [ja, jb] = [await json(a), await json(b)];
  assert.equal(a.status, 200, JSON.stringify(ja));
  assert.equal(b.status, 200, JSON.stringify(jb));
  assert.equal([ja.already_in_cart, jb.already_in_cart].filter((x) => x === true).length, 1, 'exactly one of the two was the replay');
  assert.equal(count(raw2, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', 'ge2'), 1);
});

test('removing the gift line returns it to ready; adding again works', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  const app = shopApp(asD1(raw));

  await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' });
  const lineId = String(giftLines(raw)[0].id);

  const removed = await json(await send(app, 'DELETE', `/api/cart/items/${lineId}`));
  assert.equal(removed.success, true);
  assert.equal(giftLines(raw).length, 0);
  // «in cart» is DERIVED — removing the row is the whole transition; no state
  // was written either way.
  assert.equal(row(raw, 'SELECT state FROM gift_entitlements WHERE id = ?', 'ge1')?.state, 'redeemed_ready_to_order');

  const readded = await json(await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' }));
  assert.equal(readded.success, true);
  assert.equal(readded.already_in_cart, undefined);
  assert.equal(giftLines(raw).length, 1);

  // «Empty the cart» does the same.
  await send(app, 'DELETE', '/api/cart');
  assert.equal(giftLines(raw).length, 0);
  assert.equal(row(raw, 'SELECT state FROM gift_entitlements WHERE id = ?', 'ge1')?.state, 'redeemed_ready_to_order');
  assert.equal((await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' })).status, 200);
  assert.equal(giftLines(raw).length, 1);
});

test('adding an ordered gift is refused (GIFT_ALREADY_ORDERED)', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  const app = shopApp(asD1(raw));
  await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' });
  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(row(raw, 'SELECT state FROM gift_entitlements WHERE id = ?', 'ge1')?.state, 'ordered');

  // The button is gone on /gifts; the API refuses a hand-made call too.
  const res = await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' });
  const body = await json(res);
  assert.equal(res.status, 409);
  assert.equal(body.code, 'GIFT_ALREADY_ORDERED');
  assert.equal(giftLines(raw).length, 0, 'nothing was added back');

  // A delivered (fulfilled) gift is answered the same way.
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), placed.order.id);
  assert.equal(row(raw, 'SELECT state FROM gift_entitlements WHERE id = ?', 'ge1')?.state, 'fulfilled');
  const again = await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'GIFT_ALREADY_ORDERED');
});

test('the door checks the owner, the redemption, the choice and the state', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge_mine' });
  grantGift(raw, { id: 'ge_code', state: 'code_issued' });
  grantGift(raw, { id: 'ge_nochoice', line: null });
  grantGift(raw, { id: 'ge_cancelled', state: 'cancelled' });
  const mine = shopApp(asD1(raw));
  const stranger = shopApp(asD1(raw), STRANGER);

  const refuse = async (app: ReturnType<typeof shopApp>, id: string) => {
    const res = await post(app, '/api/cart/gift-items', { entitlementId: id });
    return { status: res.status, code: (await json(res)).code as string };
  };
  // Another account's gift and an unknown id answer alike: nothing is disclosed.
  assert.deepEqual(await refuse(stranger, 'ge_mine'), { status: 404, code: 'GIFT_NOT_FOUND' });
  assert.deepEqual(await refuse(mine, 'ge_nope'), { status: 404, code: 'GIFT_NOT_FOUND' });
  assert.deepEqual(await refuse(mine, 'ge_code'), { status: 409, code: 'GIFT_NOT_REDEEMED' });
  assert.deepEqual(await refuse(mine, 'ge_nochoice'), { status: 409, code: 'GIFT_CHOICE_REQUIRED' });
  assert.deepEqual(await refuse(mine, 'ge_cancelled'), { status: 409, code: 'GIFT_NOT_AVAILABLE' });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0, 'no refusal wrote a line');
  // The stranger's own cart is untouched as well.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'other'"), 0);
});

test('nothing in the body but the entitlement is read: a client price, quantity or product is ignored', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  const app = shopApp(asD1(raw));
  const res = await post(app, '/api/cart/gift-items', {
    entitlementId: 'ge1',
    productId: 'p_plate',
    qty: 5,
    optionValueIds: ['v_06'],
    colorId: 'c_blue',
    unit_price_iqd: 0,
    price_iqd: 0,
  });
  assert.equal(res.status, 200);
  const line = giftLines(raw)[0];
  assert.deepEqual(
    [line.product_id, line.qty, line.option_value_ids, line.color_id],
    ['p_nozzle', 1, '["v_04"]', 'c_red'],
    'the frozen line, whatever the body says'
  );

  // The ORDINARY door never makes a line free: a gift id in its body is not
  // a column it reads, and the price comes from the resolver.
  const paid = await json(
    await post(app, '/api/cart/items', {
      productId: 'p_nozzle',
      optionValueIds: ['v_04'],
      colorId: 'c_blue',
      qty: 1,
      gift_entitlement_id: 'ge1',
      giftEntitlementId: 'ge1',
      unit_price_iqd: 0,
    })
  );
  assert.equal(paid.success, true, JSON.stringify(paid));
  const blue = row<Record<string, unknown>>(raw, "SELECT * FROM cart_items WHERE color_id = 'c_blue'")!;
  assert.equal(blue.gift_entitlement_id, null);
  assert.equal(blue.shipping_method_id, '');
  const blueItem = (paid.items as Array<Record<string, any>>).find((i) => i.color_id === 'c_blue')!;
  assert.equal(blueItem.unit_price_iqd, 40000);
  assert.equal(blueItem.kind, undefined);
});

test('the gift line never merges with a paid line of the same product, and the paid doors cannot edit it', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  const app = shopApp(asD1(raw));

  // The SAME product, model and colour, bought, before and after the gift.
  const add = () => post(app, '/api/cart/items', { productId: 'p_nozzle', optionValueIds: ['v_04'], colorId: 'c_red', qty: 1 });
  assert.equal((await add()).status, 200);
  assert.equal((await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' })).status, 200);
  const cart = await json(await add());
  assert.equal(cart.success, true, JSON.stringify(cart));

  const rows = all<Record<string, unknown>>(raw, 'SELECT qty, shipping_method_id, gift_entitlement_id FROM cart_items ORDER BY shipping_method_id');
  assert.deepEqual(
    rows.map((r) => [r.qty, r.shipping_method_id, r.gift_entitlement_id]),
    [[2, '', null], [1, 'gift:ge1', 'ge1']],
    'the paid line merged with itself; the gift line stayed 1 and apart'
  );
  const items = cart.items as Array<Record<string, any>>;
  assert.deepEqual(
    items.map((i) => [i.kind ?? 'ordinary', i.qty, i.unit_price_iqd]).sort(),
    [['gift', 1, 0], ['ordinary', 2, 40000]]
  );

  // The paid PATCH door refuses every edit of the gift line, by name.
  const giftId = String(row(raw, 'SELECT id FROM cart_items WHERE gift_entitlement_id = ?', 'ge1')!.id);
  for (const change of [{ qty: 2 }, { colorId: 'c_blue' }, { optionValueIds: ['v_06'] }, { warrantyPlanId: 'w1' }, { transportMethod: 'air' }, {}]) {
    const res = await patch(app, `/api/cart/items/${giftId}`, change);
    assert.equal(res.status, 409, JSON.stringify(change));
    assert.equal((await json(res)).code, 'GIFT_LINE_LOCKED');
  }
  assert.deepEqual(
    { ...row(raw, 'SELECT qty, color_id, option_value_ids FROM cart_items WHERE id = ?', giftId) },
    { qty: 1, color_id: 'c_red', option_value_ids: '["v_04"]' }
  );
});

test('the database refuses a gift line nobody verified', () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  grantGift(raw, { id: 'ge_other', userId: 'other' });
  grantGift(raw, { id: 'ge_code', state: 'code_issued' });
  const insert = (id: string, user: string, product: string, qty: number, smid: string, ent: string) => () =>
    raw
      .prepare(
        `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,qty,gift_entitlement_id)
         VALUES (?,?,?,'v_04','["v_04"]','c_red',?,?,?)`
      )
      .run(id, user, product, smid, qty, ent);
  assert.throws(insert('x1', 'buyer', 'p_nozzle', 2, 'gift:ge1', 'ge1'), /GIFT_NOT_ORDERABLE/, 'quantity 2');
  assert.throws(insert('x2', 'buyer', 'p_nozzle', 1, '', 'ge1'), /GIFT_NOT_ORDERABLE/, 'no discriminator');
  assert.throws(insert('x3', 'buyer', 'p_nozzle', 1, 'gift:ge_other', 'ge_other'), /GIFT_NOT_ORDERABLE/, 'another account’s gift');
  assert.throws(insert('x4', 'buyer', 'p_plate', 1, 'gift:ge1', 'ge1'), /GIFT_NOT_ORDERABLE/, 'another product');
  assert.throws(insert('x5', 'buyer', 'p_nozzle', 1, 'gift:ge_code', 'ge_code'), /GIFT_NOT_ORDERABLE/, 'an unredeemed gift');
  insert('ok', 'buyer', 'p_nozzle', 1, 'gift:ge1', 'ge1')();
  assert.throws(insert('dup', 'buyer', 'p_nozzle', 1, 'gift:ge1', 'ge1'), /UNIQUE/, 'one line per entitlement');
});

test('an unavailable gift shows as blocked instead of vanishing, and is refused at the door', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  const app = shopApp(asD1(raw));
  await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' });

  raw.prepare("UPDATE products SET status = 'hidden' WHERE id = 'p_nozzle'").run();
  const cart = await json(await get(app, '/api/cart'));
  const item = (cart.items as Array<Record<string, any>>).find((i) => i.kind === 'gift');
  assert.ok(item, 'still listed');
  assert.equal(item.availability.mode, 'unavailable');
  assert.equal(item.availability.reason, 'GIFT_NOT_AVAILABLE');
  assert.equal(item.unit_price_iqd, 0);

  const res = await post(app, '/api/orders/quote', { addressId: 'addr_b', deliveryMethodId: 'standard', paymentMethodId: 'cash' });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'GIFT_NOT_AVAILABLE');

  // Removing it is always possible.
  const id = String(row(raw, 'SELECT id FROM cart_items WHERE gift_entitlement_id = ?', 'ge1')!.id);
  assert.equal((await send(app, 'DELETE', `/api/cart/items/${id}`)).status, 200);
});

test('a sold-out gift and a stale cart line are refused with their own codes', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge_out', line: { ...NOZZLE_04_RED, optionValueIds: ['v_06'] } });
  grantGift(raw, { id: 'ge1' });
  const app = shopApp(asD1(raw));

  const out = await post(app, '/api/cart/gift-items', { entitlementId: 'ge_out' });
  assert.equal(out.status, 400);
  assert.equal((await json(out)).code, 'OUT_OF_STOCK');

  // A line whose row no longer matches the entitlement's frozen line (written
  // by hand around the door) is never priced at 0.
  await post(app, '/api/cart/gift-items', { entitlementId: 'ge1' });
  raw.prepare("UPDATE cart_items SET color_id = 'c_blue' WHERE gift_entitlement_id = 'ge1'").run();
  const cart = await json(await get(app, '/api/cart'));
  const item = (cart.items as Array<Record<string, any>>).find((i) => i.kind === 'gift');
  assert.equal(item?.availability.reason, 'GIFT_NOT_ORDERABLE');
  const quote = await post(app, '/api/orders/quote', { addressId: 'addr_b', deliveryMethodId: 'standard', paymentMethodId: 'cash' });
  assert.equal(quote.status, 409);
  assert.equal((await json(quote)).code, 'GIFT_NOT_ORDERABLE');
  const order = await post(app, '/api/orders', orderBody());
  assert.equal(order.status, 409);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
});

test('the one-shipping-type rule holds for a gift, and replaceCart empties the cart in the same batch', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge_direct' });
  grantGift(raw, { id: 'ge_pre', line: PLATE_AIR });
  const app = shopApp(asD1(raw));

  // A paid pre-order line by air holds the cart; the direct gift conflicts.
  paidLine(raw, 'ci_plate', 'p_plate', { optionValueIds: ['v_pei'], colorId: 'c_black', fulfillmentType: 'pre_order', transport: 'air' });
  const conflict = await post(app, '/api/cart/gift-items', { entitlementId: 'ge_direct' });
  const body = await json(conflict);
  assert.equal(conflict.status, 400);
  assert.equal(body.code, 'CART_SHIPPING_CONFLICT');
  assert.deepEqual(body.details, { cart_shipping_type: 'preorder_air', incoming_shipping_type: 'direct' });

  // The pre-order gift by air sits beside it.
  assert.equal((await post(app, '/api/cart/gift-items', { entitlementId: 'ge_pre' })).status, 200);

  // «Empty the cart and add this»: the paid line AND the other gift's line go,
  // the direct gift lands — one transaction. The removed gift is ready again.
  const replaced = await json(await post(app, '/api/cart/gift-items', { entitlementId: 'ge_direct', replaceCart: true }));
  assert.equal(replaced.success, true, JSON.stringify(replaced));
  assert.deepEqual(
    all<{ gift_entitlement_id: string | null }>(raw, 'SELECT gift_entitlement_id FROM cart_items').map((r) => r.gift_entitlement_id),
    ['ge_direct']
  );
  assert.equal(row(raw, 'SELECT state FROM gift_entitlements WHERE id = ?', 'ge_pre')?.state, 'redeemed_ready_to_order');
});
