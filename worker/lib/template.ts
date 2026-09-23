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
import { splitUrlList } from './urlList';
import { buildGrid, COLUMN_OF, FIELDS, type Field } from './priceGrid';
import { isOwnedMediaUrl } from './mediaStorage';
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

/**
 * 0075 — THE SENTENCE A `capacity` TYPED IN THE WRONG PLACE EARNS.
 *
 * Arabic first, then English, like every other refusal in this file. It names
 * BOTH keys that carry a pre-order number — the shared pool and one route's
 * own quota — and the key that carries the direct-sale number, because the
 * whole reason the mistake is made is that the admin does not know which of
 * the three they want. See `parseTemplate`'s `ignoreKey`.
 */
export const MISPLACED_CAPACITY =
  'المخزون للبيع المباشر فقط ويكتب في options.N.stock أو في توليفة الخيار واللون؛ الطلب المسبق متوفر أو غير متوفر بلا مخزون. / ' +
  'Stock belongs to direct sale only (options.N.stock or an option-colour combination); pre-order is enabled/disabled with no stock.';

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
  /** For measurements, __NULL__ is an explicit clear rather than an
   *  inheriting value. This keeps omitted=preserve and NULL=clear distinct. */
  nullClears?: boolean;
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
  /**
   * 0075 — A CELL FIELD THAT IS REALLY THE MODEL'S COLUMN.
   *
   * «استخدم مصدر مخزون واحد لكل اختيار فعلي» — one stock source per actual
   * selection. Direct-sale availability is ALREADY the row
   * `products.inventory_mode` selects, so `options.N.direct.stock` is not a
   * second number: it is a DOCUMENTED ALIAS onto `options.N.stock`, applied
   * to the parent item rather than to the cell, exactly as `aliasOf` routes a
   * value to another key of the same item. Both spellings therefore reach the
   * one column `product_option_values.stock`.
   *
   * Only the canonical spelling is EXPORTED (`exported: false` here), because
   * writing both would make an export state one number twice and a round trip
   * write it twice.
   */
  onModel?: boolean;
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
  /**
   * 0073. NAMED SUB-OBJECTS under one item, each optionally holding its own
   * indexed list — `options.N.direct.<field>`, `options.N.preorder.<field>`
   * and `options.N.preorder.transports.M.<field>`.
   *
   * A third level of nesting exists ONLY here, and only because the thing
   * being described genuinely has three: a model, its order types, and the
   * routes of one of them. Flattening it into a fourth top-level group would
   * mean repeating the model id on every line and letting a route drift away
   * from the order type it belongs to.
   */
  cellFields?: Record<string, CellSpec>;
}

export interface CellSpec {
  titleAr: string;
  titleEn: string;
  fields: FieldSpec[];
  /** The indexed list inside this cell, if it has one. */
  list?: { name: string; fields: FieldSpec[]; notes?: string[] };
  /**
   * 0075 — SUBKEYS THIS CELL REFUSES BY NAME, with the sentence that says what
   * to write instead (Arabic first, then English).
   *
   * An unknown subkey is a WARNING and is dropped, which is right for a key
   * the format never had — but wrong for `options.N.direct.capacity`, which an
   * admin writes on purpose after reading about the pre-order pool. Dropping
   * it silently would let somebody type 50 into a file and believe they had
   * limited a direct sale, when the direct number is the model's stock. So it
   * is an ERROR, raised in the PREVIEW, before anything is written.
   */
  refused?: Record<string, string>;
  /** Prose the blank template prints above this cell's keys. */
  notes?: string[];
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
const DIMENSION_MAX = 100_000_000;
const DIMENSION_KEYS = [
  'net_weight_g',
  'width_mm',
  'depth_mm',
  'height_mm',
  'package_weight_g',
  'package_width_mm',
  'package_depth_mm',
  'package_height_mm',
] as const;

type DimensionKey = (typeof DIMENSION_KEYS)[number];
const DIMENSION_KEY_SET = new Set<string>(DIMENSION_KEYS);

/** Measurements use the same eight names at product, option, colour and
 * exact-combination level. They are always positive whole grams/mm; omission
 * preserves and __NULL__ explicitly clears the override. */
function dimensionFields(group: string): FieldSpec[] {
  const notes: Record<DimensionKey, string> = {
    net_weight_g: 'وزن المنتج نفسه بالغرام — grams, whole integer > 0',
    width_mm: 'عرض المنتج بالمليمتر — millimetres, whole integer > 0',
    depth_mm: 'عمق المنتج بالمليمتر — millimetres, whole integer > 0',
    height_mm: 'ارتفاع المنتج بالمليمتر — millimetres, whole integer > 0',
    package_weight_g: 'وزن الصندوق مع المنتج بالغرام — shipping weight, whole grams > 0',
    package_width_mm: 'عرض صندوق الشحن بالمليمتر — whole millimetres > 0',
    package_depth_mm: 'عمق صندوق الشحن بالمليمتر — whole millimetres > 0',
    package_height_mm: 'ارتفاع صندوق الشحن بالمليمتر — whole millimetres > 0',
  };
  return DIMENSION_KEYS.map((key) =>
    f(key, 'int', group, `${notes[key]}؛ ${NULL_TOKEN} = clear this measurement`, {
      nullable: true,
      nullClears: true,
      min: 1,
      max: DIMENSION_MAX,
    })
  );
}

/** The canonical editor groups (Arabic-first labels used in exports). */
export const TEMPLATE_GROUPS: Array<{ id: string; titleAr: string; titleEn: string }> = [
  { id: 'identity',        titleAr: 'الهوية',                titleEn: 'Identity' },
  { id: 'description',     titleAr: 'الوصف',                 titleEn: 'Description' },
  { id: 'pricing',         titleAr: 'التسعير',               titleEn: 'Pricing' },
  { id: 'classification',  titleAr: 'التصنيف',               titleEn: 'Classification' },
  { id: 'selling',         titleAr: 'البيع والمخزون',        titleEn: 'Selling & stock' },
  { id: 'delivery',        titleAr: 'خيارات التوصيل',        titleEn: 'Delivery options' },
  { id: 'transports',      titleAr: 'شحن الطلب المسبق',      titleEn: 'Pre-order transports' },
  { id: 'media',           titleAr: 'الوسائط',               titleEn: 'Media' },
  { id: 'options',         titleAr: 'الخيارات',              titleEn: 'Options' },
  { id: 'colors',          titleAr: 'الألوان',               titleEn: 'Colors' },
  { id: 'specs',           titleAr: 'المواصفات',             titleEn: 'Specifications' },
  { id: 'labels',          titleAr: 'الشارات',               titleEn: 'Labels' },
  { id: 'warranty',        titleAr: 'خطط الضمان',            titleEn: 'Warranty plans' },
  { id: 'condition',       titleAr: 'الحالة (Open Box/مستعمل)', titleEn: 'Condition (Open Box/Used)' },
  { id: 'dimensions',      titleAr: 'الأبعاد والوزن',        titleEn: 'Dimensions & weight' },
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
  // The spelling every file written before 0079 uses. Import-only: exporting
  // both would state one column twice and a round trip would write it twice.
  // Routed to `how_to_use` by name in toDocBody — `aliasOf` is honoured for
  // repeated-group items only, never for scalars. FIRST in the list so that a
  // file carrying both spellings lands on the newer one: the scalar loop
  // follows registry order and the last writer wins.
  f('how_to_use', 'text', 'description', 'التهجئة القديمة لـ how_to_use_en — import-only synonym, never exported', { exported: false }),
  f('how_to_use_ar', 'text', 'description', 'طريقة الاستخدام بالعربية — Arabic usage instructions (multiline allowed via heredoc). فارغ = لا نص عربي، وتُقرأ الإنجليزية.', { lang: 'ar' }),
  f('how_to_use_en', 'text', 'description', 'طريقة الاستخدام بالإنجليزية (المصدر) — English usage instructions; this is the column `how_to_use`', { lang: 'en' }),
  f('how_to_use_ckb', 'text', 'description', 'چۆنیەتی بەکارهێنان بە کوردی — Kurdish usage instructions. فارغ = لا نص كردي، وتُقرأ الإنجليزية.', { lang: 'ckb' }),
  // pricing — IQD integers; null = inherit/none, 0 = explicit zero
  f('price_iqd', 'iqd', 'pricing', 'السعر الأساسي بالدينار = أرخص صنف قابل للبيع؛ كل خيار أو لون أو طريقة توفر زيادة فوقه — base price = the CHEAPEST sellable item, REQUIRED integer', { required: true, min: 0, max: IQD_MAX }),
  f('pro_price_iqd', 'iqd', 'pricing', 'سعر PRO الصريح — explicit PRO price; __NULL__ = no explicit price (store policy applies, default: no discount)', { nullable: true, min: 0, max: IQD_MAX }),
  f('prime_price_iqd', 'iqd', 'pricing', 'سعر PRIME الصريح — explicit PRIME price; __NULL__ = none (regular applies)', { nullable: true, min: 0, max: IQD_MAX }),
  f('original_price_iqd', 'iqd', 'pricing', 'السعر قبل الخصم — compare-at price; shown only when above the selling price; __NULL__ = none', { nullable: true, min: 0, max: IQD_MAX }),
  f('product_cost_iqd', 'iqd', 'pricing', 'الكلفة (داخلي) — internal cost, NEVER exposed publicly; __NULL__ = unknown', { nullable: true, min: 0, max: IQD_MAX }),
  // classification
  f('brand', 'ref', 'classification', 'العلامة التجارية — brand slug, id or name (ar/en/ckb), resolved against the brands table; a brand that does not exist yet is created and the check step says so first; __NULL__ = no brand', { nullable: true }),
  f('catalogs', 'csv', 'classification', 'الكتالوجات — comma-separated catalog slugs, ids or names; unknown values need review (a section is never created); empty = in no catalog', { nullable: true }),
  // ---- EIGHT FIELDS THE FILE COULD NOT SAY --------------------------------
  // Every one of these is edited in the admin form and stored on `products`,
  // and none had a template key: worker/lib/template.ts carried them across an
  // update untouched and defaulted them to null on a create. So a product made
  // from a .txt had no section — and the owner asking the file to «يملأ جميع
  // الحقول» was asking for something structurally impossible.
  f('category', 'ref', 'classification', 'القسم الرئيسي — main section slug, id or name from the sections tree; __NULL__ = بلا قسم. مطلوب للنشر.', { nullable: true }),
  f('sub_category', 'ref', 'classification', 'القسم الفرعي — sub-section slug, id or name; __NULL__ = بلا قسم فرعي', { nullable: true }),
  f('template_family', 'enum', 'classification', 'عائلة قالب المواصفات: devices | materials | فارغ — تحدد أي حقول spec.* تخصّ هذا المنتج', { enumValues: ['', 'devices', 'materials'] as const }),
  f('sku', 'string', 'classification', 'رمز المنتج — SKU; فارغ = بلا رمز'),
  f('hashtags', 'csv', 'classification', 'وسوم — comma-separated hashtags'),
  f('is_featured', 'bool', 'classification', 'منتج مميز — featured flag (true/false)'),
  f('display_order', 'int', 'classification', 'ترتيب العرض — display order (integer, lower = earlier)', { min: -100_000, max: 100_000 }),
  // selling
  f('selling_type', 'enum', 'selling', 'direct_sale | pre_order | bundle | mixed — «mixed» كلمة إدخال تتوسّع إلى بيع مباشر + طلب مسبق معًا؛ لا تُخزَّن كما هي. والأدق أن تترك الخيارات تقرر: أنواع البيع تُشتق من availability_type لكل خيار.', { enumValues: ['direct_sale', 'pre_order', 'bundle', 'mixed'] as const }),
  // Legacy import compatibility only. Inventory now belongs to an enabled
  // direct-sale option (or its exact option×colour variant), never the product.
  f('stock', 'int', 'selling', 'قديم للاستيراد فقط — مخزون المنتج لم يعد مستخدمًا؛ ضع المخزون في options.N.stock', { nullable: true, min: 0, max: 1_000_000, exported: false }),
  f('low_stock_threshold', 'int', 'selling', 'قديم للاستيراد فقط — حد المنتج لم يعد مستخدمًا', { nullable: true, min: 0, max: 1_000_000, exported: false }),
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
  f('direct_surcharge_iqd', 'iqd', 'selling', 'قديم للاستيراد فقط — زيادة البيع المباشر تُكتب لكل خيار في options.N.direct.price_iqd', { nullable: true, min: 0, max: IQD_MAX, plusIsPlain: true, exported: false }),
  f('payment_options', 'csv', 'selling', 'معرفات طرق الدفع المسموحة — allowed checkout payment method ids, comma-separated'),
  // Product-owned last-mile delivery. All six values are folded into the
  // single canonical `delivery_options` document below; omitted lines keep a
  // legacy product on the existing global tariff.
  f('standard_delivery_enabled', 'bool', 'delivery', 'إتاحة التوصيل العادي لهذا المنتج — enable standard delivery for this product'),
  f('standard_delivery_quantity_step', 'int', 'delivery', 'عدد القطع التي يغطيها كل رسم توصيل عادي — integer >= 1', { min: 1, max: 1_000_000 }),
  f('standard_delivery_fee_iqd', 'iqd', 'delivery', 'رسم كل شريحة كمية للتوصيل العادي بالدينار — integer IQD >= 0', { min: 0, max: IQD_MAX }),
  f('personal_delivery_enabled', 'bool', 'delivery', 'إتاحة التوصيل الشخصي لهذا المنتج — enable personal delivery for this product'),
  f('personal_delivery_quantity_step', 'int', 'delivery', 'عدد القطع التي يغطيها كل رسم توصيل شخصي — integer >= 1', { min: 1, max: 1_000_000 }),
  f('personal_delivery_fee_iqd', 'iqd', 'delivery', 'رسم كل شريحة كمية للتوصيل الشخصي بالدينار — integer IQD >= 0', { min: 0, max: IQD_MAX }),
  // device coverage (stored in products.ops_policy) — the base the extended
  // warranty adds to, and whether a unit is recorded per physical device
  f('warranty_base_months', 'int', 'warranty', 'مدة الضمان الأساسي بالأشهر من التسليم — للطابعات 12 افتراضيًا (التمديد +12 → 24 إجمالًا، +24 → 36)؛ __NULL__ = غير مُعدّة', { nullable: true, min: 1, max: 240 }),
  f('serialized', 'bool', 'warranty', 'جهاز مُرقَّم — تُنشأ وحدة لكل جهاز عند التسليم ويُربط بها الضمان (الطابعات true تلقائيًا)'),
  // OPEN BOX / USED / REFURBISHED (products.condition_doc). An empty
  // `condition_kind` leaves the product NEW and every other key here is then
  // ignored, so a sheet written before the feature cannot un-grade a listing.
  f('condition_kind', 'string', 'condition', 'حالة المنتج: open_box أو used أو refurbished — فارغ = منتج جديد وتُتجاهل بقية أسطر القسم'),
  f('condition_grade', 'string', 'condition', 'درجة الحالة: like_new أو excellent أو good أو fair'),
  f('condition_usage_hours', 'int', 'condition', 'عدد ساعات التشغيل الفعلية — integer >= 0؛ فارغ = غير معروف', { nullable: true, min: 0, max: 200_000 }),
  f('condition_warranty_months', 'int', 'condition', 'ضمان ليفو بالأشهر — 1 أو 12 فقط (فارغ = 12). لا تُباع خطط تمديد على المنتج المستعمل', { nullable: true, min: 1, max: 12 }),
  f('condition_new_product_slug', 'string', 'condition', 'سلَك المنتج الجديد الذي هذه نسخة مستعملة منه — يُعرض سعره مشطوباً بجانب السعر'),
  f('condition_fault_ar', 'string', 'condition', 'العطل الذي كان في الجهاز (عربي)'),
  f('condition_fault_en', 'string', 'condition', 'The fault this unit had (English)'),
  f('condition_fault_ckb', 'string', 'condition', 'کێشەکەی ئەم ئامێرە (کوردی)'),
  f('condition_repair_ar', 'string', 'condition', 'الإصلاح الذي جرى (عربي)'),
  f('condition_repair_en', 'string', 'condition', 'The repair that was carried out (English)'),
  f('condition_repair_ckb', 'string', 'condition', 'ئەو چاککردنەوەیەی کرا (کوردی)'),
  f('condition_notes_ar', 'string', 'condition', 'ملاحظات أخرى للمشتري (عربي)'),
  f('condition_notes_en', 'string', 'condition', 'Other notes for the buyer (English)'),
  f('condition_notes_ckb', 'string', 'condition', 'تێبینی تر بۆ کڕیار (کوردی)'),
  // «الأبعاد والوزن» (migration 0098). GRAMS AND MILLIMETRES, WHOLE NUMBERS,
  // and the column names say so — the admin form shows kg and cm because that
  // is how a person measures, but a sheet is read by whoever is handed it and
  // a unit that has to be inferred is a volume out by a factor of a thousand.
  //
  // TWO SETS, and the notes insist on the difference: the product, and the box
  // it ships in. A courier charges for the second. Every one is nullable and
  // every one is empty until somebody measures it — a zero would be a claim
  // that the thing is weightless.
  ...dimensionFields('dimensions'),
  // usage guide — the steps are the `usage_steps` group below
  f('usage_official_url', 'string', 'usage', 'رابط الدليل الرسمي للمنتج (صفحة الشركة المصنّعة) — official documentation URL; فارغ = لا يوجد'),
  // «تريدها اقساط ؟» — the product's own page inside the Gini app. Here, and
  // not only in the admin form, so an owner importing a catalogue does not
  // then have to open every product to paste one link. `safeLink` in
  // productModel refuses anything that is not http(s) or a relative path, so
  // a bad value in a file is dropped rather than carried to an href.
  f('gini_url', 'string', 'usage', 'رابط المنتج في تطبيق جني (التقسيط) — this product\'s page in the Gini instalments app; فارغ = لا يوجد رابط خاص بالمنتج'),
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
      f('url', 'string', 'media', 'رابط التسليم المحلي فقط (/files/<key>) — local stored image URL; required unless fetch_url is supplied', { required: true, requiredUnless: 'fetch_url' }),
      f('fetch_url', 'string', 'media', 'رابط خارجي للاستيراد فقط — fetched, converted and stored before apply; never exported', { required: true, requiredUnless: 'url', exported: false }),
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
      f('content_type', 'string', 'media', 'نوع الملف المحفوظ — stored MIME type (for example image/webp)'),
      f('bytes', 'int', 'media', 'حجم الملف المحفوظ بالبايت — stored object size in bytes', { nullable: true, min: 1, max: 1_000_000_000 }),
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
      // Legacy import compatibility only. Product images have one source of
      // truth (`images.*`) and bind to this option with option_value_id.
      f('image', 'string', 'options', 'قديم للاستيراد فقط — converted to a bound images row; never exported', { exported: false }),
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
      f('lead_time_text', 'string', 'options', 'التهجئة القديمة لـ lead_time_text_en — import-only synonym, never exported', { exported: false }),
      f('lead_time_text_ar', 'string', 'options', 'مدة الطلب المسبق بالعربية كما تُعرض للزبون — مثال: ٣-٤ أسابيع. فارغ = تُقرأ النسخة الإنجليزية.', { lang: 'ar' }),
      f('lead_time_text_en', 'string', 'options', 'مدة الطلب المسبق بالإنجليزية (المصدر) — 3-4 weeks. النص يسبق الأرقام دائمًا.', { lang: 'en', aliasOf: 'lead_time_text' }),
      f('lead_time_text_ckb', 'string', 'options', 'ماوەی پێشوەخت بە کوردی — فارغ = تُقرأ النسخة الإنجليزية.', { lang: 'ckb' }),
      f('lead_time_min_days', 'int', 'options', 'أقل عدد أيام للطلب المسبق — للترتيب والتقدير، لا للعرض', { nullable: true, min: 0, max: 3650 }),
      f('lead_time_max_days', 'int', 'options', 'أكثر عدد أيام للطلب المسبق', { nullable: true, min: 0, max: 3650 }),
      f('variant_key', 'string', 'options', 'مفتاح النسخة — a1 / a1-combo. هو ما يجمع «A1 طلب مسبق» و«A1 بيع مباشر» تحت نسخة واحدة؛ اتركه فارغًا ليُشتق من variant_label.'),
      f('variant_label', 'string', 'options', 'اسم النسخة كما يقرؤه الزبون — A1 / A1 Combo. فارغًا يُشتق من اسم الخيار بعد حذف لاحقة نوع التوفر.'),
      f('sku_part', 'string', 'options', 'الجزء الذي يضيفه هذا الخيار إلى رمز المنتج — SKU fragment'),
      f('low_stock_threshold', 'int', 'options', 'حد التنبيه لمخزون هذا الخيار — __NULL__ = بلا تنبيه', { nullable: true, min: 0, max: 1_000_000 }),
      ...dimensionFields('options'),
    ],
    /**
     * 0073. WHAT THIS MODEL DOES — its order types, and the routes of its
     * pre-order. The model itself is the block above; these say how it sells.
     *
     *   options.1.direct.enabled=true
     *   options.1.direct.price_iqd=+50000
     *   options.1.preorder.enabled=true
     *   options.1.preorder.lead_time_text=٢١ إلى ٣٠ يوم
     *   options.1.preorder.transports.1.method=air
     *   options.1.preorder.transports.1.surcharge_iqd=80000
     *
     * A DIRECT SALE HAS NO TRANSPORTS BLOCK, and that is not an omission:
     * air/sea/land is how a unit reaches Iraq, which only a pre-order asks.
     * Delivery INSIDE Iraq is `standard_delivery_*` / `personal_delivery_*` at
     * the top of the file and never appears here.
     */
    cellFields: {
      direct: {
        titleAr: 'البيع المباشر لهذا الموديل', titleEn: 'Direct sale for this model',
        notes: [
          'مخزون البيع المباشر هو مخزون الموديل نفسه — مصدر واحد لكل اختيار فعلي.',
          'ضع رقمًا صحيحًا في options.N.stock: الصفر = منتهي، ولا يُسمح بمخزون غير محدود.',
          'إذا رُبط الخيار بألوان فمخزون كل توليفة خيار×لون هو المصدر، ومخزون الخيار هو مجموعها.',
          'Direct-sale stock is required: 0 means sold out; linked colours use exact option×colour stock.',
        ],
        /**
         * «لا تنشئ نظامًا موازيًا» — a direct sale's number is the model's
         * stock, and this file must not offer a second box to type it into.
         */
        refused: {
          capacity: MISPLACED_CAPACITY,
        },
        fields: [
          f('enabled', 'bool', 'options', 'هل يُباع هذا الموديل مباشرةً من المخزون؟ حذف الكتلة كلها = لا يُباع مباشرة إطلاقًا'),
          // 0075 / DECISION 1. THE SAME COLUMN AS options.N.stock, spelled the
          // way an admin reading the direct block expects to find it. Applied
          // to the MODEL (`onModel`), import-only (`exported: false`) so the
          // export states the number once.
          f('stock', 'int', 'options', 'مخزون البيع المباشر = مخزون الموديل — مرادف لـ options.N.stock ويكتب في نفس العمود؛ __NULL__ = لا يُتتبع، 0 = لا توجد وحدات. لا يُصدَّر بهذه التهجئة (يُصدَّر كـ options.N.stock).', { nullable: true, min: 0, max: 1_000_000, onModel: true, exported: false, aliasOf: 'stock' }),
          f('low_stock_threshold', 'int', 'options', 'حد التنبيه لمخزون البيع المباشر — مرادف لـ options.N.low_stock_threshold ونفس العمود؛ __NULL__ = بلا تنبيه. لا يُصدَّر بهذه التهجئة.', { nullable: true, min: 0, max: 1_000_000, onModel: true, exported: false, aliasOf: 'low_stock_threshold' }),
          f('price_iqd', 'iqd', 'options', 'سعر البيع المباشر لهذا الموديل — +N = فرق عن سعر الموديل (مثال +50000)، رقم = سعر ثابت، __NULL__ = نفس سعر الموديل', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'regular_adjust_iqd' }),
          f('prime_price_iqd', 'iqd', 'options', 'سعر PRIME للبيع المباشر — __NULL__ = وراثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'prime_adjust_iqd' }),
          f('pro_price_iqd', 'iqd', 'options', 'سعر PRO للبيع المباشر — __NULL__ = وراثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'pro_adjust_iqd' }),
          f('cost_iqd', 'iqd', 'options', 'كلفة البيع المباشر (داخلي) — __NULL__ = وراثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'cost_adjust_iqd' }),
        ],
      },
      preorder: {
        titleAr: 'الطلب المسبق لهذا الموديل', titleEn: 'Pre-order for this model',
        notes: [
          'الطلب المسبق متوفر أو غير متوفر فقط؛ لا يملك مخزونًا ولا سعة.',
          'فعّل واحدة أو أكثر من طرق الوصول إلى العراق (جوي / بحري / بري) واكتب زيادة كل طريقة.',
          'Pre-order has no stock or capacity: enable transport routes and their surcharges.',
        ],
        fields: [
          f('enabled', 'bool', 'options', 'هل يمكن طلب هذا الموديل مسبقًا؟ حذف الكتلة كلها = لا طلب مسبق'),
          // 0075 / DECISION 2. Optional, independent of the model's stock, and
          // NULL by default so every product written before this behaves as it
          // always did: an unlimited pre-order.
          f('capacity', 'int', 'options', 'قديم للاستيراد فقط — الطلب المسبق متوفر أو غير متوفر ولا يملك مخزونًا أو سعة', { nullable: true, min: 0, max: 1_000_000, exported: false }),
          f('price_iqd', 'iqd', 'options', 'سعر الطلب المسبق لهذا الموديل — +N = فرق عن سعر الموديل، __NULL__ = نفس سعر الموديل', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'regular_adjust_iqd' }),
          f('prime_price_iqd', 'iqd', 'options', 'سعر PRIME للطلب المسبق — __NULL__ = وراثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'prime_adjust_iqd' }),
          f('pro_price_iqd', 'iqd', 'options', 'سعر PRO للطلب المسبق — __NULL__ = وراثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'pro_adjust_iqd' }),
          f('cost_iqd', 'iqd', 'options', 'كلفة الطلب المسبق (داخلي) — __NULL__ = وراثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'cost_adjust_iqd' }),
          f('lead_time_text', 'string', 'options', 'التهجئة القديمة لـ lead_time_text_en — import-only synonym, never exported', { exported: false }),
          f('lead_time_text_ar', 'string', 'options', 'مدة هذا الموديل بالعربية كما تُعرض للزبون — فارغ = تُقرأ النسخة الإنجليزية', { lang: 'ar' }),
          f('lead_time_text_en', 'string', 'options', 'المدة بالإنجليزية (المصدر) — النص يسبق الأرقام دائمًا', { lang: 'en', aliasOf: 'lead_time_text' }),
          f('lead_time_text_ckb', 'string', 'options', 'ماوە بە کوردی — فارغ = تُقرأ النسخة الإنجليزية', { lang: 'ckb' }),
          f('lead_time_min_days', 'int', 'options', 'أقل عدد أيام — للترتيب والتقدير', { nullable: true, min: 0, max: 3650 }),
          f('lead_time_max_days', 'int', 'options', 'أكثر عدد أيام', { nullable: true, min: 0, max: 3650 }),
        ],
        list: {
          name: 'transports',
          notes: [
            'الطريق الذي لا يذكره الملف يُحفظ كما هو بسعره — لحذف كل الطرق اكتب options.N.preorder.transports=__CLEAR__',
            'ثم اذكر الطرق التي تريد بقاءها في نفس الملف.',
            'A route the file does not name is preserved with its price.',
            '  options.N.preorder.transports=__CLEAR__ removes every route the same file does not name again;',
            '  a route you name again keeps its stored price unless the file changes it.',
          ],
          fields: [
            f('method', 'enum', 'options', 'air | sea | land — كيف يصل الجهاز إلى العراق. ليست طريقة التوصيل داخل العراق.', { required: true, enumValues: ['air', 'sea', 'land'] as const }),
            f('enabled', 'bool', 'options', 'معروضة للزبائن — offered to customers'),
            // 0075 / DECISION 2. Blank is not zero and is not "copy the pool":
            // it is "this route shares the pool", which is the default every
            // route written before 0075 has.
            f('capacity', 'int', 'options', 'قديم للاستيراد فقط — طريقة الطلب المسبق لا تملك مخزونًا أو سعة', { nullable: true, min: 0, max: 1_000_000, exported: false }),
            f('surcharge_iqd', 'iqd', 'options', 'زيادة هذه الطريقة لهذا الموديل — تحلّ محل زيادة المنتج لهذه الطريقة ولا تُضاف إليها. __NULL__ = استخدم زيادة المنتج.', { nullable: true, min: 0, max: IQD_MAX, plusIsPlain: true }),
            f('price_iqd', 'iqd', 'options', 'سعر ثابت لهذا الموديل بهذه الطريقة — نادر؛ __NULL__ = احسب من المستويات الأعلى', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'regular_adjust_iqd' }),
            f('prime_price_iqd', 'iqd', 'options', 'سعر PRIME بهذه الطريقة — __NULL__ = وراثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'prime_adjust_iqd' }),
            f('pro_price_iqd', 'iqd', 'options', 'سعر PRO بهذه الطريقة — __NULL__ = وراثة', { nullable: true, min: 0, max: IQD_MAX, adjustKey: 'pro_adjust_iqd' }),
            f('lead_time_text', 'string', 'options', 'التهجئة القديمة لـ lead_time_text_en — import-only synonym, never exported', { exported: false }),
            f('lead_time_text_ar', 'string', 'options', 'مدة هذه الطريقة بالعربية — فارغ = تُقرأ النسخة الإنجليزية، وإن كانت فارغة أيضًا فمدة الطلب المسبق أعلاه', { lang: 'ar' }),
            f('lead_time_text_en', 'string', 'options', 'مدة هذه الطريقة بالإنجليزية (المصدر) — فارغ = مدة الطلب المسبق أعلاه', { lang: 'en', aliasOf: 'lead_time_text' }),
            f('lead_time_text_ckb', 'string', 'options', 'ماوەی ئەم ڕێگایە بە کوردی — فارغ = تُقرأ النسخة الإنجليزية', { lang: 'ckb' }),
            f('lead_time_min_days', 'int', 'options', 'أقل عدد أيام لهذه الطريقة', { nullable: true, min: 0, max: 3650 }),
            f('lead_time_max_days', 'int', 'options', 'أكثر عدد أيام لهذه الطريقة', { nullable: true, min: 0, max: 3650 }),
          ],
        },
      },
    },
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
      // Legacy import compatibility only; canonical media uses color_id.
      f('image', 'string', 'colors', 'قديم للاستيراد فقط — converted to a bound images row; never exported', { exported: false }),
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
      ...dimensionFields('colors'),
    ],
  },
  {
    /**
     * Existing exact combinations are editable by stable id. The selection
     * fields are exported so the row remains understandable and a relations
     * write can recompute its combo key; all price/stock columns not represented
     * here are carried from the stored row by merge-by-id.
     */
    name: 'variants', bodyKey: 'variants', idPrefix: '', mergeKey: 'id', group: 'options',
    titleAr: 'تركيبات الخيارات', titleEn: 'Exact option combinations',
    fields: [
      f('id', 'string', 'options', 'معرف التركيبة الثابت — required stable variant id', { required: true }),
      f('option_value_ids', 'csv', 'options', 'معرفات قيم الخيارات في هذه التركيبة، مفصولة بفواصل'),
      f('color_id', 'string', 'options', `معرف اللون في التركيبة؛ ${NULL_TOKEN} = بلا لون`, { nullable: true }),
      ...dimensionFields('options'),
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
      // 0079 — three languages per line. The bare spellings are what every
      // file written before it carries, so they stay as import-only synonyms
      // of the `_en` source; only the triple is exported.
      f('title', 'string', 'usage', 'التهجئة القديمة لـ title_en — import-only synonym, never exported', { exported: false }),
      f('title_ar', 'string', 'usage', 'عنوان الخطوة بالعربية (حتى 200 حرف) — فارغ = يُقرأ العنوان الإنجليزي', { lang: 'ar' }),
      f('title_en', 'string', 'usage', 'عنوان الخطوة بالإنجليزية (المصدر) — step title', { lang: 'en', aliasOf: 'title' }),
      f('title_ckb', 'string', 'usage', 'ناونیشانی هەنگاو بە کوردی — فارغ = يُقرأ العنوان الإنجليزي', { lang: 'ckb' }),
      f('body', 'text', 'usage', 'التهجئة القديمة لـ body_en — import-only synonym, never exported', { exported: false }),
      f('body_ar', 'text', 'usage', 'شرح الخطوة بالعربية (حتى 2000 حرف؛ heredoc للأسطر المتعددة) — فارغ = يُقرأ الشرح الإنجليزي', { lang: 'ar' }),
      f('body_en', 'text', 'usage', 'شرح الخطوة بالإنجليزية (المصدر) — step body', { lang: 'en', aliasOf: 'body' }),
      f('body_ckb', 'text', 'usage', 'ڕوونکردنەوەی هەنگاو بە کوردی — فارغ = يُقرأ الشرح الإنجليزي', { lang: 'ckb' }),
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
  /** 0073. `direct` / `preorder`, each with its own fields and optional list. */
  cells?: Record<string, ParsedCell>;
}

/** A pure parse-time fetch plan. No request or R2 operation happens while
 * building it; /apply materializes every entry before it plans a DB write. */
export interface TemplateMediaFetchIntent {
  /** Exact template field that supplied the remote address. */
  field: string;
  line: number;
  /** Human-readable binding target used by preview UIs. */
  target: string;
  target_type: 'product' | 'option' | 'color' | 'variant';
  target_id: string | null;
  primary: boolean;
  source_url: string;
  source_host: string;
  /** Internal merge coordinates used to replace the intended row after all
   * downloads succeed. They remain deterministic and contain no network data. */
  group: 'images' | 'options' | 'colors';
  index: number;
  image_id: string | null;
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
  media_to_fetch: TemplateMediaFetchIntent[];
}

const MAX_TEMPLATE_BYTES = 1_500_000;
const KEY_RE = /^([A-Za-z0-9_.]+)\s*=(.*)$/;
const GROUP_KEY_RE = /^([a-z_]+)\.(\d+)\.(.+)$/;
const ROW_KEY_RE = /^rows\.(\d+)\.(.+)$/;
/** 0073. `direct.price_iqd`, `preorder.transports.2.method`, … */
const CELL_KEY_RE = /^([a-z_]{1,24})\.(.+)$/;
const CELL_LIST_RE = /^([a-z_]{1,24})\.(\d+)\.(.+)$/;

export interface ParsedCell {
  line: number;
  fields: Record<string, ParsedField>;
  list?: ParsedGroupItem[];
  /** `options.1.preorder=__CLEAR__` — this model no longer sells that way. */
  cleared?: boolean;
  /**
   * `options.1.preorder.transports=__CLEAR__` — every stored route of this
   * cell goes, and only the routes this same file names are written back.
   *
   * It exists because omission PRESERVES a route (see `buildCells`): without
   * an explicit statement there would be no way left to take one away, and
   * "the file did not mention it" and "the owner deleted it" have to stay two
   * different things.
   */
  listCleared?: boolean;
}
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
    return { value: null, clear: spec.nullClears === true, line };
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
     * comma corrupts it. The rule — and the reasons — live in
     * `worker/lib/urlList.ts`, shared with the admin image box, which had the
     * identical bug for the identical reason.
     */
    case 'urls': {
      if (raw === '') return { value: [], clear: false, line };
      return { value: splitUrlList(raw), clear: false, line };
    }
  }
}

function httpSource(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** Stable id for a media row synthesized from a fetch/legacy selector. Kept
 * in one helper so parse-time collision checks and materialization cannot
 * disagree about truncation or sanitization. */
export function generatedTemplateMediaId(
  type: TemplateMediaFetchIntent['target_type'],
  index: number,
  targetId: string | null
): string {
  return `img_${type}_${index}_${String(targetId ?? 'product').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 32)}`;
}

/**
 * Convert every remote spelling into an explicit, side-effect-free fetch
 * intent. This is deliberately a post-pass: `primary` and bindings may occur
 * before or after the URL in the text, and the preview has to report the final
 * target rather than whichever fields happened to have been read so far.
 */
function planTemplateMedia(out: ParsedTemplate): void {
  const error = (line: number, key: string, message: string) => out.errors.push({ line, key, message });
  const intent = (
    group: TemplateMediaFetchIntent['group'],
    item: ParsedGroupItem,
    field: string,
    source: URL,
    targetType: TemplateMediaFetchIntent['target_type'],
    targetId: string | null,
    primary: boolean,
    imageId: string | null,
    line: number
  ) => {
    const target = targetType === 'product'
      ? 'product'
      : `${targetType}:${targetId || `${group}.${item.index}`}`;
    out.media_to_fetch.push({
      field,
      line,
      target,
      target_type: targetType,
      target_id: targetId,
      primary,
      source_url: source.toString(),
      source_host: source.hostname.toLowerCase(),
      group,
      index: item.index,
      image_id: imageId,
    });
  };

  const seenImageIds = new Map<string, number>();
  for (const item of out.groupClears.images ? [] : (out.groups.images ?? [])) {
    const idField = item.fields.id;
    const id = typeof idField?.value === 'string' ? idField.value.trim() : '';
    if (!id) continue;
    const first = seenImageIds.get(id);
    if (first !== undefined) {
      error(idField.line, `images.${item.index}.id`, `duplicate image id "${id}" (already used by images.${first}.id)`);
    } else {
      seenImageIds.set(id, item.index);
    }
  }

  // A whole-group clear wins over indexed rows everywhere else in the
  // template merge. It must also win here: ignored rows never authorize a
  // network fetch and cannot be resurrected as materialized gallery media.
  for (const item of out.groupClears.images ? [] : (out.groups.images ?? [])) {
    const at = (name: string) => `images.${item.index}.${name}`;
    const localField = item.fields.url;
    const fetchField = item.fields.fetch_url;
    const localRaw = typeof localField?.value === 'string' ? localField.value.trim() : '';
    const fetchRaw = typeof fetchField?.value === 'string' ? fetchField.value.trim() : '';

    if (localRaw && fetchRaw) {
      const message = 'choose one media source: url for an existing local /files object, or fetch_url for a remote image to import';
      error(localField.line, at('url'), message);
      error(fetchField.line, at('fetch_url'), message);
      continue;
    }

    if (localRaw && isOwnedMediaUrl(localRaw)) {
      const expectedKey = localRaw.slice('/files/'.length);
      if (!expectedKey.endsWith('.webp')) {
        error(localField.line, at('url'), 'local product media must be a /files/<key>.webp URL');
        continue;
      }
      const keyField = item.fields.key;
      const statedKey = typeof keyField?.value === 'string' ? keyField.value.trim() : '';
      if (statedKey && statedKey !== expectedKey) {
        error(keyField!.line, at('key'), `must exactly match the key in ${at('url')} (${expectedKey})`);
        continue;
      }
    }

    // Binding validity is independent of where the bytes already live. A
    // local `/files/...` row and a remote import obey the same single-target
    // rule, and the parser reports the exact binding field in either case.
    const bindings = (['option_value_id', 'color_id', 'variant_id'] as const)
      .map((name) => ({ name, field: item.fields[name] }))
      .filter((x) => typeof x.field?.value === 'string' && String(x.field!.value).trim() !== '');
    if (bindings.length > 1) {
      for (const binding of bindings.slice(1)) {
        error(binding.field!.line, at(binding.name), 'an image may bind to only one of option_value_id, color_id, or variant_id');
      }
      continue;
    }

    let source: URL | null = null;
    let sourceField = fetchField;
    let sourceKey = at('fetch_url');
    if (fetchRaw) {
      source = httpSource(fetchRaw);
      if (!source) {
        error(fetchField.line, sourceKey, 'must be an absolute http(s) image URL without credentials');
        continue;
      }
    } else if (localRaw && !isOwnedMediaUrl(localRaw)) {
      source = httpSource(localRaw);
      if (!source) {
        error(localField.line, at('url'), 'must be a local /files/<key> URL; use images.N.fetch_url for an external http(s) source');
        continue;
      }
      // Backward compatibility is visible and deterministic: the external
      // value no longer reaches ProductDoc.url, but is materialized by apply.
      sourceField = localField;
      sourceKey = at('url');
      item.fields.fetch_url = localField;
      delete item.fields.url;
      out.warnings.push(`${sourceKey}: external url is legacy; treated as import-only ${at('fetch_url')}`);
    }

    if (!source || !sourceField) continue;
    const binding = bindings[0];
    const type: TemplateMediaFetchIntent['target_type'] = binding?.name === 'option_value_id'
      ? 'option'
      : binding?.name === 'color_id'
        ? 'color'
        : binding?.name === 'variant_id'
          ? 'variant'
          : 'product';
    const targetId = binding ? String(binding.field!.value).trim() : null;
    const imageId = typeof item.fields.id?.value === 'string' && item.fields.id.value.trim()
      ? item.fields.id.value.trim()
      : generatedTemplateMediaId(type, item.index, targetId);
    intent(
      'images',
      item,
      sourceKey,
      source,
      type,
      targetId,
      item.fields.primary?.value === true,
      imageId,
      sourceField.line
    );
  }

  for (const group of ['options', 'colors'] as const) {
    if (out.groupClears[group]) continue;
    for (const item of out.groups[group] ?? []) {
      const image = item.fields.image;
      if (!image || typeof image.value !== 'string' || image.value.trim() === '') continue;
      const key = `${group}.${item.index}.image`;
      const raw = image.value.trim();
      const id = typeof item.fields.id?.value === 'string' && item.fields.id.value.trim()
        ? item.fields.id.value.trim()
        : null;
      const type = group === 'options' ? 'option' : 'color';
      if (isOwnedMediaUrl(raw)) {
        if (!raw.endsWith('.webp')) {
          error(image.line, key, 'local product media must be a /files/<key>.webp URL');
          continue;
        }
        out.warnings.push(`${key}: legacy image field will be converted to one images row bound by ${type === 'option' ? 'option_value_id' : 'color_id'}`);
        continue;
      }
      const source = httpSource(raw);
      if (!source) {
        error(image.line, key, 'must be a local /files/<key> URL or an absolute http(s) image URL');
        continue;
      }
      delete item.fields.image;
      out.warnings.push(`${key}: external legacy image was converted to an import intent and a bound images row`);
      intent(group, item, key, source, type, id, false, id ? generatedTemplateMediaId(type, item.index, id) : null, image.line);
    }
  }

  // Generated ids and authored ids share the same relation namespace. Catch
  // a collision while parsing, before either source is fetched; otherwise the
  // later candidate would overwrite the earlier row and orphan its new R2
  // object on an otherwise successful apply.
  if (!out.errors.some((issue) => issue.message.startsWith('duplicate image id '))) {
    const candidates: Array<{ id: string; line: number; field: string }> = out.media_to_fetch
      .filter((candidate) => !!candidate.image_id)
      .map((candidate) => ({ id: candidate.image_id!, line: candidate.line, field: candidate.field }));
    for (const item of out.groupClears.images ? [] : (out.groups.images ?? [])) {
      if (out.media_to_fetch.some((candidate) => candidate.group === 'images' && candidate.index === item.index)) continue;
      const url = typeof item.fields.url?.value === 'string' ? item.fields.url.value.trim() : '';
      const id = typeof item.fields.id?.value === 'string' ? item.fields.id.value.trim() : '';
      if (id && isOwnedMediaUrl(url)) candidates.push({ id, line: item.fields.id!.line, field: `images.${item.index}.id` });
    }
    for (const group of ['options', 'colors'] as const) {
      if (out.groupClears[group]) continue;
      for (const item of out.groups[group] ?? []) {
        const url = typeof item.fields.image?.value === 'string' ? item.fields.image.value.trim() : '';
        const targetId = typeof item.fields.id?.value === 'string' ? item.fields.id.value.trim() : '';
        if (!targetId || !isOwnedMediaUrl(url)) continue;
        const type = group === 'options' ? 'option' : 'color';
        candidates.push({
          id: generatedTemplateMediaId(type, item.index, targetId),
          line: item.fields.image!.line,
          field: `${group}.${item.index}.image`,
        });
      }
    }

    const ids = new Map<string, { id: string; line: number; field: string }>();
    for (const candidate of candidates) {
      const first = ids.get(candidate.id);
      if (first) {
        error(
          candidate.line,
          candidate.field,
          `materialized image id "${candidate.id}" conflicts with ${first.field}`
        );
      } else {
        ids.set(candidate.id, candidate);
      }
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
    media_to_fetch: [],
  };
  const err = (line: number, key: string, message: string) => out.errors.push({ line, key, message });

  /**
   * 0075 — A KEY THE FORMAT DOES NOT DECLARE, dropped with a warning; EXCEPT
   * a misplaced `capacity`, which is refused BY NAME.
   *
   * `options.1.capacity=44` is the spelling an admin reaching for "how many
   * may I pre-order" types beside `options.1.stock`, and it is not a key this
   * format has ever had: it fell through to `unknown_keys`, earned the generic
   * «unknown key "…" was ignored» warning, and the apply then SUCCEEDED with
   * the cell still untracked — unlimited pre-orders under a number the admin
   * believes they typed. `options.N.direct.capacity` was already refused by
   * name (`CellSpec.refused`) on exactly that reasoning, and the sheet refuses
   * the same mistake by name on every non-`fulfillment` row
   * (worker/lib/importCsv.ts). This is the third statement of one rule, in the
   * one place every unknown key in this format passes through, so a capacity
   * typed anywhere the format has no box for it — `capacity=44`,
   * `options.1.capacity=44`, `colors.1.capacity=44` — is an ERROR naming the
   * two keys that carry the number, instead of a warning nobody reads.
   *
   * Only the LAST segment is examined, so the two real keys
   * (`options.N.preorder.capacity` and
   * `options.N.preorder.transports.M.capacity`) are declared fields that never
   * reach here, and `spec.capacity` — a spec-sheet field id, which may legally
   * be called anything — is taken by the `spec.` branch long before this.
   */
  const ignoreKey = (line: number, key: string) => {
    if (key.slice(key.lastIndexOf('.') + 1) === 'capacity') {
      err(line, key, MISPLACED_CAPACITY);
      return;
    }
    out.unknown_keys.push(key);
  };

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
        if (!rowSpec) { ignoreKey(lineNo, key); continue; }
        if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
        seenGroupField.add(key);
        item.rows ??= [];
        let row = item.rows.find((r) => r.index === rowIndex);
        if (!row) { row = { index: rowIndex, line: lineNo, fields: {} }; item.rows.push(row); }
        const pf = coerce(rowSpec, value, lineNo, key, out.errors);
        if (pf) row.fields[rowKey] = pf;
        continue;
      }

      /**
       * 0073. `options.N.direct.<field>`, `options.N.preorder.<field>` and
       * `options.N.preorder.transports.M.<field>`.
       *
       * Tried BEFORE the flat field lookup and only when the head actually
       * names a declared cell, so a key with a dot in it that is not a cell
       * still falls through to `unknown_keys` exactly as it did.
       */
      /**
       * 0073. REMOVING A CELL: `options.1.preorder=__CLEAR__`.
       *
       * The same idiom the format already uses for a whole group
       * (`options=__CLEAR__`), one level down — a key with no subfield and the
       * clear token. It needs its own statement because "the file did not
       * mention this cell" and "the owner deleted it" have to be different
       * things, or nothing could ever be taken away. `enabled=false` is not a
       * substitute: that is a configured order type switched off, which an
       * admin needs to tell apart from one that was never set up.
       */
      if (groupSpec.cellFields?.[sub]) {
        if (value !== CLEAR_TOKEN) {
          err(lineNo, key, `"${key}" is a block — use ${key}.<field>=…, or ${key}=${CLEAR_TOKEN} to remove it`);
          continue;
        }
        if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
        seenGroupField.add(key);
        item.cells ??= {};
        item.cells[sub] = { line: lineNo, fields: {}, cleared: true };
        continue;
      }

      const cm = groupSpec.cellFields ? CELL_KEY_RE.exec(sub) : null;
      const cellSpec = cm ? groupSpec.cellFields?.[cm[1]] : undefined;
      if (cm && cellSpec) {
        item.cells ??= {};
        const cell = (item.cells[cm[1]] ??= { line: lineNo, fields: {} });
        const rest = cm[2];

        // `options.N.preorder.transports=__CLEAR__`: the list itself, cleared.
        // A bare `…transports=<anything else>` is a mistake worth naming, the
        // same way a bare `options.N.preorder=<value>` is — it is a list, not
        // a field, and silently dropping it would be the loss this idiom was
        // added to prevent.
        if (cellSpec.list && rest === cellSpec.list.name) {
          if (value !== CLEAR_TOKEN) {
            err(lineNo, key, `"${key}" is a list — use ${key}.1.<field>=…, or ${key}=${CLEAR_TOKEN} to remove every route`);
            continue;
          }
          if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
          seenGroupField.add(key);
          cell.listCleared = true;
          continue;
        }

        const lm = cellSpec.list ? CELL_LIST_RE.exec(rest) : null;
        if (lm && cellSpec.list && lm[1] === cellSpec.list.name) {
          const listIndex = parseInt(lm[2], 10);
          if (listIndex < 1 || listIndex > 50) { err(lineNo, key, 'index must be between 1 and 50'); continue; }
          const listField = cellSpec.list.fields.find((x) => x.key === lm[3]);
          if (!listField) { ignoreKey(lineNo, key); continue; }
          if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
          seenGroupField.add(key);
          cell.list ??= [];
          let entry = cell.list.find((r) => r.index === listIndex);
          if (!entry) { entry = { index: listIndex, line: lineNo, fields: {} }; cell.list.push(entry); }
          const pv = coerce(listField, value, lineNo, key, out.errors);
          if (pv) entry.fields[lm[3]] = pv;
          continue;
        }

        // 0075. A subkey this cell refuses BY NAME. It is an error and not a
        // dropped unknown key, because the admin wrote it on purpose and has
        // to be told which field carries the number instead.
        const refusal = cellSpec.refused?.[rest];
        if (refusal) { err(lineNo, key, refusal); continue; }

        const cellField = cellSpec.fields.find((x) => x.key === rest);
        if (!cellField) { ignoreKey(lineNo, key); continue; }
        if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
        seenGroupField.add(key);
        const pv = coerce(cellField, value, lineNo, key, out.errors);
        if (pv) cell.fields[rest] = pv;
        continue;
      }

      const fieldSpec = groupSpec.fields.find((x) => x.key === sub);
      if (!fieldSpec) { ignoreKey(lineNo, key); continue; }
      if (seenGroupField.has(key)) { err(lineNo, key, 'duplicate key'); continue; }
      seenGroupField.add(key);
      const pf = coerce(fieldSpec, value, lineNo, key, out.errors);
      if (pf) item.fields[sub] = pf;
      continue;
    }

    ignoreKey(lineNo, key);
  }

  if (out.header.template_version === null && !out.errors.some((e) => e.key === 'template_version')) {
    err(1, 'template_version', `template_version=${TEMPLATE_VERSION} is required as the first non-comment line`);
  }

  // Materialize groups sorted by index; rows sorted too.
  for (const [name, map] of Object.entries(groupItems)) {
    const items = [...map.values()].sort((a, b) => a.index - b.index);
    for (const it of items) {
      it.rows?.sort((a, b) => a.index - b.index);
      for (const cell of Object.values(it.cells ?? {})) cell.list?.sort((a, b) => a.index - b.index);
    }
    out.groups[name] = items;
  }
  planTemplateMedia(out);
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
  /** Exact relational combinations. ProductDoc deliberately carries only the
   * flat option/color projection, so the export route supplies these rows. */
  variants?: Array<{
    id: string;
    option_value_ids: string[];
    color_id: string | null;
    [key: string]: unknown;
  }>;
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
  push('how_to_use_ar', doc.how_to_use_ar);
  push('how_to_use_en', doc.how_to_use);
  push('how_to_use_ckb', doc.how_to_use_ckb);
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
  if (opts.inventoryMode !== undefined) push('inventory_mode', opts.inventoryMode ?? '');
  push('payment_options', doc.payment_options.join(','));
  // A null delivery_options is an intentional legacy state. Do not emit six
  // invented values into an export: omitting them means a round-trip keeps
  // the global tariff exactly as it was.
  if (doc.delivery_options) {
    push('standard_delivery_enabled', boolStr(doc.delivery_options.standard.enabled));
    push('standard_delivery_quantity_step', String(doc.delivery_options.standard.quantity_step));
    push('standard_delivery_fee_iqd', String(doc.delivery_options.standard.fee_iqd));
    push('personal_delivery_enabled', boolStr(doc.delivery_options.personal.enabled));
    push('personal_delivery_quantity_step', String(doc.delivery_options.personal.quantity_step));
    push('personal_delivery_fee_iqd', String(doc.delivery_options.personal.fee_iqd));
  }
  // Device coverage — written whenever the product states it. A product that
  // never said whether it is serialized exports no `serialized` line, so a
  // re-import keeps the stored answer instead of turning silence into false.
  push('warranty_base_months', numStr(doc.warranty_base_months));
  if (doc.serialized !== null) push('serialized', boolStr(doc.serialized));
  // Product measurements live in a nested document object but use flat TXT
  // keys. Every null is exported as __NULL__, so round-trip clearing is exact.
  for (const key of DIMENSION_KEYS) push(key, numStr(doc.dimensions[key]));

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

  const canonicalMedia = [...doc.media];
  const addLegacyBound = (type: 'option' | 'color', id: string, url: string) => {
    if (!isOwnedMediaUrl(url)) return;
    const binding = type === 'option' ? 'option_value_id' : 'color_id';
    // A canonical binding wins even when an old relation column still points
    // at a different file. Exporting both would resurrect two sources of
    // truth and duplicate the row on re-import.
    if (canonicalMedia.some((m) => m[binding] === id)) return;
    canonicalMedia.push({
      id: `img_${type}_${id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 42) || 'row'}`,
      url,
      key: url.slice('/files/'.length),
      role: 'gallery',
      alt_ar: '', alt_en: '', alt_ckb: '',
      order: canonicalMedia.length,
      primary: canonicalMedia.length === 0,
      width: null, height: null, source_url: '',
      option_value_id: type === 'option' ? id : '',
      color_id: type === 'color' ? id : '',
      variant_id: '',
    });
  };
  for (const option of doc.options) if (option.image) addLegacyBound('option', option.id, option.image);
  for (const color of doc.colors) if (color.image) addLegacyBound('color', color.id, color.image);

  sorted(canonicalMedia).forEach((mItem, i) => {
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
    push(`${p}.content_type`, String((mItem as unknown as Record<string, unknown>).content_type ?? ''));
    push(`${p}.bytes`, numStr(((mItem as unknown as Record<string, unknown>).bytes as number | null | undefined) ?? null));
  });

  orderedOptions(doc).forEach((o, i) => {
    const p = `options.${i + 1}`;
    push(`${p}.id`, o.id);
    push(`${p}.group`, o.group_en ?? '');
    push(`${p}.name_ar`, o.name_ar);
    push(`${p}.name_en`, o.name_en);
    push(`${p}.name_ckb`, o.name_ckb);
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
    push(`${p}.lead_time_text_ar`, o.lead_time_text_ar ?? '');
    push(`${p}.lead_time_text_en`, o.lead_time_text ?? '');
    push(`${p}.lead_time_text_ckb`, o.lead_time_text_ckb ?? '');
    push(`${p}.lead_time_min_days`, numStr(o.lead_time_min_days ?? null));
    push(`${p}.lead_time_max_days`, numStr(o.lead_time_max_days ?? null));
    push(`${p}.variant_key`, o.variant_key ?? '');
    push(`${p}.variant_label`, o.variant_label ?? '');
    push(`${p}.sku_part`, o.sku_part ?? '');
    push(`${p}.low_stock_threshold`, numStr(o.low_stock_threshold ?? null));
    for (const key of DIMENSION_KEYS) {
      push(`${p}.${key}`, numStr((o as unknown as Record<string, number | null | undefined>)[key] ?? null));
    }

    /**
     * 0073. WHAT THIS MODEL DOES. A cell that does not exist is written as
     * NOTHING, not as `enabled=false`: an export is the bulk-EDIT path, and a
     * file that lists every possible order type with a false beside it reads
     * as a product that sells four ways and offers none. The block appears
     * when the model actually has that order type; adding the block is how an
     * admin adds one.
     */
    for (const cell of o.fulfillments ?? []) {
      const cp = `${p}.${cell.fulfillment_type === 'pre_order' ? 'preorder' : 'direct'}`;
      push(`${cp}.enabled`, boolStr(cell.enabled !== false));
      push(`${cp}.price_iqd`, numStr(cell.regular_price_iqd ?? null));
      push(`${cp}.prime_price_iqd`, numStr(cell.prime_price_iqd ?? null));
      push(`${cp}.pro_price_iqd`, numStr(cell.pro_price_iqd ?? null));
      if (money) push(`${cp}.cost_iqd`, numStr(cell.cost_iqd ?? null));
      if (cell.fulfillment_type === 'pre_order') {
        /**
         * 0075. THE PRE-ORDER POOL, written even when it is null.
         *
         * `numStr(null)` is `__NULL__`, which is UNTRACKED — the same word the
         * file uses to say it. Writing `0` here instead would turn every
         * unlimited pre-order in the catalogue into a sold-out one on the next
         * re-import, so the null must survive the round trip as a null.
         *
         * THE DIRECT CELL GETS NO `stock` LINE. Its number is the model's,
         * already written above as `options.N.stock`; emitting the alias too
         * would state one column twice and a round trip would write it twice.
         */
        push(`${cp}.lead_time_text_ar`, cell.lead_time_text_ar ?? '');
        push(`${cp}.lead_time_text_en`, cell.lead_time_text ?? '');
        push(`${cp}.lead_time_text_ckb`, cell.lead_time_text_ckb ?? '');
        push(`${cp}.lead_time_min_days`, numStr(cell.lead_time_min_days ?? null));
        push(`${cp}.lead_time_max_days`, numStr(cell.lead_time_max_days ?? null));
        (cell.transports ?? []).forEach((t, ti) => {
          const tp = `${cp}.transports.${ti + 1}`;
          push(`${tp}.method`, t.method);
          push(`${tp}.enabled`, boolStr(t.enabled !== false));
          push(`${tp}.surcharge_iqd`, numStr(t.surcharge_iqd ?? null));
          // null = THIS ROUTE SHARES THE POOL. Exported as `__NULL__`, never
          // as the pool's number: copying it here would be the automatic
          // duplication onto the three routes the owner forbade.
          push(`${tp}.price_iqd`, numStr(t.regular_price_iqd ?? null));
          push(`${tp}.prime_price_iqd`, numStr(t.prime_price_iqd ?? null));
          push(`${tp}.pro_price_iqd`, numStr(t.pro_price_iqd ?? null));
          push(`${tp}.lead_time_text_ar`, t.lead_time_text_ar ?? '');
          push(`${tp}.lead_time_text_en`, t.lead_time_text ?? '');
          push(`${tp}.lead_time_text_ckb`, t.lead_time_text_ckb ?? '');
          push(`${tp}.lead_time_min_days`, numStr(t.lead_time_min_days ?? null));
          push(`${tp}.lead_time_max_days`, numStr(t.lead_time_max_days ?? null));
        });
      }
    }
  });

  sorted(doc.colors).forEach((cItem, i) => {
    const p = `colors.${i + 1}`;
    push(`${p}.id`, cItem.id);
    push(`${p}.name_ar`, cItem.name_ar);
    push(`${p}.name_en`, cItem.name_en);
    push(`${p}.name_ckb`, cItem.name_ckb);
    push(`${p}.hex`, cItem.hex);
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
    for (const key of DIMENSION_KEYS) {
      push(`${p}.${key}`, numStr((cItem as unknown as Record<string, number | null | undefined>)[key] ?? null));
    }
  });

  const variantRows = opts.variants ??
    (((doc as unknown as Record<string, unknown>).variants as ExportOpts['variants'] | undefined) ?? []);
  variantRows.forEach((variant, i) => {
    const p = `variants.${i + 1}`;
    push(`${p}.id`, variant.id);
    push(`${p}.option_value_ids`, variant.option_value_ids.join(','));
    push(`${p}.color_id`, variant.color_id);
    for (const key of DIMENSION_KEYS) {
      push(`${p}.${key}`, numStr((variant as Record<string, unknown>)[key] as number | null));
    }
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
  push('gini_url', doc.gini_url ?? '');
  sorted(doc.usage_guide?.steps ?? []).forEach((st, i) => {
    const p = `usage_steps.${i + 1}`;
    push(`${p}.id`, st.id);
    push(`${p}.kind`, st.kind);
    push(`${p}.title_ar`, st.title_ar);
    push(`${p}.title_en`, st.title);
    push(`${p}.title_ckb`, st.title_ckb);
    push(`${p}.body_ar`, st.body_ar);
    push(`${p}.body_en`, st.body);
    push(`${p}.body_ckb`, st.body_ckb);
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
  if (spec.key.endsWith('_delivery_quantity_step')) return '1';
  if (spec.key.endsWith('_delivery_fee_iqd')) return '0';
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
    '#  - التوفر لكل خيار: فعّل options.N.direct و/أو options.N.preorder. زيادة المباشر في direct.price_iqd، وزيادة كل شحن مسبق في transports.N.surcharge_iqd.',
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
    if (spec.exported === false) continue;
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
      if (spec.exported === false) continue;
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
    /**
     * 0073. WHAT THIS MODEL DOES — commented out in the blank, and that is the
     * point. The model above is what a new product needs; its order types are
     * an answer only the owner has. A block that is PRESENT means "this model
     * sells that way", so printing them live would declare every new product
     * as selling both ways before anyone said so.
     */
    for (const [cellName, cell] of Object.entries(g.cellFields ?? {})) {
      lines.push(`# ${'─'.repeat(50)}`);
      lines.push(`# ${cell.titleAr} — ${cell.titleEn}`);
      lines.push(`# احذف الكتلة كلها = هذا الموديل لا يُباع بهذه الطريقة.`);
      lines.push(`# لإزالتها من منتج موجود عند التحديث: ${g.name}.1.${cellName}=${CLEAR_TOKEN}`);
      lines.push(`# أزل علامة # من الأسطر التالية لتفعيلها.`);
      // 0075. The cell's own prose — the shared-vs-independent rule and the
      // one-stock-source rule — printed where the keys are, not only in the
      // docs: the blank template is the only documentation many admins read.
      for (const note of cell.notes ?? []) lines.push(`# ${note}`);
      for (const [key, why] of Object.entries(cell.refused ?? {})) {
        lines.push(`# (مرفوض / refused) ${g.name}.1.${cellName}.${key} — ${why}`);
      }
      for (const spec of cell.fields) {
        if (spec.exported === false) continue;
        lines.push(fieldComment(spec));
        lines.push(`# ${g.name}.1.${cellName}.${spec.key}=${blankValue(spec)}`);
      }
      if (cell.list) {
        lines.push(
          `# ${cell.list.name}: كرر بـ ${g.name}.1.${cellName}.${cell.list.name}.2.… — كيف يصل الجهاز إلى العراق، وليس التوصيل داخل العراق.`
        );
        for (const note of cell.list.notes ?? []) lines.push(`# ${note}`);
        for (const spec of cell.list.fields) {
          if (spec.exported === false) continue;
          lines.push(fieldComment(spec));
          lines.push(`# ${g.name}.1.${cellName}.${cell.list.name}.1.${spec.key}=${blankValue(spec)}`);
        }
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

/**
 * A brand the file names that does not exist yet and the apply WILL create.
 *
 * It is carried from the check step to the apply step as DATA, not as prose:
 * the check route returns it so the owner sees «سيُنشأ» before pressing
 * «ابدأ الاستيراد», and the apply route materialises it through
 * `createPendingBrand` (./templateRefs.ts). `id` is allocated at check time so
 * the line the owner reads, the preview's diff and the row finally inserted
 * are one brand rather than three descriptions of one.
 */
export interface PendingBrand {
  id: string;
  /** The name exactly as the file spelled it. */
  name: string;
  name_ar: string;
  name_en: string;
  slug: string;
}

export interface ResolvedRefs {
  /** resolved brand id; null = clear brand; undefined = omitted/unresolved (preserve) */
  brand_id?: string | null;
  /**
   * Brands this file names that do not exist yet. `brand_id` already points at
   * the entry's `id`, so the merge proceeds and the preview is complete; the
   * ROW is written only by the apply, and only after the check disclosed it.
   */
  brands_to_create?: PendingBrand[];
  /** resolved catalog ids; undefined = omitted/unresolved (preserve associations) */
  catalog_ids?: string[];
  /** resolved main-section id; null = clear; undefined = omitted/unresolved */
  category_id?: string | null;
  /** resolved sub-section id; null = clear; undefined = omitted/unresolved */
  sub_category_id?: string | null;
  needs_review?: NeedsReviewEntry[];
}

/** Relational rows that are not part of ProductDoc but participate in a TXT
 * round trip. Today that is the exact-combination table. */
export interface TemplateMergeContext {
  variants?: LooseItem[];
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
  const dimensions = new Set<string>(
    Array.isArray(target.__template_dimension_fields)
      ? (target.__template_dimension_fields as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
  );
  for (const spec of specs) {
    const pf = fields[spec.key];
    if (!pf) continue;
    if (DIMENSION_KEY_SET.has(spec.key)) dimensions.add(spec.key);
    if (pf.adjust && spec.adjustKey) signed.push([spec, pf]);
    else applyItemField(target, spec, pf);
  }
  for (const [spec, pf] of signed) applyItemField(target, spec, pf);
  if (dimensions.size > 0) target.__template_dimension_fields = [...dimensions];
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

/**
 * 0073. THE MODEL'S ORDER TYPES, out of the file and into the document.
 *
 * A cell PRESENT in the file — even as just `options.1.direct.enabled=true` —
 * means "this model sells that way". A cell ABSENT means the file says nothing
 * about it, so whatever the product already has is preserved; that is the same
 * omission rule every other field in this format follows, and it is what lets
 * an owner edit one price without accidentally deleting a route.
 *
 * `options.N.<cell>=__CLEAR__` is how a cell is REMOVED — the same idiom the
 * format already uses for a whole group, one level down. It needs its own
 * statement because "the file did not mention it" and "the owner deleted it"
 * have to be different things, or nothing could ever be taken away. And
 * `enabled=false` is not a substitute: that is a configured order type
 * switched OFF, which an admin needs to tell apart from one never set up.
 */
function buildCells(
  g: GroupSpec,
  it: ParsedGroupItem,
  existing: LooseItem[] | null,
  /** The MODEL row these cells hang off — `options.N.direct.stock` lands here
   *  (0075 / DECISION 1), because it is `options.N.stock` spelled differently
   *  and there is only one column. Optional so older callers still compile. */
  model?: LooseItem,
  result?: ToDocResult
): LooseItem[] | undefined {
  if (!g.cellFields) return undefined;
  const parsedCells = it.cells;
  if (!parsedCells || !Object.keys(parsedCells).length) return existing ?? undefined;

  const TYPE_OF: Record<string, string> = { direct: 'direct_sale', preorder: 'pre_order' };
  const kept = new Map<string, LooseItem>();
  for (const prev of existing ?? []) kept.set(String(prev.fulfillment_type ?? ''), { ...prev });

  for (const [cellName, cellSpec] of Object.entries(g.cellFields)) {
    const parsed = parsedCells[cellName];
    if (!parsed) continue;
    const type = TYPE_OF[cellName] ?? cellName;

    // `options.N.<cell>=__CLEAR__` removes it. Nothing else does: a file that
    // simply does not mention a cell leaves it exactly as it was.
    // Named in `cleared_fields` for the same reason the list clear below is:
    // a removal the preview does not report is a removal the admin approves
    // without seeing it, and this one takes the cell's whole pre-order pool
    // with it.
    if (parsed.cleared) {
      kept.delete(type);
      result?.cleared_fields.push(`${g.name}.${it.index}.${cellName}`);
      continue;
    }

    const cell: LooseItem = { ...(kept.get(type) ?? {}), fulfillment_type: type };
    /**
     * 0075 / DECISION 1. THE ALIAS FIELDS GO TO THE MODEL, NOT TO THE CELL.
     *
     * `options.N.direct.stock` and `options.N.stock` are two spellings of
     * `product_option_values.stock`, so only one of them may be written and
     * it is the model's. Applied AFTER the model's own scalar loop, so when a
     * file carries both, the more specific spelling is the one that lands —
     * and a warning names both keys, because a file stating one number twice
     * is a file whose author expects one of them to be read.
     */
    const modelFields = cellSpec.fields.filter((x) => x.onModel);
    if (modelFields.length && model) {
      for (const spec of modelFields) {
        if (!parsed.fields[spec.key]) continue;
        const canonical = spec.aliasOf ?? spec.key;
        if (it.fields[canonical]) {
          result?.warnings.push(
            `${g.name}.${it.index}: both ${g.name}.${it.index}.${canonical} and ${g.name}.${it.index}.${cellName}.${spec.key} were given for the same column — ${cellName}.${spec.key} was used`
          );
        }
      }
      applyItemFields(model, modelFields, parsed.fields);
    }
    applyItemFields(cell, cellSpec.fields.filter((x) => !x.onModel), parsed.fields);
    // The file spells the item price `price_iqd`; the document (and the
    // ladder, and the table) call it `regular_price_iqd` like every other rung.
    if ('price_iqd' in cell) { cell.regular_price_iqd = cell.price_iqd; delete cell.price_iqd; }
    if (cell.enabled === undefined) cell.enabled = true;

    /**
     * THE ROUTES MERGE BY METHOD, AND A ROUTE THE FILE DOES NOT NAME SURVIVES.
     *
     * This used to assign `out` over the whole list, so naming air alone
     * DELETED sea and land. That contradicts the one rule this format states
     * about omission — "a field the file omits is one the importer PRESERVES"
     * — and it contradicts every other repeatable list in this same file:
     * `buildGroupItems` merges by id and keeps unmentioned items, `buildRows`
     * merges by id and keeps unmentioned rows. The transports list was the
     * only one that replaced wholesale, and nothing was pushed to
     * `result.warnings` or `cleared_fields`, so the preview showed no loss at
     * all: `{ success: true, warnings: [] }` over a destroyed route.
     *
     * Before 0075 that lost a surcharge and a lead time. Since 0075 it also
     * destroys `product_option_transports.capacity` — an INDEPENDENT quota
     * that is the only thing standing between that route and unlimited
     * pre-orders. Preserving is the safer half of the choice as well as the
     * consistent one: an owner who edits the air price in a two-line file gets
     * the air price edited, and a route is only ever removed when they say so.
     *
     * `method` is `required: true` on every entry and an entry without one is
     * skipped below, so the merge key is always present — the "not every item
     * carries a key, so replace them all" branch the other two lists need has
     * nothing to fall back from here.
     *
     * REMOVING A ROUTE therefore needs a statement of its own, and it is the
     * idiom this format already uses one level up:
     * `options.N.preorder.transports=__CLEAR__` empties the list, and the
     * routes the same file then names are the ones that remain. That keeps
     * "the file did not mention it" and "the owner deleted it" two different
     * things, which is the whole reason `options.N.preorder=__CLEAR__` exists.
     *
     * __CLEAR__ IS A STATEMENT ABOUT THE LIST, NOT ABOUT A ROUTE'S SETTINGS
     * (0075, and the defect this paragraph exists for). It used to empty the
     * merge base as well as the tail, so a route RE-LISTED after it was
     * written FRESH: `transports=__CLEAR__` followed by
     * `transports.1.method=air` with no capacity line replaced air's stored
     * quota of 10 with NULL — UNTRACKED, i.e. unlimited pre-orders on that
     * route — and reported success with empty errors, empty warnings and an
     * empty `cleared_fields`. That is the loss this file's own omission rule
     * forbids («a field the file omits is one the importer PRESERVES»), it is
     * the opposite of what the notes above this list promise the reader
     * («اذكر الطرق التي تريد بقاءها» — name the routes you want to KEEP), and
     * it silently charges NOTHING for a pre-order the owner meant to cap.
     *
     * So the merge base is always the STORED list and only the tail is
     * emptied: the routes the file re-lists keep their quota, their surcharge
     * and their lead time unless the same file states otherwise, and the ones
     * it does not re-list are gone. Untracking a route is still available, and
     * still has to be said out loud: `transports.M.capacity=__NULL__`.
     */
    if (cellSpec.list && (parsed.list || parsed.listCleared)) {
      const storedList = Array.isArray(cell[cellSpec.list.name])
        ? (cell[cellSpec.list.name] as LooseItem[])
        : [];
      const byMethod = new Map(storedList.map((x) => [String(x.method ?? ''), x]));
      // Cleared: nothing the file leaves unnamed survives. Not cleared: every
      // unnamed route is preserved, exactly as it was.
      const prevList = parsed.listCleared ? [] : storedList;
      const named = new Set<string>();
      const out: LooseItem[] = [];
      for (const entry of parsed.list ?? []) {
        const method = String(entry.fields.method?.value ?? '').trim();
        if (!method) continue;
        named.add(method);
        const row: LooseItem = { ...(byMethod.get(method) ?? {}), method };
        applyItemFields(row, cellSpec.list.fields, entry.fields);
        if ('price_iqd' in row) { row.regular_price_iqd = row.price_iqd; delete row.price_iqd; }
        if (row.enabled === undefined) row.enabled = true;
        out.push(row);
      }
      // The unnamed routes, in the order they were stored, after the ones the
      // file spoke about — the same tail `buildRows` and `buildGroupItems`
      // give an item the template never mentioned.
      for (const prev of prevList) {
        if (!named.has(String(prev.method ?? ''))) out.push({ ...prev });
      }
      cell[cellSpec.list.name] = out;
      /**
       * AND THE PREVIEW SAYS SO. `cleared_fields` is the field that exists to
       * name what a file cleared, and a list clear left it empty — the one
       * screen an admin checks before applying showed no loss at all. The
       * removed routes are named too, because "every route" is not a list an
       * admin can read back off the file.
       */
      if (parsed.listCleared && result) {
        const listKey = `${g.name}.${it.index}.${cellName}.${cellSpec.list.name}`;
        result.cleared_fields.push(listKey);
        const dropped = storedList
          .map((x) => String(x.method ?? ''))
          .filter((m) => m && !named.has(m));
        if (dropped.length) {
          result.warnings.push(`${listKey}=${CLEAR_TOKEN} removed ${dropped.join(', ')}`);
        }
      }
    }
    kept.set(type, cell);
  }
  return [...kept.values()];
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
    const freshCells = buildCells(g, it, null, item, result);
    if (freshCells) item.fulfillments = freshCells;
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
        const mergedCells = buildCells(g, it, (base.fulfillments as LooseItem[]) ?? [], item, result);
        if (mergedCells) item.fulfillments = mergedCells;
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
 * The old option/color image columns are accepted as input, then immediately
 * projected into the canonical media list with one binding. External values
 * were removed by `planTemplateMedia` and wait for /apply; local /files values
 * can be represented in the pure preview without touching storage.
 */
function canonicalizeLegacyBoundMedia(
  parsed: ParsedTemplate,
  body: Record<string, unknown>
): void {
  const media = Array.isArray(body.media) ? (body.media as LooseItem[]) : [];

  // fetch_url is working state, never a ProductDoc field. Every locator and
  // byte-derived field beside it is storage-owned: a stale exported key or
  // width must not turn a remote import into a fake local row before apply
  // has fetched and verified the new bytes.
  for (const row of media) {
    const hasFetch = typeof row.fetch_url === 'string' && row.fetch_url.trim() !== '';
    delete row.fetch_url;
    if (hasFetch) {
      row.url = '';
      row.key = '';
      row.width = null;
      row.height = null;
      row.source_url = '';
      delete row.content_type;
      row.bytes = null;
      continue;
    }
    // A legacy hotlink being converted cannot survive in the preview merely
    // because merge-by-id supplied it as the existing value. It is absent
    // until apply materializes the local replacement; it is never written.
    if (typeof row.url === 'string' && row.url && !isOwnedMediaUrl(row.url)) {
      row.url = '';
      row.key = '';
    }
  }

  for (const group of ['options', 'colors'] as const) {
    const rows = Array.isArray(body[group]) ? (body[group] as LooseItem[]) : [];
    const parsedRows = parsed.groups[group] ?? [];
    parsedRows.forEach((item, position) => {
      const row = rows[position];
      if (!row) return;
      const local = item.fields.image;
      const hasFetch = parsed.media_to_fetch.some((x) => x.group === group && x.index === item.index);
      if (!local && !hasFetch) return;

      // A template write never perpetuates the duplicate legacy source.
      row.image = '';
      if (!local || typeof local.value !== 'string' || !isOwnedMediaUrl(local.value.trim())) return;

      const url = local.value.trim();
      const targetId = typeof row.id === 'string' ? row.id : '';
      if (!targetId) return;
      const binding = group === 'options' ? 'option_value_id' : 'color_id';
      const duplicate = media.some(
        (m) => m.url === url && m[binding] === targetId && !m[group === 'options' ? 'color_id' : 'option_value_id']
      );
      if (duplicate) return;
      media.push({
        id: generatedTemplateMediaId(group === 'options' ? 'option' : 'color', item.index, targetId),
        url,
        key: url.slice('/files/'.length),
        role: 'gallery',
        alt_ar: '',
        alt_en: '',
        alt_ckb: '',
        order: media.length,
        primary: false,
        width: null,
        height: null,
        source_url: '',
        option_value_id: group === 'options' ? targetId : '',
        color_id: group === 'colors' ? targetId : '',
        variant_id: '',
      });
    });
  }
  body.media = media;
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
  resolved?: ResolvedRefs,
  context: TemplateMergeContext = {}
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
        // 0079. CARRIED, like every other column the file may not mention.
        // Leaving them out would make an UPDATE that says nothing about the
        // usage text erase its Arabic and Kurdish while reporting it preserved.
        how_to_use_ar: existing.how_to_use_ar,
        how_to_use_ckb: existing.how_to_use_ckb,
        // Carried for the same reason: a file that says nothing about the
        // Gini link must not erase one somebody pasted in the admin.
        gini_url: existing.gini_url,
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
        dimensions: { ...existing.dimensions },
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
  if (context.variants) body.variants = context.variants.map((variant) => ({ ...variant }));
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
      // An import-only synonym (`how_to_use` for `how_to_use_en`) is a
      // SPELLING, not a value: reporting it as preserved would list the same
      // column twice in the apply report.
      if (existing && !REF_KEYS.has(spec.key) && spec.exported !== false) result.preserved_fields.push(spec.key);
      continue;
    }
    if (REF_KEYS.has(spec.key)) continue; // handled below via resolved refs
    if (pf.clear) {
      result.cleared_fields.push(spec.key);
    } else {
      result.applied_fields.push(spec.key);
    }
    switch (spec.key) {
      case 'how_to_use':
      case 'how_to_use_en':
        // Two spellings of ONE column. `aliasOf` is honoured only for the
        // fields of a repeated group (applyItemField), so the scalar synonym
        // is routed here by name instead. Registry order puts the legacy
        // spelling first, so a file carrying both lands on `how_to_use_en`.
        body.how_to_use = pf.value;
        break;
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
      case 'gini_url':
        body.gini_url = typeof pf.value === 'string' ? pf.value : '';
        break;
      case 'standard_delivery_enabled':
      case 'standard_delivery_quantity_step':
      case 'standard_delivery_fee_iqd':
      case 'personal_delivery_enabled':
      case 'personal_delivery_quantity_step':
      case 'personal_delivery_fee_iqd':
        // Folded into body.delivery_options immediately after this loop.
        break;
      default:
        if (DIMENSION_KEY_SET.has(spec.key)) {
          const dimensions = body.dimensions && typeof body.dimensions === 'object'
            ? { ...(body.dimensions as Record<string, unknown>) }
            : {};
          dimensions[spec.key] = pf.value;
          body.dimensions = dimensions;
        } else {
          body[spec.key] = pf.value;
        }
    }
  }

  const deliveryKeys = [
    'standard_delivery_enabled',
    'standard_delivery_quantity_step',
    'standard_delivery_fee_iqd',
    'personal_delivery_enabled',
    'personal_delivery_quantity_step',
    'personal_delivery_fee_iqd',
  ] as const;
  if (deliveryKeys.some((key) => parsed.fields[key])) {
    const previous = existing?.delivery_options ?? {
      standard: { enabled: false, quantity_step: 1, fee_iqd: 0 },
      personal: { enabled: false, quantity_step: 1, fee_iqd: 0 },
    };
    const value = <T,>(key: typeof deliveryKeys[number], fallback: T): T =>
      (parsed.fields[key]?.value === undefined ? fallback : parsed.fields[key].value) as T;
    body.delivery_options = {
      standard: {
        enabled: value('standard_delivery_enabled', previous.standard.enabled),
        quantity_step: value('standard_delivery_quantity_step', previous.standard.quantity_step),
        fee_iqd: value('standard_delivery_fee_iqd', previous.standard.fee_iqd),
      },
      personal: {
        enabled: value('personal_delivery_enabled', previous.personal.enabled),
        quantity_step: value('personal_delivery_quantity_step', previous.personal.quantity_step),
        fee_iqd: value('personal_delivery_fee_iqd', previous.personal.fee_iqd),
      },
    };
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
      if (pf.clear || pf.value === null) {
        delete merged[id];
        result.cleared_fields.push(`spec.${id}`);
      } else if (pf.value === '') {
        // Typed blank templates list every section-specific spec as an active
        // empty row. Empty therefore means "not supplied"; __CLEAR__ remains
        // the explicit way to remove a stored value.
        result.preserved_fields.push(`spec.${id}`);
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

  canonicalizeLegacyBoundMedia(parsed, body);

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
