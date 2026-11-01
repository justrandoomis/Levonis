/**
 * «سعر تقديري» AT EVERY PURCHASE DOOR BUT THE CHECKOUT (docs/SMART_PRICING.md
 * §6.1, §8 «Other purchase doors»; WP8; DECISIONS rows 240, 278 and 280;
 * owner question 282(h)).
 *
 * An estimated price is an ordinary SELLABLE price whose product carries the
 * label `products.price_estimate` (a SKU the owner made firm is not an
 * estimate). It sells by PRE-ORDER only, through the cart, and only while the
 * owner's ordering switch is on; every door that freezes or derives a value
 * from a price leaves it out. This suite proves, on the real routes:
 *
 *   REFUSED. The cart's add (single and batch) and line update refuse a
 *     direct sale of an estimated SKU (PRICE_ESTIMATE_PREORDER_ONLY), every
 *     estimated line while ordering is paused (PRICE_ESTIMATE_ORDERING_PAUSED)
 *     and — fail closed — while the switch cannot be read
 *     (PRICE_ESTIMATES_READ_FAILED); a pre-order is admitted and labelled, line
 *     by line, with the cart's `has_estimates`. Quick Buy refuses an estimated
 *     SKU before anything is held (PRICE_ESTIMATE_QUICK_BUY). A firm SKU and
 *     an unlabelled product pass every one of these doors as before, and an
 *     unlabelled add reads no switch at all.
 *   EXCLUDED. Gifts (a new gift, a level item, the editor's projection, and a
 *     gift granted before the label — at the cart door, the cart and the
 *     checkout), bundles (sold out to customers; the admin's save names the
 *     member), mystery boxes (never drawn; the admin preview names it),
 *     trade-in targets and the print quote's material prices
 *     (`loadMaterialPrices`) leave a labelled product out.
 *   PRICE REQUESTS. The sweep tells a requester in the estimate's own words.
 *   DEPLOY-AHEAD. On a database without 0218 the SQL exclusions run today's
 *     statements.
 *
 * The checkout itself is the next package's (WP9, tests/priceEstimateCheckout.test.ts).
 *
 * Run: node --import tsx --test tests/priceEstimateDoors.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, dbThrough, freshDb, get, json, patch, post, row, send, stubApp, type App } from './fixtures/app';
import { SqliteD1, type SqliteStatement } from './fixtures/d1';
import { publishSeededV2 } from './fixtures/autoPublish';
import { publishV2 } from './fixtures/v2Publish';
import { P } from './fixtures/liveCatalog';
import { CUSTOMER_ROLES, catalogOnlyWorld, type CatalogOnlyWorld } from './fixtures/catalogOnly';
import {
  BOSS,
  NOZZLE_04_RED,
  PLAIN,
  addGiftToCart,
  apps,
  freshKey,
  giftInCart,
  giftWorld,
  orderBody,
  redeemedGift,
} from './fixtures/giftWorld';
import { addBundle, seedCatalogue } from './lib/bundles';
import { cartRoutes } from '../worker/routes/cart';
import { quickBuyRoutes } from '../worker/routes/quickBuy';
import { orderRoutes } from '../worker/routes/orders';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import { QUICK_BUY_POLICY_KEYS, requiredPolicies } from '../worker/lib/policyOps';
import { loadCandidates, loadPool } from '../worker/lib/mysteryDraw';
import { loadMaterialPrices } from '../worker/lib/printQuote/repository';
import { estimateAbsentLately } from '../worker/lib/priceEstimateLabel';
import { sweepPriceRequests, type PriceRequestBudget } from '../worker/lib/priceRequests';
import type { Env } from '../worker/lib/types';
import { ESTIMATE_STRINGS, estimateServerMessage, type EstimateRefusalCode } from '@levonis/contracts/priceEstimates';
import { PRICE_AVAILABLE_TEXT } from '@levonis/contracts/priceRequests';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are read field by field
type J = Record<string, any>;

/** What the V2 writer's estimate batch does to the label (trigger T1 lets it in only under the product's price token). */
function labelEstimate(raw: DatabaseSync, pid: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';`);
}

/** The owner's confirmation of one SKU (trigger T4: only on a labelled product). */
function firmSku(raw: DatabaseSync, pid: string, comboKey: string): void {
  raw
    .prepare('INSERT INTO price_estimate_firm_skus (product_id, combo_key, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?)')
    .run(pid, comboKey, 'usr_owner', '2026-11-01T00:00:00.000Z');
}

const setOrdering = (raw: DatabaseSync, on: boolean) =>
  raw.prepare('UPDATE price_estimate_control SET ordering_enabled = ? WHERE id = 1').run(on ? 1 : 0);

/** A refusal of the estimate contract: its status, its code and its "ar / en" sentence. */
async function refusedWith(res: Response, code: EstimateRefusalCode, where: string): Promise<J> {
  const body = await json(res);
  assert.equal(body.code, code, `${where}: ${JSON.stringify(body).slice(0, 300)}`);
  assert.equal(res.status, code === 'PRICE_ESTIMATES_READ_FAILED' ? 503 : 409, where);
  assert.equal(body.error, estimateServerMessage(code), `${where}: the contract's sentence`);
  return body;
}

/** A D1 over the same database that records the SQL of every statement prepared through it. */
function recordingD1(raw: DatabaseSync): { db: D1Database; sqls: string[] } {
  const inner = new SqliteD1(raw);
  const sqls: string[] = [];
  const db = {
    inner,
    prepare(sql: string) {
      sqls.push(sql);
      return inner.prepare(sql);
    },
    batch(stmts: SqliteStatement[]) {
      return inner.batch(stmts);
    },
  };
  return { db: db as unknown as D1Database, sqls };
}
const switchReads = (sqls: readonly string[]) => sqls.filter((s) => s.includes('price_estimate_control')).length;

// ====================================================================== the cart

/**
 *   p_dual  sells directly (5 on the shelf) AND by pre-order (air): an estimate whose direct sale the owner
 *           re-enabled — the one case the pre-order rule exists for (§6.1).
 *   p_pre   pre-order only, by air: what an applied estimate looks like.
 *   p_dir   direct only, 50 on the shelf, no options: its one SKU ('') can be made firm.
 *   p_ok    an ordinary direct product, never labelled.
 *   p_air   an ordinary pre-order by air, never labelled — the control beside an estimate (one shipping type a cart).
 */
function cartWorld(): { raw: DatabaseSync; db: D1Database; sqls: string[]; app: App } {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_dual','dual','Hotend','رأس طباعة',90000,'active',5,'[]','[]','direct_sale','["direct_sale","pre_order"]',
              '[{"method":"air","commission_iqd":0,"active":true}]','[]'),
             ('p_pre','pre','Imported printer','طابعة',500000,'active',0,'[]','[]','pre_order','["pre_order"]',
              '[{"method":"air","commission_iqd":0,"active":true}]','[]'),
             ('p_dir','dir','Nozzle','فوهة',5000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','[]'),
             ('p_ok','ok','Scraper','مكشطة',3000,'active',20,'[]','[]','direct_sale','["direct_sale"]','[]','[]'),
             ('p_air','air','Build plate','لوح طباعة',40000,'active',0,'[]','[]','pre_order','["pre_order"]',
              '[{"method":"air","commission_iqd":0,"active":true}]','[]');
  `);
  const { db, sqls } = recordingD1(raw);
  const app = stubApp(db, { id: 'u1', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/cart', cartRoutes));
  return { raw, db, sqls, app };
}

/** The world after the fixture's publish (the first customer request), labelled as an apply leaves it. */
async function labelledCart() {
  const w = cartWorld();
  assert.equal((await get(w.app, '/api/cart')).status, 200);
  for (const pid of ['p_dual', 'p_pre', 'p_dir']) labelEstimate(w.raw, pid);
  return w;
}

const linesOf = (raw: DatabaseSync) => all<J>(raw, "SELECT product_id, qty, fulfillment_type, transport_method FROM cart_items WHERE user_id = 'u1' ORDER BY product_id");
const DUAL_AIR = { productId: 'p_dual', qty: 1, fulfillmentType: 'pre_order', transportMethod: 'air' };
const PRE_AIR = { productId: 'p_pre', qty: 1, fulfillmentType: 'pre_order', transportMethod: 'air' };
const OK_AIR = { productId: 'p_air', qty: 1, fulfillmentType: 'pre_order', transportMethod: 'air' };

test('cart: a direct sale of an estimated SKU is refused at the add, the batch and the line update; a pre-order is admitted and labelled', async () => {
  const w = await labelledCart();
  // Direct sale: refused by name, before the shelf of 5 that would otherwise sell it.
  await refusedWith(await post(w.app, '/api/cart/items', { productId: 'p_dual', qty: 1, fulfillmentType: 'direct_sale' }), 'PRICE_ESTIMATE_PREORDER_ONLY', 'single add');
  const batch = await refusedWith(
    await post(w.app, '/api/cart/items/batch', { productId: 'p_dual', fulfillmentType: 'direct_sale', lines: [{ optionValueIds: [], colorId: '', qty: 1 }] }),
    'PRICE_ESTIMATE_PREORDER_ONLY',
    'batch add'
  );
  assert.equal(batch.details.lines[0].code, 'PRICE_ESTIMATE_PREORDER_ONLY');
  assert.deepEqual(linesOf(w.raw), [], 'nothing written');

  // Pre-order: admitted, and the line and the cart say it is an estimate.
  const added = await json(await post(w.app, '/api/cart/items', DUAL_AIR));
  assert.equal(added.success, true, JSON.stringify(added).slice(0, 300));
  assert.equal(added.has_estimates, true);
  const line = (added.items as J[]).find((i) => i.productId === 'p_dual')!;

  // The line update refuses the same direct sale (re-typing the cart's only line is otherwise legal), and writes nothing.
  const before = linesOf(w.raw);
  await refusedWith(await patch(w.app, `/api/cart/items/${line.id}`, { fulfillmentType: 'direct_sale', transportMethod: '' }), 'PRICE_ESTIMATE_PREORDER_ONLY', 'line update');
  assert.deepEqual(linesOf(w.raw), before, 'the row is not written');
  // A quantity change of the pre-order is an ordinary update.
  const bumped = await json(await patch(w.app, `/api/cart/items/${line.id}`, { qty: 2 }));
  assert.equal(bumped.success, true, JSON.stringify(bumped).slice(0, 300));
  assert.equal(bumped.has_estimates, true);

  // Beside an ordinary line, only the estimate is labelled.
  const plain = await json(await post(w.app, '/api/cart/items', OK_AIR));
  const cart = await json(await get(w.app, '/api/cart'));
  for (const body of [plain, cart]) {
    assert.equal(body.has_estimates, true, `the cart carries one note: ${JSON.stringify(body).slice(0, 200)}`);
    const est = (body.items as J[]).find((i) => i.productId === 'p_dual')!;
    assert.equal(est.price_estimate, true, 'the estimated line carries the label');
    assert.equal(est.breakdown.price_estimate, true, 'and so does its price block');
    const ok = (body.items as J[]).find((i) => i.productId === 'p_air')!;
    assert.equal('price_estimate' in ok, false, 'an ordinary line carries none');
    assert.equal('price_estimate' in ok.breakdown, false);
  }

  // Removing the estimated line leaves an ordinary cart: no label anywhere.
  const left = await json(await send(w.app, 'DELETE', `/api/cart/items/${line.id}`));
  assert.equal((left.items as J[]).length, 1, 'the ordinary line stays');
  assert.equal('has_estimates' in left, false);
  assert.equal(JSON.stringify(left).includes('price_estimate'), false);
});

test('cart: a firm SKU of a labelled product is an ordinary price — sold directly, and carrying no label', async () => {
  const w = await labelledCart();
  await refusedWith(await post(w.app, '/api/cart/items', { productId: 'p_dir', qty: 1, fulfillmentType: 'direct_sale' }), 'PRICE_ESTIMATE_PREORDER_ONLY', 'the estimate');
  firmSku(w.raw, 'p_dir', '');
  const res = await post(w.app, '/api/cart/items', { productId: 'p_dir', qty: 1, fulfillmentType: 'direct_sale' });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal('has_estimates' in body, false);
  assert.equal(JSON.stringify(body).includes('price_estimate'), false, 'no label on a confirmed price');
});

test('cart: while the owner pauses ordering at estimates, every estimated line is refused at add, batch and update — removing it and other products are not', async () => {
  const w = await labelledCart();
  const added = await json(await post(w.app, '/api/cart/items', PRE_AIR));
  assert.equal(added.success, true, JSON.stringify(added).slice(0, 300));
  const lineId = String((added.items as J[]).find((i) => i.productId === 'p_pre')!.id);

  setOrdering(w.raw, false);
  await refusedWith(await post(w.app, '/api/cart/items', PRE_AIR), 'PRICE_ESTIMATE_ORDERING_PAUSED', 'single add');
  const batch = await refusedWith(
    await post(w.app, '/api/cart/items/batch', { productId: 'p_pre', fulfillmentType: 'pre_order', transportMethod: 'air', lines: [{ optionValueIds: [], colorId: '', qty: 1 }] }),
    'PRICE_ESTIMATE_ORDERING_PAUSED',
    'batch add'
  );
  assert.equal(batch.details.lines[0].code, 'PRICE_ESTIMATE_ORDERING_PAUSED');
  await refusedWith(await patch(w.app, `/api/cart/items/${lineId}`, { qty: 3 }), 'PRICE_ESTIMATE_ORDERING_PAUSED', 'line update');
  assert.equal(row<{ qty: number }>(w.raw, 'SELECT qty FROM cart_items WHERE id = ?', lineId)!.qty, 1, 'the quantity is not written');
  // The cart still shows the line and its label (the checkout refuses it with the same sentence).
  const cart = await json(await get(w.app, '/api/cart'));
  assert.equal((cart.items as J[]).find((i) => i.id === lineId)?.price_estimate, true);
  // Other products are untouched by the brake, and the customer can always remove the line.
  assert.equal((await post(w.app, '/api/cart/items', OK_AIR)).status, 200);
  assert.equal((await send(w.app, 'DELETE', `/api/cart/items/${lineId}`)).status, 200);

  // Switched back on: the same add goes through.
  setOrdering(w.raw, true);
  assert.equal((await post(w.app, '/api/cart/items', PRE_AIR)).status, 200);
});

test('cart: fail closed — a switch that cannot be read refuses an estimated line (503) and nothing else', async () => {
  const w = await labelledCart();
  w.raw.exec('DROP TABLE price_estimate_control');
  await refusedWith(await post(w.app, '/api/cart/items', PRE_AIR), 'PRICE_ESTIMATES_READ_FAILED', 'single add');
  assert.deepEqual(linesOf(w.raw), [], 'nothing written');
  assert.equal((await post(w.app, '/api/cart/items', { productId: 'p_ok', qty: 1, fulfillmentType: 'direct_sale' })).status, 200, 'an unlabelled product never asks');
});

test('cart: the switch is read only for a labelled product — an ordinary add, update or cart read costs no statement more', async () => {
  const w = cartWorld();
  assert.equal((await get(w.app, '/api/cart')).status, 200);
  w.sqls.length = 0;
  const ok = await json(await post(w.app, '/api/cart/items', { productId: 'p_ok', qty: 1, fulfillmentType: 'direct_sale' }));
  const okLine = String((ok.items as J[])[0].id);
  await post(w.app, '/api/cart/items/batch', { productId: 'p_dir', fulfillmentType: 'direct_sale', lines: [{ optionValueIds: [], colorId: '', qty: 1 }] });
  await patch(w.app, `/api/cart/items/${okLine}`, { qty: 2 });
  await get(w.app, '/api/cart');
  assert.equal(switchReads(w.sqls), 0, 'no unlabelled door reads the switch');

  labelEstimate(w.raw, 'p_pre');
  // An estimate is a pre-order, and a cart holds one shipping type: the direct lines go first.
  assert.equal((await send(w.app, 'DELETE', '/api/cart')).status, 200);
  w.sqls.length = 0;
  const pre = await json(await post(w.app, '/api/cart/items', PRE_AIR));
  assert.equal(pre.success, true, JSON.stringify(pre).slice(0, 300));
  assert.equal(switchReads(w.sqls), 1, 'a labelled add reads it once');
  w.sqls.length = 0;
  await post(w.app, '/api/cart/items/batch', { productId: 'p_pre', fulfillmentType: 'pre_order', transportMethod: 'air', lines: [{ optionValueIds: [], colorId: '', qty: 1 }] });
  assert.equal(switchReads(w.sqls), 1, 'a batch reads it once, whatever its lines');
  w.sqls.length = 0;
  await patch(w.app, `/api/cart/items/${String((pre.items as J[]).find((i) => i.productId === 'p_pre')!.id)}`, { qty: 3 });
  assert.equal(switchReads(w.sqls), 1, 'a labelled line update reads it once');
  w.sqls.length = 0;
  const cart = await json(await get(w.app, '/api/cart'));
  assert.equal(cart.has_estimates, true);
  assert.equal(switchReads(w.sqls), 0, 'the cart read never does: the label rides on the row');
});

// ==================================================================== Quick Buy

const RATE = 1500;
const cents = (iqd: number) => Math.ceil((iqd * 100) / RATE);

function quickBuyWorld(): { raw: DatabaseSync; app: App } {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default,governorate,area) VALUES
      ('addr','buyer','Home','Sara','+9647701234567','Karrada 12','Near the bridge',1,'Baghdad','Karrada');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id,sku) VALUES
      ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cat_materials','cat_materials_fdm','PLA1'),
      ('p_nozzle','nozzle','Hardened nozzle','فوهة مقساة',8000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]',NULL,NULL,'NZ1');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_pla','cat_materials_fdm',0);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('wt_fund','buyer','deposit','USD',${cents(2_000_000)},'approved','test funding');
  `);
  const app = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/quick-buy', quickBuyRoutes);
    a.route('/api/orders', orderRoutes);
  });
  return { raw, app };
}

test('Quick Buy refuses an estimated SKU before anything is priced, held or reserved; a firm SKU and an ordinary product go through', async () => {
  const w = quickBuyWorld();
  const on = await json(
    await post(w.app, '/api/quick-buy/activate', { policyAcceptance: requiredPolicies(QUICK_BUY_POLICY_KEYS), walletConsent: true, addressId: 'addr', idempotencyKey: freshKey('qb') })
  );
  assert.equal(on.success, true, JSON.stringify(on).slice(0, 300));
  labelEstimate(w.raw, 'p_pla');
  const add = (productId: string) => post(w.app, '/api/quick-buy/items', { productId, qty: 1, idempotencyKey: freshKey('qb') });

  await refusedWith(await add('p_pla'), 'PRICE_ESTIMATE_QUICK_BUY', 'Quick Buy of an estimate');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM quick_buy_sessions'), 0, 'no session');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0, 'nothing held');
  assert.equal(row<{ stock_reserved: number }>(w.raw, "SELECT stock_reserved FROM products WHERE id = 'p_pla'")!.stock_reserved, 0, 'nothing reserved');

  // An ordinary product opens the session as before…
  const nozzle = await add('p_nozzle');
  assert.equal(nozzle.status, 200, JSON.stringify(await json(nozzle.clone())).slice(0, 300));
  // …and once the owner confirms the PLA's one SKU it is an ordinary price here too.
  firmSku(w.raw, 'p_pla', '');
  const firm = await add('p_pla');
  assert.equal(firm.status, 200, JSON.stringify(await json(firm.clone())).slice(0, 300));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM quick_buy_items WHERE product_id = 'p_pla' AND qty > 0"), 1);
});

// ======================================================================== gifts

test('gifts: a labelled product is never a new gift — the grant, the level item and the editor\'s projection refuse it', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  // The seeded shelf is published on the first request (the admin's too), then the plain product becomes an estimate.
  assert.equal((await get(a.admin, '/api/gifts/admin/products/p_plain/options')).status, 200);
  labelEstimate(raw, 'p_plain');

  const grant = await post(a.admin, '/api/gifts/admin/grants', {
    userId: 'buyer',
    reason: 'admin_gift',
    note: '',
    idempotencyKey: freshKey(),
    mode: 'product',
    level: 2,
    product: { qty: 1, ...PLAIN },
  });
  const g = await json(grant);
  assert.equal(grant.status, 400, JSON.stringify(g));
  assert.equal(g.code, 'GIFT_PRICE_ESTIMATE');
  const item = await post(a.admin, '/api/gifts/admin/levels/2/items', { ...PLAIN });
  const i = await json(item);
  assert.equal(item.status, 400, JSON.stringify(i));
  assert.equal(i.code, 'GIFT_PRICE_ESTIMATE');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM gift_entitlements WHERE gift_product_id = 'p_plain'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM gift_pool_items WHERE product_id = 'p_plain'"), 0);

  const options = await json(await get(a.admin, '/api/gifts/admin/products/p_plain/options'));
  assert.equal(options.options.giftable, false, 'the editor offers it as no gift');
  const control = await json(await get(a.admin, '/api/gifts/admin/products/p_nozzle/options'));
  assert.equal(control.options.giftable, true, 'an ordinary product still is one');
});

test('gifts: a gift granted before its product became an estimate is refused at the cart door, the cart and the checkout', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  // Redeemed, not yet in the cart: the gift's cart door refuses it.
  const redeemed = await redeemedGift(a, PLAIN);
  labelEstimate(raw, 'p_plain');
  const add = await addGiftToCart(a.buyer, redeemed);
  const ab = await json(add);
  assert.equal(add.status, 409, JSON.stringify(ab));
  assert.equal(ab.code, 'GIFT_NOT_AVAILABLE');
  assert.deepEqual(ab.details, { errors: ['PRICE_ESTIMATE'] });
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = '${redeemed}'`), 0);

  // Already in the cart: shown blocked, and the checkout refuses it rather than sell a gift of an estimate.
  const inCart = await giftInCart(a, NOZZLE_04_RED);
  labelEstimate(raw, 'p_nozzle');
  const cart = await json(await get(a.buyer, '/api/cart'));
  const line = (cart.items as J[]).find((it) => it.kind === 'gift')!;
  assert.equal(line.gift.id, inCart);
  assert.equal(line.availability.mode, 'unavailable');
  assert.equal(line.availability.reason, 'GIFT_NOT_AVAILABLE');
  assert.equal('price_estimate' in line, false, 'a gift line is never an estimate line');
  const order = await post(a.buyer, '/api/orders', orderBody());
  const ob = await json(order);
  assert.equal(order.status, 409, JSON.stringify(ob).slice(0, 300));
  assert.equal(ob.code, 'GIFT_NOT_AVAILABLE');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0, 'no order');
});

// ====================================================================== bundles

test('bundles: a labelled member makes the bundle unavailable to customers, and the admin\'s read names it in three languages', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter' });
  const db = asD1(raw);
  const buyer = stubApp(db, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/cart', cartRoutes));
  const owner = stubApp(db, BOSS, (a) => a.route('/api/admin/bundles', adminBundlesRoutes));

  // The control: before the label the bundle sells.
  const first = await json(await post(buyer, '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(first.success, true, JSON.stringify(first).slice(0, 300));
  const before = await json(await get(owner, '/api/admin/bundles/prd_b1'));
  assert.equal(((before.warning_details ?? []) as J[]).some((w) => w.code === 'COMPONENT_PRICE_ESTIMATE'), false);

  labelEstimate(raw, 'p_pla');
  const again = await post(buyer, '/api/cart/items', { productId: 'prd_b1', qty: 1 });
  const ab = await json(again);
  assert.equal(again.status, 400, JSON.stringify(ab).slice(0, 300));
  assert.equal(ab.code, 'OUT_OF_STOCK', 'the same refusal as a hidden member');
  assert.deepEqual(all(raw, "SELECT qty FROM cart_items WHERE user_id = 'buyer'").map((r) => r.qty), [1], 'nothing added');
  const cart = await json(await get(buyer, '/api/cart'));
  const line = (cart.items as J[]).find((it) => it.kind === 'bundle')!;
  assert.equal(line.availability.mode, 'unavailable', 'the line already in the cart shows it cannot be bought');
  assert.equal('price_estimate' in line, false, 'a bundle line is never an estimate line');

  const read = await json(await get(owner, '/api/admin/bundles/prd_b1'));
  const warning = (read.warning_details as J[]).find((w) => w.code === 'COMPONENT_PRICE_ESTIMATE');
  assert.ok(warning, JSON.stringify(read.warning_details));
  for (const lang of ['ar', 'en', 'ckb']) assert.ok(String(warning[lang]).length > 0, `${lang} is written`);
  assert.notEqual(warning.ckb, warning.ar, 'the Sorani is its own, never the Arabic');
  assert.match(warning.en, /PLA Basic/);
});

// ====================================================================== mystery

function mysterySeed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,inventory_mode,options,colors,selling_type,sale_types,preorder_transports,images)
    VALUES
      ('p_spool_a','spool-a','Spool A','بكرة أ',25000,'active',10,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
      ('p_spool_b','spool-b','Spool B','بكرة ب',25000,'active',10,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]');
    INSERT INTO mystery_pools (id,name,kind,active,require_catalog_ids,require_facet_ids,min_available)
      VALUES ('mpl_e','Spools','direct',1,'[]','[]',1);
    INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,family_id,weight,active)
      VALUES ('mpe_a','mpl_e','p_spool_a','[]','','',1,1), ('mpe_b','mpl_e','p_spool_b','[]','','',1,1);
  `);
}

test('mystery: a labelled product is never drawn — the customer query leaves it out, the admin preview names it PRICE_ESTIMATE', async () => {
  const raw = freshDb();
  mysterySeed(raw);
  await publishSeededV2(raw);
  const db = asD1(raw);
  const pool = (await loadPool(db, 'mpl_e'))!;
  assert.deepEqual((await loadCandidates(db, pool)).candidates.map((c) => c.product_id).sort(), ['p_spool_a', 'p_spool_b'], 'the control');

  labelEstimate(raw, 'p_spool_b');
  const customer = await loadCandidates(db, pool);
  assert.deepEqual(customer.candidates.map((c) => c.product_id), ['p_spool_a']);
  assert.equal(customer.excluded.some((x) => x.product_id === 'p_spool_b'), false, 'a customer read never even reads the row');
  const preview = await loadCandidates(db, pool, { preview: true });
  assert.deepEqual(preview.candidates.map((c) => c.product_id), ['p_spool_a']);
  assert.deepEqual(
    preview.excluded.filter((x) => x.product_id === 'p_spool_b').map((x) => ({ entry_id: x.entry_id, reason: x.reason })),
    [{ entry_id: 'mpe_b', reason: 'PRICE_ESTIMATE' }]
  );
});

// ================================================================ print quotes

function filamentShop(raw: DatabaseSync): string {
  raw
    .prepare(
      `INSERT INTO products (id, slug, status, name, name_ar, price_iqd, stock, stock_reserved, inventory_mode, sale_types,
                             selling_type, preorder_transports, images, template_family, spec_fields)
       VALUES ('p_fil_pla','fil-pla','active','PLA filament','فيلمنت PLA',30000,0,0,'BASE','["direct_sale"]','direct_sale','[]','[]','materials',?)`
    )
    .run(JSON.stringify({ material_type: 'PLA', net_weight: '1000' }));
  const pla = row<{ id: string }>(raw, "SELECT id FROM print_materials WHERE material_type = 'PLA' ORDER BY id LIMIT 1")!.id;
  raw.prepare("UPDATE print_materials SET product_id = 'p_fil_pla' WHERE id = ?").run(pla);
  return pla;
}

test('print quotes: a labelled filament prices no material — neither the linked-product rung nor the type rung', async () => {
  const raw = freshDb();
  const pla = filamentShop(raw);
  await publishSeededV2(raw);
  const db = asD1(raw);
  const before = await loadMaterialPrices(db, null, [pla], { platformDefaults: false });
  assert.ok(Number(before.catalogue?.[pla]) > 0, 'the control: the shop\'s filament prices it');
  assert.ok(Number(before.platformByType?.PLA) > 0);

  labelEstimate(raw, 'p_fil_pla');
  const after = await loadMaterialPrices(db, null, [pla], { platformDefaults: false });
  assert.equal(after.catalogue?.[pla], undefined, 'no catalogue rung from an estimate');
  assert.equal(after.platformByType?.PLA, undefined, 'no type rung either');
});

// ============================================================== deploy-ahead

test('deploy-ahead: on a database without 0218 the mystery query and the material prices run today\'s statements', async () => {
  const raw = dbThrough('0217');
  assert.equal(
    (raw.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>).some((c) => c.name === 'price_estimate'),
    false,
    'the column is not there'
  );
  mysterySeed(raw);
  const pla = filamentShop(raw);
  await publishSeededV2(raw);
  const db = asD1(raw);
  const pool = (await loadPool(db, 'mpl_e'))!;
  assert.deepEqual((await loadCandidates(db, pool)).candidates.map((c) => c.product_id).sort(), ['p_spool_a', 'p_spool_b']);
  assert.equal(estimateAbsentLately(db), true, 'the binding remembers the absence');
  const preview = await loadCandidates(db, pool, { preview: true });
  assert.equal(preview.excluded.some((x) => x.reason === 'PRICE_ESTIMATE'), false);
  const prices = await loadMaterialPrices(db, null, [pla], { platformDefaults: false });
  assert.ok(Number(prices.catalogue?.[pla]) > 0);
  assert.ok(Number(prices.platformByType?.PLA) > 0);
});

// ===================================================== the live catalogue: trade-in and price requests

let shared: Promise<CatalogOnlyWorld> | null = null;
const liveWorld = () => (shared ??= catalogOnlyWorld({ alsoUnpriced: [P.U1] }));
const CUSTOMER = CUSTOMER_ROLES.customer!;

test('trade-in: an estimated device is never a target — not listed, not found by id or by name, no entry on its page', async () => {
  const w = await liveWorld();
  const app = w.as(CUSTOMER);
  const ids = async (path: string) => ((await json(await get(app, path))).targets as Array<{ product_id: string }>).map((t) => t.product_id);
  assert.deepEqual(await ids(`/api/trade-in/targets?product_id=${P.H2C}`), [P.H2C], 'the control: a priced device is a target');
  assert.equal((await json(await get(app, `/api/trade-in/entry?product_id=${P.H2C}`))).target_ok, true);

  labelEstimate(w.raw, P.H2C);
  assert.deepEqual(await ids(`/api/trade-in/targets?product_id=${P.H2C}`), [], 'not found by id');
  assert.equal((await ids('/api/trade-in/targets?q=H2C')).includes(P.H2C), false, 'not found by name');
  assert.equal((await ids('/api/trade-in/targets')).includes(P.H2C), false, 'not on the featured page');
  assert.equal((await json(await get(app, `/api/trade-in/entry?product_id=${P.H2C}`))).target_ok, false, 'no entry on its page');
  assert.deepEqual(await ids(`/api/trade-in/targets?product_id=${P.P1S}`), [P.P1S], 'other devices stay targets');
});

const budget = (limit: number): PriceRequestBudget => {
  let used = 0;
  return {
    canSpend: (n) => used + n <= limit,
    spend: (n) => (used + n > limit ? false : ((used += n), true)),
    remaining: () => limit - used,
  };
};

test('price requests: the sweep tells the requester of an estimated product in the estimate\'s own words', async () => {
  const w = await liveWorld();
  const asked = await post(w.as(CUSTOMER), '/api/price-requests', { product_id: P.U1, notify: true });
  assert.equal(asked.status, 200, JSON.stringify(await json(asked.clone())));
  // Its first price is an estimate: the apply writes the price and the label together.
  await publishV2(w.raw, P.U1);
  labelEstimate(w.raw, P.U1);
  const env = { DB: w.db, APP_ORIGIN: 'https://levonis-iq.com', EMAIL_API_KEY: 're_k', EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>' } as unknown as Env;
  const report = await sweepPriceRequests(env, budget(40), { productIds: [P.U1] });
  assert.equal(report.notified, 1);
  const note = row<J>(w.raw, "SELECT * FROM user_notifications WHERE user_id = 'u_cust' AND kind = 'price_available' AND entity_id = ?", P.U1)!;
  const name = row<{ name: string }>(w.raw, 'SELECT name FROM products WHERE id = ?', P.U1)!.name;
  assert.equal(note.title_en, ESTIMATE_STRINGS.priceRequest.title.en.replace('{name}', name));
  assert.notEqual(note.title_en, PRICE_AVAILABLE_TEXT.title.en, 'never «the price is now available» about an estimate');
  assert.equal(note.body_en, ESTIMATE_STRINGS.notice.en);
  assert.equal(note.body_ar, ESTIMATE_STRINGS.notice.ar);
  const meta = JSON.parse(String(note.meta)) as Record<string, string>;
  assert.equal(meta.body_ckb, ESTIMATE_STRINGS.notice.ckb);
  assert.ok(meta.title_ckb.includes('نرخی خەمڵێنراو'), meta.title_ckb);
});
