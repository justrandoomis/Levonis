import {
  productImageForSelection as resolveProductImageForSelection,
  productVariantIdForSelection,
} from '@levonis/pricing/productSelectionMedia';
import { canonicalProductMediaUrl, primaryMediaFirst, type ProductDoc } from './productModel';
import {
  isActiveProductImageRow,
  type ImageRow,
  type ProductRelationsView,
  type VariantRow,
} from './productOverlay';

export interface ProductImageSelection {
  optionValueIds: string[];
  colorId: string | null;
}

/** D1 deployments have historically used a 100-bound-parameter ceiling. */
const PRODUCT_IMAGE_BATCH = 80;

/**
 * Resolve directly from the authoritative relation rows.
 *
 * This is intentionally separate from the legacy ProductDoc adapter below:
 * list/card readers must never resurrect `products.images` merely because all
 * relation rows were quarantined (or because no safe row survived). The
 * canonical-row predicate rejects external URLs, URL/key mismatches and
 * quarantine provenance before the shared selection resolver sees them.
 */
export function productImageFromRelations(
  images: readonly ImageRow[],
  selection: ProductImageSelection = { optionValueIds: [], colorId: null },
  variants: readonly VariantRow[] = []
): string {
  const media = primaryMediaFirst(
    images
      .filter(isActiveProductImageRow)
      .map((image) => ({
        url: image.url,
        primary: image.is_primary === 1,
        order: image.sort_order,
        option_value_id: image.option_value_id,
        color_id: image.color_id,
        variant_id: image.variant_id,
      }))
  );
  const variantId = productVariantIdForSelection(variants, {
    optionValueIds: selection.optionValueIds,
    colorId: selection.colorId,
  });
  return resolveProductImageForSelection(media, {
    optionValueIds: selection.optionValueIds,
    colorId: selection.colorId,
    variantId,
  })?.url ?? '';
}

/**
 * One bounded relation read for product cards, chunked below D1's parameter
 * ceiling. Missing/rolling relation schema fails closed to an empty image;
 * the stale JSON mirror is never a fallback or a hotlink source.
 */
export async function loadAuthoritativeProductImages(
  db: D1Database,
  productIds: readonly string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(productIds.map(String).filter(Boolean))];
  const result = new Map(ids.map((id) => [id, '']));

  for (let offset = 0; offset < ids.length; offset += PRODUCT_IMAGE_BATCH) {
    const chunk = ids.slice(offset, offset + PRODUCT_IMAGE_BATCH);
    try {
      const { results } = await db
        .prepare(
          `SELECT * FROM product_images
            WHERE product_id IN (${chunk.map(() => '?').join(', ')})
            ORDER BY product_id, sort_order, id`
        )
        .bind(...chunk)
        .all<ImageRow>();
      const byProduct = new Map<string, ImageRow[]>();
      for (const image of results ?? []) {
        const rows = byProduct.get(image.product_id);
        if (rows) rows.push(image);
        else byProduct.set(image.product_id, [image]);
      }
      for (const id of chunk) result.set(id, productImageFromRelations(byProduct.get(id) ?? []));
    } catch (error) {
      // Authority being unavailable is not permission to use an unverified
      // mirror. Cards remain useful without a thumbnail and recover after the
      // migration/read outage does.
      console.error(
        `product image authority unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return result;
}

/**
 * One image precedence rule for cart, checkout and immutable order snapshots:
 * exact modelled combination → selected colour → selected option →
 * product primary. `product_images`/`doc.media` is the only authoritative
 * image source; the legacy option/color image columns are intentionally not
 * consulted here.
 */
export function productImageForSelection(
  doc: ProductDoc,
  selection: ProductImageSelection,
  view?: ProductRelationsView | null
): string {
  // A real loaded view always carries `images`, including an empty array. In
  // that case the rows are authoritative and an empty/quarantined gallery is
  // genuinely empty. The fallback only supports callers with no relation
  // view (and old partial fixtures that predate the images member).
  if (view && Array.isArray(view.images)) {
    return productImageFromRelations(view.images, selection, view.variants ?? []);
  }
  const media = primaryMediaFirst(doc.media);
  const variantId = view
    ? productVariantIdForSelection(view.variants, {
        optionValueIds: selection.optionValueIds,
        colorId: selection.colorId,
      })
    : null;

  return resolveProductImageForSelection(media, {
    optionValueIds: selection.optionValueIds,
    colorId: selection.colorId,
    variantId,
  })?.url ?? '';
}

/**
 * «الصورة الرئيسية للوضع الفاتح» (0138) for a set of products, for the readers
 * that select explicit product columns (the compare page) rather than `*`.
 * Only products that HAVE one are in the map. A database still before 0138
 * answers "no such column", which is read as "no light images yet" — the
 * cards then show the main image in both themes, exactly as before.
 */
export async function loadLightProductImages(
  db: D1Database,
  productIds: readonly string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(productIds.map(String).filter(Boolean))];
  const result = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += PRODUCT_IMAGE_BATCH) {
    const chunk = ids.slice(offset, offset + PRODUCT_IMAGE_BATCH);
    try {
      const { results } = await db
        .prepare(
          `SELECT id, light_image FROM products
            WHERE light_image <> '' AND id IN (${chunk.map(() => '?').join(', ')})`
        )
        .bind(...chunk)
        .all<{ id: string; light_image: string }>();
      for (const row of results ?? []) {
        const url = canonicalProductMediaUrl(row.light_image);
        if (url) result.set(String(row.id), url);
      }
    } catch {
      return result;
    }
  }
  return result;
}
