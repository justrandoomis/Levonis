import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, str, int } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
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
}

const nullableInt = (v: unknown, field: string, max = 1_000_000_000): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    throw badRequest(`${field}: must be a whole number between 0 and ${max}, or empty`);
  }
  return v;
};

function readPrices(o: Record<string, unknown>, where: string): PriceInput {
  return {
    regular_price_iqd: nullableInt(o.regular_price_iqd, `${where}.regular_price_iqd`),
    prime_price_iqd: nullableInt(o.prime_price_iqd, `${where}.prime_price_iqd`),
    pro_price_iqd: nullableInt(o.pro_price_iqd, `${where}.pro_price_iqd`),
    cost_iqd: nullableInt(o.cost_iqd, `${where}.cost_iqd`),
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
        facets: number;
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
  }> = [];
  for (const g of groupInputs) {
    g.values.forEach((v, i) => {
      const where = `${g.name_en}[${i}]`;
      const prices = readPrices(v, where);
      errors.push(...validatePriceLadder(prices, where));
      valueInputs.push({
        id: typeof v.id === 'string' && v.id ? v.id : newId('ov'),
        group_id: g.id,
        name_en: str(v.name_en, `${where}.name_en`, { max: 80 }),
        sku_part: str(v.sku_part, `${where}.sku_part`, { max: 40, required: false }) ?? '',
        image: str(v.image, `${where}.image`, { max: 500, required: false }) ?? '',
        sort: int(v.sort, `${where}.sort`, { min: 0, max: 10000, def: i }),
        active: v.active === false ? 0 : 1,
        stock: nullableInt(v.stock, `${where}.stock`, 10_000_000),
        low_stock_threshold: nullableInt(v.low_stock_threshold, `${where}.low_stock_threshold`, 10_000_000),
        prices,
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
  const facetIds = (Array.isArray(body.facet_ids) ? body.facet_ids : []).filter(
    (x): x is string => typeof x === 'string'
  );

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

  if (errors.length) return { errors: [...new Set(errors)] };

  // ---- the statements, run as ONE batch by the caller ---------------------
  const stmts: D1PreparedStatement[] = [];

  stmts.push(db.prepare('UPDATE products SET inventory_mode = ? WHERE id = ?').bind(mode, productId));

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
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             group_id = excluded.group_id, name_en = excluded.name_en, sku_part = excluded.sku_part,
             image = excluded.image, sort = excluded.sort, active = excluded.active,
             stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
             regular_price_iqd = excluded.regular_price_iqd, prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd${money ? ', cost_iqd = excluded.cost_iqd' : ''}`
        )
        .bind(
          v.id, productId, v.group_id, v.name_en, v.sku_part, v.image, v.sort, v.active,
          v.stock, v.low_stock_threshold,
          v.prices.regular_price_iqd, v.prices.prime_price_iqd, v.prices.pro_price_iqd,
          money ? v.prices.cost_iqd : null
        )
    );
  }

  for (const col of colorInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_colors
             (id, product_id, name_en, hex, image, sku_part, sort, active, stock, low_stock_threshold,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name_en = excluded.name_en, hex = excluded.hex, image = excluded.image,
             sku_part = excluded.sku_part, sort = excluded.sort, active = excluded.active,
             stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
             regular_price_iqd = excluded.regular_price_iqd, prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd${money ? ', cost_iqd = excluded.cost_iqd' : ''}`
        )
        .bind(
          col.id, productId, col.name_en, col.hex, col.image, col.sku_part, col.sort, col.active,
          col.stock, col.low_stock_threshold,
          col.prices.regular_price_iqd, col.prices.prime_price_iqd, col.prices.pro_price_iqd,
          money ? col.prices.cost_iqd : null
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
              width, height, bytes, content_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             url = excluded.url, alt_en = excluded.alt_en, sort_order = excluded.sort_order,
             is_primary = excluded.is_primary, option_value_id = excluded.option_value_id,
             color_id = excluded.color_id, variant_id = excluded.variant_id,
             width = excluded.width, height = excluded.height, bytes = excluded.bytes,
             content_type = excluded.content_type`
        )
        .bind(
          img.id, productId, img.url, img.alt_en, img.sort_order, img.is_primary,
          img.option_value_id, img.color_id, img.variant_id,
          img.width, img.height, img.bytes, img.content_type
        )
    );
  }

  stmts.push(db.prepare('DELETE FROM product_facets WHERE product_id = ?').bind(productId));
  for (const f of facetIds) {
    stmts.push(
      db
        .prepare('INSERT OR IGNORE INTO product_facets (product_id, facet_id) VALUES (?, ?)')
        .bind(productId, f)
    );
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
      facets: facetIds.length,
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
