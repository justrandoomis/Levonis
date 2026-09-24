/**
 * THE MERCHANT CATALOGUE AS A SPREADSHEET — one row per VARIANT, grouped by
 * `handle` (the Shopify convention merchants already know).
 *
 *   · a simple product is one row, its option columns empty;
 *   · a product with variants is one row per variant: the FIRST row of a
 *     handle carries the product's own columns, every row carries its option
 *     values (`option1_name`/`option1_value` … up to 3) and the variant's
 *     price override, compare-at, SKU, stock and active flag.
 *
 * `parseCatalogCsv` and `catalogCsvRows` are inverses: exporting a store and
 * importing the file back creates the same products, variants, prices,
 * stock, attributes and collection memberships (tests/catalogCsv round trip).
 * An import only ever CREATES, and always as drafts — a spreadsheet must not
 * publish to real customers.
 *
 * The older template (name, price_iqd, original_price_iqd, section, …) still
 * imports: `original_price_iqd` reads as `compare_at_iqd`, `section` as
 * `collections`, `lifecycle` as `state` (and a row with no handle is its own
 * product).
 *
 * Every refusal is a stable code on its row (`row`, `field`, `code`), so the
 * preview can say which line of the merchant's file is wrong and why.
 */
import { normalizeVariantModel, type VariantModel } from '@levonis/catalog/variants';
import { normalizeAttributes, type Attributes } from '@levonis/catalog/attributes';

import { CATALOG_CSV_COLUMNS, COLLECTION_SEPARATOR } from '@levonis/catalog/csv';

export { CATALOG_CSV_COLUMNS, COLLECTION_SEPARATOR };

const ALIASES: Record<string, string> = {
  original_price_iqd: 'compare_at_iqd',
  section: 'collections',
  lifecycle: 'state',
};


export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_PRODUCTS = 200;

export interface RowError {
  row: number;
  field: string;
  code: string;
}

export interface ImportedProduct {
  /** The first line of the file that carries it. */
  row: number;
  handle: string;
  fields: {
    name: string;
    name_ar: string;
    description: string;
    description_ar: string;
    price_iqd: number;
    original_price_iqd: number | null;
    sku: string;
    stock: number;
    track_stock: number;
    low_stock_threshold: number | null;
    category: string;
    condition: string;
    prep_days: number;
    featured: number;
  };
  attributes: Attributes;
  collectionNames: string[];
  model: VariantModel;
}

export interface CatalogExportProduct {
  slug: string;
  name: string;
  name_ar: string;
  description: string;
  description_ar: string;
  state: string;
  price_iqd: number;
  original_price_iqd: number | null;
  sku: string;
  stock: number;
  track_stock: boolean;
  low_stock_threshold: number | null;
  category: string;
  condition: string;
  prep_days: number;
  featured: boolean;
  collections: string[];
  attributes: Attributes;
  groups: Array<{ name: string; values: Array<{ id: string; name: string }> }>;
  variants: Array<{ value_ids: string[]; price_iqd: number | null; compare_at_iqd: number | null; sku: string; stock: number; active: boolean }>;
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

/** Header + one row per variant (or per simple product). */
export function catalogCsvRows(products: CatalogExportProduct[]): string[][] {
  const rows: string[][] = [[...CATALOG_CSV_COLUMNS]];
  for (const p of products) {
    const productCells: Record<string, string> = {
      handle: p.slug,
      name: p.name,
      name_ar: p.name_ar,
      description: p.description,
      description_ar: p.description_ar,
      state: p.state,
      price_iqd: String(p.price_iqd),
      compare_at_iqd: num(p.original_price_iqd),
      sku: p.sku,
      stock: String(p.stock),
      track_stock: p.track_stock ? '1' : '0',
      low_stock_threshold: num(p.low_stock_threshold),
      category: p.category,
      condition: p.condition,
      prep_days: String(p.prep_days),
      featured: p.featured ? '1' : '0',
      collections: p.collections.join(COLLECTION_SEPARATOR),
      material: p.attributes.material ?? '',
      technology: p.attributes.technology ?? '',
      color: p.attributes.color ?? '',
      finish: p.attributes.finish ?? '',
      dim_x_mm: num(p.attributes.dim_x_mm),
      dim_y_mm: num(p.attributes.dim_y_mm),
      dim_z_mm: num(p.attributes.dim_z_mm),
      weight_g: num(p.attributes.weight_g),
    };
    const variants = p.groups.length ? p.variants : [null];
    variants.forEach((v, i) => {
      const cells: Record<string, string> = i === 0 ? { ...productCells } : { handle: p.slug };
      if (v) {
        p.groups.forEach((g, gi) => {
          cells[`option${gi + 1}_name`] = g.name;
          cells[`option${gi + 1}_value`] = g.values.find((x) => x.id === v.value_ids[gi])?.name ?? '';
        });
        cells.variant_price_iqd = num(v.price_iqd);
        cells.variant_compare_at_iqd = num(v.compare_at_iqd);
        cells.variant_sku = v.sku;
        cells.variant_stock = String(v.stock);
        cells.variant_active = v.active ? '1' : '0';
      }
      rows.push(CATALOG_CSV_COLUMNS.map((c) => cells[c] ?? ''));
    });
  }
  return rows;
}

function wholeCell(raw: string, min: number, max: number, dflt: number | null): number | null | undefined {
  if (raw === '') return dflt;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * The file as products, and every row's problems. `grid` is `parseCsv`'s
 * output (header first). A handle whose rows have any error is left out of
 * `products` whole — half a product is never created.
 */
export function parseCatalogCsv(grid: string[][]): { products: ImportedProduct[]; errors: RowError[]; rows: number } {
  const errors: RowError[] = [];
  const header = (grid[0] ?? []).map((h) => {
    const k = h.trim().toLowerCase().replace(/^\uFEFF/, '');
    return ALIASES[k] ?? k;
  });
  const index = new Map(header.map((h, i) => [h, i]));
  if (!index.has('name') || !index.has('price_iqd')) {
    return { products: [], errors: [{ row: 1, field: 'header', code: 'CSV_HEADER' }], rows: 0 };
  }
  // The export's formula guard (`'=…`) is undone, as the admin import does.
  const cell = (r: string[], name: string) => {
    const i = index.get(name);
    return i === undefined ? '' : (r[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '');
  };
  const dataRows = grid
    .slice(1)
    .map((r, i) => ({ r, line: i + 2 }))
    .filter(({ r }) => r.some((c) => c.trim() !== ''));
  if (dataRows.length > MAX_IMPORT_ROWS) return { products: [], errors: [{ row: 1, field: 'file', code: 'CSV_TOO_BIG' }], rows: dataRows.length };

  // Group rows into products, in file order.
  const groups: Array<{ handle: string; rows: typeof dataRows }> = [];
  const byHandle = new Map<string, (typeof groups)[number]>();
  for (const dr of dataRows) {
    const handle = cell(dr.r, 'handle');
    const existing = handle ? byHandle.get(handle) : undefined;
    if (existing) existing.rows.push(dr);
    else {
      const g = { handle, rows: [dr] };
      groups.push(g);
      if (handle) byHandle.set(handle, g);
    }
  }
  if (groups.length > MAX_IMPORT_PRODUCTS) return { products: [], errors: [{ row: 1, field: 'file', code: 'CSV_TOO_BIG' }], rows: dataRows.length };

  const products: ImportedProduct[] = [];
  for (const g of groups) {
    const first = g.rows[0];
    const rowErr = (row: number, field: string, code: string) => errors.push({ row, field, code });
    const before = errors.length;
    const r = first.r;
    const name = cell(r, 'name');
    if (name.length < 2 || name.length > 120) rowErr(first.line, 'name', 'CSV_NAME_INVALID');
    const price = wholeCell(cell(r, 'price_iqd'), 0, 1_000_000_000, null);
    if (price === undefined || price === null) rowErr(first.line, 'price_iqd', 'CSV_PRICE_INVALID');
    const compare = wholeCell(cell(r, 'compare_at_iqd'), 0, 1_000_000_000, null);
    if (compare === undefined) rowErr(first.line, 'compare_at_iqd', 'CSV_PRICE_INVALID');
    const stock = wholeCell(cell(r, 'stock'), 0, 1_000_000, 0);
    if (stock === undefined) rowErr(first.line, 'stock', 'CSV_STOCK_INVALID');
    const threshold = wholeCell(cell(r, 'low_stock_threshold'), 0, 1_000_000, null);
    if (threshold === undefined) rowErr(first.line, 'low_stock_threshold', 'CSV_FIELD_INVALID');
    const prep = wholeCell(cell(r, 'prep_days'), 0, 365, 0);
    if (prep === undefined) rowErr(first.line, 'prep_days', 'CSV_FIELD_INVALID');
    const condition = cell(r, 'condition') || 'new';
    if (!['new', 'used', 'refurbished'].includes(condition)) rowErr(first.line, 'condition', 'CSV_FIELD_INVALID');
    const texts: Array<[string, number]> = [['name_ar', 120], ['description', 6000], ['description_ar', 6000], ['sku', 64], ['category', 60]];
    for (const [f, max] of texts) if (cell(r, f).length > max) rowErr(first.line, f, 'CSV_FIELD_INVALID');

    const attrs = normalizeAttributes({
      material: cell(r, 'material'),
      technology: cell(r, 'technology'),
      color: cell(r, 'color'),
      finish: cell(r, 'finish'),
      dim_x_mm: cell(r, 'dim_x_mm'),
      dim_y_mm: cell(r, 'dim_y_mm'),
      dim_z_mm: cell(r, 'dim_z_mm'),
      weight_g: cell(r, 'weight_g'),
    });
    if (!attrs.ok) for (const e of attrs.errors) rowErr(first.line, e.field === 'technology' ? 'technology' : e.field, 'CSV_ATTRIBUTE_INVALID');

    // The option groups, named on the first row; every row names one value of each.
    const groupNames: string[] = [];
    for (let k = 1; k <= 3; k++) {
      const n = cell(r, `option${k}_name`);
      if (n) groupNames.push(n);
      else break;
    }
    const model: { groups: Array<{ ref: string; name: string; name_ar: string; kind: string; values: Array<{ ref: string; name: string; name_ar: string; swatch: string }> }>; variants: unknown[] } = {
      groups: groupNames.map((n, gi) => ({ ref: `g${gi}`, name: n, name_ar: '', kind: 'choice', values: [] })),
      variants: [],
    };
    const variantRows: number[] = [];
    if (groupNames.length) {
      for (const dr of g.rows) {
        const refs: string[] = [];
        let rowOk = true;
        groupNames.forEach((gname, gi) => {
          const named = cell(dr.r, `option${gi + 1}_name`);
          if (named && named !== gname) {
            rowErr(dr.line, `option${gi + 1}_name`, 'CSV_OPTION_NAME_MISMATCH');
            rowOk = false;
          }
          const value = cell(dr.r, `option${gi + 1}_value`);
          if (!value) {
            rowErr(dr.line, `option${gi + 1}_value`, 'CSV_OPTION_VALUE_MISSING');
            rowOk = false;
            return;
          }
          const grp = model.groups[gi];
          let v = grp.values.find((x) => x.name.toLocaleLowerCase('en-US') === value.toLocaleLowerCase('en-US'));
          if (!v) {
            v = { ref: `g${gi}v${grp.values.length}`, name: value, name_ar: '', swatch: '' };
            grp.values.push(v);
          }
          refs.push(v.ref);
        });
        const vPrice = wholeCell(cell(dr.r, 'variant_price_iqd'), 0, 1_000_000_000, null);
        const vCompare = wholeCell(cell(dr.r, 'variant_compare_at_iqd'), 0, 1_000_000_000, null);
        const vStock = wholeCell(cell(dr.r, 'variant_stock'), 0, 1_000_000, 0);
        if (vPrice === undefined) { rowErr(dr.line, 'variant_price_iqd', 'CSV_PRICE_INVALID'); rowOk = false; }
        if (vCompare === undefined) { rowErr(dr.line, 'variant_compare_at_iqd', 'CSV_PRICE_INVALID'); rowOk = false; }
        if (vStock === undefined) { rowErr(dr.line, 'variant_stock', 'CSV_STOCK_INVALID'); rowOk = false; }
        if (!rowOk) continue;
        variantRows.push(dr.line);
        model.variants.push({
          values: refs,
          price_iqd: vPrice,
          compare_at_iqd: vCompare,
          stock: vStock,
          sku: cell(dr.r, 'variant_sku'),
          active: cell(dr.r, 'variant_active') !== '0',
        });
      }
    } else if (g.rows.length > 1) {
      for (const dr of g.rows.slice(1)) rowErr(dr.line, 'handle', 'CSV_HANDLE_DUPLICATE');
    }
    const normalized = normalizeVariantModel(model);
    if (!normalized.ok) {
      for (const e of normalized.errors) {
        const m = /^variants\.(\d+)/.exec(e.path);
        rowErr(m ? variantRows[Number(m[1])] ?? first.line : first.line, e.path || 'variants', `CSV_${e.code}`);
      }
    }

    if (errors.length === before && normalized.ok && attrs.ok) {
      products.push({
        row: first.line,
        handle: g.handle,
        fields: {
          name,
          name_ar: cell(r, 'name_ar'),
          description: cell(r, 'description'),
          description_ar: cell(r, 'description_ar'),
          price_iqd: price as number,
          original_price_iqd: compare ?? null,
          sku: cell(r, 'sku'),
          stock: stock ?? 0,
          track_stock: cell(r, 'track_stock') === '0' ? 0 : 1,
          low_stock_threshold: threshold ?? null,
          category: cell(r, 'category'),
          condition,
          prep_days: prep ?? 0,
          featured: cell(r, 'featured') === '1' ? 1 : 0,
        },
        attributes: attrs.value,
        collectionNames: cell(r, 'collections').split('|').map((s) => s.trim()).filter(Boolean),
        model: normalized.model,
      });
    }
  }
  return { products, errors, rows: dataRows.length };
}
