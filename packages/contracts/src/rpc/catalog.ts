/**
 * Catalog's RPC surface (`01-TARGET.md` §2.4) — the core's `CatalogEntrypoint`
 * until Phase 5, then the Catalog deployable.
 */
import type { HealthReport, RpcCtx } from './common';

export interface CartLine {
  product_id: string;
  qty: number;
  option_value_id?: string | null;
  color_id?: string | null;
  variant_id?: string | null;
}

/** The priced, availability-checked view of a cart line (`packages/pricing` inside). */
export interface CartProduct {
  product_id: string;
  slug: string;
  status: string;
  is_printer: boolean;
  unit_price_iqd: number;
  regular_price_iqd: number;
  shipping_type: string;
  available: number | null;
  warranty_plans: Array<{ id: string; fee_iqd: number; total_months: number | null }>;
}

export interface IndexRow {
  product_id: string;
  slug: string;
  status: string;
  names: { ar: string; en: string; ckb: string };
  hashtags: string[];
  catalog_ids: string[];
  brand_id: string | null;
  price_iqd: number | null;
  doc_version: number;
}

export interface CatalogApi {
  getProductsForCart(lines: CartLine[], ctx: RpcCtx & { tier?: string | null }): Promise<CartProduct[]>;
  isPrinterCatalog(catalogId: string, ctx: RpcCtx): Promise<boolean>;
  /** Cursor-paged backfill for Search (Phase 4i). */
  listForIndex(cursor: string | null, ctx: RpcCtx): Promise<{ rows: IndexRow[]; next: string | null }>;
  health(): Promise<HealthReport>;
}
