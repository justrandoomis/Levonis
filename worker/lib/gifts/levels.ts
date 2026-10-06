/**
 * THE FIVE GIFT LEVELS AND THEIR ITEMS, AS THE ADMIN EDITS THEM
 * (docs/GIFTS_QUICK_BUY.md D2, D3; owner brief §1).
 *
 * A level is the canonical `gift_pools` row `gift_level_<n>`: its name and
 * description in Arabic, English and Sorani, and whether it is offered. Its
 * items are `gift_pool_items` rows pinned to ONE real store product — model,
 * colour, quantity, sale type and (for a pre-order) route. The items of a level
 * are alternatives; a customer with a level gift picks one. A legacy
 * label-only row (product_id NULL) is shown read-only and is never offered.
 */
import { badRequest, int, str } from '../http';
import { canonicalOptionValueIds } from '../cartSelectionIdentity';
import {
  checkGiftSelection,
  GIFT_QTY_MAX,
  type GiftProductContext,
  type GiftSelectionInput,
  type GiftSelectionResult,
} from './selection';
import { itemSelection, levelItemChoice, type GiftItemView } from './model';

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

export interface LevelPatch {
  name_ar?: string;
  name_en?: string;
  name_ckb?: string;
  description_ar?: string;
  description_en?: string;
  description_ckb?: string;
  active?: number;
}

/** PUT /api/gifts/admin/levels/:n — every field optional, each one validated. */
export function parseLevelPatch(body: Record<string, unknown>): LevelPatch {
  const out: LevelPatch = {};
  if (body.name_ar !== undefined) out.name_ar = str(body.name_ar, 'name_ar', { min: 1, max: 80 });
  if (body.name_en !== undefined) out.name_en = str(body.name_en, 'name_en', { max: 80, required: false });
  if (body.name_ckb !== undefined) out.name_ckb = str(body.name_ckb, 'name_ckb', { max: 80, required: false });
  if (body.description_ar !== undefined) out.description_ar = str(body.description_ar, 'description_ar', { max: 600, required: false });
  if (body.description_en !== undefined) out.description_en = str(body.description_en, 'description_en', { max: 600, required: false });
  if (body.description_ckb !== undefined) out.description_ckb = str(body.description_ckb, 'description_ckb', { max: 600, required: false });
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw badRequest('active must be true or false');
    out.active = body.active ? 1 : 0;
  }
  if (Object.keys(out).length === 0) throw badRequest('Nothing to update', 'NOTHING_TO_UPDATE');
  return out;
}

export interface ItemInput {
  productId: string;
  optionValueIds: string[];
  colorId: string;
  qty: number;
  saleType: string;
  transportMethod: string;
  sort: number;
  active: boolean;
}

/**
 * A level item or a manual product as the admin sends it. The quantity is the
 * number of units the gift grants; the sale type is stated, never inferred.
 */
export function parseItemInput(body: Record<string, unknown>, base?: ItemInput): ItemInput {
  const pick = <T>(key: string, parse: (v: unknown) => T, fallback: T | undefined): T => {
    if (body[key] === undefined) {
      if (fallback === undefined) return parse(undefined);
      return fallback;
    }
    return parse(body[key]);
  };
  const productId = pick('productId', (v) => str(v, 'productId', { min: 1, max: 80 }), base?.productId);
  const optionValueIds = pick(
    'optionValueIds',
    (v) => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest('optionValueIds must be a list of ids');
      return canonicalOptionValueIds(v as string[]).slice(0, 12);
    },
    base?.optionValueIds
  );
  const colorId = pick('colorId', (v) => str(v, 'colorId', { max: 80, required: false }), base?.colorId);
  const qty = pick('qty', (v) => int(v, 'qty', { min: 1, max: GIFT_QTY_MAX, def: 1 }), base?.qty);
  const saleType = pick(
    'saleType',
    (v) => {
      if (v !== 'direct_sale' && v !== 'pre_order') throw badRequest('saleType must be direct_sale or pre_order', 'GIFT_SALE_TYPE_UNAVAILABLE');
      return v;
    },
    base?.saleType
  );
  const transportMethod = pick(
    'transportMethod',
    (v) => {
      if (v === undefined || v === null || v === '') return '';
      if (v !== 'air' && v !== 'sea' && v !== 'land') throw badRequest('transportMethod must be air, sea or land');
      return v;
    },
    base?.transportMethod
  );
  const sort = pick('sort', (v) => int(v, 'sort', { min: -100000, max: 100000, def: 0 }), base?.sort);
  const active = pick(
    'active',
    (v) => {
      if (v === undefined) return true;
      if (typeof v !== 'boolean') throw badRequest('active must be true or false');
      return v;
    },
    base?.active
  );
  return { productId, optionValueIds, colorId, qty, saleType, transportMethod: saleType === 'direct_sale' ? '' : transportMethod, sort, active };
}

export const itemSelectionInput = (i: ItemInput): GiftSelectionInput => ({
  productId: i.productId,
  saleType: i.saleType,
  optionValueIds: i.optionValueIds,
  colorId: i.colorId,
  transportMethod: i.transportMethod,
  qty: i.qty,
});

/** The store's verdict on an admin's item: configured correctly, whatever today's stock. */
export function validateItem(p: GiftProductContext, input: ItemInput): GiftSelectionResult {
  return checkGiftSelection(p, itemSelectionInput(input), { requireSellable: false });
}

/** The stored item row as the editor reads it back. */
export function itemInputFromRow(row: Record<string, unknown>): ItemInput {
  const sel = itemSelection(row);
  return {
    productId: text(row.product_id),
    optionValueIds: sel?.optionValueIds ?? [],
    colorId: text(row.color_id),
    qty: Math.max(1, Number(row.qty) || 1),
    saleType: text(row.sale_type) || 'direct_sale',
    transportMethod: text(row.transport_method),
    sort: Number(row.sort) || 0,
    active: Number(row.active) === 1,
  };
}

export interface AdminItemView extends GiftItemView {
  id: string;
  level: number;
  active: boolean;
  sort: number;
  option_value_ids: string[];
  color_id: string;
  updated_at: string | null;
}

/** One product-backed level item for the admin editor, with today's availability. */
export function adminItemView(row: Record<string, unknown>, product: GiftProductContext | undefined): AdminItemView | null {
  const view = levelItemChoice(row, product);
  if (!view) return null;
  const sel = itemSelection(row)!;
  return {
    ...view,
    id: text(row.id),
    level: Number(row.level),
    active: Number(row.active) === 1,
    sort: Number(row.sort) || 0,
    option_value_ids: sel.optionValueIds,
    color_id: sel.colorId,
    updated_at: row.updated_at == null ? null : text(row.updated_at),
  };
}

/** A legacy label-only row, read-only in the new editor. */
export function legacyItemView(row: Record<string, unknown>) {
  return {
    id: text(row.id),
    level: Number(row.level),
    kind: text(row.kind),
    label: { ar: text(row.label_ar), en: text(row.label_en) || text(row.label_ar), ckb: text(row.label_ckb) || text(row.label_ar) },
    brand: text(row.brand),
    material: text(row.material),
    color: text(row.color),
    option_value: text(row.option_value),
    stock: Number(row.stock) || 0,
    active: Number(row.active) === 1,
  };
}
