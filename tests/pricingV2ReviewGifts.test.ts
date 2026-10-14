/**
 * PRICING V2 CLEAN START — GIFTS (review of feat/pricing-v2-core, 2026-10-14).
 *
 * 1. A product no customer sees (still «يحتاج تسعيرًا») is never a NEW gift:
 *    the admin's grant and level item doors refuse it (GIFT_PRODUCT_INACTIVE).
 * 2. A gift already granted on such a product is still honoured, but its new
 *    order line carries no figure of the old dinar ladder: the value frozen at
 *    the grant, every rung at that value, no member price, and the cost unknown
 *    (`cost_iqd` NULL, `cost_basis` 'unpriced') — never the legacy cost cell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, row, stubApp, withoutTriggers } from './fixtures/app';
import {
  BOSS,
  BUYER,
  PLAIN,
  apps,
  freshKey,
  giftInCart,
  giftWorld,
  mountGifts,
  placeOrder,
  type J,
} from './fixtures/giftWorld';

/** Take a product back to «يحتاج تسعيرًا» as the clean start leaves an old one: no V2 method, no V2 result. */
function unpublish(raw: DatabaseSync, pid: string): void {
  // A fixture stages the older state through every guard of these tables (never the code under test).
  const guards = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('product_pricing_state', 'pricing_v2_sku_results', 'product_sku_prices', 'products')").all() as Array<{ name: string }>).map((t) => t.name);
  withoutTriggers(
    raw,
    guards,
    `DELETE FROM pricing_v2_sku_results WHERE product_id = '${pid}';
     DELETE FROM product_sku_prices WHERE product_id = '${pid}';
     UPDATE product_pricing_state SET pricing_method = NULL, mode = 'manual' WHERE product_id = '${pid}';
     UPDATE products SET price_iqd = 99000, product_cost_iqd = 22000 WHERE id = '${pid}';`
  );
}

test('a gift already granted on a product still «يحتاج تسعيرًا» orders with its frozen value and an unknown cost — never the old ladder', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  // Granted and redeemed while the product was published (the V2 price reproduces 15,000 at the fixture U).
  const giftId = await giftInCart(a, PLAIN);
  const frozen = JSON.parse(String(row<{ s: string }>(raw, 'SELECT gift_snapshot AS s FROM gift_entitlements WHERE id = ?', giftId)!.s)).value_iqd as number;
  assert.equal(frozen, 15000);
  // The product goes back to «يحتاج تسعيرًا»; its old ladder and legacy cost cell say other things.
  unpublish(raw, 'p_plain');

  const buyer = stubApp(asD1(raw), BUYER, mountGifts, { publishV2: false });
  const cart = await json(await get(buyer, '/api/cart'));
  const line = (cart.items as J[]).find((i) => i.kind === 'gift')!;
  assert.equal(line.gift.value_iqd, 15000, 'the cart shows the value frozen at the grant');
  assert.doesNotMatch(JSON.stringify(cart), /99000|22000/);

  const order = await placeOrder(buyer);
  const item = row<J>(raw, 'SELECT cost_iqd, cost_basis, estimated_cost_iqd, pricing_snapshot, unit_price_iqd FROM order_items WHERE order_id = ?', order.id)!;
  assert.equal(item.unit_price_iqd, 0);
  assert.equal(item.cost_iqd, null, 'the legacy cost cell never feeds a new line');
  assert.equal(item.cost_basis, 'unpriced');
  assert.equal(item.estimated_cost_iqd ?? null, null, 'no V2 result: no estimate');
  const snap = JSON.parse(String(item.pricing_snapshot)) as J;
  assert.equal(snap.regular_iqd, 15000);
  assert.equal(snap.gift.value_iqd, 15000);
  assert.equal(snap.price_source, 'base', 'not the old ladder');
  assert.equal(snap.pro_iqd, null);
  assert.doesNotMatch(String(item.pricing_snapshot), /99000|22000/);
});

test('a product still «يحتاج تسعيرًا» is never a new gift: the grant and the level item doors refuse it', async () => {
  const raw = giftWorld();
  // Published once (the seeded catalogue), then the plain product goes back to «يحتاج تسعيرًا».
  await json(await get(apps(raw).buyer, '/api/cart'));
  unpublish(raw, 'p_plain');
  const admin = stubApp(asD1(raw), BOSS, mountGifts, { publishV2: false });
  const grant = await post(admin, '/api/gifts/admin/grants', {
    userId: 'buyer',
    reason: 'admin_gift',
    idempotencyKey: freshKey(),
    mode: 'product',
    level: 1,
    product: { ...PLAIN, qty: 1 },
  });
  const g = await json(grant);
  assert.equal(grant.status, 400, JSON.stringify(g));
  assert.equal(g.code, 'GIFT_PRODUCT_INACTIVE');
  const item = await post(admin, '/api/gifts/admin/levels/2/items', { ...PLAIN });
  const i = await json(item);
  assert.equal(item.status, 400, JSON.stringify(i));
  assert.equal(i.code, 'GIFT_PRODUCT_INACTIVE');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM gift_entitlements WHERE gift_product_id = 'p_plain'").get()!.n, 0);
});
