/**
 * THE REVIEW-GIFT COMMERCE WORLD (docs/REVIEWS_GIFTS.md §6.3, lane S3).
 *
 * A fully migrated database with a buyer, a stranger, an address, a wallet,
 * and two real catalogue products a gift can grant:
 *
 *   p_nozzle — DIRECT SALE, inventory per model (OPTION): «0.4 mm» has 3 on the
 *              shelf, «0.6 mm» none; two colours (red, blue), untracked.
 *   p_plate  — PRE-ORDER only, by air: the model «Textured PEI» has a pre-order
 *              cell (20–30 days) and an air route of its own (10–14 days,
 *              15,000 IQD commission); colour black.
 *
 * `grantGift` writes the rows the gift lane (S2) leaves behind after «تأكيد
 * وإصدار الكود» and a correct code: a published 5★ review, an approved
 * printer-gift reward, and an entitlement `redeemed_ready_to_order` with its
 * frozen product line. Nothing here is a mock of the cart or the checkout:
 * every request below goes through the real routes and the real triggers.
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, type StubUser } from './app';
import { cartRoutes } from '../../worker/routes/cart';
import { orderRoutes } from '../../worker/routes/orders';
import { acceptedPolicies } from '../lib/policies';

export const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
export const STRANGER: StubUser = { id: 'other', role: 'customer', email: 'o@x.co' };

export function giftWorld(raw: DatabaseSync = freshDb()): DatabaseSync {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('other','Omar','o@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_o','other','Home','Omar','+9647701234568','Baghdad, Mansour 3','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',100000,'approved'),
      ('dep_o','other','deposit','USD',100000,'approved');

    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,
                          preorder_transports,images,inventory_mode)
    VALUES ('p_nozzle','nozzle-kit','Nozzle kit','طقم فوهات',40000,'active',NULL,'[]','[]','direct_sale',
            '["direct_sale"]','[]','[]','OPTION');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_size','p_nozzle','Size',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active,stock) VALUES
      ('v_04','p_nozzle','g_size','0.4 mm',0,1,3),
      ('v_06','p_nozzle','g_size','0.6 mm',1,1,0);
    INSERT INTO product_colors (id,product_id,name_en,hex,sort,active) VALUES
      ('c_red','p_nozzle','Red','#ff0000',0,1),
      ('c_blue','p_nozzle','Blue','#0000ff',1,1);

    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,
                          preorder_transports,images,inventory_mode)
    VALUES ('p_plate','pei-plate','PEI plate','لوح PEI',60000,'active',NULL,'[]','[]','pre_order',
            '["pre_order"]','[{"method":"air","commission_iqd":15000,"active":true}]','[]','BASE');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_surface','p_plate','Surface',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active,stock) VALUES
      ('v_pei','p_plate','g_surface','Textured PEI',0,1,NULL);
    INSERT INTO product_colors (id,product_id,name_en,hex,sort,active) VALUES ('c_black','p_plate','Black','#000000',0,1);
    INSERT INTO product_option_fulfillment
      (id,product_id,option_id,fulfillment_type,enabled,lead_time_text,lead_time_min_days,lead_time_max_days)
    VALUES ('f_pei_p','p_plate','v_pei','pre_order',1,'20-30 days',20,30);
    INSERT INTO product_option_transports
      (id,product_id,fulfillment_id,method,enabled,surcharge_iqd,lead_time_text,lead_time_min_days,lead_time_max_days)
    VALUES ('t_pei_air','p_plate','f_pei_p','air',1,15000,'10-14 days',10,14);
  `);
  return raw;
}

export interface GiftLine {
  productId: string;
  saleType: 'direct_sale' | 'pre_order';
  optionValueIds: string[];
  colorId: string;
  transport: '' | 'air' | 'sea' | 'land';
}

/** The direct-sale gift every test reaches for: nozzle kit, 0.4 mm, red. */
export const NOZZLE_04_RED: GiftLine = {
  productId: 'p_nozzle',
  saleType: 'direct_sale',
  optionValueIds: ['v_04'],
  colorId: 'c_red',
  transport: '',
};
/** The pre-order gift: PEI plate, black, by air. */
export const PLATE_AIR: GiftLine = {
  productId: 'p_plate',
  saleType: 'pre_order',
  optionValueIds: ['v_pei'],
  colorId: 'c_black',
  transport: 'air',
};

let printerSeq = 0;

/**
 * One granted gift, as S2 leaves it. `state` defaults to «redeemed — ready to
 * order»; `line: null` is a level gift whose customer has not chosen yet.
 */
export function grantGift(
  raw: DatabaseSync,
  opts: {
    id: string;
    userId?: string;
    line?: GiftLine | null;
    state?: 'code_issued' | 'redeemed_ready_to_order' | 'cancelled';
    level?: number;
  }
): string {
  const userId = opts.userId ?? 'buyer';
  const level = opts.level ?? 3;
  const state = opts.state ?? 'redeemed_ready_to_order';
  const line = opts.line === undefined ? NOZZLE_04_RED : opts.line;
  const printer = `p_printer_${++printerSeq}`;
  const now = new Date().toISOString();
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
    .run(`rv_${opts.id}`, userId, printer);
  raw
    .prepare(
      `INSERT INTO review_rewards (id,review_id,user_id,kind,state,quality_score,decided_by,decided_at,product_id)
       VALUES (?, ?, ?, 'printer_gift', 'approved', ?, 'admin', ?, ?)`
    )
    .run(`rr_${opts.id}`, `rv_${opts.id}`, userId, level, now, printer);
  const issued = state === 'code_issued';
  raw
    .prepare(
      `INSERT INTO gift_entitlements
         (id, reward_id, user_id, max_level, chosen_level, state, grant_mode, gift_snapshot, gift_item_ref,
          gift_product_id, gift_option_value_ids, gift_color_id, gift_sale_type, gift_transport_method,
          code_verifier, code_state, code_attempts, code_version, code_issued_at, code_issued_by, code_redeemed_at,
          cancelled_at, cancelled_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, 'pbkdf2$1$x$y', ?, 0, 1, ?, 'admin', ?, ?, ?)`
    )
    .run(
      opts.id,
      `rr_${opts.id}`,
      userId,
      level,
      level,
      state,
      line ? 'manual' : 'level',
      line ? 'manual' : '',
      line ? line.productId : null,
      JSON.stringify(line ? [...line.optionValueIds].sort() : []),
      line ? line.colorId : '',
      line ? line.saleType : '',
      line ? line.transport : '',
      issued ? 'issued' : state === 'cancelled' ? 'revoked' : 'redeemed',
      now,
      issued ? null : now,
      state === 'cancelled' ? now : null,
      state === 'cancelled' ? 'admin' : null
    );
  return opts.id;
}

/** The cart and the checkout, mounted the way worker/index.ts mounts them. */
export const shopApp = (db: D1Database, user: StubUser = BUYER) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

let keySeq = 0;
export const orderBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `gift-checkout-key-${++keySeq}-${Date.now()}`,
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

export const db = (raw: DatabaseSync) => asD1(raw);
