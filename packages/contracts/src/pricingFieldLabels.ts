/**
 * PRIVATE PRICING FIELD LABELS, IN ALL THREE LANGUAGES (master plan v2 §2.3, §6.2).
 *
 * One table for every owner-only pricing screen, every readiness message that
 * names a field (`INPUT_CONFLICT` says WHICH field disagrees) and every export
 * header, so the owner reads the same words for the same figure everywhere.
 *
 * These are owner-only labels: a screen mounts them only for `can_write_cost`
 * and the server refuses everyone else regardless. They name fields; they never
 * carry a value.
 *
 * Terminology (C32, C46): shipping «ناردن» (never «گواستنەوە» on pricing
 * screens), product «بەرهەم», batch «وەجبە», cost «تێچوو». Every `ckb` is its own
 * Sorani — never the Arabic pasted across (docs/DECISIONS.md row 183) — and holds
 * at least one Sorani-only letter (ێ ۆ ڕ ڵ ە ڤ) [C1-V10]; `tests/pricingIssues.test.ts`
 * walks every row.
 */

export interface PricingLabel {
  readonly ar: string;
  readonly en: string;
  readonly ckb: string;
}

export type PricingLang = keyof PricingLabel;
export const PRICING_LANGS: readonly PricingLang[] = ['ar', 'en', 'ckb'];

/** Field names as stored in `pricing_inputs` / `pricing_sku_costs` (0179), plus
 * `shipping_box` (L × W × H as ONE unit [L2-1a]) and the engine's breakdown names. */
export const PRICING_FIELD_LABELS = {
  // ---- inputs (pricing_inputs) ---------------------------------------------
  supplier_cost: { ar: 'تكلفة المورد', en: 'Supplier cost', ckb: 'تێچووی دابینکەر' },
  supplier_cost_delta: { ar: 'فرق تكلفة المورد', en: 'Supplier cost difference', ckb: 'جیاوازیی تێچووی دابینکەر' },
  supplier_currency: { ar: 'عملة المورد', en: 'Supplier currency', ckb: 'دراوی دابینکەر' },
  shipping_profile: { ar: 'طريقة الشحن الافتراضية', en: 'Default shipping profile', ckb: 'ڕێگای بنەڕەتیی ناردن' },
  pricing_weight_g: { ar: 'وزن التسعير (غم)', en: 'Pricing weight (g)', ckb: 'کێشی نرخدانان (گرام)' },
  shipping_weight_g: { ar: 'وزن الشحن (غم)', en: 'Shipping weight (g)', ckb: 'کێشی ناردن (گرام)' },
  shipping_length_mm: { ar: 'طول عبوة الشحن (ملم)', en: 'Shipping box length (mm)', ckb: 'درێژیی سندوقی ناردن (میلیمەتر)' },
  shipping_width_mm: { ar: 'عرض عبوة الشحن (ملم)', en: 'Shipping box width (mm)', ckb: 'پانیی سندوقی ناردن (میلیمەتر)' },
  shipping_height_mm: { ar: 'ارتفاع عبوة الشحن (ملم)', en: 'Shipping box height (mm)', ckb: 'بەرزیی سندوقی ناردن (میلیمەتر)' },
  shipping_box: { ar: 'عبوة الشحن (طول × عرض × ارتفاع، ملم)', en: 'Shipping box (L × W × H, mm)', ckb: 'سندوقی ناردن (درێژی × پانی × بەرزی، میلیمەتر)' },
  manual_cbm: { ar: 'الحجم اليدوي (CBM)', en: 'Manual CBM', ckb: 'قەبارەی دەستی (CBM)' },
  additional_cost_iqd: { ar: 'تكاليف إضافية للقطعة (د.ع)', en: 'Additional cost per unit (IQD)', ckb: 'تێچووی زیادە بۆ هەر پارچەیەک (دینار)' },
  net_weight_g: { ar: 'الوزن الصافي (للعرض فقط)', en: 'Net weight (display only)', ckb: 'کێشی سافی (تەنها بۆ پیشاندان)' },
  // ---- engine results (pricing_sku_costs) ----------------------------------
  supplier_amount: { ar: 'تكلفة المورد بعملته', en: 'Supplier cost in its currency', ckb: 'تێچووی دابینکەر بە دراوەکەی خۆی' },
  shipping_cbm: { ar: 'الحجم المحسوب من العبوة (CBM)', en: 'Calculated CBM (from the box)', ckb: 'قەبارەی ژمێردراو لە سندوقەکەوە (CBM)' },
  calculated_cbm: { ar: 'الحجم المحسوب (CBM)', en: 'Calculated CBM', ckb: 'قەبارەی ژمێردراو (CBM)' },
  effective_cbm: { ar: 'الحجم المعتمد (CBM)', en: 'Effective CBM', ckb: 'قەبارەی بەکارهاتوو (CBM)' },
  effective_weight_g: { ar: 'الوزن المعتمد للشحن (غم)', en: 'Effective shipping weight (g)', ckb: 'کێشی بەکارهاتووی ناردن (گرام)' },
  fx_rate: { ar: 'سعر الصرف', en: 'Exchange rate', ckb: 'نرخی ئاڵوگۆڕ' },
  shipping_rate: { ar: 'سعر الشحن (لكل كغم أو CBM)', en: 'Shipping rate (per kg or CBM)', ckb: 'نرخی ناردن بۆ هەر کیلۆگرام یان CBM' },
  supplier_cost_exact: { ar: 'تكلفة المورد بالدينار (دقيقة)', en: 'Supplier cost in IQD (exact)', ckb: 'تێچووی دابینکەر بە دینار (ورد)' },
  supplier_cost_iqd: { ar: 'تكلفة المورد بالدينار', en: 'Supplier cost in IQD', ckb: 'تێچووی دابینکەر بە دینار' },
  shipping_cost_exact: { ar: 'تكلفة الشحن (دقيقة)', en: 'Shipping cost (exact)', ckb: 'تێچووی ناردن (ورد)' },
  shipping_cost_iqd: { ar: 'تكلفة الشحن', en: 'Shipping cost', ckb: 'تێچووی ناردن' },
  replacement_exact: { ar: 'تكلفة الاستبدال الحالية (دقيقة)', en: 'Current replacement cost (exact)', ckb: 'تێچووی ئێستای جێگرتنەوە (ورد)' },
  replacement_cost_iqd: { ar: 'تكلفة الاستبدال الحالية', en: 'Current replacement cost', ckb: 'تێچووی ئێستای جێگرتنەوە' },
  // Owner clarification 2026-10-07: the MINIMUM profit above the current
  // replacement cost (price >= replacement + this); actual profit from a
  // batch may be higher and is never forced down to it.
  target_profit_iqd: {
    ar: 'الحد الأدنى للربح (فوق تكلفة الاستبدال الحالية)',
    en: 'Minimum target profit (above current replacement cost)',
    ckb: 'کەمترین قازانجی مەبەست (لەسەر تێچووی ئێستای جێگرتنەوە)',
  },
  direct_premium_iqd: { ar: 'زيادة البيع المباشر', en: 'Direct sale premium', ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ' },
  rounding_step_iqd: { ar: 'خطوة التقريب', en: 'Rounding step', ckb: 'هەنگاوی خڕکردنەوە' },
  rounding_added_iqd: { ar: 'زيادة التقريب للأعلى', en: 'Added by rounding up', ckb: 'زیادکراو بە خڕکردنەوە بۆ سەرەوە' },
  preorder_base_iqd: { ar: 'سعر الطلب المسبق الأساسي', en: 'Pre-order base price', ckb: 'نرخی بنەڕەتیی پێشداواکاری' },
  computed_price_iqd: { ar: 'السعر المحسوب', en: 'Calculated price', ckb: 'نرخی ژمێردراو' },
} as const satisfies Record<string, PricingLabel>;

export type PricingFieldName = keyof typeof PRICING_FIELD_LABELS;

/** The three shipping profiles as phrases that read inside a sentence
 * («سعر {profile}», "The {profile} rate", «نرخی {profile}»). */
export type PricingProfileName = 'GERMANY_LAND' | 'CHINA_AIR' | 'CHINA_SEA';
export const PRICING_PROFILE_LABELS: Readonly<Record<PricingProfileName, PricingLabel>> = {
  GERMANY_LAND: { ar: 'الشحن البري من ألمانيا', en: 'Germany land shipping', ckb: 'ناردنی وشکانی لە ئەڵمانیاوە' },
  CHINA_AIR: { ar: 'الشحن الجوي من الصين', en: 'China air shipping', ckb: 'ناردنی ئاسمانی لە چینەوە' },
  CHINA_SEA: { ar: 'الشحن البحري من الصين', en: 'China sea shipping', ckb: 'ناردنی دەریایی لە چینەوە' },
};

/** The four sale channels of a SKU (C20). */
export type PricingChannelName = 'direct_sale' | 'pre_order_air' | 'pre_order_sea' | 'pre_order_land';
export const PRICING_CHANNEL_LABELS: Readonly<Record<PricingChannelName, PricingLabel>> = {
  direct_sale: { ar: 'بيع مباشر', en: 'Direct sale', ckb: 'فرۆشتنی ڕاستەوخۆ' },
  pre_order_air: { ar: 'طلب مسبق — جوي', en: 'Pre-order — air', ckb: 'پێشداواکاری — ئاسمانی' },
  pre_order_sea: { ar: 'طلب مسبق — بحري', en: 'Pre-order — sea', ckb: 'پێشداواکاری — دەریایی' },
  pre_order_land: { ar: 'طلب مسبق — بري', en: 'Pre-order — land', ckb: 'پێشداواکاری — وشکانی' },
};

/** Rule and input scopes. Input scope `base` is the product itself. */
export type PricingScopeName = 'global' | 'category' | 'product' | 'base' | 'option' | 'color' | 'sku';
export const PRICING_SCOPE_LABELS: Readonly<Record<PricingScopeName, PricingLabel>> = {
  global: { ar: 'عام (كل المنتجات)', en: 'Global (all products)', ckb: 'گشتی (هەموو بەرهەمەکان)' },
  category: { ar: 'القسم', en: 'Category', ckb: 'بەش' },
  product: { ar: 'المنتج', en: 'Product', ckb: 'بەرهەم' },
  base: { ar: 'المنتج', en: 'Product', ckb: 'بەرهەم' },
  option: { ar: 'الخيار', en: 'Option', ckb: 'هەڵبژاردە' },
  color: { ar: 'اللون', en: 'Colour', ckb: 'ڕەنگ' },
  sku: { ar: 'التركيبة (SKU)', en: 'Exact SKU', ckb: 'پێکهاتەی دیاریکراو (SKU)' },
};

/** Where an input value came from (`pricing_inputs.origin`). */
export type PricingOriginName = 'SOURCE' | 'MANUAL_OVERRIDE';
export const PRICING_ORIGIN_LABELS: Readonly<Record<PricingOriginName, PricingLabel>> = {
  SOURCE: { ar: 'من المصدر', en: 'From source', ckb: 'لە سەرچاوەوە' },
  MANUAL_OVERRIDE: { ar: 'تعديل يدوي من الأدمن الرئيسي', en: 'Manual override (main admin)', ckb: 'گۆڕینی دەستی (بەڕێوەبەری سەرەکی)' },
};

export function isPricingFieldName(value: unknown): value is PricingFieldName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRICING_FIELD_LABELS, value);
}
