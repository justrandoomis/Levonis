/**
 * THE REWARDS PROGRAMME'S TERMS (owner, 2026-11-03; migration 0220;
 * docs/DECISIONS.md row 286).
 *
 *   «1 coupon free shipping for every printer on 1 week and 1 coupon
 *    discounted on selected filament also for every printer on 1 week.
 *    redeem point and competition and etc.»
 *
 * The owner's answers to the open choices are the defaults below, so the
 * programme runs from the deploy with exactly what was approved:
 *   · per printer unit DELIVERED, one free-shipping coupon and one filament
 *     coupon, each valid `valid_days` (7);
 *   · EVERY WEEK for the printer's warranty period, 12 months (owner,
 *     2026-11-05; migration 0225; DECISIONS rows 223 #4 and 295): «كل اسبوع»,
 *     «all the warranty period 12month». The extended warranty does not count;
 *   · the delivery coupon is worth 5,000 IQD on an order of 100,000 IQD or more
 *     (the minimum counts: owner, 2026-11-09, DECISIONS row 303 R3): «1 free
 *     shipping 5000», «للطلبات فوق 100 الف»;
 *   · the filament coupon is 15% off ONE PIECE, at most 25,000 IQD, on the
 *     filaments ticked in Admin → Rewards — and, until any is ticked, on every
 *     product in the FDM filament section: «the coupon is for 1 pic». It also works on
 *     a piece already on sale or otherwise discounted, off that price, while `on_offer`
 *     is on (owner, 2026-11-06, for eSUN PLA+ at its $15: the filament coupon only, with
 *     a switch; DECISIONS row 302). Every other discount keeps row 223 #5;
 *   · the POINTS SHOP sells the same two coupons for points, at prices the
 *     owner sets. NO PRICE IS INVENTED HERE: both items start switched off
 *     with no price, and the shop is not shown until the owner sets one;
 *   · and it sells PRODUCTS for points (owner, 2026-11-05; migration 0229;
 *     DECISIONS row 299): `shop.items`, each one real store product, model and
 *     colour at a price in points the owner sets. None exists until he adds it.
 *
 * Stored in `admin_settings` under `rewardProgramConfig`, written only by
 * PUT /api/admin/rewards/config (the owner: it decides what every printer
 * buyer is given). Read tolerantly: a missing or damaged row behaves exactly
 * like the defaults, field by field, so it can never give away more than the
 * owner approved — only what the documented default says.
 */
import { canonicalOptionValueIds } from '../cartSelectionIdentity';
import { newId } from '../crypto';
import { safeParse } from '../types';

export const REWARD_CONFIG_KEY = 'rewardProgramConfig';

/** The FDM filament section: «every filament in the shop» until the owner ticks some. */
export const FILAMENT_SECTION_ID = 'cat_materials_fdm';

export type RewardCouponKind = 'free_shipping' | 'filament_discount';
export const REWARD_COUPON_KINDS: readonly RewardCouponKind[] = ['free_shipping', 'filament_discount'];

export interface ShopItemConfig {
  enabled: boolean;
  /** What the coupon costs in points; null until the owner sets it. */
  points: number | null;
}

/**
 * One product the points shop sells: the store's own product, pinned the way a gift
 * pins one (gifts/selection.ts), and its price in points. An item with no price can
 * never be on sale, whatever its switch says.
 */
export interface ShopProductConfig {
  id: string;
  product_id: string;
  option_value_ids: string[];
  color_id: string;
  qty: number;
  sale_type: 'direct_sale' | 'pre_order';
  transport_method: '' | 'air' | 'sea' | 'land';
  points: number | null;
  enabled: boolean;
}

export interface RewardProgramConfig {
  /** Printer coupons are issued on delivery at all. */
  enabled: boolean;
  /** How long every reward coupon is valid, in days. */
  valid_days: number;
  /** A new pair every seven days through the printer's warranty, not one pair on delivery. */
  weekly: {
    enabled: boolean;
    /** The ceiling on how many months of its base warranty a printer earns for. */
    months: number;
  };
  free_shipping: {
    enabled: boolean;
    /** What one coupon takes off the delivery fee. */
    amount_iqd: number;
    /** The goods, after every discount, an order needs for the coupon to apply. */
    min_order_iqd: number;
  };
  filament: {
    enabled: boolean;
    /** 15 = 15% off the selected filaments' goods value. */
    percent: number;
    /** The most one order saves with it; null = no ceiling. */
    max_discount_iqd: number | null;
    /** The filaments the owner ticked; empty = the whole FDM filament section. */
    product_ids: string[];
    /** How many pieces one coupon discounts. */
    max_pieces: number;
    /** It also works on a piece that already has an offer or another discount, off that price. On unless the owner turns it off. */
    on_offer: boolean;
  };
  shop: Record<RewardCouponKind, ShopItemConfig> & {
    /** The products for points. Absent from a stored row: none. */
    items: ShopProductConfig[];
  };
}

export const REWARD_PROGRAM_DEFAULT: RewardProgramConfig = Object.freeze({
  enabled: true,
  valid_days: 7,
  weekly: { enabled: true, months: 12 },
  free_shipping: { enabled: true, amount_iqd: 5_000, min_order_iqd: 100_000 },
  filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: [], max_pieces: 1, on_offer: true },
  shop: {
    free_shipping: { enabled: false, points: null },
    filament_discount: { enabled: false, points: null },
    items: [],
  },
}) as RewardProgramConfig;

export const MAX_VALID_DAYS = 90;
export const MAX_SHOP_POINTS = 10_000_000;
export const MAX_DISCOUNT_IQD = 10_000_000;
export const MAX_FILAMENTS = 200;
export const MAX_WEEKLY_MONTHS = 60;
export const MAX_PIECES = 100;
/** The most products the shop sells at once. */
export const MAX_SHOP_PRODUCTS = 50;
/** The CHECK on `gift_entitlements.gift_qty` and the option cap of a selection (gifts/selection.ts, which this file must not import: it pulls the routes). */
const MAX_SHOP_PRODUCT_QTY = 99;
const MAX_SHOP_PRODUCT_OPTIONS = 12;

const isPosInt = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= max;
const isCount = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isProductId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);

function shopItem(raw: unknown, fallback: ShopItemConfig): ShopItemConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const points = r.points === null ? null : isPosInt(r.points, MAX_SHOP_POINTS) ? (r.points as number) : fallback.points;
  // An item with no price can never be on sale, whatever its switch says.
  const enabled = (typeof r.enabled === 'boolean' ? r.enabled : fallback.enabled) && points !== null;
  return { enabled, points };
}

const isItemId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const isSaleType = (v: unknown): v is ShopProductConfig['sale_type'] => v === 'direct_sale' || v === 'pre_order';
const isRoute = (v: unknown): v is ShopProductConfig['transport_method'] => v === '' || v === 'air' || v === 'sea' || v === 'land';
const isColorId = (v: unknown): v is string => typeof v === 'string' && v.length <= 80;
const isOptionList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MAX_SHOP_PRODUCT_OPTIONS && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 80);

/** One stored row, or null when it is not one: a damaged row is not on sale, alone. */
function shopProduct(raw: unknown): ShopProductConfig | null {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (!isItemId(r.id) || !isProductId(r.product_id) || !isSaleType(r.sale_type)) return null;
  const qty = r.qty === undefined ? 1 : r.qty;
  if (!isPosInt(qty, MAX_SHOP_PRODUCT_QTY)) return null;
  const points = isPosInt(r.points, MAX_SHOP_POINTS) ? r.points : null;
  return {
    id: r.id,
    product_id: r.product_id,
    option_value_ids: isOptionList(r.option_value_ids) ? canonicalOptionValueIds(r.option_value_ids) : [],
    color_id: isColorId(r.color_id) ? r.color_id : '',
    qty,
    sale_type: r.sale_type,
    // A direct sale has no route, whatever a field says (the rule of the gift's own columns).
    transport_method: r.sale_type === 'pre_order' && isRoute(r.transport_method) ? r.transport_method : '',
    points,
    enabled: r.enabled === true && points !== null,
  };
}

function shopProducts(raw: unknown): ShopProductConfig[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ShopProductConfig[] = [];
  for (const row of raw) {
    const item = shopProduct(row);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length === MAX_SHOP_PRODUCTS) break;
  }
  return out;
}

/** Tolerant read: every malformed field falls back to its default, alone. */
export function normalizeRewardConfig(raw: unknown): RewardProgramConfig {
  const parsed = typeof raw === 'string' ? safeParse<unknown>(raw, {}) : raw;
  const r = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const d = REWARD_PROGRAM_DEFAULT;
  const fs = (r.free_shipping && typeof r.free_shipping === 'object' ? r.free_shipping : {}) as Record<string, unknown>;
  const fl = (r.filament && typeof r.filament === 'object' ? r.filament : {}) as Record<string, unknown>;
  const wk = (r.weekly && typeof r.weekly === 'object' ? r.weekly : {}) as Record<string, unknown>;
  const shop = (r.shop && typeof r.shop === 'object' ? r.shop : {}) as Record<string, unknown>;
  const ids = Array.isArray(fl.product_ids)
    ? [...new Set(fl.product_ids.filter(isProductId))].slice(0, MAX_FILAMENTS)
    : [...d.filament.product_ids];
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    valid_days: isPosInt(r.valid_days, MAX_VALID_DAYS) ? (r.valid_days as number) : d.valid_days,
    weekly: {
      enabled: typeof wk.enabled === 'boolean' ? wk.enabled : d.weekly.enabled,
      months: isPosInt(wk.months, MAX_WEEKLY_MONTHS) ? (wk.months as number) : d.weekly.months,
    },
    free_shipping: {
      enabled: typeof fs.enabled === 'boolean' ? fs.enabled : d.free_shipping.enabled,
      amount_iqd: isPosInt(fs.amount_iqd, MAX_DISCOUNT_IQD) ? (fs.amount_iqd as number) : d.free_shipping.amount_iqd,
      min_order_iqd: isCount(fs.min_order_iqd, MAX_DISCOUNT_IQD) ? (fs.min_order_iqd as number) : d.free_shipping.min_order_iqd,
    },
    filament: {
      enabled: typeof fl.enabled === 'boolean' ? fl.enabled : d.filament.enabled,
      percent: isPosInt(fl.percent, 100) ? (fl.percent as number) : d.filament.percent,
      max_discount_iqd:
        fl.max_discount_iqd === null ? null : isPosInt(fl.max_discount_iqd, MAX_DISCOUNT_IQD) ? (fl.max_discount_iqd as number) : d.filament.max_discount_iqd,
      product_ids: ids,
      max_pieces: isPosInt(fl.max_pieces, MAX_PIECES) ? (fl.max_pieces as number) : d.filament.max_pieces,
      // `on_sale` was this switch's name for one release; a row saved then keeps its answer.
      on_offer: typeof fl.on_offer === 'boolean' ? fl.on_offer : typeof fl.on_sale === 'boolean' ? fl.on_sale : d.filament.on_offer,
    },
    shop: {
      free_shipping: shopItem(shop.free_shipping, d.shop.free_shipping),
      filament_discount: shopItem(shop.filament_discount, d.shop.filament_discount),
      items: shopProducts(shop.items),
    },
  };
}

type ConfigRefusal = { ok: false; error: string; code: string; details?: Record<string, unknown> };
export type RewardConfigCheck = { ok: true; value: RewardProgramConfig } | ConfigRefusal;

/**
 * The products as the owner's screen sends them, strictly. A new row has no id yet: the
 * server names it, and it keeps that name for good. Whether each one can be sold is the
 * gift code's own judgement and needs the database: PUT /config asks it.
 */
function checkShopProducts(raw: unknown): { ok: true; items: ShopProductConfig[] } | ConfigRefusal {
  if (!Array.isArray(raw)) return { ok: false, error: 'shop.items must be a list of products', code: 'REWARD_SHOP_ITEM_INVALID' };
  if (raw.length > MAX_SHOP_PRODUCTS) return { ok: false, error: `The points shop sells at most ${MAX_SHOP_PRODUCTS} products`, code: 'REWARD_SHOP_ITEMS_TOO_MANY' };
  const items: ShopProductConfig[] = [];
  const ids = new Set<string>();
  const onSale = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const refuse = (error: string, code = 'REWARD_SHOP_ITEM_INVALID'): ConfigRefusal => ({ ok: false, error: `shop.items[${index}]: ${error}`, code, details: { item_index: index } });
    const r = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null) as Record<string, unknown> | null;
    if (!r) return refuse('must be an object');
    const id = r.id === undefined || r.id === null || r.id === '' ? newId('rsi') : r.id;
    if (!isItemId(id) || ids.has(id)) return refuse('id must be a unique short name');
    if (!isProductId(r.product_id)) return refuse('product_id must name a product');
    if (!isSaleType(r.sale_type)) return refuse('sale_type must be direct_sale or pre_order');
    const transport = r.transport_method ?? '';
    if (!isRoute(transport)) return refuse('transport_method must be air, sea, land or empty');
    const options = r.option_value_ids ?? [];
    if (!isOptionList(options)) return refuse('option_value_ids must be a list of ids');
    const color = r.color_id ?? '';
    if (!isColorId(color)) return refuse('color_id must be an id');
    const qty = r.qty ?? 1;
    if (!isPosInt(qty, MAX_SHOP_PRODUCT_QTY)) return refuse(`qty must be a whole number from 1 to ${MAX_SHOP_PRODUCT_QTY}`);
    if (typeof r.enabled !== 'boolean') return refuse('enabled must be true or false');
    const points = r.points ?? null;
    if (points !== null && !isPosInt(points, MAX_SHOP_POINTS)) return refuse('points must be a whole number of points, or null');
    if (r.enabled && points === null) return refuse('cannot be on sale without a price in points', 'REWARD_SHOP_PRICE_REQUIRED');
    const item: ShopProductConfig = {
      id,
      product_id: r.product_id,
      option_value_ids: canonicalOptionValueIds(options),
      color_id: color,
      qty,
      sale_type: r.sale_type,
      transport_method: r.sale_type === 'pre_order' ? transport : '',
      points,
      enabled: r.enabled,
    };
    const selection = JSON.stringify([item.product_id, item.option_value_ids, item.color_id, item.qty, item.sale_type, item.transport_method]);
    if (item.enabled && onSale.has(selection)) return refuse('this exact product is already on sale', 'REWARD_SHOP_ITEM_DUPLICATE');
    if (item.enabled) onSale.add(selection);
    ids.add(id);
    items.push(item);
  }
  return { ok: true, items };
}

/**
 * Strict validation for the owner's write: a typo is refused, never stored. A screen an
 * older deploy loaded sends no `shop.items`: what it never saw keeps what is `stored`.
 */
export function validateRewardConfig(raw: unknown, stored?: RewardProgramConfig): RewardConfigCheck {
  const fail = (error: string, code = 'REWARD_CONFIG_INVALID'): RewardConfigCheck => ({ ok: false, error, code });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('The rewards settings must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return fail('enabled must be true or false');
  if (!isPosInt(r.valid_days, MAX_VALID_DAYS)) return fail(`valid_days must be a whole number of days from 1 to ${MAX_VALID_DAYS}`);
  const fs = r.free_shipping as Record<string, unknown> | undefined;
  if (!fs || typeof fs !== 'object' || typeof fs.enabled !== 'boolean') return fail('free_shipping.enabled must be true or false');
  // The fields 0225 added stay optional here, so a screen an older deploy loaded can still save: what it leaves out keeps the default.
  if (fs.amount_iqd !== undefined && !isPosInt(fs.amount_iqd, MAX_DISCOUNT_IQD)) return fail('free_shipping.amount_iqd must be a whole number of dinars');
  if (fs.min_order_iqd !== undefined && !isCount(fs.min_order_iqd, MAX_DISCOUNT_IQD)) return fail('free_shipping.min_order_iqd must be a whole number of dinars');
  const wk = r.weekly as Record<string, unknown> | undefined;
  if (wk !== undefined) {
    if (!wk || typeof wk !== 'object' || typeof wk.enabled !== 'boolean') return fail('weekly.enabled must be true or false');
    if (!isPosInt(wk.months, MAX_WEEKLY_MONTHS)) return fail(`weekly.months must be a whole number of months from 1 to ${MAX_WEEKLY_MONTHS}`);
  }
  const fl = r.filament as Record<string, unknown> | undefined;
  if (!fl || typeof fl !== 'object' || typeof fl.enabled !== 'boolean') return fail('filament.enabled must be true or false');
  if (!isPosInt(fl.percent, 100)) return fail('filament.percent must be a whole number from 1 to 100');
  if (fl.max_discount_iqd !== null && !isPosInt(fl.max_discount_iqd, MAX_DISCOUNT_IQD)) {
    return fail('filament.max_discount_iqd must be a whole number of dinars, or null for no ceiling');
  }
  if (!Array.isArray(fl.product_ids) || fl.product_ids.length > MAX_FILAMENTS || fl.product_ids.some((x) => !isProductId(x))) {
    return fail(`filament.product_ids must be a list of at most ${MAX_FILAMENTS} product ids`);
  }
  if (fl.max_pieces !== undefined && !isPosInt(fl.max_pieces, MAX_PIECES)) return fail(`filament.max_pieces must be a whole number from 1 to ${MAX_PIECES}`);
  if (fl.on_offer !== undefined && typeof fl.on_offer !== 'boolean') return fail('filament.on_offer must be true or false');
  const shop = r.shop as Record<string, unknown> | undefined;
  if (!shop || typeof shop !== 'object') return fail('shop must be an object');
  for (const kind of REWARD_COUPON_KINDS) {
    const item = shop[kind] as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object' || typeof item.enabled !== 'boolean') return fail(`shop.${kind}.enabled must be true or false`);
    if (item.points !== null && !isPosInt(item.points, MAX_SHOP_POINTS)) return fail(`shop.${kind}.points must be a whole number of points, or null`);
    if (item.enabled && item.points === null) return fail(`shop.${kind} cannot be on sale without a price in points`, 'REWARD_SHOP_PRICE_REQUIRED');
  }
  let items = stored?.shop.items ?? [];
  if (shop.items !== undefined) {
    const checked = checkShopProducts(shop.items);
    if (!checked.ok) return checked;
    items = checked.items;
  }
  // What an older screen never saw keeps what is stored, here too.
  const onOffer = fl.on_offer ?? stored?.filament.on_offer ?? false;
  return { ok: true, value: normalizeRewardConfig({ ...r, filament: { ...fl, on_offer: onOffer }, shop: { ...shop, items } }) };
}

/** The stored terms, or the defaults when nothing is stored (or the table is missing). */
export async function getRewardConfig(db: D1Database): Promise<RewardProgramConfig> {
  try {
    const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(REWARD_CONFIG_KEY).first<{ value: string }>();
    return normalizeRewardConfig(row?.value ?? null);
  } catch {
    return normalizeRewardConfig(null);
  }
}

/**
 * The stored terms for MINTING. A read that fails throws. `getRewardConfig` answers
 * with the defaults, which suits a page and not a coupon: one failed read would mint
 * on terms the owner changed, or with the programme switched off, and a notice with it.
 */
export async function getRewardConfigStrict(db: D1Database): Promise<RewardProgramConfig> {
  const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(REWARD_CONFIG_KEY).first<{ value: string }>();
  return normalizeRewardConfig(row?.value ?? null);
}

/** The statement that stores validated terms. */
export function saveRewardConfigStatement(db: D1Database, value: RewardProgramConfig): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO admin_settings (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(REWARD_CONFIG_KEY, JSON.stringify(value));
}
