/**
 * THE PRODUCT DISCOUNT'S SENTENCES (docs/ux/PRODUCT-DISCOUNT.md §5.8), in one place for both sides:
 * the admin door (worker/routes/offers.ts) answers them as `{ code, message, ar, en, ckb }`, and the
 * SPA's refusal table (src/lib/refusalStrings.ts) spreads them, so the card and the «العروض الخاصة»
 * tab read the very same three sentences. Every `ckb` is its own Sorani (DECISIONS row 183).
 *
 * `SPECIAL_OFFER_CHANGED` is not `OFFER_CHANGED`: that code already means a merchant's print offer.
 */
export interface OfferSentence {
  ar: string;
  en: string;
  ckb: string;
}

/** The refusals of a dollar sale price and of a lost update. */
export const OFFER_DISCOUNT_REFUSALS = {
  OFFER_USD_NOT_INSTALLED: {
    ar: 'سعر الخصم بالدولار غير متاح بعد على قاعدة البيانات هذه — نسبة الخصم تعمل',
    en: 'a dollar sale price is not available on this database yet — a discount percent works',
    ckb: 'نرخی داشکاندن بە دۆلار هێشتا لەم بنکەدراوەیە بەردەست نییە — ڕێژەی داشکاندن کار دەکات',
  },
  OFFER_USD_ORDINARY_ONLY: {
    ar: 'سعر الخصم بالدولار للمنتجات العادية فقط — الباقات والعروض الغامضة تُسعَّر بالدينار',
    en: 'a dollar sale price is for ordinary products only — bundles and mystery offers are priced in dinars',
    ckb: 'نرخی داشکاندن بە دۆلار تەنها بۆ بەرهەمە ئاساییەکانە — پاکێج و ئۆفەرە نهێنییەکان بە دینار نرخ دەدرێن',
  },
  OFFER_USD_NOT_PRICED: {
    ar: 'انشر أسعار المنتج أولًا؛ يُحسب الخصم من السعر المنشور',
    en: "publish the product's prices first; the sale is taken from the published price",
    ckb: 'سەرەتا نرخەکانی بەرهەمەکە بڵاو بکەرەوە؛ داشکاندن لە نرخی بڵاوکراوە دەکرێت',
  },
  OFFER_USD_PRICE_SHAPE: {
    ar: 'اكتب السعر بالدولار أكبر من صفر، برقمين عشريين على الأكثر، حتى 100,000',
    en: 'enter the dollar price above zero, with at most two decimals, up to 100,000',
    ckb: 'نرخەکە بە دۆلار لە سفر زیاتر بنووسە، بە زۆرترین دوو ژمارەی دەیی، تا 100,000',
  },
  OFFER_USD_SCOPE_MIXED: {
    ar: 'سعر واحد للمنتج كله أو سعر لكل موديل — لا الاثنان معًا',
    en: 'one price for the whole product or a price per model — not both',
    ckb: 'یەک نرخ بۆ هەموو بەرهەمەکە یان نرخێک بۆ هەر مۆدێلێک — نەک هەردووکیان',
  },
  OFFER_USD_MODEL_UNKNOWN: {
    ar: 'أحد الموديلات ليس من موديلات هذا المنتج',
    en: 'one of the models is not a model of this product',
    ckb: 'یەکێک لە مۆدێلەکان مۆدێلی ئەم بەرهەمە نییە',
  },
  OFFER_USD_PER_MODEL: {
    ar: 'موديلات هذا المنتج بأسعار مختلفة — اكتب سعرًا لكل موديل',
    en: "this product's models have different prices — enter a price for each model",
    ckb: 'مۆدێلەکانی ئەم بەرهەمە نرخی جیاوازیان هەیە — نرخێک بۆ هەر مۆدێلێک بنووسە',
  },
  OFFER_USD_MIXED_PRICES: {
    ar: 'ألوان هذا الموديل بأسعار مختلفة، فلا يصلح لها سعر واحد بعد الخصم — استعمل نسبة الخصم',
    en: "this model's colours have different prices, so one price after the discount cannot fit them — use a discount percent",
    ckb: 'ڕەنگەکانی ئەم مۆدێلە نرخی جیاوازیان هەیە، بۆیە یەک نرخی دوای داشکاندن بۆیان ناگونجێت — ڕێژەی داشکاندن بەکاربهێنە',
  },
  OFFER_USD_NOT_DIRECT: {
    ar: 'هذا الموديل لا يُباع بيعًا مباشرًا، فلا يوجد سعر حالي واحد يُخفَّض منه — استعمل نسبة الخصم',
    en: 'this model is not sold direct, so there is no single current price to discount from — use a discount percent',
    ckb: 'ئەم مۆدێلە ڕاستەوخۆ نافرۆشرێت، بۆیە یەک نرخی ئێستا نییە بۆ داشکاندن — ڕێژەی داشکاندن بەکاربهێنە',
  },
  OFFER_NOT_LOWER: {
    ar: 'السعر بعد الخصم ليس أقل من السعر الحالي — لا يُعرض خصم لا يخفّض شيئًا',
    en: 'the price after the discount is not below the current price — a sale that lowers nothing is never shown',
    ckb: 'نرخی دوای داشکاندن لە نرخی ئێستا کەمتر نییە — داشکاندنێک کە هیچ کەم ناکاتەوە پیشان نادرێت',
  },
  OFFER_ROUTE_BELOW_FLOOR: {
    ar: 'هذا الخصم يجعل سعر الطلب المسبق صفرًا أو أقل — ارفع السعر بعد الخصم',
    en: 'this sale brings a pre-order price to zero or less — raise the price after the discount',
    ckb: 'ئەم داشکاندنە نرخی پێشداواکردن دەکاتە سفر یان کەمتر — نرخی دوای داشکاندن بەرز بکەرەوە',
  },
  SPECIAL_OFFER_CHANGED: {
    ar: 'عدّل أحدٌ هذا العرض بعد أن فتحته — أُعيد تحميله؛ راجعه ثم احفظ',
    en: 'someone changed this offer after you opened it — it has been reloaded; review it and save again',
    ckb: 'کەسێک دوای ئەوەی کردتەوە ئەم ئۆفەرەی گۆڕی — دووبارە بارکرایەوە؛ پێیدا بچۆرەوە و دووبارە پاشەکەوتی بکە',
  },
} as const satisfies Record<string, OfferSentence>;

/** The two warnings a save keeps visible (never refusals). `OFFER_BELOW_COST` reaches the owner only (D6). */
export const OFFER_DISCOUNT_WARNINGS = {
  OFFER_PARTLY_NOT_LOWER: {
    ar: 'بعض الموديلات لن تُخفَّض لأن سعرها بعد الخصم ليس أقل من الحالي — تُباع بسعرها بلا شطب',
    en: 'some models are not reduced because their price after the discount is not below the current one — they sell at their price, with no strikethrough',
    ckb: 'هەندێک مۆدێل داناشکێن چونکە نرخی دوای داشکاندنیان لە ئێستا کەمتر نییە — بە نرخی خۆیان دەفرۆشرێن، بێ هێڵ بەسەرداهاتن',
  },
  // The OWNER's answer only (D6): an editor's answer never carries a cost signal.
  OFFER_BELOW_COST: {
    ar: 'هذا الخصم يبيع موديلًا أو مسارًا تحت تكلفته — محفوظ ومعروض للزبائن',
    en: 'this sale sells a model or route below its cost — saved and on sale',
    ckb: 'ئەم داشکاندنە مۆدێلێک یان ڕێڕەوێک لە خوار تێچووەکەی دەفرۆشێت — پاشەکەوت کراوە و بۆ کڕیاران دیارە',
  },
} as const satisfies Record<string, OfferSentence>;

export type OfferDiscountCode = keyof typeof OFFER_DISCOUNT_REFUSALS | keyof typeof OFFER_DISCOUNT_WARNINGS;
