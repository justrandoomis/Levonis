import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, str, int, oneOf } from '../lib/http';
import { newId, } from '../lib/crypto';
import { audit } from '../lib/audit';
import { FAMILIES, fieldsFor, isTemplateFamily } from '../lib/templateFamilies';

/**
 * Database-managed category tree, facets and brands — mandate §4 and §9:
 * "أنشئ taxonomy قابلة للإدارة من قاعدة البيانات، مع parent_id وslug
 * وsort_order وstatus وtemplate_family. لا تضع الشجرة hard-coded في الواجهة"
 * and "أضف الفلاتر/Facets بصورة منفصلة عن الأقسام".
 *
 * Two axes, deliberately never merged:
 *   catalogs  the TREE — one main section, one sub-section per product, plus
 *             any number of additional placements. Carries template_family,
 *             which decides the import template and the spec fields the form
 *             renders (§10).
 *   facets    the FILTERS — offers, material type, processing mode, FDM family.
 *             A product may carry many; they are not sections and never appear
 *             in the tree.
 *
 * Nothing in the worker matches on a slug or an id from the seed, so an admin
 * may rename, deactivate, re-parent or add anything here without a code change.
 */

export const adminTaxonomyRoutes = new Hono<AppContext>();
adminTaxonomyRoutes.use('*', requireAdmin);

const TEMPLATE_FAMILIES = ['devices', 'materials'] as const;
export type TemplateFamily = (typeof TEMPLATE_FAMILIES)[number];

interface CatalogRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sort: number;
  is_printer_catalog: number;
  active: number;
  template_family: string | null;
}

/** URL-safe slug from an English name; Arabic/Kurdish names fall back to the
 *  id so a slug is never empty or ambiguous. */
export function slugify(input: string, fallback: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

async function uniqueSlug(db: D1Database, table: string, base: string, exceptId: string | null): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const row = await db
      .prepare(`SELECT id FROM ${table} WHERE slug = ?${exceptId ? ' AND id <> ?' : ''}`)
      .bind(...(exceptId ? [candidate, exceptId] : [candidate]))
      .first();
    if (!row) return candidate;
  }
  throw badRequest('Could not derive a unique slug — choose a different name');
}

/**
 * The tree, as rows plus a resolved `effective_template_family` per node.
 * Resolution walks up to the nearest ancestor that sets one, so an admin only
 * has to declare the family at the top of a branch (§10).
 */
export function resolveTemplateFamilies(rows: CatalogRow[]): Map<string, TemplateFamily | null> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, TemplateFamily | null>();
  const resolve = (id: string, seen: Set<string>): TemplateFamily | null => {
    if (out.has(id)) return out.get(id) ?? null;
    if (seen.has(id)) return null; // a cycle cannot resolve; report nothing
    seen.add(id);
    const row = byId.get(id);
    if (!row) return null;
    const own = (TEMPLATE_FAMILIES as readonly string[]).includes(row.template_family ?? '')
      ? (row.template_family as TemplateFamily)
      : null;
    const value = own ?? (row.parent_id ? resolve(row.parent_id, seen) : null);
    out.set(id, value);
    return value;
  };
  for (const r of rows) resolve(r.id, new Set());
  return out;
}

/**
 * §10: the field definitions the product form renders and the import template
 * turns into columns. Served rather than duplicated in the frontend bundle, so
 * a form field and an import column can never drift apart.
 *
 * With ?category=<catalog id> the response is narrowed to that section's
 * resolved family and its add-on group — which is exactly "الأعمدة تتغير حسب
 * القسم والقالب، ولا تظهر أعمدة لا تخص المنتج".
 */
adminTaxonomyRoutes.get('/templates', async (c) => {
  const categoryId = str(c.req.query('category'), 'category', { max: 60, required: false });
  if (!categoryId) {
    return c.json({
      success: true,
      families: Object.values(FAMILIES).map((f) => ({
        id: f.id,
        label_ar: f.label_ar,
        label_en: f.label_en,
        groups: [f.common, ...Object.values(f.sections)],
      })),
    });
  }

  const { results } = await c.env.DB.prepare('SELECT * FROM catalogs').all<CatalogRow>();
  const node = results.find((r) => r.id === categoryId);
  if (!node) throw notFound('Section not found');
  const families = resolveTemplateFamilies(results);
  const family = families.get(categoryId) ?? null;

  // Slugs from this node up to the root, so a sub-section inherits its
  // parent's add-on fields as well as contributing its own.
  const byId = new Map(results.map((r) => [r.id, r]));
  const slugs: string[] = [];
  let cursor: CatalogRow | undefined = node;
  for (let i = 0; i < 20 && cursor; i++) {
    slugs.push(cursor.slug);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }

  return c.json({
    success: true,
    category_id: categoryId,
    template_family: family,
    groups: family && isTemplateFamily(family) ? fieldsFor(family, slugs) : [],
    section_slugs: slugs,
  });
});

// ------------------------------------------------------------------ catalogs

adminTaxonomyRoutes.get('/catalogs', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM catalogs ORDER BY sort, name_en, name_ar')
    .all<CatalogRow>();
  const families = resolveTemplateFamilies(results);
  const counts = await c.env.DB
    .prepare('SELECT category_id AS id, COUNT(*) AS n FROM products WHERE category_id IS NOT NULL GROUP BY category_id')
    .all<{ id: string; n: number }>();
  const countById = new Map(counts.results.map((r) => [r.id, r.n]));
  return c.json({
    success: true,
    catalogs: results.map((r) => ({
      ...r,
      is_printer_catalog: !!r.is_printer_catalog,
      active: !!r.active,
      effective_template_family: families.get(r.id) ?? null,
      product_count: countById.get(r.id) ?? 0,
    })),
  });
});

adminTaxonomyRoutes.post('/catalogs', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof body.id === 'string' && body.id ? body.id : newId('cat');
  const existing = await c.env.DB.prepare('SELECT * FROM catalogs WHERE id = ?').bind(id).first<CatalogRow>();

  const nameEn = str(body.name_en, 'name_en', { max: 120, required: !existing }) ?? existing?.name_en ?? '';
  const nameAr = str(body.name_ar, 'name_ar', { max: 120, required: false }) || existing?.name_ar || nameEn;
  const nameCkb = str(body.name_ckb, 'name_ckb', { max: 120, required: false }) || existing?.name_ckb || '';
  const parentId =
    body.parent_id === null || body.parent_id === ''
      ? null
      : typeof body.parent_id === 'string'
        ? body.parent_id
        : (existing?.parent_id ?? null);

  if (parentId) {
    const parent = await c.env.DB.prepare('SELECT id FROM catalogs WHERE id = ?').bind(parentId).first();
    if (!parent) throw badRequest('parent_id: no such section');
    if (parentId === id) throw badRequest('A section cannot be its own parent');
    // Walk up to reject a cycle rather than letting the tree become unreadable.
    let cursor: string | null = parentId;
    for (let i = 0; i < 50 && cursor; i++) {
      if (cursor === id) throw badRequest('That parent would create a loop in the tree');
      const row: { parent_id: string | null } | null = await c.env.DB
        .prepare('SELECT parent_id FROM catalogs WHERE id = ?')
        .bind(cursor)
        .first<{ parent_id: string | null }>();
      cursor = row?.parent_id ?? null;
    }
  }

  const family =
    body.template_family === null || body.template_family === ''
      ? null
      : body.template_family === undefined
        ? (existing?.template_family ?? null)
        : oneOf(body.template_family, 'template_family', TEMPLATE_FAMILIES);

  const sort = int(body.sort, 'sort', { min: 0, max: 100000, def: existing?.sort ?? 0 });
  const active = body.active === undefined ? (existing?.active ?? 1) : body.active ? 1 : 0;
  const isPrinter =
    body.is_printer_catalog === undefined
      ? (existing?.is_printer_catalog ?? 0)
      : body.is_printer_catalog
        ? 1
        : 0;

  const wantedSlug =
    typeof body.slug === 'string' && body.slug.trim()
      ? slugify(body.slug, id)
      : existing
        ? existing.slug
        : slugify(nameEn || nameAr, id);
  const slug = await uniqueSlug(c.env.DB, 'catalogs', wantedSlug, existing ? id : null);

  if (existing) {
    await c.env.DB
      .prepare(
        `UPDATE catalogs SET parent_id = ?, slug = ?, name_ar = ?, name_en = ?, name_ckb = ?,
                sort = ?, is_printer_catalog = ?, active = ?, template_family = ?
          WHERE id = ?`
      )
      .bind(parentId, slug, nameAr, nameEn, nameCkb, sort, isPrinter, active, family, id)
      .run();
  } else {
    await c.env.DB
      .prepare(
        `INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, parentId, slug, nameAr, nameEn, nameCkb, sort, isPrinter, active, family)
      .run();
  }

  await audit(c.env.DB, admin.id, existing ? 'catalog.update' : 'catalog.create', id, {
    slug,
    name_en: nameEn,
    template_family: family,
    active: !!active,
  });
  const fresh = await c.env.DB.prepare('SELECT * FROM catalogs WHERE id = ?').bind(id).first<CatalogRow>();
  return c.json({ success: true, catalog: fresh, created: !existing });
});

/**
 * Deactivate, never destroy. A section with products or children still has
 * meaning in order history and in existing links, so the endpoint refuses a
 * hard delete and says exactly what is in the way.
 */
adminTaxonomyRoutes.delete('/catalogs/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM catalogs WHERE id = ?').bind(id).first<CatalogRow>();
  if (!row) throw notFound('Section not found');

  const [children, products, placements] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM catalogs WHERE parent_id = ?').bind(id).first<{ n: number }>(),
    c.env.DB
      .prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ? OR sub_category_id = ?')
      .bind(id, id)
      .first<{ n: number }>(),
    c.env.DB
      .prepare('SELECT COUNT(*) AS n FROM product_catalogs WHERE catalog_id = ?')
      .bind(id)
      .first<{ n: number }>(),
  ]);
  const inUse = (children?.n ?? 0) + (products?.n ?? 0) + (placements?.n ?? 0);
  if (inUse > 0) {
    await c.env.DB.prepare('UPDATE catalogs SET active = 0 WHERE id = ?').bind(id).run();
    await audit(c.env.DB, admin.id, 'catalog.deactivate', id, {
      children: children?.n ?? 0,
      products: products?.n ?? 0,
      placements: placements?.n ?? 0,
    });
    return c.json({
      success: true,
      deleted: false,
      deactivated: true,
      reason: 'IN_USE',
      children: children?.n ?? 0,
      products: products?.n ?? 0,
      placements: placements?.n ?? 0,
    });
  }
  await c.env.DB.prepare('DELETE FROM catalogs WHERE id = ?').bind(id).run();
  await audit(c.env.DB, admin.id, 'catalog.delete', id, { slug: row.slug });
  return c.json({ success: true, deleted: true, deactivated: false });
});

// -------------------------------------------------------------------- facets

interface FacetRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  kind: string;
  sort: number;
  active: number;
}

adminTaxonomyRoutes.get('/facets', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM facets ORDER BY kind, sort, name_en')
    .all<FacetRow>();
  const counts = await c.env.DB
    .prepare('SELECT facet_id AS id, COUNT(*) AS n FROM product_facets GROUP BY facet_id')
    .all<{ id: string; n: number }>();
  const countById = new Map(counts.results.map((r) => [r.id, r.n]));
  return c.json({
    success: true,
    facets: results.map((f) => ({ ...f, active: !!f.active, product_count: countById.get(f.id) ?? 0 })),
  });
});

adminTaxonomyRoutes.post('/facets', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof body.id === 'string' && body.id ? body.id : newId('fct');
  const existing = await c.env.DB.prepare('SELECT * FROM facets WHERE id = ?').bind(id).first<FacetRow>();

  const nameEn = str(body.name_en, 'name_en', { max: 120, required: !existing }) ?? existing?.name_en ?? '';
  const nameAr = str(body.name_ar, 'name_ar', { max: 120, required: false }) || existing?.name_ar || '';
  const nameCkb = str(body.name_ckb, 'name_ckb', { max: 120, required: false }) || existing?.name_ckb || '';
  // `kind` is an open grouping axis, not a fixed enum: the seed ships offer /
  // material_type / processing_mode / fdm_material, and an admin may add more.
  const kind = str(body.kind, 'kind', { max: 40, required: false }) || existing?.kind || 'tag';
  const sort = int(body.sort, 'sort', { min: 0, max: 100000, def: existing?.sort ?? 0 });
  const active = body.active === undefined ? (existing?.active ?? 1) : body.active ? 1 : 0;
  const parentId =
    body.parent_id === null || body.parent_id === ''
      ? null
      : typeof body.parent_id === 'string'
        ? body.parent_id
        : (existing?.parent_id ?? null);
  if (parentId === id) throw badRequest('A filter cannot be its own parent');

  const wantedSlug =
    typeof body.slug === 'string' && body.slug.trim()
      ? slugify(body.slug, id)
      : existing
        ? existing.slug
        : slugify(nameEn, id);
  const slug = await uniqueSlug(c.env.DB, 'facets', wantedSlug, existing ? id : null);

  if (existing) {
    await c.env.DB
      .prepare(
        `UPDATE facets SET parent_id = ?, slug = ?, name_en = ?, name_ar = ?, name_ckb = ?, kind = ?, sort = ?, active = ?
          WHERE id = ?`
      )
      .bind(parentId, slug, nameEn, nameAr, nameCkb, kind, sort, active, id)
      .run();
  } else {
    await c.env.DB
      .prepare(
        `INSERT INTO facets (id, parent_id, slug, name_en, name_ar, name_ckb, kind, sort, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, parentId, slug, nameEn, nameAr, nameCkb, kind, sort, active)
      .run();
  }
  await audit(c.env.DB, admin.id, existing ? 'facet.update' : 'facet.create', id, { slug, kind, name_en: nameEn });
  const fresh = await c.env.DB.prepare('SELECT * FROM facets WHERE id = ?').bind(id).first<FacetRow>();
  return c.json({ success: true, facet: fresh, created: !existing });
});

adminTaxonomyRoutes.delete('/facets/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM facets WHERE id = ?').bind(id).first<FacetRow>();
  if (!row) throw notFound('Filter not found');
  const used = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM product_facets WHERE facet_id = ?')
    .bind(id)
    .first<{ n: number }>();
  if ((used?.n ?? 0) > 0) {
    await c.env.DB.prepare('UPDATE facets SET active = 0 WHERE id = ?').bind(id).run();
    await audit(c.env.DB, admin.id, 'facet.deactivate', id, { products: used?.n ?? 0 });
    return c.json({ success: true, deleted: false, deactivated: true, products: used?.n ?? 0 });
  }
  await c.env.DB.prepare('DELETE FROM facets WHERE id = ?').bind(id).run();
  await audit(c.env.DB, admin.id, 'facet.delete', id, { slug: row.slug });
  return c.json({ success: true, deleted: true, deactivated: false });
});

// -------------------------------------------------------------------- brands

interface BrandRow {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  active: number;
}

adminTaxonomyRoutes.get('/brands', async (c) => {
  const q = str(c.req.query('search'), 'search', { max: 60, required: false });
  const sql = q
    ? 'SELECT * FROM brands WHERE name_en LIKE ? OR name_ar LIKE ? OR slug LIKE ? ORDER BY name_en LIMIT 200'
    : 'SELECT * FROM brands ORDER BY name_en LIMIT 500';
  const stmt = q
    ? c.env.DB.prepare(sql).bind(`%${q}%`, `%${q}%`, `%${q}%`)
    : c.env.DB.prepare(sql);
  const { results } = await stmt.all<BrandRow>();
  const counts = await c.env.DB
    .prepare('SELECT brand_id AS id, COUNT(*) AS n FROM products WHERE brand_id IS NOT NULL GROUP BY brand_id')
    .all<{ id: string; n: number }>();
  const countById = new Map(counts.results.map((r) => [r.id, r.n]));
  return c.json({
    success: true,
    brands: results.map((b) => ({ ...b, active: !!b.active, product_count: countById.get(b.id) ?? 0 })),
  });
});

adminTaxonomyRoutes.post('/brands', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof body.id === 'string' && body.id ? body.id : newId('brd');
  const existing = await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(id).first<BrandRow>();

  const nameEn = str(body.name_en, 'name_en', { max: 120, required: !existing }) ?? existing?.name_en ?? '';
  const nameAr = str(body.name_ar, 'name_ar', { max: 120, required: false }) || existing?.name_ar || nameEn;
  const nameCkb = str(body.name_ckb, 'name_ckb', { max: 120, required: false }) || existing?.name_ckb || '';
  const active = body.active === undefined ? (existing?.active ?? 1) : body.active ? 1 : 0;
  const wantedSlug =
    typeof body.slug === 'string' && body.slug.trim()
      ? slugify(body.slug, id)
      : existing
        ? existing.slug
        : slugify(nameEn || nameAr, id);
  const slug = await uniqueSlug(c.env.DB, 'brands', wantedSlug, existing ? id : null);

  if (existing) {
    await c.env.DB
      .prepare('UPDATE brands SET slug = ?, name_ar = ?, name_en = ?, name_ckb = ?, active = ? WHERE id = ?')
      .bind(slug, nameAr, nameEn, nameCkb, active, id)
      .run();
  } else {
    await c.env.DB
      .prepare('INSERT INTO brands (id, slug, name_ar, name_en, name_ckb, active) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, slug, nameAr, nameEn, nameCkb, active)
      .run();
  }
  await audit(c.env.DB, admin.id, existing ? 'brand.update' : 'brand.create', id, { slug, name_en: nameEn });
  const fresh = await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(id).first<BrandRow>();
  return c.json({ success: true, brand: fresh, created: !existing });
});
