/**
 * The catalogue spreadsheet's columns, in file order — shared by the server's
 * import/export (worker/lib/catalog/csv.ts) and the editor's «download
 * template», so the two can never name a column differently.
 * One row per VARIANT, grouped by `handle`.
 */
export const CATALOG_CSV_COLUMNS = [
  'handle', 'name', 'name_ar', 'description', 'description_ar', 'state', 'price_iqd', 'compare_at_iqd', 'sku',
  'stock', 'track_stock', 'low_stock_threshold', 'category', 'condition', 'prep_days', 'featured', 'collections',
  'material', 'technology', 'color', 'finish', 'dim_x_mm', 'dim_y_mm', 'dim_z_mm', 'weight_g',
  'option1_name', 'option1_value', 'option2_name', 'option2_value', 'option3_name', 'option3_value',
  'variant_price_iqd', 'variant_compare_at_iqd', 'variant_sku', 'variant_stock', 'variant_active',
] as const;

/** Several collection names in one cell. */
export const COLLECTION_SEPARATOR = ' | ';
