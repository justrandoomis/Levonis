/**
 * WHAT ONE STORE CART LINE COSTS AND WHETHER IT CAN BE SOLD — the one answer
 * the add door (worker/routes/cart.ts), the merchant cart, and the store
 * checkout (worker/routes/storeOrders.ts) all ask, so they cannot disagree.
 *
 * THE SERVER PRICES THE CHOSEN VARIANT (docs/MERCHANT_PLATFORM.md §2 decision
 * 8). A line names a variant by id; its price is the variant's override or
 * the product's price, read from the database — a client never sends a price
 * and nothing it sends is read as one. A variant of another product, an
 * inactive one, or none at all on a product that has variants, is refused.
 *
 * Products not on the variant model (`simple`, and `legacy` ones still sold by
 * their pre-0126 JSON) keep the wave-1 rule exactly: an option or colour id
 * must name an entry of the product's own lists (`merchantVariantLabel`), and
 * the price is the product's.
 */
import { merchantVariantLabel } from '../storeOrderOps';
import { variantLabelSql } from './sql';

/**
 * Columns to add to a SELECT that joins `community_products p` and
 * `cart_items ci`, plus the LEFT JOIN that brings the chosen variant — only a
 * variant of THIS product.
 */
export const LINE_VARIANT_COLUMNS = `p.variant_mode AS variant_mode, p.low_stock_threshold AS p_threshold,
  ci.variant_id AS ci_variant_id, v.id AS v_id, v.price_iqd AS v_price, v.stock AS v_stock, v.active AS v_active,
  v.sku AS v_sku, v.image_key AS v_image, v.low_stock_threshold AS v_threshold, ${variantLabelSql('v')} AS v_label`;
export const LINE_VARIANT_JOIN = `LEFT JOIN community_product_variants v ON v.id = ci.variant_id AND v.product_id = p.id`;

export type LineVerdict =
  | {
      ok: true;
      /** Whole dinars, from the database. */
      unit: number;
      /** The order snapshot: the merchant's own words for the choice. */
      label: string;
      variantId: string | null;
      sku: string;
      /** `/files/<key>` of the variant's picture, when it has one. */
      image: string | null;
      /** The stock this line draws on: the variant's, or the product's. */
      stock: number;
      /** The low-stock line in force for that stock (the variant's own, else the product's). */
      threshold: number | null;
    }
  | { ok: false; code: 'VARIANT_REQUIRED' | 'VARIANT_UNAVAILABLE' | 'OPTION_UNAVAILABLE'; which?: 'option' | 'color' };

const n = (v: unknown) => Math.max(0, Math.trunc(Number(v) || 0));

export function resolveCatalogLine(r: Record<string, unknown>): LineVerdict {
  const productPrice = n(r.price_iqd);
  const productThreshold = r.p_threshold === null || r.p_threshold === undefined ? null : Number(r.p_threshold);
  if (r.variant_mode === 'variants') {
    if (!r.ci_variant_id) return { ok: false, code: 'VARIANT_REQUIRED' };
    if (!r.v_id || Number(r.v_active) !== 1) return { ok: false, code: 'VARIANT_UNAVAILABLE' };
    return {
      ok: true,
      unit: r.v_price === null || r.v_price === undefined ? productPrice : n(r.v_price),
      label: String(r.v_label ?? ''),
      variantId: String(r.v_id),
      sku: String(r.v_sku ?? ''),
      image: r.v_image ? `/files/${String(r.v_image)}` : null,
      stock: Number(r.v_stock) || 0,
      threshold: r.v_threshold === null || r.v_threshold === undefined ? productThreshold : Number(r.v_threshold),
    };
  }
  // Not a variant product: a variant id on its line names nothing it sells.
  if (r.ci_variant_id) return { ok: false, code: 'VARIANT_UNAVAILABLE' };
  const legacy = merchantVariantLabel(r.options, r.colors, String(r.option_id ?? ''), String(r.color_id ?? ''));
  if (!legacy.ok) return { ok: false, code: 'OPTION_UNAVAILABLE', which: legacy.which };
  return {
    ok: true,
    unit: productPrice,
    label: legacy.label,
    variantId: null,
    sku: String(r.sku ?? ''),
    image: null,
    stock: Number(r.stock) || 0,
    threshold: productThreshold,
  };
}
