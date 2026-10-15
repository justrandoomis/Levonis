/**
 * THE DOCUMENT OF A PRODUCT THE CATALOGUE IMPORT CREATES (Bambu import spec
 * §A.4 step 3, §C.9, §C.10 layer 3; docs/DECISIONS.md rows 239 and 241).
 *
 * Built from DEFAULTS, through the app's own validator:
 *
 *   newImportProductDoc(fields) =
 *     validateProductDoc({ ...allowListedFields, price_iqd: 0 }, { costBlind: true })
 *
 * `price_iqd: 0` is the column's default (0001: NOT NULL DEFAULT 0) — the
 * validator requires the key, and the new row holds exactly what the schema
 * would hold without it. Every other money key is ABSENT, so the validator's
 * defaults apply: no price, cost, compare-at price, surcharge, stock,
 * threshold, package measure, warranty plan or base months, ops policy,
 * delivery rule, condition grade, SKU, label, payment option, featured flag or
 * pre-order route can come from the source. An unpriced product shows no
 * number (catalog-only, row 240): its price is derived, never this column.
 *
 * Only the keys of `ImportDocFields` are read, whatever the caller's object
 * carries (a cast cannot smuggle `stock` through), and the result is checked
 * once more by `importDocDefaultsViolations` before it is returned: a field
 * that is not at its default throws, so a future validator default that
 * starts inventing a value fails here and in tests/catalogImportDoc.test.ts,
 * not in production.
 */
import { validateProductDoc, type ContentBlockV2, type ProductDoc, type SpecGroupV2, type TranslationMeta, type UsageGuideV2 } from '../productModel';
import { DIMENSION_FIELDS } from '../physicalDimensions';

/** The ONLY fields an import may give a new product (§A.4: allow-listed fields only). */
export interface ImportDocFields {
  id: string;
  slug: string;
  status: 'active' | 'hidden' | 'draft';
  name_en: string;
  name_ar: string;
  name_ckb: string;
  description_en: string;
  description_ar?: string;
  description_ckb?: string;
  brand_id: string | null;
  category_id: string | null;
  sub_category_id: string | null;
  template_family: 'devices' | 'materials' | null;
  spec_fields: Record<string, string>;
  spec_groups: SpecGroupV2[];
  content_blocks: ContentBlockV2[];
  usage_guide: UsageGuideV2;
  translation_meta?: TranslationMeta;
}

/** The keys `newImportProductDoc` reads — nothing else reaches the validator. */
export const IMPORT_DOC_FIELD_KEYS = [
  'id',
  'slug',
  'status',
  'name_en',
  'name_ar',
  'name_ckb',
  'description_en',
  'description_ar',
  'description_ckb',
  'brand_id',
  'category_id',
  'sub_category_id',
  'template_family',
  'spec_fields',
  'spec_groups',
  'content_blocks',
  'usage_guide',
  'translation_meta',
] as const satisfies ReadonlyArray<keyof ImportDocFields>;

/** Builds the new product's document from the allow-listed fields and the schema defaults. */
export function newImportProductDoc(fields: ImportDocFields): ProductDoc {
  const src = fields as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const k of IMPORT_DOC_FIELD_KEYS) if (src[k] !== undefined) body[k] = src[k];
  const doc = validateProductDoc({ ...body, price_iqd: 0 }, { costBlind: true });
  const wrong = importDocDefaultsViolations(doc);
  if (wrong.length) throw new Error(`IMPORT_DOC_NOT_DEFAULT: ${wrong.join(', ')}`);
  return doc;
}

/**
 * Every money, stock, package, warranty, ops, offer and condition field of a
 * document that is NOT at its schema default (or null). Empty for a document
 * `newImportProductDoc` built; the test asserts the list field by field.
 */
export function importDocDefaultsViolations(doc: ProductDoc): string[] {
  const out: string[] = [];
  const must = (name: string, ok: boolean) => {
    if (!ok) out.push(name);
  };
  // Money.
  must('price_iqd', doc.price_iqd === 0);
  must('pro_price_iqd', doc.pro_price_iqd === null);
  must('prime_price_iqd', doc.prime_price_iqd === null);
  must('product_cost_iqd', doc.product_cost_iqd === null);
  must('original_price_iqd', doc.original_price_iqd === null);
  must('direct_surcharge_iqd', doc.direct_surcharge_iqd === null);
  // Stock.
  must('stock', doc.stock === null);
  must('low_stock_threshold', doc.low_stock_threshold === null);
  // Package and product measures (0098): Pricing V2 freight inputs.
  for (const f of DIMENSION_FIELDS) must(`dimensions.${f}`, (doc.dimensions as unknown as Record<string, unknown>)[f] === null);
  // Warranty.
  must('warranty_plans', Array.isArray(doc.warranty_plans) && doc.warranty_plans.length === 0);
  must('warranty_base_months', doc.warranty_base_months === null);
  must('serialized', doc.serialized === null);
  // Ops.
  must('ops_policy', !!doc.ops_policy && typeof doc.ops_policy === 'object' && Object.keys(doc.ops_policy).length === 0);
  must('delivery_options', (doc.delivery_options ?? null) === null);
  // Offer: what is sold, how, and what it is shown with.
  must('composition', doc.composition === '');
  must('sale_types', doc.sale_types.length === 1 && doc.sale_types[0] === 'direct_sale');
  must('selling_type', doc.selling_type === 'direct_sale');
  must('preorder_transports', Array.isArray(doc.preorder_transports) && doc.preorder_transports.length === 0);
  must('labels', Array.isArray(doc.labels) && doc.labels.length === 0);
  must('payment_options', Array.isArray(doc.payment_options) && doc.payment_options.length === 0);
  must('is_featured', doc.is_featured === false);
  must('display_order', doc.display_order === 0);
  must('gini_url', doc.gini_url === '');
  must('light_image', doc.light_image === '');
  must('hashtags', Array.isArray(doc.hashtags) && doc.hashtags.length === 0);
  must('sku', doc.sku === null);
  // Options, colours and media are the relations' (the planner mirrors them), never the document's.
  must('options', doc.options.length === 0);
  must('colors', doc.colors.length === 0);
  must('media', doc.media.length === 0);
  // Condition (open box / used / refurbished): a new product is NEW.
  must('condition', doc.condition === null);
  return out;
}
