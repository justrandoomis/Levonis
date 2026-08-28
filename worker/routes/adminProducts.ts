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
import { requireAdmin, badRequest, notFound, int, str } from '../lib/http';
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

/** Arabic-source fields whose translations are tracked per language. */
const TRACKED_FIELDS = [
  { key: 'name', ar: 'name_ar', en: 'name_en', ckb: 'name_ckb' },
  { key: 'description', ar: 'description_ar', en: 'description_en', ckb: 'description_ckb' },
] as const;

/**
 * Translation bookkeeping (Arabic is the source language, no runtime AI):
 *  - Arabic text changed → bump content_rev once and mark en/ckb entries for
 *    those fields 'stale' (only when they were approved/imported — 'missing'
 *    stays missing, an already-stale entry keeps its original src_rev).
 *  - en/ckb text changed → that entry becomes 'imported' at the new
 *    content_rev (the translation now reflects the current source).
 *  - Editor-supplied meta (e.g. an explicit approval) is merged in first and
 *    survives whenever the text itself did not change in this save.
 */
function applyTranslationTracking(doc: ProductDoc, prev: ProductDoc | null): void {
  const bodyMeta: TranslationMeta = doc.translation_meta ?? {};
  const storedMeta: TranslationMeta = prev?.translation_meta ?? {};
  const meta: TranslationMeta = {};
  for (const key of new Set([...Object.keys(storedMeta), ...Object.keys(bodyMeta)])) {
    meta[key] = { ...(storedMeta[key] ?? {}), ...(bodyMeta[key] ?? {}) };
  }

  const text = (d: ProductDoc, field: string): string => (d as unknown as Record<string, string>)[field] ?? '';

  let contentRev = prev ? prev.content_rev : doc.content_rev || 1;

  if (prev) {
    const arChanged = TRACKED_FIELDS.filter((f) => text(doc, f.ar) !== text(prev, f.ar));
    if (arChanged.length) {
      contentRev += 1;
      for (const f of arChanged) {
        const entry = meta[f.key] ?? {};
        for (const lang of ['en', 'ckb'] as const) {
          const cur = entry[lang];
          if (cur && (cur.status === 'approved' || cur.status === 'imported')) {
            entry[lang] = { status: 'stale', src_rev: cur.src_rev };
          }
        }
        meta[f.key] = entry;
      }
    }
    for (const f of TRACKED_FIELDS) {
      const entry = meta[f.key] ?? {};
      if (text(doc, f.en) !== text(prev, f.en)) entry.en = { status: 'imported', src_rev: contentRev };
      if (text(doc, f.ckb) !== text(prev, f.ckb)) entry.ckb = { status: 'imported', src_rev: contentRev };
      meta[f.key] = entry;
    }
  } else {
    // Create: seed entries that the body did not supply.
    for (const f of TRACKED_FIELDS) {
      const entry = meta[f.key] ?? {};
      if (!entry.en) entry.en = { status: text(doc, f.en).trim() ? 'imported' : 'missing', src_rev: contentRev };
      if (!entry.ckb) entry.ckb = { status: text(doc, f.ckb).trim() ? 'imported' : 'missing', src_rev: contentRev };
      meta[f.key] = entry;
    }
  }

  doc.content_rev = contentRev;
  doc.translation_meta = meta;
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

/** Bounded listing projection — for tables/search only, NEVER for editing. */
adminProductsRoutes.get('/', async (c) => {
  const q = c.req.query();
  const search = str(q.search, 'search', { max: 100, required: false });
  const limit = int(q.limit, 'limit', { min: 1, max: 100, def: 30 });
  const offset = int(q.offset, 'offset', { min: 0, max: 100_000, def: 0 });

  let where = '';
  const params: unknown[] = [];
  if (search) {
    where = ' WHERE (name LIKE ? OR name_ar LIKE ? OR name_ku LIKE ? OR slug LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const [list, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, slug, status, name, name_ar, price_iqd, pro_price_iqd, stock,
              is_featured, brand_id, images, updated_at, doc_version
         FROM products${where}
        ORDER BY updated_at DESC LIMIT ? OFFSET ?`
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
        status: r.status,
        name_ar: r.name_ar,
        name_en: r.name,
        price_iqd: r.price_iqd,
        pro_price_iqd: (r.pro_price_iqd as number | null) ?? null,
        stock: (r.stock as number | null) ?? null,
        is_featured: !!r.is_featured,
        brand_id: (r.brand_id as string | null) ?? null,
        image: primary?.url ?? '',
        updated_at: r.updated_at,
        doc_version: r.doc_version,
      };
    }),
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
    product: { ...projectAdmin(doc), catalog_ids: await catalogIdsFor(c.env.DB, id) },
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

  // Stale-edit protection: the editor echoes the updated_at it loaded.
  if (prev && typeof body.expected_updated_at === 'string' && body.expected_updated_at) {
    const currentUpdated = existingRow?.updated_at ? String(existingRow.updated_at) : '';
    if (body.expected_updated_at !== currentUpdated) {
      return c.json(
        {
          success: false,
          code: 'STALE_EDIT',
          error: 'This product was modified by someone else since you opened it. Review the current version below.',
          current: { ...projectAdmin(prev), catalog_ids: await catalogIdsFor(c.env.DB, prev.id) },
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

  applyTranslationTracking(doc, prev);

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

  await audit(c.env.DB, admin.id, prev ? 'product_v2.update' : 'product_v2.create', doc.id, {
    name_ar: doc.name_ar,
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
    product: { ...projectAdmin(parseProductRow(fresh!)), catalog_ids: await catalogIdsFor(c.env.DB, doc.id) },
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
  const tier: Tier = body.tier === 'plus' || body.tier === 'pro' ? body.tier : 'free';

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

  return c.json({
    success: true,
    quote: {
      ...resolved, // includes cost_iqd — this endpoint is admin-only
      usd_preview: {
        exchange_rate_iqd_per_usd: rate,
        applied_usd: toUsd(resolved.applied_iqd),
        unit_subtotal_usd: toUsd(resolved.unit_subtotal_iqd),
      },
    },
  });
});
