/**
 * The import/export format — mandate §10, extended to the whole product form.
 *
 * ONE PRODUCT SPANS SEVERAL ROWS, distinguished by the first column
 * `row_type`. The alternative — packing options, colours, links and images
 * into encoded strings inside a single row — is unreadable in Excel, painful
 * to validate and impossible to give a useful error message for. With row
 * types, "row 14: colour hex is not #RRGGBB" points at a real line in the
 * file the admin is looking at.
 *
 *   product    the product itself, plus the spec columns its type declares
 *   option     one value of one option group
 *   color      one colour, with its links to option values
 *   variant    one stock combination of option values (and optionally a colour)
 *   image      one gallery image, with its primary flag and binding
 *   transport  one pre-order shipping method and its commission
 *   spec       one specification row, inside a named specification group
 *   label      one badge shown on the product card
 *   warranty   one warranty plan, its duration and its fee
 *   content    one bottom-of-page content block (text / image / video)
 *   guide      one step of the setup-and-usage guide
 *
 * EVERY FIELD OF THE PRODUCT FORM HAS A HOME HERE (the owner's «ويشمل كل شي
 * كل الحقول في اضافه المنتج»). Sections 1–8 of the form map onto the product
 * row and the ten child row types above; docs/IMPORT_TEMPLATE.md holds the
 * table, and tests/importCsv.test.ts asserts that no form field is missing.
 *
 * Rows are attached to their product by `key` — the product's SKU, or its
 * slug when it has no SKU. Every child row repeats the parent key, so the
 * file can be sorted, filtered or split in a spreadsheet without breaking.
 *
 * COLUMNS FOLLOW THE PRODUCT TYPE (طابعة / ملحقات / فلمنت / اكسسوار). The
 * spec columns come from worker/lib/templateFamilies.ts for the chosen type,
 * so a printer template never shows a filament diameter and a filament
 * template never shows a nozzle — «ولا تظهر أعمدة لا تخص المنتج». The same
 * definition drives the form's specification fields, so a column and a form
 * field cannot drift apart.
 *
 * VALUES ARE CHECKED, NOT ONLY SHAPES. A `select` spec field only accepts one
 * of its declared options, a `number` field only a number, a `hex` field only
 * #RRGGBB, and every enum column (status, sale types, transport method,
 * warranty kind, content kind, guide kind, label key) names its accepted
 * values back to the admin when it refuses one. That is the precision the
 * owner asked for: a wrong cell is refused at preview time with the line
 * number and the list of what it should have said.
 *
 * ROUND-TRIP. `serializeProducts` and `parseImport` are inverses: exporting a
 * product and re-importing it reproduces the same options, colours, links,
 * variants, images, specs, labels, warranty plans, content blocks, guide
 * steps, order, stock and prices. tests/importCsv.test.ts holds that line.
 *
 * NO SCRAPING. An image cell is either a file name inside the ZIP or a URL
 * that must point directly at an image file; the server verifies it by magic
 * bytes (worker/routes/media.ts). A product-page URL is rejected, not read.
 */

import { derivedRung, type LadderRungs, type PriceFields } from './pricing';
import {
  PRODUCT_TYPES,
  flatFields,
  groupsForType,
  narrowGroups,
  type SectionRef,
  productType,
  type ProductTypeId,
  type TemplateField,
} from './templateFamilies';
import { AVAILABILITY_TYPES, normalizeAvailability, variantKeyFrom, variantLabelFallback } from './availability';
import type { Lookups } from './lookups';
import { parseFeePercent } from './warrantyPlans';

export type RowType =
  | 'product'
  | 'option'
  | 'color'
  | 'variant'
  | 'image'
  | 'transport'
  | 'spec'
  | 'label'
  | 'warranty'
  | 'content'
  | 'guide';

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

/**
 * Columns every template carries, in order: the product's own fields first,
 * then the columns the child rows write into. `facets` is deliberately GONE —
 * the owner removed the filters picker from the product form («احذف الفلاتر
 * هي تابعه او نفسها القسم الفرعي»), and a column for a field the form no
 * longer has would be a way to set something nobody can see or correct.
 */
export const BASE_COLUMNS = [
  'row_type',
  'key',
  // ---- section 1-2 of the form: identity and classification
  'name',
  'description',
  'status',
  'sku',
  'display_order',
  'is_featured',
  'brand',
  'category',
  'sub_category',
  'hashtags',
  // ---- section 3-4: prices, sale types, stock
  'sale_types',
  'inventory_mode',
  'price_iqd',
  'prime_price_iqd',
  'pro_price_iqd',
  'cost_iqd',
  'direct_surcharge_iqd',
  'stock',
  'low_stock_threshold',
  // ---- device coverage (products.ops_policy): the base the extended warranty
  // adds to (printers default to 12) and whether a unit is recorded per device
  'warranty_base_months',
  'serialized',
  // ---- 0044: an ADJUSTMENT instead of a pin — "+60,000 above the base",
  // which keeps following the base instead of freezing away from it.
  'regular_adjust_iqd',
  'prime_adjust_iqd',
  'pro_adjust_iqd',
  'cost_adjust_iqd',
  // ---- 0043: an option answers for itself (blank = inherit the product's)
  'availability_type',
  'lead_time_text',
  'lead_time_min_days',
  'lead_time_max_days',
  'variant_key',
  'variant_label',
  'payment_options',
  // ---- section 7: how it is used
  'how_to_use',
  'usage_url',
  // ---- child-row columns
  'group',
  'value',
  'label',
  'hex',
  'sku_part',
  'links',
  'image',
  'alt',
  'unit',
  'kind',
  'body',
  'url',
  'duration_months',
  // the extended-warranty fee as a share of the printer price (7.5, 10);
  // empty = the fixed price_iqd applies
  'percent',
  'primary',
  'active',
] as const;

export const SPEC_PREFIX = 'spec.';

/** The four product types the panel offers, with the column count each one
 *  produces so an admin can see the narrowing before downloading. */
export function templateTypeChoices(): Array<{
  id: ProductTypeId;
  label_ar: string;
  label_en: string;
  hint_ar: string;
  family: 'devices' | 'materials';
  spec_columns: number;
}> {
  return PRODUCT_TYPES.map((t) => ({
    id: t.id,
    label_ar: t.label_ar,
    label_en: t.label_en,
    hint_ar: t.hint_ar,
    family: t.family,
    spec_columns: flatFields(groupsForType(t.id)).length,
  }));
}

/** Enumerations the sheet accepts, named back to the admin when refused. */
export const SALE_TYPES = ['direct_sale', 'pre_order', 'bundle'] as const;
export const STATUSES = ['draft', 'active', 'hidden'] as const;
export const INVENTORY_MODES = ['BASE', 'OPTION', 'COLOR', 'VARIANT_COMBINATION'] as const;
export const TRANSPORT_METHODS = ['air', 'sea', 'land'] as const;
export const WARRANTY_KINDS = ['total', 'extension'] as const;
export const CONTENT_KINDS = ['text', 'image', 'video_embed'] as const;
export const GUIDE_KINDS = ['setup', 'usage'] as const;
export const LABEL_KEYS = ['featured', 'warranty_included', 'free_returns', 'free_plus'] as const;

export interface TemplateShape {
  columns: string[];
  specFields: TemplateField[];
  /** The product type the columns were built for. */
  type: ProductTypeId;
  family: 'devices' | 'materials';
  sectionSlugs: string[];
}

/**
 * The column list for one product type: base columns then its spec columns.
 *
 * WITH A BRANCH the columns narrow to the technology that branch names — a
 * sheet downloaded for «طابعات FDM» carries no `spec.lcd_size`, because the
 * import sheet and the product form must offer the same fields or an admin
 * fills a column the form will file under "preserved outside this section".
 *
 * WITHOUT ONE the union stands. `GET /template?type=printer` is a request for
 * "a printer sheet" with no section chosen, and narrowing it to one technology
 * would be inventing an answer the admin did not give.
 */
export function templateShape(
  type: ProductTypeId,
  sectionSlugs: string[] = [],
  { includeCost = true, branch = [] }: { includeCost?: boolean; branch?: SectionRef[] } = {}
): TemplateShape {
  const def = productType(type);
  // The branch narrows within the type; it never re-picks the type, because a
  // caller passing `?type=` has already made that decision explicitly.
  const specFields = flatFields(branch.length ? narrowGroups(type, branch) : groupsForType(type));
  const base = BASE_COLUMNS.filter((c) => (includeCost ? true : c !== 'cost_iqd'));
  return {
    columns: [...base, ...specFields.map((f) => `${SPEC_PREFIX}${f.id}`)],
    specFields,
    type,
    family: def.family,
    sectionSlugs,
  };
}

/** A human-readable header line under the machine one, so a spreadsheet shows
 *  the Arabic label without the parser ever depending on it. */
export function labelRow(shape: TemplateShape): string[] {
  const labels: Record<string, string> = {
    row_type: 'نوع السطر — انظر README',
    key: 'مفتاح المنتج (SKU أو slug) — يتكرر في كل أسطر المنتج',
    name: 'الاسم بالإنجليزية',
    description: 'الوصف بالإنجليزية',
    status: `الحالة (${STATUSES.join('/')})`,
    sku: 'رمز المنتج SKU (فارغ = يُشتق من key)',
    display_order: 'ترتيب العرض (رقم)',
    is_featured: 'منتج مميز (yes/no)',
    brand: 'العلامة التجارية',
    category: 'القسم الرئيسي',
    sub_category: 'القسم الفرعي',
    hashtags: 'الهاشتاقات (tag|tag)',
    sale_types: `أنواع البيع (${SALE_TYPES.join('|')})`,
    inventory_mode: `مصدر المخزون (${INVENTORY_MODES.join('/')})`,
    price_iqd: 'السعر الاعتيادي',
    prime_price_iqd: 'سعر PRIME',
    pro_price_iqd: 'سعر PRO',
    cost_iqd: 'التكلفة (إداري — لا تُنشر)',
    direct_surcharge_iqd: 'زيادة التوفر الفوري (للبيع المباشر)',
    stock: 'المخزون',
    low_stock_threshold: 'حد التنبيه',
    warranty_base_months: 'مدة الضمان الأساسي بالأشهر (الطابعات 12؛ فارغ = كما هو محفوظ)',
    serialized: 'جهاز مُرقَّم — وحدة لكل جهاز عند التسليم (yes/no؛ فارغ = كما هو محفوظ)',
    payment_options: 'طرق الدفع المسموحة (id|id)',
    how_to_use: 'طريقة الاستخدام (نص)',
    usage_url: 'رابط الدليل الرسمي',
    group: 'مجموعة الخيار / عنوان مجموعة المواصفات',
    value: 'قيمة الخيار / اسم اللون / العنوان',
    label: 'اسم المواصفة (سطر spec)',
    hex: 'كود اللون #RRGGBB',
    sku_part: 'جزء SKU',
    links: 'الروابط (Group:Value|Group:Value)',
    image: 'الصورة (اسم ملف داخل ZIP أو رابط مباشر)',
    alt: 'نص بديل',
    unit: 'الوحدة (mm، g، W…)',
    kind: 'النوع — يختلف حسب سطر الصف',
    body: 'النص الطويل (شروط الضمان / كتلة المحتوى / خطوة الدليل)',
    url: 'رابط (فيديو أو صورة أو مستند)',
    duration_months: 'مدة التمديد بالأشهر (الطابعات: 12 أو 24)',
    percent: 'رسم التمديد كنسبة من سعر الطابعة (مثال 7.5 أو 10؛ فارغ = رسم ثابت price_iqd)',
    primary: 'صورة رئيسية (yes/no)',
    active: 'مفعّل / ظاهر (yes/no)',
  };
  const byId = new Map(shape.specFields.map((f) => [f.id, f]));
  return shape.columns.map((c) => {
    if (c.startsWith(SPEC_PREFIX)) {
      const f = byId.get(c.slice(SPEC_PREFIX.length));
      if (!f) return c;
      const suffix = f.unit ? ` (${f.unit})` : f.options ? ` (${f.options.join(' / ')})` : '';
      return `${f.label_ar}${suffix}`;
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
  sku: string;
  display_order: number | null;
  is_featured: boolean | null;
  brand: string;
  category: string;
  sub_category: string;
  sale_types: string[];
  inventory_mode: string;
  price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  direct_surcharge_iqd: number | null;
  stock: number | null;
  low_stock_threshold: number | null;
  /**
   * Device coverage (products.ops_policy). Both are null when the column is
   * absent OR the cell is empty — "keep what is stored" — because a blank
   * here is far more often an older sheet than a decision to un-configure a
   * printer; clearing is done in the form. A printer gets 12 / yes by default
   * on import when nothing is stored (worker/lib/warrantyPlans.ts).
   */
  warranty_base_months: number | null;
  serialized: boolean | null;
  /** null when the column is absent, so an older sheet keeps stored values. */
  payment_options: string[] | null;
  how_to_use: string | null;
  usage_url: string | null;
  /** null when the sheet has no hashtags column at all, so an older file
   *  leaves a product's stored tags alone instead of clearing them. */
  hashtags: string[] | null;
  spec_fields: Record<string, string>;
  options: ParsedOption[];
  colors: ParsedColor[];
  variants: ParsedVariant[];
  images: ParsedImage[];
  /**
   * The child collections below are null when the file carries NO row of that
   * type for this product, and an array (possibly empty) when it does. That
   * distinction is the difference between "this sheet does not talk about
   * warranty plans" and "this product has no warranty plans": the first
   * preserves what is stored, the second clears it. A sheet exported from
   * this product always carries its rows, so the round-trip is exact.
   */
  transports: ParsedTransport[] | null;
  specs: ParsedSpec[] | null;
  labels: ParsedLabel[] | null;
  warranty_plans: ParsedWarranty[] | null;
  content_blocks: ParsedContent[] | null;
  guide_steps: ParsedGuideStep[] | null;
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
  /** 0044 adjustments — signed; null = this row has no adjustment. */
  regular_adjust_iqd: number | null;
  prime_adjust_iqd: number | null;
  pro_adjust_iqd: number | null;
  cost_adjust_iqd: number | null;
  /** 0043: how THIS option is fulfilled. '' = inherit the product's. */
  availability_type: string;
  lead_time_text: string;
  lead_time_min_days: number | null;
  lead_time_max_days: number | null;
  variant_key: string;
  variant_label: string;
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
  /** 0044 adjustments — signed; null = this row has no adjustment. */
  regular_adjust_iqd: number | null;
  prime_adjust_iqd: number | null;
  pro_adjust_iqd: number | null;
  cost_adjust_iqd: number | null;
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

/** One stock combination, named by the option values (and colour) it selects:
 *  `Printer:A1|Plug:EU|color:Black`. */
export interface ParsedVariant {
  line: number;
  selection: Array<{ group: string; value: string }>;
  color: string;
  sku_part: string;
  active: boolean;
  stock: number | null;
  low_stock_threshold: number | null;
  price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
}

export interface ParsedTransport {
  line: number;
  method: string;
  /** null = inherit the admin default commission for this method. */
  commission_iqd: number | null;
  active: boolean;
}

export interface ParsedSpec {
  line: number;
  group: string;
  label: string;
  value: string;
  unit: string;
}

export interface ParsedLabel {
  line: number;
  key: string;
  text: string;
  icon: string;
  visible: boolean;
}

export interface ParsedWarranty {
  line: number;
  title: string;
  terms: string;
  duration_months: number | null;
  duration_kind: string;
  fee_iqd: number | null;
  /** The `percent` column — a share of the printer price; null = fixed fee. */
  fee_percent: number | null;
  active: boolean;
}

export interface ParsedContent {
  line: number;
  kind: string;
  body: string;
  caption: string;
  alt: string;
  url: string;
  image: string;
}

export interface ParsedGuideStep {
  line: number;
  kind: string;
  title: string;
  body: string;
  /** Up to six image cells, '|'-separated in the sheet. */
  images: string[];
  video_url: string;
  link_url: string;
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

/** A 0044 adjustment is SIGNED: "-15000" means fifteen thousand cheaper than
 *  the level above, which is the ordinary case for a member price. */
function signedCell(v: string, line: number, col: string, issues: RowIssue[]): number | null {
  const s = v.trim();
  if (s === '') return null;
  if (!/^[+-]?\d+$/.test(s)) {
    issues.push({ line, severity: 'error', message: `${col}: "${s}" ليس رقمًا صحيحًا` });
    return null;
  }
  return Number(s);
}

function intCell(v: string, line: number, col: string, issues: RowIssue[]): number | null {
  const s = v.trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) {
    issues.push({ line, severity: 'error', message: `${col}: "${s}" ليس رقمًا صحيحًا` });
    return null;
  }
  return Number(s);
}

/** A share of the price: 0.01..100 with at most two decimals ("7.5", "10"). */
function percentCell(v: string, line: number, col: string, issues: RowIssue[]): number | null {
  const s = v.trim();
  if (s === '') return null;
  const n = parseFeePercent(s);
  if (n === null) {
    issues.push({
      line,
      severity: 'error',
      message: `${col}: "${s}" ليست نسبة صالحة — اكتب رقمًا بين 0.01 و100 بمنزلتين عشريتين على الأكثر (مثال 7.5)`,
    });
    return null;
  }
  return n;
}

const splitList = (v: string) =>
  v
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

/** A cell that must be one of a fixed list. Empty falls back to `fallback`
 *  (or is refused when there is none); a wrong value names the whole list,
 *  because "kind: \"vidoe\" غير معروف" without the options is a dead end. */
function enumCell<T extends string>(
  raw: string,
  allowed: readonly T[],
  line: number,
  col: string,
  issues: RowIssue[],
  fallback: T | null
): T | null {
  const v = raw.trim();
  if (v === '') return fallback;
  const hit = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
  if (hit) return hit;
  issues.push({
    line,
    severity: 'error',
    message: `${col}: "${v}" غير مقبول — القيم المتاحة: ${allowed.join(' / ')}`,
  });
  return fallback;
}

/** yes / no with a named error instead of a silent `true`. */
function boolCell(raw: string, line: number, col: string, issues: RowIssue[], fallback: boolean): boolean {
  const v = raw.trim();
  if (v === '') return fallback;
  if (yes(v)) return true;
  if (no(v)) return false;
  issues.push({ line, severity: 'error', message: `${col}: "${v}" — اكتب yes أو no` });
  return fallback;
}

/**
 * A spec cell checked against the field that declared it. A `select` field
 * only accepts one of its options, a `number` field only a number and a `hex`
 * field only #RRGGBB — so a typo is refused at preview with the line number
 * and the accepted values, instead of being stored and shown to a customer.
 */
function checkSpecCell(f: TemplateField, raw: string, line: number, issues: RowIssue[]): string {
  const v = raw.trim();
  if (v === '') return '';
  const col = `${SPEC_PREFIX}${f.id}`;
  if (f.options && f.options.length) {
    const hit = f.options.find((o) => o.toLowerCase() === v.toLowerCase());
    if (!hit) {
      issues.push({
        line,
        severity: 'error',
        message: `${col}: "${v}" غير مقبول — القيم المتاحة: ${f.options.join(' / ')}`,
      });
      return '';
    }
    return hit;
  }
  if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) {
    issues.push({ line, severity: 'error', message: `${col}: "${v}" ليس رقمًا` });
    return '';
  }
  if (f.type === 'hex' && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
    issues.push({ line, severity: 'error', message: `${col}: "${v}" ليس #RGB أو #RRGGBB` });
    return '';
  }
  return v;
}

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

  // The inverse of `defuse` in toCsv: the export prefixes a cell that starts
  // with = + - @ with a single quote so a spreadsheet does not run it as a
  // formula. A file uploaded straight back (never opened in a spreadsheet,
  // which would have eaten the quote) still carries it — and without this a
  // −5,000 adjustment the store itself wrote was refused as "not a number".
  const cell = (r: string[], name: string) => {
    const i = index.get(name);
    return i === undefined ? '' : (r[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '');
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
        const v = checkSpecCell(f, cell(r, `${SPEC_PREFIX}${f.id}`), line, issues);
        if (v) spec[f.id] = v;
      }
      const saleTypes: string[] = [];
      for (const st of splitList(cell(r, 'sale_types'))) {
        const ok = enumCell(st, SALE_TYPES, line, 'sale_types', issues, null);
        if (ok) saleTypes.push(ok);
      }
      products.set(key, {
        key,
        line,
        name: cell(r, 'name'),
        description: cell(r, 'description'),
        status: enumCell(cell(r, 'status'), STATUSES, line, 'status', issues, 'draft') ?? 'draft',
        sku: cell(r, 'sku'),
        display_order: intCell(cell(r, 'display_order'), line, 'display_order', issues),
        is_featured: index.has('is_featured')
          ? boolCell(cell(r, 'is_featured'), line, 'is_featured', issues, false)
          : null,
        brand: cell(r, 'brand'),
        category: cell(r, 'category'),
        sub_category: cell(r, 'sub_category'),
        sale_types: saleTypes,
        inventory_mode:
          enumCell(cell(r, 'inventory_mode'), INVENTORY_MODES, line, 'inventory_mode', issues, 'BASE') ?? 'BASE',
        price_iqd: intCell(cell(r, 'price_iqd'), line, 'price_iqd', issues),
        prime_price_iqd: intCell(cell(r, 'prime_price_iqd'), line, 'prime_price_iqd', issues),
        pro_price_iqd: intCell(cell(r, 'pro_price_iqd'), line, 'pro_price_iqd', issues),
        cost_iqd: intCell(cell(r, 'cost_iqd'), line, 'cost_iqd', issues),
        direct_surcharge_iqd: intCell(
          cell(r, 'direct_surcharge_iqd'),
          line,
          'direct_surcharge_iqd',
          issues
        ),
        stock: intCell(cell(r, 'stock'), line, 'stock', issues),
        low_stock_threshold: intCell(cell(r, 'low_stock_threshold'), line, 'low_stock_threshold', issues),
        warranty_base_months: intCell(cell(r, 'warranty_base_months'), line, 'warranty_base_months', issues),
        serialized:
          cell(r, 'serialized') === '' ? null : boolCell(cell(r, 'serialized'), line, 'serialized', issues, false),
        payment_options: index.has('payment_options') ? splitList(cell(r, 'payment_options')) : null,
        how_to_use: index.has('how_to_use') ? cell(r, 'how_to_use') : null,
        usage_url: index.has('usage_url') ? cell(r, 'usage_url') : null,
        hashtags: index.has('hashtags') ? splitList(cell(r, 'hashtags')) : null,
        spec_fields: spec,
        options: [],
        colors: [],
        variants: [],
        images: [],
        transports: null,
        specs: null,
        labels: null,
        warranty_plans: null,
        content_blocks: null,
        guide_steps: null,
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

    const active = boolCell(cell(r, 'active'), line, 'active', issues, true);
    const money = () => ({
      price_iqd: intCell(cell(r, 'price_iqd'), line, 'price_iqd', issues),
      prime_price_iqd: intCell(cell(r, 'prime_price_iqd'), line, 'prime_price_iqd', issues),
      pro_price_iqd: intCell(cell(r, 'pro_price_iqd'), line, 'pro_price_iqd', issues),
      cost_iqd: intCell(cell(r, 'cost_iqd'), line, 'cost_iqd', issues),
      regular_adjust_iqd: signedCell(cell(r, 'regular_adjust_iqd'), line, 'regular_adjust_iqd', issues),
      prime_adjust_iqd: signedCell(cell(r, 'prime_adjust_iqd'), line, 'prime_adjust_iqd', issues),
      pro_adjust_iqd: signedCell(cell(r, 'pro_adjust_iqd'), line, 'pro_adjust_iqd', issues),
      cost_adjust_iqd: signedCell(cell(r, 'cost_adjust_iqd'), line, 'cost_adjust_iqd', issues),
    });
    const counts = () => ({
      stock: intCell(cell(r, 'stock'), line, 'stock', issues),
      low_stock_threshold: intCell(cell(r, 'low_stock_threshold'), line, 'low_stock_threshold', issues),
    });
    /** `Group:Value` pairs out of the links column, with the colour split off. */
    const parseLinks = () => {
      const pairs: Array<{ group: string; value: string }> = [];
      let color = '';
      for (const part of splitList(cell(r, 'links'))) {
        const idx = part.indexOf(':');
        if (idx <= 0 || idx === part.length - 1) {
          issues.push({ line, severity: 'error', message: `links: "${part}" يجب أن تكون Group:Value` });
          continue;
        }
        const head = part.slice(0, idx).trim();
        const tail = part.slice(idx + 1).trim();
        if (head.toLowerCase() === 'color') color = tail;
        else pairs.push({ group: head, value: tail });
      }
      return { pairs, color };
    };

    if (type === 'option') {
      const group = cell(r, 'group');
      const value = cell(r, 'value');
      if (!group || !value) {
        issues.push({ line, severity: 'error', message: 'سطر option يحتاج group و value' });
        continue;
      }
      // 0043. An unknown word is refused by name rather than silently
      // inherited: in a spreadsheet a typo like "preordr" is the likeliest
      // mistake there is, and quietly selling a pre-order as direct stock is
      // the worst way to find out.
      const availabilityRaw = cell(r, 'availability_type');
      const availability = normalizeAvailability(availabilityRaw);
      if (availabilityRaw && !availability) {
        issues.push({
          line,
          severity: 'error',
          message: `availability_type: "${availabilityRaw}" غير مقبول — القيم المتاحة: ${AVAILABILITY_TYPES.join(' / ')}`,
        });
      }
      const leadText = cell(r, 'lead_time_text');
      const leadMin = intCell(cell(r, 'lead_time_min_days'), line, 'lead_time_min_days', issues);
      const leadMax = intCell(cell(r, 'lead_time_max_days'), line, 'lead_time_max_days', issues);
      if (leadMin !== null && leadMax !== null && leadMin > leadMax) {
        issues.push({ line, severity: 'error', message: 'lead_time_min_days: أكبر من lead_time_max_days' });
      }
      if (availability === 'direct_sale' && (leadText || leadMin !== null || leadMax !== null)) {
        issues.push({ line, severity: 'error', message: 'lead_time_text: خيار بيع مباشر بلا مدة انتظار — احذف المدة أو اجعله طلبًا مسبقًا' });
      }
      const variantLabel = cell(r, 'variant_label') || variantLabelFallback(value);
      parent.options.push({
        line,
        group,
        value,
        sku_part: cell(r, 'sku_part'),
        image: cell(r, 'image'),
        active,
        ...counts(),
        ...money(),
        availability_type: availability,
        lead_time_text: leadText,
        lead_time_min_days: availability === 'direct_sale' ? null : leadMin,
        lead_time_max_days: availability === 'direct_sale' ? null : leadMax,
        variant_key: cell(r, 'variant_key') || variantKeyFrom(variantLabel),
        variant_label: variantLabel,
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
      parent.colors.push({
        line,
        name,
        hex: hex.toLowerCase(),
        sku_part: cell(r, 'sku_part'),
        image: cell(r, 'image'),
        active,
        ...counts(),
        ...money(),
        links: parseLinks().pairs,
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

    if (type === 'variant') {
      const { pairs, color } = parseLinks();
      if (pairs.length === 0 && !color) {
        issues.push({
          line,
          severity: 'error',
          message: 'سطر variant يحتاج التوليفة في عمود links — مثال: Printer:A1|Plug:EU|color:Black',
        });
        continue;
      }
      parent.variants.push({
        line,
        selection: pairs,
        color,
        sku_part: cell(r, 'sku_part'),
        active,
        ...counts(),
        ...money(),
      });
      continue;
    }

    if (type === 'transport') {
      const method = enumCell(cell(r, 'value'), TRANSPORT_METHODS, line, 'value', issues, null);
      if (!method) continue;
      parent.transports ??= [];
      parent.transports.push({
        line,
        method,
        commission_iqd: intCell(cell(r, 'price_iqd'), line, 'price_iqd', issues),
        active,
      });
      continue;
    }

    if (type === 'spec') {
      const label = cell(r, 'label');
      if (!label) {
        issues.push({ line, severity: 'error', message: 'سطر spec يحتاج اسم المواصفة في عمود label' });
        continue;
      }
      parent.specs ??= [];
      parent.specs.push({
        line,
        group: cell(r, 'group'),
        label,
        value: cell(r, 'value'),
        unit: cell(r, 'unit'),
      });
      continue;
    }

    if (type === 'label') {
      const text = cell(r, 'value');
      const rawKey = cell(r, 'kind');
      const key = rawKey === '' ? '' : (enumCell(rawKey, LABEL_KEYS, line, 'kind', issues, null) ?? '');
      if (!text && !key) {
        issues.push({ line, severity: 'error', message: 'سطر label يحتاج نصًا في عمود value أو مفتاحًا في عمود kind' });
        continue;
      }
      parent.labels ??= [];
      parent.labels.push({ line, key, text, icon: cell(r, 'image'), visible: active });
      continue;
    }

    if (type === 'warranty') {
      const title = cell(r, 'value');
      if (!title) {
        issues.push({ line, severity: 'error', message: 'سطر warranty يحتاج عنوان الخطة في عمود value' });
        continue;
      }
      const months = intCell(cell(r, 'duration_months'), line, 'duration_months', issues);
      if (months === null || months < 1 || months > 240) {
        issues.push({ line, severity: 'error', message: 'duration_months: مدة الضمان بالأشهر مطلوبة بين 1 و240' });
        continue;
      }
      const fee = intCell(cell(r, 'price_iqd'), line, 'price_iqd', issues);
      parent.warranty_plans ??= [];
      parent.warranty_plans.push({
        line,
        title,
        terms: cell(r, 'body'),
        duration_months: months,
        // An extension over the base warranty is the only kind a printer may
        // offer, so it is the default; 'total' stays readable for old data.
        duration_kind: enumCell(cell(r, 'kind'), WARRANTY_KINDS, line, 'kind', issues, 'extension') ?? 'extension',
        // A warranty fee is never inherited: an empty cell means free, and
        // saying so beats a null that the resolver would have to guess at.
        fee_iqd: fee ?? 0,
        // The owner's model: a share of the printer price (7.5 → 7.5%).
        fee_percent: percentCell(cell(r, 'percent'), line, 'percent', issues),
        active,
      });
      continue;
    }

    if (type === 'content') {
      const rawKind = cell(r, 'kind');
      if (rawKind === '') {
        issues.push({
          line,
          severity: 'error',
          message: `سطر content يحتاج نوعًا في عمود kind — القيم المتاحة: ${CONTENT_KINDS.join(' / ')}`,
        });
        continue;
      }
      const kind = enumCell(rawKind, CONTENT_KINDS, line, 'kind', issues, null);
      if (!kind) continue;
      parent.content_blocks ??= [];
      parent.content_blocks.push({
        line,
        kind,
        body: cell(r, 'body'),
        caption: cell(r, 'value'),
        alt: cell(r, 'alt'),
        url: cell(r, 'url'),
        image: cell(r, 'image'),
      });
      continue;
    }

    if (type === 'guide') {
      const title = cell(r, 'value');
      if (!title) {
        issues.push({ line, severity: 'error', message: 'سطر guide يحتاج عنوان الخطوة في عمود value' });
        continue;
      }
      const images = splitList(cell(r, 'image'));
      if (images.length > 6) {
        issues.push({ line, severity: 'error', message: 'guide: أقصى ٦ صور للخطوة الواحدة' });
        continue;
      }
      parent.guide_steps ??= [];
      parent.guide_steps.push({
        line,
        kind: enumCell(cell(r, 'kind'), GUIDE_KINDS, line, 'kind', issues, 'usage') ?? 'usage',
        title,
        body: cell(r, 'body'),
        images,
        video_url: cell(r, 'url'),
        link_url: cell(r, 'links'),
      });
      continue;
    }

    issues.push({
      line,
      severity: 'error',
      message: `row_type غير معروف: "${type}" — الأنواع المتاحة: product / option / color / variant / image / transport / spec / label / warranty / content / guide`,
    });
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
    // The member ladder follows the regular one (worker/lib/pricing.ts
    // memberAtRung): a row that states no PRIME/PRO inherits the base member
    // price PLUS its own surcharge. A reduction at least as large as that
    // member price would leave the member no discount at all — refused
    // unless the row states its own member price. So is a row whose derived
    // PRIME lands below its derived PRO: the resolver would charge a PRIME
    // member the PRO number, one the row never shows.
    type CsvPrices = {
      price_iqd: number | null; regular_adjust_iqd: number | null;
      prime_price_iqd: number | null; prime_adjust_iqd: number | null;
      pro_price_iqd: number | null; pro_adjust_iqd: number | null;
    };
    const fieldsOf = (row: CsvPrices): PriceFields => ({
      regular_price_iqd: row.price_iqd, prime_price_iqd: row.prime_price_iqd, pro_price_iqd: row.pro_price_iqd, cost_iqd: null,
      regular_adjust_iqd: row.regular_adjust_iqd, prime_adjust_iqd: row.prime_adjust_iqd, pro_adjust_iqd: row.pro_adjust_iqd, cost_adjust_iqd: null,
    });
    const base: LadderRungs | null =
      p.price_iqd === null ? null : { regular: p.price_iqd, prime: p.prime_price_iqd, pro: p.pro_price_iqd };
    const memberCarried = (where: string, line: number, row: CsvPrices, under: Array<{ name: string; ladder: LadderRungs }> = []) => {
      if (!base) return;
      const d = derivedRung(fieldsOf(row), base);
      for (const f of d.consumed) {
        issues.push({ line, severity: 'error', message: `${where}: التخفيض أكبر من سعر ${f.toUpperCase()} الموروث — حدّد سعر ${f.toUpperCase()} لهذا الصف أو قلّل التخفيض` });
      }
      if (d.prime !== null && d.prime > d.regular) issues.push({ line, severity: 'error', message: `${where}: سعر PRIME الناتج أعلى من الاعتيادي` });
      if (d.pro !== null && d.pro > d.regular) issues.push({ line, severity: 'error', message: `${where}: سعر PRO الناتج أعلى من الاعتيادي` });
      if (d.inverted) {
        issues.push({ line, severity: 'error', message: `${where}: سعر PRIME الناتج (${d.prime}) أقل من سعر PRO الناتج (${d.pro}) — يجب PRO ≤ PRIME ≤ الاعتيادي` });
      }
      // A colour anchors on the option the customer picks: the same two
      // checks, once under each option it can be sold with.
      for (const u of under) {
        const c = derivedRung(fieldsOf(row), u.ladder);
        for (const f of c.consumed) {
          issues.push({ line, severity: 'error', message: `${where} مع الخيار ${u.name}: التخفيض أكبر من سعر ${f.toUpperCase()} الموروث (${u.ladder[f]}) — حدّد سعر ${f.toUpperCase()} لهذا اللون أو قلّل التخفيض` });
        }
        if (c.inverted) {
          issues.push({ line, severity: 'error', message: `${where} مع الخيار ${u.name}: سعر PRIME الناتج (${c.prime}) أقل من سعر PRO الناتج (${c.pro}) — يجب PRO ≤ PRIME ≤ الاعتيادي` });
        }
      }
    };
    for (const o of p.options) {
      ladder(`الخيار ${o.value}`, o.line, o.price_iqd, o.prime_price_iqd, o.pro_price_iqd, o.cost_iqd);
      memberCarried(`الخيار ${o.value}`, o.line, o);
    }
    /** The active options a colour is sold with: the ones its links name, else all of them. */
    const activeOptions = p.options.filter((o) => o.active);
    const optionsUnder = (c: ParsedColor) =>
      (c.links.length
        ? activeOptions.filter((o) => c.links.some((l) => l.group === o.group && l.value === o.value))
        : activeOptions
      ).map((o) => ({ name: `${o.group}:${o.value}`, ladder: derivedRung(fieldsOf(o), base as LadderRungs) }));
    for (const c of p.colors) {
      ladder(`اللون ${c.name}`, c.line, c.price_iqd, c.prime_price_iqd, c.pro_price_iqd, c.cost_iqd);
      memberCarried(`اللون ${c.name}`, c.line, c, base ? optionsUnder(c) : []);
    }

    for (const v of p.variants) {
      ladder('التوليفة', v.line, v.price_iqd, v.prime_price_iqd, v.pro_price_iqd, v.cost_iqd);
    }

    // A colour link must name an option row that exists in THIS file.
    const values = new Set(p.options.map((o) => `${o.group}\u0000${o.value}`));
    const colorNames = new Set(p.colors.map((c) => c.name.trim().toLowerCase()));
    for (const c of p.colors) {
      for (const l of c.links) {
        if (!values.has(`${l.group}\u0000${l.value}`)) {
          issues.push({
            line: c.line,
            severity: 'error',
            message: `links: لا يوجد سطر option باسم "${l.group}:${l.value}" لهذا المنتج`,
          });
        }
      }
    }

    // A combination names option values and a colour, and every one of them
    // has to exist in this file — a combination pointing at nothing would be
    // stock nobody can ever buy.
    const combos = new Set<string>();
    for (const v of p.variants) {
      for (const l of v.selection) {
        if (!values.has(`${l.group}\u0000${l.value}`)) {
          issues.push({
            line: v.line,
            severity: 'error',
            message: `links: لا يوجد سطر option باسم "${l.group}:${l.value}" لهذا المنتج`,
          });
        }
      }
      if (v.color && !colorNames.has(v.color.trim().toLowerCase())) {
        issues.push({
          line: v.line,
          severity: 'error',
          message: `links: لا يوجد سطر color باسم "${v.color}" لهذا المنتج`,
        });
      }
      // Two rows selecting the same values are the same combination; letting
      // both through would mean two stock numbers for one thing to sell.
      const sig = [
        ...v.selection.map((l) => `${l.group.trim().toLowerCase()}:${l.value.trim().toLowerCase()}`).sort(),
        `color:${v.color.trim().toLowerCase()}`,
      ].join('|');
      if (combos.has(sig)) {
        issues.push({ line: v.line, severity: 'error', message: 'variant: هذه التوليفة مكررة في الملف' });
      }
      combos.add(sig);
    }

    // One warranty plan per title, one spec row per (group, label): a repeat
    // is a copy-paste slip, and merging it silently would drop one of them.
    const seenPlans = new Set<string>();
    for (const w of p.warranty_plans ?? []) {
      const k = w.title.trim().toLowerCase();
      if (seenPlans.has(k)) {
        issues.push({ line: w.line, severity: 'error', message: `warranty: الخطة "${w.title}" مكررة` });
      }
      seenPlans.add(k);
    }
    const seenSpecs = new Set<string>();
    for (const sp of p.specs ?? []) {
      const k = `${sp.group.trim().toLowerCase()}\u0000${sp.label.trim().toLowerCase()}`;
      if (seenSpecs.has(k)) {
        issues.push({ line: sp.line, severity: 'error', message: `spec: "${sp.label}" مكررة في نفس المجموعة` });
      }
      seenSpecs.add(k);
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
    if (p.inventory_mode === 'VARIANT_COMBINATION' && p.variants.length === 0) {
      issues.push({
        line: p.line,
        severity: 'error',
        message: 'inventory_mode=VARIANT_COMBINATION بلا أسطر variant — اكتب توليفة واحدة على الأقل',
      });
    }
    // Pre-order transports only mean something on a product actually sold
    // that way; accepting them on a direct-only product would store an offer
    // no checkout can ever reach.
    if ((p.transports?.length ?? 0) > 0 && p.sale_types.length > 0 && !p.sale_types.includes('pre_order')) {
      issues.push({
        line: p.transports![0].line,
        severity: 'error',
        message: 'سطر transport لمنتج لا يبيع بالطلب المسبق — أضف pre_order إلى sale_types أو احذف السطر',
      });
    }
    const seenMethods = new Set<string>();
    for (const tr of p.transports ?? []) {
      if (seenMethods.has(tr.method)) {
        issues.push({ line: tr.line, severity: 'error', message: `transport: "${tr.method}" مكرر` });
      }
      seenMethods.add(tr.method);
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
  sku: string;
  display_order: number;
  is_featured: boolean;
  brand: string;
  category: string;
  sub_category: string;
  sale_types: string[];
  inventory_mode: string;
  price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  direct_surcharge_iqd: number | null;
  stock: number | null;
  low_stock_threshold: number | null;
  /** Device coverage; null exports an empty cell ("keep what is stored"). */
  warranty_base_months: number | null;
  serialized: boolean | null;
  payment_options: string[];
  how_to_use: string;
  usage_url: string;
  hashtags: string[];
  spec_fields: Record<string, string>;
  options: Array<Omit<ParsedOption, 'line'>>;
  colors: Array<Omit<ParsedColor, 'line'>>;
  variants: Array<Omit<ParsedVariant, 'line'>>;
  images: Array<Omit<ParsedImage, 'line'>>;
  transports: Array<Omit<ParsedTransport, 'line'>>;
  specs: Array<Omit<ParsedSpec, 'line'>>;
  labels: Array<Omit<ParsedLabel, 'line'>>;
  warranty_plans: Array<Omit<ParsedWarranty, 'line'>>;
  content_blocks: Array<Omit<ParsedContent, 'line'>>;
  guide_steps: Array<Omit<ParsedGuideStep, 'line'>>;
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
      sku: p.sku,
      display_order: String(p.display_order ?? 0),
      is_featured: bool(p.is_featured),
      brand: p.brand,
      category: p.category,
      sub_category: p.sub_category,
      sale_types: p.sale_types.join('|'),
      inventory_mode: p.inventory_mode,
      price_iqd: num(p.price_iqd),
      prime_price_iqd: num(p.prime_price_iqd),
      pro_price_iqd: num(p.pro_price_iqd),
      cost_iqd: num(p.cost_iqd),
      direct_surcharge_iqd: num(p.direct_surcharge_iqd),
      stock: num(p.stock),
      low_stock_threshold: num(p.low_stock_threshold),
      warranty_base_months: num(p.warranty_base_months),
      serialized: p.serialized === null ? '' : bool(p.serialized),
      payment_options: p.payment_options.join('|'),
      how_to_use: p.how_to_use,
      usage_url: p.usage_url,
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
        regular_adjust_iqd: num(o.regular_adjust_iqd),
        prime_adjust_iqd: num(o.prime_adjust_iqd),
        pro_adjust_iqd: num(o.pro_adjust_iqd),
        cost_adjust_iqd: num(o.cost_adjust_iqd),
        // 0043 — written even when blank, so the exported sheet is editable
        // in both directions: an omitted cell is one the importer preserves.
        //
        // The variant pair is DERIVED here when it is missing, with exactly
        // the fallback the parser uses. Without that the round trip is not a
        // fixed point: the parser would fill a key the export left blank, and
        // exporting the result would differ from the file it came from — which
        // is precisely the drift tests/importCsv.test.ts exists to catch.
        availability_type: o.availability_type,
        lead_time_text: o.lead_time_text,
        lead_time_min_days: num(o.lead_time_min_days),
        lead_time_max_days: num(o.lead_time_max_days),
        variant_key: o.variant_key || variantKeyFrom(o.variant_label || variantLabelFallback(o.value)),
        variant_label: o.variant_label || variantLabelFallback(o.value),
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
        regular_adjust_iqd: num(c.regular_adjust_iqd),
        prime_adjust_iqd: num(c.prime_adjust_iqd),
        pro_adjust_iqd: num(c.pro_adjust_iqd),
        cost_adjust_iqd: num(c.cost_adjust_iqd),
        links: c.links.map((l) => `${l.group}:${l.value}`).join('|'),
      });
    }
    for (const v of p.variants) {
      put({
        row_type: 'variant',
        key: p.key,
        links: [
          ...v.selection.map((l) => `${l.group}:${l.value}`),
          ...(v.color ? [`color:${v.color}`] : []),
        ].join('|'),
        sku_part: v.sku_part,
        active: bool(v.active),
        stock: num(v.stock),
        low_stock_threshold: num(v.low_stock_threshold),
        price_iqd: num(v.price_iqd),
        prime_price_iqd: num(v.prime_price_iqd),
        pro_price_iqd: num(v.pro_price_iqd),
        cost_iqd: num(v.cost_iqd),
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
    for (const tr of p.transports) {
      put({
        row_type: 'transport',
        key: p.key,
        value: tr.method,
        price_iqd: num(tr.commission_iqd),
        active: bool(tr.active),
      });
    }
    for (const sp of p.specs) {
      put({ row_type: 'spec', key: p.key, group: sp.group, label: sp.label, value: sp.value, unit: sp.unit });
    }
    for (const l of p.labels) {
      put({
        row_type: 'label',
        key: p.key,
        kind: l.key,
        value: l.text,
        image: l.icon,
        active: bool(l.visible),
      });
    }
    for (const w of p.warranty_plans) {
      put({
        row_type: 'warranty',
        key: p.key,
        value: w.title,
        body: w.terms,
        duration_months: num(w.duration_months),
        kind: w.duration_kind,
        price_iqd: num(w.fee_iqd),
        percent: num(w.fee_percent),
        active: bool(w.active),
      });
    }
    for (const b of p.content_blocks) {
      put({
        row_type: 'content',
        key: p.key,
        kind: b.kind,
        body: b.body,
        value: b.caption,
        alt: b.alt,
        url: b.url,
        image: b.image,
      });
    }
    for (const g of p.guide_steps) {
      put({
        row_type: 'guide',
        key: p.key,
        kind: g.kind,
        value: g.title,
        body: g.body,
        image: g.images.join('|'),
        url: g.video_url,
        links: g.link_url,
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

  const put = (v: Record<string, string>) => rows.push(shape.columns.map((c) => v[c] ?? ''));
  for (const r of exampleRows(shape)) put(r);
  if (lookups) rows.push(...lookupRows(shape, lookups));
  return toCsv(rows);
}

/**
 * A WORKED EXAMPLE IN THE SHAPE OF THE TYPE the admin picked, so the first
 * thing they see is a product like the one they are about to type — a printer
 * example never shows a spool weight, and a filament example never shows a
 * build volume. Every row type the template supports appears at least once,
 * because a row type nobody demonstrates is a row type nobody uses.
 *
 * The rows are ordinary data rows (`row_type=product` and friends), so the
 * example is DELETED, not commented out, before a real import: leaving it in
 * would create a product called "Example". The README says so in one line.
 */
export function exampleRows(shape: TemplateShape): Array<Record<string, string>> {
  const key = `EXAMPLE-${shape.type.toUpperCase()}`;
  const spec: Record<string, string> = {};
  for (const f of shape.specFields.slice(0, 6)) {
    spec[`${SPEC_PREFIX}${f.id}`] =
      f.options?.[0] ?? (f.type === 'number' ? '10' : f.type === 'hex' ? '#1a1a1a' : 'Example');
  }

  const perType: Record<
    ProductTypeId,
    { name: string; description: string; price: string; options: Array<[string, string]>; colors: string[] }
  > = {
    printer: {
      name: 'Example FDM Printer',
      description: 'A worked example row — delete it before importing.',
      price: '750000',
      options: [
        ['Model', 'Standard'],
        ['Model', 'Combo'],
      ],
      colors: ['Black'],
    },
    parts: {
      name: 'Example Hardened Nozzle',
      description: 'A worked example row — delete it before importing.',
      price: '25000',
      options: [
        ['Diameter', '0.4'],
        ['Diameter', '0.6'],
      ],
      colors: [],
    },
    filament: {
      name: 'Example PLA Filament',
      description: 'A worked example row — delete it before importing.',
      price: '22000',
      options: [
        ['Weight', '1 kg'],
        ['Weight', '250 g'],
      ],
      colors: ['Black', 'White'],
    },
    accessory: {
      name: 'Example Filament Dryer',
      description: 'A worked example row — delete it before importing.',
      price: '95000',
      options: [['Plug', 'EU']],
      colors: [],
    },
  };
  const ex = perType[shape.type];
  const out: Array<Record<string, string>> = [];

  out.push({
    row_type: 'product',
    key,
    name: ex.name,
    description: ex.description,
    status: 'draft',
    sku: key,
    display_order: '0',
    is_featured: 'no',
    sale_types: 'direct_sale|pre_order',
    inventory_mode: ex.colors.length ? 'COLOR' : ex.options.length ? 'OPTION' : 'BASE',
    price_iqd: ex.price,
    prime_price_iqd: '',
    pro_price_iqd: '',
    stock: '10',
    low_stock_threshold: '2',
    how_to_use: 'Unbox, plug in, follow the setup guide.',
    hashtags: 'example',
    ...spec,
  });
  for (const [group, value] of ex.options) {
    out.push({ row_type: 'option', key, group, value, sku_part: value.replace(/\s+/g, ''), active: 'yes' });
  }
  for (const name of ex.colors) {
    out.push({
      row_type: 'color',
      key,
      value: name,
      hex: name.toLowerCase() === 'black' ? '#000000' : '#ffffff',
      stock: '5',
      active: 'yes',
      links: ex.options.length ? `${ex.options[0][0]}:${ex.options[0][1]}` : '',
    });
  }
  if (ex.options.length && ex.colors.length) {
    out.push({
      row_type: 'variant',
      key,
      links: `${ex.options[0][0]}:${ex.options[0][1]}|color:${ex.colors[0]}`,
      sku_part: 'COMBO',
      stock: '3',
      active: 'yes',
    });
  }
  out.push({ row_type: 'image', key, image: 'images/example-1.jpg', alt: 'front', primary: 'yes' });
  out.push({ row_type: 'transport', key, value: 'air', price_iqd: '', active: 'yes' });
  out.push({ row_type: 'transport', key, value: 'sea', price_iqd: '15000', active: 'yes' });
  const firstSpec = shape.specFields[0];
  out.push({
    row_type: 'spec',
    key,
    group: 'General',
    label: firstSpec ? firstSpec.label_en : 'Origin',
    value: firstSpec?.options?.[0] ?? 'Example',
    unit: firstSpec?.unit ?? '',
  });
  out.push({ row_type: 'label', key, kind: 'warranty_included', value: 'Warranty included', active: 'yes' });
  // Extended warranty is a PRINTER's option (owner mandate): the printer
  // example carries the two plans the store sells — +12 months (24 total)
  // and +24 months (36 total), priced as a share of the printer price — and
  // states the 12-month base and per-device serial tracking they rest on.
  // The other types carry no warranty row, because importing one for them is
  // refused (WARRANTY_NOT_PRINTER).
  if (shape.type === 'printer') {
    out[0].warranty_base_months = '12';
    out[0].serialized = 'yes';
    out.push({
      row_type: 'warranty',
      key,
      value: 'Extended warranty +12 months',
      body: 'Adds 12 months to the 12-month base warranty (24 months total) — the same manufacturing-defect coverage.',
      duration_months: '12',
      kind: 'extension',
      percent: '7.5',
      price_iqd: '0',
      active: 'yes',
    });
    out.push({
      row_type: 'warranty',
      key,
      value: 'Extended warranty +24 months',
      body: 'Adds 24 months to the 12-month base warranty (36 months total) — the same manufacturing-defect coverage.',
      duration_months: '24',
      kind: 'extension',
      percent: '10',
      price_iqd: '0',
      active: 'yes',
    });
  }
  out.push({ row_type: 'content', key, kind: 'text', body: 'Anything you want under the product page.' });
  out.push({
    row_type: 'guide',
    key,
    kind: 'setup',
    value: 'Unbox and level the bed',
    body: 'Remove the packing foam, then run the automatic levelling routine.',
    image: '',
    url: '',
    links: '',
  });
  return out;
}

// ------------------------------------------------------------------ lookups
//
// "عند إضافة قسم جديد أو براند أو هاشتاق يجعل في قالب الاستيراد خيارات
// للاختيار": the values the classification columns accept travel WITH the
// template, read from the database at download time. A CSV cannot carry a
// dropdown, so the blank template ends with a block of `#lookup:` rows the
// parser skips by marker — one row per value, with the value to type in the
// `key` column — and the ZIP adds a proper lookups.csv sheet.
//
// Facets are NOT listed any more: the product form has no filters picker, so
// a template that offered filter slugs would be offering a value nobody can
// see or correct in the browser afterwards.

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
    'الأقسام والعلامات تُقرأ من قاعدة البيانات لحظة تنزيل هذا الملف. أي قسم أو علامة أو',
    'هاشتاق تضيفه من صفحة «التصنيفات» في الإدارة يظهر هنا في التنزيل التالي.',
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
    block('hashtags — الهاشتاقات (افصل بـ | — يمكن كتابة وسم جديد وسيُضاف إلى القائمة)', lookups.hashtags.map((h) => lookupLine(h.tag, h.name_ar, ''))),
    '',
    'الملف lookups.csv داخل الـ ZIP يحمل القوائم نفسها كجدول يمكن فرزه في Excel.',
  ].join('\n');
}

/**
 * The README that ships inside the ZIP — the only documentation most admins
 * will ever read, so it names every row type, every column that row type
 * uses, and the exact values each enum accepts. Nothing here is generic: the
 * spec list, the example and the title all come from the chosen product type.
 */
export function readmeFor(shape: TemplateShape, lookups?: Lookups): string {
  const def = productType(shape.type);
  const specList = shape.specFields
    .map((f) => {
      const suffix = f.unit ? ` (${f.unit})` : '';
      const values = f.options?.length ? `  ← ${f.options.join(' / ')}` : f.type === 'number' ? '  ← رقم' : '';
      return `  ${SPEC_PREFIX}${f.id}${suffix} — ${f.label_ar} / ${f.label_en}${values}`;
    })
    .join('\n');

  // AN ASSISTANT ADMIN'S README MUST NOT NAME A COST COLUMN EITHER. The sheet
  // already drops `cost_iqd` for them (templateShape's includeCost), and a
  // README that still lists it as an accepted column both lies about the file
  // they were handed and tells them a financial field exists. The row-type
  // table is generated from the SHAPE's own columns for that reason, rather
  // than from a hand-written string that cannot know who is reading it.
  const allowed = new Set(shape.columns);
  const cols = (list: string) =>
    list
      .split(', ')
      .filter((c) => {
        const bare = c.split(' ')[0];
        return !bare.endsWith('_iqd') || allowed.has(bare) || bare === 'spec.*';
      })
      .join(', ');
  const rowType = (name: string, ar: string, list: string) =>
    `  ${name.padEnd(10)} ${ar}\n${' '.repeat(13)}الأعمدة: ${cols(list)}`;

  return `LEVONIS — قالب استيراد المنتجات
النوع: ${def.label_ar} / ${def.label_en}
${def.hint_ar}

كيف يعمل الملف
--------------
كل منتج يمتد على عدة أسطر، والعمود الأول row_type يحدد نوع السطر. تُربط الأسطر
بالمنتج عبر العمود key — وهو SKU المنتج أو الـ slug — وتُكرَّر نفس القيمة في كل
أسطر المنتج، فيمكن فرز الملف أو تصفيته في Excel بلا أن ينكسر.

أنواع الأسطر
------------
${[
    rowType('product', 'المنتج نفسه — سطر واحد لكل منتج', 'name, description, status, sku, display_order, is_featured, brand, category, sub_category, hashtags, sale_types, inventory_mode, price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd, direct_surcharge_iqd, stock, low_stock_threshold, warranty_base_months, serialized, payment_options, how_to_use, usage_url, spec.*'),
    rowType('option', 'قيمة واحدة من مجموعة خيارات — نسخة المنتج ونوع توفرها معًا', 'group, value, sku_part, image, active, stock, low_stock_threshold, price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd, availability_type, lead_time_text, lead_time_min_days, lead_time_max_days, variant_key, variant_label'),
    rowType('color', 'لون واحد وروابطه بالخيارات', 'value (اسم اللون), hex, sku_part, image, links, active, stock, low_stock_threshold, price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd'),
    rowType('variant', 'توليفة مخزون واحدة (خيارات + لون)', 'links (Group:Value|Group:Value|color:Name), sku_part, active, stock, low_stock_threshold, price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd'),
    rowType('image', 'صورة واحدة في المعرض', 'image, alt, primary, links (color:Name أو option:Group:Value)'),
    rowType('transport', 'طريقة شحن للطلب المسبق وعمولتها', `value (${TRANSPORT_METHODS.join(' / ')}), price_iqd (فارغ = العمولة الافتراضية), active`),
    rowType('spec', 'سطر مواصفة داخل مجموعة مواصفات', 'group (عنوان المجموعة), label (اسم المواصفة), value, unit'),
    rowType('label', 'شارة تظهر على بطاقة المنتج', `kind (${LABEL_KEYS.join(' / ')} أو فارغ), value (النص), image (اسم الأيقونة), active`),
    rowType('warranty', 'خطة ضمان ممدد — للطابعات فقط', `value (العنوان), body (الشروط), duration_months (12 أو 24: +12 → 24 إجمالًا، +24 → 36), kind (${WARRANTY_KINDS.join(' / ')}), percent (النسبة من سعر الطابعة، مثال 7.5), price_iqd (رسم ثابت عندما لا توجد نسبة، 0 = مجاني), active`),
    rowType('content', 'كتلة محتوى أسفل صفحة المنتج', `kind (${CONTENT_KINDS.join(' / ')}), body, value (التعليق), alt, url, image`),
    rowType('guide', 'خطوة من دليل التركيب والاستخدام', `kind (${GUIDE_KINDS.join(' / ')}), value (العنوان), body, image (حتى ٦ مفصولة بـ |), url (فيديو), links (رابط المستند)`),
  ].join('\n')}

قواعد مهمة
----------
* الإدخال بالإنجليزية فقط. الترجمة إلى العربية والكردية تتم محليًا على الخادم
  بعد الاستيراد، بلا أي ذكاء اصطناعي وبلا أي اتصال خارجي.
* الأسعار أرقام صحيحة بالدينار. الترتيب المطلوب: PRO ≤ PRIME ≤ الاعتيادي،
  ولا يجوز أن يساوي سعر البيع التكلفة. سعر الخيار أو اللون يستبدل السعر
  الأساسي ولا يُضاف إليه؛ خلية فارغة تعني «يرث السعر الأساسي».
* الحالة (status) واحدة من: ${STATUSES.join(' / ')} — و أنواع البيع من:
  ${SALE_TYPES.join(' / ')} — و مصدر المخزون من: ${INVENTORY_MODES.join(' / ')}.
  أي قيمة أخرى تُرفض عند المعاينة مع رقم السطر وقائمة القيم المقبولة.
* روابط اللون تُكتب Group:Value مفصولة بـ | — داخل المجموعة «أو»، وبين
  المجموعات «و». لون بلا روابط يظهر مع كل الخيارات.
* سطر variant يصف توليفة مخزون واحدة، ويجب أن يذكر خيارات وألوانًا موجودة
  في نفس الملف. لا تكتب توليفتين بنفس الاختيار.
* صورة رئيسية واحدة فقط لكل منتج. إن لم تحدد واحدة تُعتمد الأولى.
* عمود image إمّا اسم ملف داخل مجلد images/ في هذا الـ ZIP، أو رابط مباشر
  إلى ملف صورة. لا يُقرأ من صفحات المنتجات إطلاقًا.
* نوع السطر الذي لا يظهر في الملف إطلاقًا يُبقي ما هو محفوظ كما هو. مثلًا:
  ملف بلا أي سطر warranty لا يمس خطط الضمان المخزّنة، بينما ملف صُدِّر من
  المنتج يحمل أسطره كلها — فحذف سطر منه يعني حذفه فعلًا.
* الضمان الممدد للطابعات فقط: سطر warranty على منتج ليس في كتالوج طابعات
  يُرفض، وخطط الطابعة تمديد 12 أو 24 شهرًا فوق الضمان الأساسي (24 أو 36
  إجمالًا) بخطة واحدة لكل مدة. الرسم نسبة من سعر الطابعة (percent، مثال
  7.5 أو 10) تُقرَّب إلى دينار صحيح ولا تُعفى بالعضوية، أو رسم ثابت في
  price_iqd. عمودا warranty_base_months وserialized: الفارغ يُبقي المحفوظ،
  والطابعة تأخذ 12 وyes تلقائيًا إن لم يُحفظ شيء.
* المعاينة لا تكتب أي شيء في قاعدة البيانات. الكتابة تحدث فقط بعد التأكيد،
  وإعادة التأكيد بنفس import_id لا تكرر شيئًا.
* الأسطر التي تبدأ بـ # (مثل #labels و #lookup:) يتجاهلها المستورد.
* احذف أسطر المثال (المفتاح EXAMPLE-…) قبل الاستيراد، وإلا أُنشئ منتج بهذا الاسم.

أعمدة المواصفات الخاصة بهذا النوع
--------------------------------
${specList || '  (لا توجد حقول مواصفات لهذا النوع)'}

${lookups ? `${lookupsReadme(lookups)}\n\n` : ''}الملفات
-------
  data.csv     البيانات (UTF-8، مفصولة بفواصل)
  lookups.csv  القيم المتاحة للأقسام والعلامات والهاشتاقات
  images/      ضع هنا الصور المذكورة في أعمدة image
  README.txt   هذا الملف
`;
}
