/**
 * SKU × CHANNEL: the identity every engine price is stored under (master plan v2
 * §2.3, LD1, C20, C21).
 *
 * A price row of `product_sku_prices` (0179) is keyed `(product_id, combo_key,
 * channel)`:
 * - `combo_key` is EXACTLY the identity `product_variants` uses (worker/lib/
 *   inventory.ts `comboKey`): option value ids sorted, each `o:<id>`, then
 *   `c:<colour id>`, joined by `|`. `''` is the product itself (no option and no
 *   colour), which a `product_variants` row cannot represent. `skuComboKey` below
 *   mirrors that function byte for byte (`tests/pricingCostToPrice.test.ts` pins
 *   the two against each other), because this package may not import worker/.
 * - `channel` is one of the four ways a SKU is sold. Each pre-order route has its
 *   own shipping profile (air → CHINA_AIR, sea → CHINA_SEA, land → GERMANY_LAND);
 *   `direct_sale` is priced on the SKU's own default profile.
 *
 * Pure: no I/O. The worker decides which channels are enabled for a SKU (the
 * resolver's one availability rule set); this file only names them.
 */
import type { ShippingType } from './shippingType';

export type SkuChannel = 'direct_sale' | 'pre_order_air' | 'pre_order_sea' | 'pre_order_land';
export const SKU_CHANNELS: readonly SkuChannel[] = ['direct_sale', 'pre_order_air', 'pre_order_sea', 'pre_order_land'];

export type PreorderRoute = 'air' | 'sea' | 'land';
export const PREORDER_ROUTES: readonly PreorderRoute[] = ['air', 'sea', 'land'];

export type ShippingProfile = 'GERMANY_LAND' | 'CHINA_AIR' | 'CHINA_SEA';
export const SHIPPING_PROFILES: readonly ShippingProfile[] = ['GERMANY_LAND', 'CHINA_AIR', 'CHINA_SEA'];

/** How a profile's freight is charged: per kg (land, air) or per CBM (sea). */
export type ShippingBasis = 'weight' | 'volume';

/** Owner decision 4: air = CHINA_AIR, sea = CHINA_SEA, land = GERMANY_LAND. */
export const ROUTE_PROFILE: Readonly<Record<PreorderRoute, ShippingProfile>> = {
  air: 'CHINA_AIR',
  sea: 'CHINA_SEA',
  land: 'GERMANY_LAND',
};

export const PROFILE_BASIS: Readonly<Record<ShippingProfile, ShippingBasis>> = {
  GERMANY_LAND: 'weight',
  CHINA_AIR: 'weight',
  CHINA_SEA: 'volume',
};

export const isSkuChannel = (value: unknown): value is SkuChannel =>
  typeof value === 'string' && (SKU_CHANNELS as readonly string[]).includes(value);

export const isShippingProfile = (value: unknown): value is ShippingProfile =>
  typeof value === 'string' && (SHIPPING_PROFILES as readonly string[]).includes(value);

/** `pre_order_<route>`. */
export function channelOfRoute(route: PreorderRoute): SkuChannel {
  return `pre_order_${route}`;
}

/** The pre-order route of a channel; null for `direct_sale`. */
export function routeOfChannel(channel: SkuChannel): PreorderRoute | null {
  switch (channel) {
    case 'pre_order_air':
      return 'air';
    case 'pre_order_sea':
      return 'sea';
    case 'pre_order_land':
      return 'land';
    default:
      return null;
  }
}

/** The shipping profile a channel is priced on. `direct_sale` uses the SKU's
 * default (base) profile, so it is null until that profile is known. */
export function profileOfChannel(channel: SkuChannel, defaultProfile: ShippingProfile | null): ShippingProfile | null {
  const route = routeOfChannel(channel);
  return route ? ROUTE_PROFILE[route] : defaultProfile;
}

/** The cart's shipping type (`shippingType.ts`) for a channel, and back. */
export function shippingTypeOfChannel(channel: SkuChannel): ShippingType {
  const route = routeOfChannel(channel);
  return route ? `preorder_${route}` : 'direct';
}

export function channelOfShippingType(type: ShippingType): SkuChannel {
  switch (type) {
    case 'preorder_air':
      return 'pre_order_air';
    case 'preorder_sea':
      return 'pre_order_sea';
    case 'preorder_land':
      return 'pre_order_land';
    default:
      return 'direct_sale';
  }
}

/** The combo key of the product itself (no option, no colour). */
export const PRODUCT_COMBO_KEY = '';

export interface SkuSelection {
  option_value_ids: readonly string[];
  color_id: string | null | undefined;
}

/**
 * The canonical, order-independent combo key — a mirror of `comboKey` in
 * worker/lib/inventory.ts (the `product_variants.combo_key` writer). Computed
 * server-side only; a client-supplied key is never trusted.
 */
export function skuComboKey(sel: SkuSelection): string {
  const opts = [...sel.option_value_ids].filter(Boolean).sort();
  const parts = opts.map((id) => `o:${id}`);
  if (sel.color_id) parts.push(`c:${sel.color_id}`);
  return parts.join('|');
}

/**
 * The selection a CANONICAL combo key names, or null when the key is not one
 * `skuComboKey` could have produced (unsorted options, an empty id, a colour
 * that is not last, two colours, an unknown part). `''` is the product itself.
 */
export function parseSkuComboKey(key: string): { option_value_ids: string[]; color_id: string | null } | null {
  if (typeof key !== 'string') return null;
  if (key === PRODUCT_COMBO_KEY) return { option_value_ids: [], color_id: null };
  const option_value_ids: string[] = [];
  let color_id: string | null = null;
  for (const part of key.split('|')) {
    if (color_id !== null) return null; // the colour is always the last part
    const id = part.slice(2);
    if (!id) return null;
    if (part.startsWith('o:')) option_value_ids.push(id);
    else if (part.startsWith('c:')) color_id = id;
    else return null;
  }
  return skuComboKey({ option_value_ids, color_id }) === key ? { option_value_ids, color_id } : null;
}

/** Price-history key of an engine row: `sku:<combo_key>@<channel>` (C21). */
export function skuPriceHistoryKey(comboKey: string, channel: SkuChannel): string {
  return `sku:${comboKey}@${channel}`;
}
