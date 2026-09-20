/**
 * Physical-dimension inheritance for one concrete product selection.
 *
 * The eight measurements are independent.  A variant may override only its
 * carton weight while its colour supplies the width, its model option supplies
 * the depth, and the product supplies everything else.  NULL never stops that
 * walk; it means "inherit" at that field only.
 */

import type { ProductRelationsView } from './productOverlay';
import { productVariantIdForSelection } from '@levonis/pricing/productSelectionMedia';
import {
  EMPTY_PHYSICAL_DIMENSIONS,
  PHYSICAL_DIMENSION_FIELDS,
  parsePhysicalDimensions,
  resolvePhysicalDimensions,
  type PhysicalDimensionOverrides,
  type PhysicalDimensions,
  type PhysicalDimensionSource,
} from '@levonis/pricing/physicalDimensions';

export {
  EMPTY_PHYSICAL_DIMENSIONS,
  PHYSICAL_DIMENSION_FIELDS,
  isPositivePhysicalDimension,
  parsePhysicalDimensions,
  physicalDimension,
  presentPhysicalDimensions,
  resolvePhysicalDimensionChain,
  resolvePhysicalDimensions,
} from '@levonis/pricing/physicalDimensions';
export type {
  PhysicalDimensionField,
  PhysicalDimensionOverrides,
  PhysicalDimensions,
  PhysicalDimensionSource,
} from '@levonis/pricing/physicalDimensions';

/** Backwards-compatible spelling used by the existing product document. */
export const DIMENSION_FIELDS = PHYSICAL_DIMENSION_FIELDS;

/** Backwards-compatible spelling used by productModel and existing callers. */
export const EMPTY_DIMENSIONS = EMPTY_PHYSICAL_DIMENSIONS;

/** Backwards-compatible spelling used by the product document. */
export const parseDimensions = parsePhysicalDimensions;

interface ProductDimensionInput extends PhysicalDimensionOverrides {
  /** ProductDoc uses the nested form; a raw products row uses the flat form. */
  dimensions?: PhysicalDimensionSource;
  options?: ReadonlyArray<PhysicalDimensionOverrides & { id: string }>;
  colors?: ReadonlyArray<PhysicalDimensionOverrides & { id: string }>;
}

export interface PhysicalDimensionSelection {
  optionValueIds: readonly string[];
  colorId: string | null;
}

/**
 * Resolves the physical facts for the same selection the cart/order validates.
 *
 * `option` means the price-bearing/model value: the first selected value in
 * the catalogue's authored relation order.  Other option groups describe the
 * exact combination, whose `product_variants` row is the higher-precedence
 * place for a physical override.  This mirrors pricing's first-authored-group
 * rule and avoids letting client array order choose a different carton.
 */
export function resolveSelectionPhysicalDimensions(
  product: ProductDimensionInput,
  view: Pick<ProductRelationsView, 'values' | 'colors' | 'variants'>,
  selection: PhysicalDimensionSelection
): PhysicalDimensions {
  const selectedIds = new Set(selection.optionValueIds.filter(Boolean));

  // `view.values` is loaded group-by-group in authored order.  Fall back to
  // the document mirror only during a rolling deploy where relations did not
  // load; its options are authored-order too.
  const option =
    (view.values ?? []).find((row) => selectedIds.has(row.id)) ??
    (product.options ?? []).find((row) => selectedIds.has(row.id)) ??
    null;
  const color = selection.colorId
    ? (view.colors ?? []).find((row) => row.id === selection.colorId) ??
      (product.colors ?? []).find((row) => row.id === selection.colorId) ??
      null
    : null;

  // Keep exact-variant eligibility identical to media/public selection.  An
  // inactive row may remain in D1 so historic orders keep their identity, but
  // it must not override the physical facts frozen for a new checkout.
  const variantId = productVariantIdForSelection(view.variants ?? [], selection);
  const variant = variantId
    ? (view.variants ?? []).find((row) => row.id === variantId) ?? null
    : null;

  const base = product.dimensions ?? product;
  return resolvePhysicalDimensions({ product: base, option, color, variant });
}
