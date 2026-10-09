/**
 * THE ONE READINESS LIST OF THE PRICING ENGINE (master plan v2 §2.3, C22).
 *
 * Every code the engine, the readiness check, the runs and the legacy switch may
 * raise for a SKU, with its owner-only label in Arabic, English and Sorani. The
 * engine returns CODES, never a number, for anything missing (brief 1 §38): a
 * label names what is missing and where, never a cost.
 *
 * Severity:
 * - `error`   — this SKU × channel gets no price row while it stands. Refusing
 *               an opt-in and hiding a product are R1's product-level rule (an
 *               opt-in is refused only when nothing can be priced; an engine
 *               product is hidden only when no SKU × channel row is left or the
 *               default direct channel cannot be priced [C9][C2-R10]).
 * - `warning` — shown to the owner, never blocks a price (RULE_TIE: the HIGHER
 *               rule applies, so a tie can never lower profit; CHANNEL_INCOMPLETE:
 *               the owner-only notice that one route is unavailable while the
 *               product stays live on the others [C2-R10]; MEASURE_FROM_PUBLIC_SPEC:
 *               readiness warns, and the opt-in's `measures_confirmed` gate (R1/L4)
 *               is what refuses an unconfirmed measure [C1-G11]).
 *
 * `missing_json` entries (R1) have the shape of `PricingMissingEntry` [C1-G23]:
 * the code, where it applies, and the label in all three languages with the
 * option, colour or SKU name in front. `pricingMissingEntriesOf` turns one engine
 * issue into its entries.
 *
 * Every `ckb` is its own Sorani, with at least one Sorani-only letter
 * (ێ ۆ ڕ ڵ ە ڤ) [C1-V10], never a copy of the Arabic (docs/DECISIONS.md row 183).
 * Terminology C32/C46: shipping «ناردن», product «بەرهەم», batch «وەجبە», cost «تێچوو».
 */
import {
  PRICING_FIELD_LABELS,
  PRICING_PROFILE_LABELS,
  isPricingFieldName,
  type PricingFieldName,
  type PricingLabel,
  type PricingLang,
  type PricingProfileName,
} from './pricingFieldLabels';

export const PRICING_ISSUE_CODES = [
  // v1 list (§2.3)
  'SUPPLIER_COST_MISSING',
  'SUPPLIER_CURRENCY_MISSING',
  'SHIPPING_PROFILE_MISSING',
  'WEIGHT_MISSING',
  'CBM_MISSING',
  'FX_RATE_MISSING',
  'SHIPPING_RATE_MISSING',
  'TARGET_PROFIT_MISSING',
  'DIRECT_SALE_EXTRA_MISSING',
  'INPUT_CONFLICT',
  'DELTA_WITHOUT_BASE',
  'CURRENCY_WITHOUT_AMOUNT',
  'CURRENCY_MISMATCH',
  'NEGATIVE_SUPPLIER_COST',
  'AMOUNT_TOO_LARGE',
  'RULE_TIE',
  'SKU_GRID_TOO_LARGE',
  'RELATIONS_REQUIRED',
  'COMPOSITION_NOT_PRICEABLE',
  'PRICE_INVALID',
  'RESOLVER_MISMATCH',
  // [C2] additions
  'FX_RATE_UNCONFIRMED',
  'SHIPPING_RATE_UNCONFIRMED',
  'CHANNEL_INCOMPLETE',
  'PRICE_DROP_REVIEW',
  'PINNED_BELOW_TARGET',
  'PRICING_CATEGORY_DIFFERS',
  'RULE_ORPHANED',
  'DIRECT_SALE_EXTRA_NOT_ON_STEP',
  // v2 additions
  'TARGET_PROFIT_BLOCKED',
  'SHIPPING_FIELD_UNRESOLVED',
  'SKU_INPUTS_UNREVIEWED',
  'INPUT_ORPHANED',
  'MEASURE_FROM_PUBLIC_SPEC',
  // v2 check (1)7: a BLOCKED Direct Sale Extra rule has its own code (TARGET_PROFIT_BLOCKED names the target only)
  'DIRECT_SALE_EXTRA_BLOCKED',
] as const;

export type PricingIssueCode = (typeof PRICING_ISSUE_CODES)[number];
export type PricingIssueSeverity = 'error' | 'warning';

/** Placeholders a label may hold. Each is filled per language from the shared
 * label tables, or with a neutral word when the caller does not know it. */
export type PricingIssueParam = 'currency' | 'profile' | 'field';

export interface PricingIssueDefinition {
  readonly severity: PricingIssueSeverity;
  readonly label: PricingLabel;
}

export const PRICING_ISSUES: Readonly<Record<PricingIssueCode, PricingIssueDefinition>> = {
  SUPPLIER_COST_MISSING: {
    severity: 'error',
    label: {
      ar: 'تكلفة المورد غير موجودة (الصفر لا يُعدّ تكلفة)',
      en: 'Supplier cost is missing (zero does not count as a cost)',
      ckb: 'تێچووی دابینکەر دانەنراوە (سفر وەک تێچوو ناژمێردرێت)',
    },
  },
  SUPPLIER_CURRENCY_MISSING: {
    severity: 'error',
    label: { ar: 'عملة المورد غير محددة', en: 'Supplier currency is not chosen', ckb: 'دراوی دابینکەر هەڵنەبژێردراوە' },
  },
  SHIPPING_PROFILE_MISSING: {
    severity: 'error',
    label: {
      ar: 'طريقة الشحن الافتراضية غير محددة',
      en: 'Default shipping profile is not chosen',
      ckb: 'ڕێگای بنەڕەتیی ناردن هەڵنەبژێردراوە',
    },
  },
  WEIGHT_MISSING: {
    severity: 'error',
    label: { ar: 'وزن الشحن غير موجود', en: 'Shipping weight is missing', ckb: 'کێشی ناردن دانەنراوە' },
  },
  CBM_MISSING: {
    severity: 'error',
    label: {
      ar: 'الحجم (CBM) أو عبوة شحن كاملة الأبعاد غير موجودة',
      en: 'Volume (CBM) or a complete shipping box is missing',
      ckb: 'قەبارە (CBM) یان سندوقێکی تەواوی ناردن دانەنراوە',
    },
  },
  FX_RATE_MISSING: {
    severity: 'error',
    label: { ar: 'سعر صرف {currency} غير مضبوط', en: 'The {currency} exchange rate is not set', ckb: 'نرخی ئاڵوگۆڕی {currency} دانەنراوە' },
  },
  SHIPPING_RATE_MISSING: {
    severity: 'error',
    label: { ar: 'سعر {profile} غير مضبوط', en: 'The {profile} rate is not set', ckb: 'نرخی {profile} دانەنراوە' },
  },
  TARGET_PROFIT_MISSING: {
    severity: 'error',
    label: { ar: 'الحد الأدنى للربح غير مضبوط', en: 'Minimum target profit is not set', ckb: 'کەمترین قازانجی مەبەست دانەنراوە' },
  },
  DIRECT_SALE_EXTRA_MISSING: {
    severity: 'error',
    label: { ar: 'زيادة البيع المباشر غير مضبوطة', en: 'Direct Sale Extra is not set', ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ دانەنراوە' },
  },
  INPUT_CONFLICT: {
    severity: 'error',
    label: {
      ar: 'خياران لهذه التركيبة يعطيان قيمتين مختلفتين في {field}',
      en: 'Two options of this SKU give different values for {field}',
      ckb: 'دوو هەڵبژاردەی ئەم SKU-یە دوو بەهای جیاواز بۆ {field} دەدەن',
    },
  },
  DELTA_WITHOUT_BASE: {
    severity: 'error',
    label: {
      ar: 'فرق تكلفة بلا تكلفة أساسية يُضاف إليها',
      en: 'A cost difference has no base cost to add to',
      ckb: 'جیاوازیی تێچوو هیچ تێچوویەکی بنەڕەتیی نییە بۆ زیادکردن',
    },
  },
  CURRENCY_WITHOUT_AMOUNT: {
    severity: 'error',
    label: { ar: 'عملة مختلفة بلا تكلفة', en: 'A different currency was set without a cost', ckb: 'دراوێکی جیاواز بێ تێچوو دانراوە' },
  },
  CURRENCY_MISMATCH: {
    severity: 'error',
    label: {
      ar: 'فرق التكلفة بعملة غير عملة التكلفة',
      en: 'The cost difference is in another currency',
      ckb: 'جیاوازیی تێچووەکە بە دراوێکی ترە',
    },
  },
  NEGATIVE_SUPPLIER_COST: {
    severity: 'error',
    label: {
      ar: 'تكلفة المورد بعد الفروق أقل من صفر',
      en: 'Supplier cost after differences is below zero',
      ckb: 'تێچووی دابینکەر دوای جیاوازییەکان لە سفر کەمترە',
    },
  },
  AMOUNT_TOO_LARGE: {
    severity: 'error',
    label: {
      ar: 'مبلغ خارج الحدود المسموحة؛ راجع التكلفة والأسعار',
      en: 'An amount is outside the allowed range; check the cost and rates',
      ckb: 'بڕێک لە دەرەوەی سنووری ڕێگەپێدراوە؛ پێداچوونەوە بە تێچوو و نرخەکاندا بکە',
    },
  },
  RULE_TIE: {
    severity: 'warning',
    label: {
      ar: 'خياران يحملان قاعدتين مختلفتين؛ طُبّقت الأعلى',
      en: 'Two options carry different rules; the higher one applies',
      ckb: 'دوو هەڵبژاردە دوو ڕێسای جیاوازیان هەیە؛ بەرزترینیان جێبەجێ دەکرێت',
    },
  },
  SKU_GRID_TOO_LARGE: {
    severity: 'error',
    label: {
      ar: 'عدد تركيبات المنتج أكبر من 240',
      en: 'The product has more than 240 combinations',
      ckb: 'ژمارەی پێکهاتەکانی بەرهەمەکە لە 240 زیاترە',
    },
  },
  RELATIONS_REQUIRED: {
    severity: 'error',
    label: {
      ar: 'احفظ خيارات المنتج من النموذج أولاً',
      en: "Save the product's options from the form first",
      ckb: 'سەرەتا هەڵبژاردەکانی بەرهەمەکە لە فۆڕمەکەوە پاشەکەوت بکە',
    },
  },
  COMPOSITION_NOT_PRICEABLE: {
    severity: 'error',
    label: {
      ar: 'الحزم والعروض العشوائية لا تُسعَّر تلقائياً',
      en: 'Bundles and mystery offers are not priced automatically',
      ckb: 'پاکێج و ئۆفەرە نهێنییەکان بە خۆکاری نرخیان بۆ دانانرێت',
    },
  },
  PRICE_INVALID: {
    severity: 'error',
    label: { ar: 'السعر المحسوب غير صالح', en: 'The calculated price is invalid', ckb: 'نرخی ژمێردراو دروست نییە' },
  },
  RESOLVER_MISMATCH: {
    severity: 'error',
    label: {
      ar: 'السعر الذي يقرؤه المتجر لا يطابق الحساب',
      en: 'The price the store reads does not match the calculation',
      ckb: 'ئەو نرخەی فرۆشگا دەیخوێنێتەوە لەگەڵ ژماردنەکە ناگونجێت',
    },
  },
  FX_RATE_UNCONFIRMED: {
    severity: 'error',
    label: {
      ar: 'سعر صرف {currency} لم يُؤكَّد بعد من شاشة «التسعير والشحن»',
      en: 'The {currency} exchange rate has not been confirmed yet on the Pricing & Shipping screen',
      ckb: 'نرخی ئاڵوگۆڕی {currency} هێشتا لە شاشەی «نرخدانان و ناردنی بەرهەم» پشتڕاست نەکراوەتەوە',
    },
  },
  SHIPPING_RATE_UNCONFIRMED: {
    severity: 'error',
    label: {
      ar: 'سعر {profile} لم يُؤكَّد بعد من شاشة «التسعير والشحن»',
      en: 'The {profile} rate has not been confirmed yet on the Pricing & Shipping screen',
      ckb: 'نرخی {profile} هێشتا لە شاشەی «نرخدانان و ناردنی بەرهەم» پشتڕاست نەکراوەتەوە',
    },
  },
  CHANNEL_INCOMPLETE: {
    severity: 'warning',
    label: {
      ar: 'مسار البيع هذا ينقصه بيانات تسعير؛ أُوقف بيعه وحده',
      en: 'This sale route is missing pricing data; only this route is paused',
      ckb: 'زانیاریی نرخدانانی ئەم ڕێگای فرۆشتنە ناتەواوە؛ تەنها ئەم ڕێگایە ڕاگیراوە',
    },
  },
  PRICE_DROP_REVIEW: {
    severity: 'warning',
    label: {
      ar: 'انخفاض السعر أكبر من الحد؛ ينتظر مراجعتك',
      en: 'The price drop is larger than the limit; it is waiting for your review',
      ckb: 'دابەزینی نرخ لە سنوور گەورەترە؛ چاوەڕێی پێداچوونەوەی تۆیە',
    },
  },
  PINNED_BELOW_TARGET: {
    severity: 'warning',
    label: {
      ar: 'سعر مثبت يدوياً يعطي ربحاً أقل من الحد الأدنى للربح',
      en: 'A manually pinned price gives less than the minimum target profit',
      ckb: 'نرخێکی جێگیرکراوی دەستی قازانجێکی کەمتر لە کەمترین قازانجی مەبەست دەدات',
    },
  },
  PRICING_CATEGORY_DIFFERS: {
    severity: 'warning',
    label: {
      ar: 'قسم التسعير يختلف عن قسم المنتج الحالي',
      en: "The pricing category differs from the product's current category",
      ckb: 'بەشی نرخدانان جیاوازە لە بەشی ئێستای بەرهەمەکە',
    },
  },
  RULE_ORPHANED: {
    severity: 'warning',
    label: {
      ar: 'قاعدة ربح أو زيادة بيع مباشر تشير إلى قسم أو خيار أو تركيبة لم تعد موجودة؛ لا تُطبَّق',
      en: 'A profit or Direct Sale Extra rule points to a category, option or SKU that no longer exists; it is not applied',
      ckb: 'ڕێسایەکی قازانج یان زیادەی فرۆشتنی ڕاستەوخۆ ئاماژە بە بەش، هەڵبژاردە یان SKU-یەک دەکات کە چیتر بوونی نییە؛ جێبەجێ ناکرێت',
    },
  },
  DIRECT_SALE_EXTRA_NOT_ON_STEP: {
    severity: 'error',
    label: {
      ar: 'يجب أن تكون زيادة البيع المباشر من مضاعفات خطوة التقريب (1,000 د.ع)',
      en: 'The Direct Sale Extra must be a multiple of the rounding step (1,000 IQD)',
      ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ دەبێت چەندجارەی هەنگاوی خڕکردنەوە بێت (1,000 دینار)',
    },
  },
  TARGET_PROFIT_BLOCKED: {
    severity: 'error',
    label: {
      ar: 'الحد الأدنى للربح موقوف حتى تقرر',
      en: 'The minimum target profit is on hold until you decide',
      ckb: 'کەمترین قازانجی مەبەست ڕاگیراوە تا تۆ بڕیار دەدەیت',
    },
  },
  SHIPPING_FIELD_UNRESOLVED: {
    severity: 'error',
    label: {
      ar: 'بيانات الشحن غير محسومة في هذا المستوى؛ لا تُورث القيمة الأعلى',
      en: 'Shipping data is unresolved at this level; the higher value is not inherited',
      ckb: 'زانیاریی ناردن لەم ئاستەدا یەکلانەکراوەتەوە؛ بەهای ئاستی سەرووتر وەرناگیرێت',
    },
  },
  SKU_INPUTS_UNREVIEWED: {
    severity: 'error',
    label: {
      ar: 'تركيبة جديدة أضافها أدمن غير المالك؛ بياناتها موروثة ولم تراجعها بعد',
      en: 'A new SKU added by an admin other than the owner; its data is inherited and you have not reviewed it yet',
      ckb: 'SKU-یەکی نوێ کە ئەدمینێکی جگە لە خاوەن زیادی کردووە؛ زانیارییەکانی وەرگیراون و هێشتا پێیاندا نەچوویتەوە',
    },
  },
  INPUT_ORPHANED: {
    severity: 'warning',
    label: {
      ar: 'بيانات تسعير لخيار أو لون لم يعد موجوداً؛ أعد ربطها أو احذفها',
      en: 'Pricing data for an option or colour that no longer exists; re-link or remove it',
      ckb: 'زانیاریی نرخدانان بۆ هەڵبژاردە یان ڕەنگێک کە چیتر بوونی نییە؛ دووبارە بیبەستەرەوە یان لایبە',
    },
  },
  MEASURE_FROM_PUBLIC_SPEC: {
    severity: 'warning',
    label: {
      ar: 'القياس منقول من المواصفات العلنية ولم تؤكده بعد',
      en: 'This measure was copied from the public specs and you have not confirmed it yet',
      ckb: 'ئەم پێوانەیە لە تایبەتمەندییە گشتییەکانەوە هێنراوە و هێشتا پشتڕاستت نەکردووەتەوە',
    },
  },
  DIRECT_SALE_EXTRA_BLOCKED: {
    severity: 'error',
    label: {
      ar: 'زيادة البيع المباشر موقوفة حتى تقرر',
      en: 'The Direct Sale Extra is on hold until you decide',
      ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ ڕاگیراوە تا تۆ بڕیار دەدەیت',
    },
  },
};

export function isPricingIssueCode(value: unknown): value is PricingIssueCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRICING_ISSUES, value);
}

/** The neutral word used when a label's placeholder is not known. */
const PARAM_FALLBACK: Readonly<Record<PricingIssueParam, PricingLabel>> = {
  currency: { ar: 'العملة', en: 'currency', ckb: 'دراو' },
  profile: { ar: 'الشحن', en: 'shipping', ckb: 'ناردن' },
  field: { ar: 'هذا الحقل', en: 'this field', ckb: 'ئەم خانەیە' },
};

export interface PricingIssueParams {
  /** An ISO code (USD, EUR, CNY): shown as is in every language. */
  currency?: string | null;
  profile?: PricingProfileName | null;
  field?: PricingFieldName | null;
}

/** The placeholders a label holds, in order of appearance. */
export function pricingIssueParams(code: PricingIssueCode): PricingIssueParam[] {
  const seen = new Set<PricingIssueParam>();
  for (const m of PRICING_ISSUES[code].label.en.matchAll(/\{(\w+)\}/g)) seen.add(m[1] as PricingIssueParam);
  return [...seen];
}

/** One code's label in one language, placeholders filled. */
export function pricingIssueLabel(code: PricingIssueCode, lang: PricingLang, params: PricingIssueParams = {}): string {
  return PRICING_ISSUES[code].label[lang].replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (name === 'currency') return params.currency || PARAM_FALLBACK.currency[lang];
    if (name === 'profile') return params.profile ? PRICING_PROFILE_LABELS[params.profile][lang] : PARAM_FALLBACK.profile[lang];
    if (name === 'field') return params.field ? PRICING_FIELD_LABELS[params.field][lang] : PARAM_FALLBACK.field[lang];
    return whole;
  });
}

/** One code's label in all three languages, placeholders filled. */
export function pricingIssueLabels(code: PricingIssueCode, params: PricingIssueParams = {}): PricingLabel {
  return { ar: pricingIssueLabel(code, 'ar', params), en: pricingIssueLabel(code, 'en', params), ckb: pricingIssueLabel(code, 'ckb', params) };
}

/** Where a readiness entry applies (`product_pricing_state.missing_json`). */
export type PricingIssueScope = 'product' | 'option' | 'color' | 'sku';

/** One `missing_json` entry [C1-G23]: the code, where it applies, and the label in
 * all three languages with the option, colour or SKU name in front ("Combo — …"). */
export interface PricingMissingEntry {
  code: PricingIssueCode;
  scope: PricingIssueScope;
  scope_id: string;
  label_ar: string;
  label_en: string;
  label_ckb: string;
}

export function pricingMissingEntry(input: {
  code: PricingIssueCode;
  scope: PricingIssueScope;
  scope_id: string;
  /** The option, colour or SKU name in each language; omitted for the product itself. */
  name?: PricingLabel | null;
  params?: PricingIssueParams;
}): PricingMissingEntry {
  const text = pricingIssueLabels(input.code, input.params);
  const named = (lang: PricingLang) => {
    const name = input.name?.[lang]?.trim();
    return name ? `${name} — ${text[lang]}` : text[lang];
  };
  return {
    code: input.code,
    scope: input.scope,
    scope_id: input.scope === 'product' ? '' : input.scope_id,
    label_ar: named('ar'),
    label_en: named('en'),
    label_ckb: named('ckb'),
  };
}

/** The part of an engine issue (`@levonis/pricing` costToPrice `PricingIssue`) that
 * `pricingMissingEntriesOf` reads. Structural, so the contracts import nothing. */
export interface PricingIssueLike {
  code: PricingIssueCode;
  level?: 'base' | 'option' | 'color' | 'sku';
  scope_ids?: readonly string[];
  field?: string;
  currency?: string;
  profile?: string;
}

/**
 * The `missing_json` entries of one engine issue for one SKU [C1-G23]. The
 * issue's input level becomes the entry scope (`base` → `product`), one entry per
 * scope id; an issue without a level (a rate, the final supplier cost, a rule)
 * belongs to the SKU itself — `sku` with its combo key, or `product` for the
 * product itself (combo key ''). `nameOf` gives the option, colour or SKU name in
 * each language. Codes and names only — never a number.
 */
export function pricingMissingEntriesOf(
  issue: PricingIssueLike,
  ctx: { combo_key: string; nameOf?: (scope: PricingIssueScope, scope_id: string) => PricingLabel | null | undefined }
): PricingMissingEntry[] {
  const params: PricingIssueParams = {
    currency: issue.currency ?? null,
    profile:
      issue.profile && Object.prototype.hasOwnProperty.call(PRICING_PROFILE_LABELS, issue.profile) ? (issue.profile as PricingProfileName) : null,
    field: isPricingFieldName(issue.field) ? issue.field : null,
  };
  const level = issue.level;
  const where: Array<[PricingIssueScope, string]> =
    level === 'base'
      ? [['product', '']]
      : level
        ? (issue.scope_ids?.length ? issue.scope_ids : ['']).map((id): [PricingIssueScope, string] => [level, id])
        : [[ctx.combo_key ? 'sku' : 'product', ctx.combo_key]];
  const seen = new Set<string>();
  const entries: PricingMissingEntry[] = [];
  for (const [scope, scope_id] of where) {
    const key = `${scope}\u0000${scope_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(pricingMissingEntry({ code: issue.code, scope, scope_id, name: scope === 'product' ? null : ctx.nameOf?.(scope, scope_id) ?? null, params }));
  }
  return entries;
}
