/**
 * Frontend mirror of the canonical product document (worker/lib/productModel.ts)
 * plus the resolver result shape. Shared by the editor, storefront pages and
 * the template import UI so every surface agrees on field names.
 */

export type Lang = 'ar' | 'en' | 'ckb';

export interface PriceFieldsV2 {
  regular_price_iqd: number | null;
  /** LEVO PRIME price (mandate §5). Compare-at was removed in the same
   *  mandate (§4) — no strikethrough price is derived anywhere. */
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null; // admin-only; absent from public payloads
  /**
   * 0044 adjustments — a signed dinar delta on the value the row would
   * otherwise inherit. Null (or absent) on every row written before 0044.
   * Mirrors packages/pricing/src/pricing.ts PriceFields.
   */
  regular_adjust_iqd?: number | null;
  prime_adjust_iqd?: number | null;
  pro_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
}

/**
 * One option as the ADMIN document carries it. The fields after `active` are
 * the ones the server's OptionV2 (packages/pricing/src/pricing.ts) declares
 * for the admin surfaces: the TXT template writes them into the product
 * document, the overlay copies them from the relational rows, and the editor
 * reads them when a product has a document but no relation rows yet.
 */
export interface OptionV2 extends PriceFieldsV2 {
  id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  image: string;
  order: number;
  active: boolean;
  /** 0043 — '' or absent = inherit the product's sale types. */
  availability_type?: '' | 'direct_sale' | 'pre_order';
  lead_time_text?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  variant_key?: string;
  variant_label?: string;
  /** Sellable units at this level; null = this level does not track stock. */
  stock?: number | null;
  /** The option GROUP this value belongs to, by English name. */
  group_en?: string;
  sku_part?: string;
  low_stock_threshold?: number | null;
}

export interface ColorV2 extends PriceFieldsV2 {
  id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  hex: string;
  image: string;
  option_id: string | null;
  order: number;
  active: boolean;
  /** EVERY option this colour is sold with; `option_id` holds it only when
   *  there is exactly one. */
  option_ids?: string[];
  stock?: number | null;
  low_stock_threshold?: number | null;
  sku_part?: string;
}

export interface MediaV2 {
  id: string;
  url: string;
  key: string;
  role: 'gallery';
  alt_ar: string;
  alt_en: string;
  alt_ckb: string;
  order: number;
  primary: boolean;
  width: number | null;
  height: number | null;
  source_url: string;
  /** What the picture is of — at most one is set; '' = general gallery image.
   *  Carried by the server's MediaV2 since 0048. */
  option_value_id?: string;
  color_id?: string;
  variant_id?: string;
}

export interface SpecRowV2 {
  id: string;
  label_ar: string; label_en: string; label_ckb: string;
  value_ar: string; value_en: string; value_ckb: string;
  unit: string;
  order: number;
}

export interface SpecGroupV2 {
  id: string;
  title_ar: string; title_en: string; title_ckb: string;
  order: number;
  rows: SpecRowV2[];
}

export interface LabelV2 {
  id: string;
  key: string;
  text_ar: string; text_en: string; text_ckb: string;
  icon: string;
  order: number;
  visible: boolean;
}

export interface WarrantyPlanV2 {
  id: string;
  title_ar: string; title_en: string; title_ckb: string;
  terms_ar: string; terms_en: string; terms_ckb: string;
  /** Printers: 12 or 24 (an extension over the 12-month base → 24 / 36 total). */
  duration_months: number;
  duration_kind: 'total' | 'extension';
  /** Fixed fee (IQD); the charged amount when `fee_percent` is null. */
  fee_iqd: number;
  /** Fee as a share of the printer's REGULAR price (7.5 = 7.5%), rounded to
   *  an integer dinar by the server — the same for every membership. */
  fee_percent: number | null;
  order: number;
  active: boolean;
}

/**
 * A plan as a storefront surface receives it: the server has already resolved
 * the fee against the selection's regular price and computed the total months.
 * Nothing here is browser arithmetic.
 */
export interface PricedWarrantyPlan extends WarrantyPlanV2 {
  basis_iqd: number;
  base_months: number | null;
  total_months: number | null;
}

export interface TransportOfferV2 {
  method: 'air' | 'sea' | 'land';
  commission_iqd: number | null; // null = inherit admin default
  active: boolean;
}

export interface UsageStepV2 {
  id: string;
  kind: 'setup' | 'usage';
  title: string;
  body: string;
  images: string[];
  video_url: string;
  link_url: string;
  order: number;
}

export interface UsageGuideV2 {
  official_url: string;
  steps: UsageStepV2[];
}

export interface ProductDeliveryRuleV2 {
  enabled: boolean;
  quantity_step: number;
  fee_iqd: number;
}

export interface ProductDeliveryOptionsV2 {
  standard: ProductDeliveryRuleV2;
  personal: ProductDeliveryRuleV2;
}

export interface ContentBlockV2 {
  id: string;
  kind: 'text' | 'image' | 'video_embed';
  order: number;
  body_ar: string; body_en: string; body_ckb: string;
  caption_ar: string; caption_en: string; caption_ckb: string;
  alt_ar: string; alt_en: string; alt_ckb: string;
  url: string;
  media_key: string;
}

export interface TranslationMetaV2 {
  [field: string]: {
    en?: { status: 'approved' | 'imported' | 'stale' | 'missing'; src_rev: number };
    ckb?: { status: 'approved' | 'imported' | 'stale' | 'missing'; src_rev: number };
  };
}

export interface ProductDocV2 {
  id: string;
  slug: string;
  status: 'draft' | 'active' | 'hidden';
  doc_version: number;
  content_rev: number;
  name_ar: string; name_en: string; name_ckb: string;
  description_ar: string; description_en: string; description_ckb: string;
  price_iqd: number;
  pro_price_iqd: number | null;
  prime_price_iqd: number | null;
  /** Compare-at strikethrough; stored and carried by the editor, no input. */
  original_price_iqd?: number | null;
  product_cost_iqd: number | null; // admin-only
  /** Legacy scalar kept in sync with sale_types[0]. */
  selling_type: 'direct_sale' | 'pre_order' | 'bundle';
  /** §6: multi-select sale types. */
  sale_types: Array<'direct_sale' | 'pre_order' | 'bundle'>;
  preorder_transports: TransportOfferV2[];
  /** Availability premium for direct (from-stock) fulfilment; the customer
   *  sees only the final price. NULL/0 = none. */
  direct_surcharge_iqd: number | null;
  stock: number | null;
  low_stock_threshold: number | null;
  brand_id: string | null;
  /** §4: the main section and its sub-section (catalogs rows). */
  category_id: string | null;
  sub_category_id: string | null;
  /** 'devices' | 'materials' | null = inherit from the section. */
  template_family: string | null;
  sku: string | null;
  /** §10: values for the spec fields the section's template declares. */
  spec_fields: Record<string, string>;
  media: MediaV2[];
  images?: string[]; // public projection compatibility
  options: OptionV2[];
  colors: ColorV2[];
  spec_groups: SpecGroupV2[];
  labels: LabelV2[];
  warranty_plans: WarrantyPlanV2[];
  /** Base coverage in months from delivery (printers default to 12); null =
   *  not configured. Stored in products.ops_policy. */
  warranty_base_months: number | null;
  /** Whether a unit is recorded per physical device at delivery (the record an
   *  extended warranty attaches to). null = not stated; printers default true. */
  serialized: boolean | null;
  /** null = legacy global tariff; object = product-owned allow-list + fee tiers. */
  delivery_options?: ProductDeliveryOptionsV2 | null;
  content_blocks: ContentBlockV2[];
  translation_meta?: TranslationMetaV2;
  is_featured: boolean;
  display_order: number;
  payment_options: string[];
  hashtags: string[];
  how_to_use: string;
  /** Structured setup/usage steps; how_to_use stays the plain-text fallback. */
  usage_guide: UsageGuideV2;
  catalog_ids?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface BrandV2 {
  id: string;
  slug: string;
  name_ar: string; name_en: string; name_ckb: string;
  active: boolean;
}

export interface CatalogV2 {
  id: string;
  parent_id: string | null;
  slug: string;
  name_ar: string; name_en: string; name_ckb: string;
  sort: number;
  is_printer_catalog: boolean;
  active: boolean;
}

export interface ResolvedPriceV2 {
  regular_iqd: number;
  pro_iqd: number | null;
  prime_iqd: number | null;
  applied_iqd: number;
  applied_tier: 'regular' | 'pro' | 'prime';
  price_source: 'color' | 'option' | 'base';
  transport: { method: string; commission_iqd: number; waived: boolean } | null;
  warranty: ResolvedWarrantyV2 | null;
  unit_subtotal_iqd: number;
  errors: string[];
}

/** The chosen plan as the resolver reports it (and as the order freezes it). */
export interface ResolvedWarrantyV2 {
  plan_id: string;
  title_ar: string;
  title_en?: string;
  fee_iqd: number;
  duration_months: number;
  duration_kind: string;
  fee_percent?: number | null;
  basis_iqd?: number;
  base_months?: number | null;
  total_months?: number | null;
}

export interface MembershipPlanV2 {
  id: string;
  tier: 'plus' | 'pro' | 'prime';
  duration_months: number;
  price_iqd: number | null; // null = unpriced → not purchasable yet
  active: boolean;
  sort: number;
}

export interface MembershipV2 {
  id: string;
  plan_id: string;
  tier: 'plus' | 'pro' | 'prime';
  state: 'pending_payment' | 'prepaid_pending_launch' | 'active' | 'expired' | 'cancelled';
  duration_months: number;
  price_paid_iqd: number;
  purchased_at: string;
  starts_at: string | null;
  expires_at: string | null;
  source: string;
}

/** Localized field access with the honest Arabic fallback (mandate §2). */
export function locField(obj: Record<string, unknown>, base: string, lang: Lang): string {
  const exact = obj[`${base}_${lang}`];
  if (typeof exact === 'string' && exact.trim()) return exact;
  const ar = obj[`${base}_ar`];
  if (typeof ar === 'string' && ar.trim()) return ar;
  const en = obj[`${base}_en`];
  return typeof en === 'string' ? en : '';
}
