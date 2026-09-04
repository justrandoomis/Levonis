/**
 * The Devices / Materials import pipeline — mandate §10, mounted at
 * /api/admin/import.
 *
 *   GET  /template?category=<id>&format=csv|zip[&example=0]
 *                              a working download for the chosen section
 *   GET  /export?category=<id>|ids=<a,b>&format=csv|zip
 *                              the same shape, filled with real products
 *   POST /preview              parses and reports; writes NO database row
 *   POST /confirm              applies a previewed import, idempotent on import_id
 *   GET  /:id/report[?format=csv]  the downloadable result report
 *   GET  /history              recent imports
 *
 * THE SINGLE GIANT TEMPLATE IS GONE (§10). Columns are generated per section
 * from worker/lib/templateFamilies.ts, so a Materials sheet never shows a
 * nozzle diameter and a Devices sheet never shows a filament colour. The older
 * TXT pipeline at /api/admin/template still exists because it is genuinely in
 * use, but it is no longer the only option and no longer the default one.
 *
 * PREVIEW WRITES NOTHING TO THE DATABASE. It parses, resolves every brand,
 * section and facet name to an id, and stores what it resolved in
 * `product_imports.payload` — an import record, not a product. No product,
 * catalog, stock or order row is touched until confirm. Image BYTES from an
 * uploaded ZIP are written to content-addressed R2 keys during preview, which
 * is deliberate: the object store is content-addressed, so an unconfirmed
 * import leaves an orphan blob and never a half-made product, and it lets
 * confirm be a pure database operation that cannot fail on a slow download.
 *
 * CONFIRM IS IDEMPOTENT. It is keyed on `import_id`; a second call finds
 * state='applied' and returns the stored report without writing again. Within
 * one confirm, each product is written as ONE D1 batch (product row +
 * options + colours + links + images + facets), so a product can never
 * half-land; a product that fails is reported with its reason and the rest of
 * the file still applies.
 */

import { Hono } from 'hono';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import type { AppContext, Env } from '../lib/types';
import { requireAdmin, badRequest, notFound, forbidden, str } from '../lib/http';
import { newId, sha256Hex } from '../lib/crypto';
import { audit } from '../lib/audit';
import { canViewFinancials } from '../lib/adminScope';
import { rateLimit } from '../lib/ratelimit';
import { sniff } from './uploads';
import { ingestImageUrl } from './media';
import { planRelationsWrite } from './adminProductRelations';
import {
  blankTemplate,
  labelRow,
  lookupsSheet,
  parseCsv,
  parseImport,
  readmeFor,
  serializeProducts,
  templateShape,
  templateTypeChoices,
  toCsv,
  type ExportProduct,
  type ParseResult,
  type RowIssue,
  type TemplateShape,
} from '../lib/importCsv';
import {
  normKey,
  resolveProduct,
  splitComboKey,
  type CatalogRef,
  type ExistingShape,
  type ImportMaps,
} from '../lib/importApply';
import {
  isProductType,
  isTemplateFamily,
  productTypeForSection,
  type ProductTypeId,
} from '../lib/templateFamilies';
import { loadLookups } from '../lib/lookups';
import { registerHashtags } from '../lib/hashtags';
import {
  PRODUCT_COLUMNS,
  parseProductRow,
  serializeDoc,
  validateProductDoc,
} from '../lib/productModel';
import { localizeProductDoc } from '../lib/translate/localizeProduct';
import { syncProductTranslations } from '../lib/translate/store';

export const adminImportRoutes = new Hono<AppContext>();
adminImportRoutes.use('*', requireAdmin);

const MAX_CSV_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const MAX_ZIP_FILES = 400;
const MAX_PRODUCTS = 500;
const IMAGE_CAP = 4 * 1024 * 1024;

// ------------------------------------------------------------- downloads

/** Both an ASCII `filename=` and an RFC 5987 `filename*=`; iPadOS Safari
 *  needs the first to save rather than render, and the sanitizer strips
 *  CR/LF so a section name can never inject a header. */
function disposition(filename: string, ext: string): string {
  const ascii =
    (filename.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'levonis').slice(0, 120);
  const withExt = ascii.toLowerCase().endsWith(`.${ext}`) ? ascii : `${ascii}.${ext}`;
  return `attachment; filename="${withExt}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function fileResponse(bytes: Uint8Array, filename: string, mime: string, ext: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': disposition(filename, ext),
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** A UTF-8 BOM so Excel opens Arabic labels correctly instead of mojibake. */
const csvBytes = (text: string) => new TextEncoder().encode(`\uFEFF${text}`);

// ------------------------------------------------------------- taxonomy

interface CatalogRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name_en: string;
  name_ar: string;
  template_family: string | null;
}

async function loadCatalogs(db: D1Database): Promise<CatalogRow[]> {
  const { results } = await db
    .prepare('SELECT id, parent_id, slug, name_en, name_ar, template_family FROM catalogs ORDER BY sort, name_en')
    .all<CatalogRow>();
  return results;
}

/** The family a catalog inherits by walking up its branch (§10). */
function familyMap(rows: CatalogRow[]): Map<string, 'devices' | 'materials' | null> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, 'devices' | 'materials' | null>();
  for (const row of rows) {
    let node: CatalogRow | undefined = row;
    let found: 'devices' | 'materials' | null = null;
    for (let hop = 0; node && hop < 12; hop++) {
      if (isTemplateFamily(node.template_family)) {
        found = node.template_family;
        break;
      }
      node = node.parent_id ? byId.get(node.parent_id) : undefined;
    }
    out.set(row.id, found);
  }
  return out;
}

/** The catalog's own slug plus its ancestors', so a section add-on defined on
 *  a parent still contributes its columns to a child. */
function branchSlugs(rows: CatalogRow[], id: string): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: string[] = [];
  let node = byId.get(id);
  for (let hop = 0; node && hop < 12; hop++) {
    out.push(node.slug);
    node = node.parent_id ? byId.get(node.parent_id) : undefined;
  }
  return out;
}

/**
 * Resolves ?category= to a shape, or fails with a message naming the reason.
 *
 * THE SHAPE COMES FROM THE PRODUCT TYPE, not from the section directly: the
 * section picks a family and a branch, the branch picks one of the four types
 * the owner works in (طابعة / ملحقات / فلمنت / اكسسوار), and the type owns the
 * columns. A section export and that type's blank template are therefore the
 * same file shape, which is what makes "download, fill, import" and "export,
 * edit, import" the same workflow.
 */
async function shapeFor(
  db: D1Database,
  categoryId: string,
  includeCost: boolean,
  typeOverride?: ProductTypeId
): Promise<{ shape: TemplateShape; catalog: CatalogRow; rows: CatalogRow[] }> {
  const rows = await loadCatalogs(db);
  const catalog = rows.find((r) => r.id === categoryId);
  if (!catalog) throw notFound(`No section with id "${categoryId}"`);
  const family = familyMap(rows).get(categoryId) ?? null;
  if (!family && !typeOverride) {
    throw badRequest(
      `Section "${catalog.name_en || catalog.name_ar}" has no template family. Set it to Devices or Materials in the taxonomy admin first.`,
      'NO_FAMILY'
    );
  }
  const slugs = branchSlugs(rows, categoryId);
  const type = typeOverride ?? productTypeForSection(family!, slugs);
  return { shape: templateShape(type, slugs, { includeCost }), catalog, rows };
}

const fileStem = (catalog: CatalogRow, kind: string) =>
  `levonis-${kind}-${catalog.slug}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

const typeStem = (type: ProductTypeId, kind: string) => `levonis-${kind}-${type}`;

/** The `?type=` query parameter, refused by name rather than silently ignored. */
function typeParam(raw: string | undefined): ProductTypeId | undefined {
  if (!raw) return undefined;
  if (!isProductType(raw)) {
    throw badRequest(
      `type: "${raw}" is not a product type — use one of printer, parts, filament, accessory`,
      'BAD_TYPE'
    );
  }
  return raw;
}

// GET /template ------------------------------------------------------------

adminImportRoutes.get('/template', async (c) => {
  const admin = c.get('user')!;
  const type = typeParam(c.req.query('type'));
  const rawCategory = c.req.query('category');
  const format = c.req.query('format') === 'zip' ? 'zip' : 'csv';
  const withExample = c.req.query('example') !== '0';
  const money = canViewFinancials(c.env, admin);

  // TWO WAYS IN, ONE FILE. `?type=` downloads the template for a product type
  // straight away — the owner's «ويكون حسب نوع المنتج» — and `?category=`
  // keeps working for an admin who thinks in sections, resolving that section
  // to its type. Both produce identical columns for the same type.
  let shape: TemplateShape;
  let stem: string;
  if (rawCategory) {
    const categoryId = str(rawCategory, 'category', { min: 1, max: 60 });
    const resolved = await shapeFor(c.env.DB, categoryId, money, type);
    shape = resolved.shape;
    stem = fileStem(resolved.catalog, 'template');
  } else if (type) {
    shape = templateShape(type, [], { includeCost: money });
    stem = typeStem(type, 'template');
  } else {
    throw badRequest('type: pick a product type (printer / parts / filament / accessory) or pass a section id');
  }

  // The accepted values of the classification columns ride along with the
  // template: a section, brand or hashtag added in the taxonomy admin is
  // offered by the very next download.
  const lookups = await loadLookups(c.env.DB);
  const csv = blankTemplate(shape, withExample, lookups);

  if (format === 'csv') return fileResponse(csvBytes(csv), `${stem}.csv`, 'text/csv; charset=utf-8', 'csv');

  const zip = zipSync(
    {
      'data.csv': strToU8(`\uFEFF${csv}`),
      'README.txt': strToU8(readmeFor(shape, lookups)),
      'lookups.csv': strToU8(`\uFEFF${lookupsSheet(lookups)}`),
      'labels.csv': strToU8(`\uFEFF${toCsv([shape.columns, labelRow(shape)])}`),
      // A real, non-empty file: some unzip tools drop empty directories, and an
      // admin who cannot see images/ will not know where to put the pictures.
      'images/PUT-IMAGES-HERE.txt': strToU8(
        'ضع صور المنتجات في هذا المجلد، ثم اكتب اسم الملف في عمود image داخل data.csv\nمثال: images/a1-front.jpg\n'
      ),
    },
    { level: 6 }
  );
  return fileResponse(zip, `${stem}.zip`, 'application/zip', 'zip');
});

// GET /types --------------------------------------------------------------
//
// The four product types and what each one costs in columns, so the import
// panel can offer them without a second copy of the list in `src/`.

adminImportRoutes.get('/types', (c) => c.json({ success: true, types: templateTypeChoices() }));

// GET /lookups ------------------------------------------------------------
//
// The same values the template ships with, as JSON for the import panel, so
// an admin sees what the file will accept before typing a single row.

adminImportRoutes.get('/lookups', async (c) => {
  const lookups = await loadLookups(c.env.DB);
  return c.json({ success: true, ...lookups });
});

// ------------------------------------------------------------- export

/** The relational rows of several products, in the template's own shape. */
async function exportProducts(
  db: D1Database,
  productIds: string[],
  shape: TemplateShape,
  money: boolean
): Promise<ExportProduct[]> {
  if (productIds.length === 0) return [];
  const ph = productIds.map(() => '?').join(',');
  const { results: prods } = await db
    .prepare(`SELECT * FROM products WHERE id IN (${ph})`)
    .bind(...productIds)
    .all<Record<string, unknown>>();
  const { results: groups } = await db
    .prepare(`SELECT * FROM product_option_groups WHERE product_id IN (${ph}) ORDER BY sort`)
    .bind(...productIds)
    .all<{ id: string; product_id: string; name_en: string }>();
  const { results: values } = await db
    .prepare(`SELECT * FROM product_option_values WHERE product_id IN (${ph}) ORDER BY sort`)
    .bind(...productIds)
    .all<Record<string, unknown>>();
  const { results: colors } = await db
    .prepare(`SELECT * FROM product_colors WHERE product_id IN (${ph}) ORDER BY sort`)
    .bind(...productIds)
    .all<Record<string, unknown>>();
  const { results: links } = await db
    .prepare(
      `SELECT l.color_id, l.option_value_id FROM product_color_option_links l
        JOIN product_colors pc ON pc.id = l.color_id
       WHERE pc.product_id IN (${ph})`
    )
    .bind(...productIds)
    .all<{ color_id: string; option_value_id: string }>();
  const { results: images } = await db
    .prepare(`SELECT * FROM product_images WHERE product_id IN (${ph}) ORDER BY sort_order`)
    .bind(...productIds)
    .all<Record<string, unknown>>();
  const { results: variants } = await db
    .prepare(`SELECT * FROM product_variants WHERE product_id IN (${ph}) ORDER BY rowid`)
    .bind(...productIds)
    .all<Record<string, unknown>>();

  const catalogs = await loadCatalogs(db);
  const catById = new Map(catalogs.map((r) => [r.id, r]));
  const { results: brands } = await db.prepare('SELECT id, name_en, name_ar FROM brands').all<{
    id: string;
    name_en: string;
    name_ar: string;
  }>();
  const brandById = new Map(brands.map((b) => [b.id, b.name_en || b.name_ar]));

  const groupById = new Map(groups.map((g) => [g.id, g]));
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  const money0 = (v: unknown) => (money ? n(v) : null);

  return prods.map((row) => {
    const doc = parseProductRow(row);
    const pid = doc.id;
    const myValues = values.filter((v) => v.product_id === pid);
    const valueById = new Map(myValues.map((v) => [v.id as string, v]));
    const linkNames = new Map<string, Array<{ group: string; value: string }>>();
    for (const l of links) {
      const v = valueById.get(l.option_value_id);
      if (!v) continue;
      const g = groupById.get(v.group_id as string);
      if (!g) continue;
      const list = linkNames.get(l.color_id) ?? [];
      list.push({ group: g.name_en, value: v.name_en as string });
      linkNames.set(l.color_id, list);
    }
    const cat = doc.category_id ? catById.get(doc.category_id) : undefined;
    const sub = doc.sub_category_id ? catById.get(doc.sub_category_id) : undefined;
    const nameOfValue = (id: string) => {
      const v = valueById.get(id);
      const grp = v ? groupById.get(v.group_id as string) : undefined;
      return v && grp ? { group: grp.name_en as string, value: v.name_en as string } : null;
    };

    return {
      // The key must survive the round-trip and identify the SAME product, so
      // it prefers the SKU and falls back to the slug, never to a fresh id.
      key: doc.sku || doc.slug,
      name: doc.name_en,
      description: doc.description_en,
      status: doc.status,
      sku: doc.sku ?? '',
      display_order: doc.display_order,
      is_featured: doc.is_featured,
      brand: doc.brand_id ? (brandById.get(doc.brand_id) ?? '') : '',
      category: cat ? cat.name_en || cat.slug : '',
      sub_category: sub ? sub.name_en || sub.slug : '',
      sale_types: doc.sale_types,
      inventory_mode: String(row.inventory_mode ?? 'BASE'),
      price_iqd: doc.price_iqd,
      prime_price_iqd: doc.prime_price_iqd,
      pro_price_iqd: doc.pro_price_iqd,
      cost_iqd: money ? doc.product_cost_iqd : null,
      direct_surcharge_iqd: doc.direct_surcharge_iqd,
      stock: doc.stock,
      low_stock_threshold: doc.low_stock_threshold,
      payment_options: doc.payment_options,
      how_to_use: doc.how_to_use,
      usage_url: doc.usage_guide?.official_url ?? '',
      hashtags: doc.hashtags,
      spec_fields: doc.spec_fields,
      transports: doc.preorder_transports.map((tr) => ({
        method: tr.method,
        commission_iqd: tr.commission_iqd,
        active: tr.active,
      })),
      specs: doc.spec_groups.flatMap((grp) =>
        grp.rows.map((r) => ({
          group: grp.title_en || grp.title_ar,
          label: r.label_en || r.label_ar,
          value: r.value_en || r.value_ar,
          unit: r.unit,
        }))
      ),
      labels: doc.labels.map((l) => ({
        key: l.key,
        text: l.text_en || l.text_ar,
        icon: l.icon,
        visible: l.visible,
      })),
      warranty_plans: doc.warranty_plans.map((w) => ({
        title: w.title_en || w.title_ar,
        terms: w.terms_en || w.terms_ar,
        duration_months: w.duration_months,
        duration_kind: w.duration_kind,
        fee_iqd: w.fee_iqd,
        active: w.active,
      })),
      content_blocks: doc.content_blocks.map((b) => ({
        kind: b.kind,
        body: b.body_en || b.body_ar,
        caption: b.caption_en || b.caption_ar,
        alt: b.alt_en || b.alt_ar,
        url: b.url,
        // The image cell carries the stored URL, which resolveImages maps
        // straight back to itself, so a round-trip re-uses the same object.
        image: b.kind === 'image' ? b.url : '',
      })),
      guide_steps: doc.usage_guide.steps.map((st) => ({
        kind: st.kind,
        title: st.title,
        body: st.body,
        images: st.images,
        video_url: st.video_url,
        link_url: st.link_url,
      })),
      variants: variants
        .filter((v) => v.product_id === pid)
        .map((v) => {
          const sel = splitComboKey(String(v.combo_key));
          return {
            selection: sel.option_value_ids
              .map(nameOfValue)
              .filter((x): x is { group: string; value: string } => x !== null),
            color: sel.color_id
              ? ((colors.find((col) => col.id === sel.color_id)?.name_en as string) ?? '')
              : '',
            sku_part: (v.sku as string) ?? '',
            active: v.active === 1,
            stock: n(v.stock),
            low_stock_threshold: n(v.low_stock_threshold),
            price_iqd: n(v.regular_price_iqd),
            prime_price_iqd: n(v.prime_price_iqd),
            pro_price_iqd: n(v.pro_price_iqd),
            cost_iqd: money0(v.cost_iqd),
          };
        }),
      options: myValues.map((v) => ({
        group: (groupById.get(v.group_id as string)?.name_en ?? ''),
        value: v.name_en as string,
        sku_part: (v.sku_part as string) ?? '',
        image: (v.image as string) ?? '',
        active: v.active === 1,
        stock: n(v.stock),
        low_stock_threshold: n(v.low_stock_threshold),
        price_iqd: n(v.regular_price_iqd),
        prime_price_iqd: n(v.prime_price_iqd),
        pro_price_iqd: n(v.pro_price_iqd),
        cost_iqd: money0(v.cost_iqd),
        // 0044. The adjustments ship for the same reason the 0043 fields do.
        regular_adjust_iqd: n(v.regular_adjust_iqd),
        prime_adjust_iqd: n(v.prime_adjust_iqd),
        pro_adjust_iqd: n(v.pro_adjust_iqd),
        cost_adjust_iqd: money0(v.cost_adjust_iqd),
        // 0043. An export is the bulk-EDIT path, so every one of these ships
        // even when empty: an omitted column is one the importer PRESERVES,
        // and a silently absent availability could never be cleared by editing
        // the very file the store produced.
        availability_type: (v.availability_type as string) ?? '',
        lead_time_text: (v.lead_time_text as string) ?? '',
        lead_time_min_days: n(v.lead_time_min_days),
        lead_time_max_days: n(v.lead_time_max_days),
        variant_key: (v.variant_key as string) ?? '',
        variant_label: (v.variant_label as string) ?? '',
      })),
      colors: colors
        .filter((col) => col.product_id === pid)
        .map((col) => ({
          name: col.name_en as string,
          hex: col.hex as string,
          sku_part: (col.sku_part as string) ?? '',
          image: (col.image as string) ?? '',
          active: col.active === 1,
          stock: n(col.stock),
          low_stock_threshold: n(col.low_stock_threshold),
          price_iqd: n(col.regular_price_iqd),
          prime_price_iqd: n(col.prime_price_iqd),
          pro_price_iqd: n(col.pro_price_iqd),
          cost_iqd: money0(col.cost_iqd),
          regular_adjust_iqd: n(col.regular_adjust_iqd),
          prime_adjust_iqd: n(col.prime_adjust_iqd),
          pro_adjust_iqd: n(col.pro_adjust_iqd),
          cost_adjust_iqd: money0(col.cost_adjust_iqd),
          links: linkNames.get(col.id as string) ?? [],
        })),
      images: images
        .filter((im) => im.product_id === pid)
        .map((im) => {
          const boundColor = colors.find((col) => col.id === im.color_id);
          const boundValue = im.option_value_id ? valueById.get(im.option_value_id as string) : undefined;
          const boundGroup = boundValue ? groupById.get(boundValue.group_id as string) : undefined;
          return {
            image: im.url as string,
            alt: (im.alt_en as string) ?? '',
            primary: im.is_primary === 1,
            bind: boundColor
              ? `color:${boundColor.name_en as string}`
              : boundValue && boundGroup
                ? `option:${boundGroup.name_en}:${boundValue.name_en as string}`
                : '',
          };
        }),
    } satisfies ExportProduct;
  });
}

adminImportRoutes.get('/export', async (c) => {
  const admin = c.get('user')!;
  const money = canViewFinancials(c.env, admin);
  const format = c.req.query('format') === 'zip' ? 'zip' : 'csv';
  const idsParam = (c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  let categoryId = c.req.query('category') ?? '';
  if (!categoryId && idsParam.length) {
    const first = await c.env.DB
      .prepare('SELECT sub_category_id, category_id FROM products WHERE id = ?')
      .bind(idsParam[0])
      .first<{ sub_category_id: string | null; category_id: string | null }>();
    categoryId = first?.sub_category_id || first?.category_id || '';
  }
  if (!categoryId) throw badRequest('category: a section id is required (or ids= of products that have one)');

  const { shape, catalog } = await shapeFor(c.env.DB, categoryId, money);

  let productIds = idsParam;
  if (productIds.length === 0) {
    const { results } = await c.env.DB
      .prepare(
        `SELECT id FROM products WHERE category_id = ? OR sub_category_id = ?
          ORDER BY display_order, created_at DESC LIMIT ?`
      )
      .bind(categoryId, categoryId, MAX_PRODUCTS)
      .all<{ id: string }>();
    productIds = results.map((r) => r.id);
  }
  if (productIds.length > MAX_PRODUCTS) productIds = productIds.slice(0, MAX_PRODUCTS);

  const products = await exportProducts(c.env.DB, productIds, shape, money);
  const csv = serializeProducts(products, shape);
  const stem = fileStem(catalog, 'export');

  if (format === 'csv') return fileResponse(csvBytes(csv), `${stem}.csv`, 'text/csv; charset=utf-8', 'csv');
  const lookups = await loadLookups(c.env.DB);
  const zip = zipSync(
    {
      'data.csv': strToU8(`\uFEFF${csv}`),
      'README.txt': strToU8(readmeFor(shape, lookups)),
      'labels.csv': strToU8(`\uFEFF${toCsv([shape.columns, labelRow(shape)])}`),
      'lookups.csv': strToU8(`\uFEFF${lookupsSheet(lookups)}`),
    },
    { level: 6 }
  );
  return fileResponse(zip, `${stem}.zip`, 'application/zip', 'zip');
});

// ------------------------------------------------------------- preview

interface UploadedFile {
  name: string;
  csv: string;
  /** ZIP entry path (lower-cased, normalized) -> bytes */
  assets: Map<string, Uint8Array>;
}

async function readUpload(c: { req: { formData: () => Promise<FormData> } }): Promise<{
  file: UploadedFile;
  categoryId: string;
}> {
  const form = await c.req.formData();
  const f = form.get('file');
  const categoryId = String(form.get('category') ?? '').trim();
  if (!(f instanceof File)) throw badRequest('file: attach the completed .csv or .zip');
  const bytes = new Uint8Array(await f.arrayBuffer());
  const name = f.name || 'import';

  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    if (bytes.byteLength > MAX_ZIP_BYTES) throw badRequest(`The ZIP exceeds ${MAX_ZIP_BYTES / 1024 / 1024} MB`);
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw badRequest('The ZIP could not be read');
    }
    const names = Object.keys(entries).filter((k) => !k.endsWith('/'));
    if (names.length > MAX_ZIP_FILES) throw badRequest(`The ZIP holds more than ${MAX_ZIP_FILES} files`);
    const dataName = names.find((k) => k.toLowerCase().endsWith('data.csv')) ?? names.find((k) => k.toLowerCase().endsWith('.csv'));
    if (!dataName) throw badRequest('The ZIP has no data.csv');
    const assets = new Map<string, Uint8Array>();
    for (const k of names) {
      if (k === dataName) continue;
      if (entries[k].byteLength > IMAGE_CAP) continue;
      assets.set(k.toLowerCase(), entries[k]);
    }
    return { file: { name, csv: new TextDecoder().decode(entries[dataName]), assets }, categoryId };
  }

  if (bytes.byteLength > MAX_CSV_BYTES) throw badRequest(`The file exceeds ${MAX_CSV_BYTES / 1024 / 1024} MB`);
  return { file: { name, csv: new TextDecoder().decode(bytes), assets: new Map() }, categoryId };
}

/** Stores one image from the ZIP under a content-addressed key. */
async function storeAsset(env: Env, bytes: Uint8Array): Promise<string | null> {
  const kind = sniff(bytes);
  if (!kind || !kind.mime.startsWith('image/')) return null;
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const key = `products/import/${sha}.${kind.ext}`;
  if (!(await env.BUCKET.head(key))) {
    await env.BUCKET.put(key, bytes as unknown as ArrayBuffer | ArrayBufferView, {
      httpMetadata: { contentType: kind.mime, cacheControl: 'public, max-age=31536000, immutable' },
    });
  }
  return `/files/${key}`;
}

/**
 * Every image cell in the file, resolved to a stored delivery URL.
 *
 * Three legal forms, and nothing else (§2 and §10): a path inside the ZIP, a
 * `/files/...` URL this store already serves (which is what an export writes,
 * so a round-trip re-uses the same object), and a direct image URL, verified
 * by magic bytes.
 *
 * A spreadsheet cell is ONE image, so this path calls `ingestImageUrl` and not
 * the page reader: pasting a product page into a cell that means "this row's
 * picture" would turn one cell into ten images with no way to say which. Page
 * reading is offered where an admin can see the result — the product form's
 * image box (worker/routes/media.ts).
 */
async function resolveImages(
  env: Env,
  parsed: ParseResult,
  assets: Map<string, Uint8Array>
): Promise<{ map: Map<string, string>; issues: RowIssue[] }> {
  const map = new Map<string, string>();
  const issues: RowIssue[] = [];
  const wanted = new Map<string, number>(); // cell -> first line that used it
  const want = (cell: string, line: number) => {
    if (cell && !wanted.has(cell)) wanted.set(cell, line);
  };
  for (const p of parsed.products) {
    for (const im of p.images) want(im.image, im.line);
    for (const o of p.options) want(o.image, o.line);
    for (const col of p.colors) want(col.image, col.line);
    // Content blocks and guide steps carry pictures too. Leaving them out is
    // what would make an export of a product with a guide fail to re-import:
    // the cell would resolve to nothing and the row would be refused.
    for (const b of p.content_blocks ?? []) want(b.image, b.line);
    for (const g of p.guide_steps ?? []) for (const cell of g.images) want(cell, g.line);
  }

  for (const [cell, line] of wanted) {
    if (cell.startsWith('/files/')) {
      map.set(cell, cell); // already ours; a round-trip must not re-upload
      continue;
    }
    const zipKey = cell.toLowerCase().replace(/^\.?\//, '');
    const bytes =
      assets.get(zipKey) ??
      assets.get(`images/${zipKey}`) ??
      [...assets.entries()].find(([k]) => k.endsWith(`/${zipKey}`))?.[1];
    if (bytes) {
      const url = await storeAsset(env, bytes);
      if (url) map.set(cell, url);
      else issues.push({ line, severity: 'error', message: `image: "${cell}" ليس ملف صورة صالحًا` });
      continue;
    }
    if (/^https?:\/\//i.test(cell)) {
      const res = await ingestImageUrl(env, cell);
      if (res.status === 'stored' && res.url) map.set(cell, res.url);
      else issues.push({ line, severity: 'error', message: `image: "${cell}" — ${res.reason ?? 'تعذّر التحميل'}` });
      continue;
    }
    issues.push({
      line,
      severity: 'error',
      message: `image: "${cell}" غير موجود في مجلد images/ داخل الـ ZIP وليس رابطًا مباشرًا`,
    });
  }
  return { map, issues };
}

/**
 * Registers one table's aliases, in two passes with different rules.
 *
 * SLUGS AND IDS FIRST, and they are final: both are unique by construction,
 * so a slug always resolves to its own row no matter what anything is named.
 *
 * DISPLAY NAMES SECOND, and a name claimed by two different rows is recorded
 * as AMBIGUOUS rather than silently resolved to whichever row was read first.
 * Two sections called "Printers" are ordinary (the seed ships several), and a
 * sheet that says `category: Printers` would otherwise file the product under
 * an arbitrary one of them — a wrong section written silently. The row is
 * refused instead, naming the slug as the way to say which one is meant.
 */
function registerAliases<T>(
  rows: Array<{ id: string; slug: string; name_en: string; name_ar: string }>,
  value: (row: { id: string }) => T,
  into: Map<string, T>,
  ambiguous: Set<string>
): void {
  const authoritative = new Set<string>();
  for (const r of rows) {
    for (const alias of [r.slug, r.id]) {
      if (!alias) continue;
      const key = normKey(alias);
      authoritative.add(key);
      if (!into.has(key)) into.set(key, value(r));
    }
  }
  const owner = new Map<string, string>();
  for (const r of rows) {
    for (const alias of [r.name_en, r.name_ar]) {
      if (!alias) continue;
      const key = normKey(alias);
      if (authoritative.has(key)) continue; // a slug owns it; names cannot take it
      const first = owner.get(key);
      if (first === undefined) {
        owner.set(key, r.id);
        into.set(key, value(r));
      } else if (first !== r.id) {
        ambiguous.add(key);
      }
    }
  }
}

async function buildMaps(db: D1Database, images: Map<string, string>): Promise<ImportMaps> {
  const rows = await loadCatalogs(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const catalogs = new Map<string, CatalogRef>();
  const ambiguous = { brands: new Set<string>(), catalogs: new Set<string>(), facets: new Set<string>() };
  registerAliases(
    rows.map((r) => ({ id: r.id, slug: r.slug, name_en: r.name_en, name_ar: r.name_ar })),
    (r) => {
      const row = byId.get(r.id)!;
      return {
        id: row.id,
        parent_id: row.parent_id,
        slug: row.slug,
        name_en: row.name_en,
        name_ar: row.name_ar,
        template_family: row.template_family,
      } satisfies CatalogRef;
    },
    catalogs,
    ambiguous.catalogs
  );

  const { results: brandRows } = await db
    .prepare('SELECT id, slug, name_en, name_ar FROM brands WHERE active = 1')
    .all<{ id: string; slug: string; name_en: string; name_ar: string }>();
  const brands = new Map<string, string>();
  registerAliases(brandRows, (b) => b.id, brands, ambiguous.brands);

  const { results: facetRows } = await db
    .prepare('SELECT id, slug, name_en, name_ar FROM facets WHERE active = 1')
    .all<{ id: string; slug: string; name_en: string; name_ar: string }>();
  const facets = new Map<string, string>();
  registerAliases(facetRows, (f) => f.id, facets, ambiguous.facets);

  return { brands, catalogs, facets, familyOf: familyMap(rows), images, ambiguous };
}

/** The existing product a `key` refers to: SKU first, then slug. */
async function loadExisting(db: D1Database, keys: string[]): Promise<Map<string, ExistingShape>> {
  const out = new Map<string, ExistingShape>();
  if (keys.length === 0) return out;
  const ph = keys.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM products WHERE sku IN (${ph}) OR slug IN (${ph})`)
    .bind(...keys, ...keys)
    .all<Record<string, unknown>>();
  if (results.length === 0) return out;

  const ids = results.map((r) => String(r.id));
  const idPh = ids.map(() => '?').join(',');
  const { results: groups } = await db
    .prepare(`SELECT id, product_id, name_en FROM product_option_groups WHERE product_id IN (${idPh})`)
    .bind(...ids)
    .all<{ id: string; product_id: string; name_en: string }>();
  const { results: values } = await db
    .prepare(`SELECT id, product_id, group_id, name_en FROM product_option_values WHERE product_id IN (${idPh})`)
    .bind(...ids)
    .all<{ id: string; product_id: string; group_id: string; name_en: string }>();
  const { results: colors } = await db
    .prepare(`SELECT id, product_id, name_en FROM product_colors WHERE product_id IN (${idPh})`)
    .bind(...ids)
    .all<{ id: string; product_id: string; name_en: string }>();
  const { results: images } = await db
    .prepare(`SELECT id, product_id, url FROM product_images WHERE product_id IN (${idPh})`)
    .bind(...ids)
    .all<{ id: string; product_id: string; url: string }>();
  const { results: variants } = await db
    .prepare(`SELECT * FROM product_variants WHERE product_id IN (${idPh})`)
    .bind(...ids)
    .all<Record<string, unknown>>();

  for (const row of results) {
    const doc = parseProductRow(row);
    const id = doc.id;
    const shape: ExistingShape = {
      id,
      slug: doc.slug,
      inventory_mode: String(row.inventory_mode ?? 'BASE'),
      doc: doc as unknown as Record<string, unknown>,
      groups: groups.filter((g) => g.product_id === id).map((g) => ({ id: g.id, name_en: g.name_en })),
      values: values
        .filter((v) => v.product_id === id)
        .map((v) => ({ id: v.id, group_id: v.group_id, name_en: v.name_en })),
      colors: colors.filter((col) => col.product_id === id).map((col) => ({ id: col.id, name_en: col.name_en })),
      images: images.filter((im) => im.product_id === id).map((im) => ({ id: im.id, url: im.url })),
      variants: variants
        .filter((v) => v.product_id === id)
        .map((v) => ({
          id: String(v.id),
          combo_key: String(v.combo_key),
          sku: (v.sku as string) ?? null,
          active: Number(v.active ?? 1),
          stock: (v.stock as number) ?? null,
          low_stock_threshold: (v.low_stock_threshold as number) ?? null,
          regular_price_iqd: (v.regular_price_iqd as number) ?? null,
          prime_price_iqd: (v.prime_price_iqd as number) ?? null,
          pro_price_iqd: (v.pro_price_iqd as number) ?? null,
          cost_iqd: (v.cost_iqd as number) ?? null,
        })),
    };
    // SKU wins over slug when both match different products.
    if (doc.sku) out.set(doc.sku, shape);
    if (!out.has(doc.slug)) out.set(doc.slug, shape);
  }
  return out;
}

interface PreviewRow {
  key: string;
  line: number;
  action: 'create' | 'update' | 'failed';
  name: string;
  options: number;
  colors: number;
  links: number;
  images: number;
  errors: string[];
  warnings: string[];
}

adminImportRoutes.post('/preview', async (c) => {
  await rateLimit(c, 'import_preview', 40, 3600);
  const admin = c.get('user')!;
  const money = canViewFinancials(c.env, admin);
  const { file, categoryId } = await readUpload(c);
  if (!categoryId) throw badRequest('category: choose the section this file belongs to');

  const { shape, catalog } = await shapeFor(c.env.DB, categoryId, money);
  const parsed = parseImport(file.csv, shape);
  if (parsed.products.length > MAX_PRODUCTS) {
    throw badRequest(`The file holds ${parsed.products.length} products; the limit is ${MAX_PRODUCTS} per import`);
  }

  const { map: imageMap, issues: imageIssues } = await resolveImages(c.env, parsed, file.assets);
  const maps = await buildMaps(c.env.DB, imageMap);
  const existing = await loadExisting(c.env.DB, parsed.products.map((p) => p.key));

  // Which product each LINE belongs to, read from the raw rows rather than
  // from the parsed result: a row rejected during parsing (a bad hex, a
  // missing group) never reaches parsed.products, and attributing its error to
  // the file instead of to the product would hide it from the row the admin is
  // looking at. Lines with no resolvable owner are genuinely file-level.
  const lineOwner = new Map<number, string>();
  {
    const raw = parseCsv(file.csv);
    const header = (raw[0] ?? []).map((h) => h.trim());
    const keyAt = header.indexOf('key');
    const typeAt = header.indexOf('row_type');
    for (let i = 1; i < raw.length; i++) {
      const type = typeAt >= 0 ? (raw[i][typeAt] ?? '').trim().toLowerCase() : '';
      if (!type || type.startsWith('#')) continue;
      const k = keyAt >= 0 ? (raw[i][keyAt] ?? '').trim() : '';
      if (k) lineOwner.set(i + 1, k);
    }
  }

  const rows: PreviewRow[] = [];
  const resolved: Array<Record<string, unknown>> = [];
  const fileIssues: RowIssue[] = [];
  const byKey = new Map<string, PreviewRow>();

  for (const p of parsed.products) {
    const r = resolveProduct(p, existing.get(p.key) ?? null, maps, {
      newId,
      money,
      specFieldIds: shape.specFields.map((f) => f.id),
    });
    const row: PreviewRow = {
      key: p.key,
      line: p.line,
      action: r.action,
      name: p.name,
      options: (r.relations.groups as Array<{ values: unknown[] }>).reduce((n, g) => n + g.values.length, 0),
      colors: (r.relations.colors as unknown[]).length,
      links: (r.relations.colors as Array<{ option_value_ids: unknown[] }>).reduce(
        (n, col) => n + col.option_value_ids.length,
        0
      ),
      images: (r.relations.images as unknown[]).length,
      errors: r.issues.filter((i) => i.severity === 'error').map((i) => `سطر ${i.line}: ${i.message}`),
      warnings: r.issues.filter((i) => i.severity === 'warning').map((i) => `سطر ${i.line}: ${i.message}`),
    };
    rows.push(row);
    byKey.set(p.key, row);
    resolved.push({
      key: r.key,
      line: r.line,
      productId: r.productId,
      action: r.action,
      doc: r.doc,
      relations: r.relations,
      catalogIds: r.catalogIds,
    });
  }

  for (const issue of [...parsed.issues, ...imageIssues]) {
    const owner = lineOwner.get(issue.line);
    const row = owner ? byKey.get(owner) : undefined;
    const text = `سطر ${issue.line}: ${issue.message}`;
    if (row) (issue.severity === 'error' ? row.errors : row.warnings).push(text);
    else fileIssues.push(issue);
  }
  for (const row of rows) if (row.errors.length) row.action = 'failed';

  const payload = {
    category_id: categoryId,
    family: shape.family,
    section_slugs: shape.sectionSlugs,
    products: resolved.filter((r) => (byKey.get(r.key as string)?.errors.length ?? 0) === 0),
  };
  const importId = newId('imp');
  const payloadJson = JSON.stringify(payload);
  const hash = await sha256Hex(payloadJson);

  const willCreate = rows.filter((r) => r.action === 'create').length;
  const willUpdate = rows.filter((r) => r.action === 'update').length;
  const failed = rows.filter((r) => r.action === 'failed').length;

  // The ONLY write a preview performs: the import record itself. No product,
  // catalog, stock or order row is touched (§10).
  await c.env.DB
    .prepare(
      `INSERT INTO product_imports
         (id, actor_user_id, template_family, category_id, sub_category_id, state, payload_hash,
          created_count, updated_count, skipped_count, failed_count, report, payload, source_name)
       VALUES (?, ?, ?, ?, NULL, 'preview', ?, 0, 0, 0, ?, ?, ?, ?)`
    )
    .bind(
      importId,
      admin.id,
      shape.family,
      categoryId,
      hash,
      failed,
      JSON.stringify(rows),
      payloadJson,
      file.name.slice(0, 200)
    )
    .run();

  return c.json({
    success: true,
    import_id: importId,
    section: { id: catalog.id, name_en: catalog.name_en, name_ar: catalog.name_ar, family: shape.family },
    columns: shape.columns,
    unknown_columns: parsed.unknownColumns,
    file_issues: fileIssues,
    rows,
    summary: { total: rows.length, create: willCreate, update: willUpdate, failed },
    // Said plainly so nobody reads a preview as a save.
    note: 'هذه معاينة فقط — لم تُكتب أي بيانات. اضغط «تأكيد الاستيراد» للتنفيذ.',
  });
});

// ------------------------------------------------------------- confirm

interface ReportRow {
  key: string;
  line: number;
  action: 'created' | 'updated' | 'skipped' | 'failed';
  name: string;
  product_id: string;
  reason: string;
}

adminImportRoutes.post('/confirm', async (c) => {
  const admin = c.get('user')!;
  const money = canViewFinancials(c.env, admin);
  const body = (await c.req.json().catch(() => ({}))) as { import_id?: unknown };
  const importId = str(body.import_id, 'import_id', { min: 1, max: 60 });

  const rec = await c.env.DB
    .prepare('SELECT * FROM product_imports WHERE id = ?')
    .bind(importId)
    .first<Record<string, unknown>>();
  if (!rec) throw notFound('No import with that id');
  if (rec.actor_user_id && rec.actor_user_id !== admin.id) {
    throw forbidden('This import was prepared by another admin');
  }

  // IDEMPOTENT: a retry after a timeout, a double click, or a repeated request
  // finds the applied record and replays its report instead of writing twice.
  if (rec.state === 'applied') {
    return c.json({
      success: true,
      import_id: importId,
      already_applied: true,
      summary: {
        created: rec.created_count,
        updated: rec.updated_count,
        skipped: rec.skipped_count,
        failed: rec.failed_count,
      },
      rows: JSON.parse(String(rec.report || '[]')),
    });
  }

  const payload = JSON.parse(String(rec.payload || '{}')) as {
    products?: Array<Record<string, unknown>>;
  };
  const products = payload.products ?? [];
  const report: ReportRow[] = [];
  const importedTags: string[] = [];
  let created = 0;
  let updated = 0;
  let failedCount = 0;
  const reviewNeeded: string[] = [];

  for (const item of products) {
    const key = String(item.key ?? '');
    const line = Number(item.line ?? 0);
    const productId = String(item.productId ?? '');
    const isCreate = item.action === 'create';
    try {
      const doc = validateProductDoc(item.doc as Record<string, unknown>);
      doc.id = productId;
      if (isCreate) {
        doc.slug = await uniqueProductSlug(c.env.DB, doc.name_en || key || productId);
      }
      // §3: English in, Arabic and Kurdish generated locally. No network call.
      const localized = localizeProductDoc(doc);
      const record = serializeDoc(doc);

      const stmts: D1PreparedStatement[] = [];
      if (isCreate) {
        stmts.push(
          c.env.DB.prepare(
            `INSERT INTO products (${PRODUCT_COLUMNS.join(', ')})
             VALUES (${PRODUCT_COLUMNS.map(() => '?').join(', ')})`
          ).bind(...PRODUCT_COLUMNS.map((k) => record[k] ?? null))
        );
      } else {
        const cols = PRODUCT_COLUMNS.filter((k) => k !== 'id');
        stmts.push(
          c.env.DB.prepare(
            `UPDATE products SET ${cols.map((k) => `${k} = ?`).join(', ')},
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE id = ?`
          ).bind(...cols.map((k) => record[k] ?? null), doc.id)
        );
      }
      // The product row has to exist before the relations planner reads it, so
      // a creation runs its INSERT first and the structure follows in its own
      // batch. Both are guarded by the same try: a failure in the second step
      // is reported against this product, never as a silent success.
      await c.env.DB.batch(stmts);

      const plan = await planRelationsWrite(
        c.env.DB,
        productId,
        item.relations as Record<string, unknown>,
        { money }
      );
      if (!plan.stmts) {
        report.push({
          key,
          line,
          action: 'failed',
          name: doc.name_en,
          product_id: productId,
          reason: plan.errors.join(' | '),
        });
        failedCount++;
        continue;
      }
      const catalogIds = (item.catalogIds as string[]) ?? [];
      const relStmts = [...plan.stmts];
      relStmts.push(c.env.DB.prepare('DELETE FROM product_catalogs WHERE product_id = ?').bind(productId));
      for (const cid of catalogIds) {
        relStmts.push(
          c.env.DB
            .prepare(
              `INSERT INTO product_catalogs (product_id, catalog_id, position)
               VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM product_catalogs WHERE catalog_id = ?))`
            )
            .bind(productId, cid, cid)
        );
      }
      await c.env.DB.batch(relStmts);

      try {
        await syncProductTranslations(c.env.DB, productId, localized.fields);
      } catch (e) {
        console.error('import translation write failed', productId, e instanceof Error ? e.message : String(e));
      }
      if (localized.review_needed.length) reviewNeeded.push(`${key}: ${localized.review_needed.join(', ')}`);
      // Collected here and registered ONCE after the loop: registration reads
      // the vocabulary to fold tags itself, and doing that per product would
      // be one extra read for every row of a 500-row import.
      importedTags.push(...doc.hashtags);

      report.push({
        key,
        line,
        action: isCreate ? 'created' : 'updated',
        name: doc.name_en,
        product_id: productId,
        reason: '',
      });
      if (isCreate) created++;
      else updated++;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      report.push({ key, line, action: 'failed', name: String(item.key ?? ''), product_id: productId, reason });
      failedCount++;
    }
  }

  // Every tag the file carried joins the vocabulary, so the next template
  // download offers it. One call for the whole import, not one per product.
  await registerHashtags(c.env.DB, importedTags, newId);

  // Rows the preview already rejected are skipped, and say so by name.
  const previewRows = JSON.parse(String(rec.report || '[]')) as PreviewRow[];
  for (const pr of previewRows) {
    if (pr.action === 'failed' && !report.some((r) => r.key === pr.key)) {
      report.push({
        key: pr.key,
        line: pr.line,
        action: 'skipped',
        name: pr.name,
        product_id: '',
        reason: pr.errors.join(' | '),
      });
    }
  }
  const skipped = report.filter((r) => r.action === 'skipped').length;

  await c.env.DB
    .prepare(
      `UPDATE product_imports
          SET state = 'applied', created_count = ?, updated_count = ?, skipped_count = ?,
              failed_count = ?, report = ?, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND state = 'preview'`
    )
    .bind(created, updated, skipped, failedCount, JSON.stringify(report), importId)
    .run();

  await audit(c.env.DB, admin.id, 'product.import.apply', importId, {
    created,
    updated,
    skipped,
    failed: failedCount,
    cost_written: money,
  });

  return c.json({
    success: true,
    import_id: importId,
    summary: { created, updated, skipped, failed: failedCount },
    rows: report,
    translation_review_needed: reviewNeeded,
  });
});

/** A free slug for a new product; mirrors the form's own rule. */
async function uniqueProductSlug(db: D1Database, seed: string): Promise<string> {
  const base =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9؀-ۿ]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `product-${Math.abs(hashOf(seed)).toString(36)}`;
  for (let i = 0; i < 40; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await db.prepare('SELECT id FROM products WHERE slug = ?').bind(candidate).first();
    if (!clash) return candidate;
  }
  return `${base}-${newId('p').slice(-6)}`;
}

/** FNV-1a, only ever used to make a fallback slug deterministic. */
function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

// ------------------------------------------------------------- reports

adminImportRoutes.get('/history', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, template_family, category_id, state, created_count, updated_count, skipped_count,
              failed_count, source_name, created_at, applied_at
         FROM product_imports ORDER BY created_at DESC LIMIT 30`
    )
    .all<Record<string, unknown>>();
  return c.json({ success: true, imports: results });
});

adminImportRoutes.get('/:id/report', async (c) => {
  const id = c.req.param('id');
  const rec = await c.env.DB
    .prepare('SELECT * FROM product_imports WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!rec) throw notFound('No import with that id');
  const rows = JSON.parse(String(rec.report || '[]')) as Array<Record<string, unknown>>;

  if (c.req.query('format') !== 'csv') {
    return c.json({
      success: true,
      import_id: id,
      state: rec.state,
      summary: {
        created: rec.created_count,
        updated: rec.updated_count,
        skipped: rec.skipped_count,
        failed: rec.failed_count,
      },
      rows,
    });
  }

  const header = ['key', 'line', 'action', 'name', 'product_id', 'reason'];
  const labels = ['المفتاح', 'السطر', 'النتيجة', 'الاسم', 'معرّف المنتج', 'السبب'];
  const body = rows.map((r) =>
    header.map((h) => {
      const v = r[h];
      if (Array.isArray(v)) return v.join(' | ');
      return v === null || v === undefined ? '' : String(v);
    })
  );
  const csv = toCsv([header, labels, ...body]);
  return fileResponse(csvBytes(csv), `levonis-import-${id}.csv`, 'text/csv; charset=utf-8', 'csv');
});
