/**
 * THE MERCHANT'S CATALOGUE — /api/merchant/products* and
 * /api/merchant/collections* (with the old /sections* spelling kept).
 *
 * Mounted inside `merchantRoutes` (worker/routes/merchant.ts), so the URLs are
 * the ones the dashboard has always called and every request has passed
 * `requireAuth`. Moved here from merchant.ts by stream W2-F of the merchant
 * platform (docs/MERCHANT_PLATFORM.md §2 decision 8), onto the 0126 model:
 *
 *   · the lifecycle is `state` (draft | published | hidden | archived, a CHECK
 *     in the database); sold out is derived from stock; Levonis's hide is its
 *     own column that no route here can clear (409 PRODUCT_HIDDEN_BY_ADMIN);
 *   · variants are rows (option groups, values, one variant per combination
 *     sold) with their own price, stock and SKU, validated by the one gate in
 *     packages/catalog and written in one batch with the product;
 *   · media are ordered pictures and videos — this owner's uploads only;
 *   · collections are the store's «sections»: manual (membership and order
 *     chosen here) or computed (featured, new arrivals, best sellers).
 *
 * THE STORE COMES FROM THE SESSION (`requireStoreOwner` /
 * `requireSellingPrivileges`) and every statement carries it in its WHERE
 * clause; no id in a path or a body can reach another store's row. Reading
 * and organising stay open to a merchant who may not sell (§48); publishing,
 * pricing, stocking and creating need selling privileges.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, badRequest, notFound, conflict, str, int, pickFrom } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { requireAuth } from '../lib/http';
import { audit } from '../lib/audit';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { requireStoreOwner, requireSellingPrivileges, type StoreContext } from '../lib/merchantAuth';
import { suggestSlug } from '../lib/merchantOps';
import { parseCsv, toCsv } from '../lib/importCsv';
import { isSchemaMissing } from '../lib/membershipBenefits';
import { getSetting } from '../lib/settings';
import { ownedMediaKey } from '../lib/mediaRefs';
import { isPublishState, type PublishState } from '@levonis/catalog/lifecycle';
import type { VariantModel } from '@levonis/catalog/variants';
import {
  LIST_EXTRA_COLUMNS,
  attributeColumns,
  attributesOf,
  membershipStatements,
  mediaStatements,
  productInvalid,
  productShape,
  publishableModel,
  readExistingModel,
  readProductDetail,
  readProductInput,
  stateOf,
  variantModelStatements,
  verifyProductRefs,
  type ProductInput,
} from '../lib/catalog/product';
import { catalogCsvRows, parseCatalogCsv, type CatalogExportProduct } from '../lib/catalog/csv';
import { COLLECTION_KINDS, collectionMemberSql, collectionOrder, sinceNewArrivals, variantLabelSql, type CollectionKind } from '../lib/catalog/sql';
import { alertLowStock, type StockMove } from '../lib/catalog/lowStock';

/** Work that must not hold the response: `waitUntil` where there is one, else awaited (tests). */
async function runAfter(c: Context<AppContext>, work: Promise<unknown>): Promise<void> {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    await work;
  }
}

export const merchantCatalogRoutes = new Hono<AppContext>();
// Every route is the signed-in owner's own store (requireStoreOwner below).
merchantCatalogRoutes.use('*', requireAuth);

const nowIso = () => new Date().toISOString();

/** 409 PRODUCT_HIDDEN_BY_ADMIN, carrying the reason the merchant is shown (wave 1, 0118). */
function hiddenByAdmin(reason: string): HttpError {
  return new HttpError(
    409,
    'Levonis has hidden this product. Fix what the reason names and contact support to have it reviewed.',
    'PRODUCT_HIDDEN_BY_ADMIN',
    { reason }
  );
}

const notPublishable = () =>
  new HttpError(409, 'A product with variants needs at least one active variant to be published.', 'PRODUCT_NOT_PUBLISHABLE');

// ================================================================== lists

/**
 * The keyset cursor of a sorted list: the sort value of the last row and its
 * id. `s1.<base64url JSON [value, id]>`; a bare `<created_at>|<id>` (the
 * pre-0126 cursor of the newest-first list) still reads.
 */
function encodeCursor(value: unknown, id: string): string {
  return `s1.${btoa(unescape(encodeURIComponent(JSON.stringify([value, id])))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
function decodeCursor(raw: string | undefined): { value: unknown; id: string } | null {
  const v = (raw ?? '').slice(0, 400);
  if (!v) return null;
  if (v.startsWith('s1.')) {
    try {
      const b = v.slice(3).replace(/-/g, '+').replace(/_/g, '/');
      const parsed = JSON.parse(decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4)))));
      if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string' && ['string', 'number'].includes(typeof parsed[0])) {
        return { value: parsed[0], id: parsed[1] };
      }
    } catch {
      /* not ours */
    }
    throw badRequest('That list position is not valid any more — reload the list', 'CURSOR_INVALID');
  }
  const bar = v.lastIndexOf('|');
  return bar === -1 ? { value: v, id: '' } : { value: v.slice(0, bar), id: v.slice(bar + 1) };
}

const SORTS: Record<string, { expr: string; dir: 'ASC' | 'DESC' }> = {
  newest: { expr: 'p.created_at', dir: 'DESC' },
  oldest: { expr: 'p.created_at', dir: 'ASC' },
  updated: { expr: "COALESCE(NULLIF(p.updated_at, ''), p.created_at)", dir: 'DESC' },
  price_asc: { expr: 'p.price_iqd', dir: 'ASC' },
  price_desc: { expr: 'p.price_iqd', dir: 'DESC' },
  sales: { expr: 'p.sold_count', dir: 'DESC' },
  views: { expr: 'p.view_count', dir: 'DESC' },
  stock: { expr: 'p.stock', dir: 'ASC' },
  name: { expr: 'p.name', dir: 'ASC' },
};

/** The WHERE clause of the management list, from a whitelist of filters; every value bound. */
function listFilters(c: Context<AppContext>, ctx: StoreContext): { where: string[]; binds: unknown[] } {
  const q = str(c.req.query('q') ?? '', 'q', { min: 0, max: 120, required: false });
  const collection = str(c.req.query('collection') ?? c.req.query('section') ?? '', 'collection', { min: 0, max: 64, required: false });
  const stateRaw = c.req.query('state') ?? c.req.query('lifecycle') ?? '';
  const stock = c.req.query('stock') ?? '';
  const category = str(c.req.query('category') ?? '', 'category', { min: 0, max: 60, required: false });
  const where: string[] = ['p.merchant_id = ?'];
  const binds: unknown[] = [ctx.merchant.id];
  if (q) {
    const like = likePattern(q);
    where.push(`(${sqlLikeClause(['p.name', 'p.name_ar', 'p.sku'])}
                 OR EXISTS (SELECT 1 FROM community_product_variants v WHERE v.product_id = p.id AND ${sqlLikeClause(['v.sku'])}))`);
    binds.push(like, like, like, like);
  }
  if (collection === 'none') where.push('NOT EXISTS (SELECT 1 FROM merchant_collection_products m WHERE m.product_id = p.id)');
  else if (collection) {
    where.push('EXISTS (SELECT 1 FROM merchant_collection_products m WHERE m.product_id = p.id AND m.collection_id = ?)');
    binds.push(collection);
  }
  const state = stateRaw === 'active' ? 'published' : stateRaw;
  if (isPublishState(state)) {
    where.push('p.publish_state = ?');
    binds.push(state);
  } else if (state === 'sold_out') {
    where.push("p.publish_state = 'published' AND p.track_stock = 1 AND p.stock <= 0");
  } else if (state === 'hidden_by_admin') {
    where.push('p.admin_hidden_at IS NOT NULL');
  }
  if (stock === 'in') where.push('(p.track_stock = 0 OR p.stock > 0)');
  else if (stock === 'low') {
    where.push(`p.track_stock = 1 AND (
      (p.stock > 0 AND p.stock <= COALESCE(p.low_stock_threshold, 5))
      OR EXISTS (SELECT 1 FROM community_product_variants v WHERE v.product_id = p.id AND v.active = 1 AND v.stock > 0
                  AND v.stock <= COALESCE(v.low_stock_threshold, p.low_stock_threshold, 5)))`);
  } else if (stock === 'out') where.push('(p.track_stock = 1 AND p.stock <= 0)');
  else if (stock === 'untracked') where.push('p.track_stock = 0');
  if (category) {
    where.push('p.category = ?');
    binds.push(category);
  }
  if (c.req.query('price_min') !== undefined) {
    where.push('p.price_iqd >= ?');
    binds.push(int(c.req.query('price_min'), 'price_min', { min: 0, max: 1_000_000_000 }));
  }
  if (c.req.query('price_max') !== undefined) {
    where.push('p.price_iqd <= ?');
    binds.push(int(c.req.query('price_max'), 'price_max', { min: 0, max: 1_000_000_000 }));
  }
  if (c.req.query('days') !== undefined) {
    where.push('p.created_at >= ?');
    binds.push(new Date(Date.now() - int(c.req.query('days'), 'days', { min: 1, max: 3650 }) * 86_400_000).toISOString());
  }
  if (c.req.query('featured') === '1') where.push('p.featured = 1');
  if (c.req.query('deals') === '1') where.push('(p.original_price_iqd IS NOT NULL AND p.original_price_iqd > p.price_iqd)');
  if (c.req.query('variants') === 'with') where.push("p.variant_mode = 'variants'");
  else if (c.req.query('variants') === 'without') where.push("p.variant_mode <> 'variants'");
  return { where, binds };
}

/**
 * The management list: search, filters, sort — and paging by CURSOR
 * (`next_cursor`), with the exact `total` for «X من Z». `?page=` keeps the
 * older offset paging working for a client that still sends it.
 */
merchantCatalogRoutes.get('/products', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });
  const sortKey = c.req.query('sort') ?? 'newest';
  const sort = pickFrom(SORTS, sortKey, SORTS.newest);
  const { where, binds } = listFilters(c, ctx);
  const whereSql = where.join(' AND ');
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM community_products p WHERE ${whereSql}`).bind(...binds);

  if (c.req.query('page') !== undefined) {
    const page = int(c.req.query('page'), 'page', { min: 1, max: 10_000, def: 1 });
    const [{ results }, count] = await Promise.all([
      db
        .prepare(
          `SELECT p.*, ${LIST_EXTRA_COLUMNS} FROM community_products p WHERE ${whereSql}
            ORDER BY ${sort.expr} ${sort.dir}, p.id ${sort.dir} LIMIT ? OFFSET ?`
        )
        .bind(...binds, limit, (page - 1) * limit)
        .all<Record<string, unknown>>(),
      countStmt.first<{ n: number }>(),
    ]);
    return c.json({ success: true, products: results.map(productShape), total: count?.n ?? 0, page, limit });
  }

  const cursor = decodeCursor(c.req.query('cursor'));
  const cmp = sort.dir === 'DESC' ? '<' : '>';
  const keyset = cursor ? ` AND (${sort.expr} ${cmp} ? OR (${sort.expr} = ? AND p.id ${cmp} ?))` : '';
  const keyBinds = cursor ? [cursor.value, cursor.value, cursor.id] : [];
  const [{ results }, count] = await Promise.all([
    db
      .prepare(
        `SELECT p.*, ${LIST_EXTRA_COLUMNS}, ${sort.expr} AS sort_value FROM community_products p
          WHERE ${whereSql}${keyset}
          ORDER BY ${sort.expr} ${sort.dir}, p.id ${sort.dir} LIMIT ?`
      )
      .bind(...binds, ...keyBinds, limit)
      .all<Record<string, unknown>>(),
    countStmt.first<{ n: number }>(),
  ]);
  const last = results[results.length - 1];
  return c.json({
    success: true,
    products: results.map(productShape),
    total: count?.n ?? 0,
    next_cursor: results.length === limit && last ? encodeCursor(last.sort_value, String(last.id)) : null,
  });
});

/** The manager's stat cards, from real rows only. */
merchantCatalogRoutes.get('/products/stats', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const since = new Date(Date.now() - 12 * 7 * 86_400_000).toISOString();
  const [totals, weekly, categories, salesDaily] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN publish_state = 'published' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN publish_state = 'draft' THEN 1 ELSE 0 END) AS draft,
              SUM(CASE WHEN publish_state IN ('hidden','archived') THEN 1 ELSE 0 END) AS hidden,
              SUM(CASE WHEN publish_state = 'archived' THEN 1 ELSE 0 END) AS archived,
              SUM(CASE WHEN track_stock = 1 AND stock <= 0 AND publish_state = 'published' THEN 1 ELSE 0 END) AS out_of_stock,
              SUM(CASE WHEN track_stock = 1 AND stock > 0 AND stock <= COALESCE(low_stock_threshold, -1) THEN 1 ELSE 0 END) AS low_stock,
              COALESCE(SUM(view_count), 0) AS views,
              COALESCE(SUM(sold_count), 0) AS sold
         FROM community_products WHERE merchant_id = ?`
    ).bind(ctx.merchant.id).first<Record<string, number>>(),
    db.prepare(
      `SELECT strftime('%Y-%W', created_at) AS week, COUNT(*) AS added,
              SUM(CASE WHEN publish_state = 'published' THEN 1 ELSE 0 END) AS active_added,
              SUM(CASE WHEN publish_state = 'draft' THEN 1 ELSE 0 END) AS draft_added,
              SUM(CASE WHEN publish_state IN ('hidden','archived') THEN 1 ELSE 0 END) AS hidden_added,
              COALESCE(SUM(view_count), 0) AS views
         FROM community_products WHERE merchant_id = ? AND created_at >= ?
        GROUP BY week ORDER BY week`
    ).bind(ctx.merchant.id, since).all(),
    db.prepare(
      `SELECT DISTINCT category FROM community_products WHERE merchant_id = ? AND category != '' ORDER BY category LIMIT 40`
    ).bind(ctx.merchant.id).all(),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS orders, COALESCE(SUM(total_iqd), 0) AS gross
         FROM orders WHERE merchant_id = ? AND status != 'cancelled' AND created_at >= ?
        GROUP BY day ORDER BY day`
    ).bind(ctx.merchant.id, new Date(Date.now() - 14 * 86_400_000).toISOString()).all(),
  ]);
  return c.json({
    success: true,
    totals: {
      total: totals?.total ?? 0,
      active: totals?.active ?? 0,
      published: totals?.active ?? 0,
      draft: totals?.draft ?? 0,
      hidden: totals?.hidden ?? 0,
      archived: totals?.archived ?? 0,
      out_of_stock: totals?.out_of_stock ?? 0,
      low_stock: totals?.low_stock ?? 0,
      views: totals?.views ?? 0,
      sold: totals?.sold ?? 0,
    },
    weekly: (weekly.results ?? []).map((w) => ({
      week: w.week,
      added: Number(w.added ?? 0),
      active_added: Number(w.active_added ?? 0),
      draft_added: Number(w.draft_added ?? 0),
      hidden_added: Number(w.hidden_added ?? 0),
      views: Number(w.views ?? 0),
    })),
    categories: (categories.results ?? []).map((r) => String(r.category)),
    sales_daily: (salesDaily.results ?? []).map((r) => ({ day: r.day, orders: Number(r.orders ?? 0), gross: Number(r.gross ?? 0) })),
  });
});

// ============================================================ export / import

/** Every product of the store, with its variants and collections, for the CSV. */
async function exportProducts(db: D1Database, ctx: StoreContext): Promise<{ products: CatalogExportProduct[]; total: number }> {
  const [rows, groups, values, variants, members, count] = await Promise.all([
    db.prepare('SELECT * FROM community_products WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT 2000').bind(ctx.merchant.id).all(),
    db.prepare(
      `SELECT o.id, o.product_id, o.name FROM community_product_options o WHERE o.store_id = ? ORDER BY o.product_id, o.position`
    ).bind(ctx.store.id).all(),
    db.prepare(
      `SELECT x.id, x.option_id, x.name FROM community_product_option_values x
         JOIN community_product_options o ON o.id = x.option_id WHERE o.store_id = ? ORDER BY x.position`
    ).bind(ctx.store.id).all(),
    db.prepare('SELECT * FROM community_product_variants WHERE store_id = ? ORDER BY product_id, position').bind(ctx.store.id).all(),
    db.prepare(
      `SELECT m.product_id, s.name FROM merchant_collection_products m
         JOIN merchant_store_sections s ON s.id = m.collection_id WHERE m.store_id = ? ORDER BY s.sort_order, s.created_at`
    ).bind(ctx.store.id).all(),
    db.prepare('SELECT COUNT(*) AS n FROM community_products WHERE merchant_id = ?').bind(ctx.merchant.id).all(),
  ]);
  const byProduct = <T extends Record<string, unknown>>(list: T[], key = 'product_id') => {
    const m = new Map<string, T[]>();
    for (const r of list) {
      const k = String(r[key]);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const groupsBy = byProduct(groups.results as Array<Record<string, unknown>>);
  const valuesBy = byProduct(values.results as Array<Record<string, unknown>>, 'option_id');
  const variantsBy = byProduct(variants.results as Array<Record<string, unknown>>);
  const membersBy = byProduct(members.results as Array<Record<string, unknown>>);
  const products = (rows.results as Array<Record<string, unknown>>).map((p): CatalogExportProduct => {
    const mode = String(p.variant_mode);
    const gs = mode === 'variants' ? groupsBy.get(String(p.id)) ?? [] : [];
    return {
      slug: String(p.slug),
      name: String(p.name ?? ''),
      name_ar: String(p.name_ar ?? ''),
      description: String(p.description ?? ''),
      description_ar: String(p.description_ar ?? ''),
      state: stateOf(p),
      price_iqd: Number(p.price_iqd ?? 0),
      original_price_iqd: p.original_price_iqd === null ? null : Number(p.original_price_iqd),
      sku: String(p.sku ?? ''),
      stock: Number(p.stock ?? 0),
      track_stock: !!Number(p.track_stock),
      low_stock_threshold: p.low_stock_threshold === null ? null : Number(p.low_stock_threshold),
      category: String(p.category ?? ''),
      condition: String(p.condition ?? 'new'),
      prep_days: Number(p.prep_days ?? 0),
      featured: !!Number(p.featured),
      collections: (membersBy.get(String(p.id)) ?? []).map((m) => String(m.name)),
      attributes: attributesOf(p),
      groups: gs.map((g) => ({
        name: String(g.name),
        values: (valuesBy.get(String(g.id)) ?? []).map((v) => ({ id: String(v.id), name: String(v.name) })),
      })),
      variants: gs.length
        ? (variantsBy.get(String(p.id)) ?? []).map((v) => ({
            value_ids: [v.value1_id, v.value2_id, v.value3_id].filter((x): x is string => typeof x === 'string'),
            price_iqd: v.price_iqd === null ? null : Number(v.price_iqd),
            compare_at_iqd: v.compare_at_iqd === null ? null : Number(v.compare_at_iqd),
            sku: String(v.sku ?? ''),
            stock: Number(v.stock ?? 0),
            active: !!Number(v.active),
          }))
        : [],
    };
  });
  return { products, total: Number((count.results as Array<{ n: number }>)[0]?.n ?? 0) };
}

/** The whole catalogue as a spreadsheet, one row per variant — BOM for Excel-friendly Arabic. */
merchantCatalogRoutes.get('/products/export.csv', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { products, total } = await exportProducts(c.env.DB, ctx);
  const truncated = total > products.length;
  return new Response('\uFEFF' + toCsv(catalogCsvRows(products)), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="products.csv"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(truncated ? { 'X-Levonis-Truncated': String(total) } : {}),
    },
  });
});

/** The statements that create one product (draft) with its variants, attributes and memberships. */
function createStatements(
  db: D1Database,
  ctx: StoreContext,
  id: string,
  ts: string,
  fields: Record<string, unknown>,
  state: PublishState,
  extras: { attributes?: ProductInput['attributes']; model?: VariantModel; collectionIds?: string[]; media?: ProductInput['media'] }
): D1PreparedStatement[] {
  const base = suggestSlug(String(fields.name)) || 'item';
  // The slug column is globally UNIQUE, so it is namespaced by store.
  const slug = `${ctx.store.slug}-${base}-${id.slice(-6)}`.slice(0, 120);
  const attrs = extras.attributes ? attributeColumns(extras.attributes) : {};
  const cols: Record<string, unknown> = {
    id,
    merchant_id: ctx.merchant.id,
    store_id: ctx.store.id,
    slug,
    name: fields.name,
    name_ar: fields.name_ar ?? '',
    description: fields.description ?? '',
    description_ar: fields.description_ar ?? '',
    images: '[]',
    price_iqd: fields.price_iqd,
    original_price_iqd: fields.original_price_iqd ?? null,
    sku: fields.sku ?? '',
    stock: fields.stock ?? 0,
    track_stock: fields.track_stock ?? 1,
    category: fields.category ?? '',
    condition: fields.condition ?? 'new',
    delivery_methods: fields.delivery_methods ?? '[]',
    prep_days: fields.prep_days ?? 0,
    featured: fields.featured ?? 0,
    low_stock_threshold: fields.low_stock_threshold ?? null,
    publish_state: state,
    created_at: ts,
    updated_at: ts,
    ...attrs,
  };
  const names = Object.keys(cols);
  const stmts = [
    db
      .prepare(`INSERT INTO community_products (${names.join(', ')}) VALUES (${names.map((_, i) => `?${i + 1}`).join(', ')})`)
      .bind(...names.map((n) => cols[n])),
  ];
  if (extras.media?.length) stmts.push(...mediaStatements(db, id, ctx.store.id, extras.media));
  if (extras.model?.groups.length) {
    stmts.push(
      ...variantModelStatements(db, id, ctx.store.id, extras.model, { groupIds: new Set(), valueIds: new Set(), variantByCombo: new Map() }).statements
    );
  }
  if (extras.collectionIds?.length) stmts.push(...membershipStatements(db, id, ctx.store.id, extras.collectionIds));
  return stmts;
}

/**
 * Spreadsheet import, previewed before it commits (`confirm: false` writes
 * NOTHING and answers the per-row report); imported products are always
 * DRAFTS. Rows of one handle become one product with its variants.
 */
merchantCatalogRoutes.post('/products/import', async (c) => {
  await rateLimit(c, 'merchant-product-import', 10, 3600);
  const ctx = await requireSellingPrivileges(c);
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const csvText = str(body.csv, 'csv', { min: 1, max: 400_000 });
  const confirm = body.confirm === true;
  const grid = parseCsv(csvText.replace(/^\uFEFF/, ''));
  if (grid.length < 2) throw badRequest('The file has no data rows', 'CSV_EMPTY');
  const parsed = parseCatalogCsv(grid);
  if (parsed.errors.some((e) => e.code === 'CSV_HEADER')) throw badRequest('The file must carry name and price_iqd columns', 'CSV_HEADER');
  if (parsed.errors.some((e) => e.code === 'CSV_TOO_BIG')) throw badRequest('Up to 200 products (1000 rows) per import', 'CSV_TOO_BIG');

  // Collections are named; each name must be one of this store's manual collections.
  const { results: collections } = await db
    .prepare(`SELECT id, name, name_ar FROM merchant_store_sections WHERE store_id = ? AND kind = 'manual'`)
    .bind(ctx.store.id)
    .all<{ id: string; name: string; name_ar: string }>();
  const byName = new Map<string, string>();
  for (const s of collections) {
    byName.set(s.name.trim().toLowerCase(), s.id);
    if (s.name_ar) byName.set(s.name_ar.trim().toLowerCase(), s.id);
  }
  const errors = [...parsed.errors];
  const materialIds = new Set(((await getSetting(db, 'printMaterials')) as Array<{ id: string }>).map((m) => m.id));
  const ready = parsed.products.filter((p) => {
    let ok = true;
    for (const name of p.collectionNames) {
      if (!byName.has(name.toLowerCase())) {
        errors.push({ row: p.row, field: 'collections', code: 'CSV_COLLECTION_UNKNOWN' });
        ok = false;
      }
    }
    if (p.attributes.material && !materialIds.has(p.attributes.material)) {
      errors.push({ row: p.row, field: 'material', code: 'CSV_ATTRIBUTE_INVALID' });
      ok = false;
    }
    return ok;
  });
  errors.sort((a, b) => a.row - b.row);

  let created = 0;
  if (confirm && ready.length) {
    // ONE INSTANT PER PRODUCT, in file order (audit 01 B5), in batches of 25
    // products — each batch all-or-nothing.
    const base = Date.now();
    for (let i = 0; i < ready.length; i += 25) {
      const stmts: D1PreparedStatement[] = [];
      ready.slice(i, i + 25).forEach((p, j) => {
        const ts = new Date(base - (i + j)).toISOString();
        stmts.push(
          ...createStatements(db, ctx, newId('cp'), ts, { ...p.fields }, 'draft', {
            attributes: p.attributes,
            model: p.model,
            collectionIds: p.collectionNames.map((n) => byName.get(n.toLowerCase())!).filter(Boolean),
          })
        );
      });
      await db.batch(stmts);
      created += Math.min(25, ready.length - i);
    }
    await audit(db, ctx.store.user_id, 'merchant.products_imported', ctx.store.id, { created });
  }

  return c.json({
    success: true,
    confirmed: confirm,
    created,
    rows: parsed.rows,
    valid: ready.length,
    invalid: new Set(errors.map((e) => e.row)).size,
    errors,
    products: ready.map((p) => ({
      row: p.row,
      handle: p.handle,
      name: p.fields.name,
      variants: p.model.variants.length,
      price_iqd: p.fields.price_iqd,
    })),
    // The pre-0126 report shape, per row, for an older client.
    report: [
      ...ready.map((p) => ({ row: p.row, name: p.fields.name, ok: true })),
      ...errors.map((e) => ({ row: e.row, name: '—', ok: false, error: `${e.field}: ${e.code}` })),
    ].sort((a, b) => a.row - b.row),
  });
});

// =================================================================== bulk

const BULK_ACTIONS = [
  'publish', 'hide', 'archive', 'draft', 'delete', 'set_price', 'set_stock', 'feature', 'unfeature',
  'add_to_collection', 'remove_from_collection',
] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];
/** What a merchant who may not sell can still do: take things off the shelf and organise. */
const OWNER_ONLY_ACTIONS: ReadonlySet<BulkAction> = new Set(['hide', 'archive', 'draft', 'delete', 'remove_from_collection', 'unfeature']);

/**
 * One action on up to 100 products, answered PER PRODUCT (`results[]` with a
 * stable code for each one that did not change). Ownership is in every
 * statement (`merchant_id = ?` beside `id IN json_each(?)`), so an id of
 * another store's product is simply `NOT_FOUND`.
 */
merchantCatalogRoutes.post('/products/bulk', async (c) => {
  await rateLimit(c, 'merchant-product-bulk', 60, 3600);
  const body = await c.req.json().catch(() => ({}));
  const action = (BULK_ACTIONS as readonly string[]).includes(String(body.action)) ? (body.action as BulkAction) : null;
  if (!action) throw badRequest('Unknown bulk action', 'BULK_ACTION_INVALID');
  const ctx = OWNER_ONLY_ACTIONS.has(action) ? await requireStoreOwner(c) : await requireSellingPrivileges(c);
  const rawIds = Array.isArray(body.ids) ? body.ids : [];
  const ids: string[] = [...new Set<string>(rawIds.filter((x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)))];
  if (!ids.length || ids.length !== rawIds.length || ids.length > 100) throw badRequest('Choose between 1 and 100 products', 'BULK_IDS_INVALID');
  const db = c.env.DB;
  const idsJson = JSON.stringify(ids);
  const ts = nowIso();

  // Read the rows first: what each one IS decides what each one gets told.
  const { results: rows } = await db
    .prepare(
      `SELECT p.id, p.name, p.stock, p.low_stock_threshold, p.publish_state, p.variant_mode, p.admin_hidden_at, p.admin_hidden_reason, p.store_id,
              (SELECT COUNT(*) FROM community_product_variants v WHERE v.product_id = p.id AND v.active = 1) AS active_variants,
              (SELECT COUNT(*) FROM order_items i WHERE i.community_product_id = p.id) AS ordered
         FROM community_products p WHERE p.merchant_id = ?1 AND p.id IN (SELECT value FROM json_each(?2))`
    )
    .bind(ctx.merchant.id, idsJson)
    .all<Record<string, unknown>>();
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const results: Array<{ id: string; ok: boolean; code?: string }> = [];
  const eligible: string[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) {
      results.push({ id, ok: false, code: 'NOT_FOUND' });
      continue;
    }
    if (action === 'publish') {
      if (r.admin_hidden_at) { results.push({ id, ok: false, code: 'PRODUCT_HIDDEN_BY_ADMIN' }); continue; }
      if (r.variant_mode === 'variants' && Number(r.active_variants) === 0) { results.push({ id, ok: false, code: 'PRODUCT_NOT_PUBLISHABLE' }); continue; }
    }
    if (action === 'set_stock' && r.variant_mode === 'variants') { results.push({ id, ok: false, code: 'VARIANTS_HAVE_OWN_STOCK' }); continue; }
    if (action === 'delete' && Number(r.ordered) > 0) { results.push({ id, ok: false, code: 'PRODUCT_HAS_ORDERS' }); continue; }
    eligible.push(id);
  }

  if (eligible.length) {
    const ej = JSON.stringify(eligible);
    const own = `merchant_id = ?2 AND id IN (SELECT value FROM json_each(?1))`;
    let stmts: D1PreparedStatement[] = [];
    const setState = (state: PublishState, extra = '') =>
      db.prepare(`UPDATE community_products SET publish_state = ?3, updated_at = ?4 WHERE ${own}${extra}`).bind(ej, ctx.merchant.id, state, ts);
    switch (action) {
      case 'publish':
        // The admin hide and the active-variant rule are repeated IN the
        // statement: a hide that lands between the read and this write wins.
        stmts = [
          setState(
            'published',
            ` AND admin_hidden_at IS NULL AND (variant_mode <> 'variants'
               OR EXISTS (SELECT 1 FROM community_product_variants v WHERE v.product_id = community_products.id AND v.active = 1))`
          ),
        ];
        break;
      case 'hide':
        stmts = [setState('hidden')];
        break;
      case 'archive':
        stmts = [setState('archived')];
        break;
      case 'draft':
        stmts = [setState('draft')];
        break;
      case 'feature':
      case 'unfeature':
        stmts = [db.prepare(`UPDATE community_products SET featured = ?3, updated_at = ?4 WHERE ${own}`).bind(ej, ctx.merchant.id, action === 'feature' ? 1 : 0, ts)];
        break;
      case 'set_price': {
        const price = int(body.price_iqd, 'price_iqd', { min: 0, max: 1_000_000_000 });
        stmts = [db.prepare(`UPDATE community_products SET price_iqd = ?3, updated_at = ?4 WHERE ${own}`).bind(ej, ctx.merchant.id, price, ts)];
        break;
      }
      case 'set_stock': {
        const stock = int(body.stock, 'stock', { min: 0, max: 1_000_000 });
        stmts = [
          db
            .prepare(
              `UPDATE community_products SET stock = ?3, updated_at = ?4,
                      low_stock_alerted_at = CASE WHEN ?3 > COALESCE(low_stock_threshold, -1) THEN NULL ELSE low_stock_alerted_at END
                WHERE ${own} AND variant_mode <> 'variants'`
            )
            .bind(ej, ctx.merchant.id, stock, ts),
        ];
        break;
      }
      case 'delete':
        // Never a product any order names: the statement re-checks it.
        stmts = [
          db
            .prepare(
              `DELETE FROM community_products WHERE ${own}
                 AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.community_product_id = community_products.id)`
            )
            .bind(ej, ctx.merchant.id),
        ];
        break;
      case 'add_to_collection':
      case 'remove_from_collection': {
        const cid = str(body.collection_id, 'collection_id', { min: 1, max: 64 });
        const col = await db
          .prepare(`SELECT id, kind FROM merchant_store_sections WHERE id = ? AND store_id = ?`)
          .bind(cid, ctx.store.id)
          .first<{ id: string; kind: string }>();
        if (!col) throw notFound('Collection not found');
        if (col.kind !== 'manual') throw conflict('A computed collection chooses its own products', 'COLLECTION_COMPUTED');
        stmts =
          action === 'add_to_collection'
            ? eligible.map((pid, i) =>
                db
                  .prepare(
                    `INSERT OR IGNORE INTO merchant_collection_products (collection_id, product_id, store_id, position)
                     SELECT ?1, p.id, p.store_id,
                            COALESCE((SELECT MIN(position) FROM merchant_collection_products WHERE collection_id = ?1), 1) - 1 - ?4
                       FROM community_products p WHERE p.id = ?2 AND p.merchant_id = ?3 AND p.store_id = ?5`
                  )
                  .bind(cid, pid, ctx.merchant.id, i, ctx.store.id)
              )
            : [
                db
                  .prepare(
                    `DELETE FROM merchant_collection_products
                      WHERE collection_id = ?3 AND store_id = ?4 AND product_id IN (SELECT value FROM json_each(?1))
                        AND EXISTS (SELECT 1 FROM community_products p WHERE p.id = product_id AND p.merchant_id = ?2)`
                  )
                  .bind(ej, ctx.merchant.id, cid, ctx.store.id),
              ];
        break;
      }
    }
    await db.batch(stmts);
    // What actually changed, read back — a row the statement's own fence
    // skipped is reported as such, never as done.
    if (action === 'publish') {
      const { results: now } = await db
        .prepare(`SELECT id, publish_state FROM community_products WHERE merchant_id = ?1 AND id IN (SELECT value FROM json_each(?2))`)
        .bind(ctx.merchant.id, ej)
        .all<{ id: string; publish_state: string }>();
      const published = new Set(now.filter((r) => r.publish_state === 'published').map((r) => r.id));
      for (const id of eligible) results.push(published.has(id) ? { id, ok: true } : { id, ok: false, code: 'PRODUCT_HIDDEN_BY_ADMIN' });
    } else if (action === 'delete') {
      const { results: left } = await db
        .prepare(`SELECT id FROM community_products WHERE merchant_id = ?1 AND id IN (SELECT value FROM json_each(?2))`)
        .bind(ctx.merchant.id, ej)
        .all<{ id: string }>();
      const remaining = new Set(left.map((r) => r.id));
      for (const id of eligible) results.push(remaining.has(id) ? { id, ok: false, code: 'PRODUCT_HAS_ORDERS' } : { id, ok: true });
    } else {
      for (const id of eligible) results.push({ id, ok: true });
    }
    // A stock set to (or under) the merchant's own line is told once per product.
    if (action === 'set_stock') {
      const after = Number(body.stock);
      const moves: StockMove[] = eligible.map((id) => {
        const r = byId.get(id)!;
        return {
          productId: id,
          productName: String(r.name ?? ''),
          before: Number(r.stock ?? 0),
          after,
          threshold: r.low_stock_threshold === null || r.low_stock_threshold === undefined ? null : Number(r.low_stock_threshold),
        };
      });
      await runAfter(c, alertLowStock(c.env, ctx.merchant.id, moves, `bulk:${ts}`));
    }
  }
  await audit(db, ctx.store.user_id, 'merchant.products_bulk', ctx.store.id, {
    action,
    ids: ids.length,
    done: results.filter((r) => r.ok).length,
  });
  const order = new Map(ids.map((id, i) => [id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return c.json({ success: true, action, done: results.filter((r) => r.ok).length, results });
});

// ================================================================= one product

merchantCatalogRoutes.get('/products/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const product = await readProductDetail(c.env.DB, ctx.merchant.id, c.req.param('id'));
  if (!product) throw notFound('Product not found');
  return c.json({ success: true, product });
});

/** Create — `state` defaults to published (the API's behaviour before 0126); the editor always sends one. */
merchantCatalogRoutes.post('/products', async (c) => {
  await rateLimit(c, 'merchant-product-create', 60, 3600);
  const ctx = await requireSellingPrivileges(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = readProductInput(body, false);
  await verifyProductRefs(c, ctx, input);
  const state = input.state ?? 'published';
  if (state === 'published' && !publishableModel(input.variantModel, 0, 'simple')) throw notPublishable();
  const id = newId('cp');
  const ts = nowIso();
  await c.env.DB.batch(
    createStatements(c.env.DB, ctx, id, ts, input.fields, state, {
      attributes: input.attributes,
      model: input.variantModel,
      collectionIds: input.collectionIds,
      media: input.media,
    })
  );
  await audit(c.env.DB, ctx.store.user_id, 'merchant.product_created', id, { store: ctx.store.id, state });
  const product = await readProductDetail(c.env.DB, ctx.merchant.id, id);
  return c.json({ success: true, product }, 201);
});

/**
 * Edit. Only what the body sends changes; `variant_model`, `media` and
 * `collection_ids` each replace their whole set. One batch.
 */
merchantCatalogRoutes.patch('/products/:id', async (c) => {
  await rateLimit(c, 'merchant-product-update', 120, 3600);
  const ctx = await requireSellingPrivileges(c);
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = readProductInput(body, true);
  if (
    !Object.keys(input.fields).length && !input.state && !input.attributes && !input.media && !input.collectionIds && !input.variantModel
  ) {
    throw badRequest('Nothing to update');
  }
  const current = await db
    .prepare(
      `SELECT p.id, p.name, p.publish_state, p.lifecycle, p.variant_mode, p.admin_hidden_at, p.admin_hidden_reason, p.stock,
              p.track_stock, p.low_stock_threshold, p.images,
              (SELECT COUNT(*) FROM community_product_variants v WHERE v.product_id = p.id AND v.active = 1) AS active_variants,
              (SELECT json_group_array(media_key) FROM community_product_media m WHERE m.product_id = p.id AND m.kind = 'image') AS image_keys
         FROM community_products p WHERE p.id = ? AND p.merchant_id = ?`
    )
    .bind(id, ctx.merchant.id)
    .first<Record<string, unknown>>();
  if (!current) throw notFound('Product not found');
  await verifyProductRefs(c, ctx, input, safeParse<string[]>(current.image_keys, []));

  const currentState = stateOf(current);
  // A product LEVONIS hid stays hidden until Levonis lifts it (audit 01 B9).
  // ONLY A CHANGE IS AN ATTEMPT: the editor re-sends the whole form, so a
  // `published` that already was the state is an edit, not a publish (and the
  // product stays hidden — the 0126 mirror computes `status` in the database).
  if (input.state === 'published' && currentState !== 'published') {
    if (current.admin_hidden_at) throw hiddenByAdmin(String(current.admin_hidden_reason ?? ''));
  }
  const targetState = input.state ?? currentState;
  if (targetState === 'published' && !publishableModel(input.variantModel, Number(current.active_variants), String(current.variant_mode))) {
    throw notPublishable();
  }
  if (input.variantModel?.groups.length === 0 && input.fields.stock === undefined && String(current.variant_mode) === 'variants') {
    // Leaving variants: the product's own stock must be stated, never inherited from the sum.
    throw productInvalid([{ path: 'stock', code: 'STOCK_REQUIRED' }]);
  }

  const ts = nowIso();
  const cols: Record<string, unknown> = { ...input.fields, ...(input.attributes ? attributeColumns(input.attributes) : {}) };
  if (input.state) cols.publish_state = input.state;
  if (cols.stock !== undefined || cols.low_stock_threshold !== undefined) cols.low_stock_alerted_at = null;
  cols.updated_at = ts;
  const names = Object.keys(cols);
  const stmts: D1PreparedStatement[] = [];
  const variantStockBefore = new Map<string, number>();
  if (input.variantModel) {
    const [existing, before] = await Promise.all([
      readExistingModel(db, id),
      db.prepare('SELECT id, stock FROM community_product_variants WHERE product_id = ?').bind(id).all<{ id: string; stock: number }>(),
    ]);
    for (const r of before.results) variantStockBefore.set(r.id, Number(r.stock));
    stmts.push(...variantModelStatements(db, id, ctx.store.id, input.variantModel, existing).statements);
  }
  // The row itself AFTER the model: a return to `simple` sets its own stock last.
  stmts.push(
    db
      .prepare(
        `UPDATE community_products SET ${names.map((n, i) => `${n} = ?${i + 1}`).join(', ')}
          WHERE id = ?${names.length + 1} AND merchant_id = ?${names.length + 2}`
      )
      .bind(...names.map((n) => cols[n]), id, ctx.merchant.id)
  );
  if (input.media) stmts.push(...mediaStatements(db, id, ctx.store.id, input.media));
  if (input.collectionIds) stmts.push(...membershipStatements(db, id, ctx.store.id, input.collectionIds));
  await db.batch(stmts);

  await audit(db, ctx.store.user_id, 'merchant.product_updated', id, {
    fields: [...Object.keys(input.fields), ...(input.state ? ['state'] : []), ...(input.variantModel ? ['variants'] : []),
      ...(input.media ? ['media'] : []), ...(input.collectionIds ? ['collections'] : []), ...(input.attributes ? ['attributes'] : [])],
  });
  const product = await readProductDetail(db, ctx.merchant.id, id);

  // A stock the merchant lowered to (or under) their own line is told once —
  // the product's, or each VARIANT's (its own line, else the product's).
  if (product) {
    const moves: StockMove[] = [];
    if (input.fields.stock !== undefined && product.variant_mode !== 'variants') {
      moves.push({ productId: id, productName: String(product.name), before: Number(current.stock), after: Number(product.stock), threshold: product.low_stock_threshold });
    }
    if (input.variantModel && product.variant_mode === 'variants') {
      for (const v of product.variants) {
        const was = variantStockBefore.get(v.id);
        if (was === undefined || !v.active) continue;
        moves.push({
          productId: id,
          productName: String(product.name),
          variantLabel: v.label,
          before: was,
          after: v.stock,
          threshold: v.low_stock_threshold ?? product.low_stock_threshold,
        });
      }
    }
    if (moves.length) await runAfter(c, alertLowStock(c.env, ctx.merchant.id, moves, `edit:${ts}`));
  }
  return c.json({ success: true, product });
});

/**
 * A copy, as a DRAFT: the product, its option groups, values and variants (new
 * ids), its media, attributes and collections. A copy of a product Levonis hid
 * is refused — it would be the hidden content with a new id.
 */
merchantCatalogRoutes.post('/products/:id/duplicate', async (c) => {
  await rateLimit(c, 'merchant-product-create', 60, 3600);
  const ctx = await requireSellingPrivileges(c);
  const db = c.env.DB;
  const src = await readProductDetail(db, ctx.merchant.id, c.req.param('id'));
  if (!src) throw notFound('Product not found');
  if (src.moderation?.hidden_by_admin) throw hiddenByAdmin(src.moderation.reason);
  const id = newId('cp');
  const ts = nowIso();
  const model: VariantModel | undefined =
    src.variant_mode === 'variants'
      ? {
          groups: src.option_groups.map((g) => ({
            ref: `g_${g.id}`,
            name: g.name,
            name_ar: g.name_ar,
            kind: g.kind,
            values: g.values.map((v) => ({ ref: `v_${v.id}`, name: v.name, name_ar: v.name_ar, swatch: v.swatch })),
          })),
          variants: src.variants.map((v) => ({
            values: v.value_ids.map((x) => `v_${x}`),
            price_iqd: v.price_iqd,
            compare_at_iqd: v.compare_at_iqd,
            stock: v.stock,
            sku: '',
            active: v.active,
            image_key: v.image_key,
            low_stock_threshold: v.low_stock_threshold,
          })),
        }
      : undefined;
  const stmts = createStatements(
    db,
    ctx,
    id,
    ts,
    {
      name: `${src.name} (copy)`.slice(0, 120),
      name_ar: src.name_ar,
      description: src.description,
      description_ar: src.description_ar,
      price_iqd: src.price_iqd,
      original_price_iqd: src.original_price_iqd,
      sku: '',
      stock: src.variant_mode === 'variants' ? 0 : src.stock,
      track_stock: src.track_stock ? 1 : 0,
      category: src.category,
      condition: src.condition,
      prep_days: src.prep_days,
      featured: src.featured ? 1 : 0,
      low_stock_threshold: src.low_stock_threshold,
      delivery_methods: JSON.stringify(src.delivery_methods ?? []),
    },
    'draft',
    {
      attributes: src.attributes,
      model,
      collectionIds: src.collection_ids,
      media: src.media.map((m) => ({ key: m.key, kind: m.kind, alt: m.alt, alt_ar: m.alt_ar })),
    }
  );
  await db.batch(stmts);
  await audit(db, ctx.store.user_id, 'merchant.product_duplicated', id, { from: src.id });
  const product = await readProductDetail(db, ctx.merchant.id, id);
  return c.json({ success: true, product }, 201);
});

/**
 * One product's real numbers. Views are the store's own first-party count
 * (stream W2-E's daily table) when this database has it, else the product's
 * de-duplicated counter; units, orders and revenue come from order lines of
 * orders that were NOT cancelled — in total, per variant and per day.
 */
merchantCatalogRoutes.get('/products/:id/insights', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const id = c.req.param('id');
  const product = await readProductDetail(db, ctx.merchant.id, id);
  if (!product) throw notFound('Product not found');
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [totals, byVariant, daily] = await Promise.all([
    db.prepare(
      `SELECT COALESCE(SUM(i.line_total_iqd), 0) AS revenue, COALESCE(SUM(i.qty), 0) AS units, COUNT(DISTINCT i.order_id) AS orders
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.community_product_id = ?1 AND o.merchant_id = ?2 AND o.status != 'cancelled'`
    ).bind(id, ctx.merchant.id).all(),
    db.prepare(
      `SELECT i.variant_id, MAX(i.option_snapshot) AS label, COALESCE(SUM(i.qty), 0) AS units, COALESCE(SUM(i.line_total_iqd), 0) AS revenue
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.community_product_id = ?1 AND o.merchant_id = ?2 AND o.status != 'cancelled' AND i.variant_id IS NOT NULL
        GROUP BY i.variant_id ORDER BY units DESC`
    ).bind(id, ctx.merchant.id).all(),
    db.prepare(
      `SELECT substr(o.created_at, 1, 10) AS day, COALESCE(SUM(i.qty), 0) AS units, COALESCE(SUM(i.line_total_iqd), 0) AS revenue
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.community_product_id = ?1 AND o.merchant_id = ?2 AND o.status != 'cancelled' AND o.created_at >= ?3
        GROUP BY day ORDER BY day`
    ).bind(id, ctx.merchant.id, since).all(),
  ]);
  let views = Number(product.view_count ?? 0);
  let viewsSource: 'analytics' | 'counter' = 'counter';
  let viewsDaily: Array<{ day: string; views: number; add_to_cart: number }> = [];
  try {
    const [sum, days] = await Promise.all([
      db.prepare(
        `SELECT COALESCE(SUM(views), 0) AS views, COUNT(*) AS n FROM merchant_product_analytics_daily WHERE product_id = ?1 AND store_id = ?2`
      ).bind(id, ctx.store.id).all(),
      db.prepare(
        `SELECT day, views, add_to_cart FROM merchant_product_analytics_daily
          WHERE product_id = ?1 AND store_id = ?2 AND day >= ?3 ORDER BY day`
      ).bind(id, ctx.store.id, since.slice(0, 10)).all(),
    ]);
    const s = (sum.results as Array<{ views: number; n: number }>)[0];
    if (s && Number(s.n) > 0) {
      views = Number(s.views);
      viewsSource = 'analytics';
      viewsDaily = (days.results as Array<Record<string, unknown>>).map((d) => ({
        day: String(d.day),
        views: Number(d.views ?? 0),
        add_to_cart: Number(d.add_to_cart ?? 0),
      }));
    }
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }
  const t = (totals.results as Array<Record<string, number>>)[0] ?? {};
  const labels = new Map(product.variants.map((v) => [v.id, v.label]));
  return c.json({
    success: true,
    product,
    insights: {
      views,
      views_source: viewsSource,
      sold: Number(product.sold_count ?? 0),
      units_sold: Number(t.units ?? 0),
      units_ordered: Number(t.units ?? 0),
      revenue_iqd: Number(t.revenue ?? 0),
      orders: Number(t.orders ?? 0),
      by_variant: (byVariant.results as Array<Record<string, unknown>>).map((r) => ({
        variant_id: String(r.variant_id),
        label: labels.get(String(r.variant_id)) ?? String(r.label ?? ''),
        units: Number(r.units ?? 0),
        revenue_iqd: Number(r.revenue ?? 0),
      })),
      daily: (daily.results as Array<Record<string, unknown>>).map((r) => ({
        day: String(r.day),
        units: Number(r.units ?? 0),
        revenue_iqd: Number(r.revenue ?? 0),
      })),
      views_daily: viewsDaily,
      created_at: product.created_at,
      updated_at: product.updated_at || product.created_at,
    },
  });
});

/**
 * Archive, not delete: a product any order names is archived (its lines,
 * reviews and the customer's history keep it); only one nothing ever touched
 * is deleted.
 */
merchantCatalogRoutes.delete('/products/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const id = c.req.param('id');
  const res = await db
    .prepare(
      `DELETE FROM community_products WHERE id = ?1 AND merchant_id = ?2
          AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.community_product_id = ?1)`
    )
    .bind(id, ctx.merchant.id)
    .run();
  if (res.meta.changes) {
    await audit(db, ctx.store.user_id, 'merchant.product_deleted', id, {});
    return c.json({ success: true, archived: false });
  }
  const arch = await db
    .prepare(`UPDATE community_products SET publish_state = 'archived', updated_at = ?1 WHERE id = ?2 AND merchant_id = ?3`)
    .bind(nowIso(), id, ctx.merchant.id)
    .run();
  if (!arch.meta.changes) throw notFound('Product not found');
  await audit(db, ctx.store.user_id, 'merchant.product_archived', id, { reason: 'has_orders' });
  return c.json({ success: true, archived: true });
});

// ============================================================ collections

const MAX_COLLECTIONS = 30;

function collectionShape(s: Record<string, unknown>) {
  return {
    id: s.id,
    name: s.name,
    name_ar: s.name_ar,
    kind: (s.kind as CollectionKind) ?? 'manual',
    description: s.description ?? '',
    description_ar: s.description_ar ?? '',
    image_url: s.image_key ? `/files/${String(s.image_key)}` : null,
    image_key: s.image_key ?? null,
    sort_order: s.sort_order,
    active: !!s.active,
    product_count: s.product_count ?? undefined,
    created_at: s.created_at,
  };
}

/** How many products a collection holds for its merchant (every state but archived). */
const COLLECTION_COUNT_SQL = `CASE s.kind
  WHEN 'manual' THEN (SELECT COUNT(*) FROM merchant_collection_products m JOIN community_products p ON p.id = m.product_id
                        WHERE m.collection_id = s.id AND p.publish_state <> 'archived')
  WHEN 'featured' THEN (SELECT COUNT(*) FROM community_products p WHERE p.store_id = s.store_id AND p.featured = 1 AND p.publish_state <> 'archived')
  WHEN 'new_arrivals' THEN (SELECT COUNT(*) FROM community_products p WHERE p.store_id = s.store_id AND p.created_at >= ?2 AND p.publish_state <> 'archived')
  ELSE (SELECT COUNT(*) FROM community_products p WHERE p.store_id = s.store_id AND p.sold_count > 0 AND p.publish_state <> 'archived')
END`;

async function listCollections(c: Context<AppContext>) {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.*, ${COLLECTION_COUNT_SQL} AS product_count
         FROM merchant_store_sections s WHERE s.store_id = ?1 ORDER BY s.sort_order, s.created_at`
    )
    .bind(ctx.store.id, sinceNewArrivals())
    .all<Record<string, unknown>>();
  // `sections` is the pre-0126 key of the same list.
  const list = results.map(collectionShape);
  return c.json({ success: true, collections: list, sections: list });
}

async function readCollectionBody(c: Context<AppContext>, ctx: StoreContext, partial: boolean) {
  const body = await c.req.json().catch(() => ({}));
  const out: Record<string, unknown> = {};
  const has = (k: string) => body[k] !== undefined;
  if (!partial || has('name')) out.name = str(body.name, 'name', { min: 1, max: 60 });
  if (has('name_ar')) out.name_ar = str(body.name_ar, 'name_ar', { min: 0, max: 60, required: false });
  // «|» separates collections in one spreadsheet cell (worker/lib/catalog/csv.ts).
  if (String(out.name ?? '').includes('|') || String(out.name_ar ?? '').includes('|')) {
    throw badRequest('A collection name cannot contain «|»', 'COLLECTION_NAME_INVALID');
  }
  if (has('description')) out.description = str(body.description, 'description', { min: 0, max: 500, required: false });
  if (has('description_ar')) out.description_ar = str(body.description_ar, 'description_ar', { min: 0, max: 500, required: false });
  if (has('sort_order')) out.sort_order = int(body.sort_order, 'sort_order', { min: 0, max: 999 });
  if (has('active')) out.active = body.active ? 1 : 0;
  if (has('image_key')) {
    const raw = typeof body.image_key === 'string' ? body.image_key : '';
    if (!raw) out.image_key = null;
    else {
      const key = ownedMediaKey(raw, ctx.store.user_id);
      if (!key) throw badRequest('image_key must be a picture you uploaded to this store', 'MEDIA_NOT_OWNED');
      out.image_key = key;
    }
  }
  if (!partial) {
    const kind = body.kind === undefined ? 'manual' : String(body.kind);
    if (!(COLLECTION_KINDS as readonly string[]).includes(kind)) throw badRequest('Unknown collection kind', 'COLLECTION_KIND_INVALID');
    out.kind = kind;
  }
  return out;
}

async function createCollection(c: Context<AppContext>) {
  await rateLimit(c, 'merchant-section', 60, 3600);
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const fields = await readCollectionBody(c, ctx, false);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM merchant_store_sections WHERE store_id = ?').bind(ctx.store.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_COLLECTIONS) throw badRequest(`A store can hold at most ${MAX_COLLECTIONS} collections`, 'COLLECTIONS_LIMIT');
  const id = newId('sec');
  try {
    await db
      .prepare(
        `INSERT INTO merchant_store_sections (id, store_id, name, name_ar, sort_order, active, kind, description, description_ar, image_key)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9)`
      )
      .bind(
        id, ctx.store.id, fields.name, fields.name_ar ?? '', fields.sort_order ?? 0, fields.kind,
        fields.description ?? '', fields.description_ar ?? '', fields.image_key ?? null
      )
      .run();
  } catch (e) {
    if (String(e instanceof Error ? e.message : e).includes('UNIQUE')) {
      throw conflict('This store already has that computed collection', 'COLLECTION_KIND_EXISTS');
    }
    throw e;
  }
  const row = await db.prepare('SELECT * FROM merchant_store_sections WHERE id = ?').bind(id).first<Record<string, unknown>>();
  const shaped = collectionShape(row!);
  return c.json({ success: true, collection: shaped, section: shaped }, 201);
}

async function updateCollection(c: Context<AppContext>) {
  const ctx = await requireStoreOwner(c);
  const fields = await readCollectionBody(c, ctx, true);
  const names = Object.keys(fields);
  if (!names.length) throw badRequest('Nothing to update');
  const res = await c.env.DB
    .prepare(
      `UPDATE merchant_store_sections SET ${names.map((n, i) => `${n} = ?${i + 1}`).join(', ')}
        WHERE id = ?${names.length + 1} AND store_id = ?${names.length + 2}`
    )
    .bind(...names.map((n) => fields[n]), c.req.param('id'), ctx.store.id)
    .run();
  if (!res.meta.changes) throw notFound('Collection not found');
  return c.json({ success: true });
}

async function deleteCollection(c: Context<AppContext>) {
  const ctx = await requireStoreOwner(c);
  const id = c.req.param('id');
  // Products survive their collection: memberships go with it (CASCADE), and
  // the pre-0126 single-collection column is cleared the same way.
  const res = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE community_products SET section_id = NULL WHERE section_id = ? AND store_id = ?').bind(id, ctx.store.id),
    c.env.DB.prepare('DELETE FROM merchant_store_sections WHERE id = ? AND store_id = ?').bind(id, ctx.store.id),
  ]);
  if (!res[1].meta.changes) throw notFound('Collection not found');
  return c.json({ success: true });
}

for (const base of ['/collections', '/sections']) {
  merchantCatalogRoutes.get(base, listCollections);
  merchantCatalogRoutes.post(base, createCollection);
  merchantCatalogRoutes.patch(`${base}/:id`, updateCollection);
  merchantCatalogRoutes.delete(`${base}/:id`, deleteCollection);
}

/** The collection's products in its own order — members of a manual one, the rule's result for a computed one. */
merchantCatalogRoutes.get('/collections/:id/products', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const col = await db
    .prepare('SELECT id, kind FROM merchant_store_sections WHERE id = ? AND store_id = ?')
    .bind(c.req.param('id'), ctx.store.id)
    .first<{ id: string; kind: CollectionKind }>();
  if (!col) throw notFound('Collection not found');
  const order = collectionOrder(col.kind, 'p', '?1');
  const { results } = await db
    .prepare(
      `SELECT p.*, ${LIST_EXTRA_COLUMNS} FROM community_products p
        WHERE p.store_id = ?2 AND p.publish_state <> 'archived' AND ${collectionMemberSql(col.kind, 'p', '?1', '?3')}
        ORDER BY ${order.sortExpr} ${order.dir}, p.created_at DESC, p.id DESC LIMIT 500`
    )
    .bind(col.id, ctx.store.id, sinceNewArrivals())
    .all<Record<string, unknown>>();
  return c.json({ success: true, collection: { id: col.id, kind: col.kind }, products: results.map(productShape) });
});

async function manualCollection(c: Context<AppContext>, ctx: StoreContext) {
  const col = await c.env.DB
    .prepare('SELECT id, kind FROM merchant_store_sections WHERE id = ? AND store_id = ?')
    .bind(c.req.param('id'), ctx.store.id)
    .first<{ id: string; kind: string }>();
  if (!col) throw notFound('Collection not found');
  if (col.kind !== 'manual') throw conflict('A computed collection chooses its own products', 'COLLECTION_COMPUTED');
  return col;
}

async function ownProductIds(db: D1Database, merchantId: string, raw: unknown, max: number): Promise<string[]> {
  const list = Array.isArray(raw) ? raw : [];
  const ids = [...new Set(list.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)))];
  if (ids.length !== list.length || ids.length > max) throw badRequest(`Up to ${max} distinct product ids`, 'COLLECTION_PRODUCTS_INVALID');
  if (!ids.length) return [];
  const { results } = await db
    .prepare('SELECT id FROM community_products WHERE merchant_id = ?1 AND id IN (SELECT value FROM json_each(?2))')
    .bind(merchantId, JSON.stringify(ids))
    .all<{ id: string }>();
  const own = new Set(results.map((r) => r.id));
  const foreign = ids.filter((id) => !own.has(id));
  if (foreign.length) throw new HttpError(404, 'Some products are not in your store', 'PRODUCT_NOT_FOUND', { ids: foreign });
  return ids;
}

/** The merchant's ORDER for a manual collection: exactly these products, in this order. */
merchantCatalogRoutes.put('/collections/:id/products', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const col = await manualCollection(c, ctx);
  const body = await c.req.json().catch(() => ({}));
  const ids = await ownProductIds(db, ctx.merchant.id, body.product_ids, 500);
  await db.batch([
    db
      .prepare(
        `DELETE FROM merchant_collection_products
          WHERE collection_id = ?1 AND store_id = ?2 AND product_id NOT IN (SELECT value FROM json_each(?3))`
      )
      .bind(col.id, ctx.store.id, JSON.stringify(ids)),
    ...ids.map((pid, i) =>
      db
        .prepare(
          `INSERT INTO merchant_collection_products (collection_id, product_id, store_id, position) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(collection_id, product_id) DO UPDATE SET position = excluded.position`
        )
        .bind(col.id, pid, ctx.store.id, i)
    ),
  ]);
  return c.json({ success: true, count: ids.length });
});

merchantCatalogRoutes.post('/collections/:id/products', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const col = await manualCollection(c, ctx);
  const body = await c.req.json().catch(() => ({}));
  const ids = await ownProductIds(db, ctx.merchant.id, body.product_ids, 100);
  if (ids.length) await db.batch(membershipAdd(db, col.id, ctx.store.id, ids));
  return c.json({ success: true, added: ids.length });
});

function membershipAdd(db: D1Database, collectionId: string, storeId: string, ids: string[]) {
  return ids.map((pid, i) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO merchant_collection_products (collection_id, product_id, store_id, position)
         SELECT ?1, ?2, ?3, COALESCE((SELECT MIN(position) FROM merchant_collection_products WHERE collection_id = ?1), 1) - 1 - ?4`
      )
      .bind(collectionId, pid, storeId, i)
  );
}

merchantCatalogRoutes.delete('/collections/:id/products/:productId', async (c) => {
  const ctx = await requireStoreOwner(c);
  const col = await manualCollection(c, ctx);
  await c.env.DB
    .prepare('DELETE FROM merchant_collection_products WHERE collection_id = ? AND product_id = ? AND store_id = ?')
    .bind(col.id, c.req.param('productId'), ctx.store.id)
    .run();
  return c.json({ success: true });
});

/** The variant label SQL is re-exported for the routes that print order lines. */
export { variantLabelSql };
