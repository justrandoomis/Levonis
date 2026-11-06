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
 *   · the delivery coupon is worth 5,000 IQD on an order over 100,000 IQD: «1
 *     free shipping 5000», «للطلبات فوق 100 الف»;
 *   · the filament coupon is 15% off ONE PIECE, at most 25,000 IQD, on the
 *     filaments ticked in Admin → Rewards — and, until any is ticked, on every
 *     product in the FDM filament section: «the coupon is for 1 pic»;
 *   · it also works on a piece already on sale, off the sale price (owner,
 *     2026-11-06, for eSUN PLA+ at its $15: the filament coupon only, with a
 *     switch; DECISIONS row 302). Every other discount keeps row 223 #5;
 *   · the POINTS SHOP sells the same two coupons for points, at prices the
 *     owner sets. NO PRICE IS INVENTED HERE: both items start switched off
 *     with no price, and the shop is not shown until the owner sets one.
 *
 * Stored in `admin_settings` under `rewardProgramConfig`, written only by
 * PUT /api/admin/rewards/config (the owner: it decides what every printer
 * buyer is given). Read tolerantly: a missing or damaged row behaves exactly
 * like the defaults, field by field, so it can never give away more than the
 * owner approved — only what the documented default says.
 */
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
    /** It also takes its percentage off a piece already on sale, off the sale price. */
    on_sale: boolean;
  };
  shop: Record<RewardCouponKind, ShopItemConfig>;
}

export const REWARD_PROGRAM_DEFAULT: RewardProgramConfig = Object.freeze({
  enabled: true,
  valid_days: 7,
  weekly: { enabled: true, months: 12 },
  free_shipping: { enabled: true, amount_iqd: 5_000, min_order_iqd: 100_000 },
  filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: [], max_pieces: 1, on_sale: true },
  shop: {
    free_shipping: { enabled: false, points: null },
    filament_discount: { enabled: false, points: null },
  },
}) as RewardProgramConfig;

export const MAX_VALID_DAYS = 90;
export const MAX_SHOP_POINTS = 10_000_000;
export const MAX_DISCOUNT_IQD = 10_000_000;
export const MAX_FILAMENTS = 200;
export const MAX_WEEKLY_MONTHS = 60;
export const MAX_PIECES = 100;

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
      on_sale: typeof fl.on_sale === 'boolean' ? fl.on_sale : d.filament.on_sale,
    },
    shop: {
      free_shipping: shopItem(shop.free_shipping, d.shop.free_shipping),
      filament_discount: shopItem(shop.filament_discount, d.shop.filament_discount),
    },
  };
}

export type RewardConfigCheck = { ok: true; value: RewardProgramConfig } | { ok: false; error: string; code: string };

/** Strict validation for the owner's write: a typo is refused, never stored. */
export function validateRewardConfig(raw: unknown): RewardConfigCheck {
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
  if (fl.on_sale !== undefined && typeof fl.on_sale !== 'boolean') return fail('filament.on_sale must be true or false');
  const shop = r.shop as Record<string, unknown> | undefined;
  if (!shop || typeof shop !== 'object') return fail('shop must be an object');
  for (const kind of REWARD_COUPON_KINDS) {
    const item = shop[kind] as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object' || typeof item.enabled !== 'boolean') return fail(`shop.${kind}.enabled must be true or false`);
    if (item.points !== null && !isPosInt(item.points, MAX_SHOP_POINTS)) return fail(`shop.${kind}.points must be a whole number of points, or null`);
    if (item.enabled && item.points === null) return fail(`shop.${kind} cannot be on sale without a price in points`, 'REWARD_SHOP_PRICE_REQUIRED');
  }
  return { ok: true, value: normalizeRewardConfig(r) };
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
