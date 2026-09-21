import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, str, int, oneOf } from '../lib/http';
import { newId, } from '../lib/crypto';
import { audit } from '../lib/audit';
import {
  FAMILIES,
  groupsForSection,
  isTemplateFamily,
  narrowGroups,
  productTypeForBranch,
  type SectionRef,
} from '../lib/templateFamilies';
import { findHashtagRow, hashtagKey, hashtagUsage, normalizeHashtag, rewriteHashtag, type HashtagUsage } from '../lib/hashtags';
import { catalogTreeWithCounts } from '../lib/catalogMembership';
import { putMediaObject } from '../lib/mediaStorage';
import { rasterDimensions, validRasterDimensions } from '../lib/imageMetadata';
import { sniff } from './uploads';
import {
  SITE_MEDIA_MAX_BYTES,
  SITE_MEDIA_MIME,
  catalogImageUrl,
  mintCatalogImageObject,
  siteMediaKey,
} from '../lib/siteMedia';
import { normalizeText } from '../lib/search/normalize';
import { degradeIfSchemaMissing } from '../lib/membershipBenefits';

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

export interface CatalogRow {
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
  /**
   * The FULL media key of the cover an admin set for this section, or ''.
   * Migration 0100; see worker/lib/siteMedia.ts for why it is a whole key
   * rather than the bare object name the brand and service slots store.
   */
  image_key: string;
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

/**
 * The English name, which every row must carry: absent on an update keeps the
 * stored one, absent on a create is refused, and an explicit empty string is
 * refused either way rather than quietly wiping the name a whole admin screen
 * is sorted by.
 */
function requiredName(value: unknown, existing: string | undefined): string {
  if (value === undefined) {
    if (existing === undefined) throw badRequest('name_en is required');
    return existing;
  }
  return str(value, 'name_en', { min: 1, max: 120 });
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

  // This node up to the root — LEAF FIRST, so «طابعات FDM» is read before
  // «الطابعات» and the technology narrowing sees the specific section before
  // the general one. Ids travel with the slugs: 0018's slugs have documented
  // collision fallbacks and an admin may rename one, but the id never moves.
  const byId = new Map(results.map((r) => [r.id, r]));
  const branch: SectionRef[] = [];
  let cursor: CatalogRow | undefined = node;
  for (let i = 0; i < 20 && cursor; i++) {
    branch.push({ id: cursor.id, slug: cursor.slug });
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }

  return c.json({
    success: true,
    category_id: categoryId,
    template_family: family,
    product_type: family && isTemplateFamily(family) ? productTypeForBranch(family, branch) : null,
    groups: family && isTemplateFamily(family) ? groupsForSection(family, branch) : [],
    section_slugs: branch.map((b) => b.slug),
    section_ids: branch.map((b) => b.id),
  });
});

// ------------------------------------------------------------------ catalogs

adminTaxonomyRoutes.get('/catalogs', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM catalogs ORDER BY sort, name_en, name_ar')
    .all<CatalogRow>();
  const families = resolveTemplateFamilies(results);
  /**
   * THE SAME NUMBER THE STOREFRONT SHOWS — that was the whole confusion.
   *
   * This counted `SELECT category_id, COUNT(*) FROM products GROUP BY
   * category_id`: the MAIN section column only. So «الطابعات» read 3 while
   * every sub-section under it — «طابعات FDM», «طابعات Resin» — read 0 even
   * though that is where the products are actually filed, and the home page,
   * counting through a third definition again, showed nothing at all.
   *
   * One relation, one roll-up, used by both doors: worker/lib/catalogMembership.ts.
   * A count here is now descendant-inclusive for the same reason it is on the
   * storefront — the owner asking "how many are in Printers" means everything
   * under Printers, not the rows that happen to stop at that level.
   */
  const countById = new Map(
    (await catalogTreeWithCounts(c.env.DB)).map((r) => [r.id, r.product_count] as const)
  );

  // The branch slugs, leaf-first, so a section resolves to the product type
  // its template is built for — the panel and the form both need to say
  // «هذا القسم طابعة» without a second round trip.
  const byId = new Map(results.map((r) => [r.id, r]));
  const branch = (id: string): SectionRef[] => {
    const out: SectionRef[] = [];
    let node = byId.get(id);
    for (let hop = 0; node && hop < 12; hop++) {
      out.push({ id: node.id, slug: node.slug });
      node = node.parent_id ? byId.get(node.parent_id) : undefined;
    }
    return out;
  };

  return c.json({
    success: true,
    catalogs: results.map((r) => {
      const family = families.get(r.id) ?? null;
      const type = family ? productTypeForBranch(family, branch(r.id)) : null;
      /**
       * WHAT THIS SECTION'S TEMPLATE ACTUALLY CONTAINS — narrowed, not the
       * type's union.
       *
       * The import panel showed one number, «٤٧ حقل مواصفات», taken from the
       * product TYPE. It never moved when a section was chosen, so the owner
       * picked «طابعات Resin», saw the same 47, downloaded a file with the
       * same name as the FDM one, and reported that the template does not
       * change. It does — 47 fields become 39 for FDM and 30 for Resin, and
       * the two sets differ by 25 fields — but nothing on the screen said so.
       *
       * The groups travel with the count because the count alone is still a
       * number to be taken on trust: «خاص بطابعات Resin» under the select is
       * the thing that makes the narrowing visible rather than merely true.
       * Both are computed from the same `narrowGroups` the download uses, so
       * the panel cannot promise a shape the file does not have.
       */
      const groups = type ? narrowGroups(type, branch(r.id)) : [];
      return {
        ...r,
        is_printer_catalog: !!r.is_printer_catalog,
        active: !!r.active,
        // The panel gets the URL, not the key, for the same reason the
        // storefront does: one place turns a stored key into something that
        // can be put in an `src`, and it re-validates while it is there.
        image_url: catalogImageUrl(r.image_key),
        effective_template_family: family,
        product_type: type,
        product_count: countById.get(r.id) ?? 0,
        spec_columns: groups.reduce((n, g) => n + g.fields.length, 0),
        spec_groups: groups.map((g) => ({ id: g.id, label_ar: g.label_ar, label_en: g.label_en, fields: g.fields.length })),
      };
    }),
  });
});

adminTaxonomyRoutes.post('/catalogs', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof body.id === 'string' && body.id ? body.id : newId('cat');
  const existing = await c.env.DB.prepare('SELECT * FROM catalogs WHERE id = ?').bind(id).first<CatalogRow>();

  // `str` returns '' for an absent field, so a partial update (an active
  // toggle, a re-parent) must fall back with `||`, never `??` — or the name
  // would be wiped by every edit that does not repeat it.
  // ABSENT and EMPTY are different: a partial update (an active toggle, a
  // re-parent) sends neither name and must keep both, while an admin who
  // clears the Arabic field means to clear it. `str()` cannot tell the two
  // apart — it answers '' for both — so the check is on `body` itself.
  const nameEn = requiredName(body.name_en, existing?.name_en);
  const nameAr =
    body.name_ar === undefined
      ? (existing?.name_ar ?? nameEn)
      : str(body.name_ar, 'name_ar', { max: 120, required: false });
  const nameCkb =
    body.name_ckb === undefined
      ? (existing?.name_ckb ?? '')
      : str(body.name_ckb, 'name_ckb', { max: 120, required: false });
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

// --------------------------------------------------------- a section's cover
//
// THE PICTURE A SUB-SECTION SHOWS ON THE HOME PAGE.
//
// Until now `CategoryBoard` BORROWED one — the first photo among the products
// the first screen happened to have fetched, filed under that section. Nobody
// chose it: which of eight filaments represented «خيوط PLA» depended on query
// order, and a section whose products were not among the thirty on screen drew
// its monogram no matter what artwork existed. This is the door that lets the
// owner decide.
//
// WHY NOT `/api/admin/site-media/:slot`. That route's slots are a FIXED LIST
// IN CODE (worker/lib/siteMedia.ts) — one per brand mark, one per service
// card — and `findSiteMediaSlot` refuses anything not in it. Sections are
// rows: the owner creates and deletes them from this very screen, so there is
// no slot to name and the pointer belongs on the row. The rules are the same
// though — WebP only, two megabytes, `UiUx/MainPage/`, a new object name every
// time — and they are shared rather than re-stated: the constants and the mint
// come from that module.

const CATALOG_IMAGE_MB = Math.round(SITE_MEDIA_MAX_BYTES / 1024 / 1024);

/** The row, or a 404 — both routes below start the same way. */
async function catalogOr404(db: D1Database, id: string): Promise<CatalogRow> {
  const row = await db.prepare('SELECT * FROM catalogs WHERE id = ?').bind(id).first<CatalogRow>();
  if (!row) throw notFound('Section not found');
  return row;
}

adminTaxonomyRoutes.post('/catalogs/:id/image', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await catalogOr404(c.env.DB, id);

  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');
  if (file.size > SITE_MEDIA_MAX_BYTES) {
    throw badRequest(
      `الصورة أكبر من الحد (${CATALOG_IMAGE_MB} ميغابايت) / Image is larger than ${CATALOG_IMAGE_MB} MB`,
      'SITE_MEDIA_TOO_LARGE'
    );
  }

  // MAGIC BYTES, NOT THE FILENAME AND NOT THE BROWSER'S CONTENT-TYPE. The
  // owner's rule is that site artwork is WebP; a `.webp` extension on a PNG
  // would satisfy a name check and then be served with the wrong type for a
  // year under an `immutable` header.
  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind || kind.mime !== SITE_MEDIA_MIME) {
    throw badRequest(
      'صورة القسم يجب أن تكون WebP فقط / A section image must be a WebP',
      'SITE_MEDIA_NOT_WEBP'
    );
  }
  const dimensions = rasterDimensions(buf, kind.mime);
  if (!validRasterDimensions(dimensions)) {
    throw badRequest('The image has invalid or unsupported dimensions', 'BAD_IMAGE_DIMENSIONS');
  }

  const object = mintCatalogImageObject(id, newId());
  const key = siteMediaKey(object);
  // The R2 write happens BEFORE the pointer moves. The other order would let a
  // failed upload leave `image_key` naming an object that was never stored —
  // a broken picture on the first screen, which is worse than the monogram
  // this replaces. A write that succeeds and is then orphaned by a D1 failure
  // costs two kilobytes the sweeper can reclaim.
  await putMediaObject(
    c.env,
    {
      key,
      visibility: 'public',
      domain: 'ui',
      mime: kind.mime,
      bytes: buf.byteLength,
      ownerId: admin.id,
      entityId: id,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      originalName: String(form.get('originalName') || file.name),
    },
    buf,
    { httpMetadata: { contentType: kind.mime, cacheControl: 'public, max-age=31536000, immutable' } }
  );

  const previous = String(row.image_key ?? '');
  await c.env.DB.prepare('UPDATE catalogs SET image_key = ? WHERE id = ?').bind(key, id).run();
  await audit(c.env.DB, admin.id, 'catalog.image_set', id, { key, previous, bytes: buf.byteLength });

  return c.json({ success: true, image_key: key, image_url: catalogImageUrl(key) });
});

/**
 * Take the picture off the section. The OBJECT is left in R2 — the media
 * sweeper owns deletion, and it is the only thing that can see whether some
 * other row still points at the same bytes.
 */
adminTaxonomyRoutes.delete('/catalogs/:id/image', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await catalogOr404(c.env.DB, id);
  const previous = String(row.image_key ?? '');
  await c.env.DB.prepare("UPDATE catalogs SET image_key = '' WHERE id = ?").bind(id).run();
  await audit(c.env.DB, admin.id, 'catalog.image_cleared', id, { previous });
  return c.json({ success: true, image_key: '', image_url: '' });
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

  // `str` returns '' for an absent field, so a partial update (an active
  // toggle, a re-parent) must fall back with `||`, never `??` — or the name
  // would be wiped by every edit that does not repeat it.
  const nameEn = requiredName(body.name_en, existing?.name_en);
  const nameAr =
    body.name_ar === undefined
      ? (existing?.name_ar ?? '')
      : str(body.name_ar, 'name_ar', { max: 120, required: false });
  const nameCkb =
    body.name_ckb === undefined
      ? (existing?.name_ckb ?? '')
      : str(body.name_ckb, 'name_ckb', { max: 120, required: false });
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
  const like = likePattern(q);
  const sql = like
    ? `SELECT * FROM brands WHERE ${sqlLikeClause(['name_en', 'name_ar', 'slug'])} ORDER BY name_en LIMIT 200`
    : 'SELECT * FROM brands ORDER BY name_en LIMIT 500';
  const stmt = like ? c.env.DB.prepare(sql).bind(like, like, like) : c.env.DB.prepare(sql);
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

  // `str` returns '' for an absent field, so a partial update (an active
  // toggle, a re-parent) must fall back with `||`, never `??` — or the name
  // would be wiped by every edit that does not repeat it.
  // ABSENT and EMPTY are different: a partial update (an active toggle, a
  // re-parent) sends neither name and must keep both, while an admin who
  // clears the Arabic field means to clear it. `str()` cannot tell the two
  // apart — it answers '' for both — so the check is on `body` itself.
  const nameEn = requiredName(body.name_en, existing?.name_en);
  const nameAr =
    body.name_ar === undefined
      ? (existing?.name_ar ?? nameEn)
      : str(body.name_ar, 'name_ar', { max: 120, required: false });
  const nameCkb =
    body.name_ckb === undefined
      ? (existing?.name_ckb ?? '')
      : str(body.name_ckb, 'name_ckb', { max: 120, required: false });
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

/**
 * Deactivate when in use, delete when not — the same contract as sections
 * and filters. A brand that products still point at keeps its row so those
 * products (and their order history) never lose their brand.
 */
adminTaxonomyRoutes.delete('/brands/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(id).first<BrandRow>();
  if (!row) throw notFound('Brand not found');
  const used = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM products WHERE brand_id = ?')
    .bind(id)
    .first<{ n: number }>();
  if ((used?.n ?? 0) > 0) {
    await c.env.DB.prepare('UPDATE brands SET active = 0 WHERE id = ?').bind(id).run();
    await audit(c.env.DB, admin.id, 'brand.deactivate', id, { products: used?.n ?? 0 });
    return c.json({ success: true, deleted: false, deactivated: true, reason: 'IN_USE', products: used?.n ?? 0 });
  }
  await c.env.DB.prepare('DELETE FROM brands WHERE id = ?').bind(id).run();
  await audit(c.env.DB, admin.id, 'brand.delete', id, { slug: row.slug });
  return c.json({ success: true, deleted: true, deactivated: false });
});

// ------------------------------------------------------------------ hashtags
//
// The managed vocabulary (migration 0041) merged with what products actually
// carry. A tag that exists on products but not in the table is listed as
// `managed: false` so the admin can adopt it, rename it or strip it — nothing
// an admin can see is outside their reach.

interface HashtagRow {
  id: string;
  tag: string;
  name_ar: string;
  sort: number;
  active: number;
}

async function loadHashtagRows(db: D1Database): Promise<HashtagRow[]> {
  try {
    const { results } = await db.prepare('SELECT * FROM hashtags ORDER BY sort, tag').all<HashtagRow>();
    return results;
  } catch (e) {
    // Before migration 0041 has run there is no table; the admin still sees
    // the products' tags rather than an error page.
    console.error('hashtags table unavailable', e instanceof Error ? e.message : String(e));
    return [];
  }
}

adminTaxonomyRoutes.get('/hashtags', async (c) => {
  // Both the counts and the unlisted rows come from reading every tagged
  // product. The product form only needs a list to suggest from, so it asks
  // with ?counts=0 and that scan never runs for it.
  const withCounts = c.req.query('counts') !== '0';
  const [rows, usage] = await Promise.all([
    loadHashtagRows(c.env.DB),
    withCounts ? hashtagUsage(c.env.DB) : Promise.resolve(new Map<string, HashtagUsage>()),
  ]);
  const seen = new Set<string>();
  const out = rows.map((r) => {
    const key = hashtagKey(r.tag);
    seen.add(key);
    return {
      id: r.id,
      tag: r.tag,
      name_ar: r.name_ar,
      sort: r.sort,
      active: !!r.active,
      managed: true,
      product_count: usage.get(key)?.count ?? 0,
    };
  });
  for (const [key, u] of usage) {
    if (seen.has(key)) continue;
    out.push({ id: '', tag: u.spelling, name_ar: '', sort: 0, active: true, managed: false, product_count: u.count });
  }
  return c.json({ success: true, hashtags: out });
});

adminTaxonomyRoutes.post('/hashtags', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const byId =
    typeof body.id === 'string' && body.id
      ? await c.env.DB.prepare('SELECT * FROM hashtags WHERE id = ?').bind(body.id).first<HashtagRow>()
      : null;
  if (typeof body.id === 'string' && body.id && !byId) throw notFound('Hashtag not found');

  const tag = body.tag === undefined && byId ? byId.tag : normalizeHashtag(body.tag);
  if (!tag) throw badRequest('tag is required');
  const key = hashtagKey(tag);

  // Another row already spelling this tag: on a create that row is what the
  // admin meant (adopting an unmanaged tag lands here), on a rename it is a
  // real clash. Matched with the module's own folding, not with the table's
  // NOCASE collation — that one only folds ASCII, so `Çap` would not see
  // `çap` and the rename would strand it.
  const clash = await findHashtagRow<HashtagRow>(c.env.DB, tag, byId?.id ?? '');
  if (clash && byId) throw badRequest(`"${tag}" is already a hashtag`, 'HASHTAG_TAKEN');
  const existing = byId ?? clash;
  // Adopting or re-adding a tag that exists in another case keeps the stored
  // spelling; only an edit BY ID (a rename) changes how a tag is written.
  const spelling = byId ? tag : (clash?.tag ?? tag);

  const nameAr = str(body.name_ar, 'name_ar', { max: 120, required: false }) || existing?.name_ar || '';
  const sort = int(body.sort, 'sort', { min: 0, max: 100000, def: existing?.sort ?? 0 });
  // Adding or adopting a tag by name means "offer this tag", so it lands
  // active even when a row for it was deactivated earlier; only an edit BY ID
  // keeps the stored state when the caller says nothing about it.
  const active = body.active === undefined ? (byId ? (existing?.active ?? 1) : 1) : body.active ? 1 : 0;

  let productsUpdated = 0;
  if (existing) {
    // The PRODUCTS are rewritten first and the vocabulary row after them: a
    // rename that dies halfway then still has its old spelling in the table,
    // so the admin can simply run it again. The other order renames the row,
    // strands the remaining products under a tag no longer in the list, and
    // leaves nothing to retry with.
    if (existing.tag !== spelling) productsUpdated = await rewriteHashtag(c.env.DB, existing.tag, spelling);
    await c.env.DB
      .prepare('UPDATE hashtags SET tag = ?, name_ar = ?, sort = ?, active = ? WHERE id = ?')
      .bind(spelling, nameAr, sort, active, existing.id)
      .run();
  } else {
    await c.env.DB
      .prepare('INSERT INTO hashtags (id, tag, name_ar, sort, active) VALUES (?, ?, ?, ?, ?)')
      .bind(newId('tag'), spelling, nameAr, sort, active)
      .run();
  }
  const fresh = await findHashtagRow<HashtagRow>(c.env.DB, spelling);
  await audit(c.env.DB, admin.id, existing ? 'hashtag.update' : 'hashtag.create', fresh?.id ?? key, {
    tag: spelling,
    previous: existing?.tag ?? null,
    products_updated: productsUpdated,
  });
  return c.json({
    success: true,
    hashtag: fresh ? { ...fresh, active: !!fresh.active } : null,
    created: !existing,
    products_updated: productsUpdated,
  });
});

/** Removes a tag from every product that carries it — managed or not. */
adminTaxonomyRoutes.post('/hashtags/strip', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tag = normalizeHashtag(body.tag);
  if (!tag) throw badRequest('tag is required');
  const n = await rewriteHashtag(c.env.DB, tag, null);
  await audit(c.env.DB, admin.id, 'hashtag.strip', hashtagKey(tag), { tag, products_updated: n });
  return c.json({ success: true, products_updated: n });
});

/** Deletes the vocabulary row; with ?strip=1 the tag leaves the products too. */
adminTaxonomyRoutes.delete('/hashtags/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const strip = c.req.query('strip') === '1';
  const row = await c.env.DB.prepare('SELECT * FROM hashtags WHERE id = ?').bind(id).first<HashtagRow>();
  if (!row) throw notFound('Hashtag not found');
  await c.env.DB.prepare('DELETE FROM hashtags WHERE id = ?').bind(id).run();
  const productsUpdated = strip ? await rewriteHashtag(c.env.DB, row.tag, null) : 0;
  await audit(c.env.DB, admin.id, 'hashtag.delete', id, { tag: row.tag, stripped: strip, products_updated: productsUpdated });
  return c.json({ success: true, deleted: true, products_updated: productsUpdated });
});

// ------------------------------------------------------------ search vocabulary

/**
 * THE WORDS CUSTOMERS SEARCH WITH, WHICH ONLY THE OWNER FINDS OUT.
 *
 * `worker/lib/search/vocabulary.ts` seeds the dictionary that makes «طابعة»
 * mean "printer" and «بمبو» mean "bambu". It covers this shop's own catalogue
 * and the owner's own examples, and it will be wrong the first time a customer
 * searches for something in a way nobody predicted — which for a shop in Iraq
 * selling foreign hardware is constantly.
 *
 * So the dictionary is a TABLE and this is its door. A word the owner adds
 * here works on the next search, with no deploy. Rows they add are marked
 * `owner_added`, and the migration's re-seed is `INSERT OR IGNORE`, so their
 * meaning is never reset to the seed's.
 *
 * BOTH SIDES ARE STORED NORMALISED — folded hamza and ta marbuta, no
 * diacritics. That is what lets one row cover «طابعة» and «طابعه» at once, and
 * it is why the owner does not have to think about spelling variants at all.
 */
adminTaxonomyRoutes.get('/search-vocabulary', async (c) => {
  // A Worker can be live before migration 0089 applies. A missing TABLE holds
  // no rows, so an empty dictionary is the literal truth — the sanctioned
  // degrade of worker/lib/membershipBenefits.ts, and far better than a screen
  // that 500s at an owner who only wanted to look.
  const results = await degradeIfSchemaMissing(
    'search vocabulary (migration 0089)',
    async () =>
      (
        await c.env.DB
          .prepare('SELECT term, canonical, owner_added, created_at FROM search_synonyms ORDER BY owner_added DESC, canonical, term LIMIT 2000')
          .all<{ term: string; canonical: string; owner_added: number }>()
      ).results ?? [],
    [] as Array<{ term: string; canonical: string; owner_added: number }>
  );
  return c.json({
    success: true,
    synonyms: results.map((r) => ({ ...r, owner_added: !!r.owner_added })),
  });
});

adminTaxonomyRoutes.post('/search-vocabulary', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const term = normalizeText(str(body.term, 'term', { min: 2, max: 60 }));
  const canonical = normalizeText(str(body.canonical, 'canonical', { min: 2, max: 60 }));
  if (!term || !canonical) throw badRequest('term and canonical must contain letters or digits');
  if (term === canonical) throw badRequest('a word cannot be a synonym of itself');
  /**
   * REPLACE, not insert-or-ignore: this door exists so the owner can CORRECT a
   * meaning, including one the seed got wrong. `owner_added = 1` is what stops
   * the next re-seed overwriting their correction.
   */
  await c.env.DB
    .prepare('INSERT OR REPLACE INTO search_synonyms (term, canonical, owner_added) VALUES (?, ?, 1)')
    .bind(term, canonical)
    .run();
  await audit(c.env.DB, admin.id, 'search.vocabulary.set', term, { term, canonical });
  return c.json({ success: true, term, canonical });
});

adminTaxonomyRoutes.delete('/search-vocabulary/:term', async (c) => {
  const admin = c.get('user')!;
  const term = normalizeText(c.req.param('term'));
  if (!term) throw badRequest('term is required');
  const res = await c.env.DB.prepare('DELETE FROM search_synonyms WHERE term = ?').bind(term).run();
  await audit(c.env.DB, admin.id, 'search.vocabulary.delete', term, { term });
  return c.json({ success: true, deleted: (res.meta.changes ?? 0) > 0 });
});
