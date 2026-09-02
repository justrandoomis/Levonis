/**
 * Admin product editor (v2) — local API contract types + form helpers.
 * Mirrors worker/routes/adminProducts.ts, template.ts and extract.ts exactly.
 * All money is IQD integers; null = inherit, 0 = explicit (never truthiness).
 */

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
    content_blocks: [],
    translation_meta: {},
    is_featured: false,
    display_order: 0,
    payment_options: [],
    hashtags: [],
    how_to_use: '',
    usage_guide: { official_url: '', steps: [] },
    catalog_ids: [],
  };
}

/** Normalize a loaded admin doc into a complete EditorDoc (arrays present). */
export function toEditorDoc(p: Partial<ProductDocV2> & { catalog_ids?: string[] }): EditorDoc {
  const b = blankDoc();
  return {
    ...b,
    ...p,
    preorder_transports: p.preorder_transports ?? [],
    direct_surcharge_iqd: p.direct_surcharge_iqd ?? null,
    media: p.media ?? [],
    options: p.options ?? [],
    colors: p.colors ?? [],
    spec_groups: p.spec_groups ?? [],
    labels: p.labels ?? [],
    warranty_plans: p.warranty_plans ?? [],
    content_blocks: p.content_blocks ?? [],
    translation_meta: p.translation_meta ?? {},
    payment_options: p.payment_options ?? [],
    hashtags: p.hashtags ?? [],
    usage_guide: p.usage_guide ?? { official_url: '', steps: [] },
    catalog_ids: p.catalog_ids ?? [],
  } as EditorDoc;
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

export interface ParseResponse {
  product_id: string | null;
  is_create: boolean;
  errors: TemplateError[];
  warnings: string[];
  unknown_keys: string[];
  needs_review: NeedsReviewEntry[];
  validation_error: { message: string; code?: string } | null;
  applied_fields: string[];
  cleared_fields: string[];
  preserved_fields: string[];
  preview: (ProductDocV2 & Record<string, unknown>) | null;
  diff: DiffEntry[];
}

export interface ApplyResponse {
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
  warnings: string[];
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
  validation_error?: { message: string; code?: string } | null;
  applied_fields?: string[];
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
