/**
 * The merchant catalogue API (worker/routes/merchantCatalog.ts), typed.
 *
 * Lives beside the editor rather than in src/lib/merchant.ts so none of it
 * reaches the storefront's bundle: a shopper never downloads the manager.
 * Every figure here is the server's — the editor sends a variant's price and
 * stock as the MERCHANT'S INPUT, and the server decides what a customer pays.
 */
import { api } from '../../../lib/api';
import type { Attributes } from '../../../../packages/catalog/src/attributes';
import type { GroupKind } from '../../../../packages/catalog/src/variants';
import type { PublishState } from '../../../../packages/catalog/src/lifecycle';

export type { PublishState };

export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  description: string;
  description_ar: string;
  images: string[];
  price_iqd: number;
  original_price_iqd: number | null;
  compare_at_iqd: number | null;
  sku: string;
  stock: number;
  track_stock: boolean;
  category: string;
  condition: string;
  prep_days: number;
  state: PublishState;
  lifecycle: string;
  sold_out: boolean;
  /** Published but unpurchasable: no price above 0 (owner decision 2026-09-25); absent from an older server. */
  price_required?: boolean;
  low_stock: boolean;
  low_stock_threshold: number | null;
  variant_mode: 'simple' | 'variants' | 'legacy';
  variant_count: number;
  price_range: { min: number; max: number } | null;
  legacy_note: string | null;
  options: unknown[];
  colors: unknown[];
  delivery_methods: string[];
  attributes: Attributes;
  collection_ids: string[];
  section_id: string | null;
  featured: boolean;
  sold_count: number;
  view_count: number;
  moderation: { hidden_by_admin: boolean; reason: string; at: string } | null;
  created_at: string;
  updated_at: string;
}

export interface CatalogMedia {
  id?: string;
  kind: 'image' | 'video';
  key: string;
  url: string;
  alt: string;
  alt_ar: string;
}

export interface CatalogGroup {
  id: string;
  name: string;
  name_ar: string;
  kind: GroupKind;
  values: Array<{ id: string; name: string; name_ar: string; swatch: string }>;
}

export interface CatalogVariant {
  id: string;
  value_ids: string[];
  label: string;
  price_iqd: number | null;
  compare_at_iqd: number | null;
  stock: number;
  sku: string;
  active: boolean;
  image_key: string | null;
  low_stock_threshold: number | null;
}

export interface CatalogProductDetail extends CatalogProduct {
  media: CatalogMedia[];
  option_groups: CatalogGroup[];
  variants: CatalogVariant[];
}

export type CollectionKind = 'manual' | 'featured' | 'new_arrivals' | 'best_sellers';

export interface Collection {
  id: string;
  name: string;
  name_ar: string;
  kind: CollectionKind;
  description: string;
  description_ar: string;
  image_url: string | null;
  image_key: string | null;
  sort_order: number;
  active: boolean;
  product_count?: number;
}

export interface CatalogStats {
  totals: {
    total: number;
    published: number;
    draft: number;
    hidden: number;
    archived: number;
    out_of_stock: number;
    low_stock: number;
    views: number;
    sold: number;
  };
  categories: string[];
}

export interface ProductInsights {
  views: number;
  views_source: 'analytics' | 'counter';
  units_sold: number;
  revenue_iqd: number;
  orders: number;
  by_variant: Array<{ variant_id: string; label: string; units: number; revenue_iqd: number }>;
  daily: Array<{ day: string; units: number; revenue_iqd: number }>;
  views_daily: Array<{ day: string; views: number; add_to_cart: number }>;
}

export interface ImportReport {
  confirmed: boolean;
  created: number;
  rows: number;
  valid: number;
  invalid: number;
  errors: Array<{ row: number; field: string; code: string }>;
  products: Array<{ row: number; handle: string; name: string; variants: number; price_iqd: number }>;
}

export type BulkAction =
  | 'publish' | 'hide' | 'archive' | 'draft' | 'delete' | 'set_price' | 'set_stock'
  | 'feature' | 'unfeature' | 'add_to_collection' | 'remove_from_collection';

export interface BulkResult {
  action: BulkAction;
  done: number;
  results: Array<{ id: string; ok: boolean; code?: string }>;
}

/** What the editor sends. The server validates every key (PRODUCT_INVALID lists each wrong one). */
export interface ProductBody {
  name?: string;
  description?: string;
  price_iqd?: number;
  compare_at_iqd?: number | null;
  sku?: string;
  stock?: number;
  track_stock?: boolean;
  category?: string;
  condition?: string;
  prep_days?: number;
  low_stock_threshold?: number | null;
  state?: PublishState;
  featured?: boolean;
  attributes?: Partial<Attributes>;
  media?: Array<{ key: string; alt: string; alt_ar: string }>;
  collection_ids?: string[];
  variant_model?: {
    groups: Array<{ ref: string; name: string; name_ar: string; kind: GroupKind; values: Array<{ ref: string; name: string; name_ar: string; swatch: string }> }>;
    variants: Array<{
      values: string[];
      price_iqd: number | null;
      compare_at_iqd: number | null;
      stock: number;
      sku: string;
      active: boolean;
      image_key: string | null;
      low_stock_threshold: number | null;
    }>;
  } | null;
}

export interface ListQuery {
  q?: string;
  state?: string;
  stock?: string;
  collection?: string;
  variants?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
}

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

export const catalogApi = {
  list: (q: ListQuery) =>
    api.get<{ products: CatalogProduct[]; total: number; next_cursor: string | null }>(
      `/api/merchant/products?${qs({ ...q, limit: q.limit ?? 30 })}`
    ),
  stats: () => api.get<CatalogStats>('/api/merchant/products/stats'),
  get: (id: string) => api.get<{ product: CatalogProductDetail }>(`/api/merchant/products/${encodeURIComponent(id)}`),
  create: (body: ProductBody) => api.post<{ product: CatalogProductDetail }>('/api/merchant/products', body),
  update: (id: string, body: ProductBody) =>
    api.patch<{ product: CatalogProductDetail }>(`/api/merchant/products/${encodeURIComponent(id)}`, body),
  duplicate: (id: string) => api.post<{ product: CatalogProductDetail }>(`/api/merchant/products/${encodeURIComponent(id)}/duplicate`),
  remove: (id: string) => api.delete<{ archived: boolean }>(`/api/merchant/products/${encodeURIComponent(id)}`),
  insights: (id: string) =>
    api.get<{ product: CatalogProductDetail; insights: ProductInsights }>(`/api/merchant/products/${encodeURIComponent(id)}/insights`),
  bulk: (action: BulkAction, ids: string[], extra: Record<string, unknown> = {}) =>
    api.post<BulkResult>('/api/merchant/products/bulk', { action, ids, ...extra }),
  importCsv: (csv: string, confirm: boolean) => api.post<ImportReport>('/api/merchant/products/import', { csv, confirm }),

  collections: () => api.get<{ collections: Collection[] }>('/api/merchant/collections'),
  createCollection: (body: Partial<Collection>) => api.post<{ collection: Collection }>('/api/merchant/collections', body),
  updateCollection: (id: string, body: Partial<Collection>) => api.patch(`/api/merchant/collections/${encodeURIComponent(id)}`, body),
  deleteCollection: (id: string) => api.delete(`/api/merchant/collections/${encodeURIComponent(id)}`),
  collectionProducts: (id: string) =>
    api.get<{ products: CatalogProduct[] }>(`/api/merchant/collections/${encodeURIComponent(id)}/products`),
  orderCollection: (id: string, productIds: string[]) =>
    api.put(`/api/merchant/collections/${encodeURIComponent(id)}/products`, { product_ids: productIds }),

  /** The platform's material vocabulary (the same list the print matcher reads). */
  materials: () =>
    api.get<{ materials: Array<{ id: string; name_en: string; name_ar: string }> }>('/api/merchant/printers').then((d) => d.materials ?? []),
};
