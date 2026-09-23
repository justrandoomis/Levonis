/**
 * Admin product editor (v2) — local API contract types + form helpers.
 * Mirrors worker/routes/adminProducts.ts, template.ts and extract.ts exactly.
 * All money is IQD integers; null = inherit, 0 = explicit (never truthiness).
 */

import { emptyDimensions } from '../../lib/productTypes';
import type {
  ProductDocV2,
  ResolvedPriceV2,
  BrandV2,
  CatalogV2,
  TranslationMetaV2,
} from '../../lib/productTypes';

// ---------------------------------------------------------------- editor doc

/** The editor form state: the canonical doc + catalog placement. */
export type EditorDoc = ProductDocV2 & { catalog_ids: string[] };

export const defaultProductDeliveryOptions = () => ({
  standard: { enabled: true, quantity_step: 1, fee_iqd: 5000 },
  personal: { enabled: true, quantity_step: 1, fee_iqd: 10000 },
});

let localCounter = 0;
export function uid(prefix: string): string {
  localCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${localCounter}`;
}

export function blankDoc(): EditorDoc {
  return {
    id: '',
    slug: '',
    status: 'draft',
    doc_version: 2,
    content_rev: 1,
    name_ar: '', name_en: '', name_ckb: '',
    description_ar: '', description_en: '', description_ckb: '',
    price_iqd: 0,
    pro_price_iqd: null,
    prime_price_iqd: null,
    product_cost_iqd: null,
    selling_type: 'direct_sale',
    sale_types: ['direct_sale'],
    preorder_transports: [],
    direct_surcharge_iqd: null,
    stock: null,
    low_stock_threshold: null,
    brand_id: null,
    category_id: null,
    sub_category_id: null,
    template_family: null,
    sku: null,
    spec_fields: {},
    media: [],
    options: [],
    colors: [],
    spec_groups: [],
    labels: [],
    warranty_plans: [],
    warranty_base_months: null,
    serialized: null,
    // null = NEW. Sent explicitly so the admin route can tell "this form
    // un-graded the listing" from "this client never had the field".
    condition: null,
    dimensions: emptyDimensions(),
    delivery_options: defaultProductDeliveryOptions(),
    content_blocks: [],
    translation_meta: {},
    is_featured: false,
    display_order: 0,
    payment_options: [],
    gini_url: '',
    hashtags: [],
    how_to_use: '',
    how_to_use_ar: '',
    how_to_use_ckb: '',
    usage_guide: { official_url: '', steps: [] },
    catalog_ids: [],
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/**
 * Normalize a loaded admin doc into a complete EditorDoc (arrays present).
 *
 * EVERY FIELD THE SERVER STORES REACHES THE FORM STATE. The document is the
 * one `GET /api/admin/products-v2/:id` returns; nothing here may drop, rename
 * or default a stored value (docs/TXT_IMPORT_PARITY.md §2). The only
 * substitutions are shape repairs for a field the server left absent or null:
 * an absent array is an empty array, an absent object is an empty object, and
 * an empty `sale_types` falls back to the legacy `selling_type` scalar so a
 * product never renders with no sale type when the row still states one.
 */
export function toEditorDoc(p: Partial<ProductDocV2> & { catalog_ids?: string[] }): EditorDoc {
  const b = blankDoc();
  const sellingType = p.selling_type ?? b.selling_type;
  const saleTypes = list<EditorDoc['sale_types'][number]>(p.sale_types);
  const guide = p.usage_guide && typeof p.usage_guide === 'object' ? p.usage_guide : b.usage_guide;
  return {
    ...b,
    ...p,
    name_ar: str(p.name_ar),
    name_en: str(p.name_en),
    name_ckb: str(p.name_ckb),
    description_ar: str(p.description_ar),
    description_en: str(p.description_en),
    description_ckb: str(p.description_ckb),
    how_to_use: str(p.how_to_use),
    how_to_use_ar: str(p.how_to_use_ar),
    how_to_use_ckb: str(p.how_to_use_ckb),
    gini_url: str(p.gini_url),
    selling_type: sellingType,
    sale_types: saleTypes.length > 0 ? saleTypes : [sellingType],
    preorder_transports: list(p.preorder_transports),
    direct_surcharge_iqd: p.direct_surcharge_iqd ?? null,
    stock: p.stock ?? null,
    low_stock_threshold: p.low_stock_threshold ?? null,
    spec_fields: p.spec_fields && typeof p.spec_fields === 'object' ? p.spec_fields : {},
    media: list(p.media),
    options: list(p.options),
    colors: list(p.colors),
    spec_groups: list(p.spec_groups),
    labels: list(p.labels),
    warranty_plans: list<EditorDoc['warranty_plans'][number]>(p.warranty_plans).map((w) => ({ ...w, fee_percent: w.fee_percent ?? null })),
    warranty_base_months: p.warranty_base_months ?? null,
    serialized: p.serialized ?? null,
    condition: p.condition ?? null,
    dimensions: { ...emptyDimensions(), ...(p.dimensions ?? {}) },
    delivery_options: p.delivery_options ?? null,
    content_blocks: list(p.content_blocks),
    translation_meta: p.translation_meta ?? {},
    payment_options: list<string>(p.payment_options).filter((x) => typeof x === 'string'),
    hashtags: list<string>(p.hashtags).filter((x) => typeof x === 'string'),
    usage_guide: { official_url: str(guide.official_url), steps: list(guide.steps) },
    catalog_ids: list<string>(p.catalog_ids),
  } as EditorDoc;
}

/**
 * The stored text the form has no input for (Arabic and Kurdish names and
 * descriptions — the form is English-only, §3). Listed so the editor can show
 * them as preserved instead of letting the owner conclude they were lost.
 */
export function importedTexts(doc: EditorDoc): Array<{ key: string; label: string; value: string }> {
  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'name_ar', label: 'الاسم (عربي)', value: doc.name_ar },
    { key: 'name_ckb', label: 'الاسم (كردي)', value: doc.name_ckb },
    { key: 'description_ar', label: 'الوصف (عربي)', value: doc.description_ar },
    { key: 'description_ckb', label: 'الوصف (كردي)', value: doc.description_ckb },
  ];
  return rows.filter((r) => r.value.trim() !== '');
}

/** One stored group the form has no editor for, rendered as read-only lines. */
export interface PreservedGroup {
  key: 'spec_groups' | 'labels' | 'content_blocks';
  label: string;
  count: number;
  lines: string[];
}

const firstText = (...xs: Array<string | undefined | null>): string => xs.find((x) => typeof x === 'string' && x.trim() !== '')?.trim() ?? '';

/**
 * The document groups ProductForm has no input for — spec groups, labels,
 * content blocks, payment options (docs/TXT_IMPORT_PARITY.md §2.7, §2.12,
 * §2.5). They are stored, they reach the form state, and until an editor
 * exists the form SHOWS them as preserved ("edit via the TXT template") so the
 * owner never concludes an import lost them. Only groups that hold something
 * are returned; nothing is invented for an empty one.
 */
export function preservedGroups(doc: EditorDoc): PreservedGroup[] {
  const out: PreservedGroup[] = [];
  if (doc.spec_groups.length > 0) {
    out.push({
      key: 'spec_groups',
      label: 'مجموعات المواصفات',
      count: doc.spec_groups.length,
      lines: doc.spec_groups.map((g) => {
        const title = firstText(g.title_en, g.title_ar, g.title_ckb, g.id);
        const rows = (g.rows ?? []).map((r) => {
          const label = firstText(r.label_en, r.label_ar, r.label_ckb, r.id);
          const value = firstText(r.value_en, r.value_ar, r.value_ckb);
          return `${label}: ${value}${r.unit ? ` ${r.unit}` : ''}`;
        });
        return `${title} (${rows.length}) — ${rows.join(' · ')}`;
      }),
    });
  }
  if (doc.labels.length > 0) {
    out.push({
      key: 'labels',
      label: 'الشارات',
      count: doc.labels.length,
      lines: doc.labels.map(
        (l) => `${l.key || l.id}: ${firstText(l.text_en, l.text_ar, l.text_ckb)}${l.visible === false ? ' (مخفية)' : ''}`
      ),
    });
  }
  if (doc.content_blocks.length > 0) {
    out.push({
      key: 'content_blocks',
      label: 'كتل المحتوى',
      count: doc.content_blocks.length,
      lines: doc.content_blocks.map((b) => {
        const text = firstText(b.body_en, b.body_ar, b.body_ckb, b.caption_en, b.caption_ar, b.caption_ckb, b.url, b.media_key);
        return `${b.kind}: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`;
      }),
    });
  }
  // NOT payment_options: it has one home, in section 4 beside the other
  // selling fields (`data-form="payment-options-preserved"`). Listing it here
  // as well showed the same list twice under two different labels, which is a
  // departure from the form's design, not extra honesty.
  return out;
}

/**
 * The stored spec ids the section's template does not declare. They are
 * stored and returned (the TXT template accepts any `spec.<id>`), so the form
 * renders them beside the template's fields instead of hiding them behind
 * the section's field list (parity root cause 9).
 */
export function specIdsOutsideTemplate(specFields: Record<string, string> | undefined, templateIds: Iterable<string>): string[] {
  const known = new Set(templateIds);
  return Object.keys(specFields ?? {}).filter((id) => !known.has(id));
}

// ---------------------------------------------------------------- listing

export interface ListingItem {
  id: string;
  slug: string;
  status: 'draft' | 'active' | 'hidden';
  name_ar: string;
  name_en: string;
  price_iqd: number;
  pro_price_iqd: number | null;
  stock: number | null;
  is_featured: boolean;
  brand_id: string | null;
  sku: string | null;
  image: string;
  updated_at: string;
  doc_version: number;
  created_at: string | null;
  /** Units sold across non-cancelled orders (list projection only). */
  sold: number;
  stock_reserved?: number;
  low_stock_threshold?: number | null;
  /** True only when at least one enabled direct-sale route exists. Direct
   *  products always carry a numeric stock (zero means sold out); null is
   *  reserved for products that are pre-order-only. */
  has_direct_sale?: boolean;
}

export interface ListingResponse {
  total: number;
  limit: number;
  offset: number;
  products: ListingItem[];
}

export interface ProductResponse {
  product: ProductDocV2 & { catalog_ids: string[] };
}

export interface SaveResponse {
  created: boolean;
  product: ProductDocV2 & { catalog_ids: string[] };
}

export interface DeleteResponse {
  archived: boolean;
  deleted: boolean;
  reason?: string;
  /** Permanent path only — measured by the server, not asserted by the client. */
  permanent?: boolean;
  already_deleted?: boolean;
  product_deleted?: boolean;
  rows_deleted_by_table?: Record<string, number>;
  rows_unlinked_by_table?: Record<string, number>;
  r2_objects_deleted?: string[];
  r2_objects_shared_skipped?: string[];
  r2_cleanup_pending?: number;
  cache_keys_invalidated?: string[];
}

export interface BrandsResponse { brands: BrandV2[] }
export interface BrandResponse { brand: BrandV2 }
export interface CatalogsResponse { catalogs: CatalogV2[] }

// ---------------------------------------------------------------- quote

export interface QuoteResponse {
  quote: ResolvedPriceV2 & {
    cost_iqd?: number | null;
    usd_preview: {
      exchange_rate_iqd_per_usd: number;
      applied_usd: number;
      unit_subtotal_usd: number;
    };
  };
}

// ---------------------------------------------------------------- template

export interface TemplateError { line: number; key: string; message: string }
export interface NeedsReviewEntry { key: string; line: number; value: string; message: string }
export interface DiffEntry { field: string; before: string | null; after: string | null }

/**
 * A brand the file names that does not exist yet and the import WILL create.
 *
 * It is NOT an error and NOT a warning the server writes a sentence for: it is
 * the disclosure that replaced «brands are never silently created», carried as
 * data so the panel can state it in the language the panel is already in.
 */
export interface BrandToCreate { name: string; slug: string }

export interface ParseResponse {
  product_id: string | null;
  is_create: boolean;
  errors: TemplateError[];
  warnings: string[];
  unknown_keys: string[];
  needs_review: NeedsReviewEntry[];
  /** Absent from an older server's answer, so always read it defensively. */
  brands_to_create?: BrandToCreate[];
  validation_error: { message: string; code?: string } | null;
  applied_fields: string[];
  cleared_fields: string[];
  preserved_fields: string[];
  preview: (ProductDocV2 & Record<string, unknown>) | null;
  diff: DiffEntry[];
  /** What the apply WILL do with the spec sheet and the stock level — stated
   *  by the check step, before anything is written. */
  spec_fields?: ApplySpecReport | null;
  inventory_mode?: string;
}

/** Counts read back from the relation tables AFTER the write — never from the file. */
export interface ApplyRelationSummary {
  groups: number;
  values: number;
  colors: number;
  links: number;
  variants: number;
  images: number;
  primary_image: string | null;
  inventory_mode: string;
}

/**
 * What the file asked for versus what the read-back holds, per collection.
 * `requested` is null when the apply wrote no structure at all (an update
 * that touched none) — a null is "not asked", never "zero stored".
 */
export interface ApplyCount {
  requested: number | null;
  stored: number;
}

/**
 * The spec sheet as the server checked it against the section the form will
 * render (`specSheetReport`, worker/routes/template.ts): what is stored, how
 * much of it the section's template shows, and the ids it does not.
 */
export interface ApplySpecReport {
  stored: number;
  visible_in_form: number;
  outside_section: string[];
  family: string | null;
  warnings: string[];
}

export type ApplyMismatchSection =
  | 'scalars'
  | 'options'
  | 'colors'
  | 'images'
  | 'variants'
  | 'spec'
  | 'catalogs'
  | 'inventory'
  | 'slug';

/** One requested value the read-back does not hold. Any of these = the apply FAILED. */
export interface ApplyMismatch {
  section: ApplyMismatchSection;
  key: string;
  requested: unknown;
  stored: unknown;
}

/**
 * `POST /api/admin/template/apply` — the verified result (docs/TXT_IMPORT_PARITY.md
 * §5.2). Every count comes from re-reading the product through the same two
 * endpoints ProductForm uses, after the batch committed; parser success alone
 * is never reported as success.
 *
 * The blocks after `warnings` are the read-back. They are OPTIONAL on the type
 * for one honest reason: the confirm-once answer (`already_applied`) carries
 * the relation counts of the product the FIRST submission wrote and nothing
 * else, and an older worker carries none at all. A reader must therefore be
 * able to say "the server did not report this" — it must never print 0.
 */
export interface ApplyResponse {
  success: true;
  created: boolean;
  /** true when the confirm-once guard recognised this exact batch and
   *  returned the product the FIRST confirm produced (nothing was written). */
  already_applied?: boolean;
  /** content fingerprint of the batch, shown in the import report. */
  fingerprint?: string;
  product_id: string;
  product: ProductDocV2 | null;
  applied_fields: string[];
  cleared_fields: string[];
  preserved_fields: string[];
  /** Keys the registry does not define — parsed, reported, never silently dropped. */
  unknown_keys: string[];
  warnings: string[];
  relations: ApplyRelationSummary | null;
  spec_fields?: ApplySpecReport;
  images?: ApplyCount;
  option_groups?: ApplyCount;
  option_values?: ApplyCount;
  colors?: ApplyCount;
  mismatches: ApplyMismatch[];
  /** Side effects the form save performs and the apply now performs too. */
  price_history_rows?: number;
  hashtags_registered?: number;
  translation_review_needed?: string[];
}

/**
 * A REFUSED apply, exactly as the route sends it — at the top level of the
 * body, which is why `ApiError` carries the body beside `details`.
 * `APPLY_VERIFY_FAILED` (HTTP 500) means the batch committed and the read-back
 * disagreed: `section`/`field`/`expected`/`stored` name the first difference,
 * `mismatches` lists them all, and `product_id` is the product that exists (it
 * is null for a create, which the route removes again).
 */
export interface ApplyVerifyFailure {
  code?: string;
  error?: string;
  section?: string;
  field?: string | null;
  expected?: unknown;
  stored?: unknown;
  product_id?: string | null;
  created?: boolean;
  mismatches?: ApplyMismatch[];
  relations?: ApplyRelationSummary | null;
  spec_fields?: ApplySpecReport;
  images?: ApplyCount;
  option_groups?: ApplyCount;
  option_values?: ApplyCount;
  colors?: ApplyCount;
  /** Row-level validation messages (`RELATIONS_VALIDATION`, `TEMPLATE_ERRORS`). */
  errors?: Array<string | TemplateError>;
  /** Unresolved references — the write was refused before anything was written. */
  needs_review?: NeedsReviewEntry[];
  /** What the apply did with the brands the check disclosed. `created: false`
   *  means the row already existed by the time the write came round. */
  brands_created?: Array<{ id: string; name: string; slug: string; created: boolean }>;
  warnings?: string[];
  unknown_keys?: string[];
}

export interface ZipFileResult {
  name: string;
  ok: boolean;
  ready_to_apply: boolean;
  product_id?: string | null;
  is_create?: boolean;
  errors: TemplateError[];
  warnings: string[];
  unknown_keys: string[];
  needs_review: NeedsReviewEntry[];
  brands_to_create?: BrandToCreate[];
  validation_error?: { message: string; code?: string } | null;
  applied_fields?: string[];
  spec_fields?: ApplySpecReport | null;
  inventory_mode?: string;
  summary?: { name_ar: string; name_en: string; price_iqd: number } | null;
}

export interface ZipParseResponse {
  files: ZipFileResult[];
  skipped_entries: string[];
  skipped_over_limit: string[];
  /** Whole-archive tally so the report can account for EVERY entry, not just
   *  the ones that parsed. */
  counts?: {
    parsed: number;
    ready: number;
    not_ready: number;
    skipped_not_txt: number;
    skipped_over_limit: number;
    limit: number;
  };
}

export type DuplicateChoice = 'update_existing' | 'create_hidden_draft_new_identity';

// ---------------------------------------------------------------- misc

export type TransStatus = 'approved' | 'imported' | 'stale' | 'missing';

export function transStatusOf(
  meta: TranslationMetaV2 | undefined,
  field: string,
  lang: 'en' | 'ckb'
): TransStatus {
  const entry = meta?.[field]?.[lang];
  return entry?.status ?? 'missing';
}
