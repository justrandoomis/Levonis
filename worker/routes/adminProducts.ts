/**
 * Admin product/taxonomy API v2 — mounted at /api/admin/products-v2.
 *
 * Works exclusively on the canonical ProductDoc (worker/lib/productModel.ts):
 *  - GET  /            bounded LISTING projection (never an edit payload)
 *  - GET  /:id         FULL document (projectAdmin) + catalog_ids — the edit payload
 *  - POST /            create/update with slug stability, stale-edit protection
 *                      and translation staleness tracking
 *  - DELETE /:id       archive policy (hide when referenced by orders, else delete)
 *  - POST /:id/quote   admin price preview via the central resolver (costs included)
 *  - /brands, /catalogs taxonomy CRUD (deactivate, never delete)
 *  - PUT  /:id/catalogs, POST /catalogs/:catalogId/reorder catalog placement
 *
 * All routes require an admin session (server-side role check). Sensitive
 * mutations are written to the audit log.
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, int, str, forbidden } from '../lib/http';
import { audit } from '../lib/audit';
import { newId } from '../lib/crypto';
import {
  parseProductRow,
  validateProductDoc,
  serializeDoc,
  projectAdmin,
  upgradeMedia,
  PRODUCT_COLUMNS,
} from '../lib/productModel';
import type { ProductDoc, TranslationMeta } from '../lib/productModel';
import { resolveUnitPrice, proPolicyFrom } from '../lib/pricing';
import type { Tier } from '../lib/pricing';
import { getSettings } from '../lib/settings';
import { transportDefaultsFrom } from './products';
import { localizeProductDoc } from '../lib/translate/localizeProduct';
import {
  attemptedFinancialWrites,
  canViewFinancials,
  carryStoredCostForward,
  projectForAdmin,
} from '../lib/adminScope';
import { syncProductTranslations } from '../lib/translate/store';

export const adminProductsRoutes = new Hono<AppContext>();

adminProductsRoutes.use('*', requireAdmin);

// ---------------------------------------------------------------- helpers

/** Same charset the v1 admin used: latin + digits + Arabic block, dash-joined. */
function slugToken(input: unknown): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

type SluggedTable = 'products' | 'brands' | 'catalogs';

async function uniqueSlugIn(
  db: D1Database,
  table: SluggedTable,
  base: string,
  excludeId: string | null
): Promise<string> {
  const taken = async (s: string): Promise<boolean> => {
    const stmt = excludeId
      ? db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id <> ?`).bind(s, excludeId)
      : db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).bind(s);
    return !!(await stmt.first());
  };
  if (!(await taken(base))) return base;
  for (let i = 2; i <= 30; i++) {
    const cand = `${base}-${i}`;
    if (!(await taken(cand))) return cand;
  }
  return `${base}-${newId().slice(0, 6)}`;
}

async function catalogIdsFor(db: D1Database, productId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ? ORDER BY catalog_id')
    .bind(productId)
    .all<{ catalog_id: string }>();
  return results.map((r) => r.catalog_id);
}

/**
 * Syncs product_catalogs to exactly `catalogIds`. New associations append at
 * MAX(position)+1 within their catalog (UNIQUE(catalog_id, position) safe).
 * Throws 400 on unknown catalog ids. Returns the final id list.
 */
async function syncCatalogs(db: D1Database, productId: string, catalogIds: string[]): Promise<string[]> {
  const wanted = [...new Set(catalogIds.map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  if (wanted.length) {
    const ph = wanted.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT id FROM catalogs WHERE id IN (${ph})`)
      .bind(...wanted)
      .all<{ id: string }>();
    const known = new Set(results.map((r) => r.id));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length) throw badRequest(`catalog_ids: unknown catalog "${missing[0]}"`);
  }
  const { results: current } = await db
    .prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ?')
    .bind(productId)
    .all<{ catalog_id: string }>();
  const have = new Set(current.map((r) => r.catalog_id));
  const wantSet = new Set(wanted);

  const stmts: D1PreparedStatement[] = [];
  for (const cid of have) {
    if (!wantSet.has(cid)) {
      stmts.push(
        db.prepare('DELETE FROM product_catalogs WHERE product_id = ? AND catalog_id = ?').bind(productId, cid)
      );
    }
  }
  for (const cid of wanted) {
    if (!have.has(cid)) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO product_catalogs (product_id, catalog_id, position)
             VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM product_catalogs WHERE catalog_id = ?))`
          )
          .bind(productId, cid, cid)
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  return wanted;
}

/** Fields whose per-language state is tracked. English is the SOURCE. */
const TRACKED_FIELDS = [
  { key: 'name', en: 'name_en', ar: 'name_ar', ckb: 'name_ckb' },
  { key: 'description', en: 'description_en', ar: 'description_ar', ckb: 'description_ckb' },
] as const;

/**
 * Translation bookkeeping, ENGLISH-SOURCED (product-form mandate §3, which
 * replaces the earlier Arabic-sourced scheme).
 *
 *  - The admin types English only. `localizeProductDoc` fills every ar/ckb slot
 *    from the local deterministic engine — no network, no AI — and reports the
 *    fields it could not cover.
 *  - The product NAME is copied, never translated, so it reads identically in
 *    all three languages (§3, §12).
 *  - `translation_meta` records, per field and language, whether the stored
 *    text came out of the engine ('machine'), still needs a human
 *    ('review_needed'), or was approved by one ('approved' — set only through
 *    the future review page, and preserved here as long as the English source
 *    is unchanged).
 *  - content_rev bumps once when any tracked ENGLISH source changed.
 */
function applyTranslationTracking(
  doc: ProductDoc,
  prev: ProductDoc | null,
  review: string[]
): void {
  const storedMeta: TranslationMeta = prev?.translation_meta ?? {};
  const meta: TranslationMeta = {};
  for (const key of Object.keys(storedMeta)) meta[key] = { ...storedMeta[key] };

  const text = (d: ProductDoc, field: string): string => (d as unknown as Record<string, string>)[field] ?? '';

  let contentRev = prev ? prev.content_rev : doc.content_rev || 1;
  const englishChanged = prev
    ? TRACKED_FIELDS.some((f) => text(doc, f.en) !== text(prev, f.en))
    : true;
  if (prev && englishChanged) contentRev += 1;

  const needsReview = new Set(review);
  for (const f of TRACKED_FIELDS) {
    const entry = meta[f.key] ?? {};
    const sourceChanged = !prev || text(doc, f.en) !== text(prev, f.en);
    entry.en = { status: text(doc, f.en).trim() ? 'imported' : 'missing', src_rev: contentRev };
    for (const lang of ['ar', 'ckb'] as const) {
      const cur = entry[lang];
      // A human approval survives while the English source is unchanged.
      if (!sourceChanged && cur && cur.status === 'approved') continue;
      if (!text(doc, f.en).trim()) {
        entry[lang] = { status: 'missing', src_rev: contentRev };
      } else if (needsReview.has(f.key)) {
        entry[lang] = { status: 'stale', src_rev: contentRev };
      } else {
        entry[lang] = { status: 'imported', src_rev: contentRev };
      }
    }
    meta[f.key] = entry;
  }

  doc.content_rev = contentRev;
  doc.translation_meta = meta;
}

// ---------------------------------------------------------------- price history

// 'compare_at' is retired from the product form (mandate §4) but stays a
// legal value in the table so historic rows remain readable; new rows only
// ever use these four.
type HistoryField = 'regular' | 'prime' | 'pro' | 'cost';

interface PriceDelta {
  variant_key: string; // '' | option:<id> | color:<id>
  field: HistoryField;
  old_iqd: number | null;
  new_iqd: number | null;
}

/**
 * Monetary-field diff between the stored document and the saved one — one
 * row per changed price (price_history, 0003). Feeds seven-day price
 * protection (§6.8): a drop stays inspectable even after the price moves
 * again. Costs are internal and deliberately NOT recorded here (the table
 * is scoped to selling prices by its CHECK constraint).
 */
interface PriceFields2 {
  id: string;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
}

export function priceHistoryDeltas(prev: ProductDoc, next: ProductDoc): PriceDelta[] {
  const out: PriceDelta[] = [];
  const push = (variantKey: string, field: HistoryField, oldV: number | null, newV: number | null) => {
    if (oldV !== newV) out.push({ variant_key: variantKey, field, old_iqd: oldV, new_iqd: newV });
  };

  push('', 'regular', prev.price_iqd, next.price_iqd);
  push('', 'prime', prev.prime_price_iqd, next.prime_price_iqd);
  push('', 'pro', prev.pro_price_iqd, next.pro_price_iqd);
  push('', 'cost', prev.product_cost_iqd, next.product_cost_iqd);

  const diffGroup = (
    kind: 'option' | 'color',
    prevItems: PriceFields2[],
    nextItems: PriceFields2[]
  ) => {
    const prevById = new Map(prevItems.map((x) => [x.id, x]));
    const nextById = new Map(nextItems.map((x) => [x.id, x]));
    for (const id of new Set([...prevById.keys(), ...nextById.keys()])) {
      const p = prevById.get(id) ?? null;
      const n = nextById.get(id) ?? null;
      push(`${kind}:${id}`, 'regular', p?.regular_price_iqd ?? null, n?.regular_price_iqd ?? null);
      push(`${kind}:${id}`, 'prime', p?.prime_price_iqd ?? null, n?.prime_price_iqd ?? null);
      push(`${kind}:${id}`, 'pro', p?.pro_price_iqd ?? null, n?.pro_price_iqd ?? null);
      push(`${kind}:${id}`, 'cost', p?.cost_iqd ?? null, n?.cost_iqd ?? null);
    }
  };
  diffGroup('option', prev.options, next.options);
  diffGroup('color', prev.colors, next.colors);
  return out;
}

async function recordPriceHistory(
  db: D1Database,
  productId: string,
  actorId: string,
  deltas: PriceDelta[]
): Promise<void> {
  if (deltas.length === 0) return;
  const stmts = deltas.map((d) =>
    db
      .prepare(
        'INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(productId, d.variant_key, d.field, d.old_iqd, d.new_iqd, actorId)
  );
  await db.batch(stmts);
}

function brandOut(r: Record<string, unknown>) {
  return {
    id: r.id,
    slug: r.slug,
    name_ar: r.name_ar,
    name_en: r.name_en,
    name_ckb: r.name_ckb,
    active: !!r.active,
    created_at: r.created_at,
  };
}

function catalogOut(r: Record<string, unknown>) {
  return {
    id: r.id,
    parent_id: (r.parent_id as string | null) ?? null,
    slug: r.slug,
    name_ar: r.name_ar,
    name_en: r.name_en,
    name_ckb: r.name_ckb,
    sort: r.sort,
    is_printer_catalog: !!r.is_printer_catalog,
    active: !!r.active,
    created_at: r.created_at,
  };
}

// NOTE: static routes (/brands, /catalogs) are registered BEFORE /:id so a
// brand/catalog request never resolves as a product id.

// ---------------------------------------------------------------- brands

adminProductsRoutes.get('/brands', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM brands ORDER BY name_ar, created_at').all<
    Record<string, unknown>
  >();
  return c.json({ success: true, brands: results.map(brandOut) });
});

adminProductsRoutes.post('/brands', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const nameAr = str(body.name_ar, 'name_ar', { min: 1, max: 200 });
  const nameEn = str(body.name_en, 'name_en', { max: 200, required: false });
  const nameCkb = str(body.name_ckb, 'name_ckb', { max: 200, required: false });
  const id = newId('brd');
  const base = slugToken(nameEn) || slugToken(nameAr) || `brand-${id.slice(-6)}`;
  const slug = await uniqueSlugIn(c.env.DB, 'brands', base, null);
  await c.env.DB.prepare('INSERT INTO brands (id, slug, name_ar, name_en, name_ckb, active) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(id, slug, nameAr, nameEn, nameCkb)
    .run();
  await audit(c.env.DB, admin.id, 'brand.create', id, { slug, name_ar: nameAr });
  const row = await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, brand: brandOut(row!) });
});

adminProductsRoutes.patch('/brands/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.name_ar !== undefined) {
    sets.push('name_ar = ?');
    params.push(str(body.name_ar, 'name_ar', { min: 1, max: 200 }));
  }
  if (body.name_en !== undefined) {
    sets.push('name_en = ?');
    params.push(str(body.name_en, 'name_en', { max: 200, required: false }));
  }
  if (body.name_ckb !== undefined) {
    sets.push('name_ckb = ?');
    params.push(str(body.name_ckb, 'name_ckb', { max: 200, required: false }));
  }
  if (body.active !== undefined) {
    sets.push('active = ?');
    params.push(body.active ? 1 : 0); // deactivate only — brands are never deleted
  }
  if (!sets.length) throw badRequest('Nothing to update (name_ar, name_en, name_ckb, active)');
  const res = await c.env.DB.prepare(`UPDATE brands SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params, id)
    .run();
  if (res.meta.changes === 0) throw notFound('Brand not found');
  await audit(c.env.DB, admin.id, 'brand.update', id, body);
  const row = await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, brand: brandOut(row!) });
});

// ---------------------------------------------------------------- catalogs

adminProductsRoutes.get('/catalogs', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM catalogs ORDER BY sort, name_ar').all<
    Record<string, unknown>
  >();
  return c.json({ success: true, catalogs: results.map(catalogOut) });
});

adminProductsRoutes.post('/catalogs', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const nameAr = str(body.name_ar, 'name_ar', { min: 1, max: 200 });
  const nameEn = str(body.name_en, 'name_en', { max: 200, required: false });
  const nameCkb = str(body.name_ckb, 'name_ckb', { max: 200, required: false });
  const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;
  if (parentId) {
    const parent = await c.env.DB.prepare('SELECT id FROM catalogs WHERE id = ?').bind(parentId).first();
    if (!parent) throw badRequest('parent_id: unknown catalog');
  }
  const sort = int(body.sort, 'sort', { min: -100_000, max: 100_000, def: 0 });
  const id = newId('cat');
  const base = slugToken(nameEn) || slugToken(nameAr) || `catalog-${id.slice(-6)}`;
  const slug = await uniqueSlugIn(c.env.DB, 'catalogs', base, null);
  await c.env.DB.prepare(
    'INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)'
  )
    .bind(id, parentId, slug, nameAr, nameEn, nameCkb, sort, body.is_printer_catalog ? 1 : 0)
    .run();
  await audit(c.env.DB, admin.id, 'catalog.create', id, { slug, name_ar: nameAr, parent_id: parentId });
  const row = await c.env.DB.prepare('SELECT * FROM catalogs WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, catalog: catalogOut(row!) });
});

adminProductsRoutes.patch('/catalogs/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.name_ar !== undefined) {
    sets.push('name_ar = ?');
    params.push(str(body.name_ar, 'name_ar', { min: 1, max: 200 }));
  }
  if (body.name_en !== undefined) {
    sets.push('name_en = ?');
    params.push(str(body.name_en, 'name_en', { max: 200, required: false }));
  }
  if (body.name_ckb !== undefined) {
    sets.push('name_ckb = ?');
    params.push(str(body.name_ckb, 'name_ckb', { max: 200, required: false }));
  }
  if (body.parent_id !== undefined) {
    const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;
    if (parentId) {
      if (parentId === id) throw badRequest('parent_id: a catalog cannot be its own parent');
      // Reject cycles by walking up the proposed ancestor chain.
      let cursor: string | null = parentId;
      for (let depth = 0; cursor && depth < 25; depth++) {
        if (cursor === id) throw badRequest('parent_id: would create a catalog cycle');
        const parentRow: { parent_id: string | null } | null = await c.env.DB
          .prepare('SELECT parent_id FROM catalogs WHERE id = ?')
          .bind(cursor)
          .first<{ parent_id: string | null }>();
        if (parentRow === null && cursor === parentId) throw badRequest('parent_id: unknown catalog');
        cursor = parentRow?.parent_id ?? null;
      }
    }
    sets.push('parent_id = ?');
    params.push(parentId);
  }
  if (body.sort !== undefined) {
    sets.push('sort = ?');
    params.push(int(body.sort, 'sort', { min: -100_000, max: 100_000 }));
  }
  if (body.is_printer_catalog !== undefined) {
    sets.push('is_printer_catalog = ?');
    params.push(body.is_printer_catalog ? 1 : 0);
  }
  if (body.active !== undefined) {
    sets.push('active = ?');
    params.push(body.active ? 1 : 0); // deactivate only — catalogs are never deleted
  }
  if (!sets.length) throw badRequest('Nothing to update');
  const res = await c.env.DB.prepare(`UPDATE catalogs SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params, id)
    .run();
  if (res.meta.changes === 0) throw notFound('Catalog not found');
  await audit(c.env.DB, admin.id, 'catalog.update', id, body);
  const row = await c.env.DB.prepare('SELECT * FROM catalogs WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, catalog: catalogOut(row!) });
});

/**
 * Atomic insert-at reorder. All rows of the catalog jump to a temporary high
 * range first, then take their final 1..count positions — inside one D1 batch
 * (a transaction), so UNIQUE(catalog_id, position) can never conflict mid-shift.
 */
adminProductsRoutes.post('/catalogs/:catalogId/reorder', async (c) => {
  const admin = c.get('user')!;
  const catalogId = c.req.param('catalogId');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = str(body.product_id, 'product_id', { min: 1, max: 60 });

  const { results: rows } = await c.env.DB.prepare(
    'SELECT product_id, position FROM product_catalogs WHERE catalog_id = ? ORDER BY position'
  )
    .bind(catalogId)
    .all<{ product_id: string; position: number }>();
  if (!rows.length) throw notFound('Catalog has no products (or does not exist)');
  const cur = rows.findIndex((r) => r.product_id === productId);
  if (cur === -1) throw notFound('Product is not in this catalog');

  const position = int(body.position, 'position', { min: 1, max: rows.length });

  if (cur + 1 !== position) {
    const order = rows.map((r) => r.product_id);
    order.splice(cur, 1);
    order.splice(position - 1, 0, productId);
    const OFFSET = 1_000_000;
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE product_catalogs SET position = position + ? WHERE catalog_id = ?').bind(
        OFFSET,
        catalogId
      ),
      ...order.map((pid, i) =>
        c.env.DB.prepare('UPDATE product_catalogs SET position = ? WHERE catalog_id = ? AND product_id = ?').bind(
          i + 1,
          catalogId,
          pid
        )
      ),
    ]);
  }
  await audit(c.env.DB, admin.id, 'catalog.reorder', catalogId, { product_id: productId, position });
  return c.json({ success: true, position });
});

// ---------------------------------------------------------------- products

/**
 * Bounded listing projection — for tables/search only, NEVER for editing.
 * The management screen's filters and sorts run here, server-side: every
 * user value is a bound parameter and the sort key maps through a fixed
 * whitelist before it can reach the SQL text. The bare call keeps its
 * original behaviour and shape.
 */
adminProductsRoutes.get('/', async (c) => {
  const q = c.req.query();
  const search = str(q.search, 'search', { max: 100, required: false });
  const limit = int(q.limit, 'limit', { min: 1, max: 100, def: 30 });
  const offset = int(q.offset, 'offset', { min: 0, max: 100_000, def: 0 });

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (search) {
    // SKU is searchable too: §4 made it a real identifier, and an admin who
    // has a packing slip in hand has the SKU, not the Arabic name.
    clauses.push('(name LIKE ? OR name_ar LIKE ? OR name_ku LIKE ? OR slug LIKE ? OR sku LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  if (['draft', 'active', 'hidden'].includes(q.status ?? '')) {
    clauses.push('status = ?');
    params.push(q.status);
  }
  if (q.brand) {
    clauses.push('brand_id = ?');
    params.push(str(q.brand, 'brand', { max: 60 }));
  }
  if (q.catalog) {
    clauses.push('EXISTS (SELECT 1 FROM product_catalogs pc WHERE pc.product_id = products.id AND pc.catalog_id = ?)');
    params.push(str(q.catalog, 'catalog', { max: 60 }));
  }
  // BASE-mode honesty: available = stock - stock_reserved; NULL = untracked.
  if (q.stock === 'untracked') clauses.push('stock IS NULL');
  else if (q.stock === 'in') clauses.push('(stock IS NULL OR stock - stock_reserved > 0)');
  else if (q.stock === 'out') clauses.push('(stock IS NOT NULL AND stock - stock_reserved <= 0)');
  else if (q.stock === 'low')
    clauses.push('(stock IS NOT NULL AND stock - stock_reserved > 0 AND stock - stock_reserved <= COALESCE(low_stock_threshold, 5))');
  if (q.price_min !== undefined) {
    clauses.push('price_iqd >= ?');
    params.push(int(q.price_min, 'price_min', { min: 0, max: 1_000_000_000 }));
  }
  if (q.price_max !== undefined) {
    clauses.push('price_iqd <= ?');
    params.push(int(q.price_max, 'price_max', { min: 0, max: 1_000_000_000 }));
  }
  if (q.days !== undefined) {
    clauses.push('created_at >= ?');
    params.push(new Date(Date.now() - int(q.days, 'days', { min: 1, max: 3650 }) * 86_400_000).toISOString());
  }
  if (q.featured === '1') clauses.push('is_featured = 1');
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

  const ORDERS: Record<string, string> = {
    updated: 'updated_at DESC',
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    price_asc: 'price_iqd ASC, updated_at DESC',
    price_desc: 'price_iqd DESC, updated_at DESC',
    sales: 'sold DESC, updated_at DESC',
    stock: 'stock IS NULL, stock - stock_reserved ASC, updated_at DESC',
  };
  const orderBy = ORDERS[q.sort ?? 'updated'] ?? ORDERS.updated;

  const [list, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, slug, sku, status, name, name_ar, price_iqd, pro_price_iqd, stock,
              stock_reserved, is_featured, brand_id, images, created_at, updated_at, doc_version,
              COALESCE((SELECT SUM(i.qty) FROM order_items i
                         JOIN orders o ON o.id = i.order_id
                        WHERE i.product_id = products.id AND o.status != 'cancelled'), 0) AS sold
         FROM products${where}
        ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM products${where}`)
      .bind(...params)
      .first<{ n: number }>(),
  ]);

  return c.json({
    success: true,
    total: count?.n ?? 0,
    limit,
    offset,
    products: list.results.map((r) => {
      const media = upgradeMedia(r.images);
      const primary = media.find((m) => m.primary) ?? media[0] ?? null;
      return {
        id: r.id,
        slug: r.slug,
        sku: (r.sku as string | null) ?? null,
        status: r.status,
        name_ar: r.name_ar,
        name_en: r.name,
        price_iqd: r.price_iqd,
        pro_price_iqd: (r.pro_price_iqd as number | null) ?? null,
        stock: (r.stock as number | null) ?? null,
        stock_reserved: Number(r.stock_reserved ?? 0),
        sold: Number(r.sold ?? 0),
        is_featured: !!r.is_featured,
        brand_id: (r.brand_id as string | null) ?? null,
        image: primary?.url ?? '',
        created_at: (r.created_at as string | null) ?? null,
        updated_at: r.updated_at,
        doc_version: r.doc_version,
      };
    }),
  });
});

/**
 * The management screen's stat feed — real aggregates only. Weekly buckets
 * come from created_at (the only per-product history that exists); sales
 * come from actual order lines for the platform's own goods. Gross revenue
 * is a financial figure, so scoped admins get the units without it. There
 * is no view counter on platform products, and none is invented.
 */
adminProductsRoutes.get('/stats', async (c) => {
  const db = c.env.DB;
  const since12w = new Date(Date.now() - 12 * 7 * 86_400_000).toISOString();
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const since14d = new Date(Date.now() - 14 * 86_400_000).toISOString();

  const [totals, weekly, sales30, salesDaily] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
              SUM(CASE WHEN status = 'hidden' THEN 1 ELSE 0 END) AS hidden,
              SUM(CASE WHEN stock IS NOT NULL AND stock - stock_reserved <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
              SUM(CASE WHEN is_featured = 1 THEN 1 ELSE 0 END) AS featured
         FROM products`
    ).first<Record<string, number>>(),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS added,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_added,
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_added,
              SUM(CASE WHEN status = 'hidden' THEN 1 ELSE 0 END) AS hidden_added
         FROM products WHERE created_at >= ?
        GROUP BY day ORDER BY day`
    ).bind(since12w).all(),
    db.prepare(
      `SELECT COALESCE(SUM(i.qty), 0) AS units, COUNT(DISTINCT o.id) AS orders,
              COALESCE(SUM(i.line_total_iqd), 0) AS gross
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.product_id IS NOT NULL AND o.status != 'cancelled' AND o.created_at >= ?`
    ).bind(since30d).first<Record<string, number>>(),
    db.prepare(
      `SELECT substr(o.created_at, 1, 10) AS day, COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(i.qty), 0) AS units
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.product_id IS NOT NULL AND o.status != 'cancelled' AND o.created_at >= ?
        GROUP BY day ORDER BY day`
    ).bind(since14d).all(),
  ]);

  // Fixed windows, zero-filled: the sparklines describe the WHOLE 12-week /
  // 14-day span, and an empty bucket is a real zero — never a shrunken series
  // that makes two lonely data points look like a trend.
  const now = Date.now();
  const weeks = Array.from({ length: 12 }, (_, i) => ({
    week: new Date(now - (12 - i) * 7 * 86_400_000).toISOString().slice(0, 10),
    added: 0,
    active_added: 0,
    draft_added: 0,
    hidden_added: 0,
  }));
  for (const w of weekly.results ?? []) {
    const age = now - new Date(`${w.day}T00:00:00Z`).getTime();
    const idx = 11 - Math.floor(age / (7 * 86_400_000));
    const bucket = weeks[Math.min(11, Math.max(0, idx))];
    bucket.added += Number(w.added ?? 0);
    bucket.active_added += Number(w.active_added ?? 0);
    bucket.draft_added += Number(w.draft_added ?? 0);
    bucket.hidden_added += Number(w.hidden_added ?? 0);
  }
  const dayRows = new Map((salesDaily.results ?? []).map((r) => [String(r.day), r]));
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(now - (13 - i) * 86_400_000).toISOString().slice(0, 10);
    const r = dayRows.get(day);
    return { day, orders: Number(r?.orders ?? 0), units: Number(r?.units ?? 0) };
  });

  const financial = canViewFinancials(c.env, c.get('user'));
  return c.json({
    success: true,
    totals: {
      total: totals?.total ?? 0,
      active: totals?.active ?? 0,
      draft: totals?.draft ?? 0,
      hidden: totals?.hidden ?? 0,
      out_of_stock: totals?.out_of_stock ?? 0,
      featured: totals?.featured ?? 0,
    },
    weekly: weeks,
    sales_30d: {
      units: sales30?.units ?? 0,
      orders: sales30?.orders ?? 0,
      ...(financial ? { gross_iqd: sales30?.gross ?? 0 } : {}),
    },
    sales_daily: days,
  });
});

/** The FULL canonical document + catalog placement — the edit payload. */
adminProductsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw notFound('Product not found');
  const doc = parseProductRow(row);
  return c.json({
    success: true,
    // §11: an assistant admin gets the same document with every financial
    // field removed on the SERVER — reading the raw response reveals nothing.
    product: projectForAdmin(c.env, c.get('user'), {
      ...projectAdmin(doc),
      catalog_ids: await catalogIdsFor(c.env.DB, id),
    }),
  });
});

/**
 * Create/update from a ProductDoc-ish body.
 *  - Slug stability: updates keep the stored slug unless allow_slug_change===true
 *    with an explicit slug; creates derive one from name_en (fallback name_ar).
 *  - Stale-edit: expected_updated_at mismatch → 409 with the current doc.
 *  - Persists ONLY the canonical PRODUCT_COLUMNS, so legacy v1 columns
 *    (brand text, categories, shipping_methods, stores, features, ...) are
 *    preserved, never overwritten.
 */
adminProductsRoutes.post('/', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') throw badRequest('JSON product document required');

  const existingRow =
    typeof body.id === 'string' && body.id
      ? await c.env.DB.prepare('SELECT * FROM products WHERE id = ?')
          .bind(body.id)
          .first<Record<string, unknown>>()
      : null;
  const prev = existingRow ? parseProductRow(existingRow) : null;

  const doc = validateProductDoc(body);

  // §11 is an authorization rule in BOTH directions: an assistant admin can
  // neither read cost nor write it. Rather than silently dropping the field
  // (which would let a stale panel wipe a real cost), the request is refused
  // when it actually tries to change one.
  if (!canViewFinancials(c.env, admin)) {
    const attempted = attemptedFinancialWrites(body, doc, prev);
    if (attempted.length) {
      throw forbidden(`You do not have access to product cost. Fields refused: ${attempted.join(', ')}`);
    }
    // Carry the stored cost forward untouched so an assistant's save cannot
    // blank a value they were never shown.
    carryStoredCostForward(doc, prev);
  }

  // Stale-edit protection: the editor echoes the updated_at it loaded.
  if (prev && typeof body.expected_updated_at === 'string' && body.expected_updated_at) {
    const currentUpdated = existingRow?.updated_at ? String(existingRow.updated_at) : '';
    if (body.expected_updated_at !== currentUpdated) {
      return c.json(
        {
          success: false,
          code: 'STALE_EDIT',
          error: 'This product was modified by someone else since you opened it. Review the current version below.',
          current: projectForAdmin(c.env, admin, { ...projectAdmin(prev), catalog_ids: await catalogIdsFor(c.env.DB, prev.id) }),
        },
        409
      );
    }
  }

  // Slug stability.
  if (prev) {
    if (body.allow_slug_change === true && typeof body.slug === 'string' && slugToken(body.slug)) {
      const want = slugToken(body.slug);
      if (want !== prev.slug) {
        const clash = await c.env.DB.prepare('SELECT id FROM products WHERE slug = ? AND id <> ?')
          .bind(want, doc.id)
          .first();
        if (clash) throw badRequest('slug: already used by another product', 'SLUG_TAKEN');
      }
      doc.slug = want;
    } else {
      doc.slug = prev.slug; // links stay stable no matter what the body says
    }
  } else {
    const base =
      slugToken(doc.name_en) || slugToken(doc.name_ar) || `product-${doc.id.replace(/^prd_/, '').slice(0, 8)}`;
    doc.slug = await uniqueSlugIn(c.env.DB, 'products', base, null);
  }

  // §3: English in, ar/ckb generated locally. This mutates the doc in place
  // BEFORE serialization, so the row that gets written already carries the
  // generated text and the storefront needs no runtime translation.
  const localized = localizeProductDoc(doc);
  applyTranslationTracking(doc, prev, localized.review_needed);

  const record = serializeDoc(doc);
  try {
    if (prev) {
      const cols = PRODUCT_COLUMNS.filter((k) => k !== 'id');
      await c.env.DB.prepare(
        `UPDATE products SET ${cols.map((k) => `${k} = ?`).join(', ')},
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      )
        .bind(...cols.map((k) => record[k] ?? null), doc.id)
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO products (${PRODUCT_COLUMNS.join(', ')})
         VALUES (${PRODUCT_COLUMNS.map(() => '?').join(', ')})`
      )
        .bind(...PRODUCT_COLUMNS.map((k) => record[k] ?? null))
        .run();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('slug')) throw badRequest('slug: already used by another product', 'SLUG_TAKEN');
    throw e;
  }

  if (Array.isArray(body.catalog_ids)) {
    await syncCatalogs(
      c.env.DB,
      doc.id,
      (body.catalog_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    );
  }

  // Price history (§6.8): every monetary change on an existing product —
  // base/PRO/compare-at at product, option and color level — is snapshotted
  // with the prior value, the actor and the change time. The product save
  // above already stands; a history-write failure is surfaced, never hidden.
  let priceHistoryWarning: string | null = null;
  if (prev) {
    try {
      await recordPriceHistory(c.env.DB, doc.id, admin.id, priceHistoryDeltas(prev, doc));
    } catch (e) {
      console.error('price history write failed for product', doc.id, e instanceof Error ? e.message : String(e));
      priceHistoryWarning =
        'The product saved, but its price-history rows could not be written — price protection for this change may need manual review.';
    }
  }

  // Store the English sources and their generated copies. A failure here must
  // not lose the product that already saved, so it degrades to a warning.
  let translationWarning: string | null = null;
  try {
    await syncProductTranslations(c.env.DB, doc.id, localized.fields);
  } catch (e) {
    console.error('translation write failed for product', doc.id, e instanceof Error ? e.message : String(e));
    translationWarning =
      'The product saved, but its Arabic/Kurdish copies could not be stored — re-save to retry.';
  }

  await audit(c.env.DB, admin.id, prev ? 'product_v2.update' : 'product_v2.create', doc.id, {
    name_en: doc.name_en,
    slug: doc.slug,
    status: doc.status,
    price_iqd: doc.price_iqd,
    content_rev: doc.content_rev,
  });

  const fresh = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?')
    .bind(doc.id)
    .first<Record<string, unknown>>();
  return c.json({
    success: true,
    created: !prev,
    product: projectForAdmin(c.env, admin, { ...projectAdmin(parseProductRow(fresh!)), catalog_ids: await catalogIdsFor(c.env.DB, doc.id) }),
    // Named honestly rather than hidden behind a green tick: these fields kept
    // their English text because the local engine could not translate them
    // safely (§3). The product is saved and live either way.
    translation_review_needed: localized.review_needed,
    ...(priceHistoryWarning ? { price_history_warning: priceHistoryWarning } : {}),
    ...(translationWarning ? { translation_warning: translationWarning } : {}),
  });
});

/**
 * Archive policy: products referenced by any order become status='hidden'
 * (order history must keep resolving); otherwise a hard delete, including
 * catalog placements.
 */
adminProductsRoutes.delete('/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT id, name_ar, name FROM products WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Product not found');

  const ref = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?')
    .bind(id)
    .first<{ n: number }>();
  const refs = ref?.n ?? 0;

  if (refs > 0) {
    await c.env.DB.prepare(
      "UPDATE products SET status = 'hidden', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    )
      .bind(id)
      .run();
    await audit(c.env.DB, admin.id, 'product_v2.archive', id, { order_item_refs: refs });
    return c.json({
      success: true,
      archived: true,
      deleted: false,
      reason: 'Referenced by past orders — hidden instead of deleted.',
    });
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM product_catalogs WHERE product_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id),
  ]);
  await audit(c.env.DB, admin.id, 'product_v2.delete', id, {});
  return c.json({ success: true, archived: false, deleted: true });
});

/** Replace this product's catalog placements with exactly catalog_ids. */
adminProductsRoutes.put('/:id/catalogs', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(id).first();
  if (!exists) throw notFound('Product not found');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!Array.isArray(body.catalog_ids)) throw badRequest('catalog_ids must be an array of catalog ids');
  const finalIds = await syncCatalogs(
    c.env.DB,
    id,
    (body.catalog_ids as unknown[]).filter((x): x is string => typeof x === 'string')
  );
  await audit(c.env.DB, admin.id, 'product_v2.catalogs', id, { catalog_ids: finalIds });
  return c.json({ success: true, catalog_ids: await catalogIdsFor(c.env.DB, id) });
});

/**
 * Admin price preview: full resolver output INCLUDING cost fields, plus a
 * USD preview from the configured exchange rate. `tier` may be supplied to
 * preview what a member of that tier would pay (server data only otherwise).
 */
adminProductsRoutes.post('/:id/quote', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw notFound('Product not found');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const doc = parseProductRow(row);
  const tier: Tier =
    body.tier === 'plus' || body.tier === 'pro' || body.tier === 'prime' ? body.tier : 'free';

  const settings = await getSettings(c.env.DB, ['proPricingPolicy', 'preorderTransportDefaults', 'exchangeRate']);
  const resolved = resolveUnitPrice({
    product: doc,
    optionId: typeof body.optionId === 'string' && body.optionId ? body.optionId : null,
    colorId: typeof body.colorId === 'string' && body.colorId ? body.colorId : null,
    transportMethod: typeof body.transportMethod === 'string' ? body.transportMethod : null,
    warrantyPlanId: typeof body.warrantyPlanId === 'string' && body.warrantyPlanId ? body.warrantyPlanId : null,
    tier,
    tierActive: tier !== 'free', // admin preview assumes the previewed tier is active
    proPolicy: proPolicyFrom(settings.proPricingPolicy),
    transportDefaults: transportDefaultsFrom(settings.preorderTransportDefaults),
  });

  const rate =
    typeof settings.exchangeRate === 'number' && Number.isFinite(settings.exchangeRate) && settings.exchangeRate > 0
      ? settings.exchangeRate
      : 1400;
  const toUsd = (iqd: number) => Math.round((iqd / rate) * 100) / 100;

  // §11: cost is financial data. An assistant admin gets the same quote with
  // it removed — the check is here, on the server, not in the panel.
  const quoteResolved = canViewFinancials(c.env, c.get('user'))
    ? resolved
    : { ...resolved, cost_iqd: undefined };
  return c.json({
    success: true,
    quote: {
      ...quoteResolved,
      usd_preview: {
        exchange_rate_iqd_per_usd: rate,
        applied_usd: toUsd(resolved.applied_iqd),
        unit_subtotal_usd: toUsd(resolved.unit_subtotal_iqd),
      },
    },
  });
});
