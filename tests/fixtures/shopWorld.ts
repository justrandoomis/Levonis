/**
 * A WORLD FOR THE POINTS SHOP'S PRODUCTS (DECISIONS row 299): the rewards world, the live
 * eSUN PLA+ product as the store holds it (read from its public page, 2026-11-06: one model
 * «With spool — 1 kg», three colours linked to it, stock per combination, and an open-ended
 * public offer that strikes 27,250 IQD to 24,000) and the owner's own prices, every door
 * mounted the way worker/index.ts mounts it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, row, stubApp, type App, type Mount } from './app';
import { BOSS, BUYER, OTHER, mountGifts } from './giftWorld';
import { rewardsWorld } from './rewardsWorld';
import { REWARD_CONFIG_KEY } from '../../worker/lib/rewards/config';
import { adminRewardsRoutes } from '../../worker/routes/adminRewards';
import { rewardProgramRoutes } from '../../worker/routes/rewardsProgram';
import { rewardRoutes } from '../../worker/routes/rewards';

/** The owner's message: «23000 … beige, 23100 … black, 23250 … cold white». */
export const ESUN_ITEMS = [
  { id: 'esun_beige', product_id: 'p_esun', option_value_ids: ['v_esun'], color_id: 'c_esun_beige', qty: 1, sale_type: 'direct_sale', transport_method: '', points: 23_000, enabled: true },
  { id: 'esun_black', product_id: 'p_esun', option_value_ids: ['v_esun'], color_id: 'c_esun_black', qty: 1, sale_type: 'direct_sale', transport_method: '', points: 23_100, enabled: true },
  { id: 'esun_white', product_id: 'p_esun', option_value_ids: ['v_esun'], color_id: 'c_esun_white', qty: 1, sale_type: 'direct_sale', transport_method: '', points: 23_250, enabled: true },
] as const;

/** What a customer pays for one piece: the live offer's price. */
export const ESUN_UNIT_IQD = 24_000;
/** The price the live offer strikes through. */
export const ESUN_BEFORE_OFFER_IQD = 27_250;
/** What a gift of it is shown as worth: its regular price, in this fixture's published dollars. A gift looks up no offer (S8). Never charged. */
export const ESUN_GIFT_VALUE_IQD = 28_000;

export function esunWorld(appliedAt = Date.now()): DatabaseSync {
  const raw = rewardsWorld(appliedAt);
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode,category_id)
      VALUES ('p_esun','esun-pla-plus','eSUN PLA+ Filament — 1 kg','فلمنت eSUN PLA+ — 1 كغم','فیلامێنتی eSUN PLA+ — 1 کگ',${ESUN_BEFORE_OFFER_IQD},'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','["https://cdn/esun.png"]','VARIANT_COMBINATION','cat_materials_fdm');
    INSERT INTO offer_windows (subject_type,subject_id,id,required_tiers,offer_price_mode,offer_price_iqd,active)
      VALUES ('product','p_esun','ofw_prd8e73357c771c4fc0b811','[]','fixed',${ESUN_UNIT_IQD},1);
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_esun','p_esun','نوع العبوة',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,name_ckb,sort,active,stock)
      VALUES ('v_esun','p_esun','g_esun','With spool — 1 kg','مع البكرة — 1 كغم','لەگەڵ قرقرە — 1 کگ',0,1,NULL);
    INSERT INTO product_colors (id,product_id,name_en,name_ar,name_ckb,hex,sort,active) VALUES
      ('c_esun_black','p_esun','BLACK','أسود','ڕەش','#272729',0,1),
      ('c_esun_white','p_esun','COLD WHITE','أبيض بارد','سپیی سارد','#dbd6dc',1,1),
      ('c_esun_beige','p_esun','BEIGE','بيج','بێژ','#fdc094',2,1);
    INSERT INTO product_color_option_links (color_id,option_value_id,group_id) VALUES
      ('c_esun_black','v_esun','g_esun'), ('c_esun_white','v_esun','g_esun'), ('c_esun_beige','v_esun','g_esun');
    INSERT INTO product_variants (id,product_id,combo_key,active,stock,reserved) VALUES
      ('var_black','p_esun','o:v_esun|c:c_esun_black',1,120,0),
      ('var_white','p_esun','o:v_esun|c:c_esun_white',1,50,0),
      ('var_beige','p_esun','o:v_esun|c:c_esun_beige',1,82,0);
  `);
  return raw;
}

/** Writes the terms the way the owner's save stores them: anything not named is the default. */
export function setTerms(raw: DatabaseSync, terms: Record<string, unknown>) {
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(REWARD_CONFIG_KEY, JSON.stringify(terms));
}

/** The owner's three colours on sale, and the coupon at 3,000. */
export function ownersPrices(raw: DatabaseSync) {
  setTerms(raw, { shop: { free_shipping: { enabled: true, points: 3_000 }, filament_discount: { enabled: false, points: null }, items: ESUN_ITEMS } });
}

export const points = (raw: DatabaseSync, userId = 'buyer'): number =>
  row<{ n: number }>(raw, "SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) AS n FROM wallet_transactions WHERE user_id = ? AND currency='POINT' AND status='approved'", userId)!.n;

let deposit = 0;
export function givePoints(raw: DatabaseSync, n: number, userId = 'buyer') {
  raw.prepare("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES (?,?,'deposit','POINT',?,'approved')").run(`pts_test_${++deposit}`, userId, n);
}

export const mountShop: Mount = (a) => {
  mountGifts(a);
  a.route('/api/rewards/program', rewardProgramRoutes);
  a.route('/api/rewards', rewardRoutes);
  a.route('/api/admin/rewards', adminRewardsRoutes);
};

export interface ShopApps {
  db: D1Database;
  buyer: App;
  other: App;
  admin: App;
}

export function shopApps(raw: DatabaseSync, db: D1Database = asD1(raw)): ShopApps {
  const app = (user: typeof BUYER) => stubApp(db, user, mountShop, { publishV2: 'always' });
  return { db, buyer: app(BUYER), other: app(OTHER), admin: app(BOSS) };
}
