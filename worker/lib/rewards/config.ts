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
 *   · the filament coupon is 15% off, at most 25,000 IQD per order, on the
 *     filaments ticked in Admin → Rewards — and, until any is ticked, on every
 *     product in the FDM filament section;
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
  free_shipping: { enabled: boolean };
  filament: {
    enabled: boolean;
    /** 15 = 15% off the selected filaments' goods value. */
    percent: number;
    /** The most one order saves with it; null = no ceiling. */
    max_discount_iqd: number | null;
    /** The filaments the owner ticked; empty = the whole FDM filament section. */
    product_ids: string[];
  };
  shop: Record<RewardCouponKind, ShopItemConfig>;
}

export const REWARD_PROGRAM_DEFAULT: RewardProgramConfig = Object.freeze({
  enabled: true,
  valid_days: 7,
  free_shipping: { enabled: true },
  filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: [] },
  shop: {
    free_shipping: { enabled: false, points: null },
    filament_discount: { enabled: false, points: null },
  },
}) as RewardProgramConfig;

export const MAX_VALID_DAYS = 90;
export const MAX_SHOP_POINTS = 10_000_000;
export const MAX_DISCOUNT_IQD = 10_000_000;
export const MAX_FILAMENTS = 200;

const isPosInt = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= max;
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
  const shop = (r.shop && typeof r.shop === 'object' ? r.shop : {}) as Record<string, unknown>;
  const ids = Array.isArray(fl.product_ids)
    ? [...new Set(fl.product_ids.filter(isProductId))].slice(0, MAX_FILAMENTS)
    : [...d.filament.product_ids];
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    valid_days: isPosInt(r.valid_days, MAX_VALID_DAYS) ? (r.valid_days as number) : d.valid_days,
    free_shipping: { enabled: typeof fs.enabled === 'boolean' ? fs.enabled : d.free_shipping.enabled },
    filament: {
      enabled: typeof fl.enabled === 'boolean' ? fl.enabled : d.filament.enabled,
      percent: isPosInt(fl.percent, 100) ? (fl.percent as number) : d.filament.percent,
      max_discount_iqd:
        fl.max_discount_iqd === null ? null : isPosInt(fl.max_discount_iqd, MAX_DISCOUNT_IQD) ? (fl.max_discount_iqd as number) : d.filament.max_discount_iqd,
      product_ids: ids,
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
  const fl = r.filament as Record<string, unknown> | undefined;
  if (!fl || typeof fl !== 'object' || typeof fl.enabled !== 'boolean') return fail('filament.enabled must be true or false');
  if (!isPosInt(fl.percent, 100)) return fail('filament.percent must be a whole number from 1 to 100');
  if (fl.max_discount_iqd !== null && !isPosInt(fl.max_discount_iqd, MAX_DISCOUNT_IQD)) {
    return fail('filament.max_discount_iqd must be a whole number of dinars, or null for no ceiling');
  }
  if (!Array.isArray(fl.product_ids) || fl.product_ids.length > MAX_FILAMENTS || fl.product_ids.some((x) => !isProductId(x))) {
    return fail(`filament.product_ids must be a list of at most ${MAX_FILAMENTS} product ids`);
  }
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

/** The statement that stores validated terms. */
export function saveRewardConfigStatement(db: D1Database, value: RewardProgramConfig): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO admin_settings (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(REWARD_CONFIG_KEY, JSON.stringify(value));
}
