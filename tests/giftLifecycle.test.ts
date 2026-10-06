/**
 * AFTER THE ORDER — every door that cancels, delivers or re-opens an order
 * moves its gift the same way (docs/GIFTS_QUICK_BUY.md D5, S9; migration 0175
 * triggers on `orders.status`).
 *
 *   cancelled (customer, admin status, admin stage move) → the gift was never
 *              received: back to «تم استرداد الهدية», orderable again as the
 *              next attempt;
 *   delivered  → «تم التسليم» (fulfilled); a mis-tapped delivery undone takes
 *              the gift back to «تم طلب هذه الهدية»;
 *   re-opening a cancelled order that held a gift is refused — the gift may
 *   already be in a new order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, row } from './fixtures/app';
import {
  NOZZLE_04_RED,
  addGiftToCart,
  apps,
  auditActions,
  giftInCart,
  giftRow,
  giftWorld,
  json,
  myGift,
  optionStock,
  patch,
  placeOrder,
  post,
  send,
} from './fixtures/giftWorld';

test('a customer cancel returns the gift to «redeemed», and it is ordered again as the next attempt', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  const first = await placeOrder(a.buyer);
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 1 });

  const res = await post(a.buyer, `/api/orders/${first.id}/cancel`, {});
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  const g = giftRow(raw, id);
  assert.equal(g.state, 'redeemed');
  assert.equal(g.order_id, null);
  assert.equal(g.order_item_id, null);
  assert.equal(g.order_seq, 1, 'the attempt counter is kept');
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 0 }, 'the reservation went back through the ordinary path');
  assert.equal((await myGift(a.buyer, id))?.status, 'REDEEMED');
  const trail = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'gift.order_cancelled' AND target = ?", id)!.detail);
  assert.equal(trail.order_id, first.id);
  assert.equal(trail.to, 'redeemed');

  // Ordered again: attempt 2, a new line, the old cancelled line untouched.
  assert.equal((await addGiftToCart(a.buyer, id)).status, 200);
  const second = await placeOrder(a.buyer);
  assert.notEqual(second.id, first.id);
  assert.equal(row(raw, 'SELECT gift_order_seq FROM order_items WHERE order_id = ?', second.id)?.gift_order_seq, 2);
  assert.equal(row(raw, 'SELECT gift_order_seq FROM order_items WHERE order_id = ?', first.id)?.gift_order_seq, 1);
  assert.equal(giftRow(raw, id).state, 'ordered');
  assert.equal(giftRow(raw, id).order_id, second.id);
  assert.deepEqual(auditActions(raw, id), ['gift.grant', 'gift.redeem', 'gift.order', 'gift.order_cancelled', 'gift.order']);
});

test('an admin cancel — by status or by stage move — returns the gift too', async () => {
  for (const door of ['status', 'stage'] as const) {
    const raw = giftWorld();
    const a = apps(raw);
    const id = await giftInCart(a);
    const order = await placeOrder(a.buyer);
    const res =
      door === 'status'
        ? await patch(a.admin, `/api/admin/orders/${order.id}`, { status: 'cancelled', adminNote: 'customer asked' })
        : await patch(a.admin, `/api/admin/orders/${order.id}/stage`, { stage: 'cancelled', note: 'customer asked' });
    const out = await json(res);
    assert.equal(res.status, 200, `${door}: ${JSON.stringify(out)}`);
    assert.equal(row(raw, 'SELECT status FROM orders WHERE id = ?', order.id)?.status, 'cancelled');
    assert.equal(giftRow(raw, id).state, 'redeemed', door);
    assert.equal(giftRow(raw, id).order_id, null, door);
    assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 0 }, door);
    assert.equal((await addGiftToCart(a.buyer, id)).status, 200, `${door}: orderable again`);
  }
});

test('delivered → «تم التسليم»; a mis-tapped delivery undone takes the gift back; a cancel after that still returns it', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  const order = await placeOrder(a.buyer);

  const delivered = await patch(a.admin, `/api/admin/orders/${order.id}`, { status: 'delivered' });
  assert.equal(delivered.status, 200, JSON.stringify(await json(delivered)));
  assert.equal(giftRow(raw, id).state, 'fulfilled');
  assert.ok(giftRow(raw, id).fulfilled_at);
  const card = await myGift(a.buyer, id);
  assert.equal(card?.status, 'FULFILLED');
  assert.equal(card?.order.id, order.id, 'the delivered order is still linked');

  // The one-step-back correction of a mis-tap.
  const undone = await patch(a.admin, `/api/admin/orders/${order.id}`, { status: 'shipped' });
  assert.equal(undone.status, 200, JSON.stringify(await json(undone)));
  assert.equal(giftRow(raw, id).state, 'ordered');
  assert.equal(giftRow(raw, id).fulfilled_at, null);

  const cancelled = await patch(a.admin, `/api/admin/orders/${order.id}`, { status: 'cancelled' });
  assert.equal(cancelled.status, 200, JSON.stringify(await json(cancelled)));
  assert.equal(giftRow(raw, id).state, 'redeemed');
  assert.deepEqual(auditActions(raw, id).slice(-3), ['gift.delivered', 'gift.undelivered', 'gift.order_cancelled']);
});

test('a cancelled order that held a gift cannot be re-opened by any admin door', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  const order = await placeOrder(a.buyer);
  await post(a.buyer, `/api/orders/${order.id}/cancel`, {});
  assert.equal(giftRow(raw, id).state, 'redeemed');

  for (const status of ['pending', 'confirmed', 'processing']) {
    const res = await patch(a.admin, `/api/admin/orders/${order.id}`, { status });
    const out = await json(res);
    assert.equal(res.status, 409, `${status}: ${JSON.stringify(out)}`);
    assert.equal(out.code, 'GIFT_ORDER_REOPEN_REFUSED');
  }
  // The stage door: a customer cancel leaves the stage where it was, so the
  // next stage forward is a «legal» move that would re-open the order.
  const forward = await patch(a.admin, `/api/admin/orders/${order.id}/stage`, { stage: 'confirmed' });
  const forwardOut = await json(forward);
  assert.equal(forward.status, 409, JSON.stringify(forwardOut));
  assert.equal(forwardOut.code, 'GIFT_ORDER_REOPEN_REFUSED');
  assert.equal(row(raw, 'SELECT status FROM orders WHERE id = ?', order.id)?.status, 'cancelled');

  // An order cancelled BY the stage door, re-opened by it.
  const id2 = await giftInCart(a);
  const order2 = await placeOrder(a.buyer);
  assert.equal((await patch(a.admin, `/api/admin/orders/${order2.id}/stage`, { stage: 'cancelled' })).status, 200);
  for (const stage of ['received', 'confirmed']) {
    const res = await patch(a.admin, `/api/admin/orders/${order2.id}/stage`, { stage });
    const out = await json(res);
    assert.equal(res.status, 409, `${stage}: ${JSON.stringify(out)}`);
    assert.equal(out.code, 'GIFT_ORDER_REOPEN_REFUSED');
  }
  assert.equal(row(raw, 'SELECT status, stage FROM orders WHERE id = ?', order2.id)?.stage, 'cancelled');
  assert.equal(giftRow(raw, id2).state, 'redeemed');
  assert.equal(giftRow(raw, id).state, 'redeemed', 'the gift stayed with its owner');
  // The database refuses it for every other door as well.
  assert.throws(() => raw.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(order.id), /GIFT_ORDER_REOPEN_REFUSED/);

  // An order with NO gift line re-opens exactly as before.
  const plainRaw = giftWorld();
  const p = apps(plainRaw);
  await post(p.buyer, '/api/cart/items', { productId: 'p_nozzle', optionValueIds: ['v_04'], colorId: 'c_red', qty: 1 });
  const plain = await placeOrder(p.buyer);
  await post(p.buyer, `/api/orders/${plain.id}/cancel`, {});
  const reopened = await patch(p.admin, `/api/admin/orders/${plain.id}`, { status: 'pending' });
  assert.equal(reopened.status, 200, JSON.stringify(await json(reopened)));
});

test('deleting a cancelled gift order keeps the gift, waiting for its owner', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a, NOZZLE_04_RED);
  const order = await placeOrder(a.buyer);
  await post(a.buyer, `/api/orders/${order.id}/cancel`, {});
  const res = await send(a.admin, 'DELETE', `/api/admin/orders/${order.id}`);
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders WHERE id = ?', order.id), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', order.id), 0);
  const g = giftRow(raw, id);
  assert.equal(g.state, 'redeemed');
  assert.equal(g.order_id, null);
  assert.equal((await addGiftToCart(a.buyer, id)).status, 200);
  const again = await placeOrder(a.buyer);
  assert.equal(row(raw, 'SELECT gift_order_seq FROM order_items WHERE order_id = ?', again.id)?.gift_order_seq, 2);
});
