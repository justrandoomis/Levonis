/**
 * The import/export format — mandate §10.
 *
 * ONE PRODUCT SPANS SEVERAL ROWS, distinguished by the first column
 * `row_type`. The alternative — packing options, colours, links and images
 * into encoded strings inside a single row — is unreadable in Excel, painful
 * to validate and impossible to give a useful error message for. With row
 * types, "row 14: colour hex is not #RRGGBB" points at a real line in the
 * file the admin is looking at.
 *
 *   product   the product itself, plus the spec columns its section declares
 *   option    one value of one option group
 *   color     one colour, with its links to option values
 *   image     one image, with its order, primary flag and binding
 *
 * Rows are attached to their product by `key` — the product's SKU, or its
 * slug when it has no SKU. Every child row repeats the parent key, so the
 * file can be sorted, filtered or split in a spreadsheet without breaking.
 *
 * COLUMNS FOLLOW THE SECTION. The spec columns come from
 * worker/lib/templateFamilies.ts for the chosen section, so a Devices template
 * never shows a filament diameter and a Materials template never shows a
 * nozzle — "ولا تظهر أعمدة لا تخص المنتج".
 *
 * ROUND-TRIP. `serializeProducts` and `parseImport` are inverses: exporting a
 * product and re-importing it reproduces the same options, colours, links,
 * images, order, stock and prices. tests/importCsv.test.ts holds that line.
 *
 * NO SCRAPING. An image cell is either a file name inside the ZIP or a URL
 * that must point directly at an image file; the server verifies it by magic
 * bytes (worker/routes/media.ts). A product-page URL is rejected, not read.
 */

import { FAMILIES, fieldsFor, flatFields, type TemplateField } from './templateFamilies';
import type { Lookups } from './lookups';

export type RowType = 'product' | 'option' | 'color' | 'image';

// ------------------------------------------------------------------- CSV IO

/** RFC 4180 parse: quoted fields, doubled quotes, CRLF or LF, BOM tolerated. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing blank lines, but keep a row that is genuinely all-empty in
  // the middle of the file so its line number stays truthful.
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

const needsQuote = (s: string) => /[",\r\n]/.test(s);

/** Spreadsheet apps treat a leading = + - @ or tab as a FORMULA, so a cell a
 *  user typed («=HYPERLINK(...)») would execute on whoever opens the export.
 *  The standard defence: prefix such cells with a single quote — Excel then
 *  shows the text as typed. Applied here so every CSV we serve is covered. */
const defuse = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export function toCsv(rows: string[][]): string {
  return rows
    .map((r) => r.map((cell) => {
      const c = defuse(cell);
      return needsQuote(c) ? `"${c.replace(/"/g, '""')}"` : c;
    }).join(','))
    .join('\r\n');
}

// ------------------------------------------------------------------ columns

/** Columns every template carries, in order. */
export const BASE_COLUMNS = [
  'row_type',
  'key',
  'name',
  'description',
  'status',
  'display_order',
  'brand',
  'category',
  'sub_category',
  'sale_types',
  'inventory_mode',
  'price_iqd',
  'prime_price_iqd',
  'pro_price_iqd',
  'cost_iqd',
  'stock',
  'low_stock_threshold',
  'facets',
  'hashtags',
  // child-row columns
  'group',
  'value',
  'hex',
  'sku_part',
  'links',
  'image',
  'alt',
  'primary',
  'active',
] as const;

export const SPEC_PREFIX = 'spec.';

export interface TemplateShape {
  columns: string[];
  specFields: TemplateField[];
  family: 'devices' | 'materials';
  sectionSlugs: string[];
}

/** The column list for one section: the base columns then its spec columns. */
export function templateShape(
  family: 'devices' | 'materials',
  sectionSlugs: string[],
  { includeCost = true }: { includeCost?: boolean } = {}
): TemplateShape {
  const specFields = flatFields(fieldsFor(family, sectionSlugs));
  const base = BASE_COLUMNS.filter((c) => (includeCost ? true : c !== 'cost_iqd'));
  return {
    columns: [...base, ...specFields.map((f) => `${SPEC_PREFIX}${f.id}`)],
    specFields,
    family,
    sectionSlugs,
  };
}

/** A human-readable header line under the machine one, so a spreadsheet shows
 *  the Arabic label without the parser ever depending on it. */
export function labelRow(shape: TemplateShape): string[] {
  const labels: Record<string, string> = {
    row_type: 'نوع السطر (product/option/color/image)',
    key: 'مفتاح المنتج (SKU أو slug)',
    name: 'الاسم بالإنجليزية',
    description: 'الوصف بالإنجليزية',
    status: 'الحالة (draft/active/hidden)',
    display_order: 'ترتيب العرض',
    brand: 'العلامة التجارية',
    category: 'القسم الرئيسي',
    sub_category: 'القسم الفرعي',
    sale_types: 'أنواع البيع (direct_sale|pre_order|bundle)',
    inventory_mode: 'مصدر المخزون (BASE/OPTION/COLOR/VARIANT_COMBINATION)',
    price_iqd: 'السعر الاعتيادي',
    prime_price_iqd: 'سعر PRIME',
    pro_price_iqd: 'سعر PRO',
    cost_iqd: 'التكلفة (إداري)',
    stock: 'المخزون',
    low_stock_threshold: 'حد التنبيه',
    facets: 'الفلاتر (slug|slug)',
    hashtags: 'الهاشتاقات (tag|tag)',
    group: 'مجموعة الخيار',
    value: 'قيمة الخيار / اسم اللون',
    hex: 'كود اللون #RRGGBB',
    sku_part: 'جزء SKU',
    links: 'روابط اللون (Group:Value|Group:Value)',
    image: 'الصورة (اسم ملف داخل ZIP أو رابط مباشر)',
    alt: 'نص بديل',
    primary: 'صورة رئيسية (yes/no)',
    active: 'مفعّل (yes/no)',
  };
  const byId = new Map(shape.specFields.map((f) => [f.id, f]));
  return shape.columns.map((c) => {
    if (c.startsWith(SPEC_PREFIX)) {
      const f = byId.get(c.slice(SPEC_PREFIX.length));
      return f ? `${f.label_ar}${f.unit ? ` (${f.unit})` : ''}` : c;
    }
    return labels[c] ?? c;
  });
}

// ------------------------------------------------------------------- parsing

export interface ParsedProduct {
  key: string;
  line: number;
  name: string;
  description: string;
  status: string;
  display_order: number | null;
  brand: string;
  category: string;
  sub_category: string;
  sale_types: string[];
  inventory_mode: string;
  price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  stock: number | null;
  low_stock_threshold: number | null;
  facets: string[];
  /** null when the sheet has no hashtags column at all, so an older file
   *  leaves a product's stored tags alone instead of clearing them. */
  hashtags: string[] | null;
  spec_fields: Record<string, string>;
  options: ParsedOption[];
  colors: ParsedColor[];
  images: ParsedImage[];
}

export interface ParsedOption {
  line: number;
  group: string;
  value: string;
  sku_part: string;
  image: string;
  active: boolean;
  stock: number | null;
  low_stock_threshold: number | null;
  price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
}

export interface ParsedColor {
  line: number;
  name: string;
  hex: string;
  sku_part: string;
  image: string;
  active: boolean;
  stock: number | null;
  low_stock_threshold: number | null;
  price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  /** [{group, value}] — resolved to ids at apply time. */
  links: Array<{ group: string; value: string }>;
}

export interface ParsedImage {
  line: number;
  image: string;
  alt: string;
  primary: boolean;
  /** 'color:Black' | 'option:Printer:A1' | '' */
  bind: string;
}

export interface RowIssue {
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface ParseResult {
  products: ParsedProduct[];
  issues: RowIssue[];
  /** Columns present in the file that the template does not define. */
  unknownColumns: string[];
}

const yes = (v: string) => /^(1|y|yes|true|نعم)$/i.test(v.trim());
const no = (v: string) => /^(0|n|no|false|لا)$/i.test(v.trim());

function intCell(v: string, line: number, col: string, issues: RowIssue[]): number | null {
  const s = v.trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) {
    issues.push({ line, severity: 'error', message: `${col}: "${s}" ليس رقمًا صحيحًا` });
    return null;
  }
  return Number(s);
}

const splitList = (v: string) =>
  v
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Parses a completed template. Pure and side-effect free — this is what the
 * PREVIEW endpoint runs, and §10 requires preview to write nothing.
 */
export function parseImport(text: string, shape: TemplateShape): ParseResult {
  const rows = parseCsv(text);
  const issues: RowIssue[] = [];
  if (rows.length === 0) {
    return { products: [], issues: [{ line: 0, severity: 'error', message: 'الملف فارغ' }], unknownColumns: [] };
  }

  const header = rows[0].map((h) => h.trim());
  const index = new Map(header.map((h, i) => [h, i]));
  if (!index.has('row_type') || !index.has('key')) {
    return {
      products: [],
      issues: [{ line: 1, severity: 'error', message: 'الصف الأول يجب أن يحتوي على الأعمدة row_type و key' }],
      unknownColumns: [],
    };
  }
  const known = new Set<string>(shape.columns);
  const unknownColumns = header.filter((h) => h && !known.has(h));

  const cell = (r: string[], name: string) => {
    const i = index.get(name);
    return i === undefined ? '' : (r[i] ?? '').trim();
  };

  const products = new Map<string, ParsedProduct>();
  const orphans: Array<{ line: number; key: string; type: string }> = [];

  for (let ri = 1; ri < rows.length; ri++) {
    const r = rows[ri];
    const line = ri + 1; // 1-based, header is line 1
    const type = cell(r, 'row_type').toLowerCase();
    if (!type) continue;
    // The label row shipped inside the template is skipped by its own marker,
    // never by position, so a file with the labels deleted still imports.
    if (type.startsWith('#') || type === 'row_type') continue;
    const key = cell(r, 'key');
    if (!key) {
      issues.push({ line, severity: 'error', message: 'عمود key فارغ' });
      continue;
    }

    if (type === 'product') {
      if (products.has(key)) {
        issues.push({ line, severity: 'error', message: `المفتاح "${key}" مكرر في الملف` });
        continue;
      }
      const spec: Record<string, string> = {};
      for (const f of shape.specFields) {
        const v = cell(r, `${SPEC_PREFIX}${f.id}`);
        if (v) spec[f.id] = v;
      }
      products.set(key, {
        key,
        line,
        name: cell(r, 'name'),
        description: cell(r, 'description'),
        status: cell(r, 'status') || 'draft',
        display_order: intCell(cell(r, 'display_order'), line, 'display_order', issues),
        brand: cell(r, 'brand'),
        category: cell(r, 'category'),
        sub_category: cell(r, 'sub_category'),
        sale_types: splitList(cell(r, 'sale_types')),
        inventory_mode: cell(r, 'inventory_mode') || 'BASE',
        price_iqd: intCell(cell(r, 'price_iqd'), line, 'price_iqd', issues),
        prime_price_iqd: intCell(cell(r, 'prime_price_iqd'), line, 'prime_price_iqd', issues),
        pro_price_iqd: intCell(cell(r, 'pro_price_iqd'), line, 'pro_price_iqd', issues),
        cost_iqd: intCell(cell(r, 'cost_iqd'), line, 'cost_iqd', issues),
        stock: intCell(cell(r, 'stock'), line, 'stock', issues),
        low_stock_threshold: intCell(cell(r, 'low_stock_threshold'), line, 'low_stock_threshold', issues),
        facets: splitList(cell(r, 'facets')),
        hashtags: index.has('hashtags') ? splitList(cell(r, 'hashtags')) : null,
        spec_fields: spec,
        options: [],
        colors: [],
        images: [],
      });
      continue;
    }

    const parent = products.get(key);
    if (!parent) {
      // Reported once per row rather than swallowed: a child row whose product
      // is missing is exactly the mistake an admin needs to see.
      orphans.push({ line, key, type });
      continue;
    }

    const activeCell = cell(r, 'active');
    const active = activeCell === '' ? true : yes(activeCell) ? true : no(activeCell) ? false : true;

    if (type === 'option') {
      const group = cell(r, 'group');
      const value = cell(r, 'value');
      if (!group || !value) {
        issues.push({ line, severity: 'error', message: 'سطر option يحتاج group و value' });
        continue;
      }
      parent.options.push({
        line,
        group,
        value,
        sku_part: cell(r, 'sku_part'),
        image: cell(r, 'image'),
        active,
        stock: intCell(cell(r, 'stock'), line, 'stock', issues),
        low_stock_threshold: intCell(cell(r, 'low_stock_threshold'), line, 'low_stock_threshold', issues),
        price_iqd: intCell(cell(r, 'price_iqd'), line, 'price_iqd', issues),
        prime_price_iqd: intCell(cell(r, 'prime_price_iqd'), line, 'prime_price_iqd', issues),
        pro_price_iqd: intCell(cell(r, 'pro_price_iqd'), line, 'pro_price_iqd', issues),
        cost_iqd: intCell(cell(r, 'cost_iqd'), line, 'cost_iqd', issues),
      });
      continue;
    }

    if (type === 'color') {
      const name = cell(r, 'value');
      const hex = cell(r, 'hex');
      if (!name) {
        issues.push({ line, severity: 'error', message: 'سطر color يحتاج اسمًا في عمود value' });
        continue;
      }
      if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
        issues.push({ line, severity: 'error', message: `hex: "${hex}" ليس #RGB أو #RRGGBB` });
        continue;
      }
      const links: Array<{ group: string; value: string }> = [];
      for (const part of splitList(cell(r, 'links'))) {
        const idx = part.indexOf(':');
        if (idx <= 0 || idx === part.length - 1) {
          issues.push({ line, severity: 'error', message: `links: "${part}" يجب أن تكون Group:Value` });
          continue;
        }
        links.push({ group: part.slice(0, idx).trim(), value: part.slice(idx + 1).trim() });
      }
      parent.colors.push({
        line,
        name,
        hex: hex.toLowerCase(),
        sku_part: cell(r, 'sku_part'),
        image: cell(r, 'image'),
        active,
        stock: intCell(cell(r, 'stock'), line, 'stock', issues),
        low_stock_threshold: intCell(cell(r, 'low_stock_threshold'), line, 'low_stock_threshold', issues),
        price_iqd: intCell(cell(r, 'price_iqd'), line, 'price_iqd', issues),
        prime_price_iqd: intCell(cell(r, 'prime_price_iqd'), line, 'prime_price_iqd', issues),
        pro_price_iqd: intCell(cell(r, 'pro_price_iqd'), line, 'pro_price_iqd', issues),
        cost_iqd: intCell(cell(r, 'cost_iqd'), line, 'cost_iqd', issues),
        links,
      });
      continue;
    }

    if (type === 'image') {
      const img = cell(r, 'image');
      if (!img) {
        issues.push({ line, severity: 'error', message: 'سطر image يحتاج اسم ملف أو رابطًا في عمود image' });
        continue;
      }
      parent.images.push({
        line,
        image: img,
        alt: cell(r, 'alt'),
        primary: yes(cell(r, 'primary')),
        bind: cell(r, 'links'),
      });
      continue;
    }

    issues.push({ line, severity: 'error', message: `row_type غير معروف: "${type}"` });
  }

  for (const o of orphans) {
    issues.push({
      line: o.line,
      severity: 'error',
      message: `سطر ${o.type} يشير إلى مفتاح "${o.key}" بلا سطر product مطابق`,
    });
  }

  // Cross-row checks the per-row pass cannot see.
  for (const p of products.values()) {
    if (!p.name.trim()) issues.push({ line: p.line, severity: 'error', message: 'name فارغ' });
    if (p.price_iqd === null) issues.push({ line: p.line, severity: 'error', message: 'price_iqd مطلوب' });

    const ladder = (
      where: string,
      line: number,
      reg: number | null,
      prime: number | null,
      pro: number | null,
      cost: number | null
    ) => {
      if (reg !== null && prime !== null && prime > reg) {
        issues.push({ line, severity: 'error', message: `${where}: سعر PRIME أعلى من الاعتيادي` });
      }
      if (reg !== null && pro !== null && pro > reg) {
        issues.push({ line, severity: 'error', message: `${where}: سعر PRO أعلى من الاعتيادي` });
      }
      if (prime !== null && pro !== null && pro > prime) {
        issues.push({ line, severity: 'error', message: `${where}: يجب PRO ≤ PRIME ≤ الاعتيادي` });
      }
      if (cost !== null && (reg === cost || prime === cost || pro === cost)) {
        issues.push({ line, severity: 'error', message: `${where}: سعر البيع يساوي التكلفة` });
      }
    };
    ladder('المنتج', p.line, p.price_iqd, p.prime_price_iqd, p.pro_price_iqd, p.cost_iqd);
    for (const o of p.options) ladder(`الخيار ${o.value}`, o.line, o.price_iqd, o.prime_price_iqd, o.pro_price_iqd, o.cost_iqd);
    for (const c of p.colors) ladder(`اللون ${c.name}`, c.line, c.price_iqd, c.prime_price_iqd, c.pro_price_iqd, c.cost_iqd);

    // A colour link must name an option row that exists in THIS file.
    const values = new Set(p.options.map((o) => `${o.group} ${o.value}`));
    for (const c of p.colors) {
      for (const l of c.links) {
        if (!values.has(`${l.group} ${l.value}`)) {
          issues.push({
            line: c.line,
            severity: 'error',
            message: `links: لا يوجد سطر option باسم "${l.group}:${l.value}" لهذا المنتج`,
          });
        }
      }
    }

    const primaries = p.images.filter((i) => i.primary);
    if (primaries.length > 1) {
      issues.push({ line: primaries[1].line, severity: 'error', message: 'أكثر من صورة رئيسية لنفس المنتج' });
    }
    if (p.images.length > 0 && primaries.length === 0) {
      issues.push({
        line: p.images[0].line,
        severity: 'warning',
        message: 'لا توجد صورة رئيسية — ستُعتمد الأولى',
      });
    }

    if (p.inventory_mode === 'COLOR' && p.colors.length === 0) {
      issues.push({ line: p.line, severity: 'error', message: 'inventory_mode=COLOR بلا ألوان' });
    }
    if (p.inventory_mode === 'OPTION' && p.options.length === 0) {
      issues.push({ line: p.line, severity: 'error', message: 'inventory_mode=OPTION بلا خيارات' });
    }
    if (p.sale_types.length > 0) {
      for (const t of p.sale_types) {
        if (!['direct_sale', 'pre_order', 'bundle'].includes(t)) {
          issues.push({ line: p.line, severity: 'error', message: `sale_types: "${t}" غير معروف` });
        }
      }
    }
  }

  return { products: [...products.values()], issues, unknownColumns };
}

// --------------------------------------------------------------- serializing

export interface ExportProduct {
  key: string;
  name: string;
  description: string;
  status: string;
  display_order: number;
  brand: string;
  category: string;
  sub_category: string;
  sale_types: string[];
  inventory_mode: string;
  price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  stock: number | null;
  low_stock_threshold: number | null;
  facets: string[];
  hashtags: string[];
  spec_fields: Record<string, string>;
  options: Array<Omit<ParsedOption, 'line'>>;
  colors: Array<Omit<ParsedColor, 'line'>>;
  images: Array<Omit<ParsedImage, 'line'>>;
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const bool = (v: boolean) => (v ? 'yes' : 'no');

/** Writes the exact file `parseImport` reads back. */
export function serializeProducts(products: ExportProduct[], shape: TemplateShape): string {
  const rows: string[][] = [shape.columns.slice()];
  const put = (values: Record<string, string>) =>
    rows.push(shape.columns.map((c) => values[c] ?? ''));

  for (const p of products) {
    const spec: Record<string, string> = {};
    for (const f of shape.specFields) {
      const v = p.spec_fields[f.id];
      if (v !== undefined) spec[`${SPEC_PREFIX}${f.id}`] = v;
    }
    put({
      row_type: 'product',
      key: p.key,
      name: p.name,
      description: p.description,
      status: p.status,
      display_order: String(p.display_order ?? 0),
      brand: p.brand,
      category: p.category,
      sub_category: p.sub_category,
      sale_types: p.sale_types.join('|'),
      inventory_mode: p.inventory_mode,
      price_iqd: num(p.price_iqd),
      prime_price_iqd: num(p.prime_price_iqd),
      pro_price_iqd: num(p.pro_price_iqd),
      cost_iqd: num(p.cost_iqd),
      stock: num(p.stock),
      low_stock_threshold: num(p.low_stock_threshold),
      facets: p.facets.join('|'),
      hashtags: p.hashtags.join('|'),
      ...spec,
    });
    for (const o of p.options) {
      put({
        row_type: 'option',
        key: p.key,
        group: o.group,
        value: o.value,
        sku_part: o.sku_part,
        image: o.image,
        active: bool(o.active),
        stock: num(o.stock),
        low_stock_threshold: num(o.low_stock_threshold),
        price_iqd: num(o.price_iqd),
        prime_price_iqd: num(o.prime_price_iqd),
        pro_price_iqd: num(o.pro_price_iqd),
        cost_iqd: num(o.cost_iqd),
      });
    }
    for (const c of p.colors) {
      put({
        row_type: 'color',
        key: p.key,
        value: c.name,
        hex: c.hex,
        sku_part: c.sku_part,
        image: c.image,
        active: bool(c.active),
        stock: num(c.stock),
        low_stock_threshold: num(c.low_stock_threshold),
        price_iqd: num(c.price_iqd),
        prime_price_iqd: num(c.prime_price_iqd),
        pro_price_iqd: num(c.pro_price_iqd),
        cost_iqd: num(c.cost_iqd),
        links: c.links.map((l) => `${l.group}:${l.value}`).join('|'),
      });
    }
    for (const i of p.images) {
      put({
        row_type: 'image',
        key: p.key,
        image: i.image,
        alt: i.alt,
        primary: bool(i.primary),
        links: i.bind,
      });
    }
  }
  return toCsv(rows);
}

/** A blank template: the machine header, a commented label row, and one
 *  worked example so the shape is obvious without reading the README. */
export function blankTemplate(shape: TemplateShape, example: boolean, lookups?: Lookups): string {
  const rows: string[][] = [shape.columns.slice()];
  const labels = labelRow(shape);
  // The label row is marked with '#' in row_type so the parser skips it by
  // marker, not by position — deleting it does not break the file.
  rows.push(shape.columns.map((c, i) => (c === 'row_type' ? '#labels' : labels[i])));
  if (!example) return toCsv(lookups ? [...rows, ...lookupRows(shape, lookups)] : rows);

  const specSample: Record<string, string> = {};
  for (const f of shape.specFields.slice(0, 4)) {
    specSample[`${SPEC_PREFIX}${f.id}`] = f.options?.[0] ?? (f.type === 'number' ? '10' : 'Example');
  }
  const put = (v: Record<string, string>) => rows.push(shape.columns.map((c) => v[c] ?? ''));
  put({
    row_type: 'product',
    key: 'EXAMPLE-001',
    name: 'Example Product',
    description: 'Nozzle diameter: 0.4 mm',
    status: 'draft',
    display_order: '0',
    sale_types: 'direct_sale|pre_order',
    inventory_mode: 'COLOR',
    price_iqd: '250000',
    prime_price_iqd: '235000',
    pro_price_iqd: '220000',
    stock: '10',
    ...specSample,
  });
  put({ row_type: 'option', key: 'EXAMPLE-001', group: 'Printer', value: 'A1', sku_part: 'A1', active: 'yes' });
  put({ row_type: 'option', key: 'EXAMPLE-001', group: 'Plug', value: 'EU', sku_part: 'EU', active: 'yes' });
  put({
    row_type: 'color',
    key: 'EXAMPLE-001',
    value: 'Black',
    hex: '#000000',
    stock: '3',
    active: 'yes',
    links: 'Printer:A1|Plug:EU',
  });
  put({ row_type: 'image', key: 'EXAMPLE-001', image: 'images/example-1.jpg', alt: 'front', primary: 'yes' });
  if (lookups) rows.push(...lookupRows(shape, lookups));
  return toCsv(rows);
}

// ------------------------------------------------------------------ lookups
//
// "عند إضافة قسم جديد أو براند أو هاشتاق يجعل في قالب الاستيراد خيارات
// للاختيار": the values the classification columns accept travel WITH the
// template, read from the database at download time. A CSV cannot carry a
// dropdown, so the blank template ends with a block of `#lookup:` rows the
// parser skips by marker — one row per value, with the value to type in the
// `key` column — and the ZIP adds a proper lookups.csv sheet.

/** One human-readable line per value, for the README. */
function lookupLine(value: string, ar: string, note: string): string {
  const tail = [ar, note].filter(Boolean).join(' — ');
  return `  ${value}${tail ? `   (${tail})` : ''}`;
}

/** The trailing lookup block of the blank template (rows in the sheet's own columns). */
export function lookupRows(shape: TemplateShape, lookups: Lookups): string[][] {
  const put = (v: Record<string, string>) => shape.columns.map((c) => v[c] ?? '');
  const rows: string[][] = [];
  rows.push(put({}));
  rows.push(
    put({
      row_type: '#lookups',
      key: 'القيم المتاحة — انسخ القيمة من عمود key إلى العمود المذكور في row_type. هذه الأسطر تُتجاهل عند الاستيراد.',
    })
  );
  // The SLUG is what every value advertises, for sections and brands too:
  // two rows may share a display name (the seed ships several sections named
  // "Printers") and the importer refuses an ambiguous name rather than guess,
  // while a slug is unique by construction and always resolves.
  for (const s of lookups.sections.filter((x) => !x.parent_id)) {
    rows.push(
      put({
        row_type: '#lookup:category',
        key: s.slug,
        name: s.name_en,
        description: [s.name_ar, s.family ? `family=${s.family}` : ''].filter(Boolean).join(' · '),
      })
    );
  }
  for (const s of lookups.sections.filter((x) => !!x.parent_id)) {
    rows.push(
      put({
        row_type: '#lookup:sub_category',
        key: s.slug,
        name: s.name_en,
        description: [s.name_ar, `parent=${s.parent_name_en}`].filter(Boolean).join(' · '),
        category: s.parent_slug ?? '',
      })
    );
  }
  for (const b of lookups.brands) {
    rows.push(put({ row_type: '#lookup:brand', key: b.slug, name: b.name_en, description: b.name_ar }));
  }
  for (const f of lookups.facets) {
    rows.push(
      put({
        row_type: '#lookup:facets',
        key: f.slug,
        name: f.name_en,
        description: [f.name_ar, `kind=${f.kind}`].filter(Boolean).join(' · '),
      })
    );
  }
  for (const h of lookups.hashtags) {
    rows.push(put({ row_type: '#lookup:hashtags', key: h.tag, name: h.name_ar }));
  }
  return rows;
}

/** lookups.csv — the same values as a plain sheet an admin can filter in Excel. */
export function lookupsSheet(lookups: Lookups): string {
  const rows: string[][] = [
    ['column', 'value', 'name_en', 'name_ar', 'slug', 'parent', 'extra'],
    [
      '#العمود',
      'القيمة التي تُكتب',
      'الاسم بالإنجليزية',
      'الاسم بالعربية',
      'المعرّف',
      'القسم الأب',
      'ملاحظات',
    ],
  ];
  for (const s of lookups.sections) {
    rows.push([
      s.parent_id ? 'sub_category' : 'category',
      s.slug,
      s.name_en,
      s.name_ar,
      s.slug,
      s.parent_slug ?? '',
      s.family ? `family=${s.family}` : '',
    ]);
  }
  for (const b of lookups.brands) rows.push(['brand', b.slug, b.name_en, b.name_ar, b.slug, '', '']);
  for (const f of lookups.facets) rows.push(['facets', f.slug, f.name_en, f.name_ar, f.slug, '', `kind=${f.kind}`]);
  for (const h of lookups.hashtags) rows.push(['hashtags', h.tag, h.tag, h.name_ar, '', '', '']);
  return toCsv(rows);
}

/** The README section listing the accepted values. */
export function lookupsReadme(lookups: Lookups): string {
  const roots = lookups.sections.filter((s) => !s.parent_id);
  const subs = lookups.sections.filter((s) => !!s.parent_id);
  const block = (title: string, lines: string[]) =>
    `${title}\n${lines.length ? lines.join('\n') : '  (لا شيء بعد — أضف من صفحة التصنيفات في الإدارة)'}`;
  return [
    'القيم المتاحة لأعمدة التصنيف',
    '--------------------------',
    'الأقسام والعلامات والفلاتر تُقرأ من قاعدة البيانات لحظة تنزيل هذا الملف. أي قسم أو',
    'علامة أو فلتر أو هاشتاق تضيفه من صفحة «التصنيفات» في الإدارة يظهر هنا في التنزيل التالي.',
    '',
    'القيمة المكتوبة أدناه هي الـ slug: يُقبل الاسم الإنجليزي أو العربي أيضًا، لكن أكثر من قسم',
    'أو علامة قد يحملان الاسم نفسه — وعندها يُرفض السطر ويُطلب منك الـ slug، لذا فهو الأضمن.',
    'قيمة خارج هذه القوائم تُرفض، باستثناء الهاشتاقات: وسم جديد تكتبه يُضاف إلى القائمة.',
    '',
    block('category — القسم الرئيسي', roots.map((s) => lookupLine(s.slug, `${s.name_en}${s.name_ar ? ` / ${s.name_ar}` : ''}`, s.family ? `القالب: ${s.family}` : 'بلا قالب'))),
    '',
    block('sub_category — القسم الفرعي (يجب أن يتبع القسم الرئيسي المذكور)', subs.map((s) => lookupLine(s.slug, `${s.name_en}${s.name_ar ? ` / ${s.name_ar}` : ''}`, `تحت: ${s.parent_slug ?? s.parent_name_en}`))),
    '',
    block('brand — العلامة التجارية', lookups.brands.map((b) => lookupLine(b.slug, `${b.name_en}${b.name_ar ? ` / ${b.name_ar}` : ''}`, ''))),
    '',
    block('facets — الفلاتر (افصل بين أكثر من فلتر بـ |)', lookups.facets.map((f) => lookupLine(f.slug, f.name_ar || f.name_en, `النوع: ${f.kind}`))),
    '',
    block('hashtags — الهاشتاقات (افصل بـ | — يمكن كتابة وسم جديد وسيُضاف إلى القائمة)', lookups.hashtags.map((h) => lookupLine(h.tag, h.name_ar, ''))),
    '',
    'الملف lookups.csv داخل الـ ZIP يحمل القوائم نفسها كجدول يمكن فرزه في Excel.',
  ].join('\n');
}

/** The README that ships inside the ZIP. */
export function readmeFor(shape: TemplateShape, lookups?: Lookups): string {
  const specList = shape.specFields
    .map((f) => `  ${SPEC_PREFIX}${f.id}${f.unit ? ` (${f.unit})` : ''} — ${f.label_ar} / ${f.label_en}`)
    .join('\n');
  return `LEVONIS — قالب استيراد المنتجات (${FAMILIES[shape.family].label_ar} / ${FAMILIES[shape.family].label_en})

كيف يعمل الملف
--------------
كل منتج يمتد على عدة أسطر، والعمود الأول row_type يحدد نوع السطر:

  product   المنتج نفسه (سطر واحد لكل منتج)
  option    قيمة واحدة من مجموعة خيارات
  color     لون واحد، مع روابطه بالخيارات
  image     صورة واحدة

تُربط الأسطر بالمنتج عبر العمود key — وهو SKU المنتج أو الـ slug.
كرّر نفس القيمة في كل أسطر المنتج.

قواعد مهمة
----------
* الإدخال بالإنجليزية فقط. الترجمة إلى العربية والكردية تتم محليًا على الخادم
  بعد الاستيراد، بلا أي ذكاء اصطناعي وبلا أي اتصال خارجي.
* الأسعار أرقام صحيحة بالدينار. الترتيب المطلوب: PRO ≤ PRIME ≤ الاعتيادي،
  ولا يجوز أن يساوي سعر البيع التكلفة.
* روابط اللون تُكتب Group:Value مفصولة بـ | — داخل المجموعة «أو»، وبين
  المجموعات «و». لون بلا روابط يظهر مع كل الخيارات.
* صورة رئيسية واحدة فقط لكل منتج. إن لم تحدد واحدة تُعتمد الأولى.
* عمود image إمّا اسم ملف داخل مجلد images/ في هذا الـ ZIP، أو رابط مباشر
  إلى ملف صورة. لا يُقرأ من صفحات المنتجات إطلاقًا.
* المعاينة لا تكتب أي شيء في قاعدة البيانات. الكتابة تحدث فقط بعد التأكيد،
  وإعادة التأكيد بنفس import_id لا تكرر شيئًا.

الأعمدة الخاصة بهذا القسم
-------------------------
${specList || '  (لا توجد حقول مواصفات لهذا القسم)'}

${lookups ? `${lookupsReadme(lookups)}\n\n` : ''}الملفات
-------
  data.csv     البيانات (UTF-8، مفصولة بفواصل)
  lookups.csv  القيم المتاحة للأقسام والعلامات والفلاتر والهاشتاقات
  images/      ضع هنا الصور المذكورة في أعمدة image
  README.txt   هذا الملف
`;
}
