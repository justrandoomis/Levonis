/**
 * THE LEGACY-MIGRATION VOCABULARY OF «التسعير والشحن», IN ALL THREE LANGUAGES
 * (master plan v2 §2.3 statuses, §6.2 labels; MVP plan §6 P1).
 *
 * Owner-only labels: the screen that reads them mounts for `can_write_cost`
 * alone and the server refuses everyone else. They name states, reasons and
 * fields; they never carry a value — a `{iqd}` or `{method}` slot is filled by
 * the owner's own screen from the owner's own answer (`migrationText`).
 *
 * What is here:
 *   - the six product statuses of §2.3, worst first (`PRICING_MIGRATION_STATUSES`);
 *   - the states one derived minimum profit or Direct Sale Extra can be in;
 *   - every reason code `packages/pricing/src/legacyTargets.ts` and the P1
 *     preview raise (tests/pricingMigrationLabels.test.ts holds the two lists
 *     equal), with its severity;
 *   - the §6.2 labels (`b.*`, `I.*`, `R.*`, `L.*`, `s.*`, `btn.*`, `chk.*`)
 *     and the shipping-profile names `p.*`.
 *
 * Three deliberate changes to the §6.2 wording, all binding owner text:
 *   - «الربح المستهدف» / "target profit" / «قازانجی ئامانج» is the MINIMUM
 *     target profit (owner clarification 2026-10-07): «الحد الأدنى للربح»,
 *     "minimum target profit", «کەمترین قازانجی مەبەست» — the words
 *     pricingFieldLabels.ts and pricingIssues.ts already use;
 *   - shipping is «ناردن» on pricing screens, never «گواستنەوە» (C46);
 *   - there is no switch and no gate (owner decision 8, 2026-10-09;
 *     DECISIONS row 191): the save that completes a product's pricing data
 *     shows the new prices, and «حفظ واعتماد الأسعار الجديدة» adopts the
 *     engine and writes them. So a complete product waits to be reviewed and
 *     saved, never to be "switched", the switch button is `btn.saveAndApply`,
 *     and the first-switch-on conditions title is gone. `READY_TO_SWITCH`
 *     keeps its key: it is a status value the server answers.
 *
 * Every `ckb` is its own Sorani — never the Arabic or the English pasted across
 * (docs/DECISIONS.md row 183) — with at least one Sorani-only letter and no
 * Arabic-only one. Pure data: imports only its own package.
 */
import type { PricingLabel, PricingLang } from './pricingFieldLabels';

// ------------------------------------------------------------ statuses (§2.3)

/** The product statuses of the legacy migration, WORST FIRST (§2.3). */
export const PRICING_MIGRATION_STATUSES = [
  'CONFLICT',
  'TARGET_PROFIT_REVIEW_REQUIRED',
  'NEEDS_MANUAL_REVIEW',
  'WAITING_FOR_SUPPLIER_COST',
  'READY_TO_SWITCH',
  'READY',
] as const;
export type PricingMigrationStatus = (typeof PRICING_MIGRATION_STATUSES)[number];

export const PRICING_MIGRATION_STATUS_LABELS: Readonly<Record<PricingMigrationStatus, PricingLabel>> = {
  CONFLICT: {
    ar: 'تعارض في البيانات القديمة',
    en: 'Conflicting legacy data',
    ckb: 'ناکۆکی لە زانیارییە کۆنەکاندا',
  },
  // A held Direct Sale Extra rolls up here too (master plan v2 check (1)7),
  // so the PRODUCT status names both values; one value's own state is below.
  TARGET_PROFIT_REVIEW_REQUIRED: {
    ar: 'الحد الأدنى للربح أو زيادة البيع المباشر يحتاج مراجعة',
    en: 'Minimum profit or Direct Sale Extra needs review',
    ckb: 'کەمترین قازانج یان زیادەی فرۆشتنی ڕاستەوخۆ پێویستی بە پێداچوونەوە هەیە',
  },
  NEEDS_MANUAL_REVIEW: {
    ar: 'يحتاج مراجعة يدوية',
    en: 'Needs manual review',
    ckb: 'پێویستی بە پێداچوونەوەی دەستی هەیە',
  },
  WAITING_FOR_SUPPLIER_COST: {
    ar: 'بانتظار تكلفة المورد فقط',
    en: 'Waiting only for supplier cost',
    ckb: 'تەنها چاوەڕێی تێچووی دابینکەرە',
  },
  READY_TO_SWITCH: {
    ar: 'مكتمل — راجع الأسعار الجديدة واحفظ',
    en: 'Complete — review the new prices and save',
    ckb: 'تەواوە — پێداچوونەوە بە نرخە نوێیەکاندا بکە و پاشەکەوتیان بکە',
  },
  READY: {
    ar: 'جاهز — يعمل بالتسعير الجديد',
    en: 'Ready — on the new pricing',
    ckb: 'ئامادەیە — بە نرخدانانی نوێ کار دەکات',
  },
};

export function isPricingMigrationStatus(value: unknown): value is PricingMigrationStatus {
  return typeof value === 'string' && (PRICING_MIGRATION_STATUSES as readonly string[]).includes(value);
}

/** The worse of the given statuses (§2.3 order); `fallback` when there are none. */
export function worstMigrationStatus(
  statuses: Iterable<PricingMigrationStatus>,
  fallback: PricingMigrationStatus = 'WAITING_FOR_SUPPLIER_COST'
): PricingMigrationStatus {
  let worst = -1;
  for (const s of statuses) {
    const i = PRICING_MIGRATION_STATUSES.indexOf(s);
    if (i >= 0 && (worst < 0 || i < worst)) worst = i;
  }
  return worst < 0 ? fallback : PRICING_MIGRATION_STATUSES[worst];
}

// --------------------------------------------- one derived value's state

/** The state of one derived minimum profit or Direct Sale Extra (master plan v2 §2.5). */
export const LEGACY_VALUE_STATES = [
  'MIGRATED',
  'TARGET_PROFIT_UNRESOLVED',
  'TARGET_PROFIT_REVIEW_REQUIRED',
  'DIRECT_SALE_EXTRA_REVIEW_REQUIRED',
  'NOT_APPLICABLE',
  'CONFLICT',
] as const;
export type LegacyValueState = (typeof LEGACY_VALUE_STATES)[number];

export const LEGACY_VALUE_STATE_LABELS: Readonly<Record<LegacyValueState, PricingLabel>> = {
  MIGRATED: {
    ar: 'مستخرج من الأسعار القديمة',
    en: 'Taken from the old prices',
    ckb: 'لە نرخە کۆنەکانەوە دەرهێنراوە',
  },
  TARGET_PROFIT_UNRESOLVED: {
    ar: 'الحد الأدنى للربح غير محسوم',
    en: 'Minimum target profit unresolved',
    ckb: 'کەمترین قازانجی مەبەست یەکلانەکراوەتەوە',
  },
  TARGET_PROFIT_REVIEW_REQUIRED: {
    ar: 'الحد الأدنى للربح يحتاج مراجعة',
    en: 'Minimum target profit needs review',
    ckb: 'کەمترین قازانجی مەبەست پێویستی بە پێداچوونەوە هەیە',
  },
  DIRECT_SALE_EXTRA_REVIEW_REQUIRED: {
    ar: 'زيادة البيع المباشر تحتاج مراجعة',
    en: 'Direct Sale Extra needs review',
    ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ پێویستی بە پێداچوونەوە هەیە',
  },
  NOT_APPLICABLE: {
    ar: 'لا ينطبق (لا يوجد بيع مباشر)',
    en: 'Not applicable (no direct sale)',
    ckb: 'جێبەجێ نابێت (فرۆشتنی ڕاستەوخۆ نییە)',
  },
  CONFLICT: {
    ar: 'تعارض — اختر القيمة بنفسك',
    en: 'Conflict — choose the value yourself',
    ckb: 'ناکۆکی — خۆت بەهاکە هەڵبژێرە',
  },
};

// ------------------------------------------------------------- reason codes

/**
 * Severity of a reason: `conflict` and `review` hold the value for the owner,
 * `unresolved` means there is nothing to derive it from, `info` changes
 * nothing (it explains a number that stands).
 */
export type LegacyReasonSeverity = 'conflict' | 'review' | 'unresolved' | 'info';

export interface LegacyReasonDefinition {
  readonly severity: LegacyReasonSeverity;
  readonly label: PricingLabel;
}

/**
 * Every reason the legacy derivation and the P1 preview raise. Codes only on
 * the wire; the label is chosen here by code. `{iqd}` and `{method}` are the
 * owner's own figures, filled on the owner's screen.
 */
export const LEGACY_REASONS = {
  LEGACY_PRICE_ZERO: {
    severity: 'review',
    label: {
      ar: 'السعر القديم صفر أو غير صالح؛ لا يُستخرج منه ربح.',
      en: 'The old price is zero or invalid; no profit is taken from it.',
      ckb: 'نرخی کۆن سفرە یان نادروستە؛ هیچ قازانجێکی لێ دەرناهێنرێت.',
    },
  },
  MISSING_LEGACY_COST: {
    severity: 'unresolved',
    label: {
      ar: 'لا توجد تكلفة قديمة لهذا الاختيار؛ حدّد الحد الأدنى للربح بنفسك.',
      en: 'There is no old cost for this selection; set the minimum target profit yourself.',
      ckb: 'هیچ تێچوویەکی کۆن بۆ ئەم هەڵبژاردنە نییە؛ خۆت کەمترین قازانجی مەبەست دیاری بکە.',
    },
  },
  LEGACY_COST_ZERO: {
    severity: 'review',
    label: {
      ar: 'التكلفة القديمة صفر؛ لا يُعدّ السعر كله ربحاً. راجعها.',
      en: 'The old cost is zero; the whole price is not counted as profit. Check it.',
      ckb: 'تێچووی کۆن سفرە؛ هەموو نرخەکە وەک قازانج حیساب ناکرێت. پێیدا بچۆرەوە.',
    },
  },
  LEGACY_SALE_NOT_ABOVE_COST: {
    severity: 'review',
    label: {
      ar: 'سعر البيع القديم لا يزيد على التكلفة القديمة؛ لا يُكتب ربح صفر أو سالب.',
      en: 'The old sale price is not above the old cost; no zero or negative profit is written.',
      ckb: 'نرخی کۆنی فرۆشتن لە تێچووی کۆن زیاتر نییە؛ هیچ قازانجێکی سفر یان سالب نانووسرێت.',
    },
  },
  COST_LESS_SPECIFIC_THAN_PRICE: {
    severity: 'review',
    label: {
      ar: 'لهذا الاختيار سعر خاص لكن تكلفته موروثة من مستوى أعلى؛ قد يكون الربح المستخرج خاطئاً. راجعه.',
      en: 'This selection has its own price but its cost is inherited from a higher level; the extracted profit may be wrong. Check it.',
      ckb: 'ئەم هەڵبژاردنە نرخی تایبەتی خۆی هەیە بەڵام تێچووەکەی لە ئاستێکی سەرووترەوە وەرگیراوە؛ لەوانەیە قازانجی دەرهێنراو هەڵە بێت. پێیدا بچۆرەوە.',
    },
  },
  TARGET_ROUTE_CONFLICT: {
    severity: 'conflict',
    label: {
      ar: 'مسارات الطلب المسبق تعطي أرباحاً قديمة مختلفة لهذا الاختيار بعد احتساب عمولة كل مسار. اختر المسار الذي يُعتمد أو حدّد الربح بنفسك؛ لا يُحسب متوسط.',
      en: "The pre-order routes give different old profits for this selection once each route's fee is counted. Choose the route to use or set the profit yourself; no average is taken.",
      ckb: 'ڕێگاکانی پێشداواکاری دوای حیسابکردنی کرێی هەر ڕێگایەک قازانجی کۆنی جیاواز دەدەن بۆ ئەم هەڵبژاردنە. ئەو ڕێگایە هەڵبژێرە کە بەکاردێت یان خۆت قازانج دیاری بکە؛ تێکڕا وەرناگیرێت.',
    },
  },
  VARIANT_COST_CONFLICT: {
    severity: 'conflict',
    label: {
      ar: 'لتركيبة من هذا الاختيار تكلفة مخزنة تختلف عن تكلفة السلّم؛ اختر أيهما يُعتمد.',
      en: 'A SKU of this selection stores a cost that differs from the ladder cost; choose which one to use.',
      ckb: 'SKU-یەکی ئەم هەڵبژاردنە تێچوویەکی هەڵگیراوی هەیە کە جیاوازە لە تێچووی پلەکان؛ هەڵبژێرە کامیان بەکاربێت.',
    },
  },
  LEGACY_DIRECT_BELOW_PREORDER: {
    severity: 'review',
    label: {
      ar: 'سعر البيع المباشر القديم أقل مما كان يدفعه الزبون في الطلب المسبق (السعر مع عمولة المسار). لن تُكتب زيادة سالبة؛ حدّد زيادة البيع المباشر بنفسك.',
      en: 'The old direct-sale price is below what the customer paid for a pre-order (price plus route fee). No negative extra is written; set the Direct Sale Extra yourself.',
      ckb: 'نرخی کۆنی فرۆشتنی ڕاستەوخۆ لەوە کەمترە کە کڕیار بۆ پێشداواکاری دەیدا (نرخ لەگەڵ کرێی ڕێگا). هیچ زیادەیەکی سالب نانووسرێت؛ خۆت زیادەی فرۆشتنی ڕاستەوخۆ دیاری بکە.',
    },
  },
  LEGACY_DIRECT_SALE_EXTRA_NOT_ON_STEP: {
    severity: 'review',
    label: {
      ar: 'زيادة البيع المباشر المستخرجة ({iqd}) ليست من مضاعفات 1,000. اختر الأقرب الأدنى أو الأعلى أو حدّدها بنفسك.',
      en: 'The extracted Direct Sale Extra ({iqd}) is not a multiple of 1,000. Choose the nearest lower or higher value, or set it yourself.',
      ckb: 'زیادەی دەرهێنراوی فرۆشتنی ڕاستەوخۆ ({iqd}) چەندجارەی 1,000 نییە. نزیکترینی خوارتر یان سەرتر هەڵبژێرە، یان خۆت دیاری بکە.',
    },
  },
  NO_BASE_ROUTE: {
    severity: 'review',
    label: {
      ar: 'للطلب المسبق أكثر من مسار؛ اختر المسار الأساسي الذي تُحسب منه زيادة البيع المباشر، فالسعر الجديد للبيع المباشر يُبنى على شحن ذلك المسار.',
      en: "Pre-order has more than one route; choose the base route the Direct Sale Extra is measured from, because the new direct-sale price is built on that route's shipping.",
      ckb: 'پێشداواکاری زیاتر لە یەک ڕێگای هەیە؛ ئەو ڕێگا بنەڕەتییە هەڵبژێرە کە زیادەی فرۆشتنی ڕاستەوخۆی لێوە حیساب دەکرێت، چونکە نرخی نوێی فرۆشتنی ڕاستەوخۆ لەسەر ناردنی ئەو ڕێگایە دادەنرێت.',
    },
  },
  DIRECT_ONLY_EXTRA_UNKNOWN: {
    severity: 'review',
    label: {
      ar: 'هذا الاختيار يُباع مباشرة فقط ولا توجد زيادة بيع مباشر موحّدة للمنتج؛ حدّد الحد الأدنى للربح أو الزيادة بنفسك.',
      en: 'This selection sells direct only and the product has no single Direct Sale Extra; set the minimum target profit or the Direct Sale Extra yourself.',
      ckb: 'ئەم هەڵبژاردنە تەنها ڕاستەوخۆ دەفرۆشرێت و بەرهەمەکە یەک زیادەی فرۆشتنی ڕاستەوخۆی نییە؛ خۆت کەمترین قازانجی مەبەست یان زیادەی فرۆشتنی ڕاستەوخۆ دیاری بکە.',
    },
  },
  PLACEMENT_INVARIANT_FAILED: {
    severity: 'review',
    label: {
      ar: 'إعادة الحساب من القيم المستخرجة لا تعطي السعر القديم نفسه؛ راجع هذا الاختيار.',
      en: 'Recomputing from the extracted values does not give back the old price; check this selection.',
      ckb: 'حیسابکردنەوە لە بەها دەرهێنراوەکانەوە هەمان نرخی کۆن ناداتەوە؛ پێداچوونەوە بەم هەڵبژاردنەدا بکە.',
    },
  },
  MODEL_NOT_SELLABLE: {
    severity: 'unresolved',
    label: {
      ar: 'لا يمكن بيع هذا الاختيار اليوم بأي طريقة؛ لا يُستخرج له ربح.',
      en: 'This selection cannot be sold today in any way; no profit is taken for it.',
      ckb: 'ئەم هەڵبژاردنە ئەمڕۆ بە هیچ شێوەیەک نافرۆشرێت؛ هیچ قازانجێکی بۆ دەرناهێنرێت.',
    },
  },
  CHANNEL_NOT_PRICED: {
    severity: 'review',
    label: {
      ar: 'طريقة بيع مفعّلة لكن السعر الحالي لا يُحسب لها؛ راجع إعدادها.',
      en: "A sale channel is on but today's price cannot be calculated for it; check its setup.",
      ckb: 'ڕێگایەکی فرۆشتن چالاکە بەڵام نرخی ئێستای بۆ حیساب ناکرێت؛ پێداچوونەوە بە ڕێکخستنەکەیدا بکە.',
    },
  },
  COLOR_PRICE_UNSUPPORTED: {
    severity: 'review',
    label: {
      ar: 'لون في هذا المنتج يحمل سعراً أو تعديلاً خاصاً؛ التسعير الجديد لا يدعمه بعد.',
      en: 'A colour of this product states its own price or adjustment; the new pricing does not support it yet.',
      ckb: 'ڕەنگێکی ئەم بەرهەمە نرخ یان گۆڕانکاریی تایبەتی خۆی هەیە؛ نرخدانانی نوێ هێشتا پشتگیری ناکات.',
    },
  },
  OPTION_GROUPS_UNSUPPORTED: {
    severity: 'review',
    label: {
      ar: 'لهذا المنتج أكثر من مجموعة خيارات؛ التسعير الجديد يدعم مجموعة واحدة.',
      en: 'This product has more than one option group; the new pricing supports one.',
      ckb: 'ئەم بەرهەمە زیاتر لە یەک کۆمەڵە هەڵبژاردەی هەیە؛ نرخدانانی نوێ تەنها یەک کۆمەڵە پشتگیری دەکات.',
    },
  },
  ROUTE_FEE_INCLUDED: {
    severity: 'info',
    label: {
      ar: 'عمولة المسار القديمة ({method}: {iqd}) جزء مما دفعه الزبون، فحُسبت في الحد الأدنى للربح؛ تُصفَّر عند حفظ الأسعار الجديدة لأن السعر الجديد يشمل الشحن.',
      en: 'The old route fee ({method}: {iqd}) was part of what the customer paid, so it counts in the minimum target profit; it is set to zero when you save the new prices, because the new price includes shipping.',
      ckb: 'کرێی کۆنی ڕێگا ({method}: {iqd}) بەشێک بوو لەوەی کڕیار دەیدا، بۆیە لە کەمترین قازانجی مەبەستدا حیساب کرا؛ لە کاتی پاشەکەوتکردنی نرخە نوێیەکاندا دەکرێتە سفر، چونکە نرخی نوێ کرێی ناردنی تێدایە.',
    },
  },
  DIRECT_SALE_EXTRA_ZERO_DIRECT_ONLY: {
    severity: 'info',
    label: {
      ar: 'لا يوجد بيع بالطلب المسبق لهذا المنتج، فكل الربح القديم صار حداً أدنى للربح وزيادة البيع المباشر صفر.',
      en: 'This product has no pre-order sale, so the whole old profit became the minimum target profit and the Direct Sale Extra is zero.',
      ckb: 'ئەم بەرهەمە فرۆشتنی پێشداواکاری نییە، بۆیە هەموو قازانجی کۆن بوو بە کەمترین قازانجی مەبەست و زیادەی فرۆشتنی ڕاستەوخۆ سفرە.',
    },
  },
  LEGACY_MEMBER_PRICE_DROPPED: {
    severity: 'info',
    label: {
      ar: 'سعر العضوية المكتوب يدوياً لن يُستخدم بعد حفظ الأسعار الجديدة؛ تُطبَّق مزايا العضوية العامة.',
      en: 'The typed membership price will not be used once you save the new prices; the general membership benefits apply.',
      ckb: 'نرخی ئەندامێتیی دەستنووس دوای پاشەکەوتکردنی نرخە نوێیەکان بەکارناهێنرێت؛ سوودە گشتییەکانی ئەندامێتی جێبەجێ دەکرێن.',
    },
  },
} as const satisfies Record<string, LegacyReasonDefinition>;

export type LegacyReasonCode = keyof typeof LEGACY_REASONS;

export function isLegacyReasonCode(value: unknown): value is LegacyReasonCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_REASONS, value);
}

// ------------------------------------------------- §6.2 screen labels

/**
 * The §6.2 labels of the «التسعير والشحن» screens, keyed as §6.2 keys them,
 * plus the P1 banners (`b.previewOnly`, `b.ratesFromPurchases`,
 * `b.usdRateMissing`) and the profile names (`p.*`, C46).
 */
export const PRICING_MIGRATION_LABELS = {
  'b.previewOnly': {
    ar: 'معاينة فقط — لا يتغير شيء في المتجر.',
    en: 'Preview only — nothing changes in the store.',
    ckb: 'تەنها پێشبینینە — هیچ شتێک لە فرۆشگاکەدا ناگۆڕێت.',
  },
  'b.ratesFromPurchases': {
    ar: 'أسعار مأخوذة من مشترياتك — غير مؤكدة بعد.',
    en: 'Rates taken from your purchases — not confirmed yet.',
    ckb: 'نرخەکان لە کڕینەکانتەوە وەرگیراون — هێشتا پشتڕاست نەکراونەتەوە.',
  },
  'b.usdRateMissing': {
    ar: 'لا يوجد سعر للدولار بعد.',
    en: 'There is no USD rate yet.',
    ckb: 'هێشتا هیچ نرخێکی دۆلار نییە.',
  },
  'b.landedNote': {
    ar: 'الحد الأدنى للربح = سعر البيع القديم مع عمولة المسار المطبّقة ناقص التكلفة القديمة. التكلفة القديمة كانت تكلفة واصلة تشمل الشحن، فلا يُضاف الشحن إليها مرة أخرى.',
    en: 'Minimum target profit = old sale price including the applicable route fee, minus the old cost. The old cost was the landed cost and already included shipping, so shipping is not added to it again.',
    ckb: 'کەمترین قازانجی مەبەست = نرخی کۆنی فرۆشتن لەگەڵ کرێی ڕێگای پەیوەندیدار، کەمکراوە لە تێچووی کۆن. تێچووی کۆن تێچووی گەیشتوو بوو و کرێی ناردنی تێدابوو، بۆیە کرێی ناردن جارێکی تر بۆی زیاد ناکرێت.',
  },
  'I.ROUTE_FEE_INCLUDED': LEGACY_REASONS.ROUTE_FEE_INCLUDED.label,
  'R.TARGET_ROUTE_CONFLICT': LEGACY_REASONS.TARGET_ROUTE_CONFLICT.label,
  'R.LEGACY_DIRECT_BELOW_PREORDER': LEGACY_REASONS.LEGACY_DIRECT_BELOW_PREORDER.label,
  'R.LEGACY_DIRECT_SALE_EXTRA_NOT_ON_STEP': LEGACY_REASONS.LEGACY_DIRECT_SALE_EXTRA_NOT_ON_STEP.label,
  'I.DIRECT_SALE_EXTRA_ZERO_DIRECT_ONLY': LEGACY_REASONS.DIRECT_SALE_EXTRA_ZERO_DIRECT_ONLY.label,
  'R.COST_LESS_SPECIFIC_THAN_PRICE': LEGACY_REASONS.COST_LESS_SPECIFIC_THAN_PRICE.label,
  'R.PRODUCT_DIMENSIONS_ONLY': {
    ar: 'توجد أبعاد المنتج فقط — لا تُستخدم بديلاً عن أبعاد العبوة',
    en: "Only the product's own dimensions exist — they are not used in place of the package dimensions",
    ckb: 'تەنها ڕەهەندەکانی خودی بەرهەمەکە هەن — لە جیاتی ڕەهەندەکانی پاکەت بەکارناهێنرێن',
  },
  'R.SKU_WITHOUT_VARIANT_ROW': {
    ar: 'لهذه التركيبة لا يوجد سجل مخزون خاص بها',
    en: 'This SKU has no stock row of its own',
    ckb: 'ئەم SKU-یە تۆماری کۆگای تایبەت بە خۆی نییە',
  },
  'R.TARGET_CHANGED_SINCE_COMMIT': {
    ar: 'تغيّر الربح المستخرج منذ الاعتماد: {old} ← {new}',
    en: 'The extracted profit changed since the commit: {old} → {new}',
    ckb: 'قازانجی دەرهێنراو لە دوای پەسەندکردنەوە گۆڕاوە: {old} ← {new}',
  },
  'I.LEGACY_MEMBER_PRICE_DROPPED': LEGACY_REASONS.LEGACY_MEMBER_PRICE_DROPPED.label,
  'I.CBM_MANUAL_DIFFERS': {
    ar: 'الحجم اليدوي يختلف عن المحسوب من الصندوق ({calc})؛ اعتُمد اليدوي.',
    en: 'The manual CBM differs from the box calculation ({calc}); the manual value is used.',
    ckb: 'قەبارەی دەستی جیاوازە لە حیسابی سندوقەکە ({calc})؛ بەهای دەستی بەکارهات.',
  },
  'L.FIELD_UNRESOLVED': {
    ar: '⚠ {field} غير محسوم: {reason}',
    en: '⚠ {field} unresolved: {reason}',
    ckb: '⚠ {field} یەکلانەکراوەتەوە: {reason}',
  },
  'L.DIRECT_SALE_EXTRA_REVIEW': {
    ar: '⚠ زيادة البيع المباشر تحتاج قرارك في {n} تركيبة',
    en: '⚠ Direct Sale Extra needs your decision for {n} SKUs',
    ckb: '⚠ زیادەی فرۆشتنی ڕاستەوخۆ پێویستی بە بڕیاری تۆ هەیە بۆ {n} SKU',
  },
  'L.TARGET_MANUAL': {
    ar: '✓ الحد الأدنى للربح حدّدته بنفسك: {iqd}',
    en: '✓ Minimum target profit set by you: {iqd}',
    ckb: '✓ کەمترین قازانجی مەبەست خۆت دیاریت کرد: {iqd}',
  },
  'L.TARGET_CONFLICT': {
    ar: '⚠ تعارض في الحد الأدنى للربح بين المسارات في {n} تركيبة',
    en: '⚠ Minimum target profit conflict between routes in {n} SKUs',
    ckb: '⚠ ناکۆکی لە کەمترین قازانجی مەبەستدا لە نێوان ڕێگاکان لە {n} SKU',
  },
  'L.NO_ADDITIONAL_COSTS': {
    ar: 'ℹ لا توجد تكاليف إضافية مسجلة',
    en: 'ℹ No additional costs recorded',
    ckb: 'ℹ هیچ تێچوویەکی زیادە تۆمار نەکراوە',
  },
  's.READY_TO_SWITCH': PRICING_MIGRATION_STATUS_LABELS.READY_TO_SWITCH,
  'btn.saveAndApply': {
    ar: 'حفظ واعتماد الأسعار الجديدة',
    en: 'Save and apply the new prices',
    ckb: 'پاشەکەوتکردن و جێبەجێکردنی نرخە نوێیەکان',
  },
  'chk.measuresConfirmed': {
    ar: 'راجعت قياسات الشحن المستخدمة',
    en: 'I have checked the shipping measures used',
    ckb: 'پێوانەکانی ناردنی بەکارهاتووم پشکنی',
  },
  'btn.bulkMeasures': {
    ar: 'إدخال صندوق أو حجم لعدة منتجات',
    en: 'Enter a box or CBM for several products',
    ckb: 'سندوق یان قەبارە بۆ چەند بەرهەمێک بنووسە',
  },
  'p.CHINA_AIR': { ar: 'شحن جوي — الصين', en: 'China air', ckb: 'ناردنی ئاسمانی — چین' },
  'p.CHINA_SEA': { ar: 'شحن بحري — الصين', en: 'China sea', ckb: 'ناردنی دەریایی — چین' },
  'p.GERMANY_LAND': { ar: 'شحن بري — ألمانيا', en: 'Germany land', ckb: 'ناردنی وشکانی — ئەڵمانیا' },
} as const satisfies Record<string, PricingLabel>;

export type PricingMigrationLabelKey = keyof typeof PRICING_MIGRATION_LABELS;

/**
 * A label with its `{name}` slots filled. A slot the caller does not fill is
 * left as written, so a missing figure shows as a gap the owner can see rather
 * than as a wrong number.
 */
export function migrationText(label: PricingLabel, lang: PricingLang, params: Readonly<Record<string, string | number>> = {}): string {
  const text = label[lang] || label.en;
  return text.replace(/\{(\w+)\}/g, (slot, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : slot
  );
}
