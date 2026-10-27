/**
 * EVERY PRINT CLOUD SETTING, AS THE CONSOLE EDITS IT — one entry per key of
 * `PrintCloudConfig` (worker/lib/printCloud/settings.ts), with the bounds
 * `normalizeConfig` enforces and the unit a person reads it in.
 *
 * The server refuses a value out of range (`assertKept`: VALIDATION, never a
 * silent default), so these bounds only let the form say so first.
 * tests/printCloudAdminUi.test.ts reads `DEFAULT_CONFIG` and the `clampInt`
 * calls of `normalizeConfig` and fails when a key is missing here or a bound
 * differs. `cost_*` keys are the owner's (`COST_SETTING_KEYS`).
 *
 * Pure data, no React: the test imports it.
 */
import { tri, type Tri, FAILURE_POLICY, OVERAGE } from './i18n';

export type SettingUnit = 'minutes' | 'seconds' | 'iqd' | 'grams' | 'bytes' | 'jobs' | 'iqd_per_kwh';

export interface SettingField {
  /** The key, dotted for a nested one: `delivery.flat_fee_iqd`, `failure_policy.workshop`. */
  path: string;
  kind: 'bool' | 'int' | 'enum' | 'governorate_fees' | 'providers';
  min?: number;
  max?: number;
  values?: readonly string[];
  valueLabels?: Readonly<Record<string, Tri>>;
  unit?: SettingUnit;
  /** Owner data: shown to a cost reader, editable by a cost writer. */
  cost?: boolean;
  /** The owner's own switch (opening the service). */
  ownerOnly?: boolean;
  label: Tri;
  help?: Tri;
}

export interface SettingGroup {
  id: string;
  label: Tri;
  fields: readonly SettingField[];
}

export const UNIT_LABEL: Readonly<Record<SettingUnit, Tri>> = {
  minutes: tri('دقيقة', 'min', 'خولەک'),
  seconds: tri('ثانية', 's', 'چرکە'),
  iqd: tri('د.ع', 'IQD', 'د.ع'),
  grams: tri('غ', 'g', 'گرام'),
  bytes: tri('ميغابايت', 'MB', 'مێگابایت'),
  jobs: tri('مهمة', 'jobs', 'کار'),
  iqd_per_kwh: tri('د.ع / كيلوواط ساعة', 'IQD / kWh', 'د.ع / کیلۆوات کاتژمێر'),
};

/** The largest model file the gateway accepts, whatever the settings say (settings.ts `MODEL_UPLOAD_CEILING_BYTES`). */
export const MODEL_UPLOAD_CEILING_BYTES = 40 * 1024 * 1024;

const POLICIES = ['no_charge', 'charge_printed', 'manual_review'] as const;
const OVERAGES = ['cap_at_reserved', 'charge_from_balance'] as const;

export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: 'service',
    label: tri('الخدمة', 'The service', 'خزمەتگوزارییەکە'),
    fields: [
      {
        path: 'enabled',
        kind: 'bool',
        ownerOnly: true,
        label: tri('مفتوحة للعملاء', 'Open to customers', 'بۆ کڕیاران کراوەیە'),
        help: tri(
          'مغلقة: كل أبواب العملاء تجيب «غير مفتوحة بعد» لأي أحد عدا مديري المنصة',
          'Closed: every customer door answers “not open yet” to anyone but platform admins',
          'داخراو: هەموو دەرگاکانی کڕیار بە هەر کەسێک دەڵێن «هێشتا نەکراوەتەوە» جگە لە بەڕێوەبەرانی پلاتفۆرم'
        ),
      },
      {
        path: 'wallet_payment_enabled',
        kind: 'bool',
        label: tri('الدفع من محفظة Levonis', 'Payment from the Levonis wallet', 'پارەدان لە جزدانی Levonis'),
        help: tri(
          'مطفأ: لا يدفع العملاء من محافظهم؛ واسترداد ما دُفع منها يعود إليها كما هو',
          'Off: customers cannot pay from their wallet; refunds of what was paid from it still go back to it',
          'کوژاوە: کڕیاران ناتوانن لە جزدانەکەیان پارە بدەن؛ گەڕاندنەوەی ئەوەی لێی دراوە هێشتا بۆی دەگەڕێتەوە'
        ),
      },
    ],
  },
  {
    id: 'holds',
    label: tri('العروض والحجوزات', 'Quotes and holds', 'نرخدان و گلدانەوە'),
    fields: [
      {
        path: 'quote_ttl_minutes',
        kind: 'int',
        min: 5,
        max: 24 * 60,
        unit: 'minutes',
        label: tri('صلاحية عرض السعر', 'Quote lifetime', 'ماوەی نرخدان'),
        help: tri('يدفع العميل السعر الذي وافق عليه ما دام العرض صالحاً', 'Customers pay the price they approved while the quote lives', 'کڕیار ئەو نرخە دەدات کە پەسەندی کرد تا نرخدانەکە ماوە'),
      },
      {
        path: 'stock_hold_minutes',
        kind: 'int',
        min: 5,
        max: 7 * 24 * 60,
        unit: 'minutes',
        label: tri('حجز المخزون لطلب غير مدفوع', 'Stock hold for an unpaid order', 'گلدانەوەی کۆگا بۆ داواکارییەکی پارە نەدراو'),
      },
      {
        path: 'confirmation_ttl_minutes',
        kind: 'int',
        min: 5,
        max: 7 * 24 * 60,
        unit: 'minutes',
        label: tri('مهلة تأكيد العميل لمهمة', 'Time for a customer to confirm a job', 'ماوەی دڵنیاکردنەوەی کڕیار بۆ کارێک'),
      },
    ],
  },
  {
    id: 'pricing',
    label: tri('تسعير المواد', 'Material pricing', 'نرخی کەرەستە'),
    fields: [
      {
        path: 'material_price_rounding_iqd',
        kind: 'int',
        min: 0,
        max: 5000,
        unit: 'iqd',
        label: tri('تقريب سعر الكمية المخصّصة', 'Rounding of a custom quantity', 'خڕکردنەوەی نرخی بڕی تایبەت'),
        help: tri(
          'يُقرَّب للأعلى إلى هذه الخطوة؛ أسعار العبوات لا تُقرَّب أبداً',
          'Rounded UP to this step; pack prices are never rounded',
          'بەرەو سەر بۆ ئەم هەنگاوە خڕ دەکرێتەوە؛ نرخی پاکەتەکان هەرگیز خڕ ناکرێنەوە'
        ),
      },
      {
        path: 'cap_custom_price_at_next_pack',
        kind: 'bool',
        label: tri('لا يتجاوز سعر العبوة التالية', 'Never above the next pack', 'هەرگیز لە پاکەتی دواتر گرانتر نییە'),
        help: tri('‏490 غ لا تكلّف أكثر من عبوة ‏500 غ', '490 g never costs more than the 500 g pack', '‏490 گرام هەرگیز لە پاکەتی ‏500 گرام گرانتر نابێت'),
      },
      {
        path: 'time_overage_policy',
        kind: 'enum',
        values: OVERAGES,
        valueLabels: OVERAGE,
        label: tri('إن تجاوز وقت الطباعة المحجوز', 'When printing time exceeds the reservation', 'ئەگەر کاتی چاپ لە گیراو زیاتر بوو'),
      },
      {
        path: 'material_overage_policy',
        kind: 'enum',
        values: OVERAGES,
        valueLabels: OVERAGE,
        label: tri('إن تجاوزت المادة المحجوزة', 'When material exceeds the reservation', 'ئەگەر کەرەستە لە گیراو زیاتر بوو'),
      },
    ],
  },
  {
    id: 'workshop',
    label: tri('الورشة والمهام', 'Workshop and jobs', 'کارگە و کارەکان'),
    fields: [
      {
        path: 'require_operator_approval',
        kind: 'bool',
        label: tri('موافقة المشغّل قبل الطابور', 'Operator approval before the queue', 'پەسەندکردنی کارپێکەر پێش ڕیز'),
      },
      {
        path: 'agent_reports_need_verification',
        kind: 'bool',
        label: tri('تحقق المشغّل من تقارير الوكيل قبل الاحتساب', 'An operator verifies agent reports before billing', 'کارپێکەر ڕاپۆرتەکانی بریکار پێش حیسابکردن پشتڕاست دەکاتەوە'),
      },
      {
        path: 'telemetry_stale_seconds',
        kind: 'int',
        min: 15,
        max: 3600,
        unit: 'seconds',
        label: tri('تُعدّ القراءة قديمة بعد', 'A reading is stale after', 'خوێندنەوە کۆن دەبێت دوای'),
        help: tri(
          'طابعة وكيل بلا قراءة أحدث لا تأخذ عملاً ولا تُعرض متصلة',
          'An agent printer without a newer reading gets no work and is never shown online',
          'چاپکەری بریکار بێ خوێندنەوەی نوێتر کار وەرناگرێت و هەرگیز پەیوەست پیشان نادرێت'
        ),
      },
      {
        path: 'max_upload_bytes',
        kind: 'int',
        min: 1024,
        max: MODEL_UPLOAD_CEILING_BYTES,
        unit: 'bytes',
        label: tri('أقصى حجم لملف النموذج', 'Largest model file', 'گەورەترین فایلی مۆدێل'),
        help: tri('حتى ‏40 ميغابايت، حد البوابة', 'Up to 40 MB, the gateway’s ceiling', 'تا ‏40 مێگابایت، سنووری دەروازەکە'),
      },
    ],
  },
  {
    id: 'failures',
    label: tri('الأعطال وإعادة الطباعة', 'Failures and reprints', 'شکستەکان و دووبارە چاپکردنەوە'),
    fields: [
      {
        path: 'failure_policy.workshop',
        kind: 'enum',
        values: POLICIES,
        valueLabels: FAILURE_POLICY,
        label: tri('عطل تتحمّله الورشة', 'A failure the workshop caused', 'شکستێک کە کارگە هۆکارەکەی بوو'),
      },
      {
        path: 'failure_policy.customer',
        kind: 'enum',
        values: POLICIES,
        valueLabels: FAILURE_POLICY,
        label: tri('عطل يتحمّله العميل', 'A failure the customer caused', 'شکستێک کە کڕیار هۆکارەکەی بوو'),
      },
      {
        path: 'failure_policy.model',
        kind: 'enum',
        values: POLICIES,
        valueLabels: FAILURE_POLICY,
        label: tri('عطل سببه ملف النموذج', 'A failure the model file caused', 'شکستێک کە فایلی مۆدێل هۆکارەکەی بوو'),
      },
      {
        path: 'failure_policy.undetermined',
        kind: 'enum',
        values: POLICIES,
        valueLabels: FAILURE_POLICY,
        label: tri('عطل غير محدد السبب', 'A failure of undetermined cause', 'شکستێکی هۆکار نەزانراو'),
      },
      {
        path: 'free_reprint_on_workshop_failure',
        kind: 'bool',
        label: tri('إعادة طباعة مجانية بعد عطل الورشة', 'Free reprint after a workshop failure', 'دووبارە چاپکردنەوەی بێبەرامبەر دوای شکستی کارگە'),
      },
    ],
  },
  {
    id: 'customers',
    label: tri('حدود العملاء', 'Customer limits', 'سنوورەکانی کڕیار'),
    fields: [
      {
        path: 'max_active_jobs_per_customer',
        kind: 'int',
        min: 1,
        max: 500,
        unit: 'jobs',
        label: tri('أقصى مهام نشطة لكل عميل', 'Active jobs per customer', 'زۆرترین کاری چالاک بۆ هەر کڕیارێک'),
      },
      {
        path: 'low_inventory_default_g',
        kind: 'int',
        min: 0,
        max: 100_000,
        unit: 'grams',
        label: tri('تذكير انخفاض المادة تحت', 'Low-material reminder below', 'بیرخستنەوەی کەمیی کەرەستە لە خوار'),
        help: tri('ما لم يضع العميل حده الخاص', 'Unless the customer set their own threshold', 'مەگەر کڕیار سنووری خۆی دانابێت'),
      },
    ],
  },
  {
    id: 'delivery',
    label: tri('التوصيل والاستلام', 'Delivery and pickup', 'گەیاندن و وەرگرتن'),
    fields: [
      { path: 'delivery.enabled', kind: 'bool', label: tri('التوصيل متاح', 'Delivery available', 'گەیاندن بەردەستە') },
      { path: 'delivery.pickup_enabled', kind: 'bool', label: tri('الاستلام من الورشة متاح', 'Pickup available', 'وەرگرتن لە کارگە بەردەستە') },
      {
        path: 'delivery.flat_fee_iqd',
        kind: 'int',
        min: 0,
        max: 1_000_000,
        unit: 'iqd',
        label: tri('رسوم التوصيل الثابتة', 'Flat delivery fee', 'کرێی جێگیری گەیاندن'),
      },
      {
        path: 'delivery.fee_by_governorate',
        kind: 'governorate_fees',
        min: 0,
        max: 1_000_000,
        unit: 'iqd',
        label: tri('رسوم حسب المحافظة', 'Fee by governorate', 'کرێ بەپێی پارێزگا'),
        help: tri(
          'تتقدّم على الرسوم الثابتة؛ احذف محافظة لتعود إليها',
          'Overrides the flat fee; remove a governorate to fall back to it',
          'لە جێی کرێی جێگیر کار دەکات؛ پارێزگایەک لاببە بۆ گەڕانەوە بۆی'
        ),
      },
    ],
  },
  {
    id: 'imports',
    label: tri('استيراد النماذج بالروابط', 'Model imports by link', 'هاوردەکردنی مۆدێل بە بەستەر'),
    fields: [
      {
        path: 'import_providers',
        kind: 'providers',
        label: tri('مزوّدو الاستيراد', 'Import providers', 'دابینکەرانی هاوردەکردن'),
        help: tri(
          'بلا واجهة برمجية مرخّصة يُحفظ الرابط فقط ويرفع العميل الملف بنفسه',
          'Without a licensed API the link is only saved and the customer uploads the file',
          'بێ API-یەکی مۆڵەتدار تەنها بەستەرەکە پاشەکەوت دەکرێت و کڕیار فایلەکە خۆی بار دەکات'
        ),
      },
    ],
  },
  {
    id: 'cost',
    label: tri('التكاليف — للمالك', 'Costs — the owner’s', 'تێچووەکان — هی خاوەن'),
    fields: [
      {
        path: 'cost_electricity_iqd_per_kwh',
        kind: 'int',
        min: 0,
        max: 100_000,
        unit: 'iqd_per_kwh',
        cost: true,
        label: tri('تعرفة الكهرباء', 'Electricity tariff', 'نرخی کارەبا'),
        help: tri('لتقدير كلفة الكهرباء في تقرير الربح', 'For the profit report’s electricity estimate', 'بۆ خەمڵاندنی تێچووی کارەبا لە ڕاپۆرتی قازانجدا'),
      },
    ],
  },
];

/** Every field, flat. */
export const SETTING_FIELDS: readonly SettingField[] = SETTING_GROUPS.flatMap((g) => g.fields);

/** The governorate codes the server accepts as a fee key (settings.ts `GOVERNORATE_RE`), at most 30. */
export const GOVERNORATE_KEY_RE = /^[a-z_]{2,40}$/;
export const MAX_GOVERNORATE_FEES = 30;

/** An import provider as settings.ts `normalizeProviders` keeps it. */
export const PROVIDER_ID_RE = /^[a-z0-9_-]{2,40}$/;
export const HOST_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
export const HTTPS_URL_RE = /^https:\/\/[^\s]+$/;
export const MAX_PROVIDERS = 20;
