/**
 * «خصص طابعتك» phase 4 (0242; DECISIONS row 355): the sheet's words for the
 * kit colours, the discounted add-ons and the store bundles linked to the
 * printer. Imported ONLY by CustomizeSheet (through PrinterOffersRows), so the
 * words ride the sheet's own lazy chunk — never the product page's opening.
 * Every sentence is written in Arabic, English and Sorani (not Arabic copied).
 */
export type OfferLang = 'ar' | 'en' | 'ckb';

export interface OfferStrings {
  perPrinter: string;
  qtyPerPrinter: (n: number) => string;
  randomColour: string;
  randomHint: string;
  soldOut: string;
  colourOf: (name: string) => string;
  colourChosenNote: string;
  addonsRow: string;
  addonsSub: string;
  addonsNote: string;
  addonsLine: string;
  /** The footer's «own cart lines» sentence when add-ons are chosen (phase 4 adds them to phase 2's membership and kit). */
  extrasApart: string;
  /** The footer's folded breakdown. */
  priceDetails: string;
  addonsChosen: (n: number) => string;
  bundlesRow: string;
  bundlesSub: string;
  bundlesNote: string;
  save: (pct: number) => string;
  saved: (amount: string) => string;
  priceBefore: string;
  addBundle: string;
  adding: string;
  added: string;
  chooseOptions: string;
  addFailed: string;
  signInToAdd: string;
  loading: string;
  failed: string;
  retry: string;
  none: string;
  unavailable: string;
}

const AR: OfferStrings = {
  perPrinter: 'لكل طابعة',
  qtyPerPrinter: (n) => `×${n} لكل طابعة`,
  randomColour: 'لون عشوائي',
  randomHint: 'نختاره لك من المتوفر في المخزن',
  soldOut: 'نفد',
  colourOf: (name) => `لون ${name}`,
  colourChosenNote: 'الألوان المعروضة متوفرة الآن؛ يُحجز اللون عند إتمام الطلب.',
  addonsRow: 'إضافات بسعر خاص',
  addonsSub: 'فوهات وأسطح طباعة وغيرها، مع الطابعة',
  addonsNote: 'تُغلَّف مع الطابعة، وكميتها تتبع عدد الطابعات. يمكنك حذفها من السلة.',
  addonsLine: 'الإضافات',
  extrasApart: 'العضوية وباقة الفيلامنت والإضافات سطور مستقلة في السلة، خارج هذا الإجمالي.',
  priceDetails: 'تفاصيل السعر',
  addonsChosen: (n) => (n === 1 ? 'إضافة واحدة' : `${n} إضافات`),
  bundlesRow: 'عروض مجمّعة',
  bundlesSub: 'منتجات مختارة لهذه الطابعة بسعر أقل',
  bundlesNote: 'كل عرض يُضاف إلى السلة كمنتج مستقل بسعره.',
  save: (pct) => `وفّر ${pct}%`,
  saved: (amount) => `وفّرت ${amount}`,
  priceBefore: 'السعر قبل الخصم',
  addBundle: 'أضف',
  adding: 'جارٍ الإضافة…',
  added: '✓ أُضيف',
  chooseOptions: 'اختر الخيارات',
  addFailed: 'تعذّرت الإضافة — حاول مرة أخرى.',
  signInToAdd: 'سجّل الدخول للإضافة',
  loading: 'جارٍ تحميل العروض…',
  failed: 'تعذّر تحميل العروض.',
  retry: 'إعادة المحاولة',
  none: 'بدون',
  unavailable: 'غير متوفر حالياً',
};

const EN: OfferStrings = {
  perPrinter: 'per printer',
  qtyPerPrinter: (n) => `×${n} per printer`,
  randomColour: 'Random colour',
  randomHint: 'We pick one that is in stock',
  soldOut: 'Sold out',
  colourOf: (name) => `${name} colour`,
  colourChosenNote: 'The colours shown are in stock now; your colour is reserved when you place the order.',
  addonsRow: 'Add-ons at a special price',
  addonsSub: 'Nozzles, build plates and more, with the printer',
  addonsNote: 'Packed with the printer; the quantity follows the number of printers. You can remove them in the cart.',
  addonsLine: 'Add-ons',
  extrasApart: 'The membership, the filament kit and the add-ons are their own cart lines, outside this total.',
  priceDetails: 'Price details',
  addonsChosen: (n) => (n === 1 ? '1 add-on' : `${n} add-ons`),
  bundlesRow: 'Bundle deals',
  bundlesSub: 'Picked for this printer, for less',
  bundlesNote: 'Each deal goes into the cart as its own item, at its own price.',
  save: (pct) => `Save ${pct}%`,
  saved: (amount) => `You save ${amount}`,
  priceBefore: 'Price before discount',
  addBundle: 'Add',
  adding: 'Adding…',
  added: '✓ Added',
  chooseOptions: 'Choose options',
  addFailed: 'Could not add it — try again.',
  signInToAdd: 'Sign in to add',
  loading: 'Loading the offers…',
  failed: 'The offers could not be loaded.',
  retry: 'Try again',
  none: 'None',
  unavailable: 'Not available right now',
};

const CKB: OfferStrings = {
  perPrinter: 'بۆ هەر پرینتەرێک',
  qtyPerPrinter: (n) => `×${n} بۆ هەر پرینتەرێک`,
  randomColour: 'ڕەنگی هەڕەمەکی',
  randomHint: 'لەوەی لە کۆگادا هەیە بۆت هەڵدەبژێرین',
  soldOut: 'نەماوە',
  colourOf: (name) => `ڕەنگی ${name}`,
  colourChosenNote: 'ئەو ڕەنگانەی پیشان دراون ئێستا بەردەستن؛ ڕەنگەکە کاتی تەواوکردنی داواکارییەکە بۆت دەگیرێت.',
  addonsRow: 'زیادکراوەکان بە نرخی تایبەت',
  addonsSub: 'نۆزڵ، پلێتی چاپ و زیاتر، لەگەڵ پرینتەرەکە',
  addonsNote: 'لەگەڵ پرینتەرەکە دەپێچرێنەوە، و بڕەکەیان شوێن ژمارەی پرینتەرەکان دەکەوێت. دەتوانیت لە سەبەتەدا لایانبەیت.',
  addonsLine: 'زیادکراوەکان',
  extrasApart: 'ئەندامێتی و پاکێجی فیلامێنت و زیادکراوەکان دێڕی جیان لە سەبەتەدا، دەرەوەی ئەم کۆیە.',
  priceDetails: 'وردەکاری نرخ',
  addonsChosen: (n) => (n === 1 ? 'یەک زیادکراو' : `${n} زیادکراو`),
  bundlesRow: 'ئۆفەری کۆمەڵە',
  bundlesSub: 'بەرهەمی هەڵبژێردراو بۆ ئەم پرینتەرە بە نرخێکی کەمتر',
  bundlesNote: 'هەر ئۆفەرێک وەک کاڵایەکی سەربەخۆ بە نرخی خۆی دەچێتە سەبەتەوە.',
  save: (pct) => `${pct}% پاشەکەوت بکە`,
  saved: (amount) => `${amount} پاشەکەوت دەکەیت`,
  priceBefore: 'نرخ پێش داشکاندن',
  addBundle: 'زیادی بکە',
  adding: 'زیاد دەکرێت…',
  added: '✓ زیادکرا',
  chooseOptions: 'هەڵبژاردنەکان دیاری بکە',
  addFailed: 'زیاد نەکرا — دووبارە هەوڵ بدەرەوە.',
  signInToAdd: 'بۆ زیادکردن بچۆ ژوورەوە',
  loading: 'ئۆفەرەکان بار دەکرێن…',
  failed: 'ئۆفەرەکان بار نەکران.',
  retry: 'دووبارە هەوڵ بدەرەوە',
  none: 'هیچ',
  unavailable: 'ئێستا بەردەست نییە',
};

export const OFFER_STRINGS: Record<OfferLang, OfferStrings> = { ar: AR, en: EN, ckb: CKB };

/**
 * The phase-4 refusals as the sheet says them (SERVICES_ERRORS style: each
 * names its fix). The cart and the checkout read src/lib/refusalStrings.ts.
 */
export const OFFER_ERRORS: Record<string, Record<OfferLang, string>> = {
  KIT_COLOR_UNAVAILABLE: {
    ar: 'اللون الذي اخترته في باقة الفيلامنت نفد — اختر لوناً آخر أو «لون عشوائي».',
    en: 'The colour you chose in the filament kit is sold out — choose another colour or «Random colour».',
    ckb: 'ئەو ڕەنگەی لە پاکێجی فیلامێنتەکەدا هەڵتبژارد نەماوە — ڕەنگێکی تر یان «ڕەنگی هەڕەمەکی» هەڵبژێرە.',
  },
  ADDON_NOT_OFFERED: {
    ar: 'إحدى الإضافات لم تعد معروضة مع هذه الطابعة — أزلها واختر من جديد.',
    en: 'One of the add-ons is no longer offered with this printer — remove it and choose again.',
    ckb: 'یەکێک لە زیادکراوەکان چیتر لەگەڵ ئەم پرینتەرە پێشکەش ناکرێت — لای ببە و دووبارە هەڵبژێرە.',
  },
  ADDON_UNAVAILABLE: {
    ar: 'إحدى الإضافات غير متوفرة الآن — أزلها أو اختر لوناً آخر.',
    en: 'One of the add-ons is not available right now — remove it or choose another colour.',
    ckb: 'یەکێک لە زیادکراوەکان ئێستا بەردەست نییە — لای ببە یان ڕەنگێکی تر هەڵبژێرە.',
  },
  ADDON_CHANGED: {
    ar: 'تغيّرت إحدى الإضافات أو سعرها — راجعها واختر من جديد.',
    en: 'One of the add-ons or its price has changed — check it and choose again.',
    ckb: 'یەکێک لە زیادکراوەکان یان نرخەکەی گۆڕاوە — بیپشکنە و دووبارە هەڵبژێرە.',
  },
  ADDON_WITHOUT_PRINTER: {
    ar: 'الإضافة تُطلب مع طابعتها فقط — حدّد الطابعة أيضاً أو أزل الإضافة.',
    en: 'An add-on is ordered only with its printer — tick the printer too or remove the add-on.',
    ckb: 'زیادکراو تەنها لەگەڵ پرینتەرەکەی داوا دەکرێت — پرینتەرەکەش دیاری بکە یان زیادکراوەکە لاببە.',
  },
};

export function offerErrorText(code: string | null | undefined, lang: string): string {
  const e = code ? OFFER_ERRORS[code] : undefined;
  if (!e) return '';
  return e[lang === 'en' || lang === 'ckb' ? lang : 'ar'];
}
