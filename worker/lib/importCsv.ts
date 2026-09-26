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
 *   fulfillment one (model x order type) cell, or one of its routes — and the
 *              OPTIONAL pre-order capacity that cell or route holds (0075)
 *   spec       one specification row, inside a named specification group
 *   label      one badge shown on the product card
 *   warranty   one warranty plan, its duration and its fee
 *   content    one bottom-of-page content block (text / image / video)
 *   guide      one step of the setup-and-usage guide
 *
 * EVERY FIELD OF THE PRODUCT FORM HAS A HOME HERE (the owner's «ويشمل كل شي
 * كل الحقول في اضافه المنتج»). Sections 1–8 of the form map onto the product
 * row and the eleven child row types above; docs/IMPORT_TEMPLATE.md holds the
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
import type { ProductDeliveryOptions } from './shipping';
import { DIMENSION_FIELDS, EMPTY_DIMENSIONS, type ProductDimensions } from './productModel';

export type RowType =
  | 'product'
  | 'option'
  | 'color'
  | 'variant'
  | 'image'
  | 'transport'
  | 'fulfillment'
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
  // ---- §18: ONE product-scoped membership discount rule per member tier.
  // Optional in every direction. All six cells of a tier empty = this file
  // says NOTHING about that tier and the stored rule is left exactly as it
  // is; `__NULL__` in the discount_mode cell is the explicit "remove it".
  // See MEMBERSHIP_COLUMNS below — the two lists are pinned to each other.
  'membership.pro.discount_mode',
  'membership.pro.percent',
  'membership.pro.fixed_iqd',
  'membership.pro.max_discount_iqd',
  'membership.pro.cap_scope',
  'membership.pro.max_quantity',
  'membership.premium.discount_mode',
  'membership.premium.percent',
  'membership.premium.fixed_iqd',
  'membership.premium.max_discount_iqd',
  'membership.premium.cap_scope',
  'membership.premium.max_quantity',
  'stock',
  'low_stock_threshold',
  /**
   * 0075 — THE PRE-ORDER CAPACITY OF ONE `fulfillment` ROW, and nothing else.
   *
   * It is deliberately NOT a second stock column. Direct-sale availability is
   * `stock` above, on the row `inventory_mode` selects — «استخدم مصدر مخزون
   * واحد لكل اختيار فعلي» — and a `fulfillment` row for a direct sale is
   * refused if it carries this cell at all.
   *
   * Empty  = this file says nothing, keep what is stored.
   * 0      = tracked and empty: no units available right now.
   * __NULL__ / __CLEAR__ = UNTRACKED: unlimited pre-orders, reserves nothing.
   *          Neither ever touches units already held for live orders.
   */
  'capacity',
  // Product-owned last-mile delivery rules. Empty across all six columns is
  // the backward-compatible legacy/global tariff state.
  'standard_delivery_enabled',
  'standard_delivery_quantity_step',
  'standard_delivery_fee_iqd',
  'personal_delivery_enabled',
  'personal_delivery_quantity_step',
  'personal_delivery_fee_iqd',
  // ---- device coverage (products.ops_policy): the base the extended warranty
  // adds to (printers default to 12) and whether a unit is recorded per device
  'warranty_base_months',
  'serialized',
  // ---- OPEN BOX / USED / REFURBISHED (products.condition_doc).
  //
  // One block, on EVERY product type. A used filament spool and a used printer
  // are graded the same way, so the columns do not vary with the template
  // family the way the spec fields do — what varies is which specs sit beside
  // them, and that is already handled.
  //
  // `condition_kind` is the switch: empty leaves the product NEW and every
  // other column in the block is then ignored, so an older sheet with none of
  // these columns cannot un-grade a listing.
  'condition_kind',
  'condition_grade',
  'condition_usage_hours',
  'condition_warranty_months',
  // The NEW product this is a used copy of, BY SLUG — an id is not something
  // a person filling a sheet can be expected to know or to copy correctly.
  'condition_new_product_slug',
  'condition_fault_ar',
  'condition_fault_en',
  'condition_fault_ckb',
  'condition_repair_ar',
  'condition_repair_en',
  'condition_repair_ckb',
  'condition_notes_ar',
  'condition_notes_en',
  'condition_notes_ckb',
  // ---- «الأبعاد والوزن» (migration 0098). Grams and millimetres, said in the
  // column names, because a sheet is read by whoever is handed it and a unit
  // inferred from context is a volume wrong by a thousand. Two SETS: the
  // product, and the box a courier charges for.
  'net_weight_g',
  'width_mm',
  'depth_mm',
  'height_mm',
  'package_weight_g',
  'package_width_mm',
  'package_depth_mm',
  'package_height_mm',
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
  // 0104 — the product's page in the Qi Card instalments app. A shop that
  // manages its catalogue by spreadsheet has to be able to set it there too;
  // the TXT template already carries it, and a column in one importer and not
  // the other is how the two drift.
  'gini_url',
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

/** The product types the panel offers, with the column count each one
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
/** 0075 — the two order types a `fulfillment` row may name. */
export const FULFILLMENT_TYPES = ['direct_sale', 'pre_order'] as const;
export const WARRANTY_KINDS = ['total', 'extension'] as const;
export const CONTENT_KINDS = ['text', 'image', 'video_embed'] as const;
export const GUIDE_KINDS = ['setup', 'usage'] as const;
export const LABEL_KEYS = ['featured', 'warranty_included', 'free_returns', 'free_plus'] as const;

/* --------------------------------- §18: the product-scoped membership rule */

/**
 * ONE PRODUCT-SCOPED MEMBERSHIP DISCOUNT PER TIER, CARRIED BY THE SHEET.
 *
 * `membership_benefit_rules` (migration 0074) is the one place a membership
 * discount lives, and docs/MEMBERSHIP_BENEFITS.md §1 says a rule scoped to a
 * PRODUCT beats a section rule and a global one. §18 asks for that override
 * to be settable from the product editor AND to travel with the template, so
 * an owner can price a hundred printers for PRO members in a spreadsheet
 * instead of a hundred admin screens.
 *
 * SIX CELLS PER TIER, all optional, all on the `product` row — they describe
 * exactly one `product_discount` rule whose `scope` is `product` and whose
 * `product_id` is this product. They are NOT a new pricing engine: the values
 * are the same columns the admin door writes, validated by the same rules
 * (worker/routes/adminMembershipBenefits.ts `ruleFromBody`), and written
 * through the same `saveBenefitRule`, so every change from a spreadsheet is
 * versioned and audited like every change from the panel.
 *
 * THE THREE STATES OF A TIER'S BLOCK, and why silence is not a decision:
 *
 *   all six cells empty   the file says NOTHING about this tier — the stored
 *                         rule is untouched. An OLD export, or a sheet from a
 *                         shape that has no membership columns at all, is
 *                         exactly this case: re-importing it can never wipe a
 *                         discount somebody set in the admin panel afterwards.
 *   values filled         create or update this tier's product rule.
 *   discount_mode=__NULL__  remove it. Deleting a price is a decision, so the
 *                         file has to SAY it; a blank cell never will.
 *
 * The rule's OTHER fields — its date window, priority, on/off switch, label,
 * note and minimum subtotal — are not in the sheet and are PRESERVED from the
 * stored rule on an update (see worker/routes/adminImport.ts). A template that
 * carried six of a rule's fields and silently cleared the rest would be a
 * worse way to lose a scheduled promotion than having no template at all.
 */
export const MEMBERSHIP_PREFIX = 'membership.';

/** The sheet's word for each tier, and the tier the database stores. */
export const MEMBERSHIP_TIERS = [
  { key: 'pro', tier: 'pro', label_ar: 'PRO' },
  { key: 'premium', tier: 'prime', label_ar: 'PREMIUM' },
] as const;

export const MEMBERSHIP_FIELDS = [
  'discount_mode',
  'percent',
  'fixed_iqd',
  'max_discount_iqd',
  'cap_scope',
  'max_quantity',
] as const;

export const MEMBERSHIP_MODES = ['percent', 'fixed'] as const;
export const MEMBERSHIP_CAP_SCOPES = ['per_unit', 'per_order'] as const;

/**
 * THE RANGES THE ADMIN DOOR ENFORCES, so the sheet enforces exactly them.
 *
 * `worker/routes/adminMembershipBenefits.ts` `ruleFromBody` bounds every one of
 * these: `optInt` caps a dinar field at 1,000,000,000, `max_quantity` is
 * `int(..., { min: 1, max: 9999 })`, and a percentage is 1..100. A cell reader
 * that only refused letters would let a spreadsheet store a rule the panel
 * refuses — and `intCell` accepts any run of digits, so a twenty-digit amount
 * was landing in the INTEGER column as a SQLite REAL (1e20) and floored every
 * member's price to zero.
 *
 * These are not a second opinion about what is reasonable; they are a copy of
 * the door's own limits, PINNED to it by a test that drives both at the
 * boundary (`tests/membershipTemplateRoundTrip.test.ts`).
 */
export const MEMBERSHIP_MAX_IQD = 1_000_000_000;
export const MEMBERSHIP_MAX_QUANTITY = 9999;
export const MEMBERSHIP_MIN_PERCENT = 1;
export const MEMBERSHIP_MAX_PERCENT = 100;

/**
 * The explicit "there is no value here". Borrowed verbatim from the TXT
 * template's `NULL_TOKEN` (worker/lib/template.ts) rather than invented, so an
 * admin who has used one template already knows what it means in the other.
 */
export const MEMBERSHIP_NULL = '__NULL__';

/**
 * 0075 — the two words a `capacity` cell may carry instead of a number.
 *
 * Borrowed verbatim from the TXT template (`worker/lib/template.ts`) so one
 * admin's habit transfers between the two files. Both mean UNTRACKED here:
 * `__NULL__` states it, `__CLEAR__` resets a number that was set. Neither is
 * zero, and neither releases a unit already held — a clear resets the
 * CONFIGURED number, not the holds customers already have.
 */
export const CAPACITY_NULL = '__NULL__';
export const CAPACITY_CLEAR = '__CLEAR__';

/** `membership.<tier key>.<field>` for every tier and field, in column order. */
export const MEMBERSHIP_COLUMNS: string[] = MEMBERSHIP_TIERS.flatMap((t) =>
  MEMBERSHIP_FIELDS.map((f) => `${MEMBERSHIP_PREFIX}${t.key}.${f}`)
);

/** The six values one tier's block states, in the database's own words. */
export interface MembershipRuleValues {
  /** The stored tier: `pro` = PRO, `prime` = PREMIUM. */
  tier: 'pro' | 'prime';
  discount_mode: 'percent' | 'fixed' | null;
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: 'per_unit' | 'per_order' | null;
  max_quantity: number | null;
}

export interface ParsedMembershipRule extends MembershipRuleValues {
  line: number;
  /** The file wrote `__NULL__`: delete this tier's product rule. */
  remove: boolean;
}

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
    capacity: 'سعة الطلب المسبق',
    standard_delivery_enabled: 'التوصيل العادي مفعّل (yes/no)',
    standard_delivery_quantity_step: 'عدد القطع لكل رسم توصيل عادي',
    standard_delivery_fee_iqd: 'رسم شريحة التوصيل العادي (د.ع)',
    personal_delivery_enabled: 'التوصيل الشخصي مفعّل (yes/no)',
    personal_delivery_quantity_step: 'عدد القطع لكل رسم توصيل شخصي',
    personal_delivery_fee_iqd: 'رسم شريحة التوصيل الشخصي (د.ع)',
    warranty_base_months: 'مدة الضمان الأساسي بالأشهر (الطابعات 12؛ فارغ = كما هو محفوظ)',
    condition_kind: 'حالة المنتج: open_box أو used أو refurbished — اتركه فارغاً للمنتج الجديد',
    condition_grade: 'درجة الحالة: like_new أو excellent أو good أو fair',
    condition_usage_hours: 'عدد ساعات التشغيل الفعلية (رقم صحيح؛ فارغ = غير معروف)',
    condition_warranty_months: 'ضمان ليفو بالأشهر: 1 أو 12 فقط (فارغ = 12)',
    condition_new_product_slug: 'سلَك المنتج الجديد الذي هذه نسخة مستعملة منه — لعرض سعر الجديد مشطوباً',
    condition_fault_ar: 'العطل الذي كان في الجهاز (عربي)',
    condition_fault_en: 'The fault this unit had (English)',
    condition_fault_ckb: 'کێشەکەی ئەم ئامێرە (کوردی)',
    condition_repair_ar: 'الإصلاح الذي جرى (عربي)',
    condition_repair_en: 'The repair that was carried out (English)',
    condition_repair_ckb: 'ئەو چاککردنەوەیەی کرا (کوردی)',
    condition_notes_ar: 'ملاحظات أخرى للمشتري (عربي)',
    condition_notes_en: 'Other notes for the buyer (English)',
    condition_notes_ckb: 'تێبینی تر بۆ کڕیار (کوردی)',
    net_weight_g: 'وزن المنتج نفسه بالغرام (رقم صحيح؛ فارغ = غير مقاس)',
    width_mm: 'عرض المنتج بالمليمتر',
    depth_mm: 'عمق المنتج بالمليمتر',
    height_mm: 'ارتفاع المنتج بالمليمتر',
    package_weight_g: 'وزن الصندوق مع المنتج بالغرام — ما يحسب عليه الناقل',
    package_width_mm: 'عرض صندوق الشحن بالمليمتر',
    package_depth_mm: 'عمق صندوق الشحن بالمليمتر',
    package_height_mm: 'ارتفاع صندوق الشحن بالمليمتر',
    serialized: 'جهاز مُرقَّم — وحدة لكل جهاز عند التسليم (yes/no؛ فارغ = كما هو محفوظ)',
    payment_options: 'طرق الدفع المسموحة (id|id)',
    how_to_use: 'طريقة الاستخدام (نص)',
    usage_url: 'رابط الدليل الرسمي',
    gini_url: 'رابط المنتج في تطبيق جني',
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
  // §18 — generated per tier rather than typed out twelve times, so a tier
  // can never gain a column that the label row leaves blank (which is what
  // shifts every Arabic heading one cell to the left in a spreadsheet).
  for (const t of MEMBERSHIP_TIERS) {
    const at = (f: string) => `${MEMBERSHIP_PREFIX}${t.key}.${f}`;
    labels[at('discount_mode')] =
      `خصم عضوية ${t.label_ar} لهذا المنتج (${MEMBERSHIP_MODES.join('/')}؛ فارغ = بلا تغيير، ${MEMBERSHIP_NULL} = احذف القاعدة)`;
    labels[at('percent')] = `نسبة خصم ${t.label_ar} (٪ — عدد صحيح بين 1 و100)`;
    labels[at('fixed_iqd')] = `خصم ${t.label_ar} مبلغًا ثابتًا (د.ع)`;
    labels[at('max_discount_iqd')] = `سقف خصم ${t.label_ar} (د.ع)`;
    labels[at('cap_scope')] = `نطاق سقف ${t.label_ar} (${MEMBERSHIP_CAP_SCOPES.join('/')} — لكل قطعة أو لكل طلب)`;
    labels[at('max_quantity')] = `أقصى عدد قطع يشمله خصم ${t.label_ar} (عدد صحيح 1 فأكثر)`;
  }
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

/** The condition block as a sheet states it; slug is resolved to an id later. */
export interface ParsedCondition {
  kind: string;
  grade: string;
  usage_hours: number | null;
  warranty_months: number;
  new_product_slug: string;
  fault_ar: string; fault_en: string; fault_ckb: string;
  repair_ar: string; repair_en: string; repair_ckb: string;
  notes_ar: string; notes_en: string; notes_ckb: string;
}

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
  /** null means the six columns were absent/empty and legacy rules survive. */
  delivery_options: ProductDeliveryOptions | null;
  /**
   * Device coverage (products.ops_policy). Both are null when the column is
   * absent OR the cell is empty — "keep what is stored" — because a blank
   * here is far more often an older sheet than a decision to un-configure a
   * printer; clearing is done in the form. A printer gets 12 / yes by default
   * on import when nothing is stored (worker/lib/warrantyPlans.ts).
   */
  warranty_base_months: number | null;
  serialized: boolean | null;
  /**
   * «الأبعاد والوزن». A per-key null means the column was absent or the cell
   * empty — "nobody has measured this". Never a zero, and never a reason to
   * blank a measurement an older sheet simply does not carry.
   */
  dimensions: ProductDimensions;
  /**
   * Open box / used / refurbished, as this SHEET states it.
   *
   * `undefined` means the sheet carried no condition columns at all, which is
   * every sheet written before this feature — importApply then keeps whatever
   * is stored. An explicit empty `condition_kind` means NEW and DOES clear a
   * stored grade, so a listing can be un-graded from a sheet on purpose.
   */
  condition: ParsedCondition | null | undefined;
  /** null when the column is absent, so an older sheet keeps stored values. */
  payment_options: string[] | null;
  how_to_use: string | null;
  usage_url: string | null;
  gini_url: string | null;
  /** null when the sheet has no hashtags column at all, so an older file
   *  leaves a product's stored tags alone instead of clearing them. */
  hashtags: string[] | null;
  /**
   * §18 — the product-scoped membership discount rules this row STATES, one
   * entry per tier it spoke about. An empty array means the file said nothing
   * (old sheet, or blank cells) and every stored rule survives untouched;
   * `remove: true` is the file asking for one to be deleted.
   */
  membership_rules: ParsedMembershipRule[];
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
  /**
   * 0075 — the (model x order type) cells and routes this sheet STATES.
   *
   * null = the file carries no `fulfillment` row for this product, so every
   * stored cell survives untouched; that is every sheet written before 0075
   * and every sheet an admin narrows down to prices. An array is the file
   * speaking, and then the cells it lists are merged onto the stored ones —
   * never a blind replacement, because this row type carries capacity and
   * enablement only and knows nothing about the eight price columns a cell
   * already holds.
   */
  fulfillments: ParsedFulfillment[] | null;
  specs: ParsedSpec[] | null;
  labels: ParsedLabel[] | null;
  warranty_plans: ParsedWarranty[] | null;
  content_blocks: ParsedContent[] | null;
  guide_steps: ParsedGuideStep[] | null;
}

/**
 * 0075 — ONE `fulfillment` ROW.
 *
 * A row names the MODEL in `links` the way every other child row names its
 * relations (`Group:Value`, exactly one pair), the ORDER TYPE in `value`, and
 * — optionally — one ROUTE in `kind`. With no `kind` the row is the order-type
 * cell itself and its `capacity` is the model's SHARED pre-order pool; with a
 * `kind` the row is that route and its `capacity` is the route's OWN quota.
 *
 * A row per line rather than an encoded string in one cell, because that is
 * this format's whole premise: "row 14: a direct sale has no capacity" points
 * at a line the admin can see in Excel.
 */
export interface ParsedFulfillment {
  line: number;
  /** The option GROUP naming the model, from `links`. */
  group: string;
  /** The option VALUE naming the model, from `links`. */
  value: string;
  fulfillment_type: 'direct_sale' | 'pre_order';
  /** '' = the order-type cell itself; otherwise the route this row is. */
  method: '' | 'air' | 'sea' | 'land';
  /**
   * undefined = the `capacity` cell was blank: this row says nothing about
   * the number and whatever is stored stays. null = UNTRACKED (`__NULL__` or
   * `__CLEAR__`). A number is tracked, and 0 is a real tracked zero.
   */
  capacity?: number | null;
  /**
   * undefined = the `active` cell was blank, so this row says nothing about
   * the flag either and the stored one stands.
   *
   * It is the SAME rule as `capacity` above, and it has to be: a hand-written
   * row that sets only a quota («links, value, capacity») leaves `active`
   * empty, and `boolCell`'s fallback for every other row type is `true`. Once
   * the sheet door actually writes cells, that fallback would switch a
   * pre-order the owner had deliberately turned OFF back on, invisibly, from a
   * cell the admin never filled in. A cell the file CREATES is enabled, which
   * is `parseFulfillmentPayload`'s own default for an absent flag.
   */
  enabled?: boolean;
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

/**
 * 0075 — A CAPACITY CELL, in units.
 *
 * Four answers, and they are four different things:
 *   ''                    -> undefined: the file says nothing; keep what is stored.
 *   '__NULL__'/'__CLEAR__'-> null: UNTRACKED — unlimited, reserves nothing.
 *   '0'                   -> 0: tracked, and none available right now.
 *   'N'                   -> N.
 *
 * `0` and `__NULL__` must never collapse into each other: one refuses a
 * pre-order and the other allows an unlimited number of them, so the test is
 * on emptiness and never on falsiness.
 */
function capacityCell(v: string, line: number, col: string, issues: RowIssue[]): number | null | undefined {
  const t = v.trim();
  if (t === '') return undefined;
  if (t === CAPACITY_NULL || t === CAPACITY_CLEAR) return null;
  if (!/^\d+$/.test(t)) {
    issues.push({
      line,
      severity: 'error',
      message: `${col}: "${t}" ليس عددًا صحيحًا من الوحدات — اكتب رقمًا ≥ 0، أو ${CAPACITY_NULL} لغير المتتبَّعة (بلا حد) / not a whole number of units — write an integer >= 0, or ${CAPACITY_NULL} for untracked (unlimited)`,
    });
    return undefined;
  }
  const n = Number(t);
  if (n > 1_000_000) {
    issues.push({
      line,
      severity: 'error',
      message: `${col}: "${t}" أكبر مما يستطيع المتجر تخطيطه / larger than this shop can plan for`,
    });
    return undefined;
  }
  return n;
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

/** The same name-matching `importApply.normKey` uses, so a `fulfillment` row
 *  and an `option` row agree on what "the same model" means. */
const normCell = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');

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
  // A LIST drawn from the options (`use_cases`): every item must be one of
  // them, and the cell is stored in the canonical spelling and order.
  if (f.multiple && f.options && f.options.length) {
    const picked: string[] = [];
    for (const piece of v.split(/[,،;]/)) {
      const item = piece.trim();
      if (item === '') continue;
      const hit = f.options.find((o) => o.toLowerCase() === item.toLowerCase());
      if (!hit) {
        issues.push({
          line,
          severity: 'error',
          message: `${col}: "${item}" غير مقبول — القيم المتاحة: ${f.options.join(' / ')}`,
        });
        return '';
      }
      if (!picked.includes(hit)) picked.push(hit);
    }
    return f.options.filter((o) => picked.includes(o)).join(', ');
  }
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
 * §18 — the membership block of one `product` row, per tier.
 *
 * EVERY REFUSAL HERE IS THE ADMIN DOOR'S OWN REFUSAL, in the same words
 * (`worker/routes/adminMembershipBenefits.ts` `ruleFromBody`): a ceiling with
 * no per-unit/per-order choice, a percentage rule with no percentage, a fixed
 * rule with no amount. The sheet cannot be a back door into a rule the panel
 * would not accept — and because this runs inside `parseImport`, which is what
 * `POST /api/admin/import/preview` calls, the owner reads the refusal BEFORE
 * confirming rather than in a report afterwards.
 *
 * `has` distinguishes a column that is ABSENT from one that is EMPTY. Both
 * mean "change nothing", but only the first can happen to a file exported
 * before these columns existed, and the two are worth telling apart when
 * reading this back.
 */
function membershipRulesFrom(
  get: (name: string) => string,
  has: (name: string) => boolean,
  line: number,
  issues: RowIssue[]
): ParsedMembershipRule[] {
  const out: ParsedMembershipRule[] = [];
  for (const t of MEMBERSHIP_TIERS) {
    const col = (f: string) => `${MEMBERSHIP_PREFIX}${t.key}.${f}`;
    if (!MEMBERSHIP_FIELDS.some((f) => has(col(f)))) continue; // older sheet
    const raw = Object.fromEntries(MEMBERSHIP_FIELDS.map((f) => [f, get(col(f))])) as MembershipCells;
    const rule = membershipRuleFromCells(t, raw, line, issues);
    if (rule) out.push(rule);
  }
  return out;
}

/** The six raw cells of one tier, before anything is believed about them. */
export type MembershipCells = Record<(typeof MEMBERSHIP_FIELDS)[number], string>;

/**
 * ONE TIER'S BLOCK, JUDGED — the single validator BOTH templates use.
 *
 * The CSV sheet reads it out of six columns and the TXT template out of six
 * `membership.<tier>.<field>` keys, and they call this same function, because
 * two copies of "a ceiling needs a per-unit/per-order choice" is exactly how
 * one file format ends up accepting a rule the other refuses.
 *
 * Returns `null` when the block says nothing at all — the file is silent about
 * this tier and the stored rule must survive untouched — and pushes an issue
 * and returns `null` when it says something impossible.
 */
export function membershipRuleFromCells(
  t: (typeof MEMBERSHIP_TIERS)[number],
  raw: MembershipCells,
  line: number,
  issues: RowIssue[]
): ParsedMembershipRule | null {
  const col = (f: string) => `${MEMBERSHIP_PREFIX}${t.key}.${f}`;
  const err = (c: string, ar: string, en: string) =>
    issues.push({ line, severity: 'error', message: `${c}: ${ar} — ${en}` });
  const mode = raw.discount_mode;
  // Silence is never a decision: an untouched block leaves the stored rule
  // alone. Only `__NULL__` in the mode cell asks for a deletion.
  if (mode !== MEMBERSHIP_NULL && MEMBERSHIP_FIELDS.every((f) => raw[f] === '' || raw[f] === MEMBERSHIP_NULL)) {
    return null;
  }

  if (mode === MEMBERSHIP_NULL) {
    const stated = MEMBERSHIP_FIELDS.filter((f) => f !== 'discount_mode' && raw[f] !== '' && raw[f] !== MEMBERSHIP_NULL);
    if (stated.length) {
      err(
        col('discount_mode'),
        `${MEMBERSHIP_NULL} يحذف قاعدة ${t.label_ar} لهذا المنتج، فلا تملأ معه ${stated.join(' / ')} — أفرغ تلك الخلايا أو اكتب نوع الخصم`,
        `${MEMBERSHIP_NULL} removes the rule; clear the other cells or state a discount mode`
      );
      return null;
    }
    return {
      line,
      tier: t.tier,
      remove: true,
      discount_mode: null,
      percent: null,
      fixed_iqd: null,
      max_discount_iqd: null,
      cap_scope: null,
      max_quantity: null,
    };
  }

  const blank = (v: string) => v === '' || v === MEMBERSHIP_NULL;
  let discountMode: 'percent' | 'fixed' | null = null;
  if (!blank(mode)) {
    const hit = MEMBERSHIP_MODES.find((m) => m === mode.toLowerCase());
    if (!hit) {
      issues.push({
        line,
        severity: 'error',
        message: `${col('discount_mode')}: "${mode}" غير مقبول — القيم المتاحة: ${MEMBERSHIP_MODES.join(' / ')} / ${MEMBERSHIP_NULL}`,
      });
      return null;
    }
    discountMode = hit;
  }

  const percent = blank(raw.percent) ? null : intCell(raw.percent, line, col('percent'), issues);
  if (percent !== null && (percent < MEMBERSHIP_MIN_PERCENT || percent > MEMBERSHIP_MAX_PERCENT)) {
    err(
      col('percent'),
      `النسبة يجب أن تكون بين ${MEMBERSHIP_MIN_PERCENT} و${MEMBERSHIP_MAX_PERCENT}`,
      `percent must be between ${MEMBERSHIP_MIN_PERCENT} and ${MEMBERSHIP_MAX_PERCENT}`
    );
    return null;
  }
  /** A dinar cell, refused at the ADMIN DOOR'S ceiling rather than at the
   *  largest number `Number()` will produce from a run of digits. */
  const dinars = (field: 'fixed_iqd' | 'max_discount_iqd'): number | null | undefined => {
    if (blank(raw[field])) return null;
    const n = intCell(raw[field], line, col(field), issues);
    if (n === null) return null;
    if (n > MEMBERSHIP_MAX_IQD) {
      err(
        col(field),
        `المبلغ يجب أن يكون بين 0 و${MEMBERSHIP_MAX_IQD.toLocaleString('en-US')} دينار`,
        `${field} must be a whole number of dinars between 0 and ${MEMBERSHIP_MAX_IQD.toLocaleString('en-US')}`
      );
      return undefined;
    }
    return n;
  };
  const fixedIqd = dinars('fixed_iqd');
  const maxDiscount = dinars('max_discount_iqd');
  if (fixedIqd === undefined || maxDiscount === undefined) return null;
  const maxQuantity = blank(raw.max_quantity) ? null : intCell(raw.max_quantity, line, col('max_quantity'), issues);
  if (maxQuantity !== null && (maxQuantity < 1 || maxQuantity > MEMBERSHIP_MAX_QUANTITY)) {
    err(
      col('max_quantity'),
      `العدد يجب أن يكون بين 1 و${MEMBERSHIP_MAX_QUANTITY}`,
      `max_quantity must be between 1 and ${MEMBERSHIP_MAX_QUANTITY}`
    );
    return null;
  }

  let capScope: 'per_unit' | 'per_order' | null = null;
  if (!blank(raw.cap_scope)) {
    const hit = MEMBERSHIP_CAP_SCOPES.find((s) => s === raw.cap_scope.toLowerCase());
    if (!hit) {
      issues.push({
        line,
        severity: 'error',
        message: `${col('cap_scope')}: "${raw.cap_scope}" غير مقبول — القيم المتاحة: ${MEMBERSHIP_CAP_SCOPES.join(' / ')} / ${MEMBERSHIP_NULL}`,
      });
      return null;
    }
    capScope = hit;
  }

  if (discountMode === null) {
    err(
      col('discount_mode'),
      'قاعدة الخصم تحتاج نسبة أو مبلغًا ثابتًا',
      'A discount rule needs a percentage or a fixed amount'
    );
    return null;
  }
  if (discountMode === 'percent' && percent === null) {
    err(col('percent'), 'اكتب النسبة', 'Enter the percentage');
    return null;
  }
  if (discountMode === 'fixed' && (fixedIqd === null || fixedIqd <= 0)) {
    err(col('fixed_iqd'), 'اكتب المبلغ بالدينار', 'Enter the amount in dinars');
    return null;
  }
  // "up to 100,000" means nothing until it says per what — and a per-unit
  // choice with no ceiling is the same half-sentence read backwards.
  if (maxDiscount !== null && capScope === null) {
    err(
      col('cap_scope'),
      'حدِّد ما إذا كان السقف لكل قطعة أم لكل طلب',
      'Say whether the ceiling is per unit or per order'
    );
    return null;
  }
  if (capScope !== null && maxDiscount === null) {
    err(
      col('max_discount_iqd'),
      'اكتب السقف، أو امسح اختيار per_unit/per_order',
      'Enter the ceiling, or clear the per-unit/per-order choice'
    );
    return null;
  }

  return {
    line,
    tier: t.tier,
    remove: false,
    discount_mode: discountMode,
    // The unused half is dropped exactly as the admin door drops it, so a
    // sheet that fills both cells cannot store a fixed amount on a rule the
    // resolver will read as a percentage.
    percent: discountMode === 'percent' ? percent : null,
    fixed_iqd: discountMode === 'fixed' ? fixedIqd : null,
    max_discount_iqd: maxDiscount,
    cap_scope: capScope,
    max_quantity: maxQuantity,
  };
}

/** The twelve membership cells of one product row, for `serializeProducts`. */
function membershipCells(rules: readonly MembershipRuleValues[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of MEMBERSHIP_TIERS) {
    // A tier with no product-scoped rule exports SIX EMPTY CELLS, never
    // `__NULL__`: an export must not carry a deletion nobody asked for. An
    // owner who exports today, writes a PRO discount in the panel tomorrow and
    // re-imports the old file still has that discount afterwards.
    const rule = rules?.find((r) => r.tier === t.tier);
    if (!rule) continue;
    const at = (f: string) => `${MEMBERSHIP_PREFIX}${t.key}.${f}`;
    out[at('discount_mode')] = rule.discount_mode ?? '';
    out[at('percent')] = num(rule.percent);
    out[at('fixed_iqd')] = num(rule.fixed_iqd);
    out[at('max_discount_iqd')] = num(rule.max_discount_iqd);
    out[at('cap_scope')] = rule.cap_scope ?? '';
    out[at('max_quantity')] = num(rule.max_quantity);
  }
  return out;
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

    /**
     * 0075 — `capacity` IS A `fulfillment` ROW'S CELL AND NOBODY ELSE'S.
     *
     * It was added to BASE_COLUMNS, which makes it a legal cell on EVERY row,
     * and it is read in exactly one branch. So a quota typed on the `option`
     * row — the row where `stock` lives, which is precisely where an admin
     * reaching for "how many may I pre-order" will type it — was dropped
     * without a word: not an issue, not even an unknown column, and the
     * preview showed a clean import of a limit that was never stored.
     *
     * The TXT side refuses the analogous mistake BY NAME
     * (`options.N.direct.capacity`, `GroupSpec.cellFields.direct.refused`) on
     * the stated reasoning that "an admin who typed it believes they limited
     * something". The sheet owes the same protection, so this is that refusal
     * in the sheet's own terms, naming the row type that carries the number.
     *
     * An error rather than a warning: `adminImport` marks any row with an
     * error `failed` and keeps it out of the confirmed payload, which is the
     * point — an import that silently ignores a limit is how a shop
     * over-sells. The row is NOT dropped here, so the rest of its cells are
     * still parsed and reported; the product simply does not apply until the
     * number is moved to the row that owns it.
     */
    if (type !== 'fulfillment' && cell(r, 'capacity') !== '') {
      issues.push({
        line,
        severity: 'error',
        message:
          `capacity: لا مكان لها على سطر ${type} — سعة الطلب المسبق تُكتب على سطر fulfillment (value=pre_order)، ` +
          `ومخزون البيع المباشر يُكتب في عمود stock على سطر option / ` +
          `capacity does not belong on a ${type} row: a pre-order capacity goes on a fulfillment row (value=pre_order), ` +
          `and direct-sale stock goes in the stock column of an option row`,
      });
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
        dimensions: (() => {
          const d = EMPTY_DIMENSIONS();
          for (const k of DIMENSION_FIELDS) d[k] = intCell(cell(r, k), line, k, issues);
          return d;
        })(),
        delivery_options: (() => {
          const names = [
            'standard_delivery_enabled',
            'standard_delivery_quantity_step',
            'standard_delivery_fee_iqd',
            'personal_delivery_enabled',
            'personal_delivery_quantity_step',
            'personal_delivery_fee_iqd',
          ] as const;
          const raw = Object.fromEntries(names.map((name) => [name, cell(r, name)])) as Record<typeof names[number], string>;
          if (names.every((name) => raw[name] === '')) return null;
          for (const name of names) {
            if (raw[name] === '') issues.push({ line, severity: 'error', message: `${name}: مطلوب عند إعداد توصيل خاص بالمنتج` });
          }
          const standardStep = intCell(raw.standard_delivery_quantity_step, line, 'standard_delivery_quantity_step', issues);
          const standardFee = intCell(raw.standard_delivery_fee_iqd, line, 'standard_delivery_fee_iqd', issues);
          const personalStep = intCell(raw.personal_delivery_quantity_step, line, 'personal_delivery_quantity_step', issues);
          const personalFee = intCell(raw.personal_delivery_fee_iqd, line, 'personal_delivery_fee_iqd', issues);
          if (standardStep !== null && standardStep < 1) issues.push({ line, severity: 'error', message: 'standard_delivery_quantity_step: يجب أن يكون 1 أو أكبر' });
          if (personalStep !== null && personalStep < 1) issues.push({ line, severity: 'error', message: 'personal_delivery_quantity_step: يجب أن يكون 1 أو أكبر' });
          return {
            standard: {
              enabled: boolCell(raw.standard_delivery_enabled, line, 'standard_delivery_enabled', issues, false),
              quantity_step: standardStep ?? 1,
              fee_iqd: standardFee ?? 0,
            },
            personal: {
              enabled: boolCell(raw.personal_delivery_enabled, line, 'personal_delivery_enabled', issues, false),
              quantity_step: personalStep ?? 1,
              fee_iqd: personalFee ?? 0,
            },
          };
        })(),
        condition: (() => {
          // Absent columns = "this sheet has nothing to say about condition".
          if (!index.has('condition_kind')) return undefined;
          const kind = cell(r, 'condition_kind').trim().toLowerCase();
          // An explicitly EMPTY kind is a decision: this listing is new.
          if (!kind) return null;
          const months = intCell(cell(r, 'condition_warranty_months'), line, 'condition_warranty_months', issues);
          return {
            kind,
            grade: cell(r, 'condition_grade').trim().toLowerCase(),
            usage_hours: intCell(cell(r, 'condition_usage_hours'), line, 'condition_usage_hours', issues),
            warranty_months: months === 1 ? 1 : 12,
            new_product_slug: cell(r, 'condition_new_product_slug').trim(),
            fault_ar: cell(r, 'condition_fault_ar'),
            fault_en: cell(r, 'condition_fault_en'),
            fault_ckb: cell(r, 'condition_fault_ckb'),
            repair_ar: cell(r, 'condition_repair_ar'),
            repair_en: cell(r, 'condition_repair_en'),
            repair_ckb: cell(r, 'condition_repair_ckb'),
            notes_ar: cell(r, 'condition_notes_ar'),
            notes_en: cell(r, 'condition_notes_en'),
            notes_ckb: cell(r, 'condition_notes_ckb'),
          };
        })(),
        warranty_base_months: intCell(cell(r, 'warranty_base_months'), line, 'warranty_base_months', issues),
        serialized:
          cell(r, 'serialized') === '' ? null : boolCell(cell(r, 'serialized'), line, 'serialized', issues, false),
        payment_options: index.has('payment_options') ? splitList(cell(r, 'payment_options')) : null,
        how_to_use: index.has('how_to_use') ? cell(r, 'how_to_use') : null,
        usage_url: index.has('usage_url') ? cell(r, 'usage_url') : null,
        gini_url: index.has('gini_url') ? cell(r, 'gini_url') : null,
        hashtags: index.has('hashtags') ? splitList(cell(r, 'hashtags')) : null,
        membership_rules: membershipRulesFrom((name) => cell(r, name), (name) => index.has(name), line, issues),
        spec_fields: spec,
        options: [],
        colors: [],
        variants: [],
        images: [],
        transports: null,
        fulfillments: null,
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

    /**
     * 0075 — ONE (MODEL x ORDER TYPE) CELL, OR ONE OF ITS ROUTES.
     *
     * The row carries the OPTIONAL pre-order capacity and the enabled flag,
     * and nothing else: the eight price columns of a cell are not repeated
     * here, so a sheet that sets a quota cannot silently rewrite a price it
     * never mentioned. `importApply` merges these onto the stored cells.
     */
    if (type === 'fulfillment') {
      const { pairs } = parseLinks();
      if (pairs.length !== 1) {
        issues.push({
          line,
          severity: 'error',
          message:
            'سطر fulfillment يحتاج links يسمّي موديلًا واحدًا بصيغة Group:Value / a fulfillment row needs links naming exactly one model as Group:Value',
        });
        continue;
      }
      const ftype = enumCell(cell(r, 'value'), FULFILLMENT_TYPES, line, 'value', issues, null);
      if (!ftype) continue;
      const kindRaw = cell(r, 'kind').trim();
      const method = kindRaw ? enumCell(kindRaw, TRANSPORT_METHODS, line, 'kind', issues, null) : '';
      if (method === null) continue;
      // A DIRECT SALE HAS NO JOURNEY — the same rule the fulfilment API
      // enforces, refused here by name at preview time.
      if (ftype === 'direct_sale' && method) {
        issues.push({
          line,
          severity: 'error',
          message:
            'البيع المباشر بلا طريق — air/sea/land تخص الطلب المسبق وحده / a direct sale has no transport: air/sea/land belongs to a pre-order',
        });
        continue;
      }
      const capacityValue = capacityCell(cell(r, 'capacity'), line, 'capacity', issues);
      /**
       * A DIRECT SALE HAS NO CAPACITY OF ITS OWN (0075 / DECISION 1).
       *
       * Its number is the MODEL's stock — the `stock` cell of the `option`
       * row — and a second one here would give the shop two places to be
       * wrong about one physical shelf. Refused rather than dropped, because
       * an admin who typed it believes they limited something.
       */
      if (ftype === 'direct_sale' && capacityValue !== undefined) {
        issues.push({
          line,
          severity: 'error',
          message:
            'capacity: البيع المباشر لا سعة له — رقمه هو مخزون الموديل، فاكتبه في عمود stock على سطر option / a direct sale has no capacity: its number is the model stock, set it in the option row stock column',
        });
        continue;
      }
      // Blank `active` = say nothing, exactly as a blank `capacity` does.
      // See `ParsedFulfillment.enabled`.
      const statedEnabled = cell(r, 'active').trim() === '' ? undefined : active;
      parent.fulfillments ??= [];
      parent.fulfillments.push({
        line,
        group: pairs[0].group,
        value: pairs[0].value,
        fulfillment_type: ftype,
        method: method as '' | 'air' | 'sea' | 'land',
        ...(capacityValue === undefined ? {} : { capacity: capacityValue }),
        ...(statedEnabled === undefined ? {} : { enabled: statedEnabled }),
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
      message: `row_type غير معروف: "${type}" — الأنواع المتاحة: product / option / color / variant / image / transport / fulfillment / spec / label / warranty / content / guide`,
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

    /**
     * 0075 — THE `fulfillment` ROWS ARE CHECKED AGAINST THE MODELS IN THE FILE.
     *
     * A row naming a model no `option` row declares would create a quota on
     * something unreachable, and `resolveProduct` would have no id to hang it
     * on; refused here, at preview, with the name it wrote. A model this file
     * does not mention but the PRODUCT already has is a different case and is
     * allowed — `resolveProduct` matches it against the stored rows.
     */
    const declaredModels = new Set(p.options.map((o) => `${normCell(o.group)}\u0000${normCell(o.value)}`));
    const seenCells = new Set<string>();
    for (const fl of p.fulfillments ?? []) {
      const modelKey = `${normCell(fl.group)}\u0000${normCell(fl.value)}`;
      if (p.options.length > 0 && !declaredModels.has(modelKey)) {
        issues.push({
          line: fl.line,
          severity: 'error',
          message: `fulfillment: لا يوجد سطر option باسم "${fl.group}:${fl.value}" في هذا الملف / no option row in this file is named "${fl.group}:${fl.value}"`,
        });
        continue;
      }
      const cellId = `${modelKey}\u0000${fl.fulfillment_type}\u0000${fl.method}`;
      if (seenCells.has(cellId)) {
        issues.push({
          line: fl.line,
          severity: 'error',
          message: `fulfillment: "${fl.group}:${fl.value}" ${fl.fulfillment_type}${fl.method ? ` ${fl.method}` : ''} مكرر / listed twice`,
        });
      }
      seenCells.add(cellId);
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
  /** Omitted/null for products that intentionally retain legacy global delivery. */
  delivery_options?: ProductDeliveryOptions | null;
  /** Device coverage; null exports an empty cell ("keep what is stored"). */
  warranty_base_months: number | null;
  serialized: boolean | null;
  /** «الأبعاد والوزن», so an export round-trips every measurement. */
  dimensions: ProductDimensions;
  /** Open box / used / refurbished; null for a new product. */
  condition?: {
    kind: string; grade: string; usage_hours: number | null; warranty_months: number;
    new_product_slug?: string;
    fault_ar: string; fault_en: string; fault_ckb: string;
    repair_ar: string; repair_en: string; repair_ckb: string;
    notes_ar: string; notes_en: string; notes_ckb: string;
  } | null;
  payment_options: string[];
  how_to_use: string;
  usage_url: string;
  gini_url: string;
  hashtags: string[];
  /**
   * §18 — the product-scoped membership discount rules this product has, at
   * most one per tier. OPTIONAL, and a tier with no rule simply has no entry:
   * `serializeProducts` then writes six empty cells for it, which the importer
   * reads as "this file says nothing" (see `membershipCells`).
   */
  membership_rules?: MembershipRuleValues[];
  spec_fields: Record<string, string>;
  options: Array<Omit<ParsedOption, 'line'>>;
  colors: Array<Omit<ParsedColor, 'line'>>;
  variants: Array<Omit<ParsedVariant, 'line'>>;
  images: Array<Omit<ParsedImage, 'line'>>;
  transports: Array<Omit<ParsedTransport, 'line'>>;
  /**
   * 0075 — the product's (model x order type) cells and their routes.
   *
   * OPTIONAL so a caller that does not read them exports exactly the file it
   * did before, and an absent list means the sheet carries no `fulfillment`
   * row — which the importer reads as "this file says nothing", preserving
   * every stored cell.
   */
  fulfillments?: Array<Omit<ParsedFulfillment, 'line'>>;
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
      // `?? EMPTY_DIMENSIONS()` and not `p.dimensions.x`: an export must not
      // THROW on a record assembled before this field existed. A missing block
      // is eight empty cells, which is the truth about an unmeasured product;
      // a TypeError here would take the whole catalogue export down.
      ...Object.fromEntries(
        DIMENSION_FIELDS.map((k) => [k, num((p.dimensions ?? EMPTY_DIMENSIONS())[k])])
      ),
      standard_delivery_enabled: p.delivery_options ? bool(p.delivery_options.standard.enabled) : '',
      standard_delivery_quantity_step: p.delivery_options ? num(p.delivery_options.standard.quantity_step) : '',
      standard_delivery_fee_iqd: p.delivery_options ? num(p.delivery_options.standard.fee_iqd) : '',
      personal_delivery_enabled: p.delivery_options ? bool(p.delivery_options.personal.enabled) : '',
      personal_delivery_quantity_step: p.delivery_options ? num(p.delivery_options.personal.quantity_step) : '',
      personal_delivery_fee_iqd: p.delivery_options ? num(p.delivery_options.personal.fee_iqd) : '',
      warranty_base_months: num(p.warranty_base_months),
      serialized: p.serialized === null ? '' : bool(p.serialized),
      // An empty `condition_kind` on export means NEW, which is exactly what
      // re-importing the file should preserve.
      condition_kind: p.condition?.kind ?? '',
      condition_grade: p.condition?.grade ?? '',
      condition_usage_hours: p.condition ? num(p.condition.usage_hours) : '',
      condition_warranty_months: p.condition ? String(p.condition.warranty_months) : '',
      condition_new_product_slug: p.condition?.new_product_slug ?? '',
      condition_fault_ar: p.condition?.fault_ar ?? '',
      condition_fault_en: p.condition?.fault_en ?? '',
      condition_fault_ckb: p.condition?.fault_ckb ?? '',
      condition_repair_ar: p.condition?.repair_ar ?? '',
      condition_repair_en: p.condition?.repair_en ?? '',
      condition_repair_ckb: p.condition?.repair_ckb ?? '',
      condition_notes_ar: p.condition?.notes_ar ?? '',
      condition_notes_en: p.condition?.notes_en ?? '',
      condition_notes_ckb: p.condition?.notes_ckb ?? '',
      payment_options: p.payment_options.join('|'),
      how_to_use: p.how_to_use,
      usage_url: p.usage_url,
      gini_url: p.gini_url,
      hashtags: p.hashtags.join('|'),
      ...membershipCells(p.membership_rules),
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
    /**
     * 0075. An UNTRACKED capacity exports as `__NULL__`, never as an empty
     * cell and never as `0`.
     *
     * Empty would mean "say nothing", so the row would stop being editable in
     * the file the store itself produced; `0` would turn every unlimited
     * pre-order in the catalogue into a sold-out one on the next re-import.
     * The word survives the round trip because it is the same word the file
     * uses to mean it.
     */
    for (const fl of p.fulfillments ?? []) {
      put({
        row_type: 'fulfillment',
        key: p.key,
        links: `${fl.group}:${fl.value}`,
        value: fl.fulfillment_type,
        kind: fl.method,
        capacity:
          fl.fulfillment_type === 'direct_sale'
            ? '' // a direct sale has no capacity: its number is the option row's `stock`
            : fl.capacity === undefined || fl.capacity === null
              ? CAPACITY_NULL
              : String(fl.capacity),
        // An export always states the flag: `undefined` here is only ever the
        // hand-written "say nothing", and this file is the store's own answer.
        active: bool(fl.enabled !== false),
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
    // The laser line. Both examples are shaped like the thing a laser admin
    // actually types: a machine sold by model, and a consumable sold by the
    // sheet — which is the option group a plywood buyer picks from, exactly as
    // the filament example is sold by spool weight.
    laser: {
      name: 'Example Laser Engraver',
      description: 'A worked example row — delete it before importing.',
      price: '950000',
      options: [
        ['Model', 'Standard'],
        ['Model', 'With rotary'],
      ],
      colors: [],
    },
    laser_material: {
      name: 'Example Laser Plywood Sheet',
      description: 'A worked example row — delete it before importing.',
      price: '4000',
      options: [
        ['Thickness', '3 mm'],
        ['Thickness', '5 mm'],
      ],
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
    standard_delivery_enabled: 'yes',
    standard_delivery_quantity_step: '10',
    standard_delivery_fee_iqd: '5000',
    personal_delivery_enabled: 'yes',
    personal_delivery_quantity_step: '1',
    personal_delivery_fee_iqd: '50000',
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
  /**
   * 0075 — THE PRE-ORDER CAPACITY, TAUGHT AS A SHAPE AND NOT AS A QUANTITY.
   *
   * Every capacity here is `__NULL__` — UNTRACKED, which is exactly what the
   * shop did before 0075 and what every existing product carries. The example
   * must not ship a number nobody typed: a 50 in this file would be copied
   * into a real catalogue by the first admin who edits the example in place.
   *
   * The two shapes are both shown, one row each:
   *   • the cell row (no `kind`)   — the model's SHARED pool, which every
   *     route with an empty capacity draws on;
   *   • a route row (`kind=air`)   — that route's OWN quota, which does NOT
   *     also spend the pool.
   * Leaving a route row out entirely is how a route stays on the pool.
   */
  if (ex.options.length) {
    const model = `${ex.options[0][0]}:${ex.options[0][1]}`;
    out.push({
      row_type: 'fulfillment',
      key,
      links: model,
      value: 'pre_order',
      capacity: CAPACITY_NULL,
      active: 'yes',
    });
    out.push({
      row_type: 'fulfillment',
      key,
      links: model,
      value: 'pre_order',
      kind: 'air',
      capacity: CAPACITY_NULL,
      active: 'yes',
    });
  }
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

/**
 * §18 — the README block for the membership columns, WITH THEIR UNITS.
 *
 * Generated from the same constants the columns and the parser use, so a
 * seventh field or a third tier cannot appear in the sheet and be missing
 * from the only page most admins read.
 */
export function membershipReadme(): string {
  const tiers = MEMBERSHIP_TIERS.map((t) => `${MEMBERSHIP_PREFIX}${t.key}.*  (${t.label_ar})`).join('  ·  ');
  return `خصم العضوية الخاص بهذا المنتج (أعمدة membership.*)
------------------------------------------------
سطر product يحمل ستة أعمدة لكل فئة عضوية — ${tiers} — تصف قاعدة خصم واحدة
مربوطة بهذا المنتج وحده. قاعدة المنتج تتقدّم على قاعدة القسم وعلى القاعدة
العامة (docs/MEMBERSHIP_BENEFITS.md §1)، ولا تُجمع قاعدتان أبدًا.

  ${MEMBERSHIP_PREFIX}<الفئة>.discount_mode      ${MEMBERSHIP_MODES.join(' / ')} — نوع الخصم
  ${MEMBERSHIP_PREFIX}<الفئة>.percent            نسبة مئوية (٪): عدد صحيح بين ${MEMBERSHIP_MIN_PERCENT} و${MEMBERSHIP_MAX_PERCENT}
  ${MEMBERSHIP_PREFIX}<الفئة>.fixed_iqd          مبلغ ثابت بالدينار العراقي (د.ع): 0..${MEMBERSHIP_MAX_IQD.toLocaleString('en-US')}
  ${MEMBERSHIP_PREFIX}<الفئة>.max_discount_iqd   سقف الخصم بالدينار العراقي (د.ع): 0..${MEMBERSHIP_MAX_IQD.toLocaleString('en-US')}
  ${MEMBERSHIP_PREFIX}<الفئة>.cap_scope          ${MEMBERSHIP_CAP_SCOPES.join(' / ')} — السقف لكل قطعة أم لكل طلب
  ${MEMBERSHIP_PREFIX}<الفئة>.max_quantity       أقصى عدد قطع يشمله الخصم (عدد صحيح، 1..${MEMBERSHIP_MAX_QUANTITY})

الحالات الثلاث لكل فئة:
  * الأعمدة الستة كلها فارغة  =  الملف لا يقول شيئًا عن هذه الفئة، والقاعدة
    المحفوظة تبقى كما هي. الملف القديم الذي لا يحمل هذه الأعمدة أصلًا هو نفس
    الحالة — فإعادة استيراده لا تمسّ خصمًا كتبته في لوحة الإدارة بعده.
  * قيم مكتوبة                =  تُنشأ قاعدة المنتج لهذه الفئة أو تُحدَّث.
  * discount_mode=${MEMBERSHIP_NULL}      =  تُحذف قواعد المنتج لهذه الفئة كلها. الحذف
    قرار، فلا بد أن يقوله الملف صراحةً؛ الخلية الفارغة لا تحذف شيئًا أبدًا.

قواعد القبول هي نفسها قواعد لوحة الإدارة تمامًا، بحدودها نفسها: سقف بلا
cap_scope مرفوض، و cap_scope بلا سقف مرفوض، و percent يحتاج نسبة، و fixed
يحتاج مبلغًا أكبر من صفر، والقيم خارج المدى أعلاه مرفوضة. أي رفض يظهر في
المعاينة برقم السطر واسم العمود قبل التأكيد، لا بعده.

الملف يحمل قاعدة واحدة لكل فئة. لو كان للمنتج أكثر من قاعدة لفئة واحدة (وهو
ما يمكن إنشاؤه من اللوحة) فالملف يصف الأولى بحسب الأولوية ويحدّثها، ولا يمسّ
غيرها — أمّا ${MEMBERSHIP_NULL} فيحذفها جميعًا، لأن "لا خصم لهذه الفئة" لا يصحّ
أن يترك خصمًا يعمل.

بقية حقول القاعدة — تاريخ البداية والنهاية، الأولوية، التفعيل/الإيقاف،
الاسم والملاحظة والحد الأدنى للسلة — ليست في الملف وتبقى كما ضُبطت في لوحة
الإدارة. كل تعديل من هذا الملف يُسجَّل بنسخة (membership_benefit_versions)
وبسطر تدقيق، تمامًا كتعديل من اللوحة.`;
}

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
 * 0075 — THE README BLOCK FOR PRE-ORDER CAPACITY.
 *
 * Two things an admin cannot guess from a column name, so both are spelled
 * out with a worked example: that a direct sale's number is the model's stock
 * and never a capacity, and how leaving a route's capacity empty puts it on
 * the SHARED pool while giving it a number makes the quota INDEPENDENT.
 *
 * No quantity in the worked example is a number the owner typed — the shapes
 * are shown with `<العدد>` placeholders and `__NULL__`.
 */
export function capacityReadme(): string {
  return `سعة الطلب المسبق (سطر fulfillment وعمود capacity)
------------------------------------------------
سطر fulfillment يصف خلية واحدة: موديل واحد (links = Group:Value) ونوع طلب
واحد (value = direct_sale أو pre_order). واترك kind فارغًا ليصف الخلية نفسها،
أو اكتب ${TRANSPORT_METHODS.join(' / ')} ليصف طريقة بعينها من طرق الطلب المسبق.

البيع المباشر لا سعة له. رقمه هو مخزون الموديل نفسه — عمود stock على سطر
option — لأن لكل اختيار فعلي مصدر مخزون واحد فقط. سطر fulfillment ببيع مباشر
وفيه capacity يُرفض عند المعاينة قبل أن يُكتب أي شيء.
A direct sale has NO capacity: its number is the model stock (the option row's
stock column). One stock source per actual selection.

ما تعنيه خانة capacity
  فارغة        هذا الملف لا يقول شيئًا عن الرقم — يبقى المحفوظ كما هو.
  0            متتبَّعة ولا توجد وحدات الآن: الطلب المسبق يُرفض.
  ${CAPACITY_NULL}     غير متتبَّعة: الطلب المسبق بلا حد ولا يحجز شيئًا (وهو حال كل
               منتج قبل هذه الإضافة).
  ${CAPACITY_CLEAR}    مثل ${CAPACITY_NULL}: يُعيد الرقم المضبوط إلى «غير متتبَّعة».
               ولا يُطلق أي وحدة محجوزة لطلب قائم — الحجز ليس إعدادًا.
  empty = say nothing · 0 = tracked and empty · ${CAPACITY_NULL} / ${CAPACITY_CLEAR} = UNTRACKED
  (unlimited, reserves nothing). A clear resets the configured number, never a hold.

سعة مشتركة أم حصص مستقلة؟  SHARED pool vs INDEPENDENT quotas
  • مشتركة: اكتب سطر الخلية وحده، واترك سطور الطرق بلا capacity (أو لا تكتبها
    إطلاقًا). عندها تسحب ${TRANSPORT_METHODS.join(' و')} كلها من حوض واحد، وبيع وحدة
    جوًا ينقص وحدة من نصيب البحر والبر.
  • مستقلة: أعطِ الطريقة رقمها الخاص. تلك الطريقة تملك حصتها وحدها ولا تسحب
    من الحوض المشترك — عدّاد واحد لكل عملية بيع، لا عدّادان.
  • لا تكرر نفس الكمية تلقائيًا على الطرق الثلاث: لا شيء في هذا الملف ينسخ
    رقمًا عنك، وكل طريقة تُكتب وحدها.

مثال (استبدل <العدد> برقمك)
  # حوض مشترك: الجو والبحر والبر يقتسمون <العدد>
  fulfillment,KEY,,,,,,Model:A1 mini,pre_order,,<العدد>,yes
  # نفس الحوض، مع إظهار أن الجو يسحب منه (capacity فارغة على سطر الطريقة)
  fulfillment,KEY,,,,,,Model:A1 mini,pre_order,air,,yes
  # حصة مستقلة للجو: لا تمس الحوض المشترك
  fulfillment,KEY,,,,,,Model:A1 mini,pre_order,air,<حصة الجو>,yes
  (ترتيب الأعمدة الحقيقي هو ترتيب الترويسة في data.csv — املأ الخانات
   links و value و kind و capacity و active أيًّا كان موضعها.)
`;
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
    rowType('product', 'المنتج نفسه — سطر واحد لكل منتج', 'name, description, status, sku, display_order, is_featured, brand, category, sub_category, hashtags, sale_types, inventory_mode, price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd, direct_surcharge_iqd, stock, low_stock_threshold, standard_delivery_enabled, standard_delivery_quantity_step, standard_delivery_fee_iqd, personal_delivery_enabled, personal_delivery_quantity_step, personal_delivery_fee_iqd, warranty_base_months, serialized, payment_options, how_to_use, usage_url, gini_url, membership.*, spec.*'),
    rowType('option', 'قيمة واحدة من مجموعة خيارات — نسخة المنتج ونوع توفرها معًا', 'group, value, sku_part, image, active, stock, low_stock_threshold, price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd, availability_type, lead_time_text, lead_time_min_days, lead_time_max_days, variant_key, variant_label'),
    rowType('color', 'لون واحد وروابطه بالخيارات', 'value (اسم اللون), hex, sku_part, image, links, active, stock, low_stock_threshold, price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd'),
    rowType('variant', 'توليفة مخزون واحدة (خيارات + لون)', 'links (Group:Value|Group:Value|color:Name), sku_part, active, stock, low_stock_threshold, price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd'),
    rowType('image', 'صورة واحدة في المعرض', 'image, alt, primary, links (color:Name أو option:Group:Value)'),
    rowType('transport', 'طريقة شحن للطلب المسبق وعمولتها', `value (${TRANSPORT_METHODS.join(' / ')}), price_iqd (فارغ = العمولة الافتراضية), active`),
    rowType(
      'fulfillment',
      'خلية (موديل × نوع الطلب) أو أحد طرقها — والسعة الاختيارية للطلب المسبق',
      `links (Group:Value — موديل واحد), value (${FULFILLMENT_TYPES.join(' / ')}), kind (فارغ = الخلية نفسها، أو ${TRANSPORT_METHODS.join(' / ')} لطريقة بعينها), capacity, active`
    ),
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

${capacityReadme()}

${membershipReadme()}

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
