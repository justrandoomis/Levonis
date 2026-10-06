/**
 * A WORLD FOR THE PRINTER-GIFT TESTS (docs/REVIEWS_GIFTS.md §6.2, lane S2):
 * real migrations, the real gift router, and only the session stubbed.
 *
 *   buyer   bought printer `printer-1` (order ORD-1, line oi-1, unit unit-1),
 *           received it, registered it in the warranty centre, wrote a 5★
 *           review rev-1 with 10 photos and 2 videos → reward rr-1 'submitted'.
 *           `rewards: n` repeats that for printer-2 … printer-n (one review
 *           per user per product is the store's rule).
 *   other   a second customer (owns nothing).
 *   boss    the admin.
 *
 * Gift products (real store products, never copies):
 *   g-mug    direct sale, stock 10; group «Size» (v-s Small, v-l Large);
 *            colours c-red (linked to v-s only) and c-blue (unlinked).
 *   g-spool  pre-order only by air; group «Material» (m-pla, m-petg); colour
 *            c-black (unlinked).
 *   g-plain  direct sale, no options, stock 3.
 *   g-other  another product with its own option value o-x (for the
 *            "option of another product" refusal).
 *   g-bundle a bundle (never a gift);  g-draft  a draft product.
 *
 * Lane S3 may import this for the gift cart / checkout tests.
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, put, send, stubApp, type App } from './app';
import { giftRoutes } from '../../worker/routes/gifts';

export const REVIEW_BODY =
  'طبعت بها عشرين قطعة خلال أسبوعين وكانت الطبقات نظيفة والدقة ممتازة، والتركيب كان سهلاً جداً.';

export function reviewMedia(images = 10, videos = 2): string {
  const list: Array<Record<string, unknown>> = [];
  for (let i = 0; i < images; i++) {
    list.push({ key: `reviews/buyer/photos/p${i}.webp`, kind: 'image', sha256: `img${i}`, bytes: 1000 + i, mime: 'image/webp' });
  }
  for (let i = 0; i < videos; i++) {
    list.push({ key: `reviews/buyer/video/v${i}.mp4`, kind: 'video', sha256: `vid${i}`, bytes: 900_000 + i, mime: 'video/mp4' });
  }
  return JSON.stringify(list);
}

export function seedGiftProducts(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
                          preorder_transports,images,inventory_mode)
    VALUES
      ('g-mug','gift-mug','Levonis Mug','كوب ليفونيس','کوپی لیڤۆنیس',20000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE'),
      ('g-spool','gift-spool','Filament Spool','بكرة فلمنت','بکەرەی فلمێنت',30000,'active',NULL,'[]','[]','pre_order','["pre_order"]',
       '[{"method":"air","commission_iqd":5000,"active":true}]','[]','BASE'),
      ('g-plain','gift-plain','Nozzle Kit','طقم فوهات','کیتی نۆزڵ',15000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE'),
      ('g-other','gift-other','Other Product','منتج آخر','بەرهەمێکی تر',10000,'active',4,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE'),
      ('g-bundle','gift-bundle','Starter Bundle','حزمة البداية','کۆمەڵەی دەستپێک',50000,'active',NULL,'[]','[]','bundle','["bundle"]','[]','[]','BASE'),
      ('g-draft','gift-draft','Draft Thing','مسودة','ڕەشنووس',9000,'draft',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE');
    UPDATE products SET composition = 'bundle' WHERE id = 'g-bundle';

    INSERT INTO product_option_groups (id,product_id,name_en,sort,active)
    VALUES ('grp-size','g-mug','Size',0,1), ('grp-mat','g-spool','Material',0,1), ('grp-o','g-other','Kind',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,name_ckb,sort,active)
    VALUES ('v-s','g-mug','grp-size','Small','صغير','بچووک',0,1),
           ('v-l','g-mug','grp-size','Large','كبير','گەورە',1,1),
           ('m-pla','g-spool','grp-mat','PLA','PLA','PLA',0,1),
           ('m-petg','g-spool','grp-mat','PETG','PETG','PETG',1,1),
           ('o-x','g-other','grp-o','X','إكس','ئێکس',0,1);
    INSERT INTO product_colors (id,product_id,name_en,name_ar,name_ckb,hex,sort,active)
    VALUES ('c-red','g-mug','Red','أحمر','سوور','#cc0000',0,1),
           ('c-blue','g-mug','Blue','أزرق','شین','#0000cc',1,1),
           ('c-black','g-spool','Black','أسود','ڕەش','#111111',0,1);
    INSERT INTO product_color_option_links (color_id,option_value_id,group_id) VALUES ('c-red','v-s','grp-size');
    INSERT INTO product_images (id,product_id,url,r2_key,sort_order,is_primary,content_type,bytes)
    VALUES ('img-mug','g-mug','/files/products/g-mug/main.webp','products/g-mug/main.webp',0,1,'image/webp',90),
           ('img-spool','g-spool','/files/products/g-spool/main.webp','products/g-spool/main.webp',0,1,'image/webp',90),
           ('img-plain','g-plain','/files/products/g-plain/main.webp','products/g-plain/main.webp',0,1,'image/webp',90);
  `);
}

/**
 * One printer purchase, delivered, registered and reviewed — the reward
 * waiting for the admin. `n` makes several independent ones (rev-n, rr-n,
 * unit-n, ORD-n) for the same buyer.
 */
export function seedPrinterReward(
  raw: DatabaseSync,
  n = 1,
  opts: { user?: string; stars?: number; registered?: boolean; media?: string; legacy?: boolean } = {}
): { reviewId: string; rewardId: string; unitId: string; orderId: string; printerId: string } {
  const user = opts.user ?? 'buyer';
  const orderId = `ORD-${n}`;
  const lineId = `oi-${n}`;
  const unitId = `unit-${n}`;
  const reviewId = `rev-${n}`;
  const rewardId = `rr-${n}`;
  const printerId = `printer-${n}`;
  raw.prepare(
    `INSERT OR IGNORE INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,images,
                                     inventory_mode,category_id,sub_category_id)
     VALUES (?,?,?,?,?,900000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','BASE','cat_printers','cat_printers_fdm')`
  ).run(printerId, `p1s-${n}`, `P1S printer ${n}`, `طابعة P1S ${n}`, `چاپکەری P1S ${n}`);
  raw.prepare(
    `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                         subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,created_at,updated_at)
     VALUES (?,?,'delivered','{}','standard','{}','cod',900000,0,1400,900000,0,'2026-09-01T00:00:00.000Z',
             '2026-08-25T00:00:00.000Z','2026-09-01T00:00:00.000Z')`
  ).run(orderId, user);
  raw.prepare(
    `INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
     VALUES (?,?,?,'P1S printer','/files/products/printer/main.webp','',1,900000,900000)`
  ).run(lineId, orderId, printerId);
  raw.prepare(
    `INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_end_at)
     VALUES (?,?,?,?,?,1,'2026-09-01T00:00:00.000Z','2027-09-01T00:00:00.000Z')`
  ).run(unitId, orderId, lineId, printerId, user);
  if (opts.registered !== false) {
    raw.prepare(`INSERT INTO device_registrations (unit_id,user_id,registered_at) VALUES (?,?,'2026-09-02T00:00:00.000Z')`).run(unitId, user);
  }
  raw.prepare(`INSERT INTO device_serials (serial_norm,serial_raw,unit_id,assigned_by) VALUES (?,?,?,'boss')`).run(
    `SN${n}00`,
    `SN-${n}00`,
    unitId
  );
  raw.prepare(
    `INSERT INTO reviews (id,user_id,product_id,order_item_id,order_id,stars,body,media,status,source,created_at)
     VALUES (?,?,?,?,?,?,?,?,'published','user',?)`
  ).run(reviewId, user, printerId, lineId, orderId, opts.stars ?? 5, REVIEW_BODY, opts.media ?? reviewMedia(), `2026-09-03T00:00:0${n % 10}.000Z`);
  raw.prepare(
    `INSERT INTO review_rewards (id,review_id,user_id,kind,state,created_at,unit_id,order_id,order_item_id,product_id,eligibility,
                                 quality_snapshot,instagram_evidence,quality_score)
     VALUES (?,?,?,'printer_gift','submitted',?,?,?,?,?,?,?,?,?)`
  ).run(
    rewardId,
    reviewId,
    user,
    `2026-09-03T00:00:1${n % 10}.000Z`,
    opts.legacy ? null : unitId,
    opts.legacy ? null : orderId,
    opts.legacy ? null : lineId,
    opts.legacy ? null : printerId,
    JSON.stringify({ v: 2, unit_id: unitId, admitted_at: '2026-09-03T00:00:00.000Z' }),
    JSON.stringify({ score: 72, tier: 4, reasons: ['detailed_text'], suspiciousSignals: [], rewardEligible: true }),
    opts.legacy ? JSON.stringify({ link: 'https://instagram.com/p/legacy', key: 'reviews/buyer/evidence/e.webp' }) : '',
    // A pre-0165 pending row carried the PREDICTED tier here; it must never surface as a level.
    opts.legacy ? 4 : null
  );
  return { reviewId, rewardId, unitId, orderId, printerId };
}

export interface GiftWorld {
  raw: DatabaseSync;
  db: D1Database;
  buyer: App;
  other: App;
  admin: App;
  mount: (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => void;
}

export function giftWorld(opts: { rewards?: number } = {}): GiftWorld {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('buyer','Sara Buyer','buyer@x.co','h','customer','sara'),
      ('other','Omar Other','other@x.co','h','customer','omar'),
      ('boss','The Admin','boss@x.co','h','admin','boss');
  `);
  seedGiftProducts(raw);
  for (let n = 1; n <= (opts.rewards ?? 1); n++) seedPrinterReward(raw, n);
  const db = asD1(raw);
  const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
    a.route('/api/reviews', giftRoutes);
  };
  return {
    raw,
    db,
    mount,
    buyer: stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, mount),
    other: stubApp(db, { id: 'other', role: 'customer', email: 'other@x.co' }, mount),
    admin: stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, mount),
  };
}

/** A level item through the real editor route. */
export async function addLevelItem(admin: App, body: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await post(admin, '/api/reviews/admin/pools', body);
  const out = await json(res);
  if (res.status !== 200) throw new Error(`level item refused: ${res.status} ${JSON.stringify(out)}`);
  return out.item;
}

let requestSeq = 0;
export const requestId = () => `req-${Date.now().toString(36)}-${(++requestSeq).toString(36)}-test`;

/** «تأكيد وإصدار الكود» for review `reviewId`. */
export const issue = (admin: App, reviewId: string, body: Record<string, unknown>) =>
  post(admin, `/api/reviews/admin/${reviewId}/reward`, { action: 'approve', requestId: requestId(), ...body });

/** Issue and return the code and entitlement id (asserting success). */
export async function issueOk(admin: App, reviewId: string, body: Record<string, unknown>): Promise<{ code: string; entitlementId: string; body: Record<string, any> }> {
  const res = await issue(admin, reviewId, body);
  const out = await json(res);
  if (res.status !== 200) throw new Error(`issue refused: ${res.status} ${JSON.stringify(out)}`);
  return { code: out.code, entitlementId: out.entitlement.id, body: out };
}

export const redeem = (app: App, entitlementId: string, code: string, ip = '1.2.3.4') =>
  send(app, 'POST', `/api/reviews/gifts/${entitlementId}/redeem`, { code }, { 'CF-Connecting-IP': ip });

export async function myGifts(app: App): Promise<Record<string, any>> {
  const res = await get(app, '/api/reviews/gifts');
  if (res.status !== 200) throw new Error(`GET /gifts → ${res.status}`);
  return json(res);
}

/** The checkout's consumption of a gift, as S3's order batch writes it (fixture only). */
export function simulateGiftOrder(raw: DatabaseSync, entitlementId: string, orderId = 'ORD-GIFT', userId = 'buyer'): { orderId: string; itemId: string } {
  const g = raw.prepare('SELECT gift_product_id, order_seq FROM gift_entitlements WHERE id = ?').get(entitlementId) as {
    gift_product_id: string;
    order_seq: number;
  };
  const itemId = `${orderId}-gift`;
  raw.exec('BEGIN');
  try {
    raw.prepare(
      `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                           subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at)
       VALUES (?,?,'pending','{}','standard','{}','cod',0,5000,1400,5000,5000,'2026-09-10T00:00:00.000Z','2026-09-10T00:00:00.000Z')`
    ).run(orderId, userId);
    raw.prepare(
      `INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,
                                gift_entitlement_id,gift_order_seq)
       VALUES (?,?,?,'gift','','',1,0,0,?,?)`
    ).run(itemId, orderId, g.gift_product_id, entitlementId, Number(g.order_seq) + 1);
    raw.prepare(
      `UPDATE gift_entitlements SET state='ordered', order_id=?, order_item_id=?, ordered_at='2026-09-10T00:00:00.000Z',
              order_seq = order_seq + 1 WHERE id = ? AND state = 'redeemed_ready_to_order'`
    ).run(orderId, itemId, entitlementId);
    raw.prepare('DELETE FROM cart_items WHERE gift_entitlement_id = ?').run(entitlementId);
    raw.exec('COMMIT');
  } catch (e) {
    raw.exec('ROLLBACK');
    throw e;
  }
  return { orderId, itemId };
}

/** A gift cart line exactly as S3's add door writes it (fixture only). */
export function simulateGiftCartLine(raw: DatabaseSync, entitlementId: string, userId = 'buyer'): string {
  const g = raw
    .prepare('SELECT gift_product_id, gift_option_value_ids, gift_color_id, gift_sale_type, gift_transport_method FROM gift_entitlements WHERE id = ?')
    .get(entitlementId) as Record<string, string>;
  const ids = JSON.parse(g.gift_option_value_ids || '[]') as string[];
  const id = `cart-${entitlementId}`;
  raw.prepare(
    `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,
                             warranty_plan_id,qty,fulfillment_type,gift_entitlement_id)
     VALUES (?,?,?,?,?,?,?,?,'',1,?,?)`
  ).run(id, userId, g.gift_product_id, ids[0] ?? '', g.gift_option_value_ids, g.gift_color_id, `gift:${entitlementId}`, g.gift_transport_method, g.gift_sale_type, entitlementId);
  return id;
}

export { get, json, post, put, send };
