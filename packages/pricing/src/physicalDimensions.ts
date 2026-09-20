/**
 * Physical facts shared by a product and each selectable rung beneath it.
 * Database/storage units are whole grams and millimetres.
 */
export interface PhysicalDimensions {
  net_weight_g: number | null;
  width_mm: number | null;
  depth_mm: number | null;
  height_mm: number | null;
  package_weight_g: number | null;
  package_width_mm: number | null;
  package_depth_mm: number | null;
  package_height_mm: number | null;
}

/** A relation row may omit a key to preserve the value already stored. */
export type PhysicalDimensionOverrides = Partial<PhysicalDimensions>;

/** The canonical schema order shared by D1, Worker snapshots and both UIs. */
export const PHYSICAL_DIMENSION_FIELDS = [
  'net_weight_g',
  'width_mm',
  'depth_mm',
  'height_mm',
  'package_weight_g',
  'package_width_mm',
  'package_depth_mm',
  'package_height_mm',
] as const;

export type PhysicalDimensionField = (typeof PHYSICAL_DIMENSION_FIELDS)[number];
export type PhysicalDimensionSource = PhysicalDimensionOverrides | null | undefined;

export const EMPTY_PHYSICAL_DIMENSIONS = (): PhysicalDimensions => ({
  net_weight_g: null,
  width_mm: null,
  depth_mm: null,
  height_mm: null,
  package_weight_g: null,
  package_width_mm: null,
  package_depth_mm: null,
  package_height_mm: null,
});

export function isPositivePhysicalDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/** Lenient legacy read adapter; new writes validate before calling this. */
export function physicalDimension(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0) return null;
  return Math.min(number, 100_000_000);
}

export function parsePhysicalDimensions(
  source: Record<string, unknown> | null | undefined
): PhysicalDimensions {
  const out = EMPTY_PHYSICAL_DIMENSIONS();
  if (!source) return out;
  for (const field of PHYSICAL_DIMENSION_FIELDS) out[field] = physicalDimension(source[field]);
  return out;
}

/** Preserve the wire distinction between an omitted key and an explicit null. */
export function presentPhysicalDimensions(source: Record<string, unknown>): PhysicalDimensionOverrides {
  const out: PhysicalDimensionOverrides = {};
  for (const field of PHYSICAL_DIMENSION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    out[field] = source[field] === null ? null : physicalDimension(source[field]);
  }
  return out;
}

/**
 * The one inheritance primitive. Sources are ordered least-specific first and
 * every field walks independently; null/omitted means continue inheriting.
 */
export function resolvePhysicalDimensionChain(
  product: PhysicalDimensionSource,
  ...overrides: PhysicalDimensionSource[]
): PhysicalDimensions {
  const resolved = EMPTY_PHYSICAL_DIMENSIONS();
  for (const source of [product, ...overrides]) {
    if (!source) continue;
    for (const field of PHYSICAL_DIMENSION_FIELDS) {
      const value = source[field];
      if (isPositivePhysicalDimension(value)) resolved[field] = value;
    }
  }
  return resolved;
}

/** Exact hierarchy required by product selection and order snapshots. */
export function resolvePhysicalDimensions(input: {
  product: PhysicalDimensionSource;
  option?: PhysicalDimensionSource;
  color?: PhysicalDimensionSource;
  variant?: PhysicalDimensionSource;
}): PhysicalDimensions {
  return resolvePhysicalDimensionChain(input.product, input.option, input.color, input.variant);
}
