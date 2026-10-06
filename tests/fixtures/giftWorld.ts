/**
 * A WORLD FOR THE GIFT TESTS (owner brief 2026-10-06 §1, docs/GIFTS_QUICK_BUY.md
 * §1). A fully migrated database, the REAL routers mounted the way
 * worker/index.ts mounts them — the cart, the checkout, the gifts, the reviews
 * (with the old gift URLs) and the admin — and only the session stubbed.
 *
 *   buyer   a customer with an address and a funded wallet.
 *   other   a second customer (owns nothing).
 *   boss    the admin.
 *
 * Real store products a gift can grant (never copies):
 *   p_nozzle  DIRECT SALE, inventory per model: «0.4 mm» (v_04) 3 on the shelf,
 *             «0.6 mm» (v_06) none; colours red and blue.
 *   p_plate   PRE-ORDER only, by air: model «Textured PEI» (v_pei) with a
 *             pre-order cell (20–30 days) and an air route (10–14 days, 15,000
 *             IQD commission); colour black.
 *   p_plain   direct sale, no options, 3 on the shelf.
 *   p_other   another product with its own model o_x (the «option of another
 *             product» refusal).
 *   p_bundle  a bundle — never a gift.   p_draft  a draft product.
 */
import type { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, patch, post, put, row, send, stubApp, type App, type Mount, type StubUser } from './app';
import { cartRoutes } from '../../worker/routes/cart';
import { orderRoutes } from '../../worker/routes/orders';
import { giftRoutes, legacyGiftRoutes } from '../../worker/routes/gifts';
import { reviewRoutes } from '../../worker/routes/reviews';
import { adminRoutes } from '../../worker/routes/admin';
import { acceptedPolicies } from '../lib/policies';

/** A JSON body as the routes answer it, read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type J = Record<string, any>;

export const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
export const OTHER: StubUser = { id: 'other', role: 'customer', email: 'other@x.co' };
export const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

export function giftWorld(raw: DatabaseSync = freshDb()): DatabaseSync {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('buyer','Sara Buyer','buyer@x.co','h','customer','sara'),
      ('other','Omar Other','other@x.co','h','customer','omar'),
      ('boss','The Admin','boss@x.co','h','admin','boss');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_o','other','Home','Omar','+9647701234568','Baghdad, Mansour 3','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',100000,'approved'),
      ('dep_o','other','deposit','USD',100000,'approved');

    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
                          preorder_transports,images,inventory_mode)
    VALUES ('p_nozzle','nozzle-kit','Nozzle kit','طقم فوهات','کیتی نۆزڵ',40000,'active',NULL,'[]','[]','direct_sale',
            '["direct_sale"]','[]','[]','OPTION');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_size','p_nozzle','Size',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,name_ckb,sort,active,stock) VALUES
      ('v_04','p_nozzle','g_size','0.4 mm','0.4 مم','0.4 ملم',0,1,3),
      ('v_06','p_nozzle','g_size','0.6 mm','0.6 مم','0.6 ملم',1,1,0);
    INSERT INTO product_colors (id,product_id,name_en,name_ar,name_ckb,hex,sort,active) VALUES
      ('c_red','p_nozzle','Red','أحمر','سوور','#ff0000',0,1),
      ('c_blue','p_nozzle','Blue','أزرق','شین','#0000ff',1,1);

    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
                          preorder_transports,images,inventory_mode)
    VALUES ('p_plate','pei-plate','PEI plate','لوح PEI','تەختەی PEI',60000,'active',NULL,'[]','[]','pre_order',
            '["pre_order"]','[{"method":"air","commission_iqd":15000,"active":true}]','[]','BASE');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_surface','p_plate','Surface',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active,stock) VALUES
      ('v_pei','p_plate','g_surface','Textured PEI',0,1,NULL);
    INSERT INTO product_colors (id,product_id,name_en,name_ar,name_ckb,hex,sort,active) VALUES
      ('c_black','p_plate','Black','أسود','ڕەش','#000000',0,1);
    INSERT INTO product_option_fulfillment
      (id,product_id,option_id,fulfillment_type,enabled,lead_time_text,lead_time_min_days,lead_time_max_days)
    VALUES ('f_pei_p','p_plate','v_pei','pre_order',1,'20-30 days',20,30);
    INSERT INTO product_option_transports
      (id,product_id,fulfillment_id,method,enabled,surcharge_iqd,lead_time_text,lead_time_min_days,lead_time_max_days)
    VALUES ('t_pei_air','p_plate','f_pei_p','air',1,15000,'10-14 days',10,14);

    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
                          preorder_transports,images,inventory_mode)
    VALUES
      ('p_plain','nozzle-cleaner','Nozzle cleaner','منظف فوهات','پاککەرەوەی نۆزڵ',15000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE'),
      ('p_other','other-thing','Other thing','شيء آخر','شتێکی تر',10000,'active',4,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE'),
      ('p_bundle','starter-bundle','Starter bundle','حزمة البداية','کۆمەڵەی دەستپێک',50000,'active',NULL,'[]','[]','bundle','["bundle"]','[]','[]','BASE'),
      ('p_draft','draft-thing','Draft thing','مسودة','ڕەشنووس',9000,'draft',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE');
    UPDATE products SET composition = 'bundle' WHERE id = 'p_bundle';
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_o','p_other','Kind',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active,stock) VALUES ('o_x','p_other','g_o','X',0,1,4);
  `);
  return raw;
}

/** Every router a gift touches, mounted the way worker/index.ts mounts them. */
export const mountGifts: Mount = (a) => {
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/reviews', reviewRoutes);
  a.route('/api/reviews', legacyGiftRoutes);
  a.route('/api/gifts', giftRoutes);
  a.route('/api/admin', adminRoutes);
};

export const appAs = (db: D1Database, user: StubUser | null = BUYER) => stubApp(db, user, mountGifts);

export interface Apps {
  db: D1Database;
  buyer: App;
  other: App;
  admin: App;
}

export function appsFor(db: D1Database): Apps {
  return { db, buyer: appAs(db, BUYER), other: appAs(db, OTHER), admin: appAs(db, BOSS) };
}

export const apps = (raw: DatabaseSync): Apps => appsFor(asD1(raw));

// ----------------------------------------------------------------- the lines

export interface GiftLine {
  productId: string;
  saleType: 'direct_sale' | 'pre_order';
  optionValueIds: string[];
  colorId: string;
  qty?: number;
  transportMethod?: '' | 'air' | 'sea' | 'land';
}

/** The direct-sale gift most tests reach for: nozzle kit, 0.4 mm, red. */
export const NOZZLE_04_RED: GiftLine = { productId: 'p_nozzle', saleType: 'direct_sale', optionValueIds: ['v_04'], colorId: 'c_red' };
/** The same model in blue. */
export const NOZZLE_04_BLUE: GiftLine = { ...NOZZLE_04_RED, colorId: 'c_blue' };
/** The pre-order gift: PEI plate, black, by air. */
export const PLATE_AIR: GiftLine = {
  productId: 'p_plate',
  saleType: 'pre_order',
  optionValueIds: ['v_pei'],
  colorId: 'c_black',
  transportMethod: 'air',
};
/** A plain product with no options. */
export const PLAIN: GiftLine = { productId: 'p_plain', saleType: 'direct_sale', optionValueIds: [], colorId: '' };

// --------------------------------------------------------------- admin calls

let keySeq = 0;
/** A fresh idempotency key for a grant or an order. */
export const freshKey = (prefix = 'gift-key') => `${prefix}-${(++keySeq).toString(36)}-${Date.now().toString(36)}`;

/** «إضافة منتج إلى المستوى» through the real route; asserts success. */
export async function addLevelItem(admin: App, level: number, line: GiftLine, extra: Record<string, unknown> = {}): Promise<J> {
  const res = await post(admin, `/api/gifts/admin/levels/${level}/items`, { ...line, ...extra });
  const out = await json(res);
  assert.equal(res.status, 200, `level item refused: ${JSON.stringify(out)}`);
  return out.item;
}

/** «منح هدية» through the real route; asserts success and returns the admin view. */
export async function grantOk(admin: App, body: Record<string, unknown>): Promise<J> {
  const res = await post(admin, '/api/gifts/admin/grants', {
    userId: 'buyer',
    reason: 'admin_gift',
    note: '',
    idempotencyKey: freshKey(),
    ...body,
  });
  const out = await json(res);
  assert.equal(res.status, 200, `grant refused: ${JSON.stringify(out)}`);
  return out.grant;
}

/** A product grant of `line`, already pinned (ready to redeem). */
export const grantProduct = (admin: App, line: GiftLine, extra: Record<string, unknown> = {}) =>
  grantOk(admin, { mode: 'product', level: 2, product: { qty: 1, ...line }, ...extra });

// ------------------------------------------------------------ customer calls

export const myGifts = async (app: App): Promise<Array<J>> => {
  const res = await get(app, '/api/gifts');
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  return out.gifts;
};

export const myGift = async (app: App, id: string) => (await myGifts(app)).find((g) => g.id === id);

export const choose = (app: App, id: string, itemId: string) => post(app, `/api/gifts/${id}/choose`, { itemId });
export const redeem = (app: App, id: string) => post(app, `/api/gifts/${id}/redeem`, {});
export const addGiftToCart = (app: App, id: string, extra: Record<string, unknown> = {}) =>
  post(app, '/api/cart/gift-items', { giftId: id, ...extra });

/** Grant `line` to the buyer and redeem it through the real routes; returns the gift id. */
export async function redeemedGift(a: Apps, line: GiftLine = NOZZLE_04_RED, extra: Record<string, unknown> = {}): Promise<string> {
  const g = await grantProduct(a.admin, line, extra);
  const res = await redeem(a.buyer, g.id);
  const out = await json(res);
  assert.equal(res.status, 200, `redeem refused: ${JSON.stringify(out)}`);
  assert.equal(out.gift.status, 'REDEEMED');
  return g.id;
}

/** The same, with the gift's cart line added. */
export async function giftInCart(a: Apps, line: GiftLine = NOZZLE_04_RED): Promise<string> {
  const id = await redeemedGift(a, line);
  const res = await addGiftToCart(a.buyer, id);
  const out = await json(res);
  assert.equal(res.status, 200, `add refused: ${JSON.stringify(out)}`);
  return id;
}

// -------------------------------------------------------------- the checkout

export const orderBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: freshKey('gift-checkout'),
  policyAcceptance: acceptedPolicies(),
  ...over,
});

export const quoteBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  itemIds: [],
  ...over,
});

/** Place the buyer's cart as an order; asserts success and returns the order. */
export async function placeOrder(app: App, over: Record<string, unknown> = {}): Promise<J> {
  const res = await post(app, '/api/orders', orderBody(over));
  const out = await json(res);
  assert.equal(res.status, 200, `order refused: ${JSON.stringify(out)}`);
  return out.order;
}

/** An ordinary paid line, written the way POST /api/cart/items writes it. */
export function paidLine(
  raw: DatabaseSync,
  id: string,
  productId: string,
  opts: { optionValueIds?: string[]; colorId?: string; qty?: number; fulfillmentType?: string; transport?: string; userId?: string } = {}
) {
  const ids = [...(opts.optionValueIds ?? [])].sort();
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,
                               fulfillment_type,warranty_plan_id,qty)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, '', ?)`
    )
    .run(id, opts.userId ?? 'buyer', productId, ids[0] ?? '', JSON.stringify(ids), opts.colorId ?? '', opts.transport ?? '', opts.fulfillmentType ?? '', opts.qty ?? 1);
}

// ------------------------------------------------------------------- reading

export const giftRow = (raw: DatabaseSync, id: string) =>
  row<J>(raw, 'SELECT * FROM gift_entitlements WHERE id = ?', id)!;

export const optionStock = (raw: DatabaseSync, id: string) => ({
  ...row<{ stock: number; reserved: number }>(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', id)!,
});

export const auditActions = (raw: DatabaseSync, target: string): string[] =>
  (raw.prepare('SELECT action FROM audit_log WHERE target = ? ORDER BY id').all(target) as Array<{ action: string }>).map((r) => r.action);

/**
 * A LEGACY review box (pre-0175 shape): a published review, an approved
 * printer-gift reward and an `available` entitlement of `maxLevel`.
 */
export function legacyBox(raw: DatabaseSync, id: string, opts: { userId?: string; maxLevel?: number; state?: string } = {}): string {
  const userId = opts.userId ?? 'buyer';
  const printer = `p_printer_${id}`;
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
       VALUES (?, ?, 'Printer', 'طابعة', 900000, 'active', 5, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '[]')`
    )
    .run(printer, printer);
  raw
    .prepare(
      `INSERT INTO reviews (id,user_id,product_id,stars,body,status,source)
       VALUES (?, ?, ?, 5, 'A real review of this printer, long enough to count.', 'published', 'user')`
    )
    .run(`rv_${id}`, userId, printer);
  raw
    .prepare(
      `INSERT INTO review_rewards (id,review_id,user_id,kind,state,quality_score,decided_by,decided_at)
       VALUES (?, ?, ?, 'printer_gift', 'approved', ?, 'boss', '2026-09-01T00:00:00.000Z')`
    )
    .run(`rr_${id}`, `rv_${id}`, userId, opts.maxLevel ?? 3);
  raw
    .prepare(
      `INSERT INTO gift_entitlements (id, reward_id, user_id, max_level, state, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-09-01T00:00:00.000Z')`
    )
    .run(id, `rr_${id}`, userId, opts.maxLevel ?? 3, opts.state ?? 'available');
  return id;
}

export { get, json, patch, post, put, send, row };
