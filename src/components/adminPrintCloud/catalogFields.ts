/**
 * THE CATALOGUE AS THE CONSOLE EDITS IT — a client-side mirror of
 * `ENTITIES` in worker/lib/printCloud/catalog.ts, FIELD FOR FIELD.
 *
 * The server's spec decides everything a write may carry: each field's kind,
 * whether it is required, its bounds, its allowed values, whether null clears
 * it, whether it is a PRICE (money scope, recorded in pc_price_changes) or a
 * COST (the owner's alone), and whether it may change after creation. This
 * file repeats those facts so the form can say them BEFORE a request — a
 * disabled price box for an assistant admin, a read-only code on edit, a
 * bound beside a number — and adds what only a screen needs: the label and
 * help in three languages, the unit, and which structured editor fits.
 *
 * It cannot drift silently: tests/printCloudAdminUi.test.ts imports both and
 * fails when a name, kind, required flag, bound, value list, nullability,
 * money, cost or immutable flag differs. The server re-checks every write
 * regardless (catalog.ts `validateField`, `assertWritable`).
 *
 * Pure data, no React: the test imports it.
 */
import { tri, type Tri } from './i18n';

export type FieldKind = 'string' | 'text' | 'code' | 'int' | 'bool' | 'enum' | 'iso' | 'json_array' | 'json_object' | 'ref';

/** Which list a `ref` field picks from (and which names the other sections print beside an id). */
export type RefSource = 'tiers' | 'packages' | 'printer_models' | 'agents' | 'categories' | 'products' | 'units' | 'variants';

/**
 * How a field is edited when its kind alone is not enough:
 *   duration        integer seconds, typed as hours and minutes
 *   microns         a list of whole micrometres (nozzle sizes)
 *   materials       material codes as chips (^[A-Za-z0-9+_-]{1,20}$)
 *   chips           free strings as chips
 *   modes           the fulfilment modes as check boxes
 *   bundle          bundled material lines {variant_id, qty, value_iqd}
 *   i18n            a {ar, en, ckb} text object (other keys kept)
 *   json            a validated JSON text box
 *   scope           a promotion's scope, built from a type and a target
 *   color           #RRGGBB with a swatch
 *   project_type    free text with the project types suggested
 */
export type FieldEditor = 'duration' | 'microns' | 'materials' | 'chips' | 'modes' | 'bundle' | 'i18n' | 'json' | 'scope' | 'color' | 'project_type';

export interface ClientField {
  name: string;
  kind: FieldKind;
  required?: boolean;
  min?: number;
  max?: number;
  values?: readonly string[];
  nullable?: boolean;
  money?: boolean;
  cost?: boolean;
  immutable?: boolean;
  label: Tri;
  help?: Tri;
  /** Shown after a number: IQD, mm, µm, W… */
  unit?: Tri;
  /** Whole dinars (rendered as money in lists). */
  iqd?: boolean;
  /** Basis points (1000 = 10 %): shown with the percentage beside it. */
  bps?: boolean;
  ref?: RefSource;
  editor?: FieldEditor;
  valueLabels?: Readonly<Record<string, Tri>>;
}

export type EntityKey =
  | 'tiers'
  | 'printer_models'
  | 'printers'
  | 'packages'
  | 'conversion_rules'
  | 'products'
  | 'variants'
  | 'promotions'
  | 'locations'
  | 'accessory_rules';

export interface ClientEntity {
  key: EntityKey;
  label: Tri;
  /** One sentence on what a row of this entity is. */
  help: Tri;
  fields: readonly ClientField[];
  /** The columns of the list, by field name (the first one names the row). */
  columns: readonly string[];
  /**
   * Creating a row needs money scope even though no single field says so:
   * registering a machine puts it on a tier's hours (catalog.ts
   * `createEntity`). Entities with a REQUIRED money field need it anyway.
   */
  createNeedsMoney?: boolean;
}

// ------------------------------------------------------------------ shared words

const IQD = tri('د.ع', 'IQD', 'د.ع');
const MM = tri('مم', 'mm', 'ملم');
const UM = tri('ميكرون', 'µm', 'مایکرۆن');
const ACTIVE = tri('فعّال', 'Active', 'چالاک');
/** A symbol, the same in every language. */
const CELSIUS = tri('°C', '°C', '°C');

const NAME_FIELDS: ClientField[] = [
  { name: 'name_ar', kind: 'string', required: true, max: 200, label: tri('الاسم بالعربية', 'Name (Arabic)', 'ناو بە عەرەبی') },
  { name: 'name_en', kind: 'string', required: true, max: 200, label: tri('الاسم بالإنجليزية', 'Name (English)', 'ناو بە ئینگلیزی') },
  { name: 'name_ckb', kind: 'string', required: true, max: 200, label: tri('الاسم بالكردية السورانية', 'Name (Sorani Kurdish)', 'ناو بە کوردیی سۆرانی') },
];

const codeField = (help: Tri): ClientField => ({
  name: 'code',
  kind: 'code',
  required: true,
  immutable: true,
  label: tri('الرمز', 'Code', 'کۆد'),
  help,
});

const FIXED_CODE = tri(
  'أحرف لاتينية وأرقام و . _ - ، ولا يتغيّر بعد الإنشاء',
  'Latin letters, digits and . _ -; it cannot change after creation',
  'پیتی لاتینی و ژمارە و . _ -؛ دوای دروستکردن ناگۆڕدرێت'
);

const DESCRIPTION: ClientField = {
  name: 'description_json',
  kind: 'json_object',
  editor: 'i18n',
  label: tri('الوصف', 'Description', 'وەسف'),
  help: tri('نص اختياري بثلاث لغات', 'Optional text in three languages', 'دەقێکی ئارەزوومەندانە بە سێ زمان'),
};

const LEVONIS_LINK = tri(
  'رابط فقط لصف في كتالوج Levonis؛ لا يُنسخ ولا يُزامَن شيء',
  'A link to a Levonis catalogue row only; nothing is copied or synced',
  'تەنها بەستەرێکە بۆ ڕیزێک لە کاتالۆگی Levonis؛ هیچ شتێک لەبەر ناگیرێتەوە و هاوکات ناکرێت'
);

// ------------------------------------------------------------------ the entities

export const CLIENT_ENTITIES: Readonly<Record<EntityKey, ClientEntity>> = {
  tiers: {
    key: 'tiers',
    label: tri('فئات الساعات', 'Hour tiers', 'پلەکانی کاتژمێر'),
    help: tri(
      'فئة ساعات طباعة بسعر للساعة؛ ساعات الفئة تشغّل طابعاتها فقط',
      'A class of printing hours with an hourly price; its hours run only its own printers',
      'پۆلێکی کاتژمێری چاپ بە نرخێک بۆ هەر کاتژمێرێک؛ کاتژمێرەکانی تەنها چاپکەرەکانی خۆی کار پێدەکەن'
    ),
    columns: ['code', 'name_en', 'hourly_rate_iqd', 'custom_hours_enabled', 'active'],
    fields: [
      codeField(FIXED_CODE),
      ...NAME_FIELDS,
      DESCRIPTION,
      {
        name: 'hourly_rate_iqd',
        kind: 'int',
        required: true,
        min: 0,
        max: 100_000_000,
        money: true,
        iqd: true,
        unit: IQD,
        label: tri('سعر الساعة', 'Hourly rate', 'نرخی کاتژمێرێک'),
        help: tri('سعر ساعة مخصّصة من هذه الفئة، بالدينار', 'The price of one custom hour of this tier, in dinars', 'نرخی یەک کاتژمێری تایبەت لەم پلەیە، بە دینار'),
      },
      {
        name: 'custom_hours_enabled',
        kind: 'bool',
        money: true,
        label: tri('السماح بساعات مخصّصة', 'Allow custom hours', 'ڕێگەدان بە کاتژمێری تایبەت'),
        help: tri('يشتري العميل عدد ساعات غير الباقات', 'Customers may buy a number of hours outside the packages', 'کڕیار دەتوانێت ژمارەیەک کاتژمێر جگە لە پاکێجەکان بکڕێت'),
      },
      {
        name: 'min_custom_seconds',
        kind: 'int',
        min: 60,
        max: 10_000_000,
        money: true,
        editor: 'duration',
        label: tri('أقل مدة مخصّصة', 'Shortest custom purchase', 'کەمترین ماوەی کڕینی تایبەت'),
      },
      {
        name: 'custom_step_seconds',
        kind: 'int',
        min: 60,
        max: 10_000_000,
        money: true,
        editor: 'duration',
        label: tri('خطوة المدة المخصّصة', 'Custom purchase step', 'هەنگاوی کڕینی تایبەت'),
      },
      {
        name: 'active',
        kind: 'bool',
        money: true,
        label: ACTIVE,
        help: tri('تفعيل الفئة يعيد فتح بيع ساعاتها وباقاتها', 'Switching a tier on reopens the sale of its hours and packages', 'چالاککردنی پلە فرۆشتنی کاتژمێر و پاکێجەکانی دەکاتەوە'),
      },
    ],
  },

  printer_models: {
    key: 'printer_models',
    label: tri('طرازات الطابعات', 'Printer models', 'مۆدێلەکانی چاپکەر'),
    help: tri(
      'مواصفات طراز وفئة الساعات التي تدفع ثمن مهامه',
      'A model’s specification and the hour tier that pays for its jobs',
      'تایبەتمەندیی مۆدێلێک و ئەو پلەی کاتژمێرەی پارەی کارەکانی دەدات'
    ),
    columns: ['model_name', 'brand', 'code', 'tier_id', 'active'],
    fields: [
      {
        name: 'tier_id',
        kind: 'ref',
        required: true,
        money: true,
        ref: 'tiers',
        label: tri('فئة الساعات', 'Hour tier', 'پلەی کاتژمێر'),
        help: tri('ساعات هذه الفئة تدفع ثمن كل مهمة على هذا الطراز', 'The tier whose hours pay for every job on this model', 'کاتژمێرەکانی ئەم پلەیە پارەی هەموو کارێکی ئەم مۆدێلە دەدەن'),
      },
      codeField(FIXED_CODE),
      { name: 'brand', kind: 'string', required: true, max: 80, label: tri('العلامة التجارية', 'Brand', 'براند') },
      { name: 'model_name', kind: 'string', required: true, max: 120, label: tri('اسم الطراز', 'Model name', 'ناوی مۆدێل') },
      { name: 'build_x_mm', kind: 'int', required: true, min: 1, max: 5000, unit: MM, label: tri('عرض منطقة الطباعة (X)', 'Build width (X)', 'پانیی ناوچەی چاپ (X)') },
      { name: 'build_y_mm', kind: 'int', required: true, min: 1, max: 5000, unit: MM, label: tri('عمق منطقة الطباعة (Y)', 'Build depth (Y)', 'قووڵیی ناوچەی چاپ (Y)') },
      { name: 'build_z_mm', kind: 'int', required: true, min: 1, max: 5000, unit: MM, label: tri('ارتفاع منطقة الطباعة (Z)', 'Build height (Z)', 'بەرزیی ناوچەی چاپ (Z)') },
      {
        name: 'nozzle_options_um',
        kind: 'json_array',
        editor: 'microns',
        unit: UM,
        label: tri('أقطار الفوهات المتاحة', 'Nozzle sizes offered', 'قەبارەکانی نۆزڵی بەردەست'),
        help: tri('بالميكرون، من 100 إلى 2000: ‏400 = ‏0.4 مم', 'In microns, 100 to 2000: 400 = 0.4 mm', 'بە مایکرۆن، لە 100 تا 2000: ‏400 = ‏0.4 ملم'),
      },
      {
        name: 'extruder_config',
        kind: 'enum',
        values: ['single', 'dual', 'idex', 'toolchanger'],
        label: tri('نظام الطارد', 'Extruder setup', 'سیستەمی دەرهێنەر'),
        valueLabels: {
          single: tri('طارد واحد', 'Single', 'یەک دەرهێنەر'),
          dual: tri('طاردان', 'Dual', 'دوو دەرهێنەر'),
          idex: tri('طاردان مستقلان (IDEX)', 'Independent dual (IDEX)', 'دوو دەرهێنەری سەربەخۆ (IDEX)'),
          toolchanger: tri('مبدّل أدوات', 'Tool changer', 'گۆڕەری ئامراز'),
        },
      },
      {
        name: 'ams_systems_json',
        kind: 'json_array',
        editor: 'chips',
        label: tri('وحدات تعدد الألوان', 'Multi-colour units', 'یەکەکانی فرەڕەنگی'),
        help: tri('أسماء الوحدات، مثل AMS 2 Pro', 'Unit names, e.g. AMS 2 Pro', 'ناوی یەکەکان، بۆ نموونە AMS 2 Pro'),
      },
      { name: 'max_colors', kind: 'int', min: 1, max: 64, label: tri('أقصى عدد ألوان', 'Maximum colours', 'زۆرترین ژمارەی ڕەنگ') },
      {
        name: 'supported_materials_json',
        kind: 'json_array',
        editor: 'materials',
        label: tri('المواد المدعومة', 'Supported materials', 'کەرەستە پشتگیریکراوەکان'),
        help: tri('رموز المواد مثل PLA وPETG؛ فارغة = بلا قيد', 'Material codes such as PLA, PETG; empty = no restriction', 'کۆدی کەرەستەکان وەک PLA و PETG؛ بەتاڵ = بێ سنوور'),
      },
      { name: 'max_nozzle_temp_c', kind: 'int', min: 0, max: 600, nullable: true, unit: CELSIUS, label: tri('أقصى حرارة للفوهة', 'Maximum nozzle temperature', 'زۆرترین پلەی گەرمیی نۆزڵ') },
      { name: 'max_bed_temp_c', kind: 'int', min: 0, max: 300, nullable: true, unit: CELSIUS, label: tri('أقصى حرارة للسرير', 'Maximum bed temperature', 'زۆرترین پلەی گەرمیی تەختە') },
      { name: 'enclosed', kind: 'bool', label: tri('حجرة طباعة مغلقة', 'Enclosed chamber', 'ژووری چاپی داخراو') },
      { name: 'camera', kind: 'bool', label: tri('كاميرا', 'Camera', 'کامێرا') },
      {
        name: 'average_power_w',
        kind: 'int',
        min: 0,
        max: 10000,
        unit: tri('واط', 'W', 'وات'),
        label: tri('متوسط استهلاك الكهرباء', 'Average power draw', 'تێکڕای بەکارهێنانی کارەبا'),
        help: tri('يُستعمل في تقدير كلفة الكهرباء في تقرير الربح', 'Used to estimate electricity in the profit report', 'بۆ خەمڵاندنی کارەبا لە ڕاپۆرتی قازانجدا بەکاردێت'),
      },
      {
        name: 'quality_rank',
        kind: 'int',
        min: 0,
        max: 100,
        label: tri('ترتيب الجودة', 'Quality rank', 'پلەی کوالیتی'),
        help: tri('من 0 إلى 100؛ يرتّب اقتراح الطابعات للعميل', '0 to 100; ranks the printer suggestions customers see', 'لە 0 تا 100؛ پێشنیاری چاپکەرەکان بۆ کڕیار ڕیز دەکات'),
      },
      { name: 'spec_json', kind: 'json_object', editor: 'json', label: tri('مواصفات إضافية', 'Extra specification', 'تایبەتمەندیی زیاتر'), help: tri('كائن JSON حر', 'A free JSON object', 'ئۆبجێکتێکی ئازادی JSON') },
      { name: 'levonis_product_id', kind: 'string', max: 80, nullable: true, label: tri('منتج Levonis المرتبط', 'Linked Levonis product', 'بەرهەمی پەیوەستکراوی Levonis'), help: LEVONIS_LINK },
      { name: 'active', kind: 'bool', label: ACTIVE },
    ],
  },

  printers: {
    key: 'printers',
    label: tri('الطابعات', 'Printers', 'چاپکەرەکان'),
    help: tri(
      'آلة فعلية في الورشة؛ تسجيلها يضعها على ساعات فئة طرازها',
      'A physical machine in the workshop; registering it puts it on its model’s tier hours',
      'ئامێرێکی ڕاستەقینە لە کارگەدا؛ تۆمارکردنی دەیخاتە سەر کاتژمێرەکانی پلەی مۆدێلەکەی'
    ),
    columns: ['name', 'model_id', 'status', 'adapter', 'location'],
    createNeedsMoney: true,
    fields: [
      { name: 'model_id', kind: 'ref', required: true, ref: 'printer_models', label: tri('الطراز', 'Model', 'مۆدێل'), help: tri('النقل إلى طراز من فئة أخرى يحتاج مديراً مالياً', 'Moving it to a model of another tier needs a full admin', 'گواستنەوەی بۆ مۆدێلێکی پلەیەکی تر پێویستی بە بەڕێوەبەری دارایی هەیە') },
      { name: 'name', kind: 'string', required: true, max: 120, label: tri('الاسم', 'Name', 'ناو') },
      { name: 'serial_number', kind: 'string', required: true, max: 120, label: tri('الرقم التسلسلي', 'Serial number', 'ژمارەی زنجیرە') },
      { name: 'equipment_code', kind: 'string', required: true, max: 80, label: tri('رمز المعدّة', 'Equipment code', 'کۆدی ئامێر') },
      { name: 'location', kind: 'string', max: 200, label: tri('الموقع في الورشة', 'Place in the workshop', 'شوێن لە کارگەدا') },
      { name: 'nozzle_um', kind: 'int', min: 100, max: 2000, unit: UM, label: tri('الفوهة المركّبة', 'Installed nozzle', 'نۆزڵی دامەزراو'), help: tri('‏400 = ‏0.4 مم', '400 = 0.4 mm', '‏400 = ‏0.4 ملم') },
      { name: 'ams_slots', kind: 'int', min: 0, max: 64, label: tri('خانات الألوان', 'Colour slots', 'خانەکانی ڕەنگ') },
      {
        name: 'materials_json',
        kind: 'json_array',
        editor: 'materials',
        label: tri('المواد القابلة للتحميل', 'Loadable materials', 'کەرەستە بارکراوەکان'),
        help: tri('فارغة = أي مادة يدعمها الطراز', 'Empty = any material the model supports', 'بەتاڵ = هەر کەرەستەیەک مۆدێلەکە پشتگیری بکات'),
      },
      { name: 'camera', kind: 'bool', label: tri('كاميرا', 'Camera', 'کامێرا') },
      {
        name: 'status',
        kind: 'enum',
        values: ['active', 'maintenance', 'retired'],
        label: tri('الحالة الإدارية', 'Administrative status', 'دۆخی کارگێڕی'),
        help: tri('الصيانة وخارج الخدمة لا تُسند إليهما مهام', 'Maintenance and retired machines are never given work', 'ئامێری لە چاکسازی و دەرچوو لە خزمەت هیچ کارێکیان پێ نادرێت'),
        valueLabels: {
          active: tri('في الخدمة', 'In service', 'لە خزمەتدایە'),
          maintenance: tri('صيانة', 'Maintenance', 'چاکسازی'),
          retired: tri('خارج الخدمة', 'Retired', 'لە خزمەت دەرچووە'),
        },
      },
      {
        name: 'adapter',
        kind: 'enum',
        values: ['manual', 'agent'],
        label: tri('طريقة التحكم', 'Control', 'شێوازی کۆنترۆڵ'),
        help: tri('طابعة الوكيل لا تأخذ عملاً إلا بقراءات حديثة', 'An agent printer takes work only with fresh readings', 'چاپکەری بریکار تەنها بە خوێندنەوەی نوێ کار وەردەگرێت'),
        valueLabels: {
          manual: tri('يدوي (مشغّل)', 'Manual (operator)', 'دەستی (کارپێکەر)'),
          agent: tri('وكيل الورشة', 'Workshop agent', 'بریکاری کارگە'),
        },
      },
      {
        name: 'connection_ref',
        kind: 'string',
        max: 200,
        label: tri('مرجع الاتصال', 'Connection reference', 'سەرچاوەی پەیوەندی'),
        help: tri('اسم يفهمه الوكيل فقط؛ لا تضع كلمة مرور هنا أبداً', 'A name only the agent understands; never put a password here', 'ناوێک کە تەنها بریکار تێیدەگات؛ هەرگیز وشەی نهێنی لێرە دامەنێ'),
      },
      { name: 'agent_id', kind: 'ref', nullable: true, ref: 'agents', label: tri('الوكيل المرتبط', 'Bound agent', 'بریکاری بەستراو') },
      { name: 'acquisition_cost_iqd', kind: 'int', min: 0, max: 10_000_000_000, cost: true, nullable: true, iqd: true, unit: IQD, label: tri('تكلفة الشراء', 'Purchase cost', 'تێچووی کڕین') },
      { name: 'acquired_at', kind: 'iso', cost: true, nullable: true, label: tri('تاريخ الشراء', 'Purchased on', 'بەرواری کڕین') },
      { name: 'expected_life_hours', kind: 'int', min: 1, max: 1_000_000, cost: true, nullable: true, unit: tri('ساعة', 'hours', 'کاتژمێر'), label: tri('العمر المتوقع', 'Expected life', 'تەمەنی چاوەڕوانکراو') },
      { name: 'residual_value_iqd', kind: 'int', min: 0, max: 10_000_000_000, cost: true, nullable: true, iqd: true, unit: IQD, label: tri('القيمة المتبقية', 'Residual value', 'بەهای ماوە') },
      { name: 'maintenance_reserve_iqd_per_hour', kind: 'int', min: 0, max: 10_000_000, cost: true, iqd: true, unit: tri('د.ع / ساعة', 'IQD / hour', 'د.ع / کاتژمێر'), label: tri('احتياطي الصيانة لكل ساعة', 'Maintenance reserve per hour', 'یەدەگی چاکسازی بۆ هەر کاتژمێرێک') },
      { name: 'notes', kind: 'text', max: 2000, label: tri('ملاحظات', 'Notes', 'تێبینییەکان') },
    ],
  },

  packages: {
    key: 'packages',
    label: tri('باقات الساعات', 'Hour packages', 'پاکێجەکانی کاتژمێر'),
    help: tri(
      'ساعات من فئة واحدة بسعر، بحدود ومهلة اختيارية',
      'Hours of one tier for a price, with limits and an optional expiry',
      'کاتژمێری یەک پلە بە نرخێک، لەگەڵ سنوور و بەسەرچوونێکی ئارەزوومەندانە'
    ),
    columns: ['code', 'name_en', 'tier_id', 'seconds', 'price_iqd', 'active'],
    fields: [
      { name: 'tier_id', kind: 'ref', required: true, immutable: true, ref: 'tiers', label: tri('فئة الساعات', 'Hour tier', 'پلەی کاتژمێر') },
      codeField(FIXED_CODE),
      ...NAME_FIELDS,
      {
        name: 'kind',
        kind: 'enum',
        values: ['standard', 'promotional', 'bundle'],
        label: tri('النوع', 'Kind', 'جۆر'),
        valueLabels: {
          standard: tri('عادية', 'Standard', 'ئاسایی'),
          promotional: tri('ترويجية', 'Promotional', 'بانگەشەیی'),
          bundle: tri('حزمة مع مواد', 'Bundle with material', 'پاکێج لەگەڵ کەرەستە'),
        },
      },
      {
        name: 'seconds',
        kind: 'int',
        required: true,
        min: 60,
        max: 100_000_000,
        immutable: true,
        editor: 'duration',
        label: tri('مدة الباقة', 'Hours in the package', 'ماوەی پاکێجەکە'),
        help: tri('لا تتغيّر بعد الإنشاء: هي ما اشتراه العملاء', 'Fixed after creation: it is what customers bought', 'دوای دروستکردن ناگۆڕدرێت: ئەوەیە کە کڕیاران کڕیویانە'),
      },
      { name: 'price_iqd', kind: 'int', required: true, min: 0, max: 1_000_000_000, money: true, iqd: true, unit: IQD, label: tri('السعر', 'Price', 'نرخ') },
      { name: 'min_quantity', kind: 'int', min: 1, max: 1000, money: true, label: tri('أقل كمية في الطلب', 'Minimum per order', 'کەمترین بڕ لە داواکارییەکدا') },
      { name: 'max_quantity', kind: 'int', min: 1, max: 1000, money: true, label: tri('أقصى كمية في الطلب', 'Maximum per order', 'زۆرترین بڕ لە داواکارییەکدا') },
      {
        name: 'max_per_customer',
        kind: 'int',
        min: 1,
        max: 100_000,
        money: true,
        nullable: true,
        label: tri('الحد لكل عميل', 'Limit per customer', 'سنوور بۆ هەر کڕیارێک'),
        help: tri('فارغ = بلا حد', 'Empty = no limit', 'بەتاڵ = بێ سنوور'),
      },
      {
        name: 'expires_after_days',
        kind: 'int',
        min: 1,
        max: 3650,
        money: true,
        nullable: true,
        unit: tri('يوم', 'days', 'ڕۆژ'),
        label: tri('تنتهي الساعات بعد', 'Hours expire after', 'کاتژمێرەکان بەسەردەچن دوای'),
        help: tri(
          'فارغ = لا تنتهي أبداً؛ إن ضُبطت تُعرض للعميل قبل الشراء',
          'Empty = never expire; when set, customers are told before buying',
          'بەتاڵ = هەرگیز بەسەرناچن؛ ئەگەر دابنرێت، پێش کڕین بە کڕیار دەوترێت'
        ),
      },
      {
        name: 'bundle_json',
        kind: 'json_array',
        money: true,
        editor: 'bundle',
        label: tri('مواد مرفقة', 'Bundled material', 'کەرەستەی هاوپێچ'),
        help: tri(
          'مواد تُمنح مع الساعات، بقيمة معلنة من سعر الباقة',
          'Material granted with the hours, at a declared share of the package price',
          'کەرەستە کە لەگەڵ کاتژمێرەکان دەدرێت، بە بەهایەکی ڕاگەیەندراو لە نرخی پاکێجەکە'
        ),
      },
      { name: 'valid_from', kind: 'iso', money: true, nullable: true, label: tri('متاحة من', 'Available from', 'بەردەستە لە') },
      { name: 'valid_until', kind: 'iso', money: true, nullable: true, label: tri('متاحة حتى', 'Available until', 'بەردەستە تا') },
      { name: 'sort', kind: 'int', min: -1000, max: 1000, label: tri('الترتيب', 'Sort order', 'ڕیزبەندی') },
      { name: 'active', kind: 'bool', money: true, label: ACTIVE },
    ],
  },

  conversion_rules: {
    key: 'conversion_rules',
    label: tri('قواعد تحويل الساعات', 'Hour conversion rules', 'یاساکانی گۆڕینی کاتژمێر'),
    help: tri(
      'يحوّل العميل ساعات فئة إلى أخرى بنسبة؛ معطّلة حتى يفعّلها مالك',
      'Customers move hours from one tier to another at a ratio; off until switched on',
      'کڕیار کاتژمێری پلەیەک بە ڕێژەیەک دەگوازێتەوە بۆ پلەیەکی تر؛ تا چالاک نەکرێت کوژاوەیە'
    ),
    columns: ['from_tier_id', 'to_tier_id', 'ratio_num', 'ratio_den', 'enabled'],
    fields: [
      { name: 'from_tier_id', kind: 'ref', required: true, immutable: true, ref: 'tiers', label: tri('من فئة', 'From tier', 'لە پلەی') },
      { name: 'to_tier_id', kind: 'ref', required: true, immutable: true, ref: 'tiers', label: tri('إلى فئة', 'To tier', 'بۆ پلەی') },
      {
        name: 'ratio_num',
        kind: 'int',
        required: true,
        min: 1,
        max: 1_000_000,
        money: true,
        label: tri('البسط', 'Ratio numerator', 'سەرەوەی ڕێژە'),
        help: tri(
          'الساعات الناتجة = الساعات × البسط ÷ المقام، بالتقريب للأسفل',
          'Hours received = hours × numerator ÷ denominator, rounded down',
          'کاتژمێری وەرگیراو = کاتژمێر × سەرەوە ÷ خوارەوە، بەرەو خوار خڕکراو'
        ),
      },
      { name: 'ratio_den', kind: 'int', required: true, min: 1, max: 1_000_000, money: true, label: tri('المقام', 'Ratio denominator', 'خوارەوەی ڕێژە') },
      {
        name: 'enabled',
        kind: 'bool',
        money: true,
        label: tri('مفعّلة', 'Enabled', 'چالاککراو'),
        help: tri('لا تنتقل الساعات بين الفئات بصمت أبداً', 'Hours never move between tiers silently', 'کاتژمێر هەرگیز بە بێدەنگی لە نێوان پلەکان ناگوازرێتەوە'),
      },
    ],
  },

  products: {
    key: 'products',
    label: tri('المنتجات', 'Products', 'بەرهەمەکان'),
    help: tri(
      'خيط أو ملحق أو أداة؛ تُباع أصنافه بالوحدة',
      'A filament, an accessory or a tool; its variants are what is sold',
      'فیلامێنت یان پاشکۆ یان ئامراز؛ جۆرەکانی ئەوەن کە دەفرۆشرێن'
    ),
    columns: ['name_en', 'category_code', 'brand', 'material', 'active'],
    fields: [
      { name: 'category_code', kind: 'ref', required: true, ref: 'categories', label: tri('الفئة', 'Category', 'پۆل') },
      { name: 'brand', kind: 'string', max: 80, label: tri('العلامة التجارية', 'Brand', 'براند') },
      ...NAME_FIELDS,
      DESCRIPTION,
      { name: 'material', kind: 'string', max: 40, nullable: true, label: tri('المادة', 'Material', 'کەرەستە'), help: tri('للخيوط: PLA أو PETG…', 'For filaments: PLA, PETG…', 'بۆ فیلامێنت: PLA یان PETG…') },
      { name: 'grade', kind: 'string', max: 40, nullable: true, label: tri('الدرجة', 'Grade', 'ئاست'), help: tri('مثل Basic أو Matte أو Silk', 'Such as Basic, Matte, Silk', 'وەک Basic یان Matte یان Silk') },
      { name: 'tags_json', kind: 'json_array', editor: 'chips', label: tri('الوسوم', 'Tags', 'تاگەکان') },
      { name: 'levonis_product_id', kind: 'string', max: 80, nullable: true, label: tri('منتج Levonis المرتبط', 'Linked Levonis product', 'بەرهەمی پەیوەستکراوی Levonis'), help: LEVONIS_LINK },
      { name: 'active', kind: 'bool', label: ACTIVE },
    ],
  },

  variants: {
    key: 'variants',
    label: tri('الأصناف', 'Variants', 'جۆرەکان'),
    help: tri(
      'لون أو مقاس من منتج، بوحدة واحدة تُعد بها كل أرصدته',
      'A colour or size of a product, with ONE unit every balance of it is counted in',
      'ڕەنگ یان قەبارەیەکی بەرهەم، بە یەک یەکە کە هەموو باڵانسەکانی پێی دەژمێردرێن'
    ),
    columns: ['sku', 'name_en', 'product_id', 'unit_code', 'active'],
    fields: [
      { name: 'product_id', kind: 'ref', required: true, immutable: true, ref: 'products', label: tri('المنتج', 'Product', 'بەرهەم') },
      { name: 'sku', kind: 'code', required: true, immutable: true, label: tri('رمز SKU', 'SKU', 'کۆدی SKU'), help: FIXED_CODE },
      ...NAME_FIELDS,
      { name: 'color_name', kind: 'string', max: 80, label: tri('اسم اللون', 'Colour name', 'ناوی ڕەنگ') },
      { name: 'color_hex', kind: 'string', max: 9, editor: 'color', label: tri('رمز اللون', 'Colour code', 'کۆدی ڕەنگ'), help: tri('بصيغة ‎#RRGGBB أو فارغ', 'As #RRGGBB, or empty', 'بە شێوەی #RRGGBB، یان بەتاڵ') },
      { name: 'diameter_um', kind: 'int', min: 100, max: 5000, nullable: true, unit: UM, label: tri('قطر الخيط', 'Filament diameter', 'تیرەی فیلامێنت'), help: tri('‏1750 = ‏1.75 مم', '1750 = 1.75 mm', '‏1750 = ‏1.75 ملم') },
      {
        name: 'unit_code',
        kind: 'ref',
        required: true,
        immutable: true,
        ref: 'units',
        label: tri('وحدة القياس', 'Unit', 'یەکەی پێوان'),
        help: tri('كل أرصدة هذا الصنف تُعد بها؛ لا تتغيّر بعد الإنشاء', 'Every balance of this variant is counted in it; fixed at creation', 'هەموو باڵانسەکانی ئەم جۆرە پێی دەژمێردرێن؛ دوای دروستکردن ناگۆڕدرێت'),
      },
      { name: 'min_purchase_qty', kind: 'int', min: 1, max: 10_000_000, label: tri('أقل كمية شراء', 'Minimum purchase', 'کەمترین بڕی کڕین') },
      { name: 'purchase_step_qty', kind: 'int', min: 1, max: 10_000_000, label: tri('خطوة الشراء', 'Purchase step', 'هەنگاوی کڕین') },
      { name: 'max_purchase_qty', kind: 'int', min: 1, max: 10_000_000, label: tri('أقصى كمية شراء', 'Maximum purchase', 'زۆرترین بڕی کڕین') },
      { name: 'max_per_customer_qty', kind: 'int', min: 1, max: 100_000_000, nullable: true, label: tri('الحد لكل عميل', 'Limit per customer', 'سنوور بۆ هەر کڕیارێک'), help: tri('فارغ = بلا حد', 'Empty = no limit', 'بەتاڵ = بێ سنوور') },
      {
        name: 'fulfillment_modes_json',
        kind: 'json_array',
        editor: 'modes',
        label: tri('طرق التسليم المسموحة', 'Allowed fulfilment', 'شێوازەکانی گەیاندنی ڕێگەپێدراو'),
        help: tri('واحدة على الأقل', 'At least one', 'لانیکەم یەکێک'),
      },
      { name: 'low_stock_threshold_qty', kind: 'int', min: 0, max: 100_000_000, label: tri('حد انخفاض المخزون', 'Low-stock threshold', 'سنووری کەمیی کۆگا') },
      { name: 'attributes_json', kind: 'json_object', editor: 'json', label: tri('خصائص إضافية', 'Extra attributes', 'تایبەتمەندیی زیاتر'), help: tri('كائن JSON حر', 'A free JSON object', 'ئۆبجێکتێکی ئازادی JSON') },
      { name: 'levonis_variant_ref', kind: 'string', max: 120, nullable: true, label: tri('مرجع صنف Levonis', 'Linked Levonis variant', 'جۆری پەیوەستکراوی Levonis'), help: LEVONIS_LINK },
      { name: 'active', kind: 'bool', label: ACTIVE },
    ],
  },

  promotions: {
    key: 'promotions',
    label: tri('العروض', 'Promotions', 'ئۆفەرەکان'),
    help: tri(
      'خصم بنسبة أو مبلغ على نطاق، تلقائي أو برمز',
      'A percentage or amount off a scope, automatic or by code',
      'داشکاندنێک بە ڕێژە یان بڕ لەسەر بوارێک، خۆکار یان بە کۆد'
    ),
    columns: ['name_en', 'code', 'scope', 'percent_bps', 'amount_off_iqd', 'active'],
    fields: [
      {
        name: 'code',
        kind: 'code',
        immutable: true,
        nullable: true,
        label: tri('الرمز', 'Code', 'کۆد'),
        help: tri('فارغ = يُطبَّق تلقائياً على كل من في النطاق', 'Empty = applies automatically to everyone in scope', 'بەتاڵ = خۆکارانە بۆ هەموو ئەوانەی لە بوارەکەدان جێبەجێ دەبێت'),
      },
      ...NAME_FIELDS,
      { name: 'scope', kind: 'string', required: true, max: 80, money: true, editor: 'scope', label: tri('النطاق', 'Scope', 'بوار') },
      { name: 'percent_bps', kind: 'int', min: 0, max: 10000, money: true, bps: true, label: tri('نسبة الخصم', 'Percent off', 'ڕێژەی داشکاندن'), help: tri('بنقاط الأساس: ‏1000 = ‏10٪', 'In basis points: 1000 = 10%', 'بە خاڵی بنەڕەت: ‏1000 = ‏10٪') },
      { name: 'amount_off_iqd', kind: 'int', min: 0, max: 100_000_000, money: true, iqd: true, unit: IQD, label: tri('مبلغ الخصم', 'Amount off', 'بڕی داشکاندن') },
      { name: 'min_subtotal_iqd', kind: 'int', min: 0, max: 1_000_000_000, money: true, iqd: true, unit: IQD, label: tri('أقل مجموع للطلب', 'Minimum subtotal', 'کەمترین کۆی داواکاری') },
      {
        name: 'membership',
        kind: 'string',
        max: 40,
        money: true,
        nullable: true,
        label: tri('العضوية المطلوبة', 'Membership required', 'ئەندامێتیی پێویست'),
        help: tri(
          'محوّل العضويات غير متصل: عرض مقيّد بعضوية لا يُطبَّق على أحد',
          'The membership adapter is not connected: an offer limited to a membership applies to no one',
          'ئەداپتەری ئەندامێتی پەیوەست نییە: ئۆفەرێکی سنووردار بە ئەندامێتی بۆ هیچ کەس جێبەجێ نابێت'
        ),
      },
      { name: 'starts_at', kind: 'iso', money: true, nullable: true, label: tri('يبدأ في', 'Starts at', 'دەستپێدەکات لە') },
      { name: 'ends_at', kind: 'iso', money: true, nullable: true, label: tri('ينتهي في', 'Ends at', 'کۆتایی دێت لە') },
      { name: 'max_redemptions', kind: 'int', min: 1, max: 10_000_000, money: true, nullable: true, label: tri('أقصى عدد استخدامات', 'Maximum redemptions', 'زۆرترین ژمارەی بەکارهێنان'), help: tri('فارغ = بلا حد', 'Empty = no limit', 'بەتاڵ = بێ سنوور') },
      { name: 'active', kind: 'bool', money: true, label: ACTIVE },
    ],
  },

  locations: {
    key: 'locations',
    label: tri('مواقع المستودع', 'Warehouse locations', 'شوێنەکانی کۆگا'),
    help: tri('رف أو خزانة تُستلم فيها الدفعات', 'A rack or cabinet lots are received into', 'ڕەف یان کابینەیەک کە کۆمەڵەکانی تێدا وەردەگیرێن'),
    columns: ['code', 'name', 'active'],
    fields: [
      codeField(FIXED_CODE),
      { name: 'name', kind: 'string', required: true, max: 120, label: tri('الاسم', 'Name', 'ناو') },
      { name: 'active', kind: 'bool', label: ACTIVE },
    ],
  },

  accessory_rules: {
    key: 'accessory_rules',
    label: tri('قواعد اقتراح الملحقات', 'Accessory suggestion rules', 'یاساکانی پێشنیاری پاشکۆ'),
    help: tri(
      'كلمة أو نوع مشروع يقترح على العميل ملحقاً (حلقات للميداليات…)',
      'A keyword or project type that suggests an accessory to customers (rings for keychains…)',
      'وشەیەک یان جۆرێکی پرۆژە کە پاشکۆیەک بە کڕیار پێشنیار دەکات (ئەڵقە بۆ کلیلدان…)'
    ),
    columns: ['keyword', 'project_type', 'variant_id', 'qty_per_item', 'active'],
    fields: [
      {
        name: 'keyword',
        kind: 'string',
        max: 60,
        label: tri('الكلمة المفتاحية', 'Keyword', 'وشەی سەرەکی'),
        help: tri('تُطابَق مع أسماء النماذج ووسومها؛ هي أو نوع المشروع مطلوب', 'Matched against model names and tags; it or the project type is required', 'لەگەڵ ناو و تاگی مۆدێلەکان بەراورد دەکرێت؛ ئەم یان جۆری پرۆژە پێویستە'),
      },
      { name: 'project_type', kind: 'string', max: 40, editor: 'project_type', label: tri('نوع المشروع', 'Project type', 'جۆری پرۆژە') },
      { name: 'variant_id', kind: 'ref', required: true, ref: 'variants', label: tri('الملحق المقترح', 'Suggested accessory', 'پاشکۆی پێشنیارکراو') },
      { name: 'qty_per_item', kind: 'int', min: 1, max: 1000, label: tri('الكمية لكل قطعة', 'Quantity per item', 'بڕ بۆ هەر پارچەیەک') },
      { name: 'needs_pause_at_layer', kind: 'bool', label: tri('يتطلب إيقافاً عند طبقة', 'Needs a pause at a layer', 'پێویستی بە ڕاگرتن لە چینێکدا هەیە') },
      { name: 'note_ar', kind: 'text', max: 500, label: tri('ملاحظة بالعربية', 'Note (Arabic)', 'تێبینی بە عەرەبی') },
      { name: 'note_en', kind: 'text', max: 500, label: tri('ملاحظة بالإنجليزية', 'Note (English)', 'تێبینی بە ئینگلیزی') },
      { name: 'note_ckb', kind: 'text', max: 500, label: tri('ملاحظة بالكردية السورانية', 'Note (Sorani Kurdish)', 'تێبینی بە کوردیی سۆرانی') },
      { name: 'active', kind: 'bool', label: ACTIVE },
    ],
  },
};

export const ENTITY_ORDER: readonly EntityKey[] = [
  'tiers',
  'printer_models',
  'printers',
  'packages',
  'conversion_rules',
  'products',
  'variants',
  'promotions',
  'locations',
  'accessory_rules',
];

/** The fulfilment modes a variant may allow (catalog.ts `crossCheck`). */
export const FULFILMENT_MODES: Readonly<Record<string, Tri>> = {
  inventory: tri('تبقى في الورشة للعميل', 'Kept in the workshop for the customer', 'لە کارگە بۆ کڕیار دەمێنێتەوە'),
  delivery: tri('توصيل للمنزل', 'Home delivery', 'گەیاندن بۆ ماڵ'),
  project: tri('مخصّصة لمشروع طباعة', 'Earmarked for a print project', 'تایبەت بە پرۆژەیەکی چاپ'),
};

/** The project types a customer picks (worker/lib/printCloud/projects.ts `PROJECT_TYPES`). */
export const PROJECT_TYPES: Readonly<Record<string, Tri>> = {
  generic: tri('عام', 'Generic', 'گشتی'),
  keychain: tri('ميدالية مفاتيح', 'Keychain', 'کلیلدان'),
  medal: tri('ميدالية', 'Medal', 'میدالیا'),
  magnetic: tri('مغناطيسي', 'Magnetic', 'موگناتیسی'),
  nfc: tri('شريحة NFC', 'NFC tag', 'تاگی NFC'),
  led: tri('إضاءة LED', 'LED', 'ڕووناکیی LED'),
  nameplate: tri('لوحة اسم', 'Name plate', 'تابلۆی ناو'),
  storage: tri('تخزين', 'Storage', 'هەڵگرتن'),
  holder: tri('حامل', 'Holder', 'هەڵگر'),
  figure: tri('مجسّم', 'Figure', 'پەیکەر'),
  mechanical: tri('ميكانيكي', 'Mechanical', 'میکانیکی'),
};

/** A promotion's scope, as catalog.ts `crossCheck` accepts it. */
export const SCOPE_TYPES: Readonly<Record<string, Tri>> = {
  all: tri('كل شيء', 'Everything', 'هەموو شتێک'),
  credits: tri('ساعات الطباعة', 'Printing hours', 'کاتژمێرەکانی چاپ'),
  materials: tri('المواد', 'Materials', 'کەرەستەکان'),
  tier: tri('فئة ساعات محددة', 'One hour tier', 'یەک پلەی کاتژمێر'),
  variant: tri('صنف محدد', 'One variant', 'یەک جۆر'),
  category: tri('فئة منتجات', 'A product category', 'پۆلێکی بەرهەم'),
};

export const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const REF_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
export const MATERIAL_RE = /^[A-Za-z0-9+_-]{1,20}$/;
export const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
export const SCOPE_RE = /^(all|credits|materials|tier:[A-Za-z0-9_.:-]+|variant:[A-Za-z0-9_.:-]+|category:[a-z_]+)$/;

/** May this admin create a row of this entity? (A required price field, or a machine registration, needs money scope.) */
export function canCreate(entity: ClientEntity, money: boolean): boolean {
  if (money) return true;
  if (entity.createNeedsMoney) return false;
  return !entity.fields.some((f) => f.required && f.money);
}
