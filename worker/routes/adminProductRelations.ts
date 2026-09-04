import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, str, int } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { deriveSaleTypes, normalizeAvailability, variantKeyFrom, variantLabelFallback } from '../lib/availability';
import { normalizeSaleTypes } from '../lib/productModel';
import { canViewFinancials, projectForAdmin } from '../lib/adminScope';
import {
  isValidHex,
  normalizeHex,
  loadProductRelations,
  validatePriceLadder,
} from '../lib/productRelations';
import {
  applyInventory,
  comboKey,
  isInventoryMode,
  resolveStock,
  type InventoryMode,
  type InventorySnapshot,
  type StockTarget,
} from '../lib/inventory';

/**
 * Option groups, values, colours, colour↔option links, variant stock, images
 * and facet placement for ONE product — mandate §7, §8 and §11.
 *
 * WHY ONE "REPLACE THE SET" ENDPOINT rather than per-row CRUD: the form edits
 * the whole structure at once, and the constraints are cross-row — a colour
 * link must point at a value that still exists, a variant key must name a
 * combination that still exists, exactly one image may be primary. Applying
 * the whole set in a single D1 batch means those invariants are checked
 * against the state actually being written, and a partial failure rolls the
 * whole structure back instead of leaving dangling links.
 *
 * WHAT IS PRESERVED ACROSS A SAVE. Rows are matched by id, so `stock` and
 * `reserved` survive an edit that only renames a value or reorders it. A row
 * that disappears from the payload is deleted — unless it currently holds
 * reserved units for a live order, which is refused with the count, because
 * deleting it would silently release someone's held stock.
 *
 * §11 applies throughout: an assistant admin can neither read nor write cost,
 * on this endpoint as on every other.
 */

export const adminProductRelationsRoutes = new Hono<AppContext>();
adminProductRelationsRoutes.use('*', requireAdmin);

interface PriceInput {
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  /** 0044 adjustments — signed, and null on every row that has never used one. */
  regular_adjust_iqd: number | null;
  prime_adjust_iqd: number | null;
  pro_adjust_iqd: number | null;
  cost_adjust_iqd: number | null;
}

const nullableInt = (v: unknown, field: string, max = 1_000_000_000): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    throw badRequest(`${field}: must be a whole number between 0 and ${max}, or empty`);
  }
  return v;
};

/** A 0044 adjustment may be negative — a discount below the inherited value is
 *  the ordinary case — so it cannot share `nullableInt`, which floors at zero. */
const nullableSigned = (v: unknown, field: string, max = 1_000_000_000): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > max) {
    throw badRequest(`${field}: must be a whole number between -${max} and ${max}, or empty`);
  }
  return v;
};

function readPrices(o: Record<string, unknown>, where: string): PriceInput {
  return {
    regular_price_iqd: nullableInt(o.regular_price_iqd, `${where}.regular_price_iqd`),
    prime_price_iqd: nullableInt(o.prime_price_iqd, `${where}.prime_price_iqd`),
    pro_price_iqd: nullableInt(o.pro_price_iqd, `${where}.pro_price_iqd`),
    cost_iqd: nullableInt(o.cost_iqd, `${where}.cost_iqd`),
    regular_adjust_iqd: nullableSigned(o.regular_adjust_iqd, `${where}.regular_adjust_iqd`),
    prime_adjust_iqd: nullableSigned(o.prime_adjust_iqd, `${where}.prime_adjust_iqd`),
    pro_adjust_iqd: nullableSigned(o.pro_adjust_iqd, `${where}.pro_adjust_iqd`),
    cost_adjust_iqd: nullableSigned(o.cost_adjust_iqd, `${where}.cost_adjust_iqd`),
  };
}

const asArray = (v: unknown, field: string): Record<string, unknown>[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw badRequest(`${field}: expected a list`);
  return v.map((x, i) => {
    if (!x || typeof x !== 'object') throw badRequest(`${field}[${i}]: expected an object`);
    return x as Record<string, unknown>;
  });
};

// ------------------------------------------------------------------- reading

/** Builds the snapshot the inventory resolver needs, straight from the DB. */
export async function inventorySnapshot(db: D1Database, productId: string): Promise<InventorySnapshot> {
  const product = await db
    .prepare(
      'SELECT inventory_mode, stock, stock_reserved, low_stock_threshold FROM products WHERE id = ?'
    )
    .bind(productId)
    .first<{
      inventory_mode: string;
      stock: number | null;
      stock_reserved: number;
      low_stock_threshold: number | null;
    }>();
  if (!product) throw notFound('Product not found');

  const rel = await loadProductRelations(db, productId);
  const variants = await db
    .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY combo_key')
    .bind(productId)
    .all<{
      id: string;
      combo_key: string;
      stock: number | null;
      reserved: number;
      low_stock_threshold: number | null;
      active: number;
    }>();

  return {
    inventory_mode: isInventoryMode(product.inventory_mode) ? product.inventory_mode : 'BASE',
    base: {
      stock: product.stock,
      reserved: product.stock_reserved ?? 0,
      low_stock_threshold: product.low_stock_threshold,
    },
    option_values: rel.values.map((v) => ({
      id: v.id,
      group_id: v.group_id,
      name_en: v.name_en,
      stock: v.stock,
      reserved: v.reserved ?? 0,
      low_stock_threshold: v.low_stock_threshold,
    })),
    colors: rel.colors.map((c) => ({
      id: c.id,
      name_en: c.name_en,
      stock: c.stock,
      reserved: c.reserved ?? 0,
      low_stock_threshold: c.low_stock_threshold,
    })),
    variants: variants.results.map((v) => ({
      id: v.id,
      combo_key: v.combo_key,
      stock: v.stock,
      reserved: v.reserved ?? 0,
      low_stock_threshold: v.low_stock_threshold,
      active: !!v.active,
    })),
    group_ids: rel.groups.map((g) => g.id),
  };
}

adminProductRelationsRoutes.get('/:id/relations', async (c) => {
  const productId = c.req.param('id');
  const product = await c.env.DB
    .prepare('SELECT id, inventory_mode, stock, stock_reserved, low_stock_threshold FROM products WHERE id = ?')
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!product) throw notFound('Product not found');

  const rel = await loadProductRelations(c.env.DB, productId);
  const [variants, images, facets] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY combo_key').bind(productId).all(),
    c.env.DB
      .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, id')
      .bind(productId)
      .all(),
    c.env.DB.prepare('SELECT facet_id FROM product_facets WHERE product_id = ?').bind(productId).all<{ facet_id: string }>(),
  ]);

  return c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      product: {
        id: product.id,
        inventory_mode: product.inventory_mode,
        stock: product.stock,
        stock_reserved: product.stock_reserved,
        low_stock_threshold: product.low_stock_threshold,
      },
      groups: rel.groups,
      values: rel.values,
      colors: rel.colors,
      links: rel.links,
      variants: variants.results,
      images: images.results,
      facet_ids: facets.results.map((f) => f.facet_id),
    })
  );
});

/** Availability per modelled combination — the admin stock table (§7). */
adminProductRelationsRoutes.get('/:id/stock', async (c) => {
  const productId = c.req.param('id');
  const snap = await inventorySnapshot(c.env.DB, productId);
  const rel = await loadProductRelations(c.env.DB, productId);

  const rows: Array<Record<string, unknown>> = [];
  if (snap.inventory_mode === 'BASE') {
    const r = resolveStock(snap, { option_value_ids: [], color_id: null });
    rows.push({ label: 'Base', combo_key: '', available: r.available, tracked: r.tracked, scope: 'base' });
  } else if (snap.inventory_mode === 'OPTION') {
    for (const v of snap.option_values) {
      const r = resolveStock(snap, { option_value_ids: [v.id], color_id: null });
      rows.push({ label: v.name_en, combo_key: `o:${v.id}`, available: r.available, tracked: r.tracked, scope: 'option' });
    }
  } else if (snap.inventory_mode === 'COLOR') {
    for (const col of snap.colors) {
      const r = resolveStock(snap, { option_value_ids: [], color_id: col.id });
      rows.push({ label: col.name_en, combo_key: `c:${col.id}`, available: r.available, tracked: r.tracked, scope: 'color' });
    }
  } else {
    const nameOf = new Map<string, string>([
      ...rel.values.map((v) => [v.id, v.name_en] as [string, string]),
      ...rel.colors.map((x) => [x.id, x.name_en] as [string, string]),
    ]);
    for (const v of snap.variants) {
      const label = v.combo_key
        .split('|')
        .map((part) => nameOf.get(part.slice(2)) ?? part)
        .join(' / ');
      rows.push({
        label,
        combo_key: v.combo_key,
        available: v.stock === null ? null : Math.max(0, v.stock - v.reserved),
        tracked: v.stock !== null,
        scope: 'variant',
        low_stock: v.low_stock_threshold !== null && v.stock !== null && v.stock - v.reserved <= v.low_stock_threshold,
      });
    }
  }

  const ledger = await c.env.DB
    .prepare(
      `SELECT kind, scope, scope_id, qty, order_id, reason, created_at
         FROM inventory_ledger WHERE product_id = ? ORDER BY created_at DESC LIMIT 100`
    )
    .bind(productId)
    .all();

  return c.json({ success: true, inventory_mode: snap.inventory_mode, rows, ledger: ledger.results });
});

// ------------------------------------------------------------------- writing

/**
 * The whole-structure write, as a function rather than a handler.
 *
 * WHY IT LIVES HERE AND NOT INSIDE THE ROUTE BODY: the CSV/ZIP importer (§10)
 * writes exactly the same structure from a spreadsheet that the form writes
 * from the browser. Two implementations would drift, and the one nobody looks
 * at would be the one that stops rejecting a colour linked to a deleted
 * option. So both callers go through this, and the route below is a thin
 * wrapper that supplies the request body.
 *
 * It PLANS and does not execute: on success it returns the statements for the
 * caller to run. The importer needs them combined with its own product write
 * in ONE batch, so a product and its options can never half-land.
 */
export async function planRelationsWrite(
  db: D1Database,
  productId: string,
  body: Record<string, unknown>,
  opts: { money: boolean }
): Promise<
  | { errors: string[]; stmts?: undefined }
  | {
      errors: never[];
      stmts: D1PreparedStatement[];
      mode: InventoryMode;
      summary: {
        inventory_mode: InventoryMode;
        groups: number;
        values: number;
        colors: number;
        links: number;
        variants: number;
        images: number;
        primary_image: string | null;
        facets: number | 'preserved';
        cost_written: boolean;
      };
    }
> {
  const money = opts.money;

  const product = await db
    .prepare('SELECT id, inventory_mode FROM products WHERE id = ?')
    .bind(productId)
    .first<{ id: string; inventory_mode: string }>();
  if (!product) throw notFound('Product not found');

  const existing = await loadProductRelations(db, productId);
  const existingVariants = await db
    .prepare('SELECT * FROM product_variants WHERE product_id = ?')
    .bind(productId)
    .all<{ id: string; combo_key: string; reserved: number; stock: number | null }>();
  const existingImages = await db
    .prepare('SELECT * FROM product_images WHERE product_id = ?')
    .bind(productId)
    .all<{ id: string }>();
  // What the product declares about itself today — the floor the derived sale
  // types fall back to when no option has an opinion.
  const productRow = await db
    .prepare('SELECT sale_types, selling_type FROM products WHERE id = ?')
    .bind(productId)
    .first<{ sale_types: string; selling_type: string }>();
  const existingSaleTypes = normalizeSaleTypes(
    productRow?.sale_types,
    String(productRow?.selling_type ?? 'direct_sale')
  ) as string[];

  const errors: string[] = [];

  // ---- inventory mode ----------------------------------------------------
  const mode: InventoryMode = isInventoryMode(body.inventory_mode)
    ? body.inventory_mode
    : isInventoryMode(product.inventory_mode)
      ? product.inventory_mode
      : 'BASE';

  // ---- groups ------------------------------------------------------------
  const groupInputs = asArray(body.groups, 'groups').map((g, i) => ({
    id: typeof g.id === 'string' && g.id ? g.id : newId('og'),
    name_en: str(g.name_en, `groups[${i}].name_en`, { max: 80 }),
    sort: int(g.sort, `groups[${i}].sort`, { min: 0, max: 10000, def: i }),
    active: g.active === false ? 0 : 1,
    values: asArray(g.values, `groups[${i}].values`),
  }));
  const groupIds = new Set(groupInputs.map((g) => g.id));
  if (groupIds.size !== groupInputs.length) errors.push('groups: duplicate group id');

  // ---- values ------------------------------------------------------------
  const valueInputs: Array<{
    id: string;
    group_id: string;
    name_en: string;
    sku_part: string;
    image: string;
    sort: number;
    active: number;
    stock: number | null;
    low_stock_threshold: number | null;
    prices: PriceInput;
    availability_type: string;
    lead_time_text: string;
    lead_time_min_days: number | null;
    lead_time_max_days: number | null;
    variant_key: string;
    variant_label: string;
  }> = [];
  for (const g of groupInputs) {
    g.values.forEach((v, i) => {
      const where = `${g.name_en}[${i}]`;
      const prices = readPrices(v, where);
      errors.push(...validatePriceLadder(prices, where));
      const name = str(v.name_en, `${where}.name_en`, { max: 80 });
      // 0043. Unknown words become '' (inherit) rather than an error: this
      // endpoint is also how an old client saves an old product, and refusing
      // a field it has never heard of would break editing the catalogue.
      const availability = normalizeAvailability(v.availability_type);
      const leadText = str(v.lead_time_text, `${where}.lead_time_text`, { max: 120, required: false }) ?? '';
      const leadMin = nullableInt(v.lead_time_min_days, `${where}.lead_time_min_days`, 3650);
      const leadMax = nullableInt(v.lead_time_max_days, `${where}.lead_time_max_days`, 3650);
      if (leadMin !== null && leadMax !== null && leadMin > leadMax) {
        errors.push(`${where}: lead_time_min_days is after lead_time_max_days`);
      }
      // A direct-sale option has no journey to wait for, so a lead time on one
      // is a contradiction the admin should see rather than a value to store.
      if (availability === 'direct_sale' && (leadText.trim() || leadMin !== null || leadMax !== null)) {
        errors.push(`${where}: a direct-sale option has no lead time`);
      }
      const label = str(v.variant_label, `${where}.variant_label`, { max: 80, required: false }) ?? '';
      const key = str(v.variant_key, `${where}.variant_key`, { max: 60, required: false }) ?? '';
      // The label falls back to the option's own name with the availability
      // suffix removed, and the key to that label's slug — so a product saved
      // by a client that does not know these fields still groups correctly.
      const effectiveLabel = label.trim() || variantLabelFallback(name);
      valueInputs.push({
        id: typeof v.id === 'string' && v.id ? v.id : newId('ov'),
        group_id: g.id,
        name_en: name,
        sku_part: str(v.sku_part, `${where}.sku_part`, { max: 40, required: false }) ?? '',
        image: str(v.image, `${where}.image`, { max: 500, required: false }) ?? '',
        sort: int(v.sort, `${where}.sort`, { min: 0, max: 10000, def: i }),
        active: v.active === false ? 0 : 1,
        stock: nullableInt(v.stock, `${where}.stock`, 10_000_000),
        low_stock_threshold: nullableInt(v.low_stock_threshold, `${where}.low_stock_threshold`, 10_000_000),
        prices,
        availability_type: availability,
        lead_time_text: leadText,
        lead_time_min_days: availability === 'direct_sale' ? null : leadMin,
        lead_time_max_days: availability === 'direct_sale' ? null : leadMax,
        variant_key: key.trim() || variantKeyFrom(effectiveLabel),
        variant_label: effectiveLabel,
      });
    });
  }
  const valueIds = new Set(valueInputs.map((v) => v.id));
  if (valueIds.size !== valueInputs.length) errors.push('values: duplicate value id');

  // ---- colours and their links -------------------------------------------
  const colorInputs = asArray(body.colors, 'colors').map((col, i) => {
    const where = `colors[${i}]`;
    const hexRaw = str(col.hex, `${where}.hex`, { max: 9 });
    if (!isValidHex(hexRaw)) {
      errors.push(`${where}.hex: must be #RGB or #RRGGBB`);
    }
    const prices = readPrices(col, where);
    errors.push(...validatePriceLadder(prices, where));
    const linkedRaw = Array.isArray(col.option_value_ids) ? col.option_value_ids : [];
    const linked = linkedRaw.filter((x): x is string => typeof x === 'string');
    for (const l of linked) {
      if (!valueIds.has(l)) errors.push(`${where}: linked option value ${l} does not exist in this product`);
    }
    return {
      id: typeof col.id === 'string' && col.id ? col.id : newId('pc'),
      name_en: str(col.name_en, `${where}.name_en`, { max: 80 }),
      hex: isValidHex(hexRaw) ? normalizeHex(hexRaw) : '#000000',
      image: str(col.image, `${where}.image`, { max: 500, required: false }) ?? '',
      sku_part: str(col.sku_part, `${where}.sku_part`, { max: 40, required: false }) ?? '',
      sort: int(col.sort, `${where}.sort`, { min: 0, max: 10000, def: i }),
      active: col.active === false ? 0 : 1,
      stock: nullableInt(col.stock, `${where}.stock`, 10_000_000),
      low_stock_threshold: nullableInt(col.low_stock_threshold, `${where}.low_stock_threshold`, 10_000_000),
      prices,
      linked,
    };
  });
  const colorIds = new Set(colorInputs.map((x) => x.id));
  if (colorIds.size !== colorInputs.length) errors.push('colors: duplicate colour id');

  // ---- variants ----------------------------------------------------------
  const groupOfValue = new Map(valueInputs.map((v) => [v.id, v.group_id]));
  const variantInputs = asArray(body.variants, 'variants').map((v, i) => {
    const where = `variants[${i}]`;
    const optionIds = (Array.isArray(v.option_value_ids) ? v.option_value_ids : []).filter(
      (x): x is string => typeof x === 'string'
    );
    const colorId = typeof v.color_id === 'string' && v.color_id ? v.color_id : null;
    for (const id of optionIds) {
      if (!valueIds.has(id)) errors.push(`${where}: option value ${id} does not exist in this product`);
    }
    if (colorId && !colorIds.has(colorId)) errors.push(`${where}: colour ${colorId} does not exist in this product`);
    const seenGroups = new Set<string>();
    for (const id of optionIds) {
      const g = groupOfValue.get(id);
      if (g && seenGroups.has(g)) errors.push(`${where}: two values from the same option group`);
      if (g) seenGroups.add(g);
    }
    const prices = readPrices(v, where);
    errors.push(...validatePriceLadder(prices, where));
    // The key is computed here, never taken from the client (§11: "لا تثق في
    // سعر أو عضوية أو شحن مرسل من الواجهة").
    const key = comboKey({ option_value_ids: optionIds, color_id: colorId });
    if (!key) errors.push(`${where}: a variant needs at least one option value or a colour`);
    return {
      id: typeof v.id === 'string' && v.id ? v.id : newId('pv'),
      combo_key: key,
      sku: str(v.sku, `${where}.sku`, { max: 60, required: false }) || null,
      active: v.active === false ? 0 : 1,
      stock: nullableInt(v.stock, `${where}.stock`, 10_000_000),
      low_stock_threshold: nullableInt(v.low_stock_threshold, `${where}.low_stock_threshold`, 10_000_000),
      prices,
    };
  });
  const variantKeys = new Set(variantInputs.map((v) => v.combo_key));
  if (variantKeys.size !== variantInputs.length) errors.push('variants: two rows describe the same combination');
  if (mode === 'VARIANT_COMBINATION' && variantInputs.length === 0) {
    errors.push('inventory_mode=VARIANT_COMBINATION needs at least one modelled combination, or nothing can be sold');
  }

  // ---- images ------------------------------------------------------------
  const imageInputs = asArray(body.images, 'images').map((img, i) => {
    const where = `images[${i}]`;
    const optionValueId = typeof img.option_value_id === 'string' && img.option_value_id ? img.option_value_id : null;
    const colorId = typeof img.color_id === 'string' && img.color_id ? img.color_id : null;
    const variantId = typeof img.variant_id === 'string' && img.variant_id ? img.variant_id : null;
    const bindings = [optionValueId, colorId, variantId].filter(Boolean).length;
    if (bindings > 1) errors.push(`${where}: an image may be bound to at most one of option, colour or variant`);
    if (optionValueId && !valueIds.has(optionValueId)) errors.push(`${where}: unknown option value`);
    if (colorId && !colorIds.has(colorId)) errors.push(`${where}: unknown colour`);
    if (variantId && !variantInputs.some((v) => v.id === variantId)) errors.push(`${where}: unknown variant`);
    return {
      id: typeof img.id === 'string' && img.id ? img.id : newId('pi'),
      url: str(img.url, `${where}.url`, { max: 1000 }),
      alt_en: str(img.alt_en, `${where}.alt_en`, { max: 300, required: false }) ?? '',
      sort_order: int(img.sort_order, `${where}.sort_order`, { min: 0, max: 10000, def: i }),
      is_primary: img.is_primary === true ? 1 : 0,
      option_value_id: optionValueId,
      color_id: colorId,
      variant_id: variantId,
      content_type: str(img.content_type, `${where}.content_type`, { max: 100, required: false }) ?? '',
      // ---- 0048 -----------------------------------------------------------
      // The template has always advertised alt_ar, alt_ckb, key and source_url
      // for an image; the table had nowhere to put them, so the overlay filled
      // the Arabic and Kurdish alt with the ENGLISH one and reported the other
      // two as empty. Now they are real columns, and a vendor photo keeps a
      // record of the page it came from.
      alt_ar: str(img.alt_ar, `${where}.alt_ar`, { max: 300, required: false }) ?? '',
      alt_ckb: str(img.alt_ckb, `${where}.alt_ckb`, { max: 300, required: false }) ?? '',
      r2_key: str(img.r2_key, `${where}.r2_key`, { max: 400, required: false }) ?? '',
      source_url: str(img.source_url, `${where}.source_url`, { max: 1000, required: false }) ?? '',
      width: nullableInt(img.width, `${where}.width`, 100000),
      height: nullableInt(img.height, `${where}.height`, 100000),
      bytes: nullableInt(img.bytes, `${where}.bytes`, 1_000_000_000),
    };
  });
  const primaries = imageInputs.filter((i) => i.is_primary === 1);
  if (primaries.length > 1) {
    errors.push('images: only one image can be the primary image');
  }
  if (imageInputs.length > 0 && primaries.length === 0) {
    // Rather than refusing the save, the first image becomes primary — the
    // storefront needs one and silently having none is worse than choosing.
    imageInputs[0].is_primary = 1;
  }

  // ---- facets ------------------------------------------------------------
  //
  // ABSENT MEANS PRESERVE, not "clear". The product form no longer carries a
  // filters picker (the owner's «احذف الفلاتر هي تابعه او نفسها القسم
  // الفرعي»), so every save from the browser omits `facet_ids` — and a writer
  // that read an omitted key as an empty list would delete a product's stored
  // filters the first time anyone edited its price. An explicit array still
  // replaces the set, which is what the importer and the API contract need.
  const facetIds = Array.isArray(body.facet_ids)
    ? body.facet_ids.filter((x): x is string => typeof x === 'string')
    : null;

  // ---- deletions that would strand reserved stock ------------------------
  const keptValues = valueIds;
  const keptColors = colorIds;
  const keptVariants = new Set(variantInputs.map((v) => v.id));
  for (const v of existing.values) {
    if (!keptValues.has(v.id) && (v.reserved ?? 0) > 0) {
      errors.push(`Option "${v.name_en}" has ${v.reserved} unit(s) reserved for live orders and cannot be removed`);
    }
  }
  for (const col of existing.colors) {
    if (!keptColors.has(col.id) && (col.reserved ?? 0) > 0) {
      errors.push(`Colour "${col.name_en}" has ${col.reserved} unit(s) reserved for live orders and cannot be removed`);
    }
  }
  for (const v of existingVariants.results) {
    if (!keptVariants.has(v.id) && (v.reserved ?? 0) > 0) {
      errors.push(`Combination "${v.combo_key}" has ${v.reserved} reserved unit(s) and cannot be removed`);
    }
  }

  // ---- an id must not belong to a DIFFERENT product ----------------------
  //
  // The upserts below key on id, so a payload naming another product's group,
  // colour or image would silently re-parent it — and, when two products
  // reuse an id, collide on product_color_option_links' primary key and
  // surface as a 500 instead of a message. Both are refused here by name.
  const claimed: Array<{ table: string; ids: string[]; label: string }> = [
    { table: 'product_option_groups', ids: [...groupIds], label: 'option group' },
    { table: 'product_option_values', ids: [...valueIds], label: 'option value' },
    { table: 'product_colors', ids: [...colorIds], label: 'colour' },
    { table: 'product_variants', ids: variantInputs.map((v) => v.id), label: 'variant' },
    { table: 'product_images', ids: imageInputs.map((i) => i.id), label: 'image' },
  ];
  for (const { table, ids, label } of claimed) {
    if (ids.length === 0) continue;
    const ph = ids.map(() => '?').join(', ');
    const { results: foreign } = await db
      .prepare(`SELECT id FROM ${table} WHERE id IN (${ph}) AND product_id <> ?`)
      .bind(...ids, productId)
      .all<{ id: string }>();
    for (const row of foreign) {
      errors.push(`${label} id "${row.id}" already belongs to another product`);
    }
  }

  // ---- a variant SKU is unique across the STORE --------------------------
  //
  // idx_product_variants_sku is a partial unique index over every non-empty
  // SKU in the table, not per product — so "L-BLK" on a second product is
  // refused by SQLite with `UNIQUE constraint failed`, which reaches an admin
  // as an unreadable D1 error and an importer as a failed row with a database
  // string for a reason. Two products having a Large-Black combination is
  // ordinary, so the collision is named here, with the product that holds it.
  const skus = [...new Set(variantInputs.map((v) => v.sku).filter((x): x is string => !!x))];
  if (skus.length) {
    const ph = skus.map(() => '?').join(', ');
    const { results: taken } = await db
      .prepare(
        `SELECT v.sku, COALESCE(NULLIF(p.name_ar,''), p.name, v.product_id) AS owner
           FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE v.sku IN (${ph}) AND v.product_id <> ?`
      )
      .bind(...skus, productId)
      .all<{ sku: string; owner: string }>();
    for (const row of taken) {
      errors.push(`Combination SKU "${row.sku}" is already used by "${row.owner}" — a SKU is unique across the store`);
    }
  }

  if (errors.length) return { errors: [...new Set(errors)] };

  // ---- the statements, run as ONE batch by the caller ---------------------
  const stmts: D1PreparedStatement[] = [];

  stmts.push(db.prepare('UPDATE products SET inventory_mode = ? WHERE id = ?').bind(mode, productId));

  /**
   * 0043 — THE PRODUCT FOLLOWS ITS OPTIONS.
   *
   * `sale_types` decides real things downstream: which order stages a purchase
   * walks through, which shipping type the cart locks to, whether a transport
   * must be chosen. If an admin marks one option pre-order and the product
   * still says direct sale, the buyer gets direct-sale stages for a parcel
   * that is weeks away — so the product is DERIVED from its options here
   * rather than validated against them, and the two cannot drift.
   *
   * A product whose options all stay silent keeps exactly what it declared,
   * which is every product that existed before this migration. `selling_type`
   * is refreshed alongside as sale_types[0], the same legacy-scalar contract
   * productModel.ts has kept since 0018.
   */
  const declaredSaleTypes = deriveSaleTypes(
    valueInputs.map((v) => ({
      availability_type: normalizeAvailability(v.availability_type),
      active: v.active === 1,
    })),
    existingSaleTypes
  );
  if (declaredSaleTypes.join(',') !== existingSaleTypes.join(',')) {
    stmts.push(
      db
        .prepare('UPDATE products SET sale_types = ?, selling_type = ? WHERE id = ?')
        .bind(
          JSON.stringify(declaredSaleTypes),
          // The CHECK on selling_type only admits the three original words.
          declaredSaleTypes.find((t) => t === 'direct_sale' || t === 'pre_order' || t === 'bundle') ?? 'direct_sale',
          productId
        )
    );
  }

  // Links are rebuilt wholesale; they are pure join rows with no state.
  stmts.push(
    db
      .prepare(
        'DELETE FROM product_color_option_links WHERE color_id IN (SELECT id FROM product_colors WHERE product_id = ?)'
      )
      .bind(productId)
  );

  // Remove rows the payload dropped. Images and links first so no foreign key
  // points at a row that is about to disappear.
  const del = (table: string, keep: Set<string>, rows: Array<{ id: string }>) => {
    for (const r of rows) {
      if (!keep.has(r.id)) stmts.push(db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(r.id));
    }
  };
  del('product_images', new Set(imageInputs.map((i) => i.id)), existingImages.results);
  del('product_variants', keptVariants, existingVariants.results.map((v) => ({ id: v.id })));
  del('product_colors', keptColors, existing.colors);
  del('product_option_values', keptValues, existing.values);
  del('product_option_groups', groupIds, existing.groups);

  for (const g of groupInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_option_groups (id, product_id, name_en, sort, active)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name_en = excluded.name_en, sort = excluded.sort, active = excluded.active`
        )
        .bind(g.id, productId, g.name_en, g.sort, g.active)
    );
  }

  for (const v of valueInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_option_values
             (id, product_id, group_id, name_en, sku_part, image, sort, active, stock, low_stock_threshold,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
              regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd,
              availability_type, lead_time_text, lead_time_min_days, lead_time_max_days,
              variant_key, variant_label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             group_id = excluded.group_id, name_en = excluded.name_en, sku_part = excluded.sku_part,
             image = excluded.image, sort = excluded.sort, active = excluded.active,
             stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
             regular_price_iqd = excluded.regular_price_iqd, prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd,
             regular_adjust_iqd = excluded.regular_adjust_iqd,
             prime_adjust_iqd = excluded.prime_adjust_iqd,
             pro_adjust_iqd = excluded.pro_adjust_iqd,
             availability_type = excluded.availability_type,
             lead_time_text = excluded.lead_time_text,
             lead_time_min_days = excluded.lead_time_min_days,
             lead_time_max_days = excluded.lead_time_max_days,
             variant_key = excluded.variant_key,
             variant_label = excluded.variant_label${money ? ', cost_iqd = excluded.cost_iqd, cost_adjust_iqd = excluded.cost_adjust_iqd' : ''}`
        )
        .bind(
          v.id, productId, v.group_id, v.name_en, v.sku_part, v.image, v.sort, v.active,
          v.stock, v.low_stock_threshold,
          v.prices.regular_price_iqd, v.prices.prime_price_iqd, v.prices.pro_price_iqd,
          money ? v.prices.cost_iqd : null,
          v.prices.regular_adjust_iqd, v.prices.prime_adjust_iqd, v.prices.pro_adjust_iqd,
          money ? v.prices.cost_adjust_iqd : null,
          v.availability_type, v.lead_time_text, v.lead_time_min_days, v.lead_time_max_days,
          v.variant_key, v.variant_label
        )
    );
  }

  for (const col of colorInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_colors
             (id, product_id, name_en, hex, image, sku_part, sort, active, stock, low_stock_threshold,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
              regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name_en = excluded.name_en, hex = excluded.hex, image = excluded.image,
             sku_part = excluded.sku_part, sort = excluded.sort, active = excluded.active,
             stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
             regular_price_iqd = excluded.regular_price_iqd, prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd,
             regular_adjust_iqd = excluded.regular_adjust_iqd,
             prime_adjust_iqd = excluded.prime_adjust_iqd,
             pro_adjust_iqd = excluded.pro_adjust_iqd${money ? ', cost_iqd = excluded.cost_iqd, cost_adjust_iqd = excluded.cost_adjust_iqd' : ''}`
        )
        .bind(
          col.id, productId, col.name_en, col.hex, col.image, col.sku_part, col.sort, col.active,
          col.stock, col.low_stock_threshold,
          col.prices.regular_price_iqd, col.prices.prime_price_iqd, col.prices.pro_price_iqd,
          money ? col.prices.cost_iqd : null,
          col.prices.regular_adjust_iqd, col.prices.prime_adjust_iqd, col.prices.pro_adjust_iqd,
          money ? col.prices.cost_adjust_iqd : null
        )
    );
    for (const valueId of col.linked) {
      const groupId = groupOfValue.get(valueId)!;
      stmts.push(
        db
          .prepare(
            // OR IGNORE: the same value listed twice in one payload is a
            // harmless client slip, not a reason to fail the whole save.
            'INSERT OR IGNORE INTO product_color_option_links (color_id, option_value_id, group_id) VALUES (?, ?, ?)'
          )
          .bind(col.id, valueId, groupId)
      );
    }
  }

  for (const v of variantInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_variants
             (id, product_id, combo_key, sku, active, stock, low_stock_threshold,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             combo_key = excluded.combo_key, sku = excluded.sku, active = excluded.active,
             stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
             regular_price_iqd = excluded.regular_price_iqd, prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd${money ? ', cost_iqd = excluded.cost_iqd' : ''}`
        )
        .bind(
          v.id, productId, v.combo_key, v.sku, v.active, v.stock, v.low_stock_threshold,
          v.prices.regular_price_iqd, v.prices.prime_price_iqd, v.prices.pro_price_iqd,
          money ? v.prices.cost_iqd : null
        )
    );
  }

  // Clear the old primary BEFORE writing the new one: the partial unique index
  // idx_product_images_primary would otherwise reject the batch.
  stmts.push(db.prepare('UPDATE product_images SET is_primary = 0 WHERE product_id = ?').bind(productId));
  for (const img of imageInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_images
             (id, product_id, url, alt_en, sort_order, is_primary, option_value_id, color_id, variant_id,
              width, height, bytes, content_type, alt_ar, alt_ckb, r2_key, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             url = excluded.url, alt_en = excluded.alt_en, sort_order = excluded.sort_order,
             is_primary = excluded.is_primary, option_value_id = excluded.option_value_id,
             color_id = excluded.color_id, variant_id = excluded.variant_id,
             width = excluded.width, height = excluded.height, bytes = excluded.bytes,
             content_type = excluded.content_type,
             -- ---- 0048, PRESERVED WHEN NOT SENT ----------------------------
             -- Every existing client omits these four: the admin form's
             -- relations PUT and the CSV importer both map images without
             -- them, so writing "excluded" unconditionally meant the next
             -- ordinary price edit wiped the Arabic alt text and, worse, the
             -- record of which vendor page a photo came from — the column the
             -- whole ingest feature exists to fill. An empty incoming value
             -- therefore keeps what is stored. The cost of that is that these
             -- four cannot be cleared by blanking them; the template's
             -- __CLEAR__ is not wired to them either, so nothing silently
             -- promises otherwise.
             alt_ar = CASE WHEN excluded.alt_ar <> '' THEN excluded.alt_ar ELSE product_images.alt_ar END,
             alt_ckb = CASE WHEN excluded.alt_ckb <> '' THEN excluded.alt_ckb ELSE product_images.alt_ckb END,
             r2_key = CASE WHEN excluded.r2_key <> '' THEN excluded.r2_key ELSE product_images.r2_key END,
             source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE product_images.source_url END`
        )
        .bind(
          img.id, productId, img.url, img.alt_en, img.sort_order, img.is_primary,
          img.option_value_id, img.color_id, img.variant_id,
          img.width, img.height, img.bytes, img.content_type,
          img.alt_ar, img.alt_ckb, img.r2_key, img.source_url
        )
    );
  }

  if (facetIds !== null) {
    stmts.push(db.prepare('DELETE FROM product_facets WHERE product_id = ?').bind(productId));
    for (const f of facetIds) {
      stmts.push(
        db
          .prepare('INSERT OR IGNORE INTO product_facets (product_id, facet_id) VALUES (?, ?)')
          .bind(productId, f)
      );
    }
  }

  return {
    errors: [] as never[],
    stmts,
    mode,
    summary: {
      inventory_mode: mode,
      groups: groupInputs.length,
      values: valueInputs.length,
      colors: colorInputs.length,
      links: colorInputs.reduce((n, x) => n + x.linked.length, 0),
      variants: variantInputs.length,
      images: imageInputs.length,
      primary_image: imageInputs.find((i) => i.is_primary === 1)?.id ?? null,
      facets: facetIds === null ? 'preserved' : facetIds.length,
      cost_written: money,
    },
  };
}

adminProductRelationsRoutes.put('/:id/relations', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const plan = await planRelationsWrite(c.env.DB, productId, body, {
    money: canViewFinancials(c.env, admin),
  });
  if (!plan.stmts) {
    return c.json({ success: false, code: 'VALIDATION', errors: plan.errors }, 400);
  }

  await c.env.DB.batch(plan.stmts);
  await audit(c.env.DB, admin.id, 'product.relations.save', productId, plan.summary);

  const rel = await loadProductRelations(c.env.DB, productId);
  return c.json(projectForAdmin(c.env, admin, { success: true, ...rel, inventory_mode: plan.mode }));
});

/**
 * A manual stock correction. Goes through the SAME ledger as an order, so the
 * adjustment appears in the product's stock history with its actor and reason
 * (§7 "سجل تعديلات", §11 audit log).
 */
adminProductRelationsRoutes.post('/:id/stock/adjust', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const scope = str(body.scope, 'scope', { max: 20 });
  if (!['base', 'option', 'color', 'variant'].includes(scope)) throw badRequest('scope: unknown stock level');
  const scopeId = str(body.scope_id, 'scope_id', { max: 60, required: false }) ?? '';
  if (scope !== 'base' && !scopeId) throw badRequest('scope_id: required for this stock level');
  const delta = int(body.delta, 'delta', { min: -10_000_000, max: 10_000_000 });
  if (delta === 0) throw badRequest('delta: nothing to change');
  const reason = str(body.reason, 'reason', { max: 200 });

  const target: StockTarget = {
    scope: scope as StockTarget['scope'],
    scope_id: scopeId,
    stock: 0,
    reserved: 0,
    low_stock_threshold: null,
    label: scopeId || 'base',
  };
  const operationId = newId('adj');
  const result = await applyInventory(
    c.env.DB,
    [{ product_id: productId, qty: Math.abs(delta), line_id: operationId, targets: [target] }],
    {
      kind: delta > 0 ? 'adjust_in' : 'adjust_out',
      operationId,
      actorUserId: admin.id,
      reason,
    }
  );

  if (result.applied === 0) {
    const why = result.rejected[0]?.reason ?? 'NOT_APPLIED';
    return c.json(
      {
        success: false,
        code: why,
        error:
          why === 'INSUFFICIENT_STOCK'
            ? 'Not enough free stock — units reserved for live orders cannot be written off.'
            : why === 'NOT_TRACKED'
              ? 'This level does not track stock. Set a starting quantity first.'
              : 'That stock row no longer exists.',
      },
      400
    );
  }

  await audit(c.env.DB, admin.id, 'product.stock.adjust', productId, { scope, scope_id: scopeId, delta, reason });
  const snap = await inventorySnapshot(c.env.DB, productId);
  return c.json({ success: true, applied: result.applied, inventory_mode: snap.inventory_mode });
});
