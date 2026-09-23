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
import { requireAdmin, badRequest, conflict, notFound, forbidden, str } from '../lib/http';
import { newId, sha256Hex } from '../lib/crypto';
import { audit } from '../lib/audit';
import { canViewFinancials } from '../lib/adminScope';
import { rateLimit } from '../lib/ratelimit';
import { HEIF_REFUSAL, isHeifBytes, sniff } from './uploads';
import { IMAGE_SOURCE_CAP } from '../lib/imageConvert';
import { ingestImageUrl } from './media';
import {
  ingestProductMediaBytes,
  PRODUCT_MEDIA_FORM_STAGING_GRACE_MINUTES,
  ProductMediaIngestError,
  verifyStoredProductMedia,
} from '../lib/productMediaIngest';
import { verifyAndNormalizeProductMedia } from '../lib/productMediaWrite';
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
  type ParsedMembershipRule,
  type ParseResult,
  type RowIssue,
  type TemplateShape,
} from '../lib/importCsv';
import {
  EXTERNAL_IMAGE_REFUSAL,
  fulfillmentPayloadFrom,
  isOwnedMediaUrl,
  normKey,
  relationValues,
  resolveProduct,
  splitComboKey,
  type CatalogRef,
  type ExistingCellRow,
  type ExistingRouteRow,
  type ExistingShape,
  type ImportMaps,
  ambiguousMessage,
} from '../lib/importApply';
import {
  createPendingBrand,
  inactiveBrandWarning,
  loadRefRows,
  matchRef,
  planBrandCreate,
} from '../lib/templateRefs';
import { normalizeText } from '../lib/search/normalize';
import type { PendingBrand } from '../lib/template';
import {
  existingCellsFrom,
  parseFulfillmentPayload,
  refuseStrandedCapacity,
  type ExistingCells,
} from '../lib/optionFulfillment';
import { planProductMembershipRules } from '../lib/membershipBenefits';
import {
  isProductType,
  isTemplateFamily,
  productTypeForBranch,
  PRODUCT_TYPES,
  type SectionRef,
  type ProductTypeId,
} from '../lib/templateFamilies';
import { loadLookups } from '../lib/lookups';
import {
  parseProductRow,
  validateProductDoc,
  type ProductDoc,
} from '../lib/productModel';
import {
  localizeRespectingAuthored,
  planProductSave,
  saveProductAtomic,
} from '../lib/productPersistence';
import { applyPrinterWarrantyRules } from '../lib/warrantyPlans';
import { withClassificationPlacements } from '../lib/catalogMembership';
import { isActiveProductImageRow } from '../lib/productOverlay';

export const adminImportRoutes = new Hono<AppContext>();
adminImportRoutes.use('*', requireAdmin);

const MAX_CSV_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const MAX_ZIP_FILES = 400;
const MAX_PRODUCTS = 500;
const IMPORT_MEDIA_STAGE_MODIFIER = `+${PRODUCT_MEDIA_FORM_STAGING_GRACE_MINUTES} minutes`;
/**
 * ONE CEILING FOR A PRODUCT PICTURE, AND IT IS THE FORM'S.
 *
 * This said 4 MB while `routes/uploads.ts` — the product form the same admin
 * uses — accepts 8. So a photograph that the owner had just added to a product
 * by hand was refused when the same photograph arrived inside a ZIP, and
 * nothing anywhere said the two numbers were different. The form's number wins
 * because it is the one the owner has already been taught — and it is now the
 * SHARED constant, so the URL half of this same import (`ingestImageUrl` in
 * routes/media.ts, which kept its own 4 MB) can no longer disagree with the
 * ZIP half about one photograph inside one run.
 */
const IMAGE_CAP = IMAGE_SOURCE_CAP;

/** For a message that names the real size rather than making the owner guess. */
const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

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
  /** 0/1 — the owner's printer flag; extended warranty rides only on these. */
  is_printer_catalog: number;
}

async function loadCatalogs(db: D1Database): Promise<CatalogRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, parent_id, slug, name_en, name_ar, template_family, is_printer_catalog FROM catalogs ORDER BY sort, name_en'
    )
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
function sectionBranch(rows: CatalogRow[], id: string): SectionRef[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: SectionRef[] = [];
  let node = byId.get(id);
  for (let hop = 0; node && hop < 12; hop++) {
    out.push({ id: node.id, slug: node.slug });
    node = node.parent_id ? byId.get(node.parent_id) : undefined;
  }
  return out;
}

/**
 * Resolves ?category= to a shape, or fails with a message naming the reason.
 *
 * THE SHAPE COMES FROM THE PRODUCT TYPE, not from the section directly: the
 * section picks a family and a branch, the branch picks one of the types the
 * owner works in (طابعة / ملحقات / فلمنت / اكسسوار, plus the laser line's
 * ليزر / مواد ليزر وقص), and the type owns the
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
  const branch = sectionBranch(rows, categoryId);
  // The type may be overridden by hand; the branch may not override it. It
  // still narrows WITHIN it, so a sheet for «طابعات FDM» carries no Resin
  // columns — the same fields the product form will show for that section.
  const type = typeOverride ?? productTypeForBranch(family!, branch);
  return {
    shape: templateShape(type, branch.map((b) => b.slug), { includeCost, branch }),
    catalog,
    rows,
  };
}

const fileStem = (catalog: CatalogRow, kind: string) =>
  `levonis-${kind}-${catalog.slug}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

const typeStem = (type: ProductTypeId, kind: string) => `levonis-${kind}-${type}`;

/** The `?type=` query parameter, refused by name rather than silently ignored. */
function typeParam(raw: string | undefined): ProductTypeId | undefined {
  if (!raw) return undefined;
  if (!isProductType(raw)) {
    throw badRequest(
      // The list is READ from the registry rather than spelled out here: it
      // was spelled out, and the day «ليزر» and «مواد ليزر وقص» were added the
      // message went on naming four types that no longer were all of them.
      `type: "${raw}" is not a product type — use one of ${PRODUCT_TYPES.map((t) => t.id).join(', ')}`,
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

  // TWO WAYS IN, TWO SHAPES. `?type=` downloads the template for a product
  // type straight away — the owner's «ويكون حسب نوع المنتج» — and `?category=`
  // resolves the section to its type AND NARROWS WITHIN IT: a sheet for
  // «طابعات Resin» carries 30 spec columns where the bare printer type carries
  // 47, and they differ by 25 fields.
  //
  // This comment used to end "Both produce identical columns for the same
  // type", which was true before `shapeFor` started passing the branch and
  // has been false since. It is corrected rather than deleted because the
  // owner's report — «لا تتغير القالب» — is exactly the belief this sentence
  // would have confirmed to anyone who read it.
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
    // READ FROM THE REGISTRY, for the same reason as `typeParam` above: this
    // line spelled the four types out, and it went on naming four after «ليزر»
    // and «مواد ليزر وقص» were added — telling the owner the store sells four
    // kinds of product at the exact moment it asks him to name one.
    throw badRequest(
      `type: pick a product type (${PRODUCT_TYPES.map((t) => t.id).join(' / ')}) or pass a section id`
    );
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
// The product types and what each one costs in columns, so the import panel
// can offer them without a second copy of the list in `src/`.

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
  // 0075 — the order-type cells and their routes, so the exported sheet
  // carries the pre-order capacity it is the only file able to edit.
  const { results: cells } = await db
    .prepare(`SELECT * FROM product_option_fulfillment WHERE product_id IN (${ph}) ORDER BY sort, id`)
    .bind(...productIds)
    .all<Record<string, unknown>>();
  const { results: routes } = await db
    .prepare(`SELECT * FROM product_option_transports WHERE product_id IN (${ph}) ORDER BY sort, id`)
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
  /**
   * §18 — the product-scoped membership discount rules, so an export carries
   * what a member actually pays for these products and not only the regular
   * ladder. `priority DESC, id` is the panel's own order (`allBenefitRules`),
   * so the sheet describes the same rule the owner sees at the top of the
   * list when two exist for one tier.
   */
  const { results: benefitRules } = await db
    .prepare(
      `SELECT tier, product_id, discount_mode, percent, fixed_iqd, max_discount_iqd, cap_scope, max_quantity
         FROM membership_benefit_rules
        WHERE benefit_type = 'product_discount' AND scope = 'product' AND product_id IN (${ph})
        ORDER BY priority DESC, id`
    )
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
      delivery_options: doc.delivery_options,
      warranty_base_months: doc.warranty_base_months,
      serialized: doc.serialized,
      // «الأبعاد والوزن» — carried so an export/edit/re-import round trip
      // returns every measurement rather than silently blanking eight columns.
      dimensions: doc.dimensions,
      payment_options: doc.payment_options,
      how_to_use: doc.how_to_use,
      usage_url: doc.usage_guide?.official_url ?? '',
      gini_url: doc.gini_url ?? '',
      hashtags: doc.hashtags,
      // §18. A tier with no product rule contributes NO entry, and
      // `serializeProducts` then writes six empty cells for it — never
      // `__NULL__`, which would turn an export into a deletion order for a
      // discount the owner may write in the panel tomorrow.
      membership_rules: benefitRules
        .filter((r) => r.product_id === pid && (r.tier === 'pro' || r.tier === 'prime'))
        .filter((r, i, list) => list.findIndex((x) => x.tier === r.tier) === i)
        .map((r) => ({
          tier: r.tier as 'pro' | 'prime',
          discount_mode: r.discount_mode === 'percent' || r.discount_mode === 'fixed' ? r.discount_mode : null,
          percent: n(r.percent),
          fixed_iqd: n(r.fixed_iqd),
          max_discount_iqd: n(r.max_discount_iqd),
          cap_scope: r.cap_scope === 'per_unit' || r.cap_scope === 'per_order' ? r.cap_scope : null,
          max_quantity: n(r.max_quantity),
        })),
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
        fee_percent: w.fee_percent,
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
        // Quarantine rows are provenance for repair, never an exportable
        // image. Their URL is intentionally blank; serializing one produced an
        // empty `image` child row that the next preview rejected.
        .filter((im) => im.product_id === pid && isActiveProductImageRow(im))
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
      /**
       * 0075. One row for the cell, then one row per route it has.
       *
       * A route with NO capacity is exported all the same, with an empty
       * number — that row is what tells the admin the route exists and is
       * drawing on the shared pool, and an export is the bulk-EDIT path, so a
       * row it omits is one the admin cannot change by editing this file.
       * Nothing here copies the pool's number onto a route.
       */
      fulfillments: cells
        .filter((f) => String(f.product_id) === pid)
        .flatMap((f) => {
          const v = valueById.get(String(f.option_id));
          const g = v ? groupById.get(v.group_id as string) : undefined;
          if (!v || !g) return [];
          const model = { group: g.name_en, value: v.name_en as string };
          const type = f.fulfillment_type === 'pre_order' ? ('pre_order' as const) : ('direct_sale' as const);
          const head = {
            ...model,
            fulfillment_type: type,
            method: '' as const,
            // A direct sale has no capacity: `serializeProducts` writes an
            // empty cell for it, never a number and never `__NULL__`.
            capacity: type === 'pre_order' ? n(f.capacity) : null,
            enabled: f.enabled !== 0,
          };
          if (type === 'direct_sale') return [head];
          return [
            head,
            ...routes
              .filter((t) => String(t.fulfillment_id) === String(f.id))
              .map((t) => ({
                ...model,
                fulfillment_type: type,
                method: (t.method === 'air' || t.method === 'sea' ? t.method : 'land') as 'air' | 'sea' | 'land',
                capacity: n(t.capacity),
                enabled: t.enabled !== 0,
              })),
          ];
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
    /**
     * AN OVERSIZE PICTURE IS KEPT HERE AND REFUSED LATER, BY NAME.
     *
     * This used to `continue` past anything over the cap, which dropped the
     * entry from the map — and `resolveImages`, finding no bytes under that
     * filename, told the owner the image was «غير موجودة في مجلد images/».
     * That sentence was false: the file was in the ZIP, in front of them, and
     * they had just put it there. They could open the archive, see the picture,
     * and have no way to learn that its SIZE was the problem. The bytes are
     * already decompressed in `entries`, so keeping the reference costs
     * nothing and lets `storeAsset` say the true thing with the real number.
     */
    for (const k of names) {
      if (k === dataName) continue;
      assets.set(k.toLowerCase(), entries[k]);
    }
    return { file: { name, csv: new TextDecoder().decode(entries[dataName]), assets }, categoryId };
  }

  if (bytes.byteLength > MAX_CSV_BYTES) throw badRequest(`The file exceeds ${MAX_CSV_BYTES / 1024 / 1024} MB`);
  return { file: { name, csv: new TextDecoder().decode(bytes), assets: new Map() }, categoryId };
}

/**
 * ONE IMAGE OUT OF THE ZIP, CONVERTED BEFORE IT IS STORED — OR NOT STORED.
 *
 * WHAT THIS WAS DOING. It called the raw R2 writer `putMediaObject` directly
 * and wrote the supplier's JPEG or PNG byte for byte under
 * `products/import/<sha>.<ext>` — three segments where the media layout says
 * four, and no conversion at all, because `lib/imageConvert` was never
 * imported into this file. The REMOTE-URL branch of `resolveImages` had
 * already been moved to the converting door, so the two halves of the same
 * import disagreed: paste a supplier's address into the `image` column and the
 * picture arrived as WebP; put the identical file inside the ZIP and it
 * arrived as the camera wrote it. A 400-file ZIP is one admin click, so this
 * was the biggest single writer of unconverted bytes left in the system.
 *
 * `storeMedia` is that door, and it is REUSED rather than re-implemented:
 * same function, same placement, same four-segment key
 * `products/import/gallery/<sha>.webp` that `ingestImageUrl` produces — so the
 * same photograph supplied both ways now lands on one object instead of two.
 *
 * THE HASH IS STILL OF THE BYTES AS THEY ARRIVED, deliberately: it is what
 * makes the second copy of the same picture in the same ZIP cost a HEAD
 * instead of a conversion, and a converter is not guaranteed to emit identical
 * bytes twice. The probe asks for `.webp` when the format is convertible and
 * for the arrival extension otherwise (GIF and AVIF pass through, by decision
 * — see lib/imageConvert).
 *
 * AND WHAT HAPPENS WHEN CONVERSION FAILS. Never "store it anyway", and never
 * an exception out of a 400-row import either: `storeMedia` THROWS on a
 * converter failure, and an uncaught throw here would have ended the whole
 * preview with a 500 that named no row and no file — the owner's entire
 * afternoon of data entry, refused as one opaque error. Every answer below is
 * a REASON, in three languages; `resolveImages` turns it into a row issue, the
 * row fails with its line number, and every other row in the file still
 * imports. That is what «ويكمل الاستيراد» has to mean.
 */
type AssetOutcome = { ok: true; url: string } | { ok: false; reason: string };

const NOT_AN_IMAGE_REASON = 'ليس ملف صورة صالحًا';

const tooLargeReason = (bytes: number): string =>
  `حجم الصورة ${mb(bytes)} ميغابايت ويتجاوز الحد ${IMAGE_CAP / 1024 / 1024} ميغابايت — صغّرها ثم أعد الاستيراد / ` +
  `the image is ${mb(bytes)} MB and the limit is ${IMAGE_CAP / 1024 / 1024} MB — shrink it and import again / ` +
  `قەبارەی وێنەکە ${mb(bytes)} مێگابایتە و سنوورەکە ${IMAGE_CAP / 1024 / 1024} مێگابایتە — بچووکی بکەرەوە و دووبارە هاوردەی بکە`;

const CONVERT_UNAVAILABLE_REASON =
  'تحويل الصور إلى WebP غير مفعّل على الخادم، فلم نحفظ الصورة إطلاقًا — راجع إعداد Cloudflare Images / ' +
  'WebP conversion is not enabled on this deployment — the image was NOT stored unconverted; check the Cloudflare Images binding / ' +
  'گۆڕینی وێنە بۆ WebP لەم سێرڤەرە چالاک نییە، بۆیە وێنەکەمان هەرگیز هەڵنەگرت — ڕێکخستنی Cloudflare Images بپشکنە';

const CONVERT_FAILED_REASON =
  'تعذّر تحويل هذه الصورة إلى WebP فلم تُخزَّن — جرّب صورة أخرى أو احفظها بصيغة JPEG / ' +
  'this image could not be converted to WebP and was not stored — try another file, or re-save it as JPEG / ' +
  'نەتوانرا ئەم وێنەیە بگۆڕدرێت بۆ WebP بۆیە هەڵنەگیرا — فایلێکی تر تاقی بکەرەوە یان بە JPEG پاشەکەوتی بکە';

async function storeAsset(env: Env, bytes: Uint8Array): Promise<AssetOutcome> {
  const kind = sniff(bytes);
  // A photograph from an iPhone is an ISO-BMFF file with a HEIF brand, which
  // `sniff` deliberately refuses to name rather than storing something no
  // browser here can display. It gets the one message that ends the problem.
  if (!kind) return { ok: false, reason: isHeifBytes(bytes) ? HEIF_REFUSAL : NOT_AN_IMAGE_REASON };
  if (!kind.mime.startsWith('image/')) return { ok: false, reason: NOT_AN_IMAGE_REASON };
  if (bytes.byteLength > IMAGE_CAP) return { ok: false, reason: tooLargeReason(bytes.byteLength) };

  try {
    // The same final-WebP/content-addressed pipeline as uploads and TXT Apply.
    // In particular, static AVIF is converted and animated GIF is refused;
    // neither can escape under an extension chosen from caller metadata.
    const stored = await ingestProductMediaBytes(env, {
      bytes,
      entity_id: 'import',
      cleanup_grace_minutes: PRODUCT_MEDIA_FORM_STAGING_GRACE_MINUTES,
    });
    return { ok: true, url: stored.url };
  } catch (e) {
    if (e instanceof ProductMediaIngestError) {
      if (e.code === 'IMAGE_CONVERT_UNAVAILABLE') return { ok: false, reason: CONVERT_UNAVAILABLE_REASON };
      if (e.code === 'IMAGE_SOURCE_TOO_LARGE') return { ok: false, reason: tooLargeReason(bytes.byteLength) };
      if (e.code === 'IMAGE_CONVERT_FAILED') return { ok: false, reason: CONVERT_FAILED_REASON };
      return { ok: false, reason: e.message };
    }
    console.error(`adminImport: product image was not stored: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, reason: CONVERT_FAILED_REASON };
  }
}

/**
 * Every image cell in the file, resolved to a stored delivery URL.
 *
 * Three legal forms, and nothing else (§2 and §10): a path inside the ZIP, a
 * `/files/...` URL this store already serves (which is what an export writes,
 * so a round-trip re-uses the same object), and a direct image URL, verified
 * by magic bytes.
 *
 * ALL THREE END AT A KEY WE OWN. A URL in a cell is an instruction to FETCH,
 * never a picture to keep pointing at: the bytes are downloaded, converted to
 * WebP and stored here, and `isOwnedMediaUrl` is asked about the result before
 * it may enter the map. The map is what `resolveProduct` reads, so this is the
 * gate that decides what a product image is allowed to be.
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
  const assetOutcomes = new Map<string, AssetOutcome>();
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
      // Already ours; a round-trip of this store's own export must not
      // re-upload. `isOwnedMediaUrl` rather than the prefix alone, so a cell
      // that merely BEGINS with `/files/` and then walks somewhere else
      // (`/files/../…`) is refused here instead of being copied into a product.
      if (!isOwnedMediaUrl(cell)) {
        issues.push({ line, severity: 'error', message: `image: "${cell}" — ${EXTERNAL_IMAGE_REFUSAL}` });
        continue;
      }
      try {
        const key = cell.slice('/files/'.length);
        await verifyStoredProductMedia(env, [{ url: cell, key }]);
        map.set(cell, cell);
      } catch (error) {
        const reason = error instanceof ProductMediaIngestError
          ? error.message
          : 'the stored image could not be verified';
        issues.push({ line, severity: 'error', message: `image: "${cell}" — ${reason}` });
      }
      continue;
    }
    const zipKey = cell.toLowerCase().replace(/^\.?\//, '');
    const bytes =
      assets.get(zipKey) ??
      assets.get(`images/${zipKey}`) ??
      [...assets.entries()].find(([k]) => k.endsWith(`/${zipKey}`))?.[1];
    if (bytes) {
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
      let outcome = assetOutcomes.get(digest);
      if (!outcome) {
        outcome = await storeAsset(env, bytes);
        assetOutcomes.set(digest, outcome);
      }
      if (outcome.ok) map.set(cell, outcome.url);
      else issues.push({ line, severity: 'error', message: `image: "${cell}" ${outcome.reason}` });
      continue;
    }
    if (/^https?:\/\//i.test(cell)) {
      /**
       * FETCH AND CONVERT — the address is never what gets stored.
       *
       * `ingestImageUrl` downloads the bytes, sniffs them, converts them and
       * returns a `/files/…` key. The check on the way out is not paranoia
       * about that function: it is the rule stated where a product image is
       * actually decided, so no future edit to the ingest path can put a
       * supplier's `https://` address into a product the way the three that
       * are live on the A1 today got there.
       */
      const res = await ingestImageUrl(env, cell);
      if (res.status === 'stored' && res.url && isOwnedMediaUrl(res.url)) map.set(cell, res.url);
      else if (res.status === 'stored' && res.url) {
        issues.push({ line, severity: 'error', message: `image: "${cell}" — ${EXTERNAL_IMAGE_REFUSAL}` });
      } else issues.push({ line, severity: 'error', message: `image: "${cell}" — ${res.reason ?? 'تعذّر التحميل'}` });
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
        is_printer_catalog: Number(row.is_printer_catalog) === 1,
      } satisfies CatalogRef;
    },
    catalogs,
    ambiguous.catalogs
  );

  // Brands are NOT read here: `brandResolver` below matches them the TXT way
  // (every row, three names, normalizeText) and plans the ones to create. The
  // empty map is the resolver's fallback for callers that pass no matcher.
  const brands = new Map<string, string>();

  const { results: facetRows } = await db
    .prepare('SELECT id, slug, name_en, name_ar FROM facets WHERE active = 1')
    .all<{ id: string; slug: string; name_en: string; name_ar: string }>();
  const facets = new Map<string, string>();
  registerAliases(facetRows, (f) => f.id, facets, ambiguous.facets);

  // Every product's slug, for the used-listing link. One read: the catalogue
  // is small enough that a map beats a lookup per graded row, and the import
  // already loads the catalogs and brands the same way.
  const { results: slugRows } = await db
    .prepare('SELECT id, slug FROM products')
    .all<{ id: string; slug: string }>();
  const productSlugs = new Map<string, string>(
    (slugRows ?? []).map((r) => [String(r.slug).toLowerCase(), String(r.id)])
  );
  return { brands, catalogs, facets, familyOf: familyMap(rows), images, productSlugs, ambiguous };
}

/**
 * BRANDS IN THE CSV/ZIP LANE RESOLVE THE WAY THE TXT LANE RESOLVES THEM.
 *
 * The owner: «عند استيراد منتج يرفض بسبب أن البراند غير موجود اجعل ينشئ
 * البراند بدل أن يرفض ... بالرغم من هذا فإن البراند موجود مثل بامبو لاب وليفو
 * لكنه يرفض». The TXT import was fixed on both halves; this lane still read
 * `brands WHERE active = 1` through `normKey` (no hamza/ta-marbuta folding, no
 * Sorani name) and refused every miss with «أضفها أولًا».
 *
 * Now: every brand row (inactive included — skipping it would mint a second
 * «Bambu Lab») is matched by `matchRef`, the TXT import's own rule. A name
 * nothing answers to is PLANNED here, once per distinct name, so every row
 * naming it shares one pending id; the confirm writes it (`createPendingBrand`)
 * before any product. Nothing is written by the preview.
 */
async function brandResolver(
  db: D1Database,
  names: string[]
): Promise<{ match: NonNullable<ImportMaps['brandMatch']>; pending: Map<string, PendingBrand> }> {
  const rows = await loadRefRows(db, 'brands');
  const pending = new Map<string, PendingBrand>();
  const pendingKey = (value: string) => normalizeText(value) || normKey(value);
  for (const name of names) {
    const value = name.trim();
    if (!value || matchRef(rows, value).kind !== 'miss') continue;
    const key = pendingKey(value);
    if (!pending.has(key)) pending.set(key, await planBrandCreate(db, value));
  }
  const match: NonNullable<ImportMaps['brandMatch']> = (value) => {
    const hit = matchRef(rows, value);
    if (hit.kind === 'hit') return { kind: 'hit', id: hit.id, warning: inactiveBrandWarning(rows, hit, value.trim()) };
    if (hit.kind === 'ambiguous') return hit;
    const planned = pending.get(pendingKey(value.trim()));
    return planned ? { kind: 'pending', pending: planned } : { kind: 'miss' };
  };
  return { match, pending };
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
  /**
   * 0075 — the stored order-type cells, read whole.
   *
   * A `fulfillment` sheet row states a capacity and an enabled flag and
   * nothing else, but the writer replaces the product's whole cell set — so
   * the merge has to start from the rows as they stand, prices and lead times
   * included. `SELECT *` is deliberate for the same reason the fulfilment
   * endpoint uses it: a column added later rides along instead of being
   * silently dropped on the next spreadsheet save.
   */
  const { results: cellRows } = await db
    .prepare(`SELECT * FROM product_option_fulfillment WHERE product_id IN (${idPh}) ORDER BY sort, id`)
    .bind(...ids)
    .all<Record<string, unknown>>();
  const { results: routeRows } = await db
    .prepare(`SELECT * FROM product_option_transports WHERE product_id IN (${idPh}) ORDER BY sort, id`)
    .bind(...ids)
    .all<Record<string, unknown>>();
  const routesByCell = new Map<string, ExistingRouteRow[]>();
  for (const t of routeRows) {
    const owner = String(t.fulfillment_id ?? '');
    const arr = routesByCell.get(owner);
    const route: ExistingRouteRow = { ...t, method: String(t.method ?? '') };
    if (arr) arr.push(route);
    else routesByCell.set(owner, [route]);
  }

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
      fulfillments: cellRows
        .filter((f) => String(f.product_id) === id)
        .map((f) => {
          const type = String(f.fulfillment_type ?? '');
          return {
            ...f,
            option_id: String(f.option_id ?? ''),
            fulfillment_type: type,
            // SQLite stores the flag as 0/1. `parseFulfillmentPayload` reads
            // `enabled !== false`, so a stored 0 handed straight back would
            // read as TRUE and a spreadsheet that only set a capacity would
            // silently switch a disabled order type back on.
            enabled: f.enabled !== 0,
            // A direct-sale cell has no capacity of its own; a stray stored
            // value (an older Worker during a rolling deploy) is inert to the
            // resolver but would be REFUSED by the payload parser, so it is
            // dropped here rather than turned into a failed import.
            ...(type === 'direct_sale' ? { capacity: null } : {}),
            transports:
              type === 'pre_order'
                ? (routesByCell.get(String(f.id)) ?? []).map((t) => ({ ...t, enabled: t.enabled !== 0 }))
                : [],
          } satisfies ExistingCellRow;
        }),
    };
    // SKU wins over slug when both match different products.
    if (doc.sku) out.set(doc.sku, shape);
    if (!out.has(doc.slug)) out.set(doc.slug, shape);
  }
  return out;
}

/**
 * 0075 — WHAT THIS PRODUCT'S CELLS ARE HOLDING RIGHT NOW, from the shape the
 * preview already loaded.
 *
 * `loadExisting` reads the cell and route rows with `SELECT *`, so `id` and
 * `capacity_reserved` — the two columns a replace must carry across, and the
 * two `refuseStrandedCapacity` judges against — are already in hand. Built
 * with the SAME builder every other door uses (`existingCellsFrom`), because a
 * second idea of "what is held" is a second place to be wrong about a live
 * pre-order.
 */
function heldCellsOf(shape: ExistingShape | null): ExistingCells {
  const cells = shape?.fulfillments ?? [];
  return existingCellsFrom(
    cells.map((f) => ({
      id: String(f.id ?? ''),
      option_id: f.option_id,
      fulfillment_type: f.fulfillment_type,
      capacity_reserved: Number(f.capacity_reserved ?? 0),
    })),
    cells.flatMap((f) =>
      (f.transports ?? []).map((t) => ({
        id: String(t.id ?? ''),
        fulfillment_id: String(f.id ?? ''),
        method: t.method,
        capacity_reserved: Number(t.capacity_reserved ?? 0),
      }))
    )
  );
}

/**
 * 0075 — THE PREVIEW ASKS ABOUT THE COUNTER THE CONFIRM WILL MOVE.
 *
 * The confirm reaches these checks through `planProductSave`, the shared
 * writer that appends the cell statements to the product/relations batch.
 * Both can refuse — a route the file drops while it is holding units, a pool
 * cut under what is already held, a quota cleared to untracked with a live
 * hold against it — and a preview that says nothing about any of them promises
 * an import the confirm then reports as `failed`. So the preview runs the same
 * two functions on the same resolved cells and shows the refusal as this
 * product's error, before anything is written. The confirm still re-checks
 * against the live rows, because the preview's answer can be minutes old and
 * the write is the write.
 */
function cellRefusal(relations: Record<string, unknown>, shape: ExistingShape | null): string | null {
  const values = relationValues(relations);
  const payload = fulfillmentPayloadFrom(values);
  if (!payload) return null;
  try {
    const cells = parseFulfillmentPayload(payload, new Set(values.map((v) => v.id)));
    refuseStrandedCapacity(heldCellsOf(shape), cells);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
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
  const brands = await brandResolver(c.env.DB, parsed.products.map((p) => p.brand ?? ''));
  maps.brandMatch = brands.match;
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
    const stored = existing.get(p.key) ?? null;
    const r = resolveProduct(p, stored, maps, {
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
    // 0075 — the order-type cells this sheet would write, judged here so the
    // preview and the confirm answer about the same counter. See `cellRefusal`.
    const refusedCells = cellRefusal(r.relations, stored);
    if (refusedCells) row.errors.push(refusedCells);
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
      // §18 — carried into the stored payload so the confirm writes exactly
      // what the preview showed, through `saveBenefitRule` and nothing else.
      membership: r.membership,
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

  const importable = resolved.filter((r) => (byKey.get(r.key as string)?.errors.length ?? 0) === 0);
  // Only the brands a row that WILL be written points at: a row refused for
  // another reason must not leave its new brand behind on confirm.
  const usedBrandIds = new Set(importable.map((r) => String((r.doc as { brand_id?: unknown }).brand_id ?? '')));
  const brandsToCreate = [...brands.pending.values()].filter((b) => usedBrandIds.has(b.id));
  const payload = {
    category_id: categoryId,
    family: shape.family,
    section_slugs: shape.sectionSlugs,
    products: importable,
    brands_to_create: brandsToCreate,
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
          created_count, updated_count, skipped_count, failed_count, report, payload, source_name,
          media_stage_until)
       VALUES (?, ?, ?, ?, NULL, 'preview', ?, 0, 0, 0, ?, ?, ?, ?,
               strftime('%Y-%m-%dT%H:%M:%fZ','now', ?))`
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
      file.name.slice(0, 200),
      IMPORT_MEDIA_STAGE_MODIFIER
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
    // The same disclosure the TXT check returns: the brands confirm will add.
    brands_to_create: brandsToCreate.map((b) => ({ name: b.name, slug: b.slug })),
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

interface ImportApplyLease {
  token: string;
  generation: number;
  leaseUntil: string;
}

interface ImportItemCheckpoint {
  import_id: string;
  item_index: number;
  item_key: string;
  line: number;
  product_id: string;
  action: 'created' | 'updated' | 'failed';
  name: string;
  reason: string;
}

const IMPORT_APPLY_LEASE_MINUTES = 5;
const IMPORT_APPLY_LEASE_MODIFIER = `+${IMPORT_APPLY_LEASE_MINUTES} minutes`;

class ImportApplyLeaseLost extends Error {
  constructor() {
    super('The import apply lease was lost; retry the same import id');
    this.name = 'ImportApplyLeaseLost';
  }
}

const checkpointReportRow = (row: ImportItemCheckpoint): ReportRow => ({
  key: row.item_key,
  line: Number(row.line),
  action: row.action,
  name: row.name,
  product_id: row.product_id,
  reason: row.reason,
});

function reportSummary(rows: readonly ReportRow[]) {
  return {
    created: rows.filter((row) => row.action === 'created').length,
    updated: rows.filter((row) => row.action === 'updated').length,
    skipped: rows.filter((row) => row.action === 'skipped').length,
    failed: rows.filter((row) => row.action === 'failed').length,
  };
}

function previewSkippedRows(raw: unknown): ReportRow[] {
  let rows: PreviewRow[] = [];
  try {
    const parsed = JSON.parse(String(raw || '[]')) as unknown;
    if (Array.isArray(parsed)) rows = parsed as PreviewRow[];
  } catch {
    return [];
  }
  return rows
    .filter((row) => row.action === 'failed')
    .map((row) => ({
      key: row.key,
      line: row.line,
      action: 'skipped' as const,
      name: row.name,
      product_id: '',
      reason: row.errors.join(' | '),
    }));
}

async function acquireImportApplyLease(db: D1Database, importId: string): Promise<ImportApplyLease | null> {
  const token = newId('impapply');
  const row = await db
    .prepare(
      `UPDATE product_imports
          SET apply_token = ?,
              apply_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now', ?),
              media_stage_until = MAX(
                media_stage_until,
                strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
              ),
              apply_generation = apply_generation + 1
        WHERE id = ? AND state = 'preview'
          AND (apply_token = '' OR apply_lease_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        RETURNING apply_token, apply_lease_until, apply_generation`
    )
    .bind(token, IMPORT_APPLY_LEASE_MODIFIER, IMPORT_APPLY_LEASE_MODIFIER, importId)
    .first<{ apply_token: string; apply_lease_until: string; apply_generation: number }>();
  return row
    ? { token: row.apply_token, leaseUntil: row.apply_lease_until, generation: Number(row.apply_generation) }
    : null;
}

async function renewImportApplyLease(db: D1Database, importId: string, token: string): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE product_imports
          SET apply_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now', ?),
              media_stage_until = MAX(
                media_stage_until,
                strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
              )
        WHERE id = ? AND state = 'preview' AND apply_token = ?
          AND apply_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')
        RETURNING id`
    )
    .bind(IMPORT_APPLY_LEASE_MODIFIER, IMPORT_APPLY_LEASE_MODIFIER, importId, token)
    .first<{ id: string }>();
  return !!row;
}

async function ownsImportApplyLease(db: D1Database, importId: string, token: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS owned FROM product_imports
        WHERE id = ? AND state = 'preview' AND apply_token = ?
          AND apply_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .bind(importId, token)
    .first<{ owned: number }>();
  return !!row;
}

async function requireImportApplyLease(db: D1Database, importId: string, token: string): Promise<void> {
  if (!(await renewImportApplyLease(db, importId, token))) throw new ImportApplyLeaseLost();
}

async function releaseImportApplyLease(db: D1Database, importId: string, token: string): Promise<void> {
  await db
    .prepare(
      `UPDATE product_imports SET apply_token = '', apply_lease_until = ''
        WHERE id = ? AND state = 'preview' AND apply_token = ?`
    )
    .bind(importId, token)
    .run();
}

async function loadImportItemCheckpoints(db: D1Database, importId: string): Promise<Map<number, ImportItemCheckpoint>> {
  const { results } = await db
    .prepare('SELECT * FROM product_import_items WHERE import_id = ? ORDER BY item_index')
    .bind(importId)
    .all<ImportItemCheckpoint>();
  return new Map((results ?? []).map((row) => [Number(row.item_index), row]));
}

async function loadImportItemCheckpoint(
  db: D1Database,
  importId: string,
  itemIndex: number
): Promise<ImportItemCheckpoint | null> {
  return db
    .prepare('SELECT * FROM product_import_items WHERE import_id = ? AND item_index = ?')
    .bind(importId, itemIndex)
    .first<ImportItemCheckpoint>();
}

function importItemCheckpointStatement(
  db: D1Database,
  importId: string,
  itemIndex: number,
  token: string,
  row: ReportRow
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO product_import_items
         (import_id, item_index, item_key, line, product_id, action, name, reason, apply_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(importId, itemIndex, row.key, row.line, row.product_id, row.action, row.name, row.reason, token);
}

adminImportRoutes.post('/confirm', async (c) => {
  const admin = c.get('user')!;
  const money = canViewFinancials(c.env, admin);
  const body = (await c.req.json().catch(() => ({}))) as { import_id?: unknown };
  const importId = str(body.import_id, 'import_id', { min: 1, max: 60 });

  let rec = await c.env.DB
    .prepare('SELECT * FROM product_imports WHERE id = ?')
    .bind(importId)
    .first<Record<string, unknown>>();
  if (!rec) throw notFound('No import with that id');
  if (rec.actor_user_id && rec.actor_user_id !== admin.id) {
    throw forbidden('This import was prepared by another admin');
  }

  const replay = (stored: Record<string, unknown>) =>
    c.json({
      success: true,
      import_id: importId,
      already_applied: true,
      summary: {
        created: stored.created_count,
        updated: stored.updated_count,
        skipped: stored.skipped_count,
        failed: stored.failed_count,
      },
      rows: JSON.parse(String(stored.report || '[]')),
    });

  // Terminal retries are pure reads. No lease is acquired and no audit,
  // product or report row is written twice.
  if (rec.state === 'applied') return replay(rec);

  /**
   * ONE EXECUTOR PER IMPORT, WITH CRASH RECOVERY.
   *
   * The token lives on the import domain row rather than in process memory.
   * A second confirm cannot enter while it is live (409); after a Worker dies,
   * its lease expires and the retry gets a new token/generation. Every product
   * batch is fenced by the checkpoint trigger in migration 0099, so an old
   * Worker waking after takeover aborts its whole batch rather than publishing
   * a stale plan.
   */
  const lease = await acquireImportApplyLease(c.env.DB, importId);
  if (!lease) {
    const latest = await c.env.DB
      .prepare('SELECT * FROM product_imports WHERE id = ?')
      .bind(importId)
      .first<Record<string, unknown>>();
    if (latest?.state === 'applied') return replay(latest);
    throw conflict(
      'هذا الاستيراد قيد التطبيق الآن / this import is already being applied; retry the same import id shortly',
      'IMPORT_APPLY_IN_PROGRESS'
    );
  }

  try {
    // Re-read after acquiring: the record is now a stable payload owned by
    // this token, and a winner that finalized between our first read and CAS
    // is answered as a replay rather than re-executed.
    rec = await c.env.DB
      .prepare('SELECT * FROM product_imports WHERE id = ?')
      .bind(importId)
      .first<Record<string, unknown>>();
    if (!rec) throw notFound('No import with that id');
    if (rec.state === 'applied') return replay(rec);

    const payload = JSON.parse(String(rec.payload || '{}')) as {
      products?: Array<Record<string, unknown>>;
      brands_to_create?: PendingBrand[];
    };
    const products = payload.products ?? [];
    const previewSkipped = previewSkippedRows(rec.report);
    const checkpoints = await loadImportItemCheckpoints(c.env.DB, importId);
    const reviewNeeded: string[] = [];

    /**
     * THE BRANDS THE PREVIEW DISCLOSED ARE WRITTEN HERE, BEFORE ANY PRODUCT.
     *
     * `createPendingBrand` re-resolves by name first, so a brand somebody added
     * by hand since the preview — or this same confirm resumed after a crash —
     * is found, not inserted twice. Each product's `brand_id` is re-pointed
     * from the id the preview reserved to the row that actually exists. A name
     * that became ambiguous in between fails only the rows naming it.
     */
    const brandRemap = new Map<string, string>();
    const brandRefused = new Map<string, string>();
    const brandsCreated: Array<{ id: string; name: string; slug: string; created: boolean }> = [];
    const pendingInUse = new Set(
      products
        .filter((_, index) => !checkpoints.has(index))
        .map((item) => String((item.doc as { brand_id?: unknown } | undefined)?.brand_id ?? ''))
    );
    for (const pending of payload.brands_to_create ?? []) {
      if (!pendingInUse.has(pending.id)) continue;
      await requireImportApplyLease(c.env.DB, importId, lease.token);
      const made = await createPendingBrand(c.env.DB, pending, { adminId: admin.id, via: 'product.import.confirm' });
      if ('ambiguous' in made) {
        brandRefused.set(pending.id, `${ambiguousMessage('brand', pending.name)} — ${made.ambiguous.join('، ')}`);
        continue;
      }
      brandRemap.set(pending.id, made.id);
      brandsCreated.push({ id: made.id, name: pending.name, slug: made.slug, created: made.created });
    }

    /**
     * PRE-FLIGHT THE COMPLETE SET, THEN RE-VERIFY EACH ITEM JUST IN TIME.
     *
     * The first pass preserves the useful all-file diagnosis before catalogue
     * writes begin. It cannot be the attachment lease: on a 500-row import,
     * protection acquired for row 1 may expire while rows 2..500 decode. The
     * second call immediately before that row's plan reacquires the global
     * cleanup guard and re-reads R2. A cleanup that won in between therefore
     * yields a failed checkpoint, never a dangling product_images reference.
     */
    const prepared = new Map<number, {
      doc: ProductDoc | null;
      relationsBody: Record<string, unknown> | null;
      error: unknown | null;
    }>();
    for (const [index, item] of products.entries()) {
      if (checkpoints.has(index)) continue;
      await requireImportApplyLease(c.env.DB, importId, lease.token);
      try {
        const stored = item.doc as Record<string, unknown>;
        const reserved = String(stored.brand_id ?? '');
        const refused = brandRefused.get(reserved);
        if (refused) throw new Error(refused);
        const remapped = brandRemap.get(reserved);
        const doc = validateProductDoc(remapped ? { ...stored, brand_id: remapped } : stored);
        doc.id = String(item.productId ?? '');
        const relationsBody = item.relations && typeof item.relations === 'object'
          ? (item.relations as Record<string, unknown>)
          : {};
        const relationImages = Array.isArray(relationsBody.images)
          ? (relationsBody.images as Array<Record<string, unknown>>)
          : [];
        await verifyAndNormalizeProductMedia(c.env, doc, relationImages);
        prepared.set(index, { doc, relationsBody, error: null });
      } catch (error) {
        prepared.set(index, { doc: null, relationsBody: null, error });
      }
    }

    for (const [index, item] of products.entries()) {
      if (checkpoints.has(index)) continue;
      const key = String(item.key ?? '');
      const line = Number(item.line ?? 0);
      const productId = String(item.productId ?? '');
      const isCreate = item.action === 'create';
      let outcome: ReportRow | null = null;

      try {
        await requireImportApplyLease(c.env.DB, importId, lease.token);
        const ready = prepared.get(index);
        if (!ready || ready.error) throw ready?.error ?? new Error('Import item was not prepared');
        const doc = ready.doc!;
        const relationsBody = ready.relationsBody!;
        const relationImages = Array.isArray(relationsBody.images)
          ? (relationsBody.images as Array<Record<string, unknown>>)
          : [];
        // The preflight guard may be old by now. This is the protection whose
        // lifetime covers the actual product batch.
        await verifyAndNormalizeProductMedia(c.env, doc, relationImages);

        const catalogIds = withClassificationPlacements((item.catalogIds as string[]) ?? [], doc);
        await applyPrinterWarrantyRules(c.env.DB, doc, catalogIds);
        if (isCreate) doc.slug = await uniqueProductSlug(c.env.DB, doc.name_en || key || productId);

        const prevRow = isCreate
          ? null
          : await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first<Record<string, unknown>>();
        const prevDoc = prevRow ? parseProductRow(prevRow) : null;
        const localized = localizeRespectingAuthored(doc, prevDoc);
        const plan = await planProductSave(c.env.DB, {
          mode: isCreate ? 'create' : 'update',
          doc,
          prev: prevDoc,
          relations: relationsBody,
          catalogIds,
          actor: { adminId: admin.id, money },
          translations: localized.fields,
        });

        // Membership is planned BEFORE the first write. Rule, version and
        // audit statements follow the product INSERT/UPDATE in this SAME
        // ProductSavePlan batch; there is no side-effect writer afterwards.
        const membership = await planProductMembershipRules(
          c.env.DB,
          admin.id,
          productId,
          (item.membership as ParsedMembershipRule[]) ?? []
        );
        plan.statements.push(...membership.statements);

        outcome = {
          key,
          line,
          action: isCreate ? 'created' : 'updated',
          name: doc.name_en,
          product_id: productId,
          reason: '',
        };
        // Last in the atomic batch. Its trigger checks the exact live token
        // and lease; a stale executor aborts every preceding product/member
        // statement. The row is also the crash-resume completion marker.
        plan.statements.push(importItemCheckpointStatement(c.env.DB, importId, index, lease.token, outcome));
        await requireImportApplyLease(c.env.DB, importId, lease.token);
        await saveProductAtomic(c.env.DB, plan);
        checkpoints.set(index, {
          import_id: importId,
          item_index: index,
          item_key: key,
          line,
          product_id: productId,
          action: outcome.action as 'created' | 'updated',
          name: outcome.name,
          reason: '',
        });
        if (localized.review_needed.length) reviewNeeded.push(`${key}: ${localized.review_needed.join(', ')}`);
      } catch (error) {
        // A transport can report an error after D1 committed. Never turn that
        // uncertain outcome into a false failure or repeat a CREATE: the
        // checkpoint shares the product transaction, so read it first.
        const committed = await loadImportItemCheckpoint(c.env.DB, importId, index);
        if (committed) {
          checkpoints.set(index, committed);
          continue;
        }
        if (
          error instanceof ImportApplyLeaseLost ||
          /IMPORT_APPLY_LEASE_LOST/.test(error instanceof Error ? error.message : String(error)) ||
          !(await ownsImportApplyLease(c.env.DB, importId, lease.token))
        ) {
          throw new ImportApplyLeaseLost();
        }

        outcome = {
          key,
          line,
          action: 'failed',
          name: key,
          product_id: productId,
          reason: error instanceof Error ? error.message : String(error),
        };
        // Planning/verification failed before a product write, or D1 rolled
        // the attempted product batch back. Persist that terminal result under
        // the same lease fence so a later Worker resumes after it.
        try {
          await requireImportApplyLease(c.env.DB, importId, lease.token);
          await c.env.DB.batch([
            importItemCheckpointStatement(c.env.DB, importId, index, lease.token, outcome),
          ]);
        } catch (checkpointError) {
          const recovered = await loadImportItemCheckpoint(c.env.DB, importId, index);
          if (recovered) {
            checkpoints.set(index, recovered);
            continue;
          }
          if (!(await ownsImportApplyLease(c.env.DB, importId, lease.token))) {
            throw new ImportApplyLeaseLost();
          }
          throw checkpointError;
        }
        checkpoints.set(index, {
          import_id: importId,
          item_index: index,
          item_key: key,
          line,
          product_id: productId,
          action: 'failed',
          name: outcome.name,
          reason: outcome.reason,
        });
      }
    }

    const completed = [...checkpoints.values()]
      .sort((a, b) => Number(a.item_index) - Number(b.item_index))
      .map(checkpointReportRow);
    if (completed.length !== products.length) {
      throw new Error(`Import checkpoint count ${completed.length} did not match payload count ${products.length}`);
    }
    const report = [...completed, ...previewSkipped];
    const summary = reportSummary(report);
    await requireImportApplyLease(c.env.DB, importId, lease.token);

    let finalized: Record<string, unknown> | null = null;
    try {
      finalized = await c.env.DB
        .prepare(
          `UPDATE product_imports
              SET state = 'applied', created_count = ?, updated_count = ?, skipped_count = ?,
                  failed_count = ?, report = ?, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                  apply_token = '', apply_lease_until = '', media_stage_until = ''
            WHERE id = ? AND state = 'preview' AND apply_token = ?
              AND apply_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')
            RETURNING *`
        )
        .bind(
          summary.created,
          summary.updated,
          summary.skipped,
          summary.failed,
          JSON.stringify(report),
          importId,
          lease.token
        )
        .first<Record<string, unknown>>();
    } catch (error) {
      const latest = await c.env.DB.prepare('SELECT * FROM product_imports WHERE id = ?').bind(importId).first<Record<string, unknown>>();
      if (latest?.state === 'applied') return replay(latest);
      throw error;
    }
    if (!finalized) throw new ImportApplyLeaseLost();

    await audit(c.env.DB, admin.id, 'product.import.apply', importId, {
      ...summary,
      cost_written: money,
      generation: lease.generation,
      brands_created: brandsCreated.filter((b) => b.created).map((b) => b.id),
    });

    return c.json({
      success: true,
      import_id: importId,
      summary,
      rows: report,
      translation_review_needed: reviewNeeded,
      brands_created: brandsCreated,
    });
  } catch (error) {
    if (
      error instanceof ImportApplyLeaseLost ||
      /IMPORT_APPLY_LEASE_LOST/.test(error instanceof Error ? error.message : String(error))
    ) {
      const latest = await c.env.DB.prepare('SELECT * FROM product_imports WHERE id = ?').bind(importId).first<Record<string, unknown>>();
      if (latest?.state === 'applied') return replay(latest);
      throw conflict(
        'انتهت ملكية تطبيق هذا الاستيراد؛ أعد المحاولة بنفس المعرّف / import apply ownership changed; retry the same import id',
        'IMPORT_APPLY_LEASE_LOST'
      );
    }
    throw error;
  } finally {
    try {
      await releaseImportApplyLease(c.env.DB, importId, lease.token);
    } catch (error) {
      console.error('import apply lease release failed', importId, error);
    }
  }
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
