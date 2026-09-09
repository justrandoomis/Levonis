/**
 * Deterministic TXT product template pipeline (mandate §6) — NO AI anywhere.
 *
 * Format (template_version=2): human-readable UTF-8 `key=value` lines,
 * `#` comments, indexed repeatable groups (`options.1.name_ar=...`,
 * `spec_groups.1.rows.2.value_ar=...`), multiline values via heredoc
 * (`key=<<<END` ... `END` on its own line). Special tokens:
 *   __NULL__  — explicit null (inherit / no value)
 *   __CLEAR__ — explicit clearing of a previously stored value on update
 * Empty string stays empty. Omitted keys PRESERVE existing values on update.
 *
 * Everything here is pure (no DB, no network): parsing, export, blank
 * generation and template→doc-body merging. Brand/catalog slug resolution
 * needs the DB and lives in worker/routes/template.ts; unresolved references
 * surface as needs_review entries — never silent creation or silent drop.
 */

import { newId } from './crypto';
import { localizableSlots } from './translationSlots';
import { isMixed } from './availability';
import { normalizeCheapestBase } from './cheapestBase';
import { buildGrid, COLUMN_OF, FIELDS, type Field } from './priceGrid';
import type {
  ProductDoc,
  TranslationMeta,
} from './productModel';

/**
 * The parser demands an EXACT match, so bumping this rejects every file
 * already in the owner's hands. Version 2 has therefore grown keys rather than
 * becoming version 3 — and because an unrecognised key is a warning, not an
 * error, an older parser accepts a newer file and drops the new content
 * quietly. That trade is deliberate: a file the owner downloaded last week
 * must keep working, and the alternative is a hard failure on every one of
 * them. Any future change that cannot be ignored safely by an old parser is
 * the one that has to bump this and accept the break.
 */
export const TEMPLATE_VERSION = 2;
export const NULL_TOKEN = '__NULL__';
export const CLEAR_TOKEN = '__CLEAR__';

// ---------------------------------------------------------------- registry

export type TemplateFieldType =
  | 'string' // single-line text
  | 'text'   // may be multiline (heredoc)
  | 'iqd'    // non-negative integer, Iraqi dinars
  | 'int'    // integer
  | 'percent' // 0.01..100 with at most two decimals (e.g. 7.5) — a fee expressed as a share of the price
  | 'bool'   // true/false
  | 'enum'   // one of enumValues
  | 'csv'    // comma-separated list of TOKENS (slugs, ids, hashtags)
  | 'urls'   // a list of ADDRESSES — see the coercion, commas are not enough
  | 'hex'    // #RRGGBB or empty
  | 'ref';   // reference resolved via DB (brand / catalog slug or id)

export interface FieldSpec {
  key: string;
  type: TemplateFieldType;
  required: boolean;
  lang?: 'ar' | 'en' | 'ckb';
  nullable: boolean;
  group: string; // one of the 13 editor groups
  notes: string;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  /** import-only convenience keys are parsed but never exported */
  exported?: boolean;
  /** A required subfield that may be omitted when THIS sibling is given —
   *  an option or colour authored in the (English-only) form has a name_en
   *  and no name_ar, and such a file must import. */
  requiredUnless?: string;
  /**
   * Price fields on options and colours: a value written WITH A SIGN (`+60000`,
   * `-5000`) is not a price but the increase (or discount) over the level
   * beneath — the owner's model, «زيادة فوق السعر». It lands in this
   * adjustment key and the price itself is cleared (applyItemField).
   */
  adjustKey?: string;
  /** Import-only synonym: the value is written to THIS key of the item. */
  aliasOf?: string;
  /**
   * A surcharge field: the guides call it «زيادة», so `+51000` is the natural
   * way to write it. The plus sign is accepted and means nothing more than
   * the number (there is no adjustment twin to route to).
   */
  plusIsPlain?: boolean;
}

export interface GroupSpec {
  /** template key prefix, e.g. `options` → options.1.name_ar */
  name: string;
  /** doc body key this group writes to */
  bodyKey: string;
  /** id prefix for newly created items ('' = items carry no id) */
  idPrefix: string;
  /** subfield that identifies an item for merge-by-id ('id', or 'method' for transports) */
  mergeKey: string;
  group: string;
  titleAr: string;
  titleEn: string;
  fields: FieldSpec[];
  /** nested rows (spec_groups only): spec_groups.N.rows.M.<field> */
  rowFields?: FieldSpec[];
}

export interface ProtectedFieldSpec {
  key: string;
  notes: string;
}

function f(
  key: string,
  type: TemplateFieldType,
  group: string,
  notes: string,
  opts: Partial<Omit<FieldSpec, 'key' | 'type' | 'group' | 'notes'>> = {}
): FieldSpec {
  return { key, type, required: false, nullable: false, group, notes, ...opts };
}

const IQD_MAX = 2_000_000_000;

/** The 14 canonical editor groups (Arabic-first labels used in exports). */
export const TEMPLATE_GROUPS: Array<{ id: string; titleAr: string; titleEn: string }> = [
  { id: 'identity',        titleAr: 'الهوية',                titleEn: 'Identity' },
  { id: 'description',     titleAr: 'الوصف',                 titleEn: 'Description' },
  { id: 'pricing',         titleAr: 'التسعير',               titleEn: 'Pricing' },
  { id: 'classification',  titleAr: 'التصنيف',               titleEn: 'Classification' },
  { id: 'selling',         titleAr: 'البيع والمخزون',        titleEn: 'Selling & stock' },
  { id: 'transports',      titleAr: 'شحن الطلب المسبق',      titleEn: 'Pre-order transports' },
  { id: 'media',           titleAr: 'الوسائط',               titleEn: 'Media' },
  { id: 'options',         titleAr: 'الخيارات',              titleEn: 'Options' },
  { id: 'colors',          titleAr: 'الألوان',               titleEn: 'Colors' },
  { id: 'specs',           titleAr: 'المواصفات',             titleEn: 'Specifications' },
  { id: 'labels',          titleAr: 'الشارات',               titleEn: 'Labels' },
  { id: 'warranty',        titleAr: 'خطط الضمان',            titleEn: 'Warranty plans' },
  { id: 'content',         titleAr: 'كتل المحتوى',           titleEn: 'Content blocks' },
  // The last form section the file could not say: the setup & usage guide
  // (official link + ordered steps with photos, a video and a doc link).
  { id: 'usage',           titleAr: 'دليل التركيب والاستخدام', titleEn: 'Setup & usage guide' },
];

const SCALAR_FIELDS: FieldSpec[] = [
  // identity
  f('name_ar', 'string', 'identity', 'اسم المنتج (المصدر العربي) — Arabic source name; required unless name_en is given', { required: true, lang: 'ar' }),
  f('name_en', 'string', 'identity', 'English name', { lang: 'en' }),
  f('name_ckb', 'string', 'identity', 'ناوی کوردی (سۆرانی) — Kurdish (Sorani) name; stored in the *_ku DB column', { lang: 'ckb' }),
  f('status', 'enum', 'identity', "draft | active | hidden — creation via template is ALWAYS forced to 'draft'", { enumValues: ['draft', 'active', 'hidden'] as const }),
  // description
  f('description_ar', 'text', 'description', 'الوصف العربي (المصدر) — multiline allowed via heredoc', { lang: 'ar' }),
  f('description_en', 'text', 'description', 'English description', { lang: 'en' }),
  f('description_ckb', 'text', 'description', 'وەسفی کوردی — Kurdish description', { lang: 'ckb' }),
  f('how_to_use', 'text', 'description', 'طريقة الاستخدام — usage instructions (multiline allowed)'),
  // pricing — IQD integers; null = inherit/none, 0 = explicit zero
  f('price_iqd', 'iqd', 'pricing', 'السعر الأساسي بالدينار = أرخص صنف قابل للبيع؛ كل خيار أو لون أو طريقة توفر زيادة فوقه — base price = the CHEAPEST sellable item, REQUIRED integer', { required: true, min: 0, max: IQD_MAX }),
  f('pro_price_iqd', 'iqd', 'pricing', 'سعر PRO الصريح — explicit PRO price; __NULL__ = no explicit price (store policy applies, default: no discount)', { nullable: true, min: 0, max: IQD_MAX }),
  f('prime_price_iqd', 'iqd', 'pricing', 'سعر PRIME الصريح — explicit PRIME price; __NULL__ = none (regular applies)', { nullable: true, min: 0, max: IQD_MAX }),
  f('original_price_iqd', 'iqd', 'pricing', 'السعر قبل الخصم — compare-at price; shown only when above the selling price; __NULL__ = none', { nullable: true, min: 0, max: IQD_MAX }),
  f('product_cost_iqd', 'iqd', 'pricing', 'الكلفة (داخلي) — internal cost, NEVER exposed publicly; __NULL__ = unknown', { nullable: true, min: 0, max: IQD_MAX }),
  // classification
  f('brand', 'ref', 'classification', 'العلامة التجارية — brand slug or id, resolved against the brands table; unknown values need review; __NULL__ = no brand', { nullable: true }),
  f('catalogs', 'csv', 'classification', 'الكتالوجات — comma-separated catalog slugs or ids; unknown values need review; empty = in no catalog', { nullable: true }),
  // ---- EIGHT FIELDS THE FILE COULD NOT SAY --------------------------------
  // Every one of these is edited in the admin form and stored on `products`,
  // and none had a template key: worker/lib/template.ts carried them across an
  // update untouched and defaulted them to null on a create. So a product made
  // from a .txt had no section — and the owner asking the file to «يملأ جميع
  // الحقول» was asking for something structurally impossible.
  f('category', 'ref', 'classification', 'القسم الرئيسي — main section slug or id from the sections tree; __NULL__ = بلا قسم. مطلوب للنشر.', { nullable: true }),
  f('sub_category', 'ref', 'classification', 'القسم الفرعي — sub-section slug or id; __NULL__ = بلا قسم فرعي', { nullable: true }),
  f('template_family', 'enum', 'classification', 'عائلة قالب المواصفات: devices | materials | فارغ — تحدد أي حقول spec.* تخصّ هذا المنتج', { enumValues: ['', 'devices', 'materials'] as const }),
  f('sku', 'string', 'classification', 'رمز المنتج — SKU; فارغ = بلا رمز'),
  f('hashtags', 'csv', 'classification', 'وسوم — comma-separated hashtags'),
  f('is_featured', 'bool', 'classification', 'منتج مميز — featured flag (true/false)'),
  f('display_order', 'int', 'classification', 'ترتيب العرض — display order (integer, lower = earlier)', { min: -100_000, max: 100_000 }),
  // selling
  f('selling_type', 'enum', 'selling', 'direct_sale | pre_order | bundle | mixed — «mixed» كلمة إدخال تتوسّع إلى بيع مباشر + طلب مسبق معًا؛ لا تُخزَّن كما هي. والأدق أن تترك الخيارات تقرر: أنواع البيع تُشتق من availability_type لكل خيار.', { enumValues: ['direct_sale', 'pre_order', 'bundle', 'mixed'] as const }),
  f('stock', 'int', 'selling', 'المخزون — stock count; __NULL__ = not tracked', { nullable: true, min: 0, max: 1_000_000 }),
  f('low_stock_threshold', 'int', 'selling', 'حد التنبيه لمخزون المنتج — __NULL__ = بلا تنبيه', { nullable: true, min: 0, max: 1_000_000 }),
  // WHICH LEVEL COUNTS THE STOCK. The form derives it from where the numbers
  // are (colour stock → COLOR, option stock → OPTION, else BASE) on every
  // save; the file may state it explicitly, and an empty value asks for the
  // same derivation — never for a silent BASE (docs/TXT_IMPORT_PARITY.md,
  // root cause 3). Not a document field: it is written by the relations
  // writer, in the same batch.
  f('inventory_mode', 'enum', 'selling', 'مستوى المخزون المعتمد: فارغ = يُشتق من مكان الأرقام (stock على اللون → COLOR، على الخيار → OPTION، وإلا BASE) كما يفعل النموذج | BASE | OPTION | COLOR | VARIANT_COMBINATION', { enumValues: ['', 'BASE', 'OPTION', 'COLOR', 'VARIANT_COMBINATION'] as const }),
  // Real money on a direct line, added on top of the price. Exporting a file
  // that showed a price the customer never pays was the quiet half of the
  // owner's complaint about the numbers in the export.
  f('direct_surcharge_iqd', 'iqd', 'selling', 'زيادة البيع المباشر — تُضاف فوق سعر الخيار/اللون المختار عند الشراء الفوري من المخزون، وعند الدفع عند الاستلام لطلب مسبق (يُعفى منها عضو PRO الفعّال كعمولة النقل)؛ __NULL__ أو 0 = بلا زيادة', { nullable: true, min: 0, max: IQD_MAX, plusIsPlain: true }),
  f('payment_options', 'csv', 'selling', 'معرفات طرق الدفع المسموحة — allowed checkout payment method ids, comma-separated'),
  // device coverage (stored in products.ops_policy) — the base the extended
  // warranty adds to, and whether a unit is recorded per physical device
  f('warranty_base_months', 'int', 'warranty', 'مدة الضمان الأساسي بالأشهر من التسليم — للطابعات 12 افتراضيًا (التمديد +12 → 24 إجمالًا، +24 → 36)؛ __NULL__ = غير مُعدّة', { nullable: true, min: 1, max: 240 }),
  f('serialized', 'bool', 'warranty', 'جهاز مُرقَّم — تُنشأ وحدة لكل جهاز عند التسليم ويُربط بها الضمان (الطابعات true تلقائيًا)'),
  // usage guide — the steps are the `usage_steps` group below
  f('usage_official_url', 'string', 'usage', 'رابط الدليل الرسمي للمنتج (صفحة الشركة المصنّعة) — official documentation URL; فارغ = لا يوجد'),
];

const GROUP_SPECS: GroupSpec[] = [
  {
    name: 'transports', bodyKey: 'preorder_transports', idPrefix: '', mergeKey: 'method', group: 'transports',
    titleAr: 'شحن الطلب المسبق', titleEn: 'Pre-order transports',
    fields: [
      f('method', 'enum', 'transports', 'air | sea | land — طريقة الطلب المسبق؛ زيادتها تُضاف فوق سعر الخيار/اللون المختار وتُعفى لأعضاء PRO الفعالين', { required: true, enumValues: ['air', 'sea', 'land'] as const }),
      f('commission_iqd', 'iqd', 'transports', 'الزيادة بالدينار فوق السعر عند الطلب المسبق بهذه الطريقة (البري مثلًا) — __NULL__ = القيمة الافتراضية من الإعدادات', { nullable: true, min: 0, max: IQD_MAX, plusIsPlain: true }),
      // The form calls this number «الزيادة بالدينار». The file accepts that
      // word too, so the owner can write what the screen says.
      f('surcharge_iqd', 'iqd', 'transports', 'مرادف لـ commission_iqd بكلمة الواجهة: الزيادة بالدينار لهذه الطريقة — import-only, never exported; يتقدّم على commission_iqd إذا وُجد الاثنان', { nullable: true, min: 0, max: IQD_MAX, exported: false, aliasOf: 'commission_iqd', plusIsPlain: true }),
      f('active', 'bool', 'transports', 'معروض للزبائن — offered to customers'),
    ],
  },
  {
    name: 'images', bodyKey: 'media', idPrefix: 'img', mergeKey: 'id', group: 'media',
    titleAr: 'الوسائط', titleEn: 'Media (gallery images)',
    fields: [
      f('id', 'string', 'media', 'معرف ثابت للدمج — stable id used for merge-by-id on update'),
      f('url', 'string', 'media', 'رابط الصورة (/files/<key> أو رابط خارجي) — REQUIRED', { required: true }),
      f('key', 'string', 'media', 'مفتاح R2 الداخلي إن وجد — internal R2 key when stored internally'),
      f('alt_ar', 'string', 'media', 'النص البديل بالعربية', { lang: 'ar' }),
      f('alt_en', 'string', 'media', 'Alt text (English)', { lang: 'en' }),
      f('alt_ckb', 'string', 'media', 'دەقی جێگرەوە بە کوردی', { lang: 'ckb' }),
      f('primary', 'bool', 'media', 'الصورة الرئيسية — exactly one image should be primary'),
      f('source_url', 'string', 'media', 'الرابط المصدر الأصلي عند الاستيراد — original remote source'),
      // ---- WHAT THE PICTURE IS OF -------------------------------------
      // product_images has carried these three columns since 0018 and the
      // form writes them, but the template had no key for any of them: the
      // store's own export turned every option and colour photo into a plain
      // gallery image, and re-importing it unbound them for good. At most one
      // may be set on a row.
      f('option_value_id', 'string', 'media', 'صورة تخص هذا الخيار — bind to ONE option by its options.N.id; فارغ = صورة عامة'),
      f('color_id', 'string', 'media', 'صورة تخص هذا اللون — bind to ONE colour by its colors.N.id; فارغ = صورة عامة'),
      f('variant_id', 'string', 'media', 'صورة تخص تركيبة محددة — bind to one modelled combination by its id'),
      f('width', 'int', 'media', 'عرض الصورة بالبكسل إن كان معروفًا — pixel width; فارغ = غير معروف', { nullable: true, min: 1, max: 100_000 }),
      f('height', 'int', 'media', 'ارتفاع الصورة بالبكسل إن كان معروفًا — pixel height', { nullable: true, min: 1, max: 100_000 }),
    ],
  },
  {
    name: 'options', bodyKey: 'options', idPrefix: 'opt', mergeKey: 'id', group: 'options',
    titleAr: 'الخيارات', titleEn: 'Options (variants)',
    fields: [
      f('id', 'string', 'options', 'معرف ثابت — stable id; needed for merge-by-id and for colors.*.option_id links'),
      // The relational model is GROUPS → values. Every flat consumer sees only
      // the values, so a product with «1 مجموعة · 4 قيمة» used to export as
      // four ungrouped options and re-import as four separate groups. Rows
      // sharing a group name belong to one group, in first-appearance order.
      f('group', 'string', 'options', 'اسم مجموعة الخيارات التي ينتمي إليها هذا الصف (مثل Model أو التوفر) — الصفوف التي تحمل نفس الاسم تُجمع في مجموعة واحدة. فارغ = المجموعة الافتراضية.'),
      f('name_ar', 'string', 'options', 'اسم الخيار بالعربية — مطلوب ما لم يُعطَ name_en (0055: يُخزَّن في صف الخيار ويعرضه المتجر)', { required: true, requiredUnless: 'name_en', lang: 'ar' }),
      f('name_en', 'string', 'options', 'Option name (English)', { lang: 'en' }),
      f('name_ckb', 'string', 'options', 'ناوی هەڵبژاردە بە کوردی', { lang: 'ckb' }),
      f('image', 'string', 'options', 'صورة الخيار — option image URL'),
      f('active', 'bool', 'options', 'فعال — active'),
      // THE OWNER'S MODEL: the base price is the cheapest item and an option
      // is an INCREASE over it. `+60000` here is that increase (it lands in
      // regular_adjust_iqd); a bare number is still accepted as a fixed price
      // and is re-expressed as an increase when the file is applied.
      f('regular_price_iqd', 'iqd', 'options', 'الزيادة فوق السعر الأساسي بصيغة +N (مثال +60000)، أو __NULL__ = نفس السعر الأساسي. رقم بلا إشارة = سعر ثابت، ويُعاد التعبير عنه كزيادة عند الاستيراد دون تغيير ما يدفعه الزبون.', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'regular_adjust_iqd' }),
      f('pro_price_iqd', 'iqd', 'options', 'سعر PRO للخيار — __NULL__ = وراثة لكل حقل (خيار ← أساسي)؛ +N/-N = فرق عن الموروث', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'pro_adjust_iqd' }),
      f('prime_price_iqd', 'iqd', 'options', 'سعر PRIME للخيار — __NULL__ = وراثة لكل حقل؛ +N/-N = فرق عن الموروث', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'prime_adjust_iqd' }),
      f('cost_iqd', 'iqd', 'options', 'كلفة الخيار (داخلي، لا يُنشر أبداً) — __NULL__ = inherit؛ +N/-N = فرق عن الكلفة الموروثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'cost_adjust_iqd' }),
      // ---- 0044: an ADJUSTMENT instead of a pin. A row that says "+60,000
      // above the base" keeps following the base; a row that pins a number
      // does not, which is the whole reason pinnedPrices.ts exists.
      f('regular_adjust_iqd', 'int', 'options', 'الزيادة فوق السعر الأساسي بالدينار — الطريقة المعتمدة لتسعير الخيار: يتبع السعر الأساسي ويبقى الفرق ثابتًا (موجب عادةً؛ سالب مسموح). يُستخدم عندما يكون regular_price_iqd فارغًا. __NULL__ = نفس السعر الأساسي.', { nullable: true, min: -IQD_MAX, max: IQD_MAX }),
      f('prime_adjust_iqd', 'int', 'options', 'فرق إضافي لسعر PRIME فوق ما ينتقل تلقائيًا — سعر PRIME يتبع زيادة الخيار من تلقاء نفسه (أساسي 125,000 وخيار +25,000 = 150,000)، فلا تكرّر الزيادة هنا. يُستخدم فقط عندما يكون prime_price_iqd فارغًا؛ بدون سعر PRIME موروث يُحسب من السعر الاعتيادي لنفس الصف.', { nullable: true, min: -IQD_MAX, max: IQD_MAX }),
      f('pro_adjust_iqd', 'int', 'options', 'فرق إضافي لسعر PRO فوق ما ينتقل تلقائيًا — سعر PRO يتبع زيادة الخيار من تلقاء نفسه، فلا تكرّر الزيادة هنا. يُستخدم فقط عندما يكون pro_price_iqd فارغًا؛ بدون سعر PRO موروث يُحسب من السعر الاعتيادي لنفس الصف.', { nullable: true, min: -IQD_MAX, max: IQD_MAX }),
      f('cost_adjust_iqd', 'int', 'options', 'فرق الكلفة عن المستوى الأعلى (داخلي) — يُستخدم فقط عندما يكون cost_iqd فارغًا، ولا يُخترع كلفة من سعر بيع.', { nullable: true, min: -IQD_MAX, max: IQD_MAX }),
      // ---- 0043: this option's own availability, stock and lead time ------
      f('availability_type', 'enum', 'options', 'نوع التوفر لهذا الخيار — فارغ = حسب المنتج (الموصى به): يُباع كما يُباع المنتج، وفرق البيع المباشر/الطلب المسبق يأتي من direct_surcharge_iqd وزيادات النقل لا من خيارات منفصلة. direct_sale | pre_order فقط عندما يختلف هذا الخيار فعلًا عن المنتج.', { enumValues: ['', 'direct_sale', 'pre_order'] as const }),
      f('stock', 'int', 'options', 'مخزون هذا الخيار — __NULL__ = لا يُتتبع (الطلب المسبق عادةً). البيع المباشر يضع رقمًا.', { nullable: true, min: 0, max: 1_000_000 }),
      f('lead_time_text', 'string', 'options', 'مدة الطلب المسبق كما تُعرض للزبون — مثال: 3-4 weeks. النص يسبق الأرقام دائمًا.'),
      f('lead_time_min_days', 'int', 'options', 'أقل عدد أيام للطلب المسبق — للترتيب والتقدير، لا للعرض', { nullable: true, min: 0, max: 3650 }),
      f('lead_time_max_days', 'int', 'options', 'أكثر عدد أيام للطلب المسبق', { nullable: true, min: 0, max: 3650 }),
      f('variant_key', 'string', 'options', 'مفتاح النسخة — a1 / a1-combo. هو ما يجمع «A1 طلب مسبق» و«A1 بيع مباشر» تحت نسخة واحدة؛ اتركه فارغًا ليُشتق من variant_label.'),
      f('variant_label', 'string', 'options', 'اسم النسخة كما يقرؤه الزبون — A1 / A1 Combo. فارغًا يُشتق من اسم الخيار بعد حذف لاحقة نوع التوفر.'),
      f('sku_part', 'string', 'options', 'الجزء الذي يضيفه هذا الخيار إلى رمز المنتج — SKU fragment'),
      f('low_stock_threshold', 'int', 'options', 'حد التنبيه لمخزون هذا الخيار — __NULL__ = بلا تنبيه', { nullable: true, min: 0, max: 1_000_000 }),
    ],
  },
  {
    name: 'colors', bodyKey: 'colors', idPrefix: 'col', mergeKey: 'id', group: 'colors',
    titleAr: 'الألوان', titleEn: 'Colors',
    fields: [
      f('id', 'string', 'colors', 'معرف ثابت — stable id for merge-by-id'),
      f('name_ar', 'string', 'colors', 'اسم اللون بالعربية — مطلوب ما لم يُعطَ name_en (0055: يُخزَّن في صف اللون)', { required: true, requiredUnless: 'name_en', lang: 'ar' }),
      f('name_en', 'string', 'colors', 'Color name (English)', { lang: 'en' }),
      f('name_ckb', 'string', 'colors', 'ناوی ڕەنگ بە کوردی', { lang: 'ckb' }),
      f('hex', 'hex', 'colors', 'رمز اللون #RRGGBB أو فارغ'),
      f('image', 'string', 'colors', 'صورة اللون — color image URL'),
      f('option_id', 'string', 'colors', 'ربط بخيار واحد عبر معرفه — link to ONE option by its id; __NULL__ = متاح لكل الخيارات', { nullable: true }),
      f('option_index', 'int', 'colors', 'بديل استيراد فقط: رقم الخيار في هذا القالب (colors.N.option_index=2 يربط بالخيار options.2) — import-only, never exported', { min: 1, max: 999, exported: false }),
      // option_id can only name ONE option, so a colour offered for two of
      // four options exported as "available to all" and came back wrong. This
      // carries every link, comma separated; it wins over option_id when both
      // are present.
      f('option_ids', 'csv', 'colors', 'كل الخيارات التي يتوفر لها هذا اللون، مفصولة بفواصل — the FULL link set; يتقدّم على option_id. فارغ = متاح لكل الخيارات.'),
      f('sku_part', 'string', 'colors', 'الجزء الذي يضيفه هذا اللون إلى رمز المنتج — SKU fragment'),
      f('stock', 'int', 'colors', 'مخزون هذا اللون — __NULL__ = لا يُتتبع على مستوى اللون', { nullable: true, min: 0, max: 1_000_000 }),
      f('low_stock_threshold', 'int', 'colors', 'حد التنبيه لمخزون هذا اللون — __NULL__ = بلا تنبيه', { nullable: true, min: 0, max: 1_000_000 }),
      f('active', 'bool', 'colors', 'فعال — active'),
      f('regular_price_iqd', 'iqd', 'colors', 'الزيادة فوق سعر الخيار المختار (أو الأساسي) بصيغة +N، أو __NULL__ = نفس سعر الخيار. رقم بلا إشارة = سعر ثابت يستبدل السعر (لون ← خيار ← أساسي).', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'regular_adjust_iqd' }),
      f('pro_price_iqd', 'iqd', 'colors', 'سعر PRO للون — __NULL__ = وراثة لكل حقل؛ +N/-N = فرق عن الموروث', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'pro_adjust_iqd' }),
      f('prime_price_iqd', 'iqd', 'colors', 'سعر PRIME للون — __NULL__ = وراثة لكل حقل؛ +N/-N = فرق عن الموروث', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'prime_adjust_iqd' }),
      f('cost_iqd', 'iqd', 'colors', 'كلفة اللون (داخلي) — __NULL__ = inherit؛ +N/-N = فرق عن الكلفة الموروثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'cost_adjust_iqd' }),
      // ---- 0044: see the options group above.
      f('regular_adjust_iqd', 'int', 'colors', 'الزيادة فوق سعر الخيار المختار (أو الأساسي) بالدينار — الطريقة المعتمدة لتسعير اللون: يتبع ما تحته ويبقى الفرق ثابتًا. يُستخدم عندما يكون regular_price_iqd فارغًا. __NULL__ = نفس السعر.', { nullable: true, min: -IQD_MAX, max: IQD_MAX }),
      f('prime_adjust_iqd', 'int', 'colors', 'فرق إضافي لسعر PRIME فوق ما ينتقل تلقائيًا — زيادة اللون تصل إلى سعر PRIME من تلقاء نفسها، فلا تكرّرها هنا. يُستخدم فقط عندما يكون prime_price_iqd فارغًا.', { nullable: true, min: -IQD_MAX, max: IQD_MAX }),
      f('pro_adjust_iqd', 'int', 'colors', 'فرق إضافي لسعر PRO فوق ما ينتقل تلقائيًا — زيادة اللون تصل إلى سعر PRO من تلقاء نفسها، فلا تكرّرها هنا. يُستخدم فقط عندما يكون pro_price_iqd فارغًا.', { nullable: true, min: -IQD_MAX, max: IQD_MAX }),
      f('cost_adjust_iqd', 'int', 'colors', 'فرق الكلفة عن المستوى الأعلى (داخلي) — يُستخدم فقط عندما يكون cost_iqd فارغًا، ولا يُخترع كلفة من سعر بيع.', { nullable: true, min: -IQD_MAX, max: IQD_MAX }),
    ],
  },
  {
    name: 'spec_groups', bodyKey: 'spec_groups', idPrefix: 'sg', mergeKey: 'id', group: 'specs',
    titleAr: 'المواصفات', titleEn: 'Specification groups',
    fields: [
      f('id', 'string', 'specs', 'معرف ثابت للمجموعة — stable group id for merge-by-id'),
      f('title_ar', 'string', 'specs', 'عنوان مجموعة المواصفات بالعربية', { required: true, lang: 'ar' }),
      f('title_en', 'string', 'specs', 'Group title (English)', { lang: 'en' }),
      f('title_ckb', 'string', 'specs', 'ناونیشانی گروپ بە کوردی', { lang: 'ckb' }),
    ],
    rowFields: [
      f('id', 'string', 'specs', 'معرف ثابت للسطر — stable row id'),
      f('label_ar', 'string', 'specs', 'اسم المواصفة بالعربية', { required: true, lang: 'ar' }),
      f('label_en', 'string', 'specs', 'Spec label (English)', { lang: 'en' }),
      f('label_ckb', 'string', 'specs', 'ناوی تایبەتمەندی بە کوردی', { lang: 'ckb' }),
      f('value_ar', 'string', 'specs', 'القيمة بالعربية', { lang: 'ar' }),
      f('value_en', 'string', 'specs', 'Value (English)', { lang: 'en' }),
      f('value_ckb', 'string', 'specs', 'بەها بە کوردی', { lang: 'ckb' }),
      f('unit', 'string', 'specs', 'الوحدة (mm، kg، W…) — measurement unit, language-neutral'),
    ],
  },
  {
    name: 'labels', bodyKey: 'labels', idPrefix: 'lbl', mergeKey: 'id', group: 'labels',
    titleAr: 'الشارات', titleEn: 'Labels / badges',
    fields: [
      f('id', 'string', 'labels', 'معرف ثابت — stable id'),
      f('key', 'string', 'labels', "مفتاح اختياري مضبوط: featured | warranty_included | free_returns | free_plus أو فارغ"),
      f('text_ar', 'string', 'labels', 'نص الشارة بالعربية', { lang: 'ar' }),
      f('text_en', 'string', 'labels', 'Label text (English)', { lang: 'en' }),
      f('text_ckb', 'string', 'labels', 'دەقی نیشانە بە کوردی', { lang: 'ckb' }),
      f('icon', 'string', 'labels', 'اسم الأيقونة — icon name'),
      f('visible', 'bool', 'labels', 'ظاهرة للزبون — visible on storefront'),
    ],
  },
  {
    name: 'warranty_plans', bodyKey: 'warranty_plans', idPrefix: 'wp', mergeKey: 'id', group: 'warranty',
    titleAr: 'خطط الضمان', titleEn: 'Warranty plans',
    fields: [
      f('id', 'string', 'warranty', 'معرف ثابت — stable id'),
      f('title_ar', 'string', 'warranty', 'عنوان الخطة بالعربية', { required: true, lang: 'ar' }),
      f('title_en', 'string', 'warranty', 'Plan title (English)', { lang: 'en' }),
      f('title_ckb', 'string', 'warranty', 'ناونیشانی پلان بە کوردی', { lang: 'ckb' }),
      f('terms_ar', 'text', 'warranty', 'شروط الضمان بالعربية (heredoc للأسطر المتعددة)', { lang: 'ar' }),
      f('terms_en', 'text', 'warranty', 'Terms (English)', { lang: 'en' }),
      f('terms_ckb', 'text', 'warranty', 'مەرجەکان بە کوردی', { lang: 'ckb' }),
      f('duration_months', 'int', 'warranty', 'مدة التمديد بالأشهر — للطابعات 12 أو 24 فقط (+12 → 24 إجمالًا، +24 → 36 إجمالًا)', { required: true, min: 1, max: 240 }),
      f('duration_kind', 'enum', 'warranty', 'extension (تمديد فوق الضمان الأساسي — الوحيد المقبول للطابعات) | total (مدة كلية، بيانات قديمة)', { enumValues: ['extension', 'total'] as const }),
      f('fee_percent', 'percent', 'warranty', 'رسم التمديد كنسبة من سعر الطابعة الاعتيادي (مثال 7.5 أو 10 — الموصى به 7.5..10)؛ يُقرَّب إلى دينار صحيح ولا يُعفى بالعضوية؛ __NULL__ = رسم ثابت من fee_iqd', { nullable: true, min: 0.01, max: 100 }),
      f('fee_iqd', 'iqd', 'warranty', 'رسم ثابت بالدينار — يُستخدم عندما لا توجد نسبة؛ يُضاف على السعر ولا يُعفى أبداً بالعضوية; 0 = مجاني صراحةً', { required: true, min: 0, max: IQD_MAX, plusIsPlain: true }),
      f('active', 'bool', 'warranty', 'معروضة — offered'),
    ],
  },
  {
    name: 'content_blocks', bodyKey: 'content_blocks', idPrefix: 'cb', mergeKey: 'id', group: 'content',
    titleAr: 'كتل المحتوى', titleEn: 'Bottom-of-page content blocks',
    fields: [
      f('id', 'string', 'content', 'معرف ثابت — stable id'),
      f('kind', 'enum', 'content', 'text | image | video_embed', { required: true, enumValues: ['text', 'image', 'video_embed'] as const }),
      f('body_ar', 'text', 'content', 'النص العربي (heredoc للأسطر المتعددة)', { lang: 'ar' }),
      f('body_en', 'text', 'content', 'Body (English)', { lang: 'en' }),
      f('body_ckb', 'text', 'content', 'دەق بە کوردی', { lang: 'ckb' }),
      f('caption_ar', 'string', 'content', 'التعليق بالعربية', { lang: 'ar' }),
      f('caption_en', 'string', 'content', 'Caption (English)', { lang: 'en' }),
      f('caption_ckb', 'string', 'content', 'سەردێر بە کوردی', { lang: 'ckb' }),
      f('alt_ar', 'string', 'content', 'النص البديل بالعربية (للصور)', { lang: 'ar' }),
      f('alt_en', 'string', 'content', 'Alt text (English)', { lang: 'en' }),
      f('alt_ckb', 'string', 'content', 'دەقی جێگرەوە بە کوردی', { lang: 'ckb' }),
      f('url', 'string', 'content', 'رابط التضمين للفيديو أو رابط الصورة — embed URL (video_embed) or image URL (image)'),
      f('media_key', 'string', 'content', 'مفتاح R2 عند التخزين الداخلي — internal R2 key'),
    ],
  },
  {
    // Lives NESTED in the document (usage_guide.steps), so toDocBody folds it
    // in and out of `usage_guide` instead of writing body[bodyKey] directly.
    name: 'usage_steps', bodyKey: 'usage_steps', idPrefix: 'ustep', mergeKey: 'id', group: 'usage',
    titleAr: 'خطوات التركيب والاستخدام', titleEn: 'Setup & usage steps',
    fields: [
      f('id', 'string', 'usage', 'معرف ثابت — stable id for merge-by-id'),
      f('kind', 'enum', 'usage', 'setup (تركيب) | usage (استخدام)', { required: true, enumValues: ['setup', 'usage'] as const }),
      f('title', 'string', 'usage', 'عنوان الخطوة (حتى 200 حرف) — step title'),
      f('body', 'text', 'usage', 'شرح الخطوة (حتى 2000 حرف؛ heredoc للأسطر المتعددة) — step body'),
      f('images', 'urls', 'usage', 'حتى 6 روابط صور — افصل بينها بمسافة (الفاصلة مقبولة أيضًا قبل رابط جديد). الفاصلة داخل الرابط نفسه لا تكسره. — up to six image URLs, space-separated'),
      f('video_url', 'string', 'usage', 'رابط فيديو (ملف مباشر أو صفحة YouTube/Vimeo) أو فارغ'),
      f('link_url', 'string', 'usage', 'رابط الوثيقة الرسمية لهذه الخطوة أو فارغ'),
    ],
  },
];

/** Fields the template can never edit (or only under an explicit flag). */
const PROTECTED_FIELDS: ProtectedFieldSpec[] = [
  { key: 'product_id', notes: 'header — present in exports; absent = create. Identifies the row to update; never invent one.' },
  { key: 'expected_updated_at', notes: 'header — optional optimistic-concurrency check; apply fails with 409 STALE when the product changed since export.' },
  { key: 'slug', notes: 'stable public identity — preserved on update unless allow_slug_change=true is set in the same template; free on create.' },
  { key: 'allow_slug_change', notes: 'header flag (true/false) unlocking a slug change on update.' },
  { key: 'doc_version', notes: 'schema version managed by the persistence layer — never editable.' },
  { key: 'content_rev', notes: 'Arabic-source revision counter — bumped automatically when Arabic source text changes.' },
  { key: 'translation_meta', notes: 'per-field translation status bookkeeping — derived automatically, never hand-edited.' },
  { key: 'created_at / updated_at', notes: 'timestamps managed by the database.' },
  { key: 'legacy.*', notes: 'v1 passthrough columns (shipping_methods, features, stores, membership_prices, …) — preserved verbatim, not template-editable.' },
];

export const FIELD_REGISTRY = {
  version: TEMPLATE_VERSION,
  scalars: SCALAR_FIELDS,
  groups: GROUP_SPECS,
  protected: PROTECTED_FIELDS,
} as const;

const SCALAR_BY_KEY = new Map(SCALAR_FIELDS.map((s) => [s.key, s]));
const GROUP_BY_NAME = new Map(GROUP_SPECS.map((g) => [g.name, g]));
const HEADER_KEYS = new Set(['template_version', 'product_id', 'expected_updated_at', 'allow_slug_change', 'slug']);

// ---------------------------------------------------------------- parse

export interface TemplateError { line: number; key: string; message: string }
export interface ParsedField {
  value: unknown;
  clear: boolean;
  line: number;
  /** `+N` / `-N` on a price field: the value is an ADJUSTMENT over the level beneath, not a price. */
  adjust?: boolean;
}
export interface ParsedGroupItem {
  index: number;
  line: number;
  fields: Record<string, ParsedField>;
  rows?: ParsedGroupItem[];
}
export interface ParsedTemplate {
  header: {
    template_version: number | null;
    product_id: string | null;
    expected_updated_at: string | null;
    allow_slug_change: boolean;
  };
  /** scalar registry fields (+ slug) present in the template */
  fields: Record<string, ParsedField>;
  /** group name → clear marker (e.g. `options=__CLEAR__`) */
  groupClears: Record<string, ParsedField>;
  /** §10 spec sheet values, keyed by field id (`spec.build_volume=…`). */
  specFields: Record<string, ParsedField>;
  groups: Record<string, ParsedGroupItem[]>;
  unknown_keys: string[];
  errors: TemplateError[];
  warnings: string[];
}

const MAX_TEMPLATE_BYTES = 1_500_000;
const KEY_RE = /^([A-Za-z0-9_.]+)\s*=(.*)$/;
const GROUP_KEY_RE = /^([a-z_]+)\.(\d+)\.(.+)$/;
const ROW_KEY_RE = /^rows\.(\d+)\.(.+)$/;
const HEREDOC_TOKEN_RE = /^[A-Za-z0-9_]{1,40}$/;

function coerce(
  spec: FieldSpec,
  raw: string,
  line: number,
  fullKey: string,
  errors: TemplateError[]
): ParsedField | null {
  const err = (message: string) => {
    errors.push({ line, key: fullKey, message });
    return null;
  };
  if (raw === NULL_TOKEN) {
    if (!spec.nullable) return err(`${NULL_TOKEN} is not allowed here — the field is not nullable (use ${CLEAR_TOKEN} to empty it, or omit the line to keep the current value)`);
    return { value: null, clear: false, line };
  }
  if (raw === CLEAR_TOKEN) {
    if (spec.type === 'iqd' || spec.type === 'int' || spec.type === 'percent') {
      if (!spec.nullable) return err(`${CLEAR_TOKEN} is not allowed — this number is required; set an explicit value`);
      return { value: null, clear: true, line };
    }
    if (spec.type === 'bool' || spec.type === 'enum') {
      return err(`${CLEAR_TOKEN} is not allowed for ${spec.type} fields — set an explicit value`);
    }
    if (spec.type === 'csv' || spec.type === 'urls') return { value: [], clear: true, line };
    return { value: '', clear: true, line };
  }
  switch (spec.type) {
    case 'string':
    case 'text':
    case 'ref':
      return { value: raw, clear: false, line };
    case 'hex':
      if (raw !== '' && !/^#[0-9a-fA-F]{6}$/.test(raw)) return err('must be a #RRGGBB hex code or empty');
      return { value: raw, clear: false, line };
    case 'iqd':
    case 'int': {
      if (raw === '') return err(`empty number — write an integer, ${spec.nullable ? `${NULL_TOKEN}, ` : ''}or omit the line to keep the current value`);
      // A SIGNED number on an option/colour price is an increase over the
      // level beneath («زيادة فوق السعر»), routed to the adjustment twin. On
      // any other price it is refused rather than read as a price: the sign
      // says the writer meant a difference, and there is nothing to differ from.
      // A surcharge written as `+51000`: the sign only says what the field
      // already is, so it is dropped rather than refused.
      const text = spec.plusIsPlain && /^\+\d+$/.test(raw) ? raw.slice(1) : raw;
      if (/^[+-]\d+$/.test(text)) {
        if (spec.adjustKey) {
          const n = parseInt(text, 10);
          if (!Number.isSafeInteger(n) || Math.abs(n) > IQD_MAX) return err('adjustment out of range');
          return { value: n, clear: false, line, adjust: true };
        }
        if (spec.type === 'iqd') {
          return err(`a signed value (+N / -N) means "over the level beneath" and only option/colour price fields take one — write a plain number here`);
        }
      }
      if (!/^[+-]?\d+$/.test(text)) return err(`must be an integer${spec.type === 'iqd' ? ' (IQD, no separators or decimals)' : ''}`);
      const n = parseInt(text, 10);
      if (!Number.isSafeInteger(n)) return err('integer out of range');
      const min = spec.min ?? (spec.type === 'iqd' ? 0 : Number.MIN_SAFE_INTEGER);
      const max = spec.max ?? Number.MAX_SAFE_INTEGER;
      if (n < min || n > max) return err(`must be between ${min} and ${max}`);
      return { value: n, clear: false, line };
    }
    case 'percent': {
      // A share of the price: "7.5", "10", "+7.5". Two decimals at most, so
      // the fee it produces rounds to the same dinar everywhere.
      if (raw === '') return err(`empty percentage — write a number like 7.5, ${spec.nullable ? `${NULL_TOKEN}, ` : ''}or omit the line to keep the current value`);
      const text = raw.replace(/^\+/, '');
      if (!/^\d+(\.\d{1,2})?$/.test(text)) return err('must be a percentage with at most two decimals (e.g. 7.5)');
      const n = Number(text);
      const min = spec.min ?? 0.01;
      const max = spec.max ?? 100;
      if (!Number.isFinite(n) || n < min || n > max) return err(`must be between ${min} and ${max}`);
      return { value: n, clear: false, line };
    }
    case 'bool': {
      const t = raw.toLowerCase();
      if (t === 'true' || t === '1' || t === 'yes') return { value: true, clear: false, line };
      if (t === 'false' || t === '0' || t === 'no') return { value: false, clear: false, line };
      return err('must be true or false');
    }
    case 'enum':
      if (!spec.enumValues || !spec.enumValues.includes(raw)) {
        return err(`must be one of: ${(spec.enumValues ?? []).join(' | ')}`);
      }
      return { value: raw, clear: false, line };
    case 'csv': {
      if (raw === '') return { value: [], clear: false, line };
      const items = raw.split(',').map((x) => x.trim()).filter(Boolean);
      return { value: items, clear: false, line };
    }
    /**
     * A LIST OF ADDRESSES IS NOT A LIST OF TOKENS, and splitting one on every
     * comma corrupts it.
     *
     * `usage_steps.N.images` is the only list of URLs the template carries, and
     * it was a plain `csv`. A comma is a legal character in a URL path, and
     * vendor CDNs use it constantly — a Cloudinary transform reads
     * `.../upload/w_400,h_300/a.jpg`. Splitting there turned ONE working image
     * into two broken ones, on export as well as on import, and the round trip
     * multiplied them every time.
     *
     * The split is therefore URL-AWARE: whitespace always separates (a bare
     * space cannot appear inside a valid URL), and a comma separates ONLY when
     * what follows it starts a new address — `http://`, `https://` or a
     * site-relative `/`. That reads every file already written with the old
     * bare-comma join, and leaves `w_400,h_300` alone. Export now joins with a
     * space, which is unambiguous from here on.
     */
    case 'urls': {
      if (raw === '') return { value: [], clear: false, line };
      const items = raw
        .split(/\s+|,(?=\s*(?:https?:\/\/|\/))/i)
        .map((x) => x.trim().replace(/,$/, ''))
        .filter(Boolean);
      return { value: items, clear: false, line };
    }
  }
}

/**
 * Parses template text into structured fields/groups with line-precise
 * errors. Strips a UTF-8 BOM, normalizes CRLF/CR line endings, handles
 * heredoc multiline values (Arabic/ckb content preserved verbatim).
 */
export function parseTemplate(text: string): ParsedTemplate {
  const out: ParsedTemplate = {
    header: { template_version: null, product_id: null, expected_updated_at: null, allow_slug_change: false },
    fields: {},
    groupClears: {},
    specFields: {},
    groups: {},
    unknown_keys: [],
    errors: [],
    warnings: [],
  };
  const err = (line: number, key: string, message: string) => out.errors.push({ line, key, message });

  if (typeof text !== 'string') {
    err(1, '', 'template text is missing');
    return out;
  }
  if (text.length > MAX_TEMPLATE_BYTES) {
    err(1, '', `template is too large (max ${MAX_TEMPLATE_BYTES} characters)`);
    return out;
  }
  // BOM strip + newline normalization (CRLF and lone CR → LF).
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // group → index → item ; duplicate detection sets
  const seenScalar = new Set<string>();
  const seenGroupField = new Set<string>();
  const groupItems: Record<string, Map<number, ParsedGroupItem>> = {};

  const getItem = (groupName: string, index: number, line: number): ParsedGroupItem => {
    const map = (groupItems[groupName] ??= new Map());
    let item = map.get(index);
    if (!item) {
      item = { index, line, fields: {} };
      map.set(index, item);
    }
    return item;
  };

  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    i++;
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const m = KEY_RE.exec(trimmed);
    if (!m) {
      err(lineNo, '', `not a key=value line: "${trimmed.slice(0, 60)}"`);
      continue;
    }
    const key = m[1];
    let value = m[2].trim();

    // Heredoc: key=<<<TOKEN … TOKEN (terminator on its own line, content verbatim).
    if (value.startsWith('<<<')) {
      const token = value.slice(3).trim() || 'END';
      if (!HEREDOC_TOKEN_RE.test(token)) {
        err(lineNo, key, `invalid heredoc delimiter "${token}" — use letters/digits/underscore, e.g. key=<<<END`);
        continue;
      }
      const collected: string[] = [];
      let terminated = false;
      while (i < lines.length) {
        const l = lines[i];
        i++;
        if (l.trim() === token) { terminated = true; break; }
        collected.push(l);
      }
      if (!terminated) {
        err(lineNo, key, `unterminated heredoc — missing closing "${token}" line`);
        continue;
      }
      value = collected.join('\n');
    }

    // ---- header keys
    if (HEADER_KEYS.has(key)) {
      if (seenScalar.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
      seenScalar.add(key);
      if (key === 'template_version') {
        if (value !== String(TEMPLATE_VERSION)) {
          err(lineNo, key, `unsupported template_version "${value}" — this parser accepts version ${TEMPLATE_VERSION}`);
        } else {
          out.header.template_version = TEMPLATE_VERSION;
        }
      } else if (key === 'product_id') {
        out.header.product_id = value || null;
      } else if (key === 'expected_updated_at') {
        out.header.expected_updated_at = value || null;
      } else if (key === 'allow_slug_change') {
        const t = value.toLowerCase();
        if (t !== 'true' && t !== 'false' && t !== '') { err(lineNo, key, 'must be true or false'); continue; }
        out.header.allow_slug_change = t === 'true';
      } else if (key === 'slug') {
        out.fields.slug = { value, clear: false, line: lineNo };
      }
      continue;
    }

    // ---- scalar registry keys
    const scalarSpec = SCALAR_BY_KEY.get(key);
    if (scalarSpec) {
      if (seenScalar.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
      seenScalar.add(key);
      const pf = coerce(scalarSpec, value, lineNo, key, out.errors);
      if (pf) out.fields[key] = pf;
      continue;
    }

    /**
     * ---- the §10 spec sheet: `spec.<field_id>=value` ---------------------
     *
     * The printer and filament sheet — build volume, nozzle, weight, warranty
     * months, «ما في الصندوق» — is a flat {field_id: value} map on
     * `products.spec_fields`, filled from the per-family templates in
     * templateFamilies.ts. It is the biggest block of the admin form (the
     * «٤٤ حقل» badge in section 7) and the TXT registry had no key for any of
     * it, so an export could neither show nor set a single spec.
     *
     * A PREFIX family rather than a registry entry, because the field list
     * depends on the product's template_family and its section — a fixed
     * registry would either be wrong for half the catalogue or 200 keys long.
     * Values are free text, which is what the column stores.
     */
    const sm = /^spec\.([a-z0-9_]{1,80})$/.exec(key);
    if (sm) {
      if (out.specFields[sm[1]]) { err(lineNo, key, 'duplicate key'); continue; }
      out.specFields[sm[1]] = {
        value: value === NULL_TOKEN ? null : value,
        clear: value === CLEAR_TOKEN,
        line: lineNo,
      };
      continue;
    }

    // ---- whole-group clear: options=__CLEAR__
    if (GROUP_BY_NAME.has(key)) {
      if (value !== CLEAR_TOKEN) {
        err(lineNo, key, `"${key}" is a repeatable group — use indexed keys like ${key}.1.…, or ${key}=${CLEAR_TOKEN} to remove all items`);
        continue;
      }
      if (out.groupClears[key]) { err(lineNo, key, 'duplicate key'); continue; }
      out.groupClears[key] = { value: null, clear: true, line: lineNo };
      continue;
    }

    // ---- indexed group keys
    const gm = GROUP_KEY_RE.exec(key);
    if (gm && GROUP_BY_NAME.has(gm[1])) {
      const groupSpec = GROUP_BY_NAME.get(gm[1])!;
      const index = parseInt(gm[2], 10);
      if (index < 1 || index > 500) { err(lineNo, key, 'group index must be between 1 and 500'); continue; }
      const sub = gm[3];
      const item = getItem(groupSpec.name, index, lineNo);

      const rm = ROW_KEY_RE.exec(sub);
      if (rm && groupSpec.rowFields) {
        const rowIndex = parseInt(rm[1], 10);
        if (rowIndex < 1 || rowIndex > 500) { err(lineNo, key, 'row index must be between 1 and 500'); continue; }
        const rowKey = rm[2];
        const rowSpec = groupSpec.rowFields.find((r) => r.key === rowKey);
        if (!rowSpec) { out.unknown_keys.push(key); continue; }
        if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
        seenGroupField.add(key);
        item.rows ??= [];
        let row = item.rows.find((r) => r.index === rowIndex);
        if (!row) { row = { index: rowIndex, line: lineNo, fields: {} }; item.rows.push(row); }
        const pf = coerce(rowSpec, value, lineNo, key, out.errors);
        if (pf) row.fields[rowKey] = pf;
        continue;
      }

      const fieldSpec = groupSpec.fields.find((x) => x.key === sub);
      if (!fieldSpec) { out.unknown_keys.push(key); continue; }
      if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
      seenGroupField.add(key);
      const pf = coerce(fieldSpec, value, lineNo, key, out.errors);
      if (pf) item.fields[sub] = pf;
      continue;
    }

    out.unknown_keys.push(key);
  }

  if (out.header.template_version === null && !out.errors.some((e) => e.key === 'template_version')) {
    err(1, 'template_version', `template_version=${TEMPLATE_VERSION} is required as the first non-comment line`);
  }

  // Materialize groups sorted by index; rows sorted too.
  for (const [name, map] of Object.entries(groupItems)) {
    const items = [...map.values()].sort((a, b) => a.index - b.index);
    for (const it of items) it.rows?.sort((a, b) => a.index - b.index);
    out.groups[name] = items;
  }
  for (const key of out.unknown_keys) {
    out.warnings.push(`unknown key "${key}" was ignored`);
  }
  return out;
}

// ---------------------------------------------------------------- export

export interface ExportOpts {
  /** brand slug for readability (falls back to doc.brand_id / __NULL__) */
  brand?: string | null;
  /** `products.inventory_mode` — not on the document, supplied by the route
   *  so the export says which level counts the stock and a re-import keeps it. */
  inventoryMode?: string | null;
  /**
   * The §10 spec field ids this product's family declares, in form order.
   * Supplied by the route from `fieldsFor(template_family, sections)`; the
   * exporter writes every one of them, empty or not, so the file lists the
   * whole sheet rather than only the specs that happen to be filled.
   */
  specFieldIds?: string[];
  /** main-section slug for readability (falls back to doc.category_id) */
  category?: string | null;
  /** sub-section slug for readability (falls back to doc.sub_category_id) */
  subCategory?: string | null;
  /** catalog slugs; when undefined the catalogs key is omitted (unknown) */
  catalogs?: string[];
  /** include field-annotation comments (blank template style) */
  comments?: boolean;
  /**
   * Whether the caller may see cost.
   *
   * §11 says cost appears in NO API, HTML or export an assistant admin can
   * reach, and the CSV path has always honoured it (adminImport.ts passes
   * `canViewFinancials`). This flag did not exist, so the TXT export wrote
   * `product_cost_iqd`, `options.N.cost_iqd` and the colour equivalents
   * unconditionally — an assistant could download the whole cost sheet as a
   * .txt. Defaults to true, so the blank-template generator, which describes
   * the FORMAT rather than any product's data, is unchanged.
   */
  includeCost?: boolean;
  /**
   * THE NUMBER THE CUSTOMER ACTUALLY PAYS, written beside every inheriting
   * field as a comment.
   *
   * The owner's words: «ويضع السعر في الخيارات المفتوحه مثل خيارات الشحن».
   * A row that inherits exports as `__NULL__`, which is the truth about what
   * is STORED and useless as an answer to "what does this option cost?".
   * Comments are ignored by the parser, so the file stays byte-for-byte
   * re-importable while finally saying what it means. Off for the blank
   * template, which describes the format rather than a product.
   */
  showEffective?: boolean;
  /**
   * The admin's per-method pre-order commissions, from the
   * `preorderTransportDefaults` setting. `transports.N.commission_iqd=__NULL__`
   * means "inherit this", and without it the export cannot say what.
   */
  transportDefaults?: Array<{ method: string; commission_iqd: number | null }>;
}

interface Entry { key: string; value: string | null }

function heredocDelim(value: string): string {
  let token = 'END';
  let n = 1;
  const has = (t: string) => value.split('\n').some((l) => l.trim() === t);
  while (has(token)) token = `END_${++n}`;
  return token;
}

function fmtLines(key: string, value: string | null): string[] {
  if (value === null) return [`${key}=${NULL_TOKEN}`];
  const needsHeredoc =
    value.includes('\n') ||
    value !== value.trim() ||
    value.startsWith('<<<') ||
    value === NULL_TOKEN ||
    value === CLEAR_TOKEN;
  if (!needsHeredoc) return [`${key}=${value}`];
  const token = heredocDelim(value);
  return [`${key}=<<<${token}`, ...value.split('\n'), token];
}

const boolStr = (b: boolean) => (b ? 'true' : 'false');
const numStr = (n: number | null) => (n === null || n === undefined ? null : String(n));

/**
 * Flattens a ProductDoc into deterministic template entries (registry order,
 * group items ordered by their `order` then id). Reused by exportProduct and
 * by the route-level diff (before/after keyed by template key).
 */
/**
 * Options in the order the file lists them: GROUP BY GROUP, not by a global
 * sort number.
 *
 * `order` is the position WITHIN a group, so sorting the flat list by it
 * interleaves the groups — "Model / A1", "Nozzle / 0.6", "Model / A1 Combo".
 * The file is read and edited by a person and rows that belong together must
 * sit together; the importer rebuilds the groups from the `group` column
 * either way, so this is presentation, not semantics. Exported because the
 * effective-price annotations must number the rows exactly as the file does.
 */
export function orderedOptions(doc: ProductDoc): ProductDoc['options'] {
  const groupOrder = new Map<string, number>();
  for (const o of doc.options) {
    const g = o.group_en ?? '';
    if (!groupOrder.has(g)) groupOrder.set(g, groupOrder.size);
  }
  return [...doc.options].sort(
    (a, b) =>
      (groupOrder.get(a.group_en ?? '') ?? 0) - (groupOrder.get(b.group_en ?? '') ?? 0) ||
      (a.order ?? 0) - (b.order ?? 0) ||
      String(a.id).localeCompare(String(b.id))
  );
}

export function docToEntries(doc: ProductDoc, opts: ExportOpts = {}): Entry[] {
  const e: Entry[] = [];
  const push = (key: string, value: string | null) => e.push({ key, value });
  // §11: cost reaches no export an assistant admin can open. Absent means
  // "may see it" so the blank template — which describes the FORMAT, not any
  // product's data — is unchanged.
  const money = opts.includeCost !== false;

  // identity
  push('name_ar', doc.name_ar);
  push('name_en', doc.name_en);
  push('name_ckb', doc.name_ckb);
  push('status', doc.status);
  // description
  push('description_ar', doc.description_ar);
  push('description_en', doc.description_en);
  push('description_ckb', doc.description_ckb);
  push('how_to_use', doc.how_to_use);
  // pricing
  push('price_iqd', String(doc.price_iqd));
  push('pro_price_iqd', numStr(doc.pro_price_iqd));
  push('prime_price_iqd', numStr(doc.prime_price_iqd));
  // Declared in the registry, taught by the blank template and the example —
  // and never written by the exporter until now, so the owner could not see
  // the struck-through price they had set, let alone edit it.
  push('original_price_iqd', numStr(doc.original_price_iqd));
  if (money) push('product_cost_iqd', numStr(doc.product_cost_iqd));
  // classification
  if (opts.brand !== undefined) push('brand', opts.brand);
  else push('brand', doc.brand_id ?? null);
  if (opts.catalogs !== undefined) push('catalogs', opts.catalogs.join(','));
  // The section pair is written as SLUGS when the caller resolved them, so the
  // file is readable and re-importable on another environment; ids are the
  // fallback rather than the norm.
  if (opts.category !== undefined) push('category', opts.category);
  else push('category', doc.category_id ?? null);
  if (opts.subCategory !== undefined) push('sub_category', opts.subCategory);
  else push('sub_category', doc.sub_category_id ?? null);
  push('template_family', doc.template_family ?? '');
  push('sku', doc.sku ?? '');
  push('hashtags', doc.hashtags.join(','));
  push('is_featured', boolStr(doc.is_featured));
  push('display_order', String(doc.display_order));
  // selling
  // A product selling both ways exports the word `mixed` — the scalar alone
  // would say 'direct_sale' and a re-import of the store's own export would
  // quietly halve the product. The importer expands it back, and the options'
  // own availability types are the authority either way.
  //
  // A COMPOSITION ROW IS THE ONE EXCEPTION (docs/BUNDLES_MYSTERY.md §1.2). Its
  // `sale_types` are pinned to `["bundle"]` or `["bundle","pre_order"]`, and
  // `isMixed` reads the second of those as mixed — so a pre-order bundle would
  // export `selling_type: mixed`, a value that describes no bundle and that
  // the parser would expand into a direct-sale product. It exports `bundle`.
  // Nothing reads the value back either way: `planProductSave` refuses every
  // writer but the bundles panel for a composition row
  // (`COMPOSITION_NOT_ALLOWED`), so the template and the CSV importer cannot
  // apply one at all.
  push(
    'selling_type',
    doc.composition !== '' ? 'bundle' : isMixed(doc.sale_types) ? 'mixed' : doc.selling_type
  );
  push('stock', numStr(doc.stock));
  push('low_stock_threshold', numStr(doc.low_stock_threshold));
  if (opts.inventoryMode !== undefined) push('inventory_mode', opts.inventoryMode ?? '');
  push('direct_surcharge_iqd', numStr(doc.direct_surcharge_iqd));
  push('payment_options', doc.payment_options.join(','));
  // Device coverage — written whenever the product states it. A product that
  // never said whether it is serialized exports no `serialized` line, so a
  // re-import keeps the stored answer instead of turning silence into false.
  push('warranty_base_months', numStr(doc.warranty_base_months));
  if (doc.serialized !== null) push('serialized', boolStr(doc.serialized));

  const sorted = <T extends { order?: number; id?: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));

  /**
   * ALL THREE ROUTES, ALWAYS.
   *
   * A product that has never been given a transport row exported nothing at
   * all here — no keys, no section, no hint — so «خيارات الشحن» could not be
   * turned on by editing the file, which is half of what the owner asked for.
   * A method the product does not carry is written with an empty commission
   * and `active=false`: importing it back changes nothing, and switching the
   * flag is now a one-word edit.
   */
  const METHOD_ORDER: Array<'air' | 'sea' | 'land'> = ['air', 'sea', 'land'];
  const declared = new Map(doc.preorder_transports.map((t) => [t.method, t]));
  const transportRows = [
    ...doc.preorder_transports,
    ...METHOD_ORDER.filter((m) => !declared.has(m)).map((method) => ({
      method,
      commission_iqd: null,
      active: false,
    })),
  ];
  transportRows.forEach((t, i) => {
    const p = `transports.${i + 1}`;
    push(`${p}.method`, t.method);
    push(`${p}.commission_iqd`, numStr(t.commission_iqd));
    push(`${p}.active`, boolStr(t.active));
  });

  sorted(doc.media).forEach((mItem, i) => {
    const p = `images.${i + 1}`;
    push(`${p}.id`, mItem.id);
    push(`${p}.url`, mItem.url);
    push(`${p}.key`, mItem.key);
    push(`${p}.alt_ar`, mItem.alt_ar);
    push(`${p}.alt_en`, mItem.alt_en);
    push(`${p}.alt_ckb`, mItem.alt_ckb);
    push(`${p}.primary`, boolStr(mItem.primary));
    push(`${p}.source_url`, mItem.source_url);
    push(`${p}.option_value_id`, mItem.option_value_id ?? '');
    push(`${p}.color_id`, mItem.color_id ?? '');
    push(`${p}.variant_id`, mItem.variant_id ?? '');
    push(`${p}.width`, numStr(mItem.width));
    push(`${p}.height`, numStr(mItem.height));
  });

  orderedOptions(doc).forEach((o, i) => {
    const p = `options.${i + 1}`;
    push(`${p}.id`, o.id);
    push(`${p}.group`, o.group_en ?? '');
    push(`${p}.name_ar`, o.name_ar);
    push(`${p}.name_en`, o.name_en);
    push(`${p}.name_ckb`, o.name_ckb);
    push(`${p}.image`, o.image);
    push(`${p}.active`, boolStr(o.active));
    push(`${p}.regular_price_iqd`, numStr(o.regular_price_iqd));
    push(`${p}.pro_price_iqd`, numStr(o.pro_price_iqd));
    push(`${p}.prime_price_iqd`, numStr(o.prime_price_iqd));
    if (money) push(`${p}.cost_iqd`, numStr(o.cost_iqd));
    push(`${p}.regular_adjust_iqd`, numStr(o.regular_adjust_iqd ?? null));
    push(`${p}.prime_adjust_iqd`, numStr(o.prime_adjust_iqd ?? null));
    push(`${p}.pro_adjust_iqd`, numStr(o.pro_adjust_iqd ?? null));
    if (money) push(`${p}.cost_adjust_iqd`, numStr(o.cost_adjust_iqd ?? null));
    // 0043. Exported unconditionally, including as empty strings, because an
    // export is the bulk-EDIT path: a field the file omits is one the importer
    // PRESERVES, so a silently-absent availability could never be cleared by
    // editing the file the store itself produced.
    push(`${p}.availability_type`, o.availability_type ?? '');
    push(`${p}.stock`, numStr(o.stock ?? null));
    push(`${p}.lead_time_text`, o.lead_time_text ?? '');
    push(`${p}.lead_time_min_days`, numStr(o.lead_time_min_days ?? null));
    push(`${p}.lead_time_max_days`, numStr(o.lead_time_max_days ?? null));
    push(`${p}.variant_key`, o.variant_key ?? '');
    push(`${p}.variant_label`, o.variant_label ?? '');
    push(`${p}.sku_part`, o.sku_part ?? '');
    push(`${p}.low_stock_threshold`, numStr(o.low_stock_threshold ?? null));
  });

  sorted(doc.colors).forEach((cItem, i) => {
    const p = `colors.${i + 1}`;
    push(`${p}.id`, cItem.id);
    push(`${p}.name_ar`, cItem.name_ar);
    push(`${p}.name_en`, cItem.name_en);
    push(`${p}.name_ckb`, cItem.name_ckb);
    push(`${p}.hex`, cItem.hex);
    push(`${p}.image`, cItem.image);
    push(`${p}.option_id`, cItem.option_id ?? null);
    push(`${p}.option_ids`, (cItem.option_ids ?? []).join(','));
    push(`${p}.sku_part`, cItem.sku_part ?? '');
    push(`${p}.stock`, numStr(cItem.stock ?? null));
    push(`${p}.low_stock_threshold`, numStr(cItem.low_stock_threshold ?? null));
    push(`${p}.active`, boolStr(cItem.active));
    push(`${p}.regular_price_iqd`, numStr(cItem.regular_price_iqd));
    push(`${p}.pro_price_iqd`, numStr(cItem.pro_price_iqd));
    push(`${p}.prime_price_iqd`, numStr(cItem.prime_price_iqd));
    if (money) push(`${p}.cost_iqd`, numStr(cItem.cost_iqd));
    push(`${p}.regular_adjust_iqd`, numStr(cItem.regular_adjust_iqd ?? null));
    push(`${p}.prime_adjust_iqd`, numStr(cItem.prime_adjust_iqd ?? null));
    push(`${p}.pro_adjust_iqd`, numStr(cItem.pro_adjust_iqd ?? null));
    if (money) push(`${p}.cost_adjust_iqd`, numStr(cItem.cost_adjust_iqd ?? null));
  });

  /**
   * The §10 sheet, one `spec.<id>` line per field.
   *
   * Every field the product's family declares is written even when it is
   * empty — that is what «يملأ جميع الحقول» asks for here: the owner opens the
   * file and sees the build volume, the nozzle, the weight and «ما في الصندوق»
   * waiting to be typed, instead of having to know the field ids. Values the
   * product carries that the family no longer declares are written after them
   * rather than silently dropped.
   */
  const specWritten = new Set<string>();
  for (const id of opts.specFieldIds ?? []) {
    specWritten.add(id);
    push(`spec.${id}`, doc.spec_fields[id] ?? '');
  }
  for (const [id, value] of Object.entries(doc.spec_fields)) {
    if (specWritten.has(id)) continue;
    push(`spec.${id}`, value);
  }

  sorted(doc.spec_groups).forEach((g, gi) => {
    const p = `spec_groups.${gi + 1}`;
    push(`${p}.id`, g.id);
    push(`${p}.title_ar`, g.title_ar);
    push(`${p}.title_en`, g.title_en);
    push(`${p}.title_ckb`, g.title_ckb);
    sorted(g.rows).forEach((r, ri) => {
      const rp = `${p}.rows.${ri + 1}`;
      push(`${rp}.id`, r.id);
      push(`${rp}.label_ar`, r.label_ar);
      push(`${rp}.label_en`, r.label_en);
      push(`${rp}.label_ckb`, r.label_ckb);
      push(`${rp}.value_ar`, r.value_ar);
      push(`${rp}.value_en`, r.value_en);
      push(`${rp}.value_ckb`, r.value_ckb);
      push(`${rp}.unit`, r.unit);
    });
  });

  sorted(doc.labels).forEach((l, i) => {
    const p = `labels.${i + 1}`;
    push(`${p}.id`, l.id);
    push(`${p}.key`, l.key);
    push(`${p}.text_ar`, l.text_ar);
    push(`${p}.text_en`, l.text_en);
    push(`${p}.text_ckb`, l.text_ckb);
    push(`${p}.icon`, l.icon);
    push(`${p}.visible`, boolStr(l.visible));
  });

  sorted(doc.warranty_plans).forEach((w, i) => {
    const p = `warranty_plans.${i + 1}`;
    push(`${p}.id`, w.id);
    push(`${p}.title_ar`, w.title_ar);
    push(`${p}.title_en`, w.title_en);
    push(`${p}.title_ckb`, w.title_ckb);
    push(`${p}.terms_ar`, w.terms_ar);
    push(`${p}.terms_en`, w.terms_en);
    push(`${p}.terms_ckb`, w.terms_ckb);
    push(`${p}.duration_months`, String(w.duration_months));
    push(`${p}.duration_kind`, w.duration_kind);
    push(`${p}.fee_percent`, w.fee_percent === null || w.fee_percent === undefined ? null : String(w.fee_percent));
    push(`${p}.fee_iqd`, String(w.fee_iqd));
    push(`${p}.active`, boolStr(w.active));
  });

  sorted(doc.content_blocks).forEach((b, i) => {
    const p = `content_blocks.${i + 1}`;
    push(`${p}.id`, b.id);
    push(`${p}.kind`, b.kind);
    push(`${p}.body_ar`, b.body_ar);
    push(`${p}.body_en`, b.body_en);
    push(`${p}.body_ckb`, b.body_ckb);
    push(`${p}.caption_ar`, b.caption_ar);
    push(`${p}.caption_en`, b.caption_en);
    push(`${p}.caption_ckb`, b.caption_ckb);
    push(`${p}.alt_ar`, b.alt_ar);
    push(`${p}.alt_en`, b.alt_en);
    push(`${p}.alt_ckb`, b.alt_ckb);
    push(`${p}.url`, b.url);
    push(`${p}.media_key`, b.media_key);
  });

  // The setup & usage guide — the one form section that had no key at all,
  // so «يملأ جميع الحقول» was structurally impossible for it.
  push('usage_official_url', doc.usage_guide?.official_url ?? '');
  sorted(doc.usage_guide?.steps ?? []).forEach((st, i) => {
    const p = `usage_steps.${i + 1}`;
    push(`${p}.id`, st.id);
    push(`${p}.kind`, st.kind);
    push(`${p}.title`, st.title);
    push(`${p}.body`, st.body);
    // A SPACE, not a comma: a bare space cannot appear inside a valid URL, so
    // this join is unambiguous no matter what the address contains.
    push(`${p}.images`, st.images.join(' '));
    push(`${p}.video_url`, st.video_url);
    push(`${p}.link_url`, st.link_url);
  });

  return e;
}

const groupTitle = (id: string): { ar: string; en: string } => {
  const g = TEMPLATE_GROUPS.find((x) => x.id === id)!;
  return { ar: g.titleAr, en: g.titleEn };
};

function sectionHeader(groupId: string): string[] {
  const t = groupTitle(groupId);
  return ['', `# ------------------------------ ${t.ar} / ${t.en}`];
}

const iqd = (n: number): string => n.toLocaleString('en-US');

/**
 * WHAT EACH INHERITING FIELD RESOLVES TO, as a comment map keyed by template
 * key.
 *
 * These are ITEM prices — what the ladder resolves for that row. What the
 * customer pays on a LINE is this plus the direct premium (a direct sale) or
 * the transport commission (a pre-order), and the file annotates those
 * separately where they live.
 *
 * Every number here comes from `buildGrid`, which computes the ladder with the
 * SAME rules `pricing.ts` resolves at checkout — so the file and the cart
 * cannot disagree. Nothing is written to a value: these are comment lines the
 * parser skips, so annotating can never change what a re-import means.
 */
function effectiveNotes(doc: ProductDoc, opts: ExportOpts): Map<string, string> {
  const out = new Map<string, string>();
  const money = opts.includeCost !== false;
  const options = orderedOptions(doc);
  const rows = buildGrid({
    price_iqd: doc.price_iqd,
    prime_price_iqd: doc.prime_price_iqd,
    pro_price_iqd: doc.pro_price_iqd,
    product_cost_iqd: doc.product_cost_iqd,
    selling_type: doc.selling_type,
    sale_types: doc.sale_types,
    options,
    colors: doc.colors,
  });
  const rowById = new Map(rows.map((r) => [`${r.level}:${r.id}`, r]));
  // Do the options actually price differently from one another? If they all
  // resolve to the same regular price, a colour's inherited number is the same
  // whichever option is picked, and naming it is safe.
  const optionRegulars = new Set(
    rows.filter((r) => r.level === 'option').map((r) => r.cells.regular.effective)
  );
  const optionsPriceDiffer = optionRegulars.size > 1;

  // Whole phrases, not a noun plus a shared adjective: «الكلفة الفعلي» is
  // wrong in Arabic, and a bare «الاعتيادي» does not say what it measures.
  // «للصنف» is load-bearing: these are the ITEM prices the ladder resolves.
  // A direct line also pays direct_surcharge_iqd and a pre-order line pays its
  // transport commission, neither of which is part of this number — calling it
  // "what the customer pays" would be wrong on most lines.
  const label: Record<Field, string> = {
    regular: 'السعر الاعتيادي الفعلي للصنف',
    prime: 'سعر PRIME الفعلي للصنف',
    pro: 'سعر PRO الفعلي للصنف',
    cost: 'الكلفة الفعلية للصنف',
  };
  const note = (prefix: string, level: 'option' | 'color', id: string) => {
    const row = rowById.get(`${level}:${id}`);
    if (!row) return;

    /**
     * THE MEMBER LADDER IS CLAMPED AT CHECKOUT, AND buildGrid DOES NOT CLAMP.
     *
     * pricing.ts caps PRO and PRIME at the regular price resolved for the SAME
     * row, and floors PRIME at PRO. buildGrid reports the raw inherited number
     * instead, so a row whose regular price is adjusted DOWN was annotated with
     * a member price higher than the one the customer is charged. Annotating a
     * number the cart will not honour is worse than annotating nothing.
     */
    const regular = row.cells.regular.effective;
    const clamp = (f: Field, v: number | null): number | null => {
      if (v === null || regular === null) return v;
      if (f === 'pro') return Math.min(v, regular);
      if (f === 'prime') {
        const pro = row.cells.pro.effective === null ? null : Math.min(row.cells.pro.effective, regular);
        const capped = Math.min(v, regular);
        return pro === null ? capped : Math.max(capped, pro);
      }
      return v;
    };

    for (const f of FIELDS) {
      if (f === 'cost' && !money) continue;
      const cell = row.cells[f];
      // Only a row that does NOT state its own number needs telling. A fixed
      // price is already written in the file above the comment.
      if (cell.mode === 'fixed') continue;
      if (cell.effective === null) continue;

      /**
       * A COLOUR THAT INHERITS HAS NO SINGLE ANSWER.
       *
       * buildGrid resolves an unlinked colour from the BASE price; the resolver
       * walks base → the option the customer picked → the colour. So for a
       * product with options, an inheriting colour costs whatever the chosen
       * option costs, and printing one number would name a price the cart
       * charges only when that option happens to be the base-priced one. The
       * file says what is true instead of a number that is sometimes right.
       */
      if (level === 'color' && cell.mode !== 'adjust' && optionsPriceDiffer) {
        out.set(`${prefix}.${COLUMN_OF[f]}`, `${label[f]}: يتبع الخيار الذي يختاره الزبون`);
        continue;
      }

      const value = clamp(f, cell.effective);
      if (value === null) continue;
      const source =
        cell.mode === 'adjust'
          ? `فرق ${cell.adjust !== null && cell.adjust >= 0 ? '+' : ''}${iqd(cell.adjust ?? 0)} عن ${iqd(cell.inherited ?? 0)}`
          : 'موروث';
      out.set(`${prefix}.${COLUMN_OF[f]}`, `${label[f]}: ${iqd(value)} د.ع — ${source}`);
    }
  };

  options.forEach((o, i) => note(`options.${i + 1}`, 'option', o.id));
  const colorsInOrder = [...doc.colors].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id))
  );
  colorsInOrder.forEach((c, i) => note(`colors.${i + 1}`, 'color', c.id));

  // Pre-order transports. `__NULL__` here means "use the admin default for
  // this method", and the export could never say what that default is.
  const defaults = new Map((opts.transportDefaults ?? []).map((d) => [d.method, d.commission_iqd]));
  const declaredMethods = new Set(doc.preorder_transports.map((t) => t.method));
  const transportRows = [
    ...doc.preorder_transports,
    ...(['air', 'sea', 'land'] as const)
      .filter((m) => !declaredMethods.has(m))
      .map((method) => ({ method, commission_iqd: null as number | null })),
  ];
  transportRows.forEach((t, i) => {
    if (t.commission_iqd !== null) return;
    const def = defaults.get(t.method);
    out.set(
      `transports.${i + 1}.commission_iqd`,
      def === null || def === undefined
        ? 'الافتراضي الإداري لهذه الطريقة غير مضبوط — لا تُضاف عمولة نقل'
        : `العمولة الفعلية ${iqd(def)} د.ع — الافتراضي الإداري لهذه الطريقة`
    );
  });
  return out;
}

/**
 * Deterministic full export of a product document (all languages).
 *
 * WRITTEN IN THE OWNER'S FORM. The base price is the cheapest sellable item and
 * every option and colour is an increase over it (cheapestBase.ts). A product
 * stored with fixed option prices is re-expressed on the way out — the numbers
 * the customer pays are identical, only the way they are written changes — and
 * the file says so beside price_iqd, because re-importing it stores it that
 * way.
 */
export function exportProduct(input: ProductDoc, opts: ExportOpts = {}): string {
  const norm = normalizeCheapestBase(input, { money: opts.includeCost !== false });
  const doc = norm.doc;
  const lines: string[] = [
    '# قالب منتج ليفونيس — الإصدار 2 / Levonis product template, version 2',
    '# الأسطر التي تبدأ بـ # تعليقات. القيم الفارغة تبقى فارغة.',
    `# ${NULL_TOKEN} = لا قيمة (وراثة). ${CLEAR_TOKEN} = مسح القيمة الحالية عند التحديث.`,
    '# الحقول المحذوفة من الملف تحافظ على قيمتها الحالية عند التحديث.',
    '# السعر الأساسي هو الأرخص؛ الخيارات والألوان والبيع المباشر وطرق الطلب المسبق زيادات فوقه.',
    `template_version=${TEMPLATE_VERSION}`,
    `product_id=${doc.id}`,
  ];
  if (doc.updated_at) lines.push(`expected_updated_at=${doc.updated_at}`);
  lines.push(`# slug ثابت — لتغييره أضف allow_slug_change=true / slug is stable; add allow_slug_change=true to change it`);
  lines.push(`slug=${doc.slug}`);

  const entries = docToEntries(doc, opts);
  const notes = opts.showEffective === false ? new Map<string, string>() : effectiveNotes(doc, opts);

  // Comments that belong beside a key whatever its value: the pricing model
  // itself at price_iqd, and what the normalizer changed or could not change.
  const extra = new Map<string, string[]>();
  const beside = (key: string, text: string) => extra.set(key, [...(extra.get(key) ?? []), text]);
  beside(
    'price_iqd',
    'أرخص صنف قابل للبيع. كل خيار أو لون زيادة فوقه (regular_adjust_iqd أو +N في regular_price_iqd)؛ ' +
      'البيع المباشر زيادة (direct_surcharge_iqd) وكل طريقة طلب مسبق زيادة (transports.N.commission_iqd).'
  );
  if (norm.base_after !== norm.base_before) {
    beside(
      'price_iqd',
      `المخزّن حاليًا ${iqd(norm.base_before)} د.ع مع أسعار ثابتة؛ هذا الملف يعبّر عنها كزيادات فوق ${iqd(norm.base_after)} — ` +
        'إعادة استيراده تُخزّنها هكذا وما يدفعه الزبون لا يتغير.'
    );
  } else if (norm.changed.length > 0) {
    beside('price_iqd', 'أسعار ثابتة للخيارات/الألوان في المخزن تظهر هنا كزيادات فوق الأساسي؛ إعادة الاستيراد تُخزّنها هكذا وما يدفعه الزبون لا يتغير.');
  }
  for (const w of norm.warnings) {
    if (w.startsWith('price_iqd: ')) beside('price_iqd', w.slice('price_iqd: '.length));
  }
  // Colour notes are keyed by id: the file numbers colours in ITS order
  // (order, then id — the same sort docToEntries uses), which is not
  // necessarily the order the document listed them in.
  const colorIndex = new Map(
    [...doc.colors]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)))
      .map((c, i) => [c.id, i + 1])
  );
  for (const n of norm.colorNotes) {
    const i = colorIndex.get(n.id);
    if (i) beside(`colors.${i}.regular_price_iqd`, n.text);
  }
  let currentSection = '';
  const sectionOf = (key: string): string => {
    // `spec.<id>` is a prefix family, not an indexed group, so it needs its
    // own branch or the whole §10 sheet lands under the identity header.
    if (key.startsWith('spec.')) return 'specs';
    const gm = /^([a-z_]+)\.\d+\./.exec(key);
    if (gm) return GROUP_BY_NAME.get(gm[1])?.group ?? gm[1];
    return SCALAR_BY_KEY.get(key)?.group ?? 'identity';
  };
  for (const entry of entries) {
    const sec = sectionOf(entry.key);
    if (sec !== currentSection) {
      currentSection = sec;
      lines.push(...sectionHeader(sec));
    }
    lines.push(...fmtLines(entry.key, entry.value));
    const note = notes.get(entry.key);
    // Only annotate a field that is actually inheriting; a row that states its
    // own price does not need to be told what its own price is.
    if (note && entry.value === null) lines.push(`#   ↳ ${note}`);
    for (const x of extra.get(entry.key) ?? []) lines.push(`#   ↳ ${x}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- blank

function fieldComment(spec: FieldSpec): string {
  const bits: string[] = [spec.type];
  if (spec.required) bits.push('مطلوب/required');
  if (spec.nullable) bits.push(`nullable (${NULL_TOKEN})`);
  if (spec.lang) bits.push(`lang:${spec.lang}`);
  if (spec.enumValues) bits.push(spec.enumValues.join('|'));
  return `# ${spec.key} — ${bits.join(', ')} — ${spec.notes}`;
}

function blankValue(spec: FieldSpec): string {
  if (spec.nullable && (spec.type === 'iqd' || spec.type === 'int' || spec.type === 'percent' || spec.type === 'ref' || spec.type === 'string')) return NULL_TOKEN;
  switch (spec.type) {
    case 'bool': return spec.key === 'active' || spec.key === 'visible' || spec.key === 'primary' ? 'true' : 'false';
    case 'enum': return spec.enumValues?.[0] ?? '';
    default: return '';
  }
}

/** Blank template with every key, commented with type/required/notes. */
export function generateBlankTemplate(): string {
  // No product, so nothing to resolve: `showEffective` never applies here.

  const lines: string[] = [
    '# ============================================================',
    '# قالب منتج ليفونيس (فارغ) — الإصدار 2',
    '# Levonis product template (blank), version 2',
    '# ============================================================',
    '# القواعد / Rules:',
    '#  - كل سطر: key=value — الأسطر التي تبدأ بـ # تعليقات وتُتجاهل.',
    `#  - ${NULL_TOKEN} = لا قيمة/وراثة (explicit null). ${CLEAR_TOKEN} = مسح القيمة عند التحديث.`,
    '#  - القيمة الفارغة تبقى فارغة. الحقول المحذوفة تحافظ على قيمتها عند التحديث.',
    '#  - النص متعدد الأسطر: key=<<<END ثم الأسطر ثم END في سطر مستقل.',
    '#  - المجموعات المتكررة مفهرسة: options.1.name_ar ثم options.2.name_ar وهكذا.',
    '#  - الأسعار أعداد صحيحة بالدينار العراقي فقط (بدون فواصل).',
    '#  - السعر الأساسي (price_iqd) هو الأرخص. الخيارات والألوان زيادات فوقه: regular_adjust_iqd=60000 أو regular_price_iqd=+60000.',
    '#  - التوفر حسب المنتج: اترك options.N.availability_type فارغًا. البيع المباشر زيادة (direct_surcharge_iqd) وكل طريقة طلب مسبق زيادة (transports.N.commission_iqd).',
    '#  - سعر ثابت (regular_price_iqd=رقم بلا إشارة) ما زال مقبولًا ويُعاد التعبير عنه كزيادة فوق الأساسي عند الاستيراد دون تغيير ما يدفعه الزبون.',
    '#  - لا تختلق قيماً — إذا كانت المعلومة غير معروفة اترك الحقل فارغاً أو __NULL__.',
    '',
    `template_version=${TEMPLATE_VERSION}`,
    '# product_id: اتركه محذوفاً لإنشاء منتج جديد (يُنشأ دائماً كمسودة draft).',
    '# product_id=',
    '# expected_updated_at: اختياري — فحص التقادم عند التحديث (يُنسخ من التصدير).',
    '# slug: حر عند الإنشاء؛ عند التحديث يتطلب allow_slug_change=true.',
    'slug=',
  ];

  // A scalar whose section also owns a repeated group (the usage guide's
  // official URL with its steps, the device coverage with the warranty
  // plans) is printed INSIDE that section's block below, so the section
  // reads as one and no key is served twice — a duplicate key is a parse
  // error, and the healer would comment the second copy out.
  const groupedSections = new Set(GROUP_SPECS.map((g) => g.group));
  let current = '';
  for (const spec of SCALAR_FIELDS) {
    if (groupedSections.has(spec.group)) continue;
    if (spec.group !== current) {
      current = spec.group;
      lines.push(...sectionHeader(spec.group));
    }
    lines.push(fieldComment(spec));
    lines.push(`${spec.key}=${blankValue(spec)}`);
  }

  for (const g of GROUP_SPECS) {
    lines.push(...sectionHeader(g.group));
    for (const spec of SCALAR_FIELDS) {
      if (spec.group !== g.group) continue;
      lines.push(fieldComment(spec));
      lines.push(`${spec.key}=${blankValue(spec)}`);
    }
    lines.push(`# مجموعة متكررة "${g.name}" — كرر بـ ${g.name}.2.… ${g.name}.3.…`);
    lines.push(`# لحذف كل العناصر عند التحديث: ${g.name}=${CLEAR_TOKEN}`);
    for (const spec of g.fields) {
      if (spec.exported === false) {
        lines.push(fieldComment(spec));
        lines.push(`# ${g.name}.1.${spec.key}=`);
        continue;
      }
      lines.push(fieldComment(spec));
      lines.push(`${g.name}.1.${spec.key}=${blankValue(spec)}`);
    }
    if (g.rowFields) {
      lines.push(`# أسطر المواصفات داخل المجموعة: ${g.name}.1.rows.1.… ${g.name}.1.rows.2.…`);
      for (const spec of g.rowFields) {
        lines.push(fieldComment(spec));
        lines.push(`${g.name}.1.rows.1.${spec.key}=${blankValue(spec)}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Does this file WRITE the option or colour rows? Only then may the apply
 * re-express the product's prices (cheapestBase.ts): the rewrite moves the
 * base AND rewrites the rows relative to it, and a file that carries no rows
 * leaves the stored rows untouched — lowering the base alone would change
 * what every inheriting option sells for. The same test the apply route uses
 * to decide whether the relational writer runs.
 */
export function touchesPricingStructure(parsed: ParsedTemplate): boolean {
  return (['options', 'colors'] as const).some(
    (g) => (parsed.groups[g]?.length ?? 0) > 0 || !!parsed.groupClears[g]
  );
}

// ---------------------------------------------------------------- to doc body

export interface NeedsReviewEntry { key: string; line: number; value: string; message: string }

/** Scalar keys the ROUTE resolves against a table before the body is built. */
const REF_KEYS = new Set(['brand', 'catalogs', 'category', 'sub_category']);

export interface ResolvedRefs {
  /** resolved brand id; null = clear brand; undefined = omitted/unresolved (preserve) */
  brand_id?: string | null;
  /** resolved catalog ids; undefined = omitted/unresolved (preserve associations) */
  catalog_ids?: string[];
  /** resolved main-section id; null = clear; undefined = omitted/unresolved */
  category_id?: string | null;
  /** resolved sub-section id; null = clear; undefined = omitted/unresolved */
  sub_category_id?: string | null;
  needs_review?: NeedsReviewEntry[];
}

export interface ToDocResult {
  body: Record<string, unknown>;
  /** The file's `inventory_mode` line: a mode, '' = derive like the form,
   *  undefined = the line was absent (preserve the stored mode). Not a
   *  document field — the relations writer owns the column. */
  inventory_mode?: string;
  applied_fields: string[];
  cleared_fields: string[];
  preserved_fields: string[];
  needs_review: NeedsReviewEntry[];
  warnings: string[];
}

type LooseItem = Record<string, unknown>;

/**
 * Applies every field the file carries for one item, in registry order —
 * except that a SIGNED price (`regular_price_iqd=+60000`) is applied last.
 *
 * An export writes every `*_adjust_iqd=__NULL__` line below its price line.
 * An owner who edits the price line to `+60000` and leaves the rest alone
 * must not have that edit silently undone by the untouched `__NULL__` line
 * beneath it — the sign is the more deliberate statement, so it wins.
 */
function applyItemFields(target: LooseItem, specs: FieldSpec[], fields: Record<string, ParsedField>): void {
  const signed: Array<[FieldSpec, ParsedField]> = [];
  for (const spec of specs) {
    const pf = fields[spec.key];
    if (!pf) continue;
    if (pf.adjust && spec.adjustKey) signed.push([spec, pf]);
    else applyItemField(target, spec, pf);
  }
  for (const [spec, pf] of signed) applyItemField(target, spec, pf);
}

function applyItemField(target: LooseItem, spec: FieldSpec, pf: ParsedField): void {
  const key = spec.aliasOf ?? spec.key;
  if (pf.adjust && spec.adjustKey) {
    // `regular_price_iqd=+60000`: this row FOLLOWS the level beneath by that
    // much. The price itself is cleared so the adjustment is what resolves.
    target[key] = null;
    target[spec.adjustKey] = pf.value;
    return;
  }
  if (pf.clear) {
    if (spec.type === 'iqd' || spec.type === 'int') target[key] = null;
    else if (spec.type === 'csv' || spec.type === 'urls') target[key] = [];
    else target[key] = '';
    return;
  }
  target[key] = pf.value;
}

function buildGroupItems(
  g: GroupSpec,
  templateItems: ParsedGroupItem[],
  existingItems: LooseItem[],
  result: ToDocResult
): LooseItem[] {
  const mk = g.mergeKey;
  const allHaveIds = templateItems.every(
    (it) => typeof it.fields[mk]?.value === 'string' && (it.fields[mk].value as string).trim() !== ''
  );

  const buildFresh = (it: ParsedGroupItem, orderIndex: number): LooseItem => {
    const item: LooseItem = { order: orderIndex };
    applyItemFields(item, g.fields, it.fields);
    if (g.idPrefix && (typeof item.id !== 'string' || !item.id)) item.id = newId(g.idPrefix);
    // requiredness of subfields — never silently drop an item
    for (const spec of g.fields) {
      const sibling = spec.requiredUnless ? item[spec.requiredUnless] : undefined;
      if (spec.requiredUnless && typeof sibling === 'string' && sibling.trim() !== '') continue;
      if (spec.required && spec.type !== 'iqd' && spec.type !== 'int') {
        const v = item[spec.key];
        if (v === undefined || v === null || v === '') {
          result.needs_review.push({
            key: `${g.name}.${it.index}.${spec.key}`, line: it.line, value: '',
            message: `${spec.key} is required for every ${g.name} item`,
          });
        }
      } else if (spec.required && item[spec.key] === undefined) {
        result.needs_review.push({
          key: `${g.name}.${it.index}.${spec.key}`, line: it.line, value: '',
          message: `${spec.key} is required for every ${g.name} item`,
        });
      }
    }
    if (g.rowFields) item.rows = buildRows(g, it, null, result);
    return item;
  };

  if (existingItems.length > 0 && templateItems.length > 0 && allHaveIds) {
    // MERGE BY ID (transports merge by method): mentioned items are updated
    // field-by-field (omitted subfields preserved); new ids are appended;
    // unmentioned existing items are KEPT (use replace-all or
    // <group>=__CLEAR__ to remove them).
    const byId = new Map(existingItems.map((x) => [String(x[mk]), x]));
    const mentioned = new Set<string>();
    const merged: LooseItem[] = [];
    templateItems.forEach((it, orderIndex) => {
      const id = String(it.fields[mk]!.value).trim();
      mentioned.add(id);
      const base = byId.get(id);
      if (base) {
        const item: LooseItem = { ...base, order: orderIndex };
        applyItemFields(item, g.fields, it.fields);
        if (g.rowFields) item.rows = buildRows(g, it, (base.rows as LooseItem[]) ?? [], result);
        merged.push(item);
      } else {
        merged.push(buildFresh(it, orderIndex));
      }
    });
    let tail = templateItems.length;
    for (const ex of existingItems) {
      if (!mentioned.has(String(ex[mk]))) merged.push({ ...ex, order: tail++ });
    }
    return merged;
  }

  // REPLACE ALL (no existing items, or some template items lack a merge key).
  if (existingItems.length > 0) {
    result.warnings.push(
      `${g.name}: replaced all ${existingItems.length} existing item(s) because not every template item carries ${g.mergeKey === 'id' ? 'an id' : `a ${g.mergeKey}`} — add ${g.mergeKey}s to merge instead`
    );
  }
  return templateItems.map((it, i) => buildFresh(it, i));
}

function buildRows(
  g: GroupSpec,
  templateItem: ParsedGroupItem,
  existingRows: LooseItem[] | null,
  result: ToDocResult
): LooseItem[] {
  const rowSpecs = g.rowFields!;
  const tRows = templateItem.rows ?? [];
  if (tRows.length === 0) return existingRows ?? [];

  const buildFreshRow = (r: ParsedGroupItem, orderIndex: number): LooseItem => {
    const row: LooseItem = { order: orderIndex };
    for (const spec of rowSpecs) {
      const pf = r.fields[spec.key];
      if (pf) applyItemField(row, spec, pf);
    }
    if (typeof row.id !== 'string' || !row.id) row.id = newId('sr');
    for (const spec of rowSpecs) {
      if (spec.required && (row[spec.key] === undefined || row[spec.key] === '')) {
        result.needs_review.push({
          key: `${g.name}.${templateItem.index}.rows.${r.index}.${spec.key}`, line: r.line, value: '',
          message: `${spec.key} is required for every specification row`,
        });
      }
    }
    return row;
  };

  const allRowIds = tRows.every((r) => typeof r.fields.id?.value === 'string' && (r.fields.id.value as string).trim() !== '');
  if (existingRows && existingRows.length > 0 && allRowIds) {
    const byId = new Map(existingRows.map((x) => [String(x.id), x]));
    const mentioned = new Set<string>();
    const merged: LooseItem[] = [];
    tRows.forEach((r, orderIndex) => {
      const id = String(r.fields.id!.value).trim();
      mentioned.add(id);
      const base = byId.get(id);
      if (base) {
        const row: LooseItem = { ...base, order: orderIndex };
        for (const spec of rowSpecs) {
          const pf = r.fields[spec.key];
          if (pf) applyItemField(row, spec, pf);
        }
        merged.push(row);
      } else {
        merged.push(buildFreshRow(r, orderIndex));
      }
    });
    let tail = tRows.length;
    for (const ex of existingRows) {
      if (!mentioned.has(String(ex.id))) merged.push({ ...ex, order: tail++ });
    }
    return merged;
  }
  if (existingRows && existingRows.length > 0) {
    result.warnings.push(
      `${g.name}.${templateItem.index}.rows: replaced all existing rows because not every template row carries an id`
    );
  }
  return tRows.map((r, i) => buildFreshRow(r, i));
}

/**
 * Merges a parsed template onto an existing doc (or builds a create body).
 * - omitted fields PRESERVE existing values (recorded in preserved_fields)
 * - __CLEAR__ empties a field (cleared_fields)
 * - repeatable groups merge BY ID when every item has one, otherwise the
 *   whole group is replaced (with a warning)
 * - brand/catalogs need DB resolution: pass `resolved` from the route; an
 *   unresolved reference lands in needs_review — never silently applied.
 * The returned body still goes through validateProductDoc — this function
 * performs merging, not final validation.
 */
export function toDocBody(
  parsed: ParsedTemplate,
  existing?: ProductDoc | null,
  resolved?: ResolvedRefs
): ToDocResult {
  const result: ToDocResult = {
    body: {},
    applied_fields: [],
    cleared_fields: [],
    preserved_fields: [],
    needs_review: [...(resolved?.needs_review ?? [])],
    warnings: [...parsed.warnings],
  };
  const body: Record<string, unknown> = existing
    ? {
        id: existing.id,
        slug: existing.slug,
        status: existing.status,
        content_rev: existing.content_rev,
        name_ar: existing.name_ar, name_en: existing.name_en, name_ckb: existing.name_ckb,
        description_ar: existing.description_ar, description_en: existing.description_en, description_ckb: existing.description_ckb,
        how_to_use: existing.how_to_use,
        price_iqd: existing.price_iqd,
        pro_price_iqd: existing.pro_price_iqd,
        prime_price_iqd: existing.prime_price_iqd,
        product_cost_iqd: existing.product_cost_iqd,
        selling_type: existing.selling_type,
        // Fields the TXT registry has no keys for are CARRIED, not rebuilt —
        // otherwise every template update silently wiped them (multi sale
        // types collapsed to the scalar, spec fields and the section
        // placement vanished, and the newer direct premium / usage guide
        // would have been erased the day they were written).
        sale_types: existing.sale_types,
        // The eight below are the STARTING values. Six of them now have
        // template keys (category, sub_category, template_family, sku,
        // low_stock_threshold, direct_surcharge_iqd) and the scalar loop
        // overwrites those the file actually carries — carrying them here is
        // what makes an omitted key mean "preserve" rather than "erase".
        // Wiring original_price_iqd end to end made it a column the apply
        // WRITES on every request; without carrying it, a file that omits the
        // key set the compare-at price to null while reporting it preserved.
        original_price_iqd: existing.original_price_iqd,
        direct_surcharge_iqd: existing.direct_surcharge_iqd,
        stock: existing.stock,
        low_stock_threshold: existing.low_stock_threshold,
        category_id: existing.category_id,
        sub_category_id: existing.sub_category_id,
        template_family: existing.template_family,
        sku: existing.sku,
        spec_fields: existing.spec_fields,
        usage_guide: existing.usage_guide,
        brand_id: existing.brand_id,
        is_featured: existing.is_featured,
        display_order: existing.display_order,
        payment_options: existing.payment_options,
        hashtags: existing.hashtags,
        media: existing.media,
        options: existing.options,
        colors: existing.colors,
        spec_groups: existing.spec_groups,
        labels: existing.labels,
        warranty_plans: existing.warranty_plans,
        // The device coverage the product already states, and the REST of its
        // ops_policy (size_class, …) — carried so a file that says nothing
        // about them changes nothing, exactly like every other omitted key.
        warranty_base_months: existing.warranty_base_months,
        serialized: existing.serialized,
        ops_policy: existing.ops_policy,
        preorder_transports: existing.preorder_transports,
        content_blocks: existing.content_blocks,
        translation_meta: existing.translation_meta,
      }
    : {};
  result.body = body;

  // ---- slug (protected: update requires allow_slug_change=true)
  const slugField = parsed.fields.slug;
  if (slugField && typeof slugField.value === 'string' && slugField.value.trim() !== '') {
    if (!existing) {
      body.slug = slugField.value.trim();
      result.applied_fields.push('slug');
    } else if (parsed.header.allow_slug_change) {
      body.slug = slugField.value.trim();
      result.applied_fields.push('slug');
    } else if (slugField.value.trim() !== existing.slug) {
      result.preserved_fields.push('slug');
      result.warnings.push('slug: changing the slug requires allow_slug_change=true — the existing slug was kept');
    }
  }

  // ---- scalar fields
  for (const spec of SCALAR_FIELDS) {
    const pf = parsed.fields[spec.key];
    if (!pf) {
      if (existing && !REF_KEYS.has(spec.key)) result.preserved_fields.push(spec.key);
      continue;
    }
    if (REF_KEYS.has(spec.key)) continue; // handled below via resolved refs
    if (pf.clear) {
      result.cleared_fields.push(spec.key);
    } else {
      result.applied_fields.push(spec.key);
    }
    switch (spec.key) {
      case 'payment_options':
      case 'hashtags':
        body[spec.key] = pf.value ?? [];
        break;
      case 'template_family':
        // The enum allows '' for "no family"; the column holds NULL for that.
        body.template_family = pf.value ? pf.value : null;
        break;
      case 'inventory_mode':
        result.inventory_mode = typeof pf.value === 'string' ? pf.value : '';
        break;
      case 'usage_official_url':
        // Nested in usage_guide; the steps beside it are a group (below).
        body.usage_guide = { ...guideOf(body), official_url: typeof pf.value === 'string' ? pf.value : '' };
        break;
      default:
        body[spec.key] = pf.value;
    }
  }

  // ---- §10 spec sheet -----------------------------------------------------
  // Merged onto what the product already has, so a file that carries three
  // specs edits three and leaves the other forty alone — the same "an omitted
  // key preserves" rule every other field follows. __CLEAR__ removes one.
  const specKeys = Object.keys(parsed.specFields);
  if (specKeys.length > 0) {
    const merged: Record<string, string> = { ...(existing?.spec_fields ?? {}) };
    for (const id of specKeys) {
      const pf = parsed.specFields[id];
      if (pf.clear || pf.value === null || pf.value === '') {
        delete merged[id];
        result.cleared_fields.push(`spec.${id}`);
      } else {
        merged[id] = String(pf.value);
        result.applied_fields.push(`spec.${id}`);
      }
    }
    body.spec_fields = merged;
  }

  // ---- brand / catalogs via resolved refs
  const brandField = parsed.fields.brand;
  if (brandField) {
    if (resolved && resolved.brand_id !== undefined) {
      body.brand_id = resolved.brand_id;
      result.applied_fields.push('brand');
    } else if (!result.needs_review.some((n) => n.key === 'brand')) {
      result.needs_review.push({
        key: 'brand', line: brandField.line, value: String(brandField.value ?? NULL_TOKEN),
        message: 'brand reference was not resolved against the brands table',
      });
    }
  } else if (existing) {
    result.preserved_fields.push('brand');
  }
  for (const [key, target] of [
    ['category', 'category_id'],
    ['sub_category', 'sub_category_id'],
  ] as const) {
    const field = parsed.fields[key];
    if (!field) {
      if (existing) result.preserved_fields.push(key);
      continue;
    }
    // Clearing a reference needs no table lookup: `__NULL__` means "no
    // section" whatever the sections tree contains, so an offline caller
    // (and the blank template, which ships every ref as __NULL__) must not be
    // sent to review for it.
    if (field.clear || field.value === null || String(field.value).trim() === '') {
      body[target] = null;
      result.cleared_fields.push(key);
      continue;
    }
    const resolvedId = resolved ? resolved[target] : undefined;
    if (resolvedId !== undefined) {
      body[target] = resolvedId;
      result.applied_fields.push(key);
    } else if (!result.needs_review.some((n) => n.key === key)) {
      result.needs_review.push({
        key, line: field.line, value: String(field.value ?? NULL_TOKEN),
        message: `${key} reference was not resolved against the sections tree`,
      });
    }
  }
  const catalogsField = parsed.fields.catalogs;
  if (catalogsField) {
    if (resolved && resolved.catalog_ids !== undefined) {
      result.applied_fields.push('catalogs'); // associations written by the route
    } else if (!result.needs_review.some((n) => n.key === 'catalogs')) {
      result.needs_review.push({
        key: 'catalogs', line: catalogsField.line,
        value: Array.isArray(catalogsField.value) ? (catalogsField.value as string[]).join(',') : String(catalogsField.value ?? NULL_TOKEN),
        message: 'catalog references were not resolved against the catalogs table',
      });
    }
  } else if (existing) {
    result.preserved_fields.push('catalogs');
  }

  // ---- repeatable groups (options first so colors.option_index can resolve)
  const orderedGroups = [...GROUP_SPECS].sort((a, b) => (a.name === 'options' ? -1 : b.name === 'options' ? 1 : 0));
  const optionIndexToId = new Map<number, string>();

  for (const g of orderedGroups) {
    const clear = parsed.groupClears[g.name];
    const templateItems = parsed.groups[g.name] ?? [];
    // The usage steps live inside usage_guide, not at the top of the body.
    const nested = g.name === 'usage_steps';
    const writeItems = (items: LooseItem[]) => {
      if (nested) body.usage_guide = { ...guideOf(body), steps: items };
      else body[g.bodyKey] = items;
    };
    if (clear) {
      writeItems([]);
      result.cleared_fields.push(g.name);
      if (templateItems.length > 0) {
        result.warnings.push(`${g.name}: both ${g.name}=${CLEAR_TOKEN} and indexed items were given — the group was cleared, items ignored`);
      }
      continue;
    }
    if (templateItems.length === 0) {
      if (existing) result.preserved_fields.push(g.name);
      continue;
    }
    const existingItems = existing ? (nested ? guideOf(body).steps : ((body[g.bodyKey] as LooseItem[]) ?? [])) : [];
    const items = buildGroupItems(g, templateItems, existingItems, result);
    if (g.name === 'options') {
      templateItems.forEach((it, i) => {
        const built = items[i];
        if (built && typeof built.id === 'string') optionIndexToId.set(it.index, built.id);
      });
    }
    if (g.name === 'colors') {
      // `option_ids` is the full link set and wins over the single-link
      // `option_id` — the store's own export writes both, with `__NULL__` in
      // the single slot whenever the set has more than one entry. A single
      // link that names an option the set does NOT contain is a genuine
      // contradiction, and it is reported rather than resolved silently.
      templateItems.forEach((it) => {
        const single = it.fields.option_id;
        const list = it.fields.option_ids;
        const listed = Array.isArray(list?.value) ? (list!.value as string[]) : [];
        const named = typeof single?.value === 'string' ? single.value.trim() : '';
        if (named && listed.length > 0 && !listed.includes(named)) {
          result.needs_review.push({
            key: `colors.${it.index}.option_id`, line: single!.line, value: named,
            message: `conflicting link keys: option_id=${named} is not in option_ids=${listed.join(',')} — keep one, or list it`,
          });
        }
      });
      // Resolve import-only option_index references onto option ids.
      templateItems.forEach((it, i) => {
        const pf = it.fields.option_index;
        if (!pf || pf.value === null) return;
        const idx = pf.value as number;
        const target = items[i] as LooseItem | undefined;
        if (!target) return;
        const optId = optionIndexToId.get(idx);
        if (optId) {
          target.option_id = optId;
        } else {
          result.needs_review.push({
            key: `colors.${it.index}.option_index`, line: pf.line, value: String(idx),
            message: `option_index=${idx} does not match any options.${idx}.* item in this template`,
          });
        }
        delete target.option_index;
      });
    }
    if (nested) {
      // upgradeUsageGuide keeps a step only when it has a title or a body;
      // one that has neither would vanish without a word.
      templateItems.forEach((it, i) => {
        const built = items[i];
        const has = (k: string) => typeof built?.[k] === 'string' && (built[k] as string).trim() !== '';
        if (built && !has('title') && !has('body')) {
          result.warnings.push(`usage_steps.${it.index}: الخطوة بلا عنوان ولا شرح فلن تُحفَظ — أضف title أو body`);
        }
      });
    }
    writeItems(items);
    result.applied_fields.push(g.name);
  }

  return result;
}

/** The usage guide carried on a body, in the shape the merge writes back. */
function guideOf(body: Record<string, unknown>): { official_url: string; steps: LooseItem[] } {
  const g = body.usage_guide as { official_url?: unknown; steps?: unknown } | undefined;
  return {
    official_url: typeof g?.official_url === 'string' ? g.official_url : '',
    steps: Array.isArray(g?.steps) ? (g.steps as LooseItem[]) : [],
  };
}

// ---------------------------------------------------------------- translation bookkeeping

/**
 * Deterministic translation bookkeeping for template imports (NO AI):
 * bumps content_rev when the Arabic source text changed and records
 * imported/missing status for the en/ckb name and description fields.
 * Existing meta for unchanged values is preserved.
 */
export function translationBookkeeping(
  body: Record<string, unknown>,
  existing: ProductDoc | null
): { content_rev: number; translation_meta: TranslationMeta } {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const arChanged =
    !existing ||
    str(body.name_ar) !== existing.name_ar ||
    str(body.description_ar) !== existing.description_ar;
  const contentRev = existing ? (arChanged ? existing.content_rev + 1 : existing.content_rev) : 1;

  const meta: TranslationMeta = { ...(existing?.translation_meta ?? {}) };
  const track = (field: 'name' | 'description') => {
    const entry: TranslationMeta[string] = { ...(meta[field] ?? {}) };
    for (const lang of ['en', 'ckb'] as const) {
      const bodyKey = `${field}_${lang}`;
      const value = str(body[bodyKey]);
      const existingValue = existing ? str((existing as unknown as Record<string, unknown>)[bodyKey]) : '';
      if (value === '') {
        entry[lang] = { status: 'missing', src_rev: contentRev };
      } else if (existing && value === existingValue && entry[lang] && !arChanged) {
        // unchanged translation of unchanged source — keep prior status
      } else if (existing && value === existingValue && entry[lang] && arChanged) {
        entry[lang] = { status: 'stale', src_rev: entry[lang]!.src_rev };
      } else {
        entry[lang] = { status: 'imported', src_rev: contentRev };
      }
    }
    meta[field] = entry;
  };
  track('name');
  track('description');

  /**
   * WHAT THE FILE WROTE IN ARABIC OR KURDISH WAS WRITTEN BY A PERSON. The
   * template path never machine-translates, so every ar/ckb text that lands
   * through it is authored — and the form's localiser must not regenerate it
   * on the next save (docs/TXT_IMPORT_PARITY.md, root cause 10). The mark is
   * `approved`: the one status the form's tracking already keeps while the
   * English source is unchanged, and the one its localiser now restores. A
   * text identical to what is stored keeps whatever status it had, so an
   * untouched re-import of a form-built product does not freeze machine copy.
   */
  const existingSlots = new Map(
    existing ? localizableSlots(existing as unknown as Record<string, unknown>).map((s) => [s.key, s]) : []
  );
  for (const slot of localizableSlots(body)) {
    const before = existingSlots.get(slot.key);
    for (const lang of ['ar', 'ckb'] as const) {
      const text = slot[lang];
      if (!text.trim()) {
        /**
         * AN EMPTY FIELD IS A STATED ABSENCE, NOT A GAP TO FILL. The file
         * carries every slot it knows about; leaving one blank is the author
         * saying "there is no Kurdish for this row". Without a mark, the first
         * form save ran the localiser over it and invented one — `title_ckb`
         * '' became 'Group', `body_ckb` '' became the English body — so the
         * same document did not survive TXT create → form save unchanged
         * (docs/TXT_IMPORT_PARITY.md). `missing` is the honest status, and
         * `localizeRespectingAuthored` keeps it empty while the English source
         * is unchanged.
         */
        if (slot.en.trim()) {
          meta[slot.key] = { ...(meta[slot.key] ?? {}), [lang]: { status: 'missing', src_rev: contentRev } };
        }
        continue;
      }
      const unchanged = !!before && before[lang] === text && before.en === slot.en;
      const prior = meta[slot.key]?.[lang];
      if (unchanged && prior && prior.status !== 'approved') continue;
      meta[slot.key] = { ...(meta[slot.key] ?? {}), [lang]: { status: 'approved', src_rev: contentRev } };
    }
  }
  return { content_rev: contentRev, translation_meta: meta };
}

// ---------------------------------------------------------------- slug helper

/** Same derivation as the v1 admin editor: latin/arabic word chars, dashes. */
export function deriveSlug(nameOrSlug: string): string {
  return nameOrSlug
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
