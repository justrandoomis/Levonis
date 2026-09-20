import {
  dimensionOverrides,
  resolveDimensions,
  type ProductDimensionOverridesV2,
  type ProductDimensionsV2,
} from './productTypes';
import { productVariantIdForSelection } from './productImage';

export interface DimensionedSelectionValue extends ProductDimensionOverridesV2 {
  id: string;
}

export interface DimensionedSelectionVariant extends ProductDimensionOverridesV2 {
  id: string;
  combo_key: string;
}

export interface ProductDimensionRelations {
  option_groups?: ReadonlyArray<{
    values: ReadonlyArray<DimensionedSelectionValue>;
  }>;
  colors?: ReadonlyArray<DimensionedSelectionValue>;
  variants?: ReadonlyArray<DimensionedSelectionVariant>;
}

export interface ProductDimensionSource {
  dimensions?: ProductDimensionOverridesV2 | null;
  options?: ReadonlyArray<DimensionedSelectionValue>;
  colors?: ReadonlyArray<DimensionedSelectionValue>;
}

/**
 * Resolve the eight physical facts for the selection painted on the product
 * page. The walk mirrors checkout: product, first authored selected option,
 * selected colour, then the exact combination. Each field walks independently
 * so an unset carton depth never erases a lower-level measurement.
 */
export function resolveProductSelectionDimensions(
  product: ProductDimensionSource,
  relations: ProductDimensionRelations | null | undefined,
  selection: { optionValueIds: readonly string[]; colorId?: string | null }
): ProductDimensionsV2 {
  const selectedIds = new Set(selection.optionValueIds.filter(Boolean));
  const relationValues = (relations?.option_groups ?? []).flatMap((group) => group.values);
  const option =
    relationValues.find((value) => selectedIds.has(value.id)) ??
    (product.options ?? []).find((value) => selectedIds.has(value.id)) ??
    null;
  const colorId = selection.colorId || null;
  const color = colorId
    ? (relations?.colors ?? []).find((value) => value.id === colorId) ??
      (product.colors ?? []).find((value) => value.id === colorId) ??
      null
    : null;
  const variantId = productVariantIdForSelection(relations?.variants ?? [], {
    optionValueIds: [...selectedIds],
    colorId,
  });
  const variant = variantId
    ? (relations?.variants ?? []).find((value) => value.id === variantId) ?? null
    : null;

  return resolveDimensions(
    dimensionOverrides(product.dimensions),
    option,
    color,
    variant
  );
}

export function hasProductDimensions(value: ProductDimensionsV2): boolean {
  return Object.values(value).some((measurement) => measurement !== null);
}

/**
 * UI-only unit conversion. Building the decimal from integer quotient and
 * remainder keeps 1 g as exactly 0.001 kg and 1 mm as exactly 0.1 cm; no
 * floating-point rounding and no converted value ever enters product state.
 */
export function formatPhysicalMeasurement(
  value: number | null,
  kind: 'weight' | 'length'
): string {
  if (value === null) return '—';
  const divisor = kind === 'weight' ? 1000 : 10;
  const decimalPlaces = kind === 'weight' ? 3 : 1;
  const whole = Math.floor(value / divisor);
  const remainder = value % divisor;
  const fraction = remainder
    ? `.${String(remainder).padStart(decimalPlaces, '0').replace(/0+$/, '')}`
    : '';
  return `${whole}${fraction} ${kind === 'weight' ? 'kg' : 'cm'}`;
}
