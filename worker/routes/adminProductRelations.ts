import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, str, int, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { parseProductRow } from '../lib/productModel';
import { canViewFinancials, projectForAdmin } from '../lib/adminScope';
import { liveValues, loadProductRelations } from '../lib/productRelations';
import { fulfillmentStatements, parseFulfillmentPayload, saleTypesFromCells } from '../lib/optionFulfillment';
import {
  loadRelationsSnapshot,
  planRelationsWriteFrom,
  planProductSave,
  saveProductAtomic,
  type RelationsPlan,
} from '../lib/productPersistence';
import {
  applyInventory,
  assertMovesApplied,
  isInventoryMode,
  resolveStock,
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
 * The whole-structure write, as a function rather than a handler — kept here
 * under its old name for the CSV/ZIP importer, which combines the statements
 * with its own product write. The planner itself lives in
 * worker/lib/productPersistence.ts (`planRelationsWriteFrom`), where the form
 * save and the TXT template apply share it through `planProductSave`: one
 * writer means one set of rules about linked colours, duplicate ids, price
 * ladders, reserved stock and primary images, and no third dialect to drift.
 */
export async function planRelationsWrite(
  db: D1Database,
  productId: string,
  body: Record<string, unknown>,
  opts: { money: boolean }
): Promise<RelationsPlan> {
  const snap = await loadRelationsSnapshot(db, productId);
  return planRelationsWriteFrom(db, snap, body, opts);
}

/**
 * THE FORM'S RELATIONS SAVE — a thin wrapper over the shared contract: the
 * body is the intent's `relations`, the product row is left alone (the form
 * saved it a moment ago through POST /products-v2), and the batch, the audit
 * row and the §11 gate are the contract's.
 */
adminProductRelationsRoutes.put('/:id/relations', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const existingRow = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first<Record<string, unknown>>();
  if (!existingRow) throw notFound('Product not found');

  let plan;
  try {
    plan = await planProductSave(c.env.DB, {
      mode: 'update',
      doc: null,
      prev: parseProductRow(existingRow),
      relations: body,
      actor: { adminId: admin.id, money: canViewFinancials(c.env, admin) },
    });
  } catch (e) {
    if (e instanceof HttpError && e.code === 'RELATIONS_VALIDATION') {
      const errors = Array.isArray(e.details?.errors) ? (e.details!.errors as string[]) : [e.message];
      return c.json({ success: false, code: 'VALIDATION', errors }, 400);
    }
    throw e;
  }
  await saveProductAtomic(c.env.DB, plan);

  const rel = await loadProductRelations(c.env.DB, productId);
  return c.json(
    projectForAdmin(c.env, admin, {
      success: true,
      ...rel,
      inventory_mode: plan.relations?.mode ?? 'BASE',
      warnings: plan.warnings,
    })
  );
});

/**
 * THE MODEL'S ORDER TYPES AND ROUTES — read and written through their own door.
 *
 * Separate from `/:id/relations` on purpose. That endpoint writes MODELS; this
 * one writes what each model DOES. Two doors is what makes the owner's first
 * rule enforceable at the API rather than by convention: a structure payload
 * has no field that could invent "A1 mini — Pre-order" as an option, and this
 * payload has no field that could invent a model.
 */
adminProductRelationsRoutes.get('/:id/fulfillment', async (c) => {
  const productId = c.req.param('id');
  const product = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first();
  if (!product) throw notFound('Product not found');

  const rel = await loadProductRelations(c.env.DB, productId);
  const byFulfillment = new Map<string, unknown[]>();
  for (const t of rel.transports) {
    const arr = byFulfillment.get(t.fulfillment_id);
    if (arr) arr.push(t);
    else byFulfillment.set(t.fulfillment_id, [t]);
  }

  return c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      // The MODELS this product has, so the form can render one card each
      // without a second round trip — merged-away rows are already filtered.
      models: liveValues(rel.values).map((v) => ({
        id: v.id,
        group_id: v.group_id,
        name_en: v.name_en,
        name_ar: v.name_ar ?? '',
        sort: v.sort,
        active: v.active,
        stock: v.stock,
      })),
      fulfillments: rel.fulfillments.map((f) => ({ ...f, transports: byFulfillment.get(f.id) ?? [] })),
    })
  );
});

adminProductRelationsRoutes.put('/:id/fulfillment', async (c) => {
  const admin = c.get('user')!;
  const productId = c.req.param('id');
  const existing = await c.env.DB
    .prepare('SELECT id, sale_types, selling_type FROM products WHERE id = ?')
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!existing) throw notFound('Product not found');

  const rel = await loadProductRelations(c.env.DB, productId);
  const live = liveValues(rel.values);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const cells = parseFulfillmentPayload(body, new Set(live.map((v) => v.id)));

  // The product's sale types are DERIVED from what its models offer, never
  // asked for — the direction 0043 set, so the two cannot drift apart.
  const fallback = (() => {
    try {
      const parsed = JSON.parse(String(existing.sale_types ?? '[]'));
      return Array.isArray(parsed) && parsed.length ? parsed.map(String) : [String(existing.selling_type ?? 'direct_sale')];
    } catch {
      return [String(existing.selling_type ?? 'direct_sale')];
    }
  })();
  const saleTypes = saleTypesFromCells(rel.values, cells, fallback);

  const statements = fulfillmentStatements(c.env.DB, productId, cells);
  statements.push(
    c.env.DB
      .prepare("UPDATE products SET sale_types = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .bind(JSON.stringify(saleTypes), productId)
  );
  await c.env.DB.batch(statements);

  await audit(c.env.DB, admin.id, 'product_v2.fulfillment', productId, {
    cells: cells.length,
    transports: cells.reduce((n, cell) => n + cell.transports.length, 0),
    sale_types: saleTypes,
  });

  const after = await loadProductRelations(c.env.DB, productId);
  const byFulfillment = new Map<string, unknown[]>();
  for (const t of after.transports) {
    const arr = byFulfillment.get(t.fulfillment_id);
    if (arr) arr.push(t);
    else byFulfillment.set(t.fulfillment_id, [t]);
  }
  return c.json(
    projectForAdmin(c.env, admin, {
      success: true,
      sale_types: saleTypes,
      fulfillments: after.fulfillments.map((f) => ({ ...f, transports: byFulfillment.get(f.id) ?? [] })),
    })
  );
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
  const moves = [{ product_id: productId, qty: Math.abs(delta), line_id: operationId, targets: [target] }];
  const result = await applyInventory(
    c.env.DB,
    moves,
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

  // POST-COMMIT ASSERTION (§3.3). An order fences its movement inside its own
  // transaction; this screen has no batch to fence, so it re-reads instead —
  // D1 does not fail a zero-row UPDATE, and a guard that stopped holding
  // between the pre-check and the write would otherwise leave a ledger row
  // claiming a movement that never happened. Reported, never repaired.
  const verified = await assertMovesApplied(c.env.DB, moves);

  await audit(c.env.DB, admin.id, 'product.stock.adjust', productId, { scope, scope_id: scopeId, delta, reason });
  const snap = await inventorySnapshot(c.env.DB, productId);
  return c.json({
    success: true,
    applied: result.applied,
    inventory_mode: snap.inventory_mode,
    ...(verified.ok
      ? {}
      : {
          warning: 'The adjustment was recorded but a stock row does not read back as expected — check it before selling.',
          rows_short: verified.short,
        }),
  });
});
