/**
 * THE FILAMENT COUPON ON A SALE PRICE (owner, 2026-11-06; migration 0226;
 * docs/DECISIONS.md row 302). eSUN PLA+ is the one filament the weekly coupon
 * names, and it is on sale at $15 = 24,000 IQD. The owner chose: 15% comes off
 * the 24,000, the customer pays 20,400, and a switch can turn it off for new coupons.
 *
 * Real migrations, real sweep, real cart and checkout routers; only the session is stubbed.
 * Run: node --import tsx --test tests/rewardsCouponOnSale.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, row, stubApp, type Mount } from './fixtures/app';
import { giftWorld, json, orderBody, paidLine, post, quoteBody, type J } from './fixtures/giftWorld';
import type { Env } from '../worker/lib/types';
import { runOrderDeliveredEffects } from '../worker/lib/orderDeliveredEffects';
import { REWARD_CONFIG_KEY, getRewardConfigStrict } from '../worker/lib/rewards/config';
import { issueWeeklyRewards } from '../worker/lib/rewards/coupons';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';

const ESUN = 'p_esun';
const mount: Mount = (a) => {
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
};
const envOf = (raw: DatabaseSync) => ({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' }) as unknown as Env;
const appOf = (raw: DatabaseSync) => stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, mount, { publishV2: 'always' });

/** A delivered printer holding its coupons, and eSUN at 27,250 with the live sale at 24,000 in the cart. */
async function world(config: Record<string, unknown>): Promise<{ raw: DatabaseSync; code: string }> {
  const raw = giftWorld();
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,name_ckb,is_printer_catalog)
      VALUES ('rw_printers',NULL,'rw-printers','طابعات','Printers','چاپکەرەکان',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_printer','reward-printer','A1 mini','طابعة A1 mini','چاپکەری A1 mini',200000,'active',20,'[]','[]','direct_sale','["direct_sale"]','[]','[]','tracked'),
             ('${ESUN}','esun-pla-plus','eSUN PLA+','فلامنت eSUN','فیلامێنتی eSUN',27250,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','[]','tracked');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','rw_printers',0);
  `);
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(
    REWARD_CONFIG_KEY,
    JSON.stringify({ enabled: true, valid_days: 7, free_shipping: { enabled: true }, filament: { enabled: true, percent: 15, max_discount_iqd: 25000, product_ids: [ESUN], ...config }, shop: {} })
  );
  raw
    .prepare(
      `INSERT OR REPLACE INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,offer_price_mode,offer_price_iqd,locked_preview,active)
       VALUES ('product',?, 'ofw_esun', NULL, NULL, '[]', 'fixed', 24000, 1, 1)`
    )
    .run(ESUN);
  const app = appOf(raw);
  paidLine(raw, 'ci_printer', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  const placed = await json(await post(app, '/api/orders', orderBody({ deliveryMethodId: 'pickup', paymentMethodId: 'cash' })));
  const orderId = placed.order.id as string;
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), orderId);
  await runOrderDeliveredEffects(envOf(raw), orderId);
  raw.prepare('DELETE FROM cart_items').run();
  const code = row<{ code: string }>(raw, "SELECT c.code FROM coupons c JOIN reward_grants g ON g.coupon_id = c.id WHERE g.kind = 'filament_discount' LIMIT 1")!.code;
  paidLine(raw, 'ci_esun', ESUN, { qty: 1, fulfillmentType: 'direct_sale' });
  return { raw, code };
}

const pickup = { deliveryMethodId: 'pickup', paymentMethodId: 'cash' };

test('with the switch on (the default), 15% comes off the sale price and the order places at 20,400', async () => {
  const { raw, code } = await world({});
  assert.equal(row<{ stacks: number }>(raw, 'SELECT stacks FROM coupons WHERE code = ?', code)!.stacks, 1);
  const app = appOf(raw);
  const quote = await json(await post(app, '/api/orders/quote', quoteBody({ couponCode: code, ...pickup })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.equal(Number(quote.quote.coupon.discount_iqd), 3_600, '15% of 24,000, not of 27,250');
  assert.equal(Number(quote.quote.total_iqd), 20_400);
  const placed: J = await json(await post(app, '/api/orders', orderBody({ couponCode: code, couponDiscountSeen: 3_600, ...pickup })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(row<{ amount_iqd: number }>(raw, 'SELECT amount_iqd FROM coupon_redemptions WHERE order_id = ?', placed.order.id)!.amount_iqd, 3_600);
  assert.equal(row<{ total_iqd: number }>(raw, 'SELECT total_iqd FROM orders WHERE id = ?', placed.order.id)!.total_iqd, 20_400, 'the customer pays 20,400');
});

test('with the switch off, a new coupon keeps off the sale line', async () => {
  const { raw, code } = await world({ on_offer: false });
  assert.equal(row<{ stacks: number }>(raw, 'SELECT stacks FROM coupons WHERE code = ?', code)!.stacks, 0);
  const res = await post(appOf(raw), '/api/orders/quote', quoteBody({ couponCode: code, ...pickup }));
  assert.equal(res.status, 400);
});

test('0226 turns on every filament coupon already out, and no other coupon', async () => {
  const { raw } = await world({ on_offer: false });
  raw.exec("INSERT INTO coupons (id,code,kind,value,active,stacks) VALUES ('cpn_promo','PROMO10','percent',10,1,0)");
  const sql = readFileSync(new URL('../migrations/0226_filament_coupon_on_sale.sql', import.meta.url), 'utf8');
  const off = (where: string) => row<{ n: number }>(raw, `SELECT COUNT(*) AS n FROM coupons WHERE stacks = 0 AND ${where}`)!.n;
  const filament = "reward_grant_id IN (SELECT id FROM reward_grants WHERE kind = 'filament_discount')";
  assert.equal(off(filament), 1);
  raw.exec(sql);
  raw.exec(sql);
  assert.equal(off(filament), 0);
  assert.equal(off("code = 'PROMO10'"), 1, 'a promo code keeps its own rule');
});

test('a failed read of the terms mints nothing: it never falls back to the defaults', async () => {
  const { raw } = await world({});
  const before = row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM reward_grants')!.n;
  const db = asD1(raw);
  const failing = {
    prepare(sql: string) {
      if (sql.includes('admin_settings')) throw new Error('D1_ERROR: read failed');
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  } as unknown as D1Database;
  await assert.rejects(getRewardConfigStrict(failing));
  await assert.rejects(issueWeeklyRewards({ DB: failing } as unknown as Env, '2026-11-01T00:00:00.000Z', new Date().toISOString()));
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM reward_grants')!.n, before);
});
