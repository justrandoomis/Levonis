import { comboKey } from './inventory';
import { primaryMedia, primaryMediaFirst, type ProductDoc } from './productModel';
import type { ProductRelationsView } from './productOverlay';

export interface ProductImageSelection {
  optionValueIds: string[];
  colorId: string | null;
  fulfillmentType?: 'direct_sale' | 'pre_order';
}

/**
 * One image precedence rule for cart, checkout and immutable order snapshots:
 * selected colour → modelled combination → selected option → product primary.
 * Bound relational media wins over legacy option/color image strings, while
 * those strings remain backward-compatible fallbacks for old products.
 */
export function productImageForSelection(
  doc: ProductDoc,
  selection: ProductImageSelection,
  view?: ProductRelationsView | null
): string {
  const media = primaryMediaFirst(doc.media);
  const bound = (predicate: (m: ProductDoc['media'][number]) => boolean) => media.find(predicate)?.url || '';

  if (selection.colorId) {
    const colorBound = bound((m) => m.color_id === selection.colorId);
    if (colorBound) return colorBound;
    const colorImage = doc.colors.find((c) => c.id === selection.colorId)?.image;
    if (colorImage) return colorImage;
  }

  if (view) {
    const key = comboKey({ option_value_ids: selection.optionValueIds, color_id: selection.colorId });
    const variantId = view.variants.find((v) => v.active !== 0 && v.combo_key === key)?.id;
    if (variantId) {
      const variantBound = bound((m) => m.variant_id === variantId);
      if (variantBound) return variantBound;
    }
  }

  for (const optionId of selection.optionValueIds) {
    const option = doc.options.find(o=>o.id===optionId);
    const fulfillment = selection.fulfillmentType === 'pre_order' ? option?.preorder : option?.direct;
    if (fulfillment?.image) return fulfillment.image;
    const optionBound = bound((m) => m.option_value_id === optionId);
    if (optionBound) return optionBound;
    const optionImage = doc.options.find((o) => o.id === optionId)?.image;
    if (optionImage) return optionImage;
  }

  return primaryMedia(doc.media)?.url ?? '';
}

