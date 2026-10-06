/**
 * THE GIFT IN THE FINANCE WORKSPACE (docs/GIFTS_QUICK_BUY.md §4, D15).
 *
 *   «Orders carry order_kind; finance workspace lists and filters it; the gift
 *    line is a 0 line with its cost.»
 *
 * A delivered gift order reads as what it is — `order_kind: 'gift'`, no goods
 * revenue, the product's cost recorded on its line — and the delivered-orders
 * list can be narrowed to one kind. Real checkout, real finance routes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, get, json, row, stubApp } from './fixtures/app';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { apps, giftInCart, giftWorld, paidLine, placeOrder, type J } from './fixtures/giftWorld';

const period = 'from=2026-10-01&to=2026-10-06';

test('a delivered gift order is listed with its kind, filtered by it, and its line is 0 with its cost', async () => {
  const raw = giftWorld();
  // The model's cost, so the gift line's cost is a recorded fact.
  raw.exec("UPDATE products SET product_cost_iqd = 22000 WHERE id IN ('p_nozzle', 'p_plain')");
  raw.exec("UPDATE users SET admin_scope = 'full' WHERE id = 'boss'");
  const a = apps(raw);

  await giftInCart(a);
  const giftOrder = await placeOrder(a.buyer);
  assert.equal(giftOrder.order_kind, 'gift');
  paidLine(raw, 'ci_plain', 'p_plain', { qty: 1 });
  const paidOrder = await placeOrder(a.buyer);
  assert.equal(paidOrder.order_kind, 'normal');
  for (const id of [giftOrder.id, paidOrder.id]) {
    raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = '2026-10-03T10:00:00Z' WHERE id = ?").run(id);
  }

  // THE LINE: an ordinary order line at 0 that keeps what the product cost.
  const line = row<J>(raw, 'SELECT unit_price_iqd, line_total_iqd, cost_iqd, gift_entitlement_id FROM order_items WHERE order_id = ?', giftOrder.id)!;
  assert.deepEqual([line.unit_price_iqd, line.line_total_iqd, line.cost_iqd], [0, 0, 22000]);
  assert.ok(line.gift_entitlement_id);

  const finance = stubApp(asD1(raw), { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (app) =>
    app.route('/f', adminFinanceWorkspaceRoutes)
  );
  const list = async (q = '') => {
    const res = await get(finance, `/f/orders?${period}${q}`);
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    return body.orders as J[];
  };

  const every = await list();
  assert.deepEqual(new Set(every.map((o) => o.id)), new Set([giftOrder.id, paidOrder.id]));
  const gift = every.find((o) => o.id === giftOrder.id)!;
  assert.equal(gift.order_kind, 'gift', 'the list says what made the order');
  assert.equal(gift.net_goods_iqd, 0, 'a gift sells nothing');
  assert.equal(gift.cogs_iqd, 22000, 'and its cost is still counted');
  assert.equal(every.find((o) => o.id === paidOrder.id)!.order_kind, 'normal');

  assert.deepEqual((await list('&kind=gift')).map((o) => o.id), [giftOrder.id]);
  assert.deepEqual((await list('&kind=normal')).map((o) => o.id), [paidOrder.id]);
  assert.deepEqual(await list('&kind=quick_buy'), []);
  assert.equal((await get(finance, `/f/orders?${period}&kind=free`)).status, 400, 'an unknown kind is refused, never ignored');
});
